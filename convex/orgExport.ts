/* Admin-only organization export, in two forms.
 *
 * `page` is the paging query the browser export (src/lib/orgExport.ts)
 * reads, one bounded read per call, each rechecking that the caller is an
 * admin. It stays until the export panel moves to the job and the release
 * after that one.
 *
 * The export job collects the archive on the server, so preparation goes on
 * when the page that asked for it closes. `request` starts the
 * organization's job, or joins the one collecting, and records the admin's
 * request (org_export_requests); at most one job per organization collects
 * at a time, and two requests at once conflict on the range that holds it,
 * so the second joins. A ready archive does not stop a fresh request, and
 * stays four hours (model/orgExports.ts ARCHIVE_TTL_MS) unless the fresh
 * job becomes ready first, which ends it (`commitFinish`). So an
 * organization holds at most one collecting job and one ready archive,
 * each under MAX_ARCHIVE_BYTES, or DEMO_ARCHIVE_BYTES on the public demo,
 * where every visitor is an admin.
 *
 * Each `step` (an action in the default runtime) reads its section in
 * bounded queries (readBatch, model/orgExportRead.ts) until its part holds
 * about EXPORT_LIMITS.part of JSON or the section ends, compresses the part
 * as one complete raw DEFLATE stream, stores it and commits its id with the
 * new read state (`commitPart`), which schedules the next step. Convex
 * stores a file from an action here, because convex-test stores none from a
 * mutation. A commit the job refuses (it moved on, ended or lost its
 * authority) answers false and the step deletes its file; a file whose
 * action died between store and commit has no row, and the orphan sweeps
 * erase it (files.ts reapOrphans, an hour old; model/demoUploads.ts
 * checkStoredFiles on the demo, after 120 seconds). Each commit checks that
 * the organization's deletion, or a public demo's cleanup, has not begun
 * and that an admin who asked is still one (model/orgExports.ts
 * stopReason); otherwise the job fails, as it does past its archive cap
 * (archiveCap).
 * When every section is read, the step stores the README and manifest and
 * `commitFinish` checks every table's files and publishes the archive with
 * its four hours, scheduling `expire` at their end.
 *
 * The reads are live, not a snapshot of one moment (lib/orgExport.ts
 * LIVE_READ_WARNING). The archive is data only: no step reads an
 * attachment's or a picture's bytes. Any admin may cancel a collecting job;
 * a failed, cancelled or expired job's parts are erased at once in `erase`
 * legs. Ended jobs and their request rows stay 30 days as history.
 *
 * Convex drops what a failed mutation scheduled and does not retry actions.
 * `recover` (every minute) restarts a collecting job whose step stopped,
 * and fails it after RESTARTS restarts without a commit; `sweep` (every 15
 * minutes) expires ready archives whose timer was lost, restarts erase legs
 * that stopped and deletes ended jobs past their 30 days. Branch previews
 * register no crons (crons.ts), so there only the scheduled steps, erase
 * legs and expiry timers run.
 *
 * On the public demo the job's rows spend nothing of the visitor's record
 * limit (lib/demo.ts uncountedWriter) and its parts nothing of the upload
 * budget; DEMO_ARCHIVE_BYTES bounds them instead, and the demo's cleanup
 * deletes them. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { deflateSync } from 'fflate/browser'
import type { Doc, Id } from './_generated/dataModel'
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
} from './_generated/server'
import { assertOrgAvailable } from './lib/billingAccess'
import { crc32 } from './lib/crc32'
import { byId } from './lib/db'
import { uncountedWriter } from './lib/demo'
import type { OrgExportState } from './lib/enums'
import { authedMutation, badRequest, forbidden, notFound, orgQuery, require } from './lib/functions'
import {
  archiveRow,
  archiveTables,
  type ExportCursor,
  type ExportStep,
  exportName,
  JOB_README,
  jobManifest,
  ORG_EXPORT_FORMAT,
  ORG_EXPORT_ORDER,
  ORG_EXPORT_SECTIONS,
  type OrgExportPage,
  partEntry,
  vExportCursor,
  ZIP_END_BYTES,
  zipEntryBytes,
} from './lib/orgExport'
import { eraseFile } from './model/fileHolds'
import {
  type ExportBatch,
  exportDocs,
  hasItemInFlight,
  liveChecks,
  organizationRow,
  pageSizeOf,
  readBatch as readExportBatch,
  readPage,
} from './model/orgExportRead'
import {
  ARCHIVE_TTL_MS,
  archiveCap,
  collectingJob,
  EXPORT_LIMITS,
  endJob,
  eraseParts,
  exportOf,
  HISTORY_MS,
  jobsOf,
  partsOf,
  RESTARTS,
  readyJobs,
  requestsOf,
  STALLED_MS,
  stopReason,
} from './model/orgExports'
import { newUuid } from './model/orgs'

const ADMINS_ONLY = 'only organization admins can export organization data'

/* Explicit literals keep both the wire surface and its manifest reviewable. */
const sectionValidator = v.union(
  v.literal('organizations'),
  v.literal('teams'),
  v.literal('profiles'),
  v.literal('projects'),
  v.literal('issues'),
  v.literal('labels'),
  v.literal('activity_events'),
  v.literal('team_members'),
  v.literal('project_access'),
  v.literal('project_team_access'),
  v.literal('milestones'),
  v.literal('issue_links'),
  v.literal('issue_labels'),
  v.literal('issue_attachments'),
  v.literal('comments'),
  v.literal('agent_keys'),
)

/** One page of one section, for the browser export. The client traverses
 * each child section through the parent ids it exported; the parent must be
 * the organization's, and a task's parent must be under a live project. */
export const page = orgQuery({
  args: {
    section: sectionValidator,
    parent_id: v.optional(v.string()),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { section, parent_id, cursor }): Promise<OrgExportPage> => {
    const isAdmin = ctx.me.org_role === 'admin'
    if (!isAdmin) throw forbidden(ADMINS_ONLY)
    const orgId = ctx.me.org_id
    const parentTable = ORG_EXPORT_SECTIONS[section]
    const live = liveChecks(ctx)
    let scope = orgId
    if (parentTable !== null) {
      if (parent_id === undefined) throw badRequest('this export section requires a parent')
      const parent = await byId(ctx, parentTable, parent_id)
      if (parent === null || parent.org_id !== orgId) throw notFound('export parent not found')
      if ('project_id' in parent && !(await live.project(parent.project_id)))
        throw notFound('export parent not found')
      scope = parent.id
      // The client traverses the whole roster; people have no agent keys.
      if (section === 'agent_keys' && (!('kind' in parent) || parent.kind !== 'agent')) {
        return { rows: [], continueCursor: '', isDone: true }
      }
    } else if (parent_id !== undefined) {
      throw badRequest('this export section does not take a parent')
    }

    if (section === 'organizations') {
      if (cursor !== null) throw badRequest('the organization has a single export page')
      const row = await organizationRow(ctx, orgId)
      if (row === null) throw notFound('organization not found')
      return { rows: [row], continueCursor: '', isDone: true }
    }

    const inFlight =
      (section === 'issues' || section === 'issue_links') && (await hasItemInFlight(ctx, orgId))
    const result = await readPage(ctx, section, scope, cursor, pageSizeOf(section, inFlight))
    const { rows } = await exportDocs(ctx, orgId, section, result.page, inFlight, live)
    return { rows, continueCursor: result.continueCursor, isDone: result.isDone }
  },
})

/* ------------------------------------------------------------- the job */

const stepRef = makeFunctionReference<'action', { export_id: string }, null>('orgExport:step')
const eraseRef = makeFunctionReference<'mutation', { export_id: string }, null>('orgExport:erase')
const expireRef = makeFunctionReference<'mutation', { export_id: string }, null>('orgExport:expire')

/* The progress a job shows while it reads section number `section` (the
 * sections' count once every one is read), with `records` written. */
const progressOf = (section: number, records: number) => ({
  section: section < ORG_EXPORT_ORDER.length ? exportName(ORG_EXPORT_ORDER[section]) : '',
  records,
  sections_done: section,
  sections_total: ORG_EXPORT_ORDER.length,
})

/** Starts the organization's export job, or joins the one collecting, and
 * records the caller's request once. Allowed while the organization is
 * read-only before its deletion, refused once the deletion has begun. */
export const request = authedMutation({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<{ export_id: string; joined: boolean }> => {
    const me = ctx.myProfiles.get(org_id)
    if (me?.org_role !== 'admin') throw forbidden(ADMINS_ONLY)
    await assertOrgAvailable(ctx, org_id)
    require(await byId(ctx, 'organizations', org_id), notFound('organization not found'))
    // job rows are a temporary copy of existing data, not the visitor's records
    const db = uncountedWriter(ctx.db)
    const now = new Date().toISOString()
    const running = await collectingJob(ctx, org_id)
    let exportId = running?.id
    if (exportId === undefined) {
      exportId = newUuid()
      const step: ExportStep = {
        n: 0,
        section: 0,
        cursor: null,
        part: 1,
        seq: 2,
        bytes: 0,
        counts: {},
      }
      const _id = await db.insert('org_exports', {
        id: exportId,
        org_id,
        state: 'collecting',
        requested_by: me.id,
        started_at: now,
        progress_at: now,
        progress: progressOf(0, 0),
        step,
        attempts: 0,
        format_version: ORG_EXPORT_FORMAT,
      })
      const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { export_id: exportId })
      await db.patch(_id, { scheduled_id })
    }
    const mine = await ctx.db
      .query('org_export_requests')
      .withIndex('by_export_profile', (q) => q.eq('export_id', exportId).eq('profile_id', me.id))
      .first()
    if (mine === null)
      await db.insert('org_export_requests', {
        export_id: exportId,
        org_id,
        profile_id: me.id,
        requested_at: now,
      })
    return { export_id: exportId, joined: running !== null }
  },
})

/** What the export page shows of one job. Never its read state or a
 * storage id. */
export type ExportSummary = {
  id: string
  state: OrgExportState
  started_at: string
  progress_at: string
  completed_at: string | null
  expires_at: string | null
  ended_at: string | null
  progress: Doc<'org_exports'>['progress']
  error: { code: string; message: string } | null
  archive_bytes: number | null
  skipped_tasks: number
  requested_by: string | null // the first requester's name
  cancelled_by: string | null // the canceller's name
  requested: boolean // whether the caller asked for this job
}

/** The organization's latest export job, and its latest ready archive that
 * has not expired when that is another job. */
export const status = orgQuery({
  args: {},
  handler: async (ctx): Promise<{ latest: ExportSummary | null; ready: ExportSummary | null }> => {
    if (ctx.me.org_role !== 'admin') throw forbidden(ADMINS_ONLY)
    const me = ctx.me
    // A profile's name, when it is still in the organization and is older
    // than the job; a later profile can take a removed one's id.
    const nameOf = async (job: Doc<'org_exports'>, id: string | undefined) => {
      if (id === undefined) return null
      const profile = await byId(ctx, 'profiles', id)
      return profile !== null &&
        profile.org_id === me.org_id &&
        profile._creationTime < job._creationTime
        ? profile.name
        : null
    }
    const summary = async (job: Doc<'org_exports'>): Promise<ExportSummary> => {
      const mine = await ctx.db
        .query('org_export_requests')
        .withIndex('by_export_profile', (q) => q.eq('export_id', job.id).eq('profile_id', me.id))
        .first()
      return {
        id: job.id,
        state: job.state,
        started_at: job.started_at,
        progress_at: job.progress_at,
        completed_at: job.completed_at ?? null,
        expires_at: job.expires_at ?? null,
        ended_at: job.ended_at ?? null,
        progress: job.progress,
        error: job.error ?? null,
        archive_bytes: job.archive?.bytes ?? null,
        skipped_tasks: job.skipped ?? 0,
        requested_by: await nameOf(job, job.requested_by),
        cancelled_by: await nameOf(job, job.cancelled_by),
        requested: mine !== null && me._creationTime < mine._creationTime,
      }
    }
    const latest = await jobsOf(ctx, me.org_id).order('desc').first()
    const newestReady = await ctx.db
      .query('org_exports')
      .withIndex('by_org_state', (q) => q.eq('org_id', me.org_id).eq('state', 'ready'))
      .order('desc')
      .first()
    const ready =
      newestReady !== null &&
      newestReady.id !== latest?.id &&
      newestReady.expires_at !== undefined &&
      Date.parse(newestReady.expires_at) > Date.now()
        ? newestReady
        : null
    return {
      latest: latest === null ? null : await summary(latest),
      ready: ready === null ? null : await summary(ready),
    }
  },
})

/** Cancels the organization's collecting job; any admin may, also one who
 * joined it. Its parts are erased. Cancelling an ended job changes
 * nothing. Answers the job's state after the call. */
export const cancel = authedMutation({
  args: { org_id: v.string(), export_id: v.string() },
  handler: async (ctx, { org_id, export_id }): Promise<{ state: OrgExportState }> => {
    const me = ctx.myProfiles.get(org_id)
    if (me?.org_role !== 'admin') throw forbidden(ADMINS_ONLY)
    await assertOrgAvailable(ctx, org_id)
    const job = await exportOf(ctx, export_id)
    if (job === null || job.org_id !== org_id) throw notFound('export not found')
    if (job.state !== 'collecting') return { state: job.state }
    await endJob(ctx, job, { state: 'cancelled', by: me.id })
    return { state: 'cancelled' }
  },
})

/** The collecting job `export_id`'s organization, start and read state, or
 * null when it is not collecting. */
export const stepState = internalQuery({
  args: { export_id: v.string() },
  handler: async (ctx, { export_id }) => {
    const job = await exportOf(ctx, export_id)
    if (job === null || job.state !== 'collecting') return null
    return { org_id: job.org_id, started_at: job.started_at, step: job.step }
  },
})
const stepStateRef = makeFunctionReference<
  'query',
  { export_id: string },
  { org_id: string; started_at: string; step: ExportStep } | null
>('orgExport:stepState')

/** One bounded read of a job's current section (model/orgExportRead.ts
 * readBatch), for its step. */
export const readBatch = internalQuery({
  args: { org_id: v.string(), at: vExportCursor },
  handler: (ctx, { org_id, at }): Promise<ExportBatch> => readExportBatch(ctx, org_id, at),
})
const readBatchRef = makeFunctionReference<
  'query',
  { org_id: string; at: ExportCursor },
  ExportBatch
>('orgExport:readBatch')

/* A stored part as a commit names it. */
const vStored = v.object({
  storage_id: v.id('_storage'),
  raw_bytes: v.number(),
  stored_bytes: v.number(),
  crc32: v.number(),
})
type Stored = { storage_id: Id<'_storage'>; raw_bytes: number; stored_bytes: number; crc32: number }

const commitPartRef = makeFunctionReference<
  'mutation',
  {
    export_id: string
    n: number
    at: ExportCursor
    done: boolean
    records: number
    skipped: number
    part?: Stored
  },
  boolean
>('orgExport:commitPart')

/** What the finish reads to write the manifest: the organization, the
 * skipped tasks and every part in archive order. */
export const finishInfo = internalQuery({
  args: { export_id: v.string() },
  handler: async (ctx, { export_id }) => {
    const job = await exportOf(ctx, export_id)
    if (job === null || job.state !== 'collecting') return null
    const org = await byId(ctx, 'organizations', job.org_id)
    const parts = await partsOf(ctx, export_id).take(EXPORT_LIMITS.parts)
    return {
      organization:
        org === null ? { id: job.org_id } : { id: org.id, name: org.name, slug: org.slug },
      skipped: job.skipped ?? 0,
      parts: parts.map(({ entry, kind, records }) => ({ entry, kind, records })),
    }
  },
})
const finishInfoRef = makeFunctionReference<
  'query',
  { export_id: string },
  {
    organization: { id: string; name?: string; slug?: string }
    skipped: number
    parts: { entry: string; kind: string; records: number }[]
  } | null
>('orgExport:finishInfo')

const commitFinishRef = makeFunctionReference<
  'mutation',
  { export_id: string; n: number; readme: Stored; manifest: Stored },
  boolean
>('orgExport:commitFinish')

/* Compresses `raw` as one complete raw DEFLATE stream and stores it. */
async function store(ctx: ActionCtx, raw: Uint8Array): Promise<Stored> {
  const packed = deflateSync(raw)
  const storage_id = await ctx.storage.store(new Blob([packed]))
  return { storage_id, raw_bytes: raw.length, stored_bytes: packed.length, crc32: crc32(raw) }
}

/* `chunks` joined into one JSON array of `records` rows, one row a line;
 * the chunks hold the rows' JSON with the commas between them. */
function jsonArray(chunks: Uint8Array[], records: number): Uint8Array {
  const encoder = new TextEncoder()
  if (records === 0) return encoder.encode('[]\n')
  const head = encoder.encode('[\n')
  const tail = encoder.encode('\n]\n')
  const out = new Uint8Array(
    head.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0) + tail.length,
  )
  out.set(head, 0)
  let at = head.length
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  out.set(tail, at)
  return out
}

/* The README and manifest of a job whose sections are all read, stored and
 * committed. */
async function finish(
  ctx: ActionCtx,
  exportId: string,
  job: { started_at: string; step: ExportStep },
): Promise<void> {
  const info = await ctx.runQuery(finishInfoRef, { export_id: exportId })
  if (info === null) return
  const encoder = new TextEncoder()
  const manifest = jobManifest({
    organization: info.organization,
    started_at: job.started_at,
    completed_at: new Date().toISOString(),
    tables: archiveTables(info.parts) ?? {},
    skipped_tasks: info.skipped,
  })
  const readme = await store(ctx, encoder.encode(JOB_README))
  const listed = await store(ctx, encoder.encode(manifest))
  const committed = await ctx.runMutation(commitFinishRef, {
    export_id: exportId,
    n: job.step.n,
    readme,
    manifest: listed,
  })
  if (!committed) {
    await ctx.storage.delete(readme.storage_id)
    await ctx.storage.delete(listed.storage_id)
  }
}

/** One step of an export job: the next part of its current section, or the
 * README and manifest once every section is read. It holds one part at
 * most, about EXPORT_LIMITS.part of JSON and one readBatch answer past it
 * (model/orgExports.ts PART_RAW_BYTES), and makes at most
 * EXPORT_LIMITS.reads reads before it stores what it has. A step whose
 * reads found no row and did not end the section commits its read state
 * without a part. */
export const step = internalAction({
  args: { export_id: v.string() },
  handler: async (ctx, { export_id }): Promise<null> => {
    const job = await ctx.runQuery(stepStateRef, { export_id })
    if (job === null) return null
    if (job.step.section >= ORG_EXPORT_ORDER.length) {
      await finish(ctx, export_id, job)
      return null
    }
    const encoder = new TextEncoder()
    let at: ExportCursor = {
      section: job.step.section,
      cursor: job.step.cursor,
      ...(job.step.parents === undefined ? {} : { parents: job.step.parents }),
    }
    const chunks: Uint8Array[] = []
    let raw = 0
    let records = 0
    let skipped = 0
    let done = false
    for (let read = 0; read < EXPORT_LIMITS.reads && raw < EXPORT_LIMITS.part && !done; read++) {
      const batch = await ctx.runQuery(readBatchRef, { org_id: job.org_id, at })
      if (batch.rows.length > 0) {
        const text = batch.rows.map((row) => JSON.stringify(archiveRow(row))).join(',\n')
        const bytes = encoder.encode(records > 0 ? `,\n${text}` : text)
        chunks.push(bytes)
        raw += bytes.length
        records += batch.rows.length
      }
      at = batch.at
      done = batch.done
      skipped += batch.skipped
    }
    // A section's first file is written even when the section is empty.
    const part =
      records > 0 || (done && job.step.part === 1)
        ? await store(ctx, jsonArray(chunks.splice(0), records))
        : undefined
    const committed = await ctx.runMutation(commitPartRef, {
      export_id,
      n: job.step.n,
      at,
      done,
      records,
      skipped,
      ...(part === undefined ? {} : { part }),
    })
    if (!committed && part !== undefined) await ctx.storage.delete(part.storage_id)
    return null
  },
})

/** Commits one step's part and read state, and schedules the next step.
 * Answers false, changing nothing, when the job is not collecting, another
 * commit took this step or the part's file is gone. Ends the job as failed
 * and answers false when it must stop (model/orgExports.ts stopReason) or
 * the part would take the archive past its cap (archiveCap) or
 * EXPORT_LIMITS.parts. */
export const commitPart = internalMutation({
  args: {
    export_id: v.string(),
    n: v.number(),
    at: vExportCursor,
    done: v.boolean(),
    records: v.number(),
    skipped: v.number(),
    part: v.optional(vStored),
  },
  handler: async (ctx, a): Promise<boolean> => {
    const job = await exportOf(ctx, a.export_id)
    if (job === null || job.state !== 'collecting' || job.step.n !== a.n) return false
    const section = ORG_EXPORT_ORDER[job.step.section]
    if (section === undefined || a.at.section !== job.step.section) return false
    if (a.part !== undefined && (await ctx.db.system.get(a.part.storage_id)) === null) return false
    const stop = await stopReason(ctx, job)
    if (stop !== null) {
      await endJob(ctx, job, { state: 'failed', code: stop })
      return false
    }
    const name = exportName(section)
    let { part, seq, bytes } = job.step
    if (a.part !== undefined) {
      const entry = partEntry(name, part)
      bytes += a.part.stored_bytes + zipEntryBytes(entry)
      // this part, then the README and the manifest
      if (bytes + ZIP_END_BYTES > archiveCap() || seq + 1 > EXPORT_LIMITS.parts) {
        await endJob(ctx, job, { state: 'failed', code: 'too_large' })
        return false
      }
      await ctx.db.insert('org_export_parts', {
        export_id: job.id,
        org_id: job.org_id,
        seq,
        entry,
        kind: 'data',
        ...a.part,
        records: a.records,
      })
      part += 1
      seq += 1
    }
    const counts = { ...job.step.counts, [name]: (job.step.counts[name] ?? 0) + a.records }
    const next: ExportStep = a.done
      ? { n: a.n + 1, section: job.step.section + 1, cursor: null, part: 1, seq, bytes, counts }
      : {
          n: a.n + 1,
          section: job.step.section,
          cursor: a.at.cursor,
          ...(a.at.parents === undefined ? {} : { parents: a.at.parents }),
          part,
          seq,
          bytes,
          counts,
        }
    const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { export_id: job.id })
    await ctx.db.patch(job._id, {
      step: next,
      progress: progressOf(next.section, job.progress.records + a.records),
      progress_at: new Date().toISOString(),
      attempts: 0,
      scheduled_id,
      skipped: (job.skipped ?? 0) + a.skipped,
    })
    return true
  },
})

/* The earlier ready archives one finish ends. A release from before the
 * rule can leave more than one; their own expiry ends the rest. */
const READY_ENDS = 8

/** Publishes the archive: checks the job as commitPart does, checks that
 * every table has its files in order with no gap and every part's file is
 * still stored (else the job fails as incomplete), stores the README and
 * manifest rows and makes the job ready for ARCHIVE_TTL_MS, scheduling its
 * expiry. It ends the organization's earlier ready archive and erases its
 * parts. Answers false when it published nothing. */
export const commitFinish = internalMutation({
  args: { export_id: v.string(), n: v.number(), readme: vStored, manifest: vStored },
  handler: async (ctx, a): Promise<boolean> => {
    const job = await exportOf(ctx, a.export_id)
    if (
      job === null ||
      job.state !== 'collecting' ||
      job.step.n !== a.n ||
      job.step.section < ORG_EXPORT_ORDER.length
    )
      return false
    for (const file of [a.readme, a.manifest])
      if ((await ctx.db.system.get(file.storage_id)) === null) return false
    const stop = await stopReason(ctx, job)
    if (stop !== null) {
      await endJob(ctx, job, { state: 'failed', code: stop })
      return false
    }
    const parts = await partsOf(ctx, job.id).take(EXPORT_LIMITS.parts)
    let whole = archiveTables(parts) !== null
    for (const part of parts)
      if (whole && (await ctx.db.system.get(part.storage_id)) === null) whole = false
    if (!whole) {
      await endJob(ctx, job, { state: 'failed', code: 'incomplete' })
      return false
    }
    const bytes =
      job.step.bytes +
      a.readme.stored_bytes +
      zipEntryBytes('README.txt') +
      a.manifest.stored_bytes +
      zipEntryBytes('manifest.json') +
      ZIP_END_BYTES
    if (bytes > archiveCap()) {
      await endJob(ctx, job, { state: 'failed', code: 'too_large' })
      return false
    }
    // One ready archive per organization: this one ends the one before it.
    for (const earlier of await readyJobs(ctx, job.org_id).take(READY_ENDS))
      await endJob(ctx, earlier, { state: 'expired' })
    const files = [
      { seq: 0, entry: 'README.txt', kind: 'readme', stored: a.readme },
      { seq: 1, entry: 'manifest.json', kind: 'manifest', stored: a.manifest },
    ] as const
    for (const { seq, entry, kind, stored } of files)
      await ctx.db.insert('org_export_parts', {
        export_id: job.id,
        org_id: job.org_id,
        seq,
        entry,
        kind,
        ...stored,
        records: 0,
      })
    const now = Date.now()
    const expires = now + ARCHIVE_TTL_MS
    const scheduled_id = await ctx.scheduler.runAt(expires, expireRef, { export_id: job.id })
    await ctx.db.patch(job._id, {
      state: 'ready',
      step: { ...job.step, n: a.n + 1 },
      progress_at: new Date(now).toISOString(),
      completed_at: new Date(now).toISOString(),
      expires_at: new Date(expires).toISOString(),
      archive: { bytes, parts: parts.length + files.length },
      attempts: 0,
      scheduled_id,
    })
    console.info('Organization export ready', {
      export_id: job.id,
      bytes,
      parts: parts.length + files.length,
      collect_ms: now - Date.parse(job.started_at),
    })
    return true
  },
})

/** Ends a ready archive at the end of its four hours and erases its parts.
 * Does nothing to any other job, or before then. */
export const expire = internalMutation({
  args: { export_id: v.string() },
  handler: async (ctx, { export_id }): Promise<null> => {
    const job = await exportOf(ctx, export_id)
    if (job?.state !== 'ready' || job.expires_at === undefined) return null
    if (Date.parse(job.expires_at) > Date.now()) return null
    await endJob(ctx, job, { state: 'expired' })
    return null
  },
})

/** One erase leg of an ended job: up to EXPORT_LIMITS.erase parts, each row
 * with its file at once, then the next leg while parts are left. Does
 * nothing to a collecting or ready job. */
export const erase = internalMutation({
  args: { export_id: v.string() },
  handler: async (ctx, { export_id }): Promise<null> => {
    const job = await exportOf(ctx, export_id)
    if (job === null || job.state === 'collecting' || job.state === 'ready') return null
    if (await eraseParts(ctx, job.id)) {
      const scheduled_id = await ctx.scheduler.runAfter(0, eraseRef, { export_id })
      await ctx.db.patch(job._id, { erasing_at: new Date().toISOString(), scheduled_id })
    } else await ctx.db.patch(job._id, { erasing_at: undefined, scheduled_id: undefined })
    return null
  },
})

const RECOVER_BATCH = 32
/* The most stalled jobs one recovery looks at, oldest progress first. Jobs
 * whose step still waits or runs are skipped without counting toward
 * RECOVER_BATCH, as in labelRemovals.ts. */
const RECOVER_SCAN = 512

/** Restarts collecting jobs whose last step committed more than STALLED_MS
 * ago and whose step neither waits nor runs. A job that must stop
 * (model/orgExports.ts stopReason), such as one whose organization or
 * requesters an earlier release deleted, fails at once, and a job restarted
 * RESTARTS times without a commit fails as stalled. */
export const recover = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const now = Date.now()
    const stalled = await ctx.db
      .query('org_exports')
      .withIndex('by_state_progress', (q) =>
        q.eq('state', 'collecting').lt('progress_at', new Date(now - STALLED_MS).toISOString()),
      )
      .take(RECOVER_SCAN)
    let handled = 0
    for (const job of stalled) {
      if (handled === RECOVER_BATCH) break
      const next = job.scheduled_id === undefined ? null : await ctx.db.system.get(job.scheduled_id)
      if (next?.state.kind === 'pending' || next?.state.kind === 'inProgress') continue
      handled += 1
      const stop = await stopReason(ctx, job)
      if (stop !== null || job.attempts >= RESTARTS) {
        await endJob(ctx, job, { state: 'failed', code: stop ?? 'stalled' })
        continue
      }
      const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { export_id: job.id })
      await ctx.db.patch(job._id, { scheduled_id, attempts: job.attempts + 1 })
      console.warn('Organization export resumed', {
        export_id: job.id,
        attempts: job.attempts + 1,
        stalled_ms: now - Date.parse(job.progress_at),
      })
    }
    return null
  },
})

/* The most jobs one sweep takes up in each of its parts, and the rows
 * (parts, requests and jobs) it deletes of ended jobs past their history. */
const SWEEP = { jobs: 64, rows: 512 }

/** Expires ready archives whose expiry timer was lost, restarts erase legs
 * that stopped, and deletes ended jobs older than HISTORY_MS with their
 * parts and request rows, within SWEEP; the next sweep goes on. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const now = Date.now()
    const due = await ctx.db
      .query('org_exports')
      .withIndex('by_state_expiry', (q) =>
        q.eq('state', 'ready').lte('expires_at', new Date(now).toISOString()),
      )
      .take(SWEEP.jobs)
    for (const job of due) await endJob(ctx, job, { state: 'expired' })

    const erasing = await ctx.db
      .query('org_exports')
      .withIndex('by_erasing', (q) =>
        q.gte('erasing_at', '').lt('erasing_at', new Date(now - STALLED_MS).toISOString()),
      )
      .take(SWEEP.jobs)
    for (const job of erasing) {
      const next = job.scheduled_id === undefined ? null : await ctx.db.system.get(job.scheduled_id)
      if (next?.state.kind === 'pending' || next?.state.kind === 'inProgress') continue
      const scheduled_id = await ctx.scheduler.runAfter(0, eraseRef, { export_id: job.id })
      await ctx.db.patch(job._id, { scheduled_id })
    }

    let left = SWEEP.rows
    const before = new Date(now - HISTORY_MS).toISOString()
    for (const state of ['failed', 'cancelled', 'expired'] as const) {
      const old = await ctx.db
        .query('org_exports')
        .withIndex('by_state_ended', (q) => q.eq('state', state).lt('ended_at', before))
        .take(SWEEP.jobs)
      for (const job of old) {
        for (const part of await partsOf(ctx, job.id).take(left)) {
          await ctx.db.delete(part._id)
          await eraseFile(ctx, part.storage_id)
          left -= 1
        }
        if (left <= 0) return null
        for (const row of await requestsOf(ctx, job.id).take(left)) {
          await ctx.db.delete(row._id)
          left -= 1
        }
        if (left <= 0) return null
        await ctx.db.delete(job._id)
        left -= 1
      }
    }
    return null
  },
})

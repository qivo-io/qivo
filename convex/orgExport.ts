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
 * The archive is format 4 (lib/orgExport.ts): the live sections under data/,
 * then the organization's retained Deleted items under deleted/, each
 * stored table read on its own and the items last, each item marked
 * complete or partial with the reason (model/orgExportRead.ts storedBatch,
 * itemsBatch). The step keeps when each live section ended and which of
 * them found a deleted item in flight, the items seen changing (at most
 * EXPORT_LIMITS.unsettled, past which the job fails with
 * `deleted_changing`), the stored rows left out with the items that held
 * them (noteLeftOut) and the item tallies, for the manifest. A job
 * collecting at the deploy of format 4 goes on into the Deleted items
 * section and finishes as format 4.
 *
 * The reads are live, not a snapshot of one moment (lib/orgExport.ts
 * LIVE_READ_WARNING). The archive is data only: no step reads an
 * attachment's or a picture's bytes. Any admin may cancel a collecting job;
 * a failed, cancelled or expired job's parts are erased at once in `erase`
 * legs. Ended jobs and their request rows stay 30 days as history.
 *
 * Delivery. Any active admin of the organization gets a link of two
 * minutes to a ready archive from `claimDownload` (model/orgExports.ts
 * DELIVERY.tokenSeconds, an org_export file token, lib/fileTokens.ts), and
 * an admin who asked for the job gets one automatic attempt, recorded on
 * their request row however many tabs ask. The /exports/ route (http.ts)
 * checks the link and then, on every request, the admin's authority, the
 * job and the organization (deliveryOf), takes a lease (leaseDelivery, at
 * most DELIVERY.streams a job) and streams the stored parts as one ZIP
 * without the function holding the archive. On a local backend the
 * runtime read that body as fast as storage allowed, whatever the client
 * took (http.ts archiveStream), so the lease and the checks before every
 * part (canDeliver) and of every part's size cover the backend's read of
 * the archive, not the client's transfer. An archive the backend read
 * whole sets only the job's first served_at (recordDelivery), so a
 * download the client abandons can still set it. The route never writes
 * the organization's last_export_at, which the deletion reminder reads, so
 * neither a prepared archive (completed_at) nor a served one counts as a
 * backup. Only orgRemovals.ts recordExport sets it, which the app calls
 * once the desktop app or a browser confirmed a saved file of exactly the
 * archive's bytes, and which records only a served archive of the
 * organization that is ready or ended less than DELIVERY.streamMs before.
 * A ready archive whose file is gone fails as
 * incomplete (failDelivery). Neither the claim nor the route touches the
 * four hours.
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
  type QueryCtx,
} from './_generated/server'
import { assertOrgAvailable, deletionBegun } from './lib/billingAccess'
import { crc32 } from './lib/crc32'
import { byId } from './lib/db'
import { demoForOrg, isDemoDeployment, uncountedWriter } from './lib/demo'
import type { OrgExportState } from './lib/enums'
import { exportFileUrl, mintFileToken } from './lib/fileTokens'
import {
  authedMutation,
  badRequest,
  forbidden,
  notFound,
  orgQuery,
  require,
  rule,
} from './lib/functions'
import {
  archiveFileName,
  archiveRow,
  archiveTables,
  type DeletedTally,
  type ExportCursor,
  type ExportStep,
  JOB_ORDER,
  JOB_README,
  jobManifest,
  ORG_EXPORT_FORMAT,
  ORG_EXPORT_SECTIONS,
  type OrgExportPage,
  partEntry,
  vExportCursor,
  ZIP_END_BYTES,
  zipEntryBytes,
} from './lib/orgExport'
import { demoCanRead } from './model/demoUploads'
import { eraseFile } from './model/fileHolds'
import {
  type BatchJob,
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
  DELIVERY,
  deploymentStreams,
  EXPORT_LIMITS,
  endJob,
  eraseParts,
  exportOf,
  HISTORY_MS,
  jobsOf,
  liveStreams,
  noteDelivered,
  partsOf,
  RESTARTS,
  readyJobs,
  requestsOf,
  STALLED_MS,
  setStreams,
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
  section: section < JOB_ORDER.length ? JOB_ORDER[section].key : '',
  records,
  sections_done: section,
  sections_total: JOB_ORDER.length,
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
  // when the backend first read the archive whole into a download's
  // response, never proof that the client received or saved it
  served_at: string | null
  // when the caller's own automatic download was claimed, while `requested`
  auto_download_at: string | null
}

/** The organization's latest export job, and its latest ready archive that
 * has not expired when that is another job. */
export const status = orgQuery({
  args: {},
  handler: async (ctx): Promise<{ latest: ExportSummary | null; ready: ExportSummary | null }> => {
    if (ctx.me.org_role !== 'admin') throw forbidden(ADMINS_ONLY)
    const me = ctx.me
    // A profile's name, when it is still in the organization and was
    // created by `before` (epoch milliseconds), when it acted on the job; a
    // later profile can take a removed one's id.
    const nameOf = async (id: string | undefined, before: number) => {
      if (id === undefined) return null
      const profile = await byId(ctx, 'profiles', id)
      return profile !== null && profile.org_id === me.org_id && profile._creationTime < before
        ? profile.name
        : null
    }
    const summary = async (job: Doc<'org_exports'>): Promise<ExportSummary> => {
      const mine = await requestOf(ctx, job.id, me.id)
      const requested = mine !== null && me._creationTime < mine._creationTime
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
        // the first requester started the job; the canceller ended it, and
        // may have joined the organization while it collected (ended_at is
        // to the millisecond, so a profile of that millisecond counts)
        requested_by: await nameOf(job.requested_by, job._creationTime),
        cancelled_by: await nameOf(
          job.cancelled_by,
          job.ended_at === undefined ? job._creationTime : Date.parse(job.ended_at) + 1,
        ),
        requested,
        served_at: job.served_at ?? null,
        auto_download_at: requested ? (mine.auto_download_at ?? null) : null,
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

/* ------------------------------------------------------------ delivery */

/* The refusals of a claim for a job that has no archive to download. */
const STILL_COLLECTING = 'This export is still being prepared. Download it once it is ready.'
const NO_LONGER_AVAILABLE = 'This export is no longer available. Prepare a new export.'

/** What claimDownload answers: a link and when it stops starting a
 * download, or why an automatic attempt gets none. */
export type DownloadClaim =
  | { url: string; expires_at: string }
  | { url: null; reason: 'claimed' | 'not_requested' }

/** A link of DELIVERY.tokenSeconds to the ready archive `export_id` of
 * `org_id`, for the export page to send the browser to at once. Any active
 * admin of the organization may download, whether or not they asked for
 * the job, and the /exports/ route checks that again on every request.
 *
 * With `automatic`, the page's automatic download: only for an admin who
 * asked for the job (their request row, their profile older than it, as
 * `status`' `requested` asks, else `not_requested`), once per job however
 * many tabs, devices or reconnects ask, recorded on that row (`claimed`
 * after the first). Two claims at once conflict on the row, and Convex runs
 * the second again, which then finds it. Without `automatic` it writes
 * nothing, though on the public demo it still spends one demo change, as
 * every authedMutation does.
 *
 * Refuses a caller who is not an active admin there (an organization whose
 * deletion has begun holds no active seat, so its admins get the same),
 * an unknown export and another organization's alike, and a job with no
 * unexpired ready archive, a collecting one with its own sentence. The
 * answer never holds a storage id, and `expires_at` is the link's own end,
 * so a later click claims again. Allowed while the organization is
 * read-only before its deletion, as `request` is. */
export const claimDownload = authedMutation({
  args: { org_id: v.string(), export_id: v.string(), automatic: v.boolean() },
  handler: async (ctx, { org_id, export_id, automatic }): Promise<DownloadClaim> => {
    const me = ctx.myProfiles.get(org_id)
    if (me?.org_role !== 'admin') throw forbidden(ADMINS_ONLY)
    await assertOrgAvailable(ctx, org_id)
    const job = await exportOf(ctx, export_id)
    if (job === null || job.org_id !== org_id) throw notFound('export not found')
    if (job.state === 'collecting') throw rule(STILL_COLLECTING)
    if (
      job.state !== 'ready' ||
      job.expires_at === undefined ||
      Date.parse(job.expires_at) <= Date.now()
    )
      throw rule(NO_LONGER_AVAILABLE)
    if (automatic) {
      const mine = await requestOf(ctx, export_id, me.id)
      if (mine === null || me._creationTime >= mine._creationTime)
        return { url: null, reason: 'not_requested' }
      if (mine.auto_download_at !== undefined) return { url: null, reason: 'claimed' }
      // request rows are a temporary copy, not the visitor's records
      await uncountedWriter(ctx.db).patch(mine._id, { auto_download_at: new Date().toISOString() })
    }
    // a second past the claim's whole second, so the moment the link counts
    // as minted (exp less its lifetime, deliverable) is after every profile
    // the claim found; the link lives DELIVERY.tokenSeconds and at most one
    // second more. The link names the caller's profile document, not its
    // uuid, so a later profile that takes a removed admin's uuid within
    // that second still matches nothing (deliverable).
    const exp = Math.floor(Date.now() / 1000) + 1 + DELIVERY.tokenSeconds
    const token = await mintFileToken({ kind: 'org_export', id: export_id, minter: me._id, exp })
    return {
      url: exportFileUrl({ id: export_id, minter: me._id, exp, token }),
      expires_at: new Date(exp * 1000).toISOString(),
    }
  },
})

/** Admin `profileId`'s request row for export `exportId`, or null. */
const requestOf = (ctx: QueryCtx, exportId: string, profileId: string) =>
  ctx.db
    .query('org_export_requests')
    .withIndex('by_export_profile', (q) => q.eq('export_id', exportId).eq('profile_id', profileId))
    .first()

/* The ready job `exportId` with its organization while the profile
 * document `minter` (its Convex id, which claimDownload signs into the
 * link) may still download it through a link that expires at `exp` (unix
 * seconds), else null. The job is ready with an archive and has not
 * expired; the minter is an active admin of the job's organization,
 * created before the link was minted (`exp` less DELIVERY.tokenSeconds);
 * the organization is there and its deletion has not begun; and on the
 * public demo its cleanup has not begun and the minter's session still
 * reads it (model/demoUploads.ts demoCanRead). A later profile that takes
 * a removed admin's uuid is another document, so it never matches, also
 * when it was created within the second the claim rounds the mint up to.
 * Reads the job, the profile, the removal, the organization and on the
 * demo two receipts. */
async function deliverable(ctx: QueryCtx, exportId: string, minter: string, exp: number) {
  const job = await exportOf(ctx, exportId)
  if (
    job?.state !== 'ready' ||
    job.archive === undefined ||
    job.expires_at === undefined ||
    job.completed_at === undefined ||
    Date.parse(job.expires_at) <= Date.now()
  )
    return null
  const profileId = ctx.db.normalizeId('profiles', minter)
  const profile = profileId === null ? null : await ctx.db.get(profileId)
  if (
    profile === null ||
    profile.org_id !== job.org_id ||
    !profile.active ||
    profile.org_role !== 'admin' ||
    profile._creationTime >= (exp - DELIVERY.tokenSeconds) * 1000
  )
    return null
  if (await deletionBegun(ctx, job.org_id)) return null
  if (isDemoDeployment()) {
    if ((await demoForOrg(ctx, job.org_id))?.status === 'deleting') return null
    if (
      profile.auth_user_id === undefined ||
      !(await demoCanRead(ctx, profile.auth_user_id, job.org_id))
    )
      return null
  }
  const org = await byId(ctx, 'organizations', job.org_id)
  if (org === null) return null
  return { job, org, archive: job.archive, completed_at: job.completed_at }
}

/* The parts of ready job `job` in archive order when they make the archive
 * its row describes (`archive`), else null: at most EXPORT_LIMITS.parts
 * data parts and the README and manifest at seq 0 and 1, as many as
 * archive.parts, whose stored bytes and ZIP headers sum to archive.bytes,
 * each file still stored at its stored size. It does not check the table
 * order again, which commitFinish checked when it published the archive,
 * so an archive of an earlier format with fewer sections stays
 * deliverable. One range for the parts and one lookup a file. */
async function deliverableParts(
  ctx: QueryCtx,
  job: Doc<'org_exports'>,
  archive: { bytes: number; parts: number },
): Promise<Doc<'org_export_parts'>[] | null> {
  const parts = await partsOf(ctx, job.id).take(EXPORT_LIMITS.parts + 3)
  if (parts.length > EXPORT_LIMITS.parts + 2 || parts.length !== archive.parts) return null
  const [readme, manifest] = parts
  if (readme?.seq !== 0 || readme.kind !== 'readme') return null
  if (manifest?.seq !== 1 || manifest.kind !== 'manifest') return null
  let bytes = ZIP_END_BYTES
  for (const part of parts) bytes += part.stored_bytes + zipEntryBytes(part.entry)
  if (bytes !== archive.bytes) return null
  for (const part of parts)
    if ((await ctx.db.system.get(part.storage_id))?.size !== part.stored_bytes) return null
  return parts
}

/** What the route needs to serve a ready archive, after the checks of
 * `deliverable` and of its parts (deliverableParts): its file name, the
 * time it was ready, its bytes and, in archive order, each part's entry,
 * file, CRC and sizes. Null when the link's admin may not download it now,
 * and `missing` when the archive is damaged, which failDelivery then ends.
 * It reads what the finish read, a handful of ranges and one more a data
 * part for its file's lookup. At EXPORT_LIMITS.parts data parts that is
 * 4,007 ranges, 8,007 documents and 1.742 MiB, answering 477 KiB, under
 * Convex's 4,096 ranges (measured with the cap's parts planted, 6 November
 * 2026; convex/tests/orgExportDelivery.test.ts checks the growth a part at
 * a lowered cap). deliveryOf runs it for the route. */
export async function readDelivery(
  ctx: QueryCtx,
  { export_id, minter, exp }: { export_id: string; minter: string; exp: number },
) {
  const allowed = await deliverable(ctx, export_id, minter, exp)
  if (allowed === null) return null
  const parts = await deliverableParts(ctx, allowed.job, allowed.archive)
  if (parts === null) return { missing: true as const }
  return {
    name: archiveFileName(allowed.org.slug || allowed.org.id, allowed.completed_at),
    completed_at: allowed.completed_at,
    bytes: allowed.archive.bytes,
    // the route's slices, so http.ts loads nothing of the job's model
    slice: DELIVERY.slice,
    parts: parts.map(({ entry, storage_id, crc32, raw_bytes, stored_bytes }) => ({
      entry,
      storage_id,
      crc32,
      raw_bytes,
      stored_bytes,
    })),
  }
}

/** The ready archive the route serves (readDelivery). */
export const deliveryOf = internalQuery({
  args: { export_id: v.string(), minter: v.string(), exp: v.number() },
  handler: readDelivery,
})

/** Whether the link's admin may still download export `export_id`
 * (`deliverable`). The route asks before each part, so a demotion, a
 * deletion that begins or the archive's end stop a download under way. A
 * handful of reads, whatever the archive's size. */
export const canDeliver = internalQuery({
  args: { export_id: v.string(), minter: v.string(), exp: v.number() },
  handler: async (ctx, { export_id, minter, exp }): Promise<boolean> =>
    (await deliverable(ctx, export_id, minter, exp)) !== null,
})

/** A lease for one download of export `export_id`, taken just before the
 * route answers: null when the link's admin may no longer download it
 * (`deliverable`), and `busy` with the seconds to wait when
 * DELIVERY.streams downloads of the archive run already, or on the public
 * demo DELIVERY.demoStreams on the whole deployment. A lease the route
 * never releases runs out after DELIVERY.streamMs. */
export const leaseDelivery = internalMutation({
  args: { export_id: v.string(), minter: v.string(), exp: v.number() },
  handler: async (
    ctx,
    { export_id, minter, exp },
  ): Promise<{ stream: string } | { busy: true; retry_after: number } | null> => {
    const allowed = await deliverable(ctx, export_id, minter, exp)
    if (allowed === null) return null
    const now = Date.now()
    const live = liveStreams(allowed.job, now)
    const busy = { busy: true as const, retry_after: DELIVERY.retrySeconds }
    if (live.length >= DELIVERY.streams) return busy
    if (isDemoDeployment() && (await deploymentStreams(ctx, now)) >= DELIVERY.demoStreams)
      return busy
    const stream = newUuid()
    await setStreams(ctx, allowed.job, [...live, { id: stream, until: now + DELIVERY.streamMs }])
    return { stream }
  },
})

/** Ends download `stream`'s lease on export `export_id` after a download
 * that stopped short, dropping leases that ran out too. Changes nothing
 * else. */
export const releaseDelivery = internalMutation({
  args: { export_id: v.string(), stream: v.string() },
  handler: async (ctx, { export_id, stream }): Promise<null> => {
    const job = await exportOf(ctx, export_id)
    if (job === null || job.streams === undefined) return null
    await setStreams(
      ctx,
      job,
      liveStreams(job, Date.now()).filter((lease) => lease.id !== stream),
    )
    return null
  },
})

/** Records that the route handed its reader, the runtime, the last byte of
 * export `export_id`'s archive in the job's first served_at
 * (model/orgExports.ts noteDelivered) and ends download `stream`'s lease.
 * It leaves organizations.last_export_at alone, since the backend cannot
 * know that the client received the archive, so a served archive does not
 * count as an export for the deletion reminder until the app confirms the
 * saved file (orgRemovals.ts recordExport, which requires served_at). It
 * needs no authority,
 * since the route checked the admin before every part it read, and writes
 * no request row, so an admin who did not ask downloads as one who did. */
export const recordDelivery = internalMutation({
  args: { export_id: v.string(), stream: v.string() },
  handler: async (ctx, { export_id, stream }): Promise<null> => {
    const job = await exportOf(ctx, export_id)
    if (job === null) return null
    await noteDelivered(ctx, job)
    await setStreams(
      ctx,
      job,
      liveStreams(job, Date.now()).filter((lease) => lease.id !== stream),
    )
    return null
  },
})

/** Ends export `export_id` as failed with `incomplete` when it is still
 * ready and its parts no longer make its archive (deliverableParts), such
 * as a file that is gone, so `status` asks for a new export instead of
 * offering a download that cannot work. Only the job's own expiry and a
 * newer archive erase its files, and endJob changes the state first, so a
 * ready archive without a file is damaged. Changes nothing otherwise. */
export const failDelivery = internalMutation({
  args: { export_id: v.string() },
  handler: async (ctx, { export_id }): Promise<null> => {
    const job = await exportOf(ctx, export_id)
    if (job?.state !== 'ready' || job.archive === undefined) return null
    if ((await deliverableParts(ctx, job, job.archive)) !== null) return null
    await endJob(ctx, job, { state: 'failed', code: 'incomplete' })
    return null
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

/* What a Deleted items section needs of its job (model/orgExportRead.ts
 * BatchJob). */
const vBatchJob = v.object({
  started_at: v.string(),
  ended: v.record(v.string(), v.string()),
  in_flight: v.array(v.string()),
  unsettled: v.array(v.string()),
})

/** One bounded read of a job's current section (model/orgExportRead.ts
 * readBatch), for its step; `wide: false` after a wide tasks page answered
 * `retry: 'narrow'`, and `job` for a Deleted items section. */
export const readBatch = internalQuery({
  args: {
    org_id: v.string(),
    at: vExportCursor,
    wide: v.optional(v.boolean()),
    job: v.optional(vBatchJob),
  },
  handler: (ctx, { org_id, at, wide, job }): Promise<ExportBatch> =>
    readExportBatch(ctx, org_id, at, { wide, job }),
})
const readBatchRef = makeFunctionReference<
  'query',
  { org_id: string; at: ExportCursor; wide?: boolean; job?: BatchJob },
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

/* What a step of the Deleted items section tallied besides its rows. */
const vDeletedStep = {
  unsettled: v.optional(v.array(v.string())),
  left_out: v.optional(v.number()),
  items: v.optional(v.object({ complete: v.number(), partial: v.number() })),
}

const noteLeftOutRef = makeFunctionReference<
  'mutation',
  { export_id: string; n: number; items: string[] },
  null
>('orgExport:noteLeftOut')

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
    in_flight?: boolean
    unsettled?: string[]
    left_out?: number
    items?: { complete: number; partial: number }
  },
  boolean
>('orgExport:commitPart')

/** What the finish reads to write the manifest: the organization, the
 * skipped tasks, the Deleted items tallies and every part in archive
 * order. */
export const finishInfo = internalQuery({
  args: { export_id: v.string() },
  handler: async (ctx, { export_id }) => {
    const job = await exportOf(ctx, export_id)
    if (job === null || job.state !== 'collecting') return null
    const org = await byId(ctx, 'organizations', job.org_id)
    const parts = await partsOf(ctx, export_id).take(EXPORT_LIMITS.parts + 1)
    const deleted: DeletedTally = {
      items: job.step.items ?? { complete: 0, partial: 0 },
      left_out: job.step.left_out ?? {},
    }
    return {
      organization:
        org === null ? { id: job.org_id } : { id: org.id, name: org.name, slug: org.slug },
      skipped: job.skipped ?? 0,
      deleted,
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
    deleted: DeletedTally
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
    deleted: info.deleted,
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
 * without a part. Tasks are read 100 a page with their texts; once a page's
 * texts do not fit (`retry: 'narrow'`), the step reads the same cursor six
 * a page for the rest of the step, so a run of long texts costs one wasted
 * read a step rather than one every six tasks, and the next step tries
 * wide pages again. Whether to read narrow lives in the step's memory, not
 * in the stored read state.
 *
 * A live section's step tells its commit whether any read found a deleted
 * item in flight (`in_flight`). A Deleted items section's step passes each
 * read the job's start, its live sections' ends, the live sections that
 * found an item in flight and its unsettled items, and gathers the items
 * each read saw changing, the stored rows it left out and the items it
 * called complete or partial for its commit. It stops reading once the
 * unsettled items pass EXPORT_LIMITS.unsettled, and the commit then fails
 * the job. The items whose stored rows its reads left out it names to the
 * job just before its commit (noteLeftOut), one more than
 * EXPORT_LIMITS.leftOut at most. */
export const step = internalAction({
  args: { export_id: v.string() },
  handler: async (ctx, { export_id }): Promise<null> => {
    const job = await ctx.runQuery(stepStateRef, { export_id })
    if (job === null) return null
    if (job.step.section >= JOB_ORDER.length) {
      await finish(ctx, export_id, job)
      return null
    }
    const deleted = JOB_ORDER[job.step.section].folder === 'deleted'
    const known = job.step.unsettled ?? []
    const batchJob: BatchJob = {
      started_at: job.started_at,
      ended: job.step.ended ?? {},
      in_flight: job.step.in_flight ?? [],
      unsettled: known,
    }
    // the items this step saw changing, and the items whose records its
    // reads left out, that the job did not know yet
    const unsettled = new Set<string>()
    const knownShort = new Set(job.step.left_out_items ?? [])
    const short = new Set<string>()
    let leftOut = 0
    const items = { complete: 0, partial: 0 }
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
    let wide = true
    let inFlight = false
    for (let read = 0; read < EXPORT_LIMITS.reads && raw < EXPORT_LIMITS.part && !done; read++) {
      const batch = await ctx.runQuery(readBatchRef, {
        org_id: job.org_id,
        at,
        ...(wide ? {} : { wide: false }),
        ...(deleted ? { job: batchJob } : {}),
      })
      if (batch.retry === 'narrow') {
        wide = false
        continue
      }
      if (batch.in_flight) inFlight = true
      for (const id of batch.unsettled ?? []) if (!known.includes(id)) unsettled.add(id)
      // one past the names the job keeps is enough for noteLeftOut to stop
      if (job.step.left_out_more !== true)
        for (const id of batch.left_out_items ?? [])
          if (!knownShort.has(id) && knownShort.size + short.size <= EXPORT_LIMITS.leftOut)
            short.add(id)
      leftOut += batch.left_out ?? 0
      items.complete += batch.items?.complete ?? 0
      items.partial += batch.items?.partial ?? 0
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
      // the commit fails the job past the cap, so reading on is wasted
      if (known.length + unsettled.size > EXPORT_LIMITS.unsettled) break
    }
    // A section's first file is written even when the section is empty.
    const part =
      records > 0 || (done && job.step.part === 1)
        ? await store(ctx, jsonArray(chunks.splice(0), records))
        : undefined
    if (short.size > 0)
      await ctx.runMutation(noteLeftOutRef, { export_id, n: job.step.n, items: [...short] })
    const committed = await ctx.runMutation(commitPartRef, {
      export_id,
      n: job.step.n,
      at,
      done,
      records,
      skipped,
      ...(part === undefined ? {} : { part }),
      ...(inFlight ? { in_flight: true } : {}),
      ...(deleted ? { unsettled: [...unsettled], left_out: leftOut, items } : {}),
    })
    if (!committed && part !== undefined) await ctx.storage.delete(part.storage_id)
    return null
  },
})

/** Names to collecting job `export_id` the Deleted items `items`, any of
 * whose stored records a read of its step `n` left out
 * (model/orgExportRead.ts storedBatch), in step.left_out_items, so the
 * items section calls each partial (rows_left_out). Past EXPORT_LIMITS.leftOut names it keeps none
 * and sets step.left_out_more, and the items section then calls every item
 * it would call complete partial, since it can no longer tell which. The
 * step runs it just before its commit, so a commit that another took
 * leaves names a read found, which can only call an item partial. Changes
 * nothing when the job is not collecting or has moved past step `n`. */
export const noteLeftOut = internalMutation({
  args: { export_id: v.string(), n: v.number(), items: v.array(v.string()) },
  handler: async (ctx, { export_id, n, items }): Promise<null> => {
    const job = await exportOf(ctx, export_id)
    if (job === null || job.state !== 'collecting' || job.step.n !== n) return null
    if (job.step.left_out_more === true) return null
    const { left_out_items: known, ...rest } = job.step
    const names = [...new Set([...(known ?? []), ...items])]
    await ctx.db.patch(job._id, {
      step:
        names.length > EXPORT_LIMITS.leftOut
          ? { ...rest, left_out_more: true }
          : { ...rest, left_out_items: names },
    })
    return null
  },
})

/** Commits one step's part and read state, and schedules the next step.
 * Answers false, changing nothing, when the job is not collecting, another
 * commit took this step or the part's file is gone. Ends the job as failed
 * and answers false when it must stop (model/orgExports.ts stopReason), the
 * part would take the archive past its cap (archiveCap) or its data parts
 * past EXPORT_LIMITS.parts, or the Deleted items seen changing pass
 * EXPORT_LIMITS.unsettled (`deleted_changing`), since past that the items
 * section could not tell which items to call partial. It records when a
 * live section's read ended (step.ended) and a live section any of whose
 * reads found a deleted item in flight (step.in_flight), and adds a
 * Deleted items step's unsettled items, left-out rows and item tallies to
 * the step, keeping the items noteLeftOut named. */
export const commitPart = internalMutation({
  args: {
    export_id: v.string(),
    n: v.number(),
    at: vExportCursor,
    done: v.boolean(),
    records: v.number(),
    skipped: v.number(),
    part: v.optional(vStored),
    // a live section's step whose reads found a deleted item in flight
    in_flight: v.optional(v.boolean()),
    ...vDeletedStep,
  },
  handler: async (ctx, a): Promise<boolean> => {
    const job = await exportOf(ctx, a.export_id)
    if (job === null || job.state !== 'collecting' || job.step.n !== a.n) return false
    const section = JOB_ORDER[job.step.section]
    if (section === undefined || a.at.section !== job.step.section) return false
    if (a.part !== undefined && (await ctx.db.system.get(a.part.storage_id)) === null) return false
    const stop = await stopReason(ctx, job)
    if (stop !== null) {
      await endJob(ctx, job, { state: 'failed', code: stop })
      return false
    }
    const unsettled = [...new Set([...(job.step.unsettled ?? []), ...(a.unsettled ?? [])])]
    if (unsettled.length > EXPORT_LIMITS.unsettled) {
      await endJob(ctx, job, { state: 'failed', code: 'deleted_changing' })
      return false
    }
    const name = section.key
    let { part, seq, bytes } = job.step
    if (a.part !== undefined) {
      const entry = partEntry(section.name, part, section.folder)
      bytes += a.part.stored_bytes + zipEntryBytes(entry)
      // data parts start at seq 2, so this is data part seq - 1
      if (bytes + ZIP_END_BYTES > archiveCap() || seq - 1 > EXPORT_LIMITS.parts) {
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
    const now = new Date().toISOString()
    const ended =
      section.kind === 'live' && a.done ? { ...job.step.ended, [name]: now } : job.step.ended
    const known = job.step.in_flight ?? []
    const inFlight =
      section.kind === 'live' && a.in_flight === true && !known.includes(name)
        ? [...known, name]
        : job.step.in_flight
    const leftOut = a.left_out
      ? { ...job.step.left_out, [name]: (job.step.left_out?.[name] ?? 0) + a.left_out }
      : job.step.left_out
    const items =
      a.items === undefined
        ? job.step.items
        : {
            complete: (job.step.items?.complete ?? 0) + a.items.complete,
            partial: (job.step.items?.partial ?? 0) + a.items.partial,
          }
    // what every step after this one keeps
    const kept = {
      seq,
      bytes,
      counts,
      ...(ended === undefined ? {} : { ended }),
      ...(inFlight === undefined ? {} : { in_flight: inFlight }),
      ...(unsettled.length === 0 ? {} : { unsettled }),
      ...(leftOut === undefined ? {} : { left_out: leftOut }),
      ...(job.step.left_out_items === undefined ? {} : { left_out_items: job.step.left_out_items }),
      ...(job.step.left_out_more === undefined ? {} : { left_out_more: job.step.left_out_more }),
      ...(items === undefined ? {} : { items }),
    }
    const next: ExportStep = a.done
      ? { n: a.n + 1, section: job.step.section + 1, cursor: null, part: 1, ...kept }
      : {
          n: a.n + 1,
          section: job.step.section,
          cursor: a.at.cursor,
          ...(a.at.parents === undefined ? {} : { parents: a.at.parents }),
          part,
          ...kept,
        }
    const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { export_id: job.id })
    await ctx.db.patch(job._id, {
      step: next,
      progress: progressOf(next.section, job.progress.records + a.records),
      progress_at: now,
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
      job.step.section < JOB_ORDER.length
    )
      return false
    for (const file of [a.readme, a.manifest])
      if ((await ctx.db.system.get(file.storage_id)) === null) return false
    const stop = await stopReason(ctx, job)
    if (stop !== null) {
      await endJob(ctx, job, { state: 'failed', code: stop })
      return false
    }
    const parts = await partsOf(ctx, job.id).take(EXPORT_LIMITS.parts + 1)
    if (parts.length > EXPORT_LIMITS.parts) {
      await endJob(ctx, job, { state: 'failed', code: 'too_large' })
      return false
    }
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
      // a job that was collecting at the deploy of format 4 read the
      // Deleted items section too, so its archive is format 4
      format_version: ORG_EXPORT_FORMAT,
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
    // The job's scheduled function is this expiry, running now. Convex
    // defines no cancel of the function that runs it, so endJob gets none.
    await endJob(ctx, { ...job, scheduled_id: undefined }, { state: 'expired' })
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

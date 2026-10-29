/* The organization export as a server job (orgExport.ts request, status,
 * cancel and the step chain; model/orgExports.ts; model/orgExportRead.ts).
 *
 * A job reads the organization in bounded queries, stores its archive as
 * compressed parts and keeps a ready archive four hours. These tests run
 * jobs to the end on fake timers, unzip the parts and compare them with
 * what the browser export's `page` returns for the same data, then check
 * joining, retries, recovery, expiry, refusals, the size cap, Convex's real
 * limits and every teardown that must remove the job's rows and files. */
/// <reference types="vite/client" />

import { makeFunctionReference } from 'convex/server'
import { inflateSync, unzipSync } from 'fflate/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import { crc32 } from '../lib/crc32'
import type { DeletedItemState } from '../lib/enums'
import {
  archiveRow,
  exportName,
  LIVE_READ_WARNING,
  ORG_EXPORT_ORDER,
  ORG_EXPORT_SECTIONS,
  type OrgExportPage,
  type OrgExportRow,
  type OrgExportSection,
  ZIP_END_BYTES,
  zipEntryBytes,
} from '../lib/orgExport'
import { checkStoredFiles } from '../model/demoUploads'
import { deleteOrgStep, wipeWorkStep } from '../model/orgDeletion'
import { readBatch } from '../model/orgExportRead'
import {
  ARCHIVE_TTL_MS,
  EXPORT_LIMITS,
  HISTORY_MS,
  RESTARTS,
  STALLED_MS,
} from '../model/orgExports'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  reap,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { assertNoDanglingRefs } from './refs.setup'

const START = Date.parse('2026-05-04T10:00:00.000Z')
const DEFAULTS = { ...EXPORT_LIMITS }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})
afterEach(() => {
  Object.assign(EXPORT_LIMITS, DEFAULTS)
  vi.clearAllTimers()
  vi.useRealTimers()
})

const page = makeFunctionReference<
  'query',
  { org_id: string; section: OrgExportSection; parent_id?: string; cursor: string | null },
  OrgExportPage
>('orgExport:page')

/** Runs every scheduled step, erase leg and expiry that is due now, until
 * none is left that is due. Later timers, such as an archive's expiry,
 * wait. */
const settle = (t: T) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0), 5000)

const jobOf = (t: T, id: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query('org_exports')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

const partsOf = (t: T, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('org_export_parts')
      .withIndex('by_export_seq', (q) => q.eq('export_id', id))
      .collect(),
  )

const requestsOf = (t: T, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('org_export_requests')
      .withIndex('by_export_profile', (q) => q.eq('export_id', id))
      .collect(),
  )

/** How many files storage holds. */
const storedFiles = (t: T) =>
  t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length)

/** Whether stored file `id` is still there. */
const exists = (t: T, id: Id<'_storage'>) =>
  t.run(async (ctx) => (await ctx.db.system.get(id)) !== null)

/** Asks for an export as `profile` and runs the job until nothing due is
 * left. */
async function exportAs(t: T, profile: Doc<'profiles'>, orgId: string) {
  const asked = await as(t, profile).mutation(api.orgExport.request, { org_id: orgId })
  await settle(t)
  return asked.export_id
}

/* A ZIP archive of `parts` in archive order, each with its stored file,
 * built as the delivery stage will: a local header and the file for each,
 * then the central directory and its end record. */
function zipOf(parts: readonly Doc<'org_export_parts'>[], files: readonly Uint8Array[]) {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const directory: Uint8Array[] = []
  let offset = 0
  for (const [i, part] of parts.entries()) {
    const name = encoder.encode(part.entry)
    const data = files[i]
    const local = new DataView(new ArrayBuffer(30))
    const central = new DataView(new ArrayBuffer(46))
    local.setUint32(0, 0x04034b50, true)
    central.setUint32(0, 0x02014b50, true)
    central.setUint16(4, 20, true)
    // version needed, UTF-8 names, deflate, 1980-01-01, CRC and sizes, at
    // the same offsets past each record's own first field
    for (const [view, at] of [
      [local, 4],
      [central, 6],
    ] as const) {
      view.setUint16(at, 20, true)
      view.setUint16(at + 2, 0x0800, true)
      view.setUint16(at + 4, 8, true)
      view.setUint16(at + 8, 0x21, true)
      view.setUint32(at + 10, part.crc32, true)
      view.setUint32(at + 14, data.length, true)
      view.setUint32(at + 18, part.raw_bytes, true)
      view.setUint16(at + 22, name.length, true)
    }
    central.setUint32(42, offset, true)
    chunks.push(new Uint8Array(local.buffer), name, data)
    directory.push(new Uint8Array(central.buffer), name)
    offset += 30 + name.length + data.length
  }
  const size = directory.reduce((sum, chunk) => sum + chunk.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, parts.length, true)
  end.setUint16(10, parts.length, true)
  end.setUint32(12, size, true)
  end.setUint32(16, offset, true)
  const all = [...chunks, ...directory, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of all) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** A ready job's archive: its parts, each inflated and checked against its
 * CRC and sizes, the ZIP they make and its entries, and each table's rows
 * joined from its files. */
async function archiveOf(t: T, exportId: string) {
  const parts = await partsOf(t, exportId)
  // t.run answers Convex values, so the bytes come back as ArrayBuffers
  const buffers = await t.run(async (ctx) => {
    const out: ArrayBuffer[] = []
    for (const part of parts) {
      const blob = await ctx.storage.get(part.storage_id)
      if (blob === null) throw new Error(`the file of ${part.entry} is gone`)
      out.push(await blob.arrayBuffer())
    }
    return out
  })
  const files = buffers.map((buffer) => new Uint8Array(buffer))
  const decoder = new TextDecoder()
  const texts: Record<string, string> = {}
  for (const [i, part] of parts.entries()) {
    expect(files[i].length, part.entry).toBe(part.stored_bytes)
    // each part is one complete raw DEFLATE stream of its own
    const raw = inflateSync(files[i])
    expect(raw.length, part.entry).toBe(part.raw_bytes)
    expect(crc32(raw), part.entry).toBe(part.crc32)
    texts[part.entry] = decoder.decode(raw)
  }
  const zip = zipOf(parts, files)
  const entries = unzipSync(zip)
  expect(Object.keys(entries)).toEqual(parts.map((part) => part.entry))
  for (const part of parts) expect(decoder.decode(entries[part.entry])).toBe(texts[part.entry])
  const tables: Record<string, OrgExportRow[]> = {}
  for (const part of parts) {
    if (part.kind !== 'data') continue
    const rows = JSON.parse(texts[part.entry]) as OrgExportRow[]
    expect(rows, part.entry).toHaveLength(part.records)
    const name = part.entry.split('/')[1]
    tables[name] = [...(tables[name] ?? []), ...rows]
  }
  return {
    parts,
    zip,
    tables,
    readme: texts['README.txt'],
    manifest: JSON.parse(texts['manifest.json']) as {
      version: number
      consistency: string
      consistency_note: string
      file_contents_included: boolean
      collection_started_at: string
      collection_completed_at: string
      organization: { id: string; name?: string; slug?: string }
      tables: Record<string, { files: string[]; records: number }>
      skipped: { tasks: number }
      exclusions: string[]
    },
  }
}

/** Every section as the browser export reads it through `page`, by archive
 * name, each row as the archive writes it (lib/orgExport.ts archiveRow). */
async function pagedRows(t: T, profile: Doc<'profiles'>, orgId: string) {
  const caller = as(t, profile)
  const readAll = async (section: OrgExportSection, parentId?: string) => {
    const rows: OrgExportRow[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 2000; guard++) {
      const result: OrgExportPage = await caller.query(page, {
        org_id: orgId,
        section,
        ...(parentId === undefined ? {} : { parent_id: parentId }),
        cursor,
      })
      rows.push(...result.rows)
      if (result.isDone) return rows
      cursor = result.continueCursor
    }
    throw new Error('export pagination did not finish')
  }
  const bySection = {} as Record<OrgExportSection, OrgExportRow[]>
  for (const section of ORG_EXPORT_ORDER) {
    const parent = ORG_EXPORT_SECTIONS[section]
    bySection[section] =
      parent === null
        ? await readAll(section)
        : (
            await Promise.all(bySection[parent].map((row) => readAll(section, row.id as string)))
          ).flat()
  }
  return Object.fromEntries(
    ORG_EXPORT_ORDER.map((section) => [
      exportName(section),
      // as JSON carries them
      JSON.parse(JSON.stringify(bySection[section].map(archiveRow))) as OrgExportRow[],
    ]),
  )
}

/** Work in every exported section: an archived task with a label, a link,
 * a comment and an attachment whose stored file is gone, a milestone, a
 * team share, activity, an agent key and a profile picture whose file is
 * gone too. */
async function plantWork(t: T, f: OrgFixture) {
  const task = await plantIssue(t, {
    org_id: f.org.id,
    project_id: f.sub.id,
    archived_at: NOW,
    description: '<p>Archived description</p>',
  })
  const target = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
  const planted = await t.run(async (ctx) => {
    // no step reads a file's bytes: these two are gone already
    const missing = await ctx.storage.store(new Blob(['gone']))
    await ctx.storage.delete(missing)
    await ctx.db.patch(f.admin._id, { avatar_storage_id: missing })
    const labelId = uuid()
    await ctx.db.insert('labels', {
      id: labelId,
      org_id: f.org.id,
      name: 'Export me',
      name_lower: 'export me',
      color: '#fff',
      created_at: NOW,
    })
    await ctx.db.insert('issue_labels', { org_id: f.org.id, issue_id: task.id, label_id: labelId })
    const attachmentId = uuid()
    await ctx.db.insert('issue_attachments', {
      org_id: f.org.id,
      id: attachmentId,
      issue_id: task.id,
      name: 'evidence.txt',
      size_bytes: 13,
      mime: 'text/plain',
      storage_id: missing,
      inline: true,
      uploaded_by: f.admin.id,
      created_at: NOW,
    })
    await ctx.db.insert('comments', {
      id: uuid(),
      issue_id: task.id,
      author: f.admin.id,
      body: `<p>See <img src="att:${attachmentId}"></p>`,
      created_at: NOW,
    })
    await ctx.db.insert('issue_links', {
      org_id: f.org.id,
      id: uuid(),
      source_id: task.id,
      target_id: target.id,
      type: 'blocks',
      pair_key: [task.id, target.id].sort().join(':'),
      created_at: NOW,
    })
    await ctx.db.insert('milestones', {
      id: uuid(),
      project_id: f.sub.id,
      name: 'Past milestone',
      week: '2026-01-05',
      created_at: NOW,
    })
    await ctx.db.insert('project_team_access', {
      project_id: f.meta.id,
      team_id: f.team.id,
      level: 'user',
    })
    await ctx.db.insert('activity_events', {
      id: uuid(),
      org_id: f.org.id,
      ts: NOW,
      verb: 'created',
      target_type: 'issue',
      target_id: task.id,
      label: task.title,
      project_id: f.sub.id,
    })
    return { missing, attachmentId }
  })
  await as(t, f.admin).mutation(api.tokens.createAgentKey, {
    org_id: f.org.id,
    id: uuid(),
    agent_id: f.agent.id,
    name: 'Automation',
    key_prefix: 'qva_abc...cdef0',
    key_hash: 'a'.repeat(64),
  })
  return { task, ...planted }
}

/* A Deleted items row for a project item of `project` in `state`, planted
 * without its stored rows. */
const plantProjectItem = (t: T, project: Doc<'projects'>, state: DeletedItemState) =>
  t.run((ctx) =>
    ctx.db.insert('deleted_items', {
      id: uuid(),
      org_id: project.org_id,
      kind: 'project',
      target_id: project.id,
      num: project.num,
      name: project.name,
      key: project.key,
      archived: false,
      project_id: project.id,
      parent_project_id: project.parent_id,
      path: [],
      projects: [
        {
          id: project.id,
          name: project.name,
          key: project.key,
          type: project.type,
          tasks: 0,
          archived_tasks: 0,
        },
      ],
      counts: { tasks: 0, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
      deleted_at: NOW,
      state,
      purge_after: Date.parse(NOW) + 30 * 86_400_000,
    }),
  )

/** An export job of organization `orgId` planted as a ready archive with
 * `parts` stored parts, asked for by `profileId`, for the teardowns. */
const plantExport = (t: T, orgId: string, profileId: string, parts = 3) =>
  t.run(async (ctx) => {
    const id = uuid()
    await ctx.db.insert('org_exports', {
      id,
      org_id: orgId,
      state: 'ready',
      requested_by: profileId,
      started_at: NOW,
      progress_at: NOW,
      completed_at: NOW,
      expires_at: new Date(Date.now() + ARCHIVE_TTL_MS).toISOString(),
      progress: { section: '', records: 0, sections_done: 16, sections_total: 16 },
      step: { n: 1, section: 16, cursor: null, part: 1, seq: 2, bytes: 0, counts: {} },
      attempts: 0,
      format_version: 3,
    })
    const files: Id<'_storage'>[] = []
    for (let seq = 0; seq < parts; seq++) {
      const storage_id = await ctx.storage.store(new Blob([`part ${seq}`]))
      files.push(storage_id)
      await ctx.db.insert('org_export_parts', {
        export_id: id,
        org_id: orgId,
        seq,
        entry: `data/tasks/${String(seq + 1).padStart(4, '0')}.json`,
        kind: 'data',
        storage_id,
        raw_bytes: 6,
        stored_bytes: 6,
        crc32: 0,
        records: 0,
      })
    }
    await ctx.db.insert('org_export_requests', {
      export_id: id,
      org_id: orgId,
      profile_id: profileId,
      requested_at: NOW,
    })
    return { id, files }
  })

/** Whether any job, part or request row of organization `orgId` is left. */
const exportRowsLeft = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const tables = ['org_exports', 'org_export_parts', 'org_export_requests'] as const
    let left = 0
    for (const table of tables)
      left += (await ctx.db.query(table).collect()).filter((row) => row.org_id === orgId).length
    return left
  })

describe('organization export job', () => {
  it('prepares an archive whose parts hold exactly the rows page returns, without reading file bytes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const planted = await plantWork(t, f)
    const exportId = await exportAs(t, f.admin, f.org.id)
    const job = await jobOf(t, exportId)
    expect(job).toMatchObject({ state: 'ready', format_version: 3, attempts: 0, skipped: 0 })
    if (job === null || job.archive === undefined) throw new Error('the job is not ready')
    expect(job.expires_at).toBe(
      new Date(Date.parse(job.completed_at ?? '') + ARCHIVE_TTL_MS).toISOString(),
    )
    expect(job.progress).toMatchObject({ section: '', sections_done: 16, sections_total: 16 })

    const archive = await archiveOf(t, exportId)
    // the README and the manifest first, then each table's files in order
    expect(archive.parts.map((part) => part.seq)).toEqual(archive.parts.map((_, i) => i))
    expect(archive.parts.slice(0, 2).map((part) => part.entry)).toEqual([
      'README.txt',
      'manifest.json',
    ])
    // the archive's size counts every stored part and its ZIP headers
    expect(archive.zip.length).toBe(job.archive.bytes)
    expect(job.archive.parts).toBe(archive.parts.length)

    // exactly the rows the browser export reads, with the archive's names
    const expected = await pagedRows(t, f.admin, f.org.id)
    expect(Object.keys(archive.tables)).toEqual(Object.keys(expected))
    for (const [name, rows] of Object.entries(expected))
      expect(archive.tables[name], name).toEqual(rows)
    expect(archive.tables.tasks.find((row) => row.id === planted.task.id)).toMatchObject({
      archived_at: NOW,
      description: '<p>Archived description</p>',
    })
    expect(archive.tables.task_attachments).toEqual([
      expect.objectContaining({ id: planted.attachmentId, task_id: planted.task.id }),
    ])
    expect(archive.tables.comments[0].task_id).toBe(planted.task.id)
    expect(archive.tables.organizations[0]).toHaveProperty('next_task_num')

    // the manifest counts what the files hold and claims no file inside
    for (const [name, rows] of Object.entries(archive.tables))
      expect(archive.manifest.tables[name].records, name).toBe(rows.length)
    expect(archive.manifest).toMatchObject({
      version: 3,
      consistency: 'live_read',
      consistency_note: LIVE_READ_WARNING,
      file_contents_included: false,
      collection_started_at: job.started_at,
      organization: { id: f.org.id, name: f.org.name, slug: f.org.slug },
      skipped: { tasks: 0 },
    })
    expect(archive.manifest).not.toHaveProperty('files')
    expect(archive.manifest.exclusions.join(' ')).toMatch(/Attachment file contents/)
    expect(archive.readme).toContain(LIVE_READ_WARNING)
    expect(archive.readme).toMatch(/no import or restore/)
    expect(archive.readme).toMatch(/Deleted items are not included yet/)
    expect(archive.readme).toMatch(/no attachment contents/)
    // no uploaded file is in the archive
    expect(archive.parts.filter((part) => !part.entry.startsWith('data/'))).toHaveLength(2)

    // the status names the requester and never sends read state or files
    const status = await as(t, f.admin).query(api.orgExport.status, { org_id: f.org.id })
    expect(status.latest).toMatchObject({
      id: exportId,
      state: 'ready',
      requested_by: f.admin.name,
      requested: true,
      archive_bytes: job.archive.bytes,
    })
    expect(status.ready).toBeNull()
    expect(JSON.stringify(status)).not.toMatch(/step|storage/)
  })

  it('makes one job for repeated and simultaneous requests, joins a second admin and starts afresh after a ready archive, which the fresh one ends', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => ctx.db.patch(f.user._id, { org_role: 'admin' }))
    const admin = as(t, f.admin)
    const second = as(t, f.user)
    const args = { org_id: f.org.id }
    const [a, b] = await Promise.all([
      admin.mutation(api.orgExport.request, args),
      admin.mutation(api.orgExport.request, args),
    ])
    expect(b.export_id).toBe(a.export_id)
    expect([a.joined, b.joined].sort()).toEqual([false, true])
    expect(await requestsOf(t, a.export_id)).toHaveLength(1)
    // another admin joins the same job
    expect(await second.mutation(api.orgExport.request, args)).toEqual({
      export_id: a.export_id,
      joined: true,
    })
    expect((await requestsOf(t, a.export_id)).map((row) => row.profile_id).sort()).toEqual(
      [f.admin.id, f.user.id].sort(),
    )
    const joined = await second.query(api.orgExport.status, args)
    expect(joined.latest).toMatchObject({ state: 'collecting', requested: true })
    expect(joined.latest?.requested_by).toBe(f.admin.name)
    await settle(t)
    expect(await jobOf(t, a.export_id)).toMatchObject({ state: 'ready' })
    const readyParts = await partsOf(t, a.export_id)

    // a fresh request after the archive is ready starts another job and
    // leaves the ready one downloadable while it collects
    const fresh = await admin.mutation(api.orgExport.request, args)
    expect(fresh).toMatchObject({ joined: false })
    expect(fresh.export_id).not.toBe(a.export_id)
    const status = await second.query(api.orgExport.status, args)
    expect(status.latest).toMatchObject({
      id: fresh.export_id,
      state: 'collecting',
      requested: false,
    })
    expect(status.ready).toMatchObject({ id: a.export_id, state: 'ready', requested: true })
    for (let i = 0; i < 3; i++)
      await t.action(internal.orgExport.step, { export_id: fresh.export_id })
    expect(await jobOf(t, a.export_id)).toMatchObject({ state: 'ready' })
    expect(await partsOf(t, a.export_id)).toEqual(readyParts)
    // once the fresh one is ready it ends the earlier one, so the
    // organization holds one ready archive
    await settle(t)
    expect(await jobOf(t, fresh.export_id)).toMatchObject({ state: 'ready' })
    expect(await jobOf(t, a.export_id)).toMatchObject({
      state: 'expired',
      ended_at: expect.any(String),
    })
    expect(await partsOf(t, a.export_id)).toEqual([])
    for (const part of readyParts) expect(await exists(t, part.storage_id)).toBe(false)
    const after = await second.query(api.orgExport.status, args)
    expect(after.latest).toMatchObject({ id: fresh.export_id, state: 'ready' })
    expect(after.ready).toBeNull()
  })

  it('adds one part when two runs commit the same step, and the loser deletes its file', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { export_id } = await as(t, f.admin).mutation(api.orgExport.request, { org_id: f.org.id })
    const before = await storedFiles(t)
    // A restarted step and the one it replaced, both started from step 0.
    // Whether the second reads the job before or after the first commits,
    // no part is added twice and no file is left without its row.
    await Promise.all([
      t.action(internal.orgExport.step, { export_id }),
      t.action(internal.orgExport.step, { export_id }),
    ])
    const parts = await partsOf(t, export_id)
    expect(new Set(parts.map((part) => part.entry)).size).toBe(parts.length)
    expect(parts[0].entry).toBe('data/organizations/0001.json')
    expect(await storedFiles(t)).toBe(before + parts.length)
    expect((await jobOf(t, export_id))?.step.n).toBe(parts.length)

    // the same commit twice: the second is refused and adds nothing
    const job = await jobOf(t, export_id)
    if (job === null) throw new Error('the job is gone')
    const commit = async () =>
      t.mutation(internal.orgExport.commitPart, {
        export_id,
        n: job.step.n,
        at: { section: job.step.section, cursor: null },
        done: true,
        records: 0,
        skipped: 0,
        part: {
          storage_id: await t.run((ctx) => ctx.storage.store(new Blob(['[]\n']))),
          raw_bytes: 3,
          stored_bytes: 3,
          crc32: 0,
        },
      })
    expect(await commit()).toBe(true)
    expect(await commit()).toBe(false)
    expect(await partsOf(t, export_id)).toHaveLength(parts.length + 1)
  })

  it('restarts a stalled job, and fails it as stalled once its restarts run out', async () => {
    const t = newT()
    const f = await withOrg(t)
    const admin = as(t, f.admin)
    /** Loses the job's waiting step, as a failed mutation's schedule is lost. */
    const lose = (id: string) =>
      t.run(async (ctx) => {
        const job = await ctx.db
          .query('org_exports')
          .withIndex('by_uuid', (q) => q.eq('id', id))
          .unique()
        if (job?.scheduled_id) await ctx.scheduler.cancel(job.scheduled_id)
      })
    const recover = () => t.mutation(internal.orgExport.recover, {})

    const first = await admin.mutation(api.orgExport.request, { org_id: f.org.id })
    await lose(first.export_id)
    // not yet stalled
    await recover()
    expect(await jobOf(t, first.export_id)).toMatchObject({ attempts: 0 })
    vi.advanceTimersByTime(STALLED_MS + 1)
    await recover()
    expect(await jobOf(t, first.export_id)).toMatchObject({ state: 'collecting', attempts: 1 })
    // a step that commits resets the restarts
    await settle(t)
    expect(await jobOf(t, first.export_id)).toMatchObject({ state: 'ready', attempts: 0 })

    const second = await admin.mutation(api.orgExport.request, { org_id: f.org.id })
    for (let attempt = 1; attempt <= RESTARTS; attempt++) {
      await lose(second.export_id)
      vi.advanceTimersByTime(STALLED_MS + 1)
      await recover()
      expect(await jobOf(t, second.export_id)).toMatchObject({ attempts: attempt })
    }
    await lose(second.export_id)
    vi.advanceTimersByTime(STALLED_MS + 1)
    await recover()
    expect(await jobOf(t, second.export_id)).toMatchObject({
      state: 'failed',
      error: { code: 'stalled' },
    })
    // a failed job blocks no new request
    expect(await admin.mutation(api.orgExport.request, { org_id: f.org.id })).toMatchObject({
      joined: false,
    })
  })

  it('lets any admin cancel a collecting job, refuses its next commit and erases its parts', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => ctx.db.patch(f.user._id, { org_role: 'admin' }))
    const { export_id } = await as(t, f.admin).mutation(api.orgExport.request, { org_id: f.org.id })
    // three steps commit their parts
    for (let i = 0; i < 3; i++) await t.action(internal.orgExport.step, { export_id })
    expect(await partsOf(t, export_id)).toHaveLength(3)
    const before = await jobOf(t, export_id)
    // an admin who did not ask cancels it
    expect(
      await as(t, f.user).mutation(api.orgExport.cancel, { org_id: f.org.id, export_id }),
    ).toEqual({ state: 'cancelled' })
    // the commit of a step that was running then is refused
    const late = await t.run((ctx) => ctx.storage.store(new Blob(['late part'])))
    expect(
      await t.mutation(internal.orgExport.commitPart, {
        export_id,
        n: before?.step.n ?? -1,
        at: { section: before?.step.section ?? -1, cursor: null },
        done: true,
        records: 1,
        skipped: 0,
        part: { storage_id: late, raw_bytes: 9, stored_bytes: 9, crc32: 0 },
      }),
    ).toBe(false)
    const files = (await partsOf(t, export_id)).map((part) => part.storage_id)
    await settle(t)
    expect(await jobOf(t, export_id)).toMatchObject({
      state: 'cancelled',
      cancelled_by: f.user.id,
      ended_at: expect.any(String),
    })
    expect(await partsOf(t, export_id)).toEqual([])
    for (const file of files) expect(await exists(t, file)).toBe(false)
    expect((await jobOf(t, export_id))?.erasing_at).toBeUndefined()
    // cancelling an ended job changes nothing
    expect(
      await as(t, f.admin).mutation(api.orgExport.cancel, { org_id: f.org.id, export_id }),
    ).toEqual({ state: 'cancelled' })
    expect(
      (await as(t, f.admin).query(api.orgExport.status, { org_id: f.org.id })).latest,
    ).toMatchObject({ state: 'cancelled', cancelled_by: f.user.name })
  })

  it('keeps a ready archive from the orphan sweeps, expires it after four hours and deletes its history after 30 days', async () => {
    const t = newT()
    const f = await withOrg(t)
    const exportId = await exportAs(t, f.admin, f.org.id)
    const files = (await partsOf(t, exportId)).map((part) => part.storage_id)
    // older than the orphan sweep's hour, and the demo check's 120 seconds
    vi.advanceTimersByTime(2 * 60 * 60 * 1000)
    await reap(t)
    await t.run(async (ctx) => {
      await checkStoredFiles(ctx, null)
    })
    for (const file of files) expect(await exists(t, file)).toBe(true)
    expect(await jobOf(t, exportId)).toMatchObject({ state: 'ready' })

    // four hours after it was ready, at once and without an open app
    vi.advanceTimersByTime(2 * 60 * 60 * 1000)
    await settle(t)
    expect(await jobOf(t, exportId)).toMatchObject({ state: 'expired' })
    expect(await partsOf(t, exportId)).toEqual([])
    for (const file of files) expect(await exists(t, file)).toBe(false)
    expect(
      (await as(t, f.admin).query(api.orgExport.status, { org_id: f.org.id })).latest,
    ).toMatchObject({ state: 'expired' })

    // the history stays 30 days with its request rows, then goes
    vi.advanceTimersByTime(HISTORY_MS - 60_000)
    await t.mutation(internal.orgExport.sweep, {})
    expect(await jobOf(t, exportId)).not.toBeNull()
    vi.advanceTimersByTime(2 * 60_000)
    await t.mutation(internal.orgExport.sweep, {})
    expect(await jobOf(t, exportId)).toBeNull()
    expect(await requestsOf(t, exportId)).toEqual([])
  })

  it('expires a ready archive whose timer was lost and restarts an erase leg that stopped', async () => {
    const t = newT()
    const f = await withOrg(t)
    const exportId = await exportAs(t, f.admin, f.org.id)
    const lose = () =>
      t.run(async (ctx) => {
        const job = await ctx.db
          .query('org_exports')
          .withIndex('by_uuid', (q) => q.eq('id', exportId))
          .unique()
        if (job?.scheduled_id) await ctx.scheduler.cancel(job.scheduled_id)
      })
    await lose()
    vi.advanceTimersByTime(ARCHIVE_TTL_MS)
    await t.mutation(internal.orgExport.sweep, {})
    expect(await jobOf(t, exportId)).toMatchObject({
      state: 'expired',
      erasing_at: expect.any(String),
    })
    await lose()
    vi.advanceTimersByTime(STALLED_MS + 1)
    await t.mutation(internal.orgExport.sweep, {})
    await settle(t)
    expect(await partsOf(t, exportId)).toEqual([])
    expect((await jobOf(t, exportId))?.erasing_at).toBeUndefined()
  })

  it("counts an in-flight deleted item's tasks as skipped, leaving them and their rows out", async () => {
    const t = newT()
    const f = await withOrg(t)
    const kept = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const moving = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
    })
    const stranded = await plantIssue(t, { org_id: f.org.id, project_id: moving.id })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: stranded.id,
    })
    await t.run(async (ctx) => {
      for (const issue_id of [kept.id, stranded.id])
        await ctx.db.insert('comments', { id: uuid(), issue_id, body: 'Notes', created_at: NOW })
    })
    await plantProjectItem(t, moving, 'moving')
    await t.run((ctx) => ctx.db.delete(moving._id))
    const exportId = await exportAs(t, f.admin, f.org.id)
    expect(await jobOf(t, exportId)).toMatchObject({ state: 'ready', skipped: 1 })
    const archive = await archiveOf(t, exportId)
    expect(archive.tables.tasks.map((row) => row.id)).toEqual([kept.id, child.id])
    expect(archive.tables.tasks[1]).not.toHaveProperty('parent_id')
    expect(archive.tables.comments.map((row) => row.task_id)).toEqual([kept.id])
    expect(archive.manifest.skipped.tasks).toBe(1)
    // an empty table has one file holding []
    expect(archive.tables.milestones).toEqual([])
    expect(archive.manifest.tables.milestones).toEqual({
      files: ['data/milestones/0001.json'],
      records: 0,
    })
    const expected = await pagedRows(t, f.admin, f.org.id)
    for (const [name, rows] of Object.entries(expected))
      expect(archive.tables[name], name).toEqual(rows)
  })

  it('refuses members who are not admins, other organizations and an organization being deleted', async () => {
    const t = newT()
    const f = await withOrg(t)
    const args = { org_id: f.org.id }
    for (const profile of [f.user, f.viewer, f.guest, f.otherAdmin]) {
      await expectRefusal(as(t, profile).mutation(api.orgExport.request, args), 'forbidden')
      await expectRefusal(as(t, profile).query(api.orgExport.status, args), 'forbidden')
    }
    await expectRefusal(t.mutation(api.orgExport.request, args), 'forbidden', /not signed in/)
    const { export_id } = await as(t, f.admin).mutation(api.orgExport.request, args)
    await expectRefusal(
      as(t, f.user).mutation(api.orgExport.cancel, { ...args, export_id }),
      'forbidden',
    )
    // another organization's admin cannot reach the job through their own
    await expectRefusal(
      as(t, f.otherAdmin).mutation(api.orgExport.cancel, { org_id: f.otherOrg.id, export_id }),
      'not_found',
    )
    // read-only before deletion, exports go on
    const removal = await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        created_at: NOW,
      }),
    )
    expect(await as(t, f.admin).mutation(api.orgExport.request, args)).toMatchObject({
      export_id,
      joined: true,
    })
    expect((await as(t, f.admin).query(api.orgExport.status, args)).latest).toMatchObject({
      id: export_id,
    })
    // once deletion has begun, every call is refused and the job stops
    await t.run((ctx) => ctx.db.patch(removal, { phase: 'profiles' }))
    await expectRefusal(as(t, f.admin).mutation(api.orgExport.request, args), 'forbidden')
    await expectRefusal(as(t, f.admin).query(api.orgExport.status, args), 'forbidden')
    await expectRefusal(
      as(t, f.admin).mutation(api.orgExport.cancel, { ...args, export_id }),
      'forbidden',
    )
    await settle(t)
    expect(await jobOf(t, export_id)).toMatchObject({
      state: 'failed',
      error: { code: 'org_deleting' },
    })
    expect(await partsOf(t, export_id)).toEqual([])
  })

  it('stops a job whose only requester is no longer an admin', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { export_id } = await as(t, f.admin).mutation(api.orgExport.request, {
      org_id: f.org.id,
    })
    await t.action(internal.orgExport.step, { export_id })
    expect(await partsOf(t, export_id)).toHaveLength(1)
    await t.run((ctx) => ctx.db.patch(f.admin._id, { org_role: 'user' }))
    await settle(t)
    expect(await jobOf(t, export_id)).toMatchObject({
      state: 'failed',
      error: { code: 'no_admin' },
    })
    expect(await partsOf(t, export_id)).toEqual([])
  })

  it('fails a job that would pass the archive size cap and erases its parts', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantWork(t, f)
    const baseline = await storedFiles(t)
    EXPORT_LIMITS.archive = 3000
    const exportId = await exportAs(t, f.admin, f.org.id)
    expect(await jobOf(t, exportId)).toMatchObject({
      state: 'failed',
      error: { code: 'too_large' },
    })
    expect(await partsOf(t, exportId)).toEqual([])
    expect(await storedFiles(t)).toBe(baseline)
  })

  it('stops at EXPORT_LIMITS.parts data parts as too large, and finishes that many within the limits', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    /** A collecting job of the fixture asked for by its admin, at `step`. */
    const plantJob = (step: Partial<Doc<'org_exports'>['step']>) =>
      t.run(async (ctx) => {
        const id = uuid()
        await ctx.db.insert('org_exports', {
          id,
          org_id: f.org.id,
          state: 'collecting',
          requested_by: f.admin.id,
          started_at: NOW,
          progress_at: NOW,
          progress: { section: '', records: 0, sections_done: 0, sections_total: 16 },
          step: { n: 0, section: 0, cursor: null, part: 1, seq: 2, bytes: 0, counts: {}, ...step },
          attempts: 0,
          format_version: 3,
        })
        await ctx.db.insert('org_export_requests', {
          export_id: id,
          org_id: f.org.id,
          profile_id: f.admin.id,
          requested_at: NOW,
        })
        return id
      })
    const stored = async () => ({
      storage_id: await t.run((ctx) => ctx.storage.store(new Blob(['[]\n']))),
      raw_bytes: 3,
      stored_bytes: 3,
      crc32: 0,
    })
    const last = ORG_EXPORT_ORDER.length - 1
    const commit = async (exportId: string) =>
      t.mutation(internal.orgExport.commitPart, {
        export_id: exportId,
        n: 0,
        at: { section: last, cursor: null },
        done: false,
        records: 0,
        skipped: 0,
        part: await stored(),
      })
    // data part EXPORT_LIMITS.parts is the last that commits
    expect(await commit(await plantJob({ section: last, seq: EXPORT_LIMITS.parts + 1 }))).toBe(true)
    const over = await plantJob({ section: last, seq: EXPORT_LIMITS.parts + 2 })
    expect(await commit(over)).toBe(false)
    expect(await jobOf(t, over)).toMatchObject({ state: 'failed', error: { code: 'too_large' } })

    // the finish of an archive with that many data parts stays within
    // Convex's 4,096 ranges: every table's first file, the rest tasks
    const entries = ORG_EXPORT_ORDER.flatMap((section) =>
      Array.from(
        { length: section === 'issues' ? EXPORT_LIMITS.parts - last : 1 },
        (_, i) => `data/${exportName(section)}/${String(i + 1).padStart(4, '0')}.json`,
      ),
    )
    expect(entries).toHaveLength(EXPORT_LIMITS.parts)
    const full = await plantJob({ n: 7, section: ORG_EXPORT_ORDER.length, seq: entries.length + 2 })
    for (let from = 0; from < entries.length; from += 500)
      await t.run(async (ctx) => {
        for (const [i, entry] of entries.slice(from, from + 500).entries())
          await ctx.db.insert('org_export_parts', {
            export_id: full,
            org_id: f.org.id,
            seq: from + i + 2,
            entry,
            kind: 'data',
            storage_id: await ctx.storage.store(new Blob(['[]\n'])),
            raw_bytes: 3,
            stored_bytes: 3,
            crc32: 0,
            records: 0,
          })
      })
    expect(
      await t.mutation(internal.orgExport.commitFinish, {
        export_id: full,
        n: 7,
        readme: await stored(),
        manifest: await stored(),
      }),
    ).toBe(true)
    expect(await jobOf(t, full)).toMatchObject({
      state: 'ready',
      archive: { parts: EXPORT_LIMITS.parts + 2 },
    })
  }, 300_000)

  it('splits large texts across parts by bytes within every query limit', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // three bytes a character in UTF-8, at the 20,000-character cap
    const text = (seed: number) =>
      Array.from({ length: 20_000 }, (_, i) =>
        String.fromCharCode(0x4e00 + ((seed + i) % 20_000)),
      ).join('')
    const described = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: text(1),
    })
    const busy = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    for (let batch = 0; batch < 10; batch++)
      await t.run(async (ctx) => {
        for (let i = 0; i < 100; i++)
          await ctx.db.insert('comments', {
            id: uuid(),
            issue_id: busy.id,
            body: text(batch * 100 + i),
            created_at: NOW,
          })
      })
    const exportId = await exportAs(t, f.admin, f.org.id)
    expect(await jobOf(t, exportId)).toMatchObject({ state: 'ready' })
    const parts = await partsOf(t, exportId)
    const commentParts = parts.filter((part) => part.entry.startsWith('data/comments/'))
    // about 60 MB of comments, in parts of PART_RAW_BYTES and less than one
    // answer more
    expect(commentParts.length).toBeGreaterThanOrEqual(10)
    for (const part of commentParts) expect(part.raw_bytes).toBeLessThan(6 * 1024 * 1024)
    expect(commentParts.reduce((sum, part) => sum + part.records, 0)).toBe(1000)
    const archive = await archiveOf(t, exportId)
    expect(archive.tables.tasks.find((row) => row.id === described.id)?.description).toBe(text(1))
    expect(archive.tables.comments.map((row) => row.body)).toEqual(
      Array.from({ length: 1000 }, (_, i) => text(i)),
    )
  }, 300_000)

  it('keeps each read of tasks with texts near 1 MiB under the limits, its answer at six texts at most', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // texts from before the cap, 900 KiB each, in description rows whose
    // task rows hold no copy, as once descriptions release 3 clears them
    const description = 'Field notes. '.repeat(80_000).slice(0, 900 * 1024)
    for (let i = 0; i < 9; i++) {
      const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description })
      await t.run((ctx) => ctx.db.patch(task._id, { description: undefined }))
    }
    const issues = ORG_EXPORT_ORDER.indexOf('issues')
    let at: Parameters<typeof readBatch>[2] = { section: issues, cursor: null }
    const reads: number[] = []
    for (let guard = 0; guard < 20; guard++) {
      const read = await t.run(async (ctx) => {
        const batch = await readBatch(ctx, f.org.id, at)
        const m = await ctx.meta.getTransactionMetrics()
        return { batch, bytes: m.bytesRead.used }
      })
      expect(read.bytes).toBeLessThan(16 * 1024 * 1024)
      // what the step receives stays far under a query's 16 MiB answer
      expect(JSON.stringify(read.batch).length).toBeLessThan(8 * 1024 * 1024)
      reads.push(read.batch.rows.length)
      if (read.batch.done) break
      at = read.batch.at
    }
    expect(reads).toEqual([6, 3])
    // and the whole job runs within the limits, a texts part of about 8 MiB
    const exportId = await exportAs(t, f.admin, f.org.id)
    expect(await jobOf(t, exportId)).toMatchObject({ state: 'ready' })
    const tasks = (await partsOf(t, exportId)).filter((part) =>
      part.entry.startsWith('data/tasks/'),
    )
    expect(tasks.reduce((sum, part) => sum + part.records, 0)).toBe(9)
  }, 300_000)

  it('reads the children of many parents in one query, paging a parent whose children do not fit', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const quiet: string[] = []
    for (let i = 0; i < 30; i++)
      quiet.push((await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })).id)
    const busy = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      for (const issue_id of quiet)
        await ctx.db.insert('comments', { id: uuid(), issue_id, body: 'One', created_at: NOW })
      for (let i = 0; i < 250; i++)
        await ctx.db.insert('comments', {
          id: uuid(),
          issue_id: busy.id,
          body: `Comment ${i}`,
          created_at: NOW,
        })
    })
    const comments = ORG_EXPORT_ORDER.indexOf('comments')
    const reads: number[] = []
    let at: Parameters<typeof readBatch>[2] = { section: comments, cursor: null }
    for (let guard = 0; guard < 20; guard++) {
      const batch = await t.run((ctx) => readBatch(ctx, f.org.id, at))
      reads.push(batch.rows.length)
      if (batch.done) break
      at = batch.at
    }
    // the parent page with 30 parents of one comment each in one read, then
    // the busy task in pages of 100
    expect(reads).toEqual([30, 100, 100, 50])
  })
})

describe("an export reads only the organization's own rows", () => {
  /** The read state a step commits between two batches of child section
   * `section`, whose page of parents holds `id` alone. */
  const kept = (section: OrgExportSection, id: string) => ({
    section: ORG_EXPORT_ORDER.indexOf(section),
    cursor: null,
    parents: { ids: [id], at: 0, cursor: null, done: true },
  })

  it("checks a parent an earlier batch kept again, so another organization's rows under a reused id stay out", async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const key = {
      name: 'Relay key',
      key_prefix: 'qva_abc...cdef0',
      key_hash: 'b'.repeat(64),
      created_at: NOW,
    }
    await t.run(async (ctx) => {
      await ctx.db.insert('agent_keys', { ...key, id: uuid(), profile_id: f.agent.id })
      await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: task.id,
        body: 'Own',
        created_at: NOW,
      })
    })
    const read = (section: OrgExportSection, id: string) =>
      t.run((ctx) => readBatch(ctx, f.org.id, kept(section, id)))
    expect((await read('agent_keys', f.agent.id)).rows).toHaveLength(1)
    expect((await read('comments', task.id)).rows).toHaveLength(1)

    // Between two batches the agent and the task go for good, with their
    // rows, and another organization's rows take their ids: a key from
    // before keys named their organization, and a task with a comment.
    await t.run(async (ctx) => {
      for (const table of ['agent_keys', 'comments'] as const)
        for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(row._id)
      await ctx.db.delete(f.agent._id)
      await ctx.db.delete(task._id)
      const { _id, _creationTime, ...agent } = f.agent
      await ctx.db.insert('profiles', { ...agent, org_id: f.otherOrg.id })
      await ctx.db.insert('agent_keys', { ...key, id: uuid(), profile_id: f.agent.id })
    })
    await plantIssue(t, { id: task.id, org_id: f.otherOrg.id, project_id: f.otherProject.id })
    await t.run((ctx) =>
      ctx.db.insert('comments', {
        id: uuid(),
        issue_id: task.id,
        body: 'Foreign',
        created_at: NOW,
      }),
    )
    for (const [section, id] of [
      ['agent_keys', f.agent.id],
      ['comments', task.id],
    ] as const)
      expect(await read(section, id), section).toMatchObject({ rows: [], done: true })
  })

  it('leaves out a child row that names another organization, in the job and in page', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const attachment = (org_id: string, name: string) => ({
      org_id,
      id: uuid(),
      issue_id: task.id,
      name,
      size_bytes: 1,
      inline: false,
      created_at: NOW,
    })
    await t.run(async (ctx) => {
      const file = await ctx.storage.store(new Blob(['x']))
      await ctx.db.insert('issue_attachments', {
        ...attachment(f.org.id, 'own.txt'),
        storage_id: file,
      })
      // damaged: under this organization's task, naming another
      await ctx.db.insert('issue_attachments', {
        ...attachment(f.otherOrg.id, 'foreign.txt'),
        storage_id: file,
      })
    })
    const batch = await t.run((ctx) => readBatch(ctx, f.org.id, kept('issue_attachments', task.id)))
    expect(batch.rows.map((row) => row.name)).toEqual(['own.txt'])
    const paged = await as(t, f.admin).query(page, {
      org_id: f.org.id,
      section: 'issue_attachments',
      parent_id: task.id,
      cursor: null,
    })
    expect(paged.rows.map((row) => row.name)).toEqual(['own.txt'])
  })
})

describe('organization export teardowns', () => {
  it("organization deletion deletes every job, part, file and request row with the organization's work", async () => {
    const t = newT()
    const f = await withOrg(t)
    const exportId = await exportAs(t, f.admin, f.org.id)
    const planted = await plantExport(t, f.org.id, f.user.id)
    const files = [...(await partsOf(t, exportId)).map((part) => part.storage_id), ...planted.files]
    const removal = await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        phase: 'profiles',
        created_at: NOW,
      }),
    )
    for (let i = 0; i < 200; i++) {
      const done = await t.run(async (ctx) => {
        const row = await ctx.db.get(removal)
        return row === null || (await deleteOrgStep(ctx, row))
      })
      if (done) break
    }
    expect(await t.run((ctx) => ctx.db.get(removal))).toBeNull()
    expect(await exportRowsLeft(t, f.org.id)).toBe(0)
    for (const file of files) expect(await exists(t, file)).toBe(false)
    await assertNoDanglingRefs(t, 'after an organization deletion with exports')
  })

  it('deleteOrgDeep deletes the guest organization fixture with its export rows and files', async () => {
    const t = newT()
    const { org_id } = await t.mutation(internal.internal.guestOrg.zzGuestOrg, {})
    const profile = await t.run(async (ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', org_id))
        .first(),
    )
    if (profile === null) throw new Error('the fixture has no profile')
    const planted = await plantExport(t, org_id, profile.id)
    // the fixture tears its organization down first, then builds it anew
    expect((await t.mutation(internal.internal.guestOrg.zzGuestOrg, {})).torn_down).toBe(true)
    expect(await t.run(async (ctx) => (await ctx.db.query('org_exports').collect()).length)).toBe(0)
    expect(await exportRowsLeft(t, org_id)).toBe(0)
    for (const file of planted.files) expect(await exists(t, file)).toBe(false)
  })

  it("the Northstar wipe deletes the organization's export rows and files", async () => {
    const t = newT()
    const f = await withOrg(t)
    const exportId = await exportAs(t, f.admin, f.org.id)
    const files = (await partsOf(t, exportId)).map((part) => part.storage_id)
    const profiles = [f.admin, f.user, f.viewer, f.guest, f.agent].map((profile) => profile.id)
    for (let i = 0; i < 100; i++)
      if (await t.run((ctx) => wipeWorkStep(ctx, f.org.id, profiles))) break
    expect(await exportRowsLeft(t, f.org.id)).toBe(0)
    for (const file of files) expect(await exists(t, file)).toBe(false)
  })

  it("profile removal deletes the profile's request rows, so a job it alone asked for stops", async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => ctx.db.patch(f.user._id, { org_role: 'admin' }))
    const { export_id } = await as(t, f.user).mutation(api.orgExport.request, {
      org_id: f.org.id,
    })
    await t.action(internal.orgExport.step, { export_id })
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: f.user.id })
    expect(await requestsOf(t, export_id)).toEqual([])
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('org_export_requests')
          .withIndex('by_profile', (q) => q.eq('profile_id', f.user.id))
          .collect(),
      ),
    ).toEqual([])
    await settle(t)
    expect(await jobOf(t, export_id)).toMatchObject({
      state: 'failed',
      error: { code: 'no_admin' },
    })
    await assertNoDanglingRefs(t, 'after a requester was removed')
  })

  it('a job whose organization and requesters an earlier release deleted fails at recovery and leaves after 30 days', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { export_id } = await as(t, f.admin).mutation(api.orgExport.request, {
      org_id: f.org.id,
    })
    await t.action(internal.orgExport.step, { export_id })
    const files = (await partsOf(t, export_id)).map((part) => part.storage_id)
    // an earlier release knows no export rows: its teardown leaves them and
    // its scheduled step fails
    await t.run(async (ctx) => {
      const job = await ctx.db
        .query('org_exports')
        .withIndex('by_uuid', (q) => q.eq('id', export_id))
        .unique()
      if (job?.scheduled_id) await ctx.scheduler.cancel(job.scheduled_id)
      for (const table of ['profiles', 'organizations'] as const)
        for (const row of await ctx.db.query(table).collect())
          if (row.id === f.org.id || ('org_id' in row && row.org_id === f.org.id))
            await ctx.db.delete(row._id)
    })
    vi.advanceTimersByTime(STALLED_MS + 1)
    await t.mutation(internal.orgExport.recover, {})
    await settle(t)
    expect(await jobOf(t, export_id)).toMatchObject({
      state: 'failed',
      error: { code: 'no_admin' },
    })
    for (const file of files) expect(await exists(t, file)).toBe(false)
    vi.advanceTimersByTime(HISTORY_MS + 60_000)
    await t.mutation(internal.orgExport.sweep, {})
    expect(await exportRowsLeft(t, f.org.id)).toBe(0)
  })
})

describe('archive helpers', () => {
  it('counts each part and its ZIP headers in the archive size', () => {
    expect(zipEntryBytes('data/tasks/0001.json')).toBe(30 + 46 + 2 * 20)
    expect(ZIP_END_BYTES).toBe(22)
  })
})

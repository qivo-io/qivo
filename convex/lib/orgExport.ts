import { type Infer, type Value, v } from 'convex/values'
import type { StoredTable } from './enums'

/* The live sections of an organization export, which the browser export's
 * `page` and the export job share; the job's archive adds a Deleted items
 * section after them (DELETED_SECTIONS, JOB_ORDER).
 *
 * Order is significant: clients read organization tables first, then traverse
 * the exported parent UUIDs. Personal inboxes, subscriptions, view preferences,
 * MCP credentials, roadmap undo receipts, account appearance, platform data
 * and operational billing/metering ledgers are outside this list. Billing
 * terms and usage retain their separate admin-only projections; raw provider
 * identifiers, checkout URLs and delivery state are not portable work data.
 * A new schema table must be classified in the export coverage test. */
export const ORG_EXPORT_SECTIONS = {
  organizations: null,
  teams: null,
  profiles: null,
  projects: null,
  issues: null,
  labels: null,
  activity_events: null,
  team_members: 'teams',
  project_access: 'projects',
  project_team_access: 'projects',
  milestones: 'projects',
  issue_links: 'issues',
  issue_labels: 'issues',
  issue_attachments: 'issues',
  comments: 'issues',
  agent_keys: 'profiles',
} as const

export type OrgExportSection = keyof typeof ORG_EXPORT_SECTIONS
export type OrgExportRow = Record<string, Value | undefined>
export type OrgExportPage = {
  rows: OrgExportRow[]
  continueCursor: string
  isDone: boolean
}

/** The sections in the order every export reads them. */
export const ORG_EXPORT_ORDER = Object.keys(ORG_EXPORT_SECTIONS) as OrgExportSection[]

// The archive is a public data interface; keep storage names behind this boundary.
export const EXPORT_NAMES: Partial<Record<OrgExportSection, string>> = {
  issues: 'tasks',
  issue_links: 'task_links',
  issue_labels: 'task_labels',
  issue_attachments: 'task_attachments',
}

/** The name section `section` has in an archive. */
export const exportName = (section: OrgExportSection): string => EXPORT_NAMES[section] ?? section

/** `row` with the field names and values an archive uses for tasks. */
export function archiveRow(row: OrgExportRow): OrgExportRow {
  return Object.fromEntries(
    Object.entries(row).map(([field, value]) => {
      if (field === 'issue_id') return ['task_id', value]
      if (field === 'next_issue_num') return ['next_task_num', value]
      if (field === 'target_type' && value === 'issue') return [field, 'task']
      return [field, value]
    }),
  )
}

/** What every archive format leaves out alike; each format adds its own
 * entries about files. */
export const COMMON_EXCLUSIONS = [
  'Private inbox messages (messages)',
  'Personal task subscriptions (task_subscriptions)',
  'Personal preferences and project favorites (user_prefs, project_favorites)',
  'Personal appearance and backgrounds (account_appearance, custom_backgrounds, background_uploads)',
  'Personal MCP tokens (mcp_tokens)',
  'Authentication accounts, sessions, login identifiers, and credentials',
  'Agent key secrets and hashes (agent key metadata is included)',
  'Platform administration, audit logs, demo receipts, and shared panorama library data',
]

/* ------------------------------------------------ the server job's archive
 * Format 4, which the export job writes (orgExport.ts). It is data only and
 * splits each table into numbered files, so no step holds a whole table.
 * The live tables go under data/, and the organization's retained Deleted
 * items under deleted/, apart from the active work. Format 3 had no
 * deleted/ folder. */

/** The archive format the export job writes. */
export const ORG_EXPORT_FORMAT = 4

/** The stored tables of Deleted items (lib/enums.ts STORED_TABLES) the
 * archive holds; issue_subscriptions, personal follows, stays out. */
export type ExportedStoredTable = Exclude<StoredTable, 'issue_subscriptions'>

/** The Deleted items section's tables in the order the job reads them,
 * after the live sections, each with its name under deleted/: one per
 * stored table, named as the live table is in the archive, read table by
 * table from deleted_rows (model/orgExportRead.ts), and the items
 * themselves, from deleted_items, last. */
export const DELETED_SECTIONS = [
  { name: 'tasks', table: 'issues' },
  { name: 'comments', table: 'comments' },
  { name: 'task_labels', table: 'issue_labels' },
  { name: 'task_links', table: 'issue_links' },
  { name: 'task_attachments', table: 'issue_attachments' },
  { name: 'projects', table: 'projects' },
  { name: 'milestones', table: 'milestones' },
  { name: 'project_access', table: 'project_access' },
  { name: 'project_team_access', table: 'project_team_access' },
  { name: 'items', table: 'deleted_items' },
] as const satisfies readonly { name: string; table: ExportedStoredTable | 'deleted_items' }[]

/** One section of the export job, as the job's step indexes them
 * (JOB_ORDER): a live table under data/, a stored table of Deleted items
 * under deleted/, or the Deleted items themselves. `key` names it in the
 * step's counts, the job's progress and the manifest: a live table by its
 * archive name (`tasks`), a Deleted items table by its path
 * (`deleted/tasks`). */
export type JobSection =
  | { kind: 'live'; section: OrgExportSection; folder: 'data'; name: string; key: string }
  | {
      kind: 'stored'
      table: ExportedStoredTable
      live: OrgExportSection
      folder: 'deleted'
      name: string
      key: string
    }
  | { kind: 'items'; folder: 'deleted'; name: string; key: string }

/** Every section of the export job in the order it reads them: the live
 * sections (ORG_EXPORT_ORDER), then DELETED_SECTIONS. */
export const JOB_ORDER: readonly JobSection[] = [
  ...ORG_EXPORT_ORDER.map(
    (section): JobSection => ({
      kind: 'live',
      section,
      folder: 'data',
      name: exportName(section),
      key: exportName(section),
    }),
  ),
  ...DELETED_SECTIONS.map(({ name, table }): JobSection => {
    const key = `deleted/${name}`
    return table === 'deleted_items'
      ? { kind: 'items', folder: 'deleted', name, key }
      : { kind: 'stored', table, live: table, folder: 'deleted', name, key }
  }),
]

/** What a format 4 archive leaves out. */
export const JOB_EXCLUSIONS = [
  ...COMMON_EXCLUSIONS,
  'Attachment file contents (attachment metadata is included in task_attachments)',
  'Images uploaded into descriptions and comments (their att: references are included)',
  'Profile picture images (each profile keeps its picture id, avatar_storage_id)',
  'External images linked in descriptions',
  "Deleted items' bookkeeping and search copies (deleted_item_jobs, deleted_item_parents, deleted_tasks) and their personal task subscriptions",
]

/** The sentence the specification asks every archive and its README to say
 * about live reads. */
export const LIVE_READ_WARNING =
  'Changes made while this export is being prepared may appear at different times in the files. This export is not a snapshot of one point in time.'

/** README.txt of a format 4 archive. */
export const JOB_README = `Qivo organization export, format version 4

This archive is data only. It holds no attachment contents, no images
uploaded into task descriptions or comments and no profile pictures. Their
metadata stays: each attachment's name, size, type, id and task
(task_attachments), the att:<attachment UUID> references in descriptions and
comments, and each profile's picture id (avatar_storage_id). The files
themselves are not in this archive, and it cannot recover them.

${LIVE_READ_WARNING}
manifest.json records when collection started and when it completed.

Qivo has no import or restore for these archives. You can keep and inspect
the records, but Qivo cannot restore an organization from this archive.

Deleted items are in their own folder, deleted/, apart from the active work
in data/. deleted/items holds each task or project the organization deleted
and still keeps, with its original ids, who deleted it and when (via names
the agent key or the kind of personal credential a REST or MCP delete came
through), and purge_at, when Qivo deletes it for good. deleted/tasks,
deleted/comments, deleted/task_labels, deleted/task_links,
deleted/task_attachments, deleted/projects, deleted/milestones,
deleted/project_access and deleted/project_team_access hold their records,
with the fields of the tables of the same names in data/ and
deleted_item_id, the item that held the record when the export read it.
Being in this archive restores nothing and does not change when Qivo deletes
a record for good. Records Qivo already deleted for good are not here.
Personal task subscriptions and Deleted items' own bookkeeping and search
copies stay out. Activity of deleted tasks is in activity_events.

Each item says how much of it the archive holds. export_rows is complete when
the archive holds every record the item kept, and partial when it may lack
some; export_reason then says why: purging (being deleted for good), restored
(restored after part of it was read), moving, restoring or stuck (records
still on their way to or from Deleted items, or stopped partway), changed
during export, deleted during export, or rows left out (records the item
kept that name something the organization no longer has, such as a label or
team deleted after the item, or another organization, which the archive
leaves out and manifest.json counts under deleted_items.left_out). When more
items lost records that way than the export can name, every item it would
call complete is partial with rows left out. deleted_during_export is true for
an item deleted after the export began. Its records can also be in data/, as
the active tables read them before it was deleted; the export leaves out of
deleted/ the records that data/ already holds for certain, those that existed
before the export read their table and were deleted only after it, when no
item was on its way to or from Deleted items while that table was read. A
record whose deleted_item_id deleted/items does not list belongs to an item
restored or deleted for good while the export ran. An item restored while
the export ran can be in neither part. A restore can also move a subtask or
a link to another item while the export runs; each record is under the item
that held it when its table was read, and a link moved while
deleted/task_links was read can appear twice or not at all. manifest.json
counts the items of each kind and any record left out because it named
another organization or nothing it belongs to (deleted_items.left_out).

A task whose project was moving to or back from Deleted items while the
export read tasks is left out of tasks, and manifest.json counts such tasks
under skipped. Its item in deleted/items is then partial, or complete with
the task under deleted/tasks when the item had settled by the time the
export read Deleted items. An item that was being restored can be gone by
then, with its tasks in neither part.

Each table is read live on its own, at its own time. So a related table,
such as comments, task_labels, task_links or task_attachments, can name a
task that tasks does not hold: one created after tasks was read, one left
out as skipped, or one that moved meanwhile. It can also lack rows of a task
that tasks holds, when the task moved or was deleted before the related
table was read.

Folders: data/<table>/ and deleted/<table>/ hold each table's records in
numbered files, 0001.json, 0002.json and so on. Each file is a JSON array of
records with snake_case fields. Read a table's files in number order and join
the arrays. A large table takes several files; an empty table has one file
holding []. Task records are in tasks; their related tables are task_links,
task_labels and task_attachments. manifest.json lists each table's files and
record count, data/ under tables and deleted/ under deleted_items.tables,
what the export leaves out and how many tasks it skipped.

Application id fields are UUIDs. References such as org_id, project_id, task_id,
profile_id, and label_id refer to these application IDs in the corresponding
tables. Activity events keep target_id, related_project_id and team_id after the
task, project or team is deleted, so those values can name rows absent from the
export. Deleting a task for good from Deleted items now also deletes its activity
events. QN task numbers are organization-scoped; a task's num gives QN-<num>.
The organization's next_task_num is its task-number counter. Task activity events
use target_type "task" and target_id references the task's UUID.
Task events carry named_task_nums, the QN numbers of the other tasks their
detail names. Some events from before October 2026 lack it.

Dates ending in _at, and activity ts values, are ISO-8601 UTC timestamps. Week/date
fields are YYYY-MM-DD strings. Optional fields can be absent. Internal Convex
document IDs and creation timestamps are omitted. Join tables may not have an id.
Agent key metadata is included; secrets and hashes are excluded.
`

/** The path of file `n` (from 1) of the archive table named `name` in
 * `folder`, data/ for the live tables and deleted/ for Deleted items. */
export const partEntry = (name: string, n: number, folder: 'data' | 'deleted' = 'data'): string =>
  `${folder}/${name}/${String(n).padStart(4, '0')}.json`

/** What one table holds in an archive: its files in order and its record
 * count. */
export type ArchiveTable = { files: string[]; records: number }

/** Each job section's files and record count by its key (JobSection),
 * from an archive's parts in archive order, or null unless every section
 * of JOB_ORDER has its files 0001.json, 0002.json and on, in order with no
 * gap and nothing else. The README and manifest parts are left out. */
export function archiveTables(
  parts: readonly { entry: string; kind: string; records: number }[],
): Record<string, ArchiveTable> | null {
  const data = parts.filter((part) => part.kind === 'data')
  const tables: Record<string, ArchiveTable> = {}
  let at = 0
  for (const section of JOB_ORDER) {
    const table: ArchiveTable = { files: [], records: 0 }
    while (
      at < data.length &&
      data[at].entry === partEntry(section.name, table.files.length + 1, section.folder)
    ) {
      table.files.push(data[at].entry)
      table.records += data[at].records
      at += 1
    }
    if (table.files.length === 0) return null
    tables[section.key] = table
  }
  return at === data.length ? tables : null
}

/** What the Deleted items section tallied (orgExport.ts commitPart): the
 * items it called complete and partial, and the stored records it left out
 * by table key, those that named another organization or nothing they
 * belong to. */
export type DeletedTally = {
  items: { complete: number; partial: number }
  left_out: Record<string, number>
}

/** manifest.json of a format 4 archive. `tables` lists the live tables
 * under data/, as format 3 did, so a reader that joins `tables` as live
 * data finds no deleted record there, and `deleted_items.tables` the ten
 * tables under deleted/, by path. It names no uploaded file and claims none
 * is inside. */
export function jobManifest(a: {
  organization: { id: string; name?: string; slug?: string }
  started_at: string
  completed_at: string
  tables: Record<string, ArchiveTable>
  skipped_tasks: number
  deleted: DeletedTally
}): string {
  const live: Record<string, ArchiveTable> = {}
  const deleted: Record<string, ArchiveTable> = {}
  for (const section of JOB_ORDER) {
    const table = a.tables[section.key]
    if (table === undefined) continue
    if (section.folder === 'data') live[section.key] = table
    else deleted[section.key] = table
  }
  return `${JSON.stringify(
    {
      format: 'qivo-organization-export',
      version: ORG_EXPORT_FORMAT,
      organization: a.organization,
      collection_started_at: a.started_at,
      collection_completed_at: a.completed_at,
      consistency: 'live_read',
      consistency_note: LIVE_READ_WARNING,
      file_contents_included: false,
      tables: live,
      deleted_items: {
        tables: deleted,
        items: a.deleted.items,
        left_out: a.deleted.left_out,
        note: 'Retained Deleted items and their records, apart from the active work in data/. An item is complete when the archive holds every record it kept, else partial with export_reason. Being in this archive restores nothing, and records Qivo deleted for good are not in it. left_out counts records that named another organization or nothing they belong to.',
      },
      exclusions: JOB_EXCLUSIONS,
      skipped: {
        tasks: a.skipped_tasks,
        reason:
          'Tasks whose project was moving to or back from Deleted items while the export read tasks, left out of tasks. Each table is read live on its own, so related tables can still hold rows of these tasks. Their item in deleted/items says whether deleted/tasks holds them.',
      },
    },
    null,
    2,
  )}\n`
}

/** The bytes a ZIP archive adds for an entry named `entry` besides its
 * data: its local header and its central directory record, each with the
 * name (no extra fields, no data descriptor, because every part's sizes and
 * CRC are known before it is written). */
export const zipEntryBytes = (entry: string): number =>
  30 + 46 + 2 * new TextEncoder().encode(entry).length

/** The bytes of a ZIP archive's end of central directory record. */
export const ZIP_END_BYTES = 22

/* ---------------------------------------------- the ZIP the route serves
 * The /exports/ route (http.ts) sends a ready archive as one ZIP: for each
 * part in seq order its local header and its stored bytes, then the central
 * directory and its end record. Each entry is version 20, UTF-8 names
 * (flag 0x0800), raw DEFLATE (method 8), the part's CRC and sizes, no extra
 * field, no comment and no data descriptor, since every size is known before
 * the first byte. So the archive's length is exactly the sum zipEntryBytes
 * and ZIP_END_BYTES count. An archive of at most EXPORT_LIMITS.parts + 2
 * entries under MAX_ARCHIVE_BYTES (model/orgExports.ts) needs no ZIP64
 * field. */

/** What a ZIP record says of one stored part. */
export type ZipPart = { entry: string; crc32: number; raw_bytes: number; stored_bytes: number }

/** A moment as the DOS time and date fields of a ZIP record, in UTC. */
export type DosTime = { time: number; date: number }

/** ISO time `iso` as ZIP's DOS time and date, in UTC, to the even second.
 * The route gives every entry the archive's completed_at. */
export function dosTime(iso: string): DosTime {
  const at = new Date(iso)
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  }
}

/* The fields a local header and a central directory record share, from
 * `at`: version needed, flags, method, time, date, CRC, sizes and the
 * name's length; the extra field's length stays 0. */
function zipFields(view: DataView, at: number, part: ZipPart, dos: DosTime, name: number): void {
  view.setUint16(at, 20, true)
  view.setUint16(at + 2, 0x0800, true)
  view.setUint16(at + 4, 8, true)
  view.setUint16(at + 6, dos.time, true)
  view.setUint16(at + 8, dos.date, true)
  view.setUint32(at + 10, part.crc32 >>> 0, true)
  view.setUint32(at + 14, part.stored_bytes, true)
  view.setUint32(at + 18, part.raw_bytes, true)
  view.setUint16(at + 22, name, true)
}

/** The local header of `part` with its name, which goes just before its
 * stored bytes. */
export function zipLocalHeader(part: ZipPart, dos: DosTime): Uint8Array {
  const name = new TextEncoder().encode(part.entry)
  const out = new Uint8Array(30 + name.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x04034b50, true)
  zipFields(view, 4, part, dos, name.length)
  out.set(name, 30)
  return out
}

/** The central directory record of `part`, whose local header starts
 * `offset` bytes into the archive. */
export function zipCentralRecord(part: ZipPart, offset: number, dos: DosTime): Uint8Array {
  const name = new TextEncoder().encode(part.entry)
  const out = new Uint8Array(46 + name.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x02014b50, true)
  view.setUint16(4, 20, true) // version made by
  zipFields(view, 6, part, dos, name.length)
  view.setUint32(42, offset, true)
  out.set(name, 46)
  return out
}

/** The end of central directory record of an archive of `count` entries
 * whose central directory holds `directoryBytes` from `directoryOffset`. */
export function zipEnd(count: number, directoryBytes: number, directoryOffset: number): Uint8Array {
  const out = new Uint8Array(ZIP_END_BYTES)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, count, true)
  view.setUint16(10, count, true)
  view.setUint32(12, directoryBytes, true)
  view.setUint32(16, directoryOffset, true)
  return out
}

/** The file name a download of an archive of organization `slug` (its id
 * when it has none) completed on `completedAt` gets:
 * qivo-<slug>-<YYYY-MM-DD>.zip, the slug cleaned as the browser export
 * cleans it (src/lib/orgExport.ts safeName). The browser export names its
 * file by the day collection started; the route names it by the day the
 * archive was ready, as the archive holds what was read until then. */
export function archiveFileName(slug: string, completedAt: string): string {
  const leaf = slug.split(/[\\/]/).pop() ?? ''
  const cleaned = Array.from(leaf)
    .map((c) => (c.charCodeAt(0) < 32 || /[<>:"|?*]/.test(c) ? '_' : c))
    .join('')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 120)
  const name =
    cleaned === '' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)
      ? `file${cleaned === '' ? '' : `-${cleaned}`}`
      : cleaned
  return `qivo-${name}-${completedAt.slice(0, 10)}.zip`
}

/* Where an export job's reads stand (schema.ts org_exports.step). A child
 * section pages its parent table by organization and keeps one page of
 * parent ids, the parent it reads and where that parent's children go
 * on. A Deleted items section pages its table by organization with the
 * cursor alone. */
const exportCursorFields = {
  // the section being read, an index into JOB_ORDER; the sections' count
  // once every section is read
  section: v.number(),
  // where the section's rows, or the current parent's children, go on
  cursor: v.union(v.string(), v.null()),
  // a child section's current page of parent ids
  parents: v.optional(
    v.object({
      ids: v.array(v.string()),
      at: v.number(), // the parent being read, an index into ids
      cursor: v.union(v.string(), v.null()), // where the parent table goes on after this page
      done: v.boolean(), // whether this page is the parent table's last
    }),
  ),
}
export const vExportCursor = v.object(exportCursorFields)
export type ExportCursor = Infer<typeof vExportCursor>

/** An export job's collection state (schema.ts org_exports.step). Only the
 * server reads it; no client ever gets it. The fields from `ended` on
 * came with format 4; a job from before has none until it needs them. */
export const vExportStep = v.object({
  n: v.number(), // the step the next commit must carry
  ...exportCursorFields,
  part: v.number(), // the next file number of the section, from 1
  seq: v.number(), // the next data part's place in the archive
  bytes: v.number(), // the archive's bytes so far: stored parts and their ZIP headers
  counts: v.record(v.string(), v.number()), // records written per job section key
  // when each live section's read ended, by key (the commit after its last
  // read), so the Deleted items section knows which deleted records the
  // live read held for certain; a section starts when the one before ended
  ended: v.optional(v.record(v.string(), v.string())),
  // the live sections, by key, any of whose reads found a Deleted item in
  // flight (model/orgExportRead.ts hasItemInFlight), whose rows the live
  // read may have left out; the Deleted items section keeps every stored
  // row of their tables, at most the nine tables it stores
  in_flight: v.optional(v.array(v.string())),
  // the Deleted items seen moving or restoring, or whose records were
  // stored again, while the export read them, at most
  // model/orgExports.ts EXPORT_LIMITS.unsettled; the items section calls
  // them partial
  unsettled: v.optional(v.array(v.string())),
  // stored records left out by job section key, those that named another
  // organization or nothing they belong to
  left_out: v.optional(v.record(v.string(), v.number())),
  // the Deleted items any of whose stored records were left out, at most
  // model/orgExports.ts EXPORT_LIMITS.leftOut; the items section calls them
  // partial (orgExport.ts noteLeftOut)
  left_out_items: v.optional(v.array(v.string())),
  // true once more items had records left out than left_out_items may
  // name, which it then no longer holds; the items section then calls
  // every item it would call complete partial
  left_out_more: v.optional(v.boolean()),
  // the items the items section called complete and partial so far
  items: v.optional(v.object({ complete: v.number(), partial: v.number() })),
})
export type ExportStep = Infer<typeof vExportStep>

/** How far an export job has read, as its status shows it. */
export const vExportProgress = v.object({
  section: v.string(), // the archive name of the table being read, '' once all are
  records: v.number(), // records written so far
  sections_done: v.number(),
  sections_total: v.number(),
})

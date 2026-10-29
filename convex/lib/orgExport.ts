import { type Infer, type Value, v } from 'convex/values'

/* Order is significant: clients read organization tables first, then traverse
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
  'Personal preferences (user_prefs)',
  'Personal appearance and backgrounds (account_appearance, custom_backgrounds, background_uploads)',
  'Personal MCP tokens (mcp_tokens)',
  'Authentication accounts, sessions, login identifiers, and credentials',
  'Agent key secrets and hashes (agent key metadata is included)',
  'Platform administration, audit logs, demo receipts, and shared panorama library data',
]

/* ------------------------------------------------ the server job's archive
 * Format 3, which the export job writes (orgExport.ts). It is data only and
 * splits each table into numbered files, so no step holds a whole table. */

/** The archive format the export job writes. */
export const ORG_EXPORT_FORMAT = 3

/** What a format 3 archive leaves out. */
export const JOB_EXCLUSIONS = [
  ...COMMON_EXCLUSIONS,
  'Attachment file contents (attachment metadata is included in task_attachments)',
  'Images uploaded into descriptions and comments (their att: references are included)',
  'Profile picture images (each profile keeps its picture id, avatar_storage_id)',
  'External images linked in descriptions',
  'Deleted items (restore an item to include its work in a later export)',
]

/** The sentence the specification asks every archive and its README to say
 * about live reads. */
export const LIVE_READ_WARNING =
  'Changes made while this export is being prepared may appear at different times in the files. This export is not a snapshot of one point in time.'

/** README.txt of a format 3 archive. */
export const JOB_README = `Qivo organization export, format version 3

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

Deleted items are not included yet. Tasks and projects in the organization's
Deleted items, with their comments, labels, links and attachment metadata,
are left out; restore an item to include its work in a later export. A task
whose project was moving to or back from Deleted items while the export read
it is left out too, with its comments, labels, links and attachment
metadata, and manifest.json counts such tasks under skipped.

Folders: data/<table>/ holds each table's records in numbered files,
0001.json, 0002.json and so on. Each file is a JSON array of records with
snake_case fields. Read a table's files in number order and join the arrays.
A large table takes several files; an empty table has one file holding [].
Task records are in tasks; their related tables are task_links, task_labels
and task_attachments. manifest.json lists each table's files and record
count, what the export leaves out and how many tasks it skipped.

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

/** The path of file `n` (from 1) of the archive table named `name`. */
export const partEntry = (name: string, n: number): string =>
  `data/${name}/${String(n).padStart(4, '0')}.json`

/** What one table holds in an archive: its files in order and its record
 * count. */
export type ArchiveTable = { files: string[]; records: number }

/** Each archive table's files and record count, from an archive's parts
 * in archive order, or null unless every table has its files 0001.json,
 * 0002.json and on, in section order with no gap and nothing else. The
 * README and manifest parts are left out. */
export function archiveTables(
  parts: readonly { entry: string; kind: string; records: number }[],
): Record<string, ArchiveTable> | null {
  const data = parts.filter((part) => part.kind === 'data')
  const tables: Record<string, ArchiveTable> = {}
  let at = 0
  for (const section of ORG_EXPORT_ORDER) {
    const name = exportName(section)
    const table: ArchiveTable = { files: [], records: 0 }
    while (at < data.length && data[at].entry === partEntry(name, table.files.length + 1)) {
      table.files.push(data[at].entry)
      table.records += data[at].records
      at += 1
    }
    if (table.files.length === 0) return null
    tables[name] = table
  }
  return at === data.length ? tables : null
}

/** manifest.json of a format 3 archive. It names no uploaded file and claims
 * none is inside. */
export function jobManifest(a: {
  organization: { id: string; name?: string; slug?: string }
  started_at: string
  completed_at: string
  tables: Record<string, ArchiveTable>
  skipped_tasks: number
}): string {
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
      tables: a.tables,
      exclusions: JOB_EXCLUSIONS,
      skipped: {
        tasks: a.skipped_tasks,
        reason:
          'Tasks whose project was moving to or back from Deleted items while the export read them, left out with their comments, labels, links and attachment metadata.',
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

/* Where an export job's reads stand (schema.ts org_exports.step). A child
 * section pages its parent table by organization and keeps one page of
 * parent ids, the parent it reads and where that parent's children go
 * on. */
const exportCursorFields = {
  // the section being read, an index into ORG_EXPORT_ORDER; the sections'
  // count once every section is read
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
 * server reads it; no client ever gets it. */
export const vExportStep = v.object({
  n: v.number(), // the step the next commit must carry
  ...exportCursorFields,
  part: v.number(), // the next file number of the section, from 1
  seq: v.number(), // the next data part's place in the archive
  bytes: v.number(), // the archive's bytes so far: stored parts and their ZIP headers
  counts: v.record(v.string(), v.number()), // records written per archive table
})
export type ExportStep = Infer<typeof vExportStep>

/** How far an export job has read, as its status shows it. */
export const vExportProgress = v.object({
  section: v.string(), // the archive name of the table being read, '' once all are
  records: v.number(), // records written so far
  sections_done: v.number(),
  sections_total: v.number(),
})

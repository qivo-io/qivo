/* The organization export's reads, which the paging query orgExport.page
 * and the export job's readBatch (orgExport.ts) share. Every read is
 * bounded and scoped to one organization; an export spanning many reads is
 * a live traversal, not an atomic database backup. Archived rows and the
 * entire retained activity history are included. The live sections leave
 * Deleted items out: their rows left the live tables, and a task still in
 * issues under a project that is moving to or back from Deleted items
 * (model/deletedItems.ts) is skipped, with its comments, labels, links and
 * attachments, and a live task's reference to it as a parent is left out.
 * The job reads the retained Deleted items afterwards in a section of
 * their own (storedBatch and itemsBatch at the end of this file); the
 * browser export's `page` never does. Only a deleted item that
 * is not ready leaves tasks in issues under an absent project, so the
 * issues section reads each task's parent only while the organization has
 * one, on a smaller page still. Each task's text comes from its description
 * rows (model/descriptions.ts), two documents at most a row. The job reads
 * tasks 100 a page with their texts under TEXT_ROOM (descriptionsOf) while
 * nothing is in flight, and six a page, each text through a range of its
 * own (descriptionOf), when a page's texts do not fit, as the browser
 * export's `page` always does.
 *
 * Convex runs one paginated read in a query, so readBatch pages at most
 * once and reads the children of further parents as whole ranges. */

import type { PaginationOptions, PaginationResult } from 'convex/server'
import { getDocumentSize } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId, usedMoreThan } from '../lib/db'
import { DELETED_ITEM_STATES } from '../lib/enums'
import { notFound } from '../lib/functions'
import { MIB } from '../lib/limits'
import {
  type ExportCursor,
  type ExportedStoredTable,
  exportName,
  JOB_ORDER,
  ORG_EXPORT_ORDER,
  ORG_EXPORT_SECTIONS,
  type OrgExportRow,
  type OrgExportSection,
} from '../lib/orgExport'
import { descriptionOf, descriptionsOf } from './descriptions'
import { collectingJob, EXPORT_LIMITS } from './orgExports'
import { countersOf } from './orgs'
import { stampRow } from './syncStamps'

export const PAGE_SIZE = 100
/* Ten rows for a page that reads another document per row, so even ten
 * related documents at Convex's 1 MiB document cap stay inside its 16 MiB
 * read limit with the page itself. */
export const JOINED_PAGE_SIZE = 10
/* A narrow issues page, whose rows each read the task's text, two
 * description rows at most of up to Convex's 1 MiB document limit: 6 rows
 * read 12 MiB beside the page's own rows. The browser export's `page` reads
 * it, and the job when a wide page's texts do not fit (TEXT_ROOM). */
export const ISSUES_PAGE_SIZE = 6
/* An issue_links page read while a project item is in flight. Each row can
 * also read its target task, up to Convex's 1 MiB document limit, and the
 * target's project, at most lib/limits.ts PROJECT_ROW_MAX_BYTES, so 4 rows
 * plus the page's own rows stay under the 16 MiB read limit. */
export const IN_FLIGHT_LINKS_PAGE_SIZE = 4
/* An issues page read while a project item is in flight. Each row can also
 * read the task's project, its parent and the parent's project, and its
 * text, two description rows at most: three documents of up to 1 MiB and
 * two projects of at most lib/limits.ts PROJECT_ROW_MAX_BYTES, so 2 rows
 * plus the page's own rows stay under the 16 MiB read limit. */
export const IN_FLIGHT_ISSUES_PAGE_SIZE = 2
export const PAGE_BYTES = 1024 * 1024

/** The reads a wide tasks page of the job may make in all, its PAGE_SIZE
 * tasks within PAGE_BYTES and their texts through descriptionsOf
 * (model/descriptions.ts), which charges each text two description rows at
 * Convex's 1 MiB document limit before it reads and answers null once the
 * texts left do not fit. The transaction's reads, the page's own included,
 * stay under `bytes`, so the answer holds at most about 7 MiB, the most
 * model/orgExports.ts PART_RAW_BYTES allows for one answer, and the texts
 * of a page fit whenever they hold under about 5 MiB in all. The ranges
 * (one a text, the page and the in-flight check) and documents (the page
 * and two a text) stay far under Convex's 4,096 ranges and 32,000
 * documents. A page whose texts do not fit answers no rows and
 * `retry: 'narrow'`, and the job reads the same cursor again six tasks a
 * page (ISSUES_PAGE_SIZE). A wide page among 300 open tasks of ordinary
 * text in one sub-project, a sub-project's open figure, read 105 ranges,
 * 200 documents and 0.097 MiB (convex/tests/orgExportJob.test.ts, the
 * design size block, 6 November 2026). A mutable object, so tests can
 * lower it. */
export const TEXT_ROOM = { ranges: 1024, documents: 4096, bytes: 7 * MIB }
const JOINED_SECTIONS: ReadonlySet<OrgExportSection> = new Set([
  'team_members',
  'project_access',
  'project_team_access',
  'issue_links',
  'issue_labels',
])

export type PagedSection = Exclude<OrgExportSection, 'organizations'>

/* One section's index range in one scope, to page or to read whole. */
type SectionRange = {
  paginate(opts: PaginationOptions): Promise<PaginationResult<Doc<PagedSection>>>
  [Symbol.asyncIterator](): AsyncIterator<Doc<PagedSection>>
}

/* Spell out the indexed reads so no caller-controlled table, index or filter
 * can widen the scope. Children use only their verified parent's UUID. */
function sectionRange(ctx: QueryCtx, section: PagedSection, scope: string): SectionRange {
  switch (section) {
    case 'teams':
      return ctx.db.query('teams').withIndex('by_org', (q) => q.eq('org_id', scope))
    case 'profiles':
      return ctx.db.query('profiles').withIndex('by_org', (q) => q.eq('org_id', scope))
    case 'projects':
      return ctx.db.query('projects').withIndex('by_org', (q) => q.eq('org_id', scope))
    case 'issues':
      return ctx.db.query('issues').withIndex('by_org', (q) => q.eq('org_id', scope))
    case 'labels':
      return ctx.db.query('labels').withIndex('by_org', (q) => q.eq('org_id', scope))
    case 'activity_events':
      return ctx.db.query('activity_events').withIndex('by_org_ts', (q) => q.eq('org_id', scope))
    case 'team_members':
      return ctx.db.query('team_members').withIndex('by_team', (q) => q.eq('team_id', scope))
    case 'project_access':
      return ctx.db
        .query('project_access')
        .withIndex('by_project', (q) => q.eq('project_id', scope))
    case 'project_team_access':
      return ctx.db
        .query('project_team_access')
        .withIndex('by_project', (q) => q.eq('project_id', scope))
    case 'milestones':
      return ctx.db.query('milestones').withIndex('by_project', (q) => q.eq('project_id', scope))
    case 'issue_links':
      // Each link is visited through its source once, regardless of type.
      return ctx.db.query('issue_links').withIndex('by_source', (q) => q.eq('source_id', scope))
    case 'issue_labels':
      return ctx.db.query('issue_labels').withIndex('by_issue', (q) => q.eq('issue_id', scope))
    case 'issue_attachments':
      return ctx.db.query('issue_attachments').withIndex('by_issue', (q) => q.eq('issue_id', scope))
    case 'comments':
      return ctx.db.query('comments').withIndex('by_issue', (q) => q.eq('issue_id', scope))
    case 'agent_keys':
      return ctx.db.query('agent_keys').withIndex('by_profile', (q) => q.eq('profile_id', scope))
  }
}

/** One page of `section` in `scope`: the organization for a top-level
 * section, else one verified parent's UUID. `pageSize` is pageSizeOf's, so
 * a page whose rows each cost another read stays small, and the page reads
 * at most `bytes` of rows besides the one that passes them. A task can
 * carry a large description, so these pages need headroom beyond the
 * pagination byte budget for the source rows themselves. */
export const readPage = (
  ctx: QueryCtx,
  section: PagedSection,
  scope: string,
  cursor: string | null,
  pageSize: number,
  bytes = PAGE_BYTES,
): Promise<PaginationResult<Doc<PagedSection>>> =>
  sectionRange(ctx, section, scope).paginate({
    numItems: pageSize,
    cursor,
    maximumRowsRead: pageSize,
    maximumBytesRead: bytes,
  })

/** The rows of `section` in `scope` when there are at most `rows` of them
 * and together they hold at most PAGE_BYTES, else null. It reads them one
 * at a time and stops at the first row that does not fit, so it reads at
 * most PAGE_BYTES and one document more, and answers at most PAGE_BYTES. */
async function wholeRange(
  ctx: QueryCtx,
  section: PagedSection,
  scope: string,
  rows: number,
): Promise<Doc<PagedSection>[] | null> {
  const docs: Doc<PagedSection>[] = []
  let bytes = 0
  for await (const doc of sectionRange(ctx, section, scope)) {
    const size = getDocumentSize(doc)
    if (docs.length === rows || bytes + size > PAGE_BYTES) return null
    docs.push(doc)
    bytes += size
  }
  return docs
}

/** The page size of `section`: smaller where each row costs another read.
 * Endpoint validation reads another document per row, and for a link also
 * the target's project while a deleted item is in flight (`inFlight`). An
 * issues page reads each task's text, and while a deleted item is in
 * flight also each task's parent. */
export function pageSizeOf(section: OrgExportSection, inFlight: boolean): number {
  if (section === 'issues') return inFlight ? IN_FLIGHT_ISSUES_PAGE_SIZE : ISSUES_PAGE_SIZE
  if (inFlight && section === 'issue_links') return IN_FLIGHT_LINKS_PAGE_SIZE
  return JOINED_SECTIONS.has(section) ? JOINED_PAGE_SIZE : PAGE_SIZE
}

/* Model writers enforce these second endpoints too. Recheck them at this
 * boundary so a damaged join cannot disclose another organization's IDs.
 * While a deleted item is in flight (`liveProject` given), a link's target
 * must also be a task the export includes, one under a live project, so no
 * exported link names a skipped task. Otherwise every task's project is
 * live and the link reads no project. */
async function hasOwnedEndpoint(
  ctx: QueryCtx,
  section: OrgExportSection,
  row: OrgExportRow,
  orgId: string,
  liveProject: ((id: string) => Promise<boolean>) | undefined,
): Promise<boolean> {
  switch (section) {
    case 'team_members':
    case 'project_access':
      return (await byId(ctx, 'profiles', row.profile_id as string))?.org_id === orgId
    case 'project_team_access':
      return (await byId(ctx, 'teams', row.team_id as string))?.org_id === orgId
    case 'issue_links': {
      const target = await byId(ctx, 'issues', row.target_id as string)
      if (target?.org_id !== orgId) return false
      return liveProject === undefined || (await liveProject(target.project_id))
    }
    case 'issue_labels':
      return (await byId(ctx, 'labels', row.label_id as string))?.org_id === orgId
    default:
      return true
  }
}

/* The deleted item states whose work may still be in the live tables. A
 * project item's move leaves tasks in issues under its absent projects until
 * each one moves, and detaches their children outside it only then; a stuck
 * move keeps them until Delete now purges them; a restore writes tasks back
 * before its reveal. A task item moves its tasks and detaches their children
 * in one transaction, and a ready item has nothing left in the live tables.
 * A state added later counts as in flight until someone decides otherwise. */
const IN_FLIGHT = DELETED_ITEM_STATES.filter((state) => state !== 'ready')

/** Whether organization `orgId` has a deleted item in flight (IN_FLIGHT),
 * by one indexed read of deleted_items.by_org_state per state. */
export async function hasItemInFlight(ctx: QueryCtx, orgId: string): Promise<boolean> {
  for (const state of IN_FLIGHT) {
    const item = await ctx.db
      .query('deleted_items')
      .withIndex('by_org_state', (q) => q.eq('org_id', orgId).eq('state', state))
      .first()
    if (item !== null) return true
  }
  return false
}

/* The live sections whose tables Deleted items stores (lib/orgExport.ts
 * JOB_ORDER), each of whose reads asks hasItemInFlight, so the Deleted
 * items section knows which live reads may have left rows out
 * (storedBatch). */
const STORED_LIVE: ReadonlySet<OrgExportSection> = new Set(
  JOB_ORDER.flatMap((section) => (section.kind === 'stored' ? [section.live] : [])),
)

/** The value `read` gives for `key`, read once while `cache` lasts. */
function once<V>(cache: Map<string, Promise<V>>, key: string, read: () => Promise<V>): Promise<V> {
  let value = cache.get(key)
  if (value === undefined) {
    value = read()
    cache.set(key, value)
  }
  return value
}

/** Whether a project, or a task's parent and its project, is live, each
 * read once while the checks last (one page, or one readBatch). */
export type LiveChecks = {
  project: (id: string) => Promise<boolean>
  parent: (id: string) => Promise<boolean>
}

/** New LiveChecks with their own reads. */
export function liveChecks(ctx: QueryCtx): LiveChecks {
  const projects = new Map<string, Promise<boolean>>()
  const project = (id: string) =>
    once(projects, id, async () => (await byId(ctx, 'projects', id)) !== null)
  const parents = new Map<string, Promise<boolean>>()
  const parent = (id: string) =>
    once(parents, id, async () => {
      const task = await byId(ctx, 'issues', id)
      return task !== null && (await project(task.project_id))
    })
  return { project, parent }
}

/** `doc` as an export sends it, without the fields that are not portable
 * organization data: a live document of `section`, or a stored one of the
 * same table (Deleted items), which leaves out the same fields. */
export function exportRow(
  doc: Doc<OrgExportSection> | Doc<'deleted_rows'>['row']['doc'],
  section: OrgExportSection,
): OrgExportRow {
  const row: OrgExportRow = { ...doc }
  // Convex's document ids and creation times are not application data.
  delete row._id
  delete row._creationTime
  // Login identifiers and credential hashes are not portable organization data.
  delete row.auth_user_id
  delete row.message_retention_days
  // the retired Gravatar setting (schema.ts)
  delete row.gravatar_avatars
  // a task's archive-mark flag is the archive steps' bookkeeping
  delete row.relations_marked
  // a task's or project's window key only placed it in the app's former
  // windows
  delete row.window_key
  // a name key, or its copy on a membership, grant or team share, only
  // serves name-ordered index reads, and so does a project's archive state
  delete row.name_key
  delete row.archive_state
  // an activity row's field prints only let a refused edit name who wrote
  // the value (model/expected.ts)
  delete row.field_prints
  // The organization id, the archive mark and the task's window key only
  // serve index reads.
  if (section === 'issue_links' || section === 'issue_labels' || section === 'issue_attachments') {
    delete row.org_id
    delete row.task_archived
  }
  delete row.task_key
  // An agent key's organization and name key only serve API access's
  // name-ordered index reads.
  if (section === 'agent_keys') {
    delete row.org_id
    delete row.name_key
  }
  delete row.key_hash
  return row
}

/** The organization's own row as an export sends it, with its counters
 * from org_counters, or null when it is gone. */
export async function organizationRow(ctx: QueryCtx, orgId: string): Promise<OrgExportRow | null> {
  const org = await byId(ctx, 'organizations', orgId)
  if (org === null) return null
  return { ...exportRow(org, 'organizations'), ...(await countersOf(ctx, org)) }
}

/** The rows an export sends for `docs`, read in order from one range of
 * `section` in organization `orgId`, and how many tasks it left out because
 * their project is not live. `inFlight` says whether a deleted item is in
 * flight, which only the issues and issue_links sections ask: only then
 * does a task's project or parent, or a link target's project, need a read.
 * An issues row takes its text from `texts` by task id when the caller read
 * them already (descriptionsOf), else reads it (descriptionOf). */
export async function exportDocs(
  ctx: QueryCtx,
  orgId: string,
  section: PagedSection,
  docs: readonly Doc<PagedSection>[],
  inFlight: boolean,
  live: LiveChecks,
  texts?: ReadonlyMap<string, string>,
): Promise<{ rows: OrgExportRow[]; skipped: number }> {
  // Only an item in flight leaves a task in issues under an absent project,
  // or a task under a parent whose project is absent (the move detaches it
  // only when it gets there). The export leaves out such a task, and such
  // a parent reference, so it reads tasks' projects and parents only then,
  // on a small page, because a project or a parent can carry a large
  // description. Otherwise every task's project and parent are live.
  const checkParents = section === 'issues' && inFlight
  const rows: OrgExportRow[] = []
  let skipped = 0
  for (const doc of docs) {
    // A child row that names its organization must name this one, also
    // when a damaged row or a reused parent id reaches another
    // organization's rows.
    if ('org_id' in doc && doc.org_id !== undefined && doc.org_id !== orgId) continue
    // a task under a project in Deleted items stays out, like the project
    const projectId = checkParents && 'project_id' in doc ? doc.project_id : undefined
    if (projectId !== undefined && !(await live.project(projectId))) {
      skipped += 1
      continue
    }
    const row = exportRow(doc, section)
    // A person's Team sync stamp goes out as sync_at and sync_since, from
    // their sync_stamps row.
    if (section === 'profiles' && typeof row.id === 'string') {
      const stamp = await stampRow(ctx, row.id)
      if (stamp !== null) {
        row.sync_at = stamp.at
        if (stamp.since !== undefined) row.sync_since = stamp.since
      }
    }
    if (checkParents && typeof row.parent_id === 'string' && !(await live.parent(row.parent_id)))
      delete row.parent_id
    // a task, the one row with a title, takes its text from its
    // description row
    if ('title' in doc) row.description = texts?.get(doc.id) ?? (await descriptionOf(ctx.db, doc))
    if (await hasOwnedEndpoint(ctx, section, row, orgId, inFlight ? live.project : undefined))
      rows.push(row)
  }
  return { rows, skipped }
}

/** What one readBatch gives the export job: rows of one section in order,
 * where its reads go on, whether the section is done, and how many tasks it
 * left out because a deleted item was in flight. `retry: 'narrow'` comes
 * with no rows and the cursor it was given, when a wide tasks page's texts
 * did not fit (TEXT_ROOM): read the same cursor again with `wide: false`.
 * `in_flight` comes with a live section of a table Deleted items stores
 * when the read found a deleted item in flight (hasItemInFlight), so its
 * rows under absent tasks or projects may have stayed out of it
 * (storedBatch). */
export type ExportBatch = {
  rows: OrgExportRow[]
  at: ExportCursor
  done: boolean
  skipped: number
  retry?: 'narrow'
  in_flight?: true
  // a Deleted items batch: the items seen changing (storedBatch), the
  // stored rows it left out with the items that held them, and the items
  // it called complete and partial
  unsettled?: string[]
  left_out?: number
  left_out_items?: string[]
  items?: { complete: number; partial: number }
}

/** How readBatch reads: `wide: false` reads the tasks section six a page
 * (ISSUES_PAGE_SIZE) instead of 100 with their texts under TEXT_ROOM, and
 * `job` is what the Deleted items sections need of the job (BatchJob). */
export type BatchOptions = { wide?: boolean; job?: BatchJob }

/* Whether readBatch may start another read: under PAGE_BYTES read so far
 * and under half of each of Convex's other limits for one transaction. */
const roomLeft = async (ctx: QueryCtx): Promise<boolean> =>
  (await ctx.meta.getTransactionMetrics()).bytesRead.used < PAGE_BYTES &&
  !(await usedMoreThan(ctx, 0.5))

type ParentTable = 'teams' | 'projects' | 'issues' | 'profiles'

/* Whether parent `doc` of `section`, read in organization `orgId`, still
 * has children the export reads. Only agents have agent keys. While a
 * deleted item is in flight a task under a project that is not live stays
 * out with its rows, as the tasks section leaves it out. */
async function parentReads(
  doc: Doc<PagedSection>,
  orgId: string,
  section: OrgExportSection,
  inFlight: boolean,
  live: LiveChecks,
): Promise<boolean> {
  if (!('org_id' in doc) || doc.org_id !== orgId) return false
  if (section === 'agent_keys' && !('kind' in doc && doc.kind === 'agent')) return false
  const projectId = 'project_id' in doc ? doc.project_id : undefined
  return !(inFlight && projectId !== undefined && !(await live.project(projectId)))
}

/* Whether the parent `id` of a page an earlier call read still belongs to
 * organization `orgId` and has children the export reads (parentReads). A
 * profile or task removed since can have its id taken by another
 * organization's row, whose children must not enter this archive. */
async function stillParent(
  ctx: QueryCtx,
  orgId: string,
  section: OrgExportSection,
  parentTable: ParentTable,
  id: string,
  inFlight: boolean,
  live: LiveChecks,
): Promise<boolean> {
  const doc = await byId(ctx, parentTable, id)
  return doc !== null && (await parentReads(doc, orgId, section, inFlight, live))
}

/* The ids of the next page of a child section's parents, `parentTable` by
 * organization from `cursor`. Only agents have agent keys, so agent_keys
 * keeps the agents alone. While a deleted item is in flight a task under a
 * project that is not live stays out with its rows, so the page then reads
 * each task's project, on a page of JOINED_PAGE_SIZE tasks, set while a
 * project row had no size bound. A project is at most lib/limits.ts
 * PROJECT_ROW_MAX_BYTES now. */
async function parentPage(
  ctx: QueryCtx,
  orgId: string,
  section: OrgExportSection,
  parentTable: ParentTable,
  cursor: string | null,
  inFlight: boolean,
  live: LiveChecks,
): Promise<NonNullable<ExportCursor['parents']>> {
  const size = parentTable === 'issues' && inFlight ? JOINED_PAGE_SIZE : PAGE_SIZE
  const page = await readPage(ctx, parentTable, orgId, cursor, size)
  const ids: string[] = []
  for (const doc of page.page) {
    // every parent table has an id; this tells TypeScript so
    if (!('id' in doc)) continue
    if (await parentReads(doc, orgId, section, inFlight, live)) ids.push(doc.id)
  }
  return { ids, at: 0, cursor: page.continueCursor, done: page.isDone }
}

/**
 * One bounded read of the export job's current section in organization
 * `orgId`, from `from` on. A Deleted items section reads one page of its
 * stored table or of the items (storedBatch, itemsBatch), with what it
 * needs of the job in `opts.job`. The organizations section is one row. A
 * top-level section reads one page. A child section reads the next page of
 * parent ids when it needs one, pages the first parent's children from the
 * cursor, and then reads the children of the next parents of the page
 * whole while it has room, so a task with few comments costs no query of
 * its own. A parent whose children do not fit in one page is left for the
 * next call, which pages them. Convex runs one paginated read in a query,
 * so a call pages once: the parent page or the first parent. Parent ids
 * that an earlier call read wait in the step's state between calls, so a
 * call reads each such parent again first and skips it unless it still
 * belongs to the organization and still has children the export reads
 * (stillParent). Every child row that names an organization must name
 * this one (exportDocs). A live section of a table Deleted items stores
 * answers `in_flight` when it found a deleted item in flight, one indexed
 * read a state (hasItemInFlight).
 *
 * A top-level section reads one page: at most PAGE_BYTES of rows and the
 * one row past them, plus the reads its rows make (pageSizeOf): six tasks'
 * texts at two description rows each, or two tasks' projects, parents and
 * texts, about 2 + 12 MiB. While no deleted item is in flight and `wide` is
 * not false, the tasks section reads PAGE_SIZE tasks within PAGE_BYTES
 * and their texts within TEXT_ROOM instead, at most 7 MiB in all; when the
 * texts do not fit it answers no rows, its cursor unchanged and
 * `retry: 'narrow'`, and the caller reads the same cursor again narrow, so
 * no page is lost. A child section starts each read under
 * PAGE_BYTES read and under half of Convex's other limits (roomLeft):
 * either a parent page, at most PAGE_BYTES of parents and one more, with
 * up to ten of their projects while a deleted item is in flight, or one
 * parent's children. Those it reads after reading a kept parent again with,
 * in flight, its project, as a page (PAGE_BYTES of rows and the one past
 * them) or as a whole range (wholeRange, PAGE_BYTES and one document read),
 * plus the reads their rows make: ten second documents of a joined
 * section, or four link targets and their projects. Each document holds at
 * most Convex's 1 MiB, so a call reads at most about 1 + 2 + 2 + 10 MiB,
 * under the 16 MiB a query may read. Its answer holds only rows it read
 * and their texts: an issues page's ISSUES_PAGE_SIZE texts with their
 * rows, or a wide page's within TEXT_ROOM, about 7 MiB at most, and about
 * 3 MiB for any other section.
 */
export async function readBatch(
  ctx: QueryCtx,
  orgId: string,
  from: ExportCursor,
  opts: BatchOptions = {},
): Promise<ExportBatch> {
  const entry = JOB_ORDER[from.section]
  if (entry === undefined) throw new Error(`no export section ${from.section}`)
  if (entry.kind !== 'live') {
    if (opts.job === undefined) throw new Error(`export section ${entry.key} needs its job`)
    return entry.kind === 'stored'
      ? await storedBatch(ctx, orgId, entry.table, from, opts.job)
      : await itemsBatch(ctx, orgId, from, opts.job)
  }
  const section = entry.section
  const at = (cursor: string | null, parents?: ExportCursor['parents']): ExportCursor => ({
    section: from.section,
    cursor,
    ...(parents === undefined ? {} : { parents }),
  })
  if (section === 'organizations') {
    const row = await organizationRow(ctx, orgId)
    if (row === null) throw notFound('organization not found')
    return { rows: [row], at: at(null), done: true, skipped: 0 }
  }
  const parentTable = ORG_EXPORT_SECTIONS[section]
  const live = liveChecks(ctx)
  // whether a deleted item is in flight, which only a table Deleted items
  // stores needs to know. The tasks and their links and children then read
  // projects and parents, and every such section reports it (in_flight).
  const sawInFlight = STORED_LIVE.has(section) && (await hasItemInFlight(ctx, orgId))
  const inFlight =
    (section === 'issues' || section === 'issue_links' || parentTable === 'issues') && sawInFlight
  const flagged = sawInFlight ? { in_flight: true as const } : {}
  const pageSize = pageSizeOf(section, inFlight)
  const rows: OrgExportRow[] = []
  let skipped = 0
  const add = async (docs: readonly Doc<PagedSection>[], texts?: ReadonlyMap<string, string>) => {
    const out = await exportDocs(ctx, orgId, section, docs, inFlight, live, texts)
    rows.push(...out.rows)
    skipped += out.skipped
  }
  if (section === 'issues' && !inFlight && opts.wide !== false) {
    const page = await ctx.db
      .query('issues')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .paginate({
        numItems: PAGE_SIZE,
        cursor: from.cursor,
        maximumRowsRead: PAGE_SIZE,
        maximumBytesRead: PAGE_BYTES,
      })
    const texts = await descriptionsOf(ctx, page.page, TEXT_ROOM)
    // Convex's cursor cannot point inside a page, so the caller reads the
    // same page again, narrow
    if (texts === null) return { rows: [], at: from, done: false, skipped: 0, retry: 'narrow' }
    await add(page.page, texts)
    return { rows, at: at(page.isDone ? null : page.continueCursor), done: page.isDone, skipped }
  }
  if (parentTable === null) {
    const page = await readPage(ctx, section, orgId, from.cursor, pageSize)
    await add(page.page)
    return {
      rows,
      at: at(page.isDone ? null : page.continueCursor),
      done: page.isDone,
      skipped,
      ...flagged,
    }
  }
  let cursor = from.cursor
  let parents = from.parents
  // whether this call read the parent page itself, so its ids are as
  // current as the children it reads; ids from an earlier call are checked
  // again first
  let fresh = false
  let paged = false
  for (;;) {
    if (parents !== undefined && parents.at >= parents.ids.length && parents.done)
      return { rows, at: at(null), done: true, skipped, ...flagged }
    if (!(await roomLeft(ctx))) break
    if (parents === undefined || parents.at >= parents.ids.length) {
      if (paged) break
      paged = true
      parents = await parentPage(
        ctx,
        orgId,
        section,
        parentTable,
        parents?.cursor ?? null,
        inFlight,
        live,
      )
      fresh = true
      cursor = null
      continue
    }
    const scope = parents.ids[parents.at]
    if (!fresh && !(await stillParent(ctx, orgId, section, parentTable, scope, inFlight, live))) {
      parents = { ...parents, at: parents.at + 1 }
      cursor = null
      continue
    }
    if (!paged) {
      paged = true
      const page = await readPage(ctx, section, scope, cursor, pageSize)
      await add(page.page)
      if (!page.isDone) {
        cursor = page.continueCursor
        break
      }
    } else {
      // only a paged parent leaves a cursor, and the call ends there
      const docs = await wholeRange(ctx, section, scope, pageSize)
      if (docs === null) break
      await add(docs)
    }
    parents = { ...parents, at: parents.at + 1 }
    cursor = null
  }
  return { rows, at: at(cursor, parents), done: false, skipped, ...flagged }
}

/* ---------------------------------------------- the Deleted items section
 * The job's last ten sections (lib/orgExport.ts DELETED_SECTIONS) read the
 * organization's retained Deleted items under the export's exception for
 * the whole organization (owner, 25 October 2026), whatever an admin's
 * role reads on the Deleted items page. Each stored table is read on its
 * own from deleted_rows by table and organization (by_table_org_owner) with
 * one cursor, every row's item read once a batch, so a row is read once
 * whichever item holds it then: a restore's split that moves a subtask's
 * rows to another item (model/deletedItems.ts splitOff) patches item_id
 * and leaves them where they are in that index. Only a link a reveal hands
 * to another item (placeLinkBy) changes owner_id, and can then be read
 * twice or missed, which the README says. Both write the receiving item's
 * received_at, so the items section calls an item partial that took rows
 * after collection began and before the section read it. The items come
 * last (`itemsBatch`), each with how much of it the archive holds. */

/** What a Deleted items batch knows of its job: when collection started,
 * when each live section's read ended (step.ended), the live sections any
 * of whose reads found a deleted item in flight (step.in_flight) and the
 * items seen changing so far (step.unsettled). */
export type BatchJob = {
  started_at: string
  ended: Record<string, string>
  in_flight: string[]
  unsettled: string[]
}

/* The stored tables whose check reads another document a row, read
 * JOINED_PAGE_SIZE a page as the live joined sections are. */
const STORED_JOINED: ReadonlySet<ExportedStoredTable> = new Set([
  'issue_labels',
  'issue_links',
  'project_access',
  'project_team_access',
])

/* The item fields the section's rules read. */
type ItemView = Pick<
  Doc<'deleted_items'>,
  'id' | 'org_id' | 'kind' | 'target_id' | 'state' | 'deleted_at' | 'received_at'
>

/** The Deleted items of organization `orgId` that are moving or restoring
 * now, whose records are on both sides, at most EXPORT_LIMITS.unsettled + 1
 * of them in two index ranges: the ids a batch adds to the job's unsettled
 * items, so the items section never calls one complete, also when the
 * batch finds none of its rows (D3). A stuck item is partial by its own
 * state, and a purging one cannot come back. */
export async function itemsInFlight(ctx: QueryCtx, orgId: string): Promise<string[]> {
  const ids: string[] = []
  for (const state of ['moving', 'restoring'] as const) {
    const left = EXPORT_LIMITS.unsettled + 1 - ids.length
    if (left <= 0) break
    const items = await ctx.db
      .query('deleted_items')
      .withIndex('by_org_state', (q) => q.eq('org_id', orgId).eq('state', state))
      .take(left)
    for (const item of items) ids.push(item.id)
  }
  return ids
}

/** Whether the Deleted items section exports the stored rows of `item`,
 * an item of the organization: one that is not purging (being deleted for
 * good) and has not been restored. A row is in its live table
 * or in deleted_rows, never both, apart from a restoring project item's
 * grants and team grants, which go back to the live tables before its
 * reveal (model/deletedItems.ts restoreAccess) and leave deleted_rows only
 * after it (restoreGrants). Before the reveal the live copies name absent
 * projects, which the live sections never reach; after it the projects are
 * live and the stored copies are left, so a restoring project item whose
 * root project is live again exports none of its stored rows (one project
 * read, of at most lib/limits.ts PROJECT_ROW_MAX_BYTES). A task item's
 * reveal writes its tasks back and moves or deletes every stored row of it
 * in one transaction, so a restoring task item's stored rows are its own
 * and are read without a root check. `projectLive` reads each project once
 * a batch. */
async function itemReads(
  item: ItemView,
  projectLive: (id: string) => Promise<boolean>,
): Promise<boolean> {
  if (item.state === 'purging') return false
  return !(
    item.state === 'restoring' &&
    item.kind === 'project' &&
    (await projectLive(item.target_id))
  )
}

/** Whether task `id` belongs to organization `orgId`, live or stored: its
 * issues row, else its deleted_tasks row (one light row per stored task,
 * schema.ts), never its stored document, which can hold a text near
 * Convex's document limit. */
async function taskOfOrg(ctx: QueryCtx, id: string, orgId: string): Promise<boolean> {
  const live = await byId(ctx, 'issues', id)
  if (live !== null) return live.org_id === orgId
  const stored = await ctx.db
    .query('deleted_tasks')
    .withIndex('by_task', (q) => q.eq('task_id', id))
    .first()
  return stored?.org_id === orgId
}

/* Whether stored row `stored` of `table` keeps its second endpoint in
 * organization `orgId`, as the live sections check it (hasOwnedEndpoint).
 * A stored link travels with the task that moved first (owner_id), so its
 * other end is the one that is not the owner, a live or stored task of the
 * organization (taskOfOrg); a link whose owner is neither end fails. One
 * read a row, two for a link whose other end is stored. */
async function storedEndOwned(
  ctx: QueryCtx,
  stored: Doc<'deleted_rows'>,
  orgId: string,
): Promise<boolean> {
  const { row } = stored
  switch (row.table) {
    case 'issue_links': {
      const other =
        row.doc.source_id === stored.owner_id
          ? row.doc.target_id
          : row.doc.target_id === stored.owner_id
            ? row.doc.source_id
            : null
      return other !== null && (await taskOfOrg(ctx, other, orgId))
    }
    case 'issue_labels':
      return (await byId(ctx, 'labels', row.doc.label_id))?.org_id === orgId
    case 'project_access':
      return (await byId(ctx, 'profiles', row.doc.profile_id))?.org_id === orgId
    case 'project_team_access':
      return (await byId(ctx, 'teams', row.doc.team_id))?.org_id === orgId
    default:
      return true
  }
}

/** One page of the stored rows of `table` in organization `orgId` from
 * `from`, as the Deleted items section writes them: each document as its
 * live table's section writes it (exportRow, the same fields left out) with
 * `deleted_item_id`, a task's text from its stored copy. Per row it reads
 * the row's item once a batch and skips the rows of an item itemReads
 * leaves out. It leaves out, and counts in `left_out`, a row whose item is
 * gone or another organization's, whose document names another
 * organization, or whose second endpoint is not the organization's
 * (storedEndOwned), such as a label assignment whose label was deleted
 * after its task, or a share whose team was. The answer's `left_out_items`
 * names the organization's items whose rows it left out so, which the items
 * section then calls partial (itemStatus); a row whose item is gone or
 * another organization's names none. It also leaves out the rows the live
 * sections exported for certain: a row of an item deleted after its table's
 * live section ended, which existed before that section began and was
 * stored after it ended, so it sat in its live table for the whole read
 * (`job.ended`), when no read of that section found a deleted item in
 * flight (`job.in_flight`). Only an item in flight leaves a live row under
 * an absent task or project, which the live read never reaches, or a live
 * link to a task under an absent project, which it drops
 * (hasOwnedEndpoint); such a row, stored later by an item deleted after the
 * read, was never exported, so after a read that found an item in flight
 * the rule keeps every row, at worst a flagged duplicate. Every other row
 * of an item deleted during the export goes out, and the items section
 * flags that item.
 *
 * The answer's `unsettled` names the items whose records may be on both
 * sides or were stored again while the export ran: every item moving or
 * restoring now (itemsInFlight), and an item deleted before collection
 * began with a row stored at or after it, which a failed restore and the
 * move back leave. One query reads one batch atomically, so an item whose
 * rows fit in one batch cannot change inside it; an item that left ready
 * and came back between two batches without either seeing it either
 * stored rows again, which a later batch counts, or kept the rows a batch
 * read.
 *
 * It reads one page of PAGE_SIZE rows, JOINED_PAGE_SIZE for the joined
 * tables, within PAGE_BYTES (a stored row is at most
 * model/deletedItems.ts STORED_ROW_MAX_BYTES), so at most PAGE_BYTES and one
 * row past them; each row's item, a fixed-size row of a few kilobytes, and
 * a restoring project item's root project; for a joined table one second
 * document a row of up to 1 MiB, and a link's stored end's deleted_tasks
 * row; and the items in flight, at most EXPORT_LIMITS.unsettled + 1 rows
 * of a few kilobytes. About 2 + 11 + 3 MiB for a page of ten links in the
 * worst case, under the 16 MiB a query may read. Each deleted/tasks page of
 * a project item holding a project's 800 open tasks read at most 4 ranges,
 * 101 documents and 0.073 MiB (convex/tests/orgExportDeleted.test.ts, 6
 * November 2026). */
async function storedBatch(
  ctx: QueryCtx,
  orgId: string,
  table: ExportedStoredTable,
  from: ExportCursor,
  job: BatchJob,
): Promise<ExportBatch> {
  const size = STORED_JOINED.has(table) ? JOINED_PAGE_SIZE : PAGE_SIZE
  const page = await ctx.db
    .query('deleted_rows')
    .withIndex('by_table_org_owner', (q) => q.eq('table', table).eq('org_id', orgId))
    .paginate({
      numItems: size,
      cursor: from.cursor,
      maximumRowsRead: size,
      maximumBytesRead: PAGE_BYTES,
    })
  const unsettled = new Set(await itemsInFlight(ctx, orgId))
  const items = new Map<string, Promise<ItemView | null>>()
  const projects = new Map<string, Promise<boolean>>()
  const projectLive = (id: string) =>
    once(projects, id, async () => (await byId(ctx, 'projects', id))?.org_id === orgId)
  // the live section of this table: it began when the one before it ended,
  // and it held its rows for certain only if no read of it found an item
  // in flight
  const live = ORG_EXPORT_ORDER.indexOf(table)
  const certain = !job.in_flight.includes(exportName(table))
  const ended = job.ended[exportName(table)]
  const began = live === 0 ? job.started_at : job.ended[exportName(ORG_EXPORT_ORDER[live - 1])]
  const startedMs = Date.parse(job.started_at)
  const rows: OrgExportRow[] = []
  let leftOut = 0
  const short = new Set<string>()
  for (const stored of page.page) {
    const item = await once(items, stored.item_id, () => byId(ctx, 'deleted_items', stored.item_id))
    if (item === null || item.org_id !== orgId) {
      leftOut += 1
      continue
    }
    if (!(await itemReads(item, projectLive))) continue
    if (item.deleted_at < job.started_at && stored._creationTime >= startedMs)
      unsettled.add(item.id)
    if (
      certain &&
      ended !== undefined &&
      began !== undefined &&
      item.deleted_at > ended &&
      stored.created_ts < Date.parse(began) &&
      stored._creationTime > Date.parse(ended)
    )
      continue
    const { doc } = stored.row
    if (
      ('org_id' in doc && doc.org_id !== undefined && doc.org_id !== orgId) ||
      !(await storedEndOwned(ctx, stored, orgId))
    ) {
      leftOut += 1
      short.add(item.id)
      continue
    }
    const row = exportRow(doc, table)
    if (stored.row.table === 'issues') row.description = stored.row.doc.description ?? ''
    rows.push({ ...row, deleted_item_id: item.id })
  }
  return {
    rows,
    at: { section: from.section, cursor: page.isDone ? null : page.continueCursor },
    done: page.isDone,
    skipped: 0,
    unsettled: [...unsettled],
    left_out: leftOut,
    ...(short.size === 0 ? {} : { left_out_items: [...short] }),
  }
}

/** Why an item's records may be missing from the archive, in the order
 * export_reason takes them when several apply. */
type ItemReason =
  | 'purging'
  | 'restored'
  | 'moving'
  | 'restoring'
  | 'stuck'
  | 'deleted_during_export'
  | 'changed_during_export'
  | 'rows_left_out'

/** The items whose stored records the job's stored sections left out
 * (storedBatch): those its step names (step.left_out_items), or every item
 * once more did than it may name (step.left_out_more). */
type LeftOut = { items: ReadonlySet<string>; all: boolean }

/** How much of `item` the archive holds: complete only when it is ready,
 * was deleted before collection began, is not among the job's unsettled
 * items, took no rows from another item's restore since collection began
 * (received_at) and kept no record the stored sections left out, else
 * partial with the first reason that applies: purging, restored (a
 * restoring project item whose root project is live again, whose stored
 * rows itemReads left out), its state (moving, restoring, stuck), deleted
 * during the export, changed during the export (unsettled or received
 * rows), rows left out (`leftOut`). There is no third value: rows of a
 * purging or restored item read while it was still ready stay in the
 * archive, so none of them is "not included". */
async function itemStatus(
  item: ItemView,
  job: BatchJob,
  unsettled: ReadonlySet<string>,
  leftOut: LeftOut,
  projectLive: (id: string) => Promise<boolean>,
): Promise<{ complete: boolean; reason?: ItemReason; during: boolean }> {
  const during = item.deleted_at >= job.started_at
  const reason: ItemReason | undefined =
    item.state === 'purging'
      ? 'purging'
      : item.state === 'restoring' && item.kind === 'project' && (await projectLive(item.target_id))
        ? 'restored'
        : item.state !== 'ready'
          ? item.state
          : during
            ? 'deleted_during_export'
            : unsettled.has(item.id) ||
                (item.received_at !== undefined && item.received_at >= job.started_at)
              ? 'changed_during_export'
              : leftOut.all || leftOut.items.has(item.id)
                ? 'rows_left_out'
                : undefined
  return reason === undefined ? { complete: true, during } : { complete: false, reason, during }
}

/** One page of organization `orgId`'s Deleted items from `from`, newest
 * last (by_org_deleted), PAGE_SIZE within PAGE_BYTES, each as the archive
 * writes it: its stored fields with `purge_after` as `purge_at`, an ISO
 * time, without `restore_by`, a restore's own state, or `received_at`,
 * the export's own bookkeeping, and with `via`
 * narrowed to the credential's table, keeping an agent key's id and name,
 * whose metadata the archive holds, and leaving out a personal token's or
 * connected app's, which the archive leaves out with the personal
 * credentials (COMMON_EXCLUSIONS); then export_rows, export_reason and
 * deleted_during_export (itemStatus). The items whose records the stored
 * sections left out come from the organization's collecting job, at most
 * one (step.left_out_items, orgExport.ts noteLeftOut), not from `job`. The
 * answer tallies complete and partial items. Reads the page, the job row,
 * at most about 30 KB, and a restoring project item's root project, under
 * 3 MiB. */
async function itemsBatch(
  ctx: QueryCtx,
  orgId: string,
  from: ExportCursor,
  job: BatchJob,
): Promise<ExportBatch> {
  const page = await ctx.db
    .query('deleted_items')
    .withIndex('by_org_deleted', (q) => q.eq('org_id', orgId))
    .paginate({
      numItems: PAGE_SIZE,
      cursor: from.cursor,
      maximumRowsRead: PAGE_SIZE,
      maximumBytesRead: PAGE_BYTES,
    })
  const projects = new Map<string, Promise<boolean>>()
  const projectLive = (id: string) =>
    once(projects, id, async () => (await byId(ctx, 'projects', id))?.org_id === orgId)
  const unsettled = new Set(job.unsettled)
  const step = (await collectingJob(ctx, orgId))?.step
  const leftOut: LeftOut = {
    items: new Set(step?.left_out_items ?? []),
    all: step?.left_out_more === true,
  }
  const items = { complete: 0, partial: 0 }
  const rows: OrgExportRow[] = []
  for (const item of page.page) {
    const status = await itemStatus(item, job, unsettled, leftOut, projectLive)
    const { _id, _creationTime, via, purge_after, restore_by, received_at, ...fields } = item
    rows.push({
      ...fields,
      ...(via === undefined
        ? {}
        : { via: via.table === 'agent_keys' ? via : { table: via.table } }),
      purge_at: new Date(purge_after).toISOString(),
      export_rows: status.complete ? 'complete' : 'partial',
      ...(status.reason === undefined ? {} : { export_reason: status.reason }),
      deleted_during_export: status.during,
    })
    if (status.complete) items.complete += 1
    else items.partial += 1
  }
  return {
    rows,
    at: { section: from.section, cursor: page.isDone ? null : page.continueCursor },
    done: page.isDone,
    skipped: 0,
    items,
  }
}

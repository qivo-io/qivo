/* The organization export's reads, which the paging query orgExport.page
 * and the export job's readBatch (orgExport.ts) share. Every read is
 * bounded and scoped to one organization; an export spanning many reads is
 * a live traversal, not an atomic database backup. Archived rows and the
 * entire retained activity history are included. Deleted items are not:
 * their rows left the live tables, and a task still in issues under a
 * project that is moving to or back from Deleted items (model/deletedItems.ts)
 * is skipped, with its comments, labels, links and attachments, and a live
 * task's reference to it as a parent is left out. Only a deleted item that
 * is not ready leaves tasks in issues under an absent project, so the
 * issues section reads each task's parent only while the organization has
 * one, on a smaller page still. Each task's text comes from its description
 * rows (model/descriptions.ts descriptionOf), two documents at most a row,
 * so the issues section reads a smaller page too.
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
import {
  type ExportCursor,
  ORG_EXPORT_ORDER,
  ORG_EXPORT_SECTIONS,
  type OrgExportRow,
  type OrgExportSection,
} from '../lib/orgExport'
import { descriptionOf } from './descriptions'
import { countersOf } from './orgs'
import { stampRow } from './syncStamps'

export const PAGE_SIZE = 100
/* Ten rows for a page that reads another document per row, so even ten
 * related documents at Convex's 1 MiB document cap stay inside its 16 MiB
 * read limit with the page itself. */
export const JOINED_PAGE_SIZE = 10
/* An issues page, whose rows each read the task's text, two description
 * rows at most of up to Convex's 1 MiB document limit: 6 rows read 12 MiB
 * beside the page's own rows. */
export const ISSUES_PAGE_SIZE = 6
/* An issue_links page read while a project item is in flight. Each row can
 * also read its target task and the target's project, each up to Convex's
 * 1 MiB document limit, so 4 rows plus the page's own rows stay under the
 * 16 MiB read limit. */
export const IN_FLIGHT_LINKS_PAGE_SIZE = 4
/* An issues page read while a project item is in flight. Each row can also
 * read the task's project, its parent and the parent's project, and its
 * text, two description rows at most, five documents of up to 1 MiB, so 2
 * rows plus the page's own rows stay under the 16 MiB read limit. */
export const IN_FLIGHT_ISSUES_PAGE_SIZE = 2
export const PAGE_BYTES = 1024 * 1024
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
 * organization data. */
export function exportRow(doc: Doc<OrgExportSection>, section: OrgExportSection): OrgExportRow {
  const { _id, _creationTime, ...fields } = doc
  const row: OrgExportRow = { ...fields }
  // Login identifiers and credential hashes are not portable organization data.
  delete row.auth_user_id
  delete row.message_retention_days
  // the retired Gravatar setting (schema.ts)
  delete row.gravatar_avatars
  // a task's archive-mark flag is the archive steps' bookkeeping
  delete row.relations_marked
  // a task's or project's window key only places it in the app's windows
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
 * An issues row reads the task's text. */
export async function exportDocs(
  ctx: QueryCtx,
  orgId: string,
  section: PagedSection,
  docs: readonly Doc<PagedSection>[],
  inFlight: boolean,
  live: LiveChecks,
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
    if ('title' in doc) row.description = await descriptionOf(ctx.db, doc)
    if (await hasOwnedEndpoint(ctx, section, row, orgId, inFlight ? live.project : undefined))
      rows.push(row)
  }
  return { rows, skipped }
}

/** What one readBatch gives the export job: rows of one section in order,
 * where its reads go on, whether the section is done, and how many tasks it
 * left out because a deleted item was in flight. */
export type ExportBatch = {
  rows: OrgExportRow[]
  at: ExportCursor
  done: boolean
  skipped: number
}

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
 * each task's project, on a page of JOINED_PAGE_SIZE tasks because a
 * project can carry a large description. */
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
 * `orgId`, from `from` on. The organizations section is one row. A
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
 * this one (exportDocs).
 *
 * A top-level section reads one page: at most PAGE_BYTES of rows and the
 * one row past them, plus the reads its rows make (pageSizeOf): six tasks'
 * texts at two description rows each, or two tasks' projects, parents and
 * texts, about 2 + 12 MiB. A child section starts each read under
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
 * rows, about 7 MiB at most, and about 3 MiB for any other section.
 */
export async function readBatch(
  ctx: QueryCtx,
  orgId: string,
  from: ExportCursor,
): Promise<ExportBatch> {
  const section = ORG_EXPORT_ORDER[from.section]
  if (section === undefined) throw new Error(`no export section ${from.section}`)
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
  const inFlight =
    (section === 'issues' || section === 'issue_links' || parentTable === 'issues') &&
    (await hasItemInFlight(ctx, orgId))
  const pageSize = pageSizeOf(section, inFlight)
  const rows: OrgExportRow[] = []
  let skipped = 0
  const add = async (docs: readonly Doc<PagedSection>[]) => {
    const out = await exportDocs(ctx, orgId, section, docs, inFlight, live)
    rows.push(...out.rows)
    skipped += out.skipped
  }
  if (parentTable === null) {
    const page = await readPage(ctx, section, orgId, from.cursor, pageSize)
    await add(page.page)
    return {
      rows,
      at: at(page.isDone ? null : page.continueCursor),
      done: page.isDone,
      skipped,
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
      return { rows, at: at(null), done: true, skipped }
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
  return { rows, at: at(cursor, parents), done: false, skipped }
}

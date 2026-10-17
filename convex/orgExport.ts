/* One-shot, admin-only organization export. Each request performs one bounded
 * indexed read and rechecks membership; an export spanning pages is a live
 * traversal, not an atomic database backup. Archived rows and the entire
 * retained activity history are included. Deleted items are not: their rows
 * left the live tables, and a task still in issues under a project that is
 * moving to or back from Deleted items (model/deletedItems.ts) is skipped,
 * with its comments, labels, links and attachments, and a live task's
 * reference to it as a parent is left out. Only a deleted item that is not
 * ready leaves tasks in issues under an absent project, so the issues
 * section reads each task's parent only while the organization has one, on
 * the smaller page the joined sections use. No signed URLs are
 * persisted here: clients mint existing file-gateway URLs immediately before
 * fetching bytes. */

import type { PaginationResult } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { byId } from './lib/db'
import { DELETED_ITEM_STATES } from './lib/enums'
import { badRequest, forbidden, notFound, orgQuery } from './lib/functions'
import {
  ORG_EXPORT_SECTIONS,
  type OrgExportPage,
  type OrgExportRow,
  type OrgExportSection,
} from './lib/orgExport'

const PAGE_SIZE = 100
/* Ten rows for a page that reads another document per row, so even ten
 * related documents at Convex's 1 MiB document cap stay inside its 16 MiB
 * read limit with the page itself. */
const JOINED_PAGE_SIZE = 10
const PAGE_BYTES = 1024 * 1024
const JOINED_SECTIONS: ReadonlySet<OrgExportSection> = new Set([
  'team_members',
  'project_access',
  'project_team_access',
  'issue_links',
  'issue_labels',
])

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

type PagedSection = Exclude<OrgExportSection, 'organizations'>

/* Spell out the indexed reads so no caller-controlled table, index or filter
 * can widen the scope. Children use only their verified parent's UUID.
 * `pageSize` is JOINED_PAGE_SIZE when each row costs another read. Endpoint
 * validation reads another document per row, and for a link also the
 * target's project, once per page, and an issues page in flight reads each
 * task's parent. A task can carry a large description, so these pages need
 * headroom beyond the pagination byte budget for the source rows themselves. */
async function readPage(
  ctx: QueryCtx,
  section: PagedSection,
  scope: string,
  cursor: string | null,
  pageSize: number,
): Promise<PaginationResult<Doc<PagedSection>>> {
  const opts = {
    numItems: pageSize,
    cursor,
    maximumRowsRead: pageSize,
    maximumBytesRead: PAGE_BYTES,
  }
  switch (section) {
    case 'teams':
      return await ctx.db
        .query('teams')
        .withIndex('by_org', (q) => q.eq('org_id', scope))
        .paginate(opts)
    case 'profiles':
      return await ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', scope))
        .paginate(opts)
    case 'projects':
      return await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', scope))
        .paginate(opts)
    case 'issues':
      return await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', scope))
        .paginate(opts)
    case 'labels':
      return await ctx.db
        .query('labels')
        .withIndex('by_org', (q) => q.eq('org_id', scope))
        .paginate(opts)
    case 'activity_events':
      return await ctx.db
        .query('activity_events')
        .withIndex('by_org_ts', (q) => q.eq('org_id', scope))
        .paginate(opts)
    case 'team_members':
      return await ctx.db
        .query('team_members')
        .withIndex('by_team', (q) => q.eq('team_id', scope))
        .paginate(opts)
    case 'project_access':
      return await ctx.db
        .query('project_access')
        .withIndex('by_project', (q) => q.eq('project_id', scope))
        .paginate(opts)
    case 'project_team_access':
      return await ctx.db
        .query('project_team_access')
        .withIndex('by_project', (q) => q.eq('project_id', scope))
        .paginate(opts)
    case 'milestones':
      return await ctx.db
        .query('milestones')
        .withIndex('by_project', (q) => q.eq('project_id', scope))
        .paginate(opts)
    case 'issue_links':
      // Each link is visited through its source once, regardless of type.
      return await ctx.db
        .query('issue_links')
        .withIndex('by_source', (q) => q.eq('source_id', scope))
        .paginate(opts)
    case 'issue_labels':
      return await ctx.db
        .query('issue_labels')
        .withIndex('by_issue', (q) => q.eq('issue_id', scope))
        .paginate(opts)
    case 'issue_attachments':
      return await ctx.db
        .query('issue_attachments')
        .withIndex('by_issue', (q) => q.eq('issue_id', scope))
        .paginate(opts)
    case 'comments':
      return await ctx.db
        .query('comments')
        .withIndex('by_issue', (q) => q.eq('issue_id', scope))
        .paginate(opts)
    case 'agent_keys':
      return await ctx.db
        .query('agent_keys')
        .withIndex('by_profile', (q) => q.eq('profile_id', scope))
        .paginate(opts)
  }
}

/* Model writers enforce these second endpoints too. Recheck them at this
 * boundary so a damaged join cannot disclose another organization's IDs. A
 * link's target must also be a task the export includes, one under a live
 * project (`liveProject`), so no exported link names a skipped task. */
async function hasOwnedEndpoint(
  ctx: QueryCtx,
  section: OrgExportSection,
  row: OrgExportRow,
  orgId: string,
  liveProject: (id: string) => Promise<boolean>,
): Promise<boolean> {
  switch (section) {
    case 'team_members':
    case 'project_access':
      return (await byId(ctx, 'profiles', row.profile_id as string))?.org_id === orgId
    case 'project_team_access':
      return (await byId(ctx, 'teams', row.team_id as string))?.org_id === orgId
    case 'issue_links': {
      const target = await byId(ctx, 'issues', row.target_id as string)
      return target?.org_id === orgId && (await liveProject(target.project_id))
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
async function hasItemInFlight(ctx: QueryCtx, orgId: string): Promise<boolean> {
  for (const state of IN_FLIGHT) {
    const item = await ctx.db
      .query('deleted_items')
      .withIndex('by_org_state', (q) => q.eq('org_id', orgId).eq('state', state))
      .first()
    if (item !== null) return true
  }
  return false
}

/** The value `read` gives for `key`, read once per page. */
function once<V>(cache: Map<string, Promise<V>>, key: string, read: () => Promise<V>): Promise<V> {
  let value = cache.get(key)
  if (value === undefined) {
    value = read()
    cache.set(key, value)
  }
  return value
}

function exportRow(doc: Doc<OrgExportSection>, section: OrgExportSection): OrgExportRow {
  const { _id, _creationTime, ...fields } = doc
  const row: OrgExportRow = { ...fields }
  // Login identifiers and credential hashes are not portable organization data.
  delete row.auth_user_id
  delete row.message_retention_days
  delete row.activity_count
  // a task's archive-mark flag only steers the app snapshot's reads
  delete row.relations_marked
  // The organization id and the archive mark only serve the app's index reads.
  if (section === 'issue_links' || section === 'issue_labels' || section === 'issue_attachments') {
    delete row.org_id
    delete row.task_archived
  }
  // An attachment's project copies its task's for the storage totals. Other
  // sections' project_id is their own data.
  if (section === 'issue_attachments') delete row.project_id
  delete row.key_hash
  return row
}

export const page = orgQuery({
  args: {
    section: sectionValidator,
    parent_id: v.optional(v.string()),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { section, parent_id, cursor }): Promise<OrgExportPage> => {
    const isAdmin = ctx.me.org_role === 'admin'
    if (!isAdmin) throw forbidden('only organization admins can export organization data')
    const orgId = ctx.me.org_id
    const parentTable = ORG_EXPORT_SECTIONS[section]
    // Whether a project, or a task's parent and its project, is live, read
    // once per page.
    const live = new Map<string, Promise<boolean>>()
    const liveProject = (id: string) =>
      once(live, id, async () => (await byId(ctx, 'projects', id)) !== null)
    const parents = new Map<string, Promise<boolean>>()
    const liveParent = (id: string) =>
      once(parents, id, async () => {
        const parent = await byId(ctx, 'issues', id)
        return parent !== null && (await liveProject(parent.project_id))
      })
    let scope = orgId
    if (parentTable !== null) {
      if (parent_id === undefined) throw badRequest('this export section requires a parent')
      const parent = await byId(ctx, parentTable, parent_id)
      if (parent === null || parent.org_id !== orgId) throw notFound('export parent not found')
      if ('project_id' in parent && !(await liveProject(parent.project_id)))
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
      const org = await byId(ctx, 'organizations', orgId)
      if (org === null) throw notFound('organization not found')
      return { rows: [exportRow(org, section)], continueCursor: '', isDone: true }
    }

    // A task under a parent whose project is moving to Deleted items keeps
    // that parent until the move detaches it. The export leaves out the
    // parent task, so it leaves out the reference too. Only an item in
    // flight leaves such a parent, so the page reads parents only then, at
    // the joined page size, because a parent can carry a large description.
    const checkParents = section === 'issues' && (await hasItemInFlight(ctx, orgId))
    const pageSize = JOINED_SECTIONS.has(section) || checkParents ? JOINED_PAGE_SIZE : PAGE_SIZE
    const result = await readPage(ctx, section, scope, cursor, pageSize)
    const rows: OrgExportRow[] = []
    for (const doc of result.page) {
      // a task under a project in Deleted items stays out, like the project
      const projectId = section === 'issues' && 'project_id' in doc ? doc.project_id : undefined
      if (projectId !== undefined && !(await liveProject(projectId))) continue
      const row = exportRow(doc, section)
      if (checkParents && typeof row.parent_id === 'string' && !(await liveParent(row.parent_id)))
        delete row.parent_id
      if (await hasOwnedEndpoint(ctx, section, row, orgId, liveProject)) rows.push(row)
    }
    return { rows, continueCursor: result.continueCursor, isDone: result.isDone }
  },
})

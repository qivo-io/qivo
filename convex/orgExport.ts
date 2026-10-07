/* One-shot, admin-only organization export. Each request performs one bounded
 * indexed read and rechecks membership; an export spanning pages is a live
 * traversal, not an atomic database backup. Archived rows and the entire
 * retained activity history are included. No signed URLs are persisted here:
 * clients mint existing file-gateway URLs immediately before fetching bytes. */

import type { PaginationResult } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { byId } from './lib/db'
import { badRequest, forbidden, notFound, orgQuery } from './lib/functions'
import {
  ORG_EXPORT_SECTIONS,
  type OrgExportPage,
  type OrgExportRow,
  type OrgExportSection,
} from './lib/orgExport'

const PAGE_SIZE = 100
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
 * can widen the scope. Children use only their verified parent's UUID. */
async function readPage(
  ctx: QueryCtx,
  section: PagedSection,
  scope: string,
  cursor: string | null,
): Promise<PaginationResult<Doc<PagedSection>>> {
  // Endpoint validation reads another document per row. In particular, a
  // linked task can carry a large description, so these pages need headroom
  // beyond the pagination byte budget for the source rows themselves.
  const pageSize = JOINED_SECTIONS.has(section) ? 10 : PAGE_SIZE
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
 * boundary so a damaged join cannot disclose another organization's IDs. */
async function hasOwnedEndpoint(
  ctx: QueryCtx,
  section: OrgExportSection,
  row: OrgExportRow,
  orgId: string,
): Promise<boolean> {
  switch (section) {
    case 'team_members':
    case 'project_access':
      return (await byId(ctx, 'profiles', row.profile_id as string))?.org_id === orgId
    case 'project_team_access':
      return (await byId(ctx, 'teams', row.team_id as string))?.org_id === orgId
    case 'issue_links':
      return (await byId(ctx, 'issues', row.target_id as string))?.org_id === orgId
    case 'issue_labels':
      return (await byId(ctx, 'labels', row.label_id as string))?.org_id === orgId
    default:
      return true
  }
}

function exportRow(doc: Doc<OrgExportSection>, section: OrgExportSection): OrgExportRow {
  const { _id, _creationTime, ...fields } = doc
  const row: OrgExportRow = { ...fields }
  // Login identifiers and credential hashes are not portable organization data.
  delete row.auth_user_id
  delete row.message_retention_days
  delete row.activity_count
  if (section === 'issue_links' || section === 'issue_labels' || section === 'issue_attachments')
    delete row.org_id
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
    let scope = orgId
    if (parentTable !== null) {
      if (parent_id === undefined) throw badRequest('this export section requires a parent')
      const parent = await byId(ctx, parentTable, parent_id)
      if (parent === null || parent.org_id !== orgId) throw notFound('export parent not found')
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

    const result = await readPage(ctx, section, scope, cursor)
    const rows: OrgExportRow[] = []
    for (const doc of result.page) {
      const row = exportRow(doc, section)
      if (await hasOwnedEndpoint(ctx, section, row, orgId)) rows.push(row)
    }
    return { rows, continueCursor: result.continueCursor, isDone: result.isDone }
  },
})

/* The operator console's organization table and platform totals
 * (src/admin/views/Orgs.tsx and Dashboard.tsx), the ports of
 * admin_list_orgs (LAST def 0086:11-48) and admin_platform_stats (LAST def
 * 0078:583-614).
 *
 * Both are platform actions that page through the data with bounded
 * internal queries. Each runQuery is its own transaction, so no read grows
 * with the deployment. A page reads at most its STATS_PAGE rows and
 * STATS_PAGE.bytes of its range, plus the members, grants, milestones or
 * links of each team, project or task on it. The answer is built from many snapshots, so a write during a
 * load can be counted in one table and not yet in another. The console
 * loads on demand and shows when, so that is accepted.
 *
 * A load reads every row it counts, about one round trip per page,
 * CONCURRENCY organizations or tables at a time. One organization's pages
 * follow each other, so its largest table sets the time. Convex caches each
 * page's result until a row in its range changes, so a repeat load re-reads
 * only the pages whose data changed. If a load ever takes more than about
 * 30 seconds, keep the numbers in a table that a periodic job refreshes
 * instead.
 *
 * org_approx_bytes and pg_database_size have no Convex analogue. The port
 * sums JSON.stringify(doc).length over the table set the SQL measured,
 * which was already approximate ("index/TOAST overhead excluded"). The set
 * also holds each organization's org_counters row and the copies of those
 * tables that Deleted items keeps in deleted_rows. */

import { v } from 'convex/values'
import { literals } from 'convex-helpers/validators'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import type { ActionCtx } from './_generated/server'
import { internalQuery } from './_generated/server'
import { subscriptionFor } from './lib/billingAccess'
import { byId } from './lib/db'
import type { StoredTable } from './lib/enums'
import { platformAction } from './lib/functions'
import { countersRow } from './model/orgs'

const DAY = 86_400_000

/** Rows per internal page, and the bytes one page's range may read. Tests
 * lower them. */
export const STATS_PAGE = {
  /** Organization ids per page. */
  orgs: 500,
  /** An organization's profiles, activity or Deleted items rows per page.
   * They read nothing per row. */
  rows: 2000,
  /** Tasks per page, each with one read of the links it is the source of. */
  issues: 500,
  /** Teams per page, each with one read of its members. */
  teams: 200,
  /** Projects per page, each with three reads: grants, team grants and
   * milestones. */
  projects: 200,
  /** Rows per page of one table for the platform totals. */
  table: 4000,
  /** Bytes the paged range of one page may read. */
  bytes: 8 * 1024 * 1024,
}

/** Organizations, or tables, read at the same time. */
const CONCURRENCY = 8

const sizeOf = (doc: unknown): number => JSON.stringify(doc).length

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/* The stored tables whose live rows the estimate measures. Deleted items
 * also stores comments, labels, follows and attachments, which the estimate
 * never counted live, so their stored copies stay out too. */
const MEASURED_STORED: ReadonlySet<StoredTable> = new Set<StoredTable>([
  'issues',
  'issue_links',
  'projects',
  'milestones',
  'project_access',
  'project_team_access',
])

const storedBytes = (row: Doc<'deleted_rows'>): number =>
  MEASURED_STORED.has(row.table) ? sizeOf(row) : 0

/** Where the next page starts, or null after the last page. */
const nextOf = (page: { isDone: boolean; continueCursor: string }): string | null =>
  page.isDone ? null : page.continueCursor

/** Runs `fn` over `items`, CONCURRENCY at a time, with results in input
 * order. */
async function inParallel<I, R>(items: readonly I[], fn: (item: I) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
  return results
}

/* ------------------------------------------------------------------ listOrgs */

export type AdminOrgRow = {
  id: string
  name: string
  created_at: string
  plan: string | null
  seats: number | null
  renewal_date: string | null
  member_count: number
  guest_count: number
  login_count: number
  team_count: number
  project_count: number
  issue_count: number
  last_activity: string | null
  approx_bytes: number
}

const vCursor = v.union(v.string(), v.null())

type OrgIdsPage = { ids: string[]; next: string | null }

/** One page of organization ids, in creation order. */
export const orgIds = internalQuery({
  args: { cursor: vCursor },
  handler: async (ctx, { cursor }): Promise<OrgIdsPage> => {
    const page = await ctx.db.query('organizations').paginate({
      cursor,
      numItems: STATS_PAGE.orgs,
      maximumBytesRead: STATS_PAGE.bytes,
    })
    return { ids: page.page.map((org) => org.id), next: nextOf(page) }
  },
})

type OrgHead = Pick<
  AdminOrgRow,
  'id' | 'name' | 'created_at' | 'plan' | 'seats' | 'renewal_date' | 'last_activity'
> & { bytes: number }

/** An organization's own fields, billing and newest activity, or null once
 * it is gone. `bytes` covers its organizations and org_counters rows. */
export const orgHead = internalQuery({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<OrgHead | null> => {
    const org = await byId(ctx, 'organizations', org_id)
    if (org === null) return null
    const subscription = await subscriptionFor(ctx, org.id)
    const plan = subscription ? await byId(ctx, 'billing_plans', subscription.plan_id) : null
    const counters = await countersRow(ctx, org.id)
    const newest = await ctx.db
      .query('activity_events')
      .withIndex('by_org_ts', (q) => q.eq('org_id', org.id))
      .order('desc')
      .first()
    return {
      id: org.id,
      name: org.name,
      created_at: org.created_at,
      plan: plan?.name ?? org.billing?.plan ?? null,
      seats: subscription?.billed_seats ?? org.billing?.seats ?? null,
      renewal_date:
        subscription?.current_period_end?.slice(0, 10) ?? org.billing?.renewal_date ?? null,
      last_activity: newest?.ts ?? null,
      bytes: sizeOf(org) + (counters === null ? 0 : sizeOf(counters)),
    }
  },
})

const ORG_PARTS = ['profiles', 'teams', 'projects', 'issues', 'activity', 'deleted'] as const
type OrgPart = (typeof ORG_PARTS)[number]

/** Counts of one part of an organization. `rows` counts the part's own
 * table; members, guests and logins come from profiles alone. */
type PartCounts = { rows: number; bytes: number; members: number; guests: number; logins: number }
type PartPage = PartCounts & { next: string | null }

/** One page of one part of an organization: its profiles, teams with their
 * members, projects with their grants, team grants and milestones, tasks
 * with the links they are the source of, activity, or Deleted items rows. */
export const orgPart = internalQuery({
  args: { org_id: v.string(), part: literals(...ORG_PARTS), cursor: vCursor },
  handler: async (ctx, { org_id, part, cursor }): Promise<PartPage> => {
    const opts = (numItems: number) => ({ cursor, numItems, maximumBytesRead: STATS_PAGE.bytes })
    const counts: PartCounts = { rows: 0, bytes: 0, members: 0, guests: 0, logins: 0 }
    const done = (page: { page: unknown[]; isDone: boolean; continueCursor: string }) => ({
      ...counts,
      rows: page.page.length,
      next: nextOf(page),
    })
    switch (part) {
      case 'profiles': {
        const page = await ctx.db
          .query('profiles')
          .withIndex('by_org', (q) => q.eq('org_id', org_id))
          .paginate(opts(STATS_PAGE.rows))
        for (const p of page.page) {
          counts.bytes += sizeOf(p)
          // the 0086 split: guests hold a profile but no seat, counted apart
          if (p.org_role === 'guest') counts.guests += 1
          else counts.members += 1
          if (p.auth_user_id !== undefined) counts.logins += 1
        }
        return done(page)
      }
      case 'teams': {
        const page = await ctx.db
          .query('teams')
          .withIndex('by_org', (q) => q.eq('org_id', org_id))
          .paginate(opts(STATS_PAGE.teams))
        for (const team of page.page) {
          counts.bytes += sizeOf(team)
          const members = await ctx.db
            .query('team_members')
            .withIndex('by_team', (q) => q.eq('team_id', team.id))
            .collect()
          for (const row of members) counts.bytes += sizeOf(row)
        }
        return done(page)
      }
      case 'projects': {
        const page = await ctx.db
          .query('projects')
          .withIndex('by_org', (q) => q.eq('org_id', org_id))
          .paginate(opts(STATS_PAGE.projects))
        for (const project of page.page) {
          counts.bytes += sizeOf(project)
          const grants = await ctx.db
            .query('project_access')
            .withIndex('by_project', (q) => q.eq('project_id', project.id))
            .collect()
          const teamGrants = await ctx.db
            .query('project_team_access')
            .withIndex('by_project', (q) => q.eq('project_id', project.id))
            .collect()
          const milestones = await ctx.db
            .query('milestones')
            .withIndex('by_project', (q) => q.eq('project_id', project.id))
            .collect()
          for (const row of [...grants, ...teamGrants, ...milestones]) counts.bytes += sizeOf(row)
        }
        return done(page)
      }
      case 'issues': {
        const page = await ctx.db
          .query('issues')
          .withIndex('by_org', (q) => q.eq('org_id', org_id))
          .paginate(opts(STATS_PAGE.issues))
        // each link once, through its source task
        const links = await Promise.all(
          page.page.map((issue) =>
            ctx.db
              .query('issue_links')
              .withIndex('by_source', (q) => q.eq('source_id', issue.id))
              .collect(),
          ),
        )
        for (const issue of page.page) counts.bytes += sizeOf(issue)
        for (const row of links.flat()) counts.bytes += sizeOf(row)
        return done(page)
      }
      case 'activity': {
        const page = await ctx.db
          .query('activity_events')
          .withIndex('by_org_ts', (q) => q.eq('org_id', org_id))
          .paginate(opts(STATS_PAGE.rows))
        for (const row of page.page) counts.bytes += sizeOf(row)
        return done(page)
      }
      case 'deleted': {
        const page = await ctx.db
          .query('deleted_rows')
          .withIndex('by_org', (q) => q.eq('org_id', org_id))
          .paginate(opts(STATS_PAGE.rows))
        for (const row of page.page) counts.bytes += storedBytes(row)
        return done(page)
      }
    }
  },
})

type Runner = Pick<ActionCtx, 'runQuery'>

/** Every page of one part of an organization, summed. */
async function partCounts(ctx: Runner, org_id: string, part: OrgPart): Promise<PartCounts> {
  const sum: PartCounts = { rows: 0, bytes: 0, members: 0, guests: 0, logins: 0 }
  let cursor: string | null = null
  do {
    const page: PartPage = await ctx.runQuery(internal.adminStats.orgPart, {
      org_id,
      part,
      cursor,
    })
    sum.rows += page.rows
    sum.bytes += page.bytes
    sum.members += page.members
    sum.guests += page.guests
    sum.logins += page.logins
    cursor = page.next
  } while (cursor !== null)
  return sum
}

/** One organization's row, or null when it is gone. */
async function orgRow(ctx: Runner, org_id: string): Promise<AdminOrgRow | null> {
  const head: OrgHead | null = await ctx.runQuery(internal.adminStats.orgHead, { org_id })
  if (head === null) return null
  const profiles = await partCounts(ctx, org_id, 'profiles')
  const teams = await partCounts(ctx, org_id, 'teams')
  const projects = await partCounts(ctx, org_id, 'projects')
  const issues = await partCounts(ctx, org_id, 'issues')
  const activity = await partCounts(ctx, org_id, 'activity')
  const deleted = await partCounts(ctx, org_id, 'deleted')
  let bytes = head.bytes
  for (const part of [profiles, teams, projects, issues, activity, deleted]) bytes += part.bytes
  return {
    id: head.id,
    name: head.name,
    created_at: head.created_at,
    plan: head.plan,
    seats: head.seats,
    renewal_date: head.renewal_date,
    member_count: profiles.members,
    guest_count: profiles.guests,
    login_count: profiles.logins,
    team_count: teams.rows,
    project_count: projects.rows,
    issue_count: issues.rows,
    last_activity: head.last_activity,
    approx_bytes: bytes,
  }
}

/** listOrgs' answer, read through `ctx.runQuery`: a row for every
 * organization that is still there when its turn comes, ordered by
 * created_at. Exported for tests that change data between its reads. */
export async function orgRows(ctx: Runner): Promise<AdminOrgRow[]> {
  const ids: string[] = []
  let cursor: string | null = null
  do {
    const page: OrgIdsPage = await ctx.runQuery(internal.adminStats.orgIds, { cursor })
    ids.push(...page.ids)
    cursor = page.next
  } while (cursor !== null)
  const rows = await inParallel(ids, (id) => orgRow(ctx, id))
  return rows
    .filter((row): row is AdminOrgRow => row !== null)
    .sort((a, b) => cmp(a.created_at, b.created_at) || cmp(a.id, b.id))
}

/* admin_list_orgs: every organization's row, its footprint over the
 * measured tables, ordered by created_at. */
export const listOrgs = platformAction({
  args: {},
  handler: async (ctx): Promise<AdminOrgRow[]> => await orgRows(ctx),
})

/* ------------------------------------------------------------- platformStats */

export type AdminPlatformStats = {
  totals: {
    orgs: number
    members: number
    logins: number
    teams: number
    projects: number
    issues: number
    activity_30d: number
    db_total_bytes: number
  }
  weekly: Array<{ week: string; new_members: number; activity: number }>
}

type Week = AdminPlatformStats['weekly'][number]

/* The tables platformStats reads, the measured set of listOrgs across the
 * deployment. */
const TOTAL_TABLES = [
  'organizations',
  'profiles',
  'teams',
  'projects',
  'issues',
  'activity_events',
  'team_members',
  'project_access',
  'project_team_access',
  'issue_links',
  'milestones',
  'org_counters',
  'deleted_rows',
] as const
type TotalTable = (typeof TOTAL_TABLES)[number]

/** Counts of one table. logins come from profiles, activity_30d from
 * activity_events, and weekly from both. */
type TableCounts = {
  rows: number
  bytes: number
  logins: number
  activity_30d: number
  weekly: Week[]
}
type TablePage = TableCounts & { next: string | null }

/* Monday of the ISO week holding `iso`, as YYYY-MM-DD (UTC), the SQL's
 * date_trunc('week', …)::date. */
const weekMonday = (iso: string): string => {
  const d = new Date(iso)
  const monday = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - ((d.getUTCDay() + 6) % 7),
  )
  return new Date(monday).toISOString().slice(0, 10)
}

/** Week buckets keyed by their Monday. */
class Weeks {
  private readonly byWeek = new Map<string, Week>()

  /** Adds `n` to one count of the week starting on Monday `week`. */
  add(week: string, field: 'new_members' | 'activity', n = 1): void {
    let bucket = this.byWeek.get(week)
    if (bucket === undefined) {
      bucket = { week, new_members: 0, activity: 0 }
      this.byWeek.set(week, bucket)
    }
    bucket[field] += n
  }

  /** Adds another list of buckets. */
  merge(weeks: readonly Week[]): void {
    for (const w of weeks) {
      this.add(w.week, 'new_members', w.new_members)
      this.add(w.week, 'activity', w.activity)
    }
  }

  /** The buckets in ascending week order. */
  list(): Week[] {
    return [...this.byWeek.values()].sort((a, b) => cmp(a.week, b.week))
  }
}

/** One page of one table for the platform totals. Profiles created and
 * activity recorded after `cutoff84` land in week buckets. */
export const tablePage = internalQuery({
  args: {
    table: literals(...TOTAL_TABLES),
    cursor: vCursor,
    cutoff30: v.string(),
    cutoff84: v.string(),
  },
  handler: async (ctx, { table, cursor, cutoff30, cutoff84 }): Promise<TablePage> => {
    const opts = { cursor, numItems: STATS_PAGE.table, maximumBytesRead: STATS_PAGE.bytes }
    const counts: TableCounts = { rows: 0, bytes: 0, logins: 0, activity_30d: 0, weekly: [] }
    const weeks = new Weeks()
    let page: { page: unknown[]; isDone: boolean; continueCursor: string }
    if (table === 'profiles') {
      const profiles = await ctx.db.query('profiles').paginate(opts)
      for (const p of profiles.page) {
        counts.bytes += sizeOf(p)
        if (p.auth_user_id !== undefined) counts.logins += 1
        if (p.created_at > cutoff84) weeks.add(weekMonday(p.created_at), 'new_members')
      }
      page = profiles
    } else if (table === 'activity_events') {
      const activity = await ctx.db.query('activity_events').paginate(opts)
      for (const a of activity.page) {
        counts.bytes += sizeOf(a)
        if (a.ts > cutoff30) counts.activity_30d += 1
        if (a.ts > cutoff84) weeks.add(weekMonday(a.ts), 'activity')
      }
      page = activity
    } else if (table === 'deleted_rows') {
      const stored = await ctx.db.query('deleted_rows').paginate(opts)
      for (const row of stored.page) counts.bytes += storedBytes(row)
      page = stored
    } else {
      page = await ctx.db.query(table).paginate(opts)
      for (const row of page.page) counts.bytes += sizeOf(row)
    }
    return { ...counts, rows: page.page.length, weekly: weeks.list(), next: nextOf(page) }
  },
})

/** Every page of one table, summed. */
async function tableCounts(
  ctx: Runner,
  table: TotalTable,
  cutoff30: string,
  cutoff84: string,
): Promise<TableCounts> {
  const sum = { rows: 0, bytes: 0, logins: 0, activity_30d: 0 }
  const weeks = new Weeks()
  let cursor: string | null = null
  do {
    const page: TablePage = await ctx.runQuery(internal.adminStats.tablePage, {
      table,
      cursor,
      cutoff30,
      cutoff84,
    })
    sum.rows += page.rows
    sum.bytes += page.bytes
    sum.logins += page.logins
    sum.activity_30d += page.activity_30d
    weeks.merge(page.weekly)
    cursor = page.next
  } while (cursor !== null)
  return { ...sum, weekly: weeks.list() }
}

/* admin_platform_stats. totals.members counts EVERY profile (guests and
 * agents included, as the SQL did). weekly merges profile created_at counts
 * with activity counts over the last 84 days into sparse week-Monday
 * buckets, ascending. The SQL aggregated actual rows, so a week with
 * neither members nor activity is absent, exactly as before.
 * db_total_bytes was pg_database_size(current_database()). The port sums
 * the JSON footprint of every row in the measured tables, so the dashboard
 * tile says the size is approximate. */
export const platformStats = platformAction({
  args: {},
  handler: async (ctx): Promise<AdminPlatformStats> => {
    const nowMs = Date.now()
    const cutoff30 = new Date(nowMs - 30 * DAY).toISOString()
    const cutoff84 = new Date(nowMs - 84 * DAY).toISOString()
    const tables = await inParallel(TOTAL_TABLES, (table) =>
      tableCounts(ctx, table, cutoff30, cutoff84),
    )
    const of = (table: TotalTable): TableCounts => tables[TOTAL_TABLES.indexOf(table)]
    const weeks = new Weeks()
    let bytes = 0
    for (const counts of tables) {
      bytes += counts.bytes
      weeks.merge(counts.weekly)
    }
    return {
      totals: {
        orgs: of('organizations').rows,
        members: of('profiles').rows,
        logins: of('profiles').logins,
        teams: of('teams').rows,
        projects: of('projects').rows,
        issues: of('issues').rows,
        activity_30d: of('activity_events').activity_30d,
        db_total_bytes: bytes,
      },
      weekly: weeks.list(),
    }
  },
})

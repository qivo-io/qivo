/* The operator console's organization table, platform totals and
 * organization names (src/admin/views/Orgs.tsx, Dashboard.tsx and
 * Audit.tsx). The first two port admin_list_orgs (LAST def 0086:11-48) and
 * admin_platform_stats (LAST def 0078:583-614).
 *
 * All three are platform actions that page through the data with bounded
 * internal queries. Each runQuery is its own transaction, so no read grows
 * with the deployment. A page reads at most its STATS_PAGE rows and
 * STATS_PAGE.bytes of its range. It also reads up to one more than
 * STATS_PAGE.children members, grants, milestones or links of each team,
 * project or task on it, and pages a longer list on its own (childPage).
 * The answer is built from many snapshots, so a write during a load can be
 * counted in one table and not yet in another. The console loads on demand
 * and shows when, so that is accepted.
 *
 * A load reads every row it counts, about one round trip per page,
 * CONCURRENCY organizations or tables at a time. One organization's pages
 * follow each other, so its largest table sets the time. Convex caches each
 * page's result for the same arguments until a row in its range changes, so
 * a repeat load re-reads only the pages whose data changed. The totals'
 * 30-day and 84-day windows start on the hour for that reason, so reloads
 * within an hour reuse those pages too. If a load ever takes more than about
 * 30 seconds, keep the numbers in a table that a periodic job refreshes
 * instead.
 *
 * org_approx_bytes and pg_database_size have no Convex analogue. The port
 * sums JSON.stringify(doc).length over the table set the SQL measured,
 * which was already approximate ("index/TOAST overhead excluded"). The set
 * also holds each organization's org_counters row, the Team sync stamps
 * that moved off the profiles into sync_stamps, and the copies of those
 * tables that Deleted items keeps in deleted_rows. */

import { type Infer, v } from 'convex/values'
import { literals } from 'convex-helpers/validators'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import type { ActionCtx, QueryCtx } from './_generated/server'
import { internalQuery } from './_generated/server'
import { subscriptionFor } from './lib/billingAccess'
import { byId } from './lib/db'
import type { StoredTable } from './lib/enums'
import { badRequest, platformAction, require } from './lib/functions'
import { countersRow } from './model/orgs'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Rows per internal page, and the bytes one page's range may read. Tests
 * lower them. */
export const STATS_PAGE = {
  /** Organizations per page. */
  orgs: 500,
  /** An organization's profiles, activity or Deleted items rows per page.
   * They read nothing per row. */
  rows: 2000,
  /** Rows of one child table read per team, project or task on a page. A
   * parent with more is left out of the page and its rows are paged on
   * their own, so the page sizes below keep a page under about 16,000
   * documents. */
  children: 50,
  /** Tasks per page, each with one read of the links it is the source of. */
  issues: 300,
  /** Teams per page, each with one read of its members. */
  teams: 200,
  /** Projects per page, each with three reads: grants, team grants and
   * milestones. */
  projects: 100,
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
export const nextOf = (page: { isDone: boolean; continueCursor: string }): string | null =>
  page.isDone ? null : page.continueCursor

/** Runs `fn` over `items`, CONCURRENCY at a time, with results in input
 * order. */
export async function inParallel<I, R>(
  items: readonly I[],
  fn: (item: I) => Promise<R>,
): Promise<R[]> {
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

export type AdminOrgName = { id: string; name: string }

type OrgPage = { orgs: AdminOrgName[]; next: string | null }

/** One page of organization ids and names, in creation order. */
export const orgPage = internalQuery({
  args: { cursor: vCursor },
  handler: async (ctx, { cursor }): Promise<OrgPage> => {
    const page = await ctx.db.query('organizations').paginate({
      cursor,
      numItems: STATS_PAGE.orgs,
      maximumBytesRead: STATS_PAGE.bytes,
    })
    return { orgs: page.page.map(({ id, name }) => ({ id, name })), next: nextOf(page) }
  },
})

type OrgHead = Pick<
  AdminOrgRow,
  'id' | 'name' | 'created_at' | 'plan' | 'seats' | 'renewal_date' | 'last_activity'
> & { bytes: number }

/** An organization's own fields, billing and newest activity, or null once
 * it is gone. `bytes` covers its organizations and org_counters rows and its
 * sync_stamps rows, one small row per stamped person. */
export const orgHead = internalQuery({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<OrgHead | null> => {
    const org = await byId(ctx, 'organizations', org_id)
    if (org === null) return null
    const subscription = await subscriptionFor(ctx, org.id)
    const plan = subscription ? await byId(ctx, 'billing_plans', subscription.plan_id) : null
    const counters = await countersRow(ctx, org.id)
    const stamps = await ctx.db
      .query('sync_stamps')
      .withIndex('by_org', (q) => q.eq('org_id', org.id))
      .collect()
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
      bytes:
        sizeOf(org) +
        (counters === null ? 0 : sizeOf(counters)) +
        stamps.reduce((sum, row) => sum + sizeOf(row), 0),
    }
  },
})

/* The rows that belong to one team, project or task, each table read
 * through the index on its parent. */
const CHILD_TABLES = [
  'team_members',
  'project_access',
  'project_team_access',
  'milestones',
  'issue_links',
] as const
type ChildRange = { table: (typeof CHILD_TABLES)[number]; parent_id: string }

/** The rows of one child range: a team's members, a project's grants,
 * team grants or milestones, or the links a task is the source of. Each link
 * is read once, through its source task. */
function childQuery(ctx: QueryCtx, { table, parent_id }: ChildRange) {
  switch (table) {
    case 'team_members':
      return ctx.db.query(table).withIndex('by_team', (q) => q.eq('team_id', parent_id))
    case 'project_access':
    case 'project_team_access':
    case 'milestones':
      return ctx.db.query(table).withIndex('by_project', (q) => q.eq('project_id', parent_id))
    case 'issue_links':
      return ctx.db.query(table).withIndex('by_source', (q) => q.eq('source_id', parent_id))
  }
}

type ChildPage = { bytes: number; next: string | null }

/** One page of a child range too long for its parent's page. */
export const childPage = internalQuery({
  args: { table: literals(...CHILD_TABLES), parent_id: v.string(), cursor: vCursor },
  handler: async (ctx, { table, parent_id, cursor }): Promise<ChildPage> => {
    const page = await childQuery(ctx, { table, parent_id }).paginate({
      cursor,
      numItems: STATS_PAGE.rows,
      maximumBytesRead: STATS_PAGE.bytes,
    })
    let bytes = 0
    for (const row of page.page) bytes += sizeOf(row)
    return { bytes, next: nextOf(page) }
  },
})

const ORG_PARTS = ['profiles', 'teams', 'projects', 'issues', 'activity', 'deleted'] as const
type OrgPart = (typeof ORG_PARTS)[number]

/** Counts of one part of an organization. `rows` counts the part's own
 * table; members, guests and logins come from profiles alone. */
type PartCounts = { rows: number; bytes: number; members: number; guests: number; logins: number }
/** A page also names the child ranges it left out for being longer than
 * STATS_PAGE.children rows. */
type PartPage = PartCounts & { deferred: ChildRange[]; next: string | null }

/** One page of one part of an organization: its profiles, teams with their
 * members, projects with their grants, team grants and milestones, tasks
 * with the links they are the source of, activity, or Deleted items rows. */
export const orgPart = internalQuery({
  args: { org_id: v.string(), part: literals(...ORG_PARTS), cursor: vCursor },
  handler: async (ctx, { org_id, part, cursor }): Promise<PartPage> => {
    const opts = (numItems: number) => ({ cursor, numItems, maximumBytesRead: STATS_PAGE.bytes })
    const counts: PartCounts = { rows: 0, bytes: 0, members: 0, guests: 0, logins: 0 }
    const deferred: ChildRange[] = []
    const done = (page: { page: unknown[]; isDone: boolean; continueCursor: string }) => ({
      ...counts,
      rows: page.page.length,
      deferred,
      next: nextOf(page),
    })
    // Counts a child range of at most STATS_PAGE.children rows, and leaves a
    // longer one to childPage.
    const children = async (range: ChildRange) => {
      const rows = await childQuery(ctx, range).take(STATS_PAGE.children + 1)
      if (rows.length > STATS_PAGE.children) deferred.push(range)
      else for (const row of rows) counts.bytes += sizeOf(row)
    }
    switch (part) {
      case 'profiles': {
        const page = await ctx.db
          .query('profiles')
          .withIndex('by_org', (q) => q.eq('org_id', org_id))
          .paginate(opts(STATS_PAGE.rows))
        for (const p of page.page) {
          counts.bytes += sizeOf(p)
          // The 0086 split counts guests apart, as they hold a profile but no seat.
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
          await children({ table: 'team_members', parent_id: team.id })
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
          for (const table of ['project_access', 'project_team_access', 'milestones'] as const)
            await children({ table, parent_id: project.id })
        }
        return done(page)
      }
      case 'issues': {
        const page = await ctx.db
          .query('issues')
          .withIndex('by_org', (q) => q.eq('org_id', org_id))
          .paginate(opts(STATS_PAGE.issues))
        for (const issue of page.page) counts.bytes += sizeOf(issue)
        // concurrent, as one read per task is most of a page's time
        await Promise.all(
          page.page.map((issue) => children({ table: 'issue_links', parent_id: issue.id })),
        )
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

/** What a platform action needs to read through internal queries. */
export type Runner = Pick<ActionCtx, 'runQuery'>

/** Every page of one part of an organization, with the child ranges its
 * pages left out, summed. */
async function partCounts(ctx: Runner, org_id: string, part: OrgPart): Promise<PartCounts> {
  const sum: PartCounts = { rows: 0, bytes: 0, members: 0, guests: 0, logins: 0 }
  const deferred: ChildRange[] = []
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
    deferred.push(...page.deferred)
    cursor = page.next
  } while (cursor !== null)
  for (const range of deferred) {
    let childCursor: string | null = null
    do {
      const page: ChildPage = await ctx.runQuery(internal.adminStats.childPage, {
        ...range,
        cursor: childCursor,
      })
      sum.bytes += page.bytes
      childCursor = page.next
    } while (childCursor !== null)
  }
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

/** Every organization's id and name, page by page, in creation order. */
export async function allOrgs(ctx: Runner): Promise<AdminOrgName[]> {
  const orgs: AdminOrgName[] = []
  let cursor: string | null = null
  do {
    const page: OrgPage = await ctx.runQuery(internal.adminStats.orgPage, { cursor })
    orgs.push(...page.orgs)
    cursor = page.next
  } while (cursor !== null)
  return orgs
}

/** Builds listOrgs' answer through `ctx.runQuery`. It holds a row for every
 * organization still there when its turn comes, ordered by created_at.
 * Exported for tests that change data between its reads. */
export async function orgRows(ctx: Runner): Promise<AdminOrgRow[]> {
  const orgs = await allOrgs(ctx)
  const rows = await inParallel(orgs, (org) => orgRow(ctx, org.id))
  return rows
    .filter((row): row is AdminOrgRow => row !== null)
    .sort((a, b) => cmp(a.created_at, b.created_at) || cmp(a.id, b.id))
}

/* admin_list_orgs. Every organization's row with its footprint over the
 * measured tables, ordered by created_at. */
export const listOrgs = platformAction({
  args: {},
  handler: async (ctx): Promise<AdminOrgRow[]> => await orgRows(ctx),
})

/* ------------------------------------------------------------------ orgNames */

/* Every organization's id and name, without the counts listOrgs reads, for
 * the audit page's labels and organization filter. */
export const orgNames = platformAction({
  args: {},
  handler: async (ctx): Promise<AdminOrgName[]> => await allOrgs(ctx),
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
  'sync_stamps',
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

const vWindow = v.object({ cutoff30: v.string(), cutoff84: v.string() })
type Window = Infer<typeof vWindow>

/* The tables whose pages count rows by time. Only their pages get the
 * window, so the other tables' pages keep the same arguments from load to
 * load and Convex can answer them from its cache. */
const WINDOWED: ReadonlySet<TotalTable> = new Set<TotalTable>(['profiles', 'activity_events'])

/** One page of one table for the platform totals. Profiles created and
 * activity recorded after `window.cutoff84` land in week buckets; profiles
 * and activity_events pages need the window. */
export const tablePage = internalQuery({
  args: { table: literals(...TOTAL_TABLES), cursor: vCursor, window: v.optional(vWindow) },
  handler: async (ctx, { table, cursor, window }): Promise<TablePage> => {
    require(window !== undefined || !WINDOWED.has(table), badRequest(
      `a ${table} page needs the time window`,
    ))
    const { cutoff30, cutoff84 } = window ?? { cutoff30: '', cutoff84: '' }
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
async function tableCounts(ctx: Runner, table: TotalTable, window: Window): Promise<TableCounts> {
  const sum = { rows: 0, bytes: 0, logins: 0, activity_30d: 0 }
  const weeks = new Weeks()
  let cursor: string | null = null
  do {
    const page: TablePage = await ctx.runQuery(internal.adminStats.tablePage, {
      table,
      cursor,
      ...(WINDOWED.has(table) ? { window } : {}),
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

/** platformStats' answer, read through `ctx.runQuery`. The 30-day and
 * 84-day windows start on the hour, so loads within one hour send the same
 * page arguments. Exported for tests that read those arguments. */
export async function platformTotals(ctx: Runner): Promise<AdminPlatformStats> {
  const hour = Math.floor(Date.now() / HOUR) * HOUR
  const window: Window = {
    cutoff30: new Date(hour - 30 * DAY).toISOString(),
    cutoff84: new Date(hour - 84 * DAY).toISOString(),
  }
  const tables = await inParallel(TOTAL_TABLES, (table) => tableCounts(ctx, table, window))
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
}

/* admin_platform_stats. totals.members counts EVERY profile (guests and
 * agents included, as the SQL did). weekly merges profile created_at counts
 * with activity counts over the last 84 days into sparse week-Monday
 * buckets, ascending. The SQL aggregated actual rows, so a week with
 * neither members nor activity is absent, exactly as before. Both windows
 * start on the hour (platformTotals), so activity_30d counts from up to an
 * hour more than 30 days ago. db_total_bytes was
 * pg_database_size(current_database()). The port sums the JSON footprint of
 * every row in the measured tables, so the dashboard tile says the size is
 * approximate. */
export const platformStats = platformAction({
  args: {},
  handler: async (ctx): Promise<AdminPlatformStats> => await platformTotals(ctx),
})

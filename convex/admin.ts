/* The platform-operator console's read/write surface — the admin_* RPC family
 * (0015/0078/0086/0096/0102) behind platformQuery/platformMutation (each call
 * re-checks the caller against platform_admins, exactly 0015's per-RPC gate).
 * Response shapes are matched FIELD-BY-FIELD to what src/admin/views/*
 * destructure, so the console rewire swaps transports without touching views.
 *
 * isOperator alone sits outside the platform wrappers ON PURPOSE: it is the
 * AdminGate's probe ("safe for any signed-in user to call", 0015:86) and must
 * answer false — never throw — for the anonymous and the merely-signed-in
 * caller alike; the gate treats a throw as denied too, but a clean false is
 * what keeps the smoke's no-console-errors check green.
 *
 * Two auth.users columns the SQL joined have no Better Auth twin:
 * - last_sign_in_at ≈ the newest session.createdAt for the login. Expired
 *   sessions vanish from the component, so a long-absent member honestly
 *   reads "—" — stated approximation, not a bug.
 * - banned_until keeps its WIRE NAME (isBanned() and both views read it) but
 *   is mapped from BA's { banned, banExpires }: not banned → null, banned
 *   with banExpires → its ISO, banned forever → a far-future sentinel.
 * Both lookups run against the component via ctx.runQuery and degrade to
 * null/'' when the login row is unreachable — the SQL's LEFT JOIN said the
 * same thing.
 *
 * org_approx_bytes/pg_database_size have no Convex analogue: the honest cheap
 * port sums JSON.stringify(doc).length over the same table set the SQL
 * measured — "index/TOAST overhead excluded" already made it approximate. */

import { v } from 'convex/values'
import { components } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, query } from './_generated/server'
import { markBillingMembershipChanged } from './lib/billableUsers'
import { subscriptionFor } from './lib/billingAccess'
import { byId } from './lib/db'
import { isDemoDeployment } from './lib/demo'
import type { OrgRole } from './lib/enums'
import {
  badRequest,
  notFound,
  platformMutation,
  platformQuery,
  require,
  rule,
} from './lib/functions'
import { allWordsMatcher } from './lib/search'
import { audit } from './model/admin'

const DAY = 86_400_000

/* banned with no banExpires — "the ban will never expire" (BA admin plugin).
 * Far-future so isBanned()'s `> Date.now()` reads it as banned forever. */
const BAN_NEVER_EXPIRES = '9999-12-31T00:00:00.000Z'

/* ------------------------------------------------------------ shared lookups */

type AuthColumns = { last_sign_in_at: string | null; banned_until: string | null }

const NO_AUTH_COLUMNS: AuthColumns = { last_sign_in_at: null, banned_until: null }

/* The two approximated auth.users columns for one Better Auth login. The
 * catch is the LEFT JOIN's null arm: a vanished or unreadable user row means
 * no auth columns, never a failed console view. */
async function authColumnsFor(ctx: QueryCtx, authUserId: string): Promise<AuthColumns> {
  try {
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: '_id', value: authUserId }],
    })) as { banned?: boolean | null; banExpires?: number | null } | null
    if (user === null) return NO_AUTH_COLUMNS
    let newestSession = 0
    let cursor: string | null = null
    for (;;) {
      const page = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: 'session',
        where: [{ field: 'userId', value: authUserId }],
        paginationOpts: { numItems: 200, cursor },
      })) as { page: Array<{ createdAt?: number }>; isDone: boolean; continueCursor: string }
      for (const s of page.page) {
        if (typeof s.createdAt === 'number' && s.createdAt > newestSession)
          newestSession = s.createdAt
      }
      if (page.isDone) break
      cursor = page.continueCursor
    }
    return {
      last_sign_in_at: newestSession > 0 ? new Date(newestSession).toISOString() : null,
      banned_until:
        user.banned !== true
          ? null
          : typeof user.banExpires === 'number'
            ? new Date(user.banExpires).toISOString()
            : BAN_NEVER_EXPIRES,
    }
  } catch {
    return NO_AUTH_COLUMNS
  }
}

/* One component round-trip per DISTINCT login across a profile list. */
async function authColumnsMap(
  ctx: QueryCtx,
  profiles: Array<Doc<'profiles'>>,
): Promise<Map<string, AuthColumns>> {
  const map = new Map<string, AuthColumns>()
  for (const p of profiles) {
    if (p.auth_user_id === undefined || map.has(p.auth_user_id)) continue
    map.set(p.auth_user_id, await authColumnsFor(ctx, p.auth_user_id))
  }
  return map
}

/* The actor half of every audit row — the SQL's
 * coalesce((select u.email from auth.users …), '') (0015:55). */
async function actorEmail(ctx: MutationCtx, authUserId: string): Promise<string> {
  try {
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: '_id', value: authUserId }],
    })) as { email?: string } | null
    return user?.email ?? ''
  } catch {
    return ''
  }
}

const sizeOf = (doc: unknown): number => JSON.stringify(doc).length

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/* ------------------------------------------------------------------ the gate */

/* public.is_platform_admin (0015:87-90) — the AdminGate's probe. A bare query
 * on purpose: fail-open false for anonymous and non-operator callers alike
 * (every real admin function below re-checks fail-closed in its wrapper, so
 * this gate is UX, not security). */
export const isOperator = query({
  args: {},
  handler: async (ctx): Promise<boolean> => {
    if (isDemoDeployment()) return false
    const identity = await ctx.auth.getUserIdentity()
    if (identity === null) return false
    const operator = await ctx.db
      .query('platform_admins')
      .withIndex('by_auth_user', (q) => q.eq('auth_user_id', identity.subject))
      .first()
    return operator !== null
  },
})

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

/* One org's fleet-table row + its approximate footprint, over the same table
 * set private.org_approx_bytes summed (0015:62-83): the org doc (billing
 * merged in), profiles, teams, team_members, projects, project_access,
 * issues, issue_links (counted once via their source issue), milestones,
 * activity_events. The activity collect doubles as the last_activity read
 * (by_org_ts is ascending, so the final row holds max ts). */
async function orgRow(ctx: QueryCtx, org: Doc<'organizations'>): Promise<AdminOrgRow> {
  const subscription = await subscriptionFor(ctx, org.id)
  const plan = subscription ? await byId(ctx, 'billing_plans', subscription.plan_id) : null
  const profiles = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()
  const teams = await ctx.db
    .query('teams')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()
  const projects = await ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()
  const issues = await ctx.db
    .query('issues')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()
  const activity = await ctx.db
    .query('activity_events')
    .withIndex('by_org_ts', (q) => q.eq('org_id', org.id))
    .collect()

  let bytes = sizeOf(org)
  for (const rows of [profiles, teams, projects, issues, activity]) {
    for (const row of rows) bytes += sizeOf(row)
  }
  for (const team of teams) {
    const members = await ctx.db
      .query('team_members')
      .withIndex('by_team', (q) => q.eq('team_id', team.id))
      .collect()
    for (const row of members) bytes += sizeOf(row)
  }
  for (const project of projects) {
    const grants = await ctx.db
      .query('project_access')
      .withIndex('by_project', (q) => q.eq('project_id', project.id))
      .collect()
    const milestones = await ctx.db
      .query('milestones')
      .withIndex('by_project', (q) => q.eq('project_id', project.id))
      .collect()
    for (const row of grants) bytes += sizeOf(row)
    const teamGrants = await ctx.db
      .query('project_team_access')
      .withIndex('by_project', (q) => q.eq('project_id', project.id))
      .collect()
    for (const row of teamGrants) bytes += sizeOf(row)
    for (const row of milestones) bytes += sizeOf(row)
  }
  for (const issue of issues) {
    const links = await ctx.db
      .query('issue_links')
      .withIndex('by_source', (q) => q.eq('source_id', issue.id))
      .collect()
    for (const row of links) bytes += sizeOf(row)
  }

  return {
    id: org.id,
    name: org.name,
    created_at: org.created_at,
    plan: plan?.name ?? org.billing?.plan ?? null,
    seats: subscription?.billed_seats ?? org.billing?.seats ?? null,
    renewal_date:
      subscription?.current_period_end?.slice(0, 10) ?? org.billing?.renewal_date ?? null,
    /* the 0086 split: guests hold a profile but no seat — counted apart */
    member_count: profiles.filter((p) => p.org_role !== 'guest').length,
    guest_count: profiles.filter((p) => p.org_role === 'guest').length,
    login_count: profiles.filter((p) => p.auth_user_id !== undefined).length,
    team_count: teams.length,
    project_count: projects.length,
    issue_count: issues.length,
    last_activity: activity.length > 0 ? activity[activity.length - 1].ts : null,
    approx_bytes: bytes,
  }
}

/* admin_list_orgs (LAST def 0086:11-48), ordered by created_at. */
export const listOrgs = platformQuery({
  args: {},
  handler: async (ctx): Promise<AdminOrgRow[]> => {
    const orgs = await ctx.db.query('organizations').withIndex('by_uuid').collect()
    orgs.sort((a, b) => cmp(a.created_at, b.created_at))
    const rows: AdminOrgRow[] = []
    for (const org of orgs) rows.push(await orgRow(ctx, org))
    return rows
  },
})

/* ----------------------------------------------------------------- orgDetail */

export type AdminMemberRow = {
  profile_id: string
  name: string
  email: string | null
  org_role: OrgRole
  has_login: boolean
  last_sign_in_at: string | null
  banned_until: string | null
  created_at: string
}

export type AdminOrgDetail = {
  org: { id: string; name: string; created_at: string }
  billing: { plan: string; seats: number; renewal_date: string | null } | null
  members: AdminMemberRow[]
  teams: Array<{ id: string; name: string; member_count: number; project_count: number }>
}

/* admin_org_detail (LAST def 0096:377-418): members and teams each ordered by
 * name; the missing org throws the SQL's sentence. */
export const orgDetail = platformQuery({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<AdminOrgDetail> => {
    const org = await byId(ctx, 'organizations', org_id)
    require(org !== null, notFound('organization not found'))
    const subscription = await subscriptionFor(ctx, org.id)
    const plan = subscription ? await byId(ctx, 'billing_plans', subscription.plan_id) : null

    const profiles = await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', org.id))
      .collect()
    profiles.sort((a, b) => cmp(a.name, b.name))
    const authColumns = await authColumnsMap(ctx, profiles)
    const members = profiles.map((p): AdminMemberRow => {
      const cols = p.auth_user_id !== undefined ? authColumns.get(p.auth_user_id) : undefined
      return {
        profile_id: p.id,
        name: p.name,
        email: p.email ?? null,
        org_role: p.org_role,
        has_login: p.auth_user_id !== undefined,
        last_sign_in_at: cols?.last_sign_in_at ?? null,
        banned_until: cols?.banned_until ?? null,
        created_at: p.created_at,
      }
    })

    const teamDocs = await ctx.db
      .query('teams')
      .withIndex('by_org', (q) => q.eq('org_id', org.id))
      .collect()
    teamDocs.sort((a, b) => cmp(a.name, b.name))
    const teams: AdminOrgDetail['teams'] = []
    for (const team of teamDocs) {
      const members_ = await ctx.db
        .query('team_members')
        .withIndex('by_team', (q) => q.eq('team_id', team.id))
        .collect()
      const projects = await ctx.db
        .query('projects')
        .withIndex('by_team', (q) => q.eq('team_id', team.id))
        .collect()
      teams.push({
        id: team.id,
        name: team.name,
        member_count: members_.length,
        project_count: projects.length,
      })
    }

    return {
      org: { id: org.id, name: org.name, created_at: org.created_at },
      billing:
        subscription && plan
          ? {
              plan: plan.name,
              seats: subscription.billed_seats,
              renewal_date: subscription.current_period_end?.slice(0, 10) ?? null,
            }
          : org.billing !== undefined
            ? {
                plan: org.billing.plan,
                seats: org.billing.seats,
                renewal_date: org.billing.renewal_date,
              }
            : null,
      members,
      teams,
    }
  },
})

/* ----------------------------------------------------------------- listUsers */

export type AdminUserRow = {
  profile_id: string
  name: string
  email: string | null
  org_id: string
  org_name: string
  org_role: OrgRole
  has_login: boolean
  last_sign_in_at: string | null
  banned_until: string | null
  created_at: string
}

/* admin_list_users (LAST def 0096:425-455): cross-org, empty search = all,
 * else every case-insensitive fragment across profile name, email and org name;
 * ordered by org name then profile name. A profile whose org row is gone
 * drops out (the SQL's INNER join on organizations). */
export const listUsers = platformQuery({
  args: { search: v.string() },
  handler: async (ctx, { search }): Promise<AdminUserRow[]> => {
    const orgs = await ctx.db.query('organizations').withIndex('by_uuid').collect()
    const orgNames = new Map(orgs.map((o) => [o.id, o.name]))
    const profiles = await ctx.db.query('profiles').withIndex('by_uuid').collect()

    const matches = allWordsMatcher(search)
    const matched = profiles
      .map((p) => ({ p, org_name: orgNames.get(p.org_id) }))
      .filter((r): r is { p: Doc<'profiles'>; org_name: string } => r.org_name !== undefined)
      .filter(({ p, org_name }) => matches(`${p.name}\n${p.email ?? ''}\n${org_name}`))
    matched.sort((a, b) => cmp(a.org_name, b.org_name) || cmp(a.p.name, b.p.name))

    const authColumns = await authColumnsMap(
      ctx,
      matched.map((r) => r.p),
    )
    return matched.map(({ p, org_name }): AdminUserRow => {
      const cols = p.auth_user_id !== undefined ? authColumns.get(p.auth_user_id) : undefined
      return {
        profile_id: p.id,
        name: p.name,
        email: p.email ?? null,
        org_id: p.org_id,
        org_name,
        org_role: p.org_role,
        has_login: p.auth_user_id !== undefined,
        last_sign_in_at: cols?.last_sign_in_at ?? null,
        banned_until: cols?.banned_until ?? null,
        created_at: p.created_at,
      }
    })
  },
})

/* --------------------------------------------------------- promoteOrgAdmin */

/* admin_promote_org_admin (0102:431-451) — the console's lockout rescue.
 * A viewer IS promotable on purpose; the one server guard is the agent
 * sentence, verbatim ("the console's one job here is to be readable when it
 * says no"). Writes the promote_org_admin audit row as the operator. */
export const promoteOrgAdmin = platformMutation({
  args: { profile_id: v.string() },
  handler: async (ctx, { profile_id }): Promise<null> => {
    const profile = await byId(ctx, 'profiles', profile_id)
    require(profile !== null, notFound('profile not found'))
    require(profile.kind !== 'agent', rule(
      'an agent cannot be an organization admin — it reaches only the projects it is added to',
    ))
    await ctx.db.patch(profile._id, { org_role: 'admin' })
    if (profile.org_role !== 'admin') {
      await markBillingMembershipChanged(
        ctx,
        profile.org_id,
        profile.email === undefined ? [] : [profile.email],
      )
    }
    await audit(ctx, {
      actor_auth_id: ctx.authUserId,
      actor_email: await actorEmail(ctx, ctx.authUserId),
      action: 'promote_org_admin',
      target_org_id: profile.org_id,
      target_profile_id: profile.id,
    })
    return null
  },
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

/* Monday of the ISO week holding `iso`, as YYYY-MM-DD (UTC) — the SQL's
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

/* admin_platform_stats (LAST def 0078:583-614). totals.members counts EVERY
 * profile (guests and agents included — the SQL did); weekly merges profile
 * created_at counts with activity counts over the last 84 days into sparse
 * week-Monday buckets, ascending (the SQL aggregated actual rows, so a week
 * with neither members nor activity is absent, exactly as before).
 * db_total_bytes was pg_database_size(current_database()); the port sums the
 * JSON footprint of every row in the ported tables — the dashboard tile's
 * "whole project" note becomes approximate. */
export const platformStats = platformQuery({
  args: {},
  handler: async (ctx): Promise<AdminPlatformStats> => {
    const nowMs = Date.now()
    const orgs = await ctx.db.query('organizations').withIndex('by_uuid').collect()
    const profiles = await ctx.db.query('profiles').withIndex('by_uuid').collect()
    const teams = await ctx.db.query('teams').withIndex('by_uuid').collect()
    const projects = await ctx.db.query('projects').withIndex('by_uuid').collect()
    const issues = await ctx.db.query('issues').withIndex('by_uuid').collect()
    const activity = await ctx.db.query('activity_events').withIndex('by_uuid').collect()
    const teamMembers = await ctx.db.query('team_members').withIndex('by_team').collect()
    const grants = await ctx.db.query('project_access').withIndex('by_project').collect()
    const teamGrants = await ctx.db.query('project_team_access').withIndex('by_project').collect()
    const links = await ctx.db.query('issue_links').withIndex('by_uuid').collect()
    const milestones = await ctx.db.query('milestones').withIndex('by_uuid').collect()

    let bytes = 0
    for (const rows of [
      orgs,
      profiles,
      teams,
      projects,
      issues,
      activity,
      teamMembers,
      grants,
      teamGrants,
      links,
      milestones,
    ]) {
      for (const row of rows) bytes += sizeOf(row)
    }

    const cutoff30 = new Date(nowMs - 30 * DAY).toISOString()
    const cutoff84 = new Date(nowMs - 84 * DAY).toISOString()

    const buckets = new Map<string, { new_members: number; activity: number }>()
    const bucket = (week: string) => {
      let b = buckets.get(week)
      if (b === undefined) {
        b = { new_members: 0, activity: 0 }
        buckets.set(week, b)
      }
      return b
    }
    for (const p of profiles) {
      if (p.created_at > cutoff84) bucket(weekMonday(p.created_at)).new_members += 1
    }
    let activity30 = 0
    for (const a of activity) {
      if (a.ts > cutoff30) activity30 += 1
      if (a.ts > cutoff84) bucket(weekMonday(a.ts)).activity += 1
    }
    const weekly = [...buckets.entries()]
      .sort(([a], [b]) => cmp(a, b))
      .map(([week, counts]) => ({ week, ...counts }))

    return {
      totals: {
        orgs: orgs.length,
        members: profiles.length,
        logins: profiles.filter((p) => p.auth_user_id !== undefined).length,
        teams: teams.length,
        projects: projects.length,
        issues: issues.length,
        activity_30d: activity30,
        db_total_bytes: bytes,
      },
      weekly,
    }
  },
})

/* ------------------------------------------------------------------ auditLog */

export type AdminAuditRow = {
  id: string
  ts: string
  actor_email: string
  action: string
  target_org_id: string | null
  target_profile_id: string | null
  detail: unknown
}

/* admin_audit_log (0015:231-245): newest first, limit clamped to 1..1000
 * (default 200). The table has no app uuid — _id serves as the row key the
 * console's list needs. */
export const auditLog = platformQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<AdminAuditRow[]> => {
    const clamped = Math.min(Math.max(limit ?? 200, 1), 1000)
    const rows = await ctx.db
      .query('platform_audit_log')
      .withIndex('by_ts')
      .order('desc')
      .take(clamped)
    return rows.map((r) => ({
      id: r._id,
      ts: r.ts,
      actor_email: r.actor_email,
      action: r.action,
      target_org_id: r.target_org_id ?? null,
      target_profile_id: r.target_profile_id ?? null,
      detail: r.detail as unknown,
    }))
  },
})

/* --------------------------------------------------------------- addOperator */

/* Operator enrolment stays CLI-only (0015: "operators are added via
 * SQL/dashboard only"):
 *   npx convex run admin:addOperator '{"email":"…"}'
 * Two writes, both required: the platform_admins row our wrappers gate on,
 * AND role 'admin' on the Better Auth user — adminMiddleware gates ban/unban
 * on the CALLER's BA role, so an operator without it opens the console but
 * fails every rescue with UNAUTHORIZED. Idempotent like
 * ensurePlatformAdmin; audited as 'cli' like deleteOrphanLogin. */
export const addOperator = internalMutation({
  args: { email: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ auth_user_id: string }> => {
    const email = args.email.trim().toLowerCase()
    require(email !== '', badRequest('email required'))
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: 'email', value: email }],
    })) as { _id: string; role?: string | null } | null
    require(user !== null, notFound('no auth account with that email'))

    const existing = await ctx.db
      .query('platform_admins')
      .withIndex('by_auth_user', (q) => q.eq('auth_user_id', user._id))
      .first()
    if (existing === null) {
      await ctx.db.insert('platform_admins', {
        auth_user_id: user._id,
        note: args.note ?? '',
        created_at: new Date().toISOString(),
      })
    }
    if (user.role !== 'admin') {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: 'user',
          where: [{ field: '_id', value: user._id }],
          update: { role: 'admin' },
        },
      })
    }
    await audit(ctx, { actor_email: 'cli', action: 'add_operator', detail: { email } })
    return { auth_user_id: user._id }
  },
})

/* ------------------------------------------------------------ removeOperator */

/* addOperator's inverse, CLI-only for the same reason:
 *   npx convex run admin:removeOperator '{"email":"…"}'
 * It undoes both writes — the platform_admins rows and the Better Auth role —
 * behind one guard: the LAST enrolled operator cannot be removed, because the
 * console gates on that table and re-enrolment only happens through
 * addOperator, off the CLI. The guard therefore asks for a DIFFERENT
 * auth_user_id whose Better Auth account still carries the 'admin' role:
 * duplicate or stale rows are not another usable operator. Duplicate rows for
 * the target are still one operator, and all of them go when removal is
 * allowed. Role-only cleanup (a stale BA 'admin' left by a half-done demotion)
 * is deliberately outside the guard: with no row there is no enrolment to
 * lose. Better Auth stores role as a comma-separated list, so only the
 * 'admin' token is taken out and the rest kept — 'user' when nothing else
 * remains. Idempotent — a call that changes nothing writes no audit row. */
export const removeOperator = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args): Promise<{ auth_user_id: string }> => {
    const email = args.email.trim().toLowerCase()
    require(email !== '', badRequest('email required'))
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: 'email', value: email }],
    })) as { _id: string; role?: string | null } | null
    require(user !== null, notFound('no auth account with that email'))

    const roleTokens = (role: string | null | undefined): string[] =>
      (role ?? '')
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token !== '')

    const enrolled = await ctx.db.query('platform_admins').withIndex('by_auth_user').collect()
    const theirs = enrolled.filter((row) => row.auth_user_id === user._id)
    if (theirs.length > 0) {
      const otherIds = [
        ...new Set(
          enrolled.filter((row) => row.auth_user_id !== user._id).map((row) => row.auth_user_id),
        ),
      ]
      let hasUsableOther = false
      for (const authUserId of otherIds) {
        const other = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: 'user',
          where: [{ field: '_id', value: authUserId }],
        })) as { role?: string | null } | null
        if (other !== null && roleTokens(other.role).includes('admin')) {
          hasUsableOther = true
          break
        }
      }
      require(hasUsableOther, rule(
        'the last platform operator cannot be removed — enrol another operator first',
      ))
      for (const row of theirs) await ctx.db.delete(row._id)
    }
    const roles = roleTokens(user.role)
    const kept = roles.filter((role) => role !== 'admin')
    const demoted = kept.length < roles.length
    if (demoted) {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: 'user',
          where: [{ field: '_id', value: user._id }],
          update: { role: kept.length > 0 ? kept.join(',') : 'user' },
        },
      })
    }
    if (theirs.length > 0 || demoted) {
      await audit(ctx, { actor_email: 'cli', action: 'remove_operator', detail: { email } })
    }
    return { auth_user_id: user._id }
  },
})

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
 * The organization table, the platform totals and the organization names
 * page through the data in actions, so they live in adminStats.ts. */

import { v } from 'convex/values'
import { components } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { internalMutation, query } from './_generated/server'
import { markBillingMembershipChanged } from './lib/billableUsers'
import { subscriptionFor } from './lib/billingAccess'
import { byId } from './lib/db'
import { isDemoDeployment } from './lib/demo'
import type { OrgRole, ProfileKind } from './lib/enums'
import {
  badRequest,
  notFound,
  platformMutation,
  platformQuery,
  require,
  rule,
} from './lib/functions'
import { allWordsMatcher } from './lib/search'
import { audit, operatorEmail } from './model/admin'
import { leaveAllTeams } from './model/orgs'
import { adminElsewhere, homeElsewhere } from './model/people'

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

/* ----------------------------------------------------------------- orgDetail */

export type AdminMemberRow = {
  profile_id: string
  name: string
  email: string | null
  org_role: OrgRole
  kind: ProfileKind
  active: boolean
  has_login: boolean
  last_sign_in_at: string | null
  banned_until: string | null
  created_at: string
  /* A pending person's newest invitation email to their current address,
   * sent from the console or the app (invites.ts), or null when none was
   * recorded. */
  invite: { sent: boolean; at: string } | null
}

/* The seat's newest 'invite_email' audit row for its current address. An
 * org admin may correct a pending seat's address, and a letter to the old
 * address says nothing about the new one. */
async function latestInvite(
  ctx: QueryCtx,
  seat: Doc<'profiles'>,
): Promise<AdminMemberRow['invite']> {
  const rows = ctx.db
    .query('platform_audit_log')
    .withIndex('by_target_profile', (q) => q.eq('target_profile_id', seat.id))
    .order('desc')
  for await (const row of rows) {
    if (row.action !== 'invite_email') continue
    const detail = row.detail as { sent?: unknown; email?: unknown }
    if (detail.email !== seat.email) continue
    return { sent: detail.sent === true, at: row.ts }
  }
  return null
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
    const members: AdminMemberRow[] = []
    for (const p of profiles) {
      const cols = p.auth_user_id !== undefined ? authColumns.get(p.auth_user_id) : undefined
      const pending = p.kind === 'person' && p.auth_user_id === undefined
      members.push({
        profile_id: p.id,
        name: p.name,
        email: p.email ?? null,
        org_role: p.org_role,
        kind: p.kind,
        active: p.active,
        has_login: p.auth_user_id !== undefined,
        last_sign_in_at: cols?.last_sign_in_at ?? null,
        banned_until: cols?.banned_until ?? null,
        created_at: p.created_at,
        invite: pending ? await latestInvite(ctx, p) : null,
      })
    }

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
 * A viewer IS promotable on purpose; the server guards are the agent
 * sentence, verbatim ("the console's one job here is to be readable when it
 * says no") and the home-organization fence for a pending seat. A promoted
 * guest starts with no team, as in profiles.update: any team row a guest
 * still holds is stale. Writes the promote_org_admin audit row as the
 * operator. */
export const promoteOrgAdmin = platformMutation({
  args: { profile_id: v.string() },
  handler: async (ctx, { profile_id }): Promise<null> => {
    const profile = await byId(ctx, 'profiles', profile_id)
    require(profile !== null, notFound('profile not found'))
    require(profile.kind !== 'agent', rule(
      'an agent cannot be an organization admin — it reaches only the projects it is added to',
    ))
    /* A pending seat whose address has a home elsewhere would arrive as a
     * guest, so it cannot be the admin. A signed-in seat is promoted as is,
     * which keeps the lockout rescue working. */
    if (profile.auth_user_id === undefined && profile.email !== undefined) {
      const home = await homeElsewhere(ctx, profile.email, profile.org_id, profile)
      if (home !== null) throw adminElsewhere(profile.email, home)
    }
    if (profile.org_role === 'guest') await leaveAllTeams(ctx, profile.id)
    // An admin creates projects by role, so the per-person right is cleared.
    await ctx.db.patch(profile._id, { org_role: 'admin', can_create_projects: undefined })
    if (profile.org_role !== 'admin') {
      await markBillingMembershipChanged(
        ctx,
        profile.org_id,
        profile.email === undefined ? [] : [profile.email],
      )
    }
    await audit(ctx, {
      actor_auth_id: ctx.authUserId,
      actor_email: await operatorEmail(ctx, ctx.authUserId),
      action: 'promote_org_admin',
      target_org_id: profile.org_id,
      target_profile_id: profile.id,
    })
    return null
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
    // The app's own invitation emails carry channel 'app' (invites.ts). They
    // are delivery records, shown through orgDetail, so the listing reads only
    // the rows without a channel.
    const rows = await ctx.db
      .query('platform_audit_log')
      .withIndex('by_channel_ts', (q) => q.eq('channel', undefined))
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
 * fails every rescue with UNAUTHORIZED. Repeated enrollment preserves the
 * account and is audited as 'cli' like deleteOrphanLogin. */
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

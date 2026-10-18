/* The platform-operator console's gate, rescue and audit listing, ports of
 * the admin_* RPC family (0015/0102) behind platformQuery/platformMutation.
 * Each call re-checks the caller against platform_admins, exactly 0015's
 * per-RPC gate. Response shapes match what src/admin/views/* destructure,
 * field by field.
 *
 * isOperator alone sits outside the platform wrappers on purpose. It is the
 * AdminGate's probe ("safe for any signed-in user to call", 0015:86) and must
 * answer false, never throw, for the anonymous and the merely signed-in
 * caller alike. The gate treats a throw as denied too, but a clean false is
 * what keeps the smoke's no-console-errors check green.
 *
 * The reads that page through the data in actions live apart: the
 * organization table, the platform totals and the organization names in
 * adminStats.ts, and the Users page and an organization's page in
 * adminPeople.ts. */

import { v } from 'convex/values'
import { components } from './_generated/api'
import { internalMutation, query } from './_generated/server'
import { markBillingMembershipChanged } from './lib/billableUsers'
import { byId } from './lib/db'
import { isDemoDeployment, refuseDemoFeature } from './lib/demo'
import {
  badRequest,
  notFound,
  platformMutation,
  platformQuery,
  require,
  rule,
} from './lib/functions'
import { audit, operatorEmail } from './model/admin'
import { leaveAllTeams } from './model/orgs'
import { adminElsewhere, homeElsewhere } from './model/people'

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
 * account and is audited as 'cli' like deleteOrphanLogin. It refuses a
 * demo deployment, as the console does, so it never writes an operator row
 * or an admin role there. */
export const addOperator = internalMutation({
  args: { email: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ auth_user_id: string }> => {
    refuseDemoFeature()
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
 * remains. Idempotent — a call that changes nothing writes no audit row.
 * Like addOperator, it refuses a demo deployment. */
export const removeOperator = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args): Promise<{ auth_user_id: string }> => {
    refuseDemoFeature()
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

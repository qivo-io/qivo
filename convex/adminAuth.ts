/* Platform-operator auth actions — admin-auth-actions' successor (the edge
 * function needed the service role; Convex needs actions because createUser
 * hashes passwords and requestPasswordReset mints tokens).
 *
 * Gate: actions run outside the db, so the platformQuery pattern is said as
 * an internal query the caller's identity propagates into — operatorCheck,
 * run by the platformAction wrapper (lib/functions.ts) BEFORE every handler
 * here, throwing the edge's 403 sentence and handing the handler
 * ctx.operator. Better Auth adds its own second fence on ban/unban: adminMiddleware
 * wants a SESSION whose user carries role 'admin' (the operator's BA user is
 * set so at enrolment — seed.ts / admin.addOperator), and the headers from
 * getAuth carry that session. `npx convex run` has no session, so ban/unban
 * are console-only; recoveryLink/createBreakGlass use headerless endpoints
 * and also work under `npx convex run --identity` on dev deployments.
 *
 * Email → seat resolution, ported from the edge's post-0081 rules: one
 * address can hold SEVERAL profiles — a home seat plus a guest seat per
 * organization that invited it. profilesByEmail reads them all in created_at
 * order; the "owning" seat is the first non-guest one (home first), falling
 * back to the first guest.
 *
 * Every action writes its platform_audit_log row (model/admin.audit) with the
 * operator's Better Auth email as actor. delete_orphan is absent from the
 * console and lives on as the deleteOrphanLogin internal
 * mutation, run via `npx convex run adminAuth:deleteOrphanLogin`. */

import { v } from 'convex/values'
import { components, internal } from './_generated/api'
import type { ActionCtx, MutationCtx } from './_generated/server'
import { internalMutation, internalQuery } from './_generated/server'
import { authComponent, createAuth, createCaptureAuth } from './auth'
import { claimSeatsForLogin } from './identity'
import { byId } from './lib/db'
import { refuseDemoFeature } from './lib/demo'
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  type PlatformOperator,
  platformAction,
  require,
} from './lib/functions'
import { audit } from './model/admin'
import { newUuid } from './model/orgs'

/* Web Crypto exists in the Convex isolate; convex/tsconfig's lib is ESNext
 * only, which does not declare the global (same move as model/orgs). */
declare const crypto: { randomUUID(): string }

/* ------------------------------------------------------------------- gates */

/* The platform fence, evaluated with the CALLER's identity (it propagates
 * into runQuery). Fail-closed: no identity and no platform_admins row get the
 * same sentence — the edge's 403. */
export const operatorCheck = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ auth_user_id: string }> => {
    refuseDemoFeature()
    const identity = await ctx.auth.getUserIdentity()
    if (identity === null) throw forbidden('platform admins only')
    const operator = await ctx.db
      .query('platform_admins')
      .withIndex('by_auth_user', (q) => q.eq('auth_user_id', identity.subject))
      .unique()
    if (operator === null) throw forbidden('platform admins only')
    return { auth_user_id: identity.subject }
  },
})

/* The gate + the audit-trail email resolution both moved into the
 * platformAction wrapper (lib/functions.ts) — handlers read ctx.operator,
 * the SQL's coalesce((select u.email from auth.users …), ''). */
type OperatorActionCtx = ActionCtx & { operator: PlatformOperator }

/* ----------------------------------------------------------------- lookups */

type SeatRow = { id: string; org_id: string; auth_user_id: string | null; org_role: string }

/* All seats carrying the address, created_at order (0081: home seat first in). */
export const profilesByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<SeatRow[]> => {
    const rows = await ctx.db
      .query('profiles')
      .withIndex('by_email', (q) => q.eq('email', email))
      .collect()
    rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    return rows.map((p) => ({
      id: p.id,
      org_id: p.org_id,
      auth_user_id: p.auth_user_id ?? null,
      org_role: p.org_role,
    }))
  },
})

const owningSeat = (all: SeatRow[]): SeatRow | null =>
  all.find((p) => p.org_role !== 'guest') ?? all[0] ?? null

const cleanEmail = (raw: string): string => {
  const email = raw.trim().toLowerCase()
  require(email !== '', badRequest('email required'))
  return email
}

/* ------------------------------------------------------------------- audit */

export const logAction = internalMutation({
  args: {
    actor_auth_id: v.optional(v.string()),
    actor_email: v.string(),
    action: v.string(),
    target_org_id: v.optional(v.string()),
    target_profile_id: v.optional(v.string()),
    detail: v.any(),
  },
  handler: async (ctx, args) => {
    await audit(ctx, {
      actor_email: args.actor_email,
      action: args.action,
      actor_auth_id: args.actor_auth_id,
      target_org_id: args.target_org_id,
      target_profile_id: args.target_profile_id,
      detail: args.detail as Record<string, unknown>,
    })
  },
})

/* ----------------------------------------------------------- recovery link */

/* The one-shot capture: a Better Auth instance whose sendResetPassword writes
 * into a per-action ref (auth.ts createCaptureAuth). requestPasswordReset is
 * headerless-safe (originCheck skips without a request) and awaits the
 * callback inline; an email with no user returns success WITHOUT invoking it
 * (anti-enumeration), and callback exceptions are swallowed by Better Auth —
 * so a still-null ref is the one honest signal, mapped to the edge's 404
 * sentence. */
async function mintRecoveryLink(ctx: ActionCtx, email: string): Promise<string> {
  const captured: { url: string | null } = { url: null }
  const auth = createCaptureAuth(ctx, captured)
  await auth.api.requestPasswordReset({
    // ?reset=1 is the AuthGate's reset-landing marker (AuthGate.tsx): Better
    // Auth appends &token=<t> to it, and without the marker the gate strips
    // the token and shows plain sign-in — the link would be a dud.
    body: { email, redirectTo: `${process.env.SITE_URL}/app?reset=1` },
  })
  if (captured.url === null) throw notFound('no login found for that email')
  return captured.url
}

/* One-time password-recovery link, returned to the console and never stored.
 * → { link } */
export const recoveryLink = platformAction({
  args: { email: v.string() },
  handler: async (ctx, args): Promise<{ link: string }> => {
    const email = cleanEmail(args.email)
    const link = await mintRecoveryLink(ctx, email)
    const p = owningSeat(await ctx.runQuery(internal.adminAuth.profilesByEmail, { email }))
    await ctx.runMutation(internal.adminAuth.logAction, {
      actor_auth_id: ctx.operator.auth_user_id,
      actor_email: ctx.operator.email,
      action: 'recovery_link',
      ...(p !== null ? { target_org_id: p.org_id, target_profile_id: p.id } : {}),
      detail: { email },
    })
    return { link }
  },
})

/* ------------------------------------------------------------- ban / unban */

/* Session-bound: banUser/unbanUser run Better Auth's adminMiddleware against
 * the headers getAuth builds from the caller's session. No banExpiresIn ⇒ the
 * ban never expires — the '87600h' idiom's successor — and banUser also
 * revokes the target's live sessions (stronger than GoTrue's ban was). */
async function setBan(
  ctx: OperatorActionCtx,
  rawEmail: string,
  ban: boolean,
): Promise<{ ok: boolean }> {
  const email = cleanEmail(rawEmail)
  const p = owningSeat(await ctx.runQuery(internal.adminAuth.profilesByEmail, { email }))
  if (p === null || p.auth_user_id === null) throw notFound('no login found for that email')
  const { auth, headers } = await authComponent.getAuth(createAuth, ctx)
  if (ban) await auth.api.banUser({ body: { userId: p.auth_user_id }, headers })
  else await auth.api.unbanUser({ body: { userId: p.auth_user_id }, headers })
  await ctx.runMutation(internal.adminAuth.logAction, {
    actor_auth_id: ctx.operator.auth_user_id,
    actor_email: ctx.operator.email,
    action: ban ? 'ban' : 'unban',
    target_org_id: p.org_id,
    target_profile_id: p.id,
    detail: { email },
  })
  return { ok: true }
}

export const banUser = platformAction({
  args: { email: v.string() },
  handler: (ctx, args): Promise<{ ok: boolean }> => setBan(ctx, args.email, true),
})

export const unbanUser = platformAction({
  args: { email: v.string() },
  handler: (ctx, args): Promise<{ ok: boolean }> => setBan(ctx, args.email, false),
})

/* ------------------------------------------------------------- break-glass */

/* "Creates a new org-admin member with a login and returns a one-time
 * recovery link. Use when nobody in the organization can sign in; hand the
 * link to the customer out-of-band and have them remove the account
 * afterwards." (console copy, verbatim contract)
 *
 * Order vs the edge: login first (headerless createUser — the one admin route
 * allowed without a session; the throwaway password dies in this frame), then
 * ONE mutation inserting the profile, claiming the seat explicitly
 * (claimSeatsForLogin — the on-auth-signup trigger's successor, same
 * transaction) and auditing. If the mutation refuses (race, missing
 * org), the just-minted login is compensated away so no orphan survives.
 * → { link } */
export const createBreakGlass = platformAction({
  args: { org_id: v.string(), email: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ link: string }> => {
    require(args.org_id !== '' && args.email.trim() !== '', badRequest('org_id and email required'))
    const email = cleanEmail(args.email)
    /* Existence fence — ANY seat, home or guest (edge sentence verbatim).
     * Pre-checked here for the readable refusal, re-checked in the insert
     * mutation whose serializability closes the race. */
    const existing = await ctx.runQuery(internal.adminAuth.profilesByEmail, { email })
    if (existing.length > 0)
      throw conflict('a member with that email already exists', 'member_exists')
    const name =
      args.name !== undefined && args.name.trim() !== '' ? args.name.trim() : 'Recovery Admin'
    const auth = createAuth(ctx)
    const { user } = await auth.api.createUser({
      body: {
        email,
        // never known to anyone: the recovery link is the only way in
        password: crypto.randomUUID() + crypto.randomUUID(),
        name,
        // spreads onto the user row — a verified login, no confirmation mail.
        // NOT role admin: the customer gets an ORG admin seat, not platform rights.
        data: { emailVerified: true },
      },
    })
    try {
      await ctx.runMutation(internal.adminAuth.insertBreakGlass, {
        org_id: args.org_id,
        email,
        name,
        auth_user_id: user.id,
        actor: { auth_user_id: ctx.operator.auth_user_id, email: ctx.operator.email },
      })
    } catch (e) {
      await ctx.runMutation(internal.adminAuth.removeAuthUser, { auth_user_id: user.id })
      throw e
    }
    const link = await mintRecoveryLink(ctx, email)
    return { link }
  },
})

/* The break-glass write, one transaction: fence re-check, org lookup, profile
 * insert (edge field-for-field; retention 7 was the PG column default),
 * explicit claim, audit row. */
export const insertBreakGlass = internalMutation({
  args: {
    org_id: v.string(),
    email: v.string(),
    name: v.string(),
    auth_user_id: v.string(),
    actor: v.object({ auth_user_id: v.string(), email: v.string() }),
  },
  handler: async (ctx, a): Promise<{ profile_id: string }> => {
    const clash = await ctx.db
      .query('profiles')
      .withIndex('by_email', (q) => q.eq('email', a.email))
      .first()
    if (clash !== null) throw conflict('a member with that email already exists', 'member_exists')
    const org = await byId(ctx, 'organizations', a.org_id)
    if (org === null) throw notFound('organization not found')
    const now = new Date().toISOString()
    const id = newUuid()
    await ctx.db.insert('profiles', {
      id,
      org_id: org.id,
      email: a.email,
      name: a.name,
      initials: 'RA',
      color: '#DC2626',
      org_role: 'admin',
      active: true,
      kind: 'person',
      message_retention_days: 7,
      created_at: now,
    })
    // Claiming also schedules the new active member's billing recount.
    await claimSeatsForLogin(ctx, { userId: a.auth_user_id, email: a.email, emailVerified: true })
    await audit(ctx, {
      actor_auth_id: a.actor.auth_user_id,
      actor_email: a.actor.email,
      action: 'create_break_glass',
      target_org_id: org.id,
      target_profile_id: id,
      detail: { email: a.email, name: a.name },
    })
    return { profile_id: id }
  },
})

/* ----------------------------------------------------------- delete orphan */

/* Adapter-level removal of a Better Auth user and everything session/account
 * shaped it holds (auth.api.removeUser needs an admin session; internal
 * mutations have none). Verification rows are keyed by identifier, not
 * userId, and expire on their own — removeUser leaves them too. */
async function removeAuthUserRows(ctx: MutationCtx, userId: string): Promise<void> {
  await ctx.runMutation(internal.appearance.clearForDeletedLogin, { auth_user_id: userId })
  for (const model of ['session', 'account'] as const) {
    let cursor: string | null = null
    for (;;) {
      const res = (await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
        input: { model, where: [{ field: 'userId', value: userId }] },
        paginationOpts: { numItems: 100, cursor },
      })) as { isDone: boolean; continueCursor: string }
      if (res.isDone) break
      cursor = res.continueCursor
    }
  }
  await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
    input: { model: 'user', where: [{ field: '_id', value: userId }] },
  })
}

/* createBreakGlass's compensation arm — no fences, no audit: the login it
 * removes was minted a moment ago by the same action and never handed out. */
export const removeAuthUser = internalMutation({
  args: { auth_user_id: v.string() },
  handler: async (ctx, { auth_user_id }) => {
    await removeAuthUserRows(ctx, auth_user_id)
  },
})

/* Sign-up leftovers: a login no profile references. Cut from the console;
 * the edge's 20-page listUsers walk becomes one indexed lookup. Run via
 *   npx convex run adminAuth:deleteOrphanLogin '{"email":"…"}' */
export const deleteOrphanLogin = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const email = cleanEmail(args.email)
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: 'email', value: email }],
    })) as { _id: string } | null
    if (user === null) throw notFound('no auth account with that email')
    /* ANY profile — home or guest — means this login is not an orphan; the
     * by_auth probe is belt-and-braces for a seat whose email moved on. */
    const byEmail = await ctx.db
      .query('profiles')
      .withIndex('by_email', (q) => q.eq('email', email))
      .first()
    const byAuth = await ctx.db
      .query('profiles')
      .withIndex('by_auth', (q) => q.eq('auth_user_id', user._id))
      .first()
    if (byEmail !== null || byAuth !== null) {
      throw conflict('that login belongs to a member — remove the member instead', 'login_in_use')
    }
    await removeAuthUserRows(ctx, user._id)
    await audit(ctx, { actor_email: 'cli', action: 'delete_orphan', detail: { email } })
  },
})

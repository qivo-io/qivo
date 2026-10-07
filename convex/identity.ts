/* Login ↔ seat linking. A Better Auth user is the LOGIN (component tables,
 * never mirrored); a profile is a per-org SEAT, possibly unclaimed. The four
 * entry points:
 *
 *   claim loop      claimSeatsForLogin — the boot path, whose extra
 *                   not-exists clause is the (org_id, auth_user_id)
 *                   uniqueness guard
 *   bootstrap       the predicate "no admin holding a login", framed as
 *                   promote-the-adopted-seat rather than create-a-profile
 *   acceptInvitation
 *   createOrganization  minus the cut domain gate; internals in model/orgs
 *
 * Adoption stamps accepted_at. The domain auto-join feature is absent, so a
 * verified-email claim IS the acceptance. */

import { v } from 'convex/values'
import type { MutationCtx } from './_generated/server'
import { internalMutation } from './_generated/server'
import { authComponent } from './auth'
import { markBillingMembershipChanged } from './lib/billableUsers'
import { byId } from './lib/db'
import { isDemoDeployment, refuseDemoFeature } from './lib/demo'
import { authedMutation, authedQuery, require, rule } from './lib/functions'
import { enrollOrganization } from './model/billing'
import {
  createStarterLabels,
  createStarterTeam,
  generateSlug,
  nameInitials,
  newOrgDefaults,
  newUuid,
} from './model/orgs'

const seatsOf = (ctx: MutationCtx, authUserId: string) =>
  ctx.db
    .query('profiles')
    .withIndex('by_auth', (q) => q.eq('auth_user_id', authUserId))
    .collect()

/* The ONE claim implementation — replaces the two GoTrue
 * triggers and the boot RPC. Adopts every unclaimed seat carrying the login's
 * verified address, across all orgs, in creation order. Never creates one. */
export async function claimSeatsForLogin(
  ctx: MutationCtx,
  { userId, email, emailVerified }: { userId: string; email: string; emailVerified: boolean },
): Promise<number> {
  // Demo ownership is linked directly by its private seed. Never discover
  // another sandbox's seats by an email claim, even after an auth miswrite.
  if (isDemoDeployment()) return 0
  // 0085: "an unconfirmed address proves nothing about its owner"
  if (!emailVerified) return 0
  const em = email.toLowerCase()
  const waiting = (
    await ctx.db
      .query('profiles')
      .withIndex('by_email', (q) => q.eq('email', em))
      .collect()
  )
    .filter((p) => p.auth_user_id === undefined)
    // order by created_at, id (0085) — first seat in wins the home role
    .sort((a, b) =>
      a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1,
    )
  let adopted = 0
  let changedOrgId: string | undefined
  for (const seat of waiting) {
    // re-read per seat: earlier adoptions in this loop must count (SQL loop semantics)
    const mine = await seatsOf(ctx, userId)
    // claim_my_seats' not-exists clause: a login never holds two seats in one org
    if (mine.some((p) => p.org_id === seat.org_id)) continue
    // one HOME seat per login: a second non-guest adoption becomes a guest seat
    const hasHome = mine.some((p) => p.org_role !== 'guest')
    const role = seat.org_role !== 'guest' && hasHome ? 'guest' : seat.org_role
    await ctx.db.patch(seat._id, {
      auth_user_id: userId,
      accepted_at: new Date().toISOString(),
      ...(role === seat.org_role ? {} : { org_role: role }),
    })
    adopted += 1
    changedOrgId = seat.org_id
    /* Bootstrap (0002): an org whose admins hold no login yet makes its first
     * login an admin. Predicate ported exactly — org_role = 'admin' AND
     * auth_user_id set; profiles.active (0099) postdates it and is not
     * consulted. Skipped when the seat landed as guest beside an existing
     * home seat: promotion would mint a second non-guest seat, which the
     * profiles_home_org_uniq index (0118) refused at the database. */
    if (role === 'guest' && hasHome) continue
    if (role === 'admin') continue
    const orgSeats = await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', seat.org_id))
      .collect()
    const hasActiveAdmin = orgSeats.some(
      (p) => p._id !== seat._id && p.org_role === 'admin' && p.auth_user_id !== undefined,
    )
    if (!hasActiveAdmin) await ctx.db.patch(seat._id, { org_role: 'admin' })
  }
  if (changedOrgId !== undefined) await markBillingMembershipChanged(ctx, changedOrgId, [em])
  return adopted
}

/* Seeds, break-glass, and tests drive the core through this. */
export const claimSeatsInternal = internalMutation({
  args: { userId: v.string(), email: v.string(), emailVerified: v.boolean() },
  handler: async (ctx, args) => claimSeatsForLogin(ctx, args),
})

/* Called first thing at every boot (initStore). Email and emailVerified come
 * from the component's user row — authoritative state, not JWT claims. */
export const claimMySeats = authedMutation({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.getAuthUser(ctx)
    return await claimSeatsForLogin(ctx, {
      userId: user._id,
      email: user.email,
      emailVerified: user.emailVerified,
    })
  },
})

/* Round-trip gate (and later AdminGate): who am I, and which active seats do
 * I hold. */
export const whoami = authedQuery({
  args: {},
  handler: async (ctx) => ({
    authUserId: ctx.authUserId,
    profiles: [...ctx.myProfiles.values()].map((p) => ({
      id: p.id,
      org_id: p.org_id,
      org_role: p.org_role,
      name: p.name,
      email: p.email,
      accepted_at: p.accepted_at,
    })),
  }),
})

/* public.create_organization (0118, minus the cut domain gate): guards in SQL
 * order, then org + admin profile + starter team, returning the org
 * uuid — both client call sites only truthiness-test the result. */
export const createOrganization = authedMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }): Promise<string> => {
    refuseDemoFeature()
    const user = await authComponent.getAuthUser(ctx)
    // 0118: "the gate every other reader of this address already had"
    require(user.emailVerified, rule('confirm your email address before creating an organization'))
    const mine = await seatsOf(ctx, ctx.authUserId)
    require(!mine.some((p) => p.org_role !== 'guest' && p.accepted_at !== undefined), rule(
      'you already belong to an organization',
    ))
    const nm = name.trim()
    require(nm !== '', rule('the organization needs a name'))
    const em = user.email.toLowerCase()
    /* (e) who the provider says this is, before a name is invented from an
     * address; the local part stays the password-path fallback, 'Admin' the
     * last resort. Folded, then cut to 80 codepoints (profiles_name_shape). */
    let who = user.name.replace(/\s+/g, ' ').trim()
    if (who === '') who = em.split('@')[0] || 'Admin'
    who = [...who].slice(0, 80).join('').trim()
    if (who === '') who = 'Admin'

    const now = new Date().toISOString()
    // Retention follows the person across seats (0112), including a saved
    // Never. With no prior seat, stamp 7: an absent database field means Never.
    const retentionSeats = [
      ...mine,
      ...(await ctx.db
        .query('profiles')
        .withIndex('by_email', (q) => q.eq('email', em))
        .collect()),
    ].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    const retention = retentionSeats.length > 0 ? retentionSeats[0].message_retention_days : 7
    const orgId = newUuid()
    await ctx.db.insert('organizations', {
      id: orgId,
      name: nm,
      slug: await generateSlug(ctx, nm),
      ...newOrgDefaults(now),
    })
    const profileId = newUuid()
    await ctx.db.insert('profiles', {
      id: profileId,
      auth_user_id: ctx.authUserId,
      org_id: orgId,
      email: em,
      name: who,
      initials: nameInitials(who),
      color: '#6D7BF2',
      org_role: 'admin',
      active: true,
      kind: 'person',
      message_retention_days: retention,
      accepted_at: now,
      created_at: now,
    })
    await createStarterTeam(ctx, { org_id: orgId, name: nm, leader_id: profileId, now })
    await createStarterLabels(ctx, { org_id: orgId, now })
    await enrollOrganization(ctx, orgId)
    await markBillingMembershipChanged(ctx, orgId, [em])
    return orgId
  },
})

/* Say yes to a seat somebody invited you to (0118). Accepting is answering,
 * never claiming: the row must already carry the caller's login, and any
 * mismatch is uniformly not found — the id is not an existence oracle. */
export const acceptInvitation = authedMutation({
  args: { profile_id: v.string() },
  handler: async (ctx, { profile_id }) => {
    refuseDemoFeature()
    const seat = await byId(ctx, 'profiles', profile_id)
    if (seat === null || seat.auth_user_id !== ctx.authUserId) throw rule('invitation not found')
    if (seat.accepted_at !== undefined) return
    /* Home-org uniqueness re-checked at accept time — another ACCEPTED
     * non-guest seat — but demote-to-guest instead of refusing. */
    const mine = await seatsOf(ctx, ctx.authUserId)
    const hasHome = mine.some(
      (p) => p._id !== seat._id && p.org_role !== 'guest' && p.accepted_at !== undefined,
    )
    await ctx.db.patch(seat._id, {
      accepted_at: new Date().toISOString(),
      ...(seat.org_role !== 'guest' && hasHome ? { org_role: 'guest' as const } : {}),
    })
    if (seat.org_role !== 'guest' && hasHome) {
      await markBillingMembershipChanged(
        ctx,
        seat.org_id,
        seat.email === undefined ? [] : [seat.email],
      )
    }
  },
})

/* Login ↔ seat linking. A Better Auth user is the LOGIN (component tables,
 * never mirrored); a profile is a per-org SEAT, possibly unclaimed. The four
 * entry points:
 *
 *   claim loop      claimSeatsForLogin — the boot path, whose extra
 *                   not-exists clause is the (org_id, auth_user_id)
 *                   uniqueness guard
 *   bootstrap       the predicate "no admin holding a login and no active
 *                   invited admin", framed as promote-the-adopted-seat
 *                   rather than create-a-profile
 *   acceptInvitation
 *   createOrganization  minus the cut domain gate; internals in model/orgs
 *
 * Adoption stamps accepted_at. The domain auto-join feature is absent, so a
 * verified-email claim IS the acceptance. */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { internalMutation } from './_generated/server'
import { requireLiveAuthUser } from './lib/authUser'
import { markBillingMembershipChanged } from './lib/billableUsers'
import { isHomeSeat } from './lib/billingAccess'
import { byId } from './lib/db'
import { isDemoDeployment, refuseDemoFeature } from './lib/demo'
import { asciiEmail } from './lib/email'
import { authedMutation, authedQuery, require, rule } from './lib/functions'
import { cutText, DEFAULT_MESSAGE_RETENTION_DAYS, LIMITS } from './lib/limits'
import { named } from './lib/nameKey'
import { enrollOrganization } from './model/billing'
import {
  cleanOrgName,
  createStarterLabels,
  createStarterTeam,
  generateSlug,
  insertOrgRows,
  leaveAllTeams,
  nameInitials,
  newOrgDefaults,
  newUuid,
} from './model/orgs'
import { byClaimOrder, cleanName } from './model/people'

const seatsOf = (ctx: MutationCtx, authUserId: string) =>
  ctx.db
    .query('profiles')
    .withIndex('by_auth', (q) => q.eq('auth_user_id', authUserId))
    .collect()

/* The bootstrap's admin test. An admin holding a login counts, active or not
 * as 0002 had it, and so does an active invited admin. */
const countsAsAdmin = (p: Doc<'profiles'>) =>
  p.org_role === 'admin' && (p.auth_user_id !== undefined || p.active)

/* An invited org admin whose address had meanwhile gained a home elsewhere
 * arrives as a guest. People who signed in earlier kept their invited roles
 * because that invitation counted as the admin, so repeat the bootstrap for
 * them. The earliest active person who already signed in becomes the admin.
 * With nobody signed in yet, the next sign-in is promoted as usual. */
async function replaceLostAdmin(ctx: MutationCtx, orgId: string): Promise<void> {
  const seats = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  if (seats.some(countsAsAdmin)) return
  const [first] = seats
    .filter(
      (p) =>
        p.kind === 'person' && p.active && p.org_role !== 'guest' && p.auth_user_id !== undefined,
    )
    .sort(byClaimOrder)
  // A role change clears the project-creation right (profiles.update).
  if (first !== undefined) {
    await ctx.db.patch(first._id, { org_role: 'admin', can_create_projects: undefined })
  }
}

/* The ONE claim implementation — replaces the two GoTrue
 * triggers and the boot RPC. Adopts every active unclaimed seat carrying the
 * login's verified address, across all orgs, in creation order. Never
 * creates one. A deactivated invitation is no invitation (invites.ts): it
 * waits, and a reactivation lets the next boot adopt it, as a guest seat
 * once the login has a home. Adopting it would give the login a home seat
 * it cannot open, which bars it from creating an organization. */
export async function claimSeatsForLogin(
  ctx: MutationCtx,
  { userId, email, emailVerified }: { userId: string; email: string; emailVerified: boolean },
): Promise<number> {
  // Demo ownership is linked directly by its private seed. Never discover
  // another sandbox's seats by an email claim, even after an auth miswrite.
  if (isDemoDeployment()) return 0
  // 0085: "an unconfirmed address proves nothing about its owner"
  if (!emailVerified) return 0
  // the form invitations store (lib/email.ts), so a provider's Unicode
  // domain finds the seat invited under its punycode one
  const em = asciiEmail(email)
  const waiting = (
    await ctx.db
      .query('profiles')
      .withIndex('by_email', (q) => q.eq('email', em))
      .collect()
  )
    .filter((p) => p.auth_user_id === undefined && p.active)
    // order by created_at, id (0085) — first seat in wins the home role
    .sort(byClaimOrder)
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
    // A role change clears the project-creation right (profiles.update).
    await ctx.db.patch(seat._id, {
      auth_user_id: userId,
      accepted_at: new Date().toISOString(),
      ...(role === seat.org_role ? {} : { org_role: role, can_create_projects: undefined }),
    })
    // Guests never belong to teams; nobody is present to refuse a sign-in.
    if (role === 'guest') await leaveAllTeams(ctx, seat.id)
    adopted += 1
    changedOrgId = seat.org_id
    // An invited org admin who arrives as a guest stops counting as an admin.
    if (seat.org_role === 'admin' && role === 'guest') await replaceLostAdmin(ctx, seat.org_id)
    /* Bootstrap (0002): an org with no admin makes its first login an admin.
     * An active invited admin counts too (countsAsAdmin), so someone invited
     * as a standard user or viewer who signs in before the invited admin
     * keeps that role. Skipped when the seat landed as guest beside an
     * existing home seat: promotion would mint a second non-guest seat, which
     * the profiles_home_org_uniq index (0118) refused at the database. */
    if (role === 'guest' && hasHome) continue
    if (role === 'admin') continue
    const orgSeats = await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', seat.org_id))
      .collect()
    if (!orgSeats.some((p) => p._id !== seat._id && countsAsAdmin(p))) {
      await ctx.db.patch(seat._id, { org_role: 'admin', can_create_projects: undefined })
    }
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
 * from the component's user row — authoritative state, not JWT claims. The
 * login is read without loading Better Auth (lib/authUser.ts), and a caller
 * without a live session is refused. */
export const claimMySeats = authedMutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireLiveAuthUser(ctx)
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
    const user = await requireLiveAuthUser(ctx)
    // 0118: "the gate every other reader of this address already had"
    require(user.emailVerified, rule('confirm your email address before creating an organization'))
    const mine = await seatsOf(ctx, ctx.authUserId)
    require(!mine.some(isHomeSeat), rule('you already belong to an organization'))
    const nm = cleanOrgName(name)
    require(nm !== '', rule('the organization needs a name'))
    // the form every seat stores (lib/email.ts), so canonical lookups find it
    const em = asciiEmail(user.email)
    /* (e) who the provider says this is, before a name is invented from an
     * address; the local part stays the password-path fallback, 'Admin' the
     * last resort. Folded, then cut to a name's length (LIMITS.personName)
     * rather than refused, because the provider chose it. */
    let who = cleanName(user.name)
    if (who === '') who = em.split('@')[0] || 'Admin'
    who = cutText(who, LIMITS.personName.max).trim()
    if (who === '') who = 'Admin'

    const now = new Date().toISOString()
    // Retention follows the person across seats (0112), including a saved
    // Never. With no prior seat, stamp the default: an absent database field
    // means Never.
    const retentionSeats = [
      ...mine,
      ...(await ctx.db
        .query('profiles')
        .withIndex('by_email', (q) => q.eq('email', em))
        .collect()),
    ].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    const retention =
      retentionSeats.length > 0
        ? retentionSeats[0].message_retention_days
        : DEFAULT_MESSAGE_RETENTION_DAYS
    const orgId = newUuid()
    await insertOrgRows(ctx, {
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
      ...named(who),
      initials: nameInitials(who),
      color: '#6D7BF2',
      org_role: 'admin',
      active: true,
      kind: 'person',
      message_retention_days: retention,
      accepted_at: now,
      created_at: now,
    })
    await createStarterTeam(ctx, {
      org_id: orgId,
      name: nm,
      leader: { id: profileId, name: who },
      now,
    })
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
    const hasHome = mine.some((p) => p._id !== seat._id && isHomeSeat(p))
    const role = seat.org_role !== 'guest' && hasHome ? 'guest' : seat.org_role
    // A role change clears the project-creation right (profiles.update).
    await ctx.db.patch(seat._id, {
      accepted_at: new Date().toISOString(),
      ...(role === seat.org_role ? {} : { org_role: role, can_create_projects: undefined }),
    })
    // Guests never belong to teams.
    if (role === 'guest') await leaveAllTeams(ctx, seat.id)
    if (role !== seat.org_role) {
      await markBillingMembershipChanged(
        ctx,
        seat.org_id,
        seat.email === undefined ? [] : [seat.email],
      )
    }
  },
})

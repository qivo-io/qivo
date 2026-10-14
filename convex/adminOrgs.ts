/* The operator console's doors for creating organizations and inviting their
 * people.
 *
 * An invitation is a pending seat (see profiles.ts), a person profile with an
 * email address and no login. The person joins by signing in or creating an
 * account with that address (identity.claimSeatsForLogin). The doors here:
 *
 *   createOrganization  the organization, its address, starter team and
 *                       labels, billing plan (optionally months free) and
 *                       its first people, in one transaction
 *   invitePeople        more people for an existing organization
 *   resendInvite        another invitation email for a pending seat
 *   editInvite          corrects a pending seat's name or address, and
 *                       emails the corrected address
 *   cancelInvite        removes a pending seat
 *   setMemberRole       Org admin, Standard user or Viewer for a person
 *   suggestAddress, checkAddress, checkPeople
 *                       read-only checks the dialog runs while typing
 *
 * Rules every door enforces:
 *   - Admin first. Until the organization has an active org admin, invited or
 *     signed in, the first person added must be an org admin.
 *     claimSeatsForLogin counts invited admins too, so a person invited with
 *     another role keeps it even if they sign in before the admin.
 *   - No guests. An operator invites people to a new customer's
 *     organization, and its org admins and project leads invite guests. A
 *     login has one home organization, and a non-guest seat elsewhere turns
 *     a new seat into a guest when it is claimed. So an address that already
 *     has a home organization elsewhere is refused for every role, and
 *     checkPeople lets the console say so before sending. Guest seats are
 *     outside every door here.
 *
 * The actions send invitation email after the seat mutation commits, through
 * invites.sendInvites (From is the deployment's AgentMail inbox,
 * no-reply@qivo.io in production), which records every attempt. A failed or
 * unconfigured send keeps the seat, and the console offers the sign-up link
 * instead. A seat claimed between saving and sending is skipped rather than
 * failing a request whose writes already committed. Every write is audited as
 * the operator. */

import { ConvexError, type Infer, v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation } from './_generated/server'
import { type InviteResult, sendInvites } from './invites'
import { markBillingMembershipChanged } from './lib/billableUsers'
import { byId } from './lib/db'
import {
  notFound,
  platformAction,
  platformMutation,
  platformQuery,
  type Refusal,
  require,
  rule,
} from './lib/functions'
import { audit, operatorEmail } from './model/admin'
import { enrollOrganization, grantComplimentaryMonths } from './model/billing'
import { removeProfile } from './model/cascade'
import {
  assertNotLastAdmin,
  assertSlugAvailable,
  createStarterLabels,
  createStarterTeam,
  generateSlug,
  nameInitials,
  newOrgDefaults,
  newUuid,
} from './model/orgs'
import {
  adminElsewhere,
  assertNameShape,
  assertViewerLeadsNothing,
  cleanName,
  EMAIL_SHAPE,
  homeElsewhere,
  inheritedRetention,
  normalizeEmail,
} from './model/people'

/* The roles an operator assigns. Guests come from project invitations and
 * agents from the in-app Users page, so neither is offered here. */
const vRole = v.union(v.literal('admin'), v.literal('user'), v.literal('viewer'))
const vPerson = v.object({ name: v.string(), email: v.string(), role: vRole })
const vActor = v.object({ auth_user_id: v.string(), email: v.string() })
type Person = Infer<typeof vPerson>
type Actor = Infer<typeof vActor>

/* People per request. Their mail sends share one time budget (sendInvites). */
const MAX_PEOPLE = 50

/* Data, not tokens. The same palette the planner's add-user flow writes. */
const AVATAR_COLORS = [
  '#0F766E',
  '#B45309',
  '#1D4ED8',
  '#6D28D9',
  '#9333EA',
  '#0891B2',
  '#BE123C',
  '#4D7C0F',
  '#A16207',
  '#0E7490',
]

/* ----------------------------------------------------------------- lookups */

/* An active org admin, invited or signed in. */
async function hasActiveAdmin(ctx: QueryCtx, orgId: string): Promise<boolean> {
  const seats = ctx.db.query('profiles').withIndex('by_org', (q) => q.eq('org_id', orgId))
  for await (const p of seats) if (p.org_role === 'admin' && p.active) return true
  return false
}

/* Refusal for an address with a home organization elsewhere. It would join
 * as a guest, and org admins and project leads invite guests, not the
 * operator. */
const memberElsewhere = (email: string, org: Doc<'organizations'>) =>
  rule(
    `${email} already belongs to ${org.name}, so they can only join as a guest. An org admin or project lead can invite them from project settings.`,
  )

/* ------------------------------------------------------------------ writes */

/* Validates every person first, then inserts their pending seats, one
 * 'invite_member' audit row each. Returns the new profile ids in input
 * order. */
async function addPeople(
  ctx: MutationCtx,
  org: Doc<'organizations'>,
  people: Person[],
  actor: Actor,
): Promise<string[]> {
  require(people.length <= MAX_PEOPLE, rule(`Invite at most ${MAX_PEOPLE} people at a time.`))
  const rows: Person[] = []
  const seen = new Set<string>()
  let admin = await hasActiveAdmin(ctx, org.id)
  for (const person of people) {
    const name = cleanName(person.name)
    assertNameShape(name)
    const email = normalizeEmail(person.email)
    if (email === undefined) throw rule(`${name} needs an email address.`)
    if (!EMAIL_SHAPE.test(email)) throw rule(`${email} is not an email address.`)
    if (seen.has(email)) throw rule(`${email} is listed twice.`)
    seen.add(email)
    const dup = await ctx.db
      .query('profiles')
      .withIndex('by_org_email', (q) => q.eq('org_id', org.id).eq('email', email))
      .first()
    if (dup !== null) throw rule(`${email} already has a seat in this organization`)
    if (!admin && person.role !== 'admin') throw rule('The first person must be an org admin.')
    const home = await homeElsewhere(ctx, email, org.id)
    if (home !== null) throw memberElsewhere(email, home)
    if (person.role === 'admin') admin = true
    rows.push({ name, email, role: person.role })
  }

  const now = new Date().toISOString()
  const existing = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()
  const ids: string[] = []
  for (const [i, row] of rows.entries()) {
    const id = newUuid()
    await ctx.db.insert('profiles', {
      id,
      org_id: org.id,
      email: row.email,
      name: row.name,
      initials: nameInitials(row.name),
      color: AVATAR_COLORS[(existing.length + i) % AVATAR_COLORS.length],
      org_role: row.role,
      active: true,
      kind: 'person',
      plannable_hours: org.default_plannable_hours,
      message_retention_days: await inheritedRetention(ctx, { email: row.email }),
      // accepted_at ABSENT: the seat IS the invitation (profiles.create)
      created_at: now,
    })
    await audit(ctx, {
      actor_auth_id: actor.auth_user_id,
      actor_email: actor.email,
      action: 'invite_member',
      target_org_id: org.id,
      target_profile_id: id,
      detail: { email: row.email, role: row.role },
    })
    ids.push(id)
  }
  if (rows.length > 0) {
    await markBillingMembershipChanged(
      ctx,
      org.id,
      rows.map((row) => row.email),
    )
  }
  return ids
}

/* The organization, its first people and its billing, in one transaction,
 * so any refusal leaves nothing behind. Mirrors identity.createOrganization's
 * defaults. The address comes from the name unless one is chosen, the
 * starter team is named after the organization (led by the first org admin
 * when one is invited) and the starter labels are added. */
export const insertOrganization = internalMutation({
  args: {
    name: v.string(),
    slug: v.optional(v.string()),
    plan_id: v.optional(v.string()),
    complimentary_months: v.optional(v.number()),
    people: v.array(vPerson),
    actor: vActor,
  },
  handler: async (ctx, a): Promise<{ org_id: string; profile_ids: string[] }> => {
    const name = a.name.trim()
    require(name !== '', rule('The organization needs a name.'))
    let slug: string
    if (a.slug === undefined || a.slug.trim() === '') slug = await generateSlug(ctx, name)
    else {
      slug = a.slug.trim().toLowerCase()
      await assertSlugAvailable(ctx, slug)
    }
    if (a.plan_id !== undefined) {
      const plan = await byId(ctx, 'billing_plans', a.plan_id)
      require(plan !== null && !plan.archived, notFound('plan not found'))
    }

    const now = new Date().toISOString()
    const orgId = newUuid()
    await ctx.db.insert('organizations', { id: orgId, name, slug, ...newOrgDefaults(now) })
    const org = await byId(ctx, 'organizations', orgId)
    require(org !== null, notFound('organization not found'))
    await createStarterLabels(ctx, { org_id: orgId, now })
    const profileIds = await addPeople(ctx, org, a.people, a.actor)
    const firstAdmin = profileIds.find((_, i) => a.people[i].role === 'admin')
    await createStarterTeam(ctx, { org_id: orgId, name, leader_id: firstAdmin, now })

    await enrollOrganization(ctx, orgId, a.plan_id)
    let complimentaryUntil: string | null = null
    if (a.complimentary_months !== undefined) {
      const grant = await grantComplimentaryMonths(ctx, orgId, a.complimentary_months)
      complimentaryUntil = grant.until
      await audit(ctx, {
        actor_auth_id: a.actor.auth_user_id,
        actor_email: a.actor.email,
        action: 'billing.grant_complimentary',
        target_org_id: orgId,
        detail: { months: a.complimentary_months, until: grant.until, plan_id: grant.plan_id },
      })
    }
    await audit(ctx, {
      actor_auth_id: a.actor.auth_user_id,
      actor_email: a.actor.email,
      action: 'create_org',
      target_org_id: orgId,
      detail: {
        name,
        slug,
        plan_id: a.plan_id ?? null,
        complimentary_until: complimentaryUntil,
        people: profileIds.length,
      },
    })
    return { org_id: orgId, profile_ids: profileIds }
  },
})

export const insertPeople = internalMutation({
  args: { org_id: v.string(), people: v.array(vPerson), actor: vActor },
  handler: async (ctx, a): Promise<string[]> => {
    require(a.people.length > 0, rule('Add at least one person.'))
    const org = await byId(ctx, 'organizations', a.org_id)
    require(org !== null, notFound('organization not found'))
    return await addPeople(ctx, org, a.people, a.actor)
  },
})

/* ------------------------------------------------------------ public doors */

export const createOrganization = platformAction({
  args: {
    name: v.string(),
    slug: v.optional(v.string()),
    plan_id: v.optional(v.string()),
    complimentary_months: v.optional(v.number()),
    people: v.array(vPerson),
  },
  handler: async (ctx, args): Promise<{ org_id: string; invites: InviteResult[] }> => {
    const created = await ctx.runMutation(internal.adminOrgs.insertOrganization, {
      ...args,
      actor: { auth_user_id: ctx.operator.auth_user_id, email: ctx.operator.email },
    })
    const invites = await sendInvites(
      ctx,
      created.profile_ids.map((profile_id) => ({ profile_id })),
      { resend: false, operator: ctx.operator },
    )
    return { org_id: created.org_id, invites }
  },
})

export const invitePeople = platformAction({
  args: { org_id: v.string(), people: v.array(vPerson) },
  handler: async (ctx, args): Promise<{ invites: InviteResult[] }> => {
    const ids = await ctx.runMutation(internal.adminOrgs.insertPeople, {
      ...args,
      actor: { auth_user_id: ctx.operator.auth_user_id, email: ctx.operator.email },
    })
    const invites = await sendInvites(
      ctx,
      ids.map((profile_id) => ({ profile_id })),
      { resend: false, operator: ctx.operator },
    )
    return { invites }
  },
})

export const resendInvite = platformAction({
  args: { profile_id: v.string() },
  handler: async (ctx, { profile_id }): Promise<InviteResult> => {
    const [result] = await sendInvites(ctx, [{ profile_id }], {
      resend: true,
      operator: ctx.operator,
      strict: true,
    })
    return result
  },
})

/* Corrects an active pending seat's name or address. A new address is judged
 * like a new invitation, so an address with any non-guest seat elsewhere,
 * claimed or pending, is refused. Returns whether the address changed, so the
 * action knows to email it. */
export const updateInvite = internalMutation({
  args: { profile_id: v.string(), name: v.string(), email: v.string(), actor: vActor },
  handler: async (ctx, a): Promise<{ email_changed: boolean }> => {
    const seat = await byId(ctx, 'profiles', a.profile_id)
    require(seat !== null &&
      seat.kind === 'person' &&
      seat.auth_user_id === undefined &&
      seat.active &&
      seat.org_role !== 'guest', notFound('invitation not found'))
    const name = cleanName(a.name)
    assertNameShape(name)
    const email = normalizeEmail(a.email)
    if (email === undefined) throw rule(`${name} needs an email address.`)
    if (!EMAIL_SHAPE.test(email)) throw rule(`${email} is not an email address.`)
    const patch: { name?: string; initials?: string; email?: string } = {}
    if (name !== seat.name) {
      patch.name = name
      patch.initials = nameInitials(name)
    }
    const emailChanged = email !== seat.email
    if (emailChanged) {
      const dup = await ctx.db
        .query('profiles')
        .withIndex('by_org_email', (q) => q.eq('org_id', seat.org_id).eq('email', email))
        .first()
      if (dup !== null) throw rule(`${email} already has a seat in this organization`)
      const home = await homeElsewhere(ctx, email, seat.org_id)
      if (home !== null) throw memberElsewhere(email, home)
      patch.email = email
    }
    if (Object.keys(patch).length === 0) return { email_changed: false }
    await ctx.db.patch(seat._id, patch)
    await audit(ctx, {
      actor_auth_id: a.actor.auth_user_id,
      actor_email: a.actor.email,
      action: 'edit_invite',
      target_org_id: seat.org_id,
      target_profile_id: seat.id,
      detail: {
        from: { name: seat.name, email: seat.email ?? null },
        to: { name, email },
      },
    })
    if (emailChanged) {
      await markBillingMembershipChanged(
        ctx,
        seat.org_id,
        [seat.email, email].filter((e): e is string => e !== undefined),
      )
    }
    return { email_changed: emailChanged }
  },
})

/* sent is null when the address did not change and no email went out. */
export const editInvite = platformAction({
  args: { profile_id: v.string(), name: v.string(), email: v.string() },
  handler: async (ctx, args): Promise<{ sent: boolean | null }> => {
    const { email_changed } = await ctx.runMutation(internal.adminOrgs.updateInvite, {
      ...args,
      actor: { auth_user_id: ctx.operator.auth_user_id, email: ctx.operator.email },
    })
    if (!email_changed) return { sent: null }
    // The edit is saved. A seat claimed since then needs no email.
    const [result] = await sendInvites(ctx, [{ profile_id: args.profile_id }], {
      resend: false,
      operator: ctx.operator,
    })
    return { sent: result?.sent ?? false }
  },
})

/* Removes a pending seat and everything that references it. The only
 * invited org admin can be cancelled only while nobody else is in the
 * organization, so the admin-first rule never breaks after the fact. */
export const cancelInvite = platformMutation({
  args: { profile_id: v.string() },
  handler: async (ctx, { profile_id }): Promise<null> => {
    const seat = await byId(ctx, 'profiles', profile_id)
    require(seat !== null &&
      seat.kind === 'person' &&
      seat.auth_user_id === undefined &&
      seat.org_role !== 'guest', notFound('invitation not found'))
    if (seat.org_role === 'admin' && seat.active) {
      const others = (
        await ctx.db
          .query('profiles')
          .withIndex('by_org', (q) => q.eq('org_id', seat.org_id))
          .collect()
      ).filter((p) => p.id !== seat.id)
      const otherAdmin = others.some((p) => p.org_role === 'admin' && p.active)
      require(otherAdmin || others.length === 0, rule(
        'Add another org admin before cancelling this invite.',
      ))
    }
    await removeProfile(ctx, { profile: seat, now: new Date().toISOString() })
    await audit(ctx, {
      actor_auth_id: ctx.authUserId,
      actor_email: await operatorEmail(ctx, ctx.authUserId),
      action: 'cancel_invite',
      target_org_id: seat.org_id,
      target_profile_id: seat.id,
      detail: { email: seat.email ?? null, role: seat.org_role },
    })
    await markBillingMembershipChanged(
      ctx,
      seat.org_id,
      seat.email === undefined ? [] : [seat.email],
    )
    return null
  },
})

/* The operator's role change for a person or agent, with the same guards as the
 * organization admin's profiles.update (agents are never admins, the last
 * active admin stays, a viewer leads nothing) plus the home-organization
 * fence for an invited admin. Guests are managed from project settings. */
export const setMemberRole = platformMutation({
  args: { profile_id: v.string(), role: vRole },
  handler: async (ctx, { profile_id, role }): Promise<null> => {
    const row = await byId(ctx, 'profiles', profile_id)
    require(row !== null, notFound('person not found'))
    require(row.org_role !== 'guest', rule('A guest gets access from project settings.'))
    if (row.org_role === role) return null
    if (row.kind === 'agent' && role === 'admin') {
      throw rule(
        'an agent cannot be an organization admin — it reaches only the projects it is added to',
      )
    }
    if (row.org_role === 'admin' && row.active) await assertNotLastAdmin(ctx, row, 'demote')
    if (role === 'viewer') await assertViewerLeadsNothing(ctx, row, row.name)
    if (role === 'admin' && row.auth_user_id === undefined && row.email !== undefined) {
      const home = await homeElsewhere(ctx, row.email, row.org_id, row)
      if (home !== null) throw adminElsewhere(row.email, home)
    }
    // A role change clears the project-creation right (profiles.update).
    await ctx.db.patch(row._id, { org_role: role, can_create_projects: undefined })
    await audit(ctx, {
      actor_auth_id: ctx.authUserId,
      actor_email: await operatorEmail(ctx, ctx.authUserId),
      action: 'set_member_role',
      target_org_id: row.org_id,
      target_profile_id: row.id,
      detail: { email: row.email ?? null, from: row.org_role, to: role },
    })
    await markBillingMembershipChanged(ctx, row.org_id, row.email === undefined ? [] : [row.email])
    return null
  },
})

/* --------------------------------------------------------- dialog checks */

/* The address identity.createOrganization would generate for this name. */
export const suggestAddress = platformQuery({
  args: { name: v.string() },
  handler: async (ctx, { name }): Promise<string> => await generateSlug(ctx, name.trim()),
})

/* Whether an address can be used, as the reason code the console maps to
 * its own sentence: slug_shape, slug_reserved or slug_taken. */
export const checkAddress = platformQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }): Promise<{ ok: true } | { ok: false; reason: string }> => {
    try {
      await assertSlugAvailable(ctx, slug.trim().toLowerCase())
      return { ok: true }
    } catch (e) {
      if (e instanceof ConvexError) {
        const data = e.data as Refusal
        if (data.code === 'conflict' && data.reason !== undefined) {
          return { ok: false, reason: data.reason }
        }
      }
      throw e
    }
  },
})

/* For each address, the organization that would be its home instead of
 * `org_id` (such an address cannot be invited here, and the console says so
 * before sending) and whether it already has a seat in `org_id`. Omit org_id
 * for a new organization. */
export const checkPeople = platformQuery({
  args: { org_id: v.optional(v.string()), emails: v.array(v.string()) },
  handler: async (
    ctx,
    { org_id, emails },
  ): Promise<Array<{ email: string; home_org_name: string | null; in_org: boolean }>> => {
    require(emails.length <= MAX_PEOPLE, rule(`Check at most ${MAX_PEOPLE} addresses at a time.`))
    const out: Array<{ email: string; home_org_name: string | null; in_org: boolean }> = []
    for (const raw of emails) {
      const email = normalizeEmail(raw)
      if (email === undefined) continue
      const home = await homeElsewhere(ctx, email, org_id)
      const inOrg =
        org_id !== undefined &&
        (await ctx.db
          .query('profiles')
          .withIndex('by_org_email', (q) => q.eq('org_id', org_id).eq('email', email))
          .first()) !== null
      out.push({ email, home_org_name: home?.name ?? null, in_org: inOrg })
    }
    return out
  },
})

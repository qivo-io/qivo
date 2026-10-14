/* Invitation email for pending seats, shared by the operator console
 * (adminOrgs.ts) and the app's own invitations. The app sends one when an org
 * admin adds a person (profiles.create), corrects a pending person's address
 * or reactivates a pending person who was never emailed at that address
 * (profiles.update), or when an org admin or project lead invites a new
 * project guest (projects.inviteGuest).
 *
 * Every letter says "{organization} has invited you to join their
 * organization", ending in "as a guest" when the seat is a guest seat or will
 * become one when it is claimed, because its address has a home organization
 * elsewhere. The link opens sign-in for an address that already has a login
 * and account creation otherwise. Either way the verified address claims the
 * seat (identity.claimSeatsForLogin).
 *
 * Every attempt is recorded as an 'invite_email' platform audit row, with
 * the operator as actor for console sends and 'system' for the app's.
 * admin.orgDetail shows the newest one for the seat's current address. The
 * app's sends are capped per organization and per seat, because any org
 * admin can trigger them and they leave from the shared no-reply inbox. */

import { type Infer, v } from 'convex/values'
import { components, internal } from './_generated/api'
import type { ActionCtx, QueryCtx } from './_generated/server'
import { internalAction, internalMutation, internalQuery } from './_generated/server'
import { byId } from './lib/db'
import { notFound } from './lib/functions'
import { sendInviteEmail } from './mail'
import { audit } from './model/admin'
import { newUuid } from './model/orgs'
import { homeElsewhere } from './model/people'

export type InviteResult = { profile_id: string; email: string; sent: boolean }

/* One seat to email. The app schedules the address it saw, so a send that a
 * later correction superseded is skipped, and a reactivation sends only if
 * that address was never emailed (unless_sent). */
const vInvite = v.object({
  profile_id: v.string(),
  email: v.optional(v.string()),
  unless_sent: v.optional(v.boolean()),
})
export type ScheduledInvite = Infer<typeof vInvite>

const vActor = v.object({ auth_user_id: v.optional(v.string()), email: v.string() })
type Actor = Infer<typeof vActor>

/* App sends allowed per organization per hour and per seat per day. Attempts
 * over the cap are recorded as not sent. */
const APP_SENDS_PER_ORG_HOUR = 50
const APP_SENDS_PER_SEAT_DAY = 5

type InviteTarget = {
  profile_id: string
  org_id: string
  org_name: string
  email: string
  has_account: boolean
  as_guest: boolean
  limited: boolean
}

/* invite_email rows since `since` for one organization or one seat. */
async function recentSends(
  ctx: QueryCtx,
  by: { org_id: string } | { profile_id: string },
  since: string,
): Promise<Array<{ detail: { email?: unknown; sent?: unknown } }>> {
  const rows =
    'org_id' in by
      ? ctx.db
          .query('platform_audit_log')
          .withIndex('by_target_org', (q) => q.eq('target_org_id', by.org_id).gt('ts', since))
      : ctx.db
          .query('platform_audit_log')
          .withIndex('by_target_profile', (q) =>
            q.eq('target_profile_id', by.profile_id).gt('ts', since),
          )
  const out: Array<{ detail: { email?: unknown; sent?: unknown } }> = []
  for await (const row of rows) {
    if (row.action === 'invite_email') out.push(row as { detail: { email?: unknown } })
  }
  return out
}

/* The seats to email. An invitation is an active person seat with an address
 * and no login yet. For the operator, anything else is uniformly not found,
 * and guest seats are too, because org admins and project leads invite
 * guests, not the operator. For the app, a seat claimed, removed, deactivated
 * or readdressed before its scheduled send is skipped. */
export const targets = internalQuery({
  args: { invites: v.array(vInvite), operator: v.boolean() },
  handler: async (ctx, { invites, operator }): Promise<InviteTarget[]> => {
    const now = Date.now()
    const out: InviteTarget[] = []
    for (const invite of invites) {
      const seat = await byId(ctx, 'profiles', invite.profile_id)
      const email = seat?.email
      if (
        seat === null ||
        email === undefined ||
        seat.kind !== 'person' ||
        seat.auth_user_id !== undefined ||
        !seat.active ||
        (operator && seat.org_role === 'guest')
      ) {
        if (operator) throw notFound('invitation not found')
        continue
      }
      const org = await byId(ctx, 'organizations', seat.org_id)
      if (org === null) {
        if (operator) throw notFound('organization not found')
        continue
      }
      let limited = false
      if (!operator) {
        if (invite.email !== undefined && invite.email !== email) continue
        const daySends = await recentSends(
          ctx,
          { profile_id: seat.id },
          new Date(now - 86_400_000).toISOString(),
        )
        if (invite.unless_sent) {
          const ever = await recentSends(ctx, { profile_id: seat.id }, '')
          if (ever.some((r) => r.detail.email === email && r.detail.sent === true)) continue
        }
        const hourSends = await recentSends(
          ctx,
          { org_id: org.id },
          new Date(now - 3_600_000).toISOString(),
        )
        limited =
          daySends.length >= APP_SENDS_PER_SEAT_DAY || hourSends.length >= APP_SENDS_PER_ORG_HOUR
      }
      const account = await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: 'user',
        where: [{ field: 'email', value: email }],
      })
      out.push({
        profile_id: seat.id,
        org_id: org.id,
        org_name: org.name,
        email,
        has_account: account !== null,
        as_guest:
          seat.org_role === 'guest' ||
          (await homeElsewhere(ctx, email, seat.org_id, seat)) !== null,
        limited,
      })
    }
    return out
  },
})

export const record = internalMutation({
  args: {
    profile_id: v.string(),
    org_id: v.string(),
    email: v.string(),
    sent: v.boolean(),
    resend: v.boolean(),
    limited: v.boolean(),
    actor: vActor,
  },
  handler: async (ctx, a) => {
    await audit(ctx, {
      ...(a.actor.auth_user_id !== undefined ? { actor_auth_id: a.actor.auth_user_id } : {}),
      actor_email: a.actor.email,
      action: 'invite_email',
      target_org_id: a.org_id,
      target_profile_id: a.profile_id,
      detail: {
        email: a.email,
        sent: a.sent,
        resend: a.resend,
        ...(a.limited ? { limited: true } : {}),
      },
    })
  },
})

/* Sign in for an existing login, create an account otherwise. Both pages
 * offer the other. */
const joinUrl = (hasAccount: boolean) => `${process.env.SITE_URL}/app${hasAccount ? '' : '#signup'}`

/* Bounds a batch's wait. Letters still unsent when the budget runs out count
 * as not sent, and the console offers the sign-up link for them. */
const SEND_BUDGET_MS = 60_000
const SEND_CONCURRENCY = 5

/* One email per seat, a few at a time, results in input order. Mail never
 * fails the caller. The seats exist already, so an unsent invitation is
 * reported and recorded, not thrown. Without an operator the actor is
 * 'system', seats that are no longer invitations are skipped, and the app's
 * caps apply. */
export async function sendInvites(
  ctx: ActionCtx,
  invites: ScheduledInvite[],
  opts: { resend: boolean; operator?: { auth_user_id: string; email: string } },
): Promise<InviteResult[]> {
  if (invites.length === 0) return []
  const list = await ctx.runQuery(internal.invites.targets, {
    invites,
    operator: opts.operator !== undefined,
  })
  const deadline = Date.now() + SEND_BUDGET_MS
  const actor: Actor = opts.operator ?? { email: 'system' }
  const results: InviteResult[] = []
  const sendOne = async (target: InviteTarget, i: number) => {
    const sent =
      !target.limited &&
      (await sendInviteEmail({
        to: target.email,
        org_name: target.org_name,
        as_guest: target.as_guest,
        url: joinUrl(target.has_account),
        send_key: `invite:${target.profile_id}:${newUuid()}`,
        deadline,
      }))
    await ctx.runMutation(internal.invites.record, {
      profile_id: target.profile_id,
      org_id: target.org_id,
      email: target.email,
      sent,
      resend: opts.resend,
      limited: target.limited,
      actor,
    })
    results[i] = { profile_id: target.profile_id, email: target.email, sent }
  }
  let next = 0
  const worker = async () => {
    while (next < list.length) {
      const i = next++
      await sendOne(list[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, list.length) }, worker))
  return results
}

/* The app's invitations, scheduled by the mutation that created, corrected
 * or reactivated the seat once it commits. */
export const sendFromApp = internalAction({
  args: { invites: v.array(vInvite) },
  handler: async (ctx, { invites }): Promise<null> => {
    await sendInvites(ctx, invites, { resend: false })
    return null
  },
})

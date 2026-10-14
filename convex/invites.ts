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
 * Every attempt is recorded as an 'invite_email' platform audit row before it
 * is sent, with the operator as actor for console sends and 'system' for the
 * app's, whose rows carry channel 'app'.
 * admin.orgDetail shows the newest one for the seat's current address. The
 * app's sends are capped per organization, because any org admin can trigger
 * them and they leave from the shared no-reply inbox. Past the cap, people
 * can still join by creating an account with the invited address. */

import { type Infer, v } from 'convex/values'
import { components, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
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

/* App sends allowed per organization per hour, counting console sends too.
 * Attempts over the cap are recorded as held back and do not count. */
const APP_SENDS_PER_ORG_HOUR = 50

type InviteTarget = {
  profile_id: string
  org_id: string
  org_name: string
  email: string
  has_account: boolean
  as_guest: boolean
}

type SendRow = { detail: { email?: unknown; sent?: unknown; limited?: unknown } }

/* invite_email rows since `since` for one organization or one seat. */
async function recentSends(
  ctx: QueryCtx,
  by: { org_id: string } | { profile_id: string },
  since: string,
): Promise<SendRow[]> {
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
  const out: SendRow[] = []
  for await (const row of rows) {
    if (row.action === 'invite_email') out.push(row as SendRow)
  }
  return out
}

/* The seats to email. An invitation is an active person seat with an address
 * and no login yet. The operator never emails a guest seat, because org
 * admins and project leads invite guests. With `strict` (an explicit resend
 * or edit) anything else is uniformly not found. Otherwise a seat that stopped
 * being an invitation since it was saved, for example one claimed at once, is
 * skipped. For the app, a seat readdressed before its scheduled send is
 * skipped too. */
export const targets = internalQuery({
  args: { invites: v.array(vInvite), operator: v.boolean(), strict: v.boolean() },
  handler: async (ctx, { invites, operator, strict }): Promise<InviteTarget[]> => {
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
        if (strict) throw notFound('invitation not found')
        continue
      }
      const org = await byId(ctx, 'organizations', seat.org_id)
      if (org === null) {
        if (strict) throw notFound('organization not found')
        continue
      }
      if (!operator) {
        if (invite.email !== undefined && invite.email !== email) continue
        if (invite.unless_sent) {
          const ever = await recentSends(ctx, { profile_id: seat.id }, '')
          if (ever.some((r) => r.detail.email === email && r.detail.sent === true)) continue
        }
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
      })
    }
    return out
  },
})

/* Records one send before it happens, as not sent yet, and settle() records
 * the outcome. For the app, the count and the new row commit in one
 * transaction, so concurrent sends cannot both take the last slot under the
 * cap. An app send over the cap is recorded as held back, and allowed is
 * false. App rows carry channel 'app', which keeps them out of the operator's
 * audit listing. */
export const reserve = internalMutation({
  args: {
    profile_id: v.string(),
    org_id: v.string(),
    email: v.string(),
    resend: v.boolean(),
    actor: vActor,
    app: v.boolean(),
  },
  handler: async (ctx, a): Promise<{ row: Id<'platform_audit_log'>; allowed: boolean }> => {
    let allowed = true
    if (a.app) {
      const since = new Date(Date.now() - 3_600_000).toISOString()
      const recent = await recentSends(ctx, { org_id: a.org_id }, since)
      allowed = recent.filter((r) => r.detail.limited !== true).length < APP_SENDS_PER_ORG_HOUR
    }
    const row = await audit(ctx, {
      ...(a.actor.auth_user_id !== undefined ? { actor_auth_id: a.actor.auth_user_id } : {}),
      actor_email: a.actor.email,
      action: 'invite_email',
      target_org_id: a.org_id,
      target_profile_id: a.profile_id,
      ...(a.app ? { channel: 'app' as const } : {}),
      detail: {
        email: a.email,
        sent: false,
        resend: a.resend,
        ...(allowed ? {} : { limited: true }),
      },
    })
    return { row, allowed }
  },
})

/* Records whether a reserved send went out. */
export const settle = internalMutation({
  args: { row: v.id('platform_audit_log'), sent: v.boolean() },
  handler: async (ctx, { row, sent }) => {
    const entry = await ctx.db.get(row)
    if (entry === null) return
    await ctx.db.patch(row, { detail: { ...(entry.detail as object), sent } })
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
 * 'system', the app's cap applies, and seats that are no longer invitations
 * are skipped. With an operator, `strict` refuses them instead. */
export async function sendInvites(
  ctx: ActionCtx,
  invites: ScheduledInvite[],
  opts: {
    resend: boolean
    operator?: { auth_user_id: string; email: string }
    strict?: boolean
  },
): Promise<InviteResult[]> {
  if (invites.length === 0) return []
  const app = opts.operator === undefined
  const list = await ctx.runQuery(internal.invites.targets, {
    invites,
    operator: !app,
    strict: opts.strict === true,
  })
  const deadline = Date.now() + SEND_BUDGET_MS
  const actor: Actor = opts.operator ?? { email: 'system' }
  const results: InviteResult[] = []
  const sendOne = async (target: InviteTarget, i: number) => {
    const { row, allowed } = await ctx.runMutation(internal.invites.reserve, {
      profile_id: target.profile_id,
      org_id: target.org_id,
      email: target.email,
      resend: opts.resend,
      actor,
      app,
    })
    const sent =
      allowed &&
      (await sendInviteEmail({
        to: target.email,
        org_name: target.org_name,
        as_guest: target.as_guest,
        url: joinUrl(target.has_account),
        send_key: `invite:${target.profile_id}:${newUuid()}`,
        deadline,
      }))
    if (sent) await ctx.runMutation(internal.invites.settle, { row, sent })
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

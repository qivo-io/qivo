import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalAction, internalMutation, internalQuery } from './_generated/server'
import { billingEnabled, subscriptionFor } from './lib/billingAccess'
import { byId } from './lib/db'
import { sendBillingReminder } from './mail'
import { audit } from './model/admin'

const input = {
  to: v.string(),
  url: v.string(),
  until: v.string(),
  notice_key: v.string(),
  attempt: v.optional(v.number()),
}
type Input = { to: string; url: string; until: string; notice_key: string; attempt?: number }
type Delivery = { to: string; url: string; until: string }
const sendRef = makeFunctionReference<'action', Input, null>('billingMail:send')
const readyRef = makeFunctionReference<'query', { key: string }, Delivery | null>(
  'billingMail:ready',
)
const sentRef = makeFunctionReference<'mutation', { key: string }, null>('billingMail:sent')
const unsentRef = makeFunctionReference<'mutation', { key: string; attempts: number }, null>(
  'billingMail:unsent',
)

/** The hourly attempts after the first one, for a billing reminder and for
 * orgRemovals.ts's deletion notice. */
export const NOTICE_RETRIES = 24

export const ready = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }): Promise<Delivery | null> => {
    const notice = await ctx.db
      .query('billing_notices')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique()
    if (!notice || notice.sent_at) return null
    const sub = await subscriptionFor(ctx, notice.org_id)
    if (!sub?.complimentary_until || sub.polar_subscription_id) return null
    if (key !== `${sub.id}:${sub.complimentary_until}:${notice.profile_id}:${notice.kind}`)
      return null
    const remaining = Date.parse(sub.complimentary_until) - Date.now()
    const kind =
      remaining <= 0
        ? 'expired'
        : remaining <= 86_400_000
          ? 'one_day'
          : remaining <= 7 * 86_400_000
            ? 'seven_days'
            : null
    if (notice.kind !== kind) return null
    const profile = await byId(ctx, 'profiles', notice.profile_id)
    if (
      !profile?.active ||
      profile.org_role !== 'admin' ||
      profile.org_id !== notice.org_id ||
      !profile.email
    )
      return null
    const org = await byId(ctx, 'organizations', notice.org_id)
    const base = process.env.SITE_URL
    if (!org || !base) return null
    return {
      to: profile.email,
      until: sub.complimentary_until,
      url: `${base.replace(/\/$/, '')}/app/${encodeURIComponent(org.slug)}/settings/org-billing`,
    }
  },
})
export const sent = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const notice = await ctx.db
      .query('billing_notices')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique()
    if (notice && !notice.sent_at)
      await ctx.db.patch(notice._id, { sent_at: new Date().toISOString() })
    return null
  },
})
/** Records in the operator's audit log that a billing reminder or a
 * deletion notice (orgRemovals.ts) was never delivered: its last hourly
 * attempt failed, or it stopped being due (a later reminder took over, the
 * grant changed, the admin left) after `attempts` failed ones. The failure
 * is then not only a log line. */
export const unsent = internalMutation({
  args: { key: v.string(), attempts: v.number() },
  handler: async (ctx, { key, attempts }) => {
    const reason = attempts > NOTICE_RETRIES ? 'out_of_attempts' : 'no_longer_due'
    const notice = await ctx.db
      .query('billing_notices')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique()
    if (!notice || notice.sent_at) return null
    await audit(ctx, {
      actor_email: 'system',
      action: 'notice_email_unsent',
      target_org_id: notice.org_id,
      target_profile_id: notice.profile_id,
      detail: { kind: notice.kind, attempts, reason },
    })
    return null
  },
})
export const send = internalAction({
  args: input,
  handler: async (ctx, args): Promise<null> => {
    if (!billingEnabled()) return null
    const delivery = await ctx.runQuery(readyRef, { key: args.notice_key })
    if (!delivery) {
      const failed = args.attempt ?? 0
      if (failed > 0) await ctx.runMutation(unsentRef, { key: args.notice_key, attempts: failed })
      return null
    }
    if (
      await sendBillingReminder({
        ...delivery,
        notice_key: args.notice_key,
        attempt: args.attempt ?? 0,
      })
    )
      await ctx.runMutation(sentRef, { key: args.notice_key })
    else if ((args.attempt ?? 0) < NOTICE_RETRIES)
      await ctx.scheduler.runAfter(60 * 60_000, sendRef, {
        ...args,
        attempt: (args.attempt ?? 0) + 1,
      })
    else await ctx.runMutation(unsentRef, { key: args.notice_key, attempts: NOTICE_RETRIES + 1 })
    return null
  },
})

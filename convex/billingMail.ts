import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalAction, internalMutation, internalQuery } from './_generated/server'
import { billingEnabled, subscriptionFor } from './lib/billingAccess'
import { byId } from './lib/db'
import { sendBillingReminder } from './mail'

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
export const send = internalAction({
  args: input,
  handler: async (ctx, args): Promise<null> => {
    if (!billingEnabled()) return null
    const delivery = await ctx.runQuery(readyRef, { key: args.notice_key })
    if (!delivery) return null
    if (await sendBillingReminder({ ...delivery, notice_key: args.notice_key }))
      await ctx.runMutation(sentRef, { key: args.notice_key })
    else if ((args.attempt ?? 0) < 24)
      await ctx.scheduler.runAfter(60 * 60_000, sendRef, {
        ...args,
        attempt: (args.attempt ?? 0) + 1,
      })
    return null
  },
})

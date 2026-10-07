import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

type WebhookHealth = Pick<
  Doc<'webhook_health'>,
  'failed_since' | 'last_failure_at' | 'last_success_at' | 'last_status'
>

function healthRow(ctx: QueryCtx, subscription: Id<'webhook_subscriptions'>) {
  return ctx.db
    .query('webhook_health')
    .withIndex('by_subscription', (q) => q.eq('subscription_row_id', subscription))
    .unique()
}

/** A stored health row owns absent fields too. Never revive a cleared legacy streak. */
export async function readWebhookHealth(
  ctx: QueryCtx,
  subscription: Doc<'webhook_subscriptions'>,
): Promise<WebhookHealth> {
  const source = (await healthRow(ctx, subscription._id)) ?? subscription
  return {
    failed_since: source.failed_since,
    last_failure_at: source.last_failure_at,
    last_success_at: source.last_success_at,
    last_status: source.last_status,
  }
}

/** Persist immediate delivery health without rewriting event subscription configuration. */
export async function writeWebhookHealth(
  ctx: MutationCtx,
  subscription: Doc<'webhook_subscriptions'>,
  patch: Partial<WebhookHealth>,
): Promise<void> {
  const existing = await healthRow(ctx, subscription._id)
  if (existing) {
    await ctx.db.patch(existing._id, patch)
    return
  }
  await ctx.db.insert('webhook_health', {
    subscription_row_id: subscription._id,
    org_id: subscription.org_id,
    failed_since: subscription.failed_since,
    last_failure_at: subscription.last_failure_at,
    last_success_at: subscription.last_success_at,
    last_status: subscription.last_status,
    ...patch,
  })
}

/** Remove a registration and the health belonging to that exact database row. */
export async function removeWebhookSubscription(
  ctx: MutationCtx,
  subscription: Doc<'webhook_subscriptions'>,
): Promise<void> {
  const health = await healthRow(ctx, subscription._id)
  if (health) await ctx.db.delete(health._id)
  await ctx.db.delete(subscription._id)
}

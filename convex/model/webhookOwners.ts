import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { removeWebhookSubscription } from './webhookHealth'

async function ownerWasRemoved(
  ctx: QueryCtx,
  subscription: Doc<'webhook_subscriptions'>,
): Promise<boolean> {
  const { owner } = subscription
  const profile = await byId(ctx, 'profiles', owner.profile_id)
  if (!profile || profile.org_id !== subscription.org_id) return true
  const credential = await byId(ctx, owner.credential_table, owner.credential_id)
  if (
    !credential ||
    credential._id !== owner.credential_row_id ||
    credential.profile_id !== owner.profile_id ||
    credential.revoked_at !== undefined
  )
    return true
  return (
    'auth_user_id' in credential &&
    (credential.auth_user_id !== profile.auth_user_id || credential.org_id !== profile.org_id)
  )
}

/** Reclaim removed owners' quota while preserving temporarily suspended subscriptions. */
export async function pruneRemovedWebhookOwners(
  ctx: MutationCtx,
  subscriptions: Doc<'webhook_subscriptions'>[],
): Promise<Doc<'webhook_subscriptions'>[]> {
  const removedOwners = new Map<string, boolean>()
  const retained: Doc<'webhook_subscriptions'>[] = []
  for (const subscription of subscriptions) {
    const { owner } = subscription
    const key = JSON.stringify([
      subscription.org_id,
      owner.profile_id,
      owner.credential_table,
      owner.credential_id,
      owner.credential_row_id,
    ])
    let removed = removedOwners.get(key)
    if (removed === undefined) {
      removed = await ownerWasRemoved(ctx, subscription)
      removedOwners.set(key, removed)
    }
    if (removed) await removeWebhookSubscription(ctx, subscription)
    else retained.push(subscription)
  }
  return retained
}

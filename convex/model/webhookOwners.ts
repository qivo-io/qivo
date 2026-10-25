import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { findAuthUser, findOAuthClient, tokenExpired } from '../lib/access'
import { byId } from '../lib/db'
import { removeWebhookSubscription } from './webhookHealth'

/* Whether the subscription's owner can never authorize it again. The profile
 * is gone or moved, the credential was deleted, replaced, revoked or, for a
 * personal token, expired, the person's login is gone from Better Auth, or,
 * for an OAuth grant, its client is. Nothing extends a token's expiry, and
 * nothing in Qivo restores a login or a client, so each is as dead as a
 * revocation. Deactivation, a ban, a disabled client and a client that lost
 * its link to the MCP resource can be undone, and keep it. */
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
    credential.revoked_at !== undefined ||
    ('token_hash' in credential && tokenExpired(credential, Date.now()))
  )
    return true
  if (
    'auth_user_id' in credential &&
    (credential.auth_user_id !== profile.auth_user_id || credential.org_id !== profile.org_id)
  )
    return true
  // the Better Auth reads come last, after the app's own rows
  if ('client_id' in credential && (await findOAuthClient(ctx, credential.client_id)) === null)
    return true
  // a personal token or a grant acts as its person's login (taskEvents.ts
  // eventOwner); an agent key belongs to none
  return (
    owner.credential_table !== 'agent_keys' &&
    profile.auth_user_id !== undefined &&
    (await findAuthUser(ctx, profile.auth_user_id)) === null
  )
}

/** For each of `subscriptions`, whether its owner can never authorize it
 * again (ownerWasRemoved), each owner judged once. The next registration in
 * the organization removes those (pruneRemovedWebhookOwners), so they hold
 * no quota, and the organization's list shows them as unauthorized. */
export async function ownersRemoved(
  ctx: QueryCtx,
  subscriptions: readonly Doc<'webhook_subscriptions'>[],
): Promise<boolean[]> {
  const removedOwners = new Map<string, boolean>()
  const out: boolean[] = []
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
    out.push(removed)
  }
  return out
}

/** Reclaim removed owners' quota while preserving temporarily suspended subscriptions. */
export async function pruneRemovedWebhookOwners(
  ctx: MutationCtx,
  subscriptions: Doc<'webhook_subscriptions'>[],
): Promise<Doc<'webhook_subscriptions'>[]> {
  const removed = await ownersRemoved(ctx, subscriptions)
  const retained: Doc<'webhook_subscriptions'>[] = []
  for (const [at, subscription] of subscriptions.entries()) {
    if (removed[at]) await removeWebhookSubscription(ctx, subscription)
    else retained.push(subscription)
  }
  return retained
}

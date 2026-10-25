import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { findAuthUser, findOAuthClient, tokenExpired } from '../lib/access'
import { byId } from '../lib/db'
import { eventOwner } from './taskEvents'
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

/** For each of `subscriptions`, `judge`'s answer for its owner, each owner
 * judged once. */
async function perOwner<R>(
  subscriptions: readonly Doc<'webhook_subscriptions'>[],
  judge: (subscription: Doc<'webhook_subscriptions'>) => Promise<R>,
): Promise<R[]> {
  const judged = new Map<string, R>()
  const out: R[] = []
  for (const subscription of subscriptions) {
    const { owner } = subscription
    const key = JSON.stringify([
      subscription.org_id,
      owner.profile_id,
      owner.credential_table,
      owner.credential_id,
      owner.credential_row_id,
    ])
    let answer = judged.get(key)
    if (answer === undefined) {
      answer = await judge(subscription)
      judged.set(key, answer)
    }
    out.push(answer)
  }
  return out
}

/** How a subscription's owner stands. `removed`: it can never authorize the
 * subscription again (ownerWasRemoved), so the next registration in the
 * organization removes it, and it holds no quota. `suspended`: Qivo refuses
 * the owner for now, as for a deactivated account, a banned login, or a
 * disabled client or one without its link to the MCP resource, so the
 * subscription receives nothing (taskEvents.ts eventOwner, which every
 * event's fan-out, expansion and delivery asks) but keeps its quota, and
 * resumes delivery once the owner is allowed again. `live` otherwise. */
export type OwnerStanding = 'removed' | 'suspended' | 'live'

/** For each of `subscriptions`, how its owner stands (OwnerStanding), for
 * the organization's list. */
export const ownerStandings = (
  ctx: QueryCtx,
  subscriptions: readonly Doc<'webhook_subscriptions'>[],
): Promise<OwnerStanding[]> =>
  perOwner(subscriptions, async (subscription) =>
    (await ownerWasRemoved(ctx, subscription))
      ? 'removed'
      : (await eventOwner(ctx, subscription.owner)) === null
        ? 'suspended'
        : 'live',
  )

/** Reclaim removed owners' quota while preserving temporarily suspended subscriptions. */
export async function pruneRemovedWebhookOwners(
  ctx: MutationCtx,
  subscriptions: Doc<'webhook_subscriptions'>[],
): Promise<Doc<'webhook_subscriptions'>[]> {
  const removed = await perOwner(subscriptions, (subscription) =>
    ownerWasRemoved(ctx, subscription),
  )
  const retained: Doc<'webhook_subscriptions'>[] = []
  for (const [at, subscription] of subscriptions.entries()) {
    if (removed[at]) await removeWebhookSubscription(ctx, subscription)
    else retained.push(subscription)
  }
  return retained
}

import type { GenericCtx } from '../../vendor/convex-better-auth/src/client'
import { components } from '../_generated/api'
import type { DataModel } from '../_generated/dataModel'

/** A Microsoft object or tenant id: a GUID, which a `sub` never is. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The Microsoft identity of one sign-in, which recordMicrosoftTenant writes
 * once Better Auth has created or updated the account. One auth options
 * object serves one request (auth.ts), so this holds one sign-in's. */
export type MicrosoftSignIn = { oid: string; tid: string | null } | null

/** The tenant of a Microsoft ID token: its `tid`, when it is a GUID and the
 * token's issuer names it, the check Better Auth's Microsoft provider makes
 * of a token it verifies. Otherwise null. */
function tenantOf(profile: { tid?: unknown; iss?: unknown }): string | null {
  const tid = profile.tid
  if (typeof tid !== 'string' || !GUID.test(tid)) return null
  return profile.iss === `https://login.microsoftonline.com/${tid}/v2.0` ? tid : null
}

/** Moves a Microsoft account Better Auth 1.6 keyed by the ID token's `sub`
 * to the `oid` key 1.7 looks it up by (betterAuth/accounts.ts), and returns
 * the sign-in's `oid` and tenant. Better Auth gives the provider's
 * mapProfileToUser the decoded ID token, which came from Microsoft's token
 * endpoint with Qivo's client secret, or which Better Auth verified when the
 * client sent it, and calls it before it resolves the account. Better Auth
 * itself trusts that token's `oid` to name the account, so this trusts
 * nothing more, and never the email, which Microsoft does not verify.
 * Without it, the 1.7 lookup misses the account: a returning login whose
 * email is unverified would be refused as not linked, and one whose email
 * changed would become a new user.
 *
 * A context that cannot run a mutation skips the move; every sign-in runs in
 * an HTTP action, which can. */
export async function rekeyMicrosoftAccount(
  ctx: GenericCtx<DataModel>,
  profile: { sub?: unknown; oid?: unknown; tid?: unknown; iss?: unknown },
): Promise<MicrosoftSignIn> {
  if (typeof profile.oid !== 'string') return null
  if ('runMutation' in ctx && typeof profile.sub === 'string')
    await ctx.runMutation(components.betterAuth.accounts.rekeyMicrosoftAccount, {
      sub: profile.sub,
      oid: profile.oid,
    })
  return { oid: profile.oid, tid: tenantOf(profile) }
}

/** Records the sign-in's tenant beside the Microsoft account Better Auth just
 * created or updated for it, so the pair (tid, oid) names the person in a
 * later login system. It stays on the server: Better Auth does not know the
 * field (betterAuth/schema.ts). A sign-in whose token has no usable tenant
 * leaves the account as it was, and a first sign-in then has none. */
export async function recordMicrosoftTenant(
  ctx: GenericCtx<DataModel>,
  account: { id: string; providerId: string; accountId: string },
  signIn: MicrosoftSignIn,
): Promise<void> {
  if (!('runMutation' in ctx) || account.providerId !== 'microsoft') return
  if (!signIn?.tid || signIn.oid !== account.accountId) return
  await ctx.runMutation(components.betterAuth.accounts.setMicrosoftTenant, {
    id: account.id,
    oid: signIn.oid,
    tid: signIn.tid,
  })
}

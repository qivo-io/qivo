import { v } from 'convex/values'
import { stream } from 'convex-helpers/server/stream'
import { mutation, query } from './_generated/server'
import schema from './schema'

/* Better Auth 1.6 keyed a Microsoft account by the ID token's `sub`, which
 * Microsoft makes different for every app. 1.7 keys it by `oid`, the user's
 * object id in their organization's directory, which is a GUID. Qivo keeps
 * no ID tokens and serves people from any organization, so no stored data
 * maps one to the other. The next Microsoft sign-in carries both, and
 * lib/microsoftAccounts.ts moves the account to `oid` then, and records the
 * token's tenant (`tid`) beside it. */

/** A Microsoft object id: a GUID, which a `sub` never is. */
const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Moves the Microsoft account keyed by `sub` to `oid`, both from one ID token.
 * Answers 'rekeyed', 'none' when no account has that `sub`, or 'conflict'
 * when another account already has that `oid`; it changes nothing then, so
 * the sign-in goes on with the account that has it. */
export const rekeyMicrosoftAccount = mutation({
  args: { sub: v.string(), oid: v.string() },
  handler: async (ctx, { sub, oid }) => {
    if (!sub || !OBJECT_ID.test(oid) || sub === oid) return 'none' as const
    const byKey = (accountId: string) =>
      ctx.db
        .query('account')
        .withIndex('accountId_providerId', (q) =>
          q.eq('accountId', accountId).eq('providerId', 'microsoft'),
        )
        .unique()
    const account = await byKey(sub)
    if (!account) return 'none' as const
    if (await byKey(oid)) return 'conflict' as const
    await ctx.db.patch(account._id, { accountId: oid, updatedAt: Date.now() })
    return 'rekeyed' as const
  },
})

/** Records `tid` as the tenant of the Microsoft account `id`, when that
 * account is keyed by `oid`. Answers whether the account now holds it. A
 * later token's tenant replaces an earlier one; for one `oid` Microsoft names
 * one tenant, the person's own, so a change is not expected. */
export const setMicrosoftTenant = mutation({
  args: { id: v.string(), oid: v.string(), tid: v.string() },
  handler: async (ctx, { id, oid, tid }) => {
    const accountId = ctx.db.normalizeId('account', id)
    const account = accountId ? await ctx.db.get(accountId) : null
    if (account?.providerId !== 'microsoft' || account.accountId !== oid) return false
    if (!OBJECT_ID.test(tid)) return false
    if (account.microsoftTenantId !== tid)
      await ctx.db.patch(account._id, { microsoftTenantId: tid })
    return true
  },
})

/** One page of the Microsoft accounts: how many there are, how many still
 * have the `sub` key of Better Auth 1.6 rather than an `oid`, and how many
 * have no tenant recorded. It reads only and returns counts. Pass `cursor`
 * back until `done`. */
export const microsoftAccountKeys = query({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await stream(ctx.db, schema)
      .query('account')
      .withIndex('providerId_userId', (q) => q.eq('providerId', 'microsoft'))
      .paginate({ cursor, numItems: 500 })
    const sub = page.page.filter((account) => !OBJECT_ID.test(account.accountId)).length
    return {
      accounts: page.page.length,
      sub,
      oid: page.page.length - sub,
      noTenant: page.page.filter((account) => !account.microsoftTenantId).length,
      cursor: page.continueCursor,
      done: page.isDone,
    }
  },
})

/** Which of `ids` name a login that exists (`live`), and which are no login
 * id at all (`invalid`), such as a string a write outside the app left. The
 * orphan sweep (files.ts reapOrphans) clears the appearance of the others,
 * whose login was removed, and keeps the invalid ones. Reads one login per
 * valid id. */
export const liveLogins = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const live: string[] = []
    const invalid: string[] = []
    for (const id of ids) {
      const userId = ctx.db.normalizeId('user', id)
      if (userId === null) invalid.push(id)
      else if (await ctx.db.get(userId)) live.push(id)
    }
    return { live, invalid }
  },
})

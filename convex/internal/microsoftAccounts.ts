/* A dry run for the Microsoft account keys of Better Auth 1.7
 * (betterAuth/accounts.ts). `count` reads only. It counts the Microsoft
 * accounts of one page and how many still have the `sub` key of Better Auth
 * 1.6, which the person's next Microsoft sign-in moves to `oid`
 * (lib/microsoftAccounts.ts), and how many have no tenant (`tid`) recorded
 * yet, which every Microsoft sign-in records. Start with `{"cursor": null}` and pass the
 * returned `cursor` back until `done` is true. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/microsoftAccounts:count '{"cursor": null}'
 * A key that may run internal queries can run it. The results hold counts
 * only. */
import { v } from 'convex/values'
import { components } from '../_generated/api'
import { internalQuery } from '../_generated/server'

/** One page of Microsoft accounts: how many, how many use `sub` or `oid`,
 * and how many lack a tenant. */
export const count = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) =>
    await ctx.runQuery(components.betterAuth.accounts.microsoftAccountKeys, { cursor }),
})

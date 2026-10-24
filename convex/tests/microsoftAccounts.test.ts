/* The Microsoft account key count (internal/microsoftAccounts.ts). */
import { describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import { newT, runInAuth } from './helpers.setup'

describe('Microsoft account key count', () => {
  it('counts the Microsoft accounts and those still keyed by sub', async () => {
    const t = newT()
    await runInAuth(t, async (ctx) => {
      const at = Date.now()
      const userId = await ctx.db.insert('user', {
        name: 'Bo',
        email: 'bo@example.test',
        emailVerified: true,
        createdAt: at,
        updatedAt: at,
      })
      for (const [providerId, accountId] of [
        ['microsoft', 'AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ'],
        ['microsoft', '00000000-0000-4000-8000-0000000000b0'],
        ['google', '1234567890'],
      ])
        await ctx.db.insert('account', {
          providerId,
          accountId,
          userId,
          createdAt: at,
          updatedAt: at,
          // the account keyed by oid has signed in on 1.7, which recorded its tenant
          ...(accountId.includes('-')
            ? { microsoftTenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47' }
            : {}),
        })
    })
    expect(
      await t.query(internal.internal.microsoftAccounts.count, { cursor: null }),
    ).toMatchObject({
      accounts: 2,
      sub: 1,
      oid: 1,
      noTenant: 1,
      done: true,
    })
  })
})

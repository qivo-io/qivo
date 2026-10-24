/* Qivo's changes to its copy of the Convex adapter for Better Auth 1.7
 * (vendor/convex-better-auth), through the component functions the adapter
 * calls, and the component schema Qivo builds from the generated one. */
import { describe, expect, it, vi } from 'vitest'
import { components } from '../_generated/api'
import authSchema from '../betterAuth/schema'
import { tables as generated } from '../betterAuth/schema.generated'
import { newT, runInAuth } from './helpers.setup'

const RESOURCE = 'https://some.convex.site/mcp'

describe('the copied Convex adapter', () => {
  it('refuses a second row for a unique index of several fields, and allows other pairs', async () => {
    const t = newT()
    const link = (clientId: string, resourceId = RESOURCE) =>
      t.mutation(components.betterAuth.adapter.create, {
        input: { model: 'oauthClientResource', data: { clientId, resourceId } },
      })
    await link('client-a')
    await link('client-b')
    await link('client-a', 'https://other.example.test/mcp')
    await expect(link('client-a')).rejects.toThrow(
      'oauthClientResource unique constraint clientId+resourceId already exists',
    )
  })

  it('deletes and returns the matching row once when two consume it at the same time', async () => {
    const t = newT()
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'verification',
        data: {
          identifier: 'code-1',
          value: 'v',
          expiresAt: Date.now() + 60_000,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })
    // consumeOne runs as deleteOne
    const consume = () =>
      t.mutation(components.betterAuth.adapter.deleteOne, {
        input: { model: 'verification', where: [{ field: 'identifier', value: 'code-1' }] },
      })
    const outcomes = await Promise.all([consume(), consume()])
    expect(outcomes.filter((row) => row != null)).toHaveLength(1)
    expect(await runInAuth(t, (ctx) => ctx.db.query('verification').collect())).toEqual([])
  })

  it('matches a field never written for eq null, and only a field that holds a value for ne null', async () => {
    const t = newT()
    for (const [token, revoked] of [
      ['live', undefined],
      ['gone', 1],
    ] as const)
      await t.mutation(components.betterAuth.adapter.create, {
        input: {
          model: 'oauthRefreshToken',
          data: { token, clientId: 'c', userId: 'u', scopes: [], ...(revoked ? { revoked } : {}) },
        },
      })
    const tokens = async (operator: 'eq' | 'ne') =>
      (
        await t.query(components.betterAuth.adapter.findMany, {
          model: 'oauthRefreshToken',
          where: [
            { field: 'clientId', value: 'c' },
            { field: 'revoked', operator, value: null },
          ],
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page.map((row: { token: string }) => row.token)
    expect(await tokens('eq')).toEqual(['live'])
    expect(await tokens('ne')).toEqual(['gone'])
  })
})

describe('index choice', () => {
  it('uses the index that covers most equality clauses and filters the rest', async () => {
    const t = newT()
    await runInAuth(t, async (ctx) => {
      const at = Date.now()
      for (const [accountId, userId] of [
        ['a', 'u1'],
        ['a', 'u2'],
        ['b', 'u1'],
      ])
        await ctx.db.insert('account', {
          accountId,
          providerId: 'credential',
          userId,
          createdAt: at,
          updatedAt: at,
        })
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // How Better Auth 1.7 looks up a password account; no index starts with all three.
      const found = await t.query(components.betterAuth.adapter.findMany, {
        model: 'account',
        where: [
          { field: 'accountId', value: 'a' },
          { field: 'providerId', value: 'credential' },
          { field: 'userId', value: 'u2' },
        ],
        paginationOpts: { numItems: 10, cursor: null },
      })
      expect(found.page.map((row: { userId: string }) => row.userId)).toEqual(['u2'])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('the component schema', () => {
  it('keeps every generated field and index of the tables it extends', () => {
    for (const name of ['account', 'oauthClient'] as const) {
      const ours = authSchema.tables[name]
      const theirs = generated[name]
      expect(Object.keys(ours.validator.fields)).toEqual(
        expect.arrayContaining(Object.keys(theirs.validator.fields)),
      )
      expect(ours[' indexes']()).toEqual(theirs[' indexes']())
    }
  })
})

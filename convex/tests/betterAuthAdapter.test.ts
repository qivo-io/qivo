/* Qivo's changes to its copy of the Convex adapter for Better Auth 1.7
 * (vendor/convex-better-auth), through the component functions the adapter
 * calls, and the component schema Qivo builds from the generated one. */
import { describe, expect, it, vi } from 'vitest'
import { handlePagination } from '../../vendor/convex-better-auth/src/client/adapter'
import { components } from '../_generated/api'
import { createAuth } from '../auth'
import authSchema from '../betterAuth/schema'
import { tables as generated } from '../betterAuth/schema.generated'
import { newT, runInAuth, type T } from './helpers.setup'

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

describe('the client adapter', () => {
  it('answers null for a lookup of only OR clauses that nothing matches, and finds a match', async () => {
    const t = newT()
    const lookup = (email: string) =>
      t.run(async (ctx) =>
        (await createAuth(ctx).$context).adapter.findOne<{ email: string }>({
          model: 'user',
          where: [
            { field: 'email', value: email, connector: 'OR' },
            { field: 'name', value: 'Nobody', connector: 'OR' },
          ],
        }),
      )
    expect(await lookup('nobody@example.test')).toBeNull()
    await runInAuth(t, (ctx) =>
      ctx.db.insert('user', {
        email: 'someone@example.test',
        emailVerified: true,
        name: 'Someone',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    )
    expect(await lookup('someone@example.test')).toMatchObject({ email: 'someone@example.test' })
  })
})

/** Plants access tokens of client 'c' in creation order, one for each
 * userId given. */
const plantTokens = (t: T, userIds: string[]) =>
  runInAuth(t, async (ctx) => {
    for (const [index, userId] of userIds.entries())
      await ctx.db.insert('oauthAccessToken', {
        token: `t${index}`,
        clientId: 'c',
        userId,
        scopes: [],
      })
  })

describe('reads that span pages', () => {
  it('collects every match once when a page stops early at the scan limit', async () => {
    const t = newT()
    // Every other token matches, so a page scans 200 tokens to find 100.
    await plantTokens(
      t,
      Array.from({ length: 300 }, (_, index) => (index % 2 ? 'u2' : 'u1')),
    )
    const { docs } = await handlePagination(({ paginationOpts }) =>
      t.query(components.betterAuth.adapter.findMany, {
        model: 'oauthAccessToken',
        where: [
          { field: 'clientId', value: 'c' },
          { field: 'userId', operator: 'ne', value: 'u2' },
        ],
        paginationOpts,
      }),
    )
    const tokens = docs.map((doc) => doc.token)
    expect(tokens).toHaveLength(150)
    expect(new Set(tokens).size).toBe(150)
  })

  it('finds a single row that comes after a page with no match', async () => {
    const t = newT()
    await plantTokens(t, [...Array.from({ length: 250 }, () => 'u1'), 'u2'])
    const where = [
      { field: 'clientId' as const, value: 'c' },
      { field: 'userId' as const, value: 'u2' },
    ]
    expect(
      await t.query(components.betterAuth.adapter.findOne, { model: 'oauthAccessToken', where }),
    ).toMatchObject({ token: 't250' })
    expect(
      await t.mutation(components.betterAuth.adapter.updateOne, {
        input: { model: 'oauthAccessToken', where, update: { revoked: 1 } },
      }),
    ).toMatchObject({ token: 't250', revoked: 1 })
    expect(
      await t.query(components.betterAuth.adapter.findOne, {
        model: 'oauthAccessToken',
        where: [
          { field: 'clientId', value: 'c' },
          { field: 'userId', value: 'u3' },
        ],
      }),
    ).toBeNull()
  })

  it('applies every in clause, not only the first', async () => {
    const t = newT()
    await plantTokens(t, ['u1', 'u2'])
    const found = await t.query(components.betterAuth.adapter.findMany, {
      model: 'oauthAccessToken',
      where: [
        { field: 'clientId', operator: 'in', value: ['c'] },
        { field: 'userId', operator: 'in', value: ['u1'] },
      ],
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(found.page.map((row: { userId: string }) => row.userId)).toEqual(['u1'])
  })

  it('refuses a bulk update that would give two rows the same composite key', async () => {
    const t = newT()
    for (const clientId of ['a', 'b'])
      await t.mutation(components.betterAuth.adapter.create, {
        input: { model: 'oauthClientResource', data: { clientId, resourceId: RESOURCE } },
      })
    await expect(
      t.mutation(components.betterAuth.adapter.updateMany, {
        input: {
          model: 'oauthClientResource',
          where: [{ field: 'resourceId', value: RESOURCE }],
          update: { clientId: 'c' },
        },
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow('oauthClientResource unique constraint clientId+resourceId already exists')
    const links = await runInAuth(t, (ctx) => ctx.db.query('oauthClientResource').collect())
    expect(links.map((link) => link.clientId).sort()).toEqual(['a', 'b'])
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

  it('merges an in clause over an index with fields after the equality fields', async () => {
    const t = newT()
    await runInAuth(t, async (ctx) => {
      const at = Date.now()
      for (const [providerId, userId] of [
        ['microsoft', 'u2'],
        ['credential', 'u1'],
        ['google', 'u3'],
        ['microsoft', 'u1'],
      ])
        await ctx.db.insert('account', {
          accountId: `${providerId}-${userId}`,
          providerId,
          userId,
          createdAt: at,
          updatedAt: at,
        })
    })
    // Each value reads providerId_userId, which orders by userId first.
    const found = await t.query(components.betterAuth.adapter.findMany, {
      model: 'account',
      where: [{ field: 'providerId', operator: 'in', value: ['microsoft', 'credential'] }],
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(found.page.map((row: { accountId: string }) => row.accountId).sort()).toEqual([
      'credential-u1',
      'microsoft-u1',
      'microsoft-u2',
    ])
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

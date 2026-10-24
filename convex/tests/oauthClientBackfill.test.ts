/* The Better Auth 1.7 client backfill (internal/oauthClientBackfill.ts,
 * betterAuth/oauth.ts walkClients) and the Microsoft account key count
 * (internal/microsoftAccounts.ts). Clients are planted as Better Auth 1.6
 * stored them, with `public` and maybe `type`, which betterAuth/schema.ts
 * still accepts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import { newT, runInAuth, type T } from './helpers.setup'

const RESOURCE = 'https://some.convex.site/mcp'

beforeEach(() => {
  vi.stubEnv('CONVEX_SITE_URL', 'https://some.convex.site')
  vi.stubEnv('MCP_RESOURCE_URL', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

/* The clients of every kind the backfill meets, and two links for the first. */
const plant = (t: T) =>
  runInAuth(t, async (ctx) => {
    const client = (clientId: string, fields: Record<string, unknown>) =>
      ctx.db.insert('oauthClient', {
        clientId,
        redirectUris: ['https://client.example.test/callback'],
        createdAt: Date.now(),
        ...fields,
      })
    // what an unauthenticated 1.6 registration stored
    await client('public-none', { public: true, tokenEndpointAuthMethod: 'none' })
    // a native client whose method was never stored
    await client('public-native', { public: true, type: 'native' })
    // registered on 1.7, already linked
    await client('current', { tokenEndpointAuthMethod: 'none' })
    // a type 1.7 has no application type for
    await client('confidential-agent', {
      public: false,
      type: 'user-agent-based',
      tokenEndpointAuthMethod: 'client_secret_basic',
    })
    const link = (clientId: string) =>
      ctx.db.insert('oauthClientResource', { clientId, resourceId: RESOURCE })
    await link('public-none')
    await link('public-none')
    await link('current')
  })

const rows = (t: T) =>
  runInAuth(t, async (ctx) => ({
    clients: await ctx.db.query('oauthClient').collect(),
    links: await ctx.db.query('oauthClientResource').collect(),
  }))

const FOUND = { legacy: 3, madePublic: 1, linked: 2, duplicates: 1, review: 1 }
const NONE = { legacy: 0, madePublic: 0, linked: 0, duplicates: 0, review: 0 }

describe('OAuth client backfill', () => {
  it('counts what it would change and writes nothing in a check or a dry run', async () => {
    const t = newT()
    await plant(t)
    const before = await rows(t)
    expect(
      await t.query(internal.internal.oauthClientBackfill.remaining, { cursor: null }),
    ).toEqual({ ...FOUND, cursor: null })
    expect(await t.action(internal.internal.oauthClientBackfill.run, { dry_run: true })).toEqual({
      dry_run: true,
      ...FOUND,
    })
    expect(await rows(t)).toEqual(before)
    expect(await t.run((ctx) => ctx.db.query('platform_audit_log').collect())).toEqual([])
  })

  it('maps the 1.6 fields, links every client once, and finds nothing on a second run', async () => {
    const t = newT()
    await plant(t)
    expect(await t.action(internal.internal.oauthClientBackfill.run, { dry_run: false })).toEqual({
      dry_run: false,
      ...FOUND,
    })
    const { clients, links } = await rows(t)
    const byId = Object.fromEntries(clients.map((client) => [client.clientId, client]))
    for (const client of clients) {
      expect(client).not.toHaveProperty('public')
      expect(client).not.toHaveProperty('type')
    }
    expect(byId['public-none'].tokenEndpointAuthMethod).toBe('none')
    expect(byId['public-native']).toMatchObject({
      tokenEndpointAuthMethod: 'none',
      applicationType: 'native',
    })
    // left for a person to review
    expect(byId['confidential-agent'].tokenEndpointAuthMethod).toBe('client_secret_basic')
    expect(byId['confidential-agent']).not.toHaveProperty('applicationType')
    expect(links.map((link) => [link.clientId, link.resourceId]).sort()).toEqual(
      ['confidential-agent', 'current', 'public-native', 'public-none'].map((id) => [id, RESOURCE]),
    )
    const audit = await t.run((ctx) => ctx.db.query('platform_audit_log').collect())
    expect(audit.map(({ action, detail }) => ({ action, detail }))).toEqual([
      { action: 'oauth_client_backfill', detail: FOUND },
    ])
    expect(await t.action(internal.internal.oauthClientBackfill.run, { dry_run: false })).toEqual({
      dry_run: false,
      ...NONE,
    })
  })
})

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

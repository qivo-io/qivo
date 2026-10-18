/* OAuth client registration limits (oauthRegistrations.ts admit, the Better
 * Auth hook in lib/oauthProvider.ts) and the cleanup of clients and counters
 * nobody uses (sweepClients, sweepCounters). Registration runs through the
 * real HTTP handler and Better Auth provider. convex-test reports no client
 * address, so every HTTP registration here shares the unknown source. */
/// <reference types="vite/client" />
import { hashPassword } from 'better-auth/crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { components, internal } from '../_generated/api'
import {
  addressBucket,
  OAUTH_CLIENT_METADATA_MAX_BYTES,
  OAUTH_REGISTRATION_TOTAL_KEY,
  OAUTH_REGISTRATION_WINDOW_MS,
  OAUTH_REGISTRATIONS_PER_SOURCE,
  OAUTH_REGISTRATIONS_TOTAL,
  OAUTH_UNUSED_CLIENT_TTL_MS,
  registrationSourceKey,
} from '../lib/oauthRegistration'
import { newT, type T } from './helpers.setup'

const APP = 'http://localhost:5199'
const BROWSER = 'https://browser-client.example.test'
const SECRET = 'oauth-registration-hermetic-secret-not-a-deployment-314159'
process.env.SITE_URL = APP
process.env.CONVEX_SITE_URL = 'https://some.convex.site'
process.env.BETTER_AUTH_SECRET = SECRET

type Json = Record<string, unknown>
type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }
const http = (t: T, path: string, init?: FetchInit): Promise<Response> =>
  (t as unknown as { fetch(path: string, init?: FetchInit): Promise<Response> }).fetch(path, init)
const json = async (response: Response): Promise<Json> => JSON.parse(await response.text())

// Half past the hour, so a refused registration waits 30 minutes.
const NOW = Date.parse('2026-10-18T12:30:00Z')
const WINDOW = Math.floor(NOW / OAUTH_REGISTRATION_WINDOW_MS) * OAUTH_REGISTRATION_WINDOW_MS

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

const metadata = (overrides: Json = {}): Json => ({
  client_name: 'Hermetic MCP client',
  redirect_uris: [`${BROWSER}/callback`],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  scope: 'qivo:read qivo:write offline_access',
  ...overrides,
})

const register = (t: T, body: Json = metadata()) =>
  http(t, '/api/auth/oauth2/register', {
    method: 'POST',
    headers: { Origin: BROWSER, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const clients = async (t: T) =>
  (
    await t.query(components.betterAuth.adapter.findMany, {
      model: 'oauthClient',
      paginationOpts: { cursor: null, numItems: 1000 },
    })
  ).page as { clientId: string }[]

const counters = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query('machine_rate_limits').collect()).map(({ key, window_start, count }) => ({
      key,
      window_start,
      count,
    })),
  )

const setCounter = (t: T, key: string, count: number, windowStart = WINDOW) =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query('machine_rate_limits')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique()
    if (row) await ctx.db.patch(row._id, { window_start: windowStart, count })
    else await ctx.db.insert('machine_rate_limits', { key, window_start: windowStart, count })
  })

const admit = (t: T, address: string | null) =>
  t.mutation(internal.oauthRegistrations.admit, { address })

describe('source address buckets', () => {
  it('counts an IPv6 address as its /64 network', () => {
    for (const address of [
      '2001:db8:1:2::1',
      '2001:DB8:1:2:ffff:ffff:ffff:ffff',
      '[2001:db8:1:2::5]',
      '2001:0db8:0001:0002:0:0:0:9',
    ])
      expect(addressBucket(address), address).toBe('2001:db8:1:2::/64')
    expect(addressBucket('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64')
    expect(addressBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
    expect(addressBucket('::')).toBe('0:0:0:0::/64')
  })

  it('counts an IPv4 address as written, also when mapped into IPv6', () => {
    expect(addressBucket('203.0.113.7')).toBe('203.0.113.7')
    expect(addressBucket('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(addressBucket('203.0.113.8')).not.toBe(addressBucket('203.0.113.7'))
  })

  it('keeps any other value as a bucket of its own', () => {
    expect(addressBucket('not an address')).toBe('not an address')
    expect(addressBucket('x'.repeat(100))).toBe('x'.repeat(64))
  })
})

describe('registration limits', () => {
  it('admits a source up to its hourly limit, then refuses it until the next hour', async () => {
    const t = newT()
    for (let i = 0; i < OAUTH_REGISTRATIONS_PER_SOURCE; i++)
      expect(await admit(t, '203.0.113.7')).toEqual({ admitted: true, retryAfter: 0 })
    expect(await admit(t, '203.0.113.7')).toEqual({ admitted: false, retryAfter: 1800 })
    // another source still registers
    expect(await admit(t, '203.0.113.8')).toEqual({ admitted: true, retryAfter: 0 })
    const rows = await counters(t)
    expect(rows.find((row) => row.key === OAUTH_REGISTRATION_TOTAL_KEY)?.count).toBe(
      OAUTH_REGISTRATIONS_PER_SOURCE + 1,
    )
    // the stored keys do not reveal the address
    expect(rows.some((row) => row.key.includes('203.0.113'))).toBe(false)
    vi.setSystemTime(WINDOW + OAUTH_REGISTRATION_WINDOW_MS)
    expect(await admit(t, '203.0.113.7')).toEqual({ admitted: true, retryAfter: 0 })
  })

  it('shares one source counter across an IPv6 /64 network', async () => {
    const t = newT()
    await setCounter(
      t,
      await registrationSourceKey('2001:db8:1:2::1', SECRET),
      OAUTH_REGISTRATIONS_PER_SOURCE,
    )
    expect((await admit(t, '2001:db8:1:2:ffff::9')).admitted).toBe(false)
    expect((await admit(t, '2001:db8:1:3::1')).admitted).toBe(true)
  })

  it('refuses every source once the deployment limit is full and writes nothing', async () => {
    const t = newT()
    await setCounter(t, OAUTH_REGISTRATION_TOTAL_KEY, OAUTH_REGISTRATIONS_TOTAL)
    expect(await admit(t, '198.51.100.1')).toEqual({ admitted: false, retryAfter: 1800 })
    expect(await admit(t, null)).toEqual({ admitted: false, retryAfter: 1800 })
    expect(await counters(t)).toEqual([
      { key: OAUTH_REGISTRATION_TOTAL_KEY, window_start: WINDOW, count: OAUTH_REGISTRATIONS_TOTAL },
    ])
  })

  it('ignores counts from an earlier hour', async () => {
    const t = newT()
    await setCounter(
      t,
      OAUTH_REGISTRATION_TOTAL_KEY,
      OAUTH_REGISTRATIONS_TOTAL,
      WINDOW - OAUTH_REGISTRATION_WINDOW_MS,
    )
    expect((await admit(t, '198.51.100.1')).admitted).toBe(true)
    expect(
      (await counters(t)).find((row) => row.key === OAUTH_REGISTRATION_TOTAL_KEY),
    ).toMatchObject({ window_start: WINDOW, count: 1 })
  })

  it('throws when a counter cannot be read', async () => {
    const t = newT()
    await t.run(async (ctx) => {
      for (const count of [1, 2])
        await ctx.db.insert('machine_rate_limits', {
          key: OAUTH_REGISTRATION_TOTAL_KEY,
          window_start: WINDOW,
          count,
        })
    })
    await expect(admit(t, '198.51.100.1')).rejects.toThrow()
  })
})

describe('client registration over HTTP', () => {
  it('counts each registration and answers 429 with Retry-After once the limit is full', async () => {
    const t = newT()
    const accepted = await register(t)
    expect(accepted.status).toBe(200)
    expect((await json(accepted)).client_id).toBeTypeOf('string')
    const unknown = await registrationSourceKey(null, SECRET)
    expect(await counters(t)).toEqual(
      expect.arrayContaining([
        { key: unknown, window_start: WINDOW, count: 1 },
        { key: OAUTH_REGISTRATION_TOTAL_KEY, window_start: WINDOW, count: 1 },
      ]),
    )
    await setCounter(t, unknown, OAUTH_REGISTRATIONS_PER_SOURCE)
    const refused = await register(t)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('Retry-After')).toBe('1800')
    expect(refused.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(refused.headers.get('Access-Control-Expose-Headers')).toContain('Retry-After')
    expect(await json(refused)).toMatchObject({ error: 'too_many_requests' })
    expect(await clients(t)).toHaveLength(1)
  })

  it('refuses oversized client metadata without counting it', async () => {
    const t = newT()
    const response = await register(
      t,
      metadata({ client_name: 'x'.repeat(OAUTH_CLIENT_METADATA_MAX_BYTES) }),
    )
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: 'invalid_client_metadata' })
    expect(await clients(t)).toEqual([])
    expect(await counters(t)).toEqual([])
  })

  it('refuses the registration when the counters cannot be read', async () => {
    const t = newT()
    await t.run(async (ctx) => {
      for (const count of [1, 2])
        await ctx.db.insert('machine_rate_limits', {
          key: OAUTH_REGISTRATION_TOTAL_KEY,
          window_start: WINDOW,
          count,
        })
    })
    const response = await register(t)
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(await json(response)).toMatchObject({ error: 'temporarily_unavailable' })
    expect(await clients(t)).toEqual([])
  })

  it('applies the same limits to signed-in client creation', async () => {
    const t = newT()
    const now = Date.now()
    const email = 'oauth-registration@example.test'
    const password = 'Hermetic OAuth registration password 314159!'
    const user = await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: { name: 'Registrar', email, emailVerified: true, createdAt: now, updatedAt: now },
      },
    })
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'account',
        data: {
          accountId: user._id,
          userId: user._id,
          providerId: 'credential',
          password: await hashPassword(password),
          createdAt: now,
          updatedAt: now,
        },
      },
    })
    const login = await http(t, '/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      headers: { Origin: APP, 'Content-Type': 'application/json', 'Better-Auth-Cookie': '' },
    })
    expect(login.status).toBe(200)
    const cookie = login.headers
      .get('Set-Better-Auth-Cookie')
      ?.match(/(?:^|,\s*)([^=;,]*session_token=[^;]+)/)?.[1]
    expect(cookie).toBeTruthy()
    await setCounter(t, OAUTH_REGISTRATION_TOTAL_KEY, OAUTH_REGISTRATIONS_TOTAL)
    const response = await http(t, '/api/auth/oauth2/create-client', {
      method: 'POST',
      headers: { Origin: APP, 'Content-Type': 'application/json', 'Better-Auth-Cookie': cookie! },
      body: JSON.stringify(metadata({ token_endpoint_auth_method: 'client_secret_basic' })),
    })
    expect(response.status).toBe(429)
    expect(await clients(t)).toEqual([])
  })
})

/** Plants a client, as the provider stores one, created now. */
const plantClient = (t: T, clientId: string) =>
  t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'oauthClient',
      data: {
        clientId,
        name: clientId,
        redirectUris: [`${BROWSER}/callback`],
        public: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  })

describe('unused client cleanup', () => {
  async function plantClients(t: T) {
    for (const clientId of ['unused', 'consented', 'refreshing', 'accessing', 'connected'])
      await plantClient(t, clientId)
    const scopes = ['qivo:read']
    await t.mutation(components.betterAuth.adapter.create, {
      input: { model: 'oauthConsent', data: { clientId: 'consented', userId: 'u1', scopes } },
    })
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'oauthRefreshToken',
        data: { clientId: 'refreshing', token: 'hash-1', userId: 'u1', scopes },
      },
    })
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'oauthAccessToken',
        data: { clientId: 'accessing', token: 'hash-2', scopes },
      },
    })
    // a revoked connection still keeps its client
    await t.run((ctx) =>
      ctx.db.insert('oauth_connections', {
        id: 'connection-1',
        authorization_hash: 'authorization-1',
        auth_user_id: 'u1',
        profile_id: 'profile-1',
        org_id: 'org-1',
        client_id: 'connected',
        client_name: 'Connected client',
        resource: 'https://some.convex.site/mcp',
        requested_scopes: scopes,
        scopes: [],
        created_at: new Date().toISOString(),
        authorization_expires_at: new Date().toISOString(),
        revoked_at: new Date().toISOString(),
        revocation_reason: 'deleted',
      }),
    )
  }
  const sweep = async (t: T) => {
    await t.mutation(internal.oauthRegistrations.sweepClients, {})
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  }
  const ids = async (t: T) => (await clients(t)).map((client) => client.clientId).sort()

  it('deletes only clients past the age limit that nothing refers to', async () => {
    const t = newT()
    await plantClients(t)
    vi.setSystemTime(NOW + OAUTH_UNUSED_CLIENT_TTL_MS - 60 * 60_000)
    await plantClient(t, 'recent')
    await sweep(t)
    expect(await ids(t)).toEqual(
      ['accessing', 'connected', 'consented', 'recent', 'refreshing', 'unused'].sort(),
    )
    vi.setSystemTime(NOW + OAUTH_UNUSED_CLIENT_TTL_MS + 60_000)
    await sweep(t)
    expect(await ids(t)).toEqual(['accessing', 'connected', 'consented', 'recent', 'refreshing'])
    vi.setSystemTime(NOW + 2 * OAUTH_UNUSED_CLIENT_TTL_MS)
    await sweep(t)
    expect(await ids(t)).toEqual(['accessing', 'connected', 'consented', 'refreshing'])
  })

  it('walks every client in bounded legs', async () => {
    const t = newT()
    await plantClients(t)
    const extra = Array.from({ length: 150 }, (_, i) => `extra-${String(i).padStart(3, '0')}`)
    for (const clientId of extra) await plantClient(t, clientId)
    vi.setSystemTime(NOW + OAUTH_UNUSED_CLIENT_TTL_MS + 60_000)
    await sweep(t)
    expect(await ids(t)).toEqual(['accessing', 'connected', 'consented', 'refreshing'])
  })

  it('never deletes a client that a consent or token refers to, even when asked', async () => {
    const t = newT()
    await plantClients(t)
    vi.setSystemTime(NOW + OAUTH_UNUSED_CLIENT_TTL_MS + 60_000)
    await plantClient(t, 'recent')
    const deleted = await t.mutation(components.betterAuth.oauth.deleteUnusedClients, {
      clientIds: ['unused', 'consented', 'refreshing', 'accessing', 'recent'],
      before: Date.now() - OAUTH_UNUSED_CLIENT_TTL_MS,
    })
    expect(deleted).toBe(1)
    expect(await ids(t)).toEqual(['accessing', 'connected', 'consented', 'recent', 'refreshing'])
  })
})

describe('registration counter cleanup', () => {
  it('deletes source counters from earlier hours and keeps everything else', async () => {
    const t = newT()
    const stale = await registrationSourceKey('203.0.113.7', SECRET)
    const current = await registrationSourceKey('203.0.113.8', SECRET)
    const earlier = WINDOW - OAUTH_REGISTRATION_WINDOW_MS
    await setCounter(t, stale, 3, earlier)
    await setCounter(t, current, 2)
    await setCounter(t, OAUTH_REGISTRATION_TOTAL_KEY, 5, earlier)
    await setCounter(t, 'profile:p1', 7, earlier)
    await t.mutation(internal.oauthRegistrations.sweepCounters, {})
    expect((await counters(t)).map((row) => row.key).sort()).toEqual(
      [current, OAUTH_REGISTRATION_TOTAL_KEY, 'profile:p1'].sort(),
    )
  })

  it('walks every counter in bounded legs', async () => {
    const t = newT()
    const earlier = WINDOW - OAUTH_REGISTRATION_WINDOW_MS
    await t.run(async (ctx) => {
      for (let i = 0; i < 1100; i++)
        await ctx.db.insert('machine_rate_limits', {
          key: await registrationSourceKey(`198.51.100.${i % 256}-${i}`, SECRET),
          window_start: earlier,
          count: 1,
        })
    })
    await t.mutation(internal.oauthRegistrations.sweepCounters, {})
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await counters(t)).toEqual([])
  })
})

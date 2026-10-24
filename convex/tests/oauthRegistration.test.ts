/* OAuth client registration limits (oauthRegistrations.ts admit, the Better
 * Auth hook in lib/oauthProvider.ts), the client management endpoints Qivo
 * does not serve (lib/authRoutes.ts) and the cleanup of clients and
 * counters nobody uses (sweepClients, sweepCounters). Registration runs
 * through the real HTTP handler and Better Auth provider. convex-test 0.0.58
 * reports no client address, so an HTTP registration here counts against the
 * unknown source unless the test reports one (reportRequestMetadata). */
/// <reference types="vite/client" />
import { hashPassword } from 'better-auth/crypto'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { components, internal } from '../_generated/api'
import {
  addressBuckets,
  OAUTH_CLIENT_METADATA_MAX_BYTES,
  OAUTH_REGISTRATION_TOTAL_KEY,
  OAUTH_REGISTRATION_WINDOW_MS,
  OAUTH_REGISTRATIONS_PER_NETWORK,
  OAUTH_REGISTRATIONS_PER_SOURCE,
  OAUTH_REGISTRATIONS_TOTAL,
  OAUTH_UNUSED_CLIENT_TTL_MS,
  registrationSourceCounters,
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

const register = (t: T, body: Json = metadata(), headers: Record<string, string> = {}) =>
  http(t, '/api/auth/oauth2/register', {
    method: 'POST',
    headers: { Origin: BROWSER, 'Content-Type': 'application/json', ...headers },
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

/** The key of the /64 or IPv4 counter for `address`, or with `index` 1 the
 * key of its /48 counter. */
const sourceKey = async (address: string | null, index = 0) =>
  (await registrationSourceCounters(address, SECRET))[index].key

type Syscalls = {
  syscall: (op: string, json: string) => string
  asyncSyscall: (op: string, json: string) => Promise<string>
  jsSyscall: (op: string, args: Record<string, unknown>) => unknown
}

/** Makes the backend report request metadata for each HTTP request until the
 * test ends, which convex-test 0.0.58 cannot do. The returned function sets
 * the fields to report; leaving out `ip` imitates a backend that omits it. */
function reportRequestMetadata(): (fields: Json) => void {
  const global = globalThis as unknown as { Convex: Syscalls }
  const real = global.Convex
  let fields: Json = {}
  global.Convex = {
    get syscall() {
      return real.syscall
    },
    get asyncSyscall() {
      const call = real.asyncSyscall
      return (op: string, json: string) =>
        op === '1.0/getRequestMetadata'
          ? Promise.resolve(
              JSON.stringify({
                userAgent: null,
                requestId: 'request-metadata-check',
                scheduledFunctionId: null,
                authToken: null,
                ...fields,
              }),
            )
          : call(op, json)
    },
    get jsSyscall() {
      return real.jsSyscall
    },
  }
  onTestFinished(() => {
    global.Convex = real
  })
  return (next) => {
    fields = next
  }
}

describe('source address buckets', () => {
  const buckets = (address: string) => addressBuckets(address).map(({ bucket }) => bucket)

  it('counts an IPv6 address as its /64 network and as its /48 network', () => {
    for (const address of [
      '2001:db8:1:2::1',
      '2001:DB8:1:2:ffff:ffff:ffff:ffff',
      '[2001:db8:1:2::5]',
      '2001:0db8:0001:0002:0:0:0:9',
    ])
      expect(buckets(address), address).toEqual(['2001:db8:1:2::/64', '2001:db8:1::/48'])
    expect(buckets('2001:db8:1:3::1')).toEqual(['2001:db8:1:3::/64', '2001:db8:1::/48'])
    expect(buckets('fe80::1%eth0')).toEqual(['fe80:0:0:0::/64', 'fe80:0:0::/48'])
    expect(buckets('::')).toEqual(['0:0:0:0::/64', '0:0:0::/48'])
    expect(addressBuckets('2001:db8:1:2::1').map(({ limit }) => limit)).toEqual([
      OAUTH_REGISTRATIONS_PER_SOURCE,
      OAUTH_REGISTRATIONS_PER_NETWORK,
    ])
  })

  it('counts an IPv4 address as written, also when mapped into IPv6', () => {
    expect(addressBuckets('203.0.113.7')).toEqual([
      { bucket: '203.0.113.7', limit: OAUTH_REGISTRATIONS_PER_SOURCE },
    ])
    expect(buckets('::ffff:203.0.113.7')).toEqual(['203.0.113.7'])
    expect(buckets('203.0.113.8')).not.toEqual(buckets('203.0.113.7'))
  })

  it('keeps any other value as a bucket of its own', () => {
    expect(buckets('not an address')).toEqual(['not an address'])
    expect(buckets('x'.repeat(100))).toEqual(['x'.repeat(64)])
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
    await setCounter(t, await sourceKey('2001:db8:1:2::1'), OAUTH_REGISTRATIONS_PER_SOURCE)
    expect((await admit(t, '2001:db8:1:2:ffff::9')).admitted).toBe(false)
    expect((await admit(t, '2001:db8:1:3::1')).admitted).toBe(true)
  })

  it('limits an IPv6 /48 network across all of its /64 networks', async () => {
    const t = newT()
    expect((await admit(t, '2001:db8:1:2::1')).admitted).toBe(true)
    // the /64, the /48 and the deployment counter
    expect(await counters(t)).toHaveLength(3)
    await setCounter(t, await sourceKey('2001:db8:1:2::1', 1), OAUTH_REGISTRATIONS_PER_NETWORK)
    expect(await admit(t, '2001:db8:1:7::1')).toEqual({ admitted: false, retryAfter: 1800 })
    expect((await admit(t, '2001:db8:2:7::1')).admitted).toBe(true)
  })

  it('logs once when a counter reaches its limit, without the address', async () => {
    const t = newT()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())
    await setCounter(t, await sourceKey('203.0.113.7'), OAUTH_REGISTRATIONS_PER_SOURCE - 2)
    expect((await admit(t, '203.0.113.7')).admitted).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    expect((await admit(t, '203.0.113.7')).admitted).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain(`limit of ${OAUTH_REGISTRATIONS_PER_SOURCE}`)
    expect((await admit(t, '203.0.113.7')).admitted).toBe(false)
    await setCounter(t, OAUTH_REGISTRATION_TOTAL_KEY, OAUTH_REGISTRATIONS_TOTAL - 1)
    expect((await admit(t, '203.0.113.8')).admitted).toBe(true)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[1][0])).toContain('deployment limit')
    expect((await admit(t, '203.0.113.9')).admitted).toBe(false)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.flat().some((line) => String(line).includes('203.0.113'))).toBe(false)
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
    expect(accepted.status).toBe(201)
    expect((await json(accepted)).client_id).toBeTypeOf('string')
    const unknown = await sourceKey(null)
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

  it('counts each registration against the address the backend reports', async () => {
    const t = newT()
    const report = reportRequestMetadata()
    report({ ip: '2001:db8:1:2::5' })
    expect((await register(t)).status).toBe(201)
    expect(await counters(t)).toEqual(
      expect.arrayContaining([
        { key: await sourceKey('2001:db8:1:2::5'), window_start: WINDOW, count: 1 },
        { key: await sourceKey('2001:db8:1:2::5', 1), window_start: WINDOW, count: 1 },
        { key: OAUTH_REGISTRATION_TOTAL_KEY, window_start: WINDOW, count: 1 },
      ]),
    )
    await setCounter(t, await sourceKey('2001:db8:1:2::5'), OAUTH_REGISTRATIONS_PER_SOURCE)
    expect((await register(t)).status).toBe(429)
    // another /64 in the same /48 still registers until the /48 is full
    report({ ip: '2001:db8:1:3::5' })
    expect((await register(t)).status).toBe(201)
    await setCounter(t, await sourceKey('2001:db8:1:3::5', 1), OAUTH_REGISTRATIONS_PER_NETWORK)
    report({ ip: '2001:db8:1:4::5' })
    expect((await register(t)).status).toBe(429)
    report({ ip: '2001:db8:2:1::5' })
    expect((await register(t)).status).toBe(201)
    report({ ip: '203.0.113.7' })
    expect((await register(t)).status).toBe(201)
    expect(await clients(t)).toHaveLength(4)
  })

  it('counts a request whose metadata omits the address against the unknown source', async () => {
    const t = newT()
    reportRequestMetadata()({})
    expect((await register(t)).status).toBe(201)
    expect(await counters(t)).toEqual(
      expect.arrayContaining([{ key: await sourceKey(null), window_start: WINDOW, count: 1 }]),
    )
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

  it('does not serve the endpoints that create or change a client for a signed-in owner', async () => {
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
    const signedIn = (path: string, body: Json) =>
      http(t, `/api/auth/oauth2/${path}`, {
        method: 'POST',
        headers: { Origin: APP, 'Content-Type': 'application/json', 'Better-Auth-Cookie': cookie! },
        body: JSON.stringify(body),
      })
    const created = await signedIn(
      'create-client',
      metadata({ token_endpoint_auth_method: 'client_secret_basic' }),
    )
    expect(created.status).toBe(404)
    expect(await clients(t)).toEqual([])
    // A client this person owns cannot be grown past the metadata cap.
    await plantClient(t, 'owned', { userId: user._id })
    // past the metadata cap, and within the auth body cap (AUTH_BODY_MAX_BYTES)
    const large = 'x'.repeat(2 * OAUTH_CLIENT_METADATA_MAX_BYTES)
    const updated = await signedIn('update-client', {
      client_id: 'owned',
      update: { client_uri: `${BROWSER}/${large}`, software_statement: large },
    })
    expect(updated.status).toBe(404)
    const [owned] = (await clients(t)) as { uri?: string; softwareStatement?: string }[]
    expect(owned.uri ?? null).toBeNull()
    expect(owned.softwareStatement ?? null).toBeNull()
    for (const path of ['client/rotate-secret', 'delete-client', 'get-clients'])
      expect((await signedIn(path, { client_id: 'owned' })).status, path).toBe(404)
  })
})

describe('registered clients', () => {
  it('registers every client as public and links it to the MCP resource', async () => {
    const t = newT()
    for (const method of [undefined, 'client_secret_basic', 'client_secret_post', 'none']) {
      const response = await register(t, metadata({ token_endpoint_auth_method: method }))
      const client = await json(response)
      expect([method, response.status]).toEqual([method, 201])
      expect(client.token_endpoint_auth_method).toBe('none')
      expect(client.client_secret).toBeUndefined()
      expect(client.resources).toEqual(['https://some.convex.site/mcp'])
    }
    const stored = (await clients(t)) as {
      tokenEndpointAuthMethod?: string
      clientSecret?: string
    }[]
    expect(stored.map((client) => client.tokenEndpointAuthMethod)).toEqual(Array(4).fill('none'))
    expect(stored.some((client) => client.clientSecret)).toBe(false)
  })

  it('registers a client that redirects to a loopback or private-use address', async () => {
    const t = newT()
    for (const uri of [
      'http://127.0.0.1:33418/callback',
      'com.example.app:/callback',
      'cursor://anysphere.cursor-retrieval/oauth/callback',
    ]) {
      const response = await register(t, metadata({ redirect_uris: [uri] }))
      const client = await json(response)
      expect([uri, response.status]).toEqual([uri, 201])
      expect(client.application_type).toBe('native')
    }
  })

  it('refuses a redirect address that Better Auth 1.7 allows no client to use', async () => {
    const t = newT()
    for (const [uri, applicationType] of [
      ['myapp://callback', undefined],
      ['myapp:/callback', undefined],
      ['http://localhost./callback', undefined],
      ['http://example.test/callback', undefined],
      ['http://127.0.0.1:33418/callback', 'web'],
    ]) {
      const response = await register(
        t,
        metadata({ redirect_uris: [uri], application_type: applicationType }),
      )
      expect([uri, response.status]).toEqual([uri, 400])
      expect((await json(response)).error).toBe('invalid_redirect_uri')
    }
    expect(await clients(t)).toEqual([])
  })

  it('ignores a Bearer token sent with a registration', async () => {
    const t = newT()
    // Qivo takes no initial access tokens (RFC 7591), so an old access token
    // a client sends along must not turn open registration into a 401.
    const response = await register(t, metadata(), { Authorization: 'Bearer qvo_1111111111' })
    expect(response.status).toBe(201)
    expect((await json(response)).token_endpoint_auth_method).toBe('none')
  })
})

/** Plants a client, as the provider stores one, created now. */
function plantClient(t: T, clientId: string, fields: Json = {}) {
  return t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'oauthClient',
      data: {
        clientId,
        name: clientId,
        redirectUris: [`${BROWSER}/callback`],
        public: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...fields,
      },
    },
  })
}

/** Plants a Qivo connection for the client, pending unless `approved_at` is
 * given. */
const plantConnection = (
  t: T,
  clientId: string,
  fields: { authorization_expires_at: string; approved_at?: string; revoked_at?: string },
) =>
  t.run((ctx) =>
    ctx.db.insert('oauth_connections', {
      id: `connection-${clientId}`,
      authorization_hash: `authorization-${clientId}`,
      auth_user_id: 'u1',
      profile_id: 'profile-1',
      org_id: 'org-1',
      client_id: clientId,
      client_name: clientId,
      resource: 'https://some.convex.site/mcp',
      requested_scopes: ['qivo:read'],
      scopes: fields.approved_at ? ['qivo:read'] : [],
      created_at: new Date().toISOString(),
      ...fields,
    }),
  )

describe('unused client cleanup', () => {
  async function plantClients(t: T) {
    for (const clientId of [
      'unused',
      'consented',
      'refreshing',
      'accessing',
      'connected',
      'abandoned',
      'authorizing',
    ])
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
    const at = (ms: number) => new Date(ms).toISOString()
    // someone approved this connection and later revoked it
    await plantConnection(t, 'connected', {
      authorization_expires_at: at(NOW + 10 * 60_000),
      approved_at: at(NOW + 60_000),
      revoked_at: at(NOW + 2 * 60_000),
    })
    // someone opened the consent page and never approved
    await plantConnection(t, 'abandoned', { authorization_expires_at: at(NOW + 10 * 60_000) })
    // an authorization still in progress when the first cleanup runs
    await plantConnection(t, 'authorizing', {
      authorization_expires_at: at(NOW + OAUTH_UNUSED_CLIENT_TTL_MS + 10 * 60_000),
    })
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
      [
        'abandoned',
        'accessing',
        'authorizing',
        'connected',
        'consented',
        'recent',
        'refreshing',
        'unused',
      ].sort(),
    )
    vi.setSystemTime(NOW + OAUTH_UNUSED_CLIENT_TTL_MS + 60_000)
    await sweep(t)
    expect(await ids(t)).toEqual(
      ['accessing', 'authorizing', 'connected', 'consented', 'recent', 'refreshing'].sort(),
    )
    vi.setSystemTime(NOW + 2 * OAUTH_UNUSED_CLIENT_TTL_MS)
    await sweep(t)
    expect(await ids(t)).toEqual(['accessing', 'connected', 'consented', 'refreshing'])
  })

  it('deletes the resource links of a client with it', async () => {
    const t = newT()
    await plantClients(t)
    for (const clientId of ['unused', 'consented'])
      await t.mutation(components.betterAuth.adapter.create, {
        input: {
          model: 'oauthClientResource',
          data: { clientId, resourceId: 'https://some.convex.site/mcp' },
        },
      })
    vi.setSystemTime(NOW + 2 * OAUTH_UNUSED_CLIENT_TTL_MS)
    await sweep(t)
    expect(await ids(t)).not.toContain('unused')
    const links = await t.run(
      async (ctx) =>
        await ctx.runQuery(components.betterAuth.adapter.findMany, {
          model: 'oauthClientResource',
          paginationOpts: { numItems: 10, cursor: null },
        }),
    )
    expect(links.page.map((link: { clientId: string }) => link.clientId)).toEqual(['consented'])
  })

  it('walks every client in bounded legs', async () => {
    const t = newT()
    await plantClients(t)
    const extra = Array.from({ length: 150 }, (_, i) => `extra-${String(i).padStart(3, '0')}`)
    for (const clientId of extra) await plantClient(t, clientId)
    vi.setSystemTime(NOW + 2 * OAUTH_UNUSED_CLIENT_TTL_MS)
    await sweep(t)
    expect(await ids(t)).toEqual(['accessing', 'connected', 'consented', 'refreshing'])
  })

  it('stays within the read limit when old client rows are near the document size limit', async () => {
    const t = newT({ transactionLimits: true })
    // Rows registered before the metadata cap, 30 of them about 900 KB each.
    const statement = 'x'.repeat(900_000)
    for (let i = 0; i < 30; i++)
      await plantClient(t, `large-${i}`, { softwareStatement: statement })
    await plantClient(t, 'consented')
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'oauthConsent',
        data: { clientId: 'consented', userId: 'u1', scopes: ['qivo:read'] },
      },
    })
    vi.setSystemTime(NOW + OAUTH_UNUSED_CLIENT_TTL_MS + 60_000)
    await sweep(t)
    expect(await ids(t)).toEqual(['consented'])
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
    expect(await ids(t)).toEqual(
      [
        'abandoned',
        'accessing',
        'authorizing',
        'connected',
        'consented',
        'recent',
        'refreshing',
      ].sort(),
    )
  })
})

describe('registration counter cleanup', () => {
  it('deletes source counters from earlier hours and keeps everything else', async () => {
    const t = newT()
    const stale = await sourceKey('203.0.113.7')
    const current = await sourceKey('203.0.113.8')
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

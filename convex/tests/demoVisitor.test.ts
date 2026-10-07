/// <reference types="vite/client" />
import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { components } from '../_generated/api'
import { createAuthOptions } from '../auth'
import authSchema from '../betterAuth/schema'
import { DEMO_TTL_MS } from '../lib/demo'
import { DEMO_VISITOR_HEADER, demoVisitorPlatform, verifiedDemoCountry } from '../lib/demoVisitor'
import { expectRefusal, newT, type T, uuid } from './helpers.setup'

const secret = 'demo-metrics-visitor-hermetic-test-314159'
const now = Date.parse('2026-09-14T12:00:00Z')
// Independently minted with Node createHmac; the Convex verifier uses Web Crypto.
const countryContext =
  'v1.1789387200.NO.29e6e36c18d37067831a5ee817b71f312568efaf2c6d0b01479d04813a931ca7'
const record = makeFunctionReference<
  'mutation',
  { auth_user_id: string; browser: string; os: string; country: string }
>('demoVisitor:record')
const componentModules = import.meta.glob('../betterAuth/**/*.ts')
let t: T

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.stubEnv('APP_MODE', 'demo')
  vi.stubEnv('SITE_URL', 'https://demo.qivo.io')
  vi.stubEnv('CONVEX_SITE_URL', 'https://some.convex.site')
  vi.stubEnv('BETTER_AUTH_SECRET', 'demo-hermetic-secret-never-a-deployment-314159')
  vi.stubEnv('DEMO_METRICS_SECRET', secret)
  vi.stubEnv('DEMO_ADMISSION_OPEN', 'true')
  t = newT()
  t.registerComponent('betterAuth', authSchema, componentModules)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('demo visitor categories and country attestation', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36', 'Chrome', 'Windows'],
    ['Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36 Edg/140.0', 'Edge', 'Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/142.0', 'Firefox', 'Linux'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.6 Safari/605.1.15',
      'Safari',
      'macOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14) Chrome/140.0 Mobile Safari/537.36 SamsungBrowser/28.0',
      'Samsung Internet',
      'Android',
    ],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541) Chrome/140.0 Safari/537.36', 'Chrome', 'ChromeOS'],
    ['Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36 OPR/121.0', 'Opera', 'Windows'],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6) CriOS/140.0 Mobile/15E148 Safari/604.1',
      'Chrome',
      'iOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6) FxiOS/142.0 Mobile/15E148 Safari/605.1.15',
      'Firefox',
      'iOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6) EdgiOS/140.0 Mobile/15E148 Safari/605.1.15',
      'Edge',
      'iOS',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/18.6 Mobile/15E148 Safari/604.1',
      'Safari',
      'iOS',
    ],
    ['custom-client', 'Other', 'Unknown'],
    [null, 'Unknown', 'Unknown'],
  ])('categorizes %s without browser versions or device identifiers', (ua, browser, os) => {
    expect(demoVisitorPlatform(ua)).toEqual({ browser, os })
  })

  it('accepts only fresh, correctly signed, domain-separated country context', async () => {
    expect(await verifiedDemoCountry(countryContext)).toBe('NO')
    for (const context of [
      null,
      '',
      'NO',
      countryContext.replace('.NO.', '.US.'),
      countryContext.replace('v1.', 'v2.'),
      countryContext.replace(/.$/, '8'),
      `${countryContext}extra`,
    ])
      expect(await verifiedDemoCountry(context)).toBe('ZZ')
    expect(await verifiedDemoCountry(countryContext, { secret: `${secret}wrong` })).toBe('ZZ')
    expect(await verifiedDemoCountry(countryContext, { now: now + 300_000 })).toBe('ZZ')
    expect(await verifiedDemoCountry(countryContext, { now: now - 31_000 })).toBe('ZZ')
    vi.stubEnv('DEMO_METRICS_SECRET', '')
    expect(await verifiedDemoCountry(countryContext)).toBe('ZZ')
  })
})

describe('demo creator attribution lifecycle', () => {
  async function receipt(status: 'unprovisioned' | 'ready' | 'deleting' = 'unprovisioned') {
    return t.run(async (ctx) => {
      const id = await ctx.db.insert('demo_sessions', {
        id: uuid(),
        auth_user_id: uuid(),
        created_at: now,
        expires_at: now + DEMO_TTL_MS,
        status,
      })
      return (await ctx.db.get(id))!
    })
  }

  it('records one fixed category set only on its owned unprovisioned receipt', async () => {
    const a = await receipt()
    const b = await receipt()
    await t.mutation(record, {
      auth_user_id: a.auth_user_id,
      browser: 'Chrome',
      os: 'Windows',
      country: 'NO',
    })
    await t.mutation(record, {
      auth_user_id: a.auth_user_id,
      browser: 'Safari',
      os: 'iOS',
      country: 'US',
    })
    expect(await t.run((ctx) => ctx.db.get(a._id))).toMatchObject({
      visitor_browser: 'Chrome',
      visitor_os: 'Windows',
      visitor_country: 'NO',
    })
    expect((await t.run((ctx) => ctx.db.get(b._id)))?.visitor_browser).toBeUndefined()
  })

  it('does not alter provisioned, deleting, expired or previously counted receipts', async () => {
    const ready = await receipt('ready')
    const deleting = await receipt('deleting')
    const expired = await receipt()
    const counted = await receipt()
    await t.run(async (ctx) => {
      await ctx.db.patch(expired._id, { expires_at: now })
      await ctx.db.patch(counted._id, { metrics_counted_at: now })
    })
    for (const value of [ready, deleting, expired, counted]) {
      await t.mutation(record, {
        auth_user_id: value.auth_user_id,
        browser: 'Chrome',
        os: 'Windows',
        country: 'NO',
      })
      expect((await t.run((ctx) => ctx.db.get(value._id)))?.visitor_browser).toBeUndefined()
    }
    vi.stubEnv('APP_MODE', 'normal')
    await expectRefusal(
      t.mutation(record, {
        auth_user_id: ready.auth_user_id,
        browser: 'Chrome',
        os: 'Windows',
        country: 'NO',
      }),
      'forbidden',
      /unavailable/,
    )
  })

  it('reduces unexpected metadata to known categories', async () => {
    const a = await receipt()
    await t.mutation(record, {
      auth_user_id: a.auth_user_id,
      browser: 'Chrome/140.0 user-id',
      os: 'Linux; device123',
      country: 'city, NO',
    })
    expect(await t.run((ctx) => ctx.db.get(a._id))).toMatchObject({
      visitor_browser: 'Unknown',
      visitor_os: 'Unknown',
      visitor_country: 'ZZ',
    })
  })

  const http = (
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> => (t as unknown as { fetch: typeof http }).fetch(path, init)

  it('captures a real successful anonymous sign-in while preserving its response and cookies', async () => {
    const login = await http('/api/auth/sign-in/anonymous', {
      method: 'POST',
      headers: {
        Origin: 'https://demo.qivo.io',
        'Content-Type': 'application/json',
        'Better-Auth-Cookie': '',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/140.0 Mobile Safari/537.36',
        'X-Forwarded-For': '192.0.2.123',
        [DEMO_VISITOR_HEADER]: countryContext,
      },
      body: '{}',
    })
    expect(login.status).toBe(200)
    expect(login.headers.get('Set-Better-Auth-Cookie')).toMatch(/session_token=/)
    const body = JSON.parse(await login.text()) as { token: string; user: { id: string } }
    expect(body.token).toBeTruthy()
    const receipts = await t.run((ctx) => ctx.db.query('demo_sessions').collect())
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      auth_user_id: body.user.id,
      visitor_browser: 'Chrome',
      visitor_os: 'Android',
      visitor_country: 'NO',
    })
    expect(JSON.stringify(receipts[0])).not.toMatch(/Mozilla|Android 14|Chrome\/140|v1\.1789387200/)
    const sessions = await t.query(components.betterAuth.adapter.findMany, {
      model: 'session',
      paginationOpts: { cursor: null, numItems: 100 },
    })
    expect(sessions.page).toHaveLength(1)
    expect(sessions.page[0].ipAddress).toBeUndefined()
    expect(sessions.page[0].userAgent).toBeUndefined()
    // The main product retains Better Auth's normal session behavior.
    vi.stubEnv('APP_MODE', 'normal')
    expect(createAuthOptions({} as never).databaseHooks.session).toBeUndefined()
  })

  it('ignores direct geolocation headers without blocking anonymous login', async () => {
    const login = await http('/api/auth/sign-in/anonymous', {
      method: 'POST',
      headers: {
        Origin: 'https://demo.qivo.io',
        'Content-Type': 'application/json',
        'x-vercel-ip-country': 'NO',
        [DEMO_VISITOR_HEADER]: 'NO',
      },
      body: '{}',
    })
    expect(login.status).toBe(200)
    expect((await t.run((ctx) => ctx.db.query('demo_sessions').collect()))[0]).toMatchObject({
      visitor_browser: 'Unknown',
      visitor_os: 'Unknown',
      visitor_country: 'ZZ',
    })
  })

  it('allows the optional country context on the demo origin preflight', async () => {
    const response = await http('/api/auth/sign-in/anonymous', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://demo.qivo.io',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-qivo-demo-visitor',
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain(
      'x-qivo-demo-visitor',
    )
  })
})

/* The Better Auth routes Qivo serves (lib/authRoutes.ts). Every route listed
 * is one Better Auth serves, on every kind of deployment, and every other
 * route answers 404 before Better Auth reads the request. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuth } from '../auth'
import { AUTH_ROUTES, DEMO_AUTH_ROUTES, servesAuthRoute } from '../lib/authRoutes'
import { AUTH_BODY_MAX_BYTES } from '../lib/limits'
import { newT, type T } from './helpers.setup'

process.env.BETTER_AUTH_SECRET ??= 'authRoutes-test-secret-not-a-deployment'

const SITE = 'https://some.convex.site'

/* The settings that make each kind of deployment build its auth. A hosted
 * one also gets both social providers, which add no route of their own. */
const PROVIDERS = {
  GOOGLE_CLIENT_ID: 'test-only-google',
  GOOGLE_CLIENT_SECRET: 'test-only-google',
  MICROSOFT_CLIENT_ID: 'test-only-microsoft',
  MICROSOFT_CLIENT_SECRET: 'test-only-microsoft',
}
const KINDS = [
  ['development', AUTH_ROUTES, {}],
  [
    'staging',
    AUTH_ROUTES,
    { QIVO_ENVIRONMENT: 'staging', SITE_URL: 'https://preview.qivo.io', ...PROVIDERS },
  ],
  [
    'production',
    AUTH_ROUTES,
    { QIVO_ENVIRONMENT: 'production', SITE_URL: 'https://qivo.io', ...PROVIDERS },
  ],
  [
    'demo',
    DEMO_AUTH_ROUTES,
    { QIVO_ENVIRONMENT: 'demo', APP_MODE: 'demo', SITE_URL: 'https://demo.qivo.io' },
  ],
] as const

afterEach(() => vi.unstubAllEnvs())

/* The auth createAuth builds under `env`. */
function authOf(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  return createAuth({} as Parameters<typeof createAuth>[0])
}

type Endpoint = {
  path?: string
  options?: {
    method?: string | string[]
    metadata?: { SERVER_ONLY?: boolean; [part: string]: unknown }
  }
}

/* Every `METHOD /path` Better Auth's router serves for `auth`, a `:name`
 * segment standing for any one segment, as the router matches it. */
const routesOf = (auth: { api: Record<string, Endpoint> }): string[] =>
  Object.values(auth.api).flatMap(({ path, options }) =>
    path && options && !options.metadata?.SERVER_ONLY
      ? [options.method].flat().map((method) => `${method} ${path}`)
      : [],
  )

/* Whether the router's `served` route takes requests for `listed`. */
const takes = (served: string, listed: string) => {
  const [method, path] = served.split(' ')
  const [listedMethod, listedPath] = listed.split(' ')
  const segments = listedPath.split('/')
  const pattern = path.split('/')
  return (
    method === listedMethod &&
    pattern.length === segments.length &&
    pattern.every((part, i) => part.startsWith(':') || part === segments[i])
  )
}

/* A request for `route`, any `:name` segment filled in. A POST carries a
 * body zod would refuse, with more values than a full check takes. */
function requestFor(route: string) {
  const [method, path] = route.split(' ')
  const concrete = path.replace(/:[^/]+/g, 'x')
  const body = JSON.stringify({ scopes: Array(Math.floor(AUTH_BODY_MAX_BYTES / 3)).fill(1) })
  return new Request(`${SITE}/api/auth${concrete}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body } : {}),
  })
}

/* The routes the OAuth provider answers before the router does, with its
 * metadata (onRequest), on every deployment but the demo. */
const BEFORE_THE_ROUTER = [
  'GET /.well-known/oauth-authorization-server',
  'HEAD /.well-known/oauth-authorization-server',
]

/* Paths a plugin answers outside the router's endpoints, or no route at all. */
const OUTSIDE_THE_ROUTER = [
  ...BEFORE_THE_ROUTER,
  'POST /.well-known/oauth-authorization-server',
  'GET /.well-known/openid-configuration',
  'GET /convex/.well-known/openid-configuration',
  'GET /no-such-route',
  'POST /no-such-route',
]

describe.each(KINDS)('the auth routes a %s deployment serves', (kind, routes, env) => {
  it('lists only routes Better Auth serves', async () => {
    const auth = authOf(env)
    const served = routesOf(auth)
    const unserved = routes.filter((route) => !served.some((each) => takes(each, route)))
    expect(unserved).toEqual(kind === 'demo' ? [] : BEFORE_THE_ROUTER)
    for (const route of unserved) {
      const response = await auth.handler(requestFor(route))
      expect([route, response.status, response.headers.get('Content-Type')]).toEqual([
        route,
        200,
        'application/json',
      ])
    }
  })

  it('answers 404 before reading the request on every other route', async () => {
    const auth = authOf(env)
    const others = [...routesOf(auth), ...OUTSIDE_THE_ROUTER]
      .map(requestFor)
      .filter((request) => !servesAuthRoute(routes, request))
    expect(others.length).toBeGreaterThan(20)
    for (const request of others) {
      const response = await auth.handler(request)
      expect([request.method, new URL(request.url).pathname, response.status]).toEqual([
        request.method,
        new URL(request.url).pathname,
        404,
      ])
      expect(await response.text()).toBe('Not Found')
      expect(request.bodyUsed).toBe(false)
    }
  })
})

describe('the auth routes over HTTP', () => {
  const http = (t: T, path: string, init: { method: string; body?: string }): Promise<Response> =>
    (t as unknown as { fetch(path: string, init: object): Promise<Response> }).fetch(path, {
      ...init,
      headers: { Origin: 'http://localhost:5199', 'Content-Type': 'application/json' },
    })

  it.each([
    ['POST', '/link-social', { provider: 'google', scopes: [] }],
    ['POST', '/oauth2/update-consent', { id: 'x', update: { scopes: [] } }],
    ['POST', '/admin/has-permission', { permission: {} }],
    ['POST', '/admin/set-role', { userId: 'x', role: '' }],
    ['GET', '/ok', null],
    ['GET', '/.well-known/openid-configuration', null],
    ['GET', '/convex/.well-known/openid-configuration', null],
  ])('answers %s %s with 404 before validation', async (method, path, body) => {
    const response = await http(newT(), `/api/auth${path}`, {
      method,
      ...(body ? { body: JSON.stringify({ ...body, filler: Array(20_000).fill(1) }) } : {}),
    })
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Not Found')
  })

  it('answers 404 before reading a body over the cap', async () => {
    const response = await http(newT(), '/api/auth/link-social', {
      method: 'POST',
      body: JSON.stringify({ filler: 'x'.repeat(AUTH_BODY_MAX_BYTES) }),
    })
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Not Found')
  })

  it('still answers a route it serves', async () => {
    const response = await http(newT(), '/api/auth/get-session', { method: 'GET' })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('null')
  })

  it('serves the same metadata after the issuer path as before it, and no OpenID configuration', async () => {
    const t = newT()
    const metadata = async (path: string) => {
      const response = await http(t, path, { method: 'GET' })
      expect([path, response.status]).toEqual([path, 200])
      return response.json()
    }
    const appended = await metadata('/api/auth/.well-known/oauth-authorization-server')
    expect(appended).toEqual(await metadata('/.well-known/oauth-authorization-server/api/auth'))
    expect(appended).toMatchObject({ issuer: expect.stringMatching(/\/api\/auth$/) })
    // no redirect to the Convex plugin's configuration, which nothing serves
    const root = await http(t, '/.well-known/openid-configuration', { method: 'GET' })
    expect([root.status, root.headers.get('Location')]).toEqual([404, null])
  })
})

describe('servesAuthRoute', () => {
  const at = (method: string, path: string) =>
    servesAuthRoute(AUTH_ROUTES, new Request(`${SITE}${path}`, { method }))

  it('serves a listed method and path, and a filled-in segment', () => {
    expect(at('GET', '/api/auth/get-session')).toBe(true)
    expect(at('POST', '/api/auth/oauth2/token')).toBe(true)
    expect(at('GET', '/api/auth/reset-password/a-token')).toBe(true)
    expect(at('GET', '/api/auth/callback/google')).toBe(true)
    expect(at('HEAD', '/api/auth/.well-known/oauth-authorization-server')).toBe(true)
  })

  it('refuses anything that only resembles a listed route', () => {
    for (const [method, path] of [
      ['POST', '/api/auth/get-session'],
      ['HEAD', '/api/auth/get-session'],
      ['GET', '/api/auth/get-session/'],
      ['GET', '/api/auth/Get-Session'],
      ['GET', '/api/auth/get%2Dsession'],
      ['GET', '/api/auth//get-session'],
      ['GET', '/api/auth/get-session/x'],
      ['GET', '/get-session'],
      ['GET', '/api/authget-session'],
      ['GET', '/api/auth/reset-password/'],
      ['GET', '/api/auth/reset-password/a/b'],
      ['GET', '/api/auth/callback/github'],
      ['POST', '/api/auth/callback/google'],
      ['POST', '/api/auth/sign-in/anonymous'],
      ['GET', '/api/auth/a-route-better-auth-adds-later'],
    ])
      expect(at(method, path), `${method} ${path}`).toBe(false)
  })

  it('serves the demo only its anonymous sign-in, session and token routes', () => {
    const demo = (method: string, path: string) =>
      servesAuthRoute(DEMO_AUTH_ROUTES, new Request(`${SITE}/api/auth${path}`, { method }))
    expect(demo('POST', '/sign-in/anonymous')).toBe(true)
    expect(demo('GET', '/convex/token')).toBe(true)
    expect(demo('POST', '/sign-in/email')).toBe(false)
    expect(demo('GET', '/convex/.well-known/openid-configuration')).toBe(false)
  })
})

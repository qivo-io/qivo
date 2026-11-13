/* The sign-in, OAuth and metadata routes as the HTTP router serves them, for
 * a regular deployment and for the demo: the router's table of these
 * routes, and the status, every header and the body of each answer, through
 * t.fetch as a client sends them. Every route lib/authRoutes.ts lists is
 * swept too, with its status, its header names and its content type.
 *
 * The values were taken from the router that registered these routes
 * through the adapter copy's registerRoutes, and this file is not edited
 * when the router changes how it registers or loads them, so a change that
 * passes it answers exactly as before. A value that must change is a change
 * in what a caller sees and needs its own reason.
 *
 * http.ts reads the kind of deployment when it loads, so each kind stubs its
 * settings and resets the module registry before its first request.
 * Session tokens, JSON Web Tokens, ids and times are masked to their shape. */
/// <reference types="vite/client" />
import { hashPassword } from 'better-auth/crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { components } from '../_generated/api'
import { AUTH_ROUTES, DEMO_AUTH_ROUTES } from '../lib/authRoutes'
import { AUTH_BODY_MAX_BYTES } from '../lib/limits'
import { newT, type T } from './helpers.setup'

type Init = { method?: string; headers?: Record<string, string>; body?: string }
const fetchOf = (t: T, path: string, init?: Init): Promise<Response> =>
  (t as unknown as { fetch(path: string, init?: Init): Promise<Response> }).fetch(path, init)

const SECRET = 'auth-http-parity-secret-never-a-deployment'
const REGULAR_APP = 'https://preview.qivo.io'
const SECOND_APP = 'https://second.qivo.test'
const DEMO_APP = 'https://demo.qivo.io'
const LOCAL_APP = 'http://localhost:5199'
const FOREIGN = 'https://client.example'

/* The settings of each kind of deployment. */
const REGULAR = {
  QIVO_ENVIRONMENT: 'staging',
  SITE_URL: REGULAR_APP,
  ADDITIONAL_APP_ORIGINS: SECOND_APP,
  BETTER_AUTH_SECRET: SECRET,
}
const DEMO = {
  QIVO_ENVIRONMENT: 'demo',
  APP_MODE: 'demo',
  SITE_URL: DEMO_APP,
  BETTER_AUTH_SECRET: SECRET,
}

/* Sets `env` for the tests of one describe and resets the module registry,
 * so http.ts loads again under it. The values are set directly rather than
 * stubbed, so a test's own vi.stubEnv and vi.unstubAllEnvs leave them. */
function deployment(env: Record<string, string>) {
  const before: Record<string, string | undefined> = {}
  beforeAll(() => {
    for (const [name, value] of Object.entries(env)) {
      before[name] = process.env[name]
      process.env[name] = value
    }
    vi.resetModules()
  })
  afterAll(() => {
    for (const [name, value] of Object.entries(before))
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    vi.resetModules()
  })
}

afterEach(() => vi.unstubAllEnvs())

/* The router's routes under /api/auth and /.well-known, as [path, method],
 * a prefix route's path ending in `*`, in sorted order. */
async function authRouteTable(): Promise<[string, string][]> {
  const http = (await import('../http')).default
  return http
    .getRoutes()
    .map(([path, method]): [string, string] => [path, method])
    .filter(([path]) => path.startsWith('/api/auth') || path.startsWith('/.well-known'))
    .sort(([a, m], [b, n]) => (a === b ? (m < n ? -1 : 1) : a < b ? -1 : 1))
}

const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/
const TIMES = new Set(['createdAt', 'updatedAt', 'expiresAt'])
const IDS = new Set(['id', 'userId'])

/* `value` with its tokens, ids, times and generated addresses masked. */
function masked(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((each) => masked(each))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, masked(v, k)]))
  if (typeof value === 'string' && JWT.test(value)) return '<jwt>'
  if (key === 'token' && typeof value === 'string') return '<token>'
  if (IDS.has(key) && typeof value === 'string') return '<id>'
  if (TIMES.has(key) && typeof value === 'number') return '<time>'
  if (typeof value === 'string' && /^temp-[a-z0-9]+@demo\.qivo\.invalid$/.test(value))
    return '<temporary address>'
  return value
}

/* A header's value with its cookie values and dates masked. */
const maskedHeader = (name: string, value: string) =>
  name === 'date'
    ? '<date>'
    : name === 'set-cookie' || name === 'set-better-auth-cookie'
      ? value.replace(/(session_token|convex_jwt)=[^;]+/g, '$1=<value>')
      : value

type Answer = { status: number; headers: string[]; body: unknown }

/* What `response` answered: its status, every header as `name: value` in
 * sorted order, and its body, parsed when it is JSON. */
async function answerOf(response: Response): Promise<Answer> {
  const text = await response.text()
  let body: unknown = text
  if (response.headers.get('Content-Type')?.startsWith('application/json') && text !== '')
    body = masked(JSON.parse(text))
  return {
    status: response.status,
    headers: [...response.headers]
      .map(([name, value]) => `${name}: ${maskedHeader(name, value)}`)
      .sort(),
    body,
  }
}

/* `lists` of `name: value` headers as one sorted list. */
const headers = (...lists: string[][]) => lists.flat().sort()

/* The CORS headers the /api/auth/ prefix adds to an answer, with the
 * origin echoed when it is one it allows. */
const authCors = (origin?: string) => [
  'access-control-allow-credentials: true',
  ...(origin ? [`access-control-allow-origin: ${origin}`] : []),
  'access-control-expose-headers: Set-Better-Auth-Cookie',
  'vary: Origin',
]

/* The /api/auth/ prefix's preflight answer. */
const authPreflight = (origin: string | undefined, demo = false) => ({
  status: 204,
  headers: headers(authCors(origin), [
    `access-control-allow-headers: Content-Type, Better-Auth-Cookie, Authorization${demo ? ', X-Qivo-Demo-Visitor' : ''}`,
    'access-control-allow-methods: GET, POST',
    'access-control-max-age: 86400',
  ]),
  body: '',
})

/* The headers of every OAuth machine answer (http.ts oauthMachineHeaders). */
const MACHINE = [
  'access-control-allow-headers: Content-Type, Authorization',
  'access-control-allow-methods: POST, OPTIONS',
  'access-control-allow-origin: *',
  'access-control-expose-headers: WWW-Authenticate, Retry-After',
  'cache-control: no-store',
]

/* The headers of the authorization server metadata at the root paths. */
const METADATA_HEADERS = [
  'access-control-allow-methods: GET, OPTIONS',
  'access-control-allow-origin: *',
  'cache-control: public, max-age=300',
  'content-type: application/json',
]

/* The one authorization server metadata document every path serves. */
const METADATA = {
  scopes_supported: ['qivo:read', 'qivo:write', 'offline_access'],
  issuer: 'https://some.convex.site/api/auth',
  authorization_endpoint: 'https://some.convex.site/api/auth/oauth2/authorize',
  token_endpoint: 'https://some.convex.site/api/auth/oauth2/token',
  registration_endpoint: 'https://some.convex.site/api/auth/oauth2/register',
  revocation_endpoint: 'https://some.convex.site/api/auth/oauth2/revoke',
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  revocation_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
  authorization_response_iss_parameter_supported: true,
  backchannel_logout_supported: false,
  backchannel_logout_session_supported: false,
}

/* The session cookie of a sign-in, masked. A sign-in also clears the token
 * cookie, so that no token of an earlier session outlives it, and the page
 * asks /convex/token for the new session's. */
const SIGNED_IN_COOKIE = (maxAge: number) =>
  `set-better-auth-cookie: __Secure-better-auth.session_token=<value>; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax, __Secure-better-auth.convex_jwt=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
const TOKEN_COOKIE =
  'set-better-auth-cookie: __Secure-better-auth.convex_jwt=<value>; Max-Age=900; Path=/; HttpOnly; Secure; SameSite=Lax'
const CLEARED_TOKEN_COOKIE =
  'set-cookie: __Secure-better-auth.convex_jwt=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax'

const preflight = (origin: string, method = 'POST'): Init => ({
  method: 'OPTIONS',
  headers: {
    Origin: origin,
    'Access-Control-Request-Method': method,
    'Access-Control-Request-Headers': 'content-type,better-auth-cookie',
  },
})
const postJson = (origin: string, body: string, more: Record<string, string> = {}): Init => ({
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json', ...more },
  body,
})
const overTheCap = JSON.stringify({ filler: 'x'.repeat(AUTH_BODY_MAX_BYTES) })

/* The session cookie a sign-in answered, to send back. */
const sessionCookie = (response: Response) => {
  const cookie = response.headers
    .get('Set-Better-Auth-Cookie')
    ?.match(/(?:^|,\s*)([^=;,]*session_token=[^;]+)/)?.[1]
  if (!cookie) throw new Error(`no session cookie in a ${response.status} answer`)
  return cookie
}

const EMAIL = 'parity@example.test'
const PASSWORD = 'Hermetic parity password 314159!'

/* A login with a confirmed address and PASSWORD. */
async function plantLogin(t: T) {
  const now = Date.now()
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: { name: 'Parity', email: EMAIL, emailVerified: true, createdAt: now, updatedAt: now },
    },
  })
  await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'account',
      data: {
        accountId: user._id,
        userId: user._id,
        providerId: 'credential',
        password: await hashPassword(PASSWORD),
        createdAt: now,
        updatedAt: now,
      },
    },
  })
}

/* A session of the planted login, signed in from the regular app. */
async function regularSession(t: T) {
  await plantLogin(t)
  return sessionCookie(
    await fetchOf(
      t,
      '/api/auth/sign-in/email',
      postJson(REGULAR_APP, JSON.stringify({ email: EMAIL, password: PASSWORD }), {
        'Better-Auth-Cookie': '',
      }),
    ),
  )
}

/* A demo visitor's session, admitted. */
async function demoSession(t: T) {
  vi.stubEnv('DEMO_ADMISSION_OPEN', 'true')
  return sessionCookie(
    await fetchOf(
      t,
      '/api/auth/sign-in/anonymous',
      postJson(DEMO_APP, '{}', { 'Better-Auth-Cookie': '' }),
    ),
  )
}

const ROOT_METADATA = '/.well-known/oauth-authorization-server'
const ISSUER_METADATA = '/.well-known/oauth-authorization-server/api/auth'
const PREFIX_METADATA = '/api/auth/.well-known/oauth-authorization-server'

/* The login every regular sign-in answers, masked. */
const PARITY_USER = {
  name: 'Parity',
  email: EMAIL,
  emailVerified: true,
  createdAt: '<time>',
  updatedAt: '<time>',
  id: '<id>',
}

type Case = [name: string, send: (t: T) => Promise<Response>, expected: Answer]

const REGULAR_CASES: Case[] = [
  [
    'OPTIONS /api/auth/sign-in/email from the app',
    (t) => fetchOf(t, '/api/auth/sign-in/email', preflight(REGULAR_APP)),
    authPreflight(REGULAR_APP),
  ],
  [
    'OPTIONS /api/auth/sign-in/email from an additional app origin',
    (t) => fetchOf(t, '/api/auth/sign-in/email', preflight(SECOND_APP)),
    authPreflight(SECOND_APP),
  ],
  [
    'OPTIONS /api/auth/sign-in/email from http://localhost:5199',
    (t) => fetchOf(t, '/api/auth/sign-in/email', preflight(LOCAL_APP)),
    authPreflight(LOCAL_APP),
  ],
  [
    'OPTIONS /api/auth/sign-in/email from a foreign origin',
    (t) => fetchOf(t, '/api/auth/sign-in/email', preflight(FOREIGN)),
    authPreflight(undefined),
  ],
  [
    'OPTIONS /api/auth/get-session from the app',
    (t) => fetchOf(t, '/api/auth/get-session', preflight(REGULAR_APP, 'GET')),
    authPreflight(REGULAR_APP),
  ],
  [
    'GET /api/auth/get-session without a cookie',
    (t) => fetchOf(t, '/api/auth/get-session', { headers: { Origin: REGULAR_APP } }),
    {
      status: 200,
      headers: headers(authCors(REGULAR_APP), [
        'cache-control: no-store',
        'content-type: application/json',
        'pragma: no-cache',
        CLEARED_TOKEN_COOKIE,
      ]),
      body: null,
    },
  ],
  [
    'POST /api/auth/sign-in/email with a wrong password',
    async (t) => {
      await plantLogin(t)
      return fetchOf(
        t,
        '/api/auth/sign-in/email',
        postJson(REGULAR_APP, JSON.stringify({ email: EMAIL, password: 'not the password 1' })),
      )
    },
    {
      status: 401,
      // every answer of a sign-in route clears the token cookie
      headers: headers(authCors(REGULAR_APP), [
        'content-type: application/json',
        CLEARED_TOKEN_COOKIE,
      ]),
      body: { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' },
    },
  ],
  [
    'POST /api/auth/sign-in/email with the right password',
    async (t) => {
      await plantLogin(t)
      return fetchOf(
        t,
        '/api/auth/sign-in/email',
        postJson(REGULAR_APP, JSON.stringify({ email: EMAIL, password: PASSWORD }), {
          'Better-Auth-Cookie': '',
        }),
      )
    },
    {
      status: 200,
      headers: headers(authCors(REGULAR_APP), [
        'content-type: application/json',
        SIGNED_IN_COOKIE(604800),
      ]),
      body: { redirect: false, token: '<token>', user: PARITY_USER },
    },
  ],
  [
    'GET /api/auth/get-session with the session',
    async (t) =>
      fetchOf(t, '/api/auth/get-session', {
        headers: { Origin: REGULAR_APP, 'Better-Auth-Cookie': await regularSession(t) },
      }),
    {
      status: 200,
      headers: headers(authCors(REGULAR_APP), [
        'cache-control: no-store',
        'content-type: application/json',
        'pragma: no-cache',
        TOKEN_COOKIE,
      ]),
      body: {
        session: {
          expiresAt: '<time>',
          token: '<token>',
          createdAt: '<time>',
          updatedAt: '<time>',
          userId: '<id>',
          id: '<id>',
        },
        user: PARITY_USER,
      },
    },
  ],
  [
    'GET /api/auth/convex/token with the session',
    async (t) =>
      fetchOf(t, '/api/auth/convex/token', {
        headers: { Origin: REGULAR_APP, 'Better-Auth-Cookie': await regularSession(t) },
      }),
    {
      status: 200,
      headers: headers(authCors(REGULAR_APP), ['content-type: application/json', TOKEN_COOKIE]),
      body: { token: '<jwt>' },
    },
  ],
  [
    'POST /api/auth/sign-up/email on a deployment without mail',
    (t) =>
      fetchOf(
        t,
        '/api/auth/sign-up/email',
        postJson(REGULAR_APP, JSON.stringify({ email: 'x', password: 1, name: [] })),
      ),
    {
      status: 503,
      headers: headers(authCors(REGULAR_APP), ['content-type: application/json']),
      body: {
        message:
          'Qivo cannot send email right now, so it cannot confirm a new account. Try again later.',
        code: 'AUTH_MAIL_UNAVAILABLE',
      },
    },
  ],
  [
    'POST /api/auth/sign-in/social with a large body that fails validation',
    (t) =>
      fetchOf(
        t,
        '/api/auth/sign-in/social',
        postJson(
          REGULAR_APP,
          JSON.stringify({ provider: 'google', scopes: Array(20_000).fill(1) }),
        ),
      ),
    {
      status: 400,
      headers: headers(authCors(REGULAR_APP), [
        'content-type: application/json',
        CLEARED_TOKEN_COOKIE,
      ]),
      body: {
        message: '[body.scopes.0] Invalid input: expected string, received number',
        code: 'VALIDATION_ERROR',
      },
    },
  ],
  [
    'POST /api/auth/sign-in/email with a body just over the cap',
    (t) => fetchOf(t, '/api/auth/sign-in/email', postJson(REGULAR_APP, overTheCap)),
    {
      status: 413,
      headers: headers(authCors(REGULAR_APP), [
        'cache-control: no-store',
        'content-type: application/json',
      ]),
      body: {
        code: 'PAYLOAD_TOO_LARGE',
        message:
          'The request body is larger than the 64 KiB a sign-in request may hold. Shorten what you sent and try again.',
      },
    },
  ],
  [
    'POST /api/auth/link-social, a route Qivo does not serve',
    (t) => fetchOf(t, '/api/auth/link-social', postJson(REGULAR_APP, '{}')),
    {
      status: 404,
      headers: headers(authCors(REGULAR_APP), ['content-type: text/plain;charset=UTF-8']),
      body: 'Not Found',
    },
  ],
  [
    'POST /api/auth/link-social with a body over the cap',
    (t) => fetchOf(t, '/api/auth/link-social', postJson(REGULAR_APP, overTheCap)),
    {
      status: 404,
      headers: headers(authCors(REGULAR_APP), ['content-type: text/plain;charset=UTF-8']),
      body: 'Not Found',
    },
  ],
  ...(['token', 'register'] as const).flatMap((endpoint): Case[] => [
    [
      `OPTIONS /api/auth/oauth2/${endpoint} from a foreign origin`,
      (t) =>
        fetchOf(t, `/api/auth/oauth2/${endpoint}`, {
          method: 'OPTIONS',
          headers: {
            Origin: FOREIGN,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type,authorization',
          },
        }),
      { status: 204, headers: headers(MACHINE), body: '' },
    ],
  ]),
  [
    'POST /api/auth/oauth2/token as JSON from a foreign origin',
    (t) => fetchOf(t, '/api/auth/oauth2/token', postJson(FOREIGN, '{}')),
    {
      status: 400,
      headers: headers(MACHINE, ['content-type: application/json']),
      body: {
        error: 'invalid_request',
        error_description: 'Use an application/x-www-form-urlencoded token request.',
      },
    },
  ],
  [
    'POST /api/auth/oauth2/register without redirect URIs from a foreign origin',
    (t) => fetchOf(t, '/api/auth/oauth2/register', postJson(FOREIGN, '{}')),
    {
      status: 400,
      headers: headers(MACHINE, ['content-type: application/json', 'pragma: no-cache']),
      body: {
        error: 'invalid_redirect_uri',
        error_description:
          'Redirect URIs are required for authorization_code and implicit grant types',
      },
    },
  ],
  ...[ROOT_METADATA, ISSUER_METADATA].flatMap((path): Case[] => [
    [
      `GET ${path}`,
      (t) => fetchOf(t, path, { headers: { Origin: FOREIGN } }),
      { status: 200, headers: headers(METADATA_HEADERS), body: METADATA },
    ],
    [
      `OPTIONS ${path}`,
      (t) =>
        fetchOf(t, path, {
          method: 'OPTIONS',
          headers: { Origin: FOREIGN, 'Access-Control-Request-Method': 'GET' },
        }),
      { status: 204, headers: headers(METADATA_HEADERS), body: '' },
    ],
  ]),
  [
    `GET ${PREFIX_METADATA}`,
    (t) => fetchOf(t, PREFIX_METADATA, { headers: { Origin: FOREIGN } }),
    {
      status: 200,
      headers: headers(authCors(), [
        'cache-control: public, max-age=15, stale-while-revalidate=15, stale-if-error=86400',
        'content-type: application/json',
      ]),
      body: METADATA,
    },
  ],
  [
    `OPTIONS ${PREFIX_METADATA}`,
    (t) =>
      fetchOf(t, PREFIX_METADATA, {
        method: 'OPTIONS',
        headers: { Origin: FOREIGN, 'Access-Control-Request-Method': 'GET' },
      }),
    authPreflight(undefined),
  ],
  [
    'GET /.well-known/openid-configuration',
    (t) => fetchOf(t, '/.well-known/openid-configuration'),
    { status: 404, headers: ['content-type: text/plain;charset=UTF-8'], body: 'Not Found' },
  ],
]

/* Convex's own answer to a path no route serves (convex-test's wording). */
const unrouted = (path: string): Answer => ({
  status: 404,
  headers: ['content-type: text/plain;charset=UTF-8'],
  body: `No HttpAction routed for ${path}`,
})
const DEMO_REFUSAL = { message: 'This feature requires a regular workspace.' }

/* The demo visitor every anonymous sign-in answers, masked. */
const DEMO_USER = {
  name: 'Nora',
  email: '<temporary address>',
  emailVerified: false,
  createdAt: '<time>',
  updatedAt: '<time>',
  role: 'user',
  banned: false,
  isAnonymous: true,
  id: '<id>',
}

const DEMO_CASES: Case[] = [
  [
    'OPTIONS /api/auth/sign-in/anonymous from the demo app',
    (t) => fetchOf(t, '/api/auth/sign-in/anonymous', preflight(DEMO_APP)),
    authPreflight(DEMO_APP, true),
  ],
  [
    'OPTIONS /api/auth/sign-in/anonymous from http://localhost:5199',
    (t) => fetchOf(t, '/api/auth/sign-in/anonymous', preflight(LOCAL_APP)),
    authPreflight(undefined, true),
  ],
  [
    'OPTIONS /api/auth/sign-in/anonymous from a foreign origin',
    (t) => fetchOf(t, '/api/auth/sign-in/anonymous', preflight(FOREIGN)),
    authPreflight(undefined, true),
  ],
  [
    'OPTIONS /api/auth/get-session from the demo app',
    (t) => fetchOf(t, '/api/auth/get-session', preflight(DEMO_APP, 'GET')),
    authPreflight(DEMO_APP, true),
  ],
  [
    'GET /api/auth/get-session without a cookie',
    (t) => fetchOf(t, '/api/auth/get-session', { headers: { Origin: DEMO_APP } }),
    {
      status: 200,
      headers: headers(authCors(DEMO_APP), [
        'cache-control: no-store',
        'content-type: application/json',
        'pragma: no-cache',
        CLEARED_TOKEN_COOKIE,
      ]),
      body: null,
    },
  ],
  [
    'POST /api/auth/sign-in/anonymous from a foreign origin',
    (t) => fetchOf(t, '/api/auth/sign-in/anonymous', postJson(FOREIGN, '{}')),
    { status: 403, headers: headers(authCors()), body: '' },
  ],
  [
    'POST /api/auth/sign-in/anonymous as text/plain',
    (t) =>
      fetchOf(t, '/api/auth/sign-in/anonymous', {
        method: 'POST',
        headers: { Origin: DEMO_APP, 'Content-Type': 'text/plain' },
        body: '{}',
      }),
    { status: 415, headers: headers(authCors(DEMO_APP)), body: '' },
  ],
  [
    'POST /api/auth/sign-in/anonymous with admission closed',
    (t) => fetchOf(t, '/api/auth/sign-in/anonymous', postJson(DEMO_APP, '{}')),
    {
      status: 429,
      headers: headers(authCors(DEMO_APP), [
        'cache-control: no-store',
        'content-type: application/json',
        'retry-after: 60',
      ]),
      body: { message: 'The demo is busy. Please try again shortly.' },
    },
  ],
  [
    'POST /api/auth/sign-in/anonymous admitted',
    (t) => {
      vi.stubEnv('DEMO_ADMISSION_OPEN', 'true')
      return fetchOf(
        t,
        '/api/auth/sign-in/anonymous',
        postJson(DEMO_APP, '{}', { 'Better-Auth-Cookie': '' }),
      )
    },
    {
      status: 200,
      headers: headers(authCors(DEMO_APP), [
        'content-type: application/json',
        SIGNED_IN_COOKIE(86400),
      ]),
      body: { token: '<token>', user: DEMO_USER },
    },
  ],
  [
    'GET /api/auth/get-session with a demo session',
    async (t) =>
      fetchOf(t, '/api/auth/get-session', {
        headers: { Origin: DEMO_APP, 'Better-Auth-Cookie': await demoSession(t) },
      }),
    {
      status: 200,
      headers: headers(authCors(DEMO_APP), [
        'cache-control: no-store',
        'content-type: application/json',
        'pragma: no-cache',
        TOKEN_COOKIE,
      ]),
      body: {
        session: {
          expiresAt: '<time>',
          token: '<token>',
          createdAt: '<time>',
          updatedAt: '<time>',
          userId: '<id>',
          id: '<id>',
        },
        user: DEMO_USER,
      },
    },
  ],
  [
    'GET /api/auth/convex/token with a demo session',
    async (t) =>
      fetchOf(t, '/api/auth/convex/token', {
        headers: { Origin: DEMO_APP, 'Better-Auth-Cookie': await demoSession(t) },
      }),
    {
      status: 200,
      headers: headers(authCors(DEMO_APP), ['content-type: application/json', TOKEN_COOKIE]),
      body: { token: '<jwt>' },
    },
  ],
  [
    'POST /api/auth/sign-in/email, which the demo does not serve',
    (t) => fetchOf(t, '/api/auth/sign-in/email', postJson(DEMO_APP, '{}')),
    {
      status: 403,
      headers: headers(authCors(DEMO_APP), [
        'cache-control: no-store',
        'content-type: application/json',
      ]),
      body: DEMO_REFUSAL,
    },
  ],
  [
    'POST /api/auth/sign-in/anonymous with a body just over the cap',
    (t) => fetchOf(t, '/api/auth/sign-in/anonymous', postJson(DEMO_APP, overTheCap)),
    {
      status: 413,
      headers: headers(authCors(DEMO_APP), [
        'cache-control: no-store',
        'content-type: application/json',
      ]),
      body: {
        code: 'PAYLOAD_TOO_LARGE',
        message:
          'The request body is larger than the 64 KiB a sign-in request may hold. Shorten what you sent and try again.',
      },
    },
  ],
  [
    'POST /api/auth/link-social with a body over the cap',
    (t) => fetchOf(t, '/api/auth/link-social', postJson(DEMO_APP, overTheCap)),
    {
      status: 403,
      headers: headers(authCors(DEMO_APP), [
        'cache-control: no-store',
        'content-type: application/json',
      ]),
      body: DEMO_REFUSAL,
    },
  ],
  ...(['token', 'register'] as const).flatMap((endpoint): Case[] => [
    [
      `OPTIONS /api/auth/oauth2/${endpoint} from a foreign origin`,
      (t) =>
        fetchOf(t, `/api/auth/oauth2/${endpoint}`, {
          method: 'OPTIONS',
          headers: { Origin: FOREIGN, 'Access-Control-Request-Method': 'POST' },
        }),
      { status: 204, headers: headers(MACHINE), body: '' },
    ],
    [
      `POST /api/auth/oauth2/${endpoint} from a foreign origin`,
      (t) => fetchOf(t, `/api/auth/oauth2/${endpoint}`, postJson(FOREIGN, '{}')),
      { status: 403, headers: headers(MACHINE), body: '' },
    ],
  ]),
  ...[ROOT_METADATA, ISSUER_METADATA].flatMap((path): Case[] => [
    [`GET ${path}`, (t) => fetchOf(t, path, { headers: { Origin: FOREIGN } }), unrouted(path)],
    [
      `OPTIONS ${path}`,
      (t) =>
        fetchOf(t, path, {
          method: 'OPTIONS',
          headers: { Origin: FOREIGN, 'Access-Control-Request-Method': 'GET' },
        }),
      unrouted(path),
    ],
  ]),
  [
    `GET ${PREFIX_METADATA}`,
    (t) => fetchOf(t, PREFIX_METADATA, { headers: { Origin: FOREIGN } }),
    {
      status: 403,
      headers: headers(authCors(), ['cache-control: no-store', 'content-type: application/json']),
      body: DEMO_REFUSAL,
    },
  ],
  [
    `OPTIONS ${PREFIX_METADATA}`,
    (t) =>
      fetchOf(t, PREFIX_METADATA, {
        method: 'OPTIONS',
        headers: { Origin: FOREIGN, 'Access-Control-Request-Method': 'GET' },
      }),
    authPreflight(undefined, true),
  ],
  [
    'GET /.well-known/openid-configuration',
    (t) => fetchOf(t, '/.well-known/openid-configuration'),
    { status: 404, headers: ['content-type: text/plain;charset=UTF-8'], body: 'Not Found' },
  ],
]

/* A request for `route` from lib/authRoutes.ts, as authRoutes.test.ts
 * builds it: any `:name` segment filled in, and for a POST a JSON body that
 * fails validation, so no route sends mail or reaches a provider. */
function sweepRequest(route: string): [string, Init] {
  const [method, path] = route.split(' ')
  const body = JSON.stringify({ scopes: Array(Math.floor(AUTH_BODY_MAX_BYTES / 3)).fill(1) })
  return [
    `/api/auth${path.replace(/:[^/]+/g, 'x')}`,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body } : {}),
    },
  ]
}

type Swept = [status: number, headerNames: string[], contentType: string | null]

/* The names of the headers of every answer of the /api/auth/ prefix, and of
 * the OAuth machine routes, without an Origin. */
const PREFIX_NAMES = ['access-control-allow-credentials', 'access-control-expose-headers', 'vary']
const MACHINE_NAMES = [
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-origin',
  'access-control-expose-headers',
  'cache-control',
  'content-type',
]
const prefixed = (...names: string[]) => [...PREFIX_NAMES, ...names].sort()
const SESSION_NAMES = prefixed('cache-control', 'content-type', 'pragma', 'set-cookie')
const SIGN_OUT_NAMES = prefixed(
  'content-type',
  'set-cookie',
  'set-cookie',
  'set-cookie',
  'set-cookie',
)
const JSON_TYPE = 'application/json'

/* What each route the regular deployment serves answers to sweepRequest. */
const REGULAR_SWEEP: Record<(typeof AUTH_ROUTES)[number], Swept> = {
  'GET /get-session': [200, SESSION_NAMES, JSON_TYPE],
  'GET /convex/token': [401, prefixed('content-type'), JSON_TYPE],
  'POST /sign-in/email': [400, prefixed('content-type', 'set-cookie'), JSON_TYPE],
  'POST /sign-out': [200, SIGN_OUT_NAMES, JSON_TYPE],
  'POST /sign-up/email': [503, prefixed('content-type'), JSON_TYPE],
  'POST /sign-in/social': [400, prefixed('content-type', 'set-cookie'), JSON_TYPE],
  'POST /send-verification-email': [503, prefixed('content-type'), JSON_TYPE],
  'POST /request-password-reset': [503, prefixed('content-type'), JSON_TYPE],
  'POST /reset-password': [400, prefixed('content-type'), JSON_TYPE],
  'POST /cross-domain/one-time-token/verify': [400, prefixed('content-type'), JSON_TYPE],
  'GET /callback/google': [302, prefixed('content-type', 'location', 'set-cookie'), JSON_TYPE],
  'GET /callback/microsoft': [302, prefixed('content-type', 'location', 'set-cookie'), JSON_TYPE],
  'GET /verify-email': [400, prefixed('content-type'), JSON_TYPE],
  'GET /reset-password/:token': [400, prefixed('content-type'), JSON_TYPE],
  'GET /error': [200, prefixed('content-type'), 'text/html'],
  'GET /convex/jwks': [200, prefixed('content-type'), JSON_TYPE],
  'GET /oauth2/authorize': [400, prefixed('content-type'), JSON_TYPE],
  'POST /oauth2/consent': [400, prefixed('content-type'), JSON_TYPE],
  'POST /oauth2/register': [400, MACHINE_NAMES, JSON_TYPE],
  'POST /oauth2/token': [400, MACHINE_NAMES, JSON_TYPE],
  'POST /oauth2/revoke': [415, MACHINE_NAMES, JSON_TYPE],
  'GET /.well-known/oauth-authorization-server': [
    200,
    prefixed('cache-control', 'content-type'),
    JSON_TYPE,
  ],
  'HEAD /.well-known/oauth-authorization-server': [
    200,
    prefixed('cache-control', 'content-type'),
    JSON_TYPE,
  ],
}

/* What each route the demo serves answers to sweepRequest, admission open. */
const DEMO_SWEEP: Record<(typeof DEMO_AUTH_ROUTES)[number], Swept> = {
  'POST /sign-in/anonymous': [200, prefixed('content-type', 'set-cookie', 'set-cookie'), JSON_TYPE],
  'POST /sign-out': [200, SIGN_OUT_NAMES, JSON_TYPE],
  'GET /get-session': [200, SESSION_NAMES, JSON_TYPE],
  'GET /convex/token': [401, prefixed('content-type'), JSON_TYPE],
  'GET /convex/jwks': [200, prefixed('content-type'), JSON_TYPE],
}

/* What `route` answers to sweepRequest on a fresh backend. */
async function swept(route: string): Promise<Swept> {
  const response = await fetchOf(newT(), ...sweepRequest(route))
  await response.text()
  return [
    response.status,
    [...response.headers.keys()].sort(),
    response.headers.get('Content-Type'),
  ]
}

describe('a regular deployment', () => {
  deployment(REGULAR)

  it('routes the sign-in, OAuth and metadata paths as before', async () => {
    expect(await authRouteTable()).toEqual([
      ['/.well-known/oauth-authorization-server', 'GET'],
      ['/.well-known/oauth-authorization-server', 'OPTIONS'],
      ['/.well-known/oauth-authorization-server/api/auth', 'GET'],
      ['/.well-known/oauth-authorization-server/api/auth', 'OPTIONS'],
      ['/.well-known/oauth-protected-resource', 'GET'],
      ['/.well-known/oauth-protected-resource', 'OPTIONS'],
      ['/.well-known/oauth-protected-resource/mcp', 'GET'],
      ['/.well-known/oauth-protected-resource/mcp', 'OPTIONS'],
      ['/.well-known/openid-configuration', 'GET'],
      ['/api/auth/*', 'GET'],
      ['/api/auth/*', 'OPTIONS'],
      ['/api/auth/*', 'POST'],
      ['/api/auth/oauth2/register', 'OPTIONS'],
      ['/api/auth/oauth2/register', 'POST'],
      ['/api/auth/oauth2/revoke', 'OPTIONS'],
      ['/api/auth/oauth2/revoke', 'POST'],
      ['/api/auth/oauth2/token', 'OPTIONS'],
      ['/api/auth/oauth2/token', 'POST'],
    ])
  })

  it.each(REGULAR_CASES)('answers %s as before', async (_name, send, expected) => {
    expect(await answerOf(await send(newT()))).toEqual(expected)
  })

  it('sweeps every route it serves', () => {
    expect(Object.keys(REGULAR_SWEEP)).toEqual([...AUTH_ROUTES])
  })

  it.each(AUTH_ROUTES)('answers the served route %s as before', async (route) => {
    expect(await swept(route)).toEqual(REGULAR_SWEEP[route])
  })
})

describe('the demo', () => {
  deployment(DEMO)

  it('routes the sign-in, OAuth and metadata paths as before', async () => {
    expect(await authRouteTable()).toEqual([
      ['/.well-known/openid-configuration', 'GET'],
      ['/api/auth/*', 'GET'],
      ['/api/auth/*', 'OPTIONS'],
      ['/api/auth/*', 'POST'],
      ['/api/auth/oauth2/register', 'OPTIONS'],
      ['/api/auth/oauth2/register', 'POST'],
      ['/api/auth/oauth2/revoke', 'OPTIONS'],
      ['/api/auth/oauth2/revoke', 'POST'],
      ['/api/auth/oauth2/token', 'OPTIONS'],
      ['/api/auth/oauth2/token', 'POST'],
    ])
  })

  it.each(DEMO_CASES)('answers %s as before', async (_name, send, expected) => {
    expect(await answerOf(await send(newT()))).toEqual(expected)
  })

  it('records the visitor of an admitted sign-in', async () => {
    vi.stubEnv('DEMO_ADMISSION_OPEN', 'true')
    const t = newT()
    const response = await fetchOf(
      t,
      '/api/auth/sign-in/anonymous',
      postJson(DEMO_APP, '{}', {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/142.0',
      }),
    )
    expect(response.status).toBe(200)
    const visitors = await t.run(async (ctx) =>
      (await ctx.db.query('demo_sessions').collect()).map((row) => [
        row.visitor_browser,
        row.visitor_os,
      ]),
    )
    expect(visitors).toEqual([['Firefox', 'Linux']])
  })

  it('sweeps every route it serves', () => {
    expect(Object.keys(DEMO_SWEEP)).toEqual([...DEMO_AUTH_ROUTES])
  })

  it.each(DEMO_AUTH_ROUTES)('answers the served route %s as before', async (route) => {
    vi.stubEnv('DEMO_ADMISSION_OPEN', 'true')
    expect(await swept(route)).toEqual(DEMO_SWEEP[route])
  })
})

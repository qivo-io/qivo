/* The HTTP router when Better Auth cannot load. convex/auth.ts is mocked so
 * that importing it rejects, as on a runtime that refuses the sign-in,
 * OAuth machine and metadata handlers' import of it (http.ts). The router
 * itself still loads, and REST, MCP, the image links and every refusal that
 * needs no Better Auth answer as before: a route Qivo does not serve, the
 * demo's foreign or non-JSON anonymous sign-in, a body over the cap and the
 * OAuth machine routes on the demo. Every route that needs Better Auth fails
 * with an error, never with a 2xx or a cookie, and the demo's anonymous
 * sign-in takes no admission, because the import comes first. A last case lets the import
 * succeed with a recording stand-in for createAuth, to show what the
 * sign-in handler hands Better Auth. */
/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_BODY_MAX_BYTES } from '../lib/limits'
import { newT, type T } from './helpers.setup'

/* Whether importing auth.ts rejects, and the requests the stand-in got. */
const auth = vi.hoisted(() => ({ refused: true, received: [] as Request[] }))

vi.mock('../auth', () => {
  if (auth.refused) throw new Error('the runtime refused to import auth.ts')
  return {
    createAuth: () => ({
      handler: async (request: Request) => {
        auth.received.push(request)
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
      },
    }),
  }
})

type Init = { method?: string; headers?: Record<string, string>; body?: string }
const fetchOf = (t: T, path: string, init?: Init): Promise<Response> =>
  (t as unknown as { fetch(path: string, init?: Init): Promise<Response> }).fetch(path, init)

const APP = 'http://localhost:5199'
const DEMO_APP = 'https://demo.qivo.io'
const FOREIGN = 'https://client.example'
const json = (origin: string, body: string): Init => ({
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body,
})
const overTheCap = JSON.stringify({ filler: 'x'.repeat(AUTH_BODY_MAX_BYTES) })

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_SECRET', 'auth-load-refused-secret-never-a-deployment')
})
afterEach(() => vi.unstubAllEnvs())

/* Stubs the demo's settings. http.ts reads them on every request for the
 * refusals these cases reach. */
function demo() {
  vi.stubEnv('QIVO_ENVIRONMENT', 'demo')
  vi.stubEnv('APP_MODE', 'demo')
  vi.stubEnv('SITE_URL', DEMO_APP)
  vi.stubEnv('DEMO_ADMISSION_OPEN', 'true')
}

/* The error `sent` rejected with, or the response it answered. */
const settle = (sent: Promise<Response>) =>
  sent.then(
    (response) => response,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  )

/* An error's message with its causes', since vitest wraps the mock's. */
const reasons = (error: unknown): string =>
  error instanceof Error ? `${error.message} ${reasons(error.cause)}` : ''

/* Checks that `outcome` failed closed: an error whose reasons match
 * `reason`, or a 5xx that sets no cookie. */
function expectFailedClosed(outcome: Response | Error, reason: RegExp) {
  if (outcome instanceof Error) {
    expect(reasons(outcome)).toMatch(reason)
    return
  }
  expect(outcome.status).toBeGreaterThanOrEqual(500)
  expect(outcome.headers.get('Set-Cookie')).toBeNull()
  expect(outcome.headers.get('Set-Better-Auth-Cookie')).toBeNull()
}

describe('a router whose import of auth.ts is refused', () => {
  it.each([
    ['POST /api/auth/link-social', '{}'],
    ['POST /api/auth/link-social with a body over the cap', overTheCap],
  ])('still answers %s 404', async (_name, body) => {
    const response = await fetchOf(newT(), '/api/auth/link-social', json(APP, body))
    expect([response.status, await response.text()]).toEqual([404, 'Not Found'])
  })

  it('still answers an unlisted route on the demo 403', async () => {
    demo()
    const response = await fetchOf(newT(), '/api/auth/sign-in/email', json(DEMO_APP, overTheCap))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      message: 'This feature requires a regular workspace.',
    })
  })

  it("still refuses the demo's anonymous sign-in from a foreign origin and without JSON", async () => {
    demo()
    const t = newT()
    const foreign = await fetchOf(t, '/api/auth/sign-in/anonymous', json(FOREIGN, '{}'))
    expect(foreign.status).toBe(403)
    const plain = await fetchOf(t, '/api/auth/sign-in/anonymous', {
      method: 'POST',
      headers: { Origin: DEMO_APP, 'Content-Type': 'text/plain' },
      body: '{}',
    })
    expect(plain.status).toBe(415)
  })

  it.each([
    ['a sign-in', '/api/auth/sign-in/email', 'code', 'PAYLOAD_TOO_LARGE', 'message'],
    [
      "the demo's anonymous sign-in",
      '/api/auth/sign-in/anonymous',
      'code',
      'PAYLOAD_TOO_LARGE',
      'message',
    ],
    ['a token request', '/api/auth/oauth2/token', 'error', 'invalid_request', 'error_description'],
  ])(
    'still answers %s with a body over the cap 413',
    async (name, path, codeField, code, messageField) => {
      if (name.includes('demo')) demo()
      const response = await fetchOf(
        newT(),
        path,
        json(name.includes('demo') ? DEMO_APP : APP, overTheCap),
      )
      expect(response.status).toBe(413)
      const refusal = (await response.json()) as Record<string, string>
      expect(refusal[codeField]).toBe(code)
      expect(refusal[messageField]).toMatch(/larger than the 64 KiB/)
    },
  )

  it('still answers every preflight 204', async () => {
    const t = newT()
    const signIn = await fetchOf(t, '/api/auth/sign-in/email', {
      method: 'OPTIONS',
      headers: {
        Origin: APP,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,better-auth-cookie',
      },
    })
    expect([
      signIn.status,
      signIn.headers.get('Access-Control-Allow-Origin'),
      signIn.headers.get('Access-Control-Allow-Credentials'),
      signIn.headers.get('Access-Control-Allow-Headers'),
    ]).toEqual([204, APP, 'true', 'Content-Type, Better-Auth-Cookie, Authorization'])
    for (const path of ['/api/auth/oauth2/token', '/.well-known/oauth-authorization-server']) {
      const preflight = await fetchOf(t, path, {
        method: 'OPTIONS',
        headers: { Origin: FOREIGN, 'Access-Control-Request-Method': 'POST' },
      })
      expect([
        path,
        preflight.status,
        preflight.headers.get('Access-Control-Allow-Origin'),
      ]).toEqual([path, 204, '*'])
    }
  })

  it('still answers REST, the protected resource metadata and the image links', async () => {
    const t = newT()
    const resource = await fetchOf(t, '/.well-known/oauth-protected-resource')
    expect(resource.status).toBe(200)
    expect(await resource.json()).toMatchObject({ resource: 'https://some.convex.site/mcp' })
    const me = await fetchOf(t, '/v1/me')
    expect(me.status).toBe(401)
    const image = await fetchOf(t, '/files/x?e=1&m=x&t=bad')
    expect(image.status).toBe(404)
  })

  it.each([
    ['GET /api/auth/get-session', '/api/auth/get-session', { headers: { Origin: APP } }],
    [
      'POST /api/auth/sign-in/email',
      '/api/auth/sign-in/email',
      json(APP, JSON.stringify({ email: 'nobody@example.test', password: 'no password 1' })),
    ],
    [
      'POST /api/auth/oauth2/token',
      '/api/auth/oauth2/token',
      {
        method: 'POST',
        headers: { Origin: FOREIGN, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token&refresh_token=x&client_id=x',
      },
    ],
    ['GET /.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server', {}],
  ])('fails %s with an error, never a 2xx or a cookie', async (_name, path, init) => {
    expectFailedClosed(await settle(fetchOf(newT(), path, init)), /refused to import auth\.ts/)
  })

  it("fails the demo's anonymous sign-in with an error and takes no admission", async () => {
    demo()
    const t = newT()
    const outcome = await settle(fetchOf(t, '/api/auth/sign-in/anonymous', json(DEMO_APP, '{}')))
    expectFailedClosed(outcome, /refused to import auth\.ts/)
    expect(await t.run((ctx) => ctx.db.query('demo_admission').collect())).toEqual([])
  })

  it('still answers an OAuth machine request on the demo 403', async () => {
    demo()
    const response = await fetchOf(newT(), '/api/auth/oauth2/register', json(FOREIGN, '{}'))
    expect([response.status, response.headers.get('Access-Control-Allow-Origin')]).toEqual([
      403,
      '*',
    ])
  })
})

describe('a router whose import of auth.ts succeeds', () => {
  beforeEach(() => {
    auth.refused = false
    auth.received = []
    vi.resetModules()
  })
  afterEach(() => {
    auth.refused = true
    vi.resetModules()
  })

  it('hands Better Auth the host and protocol a proxy forwarded', async () => {
    const response = await fetchOf(newT(), '/api/auth/get-session', {
      headers: {
        Origin: APP,
        'x-better-auth-forwarded-host': 'app.example.test',
        'x-better-auth-forwarded-proto': 'https',
      },
    })
    expect(response.status).toBe(200)
    expect(
      auth.received.map((request) => [
        request.headers.get('x-forwarded-host'),
        request.headers.get('x-forwarded-proto'),
      ]),
    ).toEqual([['app.example.test', 'https']])
  })
})

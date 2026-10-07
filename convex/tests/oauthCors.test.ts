/// <reference types="vite/client" />
import { hashPassword } from 'better-auth/crypto'
import { describe, expect, it } from 'vitest'
import { components } from '../_generated/api'
import authSchema from '../betterAuth/schema'
import { newT, type T } from './helpers.setup'

const APP = 'http://localhost:5199'
const BROWSER = 'https://browser-client.example.test'
process.env.SITE_URL = APP
process.env.CONVEX_SITE_URL = 'https://some.convex.site'
process.env.BETTER_AUTH_SECRET = 'oauth-cors-hermetic-secret-not-a-deployment-314159'
type Json = Record<string, unknown>
type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }
const http = (t: T, path: string, init?: FetchInit): Promise<Response> =>
  (t as unknown as { fetch(path: string, init?: FetchInit): Promise<Response> }).fetch(path, init)
const json = async (response: Response): Promise<Json> => JSON.parse(await response.text())
function fixture() {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
  return t
}
const preflight = (origin: string): FetchInit => ({
  method: 'OPTIONS',
  headers: {
    Origin: origin,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,authorization',
  },
})
function publicResponse(response: Response) {
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull()
  expect(response.headers.get('Set-Cookie')).toBeNull()
  expect(response.headers.get('Set-Better-Auth-Cookie')).toBeNull()
}

describe('OAuth browser client CORS', () => {
  it.each(['register', 'token', 'introspect', 'revoke'])(
    'allows noncredentialed preflight for the exact %s endpoint',
    async (endpoint) => {
      const response = await http(fixture(), `/api/auth/oauth2/${endpoint}`, preflight(BROWSER))
      expect(response.status).toBe(204)
      publicResponse(response)
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS')
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Content-Type, Authorization',
      )
    },
  )

  it.each(['token', 'introspect', 'revoke'])(
    'exposes the %s protocol refusal to a browser instead of hiding it behind CORS',
    async (endpoint) => {
      const body =
        endpoint === 'token'
          ? 'grant_type=authorization_code&client_id=unknown&code=unknown&resource=https%3A%2F%2Fsome.convex.site%2Fmcp'
          : 'client_id=unknown&token=unknown'
      const response = await http(fixture(), `/api/auth/oauth2/${endpoint}`, {
        method: 'POST',
        body,
        headers: { Origin: BROWSER, 'Content-Type': 'application/x-www-form-urlencoded' },
      })
      publicResponse(response)
      expect([400, 401]).toContain(response.status)
      const error = await json(response)
      expect(['invalid_grant', 'invalid_client', 'invalid_request']).toContain(error.error)
    },
  )

  it('registers anonymously even when a valid app session cookie is supplied', async () => {
    const t = fixture()
    const now = Date.now()
    const email = 'oauth-cors@example.test'
    const password = 'Hermetic OAuth CORS password 314159!'
    const user = await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: { name: 'CORS tester', email, emailVerified: true, createdAt: now, updatedAt: now },
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
    const response = await http(t, '/api/auth/oauth2/register', {
      method: 'POST',
      headers: {
        Origin: BROWSER,
        'Content-Type': 'application/json',
        Cookie: cookie!,
        'Better-Auth-Cookie': cookie!,
      },
      body: JSON.stringify({
        client_name: 'Public browser client',
        redirect_uris: [`${BROWSER}/callback`],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'qivo:read',
      }),
    })
    expect(response.status).toBe(200)
    publicResponse(response)
    const client = await json(response)
    expect(client.client_id).toBeTypeOf('string')
    expect(client.client_secret).toBeUndefined()
    const stored = await t.query(components.betterAuth.adapter.findOne, {
      model: 'oauthClient',
      where: [{ field: 'clientId', value: client.client_id as string }],
    })
    expect(stored).not.toBeNull()
    expect((stored as { userId?: string }).userId).toBeUndefined()
    // The public request neither adopts nor revokes the existing app login.
    const session = await http(t, '/api/auth/get-session', {
      headers: { Origin: APP, 'Better-Auth-Cookie': cookie! },
    })
    expect(((await json(session)).user as Json).id).toBe(user._id)
  })

  it.each([
    'sign-in/email',
    'oauth2/consent',
    'admin/list-users',
    'cross-domain/one-time-token/verify',
    'oauth2/token/extra',
  ])('keeps app-only CORS for %s', async (path) => {
    const t = fixture()
    const external = await http(t, `/api/auth/${path}`, preflight(BROWSER))
    expect(external.headers.get('Access-Control-Allow-Origin')).toBeNull()
    const app = await http(t, `/api/auth/${path}`, preflight(APP))
    expect(app.headers.get('Access-Control-Allow-Origin')).toBe(APP)
    expect(app.headers.get('Access-Control-Allow-Credentials')).toBe('true')
  })
})

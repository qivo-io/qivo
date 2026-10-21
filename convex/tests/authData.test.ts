/* Better Auth keeps none of the personal data lib/authData.ts lists. The
 * sign-in cases drive the real auth HTTP handler through Google's and
 * Microsoft's code flows, with only the providers' network boundary mocked,
 * and read the component's raw rows, where an absent field stays absent. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthOptions } from '../auth'
import { PROVIDER_TOKEN_FIELDS } from '../lib/authData'
import { newT, runInAuth, type T } from './helpers.setup'

declare function btoa(value: string): string

const APP = 'http://localhost:5199'
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36'
const MICROSOFT_TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47'

const base64url = (value: object) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/* An ID token as the code flow receives it. better-auth decodes it without
 * checking the signature, because it came straight from the token endpoint. */
const idToken = (claims: Record<string, unknown>) =>
  `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url(claims)}.signature`

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })

/* The providers' side of both code flows. Each token endpoint answers with
 * every credential a provider can return, and Graph answers the photo
 * request, so anything left out of the rows was left out by Qivo. */
function providerNetwork() {
  return vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url === 'https://oauth2.googleapis.com/token')
      return json({
        token_type: 'Bearer',
        access_token: 'google-access-token',
        refresh_token: 'google-refresh-token',
        expires_in: 3599,
        refresh_token_expires_in: 86_400,
        scope: 'openid https://www.googleapis.com/auth/userinfo.email',
        id_token: idToken({
          sub: 'google-ana',
          email: 'ana@example.test',
          email_verified: true,
          name: 'Ana Example',
          picture: 'https://lh3.googleusercontent.com/a/ana-photo',
        }),
      })
    if (url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token')
      return json({
        token_type: 'Bearer',
        access_token: 'microsoft-access-token',
        refresh_token: 'microsoft-refresh-token',
        expires_in: 3599,
        scope: 'openid profile email',
        id_token: idToken({
          sub: 'microsoft-bo',
          tid: MICROSOFT_TENANT,
          iss: `https://login.microsoftonline.com/${MICROSOFT_TENANT}/v2.0`,
          email: 'bo@example.test',
          // verified here only so the sign-up mails nothing
          email_verified: true,
          name: 'Bo Example',
        }),
      })
    if (url.startsWith('https://graph.microsoft.com/'))
      return new Response('jpeg-bytes', { headers: { 'Content-Type': 'image/jpeg' } })
    return new Response('unexpected request', { status: 500 })
  })
}

/* Every raw row of the three tables the hooks guard. */
const authRows = (t: T) =>
  runInAuth(t, async (ctx) => ({
    users: await ctx.db.query('user').collect(),
    sessions: await ctx.db.query('session').collect(),
    accounts: await ctx.db.query('account').collect(),
  }))

/* Signs in through `provider`'s code flow as a browser does, and answers the
 * authorization URL the browser was sent to. */
async function signIn(t: T, provider: 'google' | 'microsoft'): Promise<URL> {
  const start = await t.fetch('/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP, 'User-Agent': BROWSER },
    body: JSON.stringify({ provider, callbackURL: `${APP}/app` }),
  })
  expect(start.status, await start.clone().text()).toBe(200)
  const authorization = new URL((JSON.parse(await start.text()) as { url: string }).url)
  const state = encodeURIComponent(authorization.searchParams.get('state') ?? '')
  const callback = await t.fetch(`/api/auth/callback/${provider}?code=test-code&state=${state}`, {
    headers: { 'User-Agent': BROWSER, 'X-Forwarded-For': '192.0.2.44' },
  })
  expect(callback.status).toBe(302)
  expect(callback.headers.get('location')).not.toMatch(/error/)
  return authorization
}

describe('sign-in stores no provider tokens, picture or request metadata', () => {
  let network: ReturnType<typeof providerNetwork>
  beforeEach(() => {
    vi.stubEnv('SITE_URL', APP)
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-only-auth-data-secret-at-least-32-characters')
    vi.stubEnv('APP_MODE', '')
    vi.stubEnv('GOOGLE_CLIENT_ID', 'test-google-client')
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-google-secret')
    vi.stubEnv('MICROSOFT_CLIENT_ID', 'test-microsoft-client')
    vi.stubEnv('MICROSOFT_CLIENT_SECRET', 'test-microsoft-secret')
    network = providerNetwork()
    vi.stubGlobal('fetch', network)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('a Google sign-up keeps the login and leaves the provider data out', async () => {
    const t = newT()
    await signIn(t, 'google')
    expect(network.mock.calls.map(([url]) => String(url))).toContain(
      'https://oauth2.googleapis.com/token',
    )
    const { users, sessions, accounts } = await authRows(t)
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({
      email: 'ana@example.test',
      name: 'Ana Example',
      emailVerified: true,
    })
    expect(users[0]).not.toHaveProperty('image')
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      providerId: 'google',
      accountId: 'google-ana',
      userId: users[0]._id,
    })
    for (const field of PROVIDER_TOKEN_FIELDS) expect(accounts[0]).not.toHaveProperty(field)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ userId: users[0]._id })
    expect(sessions[0]).not.toHaveProperty('ipAddress')
    expect(sessions[0]).not.toHaveProperty('userAgent')
  })

  it('a returning Google login clears the tokens an older row still held', async () => {
    const t = newT()
    await signIn(t, 'google')
    await runInAuth(t, async (ctx) => {
      const account = await ctx.db.query('account').first()
      if (account === null) throw new Error('the sign-up made no account')
      await ctx.db.patch(account._id, {
        accessToken: 'stored-access-token',
        refreshToken: 'stored-refresh-token',
        idToken: 'stored-id-token',
        accessTokenExpiresAt: Date.now(),
      })
    })
    await signIn(t, 'google')
    const { users, sessions, accounts } = await authRows(t)
    expect(users).toHaveLength(1)
    expect(accounts).toHaveLength(1)
    for (const field of PROVIDER_TOKEN_FIELDS) expect(accounts[0][field]).toBeNull()
    expect(sessions).toHaveLength(2)
    for (const session of sessions) {
      expect(session).not.toHaveProperty('ipAddress')
      expect(session).not.toHaveProperty('userAgent')
    }
  })

  it('Microsoft asks only for the OpenID scopes and keeps no photo', async () => {
    const t = newT()
    const authorization = await signIn(t, 'microsoft')
    expect(authorization.searchParams.get('scope')).toBe('openid profile email')
    expect(createAuthOptions({} as never).socialProviders.microsoft).toMatchObject({
      disableDefaultScope: true,
      disableProfilePhoto: true,
    })
    const { users, accounts } = await authRows(t)
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ email: 'bo@example.test', name: 'Bo Example' })
    expect(users[0]).not.toHaveProperty('image')
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ providerId: 'microsoft', accountId: 'microsoft-bo' })
    for (const field of PROVIDER_TOKEN_FIELDS) expect(accounts[0]).not.toHaveProperty(field)
  })

  it('linking Google to a password login leaves the password account as it was', async () => {
    const t = newT()
    const credential = await runInAuth(t, async (ctx) => {
      const at = Date.now()
      const userId = await ctx.db.insert('user', {
        name: 'Ana Example',
        email: 'ana@example.test',
        emailVerified: true,
        createdAt: at,
        updatedAt: at,
      })
      const id = await ctx.db.insert('account', {
        accountId: userId,
        providerId: 'credential',
        userId,
        password: 'salt:test-only-password-hash',
        createdAt: at,
        updatedAt: at,
      })
      return await ctx.db.get(id)
    })
    await signIn(t, 'google')
    const { users, accounts } = await authRows(t)
    expect(users).toHaveLength(1)
    expect(accounts).toHaveLength(2)
    expect(accounts.find((account) => account.providerId === 'credential')).toEqual(credential)
    const google = accounts.find((account) => account.providerId === 'google')
    expect(google).toMatchObject({ accountId: 'google-ana', userId: users[0]._id })
    for (const field of PROVIDER_TOKEN_FIELDS) expect(google).not.toHaveProperty(field)
  })

  it('passes writes that carry no provider data through unchanged', async () => {
    const hooks = createAuthOptions({} as never).databaseHooks
    const at = new Date()
    expect(
      await hooks.account.create.before({
        id: 'account-1',
        accountId: 'user-1',
        providerId: 'credential',
        userId: 'user-1',
        password: 'salt:hash',
        createdAt: at,
        updatedAt: at,
      }),
    ).toBeUndefined()
    // a password change or reset
    expect(
      await hooks.account.update.before({ password: 'salt:new-hash', updatedAt: at }),
    ).toBeUndefined()
    // a ban, an email confirmation
    expect(await hooks.user.update.before({ banned: true, updatedAt: at })).toBeUndefined()
    expect(await hooks.user.update.before({ emailVerified: true })).toBeUndefined()
    // and the writes that do carry some
    expect(await hooks.account.update.before({ accessToken: 'fresh', scope: 'openid' })).toEqual({
      data: {
        accessToken: null,
        refreshToken: null,
        idToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scope: 'openid',
      },
    })
    expect(await hooks.user.update.before({ image: 'https://example.test/me.png' })).toEqual({
      data: { image: null },
    })
  })

  it('serves none of the routes that answer from stored provider tokens', async () => {
    const t = newT()
    const request = (path: string, method: string) =>
      t.fetch(`/api/auth${path}`, {
        method,
        headers: { Origin: APP, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ providerId: 'google' }) } : {}),
      })
    expect((await request('/get-access-token', 'POST')).status).toBe(404)
    expect((await request('/refresh-token', 'POST')).status).toBe(404)
    expect((await request('/account-info', 'GET')).status).toBe(404)
    // the session route beside them still answers
    expect((await request('/get-session', 'GET')).status).toBe(200)
  })
})

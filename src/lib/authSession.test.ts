import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import type { ConvexClient } from 'convex/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthSession } from './authSession'
import { oauthConnectRequest } from './oauthConnection'

const SITE_URL = 'https://auth-session-test.convex.site'
const APP_PREFIX = 'better-auth'
const ADMIN_PREFIX = 'qivo-admin'
type AuthSession = ReturnType<typeof createAuthSession>
type SocketFetcher = Parameters<ConvexClient['setAuth']>[0]
type AuthChange = Parameters<ConvexClient['setAuth']>[1]

function socket() {
  let fetcher: SocketFetcher
  let onChange: AuthChange
  const clearAuth = vi.fn()
  const setAuth = vi.fn<ConvexClient['setAuth']>((nextFetcher, nextOnChange) => {
    fetcher = nextFetcher
    onChange = nextOnChange
  })
  // Only the network socket is replaced; the auth client, plugins, request
  // headers, cookie parsing, and session cache all use the installed SDK.
  const client = { setAuth, client: { clearAuth } } as unknown as ConvexClient
  return {
    client,
    setAuth,
    clearAuth,
    token: () => fetcher({ forceRefreshToken: true }),
    settle: (authenticated: boolean) => onChange?.(authenticated),
  }
}

function sharedStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => {
      values.set(key, String(value))
    },
  }
}

function authService(baseURL = SITE_URL) {
  const base = new URL(baseURL)
  const sessions = new Map<string, { email: string; id: string }>()
  const revoked: string[] = []
  const requests: { path: string; cookie: string; credentials: RequestCredentials }[] = []
  const oauthQueries: (string | undefined)[] = []
  const socialRequests: Record<string, unknown>[] = []
  let serial = 0
  let failPath: string | undefined
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    expect(url.origin).toBe(base.origin)
    const path = url.pathname.replace(`${base.pathname.replace(/\/$/, '')}/api/auth`, '')
    const cookie = request.headers.get('Better-Auth-Cookie') ?? ''
    requests.push({ path, cookie, credentials: request.credentials })
    // Browser cookies must never supplement either explicitly scoped jar.
    expect(request.credentials).toBe('omit')
    expect(request.headers.has('Cookie')).toBe(false)
    if (path === failPath) throw new TypeError('Simulated offline request')
    const token = cookie.match(/(?:^|; )better-auth\.session_token=([^;]+)/)?.[1]
    const session = sessions.get(token)
    const user = (email: string) => ({
      id: email,
      email,
      name: email.split('@')[0],
      emailVerified: true,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    })
    if (path === '/sign-in/anonymous') {
      expect(request.method).toBe('POST')
      const nextToken = `session-${++serial}`
      const email = `demo-${serial}@qivo.invalid`
      sessions.set(nextToken, { email, id: `id-${serial}` })
      return Response.json(
        { token: nextToken, user: { ...user(email), isAnonymous: true } },
        {
          headers: {
            'set-better-auth-cookie': `better-auth.session_token=${nextToken}; Path=/; Max-Age=86400; HttpOnly; Secure`,
          },
        },
      )
    }
    if (path === '/sign-in/email') {
      expect(request.method).toBe('POST')
      const body = (await request.json()) as {
        email: string
        password: string
        oauth_query?: string
      }
      oauthQueries.push(body.oauth_query)
      if (body.password !== 'test-password') {
        return Response.json(
          { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid login' },
          { status: 401 },
        )
      }
      const nextToken = `session-${++serial}`
      sessions.set(nextToken, { email: body.email, id: `id-${serial}` })
      return Response.json(
        { redirect: false, token: nextToken, user: user(body.email) },
        {
          headers: {
            'set-better-auth-cookie': `better-auth.session_token=${nextToken}; Path=/; Max-Age=3600; HttpOnly; Secure`,
          },
        },
      )
    }
    if (path === '/get-session') {
      expect(request.method).toBe('GET')
      return Response.json(
        session
          ? {
              session: {
                id: session.id,
                token,
                userId: session.email,
                expiresAt: '2030-01-01T00:00:00.000Z',
                createdAt: '2026-09-01T00:00:00.000Z',
                updatedAt: '2026-09-01T00:00:00.000Z',
              },
              user: user(session.email),
            }
          : null,
      )
    }
    if (path === '/sign-in/social') {
      socialRequests.push(await request.json())
      return Response.json({ redirect: false, url: 'https://provider.example.test/authorize' })
    }
    if (path === '/cross-domain/one-time-token/verify') {
      const body = (await request.json()) as { token: string; oauth_query?: string }
      expect(body.token).toBe('private-return-token')
      oauthQueries.push(body.oauth_query)
      const nextToken = `session-${++serial}`
      sessions.set(nextToken, { email: 'nora@example.test', id: `id-${serial}` })
      // The OAuth provider resumes authorization when the OTT sets a session
      // cookie, so a successful return may carry a redirect instead of session.
      return Response.json(
        { redirect: true, url: 'https://app.example.test/app/~/connect?resumed=1' },
        {
          headers: {
            'set-better-auth-cookie': `better-auth.session_token=${nextToken}; Path=/; Max-Age=3600; HttpOnly; Secure`,
          },
        },
      )
    }
    if (path === '/convex/token') {
      expect(request.method).toBe('GET')
      return session
        ? Response.json({ token: `jwt:${token}:${session.email}` })
        : Response.json({ code: 'UNAUTHORIZED', message: 'Session missing' }, { status: 401 })
    }
    if (path === '/sign-out') {
      expect(request.method).toBe('POST')
      if (session) {
        sessions.delete(token)
        revoked.push(token)
      }
      return Response.json({ success: true })
    }
    throw new Error(`Unexpected auth request: ${path}`)
  })
  return {
    fetch,
    sessions,
    revoked,
    requests,
    oauthQueries,
    socialRequests,
    fail: (path: string) => {
      failPath = path
    },
  }
}

async function login(session: AuthSession, email: string) {
  const result = await session.authClient.signIn.email({ email, password: 'test-password' })
  expect(result.error).toBeNull()
  const current = await session.authClient.getSession()
  expect(current.error).toBeNull()
  expect(current.data?.user.email).toBe(email)
  return current.data.session.token
}

describe('independent app and admin browser sessions', () => {
  let storage: Storage
  let service: ReturnType<typeof authService>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_CONVEX_SITE_URL', SITE_URL)
    storage = sharedStorage()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('window', {
      localStorage: storage,
      location: new URL('https://app.example.test'),
    })
    vi.stubGlobal('document', { cookie: 'better-auth.session_token=ambient-browser-session' })
    service = authService()
    vi.stubGlobal('fetch', service.fetch)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  function pair() {
    const appSocket = socket()
    const adminSocket = socket()
    const app = createAuthSession(APP_PREFIX, appSocket.client, oauthProviderClient())
    const admin = createAuthSession(ADMIN_PREFIX, adminSocket.client)
    // Session-isolation cases below exercise already-armed sockets. The boot
    // case separately proves construction and session reads leave them idle.
    void authenticate(app, appSocket)
    void authenticate(admin, adminSocket)
    return { app, admin, appSocket, adminSocket }
  }

  function authenticate(session: AuthSession, target: ReturnType<typeof socket>) {
    const ready = session.armConvexAuth()
    target.settle(true)
    return ready
  }

  function saved(prefix: string) {
    return {
      cookie: storage.getItem(`${prefix}_cookie`),
      cache: storage.getItem(`${prefix}_session_data`),
    }
  }

  it.each([
    { prefix: APP_PREFIX, anonymous: false },
    { prefix: ADMIN_PREFIX, anonymous: false },
    { prefix: 'qivo-demo', anonymous: true },
  ])('waits for the $prefix gate before arming its socket', async ({ prefix, anonymous }) => {
    const target = socket()
    const session = createAuthSession(prefix, target.client, undefined, anonymous)
    expect(target.setAuth).not.toHaveBeenCalled()
    expect(service.requests).toEqual([])
    expect((await session.authClient.getSession()).data).toBeNull()
    expect(target.setAuth).not.toHaveBeenCalled()
    if (anonymous) {
      const result = await session.authClient.signIn.anonymous()
      expect(result.error).toBeNull()
    } else {
      await login(session, 'nora@example.test')
    }
    expect(target.setAuth).not.toHaveBeenCalled()
    expect(service.requests.some(({ path }) => path === '/convex/token')).toBe(false)
    const ready = session.armConvexAuth()
    expect(target.setAuth).toHaveBeenCalledOnce()
    expect(await target.token()).toMatch(/^jwt:session-/)
    target.settle(true)
    expect(await ready).toBe(true)
    expect(service.requests.filter(({ path }) => path === '/convex/token')).toHaveLength(1)
  })

  it('keeps anonymous sign-in and token requests under the forwarded local auth prefix', async () => {
    vi.stubEnv('DEV', true)
    vi.stubEnv('VITE_APP_MODE', 'demo')
    vi.stubEnv('VITE_CONVEX_URL', 'http://127.0.0.1:3210')
    vi.stubEnv('VITE_CONVEX_SITE_URL', 'http://127.0.0.1:3211')
    window.location.href = 'http://localhost:58955/app'
    service = authService('http://localhost:58955/__qivo_http')
    vi.stubGlobal('fetch', service.fetch)
    const demoSocket = socket()
    const demo = createAuthSession('qivo-demo', demoSocket.client, undefined, true)
    const signedIn = await demo.authClient.signIn.anonymous()
    expect(signedIn.error).toBeNull()
    expect(String(service.fetch.mock.calls[0][0])).toBe(
      'http://localhost:58955/__qivo_http/api/auth/sign-in/anonymous',
    )
    await authenticate(demo, demoSocket)
    expect(await demoSocket.token()).toBe(`jwt:${signedIn.data.token}:${signedIn.data.user.email}`)
    expect(service.requests.map(({ path }) => path)).toContain('/convex/token')
  })

  it('creates and clears an anonymous demo without touching app or operator credentials', async () => {
    const { app, admin, appSocket, adminSocket } = pair()
    const appToken = await login(app, 'nora@example.test')
    const adminToken = await login(admin, 'operator@example.test')
    const before = [saved(APP_PREFIX), saved(ADMIN_PREFIX)]
    const demoSocket = socket()
    const demo = createAuthSession('qivo-demo', demoSocket.client, undefined, true)
    const result = await demo.authClient.signIn.anonymous()
    expect(result.error).toBeNull()
    await authenticate(demo, demoSocket)
    expect(demo.authClient.getCookie()).toContain('better-auth.session_token=')
    demo.clearLocalSession()
    expect(demo.authClient.getCookie()).toBe('')
    expect(demo.authClient.getSessionData()).toBeNull()
    expect(demoSocket.clearAuth).toHaveBeenCalledOnce()
    expect(await demoSocket.token()).toBeNull()
    expect([saved(APP_PREFIX), saved(ADMIN_PREFIX)]).toEqual(before)
    expect(await appSocket.token()).toBe(`jwt:${appToken}:nora@example.test`)
    expect(await adminSocket.token()).toBe(`jwt:${adminToken}:operator@example.test`)
  })

  it('resumes the signed OAuth request only in the app session, without forwarding callback credentials', async () => {
    const signed = new URLSearchParams([
      ['client_id', 'test-client'],
      ['scope', 'qivo:read offline_access'],
      ['state', 'keep-this-state'],
      ['ba_iat', '1000'],
      ...['client_id', 'scope', 'state', 'ba_iat', 'ba_param'].map((name) => ['ba_param', name]),
      ['sig', 'test-signature'],
    ])
    window.location.href = `https://app.example.test/app/~/connect?${signed}&ott=private-ott`
    const { app, admin, appSocket, adminSocket } = pair()
    const appToken = await login(app, 'nora@example.test')
    const adminToken = await login(admin, 'operator@example.test')
    expect(service.oauthQueries).toEqual([signed.toString(), undefined])
    expect(await appSocket.token()).toBe(`jwt:${appToken}:nora@example.test`)
    expect(await adminSocket.token()).toBe(`jwt:${adminToken}:operator@example.test`)
  })

  it.each(['google', 'microsoft'] as const)(
    'preserves the signed connection in %s callbacks without including the OTT',
    async (provider) => {
      const { app, admin, adminSocket } = pair()
      const adminToken = await login(admin, 'operator@example.test')
      const before = saved(ADMIN_PREFIX)
      const signed = new URLSearchParams([
        ['client_id', 'desktop-app'],
        ['scope', 'qivo:read'],
        ['state', 'opaque-state'],
        ['ba_iat', '1000'],
        ...['client_id', 'scope', 'state', 'ba_iat', 'ba_param'].map((name) => ['ba_param', name]),
        ['sig', 'test-signature'],
      ])
      window.location.href = `https://app.example.test/app/~/connect?${signed}&ott=private-ott&error=callback-error`
      const request = oauthConnectRequest(new URL(window.location.href))
      const response = await app.authClient.signIn.social({
        provider,
        callbackURL: request.returnURL,
        errorCallbackURL: request.returnURL,
      })
      expect(response.error).toBeNull()
      expect(service.socialRequests).toEqual([
        expect.objectContaining({
          provider,
          callbackURL: request.returnURL,
          errorCallbackURL: request.returnURL,
          oauth_query: signed.toString(),
        }),
      ])
      expect(request.returnURL).not.toContain('private-ott')
      expect(request.returnURL).not.toContain('callback-error')
      expect(saved(ADMIN_PREFIX)).toEqual(before)
      expect(await adminSocket.token()).toBe(`jwt:${adminToken}:operator@example.test`)
    },
  )

  it('keeps the new app cookie when an OTT return resumes authorization with a redirect', async () => {
    const { app, admin, appSocket, adminSocket } = pair()
    const adminToken = await login(admin, 'operator@example.test')
    const before = saved(ADMIN_PREFIX)
    const signed = new URLSearchParams([
      ['client_id', 'desktop-app'],
      ['scope', 'qivo:read'],
      ['ba_param', 'client_id'],
      ['ba_param', 'scope'],
      ['ba_param', 'ba_param'],
      ['sig', 'test-signature'],
    ])
    window.location.href = `https://app.example.test/app/~/connect?${signed}`
    const result = await app.authClient.crossDomain.oneTimeToken.verify({
      token: 'private-return-token',
    })
    expect(result.error).toBeNull()
    expect(result.data).toEqual({
      redirect: true,
      url: 'https://app.example.test/app/~/connect?resumed=1',
    })
    expect(window.location.href).toBe('https://app.example.test/app/~/connect?resumed=1')
    expect(service.oauthQueries.at(-1)).toBe(signed.toString())
    const current = await app.authClient.getSession()
    expect(current.data?.user.email).toBe('nora@example.test')
    expect(await appSocket.token()).toBe(`jwt:${current.data.session.token}:nora@example.test`)
    expect(saved(ADMIN_PREFIX)).toEqual(before)
    expect(await adminSocket.token()).toBe(`jwt:${adminToken}:operator@example.test`)
  })

  it('starts admin anonymously without adopting the existing app jar or cached identity', async () => {
    const appSocket = socket()
    const app = createAuthSession(APP_PREFIX, appSocket.client, oauthProviderClient())
    const appToken = await login(app, 'nora@example.test')
    await authenticate(app, appSocket)
    const before = saved(APP_PREFIX)

    const adminSocket = socket()
    const admin = createAuthSession(ADMIN_PREFIX, adminSocket.client)
    expect(admin.authClient.getCookie()).toBe('')
    expect(admin.authClient.getSessionData()).toBeNull()
    expect(saved(ADMIN_PREFIX)).toEqual({ cookie: null, cache: null })
    expect((await admin.authClient.getSession()).data).toBeNull()
    await authenticate(admin, adminSocket)
    expect(await adminSocket.token()).toBeNull()
    expect(service.requests.slice(-2).map((request) => request.cookie)).toEqual(['', ''])
    expect(saved(APP_PREFIX)).toEqual(before)
    expect(await appSocket.token()).toBe(`jwt:${appToken}:nora@example.test`)
  })

  it.each([
    { description: 'the same account', adminEmail: 'nora@example.test' },
    { description: 'different accounts', adminEmail: 'operator@example.test' },
  ])(
    'keeps both credential and session-cache jars separate for $description',
    async ({ adminEmail }) => {
      const { app, admin, appSocket, adminSocket } = pair()
      const appToken = await login(app, 'nora@example.test')
      const appBefore = saved(APP_PREFIX)
      const adminToken = await login(admin, adminEmail)
      expect(adminToken).not.toBe(appToken)
      expect(saved(APP_PREFIX)).toEqual(appBefore)
      expect(app.authClient.getCookie()).toBe(`better-auth.session_token=${appToken}`)
      expect(admin.authClient.getCookie()).toBe(`better-auth.session_token=${adminToken}`)
      expect(app.authClient.getSessionData()).toMatchObject({
        session: { token: appToken },
        user: { email: 'nora@example.test' },
      })
      expect(admin.authClient.getSessionData()).toMatchObject({
        session: { token: adminToken },
        user: { email: adminEmail },
      })
      expect(await appSocket.token()).toBe(`jwt:${appToken}:nora@example.test`)
      expect(await adminSocket.token()).toBe(`jwt:${adminToken}:${adminEmail}`)

      // Changing the app account cannot replace the already-open operator's
      // credentials, including when both pages initially used the same user.
      const adminBefore = saved(ADMIN_PREFIX)
      const replacementAppToken = await login(app, 'another-member@example.test')
      expect(saved(ADMIN_PREFIX)).toEqual(adminBefore)
      expect(await appSocket.token()).toBe(`jwt:${replacementAppToken}:another-member@example.test`)
      expect(await adminSocket.token()).toBe(`jwt:${adminToken}:${adminEmail}`)
      const replacementAppBefore = saved(APP_PREFIX)
      await login(admin, 'another-operator@example.test')
      expect(saved(APP_PREFIX)).toEqual(replacementAppBefore)
    },
  )

  it.each([
    { door: 'app' as const, adminEmail: 'nora@example.test' },
    { door: 'admin' as const, adminEmail: 'nora@example.test' },
    { door: 'app' as const, adminEmail: 'operator@example.test' },
    { door: 'admin' as const, adminEmail: 'operator@example.test' },
  ])(
    'signing out $door revokes only its session (admin account: $adminEmail)',
    async ({ door, adminEmail }) => {
      const { app, admin, appSocket, adminSocket } = pair()
      const appToken = await login(app, 'nora@example.test')
      const adminToken = await login(admin, adminEmail)
      const own = door === 'app' ? app : admin
      const other = door === 'app' ? admin : app
      const ownSocket = door === 'app' ? appSocket : adminSocket
      const otherSocket = door === 'app' ? adminSocket : appSocket
      const ownPrefix = door === 'app' ? APP_PREFIX : ADMIN_PREFIX
      const otherPrefix = door === 'app' ? ADMIN_PREFIX : APP_PREFIX
      const ownToken = door === 'app' ? appToken : adminToken
      const otherToken = door === 'app' ? adminToken : appToken
      const otherEmail = door === 'app' ? adminEmail : 'nora@example.test'
      const otherBefore = saved(otherPrefix)

      await own.signOut()
      expect(service.requests.filter((request) => request.path === '/sign-out')).toEqual([
        { path: '/sign-out', cookie: `better-auth.session_token=${ownToken}`, credentials: 'omit' },
      ])
      expect(service.revoked).toEqual([ownToken])
      expect(service.sessions.has(ownToken)).toBe(false)
      expect(service.sessions.has(otherToken)).toBe(true)
      expect(ownSocket.clearAuth).toHaveBeenCalledOnce()
      expect(otherSocket.clearAuth).not.toHaveBeenCalled()
      expect(own.authClient.getCookie()).toBe('')
      expect(own.authClient.getSessionData()).toBeNull()
      expect(saved(ownPrefix)).toEqual({ cookie: '{}', cache: '{}' })
      expect(saved(otherPrefix)).toEqual(otherBefore)
      expect(other.authClient.getSessionData()).toMatchObject({
        session: { token: otherToken },
        user: { email: otherEmail },
      })
      expect((await other.authClient.getSession()).data?.session.token).toBe(otherToken)
      expect(await otherSocket.token()).toBe(`jwt:${otherToken}:${otherEmail}`)
      expect(await ownSocket.token()).toBeNull()
      expect((await own.authClient.getSession()).data).toBeNull()
      expect(saved(otherPrefix)).toEqual(otherBefore)
    },
  )

  it('re-arms and settles only the requested socket using its own current session', async () => {
    const { app, admin, appSocket, adminSocket } = pair()
    const appToken = await login(app, 'nora@example.test')
    const adminToken = await login(admin, 'operator@example.test')
    expect(appSocket.setAuth).toHaveBeenCalledTimes(1)
    expect(adminSocket.setAuth).toHaveBeenCalledTimes(1)

    const appReady = app.armConvexAuth()
    expect(appSocket.setAuth).toHaveBeenCalledTimes(2)
    expect(adminSocket.setAuth).toHaveBeenCalledTimes(1)
    const adminReady = admin.armConvexAuth()
    appSocket.settle(true)
    adminSocket.settle(false)
    expect(await appReady).toBe(true)
    expect(await adminReady).toBe(false)
    expect(await appSocket.token()).toBe(`jwt:${appToken}:nora@example.test`)
    expect(await adminSocket.token()).toBe(`jwt:${adminToken}:operator@example.test`)
    // Later notifications do not rewrite the first auth settlement.
    appSocket.settle(false)
    adminSocket.settle(true)
    expect(await appReady).toBe(true)
    expect(await adminReady).toBe(false)
  })

  it('a failed admin login does not overwrite either existing session or cache', async () => {
    const { app, admin, appSocket, adminSocket } = pair()
    const appToken = await login(app, 'nora@example.test')
    const adminToken = await login(admin, 'operator@example.test')
    const before = [saved(APP_PREFIX), saved(ADMIN_PREFIX)]
    const result = await admin.authClient.signIn.email({
      email: 'wrong@example.test',
      password: 'wrong',
    })
    expect(result.error?.status).toBe(401)
    expect([saved(APP_PREFIX), saved(ADMIN_PREFIX)]).toEqual(before)
    expect(await appSocket.token()).toBe(`jwt:${appToken}:nora@example.test`)
    expect(await adminSocket.token()).toBe(`jwt:${adminToken}:operator@example.test`)
  })

  it('an expired admin session cannot fall back to the valid app session', async () => {
    const { app, admin, appSocket, adminSocket } = pair()
    const appToken = await login(app, 'nora@example.test')
    const adminToken = await login(admin, 'operator@example.test')
    const appBefore = saved(APP_PREFIX)
    service.sessions.delete(adminToken)
    expect(await adminSocket.token()).toBeNull()
    expect((await admin.authClient.getSession()).data).toBeNull()
    expect(admin.authClient.getCookie()).toBe('')
    expect(admin.authClient.getSessionData()).toBeNull()
    expect(saved(APP_PREFIX)).toEqual(appBefore)
    expect(await appSocket.token()).toBe(`jwt:${appToken}:nora@example.test`)
  })

  it('a token network failure returns null without changing either saved login', async () => {
    const { app, admin, adminSocket } = pair()
    await login(app, 'nora@example.test')
    await login(admin, 'operator@example.test')
    const before = [saved(APP_PREFIX), saved(ADMIN_PREFIX)]
    service.fail('/convex/token')
    expect(await adminSocket.token()).toBeNull()
    expect([saved(APP_PREFIX), saved(ADMIN_PREFIX)]).toEqual(before)
  })

  it('a failed sign-out request still clears only its own local jar and socket', async () => {
    const { app, admin, appSocket, adminSocket } = pair()
    const appToken = await login(app, 'nora@example.test')
    const adminToken = await login(admin, 'operator@example.test')
    const appBefore = saved(APP_PREFIX)
    service.fail('/sign-out')
    await expect(admin.signOut()).rejects.toThrow('Simulated offline request')
    expect(adminSocket.clearAuth).toHaveBeenCalledOnce()
    expect(appSocket.clearAuth).not.toHaveBeenCalled()
    expect(saved(ADMIN_PREFIX)).toEqual({ cookie: '{}', cache: '{}' })
    expect(saved(APP_PREFIX)).toEqual(appBefore)
    expect(await appSocket.token()).toBe(`jwt:${appToken}:nora@example.test`)
    // A failed HTTP request cannot establish that server revocation happened.
    expect(service.revoked).toEqual([])
    expect(service.sessions.has(adminToken)).toBe(true)
  })
})

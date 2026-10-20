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
  // whether Convex holds a token; the first confirmed answer gives it one
  let held = false
  const clearAuth = vi.fn(() => {
    held = false
  })
  const setAuth = vi.fn<ConvexClient['setAuth']>((nextFetcher, nextOnChange) => {
    fetcher = nextFetcher
    onChange = nextOnChange
  })
  // Only the network socket is replaced; the auth client, plugins, request
  // headers, cookie parsing, and session cache all use the installed SDK.
  const client = {
    setAuth,
    client: { clearAuth, hasAuth: () => held },
  } as unknown as ConvexClient
  return {
    client,
    setAuth,
    clearAuth,
    /** A refresh, or with `false` the first fetch of an arm. */
    token: (forceRefreshToken = true) => fetcher({ forceRefreshToken }),
    settle: (authenticated: boolean) => {
      held = authenticated
      onChange?.(authenticated)
    },
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
  let failStatus: number | undefined
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
    if (path === failPath) {
      if (failStatus) return Response.json({ message: 'Unavailable' }, { status: failStatus })
      throw new TypeError('Simulated offline request')
    }
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
    /** Fails every request to `path`: offline, or with `status`. */
    fail: (path: string, status?: number) => {
      failPath = path
      failStatus = status
    },
    recover: () => {
      failPath = undefined
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
    // the longest jitter, so every backoff step takes its full 1.25 times
    vi.spyOn(Math, 'random').mockReturnValue(1)
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
    vi.restoreAllMocks()
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
    // the app's later drop arms only the app socket again, its session lasting
    await vi.advanceTimersByTimeAsync(0)
    expect(appSocket.setAuth).toHaveBeenCalledTimes(3)
    expect(adminSocket.setAuth).toHaveBeenCalledTimes(2)
  })

  it('reports a sign-in Convex drops after the first answer once the session is gone', async () => {
    const { admin, adminSocket } = pair()
    const token = await login(admin, 'operator@example.test')
    const lost = vi.fn()
    const ready = admin.armConvexAuth(lost)
    adminSocket.settle(false)
    expect(await ready).toBe(false)
    // the first answer is the promise's, never a loss
    expect(lost).not.toHaveBeenCalled()
    adminSocket.settle(true)
    service.sessions.delete(token)
    adminSocket.settle(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(lost).toHaveBeenCalledOnce()
    expect(adminSocket.setAuth).toHaveBeenCalledTimes(2)
  })

  it('arms a dropped sign-in again while the session lasts, waiting out an outage', async () => {
    const { admin, adminSocket } = pair()
    await login(admin, 'operator@example.test')
    const lost = vi.fn()
    const ready = admin.armConvexAuth(lost)
    adminSocket.settle(true)
    expect(await ready).toBe(true)
    service.fail('/get-session')
    adminSocket.settle(false)
    await vi.advanceTimersByTimeAsync(60_000)
    // a session check that cannot reach the service is no answer
    expect(lost).not.toHaveBeenCalled()
    expect(adminSocket.setAuth).toHaveBeenCalledTimes(2)
    service.recover()
    // the longest backoff step with its jitter is 37.5 s
    await vi.advanceTimersByTimeAsync(40_000)
    expect(adminSocket.setAuth).toHaveBeenCalledTimes(3)
    adminSocket.settle(true)
    expect(lost).not.toHaveBeenCalled()
  })

  it('waits out a token service outage before arming a dropped sign-in again', async () => {
    const { admin, adminSocket } = pair()
    await login(admin, 'operator@example.test')
    const lost = vi.fn()
    const ready = admin.armConvexAuth(lost)
    adminSocket.settle(true)
    expect(await ready).toBe(true)
    service.fail('/convex/token', 503)
    adminSocket.settle(false)
    await vi.advanceTimersByTimeAsync(180_000)
    // the session lasts, and a service that cannot mint a token is no arm
    expect(lost).not.toHaveBeenCalled()
    expect(adminSocket.setAuth).toHaveBeenCalledTimes(2)
    service.recover()
    // the longest backoff step with its jitter is 37.5 s
    await vi.advanceTimersByTimeAsync(40_000)
    expect(adminSocket.setAuth).toHaveBeenCalledTimes(3)
    // the arm's first fetch gets the token recovery waited for, unasked
    const asked = service.requests.length
    expect(await adminSocket.token(false)).toMatch(/^jwt:session-/)
    expect(service.requests).toHaveLength(asked)
    adminSocket.settle(true)
    expect(lost).not.toHaveBeenCalled()
  })

  it('stops arming again when the server keeps refusing a live session', async () => {
    const { admin, adminSocket } = pair()
    await login(admin, 'operator@example.test')
    const lost = vi.fn()
    const ready = admin.armConvexAuth(lost)
    adminSocket.settle(true)
    expect(await ready).toBe(true)
    adminSocket.settle(false)
    for (let arm = 0; arm < 3; arm++) {
      await vi.advanceTimersByTimeAsync(30_000)
      adminSocket.settle(false)
    }
    await vi.advanceTimersByTimeAsync(30_000)
    expect(adminSocket.setAuth).toHaveBeenCalledTimes(5)
    expect(lost).toHaveBeenCalledOnce()
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

  it('a token network failure with no sign-in to keep returns null without changing either saved login', async () => {
    const app = createAuthSession(APP_PREFIX, socket().client, oauthProviderClient())
    const adminSocket = socket()
    const admin = createAuthSession(ADMIN_PREFIX, adminSocket.client)
    await login(app, 'nora@example.test')
    await login(admin, 'operator@example.test')
    void admin.armConvexAuth()
    const before = [saved(APP_PREFIX), saved(ADMIN_PREFIX)]
    service.fail('/convex/token')
    // a boot holds no token yet, and an arm's first fetch answers at once
    expect(await adminSocket.token()).toBeNull()
    adminSocket.settle(true)
    expect(await adminSocket.token(false)).toBeNull()
    expect([saved(APP_PREFIX), saved(ADMIN_PREFIX)]).toEqual(before)
  })

  it.each([
    { failure: 'is offline', status: undefined },
    { failure: 'answers 503', status: 503 },
  ])(
    'keeps a refresh waiting while the token service $failure, and resolves once it answers',
    async ({ status }) => {
      const { admin, adminSocket } = pair()
      const token = await login(admin, 'operator@example.test')
      service.fail('/convex/token', status)
      let answer: string | null | undefined = 'pending'
      void adminSocket.token().then((value) => {
        answer = value
      })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(answer).toBe('pending')
      service.recover()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(answer).toBe(`jwt:${token}:operator@example.test`)
    },
  )

  it('asks again as soon as the browser is back online, in one loop for every caller', async () => {
    const events = new EventTarget()
    Object.assign(window, {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    })
    const { admin, adminSocket } = pair()
    const token = await login(admin, 'operator@example.test')
    service.fail('/convex/token')
    const refresh = adminSocket.token()
    const again = adminSocket.token()
    await vi.advanceTimersByTimeAsync(20_000)
    const asked = () => service.requests.filter(({ path }) => path === '/convex/token').length
    const before = asked()
    service.recover()
    events.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(asked()).toBe(before + 1)
    expect(await refresh).toBe(`jwt:${token}:operator@example.test`)
    expect(await again).toBe(`jwt:${token}:operator@example.test`)
  })

  it('asks again at once when Convex asks again while the loop waits', async () => {
    const { admin, adminSocket } = pair()
    const token = await login(admin, 'operator@example.test')
    service.fail('/convex/token')
    const refresh = adminSocket.token()
    await vi.advanceTimersByTimeAsync(20_000)
    const asked = () => service.requests.filter(({ path }) => path === '/convex/token').length
    const before = asked()
    service.recover()
    // what Convex does after the server refuses the expired token
    const again = adminSocket.token()
    await vi.advanceTimersByTimeAsync(0)
    expect(asked()).toBe(before + 1)
    expect(await again).toBe(`jwt:${token}:operator@example.test`)
    expect(await refresh).toBe(`jwt:${token}:operator@example.test`)
  })

  /* Arms the way Convex's setConfig does: the first fetch may use a cached
     token, and a null answer is followed by a forced one. Settles with
     whether either got a token. */
  async function armLikeConvex(session: AuthSession, target: ReturnType<typeof socket>) {
    const ready = session.armConvexAuth()
    await vi.advanceTimersByTimeAsync(0)
    const token = (await target.token(false)) ?? (await target.token(true))
    target.settle(!!token)
    return { token, armed: await ready }
  }

  it('fails a new arm at once when the token service cannot answer, though Convex holds a token', async () => {
    const { admin, adminSocket } = pair()
    await login(admin, 'operator@example.test')
    service.fail('/convex/token', 503)
    // nothing advances the clock, so a wait in the retry loop never ends
    expect(await armLikeConvex(admin, adminSocket)).toEqual({ token: null, armed: false })
  })

  it('ends a refresh waiting in the retry loop before a new arm, so Convex can restart its socket', async () => {
    const { admin, adminSocket } = pair()
    const token = await login(admin, 'operator@example.test')
    service.fail('/convex/token')
    const refresh = adminSocket.token()
    await vi.advanceTimersByTimeAsync(5_000)
    service.recover()
    const ready = admin.armConvexAuth()
    // the arm waits until Convex has the refresh's answer
    expect(adminSocket.setAuth).toHaveBeenCalledTimes(1)
    expect(await refresh).toBeNull()
    await vi.advanceTimersByTimeAsync(0)
    expect(adminSocket.setAuth).toHaveBeenCalledTimes(2)
    expect(await adminSocket.token(false)).toBe(`jwt:${token}:operator@example.test`)
    adminSocket.settle(true)
    expect(await ready).toBe(true)
  })

  it.each([
    { answer: 'a 404 from a proxy', status: 404 },
    { answer: 'a rate limit', status: 429 },
    { answer: 'a captive portal page', status: 200 },
  ])(
    'keeps a refresh waiting after $answer, which says nothing about the session',
    async ({ status }) => {
      const { admin, adminSocket } = pair()
      const token = await login(admin, 'operator@example.test')
      service.fail('/convex/token', status)
      let answer: string | null | undefined = 'pending'
      void adminSocket.token().then((value) => {
        answer = value
      })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(answer).toBe('pending')
      service.recover()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(answer).toBe(`jwt:${token}:operator@example.test`)
    },
  )

  it('answers a refresh null when the server says the session is gone, and when signed out', async () => {
    const { admin, adminSocket } = pair()
    const token = await login(admin, 'operator@example.test')
    service.fail('/convex/token')
    const refresh = adminSocket.token()
    await admin.signOut()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await refresh).toBeNull()
    service.recover()
    adminSocket.settle(true)
    expect(service.sessions.has(token)).toBe(false)
    // the 401 from /convex/token is the one answer that means signed out
    expect(await adminSocket.token()).toBeNull()
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

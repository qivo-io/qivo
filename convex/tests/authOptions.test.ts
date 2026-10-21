import { runWithEndpointContext } from '@better-auth/core/context'
import type { GenericCtx } from '@convex-dev/better-auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataModel } from '../_generated/dataModel'
import { appOrigins, createAuthOptions, tokenPayload } from '../auth'

/* The options object is built without touching ctx — every dereference lives
 * inside a callback — so reading a flag needs no context at all. */
const noCtx = {} as GenericCtx<DataModel>

/* The provider's answer to every send, so a callback's letter can be read. */
function provider() {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message_id: 'm' }) })
  vi.stubGlobal('fetch', fetch)
  const sent = () => fetch.mock.calls.map(([, init]) => JSON.parse(init.body))
  return { fetch, sent }
}

beforeEach(() => {
  vi.stubEnv('LETTERMINT_API_KEY', 'test-only-mail-token')
  vi.stubEnv('MAIL_FROM', 'sender@example.test')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('email verification is mailed on every path that needs it', () => {
  it('mails on a password registration and re-mails on an unverified sign-in', () => {
    const options = createAuthOptions(noCtx)

    // the password register branch reads sendOnSignUp; a provider
    // registration's first link comes from the app's confirm screen
    expect(options.emailVerification?.sendOnSignUp).toBe(true)
    // better-auth sends once, on the registration — a lost link is only
    // recoverable because an unverified sign-in mints a fresh one
    expect(options.emailVerification?.sendOnSignIn).toBe(true)
    expect(options.emailAndPassword?.requireEmailVerification).toBe(true)
  })

  it('the verification callback sends the verify letter with the link it was handed', async () => {
    const { sent } = provider()
    const options = createAuthOptions(noCtx)
    const url = 'https://example.convex.site/api/auth/verify-email?token=t&callbackURL=%2Fapp'

    await options.emailVerification!.sendVerificationEmail!({
      user: { email: 'ana@example.com' },
      url,
      token: 't',
    } as never)

    expect(sent()).toHaveLength(1)
    expect(sent()[0]).toMatchObject({
      to: ['ana@example.com'],
      subject: 'Confirm your email address on Qivo',
    })
    expect(sent()[0].text).toContain(url)
  })

  it('leaves a provider registration and a resend without a session to the app, mailing nothing', async () => {
    const { fetch } = provider()
    const options = createAuthOptions(noCtx)
    const callback = () =>
      options.emailVerification!.sendVerificationEmail!({
        user: { email: 'ana@example.com' },
        url: 'https://example.convex.site/api/auth/verify-email?token=t',
        token: 't',
      } as never)
    const inEndpoint = (path: string, session: unknown) =>
      runWithEndpointContext({ path, context: { session } } as never, callback)

    await inEndpoint('/callback/:id', null)
    await inEndpoint('/sign-in/social', null)
    await inEndpoint('/send-verification-email', null)
    expect(fetch).not.toHaveBeenCalled()
    // the same callback mails for a signed-in resend and an unconfirmed sign-in
    await inEndpoint('/send-verification-email', { user: { id: 'u' } })
    await inEndpoint('/sign-in/email', null)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('the reset callback is a different letter — the two are not crossed', async () => {
    const { sent } = provider()
    const options = createAuthOptions(noCtx)

    await options.emailAndPassword!.sendResetPassword!({
      user: { email: 'ana@example.com' },
      url: 'https://example.convex.site/reset',
      token: 't',
    } as never)

    expect(sent()[0]).toMatchObject({
      to: ['ana@example.com'],
      subject: 'Reset your Qivo password',
    })
    expect(sent()[0].text).toContain('https://example.convex.site/reset')
  })

  it('the recovery capture keeps the link and mails nothing, without the mail hooks', async () => {
    const { fetch } = provider()
    const captured: { url: string | null } = { url: null }
    const options = createAuthOptions(noCtx, { recovery: captured })

    await options.emailAndPassword!.sendResetPassword!({
      user: { email: 'ana@example.com' },
      url: 'https://example.convex.site/reset',
      token: 't',
    } as never)

    expect(captured.url).toBe('https://example.convex.site/reset')
    expect(fetch).not.toHaveBeenCalled()
    expect(options.plugins.map((p) => p.id)).not.toContain('qivo-auth-mail')
    expect(createAuthOptions(noCtx).plugins.map((p) => p.id)).toContain('qivo-auth-mail')
  })
})

/* env.setup.ts plants SITE_URL for every suite; these cases take it away
 * again, so each one restores what it found. */
declare const process: { env: Record<string, string | undefined> }

describe('SITE_URL is required, not assumed', () => {
  const withSiteUrl = <T>(value: string | undefined, run: () => T): T => {
    const had = process.env.SITE_URL
    if (value === undefined) delete process.env.SITE_URL
    else process.env.SITE_URL = value
    try {
      return run()
    } finally {
      process.env.SITE_URL = had
    }
  }

  it('the app origin reaches trustedOrigins and the crossDomain redirect', () => {
    const options = withSiteUrl('https://qivo.test', () => createAuthOptions(noCtx))

    // originCheck rejects the OAuth/reset round trip unless the app origin is
    // named here — crossDomain does not feed it
    expect(options.trustedOrigins).toEqual(['https://qivo.test'])
    /* crossDomain gets the same local, but closes over it inside its hooks
     * rather than exposing it — so the plugin is pinned by presence here and
     * by the refusals below, which fire before the plugin list is built. */
    expect(options.plugins.map((p) => p.id)).toContain('cross-domain')
  })

  it('adds exact optional development origins without replacing SITE_URL', () => {
    const previous = process.env.ADDITIONAL_APP_ORIGINS
    process.env.ADDITIONAL_APP_ORIGINS =
      'http://100.74.229.78:5199, http://devbox.example.test:5199/'
    try {
      const origins = withSiteUrl('http://localhost:5199', () => appOrigins())
      expect(origins).toEqual([
        'http://localhost:5199',
        'http://100.74.229.78:5199',
        'http://devbox.example.test:5199',
      ])
      expect(
        withSiteUrl('http://localhost:5199', () => createAuthOptions(noCtx)).trustedOrigins,
      ).toEqual(origins)
    } finally {
      if (previous === undefined) delete process.env.ADDITIONAL_APP_ORIGINS
      else process.env.ADDITIONAL_APP_ORIGINS = previous
    }
  })

  it('refuses an additional entry that is not an exact origin', () => {
    const previous = process.env.ADDITIONAL_APP_ORIGINS
    process.env.ADDITIONAL_APP_ORIGINS = 'http://devbox.example.test/app'
    try {
      expect(() => withSiteUrl('http://localhost:5199', () => appOrigins())).toThrow(
        /ADDITIONAL_APP_ORIGINS entries must be exact http\(s\) origins/,
      )
    } finally {
      if (previous === undefined) delete process.env.ADDITIONAL_APP_ORIGINS
      else process.env.ADDITIONAL_APP_ORIGINS = previous
    }
  })

  it('requires an explicit environment and HTTPS for all hosted app origins', () => {
    vi.stubEnv('QIVO_ENVIRONMENT', '')
    expect(() => createAuthOptions(noCtx)).toThrow(/QIVO_ENVIRONMENT/)
    expect(() => createAuthOptions(noCtx, { schemaOnly: true })).not.toThrow()
    vi.stubEnv('QIVO_ENVIRONMENT', 'staging')
    vi.stubEnv('SITE_URL', 'https://preview.example.test')
    vi.stubEnv('ADDITIONAL_APP_ORIGINS', 'http://other.example.test')
    expect(() => createAuthOptions(noCtx)).toThrow(/HTTPS for every app origin/)
    vi.stubEnv('ADDITIONAL_APP_ORIGINS', 'https://other.example.test')
    expect(createAuthOptions(noCtx).emailAndPassword.requireEmailVerification).toBe(true)
  })

  it('an unset SITE_URL is refused by name instead of passed on as undefined', () => {
    expect(() => withSiteUrl(undefined, () => createAuthOptions(noCtx))).toThrow(
      /SITE_URL is not set/,
    )
  })

  it('an empty SITE_URL is refused too — "" is an origin nothing can match', () => {
    expect(() => withSiteUrl('', () => createAuthOptions(noCtx))).toThrow(/SITE_URL is not set/)
  })

  /* The component sandbox (convex/betterAuth/) analyzes its modules with NO
   * deployment env vars — a throwing options build there refuses the entire
   * `convex dev` push (regression of 2026-08-23). The two schema-only
   * consumers must therefore build without SITE_URL, on an inert placeholder
   * that can never resolve, while the strict default above keeps refusing. */
  it('schemaOnly builds without SITE_URL — the component sandbox has no env vars', () => {
    const options = withSiteUrl(undefined, () => createAuthOptions(noCtx, { schemaOnly: true }))
    expect(options.trustedOrigins).toEqual(['http://schema-only.invalid'])
    // the plugin list (which feeds getAuthTables' schema) is still complete
    expect(options.plugins.map((p) => p.id)).toContain('cross-domain')
  })
})

describe('every minted token is new', () => {
  const user = { id: 'user-1', name: 'Ana', email: 'ana@example.com', image: 'https://img.test/a' }
  const session = { expiresAt: new Date(Date.now() + 3_600_000) }

  it('gives each token its own jti and keeps the default user claims', async () => {
    const payload = tokenPayload(noCtx, false)
    const first = await payload({ user, session })
    const second = await payload({ user, session })
    expect(first).toEqual({ name: 'Ana', email: 'ana@example.com', jti: expect.any(String) })
    expect(second.jti).not.toBe(first.jti)
  })

  it('gives a demo token its own jti and only its expiry', async () => {
    const deadline = Date.now() + 60_000
    const ctx = { runQuery: vi.fn(async () => deadline) } as unknown as GenericCtx<DataModel>
    const payload = tokenPayload(ctx, true)
    const first = await payload({ user, session })
    const second = await payload({ user, session })
    expect(first).toEqual({ exp: Math.floor(deadline / 1_000), jti: expect.any(String) })
    expect(second.jti).not.toBe(first.jti)
  })
})

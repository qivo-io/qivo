/* Run the real auth HTTP handler through its mail and link consumption. Only
 * Lettermint's network boundary is mocked. No hosted data is touched. */
/// <reference types="vite/client" />
import { afterEach, describe, expect, it, vi } from 'vitest'
import { components } from '../_generated/api'
import authSchema from '../betterAuth/schema'
import { newT } from './helpers.setup'

const APP = 'http://localhost:5199'
const SITE = 'https://some.convex.site'
const PASSWORD = 'Test-only original password 314159!'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const accepted = () => ({ ok: true, json: async () => ({ message_id: 'test-only-message' }) })
// a final refusal, such as a suppressed recipient: nothing was sent
const refused = () => ({
  ok: false,
  status: 422,
  headers: { get: () => null },
  json: async () => ({}),
})
// a server error: the letter may or may not have gone out
const failing = () => ({
  ok: false,
  status: 500,
  headers: { get: () => null },
  json: async () => ({}),
})

/** An auth backend over convex-test. `mail` false leaves Lettermint
 * unconfigured. The provider mock answers every send. */
function backend(mail = true) {
  vi.stubEnv('SITE_URL', APP)
  vi.stubEnv('CONVEX_SITE_URL', SITE)
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-only-auth-mail-secret-at-least-32-characters')
  vi.stubEnv('LETTERMINT_API_KEY', mail ? 'test-only-project-token' : '')
  vi.stubEnv('MAIL_FROM', mail ? 'no-reply@qivo.io' : '')
  vi.stubEnv('APP_MODE', '')
  vi.stubEnv('QIVO_ALLOW_LOCAL_AUTH_EMAIL_LOG', '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const provider = vi.fn().mockImplementation(async () => accepted())
  vi.stubGlobal('fetch', provider)
  const t = newT()
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
  // the app's client sends this header, empty before a session exists
  const post = (path: string, input: Record<string, string>, cookie = '') =>
    t.fetch(`/api/auth/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP, 'better-auth-cookie': cookie },
      body: JSON.stringify(input),
    })
  const signUp = (email: string, password = PASSWORD) =>
    post('sign-up/email', { email, password, name: 'Mail test' })
  const letters = () => provider.mock.calls.map(([, init]) => JSON.parse(init.body))
  const link = (letter: { text: string }) => new URL(letter.text.match(/https?:\/\/\S+/)![0])
  /** Signs up and follows the confirmation link. */
  const confirmed = async (email: string) => {
    provider.mockClear()
    expect((await signUp(email)).status).toBe(200)
    const url = link(letters()[0])
    expect((await t.fetch(`${url.pathname}${url.search}`)).status).toBe(302)
    provider.mockClear()
  }
  return { t, provider, post, signUp, letters, link, confirmed }
}

// convex's tsconfig declares a Response without json()
const json = async (response: Response) => JSON.parse(await response.text())

/** Status and body, the two things a caller can compare. */
const answer = async (response: Response) => ({
  status: response.status,
  body: await response.text(),
})

it('delivers verification and reset links through the mail provider and consumes both links', async () => {
  const { t, provider, post, letters, link } = backend()
  const email = 'auth-flow@example.test'
  const signup = await post('sign-up/email', {
    email,
    password: PASSWORD,
    name: 'Mail test',
    callbackURL: `${APP}/app`,
  })
  expect(signup.status, await signup.text()).toBe(200)
  expect(provider).toHaveBeenCalledOnce()
  const verification = letters()[0]
  expect(verification.reply_to).toEqual(['support@qivo.io'])
  const verifyUrl = link(verification)
  expect(verifyUrl.origin).toBe(SITE)
  expect(verifyUrl.searchParams.get('callbackURL')).toBe(`${APP}/app`)
  expect((await t.fetch(`${verifyUrl.pathname}${verifyUrl.search}`)).status).toBe(302)
  expect((await post('sign-in/email', { email, password: PASSWORD })).status).toBe(200)

  provider.mockClear()
  const reset = await post('request-password-reset', { email, redirectTo: `${APP}/app?reset=1` })
  expect(reset.status, await reset.text()).toBe(200)
  expect(provider).toHaveBeenCalledOnce()
  const message = letters()[0]
  expect(message.reply_to).toEqual(['support@qivo.io'])
  const resetUrl = link(message)
  expect(resetUrl.origin).toBe(SITE)
  const landing = await t.fetch(`${resetUrl.pathname}${resetUrl.search}`)
  expect(landing.status).toBe(302)
  const destination = new URL(landing.headers.get('location')!)
  expect(destination.origin).toBe(APP)
  expect(destination.pathname).toBe('/app')
  expect(destination.searchParams.get('reset')).toBe('1')
  const newPassword = 'Test-only replacement password 271828!'
  const token = destination.searchParams.get('token')!
  expect(token).toBeTruthy()
  expect((await post('reset-password', { token, newPassword })).status).toBe(200)
  expect((await post('sign-in/email', { email, password: newPassword })).status).toBe(200)
  expect((await post('sign-in/email', { email, password: PASSWORD })).status).not.toBe(200)
  expect((await post('reset-password', { token, newPassword: PASSWORD })).status).not.toBe(200)
  expect(provider.mock.calls[0][0]).toBe('https://api.lettermint.co/v1/send')
})

it('mails an existing sign-up address a note instead of a link, and an unknown reset address one too', async () => {
  const { post, signUp, letters, confirmed } = backend()
  await confirmed('known@example.test')

  expect((await signUp('known@example.test', 'Test-only other password 161803!')).status).toBe(200)
  expect(letters()).toHaveLength(1)
  expect(letters()[0]).toMatchObject({ to: ['known@example.test'], subject: 'Your Qivo account' })
  expect(letters()[0].text).toContain(`${APP}/app`)
  expect(letters()[0].text).not.toContain('token=')

  expect((await post('request-password-reset', { email: 'nobody@example.test' })).status).toBe(200)
  expect(letters()).toHaveLength(2)
  expect(letters()[1]).toMatchObject({
    to: ['nobody@example.test'],
    subject: 'Your Qivo password reset request',
  })
  expect(letters()[1].text).toContain(`${APP}/app#signup`)
})

it('refuses an address the sender would never mail before creating anything', async () => {
  const { post, signUp, provider } = backend()
  // Better Auth takes a domain label that ends in a hyphen; the sender does not
  const unmailable = 'anna@exam-.test'
  for (const answer of [
    await signUp(unmailable),
    await post('request-password-reset', { email: unmailable }),
  ]) {
    expect(answer.status).toBe(400)
    expect(await json(answer)).toEqual({
      code: 'UNMAILABLE_EMAIL',
      message: 'Qivo cannot send email to that address. Use another one.',
    })
  }
  expect(provider).not.toHaveBeenCalled()
  // no account was created: sign-in finds none
  expect((await post('sign-in/email', { email: unmailable, password: PASSWORD })).status).toBe(401)
})

it('mails nothing for a reset request that fails validation', async () => {
  const { t, provider, confirmed } = backend()
  await confirmed('known@example.test')
  const reset = await t.fetch('/api/auth/request-password-reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP, 'better-auth-cookie': '' },
    body: JSON.stringify({ email: 'known@example.test', redirectTo: null }),
  })
  expect(reset.status).toBe(400)
  expect(provider).not.toHaveBeenCalled()
})

describe('a person is told when their email could not be sent', () => {
  it('refuses sign-up, reset and resend before anything is created while mail is off', async () => {
    const { post, signUp, provider } = backend(false)
    const signup = await signUp('off@example.test')
    expect(signup.status).toBe(503)
    expect(await json(signup)).toEqual({
      code: 'AUTH_MAIL_UNAVAILABLE',
      message:
        'Qivo cannot send email right now, so it cannot confirm a new account. Try again later.',
    })
    for (const email of ['off@example.test', 'nobody@example.test']) {
      const reset = await post('request-password-reset', { email })
      expect(reset.status).toBe(503)
      expect((await json(reset)).code).toBe('AUTH_MAIL_UNAVAILABLE')
      expect((await post('send-verification-email', { email })).status).toBe(503)
    }
    // no account was left behind that could never be confirmed: once mail
    // works, the same address signs up as new and gets a confirmation link
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-project-token')
    vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io')
    expect((await signUp('off@example.test')).status).toBe(200)
    expect(provider).toHaveBeenCalledOnce()
    expect(JSON.parse(provider.mock.calls[0][1].body).subject).toBe(
      'Confirm your email address on Qivo',
    )
  })

  it('tells an unconfirmed sign-in that no new link went out while mail is off', async () => {
    const { post, signUp } = backend()
    expect((await signUp('later@example.test')).status).toBe(200)
    vi.stubEnv('LETTERMINT_API_KEY', '')
    const signin = await post('sign-in/email', { email: 'later@example.test', password: PASSWORD })
    expect(signin.status).toBe(403)
    expect(await json(signin)).toEqual({
      code: 'AUTH_MAIL_UNAVAILABLE',
      message:
        'Confirm your email first. Qivo cannot send email right now, so no new link was sent. Try again later.',
    })
    // a wrong password is still only a wrong password
    const wrong = await post('sign-in/email', {
      email: 'later@example.test',
      password: 'Test-only wrong password 000000!',
    })
    expect(wrong.status).toBe(401)
  })

  it('reports a refused sign-up the same way for a new and an existing address', async () => {
    const { post, signUp, provider, confirmed } = backend()
    await confirmed('known@example.test')
    provider.mockImplementation(async () => refused())
    const fresh = await answer(await signUp('new@example.test'))
    const existing = await answer(await signUp('known@example.test'))
    expect(fresh).toEqual(existing)
    expect(fresh.status).toBe(503)
    expect(JSON.parse(fresh.body)).toEqual({
      code: 'AUTH_MAIL_NOT_SENT',
      message:
        'We could not send the confirmation email. Wait a few minutes, then sign in to get a new one.',
    })
    expect(provider).toHaveBeenCalledTimes(2)

    // signing in later mails the fresh link the sentence promises
    provider.mockImplementation(async () => accepted())
    provider.mockClear()
    const signin = await post('sign-in/email', { email: 'new@example.test', password: PASSWORD })
    expect(signin.status).toBe(403)
    expect((await json(signin)).code).toBe('EMAIL_NOT_VERIFIED')
    expect(JSON.parse(provider.mock.calls[0][1].body).subject).toBe(
      'Confirm your email address on Qivo',
    )
  })

  it('reports a refused reset the same way for a known and an unknown address', async () => {
    const { post, provider, confirmed } = backend()
    await confirmed('known@example.test')
    provider.mockImplementation(async () => refused())
    const known = await answer(
      await post('request-password-reset', { email: 'known@example.test' }),
    )
    const unknown = await answer(
      await post('request-password-reset', { email: 'nobody@example.test' }),
    )
    expect(known).toEqual(unknown)
    expect(known.status).toBe(503)
    expect(JSON.parse(known.body)).toEqual({
      code: 'AUTH_MAIL_NOT_SENT',
      message: 'We could not send the email. Try again in a few minutes.',
    })
  })

  it('says a send may not have arrived when the provider kept failing', async () => {
    const { post, provider } = backend()
    provider.mockImplementation(async () => failing())
    const reset = await post('request-password-reset', { email: 'nobody@example.test' })
    expect(reset.status).toBe(503)
    expect(await json(reset)).toEqual({
      code: 'AUTH_MAIL_NOT_SENT',
      message:
        'We could not confirm that the email was sent. If it does not arrive, try again in a few minutes.',
    })
    expect(provider).toHaveBeenCalledTimes(3)
  })

  it('tells an unconfirmed sign-in that its new link could not be sent', async () => {
    const { post, signUp, provider } = backend()
    expect((await signUp('later@example.test')).status).toBe(200)
    provider.mockImplementation(async () => refused())
    const signin = await post('sign-in/email', { email: 'later@example.test', password: PASSWORD })
    expect(signin.status).toBe(403)
    expect(await json(signin)).toEqual({
      code: 'AUTH_MAIL_NOT_SENT',
      message:
        'Confirm your email first. We could not send a new link, so try again in a few minutes.',
    })
  })

  it('refuses a resend without a session for every address and sends nothing', async () => {
    const { post, signUp, provider } = backend()
    expect((await signUp('later@example.test')).status).toBe(200)
    provider.mockClear()
    const unconfirmed = await answer(
      await post('send-verification-email', { email: 'later@example.test' }),
    )
    const unknown = await answer(
      await post('send-verification-email', { email: 'nobody@example.test' }),
    )
    expect(unconfirmed).toEqual(unknown)
    expect(unconfirmed.status).toBe(401)
    expect(JSON.parse(unconfirmed.body).message).toBe('Sign in to get a new confirmation link.')
    expect(provider).not.toHaveBeenCalled()
  })

  it('tells a signed-in unconfirmed login that its resend could not be sent', async () => {
    const { t, post, provider, confirmed } = backend()
    await confirmed('provider-login@example.test')
    const signin = await post('sign-in/email', {
      email: 'provider-login@example.test',
      password: PASSWORD,
    })
    const cookie = signin.headers
      .get('set-better-auth-cookie')
      ?.match(/(?:^|,\s*)([^=;,]*session_token=[^;]+)/)?.[1]
    expect(cookie).toBeTruthy()
    // a provider login arrives unconfirmed with a session, as Entra's do
    await t.mutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'user',
        where: [{ field: 'email', value: 'provider-login@example.test' }],
        update: { emailVerified: false },
      },
    })
    provider.mockImplementation(async () => refused())
    const input = { email: 'provider-login@example.test', callbackURL: `${APP}/app` }
    const resend = await post('send-verification-email', input, cookie)
    expect(resend.status).toBe(503)
    expect(await json(resend)).toEqual({
      code: 'AUTH_MAIL_NOT_SENT',
      message: 'We could not send the confirmation email. Try again in a few minutes.',
    })
    provider.mockImplementation(async () => accepted())
    provider.mockClear()
    const again = await post('send-verification-email', input, cookie)
    expect(again.status, await again.text()).toBe(200)
    expect(provider).toHaveBeenCalledOnce()
  })
})

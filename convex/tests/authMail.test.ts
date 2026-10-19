/* Run the real auth HTTP handler through scheduled mail and link consumption.
 * Only Lettermint's network boundary is mocked. No hosted data is touched. */
/// <reference types="vite/client" />
import { afterEach, expect, it, vi } from 'vitest'
import authSchema from '../betterAuth/schema'
import { newT } from './helpers.setup'

const APP = 'http://localhost:5199'
const SITE = 'https://some.convex.site'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('delivers verification and reset links through the mail provider and consumes both links', async () => {
  vi.stubEnv('SITE_URL', APP)
  vi.stubEnv('CONVEX_SITE_URL', SITE)
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-only-auth-mail-secret-at-least-32-characters')
  vi.stubEnv('LETTERMINT_API_KEY', 'test-only-project-token')
  vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io')
  vi.stubEnv('APP_MODE', '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const provider = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ message_id: 'test-only-message' }),
  })
  vi.stubGlobal('fetch', provider)
  vi.useFakeTimers()
  const t = newT()
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
  const post = (path: string, input: Record<string, string>) =>
    t.fetch(`/api/auth/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP },
      body: JSON.stringify(input),
    })
  const email = 'auth-flow@example.test'
  const password = 'Test-only original password 314159!'
  const signup = await post('sign-up/email', {
    email,
    password,
    name: 'Mail test',
    callbackURL: `${APP}/app`,
  })
  expect(signup.status, await signup.text()).toBe(200)
  await t.finishAllScheduledFunctions(vi.runAllTimers)
  expect(provider).toHaveBeenCalledOnce()
  const verification = JSON.parse(provider.mock.calls[0][1].body)
  expect(verification.reply_to).toEqual(['support@qivo.io'])
  const verifyUrl = new URL(verification.text.match(/https?:\/\/\S+/)[0])
  expect(verifyUrl.origin).toBe(SITE)
  expect(verifyUrl.searchParams.get('callbackURL')).toBe(`${APP}/app`)
  expect((await t.fetch(`${verifyUrl.pathname}${verifyUrl.search}`)).status).toBe(302)
  expect((await post('sign-in/email', { email, password })).status).toBe(200)

  provider.mockClear()
  const reset = await post('request-password-reset', { email, redirectTo: `${APP}/app?reset=1` })
  expect(reset.status, await reset.text()).toBe(200)
  await t.finishAllScheduledFunctions(vi.runAllTimers)
  expect(provider).toHaveBeenCalledOnce()
  const message = JSON.parse(provider.mock.calls[0][1].body)
  expect(message.reply_to).toEqual(['support@qivo.io'])
  const resetUrl = new URL(message.text.match(/https?:\/\/\S+/)[0])
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
  expect((await post('sign-in/email', { email, password })).status).not.toBe(200)
  expect((await post('reset-password', { token, newPassword: password })).status).not.toBe(200)
  expect(provider.mock.calls[0][0]).toBe('https://api.lettermint.co/v1/send')
})

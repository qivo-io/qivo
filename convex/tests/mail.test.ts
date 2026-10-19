import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import { sendBillingReminder, sendDeletionNotice, sendInviteEmail } from '../mail'
import { newT } from './helpers.setup'

const letter = {
  to: 'recipient@example.test',
  intent: 'reset' as const,
  url: 'https://backend.example.test/reset?token=test-only-token',
}

beforeEach(() => {
  vi.stubEnv('LETTERMINT_API_KEY', '')
  vi.stubEnv('MAIL_FROM', '')
  vi.stubEnv('APP_MODE', '')
  vi.stubEnv('QIVO_ALLOW_LOCAL_AUTH_EMAIL_LOG', '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('authentication mail configuration', () => {
  it('fails without disclosing an auth link when hosted mail is missing, even with local logging enabled', async () => {
    for (const environment of ['production', 'preview', 'staging']) {
      vi.stubEnv('QIVO_ENVIRONMENT', environment)
      vi.stubEnv('SITE_URL', 'https://app.example.test')
      vi.stubEnv('QIVO_ALLOW_LOCAL_AUTH_EMAIL_LOG', 'true')
      await expect(newT().action(internal.mail.send, letter)).rejects.toThrow(
        /Authentication email is unavailable/,
      )
    }
    expect(console.log).not.toHaveBeenCalled()
  })

  it('requires both a loopback origin and explicit opt-in for local auth links', async () => {
    vi.stubEnv('QIVO_ENVIRONMENT', 'development')
    vi.stubEnv('SITE_URL', 'http://localhost:5199')
    await expect(newT().action(internal.mail.send, letter)).rejects.toThrow(/unavailable/)
    vi.stubEnv('QIVO_ALLOW_LOCAL_AUTH_EMAIL_LOG', 'true')
    vi.stubEnv('SITE_URL', 'https://shared.example.test')
    await expect(newT().action(internal.mail.send, letter)).rejects.toThrow(/unavailable/)
    vi.stubEnv('SITE_URL', 'http://localhost:5199')
    await newT().action(internal.mail.send, letter)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(letter.url))
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(letter.to)
  })

  it('refuses a partial provider configuration and never falls back to logging', async () => {
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
    vi.stubEnv('QIVO_ALLOW_LOCAL_AUTH_EMAIL_LOG', 'true')
    await expect(newT().action(internal.mail.send, letter)).rejects.toThrow(/MAIL_FROM/)
    // a sender that is not one bare address cannot reach the From header
    vi.stubEnv('MAIL_FROM', 'Qivo <no-reply@qivo.io>, other@example.test')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(newT().action(internal.mail.send, letter)).rejects.toThrow(/MAIL_FROM/)
    expect(fetch).not.toHaveBeenCalled()
    expect(console.log).not.toHaveBeenCalled()
  })

  it.each(['verify', 'reset'] as const)(
    'sends %s through the provider without logging secrets',
    async (intent) => {
      vi.stubEnv('QIVO_ENVIRONMENT', 'production')
      vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
      vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io')
      const fetch = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ message_id: 'test-message' }) })
      vi.stubGlobal('fetch', fetch)
      await newT().action(internal.mail.send, { ...letter, intent })
      expect(fetch).toHaveBeenCalledOnce()
      expect(fetch.mock.calls[0][0]).toBe('https://api.lettermint.co/v1/send')
      expect(fetch.mock.calls[0][1].headers['x-lettermint-token']).toBe('test-only-provider-token')
      expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined()
      expect(fetch.mock.calls[0][1].headers['Idempotency-Key']).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
        from: 'Qivo <no-reply@qivo.io>',
        to: [letter.to],
        reply_to: ['support@qivo.io'],
        subject:
          intent === 'verify' ? 'Confirm your email address on Qivo' : 'Reset your Qivo password',
      })
      expect(JSON.parse(fetch.mock.calls[0][1].body).text).toContain(letter.url)
      const logs = JSON.stringify(vi.mocked(console.log).mock.calls)
      expect(logs).not.toContain(letter.url)
      expect(logs).not.toContain(letter.to)
      expect(logs).not.toContain('test-only-provider-token')
    },
  )
})

describe('invitation mail', () => {
  const invite = (deadline: number) =>
    sendInviteEmail({
      to: letter.to,
      org_name: 'Brightwater Studio',
      as_guest: false,
      url: 'https://app.example.test/app#signup',
      send_key: 'test-only-invite',
      deadline,
    })

  beforeEach(() => {
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
    vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io')
  })

  it('reports not sent, without calling the provider, once the batch deadline has passed', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await invite(Date.now() - 1)).toBe('unsent')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('gives up instead of waiting out a Retry-After that ends past the deadline', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: () => '120' },
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', fetch)
    expect(await invite(Date.now() + 5_000)).toBe('uncertain')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('folds a long or multi-line organization name into one capped line', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message_id: 'm' }) })
    vi.stubGlobal('fetch', fetch)
    const outcome = await sendInviteEmail({
      to: letter.to,
      org_name: `Acme\n\nVisit   example.test ${'x'.repeat(100)}`,
      as_guest: true,
      url: 'https://app.example.test/app',
      send_key: 'test-only-invite',
      deadline: Date.now() + 60_000,
    })
    expect(outcome).toBe('sent')
    const { text } = JSON.parse(fetch.mock.calls[0][1].body)
    expect(text.split('\n')[2]).toMatch(
      /^Acme Visit example\.test x{56}… has invited you to join their organization as a guest\. /,
    )
  })

  it('is unsent after a final refusal, and uncertain after a network error', async () => {
    const refusal = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => null },
      json: async () => ({ error: { code: 'FEATURE_NOT_AVAILABLE', message: letter.to } }),
    })
    vi.stubGlobal('fetch', refusal)
    expect(await invite(Date.now() + 60_000)).toBe('unsent')
    expect(refusal).toHaveBeenCalledOnce()
    // the provider's code is logged, never its message
    const errors = JSON.stringify(vi.mocked(console.error).mock.calls)
    expect(errors).toContain('FEATURE_NOT_AVAILABLE')
    expect(errors).not.toContain(letter.to)
    const unreachable = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue({
        ok: false,
        status: 403,
        headers: { get: () => null },
        json: async () => ({}),
      })
    vi.stubGlobal('fetch', unreachable)
    // the retry after the network error waits half a second
    expect(await invite(Date.now() + 60_000)).toBe('uncertain')
    expect(unreachable).toHaveBeenCalledTimes(2)
  })

  it('retries a server error under the same key and counts the replayed acceptance as sent', async () => {
    const answers = [
      { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) },
      { ok: true, status: 202, json: async () => ({ message_id: 'm', status: 'pending' }) },
    ]
    const fetch = vi.fn().mockImplementation(async () => answers.shift())
    vi.stubGlobal('fetch', fetch)
    expect(await invite(Date.now() + 60_000)).toBe('sent')
    expect(fetch).toHaveBeenCalledTimes(2)
    const keys = fetch.mock.calls.map(([, init]) => init.headers['Idempotency-Key'])
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(keys[1]).toBe(keys[0])
  })

  it('repeats a conflict once, then reports it uncertain', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      headers: { get: () => null },
      json: async () => ({ error: { code: 'IDEMPOTENCY_CONFLICT' } }),
    })
    vi.stubGlobal('fetch', fetch)
    expect(await invite(Date.now() + 60_000)).toBe('uncertain')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('is not sent when mail is not configured', async () => {
    vi.stubEnv('LETTERMINT_API_KEY', '')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await invite(Date.now() + 60_000)).toBe('unsent')
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
    vi.stubEnv('MAIL_FROM', '')
    expect(await invite(Date.now() + 60_000)).toBe('unsent')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('shared transactional transport', () => {
  const billing = {
    to: letter.to,
    url: 'https://app.example.test/app/test/settings/org-billing',
    until: '2099-01-01T00:00:00.000Z',
    notice_key: 'test-only-billing-notice',
  }

  it('uses the same sender and support reply address for billing', async () => {
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
    vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io')
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ message_id: 'billing' }) })
    vi.stubGlobal('fetch', fetch)
    expect(await sendBillingReminder(billing)).toBe(true)
    expect(fetch.mock.calls[0][0]).toBe('https://api.lettermint.co/v1/send')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      from: 'Qivo <no-reply@qivo.io>',
      to: [letter.to],
      reply_to: ['support@qivo.io'],
      text: expect.stringContaining(billing.url),
    })
  })

  it('sends a deletion notice under its notice key, so a repeat is the same letter', async () => {
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
    vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io')
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message_id: 'd' }) })
    vi.stubGlobal('fetch', fetch)
    const notice = {
      to: letter.to,
      org_name: 'Brightwater\nStudio',
      delete_after: '2099-02-01T00:00:00.000Z',
      reason: 'requested',
      url: 'https://app.example.test/app/brightwater/settings/org-general',
      notice_key: 'test-only-deletion-notice',
    }
    expect(await sendDeletionNotice(notice)).toBe(true)
    expect(await sendDeletionNotice(notice)).toBe(true)
    const [first, second] = fetch.mock.calls.map(([, init]) => init)
    expect(second.headers['Idempotency-Key']).toBe(first.headers['Idempotency-Key'])
    expect(JSON.parse(first.body)).toMatchObject({
      from: 'Qivo <no-reply@qivo.io>',
      to: [letter.to],
      reply_to: ['support@qivo.io'],
      subject: 'Export your Qivo data before it is deleted',
      text: expect.stringContaining(
        'Brightwater Studio is read-only and will be deleted on 2099-02-01',
      ),
    })
    expect(JSON.parse(first.body).text).toContain(notice.url)
  })

  it('never sends demo mail even with a complete provider configuration', async () => {
    vi.stubEnv('APP_MODE', 'demo')
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
    vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await newT().action(internal.mail.send, letter)
    expect(await sendBillingReminder(billing)).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not send billing reminders without configuration', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await sendBillingReminder(billing)).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails on provider rejection without retrying or disclosing the response body', async () => {
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
    vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io')
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ message: letter.url, errors: { to: [letter.to] } }),
    })
    vi.stubGlobal('fetch', fetch)
    await expect(newT().action(internal.mail.send, letter)).rejects.toThrow(
      'Authentication email delivery failed',
    )
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(letter.url)
  })
})

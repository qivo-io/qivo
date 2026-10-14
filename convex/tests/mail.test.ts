import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import { sendBillingReminder, sendInviteEmail } from '../mail'
import { newT } from './helpers.setup'

const letter = {
  to: 'recipient@example.test',
  intent: 'reset' as const,
  url: 'https://backend.example.test/reset?token=test-only-token',
}

beforeEach(() => {
  vi.stubEnv('AGENTMAIL_API_KEY', '')
  vi.stubEnv('AGENTMAIL_INBOX', '')
  vi.stubEnv('AGENTMAIL_BASE_URL', undefined)
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
    vi.stubEnv('AGENTMAIL_API_KEY', 'test-only-provider-key')
    vi.stubEnv('QIVO_ALLOW_LOCAL_AUTH_EMAIL_LOG', 'true')
    await expect(newT().action(internal.mail.send, letter)).rejects.toThrow(/AGENTMAIL_INBOX/)
    expect(console.log).not.toHaveBeenCalled()
  })

  it.each(['verify', 'reset'] as const)(
    'sends %s through the shared inbox without logging secrets',
    async (intent) => {
      vi.stubEnv('QIVO_ENVIRONMENT', 'production')
      vi.stubEnv('AGENTMAIL_API_KEY', 'test-only-provider-key')
      vi.stubEnv('AGENTMAIL_INBOX', 'no-reply@qivo.io')
      const fetch = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ message_id: 'test-message' }) })
      vi.stubGlobal('fetch', fetch)
      await newT().action(internal.mail.send, { ...letter, intent })
      expect(fetch).toHaveBeenCalledOnce()
      expect(fetch.mock.calls[0][0]).toBe(
        'https://api.agentmail.to/v0/inboxes/no-reply%40qivo.io/messages/send',
      )
      expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-only-provider-key')
      expect(fetch.mock.calls[0][1].headers['Idempotency-Key']).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
        to: [letter.to],
        reply_to: ['support@qivo.io'],
        subject:
          intent === 'verify' ? 'Confirm your email address on Qivo' : 'Reset your Qivo password',
      })
      expect(JSON.parse(fetch.mock.calls[0][1].body).text).toContain(letter.url)
      const logs = JSON.stringify(vi.mocked(console.log).mock.calls)
      expect(logs).not.toContain(letter.url)
      expect(logs).not.toContain(letter.to)
      expect(logs).not.toContain('test-only-provider-key')
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
    vi.stubEnv('AGENTMAIL_API_KEY', 'test-only-provider-key')
    vi.stubEnv('AGENTMAIL_INBOX', 'no-reply@qivo.io')
  })

  it('reports not sent, without calling the provider, once the batch deadline has passed', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await invite(Date.now() - 1)).toBe(false)
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
    expect(await invite(Date.now() + 5_000)).toBe(false)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('folds a long or multi-line organization name into one capped line', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message_id: 'm' }) })
    vi.stubGlobal('fetch', fetch)
    await sendInviteEmail({
      to: letter.to,
      org_name: `Acme\n\nVisit   example.test ${'x'.repeat(100)}`,
      as_guest: true,
      url: 'https://app.example.test/app',
      send_key: 'test-only-invite',
      deadline: Date.now() + 60_000,
    })
    const { text } = JSON.parse(fetch.mock.calls[0][1].body)
    expect(text.split('\n')[2]).toMatch(
      /^Acme Visit example\.test x{56}… has invited you to join their organization as a guest\. /,
    )
  })

  it('is not sent when mail is not configured', async () => {
    vi.stubEnv('AGENTMAIL_API_KEY', '')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await invite(Date.now() + 60_000)).toBe(false)
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

  it('uses the same inbox and support reply address for billing, preserving the API host override', async () => {
    vi.stubEnv('AGENTMAIL_API_KEY', 'test-only-provider-key')
    vi.stubEnv('AGENTMAIL_INBOX', 'no-reply@qivo.io')
    vi.stubEnv('AGENTMAIL_BASE_URL', 'https://mail.example.test/')
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ message_id: 'billing' }) })
    vi.stubGlobal('fetch', fetch)
    expect(await sendBillingReminder(billing)).toBe(true)
    expect(fetch.mock.calls[0][0]).toBe(
      'https://mail.example.test/v0/inboxes/no-reply%40qivo.io/messages/send',
    )
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      to: [letter.to],
      reply_to: ['support@qivo.io'],
      text: expect.stringContaining(billing.url),
    })
  })

  it('never sends demo mail even with a complete provider configuration', async () => {
    vi.stubEnv('APP_MODE', 'demo')
    vi.stubEnv('AGENTMAIL_API_KEY', 'test-only-provider-key')
    vi.stubEnv('AGENTMAIL_INBOX', 'no-reply@qivo.io')
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
    vi.stubEnv('AGENTMAIL_API_KEY', 'test-only-provider-key')
    vi.stubEnv('AGENTMAIL_INBOX', 'no-reply@qivo.io')
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: letter.url }),
    })
    vi.stubGlobal('fetch', fetch)
    await expect(newT().action(internal.mail.send, letter)).rejects.toThrow(
      'Authentication email delivery failed',
    )
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(letter.url)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendAuthLetter, sendBillingReminder, sendDeletionNotice, sendInviteEmail } from '../mail'

const letter = {
  to: 'recipient@example.test',
  intent: 'reset' as const,
  url: 'https://backend.example.test/reset?token=test-only-token',
}
const send = sendAuthLetter

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
  it('is unavailable without disclosing an auth link when hosted mail is missing, even with local logging enabled', async () => {
    for (const environment of ['production', 'preview', 'staging']) {
      vi.stubEnv('QIVO_ENVIRONMENT', environment)
      vi.stubEnv('SITE_URL', 'https://app.example.test')
      vi.stubEnv('QIVO_ALLOW_LOCAL_AUTH_EMAIL_LOG', 'true')
      expect(await send(letter)).toBe('unavailable')
    }
    expect(console.log).not.toHaveBeenCalled()
  })

  it('requires both a loopback origin and explicit opt-in for local auth links', async () => {
    vi.stubEnv('QIVO_ENVIRONMENT', 'development')
    vi.stubEnv('SITE_URL', 'http://localhost:5199')
    expect(await send(letter)).toBe('unavailable')
    vi.stubEnv('QIVO_ALLOW_LOCAL_AUTH_EMAIL_LOG', 'true')
    vi.stubEnv('SITE_URL', 'https://shared.example.test')
    expect(await send(letter)).toBe('unavailable')
    vi.stubEnv('SITE_URL', 'http://localhost:5199')
    expect(await send(letter)).toBe('sent')
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(letter.url))
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(letter.to)
  })

  it('refuses a partial provider configuration and never falls back to logging', async () => {
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
    vi.stubEnv('QIVO_ALLOW_LOCAL_AUTH_EMAIL_LOG', 'true')
    expect(await send(letter)).toBe('unavailable')
    // a sender that is not one bare address cannot reach the From header
    vi.stubEnv('MAIL_FROM', 'Qivo <no-reply@qivo.io>, other@example.test')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await send(letter)).toBe('unavailable')
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
      expect(await send({ ...letter, intent })).toBe('sent')
      expect(fetch).toHaveBeenCalledOnce()
      expect(fetch.mock.calls[0][0]).toBe('https://api.lettermint.co/v1/send')
      expect(fetch.mock.calls[0][1].headers['x-lettermint-token']).toBe('test-only-provider-token')
      expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined()
      expect(fetch.mock.calls[0][1].headers['Idempotency-Key']).toMatch(/^[a-f0-9]{64}$/)
      // a redirect would carry the token header to another origin
      expect(fetch.mock.calls[0][1].redirect).toBe('error')
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

describe('an authentication letter that may have gone out', () => {
  it('stays uncertain when a refusal follows a server error', async () => {
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
    vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io')
    const answer = (status: number) => ({
      ok: false,
      status,
      headers: { get: () => null },
      json: async () => ({}),
    })
    const fetch = vi.fn().mockResolvedValueOnce(answer(500)).mockResolvedValueOnce(answer(401))
    vi.stubGlobal('fetch', fetch)
    expect(await send(letter)).toBe('uncertain')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('the send endpoint', () => {
  const sendTo = async () => {
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
    vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io')
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message_id: 'm' }) })
    vi.stubGlobal('fetch', fetch)
    await send(letter)
    return fetch.mock.calls[0][0]
  }

  it('reaches a loopback stub only from a local development backend', async () => {
    vi.stubEnv('QIVO_ENVIRONMENT', 'development')
    vi.stubEnv('SITE_URL', 'http://localhost:5199')
    vi.stubEnv('LETTERMINT_SEND_URL', 'http://127.0.0.1:4010/v1/send')
    expect(await sendTo()).toBe('http://127.0.0.1:4010/v1/send')
  })

  it('ignores the stub anywhere else, and a stub that is not on this machine', async () => {
    vi.stubEnv('LETTERMINT_SEND_URL', 'http://127.0.0.1:4010/v1/send')
    for (const [environment, site] of [
      ['production', 'https://qivo.io'],
      ['staging', 'https://preview.qivo.io'],
      ['development', 'https://shared.example.test'],
    ]) {
      vi.stubEnv('QIVO_ENVIRONMENT', environment)
      vi.stubEnv('SITE_URL', site)
      expect(await sendTo()).toBe('https://api.lettermint.co/v1/send')
    }
    vi.stubEnv('QIVO_ENVIRONMENT', 'development')
    vi.stubEnv('SITE_URL', 'http://localhost:5199')
    for (const stub of ['https://stub.example.test/v1/send', 'not a url']) {
      vi.stubEnv('LETTERMINT_SEND_URL', stub)
      expect(await sendTo()).toBe('https://api.lettermint.co/v1/send')
    }
  })
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
      headers: { get: () => '20' },
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

  it('is unsent after a final refusal, and uncertain when a network error was the last answer', async () => {
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
    // a refusal of the repeat means the first attempt was not accepted either
    expect(await invite(Date.now() + 60_000)).toBe('unsent')
    expect(unreachable).toHaveBeenCalledTimes(2)
    const lost = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', lost)
    // the deadline passes before the retry, so the first attempt may have delivered it
    expect(await invite(Date.now() + 300)).toBe('uncertain')
    expect(lost).toHaveBeenCalledOnce()
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

  it('counts a sandbox acceptance as not sent, because nothing was delivered', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ message_id: 'm', status: 'pending', sandbox: true }),
    })
    vi.stubGlobal('fetch', fetch)
    expect(await invite(Date.now() + 60_000)).toBe('unsent')
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('sandbox mode')
  })

  it('repeats a conflict that follows its own timeout, and counts the first acceptance as sent', async () => {
    const answers = [
      () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
      () =>
        Promise.resolve({
          ok: false,
          status: 409,
          headers: { get: () => null },
          json: async () => ({ message: 'still being processed' }),
        }),
      () => Promise.resolve({ ok: true, status: 202, json: async () => ({ message_id: 'm' }) }),
    ]
    const fetch = vi.fn().mockImplementation(() => answers.shift()?.())
    vi.stubGlobal('fetch', fetch)
    expect(await invite(Date.now() + 60_000)).toBe('sent')
    expect(fetch).toHaveBeenCalledTimes(3)
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
    expect(console.error).not.toHaveBeenCalled()
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
    vi.stubEnv('MAIL_FROM', 'Qivo <no-reply@qivo.io>')
    expect(await invite(Date.now() + 60_000)).toBe('unsent')
    expect(fetch).not.toHaveBeenCalled()
    // a token beside an unusable sender is logged, without the value
    const errors = JSON.stringify(vi.mocked(console.error).mock.calls)
    expect(errors).toContain('MAIL_FROM is not one address')
    expect(errors).not.toContain('no-reply@qivo.io')
  })
})

describe('shared transactional transport', () => {
  const billing = {
    to: letter.to,
    url: 'https://app.example.test/app/test/settings/org-billing',
    until: '2099-01-01T00:00:00.000Z',
    notice_key: 'test-only-billing-notice',
    attempt: 0,
  }
  const deletion = {
    to: letter.to,
    org_name: 'Brightwater\nStudio',
    delete_after: '2099-02-01T00:00:00.000Z',
    reason: 'requested',
    url: 'https://app.example.test/app/brightwater/settings/org-general',
    notice_key: 'test-only-deletion-notice',
    attempt: 0,
  }

  it('uses the same sender and support reply address for billing', async () => {
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
    // a pasted trailing newline is not part of the address
    vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io\n')
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

  it('sends a deletion notice under one key per hourly attempt', async () => {
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
    vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io')
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message_id: 'd' }) })
    vi.stubGlobal('fetch', fetch)
    expect(await sendDeletionNotice(deletion)).toBe(true)
    expect(await sendDeletionNotice(deletion)).toBe(true)
    expect(await sendDeletionNotice({ ...deletion, attempt: 1 })).toBe(true)
    const [first, second, next] = fetch.mock.calls.map(([, init]) => init)
    expect(second.headers['Idempotency-Key']).toBe(first.headers['Idempotency-Key'])
    expect(next.headers['Idempotency-Key']).toMatch(/^[a-f0-9]{64}$/)
    expect(next.headers['Idempotency-Key']).not.toBe(first.headers['Idempotency-Key'])
    expect(JSON.parse(first.body)).toMatchObject({
      from: 'Qivo <no-reply@qivo.io>',
      to: [letter.to],
      reply_to: ['support@qivo.io'],
      subject: 'Export your Qivo data before it is deleted',
      text: expect.stringContaining(
        'Brightwater Studio is read-only and will be deleted on 2099-02-01',
      ),
    })
    expect(JSON.parse(first.body).text).toContain(deletion.url)
  })

  it('counts a sandbox acceptance as not sent on every path', async () => {
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
    vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io')
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ message_id: 'm', status: 'pending', sandbox: true }),
    })
    vi.stubGlobal('fetch', fetch)
    expect(await sendBillingReminder(billing)).toBe(false)
    expect(await sendDeletionNotice(deletion)).toBe(false)
    expect(await send(letter)).toBe('unsent')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('leaves a Retry-After longer than a send allows to the hourly retry', async () => {
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
    vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io')
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: () => '120' },
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', fetch)
    expect(await sendBillingReminder(billing)).toBe(false)
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('longer wait')
  })

  it('never sends demo mail even with a complete provider configuration', async () => {
    vi.stubEnv('APP_MODE', 'demo')
    vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
    vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await send(letter)).toBe('unavailable')
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
    expect(await send(letter)).toBe('unsent')
    expect(fetch).toHaveBeenCalledOnce()
    const errors = JSON.stringify(vi.mocked(console.error).mock.calls)
    expect(errors).not.toContain(letter.url)
    expect(errors).not.toContain(letter.to)
  })
})

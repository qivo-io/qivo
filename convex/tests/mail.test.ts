import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import { newT } from './helpers.setup'

const letter = {
  to: 'recipient@example.test',
  intent: 'reset' as const,
  url: 'https://backend.example.test/reset?token=test-only-token',
}

beforeEach(() => {
  vi.stubEnv('AGENTMAIL_API_KEY', '')
  vi.stubEnv('AGENTMAIL_INBOX', '')
  vi.stubEnv('QIVO_ALLOW_LOCAL_AUTH_EMAIL_LOG', '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
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

  it('sends through the configured provider without logging recipient or token', async () => {
    vi.stubEnv('QIVO_ENVIRONMENT', 'production')
    vi.stubEnv('AGENTMAIL_API_KEY', 'test-only-provider-key')
    vi.stubEnv('AGENTMAIL_INBOX', 'sender@example.test')
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ message_id: 'test-message' }) })
    vi.stubGlobal('fetch', fetch)
    await newT().action(internal.mail.send, letter)
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(fetch.mock.calls[0][1].body).text).toContain(letter.url)
    const logs = JSON.stringify(vi.mocked(console.log).mock.calls)
    expect(logs).not.toContain(letter.url)
    expect(logs).not.toContain(letter.to)
  })
})

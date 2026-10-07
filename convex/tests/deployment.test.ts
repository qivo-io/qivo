import { afterEach, describe, expect, it, vi } from 'vitest'
import { deploymentEnvironment, refuseProduction } from '../lib/deployment'

afterEach(() => vi.unstubAllEnvs())

describe('explicit deployment permissions', () => {
  it('refuses missing, unknown and production environments even on an innocuous hostname', () => {
    vi.stubEnv('SITE_URL', 'https://preview.example.test')
    for (const environment of [undefined, '', 'test', 'production', 'demo']) {
      vi.stubEnv('QIVO_ENVIRONMENT', environment)
      expect(() => refuseProduction('fixture')).toThrow()
    }
    vi.stubEnv('QIVO_ENVIRONMENT', '')
    expect(deploymentEnvironment).toThrow(/QIVO_ENVIRONMENT/)
  })

  it('accepts explicit isolated environments and rejects customer hosts and demo mode', () => {
    for (const environment of ['development', 'staging', 'preview']) {
      vi.stubEnv('QIVO_ENVIRONMENT', environment)
      vi.stubEnv('SITE_URL', 'https://preview.qivo.io')
      expect(() => refuseProduction('fixture')).not.toThrow()
    }
    for (const host of ['qivo.io', 'www.qivo.io', 'demo.qivo.io']) {
      vi.stubEnv('SITE_URL', `https://${host}`)
      expect(() => refuseProduction('fixture')).toThrow(/production/)
    }
    vi.stubEnv('SITE_URL', 'https://preview.example.test')
    vi.stubEnv('APP_MODE', 'demo')
    expect(() => refuseProduction('fixture')).toThrow(/public demo/)
  })

  it('requires a canonical HTTPS origin except for local development', () => {
    vi.stubEnv('QIVO_ENVIRONMENT', 'staging')
    for (const origin of [
      undefined,
      'http://localhost:5199',
      'https://preview.example.test/app',
      'https://user:password@preview.example.test',
      'https://preview.example.test/?token=test',
    ]) {
      vi.stubEnv('SITE_URL', origin)
      expect(() => refuseProduction('fixture')).toThrow()
    }
    vi.stubEnv('QIVO_ENVIRONMENT', 'development')
    vi.stubEnv('SITE_URL', 'http://localhost:5199')
    expect(() => refuseProduction('fixture')).not.toThrow()
    vi.stubEnv('SITE_URL', 'http://shared.example.test')
    expect(() => refuseProduction('fixture')).toThrow(/HTTPS/)
  })
})

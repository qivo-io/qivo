import { describe, expect, it } from 'vitest'
import { parseArgs, redact, resolveConfig } from './staging-check.mjs'

describe('staging check arguments', () => {
  it('takes the target, the comment cap and the cleanup options', () => {
    expect(parseArgs(['--staging', '--comment-cap']).commentCap).toBe(true)
    expect(parseArgs(['--staging', '--cleanup', '--run', 'a1b2c3']).run).toBe('a1b2c3')
    expect([...parseArgs(['--local', '--require', 'all']).require]).toContain('task-delay')
  })
  it('refuses unknown arguments, values that could be secrets and odd combinations', () => {
    for (const argv of [
      [],
      ['--staging', '--local'],
      ['--staging', '--token', 'qvt_0000'],
      ['--staging', '--run', 'a1b2c3'],
      ['--staging', '--cleanup', '--run', 'xyz'],
      ['--staging', '--cleanup', '--comment-cap'],
      ['--staging', '--require', 'text-caps'],
      ['--staging', '--invert', 'everything'],
    ])
      expect(() => parseArgs(argv)).toThrow()
  })
})

describe('staging check target', () => {
  const staging = {
    QIVO_ENVIRONMENT: 'staging',
    CONVEX_DEPLOY_KEY: 'prod:striped-snake-649|test-only',
    SITE_URL: 'https://preview.qivo.io',
  }
  const resolve = (env, extra = []) => resolveConfig(parseArgs(['--staging', ...extra]), env)

  it('accepts the staging app with its own deployment, with or without a region', () => {
    expect(resolve(staging)).toMatchObject({
      appOrigin: 'https://preview.qivo.io',
      apiOrigin: 'https://striped-snake-649.convex.site',
    })
    const regional = {
      ...staging,
      VITE_CONVEX_URL: 'https://striped-snake-649.eu-west-1.convex.cloud',
    }
    expect(resolve(regional).apiOrigin).toBe('https://striped-snake-649.eu-west-1.convex.site')
  })
  it('refuses production, another app and another deployment', () => {
    for (const change of [
      { QIVO_ENVIRONMENT: undefined },
      { QIVO_ENVIRONMENT: 'production' },
      { SITE_URL: 'https://qivo.io' },
      { SITE_URL: 'https://demo.qivo.io' },
      { SITE_URL: 'https://qivo-staging.vercel.app' },
      { SITE_URL: 'http://preview.qivo.io' },
      { CONVEX_DEPLOY_KEY: 'dev:striped-snake-649|test-only' },
      { CONVEX_DEPLOY_KEY: 'prod:striped-snake-649' },
    ])
      expect(() => resolve({ ...staging, ...change })).toThrow()
    expect(() =>
      resolve(staging, ['--api-url', 'https://determined-dachshund-357.convex.site']),
    ).toThrow()
    expect(() => resolve(staging, ['--api-url', 'https://api.qivo.io'])).toThrow()
  })
  it('takes loopback origins only for a local run, outside a hosted helper', () => {
    const local = [
      '--local',
      '--app-url',
      'http://localhost:5241',
      '--convex-url',
      'http://127.0.0.1:3236',
      '--api-url',
      'http://127.0.0.1:3237',
      '--deployment',
      'local-name-3236',
    ]
    expect(resolveConfig(parseArgs(local), {}).apiOrigin).toBe('http://127.0.0.1:3237')
    expect(() => resolveConfig(parseArgs(local), { QIVO_ENVIRONMENT: 'staging' })).toThrow()
    expect(() => resolveConfig(parseArgs(local), { QIVO_ENVIRONMENT: 'production' })).toThrow()
    const remote = local.map((a) => (a === 'http://127.0.0.1:3237' ? 'https://api.qivo.io' : a))
    expect(() => resolveConfig(parseArgs(remote), {})).toThrow()
  })
})

describe('staging check output', () => {
  it('removes credentials, codes, signed link values and known secrets', () => {
    const line = redact(
      [
        'qvt_aaaaaaaaaaaaaaaaaaaa qva_bbbbbbbbbbbbbbbbbbbb qvo_cccccccccccc',
        'Bearer something',
        'https://x.convex.cloud/api/storage/upload?token=abc123',
        'https://x.convex.site/files/1?e=1&m=a&t=def456',
        '/callback?code=ghi789&state=jkl',
        'the fixture password hunter2-long',
      ].join(' '),
      new Set(['hunter2-long']),
    )
    for (const secret of [
      'aaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbb',
      'cccccccccccc',
      'something',
      'abc123',
      'def456',
      'ghi789',
      'hunter2-long',
    ])
      expect(line).not.toContain(secret)
    expect(line).toContain('qvt_[redacted]')
    expect(line).toContain('t=[redacted]')
  })
  it('leaves ordinary status text alone', () => {
    const text = 'PASS uploads/delete  7 files deleted in 12 s'
    expect(redact(text, new Set())).toBe(text)
  })
})

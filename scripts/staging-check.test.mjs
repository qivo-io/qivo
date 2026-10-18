import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  addDays,
  findComment,
  hasTag,
  parseArgs,
  redact,
  request,
  resolveConfig,
  TAG_ANY,
  weekOf,
  windowOrder,
} from './staging-check.mjs'

describe('staging check arguments', () => {
  it('takes the target, the comment cap and the cleanup options', () => {
    expect(parseArgs(['--staging', '--comment-cap']).commentCap).toBe(true)
    expect(parseArgs(['--staging', '--cleanup', '--run', 'a1b2c3']).run).toBe('a1b2c3')
    expect([...parseArgs(['--local', '--require', 'all']).require]).toEqual(['billing-pause-leave'])
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
      // merged features are checked for real, not behind a probe
      ['--staging', '--require', 'task-delay'],
      ['--staging', '--force', 'billing-pause-leave'],
      ['--staging', '--invert', 'everything'],
    ])
      expect(() => parseArgs(argv)).toThrow()
  })
  it('never repeats a value it refuses, which could be a secret', () => {
    const secret = 'qvt_1111111111111111111111111'
    for (const argv of [
      ['--staging', secret],
      ['--staging', '--require', secret],
      ['--staging', '--invert', `read-token,${secret}`],
    ])
      expect(() => parseArgs(argv)).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining('0123456789abcdef'),
        }),
      )
    expect(() => parseArgs(['--staging', '--tokn'])).toThrow('Unknown argument --tokn.')
  })
})

describe('staging check weeks', () => {
  it('finds the first day of the planning week for any week start', () => {
    // 2026-10-18 is a Sunday
    expect(weekOf('2026-10-18', 1)).toBe('2026-10-12')
    expect(weekOf('2026-10-18', 0)).toBe('2026-10-18')
    expect(weekOf('2026-10-19', 1)).toBe('2026-10-19')
    expect(weekOf('2026-10-17', 6)).toBe('2026-10-17')
    expect(weekOf('2026-01-01', 1)).toBe('2025-12-29')
    expect(weekOf('2026-10-18', 1)).not.toBe('2026-10-19')
  })
  it('moves a day across months and years', () => {
    expect(addDays('2026-10-12', 35)).toBe('2026-11-16')
    expect(addDays('2026-01-05', -70)).toBe('2025-10-27')
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
    expect(() => resolveConfig(parseArgs(local), { QIVO_ENVIRONMENT: 'demo' })).toThrow()
    for (const [from, to] of [
      ['http://127.0.0.1:3236', 'http://192.168.1.20:3236'],
      ['http://localhost:5241', 'https://localhost:5241'],
    ])
      expect(() => resolveConfig(parseArgs(local.map((a) => (a === from ? to : a))), {})).toThrow()
  })
  it('refuses debug output that would print secrets past redaction', () => {
    for (const env of [
      { DEBUG: 'pw:api' },
      { PWDEBUG: '1' },
      { DEBUG_FILE: '/tmp/x' },
      { NODE_DEBUG: 'http' },
    ])
      expect(() => resolve({ ...staging, ...env })).toThrow(/debug output/)
  })
})

describe('run tags', () => {
  it('matches a name that starts with the tag and a space, and nothing else', () => {
    expect(hasTag('stgchk-1a2b3c', 'stgchk-1a2b3c project')).toBe(true)
    for (const name of [
      'stgchk-1a2b3cd project',
      'stgchk-1a2b3c',
      'my stgchk-1a2b3c project',
      'Stgchk-1a2b3c project',
      undefined,
    ])
      expect(hasTag('stgchk-1a2b3c', name)).toBe(false)
    expect(hasTag(TAG_ANY, 'stgchk-00ff99 cleanup token')).toBe(true)
    for (const name of ['stgchk-00ff9 x', 'stgchk-00ff99x', 'stgchk-00FF99 x', 'x stgchk-00ff99 y'])
      expect(hasTag(TAG_ANY, name)).toBe(false)
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

describe('staging check requests', () => {
  /** A loopback server; `handle` answers each request after its body arrived. */
  const serve = async (handle) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => handle(req, res, body))
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    return { server, origin: `http://127.0.0.1:${server.address().port}` }
  }

  it('refuses a redirect, so a body never reaches another origin', async () => {
    const seen = []
    const other = await serve((_req, res, body) => {
      seen.push(body)
      res.end('{}')
    })
    const first = await serve((_req, res) => {
      res.writeHead(307, { Location: `${other.origin}/token` }).end()
    })
    try {
      await expect(
        request(`${first.origin}/token`, { method: 'POST', body: 'refresh_token=secret-value' }),
      ).rejects.toThrow('a request was answered with a redirect, which this check never follows')
      expect(seen).toEqual([])
      const direct = await request(`${other.origin}/token`, { method: 'POST', body: 'ok' })
      expect(direct.status).toBe(200)
      expect(seen).toEqual(['ok'])
    } finally {
      first.server.close()
      other.server.close()
    }
  })

  it('gives up on a request that gets no answer', async () => {
    const stalled = await serve(() => {})
    try {
      await expect(request(`${stalled.origin}/me`, {}, 200)).rejects.toThrow(
        'network error: no answer in 0.2 s',
      )
    } finally {
      stalled.server.closeAllConnections()
      stalled.server.close()
    }
  })
})

describe('comment cap helpers', () => {
  // 400 comments, oldest first, paged newest first like REST
  const thread = Array.from({ length: 400 }, (_, i) => ({ id: `c${1000 + i}`, body: `cap ${i}` }))
  const readPage = async (before) => {
    const end = before ? thread.findIndex((c) => c.id === before) : thread.length
    return thread.slice(Math.max(0, end - 50), end)
  }
  it('finds a stored comment beyond the newest 50', async () => {
    expect(await findComment(readPage, 'cap 10')).toBe('c1010')
    expect(await findComment(readPage, 'cap 399')).toBe('c1399')
    expect(await findComment(readPage, 'cap 400')).toBeUndefined()
  })
  it('orders comments of the same millisecond by id, as the task window does', () => {
    const at = '2026-10-18T10:00:00.123Z'
    const stored = [
      { id: 'b', created_at: '2026-10-18T09:59:59.000Z' },
      { id: 'z', created_at: at },
      { id: 'a', created_at: at },
      { id: 'c', created_at: '2026-10-18T10:00:01.000Z' },
    ]
    expect(windowOrder(stored)).toEqual(['b', 'a', 'z', 'c'])
  })
})

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HISTORY_PAGE_MAX } from '../convex/lib/activityVisibility'
import {
  ACCESS_PUT_FIELDS,
  HELD_TASKS_FIELDS,
  MEMBER_PUT_FIELDS,
} from '../convex/machine/bodyFields'
import { COMMENT_PAGE_MAX } from '../convex/model/comments'
import {
  addDays,
  deleteOutcome,
  evaluate,
  hasTag,
  historyRows,
  isSiteOf,
  pace,
  parseArgs,
  RATE_BUDGET,
  REST_BODY_FIELDS,
  rateLimitWait,
  redact,
  request,
  resolveConfig,
  send,
  syncsWith,
  TAG_ANY,
  THREAD_PAGE,
  WAITS,
  WRITE_CONFLICT,
  weekOf,
} from './staging-check.mjs'

describe('staging check REST contract', () => {
  it('expects the body fields the access and member routes take', () => {
    expect(REST_BODY_FIELDS).toEqual({
      accessPut: [...ACCESS_PUT_FIELDS],
      heldTasks: [...HELD_TASKS_FIELDS],
      memberPut: [...MEMBER_PUT_FIELDS],
    })
  })
  it('fills a task to the page sizes of its thread', () => {
    expect(THREAD_PAGE).toEqual({ comments: COMMENT_PAGE_MAX, history: HISTORY_PAGE_MAX })
  })
})

describe('staging check arguments', () => {
  it('takes the target and the cleanup options', () => {
    expect(parseArgs(['--staging']).target).toBe('staging')
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
      // the 400-comment run went with the comment cap
      ['--staging', '--comment-cap'],
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
          message: expect.not.stringContaining(secret.slice(4)),
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
  it('takes a Convex site URL of the deployment only', () => {
    const deployment = 'striped-snake-649'
    for (const url of [
      'https://striped-snake-649.convex.site',
      'https://striped-snake-649.eu-west-1.convex.site',
    ])
      expect(isSiteOf(new URL(url), deployment)).toBe(true)
    for (const url of [
      'http://striped-snake-649.convex.site',
      'https://determined-dachshund-357.convex.site',
      'https://striped-snake-649.convex.site.evil.example',
      'https://striped-snake-649.convex.cloud',
    ])
      expect(isSiteOf(new URL(url), deployment)).toBe(false)
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

describe('local backend proof', () => {
  const backend = 'http://127.0.0.1:3236'
  it("accepts the Convex client's sync socket to the backend", () => {
    expect(
      syncsWith(['ws://localhost:5241/?token=hmr', 'ws://127.0.0.1:3236/api/1.31.0/sync'], backend),
    ).toBe(true)
    expect(
      syncsWith(
        ['wss://striped-snake-649.convex.cloud/api/1.31.0/sync'],
        'https://striped-snake-649.convex.cloud',
      ),
    ).toBe(true)
  })
  it('refuses a socket to another host, port, protocol or path', () => {
    for (const socket of [
      'ws://127.0.0.1:3210/api/1.31.0/sync',
      'ws://localhost:3236/api/1.31.0/sync',
      'wss://127.0.0.1:3236/api/1.31.0/sync',
      'ws://127.0.0.1:3236/',
      'ws://127.0.0.1:5241/api/1.31.0/sync',
      'not a URL',
    ])
      expect(syncsWith([socket], backend)).toBe(false)
    expect(syncsWith([], backend)).toBe(false)
  })
})

describe('page calls', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  it('gives up on a page call that never settles and leaves no timer', async () => {
    vi.useFakeTimers()
    const hung = { evaluate: () => new Promise(() => {}) }
    const failed = expect(evaluate(hung, () => 1, undefined, 1000)).rejects.toThrow(
      'a call in the page gave no answer in 1 s',
    )
    await vi.advanceTimersByTimeAsync(1000)
    await failed
    expect(vi.getTimerCount()).toBe(0)
  })
  it('answers what the page answers and leaves no timer', async () => {
    vi.useFakeTimers()
    const page = { evaluate: async (fn, arg) => fn(arg) }
    expect(await evaluate(page, (n) => n * 2, 21)).toBe(42)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('request pacing', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  it('lets RATE_BUDGET calls of a profile through at once, then waits for the oldest to age', async () => {
    vi.useFakeTimers()
    const profile = `pace-${randomUUID()}`
    let through = 0
    for (let i = 0; i < RATE_BUDGET; i++) pace(profile).then(() => through++)
    await vi.advanceTimersByTimeAsync(0)
    expect(through).toBe(RATE_BUDGET)
    let next = false
    pace(profile).then(() => {
      next = true
    })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(next).toBe(false)
    // a call just inside the minute waits too, and another profile has its own window
    let late = false
    pace(profile).then(() => {
      late = true
    })
    let other = false
    pace(`pace-${randomUUID()}`).then(() => {
      other = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(other).toBe(true)
    expect(next || late).toBe(false)
    // the oldest call is 60 seconds old, plus the 100 ms margin
    await vi.advanceTimersByTimeAsync(101)
    expect(next && late).toBe(true)
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

  describe('send', () => {
    const waits = { ...WAITS }
    beforeEach(() => {
      Object.assign(WAITS, { rateLimit: 20, readRetry: 5, conflictRetry: 5 })
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })
    afterEach(() => {
      Object.assign(WAITS, waits)
      vi.restoreAllMocks()
    })
    /** Sends one request to a server that gives `answers` ([status, body])
     *  in turn and then the last one again, and answers the status send()
     *  returned and how many requests the server got. */
    const exchange = async (answers, read) => {
      let hits = 0
      const target = await serve((_req, res) => {
        const [status, body = {}] = answers[Math.min(hits++, answers.length - 1)]
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
      })
      try {
        const init = read ? { method: 'GET' } : { method: 'POST', body: '{}' }
        const r = await send(`send-${randomUUID()}`, `${target.origin}/v1/tasks`, init, { read })
        await r.arrayBuffer()
        return { status: r.status, hits }
      } finally {
        target.server.closeAllConnections()
        target.server.close()
      }
    }

    it('waits out one 429 and answers what comes next', async () => {
      expect(await exchange([[429], [200]], true)).toEqual({ status: 200, hits: 2 })
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('waiting 0.02 seconds'))
    })
    it("waits a 429's Retry-After seconds and one more, else the most it waits", () => {
      Object.assign(WAITS, { rateLimit: 61_000 })
      expect(rateLimitWait('17')).toBe(18_000)
      expect(rateLimitWait('1')).toBe(2_000)
      expect(rateLimitWait('60')).toBe(61_000)
      for (const header of [null, '', '0', '61', '2.5', 'soon', '-3'])
        expect(rateLimitWait(header), String(header)).toBe(61_000)
    })
    it('returns a second 429 as it is', async () => {
      expect(await exchange([[429]], true)).toEqual({ status: 429, hits: 2 })
    })
    it('sends a read once more after a server error', async () => {
      expect(await exchange([[502], [200]], true)).toEqual({ status: 200, hits: 2 })
      expect(await exchange([[503]], true)).toEqual({ status: 503, hits: 2 })
    })
    it('never sends a write again after a server error', async () => {
      expect(await exchange([[500]], false)).toEqual({ status: 500, hits: 1 })
      expect(await exchange([[503, { error: 'internal error' }]], false)).toEqual({
        status: 503,
        hits: 1,
      })
    })
    it('sends a write once more after a write conflict', async () => {
      const conflict = [503, { error: WRITE_CONFLICT }]
      expect(await exchange([conflict, [201]], false)).toEqual({ status: 201, hits: 2 })
      expect(await exchange([conflict], false)).toEqual({ status: 503, hits: 2 })
    })
  })
})

describe('attachment delete answers', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const outcome = (r, surface) => deleteOutcome(r, surface, id, 'QN-7')
  it('counts a success only when it says deleted: true', () => {
    expect(outcome({ status: 200, json: { deleted: true } }, 'rest')).toBe('deleted')
    expect(outcome({ status: 200, isError: false, data: { deleted: true } }, 'mcp')).toBe('deleted')
    expect(outcome({ status: 200, json: { deleted: false } }, 'rest')).toBe('deleted is false')
    expect(outcome({ status: 200, isError: false, data: {} }, 'mcp')).toBe('deleted is undefined')
  })
  it('leaves a lost answer, a server error and a not-found answer to a read', () => {
    for (const [r, surface] of [
      [{ status: 0, error: 'network error' }, 'rest'],
      [{ status: 502, json: null }, 'rest'],
      [{ status: 500, json: { error: 'internal error' } }, 'rest'],
      [{ status: 404, json: { error: 'attachment not found' } }, 'rest'],
      [{ status: 200, isError: true, text: 'internal error' }, 'mcp'],
      [{ status: 200, isError: true, text: `attachment "${id}" not found on QN-7` }, 'mcp'],
      [{ status: 503, json: null }, 'mcp'],
    ])
      expect(outcome(r, surface)).toBe('unsure')
  })
  it('fails a refusal or another not-found answer as it is', () => {
    for (const [r, surface] of [
      [{ status: 403, json: { error: 'this credential can only read' } }, 'rest'],
      [{ status: 404, json: { error: 'task not found' } }, 'rest'],
      [
        { status: 200, isError: true, text: 'your account has no write access to that project' },
        'mcp',
      ],
      [{ status: 200, isError: true, text: `attachment "${id}" not found on QN-8` }, 'mcp'],
    ])
      expect(outcome(r, surface)).toMatch(/^HTTP /)
  })
})

describe('thread pages', () => {
  // 511 rows, oldest first, one second apart, paged newest first like REST
  const all = Array.from({ length: 511 }, (_, i) => ({
    id: `r${i}`,
    verb: i === 0 ? 'created' : 'labeled',
    created_at: new Date(Date.UTC(2026, 9, 21, 12, 0, i)).toISOString(),
  }))
  const pages = (rows) => [rows.slice(-500), rows.slice(0, -500)]
  it('takes the whole history in a full page and the rest', () => {
    expect(historyRows(pages(all), 511).map((r) => r.id)).toEqual(all.map((r) => r.id))
  })
  it('refuses a history with rows missing, repeated or out of order', () => {
    // the earlier page holds only the created row
    expect(() => historyRows([all.slice(-500), all.slice(0, 1)], 511)).toThrow(
      /^rows across pages:/,
    )
    expect(() => historyRows([all.slice(-500), all.slice(0, 12)], 511)).toThrow(
      /^distinct rows across pages:/,
    )
    // a short newest page, though every row comes once
    expect(() => historyRows([all.slice(-499), all.slice(0, 12)], 511)).toThrow(/^the newest page:/)
    expect(() => historyRows(pages(all.slice(1)), 510)).toThrow(/^the first row:/)
    expect(() => historyRows([all.slice(-500)], 500)).toThrow(/^pages before the empty one:/)
    const swapped = [...all.slice(0, 10), all[20], ...all.slice(10, 20), ...all.slice(21)]
    expect(() => historyRows(pages(swapped), 511)).toThrow(/^pages overlap or skip/)
  })
})

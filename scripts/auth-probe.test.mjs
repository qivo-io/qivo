import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeAuthRoutes, probeSite, pushThenProbe, recordSiteUrl } from './auth-probe.mjs'

const SITE = 'https://fixture-otter-12.convex.site'

/* What each route answers on a deployment that runs the change. The
 * session read clears the token cookie, as Better Auth does without a
 * session. */
const ANSWERS = {
  '/api/auth/get-session': () =>
    new Response('null', {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie':
          '__Secure-better-auth.convex_jwt=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
      },
    }),
  '/api/auth/oauth2/token': () =>
    Response.json(
      { error: 'invalid_request', error_description: 'secret-looking body text' },
      { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } },
    ),
  '/.well-known/oauth-authorization-server': () =>
    Response.json({ issuer: `${SITE}/api/auth`, token_endpoint_auth_methods_supported: ['none'] }),
}

/* A deployment stand-in that answers each path from `answers`, which
 * override ANSWERS, and records the requests. */
const deployment = (answers = {}) =>
  vi.fn(async (url, _init) => {
    const path = new URL(url).pathname
    return { ...ANSWERS, ...answers }[path]()
  })
const noWait = async () => {}
const paths = (fetch) =>
  fetch.mock.calls.map(([url, init]) => `${init.method} ${new URL(url).pathname}`)

/* The status and headers `answer` gives, with a body that fails with
 * `fault` once read, as when the connection drops after the headers
 * (undici's TypeError 'terminated') or the timeout runs out before the
 * body arrives (a TimeoutError). */
const cutOff = (answer, fault) => {
  const { status, headers } = answer()
  const body = new ReadableStream({ start: (controller) => controller.error(fault) })
  return new Response(body, { status, headers })
}
const TERMINATED = new TypeError('terminated')
const BODY_TIMEOUT = new DOMException('The operation was aborted due to timeout', 'TimeoutError')

describe('probeAuthRoutes', () => {
  afterEach(() => vi.restoreAllMocks())

  it('passes on the expected answers, each route once, with one line each', async () => {
    const fetch = deployment()
    const lines = []
    await probeAuthRoutes(SITE, { fetch, sleep: noWait, log: (line) => lines.push(line) })
    expect(paths(fetch)).toEqual([
      'GET /api/auth/get-session',
      'POST /api/auth/oauth2/token',
      'GET /.well-known/oauth-authorization-server',
    ])
    expect(fetch.mock.calls.every(([, init]) => !('Cookie' in (init.headers ?? {})))).toBe(true)
    expect(lines).toHaveLength(4)
    expect(
      lines
        .slice(0, 3)
        .every((line) => /^\[auth-probe\] \S+ \S+ \d{3} in \d+ ms \(attempt 1\)$/.test(line)),
    ).toBe(true)
    expect(lines.join('\n')).not.toMatch(/secret-looking|invalid_request|convex_jwt/)
  })

  it('sends only the sign-in route on the demo', async () => {
    const fetch = deployment()
    await probeAuthRoutes(SITE, { demo: true, fetch, sleep: noWait, log: () => {} })
    expect(paths(fetch)).toEqual(['GET /api/auth/get-session'])
  })

  it.each([
    [
      'a 500',
      { '/api/auth/get-session': () => new Response('import refused', { status: 500 }) },
      'GET /api/auth/get-session answered 500, not 200',
    ],
    [
      'a session cookie from get-session',
      {
        '/api/auth/get-session': () =>
          new Response('null', {
            headers: { 'Set-Better-Auth-Cookie': '__Secure-better-auth.session_token=abc; Path=/' },
          }),
      },
      'GET /api/auth/get-session set a cookie without a session',
    ],
    [
      'a session from get-session',
      { '/api/auth/get-session': () => Response.json({ session: {}, user: {} }) },
      'GET /api/auth/get-session answered a session without a cookie',
    ],
    [
      'a 2xx from the token refusal',
      { '/api/auth/oauth2/token': () => Response.json({ access_token: 'x' }) },
      'POST /api/auth/oauth2/token answered 200, not 400',
    ],
    [
      'a token refusal without its public CORS',
      {
        '/api/auth/oauth2/token': () =>
          Response.json({ error: 'invalid_request' }, { status: 400 }),
      },
      'POST /api/auth/oauth2/token answered without its public CORS',
    ],
    [
      'metadata without ["none"]',
      {
        '/.well-known/oauth-authorization-server': () =>
          Response.json({ token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'] }),
      },
      'GET /.well-known/oauth-authorization-server answered metadata whose token endpoint takes another method than none',
    ],
  ])('fails on %s, naming the route', async (_name, answers, failure) => {
    const error = await probeAuthRoutes(SITE, {
      fetch: deployment(answers),
      sleep: noWait,
      log: () => {},
    }).catch((caught) => caught)
    expect(error.message).toBe(
      `The deployment's auth routes did not answer as expected: ${failure}.`,
    )
  })

  it('names every route that failed, as a refused import fails them all', async () => {
    const refused = () => new Response(null, { status: 500 })
    const fetch = vi.fn(async () => refused())
    const error = await probeAuthRoutes(SITE, { fetch, sleep: noWait, log: () => {} }).catch(
      (caught) => caught,
    )
    expect(error.message).toBe(
      "The deployment's auth routes did not answer as expected: GET /api/auth/get-session answered 500, not 200; POST /api/auth/oauth2/token answered 500, not 400; GET /.well-known/oauth-authorization-server answered 500, not 200.",
    )
    expect(fetch).toHaveBeenCalledTimes(12)
  })

  it('tries a request that gets no answer 4 times, 1, 2 and 4 seconds apart, then fails', async () => {
    const sleep = vi.fn(noWait)
    const fetch = vi.fn(async (url) => {
      if (new URL(url).pathname === '/api/auth/get-session')
        throw new TypeError(`fetch failed for ${url}`)
      return deployment()(url)
    })
    const lines = []
    const error = await probeAuthRoutes(SITE, {
      fetch,
      sleep,
      log: (line) => lines.push(line),
    }).catch((caught) => caught)
    expect(error.message).toBe(
      "The deployment's auth routes did not answer as expected: GET /api/auth/get-session gave no answer.",
    )
    expect(sleep.mock.calls).toEqual([[1000], [2000], [4000]])
    expect(paths(fetch).filter((path) => path.endsWith('get-session'))).toHaveLength(4)
    expect(lines.filter((line) => line.includes('no answer'))).toHaveLength(4)
  })

  it('passes once a 5xx gives way to the expected answer', async () => {
    const answers = [new Response(null, { status: 503 }), ANSWERS['/api/auth/get-session']()]
    const fetch = vi.fn(async (url) =>
      new URL(url).pathname === '/api/auth/get-session' ? answers.shift() : deployment()(url),
    )
    const sleep = vi.fn(noWait)
    await probeAuthRoutes(SITE, { fetch, sleep, log: () => {} })
    expect(sleep.mock.calls).toEqual([[1000]])
  })

  it('gives each request 15 seconds, then tries again', async () => {
    const stalled = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(stalled.signal)
    const answering = deployment()
    const fetch = vi.fn((url, init) =>
      init.signal === stalled.signal
        ? new Promise((_resolve, reject) =>
            init.signal.addEventListener('abort', () => reject(init.signal.reason)),
          )
        : answering(url, init),
    )
    const lines = []
    const done = probeAuthRoutes(SITE, { fetch, sleep: noWait, log: (line) => lines.push(line) })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    stalled.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    await done
    expect(timeout.mock.calls).toEqual([[15_000], [15_000], [15_000], [15_000]])
    expect(lines[0]).toBe('[auth-probe] GET /api/auth/get-session no answer (attempt 1)')
  })

  it.each(Object.keys(ANSWERS))(
    'tries %s again when its body is cut off after the headers, then passes',
    async (path) => {
      const answers = [cutOff(ANSWERS[path], TERMINATED), ANSWERS[path]()]
      const fetch = vi.fn(async (url) =>
        new URL(url).pathname === path ? answers.shift() : deployment()(url),
      )
      const sleep = vi.fn(noWait)
      const lines = []
      await probeAuthRoutes(SITE, { fetch, sleep, log: (line) => lines.push(line) })
      expect(sleep.mock.calls).toEqual([[1000]])
      expect(paths(fetch).filter((sent) => sent.endsWith(path))).toHaveLength(2)
      expect(lines.filter((line) => line.includes('cut off'))).toEqual([
        expect.stringMatching(/^\[auth-probe\] \S+ \S+ \d{3} cut off after \d+ ms \(attempt 1\)$/),
      ])
    },
  )

  it.each([
    ['cut off', TERMINATED, 'answered 200, but the answer was cut off'],
    ['late', BODY_TIMEOUT, 'answered 200, but the rest of the answer did not arrive in 15 s'],
  ])(
    'fails naming the route when its body is %s on every attempt, and still checks the others',
    async (_name, fault, problem) => {
      const fetch = vi.fn(async (url) =>
        new URL(url).pathname === '/api/auth/get-session'
          ? cutOff(ANSWERS['/api/auth/get-session'], fault)
          : deployment()(url),
      )
      const sleep = vi.fn(noWait)
      const error = await probeAuthRoutes(SITE, { fetch, sleep, log: () => {} }).catch(
        (caught) => caught,
      )
      expect(error.message).toBe(
        `The deployment's auth routes did not answer as expected: GET /api/auth/get-session ${problem}.`,
      )
      expect(sleep.mock.calls).toEqual([[1000], [2000], [4000]])
      expect(paths(fetch)).toEqual([
        ...Array(4).fill('GET /api/auth/get-session'),
        'POST /api/auth/oauth2/token',
        'GET /.well-known/oauth-authorization-server',
      ])
    },
  )

  it('fails at once on a whole answer whose body is not JSON, without trying again', async () => {
    const fetch = deployment({
      '/api/auth/oauth2/token': () =>
        new Response('<html>Bad Gateway</html>', {
          status: 400,
          headers: { 'Access-Control-Allow-Origin': '*' },
        }),
    })
    const sleep = vi.fn(noWait)
    const error = await probeAuthRoutes(SITE, { fetch, sleep, log: () => {} }).catch(
      (caught) => caught,
    )
    expect(error.message).toBe(
      "The deployment's auth routes did not answer as expected: POST /api/auth/oauth2/token answered without invalid_request.",
    )
    expect(sleep).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('follows no redirect', async () => {
    const fetch = deployment()
    await probeAuthRoutes(SITE, { fetch, sleep: noWait, log: () => {} })
    expect(fetch.mock.calls.every(([, init]) => init.redirect === 'manual')).toBe(true)
  })
})

describe('probeSite', () => {
  it('takes an https: origin, and a loopback http: one only for a local check', () => {
    expect(probeSite(SITE)).toBe(SITE)
    expect(probeSite('https://name.eu-west-1.convex.site')).toBe(
      'https://name.eu-west-1.convex.site',
    )
    expect(probeSite('http://127.0.0.1:3211', { local: true })).toBe('http://127.0.0.1:3211')
    expect(probeSite('http://localhost:3221', { local: true })).toBe('http://localhost:3221')
  })

  it.each([
    ['http://fixture-otter-12.convex.site', false],
    ['http://127.0.0.1:3211', false],
    [`${SITE}/api`, false],
    [`${SITE}/`, false],
    ['', false],
    ['http://example.test', true],
    ['ftp://127.0.0.1', true],
  ])('refuses %s (local %s) before any request', async (site, local) => {
    expect(() => probeSite(site, { local })).toThrow(/Convex site URL/)
    const fetch = vi.fn()
    await expect(probeAuthRoutes(site, { local, fetch, log: () => {} })).rejects.toThrow(
      /Convex site URL/,
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('recordSiteUrl', () => {
  it('writes the site URL only when QIVO_SITE_URL_FILE names a file', () => {
    const write = vi.fn()
    recordSiteUrl({ VITE_CONVEX_SITE_URL: SITE }, write)
    expect(write).not.toHaveBeenCalled()
    recordSiteUrl({ VITE_CONVEX_SITE_URL: SITE, QIVO_SITE_URL_FILE: '/tmp/x/site-url' }, write)
    expect(write).toHaveBeenCalledWith('/tmp/x/site-url', `${SITE}\n`, { mode: 0o600 })
  })

  it('refuses a malformed site URL', () => {
    const write = vi.fn()
    for (const site of [undefined, 'http://fixture-otter-12.convex.site', `${SITE}/path`])
      expect(() =>
        recordSiteUrl({ VITE_CONVEX_SITE_URL: site, QIVO_SITE_URL_FILE: '/tmp/x/site-url' }, write),
      ).toThrow(/Convex site URL/)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('pushThenProbe', () => {
  /* A `convex deploy` stand-in that records its calls and, as the build
   * command it runs, writes `site` (or nothing) to QIVO_SITE_URL_FILE. */
  const convexDeploy = (site, steps) =>
    vi.fn((_command, _args, options) => {
      steps.push('convex deploy')
      if (site !== undefined) writeFileSync(options.env.QIVO_SITE_URL_FILE, `${site}\n`)
    })

  it('probes the site the build recorded after convex deploy returns, then removes the file', async () => {
    const steps = []
    const run = convexDeploy(SITE, steps)
    const probe = vi.fn(async (site, options) => {
      steps.push(`probe ${site} demo ${options.demo}`)
    })
    await pushThenProbe({ CONVEX_DEPLOY_KEY: 'k' }, { run, command: 'node scripts/x.mjs', probe })
    expect(steps).toEqual(['convex deploy', `probe ${SITE} demo false`])
    expect(run.mock.calls[0].slice(0, 2)).toEqual([
      'npx',
      ['convex', 'deploy', '--cmd', 'node scripts/x.mjs'],
    ])
    const file = run.mock.calls[0][2].env.QIVO_SITE_URL_FILE
    expect(run.mock.calls[0][2].env.CONVEX_DEPLOY_KEY).toBe('k')
    expect(file.startsWith(tmpdir())).toBe(true)
    expect(existsSync(dirname(file))).toBe(false)
  })

  it.each([
    ['records no site URL', undefined, /recorded no Convex site URL/],
    ['records a malformed one', 'http://fixture-otter-12.convex.site', /Convex site URL must be/],
  ])('fails when the build %s, without probing', async (_name, site, message) => {
    const steps = []
    const run = convexDeploy(site, steps)
    const probe = vi.fn()
    await expect(pushThenProbe({}, { run, command: 'x', probe })).rejects.toThrow(message)
    expect(probe).not.toHaveBeenCalled()
    expect(existsSync(dirname(run.mock.calls[0][2].env.QIVO_SITE_URL_FILE))).toBe(false)
  })

  it('fails when the probe fails, and probes nothing when convex deploy fails', async () => {
    const steps = []
    const probe = vi.fn(async () => {
      throw new Error('refused')
    })
    await expect(
      pushThenProbe({}, { run: convexDeploy(SITE, steps), command: 'x', probe }),
    ).rejects.toThrow('refused')
    const failing = vi.fn(() => {
      throw new Error('Command failed: npx convex deploy')
    })
    const unused = vi.fn()
    await expect(pushThenProbe({}, { run: failing, command: 'x', probe: unused })).rejects.toThrow(
      'Command failed',
    )
    expect(unused).not.toHaveBeenCalled()
  })

  it('keeps the site URL file out of the checkout', async () => {
    const steps = []
    const run = convexDeploy(SITE, steps)
    await pushThenProbe({}, { run, command: 'x', probe: async () => {} })
    const file = run.mock.calls[0][2].env.QIVO_SITE_URL_FILE
    expect(file.startsWith(process.cwd())).toBe(false)
  })
})

describe('recordSiteUrl on disk', () => {
  it('writes the site URL and a newline to the file', () => {
    const folder = mkdtempSync(join(tmpdir(), 'qivo-auth-probe-test-'))
    try {
      const file = join(folder, 'site-url')
      recordSiteUrl({ VITE_CONVEX_SITE_URL: SITE, QIVO_SITE_URL_FILE: file })
      expect(readFileSync(file, 'utf8')).toBe(`${SITE}\n`)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

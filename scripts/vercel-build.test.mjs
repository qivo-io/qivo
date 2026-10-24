import { afterEach, describe, expect, it, vi } from 'vitest'
import { address } from '../convex/lib/mailConfig'
import {
  deploymentName,
  ignoredTheTarget,
  isOneAddress,
  isPreviewDeployKey,
  main,
  PREVIEW_LIFETIME_DAYS,
  previewSiteUrl,
  requireProductionBackendEnv,
  setPreviewExpiry,
  websiteOrigin,
} from './vercel-build.mjs'

/* The build script decides, from the environment alone, whether this deploy
 * is the one that must hand the backend its app origin. Getting either half
 * wrong is silent: a production key mistaken for a preview one would rewrite
 * SITE_URL on qivo.io, and a preview key mistaken for production leaves the
 * placeholder in place and the preview unusable. */

describe('isPreviewDeployKey — mirrors the CLI branch that claims a preview', () => {
  it('accepts the preview shape and nothing else', () => {
    expect(isPreviewDeployKey('preview:qivo-team:qivo|abc123')).toBe(true)
    // production and dev keys carry the deployment name, not "preview"
    expect(isPreviewDeployKey('prod:scintillating-iguana-170|abc123')).toBe(false)
    expect(isPreviewDeployKey('dev:admired-wildcat-470|abc123')).toBe(false)
    // project keys look close and are NOT preview keys
    expect(isPreviewDeployKey('project:qivo-team:qivo|abc123')).toBe(false)
  })

  it('refuses malformed and absent keys instead of guessing', () => {
    expect(isPreviewDeployKey('preview:qivo-team:qivo')).toBe(false) // no secret half
    expect(isPreviewDeployKey('preview:qivo|abc123')).toBe(false) // only two prefix parts
    expect(isPreviewDeployKey(undefined)).toBe(false)
    expect(isPreviewDeployKey('')).toBe(false)
  })
})

describe('previewSiteUrl — the exact origin the browser will load', () => {
  it('prefers the per-branch alias, which is what the per-branch backend matches', () => {
    expect(
      previewSiteUrl({
        VERCEL_BRANCH_URL: 'qivo-git-my-branch-techqi.vercel.app',
        VERCEL_URL: 'qivo-9x8f7g6h5-techqi.vercel.app',
      }),
    ).toBe('https://qivo-git-my-branch-techqi.vercel.app')
  })

  it('falls back to the deployment host when there is no branch alias', () => {
    expect(previewSiteUrl({ VERCEL_URL: 'qivo-9x8f7g6h5-techqi.vercel.app' })).toBe(
      'https://qivo-9x8f7g6h5-techqi.vercel.app',
    )
  })

  it('fails the build rather than trusting a wrong or wildcard origin', () => {
    expect(() => previewSiteUrl({})).toThrow(/cannot tell the preview backend/)
    expect(() => previewSiteUrl({ VERCEL_BRANCH_URL: '' })).toThrow(
      /cannot tell the preview backend/,
    )
    // a scheme would produce https://https://… and silently break every check
    expect(() => previewSiteUrl({ VERCEL_BRANCH_URL: 'https://x.vercel.app' })).toThrow(/bare host/)
  })

  it('never widens to a wildcard', () => {
    const url = previewSiteUrl({
      VERCEL_BRANCH_URL: 'qivo-git-b-techqi.vercel.app',
    })
    expect(url).not.toContain('*')
    expect(new URL(url).hostname).toBe('qivo-git-b-techqi.vercel.app')
  })
})

describe('deploymentName — the exact target, read off what convex handed the build', () => {
  it('takes the name out of the injected canonical cloud URL', () => {
    expect(
      deploymentName({
        VITE_CONVEX_URL: 'https://admired-wildcat-470.convex.cloud',
      }),
    ).toBe('admired-wildcat-470')
    expect(
      deploymentName({
        VITE_CONVEX_URL: 'https://tidy-otter-12.convex.cloud/',
      }),
    ).toBe('tidy-otter-12')
  })

  it('answers null rather than a guess when the URL is not a deployment URL', () => {
    // the SITE url, a custom domain, and nothing at all
    expect(
      deploymentName({
        VITE_CONVEX_URL: 'https://admired-wildcat-470.convex.site',
      }),
    ).toBe(null)
    expect(deploymentName({ VITE_CONVEX_URL: 'https://api.qivo.io' })).toBe(null)
    expect(deploymentName({})).toBe(null)
  })
})

describe('ignoredTheTarget — a success that went somewhere else is not a success', () => {
  it('spots the CLI warning that the target flag was dropped', () => {
    expect(
      ignoredTheTarget(
        'Ignoring `--prod`, `--preview-name`, or `--deployment-name` flags and using ' +
          'deployment from CONVEX_DEPLOY_KEY\n\u2714 Successfully set SITE_URL\n',
      ),
    ).toBe(true)
  })

  it('leaves an ordinary success alone', () => {
    expect(
      ignoredTheTarget('\u2714 Successfully set SITE_URL (on preview deployment tidy-otter-12)\n'),
    ).toBe(false)
    expect(ignoredTheTarget('')).toBe(false)
  })
})

describe('websiteOrigin — where the website build points canonical links', () => {
  it('uses the branch host for previews and the checked app origin for stable builds', () => {
    expect(
      websiteOrigin({
        CONVEX_DEPLOY_KEY: 'preview:team:qivo|abc',
        VERCEL_BRANCH_URL: 'qivo-git-x-techqi.vercel.app',
        QIVO_APP_ORIGIN: 'https://qivo.io',
      }),
    ).toBe('https://qivo-git-x-techqi.vercel.app')
    expect(
      websiteOrigin({
        CONVEX_DEPLOY_KEY: 'prod:scintillating-iguana-170|abc',
        QIVO_APP_ORIGIN: 'https://qivo.io',
      }),
    ).toBe('https://qivo.io')
  })
})

describe('requireProductionBackendEnv — production mail before functions push', () => {
  const backend = (values) => vi.fn((name) => values[name] ?? '')

  it('refuses a production backend without the Lettermint token or MAIL_FROM, naming only the missing', () => {
    const production = { QIVO_ENVIRONMENT: 'production' }
    expect(() =>
      requireProductionBackendEnv(production, backend({ LETTERMINT_API_KEY: 'test-only-token' })),
    ).toThrow('Set backend MAIL_FROM before releasing to production.')
    expect(() => requireProductionBackendEnv(production, backend({}))).toThrow(
      'Set backend LETTERMINT_API_KEY and MAIL_FROM before releasing to production.',
    )
  })

  it('refuses a MAIL_FROM that the mail code would not send from', () => {
    for (const from of ['Qivo <no-reply@qivo.io>', 'a@qivo.io, b@qivo.io', 'no-reply'])
      expect(() =>
        requireProductionBackendEnv(
          { QIVO_ENVIRONMENT: 'production' },
          backend({ LETTERMINT_API_KEY: 'test-only-token', MAIL_FROM: from }),
        ),
      ).toThrow('Set backend MAIL_FROM to one bare address before releasing to production.')
  })

  it('applies the same address rule as convex/lib/mailConfig.ts', () => {
    const samples = [
      'no-reply@qivo.io',
      'No-Reply@Mail.Qivo.IO',
      'Qivo <no-reply@qivo.io>',
      'a@qivo.io,b@qivo.io',
      'a b@qivo.io',
      'no-reply@localhost',
      'no-reply@-qivo.io',
      "o'brien@qivo.io",
      '"no-reply"@qivo.io',
      `${'a'.repeat(250)}@q.io`,
      `${'a'.repeat(249)}@q.io`,
    ]
    for (const s of samples) expect(isOneAddress(s), s).toBe(address(s) !== null)
    // an apostrophe is an ordinary address character
    expect(isOneAddress("o'brien@qivo.io")).toBe(true)
  })

  it('passes a configured production backend and never reads mail settings elsewhere', () => {
    const configured = backend({
      LETTERMINT_API_KEY: 'test-only-token',
      MAIL_FROM: 'no-reply@qivo.io',
    })
    expect(() =>
      requireProductionBackendEnv({ QIVO_ENVIRONMENT: 'production' }, configured),
    ).not.toThrow()
    const read = backend({})
    for (const environment of ['staging', 'preview', 'demo'])
      requireProductionBackendEnv({ QIVO_ENVIRONMENT: environment }, read)
    expect(read).not.toHaveBeenCalled()
  })
})

describe('main — the build refuses a production backend before it builds', () => {
  const production = {
    QIVO_ENVIRONMENT: 'production',
    QIVO_APP_ORIGIN: 'https://qivo.io',
    QIVO_CONVEX_DEPLOYMENT: 'fixture-cloud-123',
    VITE_CONVEX_URL: 'https://fixture-cloud-123.convex.cloud',
    CONVEX_DEPLOY_KEY: 'prod:fixture-cloud-123|test-only',
  }
  /** A command runner that answers `convex env get` from `values` and
   * records every command. */
  const runner = (values) =>
    vi.fn((command, args) =>
      command === 'npx' && args[1] === 'env' && args[2] === 'get'
        ? `${values[args[3]] ?? ''}\n`
        : '',
    )
  const identity = { QIVO_ENVIRONMENT: 'production', SITE_URL: 'https://qivo.io' }
  const built = (run) =>
    run.mock.calls.some(([command, args]) => command === 'npm' && args[1] === 'build')

  it('stops before npm run build when the backend lacks the mail settings', async () => {
    for (const values of [
      identity,
      { ...identity, LETTERMINT_API_KEY: 'test-only-token' },
      { ...identity, LETTERMINT_API_KEY: 'test-only-token', MAIL_FROM: 'Qivo <no-reply@qivo.io>' },
    ]) {
      const run = runner(values)
      const receipt = vi.fn()
      await expect(main(production, { run, receipt })).rejects.toThrow(
        /before releasing to production/,
      )
      expect(built(run)).toBe(false)
      expect(receipt).not.toHaveBeenCalled()
    }
  })

  /* crons.ts drops every job under QIVO_ENVIRONMENT=preview, so a stable
     backend set to it by mistake must never get this build's push. */
  it('stops before npm run build when the backend names another environment', async () => {
    const builds = [
      [production, 'preview'],
      [production, 'staging'],
      [production, ''],
      [{ ...production, QIVO_ENVIRONMENT: 'staging' }, 'preview'],
    ]
    for (const [build, backend] of builds) {
      const run = runner({ ...identity, QIVO_ENVIRONMENT: backend })
      await expect(main(build, { run, receipt: vi.fn() }), backend).rejects.toThrow(
        'Backend QIVO_ENVIRONMENT does not match the build.',
      )
      expect(built(run)).toBe(false)
    }
  })

  it('builds once the backend has them', async () => {
    const run = runner({
      ...identity,
      LETTERMINT_API_KEY: 'test-only-token',
      MAIL_FROM: 'no-reply@qivo.io',
    })
    const receipt = vi.fn()
    await main(production, { run, receipt })
    expect(built(run)).toBe(true)
    expect(receipt).toHaveBeenCalledWith(production)
  })

  /* an expiry on a stable backend would schedule its deletion, so neither
     the passed fetch nor the global one may run */
  it('sends no request at all from a production or staging build', async () => {
    const staging = {
      ...production,
      QIVO_ENVIRONMENT: 'staging',
      QIVO_APP_ORIGIN: 'https://preview.qivo.io',
    }
    for (const [build, values] of [
      [production, { ...identity, LETTERMINT_API_KEY: 'test-only-token', MAIL_FROM: 'a@qivo.io' }],
      [staging, { QIVO_ENVIRONMENT: 'staging', SITE_URL: 'https://preview.qivo.io' }],
    ]) {
      const fetch = vi.fn()
      const global = vi.fn()
      vi.stubGlobal('fetch', global)
      const run = runner(values)
      await main(build, { run, receipt: vi.fn(), fetch })
      vi.unstubAllGlobals()
      expect(built(run), build.QIVO_ENVIRONMENT).toBe(true)
      expect(fetch).not.toHaveBeenCalled()
      expect(global).not.toHaveBeenCalled()
    }
  })
})

/** A Management API stand-in that keeps the expiry each PATCH sets and
 * answers GET with it, the way Convex reads a deployment back. */
const managementApi = () => {
  let expiresAt = null
  return vi.fn(async (_url, init) => {
    if (init.method !== 'PATCH') return Response.json({ deploymentType: 'preview', expiresAt })
    expiresAt = JSON.parse(init.body).expiresAt
    return new Response(null, { status: 200 })
  })
}

describe('main — a preview build names the backend a preview before it pushes', () => {
  const preview = {
    QIVO_ENVIRONMENT: 'preview',
    CONVEX_DEPLOY_KEY: 'preview:fixture-team:qivo|test-only',
    VITE_CONVEX_URL: 'https://fixture-otter-12.convex.cloud',
    VERCEL_BRANCH_URL: 'qivo-git-x-fixture.vercel.app',
  }

  /* `convex deploy` runs this script as its --cmd and pushes the functions
     only after it returns, also on a branch's first build, and crons.ts
     registers no job when QIVO_ENVIRONMENT is preview at push time. */
  it('sets QIVO_ENVIRONMENT=preview on the claimed deployment before the build', async () => {
    const run = vi.fn(() => '')
    await main(preview, { run, receipt: vi.fn(), fetch: managementApi() })
    const commands = run.mock.calls.map(([command, args]) => [command, ...args].join(' '))
    const set = commands.indexOf(
      'npx convex env set QIVO_ENVIRONMENT preview --deployment fixture-otter-12',
    )
    expect(set).toBeGreaterThan(-1)
    expect(set).toBeLessThan(commands.indexOf('npm run build'))
  })

  it('sets the claimed deployment to expire before it configures or builds anything', async () => {
    const order = []
    const run = vi.fn((command, args) => {
      order.push([command, ...args.slice(0, 3)].join(' '))
      return ''
    })
    const api = managementApi()
    const fetch = vi.fn((url, init) => {
      order.push(`${init.method} ${url}`)
      return api(url, init)
    })
    await main(preview, { run, receipt: vi.fn(), fetch })
    expect(order.slice(0, 3)).toEqual([
      'PATCH https://api.convex.dev/v1/deployments/fixture-otter-12',
      'GET https://api.convex.dev/v1/deployments/fixture-otter-12',
      'npx convex env set',
    ])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('fails the build, before any command, when the expiry cannot be set', async () => {
    const run = vi.fn(() => '')
    const receipt = vi.fn()
    const fetch = vi.fn(async () => new Response(null, { status: 401 }))
    await expect(main(preview, { run, receipt, fetch, sleep: async () => {} })).rejects.toThrow(
      'Could not set the expiry of preview deployment fixture-otter-12 ' +
        '(HTTP 401, HTTP 401, HTTP 401, HTTP 401).',
    )
    expect(run).not.toHaveBeenCalled()
    expect(receipt).not.toHaveBeenCalled()
  })

  it('refuses a preview key whose build is not a preview', async () => {
    for (const environment of ['production', 'staging', undefined]) {
      const run = vi.fn(() => '')
      const fetch = vi.fn()
      await expect(
        main({ ...preview, QIVO_ENVIRONMENT: environment }, { run, fetch }),
      ).rejects.toThrow('Preview environment identity required.')
      expect(run).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    }
  })

  // the key would otherwise go to /v1/deployments/null
  it('refuses a deployment URL it cannot read before any request', async () => {
    for (const url of ['https://x-y-1.convex.site', undefined]) {
      const run = vi.fn(() => '')
      const fetch = vi.fn()
      await expect(
        main({ ...preview, VITE_CONVEX_URL: url }, { run, receipt: vi.fn(), fetch }),
      ).rejects.toThrow('cannot read a deployment name out of VITE_CONVEX_URL')
      expect(run).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    }
  })
})

describe('setPreviewExpiry — each push moves when the preview backend is deleted', () => {
  const key = 'preview:fixture-team:qivo|test-only-secret'
  const env = {
    CONVEX_DEPLOY_KEY: key,
    QIVO_ENVIRONMENT: 'preview',
    VITE_CONVEX_URL: 'https://fixture-otter-12.convex.cloud',
  }
  const url = 'https://api.convex.dev/v1/deployments/fixture-otter-12'
  const day = 24 * 60 * 60 * 1000
  const noWait = async () => {}
  afterEach(() => vi.restoreAllMocks())

  /** Every line the call prints, to check that the key is never among them. */
  const printed = () => {
    const lines = []
    for (const method of ['log', 'error', 'warn', 'info'])
      vi.spyOn(console, method).mockImplementation((...args) => lines.push(args.join(' ')))
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => lines.push(String(chunk)))
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => lines.push(String(chunk)))
    return lines
  }

  it('sends PATCH expiresAt, 3 days ahead, and reads it back, with the key only in the Authorization header', async () => {
    const lines = printed()
    const fetch = managementApi()
    const before = Date.now()
    await setPreviewExpiry(env, { fetch })
    const after = Date.now()
    expect(PREVIEW_LIFETIME_DAYS).toBe(3)
    const [[patchUrl, patch], [getUrl, get]] = fetch.mock.calls
    expect(fetch).toHaveBeenCalledTimes(2)
    expect([patchUrl, getUrl]).toEqual([url, url])
    expect(patch.method).toBe('PATCH')
    expect(patch.headers).toEqual({
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    })
    expect(get.method).toBe('GET')
    expect(get.headers).toEqual({ Authorization: `Bearer ${key}` })
    for (const init of [patch, get]) expect(init.signal).toBeInstanceOf(AbortSignal)
    const body = JSON.parse(patch.body)
    expect(Object.keys(body)).toEqual(['expiresAt'])
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 3 * day)
    expect(body.expiresAt).toBeLessThanOrEqual(after + 3 * day)
    expect(lines.join('\n')).toContain(
      `Preview deployment fixture-otter-12 expires at ${new Date(body.expiresAt).toISOString()}`,
    )
    expect(lines.join('\n')).not.toContain('test-only-secret')
  })

  it('uses the API host the CLI is pointed at', async () => {
    printed()
    const fetch = managementApi()
    await setPreviewExpiry({ ...env, CONVEX_PROVISION_HOST: 'http://127.0.0.1:9' }, { fetch })
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:9/v1/deployments/fixture-otter-12')
  })

  /* production, staging and the demo would be deleted on that date, so a
     stable build, or an edit that calls this outside the preview path,
     stops here without a request */
  it('refuses, before any request, anything but a branch preview build', async () => {
    const stable = [
      { ...env, CONVEX_DEPLOY_KEY: 'prod:fixture-otter-12|test-only-secret' },
      { ...env, CONVEX_DEPLOY_KEY: 'prod:demo-fixture-123|test-only-secret' },
      { ...env, CONVEX_DEPLOY_KEY: undefined },
      { ...env, QIVO_ENVIRONMENT: 'production' },
      { ...env, QIVO_ENVIRONMENT: 'staging' },
      { ...env, QIVO_ENVIRONMENT: 'demo' },
      { ...env, VITE_CONVEX_URL: 'https://fixture-otter-12.convex.site' },
      { ...env, QIVO_CONVEX_DEPLOYMENT: 'fixture-otter-12' },
      { ...env, DEMO_CONVEX_DEPLOYMENT: 'fixture-otter-12' },
    ]
    for (const build of stable) {
      const fetch = vi.fn()
      await expect(setPreviewExpiry(build, { fetch }), JSON.stringify(build)).rejects.toThrow(
        'Only a branch preview build may set its deployment to expire.',
      )
      expect(fetch).not.toHaveBeenCalled()
    }
  })

  it('retries a failure and succeeds once Convex reports the new date', async () => {
    printed()
    const api = managementApi()
    const answers = [
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.resolve(new Response('busy', { status: 503 })),
    ]
    const fetch = vi.fn((url, init) => (answers.length > 0 ? answers.shift()() : api(url, init)))
    // a newer push's build may set the expiry while this one waits
    let now = Date.UTC(2026, 9, 24, 12)
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const sleep = vi.fn(async (ms) => {
      now += ms
    })
    await setPreviewExpiry(env, { fetch, sleep })
    expect(sleep.mock.calls).toEqual([[1000], [2000]])
    const start = Date.UTC(2026, 9, 24, 12)
    const patches = fetch.mock.calls.filter(([, init]) => init.method === 'PATCH')
    expect(patches.map(([, init]) => JSON.parse(init.body).expiresAt)).toEqual([
      start + 3 * day,
      start + 1000 + 3 * day,
      start + 3000 + 3 * day,
    ])
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('gives up after 4 attempts naming each outcome, never the key or a body', async () => {
    const lines = printed()
    const accepted = () => Promise.resolve(new Response(null, { status: 200 }))
    const reading = (answer) => (_url, init) => (init.method === 'PATCH' ? accepted() : answer())
    for (const [answer, failure] of [
      [() => Promise.resolve(new Response(`echo ${key}`, { status: 403 })), 'HTTP 403'],
      [() => Promise.reject(new TypeError(`bad header Bearer ${key}`)), 'no response'],
      [
        reading(() => Promise.resolve(new Response(key, { status: 404 }))),
        'HTTP 404 reading it back',
      ],
      // the PATCH was taken but the deployment still holds Convex's own date
      [
        reading(() => Promise.resolve(Response.json({ expiresAt: 1 }))),
        'a different date read back',
      ],
      [
        reading(() => Promise.resolve(new Response(`not json ${key}`))),
        'a different date read back',
      ],
    ]) {
      const fetch = vi.fn(answer)
      const error = await setPreviewExpiry(env, { fetch, sleep: noWait }).catch((caught) => caught)
      expect(error.message).toBe(
        `Could not set the expiry of preview deployment fixture-otter-12 (${Array(4).fill(failure).join(', ')}).`,
      )
      expect(error.message).not.toContain('test-only-secret')
      expect(error.cause).toBeUndefined()
    }
    expect(lines.join('\n')).not.toContain('test-only-secret')
  })

  // a key or permission problem must not hide behind a last network blip
  it('names every attempt when the failures differ', async () => {
    const answers = [401, 401, 401].map(
      (status) => () => Promise.resolve(new Response(null, { status })),
    )
    answers.push(() => Promise.reject(new TypeError('fetch failed')))
    const fetch = vi.fn(() => answers.shift()())
    await expect(setPreviewExpiry(env, { fetch, sleep: noWait })).rejects.toThrow(
      '(HTTP 401, HTTP 401, HTTP 401, no response).',
    )
  })

  it('gives each request 15 seconds, then tries again', async () => {
    printed()
    const stalled = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(stalled.signal)
    const api = managementApi()
    const fetch = vi.fn((url, init) =>
      init.signal === stalled.signal
        ? // never answers, like an API that took the connection and stalled
          new Promise((_resolve, reject) =>
            init.signal.addEventListener('abort', () => reject(init.signal.reason)),
          )
        : api(url, init),
    )
    const done = setPreviewExpiry(env, { fetch, sleep: noWait })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    stalled.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    await done
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(timeout.mock.calls).toEqual([[15_000], [15_000], [15_000]])
  })
})

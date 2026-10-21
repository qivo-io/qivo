import { describe, expect, it, vi } from 'vitest'
import { address } from '../convex/lib/mailConfig'
import {
  deploymentName,
  ignoredTheTarget,
  isOneAddress,
  isPreviewDeployKey,
  main,
  previewSiteUrl,
  requireProductionBackendEnv,
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
      `${'a'.repeat(250)}@q.io`,
      `${'a'.repeat(249)}@q.io`,
    ]
    for (const s of samples) expect(isOneAddress(s), s).toBe(address(s) !== null)
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

  it('stops before npm run build when the backend lacks the mail settings', () => {
    for (const values of [
      identity,
      { ...identity, LETTERMINT_API_KEY: 'test-only-token' },
      { ...identity, LETTERMINT_API_KEY: 'test-only-token', MAIL_FROM: 'Qivo <no-reply@qivo.io>' },
    ]) {
      const run = runner(values)
      const receipt = vi.fn()
      expect(() => main(production, { run, receipt })).toThrow(/before releasing to production/)
      expect(built(run)).toBe(false)
      expect(receipt).not.toHaveBeenCalled()
    }
  })

  it('builds once the backend has them', () => {
    const run = runner({
      ...identity,
      LETTERMINT_API_KEY: 'test-only-token',
      MAIL_FROM: 'no-reply@qivo.io',
    })
    const receipt = vi.fn()
    main(production, { run, receipt })
    expect(built(run)).toBe(true)
    expect(receipt).toHaveBeenCalledWith(production)
  })
})

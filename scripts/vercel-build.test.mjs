import { describe, expect, it } from 'vitest'
import {
  deploymentName,
  ignoredTheTarget,
  isPreviewDeployKey,
  previewSiteUrl,
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

  it('is never a production origin, so the seed guard still bites on qivo.io', () => {
    const url = previewSiteUrl({
      VERCEL_BRANCH_URL: 'qivo-git-b-techqi.vercel.app',
    })
    expect(new URL(url).hostname.endsWith('qivo.io')).toBe(false)
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

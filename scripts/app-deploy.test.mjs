import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { assertAppTarget, deploy } from './app-deploy.mjs'

describe('backend deployment boundary', () => {
  const stable = {
    QIVO_ENVIRONMENT: 'staging',
    QIVO_APP_ORIGIN: 'https://preview.qivo.io',
    QIVO_CONVEX_DEPLOYMENT: 'fixture-cloud-123',
    CONVEX_DEPLOY_KEY: 'prod:fixture-cloud-123|test-only',
  }
  it('accepts an explicitly selected stable backend and rejects missing or conflicting identity', () => {
    expect(() => assertAppTarget(stable)).not.toThrow()
    for (const change of [
      { QIVO_ENVIRONMENT: undefined },
      { QIVO_ENVIRONMENT: 'development' },
      { QIVO_CONVEX_DEPLOYMENT: 'other-cloud-123' },
      { QIVO_CONVEX_DEPLOYMENT: undefined },
      { CONVEX_DEPLOY_KEY: 'prod:fixture-cloud-123|' },
      { CONVEX_DEPLOY_KEY: 'dev:fixture-cloud-123|test-only' },
      { QIVO_APP_ORIGIN: 'https://preview.qivo.io/path' },
      { QIVO_APP_ORIGIN: 'http://preview.qivo.io' },
    ])
      expect(() => assertAppTarget({ ...stable, ...change })).toThrow()
  })
  it('requires a preview key and preview environment to agree', () => {
    const preview = {
      QIVO_ENVIRONMENT: 'preview',
      CONVEX_DEPLOY_KEY: 'preview:team:project|test-only',
    }
    expect(() => assertAppTarget(preview)).not.toThrow()
    expect(() => assertAppTarget({ ...preview, QIVO_ENVIRONMENT: 'production' })).toThrow()
    expect(() => assertAppTarget({ ...stable, QIVO_ENVIRONMENT: 'preview' })).toThrow()
  })
})

const production = {
  QIVO_ENVIRONMENT: 'production',
  QIVO_APP_ORIGIN: 'https://qivo.io',
  QIVO_CONVEX_DEPLOYMENT: 'fixture-cloud-123',
  CONVEX_DEPLOY_KEY: 'prod:fixture-cloud-123|test-only',
}
const SITE = 'https://fixture-cloud-123.convex.site'

/* A `convex deploy` stand-in that records each step in `steps` and, as its
 * build command (vercel-build.mjs) does, records `site` for the probe, or
 * nothing when it is null. */
const convexDeploy = (steps, site = SITE) =>
  vi.fn((_command, _args, options) => {
    steps.push('convex deploy')
    if (site !== null) writeFileSync(options.env.QIVO_SITE_URL_FILE, `${site}\n`)
  })

describe('the deploy runs the build that guards production', () => {
  it('Vercel runs app-deploy.mjs, which deploys with vercel-build.mjs as the build command', async () => {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
    expect(vercel.buildCommand).toContain('node scripts/app-deploy.mjs')
    const run = convexDeploy([])
    await deploy(production, run, { probe: async () => {} })
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0].slice(0, 2)).toEqual([
      'npx',
      ['convex', 'deploy', '--cmd', 'node scripts/vercel-build.mjs'],
    ])
  })

  it('pushes nothing for a target it refuses', () => {
    const run = vi.fn()
    expect(() => deploy({ QIVO_ENVIRONMENT: 'production' }, run)).toThrow()
    expect(run).not.toHaveBeenCalled()
  })
})

describe('the deploy checks the auth routes after the push', () => {
  it('probes the sign-in, token and metadata routes at the site the build recorded', async () => {
    const steps = []
    const probe = vi.fn(async (site, options) => {
      steps.push(`probe ${site} demo ${options.demo}`)
    })
    await deploy(production, convexDeploy(steps), { probe })
    expect(steps).toEqual(['convex deploy', `probe ${SITE} demo false`])
  })

  it('fails the build when a route does not answer as expected', async () => {
    // a runtime that refuses the handlers' import of auth.ts
    const fetch = vi.fn(async () => new Response(null, { status: 500 }))
    await expect(
      deploy(production, convexDeploy([]), { fetch, sleep: async () => {}, log: () => {} }),
    ).rejects.toThrow(/auth routes did not answer as expected: GET \/api\/auth\/get-session/)
    expect(fetch.mock.calls[0][0]).toBe(`${SITE}/api/auth/get-session`)
  })

  it('fails the build when the build command recorded no site URL or a malformed one', async () => {
    for (const site of [null, 'http://fixture-cloud-123.convex.site'])
      await expect(
        deploy(production, convexDeploy([], site), { probe: vi.fn() }),
        String(site),
      ).rejects.toThrow(/Convex site URL/)
  })

  it('neither pushes nor probes for a target it refuses', () => {
    const run = vi.fn()
    const probe = vi.fn()
    expect(() =>
      deploy({ ...production, QIVO_APP_ORIGIN: 'http://qivo.io' }, run, { probe }),
    ).toThrow()
    expect(run).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })
})

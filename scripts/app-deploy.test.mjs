import { readFileSync } from 'node:fs'
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

describe('the deploy runs the build that guards production', () => {
  it('Vercel runs app-deploy.mjs, which deploys with vercel-build.mjs as the build command', () => {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
    expect(vercel.buildCommand).toContain('node scripts/app-deploy.mjs')
    const run = vi.fn()
    deploy(
      {
        QIVO_ENVIRONMENT: 'production',
        QIVO_APP_ORIGIN: 'https://qivo.io',
        QIVO_CONVEX_DEPLOYMENT: 'fixture-cloud-123',
        CONVEX_DEPLOY_KEY: 'prod:fixture-cloud-123|test-only',
      },
      run,
    )
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

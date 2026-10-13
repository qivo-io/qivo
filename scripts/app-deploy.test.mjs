import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertAppTarget } from './app-deploy.mjs'

describe('Node.js version', () => {
  const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))

  // Vercel and the workflows read engines.node. Convex reads convex.json and
  // otherwise runs Node actions on its own default, Node 20.
  it('runs the backend Node actions on the major version the app builds and tests with', () => {
    const engines = read('package.json').engines.node
    expect(engines).toMatch(/^\d+\.x$/)
    expect(read('convex.json').node.nodeVersion).toBe(engines.split('.')[0])
  })
})

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

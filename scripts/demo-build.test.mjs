import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { finishDemoBuild } from './demo-build.mjs'
import { assertDemoTarget } from './demo-deploy.mjs'

describe('dedicated demo deployment target', () => {
  const production = {
    VITE_APP_MODE: 'demo',
    DEMO_CONVEX_DEPLOYMENT: 'demo-fixture-123',
    CONVEX_DEPLOY_KEY: 'prod:demo-fixture-123|test-secret',
  }

  it('accepts only the explicitly named production deployment', () => {
    expect(() => assertDemoTarget(production)).not.toThrow()
    for (const key of [
      '',
      'prod:normal-fixture-123|test-secret',
      'dev:demo-fixture-123|test-secret',
      'project:team:demo|test-secret',
      'prod:demo-fixture-123',
    ]) {
      expect(() => assertDemoTarget({ ...production, CONVEX_DEPLOY_KEY: key })).toThrow()
    }
    expect(() => assertDemoTarget({ ...production, DEMO_CONVEX_DEPLOYMENT: undefined })).toThrow()
    expect(() => assertDemoTarget({ ...production, VITE_APP_MODE: undefined })).toThrow()
    expect(() => assertDemoTarget({ ...production, VITE_APP_MODE: 'normal' })).toThrow()
  })

  it('binds preview credentials to the configured demo team and project', () => {
    const preview = {
      VITE_APP_MODE: 'demo',
      DEMO_CONVEX_PROJECT: 'team:demo',
      CONVEX_DEPLOY_KEY: 'preview:team:demo|test-secret',
    }
    expect(() => assertDemoTarget(preview)).not.toThrow()
    for (const change of [
      { DEMO_CONVEX_PROJECT: 'team:normal' },
      { DEMO_CONVEX_PROJECT: undefined },
      { CONVEX_DEPLOY_KEY: 'preview:other-team:demo|test-secret' },
      { CONVEX_DEPLOY_KEY: 'preview:team:demo' },
    ])
      expect(() => assertDemoTarget({ ...preview, ...change })).toThrow()
  })
})

describe('demo build output', () => {
  const directories = []
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  it('hides operator entry, marks every page noindex and replaces agent guides', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qivo-demo-build-'))
    directories.push(directory)
    const page = (body) =>
      `<!doctype html><html><head><title>Qivo</title></head><body>${body}</body></html>`
    writeFileSync(join(directory, 'admin.html'), page('<p>Operator login</p>'))
    writeFileSync(
      join(directory, 'app.html'),
      page('<div id="root"></div><script type="module" src="/assets/app.js"></script>'),
    )
    for (const name of ['llms.txt', 'skill.md', 'auth.md'])
      writeFileSync(join(directory, name), 'Normal workspace credentials and OAuth instructions')
    finishDemoBuild(directory)
    const app = readFileSync(join(directory, 'app.html'), 'utf8')
    expect(readFileSync(join(directory, 'admin.html'), 'utf8')).toBe(app)
    expect(existsSync(join(directory, 'index.html'))).toBe(false)
    expect(app).toContain('src="/assets/app.js"')
    expect(app).not.toContain('Operator login')
    for (const file of ['app.html', 'admin.html'])
      expect(readFileSync(join(directory, file), 'utf8')).toContain(
        '<meta name="robots" content="noindex,nofollow">',
      )
    expect(readFileSync(join(directory, 'robots.txt'), 'utf8')).toBe('User-agent: *\nDisallow: /\n')
    for (const name of ['llms.txt', 'skill.md', 'auth.md']) {
      const guide = readFileSync(join(directory, name), 'utf8')
      expect(guide).toContain(
        'External agent connections, MCP, REST credentials and account registration are disabled.',
      )
      expect(guide).toContain('Each demo expires after 24 hours.')
      expect(guide).toContain('https://qivo.io/app#signup')
      expect(guide).not.toContain('Normal workspace credentials and OAuth instructions')
    }
  })
})

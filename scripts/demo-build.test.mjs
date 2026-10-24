import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { finishDemoBuild, main, WEBSITE_OUTPUT } from './demo-build.mjs'
import { assertDemoTarget } from './demo-deploy.mjs'

describe('dedicated demo deployment target', () => {
  const production = {
    QIVO_ENVIRONMENT: 'demo',
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
      QIVO_ENVIRONMENT: 'preview',
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
    const root = readFileSync(join(directory, 'index.html'), 'utf8')
    expect(root).toContain('content="0;url=/app"')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the page's own script holds this template literal
    expect(root).toContain('location.replace(`/app${location.search}${location.hash}`)')
    expect(root).toContain('<meta name="robots" content="noindex,nofollow">')
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

  it('refuses output that contains the website', () => {
    for (const name of WEBSITE_OUTPUT) {
      const directory = mkdtempSync(join(tmpdir(), 'qivo-demo-build-'))
      directories.push(directory)
      writeFileSync(join(directory, 'app.html'), '<html><head></head></html>')
      if (name.includes('.')) writeFileSync(join(directory, name), 'website')
      else mkdirSync(join(directory, name))
      expect(() => finishDemoBuild(directory), name).toThrow(/must not include the website/)
    }
  })
})

describe('main — a demo preview build names the backend a preview before it pushes', () => {
  const preview = {
    QIVO_ENVIRONMENT: 'preview',
    VITE_APP_MODE: 'demo',
    DEMO_CONVEX_PROJECT: 'team:demo',
    CONVEX_DEPLOY_KEY: 'preview:team:demo|test-only',
    VITE_CONVEX_URL: 'https://fixture-otter-12.convex.cloud',
    VERCEL_BRANCH_URL: 'qivo-demo-git-x-fixture.vercel.app',
  }

  /* `convex deploy` runs this script as its --cmd and pushes the functions
     only after it returns, and crons.ts registers no job when
     QIVO_ENVIRONMENT is preview at push time. */
  it('sets QIVO_ENVIRONMENT=preview on the claimed deployment before the build', async () => {
    const run = vi.fn(() => '')
    const fetch = vi.fn(async () => new Response(null, { status: 200 }))
    await main(preview, { run, finish: vi.fn(), receipt: vi.fn(), fetch })
    const commands = run.mock.calls.map(([command, args]) => [command, ...args].join(' '))
    const set = commands.indexOf(
      'npx convex env set QIVO_ENVIRONMENT preview --deployment fixture-otter-12',
    )
    expect(set).toBeGreaterThan(-1)
    expect(set).toBeLessThan(commands.indexOf('npm run build'))
    expect(fetch.mock.calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'PATCH https://api.convex.dev/v1/deployments/fixture-otter-12',
    ])
  })

  it('fails the build, before any command, when the expiry cannot be set', async () => {
    const run = vi.fn(() => '')
    const fetch = vi.fn(async () => new Response(null, { status: 500 }))
    await expect(
      main(preview, { run, finish: vi.fn(), receipt: vi.fn(), fetch, sleep: async () => {} }),
    ).rejects.toThrow('Could not set the expiry of preview deployment fixture-otter-12 (HTTP 500')
    expect(run).not.toHaveBeenCalled()
  })
})

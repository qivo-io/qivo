import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDemoSmokeOwnerJournal,
  demoSmokeCanvasRequestAllowed,
  demoSmokeConfiguration,
  demoSmokeRequestAllowed,
  demoSmokeSuppressedFontRequest,
  loadDemoSmokeCanvas,
  readDemoSmokeOwnerJournal,
} from './demo-smoke.mjs'

describe('isolated public-demo smoke target', () => {
  const target = {
    QIVO_DEMO_BASE_URL: 'http://localhost:5299',
    QIVO_DEMO_CONVEX_URL: 'https://demo-dev-fixture-123.convex.cloud',
    QIVO_DEMO_DEPLOY_KEY: 'dev:demo-dev-fixture-123|test-secret',
    QIVO_DEMO_CANVAS_FEED_URL: 'https://api.qivo.io/public/canvas',
  }

  it('accepts an explicit localhost origin and matching development deployment key', () => {
    expect(demoSmokeConfiguration(target)).toMatchObject({
      base: target.QIVO_DEMO_BASE_URL,
      browserBase: target.QIVO_DEMO_BASE_URL,
      local: false,
      url: target.QIVO_DEMO_CONVEX_URL,
      site: 'https://demo-dev-fixture-123.convex.site',
      canvasFeed: target.QIVO_DEMO_CANVAS_FEED_URL,
    })
  })

  it('never falls back to the existing app deployment environment', () => {
    expect(() =>
      demoSmokeConfiguration({
        CONVEX_DEPLOY_KEY: target.QIVO_DEMO_DEPLOY_KEY,
        VITE_CONVEX_URL: target.QIVO_DEMO_CONVEX_URL,
        CONVEX_DEPLOYMENT: 'dev:demo-dev-fixture-123',
      }),
    ).toThrow(/dedicated/)
  })

  it('requires an explicit opt-in, key and both loopback endpoints for a local backend', () => {
    const local = {
      QIVO_DEMO_LOCAL: 'true',
      QIVO_DEMO_BASE_URL: 'http://localhost:5200',
      QIVO_DEMO_CONVEX_URL: 'http://127.0.0.1:3210',
      QIVO_DEMO_CONVEX_SITE_URL: 'http://127.0.0.1:3211',
      QIVO_DEMO_DEPLOY_KEY: 'local-verification-key',
      QIVO_DEMO_CANVAS_FEED_URL: target.QIVO_DEMO_CANVAS_FEED_URL,
    }
    expect(demoSmokeConfiguration(local)).toMatchObject({
      browserBase: local.QIVO_DEMO_BASE_URL,
      local: true,
      url: local.QIVO_DEMO_CONVEX_URL,
      site: local.QIVO_DEMO_CONVEX_SITE_URL,
    })
    for (const change of [
      { QIVO_DEMO_LOCAL: undefined },
      { QIVO_DEMO_DEPLOY_KEY: undefined },
      { QIVO_DEMO_CONVEX_SITE_URL: undefined },
      { QIVO_DEMO_CONVEX_URL: 'https://normal-fixture-123.convex.cloud' },
      { QIVO_DEMO_CONVEX_SITE_URL: 'https://demo.qivo.io' },
      { QIVO_DEMO_DEPLOY_KEY: 'prod:normal-fixture-123|test-secret' },
    ])
      expect(() => demoSmokeConfiguration({ ...local, ...change })).toThrow()
  })

  it('keeps the backend site guard unchanged while the browser visits a forwarded port', () => {
    const config = demoSmokeConfiguration({
      QIVO_DEMO_LOCAL: 'true',
      QIVO_DEMO_BASE_URL: 'http://localhost:5200',
      QIVO_DEMO_BROWSER_URL: 'http://localhost:58955',
      QIVO_DEMO_CONVEX_URL: 'http://127.0.0.1:3210',
      QIVO_DEMO_CONVEX_SITE_URL: 'http://127.0.0.1:3211',
      QIVO_DEMO_DEPLOY_KEY: 'local-verification-key',
      QIVO_DEMO_CANVAS_FEED_URL: target.QIVO_DEMO_CANVAS_FEED_URL,
    })
    expect(config.base).toBe('http://localhost:5200')
    expect(config.browserBase).toBe('http://localhost:58955')
    for (const url of [
      'http://localhost:58955/',
      'http://localhost:58955/__qivo_http/api/auth/sign-in/anonymous',
      'http://localhost:58955/__qivo_http/files/private?e=123&t=signature',
      'ws://localhost:58955/__qivo_convex/api/1.45.0/sync',
      'ws://localhost:58955/?token=vite-development',
    ])
      expect(demoSmokeRequestAllowed(config, url), url).toBe(true)
    for (const url of [
      'http://localhost:5200/',
      'http://127.0.0.1:3210/api/query',
      'http://127.0.0.1:3211/api/auth/sign-in/anonymous',
      'ws://127.0.0.1:3210/api/1.45.0/sync',
      'ws://localhost:3210/api/1.45.0/sync',
      'http://127.0.0.1:58955/',
      'https://foreign.example/',
      'http://user:secret@localhost:58955/',
    ])
      expect(demoSmokeRequestAllowed(config, url), url).toBe(false)
  })

  it('preserves direct cloud HTTP and WebSocket access for the selected deployment', () => {
    const config = demoSmokeConfiguration(target)
    for (const url of [
      `${config.base}/`,
      `${config.url}/api/query`,
      `${config.site}/api/auth/get-session`,
      'wss://demo-dev-fixture-123.convex.cloud/api/1.45.0/sync',
    ])
      expect(demoSmokeRequestAllowed(config, url), url).toBe(true)
    for (const url of [
      'https://normal-fixture-123.convex.cloud/api/query',
      'wss://normal-fixture-123.convex.cloud/api/1.45.0/sync',
      'http://127.0.0.1:3210/',
    ])
      expect(demoSmokeRequestAllowed(config, url), url).toBe(false)
  })

  it('keeps known Google Fonts requests blocked while excluding their suppression from failures', () => {
    const config = demoSmokeConfiguration(target)
    for (const url of [
      'https://fonts.googleapis.com/css2?family=Inter&display=swap',
      'https://fonts.gstatic.com/s/inter/v18/example.woff2',
    ]) {
      expect(demoSmokeRequestAllowed(config, url), url).toBe(false)
      expect(demoSmokeSuppressedFontRequest(url, 'GET'), url).toBe(true)
      expect(demoSmokeSuppressedFontRequest(url, 'POST'), url).toBe(false)
    }
    for (const url of [
      'http://127.0.0.1:3211/api/auth/get-session',
      'http://localhost:3210/api/query',
      'https://fonts.googleapis.com/other',
      'https://fonts.gstatic.com/api/auth/get-session',
      'https://fonts.googleapis.com.evil.test/css2',
      'https://fonts.googleapis.com@foreign.example/css2',
      'http://fonts.googleapis.com/css2',
      'wss://fonts.googleapis.com/css2',
    ])
      expect(demoSmokeSuppressedFontRequest(url, 'GET'), url).toBe(false)
  })

  it('refuses production, mismatched and malformed keys before any browser or network work', () => {
    for (const key of [
      'prod:demo-dev-fixture-123|test-secret',
      'dev:normal-fixture-123|test-secret',
      'preview:team:demo|test-secret',
      'dev:demo-dev-fixture-123',
      'dev:demo-dev-fixture-123|',
      '',
    ])
      expect(() => demoSmokeConfiguration({ ...target, QIVO_DEMO_DEPLOY_KEY: key })).toThrow()
  })

  it('refuses non-local app origins and URLs carrying credentials, paths or query state', () => {
    for (const base of [
      'https://demo.qivo.io',
      'https://qivo.io',
      'https://preview.vercel.app',
      'http://localhost:5299/app',
      'http://localhost:5299?override=1',
      'http://localhost:5299#signup',
      'http://user:secret@localhost:5299',
    ]) {
      for (const name of ['QIVO_DEMO_BASE_URL', 'QIVO_DEMO_BROWSER_URL'])
        expect(() => demoSmokeConfiguration({ ...target, [name]: base })).toThrow(/localhost/)
    }
  })

  it('requires the explicit public Canvas endpoint without broad normal-backend access', () => {
    for (const feed of [
      'https://api.qivo.io/public/canvas',
      'https://normal-fixture-123.convex.site/public/canvas',
      'http://localhost:3211/public/canvas',
    ])
      expect(
        demoSmokeConfiguration({ ...target, QIVO_DEMO_CANVAS_FEED_URL: feed }).canvasFeed,
      ).toBe(feed)
    for (const feed of [
      undefined,
      'https://api.qivo.io/',
      'https://api.qivo.io/api/query',
      'https://api.qivo.io/public/canvas?date=2026-09-14',
      'https://api.qivo.io/public/canvas#fragment',
      'https://user:secret@api.qivo.io/public/canvas',
      'http://api.qivo.io/public/canvas',
    ])
      expect(() =>
        demoSmokeConfiguration({
          ...target,
          QIVO_DEMO_CANVAS_FEED_URL: feed,
          VITE_DEMO_CANVAS_FEED_URL: target.QIVO_DEMO_CANVAS_FEED_URL,
        }),
      ).toThrow(/QIVO_DEMO_CANVAS_FEED_URL/)
  })
})

describe('interrupted demo cleanup ownership journal', () => {
  const folders = []
  const folder = () => {
    const directory = mkdtempSync(join(tmpdir(), 'qivo-demo-owner-journal-'))
    folders.push(directory)
    return directory
  }
  afterEach(() => {
    for (const directory of folders.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('persists only captured IDs privately and keeps the org ID when auth-only recovery repeats', () => {
    const directory = folder()
    const journal = createDemoSmokeOwnerJournal(directory)
    journal.record({ authUserId: 'visitor-a', orgId: 'private-org-a', token: 'must-not-store' })
    journal.record({ authUserId: 'visitor-b', password: 'must-not-store' })
    journal.record({ authUserId: 'visitor-a' })
    journal.record({ authUserId: 'visitor-a', orgId: null })
    expect(statSync(journal.file).mode & 0o777).toBe(0o600)
    expect(readFileSync(journal.file, 'utf8')).not.toContain('must-not-store')
    expect(readDemoSmokeOwnerJournal(journal.file, directory)).toEqual([
      { authUserId: 'visitor-a', orgId: 'private-org-a' },
      { authUserId: 'visitor-b' },
    ])
    expect(existsSync(`${journal.file}.tmp`)).toBe(false)
    journal.remove()
    expect(existsSync(journal.file)).toBe(false)
  })

  it('refuses foreign paths, symlinks and invalid ownership entries on cleanup resume', () => {
    const directory = folder()
    const other = folder()
    const journal = createDemoSmokeOwnerJournal(directory)
    journal.record({ authUserId: 'visitor-a' })
    expect(() => readDemoSmokeOwnerJournal(journal.file, other)).toThrow(/inside/)
    const link = join(other, basename(journal.file))
    symlinkSync(journal.file, link)
    expect(() => readDemoSmokeOwnerJournal(link, other)).toThrow(/regular local file/)
    writeFileSync(journal.file, JSON.stringify({ owners: [{ authUserId: null }] }))
    expect(() => readDemoSmokeOwnerJournal(journal.file, directory)).toThrow(/auth identity/)
  })
})

describe('approved Canvas photo boundary', () => {
  const config = {
    local: true,
    browserBase: 'http://localhost:58955',
    canvasFeed: 'https://normal-fixture-123.convex.site/public/canvas',
  }
  const image = {
    id: 'approved-photo',
    image_url: 'https://normal-fixture-123.convex.cloud/api/storage/approved-full',
    preview_url: 'https://normal-fixture-123.convex.cloud/api/storage/approved-preview',
  }
  const date = '2026-09-14'
  const canvas = { date, imageId: image.id, imageUrls: [image.image_url, image.preview_url] }

  it('prefetches one approved UTC-date selection without credentials or redirects', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => image }))
    expect(await loadDemoSmokeCanvas(config, fetcher, date)).toEqual(canvas)
    expect(fetcher).toHaveBeenCalledWith(
      `${config.canvasFeed}?date=${date}`,
      expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
    )
  })

  it('refuses unavailable, missing or unsafe photos before browser identity allocation', async () => {
    const unavailable = vi.fn(async () => ({ ok: false }))
    await expect(loadDemoSmokeCanvas(config, unavailable, date)).rejects.toThrow(/successfully/)
    for (const value of [
      null,
      { ...image, image_url: null },
      { ...image, image_url: 'https://user:secret@normal-fixture-123.convex.cloud/private' },
      { ...image, preview_url: 'http://external.example/private' },
      { ...image, preview_url: 'https://normal-fixture-123.convex.cloud/private#fragment' },
    ]) {
      const fetcher = async () => ({ ok: true, json: async () => value })
      await expect(loadDemoSmokeCanvas(config, fetcher, date)).rejects.toThrow()
    }
    const invalidDate = vi.fn()
    await expect(loadDemoSmokeCanvas(config, invalidDate, '2026-02-30')).rejects.toThrow(/UTC date/)
    expect(invalidDate).not.toHaveBeenCalled()
  })

  it('allows only GET of the pinned feed date and exact approved full/preview URLs', () => {
    for (const url of [`${config.canvasFeed}?date=${date}`, image.image_url, image.preview_url]) {
      expect(demoSmokeCanvasRequestAllowed(config, url, 'GET', canvas), url).toBe(true)
      expect(demoSmokeRequestAllowed(config, url, 'GET', canvas), url).toBe(true)
      for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'])
        expect(demoSmokeRequestAllowed(config, url, method, canvas), `${method} ${url}`).toBe(false)
    }
  })

  it('keeps other normal deployment HTTP and WebSockets outside the boundary', () => {
    for (const url of [
      config.canvasFeed,
      `${config.canvasFeed}?date=2026-02-30`,
      `${config.canvasFeed}?date=2026-09-15`,
      `${config.canvasFeed}?date=${date}&date=${date}`,
      `${config.canvasFeed}?date=${date}&org_id=private`,
      `${config.canvasFeed}?date=${date}#fragment`,
      'https://normal-fixture-123.convex.site/api/auth/get-session',
      'https://normal-fixture-123.convex.cloud/api/query',
      'https://normal-fixture-123.convex.cloud/api/storage/unapproved-photo',
      `${image.image_url}?extra=1`,
      `${image.preview_url}/other`,
      image.image_url.replace('https:', 'wss:'),
      'wss://normal-fixture-123.convex.cloud/api/1.45.0/sync',
      'https://user:secret@normal-fixture-123.convex.cloud/api/storage/approved-full',
    ])
      expect(demoSmokeRequestAllowed(config, url, 'GET', canvas), url).toBe(false)
    expect(demoSmokeRequestAllowed(config, image.image_url, 'GET', null)).toBe(false)
  })
})

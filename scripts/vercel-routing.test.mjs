import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/* Route fixtures for vercel.json. Vercel's documented order is redirects,
 * then headers, then files in the deployment, then rewrites in array order.
 * A directory path serves its index.html. Sources here use only literal paths
 * and `(regex)` or `:name(regex)` groups, which @vercel/routing-utils compiles
 * to the same regular expression with each group as a capture (checked
 * against routing-utils 6.6.0: `/app/:path(.*)` becomes `^/app(?:/(.*))$`).
 * Any other syntax fails this test instead of being guessed. Host conditions
 * use only `{ inc: [...] }`, Vercel's exact-membership operator, never a
 * regular expression or suffix. */
const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
const STAGING_HOST = 'preview.qivo.io'
const DEMO_HOST = 'demo.qivo.io'
const FONT = '/marketing/fonts/manrope-normal-latin.a30ddcd3.woff2'

/** Files `vite build` writes, plus the demo visitor function. */
const APP_FILES = [
  '/app.html',
  '/admin.html',
  '/assets/index-abc123.js',
  '/version.json',
  '/llms.txt',
  '/skill.md',
  '/auth.md',
  '/favicon.svg',
  '/api/demo-visitor',
]
/** Files website/scripts/build.mjs adds. The demo build has none of them. */
const WEBSITE_FILES = [
  '/index.html',
  '/docs/index.html',
  '/docs/the-board/index.html',
  '/pricing/index.html',
  '/sitemap.xml',
  '/robots.txt',
  '/marketing/home.js',
  '/marketing/nav.js',
  FONT,
  '/.well-known/microsoft-identity-association.json',
]
const DEPLOYMENT = new Set([...APP_FILES, ...WEBSITE_FILES])
/** The demo build adds only a root page that sends visitors to /app. */
const DEMO_DEPLOYMENT = new Set([...APP_FILES, '/index.html'])

function compile(source) {
  let pattern = ''
  for (const part of source.split(/((?::[a-z]+)?\([^)]*\))/i)) {
    const group = /^(?::[a-z]+)?\(([^)]*)\)$/i.exec(part)
    if (group) pattern += `(${group[1]})`
    else if (/^[/a-z0-9._-]*$/i.test(part)) pattern += part.replace(/\./g, '\\.')
    else throw new Error(`Unsupported source syntax in vercel.json: ${source}`)
  }
  return new RegExp(`^${pattern}$`)
}

function hostCondition(conditions = [], host) {
  return conditions.map((condition) => {
    const values = condition.value?.inc
    if (
      condition.type !== 'host' ||
      !Array.isArray(values) ||
      Object.keys(condition.value).length !== 1
    )
      throw new Error(`Only exact host lists are allowed: ${JSON.stringify(condition)}`)
    return values.includes(host)
  })
}

const applies = (rule, host) =>
  hostCondition(rule.has, host).every(Boolean) && !hostCondition(rule.missing, host).some(Boolean)

/** The deployed file a path serves, including a directory's index.html. */
function file(files, path) {
  for (const candidate of [path, `${path}index.html`, `${path}/index.html`])
    if (files.has(candidate)) return candidate
  return null
}

/** Resolve one request the way the configured phases do. */
function route(vercel, host, path, files = DEPLOYMENT) {
  for (const rule of vercel.redirects || []) {
    if (compile(rule.source).test(path) && applies(rule, host))
      return { status: rule.permanent ? 308 : 307, location: rule.destination }
  }
  const headers = {}
  for (const rule of vercel.headers || []) {
    if (!compile(rule.source).test(path) || !applies(rule, host)) continue
    for (const { key, value } of rule.headers) headers[key.toLowerCase()] = value
  }
  const served = file(files, path)
  if (served) return { file: served, headers }
  for (const rule of vercel.rewrites || []) {
    const match = compile(rule.source).exec(path)
    if (!match || !applies(rule, host)) continue
    const destination = rule.destination.replace(/:[a-z]+/i, () => match[1] ?? '')
    return { file: destination, headers }
  }
  return { status: 404, headers }
}

const WEBSITE_PATHS = {
  '/': '/index.html',
  '/docs/': '/docs/index.html',
  '/docs/the-board/': '/docs/the-board/index.html',
  '/docs/the-board': '/docs/the-board/index.html',
  '/pricing/': '/pricing/index.html',
  '/pricing': '/pricing/index.html',
  '/sitemap.xml': '/sitemap.xml',
  '/robots.txt': '/robots.txt',
  '/marketing/home.js': '/marketing/home.js',
}
const APP_PATHS = {
  '/app': '/app.html',
  '/app/': '/app.html',
  '/app/acme/board/all': '/app.html',
  '/app/acme/board/': '/app.html',
  '/admin': '/admin.html',
  '/admin/': '/admin.html',
}
const HOSTS = [
  'qivo.io',
  'www.qivo.io',
  STAGING_HOST,
  'qivo-git-branch-team.vercel.app',
  'qivo-app.example',
  'evilqivo.io',
]

describe('one deployment serves the website and the application', () => {
  it.each(HOSTS)('serves website pages, app routes and deployed files on %s', (host) => {
    for (const [path, served] of Object.entries(WEBSITE_PATHS))
      expect(route(config, host, path).file, path).toBe(served)
    for (const [path, served] of Object.entries(APP_PATHS))
      expect(route(config, host, path).file, path).toBe(served)
    for (const path of DEPLOYMENT) expect(route(config, host, path).file, path).toBe(path)
    expect(route(config, host, '/missing-page').status).toBe(404)
  })

  it('keeps the staging host out of search indexes, website pages included', () => {
    for (const path of [...Object.keys(WEBSITE_PATHS), ...Object.keys(APP_PATHS)])
      expect(route(config, STAGING_HOST, path).headers['x-robots-tag'], path).toBe(
        'noindex, nofollow',
      )
    for (const host of ['evilpreview.qivo.io', 'preview.qivo.io.evil.test'])
      expect(route(config, host, '/').headers['x-robots-tag']).toBeUndefined()
  })

  it('lets browsers keep hashed website fonts and revalidate everything else', () => {
    expect(route(config, 'qivo.io', FONT).headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    )
    for (const path of [
      '/marketing/fonts/manrope-OFL.txt',
      '/marketing/fonts/manrope-normal-latin.woff2',
      '/marketing/home.js',
      '/',
      '/docs/',
    ])
      expect(route(config, 'qivo.io', path).headers['cache-control'], path).toBeUndefined()
  })
})

describe('public demo', () => {
  it('sends the root to the app and serves no website pages', () => {
    expect(route(config, DEMO_HOST, '/', DEMO_DEPLOYMENT)).toEqual({
      status: 307,
      location: '/app',
    })
    // Demo branch previews have other hosts and get the demo build's forwarding page.
    expect(route(config, 'qivo-demo-git-x-techqi.vercel.app', '/', DEMO_DEPLOYMENT).file).toBe(
      '/index.html',
    )
    for (const path of ['/docs/', '/pricing/', '/sitemap.xml'])
      expect(route(config, DEMO_HOST, path, DEMO_DEPLOYMENT).status, path).toBe(404)
    for (const [path, served] of Object.entries(APP_PATHS))
      expect(route(config, DEMO_HOST, path, DEMO_DEPLOYMENT).file, path).toBe(served)
  })

  it('serves the demo visitor function and keeps demo noindex headers', () => {
    const result = route(config, DEMO_HOST, '/api/demo-visitor', DEMO_DEPLOYMENT)
    expect(result.file).toBe('/api/demo-visitor')
    expect(result.headers['x-robots-tag']).toBe('noindex, nofollow')
    expect(result.headers['cache-control']).toBe('no-store')
  })
})

describe('security headers', () => {
  it.each([...HOSTS, DEMO_HOST])('protect app and operator pages on %s', (host) => {
    for (const path of [...Object.keys(APP_PATHS), '/app.html', '/admin.html']) {
      const { headers } = route(config, host, path)
      expect(headers['x-frame-options'], path).toBe('DENY')
      expect(headers['content-security-policy'], path).toBe("frame-ancestors 'none'")
      expect(headers['cache-control'], path).toBe('no-store')
    }
    expect(route(config, host, '/assets/index-abc123.js').headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    )
  })
})

describe('route fixtures detect unsafe edits', () => {
  const edited = (change) => {
    const copy = structuredClone(config)
    change(copy)
    return copy
  }

  it('fails if the demo root redirect reaches other hosts', () => {
    const copy = edited((c) => delete c.redirects[0].has)
    expect(route(copy, 'qivo.io', '/').status).toBe(307)
  })

  it('fails if the app rewrites are dropped', () => {
    const copy = edited((c) => {
      c.rewrites = []
    })
    expect(route(copy, 'qivo.io', '/app/acme/board/all').status).toBe(404)
  })

  it('fails with the old strict wildcard that rejects trailing slashes', () => {
    expect(() => compile('/app/:path*')).toThrow(/Unsupported/)
  })

  it('rejects regular-expression or suffix host conditions', () => {
    for (const value of ['qivo.io', { suf: 'qivo.io' }, { re: '.*qivo\\.io' }])
      expect(() => hostCondition([{ type: 'host', value }], 'qivo.io')).toThrow(/exact host/)
  })

  it('never sends a request to another origin', () => {
    for (const rule of [...config.redirects, ...config.rewrites])
      expect(rule.destination, rule.source).toMatch(/^\/[^/]/)
    expect(JSON.stringify(config)).not.toMatch(/vercel\.app|site-origin|site-preview/)
  })
})

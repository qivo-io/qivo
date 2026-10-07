import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/* Route fixtures for vercel.json. Vercel's documented order is redirects,
 * then headers, then files in the deployment, then rewrites in array order.
 * Sources here use only literal paths and `(regex)` or `:name(regex)` groups,
 * which @vercel/routing-utils compiles to the same regular expression with
 * each group as a capture (checked against routing-utils 6.6.0:
 * `/app/:path(.*)` becomes `^/app(?:/(.*))$`). Any other syntax fails this
 * test instead of being guessed. Host conditions use only `{ inc: [...] }`,
 * Vercel's exact-membership operator, never a regular expression or suffix. */
const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
const WEBSITE = 'https://site-origin.qivo.io'
const WEBSITE_HOSTS = ['qivo.io', 'www.qivo.io']
const STAGING_HOST = 'preview.qivo.io'

/** Files in a normal app deployment, plus the demo visitor function. */
const FILES = new Set([
  '/app.html',
  '/admin.html',
  '/assets/index-abc123.js',
  '/version.json',
  '/llms.txt',
  '/skill.md',
  '/auth.md',
  '/favicon.svg',
  '/api/demo-visitor',
])

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

/** Resolve one request the way the configured phases do. */
function route(vercel, host, path) {
  for (const rule of vercel.redirects || []) {
    if (compile(rule.source).test(path) && applies(rule, host))
      return { status: rule.permanent ? 308 : 307, location: rule.destination }
  }
  const headers = {}
  for (const rule of vercel.headers || []) {
    if (!compile(rule.source).test(path) || !applies(rule, host)) continue
    for (const { key, value } of rule.headers) headers[key.toLowerCase()] = value
  }
  if (FILES.has(path)) return { file: path, headers }
  for (const rule of vercel.rewrites || []) {
    const match = compile(rule.source).exec(path)
    if (!match || !applies(rule, host)) continue
    const destination = rule.destination.replace(/:[a-z]+/i, () => match[1] ?? '')
    return destination.startsWith('https://')
      ? { proxy: destination, headers }
      : { file: destination, headers }
  }
  return { status: 404, headers }
}

const WEBSITE_PATHS = [
  '/',
  '/docs/',
  '/docs/the-board/',
  '/pricing/',
  '/pricing',
  '/sitemap.xml',
  '/robots.txt',
  '/marketing/home.js',
  '/marketing/fonts/manrope-normal-latin.woff2',
  '/site-version.json',
  '/missing-page',
]
const APP_PATHS = {
  '/app': '/app.html',
  '/app/': '/app.html',
  '/app/acme/board/all': '/app.html',
  '/app/acme/board/': '/app.html',
  '/admin': '/admin.html',
  '/admin/': '/admin.html',
}
const OTHER_HOSTS = [
  'demo.qivo.io',
  'qivo-app.example',
  'qivo-git-branch-team.vercel.app',
  'site-origin.qivo.io',
  'evilqivo.io',
  'qivo.io.evil.test',
  'app.qivo.io',
]

describe('production website hosts', () => {
  it.each(WEBSITE_HOSTS)('proxies website paths on %s without caching', (host) => {
    for (const path of WEBSITE_PATHS) {
      const result = route(config, host, path)
      expect(result.proxy, path).toBe(`${WEBSITE}${path}`)
      expect(result.headers['x-vercel-enable-rewrite-caching'], path).toBe('0')
    }
  })

  it.each(WEBSITE_HOSTS)('keeps app routes and deployed files on %s', (host) => {
    for (const [path, file] of Object.entries(APP_PATHS))
      expect(route(config, host, path).file, path).toBe(file)
    for (const path of FILES) expect(route(config, host, path).file, path).toBe(path)
  })
})

describe('persistent staging website', () => {
  it('uses the authenticated proxy only on the exact staging hostname', () => {
    for (const path of WEBSITE_PATHS) {
      const result = route(config, STAGING_HOST, path)
      expect(result.file).toBe(`/api/website?__qivo_path=${path.slice(1)}`)
      expect(result.headers['x-robots-tag']).toBe('noindex, nofollow')
      expect(result.headers['x-vercel-enable-rewrite-caching']).toBe('0')
    }
    for (const [path, file] of Object.entries(APP_PATHS))
      expect(route(config, STAGING_HOST, path).file).toBe(file)
    for (const path of FILES) expect(route(config, STAGING_HOST, path).file).toBe(path)
    for (const host of ['evilpreview.qivo.io', 'preview.qivo.io.evil.test'])
      expect(route(config, host, '/docs/')).toEqual({ status: 404, headers: {} })
  })
})

describe('self-hosted, demo and branch preview hosts', () => {
  it.each(OTHER_HOSTS)('redirects the root of %s to the app and never proxies', (host) => {
    expect(route(config, host, '/')).toEqual({ status: 307, location: '/app' })
    for (const path of WEBSITE_PATHS.slice(1)) {
      const result = route(config, host, path)
      expect(result.proxy, path).toBeUndefined()
      expect(result.headers['x-vercel-enable-rewrite-caching'], path).toBeUndefined()
    }
    for (const [path, file] of Object.entries(APP_PATHS))
      expect(route(config, host, path).file, path).toBe(file)
  })

  it('serves the demo visitor function and keeps demo noindex headers', () => {
    const result = route(config, 'demo.qivo.io', '/api/demo-visitor')
    expect(result.file).toBe('/api/demo-visitor')
    expect(result.headers['x-robots-tag']).toBe('noindex, nofollow')
  })
})

describe('security headers', () => {
  it.each([...WEBSITE_HOSTS, STAGING_HOST, ...OTHER_HOSTS])(
    'protect app and operator pages on %s',
    (host) => {
      for (const path of [...Object.keys(APP_PATHS), '/app.html', '/admin.html']) {
        const { headers } = route(config, host, path)
        expect(headers['x-frame-options'], path).toBe('DENY')
        expect(headers['content-security-policy'], path).toBe("frame-ancestors 'none'")
        expect(headers['cache-control'], path).toBe('no-store')
      }
      expect(route(config, host, '/assets/index-abc123.js').headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      )
    },
  )
})

describe('route fixtures detect unsafe edits', () => {
  const edited = (change) => {
    const copy = structuredClone(config)
    change(copy)
    return copy
  }
  const proxyIndex = config.rewrites.findIndex((rule) => rule.destination.startsWith('https://'))

  it('fails if the website hosts are dropped from the root redirect', () => {
    const copy = edited((c) => delete c.redirects[0].missing)
    expect(route(copy, 'qivo.io', '/').status).toBe(307)
  })

  it('fails if the proxy is not limited to the website hosts', () => {
    const copy = edited((c) => {
      c.rewrites[proxyIndex].missing = c.rewrites[proxyIndex].has
      delete c.rewrites[proxyIndex].has
    })
    expect(route(copy, 'demo.qivo.io', '/docs/').proxy).toBeDefined()
  })

  it('fails if the proxy runs before the app rewrites', () => {
    const copy = edited((c) => c.rewrites.unshift(c.rewrites.splice(proxyIndex, 1)[0]))
    expect(route(copy, 'qivo.io', '/app/').proxy).toBeDefined()
  })

  it('fails with the old strict wildcard that rejects trailing slashes', () => {
    expect(() => compile('/app/:path*')).toThrow(/Unsupported/)
  })

  it('rejects regular-expression or suffix host conditions', () => {
    for (const value of ['qivo.io', { suf: 'qivo.io' }, { re: '.*qivo\\.io' }])
      expect(() => hostCondition([{ type: 'host', value }], 'qivo.io')).toThrow(/exact host/)
  })

  it('proxies only to the stable website origin', () => {
    const destinations = config.rewrites.map((rule) => rule.destination)
    expect(destinations.filter((d) => d.startsWith('http'))).toEqual([`${WEBSITE}/:path`])
    expect(JSON.stringify(config)).not.toMatch(/vercel\.app/)
  })
})

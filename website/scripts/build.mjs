#!/usr/bin/env node
/* Build the qivo.io website into dist/, next to the application `vite build`
 * wrote there. `npm run build` runs it after Vite. It:
 *
 * 1. renders /docs/, /pricing/ and /sitemap.xml from docs/guide;
 * 2. injects the shared stylesheet and font preloads into the homepage;
 * 3. copies only the named website assets below;
 * 4. asks search engines to skip everything outside production;
 * 5. refuses to replace an application file, to write under /assets/, to
 *    publish a page that loads anything from another origin, or to publish
 *    text that looks like a credential.
 *
 * The demo build skips it, because demo.qivo.io serves only the application.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as buildPages } from '../site/pages.mjs'
import { CSS, FONT_PRELOADS, FONTS, ORIGIN } from '../site/theme.mjs'

/** The website directory. Asset sources below are relative to it. */
export const ROOT = fileURLToPath(new URL('../', import.meta.url))
const REPOSITORY = resolve(ROOT, '..')

/** Every file copied from the website source, by its published path. The
    fonts are published under the content-hashed names from FONTS. The app's
    public/ directory already provides favicon.svg and the agent guides. */
export const ASSETS = {
  '.well-known/microsoft-identity-association.json':
    'public/.well-known/microsoft-identity-association.json',
  'robots.txt': 'public/robots.txt',
  'marketing/home.js': 'site/home.mjs',
  'marketing/README.md': 'public/marketing/README.md',
  'marketing/board-canvas.webp': 'public/marketing/board-canvas.webp',
  'marketing/roadmap.webp': 'public/marketing/roadmap.webp',
  'marketing/task.webp': 'public/marketing/task.webp',
  ...Object.fromEntries(Object.values(FONTS).map(({ url, source }) => [url.slice(1), source])),
  'marketing/fonts/manrope-OFL.txt': 'public/marketing/fonts/manrope-OFL.txt',
  'marketing/fonts/rubik-OFL.txt': '../src/assets/fonts/rubik-OFL.txt',
}

/** The origin each stable environment must publish its canonical links for. */
const ORIGINS = { production: 'https://qivo.io', staging: 'https://preview.qivo.io' }

const SECRET_PATTERNS = [
  /\b(?:CONVEX_DEPLOY_KEY|CONVEX_TEAM_TOKEN|VERCEL_TOKEN|VERCEL_OIDC_TOKEN|BETTER_AUTH_SECRET)\b/,
  /\b(?:prod|preview|dev|project):[A-Za-z0-9:_-]+\|[A-Za-z0-9+/=_-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  /api\.vercel\.com\/v1\/integrations\/deploy\//,
]

/** Tags whose URL attributes the browser fetches. Links in `<a>` are only followed when
    clicked, so they may point anywhere. Quoted attribute values may contain `>`. */
const RESOURCE_TAGS =
  /<(script|link|img|source|iframe|video|audio|embed|object|track|input|image|use)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi
/** Attributes that hold one URL, and those that hold a srcset list of URLs. */
const URL_ATTRIBUTES = ['src', 'href', 'xlink:href', 'poster', 'data']
const SRCSET_ATTRIBUTES = ['srcset', 'imagesrcset']
/** `rel` values of a <link> that only name a document and load nothing. */
const NAMING_RELS = new Set(['canonical', 'alternate', 'describedby', 'author', 'license', 'help'])
/** An absolute or protocol-relative URL, which may leave this origin. */
const OTHER_ORIGIN = /^\s*(?:[a-z][a-z0-9+.-]*:)?[\\/]{2}/i

/** Every attribute of one tag by lowercase name, whatever its quoting and spacing. */
function attributesOf(source) {
  const values = new Map()
  for (const [, name, double, single, bare] of source.matchAll(
    /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
  ))
    values.set(name.toLowerCase(), double ?? single ?? bare ?? '')
  return values
}

/** The URLs one resource tag would fetch. */
function fetchedUrls(tag, source) {
  const attributes = attributesOf(source)
  if (tag === 'link') {
    const rels = (attributes.get('rel') || '').toLowerCase().split(/\s+/).filter(Boolean)
    if (rels.length && rels.every((rel) => NAMING_RELS.has(rel))) return []
  }
  return [
    ...URL_ATTRIBUTES.map((name) => attributes.get(name)),
    ...SRCSET_ATTRIBUTES.flatMap((name) =>
      (attributes.get(name) || '').split(',').map((candidate) => candidate.trim().split(/\s+/)[0]),
    ),
  ].filter(Boolean)
}

/** Replace a marker that must appear in index.html exactly once. */
function fill(html, marker, value) {
  const parts = html.split(marker)
  if (parts.length !== 2) throw new Error(`index.html must contain ${marker} exactly once`)
  return parts.join(value)
}

/** The homepage with the stylesheet and the font preloads in place of their
    markers, so they stay the same as on the generated pages. */
export function homepage(html) {
  return fill(fill(html, '/* SITE_CSS */', CSS), '<!-- FONT_PRELOADS -->', FONT_PRELOADS)
    .replace('rel="canonical" href="https://qivo.io/"', `rel="canonical" href="${ORIGIN}/"`)
    .replace(
      'property="og:url" content="https://qivo.io/"',
      `property="og:url" content="${ORIGIN}/"`,
    )
}

/** Throw unless every file is safe to publish on the application's origin. */
export function verifyOutput(files) {
  const errors = []
  for (const [file, body] of files) {
    if (file === 'assets' || file.startsWith('assets/'))
      errors.push(`${file}: /assets/ belongs to the application`)
    const text = Buffer.isBuffer(body) ? body.toString('latin1') : body
    for (const pattern of SECRET_PATTERNS)
      if (pattern.test(text)) errors.push(`${file}: looks like it contains a credential`)
    if (/\.(?:html|js|css)$/.test(file)) {
      if (/url\(\s*["']?\s*(?:[a-z][a-z0-9+.-]*:)?[\\/]{2}/i.test(text) || /@import\s/i.test(text))
        errors.push(`${file}: loads a third-party stylesheet resource`)
      if (/\b(?:import\s*\(?|from)\s*["']\s*(?:[a-z][a-z0-9+.-]*:)?[\\/]{2}/i.test(text))
        errors.push(`${file}: imports a third-party module`)
      for (const [, name, source] of text.matchAll(RESOURCE_TAGS)) {
        const tag = name.toLowerCase()
        if (fetchedUrls(tag, source).some((url) => OTHER_ORIGIN.test(url)))
          errors.push(`${file}: loads a third-party ${tag === 'script' ? 'script' : 'resource'}`)
      }
    }
  }
  if (errors.length) throw new Error(`Website output rejected:\n  ${errors.join('\n  ')}`)
}

/**
 * Render the website and write it into `outDir`. `env.QIVO_ENVIRONMENT` decides
 * indexing: only production may be indexed. Stable environments must also be
 * built for their own origin (SITE_ORIGIN). Returns the published files.
 */
export function buildSite({
  contentDir = join(REPOSITORY, 'docs/guide'),
  publicDir = join(REPOSITORY, 'public'),
  outDir = join(REPOSITORY, 'dist'),
  env = process.env,
} = {}) {
  const environment = env.QIVO_ENVIRONMENT || 'local'
  if (ORIGINS[environment] && ORIGIN !== ORIGINS[environment])
    throw new Error(`SITE_ORIGIN must be ${ORIGINS[environment]} for ${environment} builds`)
  if (environment === 'preview' && !env.SITE_ORIGIN)
    throw new Error('SITE_ORIGIN must name the branch preview for preview builds')
  const files = buildPages({ contentDir, publicDir })
  files.set('index.html', homepage(readFileSync(join(ROOT, 'index.html'), 'utf8')))
  for (const [published, from] of Object.entries(ASSETS))
    files.set(published, readFileSync(join(ROOT, from)))
  if (environment !== 'production') {
    files.set('robots.txt', 'User-agent: *\nDisallow: /\n')
    for (const [name, body] of files)
      if (name.endsWith('.html'))
        files.set(
          name,
          body.replace('</head>', '<meta name="robots" content="noindex, nofollow" />\n</head>'),
        )
  }
  verifyOutput(files)

  const errors = []
  const targets = new Map()
  for (const published of files.keys()) {
    const file = resolve(outDir, published)
    if (!file.startsWith(`${resolve(outDir)}${sep}`)) errors.push(`${published}: outside dist/`)
    else if (existsSync(file)) errors.push(`${published}: would replace an application file`)
    targets.set(published, file)
  }
  if (errors.length) throw new Error(`Website output rejected:\n  ${errors.join('\n  ')}`)
  for (const [published, body] of files) {
    const file = targets.get(published)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
  return files
}

function main(env) {
  if (env.VITE_APP_MODE === 'demo') {
    console.log('[website] Skipped: demo.qivo.io serves only the application.')
    return
  }
  const files = buildSite({ env })
  console.log(`[website] ${files.size} files written to dist/ for ${ORIGIN}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.env)
  } catch (error) {
    console.error(`[website] ${error.message}`)
    process.exitCode = 1
  }
}

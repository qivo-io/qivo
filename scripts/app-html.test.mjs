import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { verifyOutput } from '../website/scripts/build.mjs'

/* app.html and admin.html are the application's Vite entries, and the demo
 * serves app.html too. Loading a stylesheet, font or script from another
 * origin would send every visitor's IP address there, as the Google Fonts
 * links once did. The website build applies the same check to its pages. */
const PAGES = ['app.html', 'admin.html']
const page = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
/** The page with `markup` added at the end of its <head>. */
const withHead = (name, markup) => page(name).replace('</head>', `${markup}\n</head>`)

describe('application HTML entries', () => {
  it.each(PAGES)('%s loads nothing from another origin', (name) => {
    expect(() => verifyOutput(new Map([[name, page(name)]]))).not.toThrow()
  })

  it.each([
    [
      '<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />',
      /third-party resource/,
    ],
    [
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
      /third-party resource/,
    ],
    [
      '<link rel="preload" as="font" href="//fonts.gstatic.com/s/x.woff2" crossorigin />',
      /third-party resource/,
    ],
    ['<style>@font-face{src:url(https://fonts.gstatic.com/s/x.woff2)}</style>', /stylesheet/],
    [
      '<style>@import url("https://fonts.googleapis.com/css2?family=Geist+Mono");</style>',
      /stylesheet/,
    ],
    ['<script src="https://cdn.example/x.js"></script>', /third-party script/],
    ['<script type="module">import "https://cdn.example/x.js"</script>', /third-party module/],
  ])('rejects %s in either page', (markup, message) => {
    for (const name of PAGES)
      expect(() => verifyOutput(new Map([[name, withHead(name, markup)]])), name).toThrow(message)
  })
})

/* The HTML check above cannot see stylesheets, and Vite only warns about a
 * url() it cannot resolve. These checks keep fonts and other CSS resources on
 * the application's own origin and fail when a local font file goes missing.
 * The fonts' licence requires its text to travel with them, so every build
 * publishes public/fonts/<family>-OFL.txt. */
const SRC = new URL('../src/', import.meta.url)
const TOKENS = new URL('styles/tokens.css', SRC)
const PUBLIC_FONTS = new URL('../public/fonts/', import.meta.url)

/** What a stylesheet can load, without data: URLs: url() and @import
 * targets, and remote quoted strings such as image-set() arguments. CSS names
 * are case-insensitive, and comments load nothing. */
function cssTargets(stylesheet) {
  const css = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '')
  const targets = new Set()
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) targets.add(match[2])
  for (const match of css.matchAll(/@import\s*(['"])([^'"]+)\1/gi)) targets.add(match[2])
  // A url() may hold a data: URL with quoted SVG attributes, which load nothing.
  const outsideUrls = css.replace(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/gi, '')
  for (const match of outsideUrls.matchAll(/(['"])([^'"]*)\1/g))
    if (remote(match[2])) targets.add(match[2])
  return [...targets].filter((target) => !target.startsWith('data:'))
}

/** True for absolute and protocol-relative URLs, which load from another origin. */
const remote = (target) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(target)

/** True when a relative url() in `stylesheet` names an existing file. */
const resolves = (target, stylesheet) => existsSync(fileURLToPath(new URL(target, stylesheet)))

describe('application stylesheets', () => {
  const sheets = readdirSync(SRC, { recursive: true })
    .filter((path) => path.endsWith('.css'))
    .map((path) => new URL(path, SRC))

  it('load nothing from another origin', () => {
    expect(sheets.length).toBeGreaterThan(0)
    for (const sheet of sheets)
      expect(cssTargets(readFileSync(sheet, 'utf8')).filter(remote), sheet.pathname).toEqual([])
  })

  it('point every font face at a file that exists', () => {
    const fonts = cssTargets(readFileSync(TOKENS, 'utf8')).filter((target) =>
      target.endsWith('.woff2'),
    )
    expect(fonts.length).toBeGreaterThan(0)
    for (const font of fonts) expect(resolves(font, TOKENS), font).toBe(true)
  })

  it('publish a licence for every font face', () => {
    const licences = readdirSync(PUBLIC_FONTS).filter((name) => name.endsWith('-OFL.txt'))
    const fonts = cssTargets(readFileSync(TOKENS, 'utf8')).filter((target) =>
      target.endsWith('.woff2'),
    )
    for (const font of fonts) {
      const name = basename(font)
      expect(
        licences.some((licence) => name.startsWith(licence.replace('OFL.txt', ''))),
        name,
      ).toBe(true)
    }
  })

  it('detect remote resources and missing files', () => {
    expect(
      cssTargets('@font-face{src:url(https://fonts.gstatic.com/s/x.woff2)}').filter(remote),
    ).toHaveLength(1)
    expect(
      cssTargets('@import "//fonts.googleapis.com/css2?family=Geist+Mono";').filter(remote),
    ).toHaveLength(1)
    for (const css of [
      'a{src:URL(https://fonts.gstatic.com/s/x.woff2)}',
      '@IMPORT "https://x.test/a.css";',
      '@import"https://x.test/a.css";',
      'a{background:image-set("https://cdn.x.test/x.png" 1x)}',
    ])
      expect(cssTargets(css).filter(remote), css).not.toEqual([])
    expect(cssTargets('/* url(https://x.test/a.png) */ a{color:red}')).toEqual([])
    expect(cssTargets('a{background:url(/marketing/x.png)}').filter(remote)).toEqual([])
    expect(cssTargets('a{background:url("data:image/png;base64,AA==")}')).toEqual([])
    expect(resolves('../assets/fonts/missing.woff2', TOKENS)).toBe(false)
  })
})

/* app.html fixes the document's base URL at the site root with a <base>, so
 * a route change costs no walk over the page's elements. A relative URL in
 * the application resolves against `/` then, not against the route it is
 * on: `#part` or `?tab=x` would leave for the website. So the application
 * writes every URL it links, loads or navigates to whole. */
const APP_SOURCE = new URL('../src/', import.meta.url)
const WHOLE = /^(?:\/|[a-z][a-z0-9+.-]*:)/i
/* A URL written out: a quoted string or a template literal, alone or the
 * first part of a `+`. Only the text before a template's first `${` is
 * checked, and a URL that starts with an interpolation or is a variable is
 * not: a scan of the source text cannot know what those hold. */
const LITERAL = String.raw`(?:'([^']*)'|"([^"]*)"|\`([^\`$]*)(\$\{)?[^\`]*\`)`
const WRITTEN = String.raw`(?:"([^"]*)"|'([^']*)'|\{\s*${LITERAL})`
const URL_PLACES = [
  // a JSX attribute that holds a URL
  new RegExp(String.raw`\b(?:href|src|action|formAction|poster)=${WRITTEN}`, 'g'),
  // the URL of a history entry, after the state and the unused title
  new RegExp(
    String.raw`\b(?:pushState|replaceState)\([^()]*?,\s*(?:''|""|\`\`)\s*,\s*${LITERAL}`,
    'g',
  ),
  // a navigation or a request
  new RegExp(
    String.raw`\b(?:location\.(?:assign|replace)|window\.open|fetch|sendBeacon)\(\s*${LITERAL}`,
    'g',
  ),
  new RegExp(String.raw`\blocation\.href\s*=\s*${LITERAL}`, 'g'),
]

/** The URLs written out in `source` that the base would resolve against the
    site root rather than against the route. */
function relativeUrls(source) {
  const found = []
  for (const place of URL_PLACES)
    for (const match of source.matchAll(place)) {
      const at = match.slice(1).findIndex((group) => group !== undefined)
      const url = match[at + 1]
      // an empty template literal before an interpolation is not checked
      if (url === '' && match[at + 2] !== undefined) continue
      if (url !== undefined && !WHOLE.test(url)) found.push(url)
    }
  return found
}

describe('URLs under the base', () => {
  it('app.html sets the base at the site root before anything it loads', () => {
    const html = page('app.html')
    const base = html.search(/<base href="\/" \/>/)
    expect(base).toBeGreaterThan(0)
    expect(html.match(/<base\b/g)).toHaveLength(1)
    for (const loads of [/<link\b/, /<script\b/]) expect(base).toBeLessThan(html.search(loads))
  })

  it('finds a relative URL the base would move, and passes whole ones', () => {
    for (const source of [
      '<a href="#details">',
      "<a href='settings'>",
      '<img src={"avatar.png"} />',
      "history.pushState(null, '', '?view=board')",
      "history.pushState({ ...history.state, layer: id }, '', '#layer')",
      'history.replaceState(history.state, "", "")',
      'window.open(`help`)',
      "location.assign('../app')",
      'location.href = "#top"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text the scan reads
      '<a href={`#${section}`}>',
      "<a href={'#' + id}>",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text the scan reads
      "history.pushState(null, '', `?tab=${tab}`)",
      "fetch('api/tasks')",
      "navigator.sendBeacon('log', body)",
    ])
      expect(relativeUrls(source), source).toHaveLength(1)
    for (const source of [
      '<a href="/app/acme/board">',
      '<a href={WORKSPACE_SIGNUP_URL}>',
      '<img src={url} />',
      "<a href='https://qivo.io/docs'>",
      '<a href="mailto:help@qivo.io">',
      "history.pushState({ qivoPrevious: location.pathname }, '', buildPath(was))",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text the scan reads
      "history.replaceState(null, '', `/app/${slug}/board/all`)",
      "history.pushState({ ...history.state, qivoLayer: id }, '', location.href)",
      "window.open(href, '_blank', 'noopener')",
      "location.replace('qivo://auth')",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text the scan reads
      '<a href={`/app/${slug}#${part}`}>',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text the scan reads
      '<a href={`${origin}/app`}>',
      "<a href={'/app/' + slug}>",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text the scan reads
      'fetch(`/version.json?t=${Date.now()}`)',
    ])
      expect(relativeUrls(source), source).toEqual([])
  })

  it('the application writes no relative URL', () => {
    const files = readdirSync(APP_SOURCE, { recursive: true }).filter(
      (path) => /\.(?:ts|tsx)$/.test(path) && !/\.test\.(?:ts|tsx)$/.test(path),
    )
    expect(files.length).toBeGreaterThan(100)
    for (const path of files)
      expect(relativeUrls(readFileSync(new URL(path, APP_SOURCE), 'utf8')), path).toEqual([])
  })
})

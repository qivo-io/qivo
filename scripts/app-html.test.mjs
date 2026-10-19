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

/** url() and @import targets in a stylesheet, without data: URLs. */
function cssTargets(css) {
  const targets = []
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) targets.push(match[2])
  for (const match of css.matchAll(/@import\s+(['"])([^'"]+)\1/g)) targets.push(match[2])
  return targets.filter((target) => !target.startsWith('data:'))
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
    expect(cssTargets('a{background:url(/marketing/x.png)}').filter(remote)).toEqual([])
    expect(cssTargets('a{background:url("data:image/png;base64,AA==")}')).toEqual([])
    expect(resolves('../assets/fonts/missing.woff2', TOKENS)).toBe(false)
  })
})

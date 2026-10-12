import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { homepage } from '../scripts/build.mjs'
import { CSS } from '../site/theme.mjs'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

describe('homepage', () => {
  it('keeps website section links on the homepage while forwarding legacy app links', () => {
    const redirect = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    for (const hash of ['', '#main', '#features', '#capacity', '#agents']) {
      runInNewContext(redirect, {
        location: {
          hash,
          replace: () => {
            throw new Error(`Unexpected redirect for ${hash}`)
          },
        },
      })
    }
    for (const hash of ['#/board/all', '#/o/acme/tasks/qn-5', '#signup']) {
      const destinations = []
      runInNewContext(redirect, {
        location: { hash, replace: (url) => destinations.push(url) },
      })
      expect(destinations).toEqual([`/app${hash}`])
    }
  })

  it('ships the theme inline and loads only local scripts, fonts and images', () => {
    const page = homepage(html)
    const css = [...page.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
    expect(css).toMatch(/body\s*\{[^}]*font-family\s*:/)
    expect(css).toContain('.hero')
    expect(css).toContain('--bg:')
    expect(css).toMatch(/url\("\/marketing\/fonts\/manrope-normal-latin\.[0-9a-f]{8}\.woff2"\)/)
    expect(page).not.toContain('SITE_CSS')
    expect(page).not.toContain('FONT_PRELOADS')
    expect(page).toContain('<script type="module" src="/marketing/home.js">')
    expect(page).toMatch(/<a\b[^>]*href="https:\/\/demo\.qivo\.io"[^>]*>Demo<\/a>/)
    for (const [, src] of page.matchAll(/\bsrc="([^"]+)"/g)) expect(src).toMatch(/^\/marketing\//)
  })

  it('requires exactly one stylesheet marker and one font preload marker', () => {
    expect(() => homepage('<style></style>')).toThrow(/exactly once/)
    expect(() => homepage('/* SITE_CSS *//* SITE_CSS */')).toThrow(/exactly once/)
    expect(() => homepage('<style>/* SITE_CSS */</style>')).toThrow(
      /FONT_PRELOADS --> exactly once/,
    )
    expect(() => homepage('<!-- FONT_PRELOADS --><!-- FONT_PRELOADS -->/* SITE_CSS */')).toThrow(
      /FONT_PRELOADS --> exactly once/,
    )
    expect(homepage('<!-- FONT_PRELOADS --><style>/* SITE_CSS */</style>')).toMatch(
      /^<link rel="preload"[^>]*><style>/,
    )
  })

  // The wordmark must never wait for a request, or it shows in a fallback
  // font after each click wherever caching is off.
  it('embeds the wordmark font in the stylesheet', () => {
    const face = /@font-face\s*\{[^}]*font-family:\s*"Qivo Wordmark"[^}]*\}/.exec(CSS)?.[0]
    expect(face).toBeDefined()
    expect(face).toContain('font-weight: 700')
    const data = /url\("data:font\/woff2;base64,([A-Za-z0-9+/=]+)"\)/.exec(face)?.[1]
    expect(Buffer.from(data, 'base64')).toEqual(
      readFileSync(new URL('../../src/assets/fonts/rubik-700-qivo.woff2', import.meta.url)),
    )
    expect(CSS).toMatch(/\.brand\s*\{[^}]*font-family:\s*"Qivo Wordmark"/)
  })
})

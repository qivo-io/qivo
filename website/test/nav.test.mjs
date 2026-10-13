import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { homepage } from '../scripts/build.mjs'
import { build } from '../site/pages.mjs'
import { CSS } from '../site/theme.mjs'

const source = readFileSync(new URL('../site/nav.mjs', import.meta.url), 'utf8')
const repository = fileURLToPath(new URL('../../', import.meta.url))

/** A docs sidebar box `height` tall with `content` worth of entries. The
    current page's entry spans `entry`, measured from the sidebar's top while
    the sidebar is sticky, and from the page otherwise. */
function docnav({ height, content, entry, sticky = true }) {
  const sidebar = {
    clientHeight: height,
    scrollHeight: content,
    scrollTop: 0,
    listeners: {},
    addEventListener(type, listener) {
      this.listeners[type] = listener
    },
  }
  const current = {
    offsetParent: sticky ? sidebar : {},
    offsetTop: entry[0],
    offsetHeight: entry[1] - entry[0],
  }
  sidebar.querySelector = (selector) => (selector === '[aria-current]' ? current : null)
  return sidebar
}

/** Runs nav.mjs on a page opened at `scrollY`, with or without a header and
    with an optional docs sidebar. */
function load({ scrollY = 0, withHeader = true, sidebar = null } = {}) {
  const header = {
    marked: false,
    toggleAttribute(name, force) {
      expect(name).toBe('data-scrolled')
      this.marked = force
      return force
    },
  }
  const listeners = []
  const window = {
    scrollY,
    addEventListener: (type, listener, options) => listeners.push({ type, listener, options }),
  }
  const elements = { 'header.top': withHeader ? header : null, '.docnav': sidebar }
  runInNewContext(source, { window, document: { querySelector: (s) => elements[s] ?? null } })
  const scrollTo = (y) => {
    window.scrollY = y
    for (const { type, listener } of listeners) if (type === 'scroll') listener()
  }
  return { header, listeners, scrollTo }
}

describe('sticky header line', () => {
  it('marks the header only while the page is scrolled', () => {
    const { header, listeners, scrollTo } = load()
    expect(header.marked).toBe(false)
    expect(listeners).toEqual([
      { type: 'scroll', listener: expect.any(Function), options: { passive: true } },
    ])
    scrollTo(1)
    expect(header.marked).toBe(true)
    scrollTo(900)
    expect(header.marked).toBe(true)
    scrollTo(0)
    expect(header.marked).toBe(false)
  })

  it('marks a page that opens already scrolled', () => {
    expect(load({ scrollY: 640 }).header.marked).toBe(true)
  })

  it('does nothing on a page without the header', () => {
    expect(load({ scrollY: 640, withHeader: false }).listeners).toEqual([])
  })

  it('is loaded by every page', () => {
    const pages = build({
      contentDir: join(repository, 'docs/guide'),
      publicDir: join(repository, 'public'),
    })
    pages.set(
      'index.html',
      homepage(readFileSync(new URL('../index.html', import.meta.url), 'utf8')),
    )
    const html = [...pages].filter(([name]) => name.endsWith('.html'))
    expect(html.map(([name]) => name)).toEqual(
      expect.arrayContaining(['index.html', 'pricing/index.html', 'docs/index.html']),
    )
    for (const [name, page] of html) {
      const head = page.slice(0, page.indexOf('</head>'))
      expect(head, name).toContain('<script type="module" src="/marketing/nav.js"></script>')
      expect(page, name).toMatch(/<header class="top">/)
    }
  })

  // Short windows (WCAG technique C34) keep the header in the page flow. Where
  // it sticks, anchors and keyboard focus must land below it, and focus on its
  // own links must not scroll the page.
  it('sticks only on tall windows, with matching scroll offsets', () => {
    const query = '@media (min-height: 480px) {'
    expect(CSS).toContain(query)
    const open = CSS.indexOf(query) + query.length - 1
    let close = open
    for (let depth = 0; close < CSS.length; close++) {
      if (CSS[close] === '{') depth++
      else if (CSS[close] === '}' && --depth === 0) break
    }
    const tall = CSS.slice(open + 1, close)
    const elsewhere = CSS.slice(0, open) + CSS.slice(close)
    const sticky = /\.top\s*\{[^}]*position:\s*sticky/
    const line = /\.top\[data-scrolled\]\s*\{[^}]*box-shadow:/
    expect(tall).toMatch(sticky)
    expect(tall).toMatch(line)
    expect(tall).toMatch(/html\s*\{[^}]*scroll-padding-top:\s*var\(--below-header\)/)
    expect(tall).toMatch(
      /\.top a\s*\{[^}]*scroll-margin-top:\s*calc\(-1 \* var\(--below-header\)\)/,
    )
    expect(elsewhere).not.toMatch(sticky)
    expect(elsewhere).not.toMatch(line)
    expect(elsewhere).toMatch(/html\s*\{[^}]*scroll-padding-top:\s*24px/)
  })
})

describe('docs sidebar', () => {
  it('centres a current entry that the scrolling sidebar would hide', () => {
    const sidebar = docnav({ height: 521, content: 662, entry: [600, 630] })
    load({ sidebar })
    expect(sidebar.scrollTop + sidebar.clientHeight / 2).toBe(615)
  })

  it('leaves the sidebar alone when the current entry is already visible', () => {
    const sidebar = docnav({ height: 521, content: 662, entry: [200, 230] })
    load({ sidebar })
    expect(sidebar.scrollTop).toBe(0)
  })

  it('leaves a sidebar that does not scroll alone', () => {
    // Narrow windows show the sidebar in the page flow, measured from the page.
    const flowing = docnav({ height: 662, content: 662, entry: [1200, 1230], sticky: false })
    load({ sidebar: flowing })
    expect(flowing.scrollTop).toBe(0)
    // A sticky sidebar can still fit the window.
    const fitting = docnav({ height: 662, content: 662, entry: [600, 630] })
    load({ sidebar: fitting })
    expect(fitting.scrollTop).toBe(0)
  })

  it('scrolls a link that gains focus fully into the sidebar', () => {
    const sidebar = docnav({ height: 521, content: 662, entry: [200, 230] })
    load({ sidebar })
    const calls = []
    sidebar.listeners.focusin({ target: { scrollIntoView: (options) => calls.push(options) } })
    expect(calls).toEqual([{ block: 'nearest' }])
  })
})

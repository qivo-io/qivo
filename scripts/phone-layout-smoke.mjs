/* Phone pages beside the bottom navigation, in a real browser without a
 * backend.
 * Usage: node scripts/phone-layout-smoke.mjs [--shots dir]
 * Builds the benchmark page (scripts/perf/page.mjs) from this checkout and
 * opens it at 390x844 and 360x640. On the Inbox, My tasks, Projects, Team
 * sync and Settings it checks that the page's content ends above the bottom
 * navigation, and that at the end of every scrolling area no control of
 * the page is left under it. --shots saves a screenshot of each page. Writes
 * go to the page's synthetic transport only. */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { buildPage, serve } from './perf/page.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const at = process.argv.indexOf('--shots')
const shots = at < 0 ? null : resolve(process.argv[at + 1])
const log = (message) => console.log(`[phone-layout] ${message}`)
const SIZES = [
  [390, 844],
  [360, 640],
]
/** Each page: the control that opens it and what shows once it is open. */
const PAGES = [
  ['Inbox', '[data-inbox-nav]', '.inbox-layout, [data-inbox-list]'],
  ['My tasks', '[data-mine-nav]', '[data-workspace-view]'],
  ['Projects', '[data-projects-nav]', '.mobile-project-directory'],
  ['Team sync', '[data-sync-nav]', '[data-sync-page]'],
  ['Settings', '[data-mobile-settings]', '[data-settings-page]'],
]

const temporary = await mkdtemp(join(tmpdir(), 'qivo-phone-layout-'))
// Ctrl-C or a stop skips the finally below, so remove the build here.
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
])
  process.once(signal, () => {
    rmSync(temporary, { recursive: true, force: true })
    process.exit(code)
  })
let server
let browser
try {
  const outDir = join(temporary, 'dist')
  await buildPage(root, outDir, temporary)
  server = await serve(outDir)
  browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
  if (shots) mkdirSync(shots, { recursive: true })
  const errors = []
  for (const [width, height] of SIZES) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: true })
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${server.origin}/?tasks=300&latency=0&mbps=10000`)
    await page.waitForSelector('[data-mine-nav]')
    for (const [name, nav, shown] of PAGES) {
      await page.click(nav)
      await page.waitForFunction((css) => !!document.querySelector(css)?.checkVisibility(), shown)
      const found = await page.evaluate(() => {
        const nav = document.querySelector('.mobile-bottom-navigation')
        const top = nav?.checkVisibility() ? nav.getBoundingClientRect().top : innerHeight
        const main = document.querySelector('.workspace-shell:not([data-hidden-view]) > main')
        const mainBottom = main ? main.getBoundingClientRect().bottom : 0
        // every scrolling area of the page, at its end
        const scrolled = []
        for (const element of document.querySelectorAll('main *, .settings-main, .settings-main *'))
          if (
            !element.closest('[data-hidden-view]') &&
            element.scrollHeight > element.clientHeight + 1 &&
            /(auto|scroll)/.test(getComputedStyle(element).overflowY)
          ) {
            element.scrollTop = element.scrollHeight
            scrolled.push(element)
          }
        const covered = []
        for (const control of document.querySelectorAll(
          'button, a[href], input, select, textarea, summary, [tabindex="0"]',
        )) {
          if (!control.checkVisibility() || control.closest('[data-hidden-view]')) continue
          if (nav?.contains(control)) continue
          const box = control.getBoundingClientRect()
          if (box.height === 0 || box.bottom <= top + 0.5 || box.top >= innerHeight) continue
          const hit = document.elementFromPoint(
            box.x + box.width / 2,
            Math.min(box.bottom, innerHeight) - 1,
          )
          if (nav?.contains(hit))
            covered.push(
              (control.getAttribute('aria-label') || control.textContent).trim().slice(0, 40),
            )
        }
        for (const element of scrolled) element.scrollTop = 0
        return { navTop: Math.round(top), mainBottom: Math.round(mainBottom), covered }
      })
      if (shots)
        await page.screenshot({
          path: join(shots, `${width}x${height}-${name.replace(' ', '-')}.png`),
        })
      const where = `${width}x${height} ${name}`
      assert.ok(
        found.mainBottom <= found.navTop + 0.5,
        `${where}: the page ends at ${found.mainBottom}px, under the navigation at ${found.navTop}px`,
      )
      assert.deepEqual(found.covered, [], `${where}: controls under the bottom navigation`)
      log(`${where}: clear of the bottom navigation`)
      if (name === 'Settings') await page.click('[data-settings-back]')
    }
    await context.close()
  }
  assert.deepEqual(errors, [], 'The page logged errors')
  log('passed')
} finally {
  await browser?.close()
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}

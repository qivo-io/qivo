/* A large Board, driven in a real browser without a backend.
 * Usage: node scripts/board-large-smoke.mjs [--tasks 10000]
 * Builds the benchmark page (scripts/perf/page.mjs) from this checkout,
 * serves it on loopback and opens the Board with that many tasks at full
 * CPU speed. Checks a drag between statuses, keyboard focus through a card
 * and back from the task window, Find on the last card, and that the page
 * logs no errors. Writes go to the page's synthetic transport only. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { buildPage, serve } from './perf/page.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const at = process.argv.indexOf('--tasks')
const tasks = at < 0 ? 10_000 : Number(process.argv[at + 1])
const slow = { timeout: 120_000 }
const log = (message) => console.log(`[board-large] ${message}`)

const temporary = await mkdtemp(join(tmpdir(), 'qivo-board-large-'))
let server
let browser
try {
  const outDir = join(temporary, 'dist')
  await buildPage(root, outDir, temporary)
  server = await serve(outDir)
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(30_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto(`${server.origin}/?tasks=${tasks}&latency=0`)
  await page.locator('[data-view-switch]').waitFor()
  await page
    .locator('[data-view-switch]')
    .getByRole('radio', { name: 'Board', exact: true })
    .click(slow)
  await page.locator('[data-card]').first().waitFor(slow)
  // a Board that mounts in slices marks the part still to come
  await page.waitForFunction(
    () => !document.querySelector('[data-board-mount="pending"]'),
    null,
    slow,
  )
  assert.equal(await page.locator('[data-card]').count(), tasks, 'The Board must show every task')
  log(`opened with ${tasks} tasks`)

  const lane = page.locator('.board-lane').first()
  const todo = lane.locator('[data-board-cell][data-status="todo"]')
  const progress = lane.locator('[data-board-cell][data-status="progress"]')
  const first = todo.locator('[data-card][draggable="true"]').first()
  const id = await first.getAttribute('data-card')
  const title = await page.evaluate((id) => window.PLANNER.issueById[id].title, id)
  const titleButton = first.getByRole('button', { name: title, exact: true })
  const focusedCard = () =>
    page.evaluate(() => ({
      card: document.activeElement?.closest('[data-card]')?.getAttribute('data-card') ?? null,
      owner: document.activeElement?.getAttribute('data-assignee-edit') ?? null,
      label: document.activeElement?.getAttribute('aria-label') ?? null,
    }))

  // Tab from a card's title reaches its owner, Enter on the title opens the
  // task and Escape brings focus back to the title.
  await titleButton.focus()
  await page.keyboard.press('Tab')
  assert.deepEqual(
    await focusedCard(),
    {
      card: id,
      owner: id,
      label: await first.locator('[data-assignee-edit]').getAttribute('aria-label'),
    },
    'Tab from the title must reach its owner button',
  )
  await titleButton.focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-task-close]').waitFor()
  await page.keyboard.press('Escape')
  await page.locator('[data-task-close]').waitFor({ state: 'detached' })
  await page.waitForFunction(
    (id) =>
      document.activeElement?.closest('[data-card]')?.getAttribute('data-card') === id &&
      document.activeElement.matches('button:not([data-assignee-edit])'),
    id,
  )
  log('focus moves through a card and returns from its task')

  // One drag from To Do into In Progress writes once.
  const writes = await page.evaluate(() => window.__perf.writes)
  await progress.scrollIntoViewIfNeeded()
  await first.dragTo(progress, { targetPosition: { x: 12, y: 12 } })
  await page.waitForFunction((id) => window.PLANNER.issueById[id]?.status === 'progress', id, slow)
  await page.waitForTimeout(500)
  assert.equal(
    await page.evaluate(() => window.__perf.writes),
    writes + 1,
    'The drag must write once',
  )
  assert.equal(await progress.locator(`[data-card="${id}"]`).count(), 1)
  log('a drag between statuses writes once')

  // Find reaches the last card, wherever it is on the Board.
  const last = await page.evaluate(() => window.PLANNER.issues.at(-1).title)
  assert.equal(
    await page.evaluate((text) => window.find(text, true), last),
    true,
    'Find must reach the last task',
  )
  log('Find reaches the last task')

  assert.deepEqual(errors, [], 'The page logged errors')
  log('passed')
} finally {
  await browser?.close()
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}

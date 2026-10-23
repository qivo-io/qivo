/* A large Board, driven in a real browser without a backend.
 * Usage: node scripts/board-large-smoke.mjs [--tasks 10000]
 * Builds the benchmark page (scripts/perf/page.mjs) from this checkout,
 * serves it on loopback and opens the Board with that many tasks. While the
 * Board still mounts in slices (with the CPU 4x slower, so that lasts), it
 * checks the first commit's size, the busy mark, Tab through the waiting
 * space, focus that follows a moved card, a drag and Ctrl+F. Then, at full
 * speed, a drag between statuses, keyboard focus through a card and back
 * from the task window, Find on the last card, scrolling back into a lane
 * that changed above the view, the owner picker on the first tap of a
 * touch screen, the frames of the pooled Board mounting at 4x, and that
 * the pages log no errors. Writes go to the page's synthetic
 * transport only. */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { buildPage, serve } from './perf/page.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const at = process.argv.indexOf('--tasks')
const tasks = at < 0 ? 10_000 : Number(process.argv[at + 1])
/* The checks below need a Board that mounts in slices (over 300 cards, and
   the parents of the generated workspace are no cards of their own) with
   cards still waiting in the first lane's To Do when they start: the drag
   check after the Tab and focus checks runs on that cell while slices go
   on.
   Cells near the view mount first, so at 2,000 tasks that cell is often
   whole by then; 3,000 tasks put about 100 cards there. */
const LEAST_TASKS = 3000
if (!Number.isInteger(tasks) || tasks < LEAST_TASKS) {
  console.error(`[board-large] --tasks takes a whole number of ${LEAST_TASKS} or more`)
  process.exit(1)
}
const slow = { timeout: 120_000 }
const log = (message) => console.log(`[board-large] ${message}`)
// the most cards a first screen of 1000px and 500px more holds in each of
// five status columns, at the least a card takes (MIN_CARD_PITCH, 63px)
const FIRST_SCREEN_CARDS = 5 * Math.ceil(1500 / 63)
const pending = () => !!document.querySelector('[data-board-mount="pending"]')

const temporary = await mkdtemp(join(tmpdir(), 'qivo-board-large-'))
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
  // the handlers above stop the run; the browser goes with the process
  browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
  const errors = []
  /** A new page in its own context, its errors collected. */
  const open = async (options = {}) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      ...options,
    })
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    const cdp = await context.newCDPSession(page)
    return { context, page, cpu: (rate) => cdp.send('Emulation.setCPUThrottlingRate', { rate }) }
  }
  /** Opens the Board, noting how many cards its first commit held and every
      long animation frame from the first card on. */
  const openBoard = async (page) => {
    // a fast network: this checks the Board, not how long results take
    await page.goto(`${server.origin}/?tasks=${tasks}&latency=0&mbps=10000`)
    await page.locator('[data-view-switch]').waitFor(slow)
    await page.evaluate(() => {
      const state = { first: null, firstAt: null, frames: [], observer: null }
      window.__boardOpen = state
      // held in the state, so the read below can take the frames it has
      // not delivered yet
      state.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.frames.push(entry)
      })
      state.observer.observe({ type: 'long-animation-frame' })
      const seen = new MutationObserver(() => {
        const count = document.querySelectorAll('.board-card').length
        if (!count) return
        state.first = count
        state.firstAt = performance.now()
        seen.disconnect()
      })
      seen.observe(document.body, { childList: true, subtree: true })
    })
    await page
      .locator('[data-view-switch]')
      .getByRole('radio', { name: 'Board', exact: true })
      .click(slow)
    await page.locator('[data-card]').first().waitFor(slow)
  }
  /** The long animation frames (over 50ms) after the first card, with
      those the observer has not delivered yet. */
  const longFrames = (page) =>
    page.evaluate(() => {
      const { firstAt, frames, observer } = window.__boardOpen
      frames.push(...observer.takeRecords())
      return frames.filter((f) => f.startTime > firstAt).map((f) => f.duration)
    })

  const { page, cpu } = await open()
  await cpu(4)
  await openBoard(page)
  const firstCommit = await page.evaluate(() => window.__boardOpen.first)
  assert.ok(
    firstCommit > 0 && firstCommit <= FIRST_SCREEN_CARDS,
    `The first commit must hold the first screen only, not ${firstCommit} cards`,
  )
  const pane = page.locator('[data-workspace-view="kanban"] [data-scroll]')
  assert.equal(await pane.getAttribute('aria-busy'), 'true', 'A mounting Board must be busy')
  assert.equal(
    await page
      .locator('[data-deferred-block]')
      .first()
      .evaluate((block) => getComputedStyle(block).contentVisibility),
    'auto',
    'Blocks of cards must skip layout offscreen',
  )
  log(`the first commit held ${firstCommit} cards and the Board is busy`)

  // Tab from the last mounted card of a cell into its waiting space lands
  // on the next card's first control: a task's title, or a parent card's
  // heading. The page's animation frames are held meanwhile, also for the
  // focus check after it: slices wait for a frame once they used theirs
  // (src/lib/mountScheduler.ts), so the Board stops mounting and the cells
  // keep their waiting space through the checks, however fast the machine
  // is.
  await page.evaluate(() => {
    const held = []
    window.__frames = { held, original: window.requestAnimationFrame }
    window.requestAnimationFrame = (callback) => held.push(callback)
  })
  // the scheduler asked for a frame: no slice runs until it gets one
  await page.waitForFunction(() => window.__frames.held.length > 0, null, { polling: 10 })
  const lane = page.locator('.board-lane').first()
  const todo = lane.locator('[data-board-cell][data-status="todo"]')
  const progress = lane.locator('[data-board-cell][data-status="progress"]')
  // the first cell, in Board order, that holds cards and still waits for more
  const waiting = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('[data-board-cell]')]
    const cell = cells.find(
      (it) => it.querySelector('[data-board-pending]') && it.querySelector('.board-card'),
    )
    if (!cell) return null
    cell.setAttribute('data-smoke-cell', '')
    const keys = cell.querySelectorAll('[data-focus-key]')
    keys[keys.length - 1].focus()
    return cell.querySelectorAll('.board-card').length
  })
  assert.ok(waiting > 0, 'A cell must still wait for cards')
  await page.keyboard.press('Tab')
  assert.deepEqual(
    await page.evaluate(() => {
      const cell = document.querySelector('[data-smoke-cell]')
      const card = document.activeElement?.closest('.board-card')
      const first = [...(card?.querySelectorAll('[data-focus-key]') ?? [])].find(
        (element) => element.tabIndex >= 0,
      )
      return {
        index: [...cell.querySelectorAll('.board-card')].indexOf(card),
        first: !!first && first === document.activeElement,
      }
    }),
    { index: waiting, first: true },
    'Tab into the waiting space must land on the next card',
  )
  log('Tab through the waiting space lands on the next card')

  // Focus stays on a card that moves into a cell whose cards still wait:
  // the first waiting cell, and a card from another cell of its lane.
  const move = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('[data-board-cell]')]
    for (const to of cells) {
      if (!to.querySelector('[data-board-pending]')) continue
      const lane = to.getAttribute('data-board-cell')
      const from = cells.find(
        (cell) =>
          cell !== to &&
          cell.getAttribute('data-board-cell') === lane &&
          cell.querySelectorAll('[data-card]').length > 1,
      )
      const card = from?.querySelectorAll('[data-card]')[1]
      if (card)
        return { id: card.getAttribute('data-card'), status: to.getAttribute('data-status') }
    }
    return null
  })
  assert.ok(move, 'A waiting cell must have a card of its lane to take')
  await page.locator(`[data-card="${move.id}"] [data-focus-key="title"]`).focus()
  await page.evaluate(({ id, status }) => window.PLANNER.updateIssue(id, { status }), move)
  await page.waitForFunction(
    ({ id, status }) =>
      document.activeElement
        ?.closest(`[data-status="${status}"] [data-card]`)
        ?.getAttribute('data-card') === id,
    move,
    { polling: 20 },
  )
  log('focus follows a card into a waiting cell')
  // the frames go back, and the ones held run
  await page.evaluate(() => {
    const { held, original } = window.__frames
    window.requestAnimationFrame = original
    delete window.__frames
    for (const callback of held) original(callback)
  })

  // A drag while the Board mounts writes once.
  const dragged = todo.locator('[data-card][draggable="true"]').first()
  const draggedId = await dragged.getAttribute('data-card')
  let writes = await page.evaluate(() => window.__perf.writes)
  assert.ok(await page.evaluate(pending), 'The Board must still be mounting')
  await dragged.dragTo(progress, { targetPosition: { x: 12, y: 12 } })
  await page.waitForFunction(
    (id) => window.PLANNER.issueById[id]?.status === 'progress',
    draggedId,
    slow,
  )
  // the server counts a write once its results reach the page
  await page.waitForFunction((count) => window.__perf.writes > count, writes, slow)
  await page.waitForTimeout(500)
  assert.equal(
    await page.evaluate(() => window.__perf.writes),
    writes + 1,
    'The drag must write once',
  )
  log('a drag during slicing writes once')

  // Ctrl+F mounts every card before the browser searches.
  if (await page.evaluate(pending)) {
    await page.keyboard.press('Control+f')
    assert.equal(await page.evaluate(pending), false, 'Ctrl+F must complete the Board')
    log('Ctrl+F completes the Board')
  } else log('the Board finished before Ctrl+F; its unit test covers it')
  await page.waitForFunction(
    () => !document.querySelector('[data-board-mount="pending"]'),
    null,
    slow,
  )
  assert.equal(await pane.getAttribute('data-board-mount'), 'complete')
  assert.equal(await pane.getAttribute('aria-busy'), null, 'A complete Board must not be busy')
  await cpu(1)
  // every task but the parents, whose subtasks are their cards, as the
  // stand-in server counts them
  assert.equal(
    await page.locator('[data-card]').count(),
    await page.evaluate(() => window.__perf.cards),
    'The Board must show every task',
  )
  log(`opened with ${tasks} tasks`)

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
  writes = await page.evaluate(() => window.__perf.writes)
  await progress.scrollIntoViewIfNeeded()
  await first.dragTo(progress, { targetPosition: { x: 12, y: 12 } })
  await page.waitForFunction((id) => window.PLANNER.issueById[id]?.status === 'progress', id, slow)
  // the server counts a write once its results reach the page, which a
  // large workspace takes seconds to send; then no second write may follow
  await page.waitForFunction((count) => window.__perf.writes > count, writes, slow)
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

  // A lane whose cards change while it is above the view: scrolling back
  // into it keeps the cards in view in place. A body the browser still
  // skipped would keep the height it last rendered at (Kanban).
  const changed = await page.evaluate(async () => {
    const frames = async (n) => {
      for (let i = 0; i < n; i++) await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    const pane = document.querySelector('[data-workspace-view="kanban"] [data-scroll]')
    const bodies = () => document.querySelectorAll('.board-lane-body')
    if (bodies().length < 3) return { lanes: bodies().length }
    const P = window.PLANNER
    const box = () => bodies()[1].getBoundingClientRect()
    const view = pane.getBoundingClientRect()
    // the lane's foot comes into view, then goes far above it
    pane.scrollTop += box().bottom - view.top - view.height / 2
    await frames(3)
    pane.scrollTop += view.height * 2
    await frames(3)
    const before = box().height
    // 40 of its cards move into its tallest column (the stand-in server
    // takes status changes, not moves between lanes)
    const cards = [...bodies()[1].querySelectorAll('[data-card]')].map(
      (card) => P.issueById[card.getAttribute('data-card')],
    )
    const count = new Map()
    for (const it of cards) count.set(it.status, (count.get(it.status) ?? 0) + 1)
    const tallest = [...count].sort((a, b) => b[1] - a[1])[0][0]
    const moving = cards.filter((it) => it.status !== tallest && !it.parent && !it.children?.length)
    for (const it of moving.slice(0, 40)) P.setStatus(it.id, tallest)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await frames(3)
    // back up a step at a time: a card in view moves by the step alone
    let jump = 0
    for (let step = 0; step < 100 && box().bottom < view.top + view.height / 2; step++) {
      const card = document
        .elementFromPoint(view.left + view.width / 2, view.top + view.height * 0.6)
        ?.closest('[data-card]')
      const top = card?.getBoundingClientRect().top
      const from = pane.scrollTop
      pane.scrollTop = from - 150
      await frames(3)
      if (card?.isConnected && top !== undefined)
        jump = Math.max(
          jump,
          Math.abs(card.getBoundingClientRect().top - top - (from - pane.scrollTop)),
        )
    }
    return { lanes: bodies().length, before, after: box().height, jump }
  })
  assert.ok(changed.lanes >= 3, `The Board must have three lanes, not ${changed.lanes}`)
  assert.ok(
    changed.after - changed.before > 500,
    `The lane must grow, not go from ${changed.before}px to ${changed.after}px`,
  )
  assert.ok(changed.jump <= 100, `Scrolling back into the lane moved its cards ${changed.jump}px`)
  log(
    `scrolling back into a lane that changed above the view moved its cards ${Math.round(changed.jump)}px`,
  )

  // A tap on a card's owner button opens the picker on a touch screen.
  const touch = await open({ hasTouch: true })
  await openBoard(touch.page)
  const owner = touch.page.locator('.board-card [data-assignee-edit]').first()
  assert.equal(await owner.evaluate((el) => !!el.closest('[data-card-live]')), false)
  await owner.tap()
  await touch.page.getByRole('dialog').waitFor()
  assert.equal(
    await touch.page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')),
    true,
    'The picker must take focus',
  )
  await touch.context.close()
  log('the owner picker opens on the first tap')

  // The pooled Board at 4x mounts in slices. Its frames aim for 50ms; at the
  // cost a card takes on a shared machine some run over, and no frame may
  // come near the seconds main freezes for.
  const pooled = await open()
  await pooled.page.goto(`${server.origin}/?tasks=${tasks}&latency=0&mbps=10000`)
  await pooled.page.locator('[data-view-switch]').waitFor(slow)
  await pooled.page.evaluate(() => window.PLANNER.saveUI({ metaViz: 'pool' }))
  await pooled.cpu(4)
  await openBoard(pooled.page)
  await pooled.page.waitForFunction(
    () => !document.querySelector('[data-board-mount="pending"]'),
    null,
    slow,
  )
  const frames = await longFrames(pooled.page)
  const longest = Math.max(0, ...frames)
  assert.ok(longest <= 250, `No frame of the pooled Board at 4x may take ${longest}ms`)
  await pooled.context.close()
  log(
    `the pooled Board at 4x mounted with ${frames.length} frames over 50ms, the longest ${Math.round(longest)}ms`,
  )

  assert.deepEqual(errors, [], 'The page logged errors')
  log('passed')
} finally {
  await browser?.close()
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}

// Real production UI/store; synthetic transport isolates CPU/DOM costs from backend variance.
//
//   node scripts/benchmark-browser.mjs [--sizes 100,1000,10000] [--samples 5]
//     [--baseline [revision]] [--root checkout] [--output file.json]
//     [--fixture varied] [--serve [--host address]]
//
// The page loads a realistic workspace from a stand-in server in a Web Worker
// (scripts/perf/server.mjs) and pays for every delivery what a real client
// pays: the time its bytes take at --mbps, and decoding its JSON text
// (scripts/perf/transport.mjs). Each phase also records the bytes delivered
// in it (*WireBytes) and the script time spent decoding them (*DecodeMs);
// the phase's own key is its elapsed time.
//
// --baseline also builds `revision` (by default the merge base of HEAD and
// origin/main, as scripts/benchmark-backend.mjs picks it) with this
// checkout's dependencies and transport, runs its samples in turn with the
// checkout's, and prints both medians side by side. Taking turns puts both
// under the same machine load, which moves single numbers a lot. The App
// render counts (*AppRenders) do not depend on load at all.
//
// Every sample ends on the Overview and the Roadmap after the Board was
// open (which stays loaded, hidden): the page's memory, and a remote change
// and a local edit on each (overviewAfterBoard*, roadmapAfterBoard*).
//
// The Board answers one top-level project from the server (tasks:board),
// at most 1,000 tasks. The workspace spreads its tasks over a top-level
// project for each 1,000 of them or part of them (perf/page.mjs
// programsFor), so the one the app opens holds about 1,000 tasks and 900
// cards at whole thousands and fewer between them, in a build that filters
// in the browser as in one that asks the server. The Board's
// phases wait for its answer where the build marks its state
// (data-board-state), so they include the round trip and the answer's
// bytes.
//
// --fixture varied also opens a second page per sample on the varied
// workspace (scripts/perf/transport.mjs, shape=varied) and measures opening
// its Board with the longest frame after the first card, scrolling and one
// drag over it, going back to the Overview and then to the Board again,
// each with the longest frame after the view first showed and the longest
// key press delay of the switch, and the phone's Roadmap task schedule.
// Each sample records the machine's load average in `loads`. --serve only
// builds and serves the pages, on --host (127.0.0.1 by default), until it
// is stopped.
import assert from 'node:assert/strict'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { loadavg, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { BaselineError, resolveBaseline } from './benchmark-backend.mjs'
import { gitIn } from './git.mjs'
import { buildPage, checkoutOf, programsFor, serve } from './perf/page.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1]
}
const root = resolve(option('root', join(here, '..')))
const sizes = option('sizes', '100,1000,10000').split(',').map(Number)
const samples = Number(option('samples', '5'))
const cpu = Number(option('cpu', '4'))
const latency = Number(option('latency', '100'))
const bandwidth = Number(option('mbps', '8'))
const output = option('output', '/tmp/qivo-browser-benchmark.json')
// long enough for the default 10,000 tasks: at 8 Mbps every result of
// theirs takes about 16 s, and marking 500 messages read takes two
const timeout = Number(option('timeout', '60000'))
// unread messages the bulk-read scenario adds just before it runs, so the
// earlier scenarios load the same workspace as before it existed
const messages = Number(option('messages', '500'))
const host = option('host', '127.0.0.1')
const varied = option('fixture', 'default') === 'varied'
// --baseline, with the revision when one follows it
const baselineAt = process.argv.indexOf('--baseline')
const baselineRevision =
  baselineAt < 0
    ? null
    : process.argv[baselineAt + 1] && !process.argv[baselineAt + 1].startsWith('--')
      ? process.argv[baselineAt + 1]
      : ''
/* The --baseline commit, resolved before anything is made, so a revision
   that is not usable stops here with nothing to clean up. */
let baseline = null
if (baselineRevision !== null) {
  try {
    // git in the measured checkout, which --root may name
    const git = (args) => gitIn(root, args)
    baseline = await resolveBaseline(baselineRevision ? [baselineRevision] : [], git)
  } catch (error) {
    if (!(error instanceof BaselineError)) throw error
    console.error(error.message)
    process.exit(1)
  }
}
const temporary = await mkdtemp(join(tmpdir(), 'qivo-browser-perf-'))
// Ctrl-C or a stop skips the finally below, so a measuring run removes its
// builds and the baseline checkout here, and keeps the sizes it finished
// with a note of where it stopped. --serve waits for the signal itself.
if (!process.argv.includes('--serve'))
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ])
    process.once(signal, () => {
      if (running) {
        report.failure = { ...running, message: `stopped by ${signal}` }
        writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
      }
      // a build still writing into the folder can make one removal fail,
      // so it is tried again before the process ends
      rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      process.exit(code)
    })
// the timed phases, each with its script, layout and style time and the
// number of App renders in it
const PHASES = [
  'searchOpen',
  'search',
  'navigation',
  'drag',
  'comments',
  'remote',
  'remoteWhilePending',
  'remoteSettle',
  'refusalWithTen',
  'markAllRead',
  'remoteCreate',
  'remoteProjectRename',
  'inboxMessage',
  'remoteStamp',
  'boardNavigation',
  'boardComplete',
  'boardRemote',
  'boardScroll',
  'boardFilter',
  'boardFilterClear',
  'phoneBoard',
  // with the Board open before, now hidden (a Board that stays loaded)
  'overviewAfterBoardRemote',
  'overviewAfterBoardEdit',
  'roadmapAfterBoardRemote',
  'roadmapAfterBoardEdit',
  ...(varied
    ? [
        'variedBoardNavigation',
        'variedBoardComplete',
        'variedBoardScroll',
        'variedBoardDragOver',
        'variedOverview',
        'variedOverviewComplete',
        'variedBoardReturn',
        'variedBoardReturnComplete',
        'variedPhoneRoadmap',
        'variedPhoneRoadmapComplete',
      ]
    : []),
]
// the medians --baseline prints side by side
const COMPARED = [
  ...[
    'remote',
    'remoteWhilePending',
    'remoteSettle',
    'refusalWithTen',
    'markAllRead',
    'drag',
    'remoteCreate',
    'remoteProjectRename',
    'inboxMessage',
    'remoteStamp',
    ...PHASES.filter((phase) => /^(board|phone|varied|overview|roadmap)/.test(phase)),
  ].flatMap((phase) => [`${phase}ScriptDurationMs`, `${phase}AppRenders`]),
  ...[
    'remote',
    'remoteCreate',
    'remoteProjectRename',
    'inboxMessage',
    'remoteStamp',
    'boardNavigation',
    'boardComplete',
    'boardRemote',
    'boardFilter',
    'boardFilterClear',
    'phoneBoard',
    'overviewAfterBoardRemote',
  ].map((phase) => `${phase}WireBytes`),
  // opening the Board from the click until every card is in
  'boardOpenToCompleteMs',
  'boardLongestSliceMs',
  'boardDomNodes',
  'boardHeapMb',
  'boardKeyDelayMs',
  'boardRemote',
  'overviewAfterBoardRemote',
  'overviewAfterBoardEdit',
  'roadmapAfterBoardRemote',
  'roadmapAfterBoardEdit',
  'afterBoardHeapMb',
  ...(varied
    ? [
        'variedBoardLongestFrameMs',
        'variedBoardKeyDelayMs',
        'variedOverview',
        'variedOverviewComplete',
        'variedOverviewLongestFrameMs',
        'variedOverviewKeyDelayMs',
        'variedBoardReturn',
        'variedBoardReturnComplete',
        'variedBoardReturnLongestFrameMs',
        'variedBoardReturnKeyDelayMs',
      ]
    : []),
]
let browser
const servers = []
let running
const report = {
  root,
  cpu,
  latency,
  bandwidthMbps: bandwidth,
  samples,
  timeoutMs: timeout,
  kind: 'authenticated production UI; synthetic transport',
  scenarios: [],
  // the one-minute load average after each sample
  loads: [],
}
// --trace prints each phase as it starts, to find a step that stalls
const trace = process.argv.includes('--trace')
const phase = (name) => {
  running.phase = name
  if (trace)
    console.error(`${running.label} ${running.tasks} tasks, sample ${running.sample}: ${name}`)
}
const summary = (values) => {
  const ordered = [...values].sort((a, b) => a - b)
  return {
    p50: ordered[Math.floor(ordered.length * 0.5)],
    p95: ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))],
    samples: values,
  }
}
const summarized = (tasks, metrics) => ({
  tasks,
  metrics: Object.fromEntries(
    Object.entries(metrics)
      .filter(([, values]) => values.length)
      .map(([key, values]) => [key, summary(values)]),
  ),
})

/** Opens the benchmark page at `origin` with `tasks` tasks and the extra
    `query`, throttled and on the slow network. Its `timed` adds the running
    phase's numbers to `metrics`. */
async function openPage(origin, tasks, metrics, query = '') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.setDefaultTimeout(timeout)
  const errors = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  page.on('console', (message) => {
    // the refusal the refusalWithTen phase asks for is logged as one
    const asked = running.phase === 'refusalWithTen' && message.text().includes('no write access')
    if (message.type() === 'error' && !asked) {
      errors.push(message.text())
      console.error(message.text())
    }
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
  await cdp.send('Performance.enable')
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency,
    downloadThroughput: bandwidth * 125000,
    uploadThroughput: bandwidth * 125000,
  })
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
  const appRenders = () => page.evaluate(() => window.__perf.appRenders)
  const wireBytes = () => page.evaluate(() => window.__perf.wireBytes)
  const decodeMs = () => page.evaluate(() => window.__perf.decodeMs)
  /* Times `operation` as the running phase, with its script, layout and
     style time, its App renders and the bytes delivered in it. */
  const timed = async (operation) => {
    const before = await cdp.send('Performance.getMetrics')
    const renders = await appRenders()
    const bytes = await wireBytes()
    const decoding = await decodeMs()
    const start = await page.evaluate(() => performance.now())
    await operation()
    await settle()
    const elapsed = (await page.evaluate(() => performance.now())) - start
    const after = await cdp.send('Performance.getMetrics')
    for (const metric of ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration']) {
      const value =
        (after.metrics.find((item) => item.name === metric).value -
          before.metrics.find((item) => item.name === metric).value) *
        1000
      const key = `${running.phase}${metric}Ms`
      metrics[key] ??= []
      metrics[key].push(value)
    }
    metrics[`${running.phase}AppRenders`] ??= []
    metrics[`${running.phase}AppRenders`].push((await appRenders()) - renders)
    metrics[`${running.phase}WireBytes`] ??= []
    metrics[`${running.phase}WireBytes`].push((await wireBytes()) - bytes)
    metrics[`${running.phase}DecodeMs`] ??= []
    metrics[`${running.phase}DecodeMs`].push((await decodeMs()) - decoding)
    return elapsed
  }
  await page.goto(
    `${origin}/?tasks=${tasks}&programs=${programsFor(tasks)}&latency=${latency}&mbps=${bandwidth}${query}`,
  )
  return { context, page, cdp, errors, settle, appRenders, timed }
}

/* The Board counts as complete when nothing on it waits to mount and, in a
   build whose Board asks the server, its answer arrived (data-board-state
   ok). A Board that mounts in slices marks its pending part with
   data-board-mount; one that mounts whole never sets it. Only the shown
   view counts: a Board kept hidden while another view shows (KeptView)
   waits until it shows again. */
const boardComplete = () => {
  const state = document.querySelector('[data-workspace-view] [data-board-root]')
  return (
    !document.querySelector('[data-workspace-view] [data-board-mount="pending"]') &&
    (state === null || state.getAttribute('data-board-state') === 'ok')
  )
}

/** How many cards the Board must show, as the stand-in server counts them:
    every task of the top-level project it opens but the parents, whose
    subtasks are their cards. */
const boardCards = (page) => page.evaluate(() => window.__perf.boardCards)

/** The heap in use after a collection, in MiB, and the page's elements. */
async function pageSize(page, cdp) {
  await cdp.send('HeapProfiler.collectGarbage')
  const performanceMetrics = await cdp.send('Performance.getMetrics')
  return {
    heapMb:
      performanceMetrics.metrics.find((metric) => metric.name === 'JSHeapUsedSize').value / 1048576,
    domNodes: await page.locator('*').count(),
  }
}

/** The element `locator` finds, found before a timed phase uses it. Each
    CSS selector a Playwright locator runs also reads every element on the
    page, to look into shadow roots, which on a page with a large Board or
    Roadmap takes longer than the app's own work, so a phase that searched
    inside its timing measured the search. A timed phase acts on the handle
    and waits with shows and the page's own functions instead. */
const handle = (locator) => locator.elementHandle({ timeout: timeout * 10 })

/** Presses Shift, which nothing handles, every 50ms until `stop`, which
    waits for the last press and throws what a press threw. */
function pressEvery50ms(page) {
  let pressing = true
  const loop = (async () => {
    while (pressing) {
      await page.keyboard.press('Shift')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })()
  // a failed press surfaces through stop, never as an unhandled rejection
  loop.catch(() => {})
  return {
    stop: () => {
      pressing = false
      return loop
    },
  }
}

/** Watches the page's animation frames and key presses, with a Shift
    press every 50ms, which nothing handles, from now until `stop`. Then
    `read(after)` answers the longest frame that started at page time
    `after` or later, and the longest any press waited for its turn. */
async function watchInput(page) {
  await page.evaluate(() => {
    const state = { frames: [], events: [], observers: [] }
    window.__watch = state
    const frames = new PerformanceObserver((list) => {
      state.frames.push(...list.getEntries())
    })
    frames.observe({ type: 'long-animation-frame' })
    const events = new PerformanceObserver((list) => {
      state.events.push(...list.getEntries())
    })
    events.observe({ type: 'event', durationThreshold: 16 })
    state.observers = [frames, events]
  })
  const presses = pressEvery50ms(page)
  return {
    stop: () => presses.stop(),
    read: (after) =>
      page.evaluate((after) => {
        const { frames, events, observers } = window.__watch
        const [frameObserver, eventObserver] = observers
        frames.push(...frameObserver.takeRecords())
        events.push(...eventObserver.takeRecords())
        for (const observer of observers) observer.disconnect()
        delete window.__watch
        return {
          frame: Math.max(
            0,
            ...frames.filter((entry) => entry.startTime >= after).map((entry) => entry.duration),
          ),
          keyDelay: Math.max(
            0,
            ...events
              .filter((entry) => entry.name === 'keydown')
              .map((entry) => entry.processingStart - entry.startTime),
          ),
        }
      }, after),
  }
}

/** The view switch's `name` button, for a timed phase to click. */
const viewButton = (page, name) =>
  handle(page.locator('[data-view-switch]').getByRole('radio', { name, exact: true }))

/** Waits inside a timed phase until the element that `selector` matches
    `nth` (from 0) shows, with the page's own querySelector on each frame,
    for the reason handle gives. */
const shows = (page, selector, nth = 0) =>
  page.waitForFunction(
    ([css, index]) =>
      !!(
        index ? document.querySelectorAll(css)[index] : document.querySelector(css)
      )?.checkVisibility(),
    [selector, nth],
    { timeout: timeout * 10 },
  )

/** Opens the Board from another view as `prefix`Navigation, until its first
    card shows, and `prefix`Complete, until every card is in, with input
    watched from the click: `prefix`KeyDelayMs is the longest a key press
    waited. Returns their sum and the longest animation frame that started
    after the first card showed (0 when it all happened in one). */
async function openBoard({ page, timed }, metrics, prefix) {
  await page.evaluate(() => {
    const state = { firstCardAt: null }
    window.__boardOpen = state
    const seen = new MutationObserver(() => {
      if (!document.querySelector('[data-card]')) return
      state.firstCardAt = performance.now()
      seen.disconnect()
    })
    seen.observe(document.body, { childList: true, subtree: true })
  })
  const button = await viewButton(page, 'Board')
  const watch = await watchInput(page)
  let navigation
  let complete
  try {
    phase(`${prefix}Navigation`)
    navigation = await timed(async () => {
      await button.click({ timeout: timeout * 10 })
      await shows(page, '[data-card]')
    })
    metrics[`${prefix}Navigation`].push(navigation)
    phase(`${prefix}Complete`)
    complete = await timed(() =>
      page.waitForFunction(boardComplete, null, { timeout: timeout * 10 }),
    )
    metrics[`${prefix}Complete`].push(complete)
  } finally {
    await watch.stop()
  }
  const firstCardAt = await page.evaluate(() => {
    const at = window.__boardOpen.firstCardAt
    delete window.__boardOpen
    return at
  })
  const { frame, keyDelay } = await watch.read(firstCardAt ?? Number.POSITIVE_INFINITY)
  metrics[`${prefix}KeyDelayMs`].push(keyDelay)
  return { openToComplete: navigation + complete, longest: frame }
}

/** Switches to the view `name` as `prefix`, until `first` shows (then
    `last`, when given), and `prefix`Complete, until nothing in the shown
    view waits to mount, with input watched from the click:
    `prefix`LongestFrameMs is the longest animation frame that started after
    `first` showed, and `prefix`KeyDelayMs the longest a key press waited
    during the whole switch. */
async function switchTo({ page, timed }, metrics, prefix, name, first, last) {
  const button = await viewButton(page, name)
  const watch = await watchInput(page)
  let shownAt = Number.POSITIVE_INFINITY
  try {
    phase(prefix)
    metrics[prefix].push(
      await timed(async () => {
        await button.click({ timeout: timeout * 10 })
        // on the frame that first shows it, so later frames can be told apart
        const shown = await page.waitForFunction(
          (css) => !!document.querySelector(css)?.checkVisibility() && performance.now(),
          first,
          { timeout: timeout * 10 },
        )
        shownAt = await shown.jsonValue()
        if (last) await shows(page, last)
      }),
    )
    phase(`${prefix}Complete`)
    metrics[`${prefix}Complete`].push(
      await timed(() => page.waitForFunction(boardComplete, null, { timeout: timeout * 10 })),
    )
  } finally {
    await watch.stop()
  }
  const { frame, keyDelay } = await watch.read(shownAt)
  metrics[`${prefix}LongestFrameMs`].push(frame)
  metrics[`${prefix}KeyDelayMs`].push(keyDelay)
}

/** Scrolls the Board's pane down by half its height every animation frame
    for 60 frames, then back to the top, as `name`. Programmatic scrolling
    keeps the lane wheel snap out of it. Records the longest frame as
    `name`LongestFrameMs. */
async function scrollBoard({ page, timed }, metrics, name) {
  phase(name)
  let longest = 0
  metrics[name].push(
    await timed(async () => {
      longest = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const pane = document.querySelector('[data-workspace-view="kanban"] [data-scroll]')
            if (!pane) throw new Error('The Board has no scrolling pane')
            let frames = 0
            let last = performance.now()
            let longestFrame = 0
            const step = (now) => {
              longestFrame = Math.max(longestFrame, now - last)
              last = now
              if (frames++ === 60) {
                pane.scrollTop = 0
                resolve(longestFrame)
                return
              }
              pane.scrollTop += pane.clientHeight / 2
              requestAnimationFrame(step)
            }
            requestAnimationFrame(step)
          }),
      )
    }),
  )
  metrics[`${name}LongestFrameMs`] ??= []
  metrics[`${name}LongestFrameMs`].push(longest)
}

/** How many rows Search shows for "signed firm", which every visible task
    of the stand-in holds: a build that searches on the server shows the
    stand-in's first page of 25 (scripts/perf/server.mjs searchPage), and a
    build from before it, which kept a browser index (src/lib/paletteSearch.ts),
    its first nine tasks. */
const searchRowsOf = (target, tasks) => Math.min(target.browserSearch ? 9 : 25, tasks)

/** Runs one sample of every scenario on the page at `origin` with `tasks`
    tasks, adding its numbers to `metrics`. `searchRows` is how many rows
    the build's Search shows for "signed firm" (searchRowsOf). */
async function runSample(origin, tasks, metrics, query = '', searchRows = Math.min(25, tasks)) {
  const opened = await openPage(origin, tasks, metrics, query)
  const { context, page, cdp, errors, settle, appRenders, timed } = opened
  await page.locator('[data-view-switch]').waitFor()
  await settle()
  metrics.startup.push(await page.evaluate(() => performance.now()))
  assert.equal(await page.evaluate(() => window.PLANNER.issues.length), tasks)
  const searchButton = await handle(page.locator('[data-sidebar-search]'))
  phase('searchOpen')
  metrics.searchOpen.push(
    await timed(async () => {
      await searchButton.click()
      await shows(page, '[role="dialog"] input[aria-label="Search tasks and projects"]')
    }),
  )
  const search = await handle(
    page.getByRole('dialog').getByRole('combobox', { name: 'Search tasks and projects' }),
  )
  // A build whose Search asks the server (search:page) waits 250 ms after
  // the last key and one round trip to the stand-in, so the phase includes
  // both; an older build filtered the loaded tasks in the browser at once.
  phase('search')
  metrics.search.push(
    await timed(async () => {
      await search.fill('signed firm')
      await shows(page, '[cmdk-item]')
    }),
  )
  assert.equal(await page.locator('[cmdk-item]').count(), searchRows)
  await page.keyboard.press('Escape')
  const roadmap = await viewButton(page, 'Roadmap')
  phase('navigation')
  metrics.navigation.push(
    await timed(async () => {
      await roadmap.click()
      await shows(page, '[data-roadmap-panel]')
      await shows(page, '[data-roadmap-task-open]')
    }),
  )
  // the Roadmap of the top-level project the app opens
  assert.equal(
    await page.locator('[data-roadmap-task-open]').count(),
    await page.evaluate(() => window.__perf.boardRows),
    'Every task title must remain available before scrolling',
  )
  const bar = page.locator('[data-bar]').first()
  await bar.waitFor()
  const styles = await bar.evaluate((element) => ({
    bar: getComputedStyle(element).position,
    cell: getComputedStyle(element.parentElement).position,
    row: getComputedStyle(element.closest('[data-roadmap-task-top]')).display,
  }))
  assert.deepEqual(
    styles,
    { bar: 'absolute', cell: 'relative', row: 'flex' },
    'Benchmark must include the production utility CSS',
  )
  await bar.hover()
  await settle()
  const bounds = await bar.boundingBox()
  const taskId = await bar.getAttribute('data-bar')
  const initial = await page.evaluate((id) => window.PLANNER.issueById[id].start, taskId)
  const writes = await page.evaluate(() => window.__perf.writes)
  phase('drag')
  assert.equal(
    await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[data-bar]')?.getAttribute('data-bar'),
      { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
    ),
    taskId,
    'The drag must hit its task bar',
  )
  metrics.drag.push(
    await timed(async () => {
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await page.mouse.down()
      await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2, {
        steps: 4,
      })
      await page.mouse.up()
      await page.waitForFunction((previous) => window.__perf.writes > previous, writes)
    }),
  )
  assert.notEqual(await page.evaluate((id) => window.PLANNER.issueById[id].start, taskId), initial)
  await page.locator('[data-roadmap-task-open]').first().click()
  phase('comments')
  await page.locator('[data-task-close]').waitFor()
  await page.waitForFunction(() => window.PLANNER.commentsLoaded)
  await settle()
  const renders = await appRenders()
  metrics.comments.push(
    await timed(async () => {
      const body = await page.evaluate(() => window.__perf.deliverComments())
      await page.waitForFunction(
        (text) =>
          [...document.querySelectorAll('[data-comment]')].some(
            (comment) => comment.textContent.includes(text) && comment.checkVisibility(),
          ),
        body,
      )
    }),
  )
  metrics.commentAppRenders.push((await appRenders()) - renders)
  const roadmapSize = await pageSize(page, cdp)
  metrics.heapMb.push(roadmapSize.heapMb)
  metrics.domNodes.push(roadmapSize.domNodes)
  await page.locator('[data-task-close]').click()
  await settle()
  const paintTimer = () => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)))
  /* Waits until no toast shows. A toast leaves 4.2 s after it came, which
     renders the app, so one leaving inside a timed phase would count. */
  const noToasts = () =>
    page.waitForFunction(
      () => !document.querySelector('[data-float-slot="toasts"]')?.children.length,
      null,
      { timeout: timeout * 2 },
    )
  await noToasts()
  // Another person's change with nothing of this person's waiting: the
  // repaint every delivery costs.
  phase('remote')
  metrics.remote.push(
    await timed(async () => {
      await page.evaluate(() => window.__perf.deliverRemote(2))
      await paintTimer()
    }),
  )
  // Writes waiting for their answer: another person's change arrives
  // while one waits, then the write answers with its own echo.
  const heldCount = (n) => page.waitForFunction((count) => window.__perf.held() === count, n)
  await page.evaluate(() => window.__perf.hold())
  // not awaited in the page: the write waits until it is released
  await page.evaluate(() => {
    void window.PLANNER.updateIssue(window.PLANNER.issues[0].id, { title: 'Pending edit' })
  })
  await heldCount(1)
  phase('remoteWhilePending')
  metrics.remoteWhilePending.push(
    await timed(async () => {
      await page.evaluate(() => window.__perf.deliverRemote(1))
      await paintTimer()
    }),
  )
  const before = await page.evaluate(() => window.__perf.writes)
  phase('remoteSettle')
  metrics.remoteSettle.push(
    await timed(async () => {
      await page.evaluate(() => window.__perf.releaseAll())
      await page.waitForFunction((count) => window.__perf.writes > count, before)
      await paintTimer()
    }),
  )
  assert.equal(await page.evaluate(() => window.PLANNER.issues[0].title), 'Pending edit')
  // A refusal while ten other edits wait: only its own change goes.
  await page.evaluate(() => {
    window.__perf.hold()
    for (const [n, task] of window.PLANNER.issues.slice(0, 11).entries())
      window.PLANNER.updateIssue(task.id, { title: `Layer ${n}` })
  })
  await heldCount(11)
  phase('refusalWithTen')
  metrics.refusalWithTen.push(
    await timed(async () => {
      await page.evaluate(() => window.__perf.releaseOne(true))
      await page.waitForFunction(() => window.PLANNER.issues[0].title !== 'Layer 0')
      await paintTimer()
    }),
  )
  await page.evaluate(() => window.__perf.releaseAll())
  await page.waitForFunction(() => !window.PLANNER.roadmapUndo.busy)
  await noToasts()
  // Mark all as read over `messages` new unread messages.
  await page.evaluate((count) => window.__perf.seedMessages(count), messages)
  // one inbox item per task the messages land on
  await page.waitForFunction(
    (items) => window.PLANNER.unreadMessages >= items,
    Math.min(messages, tasks),
  )
  phase('markAllRead')
  metrics.markAllRead.push(
    await timed(async () => {
      await page.evaluate(
        (limit) =>
          Promise.race([
            window.PLANNER.markAllMessagesRead(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Mark all as read did not finish')), limit),
            ),
          ]),
        timeout,
      )
      await paintTimer()
    }),
  )
  assert.equal(await page.evaluate(() => window.PLANNER.unreadMessages), 0)
  await noToasts()
  // Other people's changes besides a rename, each one delivery: a new
  // task, a renamed project, a new inbox message and a Team sync stamp.
  phase('remoteCreate')
  metrics.remoteCreate.push(
    await timed(async () => {
      await page.evaluate(() => window.__perf.deliverCreate())
      await paintTimer()
    }),
  )
  assert.equal(await page.evaluate(() => window.PLANNER.issues.length), tasks + 1)
  phase('remoteProjectRename')
  metrics.remoteProjectRename.push(
    await timed(async () => {
      await page.evaluate(() => window.__perf.deliverProjectRename())
      await paintTimer()
    }),
  )
  phase('inboxMessage')
  metrics.inboxMessage.push(
    await timed(async () => {
      await page.evaluate(() => window.__perf.deliverMessage())
      await paintTimer()
    }),
  )
  assert.equal(await page.evaluate(() => window.PLANNER.unreadMessages), 1)
  phase('remoteStamp')
  metrics.remoteStamp.push(
    await timed(async () => {
      await page.evaluate(() => window.__perf.deliverStamp())
      await paintTimer()
    }),
  )
  phase('offscreen focus')
  const lastTask = page.locator('[data-roadmap-task-open]').last()
  const lastId = await lastTask.getAttribute('data-roadmap-task-open')
  await lastTask.focus()
  await settle()
  const rowHeight = await lastTask.evaluate(
    (element) => element.closest('[data-roadmap-task-top]').getBoundingClientRect().height,
  )
  assert.equal(rowHeight, 35, 'Task row height must match dependency geometry')
  await page.keyboard.press('Enter')
  await page.locator('[data-task-close]').waitFor()
  assert.ok(
    (await page.locator('[data-issue-key]').textContent()).includes(lastId),
    'Offscreen keyboard focus must open the selected task',
  )
  await page.locator('[data-task-close]').click()
  await settle()
  await noToasts()
  // The Board renders every card, so a delivery there repaints them all
  // unless the cards skip the tasks that did not change. Opening it can take
  // a baseline far longer than any other step.
  const board = await openBoard(opened, metrics, 'board')
  metrics.boardOpenToCompleteMs.push(board.openToComplete)
  metrics.boardLongestSliceMs.push(board.longest)
  assert.equal(
    await page.locator('[data-card]').count(),
    await boardCards(page),
    'The Board must show every task of its project',
  )
  const boardSize = await pageSize(page, cdp)
  metrics.boardHeapMb.push(boardSize.heapMb)
  metrics.boardDomNodes.push(boardSize.domNodes)
  phase('boardRemote')
  metrics.boardRemote.push(
    await timed(async () => {
      await page.evaluate(() => window.__perf.deliverRemote(3))
      await paintTimer()
    }),
  )
  const renamed = await page.evaluate(() => window.PLANNER.issues[3].title)
  assert.equal(
    await page.locator('[data-card]', { hasText: renamed }).count(),
    1,
    'The Board must show the remote rename',
  )
  await scrollBoard(opened, metrics, 'boardScroll')
  // A filter that matches nothing, then clearing it, which brings every card
  // back.
  // the Board's own filter row: a Roadmap kept hidden holds another field
  const filter = await handle(
    page.locator('[data-filter-row]').getByPlaceholder('Filter tasks…', { exact: true }),
  )
  phase('boardFilter')
  metrics.boardFilter.push(
    await timed(async () => {
      await filter.fill('no-such-task-zz', { timeout: timeout * 10 })
      await page.waitForFunction(() => !document.querySelector('[data-card]'), null, {
        timeout: timeout * 10,
      })
    }),
  )
  // until every card is back; the first card's time is boardFilterFirstCardMs
  phase('boardFilterClear')
  let firstCard = 0
  metrics.boardFilterClear.push(
    await timed(async () => {
      const start = await page.evaluate(() => performance.now())
      await filter.fill('', { timeout: timeout * 10 })
      await shows(page, '[data-card]')
      firstCard = (await page.evaluate(() => performance.now())) - start
      await page.waitForFunction(boardComplete, null, { timeout: timeout * 10 })
    }),
  )
  metrics.boardFilterFirstCardMs.push(firstCard)
  assert.equal(
    await page.locator('[data-card]').count(),
    await boardCards(page),
    'Clearing must bring every task of the project back',
  )
  // A phone shows the task list in place of the Board.
  phase('phoneBoard')
  let phoneFirstCard = 0
  metrics.phoneBoard.push(
    await timed(async () => {
      const start = await page.evaluate(() => performance.now())
      await page.setViewportSize({ width: 390, height: 844 })
      await shows(page, '.mobile-task-list [data-card]')
      phoneFirstCard = (await page.evaluate(() => performance.now())) - start
      await page.waitForFunction(boardComplete, null, { timeout: timeout * 10 })
    }),
  )
  metrics.phoneBoardFirstCardMs.push(phoneFirstCard)
  assert.equal(
    await page.locator('.mobile-task-list [data-card]').count(),
    await page.evaluate(() => window.__perf.boardRows),
    'The phone list must show every task of the project',
  )
  await page.setViewportSize({ width: 1440, height: 1000 })
  await shows(page, '[data-workspace-view="kanban"] [data-card]')
  await page.waitForFunction(boardComplete, null, { timeout: timeout * 10 })
  /* The Overview and the Roadmap after the Board was open, which a Board
     that stays loaded (KeptView) keeps hidden: the memory the page holds,
     and another person's change and one of this person's own on each. */
  await (await viewButton(page, 'Overview')).click({ timeout: timeout * 10 })
  await shows(page, '[data-ov-strip]')
  await page.waitForFunction(boardComplete, null, { timeout: timeout * 10 })
  const afterBoard = await pageSize(page, cdp)
  metrics.afterBoardHeapMb.push(afterBoard.heapMb)
  metrics.afterBoardDomNodes.push(afterBoard.domNodes)
  /** Times another person's rename of task `remote`, then this person's
      own rename of task `own`, as `prefix`Remote and `prefix`Edit. */
  const changes = async (prefix, remote, own) => {
    await settle()
    await noToasts()
    phase(`${prefix}Remote`)
    metrics[`${prefix}Remote`].push(
      await timed(async () => {
        await page.evaluate((n) => window.__perf.deliverRemote(n), remote)
        await paintTimer()
      }),
    )
    const written = await page.evaluate(() => window.__perf.writes)
    phase(`${prefix}Edit`)
    metrics[`${prefix}Edit`].push(
      await timed(async () => {
        await page.evaluate((n) => {
          void window.PLANNER.updateIssue(window.PLANNER.issues[n].id, { title: `Own edit ${n}` })
        }, own)
        await paintTimer()
      }),
    )
    // its answer lands before the next phase
    await page.waitForFunction((count) => window.__perf.writes > count, written, {
      timeout: timeout * 2,
    })
  }
  await changes('overviewAfterBoard', 5, 6)
  await (await viewButton(page, 'Roadmap')).click({ timeout: timeout * 10 })
  await shows(page, '[data-roadmap-task-open]')
  await page.waitForFunction(boardComplete, null, { timeout: timeout * 10 })
  await changes('roadmapAfterBoard', 7, 8)
  assert.deepEqual(errors, [], `Browser errors at ${tasks} tasks`)
  await context.close()
}

/** Runs one sample on the varied workspace: opens the Board right after
    startup, scrolls it and drags one card into the next status. */
async function runVariedSample(origin, tasks, metrics, query = '') {
  phase('variedStartup')
  const opened = await openPage(origin, tasks, metrics, `&shape=varied${query}`)
  const { context, page, errors, settle, timed } = opened
  await page.locator('[data-view-switch]').waitFor()
  await settle()
  metrics.variedBoardLongestFrameMs.push((await openBoard(opened, metrics, 'variedBoard')).longest)
  await scrollBoard(opened, metrics, 'variedBoardScroll')
  // A drag from the first lane's To Do into its In Progress, the way
  // board-cards-smoke.mjs drives one, with only the dragover timed.
  const lane = page.locator('.board-lane').first()
  phase('variedBoardDragStart')
  // the dragged task's own row, which the drop moves to In Progress
  const id = await lane
    .locator('[data-board-cell][data-status="todo"] [data-card][draggable="true"]')
    .first()
    .getAttribute('data-card')
  const source = page.locator(`[data-card="${id}"]`)
  const target = await handle(lane.locator('[data-board-cell][data-status="progress"]'))
  await source.scrollIntoViewIfNeeded()
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await source.dispatchEvent('dragstart', { dataTransfer: transfer })
  await settle()
  phase('variedBoardDragOver')
  metrics.variedBoardDragOver.push(
    await timed(async () => {
      const accepted = await target.evaluate((element, dataTransfer) => {
        const event = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer })
        element.dispatchEvent(event)
        return event.defaultPrevented
      }, transfer)
      assert.equal(accepted, true, 'In Progress must accept the drag')
    }),
  )
  phase('variedBoardDrop')
  const writes = await page.evaluate(() => window.__perf.writes)
  await target.dispatchEvent('drop', { dataTransfer: transfer })
  await page.waitForFunction((previous) => window.__perf.writes > previous, writes, {
    timeout: timeout * 10,
  })
  await source.dispatchEvent('dragend', { dataTransfer: transfer })
  await transfer.dispose()
  await settle()
  /* Back to the Overview until its first screen shows, then until its
     lists are complete, and to the Board again, which a Board that stays
     loaded (KeptView) shows without mounting it anew. */
  await switchTo(
    opened,
    metrics,
    'variedOverview',
    'Overview',
    '[data-ov-strip]',
    '[data-atrisk], [data-ovrow]',
  )
  await switchTo(
    opened,
    metrics,
    'variedBoardReturn',
    'Board',
    '[data-workspace-view="kanban"] [data-card]',
  )
  // the phone's Roadmap below starts from the Overview, as before
  await (await viewButton(page, 'Overview')).click({ timeout: timeout * 10 })
  await shows(page, '[data-ov-strip]')
  // The phone's Roadmap: its task schedule until the first row shows, then
  // until every row is in.
  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .locator('[data-view-switch]')
    .getByRole('radio', { name: 'Roadmap', exact: true })
    .click({ timeout: timeout * 10 })
  const schedule = await handle(page.getByRole('button', { name: 'Task schedule', exact: true }))
  await settle()
  phase('variedPhoneRoadmap')
  metrics.variedPhoneRoadmap.push(
    await timed(async () => {
      // the phone's bottom navigation can sit over the button, so a
      // pointer click would land on it
      await schedule.evaluate((button) => button.click())
      await shows(
        page,
        '.mobile-roadmap-task-list .mobile-roadmap-row, .mobile-roadmap-section > .mobile-roadmap-row',
      )
    }),
  )
  phase('variedPhoneRoadmapComplete')
  metrics.variedPhoneRoadmapComplete.push(
    await timed(() => page.waitForFunction(boardComplete, null, { timeout: timeout * 10 })),
  )
  assert.deepEqual(errors, [], `Browser errors at ${tasks} varied tasks`)
  await context.close()
}

/** Empty metric lists for one size. */
const emptyMetrics = () =>
  Object.fromEntries(
    [
      ...PHASES,
      'startup',
      'commentAppRenders',
      'heapMb',
      'domNodes',
      'boardOpenToCompleteMs',
      'boardLongestSliceMs',
      'boardDomNodes',
      'boardHeapMb',
      'boardFilterFirstCardMs',
      'phoneBoardFirstCardMs',
      'boardKeyDelayMs',
      'afterBoardHeapMb',
      'afterBoardDomNodes',
      'variedBoardLongestFrameMs',
      'variedBoardKeyDelayMs',
      'variedOverviewLongestFrameMs',
      'variedOverviewKeyDelayMs',
      'variedBoardReturnLongestFrameMs',
      'variedBoardReturnKeyDelayMs',
    ].map((key) => [key, []]),
  )

/** The medians of `scenarios` against the baseline's, one row per size and
    metric, with the change. */
function comparison(scenarios, baseline) {
  return scenarios.flatMap(({ tasks, metrics }) => {
    const old = baseline.find((scenario) => scenario.tasks === tasks)?.metrics ?? {}
    return COMPARED.filter((key) => metrics[key] || old[key]).map((key) => {
      const now = metrics[key]?.p50
      const then = old[key]?.p50
      return {
        tasks,
        metric: key,
        baseline: then === undefined ? '' : Math.round(then),
        branch: now === undefined ? '' : Math.round(now),
        change: then ? `${Math.round(((now - then) / then) * 100)}%` : '',
      }
    })
  })
}

const targets = [{ label: 'branch', source: root, scenarios: report.scenarios }]
try {
  if (baseline !== null) {
    report.baseline = { commit: baseline.commit, chosen: baseline.chosen, scenarios: [] }
    targets.push({
      label: 'baseline',
      source: await checkoutOf(root, baseline.commit, temporary),
      scenarios: report.baseline.scenarios,
    })
  }
  for (const target of targets) {
    const outDir = join(temporary, `dist-${target.label}`)
    await buildPage(target.source, outDir, temporary)
    const server = await serve(outDir, process.argv.includes('--serve') ? host : '127.0.0.1')
    servers.push(server)
    target.origin = server.origin
    // an app from before it derived the load of the tasks it shows from
    // their rows gets those load rows too, as its own server sent them
    target.query = existsSync(join(target.source, 'convex/lib/loadRows.ts')) ? '' : '&shownload=1'
    target.browserSearch = existsSync(join(target.source, 'src/lib/paletteSearch.ts'))
  }
  if (process.argv.includes('--serve')) {
    for (const target of targets)
      console.log(
        `Benchmark workspace (${target.label}): ${target.origin}/?tasks=${sizes[0]}&programs=${programsFor(sizes[0])}&latency=${latency}&mbps=${bandwidth}${varied ? '&shape=varied' : ''}${target.query}`,
      )
    // a supervised service stops with SIGTERM
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
    process.exitCode = 0
  } else {
    // the handlers above stop the run; the browser goes with the process
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
    for (const tasks of sizes) {
      for (const target of targets) target.metrics = emptyMetrics()
      for (let sample = 0; sample < samples; sample++) {
        // the targets take turns, so both run under the same load
        for (const target of targets) {
          running = { label: target.label, tasks, sample: sample + 1, phase: 'startup' }
          await runSample(
            target.origin,
            tasks,
            target.metrics,
            target.query,
            searchRowsOf(target, tasks),
          )
          if (varied) await runVariedSample(target.origin, tasks, target.metrics, target.query)
          // the machine's load, which moves single numbers a lot
          const load = loadavg()[0]
          report.loads.push({ target: target.label, tasks, sample: sample + 1, load })
          console.log(
            `${target.label}, ${tasks} tasks: sample ${sample + 1}/${samples}, load ${load.toFixed(2)}`,
          )
        }
      }
      for (const target of targets) target.scenarios.push(summarized(tasks, target.metrics))
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
    }
    console.log(JSON.stringify(report, null, 2))
    if (report.baseline) {
      console.log(
        `Baseline ${report.baseline.commit.slice(0, 12)} (${report.baseline.chosen}), medians of ${samples} samples taken in turns at ${cpu}x CPU throttling, times in ms, heap in MiB:`,
      )
      console.table(comparison(report.scenarios, report.baseline.scenarios))
    }
  }
} catch (error) {
  if (running) {
    report.failure = {
      target: running.label,
      tasks: running.tasks,
      sample: running.sample,
      phase: running.phase,
      message: error.message,
    }
    for (const target of targets)
      if (target.metrics && !target.scenarios.some((scenario) => scenario.tasks === running.tasks))
        target.scenarios.push(summarized(running.tasks, target.metrics))
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  }
  throw error
} finally {
  await browser?.close()
  for (const server of servers) await server.close()
  await rm(temporary, { recursive: true, force: true })
}

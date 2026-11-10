// Real production UI/store; synthetic transport isolates CPU/DOM costs from backend variance.
//
//   node scripts/benchmark-browser.mjs [--browser chromium|firefox|webkit]
//     [--sizes 100,958] [--samples 5] [--cpu 4]
//     [--baseline [revision]] [--root checkout] [--output file.json]
//     [--fixture varied] [--files parameters] [--serve [--host address]]
//
// The options are read in scripts/perf/options.mjs, which its test checks.
//
// --browser picks the browser Playwright drives, Chromium by default.
// Chromium's own figures come from a CDP session, which Firefox and WebKit
// do not have, so there the run skips the CPU slowdown
// (Emulation.setCPUThrottlingRate), the shaping of the page's own requests
// (Network.emulateNetworkConditions), each phase's script, layout and style
// time (Performance.getMetrics) and the heap after a collection
// (HeapProfiler.collectGarbage), and names each one in report.skipped and
// in its output. It also leaves out and names the longest animation frames
// and key press delays in a browser that reports no such entries (long
// animation frames are Chromium's alone). The stand-in's own latency and
// bandwidth delay every answer in all three browsers alike
// (scripts/perf/server.mjs latency and mbps). --cpu is the CPU slowdown, 4
// in Chromium by default for Chromium's own figures. Firefox and WebKit run
// at 1 and refuse another. At --cpu 1 Chromium does not shape its page's
// own requests either (report.shapedRequests), so a run at --cpu 1 in each
// of the three is the condition that compares them.
//
// Each --sizes case puts that many visible tasks in the stand-in's
// workspace, in top-level projects of 3 sub-projects each (perf/page.mjs
// programsFor, perf/options.mjs SIZE_CASE_SHAPE), with one hidden
// sub-project as full as a visible one. The stand-in makes every sixth
// task Done, so the default 100 is an everyday project, and 958 is 799
// open tasks of one project with 159 Done, fewer than 300 open in each
// sub-project. The sample's create of one open task takes that project to
// the design size's 800 open tasks, and so does another person's create
// (remoteCreate), each deleted again before the next; its status changes
// move tasks between open statuses only (perf/options.mjs STATUS_WRITES).
// Neither case raises two figures at once, and no phase passes the design
// size (perf/options.test.mjs counts the tasks after each).
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
// render counts (*AppRenders) do not depend on load at all. A revision from
// after the workspace parts and before the workspace's projects part went
// subscribes that part (workspace.projects) and sizes its windows from root
// fields this checkout's perf server no longer sends, so it cannot load
// here, and the perf server answers its read of the part with an error that
// says so; measure such a revision with its own checkout's benchmark on the
// same machine instead. So it is for a revision before the Inbox feed,
// whose workspace waits for the inbox part (workspace.inbox), which this
// checkout's perf server no longer answers either. A revision from before
// the task windows went still has the ask for every task, which nothing
// calls once this driver dropped its task load, so its store
// holds no task either and both arms run the same phases.
//
// Every sample ends on the Overview and the Roadmap after the Board was
// open (which stays loaded, hidden): the page's memory, and a remote change
// and a local edit on each (overviewAfterBoard*, roadmapAfterBoard*).
//
// The Board answers one top-level project from the server (tasks:board),
// at most 1,000 tasks. The workspace spreads its tasks over a top-level
// project for each 1,000 of them or part of them (perf/page.mjs
// programsFor), so the one the app opens holds every task of a case up to
// 1,000, in a build that filters in the browser as in one that asks the
// server. The Board's phases wait for its answer where the build marks
// its state (data-board-state), so they include the round trip and the
// answer's bytes.
//
// --fixture varied also opens a second page per sample on the varied
// workspace (scripts/perf/transport.mjs, shape=varied) and measures opening
// its Board with the longest frame after the first card, scrolling and one
// drag over it, going back to the Overview and then to the Board again,
// each with the longest frame after the view first showed and the longest
// key press delay of the switch, and the phone's Roadmap task schedule.
// It also opens a third page on a workspace whose one project holds 1,000
// tasks over 3 sub-projects, a fifth of them Done (the design size's 800
// open and 200 Done tasks of a project, at their sum), with that project
// saved as Team sync's scope (scripts/perf/server.mjs syncscope=program),
// and measures Team sync: opening it from the sidebar until the opening's
// facts show (syncOpen, with the longest frame after they first showed,
// syncLongestFrameMs), Next to the first person's columns (syncNext), a
// Remaining typed on that person's first card and Enter until the person's
// load moves (syncEdit), a press on that card's owner until its list shows
// the owner and one more person (syncOwnerOpen), and a press on its @ until
// the Mention window shows its first person (syncMentionOpen); on this
// branch both lists read their people from the server as they open, on a
// build before the owner pickers from the workspace's roster. On this
// branch the meeting is the server's agenda
// and the card is one only the agenda brings; a build whose Team sync asks
// for every task first (--baseline before the agenda view) loads every
// task inside syncOpen and edits a task the workspace holds, so its
// complete means every task held and the meeting derived from them.
// --files adds the stand-in's file parameters (scripts/perf/server.mjs) to
// every page the run opens, for example `--files images=100` for a first
// task with 100 description images or `--files people=1000&pictures=1` for
// 1,000 pictures. The page then serves the stand-in's perf.invalid file
// URLs itself (scripts/perf/files.mjs routePerfFiles), and each sample
// records the image and picture downloads it served (fileDownloads,
// pictureDownloads), the most of each in flight at once (fileMostInFlight,
// pictureMostInFlight) and their bytes (fileBytesServed).
// Each sample records the machine's load average in `loads`. --serve only
// builds and serves the pages, on --host (127.0.0.1 by default), until it
// is stopped.
//
// --thread 100,200,300,500,1000 measures only the task window's thread, for
// each figure the comments and changes it keeps loaded (THREAD_KEEP,
// src/lib/threadBudget.ts, which the page lowers with threadkeep). Each case
// raises one figure: Comments on a task with 1,000 comments, and All on a
// task with 30 comments and 1,000 changes, ordinary text throughout
// (scripts/perf/server.mjs thread). It opens the task from the Roadmap and
// presses Show earlier until the store holds the figure, then times the
// press made while it holds it, or the last press when nothing earlier is
// left (threadEarlier), a comment another person posts (threadArrival) and
// Show newer when it shows (threadNewer), each until its rows show, with
// the longest animation frame from the press or the delivery on
// (*LongestFrameMs), and records the heap and the page's elements after
// them. The figures take turns in each sample, so every figure runs under
// the same load. Each sample then times the return to a hidden page
// (threadReturn) for 10, 49 and 60 comments, below the live window's 50,
// at its edge and past it: a task with 200 comments and 200 changes opened
// from the Roadmap under All, Show earlier pressed until the store holds
// the budget (THREAD_KEEP, 150 rows), the page hidden by overriding
// document.visibilityState and dispatching visibilitychange, the comments
// posted at once, and the page shown again, timed from the show until the
// newest of them shows with no thread page loading and, in a build that
// marks it, the window's reads current (data-task-window-reads), with the
// longest animation frame from the show on. threadReturnArrivedHidden says
// whether their delivery reached the page while it was hidden. The
// window's reads pause while the page is hidden, so it does not (0), and
// the comments arrive on the return, which then reads the thread again.
// The perf server keeps them for the thread the page read last. --phone
// runs the same with the window at the phone's 390 by 844, which it
// narrows to once the task is open, as the phone phases above do.
import assert from 'node:assert/strict'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, firefox, webkit } from 'playwright'
import { BaselineError, resolveBaseline } from './benchmark-backend.mjs'
import { gitIn } from './git.mjs'
import { routePerfFiles, servesFiles } from './perf/files.mjs'
import {
  benchmarkOptions,
  OptionsError,
  SIZE_CASE_SHAPE,
  STATUS_WRITES,
  workspaceParameters,
} from './perf/options.mjs'
import { buildPage, checkoutOf, serve } from './perf/page.mjs'

const options = (() => {
  try {
    return benchmarkOptions(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof OptionsError)) throw error
    console.error(error.message)
    process.exit(1)
  }
})()
const {
  browser: browserName,
  root,
  sizes,
  samples,
  cpu,
  latency,
  bandwidth,
  output,
  timeout,
  messages,
  host,
  varied,
  threadFigures,
  phone,
  filesQuery,
  baselineRevision,
  trace,
} = options
/* Whether the page gets a CDP session, which only Chromium has. The CPU
   slowdown, the shaping of the page's own requests, the script, layout and
   style times of every phase and the heap after a collection come from it,
   so the other browsers' output names them as skipped (report.skipped). */
const devtools = browserName === 'chromium'
/* Whether Chromium also shapes the page's own requests, its assets and
   files, to --latency and --mbps. Only a slowed run does, since at --cpu 1
   the run is the condition the three browsers share. */
const shapesRequests = devtools && cpu !== 1
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
if (!options.serve)
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
// number of App renders in it. The app holds no task, so `startup` is the
// startup with the root part alone. It lasts until the project the app
// opens shows a view (startedOn), which follows the projectNav.resolve
// check of the remembered project. Every phase reads its tasks from a
// view's answer or a task window's: the Roadmap's navigation and drag from
// the Roadmap's (tasks.roadmap), the person's own create from its send to
// its confirmation, `comments` in a window opened from a Roadmap row, which
// shows its task from its own answer (taskWindow.task), and the person's
// own writes after it (remoteWhilePending, remoteSettle, refusalWithTen and
// the *AfterBoardEdit phases) as status changes of tasks the Roadmap's or
// the Board's answer brings, which the store sends from the view's row
// (store/planner.ts updateViewTask), as the Board's drop does. Against
// reports from before the task windows went, taskLoad is gone and those
// writes changed meaning: they were title edits of held tasks, which a
// view's row cannot send, so they repaint a status where they repainted a
// title
const PHASES = [
  'searchOpen',
  'search',
  'navigation',
  'drag',
  'create',
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
        'syncOpen',
        'syncNext',
        'syncEdit',
        'syncOwnerOpen',
        'syncMentionOpen',
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
    'create',
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
  // the startup and the person's own create
  'startup',
  'create',
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
        'syncOpen',
        'syncNext',
        'syncEdit',
        'syncOwnerOpen',
        'syncMentionOpen',
        'syncLongestFrameMs',
        'syncOpenWireBytes',
      ]
    : []),
]
let browser
const servers = []
let running
const report = {
  root,
  browser: browserName,
  cpu,
  shapedRequests: shapesRequests,
  latency,
  bandwidthMbps: bandwidth,
  samples,
  timeoutMs: timeout,
  kind: 'authenticated production UI; synthetic transport',
  scenarios: [],
  // the one-minute load average after each sample
  loads: [],
  // the figures this browser cannot give, which its scenarios leave out
  skipped: devtools
    ? []
    : [
        'CPU slowdown (Emulation.setCPUThrottlingRate)',
        "shaping of the page's own requests (Network.emulateNetworkConditions)",
        '*ScriptDurationMs, *LayoutDurationMs and *RecalcStyleDurationMs (Performance.getMetrics)',
        'heapMb (HeapProfiler.collectGarbage and Performance.getMetrics)',
      ],
}
const phase = (name) => {
  running.phase = name
  if (trace)
    console.error(`${running.label} ${running.tasks} tasks, sample ${running.sample}: ${name}`)
}
/* A figure this browser cannot give is pushed as null and left out. */
const summary = (values) => {
  const ordered = values.filter((value) => value !== null).sort((a, b) => a - b)
  return {
    p50: ordered[Math.floor(ordered.length * 0.5)],
    p95: ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))],
    samples: values,
  }
}
/* The medians of `metrics` for `tasks`. A figure the browser gave in no
   sample joins report.skipped by its key, unless the list names it. */
const summarized = (tasks, metrics) => {
  for (const [key, values] of Object.entries(metrics))
    if (
      values.length &&
      values.every((value) => value === null) &&
      !report.skipped.some((named) => named === key || named.startsWith(`${key} `))
    )
      report.skipped.push(key)
  return {
    tasks,
    metrics: Object.fromEntries(
      Object.entries(metrics)
        .filter(([, values]) => values.some((value) => value !== null))
        .map(([key, values]) => [key, summary(values)]),
    ),
  }
}

/** Console message `message`'s text with the messages of the errors it
    logs. Firefox writes an Error argument by its name alone, so a refusal's
    sentence is read from the error itself. */
async function withErrorMessages(message) {
  const parts = await Promise.all(
    message
      .args()
      .map((arg) =>
        arg.evaluate((value) => (value instanceof Error ? value.message : '')).catch(() => ''),
      ),
  )
  return [message.text(), ...parts].join(' ')
}

/** Opens the benchmark page at `origin` with `tasks` tasks and the extra
    `query`, in Chromium throttled and on the slow network. Its `timed`
    adds the running phase's numbers to `metrics`. Its `cdp` is null in a
    browser without a CDP session. */
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
    if (message.type() !== 'error') return
    // the refusal the refusalWithTen phase asks for is logged as one
    const refusing = running.phase === 'refusalWithTen'
    void (async () => {
      const text = refusing ? await withErrorMessages(message) : message.text()
      if (refusing && text.includes('no write access')) return
      errors.push(message.text())
      console.error(message.text())
    })()
  })
  // the stand-in's own latency and bandwidth delay its answers in every
  // browser; Chromium also slows the CPU and, past --cpu 1, the page's own
  // requests
  const cdp = devtools ? await context.newCDPSession(page) : null
  if (cdp) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
    await cdp.send('Performance.enable')
  }
  if (cdp && shapesRequests) {
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency,
      downloadThroughput: bandwidth * 125000,
      uploadThroughput: bandwidth * 125000,
    })
  }
  // the stand-in's perf.invalid files, which only this page can serve
  const fileStats = servesFiles(query + filesQuery) ? await routePerfFiles(page) : null
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
  const appRenders = () => page.evaluate(() => window.__perf.appRenders)
  const wireBytes = () => page.evaluate(() => window.__perf.wireBytes)
  const decodeMs = () => page.evaluate(() => window.__perf.decodeMs)
  /* Times `operation` as the running phase, with its script, layout and
     style time where the browser gives them, its App renders and the bytes
     delivered in it. */
  const timed = async (operation) => {
    const before = cdp ? await cdp.send('Performance.getMetrics') : null
    const renders = await appRenders()
    const bytes = await wireBytes()
    const decoding = await decodeMs()
    const start = await page.evaluate(() => performance.now())
    await operation()
    await settle()
    const elapsed = (await page.evaluate(() => performance.now())) - start
    const after = cdp ? await cdp.send('Performance.getMetrics') : null
    for (const metric of after ? ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'] : []) {
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
    `${origin}/?${workspaceParameters(tasks)}&latency=${latency}&mbps=${bandwidth}${query}${filesQuery}`,
  )
  /* Adds the files the page served to `metrics`, once its sample ends. */
  const recordFiles = () => {
    if (!fileStats) return
    for (const [key, value] of [
      ['fileDownloads', fileStats.files],
      ['pictureDownloads', fileStats.avatars],
      ['fileMostInFlight', fileStats.mostInFlight.files],
      ['pictureMostInFlight', fileStats.mostInFlight.avatars],
      ['fileBytesServed', fileStats.bytes],
    ]) {
      metrics[key] ??= []
      metrics[key].push(value)
    }
  }
  return { context, page, cdp, errors, settle, appRenders, timed, recordFiles }
}

/* The shown view counts as complete when nothing on it waits to mount and,
   in a build whose views ask the server, their answers arrived: the
   Board's (data-board-state ok), and the Overview's summary
   (data-overview-state ok) with the first batch of each of its lists
   (data-ov-list-state no longer loading or refreshing) and its health
   table's first answer for the table on screen (data-ov-health-state
   neither loading nor refreshing, and no data-ov-health-kept), and the
   Roadmap's answer for the selection on screen (data-roadmap-state ok, not
   the last answer kept while a new one loads) with no Team utilization
   cell waiting for its owner's load (data-load-waiting), and the Overview's
   Upcoming milestones (data-overview-milestones' Upcoming section no longer
   loading or refreshing) where the page shows that section; Past reads
   nothing until it is opened, so it is not waited for. A build from before
   the Overview read its milestones from the server marks no such section
   and counts as complete without it, and a build from before the Roadmap
   read the server marks neither, so its Roadmap counts as complete once it
   shows. A view that mounts in slices marks its
   pending part with data-board-mount; one that mounts whole never sets
   it. Only the shown view counts: a view kept
   hidden while another one shows (KeptView) waits until it shows again. On
   main (7cd73dab) the Overview read its summary and lists from the server
   too, but derived its health table in the browser once every task had
   loaded, showing a loading note in its place until then; a build without
   data-ov-health counts as complete once that table (data-ov-table) shows
   in a project's or My view's Overview, which shows a health section, so
   both sides wait for the table. */
const boardComplete = () => {
  const state = document.querySelector('[data-workspace-view] [data-board-root]')
  const overview = document.querySelector('[data-workspace-view] [data-overview-root]')
  const lists = [...document.querySelectorAll('[data-workspace-view] [data-ov-list]')]
  const health = document.querySelector('[data-workspace-view] [data-ov-health]')
  const roadmap = document.querySelector('[data-workspace-view] [data-roadmap-root]')
  const upcoming = document.querySelector(
    '[data-workspace-view] [data-overview-milestones] [data-milestone-section="upcoming"]',
  )
  const healthSection = [
    ...document.querySelectorAll('[data-workspace-view] [data-overview-root] h2'),
  ].some((title) => (title.textContent ?? '').endsWith('health'))
  const healthDone =
    health !== null
      ? !['loading', 'refreshing'].includes(health.getAttribute('data-ov-health-state')) &&
        !health.hasAttribute('data-ov-health-kept')
      : !healthSection || document.querySelector('[data-workspace-view] [data-ov-table]') !== null
  return (
    !document.querySelector('[data-workspace-view] [data-board-mount="pending"]') &&
    (state === null || state.getAttribute('data-board-state') === 'ok') &&
    (roadmap === null || roadmap.getAttribute('data-roadmap-state') === 'ok') &&
    !document.querySelector('[data-workspace-view] [data-load-waiting]') &&
    (overview === null || overview.getAttribute('data-overview-state') === 'ok') &&
    (upcoming === null ||
      !['loading', 'refreshing'].includes(upcoming.getAttribute('data-milestone-section-state'))) &&
    lists.every(
      (list) => !['loading', 'refreshing'].includes(list.getAttribute('data-ov-list-state')),
    ) &&
    (overview === null || healthDone)
  )
}

/** Waits until the project the app opens shows a view. The stand-in
    server remembers its first program (scripts/perf/server.mjs prefs:get),
    which this branch opens once projectNav.resolve answered, with the top
    bar up meanwhile, and a build from before it opened at once as the
    first project; the project chooser is never a view. */
const startedOn = (page) => page.locator('[data-workspace-view]').first().waitFor()

/* What shows once the Overview's summary answered, on this branch, or its
   status strip on a build from before it asked the server. */
const OVERVIEW_SHOWN =
  '[data-workspace-view] [data-overview-root][data-overview-state="ok"], [data-workspace-view] [data-ov-strip]:not([data-overview-root] *)'

/** How many cards the Board must show, as the stand-in server counts them:
    every task of the top-level project it opens but the parents, whose
    subtasks are their cards. */
const boardCards = (page) => page.evaluate(() => window.__perf.boardCards)

/** The heap in use after a collection, in MiB (null without a CDP
    session), and the page's elements. */
async function pageSize(page, cdp) {
  if (!cdp) return { heapMb: null, domNodes: await page.locator('*').count() }
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
    `after` or later, and the longest any press waited for its turn. Each
    is null in a browser that reports no such entries (long animation
    frames are Chromium's alone), so the run leaves that figure out. */
async function watchInput(page) {
  await page.evaluate(() => {
    const supported = PerformanceObserver.supportedEntryTypes ?? []
    const state = {
      frames: [],
      events: [],
      observers: [],
      framesKnown: supported.includes('long-animation-frame'),
      eventsKnown: supported.includes('event'),
    }
    window.__watch = state
    const frames = new PerformanceObserver((list) => {
      state.frames.push(...list.getEntries())
    })
    if (state.framesKnown) frames.observe({ type: 'long-animation-frame' })
    const events = new PerformanceObserver((list) => {
      state.events.push(...list.getEntries())
    })
    if (state.eventsKnown) events.observe({ type: 'event', durationThreshold: 16 })
    state.observers = [frames, events]
  })
  const presses = pressEvery50ms(page)
  return {
    stop: () => presses.stop(),
    read: (after) =>
      page.evaluate((after) => {
        const { frames, events, observers, framesKnown, eventsKnown } = window.__watch
        const [frameObserver, eventObserver] = observers
        frames.push(...frameObserver.takeRecords())
        events.push(...eventObserver.takeRecords())
        for (const observer of observers) observer.disconnect()
        delete window.__watch
        return {
          frame: framesKnown
            ? Math.max(
                0,
                ...frames
                  .filter((entry) => entry.startTime >= after)
                  .map((entry) => entry.duration),
              )
            : null,
          keyDelay: eventsKnown
            ? Math.max(
                0,
                ...events
                  .filter((entry) => entry.name === 'keydown')
                  .map((entry) => entry.processingStart - entry.startTime),
              )
            : null,
        }
      }, after),
  }
}

/** Status changes for the `count` tasks after the first `skip` that view
    `slot`'s answer brings ('roadmap' or a Board's slot) and that are
    neither groups nor Done, each to another open status (STATUS_WRITES,
    perf/options.mjs), so no change takes a project past its open tasks of
    the design size: `{ id, status, was }` with the task's handle. The
    store sends them from the view's row (P.updateIssue, store/planner.ts
    updateViewTask), as the Board's drop does, since it holds no task to
    rename. */
const statusWrites = (page, slot, count, skip = 0) =>
  page.evaluate(
    ({ slot, count, skip, next }) => {
      const P = window.PLANNER
      const read = slot === 'roadmap' ? P.roadmapRead() : P.boardRead(slot)
      const rows = read.value?.state === 'ok' ? read.value.rows : []
      return rows
        .map((row) => P.viewTask(slot, row.id))
        .filter((it) => it && !it.isGroup && Object.hasOwn(next, it.status))
        .slice(skip, skip + count)
        .map((it) => ({ id: it.id, was: it.status, status: next[it.status] }))
    },
    { slot, count, skip, next: STATUS_WRITES },
  )

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
  const opened = await openPage(origin, tasks, metrics, `${SIZE_CASE_SHAPE}${query}`)
  const { context, page, cdp, errors, settle, appRenders, timed } = opened
  await startedOn(page)
  await settle()
  // the startup without task windows, as the app boots
  metrics.startup.push(await page.evaluate(() => performance.now()))
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
  await settle()
  const roadmap = await viewButton(page, 'Roadmap')
  // From the click until the Roadmap shows its rows: on this build its
  // answer for the selection (data-roadmap-state ok), with no task of the
  // workspace held; on a build from before it read the server, every task
  // loaded and the Roadmap drawn from them (data-roadmap-panel)
  phase('navigation')
  metrics.navigation.push(
    await timed(async () => {
      await roadmap.click()
      await shows(
        page,
        '[data-roadmap-root][data-roadmap-state="ok"] [data-roadmap-panel], [data-roadmap-panel]:not([data-roadmap-root] *)',
      )
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
  // the dragged task by its handle, held or only in the Roadmap's answer
  const initial = await page.evaluate((id) => window.PLANNER.anyTask(id).start, taskId)
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
  assert.notEqual(await page.evaluate((id) => window.PLANNER.anyTask(id).start, taskId), initial)
  // The person's own create into the sub-project of the task the drag
  // moved, which the person may write and the Roadmap's answer names, so
  // a build that holds no project list finds it answered in its project
  // cache, on a workspace that holds no task, from its send (P.addIssue)
  // to its confirmation (P.hasUnconfirmed). The stand-in stores and
  // answers it (issues:create), and deletes it again, untimed, so the
  // phases after it find the tasks they found before.
  phase('create')
  metrics.create.push(
    await timed(async () => {
      const made = await page.evaluate((id) => {
        const sub = window.PLANNER.anyTask(id).project
        return window.PLANNER.addIssue({
          project: sub,
          title: 'Check the spare sensors on the north bench before the cold week',
          status: 'todo',
          priority: 'medium',
        })
      }, taskId)
      assert.ok(made, 'The create must go out')
      await page.waitForFunction(() => !window.PLANNER.hasUnconfirmed(), null, {
        timeout: timeout * 10,
      })
    }),
  )
  await page.evaluate(() => window.__perf.deliverDelete())
  await settle()
  // a window opened from a Roadmap row, which shows its task from its own
  // answer (taskWindow.task)
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
  // a status change of the Roadmap's first task, from its view's row
  const [pending] = await statusWrites(page, 'roadmap', 1)
  assert.ok(pending, 'The Roadmap must bring a task to change')
  await page.evaluate(() => window.__perf.hold())
  // not awaited in the page: the write waits until it is released
  await page.evaluate(({ id, status }) => {
    void window.PLANNER.updateIssue(id, { status })
  }, pending)
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
  assert.equal(
    await page.evaluate((id) => window.PLANNER.anyTask(id)?.status, pending.id),
    pending.status,
  )
  // A refusal while ten other edits wait: only its own change goes. Eleven
  // status changes of the Roadmap's next tasks, from their views' rows.
  const layers = await statusWrites(page, 'roadmap', 11, 1)
  assert.equal(layers.length, 11, 'The Roadmap must bring eleven tasks to change')
  await page.evaluate((layers) => {
    window.__perf.hold()
    for (const { id, status } of layers) void window.PLANNER.updateIssue(id, { status })
  }, layers)
  await heldCount(11)
  phase('refusalWithTen')
  metrics.refusalWithTen.push(
    await timed(async () => {
      await page.evaluate(() => window.__perf.releaseOne(true))
      // the refused change's paint goes, so its task shows its status again
      await page.waitForFunction(
        ({ id, was }) => window.PLANNER.anyTask(id)?.status === was,
        layers[0],
      )
      await paintTimer()
    }),
  )
  await page.evaluate(() => window.__perf.releaseAll())
  await page.waitForFunction(() => !window.PLANNER.roadmapUndo.busy)
  await noToasts()
  // Mark all as read over `messages` new unread messages.
  await page.evaluate((count) => window.__perf.seedMessages(count), messages)
  // one inbox item per task the messages land on, as the server's unread
  // summary counts them, exact to 99 and then more than 99, on every build
  // it compares
  await page.waitForFunction(
    (items) => {
      const summary = window.PLANNER.inboxSummary
      if (!summary) return true
      if (summary.state !== 'ok' || !summary.current) return false
      return summary.answer.unread_more || summary.answer.unread_count >= items
    },
    Math.min(messages, tasks, 100),
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
  // the summary counts none once the server marked them read
  await page.waitForFunction(() => {
    const summary = window.PLANNER.inboxSummary
    if (!summary) return true
    return summary.state === 'ok' && summary.current && summary.answer.unread_count === 0
  })
  await noToasts()
  // Other people's changes besides a rename, each one delivery: a new
  // task, a renamed project, a new inbox message and a Team sync stamp.
  let made = null
  phase('remoteCreate')
  metrics.remoteCreate.push(
    await timed(async () => {
      made = await page.evaluate(() => window.__perf.deliverCreate())
      await paintTimer()
    }),
  )
  // the Roadmap's answer names the new task, or says its project passed
  // the ceiling
  const roadmapNames = (id, named) =>
    page.waitForFunction(
      ({ id, named }) => {
        const answer = window.PLANNER.roadmapRead().value
        if (answer?.state === 'over_ceiling') return named
        return answer?.state === 'ok' && answer.rows.some((row) => row.id === id) === named
      },
      { id, named },
      { timeout: timeout * 2 },
    )
  await roadmapNames(made, true)
  // At whole thousands the new task takes the top-level project the app
  // opens past the Roadmap's 1,000 tasks, the design size, and a build that
  // reads the Roadmap from the server shows its ceiling note there instead
  // of rows. Its creator deletes it again, untimed, on both builds, so the
  // phases after it time the Roadmap with its rows as before.
  await page.evaluate(() => window.__perf.deliverDelete())
  await roadmapNames(made, false)
  await shows(page, '[data-roadmap-task-open]')
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
  // the summary counts the one message and the top bar's chip says so,
  // untimed
  await page.waitForFunction(() => {
    const summary = window.PLANNER.inboxSummary
    if (!summary) return true
    const chip = document.querySelector('[data-inbox-badge]')?.textContent ?? null
    return (
      summary.state === 'ok' && summary.current && summary.answer.unread_count === 1 && chip === '1'
    )
  })
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
  // the stand-in answers the title it gave the task
  let renamed = null
  phase('boardRemote')
  metrics.boardRemote.push(
    await timed(async () => {
      renamed = await page.evaluate(() => window.__perf.deliverRemote(3))
      await paintTimer()
    }),
  )
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
  await shows(page, OVERVIEW_SHOWN)
  await page.waitForFunction(boardComplete, null, { timeout: timeout * 10 })
  const afterBoard = await pageSize(page, cdp)
  metrics.afterBoardHeapMb.push(afterBoard.heapMb)
  metrics.afterBoardDomNodes.push(afterBoard.domNodes)
  /** Times another person's rename of task `remote`, then this person's
      own status change of the `own`th task view `slot`'s answer brings,
      from its row, as `prefix`Remote and `prefix`Edit. */
  const changes = async (prefix, remote, own, slot) => {
    await settle()
    await noToasts()
    phase(`${prefix}Remote`)
    metrics[`${prefix}Remote`].push(
      await timed(async () => {
        await page.evaluate((n) => window.__perf.deliverRemote(n), remote)
        await paintTimer()
      }),
    )
    const [edit] = await statusWrites(page, slot, 1, own)
    assert.ok(edit, `The ${slot} answer must bring a task to change`)
    const written = await page.evaluate(() => window.__perf.writes)
    phase(`${prefix}Edit`)
    metrics[`${prefix}Edit`].push(
      await timed(async () => {
        await page.evaluate(({ id, status }) => {
          void window.PLANNER.updateIssue(id, { status })
        }, edit)
        await paintTimer()
      }),
    )
    // its answer lands before the next phase
    await page.waitForFunction((count) => window.__perf.writes > count, written, {
      timeout: timeout * 2,
    })
  }
  // the Board's answer, which the Board kept hidden holds
  await changes('overviewAfterBoard', 5, 6, 'board:desktop')
  await (await viewButton(page, 'Roadmap')).click({ timeout: timeout * 10 })
  await shows(page, '[data-roadmap-task-open]')
  await page.waitForFunction(boardComplete, null, { timeout: timeout * 10 })
  await changes('roadmapAfterBoard', 7, 8, 'roadmap')
  assert.deepEqual(errors, [], `Browser errors at ${tasks} tasks`)
  opened.recordFiles()
  await context.close()
}

/** Runs one sample on the varied workspace: opens the Board right after
    startup, scrolls it and drags one card into the next status. */
async function runVariedSample(origin, tasks, metrics, query = '') {
  phase('variedStartup')
  const opened = await openPage(origin, tasks, metrics, `&shape=varied${query}`)
  const { context, page, errors, settle, timed } = opened
  await startedOn(page)
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
    OVERVIEW_SHOWN,
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
  await shows(page, OVERVIEW_SHOWN)
  // The phone's Roadmap: its task schedule until the first row shows, then
  // until every row is in.
  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .locator('[data-view-switch]')
    .getByRole('radio', { name: 'Roadmap', exact: true })
    .click({ timeout: timeout * 10 })
  // the phone Roadmap shows its schedule button once its answer for the
  // selection arrived (a build from before it read the server, once every
  // task is held), so the timed phase starts after that
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
  opened.recordFiles()
  await context.close()
}

/** Runs one sample of Team sync on a project of 1,000 tasks over 3
    sub-projects, a fifth Done, saved as the scope (see the header). */
async function runSyncSample(origin, metrics, query = '') {
  phase('syncStartup')
  const opened = await openPage(
    origin,
    1000,
    metrics,
    `&subprojects=3&done=0.2&syncscope=program${query}`,
  )
  const { context, page, errors, settle, timed } = opened
  await startedOn(page)
  await settle()
  const nav = await handle(page.locator('[data-sync-nav]'))
  const watch = await watchInput(page)
  let shownAt = Number.POSITIVE_INFINITY
  try {
    phase('syncOpen')
    metrics.syncOpen.push(
      await timed(async () => {
        await nav.click({ timeout: timeout * 10 })
        // the opening's facts, on the frame that first shows them
        const shown = await page.waitForFunction(
          () =>
            !!document.querySelector('[data-sync-page] [data-sync-facts]')?.checkVisibility() &&
            performance.now(),
          null,
          { timeout: timeout * 10 },
        )
        shownAt = await shown.jsonValue()
      }),
    )
  } finally {
    await watch.stop()
  }
  metrics.syncLongestFrameMs.push((await watch.read(shownAt)).frame)
  await settle()
  phase('syncNext')
  const next = await handle(page.locator('[data-sync-next]'))
  metrics.syncNext.push(
    await timed(async () => {
      await next.click({ timeout: timeout * 10 })
      await shows(page, '[data-sync-person]')
      await shows(page, '[data-sync-col="onit"]')
    }),
  )
  await settle()
  // the first card of the person's that this week's load counts, which a
  // Remaining moves, and their load chip
  const card = await page.evaluate(() => {
    const P = window.PLANNER
    for (const row of document.querySelectorAll('[data-sync-card]')) {
      const it = P.anyTask(row.dataset.syncCard)
      if (
        it &&
        !it.paused &&
        it.start != null &&
        it.end != null &&
        it.start <= P.TODAY_WEEK &&
        P.TODAY_WEEK <= it.end
      )
        return row.dataset.syncCard
    }
    return null
  })
  // With many people (--files people=1000) the first person may hold no
  // card this week's load counts, which syncEdit needs. Then the sample
  // leaves syncEdit out, says so, and opens the first card's lists
  if (card) {
    const chip = page.locator('[data-sync-person] [data-sync-load]')
    const box = page.locator(`[data-sync-card="${card}"] [data-sync-input]`)
    const before = await chip.textContent()
    const hours = String(Number((await box.inputValue()) || '0') + 37)
    await box.fill(hours)
    phase('syncEdit')
    metrics.syncEdit.push(
      await timed(async () => {
        await box.press('Enter')
        await page.waitForFunction(
          (was) =>
            document.querySelector('[data-sync-person] [data-sync-load]')?.textContent !== was,
          before,
          { timeout: timeout * 10 },
        )
      }),
    )
    await settle()
  } else
    console.warn("syncEdit left out: Team sync's first person has no card this week's load counts")
  const listCard =
    card ?? (await page.locator('[data-sync-card]').first().getAttribute('data-sync-card'))
  assert.ok(listCard, "Team sync's first person has a card")
  // Until `least` people show in a list, counting no clear row and no row
  // of the list's end. The owner list waits for two, the card's owner and
  // one more. On this branch the owner's row comes at once from the store's
  // name, and the next from the server's first batch, so the phase holds
  // that round trip; on a build before the owner pickers both come from
  // the roster. The Mention window waits for one, since it chooses no one
  // until a batch or the check answers.
  const personShown = (within, least) =>
    page.waitForFunction(
      ([selector, least]) =>
        [...document.querySelectorAll(selector)].filter(
          (item) =>
            !/^(Unassigned|No reviewer|Load more|Loading…|Try again)$/.test(
              item.textContent.trim(),
            ),
        ).length >= least,
      [within, least],
      { timeout: timeout * 10 },
    )
  const owner = await handle(page.locator(`[data-sync-card="${listCard}"] [data-assignee-edit]`))
  phase('syncOwnerOpen')
  metrics.syncOwnerOpen.push(
    await timed(async () => {
      await owner.click({ timeout: timeout * 10 })
      await personShown('[data-slot="popover-content"] [cmdk-item]', 2)
    }),
  )
  await page.keyboard.press('Escape')
  await page.locator('[data-slot="popover-content"] [cmdk-root]').waitFor({ state: 'detached' })
  await settle()
  const mention = await handle(page.locator(`[data-sync-mention="${listCard}"]`))
  phase('syncMentionOpen')
  metrics.syncMentionOpen.push(
    await timed(async () => {
      await mention.click({ timeout: timeout * 10 })
      await personShown('[data-sync-mention-window] [data-sync-mention-person]', 1)
    }),
  )
  await page.keyboard.press('Escape')
  assert.deepEqual(errors, [], 'Browser errors on Team sync')
  opened.recordFiles()
  await context.close()
}

/* The metrics of the thread phase (--thread), for one figure and case. */
const THREAD_METRICS = [
  'threadHeldAfterEarlier',
  'threadEarlierMs',
  'threadEarlierLongestFrameMs',
  'threadArrivalMs',
  'threadArrivalLongestFrameMs',
  'threadNewerMs',
  'threadNewerLongestFrameMs',
  'threadHeldRows',
  'threadHeapMb',
  'threadDomNodes',
]

/** The rows the task window's store holds for the open task: its comments,
    and under All its changes too. */
const heldRows = (page, all) =>
  page.evaluate(
    (all) => window.PLANNER.comments.length + (all ? window.PLANNER.threadEvents.length : 0),
    all,
  )

/** Times one press of the thread's control `selector` (Show earlier or Show
    newer) until no page loads and the thread's first row, or the row above
    Show newer, changed, as `prefix`Ms, with the longest animation frame
    from the press on as `prefix`LongestFrameMs. */
async function timedThreadPress({ page, timed }, metrics, prefix, selector, all) {
  const button = await handle(page.locator(`${selector} button`))
  const before = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-spine-feed] [data-comment], [data-spine-feed] [data-event]',
      ),
    ]
      .map((row) => row.getAttribute('data-comment') ?? row.getAttribute('data-event'))
      .join(' '),
  )
  const watch = await watchInput(page)
  let pressedAt = Number.POSITIVE_INFINITY
  try {
    phase(prefix)
    metrics[`${prefix}Ms`].push(
      await timed(async () => {
        pressedAt = await page.evaluate(() => performance.now())
        await button.click({ timeout: timeout * 10 })
        await page.waitForFunction(
          ({ was, all }) => {
            const P = window.PLANNER
            const states = all
              ? [P.commentsEarlier, P.historyEarlier, P.commentsNewer, P.historyNewer]
              : [P.commentsEarlier, P.commentsNewer]
            if (states.includes('loading')) return false
            const now = [
              ...document.querySelectorAll(
                '[data-spine-feed] [data-comment], [data-spine-feed] [data-event]',
              ),
            ]
              .map((row) => row.getAttribute('data-comment') ?? row.getAttribute('data-event'))
              .join(' ')
            return now !== was
          },
          { was: before, all },
          { timeout: timeout * 10 },
        )
      }),
    )
  } finally {
    await watch.stop()
  }
  metrics[`${prefix}LongestFrameMs`].push((await watch.read(pressedAt)).frame)
}

/** One sample of the thread phase at `figure` for `kind`, 'comments' or
    'all': the task opened from the Roadmap with the thread its case raises,
    Show earlier pressed until the store holds the figure, then the timed
    press, a delivered comment and Show newer. */
async function runThreadSample(origin, figure, kind, metrics) {
  const all = kind === 'all'
  const thread = all ? '&thread=30&threadchanges=1000' : '&thread=1000&threadchanges=30'
  phase(`thread${all ? 'All' : 'Comments'}Startup`)
  const opened = await openPage(origin, 100, metrics, `${thread}&threadkeep=${figure}`)
  const { context, page, cdp, errors, settle, timed } = opened
  await startedOn(page)
  await settle()
  await (await viewButton(page, 'Roadmap')).click()
  await page.locator('[data-roadmap-task-open]').first().click()
  await page.locator('[data-task-close]').waitFor()
  await page.waitForFunction(() => window.PLANNER.commentsLoaded)
  if (all) {
    await page.getByRole('radio', { name: 'All', exact: true }).click()
    await page.waitForFunction(() => window.PLANNER.historyLoaded)
  }
  // the phone's window, on its Activity tab
  if (phone) await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-earlier-comments]').waitFor()
  await settle()
  // Show earlier until the store holds the figure, then the press made
  // while it holds it, or, when nothing earlier is left by then, the press
  // that reached the figure. Every press is timed, and the one judged is
  // kept.
  const earlier = '[data-earlier-comments="more"]'
  let last = null
  for (let press = 0; press < 100; press++) {
    if ((await page.locator(earlier).count()) === 0) break
    const held = await heldRows(page, all)
    const scratch = Object.fromEntries(
      ['threadEarlierMs', 'threadEarlierLongestFrameMs'].map((key) => [key, []]),
    )
    await timedThreadPress({ page, timed }, scratch, 'threadEarlier', earlier, all)
    last = scratch
    await settle()
    if (held >= figure) break
  }
  assert.ok(last, 'Show earlier showed at least once')
  metrics.threadEarlierMs.push(last.threadEarlierMs[0])
  metrics.threadEarlierLongestFrameMs.push(last.threadEarlierLongestFrameMs[0])
  metrics.threadHeldAfterEarlier.push(await heldRows(page, all))
  await settle()
  // a comment another person posts while the reader is up the thread
  const watch = await watchInput(page)
  let deliveredAt = Number.POSITIVE_INFINITY
  try {
    phase('threadArrival')
    metrics.threadArrivalMs.push(
      await timed(async () => {
        deliveredAt = await page.evaluate(() => performance.now())
        const body = await page.evaluate(() => window.__perf.deliverComments())
        await page.waitForFunction(
          (text) =>
            [...document.querySelectorAll('[data-comment]')].some(
              (comment) => comment.textContent.includes(text) && comment.checkVisibility(),
            ),
          body,
          { timeout: timeout * 10 },
        )
      }),
    )
  } finally {
    await watch.stop()
  }
  metrics.threadArrivalLongestFrameMs.push((await watch.read(deliveredAt)).frame)
  await settle()
  // Show newer, which shows once the store let rows go
  const newer = '[data-newer-comments="more"]'
  if ((await page.locator(newer).count()) > 0)
    await timedThreadPress(opened, metrics, 'threadNewer', newer, all)
  await settle()
  metrics.threadHeldRows.push(await heldRows(page, all))
  const size = await pageSize(page, cdp)
  metrics.threadHeapMb.push(size.heapMb)
  metrics.threadDomNodes.push(size.domNodes)
  assert.deepEqual(errors, [], 'Browser errors in the thread phase')
  await context.close()
}

/* The comments threadReturn has arrive while the page is hidden: fewer
   than the live window's 50, at its edge and past it. */
const RETURN_ARRIVALS = [10, 49, 60]
/* The rows the task window keeps loaded (src/lib/threadBudget.ts
   THREAD_KEEP, convex/lib/limits.ts THREAD_ROWS), which threadReturn's
   window holds before the page hides. */
const THREAD_BUDGET = 150
/* The metrics of threadReturn, for one count of arrivals. */
const RETURN_METRICS = [
  'threadReturnMs',
  'threadReturnLongestFrameMs',
  'threadReturnHeldBefore',
  'threadReturnArrivedHidden',
]

/** Hides the page as a minimized window or a background tab does for
    lib/viewVisibility.ts, by overriding document.visibilityState and
    document.hidden and dispatching visibilitychange, or, with `hidden`
    false, takes the override away and dispatches it again. Answers the
    page's time of the dispatch. */
const setHidden = (page, hidden) =>
  page.evaluate((hidden) => {
    if (hidden) {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      })
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    } else {
      delete document.visibilityState
      delete document.hidden
    }
    document.dispatchEvent(new Event('visibilitychange'))
    return performance.now()
  }, hidden)

/** One sample of threadReturn for `arrivals` comments: the task opened from
    the Roadmap under All with its thread at the budget, the page hidden,
    the comments posted at once, and the page shown again, timed until the
    newest of them shows with no thread page loading and, where the build
    marks it, the window's reads current (data-task-window-reads). */
async function runThreadReturnSample(origin, arrivals, metrics) {
  phase('threadReturnStartup')
  const opened = await openPage(origin, 100, metrics, '&thread=200&threadchanges=200')
  const { context, page, errors, settle, timed } = opened
  await startedOn(page)
  await settle()
  await (await viewButton(page, 'Roadmap')).click()
  await page.locator('[data-roadmap-task-open]').first().click()
  await page.locator('[data-task-close]').waitFor()
  await page.waitForFunction(() => window.PLANNER.commentsLoaded)
  await page.getByRole('radio', { name: 'All', exact: true }).click()
  await page.waitForFunction(() => window.PLANNER.historyLoaded)
  if (phone) await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-earlier-comments]').waitFor()
  await settle()
  // Show earlier until the store holds the budget, untimed
  const earlier = '[data-earlier-comments="more"]'
  for (let press = 0; press < 20 && (await heldRows(page, true)) < THREAD_BUDGET; press++) {
    if ((await page.locator(earlier).count()) === 0) break
    const scratch = { threadEarlierMs: [], threadEarlierLongestFrameMs: [] }
    await timedThreadPress(opened, scratch, 'threadEarlier', earlier, true)
    await settle()
  }
  metrics.threadReturnHeldBefore.push(await heldRows(page, true))
  // the page hidden, and the comments posted while it is; their delivery
  // would reach the page within two seconds if its reads kept running,
  // but they pause while it is hidden, so they arrive on the return
  phase('threadReturnHidden')
  await setHidden(page, true)
  const bytes = await page.evaluate(() => window.__perf.wireBytes)
  const last = await page.evaluate((n) => window.__perf.deliverComments(n), arrivals)
  const arrived = await page
    .waitForFunction((before) => window.__perf.wireBytes > before, bytes, { timeout: 2000 })
    .then(
      () => true,
      () => false,
    )
  metrics.threadReturnArrivedHidden.push(arrived ? 1 : 0)
  await settle()
  const watch = await watchInput(page)
  let shownAt = Number.POSITIVE_INFINITY
  try {
    phase('threadReturn')
    metrics.threadReturnMs.push(
      await timed(async () => {
        shownAt = await setHidden(page, false)
        await page.waitForFunction(
          (text) => {
            const marked = document.querySelector('[data-task-window-reads]')
            if (marked && marked.getAttribute('data-task-window-reads') !== 'current') return false
            const P = window.PLANNER
            const pages = [P.commentsEarlier, P.historyEarlier, P.commentsNewer, P.historyNewer]
            if (pages.includes('loading')) return false
            return [...document.querySelectorAll('[data-comment]')].some(
              (comment) => comment.textContent.includes(text) && comment.checkVisibility(),
            )
          },
          last,
          { timeout: timeout * 10 },
        )
      }),
    )
  } finally {
    await watch.stop()
  }
  metrics.threadReturnLongestFrameMs.push((await watch.read(shownAt)).frame)
  assert.deepEqual(errors, [], 'Browser errors in threadReturn')
  await context.close()
}

/** Runs the thread phase (--thread): `samples` samples, each taking every
    figure in turn under Comments and then under All, and reports the
    medians per figure and case. */
async function runThreadPhase(origin) {
  const metrics = new Map()
  for (const figure of threadFigures)
    for (const kind of ['comments', 'all'])
      metrics.set(`${figure}:${kind}`, Object.fromEntries(THREAD_METRICS.map((key) => [key, []])))
  const returns = new Map(
    RETURN_ARRIVALS.map((n) => [n, Object.fromEntries(RETURN_METRICS.map((key) => [key, []]))]),
  )
  report.thread = { figures: threadFigures, phone, scenarios: [], returns: [] }
  for (let sample = 0; sample < samples; sample++) {
    for (const figure of threadFigures)
      for (const kind of ['comments', 'all']) {
        running = { label: `thread ${kind}`, tasks: figure, sample: sample + 1, phase: 'startup' }
        await runThreadSample(origin, figure, kind, metrics.get(`${figure}:${kind}`))
      }
    for (const n of RETURN_ARRIVALS) {
      running = { label: 'thread return', tasks: n, sample: sample + 1, phase: 'startup' }
      await runThreadReturnSample(origin, n, returns.get(n))
    }
    const load = loadavg()[0]
    report.loads.push({ target: 'thread', sample: sample + 1, load })
    console.log(`thread phase: sample ${sample + 1}/${samples}, load ${load.toFixed(2)}`)
  }
  for (const figure of threadFigures)
    for (const kind of ['comments', 'all']) {
      report.thread.scenarios.push({
        figure,
        kind,
        ...summarized(figure, metrics.get(`${figure}:${kind}`)),
      })
    }
  for (const n of RETURN_ARRIVALS)
    report.thread.returns.push({ arrivals: n, ...summarized(100, returns.get(n)) })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  console.table(
    report.thread.returns.map(({ arrivals, metrics: m }) => ({
      arrivals,
      ...Object.fromEntries(
        [
          ...RETURN_METRICS,
          'threadReturnScriptDurationMs',
          'threadReturnLayoutDurationMs',
          'threadReturnRecalcStyleDurationMs',
          'threadReturnWireBytes',
        ]
          .filter((key) => m[key])
          .map((key) => [key, Math.round(m[key].p50 * 10) / 10]),
      ),
    })),
  )
  console.table(
    report.thread.scenarios.map(({ figure, kind, metrics: m }) => ({
      figure,
      kind,
      ...Object.fromEntries(
        THREAD_METRICS.filter((key) => m[key]).map((key) => [
          key,
          Math.round(m[key].p50 * 10) / 10,
        ]),
      ),
    })),
  )
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
      'syncLongestFrameMs',
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
    const server = await serve(outDir, options.serve ? host : '127.0.0.1')
    servers.push(server)
    target.origin = server.origin
    // an app from before it derived the load of the tasks it shows from
    // their rows gets those load rows too, as its own server sent them
    target.query = existsSync(join(target.source, 'convex/lib/loadRows.ts')) ? '' : '&shownload=1'
    target.browserSearch = existsSync(join(target.source, 'src/lib/paletteSearch.ts'))
  }
  if (options.serve) {
    for (const target of targets)
      console.log(
        `Benchmark workspace (${target.label}): ${target.origin}/?${workspaceParameters(sizes[0])}${SIZE_CASE_SHAPE}&latency=${latency}&mbps=${bandwidth}${varied ? '&shape=varied' : ''}${target.query}`,
      )
    // a supervised service stops with SIGTERM
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
    process.exitCode = 0
  } else {
    // the handlers above stop the run; the browser goes with the process
    if (report.skipped.length)
      console.log(`${browserName} cannot give ${report.skipped.join('; ')}`)
    browser = await { chromium, firefox, webkit }[browserName].launch({
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
    })
    if (threadFigures) await runThreadPhase(targets[0].origin)
    for (const tasks of threadFigures ? [] : sizes) {
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
          if (varied) {
            await runVariedSample(target.origin, tasks, target.metrics, target.query)
            await runSyncSample(target.origin, target.metrics, target.query)
          }
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
        `Baseline ${report.baseline.commit.slice(0, 12)} (${report.baseline.chosen}), medians of ${samples} samples taken in turns in ${browserName} at ${cpu}x CPU throttling, times in ms, heap in MiB:`,
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

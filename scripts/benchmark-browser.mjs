// Real production UI/store; synthetic transport isolates CPU/DOM costs from backend variance.
//
//   node scripts/benchmark-browser.mjs [--sizes 100,1000,10000] [--samples 5]
//     [--baseline [revision]] [--root checkout] [--output file.json]
//
// --baseline also builds `revision` (by default the merge base of HEAD and
// origin/main, as scripts/benchmark-backend.mjs picks it) with this
// checkout's dependencies and transport, runs its samples in turn with the
// checkout's, and prints both medians side by side. Taking turns puts both
// under the same machine load, which moves single numbers a lot. The App
// render counts (*AppRenders) do not depend on load at all.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { build } from 'vite'
import { BaselineError, resolveBaseline } from './benchmark-backend.mjs'

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
const timeout = Number(option('timeout', '15000'))
// unread messages the bulk-read scenario adds just before it runs, so the
// earlier scenarios load the same workspace as before it existed
const messages = Number(option('messages', '500'))
// --baseline, with the revision when one follows it
const baselineAt = process.argv.indexOf('--baseline')
const baselineRevision =
  baselineAt < 0
    ? null
    : process.argv[baselineAt + 1] && !process.argv[baselineAt + 1].startsWith('--')
      ? process.argv[baselineAt + 1]
      : ''
const temporary = await mkdtemp(join(tmpdir(), 'qivo-browser-perf-'))
const entry = join(here, 'perf/entry.tsx')
const transport = join(here, 'perf/transport.mjs')
await writeFile(
  join(temporary, 'index.html'),
  `<html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
)
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
  'boardNavigation',
  'boardRemote',
]
// the medians --baseline prints side by side
const COMPARED = [
  'remote',
  'remoteWhilePending',
  'remoteSettle',
  'refusalWithTen',
  'markAllRead',
  'drag',
  'boardRemote',
].flatMap((phase) => [`${phase}ScriptDurationMs`, `${phase}AppRenders`])
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
    Object.entries(metrics).map(([key, values]) => [key, summary(values)]),
  ),
})

/** Builds the benchmark page from the checkout at `source` into `outDir`. */
async function buildPage(source, outDir) {
  await build({
    configFile: false,
    root: temporary,
    logLevel: 'warn',
    define: {
      __QIVO_BUILD_ID__: '"benchmark"',
      'import.meta.env.VITE_CONVEX_URL': '"https://benchmark.invalid"',
      'import.meta.env.VITE_CONVEX_SITE_URL': '"https://benchmark.invalid"',
    },
    plugins: [
      {
        name: 'benchmark-transport',
        enforce: 'pre',
        resolveId(id, importer) {
          if (!importer) return
          const path = id.startsWith('@perf/')
            ? resolve(source, 'src', id.slice(6))
            : id.startsWith('@/')
              ? resolve(source, 'src', id.slice(2))
              : id.startsWith('.')
                ? resolve(dirname(importer), id)
                : id
          if (
            [join(source, 'src/lib/convex'), join(source, 'src/lib/auth')].includes(
              path.replace(/\.ts$/, ''),
            )
          )
            return transport
        },
        transform(code, id) {
          if (id === join(source, 'src/styles/app.css'))
            return `${code}\n@source ${JSON.stringify(join(source, 'src'))};\n`
          if (id === join(source, 'src/App.tsx'))
            return code.replace('function App() {', 'function App() { window.__perf.appRenders++;')
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { '@perf': join(source, 'src'), '@': join(source, 'src') } },
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  })
}

/** The source of `commit` in a folder of its own, with this checkout's
    dependencies. */
async function checkoutOf(commit) {
  const folder = join(temporary, `baseline-${commit.slice(0, 12)}`)
  await mkdir(folder)
  const archive = join(temporary, 'baseline.tar')
  await promisify(execFile)('git', ['archive', '-o', archive, commit, 'src', 'convex', 'scripts'], {
    cwd: root,
  })
  await promisify(execFile)('tar', ['-xf', archive, '-C', folder])
  await symlink(join(root, 'node_modules'), join(folder, 'node_modules'))
  return folder
}

/** Serves the page built into `outDir` and resolves its origin. */
async function serve(outDir) {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    const file = pathname.startsWith('/assets/')
      ? join(outDir, pathname)
      : join(outDir, 'index.html')
    try {
      const content = await readFile(file)
      response.setHeader(
        'Content-Type',
        { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }[
          extname(file)
        ] || 'application/octet-stream',
      )
      response.end(content)
    } catch {
      response.writeHead(404).end()
    }
  })
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

/** Runs one sample of every scenario on the page at `origin` with `tasks`
    tasks, adding its numbers to `metrics`. */
async function runSample(origin, tasks, metrics) {
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
  /* Times `operation` as the running phase, with its script, layout and
     style time and its App renders. */
  const timed = async (operation) => {
    const before = await cdp.send('Performance.getMetrics')
    const renders = await appRenders()
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
    return elapsed
  }
  await page.goto(`${origin}/?tasks=${tasks}&latency=${latency}`)
  await page.locator('[data-view-switch]').waitFor()
  await settle()
  metrics.startup.push(await page.evaluate(() => performance.now()))
  assert.equal(await page.evaluate(() => window.PLANNER.issues.length), tasks)
  const search = page.getByRole('combobox', { name: 'Search tasks and projects' })
  phase('searchOpen')
  metrics.searchOpen.push(
    await timed(async () => {
      await page.locator('[data-sidebar-search]').click()
      await search.waitFor()
    }),
  )
  phase('search')
  metrics.search.push(
    await timed(async () => {
      await search.fill('signed firm')
      await page.locator('[cmdk-item]').nth(8).waitFor()
    }),
  )
  assert.equal(await page.locator('[cmdk-item]').count(), 9)
  await page.keyboard.press('Escape')
  phase('navigation')
  metrics.navigation.push(
    await timed(async () => {
      await page
        .locator('[data-view-switch]')
        .getByRole('radio', { name: 'Roadmap', exact: true })
        .click()
      await page.locator('[data-roadmap-panel]').waitFor()
      await page.locator('[data-bar]').first().waitFor()
    }),
  )
  assert.equal(
    await page.locator('[data-roadmap-task-open]').count(),
    tasks,
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
      await page.getByText(body, { exact: true }).waitFor()
    }),
  )
  metrics.commentAppRenders.push((await appRenders()) - renders)
  await cdp.send('HeapProfiler.collectGarbage')
  const performanceMetrics = await cdp.send('Performance.getMetrics')
  metrics.heapMb.push(
    performanceMetrics.metrics.find((metric) => metric.name === 'JSHeapUsedSize').value / 1048576,
  )
  metrics.domNodes.push(await page.locator('*').count())
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
      await page.evaluate(() =>
        Promise.race([
          window.PLANNER.markAllMessagesRead(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Mark all as read did not finish')), 15000),
          ),
        ]),
      )
      await paintTimer()
    }),
  )
  assert.equal(await page.evaluate(() => window.PLANNER.unreadMessages), 0)
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
  phase('boardNavigation')
  metrics.boardNavigation.push(
    await timed(async () => {
      await page
        .locator('[data-view-switch]')
        .getByRole('radio', { name: 'Board', exact: true })
        .click({ timeout: timeout * 10 })
      await page
        .locator('[data-card]')
        .first()
        .waitFor({ timeout: timeout * 10 })
    }),
  )
  assert.equal(await page.locator('[data-card]').count(), tasks, 'The Board must show every task')
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
  assert.deepEqual(errors, [], `Browser errors at ${tasks} tasks`)
  await context.close()
}

/** Empty metric lists for one size. */
const emptyMetrics = () =>
  Object.fromEntries(
    [...PHASES, 'startup', 'commentAppRenders', 'heapMb', 'domNodes'].map((key) => [key, []]),
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
  if (baselineRevision !== null) {
    let baseline
    try {
      baseline = await resolveBaseline(baselineRevision ? [baselineRevision] : [])
    } catch (error) {
      if (!(error instanceof BaselineError)) throw error
      console.error(error.message)
      process.exit(1)
    }
    report.baseline = { commit: baseline.commit, chosen: baseline.chosen, scenarios: [] }
    targets.push({
      label: 'baseline',
      source: await checkoutOf(baseline.commit),
      scenarios: report.baseline.scenarios,
    })
  }
  for (const target of targets) {
    const outDir = join(temporary, `dist-${target.label}`)
    await buildPage(target.source, outDir)
    target.origin = await serve(outDir)
  }
  if (process.argv.includes('--serve')) {
    for (const target of targets)
      console.log(
        `Benchmark workspace (${target.label}): ${target.origin}/?tasks=${sizes[0]}&latency=${latency}`,
      )
    await new Promise((resolve) => process.once('SIGINT', resolve))
    process.exitCode = 0
  } else {
    browser = await chromium.launch({ headless: true })
    for (const tasks of sizes) {
      for (const target of targets) target.metrics = emptyMetrics()
      for (let sample = 0; sample < samples; sample++) {
        // the targets take turns, so both run under the same load
        for (const target of targets) {
          running = { label: target.label, tasks, sample: sample + 1, phase: 'startup' }
          await runSample(target.origin, tasks, target.metrics)
          console.log(`${target.label}, ${tasks} tasks: sample ${sample + 1}/${samples}`)
        }
      }
      for (const target of targets) target.scenarios.push(summarized(tasks, target.metrics))
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
    }
    console.log(JSON.stringify(report, null, 2))
    if (report.baseline) {
      console.log(
        `Baseline ${report.baseline.commit.slice(0, 12)} (${report.baseline.chosen}), medians of ${samples} samples taken in turns, script time in ms at ${cpu}x CPU throttling:`,
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
  for (const server of servers) await new Promise((resolve) => server.close(resolve))
  await rm(temporary, { recursive: true, force: true })
}

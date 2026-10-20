// Real production UI/store; synthetic transport isolates CPU/DOM costs from backend variance.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { build } from 'vite'

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
const temporary = await mkdtemp(join(tmpdir(), 'qivo-browser-perf-'))
const distribution = join(temporary, 'dist')
const entry = join(here, 'perf/entry.tsx')
const transport = join(here, 'perf/transport.mjs')
await writeFile(
  join(temporary, 'index.html'),
  `<html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
)
let browser
let server
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
  if (trace) console.error(`${running.tasks} tasks, sample ${running.sample}: ${name}`)
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
try {
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
        resolveId(source, importer) {
          if (!importer) return
          const path = source.startsWith('@perf/')
            ? resolve(root, 'src', source.slice(6))
            : source.startsWith('@/')
              ? resolve(root, 'src', source.slice(2))
              : source.startsWith('.')
                ? resolve(dirname(importer), source)
                : source
          if (
            [join(root, 'src/lib/convex'), join(root, 'src/lib/auth')].includes(
              path.replace(/\.ts$/, ''),
            )
          )
            return transport
        },
        transform(code, id) {
          if (id === join(root, 'src/styles/app.css'))
            return `${code}\n@source ${JSON.stringify(join(root, 'src'))};\n`
          if (id === join(root, 'src/App.tsx'))
            return code.replace('function App() {', 'function App() { window.__perf.appRenders++;')
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { '@perf': join(root, 'src'), '@': join(root, 'src') } },
    build: { outDir: distribution, emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  })
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    const file = pathname.startsWith('/assets/')
      ? join(distribution, pathname)
      : join(distribution, 'index.html')
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  if (process.argv.includes('--serve')) {
    console.log(`Benchmark workspace: ${origin}/?tasks=${sizes[0]}&latency=${latency}`)
    await new Promise((resolve) => process.once('SIGINT', resolve))
    process.exitCode = 0
  } else {
    browser = await chromium.launch({ headless: true })
    for (const tasks of sizes) {
      const metrics = {
        startup: [],
        searchOpen: [],
        search: [],
        navigation: [],
        drag: [],
        comments: [],
        commentAppRenders: [],
        remoteWhilePending: [],
        remoteSettle: [],
        refusalWithTen: [],
        markAllRead: [],
        heapMb: [],
        domNodes: [],
      }
      for (let sample = 0; sample < samples; sample++) {
        running = { tasks, sample: sample + 1, metrics, phase: 'startup' }
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
          const asked =
            running.phase === 'refusalWithTen' && message.text().includes('no write access')
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
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          )
        const timed = async (operation) => {
          const before = await cdp.send('Performance.getMetrics')
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
        assert.notEqual(
          await page.evaluate((id) => window.PLANNER.issueById[id].start, taskId),
          initial,
        )
        await page.locator('[data-roadmap-task-open]').first().click()
        phase('comments')
        await page.locator('[data-task-close]').waitFor()
        await page.waitForFunction(() => window.PLANNER.commentsLoaded)
        await settle()
        const renders = await page.evaluate(() => window.__perf.appRenders)
        metrics.comments.push(
          await timed(async () => {
            const body = await page.evaluate(() => window.__perf.deliverComments())
            await page.getByText(body, { exact: true }).waitFor()
          }),
        )
        metrics.commentAppRenders.push(
          (await page.evaluate(() => window.__perf.appRenders)) - renders,
        )
        await cdp.send('HeapProfiler.collectGarbage')
        const performanceMetrics = await cdp.send('Performance.getMetrics')
        metrics.heapMb.push(
          performanceMetrics.metrics.find((metric) => metric.name === 'JSHeapUsedSize').value /
            1048576,
        )
        metrics.domNodes.push(await page.locator('*').count())
        await page.locator('[data-task-close]').click()
        await settle()
        // Writes waiting for their answer: another person's change arrives
        // while one waits, then the write answers with its own echo.
        const heldCount = (n) => page.waitForFunction((count) => window.__perf.held() === count, n)
        const paintTimer = () =>
          page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)))
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
        assert.deepEqual(errors, [], `Browser errors at ${tasks} tasks`)
        await context.close()
        console.log(`${tasks} tasks: sample ${sample + 1}/${samples}`)
      }
      report.scenarios.push(summarized(tasks, metrics))
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
    }
    console.log(JSON.stringify(report, null, 2))
  }
} catch (error) {
  if (running) {
    report.failure = {
      tasks: running.tasks,
      sample: running.sample,
      phase: running.phase,
      message: error.message,
    }
    if (!report.scenarios.some((scenario) => scenario.tasks === running.tasks))
      report.scenarios.push(summarized(running.tasks, running.metrics))
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  }
  throw error
} finally {
  await browser?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await rm(temporary, { recursive: true, force: true })
}

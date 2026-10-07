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
          if (message.type() === 'error') {
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
        running.phase = 'searchOpen'
        metrics.searchOpen.push(
          await timed(async () => {
            await page.locator('[data-sidebar-search]').click()
            await search.waitFor()
          }),
        )
        running.phase = 'search'
        metrics.search.push(
          await timed(async () => {
            await search.fill('signed firm')
            await page.locator('[cmdk-item]').nth(8).waitFor()
          }),
        )
        assert.equal(await page.locator('[cmdk-item]').count(), 9)
        await page.keyboard.press('Escape')
        running.phase = 'navigation'
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
        running.phase = 'drag'
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
        running.phase = 'comments'
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
        running.phase = 'offscreen focus'
        await page.locator('[data-task-close]').click()
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

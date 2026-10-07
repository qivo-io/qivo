/* Read-only Northstar regression using native OS wheel input, including the
 * Chromium imprecise mouse path that Playwright/CDP wheel events do not use.
 * Run: xvfb-run -a -s '-screen 0 1800x1500x24' node scripts/board-native-wheel-smoke.mjs [baseURL]
 * Requires Xvfb and xdotool. Never seeds, resets or changes demo records. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { inspectBrowserDemo, loadBrowserDemo, signInDemo } from './browser-demo.mjs'

const run = promisify(execFile),
  demo = loadBrowserDemo(process.argv[2] ?? 'http://localhost:5199'),
  before = await inspectBrowserDemo(demo),
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  errors = []
assert.ok(process.env.DISPLAY, 'Run this drive with xvfb-run -a; it sends actual OS mouse input')
const processes = await run('ps', ['-eo', 'args'])
assert.ok(
  processes.stdout
    .split('\n')
    .some((line) => line.startsWith(`Xvfb ${process.env.DISPLAY.split('.')[0]} `)),
  'The native drive requires its own Xvfb display',
)
const browser = await chromium.launch({
    headless: false,
    args: ['--enable-smooth-scrolling', '--window-position=0,0', '--window-size=1750,1450'],
  }),
  page = await browser.newPage({ viewport: { width: 1556, height: 1000 } })
page.on('pageerror', (e) => errors.push(e.message))
async function settle() {
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const p = document.querySelector('[data-scroll]')
        let top = p.scrollTop,
          start = performance.now(),
          change = start
        function tick(now) {
          if (p.scrollTop !== top) {
            top = p.scrollTop
            change = now
          }
          if (now - start > 650 && now - change > 180) return resolve()
          if (now - start > 4000) return reject(Error('scroll stuck'))
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
  )
}
async function aim() {
  await run('xdotool', ['mousemove_relative', '--', '1', '0'])
  const c = await page.evaluate(() => {
    const r = document.querySelector('[data-scroll]').getBoundingClientRect(),
      x = Math.round(r.x + r.width * 0.35),
      y = Math.round(r.y + r.height * 0.55)
    window.__osMove = null
    const onMove = (event) => {
      window.__osMove = { x: event.clientX, y: event.clientY }
    }
    document.addEventListener('mousemove', onMove)
    window.__finishOsMove = () => {
      document.removeEventListener('mousemove', onMove)
      delete window.__finishOsMove
      return window.__osMove
    }
    return {
      x,
      y,
      sx: Math.round(window.screenX + x),
      sy: Math.round(window.screenY + window.outerHeight - window.innerHeight + y),
    }
  })
  await run('xdotool', ['mousemove', '--sync', String(c.sx), String(c.sy)])
  // A resize or the preliminary nudge can leave an older mousemove queued.
  // Match the delivered coordinates instead of trusting the first event.
  await page
    .waitForFunction(
      ({ x, y }) =>
        window.__osMove &&
        Math.abs(window.__osMove.x - x) <= 2 &&
        Math.abs(window.__osMove.y - y) <= 2,
      c,
      { timeout: 2000 },
    )
    .catch(() => {})
  const actual = await page.evaluate(() => window.__finishOsMove())
  assert.ok(
    actual && Math.abs(actual.x - c.x) <= 2 && Math.abs(actual.y - c.y) <= 2,
    `Native pointer missed board: ${JSON.stringify({ requested: c, actual })}`,
  )
}
async function position(name, where = 'heading') {
  await page.evaluate(
    ({ name, where }) => {
      const p = document.querySelector('[data-scroll]'),
        r = p.getBoundingClientRect(),
        line = r.top + parseFloat(getComputedStyle(p).scrollPaddingTop),
        lane = [...p.querySelectorAll('[data-swimlane-panel]')].find(
          (l) => l.querySelector('[data-lane-open]').textContent === name,
        ),
        b = lane.getBoundingClientRect(),
        head = p.scrollTop + b.top - line,
        bottom = p.scrollTop + b.bottom - r.top - p.clientHeight
      p.scrollTo({
        top: where === 'bottom' ? bottom : where === 'middle' ? (head + bottom) / 2 : head,
        behavior: 'instant',
      })
    },
    { name, where },
  )
  await settle()
}
async function start() {
  await page.evaluate(() => {
    const p = document.querySelector('[data-scroll]'),
      epoch = performance.now(),
      data = { events: [], frames: [], calls: [], ends: [] }
    const sample = () => {
      const r = p.getBoundingClientRect(),
        line = r.top + parseFloat(getComputedStyle(p).scrollPaddingTop)
      return {
        t: performance.now() - epoch,
        top: p.scrollTop,
        max: p.scrollHeight - p.clientHeight,
        lanes: [...p.querySelectorAll('[data-swimlane-panel]')].map((l) => {
          const b = l.getBoundingClientRect()
          const heading = l.querySelector('[data-lane]').getBoundingClientRect()
          const foot = l.querySelector('[data-lane-foot]').getBoundingClientRect()
          const last = [...l.querySelectorAll('[data-card]')]
            .map((card) => card.getBoundingClientRect())
            .sort((a, b) => b.bottom - a.bottom)[0]
          return {
            name: l.querySelector('[data-lane-open]').textContent,
            offset: b.top - line,
            bottom: b.bottom - r.top - p.clientHeight,
            lastTop: last?.top,
            lastBottom: last?.bottom,
            headingBottom: heading.bottom,
            visibleBottom: Math.min(r.top + p.clientHeight, foot.bottom - 1),
          }
        }),
      }
    }
    const wheel = (e) => {
      const item = {
        ...sample(),
        delta: e.deltaY,
        cancelable: e.cancelable,
        prevented: e.defaultPrevented,
        hit: e.target.closest('[data-card]')
          ? 'card'
          : e.target.closest('[data-lane]')
            ? 'header'
            : 'blank',
      }
      data.events.push(item)
      setTimeout(() => (item.prevented = e.defaultPrevented), 0)
    }
    const end = () => data.ends.push(sample())
    const original = p.scrollTo.bind(p)
    p.scrollTo = (...args) => {
      data.calls.push({ ...sample(), args })
      return original(...args)
    }
    let frame
    const tick = () => {
      data.frames.push(sample())
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    p.addEventListener('wheel', wheel, { capture: true })
    p.addEventListener('scrollend', end)
    window.__osLong = data
    window.__finishLong = () => {
      cancelAnimationFrame(frame)
      p.removeEventListener('wheel', wheel, true)
      p.removeEventListener('scrollend', end)
      p.scrollTo = original
      delete window.__osLong
      delete window.__finishLong
      return { ...data, final: sample() }
    }
  })
}
async function finish(label, ticks) {
  await settle()
  const data = await page.evaluate(() => window.__finishLong())
  assert.ok(data.events.length > 0, `${label}: no OS wheel events reached the board`)
  const unit = Math.min(...data.events.map((event) => Math.abs(event.delta)))
  assert.ok(
    data.events.reduce((sum, event) => sum + Math.abs(event.delta), 0) >= ticks * unit,
    `${label}: native wheel input was lost; coalesced events must retain their deltas`,
  )
  const stalls = []
  for (let i = 0; i < data.events.length; i++) {
    const first = data.events[i]
    if (first.top <= 3 || first.top >= first.max - 3) continue
    let amount = 0
    for (let j = i; j < data.events.length; j++) {
      const event = data.events[j]
      if (Math.sign(event.delta) !== Math.sign(first.delta) || Math.abs(event.top - first.top) > 2)
        break
      amount += Math.abs(event.delta)
      if (amount < 4 * unit || event.t - first.t < 180) continue
      const frames = data.frames.filter((frame) => frame.t >= first.t && frame.t <= event.t)
      if (
        frames.length >= 3 &&
        Math.max(...frames.map((frame) => frame.top)) -
          Math.min(...frames.map((frame) => frame.top)) <=
          2
      ) {
        stalls.push(
          data.events.slice(i, j + 1).map(({ t, top, delta, cancelable, prevented }) => ({
            t,
            top,
            delta,
            cancelable,
            prevented,
          })),
        )
        break
      }
    }
  }
  if (stalls.length)
    console.error(
      JSON.stringify({
        label,
        stalls,
        calls: data.calls.map(({ t, top, args }) => ({ t, top, args })),
      }),
    )
  assert.deepEqual(
    stalls,
    [],
    `${label}: at least four native wheel ticks left the board stationary`,
  )
  console.log(
    `[board-native-wheel] ${label}: ${data.events.length} DOM events, ${data.events.filter((e) => !e.cancelable).length} noncancelable; no dead ticks`,
  )
  return data
}

const click = (button, count = 1, interval = 100) =>
  run('xdotool', ['click', '--repeat', String(count), '--delay', String(interval), String(button)])
try {
  await signInDemo(page, demo)
  await page
    .locator('[data-lane]')
    .getByRole('button', { name: 'Luma Cloud', exact: true })
    .waitFor()
  await page.evaluate(() => document.fonts.ready)
  await aim()
  for (const motion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion: motion })
    for (const pause of [150, 100, 220]) {
      await position('Luma Cloud', 'middle')
      await start()
      // Five physical detents per burst; short pauses preserve the native wheel
      // sequence while it crosses a project boundary and then changes direction.
      await click(5, 5, 100)
      await wait(pause)
      await click(5, 5, 100)
      await wait(pause)
      await click(4, 5, 100)
      await wait(pause)
      await click(4, 5, 100)
      await finish(`${motion}: pause ${pause}ms across Cloud and Pilot`, 20)
    }
  }
  for (const motion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion: motion })
    for (const interval of [60, 100, 220]) {
      await position('Pilot & Launch')
      const sensorBottom = await page.evaluate(() => {
        const pane = document.querySelector('[data-scroll]')
        const sensor = [...pane.querySelectorAll('[data-swimlane-panel]')].find(
          (lane) => lane.querySelector('[data-lane-open]').textContent === 'Luma Sensor',
        )
        return (
          pane.scrollTop +
          sensor.getBoundingClientRect().bottom -
          pane.getBoundingClientRect().top -
          pane.clientHeight
        )
      })
      await start()
      await click(4, 35, interval)
      const result = await finish(
        `${motion}: continuous upward ${interval}ms project transitions`,
        35,
      )
      assert.ok(
        result.calls.some((call) => {
          const options = call.args[0]
          return options?.behavior !== 'instant' && Math.abs(options?.top - sensorBottom) <= 2
        }),
        'Upward scrolling through Cloud must snap to Sensor’s final tasks',
      )
      // A pinned heading alone cannot prove the transition was entered at its
      // readable end. Observe the actual last card at the destination before
      // later ticks continue upward into earlier task rows.
      const arrived = result.frames.findIndex((frame) => {
        const sensor = frame.lanes.find((lane) => lane.name === 'Luma Sensor')
        return (
          Math.abs(frame.top - sensorBottom) <= 2 &&
          sensor.lastTop >= sensor.headingBottom - 2 &&
          sensor.lastBottom <= sensor.visibleBottom + 2
        )
      })
      const earlierRows = result.frames.findIndex((frame) => frame.top < sensorBottom - 80)
      assert.ok(
        arrived >= 0,
        'Native upward transition must show Sensor’s last task at the pane bottom',
      )
      assert.ok(
        earlierRows > arrived,
        'Native ticks must read Sensor’s final tasks before its earlier rows',
      )
    }
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  for (const direction of [1, -1]) {
    await position(
      direction > 0 ? 'Luma Sensor' : 'Luma Cloud',
      direction > 0 ? 'bottom' : 'heading',
    )
    const { initial, target } = await page.evaluate((direction) => {
      const p = document.querySelector('[data-scroll]')
      const r = p.getBoundingClientRect()
      const name = direction > 0 ? 'Luma Cloud' : 'Luma Sensor'
      const lane = [...p.querySelectorAll('[data-swimlane-panel]')].find(
        (l) => l.querySelector('[data-lane-open]').textContent === name,
      )
      const b = lane.getBoundingClientRect()
      const offset =
        direction > 0
          ? b.top - r.top - parseFloat(getComputedStyle(p).scrollPaddingTop)
          : b.bottom - r.top - p.clientHeight
      return { initial: p.scrollTop, target: p.scrollTop + offset }
    }, direction)
    await start()
    await click(direction > 0 ? 5 : 4)
    await page.waitForFunction(
      ({ initial, target }) => {
        const top = document.querySelector('[data-scroll]').scrollTop
        return top > Math.min(initial, target) + 20 && top < Math.max(initial, target) - 20
      },
      { initial, target },
      { timeout: 2000 },
    )
    await click(direction > 0 ? 4 : 5)
    const result = await finish(`native in-flight reversal ${direction}`, 2)
    const reversedAt = result.events[1]?.top
    assert.ok(
      reversedAt > Math.min(initial, target) + 2 && reversedAt < Math.max(initial, target) - 2,
      'The second actual OS wheel event must arrive before the original snap finishes',
    )
    assert.ok(
      direction > 0 ? result.final.top <= initial + 2 : result.final.top >= initial - 2,
      'A reversed native wheel must stop the old snap direction',
    )
  }
  await page.setViewportSize({ width: 1024, height: 700 })
  await position('Luma Sensor')
  await aim()
  await start()
  await click(5, 40, 100)
  await wait(150)
  await click(4, 40, 100)
  await finish('narrow board: 40 detents down and back up', 80)
  await page.setViewportSize({ width: 1556, height: 1286 })
  await page.locator('aside').getByText('Luma Sensor', { exact: true }).click()
  await page.getByRole('heading', { name: 'Luma Sensor', exact: true }).waitFor()
  await page
    .locator('[data-lane]')
    .getByRole('button', { name: 'Electronics', exact: true })
    .waitFor()
  await aim()
  for (const motion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion: motion })
    await position('Electronics')
    await start()
    await click(5, 8, 100)
    await wait(150)
    await click(4, 8, 100)
    const result = await finish(`${motion}: native short-lane traversal and reversal`, 16)
    const seenLast = new Set()
    let previous = -1
    for (const frame of [result.events[0], ...result.frames].sort((a, b) => a.t - b.t)) {
      frame.lanes.forEach((lane) => {
        if (lane.lastTop >= lane.headingBottom - 2 && lane.lastBottom <= lane.visibleBottom + 2)
          seenLast.add(lane.name)
      })
      const active = frame.lanes.findLastIndex((lane) => lane.offset <= 2)
      if (previous >= 0 && active > previous) {
        for (let index = previous; index < active; index++)
          assert.ok(
            seenLast.has(frame.lanes[index].name),
            'Native scrolling skipped a short lane’s final task',
          )
      }
      previous = active
    }
    assert.ok(
      seenLast.has('Firmware'),
      'Native short-lane traversal must show Firmware’s final task',
    )
  }
  assert.deepEqual(errors, [], 'Browser reported uncaught errors')
  assert.deepEqual(
    await inspectBrowserDemo(demo),
    before,
    'Native drive changed demo anchor or counts',
  )
  console.log('[board-native-wheel] PASS — demo anchor and counts preserved')
} finally {
  await page.evaluate(() => window.PLANNER?.signOut()).catch(() => {})
  await browser.close()
  assert.deepEqual(
    await inspectBrowserDemo(demo),
    before,
    'Native drive changed demo anchor or counts',
  )
}

/* Read-only swimlane wheel and panel-paint regression against the Northstar development demo.
 * Usage: node scripts/board-scroll-smoke.mjs [baseURL]
 * Requires the running dev server; never seeds, resets, or edits demo data. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { inspectBrowserDemo, loadBrowserDemo, signInDemo } from './browser-demo.mjs'

const demo = loadBrowserDemo(process.argv[2] ?? 'http://localhost:5199')
const before = await inspectBrowserDemo(demo)
// Keep the native thumb available for the scrollbar drag regression below.
const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] })
const page = await browser.newPage({ viewport: { width: 1556, height: 1286 } })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))
const log = (message) => console.log(`[board-scroll] ${message}`)
const paintProof = { headingOverlaps: 0, footContent: 0, roundedCorners: 0, gapOverlaps: 0 }
const panel = (name) =>
  page.locator('[data-swimlane-panel]').filter({
    has: page.getByRole('button', { name, exact: true }),
  })

async function geometry(name) {
  return panel(name).evaluate((lane) => {
    const scroll = lane.closest('[data-scroll]')
    const bounds = scroll.getBoundingClientRect()
    const rect = lane.getBoundingClientRect()
    const cards = [...lane.querySelectorAll('[data-card]')].map((card) =>
      card.getBoundingClientRect(),
    )
    const line =
      bounds.top + Number.parseFloat(getComputedStyle(lane.querySelector('[data-lane]')).top)
    const paneBottom = bounds.top + scroll.clientHeight
    return {
      scrollTop: scroll.scrollTop,
      offset: rect.top - line,
      bottomOffset: rect.bottom - paneBottom,
      horizontalOverflow: scroll.scrollWidth > scroll.clientWidth,
      headingOffset: lane.querySelector('[data-lane]').getBoundingClientRect().top - line,
      cards: cards.length,
      firstCardTop: Math.min(...cards.map((card) => card.top)),
      lastCardBottom: Math.max(...cards.map((card) => card.bottom)),
      headingBottom: lane.querySelector('[data-lane]').getBoundingClientRect().bottom,
      visibleBottom: Math.min(
        paneBottom,
        lane.querySelector('[data-lane-foot]').getBoundingClientRect().bottom - 1,
      ),
    }
  })
}

async function assertPanelPaint() {
  const proof = await page.locator('[data-scroll]').evaluate((scroll) => {
    const pane = scroll.getBoundingClientRect()
    const band = scroll.parentElement.querySelector('.board-status-band')
    const status = band.querySelector('.board-status-panel').getBoundingClientRect()
    const bandRect = band.getBoundingClientRect()
    const bodies = [...scroll.querySelectorAll('.board-lane-body')].map((body) =>
      body.getBoundingClientRect(),
    )
    const fragments = [
      ...scroll.querySelectorAll('.board-panel-heading, .board-lane-body, [data-lane-foot]'),
    ].map((fragment) => fragment.getBoundingClientRect())
    const proof = {
      headingOverlaps: 0,
      footContent: 0,
      roundedCorners: 0,
      gapOverlaps: 0,
      failures: [],
    }
    if (Math.abs(pane.top - bandRect.bottom) > 1) {
      proof.failures.push('The board scrollbar and body must begin below the status header')
    }
    for (const count of band.querySelectorAll('[data-status-count]')) {
      const heading = count.parentElement.getBoundingClientRect()
      const cell = scroll.querySelector(
        `[data-board-cell][data-status="${count.dataset.statusCount}"]`,
      )
      if (!cell) continue
      const column = cell.getBoundingClientRect()
      if (Math.abs(heading.left - column.left) > 1 || Math.abs(heading.right - column.right) > 1) {
        proof.failures.push('Status headers and task columns must stay horizontally aligned')
      }
    }
    const contains = (rect, x, y) =>
      x > rect.left && x < rect.right && y > rect.top && y < rect.bottom
    const sampleXs = (rect) => {
      const left = Math.max(rect.left, pane.left)
      const right = Math.min(rect.right, pane.left + scroll.clientWidth)
      return right - left > 4 ? [0.2, 0.5, 0.8].map((part) => left + (right - left) * part) : []
    }

    // Read the real hit-test stack, including elements behind the topmost one.
    // No clip-path value is read or reconstructed: a translucent heading
    // must have no body or card paint beneath it even when their layout overlaps.
    for (const chrome of scroll.querySelectorAll('.board-panel-heading')) {
      const rect = chrome.getBoundingClientRect()
      const top = Math.max(rect.top, pane.top)
      const bottom = Math.min(rect.bottom, pane.top + scroll.clientHeight)
      if (bottom - top <= 2) continue
      const y = (top + bottom) / 2
      for (const x of sampleXs(rect)) {
        const hits = document.elementsFromPoint(x, y)
        // A departing fragment can itself be clipped away. Its remaining
        // visible fragments and the clear status gap are checked separately.
        if (!hits.includes(chrome)) continue
        if (bodies.some((body) => contains(body, x, y))) proof.headingOverlaps++
        if (hits.some((element) => element.closest('.board-lane-body, [data-card]'))) {
          proof.failures.push(`Body/card paint remains beneath a visible heading at ${x}, ${y}`)
        }
      }
    }

    // The foot is a transparent border: body content must stay visible and
    // interactive to its lower edge, but never escape the rounded corners.
    for (const foot of scroll.querySelectorAll('[data-lane-foot]')) {
      const lane = foot.closest('.board-lane, [data-board-group]')
      const body = lane.querySelector('.board-lane-body')
      const bodyRect = body.getBoundingClientRect()
      const rect = foot.getBoundingClientRect()
      const y = Math.min(rect.bottom, pane.top + scroll.clientHeight) - 4
      if (y <= Math.max(rect.top, pane.top)) continue
      for (const x of sampleXs(rect)) {
        if (!contains(bodyRect, x, y)) continue
        proof.footContent++
        const hits = document.elementsFromPoint(x, y)
        if (!hits.includes(body) || hits.includes(foot)) {
          proof.failures.push(`The bottom border hides or intercepts body content at ${x}, ${y}`)
        }
      }
      const cornerY = rect.bottom - 4
      if (cornerY <= pane.top || cornerY >= pane.top + scroll.clientHeight) continue
      for (const x of [rect.left + 0.5, rect.right - 0.5]) {
        if (x <= pane.left || x >= pane.left + scroll.clientWidth) continue
        if (!contains(bodyRect, x, cornerY)) continue
        proof.roundedCorners++
        if (document.elementsFromPoint(x, cornerY).some((element) => body.contains(element))) {
          proof.failures.push(`Body/card paint escapes a rounded bottom corner at ${x}, ${cornerY}`)
        }
      }
    }

    // The gap is actual space between the visible status panel and its band;
    // no lane content may remain there after a heading scrolls out of view.
    if (bandRect.bottom - status.bottom > 2) {
      const y = (status.bottom + bandRect.bottom) / 2
      for (const x of sampleXs(status)) {
        if (fragments.some((fragment) => contains(fragment, x, y))) proof.gapOverlaps++
        if (
          document
            .elementsFromPoint(x, y)
            .some((element) =>
              element.closest('.board-panel-heading, .board-lane-body, [data-lane-foot]'),
            )
        ) {
          proof.failures.push(`Lane paint remains in the status-header gap at ${x}, ${y}`)
        }
      }
    }
    return proof
  })
  assert.deepEqual(proof.failures, [], 'Board panels overlap pinned chrome or the clear status gap')
  for (const key of Object.keys(paintProof)) paintProof[key] += proof[key]
}

// Wait through wheel dispatch and smooth scrolling.
async function settle() {
  await page.locator('[data-scroll]').evaluate(
    (scroll) =>
      new Promise((resolve, reject) => {
        const started = performance.now()
        let lastTop = scroll.scrollTop
        let lastChange = started
        function frame(now) {
          if (scroll.scrollTop !== lastTop) {
            lastTop = scroll.scrollTop
            lastChange = now
          }
          if (now - started > 600 && now - lastChange > 160) return resolve()
          if (now - started > 4000) return reject(new Error('Board scrolling did not settle'))
          requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      }),
  )
  await assertPanelPaint()
}

async function positionAt(name, headingOffset = 0) {
  await panel(name).evaluate((lane, headingOffset) => {
    const scroll = lane.closest('[data-scroll]')
    const line =
      scroll.getBoundingClientRect().top +
      Number.parseFloat(getComputedStyle(lane.querySelector('[data-lane]')).top)
    scroll.scrollTo({
      top: scroll.scrollTop + lane.getBoundingClientRect().top - line - headingOffset,
      behavior: 'instant',
    })
  }, headingOffset)
  await settle()
  if (headingOffset === 0) await assertAt(name)
  else {
    const state = await geometry(name)
    assert.ok(
      Math.abs(state.offset - headingOffset) <= 1,
      `${name} did not reach the requested ${headingOffset}px heading offset`,
    )
  }
  const bounds = await page.locator('[data-scroll]').boundingBox()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
}

async function assertAt(name) {
  const state = await geometry(name)
  assert.ok(Math.abs(state.offset) <= 2, `${name} panel missed the snap line by ${state.offset}px`)
  assert.ok(
    Math.abs(state.headingOffset) <= 2,
    `${name} heading missed the snap line by ${state.headingOffset}px`,
  )
}

async function assertAtBottom(name) {
  const state = await geometry(name)
  assert.ok(
    Math.abs(state.bottomOffset) <= 2,
    `${name} bottom missed the pane bottom by ${state.bottomOffset}px`,
  )
  assert.ok(state.offset < -80, `${name} must retain earlier rows above the viewport`)
  assert.ok(
    state.lastCardBottom <= state.visibleBottom + 2,
    `${name}'s last task is obscured after returning from the next heading`,
  )
  assert.ok(
    state.firstCardTop < state.headingBottom - 2,
    `${name} returned to its first tasks instead of its last tasks`,
  )
}

async function wheel(deltaY) {
  await page.mouse.wheel(0, deltaY)
  await settle()
}

async function reverseDuringSnap(direction) {
  const sensor = await geometry('Luma Sensor')
  const cloud = await geometry('Luma Cloud')
  const start = sensor.scrollTop
  const target = start + (direction > 0 ? cloud.offset : sensor.bottomOffset)
  await page.mouse.wheel(0, direction * 120)
  // Observe actual animation progress instead of assuming a fixed dispatch
  // delay. Keep clear of the endpoints so this cannot pass after settlement.
  await page.waitForFunction(
    ({ start, target }) => {
      const top = document.querySelector('[data-scroll]').scrollTop
      return top > Math.min(start, target) + 20 && top < Math.max(start, target) - 20
    },
    { start, target },
  )
  // Capture before the app's listener handles the reversal, proving the real
  // wheel event arrived while the original animation was still in flight.
  await page.locator('[data-scroll]').evaluate((scroll) => {
    delete scroll.dataset.wheelReversedAt
    scroll.addEventListener(
      'wheel',
      () => {
        scroll.dataset.wheelReversedAt = String(scroll.scrollTop)
      },
      { capture: true, once: true },
    )
  })
  await page.mouse.wheel(0, -direction * 120)
  await page.waitForFunction(
    () => document.querySelector('[data-scroll]').dataset.wheelReversedAt !== undefined,
    null,
    { timeout: 2000 },
  )
  const reversedAt = await page.locator('[data-scroll]').evaluate((scroll) => {
    const top = Number(scroll.dataset.wheelReversedAt)
    delete scroll.dataset.wheelReversedAt
    return top
  })
  assert.ok(
    reversedAt > Math.min(start, target) + 2 && reversedAt < Math.max(start, target) - 2,
    'The reverse wheel must arrive during an unfinished snap',
  )
  await settle()
  return { start, reversedAt }
}

async function scrollDownTo(name, nextName) {
  for (let gesture = 0; gesture < 80; gesture++) {
    const next = await geometry(nextName)
    if (Math.abs(next.offset) <= 2) {
      await assertAt(nextName)
      return
    }
    const current = await geometry(name)
    await wheel(120)
    const after = await geometry(name)
    assert.ok(after.scrollTop > current.scrollTop + 2, `Wheel down stopped inside ${name}`)
    if (Math.abs((await geometry(nextName)).offset) <= 2) {
      assert.ok(
        current.lastCardBottom <= current.visibleBottom + 2,
        `Advanced to ${nextName} before ${name}'s last task was shown`,
      )
    }
  }
  assert.fail(`Could not reach ${nextName} with downward mouse-wheel steps`)
}

async function steadyWheelTicks(deltaY, interval, count) {
  await page.locator('[data-scroll]').evaluate((scroll) => {
    const lanes = [...scroll.querySelectorAll('[data-swimlane-panel]')]
    const proof = { ticks: [], unreadCrossings: [], seenLast: [], active: -1 }
    const sample = () => {
      const pane = scroll.getBoundingClientRect()
      const line = pane.top + Number.parseFloat(getComputedStyle(scroll).scrollPaddingTop)
      const bottom = pane.top + scroll.clientHeight
      let active = -1
      lanes.forEach((lane, index) => {
        const rect = lane.getBoundingClientRect()
        const heading = lane.querySelector('[data-lane]').getBoundingClientRect()
        const foot = lane.querySelector('[data-lane-foot]').getBoundingClientRect()
        const cards = [...lane.querySelectorAll('[data-card]')].map((card) =>
          card.getBoundingClientRect(),
        )
        const last = cards.sort((a, b) => b.bottom - a.bottom)[0]
        if (
          last &&
          last.top >= heading.bottom - 2 &&
          last.bottom <= Math.min(bottom, foot.bottom - 1) + 2
        )
          proof.seenLast[index] = true
        if (rect.top <= line + 2 && rect.bottom > line) active = index
      })
      if (active > proof.active && proof.active >= 0) {
        for (let index = proof.active; index < active; index++) {
          if (!proof.seenLast[index])
            proof.unreadCrossings.push(lanes[index].querySelector('[data-lane-open]').textContent)
        }
      }
      if (active >= 0) proof.active = active
    }
    const onWheel = (event) => {
      sample()
      proof.ticks.push({ time: performance.now(), top: scroll.scrollTop, delta: event.deltaY })
    }
    sample()
    let frame
    const observe = () => {
      sample()
      frame = requestAnimationFrame(observe)
    }
    frame = requestAnimationFrame(observe)
    scroll.addEventListener('wheel', onWheel, { capture: true, passive: true })
    scroll.wheelProof = proof
    scroll.finishWheelProof = () => {
      cancelAnimationFrame(frame)
      scroll.removeEventListener('wheel', onWheel, true)
      delete scroll.finishWheelProof
      delete scroll.wheelProof
      return proof
    }
  })
  // Timers schedule real wheel input independently of protocol round trips.
  // Actual DOM timestamps below decide whether the intended fast cadence
  // reached the app; a busy renderer must not silently weaken the regression.
  await Promise.all(
    Array.from({ length: count }, async (_, pulse) => {
      await new Promise((resolve) => setTimeout(resolve, pulse * interval))
      await page.mouse.wheel(0, deltaY)
    }),
  )
  await settle()
  return page.locator('[data-scroll]').evaluate((scroll) => scroll.finishWheelProof())
}

async function assertSteadyResponse({ short = false, motion, interval, deltaY = 30, count = 16 }) {
  const up = deltaY < 0
  await page.emulateMedia({ reducedMotion: motion })
  for (let attempt = 0; attempt < 3; attempt++) {
    if (short) {
      await positionAt('Electronics')
    } else {
      await positionAt('Luma Cloud')
      if (!up) {
        await wheel(-120)
        await assertAtBottom('Luma Sensor')
      }
    }
    const destination = short ? 'Firmware' : up ? 'Luma Sensor' : 'Luma Cloud'
    const target = await geometry(destination)
    const destinationTop = target.scrollTop + (up ? target.bottomOffset : target.offset)
    // Keep the full uninterrupted burst, but budget travel inside tall lanes.
    // Compact cards can leave less than 16 × 30px between readable edges:
    // ordinary scrolling would then exhaust the lane and fail the assertions
    // that deliberately require tasks to remain unread at the opposite edge.
    // Short-lane sequences still traverse whole lanes at the requested delta.
    const unreadMargin = 80
    const interiorBudget = target.bottomOffset - target.offset - unreadMargin
    const magnitude = short
      ? Math.abs(deltaY)
      : Math.min(Math.abs(deltaY), Math.floor(interiorBudget / count))
    assert.ok(magnitude > 0, 'The destination lane needs interior space for the steady burst')
    const burstDelta = Math.sign(deltaY) * magnitude
    const proof = await steadyWheelTicks(burstDelta, interval, count)
    assert.equal(proof.ticks.length, count, 'Every scheduled wheel tick must reach the board')
    const gaps = proof.ticks.slice(1).map((tick, index) => tick.time - proof.ticks[index].time)
    // The former sliding gate needed a >=180ms pause to release. Require a
    // real uninterrupted sequence, retrying only when dispatch timing missed it.
    if (gaps.some((gap) => gap >= 180)) {
      if (attempt < 2) continue
      assert.fail(`Could not deliver ${interval}ms wheel ticks without a 180ms dispatch gap`)
    }
    const after = await geometry(destination)
    assert.ok(
      up ? after.scrollTop < destinationTop - 10 : after.scrollTop > destinationTop + 10,
      `${motion} ${interval}ms ticks stopped after reaching ${destination}`,
    )
    if (up) {
      assert.ok(proof.seenLast[0], 'The upward sequence must show Sensor’s final task')
      assert.ok(after.offset < -unreadMargin, 'Steady upward ticks skipped to Sensor’s heading')
      return
    }
    assert.deepEqual(proof.unreadCrossings, [], 'Steady scrolling skipped a lane’s final task')
    if (!short) {
      assert.ok(
        after.lastCardBottom > after.visibleBottom + 2,
        'The steady sequence should leave later Cloud tasks to read',
      )
      assert.ok((await geometry('Pilot & Launch')).offset > 2, 'Skipped unread Cloud tasks')
    }
    return
  }
}

let initialLayout

try {
  await signInDemo(page, demo)
  // the drive reads project lanes; a saved by-assignee layout is put back at the end
  initialLayout = await page.evaluate(() => window.PLANNER.loadUI().metaViz || 'swimlanes')
  if (initialLayout !== 'swimlanes') {
    await page.locator('[data-group-menu]').click()
    await page.getByRole('button', { name: 'Swimlanes by project', exact: true }).click()
  }
  await panel('Luma Sensor').waitFor()
  await page.evaluate(() => document.fonts.ready)
  await positionAt('Luma Sensor')
  await scrollDownTo('Luma Sensor', 'Luma Cloud')
  await wheel(-120)
  await assertAtBottom('Luma Sensor')
  log('All projects: wheel down reaches Luma Cloud; reversing reveals Luma Sensor’s last tasks')

  for (let round = 0; round < 3; round++) {
    await wheel(120)
    await assertAt('Luma Cloud')
    await wheel(-120)
    await assertAtBottom('Luma Sensor')
  }
  log('Repeated mouse detents alternate between the next heading and the previous final tasks')

  for (const offset of [2, 8, 20, 60]) {
    // Other scrolling can leave the heading just below its pin line or expose
    // part of the previous panel. Up must still enter that panel at its end.
    await positionAt('Luma Cloud', offset)
    await wheel(-120)
    await assertAtBottom('Luma Sensor')

    await positionAt('Luma Cloud', -offset)
    await wheel(-120)
    await assertAt('Luma Cloud')
    await wheel(-120)
    await assertAtBottom('Luma Sensor')
  }
  log(
    'Upward snaps handle near-heading offsets, panel gaps, and partially exposed previous projects',
  )

  await positionAt('Luma Sensor')
  await wheel(80)
  await wheel(5000)
  await assertAtBottom('Luma Sensor')
  assert.ok(
    (await geometry('Luma Cloud')).offset > 2,
    'A large downward tick skipped the current project’s final tasks',
  )
  await wheel(120)
  await assertAt('Luma Cloud')
  await wheel(80)
  await wheel(-5000)
  await assertAt('Luma Cloud')
  await wheel(-120)
  await assertAtBottom('Luma Sensor')
  log('Large ticks stop at the last row or current heading before another tick changes project')

  // Switch input while the interior wheel operation is still fresh. Keyboard
  // and scrollbar navigation must be able to pass its project boundary.
  await positionAt('Luma Cloud')
  await panel('Luma Cloud').getByRole('button', { name: 'Luma Cloud', exact: true }).focus()
  const beforeKeyboard = await geometry('Luma Cloud')
  await page.mouse.wheel(0, 80)
  await page.waitForFunction(
    (top) => document.querySelector('[data-scroll]').scrollTop > top + 2,
    beforeKeyboard.scrollTop,
  )
  await page.keyboard.press('End')
  await settle()
  const keyboardEnd = await page.locator('[data-scroll]').evaluate((scroll) => ({
    top: scroll.scrollTop,
    max: scroll.scrollHeight - scroll.clientHeight,
  }))
  assert.ok(
    Math.abs(keyboardEnd.top - keyboardEnd.max) <= 2,
    'End was trapped at the wheel boundary',
  )

  await positionAt('Luma Cloud')
  const beforeScrollbar = await geometry('Luma Cloud')
  await page.mouse.wheel(0, 80)
  await page.waitForFunction(
    (top) => document.querySelector('[data-scroll]').scrollTop > top + 2,
    beforeScrollbar.scrollTop,
  )
  const scrollbar = await page.locator('[data-scroll]').evaluate((scroll) => {
    const bounds = scroll.getBoundingClientRect()
    const width = scroll.offsetWidth - scroll.clientWidth
    const height = scroll.clientHeight
    const thumbHeight = (height * height) / scroll.scrollHeight
    return {
      width,
      x: bounds.right - width / 2,
      fromY: bounds.top + (scroll.scrollTop / scroll.scrollHeight) * height + thumbHeight / 2,
      toY: bounds.top + height - 5,
    }
  })
  assert.ok(scrollbar.width > 0, 'Board must expose its vertical scrollbar for the drag check')
  await page.mouse.move(scrollbar.x, scrollbar.fromY)
  await page.mouse.down()
  await page.mouse.move(scrollbar.x, scrollbar.toY, { steps: 8 })
  await page.mouse.up()
  await settle()
  const afterScrollbar = await geometry('Luma Cloud')
  assert.ok(
    afterScrollbar.bottomOffset < -80,
    'Scrollbar drag was trapped inside the wheeled project',
  )
  log('Keyboard End and a real scrollbar drag can leave the project after interior wheel input')
  await positionAt('Luma Cloud')
  await wheel(-120)
  await assertAtBottom('Luma Sensor')

  const downInterrupted = await reverseDuringSnap(1)
  const returned = await geometry('Luma Sensor')
  assert.ok(
    returned.scrollTop <= downInterrupted.start + 2 &&
      returned.scrollTop < downInterrupted.reversedAt - 2,
    'Reversing a downward snap must return to the previous project’s lower tasks',
  )
  assert.ok(returned.offset < -80, 'Interrupted reversal must not skip to the previous heading')
  assert.ok((await geometry('Luma Cloud')).offset > 2, 'The interrupted downward snap continued')

  await positionAt('Luma Cloud')
  const upInterrupted = await reverseDuringSnap(-1)
  const stayed = await geometry('Luma Cloud')
  assert.ok(
    stayed.scrollTop >= upInterrupted.start - 2 && stayed.scrollTop > upInterrupted.reversedAt + 2,
    'Reversing an upward snap must stay at the current project instead of continuing upward',
  )
  log('Reversing real wheel input during either smooth transition cancels its old direction')
  await positionAt('Luma Cloud')
  await wheel(-120)
  await assertAtBottom('Luma Sensor')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await wheel(120)
  await assertAt('Luma Cloud')
  await wheel(-120)
  await assertAtBottom('Luma Sensor')
  log('Reduced motion preserves both directional destinations for individual detents')

  for (const motion of ['no-preference', 'reduce']) {
    for (const interval of [100, 150]) {
      await assertSteadyResponse({ motion, interval })
    }
    await assertSteadyResponse({ motion, interval: 100, deltaY: -30 })
  }
  await assertSteadyResponse({ motion: 'no-preference', interval: 30, deltaY: 10, count: 48 })
  log(
    'Steady ticks and 30ms momentum remain responsive after arrival without skipping unread tasks',
  )

  await page.setViewportSize({ width: 1024, height: 900 })
  await positionAt('Luma Cloud')
  assert.ok(
    (await geometry('Luma Cloud')).horizontalOverflow,
    'Narrow board must overflow horizontally',
  )
  await wheel(-120)
  await assertAtBottom('Luma Sensor')
  await wheel(120)
  await assertAt('Luma Cloud')
  await wheel(-120)
  await assertAtBottom('Luma Sensor')
  log('Narrow boards align the previous panel above the horizontal scrollbar')
  await page.mouse.wheel(180, 0)
  await settle()
  assert.ok(
    await page.locator('[data-scroll]').evaluate((scroll) => scroll.scrollLeft > 0),
    'Horizontal wheel input must move the narrow board',
  )
  await assertPanelPaint()
  log('Horizontal scrolling keeps the separate status header aligned with every task column')

  await page.setViewportSize({ width: 1556, height: 1286 })
  await page.locator('aside').getByText('Luma Sensor', { exact: true }).click()
  await page.getByRole('heading', { name: 'Luma Sensor', exact: true }).waitFor()
  // the closed switcher names the layout in a word
  await page.locator('[data-group-menu]', { hasText: 'Project' }).waitFor()
  await panel('Testing & Compliance').waitFor()
  await page.evaluate(() => document.fonts.ready)

  await positionAt('Testing & Compliance')
  const testing = await geometry('Testing & Compliance')
  assert.ok(testing.cards > 0, 'Testing & Compliance must contain demo tasks')
  assert.ok(testing.firstCardTop >= testing.headingBottom - 2, 'First task is obscured')
  assert.ok(
    testing.lastCardBottom <= testing.visibleBottom + 2,
    'The large viewport must show all Testing & Compliance tasks',
  )
  await page.mouse.wheel(0, 180)
  await settle()
  await assertAt('Manufacturing')
  log('Once all Testing & Compliance tasks are visible, wheel down snaps to Manufacturing')

  for (const name of [
    'Testing & Compliance',
    'Mechanical & Industrial Design',
    'Firmware',
    'Electronics',
  ]) {
    await page.mouse.wheel(0, -180)
    await settle()
    await assertAt(name)
  }
  log('Wheel up returns from Manufacturing through each preceding subproject heading')

  await positionAt('Manufacturing', 5)
  await wheel(-120)
  await assertAt('Testing & Compliance')
  log('A short previous lane still aligns its heading when scrolling up from a panel gap')

  for (const motion of ['no-preference', 'reduce']) {
    for (const interval of [100, 150]) {
      await assertSteadyResponse({ short: true, motion, interval })
    }
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  log('Steady 100/150ms ticks continue through short lanes after each snap, without unread skips')

  await positionAt('Testing & Compliance')
  await page.mouse.wheel(180, 0)
  await settle()
  await assertAt('Testing & Compliance')
  log('Horizontal wheel input does not change the current subproject')

  await page.setViewportSize({ width: 1556, height: 550 })
  await positionAt('Testing & Compliance')
  const tall = await geometry('Testing & Compliance')
  assert.ok(tall.lastCardBottom > tall.visibleBottom + 80, 'The small pane must hide later tasks')
  // Keep the first gesture inside this lane even when compact cards leave
  // only just over 80px unread. The remaining gestures still reach both edges.
  const interiorStep = Math.min(80, Math.floor((tall.lastCardBottom - tall.visibleBottom) / 2))
  await page.mouse.wheel(0, interiorStep)
  await settle()
  const inside = await geometry('Testing & Compliance')
  assert.ok(inside.scrollTop > tall.scrollTop + 2, 'Wheel must scroll within a tall subproject')
  assert.ok(
    inside.lastCardBottom > inside.visibleBottom + 2,
    'This first wheel must leave later tasks',
  )
  assert.ok((await geometry('Manufacturing')).offset > 2, 'The next heading snapped prematurely')

  // Separate, modest gestures reveal the final task before the next lane can win.
  let revealed = false
  for (let gesture = 0; gesture < 30; gesture++) {
    const state = await geometry('Testing & Compliance')
    if (state.lastCardBottom <= state.visibleBottom + 2) {
      revealed = true
      break
    }
    await page.mouse.wheel(0, 60)
    await settle()
    assert.ok(
      (await geometry('Manufacturing')).offset > 2,
      'Advanced before the last task was shown',
    )
  }
  assert.ok(revealed, 'Could not scroll down to the last Testing & Compliance task')
  await page.mouse.wheel(0, 180)
  await settle()
  await assertAt('Manufacturing')
  log('A tall subproject scrolls through its last task before the next gesture advances')

  // Reverse from the next heading using the wheel itself. Restoring scrollTop
  // here would conceal the regression that skipped straight to the prior heading.
  await wheel(-180)
  await assertAtBottom('Testing & Compliance')
  const testingBottom = await geometry('Testing & Compliance')
  await page.mouse.wheel(0, -interiorStep)
  await settle()
  const insideUp = await geometry('Testing & Compliance')
  assert.ok(
    insideUp.scrollTop < testingBottom.scrollTop - 2,
    'Wheel up must scroll within a tall subproject',
  )
  assert.ok(insideUp.offset < -2, 'The first upward wheel should remain inside Testing')
  let headingRevealed = false
  for (let gesture = 0; gesture < 30; gesture++) {
    const state = await geometry('Testing & Compliance')
    if (Math.abs(state.offset) <= 2) {
      headingRevealed = true
      break
    }
    await page.mouse.wheel(0, -60)
    await settle()
    assert.ok(
      (await geometry('Mechanical & Industrial Design')).offset < -2,
      'Returned to the previous subproject before reaching the current heading',
    )
  }
  assert.ok(headingRevealed, 'Could not scroll back to the Testing & Compliance heading')
  await assertAt('Testing & Compliance')
  await page.mouse.wheel(0, -180)
  await settle()
  await assertAt('Mechanical & Industrial Design')
  log(
    'Tall subprojects return at their last tasks, then scroll up before entering a shorter predecessor',
  )

  for (const [kind, samples] of Object.entries(paintProof)) {
    assert.ok(samples > 0, `Panel clipping checks must exercise actual ${kind}`)
  }
  log(
    'Headings and status gaps stay clear; content reaches the bottom border within rounded corners',
  )
  assert.deepEqual(pageErrors, [], 'Browser reported uncaught errors')
  const after = await inspectBrowserDemo(demo)
  assert.deepEqual(after, before, 'The read-only drive changed the demo anchor or counts')
  log('PASS — demo anchor and counts preserved')
} finally {
  if (initialLayout && initialLayout !== 'swimlanes') {
    // Runs on the failure path too, so say what happened rather than
    // swallowing it: a drive that leaves the account on another layout is
    // the next drive's mystery.
    const restored = await page
      .evaluate(async (metaViz) => {
        const P = window.PLANNER
        P.saveUINow({ metaViz })
        const { convex } = await import('/src/lib/convex.ts')
        await convex.mutation('prefs:save', { profile_id: P.CURRENT_USER, prefs: P.loadUI() })
        return P.loadUI().metaViz
      }, initialLayout)
      .catch((error) => `not restored: ${error?.message || error}`)
    log(`board layout restored: ${restored}`)
  }
  await page.evaluate(() => window.PLANNER?.signOut()).catch(() => {})
  await browser.close()
}

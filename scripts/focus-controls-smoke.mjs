/* App-wide focus-paint sweep against the Northstar development demo.
 * Usage: node scripts/focus-controls-smoke.mjs [baseURL]
 * Requires the running dev app. Never seeds, resets, changes settings or edits
 * tasks. View preferences stay in memory; notification reads are suppressed.
 * Exposed non-text controls in each audited viewport are focused without
 * activation before real Shift input; active fields get separate checks.
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { inspectBrowserDemo, loadBrowserDemo, signInDemo } from './browser-demo.mjs'

const demo = loadBrowserDemo(process.argv[2] ?? 'http://localhost:5199')
const before = await inspectBrowserDemo(demo)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
page.setDefaultTimeout(10000)
const errors = []
const coverage = []
const log = (message) => console.log(`[focus-controls] ${message}`)
let savedPrefs
let passed = false

page.on('pageerror', (error) => errors.push(error.message))
// Install before App mounts, so even its initial view-state save remains local.
await page.addInitScript(() => {
  let planner
  Object.defineProperty(window, 'PLANNER', {
    configurable: true,
    get: () => planner,
    set: (value) => {
      planner = value
      if (!value || window.__focusControlsOriginals) return
      const originals = Object.fromEntries(
        ['loadUI', 'saveUI', 'saveUINow', 'markMessagesRead'].map((name) => [name, value[name]]),
      )
      window.__focusControlsOriginals = originals
      let prefs
      const currentPrefs = () => {
        prefs ??= originals.loadUI()
        return prefs
      }
      value.loadUI = () => structuredClone(currentPrefs())
      value.saveUI = (patch) => Object.assign(currentPrefs(), patch)
      value.saveUINow = value.saveUI
      value.markMessagesRead = () => {}
    },
  })
})

async function route(path, ready) {
  await page.evaluate((url) => {
    history.pushState({}, '', url)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, `/app/${demo.orgSlug}/${path}`)
  await page.locator(ready).first().waitFor()
}

async function settle(element) {
  await element.evaluate(async (node) => {
    const finite = node
      .getAnimations({ subtree: false })
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
    await Promise.all(finite.map((animation) => animation.finished.catch(() => {})))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

async function paint(element) {
  return element.evaluate((node) => {
    const read = (target, pseudo) => {
      const style = getComputedStyle(target, pseudo)
      return {
        outline:
          style.outlineStyle === 'none' || Number.parseFloat(style.outlineWidth) === 0
            ? 'none'
            : `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`,
        shadow: style.boxShadow,
        border: ['Top', 'Right', 'Bottom', 'Left'].map((side) =>
          Number.parseFloat(style[`border${side}Width`]) === 0 ||
          style[`border${side}Style`] === 'none'
            ? 'none'
            : `${style[`border${side}Width`]} ${style[`border${side}Color`]}`,
        ),
        stroke: style.stroke,
      }
    }
    // Theme radios paint their sibling preview card; SVG chart controls paint
    // through inherited stroke. Read those actual surfaces as well as the node.
    const targets = [node]
    if (node.matches('.theme-choice-input') && node.nextElementSibling)
      targets.push(node.nextElementSibling)
    if (node instanceof SVGElement) targets.push(...node.querySelectorAll('rect, path, circle'))
    const surfaces = targets.map((target) => read(target))
    if (node.matches('input[type="file"]')) surfaces.push(read(node, '::file-selector-button'))
    return {
      focused: document.activeElement === node,
      surfaces,
    }
  })
}

function visiblePoint(node) {
  if (
    !node.isConnected ||
    node.matches(
      ':disabled, input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"]), textarea, select, [contenteditable="true"], [data-slot="toggle-group"], [role="tablist"], [role="radiogroup"]',
    ) ||
    node.closest('[inert], [aria-hidden="true"]')
  )
    return null
  const rect = node.getBoundingClientRect()
  if (!rect.width || !rect.height || getComputedStyle(node).visibility !== 'visible') return null
  let left = Math.max(0, rect.left)
  let right = Math.min(innerWidth, rect.right)
  let top = Math.max(0, rect.top)
  let bottom = Math.min(innerHeight, rect.bottom)
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    const bounds = parent.getBoundingClientRect()
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, bounds.left)
      right = Math.min(right, bounds.right)
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, bounds.top)
      bottom = Math.min(bottom, bounds.bottom)
    }
  }
  if (right <= left || bottom <= top) return null
  // A Roadmap cell can geometrically intersect the viewport while a pinned
  // header or a scheduled bar covers it. Check exposed pixels, not only boxes.
  for (const dx of [0.5, 0.1, 0.9]) {
    for (const dy of [0.5, 0.1, 0.9]) {
      const x = left + (right - left) * dx
      const y = top + (bottom - top) * dy
      const hit = document.elementFromPoint(x, y)
      if (hit && (hit === node || node.contains(hit))) return { x, y }
    }
  }
  return null
}

async function sweep(scope, label) {
  const candidates = await scope
    .locator(
      'button, a[href], summary, input[type="checkbox"], input[type="radio"], input[type="range"], input[type="file"], [tabindex]',
    )
    .elementHandles()
  const visible = []
  for (const element of candidates) {
    const included = await element.evaluate(visiblePoint)
    if (included) visible.push(element)
    else await element.dispose()
  }
  assert.ok(visible.length, `${label}: no visible controls to audit`)
  log(`${label}: checking ${visible.length} visible controls`)
  // Keep the baseline focus inside any modal focus trap. The empty sentinel
  // changes no control styles, values or application focus handlers.
  const sentinel = await scope.evaluateHandle((root) => {
    const parking = document.createElement('span')
    parking.tabIndex = -1
    root.append(parking)
    return parking
  })
  let count = 0
  try {
    for (const element of visible) {
      const point = await element.evaluate(visiblePoint)
      if (!point) continue
      const description = await element.evaluate((node) =>
        `${node.tagName.toLowerCase()} ${node.getAttribute('aria-label') || node.textContent || node.getAttribute('data-slot') || node.getAttribute('type') || ''}`
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 100),
      )
      // Hover is genuine pointer movement; focus() reproduces restored focus
      // without clicking destructive actions or changing checked state.
      await page.mouse.move(point.x, point.y)
      await sentinel.evaluate((node) => node.focus({ preventScroll: true }))
      await settle(element)
      const resting = await paint(element)
      assert.equal(resting.focused, false, `${label}: ${description} has no unfocused baseline`)
      await element.evaluate((node) => node.focus({ preventScroll: true }))
      await settle(element)
      await page.keyboard.down('Shift')
      try {
        await settle(element)
        const focused = await paint(element)
        assert.equal(focused.focused, true, `${label}: ${description} did not retain DOM focus`)
        assert.deepEqual(
          focused.surfaces,
          resting.surfaces,
          `${label}: ${description} gained focus paint after pointer input + Shift`,
        )
      } finally {
        await page.keyboard.up('Shift')
      }
      count++
    }
  } finally {
    await sentinel.evaluate((node) => node.remove()).catch(() => {})
    await sentinel.dispose()
    await Promise.all(visible.map((element) => element.dispose()))
    await page.mouse.move(0, 0)
  }
  coverage.push({ surface: label, controls: count })
  log(`${label}: ${count} visible controls retain their resting border, shadow and SVG stroke`)
}

async function activeField(locator, label) {
  await settle(locator)
  const state = await locator.evaluate((node) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--primary)'
    node.parentElement.append(probe)
    const primary = getComputedStyle(probe).color
    probe.remove()
    const style = getComputedStyle(node)
    return {
      active: style.borderTopWidth === '1px' && style.borderTopColor === primary,
      outline: style.outlineStyle,
      shadow: style.boxShadow,
    }
  })
  assert.equal(state.active, true, `${label}: missing active-field border`)
  assert.equal(state.outline, 'none', `${label}: extra active-field outline`)
  assert.equal(state.shadow, 'none', `${label}: extra active-field ring`)
}

async function keyboardCue(locator, label) {
  await settle(locator)
  const state = await paint(locator)
  assert.equal(state.focused, true, `${label}: expected DOM focus`)
  assert.ok(
    state.surfaces.some((surface) => surface.outline !== 'none'),
    `${label}: no keyboard outline`,
  )
}

async function closeLayer(selector) {
  for (let attempt = 0; attempt < 3 && (await page.locator(selector).count()); attempt++) {
    await page.keyboard.press('Escape')
    if (
      await page
        .locator(selector)
        .waitFor({ state: 'detached', timeout: 1000 })
        .then(
          () => true,
          () => false,
        )
    )
      return
  }
  await page.locator(selector).waitFor({ state: 'detached' })
}

try {
  await signInDemo(page, demo)
  savedPrefs = await page.evaluate(async () => {
    const { convex } = await import('/src/lib/convex.ts')
    const prefs = await convex.query('prefs:get', { profile_id: window.PLANNER.CURRENT_USER })
    window.__focusControlsMutation = convex.mutation
    window.__focusControlsWrites = []
    convex.mutation = (...args) => {
      window.__focusControlsWrites.push(String(args[0]))
      return Promise.reject(new Error('Focus sweep attempted an unexpected backend write'))
    }
    return prefs
  })

  await page.locator('[data-all-nav]').click()
  await page
    .locator('[data-view-switch]')
    .getByRole('radio', { name: 'Board', exact: true })
    .click()
  await page.locator('[data-card]').first().waitFor()
  await sweep(page.locator('body'), 'Desktop Board and sidebar')

  await page.locator('aside').getByRole('button', { name: 'Luma Cloud', exact: true }).click()
  await page
    .locator('[data-view-switch]')
    .getByRole('radio', { name: 'Roadmap', exact: true })
    .click()
  const task = page.locator('[data-roadmap-task-open]').filter({ visible: true }).first()
  await task.waitFor()
  await sweep(page.locator('body'), 'Roadmap and sidebar')
  await task.click()
  await page.locator('[data-task-chrome]').waitFor()
  await sweep(
    page.getByRole('dialog', { name: 'Task', exact: true }),
    'Task details and description toolbar',
  )

  const status = page.locator('[role="combobox"][aria-label="Status"]')
  await status.click()
  await page.locator('[data-fieldselect-menu]').waitFor()
  await activeField(status, 'Open task status selector')
  await sweep(page.locator('[data-fieldselect-menu]'), 'Task status menu')
  await closeLayer('[data-fieldselect-menu]')
  assert.equal(
    await status.evaluate((node) => document.activeElement === node),
    true,
    'Status menu did not restore its trigger',
  )
  await page
    .locator('[data-task-chrome]')
    .getByRole('button', { name: 'Task actions', exact: true })
    .click()
  const taskMenu = page.locator('[data-slot="popover-content"]').last()
  await taskMenu.waitFor()
  await sweep(taskMenu, 'Task action menu')
  await closeLayer('[data-slot="popover-content"]')
  await page
    .locator('[data-task-chrome]')
    .getByRole('button', { name: 'Close (esc)', exact: true })
    .click()
  await page.locator('[data-task-scrim]').waitFor({ state: 'detached' })

  await route('inbox', '[data-inbox]')
  await sweep(page.locator('body'), 'Inbox filters, notification actions and sidebar')
  await route('settings/account', '[data-appearance-settings]')
  await page.locator('[data-appearance-mode="blue"]').scrollIntoViewIfNeeded()
  await sweep(page.locator('body'), 'Account preferences and appearance radios')
  const retention = page.locator('[data-message-retention]')
  await retention.scrollIntoViewIfNeeded()
  await retention.focus()
  await activeField(retention, 'Focused native retention select')
  await page.keyboard.press('Shift')
  await activeField(retention, 'Native select after screenshot modifier')
  await sweep(page.locator('body'), 'Account preferences lower controls')
  await route('settings/org-general', '[data-settings-page="org-general"]')
  const orgSwitch = page.getByRole('switch').first()
  await orgSwitch.scrollIntoViewIfNeeded()
  await sweep(page.locator('body'), 'Organization settings switches and selectors')

  await route('board/all', '[data-view-switch]')
  const newProject = page.getByRole('button', { name: 'New project', exact: true })
  await newProject.click()
  const dialog = page.locator('[data-modal-shell]')
  await dialog.waitFor()
  await sweep(dialog, 'New project controls')
  const name = dialog.getByRole('textbox', { name: 'Name', exact: true })
  await name.click()
  await activeField(name, 'Focused project name field')
  const access = dialog.locator('[data-new-project-access]')
  await access.click()
  const accessPopup = page.locator('[data-new-project-access-popup]')
  await accessPopup.waitFor()
  await activeField(access, 'Open project access field')
  await sweep(accessPopup, 'Project access popup checkboxes')
  await closeLayer('[data-new-project-access-popup]')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })

  // Positive controls use actual navigation keys, with no CSS or modality
  // attributes written by this script. View toggles only change local prefs.
  await page.keyboard.press('Tab')
  await keyboardCue(page.locator(':focus'), 'Tab navigation')
  const view = page.locator('[data-view-switch] [role="radio"]').first()
  await view.click()
  await page.keyboard.press('ArrowRight')
  await keyboardCue(page.locator('[data-view-switch] :focus'), 'Arrow-key view navigation')
  log(
    'Tab and arrow navigation retain visible focus; text fields, native selects and open selectors stay active',
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await route('board/all', '.mobile-task-row')
  const mobileTask = page.locator('.mobile-task-row').first()
  // A pointer click on this real heading establishes pointer interaction
  // without selecting a task or changing any setting.
  await page.locator('.mobile-task-section h2').first().click()
  await sweep(page.locator('body'), 'Mobile task list and navigation')
  await mobileTask.click()
  await page.locator('[data-mobile-task]').waitFor()
  await sweep(page.locator('[data-mobile-task]'), 'Mobile task controls')
  const detailsTab = page
    .locator('[data-mobile-task-sections]')
    .getByRole('radio', { name: 'Details', exact: true })
  await detailsTab.click()
  await sweep(page.locator('[data-mobile-task]'), 'Mobile task details and fields')
  await page.locator('[data-mobile-task-back]').click()

  assert.deepEqual(errors, [], 'Uncaught browser errors')
  const state = await page.evaluate(async () => {
    const { convex } = await import('/src/lib/convex.ts')
    return {
      writes: window.__focusControlsWrites,
      prefs: await convex.query('prefs:get', { profile_id: window.PLANNER.CURRENT_USER }),
    }
  })
  assert.deepEqual(state.writes, [], 'The sweep attempted a backend mutation')
  assert.deepEqual(state.prefs, savedPrefs, 'The sweep changed saved preferences')
  passed = true
} catch (error) {
  console.error('[focus-controls] FAIL:', error?.message || 'Browser drive failed')
  mkdirSync('scripts/shots', { recursive: true })
  await page.screenshot({ path: 'scripts/shots/focus-controls-failure.png' }).catch(() => {})
} finally {
  try {
    await page.evaluate(async () => {
      const P = window.PLANNER
      if (!P) return
      const { convex } = await import('/src/lib/convex.ts')
      if (window.__focusControlsMutation) convex.mutation = window.__focusControlsMutation
      if (window.__focusControlsOriginals) Object.assign(P, window.__focusControlsOriginals)
      delete window.__focusControlsMutation
      delete window.__focusControlsOriginals
      await P.signOut()
    })
    assert.deepEqual(await inspectBrowserDemo(demo), before, 'Northstar counts or anchor changed')
  } catch (error) {
    passed = false
    console.error('[focus-controls] cleanup failed:', error?.message || 'Unknown cleanup failure')
  }
  await browser.close()
}
if (passed) {
  const count = coverage.reduce((sum, item) => sum + item.controls, 0)
  log(
    `PASS: ${count} controls across ${coverage.length} surfaces; no backend writes, preference or dataset changes`,
  )
}
process.exitCode = passed ? 0 : 1

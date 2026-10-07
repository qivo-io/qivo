/* Focus visibility regression against the Northstar development demo.
 * Usage: node scripts/focus-smoke.mjs [baseURL]
 * Requires a running dev server; never seeds, resets or edits tasks. Existing
 * notifications stay unread, and the user's view preferences are restored. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { inspectBrowserDemo, loadBrowserDemo, signInDemo } from './browser-demo.mjs'

const demo = loadBrowserDemo(process.argv[2] ?? 'http://localhost:5199')
const before = await inspectBrowserDemo(demo)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const log = (message) => console.log(`[focus] ${message}`)
let initialUI
let passed = false

async function paint(locator) {
  return locator.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished.catch(() => {})),
    )
    const style = getComputedStyle(element)
    return {
      focused: document.activeElement === element,
      outline: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0,
      shadow: style.boxShadow,
      border: style.borderTopColor,
    }
  })
}

async function quiet(locator, baseline, message, retained = false) {
  const state = await paint(locator)
  assert.equal(state.outline, false, `${message}: unexpected outline`)
  assert.equal(state.shadow, baseline.shadow, `${message}: unexpected focus ring`)
  if (retained) assert.equal(state.focused, true, `${message}: DOM focus was lost`)
}

async function keyboardFocus(locator, message) {
  const state = await paint(locator)
  assert.equal(state.focused, true, `${message}: DOM focus is on another element`)
  assert.equal(state.outline, true, `${message}: keyboard focus is invisible`)
}

// Use real browser key events: Shift can change Chromium's :focus-visible
// before the OS shortcut's Meta key arrives. A synthetic dispatch misses it.
async function screenshotKeys(check) {
  await page.keyboard.down('Shift')
  try {
    await check('Shift')
    await page.keyboard.down('Meta')
    try {
      await page.keyboard.press('s')
      await check('Shift+Meta+S')
    } finally {
      await page.keyboard.up('Meta')
    }
  } finally {
    await page.keyboard.up('Shift')
  }
  await check('released screenshot shortcut')
}

async function activeField(locator, message) {
  await locator.evaluate(async (element) => {
    // Border colors transition; wait for the settled computed paint.
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished.catch(() => {})),
    )
  })
  const state = await locator.evaluate((element) => {
    const style = getComputedStyle(element)
    const probe = document.createElement('span')
    probe.style.color = 'var(--primary)'
    element.parentElement.append(probe)
    const primary = getComputedStyle(probe).color
    probe.remove()
    return {
      active: style.borderTopColor === primary && style.borderTopWidth === '1px',
      outline: style.outlineStyle,
      shadow: style.boxShadow,
    }
  })
  assert.equal(state.active, true, `${message}: missing active-field border`)
  assert.equal(state.outline, 'none', `${message}: extra outline`)
  assert.equal(state.shadow, 'none', `${message}: extra ring`)
}

async function pickerFocus(trigger, popup, message) {
  const rest = await paint(trigger)
  await trigger.click()
  await popup.waitFor()
  await activeField(trigger, `${message} open by pointer`)
  await page.keyboard.press('Escape')
  await popup.waitFor({ state: 'detached' })
  await quiet(trigger, rest, `${message} pointer dismissal retains focus quietly`, true)
  assert.equal((await paint(trigger)).border, rest.border, `${message} stayed lit after dismissal`)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  assert.equal((await paint(trigger)).focused, true, `${message} lost its keyboard position`)
  await activeField(trigger, `${message} keyboard focus`)
  await page.keyboard.press('Enter')
  await popup.waitFor()
  await page.keyboard.press('Escape')
  await popup.waitFor({ state: 'detached' })
  assert.equal((await paint(trigger)).focused, true, `${message} lost focus on keyboard dismissal`)
  await activeField(trigger, `${message} keyboard dismissal restores its active border`)
}

try {
  await signInDemo(page, demo)
  initialUI = await page.evaluate(() => {
    const P = window.PLANNER
    // Opening a task normally reads notifications. Preserve the demo's Inbox
    // for this visual-only drive; the original function is restored below.
    window.__focusSmokeMarkRead = P.markMessagesRead
    P.markMessagesRead = () => {}
    return P.loadUI()
  })

  const project = page.locator('aside').getByRole('button', { name: 'Pilot & Launch', exact: true })
  await project.click()
  const projectRest = await paint(project)
  await quiet(project, projectRest, 'Pointer-selected sidebar project', true)
  await project.hover()
  await screenshotKeys((step) => quiet(project, projectRest, `Sidebar after ${step}`, true))
  log('Sidebar keeps DOM focus without an outline or ring during the screenshot key sequence')

  await page.keyboard.press('Tab')
  await keyboardFocus(page.locator(':focus'), 'Tab to the next sidebar control')
  await page.keyboard.press('Shift+Tab')
  await keyboardFocus(project, 'Shift+Tab back to the project')
  await screenshotKeys((step) => keyboardFocus(project, `Keyboard-focused project after ${step}`))
  log('Tab and Shift+Tab show focus, and screenshot modifiers preserve existing keyboard cues')

  const stale = page.locator('[data-filter-stale]')
  const staleBefore = await stale.getAttribute('aria-pressed')
  await stale.click()
  if ((await stale.getAttribute('aria-pressed')) !== 'true') await stale.click()
  const toggleRest = await paint(stale)
  await quiet(stale, toggleRest, 'Pointer-selected toggle', true)
  await screenshotKeys((step) => quiet(stale, toggleRest, `Selected toggle after ${step}`, true))
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await keyboardFocus(stale, 'Keyboard returns to a selected toggle')
  if ((await stale.getAttribute('aria-pressed')) !== staleBefore) await stale.click()
  log('Selected toggles preserve their normal shadow without a screenshot-induced ring')

  await page.locator('aside').getByRole('button', { name: 'Luma Cloud', exact: true }).click()
  await page.locator('[data-view-switch]').getByRole('radio', { name: 'Roadmap' }).click()
  const task = page.locator('[data-roadmap-task-open]').filter({ visible: true }).first()
  await task.waitFor()
  const taskRest = await paint(task)
  await task.click()
  await page.locator('[data-task-scrim]').waitFor()
  await page.mouse.move(0, 0)
  await page.keyboard.press('Escape')
  await page.locator('[data-task-scrim]').waitFor({ state: 'detached' })
  await quiet(task, taskRest, 'Roadmap task after pointer open and Escape close', true)
  await task.click()
  await page.locator('[data-task-scrim]').waitFor()
  await pickerFocus(
    page.locator('[data-task-scrim] [role="combobox"][aria-label="Status"]'),
    page.locator('[data-fieldselect-menu]'),
    'Task status select',
  )
  const priority = page.locator('[data-task-scrim] [role="combobox"][aria-label="Priority"]')
  const priorityRest = await paint(priority)
  const priorityLabel = (await priority.innerText()).trim()
  await priority.click()
  await page.locator('[data-fieldselect-menu]').waitFor()
  await page.keyboard.press('Escape')
  await page.locator('[data-fieldselect-menu]').waitFor({ state: 'detached' })
  await quiet(priority, priorityRest, 'Pointer-dismissed priority retains quiet focus', true)
  // Priority initials are unique. Typing the current label exercises Radix's
  // closed-trigger typeahead without changing the task's priority.
  await page.keyboard.press(priorityLabel[0].toLowerCase())
  await activeField(priority, 'Select typeahead restores keyboard focus visibility')
  assert.equal((await priority.innerText()).trim(), priorityLabel, 'Typeahead changed priority')

  const calendarTrigger = page.locator(
    '[data-task-scrim] fieldset[aria-label="Plan start"] .datectl',
  )
  const calendar = page.locator('[data-calendar]')
  const calendarRest = await paint(calendarTrigger)
  await pickerFocus(calendarTrigger, calendar, 'Task calendar')
  await calendarTrigger.click()
  await calendar.waitFor()
  await calendar.getByRole('button', { name: 'Next month', exact: true }).click()
  await page.keyboard.press('Escape')
  await calendar.waitFor({ state: 'detached' })
  await quiet(calendarTrigger, calendarRest, 'Calendar restores focus from its own controls', true)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Enter')
  await calendar.waitFor()
  await page.keyboard.press('Tab')
  const endDate = page.locator('[data-task-scrim] fieldset[aria-label="Plan end"] .datectl')
  assert.equal((await paint(endDate)).focused, true, 'Tab did not reach the next date field')
  await page.locator('[data-task-scrim] .task-details-scroll').evaluate((element) => {
    element.scrollTop += 40
  })
  await calendar.waitFor({ state: 'detached' })
  assert.equal((await paint(endDate)).focused, true, 'Closing on scroll pulled focus backward')
  await activeField(endDate, 'Calendar close preserves keyboard focus already moved outside')
  await page.locator('[data-task-chrome]').getByRole('button', { name: 'Close (esc)' }).click()
  await page.locator('[data-task-scrim]').waitFor({ state: 'detached' })
  await quiet(task, taskRest, 'Roadmap task after pointer close')
  log('Task pickers preserve focus, support typeahead and keep Tab navigation outside a calendar')

  const newProject = page.getByRole('button', { name: 'New project', exact: true })
  const triggerRest = await paint(newProject)
  await newProject.click()
  // A modal access popover temporarily aria-hides its parent dialog. Keep the
  // shell locator addressable while checking the open trigger's border.
  const dialog = page.locator('[data-modal-shell]')
  const name = dialog.getByRole('textbox', { name: 'Name', exact: true })
  await name.waitFor()
  await dialog.getByRole('textbox', { name: 'Description', exact: true }).click()
  await name.click()
  await activeField(name, 'Pointer-focused name field')
  const access = dialog.locator('[data-new-project-access]')
  const accessRest = await paint(access)
  await access.click()
  await page.locator('[data-new-project-access-popup]').waitFor()
  await activeField(access, 'Open project access selector')
  const accessPopup = page.locator('[data-new-project-access-popup]')
  const checkbox = accessPopup.getByRole('checkbox').first()
  const checkboxRest = await paint(checkbox)
  await checkbox.click()
  await quiet(checkbox, checkboxRest, 'Pointer-toggled draft checkbox', true)
  await screenshotKeys((step) => quiet(checkbox, checkboxRest, `Checkbox after ${step}`, true))
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await keyboardFocus(checkbox, 'Keyboard returns to the draft checkbox')
  await accessPopup.getByRole('textbox').click()
  await page.keyboard.press('Escape')
  await page.locator('[data-new-project-access-popup]').waitFor({ state: 'detached' })
  await quiet(access, accessRest, 'Access selector restores pointer focus without blur', true)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await quiet(newProject, triggerRest, 'Dialog restores pointer focus silently', true)
  await newProject.click()
  await name.waitFor()
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  await quiet(newProject, triggerRest, 'Escape restores a pointer-opened dialog silently', true)
  log('Mouse-focused fields and open selectors retain their border; modal refocus stays quiet')

  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await keyboardFocus(newProject, 'Keyboard returns to New project')
  await page.keyboard.press('Enter')
  await name.waitFor()
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  await keyboardFocus(newProject, 'Keyboard-opened dialog restores visible focus')
  log('Keyboard-opened dialogs restore visible focus to their trigger')

  await page.locator('[data-view-switch]').getByRole('radio', { name: 'Board' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  const mobileRow = page.locator('.mobile-task-row').first()
  await mobileRow.waitFor()
  const rowRest = await paint(mobileRow)
  await mobileRow.click()
  const mobileBack = page.locator('[data-mobile-task-back]')
  await mobileBack.waitFor()
  await page.waitForFunction(() => document.activeElement?.matches('[data-mobile-task-back]'))
  const backRest = await paint(mobileBack)
  await quiet(mobileBack, backRest, 'Pointer-opened mobile task back button', true)
  await screenshotKeys((step) => quiet(mobileBack, backRest, `Mobile back after ${step}`, true))
  await mobileBack.click()
  await mobileBack.waitFor({ state: 'detached' })
  await quiet(mobileRow, rowRest, 'Mobile task restores its pointer-focused row', true)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await keyboardFocus(mobileRow, 'Keyboard returns to the mobile task row')
  await page.keyboard.press('Enter')
  await mobileBack.waitFor()
  await page.waitForFunction(() => document.activeElement?.matches('[data-mobile-task-back]'))
  await keyboardFocus(mobileBack, 'Keyboard-opened mobile task shows its back button focus')
  await page.keyboard.press('Escape')
  await mobileBack.waitFor({ state: 'detached' })
  await keyboardFocus(mobileRow, 'Mobile task restores keyboard focus to its row')
  await page.setViewportSize({ width: 1500, height: 1000 })
  log('Mobile task open, screenshot keys and close preserve pointer and keyboard focus behavior')

  // Projects and sub-projects have no managing-team selector. Team sharing is
  // edited in the Project access groups, so there is no team handover control
  // to exercise in this focus-only drive.
  log('Teamless project settings have no managing-team focus control')

  assert.deepEqual(errors, [], 'Uncaught browser errors')
  passed = true
} catch (error) {
  console.error('[focus] FAIL:', error?.message || 'Browser drive failed')
  mkdirSync('scripts/shots', { recursive: true })
  await page.screenshot({ path: 'scripts/shots/focus-failure.png' }).catch(() => {})
} finally {
  try {
    if (initialUI) {
      await page.evaluate(async (prefs) => {
        const P = window.PLANNER
        if (window.__focusSmokeMarkRead) {
          P.markMessagesRead = window.__focusSmokeMarkRead
          delete window.__focusSmokeMarkRead
        }
        P.saveUINow(prefs)
        const { convex } = await import('/src/lib/convex.ts')
        await convex.mutation('prefs:save', { profile_id: P.CURRENT_USER, prefs: P.loadUI() })
      }, initialUI)
      await page.evaluate(() => window.PLANNER.signOut())
    }
    assert.deepEqual(await inspectBrowserDemo(demo), before, 'Northstar counts or anchor changed')
  } catch (error) {
    passed = false
    console.error('[focus] cleanup failed:', error?.message || 'Unknown cleanup failure')
  }
  await browser.close()
}
if (passed) log('PASS; no tasks edited, notification state and view preferences preserved')
process.exitCode = passed ? 0 : 1

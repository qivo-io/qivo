/* Milestones window regression against the Northstar development demo.
 * Usage: node scripts/milestone-window-smoke.mjs [baseURL]
 * Requires a running dev server. Creates one temporary milestone through the
 * window, edits and deletes it there; finally sweeps anything it left behind,
 * never seeds or resets. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { inspectBrowserDemo, loadBrowserDemo, signInDemo } from './browser-demo.mjs'

const demo = loadBrowserDemo(process.argv[2] ?? 'http://localhost:5199')
const before = await inspectBrowserDemo(demo)
const prefix = `Milestone window ${randomUUID().slice(0, 8)}`
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const log = (message) => console.log(`[milestone-window] ${message}`)
const modal = () => page.locator('[data-modal-shell]')
const editor = () => modal().locator('[data-milestone-editor]')
const editButton = (name) => modal().getByRole('button', { name: `Edit ${name}`, exact: true })
let passed = false

async function selectView(name) {
  await page.locator('[data-view-switch]').getByRole('radio', { name, exact: true }).click()
  await page.waitForFunction(
    (name) => document.querySelector(`[data-workspace-view="${name}"]`),
    name === 'Board' ? 'kanban' : name.toLowerCase(),
  )
}

/* The backend's rows for this run, read through the dev app's authenticated
   client once its outstanding writes have landed. */
async function persisted() {
  await page.waitForFunction(async () => {
    const { convex } = await import('/src/lib/convex.ts')
    return convex.connectionState().inflightMutations === 0
  })
  return page.evaluate(async (prefix) => {
    const { convex } = await import('/src/lib/convex.ts')
    const snapshot = await convex.query('snapshot:forMe', {})
    return snapshot.milestones
      .filter((row) => row.name.startsWith(prefix))
      .map(({ name, week, project_id }) => ({ name, week, project_id }))
  }, prefix)
}

/* The store dispatches a write a tick after it paints the row, so the backend
   is polled until it agrees (or the deadline passes and the diff is shown). */
async function expectPersisted(expected, message) {
  const deadline = Date.now() + 15000
  let rows = await persisted()
  while (Date.now() < deadline) {
    try {
      assert.deepEqual(rows, expected)
      return
    } catch {
      await page.waitForTimeout(400)
      rows = await persisted()
    }
  }
  assert.deepEqual(rows, expected, message)
}

/* Picks the day the given week starts on in the window's own calendar popup,
   paging forward from the month it opens on. */
async function pickWeek(week) {
  const iso = await page.evaluate((week) => {
    const P = window.PLANNER
    return P.isoFromDate(P.weekToDate(week))
  }, week)
  await editor().locator('.datectl').click()
  const calendar = page.locator('[data-calendar]')
  await calendar.waitFor()
  for (let page_ = 0; page_ < 3; page_++) {
    if (await calendar.locator(`[data-cal-day="${iso}"]`).count()) break
    await calendar.getByRole('button', { name: 'Next month' }).click()
  }
  await calendar.locator(`[data-cal-day="${iso}"]`).click()
  await calendar.waitFor({ state: 'detached' })
  return iso
}

async function cleanup() {
  const context = await browser.newContext()
  try {
    const cleanupPage = await context.newPage()
    await signInDemo(cleanupPage, demo)
    await cleanupPage.evaluate(
      async ({ prefix, orgSlug }) => {
        const { convex } = await import('/src/lib/convex.ts')
        const snapshot = await convex.query('snapshot:forMe', {})
        const org = snapshot.orgs.find((row) => row.slug === orgSlug)
        if (!org) throw new Error('Cleanup organization is unavailable')
        for (const row of snapshot.milestones.filter((row) => row.name.startsWith(prefix))) {
          const project = snapshot.projects.find((project) => project.id === row.project_id)
          if (project?.org_id === org.id)
            await convex.mutation('projects:removeMilestone', { org_id: org.id, id: row.id })
        }
      },
      { prefix, orgSlug: demo.orgSlug },
    )
    await cleanupPage.evaluate(() => window.PLANNER?.signOut()).catch(() => {})
  } finally {
    await context.close()
  }
}

try {
  await signInDemo(page, demo)
  const fixture = await page.evaluate(() => {
    const P = window.PLANNER
    const project = P.projects.find((p) => p.name === 'Luma Sensor' && p.type === 'meta')
    if (!project) throw new Error('Northstar Luma Sensor fixture is unavailable')
    P.saveUINow({ roadmapWin: P.DEFAULT_WIN })
    const iso = (week) => P.isoFromDate(P.weekToDate(week))
    return { project: project.id, today: P.TODAY_WEEK, thisWeek: iso(P.TODAY_WEEK) }
  })
  await page.locator('aside').getByText('Luma Sensor', { exact: true }).click()
  await selectView('Overview')
  const existing = await page.evaluate(
    (id) => window.PLANNER.milestonesIn(id).length,
    fixture.project,
  )

  // ---- the + opens the window on the new row; Enter adds and keeps it open
  await page.getByRole('button', { name: 'New milestone', exact: true }).click()
  await modal().waitFor()
  assert.equal(await modal().getByRole('heading', { name: 'Milestones' }).count(), 1)
  assert.ok(await modal().getByText('Luma Sensor', { exact: true }).isVisible(), 'No project chip')
  const newBox = modal().getByRole('textbox', { name: 'New milestone', exact: true })
  assert.ok(await newBox.evaluate((el) => el === document.activeElement), 'New box not focused')
  assert.equal(await modal().getByRole('button', { name: 'Add', exact: true }).isDisabled(), true)
  await newBox.fill(`${prefix} A`)
  await page.keyboard.press('Enter')
  await editButton(`${prefix} A`).waitFor()
  assert.equal(await newBox.inputValue(), '', 'New box was not cleared after Add')
  assert.equal(await modal().count(), 1, 'Window closed after Add')
  assert.equal(
    await modal().locator('[data-milestone-row]').count(),
    existing + 1,
    'List did not grow by one',
  )
  await expectPersisted([
    { name: `${prefix} A`, week: fixture.thisWeek, project_id: fixture.project },
  ])
  log('The + opens Milestones on the new row; Enter adds this week and the window stays open')

  // ---- Edit opens the row in place: rename, move two weeks, Save
  await editButton(`${prefix} A`).click()
  const nameBox = editor().getByRole('textbox', { name: 'Name', exact: true })
  assert.equal(await nameBox.inputValue(), `${prefix} A`)
  assert.ok(await nameBox.evaluate((el) => el === document.activeElement), 'Editor not focused')
  await nameBox.fill(`${prefix} B`)
  const moved = await pickWeek(fixture.today + 2)
  assert.ok(
    await editor()
      .getByText(
        `Week ${await page.evaluate((w) => window.PLANNER.weekNumberOf(w).num, fixture.today + 2)}`,
      )
      .isVisible(),
    'Editor does not show the picked week',
  )
  await editor().getByRole('button', { name: 'Save', exact: true }).click()
  await editor().waitFor({ state: 'detached' })
  await editButton(`${prefix} B`).waitFor()
  await expectPersisted([{ name: `${prefix} B`, week: moved, project_id: fixture.project }])
  log('Edit renames and moves the milestone in place; Save persists both')

  // ---- Escape cancels an edit and leaves the window open
  await editButton(`${prefix} B`).click()
  await editor().getByRole('textbox', { name: 'Name', exact: true }).fill(`${prefix} discarded`)
  await page.keyboard.press('Escape')
  await editor().waitFor({ state: 'detached' })
  assert.equal(await modal().count(), 1, 'Escape closed the window instead of the edit')
  await editButton(`${prefix} B`).waitFor()
  await expectPersisted(
    [{ name: `${prefix} B`, week: moved, project_id: fixture.project }],
    'Escape saved the discarded name',
  )
  await modal().getByRole('button', { name: 'Done', exact: true }).click()
  await modal().waitFor({ state: 'detached' })
  log('Escape cancels the edit; Done closes the window')

  // ---- an Overview row and a roadmap diamond reopen it on that row's editor
  await page.locator('.overview-milestone', { hasText: `${prefix} B` }).click()
  await editor().waitFor()
  assert.equal(
    await editor().getByRole('textbox', { name: 'Name', exact: true }).inputValue(),
    `${prefix} B`,
  )
  await editor().getByRole('button', { name: 'Cancel', exact: true }).click()
  await modal().getByRole('button', { name: 'Done', exact: true }).click()
  await modal().waitFor({ state: 'detached' })
  await selectView('Roadmap')
  const flagId = await page.evaluate(
    (name) => window.PLANNER.milestones.find((m) => m.name === name)?.id,
    `${prefix} B`,
  )
  await page.locator(`[data-msflag="${flagId}"]`).click()
  await editor().waitFor()
  assert.equal(
    await editor().getByRole('textbox', { name: 'Name', exact: true }).inputValue(),
    `${prefix} B`,
  )
  log('An Overview row and a roadmap diamond open the window with that milestone in edit')

  // ---- Delete arms, then confirms, then the row is gone
  await editor().getByRole('button', { name: 'Delete', exact: true }).click()
  await editor().getByRole('button', { name: 'Confirm delete', exact: true }).click()
  await editor().waitFor({ state: 'detached' })
  assert.equal(await editButton(`${prefix} B`).count(), 0, 'Deleted milestone still listed')
  assert.equal(await modal().locator('[data-milestone-row]').count(), existing)
  await expectPersisted([], 'Deleted milestone still persisted')
  await modal().getByRole('button', { name: 'Done', exact: true }).click()
  await modal().waitFor({ state: 'detached' })
  assert.deepEqual(errors, [], 'Browser reported uncaught errors')
  log('Delete arms, confirms and removes the milestone; the list is back to its start')
  passed = true
} catch (error) {
  console.error('[milestone-window] FAIL:', error?.message || 'Browser drive failed')
  mkdirSync('scripts/shots', { recursive: true })
  await page.screenshot({ path: 'scripts/shots/milestone-window-failure.png' }).catch(() => {})
} finally {
  try {
    await page.close()
    await cleanup()
    assert.deepEqual(await inspectBrowserDemo(demo), before, 'Northstar counts or anchor changed')
    log('Temporary milestone removed; Northstar counts and anchor preserved')
  } catch (error) {
    passed = false
    console.error('[milestone-window] cleanup failed:', error?.message || 'Unknown cleanup failure')
  }
  await browser.close()
}
if (passed) log('PASS')
process.exit(passed ? 0 : 1)

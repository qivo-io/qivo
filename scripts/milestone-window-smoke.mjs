/* Milestones window regression against the Northstar development demo.
 * Usage: node scripts/milestone-window-smoke.mjs [baseURL]
 * Requires a running dev server. Creates one temporary milestone through the
 * window, edits and deletes it there, and one past milestone through the
 * backend that Past shows once expanded; finally removes the milestones the
 * run made, by their ids, never seeds or resets. It reads milestones from
 * the server (milestones.between, as the window reads milestones.section),
 * never from the workspace's copy, so a copy seeded before Northstar had
 * past milestones runs too. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { inspectBrowserDemo, loadBrowserDemo, navRows, signInDemo } from './browser-demo.mjs'

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

/* The ids of the milestones this run made, which cleanup() removes. */
const made = new Set()

/* Every milestone of `project` the backend holds on a day in [from, to),
   read on `on` through the dev app's authenticated client with the window's
   own bounded read of a range of days (milestones.between). */
function serverRows(on, project, from, to) {
  return on.evaluate(
    async ({ project, from, to }) => {
      const { convex } = await import('/src/lib/convex.ts')
      const rows = []
      let after
      for (let round = 0; round < 20; round++) {
        const batch = await convex.query('milestones:between', {
          projects: [project],
          from,
          to,
          ...(after ? { after } : {}),
        })
        rows.push(...batch.rows)
        if (!batch.next) return rows
        after = batch.next
      }
      throw new Error('The range did not end within 20 batches')
    },
    { project, from, to },
  )
}

/* The project and weeks a run reads and writes in, 13 weeks back to 13
   ahead, once it chose them. */
let span = null

/* The backend's rows for this run, read once the app's outstanding writes
   have landed. */
async function persisted() {
  await page.waitForFunction(async () => {
    const { convex } = await import('/src/lib/convex.ts')
    return convex.connectionState().inflightMutations === 0
  })
  const rows = (await serverRows(page, span.project, span.from, span.to)).filter((row) =>
    row.name.startsWith(prefix),
  )
  for (const row of rows) made.add(row.id)
  return rows.map(({ name, week, project_id }) => ({ name, week, project_id }))
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

/* Removes the milestones this run made that the backend still holds: the
   ids it recorded, and any row named with its prefix that the server
   answers in the run's weeks of its project, as an add the run painted
   before a failure. A milestone the run already deleted stays deleted. */
async function cleanup() {
  if (!span) return
  const context = await browser.newContext()
  try {
    const cleanupPage = await context.newPage()
    await signInDemo(cleanupPage, demo)
    const held = await serverRows(cleanupPage, span.project, span.from, span.to)
    for (const row of held) if (row.name.startsWith(prefix)) made.add(row.id)
    const left = held.filter((row) => made.has(row.id)).map((row) => row.id)
    await cleanupPage.evaluate(
      async ({ ids, org }) => {
        const { convex } = await import('/src/lib/convex.ts')
        for (const id of ids) await convex.mutation('projects:removeMilestone', { org_id: org, id })
      },
      { ids: left, org: span.org },
    )
    await cleanupPage.evaluate(() => window.PLANNER?.signOut()).catch(() => {})
  } finally {
    await context.close()
  }
}

try {
  await signInDemo(page, demo)
  /* A top-level project holds one milestone a week, so the run uses a
     Northstar project, Luma Sensor when it can, whose milestones leave this
     week and the week two ahead free for the milestone it adds and moves,
     and a week before this one free for the past milestone it makes. */
  const grid = await page.evaluate(() => {
    const P = window.PLANNER
    P.saveUINow({ roadmapWin: P.DEFAULT_WIN })
    const iso = (week) => P.isoFromDate(P.weekToDate(week))
    const weeks = Array.from({ length: 27 }, (_, i) => iso(P.TODAY_WEEK - 13 + i))
    return { org: P.org.id, today: P.TODAY_WEEK, weeks }
  })
  // the demo organization's live top-level projects, Luma Sensor first, from
  // the navigation reads, as the store holds no project list
  const metas = (await navRows(page, 'projectNav:page', { org_id: grid.org }))
    .sort((a, b) => Number(b.name === 'Luma Sensor') - Number(a.name === 'Luma Sensor'))
    .map((p) => ({ id: p.id, name: p.name }))
  // the first day of the week `offset` weeks from this one
  const at = (offset) => grid.weeks[13 + offset]
  let fixture = null
  for (const meta of metas) {
    const rows = await serverRows(page, meta.id, grid.weeks[0], grid.weeks[26])
    // the first day of each milestone's week, since a milestone stored on
    // another day, as a REST add can be, still takes its whole week
    const taken = new Set(
      await page.evaluate(
        (days) => {
          const P = window.PLANNER
          return days.map((day) => P.isoFromDate(P.weekToDate(P.isoToWeek(day))))
        },
        rows.map((row) => row.week),
      ),
    )
    const pastWeek = [-1, -2, -3, -4, -5, -6].map(at).find((week) => !taken.has(week))
    if (!taken.has(at(0)) && !taken.has(at(2)) && pastWeek) {
      fixture = {
        project: meta.id,
        name: meta.name,
        today: grid.today,
        thisWeek: at(0),
        pastWeek,
      }
      break
    }
  }
  if (!fixture) throw new Error('No Northstar project has the weeks this run needs free')
  span = { project: fixture.project, org: grid.org, from: grid.weeks[0], to: grid.weeks[26] }
  await page.locator('aside').getByText(fixture.name, { exact: true }).click()
  await selectView('Overview')
  const upcomingRows = () =>
    modal().locator('[data-milestone-section="upcoming"] [data-milestone-row]')

  // ---- the + opens the window on the new row; Enter adds and keeps it open
  await page.getByRole('button', { name: 'New milestone', exact: true }).click()
  await modal().waitFor()
  await modal()
    .locator('[data-milestone-section="upcoming"][data-milestone-section-state="ok"]')
    .waitFor()
  const existing = await upcomingRows().count()
  assert.equal(await modal().getByRole('heading', { name: 'Milestones' }).count(), 1)
  assert.ok(await modal().getByText(fixture.name, { exact: true }).isVisible(), 'No project chip')
  const newBox = modal().getByRole('textbox', { name: 'New milestone', exact: true })
  assert.ok(await newBox.evaluate((el) => el === document.activeElement), 'New box not focused')
  assert.equal(await modal().getByRole('button', { name: 'Add', exact: true }).isDisabled(), true)
  await newBox.fill(`${prefix} A`)
  await page.keyboard.press('Enter')
  await editButton(`${prefix} A`).waitFor()
  // the row paints at once, the box clears once the server created it
  const cleared = Date.now() + 15000
  while ((await newBox.inputValue()) !== '' && Date.now() < cleared) await page.waitForTimeout(200)
  assert.equal(await newBox.inputValue(), '', 'New box was not cleared after Add')
  assert.equal(await modal().count(), 1, 'Window closed after Add')
  assert.equal(await upcomingRows().count(), existing + 1, 'Upcoming did not grow by one')
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

  // ---- an Overview row and a roadmap diamond reopen it on that row's editor.
  // The Overview lists the first 10 upcoming milestones from the server, and
  // the row, two weeks on, has at most two before it, as a project holds one
  // milestone a week
  await page
    .locator('[data-workspace-view] [data-overview-milestones] .overview-milestone', {
      hasText: `${prefix} B`,
    })
    .click()
  await editor().waitFor()
  assert.equal(
    await editor().getByRole('textbox', { name: 'Name', exact: true }).inputValue(),
    `${prefix} B`,
  )
  await editor().getByRole('button', { name: 'Cancel', exact: true }).click()
  await modal().getByRole('button', { name: 'Done', exact: true }).click()
  await modal().waitFor({ state: 'detached' })
  // the milestone the run made, whose id the backend's rows give
  const [flagId] = (await serverRows(page, span.project, span.from, span.to))
    .filter((row) => row.name === `${prefix} B`)
    .map((row) => row.id)
  assert.ok(flagId, 'The backend does not hold the renamed milestone')
  await selectView('Roadmap')
  await page.locator(`[data-msflag="${flagId}"]`).click()
  await editor().waitFor()
  assert.equal(
    await editor().getByRole('textbox', { name: 'Name', exact: true }).inputValue(),
    `${prefix} B`,
  )
  log('An Overview row and a roadmap diamond open the window with that milestone in edit')

  // ---- Delete arms, then confirms, then the row is gone
  await editor().getByRole('button', { name: 'Delete', exact: true }).click()
  // the app ignores a second click within 500 ms of arming (lib/useConfirmArm)
  await page.waitForTimeout(600)
  await editor().getByRole('button', { name: 'Confirm delete', exact: true }).click()
  await editor().waitFor({ state: 'detached' })
  assert.equal(await editButton(`${prefix} B`).count(), 0, 'Deleted milestone still listed')
  assert.equal(await upcomingRows().count(), existing)
  await expectPersisted([], 'Deleted milestone still persisted')
  log('Delete arms, confirms and removes the milestone; Upcoming is back to its start')

  // ---- Past: collapsed, reading nothing, then the run's past milestone in
  // its place among the project's past milestones, newest first
  const pastName = `${prefix} past`
  const pastId = randomUUID()
  made.add(pastId)
  await page.evaluate(
    async ({ org, id, project, name, week }) => {
      const { convex } = await import('/src/lib/convex.ts')
      await convex.mutation('projects:addMilestone', {
        org_id: org,
        id,
        project_id: project,
        name,
        week,
      })
    },
    { org: span.org, id: pastId, project: fixture.project, name: pastName, week: fixture.pastWeek },
  )
  const toggle = modal().locator('[data-milestone-past-toggle]')
  await toggle.waitFor()
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'Past was not collapsed')
  assert.equal(await modal().getByText(pastName, { exact: true }).count(), 0, 'Past showed early')
  await toggle.click()
  const pastSection = modal().locator('[data-milestone-section="past"]')
  await pastSection.locator(`[data-milestone-row="${pastId}"]`).waitFor()
  const days = await pastSection
    .locator('[data-milestone-row] time')
    .evaluateAll((times) => times.map((time) => time.getAttribute('datetime')))
  assert.ok(days.length >= 1, 'Past shows no milestone')
  assert.deepEqual(days, [...days].sort().reverse(), 'Past is not newest first')
  log(`Past expands to ${days.length} past milestones, newest first, the run's own among them`)
  await modal().getByRole('button', { name: 'Done', exact: true }).click()
  await modal().waitFor({ state: 'detached' })
  assert.deepEqual(errors, [], 'Browser reported uncaught errors')
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

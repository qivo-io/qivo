/* Roadmap undo regression against the Northstar development demo.
 * Usage: node scripts/roadmap-undo-smoke.mjs [baseURL]
 * Requires the matching backend and a running dev server. Creates only
 * temporary tasks/milestones; finally removes them, never seeds or resets. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { chromium } from 'playwright'
import { inspectBrowserDemo, loadBrowserDemo, signInDemo } from './browser-demo.mjs'

const demo = loadBrowserDemo(process.argv[2] ?? 'http://localhost:5199')
const before = await inspectBrowserDemo(demo)
const prefix = `Roadmap undo ${randomUUID().slice(0, 8)}`
const tasks = ['parent', 'child', 'leaf'].map((name) => ({
  id: randomUUID(),
  title: `${prefix} ${name}`,
}))
const milestone = { id: randomUUID(), name: `${prefix} milestone` }
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const log = (message) => console.log(`[roadmap-undo] ${message}`)
const undo = () => page.locator('[data-roadmap-undo]').filter({ visible: true })
const bar = (id) => page.locator(`[data-bar="${id}"]`)
let initialUI
let passed = false

async function selectView(name) {
  await page.locator('[data-view-switch]').getByRole('radio', { name, exact: true }).click()
  await page.waitForFunction(
    (name) => document.querySelector(`[data-workspace-view="${name}"]`),
    name === 'Board' ? 'kanban' : name.toLowerCase(),
  )
}

async function settled(count) {
  await page.waitForFunction((count) => {
    const history = window.PLANNER.roadmapUndo
    return history && !history.busy && history.count === count
  }, count)
  await page.waitForFunction(() => window.__roadmapSmokeConnection().inflightMutations === 0)
}

async function persisted() {
  await page.waitForFunction(() => window.__roadmapSmokeConnection().inflightMutations === 0)
  const client = new ConvexHttpClient(demo.target.url, { logger: false })
  client.setAuth(
    await page.evaluate(async () => {
      const { authClient } = await import('/src/lib/auth.ts')
      const { data } = await authClient.convex.token()
      if (!data?.token) throw new Error('Could not authenticate roadmap persistence check')
      return data.token
    }),
  )
  const snapshot = await client.query(makeFunctionReference('snapshot:forMe'), {})
  return {
    tasks: tasks.map(({ id }) => {
      const row = snapshot.issues.find((issue) => issue.id === id)
      assert.ok(row, 'A temporary task disappeared')
      return {
        id,
        start: row.start_week ?? null,
        end: row.end_week ?? null,
        remaining: row.remaining_hours ?? null,
        measured: row.remaining_set_at ?? null,
      }
    }),
    milestones: snapshot.milestones
      .filter((row) => row.name.startsWith(prefix))
      .map(({ id, name, week, project_id }) => ({ id, name, week, project_id }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
}

async function dragWeeks(id, weeks) {
  await bar(id).scrollIntoViewIfNeeded()
  const span = await page.evaluate((id) => {
    const it = window.PLANNER.issueById[id]
    return it.end - it.start + 1
  }, id)
  const box = await bar(id).boundingBox()
  assert.ok(box, 'Temporary task has no visible roadmap bar')
  const weekWidth = (box.width + 6) / span
  const x = box.x + Math.min(22, box.width / 2)
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + weeks * weekWidth, y, { steps: 8 })
  await page.mouse.up()
}

async function readTask(id) {
  await bar(id).click({ position: { x: 18, y: 10 } })
  await page.locator('[data-issue-key]').first().waitFor({ state: 'visible' })
  assert.equal((await page.locator('[data-issue-key]').first().innerText()).trim(), id)
}

async function closeTask() {
  await page.keyboard.press('Escape')
  await page.locator('[data-issue-key]').waitFor({ state: 'detached' })
}

async function cleanup() {
  const context = await browser.newContext()
  try {
    const cleanupPage = await context.newPage()
    await signInDemo(cleanupPage, demo)
    await cleanupPage.evaluate(
      async ({ ids, prefix, orgSlug, initialUI }) => {
        const P = window.PLANNER
        const { convex } = await import('/src/lib/convex.ts')
        const snapshot = await convex.query('snapshot:forMe', {})
        const org = snapshot.orgs.find((row) => row.slug === orgSlug)
        if (!org) throw new Error('Cleanup organization is unavailable')
        for (const id of [...ids].reverse()) {
          if (snapshot.issues.some((row) => row.id === id && row.org_id === org.id))
            await convex.mutation('issues:deleteDeep', { org_id: org.id, id })
        }
        for (const row of snapshot.milestones.filter((row) => row.name.startsWith(prefix))) {
          const project = snapshot.projects.find((project) => project.id === row.project_id)
          if (project?.org_id === org.id)
            await convex.mutation('projects:removeMilestone', { org_id: org.id, id: row.id })
        }
        if (initialUI) {
          P.saveUINow(initialUI)
          await convex.mutation('prefs:save', { profile_id: P.CURRENT_USER, prefs: P.loadUI() })
        }
      },
      { ids: tasks.map(({ id }) => id), prefix, orgSlug: demo.orgSlug, initialUI },
    )
    await cleanupPage.evaluate(() => window.PLANNER?.signOut()).catch(() => {})
  } finally {
    await context.close()
  }
}

try {
  await signInDemo(page, demo)
  initialUI = await page.evaluate(() => window.PLANNER.loadUI())
  const fixture = await page.evaluate(
    async ({ tasks, milestone }) => {
      const P = window.PLANNER
      const project = P.projects.find((p) => p.name === 'Luma Sensor' && p.type === 'meta')
      const sub = P.projects.find((p) => p.parent === project?.id && p.name === 'Electronics')
      if (!project || !sub) throw new Error('Northstar Luma Sensor fixture is unavailable')
      P.saveUINow({ roadmapWin: P.DEFAULT_WIN })
      const { convex } = await import('/src/lib/convex.ts')
      window.__roadmapSmokeConnection = () => convex.connectionState()
      const today = P.TODAY_WEEK
      const iso = (week) => P.isoFromDate(P.weekToDate(week))
      for (const [i, task] of tasks.entries()) {
        await convex.mutation('issues:create', {
          org_id: P.org.id,
          id: task.id,
          project_id: sub.id,
          title: task.title,
          status: 'todo',
          priority: 'low',
          start_week: iso(today),
          end_week: iso(today + 1),
          ...(i === 1 ? { parent_id: tasks[0].id } : {}),
          ...(i === 2 ? { assignee_id: P.CURRENT_USER, remaining_hours: 6 } : {}),
        })
      }
      await convex.mutation('issues:addLink', {
        org_id: P.org.id,
        id: crypto.randomUUID(),
        source_id: tasks[2].id,
        target_id: tasks[0].id,
        type: 'blocks',
      })
      await convex.mutation('projects:addMilestone', {
        org_id: P.org.id,
        id: milestone.id,
        project_id: project.id,
        name: milestone.name,
        week: iso(today),
      })
      return { project: project.id, today, nora: P.CURRENT_USER }
    },
    { tasks, milestone },
  )
  await page.waitForFunction(
    (ids) => ids.every((id) => window.PLANNER.issues.some((it) => it.uuid === id)),
    tasks.map(({ id }) => id),
  )
  const [, child, leaf] = await page.evaluate(
    (ids) => ids.map((id) => window.PLANNER.issues.find((it) => it.uuid === id).id),
    tasks.map(({ id }) => id),
  )
  await page.locator('aside').getByText('Luma Sensor', { exact: true }).click()
  await selectView('Roadmap')
  await page.locator('[data-roadmap-toolbar]').waitFor()
  await page.getByPlaceholder('Filter tasks…').fill(prefix)
  await settled(0)
  assert.equal(await undo().isDisabled(), true)
  assert.equal(await page.locator('[data-roadmap-revert-all]').count(), 0)
  const baseline = await persisted()

  await page.locator('[data-auto-correct]').click()
  await settled(1)
  const corrected = await persisted()
  assert.notEqual(corrected.tasks[0].start, baseline.tasks[0].start)
  assert.notEqual(corrected.tasks[1].start, baseline.tasks[1].start)
  assert.deepEqual(corrected.tasks[2], baseline.tasks[2], 'Auto-correct moved its blocker')
  await undo().click()
  await settled(0)
  assert.deepEqual(await persisted(), baseline, 'Grouped Auto-correct undo lost family dates')
  log('One Auto-correct action creates one undo step for its whole task family')

  await dragWeeks(child, 2)
  await settled(1)
  const first = await persisted()
  assert.notEqual(first.tasks[1].start, baseline.tasks[1].start, 'Child drag was not saved')
  assert.notEqual(first.tasks[0].end, baseline.tasks[0].end, 'Child drag did not widen parent')
  await dragWeeks(leaf, 1)
  await settled(2)
  await undo().click()
  await settled(1)
  assert.deepEqual(await persisted(), first, 'Undo did not restore only the latest action')
  log('Task drags save; Undo restores one step and retains earlier parent widening')

  await page.evaluate(({ id, week }) => window.PLANNER.updateMilestone(id, { week }), {
    id: milestone.id,
    week: fixture.today + 1,
  })
  await settled(2)
  await page.evaluate((id) => window.PLANNER.removeMilestone(id), milestone.id)
  await settled(3)
  await undo().click()
  await settled(2)
  assert.equal((await persisted()).milestones.length, 1, 'Undo did not restore deleted milestone')
  await page.locator('[data-new-milestone]').click()
  const modal = page.locator('[data-modal-shell]')
  await modal.getByRole('textbox', { name: 'New milestone', exact: true }).fill(`${prefix} added`)
  await modal.getByRole('button', { name: 'Add', exact: true }).click()
  await modal.getByRole('button', { name: `Edit ${prefix} added`, exact: true }).waitFor()
  await modal.getByRole('button', { name: 'Done', exact: true }).click()
  await modal.waitFor({ state: 'detached' })
  await settled(3)
  assert.equal((await persisted()).milestones.length, 2, 'New milestone was not saved')
  for (let remaining = 2; remaining >= 0; remaining--) {
    await undo().click()
    await settled(remaining)
  }
  assert.deepEqual(
    await persisted(),
    baseline,
    'Repeated Undo did not restore dates and milestones',
  )
  log(
    'Repeated Undo restores widened ancestors and reverses milestone creation, edits and deletion',
  )

  await page.locator('[data-ue-open]').click()
  await page.locator(`[data-ue-jump="${fixture.nora}"]`).click()
  const estimate = page.locator(`[data-ue-row="${leaf}"] [data-ue-input]`)
  await estimate.fill('11')
  await estimate.press('Enter')
  await settled(1)
  await page.keyboard.press('Escape')
  await page.locator('[data-update-estimate]').waitFor({ state: 'detached' })
  assert.equal((await persisted()).tasks[2].remaining, 11)
  await undo().click()
  await settled(0)
  assert.deepEqual(await persisted(), baseline, 'Estimate undo lost its original measurement time')
  log('Update Estimate undo restores remaining hours and their original measurement timestamp')

  await dragWeeks(child, 1)
  await settled(1)
  await page.locator('[data-all-nav]').click()
  await settled(1)
  await page.locator('aside').getByText('Luma Sensor', { exact: true }).click()
  await settled(1)
  await readTask(child)
  await closeTask()
  await settled(1)
  assert.equal(await undo().isEnabled(), true, 'Reading a task cleared undo history')
  await readTask(child)
  await page.locator('h1[data-task-title]').click()
  const title = page.getByRole('textbox', { name: 'Task title', exact: true })
  await title.fill(`${prefix} child edited`)
  await title.press('Enter')
  await page.waitForFunction(() => window.PLANNER.roadmapUndo.disabled)
  await closeTask()
  await settled(0)
  assert.equal(await undo().isDisabled(), true, 'Task editing left undo available')
  await dragWeeks(leaf, 1)
  await settled(0)
  assert.equal(await undo().isDisabled(), true, 'History restarted before leaving Roadmap')
  log('Scope changes and task reading retain history; task editing disables it for the visit')

  await selectView('Board')
  await selectView('Roadmap')
  await settled(0)
  assert.equal(await page.evaluate(() => window.PLANNER.roadmapUndo.disabled), false)
  await dragWeeks(leaf, 1)
  await settled(1)
  const beforeLeaving = await persisted()
  await selectView('Board')
  await selectView('Roadmap')
  await settled(0)
  assert.deepEqual(await persisted(), beforeLeaving, 'Leaving Roadmap reverted saved data')

  await selectView('Board')
  await page.setViewportSize({ width: 390, height: 844 })
  await selectView('Roadmap')
  await page.locator('.mobile-roadmap-agenda').waitFor()
  const mobileBaseline = await persisted()
  await page.evaluate((id) => {
    const P = window.PLANNER
    const it = P.issueById[id]
    P.updateIssue(id, { start: it.start - 1, end: it.end - 1 })
  }, leaf)
  await settled(1)
  await page.getByRole('button', { name: 'Timeline & team', exact: true }).click()
  await page.locator('[data-roadmap-landscape]').waitFor()
  await settled(1)
  await page.locator('[data-landscape-back]').click()
  await page.locator('.mobile-roadmap-agenda').waitFor()
  await undo().click()
  await settled(0)
  assert.deepEqual(await persisted(), mobileBaseline, 'Phone Undo did not restore saved dates')
  assert.equal(await page.locator('[data-roadmap-revert-all]').count(), 0)
  assert.deepEqual(errors, [], 'Browser reported uncaught errors')
  log('Leaving preserves saved changes; reentry starts fresh; phone agenda and timeline share undo')
  passed = true
} catch (error) {
  console.error('[roadmap-undo] FAIL:', error?.message || 'Browser drive failed')
  mkdirSync('scripts/shots', { recursive: true })
  await page.screenshot({ path: 'scripts/shots/roadmap-undo-failure.png' }).catch(() => {})
} finally {
  try {
    // Stop the tested client before cleanup restores preferences, so its
    // outstanding preference debounce cannot overwrite the restoration.
    await page.close()
    await cleanup()
    assert.deepEqual(await inspectBrowserDemo(demo), before, 'Northstar counts or anchor changed')
    log('Temporary tasks and milestones removed; Northstar counts and anchor preserved')
  } catch (error) {
    passed = false
    console.error('[roadmap-undo] cleanup failed:', error?.message || 'Unknown cleanup failure')
  }
  await browser.close()
}
if (passed) log('PASS')
process.exitCode = passed ? 0 : 1

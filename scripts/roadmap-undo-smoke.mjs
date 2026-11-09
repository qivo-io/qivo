/* Roadmap undo regression against the Northstar development demo.
 * Usage: node scripts/roadmap-undo-smoke.mjs [baseURL]
 * Requires the matching backend and a running dev server. Creates only
 * temporary tasks/milestones; finally removes them and reads the milestones
 * again to check none is left, never seeds or resets.
 * It looks its tasks up in the Roadmap's answer (P.viewTask, P.anyTask), so
 * it drives the Roadmap's writes of the answer's rows (src/store/planner.ts
 * updateViewTask), which the jsdom suites pin too
 * (src/store/roadmapWrites.test.ts, src/views/roadmapView.test.tsx), and
 * checks what the backend saved through the task window's read of each
 * task (taskWindow.task). The
 * workspace holds no milestone, so it picks its project, checks what the
 * backend saved and cleans up through the server's milestone reads
 * (milestones.between, and milestones.get by id for its first milestone
 * when the evaluation that created it never answered), and writes its
 * milestone through the Roadmap's range read, once that read shows its
 * flag. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { chromium } from 'playwright'
import {
  inspectBrowserDemo,
  loadBrowserDemo,
  navRows,
  purgeDeletedTasks,
  signInDemo,
} from './browser-demo.mjs'

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
/* The flag of milestone `id` in the shown Roadmap, which its range read
   (milestones.between) holds. */
const flag = (id) => page.locator(`[data-workspace-view] [data-msflag="${id}"]`)
/* A Roadmap of the scope the drive left stays in the page, hidden, until the
   next view has painted and the page is idle (KeptView), and holds the same
   task bars. Bars are looked up in the shown view, which alone has
   data-workspace-view. */
const bar = (id) => page.locator(`[data-workspace-view] [data-bar="${id}"]`)
let initialUI
/* The run's project, Northstar's top-level project it adds its milestones
   to, and the weeks they lie in, once the evaluation that chose them and
   created the run's first milestone answered. */
let fixture
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

/* Waits until the shown Undo button is enabled, or disabled, as `enabled`
   says, and fails with `message` if it never is. The button renders the
   store's history after the history changes, so a step waits for the button
   itself rather than reading it once after settled(). */
async function undoShows(enabled, message) {
  await page
    .locator(`[data-roadmap-undo]:${enabled ? 'enabled' : 'disabled'}`)
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(() => {
      throw new Error(message)
    })
}

/* A client of the backend signed in as the person page `on` is signed in
   as. */
async function clientOf(on) {
  const client = new ConvexHttpClient(demo.target.url, { logger: false })
  client.setAuth(
    await on.evaluate(async () => {
      const { authClient } = await import('/src/lib/auth.ts')
      const { data } = await authClient.convex.token()
      if (!data?.token) throw new Error('Could not authenticate roadmap persistence check')
      return data.token
    }),
  )
  return client
}

/* The milestones of this run (named with its prefix) that the backend holds
   on top-level project `project` on a day of `weeks` ([from, to)), read
   through `client` with milestones.between, following `next` until the
   range ends, as the Roadmap reads them. */
async function runMilestones(client, project, weeks) {
  const rows = []
  let after
  for (let round = 0; round < 20; round++) {
    const batch = await client.query(makeFunctionReference('milestones:between'), {
      projects: [project],
      from: weeks.from,
      to: weeks.to,
      ...(after ? { after } : {}),
    })
    rows.push(...batch.rows)
    if (!batch.next)
      return rows
        .filter((row) => row.name.startsWith(prefix))
        .map(({ id, name, week, project_id }) => ({ id, name, week, project_id }))
        .sort((a, b) => a.id.localeCompare(b.id))
    after = batch.next
  }
  throw new Error('The milestone range did not end within 20 batches')
}

/* The run's first milestone, read through `client` by the id the run gave
   it (milestones.get), as a list of none or one in runMilestones' shape. */
async function firstMilestone(client) {
  const found = await client.query(makeFunctionReference('milestones:get'), { id: milestone.id })
  if (found === null || !found.row.name.startsWith(prefix)) return []
  const { id, name, week, project_id } = found.row
  return [{ id, name, week, project_id }]
}

/* The run's tasks' stored dates, through the task window's read of each
   by its uuid (taskWindow.task), as the store holds no task, and the run's
   milestones, over a fresh HTTP client once no write is on its way. */
async function persisted() {
  await page.waitForFunction(() => window.__roadmapSmokeConnection().inflightMutations === 0)
  const client = await clientOf(page)
  const rows = await Promise.all(
    tasks.map(async ({ id }) => {
      const answer = await client.query(makeFunctionReference('taskWindow:task'), {
        org_id: fixture.org,
        ref: id,
      })
      assert.equal(answer?.state, 'ok', 'A temporary task disappeared')
      return answer.task
    }),
  )
  return {
    tasks: rows.map((row) => ({
      id: row.id,
      start: row.start_week ?? null,
      end: row.end_week ?? null,
    })),
    milestones: await runMilestones(client, fixture.project, fixture.weeks),
  }
}

/* The handles of the run's tasks, once the Roadmap's answer brings all
   three (P.viewTask on the Roadmap's slot), in the run's order. */
async function roadmapHandles() {
  const uuids = tasks.map(({ id }) => id)
  await page.waitForFunction(
    (uuids) => uuids.every((uuid) => window.PLANNER.viewTask('roadmap', uuid)),
    uuids,
    { timeout: 30000 },
  )
  return page.evaluate(
    (uuids) => uuids.map((uuid) => window.PLANNER.viewTask('roadmap', uuid).id),
    uuids,
  )
}

async function dragWeeks(id, weeks) {
  await bar(id).scrollIntoViewIfNeeded()
  // the bar's task as the Roadmap's answer brings it
  const span = await page.evaluate((id) => {
    const it = window.PLANNER.anyTask(id)
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

/* A group's dates are calculated from its scheduled subtasks, so the parent's
   span in the Roadmap's answer (its row's span) must match its only
   subtask, whatever the parent's stored row holds. Waits because the
   answer follows the server's write. */
async function spanFollows(group, child, message) {
  await page
    .waitForFunction(
      ([group, child]) => {
        const P = window.PLANNER
        const g = P.anyTask(group)
        const c = P.anyTask(child)
        return !!g && !!c && c.start != null && g.start === c.start && g.end === c.end
      },
      [group, child],
      { timeout: 10_000 },
    )
    .catch(() => {
      throw new Error(message)
    })
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
    // the run's milestones, which lie on its project in this week and the
    // next two. Without the fixture, the evaluation that creates the first
    // one did not answer, perhaps after the create, and the run made no
    // other, so its id finds it if it was made.
    const client = await clientOf(cleanupPage)
    const made = fixture
      ? await runMilestones(client, fixture.project, fixture.weeks)
      : await firstMilestone(client)
    await cleanupPage.evaluate(
      async ({ ids, milestones, orgSlug, initialUI }) => {
        const P = window.PLANNER
        const { convex } = await import('/src/lib/convex.ts')
        const org = P.orgs.find((row) => row.slug === orgSlug)
        if (!org) throw new Error('Cleanup organization is unavailable')
        for (const id of [...ids].reverse()) {
          // a task the run made answers the task window's read
          const read = await convex.query('taskWindow:task', { org_id: org.id, ref: id })
          if (read?.state === 'ok')
            await convex.mutation('issues:deleteDeep', { org_id: org.id, id })
        }
        // each milestone's project by id (projectNav.byIds), as the store
        // holds no project list
        const asked = [...new Set(milestones.map((row) => row.project_id))]
        const known = asked.length
          ? (await convex.query('projectNav:byIds', { ids: asked })).rows
          : []
        for (const row of milestones) {
          const project = known.find((project) => project.id === row.project_id)
          if (project?.org_id === org.id)
            await convex.mutation('projects:removeMilestone', { org_id: org.id, id: row.id })
        }
        if (initialUI) {
          P.saveUINow(initialUI)
          await convex.mutation('prefs:save', { profile_id: P.CURRENT_USER, prefs: P.loadUI() })
        }
      },
      { ids: tasks.map(({ id }) => id), milestones: made, orgSlug: demo.orgSlug, initialUI },
    )
    // deleting moved the tasks to Deleted items; delete them for good there
    await purgeDeletedTasks(
      demo,
      tasks.map(({ id }) => id),
    )
    // read the run's milestones again, in its weeks and by the first one's
    // id, so a milestone the cleanup missed fails the run instead of staying
    // in Northstar, whose counts hold no milestones. Each one left is named
    // once, however many of the two reads found it.
    const left = fixture ? await runMilestones(client, fixture.project, fixture.weeks) : []
    for (const row of await firstMilestone(client))
      if (!left.some(({ id }) => id === row.id)) left.push(row)
    await cleanupPage.evaluate(() => window.PLANNER?.signOut()).catch(() => {})
    assert.deepEqual(left, [], 'A temporary milestone was left in Northstar')
  } finally {
    await context.close()
  }
}

try {
  await signInDemo(page, demo)
  initialUI = await page.evaluate(() => window.PLANNER.loadUI())
  // the demo organization's live top-level projects from the navigation
  // reads, as the store holds no project list
  const listed = await navRows(page, 'projectNav:page', {
    org_id: await page.evaluate(() => window.PLANNER.org.id),
  })
  fixture = await page.evaluate(
    async ({ tasks, milestone, listed }) => {
      const P = window.PLANNER
      const { convex } = await import('/src/lib/convex.ts')
      const today = P.TODAY_WEEK
      const iso = (week) => P.isoFromDate(P.weekToDate(week))
      // A top-level project holds one milestone a week, so the run uses a
      // Northstar project, Luma Sensor when it can, whose milestones leave
      // this week and the next free for the milestones it adds and moves,
      // as the server's range read of those weeks answers them, among the
      // demo organization's live top-level projects.
      const candidates = [...listed]
        .sort((a, b) => Number(b.name === 'Luma Sensor') - Number(a.name === 'Luma Sensor'))
        .slice(0, 200)
      const taken = await convex.query('milestones:between', {
        projects: candidates.map((p) => p.id),
        from: iso(today),
        to: iso(today + 2),
      })
      const whole = taken.next === null && taken.stopped === null
      const project = whole
        ? candidates.find((p) => !taken.rows.some((m) => m.project_id === p.id))
        : undefined
      // its live sub-projects, every batch of projectNav.children
      const subs = []
      for (let after; project; ) {
        const batch = await convex.query('projectNav:children', {
          project_id: project.id,
          ...(after ? { after } : {}),
        })
        if (batch.state !== 'ok') break
        subs.push(...batch.rows)
        if (batch.next === null || batch.stopped) break
        after = batch.next
      }
      const sub = subs.find((p) => p.name === 'Electronics') ?? subs[0]
      if (!project || !sub)
        throw new Error('No Northstar project has this week and the next free for milestones')
      P.saveUINow({ roadmapWin: P.DEFAULT_WIN })
      window.__roadmapSmokeConnection = () => convex.connectionState()
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
        })
      }
      await convex.mutation('issues:addLink', {
        org_id: P.org.id,
        id: crypto.randomUUID(),
        source_id: tasks[2].id,
        target_id: tasks[0].id,
        type: 'blocks',
      })
      // the run's last write here, so the fixture answers as soon as it
      // does; cleanup finds the milestone by its id if it never answers
      await convex.mutation('projects:addMilestone', {
        org_id: P.org.id,
        id: milestone.id,
        project_id: project.id,
        name: milestone.name,
        week: iso(today),
      })
      // every milestone the run makes lies in this week or the next two
      return {
        org: P.org.id,
        project: project.id,
        name: project.name,
        today,
        weeks: { from: iso(today), to: iso(today + 3) },
      }
    },
    { tasks, milestone, listed },
  )
  await page.locator('aside').getByText(fixture.name, { exact: true }).click()
  await selectView('Roadmap')
  await page.locator('[data-roadmap-toolbar]').waitFor()
  await page.getByPlaceholder('Filter tasks…').fill(prefix)
  // the run's tasks by their handles, from the Roadmap's answer
  const [parent, child, leaf] = await roadmapHandles()
  await settled(0)
  await undoShows(false, 'Undo is available before any change')
  assert.equal(await page.locator('[data-roadmap-revert-all]').count(), 0)
  const baseline = await persisted()

  await spanFollows(parent, child, 'Parent span does not match its subtask before planning')

  // The leaf blocks the parent, so Auto-move must move the parent's subtask.
  await page.locator('[data-auto-correct]').click()
  await settled(1)
  const corrected = await persisted()
  assert.deepEqual(corrected.tasks[0], baseline.tasks[0], "Auto-move wrote the parent's own dates")
  assert.notEqual(corrected.tasks[1].start, baseline.tasks[1].start, 'Auto-move left the subtask')
  assert.deepEqual(corrected.tasks[2], baseline.tasks[2], 'Auto-move moved its blocker')
  await spanFollows(parent, child, 'Parent span did not follow the subtask Auto-move moved')
  await undo().click()
  await settled(0)
  assert.deepEqual(await persisted(), baseline, 'Auto-move undo did not restore the subtask')
  await spanFollows(parent, child, 'Parent span did not follow the subtask after Auto-move undo')
  log('One Auto-move action is one undo step; it writes only the subtask, and the parent follows')

  await dragWeeks(child, 2)
  await settled(1)
  const first = await persisted()
  assert.notEqual(first.tasks[1].start, baseline.tasks[1].start, 'Child drag was not saved')
  assert.deepEqual(first.tasks[0], baseline.tasks[0], "Child drag wrote the parent's own dates")
  await spanFollows(parent, child, 'Parent span did not follow the dragged subtask')
  await dragWeeks(leaf, 1)
  await settled(2)
  await undo().click()
  await settled(1)
  assert.deepEqual(await persisted(), first, 'Undo did not restore only the latest action')
  log("Task drags save only the dragged task; the parent's span follows; Undo restores one step")

  // the store writes a milestone from a read that shows it, here the
  // Roadmap's range read, once its flag shows
  await flag(milestone.id).waitFor()
  assert.equal(
    await page.evaluate(({ id, week }) => window.PLANNER.updateMilestone(id, { week }), {
      id: milestone.id,
      week: fixture.today + 1,
    }),
    true,
    'The milestone move was not saved',
  )
  await settled(2)
  await flag(milestone.id).waitFor()
  assert.equal(
    await page.evaluate((id) => window.PLANNER.removeMilestone(id), milestone.id),
    true,
    'The milestone delete was not saved',
  )
  await settled(3)
  await undo().click()
  await settled(2)
  assert.equal((await persisted()).milestones.length, 1, 'Undo did not restore deleted milestone')
  await page.locator('[data-new-milestone]').click()
  const modal = page.locator('[data-modal-shell]')
  const newName = modal.getByRole('textbox', { name: 'New milestone', exact: true })
  await newName.fill(`${prefix} added`)
  await modal.getByRole('button', { name: 'Add', exact: true }).click()
  await modal.getByRole('button', { name: `Edit ${prefix} added`, exact: true }).waitFor()
  // The row shows before the server answers, and the window keeps the typed
  // name until the milestone is created; Done before then asks whether to
  // discard that name.
  await page.waitForFunction((input) => input.value === '', await newName.elementHandle())
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
  await spanFollows(parent, child, 'Parent span did not follow the subtask after repeated Undo')
  log('Repeated Undo restores task dates and reverses milestone creation, edits and deletion')

  await dragWeeks(child, 1)
  await settled(1)
  // another project and back keep the Roadmap's history; All projects
  // opens the project directory, a page of its own, which ends the visit
  const other = fixture.name === 'Luma Cloud' ? 'Pilot & Launch' : 'Luma Cloud'
  await page.locator('aside').getByText(other, { exact: true }).click()
  await settled(1)
  await page.locator('aside').getByText(fixture.name, { exact: true }).click()
  await settled(1)
  await readTask(child)
  await closeTask()
  await settled(1)
  await undoShows(true, 'Reading a task cleared undo history')
  await readTask(child)
  await page.locator('h1[data-task-title]').click()
  const title = page.getByRole('textbox', { name: 'Task title', exact: true })
  await title.fill(`${prefix} child edited`)
  await title.press('Enter')
  await page.waitForFunction(() => window.PLANNER.roadmapUndo.disabled)
  await closeTask()
  await settled(0)
  await undoShows(false, 'Task editing left undo available')
  await dragWeeks(leaf, 1)
  await settled(0)
  await undoShows(false, 'History restarted before leaving Roadmap')
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
  // the agenda's row of the leaf, a write of the Roadmap's answer's row
  await page.evaluate((id) => {
    const P = window.PLANNER
    const it = P.anyTask(id)
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

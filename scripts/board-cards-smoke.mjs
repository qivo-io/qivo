/* Grouped-card regression against the Northstar development demo.
 * Usage: node scripts/board-cards-smoke.mjs [baseURL]
 * Requires a running dev server. Creates one temporary parent and three
 * children; finally removes only those tasks, never seeds or resets. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { chromium } from 'playwright'
import { inspectBrowserDemo, loadBrowserDemo, signInDemo } from './browser-demo.mjs'

const demo = loadBrowserDemo(process.argv[2] ?? 'http://localhost:5199')
const before = await inspectBrowserDemo(demo)
const prefix = `Board cards ${randomUUID().slice(0, 8)}`
const fixtures = [
  { id: randomUUID(), title: `${prefix} parent` },
  { id: randomUUID(), title: `${prefix} owned child` },
  { id: randomUUID(), title: `${prefix} unassigned child` },
  { id: randomUUID(), title: `${prefix} other lane child` },
]
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))
const log = (message) => console.log(`[board-cards] ${message}`)
const card = (id) => page.locator(`[data-card="${id}"]`)
const family = (parentId) => page.locator(`[data-parent-card="${parentId}"]`)
const lane = (id) =>
  page.locator('[data-swimlane-panel]').filter({ has: page.locator(`[data-lane="${id}"]`) })
const cell = (laneId, status) => lane(laneId).locator(`[data-board-cell][data-status="${status}"]`)
let initialLayout
let initialFocus
let passed = false

async function assertActualCards(ids) {
  await page.waitForFunction((ids) => {
    const actual = [...document.querySelectorAll('[data-card]')].map((el) => el.dataset.card)
    return actual.length === ids.length && ids.every((id) => actual.includes(id))
  }, ids)
  const actual = await page
    .locator('[data-card]')
    .evaluateAll((els) => els.map((el) => el.dataset.card))
  assert.equal(new Set(actual).size, actual.length, 'An actual task appears more than once')
  assert.deepEqual(actual.sort(), [...ids].sort(), 'A filtered-out task entered the board')
}

async function assertGroup(parentId, laneId, status, children) {
  const wrapper = cell(laneId, status).locator(`[data-parent-card="${parentId}"]`)
  await wrapper.waitFor({ state: 'visible' })
  assert.equal(await wrapper.count(), 1, 'A parent has multiple cards in one column and swimlane')
  const actual = await wrapper
    .locator('[data-card]')
    .evaluateAll((els) => els.map((el) => el.dataset.card))
  assert.deepEqual(
    actual.sort(),
    [...children].sort(),
    'The family card has the wrong actual tasks',
  )
  assert.equal(
    await wrapper.locator('button[aria-expanded]:not([data-assignee-edit])').count(),
    0,
    'Family rows must not require expanding an overview',
  )
  assert.doesNotMatch(await wrapper.innerText(), /whole family/i)
  const heading = wrapper.locator(`[data-parent-heading="${parentId}"]`)
  assert.equal(
    await heading.getAttribute('draggable'),
    'false',
    'A parent heading can change status by drag',
  )
  assert.doesNotMatch(await heading.innerText(), /\b(Backlog|Todo|In progress|In review|Done)\b/)
  return wrapper
}

async function assertOpacities(ids) {
  const opacity = await page.evaluate((ids) => {
    return ids.map((id) => {
      let el = document.querySelector(`[data-card="${id}"]`)
      if (!el) throw new Error(`Missing actual task ${id}`)
      let product = 1
      while (el && el !== document.body) {
        product *= Number(getComputedStyle(el).opacity)
        el = el.parentElement
      }
      return product
    })
  }, ids)
  assert.ok(
    opacity.every((value) => value >= 0.99),
    'Hover dimmed another task or its family',
  )
}

async function openAndClose(id, target = card(id), hasStatus = true) {
  await target.click()
  await page.locator('[data-issue-key]').first().waitFor({ state: 'visible' })
  assert.equal((await page.locator('[data-issue-key]').first().textContent()).trim(), id)
  assert.match(page.url(), new RegExp(`/tasks/${id.toLowerCase()}$`))
  assert.equal(await page.locator('[aria-label="Status"]').count(), hasStatus ? 1 : 0)
  await page.keyboard.press('Escape')
  await page.locator('[data-issue-key]').waitFor({ state: 'detached' })
}

async function dragChild(id, laneId, status) {
  const target = cell(laneId, status)
  await target.scrollIntoViewIfNeeded()
  await card(id).dragTo(target, { targetPosition: { x: 12, y: 12 } })
  await page.waitForFunction(({ id, status }) => window.PLANNER.issueById[id]?.status === status, {
    id,
    status,
  })
}

async function waitForMutations() {
  await page.evaluate(async () => {
    const { convex } = await import('/src/lib/convex.ts')
    window.__boardSmokeConnectionState = () => convex.connectionState()
  })
  // Playwright polls only synchronous predicates; a Promise is immediately
  // truthy and would let this barrier finish while a write is still pending.
  await page.waitForFunction(() => window.__boardSmokeConnectionState().inflightMutations === 0)
  await page.evaluate(() => delete window.__boardSmokeConnectionState)
}

async function assertDragBoundary(id, sourceProject, otherProject) {
  const selector = (project, status) => `[data-board-cell="${project}"][data-status="${status}"]`
  const source = selector(sourceProject, 'todo')
  const empty = selector(sourceProject, 'progress')
  const invalid = selector(otherProject, 'done')
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  const hover = (target) =>
    page.locator(target).evaluate((el, dataTransfer) => {
      const event = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer })
      el.dispatchEvent(event)
      // Chromium can keep dropEffect read-only on a constructed DataTransfer.
      // Check acceptance and the rendered highlight instead of that synthetic value.
      return event.defaultPrevented
    }, transfer)
  const highlighted = (target, expected) =>
    page.waitForFunction(
      ({ target, expected }) =>
        document.querySelector(target)?.style.outline.includes('dashed') === expected,
      { target, expected },
    )
  try {
    await card(id).dispatchEvent('dragstart', { dataTransfer: transfer })
    await page.waitForFunction(
      (id) => document.querySelector(`[data-card="${id}"]`)?.classList.contains('opacity-40'),
      id,
    )
    assert.equal(await hover(source), true)
    await highlighted(source, false)
    assert.equal(await page.locator(empty).locator('[data-card]').count(), 0)
    assert.equal(await hover(empty), true)
    await highlighted(empty, true)
    await highlighted(source, false)

    // Returning to the source must clear the destination without advertising
    // a status change in the task's current column.
    assert.equal(await hover(source), true)
    await highlighted(source, false)
    await highlighted(empty, false)
    assert.equal(await hover(empty), true)
    await highlighted(empty, true)

    await page.locator(empty).dispatchEvent('dragleave', { dataTransfer: transfer })
    await highlighted(empty, false)
    assert.equal(await hover(empty), true)
    await highlighted(empty, true)
    assert.equal(await hover(invalid), false)
    await highlighted(invalid, false)
    await highlighted(empty, false)

    // Native dragging skips a rejected target's drop. Force the event too so
    // the status/assignment write must independently reject another project.
    await page.locator(invalid).dispatchEvent('drop', { dataTransfer: transfer })
  } finally {
    await card(id).dispatchEvent('dragend', { dataTransfer: transfer })
    await transfer.dispose()
  }
}

async function cleanupFixture() {
  const context = await browser.newContext()
  const cleanupPage = await context.newPage()
  try {
    await signInDemo(cleanupPage, demo)
    await cleanupPage.evaluate(
      async ({ tasks, orgSlug }) => {
        const { convex } = await import('/src/lib/convex.ts')
        const snapshot = await convex.query('snapshot:forMe', {})
        const org = snapshot.orgs.find((candidate) => candidate.slug === orgSlug)
        if (!org) throw new Error('Cleanup organization is unavailable')
        const errors = []
        for (const task of [...tasks].reverse()) {
          const issue = snapshot.issues.find(
            (item) => item.id === task.id && item.org_id === org.id,
          )
          if (!issue) continue
          try {
            await convex.mutation('issues:deleteDeep', { org_id: org.id, id: issue.id })
          } catch {
            errors.push(task.id)
          }
        }
        if (errors.length) throw new Error(`Could not remove ${errors.length} temporary tasks`)
      },
      { tasks: fixtures, orgSlug: demo.orgSlug },
    )
  } finally {
    // Successful sign-out can destroy its own JavaScript context during the
    // auth navigation. Task deletion above has already awaited the backend.
    await cleanupPage.evaluate(() => window.PLANNER?.signOut()).catch(() => {})
    await context.close()
  }
}

try {
  await signInDemo(page, demo)
  initialLayout = await page.evaluate(() => window.PLANNER.loadUI().metaViz || 'swimlanes')
  initialFocus = await page.evaluate(() => !!window.PLANNER.loadUI().focus)
  await page.locator('aside').getByText('Luma Sensor', { exact: true }).click()
  await page.getByRole('heading', { name: 'Luma Sensor', exact: true }).waitFor()
  if (initialFocus) await page.locator('[data-filter-focus]').click()
  // the closed switcher names the layout in a word
  if (!(await page.locator('[data-group-menu]').innerText()).includes('Project')) {
    await page.locator('[data-group-menu]').click()
    await page.getByRole('button', { name: 'Swimlanes by project', exact: true }).click()
  }

  const fixture = await page.evaluate(async (tasks) => {
    const P = window.PLANNER
    const meta = P.projects.find(
      (project) => project.name === 'Luma Sensor' && project.type === 'meta',
    )
    const electronics = P.projects.find(
      (project) => project.parent === meta?.id && project.name === 'Electronics',
    )
    const firmware = P.projects.find(
      (project) => project.parent === meta?.id && project.name === 'Firmware',
    )
    const nora = P.users.find((user) => user.id === P.CURRENT_USER)
    const leo = P.users.find((user) => user.name === 'Leo Martins' && user.org === P.org.id)
    if (!meta || !electronics || !firmware || !nora || !leo)
      throw new Error('Northstar fixture projects or assignees are unavailable')
    const { convex } = await import('/src/lib/convex.ts')
    const create = (task, extra) =>
      convex.mutation('issues:create', {
        org_id: P.org.id,
        id: task.id,
        title: task.title,
        project_id: electronics.id,
        status: 'todo',
        priority: 'high',
        ...extra,
      })
    await create(tasks[0], { status: 'done', assignee_id: nora.id })
    await create(tasks[1], {
      parent_id: tasks[0].id,
      assignee_id: nora.id,
      paused: true,
    })
    await create(tasks[2], { parent_id: tasks[0].id })
    await create(tasks[3], {
      project_id: firmware.id,
      parent_id: tasks[0].id,
      assignee_id: leo.id,
    })
    return { electronics: electronics.id, firmware: firmware.id, nora: nora.id, leo: leo.id }
  }, fixtures)
  await page.waitForFunction(
    (uuids) => uuids.every((uuid) => window.PLANNER.issues.some((issue) => issue.uuid === uuid)),
    fixtures.map((task) => task.id),
  )
  const ids = await page.evaluate(
    (uuids) => uuids.map((uuid) => window.PLANNER.issues.find((issue) => issue.uuid === uuid).id),
    fixtures.map((task) => task.id),
  )
  const [parent, assigned, unassigned, otherLane] = ids
  const childIds = ids.slice(1)
  const search = page.getByPlaceholder('Filter tasks…')
  await search.fill(prefix)
  await assertActualCards(childIds)
  await assertGroup(parent, fixture.electronics, 'todo', [assigned, unassigned])
  await assertGroup(parent, fixture.firmware, 'todo', [otherLane])
  assert.equal(
    await family(parent).count(),
    2,
    'Only columns with visible children need a family card',
  )
  assert.equal((await page.locator('[data-status-count="todo"]').innerText()).trim(), '3')
  assert.equal((await page.locator('[data-status-count="done"]').innerText()).trim(), '0')
  log('Siblings share one card per column and swimlane; parent status contributes no card or count')

  await card(assigned).locator(`[data-avatar="${fixture.nora}"]`).waitFor({ state: 'visible' })
  await card(otherLane).locator(`[data-avatar="${fixture.leo}"]`).waitFor({ state: 'visible' })
  await card(unassigned).getByRole('img', { name: 'Unassigned', exact: true }).waitFor()
  await page.mouse.move(0, 0)
  await card(assigned).locator('[data-paused]').waitFor({ state: 'visible' })
  await assertOpacities(childIds)
  await card(assigned).hover()
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    )
  })
  await assertOpacities(childIds)
  await card(assigned).locator('[data-paused]').waitFor({ state: 'visible' })
  log('Each child shows its own assignee; paused glyph stays visible and hover dims no task')

  await openAndClose(assigned)
  // A repeated parent header is context, yet still opens the ordinary task.
  const repeatedHeader = cell(fixture.firmware, 'todo').locator(`[data-parent-heading="${parent}"]`)
  await openAndClose(parent, repeatedHeader, false)
  log('Child rows retain editable status; parent context opens details with no status control')

  await search.fill(fixtures[1].title)
  await assertActualCards([assigned])
  await assertGroup(parent, fixture.electronics, 'todo', [assigned])
  assert.equal(await family(parent).count(), 1)
  await search.fill(prefix)
  await assertActualCards(childIds)
  log(
    'Search retains parent context while excluding unmatched parents and siblings as actual tasks',
  )

  const persistedClient = new ConvexHttpClient(demo.target.url, { logger: false })
  persistedClient.setAuth(
    await page.evaluate(async () => {
      const { authClient } = await import('/src/lib/auth.ts')
      const { data } = await authClient.convex.token()
      if (!data?.token) throw new Error('Could not authenticate the persistence check')
      return data.token
    }),
  )
  for (const layout of ['Swimlanes by project', 'Side-by-side boards']) {
    await page.locator('[data-group-menu]').click()
    await page.getByRole('dialog').getByRole('button', { name: layout, exact: true }).click()
    await assertDragBoundary(assigned, fixture.electronics, fixture.firmware)
    await waitForMutations()
    const stored = await persistedClient.query(makeFunctionReference('snapshot:forMe'), {})
    assert.deepEqual(
      fixtures.map(({ id }) => {
        const task = stored.issues.find((issue) => issue.id === id)
        return {
          status: task?.status,
          assignee: task?.assignee_id ?? null,
          project: task?.project_id,
        }
      }),
      [
        { status: 'done', assignee: fixture.nora, project: fixture.electronics },
        { status: 'todo', assignee: fixture.nora, project: fixture.electronics },
        { status: 'todo', assignee: null, project: fixture.electronics },
        { status: 'todo', assignee: fixture.leo, project: fixture.firmware },
      ],
      `${layout} changed a task after a drop in another sub-project`,
    )
  }
  await page.locator('[data-group-menu]').click()
  await page.getByRole('button', { name: 'Swimlanes by project', exact: true }).click()
  log(
    'Swimlanes and Boards highlight only the current sub-project, clear exited targets and reject cross-project drops',
  )

  await dragChild(assigned, fixture.electronics, 'progress')
  await assertGroup(parent, fixture.electronics, 'progress', [assigned])
  await assertGroup(parent, fixture.electronics, 'todo', [unassigned])
  await assertGroup(parent, fixture.firmware, 'todo', [otherLane])
  await dragChild(unassigned, fixture.electronics, 'review')
  await assertGroup(parent, fixture.electronics, 'review', [unassigned])
  assert.equal(
    await cell(fixture.electronics, 'todo').locator(`[data-parent-card="${parent}"]`).count(),
    0,
    'An empty context-only family card survived moving its final child',
  )
  await assertActualCards(childIds)

  // The subscribed query can return the optimistic local cache. Wait for the
  // mutation acknowledgement, then verify through an independent HTTP client
  // before reloading. Neither proof can be satisfied by optimistic paint.
  await waitForMutations()
  const stored = await persistedClient.query(makeFunctionReference('snapshot:forMe'), {})
  assert.deepEqual(
    fixtures.map((task) => stored.issues.find((issue) => issue.id === task.id)?.status),
    ['done', 'progress', 'review', 'todo'],
    'Dragged statuses did not persist on the server',
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-group-menu]').waitFor({ state: 'visible' })
  await page.getByPlaceholder('Filter tasks…').fill(prefix)
  await assertActualCards(childIds)
  const persisted = await page.evaluate(
    (ids) =>
      ids.map((id) => {
        const issue = window.PLANNER.issueById[id]
        return { status: issue.status, parent: issue.parent, project: issue.project }
      }),
    ids,
  )
  assert.deepEqual(persisted, [
    { status: 'done', parent: null, project: fixture.electronics },
    { status: 'progress', parent, project: fixture.electronics },
    { status: 'review', parent, project: fixture.electronics },
    { status: 'todo', parent, project: fixture.firmware },
  ])
  await assertGroup(parent, fixture.electronics, 'progress', [assigned])
  await assertGroup(parent, fixture.electronics, 'review', [unassigned])
  await assertGroup(parent, fixture.firmware, 'todo', [otherLane])
  assert.deepEqual(pageErrors, [], 'Browser reported uncaught errors')
  log(
    'Child drag merges and creates family cards; parent, siblings and projects remain unchanged after reload',
  )

  // Removing children one at a time must restore the preserved status only
  // when the final child is detached. Keep every temporary issue for cleanup.
  for (const task of fixtures.slice(1)) {
    await page.evaluate(async (id) => {
      const { convex } = await import('/src/lib/convex.ts')
      await convex.mutation('issues:update', {
        org_id: window.PLANNER.org.id,
        id,
        patch: { parent_id: null },
      })
    }, task.id)
    await page.waitForFunction(
      (uuid) => !window.PLANNER.issues.find((it) => it.uuid === uuid)?.parent,
      task.id,
    )
    if (task.id !== fixtures.at(-1).id) {
      assert.equal(
        await card(parent).count(),
        0,
        'A parent appeared before its final child was removed',
      )
    }
  }
  await assertActualCards(ids)
  assert.equal(await family(parent).count(), 0)
  assert.equal(
    await cell(fixture.electronics, 'done').locator(`[data-card="${parent}"]`).count(),
    1,
  )
  assert.equal((await page.locator('[data-status-count="done"]').innerText()).trim(), '1')
  await card(parent).click()
  const status = page.locator('[aria-label="Status"]')
  await status.waitFor({ state: 'visible' })
  assert.equal(await status.isEnabled(), true)
  assert.match(await status.innerText(), /Done/)
  await page.keyboard.press('Escape')
  await page.locator('[data-issue-key]').waitFor({ state: 'detached' })
  assert.deepEqual(pageErrors, [], 'Browser reported uncaught errors during parent restoration')
  log(
    'Removing the last subtask restores the saved Done status, ordinary card, count and editable status',
  )
  passed = true
} catch (error) {
  console.error('[board-cards] FAIL:', error?.message || 'Browser drive failed')
  mkdirSync('scripts/shots', { recursive: true })
  await page.screenshot({ path: 'scripts/shots/board-cards-failure.png' }).catch(() => {})
} finally {
  try {
    if (initialLayout) {
      await page.evaluate(
        async ({ metaViz, focus }) => {
          const P = window.PLANNER
          P.saveUINow({ metaViz, focus })
          const { convex } = await import('/src/lib/convex.ts')
          await convex.mutation('prefs:save', { profile_id: P.CURRENT_USER, prefs: P.loadUI() })
        },
        { metaViz: initialLayout, focus: initialFocus },
      )
    }
  } catch (error) {
    passed = false
    console.error('[board-cards] layout restore failed:', error?.message || 'Unknown failure')
  }
  // deleteDeep detaches children; remove all temporary children explicitly
  // before deleting the parent, including when setup failed halfway through.
  try {
    await cleanupFixture()
  } catch (error) {
    passed = false
    console.error('[board-cards] task cleanup failed:', error?.message || 'Unknown failure')
  }
  try {
    assert.deepEqual(await inspectBrowserDemo(demo), before, 'Northstar counts or anchor changed')
    log('Temporary family removed; Northstar counts and anchor preserved')
  } catch (error) {
    passed = false
    console.error('[board-cards] cleanup failed:', error?.message || 'Unknown cleanup failure')
  }
  await page.evaluate(() => window.PLANNER?.signOut()).catch(() => {})
  await browser.close()
}
if (passed) log('PASS')
process.exitCode = passed ? 0 : 1

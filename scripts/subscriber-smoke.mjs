/* Subscriber-popover regression against the Northstar development demo.
 * Usage: node scripts/subscriber-smoke.mjs [baseURL]
 * Creates and removes one temporary task. Never seeds, resets, changes access,
 * or changes subscriptions on an existing task. Run browser drives sequentially. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { chromium } from 'playwright'
import {
  cleanupDemoArtifacts,
  inspectBrowserDemo,
  loadBrowserDemo,
  navProject,
  signInDemo,
} from './browser-demo.mjs'

const demo = loadBrowserDemo(process.argv[2] ?? 'http://localhost:5199')
const before = await inspectBrowserDemo(demo)
const fixture = { id: randomUUID(), title: `Subscribers ${randomUUID().slice(0, 8)}` }
const browser = await chromium.launch({ headless: true })
const manager = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const participants = []
const pageErrors = []
manager.on('pageerror', (error) => pageErrors.push(error.message))
const log = (message) => console.log(`[subscribers] ${message}`)
const eye = (page) => page.locator('[data-task-subscribe]')
const popup = (page) => page.locator('[data-task-subscribers]')
const me = (page) => page.locator('[data-task-subscribe-me]')
const add = (page) => page.locator('[data-task-subscriber-add-open]')
const row = (page, id) => page.locator(`[data-task-subscriber="${id}"]`)
const remove = (page, id) => page.locator(`[data-task-subscriber-remove="${id}"]`)
let passed = false
let taskURL
let orgId

async function persistedRoster(page) {
  // Wait for acknowledgement, then query over a fresh HTTP connection. A
  // subscribed query's optimistic cache alone cannot establish persistence.
  await page.evaluate(async () => {
    const { convex } = await import('/src/lib/convex.ts')
    window.__subscriberSmokeConnection = () => convex.connectionState()
  })
  await page.waitForFunction(() => window.__subscriberSmokeConnection().inflightMutations === 0)
  await page.evaluate(() => delete window.__subscriberSmokeConnection)
  const client = new ConvexHttpClient(demo.target.url, { logger: false })
  client.setAuth(
    await page.evaluate(async () => {
      const { authClient } = await import('/src/lib/auth.ts')
      const { data } = await authClient.convex.token()
      if (!data?.token) throw new Error('Could not authenticate subscriber persistence check')
      return data.token
    }),
  )
  return client.query(makeFunctionReference('issues:subscribers'), {
    org_id: orgId,
    issue_id: fixture.id,
  })
}

/* The ids of the followers a roster answer lists (issues.subscribers
   answers them as rows), sorted. */
const followerIds = (roster) => roster.subscribers.map((row) => row.id).sort()

async function openRoster(page) {
  const subscribed = await eye(page).getAttribute('data-task-subscribe')
  const before = await persistedRoster(page)
  await eye(page).click()
  await popup(page).waitFor()
  await popup(page)
    .getByText('Loading subscribers…', { exact: true })
    .waitFor({ state: 'detached' })
  assert.equal(await popup(page).getByRole('alert').count(), 0, 'Subscriber query failed')
  assert.equal(await eye(page).getAttribute('data-task-subscribe'), subscribed)
  assert.deepEqual(
    followerIds(await persistedRoster(page)),
    followerIds(before),
    'Opening the eye changed a subscription',
  )
  await me(page).getByText('Me', { exact: true }).waitFor()
  assert.equal(await me(page).getAttribute('data-task-subscribe-me'), subscribed)
  assert.equal(await me(page).getAttribute('aria-pressed'), String(subscribed === 'on'))
  return before
}

async function setMe(page, subscribed) {
  const state = subscribed ? 'on' : 'off'
  assert.notEqual(await me(page).getAttribute('data-task-subscribe-me'), state)
  await me(page).click()
  await page.locator(`[data-task-subscribe-me="${state}"]`).waitFor()
  await page.locator(`[data-task-subscribe="${state}"]`).waitFor({ state: 'attached' })
  assert.equal(
    await eye(page).getAttribute('aria-label'),
    `Task subscribers: ${subscribed ? 'subscribed' : 'not subscribed'}`,
  )
  assert.equal(await popup(page).isVisible(), true, 'Me toggle closed the subscriber list')
  const current = await page.evaluate(() => window.PLANNER.CURRENT_USER)
  assert.equal(followerIds(await persistedRoster(page)).includes(current), subscribed)
}

async function escapeRoster(page) {
  await page.keyboard.press('Escape')
  await popup(page).waitFor({ state: 'detached' })
  assert.equal(page.url(), taskURL, 'Nested Escape changed the task URL')
  assert.equal(await page.locator('[data-issue-key]').isVisible(), true)
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-task-subscribe'))
}

async function assertWithinViewport(page) {
  const bounds = await popup(page).boundingBox()
  const viewport = page.viewportSize()
  assert.ok(bounds && viewport)
  assert.ok(
    bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.x + bounds.width <= viewport.width + 1 &&
      bounds.y + bounds.height <= viewport.height + 1,
    'Subscriber popup extends outside the viewport',
  )
}

try {
  await signInDemo(manager, demo)
  // Luma Sensor and its Electronics from the navigation reads, as the store
  // holds no project list
  const luma = await navProject(manager, 'Luma Sensor')
  const setup = await manager.evaluate(
    async ({ task, accounts, project, subproject }) => {
      const P = window.PLANNER
      // the project cache reads Luma Sensor for the manager's level and lead
      P.nameProjects('subscriber-smoke', [project.id])
      const deadline = Date.now() + 15000
      while (P.projectState(project.id) === 'loading' && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100))
      if (!subproject || !P.canManageOwnProjectAccess(project.id))
        throw new Error('Northstar manager or Luma Sensor project is unavailable')
      const { convex } = await import('/src/lib/convex.ts')
      await convex.mutation('issues:create', {
        org_id: P.org.id,
        id: task.id,
        title: task.title,
        project_id: subproject.id,
        status: 'todo',
        priority: 'low',
      })
      // the store holds nobody but the signed-in person, so each account is
      // found on the server: among the people who may follow the new task
      // (pickers.taskFollowers) by address, with its role from its face
      // (people.byIds); one who leads the project manages its followers
      const lead = P.project(project.id)?.lead
      const found = []
      for (const account of accounts) {
        const batch = await P.followerChoices({
          task: { uuid: task.id, org: P.org.id },
          search: account.email,
          cursor: null,
        })
        const row = batch?.state === 'ready' && batch.rows.length === 1 ? batch.rows[0] : null
        if (row?.active && row.id !== lead) found.push({ key: account.key, row })
      }
      const faces = found.length
        ? await convex.query('people:byIds', { org_id: P.org.id, ids: found.map((f) => f.row.id) })
        : { rows: [] }
      const available = found.flatMap(({ key, row }) => {
        const face = faces.rows.find((f) => f.id === row.id)
        return face ? [{ key, id: row.id, name: row.name, role: face.org_role }] : []
      })
      const ordinary = available.find((user) => user.role === 'user')
      if (!ordinary) throw new Error('Northstar has no ordinary account with task access')
      const viewer = available.find((user) => user.role === 'viewer')
      return {
        orgId: P.org.id,
        managerId: P.CURRENT_USER,
        users: [ordinary, ...[viewer].filter(Boolean)],
      }
    },
    {
      task: fixture,
      accounts: demo.credentials.value.accounts.map(({ key, email }) => ({ key, email })),
      project: { id: luma.id },
      subproject: luma.children.find((item) => item.name === 'Electronics'),
    },
  )
  orgId = setup.orgId
  // the new task's number, from the task window's read of it by its uuid
  // (taskWindow.task), as the store holds no task
  const taskNum = await manager.evaluate(
    async ({ id, org }) => {
      const { convex } = await import('/src/lib/convex.ts')
      const deadline = Date.now() + 15000
      for (;;) {
        const read = await convex.query('taskWindow:task', { org_id: org, ref: id })
        if (read?.state === 'ok') return read.task.num
        if (Date.now() > deadline) return null
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    },
    { id: fixture.id, org: orgId },
  )
  assert.ok(taskNum, "The task window's read never answered the temporary task")
  taskURL = `${demo.base}/app/${demo.orgSlug}/board/tasks/qn-${taskNum}`
  await manager.goto(taskURL, { waitUntil: 'domcontentloaded' })
  await eye(manager).waitFor({ timeout: 30000 })
  taskURL = manager.url()
  const initial = await openRoster(manager)
  assert.equal(initial.canManage, true)
  assert.deepEqual(followerIds(initial), [], 'Unassigned temporary task has unexpected subscribers')
  await popup(manager).getByText('No other subscribers.', { exact: true }).waitFor()
  await setMe(manager, true)
  await setMe(manager, false)
  assert.deepEqual(followerIds(await persistedRoster(manager)), [])
  await escapeRoster(manager)
  await openRoster(manager)
  await setMe(manager, true)
  log('Opening the eye preserves state; Me toggles the header and persists after reopening')

  for (const account of setup.users) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', (error) => pageErrors.push(error.message))
    participants.push(page)
    await signInDemo(page, demo, account.key)
    await page.goto(taskURL, { waitUntil: 'domcontentloaded' })
    await eye(page).waitFor({ timeout: 30000 })
    const ordinaryRoster = await openRoster(page)
    assert.equal(ordinaryRoster.canManage, false)
    await row(page, setup.managerId).waitFor()
    assert.equal(await add(page).count(), 0, 'Ordinary user can add other subscribers')
    assert.equal(await page.locator('[data-task-subscriber-remove]').count(), 0)
    await setMe(page, true)
    await row(manager, account.id).waitFor()
    await setMe(page, false)
    await row(manager, account.id).waitFor({ state: 'detached' })
    log(`${account.role}: sees the roster, manages only Me, and changes arrive in the manager list`)

    await add(manager).click()
    const search = manager.locator('[data-task-subscriber-search]')
    await search.waitFor()
    await manager.waitForFunction(() =>
      document.activeElement?.hasAttribute('data-task-subscriber-search'),
    )
    await search.fill(`no-subscriber-${randomUUID()}`)
    await popup(manager).getByText('No users found.', { exact: true }).waitFor()
    assert.equal(await manager.locator('[data-task-subscriber-add]').count(), 0)
    await search.fill(account.name)
    const candidate = manager.locator(`[data-task-subscriber-add="${account.id}"]`)
    await candidate.waitFor()
    assert.equal(await manager.locator('[data-task-subscriber-add]').count(), 1)
    await candidate.click()
    await row(manager, account.id).waitFor()
    await search.waitFor({ state: 'detached' })
    await manager.waitForFunction(() =>
      document.activeElement?.hasAttribute('data-task-subscriber-add-open'),
    )
    assert.equal(
      await remove(manager, account.id).getAttribute('aria-label'),
      `Remove ${account.name} from subscribers`,
    )
    await manager.waitForFunction(
      (id) => !document.querySelector(`[data-task-subscriber-remove="${id}"]`)?.disabled,
      account.id,
    )
    await remove(manager, account.id).focus()
    assert.equal(
      await remove(manager, account.id).evaluate((button) => button === document.activeElement),
      true,
    )
    await page.locator('[data-task-subscribe="on"]').waitFor({ state: 'attached' })
    await page.locator('[data-task-subscribe-me="on"]').waitFor()
    assert.equal(followerIds(await persistedRoster(manager)).includes(account.id), true)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await eye(page).waitFor({ timeout: 30000 })
    assert.equal(await eye(page).getAttribute('data-task-subscribe'), 'on')
    await openRoster(page)
    assert.equal(
      await popup(manager).isVisible(),
      true,
      'Manager popup closed while the other account reloaded',
    )
    await remove(manager, account.id).click()
    await row(manager, account.id).waitFor({ state: 'detached' })
    await page.locator('[data-task-subscribe-me="off"]').waitFor()
    assert.equal(followerIds(await persistedRoster(manager)).includes(account.id), false)
    log(
      `Manager search, add and remove persist; ${account.role}'s eye updates live and after reload`,
    )
    await escapeRoster(page)
  }

  await add(manager).click()
  await manager.locator('[data-task-subscriber-search]').waitFor()
  await escapeRoster(manager)
  await openRoster(manager)
  assert.equal(await manager.locator('[data-task-subscriber-search]').count(), 0)
  await manager.mouse.click(8, 8)
  await popup(manager).waitFor({ state: 'detached' })
  assert.equal(manager.url(), taskURL, 'Clicking outside the popup dismissed the task')
  assert.equal(await manager.locator('[data-issue-key]').isVisible(), true)
  await manager.waitForFunction(() => document.activeElement?.hasAttribute('data-task-subscribe'))
  await manager.setViewportSize({ width: 390, height: 844 })
  await openRoster(manager)
  await assertWithinViewport(manager)
  await add(manager).click()
  await manager.locator('[data-task-subscriber-search]').waitFor()
  await assertWithinViewport(manager)
  mkdirSync('scripts/shots', { recursive: true })
  await manager.screenshot({ path: 'scripts/shots/subscribers-narrow.png' })
  await escapeRoster(manager)
  await manager.setViewportSize({ width: 1440, height: 1000 })
  await manager.reload({ waitUntil: 'domcontentloaded' })
  await eye(manager).waitFor({ timeout: 30000 })
  await openRoster(manager)
  await popup(manager).getByText('No other subscribers.', { exact: true }).waitFor()
  assert.deepEqual(followerIds(await persistedRoster(manager)), [setup.managerId])
  await manager.screenshot({ path: 'scripts/shots/subscribers-desktop.png' })
  await escapeRoster(manager)
  assert.deepEqual(pageErrors, [], 'Browser reported uncaught errors')
  log('Escape/outside dismiss only the popup and restore focus; narrow layout stays in bounds')
  if (!setup.users.some((user) => user.role === 'viewer'))
    log('No Northstar viewer account; viewer authority remains covered by hermetic backend tests')
  passed = true
} catch (error) {
  console.error('[subscribers] FAIL:', error?.message || 'Browser drive failed')
  mkdirSync('scripts/shots', { recursive: true })
  await manager.screenshot({ path: 'scripts/shots/subscribers-failure.png' }).catch(() => {})
  for (const [index, page] of [manager, ...participants].entries()) {
    if (index)
      await page
        .screenshot({ path: `scripts/shots/subscribers-failure-${index}.png` })
        .catch(() => {})
  }
} finally {
  try {
    await cleanupDemoArtifacts(browser, demo, { issueTitle: fixture.title })
    assert.deepEqual(await inspectBrowserDemo(demo), before, 'Northstar counts or anchor changed')
    log('Temporary task removed; Northstar counts and anchor preserved')
  } catch (error) {
    passed = false
    console.error('[subscribers] cleanup failed:', error?.message || 'Unknown cleanup failure')
  }
  for (const page of [manager, ...participants])
    await page.evaluate(() => window.PLANNER?.signOut()).catch(() => {})
  await browser.close()
}
if (passed) log('PASS')
process.exitCode = passed ? 0 : 1

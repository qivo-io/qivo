/* Production-bundle loading and update drive against the localhost dev origin.
 * Usage: npm run build && node scripts/update-smoke.mjs [baseURL]
 * The dev server and Northstar Nora credentials must already exist. Browser
 * routes serve dist/app.html + dist/assets and simulate version.json releases;
 * nothing is deployed and every editor draft is discarded without saving. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { inspectBrowserDemo, loadBrowserDemo, signInDemo } from './browser-demo.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = resolve(ROOT, 'dist')
const SHOTS = resolve(process.env.QIVO_SMOKE_ARTIFACTS ?? resolve(ROOT, '.local/update-review'))
mkdirSync(SHOTS, { recursive: true })
const demo = loadBrowserDemo(process.argv[2] ?? 'http://localhost:5199')
const before = await inspectBrowserDemo(demo)
let initialVersion
let appHtml
const assets = new Map()
function snapshotAssets(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) snapshotAssets(path)
    else assets.set(path, readFileSync(path))
  }
}
try {
  initialVersion = JSON.parse(readFileSync(resolve(DIST, 'version.json'), 'utf8')).buildId
  appHtml = readFileSync(resolve(DIST, 'app.html'), 'utf8')
  // Snapshot this artifact once so a separate local rebuild cannot remove a
  // lazy-loaded chunk midway through the drive.
  snapshotAssets(resolve(DIST, 'assets'))
} catch {
  throw new Error('Build artifacts are missing. Run npm run build before the update smoke.')
}
assert.match(initialVersion, /^[a-zA-Z0-9._-]{1,128}$/, 'Invalid build version manifest')

const log = (message) => console.log(`[update-smoke] ${message}`)
const QUIET_PROOF_MS = 6_000 // longer than the production monitor's five-second quiet period
const STAMP = randomUUID().slice(0, 8)
const MIME = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
}
let servedVersion = initialVersion
let documentLoads = 0
let versionRequests = 0
let pageErrors = 0
const requestedAssets = new Set()
const blockedAssets = new Set()
const chunks = (name) =>
  [...assets.keys()]
    .map((asset) => basename(asset))
    .filter((asset) => asset.startsWith(`${name}-`) && asset.endsWith('.js'))
    .map((asset) => `/assets/${asset}`)

function assertChunkRequested(name, expected) {
  const paths = chunks(name)
  assert.ok(paths.length > 0, `The production build has no ${name} chunk`)
  assert.equal(
    paths.some((path) => requestedAssets.has(path)),
    expected,
    `${name} chunk ${expected ? 'was not requested when opened' : 'loaded before it was needed'}`,
  )
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
page.setDefaultTimeout(15_000)
page.on('pageerror', () => pageErrors++)
const notice = page.locator('[data-app-update]')
const reloadButton = notice.getByRole('button', {
  name: 'Reload now',
  exact: true,
})

// Keep auth and backend traffic on their usual origins. The app bundle and
// stylesheet are immutable artifacts, while only the simulated manifest moves.
await page.route(`${demo.base}/**`, async (route) => {
  const url = new URL(route.request().url())
  if (url.pathname === '/version.json') {
    versionRequests++
    await route.fulfill({
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ buildId: servedVersion }),
    })
    return
  }
  if (
    route.request().isNavigationRequest() &&
    (url.pathname === '/app' || url.pathname.startsWith('/app/'))
  ) {
    documentLoads++
    await route.fulfill({ contentType: 'text/html', body: appHtml })
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    requestedAssets.add(url.pathname)
    if (blockedAssets.has(url.pathname)) {
      await route.abort('failed')
      return
    }
    const asset = resolve(DIST, `.${decodeURIComponent(url.pathname)}`)
    assert.ok(asset.startsWith(`${resolve(DIST, 'assets')}/`), 'Invalid asset path')
    assert.ok(assets.has(asset), 'Requested asset does not belong to the build under test')
    await route.fulfill({
      contentType: MIME[extname(asset)] || 'application/octet-stream',
      body: assets.get(asset),
    })
    return
  }
  await route.continue()
})

async function publishVersion(suffix) {
  servedVersion = `smoke-${STAMP}-${suffix}`
  const previousRequests = versionRequests
  // Focus is a real production check trigger; the regular poll stays at its
  // production interval rather than accelerating the code under test.
  const response = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/version.json',
  )
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await response
  await notice.waitFor({ state: 'visible' })
  assert.ok(versionRequests > previousRequests, 'Focus did not fetch the version manifest')
}

async function blurEditor() {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
}

async function assertHeld(loads, message, noticeVisible = true) {
  if (noticeVisible)
    assert.equal(await reloadButton.isDisabled(), true, `${message}: Reload now must be disabled`)
  await page.waitForTimeout(QUIET_PROOF_MS)
  assert.equal(documentLoads, loads, `${message}: the draft was interrupted by a reload`)
  if (noticeVisible)
    assert.equal(await reloadButton.isDisabled(), true, `${message}: Reload now became enabled`)
  else assert.equal(await notice.count(), 0, `${message}: the hidden notice reappeared`)
}

async function expectOneReload(previousLoads) {
  await page.waitForEvent('domcontentloaded', { timeout: 15_000 })
  await page.locator('[data-all-nav]').waitFor({ timeout: 30_000 })
  assert.equal(documentLoads, previousLoads + 1, 'Expected exactly one document reload')
  await notice.waitFor({ state: 'visible' })
  await page.waitForFunction(() =>
    document.querySelector('[data-app-update]')?.textContent.includes('Reload to update Qivo.'),
  )
}

async function assertPhoneDialogBounds(width) {
  await page.setViewportSize({ width, height: 844 })
  try {
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[data-modal-shell]')
      if (!(dialog instanceof HTMLElement) || dialog.style.width !== '100%') return false
      const rect = dialog.getBoundingClientRect()
      return (
        Math.abs(rect.left) <= 1 &&
        Math.abs(rect.width - window.innerWidth) <= 1 &&
        rect.top >= -1 &&
        rect.bottom <= window.innerHeight + 1
      )
    })
  } catch {
    const bounds = await page.locator('[data-modal-shell]').boundingBox()
    assert.fail(`New task dialog is clipped at ${width}px. Bounds ${JSON.stringify(bounds)}`)
  }
}

async function verifyLazyLoading() {
  const boardURL = `${demo.base}/app/${demo.orgSlug}/board/all`
  await page.locator('[data-card]').first().waitFor()
  assertChunkRequested('Kanban', true)
  for (const name of ['Overview', 'Inbox', 'IssueDetail', 'Modals', 'Palette'])
    assertChunkRequested(name, false)

  // Creation also loads the task window before submit can hand focus to it.
  await page
    .getByRole('button', { name: /^New task in / })
    .first()
    .click()
  const creation = page.getByRole('dialog', { name: 'New task', exact: true })
  await creation.waitFor()
  assertChunkRequested('Modals', true)
  assertChunkRequested('IssueDetail', true)
  await creation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await creation.waitFor({ state: 'detached' })

  const card = page.locator('[data-card]').first()
  const task = await card.getAttribute('data-card')
  const identity = await page.evaluate((id) => {
    const planner = window.PLANNER
    return { profile: planner.CURRENT_USER, ref: planner.issueById[id].key.toLowerCase() }
  }, task)
  await card.click()
  await page.locator('[data-task-scrim]').waitFor()
  assertChunkRequested('IssueDetail', true)
  await page.locator('[data-task-close]').click()
  await page.locator('[data-task-scrim]').waitFor({ state: 'detached' })
  await page.locator('[data-sidebar-search]').click()
  await page.getByRole('combobox', { name: 'Search tasks and projects' }).waitFor()
  assertChunkRequested('Palette', true)
  await page.locator('[data-palette-close]').click()
  log('Cold Board defers other views and loads task, creation and search chunks on demand')

  // An embedded Inbox task leaves Search reachable without bypassing a scrim.
  // A reply stays unsaved when focus moves; title edits intentionally save on blur.
  for (const path of chunks('Palette')) blockedAssets.add(path)
  requestedAssets.clear()
  await page.goto(`${demo.base}/app/${demo.orgSlug}/inbox/tasks/${identity.ref}`, {
    waitUntil: 'domcontentloaded',
  })
  const reply = page.getByRole('textbox', { name: 'Leave a comment', exact: true })
  await reply.waitFor()
  const draft = `Unsaved lazy-loading reply ${STAMP}`
  await reply.fill(draft)
  const taskTitle = await page.locator('[data-task-title]').innerText()
  await page.evaluate(() => {
    window.__smokeLazyPlanner = window.PLANNER
  })
  await page.locator('[data-sidebar-search]').click()
  const recovery = page.getByRole('dialog', { name: 'View unavailable', exact: true })
  await recovery.waitFor()
  assertChunkRequested('Palette', true)
  assert.equal(
    await recovery.getByRole('button', { name: 'Reload', exact: true }).isDisabled(),
    true,
  )
  // Radix hides the underlying Inbox from assistive technology while this
  // modal is open. Inspect its retained DOM without bypassing interaction guards.
  assert.equal(
    await page
      .locator('[data-composer] [role="textbox"][aria-label="Leave a comment"]')
      .innerText(),
    draft,
    'Failed search lost the task reply draft',
  )
  await page.keyboard.press('Escape')
  await recovery.waitFor({ state: 'detached' })
  assert.equal(await page.locator('[data-task-title]').innerText(), taskTitle)
  assert.equal(await reply.innerText(), draft, 'Closing recovery lost the task reply draft')
  assert.equal(await page.locator('[data-inbox]').isVisible(), true)
  assert.equal(await page.evaluate(() => window.PLANNER === window.__smokeLazyPlanner), true)
  await page
    .locator('[data-composer]')
    .getByRole('button', { name: 'Discard changes', exact: true })
    .click()
  assert.equal((await reply.innerText()).trim(), '', 'The temporary reply was not discarded')
  for (const path of chunks('Palette')) blockedAssets.delete(path)
  log('Failed search preserves the Inbox task and reply, guards reload and contains Escape')

  for (const path of chunks('App')) blockedAssets.add(path)
  requestedAssets.clear()
  await page.goto(boardURL, { waitUntil: 'domcontentloaded' })
  await page.getByText("Couldn't load your workspace", { exact: true }).waitFor()
  assertChunkRequested('App', true)
  assert.equal(await page.locator('[data-all-nav]').count(), 0)
  for (const path of chunks('App')) blockedAssets.delete(path)
  const beforeRetry = documentLoads
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.getByRole('button', { name: 'Try again', exact: true }).click(),
  ])
  await page.locator('[data-card]').first().waitFor({ timeout: 30_000 })
  assert.equal(documentLoads, beforeRetry + 1, 'A failed shell import must retry in a new document')
  assert.equal(await page.evaluate(() => window.PLANNER.CURRENT_USER), identity.profile)
  assert.equal(await page.evaluate(() => window.PLANNER.org.slug), demo.orgSlug)
  log('Failed workspace code reports a load error and retries by reloading the signed-in workspace')
}

let passed = false
try {
  await signInDemo(page, demo)
  await verifyLazyLoading()
  const initialLoads = documentLoads
  assert.ok(versionRequests > 0, 'Production version monitor did not request version.json')
  await blurEditor()
  await page.waitForTimeout(QUIET_PROOF_MS)
  assert.equal(documentLoads, initialLoads, 'An unchanged version reloaded the app')
  assert.equal(await notice.count(), 0, 'An unchanged version displayed an update notice')
  log('Unchanged build stays open without a notice')

  await page.locator('aside').getByText('Luma Sensor', { exact: true }).click()
  // the top bar carries no New task button (deviation #233): a status
  // column's + opens the same dialog
  await page
    .getByRole('button', { name: /^New task in / })
    .first()
    .click()
  const newTask = page.getByRole('dialog', { name: 'New task', exact: true })
  const title = newTask.getByRole('textbox', { name: 'Title', exact: true })
  const draftTitle = `Unsaved update smoke ${STAMP}`
  await title.fill(draftTitle)
  await blurEditor()
  await publishVersion('task-draft')
  await assertHeld(initialLoads, 'Blurred new-task draft')
  // Inspect the actual production stylesheet, including the notice's portal
  // outside the app root. Theme probes change only this browser's DOM, over a
  // painted Canvas image: Dark and Light panels turn translucent then, but
  // their floating windows stay solid.
  const materials = await notice.evaluate((element) => {
    const html = document.documentElement
    const original = {
      appearance: html.dataset.appearance,
      backgroundState: html.dataset.backgroundState,
    }
    const results = {}
    try {
      html.dataset.backgroundState = 'ready'
      for (const mode of ['blue', 'dark', 'light']) {
        html.dataset.appearance = mode
        const style = getComputedStyle(element)
        results[mode] = { background: style.backgroundColor, blur: style.backdropFilter }
      }
    } finally {
      for (const [key, value] of Object.entries(original))
        if (value === undefined) delete html.dataset[key]
        else html.dataset[key] = value
    }
    return results
  })
  assert.deepEqual(
    materials.blue,
    {
      background: 'rgba(26, 42, 56, 0.88)',
      blur: 'blur(10px)',
    },
    'blue: update notice must use the translucent floating material',
  )
  for (const mode of ['dark', 'light']) {
    assert.equal(materials[mode].blur, 'none', `${mode}: update notice must retain a solid surface`)
    assert.match(materials[mode].background, /^rgb\(/, `${mode}: update notice must be opaque`)
  }
  assert.equal(await title.inputValue(), draftTitle, 'The new-task title was lost')
  await page.screenshot({
    path: resolve(SHOTS, 'update-draft-desktop.png'),
    animations: 'disabled',
  })
  await assertPhoneDialogBounds(390)
  await notice.waitFor({ state: 'visible' })
  await page.screenshot({ path: resolve(SHOTS, 'update-draft-phone.png'), animations: 'disabled' })
  await assertPhoneDialogBounds(320)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.waitForFunction(
    () => document.querySelector('[data-modal-shell]')?.style.width !== '100%',
  )
  log('Blurred new-task draft survives a release and disables Reload now')

  await notice.getByRole('button', { name: 'Hide notice', exact: true }).click()
  await notice.waitFor({ state: 'detached' })
  await assertHeld(initialLoads, 'New-task draft after hiding the notice', false)
  assert.equal(await title.inputValue(), draftTitle, 'Hiding the notice dismissed the task draft')
  log('Hiding the notice preserves the draft and keeps its update queued')

  await newTask.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expectOneReload(initialLoads)
  const afterAutomatic = documentLoads
  await page.waitForTimeout(QUIET_PROOF_MS)
  assert.equal(documentLoads, afterAutomatic, 'The stale artifact caused a reload loop')
  assert.equal(await reloadButton.isEnabled(), true, 'A clean page should allow manual reload')
  log('Discarding the draft reloads once; a stale artifact pauses further automatic reloads')

  const manualReload = expectOneReload(afterAutomatic)
  await reloadButton.click()
  await manualReload
  log('Reload now explicitly retries a paused update')

  await page.locator('[data-card]').first().click()
  await page.locator('[data-task-scrim]').waitFor()
  const description = page.getByRole('textbox', { name: 'Task description', exact: true })
  const reply = page.getByRole('textbox', { name: 'Leave a comment', exact: true })
  await description.waitFor()
  const originalDescription = await description.innerText()
  const descriptionDraft = `Unsaved description ${STAMP}`
  const replyDraft = `Unsaved reply ${STAMP}`
  await description.fill(descriptionDraft)
  await reply.fill(replyDraft)
  await blurEditor()
  const beforeDescriptionReload = documentLoads
  await publishVersion('description-reply')
  await assertHeld(beforeDescriptionReload, 'Description and reply drafts')
  assert.equal(await description.innerText(), descriptionDraft, 'The description draft was lost')
  assert.equal(await reply.innerText(), replyDraft, 'The reply draft was lost')
  log('Description and reply drafts both survive a release after focus leaves the editors')

  await notice.getByRole('button', { name: 'Hide notice', exact: true }).click()
  await notice.waitFor({ state: 'detached' })
  await description
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " descfield ")]',
    )
    .getByRole('button', { name: 'Discard changes', exact: true })
    .click()
  await blurEditor()
  await assertHeld(beforeDescriptionReload, 'Remaining reply draft', false)
  assert.equal(await description.innerText(), originalDescription, 'Description discard failed')
  assert.equal(await reply.innerText(), replyDraft, 'Discarding the description cleared the reply')
  log('Discarding one editor keeps the remaining reply protected')

  await page
    .locator('[data-composer]')
    .getByRole('button', { name: 'Discard changes', exact: true })
    .click()
  await blurEditor()
  await expectOneReload(beforeDescriptionReload)
  assert.equal((await reply.innerText()).trim(), '', 'Discarded reply reappeared after reload')
  assert.equal(await description.innerText(), originalDescription, 'Draft description was saved')
  log('Discarding the last draft permits the update; saved task content stays unchanged')

  assert.equal(pageErrors, 0, 'The production bundle raised an uncaught browser error')
  const after = await inspectBrowserDemo(demo)
  assert.equal(after.anchor, before.anchor, 'The demo anchor changed during the update smoke')
  passed = true
} catch (error) {
  // Do not print browser payloads, source excerpts or authentication values.
  console.error('[update-smoke] FAIL:', error instanceof Error ? error.message : 'Unknown failure')
  process.exitCode = 1
} finally {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  try {
    await page.evaluate(() => window.PLANNER?.signOut())
  } catch {
    // The sign-out redirect can close its execution context. Closing the
    // isolated browser context also destroys the drive's remaining session.
  }
  await context.close()
  await browser.close()
}
if (passed) log('PASS. Production lazy loading, update detection, draft protection and recovery')

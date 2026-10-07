/* Smoke drive for the platform-operator area (/admin.html) on Convex.
   Usage: QIVO_ADMIN_EMAIL=... QIVO_ADMIN_PW=... node scripts/admin-smoke.mjs [baseURL]
   Checks non-admin denial and app/admin session isolation in the same browser
   context, then signs in as the operator alongside Nora in the app and walks
   Dashboard → Demos (report, charts and local cost preferences, or connection
   state) → Organizations → org detail → Users → recovery-link one-shot
   reveal (Nora) → break-glass create + ban/unban of the throwaway login →
   Background images + default setting + board preview + recurring calendar →
   Audit log → sign out.
   Exits non-zero on the first failed assertion.
   NOT read-only: it creates one break-glass member in the demo org, then
   removes only that member and its orphaned login. Northstar is not reset. */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import {
  cleanupDemoArtifacts,
  inspectBrowserDemo,
  loadBrowserDemo,
  signInBrowser,
  signInDemo,
} from './browser-demo.mjs'

const demo = loadBrowserDemo(process.argv[2] || 'http://localhost:5199')
const BASE = demo.base
const before = await inspectBrowserDemo(demo)
const EMAIL = process.env.QIVO_ADMIN_EMAIL
const PW = process.env.QIVO_ADMIN_PW
if (!EMAIL || !PW) {
  console.error('Set QIVO_ADMIN_EMAIL and QIVO_ADMIN_PW to a platform-admin login.')
  process.exit(2)
}
const SHOTS = 'scripts/shots'
mkdirSync(SHOTS, { recursive: true })

const BG_EMAIL = `smoke-ban-${randomUUID()}@example.test`
let bgCreated = false

const browser = await chromium.launch()
let failures = 0
function ok(cond, label) {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
}

async function signIn(page, email, password) {
  await page.goto(`${BASE}/admin.html`)
  await signInBrowser(page, { email, password })
}

async function expectBillingPlans(page) {
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Billing plans', exact: true })
    .click()
  const panel = page.locator('[data-billing-plans]')
  await panel.getByRole('heading', { name: 'Billing plans', exact: true }).waitFor()
  const catalogue = await page.evaluate(async () => {
    const { api } = await import('/convex/_generated/api.js')
    const { convex } = await import('/src/lib/convex.ts')
    return convex.query(api.adminBilling.listPlans, {})
  })
  if (catalogue.plans.length === 0)
    await panel.getByText('No billing plans yet.', { exact: true }).waitFor()
  for (const plan of catalogue.plans) {
    const row = panel.locator(`[data-billing-plan="${plan.id}"]`)
    await row.waitFor()
    ok(
      (await row.locator('legend').first().innerText()) === plan.name,
      'operator: billing catalogue preserves each named plan',
    )
    if (plan.id === catalogue.default_plan_id)
      ok(
        (await row.getByText('Default for new customers', { exact: true }).count()) === 1,
        'operator: billing catalogue identifies the new-customer default',
      )
  }
  const create = panel.locator('[data-create-billing-plan]')
  ok(await create.isDisabled(), 'operator: an unnamed billing plan cannot be created')
  const name = panel.getByRole('textbox', { name: 'Plan name', exact: true })
  await name.fill('Smoke plan (not saved)')
  ok(await create.isEnabled(), 'operator: valid draft plan form enables creation')
  await name.fill('')
  ok((await panel.getByRole('alert').count()) === 0, 'operator: billing plans load without errors')
  await page.screenshot({ path: `${SHOTS}/admin-billing-plans.png` })
  // Plans are immutable. This drive deliberately neither creates a plan nor
  // changes the default or any organization's real complimentary end date.
}

async function expectOrgBilling(page) {
  const panel = page.locator('[data-org-billing]')
  await panel.getByText('Current count', { exact: true }).waitFor({ timeout: 15000 })
  const summary = await page.evaluate(async (orgName) => {
    const { api } = await import('/convex/_generated/api.js')
    const { convex } = await import('/src/lib/convex.ts')
    const org = (await convex.query(api.admin.listOrgs, {})).find((row) => row.name === orgName)
    if (!org) throw new Error('The billing fixture is missing')
    return convex.query(api.adminBilling.orgBilling, { org_id: org.id })
  }, demo.orgName)
  ok(
    (await panel
      .getByText(
        `${summary.billable_users} billable users · ${summary.next_seats} users on the next invoice`,
        { exact: true },
      )
      .count()) === 1,
    'operator: organization billing count agrees with the backend',
  )
  ok(
    (await panel.locator('[data-grant-complimentary]').isEnabled()) ===
      summary.can_grant_complimentary,
    'operator: six-month free grant availability follows subscription and checkout state',
  )
  ok(
    (await panel
      .getByRole('combobox', { name: 'Organization billing plan', exact: true })
      .isEnabled()) === summary.can_assign_plan,
    'operator: plan assignment respects an existing subscription or checkout',
  )
  ok(
    (await panel.getByRole('alert').count()) === 0,
    'operator: organization billing loads without errors',
  )
}

async function backgroundAssignments(page) {
  return page.evaluate(async () => {
    const { api } = await import('/convex/_generated/api.js')
    const { convex } = await import('/src/lib/convex.ts')
    const calendar = await convex.query(api.panoramaImages.calendar, {})
    return {
      default_image_id: calendar.default_image_id,
      approved_count: calendar.approved_images.length,
      slots: calendar.slots.map(({ day, image }) => ({ day, image_id: image?.id ?? null })),
    }
  })
}

async function openDemoMetrics(page) {
  await page.getByRole('navigation').getByRole('button', { name: 'Demos', exact: true }).click()
  const panel = page.locator('[data-demo-metrics]')
  await panel.getByRole('heading', { name: 'Demos', exact: true }).waitFor()
  // Refreshing… remains the button label until the query has settled.
  await panel.getByRole('button', { name: 'Refresh', exact: true }).waitFor({ timeout: 15000 })
  if (await panel.getByRole('alert').count())
    throw new Error('The Demos panel could not load its reporting state.')
  return panel
}

async function expectDemoMetrics(page) {
  const panel = await openDemoMetrics(page)
  const disconnected = panel.getByRole('heading', {
    name: 'Demo reporting is not connected yet',
    exact: true,
  })
  if (await disconnected.count()) {
    ok(
      (await panel
        .getByText(/Connect demo reporting|Waiting for the first demo usage report/)
        .count()) === 1 &&
        (await panel.locator('#demo-chart-period, [data-demo-cost-total]').count()) === 0,
      'operator: Demos explains disconnected or waiting reporting without fabricated usage or costs',
    )
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
    await panel.getByRole('button', { name: 'Refresh', exact: true }).waitFor({ timeout: 15000 })
    ok(
      (await panel.getByRole('alert').count()) === 0,
      'operator: refreshing the Demos connection state succeeds',
    )
    await page.screenshot({ path: `${SHOTS}/admin-01-demos.png` })
    return
  }

  await panel.getByRole('heading', { name: 'Demo workspaces created', exact: true }).waitFor()
  ok(
    (await panel.getByRole('heading', { name: 'Total recorded', exact: true }).count()) === 1 &&
      (await panel
        .getByRole('heading', { name: 'This year compared with last year', exact: true })
        .count()) === 0 &&
      (await panel.getByText(/All reporting periods use UTC/).count()) === 1,
    'operator: Demos shows recorded totals and UTC periods without the old yearly text card',
  )
  const selector = panel.locator('#demo-chart-period')
  const creationChart = panel.getByRole('group', { name: 'Demo workspaces created', exact: true })
  for (const [period, expected] of [
    ['7d', 7],
    ['30d', 30],
    ['12m', 12],
  ]) {
    await selector.selectOption(period)
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector('svg[aria-label="Demo workspaces created"]')
          ?.querySelectorAll('[role="button"]').length === expected,
      expected,
    )
    ok(
      (await creationChart.getByRole('button').count()) === expected,
      `operator: Demos ${period} chart has ${expected} inspectable dates even when history is unavailable`,
    )
    ok(
      (await panel.locator('[data-demo-comparison-legend]').count()) === 1 &&
        (await creationChart.getByRole('button').first().getAttribute('aria-label')).includes(
          'Previous',
        ),
      `operator: Demos ${period} graph includes previous-period information and a color legend`,
    )
  }
  const points = creationChart.getByRole('button')
  await points.first().focus()
  await points.first().press('ArrowRight')
  ok(
    await points.nth(1).evaluate((point) => document.activeElement === point),
    'operator: Demos chart supports arrow-key navigation between values',
  )
  await points.nth(1).press('End')
  ok(
    await points.last().evaluate((point) => document.activeElement === point),
    'operator: Demos chart supports jumping to the latest date',
  )
  const creationCard = panel.locator('[data-slot="card"]').filter({
    has: page.getByRole('heading', { name: 'Demo workspaces created', exact: true }),
  })
  await creationCard.locator('summary').click()
  ok(
    (await creationCard.locator('tbody tr').count()) === 12 &&
      (await creationCard
        .getByRole('columnheader', { name: 'Previous period', exact: true })
        .count()) === 1,
    'operator: Demos chart has an equivalent data table with previous-period comparison',
  )
  ok(
    (await panel.getByRole('heading', { name: /^(Browser|Operating system|Country)$/ }).count()) ===
      3 &&
      (await panel
        .getByRole('group', { name: 'Daily average demo storage', exact: true })
        .count()) === 1,
    'operator: Demos includes visitor breakdowns and a storage history chart',
  )

  const costKey = 'qivo:admin:demo-cost-estimate:v1'
  const previousPrices = await page.evaluate((key) => localStorage.getItem(key), costKey)
  const prices = { currency: 'NOK', databasePrice: '0.5', filePrice: '0.1', otherMonthly: '12' }
  try {
    ok(
      (await panel.locator('#demo-currency').inputValue()) === 'USD' &&
        (await panel.locator('#demo-databasePrice').inputValue()) === '0.26' &&
        (await panel.locator('#demo-filePrice').inputValue()) === '0.039',
      'operator: Demos prefills current Convex Professional EU storage prices',
    )
    await panel.locator('#demo-databasePrice').fill('')
    await panel.locator('#demo-filePrice').fill('')
    ok(
      (await panel.locator('[data-demo-cost-total]').innerText()) === 'Unavailable',
      'operator: Demos does not invent a cost when storage prices are missing',
    )
    for (const [field, value] of Object.entries(prices))
      await panel.locator(`#demo-${field}`).fill(value)
    const hasSamples = (await panel.getByText(/^Basis: 0 samples /).count()) === 0
    ok(
      ((await panel.locator('[data-demo-cost-total]').innerText()) !== 'Unavailable') ===
        hasSamples,
      'operator: Demos calculates the entered cost only when this month has storage samples',
    )
    await panel.locator('#demo-databasePrice').fill('-1')
    ok(
      (await panel.locator('#demo-databasePrice').getAttribute('aria-invalid')) === 'true' &&
        (await panel.locator('[data-demo-cost-total]').innerText()) === 'Unavailable',
      'operator: Demos rejects negative prices instead of showing a misleading estimate',
    )
    await panel.locator('#demo-databasePrice').fill(prices.databasePrice)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor({ timeout: 20000 })
    const reopened = await openDemoMetrics(page)
    for (const [field, value] of Object.entries(prices))
      ok(
        (await reopened.locator(`#demo-${field}`).inputValue()) === value,
        `operator: Demos preserves the local ${field} preference after reload`,
      )
    await page.locator('main').evaluate((main) => {
      main.scrollTop = 0
    })
    await page.screenshot({ path: `${SHOTS}/admin-01-demos.png` })
  } finally {
    await page.evaluate(
      ({ key, previous }) => {
        if (previous === null) localStorage.removeItem(key)
        else localStorage.setItem(key, previous)
      },
      { key: costKey, previous: previousPrices },
    )
  }
}

async function expectImageFileInfo(page, scope, image, label) {
  const expected = await page.evaluate(async (image) => {
    const { fmtBytes } = await import('/src/admin/api.ts')
    const original = `Original: ${image.width} × ${image.height}, ${fmtBytes(image.byte_size)}`
    if (!image.preview_url || !image.preview_byte_size)
      return { original, preview: 'Preview unavailable', previewSize: null }
    const preview = new Image()
    preview.src = image.preview_url
    await preview.decode()
    const blob = await (await fetch(image.preview_url)).blob()
    return {
      original,
      preview: `Preview: ${preview.naturalWidth} × ${preview.naturalHeight}, ${fmtBytes(blob.size)}`,
      previewSize: blob.size,
    }
  }, image)
  ok(
    (await scope.locator('[data-image-file-info="original"]').innerText()) === expected.original,
    `${label}: original dimensions and file size match the saved image`,
  )
  const preview = scope.locator('[data-image-file-info="preview"]')
  await preview.waitFor()
  await preview.filter({ hasText: 'Preview: Loading details…' }).waitFor({ state: 'hidden' })
  ok(
    (await preview.innerText()) === expected.preview &&
      (expected.previewSize === null || expected.previewSize === image.preview_byte_size),
    `${label}: preview statistics match the decoded derivative and downloaded bytes`,
  )
}

async function expectImagePickerLayout(page, chooser, image, label) {
  const option = chooser.locator(`[data-image-picker-option="${image.id}"]`)
  await option.click()
  const selected = chooser.locator('[data-image-picker-selection]')
  await selected.waitFor()
  const expected = ['title', 'location', 'creator']
    .filter((field) => image[field]?.trim())
    .map((field) => ({ field, text: image[field].trim() }))
  let wrappedRows = 0
  for (const [scope, name] of [
    [option, 'result'],
    [selected, 'selection'],
  ]) {
    const rows = await scope.locator('[data-image-metadata]').evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        const range = document.createRange()
        range.selectNodeContents(element)
        const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)))
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')
        context.font = style.font
        return {
          field: element.dataset.imageMetadata,
          text: element.textContent.trim(),
          top: bounds.top,
          bottom: bounds.bottom,
          horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
          needsWrap: context.measureText(element.textContent.trim()).width > bounds.width + 2,
          lines: lines.size,
        }
      }),
    )
    ok(
      JSON.stringify(rows.map(({ field, text }) => ({ field, text }))) ===
        JSON.stringify(expected) &&
        rows.every((row, index) => index === 0 || row.top >= rows[index - 1].bottom - 1),
      `${label}: ${name} shows available Title, Location and Creator on separate ordered rows`,
    )
    ok(
      rows.every((row) => !row.horizontalOverflow && (!row.needsWrap || row.lines > 1)),
      `${label}: ${name} wraps metadata that exceeds its available width`,
    )
    wrappedRows += rows.filter((row) => row.lines > 1).length
  }
  ok(
    await chooser.evaluate((dialog) => {
      const bounds = dialog.getBoundingClientRect()
      return (
        dialog.scrollWidth <= dialog.clientWidth + 1 &&
        bounds.left >= 0 &&
        bounds.right <= window.innerWidth &&
        [...dialog.querySelectorAll('[data-image-metadata]')].every((element) => {
          const row = element.getBoundingClientRect()
          return row.left >= bounds.left && row.right <= bounds.right
        })
      )
    }),
    `${label}: dialog and metadata stay within the viewport without horizontal overflow`,
  )
  if (page.viewportSize().width < 640) {
    ok(
      await selected.evaluate((selection) => {
        const button = selection.querySelector('button').getBoundingClientRect()
        const contentBottom = Math.max(
          ...[...selection.querySelectorAll('img, [data-image-metadata]')].map(
            (element) => element.getBoundingClientRect().bottom,
          ),
        )
        return button.top >= contentBottom
      }),
      `${label}: Preview in board sits below the image and metadata at narrow width`,
    )
  }
  return wrappedRows
}

async function appIsNora(page) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-all-nav]').waitFor({ timeout: 30000 })
  return page.evaluate(
    async ({ email, orgSlug }) => {
      const { authClient } = await import('/src/lib/auth.ts')
      const { data } = await authClient.getSession()
      return !!data?.session && data.user.email === email && window.PLANNER.org?.slug === orgSlug
    },
    { email: demo.account('nora').email, orgSlug: demo.orgSlug },
  )
}

/* Read only opaque IDs into test-process memory; never tokens or cookies.
   Each page imports its OWN auth module: importing both modules into one page
   could itself re-arm that page's Convex socket with the other identity. */
async function separateSessionsForNora(appPage, adminPage) {
  try {
    const read = (page, module) =>
      page.evaluate(
        async ({ module, email }) => {
          const { authClient } = await import(module)
          const { data } = await authClient.getSession()
          if (!data?.session || data.user.email !== email) return null
          return { userId: data.user.id, sessionId: data.session.id }
        },
        { module, email: demo.account('nora').email },
      )
    const [app, admin] = await Promise.all([
      read(appPage, '/src/lib/auth.ts'),
      read(adminPage, '/src/admin/auth.ts'),
    ])
    return (
      !!app?.sessionId &&
      !!admin?.sessionId &&
      app.userId === admin.userId &&
      app.sessionId !== admin.sessionId
    )
  } catch {
    throw new Error('Could not compare the independent app and admin sessions.')
  }
}

/* One-shot LinkReveal: exactly one reveal, the one-time warning copy, and the
   URL present exactly once in the whole document. Returns the URL. */
async function expectReveal(page, label) {
  const reveal = page.locator('[data-link-reveal]')
  await reveal.waitFor({ timeout: 20000 })
  ok((await reveal.count()) === 1, `${label}: exactly one reveal panel`)
  const heading = await reveal.getByText('One-time recovery link', { exact: true }).count()
  const warning = await reveal
    .getByText('Copy it now. It won’t be shown again.', { exact: true })
    .count()
  ok(heading === 1 && warning === 1, `${label}: copy warns the link is shown only once`)
  const url = ((await reveal.innerText()).match(/https?:\/\/\S+/) || [])[0] || ''
  ok(url.startsWith('http'), `${label}: reveal holds a URL`)
  const occurrences = (await page.content()).split(url).length - 1
  ok(occurrences === 1, `${label}: URL appears exactly once in the DOM (${occurrences})`)
  await page.click('[data-link-reveal] >> text=Done')
  await reveal.waitFor({ state: 'detached', timeout: 5000 })
  return url
}

try {
  /* ---------------- probe: regular user is denied ---------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } })
    const page = await ctx.newPage()
    await signIn(page, demo.account('leo').email, demo.account('leo').password)
    const denied = await page
      .waitForSelector('text=No access', { timeout: 10000 })
      .then(() => true)
      .catch(() => false)
    ok(denied, 'Leo: non-admin sees "No access"')
    await page.screenshot({ path: `${SHOTS}/admin-00-denied.png` })
    if (denied) {
      await page.getByRole('button', { name: 'Use another account', exact: true }).click()
      await page.locator('input[type=email]').waitFor({ timeout: 15000 })
    }
    await ctx.close()
  }

  /* ---------------- operator: full walk ---------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } })
    const page = await ctx.newPage()
    const appPage = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      /* A signed-out page always mints a 401 on the Better Auth token
         endpoint (lib/auth.ts handles it with throw:false, but the browser
         logs the network failure anyway — the app shell does the same).
         Benign by construction; everything else fails the run. */
      if (
        m.location().url.includes('/api/auth/convex/token') &&
        m.text().startsWith('Failed to load resource')
      )
        return
      errors.push(m.text())
    })

    await signInDemo(appPage, demo, 'nora')
    ok(await appIsNora(appPage), 'isolation: app is signed in as Nora in Northstar Labs')
    await page.goto(`${BASE}/admin.html`)
    await page.locator('input[type=email]').waitFor({ timeout: 15000 })
    ok(
      (await page.getByRole('button', { name: 'Sign in', exact: true }).count()) === 1 &&
        (await page.getByText('No access', { exact: true }).count()) === 0,
      'isolation: a signed-in app leaves admin at its own Sign in form',
    )
    await signInBrowser(page, demo.account('nora'))
    await page.getByText('No access', { exact: true }).waitFor({ timeout: 15000 })
    ok(
      await separateSessionsForNora(appPage, page),
      'isolation: the same Nora login creates distinct app and admin sessions',
    )
    await page.getByRole('button', { name: 'Use another account', exact: true }).click()
    await page.locator('input[type=email]').waitFor({ timeout: 15000 })
    ok(await appIsNora(appPage), 'isolation: denied-admin sign-out preserves the app session')

    await signIn(page, EMAIL, PW)
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor({ timeout: 20000 })
    ok(true, 'operator: signed in, dashboard renders')
    ok(
      await appIsNora(appPage),
      'isolation: operator sign-in does not replace app Nora after reload',
    )
    await page.waitForSelector('text=Activity events per week', { timeout: 10000 })
    ok(true, 'operator: weekly activity chart present')
    await page.screenshot({ path: `${SHOTS}/admin-01-dashboard.png` })

    await expectDemoMetrics(page)
    await expectBillingPlans(page)

    await page.click('nav >> text=Organizations')
    const northstarRow = page.locator('tbody tr', { hasText: demo.orgName })
    await northstarRow.waitFor({ timeout: 10000 })
    ok(true, 'operator: organizations table has the Northstar Labs row')
    const tasksColumn = await page
      .getByRole('columnheader', { name: 'Tasks', exact: true })
      .evaluate((cell) => cell.cellIndex)
    const tasks = parseInt(await northstarRow.locator('td').nth(tasksColumn).innerText(), 10)
    ok(
      Number.isFinite(tasks) && tasks > 0,
      `operator: Northstar row carries counts (${tasks} tasks)`,
    )
    await page.screenshot({ path: `${SHOTS}/admin-02-orgs.png` })

    const representedOrganizations = await page.locator('tbody tr').evaluateAll((rows) => {
      const labels = [...document.querySelectorAll('thead th')].map((cell) => cell.innerText.trim())
      const memberColumn = labels.indexOf('Members')
      const guestColumn = labels.indexOf('Guests')
      return rows
        .filter(
          (row) =>
            Number.parseInt(row.cells[memberColumn]?.innerText || '0', 10) +
              Number.parseInt(row.cells[guestColumn]?.innerText || '0', 10) >
            0,
        )
        .map((row) => row.cells[0].innerText.trim())
    })
    await northstarRow.click()
    await page.waitForSelector('text=Break-glass access', { timeout: 10000 })
    ok(true, 'operator: org detail shows break-glass card')
    const memberRows = await page.locator('tbody tr').count()
    ok(memberRows > 0, `operator: org detail lists members (${memberRows})`)
    await expectOrgBilling(page)
    await page.screenshot({ path: `${SHOTS}/admin-03-org-detail.png` })

    await page.click('nav >> text=Users')
    await page.waitForSelector('tbody tr', { timeout: 10000 })
    const allUsers = await page.locator('tbody tr').count()
    const userOrganizations = await page
      .locator('tbody tr')
      .evaluateAll((rows) => [...new Set(rows.map((row) => row.cells[2]?.innerText.trim()))])
    ok(
      allUsers >= before.counts.users &&
        representedOrganizations.every((name) => userOrganizations.includes(name)),
      `operator: users list covers the organizations with members (${allUsers} rows)`,
    )
    await page.fill('input[placeholder*="Search"]', 'sofia')
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('tbody tr')]
      return rows.length === 1 && rows[0].innerText.includes('Sofia Andersson')
    })
    const narrowed = await page.locator('tbody tr').count()
    ok(
      allUsers > narrowed && narrowed >= 1,
      `operator: user search narrows (${allUsers} → ${narrowed})`,
    )
    await page.screenshot({ path: `${SHOTS}/admin-04-users.png` })

    /* Recovery link for Nora — target her Northstar seat explicitly. */
    await page.fill('input[placeholder*="Search"]', 'nora')
    const noraRow = page
      .locator('tbody tr', { hasText: 'Nora Berg' })
      .filter({ hasText: demo.orgName })
    await noraRow.waitFor({ timeout: 10000 })
    await noraRow.getByRole('button', { name: 'Recovery link' }).click()
    await expectReveal(page, 'operator: Nora recovery link')
    await page.screenshot({ path: `${SHOTS}/admin-05-reveal-closed.png` })

    /* break-glass throwaway, then ban + unban it */
    await page.click('nav >> text=Organizations')
    await page.locator('tbody tr', { hasText: demo.orgName }).click()
    await page.waitForSelector('text=Break-glass access', { timeout: 10000 })
    await page
      .getByRole('textbox', { name: 'Break-glass account email', exact: true })
      .fill(BG_EMAIL)
    bgCreated = true // Cleanup also runs if the create response/reveal is lost.
    await page.click('button:has-text("Create")')
    await expectReveal(page, 'operator: break-glass link')
    const bgRow = page.locator('tbody tr', { hasText: BG_EMAIL })
    await bgRow.waitFor({ timeout: 10000 })
    ok(true, `operator: break-glass member row appears (${BG_EMAIL})`)
    await page.screenshot({ path: `${SHOTS}/admin-06-break-glass.png` })

    await bgRow.getByRole('button', { name: 'Ban', exact: true }).click()
    await bgRow.getByText('banned', { exact: true }).waitFor({ timeout: 20000 })
    ok(true, 'operator: ban lands, "banned" badge renders')
    await page.screenshot({ path: `${SHOTS}/admin-07-banned.png` })
    await bgRow.getByRole('button', { name: 'Unban', exact: true }).click()
    await bgRow.getByText('banned', { exact: true }).waitFor({ state: 'detached', timeout: 20000 })
    ok(true, 'operator: unban lifts the badge')

    /* Curated backgrounds: read the live library/calendar without uploading,
       approving or changing an operator's assignments during a smoke. */
    const backgroundImages = await page.evaluate(async () => {
      const { api } = await import('/convex/_generated/api.js')
      const { convex } = await import('/src/lib/convex.ts')
      const [library, calendar] = await Promise.all([
        convex.query(api.panoramaImages.library, { status: 'pending' }),
        convex.query(api.panoramaImages.calendar, {}),
      ])
      return [...library.images, ...calendar.approved_images]
    })
    const imagesById = new Map(backgroundImages.map((image) => [image.id, image]))
    const pickerImage = [...imagesById.values()]
      .filter((image) => image.status === 'approved')
      .sort(
        (a, b) =>
          [b.title, b.location, b.creator].join(' ').length -
          [a.title, a.location, a.creator].join(' ').length,
      )[0]
    const originalUrls = new Set(backgroundImages.map((image) => image.image_url).filter(Boolean))
    const previewUrls = new Set(backgroundImages.map((image) => image.preview_url).filter(Boolean))
    const backgroundRequests = []
    const recordBackground = (request) => backgroundRequests.push(request.url())
    page.on('request', recordBackground)
    const expectPreviewSources = async (scope, label) => {
      const sources = await scope
        .locator('img')
        .evaluateAll((images) => images.map((image) => image.src))
      ok(
        sources.every((source) => previewUrls.has(source)),
        label,
      )
    }
    await page.getByRole('button', { name: 'Background images', exact: true }).click()
    await page.locator('[data-background-images]').waitFor()
    await page.locator('[data-image-summary]').waitFor({ timeout: 10000 })
    const assignmentsBefore = await backgroundAssignments(page)
    const defaultCard = page.locator('[data-default-background]')
    await defaultCard.getByRole('heading', { name: 'Default background', exact: true }).waitFor()
    await defaultCard.getByText('Used in weeks without an available calendar image.').waitFor()
    ok(true, 'operator: default background setting explains its calendar fallback')
    await expectPreviewSources(
      defaultCard,
      'operator: default background thumbnail uses its compressed derivative',
    )
    const chooseDefault = defaultCard.getByRole('button', {
      name: /^(Choose|Change) default$/,
    })
    if (!assignmentsBefore.default_image_id && assignmentsBefore.approved_count === 0) {
      ok(
        await chooseDefault.isDisabled(),
        'operator: default selection is disabled when no approved images exist',
      )
    } else {
      await chooseDefault.click()
      const chooser = page.getByRole('dialog', { name: 'Default background image', exact: true })
      await chooser.getByRole('combobox', { name: 'Search approved images' }).waitFor()
      await expectPreviewSources(
        chooser,
        'operator: default chooser thumbnails use compressed derivatives',
      )
      ok(
        await chooser.locator('[data-default-background-save]').isDisabled(),
        'operator: default chooser opens with the current selection and no pending change',
      )
      if (pickerImage) {
        await expectImagePickerLayout(page, chooser, pickerImage, 'operator: default chooser')
        await page.setViewportSize({ width: 390, height: 844 })
        const wrapped = await expectImagePickerLayout(
          page,
          chooser,
          pickerImage,
          'operator: narrow default chooser',
        )
        if (!wrapped)
          console.log('SKIP  operator: approved library metadata is too short to require wrapping')
        await page.screenshot({ path: `${SHOTS}/admin-background-default-narrow.png` })
        await page.setViewportSize({ width: 1280, height: 820 })
      }
      await chooser.getByRole('button', { name: 'Cancel', exact: true }).click()
      await chooser.waitFor({ state: 'detached' })
    }
    const firstPreview = page
      .locator('[data-background-image]')
      .filter({ has: page.locator('img') })
      .first()
    await page.waitForFunction(() => {
      const status = document.querySelector('#background-status')
      return (
        status?.value === 'pending' &&
        (document.querySelector('[data-background-image]') ||
          document.body.innerText.includes('No images waiting for review'))
      )
    })
    const renderedCards = await page.locator('[data-background-image]').evaluateAll((cards) =>
      cards.map((card) => ({
        id: card.dataset.backgroundImage,
        src: card.querySelector('img')?.src ?? null,
      })),
    )
    ok(
      renderedCards.every(
        ({ id, src }) => imagesById.has(id) && src === imagesById.get(id).preview_url,
      ),
      'operator: library cards use each image’s compressed derivative or a placeholder when unavailable',
    )
    ok(
      (await page.getByText('Permission confirmed by uploader', { exact: true }).count()) === 0,
      'operator: image cards omit the generic uploader permission label',
    )
    if (await firstPreview.count()) {
      const imageTitle = await firstPreview.getByRole('heading').innerText()
      const visibleImageId = await firstPreview.getAttribute('data-background-image')
      const selectedImage = imagesById.get(visibleImageId)
      await expectImageFileInfo(page, firstPreview, selectedImage, 'operator: image card')
      await firstPreview.getByRole('button', { name: `Preview ${imageTitle}`, exact: true }).click()
      const preview = page.getByRole('dialog', { name: imageTitle, exact: true })
      await expectImageFileInfo(page, preview, selectedImage, 'operator: preview window')
      ok(
        (await preview.getByText('Permission confirmed by uploader', { exact: true }).count()) ===
          0,
        'operator: preview window omits the generic uploader permission label',
      )
      if (selectedImage.license_url) {
        ok(
          (await preview
            .getByRole('link', { name: selectedImage.license, exact: true })
            .getAttribute('href')) === selectedImage.license_url,
          'operator: preview retains the provider license link',
        )
      }
      const board = preview.locator('[data-canvas-preview]')
      await board.waitFor()
      await board.locator('img').waitFor({ timeout: 20000 })
      await board.locator('img').evaluate((image) => image.decode())
      ok(
        (await preview
          .getByRole('tab', { name: 'Board preview', exact: true })
          .getAttribute('aria-selected')) === 'true' &&
          (await board.locator('img').evaluate((image) => image.naturalWidth > 0)),
        'operator: a pending library image opens as a decoded sample Canvas board',
      )
      const approveInPreview = preview.locator('[data-image-preview-approve]')
      await approveInPreview.waitFor()
      ok(
        (await approveInPreview.getAttribute('data-image-preview-approve')) === visibleImageId &&
          (await approveInPreview.innerText()) === 'Approve and next' &&
          !(await approveInPreview.isDisabled()),
        'operator: the board preview offers approval for the displayed pending image',
      )
      ok(
        (await board.locator('img').getAttribute('src')) === selectedImage.preview_url &&
          (await board.locator('img').evaluate((image) => image.naturalWidth <= 960)),
        'operator: the board preview decodes the selected compressed image',
      )
      ok(
        (await preview
          .getByRole('link', { name: 'Open preview image', exact: true })
          .getAttribute('href')) === selectedImage.preview_url,
        'operator: opening the image separately also links to the compressed preview',
      )
      await page.screenshot({ path: `${SHOTS}/admin-background-board-preview.png` })
      await preview.getByRole('tab', { name: 'Image only', exact: true }).click()
      const photo = preview
        .getByRole('tabpanel', { name: 'Image only', exact: true })
        .getByRole('img', { name: imageTitle, exact: true })
      await photo.waitFor()
      await photo.evaluate((image) => image.decode())
      ok(
        (await photo.evaluate((image) => image.naturalWidth > 0)) && (await board.count()) === 0,
        'operator: Image only shows the selected photograph without the board',
      )
      ok(
        (await photo.getAttribute('src')) === selectedImage.preview_url &&
          (await photo.evaluate((image) => image.naturalWidth <= 960)),
        'operator: Image only uses the same compressed derivative',
      )
      await preview
        .locator('[data-slot="dialog-footer"]')
        .getByRole('button', { name: 'Close', exact: true })
        .click()
      await preview.waitFor({ state: 'detached' })
      ok(
        (await page.locator('#background-status').inputValue()) === 'pending' &&
          (await page.locator(`[data-background-image="${visibleImageId}"]`).count()) === 1,
        'operator: closing the preview restores the pending library and reviewed image',
      )
    } else {
      console.log('SKIP  operator: no pending library image is available to preview')
    }
    ok(
      (await page.getByRole('button', { name: /Fill image library|Library settings/ }).count()) ===
        0,
      'operator: background library has no automatic import or refill settings controls',
    )
    const manual = page.locator('[data-manual-image-upload]')
    const manualFile = manual.locator('[data-manual-image-file]')
    const manualSubmit = manual.locator('[data-manual-image-submit]')
    await manualFile.waitFor()
    ok(
      (await manualFile.getAttribute('accept')) === 'image/jpeg,image/png,image/webp',
      'operator: manual image entry accepts JPEG, PNG and WebP without a source URL',
    )
    ok(
      await manualFile.evaluate((input) => input.multiple),
      'operator: manual image entry accepts multiple selected files',
    )
    ok(
      await manualSubmit.isDisabled(),
      'operator: manual upload requires an image, title and creator',
    )
    await manual.getByLabel('Title', { exact: true }).waitFor()
    await manual.getByLabel('Location', { exact: true }).waitFor()
    await manual.getByLabel('Creator', { exact: true }).waitFor()
    await manual
      .getByText(
        'By uploading images, I confirm that I have permission to use them for this purpose.',
        {
          exact: true,
        },
      )
      .waitFor()
    ok(
      (await manual.getByRole('checkbox').count()) === 0 &&
        (await manualSubmit.textContent()).trim() === 'Save image',
      'operator: Save image records the displayed permission assertion without a checkbox',
    )
    await manual.getByText(/landscape ratio 1.3:1–3:1/).waitFor()
    await manual.locator('#manual-image-title').fill('Temporary suitability check')
    await manual.locator('#manual-image-creator').fill('Synthetic browser fixture')
    for (const [width, height, refusal] of [
      [800, 600, /at least 1600 × 800/],
      [1600, 1920, /aspect ratio/],
      [3200, 900, /aspect ratio/],
    ]) {
      const encoded = await page.evaluate(
        ({ width, height }) => {
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          canvas.getContext('2d').fillRect(0, 0, width, height)
          return canvas.toDataURL('image/jpeg').split(',')[1]
        },
        { width, height },
      )
      await manualFile.setInputFiles({
        name: 'suitability-check.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.from(encoded, 'base64'),
      })
      await manual.getByRole('alert').filter({ hasText: refusal }).waitFor()
      ok(
        await manualSubmit.isDisabled(),
        `operator: unsuitable ${width}×${height} image is blocked before upload with a specific reason`,
      )
    }
    for (const format of ['jpeg', 'png', 'webp']) {
      const encoded = await page.evaluate((format) => {
        const canvas = document.createElement('canvas')
        canvas.width = 1920
        canvas.height = 1080
        canvas.getContext('2d').fillRect(0, 0, 1920, 1080)
        return canvas.toDataURL(`image/${format}`).split(',')[1]
      }, format)
      const originalBytes = Buffer.from(encoded, 'base64')
      await manualFile.setInputFiles({
        name: `suitability-check.${format}`,
        mimeType: `image/${format}`,
        buffer: originalBytes,
      })
      await manual.getByText(/1920 × 1080 pixels/).waitFor()
      ok(await manualSubmit.isEnabled(), `operator: suitable ${format} passes browser validation`)
      const localPreview = manual.locator('img')
      await localPreview.waitFor()
      const compressed = await localPreview.evaluate(async (image) => {
        await image.decode()
        const blob = await (await fetch(image.currentSrc)).blob()
        const original = document.querySelector('[data-manual-image-file]').files[0]
        return {
          width: image.naturalWidth,
          height: image.naturalHeight,
          type: blob.type,
          size: blob.size,
          originalType: original.type,
          originalSize: original.size,
        }
      })
      ok(
        compressed.width === 960 &&
          compressed.height === 540 &&
          compressed.type === 'image/webp' &&
          compressed.size > 0 &&
          compressed.size < originalBytes.length &&
          compressed.originalType === `image/${format}` &&
          compressed.originalSize === originalBytes.length,
        `operator: local ${format} preview is compressed WebP while the selected original stays unchanged`,
      )
    }
    await manual.locator('#manual-image-location').fill('Synthetic fixture location')
    await manual.getByRole('button', { name: 'Clear', exact: true }).click()
    ok(
      (await manual.locator('#manual-image-title').inputValue()) === '' &&
        (await manual.locator('#manual-image-location').inputValue()) === '' &&
        (await manual.locator('#manual-image-creator').inputValue()) === '' &&
        (await manualFile.inputValue()) === '' &&
        (await manualSubmit.isDisabled()),
      'operator: Clear discards the local selection without adding a photo',
    )
    const batchBefore = await page.evaluate(async () => {
      const { api } = await import('/convex/_generated/api.js')
      const { convex } = await import('/src/lib/convex.ts')
      return convex.query(api.panoramaImages.summary, {})
    })
    const missingCreditFiles = await page.evaluate(async () => {
      const fixture = (await import('/src/lib/fixtures/background-windows-exif.json')).default
      const canvas = document.createElement('canvas')
      canvas.width = 1920
      canvas.height = 1080
      canvas.getContext('2d').fillRect(0, 0, 1920, 1080)
      const pixels = Uint8Array.from(atob(canvas.toDataURL('image/jpeg').split(',')[1]), (c) =>
        c.charCodeAt(0),
      )
      return ['title', 'author'].map((field) => {
        const metadata = Uint8Array.from(atob(fixture.app1Base64), (c) => c.charCodeAt(0))
        const view = new DataView(metadata.buffer, 10)
        const count = view.getUint16(8)
        for (let index = 0; index < count; index++) {
          const entry = 10 + index * 12
          const tag = view.getUint16(entry)
          if ((field === 'title' ? [0x9c9b, 0x010e] : [0x9c9d, 0x013b]).includes(tag))
            view.setUint16(entry, 0)
        }
        return {
          name: `missing-${field}.jpg`,
          bytes: [...pixels.subarray(0, 2), ...metadata, ...pixels.subarray(2)],
        }
      })
    })
    // Edited single-image fields must never supply a batch file's missing credits.
    await manual.locator('#manual-image-title').fill('Title from another image')
    await manual.locator('#manual-image-creator').fill('Author from another image')
    await manualFile.setInputFiles(
      missingCreditFiles.map(({ name, bytes }) => ({
        name,
        mimeType: 'image/jpeg',
        buffer: Buffer.from(bytes),
      })),
    )
    const batchResult = page.locator('[data-manual-image-batch-result]')
    await batchResult
      .getByText(/2 images were skipped because title or author was missing/)
      .waitFor()
    ok(
      (await batchResult.innerText()).includes('0 images added for review.') &&
        (await manualFile.inputValue()) === '' &&
        (await manualSubmit.isDisabled()),
      'operator: missing title or author skips each batch image and reports the result automatically',
    )
    const batchAfter = await page.evaluate(async () => {
      const { api } = await import('/convex/_generated/api.js')
      const { convex } = await import('/src/lib/convex.ts')
      return convex.query(api.panoramaImages.summary, {})
    })
    ok(
      JSON.stringify(batchAfter) === JSON.stringify(batchBefore),
      'operator: skipped batch files leave the live image library unchanged',
    )
    await page.locator('#background-status').selectOption('approved')
    ok(
      (await page.locator('#background-status').inputValue()) === 'approved',
      'operator: image review filter changes',
    )
    await page.getByRole('tab', { name: 'Calendar', exact: true }).click()
    await page.locator('[data-calendar-day="W01"]').waitFor({ timeout: 10000 })
    ok(
      JSON.stringify(
        await page
          .locator('[data-calendar-day]')
          .evaluateAll((slots) => slots.map((slot) => slot.dataset.calendarDay)),
      ) ===
        JSON.stringify(
          Array.from({ length: 53 }, (_, index) => `W${String(index + 1).padStart(2, '0')}`),
        ),
      'operator: the recurring calendar shows Week 1 through Week 53 in order',
    )
    ok(
      (await page.getByText('Each image runs Monday–Sunday in UTC', { exact: false }).count()) ===
        1,
      'operator: weekly boundaries and the occasional week 53 are explained',
    )
    ok(
      (await page.locator('#background-year, #background-month').count()) === 0,
      'operator: the recurring calendar has no year or month filters',
    )
    ok(
      (await page.locator('[data-calendar-edit="W53"]').isDisabled()) ===
        (assignmentsBefore.approved_count === 0),
      'operator: Week 53 remains editable for its recurring assignment',
    )
    if (pickerImage) {
      await page.locator('[data-calendar-edit="W52"]').click()
      const chooser = page.getByRole('dialog', { name: 'Image for Week 52', exact: true })
      await chooser.getByRole('combobox', { name: 'Search approved images' }).waitFor()
      await expectImagePickerLayout(page, chooser, pickerImage, 'operator: date chooser')
      await page.setViewportSize({ width: 390, height: 844 })
      await expectImagePickerLayout(page, chooser, pickerImage, 'operator: narrow date chooser')
      await page.screenshot({ path: `${SHOTS}/admin-background-date-narrow.png` })
      await page.setViewportSize({ width: 1280, height: 820 })
      await chooser.getByRole('button', { name: 'Cancel', exact: true }).click()
      await chooser.waitFor({ state: 'detached' })
    }
    await page.screenshot({ path: `${SHOTS}/admin-background-calendar.png` })
    await expectPreviewSources(
      page.locator('[data-background-calendar]'),
      'operator: calendar thumbnails use compressed derivatives',
    )
    ok(
      backgroundRequests.every((url) => !originalUrls.has(url)),
      'operator: library, default chooser and both preview tabs never request a full-size background',
    )
    page.off('request', recordBackground)
    ok(
      JSON.stringify(await backgroundAssignments(page)) === JSON.stringify(assignmentsBefore),
      'operator: preview and calendar inspection preserve the default and every date assignment',
    )

    /* the audit trail shows what was just done */
    await page.click('nav >> text=Audit log')
    await page.getByRole('heading', { name: 'Audit log', exact: true }).waitFor({ timeout: 10000 })
    for (const label of [
      'Generated recovery link',
      'Created break-glass admin',
      'Banned sign-in',
      'Lifted sign-in ban',
    ]) {
      const seen = await page
        .waitForSelector(`td:has-text("${label}")`, { timeout: 10000 })
        .then(() => true)
        .catch(() => false)
      ok(seen, `operator: audit log shows "${label}"`)
    }
    await page.screenshot({ path: `${SHOTS}/admin-08-audit.png` })

    await page.click('nav >> text=Sign out')
    const signedOut = await page
      .waitForSelector('input[type=email]', { timeout: 15000 })
      .then(() => true)
      .catch(() => false)
    ok(signedOut, 'operator: sign out lands back on the sign-in form')
    ok(await appIsNora(appPage), 'isolation: operator sign-out preserves app Nora after reload')

    await signIn(page, EMAIL, PW)
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor({ timeout: 20000 })
    await appPage.evaluate(() => window.PLANNER.signOut())
    await appPage.locator('input[type=email]').waitFor({ timeout: 15000 })
    ok(true, 'isolation: app sign-out returns the app to its Sign in form')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor({ timeout: 20000 })
    ok(
      await page.evaluate(async (email) => {
        const { authClient } = await import('/src/admin/auth.ts')
        const { data } = await authClient.getSession()
        return !!data?.session && data.user.email === email
      }, EMAIL),
      'isolation: app sign-out preserves the operator session after admin reload',
    )
    await page.click('nav >> text=Sign out')
    await page.locator('input[type=email]').waitFor({ timeout: 15000 })
    ok(true, 'isolation: both surfaces finish signed out')

    ok(errors.length === 0, `operator: no console/page errors (${errors.length})`)
    if (errors.length) console.log(`ERRORS:\n${errors.slice(0, 10).join('\n---\n')}`)
    await ctx.close()
  }
} catch (e) {
  failures++
  console.error('FAIL browser drive:', e?.message || 'Unknown browser failure')
} finally {
  try {
    if (bgCreated) {
      await cleanupDemoArtifacts(browser, demo, { memberEmail: BG_EMAIL })
      console.log('cleanup: temporary break-glass member and login removed')
    }
    const after = await inspectBrowserDemo(demo)
    ok(
      JSON.stringify(before) === JSON.stringify(after),
      'Northstar counts and anchor preserved after the operator drive',
    )
  } catch (e) {
    failures++
    console.error('FAIL cleanup:', e?.message || 'Unknown cleanup failure')
  }
  await browser.close()
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)

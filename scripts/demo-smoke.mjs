/* Public Try workflow against an explicitly configured, isolated demo DEV
 * deployment. Never loads .env.local, seeds Northstar's shared fixture, or
 * uses a production key. See docs/verification.md for target configuration. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { chromium } from 'playwright'

export function demoSmokeConfiguration(env) {
  const browserOrigin = (value) => {
    const origin = new URL(value)
    if (
      origin.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new Error('The demo smoke requires a localhost development server origin.')
    return origin.origin
  }
  const base = browserOrigin(env.QIVO_DEMO_BASE_URL || 'http://localhost:5299')
  const browserBase = browserOrigin(env.QIVO_DEMO_BROWSER_URL || base)
  const url = env.QIVO_DEMO_CONVEX_URL
  const key = env.QIVO_DEMO_DEPLOY_KEY || ''
  const canvasFeed = () => {
    let feed
    try {
      feed = new URL(env.QIVO_DEMO_CANVAS_FEED_URL)
    } catch {
      throw new Error('Supply QIVO_DEMO_CANVAS_FEED_URL explicitly for the approved Canvas feed.')
    }
    if (!publicCanvasUrl(feed) || feed.pathname !== '/public/canvas' || feed.search || feed.hash)
      throw new Error('QIVO_DEMO_CANVAS_FEED_URL must name the exact public Canvas endpoint.')
    return feed.href
  }
  if (env.QIVO_DEMO_LOCAL === 'true') {
    const localOrigin = (value) => {
      const origin = new URL(value || 'https://missing.invalid')
      if (
        origin.protocol !== 'http:' ||
        !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
        origin.username ||
        origin.password ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash
      )
        throw new Error(
          'Local demo verification requires explicit loopback backend and site origins.',
        )
      return origin.origin
    }
    if (!key || /^(prod|preview|project):/.test(key))
      throw new Error('Supply the isolated local demo backend key explicitly.')
    return {
      base,
      browserBase,
      local: true,
      url: localOrigin(url),
      site: localOrigin(env.QIVO_DEMO_CONVEX_SITE_URL),
      key,
      canvasFeed: canvasFeed(),
    }
  }
  const match = url?.match(/^https:\/\/([a-z0-9-]+)\.convex\.cloud\/?$/)
  if (!match || !key.startsWith(`dev:${match[1]}|`) || !key.split('|')[1])
    throw new Error(
      'Set QIVO_DEMO_CONVEX_URL and the matching dedicated QIVO_DEMO_DEPLOY_KEY (dev key only).',
    )
  if (
    env.QIVO_DEMO_CONVEX_SITE_URL &&
    env.QIVO_DEMO_CONVEX_SITE_URL !== `https://${match[1]}.convex.site`
  )
    throw new Error('The demo site URL must belong to the selected cloud deployment.')
  return {
    base,
    browserBase,
    local: false,
    url: `https://${match[1]}.convex.cloud`,
    site: `https://${match[1]}.convex.site`,
    key,
    canvasFeed: canvasFeed(),
  }
}

function publicCanvasUrl(url) {
  return (
    !url.username &&
    !url.password &&
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
}

function validCanvasDate(date) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  )
}

/** Resolve the approved photo before any anonymous identities are created.
 * Only these exact public image URLs may cross the demo's normal boundary. */
export async function loadDemoSmokeCanvas(
  config,
  fetcher = fetch,
  date = new Date().toISOString().slice(0, 10),
) {
  assert.ok(validCanvasDate(date), 'Canvas verification needs a valid UTC date')
  const endpoint = new URL(config.canvasFeed)
  endpoint.searchParams.set('date', date)
  const response = await fetcher(endpoint.href, {
    credentials: 'omit',
    redirect: 'error',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(response.ok, true, 'The selected public Canvas feed must respond successfully')
  const image = await response.json()
  assert.ok(
    image && typeof image.id === 'string' && image.id && typeof image.image_url === 'string',
    'The selected public Canvas feed must provide an approved photo',
  )
  const imageUrls = [image.image_url, image.preview_url]
    .filter((value) => value !== null)
    .map((value) => {
      assert.equal(typeof value, 'string', 'Canvas image URLs must be explicit public URLs')
      const url = new URL(value)
      assert.ok(publicCanvasUrl(url) && !url.hash, 'Canvas image URLs must be public HTTP(S) URLs')
      return url.href
    })
  return { date, imageId: image.id, imageUrls }
}

export function demoSmokeCanvasRequestAllowed(config, value, method, canvas) {
  if (method !== 'GET' || !canvas) return false
  const request = new URL(value)
  if (!publicCanvasUrl(request) || request.hash) return false
  if (canvas.imageUrls.includes(request.href)) return true
  const feed = new URL(config.canvasFeed)
  const dates = request.searchParams.getAll('date')
  return (
    request.origin === feed.origin &&
    request.pathname === feed.pathname &&
    dates.length === 1 &&
    dates[0] === canvas.date &&
    validCanvasDate(dates[0]) &&
    [...request.searchParams.keys()].every((key) => key === 'date')
  )
}

/** Local app HTTP and WebSockets reach only Vite, catching exposed backend
 * ports. The public Canvas feed and its exact photo URLs are GET-only exceptions. */
export function demoSmokeRequestAllowed(config, value, method = 'GET', canvas = null) {
  const request = new URL(value)
  if (request.username || request.password) return false
  if (request.protocol === 'ws:') request.protocol = 'http:'
  if (request.protocol === 'wss:') request.protocol = 'https:'
  if (!['http:', 'https:'].includes(request.protocol)) return false
  return (
    (config.local ? [config.browserBase] : [config.browserBase, config.url, config.site]).includes(
      request.origin,
    ) || demoSmokeCanvasRequestAllowed(config, value, method, canvas)
  )
}

/** app.html already references Google Fonts. Keep those requests offline in
 * this drive; their deliberate suppression is separate from a transport leak. */
export function demoSmokeSuppressedFontRequest(value, method) {
  if (method !== 'GET') return false
  const request = new URL(value)
  if (request.username || request.password) return false
  return (
    (request.origin === 'https://fonts.googleapis.com' && request.pathname === '/css2') ||
    (request.origin === 'https://fonts.gstatic.com' &&
      /^\/s\/[^?]+\.(woff2?|ttf)$/.test(request.pathname))
  )
}

const inspectRef = makeFunctionReference('internal/demoTest:inspect')
const expireRef = makeFunctionReference('internal/demoTest:expireOwned')

function ownerIds(owner) {
  assert.ok(typeof owner.authUserId === 'string' && owner.authUserId, 'Missing demo auth identity')
  assert.ok(
    owner.orgId === undefined || owner.orgId === null || typeof owner.orgId === 'string',
    'Invalid demo org identity',
  )
  return { authUserId: owner.authUserId, ...(owner.orgId ? { orgId: owner.orgId } : {}) }
}

/** IDs only: an interrupted drive can resume cleanup without storing a login,
 * token or deployment key. Atomic replacement keeps the receipt readable. */
export function createDemoSmokeOwnerJournal(directory = '.local/demo-verification') {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, `owners-${randomUUID()}.json`)
  const owners = new Map()
  return {
    file,
    record(owner) {
      const ids = ownerIds(owner)
      const previous = owners.get(ids.authUserId)
      owners.set(ids.authUserId, { ...previous, ...ids })
      const temporary = `${file}.tmp`
      writeFileSync(temporary, JSON.stringify({ owners: [...owners.values()] }), {
        mode: 0o600,
        flag: 'wx',
      })
      renameSync(temporary, file)
    },
    remove() {
      rmSync(file, { force: true })
    },
  }
}

export function readDemoSmokeOwnerJournal(file, directory = '.local/demo-verification') {
  const name = basename(file)
  assert.ok(
    /^owners-[a-f0-9-]{36}\.json$/.test(name) && resolve(file) === resolve(directory, name),
    'Select an owners-<uuid>.json journal inside .local/demo-verification',
  )
  assert.equal(
    lstatSync(file).isSymbolicLink(),
    false,
    'Owner journal must be a regular local file',
  )
  const value = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(Array.isArray(value.owners) && value.owners.length, 'Owner journal must contain IDs')
  return value.owners.map(ownerIds)
}

function demoSmokeBackend(config) {
  const admin = new ConvexHttpClient(config.url, { logger: false })
  admin.setAdminAuth(config.key)
  const inspect = (owner) =>
    admin.query(inspectRef, {
      auth_user_id: owner?.authUserId || '',
      ...(owner?.orgId ? { org_id: owner.orgId } : {}),
      expected_site_url: config.base,
    })
  return {
    inspect,
    expire: (owner, delay = 1500) =>
      admin.mutation(expireRef, {
        auth_user_id: owner.authUserId,
        expected_site_url: config.base,
        delay_ms: delay,
      }),
    async waitGone(owner) {
      const deadline = Date.now() + 6 * 60_000
      while (Date.now() < deadline) {
        const state = await inspect(owner)
        if (!state.demoId && !state.authExists && !state.orgExists) return
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      throw new Error('Demo receipt, organization or temporary auth user survived cleanup')
    },
  }
}

function assertDemoPreflight(preflight) {
  assert.equal(preflight.mode, 'demo', 'Selected backend must explicitly run in demo mode')
  assert.equal(
    preflight.testControls,
    true,
    'Enable internal demo test controls on the dedicated dev deployment',
  )
}

export async function cleanupDemoSmokeOwnerJournal(env, file) {
  const config = demoSmokeConfiguration(env)
  const owners = readDemoSmokeOwnerJournal(file)
  const backend = demoSmokeBackend(config)
  assertDemoPreflight(await backend.inspect())
  await Promise.all(
    owners.map(async (owner) => {
      const state = await backend.inspect(owner)
      if (state.demoId && state.status !== 'deleting') await backend.expire(owner, 1000)
      await backend.waitGone(owner)
    }),
  )
  rmSync(file)
  console.log('[demo-smoke] PASS; captured owner journal fully cleaned up and removed')
}

function failureMessage(error) {
  if (!(error instanceof Error)) return 'Drive failed'
  return error.message
    .replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
      try {
        const url = new URL(value)
        return `${url.origin}${url.pathname}${url.search || url.hash ? '?[redacted]' : ''}`
      } catch {
        return '[URL redacted]'
      }
    })
    .replace(/\beyJ[A-Za-z0-9_.-]+/g, '[token redacted]')
}

export async function runDemoSmoke(env = process.env) {
  const config = demoSmokeConfiguration(env)
  const { inspect, expire, waitGone } = demoSmokeBackend(config)
  const preflight = await inspect()
  assertDemoPreflight(preflight)
  const admission = await new ConvexHttpClient(config.url, { logger: false }).query(
    'demo:configuration',
    {},
  )
  assert.equal(admission.admissionOpen, true, 'Demo admission must be open for the drive')
  const canvas = await loadDemoSmokeCanvas(config)

  const owners = new Map()
  const journal = createDemoSmokeOwnerJournal()
  const recordOwner = (owner) => {
    owners.set(owner.authUserId, owner)
    journal.record(owner)
  }
  const browser = await chromium.launch({ headless: true })
  const errors = []
  const creationIntent = new WeakSet()
  const anonymousRequests = new WeakMap()
  const shots = 'scripts/shots'
  mkdirSync(shots, { recursive: true })
  let pageA, pageB
  let failure
  const mark = (message) => console.log(`[demo-smoke] ${message}`)
  const browserError = (message) => {
    errors.push(message)
    mark(message)
  }
  mark(`Private cleanup journal: ${journal.file}`)
  async function pageIn(context) {
    context.on('request', (request) => {
      if (!new URL(request.url()).pathname.endsWith('/api/auth/sign-in/anonymous')) return
      const page = request.frame().page()
      anonymousRequests.set(page, (anonymousRequests.get(page) || 0) + 1)
      if (!creationIntent.has(page))
        browserError('Anonymous sign-in started before an explicit demo creation action')
    })
    // A misconfigured frontend may not allocate an identity on another
    // backend while the test is trying to diagnose its target mismatch.
    await context.route('**/*', (route) => {
      if (demoSmokeRequestAllowed(config, route.request().url(), route.request().method(), canvas))
        return route.continue()
      if (demoSmokeSuppressedFontRequest(route.request().url(), route.request().method()))
        return route.abort()
      const request = new URL(route.request().url())
      browserError(
        `Blocked ${route.request().method()} outside the demo boundary: ${request.origin}/${request.pathname.split('/')[1]}`,
      )
      return route.abort()
    })
    await context.routeWebSocket('**/*', (socket) => {
      if (demoSmokeRequestAllowed(config, socket.url())) return socket.connectToServer()
      const request = new URL(socket.url())
      browserError(
        `Blocked WebSocket outside the demo boundary: ${request.origin}/${request.pathname.split('/')[1]}`,
      )
      return socket.close()
    })
    const page = await context.newPage()
    page.on('pageerror', (error) =>
      browserError(`Uncaught browser error: ${failureMessage(error)}`),
    )
    return page
  }
  async function intro(page) {
    await page
      .getByRole('heading', { name: 'Explore Qivo in a private demo', exact: true })
      .waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Create demo workspace', exact: true }).waitFor()
    await page.getByText(/After 24 hours, Qivo automatically removes the demo/).waitFor()
    assert.equal(
      await page.getByRole('link', { name: 'Create a workspace', exact: true }).count(),
      0,
    )
    assert.equal(await page.locator('[data-demo-banner], [data-card]').count(), 0)
    const untouched = await page.evaluate(async () => {
      const { authClient } = await import('/src/lib/auth.ts')
      const session = await authClient.getSession({ query: { disableCookieCache: true } })
      return {
        error: session.error?.message || null,
        userId: session.data?.user.id || null,
        cookie: localStorage.getItem('qivo-demo_cookie'),
        marker: localStorage.getItem('qivo-demo-lifecycle-v1'),
        tasks: window.PLANNER?.issues.length || 0,
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }
    })
    assert.equal(untouched.error, null, 'The intro session check must reach the selected backend')
    assert.equal(untouched.userId, null, 'The intro must not allocate an anonymous identity')
    // An unauthenticated session check may persist an empty Better Auth jar.
    // Any cookie entry still fails, including a credential without a live session.
    assert.deepEqual(
      JSON.parse(untouched.cookie ?? '{}'),
      {},
      'The intro must not create a demo credential',
    )
    assert.equal(untouched.marker, null, 'The intro must not create a demo lifecycle receipt')
    assert.equal(untouched.tasks, 0, 'The intro must not load workspace data')
    assert.equal(
      anonymousRequests.get(page) || 0,
      0,
      'The intro must not request anonymous sign-in',
    )
    assert.ok(untouched.scroll <= untouched.width + 1, 'The intro must fit the viewport')
  }
  async function createDemo(page) {
    creationIntent.add(page)
    await page.getByRole('button', { name: 'Create demo workspace', exact: true }).click()
    return ready(page)
  }
  async function ready(page) {
    await page.locator('[data-demo-banner]').waitFor({ timeout: 45_000 })
    await page.waitForFunction(() => window.PLANNER?.loaded === true, { timeout: 30_000 })
    const owner = await page.evaluate(async () => {
      const { authClient } = await import('/src/lib/auth.ts')
      const { convex } = await import('/src/lib/convex.ts')
      const { configuredConvexDeploymentUrl } = await import('/src/lib/backendUrl.ts')
      const { demoCanvasFeedUrl } = await import('/src/lib/demoCanvas.ts')
      const session = await authClient.getSession()
      const current = await convex.query('demo:current', {})
      return {
        ...current,
        authUserId: session.data?.user.id,
        backend: convex.client.url,
        configuredBackend: configuredConvexDeploymentUrl(),
        canvasFeed: demoCanvasFeedUrl(),
      }
    })
    if (owner.authUserId) recordOwner(owner)
    assert.equal(
      owner.backend,
      config.local ? `${config.browserBase}/__qivo_convex` : config.url,
      'Frontend must use the explicitly selected demo backend',
    )
    assert.equal(
      owner.configuredBackend,
      config.url,
      'Frontend proxy must target the explicitly selected demo backend',
    )
    assert.equal(owner.status, 'ready')
    assert.ok(owner.authUserId && owner.orgId && owner.orgSlug)
    assert.equal(owner.canvasFeed, config.canvasFeed, 'Frontend must use the selected Canvas feed')
    const preferences = await page.evaluate(async () => {
      const { convex } = await import('/src/lib/convex.ts')
      return convex.query('appearance:get', {})
    })
    assert.equal(preferences.mode, 'blue', 'A new demo must default to the Blue theme')
    assert.equal(preferences.image_source, 'daily', 'A new demo must use the shared weekly photo')
    await page.waitForFunction(
      (imageUrls) => {
        const image = document.querySelector('[data-appearance-background]')
        return (
          document.documentElement.dataset.appearance === 'blue' &&
          document.documentElement.dataset.backgroundState === 'ready' &&
          image?.complete &&
          image.naturalWidth > 0 &&
          imageUrls.includes(image.currentSrc || image.src)
        )
      },
      canvas.imageUrls,
      { timeout: 30_000 },
    )
    const background = await page.evaluate(async () => {
      const image = document.querySelector('[data-appearance-background]')
      // A decoded full image can replace this preview while decode() resolves.
      // Capture its selection date before React detaches the previous <img>.
      const date = image.parentElement.dataset.backgroundDate
      await image.decode()
      return {
        url: image.currentSrc || image.src,
        width: image.naturalWidth,
        height: image.naturalHeight,
        date,
      }
    })
    assert.ok(canvas.imageUrls.includes(background.url), 'Canvas must display the selected photo')
    assert.ok(background.width > 0 && background.height > 0, 'Canvas photo must decode completely')
    assert.equal(background.date, canvas.date, 'Canvas must use the prefetched UTC selection date')
    return owner
  }
  async function assertExpiredScreen(page) {
    creationIntent.delete(page)
    await page
      .getByRole('heading', { name: 'Your demo has expired.', exact: true })
      .waitFor({ timeout: 45_000 })
    assert.equal(await page.locator('[data-demo-banner], [data-card]').count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).count(), 1)
    assert.equal(
      await page.getByRole('link', { name: 'Create a workspace', exact: true }).count(),
      0,
    )
    const cached = await page.evaluate(() => ({
      cookie: localStorage.getItem('qivo-demo_cookie'),
      marker: JSON.parse(localStorage.getItem('qivo-demo-lifecycle-v1') || 'null'),
      tasks: window.PLANNER?.issues.length || 0,
    }))
    assert.equal(cached.cookie, null, 'Expired browser must discard its demo credential')
    assert.equal(cached.marker?.state, 'expired')
    assert.equal(cached.tasks, 0, 'Expired browser must discard its cached tasks')
  }

  try {
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const contextB = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    })
    pageA = await pageIn(contextA)
    pageB = await pageIn(contextB)
    await Promise.all([pageA.goto(config.browserBase), pageB.goto(config.browserBase)])
    await Promise.all([intro(pageA), intro(pageB)])
    await pageA.screenshot({ path: `${shots}/demo-smoke-intro.png` })
    await pageB.screenshot({ path: `${shots}/demo-smoke-intro-phone.png` })
    await pageA.reload()
    await intro(pageA)
    mark('Desktop and phone explain the 24-hour demo without creating a login or workspace')
    const [ownerA, ownerB] = await Promise.all([createDemo(pageA), createDemo(pageB)])
    assert.notEqual(ownerA.authUserId, ownerB.authUserId)
    assert.notEqual(ownerA.orgId, ownerB.orgId)
    assert.notEqual(ownerA.orgSlug, ownerB.orgSlug)
    mark(
      'Create demo workspace signed both visitors in to separate private Northstar copies with the approved Canvas photo',
    )

    const mobile = await pageB.evaluate(() => {
      const banner = document.querySelector('[data-demo-banner]').getBoundingClientRect()
      return {
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        bannerWidth: banner.width,
        bannerHeight: banner.height,
      }
    })
    assert.ok(mobile.scroll <= mobile.width + 1, 'Phone viewport must not scroll sideways')
    assert.ok(
      mobile.bannerWidth <= mobile.width && mobile.bannerHeight < 90,
      'Phone demo banner must fit the header',
    )
    await pageB.screenshot({ path: `${shots}/demo-smoke-phone.png` })

    await pageA.locator('aside').getByText('Luma Sensor', { exact: true }).click()
    // the top bar carries no New task button (deviation #233): a status
    // column's + opens the same dialog
    await pageA
      .getByRole('button', { name: /^New task in / })
      .first()
      .click()
    const dialog = pageA.getByRole('dialog', { name: 'New task', exact: true })
    const title = `Private demo smoke ${randomUUID().slice(0, 8)}`
    await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await pageA.waitForFunction(
      (title) => window.PLANNER.issues.some((task) => task.title === title),
      title,
    )
    const task = await pageA.evaluate((title) => {
      const task = window.PLANNER.issues.find((item) => item.title === title)
      return { id: task.id, uuid: task.uuid, key: task.key }
    }, title)
    assert.ok(task.uuid && task.key, 'Created task must provide its own UUID and QN reference')
    await dialog.waitFor({ state: 'detached' })
    await pageA.locator('[data-issue-key]').first().waitFor()
    assert.equal(
      (await pageA.locator('[data-issue-key]').first().textContent()).trim(),
      task.key,
      'Create must open the new task in its normal task window',
    )
    assert.ok(
      pageA.url().toLowerCase().includes(`/tasks/${task.key.toLowerCase()}`),
      'Create must navigate to the new task URL',
    )
    const bytes = Buffer.from('A file stored only in visitor A’s private demo.\n')
    const filename = `demo-smoke-${randomUUID().slice(0, 8)}.txt`
    await pageA.setInputFiles('input[type="file"][multiple]', {
      name: filename,
      mimeType: 'text/plain',
      buffer: bytes,
    })
    await pageA.locator(`button[data-attachment-open="${filename}"]`).waitFor({ timeout: 30_000 })
    const file = await pageA.evaluate(async (uuid) => {
      const task = window.PLANNER.issues.find((item) => item.uuid === uuid)
      const attachment = task.attachments[0]
      const url = await window.PLANNER.attachmentUrl(attachment.id)
      const response = await fetch(url)
      return { url, status: response.status, text: await response.text() }
    }, task.uuid)
    assert.equal(file.status, 200)
    assert.equal(file.text, bytes.toString())

    await pageA.evaluate(async () => {
      const { convex } = await import('/src/lib/convex.ts')
      await convex.mutation('profiles:setDisplayName', { name: 'Demo visitor A' })
      await convex.mutation('profiles:setMessageRetention', { days: 14 })
    })
    const isolation = await pageB.evaluate(
      async ({ orgId, taskId, title }) => {
        const { convex } = await import('/src/lib/convex.ts')
        const snapshot = await convex.query('snapshot:forMe', {})
        let refusal = null
        try {
          await convex.mutation('issues:update', {
            org_id: orgId,
            id: taskId,
            patch: { title: 'Cross-demo overwrite' },
          })
        } catch (error) {
          refusal = error.data
        }
        const me = snapshot.profiles.find((profile) => snapshot.myProfileIds.includes(profile.id))
        return {
          containsTask: snapshot.issues.some((task) => task.title === title),
          name: me.name,
          retention: me.message_retention_days,
          refusal,
        }
      },
      { orgId: ownerA.orgId, taskId: task.uuid, title },
    )
    assert.equal(isolation.containsTask, false)
    assert.notEqual(isolation.name, 'Demo visitor A')
    assert.notEqual(isolation.retention, 14)
    assert.equal(
      isolation.refusal?.code,
      'forbidden',
      'Cross-demo edit must receive a typed refusal',
    )
    mark(
      'Task creation, private upload and personal edits remain isolated; cross-demo write refused',
    )

    await pageA.reload()
    const resumed = await ready(pageA)
    assert.equal(resumed.orgId, ownerA.orgId)
    assert.equal(resumed.expiresAt, ownerA.expiresAt, 'Reload must not extend the fixed deadline')
    assert.equal(await pageA.locator('[data-issue-key]').first().textContent(), task.key)
    await pageA.screenshot({ path: `${shots}/demo-smoke-task.png` })

    // Visit B closes every tab before expiration; the same browser context
    // retains only its original local storage for the later return visit.
    const shortened = await expire(ownerB, 10_000)
    await pageB.waitForFunction(
      (expiresAt) =>
        JSON.parse(localStorage.getItem('qivo-demo-lifecycle-v1') || 'null')?.expiresAt ===
        expiresAt,
      shortened.expiresAt,
    )
    await pageB.close()

    // Visit A remains open with an unsaved dialog, proving expiration unmounts
    // drafts and cached content without a final save or a user gesture.
    await pageA.keyboard.press('Escape')
    await pageA
      .getByRole('button', { name: /^New task in / })
      .first()
      .click()
    const abandonedDraft = 'Unsaved private demo draft'
    await pageA
      .getByRole('dialog', { name: 'New task', exact: true })
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill(abandonedDraft)
    await expire(ownerA)
    await assertExpiredScreen(pageA)
    assert.equal(
      await pageA.getByRole('dialog').count(),
      0,
      'Expiry must discard the open draft dialog',
    )
    mark(
      'Both demos have reached their test deadline; waiting for bounded file and account cleanup',
    )
    await Promise.all([waitGone(ownerA), waitGone(ownerB)])
    pageB = await contextB.newPage()
    await pageB.goto(config.browserBase)
    await assertExpiredScreen(pageB)
    await pageB.reload()
    await assertExpiredScreen(pageB)
    mark('Closed-browser deletion completed; return and reload require explicit Try again')
    const expiredFile = await fetch(file.url)
    assert.ok(
      [401, 403, 404].includes(expiredFile.status),
      'An old file URL must stop serving bytes',
    )
    await pageA.reload()
    await assertExpiredScreen(pageA)
    creationIntent.add(pageA)
    await pageA.getByRole('button', { name: 'Try again', exact: true }).click()
    const replacement = await ready(pageA)
    assert.notEqual(replacement.authUserId, ownerA.authUserId)
    assert.notEqual(replacement.orgId, ownerA.orgId)
    assert.equal(
      await pageA.evaluate(
        (title) => window.PLANNER.issues.some((task) => task.title === title),
        title,
      ),
      false,
    )
    assert.equal(errors.length, 0, `No browser errors or escaped requests:\n${errors.join('\n')}`)
    mark(
      'Live expiry cleared the workspace and file access; Try again created a fresh private copy',
    )
  } catch (error) {
    failure = error
    mark(`Browser checks failed: ${failureMessage(error)}; cleaning up private demos`)
    await pageA?.screenshot({ path: `${shots}/demo-smoke-failure-a.png` }).catch(() => {})
    await pageB?.screenshot({ path: `${shots}/demo-smoke-failure-b.png` }).catch(() => {})
  } finally {
    // Capture a login even if startup failed before its workspace banner
    // appeared. This is read-only and never creates a replacement identity.
    for (const page of [pageA, pageB]) {
      if (!page || page.isClosed()) continue
      try {
        const owner = await page.evaluate(async () => {
          const { authClient } = await import('/src/lib/auth.ts')
          const session = await authClient.getSession()
          return session.data?.user.id ? { authUserId: session.data.user.id } : null
        })
        if (owner && !owners.has(owner.authUserId)) recordOwner(owner)
      } catch {
        /* Backend receipts also retain their automatic 24-hour job. */
      }
    }
    await browser.close()
    // Only identities captured from this drive are expired. The backend
    // performs its real bounded purge; no shared seed/reset path is invoked.
    const capturedOwners = [...owners.values()]
    let cleanupComplete = true
    await Promise.all(
      capturedOwners.map(async (owner) => {
        try {
          const state = await inspect(owner)
          if (state.demoId && state.status !== 'deleting') await expire(owner, 1000)
        } catch {
          cleanupComplete = false
          failure ??= new Error('Could not expire one of this drive’s private demos')
        }
      }),
    )
    await Promise.all(
      capturedOwners.map(async (owner) => {
        try {
          await waitGone(owner)
        } catch {
          cleanupComplete = false
          failure ??= new Error('Could not verify cleanup for one of this drive’s private demos')
        }
      }),
    )
    if (cleanupComplete) journal.remove()
    else mark(`Cleanup can be resumed from ${journal.file}`)
  }
  if (failure) throw failure
  mark('PASS; all private demos created by this drive were removed')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const operation =
    args.length === 0
      ? runDemoSmoke()
      : args.length === 2 && args[0] === '--cleanup-owner-journal'
        ? cleanupDemoSmokeOwnerJournal(process.env, args[1])
        : Promise.reject(new Error('Usage: demo-smoke.mjs [--cleanup-owner-journal <file>]'))
  operation.catch((error) => {
    console.error(`[demo-smoke] ${failureMessage(error)}`)
    process.exitCode = 1
  })
}

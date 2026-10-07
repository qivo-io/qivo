/* Thin durable browser smoke against the dev server + Convex backend.
   Usage: node scripts/smoke.mjs [baseURL]     (default http://localhost:5199)
   Assumes `npm run dev` (convex dev + vite 5199) is already up — does NOT
   start vite. Two contexts: A (Nora, Northstar admin) signs in, creates an
   issue through the real New-task dialog, uploads an attachment through the
   Attachments drawer, and proves the minted /files/ URL serves the exact
   bytes; B (Leo, project lead) watches the issue arrive and leave WITHOUT
   reloading (realtime + fire-and-forget delete ordering). Cleanup deletes the
   smoke issue. A Team sync leg then edits the Remaining of a second
   temporary task, held by a temporary agent, from the agents step (the edit
   stamps only that agent) and deletes both; both contexts sign out.
   Auto-fail on any console/page output
   matching /saving is disabled|uploads are disabled/i, any uncaught page
   exception, or the old disabled copy in the DOM. Exits non-zero on the
   first failure. Screenshots land in scripts/shots/. */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import zlib from 'node:zlib'
import { strFromU8, unzipSync } from 'fflate'
import { chromium } from 'playwright'
import {
  cleanupDemoArtifacts,
  inspectBrowserDemo,
  loadBrowserDemo,
  signInDemo,
} from './browser-demo.mjs'

const demo = loadBrowserDemo(process.argv[2] ?? 'http://localhost:5199')
const BASE = demo.base
const before = await inspectBrowserDemo(demo)
const SHOTS = 'scripts/shots'
mkdirSync(SHOTS, { recursive: true })

const STAMP = randomUUID().slice(0, 8)
const TITLE = `Smoke ${STAMP}`
const PNG_NAME = `smoke-${STAMP}.png`
const AGENT_KEY_NAME = `Smoke key ${STAMP}`
const SYNC_AGENT = `Smoke agent ${STAMP}`

// ---- deterministic small PNG (16x16 opaque red, < 16 KiB so compressImage's
// MIN_BYTES floor passes it through BYTE-IDENTICAL — known exact size e2e)
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const makePng = (w, h) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2 // 8-bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3)
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = 0xc8
    } // red
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const PNG = makePng(16, 16)

const log = (...a) => console.log('[smoke]', ...a)
let browser, pageA, pageB
const fail = async (msg) => {
  throw new Error(msg)
}
let passed = false
let appearanceBefore = null
let appearanceNeedsRestore = false

browser = await chromium.launch({ headless: true })

// -- console/error capture. Expected network-failure fixtures can log console
// errors, but disabled copies and every uncaught page exception fail the drive.
const badLogs = []
const BAD = /saving is disabled|uploads are disabled/i
const wire = (page, tag) => {
  page.on('console', (m) => {
    const t = m.text()
    if (m.type() === 'error' || m.type() === 'warning')
      console.log(`[${tag} console.${m.type()}]`, t.slice(0, 300))
    if (BAD.test(t)) badLogs.push(`${tag} console: ${t}`)
  })
  page.on('pageerror', (e) => {
    const t = String(e)
    console.log(`[${tag} pageerror]`, t.slice(0, 300))
    badLogs.push(`${tag} pageerror: ${t}`)
  })
}
const noDisabledCopy = async (page, where) => {
  for (const s of ['saving is disabled', 'file uploads are disabled']) {
    const n = await page.locator(`text=${s}`).count()
    if (n) await fail(`the old disabled copy "${s}" is on screen (${where})`)
  }
}

// Injected into Vite's real Convex singleton for this one reload. Auth and
// backend requests remain live; hold selected deliveries to inspect startup.
function deferWorkspaceBoot(convex, { appearance = false } = {}) {
  const originalUpdate = convex.onUpdate
  const originalQuery = convex.query
  let holdSnapshot = true
  let holdPrefs = true
  let holdAppearance = appearance
  const snapshots = []
  const prefs = []
  const appearances = []
  const name = (reference) =>
    typeof reference === 'string' ? reference : reference[Symbol.for('functionName')]
  const gate = {
    snapshotHeld: false,
    prefsHeld: false,
    appearanceHeld: false,
    releaseSnapshot() {
      holdSnapshot = false
      for (const deliver of snapshots.splice(0)) deliver()
    },
    releasePrefs() {
      holdPrefs = false
      for (const release of prefs.splice(0)) release()
    },
    releaseAppearance() {
      holdAppearance = false
      for (const deliver of appearances.splice(0)) deliver()
    },
    restore() {
      convex.onUpdate = originalUpdate
      convex.query = originalQuery
      gate.releaseSnapshot()
      gate.releasePrefs()
      gate.releaseAppearance()
    },
  }
  convex.onUpdate = (query, args, receive, onError) => {
    const snapshot = name(query) === 'snapshot:forMe'
    const appearance = name(query) === 'appearance:get'
    if (!snapshot && !appearance) return originalUpdate.call(convex, query, args, receive, onError)
    let active = true
    const unsubscribe = originalUpdate.call(
      convex,
      query,
      args,
      (value) => {
        if (!(snapshot ? holdSnapshot : holdAppearance)) return receive(value)
        gate[snapshot ? 'snapshotHeld' : 'appearanceHeld'] = true
        const pending = snapshot ? snapshots : appearances
        pending.push(() => {
          if (active) receive(value)
        })
      },
      onError,
    )
    return () => {
      active = false
      unsubscribe()
    }
  }
  convex.query = async (...args) => {
    const result = await originalQuery.apply(convex, args)
    if (name(args[0]) === 'prefs:get' && holdPrefs) {
      gate.prefsHeld = true
      await new Promise((resolve) => prefs.push(resolve))
    }
    if (name(args[0]) === 'appearance:get' && holdAppearance) {
      gate.appearanceHeld = true
      await new Promise((resolve) => appearances.push(resolve))
    }
    return result
  }
  window.__smokeWorkspaceBoot = gate
}

// These drives keep the real account's upload intact. Only the browser's
// cached copy is cleared to exercise network failures and cold startup.
async function storedBackground({ clear = false } = {}) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('qivo-background-image', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('current')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('current', clear ? 'readwrite' : 'readonly')
      const store = transaction.objectStore('current')
      const request = clear ? store.clear() : store.get('image')
      transaction.oncomplete = () => {
        const value = request.result
        resolve({
          key: value?.selection?.key,
          preview: value?.preview instanceof Blob && value.preview.size > 0,
          full: value?.full instanceof Blob && value.full.size > 0,
        })
      }
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

async function checkCompressedCanvas(page) {
  const fixture = await page.evaluate(async () => {
    const { convex } = await import('/src/lib/convex.ts')
    const { custom_image } = await convex.query('appearance:get', {})
    return custom_image
  })
  if (!fixture) {
    log('SKIP: no existing custom background for full-resolution loading checks')
    return
  }
  if (!fixture.preview_ready)
    await fail('The existing custom background needs its preview backfilled before this drive')

  const fullPath = `/backgrounds/${fixture.id}`
  const previewPath = `/background-previews/${fixture.id}`
  const matchesFull = (url) => url.pathname === fullPath
  const matchesConvex = (url) => url.pathname === '/src/lib/convex.ts'
  const held = []
  const requests = []
  let delivery = 'hold'
  let deferAppearance = false
  let recording = false
  const beginRecording = (frame) => {
    if (frame === page.mainFrame()) recording = true
  }
  const record = (request) => {
    if (!recording) return
    const path = new URL(request.url()).pathname
    if (path.startsWith('/backgrounds/') || path.startsWith('/background-previews/'))
      requests.push(path)
  }
  const serveFull = async (route) => {
    if (delivery === 'hold') held.push(route)
    else if (delivery === 'fail') await route.abort('failed')
    else await route.continue()
  }
  const delayBoot = async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      body: `${await response.text()}\n;(${deferWorkspaceBoot.toString()})(convex, { appearance: ${deferAppearance} });`,
    })
  }
  const waitForQuality = (quality) =>
    page.waitForFunction(
      (quality) => {
        const image = document.querySelector('[data-appearance-background]')
        return image?.dataset.backgroundQuality === quality && image.naturalWidth > 0
      },
      quality,
      { timeout: 20000 },
    )
  const waitForStored = async (full = false) => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const value = await page.evaluate(storedBackground)
      if (value.key === `custom:${fixture.id}` && (full ? value.full : value.preview)) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await fail('Canvas did not persist its decoded background bytes for the next visit')
  }
  const coldCache = () => page.evaluate(storedBackground, { clear: true })
  await waitForQuality('full')
  await waitForStored(true)
  await coldCache()
  // Settings can still finish minting its thumbnail URL on the outgoing
  // page. Count only requests from the new document when checking startup.
  page.on('framenavigated', beginRecording)
  page.on('request', record)
  // Routing disables the HTTP cache. Cold-start scenarios also clear the app's
  // persistent byte cache; warm-start scenarios must reuse it without a fetch.
  await page.route(matchesFull, serveFull)
  await page.route(matchesConvex, delayBoot)
  try {
    const fullRequested = page
      .waitForRequest((request) => new URL(request.url()).pathname === fullPath)
      .catch(() => null)
    await page.reload({ waitUntil: 'domcontentloaded' })
    page.off('framenavigated', beginRecording)
    if (!(await fullRequested))
      await fail('Canvas did not request the full-size image during workspace startup')
    await page.waitForFunction(() => window.__smokeWorkspaceBoot?.snapshotHeld)
    if (held.length === 0) await fail('The cold-start fixture did not hold the original request')
    const loading = page.locator('[data-workspace-loading]')
    await loading.waitFor()
    const loadingPaint = await loading.evaluate((status) => ({
      card: status.parentElement.innerText,
      shellColor: getComputedStyle(status.parentElement.parentElement).backgroundColor,
      loaded: window.PLANNER.loaded,
      backgrounds: Array.from(
        document.querySelectorAll('[data-appearance-background]'),
        (image) => ({
          quality: image.dataset.backgroundQuality,
          restored: image.dataset.backgroundRestored === 'true',
          width: image.naturalWidth,
        }),
      ),
    }))
    const startupFailures = [
      loadingPaint.loaded && 'workspace loaded before its held snapshot',
      !loadingPaint.card.includes('qivo') && 'Qivo loading card missing',
      loadingPaint.shellColor !== 'rgba(0, 0, 0, 0)' && 'loading shell is opaque',
      requests.includes(previewPath) && 'preview requested before the original finished',
      loadingPaint.backgrounds.length > 0 && 'background displayed while the original is held',
    ].filter(Boolean)
    if (startupFailures.length)
      await fail(
        `Workspace startup failed: ${startupFailures.join('; ')}. ${JSON.stringify({
          paint: loadingPaint,
          requests,
        })}`,
      )
    delivery = 'pass'
    await Promise.all(held.splice(0).map((route) => route.continue()))
    await waitForQuality('full')
    const startupImage = await page.locator('[data-appearance-background]').elementHandle()
    const startupSrc = await startupImage.getAttribute('src')
    await startupImage.evaluate((image) => image.decode())
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    const coversViewport = await startupImage.evaluate((image, width) => {
      const rect = image.getBoundingClientRect()
      return (
        image.naturalWidth === width &&
        rect.x === 0 &&
        rect.y === 0 &&
        rect.width >= innerWidth &&
        rect.height >= innerHeight
      )
    }, fixture.width)
    if (!coversViewport || !(await loading.isVisible()) || requests.includes(previewPath))
      await fail('The full-size startup background did not cover the loading screen directly')
    const startupMaterial = await loading.evaluate((element) => {
      const card = element.closest('[data-floating-surface]')
      if (!card) return null
      const style = getComputedStyle(card)
      return { background: style.backgroundColor, blur: style.backdropFilter }
    })
    if (
      startupMaterial?.background !== 'rgba(16, 26, 36, 0.81)' ||
      startupMaterial?.blur !== 'blur(10px)'
    )
      await fail('The startup card does not use the translucent Blue window material')
    await page.screenshot({ path: `${SHOTS}/smoke-loading-full.png` })
    await page.evaluate(() => window.__smokeWorkspaceBoot.releaseSnapshot())
    await page.waitForFunction(() => window.__smokeWorkspaceBoot.prefsHeld)
    if (!(await loading.isVisible()))
      await fail('Workspace startup ended before saved preferences arrived')
    await page.evaluate(() => window.__smokeWorkspaceBoot.releasePrefs())
    await loading.waitFor({ state: 'detached', timeout: 10000 })
    if (
      !(await startupImage.evaluate(
        (image, source) =>
          image.isConnected &&
          image === document.querySelector('[data-appearance-background]') &&
          image.getAttribute('src') === source &&
          image.dataset.backgroundQuality === 'full',
        startupSrc,
      ))
    )
      await fail('Workspace startup replaced the full-size background during the app handoff')
    await startupImage.dispose()
    await page.evaluate(() => window.__smokeWorkspaceBoot.restore())
    await page.unroute(matchesConvex, delayBoot)
    log('A: the original stays behind the Qivo loading card through workspace handoff')
    const thumbnail = page.locator('[data-appearance-preview]')
    await thumbnail.waitFor({ timeout: 20000 })
    const thumbnailImage = await thumbnail.evaluate(async (image) => {
      await image.decode()
      return { width: image.naturalWidth }
    })
    const backgroundImage = await page
      .locator('[data-appearance-background]')
      .evaluate((image) => ({
        source: image.currentSrc,
        width: image.naturalWidth,
        quality: image.dataset.backgroundQuality,
      }))
    if (
      thumbnailImage.width === 0 ||
      thumbnailImage.width > 960 ||
      backgroundImage.width !== fixture.width ||
      backgroundImage.quality !== 'full' ||
      !backgroundImage.source.startsWith('blob:') ||
      !requests.includes(previewPath)
    )
      await fail('Settings did not use the compressed preview while Canvas used the original')
    delivery = 'pass'
    log('A: settings uses a compressed thumbnail; Canvas paints the original directly')

    // After authentication, a warm visit restores the cached original before
    // appearance metadata arrives and reuses its bytes without a network fetch.
    await waitForStored(true)
    deferAppearance = true
    delivery = 'hold'
    await page.route(matchesConvex, delayBoot)
    const warmRequestCount = requests.length
    await page.goto(`${BASE}/app/${demo.orgSlug}/board/all`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__smokeWorkspaceBoot?.appearanceHeld)
    await waitForQuality('full')
    const restoredFull = page.locator(
      '[data-appearance-background][data-background-restored="true"]',
    )
    await restoredFull.waitFor()
    if (
      !(await page.locator('[data-workspace-loading]').isVisible()) ||
      requests.length !== warmRequestCount ||
      !(await restoredFull.getAttribute('src')).startsWith('blob:')
    )
      await fail(
        'Warm startup did not restore the cached original before current appearance arrived',
      )
    await page.evaluate(() => window.__smokeWorkspaceBoot.releaseAppearance())
    await page.waitForFunction(() => window.__smokeWorkspaceBoot.snapshotHeld)
    await page.evaluate(() => window.__smokeWorkspaceBoot.releaseSnapshot())
    await page.waitForFunction(() => window.__smokeWorkspaceBoot.prefsHeld)
    await page.evaluate(() => window.__smokeWorkspaceBoot.releasePrefs())
    await page.locator('[data-all-nav]').waitFor({ timeout: 30000 })
    await waitForQuality('full')
    if (requests.length !== warmRequestCount || held.length)
      await fail('Warm Canvas downloaded unchanged background bytes again')
    await page.evaluate(() => window.__smokeWorkspaceBoot.restore())
    await page.unroute(matchesConvex, delayBoot)
    deferAppearance = false
    log('A: warm Canvas restores its cached original before appearance metadata')

    await coldCache()
    delivery = 'fail'
    const fullFailed = page
      .waitForEvent('requestfailed', {
        predicate: (request) => new URL(request.url()).pathname === fullPath,
      })
      .catch(() => null)
    await page.reload({ waitUntil: 'domcontentloaded' })
    if (!(await fullFailed)) await fail('The full-size failure fixture did not intercept a request')
    await waitForQuality('preview')
    if (
      (await page
        .locator('[data-appearance-background]')
        .evaluate((image) => image.naturalWidth)) !== thumbnailImage.width
    )
      await fail('Canvas did not use its compressed fallback when the original failed')
    log('A: Canvas uses the compressed fallback when the original cannot load')

    // A full-size request may be slow without blocking workspace access. Hold
    // it so only the startup time limit can reveal the app, then allow the
    // compressed derivative to serve as the documented failure fallback.
    await waitForStored()
    await coldCache()
    delivery = 'hold'
    await page.route(matchesConvex, delayBoot)
    const slowStart = requests.length
    const slowFullRequested = page
      .waitForRequest((request) => new URL(request.url()).pathname === fullPath)
      .catch(() => null)
    await page.goto(`${BASE}/app/${demo.orgSlug}/board/all`, { waitUntil: 'domcontentloaded' })
    if (!(await slowFullRequested))
      await fail('The slow-original fixture did not receive a full-size request')
    await page.waitForFunction(() => window.__smokeWorkspaceBoot?.snapshotHeld)
    await page.evaluate(() => window.__smokeWorkspaceBoot.releaseSnapshot())
    await page.waitForFunction(() => window.__smokeWorkspaceBoot.prefsHeld)
    await page.evaluate(() => window.__smokeWorkspaceBoot.releasePrefs())
    await page.waitForFunction(() => window.PLANNER?.loaded, null, { timeout: 30000 })
    const workspaceReadyAt = Date.now()
    await page.locator('[data-all-nav]').waitFor({ timeout: 4500 })
    if (
      Date.now() - workspaceReadyAt > 4500 ||
      !held.length ||
      requests.slice(slowStart).includes(previewPath) ||
      (await page.locator('[data-appearance-background]').count()) ||
      (await page.locator('[data-workspace-loading]').count())
    )
      await fail('Slow background requests blocked the workspace after planner readiness')
    await page.evaluate(() => window.__smokeWorkspaceBoot.restore())
    await page.unroute(matchesConvex, delayBoot)
    delivery = 'fail'
    await Promise.all(held.splice(0).map((route) => route.abort('failed')))
    await waitForQuality('preview')
    log('A: the workspace opens as soon as planner data is ready while the original is held')

    // The planner has no settings thumbnail. Every theme paints the custom
    // image: switching theme keeps the painted image with no new request.
    const themeImage = await page.locator('[data-appearance-background]').elementHandle()
    const themeRequests = requests.length
    for (const mode of ['dark', 'light', 'blue']) {
      await page.evaluate(
        (mode) => window.PLANNER.setAppearance({ mode, image_source: 'custom' }),
        mode,
      )
      await page.waitForFunction(
        (mode) => document.documentElement.dataset.appearance === mode,
        mode,
      )
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
      if (
        requests.length !== themeRequests ||
        !(await themeImage.evaluate(
          (image) =>
            image === document.querySelector('[data-appearance-background]') &&
            document.documentElement.dataset.backgroundState === 'ready',
        ))
      )
        await fail(`${mode} replaced or requested the custom background image again`)
    }
    await themeImage.dispose()
    const preserved = await page.evaluate(async (id) => {
      const { convex } = await import('/src/lib/convex.ts')
      return (await convex.query('appearance:get', {})).custom_image?.id === id
    }, fixture.id)
    if (!preserved) await fail('Appearance checks changed the existing custom upload')
    // Later legs need a fresh document without the startup gate's patched
    // convex module, with the original served normally again.
    delivery = 'pass'
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('[data-all-nav]').waitFor({ timeout: 30000 })
    log('A: every theme keeps the painted custom image without a request and preserves the upload')
  } finally {
    delivery = 'pass'
    await page.evaluate(() => window.__smokeWorkspaceBoot?.restore()).catch(() => {})
    await Promise.all(held.splice(0).map((route) => route.abort().catch(() => {})))
    await page.unroute(matchesFull, serveFull)
    await page.unroute(matchesConvex, delayBoot)
    page.off('framenavigated', beginRecording)
    page.off('request', record)
  }
}

const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } })
pageA = await ctxA.newPage()
pageB = await ctxB.newPage()
wire(pageA, 'A')
wire(pageB, 'B')

try {
  // The website's account links open /app#signup. Check that address and
  // both toggle directions without registering another account.
  await pageA.goto(`${BASE}/app#signup`, { waitUntil: 'domcontentloaded' })
  await pageA
    .getByRole('button', { name: 'Create account', exact: true })
    .waitFor({ timeout: 20000 })
  await pageA.locator('[data-auth-toggle]').click()
  await pageA.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
  await pageA.getByRole('button', { name: 'Create an account', exact: true }).click()
  await pageA.getByRole('button', { name: 'Create account', exact: true }).waitFor()
  log('The signup address and sign-in offer account creation without registering a test account')

  // ---- 1. context A signs in as Nora
  await signInDemo(pageA, demo, 'nora')
  await pageA.waitForSelector('text=Northstar Labs', { timeout: 10000 })
  log('A: Nora signed in — Northstar Labs board renders')

  // A failed on-demand view keeps the running workspace and safe reload controls.
  const recoveryPage = await ctxA.newPage()
  wire(recoveryPage, 'route recovery')
  const settingsModule = '**/src/panels/Settings.tsx*'
  try {
    await recoveryPage.route(settingsModule, (route) => route.abort('failed'))
    await recoveryPage.goto(`${BASE}/app/${demo.orgSlug}/board/all`, {
      waitUntil: 'domcontentloaded',
    })
    await recoveryPage.locator('[data-filter-focus]').waitFor({ timeout: 30000 })
    await recoveryPage.evaluate(async () => {
      const { beginUpdateBlock } = await import('/src/lib/updateSafety.ts')
      window.__smokeRouteRelease = beginUpdateBlock()
      window.__smokeRouteStore = window.PLANNER
    })
    await recoveryPage.getByRole('button', { name: 'Settings', exact: true }).click()
    await recoveryPage
      .getByRole('alert')
      .filter({ hasText: 'This view could not be loaded' })
      .waitFor()
    if (!(await recoveryPage.getByRole('button', { name: 'Reload', exact: true }).isDisabled()))
      await fail('Failed view offered reload while a draft/save blocker was active')
    await recoveryPage.evaluate(() => window.__smokeRouteRelease())
    await recoveryPage.waitForFunction(() =>
      Array.from(document.querySelectorAll('button')).some(
        (button) => button.textContent.trim() === 'Reload' && !button.disabled,
      ),
    )
    await recoveryPage.getByRole('button', { name: 'Back to workspace', exact: true }).click()
    await recoveryPage.locator('[data-filter-focus]').waitFor()
    if (!(await recoveryPage.evaluate(() => window.PLANNER === window.__smokeRouteStore)))
      await fail('Failed view replaced the running planner store')
    await recoveryPage.unroute(settingsModule)
    await recoveryPage.reload({ waitUntil: 'domcontentloaded' })
    await recoveryPage.getByRole('button', { name: 'Settings', exact: true }).click()
    await recoveryPage.locator('[data-appearance-settings]').waitFor({ timeout: 30000 })
    log('A: failed view preserves the workspace, guards reload and recovers after reconnect')
  } finally {
    await recoveryPage.close()
  }

  // Hover help uses one portalled design; native titles must not produce a
  // second browser bubble. Keyboard focus and Escape keep the page intact.
  // The Board's Focus toggle is the trigger: the sidebar's own rows carry no
  // hover help at all (deviation #250), which the rail check below proves.
  const tooltip = pageA.locator('[data-slot="tooltip-content"]')
  const focusToggle = pageA.locator('[data-filter-focus]')
  await focusToggle.hover()
  await tooltip.filter({ hasText: 'Hide Backlog and Done' }).waitFor()
  const tooltipStyle = await tooltip.evaluate((el) => {
    const style = getComputedStyle(el)
    return {
      radius: style.borderRadius,
      padding: style.padding,
      size: style.fontSize,
      arrows: el.querySelectorAll('svg, [data-slot="tooltip-arrow"]').length,
      nativeTitles: document.querySelectorAll('[title]').length,
    }
  })
  if (
    tooltipStyle.radius !== '8px' ||
    tooltipStyle.padding !== '6px 12px' ||
    tooltipStyle.size !== '12px' ||
    tooltipStyle.arrows ||
    tooltipStyle.nativeTitles
  )
    await fail(`Shared tooltip design drifted: ${JSON.stringify(tooltipStyle)}`)
  // Cross the trigger/tooltip hover bridge as a pointer does in normal use.
  await pageA.mouse.move(0, 0, { steps: 10 })
  await pageA.mouse.move(4, 0)
  // Crossing another trigger can leave multiple closing tooltips briefly.
  // Require all of them to leave, without a single-element locator assumption.
  await pageA.waitForFunction(() => !document.querySelector('[data-slot="tooltip-content"]'))
  log('A: pointer tooltip uses the shared design and closes on leave')
  await focusToggle.focus()
  await tooltip.filter({ hasText: 'Hide Backlog and Done' }).waitFor()
  await pageA.keyboard.press('Escape')
  await pageA.waitForFunction(() => !document.querySelector('[data-slot="tooltip-content"]'))
  if (!(await focusToggle.evaluate((el) => document.activeElement === el)))
    await fail('Dismissing a tooltip moved keyboard focus away from its trigger')
  // The rail is tooltip-free: hovering its search box, personal rows, header
  // + and a project row's "…" must open nothing.
  for (const sel of [
    '[data-sidebar-search]',
    '[data-mine-nav]',
    '[data-all-nav]',
    '[data-sync-nav]',
    '.planner-project-list [aria-label="New project"]',
    '.planner-project-list [aria-label="Project actions"]',
  ]) {
    const trigger = pageA.locator(sel).first()
    if (!(await trigger.count())) continue
    await trigger.hover()
    await pageA.waitForTimeout(500)
    if (await tooltip.count()) await fail(`Sidebar control ${sel} opened a tooltip`)
  }
  await pageA.mouse.move(0, 0)
  log('A: sidebar controls open no tooltip')
  log('A: shared tooltips match the approved design and preserve keyboard focus')

  // A top-level Dialog owns autofocus and Escape. This route has its own
  // page-level Escape handler, so it catches both focus regression and a
  // single keypress accidentally closing the dialog plus the Inbox beneath.
  await pageA.goto(`${BASE}/app/~/inbox`, { waitUntil: 'domcontentloaded' })
  await pageA.waitForSelector('h1:has-text("Inbox")', { timeout: 30000 })
  await pageA.click('button[aria-label="New project"]')
  const projectName = pageA
    .getByRole('dialog', { name: 'New project', exact: true })
    .getByRole('textbox', { name: 'Name', exact: true })
  await projectName.waitFor({ state: 'visible', timeout: 10000 })
  if (!(await projectName.evaluate((el) => el === document.activeElement))) {
    await fail('New project did not autofocus its name field')
  }
  const projectDialog = pageA.getByRole('dialog', { name: 'New project', exact: true })
  if ((await projectDialog.getByRole('button', { name: /project icon/i }).count()) !== 0) {
    await fail('New project still has a project icon chooser beside Name')
  }
  const projectLead = projectDialog.getByRole('combobox', { name: 'Lead', exact: true })
  if (
    (await projectDialog.getByRole('combobox', { name: 'Managing team', exact: true }).count()) !==
    0
  )
    await fail('New project still offers a managing-team selector')
  const leadCandidates = await pageA.evaluate(() =>
    window.PLANNER.homeAssignees()
      .map((user) => user.id)
      .sort(),
  )
  const offered = await projectLead.locator('option').evaluateAll((options) =>
    options
      .map((option) => option.value)
      .filter(Boolean)
      .sort(),
  )
  if (JSON.stringify(offered) !== JSON.stringify(leadCandidates))
    await fail('New project offers a lead outside the active organization roster')
  if (!leadCandidates.includes(await projectLead.inputValue()))
    await fail('New project did not select an eligible lead by default')
  log('A: New project is teamless and offers one eligible lead roster')
  await pageA.keyboard.press('Escape')
  await projectName.waitFor({ state: 'detached', timeout: 5000 })
  if (
    !pageA.url().endsWith('/app/~/inbox') ||
    (await pageA.locator('h1:has-text("Inbox")').count()) === 0
  ) {
    await fail('Escape from New project also dismissed the Inbox beneath it')
  }
  log('A: dialog autofocus and nested Escape preserve the Inbox beneath')

  // cmdk handles Home/End on its parent. Search inputs must keep the native
  // caret/selection behavior while arrows and Enter still operate the results.
  const paletteQuery = await pageA.evaluate(() => {
    const issues = window.PLANNER.issues
    if (issues.filter((issue) => issue.title.toLowerCase().includes('firm')).length >= 3)
      return 'firm'
    return issues.length >= 3 ? issues[0].key.replace(/\d+$/, '') : null
  })
  if (!paletteQuery) await fail('Northstar has too few tasks for the search keyboard check')
  const searchButton = pageA.locator('button[data-sidebar-search]')
  const palette = pageA.getByRole('dialog', { name: 'Search tasks and projects', exact: true })
  const searchInput = palette.getByRole('combobox', { name: 'Search tasks and projects' })
  const closeSearch = palette.getByRole('button', { name: 'Close search', exact: true })
  const selectedResult = palette.locator('[cmdk-item][aria-selected="true"]')
  const openPalette = async () => {
    await searchButton.click()
    await searchInput.waitFor({ state: 'visible', timeout: 10000 })
    await searchInput.fill(paletteQuery)
    await pageA.waitForFunction(
      () =>
        document.querySelectorAll('[cmdk-item]').length >= 3 &&
        document.querySelector('[cmdk-item][aria-selected="true"]'),
      null,
      { timeout: 5000 },
    )
  }
  await searchButton.click()
  await closeSearch.waitFor({ state: 'visible', timeout: 10000 })
  if ((await closeSearch.textContent()).trim() !== 'esc')
    await fail('Desktop Search dismiss button does not show esc')
  await closeSearch.click()
  await palette.waitFor({ state: 'detached', timeout: 5000 })
  if (
    !pageA.url().endsWith('/app/~/inbox') ||
    (await pageA.locator('h1:has-text("Inbox")').count()) === 0
  )
    await fail(`Clicking esc in Search also dismissed Inbox: ${pageA.url()}`)
  await openPalette()
  const firstResult = await selectedResult.getAttribute('data-value')
  await searchInput.press('ArrowDown')
  const secondResult = await selectedResult.getAttribute('data-value')
  if (!secondResult || secondResult === firstResult)
    await fail('ArrowDown in Search did not select the next result')
  await searchInput.press('ArrowUp')
  if ((await selectedResult.getAttribute('data-value')) !== firstResult)
    await fail('ArrowUp in Search did not restore the previous result')
  await searchInput.press('ArrowDown')

  const midpoint = Math.floor(paletteQuery.length / 2)
  for (const [key, start, end] of [
    ['Home', 0, 0],
    ['End', paletteQuery.length, paletteQuery.length],
    ['Shift+Home', 0, midpoint],
    ['Shift+End', midpoint, paletteQuery.length],
    ['Control+Home', 0, 0],
    ['Control+End', paletteQuery.length, paletteQuery.length],
    ['Control+Shift+Home', 0, midpoint],
    ['Control+Shift+End', midpoint, paletteQuery.length],
  ]) {
    await searchInput.evaluate(
      (input, position) => input.setSelectionRange(position, position),
      midpoint,
    )
    await searchInput.press(key)
    const selection = await searchInput.evaluate((input) => ({
      start: input.selectionStart,
      end: input.selectionEnd,
      value: input.value,
      focused: input === document.activeElement,
    }))
    if (
      selection.start !== start ||
      selection.end !== end ||
      selection.value !== paletteQuery ||
      !selection.focused ||
      (await selectedResult.getAttribute('data-value')) !== secondResult
    ) {
      await fail(
        `Search ${key} changed results or failed native selection: ${JSON.stringify(selection)}`,
      )
    }
  }
  await searchInput.press('Escape')
  await palette.waitFor({ state: 'detached', timeout: 5000 })
  if (
    !pageA.url().endsWith('/app/~/inbox') ||
    (await pageA.locator('h1:has-text("Inbox")').count()) === 0
  )
    await fail(`Escape from Search also dismissed Inbox: ${pageA.url()}`)

  await openPalette()
  // Opening a task marks its messages read. Pick an existing task with no
  // unread messages, so this regression does not alter the demo notification state.
  const enterTarget = await palette.locator('[cmdk-item]').evaluateAll((items) => {
    for (const [index, item] of items.entries()) {
      const value = item.getAttribute('data-value') || ''
      const issue = value.startsWith('issue-') && window.PLANNER.issueById[value.slice(6)]
      if (
        issue &&
        !window.PLANNER.messages.some(
          (message) => message.issueUuid === issue.uuid && !message.read,
        )
      )
        return { index, value, key: issue.key }
    }
    return null
  })
  if (!enterTarget)
    await fail('Search has no result safe to open without marking demo messages read')
  for (let index = 0; index < enterTarget.index; index++) await searchInput.press('ArrowDown')
  if ((await selectedResult.getAttribute('data-value')) !== enterTarget.value)
    await fail('Search arrows did not select the captured task for Enter')
  await searchInput.press('Enter')
  await palette.waitFor({ state: 'detached', timeout: 5000 })
  await pageA.locator('[data-task-scrim] [data-issue-key]').waitFor({ timeout: 10000 })
  if (
    (await pageA.locator('[data-task-scrim] [data-issue-key]').textContent()).trim() !==
    enterTarget.key
  )
    await fail('Enter from Search opened a different task than the selected result')
  // Closing the palette restores keyboard focus, which can show its trigger's
  // help. Escape dismisses that layer before it dismisses the task window.
  if (await tooltip.count()) {
    await pageA.keyboard.press('Escape')
    await tooltip.waitFor({ state: 'detached' })
    if (!(await pageA.locator('[data-task-scrim]').count()))
      await fail('Tooltip Escape also closed the task window')
  }
  await pageA.keyboard.press('Escape')
  await pageA.locator('[data-task-scrim]').waitFor({ state: 'detached', timeout: 5000 })
  log('A: Search has clickable esc and preserves Home/End, arrows, Enter and layered Escape')

  // Appearance applies immediately and persists. Blue, Dark and Light keep the
  // Canvas controls enabled and paint the chosen Canvas image behind them; No
  // image paints and requests nothing. Restore the demo account's original
  // choice after the check.
  await pageA.goto(`${BASE}/app/${demo.orgSlug}/settings/account`, {
    waitUntil: 'domcontentloaded',
  })
  await pageA.locator('[data-appearance-settings]').waitFor({ timeout: 30000 })
  await pageA.locator('[data-appearance-mode="blue"]').waitFor()
  const accountAppearance = () =>
    pageA.evaluate(async () => {
      const { convex } = await import('/src/lib/convex.ts')
      const { mode, image_source, custom_image } = await convex.query('appearance:get', {})
      return { mode, image_source, customImage: custom_image?.id ?? null }
    })
  const { customImage, ...originalAppearance } = await accountAppearance()
  appearanceBefore = originalAppearance
  appearanceNeedsRestore = true
  const waitChecked = (selector) =>
    pageA.waitForFunction((selector) => {
      const radio = document.querySelector(selector)
      return (
        radio?.checked &&
        !radio.matches(':disabled') &&
        radio.getAttribute('aria-disabled') !== 'true'
      )
    }, selector)
  const chooseTheme = async (mode) => {
    await pageA.locator(`[data-appearance-mode="${mode}"]`).click()
    await waitChecked(`[data-appearance-mode="${mode}"]`)
    await pageA.waitForFunction(
      (mode) => document.documentElement.dataset.appearance === mode,
      mode,
    )
  }
  // Settings and the provider subscribe separately. Wait for the selected
  // source's expected result, then read Canvas and panel styles in one turn.
  const settledCanvas = async ({ source, state, mode, image = null }) => {
    const sample = await pageA.waitForFunction(
      ({ source, state, mode, image }) => {
        const root = document.documentElement
        const radio = document.querySelector(`[data-appearance-source="${source}"]`)
        const canvas = document.querySelector('[data-appearance-background]')
        const preview = document.querySelector('[data-appearance-weekly-preview]')
        const frame = document.querySelector('.settings-content-frame')
        if (
          !frame ||
          !radio?.checked ||
          radio.matches(':disabled') ||
          radio.getAttribute('aria-disabled') === 'true' ||
          root.dataset.backgroundState !== state ||
          (mode && root.dataset.appearance !== mode)
        )
          return false
        if (
          state === 'ready'
            ? !canvas?.complete ||
              !canvas.naturalWidth ||
              canvas.dataset.backgroundRestored ||
              !preview?.complete ||
              !preview.naturalWidth
            : canvas
        )
          return false
        const style = getComputedStyle(frame)
        return {
          mode: root.dataset.appearance,
          cached: localStorage.getItem('qivo-appearance-mode'),
          background: getComputedStyle(document.body).backgroundColor,
          scheme: getComputedStyle(root).colorScheme,
          state: root.dataset.backgroundState,
          images: document.querySelectorAll('[data-appearance-background]').length,
          sameImage: !image || image === canvas,
          panel: { background: style.backgroundColor, blur: style.backdropFilter },
          canvasDisabled: document.querySelector('[data-appearance-image-controls]')?.disabled,
          sources: Array.from(
            document.querySelectorAll('[data-appearance-source]:enabled'),
            (radio) => radio.dataset.appearanceSource,
          ).join(),
        }
      },
      { source, state, mode, image },
      { timeout: 30000 },
    )
    try {
      return await sample.jsonValue()
    } finally {
      await sample.dispose()
    }
  }
  // Computed colors serialize as rgb(), rgba() or color(srgb … / alpha).
  const panelMaterial = ({ background, blur }) => {
    const alpha = Number(
      /^rgba\(.*,\s*([\d.]+)\)$/.exec(background)?.[1] ??
        /\/\s*([\d.]+)\)$/.exec(background)?.[1] ??
        1,
    )
    if (alpha === 1 && blur === 'none') return 'solid'
    if (alpha > 0 && alpha < 1 && blur === 'blur(10px)') return 'translucent'
    return `${background} with ${blur}`
  }
  // Canvas image traffic: custom originals and previews, and the week's
  // library image and preview served from Convex storage.
  const canvasRequests = []
  const recordCanvas = (request) => {
    const path = new URL(request.url()).pathname
    if (/\/(?:backgrounds|background-previews)\/|\/api\/storage\//.test(path))
      canvasRequests.push(path)
  }
  pageA.on('request', recordCanvas)

  // Resolve eligibility independently: a transient unavailable state from the
  // previous source must not turn a real image into a skipped assertion.
  const weeklyAvailable = await pageA.evaluate(async () => {
    const { convex } = await import('/src/lib/convex.ts')
    const date = document.querySelector('[data-background-date]').dataset.backgroundDate
    return Boolean((await convex.query('appearance:dailyImage', { date }))?.image_url)
  })
  const weeklyState = weeklyAvailable ? 'ready' : 'unavailable'
  await pageA.locator('[data-appearance-source="daily"]').click()
  await waitChecked('[data-appearance-source="daily"]')
  await settledCanvas({ source: 'daily', state: weeklyState })
  const painted = weeklyAvailable
  if (painted) log('A: the Canvas box previews the image of the week')
  else log('SKIP: no image of the week to preview or paint behind the theme checks')
  const paintedImage = painted
    ? await pageA.locator('[data-appearance-background]').elementHandle()
    : null
  const themeRequests = canvasRequests.length
  const modeBackgrounds = new Map()
  for (const mode of ['dark', 'light', 'blue']) {
    await chooseTheme(mode)
    const paint = await settledCanvas({
      source: 'daily',
      state: weeklyState,
      mode,
      image: paintedImage,
    })
    modeBackgrounds.set(mode, paint.background)
    if (paint.scheme !== (mode === 'light' ? 'light' : 'dark'))
      await fail(`Native controls have incorrect color scheme for ${mode}`)
    if (paint.canvasDisabled !== false || paint.sources !== 'daily,custom,none')
      await fail(`Canvas controls are not all enabled in ${mode}: ${paint.sources}`)
    if (painted && (paint.images !== 1 || !paint.sameImage))
      await fail(`${mode} did not keep the painted Canvas image`)
    // Every theme's panels are translucent over an image, solid without one.
    const expected = painted ? 'translucent' : 'solid'
    const material = panelMaterial(paint.panel)
    if (material !== expected) await fail(`${mode} panels are ${material}, not ${expected}`)
  }
  await paintedImage?.dispose()
  if (canvasRequests.length !== themeRequests)
    await fail(`Switching theme requested Canvas images: ${canvasRequests.slice(themeRequests)}`)
  if (modeBackgrounds.get('light') === modeBackgrounds.get('dark')) {
    await fail('Light and Dark did not apply different palettes')
  }
  if (
    modeBackgrounds.get('blue') === modeBackgrounds.get('dark') ||
    modeBackgrounds.get('blue') === modeBackgrounds.get('light')
  ) {
    await fail('Blue did not apply its own palette')
  }
  await pageA.reload({ waitUntil: 'domcontentloaded' })
  await waitChecked('[data-appearance-mode="blue"]')
  const restored = await settledCanvas({ source: 'daily', state: weeklyState, mode: 'blue' })
  if (
    restored.mode !== 'blue' ||
    restored.cached !== 'blue' ||
    (painted && (restored.state !== 'ready' || restored.images !== 1))
  )
    await fail('Blue did not survive reload with its Canvas image')
  log(
    painted
      ? 'A: Blue/Dark/Light keep the painted Canvas image, its controls and translucent panels'
      : 'A: Blue/Dark/Light keep the Canvas controls and solid panels without an image',
  )

  // No image paints and requests nothing, including after a fresh visit, and
  // keeps the custom upload. Every theme's panels turn solid.
  const noneRequests = canvasRequests.length
  await pageA.locator('[data-appearance-source="none"]').click()
  await waitChecked('[data-appearance-source="none"]')
  await settledCanvas({ source: 'none', state: 'none' })
  for (const mode of ['dark', 'light', 'blue']) {
    await chooseTheme(mode)
    const paint = await settledCanvas({ source: 'none', state: 'none', mode })
    const material = panelMaterial(paint.panel)
    if (material !== 'solid') await fail(`${mode} panels are ${material} with No image, not solid`)
  }
  await pageA.reload({ waitUntil: 'domcontentloaded' })
  await waitChecked('[data-appearance-source="none"]')
  await settledCanvas({ source: 'none', state: 'none', mode: 'blue' })
  await pageA.waitForLoadState('networkidle', { timeout: 10000 })
  if (
    canvasRequests.length !== noneRequests ||
    (await pageA.locator('[data-appearance-background]').count())
  )
    await fail('No image requested or rendered a Canvas image')
  if ((await accountAppearance()).customImage !== customImage)
    await fail('No image changed the existing custom upload')
  pageA.off('request', recordCanvas)
  log('A: No image paints and requests nothing; every theme turns its panels solid')

  await pageA.locator('[data-appearance-source="custom"]').click()
  await waitChecked('[data-appearance-source="custom"]')
  await pageA.reload({ waitUntil: 'domcontentloaded' })
  await pageA.waitForFunction(
    () => document.querySelector('[data-appearance-source="custom"]')?.checked,
  )
  if (!(await pageA.locator('[data-appearance-mode="blue"]').isChecked())) {
    await fail('Appearance choice did not survive reload')
  }
  await checkCompressedCanvas(pageA)
  await pageA.evaluate(async (original) => {
    const { convex } = await import('/src/lib/convex.ts')
    await convex.mutation('appearance:save', original)
  }, appearanceBefore)
  appearanceNeedsRestore = false
  log('A: Blue/Dark/Light and the Canvas image choices apply and persist')

  // Phone navigation keeps daily work reachable and gives each full-page
  // layer one Back step. This leg is read-only and preserves the task view.
  const originalViewport = pageA.viewportSize()
  const noPhonePageSearch = async (where, root = pageA) => {
    const fields = await root
      .locator(
        'input[placeholder="Find a project…"], input[placeholder="Filter messages…"], input[placeholder="Filter tasks…"], [data-archive-search]',
      )
      .count()
    if (fields) await fail(`Phone ${where} still mounts a page-level search field`)
  }
  await pageA.goto(`${BASE}/app/${demo.orgSlug}/board/all`, { waitUntil: 'domcontentloaded' })
  const desktopTaskFilter = pageA.getByPlaceholder('Filter tasks…', { exact: true })
  await desktopTaskFilter.waitFor({ state: 'visible', timeout: 30000 })
  if ((await pageA.locator('[data-filter-focus]').count()) !== 1)
    await fail('The desktop Board does not render its Focus button')
  await pageA.locator('[data-card]').first().waitFor({ state: 'visible' })
  const desktopOnlyQuery = `no-task-matches-${STAMP}`
  await desktopTaskFilter.fill(desktopOnlyQuery)
  await pageA.waitForFunction(() => document.querySelectorAll('[data-card]').length === 0)
  await pageA.setViewportSize({ width: 390, height: 844 })
  const allTasksURL = `${BASE}/app/~/board/all`
  await pageA.waitForURL(allTasksURL)
  const phoneNavigation = pageA.getByRole('navigation', { name: 'Main navigation', exact: true })
  const myTasks = phoneNavigation.getByRole('button', { name: 'My tasks', exact: true })
  await myTasks.focus()
  await pageA.keyboard.press('Enter')
  const myTasksURL = `${BASE}/app/~/board/mine`
  await pageA.waitForURL(myTasksURL)
  await pageA.locator('.mobile-task-list').waitFor({ state: 'visible' })
  if ((await myTasks.getAttribute('aria-current')) !== 'page')
    await fail('Phone navigation does not identify My tasks as the current page')
  const checkPhoneTaskSections = async () => {
    const sections = await pageA.locator('.mobile-task-section').evaluateAll((elements) =>
      elements.map((element) => ({
        label: element.querySelector('h2')?.textContent,
        height: element.clientHeight,
        contentHeight: element.scrollHeight,
      })),
    )
    if (!sections.length) await fail('Phone My tasks has no task sections to check')
    const clipped = sections.filter((section) => section.contentHeight > section.height + 1)
    if (clipped.length)
      await fail(`Phone task sections clip their contents: ${JSON.stringify(clipped)}`)
  }
  await checkPhoneTaskSections()
  await noPhonePageSearch('My tasks')
  await pageA.locator('.mobile-task-list [data-card]').first().waitFor({ state: 'visible' })
  const filterLabelWithDesktopQuery = await pageA
    .locator('.mobile-task-tools')
    .getByRole('button', { name: /^Filters(?:, \d+)?$/ })
    .textContent()
  // Resizing back restores the desktop query. Clear it there, then prove its
  // presence had no effect on either phone tasks or the active-filter count.
  await pageA.setViewportSize(originalViewport)
  await desktopTaskFilter.waitFor({ state: 'visible' })
  if ((await desktopTaskFilter.inputValue()) !== desktopOnlyQuery)
    await fail('Switching to phone My tasks discarded the desktop text filter')
  if (await pageA.locator('[data-card]').count())
    await fail('Returning to desktop did not restore its active text filter')
  await desktopTaskFilter.fill('')
  await pageA.locator('[data-card]').first().waitFor({ state: 'visible' })
  await pageA.setViewportSize({ width: 390, height: 844 })
  await pageA.locator('.mobile-task-list [data-card]').first().waitFor({ state: 'visible' })
  if (
    (await pageA
      .locator('.mobile-task-tools')
      .getByRole('button', { name: /^Filters(?:, \d+)?$/ })
      .textContent()) !== filterLabelWithDesktopQuery
  )
    await fail('A desktop-only text query contributes to the phone active-filter badge')
  log(
    'A: desktop task query is ignored on phone, retained on resize, and cleared after verification',
  )

  const openPhoneSearch = async () => {
    await pageA.getByRole('button', { name: 'Search tasks and projects', exact: true }).click()
    await searchInput.waitFor({ state: 'visible', timeout: 10000 })
    if ((await closeSearch.textContent()).trim() !== 'Close')
      await fail('Phone Search dismiss button does not show Close')
  }
  const checkSearchReturnedToMyTasks = async () => {
    await palette.waitFor({ state: 'detached', timeout: 5000 })
    await pageA.waitForURL(myTasksURL)
    await pageA.locator('.mobile-task-list').waitFor({ state: 'visible' })
    if ((await myTasks.getAttribute('aria-current')) !== 'page')
      await fail('Dismissing phone Search changed the underlying My tasks view')
  }
  const checkNoSearchHistoryStep = async () => {
    // My tasks was entered from All tasks. A leftover same-URL search entry
    // would swallow this Back and leave the user on My tasks again.
    await pageA.goBack()
    await pageA.waitForURL(allTasksURL)
    await pageA.locator('.mobile-task-list').waitFor({ state: 'visible' })
    if (await palette.count()) await fail('Native Back reopened a dismissed phone Search')
    await myTasks.click()
    await pageA.waitForURL(myTasksURL)
  }
  await openPhoneSearch()
  await pageA.goBack()
  await checkSearchReturnedToMyTasks()
  await checkNoSearchHistoryStep()

  await openPhoneSearch()
  await closeSearch.click()
  await checkSearchReturnedToMyTasks()
  await checkNoSearchHistoryStep()

  // Reuse the captured task with no unread messages: viewing it must not
  // mark any seeded notification read. Both kinds of result consume Search
  // before navigating, so Back returns to its source page exactly once.
  await openPhoneSearch()
  await searchInput.fill(enterTarget.key)
  await palette.locator(`[cmdk-item][data-value="${enterTarget.value}"]`).click()
  await palette.waitFor({ state: 'detached', timeout: 5000 })
  const phoneTask = pageA.locator('[data-mobile-task-frame] [role="dialog"][aria-modal="true"]')
  await phoneTask.waitFor({ state: 'visible', timeout: 10000 })
  // Probed as Blue over a painted image: with No image its window is solid.
  const phoneWindowMaterial = await phoneTask.evaluate((element) => {
    const html = document.documentElement
    const original = {
      appearance: html.dataset.appearance,
      backgroundState: html.dataset.backgroundState,
    }
    try {
      html.dataset.appearance = 'blue'
      html.dataset.backgroundState = 'ready'
      const style = getComputedStyle(element)
      const frame = getComputedStyle(element.closest('[data-mobile-task-frame]'))
      return {
        background: style.backgroundColor,
        blur: style.backdropFilter,
        frame: frame.backgroundColor,
      }
    } finally {
      for (const [key, value] of Object.entries(original))
        if (value === undefined) delete html.dataset[key]
        else html.dataset[key] = value
    }
  })
  if (
    phoneWindowMaterial.background !== 'rgba(16, 26, 36, 0.81)' ||
    phoneWindowMaterial.blur !== 'blur(10px)' ||
    phoneWindowMaterial.frame !== 'rgba(0, 0, 0, 0)'
  )
    await fail('The Blue phone task window is hidden behind an opaque frame')
  if ((await phoneTask.locator('[data-issue-key]').textContent()).trim() !== enterTarget.key)
    await fail('Phone Search opened a different task than the selected result')
  await pageA.goBack()
  await phoneTask.waitFor({ state: 'detached', timeout: 5000 })
  await checkSearchReturnedToMyTasks()
  await checkNoSearchHistoryStep()

  const searchProject = await pageA.evaluate(() => {
    const project = window.PLANNER.visibleProjects()[0]
    return project ? { id: project.id, name: project.name, num: project.num } : null
  })
  if (!searchProject) await fail('Northstar has no visible project for the phone Search check')
  await openPhoneSearch()
  await searchInput.fill(searchProject.name)
  await palette.locator(`[cmdk-item][data-value="project-${searchProject.id}"]`).click()
  await palette.waitFor({ state: 'detached', timeout: 5000 })
  await pageA.waitForURL((url) => url.pathname.endsWith(`/board/p/${searchProject.num}`))
  if ((await pageA.locator('.mobile-page-title').textContent()).trim() !== searchProject.name)
    await fail('Phone Search opened a different project than the selected result')
  await pageA.goBack()
  await checkSearchReturnedToMyTasks()
  await checkNoSearchHistoryStep()
  log('A: phone Search Close/native Back and task/project results consume one history layer')

  const phoneTools = pageA.locator('.mobile-task-tools')
  await phoneTools.getByRole('button', { name: /^Filters(?:, \d+)?$/ }).click()
  const phoneFilters = pageA.locator('.mobile-filter-page')
  await phoneFilters.waitFor({ state: 'visible' })
  await noPhonePageSearch('task filters')
  await pageA.goBack()
  await phoneFilters.waitFor({ state: 'detached' })
  if (pageA.url() !== myTasksURL)
    await fail(`Native Back from phone filters left My tasks: ${pageA.url()}`)
  await phoneTools.getByRole('button', { name: 'New task', exact: true }).click()
  const phoneNewTask = pageA.locator('[data-modal-shell]')
  await phoneNewTask.waitFor({ state: 'visible' })
  await pageA.goBack()
  await phoneNewTask.waitFor({ state: 'detached' })
  if (pageA.url() !== myTasksURL)
    await fail(`Native Back from phone New task left My tasks: ${pageA.url()}`)

  await phoneNavigation.locator('[data-inbox-nav]').click()
  await pageA.waitForURL(`${BASE}/app/~/inbox`)
  await pageA.locator('[data-inbox]').waitFor({ state: 'visible' })
  await noPhonePageSearch('Inbox')
  await pageA.goBack()
  await pageA.waitForURL(myTasksURL)

  await pageA.locator('[data-mobile-settings]').click()
  await pageA.locator('[data-settings-page="menu"]').waitFor({ state: 'visible' })
  const settingsMenuRadii = await pageA.locator('.settings-navigation').evaluate((element) => {
    const style = getComputedStyle(element)
    return [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomLeftRadius,
      style.borderBottomRightRadius,
    ].map(Number.parseFloat)
  })
  if (settingsMenuRadii.some((radius) => !Number.isFinite(radius) || radius <= 0))
    await fail(`Phone Settings menu lost its rounded outside edge: ${settingsMenuRadii}`)
  await pageA.locator('[data-settings-item="account"]').click()
  await pageA.locator('[data-settings-account-section="profile"]').click()
  await pageA.locator('[data-settings-page="account-profile"]').waitFor({ state: 'visible' })
  await pageA.goBack()
  await pageA.locator('[data-settings-page="account"]').waitFor({ state: 'visible' })
  await pageA.locator('[data-settings-account-section="profile"]').click()
  await pageA.locator('[data-settings-page="account-profile"]').waitFor({ state: 'visible' })
  await pageA.locator('[data-settings-back]').click()
  await pageA.locator('[data-settings-page="account"]').waitFor({ state: 'visible' })
  await pageA.goBack()
  await pageA.locator('[data-settings-page="menu"]').waitFor({ state: 'visible' })
  await pageA.locator('[data-settings-back]').click()
  await pageA.waitForURL(myTasksURL)
  await pageA.locator('.mobile-task-list').waitFor({ state: 'visible' })

  await phoneNavigation.getByRole('button', { name: 'Projects', exact: true }).click()
  const projectsURL = `${BASE}/app/~/projects`
  await pageA.waitForURL(projectsURL)
  await pageA.locator('.mobile-project-directory').waitFor({ state: 'visible' })
  await noPhonePageSearch('Projects')
  await pageA
    .locator('.mobile-project-card')
    .first()
    .getByRole('button', { name: / actions$/ })
    .click()
  await pageA.getByRole('button', { name: 'Archived tasks', exact: true }).click()
  await pageA.locator('[data-archive-page]').waitFor({ state: 'visible' })
  await noPhonePageSearch('Archive')
  await pageA
    .locator('.archive-mobile-navigation')
    .getByRole('button', { name: 'Back', exact: true })
    .click()
  await pageA.waitForURL(projectsURL)
  await pageA.locator('.mobile-project-directory').waitFor({ state: 'visible' })
  await pageA.goBack()
  await pageA.waitForURL(myTasksURL)
  await pageA.setViewportSize({ width: 320, height: 844 })
  await pageA.locator('.mobile-task-list').waitFor({ state: 'visible' })
  await checkPhoneTaskSections()
  await pageA.setViewportSize({ width: 390, height: 844 })

  // Timeline & team must open a landscape canvas even with portrait rotation
  // locked. Inspect its window controls without changing dates or preferences.
  const roadmapPreferences = () => {
    const ui = window.PLANNER.loadUI()
    return JSON.stringify({ window: ui.roadmapWin, default: ui.roadmapWinDefault })
  }
  const roadmapPreferencesBefore = await pageA.evaluate(roadmapPreferences)
  await pageA.locator('.mobile-view-switch').getByRole('radio', { name: 'Roadmap' }).click()
  const roadmapURL = `${BASE}/app/~/roadmap/mine`
  await pageA.waitForURL(roadmapURL)
  const agenda = pageA.locator('.mobile-roadmap-agenda')
  await agenda.waitFor({ state: 'visible' })
  await agenda.getByRole('button', { name: 'Task schedule', exact: true }).click()
  await agenda.getByRole('combobox', { name: 'Show', exact: true }).selectOption('planned')
  await noPhonePageSearch('Roadmap agenda')
  const landscape = pageA.locator('[data-roadmap-landscape]')
  const checkLandscape = async (mode) => {
    await pageA.locator(`[data-roadmap-landscape="${mode}"]`).waitFor({ state: 'visible' })
    await noPhonePageSearch(`${mode} Timeline & team`, landscape)
    const bounds = await landscape.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        width: element.clientWidth,
        height: element.clientHeight,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
      }
    })
    if (
      bounds.width <= bounds.height ||
      Math.abs(bounds.width - Math.max(bounds.viewportWidth, bounds.viewportHeight)) > 1 ||
      Math.abs(bounds.height - Math.min(bounds.viewportWidth, bounds.viewportHeight)) > 1 ||
      bounds.left < -1 ||
      bounds.top < -1 ||
      bounds.right > bounds.viewportWidth + 1 ||
      bounds.bottom > bounds.viewportHeight + 1
    )
      await fail(
        `Phone ${mode} timeline does not fit a landscape viewport: ${JSON.stringify(bounds)}`,
      )
  }
  const checkLandscapePopover = async (selector) => {
    const content = landscape.locator(selector)
    await content.waitFor({ state: 'visible' })
    const bounds = await content.evaluate(async (element) => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const frame = element.closest('[data-roadmap-landscape]')
      const surface = element.closest('[data-floating-surface]')
      if (!frame || !surface) return null
      const rect = surface.getBoundingClientRect()
      const outer = frame.getBoundingClientRect()
      const rotated = frame.dataset.roadmapLandscape === 'rotated'
      return {
        left: rotated ? rect.top - outer.top : rect.left - outer.left,
        top: rotated ? outer.right - rect.right : rect.top - outer.top,
        right: rotated ? rect.bottom - outer.top : rect.right - outer.left,
        bottom: rotated ? outer.right - rect.left : rect.bottom - outer.top,
        width: frame.clientWidth,
        height: frame.clientHeight,
        clipped:
          surface.scrollHeight > surface.clientHeight + 1 &&
          !['auto', 'scroll'].includes(getComputedStyle(surface).overflowY),
      }
    })
    if (
      !bounds ||
      bounds.left < -1 ||
      bounds.top < -1 ||
      bounds.right > bounds.width + 1 ||
      bounds.bottom > bounds.height + 1 ||
      bounds.clipped
    )
      await fail(
        `Phone timeline ${selector} escapes its logical viewport: ${JSON.stringify(bounds)}`,
      )
  }
  const checkAgendaSelection = async () => {
    await landscape.waitFor({ state: 'detached' })
    await agenda.waitFor({ state: 'visible' })
    if (
      pageA.url() !== roadmapURL ||
      (await agenda
        .getByRole('button', { name: 'Task schedule', exact: true })
        .getAttribute('aria-pressed')) !== 'true' ||
      (await agenda.getByRole('combobox', { name: 'Show', exact: true }).inputValue()) !== 'planned'
    )
      await fail(
        'Closing Timeline & team changed the agenda route or Task schedule/Planned selection',
      )
    await pageA.waitForFunction(
      () =>
        document.querySelector('.mobile-roadmap-open-timeline > button') === document.activeElement,
      null,
      { timeout: 5000 },
    )
  }
  const openTimeline = () =>
    agenda.getByRole('button', { name: 'Timeline & team', exact: true }).click()
  await openTimeline()
  await checkLandscape('rotated')
  await landscape.locator('[data-win="menu"]').click()
  await checkLandscapePopover('[data-win-menu]')
  // Chromium's automatic click scrolling uses physical coordinates for a
  // transformed ancestor. Scroll the popup itself before targeting its tail.
  const scrollPopupToEnd = (element) => {
    const surface = element.closest('[data-floating-surface]')
    surface.scrollTop = surface.scrollHeight
  }
  await landscape.locator('[data-win-menu]').evaluate(scrollPopupToEnd)
  await landscape.locator('[data-win-custom]').click()
  await checkLandscapePopover('[data-win-picker]')
  await landscape.locator('[data-win-picker]').evaluate(scrollPopupToEnd)
  await checkLandscapePopover('[data-win-picker]')
  await pageA.keyboard.press('Escape')
  await pageA.locator('[data-win-picker]').waitFor({ state: 'detached' })
  await checkLandscape('rotated')
  await landscape.locator('[data-landscape-back]').click()
  await checkAgendaSelection()

  await openTimeline()
  await checkLandscape('rotated')
  await pageA.goBack()
  await checkAgendaSelection()

  await openTimeline()
  const frameBeforeRotation = await landscape.elementHandle()
  await pageA.setViewportSize({ width: 844, height: 390 })
  await checkLandscape('natural')
  if (!(await frameBeforeRotation.evaluate((element) => element.isConnected)))
    await fail('Physical phone rotation remounted the active timeline layer')
  await frameBeforeRotation.dispose()
  const landscapeTask = await landscape.locator('[data-bar]').evaluateAll((items) => {
    for (const element of items) {
      const id = element.getAttribute('data-bar')
      const issue = window.PLANNER.issueById[id]
      if (
        !issue ||
        window.PLANNER.messages.some((message) => message.issueUuid === issue.uuid && !message.read)
      )
        continue
      const rect = element.getBoundingClientRect()
      const clip = element.parentElement.getBoundingClientRect()
      const left = Math.max(rect.left, clip.left, 0)
      const right = Math.min(rect.right, clip.right, innerWidth)
      const top = Math.max(rect.top, clip.top, 0)
      const bottom = Math.min(rect.bottom, clip.bottom, innerHeight)
      if (right <= left || bottom <= top) continue
      const x = (left + right) / 2
      const y = (top + bottom) / 2
      if (element.contains(document.elementFromPoint(x, y)))
        return { id, key: issue.key, start: issue.start, end: issue.end, x, y }
    }
    return null
  })
  if (landscapeTask) {
    // A click opens the task; there is no pointer movement or schedule edit.
    await pageA.mouse.click(landscapeTask.x, landscapeTask.y)
    const taskWindow = pageA.locator('[data-task-scrim]')
    await taskWindow.locator('[data-task-close]').waitFor({ state: 'visible' })
    if ((await taskWindow.locator('[data-issue-key]').textContent()).trim() !== landscapeTask.key)
      await fail('The natural-landscape timeline opened a different task than the clicked bar')
    await taskWindow.locator('[data-task-close]').click()
    await taskWindow.waitFor({ state: 'detached' })
    await pageA.waitForURL(roadmapURL)
    await checkLandscape('natural')
    const datesPreserved = await pageA.evaluate(({ id, start, end }) => {
      const issue = window.PLANNER.issueById[id]
      return issue.start === start && issue.end === end
    }, landscapeTask)
    if (!datesPreserved) await fail('Opening a timeline task changed its schedule')
    // Closing the task consumes its entry. The next Back closes the landscape
    // layer; it must not reopen the task or swallow an extra same-URL step.
    await pageA.goBack()
  } else {
    log(
      'SKIP: saved roadmap window has no visible task without unread messages for task-close check',
    )
    await landscape.locator('[data-landscape-back]').click()
  }
  await checkAgendaSelection()
  await openTimeline()
  await checkLandscape('natural')
  await pageA.goBack()
  await checkAgendaSelection()
  if ((await pageA.evaluate(roadmapPreferences)) !== roadmapPreferencesBefore)
    await fail('Inspecting phone timeline menus changed saved roadmap windows')

  // A new desktop visit must return to the ordinary timeline, independent of
  // the phone flow retained while the same mounted screen rotates.
  await pageA.setViewportSize(originalViewport)
  await pageA.goto(`${BASE}/app/${demo.orgSlug}/roadmap/all`, {
    waitUntil: 'domcontentloaded',
  })
  await pageA
    .locator('.roadmap-view [data-win="menu"]')
    .waitFor({ state: 'visible', timeout: 30000 })
  if ((await landscape.count()) || (await agenda.count()))
    await fail('A fresh desktop Roadmap still renders the phone agenda or landscape layer')
  // Focus is the Board's control (deviation #241): no button here, while the
  // Board check above proved the same page still renders its own.
  if (await pageA.locator('[data-filter-focus]').count())
    await fail('The desktop Roadmap still renders a Focus button')
  const roadmapScroll = await pageA.locator('.roadmap-view').evaluate(async (view) => {
    const header = view.querySelector('[data-roadmap-header]')
    const body = view.querySelector('[data-scroll]')
    if (!header || !body) return null
    const settle = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await settle()
    const before = header.getBoundingClientRect()
    const bodyRect = body.getBoundingClientRect()
    const originalTop = body.scrollTop
    const contentTop = body.firstElementChild.getBoundingClientRect().top
    body.scrollTop = originalTop > 0 ? 0 : body.scrollHeight
    await settle()
    const after = header.getBoundingClientRect()
    const paintedUnderHeader = [before.left + 100, (before.left + before.right) / 2].some((x) =>
      [before.top + before.height / 2, before.bottom - 2].some((y) =>
        body.contains(document.elementFromPoint(x, y)),
      ),
    )
    const result = {
      independent: !body.contains(header),
      bodyTop: bodyRect.top,
      headerBottom: before.bottom,
      headerWidth: header.clientWidth,
      bodyWidth: body.clientWidth,
      headerShift: after.top - before.top,
      scrollDelta: body.scrollTop - originalTop,
      contentShift: body.firstElementChild.getBoundingClientRect().top - contentTop,
      paintedUnderHeader,
    }
    body.scrollTop = originalTop
    await settle()
    return result
  })
  if (
    !roadmapScroll?.independent ||
    Math.abs(roadmapScroll.bodyTop - roadmapScroll.headerBottom) > 2 ||
    Math.abs(roadmapScroll.headerWidth - roadmapScroll.bodyWidth) > 1 ||
    Math.abs(roadmapScroll.headerShift) > 1 ||
    Math.abs(roadmapScroll.scrollDelta) < 1 ||
    Math.abs(roadmapScroll.contentShift + roadmapScroll.scrollDelta) > 1 ||
    roadmapScroll.paintedUnderHeader
  )
    await fail(
      `Roadmap task scrolling overlaps or moves its header: ${JSON.stringify(roadmapScroll)}`,
    )
  log('A: Roadmap scrolls below its fixed, width-aligned task and week header')
  const roadmapEdges = await pageA.locator('.roadmap-view').evaluate((view) => {
    const errors = []
    const near = (a, b) => Math.abs(a - b) <= 1
    const cells = [...view.querySelectorAll('[data-roadmap-header] [data-wkcell]')]
    const weeks = new Map(
      cells.map((cell) => [Number(cell.dataset.wkcell), cell.getBoundingClientRect()]),
    )
    const p = window.PLANNER
    const ui = p.loadUI()
    const { w0, w1 } = p.resolveWin(p.sanitizeWin(ui.roadmapWin || ui.roadmapWinDefault))
    if (cells.length !== w1 - w0 + 1 || !cells.length)
      errors.push('Week count differs from the saved window')
    cells.forEach((cell, i) => {
      const rect = cell.getBoundingClientRect()
      if (
        Number(cell.dataset.wkcell) !== w0 + i ||
        !near(rect.width, cells[0].getBoundingClientRect().width)
      )
        errors.push(`Week ${cell.dataset.wkcell}: unequal width or wrong window position`)
      if (i && !near(rect.left, cells[i - 1].getBoundingClientRect().right))
        errors.push('Week cells are not contiguous')
    })
    const columns = [...view.querySelectorAll('.roadmap-edge-column, .rs-gutter')]
    if (view.querySelectorAll('[data-roadmap-header] .roadmap-edge-column').length !== 2)
      errors.push('The week header is missing its two edge columns')
    if (columns.some((column) => !near(column.getBoundingClientRect().width, 56)))
      errors.push('A timeline or Team edge column is not 56px wide')
    const teamCells = [...view.querySelectorAll('[data-load-box]')]
    for (const cell of teamCells) {
      const header = weeks.get(Number(cell.dataset.loadBox))
      const rect = cell.closest('.rs-week-cell').getBoundingClientRect()
      if (!header || !near(rect.left, header.left) || !near(rect.width, header.width))
        errors.push(`Team week ${cell.dataset.loadBox} is not aligned with the week header`)
    }
    const rows = [
      ...new Set([...view.querySelectorAll('.roadmap-row-edge')].map((edge) => edge.parentElement)),
    ]
    if (!rows.length) errors.push('No roadmap rows were found for edge validation')
    let checkedMarkers = 0
    for (const row of rows) {
      const label = row.querySelector('[data-roadmap-task-open]')
      const task = label && p.issueById[label.dataset.roadmapTaskOpen]
      if (label && !task)
        errors.push(`Rendered task ${label.dataset.roadmapTaskOpen} is missing from the planner`)
      if (
        task &&
        (task.status === 'backlog' ||
          (task.status === 'done' &&
            (task.start == null || task.end == null || task.end < w0 || task.start > w1)))
      )
        errors.push(`${task.title}: task status and planned period exclude it from this roadmap`)
      const expected = []
      if (task && task.start != null && task.end != null) {
        if (task.end < w0) expected.push(['before', 'outside', w0 - task.end - 1])
        else if (task.start > w1) expected.push(['after', 'outside', task.start - w1 - 1])
        else {
          if (task.start < w0) expected.push(['before', 'continuation', w0 - task.start])
          if (task.end > w1) expected.push(['after', 'continuation', task.end - w1])
        }
      }
      const actual = [...row.querySelectorAll('[data-roadmap-edge]')]
      checkedMarkers += actual.length
      if (actual.length !== expected.length)
        errors.push(`${task?.title || 'Project heading'} has the wrong number of edge markers`)
      for (const [side, kind, count] of expected) {
        const marker = actual.find((item) => item.dataset.edgeSide === side)
        if (
          !marker ||
          marker.dataset.roadmapEdge !== task.id ||
          marker.dataset.edgeKind !== kind ||
          marker.textContent.trim() !== ''
        )
          errors.push(`${task.title}: expected ${side} ${kind} ${count}w`)
        const badge = marker?.querySelector('.roadmap-week-count')
        if (badge) {
          const background = getComputedStyle(badge).backgroundColor
          const filled = background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent'
          if (filled !== (kind === 'continuation' || count === 0))
            errors.push(`${task.title}: ${side} ${kind} ${count}w has the wrong fill`)
        }
      }
    }
    return {
      errors,
      weeks: cells.length,
      rows: rows.length,
      markers: checkedMarkers,
      teamCells: teamCells.length,
    }
  })
  if (roadmapEdges.errors.length) await fail(`Roadmap edge badges: ${JSON.stringify(roadmapEdges)}`)
  log(
    `A: Roadmap has equal weeks and 56px edges; checked ${roadmapEdges.rows} rows, ${roadmapEdges.markers} markers and ${roadmapEdges.teamCells} aligned Team cells`,
  )
  const roadmapDependencyPin = await pageA.locator('.roadmap-view').evaluate(async (view) => {
    const body = view.querySelector('[data-scroll]')
    const overlay = body?.querySelector(':scope > div > div > svg')
    if (!body || !overlay) return { error: 'Roadmap dependency overlay is missing' }
    const settle = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const originalTop = body.scrollTop
    const originalLeft = body.scrollLeft
    const originalPointerEvents = overlay.style.pointerEvents
    const lines = Array.from(overlay.querySelectorAll(':scope > g > path:first-of-type'))
    const signature = () =>
      Array.from(overlay.querySelectorAll(':scope > g > path')).map((path) =>
        path.getAttribute('d'),
      )
    const originalPaths = JSON.stringify(signature())
    const pointAtY = (path, y) => {
      let lo = 0
      let hi = path.getTotalLength()
      const increasing = path.getPointAtLength(hi).y >= path.getPointAtLength(0).y
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2
        if (path.getPointAtLength(mid).y < y === increasing) lo = mid
        else hi = mid
      }
      return path.getPointAtLength((lo + hi) / 2)
    }
    try {
      body.scrollLeft = 0
      body.scrollTop = 0
      await settle()
      const bodyRect = body.getBoundingClientRect()
      let crossing = null
      for (const heading of body.querySelectorAll('[data-subtrack][data-roadmap-heading-top]')) {
        const naturalTop = Number(heading.dataset.roadmapHeadingTop)
        const stickyTop = Number.parseFloat(getComputedStyle(heading).top)
        const dock = naturalTop - stickyTop
        const height = heading.getBoundingClientRect().height
        if (
          dock <= 1 ||
          dock + 4 > body.scrollHeight - body.clientHeight ||
          heading.parentElement.clientHeight < height + 4
        )
          continue
        const railRight = heading.firstElementChild.getBoundingClientRect().right
        for (const path of lines) {
          const box = path.getBBox()
          if (box.y >= naturalTop || box.y + box.height <= naturalTop + height) continue
          const point = pointAtY(path, naturalTop + height / 2)
          const screen = new DOMPoint(point.x, point.y).matrixTransform(overlay.getScreenCTM())
          if (screen.x <= railRight + 3 || screen.x >= bodyRect.right - 20) continue
          crossing = { heading, path, dock, stickyTop }
          break
        }
        if (crossing) break
      }
      if (!crossing) return { error: 'No scrollable sub-project header with a dependency crossing' }
      const { heading, path, dock, stickyTop } = crossing
      // Enable stroke hit-testing only while inspecting paint order. The real
      // overlay ignores pointer events; this never edits a task or its links.
      overlay.style.pointerEvents = 'stroke'
      const inspect = async (scrollTop) => {
        body.scrollTop = scrollTop
        await settle()
        const rect = heading.getBoundingClientRect()
        const matrix = overlay.getScreenCTM()
        const localY = new DOMPoint(0, rect.top + rect.height / 2).matrixTransform(
          matrix.inverse(),
        ).y
        const point = pointAtY(path, localY)
        const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix)
        const hit = document.elementFromPoint(screen.x, screen.y)
        return {
          pinned: heading.dataset.roadmapPinned,
          headingZ: Number(getComputedStyle(heading).zIndex),
          overlayZ: Number(getComputedStyle(overlay).zIndex),
          headingTop: rect.top - body.getBoundingClientRect().top,
          arrowOnTop: overlay.contains(hit),
          headingOnTop: heading.contains(hit),
          pathsPreserved: JSON.stringify(signature()) === originalPaths,
          lineVisible:
            getComputedStyle(path).visibility === 'visible' &&
            getComputedStyle(path).display !== 'none' &&
            Number(getComputedStyle(path).opacity) > 0,
        }
      }
      const beforeTop = Math.max(0, dock - 64)
      return {
        stickyTop,
        before: await inspect(beforeTop),
        boundary: await inspect(dock),
        after: await inspect(dock + 4),
        restored: await inspect(beforeTop),
      }
    } finally {
      overlay.style.pointerEvents = originalPointerEvents
      body.scrollLeft = originalLeft
      body.scrollTop = originalTop
      await settle()
    }
  })
  const ordinaryDependencyCrossing = (stage) =>
    stage?.pinned === 'false' && stage.headingZ < stage.overlayZ && stage.arrowOnTop
  const pinnedDependencyCrossing = (stage) =>
    stage?.pinned === 'true' &&
    stage.headingZ > stage.overlayZ &&
    stage.headingOnTop &&
    Math.abs(stage.headingTop - roadmapDependencyPin.stickyTop) <= 1
  if (
    roadmapDependencyPin.error ||
    !ordinaryDependencyCrossing(roadmapDependencyPin.before) ||
    !pinnedDependencyCrossing(roadmapDependencyPin.boundary) ||
    !pinnedDependencyCrossing(roadmapDependencyPin.after) ||
    !ordinaryDependencyCrossing(roadmapDependencyPin.restored) ||
    !['before', 'boundary', 'after', 'restored'].every(
      (stage) =>
        roadmapDependencyPin[stage]?.pathsPreserved && roadmapDependencyPin[stage]?.lineVisible,
    )
  )
    await fail(
      `Roadmap dependency crossings do not follow pinned headers: ${JSON.stringify(roadmapDependencyPin)}`,
    )
  log(
    'A: dependency lines cross ordinary sub-project headings and disappear only behind pinned ones',
  )
  await pageA.goto(myTasksURL, { waitUntil: 'domcontentloaded' })
  await pageA.locator('[data-all-nav]').waitFor({ timeout: 30000 })
  log(
    'A: phone Timeline & team rotates immediately, bounds menus, retains agenda and survives rotation',
  )
  log('A: phone navigation, native/UI Back, and unclipped task sections at 320/390px')

  // Settings owns its screen, including the project modal it launches. Keep
  // this leg read-only: arm a delete but never send the confirming click.
  await pageA.goto(`${BASE}/app/${demo.orgSlug}/settings/projects`, {
    waitUntil: 'domcontentloaded',
  })
  await pageA.waitForSelector('[data-screen-label="Settings"]', { timeout: 30000 })
  const settingsBack = pageA.locator('[data-settings-back]')
  if (((await settingsBack.textContent()) || '').trim() !== 'Back') {
    await fail(`Settings exit label is not exactly "Back": ${await settingsBack.textContent()}`)
  }
  await pageA.locator('[data-new-settings-project]').click()
  await projectName.waitFor({ state: 'visible', timeout: 10000 })
  if (!(await projectName.evaluate((el) => el === document.activeElement))) {
    await fail('Settings New project did not autofocus its name field')
  }
  await pageA.keyboard.press('Escape')
  await projectName.waitFor({ state: 'detached', timeout: 5000 })
  if ((await pageA.locator('[data-screen-label="Settings"]').count()) === 0) {
    await fail('Escape from Settings New project also dismissed Settings')
  }

  // The list is the sidebar's tree (deviation #251): a project row opens its
  // branch and lights up, and its "…" menu is the way to the project's page.
  const firstProject = pageA.locator('[data-project-row]').first()
  await firstProject.click()
  if (!(await firstProject.evaluate((el) => el.hasAttribute('data-on'))))
    await fail('Opening a project row on the Projects page did not light it')
  if ((await pageA.locator('[data-subproject-row]').count()) === 0)
    await fail('Opening a project row on the Projects page revealed no sub-project rows')
  await firstProject.getByRole('button', { name: 'Project actions', exact: true }).click()
  await pageA.getByRole('button', { name: 'Project settings', exact: true }).click()
  await pageA.waitForSelector('[data-add-project-user]', { timeout: 10000 })
  const addProjectUser = (
    (await pageA.locator('[data-add-project-user]').textContent()) || ''
  ).trim()
  if (addProjectUser !== '+ Add') {
    await fail(`project Users action reads "${addProjectUser}", expected "+ Add"`)
  }
  const projectSettings = pageA.locator('.settings-content-scroll')
  if (!(await projectSettings.getByRole('textbox', { name: 'Name', exact: true }).isVisible()))
    await fail('Project settings Name field is missing')
  if ((await projectSettings.getByRole('button', { name: /project icon/i }).count()) !== 0)
    await fail('Project settings still has a project icon chooser beside Name')
  const subprojectsSection = projectSettings.getByText('Sub-projects', { exact: true })
  const projectAccessSection = projectSettings.getByText('Project access', { exact: true })
  const subprojectsBox = await subprojectsSection.boundingBox()
  const projectAccessBox = await projectAccessSection.boundingBox()
  if (!subprojectsBox || !projectAccessBox || subprojectsBox.y >= projectAccessBox.y)
    await fail('Project settings Sub-projects does not precede Project access')
  // each is the name on the border of its own outlined box (design-spec §3.2)
  for (const section of [subprojectsSection, projectAccessSection]) {
    const boxed = await section.evaluate((el) => {
      const box = el.closest('fieldset.settings-section')
      if (!box || el.tagName !== 'LEGEND') return false
      const style = getComputedStyle(box)
      return parseFloat(style.borderTopWidth) > 0 && parseFloat(style.borderLeftWidth) > 0
    })
    if (!boxed) await fail('Project settings Sub-projects and Project access are not named boxes')
  }
  const dangerZone = projectSettings.locator('fieldset.settings-danger-zone')
  if ((await dangerZone.count()) !== 1 || !(await dangerZone.locator('legend').textContent()))
    await fail('Project settings has no Danger zone box')
  log(
    'A: project forms use Name without an icon chooser; Sub-projects, Project access and Danger zone are named boxes',
  )

  await pageA.goto(`${BASE}/app/${demo.orgSlug}/settings/org-billing`, {
    waitUntil: 'domcontentloaded',
  })
  await pageA.locator('[data-billing-subscription]').waitFor({ timeout: 30000 })
  const billing = await pageA.evaluate(async () => {
    const { api } = await import('/convex/_generated/api.js')
    const { convex } = await import('/src/lib/convex.ts')
    return convex.query(api.billing.summary, { org_id: window.PLANNER.org.id })
  })
  const billableText = (await pageA.locator('[data-seat-count]').textContent()).trim()
  if (
    billableText !==
    `${billing.billable_users} active user${billing.billable_users === 1 ? '' : 's'}`
  )
    await fail(`Billing shows an incorrect active-user count: ${billableText}`)
  if (
    /\bof\b.*seats|seats used|No seats left/i.test(
      await pageA.locator('[data-billing-users]').innerText(),
    )
  )
    await fail('Billing still describes a purchased-seat cap')
  if (
    (await pageA.locator('[data-billing-checkout]').count()) !== Number(billing.checkout_available)
  )
    await fail('Billing checkout availability differs from the backend entitlement')
  if ((await pageA.locator('[data-billing-portal]').count()) !== Number(billing.portal_available))
    await fail('Billing portal availability differs from the backend subscription')
  await pageA.getByText('Who counts toward your bill', { exact: true }).click()
  for (const account of billing.billable_accounts) {
    const row = pageA.locator(`[data-billable-account="${account.profile_id}"]`)
    if ((await row.innerText()).trim() !== account.name)
      await fail('Billing billable-account row must show only the account name')
  }
  if (
    (await pageA.locator('[data-billing-inactive-count]').innerText()).trim() !==
    `${billing.inactive_users} inactive user${billing.inactive_users === 1 ? '' : 's'}`
  )
    await fail('Billing must always show the correct inactive-user counter, including zero')
  const ownBillingCount = pageA.locator('[data-billing-own-count]')
  if ((await ownBillingCount.count()) !== Number(billing.invited_users_with_own_billing > 0))
    await fail('Billing own-billing invitee counter must appear only above zero')
  if (
    billing.invited_users_with_own_billing > 0 &&
    (await ownBillingCount.innerText()).trim() !== String(billing.invited_users_with_own_billing)
  )
    await fail('Billing own-billing invitee counter is incorrect')
  await pageA.getByText('Who does not count toward your bill', { exact: true }).click()
  if (
    (await pageA.locator('[data-non-billable-account]').count()) !==
    billing.non_billable_accounts.length
  )
    await fail('Billing non-billable account list has an incorrect number of users')
  for (const account of billing.non_billable_accounts) {
    const row = pageA.locator(`[data-non-billable-account="${account.profile_id}"]`)
    if ((await row.innerText()).trim() !== account.name)
      await fail('Billing non-billable-account row must show only the account name')
  }
  if (billing.plan) {
    await pageA.locator('[data-billing-usage]').waitFor({ timeout: 15000 })
    await pageA.getByRole('button', { name: 'Refresh', exact: true }).click()
    await pageA.getByRole('button', { name: 'Refresh', exact: true }).waitFor({ timeout: 15000 })
  }
  if (await pageA.getByRole('alert').count()) await fail('Billing rendered a load or usage error')
  await pageA.screenshot({ path: `${SHOTS}/billing.png` })
  log(
    'A: Billing shows user counters, names-only billing lists and provider availability without a seat cap',
  )

  await pageA.goto(`${BASE}/app/~/settings/org-users`, { waitUntil: 'domcontentloaded' })
  await pageA.waitForSelector('[data-agent-keyline]', { timeout: 30000 })
  const newPersonName = pageA.getByRole('textbox', { name: 'New person name', exact: true })
  const newPersonEmail = pageA.locator('[data-add-email]')
  await newPersonName.fill(`Billing smoke ${STAMP}`)
  await newPersonEmail.fill(`billing-smoke-${STAMP}@example.test`)
  if (!(await pageA.locator('[data-add-user]').isEnabled()))
    await fail('Northstar still blocks a valid Add user form because no seats remain')
  await pageA.locator('[data-add-user]').hover()
  if (await pageA.getByText('No seats left — see Billing', { exact: true }).count())
    await fail('Northstar Add user still shows the obsolete no-seats message')
  await newPersonName.fill('')
  await newPersonEmail.fill('')
  log(
    'A: a valid Northstar user invitation can be added without buying seats first (not submitted)',
  )
  // Northstar has no permanent agent credential. Mint only this run's key;
  // its secret stays in the browser and cleanup revokes/deletes the row.
  const keyCreated = await pageA.evaluate(async (name) => {
    const atlas = window.PLANNER.users.find((u) => u.name === 'Atlas' && u.isAgent)
    if (!atlas) throw new Error('Northstar has no Atlas profile')
    const key = await window.PLANNER.createAgentKey(atlas.id, name)
    return Boolean(key)
  }, AGENT_KEY_NAME)
  if (!keyCreated) await fail('could not create the temporary Atlas key')
  await pageA.reload({ waitUntil: 'domcontentloaded' })
  const agentKeyline = pageA.locator('[data-agent-keyline]').first()
  await agentKeyline.waitFor({ state: 'visible', timeout: 30000 })
  await pageA.waitForFunction(
    () =>
      /^qva_[0-9a-f]{3}\.\.\.[0-9a-f]{5}(?:\s|$)/.test(
        document.querySelector('[data-agent-keyline]')?.textContent?.trim() || '',
      ),
    undefined,
    { timeout: 30000 },
  )
  const fingerprint = ((await agentKeyline.textContent()) || '').trim()
  if (!/^qva_[0-9a-f]{3}\.\.\.[0-9a-f]{5}(?:\s|$)/.test(fingerprint)) {
    await fail(`agent row has no first/last key fingerprint: "${fingerprint}"`)
  }
  const identityAlignment = await pageA.locator('[data-user-row]').evaluateAll((rows) =>
    rows.flatMap((row) => {
      const name = row.querySelector('[data-user-name]')
      const detail = row.querySelector('[data-user-email], [data-agent-keyline]')
      if (!name || !detail) return []
      const textLeft = (element) => {
        const style = getComputedStyle(element)
        return (
          element.getBoundingClientRect().left +
          Number.parseFloat(style.borderLeftWidth || '0') +
          Number.parseFloat(style.paddingLeft || '0')
        )
      }
      return [
        {
          kind: detail.hasAttribute('data-agent-keyline') ? 'agent key' : 'email',
          delta: Math.abs(textLeft(name) - textLeft(detail)),
        },
      ]
    }),
  )
  if (!identityAlignment.some(({ kind }) => kind === 'email')) {
    await fail('Settings Users alignment check found no person email row')
  }
  if (!identityAlignment.some(({ kind }) => kind === 'agent key')) {
    await fail('Settings Users alignment check found no agent key row')
  }
  for (const { kind, delta } of identityAlignment) {
    if (delta > 0.5) {
      await fail(`Settings Users ${kind} starts ${delta.toFixed(1)}px away from the user name`)
    }
  }

  await pageA.goto(`${BASE}/app/${demo.orgSlug}/settings/org-labels`, {
    waitUntil: 'domcontentloaded',
  })
  const labelDelete = pageA.locator('[data-delete-label]').first()
  await labelDelete.waitFor({ state: 'visible', timeout: 30000 })
  const settledColor = (el) =>
    Promise.all(el.getAnimations().map((animation) => animation.finished)).then(
      () => getComputedStyle(el).color,
    )
  const colorBeforeArm = await labelDelete.evaluate(settledColor)
  await labelDelete.click()
  if (((await labelDelete.textContent()) || '').trim() !== 'Delete?') {
    await fail('armed compact delete did not expand to "Delete?"')
  }
  const colorAfterArm = await labelDelete.evaluate(settledColor)
  if (colorAfterArm === colorBeforeArm) {
    await fail('armed compact delete lost its existing danger-color change')
  }
  log(
    'A: Settings labels, project creation, aligned identities, + Add, key fingerprint and Delete? verified',
  )

  await pageA.goto(`${BASE}/app/~/board/all`, { waitUntil: 'domcontentloaded' })
  await pageA.waitForSelector('[data-card]', { timeout: 30000 })
  await pageA.locator('aside').getByText('Luma Sensor', { exact: true }).click()
  // The scope heading is semantic only; the sidebar supplies visible context.
  await pageA
    .getByRole('heading', { name: 'Luma Sensor', exact: true })
    .waitFor({ state: 'attached' })
  log('A: on the Luma Sensor board')

  // ---- 2. context B signs in as Leo on the All-projects board
  await signInDemo(pageB, demo, 'leo')
  log('B: Leo signed in — All-projects board renders')

  // ---- 3. create through the real UI in A — the column supplies status,
  // while the short dialog asks only where the task goes and its title.
  const createButton = pageA.getByRole('button', { name: /^New task in / }).first()
  const createContext = await createButton.getAttribute('aria-label')
  const expectedStatus = await pageA.evaluate(
    (label) =>
      window.PLANNER.STATUSES.find((status) => `New task in ${status.name}` === label)?.id ||
      'backlog',
    createContext,
  )
  await createButton.click()
  const newTask = pageA.getByRole('dialog', { name: 'New task', exact: true })
  const taskTitle = newTask.getByRole('textbox', { name: 'Title', exact: true })
  await taskTitle.waitFor({ timeout: 10000 })
  const fields = await newTask
    .locator('input:not([type="hidden"]), select, textarea, [contenteditable="true"]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')))
  if (JSON.stringify(fields) !== JSON.stringify(['Project', 'Sub-project', 'Title'])) {
    await fail(`New task fields do not match Project, Sub-project, Title: ${fields}`)
  }
  if (!(await taskTitle.evaluate((element) => element === document.activeElement))) {
    await fail('New task did not focus Title')
  }
  const submitTask = newTask.getByRole('button', { name: 'Create', exact: true })
  await taskTitle.fill('   ')
  if (!(await submitTask.isDisabled())) await fail('New task accepts a whitespace-only title')
  await taskTitle.fill(TITLE)
  const projectPicker = newTask.getByRole('combobox', { name: 'Project', exact: true })
  const subprojectPicker = newTask.getByRole('combobox', { name: 'Sub-project', exact: true })
  const originalProject = await projectPicker.inputValue()
  const subProj = await subprojectPicker.inputValue()
  if (!subProj) await fail('New task offers no sub-project')
  const otherProject = await projectPicker
    .locator('option')
    .evaluateAll(
      (options, original) => options.find((option) => option.value !== original)?.value,
      originalProject,
    )
  if (!otherProject) await fail('Northstar has no second writable project for the create picker')
  await projectPicker.selectOption(otherProject)
  const switchedSubproject = await subprojectPicker.inputValue()
  const switchedCorrectly = await pageA.evaluate(
    ({ project, subproject }) => window.PLANNER.project(subproject)?.parent === project,
    { project: otherProject, subproject: switchedSubproject },
  )
  if (!switchedCorrectly) await fail('Changing Project left Sub-project in the previous project')
  await projectPicker.selectOption(originalProject)
  await subprojectPicker.selectOption(subProj)
  if ((await taskTitle.inputValue()) !== TITLE) await fail('Changing Project lost the task title')
  await submitTask.click()
  await newTask.waitFor({ state: 'detached' })
  await pageA.waitForSelector('[data-issue-key]', { timeout: 10000 })
  // Radix restores focus after the create dialog unmounts; wait for the
  // handoff to land in the task window instead of the covered Board button.
  await pageA.waitForFunction(() =>
    document.querySelector('[data-task-scrim]')?.contains(document.activeElement),
  )
  log('A: three-field New task dialog opened and focused the task window automatically')

  await pageA.waitForSelector('text=/Created QN-\\d+/', { timeout: 10000 })
  const toastText = await pageA.locator('text=/Created QN-\\d+/').first().textContent()
  const key = (toastText.match(/QN-\d+/) || [])[0]
  if (!key) await fail(`create toast carried no QN key: ${toastText}`)
  log(`A: create toast — ${toastText.trim().slice(0, 60)} (key ${key})`)

  await pageA.waitForSelector(`text=${TITLE}`, { timeout: 10000 })
  const revertedA = await pageA.locator('text=reverted').count()
  if (revertedA) await fail('a "— reverted" toast fired during the create')
  await noDisabledCopy(pageA, 'A after create')
  await pageA.screenshot({ path: `${SHOTS}/smoke-board.png` })
  log('A: created task window — screenshot smoke-board.png')

  // ---- 4. realtime leg: B sees the issue arrive WITHOUT reload
  await pageB.waitForSelector(`text=${TITLE}`, { timeout: 15000 })
  log('B: issue arrived without reload')

  // ---- 5. Create already opened the editor; its header and URL name the key
  await pageA.waitForSelector('[data-issue-key]', { timeout: 10000 })
  const shownKey = ((await pageA.locator('[data-issue-key]').first().textContent()) || '').trim()
  if (shownKey !== key) await fail(`detail shows ${shownKey}, toast said ${key}`)
  if (!pageA.url().toLowerCase().includes(`/tasks/${key.toLowerCase()}`)) {
    await fail(`task URL does not carry the key: ${pageA.url()}`)
  }
  log(`A: detail header shows ${shownKey}`)

  // ---- 6. persistence leg: reload lands on the same key
  await pageA.reload({ waitUntil: 'domcontentloaded' })
  await pageA.waitForSelector('[data-issue-key]', { timeout: 30000 })
  const keyAfter = ((await pageA.locator('[data-issue-key]').first().textContent()) || '').trim()
  if (keyAfter !== key) await fail(`after reload the detail shows ${keyAfter}, expected ${key}`)
  log(`A: reload persisted ${key}`)

  const reporter = pageA.locator('[data-task-reporter]')
  await reporter.waitFor()
  if (
    (await pageA.getByText('Created by', { exact: true }).count()) ||
    (await pageA.getByRole('button', { name: 'Reporter', exact: true }).count()) ||
    (await pageA.getByRole('combobox', { name: 'Reporter', exact: true }).count()) ||
    (await reporter.locator('button, input, select, [role="combobox"]').count())
  ) {
    await fail('Task details show Created by or offer a Reporter editor')
  }
  const savedReporter = await pageA.evaluate(async (title) => {
    const { convex } = await import('/src/lib/convex.ts')
    const snapshot = await convex.query('snapshot:forMe', {})
    const task = snapshot.issues.find((row) => row.title === title)
    if (!task) throw new Error('Created task is absent from the saved snapshot')
    const actor = snapshot.profiles.find((row) => row.id === task.created_by)
    return {
      reporter: task.reporter_id,
      actor: actor?.id,
      name: actor?.name,
      project: task.project_id,
      status: task.status,
      priority: task.priority,
      assignee: task.assignee_id ?? null,
      reviewer: task.reviewer_id ?? null,
      remaining: task.remaining_hours ?? null,
      parent: task.parent_id ?? null,
      start: task.start_week ?? null,
      end: task.end_week ?? null,
      due: task.due_date ?? null,
      description: task.description,
    }
  }, TITLE)
  if (
    savedReporter.project !== subProj ||
    savedReporter.status !== expectedStatus ||
    savedReporter.priority !== 'low' ||
    savedReporter.assignee !== null ||
    savedReporter.reviewer !== null ||
    savedReporter.remaining !== null ||
    savedReporter.parent !== null ||
    savedReporter.start !== null ||
    savedReporter.end !== null ||
    savedReporter.due !== null ||
    savedReporter.description
  ) {
    await fail(
      'Created task did not persist the chosen destination, column status and empty defaults',
    )
  }
  log('A: new task destination, column status and defaults persisted')
  const currentProfile = await pageA.evaluate(() => window.PLANNER.CURRENT_USER)
  if (
    savedReporter.reporter !== currentProfile ||
    savedReporter.actor !== currentProfile ||
    !savedReporter.name ||
    (await reporter.getByText(savedReporter.name, { exact: true }).count()) !== 1
  ) {
    await fail('Reporter does not display the signed-in user saved at task creation')
  }
  log('A: Reporter is the saved signed-in user, read-only, with no Created by field')

  // Reviewer leg, on the temporary task only: the row follows Assignee, and
  // moving the task into Review hands it to the reviewer with the project's
  // review time. The signed-in user reviews it, so nobody else is messaged.
  const taskWindow = pageA.locator('[data-task-scrim]')
  const picker = (name) => taskWindow.getByRole('combobox', { name, exact: true })
  // A menu row's accessible name repeats its glyph's label, so pick by the
  // row's visible text instead.
  const pickFieldOption = async (name, label) => {
    await picker(name).click()
    const menu = pageA.locator('[data-fieldselect-menu]')
    await menu
      .getByRole('option')
      .filter({ has: pageA.getByText(label, { exact: true }) })
      .click()
    await menu.waitFor({ state: 'detached', timeout: 5000 })
  }
  if ((await picker('Assignee').count()) !== 1 || (await picker('Reviewer').count()) !== 1) {
    await fail('Task details do not show one Assignee and one Reviewer picker')
  }
  const reviewerFollowsAssignee = await pageA.evaluate(() => {
    const field = (name) =>
      document
        .querySelector(`[data-task-scrim] [role="combobox"][aria-label="${name}"]`)
        ?.closest('.task-field')
    const assignee = field('Assignee')
    return !!assignee && assignee.nextElementSibling === field('Reviewer')
  })
  if (!reviewerFollowsAssignee) await fail('The Reviewer row does not directly follow Assignee')
  log('A: Reviewer picker sits directly under Assignee')
  await pickFieldOption('Reviewer', savedReporter.name)
  log(`A: picked ${savedReporter.name} as reviewer`)
  await pickFieldOption('Status', 'In Review')
  log('A: moved the task to In Review')
  const reviewed = await pageA.evaluate(
    async ({ title, me }) => {
      const { convex } = await import('/src/lib/convex.ts')
      const deadline = Date.now() + 15000
      for (;;) {
        const snapshot = await convex.query('snapshot:forMe', {})
        const task = snapshot.issues.find((row) => row.title === title)
        if (task && task.reviewer_id === me && task.status === 'review') {
          const sub = snapshot.projects.find((row) => row.id === task.project_id)
          const parent = sub?.parent_id
            ? snapshot.projects.find((row) => row.id === sub.parent_id)
            : undefined
          return {
            remaining: task.remaining_hours ?? null,
            stamped: !!task.remaining_set_at,
            expected: sub?.review_hours ?? parent?.review_hours ?? 2,
          }
        }
        if (Date.now() > deadline) return null
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    },
    { title: TITLE, me: currentProfile },
  )
  if (!reviewed) await fail('The saved task never carried the chosen reviewer and In Review')
  log(`A: saved task is In Review with ${savedReporter.name} as reviewer`)
  if (reviewed.remaining !== reviewed.expected || !reviewed.stamped) {
    await fail(
      `Entering Review saved ${reviewed.remaining} h (stamped: ${reviewed.stamped}), expected the review time ${reviewed.expected} h`,
    )
  }
  const shownRemaining = await pageA.locator('[data-remaining-input]').inputValue()
  if (Number(shownRemaining) !== reviewed.expected || shownRemaining === '') {
    await fail(`Remaining shows "${shownRemaining}", expected ${reviewed.expected}`)
  }
  log(`A: entering Review set Remaining to the review time, ${reviewed.expected} h, with a stamp`)

  // A nested Select owns the first Escape. Radix portals its list outside the
  // task window, so this guards against one keypress dismissing both layers.
  const taskUrl = pageA.url()
  await pageA.locator('[data-fieldselect]').first().click()
  await pageA.waitForSelector('[data-fieldselect-menu]', { timeout: 5000 })
  await pageA.keyboard.press('Escape')
  await pageA.waitForSelector('[data-fieldselect-menu]', { state: 'detached', timeout: 5000 })
  if (pageA.url() !== taskUrl || (await pageA.locator('[data-issue-key]').count()) === 0) {
    await fail('Escape from a task field select also dismissed the task window')
  }
  log('A: nested Escape closed the field select and kept the task window open')

  // ---- 7a. upload through the REAL Attachments drawer input (the hidden
  // input[type=file][multiple] behind "browse" — IssueDetail AttachmentsSection)
  const uploadingSeen = pageA
    .waitForSelector('text=/Uploading .*…/', { timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  await pageA.setInputFiles('input[type="file"][multiple]', {
    name: PNG_NAME,
    mimeType: 'image/png',
    buffer: PNG,
  })
  const sawUploading = await uploadingSeen
  await pageA.waitForSelector(`button[data-attachment-open="${PNG_NAME}"]`, { timeout: 20000 })
  log(
    `A: attachment row for ${PNG_NAME} rendered (transient "Uploading…" ${sawUploading ? 'seen' : 'too fast to catch'})`,
  )

  // the store row: exact server-recorded size must equal the bytes we sent
  const att = await pageA.evaluate((k) => {
    const it = window.PLANNER.issues.find((i) => i.key === k)
    const a = it?.attachments?.[0]
    return a ? { id: a.id, name: a.name, size: a.size, mime: a.mime } : null
  }, key)
  if (!att) await fail('no attachment row in the store after upload')
  if (att.name !== PNG_NAME) await fail(`attachment name ${att.name}, expected ${PNG_NAME}`)
  if (att.size !== PNG.length)
    await fail(`server size_bytes ${att.size}, uploaded ${PNG.length} (byte identity broken)`)
  log(`A: store row ${att.id} — name+size exact (${att.size} bytes, mime ${att.mime})`)
  await pageA.screenshot({ path: `${SHOTS}/smoke-attachment.png` })

  // ---- 7b. serve: minted /files/ URL answers 200 with the EXACT bytes
  // (cross-origin fetch from the app origin — this is also the CORS proof)
  const served = await pageA.evaluate(async (attId) => {
    const u = await window.PLANNER.attachmentUrl(attId)
    if (!u) return { err: 'attachmentUrl returned null' }
    const r = await fetch(u)
    const buf = await r.arrayBuffer()
    return {
      u,
      status: r.status,
      len: buf.byteLength,
      ct: r.headers.get('content-type'),
      cc: r.headers.get('cache-control'),
      bytes: Array.from(new Uint8Array(buf)),
    }
  }, att.id)
  if (served.err) await fail(served.err)
  if (!/\/files\//.test(served.u))
    await fail(`minted URL is not a /files/ gateway URL: ${served.u}`)
  if (served.status !== 200) await fail(`gateway answered ${served.status} for a fresh mint`)
  if (served.len !== PNG.length) await fail(`served ${served.len} bytes, uploaded ${PNG.length}`)
  if (served.ct !== 'image/png') await fail(`served content-type ${served.ct}`)
  if (Buffer.compare(Buffer.from(served.bytes), PNG) !== 0)
    await fail('served bytes are not the PNG we sent')
  log(`A: /files/ serve — 200, ${served.len} bytes exact, image/png, cache-control "${served.cc}"`)
  log(`   url ${served.u.slice(0, 110)}…`)

  // The organization export must contain the real attachment bytes, not
  // expiring URLs, and preserve the row/UUID relationship in its JSON files.
  await pageA.goto(`${BASE}/app/${demo.orgSlug}/settings/org-general`, {
    waitUntil: 'domcontentloaded',
  })
  const exportTimeout = 120000
  const exportAlert = pageA.locator('[data-org-export] [role="alert"]')
  const [result] = await Promise.all([
    Promise.race([
      pageA
        .waitForEvent('download', { timeout: exportTimeout })
        .then((download) => ({ kind: 'downloaded', download })),
      exportAlert.waitFor({ state: 'visible', timeout: exportTimeout }).then(async () => ({
        kind: 'failed',
        message: (await exportAlert.textContent())?.trim(),
      })),
    ]),
    pageA.locator('[data-export-download]').click(),
  ])
  if (result.kind === 'failed') {
    await fail(`Organization export failed: ${result.message || 'unknown error'}`)
  }
  const exported = result.download
  if (!exported.suggestedFilename().endsWith('.zip')) await fail('Export did not download a ZIP')
  const stream = await exported.createReadStream()
  if (!stream) await fail('Export download is unavailable')
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const zip = unzipSync(Buffer.concat(chunks))
  const manifest = JSON.parse(strFromU8(zip['manifest.json']))
  const exportedTasks = JSON.parse(strFromU8(zip['data/tasks.json']))
  const exportedAttachments = JSON.parse(strFromU8(zip['data/task_attachments.json']))
  const exportedProfiles = JSON.parse(strFromU8(zip['data/profiles.json']))
  const exportedTask = exportedTasks.find((task) => task.title === TITLE)
  const exportedAttachment = exportedAttachments.find((attachment) => attachment.id === att.id)
  const file = manifest.files.find((item) => item.kind === 'attachment' && item.id === att.id)
  if (
    manifest.format !== 'qivo-organization-export' ||
    manifest.version !== 2 ||
    manifest.organization.slug !== demo.orgSlug ||
    !exportedTask ||
    exportedAttachment?.task_id !== exportedTask.id ||
    !file ||
    !zip[file.path] ||
    Buffer.compare(Buffer.from(zip[file.path]), PNG) !== 0
  )
    await fail('Organization ZIP did not preserve its task, attachment record and exact bytes')
  if (exportedProfiles.some((profile) => 'auth_user_id' in profile))
    await fail('Organization export exposed account identity references')
  if (zip['data/messages.json'] || zip['data/user_prefs.json'] || zip['data/mcp_tokens.json'])
    await fail('Organization export included private account data')
  await pageA.screenshot({ path: `${SHOTS}/smoke-export.png` })
  log('A: organization ZIP contains task JSON and exact uploaded bytes; personal data excluded')

  // ---- 8. cleanup: A deletes the smoke issue (cascade reaps the attachment's
  // bytes); B watches it leave WITHOUT reload — the delete is fire-and-forget
  // on the client, so B's removal doubles as the ordering proof
  const gone = await pageA.evaluate((k) => window.PLANNER.deleteIssue(k), key)
  void gone
  await pageB.waitForFunction((t) => !document.body.innerText.includes(t), TITLE, {
    timeout: 15000,
  })
  log(`A deleted ${key}; B saw it leave without reload`)

  await pageB.goto(`${BASE}/app/${demo.orgSlug}/settings/org-general`, {
    waitUntil: 'domcontentloaded',
  })
  await pageB.locator('[data-settings-page]').waitFor({ state: 'visible', timeout: 30000 })
  if (await pageB.locator('[data-export-download]').count())
    await fail('A non-admin can see the organization export control')

  // ---- 8b. Team sync, on temporaries only. Every change made from a row
  // stamps the page owner's last sync (profiles.sync_at), and no client
  // write can put an older stamp back, so the stamp lands on a temporary
  // AGENT that the leg removes, with its stamp, afterwards: a real person's
  // stamp never moves. The agent joins every Northstar team (each meta
  // project grants its own team Edit) so it can hold an In Progress task,
  // which sits On it on the agents step. The first smoke task is gone, so
  // this one reuses TITLE; after a failure the finally cleanup deletes it
  // with the other temporaries and removes the agent by its run-unique name.
  const syncTaskId = randomUUID()
  const syncAgentId = randomUUID()
  const stampsBefore = await pageA.evaluate(
    async ({ id, agent, name, title, project }) => {
      const P = window.PLANNER
      const { convex } = await import('/src/lib/convex.ts')
      const snapshot = await convex.query('snapshot:forMe', {})
      await convex.mutation('profiles:create', {
        org_id: P.org.id,
        id: agent,
        name,
        email: null,
        org_role: 'user',
        kind: 'agent',
        color: '#475569',
        teams: snapshot.teams.filter((t) => t.org_id === P.org.id).map((t) => t.id),
      })
      await convex.mutation('issues:create', {
        org_id: P.org.id,
        id,
        project_id: project,
        title,
        status: 'progress',
        priority: 'low',
        assignee_id: agent,
      })
      return Object.fromEntries(
        snapshot.profiles.map((row) => [row.id, `${row.sync_at ?? ''}|${row.sync_since ?? ''}`]),
      )
    },
    { id: syncTaskId, agent: syncAgentId, name: SYNC_AGENT, title: TITLE, project: subProj },
  )
  // The bare address opens the saved scope on the team opening and names
  // that scope in place, with the sidebar row lit.
  await pageA.goto(`${BASE}/app/${demo.orgSlug}/sync`, { waitUntil: 'domcontentloaded' })
  await pageA.locator('[data-sync-opening]').waitFor({ timeout: 30000 })
  await pageA.waitForURL(new RegExp(`/app/${demo.orgSlug}/sync/(all|p/\\d+|team/[0-9a-f-]+)$`))
  if (!(await pageA.locator('[data-sync-nav][aria-current="page"]').count()))
    await fail('The sidebar Team sync row is not lit on the page')
  log('A: Team sync opened on the team opening at its saved scope')
  // All projects holds the task whatever scope is saved; opening it by
  // address saves nothing, so the user's saved scope stays as it was.
  await pageA.goto(`${BASE}/app/${demo.orgSlug}/sync/all`, { waitUntil: 'domcontentloaded' })
  const syncKey = await pageA.evaluate(
    async ({ id, agent }) => {
      const P = window.PLANNER
      const deadline = Date.now() + 30000
      for (;;) {
        const it = P.issues.find((row) => row.uuid === id)
        if (it && P.users.some((u) => u.id === agent && u.isAgent)) return it.id
        if (Date.now() > deadline) return null
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    },
    { id: syncTaskId, agent: syncAgentId },
  )
  if (!syncKey) await fail('The temporary Team sync task or agent never reached the store')
  // An agent in the rail opens the agents step with that agent expanded.
  const depth = await pageA.evaluate(() => history.length)
  await pageA.locator(`[data-sync-rail] [data-sync-jump="${syncAgentId}"]`).click()
  const syncAgent = pageA.locator(`[data-sync-agent="${syncAgentId}"]`)
  await syncAgent
    .locator(`[data-sync-agent-toggle][aria-expanded="true"]`)
    .waitFor({ timeout: 10000 })
  await pageA.waitForURL(`**/app/${demo.orgSlug}/sync/all/agents`)
  if ((await pageA.evaluate(() => history.length)) !== depth)
    await fail('Stepping to the agents pushed a history entry instead of replacing the address')
  const syncCard = syncAgent.locator(`[data-sync-col="onit"] [data-sync-card="${syncKey}"]`)
  await syncCard.waitFor({ timeout: 15000 })
  if (!(await syncCard.getByText('no estimate', { exact: true }).count()))
    await fail('A task with Remaining unset is not marked "no estimate" on the sync')
  log(`A: the rail opened the agents step in place, ${SYNC_AGENT} open; ${syncKey} is On it`)
  const syncInput = syncCard.locator('[data-sync-input]')
  await syncInput.fill('4')
  await syncInput.press('Enter')
  // The edit stamps the agent, the page owner, not A who made it: a first
  // stamp carries the reading day it started from, and nobody else's stamp
  // moves.
  const synced = await pageA.evaluate(
    async ({ id, agent, before }) => {
      const { convex } = await import('/src/lib/convex.ts')
      const deadline = Date.now() + 15000
      for (;;) {
        const snapshot = await convex.query('snapshot:forMe', {})
        const task = snapshot.issues.find((row) => row.id === id)
        const stamp = snapshot.profiles.find((row) => row.id === agent)
        if (task?.remaining_hours === 4 && task.remaining_set_at && stamp?.sync_at) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp.sync_since ?? ''))
            return "The agent's first stamp does not carry its reading day"
          const moved = snapshot.profiles.filter(
            (row) =>
              row.id !== agent &&
              (before[row.id] ?? '|') !== `${row.sync_at ?? ''}|${row.sync_since ?? ''}`,
          )
          return moved.length ? `The sync row edit stamped ${moved.map((row) => row.name)}` : ''
        }
        if (Date.now() > deadline)
          return 'The sync row edit did not save Remaining 4 h and stamp the agent'
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    },
    { id: syncTaskId, agent: syncAgentId, before: stampsBefore },
  )
  if (synced) await fail(synced)
  await syncCard.getByText('no estimate', { exact: true }).waitFor({ state: 'detached' })
  if ((await syncCard.locator('[data-sync-tick]').getAttribute('data-sync-reviewed')) !== '1')
    await fail('Editing Remaining on the sync did not tick the row')
  const syncProgress = ((await pageA.locator('[data-sync-progress]').textContent()) || '').trim()
  if (!/^1 of \d+ tasks? reviewed$/.test(syncProgress))
    await fail(`The sync footer reads "${syncProgress}" after one edited row`)
  log('A: the row saved Remaining 4 h, ticked itself and stamped only the agent')
  // Delete the task, then remove the agent and its stamp with it.
  await pageA.evaluate((k) => window.PLANNER.deleteIssue(k), syncKey)
  await syncCard.waitFor({ state: 'detached', timeout: 15000 })
  const syncGone = await pageA.evaluate(
    async ({ id, agent }) => {
      const P = window.PLANNER
      const { convex } = await import('/src/lib/convex.ts')
      const saved = async (test) => {
        const deadline = Date.now() + 15000
        for (;;) {
          if (test(await convex.query('snapshot:forMe', {}))) return true
          if (Date.now() > deadline) return false
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
      if (!(await saved((s) => !s.issues.some((row) => row.id === id))))
        return 'The temporary Team sync task is still saved after its delete'
      await convex.mutation('profiles:remove', { org_id: P.org.id, id: agent })
      if (!(await saved((s) => !s.profiles.some((row) => row.id === agent))))
        return 'The temporary Team sync agent is still saved after its removal'
      return ''
    },
    { id: syncTaskId, agent: syncAgentId },
  )
  if (syncGone) await fail(syncGone)
  await syncAgent.waitFor({ state: 'detached', timeout: 15000 })
  log(`A deleted ${syncKey} and removed ${SYNC_AGENT}; both left the page and the saved snapshot`)

  // ---- 9. final sweeps + sign-out both
  await noDisabledCopy(pageA, 'A final')
  await noDisabledCopy(pageB, 'B final')
  if (badLogs.length) await fail(`bad console/page output:\n${badLogs.join('\n')}`)
  await pageA.evaluate(() => window.PLANNER.signOut())
  await pageA.waitForSelector('input[type="email"]', { timeout: 20000 })
  await pageB.evaluate(() => window.PLANNER.signOut())
  await pageB.waitForSelector('input[type="email"]', { timeout: 20000 })
  if (
    (await pageA.locator('[data-appearance-background]').count()) ||
    (await pageB.locator('[data-appearance-background]').count())
  )
    await fail('Signing out left an account background visible on the sign-in screen')
  log('both contexts signed out — AuthGate form back')
  passed = true
} catch (e) {
  console.error('[smoke] FAIL:', e?.message || 'Browser drive failed')
  await pageA.screenshot({ path: `${SHOTS}/smoke-failure.png` }).catch(() => {})
  await pageB.screenshot({ path: `${SHOTS}/smoke-failure-b.png` }).catch(() => {})
} finally {
  try {
    if (appearanceNeedsRestore && appearanceBefore) {
      const restoreContext = await browser.newContext()
      try {
        const restorePage = await restoreContext.newPage()
        await signInDemo(restorePage, demo, 'nora')
        await restorePage.evaluate(async (original) => {
          const { convex } = await import('/src/lib/convex.ts')
          await convex.mutation('appearance:save', original)
        }, appearanceBefore)
      } finally {
        await restoreContext.close()
      }
    }
    await cleanupDemoArtifacts(browser, demo, {
      issueTitle: TITLE,
      agentKeyName: AGENT_KEY_NAME,
      agentName: SYNC_AGENT,
    })
    const after = await inspectBrowserDemo(demo)
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      passed = false
      console.error('[smoke] Northstar counts or anchor changed after cleanup')
    } else {
      log(
        'temporary tasks, attachment, agent key and agent removed; Northstar counts and dates preserved',
      )
    }
  } catch (e) {
    passed = false
    console.error('[smoke] cleanup failed:', e?.message || 'Unknown cleanup failure')
  }
  await browser.close()
}
if (passed) log('PASS')
process.exitCode = passed ? 0 : 1

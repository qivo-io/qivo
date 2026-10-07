/* Inbox snooze regression against the Northstar development demo.
 * Usage: node scripts/inbox-snooze-smoke.mjs [baseURL]
 * Requires a running dev server whose backend carries the snooze functions.
 * Drives the row menu's Hours/Days steppers, Show snoozed, Unsnooze, a
 * two-window sync, the phone actions button and one REAL scheduled wake (a
 * 20-second snooze through the API). Touches only Nora's own inbox rows and
 * puts every one of them back: unsnoozed, and read again if it was read. */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { loadBrowserDemo, signInBrowser, signInDemo } from './browser-demo.mjs'

const SHOTS = 'scripts/shots'
mkdirSync(SHOTS, { recursive: true })
const demo = loadBrowserDemo(process.argv[2] ?? 'http://localhost:5199')
const BASE = demo.base
const log = (m) => console.log(`[inbox-snooze] ✔ ${m}`)
const fail = (m) => {
  console.error(`[inbox-snooze] ✘ ${m}`)
  process.exitCode = 1
  throw new Error(m)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const groups = (page) =>
  page.evaluate(() =>
    window.PLANNER.messageGroups.map((g) => ({
      id: g.id,
      title: g.issueTitle,
      read: g.read,
      snoozed: g.snoozed,
      snoozedUntil: g.snoozedUntil,
      wokeAt: g.wokeAt,
      ids: g.ids,
    })),
  )
const unreadBadge = (page) => page.evaluate(() => window.PLANNER.unreadMessages)
const openInbox = async (page) => {
  await page.goto(`${BASE}/app/~/inbox`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('h1:has-text("Inbox")', { timeout: 30000 })
  await page.waitForSelector('[data-message]', { timeout: 30000 })
}

const browser = await chromium.launch()
const restore = [] // { ids, read } for every row this drive touched
let ctxA
let ctxB
let ctxPhone
let pageA
try {
  ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  const A = await ctxA.newPage()
  pageA = A
  await signInDemo(A, demo)
  await openInbox(A)

  // ---- 1. snooze 2 days from the row menu (desktop) -----------------------
  let list = await groups(A)
  const target = list[0]
  restore.push({ ids: target.ids, read: target.read })
  const badgeBefore = await unreadBadge(A)
  await A.click(`[data-message="${target.id}"]`, { button: 'right' })
  await A.waitForSelector('[data-msg-menu]')
  if ((await A.locator('[data-msg-menu-snooze]').textContent())?.trim() !== 'Snooze')
    fail('the Snooze heading is missing or not sentence case')
  const days = A.locator('[data-msg-snooze-row="days"]')
  if ((await days.locator('[data-msg-snooze-count]').textContent()) !== '1')
    fail('Days does not start at 1')
  if (!(await days.getByLabel('Fewer days').isDisabled())) fail('minus is not disabled at 1')
  await days.getByLabel('More days').click()
  if ((await days.locator('[data-msg-snooze-count]').textContent()) !== '2')
    fail('plus did not step Days to 2')
  if ((await A.locator('[data-msg-menu]').count()) !== 1) fail('stepping closed the menu')
  await days.getByLabel('More days').hover()
  await A.screenshot({ path: `${SHOTS}/inbox-snooze-1-menu.png` })
  await days.locator('[data-msg-snooze-go]').click()
  await A.waitForSelector(`[data-message="${target.id}"]`, { state: 'detached', timeout: 10000 })
  await A.waitForFunction(
    (id) => window.PLANNER.messageGroups.find((g) => g.id === id)?.snoozed === true,
    target.id,
  )
  list = await groups(A)
  const snoozed = list.find((g) => g.id === target.id)
  const expectMs = Date.now() + 2 * 86_400_000
  if (Math.abs(snoozed.snoozedUntil - expectMs) > 60_000)
    fail(`snoozedUntil is not ~2 days out: ${snoozed.snoozedUntil}`)
  if (snoozed.read) fail('the snoozed row is not unread')
  if ((await A.locator('[data-msg-menu]').count()) !== 0) fail('the menu stayed open after Snooze')
  const badgeAfter = await unreadBadge(A)
  if (badgeAfter !== badgeBefore - (target.read ? 0 : 1))
    fail(`badge went ${badgeBefore} → ${badgeAfter}`)
  log(
    `snoozed "${target.title}" for 2 days: row hidden, unread, badge ${badgeBefore} → ${badgeAfter}`,
  )
  await A.screenshot({ path: `${SHOTS}/inbox-snooze-2-list.png` })

  // ---- 2. Show snoozed, the sleeping row, Unsnooze -------------------------
  await A.click('[data-inbox-filter]')
  await A.click('[data-inbox-show-snoozed]')
  await A.keyboard.press('Escape')
  await A.waitForSelector(`[data-message="${target.id}"][data-snoozed]`, { timeout: 10000 })
  const untilText = (
    await A.locator(`[data-message="${target.id}"] [data-msg-until]`).textContent()
  )?.trim()
  if (!untilText) fail('the sleeping row shows no return time')
  if (!(await A.locator('[data-inbox-filter]').textContent())?.includes('(1)'))
    fail('Filter does not count Show snoozed')
  await A.screenshot({ path: `${SHOTS}/inbox-snooze-3-show-snoozed.png` })
  log(`Show snoozed lists it, dimmed, with "${untilText}"`)
  // opening the sleeping row must not read it
  await A.click(`[data-message="${target.id}"] .inbox-message-open`)
  await A.waitForSelector('[data-inbox-detail], [data-issue-detail], .inbox-detail-frame', {
    timeout: 10000,
  })
  await sleep(800)
  list = await groups(A)
  if (list.find((g) => g.id === target.id).read) fail('opening a sleeping row marked it read')
  log('opening the sleeping row left it unread')
  // the pane reads the task it holds the moment the row wakes (the app's
  // rule for news arriving while you look at a task), so clear it first
  await A.keyboard.press('Escape')
  await A.waitForFunction(() => !location.pathname.includes('/tasks/'))
  await A.click(`[data-message="${target.id}"]`, { button: 'right' })
  await A.waitForSelector('[data-msg-menu-unsnooze]')
  const unsnoozeText = (await A.locator('[data-msg-menu-unsnooze]').textContent())?.trim()
  if (!/^Unsnooze\s*until /.test(unsnoozeText)) fail(`Unsnooze row reads "${unsnoozeText}"`)
  if ((await A.locator('[data-msg-snooze-row]').count()) !== 0)
    fail('steppers shown on a sleeping row')
  await A.screenshot({ path: `${SHOTS}/inbox-snooze-4-unsnooze.png` })
  await A.click('[data-msg-menu-unsnooze]')
  await A.waitForFunction(
    (id) => window.PLANNER.messageGroups.find((g) => g.id === id)?.snoozed === false,
    target.id,
  )
  list = await groups(A)
  const back = list.find((g) => g.id === target.id)
  if (back.read || back.snoozed || back.wokeAt !== null)
    fail('Unsnooze did not return the row unread without a wake stamp')
  log(`Unsnooze: "${unsnoozeText}" → back, unread`)
  await A.click('[data-inbox-filter]')
  await A.click('[data-inbox-show-snoozed]')
  await A.keyboard.press('Escape')

  // ---- 3. two windows: snooze in A, gone in B; unsnooze in B, back in A ----
  ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  const B = await ctxB.newPage()
  await signInDemo(B, demo)
  await openInbox(B)
  const second = (await groups(A)).find((g) => !g.snoozed && g.id !== target.id) ?? target
  restore.push({ ids: second.ids, read: second.read })
  await B.waitForSelector(`[data-message="${second.id}"]`)
  await A.click(`[data-message="${second.id}"]`, { button: 'right' })
  await A.waitForSelector('[data-msg-snooze-row="hours"]')
  await A.locator('[data-msg-snooze-row="hours"] [data-msg-snooze-go]').click()
  await B.waitForSelector(`[data-message="${second.id}"]`, { state: 'detached', timeout: 15000 })
  log(`window B lost "${second.title}" when A snoozed it (no reload)`)
  await B.click('[data-inbox-filter]')
  await B.click('[data-inbox-show-snoozed]')
  await B.keyboard.press('Escape')
  await B.click(`[data-message="${second.id}"]`, { button: 'right' })
  await B.waitForSelector('[data-msg-menu-unsnooze]')
  await B.click('[data-msg-menu-unsnooze]')
  await A.waitForSelector(`[data-message="${second.id}"]`, { timeout: 15000 })
  log('window A regained it when B unsnoozed')
  await B.close()
  await ctxB.close()
  ctxB = null

  // ---- 4. the real scheduled wake: a 20-second snooze through the API ------
  const third = (await groups(A)).find((g) => !g.snoozed) ?? target
  if (!restore.some((r) => r.ids.join() === third.ids.join()))
    restore.push({ ids: third.ids, read: third.read })
  const wakeAt = new Date(Date.now() + 20_000).toISOString()
  await A.evaluate(
    async ({ ids, until }) => {
      const { convex } = await import('/src/lib/convex.ts')
      const org = window.PLANNER.org
      await convex.mutation('messages:snooze', { org_id: org.id, ids, until })
    },
    { ids: third.ids, until: wakeAt },
  )
  await A.waitForSelector(`[data-message="${third.id}"]`, { state: 'detached', timeout: 15000 })
  await A.evaluate(() => {
    window.__qivoNotes = []
  })
  const t0 = Date.now()
  await A.waitForSelector(`[data-message="${third.id}"]`, { timeout: 60000 })
  const woke = (await groups(A)).find((g) => g.id === third.id)
  if (woke.snoozed || woke.read || !woke.wokeAt)
    fail('the wake did not return the row unread with a wake stamp')
  if ((await groups(A))[0].id !== third.id) fail('the woken row is not at the top of the list')
  const notes = await A.evaluate(() => window.__qivoNotes ?? [])
  if (!notes.some((n) => n.title.startsWith('Back from snooze, ')))
    fail(`no wake notification: ${JSON.stringify(notes)}`)
  log(
    `server wake returned "${third.title}" ${Math.round((Date.now() - t0) / 1000)}s after the stamp: unread, on top, announced`,
  )
  await A.screenshot({ path: `${SHOTS}/inbox-snooze-5-after-wake.png` })

  // ---- 5. phone layout: the row's actions button opens the same menu -------
  ctxPhone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  })
  const M = await ctxPhone.newPage()
  // signInDemo waits for the desktop sidebar, which a phone never renders
  await M.goto(`${BASE}/app/~/inbox`, { waitUntil: 'domcontentloaded' })
  await signInBrowser(M, demo.account('nora'))
  await M.waitForSelector('[data-message]', { timeout: 30000 })
  const first = (await groups(M)).find((g) => !g.snoozed)
  await M.locator(`[data-message="${first.id}"] .inbox-message-actions`).click()
  await M.waitForSelector('[data-msg-snooze-row="days"]')
  await M.locator('[data-msg-snooze-row="days"]').getByLabel('More days').click()
  await M.screenshot({ path: `${SHOTS}/inbox-snooze-6-phone.png` })
  await M.keyboard.press('Escape')
  await M.waitForSelector('[data-msg-menu]', { state: 'detached' })
  log('phone: the actions button opens the menu with the steppers')
  await M.close()
  await ctxPhone.close()
  ctxPhone = null
} finally {
  // ---- restore, whatever happened above --------------------------------------
  if (pageA && restore.length) {
    try {
      await pageA.evaluate(async (entries) => {
        const { convex } = await import('/src/lib/convex.ts')
        const org = window.PLANNER.org
        for (const e of entries) {
          await convex.mutation('messages:snooze', { org_id: org.id, ids: e.ids, until: null })
          if (e.read) await convex.mutation('messages:markRead', { org_id: org.id, ids: e.ids })
        }
      }, restore)
      await sleep(1000)
      const final = await groups(pageA)
      if (final.some((g) => g.snoozed)) console.error('✘ a row is still snoozed after restore')
      else log('restored: nothing snoozed, read state put back')
    } catch (e) {
      console.error('✘ restore failed:', e.message)
    }
  }
  if (ctxB) await ctxB.close().catch(() => {})
  if (ctxPhone) await ctxPhone.close().catch(() => {})
  if (ctxA) await ctxA.close().catch(() => {})
  await browser.close()
}

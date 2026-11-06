/* Notification delivery across a person's sessions (notifications.ts): the
 * session wrappers' refusals, the beat and the end, the target of the
 * default mode, the claims of both modes and of mode changes, the catch-up
 * summary, the teardowns at sign-out, ban, expiry, login deletion and in
 * the expiry cron, and the reads at the design size. Time is fake and
 * starts at helpers.setup.ts NOW, the time the inbox fixtures post at
 * (inboxItems.setup.ts at), so an item's time and a checkpoint compare. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { createAuth } from '../auth'
import { OWN_READS } from '../lib/access'
import { CATCH_UP } from '../model/notificationCatchup'
import { EXPIRY, NOTIFY } from '../model/notificationSessions'
import * as notifications from '../notifications'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantLogin,
  plantLogins,
  plantProject,
  plantSeat,
  runInAuth,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { archiveRaw, grant, plantItems, post } from './inboxItems.setup'

const MINUTE = 60_000
const DAY = 86_400_000
const START = Date.parse(NOW)
const DEFAULT_NOTIFY = structuredClone(NOTIFY)
const DEFAULT_EXPIRY = structuredClone(EXPIRY)
const DEFAULT_CATCH_UP = structuredClone(CATCH_UP)
const DEFAULT_OWN_READS = structuredClone(OWN_READS)

beforeEach(() => {
  vi.useFakeTimers()
  clock(0)
})
afterEach(() => {
  Object.assign(NOTIFY, structuredClone(DEFAULT_NOTIFY))
  Object.assign(EXPIRY, structuredClone(DEFAULT_EXPIRY))
  Object.assign(CATCH_UP, structuredClone(DEFAULT_CATCH_UP))
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

/** Sets the server's time to `minutes` after NOW. */
function clock(minutes: number): void {
  vi.setSystemTime(START + minutes * MINUTE)
}

/** A caller of the functions, as convex-test hands one out. */
type Caller = Pick<T, 'query' | 'mutation'>

/** A Better Auth session of a login, planted in the component's own table,
 * and a caller whose token names it, as the Convex token does. */
type Session = {
  authUserId: string
  sessionId: string
  token: string
  as: ReturnType<T['withIdentity']>
}

/** Signs login `authUserId` in once more: a new Better Auth session that
 * expires `expiresIn` from now. */
async function signIn(t: T, authUserId: string, expiresIn = 7 * DAY): Promise<Session> {
  const now = Date.now()
  const token = uuid()
  const sessionId: string = await runInAuth(t, (ctx) =>
    ctx.db.insert('session', {
      token,
      userId: authUserId,
      expiresAt: now + expiresIn,
      createdAt: now,
      updatedAt: now,
    }),
  )
  return { authUserId, sessionId, token, as: t.withIdentity({ subject: authUserId, sessionId }) }
}

/** A login with no profile anywhere. */
async function lonelyLogin(t: T, name = 'lonely'): Promise<string> {
  const [login] = await plantLogins(t, [{ name, email: `${name}@testbed.test` }])
  return login
}

const beat = (
  s: Session,
  a: Partial<{ instance: string; can_notify: boolean; active: boolean }> = {},
) =>
  s.as.mutation(api.notifications.beat, {
    instance: 'tab-1',
    can_notify: true,
    active: false,
    ...a,
  })

/** An event as the feed offers one: its key and its time, `minute` after
 * NOW. */
const ev = (key: string, minute: number) => ({ key, at: START + minute * MINUTE })

const claim = (s: Session, events: { key: string; at: number }[], through?: number) =>
  s.as.mutation(api.notifications.claimAlerts, {
    events,
    ...(through === undefined ? {} : { through }),
  })

const summary = (s: Session) => s.as.mutation(api.notifications.claimSummary, {})

/** A resume or a reconnect, in the order a client takes it: a beat, then
 * the summary. */
async function resume(s: Session, a: Parameters<typeof beat>[1] = {}) {
  await beat(s, a)
  return await summary(s)
}

const setDelivery = (s: Session, delivery: 'recent' | 'all') =>
  s.as.mutation(api.notifications.setDelivery, { delivery })

const sessionRows = (t: T) => t.run((ctx) => ctx.db.query('notification_sessions').collect())
const accountRows = (t: T) => t.run((ctx) => ctx.db.query('account_notifications').collect())
const records = (t: T) => t.run((ctx) => ctx.db.query('notification_deliveries').collect())

/** The row of session `s`, or null. */
const rowOf = async (t: T, s: Session) =>
  (await sessionRows(t)).find((row) => row.session_id === s.sessionId) ?? null

/** The account row of login `authUserId`, or null. */
const accountOf = async (t: T, authUserId: string) =>
  (await accountRows(t)).find((row) => row.auth_user_id === authUserId) ?? null

/** Which of `sessions` the default mode grants to now, by a claim of no
 * events and no `through`, which writes nothing; -1 for none. A target
 * that must summarize first counts as the target. */
async function targetIndex(sessions: readonly Session[]): Promise<number> {
  const granted: number[] = []
  for (const [i, s] of sessions.entries())
    if (['granted', 'summarize_first'].includes((await claim(s, [])).state)) granted.push(i)
  expect(granted.length).toBeLessThanOrEqual(1)
  return granted[0] ?? -1
}

/** The message, item and build state rows, which no function here may
 * change. */
const inboxRows = (t: T) =>
  t.run(async (ctx) => ({
    messages: await ctx.db.query('messages').collect(),
    items: await ctx.db.query('inbox_items').collect(),
    states: await ctx.db.query('inbox_state').collect(),
  }))

/** The event of message `m` as the feed offers it: its id and created_at. */
const eventOf = (m: Doc<'messages'> | null) => {
  if (m === null) throw new Error('no message was stored')
  return { key: m.id, at: Date.parse(m.created_at) }
}

/** A fixture organization and a session of its guest, who sees the meta
 * project's two sub-projects. */
async function guestFixture(t: T): Promise<{ f: OrgFixture; s: Session }> {
  const f = await withOrg(t)
  return { f, s: await signIn(t, f.guest.auth_user_id as string) }
}

/** A new task in `project_id` (the guest's first sub-project) with one
 * message to the guest, made `minute` after NOW, and that message. */
async function newsAt(t: T, f: OrgFixture, minute: number, project_id = f.sub.id) {
  const task = await plantIssue(t, { org_id: f.org.id, project_id })
  const message = await post(t, f, { to: f.guest, task, minute })
  return { task, message: message as Doc<'messages'> }
}

/** The guest's unread message ids about `task`. */
const unreadOf = (t: T, f: OrgFixture, task: Doc<'issues'>) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('messages')
        .withIndex('by_recipient_issue', (q) =>
          q.eq('recipient_id', f.guest.id).eq('issue_id', task.id),
        )
        .collect()
    ).filter((m) => m.read_at === undefined),
  )

/* ------------------------------------------------------------ wrappers */

/** Each public function, called as `caller` with arguments it accepts. */
const CALLS: [string, (caller: Caller) => Promise<unknown>][] = [
  ['settings', (c) => c.query(api.notifications.settings, {})],
  ['setDelivery', (c) => c.mutation(api.notifications.setDelivery, { delivery: 'all' })],
  [
    'beat',
    (c) =>
      c.mutation(api.notifications.beat, { instance: 'tab-1', can_notify: true, active: true }),
  ],
  ['end', (c) => c.mutation(api.notifications.end, { instance: 'tab-1' })],
  ['claimAlerts', (c) => c.mutation(api.notifications.claimAlerts, { events: [] })],
  ['claimSummary', (c) => c.mutation(api.notifications.claimSummary, {})],
]

describe('the session wrappers', () => {
  it.each(CALLS)('%s needs a sign-in whose session is live and the caller’s', async (_, call) => {
    const t = newT()
    const login = await lonelyLogin(t)
    const other = await lonelyLogin(t, 'other')
    const mine = await signIn(t, login)
    const theirs = await signIn(t, other)
    const brief = await signIn(t, login, MINUTE)
    // a login with no profile passes, since nothing reads a seat
    await call(mine.as)
    await expectRefusal(call(t), 'forbidden', /not signed in/)
    await expectRefusal(call(t.withIdentity({ subject: login })), 'forbidden', /not signed in/)
    await expect(
      call(t.withIdentity({ subject: login, sessionId: theirs.sessionId })),
    ).rejects.toThrow(/Unauthenticated/)
    clock(2)
    await expect(call(brief.as)).rejects.toThrow(/Unauthenticated/)
    await runInAuth(t, (ctx) => ctx.db.delete(mine.sessionId as never))
    await expect(call(mine.as)).rejects.toThrow(/Unauthenticated/)
  })

  it.each(CALLS)('%s on the demo needs the login’s demo, active and ready', async (_, call) => {
    vi.stubEnv('APP_MODE', 'demo')
    const t = newT()
    const login = await lonelyLogin(t)
    const s = await signIn(t, login)
    const receipt = await t.run((ctx) =>
      ctx.db.insert('demo_sessions', {
        id: uuid(),
        auth_user_id: login,
        org_id: uuid(),
        status: 'unprovisioned',
        created_at: Date.now(),
        expires_at: Date.now() + DAY,
      }),
    )
    await expectRefusal(call(s.as), 'forbidden', /still being prepared/)
    await t.run((ctx) => ctx.db.patch(receipt, { status: 'ready' }))
    await call(s.as)
    await t.run((ctx) => ctx.db.patch(receipt, { expires_at: Date.now() }))
    await expectRefusal(call(s.as), 'forbidden', /expired/)
  })

  it('spends no demo write on the bookkeeping and one on the setting', async () => {
    vi.stubEnv('APP_MODE', 'demo')
    const t = newT()
    const login = await lonelyLogin(t)
    const s = await signIn(t, login)
    const demo_id = uuid()
    await t.run((ctx) =>
      ctx.db.insert('demo_sessions', {
        id: demo_id,
        auth_user_id: login,
        org_id: uuid(),
        status: 'ready',
        created_at: Date.now(),
        expires_at: Date.now() + DAY,
      }),
    )
    const writes = () =>
      t.run(async (ctx) => {
        const row = await ctx.db
          .query('demo_write_counts')
          .withIndex('by_demo', (q) => q.eq('demo_id', demo_id))
          .unique()
        return { writes: row?.write_count ?? 0, inserts: row?.insert_count ?? 0 }
      })
    await beat(s, { active: true })
    await claim(s, [ev('a', 0)], START)
    await summary(s)
    await s.as.mutation(api.notifications.end, { instance: 'tab-1' })
    expect(await writes()).toEqual({ writes: 0, inserts: 0 })
    expect(await records(t)).toHaveLength(1)
    await setDelivery(s, 'all')
    expect(await writes()).toEqual({ writes: 1, inserts: 0 })
  })
})

/* -------------------------------------------------------- beat and end */

describe('beat and end', () => {
  it('registers the session in the token, and moves active_at only on a report, at most every 15 s', async () => {
    const t = newT()
    const login = await lonelyLogin(t)
    const s = await signIn(t, login)
    // a first beat never sets active_at, even with a report
    expect(await beat(s, { active: true })).toEqual({
      every_ms: NOTIFY.beat_ms,
      live_ms: 3 * NOTIFY.beat_ms,
      now: START,
    })
    expect(await sessionRows(t)).toEqual([
      expect.objectContaining({
        auth_user_id: login,
        session_id: s.sessionId,
        instance: 'tab-1',
        can_notify: true,
        beat_at: START,
      }),
    ])
    expect((await rowOf(t, s))?.active_at).toBeUndefined()
    // a beat without a report never moves it
    clock(1)
    await beat(s)
    expect((await rowOf(t, s))?.active_at).toBeUndefined()
    await beat(s, { active: true })
    expect((await rowOf(t, s))?.active_at).toBe(START + MINUTE)
    // within NOTIFY.active_ms a report writes nothing new
    vi.setSystemTime(START + MINUTE + NOTIFY.active_ms - 1)
    await beat(s, { active: true })
    expect((await rowOf(t, s))?.active_at).toBe(START + MINUTE)
    vi.setSystemTime(START + MINUTE + NOTIFY.active_ms)
    await beat(s, { active: true })
    expect((await rowOf(t, s))?.active_at).toBe(START + MINUTE + NOTIFY.active_ms)
    // two first beats of another session leave one row each
    const other = await signIn(t, login)
    await beat(other)
    await beat(other)
    expect(await sessionRows(t)).toHaveLength(2)
  })

  it('lets a second tab take the row over and answers the pacing by mode and capability', async () => {
    const t = newT()
    const s = await signIn(t, await lonelyLogin(t))
    expect((await beat(s, { can_notify: false })).every_ms).toBe(NOTIFY.idle_beat_ms)
    await beat(s, { instance: 'tab-2' })
    expect(await rowOf(t, s)).toMatchObject({ instance: 'tab-2', can_notify: true })
    // the capability moves the row within by_login_notify_active
    const notifying = (can_notify: boolean) =>
      t.run(
        async (ctx) =>
          (
            await ctx.db
              .query('notification_sessions')
              .withIndex('by_login_notify_active', (q) =>
                q.eq('auth_user_id', s.authUserId).eq('can_notify', can_notify),
              )
              .collect()
          ).length,
      )
    expect([await notifying(true), await notifying(false)]).toEqual([1, 0])
    await beat(s, { can_notify: false })
    expect([await notifying(true), await notifying(false)]).toEqual([0, 1])
    await setDelivery(s, 'all')
    expect((await beat(s)).every_ms).toBe(NOTIFY.idle_beat_ms)
    await setDelivery(s, 'recent')
    expect((await beat(s)).every_ms).toBe(NOTIFY.beat_ms)
  })

  it('ends a session at once only from the tab that beat last, until it beats again', async () => {
    const t = newT()
    const login = await lonelyLogin(t)
    const a = await signIn(t, login)
    const b = await signIn(t, login)
    await beat(a)
    clock(1)
    await beat(b)
    expect(await targetIndex([a, b])).toBe(1)
    // another tab's late end changes nothing
    await b.as.mutation(api.notifications.end, { instance: 'tab-9' })
    expect(await targetIndex([a, b])).toBe(1)
    await b.as.mutation(api.notifications.end, { instance: 'tab-1' })
    expect(await targetIndex([a, b])).toBe(0)
    expect(await rowOf(t, b)).not.toBeNull()
    await beat(b)
    expect(await targetIndex([a, b])).toBe(1)
    // an end without a row changes nothing
    const c = await signIn(t, login)
    expect(await c.as.mutation(api.notifications.end, { instance: 'tab-1' })).toBeNull()
    expect(await rowOf(t, c)).toBeNull()
  })

  it('refuses a session row that names another login', async () => {
    const t = newT()
    const login = await lonelyLogin(t)
    const s = await signIn(t, login)
    await t.run((ctx) =>
      ctx.db.insert('notification_sessions', {
        auth_user_id: 'someone-else',
        session_id: s.sessionId,
        instance: 'tab-1',
        can_notify: true,
        beat_at: Date.now(),
      }),
    )
    for (const [, call] of CALLS.filter(([name]) => !['settings', 'setDelivery'].includes(name)))
      await expectRefusal(call(s.as), 'forbidden', /another login/)
    expect(await sessionRows(t)).toHaveLength(1)
  })

  it('checks the arguments before it reads a row', async () => {
    const t = newT()
    const s = await signIn(t, await lonelyLogin(t))
    await expectRefusal(beat(s, { instance: '' }), 'bad_request', /instance/)
    await expectRefusal(beat(s, { instance: 'x'.repeat(65) }), 'bad_request', /instance/)
    await expectRefusal(
      s.as.mutation(api.notifications.end, { instance: 'x'.repeat(65) }),
      'bad_request',
    )
    const many = Array.from({ length: NOTIFY.claim_keys + 1 }, (_, i) => ev(`k${i}`, 0))
    await expectRefusal(claim(s, many), 'bad_request', /at most 50/)
    await expectRefusal(claim(s, [ev('', 0)]), 'bad_request', /key/)
    await expectRefusal(claim(s, [ev('k'.repeat(129), 0)]), 'bad_request', /key/)
    await expectRefusal(claim(s, [{ key: 'k', at: Number.NaN }]), 'bad_request', /time/)
    await expectRefusal(claim(s, [], Number.POSITIVE_INFINITY), 'bad_request', /through/)
    // times are epoch milliseconds, never negative, so no checkpoint a
    // later summary reads back from leaves Date's range
    await expectRefusal(claim(s, [{ key: 'k', at: -1 }]), 'bad_request', /time/)
    await expectRefusal(claim(s, [], -1e300), 'bad_request', /through/)
    expect(await claim(s, [ev('k'.repeat(128), 0)])).toEqual({ state: 'not_registered' })
  })
})

/* ---------------------------------------------------------- the target */

describe('the target of the default mode', () => {
  it('is the most recently active live session that can notify', async () => {
    const t = newT()
    const login = await lonelyLogin(t)
    const [a, b, c] = [await signIn(t, login), await signIn(t, login), await signIn(t, login)]
    await beat(a)
    await beat(b)
    await beat(c, { can_notify: false })
    // none reported activity, so the row created last wins, the index's
    // order, in every call
    expect(await targetIndex([a, b, c])).toBe(1)
    expect(await targetIndex([a, b, c])).toBe(1)
    // a report makes a the most recent; c's, which cannot notify, does not
    clock(0.5)
    await beat(a, { active: true })
    expect(await targetIndex([a, b, c])).toBe(0)
    clock(0.75)
    await beat(c, { can_notify: false, active: true })
    expect(await targetIndex([a, b, c])).toBe(0)
    // equal active_at falls to the row created last
    await beat(b, { active: true })
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('notification_sessions').collect()
      for (const row of rows) await ctx.db.patch(row._id, { active_at: START })
    })
    expect(await targetIndex([a, b, c])).toBe(1)
    expect(await targetIndex([a, b, c])).toBe(1)
    // b misses three beats; a, which still beats, takes over
    clock(2)
    await beat(a)
    clock(4)
    await beat(a)
    expect(await targetIndex([a, b, c])).toBe(0)
    // a session that never reported activity loses to one that did
    const d = await signIn(t, login)
    await beat(d)
    expect(await targetIndex([a, b, c, d])).toBe(0)
  })

  it('never considers another login’s sessions', async () => {
    const t = newT()
    const a = await signIn(t, await lonelyLogin(t))
    const b = await signIn(t, await lonelyLogin(t, 'other'))
    await beat(a)
    clock(1)
    await beat(b, { active: true })
    clock(1.5)
    await beat(b, { active: true })
    expect((await claim(a, [ev('k', 1)])).state).toBe('granted')
    expect((await claim(b, [ev('k', 1)])).state).toBe('granted')
  })

  it('answers no target past NOTIFY.scan stale rows, and grants nothing', async () => {
    const t = newT()
    const login = await lonelyLogin(t)
    const live = await signIn(t, login)
    await beat(live)
    const stale = [await signIn(t, login), await signIn(t, login)]
    for (const s of stale) await beat(s, { active: true })
    clock(0.5)
    for (const s of stale) await beat(s, { active: true })
    clock(3.6)
    await beat(live)
    expect(await targetIndex([live, ...stale])).toBe(0)
    NOTIFY.scan = 2
    expect(await targetIndex([live, ...stale])).toBe(-1)
    expect(await claim(live, [ev('k', 3)], START + 3 * MINUTE)).toEqual({ state: 'not_target' })
    expect(await records(t)).toEqual([])
    expect(await accountRows(t)).toEqual([])
  })
})

/* ---------------------------------------------- claims, the default mode */

describe('claimAlerts in the default mode', () => {
  it('grants each new key once to the target, and none to another session', async () => {
    const t = newT()
    const login = await lonelyLogin(t)
    const [a, b] = [await signIn(t, login), await signIn(t, login)]
    await beat(b)
    await beat(a)
    clock(0.5)
    await beat(a, { active: true })
    expect(await claim(a, [ev('k1', 0), ev('k2', 0.25), ev('k1', 0)], START)).toEqual({
      state: 'granted',
      keys: ['k1', 'k2'],
      limited: false,
    })
    expect(await claim(b, [ev('k3', 0.4)])).toEqual({ state: 'not_target' })
    expect(await claim(a, [ev('k1', 0), ev('k3', 0.4)])).toEqual({
      state: 'granted',
      keys: ['k3'],
      limited: false,
    })
    expect((await records(t)).map((r) => [r.key, r.session_id, r.expires_at])).toEqual([
      ['k1', undefined, START + 0.5 * MINUTE + NOTIFY.keep_ms],
      ['k2', undefined, START + 0.5 * MINUTE + NOTIFY.keep_ms],
      ['k3', undefined, START + 0.5 * MINUTE + NOTIFY.keep_ms],
    ])
    // recency moves to b, which summarizes first, as a new target does, so
    // the next keys go to b, and what a recorded is refused to it
    clock(1)
    await beat(b, { active: true })
    expect(await claim(a, [ev('k4', 1.25)])).toEqual({ state: 'not_target' })
    expect(await claim(b, [ev('k3', 0.4), ev('k4', 1.25)])).toEqual({ state: 'summarize_first' })
    expect(await summary(b)).toEqual({ state: 'none' })
    clock(1.5)
    expect(await claim(b, [ev('k3', 0.4), ev('k4', 1.25)])).toEqual({
      state: 'granted',
      keys: ['k4'],
      limited: false,
    })
  })

  it('sends a session that became the target after another moved the checkpoint to summarize first', async () => {
    const t = newT()
    const { f, s: a } = await guestFixture(t)
    const b = await signIn(t, a.authUserId)
    await beat(b)
    await beat(a)
    clock(0.5)
    await beat(a, { active: true })
    expect(await summary(a)).toEqual({ state: 'baseline' })
    // a, the target, sleeps but stays live; b, live and idle, sees E first
    clock(1)
    await beat(b)
    const e = eventOf((await newsAt(t, f, 1)).message)
    expect(await claim(b, [e], e.at)).toEqual({ state: 'not_target' })
    // a lapses, so b is the target, and F arrives past E's live window
    for (const minute of [2, 3, 4]) {
      clock(minute)
      await beat(b)
    }
    const account = await accountOf(t, a.authUserId)
    clock(20)
    await beat(b)
    const later = eventOf((await newsAt(t, f, 19.5)).message)
    expect(await claim(b, [later], later.at)).toEqual({ state: 'summarize_first' })
    expect(await accountOf(t, a.authUserId)).toEqual(account)
    expect(await records(t)).toEqual([])
    // the summary covers E, and records F, which it found in its last minute
    expect(await summary(b)).toEqual({ state: 'summary' })
    expect((await records(t)).map((r) => r.key)).toEqual([later.key])
    expect(await accountOf(t, a.authUserId)).toMatchObject({
      covered_at: START + 20 * MINUTE,
      covered_by: b.sessionId,
    })
    const next = eventOf((await newsAt(t, f, 20.25)).message)
    clock(20.5)
    expect(await claim(b, [later, next], next.at)).toEqual({
      state: 'granted',
      keys: [next.key],
      limited: false,
    })
    clock(21)
    expect(await summary(b)).toEqual({ state: 'none' })
    // a switch to 'recent' names the switching session, so another target's
    // first claim after it summarizes first
    clock(22)
    await setDelivery(b, 'all')
    await setDelivery(b, 'recent')
    expect((await accountOf(t, a.authUserId))?.covered_by).toBe(b.sessionId)
    clock(23)
    await beat(a, { active: true })
    expect(await claim(a, [], START + 22.5 * MINUTE)).toEqual({ state: 'summarize_first' })
    expect(await summary(a)).toEqual({ state: 'none' })
    expect(await claim(a, [], START + 22.5 * MINUTE)).toMatchObject({ state: 'granted' })
    expect((await accountOf(t, a.authUserId))?.covered_by).toBe(a.sessionId)
  })

  it('sends another target to summarize first after a switch to recent by a session that then slept', async () => {
    const t = newT()
    const { f, s: x } = await guestFixture(t)
    const b = await signIn(t, x.authUserId)
    await beat(b)
    await beat(x)
    await setDelivery(x, 'all')
    // x reports activity before the switch, so it is the target after it
    clock(0.5)
    await beat(x, { active: true })
    clock(1)
    await setDelivery(x, 'recent')
    await beat(x)
    // x sleeps; b, live and idle, sees E first
    const e = eventOf((await newsAt(t, f, 1.5)).message)
    clock(2)
    await beat(b)
    expect(await claim(b, [e], e.at)).toEqual({ state: 'not_target' })
    // x lapses, so b is the target, and F arrives past E's live window
    for (const minute of [3, 4, 5]) {
      clock(minute)
      await beat(b)
    }
    clock(20)
    await beat(b)
    const later = eventOf((await newsAt(t, f, 19.5)).message)
    expect(await claim(b, [later], later.at)).toEqual({ state: 'summarize_first' })
    // the summary covers E, which nobody alerted
    expect(await summary(b)).toEqual({ state: 'summary' })
    expect(await claim(b, [later], later.at)).toMatchObject({ state: 'granted', keys: [] })
  })

  it('sends the session that moved the checkpoint to summarize first when another was the target since', async () => {
    const t = newT()
    const { f, s: a } = await guestFixture(t)
    const b = await signIn(t, a.authUserId)
    await beat(b)
    await beat(a)
    clock(0.5)
    await beat(a, { active: true })
    expect(await summary(a)).toEqual({ state: 'baseline' })
    // b reports activity, so it is the target, and then sleeps; its last
    // beat keeps it live until minute 4 and it never claims
    clock(1)
    await beat(b, { active: true })
    const e = eventOf((await newsAt(t, f, 1.5)).message)
    clock(2)
    await beat(a)
    expect(await claim(a, [e], e.at)).toEqual({ state: 'not_target' })
    // b lapses, so a, which moved the checkpoint last, is the target again
    for (const minute of [3, 4, 5]) {
      clock(minute)
      await beat(a)
    }
    clock(20)
    await beat(a)
    const later = eventOf((await newsAt(t, f, 19.5)).message)
    expect(await claim(a, [later], later.at)).toEqual({ state: 'summarize_first' })
    expect(await records(t)).toEqual([])
    // the summary covers E, which nobody alerted, and records F
    expect(await summary(a)).toEqual({ state: 'summary' })
    expect(await claim(a, [later], later.at)).toEqual({
      state: 'granted',
      keys: [],
      limited: false,
    })
    clock(21)
    expect(await summary(a)).toEqual({ state: 'none' })
  })

  it('answers not_registered for a session without a row or that cannot notify', async () => {
    const t = newT()
    const login = await lonelyLogin(t)
    const [a, b] = [await signIn(t, login), await signIn(t, login)]
    expect(await claim(a, [ev('k', 0)])).toEqual({ state: 'not_registered' })
    expect(await summary(a)).toEqual({ state: 'not_registered' })
    await beat(b, { can_notify: false })
    clock(0.5)
    await beat(b, { can_notify: false, active: true })
    expect(await claim(b, [ev('k', 0)])).toEqual({ state: 'not_registered' })
    expect(await summary(b)).toEqual({ state: 'not_registered' })
    expect(await records(t)).toEqual([])
    expect(await accountRows(t)).toEqual([])
  })

  it('refuses an event older than the live window or a minute before a summary or a mode change, with no record', async () => {
    const t = newT()
    const s = await signIn(t, await lonelyLogin(t))
    clock(20)
    await beat(s)
    const old = ev('old', 20 - NOTIFY.live_window_ms / MINUTE)
    expect(await claim(s, [old, ev('fresh', 19)])).toMatchObject({ keys: ['fresh'] })
    // a summary at minute 21 floors live alerts NOTIFY.lag_ms before it, and
    // a baseline recorded nothing, so a later time in that minute is granted
    clock(21)
    await beat(s)
    expect(await summary(s)).toEqual({ state: 'baseline' })
    clock(22)
    expect(await claim(s, [ev('summed', 20), ev('late', 20.5), ev('after', 21.5)])).toMatchObject({
      keys: ['late', 'after'],
    })
    // so does a change of the mode, there and back
    clock(23)
    await setDelivery(s, 'all')
    await setDelivery(s, 'recent')
    await beat(s)
    expect(await claim(s, [ev('changed', 22), ev('later', 22.5)])).toMatchObject({
      keys: ['later'],
    })
    clock(24)
    expect(await claim(s, [ev('changed', 22), ev('later', 22.5), ev('next', 23.5)])).toMatchObject({
      keys: ['next'],
    })
    expect((await records(t)).map((r) => r.key).sort()).toEqual([
      'after',
      'fresh',
      'late',
      'later',
      'next',
    ])
    // an event from the future is taken at now
    expect(await claim(s, [ev('future', 99)])).toMatchObject({ keys: ['future'] })
  })

  it('moves the checkpoint for the target only, never past now and never back', async () => {
    const t = newT()
    const login = await lonelyLogin(t)
    const [a, b] = [await signIn(t, login), await signIn(t, login)]
    await beat(a)
    clock(1)
    await beat(b)
    expect(await claim(a, [], START + MINUTE)).toEqual({ state: 'not_target' })
    expect(await accountRows(t)).toEqual([])
    await claim(b, [ev('k', 0.5)], START + 0.5 * MINUTE)
    expect((await accountOf(t, login))?.covered_at).toBe(START + 0.5 * MINUTE)
    expect(await claim(a, [], START + MINUTE)).toEqual({ state: 'not_target' })
    expect((await accountOf(t, login))?.covered_at).toBe(START + 0.5 * MINUTE)
    await claim(b, [], START + 0.25 * MINUTE)
    expect((await accountOf(t, login))?.covered_at).toBe(START + 0.5 * MINUTE)
    await claim(b, [], START + 9 * MINUTE)
    expect((await accountOf(t, login))?.covered_at).toBe(START + MINUTE)
  })

  it('stops granting past the rate window and holds the checkpoint before the first refused event', async () => {
    const t = newT()
    const { f, s } = await guestFixture(t)
    NOTIFY.claim_window_most = 2
    await beat(s)
    expect(await summary(s)).toEqual({ state: 'baseline' })
    clock(1)
    const news = [
      eventOf((await newsAt(t, f, 1)).message),
      eventOf((await newsAt(t, f, 1.25)).message),
      eventOf((await newsAt(t, f, 1.5)).message),
    ]
    clock(2)
    await beat(s)
    // offered newest first, granted oldest first
    expect(await claim(s, [...news].reverse(), news[2].at)).toEqual({
      state: 'granted',
      keys: [news[1].key, news[0].key],
      limited: true,
    })
    expect((await records(t)).map((r) => r.key)).toEqual([news[0].key, news[1].key])
    expect(await accountOf(t, s.authUserId)).toMatchObject({
      covered_at: news[2].at - 1,
      claim_window_count: 2,
    })
    // the window holds, so nothing more until it ends
    const late = eventOf((await newsAt(t, f, 2)).message)
    expect(await claim(s, [late])).toEqual({ state: 'granted', keys: [], limited: true })
    expect(await records(t)).toHaveLength(2)
    // the refused events become one summary, never the granted ones
    expect(await summary(s)).toEqual({ state: 'summary' })
    expect(await summary(s)).toEqual({ state: 'none' })
    clock(2 + NOTIFY.claim_window_ms / MINUTE)
    await beat(s)
    const next = eventOf((await newsAt(t, f, 12)).message)
    expect(await claim(s, [next])).toMatchObject({ keys: [next.key], limited: false })
  })

  it('still refuses a key after its record expired and the cron deleted it', async () => {
    const t = newT()
    const s = await signIn(t, await lonelyLogin(t))
    await beat(s)
    expect(await claim(s, [ev('k', 0)])).toMatchObject({ keys: ['k'] })
    clock(NOTIFY.keep_ms / MINUTE + 1)
    await t.mutation(internal.notifications.expire, {})
    expect(await records(t)).toEqual([])
    await beat(s)
    expect(await claim(s, [ev('k', 0)])).toMatchObject({ keys: [] })
  })
})

/* -------------------------------------------- claims, All enabled sessions */

describe('claimAlerts with All enabled sessions', () => {
  it('grants each session a key once, on its own row and window', async () => {
    const t = newT()
    const login = await lonelyLogin(t)
    const [a, b] = [await signIn(t, login), await signIn(t, login)]
    await beat(a)
    await beat(b)
    // a record of the default mode, from before the switch
    expect(await claim(b, [ev('before', 0)])).toMatchObject({ keys: ['before'] })
    clock(1)
    await setDelivery(a, 'all')
    const account = await accountOf(t, login)
    clock(2)
    for (const s of [a, b])
      expect(await claim(s, [ev('before', 1.5), ev('k', 1.5)], START + 1.5 * MINUTE)).toEqual({
        state: 'granted',
        keys: ['k'],
        limited: false,
      })
    // a second tab of a session is refused what the first was granted
    expect(await claim(a, [ev('k', 1.5)])).toMatchObject({ keys: [] })
    expect((await records(t)).map((r) => `${r.key} ${r.session_id ?? 'account'}`).sort()).toEqual(
      ['before account', `k ${a.sessionId}`, `k ${b.sessionId}`].sort(),
    )
    // each claim moved its own row's checkpoint and window, not the account's
    for (const s of [a, b])
      expect(await rowOf(t, s)).toMatchObject({
        covered_at: START + 1.5 * MINUTE,
        claim_window_count: 1,
      })
    expect(await accountOf(t, login)).toEqual(account)
    // a session in 'all' needs no liveness
    clock(30)
    expect(await claim(a, [ev('late', 29)])).toMatchObject({ keys: ['late'] })
  })
})

/* -------------------------------------------------------- mode changes */

describe('mode changes', () => {
  it('replay nothing from recent to all and back, and floor each summary', async () => {
    const t = newT()
    const { f, s: a } = await guestFixture(t)
    const b = await signIn(t, a.authUserId)
    expect(await a.as.query(api.notifications.settings, {})).toEqual({ delivery: 'recent' })
    // the same mode writes nothing
    await setDelivery(a, 'recent')
    expect(await accountRows(t)).toEqual([])
    await beat(b)
    await beat(a)
    expect(await summary(a)).toEqual({ state: 'baseline' })
    clock(1)
    const first = eventOf((await newsAt(t, f, 1)).message)
    await beat(a)
    expect(await claim(a, [first], first.at)).toMatchObject({ keys: [first.key] })
    // to 'all': all_from is the account's checkpoint
    clock(2)
    await setDelivery(b, 'all')
    expect(await b.as.query(api.notifications.settings, {})).toEqual({ delivery: 'all' })
    expect(await accountOf(t, a.authUserId)).toMatchObject({
      delivery: 'all',
      changed_at: START + 2 * MINUTE,
      all_from: first.at,
    })
    // what 'recent' alerted stays refused, and an event at the change that
    // no session alerted is still live; a session without a checkpoint of
    // its own takes a baseline
    const atChange = eventOf((await newsAt(t, f, 2)).message)
    clock(3)
    expect(await claim(a, [first, atChange])).toMatchObject({ keys: [atChange.key] })
    expect(await summary(b)).toEqual({ state: 'baseline' })
    const second = eventOf((await newsAt(t, f, 3.5)).message)
    clock(4)
    expect(await claim(a, [second], second.at)).toMatchObject({ keys: [second.key] })
    expect(await claim(b, [second], second.at)).toMatchObject({ keys: [second.key] })
    // a's own checkpoint, second, is past the account's all_from
    clock(5)
    expect(await summary(a)).toEqual({ state: 'none' })
    // back to 'recent': the switch is a baseline, so nothing before it
    // counts, what 'all' alerted is refused and what no session alerted in
    // its last minute is still live
    const third = eventOf((await newsAt(t, f, 5)).message)
    await setDelivery(a, 'recent')
    expect(await accountOf(t, a.authUserId)).toMatchObject({
      delivery: 'recent',
      changed_at: START + 5 * MINUTE,
      covered_at: START + 5 * MINUTE,
      baseline_at: START + 5 * MINUTE,
    })
    await beat(a)
    expect(await claim(a, [second, third])).toMatchObject({ keys: [third.key] })
    clock(9)
    expect(await resume(a)).toEqual({ state: 'none' })
    // no key was granted twice in one scope
    const scopes = (await records(t)).map((r) => `${r.session_id ?? 'account'} ${r.key}`)
    expect(new Set(scopes).size).toBe(scopes.length)
  })

  it('floor a session’s own older checkpoint at all_from on a second switch to all', async () => {
    const t = newT()
    const { f, s } = await guestFixture(t)
    await beat(s)
    await setDelivery(s, 'all')
    // the session's own checkpoint in 'all'
    expect(await summary(s)).toEqual({ state: 'baseline' })
    clock(1)
    await setDelivery(s, 'recent')
    // in 'recent' the target alerts E and moves the account's checkpoint
    const e = eventOf((await newsAt(t, f, 2)).message)
    clock(2.5)
    await beat(s)
    expect(await claim(s, [e], e.at)).toMatchObject({ keys: [e.key] })
    // E's record expires and the cron deletes it
    clock(2.5 + NOTIFY.keep_ms / MINUTE + 1)
    await t.mutation(internal.notifications.expire, {})
    expect(await records(t)).toEqual([])
    // back to 'all', where the account's checkpoint, past the session's
    // own, is its floor, so the 'recent' period is not summarized again
    await setDelivery(s, 'all')
    expect(await accountOf(t, s.authUserId)).toMatchObject({ all_from: e.at })
    expect((await rowOf(t, s))?.covered_at).toBe(START)
    clock(20)
    expect(await resume(s)).toEqual({ state: 'none' })
  })
})

/* ------------------------------------------------------------ the summary */

describe('claimSummary', () => {
  it('takes a baseline without a checkpoint, then answers each gap once', async () => {
    const t = newT()
    const { f, s } = await guestFixture(t)
    // unread activity from before the first checkpoint never counts
    await newsAt(t, f, -5)
    expect(await resume(s)).toEqual({ state: 'baseline' })
    expect(await summary(s)).toEqual({ state: 'none' })
    clock(10)
    expect(await resume(s)).toEqual({ state: 'none' })
    await newsAt(t, f, 15)
    clock(20)
    expect(await resume(s)).toEqual({ state: 'summary' })
    // the same gap asked again
    expect(await summary(s)).toEqual({ state: 'none' })
    expect(await accountOf(t, s.authUserId)).toMatchObject({
      covered_at: START + 20 * MINUTE,
      summarized_at: START + 20 * MINUTE,
      baseline_at: START,
    })
  })

  it('counts no item read, snoozed or hidden meanwhile, and no item whose new message was read', async () => {
    const t = newT()
    const { f, s } = await guestFixture(t)
    const guest = as(t, f.guest)
    // an older unread message on a task whose newer one is read below
    const { task: partly } = await newsAt(t, f, -1)
    // an item that returns from a snooze after the checkpoint and is read
    const { task: woken, message: dozing } = await newsAt(t, f, -1)
    const until = new Date(START + 4 * MINUTE).toISOString()
    await guest.mutation(api.messages.snooze, { org_id: f.org.id, ids: [dozing.id], until })
    expect(await resume(s)).toEqual({ state: 'baseline' })
    clock(4)
    await t.mutation(internal.messages.wake, {
      recipient_id: f.guest.id,
      issue_id: woken.id,
      until,
    })
    clock(5)
    const { message: read } = await newsAt(t, f, 5)
    const { message: snoozed } = await newsAt(t, f, 5)
    const lost = await plantProject(t, { org_id: f.org.id })
    const revoke = await grant(t, f.guest, lost.id)
    await newsAt(t, f, 5, lost.id)
    const newer = await post(t, f, { to: f.guest, task: partly, minute: 5 })
    // a task archived before the archive's read step, in a project the
    // guest sees, keeps its message unread but is not shown
    const { task: archived } = await newsAt(t, f, 5)
    await archiveRaw(t, [archived])
    clock(6)
    await guest.mutation(api.messages.markRead, { org_id: f.org.id, ids: [read.id] })
    await guest.mutation(api.messages.snooze, {
      org_id: f.org.id,
      ids: [snoozed.id],
      until: new Date(START + DAY).toISOString(),
    })
    await revoke()
    await guest.mutation(api.messages.markRead, {
      org_id: f.org.id,
      ids: [(newer as Doc<'messages'>).id, ...(await unreadOf(t, f, woken)).map((m) => m.id)],
    })
    // the older message keeps the item unread, sorted at the newer one
    expect(await unreadOf(t, f, partly)).toHaveLength(1)
    clock(7)
    expect(await resume(s)).toEqual({ state: 'none' })
  })

  it('counts a snooze return after the checkpoint', async () => {
    const t = newT()
    const { f, s } = await guestFixture(t)
    const { task, message } = await newsAt(t, f, -1)
    const until = new Date(START + 5 * MINUTE).toISOString()
    await as(t, f.guest).mutation(api.messages.snooze, {
      org_id: f.org.id,
      ids: [message.id],
      until,
    })
    expect(await resume(s)).toEqual({ state: 'baseline' })
    clock(5)
    await t.mutation(internal.messages.wake, {
      recipient_id: f.guest.id,
      issue_id: task.id,
      until,
    })
    clock(5.5)
    expect(await resume(s)).toEqual({ state: 'summary' })
    // the wake's key is the summary record, so a quick resume reads it again
    // and counts nothing
    expect((await records(t)).map((r) => r.key)).toEqual([`${task.id}:${at5()}`])
    clock(6)
    expect(await resume(s)).toEqual({ state: 'none' })
  })

  it('answers once a gap across sessions, and none after another session alerted it live', async () => {
    const t = newT()
    const { f, s: a } = await guestFixture(t)
    const b = await signIn(t, a.authUserId)
    await beat(b)
    expect(await resume(a)).toEqual({ state: 'baseline' })
    expect(await summary(b)).toEqual({ state: 'not_target' })
    // a sleeps; b takes over, summarizes first, and alerts the new message
    // live
    clock(2)
    await beat(b, { active: true })
    expect(await claim(b, [], START + 2 * MINUTE)).toEqual({ state: 'summarize_first' })
    expect(await summary(b)).toEqual({ state: 'none' })
    const live = eventOf((await newsAt(t, f, 2.5)).message)
    clock(3)
    await beat(b)
    expect(await claim(b, [live], live.at)).toMatchObject({ keys: [live.key] })
    // a resumes with input and becomes the target, and nothing was missed
    clock(10)
    expect(await resume(a, { active: true })).toEqual({ state: 'none' })
    // a new message while both slept goes to one summary only
    await newsAt(t, f, 12)
    clock(20)
    expect(await resume(a, { active: true })).toEqual({ state: 'summary' })
    clock(21)
    expect(await resume(b, { active: true })).toEqual({ state: 'none' })
  })

  it('finds each session’s own gap with All enabled sessions', async () => {
    const t = newT()
    const { f, s: a } = await guestFixture(t)
    const b = await signIn(t, a.authUserId)
    await beat(a)
    await setDelivery(a, 'all')
    expect(await resume(a)).toEqual({ state: 'baseline' })
    await newsAt(t, f, 3)
    // b first beats after the switch, so a baseline, never everything since it
    clock(4)
    expect(await resume(b)).toEqual({ state: 'baseline' })
    // b stays and alerts the next news live; a sleeps through it
    const news = eventOf((await newsAt(t, f, 5)).message)
    clock(6)
    await beat(b)
    expect(await claim(b, [news], news.at)).toMatchObject({ keys: [news.key] })
    clock(10)
    expect(await resume(a)).toEqual({ state: 'summary' })
    expect(await resume(b)).toEqual({ state: 'none' })
    expect(await resume(a)).toEqual({ state: 'none' })
  })

  it('answers unchecked when its budget or a seat not ready stops it, and moves the checkpoint', async () => {
    const t = newT()
    const { f, s } = await guestFixture(t)
    const lost = await plantProject(t, { org_id: f.org.id })
    const revoke = await grant(t, f.guest, lost.id)
    expect(await resume(s)).toEqual({ state: 'baseline' })
    await newsAt(t, f, 2, lost.id)
    await newsAt(t, f, 3, lost.id)
    await revoke()
    clock(5)
    CATCH_UP.items = 1
    expect(await resume(s)).toEqual({ state: 'unchecked' })
    CATCH_UP.items = DEFAULT_CATCH_UP.items
    expect(await summary(s)).toEqual({ state: 'none' })
    // a second seat whose items are not built yet
    const seat = await plantSeat(t, {
      org_id: f.otherOrg.id,
      email: f.guest.email,
      auth_user_id: s.authUserId,
      accepted_at: NOW,
    })
    await t.run((ctx) => ctx.db.insert('inbox_state', { profile_id: seat.id, built: false }))
    clock(10)
    expect(await resume(s)).toEqual({ state: 'unchecked' })
    // an eligible item in the ready seat still answers summary
    await newsAt(t, f, 12)
    clock(15)
    expect(await resume(s)).toEqual({ state: 'summary' })
  })

  it('answers unchecked when a check of a seat’s access stops, and summary when another seat holds new activity', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a seat that sees PCB only through its team, as in the unread
    // summary's case (tests/inboxReads.test.ts)
    const me = await plantLogin(t, await plantSeat(t, { org_id: f.org.id, accepted_at: NOW }))
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub2.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    // the login's second seat, an admin of an organization the catch-up
    // reads after the first, made ready by a message before the checkpoint
    const later = await laterOrg(t, f.org.id)
    const second = await plantSeat(t, {
      org_id: later.id,
      auth_user_id: me.auth_user_id,
      org_role: 'admin',
      accepted_at: NOW,
    })
    const elsewhere = await plantProject(t, { org_id: later.id })
    const news = async (to: Doc<'profiles'>, minute: number) => {
      const [org, project_id] = to === me ? [f.org, f.sub2.id] : [later, elsewhere.id]
      const task = await plantIssue(t, { org_id: org.id, project_id })
      expect(await post(t, { org, admin: f.admin }, { to, task, minute })).not.toBeNull()
    }
    await news(second, -1)
    const s = await signIn(t, me.auth_user_id as string)
    expect(await resume(s)).toEqual({ state: 'baseline' })
    await news(me, 1)
    // no team share read project by project, at once or team by team
    const stop = () =>
      Object.assign(OWN_READS, { projectShares: 0, rows: 0, lookups: 0, teamReads: 0 })
    clock(2)
    stop()
    expect(await resume(s)).toEqual({ state: 'unchecked' })
    // new activity in both seats, where the first still stops and the
    // second finds it
    Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
    await news(me, 3)
    await news(second, 3)
    clock(4)
    stop()
    expect(await resume(s)).toEqual({ state: 'summary' })
  })

  it('leaves out a seat whose organization’s deletion began', async () => {
    const t = newT()
    const { f, s } = await guestFixture(t)
    expect(await resume(s)).toEqual({ state: 'baseline' })
    await newsAt(t, f, 3)
    await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        phase: 'profiles',
        created_at: NOW,
      }),
    )
    clock(5)
    expect(await resume(s)).toEqual({ state: 'none' })
  })

  it('reads back NOTIFY.lag_ms for an item stored late, but never what was alerted, summarized or baselined', async () => {
    const t = newT()
    const { f, s } = await guestFixture(t)
    // a message from before the baseline claim, in its last minute, which
    // the client took as its baseline and never offered
    const seen = eventOf((await newsAt(t, f, -0.2)).message)
    await beat(s)
    expect(await claim(s, [], seen.at)).toMatchObject({ state: 'granted', keys: [] })
    clock(5)
    expect(await resume(s)).toEqual({ state: 'none' })
    // a notice a background step stores after the summary, with its write's
    // earlier time, goes to the next summary
    await newsAt(t, f, 4.5)
    clock(10)
    expect(await resume(s)).toEqual({ state: 'summary' })
    // what that summary found in its last minute is recorded for the next
    const recent = await newsAt(t, f, 9.7)
    clock(10.1)
    expect(await resume(s)).toEqual({ state: 'summary' })
    expect((await records(t)).map((r) => r.key)).toEqual([recent.message.id])
    clock(10.5)
    expect(await resume(s)).toEqual({ state: 'none' })
    // an event alerted just before the checkpoint is not counted again
    const alerted = eventOf((await newsAt(t, f, 10.6)).message)
    clock(11)
    await beat(s)
    expect(await claim(s, [alerted], START + 10.8 * MINUTE)).toMatchObject({
      keys: [alerted.key],
    })
    clock(12)
    expect(await resume(s)).toEqual({ state: 'none' })
  })

  it('leaves a notice stored after a summary and a claim, with a time just before the summary, to a live alert', async () => {
    const t = newT()
    const { f, s } = await guestFixture(t)
    expect(await resume(s)).toEqual({ state: 'baseline' })
    clock(5)
    expect(await resume(s)).toEqual({ state: 'none' })
    // a claim after the summary moves the checkpoint past it
    const news = eventOf((await newsAt(t, f, 6.5)).message)
    clock(7)
    await beat(s)
    expect(await claim(s, [news], news.at)).toMatchObject({ keys: [news.key] })
    // a background step stores a notice with its write's time, 20 s before
    // the summary, which the summary never saw
    const late = eventOf((await newsAt(t, f, 5 - 20 / 60)).message)
    expect(await claim(s, [late], news.at)).toEqual({
      state: 'granted',
      keys: [late.key],
      limited: false,
    })
    clock(8)
    expect(await resume(s)).toEqual({ state: 'none' })
  })

  it('records every unread message of an item it counted in its last minute, so reading the newest repeats nothing', async () => {
    const t = newT()
    const { f, s } = await guestFixture(t)
    expect(await resume(s)).toEqual({ state: 'baseline' })
    // two unread messages about one task in the summary's last minute
    const { task, message: older } = await newsAt(t, f, 0.2)
    const newer = (await post(t, f, { to: f.guest, task, minute: 0.4 })) as Doc<'messages'>
    clock(0.5)
    expect(await resume(s)).toEqual({ state: 'summary' })
    expect((await records(t)).map((r) => r.key).sort()).toEqual([older.id, newer.id].sort())
    // the newest alone is marked read, which leaves the older one the item's
    // newest unread event inside the next summary's read back
    await as(t, f.guest).mutation(api.messages.markRead, { org_id: f.org.id, ids: [newer.id] })
    expect(await unreadOf(t, f, task)).toHaveLength(1)
    clock(0.75)
    expect(await resume(s)).toEqual({ state: 'none' })
    // a new message about the same task is a new gap
    await post(t, f, { to: f.guest, task, minute: 0.8 })
    clock(1)
    expect(await resume(s)).toEqual({ state: 'summary' })
  })

  it('records the snooze return of an item it counted in its last minute, so reading the newer message repeats nothing', async () => {
    const t = newT()
    const { f, s } = await guestFixture(t)
    const guest = as(t, f.guest)
    const { task, message } = await newsAt(t, f, -1)
    const until = at5()
    await guest.mutation(api.messages.snooze, { org_id: f.org.id, ids: [message.id], until })
    expect(await resume(s)).toEqual({ state: 'baseline' })
    // the item returns at minute 5 and a newer message follows, both in the
    // summary's last minute
    clock(5)
    await t.mutation(internal.messages.wake, {
      recipient_id: f.guest.id,
      issue_id: task.id,
      until,
    })
    const newer = (await post(t, f, { to: f.guest, task, minute: 5.25 })) as Doc<'messages'>
    clock(5.5)
    expect(await resume(s)).toEqual({ state: 'summary' })
    expect((await records(t)).map((r) => r.key).sort()).toEqual(
      [newer.id, `${task.id}:${at5()}`].sort(),
    )
    // the newer message alone is marked read, which leaves the wake, later
    // than the older unread message, the item's newest unread event inside
    // the next summary's read back
    await guest.mutation(api.messages.markRead, { org_id: f.org.id, ids: [newer.id] })
    expect(await unreadOf(t, f, task)).toHaveLength(1)
    clock(6)
    expect(await resume(s)).toEqual({ state: 'none' })
  })

  it('stops reading back once the records of what it would pass may be gone', async () => {
    const t = newT()
    const { f, s } = await guestFixture(t)
    await beat(s)
    expect(await summary(s)).toEqual({ state: 'baseline' })
    clock(1)
    const alerted = eventOf((await newsAt(t, f, 0.9)).message)
    await beat(s)
    expect(await claim(s, [alerted], alerted.at)).toMatchObject({ keys: [alerted.key] })
    clock(1 + NOTIFY.keep_ms / MINUTE + 1)
    await t.mutation(internal.notifications.expire, {})
    expect(await records(t)).toEqual([])
    expect(await resume(s)).toEqual({ state: 'none' })
  })
})

/** A new organization whose id sorts after `than`, so a catch-up reads a
 * seat of it after one of `than`'s. */
async function laterOrg(t: T, than: string) {
  let id = uuid()
  while (id <= than) id = uuid()
  return await t.run(async (ctx) => {
    const _id = await ctx.db.insert('organizations', {
      id,
      name: 'Later',
      slug: `later-${id.slice(0, 8)}`,
      created_at: NOW,
      date_format: 'iso',
      week_start: 1,
      week_one_rule: 'first4day',
      default_plannable_hours: 40,
    })
    await ctx.db.insert('org_counters', { org_id: id, next_issue_num: 1, next_project_num: 2 })
    return (await ctx.db.get(_id)) as Doc<'organizations'>
  })
}

/** The wake time of the snooze-return test, minute 5. */
const at5 = () => new Date(START + 5 * MINUTE).toISOString()

/* ----------------------------------------------------- nothing marked read */

describe('claims and summaries', () => {
  it('leave every message, item and build state as they were', async () => {
    const t = newT()
    const { f, s } = await guestFixture(t)
    await newsAt(t, f, -1)
    expect(await resume(s)).toEqual({ state: 'baseline' })
    const news = eventOf((await newsAt(t, f, 1)).message)
    await newsAt(t, f, 2)
    const before = await inboxRows(t)
    clock(1.5)
    await beat(s)
    expect(await claim(s, [news], news.at)).toMatchObject({ keys: [news.key] })
    clock(5)
    expect(await resume(s)).toEqual({ state: 'summary' })
    await setDelivery(s, 'all')
    await resume(s)
    await claim(s, [news], news.at)
    expect(await inboxRows(t)).toEqual(before)
  })
})

/* ------------------------------------------------------------- teardowns */

/** The environment Better Auth's options need (auth.ts createAuth). */
const authEnv = () =>
  vi.stubEnv('BETTER_AUTH_SECRET', 'notifications-hermetic-secret-not-a-real-deployment-314159')

/** Better Auth's own deletes, each through the adapter with Qivo's
 * session delete trigger, as sign-out, a ban and a deleted login run them. */
const betterAuth = (t: T) => ({
  deleteSession: (token: string) =>
    t.run(async (ctx) => (await createAuth(ctx).$context).internalAdapter.deleteSession(token)),
  deleteUserSessions: (userId: string) =>
    t.run(async (ctx) =>
      (await createAuth(ctx).$context).internalAdapter.deleteUserSessions(userId),
    ),
  deleteUser: (userId: string) =>
    t.run(async (ctx) => (await createAuth(ctx).$context).internalAdapter.deleteUser(userId)),
})

/** Gives login `authUserId` two sessions with rows, the setting 'all' and
 * three records, and answers the sessions. */
async function busyLogin(t: T, authUserId: string): Promise<Session[]> {
  const sessions = [await signIn(t, authUserId), await signIn(t, authUserId)]
  for (const s of sessions) await beat(s)
  await claim(sessions[1], [ev('one', 0), ev('two', 0), ev('three', 0)], START)
  await setDelivery(sessions[0], 'all')
  return sessions
}

/** Login `authUserId`'s notification rows of each table. */
const rowsOf = async (t: T, authUserId: string) => ({
  accounts: (await accountRows(t)).filter((r) => r.auth_user_id === authUserId).length,
  sessions: (await sessionRows(t)).filter((r) => r.auth_user_id === authUserId).length,
  records: (await records(t)).filter((r) => r.auth_user_id === authUserId).length,
})

describe('teardowns', () => {
  it('delete a session’s row with the session at sign-out, a ban and the nightly expiry', async () => {
    authEnv()
    const t = newT()
    const login = await lonelyLogin(t)
    const [a, b, c] = [await signIn(t, login), await signIn(t, login), await signIn(t, login)]
    const other = await signIn(t, await lonelyLogin(t, 'other'))
    for (const s of [a, b, c, other]) await beat(s)
    expect(await claim(c, [ev('k', 0)])).toMatchObject({ keys: ['k'] })
    await betterAuth(t).deleteSession(a.token)
    expect((await sessionRows(t)).map((r) => r.session_id).sort()).toEqual(
      [b.sessionId, c.sessionId, other.sessionId].sort(),
    )
    await betterAuth(t).deleteUserSessions(login)
    expect((await sessionRows(t)).map((r) => r.session_id)).toEqual([other.sessionId])
    // the records are left to expire
    expect(await records(t)).toHaveLength(1)
    const brief = await signIn(t, login, MINUTE)
    await beat(brief)
    clock(2)
    await t.mutation(internal.authRetention.expireSessions, {})
    expect((await sessionRows(t)).map((r) => r.session_id)).toEqual([other.sessionId])
  })

  it('delete the row on the demo too, before the trigger’s demo return', async () => {
    vi.stubEnv('APP_MODE', 'demo')
    const t = newT()
    const login = await lonelyLogin(t)
    await t.run((ctx) =>
      ctx.db.insert('demo_sessions', {
        id: uuid(),
        auth_user_id: login,
        org_id: uuid(),
        status: 'ready',
        created_at: Date.now(),
        expires_at: Date.now() + DAY,
      }),
    )
    const [a, b] = [await signIn(t, login), await signIn(t, login)]
    for (const s of [a, b]) await beat(s)
    const doc = (s: Session) => runInAuth(t, (ctx) => ctx.db.get(s.sessionId as never))
    await t.mutation(internal.authTriggers.onDelete, { doc: await doc(a), model: 'session' })
    await t.mutation(internal.authTriggers.onExpiredDelete, {
      doc: await doc(b),
      model: 'session',
    })
    expect(await sessionRows(t)).toEqual([])
  })

  it('delete every row of a login Better Auth deletes, in steps', async () => {
    authEnv()
    const t = newT()
    const login = await lonelyLogin(t)
    const other = await lonelyLogin(t, 'other')
    await busyLogin(t, login)
    await busyLogin(t, other)
    expect(await rowsOf(t, login)).toEqual({ accounts: 1, sessions: 2, records: 3 })
    EXPIRY.records = 1
    EXPIRY.sessions = 1
    await betterAuth(t).deleteUser(login)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await rowsOf(t, login)).toEqual({ accounts: 0, sessions: 0, records: 0 })
    expect(await rowsOf(t, other)).toEqual({ accounts: 1, sessions: 2, records: 3 })
  })

  it('delete every row of a login the console deletes, whose sessions go without the trigger', async () => {
    const t = newT()
    const orphan = await lonelyLogin(t, 'orphan')
    const minted = await lonelyLogin(t, 'minted')
    const other = await lonelyLogin(t, 'other')
    for (const login of [orphan, minted, other]) await busyLogin(t, login)
    EXPIRY.records = 1
    EXPIRY.sessions = 1
    await t.mutation(internal.adminAuth.deleteOrphanLogin, { email: 'orphan@testbed.test' })
    await t.mutation(internal.adminAuth.removeAuthUser, { auth_user_id: minted })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    for (const login of [orphan, minted])
      expect(await rowsOf(t, login)).toEqual({ accounts: 0, sessions: 0, records: 0 })
    expect(await rowsOf(t, other)).toEqual({ accounts: 1, sessions: 2, records: 3 })
    // safe to run again, and for a login with no rows
    await t.mutation(internal.notifications.forgetLogin, { auth_user_id: orphan })
    await t.mutation(internal.notifications.forgetLogin, { auth_user_id: 'never-signed-in' })
  })

  it('expire records and session rows not beaten for 8 days in steps, ended ones too, never a live one', async () => {
    const t = newT()
    const login = await lonelyLogin(t)
    const [ended, gone, live] = [
      await signIn(t, login, 30 * DAY),
      await signIn(t, login, 30 * DAY),
      await signIn(t, login, 30 * DAY),
    ]
    for (const s of [ended, gone, live]) await beat(s)
    await ended.as.mutation(api.notifications.end, { instance: 'tab-1' })
    await claim(live, [ev('a', 0), ev('b', 0), ev('c', 0)])
    // the records outlive a cron run before their expiry
    clock(NOTIFY.keep_ms / MINUTE - 1)
    await t.mutation(internal.notifications.expire, {})
    expect(await records(t)).toHaveLength(3)
    // a session beaten a minute inside the 8 days stays, live or not
    const kept = NOTIFY.session_keep_ms / MINUTE
    clock(kept - 1)
    await beat(live)
    await beat(gone)
    clock(kept + 2)
    await beat(live)
    await claim(live, [ev('d', kept + 2)])
    EXPIRY.records = 1
    EXPIRY.sessions = 1
    await t.mutation(internal.notifications.expire, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect((await sessionRows(t)).map((r) => r.session_id).sort()).toEqual(
      [gone.sessionId, live.sessionId].sort(),
    )
    expect((await records(t)).map((r) => r.key)).toEqual(['d'])
    clock(kept * 2)
    await beat(live)
    await t.mutation(internal.notifications.expire, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect((await sessionRows(t)).map((r) => r.session_id)).toEqual([live.sessionId])
  })
})

/* ----------------------------------------------- inside Convex's limits */

/** A public function of notifications.ts run inside `caller`'s transaction,
 * its wrapper included, with what the transaction read. */
const measured = (caller: Session, fn: unknown, args: Record<string, unknown>) =>
  caller.as.run(async (ctx) => {
    const answer = await (
      fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> }
    )._handler(ctx, args)
    const m = await ctx.meta.getTransactionMetrics()
    return {
      answer,
      ranges: m.databaseQueries.used,
      documents: m.documentsRead.used,
      bytes: m.bytesRead.used,
      writes: m.documentsWritten.used,
    }
  })

/** Logs one measured call of a design size case and checks it stayed well
 * inside Convex's limits for one call. */
function logged(label: string, r: Awaited<ReturnType<typeof measured>>) {
  const { keys, ...answer } = r.answer as { keys?: string[] }
  const shown = keys === undefined ? answer : { ...answer, keys: keys.length }
  console.log(
    `${label}: ${JSON.stringify(shown)}, ${r.ranges} ranges, ${r.documents} documents, ${(r.bytes / 1024).toFixed(0)} KiB read, ${r.writes} written`,
  )
  expect(r.ranges, label).toBeLessThan(4096 / 2)
  expect(r.documents, label).toBeLessThan(32_000 / 2)
  expect(r.bytes, label).toBeLessThan(8 * 1024 * 1024)
  return r
}

/** `n` sub-projects of a new top-level project the guest is granted, and a
 * function that takes the grant away. */
async function grantedProject(t: T, f: OrgFixture, n: number) {
  const top = await plantProject(t, { org_id: f.org.id })
  const subs: Doc<'projects'>[] = []
  for (let i = 0; i < n; i++)
    subs.push(await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: top.id }))
  return { subs, revoke: await grant(t, f.guest, top.id) }
}

describe('inside Convex’s limits', () => {
  it('finds the everyday Inbox’s new activity at once: 60 groups over 3 sub-projects, 10 new', async () => {
    const t = newT()
    const { f, s } = await guestFixture(t)
    const { subs } = await grantedProject(t, f, 3)
    // 50 groups (minutes 0 to 16) before the checkpoint, 10 after it
    for (const [i, sub] of subs.entries())
      await plantItems(t, f, f.guest, i === 2 ? 16 : 17, sub.id)
    clock(17)
    expect(await resume(s)).toEqual({ state: 'baseline' })
    for (let i = 0; i < 10; i++) await newsAt(t, f, 18 + i, subs[i % 3].id)
    clock(30)
    await beat(s)
    const r = logged(
      'claimSummary, the everyday Inbox',
      await measured(s, notifications.claimSummary, {}),
    )
    expect(r.answer).toEqual({ state: 'summary' })
  })

  it('passes 1,000 groups of a project the seat no longer sees without reading their tasks', async () => {
    const t = newT()
    const { f, s } = await guestFixture(t)
    // one eligible group from before the checkpoint, which a minute before
    // the items' first time leaves none of them at it
    await newsAt(t, f, -3)
    clock(-1)
    expect(await resume(s)).toEqual({ state: 'baseline' })
    // the project figure: 800 open and 200 Done tasks over its 3
    // sub-projects, a group each, all after the checkpoint
    const { subs, revoke } = await grantedProject(t, f, 3)
    for (const [i, sub] of subs.entries()) {
      await plantItems(t, f, f.guest, i === 2 ? 266 : 267, sub.id)
      await plantItems(t, f, f.guest, i === 2 ? 66 : 67, sub.id, { status: 'done' })
    }
    await revoke()
    const checkpoint = new Date((await accountOf(t, s.authUserId))?.covered_at ?? 0).toISOString()
    const after = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query('inbox_items')
            .withIndex('by_recipient_unread_list', (q) =>
              q
                .eq('recipient_id', f.guest.id)
                .eq('snoozed', false)
                .eq('unread', true)
                .gt('sort_at', checkpoint),
            )
            .collect()
        ).length,
    )
    expect(after).toBe(1000)
    clock(300)
    await beat(s)
    const r = logged(
      'claimSummary, 1,000 groups of a hidden project',
      await measured(s, notifications.claimSummary, {}),
    )
    expect(r.answer).toEqual({ state: 'none' })
    expect(r.documents).toBeGreaterThan(1000)
    expect(r.documents).toBeLessThan(1100)
  })

  it('answers one sub-project’s 300 open groups at the first, or from one empty range', async () => {
    const t = newT()
    const { f, s } = await guestFixture(t)
    expect(await resume(s)).toEqual({ state: 'baseline' })
    await plantItems(t, f, f.guest, 300, f.sub.id)
    clock(400)
    await beat(s)
    const after = logged(
      'claimSummary, 300 groups after the checkpoint',
      await measured(s, notifications.claimSummary, {}),
    )
    expect(after.answer).toEqual({ state: 'summary' })
    clock(401)
    await beat(s)
    const before = logged(
      'claimSummary, 300 groups before the checkpoint',
      await measured(s, notifications.claimSummary, {}),
    )
    expect(before.answer).toEqual({ state: 'none' })
    expect(before.documents).toBeLessThan(20)
  })

  it('claims 50 events in the default mode for a login with 3 sessions', async () => {
    const t = newT()
    const login = await lonelyLogin(t)
    const sessions = [await signIn(t, login), await signIn(t, login), await signIn(t, login)]
    for (const s of sessions) await beat(s)
    clock(0.5)
    await beat(sessions[0], { active: true })
    // a baseline first, so the claim checks the checkpoint, as every claim
    // of a target with one does
    await claim(sessions[0], [], START)
    const events = Array.from({ length: NOTIFY.claim_keys }, (_, i) => ev(uuid(), 0.001 * i))
    const r = logged(
      'claimAlerts, 50 events, 3 sessions',
      await measured(sessions[0], notifications.claimAlerts, { events, through: START }),
    )
    expect(r.answer).toMatchObject({ state: 'granted', limited: false })
    expect((r.answer as { keys: string[] }).keys).toHaveLength(50)
  })

  it('reads only the caller’s rows beside 1,000 people’s sessions and records, which the cron deletes in steps', async () => {
    const t = newT()
    const s = await signIn(t, await lonelyLogin(t), 30 * DAY)
    await beat(s)
    await claim(s, [ev('first', 0)], START)
    const events = (name: string) =>
      Array.from({ length: 10 }, (_, i) => ev(`${name}-${i}`, 0.01 * i))
    // after the checkpoint, so both claims read the caller's own activity
    // report in the check of activity after it
    clock(0.5)
    const quiet = {
      beat: await measured(s, notifications.beat, {
        instance: 'tab-1',
        can_notify: true,
        active: true,
      }),
      claim: await measured(s, notifications.claimAlerts, {
        events: events('mine'),
        through: START,
      }),
    }
    // 1,000 people, each with a session and 10 records
    for (let from = 0; from < 1000; from += 100)
      await t.run(async (ctx) => {
        for (let p = from; p < from + 100; p++) {
          const auth_user_id = `person-${p}`
          await ctx.db.insert('notification_sessions', {
            auth_user_id,
            session_id: `session-${p}`,
            instance: 'tab-1',
            can_notify: true,
            beat_at: Date.now(),
            active_at: Date.now(),
          })
          for (let k = 0; k < 10; k++)
            await ctx.db.insert('notification_deliveries', {
              auth_user_id,
              key: `theirs-${k}`,
              expires_at: Date.now() + NOTIFY.keep_ms,
            })
        }
      })
    clock(1)
    const crowded = {
      beat: logged(
        'beat beside 1,000 people',
        await measured(s, notifications.beat, {
          instance: 'tab-1',
          can_notify: true,
          active: true,
        }),
      ),
      claim: logged(
        'claimAlerts, 10 events, beside 1,000 people',
        await measured(s, notifications.claimAlerts, {
          events: events('theirs'),
          through: START,
        }),
      ),
    }
    expect((crowded.claim.answer as { keys: string[] }).keys).toHaveLength(10)
    for (const call of ['beat', 'claim'] as const) {
      expect(crowded[call].documents, call).toBe(quiet[call].documents)
      expect(crowded[call].ranges, call).toBe(quiet[call].ranges)
    }
    // the cron, a background job, deletes everything expired or stale in
    // steps, and the caller's live row stays
    clock(NOTIFY.session_keep_ms / MINUTE + 1)
    await beat(s)
    EXPIRY.records = 500
    EXPIRY.sessions = 50
    await t.mutation(internal.notifications.expire, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect((await sessionRows(t)).map((r) => r.session_id)).toEqual([s.sessionId])
    expect(await records(t)).toEqual([])
  })
})

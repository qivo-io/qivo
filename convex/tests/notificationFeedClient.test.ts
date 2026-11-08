/* The app's desktop alert client (src/lib/notificationFeed.ts) under its
 * leader (src/lib/notificationLeader.ts) against the real feed and session
 * functions in convex-test: the fresh start's baseline, the claims and
 * their answers, the resume order after a reconnect, a timer gap and a
 * capability that turns on, the summary after a cut or a rate limit, the
 * floor kept within ten minutes, the stored messages that come back into
 * view, what the client holds, and one leader for the tabs of a profile
 * with a takeover from its floor. Each tab is a client and a leader whose
 * mutations run as one planted Better Auth session, whose feed watch runs
 * inbox.feed again after each write the test makes, and whose alerts go to
 * a list. A tab leads alone unless a case gives it locks shared with other
 * tabs (src/lib/notificationTabs.setup.ts). Time is fake and starts at
 * helpers.setup.ts NOW, the time the inbox fixtures post at. */
/// <reference types="vite/client" />

import { type FunctionReference, getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createNotificationFeed,
  type FeedConvex,
  type NotificationFeed,
  RESUME_GAP_MS,
  SUMMARY_TAG,
} from '../../src/lib/notificationFeed'
import {
  type LeaderLocks,
  NOTIFY_CLIENT,
  type NotificationLeader,
  startNotificationLeader,
} from '../../src/lib/notificationLeader'
import { createChannelHub, createLockManager } from '../../src/lib/notificationTabs.setup'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { newWindowKey } from '../lib/db'
import { insertTask } from '../model/descriptions'
import { postMessage } from '../model/messages'
import { CATCH_UP } from '../model/notificationCatchup'
import { NOTIFY } from '../model/notificationSessions'
import {
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  runInAuth,
  type T,
  uuid,
  withReadingAdmin,
} from './helpers.setup'
import { archiveRaw, grant, post } from './inboxItems.setup'

const MINUTE = 60_000
const DAY = 86_400_000
const START = Date.parse(NOW)
const DEFAULT_NOTIFY = structuredClone(NOTIFY)
const DEFAULT_CATCH_UP = structuredClone(CATCH_UP)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})
afterEach(() => {
  Object.assign(NOTIFY, structuredClone(DEFAULT_NOTIFY))
  Object.assign(CATCH_UP, structuredClone(DEFAULT_CATCH_UP))
  vi.useRealTimers()
})

/** The fake clock's minutes after NOW. */
const minutesNow = () => (Date.now() - START) / MINUTE

/** Moves the clock `minutes` on without running a timer, as a sleep or a
    throttled tab does. */
const jump = (minutes: number) => vi.setSystemTime(Date.now() + minutes * MINUTE)

/** A Better Auth session of a login, planted in the component's own table. */
type Session = { sessionId: string; as: ReturnType<T['withIdentity']> }

async function signIn(t: T, authUserId: string): Promise<Session> {
  const now = Date.now()
  const sessionId: string = await runInAuth(t, (ctx) =>
    ctx.db.insert('session', {
      token: uuid(),
      userId: authUserId,
      expiresAt: now + 7 * DAY,
      createdAt: now,
      updatedAt: now,
    }),
  )
  return { sessionId, as: t.withIdentity({ subject: authUserId, sessionId }) }
}

/** One call a tab sent, with what it answered. */
type Call = { name: string; args: Record<string, unknown>; answer?: unknown; failed?: true }

/** A tab: a feed client of one session under its leader, its calls and
    its alerts. */
type Tab = {
  client: NotificationFeed
  leader: NotificationLeader | null
  /** the Convex client double its feed and leader call */
  convex: FeedConvex
  calls: Call[]
  /** the calls that have not answered yet */
  pending: Set<Promise<unknown>>
  notes: { tag: string; title: string; body: string }[]
  opened: number
  /** the floor its feed is watched with, null while not */
  after: number | null
  /** whether the watch changed since its last answer */
  dirty: boolean
  /** the socket's connection count its answers arrive with */
  connection: number
  online: boolean
  can: boolean
  /** tells the leader that the capability may have changed */
  permissionChanged: () => void
  /** a mutation name the next call of fails once, for a failure case */
  failNext: string | null
  s: Session
  /** the locks its leader shares with other tabs, none to lead alone */
  locks: LeaderLocks | null
}

/* The tabs a case opened, whose leaders stop after it. */
const opened: Tab[] = []
afterEach(() => {
  for (const tab of opened.splice(0)) tab.leader?.stop()
})

/** Opens a tab of session `s`, which can notify unless `can` is false, and
    leads alone unless it shares `locks` with other tabs. */
function openTab(s: Session, can = true, locks: LeaderLocks | null = null): Tab {
  const tab = {
    leader: null,
    calls: [],
    pending: new Set(),
    notes: [],
    opened: 0,
    after: null,
    dirty: false,
    connection: 1,
    online: true,
    can,
    permissionChanged: () => {},
    failNext: null,
    s,
    locks,
  } as unknown as Tab
  const convex = {
    mutation: (ref: FunctionReference<'mutation'>, args: Record<string, unknown>) => {
      const name = getFunctionName(ref)
      const call: Call = { name, args }
      tab.calls.push(call)
      const run = (async () => {
        if (tab.failNext === name) {
          tab.failNext = null
          call.failed = true
          throw new Error('the network failed')
        }
        // convex-test's mutation, typed loosely as the client's is
        const mutate = s.as.mutation as (ref: unknown, args: unknown) => Promise<unknown>
        call.answer = await mutate(ref, args)
        return call.answer
      })()
      tab.pending.add(run)
      void run.then(
        () => tab.pending.delete(run),
        () => tab.pending.delete(run),
      )
      return run
    },
    connectionState: () => ({ isWebSocketConnected: tab.online }),
  } as unknown as FeedConvex
  tab.client = createNotificationFeed({
    convex,
    watch: (after) => {
      tab.after = after
      tab.dirty = true
    },
    unwatch: () => {
      tab.after = null
      tab.dirty = false
    },
    notify: (tag, title, body, onClick) => {
      tab.notes.push({ tag, title, body })
      // a click runs the store's way into the Inbox, which writes nothing
      if (tag === SUMMARY_TAG || tab.notes.length % 2 === 0) onClick()
    },
    openInbox: () => {
      tab.opened += 1
    },
  })
  tab.convex = convex
  opened.push(tab)
  return tab
}

/** Starts tab `tab`'s leader, as the store does at its boot. */
function startLeader(tab: Tab) {
  tab.leader = startNotificationLeader({
    convex: tab.convex,
    feed: tab.client,
    canNotify: () => tab.can,
    watchCapability: (listener) => {
      tab.permissionChanged = () => listener(tab.can)
      return () => {
        tab.permissionChanged = () => {}
      }
    },
    watchSettings: (take) => {
      let stopped = false
      void tab.s.as.query(api.notifications.settings, {}).then((answer) => {
        if (!stopped) take(answer.delivery)
      })
      return () => {
        stopped = true
      }
    },
    name: 'qivo-notifications:test',
    locks: tab.locks,
    openChannel: tab.locks ? () => hub.open() : null,
    newInstance: () => uuid(),
  })
}

/* The tabs' channel, one for the whole file, as a browser profile's. */
const hub = createChannelHub()

/** Waits until tab `tab` has no call in flight and its feed is idle. */
async function quiet(tab: Tab) {
  for (let round = 0; round < 50; round++) {
    await tab.client.idle()
    if (tab.pending.size === 0) {
      await Promise.resolve()
      if (tab.pending.size === 0) return
    }
    await Promise.allSettled(tab.pending)
  }
}

/** Hands each tab whose watch changed, or all with `all`, the feed's
    answer for its floor, until no tab's watch moves. */
async function settle(tabs: readonly Tab[], all = false) {
  let every = all
  for (let round = 0; round < 50; round++) {
    let moved = false
    for (const tab of tabs) {
      await quiet(tab)
      if (tab.after === null || !(tab.dirty || every)) continue
      tab.dirty = false
      const value = await tab.s.as.query(api.inbox.feed, { after: tab.after })
      tab.client.receive({ value }, tab.connection)
      moved = true
    }
    every = false
    if (!moved) {
      for (const tab of tabs) await quiet(tab)
      return
    }
  }
  throw new Error('the tabs did not settle')
}

/** Starts the tabs' leaders and settles them. */
async function startTabs(tabs: readonly Tab[]) {
  for (const tab of tabs) startLeader(tab)
  // a shared lock grants on a later task
  await vi.advanceTimersByTimeAsync(0)
  await settle(tabs)
}

/** The names of a tab's calls from `from` on. */
const names = (tab: Tab, from = 0) => tab.calls.slice(from).map((c) => c.name)

/** The answers of a tab's calls of `name`. */
const answers = (tab: Tab, name: string) =>
  tab.calls.filter((c) => c.name === name).map((c) => c.answer)

/** A message to the guest about `task`, now, of `kind`, from the admin. */
const news = (
  t: T,
  f: OrgFixture,
  task: Doc<'issues'>,
  kind: 'mention' | 'change' | 'comment' = 'mention',
) => post(t, f, { to: f.guest, task, minute: minutesNow(), kind })

/** A guest fixture: the organization, the guest's session and a task the
    guest sees. */
async function fixture(t: T) {
  const f = await withReadingAdmin(t)
  const s = await signIn(t, f.guest.auth_user_id as string)
  const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Board rev C' })
  return { f, s, task }
}

/** Runs the fake timers on `ms`, settling the tabs after. */
async function wait(tabs: readonly Tab[], ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  await settle(tabs)
}

/* ---------------------------------------------------------- a fresh start */

describe('a fresh start', () => {
  it('replays no stored message, takes its baseline from the first answer, then alerts with today’s words', async () => {
    const t = newT()
    const { f, s, task } = await fixture(t)
    await news(t, f, task)
    const tab = openTab(s)
    await startTabs([tab])
    expect(tab.notes).toEqual([])
    expect(names(tab)).toEqual(['notifications:beat', 'notifications:claimAlerts'])
    const first = tab.calls[1]
    expect(first.args.events).toEqual([])
    expect(first.args.through).toBe(START)
    // a new mention raises one alert, tagged with the message id
    jump(1)
    const mention = await news(t, f, task)
    await settle([tab], true)
    expect(tab.notes).toEqual([
      { tag: mention?.id, title: 'admin mentioned you, Board rev C', body: mention?.detail },
    ])
    // three messages on one task raise three, oldest first
    jump(1)
    const three = []
    for (const kind of ['comment', 'change', 'comment'] as const) {
      jump(0.01)
      three.push(await news(t, f, task, kind))
    }
    await settle([tab], true)
    expect(tab.notes.slice(1).map((n) => n.tag)).toEqual(three.map((m) => m?.id))
    expect(tab.notes[2].title).toBe('admin, Board rev C')
    // a resume after them finds nothing to summarize
    tab.client.resume()
    await settle([tab])
    expect(answers(tab, 'notifications:claimSummary')).toEqual([{ state: 'none' }])
    expect(tab.notes).toHaveLength(4)
  })

  it('claims a summary first when its baseline answers summarize_first, then the baseline again', async () => {
    const t = newT()
    const { f, s, task } = await fixture(t)
    // another session moved the checkpoint last
    const other = openTab(await signIn(t, f.guest.auth_user_id as string))
    await startTabs([other])
    jump(1)
    await news(t, f, task)
    await settle([other], true)
    expect(other.notes).toHaveLength(1)
    // the new session becomes the target as it enters and must summarize
    jump(1)
    const tab = openTab(s)
    await startTabs([tab])
    expect(names(tab)).toEqual([
      'notifications:beat',
      'notifications:claimAlerts',
      'notifications:beat',
      'notifications:claimSummary',
      'notifications:claimAlerts',
    ])
    expect(answers(tab, 'notifications:claimAlerts')[0]).toEqual({ state: 'summarize_first' })
    expect(
      tab.calls.filter((c) => c.name === 'notifications:claimAlerts').map((c) => c.args.events),
    ).toEqual([[], []])
  })
})

/* --------------------------------------------------------------- tabs */

describe('tabs and sessions', () => {
  it('raises one alert an event across two tabs of one session, and one summary when both resume', async () => {
    const t = newT()
    const { f, s, task } = await fixture(t)
    const a = openTab(s)
    const b = openTab(s)
    await startTabs([a, b])
    jump(1)
    const mention = await news(t, f, task)
    await settle([a, b], true)
    expect([...a.notes, ...b.notes].map((n) => n.tag)).toEqual([mention?.id])
    // both tabs sleep and come back with a mention in between
    jump(1)
    await news(t, f, task)
    jump(10)
    await wait([a, b], NOTIFY_CLIENT.tick_ms)
    const summaries = [...a.notes, ...b.notes].filter((n) => n.tag === SUMMARY_TAG)
    expect(summaries).toHaveLength(1)
  })

  it('alerts only in the target of the default mode, and hands on with a summary when its capability turns off', async () => {
    const t = newT()
    const { f, task } = await fixture(t)
    const login = f.guest.auth_user_id as string
    const first = openTab(await signIn(t, login))
    await startTabs([first])
    jump(0.5)
    // the second session entered last, so it is the target
    const second = openTab(await signIn(t, login))
    await startTabs([second])
    jump(0.5)
    const mention = await news(t, f, task)
    await settle([first, second], true)
    expect(second.notes.map((n) => n.tag)).toEqual([mention?.id])
    expect(first.notes).toEqual([])
    expect(answers(first, 'notifications:claimAlerts').at(-1)).toEqual({ state: 'not_target' })
    // the target's capability turns off: one beat that says so, no watch
    second.can = false
    const before = second.calls.length
    second.permissionChanged()
    await settle([first, second])
    expect(second.calls.slice(before)).toEqual([
      expect.objectContaining({
        name: 'notifications:beat',
        args: expect.objectContaining({ can_notify: false }),
      }),
    ])
    expect(second.after).toBeNull()
    // the first session's next claim summarizes first and shows the summary
    jump(0.5)
    const next = await news(t, f, task)
    await settle([first, second], true)
    expect(answers(first, 'notifications:claimAlerts').at(-2)).toEqual({ state: 'summarize_first' })
    expect(first.notes.map((n) => n.tag)).toEqual([SUMMARY_TAG])
    // and after it, the next mention alerts there
    jump(0.5)
    const later = await news(t, f, task)
    await settle([first, second], true)
    expect(first.notes.map((n) => n.tag)).toEqual([SUMMARY_TAG, later?.id])
    expect(first.notes.map((n) => n.tag)).not.toContain(next?.id)
  })
})

/* ---------------------------------------------------------- the leader */

describe('the leader tab', () => {
  it('lets one tab of a profile beat and claim, and the next take over from its floor with no baseline', async () => {
    const t = newT()
    const { f, s, task } = await fixture(t)
    const locks = createLockManager()
    const a = openTab(s, true, locks)
    const b = openTab(s, true, locks)
    await startTabs([a, b])
    expect([a.leader?.role(), b.leader?.role()]).toEqual(['leader', 'follower'])
    expect(b.calls).toEqual([])
    expect(b.after).toBeNull()
    jump(1)
    const mention = await news(t, f, task)
    await settle([a, b], true)
    expect(a.notes.map((n) => n.tag)).toEqual([mention?.id])
    expect(b.notes).toEqual([])
    // the leader's tab goes: the other takes over, beats first and goes on
    // from the floor and keys the leader posted, with no baseline
    const floor = a.after
    a.leader?.stop()
    await vi.advanceTimersByTimeAsync(0)
    await settle([b])
    expect(b.leader?.role()).toBe('leader')
    expect(names(b)[0]).toBe('notifications:beat')
    expect(b.after).toBe(floor)
    expect(names(b)).not.toContain('notifications:claimSummary')
    jump(0.5)
    const next = await news(t, f, task)
    await settle([b], true)
    expect(b.notes.map((n) => n.tag)).toEqual([next?.id])
    const claims = b.calls.filter((c) => c.name === 'notifications:claimAlerts')
    expect(claims.map((c) => (c.args.events as { key: string }[]).map((e) => e.key))).toEqual([
      [next?.id],
    ])
  })

  it('runs the resume order in a takeover whose last heard beat is stale', async () => {
    const t = newT()
    const { f, s, task } = await fixture(t)
    const locks = createLockManager()
    const a = openTab(s, true, locks)
    const b = openTab(s, true, locks)
    await startTabs([a, b])
    // the leader froze two minutes ago and posted nothing since
    a.online = false
    jump(1)
    await news(t, f, task)
    jump(1.5)
    a.leader?.stop()
    await vi.advanceTimersByTimeAsync(0)
    await settle([b], true)
    expect(names(b).slice(0, 2)).toEqual(['notifications:beat', 'notifications:claimSummary'])
    expect(answers(b, 'notifications:claimSummary')).toEqual([{ state: 'summary' }])
  })
})

/* ------------------------------------------------------------ resumes */

describe('resumes', () => {
  it('shows one summary for what arrived during an outage, and claims only after it', async () => {
    const t = newT()
    const { f, s, task } = await fixture(t)
    const tab = openTab(s)
    await startTabs([tab])
    tab.online = false
    jump(1)
    const missed = [await news(t, f, task), await news(t, f, task)]
    // a beat that came due while offline sent nothing
    await wait([tab], 2 * MINUTE)
    expect(tab.notes).toEqual([])
    tab.online = true
    tab.connection = 2
    const from = tab.calls.length
    await settle([tab], true)
    // a beat, then claimSummary, before any claim
    const after = names(tab, from)
    expect(after[0]).toBe('notifications:beat')
    expect(after.indexOf('notifications:claimSummary')).toBe(1)
    expect(after).toContain('notifications:claimAlerts')
    expect(tab.notes.map((n) => n.tag)).toEqual([SUMMARY_TAG])
    for (const m of missed) expect(tab.notes.map((n) => n.tag)).not.toContain(m?.id)
  })

  it('claims through the answer’s newest time, never a clock or a beat’s, so a notice stored late reaches the summary', async () => {
    const t = newT()
    const { f, s, task } = await fixture(t)
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Late' })
    const tab = openTab(s)
    await startTabs([tab])
    // two minutes of beats, then a mention stored half a minute back
    await wait([tab], 2 * MINUTE)
    const mention = await post(t, f, { to: f.guest, task, minute: 1.5, kind: 'mention' })
    await settle([tab], true)
    expect(tab.notes.map((n) => n.tag)).toEqual([mention?.id])
    const claim = tab.calls.filter((c) => c.name === 'notifications:claimAlerts').at(-1)
    expect(claim?.args.through).toBe(Date.parse(mention?.created_at as string))
    // offline, a notice stored late with a time between the mention and the claim
    tab.online = false
    await post(t, f, { to: f.guest, task: other, minute: 1.75 })
    await settle([tab], true)
    tab.online = true
    tab.connection = 2
    await settle([tab], true)
    expect(answers(tab, 'notifications:claimSummary')).toEqual([{ state: 'summary' }])
  })

  it('runs the resume order once for a wake, a reconnect and a gap a few seconds apart', async () => {
    const t = newT()
    const { f, s, task } = await fixture(t)
    const tab = openTab(s)
    await startTabs([tab])
    jump(10)
    await news(t, f, task)
    // the overdue tick finds the gap at once, then the desktop app's wake
    // and the reconnect come a second or two later
    const from = tab.calls.length
    await wait([tab], NOTIFY_CLIENT.tick_ms)
    expect(names(tab, from)).toContain('notifications:claimSummary')
    jump(0.02)
    tab.client.resume()
    await settle([tab])
    jump(0.02)
    tab.connection = 2
    await settle([tab], true)
    expect(names(tab, from).filter((n) => n === 'notifications:claimSummary')).toHaveLength(1)
    // a reconnect while a resume runs adds no second one
    jump(1)
    const value = await tab.s.as.query(api.inbox.feed, { after: tab.after ?? 0 })
    const during = tab.calls.length
    tab.client.resume()
    tab.connection = 3
    tab.client.receive({ value }, tab.connection)
    await settle([tab], true)
    expect(names(tab, during).filter((n) => n === 'notifications:claimSummary')).toHaveLength(1)
    expect(tab.notes.filter((n) => n.tag === SUMMARY_TAG)).toHaveLength(1)
  })

  it('takes a ten-minute gap between ticks for a resume, and a throttled minute for none', async () => {
    const t = newT()
    const { f, s, task } = await fixture(t)
    const tab = openTab(s)
    await startTabs([tab])
    // a hidden tab's timer running a minute late asks nothing
    jump(0.75)
    await wait([tab], NOTIFY_CLIENT.tick_ms)
    expect(names(tab)).not.toContain('notifications:claimSummary')
    // a sleep of ten minutes, with the feed's answers kept
    await news(t, f, task)
    jump(10)
    await wait([tab], NOTIFY_CLIENT.tick_ms)
    expect(answers(tab, 'notifications:claimSummary')).toEqual([{ state: 'summary' }])
    expect(tab.notes.map((n) => n.tag)).toEqual([SUMMARY_TAG])
    expect(RESUME_GAP_MS).toBeGreaterThan(MINUTE)
  })

  it('calls nothing without the capability, and beats, summarizes, then claims once it turns on', async () => {
    const t = newT()
    const { f, s, task } = await fixture(t)
    // a page that never can notify sends nothing and watches nothing
    const quiet = openTab(await signIn(t, f.guest.auth_user_id as string), false)
    await startTabs([quiet])
    await wait([quiet], 3 * MINUTE)
    expect(quiet.calls).toEqual([])
    expect(quiet.after).toBeNull()
    // one that could, turned off, then on again after a mention
    const tab = openTab(s)
    await startTabs([tab])
    tab.can = false
    tab.permissionChanged()
    await settle([tab])
    jump(1)
    await news(t, f, task)
    jump(1)
    tab.can = true
    const from = tab.calls.length
    tab.permissionChanged()
    await settle([tab])
    // the leader's beat, which the summary takes rather than beating again
    expect(names(tab, from).slice(0, 2)).toEqual([
      'notifications:beat',
      'notifications:claimSummary',
    ])
    expect(tab.calls[from].args).toMatchObject({ can_notify: true })
    expect(tab.notes.map((n) => n.tag)).toEqual([SUMMARY_TAG])
    jump(1)
    const mention = await news(t, f, task)
    await settle([tab], true)
    expect(tab.notes.map((n) => n.tag)).toEqual([SUMMARY_TAG, mention?.id])
    // off again: one beat that says so, and the watch stops
    tab.can = false
    const before = tab.calls.length
    tab.permissionChanged()
    await settle([tab])
    expect(tab.calls.slice(before).map((c) => [c.name, c.args.can_notify])).toEqual([
      ['notifications:beat', false],
    ])
    expect(tab.after).toBeNull()
  })

  it('beats and summarizes again after a failed claim, before it claims anything', async () => {
    const t = newT()
    const { f, s, task } = await fixture(t)
    const tab = openTab(s)
    await startTabs([tab])
    jump(0.25)
    tab.failNext = 'notifications:claimAlerts'
    const lost = await news(t, f, task)
    const from = tab.calls.length
    await settle([tab], true)
    expect(tab.notes).toEqual([])
    // the next run, here the next tick's, summarizes before any claim
    await wait([tab], NOTIFY_CLIENT.tick_ms)
    const after = tab.calls.slice(from)
    const failed = after.findIndex((c) => c.failed)
    expect(after[failed].name).toBe('notifications:claimAlerts')
    expect(after.slice(failed + 1, failed + 3).map((c) => c.name)).toEqual([
      'notifications:beat',
      'notifications:claimSummary',
    ])
    expect(answers(tab, 'notifications:claimSummary')).toEqual([{ state: 'summary' }])
    expect(tab.notes.map((n) => n.tag)).toEqual([SUMMARY_TAG])
    expect(tab.notes.map((n) => n.tag)).not.toContain(lost?.id)
  })
})

/* ------------------------------------------------------ bursts and limits */

describe('bursts and limits', () => {
  /** `n` mentions of the guest on as many tasks, spread over the last
      `spread` ms before now. */
  async function burst(t: T, f: OrgFixture, n: number, spread: number) {
    await t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        const issue = await plantIssueIn(ctx, f, i)
        await postMessage(ctx, {
          org_id: f.org.id,
          recipient_id: f.guest.id,
          issue_id: issue,
          kind: 'mention',
          body: `Burst ${i}`,
          actor_id: f.admin.id,
          now: new Date(Date.now() - spread + (i * spread) / n).toISOString(),
        })
      }
    })
  }

  it('turns a burst larger than one answer into one summary, not a stream of alerts', async () => {
    const t = newT()
    const { f, s } = await fixture(t)
    const tab = openTab(s)
    await startTabs([tab])
    await wait([tab], 2 * MINUTE)
    await burst(t, f, 60, 30_000)
    await settle([tab], true)
    expect(answers(tab, 'notifications:claimSummary')).toEqual([{ state: 'summary' }])
    expect(tab.notes.map((n) => n.tag)).toEqual([SUMMARY_TAG])
    // the next answer starts after the burst and asks nothing more
    await settle([tab], true)
    expect(answers(tab, 'notifications:claimSummary')).toHaveLength(1)
  })

  it('takes a fresh start’s first answer with more as its baseline, with no summary', async () => {
    const t = newT()
    const { f, s } = await fixture(t)
    await burst(t, f, 60, 30_000)
    const tab = openTab(s)
    await startTabs([tab])
    await wait([tab], 2 * NOTIFY_CLIENT.tick_ms)
    expect(names(tab)).not.toContain('notifications:claimSummary')
    expect(tab.notes).toEqual([])
  })

  it('asks claimSummary once for a burst inside the minute before the beat', async () => {
    const t = newT()
    const { f, s } = await fixture(t)
    const tab = openTab(s)
    await startTabs([tab])
    // five minutes of ticks and beats, then the burst
    await wait([tab], 5 * MINUTE)
    await burst(t, f, 60, 20_000)
    await settle([tab], true)
    await wait([tab], 2 * NOTIFY_CLIENT.tick_ms)
    expect(answers(tab, 'notifications:claimSummary')).toHaveLength(1)
  })

  it('shows what a limited claim granted, then asks claimSummary once', async () => {
    const t = newT()
    const { f, s } = await fixture(t)
    const tab = openTab(s)
    await startTabs([tab])
    NOTIFY.claim_window_most = 3
    jump(1)
    await burst(t, f, 5, 10_000)
    await settle([tab], true)
    expect(tab.notes.filter((n) => n.tag !== SUMMARY_TAG)).toHaveLength(3)
    expect(answers(tab, 'notifications:claimSummary')).toHaveLength(1)
  })
})

let burstNum = 70_000

/** A task in the guest's first sub-project, the `i`th of a burst. */
async function plantIssueIn(
  ctx: Parameters<Parameters<T['run']>[0]>[0],
  f: OrgFixture,
  i: number,
): Promise<string> {
  const id = uuid()
  await insertTask(
    ctx.db,
    {
      id,
      org_id: f.org.id,
      project_id: f.sub.id,
      num: burstNum++,
      title: `Burst task ${i}`,
      description: '',
      status: 'todo',
      priority: 'medium',
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      window_key: newWindowKey(),
    },
    'restore',
  )
  return id
}

/* ------------------------------------------------- the summary's answers */

describe('the summary', () => {
  it('shows only on summary, never on baseline, none or unchecked', async () => {
    const t = newT()
    const { f, s, task } = await fixture(t)
    // a login with no checkpoint yet answers baseline to a capability that
    // turns on
    const tab = openTab(s, false)
    await startTabs([tab])
    await news(t, f, task)
    tab.can = true
    tab.permissionChanged()
    await settle([tab])
    expect(answers(tab, 'notifications:claimSummary')).toEqual([{ state: 'baseline' }])
    // none, past the quiet seconds after a resume
    jump(0.1)
    tab.client.resume()
    await settle([tab])
    // unchecked: a budget with no room
    jump(1)
    await news(t, f, task)
    CATCH_UP.room = 0
    tab.client.resume()
    await settle([tab])
    Object.assign(CATCH_UP, structuredClone(DEFAULT_CATCH_UP))
    expect(answers(tab, 'notifications:claimSummary')).toEqual([
      { state: 'baseline' },
      { state: 'none' },
      { state: 'unchecked' },
    ])
    expect(tab.notes.filter((n) => n.tag === SUMMARY_TAG)).toEqual([])
  })

  it('beats again on not_registered and claims once more', async () => {
    const t = newT()
    const { f, s, task } = await fixture(t)
    const tab = openTab(s)
    await startTabs([tab])
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('notification_sessions').collect())
        await ctx.db.delete(row._id)
    })
    // before the next periodic beat registers the session again
    jump(0.25)
    const mention = await news(t, f, task)
    await settle([tab], true)
    const claims = answers(tab, 'notifications:claimAlerts')
    expect(claims.at(-2)).toEqual({ state: 'not_registered' })
    expect(claims.at(-1)).toMatchObject({ state: 'granted' })
    expect(tab.notes.map((n) => n.tag)).toContain(mention?.id)
  })
})

/* --------------------------------------------------- the floor and history */

describe('the floor', () => {
  it('keeps the floor within ten minutes through a quiet hour, so items back in view raise nothing', async () => {
    const t = newT()
    const { f, s } = await fixture(t)
    const lost = await plantProject(t, { org_id: f.org.id })
    const revoke = await grant(t, f.guest, lost.id)
    // 60 unread items about a project the guest then loses
    for (let i = 0; i < 60; i++) {
      const task = await plantIssue(t, { org_id: f.org.id, project_id: lost.id })
      await post(t, f, { to: f.guest, task, minute: 0.01 * i })
    }
    await revoke()
    jump(1)
    const tab = openTab(s)
    await startTabs([tab])
    // an hour with no event, the beats going on
    await wait([tab], 60 * MINUTE)
    const restore = await grant(t, f.guest, lost.id)
    await settle([tab], true)
    expect(tab.notes).toEqual([])
    expect(names(tab)).not.toContain('notifications:claimSummary')
    expect(tab.after).toBeGreaterThan(Date.now() - 11 * MINUTE)
    await restore()
  })

  it('alerts a message under ten minutes old that comes back into view, and not one older', async () => {
    const t = newT()
    const { f, s } = await fixture(t)
    const old = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Old' })
    const recent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Recent' })
    // unread messages eleven and three minutes old, nobody alerted, about
    // tasks archived before the archive's read steps ran
    await post(t, f, { to: f.guest, task: old, minute: -11 })
    const fresh = await post(t, f, { to: f.guest, task: recent, minute: -3 })
    await archiveRaw(t, [old, recent])
    const tab = openTab(s)
    await startTabs([tab])
    expect(tab.notes).toEqual([])
    // both restored, the archive's read mark beaten
    await t.run(async (ctx) => {
      for (const task of [old, recent]) await ctx.db.patch(task._id, { archived_at: undefined })
    })
    await settle([tab], true)
    expect(tab.notes.map((n) => n.tag)).toEqual([fresh?.id])
  })
})

/* ---------------------------------------------------- what it holds */

describe('what the client holds', () => {
  it('marks nothing read, and holds no more than one answer’s keys after 200 answers', async () => {
    const t = newT()
    const { f, s, task } = await fixture(t)
    const tab = openTab(s)
    await startTabs([tab])
    for (let i = 0; i < 200; i++) {
      jump(0.05)
      await news(t, f, task, 'comment')
      await settle([tab], true)
      expect(tab.client.held().keys).toBeLessThanOrEqual(51)
    }
    expect(tab.notes.length).toBeGreaterThan(0)
    expect(tab.opened).toBeGreaterThan(0)
    const read = await t.run(async (ctx) =>
      (await ctx.db.query('messages').collect()).filter((m) => m.read_at !== undefined),
    )
    expect(read).toEqual([])
    expect(names(tab).filter((n) => !n.startsWith('notifications:'))).toEqual([])
  })
})

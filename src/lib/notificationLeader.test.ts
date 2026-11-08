import { type FunctionReference, getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INPUTS } from './inputIdle'
import {
  type Beat,
  type FeedLink,
  type FeedStart,
  notificationCallsInFlight,
  othersInFlight,
  RESUME_GAP_MS,
} from './notificationFeed'
import {
  type Delivery,
  type LeaderLocks,
  leaderName,
  NOTIFY_CLIENT,
  type NotificationLeader,
  type NotifyMirror,
  startNotificationLeader,
} from './notificationLeader'
import { createChannelHub, createLockManager, createPageDouble } from './notificationTabs.setup'

/* The leader tab of a browser profile (lib/notificationLeader.ts) on
   simulated tabs: a shared Web Lock manager and channel, a page double for
   each tab's window and document, a Convex double that records each call,
   a feed double that records how it was started, and fake timers. The
   feed's own rules run against the server in convex/tests/
   notificationFeedClient.test.ts. */

const MINUTE = 60_000
const DEFAULT_CLIENT = structuredClone(NOTIFY_CLIENT)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  for (const tab of tabs.splice(0)) tab.leader.stop()
  Object.assign(NOTIFY_CLIENT, structuredClone(DEFAULT_CLIENT))
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** One call a tab sent. */
type Sent = { name: string; args: Record<string, unknown> }

/** A simulated browser profile: its tabs share the locks and the channel. */
function profile({ locks = true }: { locks?: boolean } = {}) {
  const manager = locks ? createLockManager() : null
  const hub = createChannelHub()
  // every message a tab posted on the channel, with the tab's number
  const posted: { from: number; message: Record<string, unknown> }[] = []
  return { manager, hub, posted }
}
type Profile = ReturnType<typeof profile>

/** A feed double that records how the leader drove it. */
type FeedDouble = {
  leads: FeedStart[]
  stops: number
  resumes: number
  beatens: number
  ticks: number
  link: FeedLink | null
  /** the keys it posts once it leads, as its first watch does */
  keys: string[]
  lead(start: FeedStart, link: FeedLink, first: Beat): void
  stop(): void
  resume(): void
  beaten(): void
  tick(): void
}

/** A simulated tab: its page, its Convex double's calls, its feed and its
    leader. */
type Tab = {
  number: number
  page: ReturnType<typeof createPageDouble>
  sent: Sent[]
  state: {
    can: boolean
    online: boolean
    every: number
    /** what the next calls throw, while set */
    fail: (() => unknown) | null
    /** whether the calls never answer */
    hang: boolean
  }
  feed: FeedDouble
  settings: { take: ((d: Delivery | null) => void) | null; watching: number }
  mirror: NotifyMirror | null
  leader: NotificationLeader
  beats: () => Sent[]
  ends: () => Sent[]
  /** says the capability may have changed, as lib/notify.ts would */
  capabilityChanged: () => void
  /** the desktop app's wake */
  wake: () => void
}

const tabs: Tab[] = []
let tabCount = 0

/** Opens a tab of profile `p`, which can notify unless `can` is false. */
function openTab(p: Profile, { can = true, locks }: { can?: boolean; locks?: LeaderLocks } = {}) {
  const number = ++tabCount
  const capability = new Set<(can: boolean) => void>()
  const powers = new Set<() => void>()
  const sent: Sent[] = []
  const feed: FeedDouble = {
    leads: [],
    stops: 0,
    resumes: 0,
    beatens: 0,
    ticks: 0,
    link: null,
    keys: ['m1'],
    lead(start, link, first) {
      feed.leads.push(start)
      feed.link = link
      link.moved({ after: first.now - 10 * MINUTE, keys: feed.keys })
    },
    stop() {
      feed.stops += 1
      feed.link = null
    },
    resume() {
      feed.resumes += 1
    },
    beaten() {
      feed.beatens += 1
    },
    tick() {
      feed.ticks += 1
    },
  }
  const tab: Tab = {
    number,
    page: createPageDouble(),
    sent,
    state: { can, online: true, every: MINUTE, fail: null, hang: false },
    feed,
    settings: { take: null, watching: 0 },
    mirror: null,
    leader: { stop: () => {}, role: () => 'stopped' },
    beats: () => sent.filter((s) => s.name === 'notifications:beat'),
    ends: () => sent.filter((s) => s.name === 'notifications:end'),
    capabilityChanged: () => {
      for (const listener of capability) listener(tab.state.can)
    },
    wake: () => {
      for (const listener of powers) listener()
    },
  }
  const convex = {
    mutation: (ref: FunctionReference<'mutation'>, args: Record<string, unknown>) => {
      const name = getFunctionName(ref)
      sent.push({ name, args })
      if (tab.state.fail) return Promise.reject(tab.state.fail())
      if (tab.state.hang) return new Promise(() => {})
      if (name === 'notifications:beat')
        return Promise.resolve({ every_ms: tab.state.every, live_ms: 180_000, now: Date.now() })
      return Promise.resolve(null)
    },
    connectionState: () => ({ isWebSocketConnected: tab.state.online }),
  }
  tabs.push(tab)
  tab.leader = startNotificationLeader({
    convex: convex as never,
    feed,
    canNotify: () => tab.state.can,
    watchCapability: (listener) => {
      capability.add(listener)
      return () => capability.delete(listener)
    },
    watchSettings: (take) => {
      tab.settings.take = take
      tab.settings.watching += 1
      return () => {
        tab.settings.take = null
        tab.settings.watching -= 1
      }
    },
    name: leaderName('https://happy-otter-123.convex.cloud', 'better-auth'),
    locks: locks ?? p.manager,
    openChannel: () => {
      const channel = p.hub.open()
      const post = channel.postMessage.bind(channel)
      channel.postMessage = (message) => {
        p.posted.push({ from: number, message: message as Record<string, unknown> })
        post(message)
      }
      return channel
    },
    win: tab.page.win,
    doc: tab.page.doc,
    inputs: INPUTS,
    power: {
      onResume: (listener) => {
        powers.add(listener)
        return () => powers.delete(listener)
      },
    },
    newInstance: () => `tab-${number}`,
    mirror: (m) => {
      tab.mirror = m
    },
  })
  return tab
}

/** Runs the microtasks and the timers due now, as a browser's next tasks. */
async function flush() {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
}

/** Fires a trusted input of `type` on tab `tab`'s window. */
const input = (tab: Tab, type = 'pointerdown', fields: Record<string, unknown> = {}) =>
  tab.page.win.fire(type, fields)

/* ----------------------------------------------------------------- election */

describe('the election', () => {
  it('gives three tabs one leader and two followers, and only the leader calls', async () => {
    const p = profile()
    const [a, b, c] = [openTab(p), openTab(p), openTab(p)]
    await flush()
    expect([a, b, c].map((t) => t.leader.role())).toEqual(['leader', 'follower', 'follower'])
    expect(a.beats()).toHaveLength(1)
    expect([...b.sent, ...c.sent]).toEqual([])
    expect(b.feed.leads).toEqual([])
    expect(c.settings.watching).toBe(0)
    // each follower says hello once
    const hellos = p.posted.filter((m) => m.message.kind === 'hello').map((m) => m.from)
    expect(hellos).toEqual([b.number, c.number])
    expect(a.mirror).toMatchObject({ role: 'leader', instance: `tab-${a.number}`, beats: 1 })
  })

  it('beats once a minute for ten tabs as for one', async () => {
    const p = profile()
    const all = Array.from({ length: 10 }, () => openTab(p))
    await flush()
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    const beats = all.map((t) => t.beats().length)
    expect(beats[0]).toBe(6)
    expect(beats.slice(1).every((n) => n === 0)).toBe(true)
  })

  it('leads alone without Web Locks, or when asking for one throws', async () => {
    const bare = profile({ locks: false })
    const [a, b] = [openTab(bare), openTab(bare)]
    await flush()
    expect([a.leader.role(), b.leader.role()]).toEqual(['alone', 'alone'])
    expect([a.beats().length, b.beats().length]).toEqual([1, 1])
    const broken: LeaderLocks = {
      request: () => {
        throw new Error('SecurityError')
      },
      query: async () => ({}),
    }
    const c = openTab(profile(), { locks: broken })
    await flush()
    expect(c.leader.role()).toBe('alone')
    expect(c.beats()).toHaveLength(1)
  })
})

/* ------------------------------------------------------- takeover and end */

describe('takeover and end', () => {
  it('hands on at the leader’s pagehide to a tab that beats first and starts from the posted floor', async () => {
    const p = profile()
    const [a, b] = [openTab(p), openTab(p)]
    await flush()
    a.page.win.fire('pagehide', { persisted: false })
    await flush()
    expect(b.leader.role()).toBe('leader')
    expect(b.sent[0]).toMatchObject({
      name: 'notifications:beat',
      args: { instance: `tab-${b.number}`, can_notify: true },
    })
    expect(b.feed.leads).toEqual([{ kind: 'takeover', after: expect.any(Number), keys: ['m1'] }])
    // a tab waited, so the old leader sent no end
    expect(a.ends()).toEqual([])
    expect(a.feed.stops).toBe(1)
  })

  it('takes the fresh start when it heard no floor, and the resume order when the heard beat is stale', async () => {
    const p = profile()
    const a = openTab(p, { can: false })
    const b = openTab(p)
    await flush()
    // a leader that cannot notify posts nothing
    a.page.win.fire('pagehide', { persisted: false })
    await flush()
    expect(b.feed.leads).toEqual([{ kind: 'fresh' }])
    const c = openTab(p)
    await flush()
    // b's tab freezes for longer than the resume threshold, then closes
    b.state.hang = true
    await vi.advanceTimersByTimeAsync(RESUME_GAP_MS + MINUTE)
    b.page.win.fire('pagehide', { persisted: false })
    await flush()
    expect(c.feed.leads).toEqual([{ kind: 'resume' }])
  })

  it('sends one end at a lone leader’s pagehide, none before its first beat, and none at a stop', async () => {
    const lone = openTab(profile())
    await flush()
    lone.page.win.fire('pagehide', { persisted: false })
    await flush()
    expect(lone.ends()).toEqual([
      { name: 'notifications:end', args: { instance: `tab-${lone.number}` } },
    ])
    expect(lone.mirror).toMatchObject({ role: 'stopped', ends: 1 })
    // a leader whose first beat never answered
    const early = openTab(profile())
    early.state.hang = true
    await flush()
    early.page.win.fire('pagehide', { persisted: false })
    expect(early.ends()).toEqual([])
    // a sign-out stops the leader, which sends no end
    const leaving = openTab(profile())
    await flush()
    leaving.leader.stop()
    leaving.page.win.fire('pagehide', { persisted: false })
    await flush()
    expect(leaving.ends()).toEqual([])
    expect(leaving.page.listening('pagehide')).toBe(0)
  })

  it('lets go at freeze and into the back and forward cache, and follows when it returns', async () => {
    const p = profile()
    const [a, b] = [openTab(p), openTab(p)]
    await flush()
    a.page.doc.fire('freeze')
    await flush()
    expect([a.leader.role(), b.leader.role()]).toEqual(['stopped', 'leader'])
    a.page.doc.fire('resume')
    await flush()
    expect(a.leader.role()).toBe('follower')
    // into the cache and back
    b.page.win.fire('pagehide', { persisted: true })
    await flush()
    expect(a.leader.role()).toBe('leader')
    b.page.win.fire('pageshow', { persisted: true })
    await flush()
    expect(b.leader.role()).toBe('follower')
  })

  it('drops a frozen follower’s turn, so a live tab takes over', async () => {
    const p = profile()
    const [a, b, c] = [openTab(p), openTab(p), openTab(p)]
    await flush()
    b.page.doc.fire('freeze')
    await flush()
    a.page.win.fire('pagehide', { persisted: false })
    await flush()
    expect(c.leader.role()).toBe('leader')
    expect(b.sent).toEqual([])
    // the frozen tab said bye, so a lone leader may end the session later
    expect(p.posted.some((m) => m.from === b.number && m.message.kind === 'bye')).toBe(true)
  })

  it('leads again after a freeze with the resume order', async () => {
    const lone = openTab(profile())
    await flush()
    lone.page.doc.fire('freeze')
    await flush()
    lone.page.doc.fire('resume')
    await flush()
    expect(lone.feed.leads).toEqual([{ kind: 'fresh' }, { kind: 'resume' }])
  })
})

/* -------------------------------------------------------------------- pace */

describe('the pace', () => {
  it('beats at the server’s pace, clamped', async () => {
    const tab = openTab(profile())
    await flush()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(tab.beats()).toHaveLength(2)
    tab.state.every = 21_600_000
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(tab.beats()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(6 * 60 * MINUTE - 1)
    expect(tab.beats()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(tab.beats()).toHaveLength(4)
    // a pace too fast or too slow is clamped
    tab.state.every = 1
    await vi.advanceTimersByTimeAsync(6 * 60 * MINUTE)
    expect(tab.beats()).toHaveLength(5)
    await vi.advanceTimersByTimeAsync(NOTIFY_CLIENT.every_min_ms - 1)
    expect(tab.beats()).toHaveLength(5)
    tab.state.every = 1e12
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(tab.beats()).toHaveLength(6)
    expect(tab.mirror?.every_ms).toBe(NOTIFY_CLIENT.every_max_ms)
  })

  it('beats at once on a mode change, not on an equal mode, and for the feed', async () => {
    const tab = openTab(profile())
    await flush()
    tab.settings.take?.('recent')
    await flush()
    expect(tab.beats()).toHaveLength(1)
    tab.settings.take?.('recent')
    tab.settings.take?.('all')
    await flush()
    expect(tab.beats()).toHaveLength(2)
    // the feed asks for a beat, as after not_registered
    await tab.feed.link?.beat()
    expect(tab.beats()).toHaveLength(3)
  })
})

/* ---------------------------------------------------------------- activity */

describe('reports of use', () => {
  it('reports input at once a minute after the last report, and not inside it', async () => {
    const tab = openTab(profile())
    // input before it leads rides on the first beat, which counts as no
    // report, since the server ignores `active` on a session's first beat
    input(tab)
    await flush()
    expect(tab.beats().map((b) => b.args.active)).toEqual([true])
    input(tab)
    await flush()
    expect(tab.beats().map((b) => b.args.active)).toEqual([true, true])
    // inside report_ms of the report, input waits
    input(tab, 'keydown')
    await vi.advanceTimersByTimeAsync(30_000)
    input(tab, 'wheel')
    await flush()
    expect(tab.beats()).toHaveLength(2)
    // the periodic beat a minute after the report carries the input of the
    // last minute
    await vi.advanceTimersByTimeAsync(30_000)
    expect(tab.beats().map((b) => b.args.active)).toEqual([true, true, true])
    // a quiet minute's beat reports nothing and restarts no report window,
    // so the next input reports at once
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(tab.beats().at(-1)?.args.active).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    input(tab, 'touchstart')
    await flush()
    expect(tab.beats().map((b) => b.args.active)).toEqual([true, true, true, false, true])
  })

  it('counts nothing hidden, untrusted or from a pointer that did not move', async () => {
    const tab = openTab(profile())
    await flush()
    await vi.advanceTimersByTimeAsync(NOTIFY_CLIENT.report_ms)
    const before = tab.beats().length
    input(tab, 'pointermove', { movementX: 0, movementY: 0 })
    input(tab, 'pointerdown', { isTrusted: false })
    Object.assign(tab.page.doc, { visibilityState: 'hidden' })
    input(tab, 'keydown')
    await flush()
    expect(tab.beats()).toHaveLength(before)
    Object.assign(tab.page.doc, { visibilityState: 'visible' })
    input(tab, 'pointermove', { movementX: 2, movementY: 0 })
    await flush()
    expect(tab.beats()).toHaveLength(before + 1)
  })

  it('forwards a follower’s input at most every forward_ms, with nothing about it', async () => {
    const p = profile()
    const [lead, follow] = [openTab(p), openTab(p)]
    await flush()
    await vi.advanceTimersByTimeAsync(NOTIFY_CLIENT.report_ms)
    input(follow, 'keydown', { key: 'a', code: 'KeyA' })
    input(follow, 'keydown', { key: 'b' })
    await flush()
    const inputs = p.posted.filter((m) => m.message.kind === 'input')
    expect(inputs).toEqual([{ from: follow.number, message: { kind: 'input' } }])
    expect(lead.beats().at(-1)?.args).toEqual({
      instance: `tab-${lead.number}`,
      can_notify: true,
      active: true,
    })
    await vi.advanceTimersByTimeAsync(NOTIFY_CLIENT.forward_ms)
    input(follow)
    await flush()
    expect(p.posted.filter((m) => m.message.kind === 'input')).toHaveLength(2)
    expect(follow.sent).toEqual([])
  })

  it('reports nothing in All enabled sessions, and the switch back carries recent input', async () => {
    const tab = openTab(profile())
    await flush()
    tab.settings.take?.('all')
    await flush()
    await vi.advanceTimersByTimeAsync(NOTIFY_CLIENT.report_ms)
    const before = tab.beats().length
    input(tab)
    await flush()
    expect(tab.beats()).toHaveLength(before)
    tab.settings.take?.('recent')
    await flush()
    expect(tab.beats().at(-1)?.args.active).toBe(true)
    // input older than report_ms is never reported as current
    tab.settings.take?.('all')
    await flush()
    input(tab)
    await vi.advanceTimersByTimeAsync(NOTIFY_CLIENT.report_ms + 1)
    tab.settings.take?.('recent')
    await flush()
    expect(tab.beats().at(-1)?.args.active).toBe(false)
  })
})

/* -------------------------------------------------------------- capability */

describe('the capability', () => {
  it('calls nothing in a profile that cannot notify', async () => {
    const p = profile()
    const [a, b] = [openTab(p, { can: false }), openTab(p, { can: false })]
    await flush()
    input(a)
    input(b)
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect([...a.sent, ...b.sent]).toEqual([])
    expect(a.settings.watching).toBe(0)
    expect(a.feed.leads).toEqual([])
  })

  it('beats at once as it turns on and starts the feed with the resume order, and beats once as it turns off', async () => {
    const tab = openTab(profile(), { can: false })
    await flush()
    tab.state.can = true
    tab.capabilityChanged()
    await flush()
    expect(tab.beats().map((b) => b.args.can_notify)).toEqual([true])
    expect(tab.feed.leads).toEqual([{ kind: 'resume' }])
    expect(tab.settings.watching).toBe(1)
    tab.state.can = false
    tab.capabilityChanged()
    await flush()
    expect(tab.beats().map((b) => b.args.can_notify)).toEqual([true, false])
    expect(tab.feed.stops).toBe(1)
    expect(tab.settings.watching).toBe(0)
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(tab.beats()).toHaveLength(2)
  })

  it('reads the capability again when a follower says it changed, and at its tick', async () => {
    const p = profile()
    const [lead, follow] = [openTab(p), openTab(p)]
    await flush()
    lead.state.can = false
    follow.capabilityChanged()
    await flush()
    expect(lead.beats().at(-1)?.args.can_notify).toBe(false)
    // a change nobody announced reaches the next tick
    lead.state.can = true
    await vi.advanceTimersByTimeAsync(NOTIFY_CLIENT.tick_ms)
    expect(lead.beats().at(-1)?.args.can_notify).toBe(true)
  })
})

/* ---------------------------------------------------------------- failures */

describe('failures', () => {
  it('retries a failed beat after 5, 30 and 120 seconds, then keeps the pace', async () => {
    const tab = openTab(profile())
    await flush()
    tab.state.fail = () => new Error('the network failed')
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(tab.beats()).toHaveLength(2)
    for (const wait of [5_000, 30_000, MINUTE]) {
      await vi.advanceTimersByTimeAsync(wait - 1)
      const n = tab.beats().length
      await vi.advanceTimersByTimeAsync(1)
      expect(tab.beats()).toHaveLength(n + 1)
    }
    // the third retry waited 120 s capped at the pace of a minute, and the
    // next keeps the pace
    tab.state.fail = null
    await vi.advanceTimersByTimeAsync(MINUTE)
    await flush()
    expect(tab.beats()).toHaveLength(6)
    expect(tab.mirror?.beats).toBe(2)
  })

  it('stops for a session that ended, a missing sign-in and a bad request', async () => {
    for (const refusal of [
      () => new ConvexError('Unauthenticated'),
      () => new ConvexError({ code: 'forbidden', message: 'not signed in' }),
      () =>
        new ConvexError({ code: 'bad_request', message: 'instance must be 1 to 64 characters' }),
    ]) {
      const tab = openTab(profile())
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      tab.state.fail = refusal
      await flush()
      await vi.advanceTimersByTimeAsync(10 * MINUTE)
      input(tab)
      await flush()
      expect(tab.beats()).toHaveLength(1)
      tab.page.win.fire('pagehide', { persisted: false })
      expect(tab.ends()).toEqual([])
    }
  })

  it('sends no beat while the socket is down, and the reconnect runs the resume order', async () => {
    const tab = openTab(profile())
    await flush()
    tab.state.online = false
    await vi.advanceTimersByTimeAsync(2 * MINUTE)
    expect(tab.beats()).toHaveLength(1)
    tab.state.online = true
    await vi.advanceTimersByTimeAsync(NOTIFY_CLIENT.tick_ms)
    expect(tab.feed.resumes).toBe(1)
    expect(tab.beats()).toHaveLength(1)
  })
})

/* ---------------------------------------------------------------- resumes */

describe('the resume entry', () => {
  it('takes the desktop app’s wake and a gap between ticks past the threshold', async () => {
    const tab = openTab(profile())
    await flush()
    tab.wake()
    expect(tab.feed.resumes).toBe(1)
    vi.setSystemTime(Date.now() + RESUME_GAP_MS + MINUTE)
    await vi.advanceTimersByTimeAsync(NOTIFY_CLIENT.tick_ms)
    expect(tab.feed.resumes).toBe(2)
    // a follower takes no wake
    const p = profile()
    const [, follow] = [openTab(p), openTab(p)]
    await flush()
    follow.wake()
    expect(follow.feed.resumes).toBe(0)
  })
})

/* -------------------------------------------------------- hidden and guard */

describe('hidden pages and the close guard', () => {
  it('keeps beating and watching the mode while hidden', async () => {
    const tab = openTab(profile())
    await flush()
    Object.assign(tab.page.doc, { visibilityState: 'hidden' })
    tab.page.doc.fire('visibilitychange')
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(tab.beats()).toHaveLength(6)
    expect(tab.settings.watching).toBe(1)
    expect(tab.leader.role()).toBe('leader')
  })

  it('leaves a beat in flight out of the guard, and counts a store write beside it', async () => {
    // calls earlier cases left hanging stay counted, as they would in a page
    const base = notificationCallsInFlight()
    const tab = openTab(profile())
    tab.state.hang = true
    await flush()
    expect(notificationCallsInFlight()).toBe(base + 1)
    expect(othersInFlight(base + 1) > 0).toBe(false)
    expect(othersInFlight(base + 2) > 0).toBe(true)
  })
})

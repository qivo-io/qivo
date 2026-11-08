/* The client of the person's desktop alerts: it reads the Inbox feed
   (convex/inbox.ts feed), asks the server which of its new events this
   session may show (notifications.claimAlerts), and after a gap asks
   whether unread activity arrived meanwhile (notifications.claimSummary).
   The header of convex/notifications.ts holds the rules every client
   follows; this module keeps them:

   - While the session cannot notify it beats nothing, watches no feed and
     claims nothing. When the capability turns off it beats once with
     `can_notify: false`, so the server stops choosing it and records the
     handoff, then stops the feed and forgets the answer and its keys.
   - A fresh start (a boot or a reload with the capability on) beats, sets
     its floor ALERT_WINDOW_MS before that beat's server time, watches the
     feed and takes its first answer as a baseline: a claim with no events
     and that answer's `through`, never offering its events, so signing in
     or reloading replays no stored history.
   - Each later answer offers the events whose keys the last handled
     answer did not hold, oldest first, in one claim with the answer's
     `through`, never a clock, and shows each granted one. The floor then
     moves to `through`, and on each beat answer it is raised to no
     further back than ALERT_WINDOW_MS before the beat's `now`, so it stays
     the later of ten minutes ago and the last `through`.
   - A resume (a rise in the socket's connection count, a gap between two
     ticks past RESUME_GAP_MS by Date.now(), which jumps over a sleep, the
     capability turning on, or resume()) beats, then asks claimSummary,
     before any claim, and moves the floor to at least that beat's `now`.
     So do a `more` answer (a burst larger than one answer; a fresh start's
     first answer excepted, whose `more` is part of its baseline), a claim
     answering `limited` or `summarize_first`, and a call that failed,
     which leaves the resume pending and the answer it was handling waiting
     to be handled again. The generic summary shows only on `summary`.
   - Nothing here reads or preloads the Inbox, and no alert, summary or
     click writes a message, an item or a read state. A click opens the
     Inbox (openInbox).

   It holds the session's capability, its tab instance, the floor, the keys
   of the last answer it handled (at most FEED.events), the newest answer
   that arrived while a call ran, the last connection count, the time of
   the last tick and of the next beat, and whether a resume waits: no event
   log. Every call goes through track(), which counts the calls in flight
   for the close guard (notificationCallsInFlight) and sends none while the
   socket is down; a call that comes due then fails, and the reconnect runs
   the resume order.

   Its dependencies are injected so tests drive it (convex/tests/
   notificationFeedClient.test.ts), and it imports only types, the API and
   ALERT_WINDOW_MS, so it also loads in convex-test's runtime.
   t3/limits-notification-delivery puts it under one leader tab a browser
   profile: the beat is one function every path calls (beat), every
   trigger reaches one resume entry (resume), and the feed starts fresh
   or from the floor another tab handed over (start). */

import type { ConvexClient } from 'convex/browser'
import { api } from '../../convex/_generated/api'
import { ALERT_WINDOW_MS } from '../../convex/lib/limits'
import type { Feed, FeedEvent } from '../../convex/model/notificationCatchup'

/** How often the client checks its capability, its beat and the clock. */
export const TICK_MS = 20_000

/** A gap between two checks past which the client takes a resume: past a
    minute, with room for a hidden tab's timers, which run about once a
    minute, so a throttled tab is not taken for one that slept. */
export const RESUME_GAP_MS = 90_000

/** The generic summary's tag, so a newer one replaces an older one. */
export const SUMMARY_TAG = 'qivo:catch-up'

/** The generic summary's words, which hold no count and fit a resume, a
    burst, a capability that turned on and a handoff alike. */
export const SUMMARY_TITLE = 'New unread activity'
export const SUMMARY_BODY = 'Open your Inbox to see what arrived.'

/** What the client needs of the Convex client: its mutation, and whether
    the socket is connected. */
export type FeedConvex = Pick<ConvexClient, 'mutation' | 'connectionState'>

/** The client's dependencies, injected so tests can drive it. */
export type FeedDeps = {
  /** the Convex client itself, whose mutation the client calls by name */
  convex: FeedConvex
  /** subscribes the feed with floor `after`, replacing any earlier watch */
  watch: (after: number) => void
  /** stops the feed's subscription */
  unwatch: () => void
  /** shows a desktop alert (lib/notify.ts desktopNotify) */
  notify: (tag: string, title: string, body: string, onClick: () => void) => void
  /** what a click on an alert runs, the store's way into the Inbox */
  openInbox: () => void
  /** whether this session can show alerts now */
  canNotify: () => boolean
  /** whether this page can notify at all, which gates the tick */
  supported: () => boolean
  /** the local clock, Date.now by default */
  now?: () => number
  /** a tab instance name, crypto.randomUUID by default */
  newInstance?: () => string
}

/** One answer of the feed, or why it failed. */
export type FeedNews = { value: Feed } | { error: unknown }

/* The calls in flight across every client of the page. */
let inFlight = 0

/** How many of the notification calls this page sent have not answered,
    which the close guard leaves out of Convex's count of mutations in
    flight (src/main.tsx), so a beat or a claim never makes closing a tab
    ask about unsaved work. A call refused before it was sent, or that
    threw at once, is never counted. */
export const notificationCallsInFlight = () => inFlight

/* A call the client could not send. */
class CallFailed extends Error {}

/* A tab instance name: crypto.randomUUID where the page is a secure
   context, else one built from crypto.getRandomValues, which works on any
   page. */
function randomInstance(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  const bytes = new Uint8Array(16)
  c.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The words of the alert for event `e`, as the Inbox's alerts have always
    read: who mentioned you or wrote, with the task's title, or a snooze
    return; "Someone" where Qivo cannot name the actor. */
export function alertOf(e: FeedEvent): { title: string; body: string } {
  if (e.kind === 'wake') return { title: `Back from snooze, ${e.title}`, body: e.detail }
  const who = e.actor_name ?? 'Someone'
  return {
    title: e.kind === 'mention' ? `${who} mentioned you, ${e.title}` : `${who}, ${e.title}`,
    body: e.detail,
  }
}

/**
 * Creates the client. It does nothing until start(), and nothing at all
 * on a page that cannot notify. The store hands it every feed answer
 * (receive) and stops it at disposal (stop).
 */
export function createNotificationFeed(deps: FeedDeps) {
  const { convex } = deps
  const now = deps.now ?? (() => Date.now())
  let stopped = false
  let tick: ReturnType<typeof setInterval> | null = null
  let beatTimer: ReturnType<typeof setTimeout> | null = null
  // whether the session can notify, as last checked
  let capable = false
  // whether the next start is this page's first with the capability on,
  // which takes a baseline rather than a summary
  let firstStart = true
  // made once the session first beats, which needs it to notify
  let instance: string | null = null
  // the floor the feed is watched with, null while it is not
  let after: number | null = null
  let watched: number | null = null
  // whether the next answer is a fresh start's baseline
  let baseline = false
  // the keys of the last answer handled
  let lastKeys = new Set<string>()
  // the newest answer not handled yet
  let waiting: Feed | null = null
  let lastConnection = 0
  let lastCheck = now()
  // the local time the next periodic beat is due, null with none
  let beatDue: number | null = null
  let resumePending = false
  let running = false
  // the run in progress, which idle() waits for
  let current: Promise<void> | null = null

  /* Runs call `send` counted in flight, refusing it while the socket is
     down. */
  async function track<R>(send: () => Promise<R>): Promise<R> {
    if (!convex.connectionState().isWebSocketConnected) throw new CallFailed('offline')
    inFlight += 1
    try {
      return await send()
    } finally {
      inFlight -= 1
    }
  }

  /** Beats with whether the session can notify, raises the floor to no
      further back than ALERT_WINDOW_MS before the answer's `now`, and
      schedules the next periodic beat after `every_ms`. Every path that
      beats calls this one function. */
  async function beat(canNotify = capable) {
    if (instance === null) instance = (deps.newInstance ?? randomInstance)()
    const id = instance
    const answer = await track(() =>
      convex.mutation(api.notifications.beat, {
        instance: id,
        can_notify: canNotify,
        active: false,
      }),
    )
    if (canNotify && capable) scheduleBeat(answer.every_ms)
    if (after !== null && after < answer.now - ALERT_WINDOW_MS) {
      after = answer.now - ALERT_WINDOW_MS
      watchFeed()
    }
    return answer
  }

  function scheduleBeat(everyMs: number) {
    if (beatTimer) clearTimeout(beatTimer)
    beatDue = now() + everyMs
    beatTimer = setTimeout(() => {
      beatTimer = null
      void pump()
    }, everyMs)
  }

  /** A beat, then claimSummary, showing the summary only on `summary`,
      then the floor at least that beat's `now`. */
  async function summarize(): Promise<void> {
    const beaten = await beat()
    const answer = await track(() => convex.mutation(api.notifications.claimSummary, {}))
    if (answer.state === 'summary')
      deps.notify(SUMMARY_TAG, SUMMARY_TITLE, SUMMARY_BODY, deps.openInbox)
    if (after !== null && after < beaten.now) {
      after = beaten.now
      watchFeed()
    }
  }

  function watchFeed() {
    if (after === null || after === watched) return
    watched = after
    deps.watch(after)
  }

  /* Shows the granted events of `offered`, in the order the claim answered
     their keys. */
  function show(offered: readonly FeedEvent[], keys: readonly string[]) {
    const byKey = new Map(offered.map((e) => [e.key, e]))
    for (const key of keys) {
      const e = byKey.get(key)
      if (!e) continue
      const { title, body } = alertOf(e)
      deps.notify(e.key, title, body, deps.openInbox)
    }
  }

  /** Claims `events` with `through` by the claim rules: a summary first on
      `summarize_first` and a beat on `not_registered`, each then claiming
      the same events once more, and a summary after `limited`. Nothing
      shows on `not_target`. */
  async function claimEvents(events: FeedEvent[], through: number) {
    const claim = () =>
      track(() =>
        convex.mutation(api.notifications.claimAlerts, {
          events: events.map(({ key, at }) => ({ key, at })),
          through,
        }),
      )
    let answer = await claim()
    if (answer.state === 'summarize_first') {
      await summarize()
      answer = await claim()
    } else if (answer.state === 'not_registered') {
      await beat()
      answer = await claim()
    }
    if (answer.state !== 'granted') return
    show(events, answer.keys)
    if (answer.limited) await summarize()
  }

  /** Handles one feed answer. */
  async function handle(feed: Feed) {
    if (baseline) {
      // a fresh start's first answer, whose events it never offers
      await claimEvents([], feed.through)
      baseline = false
    } else {
      // a burst larger than one answer becomes one summary
      if (feed.more) await summarize()
      const offered = feed.events.filter((e) => !lastKeys.has(e.key)).reverse()
      if (offered.length > 0) await claimEvents(offered, feed.through)
    }
    lastKeys = new Set(feed.events.map((e) => e.key))
    if (after !== null && feed.through > after) {
      after = feed.through
      watchFeed()
    }
  }

  /** Runs what is due, one call at a time: a pending resume first, then a
      periodic beat, then the newest answer. A failed call leaves a resume
      pending and its answer waiting, and the next tick, answer or trigger
      runs them. */
  function pump(): Promise<void> {
    if (running || stopped || !capable) return current ?? Promise.resolve()
    const run = drain().finally(() => {
      if (current === run) current = null
    })
    current = run
    return run
  }

  async function drain(): Promise<void> {
    running = true
    let feed: Feed | null = null
    try {
      while (!stopped && capable) {
        if (resumePending) {
          resumePending = false
          await summarize()
          continue
        }
        if (beatDue !== null && now() >= beatDue) {
          beatDue = null
          await beat()
          continue
        }
        feed = waiting
        if (feed === null) break
        waiting = null
        await handle(feed)
        feed = null
      }
    } catch (e) {
      // nothing moves the floor over what this call left; the next run
      // beats and asks claimSummary before it claims anything
      resumePending = true
      if (feed !== null && waiting === null) waiting = feed
      if (!(e instanceof CallFailed)) console.warn('[qivo] notification call failed:', e)
    } finally {
      running = false
    }
  }

  /** Marks a resume pending, which the next run takes before any claim.
      Several marks run once. Every resume trigger calls it, the desktop
      app's wake included. */
  function resume() {
    if (!capable || stopped) return
    resumePending = true
    void pump()
  }

  /** Starts the feed, beat first: on the page's first start with a
      baseline from its first answer, else, as for a capability that turned
      on, from a summary, which then watches the feed. */
  function begin() {
    const run = start().finally(() => {
      if (current === run) current = null
    })
    current = run
  }

  async function start() {
    running = true
    let began = false
    try {
      const beaten = await beat()
      if (!capable || stopped) return
      began = true
      after = beaten.now - ALERT_WINDOW_MS
      if (firstStart) {
        baseline = true
        watchFeed()
      } else resumePending = true
      firstStart = false
    } catch (e) {
      if (!(e instanceof CallFailed)) console.warn('[qivo] notification call failed:', e)
    } finally {
      running = false
      // a start that failed starts again at the next check
      if (!began && !stopped) capable = false
    }
    if (began) await drain()
  }

  /** Stops the feed and forgets its answer, keys and floor. */
  function forget() {
    if (after !== null || watched !== null) deps.unwatch()
    after = null
    watched = null
    baseline = false
    lastKeys = new Set()
    waiting = null
    resumePending = false
    beatDue = null
    if (beatTimer) clearTimeout(beatTimer)
    beatTimer = null
  }

  /** Reads the capability and the clock: one that turned on starts the
      feed, one that turned off beats once more and stops it, a gap past
      RESUME_GAP_MS marks a resume, and a due beat goes out. */
  function check() {
    if (stopped) return
    const at = now()
    const gap = at - lastCheck
    lastCheck = at
    const can = deps.canNotify()
    if (can && !capable) {
      if (running) return
      capable = true
      begin()
      return
    }
    // a page that starts without the capability turns it on later
    if (!can && !capable) firstStart = false
    if (!can && capable) {
      capable = false
      forget()
      // records the handoff the server needs, best effort
      if (instance !== null) void beat(false).catch(() => undefined)
      return
    }
    if (!capable) return
    if (gap > RESUME_GAP_MS) resume()
    else void pump()
  }

  return {
    /** Starts the client on a page that can notify: checks at once and
        every TICK_MS. */
    start() {
      if (stopped || tick !== null || !deps.supported()) return
      lastCheck = now()
      tick = setInterval(check, TICK_MS)
      check()
    },
    /** Takes a feed answer or failure, with the socket connection count of
        the transition that brought it; a rise in it is a reconnect. */
    receive(news: FeedNews, connection: number) {
      if (stopped || !capable || after === null) return
      const rose = lastConnection > 0 && connection > lastConnection
      lastConnection = Math.max(lastConnection, connection)
      if (rose) resumePending = true
      if ('error' in news) {
        // shows nothing; Convex runs the feed again when what it read changes
        console.warn('[qivo] the Inbox feed failed:', news.error)
      } else waiting = news.value
      void pump()
    },
    /** Reads the capability again, as after a permission request. */
    permissionChanged: check,
    resume,
    /** The floor the feed is watched with, for a new registry to watch it
        again, or null while it is not. */
    floor: (): number | null => watched,
    /** Resolves once no call runs, for tests and drives. */
    async idle(): Promise<void> {
      while (current !== null) await current
    },
    /** What the client holds, for tests: the keys of the last answer and
        whether an answer waits. */
    held: () => ({ keys: lastKeys.size, waiting: waiting !== null }),
    /** Stops the timers and the watch, and sends nothing more. */
    stop() {
      if (stopped) return
      stopped = true
      if (tick) clearInterval(tick)
      tick = null
      forget()
    },
  }
}

export type NotificationFeed = ReturnType<typeof createNotificationFeed>

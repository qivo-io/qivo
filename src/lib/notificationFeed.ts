/* The client of the person's desktop alerts: it reads the Inbox feed
   (convex/inbox.ts feed), asks the server which of its new events this
   session may show (notifications.claimAlerts), and after a gap asks
   whether unread activity arrived meanwhile (notifications.claimSummary).
   The header of convex/notifications.ts holds the rules every client
   follows; this module keeps them, and lib/notificationLeader.ts runs it
   only in the one tab of a browser profile that leads, which owns the
   beat, the capability, the clock's gaps and the session's end:

   - It runs only between lead() and stop(), which the leader calls when it
     gains and loses leadership, or when the capability turns on and off.
     Every beat it needs (the start, a resume, `not_registered`) asks the
     leader's beat, so one instance a page beats, and the leader tells it
     of every other beat's answer (beaten).
   - A fresh start (the page's first leadership, with nothing heard from a
     tab that led before) sets its floor ALERT_WINDOW_MS before the
     leader's first beat's server time, watches the feed and takes its
     first answer as a baseline: a claim with no events and that answer's
     `through`, never offering its events, so signing in or reloading
     replays no stored history. That answer's `more` is part of the
     baseline too. Its keys are never offered later, since the baseline
     recorded none of them and one may come back into the feed, as when
     the person reads it and marks it unread again. They belong to the
     session, not to one lead, so a stop and the resume that follows (a
     capability that turns off and on, a freeze) keep them, and only the
     next baseline or a new client, as after a sign-out, drops them.
   - A takeover starts from the floor, the keys and the baseline's keys the
     tab that led before posted, as if it went on from there. It offers
     what its first answer holds beyond those keys, and takes no baseline.
   - Each later answer offers the events whose keys the last handled
     answer did not hold, oldest first, in one claim with the answer's
     `through`, never a clock, and shows each granted one. The floor then
     moves to `through`, and on each beat answer it is raised to no
     further back than ALERT_WINDOW_MS before the beat's `now`, so it stays
     the later of ten minutes ago and the last `through`. The leader's
     tick raises it the same way from the server's time it estimates (the
     last beat's `now` plus the local time since) once it lags FLOOR_SLACK_MS
     more, so the bound also holds under All enabled sessions, whose leader
     beats every six hours, and a quiet tab watches the feed again at most
     once a minute. That raise is a floor, never a claim's `through`.
   - A resume (a rise in the socket's connection count, resume(), which the
     leader calls for a gap between its ticks past RESUME_GAP_MS, the
     desktop app's wake and a start after a freeze, and a lead() that is
     no fresh start or takeover) beats, then asks claimSummary, before any
     claim, and moves the floor to at least that beat's `now`. So do a
     `more` answer (a burst larger than one answer), a claim answering
     `limited` or `summarize_first`, and a call that failed, which leaves
     the resume pending and the answer it was handling waiting to be
     handled again. Triggers that come while one waits or runs, or within
     RESUME_QUIET_MS after it answered, run nothing more. The generic
     summary shows only on `summary`.
   - Nothing here reads or preloads the Inbox, and no alert, summary or
     click writes a message, an item or a read state. A click opens the
     Inbox (openInbox).

   It holds the floor, the keys of the last answer it handled and of its
   baseline (at most FEED.events each), the newest answer that arrived
   while a call ran, the last
   connection count and whether a resume waits: no event log. Each time
   the floor or the keys move after a fresh start's baseline it tells the
   leader (moved), which posts them for a tab that may take over; before
   it, nothing, so a tab that takes over then takes the baseline itself
   rather than offering stored history. Every call goes through
   trackNotificationCall(), which counts the calls in flight for the close
   guard (notificationCallsInFlight) and sends none while the socket is
   down; a call that comes due then fails, and the reconnect runs the
   resume order.

   Its dependencies are injected so tests drive it (convex/tests/
   notificationFeedClient.test.ts), and it imports only types, the API and
   ALERT_WINDOW_MS, so it also loads in convex-test's runtime and in the
   benchmark's worker. */

import type { ConvexClient } from 'convex/browser'
import type { FunctionReturnType } from 'convex/server'
import { api } from '../../convex/_generated/api'
import { ALERT_WINDOW_MS } from '../../convex/lib/limits'
import type { Feed, FeedEvent } from '../../convex/model/notificationCatchup'

/** A gap between two of the leader's checks past which it takes a resume:
    past a minute, with room for a hidden tab's timers, which run about once
    a minute, so a throttled tab is not taken for one that slept. A takeover
    whose last heard beat is older runs the resume order too. */
export const RESUME_GAP_MS = 90_000

/** How long after a resume answered another trigger runs nothing, so the
    desktop app's wake, the reconnect and the timer gap that follow one
    sleep run the resume order once. */
export const RESUME_QUIET_MS = 5_000

/** How far past ALERT_WINDOW_MS the floor may lag the estimated server
    time before the leader's tick raises it: a minute, a leader's beat in
    Most recently active session, so a quiet tab of either mode watches
    the feed again at most once a minute. */
export const FLOOR_SLACK_MS = 60_000

/** The generic summary's tag, so a newer one replaces an older one. */
export const SUMMARY_TAG = 'qivo:catch-up'

/** The generic summary's words, which hold no count and fit a resume, a
    burst, a capability that turned on and a handoff alike. */
export const SUMMARY_TITLE = 'New unread activity'
export const SUMMARY_BODY = 'Open your Inbox to see what arrived.'

/** What the client needs of the Convex client: its mutation, and whether
    the socket is connected. */
export type FeedConvex = Pick<ConvexClient, 'mutation' | 'connectionState'>

/** What notifications.beat answers. */
export type Beat = FunctionReturnType<typeof api.notifications.beat>

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
}

/** How the feed starts: fresh, with a baseline; as a takeover from the
    state the tab that led before posted; or with the resume order. */
export type FeedStart = { kind: 'fresh' } | ({ kind: 'takeover' } & FeedState) | { kind: 'resume' }

/** What the leader lends the feed while it leads: its beat, which every
    beat the feed needs goes through, and where the feed's floor and keys
    go each time they move. */
export type FeedLink = {
  beat: () => Promise<Beat>
  moved: (state: FeedState) => void
}

/** The floor the feed is watched with, the keys of the last answer it
    handled and the keys of its fresh start's baseline, which a takeover
    starts from. The feed tells them only once a fresh start's baseline is
    taken. */
export type FeedState = { after: number; keys: readonly string[]; baselined: readonly string[] }

/** One answer of the feed, or why it failed. */
export type FeedNews = { value: Feed } | { error: unknown }

/* The calls in flight across every client of the page. */
let inFlight = 0

/** How many of the notification calls this page sent have not answered,
    which the close guard leaves out of Convex's count of mutations in
    flight (src/main.tsx), so a beat, a claim or an end never makes closing
    a tab ask about unsaved work. A call refused before it was sent, or that
    threw at once, is never counted. */
export const notificationCallsInFlight = () => inFlight

/** How many of `inflight`, the Convex client's mutations in flight, are
    not this page's notification calls, which the close guard asks about
    (src/main.tsx). */
export const othersInFlight = (inflight: number) => Math.max(0, inflight - inFlight)

/** A notification call that was not sent because the socket was down. */
export class CallOffline extends Error {}

/**
 * Runs the notification call `send` over `convex`, counted in flight for
 * the close guard, and refuses it with CallOffline while the socket is
 * down, so no call waits in the Convex client's queue. The feed's claims
 * and summaries and the leader's beats and end all go through it.
 */
export async function trackNotificationCall<R>(
  convex: Pick<FeedConvex, 'connectionState'>,
  send: () => Promise<R>,
): Promise<R> {
  if (!convex.connectionState().isWebSocketConnected) throw new CallOffline('offline')
  inFlight += 1
  try {
    return await send()
  } finally {
    inFlight -= 1
  }
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
 * Creates the client. It does nothing until lead(), which the leader calls
 * with a beat it just sent. The store hands it every feed answer (receive).
 */
export function createNotificationFeed(deps: FeedDeps) {
  const { convex } = deps
  // what the leader lends while it leads, null while it does not
  let link: FeedLink | null = null
  // which leadership a run belongs to, so one that outlives stop() changes
  // nothing
  let epoch = 0
  // the floor the feed is watched with, null while it is not
  let after: number | null = null
  let watched: number | null = null
  // whether the next answer is a fresh start's baseline
  let baseline = false
  // the keys of the last answer handled
  let lastKeys = new Set<string>()
  // the keys of the fresh start's baseline, which it never offers, since
  // the baseline recorded none of them and one may come back into the feed;
  // kept across stop() and a resume, replaced by a takeover's and by the
  // next baseline
  let baselined = new Set<string>()
  // the newest answer not handled yet
  let waiting: Feed | null = null
  let lastConnection = 0
  let resumePending = false
  // a beat the leader just sent, which the next summary takes instead of
  // beating again
  let freshBeat: Beat | null = null
  // the local time the last resume answered, and whether one runs now
  let resumedAt = -Infinity
  let resuming = false
  let running = false
  // the run in progress, which idle() waits for
  let current: Promise<void> | null = null
  // the server time of the last beat answer heard and the local time it
  // came, from which the tick estimates the server's time
  let heard: { now: number; local: number } | null = null

  /* Sends `send` for a run of leadership `mine`, refused with CallOffline
     once that run ended, so a run that outlives stop() records no key and
     moves no checkpoint. */
  const sendAs = <R>(mine: number, send: () => Promise<R>) => {
    if (!link || mine !== epoch) return Promise.reject(new CallOffline('not leading'))
    return trackNotificationCall(convex, send)
  }

  /* Tells the leader where the floor and the keys stand, and nothing
     while a fresh start's baseline waits, so a tab that takes over then
     takes the baseline itself. */
  function moved() {
    if (link && watched !== null && !baseline)
      link.moved({ after: watched, keys: [...lastKeys], baselined: [...baselined] })
  }

  function watchFeed() {
    if (after === null || after === watched) return
    watched = after
    deps.watch(after)
    moved()
  }

  /* Raises the floor to no further back than ALERT_WINDOW_MS before the
     server time `now`. */
  function lift(now: number) {
    if (after !== null && after < now - ALERT_WINDOW_MS) {
      after = now - ALERT_WINDOW_MS
      watchFeed()
    }
  }

  /* Takes beat answer `beat`: its time is the tick's estimate from now on,
     and the floor rises to ten minutes before it. */
  function raise(beat: Beat) {
    heard = { now: beat.now, local: Date.now() }
    lift(beat.now)
  }

  /* The leader's beat, for a run of leadership `mine`, which a stop
     during the beat ends. */
  async function beat(mine: number): Promise<Beat> {
    if (!link || mine !== epoch) throw new CallOffline('not leading')
    const answer = await link.beat()
    if (mine !== epoch) throw new CallOffline('not leading')
    raise(answer)
    return answer
  }

  /** A beat, then claimSummary, showing the summary only on `summary`,
      then the floor at least that beat's `now`. */
  async function summarize(mine: number): Promise<void> {
    // the beat the leader just sent belongs to its own leadership
    let beaten: Beat
    if (freshBeat !== null && mine === epoch) {
      beaten = freshBeat
      freshBeat = null
    } else beaten = await beat(mine)
    const answer = await sendAs(mine, () => convex.mutation(api.notifications.claimSummary, {}))
    if (mine !== epoch) return
    if (answer.state === 'summary')
      deps.notify(SUMMARY_TAG, SUMMARY_TITLE, SUMMARY_BODY, deps.openInbox)
    if (after === null || after < beaten.now) {
      after = beaten.now
      watchFeed()
    }
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
  async function claimEvents(mine: number, events: FeedEvent[], through: number) {
    const claim = () =>
      sendAs(mine, () =>
        convex.mutation(api.notifications.claimAlerts, {
          events: events.map(({ key, at }) => ({ key, at })),
          through,
        }),
      )
    let answer = await claim()
    if (answer.state === 'summarize_first') {
      await summarize(mine)
      answer = await claim()
    } else if (answer.state === 'not_registered') {
      await beat(mine)
      answer = await claim()
    }
    if (mine !== epoch || answer.state !== 'granted') return
    show(events, answer.keys)
    if (answer.limited) await summarize(mine)
  }

  /** Handles one feed answer. */
  async function handle(mine: number, feed: Feed) {
    if (baseline) {
      // a fresh start's first answer, whose events it never offers
      await claimEvents(mine, [], feed.through)
      if (mine === epoch) {
        baseline = false
        baselined = new Set(feed.events.map((e) => e.key))
      }
    } else {
      // a burst larger than one answer becomes one summary
      if (feed.more) await summarize(mine)
      const offered = feed.events
        .filter((e) => !lastKeys.has(e.key) && !baselined.has(e.key))
        .reverse()
      if (offered.length > 0) await claimEvents(mine, offered, feed.through)
    }
    if (mine !== epoch) return
    lastKeys = new Set(feed.events.map((e) => e.key))
    if (after !== null && feed.through > after) {
      after = feed.through
      watchFeed()
    } else moved()
  }

  /** Runs what is due, one call at a time: a pending resume first, then the
      newest answer. A failed call leaves a resume pending and its answer
      waiting, and the next answer, trigger or tick runs them. A run left
      over from an earlier leadership makes this one's work wait only until
      it ends. */
  function pump(): Promise<void> {
    if (running || !link) return current ?? Promise.resolve()
    const mine = epoch
    const run = drain(mine).finally(() => {
      if (current === run) current = null
      if (mine !== epoch && link && (resumePending || waiting !== null)) void pump()
    })
    current = run
    return run
  }

  async function drain(mine: number): Promise<void> {
    running = true
    let feed: Feed | null = null
    try {
      while (mine === epoch) {
        if (resumePending) {
          resumePending = false
          resuming = true
          try {
            await summarize(mine)
          } finally {
            resuming = false
          }
          // the quiet time after a resume is its own leadership's
          if (mine === epoch) resumedAt = Date.now()
          continue
        }
        feed = waiting
        if (feed === null) break
        waiting = null
        await handle(mine, feed)
        feed = null
      }
    } catch (e) {
      // nothing moves the floor over what this call left; the next run
      // beats and asks claimSummary before it claims anything
      if (mine === epoch) {
        resumePending = true
        if (feed !== null && waiting === null) waiting = feed
      }
      if (!(e instanceof CallOffline)) console.warn('[qivo] notification call failed:', e)
    } finally {
      running = false
    }
  }

  /** Marks a resume pending, which the next run takes before any claim.
      Marks while one waits or runs, or within RESUME_QUIET_MS after one
      answered, run nothing more. */
  function resume() {
    if (!link || resuming) return
    if (Date.now() - resumedAt < RESUME_QUIET_MS) return
    resumePending = true
    void pump()
  }

  /** Forgets the floor, the answer and its keys, and stops the watch. It
      keeps the baseline's keys, which a resume of the session still
      needs. */
  function forget() {
    if (after !== null || watched !== null) deps.unwatch()
    after = null
    watched = null
    baseline = false
    lastKeys = new Set()
    waiting = null
    resumePending = false
    freshBeat = null
    heard = null
  }

  return {
    /**
     * Starts the feed for a leader that just beat (`first`, its answer),
     * which lends it `l` until stop(): fresh with a baseline from its first
     * answer, as a takeover from the floor and keys another tab posted, or
     * with the resume order, which asks claimSummary before it watches.
     */
    lead(start: FeedStart, l: FeedLink, first: Beat) {
      forget()
      epoch += 1
      link = l
      heard = { now: first.now, local: Date.now() }
      if (start.kind === 'resume') {
        // the summary takes this beat and watches from its `now`
        freshBeat = first
        resumePending = true
        resumedAt = -Infinity
        void pump()
        return
      }
      if (start.kind === 'fresh') {
        after = first.now - ALERT_WINDOW_MS
        baseline = true
      } else {
        after = Math.max(start.after, first.now - ALERT_WINDOW_MS)
        lastKeys = new Set(start.keys)
        baselined = new Set(start.baselined)
      }
      watchFeed()
    },
    /** Takes the answer of a beat the leader sent on its own, which raises
        the floor. */
    beaten(answer: Beat) {
      if (link) raise(answer)
    },
    /** Takes a feed answer or failure, with the socket connection count of
        the transition that brought it; a rise in it is a reconnect. */
    receive(news: FeedNews, connection: number) {
      if (!link || after === null) return
      const rose = lastConnection > 0 && connection > lastConnection
      lastConnection = Math.max(lastConnection, connection)
      if (rose) resume()
      if ('error' in news) {
        // shows nothing; Convex runs the feed again when what it read changes
        console.warn('[qivo] the Inbox feed failed:', news.error)
      } else waiting = news.value
      void pump()
    },
    resume,
    /** At the leader's tick: raises the floor from the estimated server
        time once it lags FLOOR_SLACK_MS past ALERT_WINDOW_MS, and runs
        what a failed call left, a resume and the answer it was handling. */
    tick() {
      if (link && heard !== null) {
        const now = heard.now + Math.max(0, Date.now() - heard.local)
        if (after !== null && after < now - ALERT_WINDOW_MS - FLOOR_SLACK_MS) lift(now)
      }
      if (resumePending || waiting !== null) void pump()
    },
    /** The floor the feed is watched with, for a new registry to watch it
        again, or null while it is not. */
    floor: (): number | null => watched,
    /** Resolves once no call runs, for tests and drives. */
    async idle(): Promise<void> {
      while (current !== null) await current
    },
    /** What the client holds, for tests: the keys of the last answer and
        of the baseline, and whether an answer waits. */
    held: () => ({ keys: lastKeys.size, baselined: baselined.size, waiting: waiting !== null }),
    /** Stops leading: forgets the floor, the answer and its keys, but not
        the baseline's, stops the watch, and lets no run in progress show
        or move anything. */
    stop() {
      if (!link) return
      link = null
      epoch += 1
      forget()
    },
  }
}

export type NotificationFeed = ReturnType<typeof createNotificationFeed>

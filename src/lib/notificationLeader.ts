/* One tab of each browser profile leads its desktop alerts.

   Every tab of a browser profile shares the app's Better Auth session, so
   they share one notification session row on the server
   (convex/notifications.ts), which keeps the `instance` that beat last. So
   one tab a profile beats, runs the Inbox feed and its claims
   (lib/notificationFeed.ts), watches the delivery mode and shows alerts,
   and the other tabs keep only the unread count from inbox.summary. A
   profile with ten tabs calls the server as one with one tab.

   - Election. The tabs of one profile, one deployment and one sign-in
     namespace share a Web Lock and a BroadcastChannel by one name
     (leaderName). At start a tab asks for the lock if it is free; holding
     it, it leads. Else it follows: it says `hello` on the channel and
     queues for the lock, and takes over when the browser grants it, which
     happens at once when the leader's tab closes or crashes. Without Web
     Locks or a channel (a page outside a secure context) or when asking
     throws, the tab leads alone; the server's records keep two such tabs
     from alerting one event. One election runs at a time, so a page back
     from the cache, which hears pageshow and the document's resume, asks
     once.
   - Leaving. A leader lets go of the lock on `pagehide` (also into the back
     and forward cache) and on the document's `freeze`, and asks again on
     `pageshow` from the cache and on the document's `resume`. A follower
     drops its queued request then too, so a frozen page never holds the
     next turn. A leave and a stop let go of a held lock whatever the
     tab's role says.
   - The beat. Only while this page can notify (lib/notify.ts canNotify),
     at the server's pace (`every_ms`, clamped to NOTIFY_CLIENT's range):
     at once on gaining leadership, when the capability or the watched
     mode changes and for the feed's beats (`not_registered` and the start
     of a resume), and on a report of use. Each beat restarts the timer. A
     capability that turns off sends one more beat with `can_notify:
     false`, which records the handoff the server needs, and stops the
     feed, the watch and the timers. A leader that cannot notify calls
     nothing. A beat while the socket is down is not sent; the reconnect
     runs the feed's resume order, a beat first. A failed beat tries again
     after NOTIFY_CLIENT.retry_ms in turn, and so does a beat refused for
     a missing sign-in, which the Convex client sends while it arms the
     socket again after it dropped the sign-in (lib/authSession.ts
     recover). A refusal of the session (it ended, the login was banned, a
     demo that is not active) stops the leader and lets go of the lock, so
     another tab, such as one loaded after a new sign-in, may lead; it
     stays stopped until the store starts a new one (refused). A bad
     request does the same and is a defect it reports.
   - Use. The first trusted pointer, key, touch or wheel input
     (lib/inputIdle.ts INPUTS, which the store passes) in a visible page of the profile, a pointer
     move only when it moved, NOTIFY_CLIENT.report_ms or more after the
     last report, beats at once with `active: true` while the mode is
     Most recently active session. A follower tells the leader that input
     happened, at most every forward_ms, never what it was. `active` is
     true only for input within report_ms, never older, and never in All
     enabled sessions, where nothing reads it until a switch back, whose
     beat carries it. The first beat after gaining leadership or after the
     capability turned on counts as no report, since the server ignores
     `active` on a session's first beat.
   - The feed. A leader that can notify starts the feed after its first
     beat: fresh, with a baseline, on the page's first leadership with
     nothing heard; as a takeover from the floor, the keys and the
     baseline's keys the leader before posted (`state`, sent each time they move and after each beat, once a
     fresh start took its baseline) when
     that tab's last beat is under RESUME_GAP_MS old; else with the resume
     order, as after a freeze, the back and forward cache, a capability
     that turned on and a stale handover. A handover is taken once, and
     one heard before this page left (pagehide or freeze) is dropped, so a
     later start runs the resume order unless the page hears a newer one. A gap between its ticks past
     RESUME_GAP_MS and the desktop app's wake go to the feed's resume(),
     and every other tick to the feed's tick(), which keeps its floor
     about eleven minutes back at most between beats hours apart.
   - The mode. The leader watches notifications.settings through
     `watchSettings`, the live transport outside the visibility gate, so a
     change reaches a session that beats every six hours, also hidden.
   - End. The leader keeps whether another tab waits for its lock
     (locks.query), refreshed when it gains leadership, on each `hello` and
     `bye` and after each beat. On `pagehide` and `freeze`, a leader that
     beat since it gained leadership and sees no other tab waiting sends
     `end` with its instance, best effort over the open socket, which the
     server takes as the session no longer live. A stop (the store's reset
     and a sign-out) sends none.

   Every call goes through the feed module's trackNotificationCall, which
   the close guard leaves out of its count (src/main.tsx). The channel
   carries no input and no server answer, and a message of an unknown kind
   or a time that is not finite is dropped. The drive's mirror
   (window.__qivoNotify) holds counts and the role, no answer.

   Its dependencies are injected so tests drive it with doubles
   (lib/notificationLeader.test.ts, convex/tests/
   notificationFeedClient.test.ts); it never imports the store. */

import { ConvexError } from 'convex/values'
import { api } from '../../convex/_generated/api'
import {
  type Beat,
  CallOffline,
  type FeedConvex,
  type FeedLink,
  type FeedStart,
  type FeedState,
  type NotificationFeed,
  RESUME_GAP_MS,
  trackNotificationCall,
} from './notificationFeed'

/** The leader's bounds, which tests lower and restore. */
export const NOTIFY_CLIENT = {
  /** one report of use a minute at most: the first input this long or more
      after the last report beats with `active: true` */
  report_ms: 60_000,
  /** a follower tells the leader of input at most this often, the server's
      NOTIFY.active_ms, below which it writes no newer use */
  forward_ms: 15_000,
  /** the waits after a failed beat, in turn, each at most `every_ms`; the
      last is under the server's live_ms (180 s), so a retry lands before
      the session lapses */
  retry_ms: [5_000, 30_000, 120_000],
  /** the server's `every_ms` is clamped to this range, so a bad answer
      cannot make a tight loop or stop the beat */
  every_min_ms: 15_000,
  every_max_ms: 86_400_000,
  /** how often the leader reads its capability and the clock, whose gap
      past RESUME_GAP_MS is a resume */
  tick_ms: 20_000,
}

/** The delivery mode, as notifications.settings answers it. */
export type Delivery = 'recent' | 'all'

/** What a tab is to its profile's alerts. */
export type LeaderRole = 'leader' | 'follower' | 'alone' | 'stopped'

/** The drive's mirror, window.__qivoNotify: counts and the role, no answer. */
export type NotifyMirror = {
  role: LeaderRole
  instance: string | null
  can_notify: boolean
  every_ms: number | null
  beats: number
  ends: number
}

/** What the leader needs of the Web Locks API (navigator.locks). */
export type LeaderLocks = {
  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: { name: string } | null) => unknown,
  ): Promise<unknown>
  query(): Promise<{ held?: { name?: string }[]; pending?: { name?: string }[] }>
}

/** What the leader needs of a BroadcastChannel. */
export type LeaderChannel = {
  postMessage(message: unknown): void
  close(): void
  onmessage: ((event: MessageEvent) => void) | null
}

/** How the leader listens for input: early and without blocking. */
type ListenOptions = { capture?: boolean; passive?: boolean }

/** An event target the leader listens on: the window or the document. */
export type LeaderTarget = {
  addEventListener(type: string, listener: (event: Event) => void, options?: ListenOptions): void
  removeEventListener(type: string, listener: (event: Event) => void, options?: ListenOptions): void
}

/* The fields the leader reads of an input or a page transition, which the
   DOM's PointerEvent and PageTransitionEvent carry. */
type PageEvent = Event & { movementX?: number; movementY?: number; persisted?: boolean }

declare global {
  interface Window {
    /** the drive's mirror of this tab's part in its profile's alerts */
    __qivoNotify?: NotifyMirror
  }
}

/** The leader's dependencies, injected so tests drive it with doubles. */
export type LeaderDeps = {
  /** the Convex client itself, whose mutation the leader calls by name */
  convex: FeedConvex
  /** the feed it runs while it leads */
  feed: Pick<NotificationFeed, 'lead' | 'stop' | 'resume' | 'beaten' | 'tick'>
  /** whether this page can show alerts now (lib/notify.ts canNotify) */
  canNotify: () => boolean
  /** calls its listener when canNotify() changed (lib/notify.ts) */
  watchCapability: (listener: (can: boolean) => void) => () => void
  /** watches notifications.settings outside the visibility gate, handing
      each answer's mode, or null for a failure */
  watchSettings: (take: (delivery: Delivery | null) => void) => () => void
  /** the lock's and the channel's name (leaderName) */
  name: string
  /** navigator.locks, absent outside a secure context */
  locks?: LeaderLocks | null
  /** opens the profile's channel by name */
  openChannel?: ((name: string) => LeaderChannel) | null
  /** the window, which carries the inputs, pagehide and pageshow */
  win?: LeaderTarget | null
  /** the input events that count as use (lib/inputIdle.ts INPUTS) */
  inputs?: readonly string[]
  /** the document, which carries freeze and resume, and whether it shows */
  doc?: (LeaderTarget & { readonly visibilityState: string }) | null
  /** the desktop app's wake from sleep (window.qivoDesktop.power) */
  power?: { onResume(listener: () => void): () => void } | null
  /** a tab instance name, crypto.randomUUID where it exists */
  newInstance?: () => string
  /** hears the drive's mirror after each change */
  mirror?: (state: NotifyMirror) => void
}

/** The lock's and the channel's name for one deployment and one sign-in
    namespace, so a tab of another backend or of the demo does not join. */
export const leaderName = (deployment: string, authPrefix: string) =>
  `qivo-notifications:${deployment}:${authPrefix}`

/* What the leader posts after the feed's floor moves and after each beat,
   for a tab that may take over. */
type Handover = FeedState & { beat_at: number }

/* A message on the profile's channel. */
type Message =
  | { kind: 'hello' }
  | { kind: 'bye' }
  | { kind: 'input' }
  | { kind: 'capability' }
  | ({ kind: 'state' } & Handover)

/* The most keys a handover carries in each list: one feed answer's, and
   one more. */
const HANDOVER_KEYS = 51

/* Whether `value` is a list of keys a handover may carry. */
const keysOf = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= HANDOVER_KEYS &&
  value.every((k) => typeof k === 'string' && k.length <= 200)

/* A message read off the channel, or null for one the leader drops: an
   unknown kind, a time that is not finite or a key that is no short
   string, as after a deploy two builds share the channel. A state from a
   build before the baseline's keys carries none. */
function messageOf(data: unknown): Message | null {
  if (typeof data !== 'object' || data === null) return null
  const m = data as Record<string, unknown>
  switch (m.kind) {
    case 'hello':
    case 'bye':
    case 'input':
    case 'capability':
      return { kind: m.kind }
    case 'state': {
      const { after, beat_at, keys, baselined = [] } = m
      if (typeof after !== 'number' || !Number.isFinite(after) || after < 0) return null
      if (typeof beat_at !== 'number' || !Number.isFinite(beat_at) || beat_at < 0) return null
      if (!keysOf(keys) || !keysOf(baselined)) return null
      return { kind: 'state', after, beat_at, keys, baselined }
    }
    default:
      return null
  }
}

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

/* How the server refused the session, if it did: 'stop' for a session
   that ended or a ban (Better Auth's 'Unauthenticated'), another login's
   session row and a demo that is not active, 'defect' for a bad request,
   else null for a failure worth trying again. A call without a sign-in
   (convex/lib/functions.ts loadSession's forbidden 'not signed in') is one
   to try again: the Convex client sends calls without one while it arms
   the socket again, and the beat goes on once it is armed. */
function refusalOf(e: unknown): 'stop' | 'defect' | null {
  if (!(e instanceof ConvexError)) return null
  const data: unknown = e.data
  if (data === 'Unauthenticated') return 'stop'
  if (typeof data === 'object' && data !== null) {
    const { code, message } = data as { code?: unknown; message?: unknown }
    if (code === 'forbidden') return message === 'not signed in' ? null : 'stop'
    if (code === 'bad_request') return 'defect'
  }
  return null
}

/* A beat's wait between two clamps. */
const clamp = (ms: number) =>
  Math.min(
    NOTIFY_CLIENT.every_max_ms,
    Math.max(NOTIFY_CLIENT.every_min_ms, Number.isFinite(ms) ? ms : NOTIFY_CLIENT.every_max_ms),
  )

/**
 * Starts this tab's part in its profile's alerts: it leads, follows, or
 * leads alone. Answers the stop, which the store calls at its reset and at
 * a sign-out, and which sends no `end`, and whether the server refused the
 * session (refused), after which the store starts a new leader at its
 * next boot.
 */
export function startNotificationLeader(deps: LeaderDeps) {
  const { convex, feed, name } = deps
  const locks = deps.locks ?? null
  const win = deps.win && typeof deps.win.addEventListener === 'function' ? deps.win : null
  const doc = deps.doc && typeof deps.doc.addEventListener === 'function' ? deps.doc : null

  let role: LeaderRole = 'stopped'
  let stopped = false
  // set by a refusal of the session, which stops this leader for good
  let refused = false
  let channel: LeaderChannel | null = null
  // the lock this tab holds, resolved to let it go
  let release: (() => void) | null = null
  // the queued request of a follower
  let queued: AbortController | null = null
  // whether this tab leads, so a callback from a request let go is ignored
  let leadership = 0
  // whether an election waits for the lock's answer, so a second trigger
  // asks nothing, and its number, so the callback of an election that a
  // leave, a stop or a later election replaced changes nothing
  let electing = false
  let election = 0

  let instance: string | null = null
  let capable = false
  let mode: Delivery | null = null
  let every: number | null = null
  let beats = 0
  let ends = 0
  let beatTimer: ReturnType<typeof setTimeout> | null = null
  let retry = 0
  let inFlight = false
  // the local time the in-flight beat went out
  let sentAt = 0
  // whether a report of use waits for the beat in flight to answer
  let inputWaits = false
  // the server time of the last beat that answered
  let lastBeatAt: number | null = null
  // whether the next beat counts as no report (the first after gaining
  // leadership or after the capability turned on)
  let noReport = true
  let beatenSinceGain = false
  // a beat that came due while the socket was down
  let socketWait = false
  let feedStarted = false
  // whether this page has not started a feed yet, has heard no handover
  // and led with the capability on from its first leadership, so its
  // first start is fresh
  let freshLeft = true
  // the newest handover heard since this page last left or started a
  // feed, and the feed's own state while it leads
  let heard: Handover | null = null
  let ownState: FeedState | null = null
  let othersWaiting = false

  let inputAt: number | null = null
  let reportedAt: number | null = null
  let forwardedAt = -Infinity

  let tick: ReturnType<typeof setInterval> | null = null
  let lastTick = 0
  let stopSettings: (() => void) | null = null
  let stopPower: (() => void) | null = null
  const stops: (() => void)[] = []

  const leading = () => role === 'leader' || role === 'alone'

  function mirror() {
    deps.mirror?.({ role, instance, can_notify: capable, every_ms: every, beats, ends })
  }

  function post(message: Message) {
    try {
      channel?.postMessage(message)
    } catch {
      /* a closed channel */
    }
  }

  function postState() {
    if (!leading() || ownState === null || lastBeatAt === null) return
    const { after, keys, baselined } = ownState
    post({ kind: 'state', after, keys, baselined, beat_at: lastBeatAt })
  }

  /* Reads whether another tab waits for the lock. */
  function refreshOthers() {
    if (!locks || role !== 'leader') return
    void locks
      .query()
      .then(({ pending = [] }) => {
        othersWaiting = pending.some((lock) => lock.name === name)
      })
      .catch(() => {
        othersWaiting = false
      })
  }

  function clearBeat() {
    if (beatTimer) clearTimeout(beatTimer)
    beatTimer = null
  }

  function schedule(ms: number) {
    clearBeat()
    beatTimer = setTimeout(() => {
      beatTimer = null
      void beat().catch(() => undefined)
    }, ms)
  }

  /* Stops this leader for good after the server refused the session, and
     lets go of the lock, so another tab of the profile may lead: one
     loaded after a new sign-in leads, and one of the same ended session is
     refused once in turn. */
  function refuse(kind: 'stop' | 'defect', e: unknown) {
    refused = true
    if (kind === 'defect') console.error('[qivo] the notification beat was refused:', e)
    else console.warn('[qivo] the notification session ended:', e)
    stopLeading()
    role = 'stopped'
    mirror()
  }

  /** Beats with whether the page can notify and whether it reports use,
      restarting the timer. Every beat goes through here, the feed's
      included (its FeedLink). */
  async function beat(): Promise<Beat> {
    if (refused || stopped || !leading()) throw new CallOffline('not leading')
    instance ??= (deps.newInstance ?? randomInstance)()
    const id = instance
    const mine = leadership
    const can = deps.canNotify()
    const at = Date.now()
    const active =
      can &&
      mode !== 'all' &&
      inputAt !== null &&
      at - inputAt < NOTIFY_CLIENT.report_ms &&
      (reportedAt === null || at - reportedAt >= NOTIFY_CLIENT.report_ms)
    const counts = active && !noReport
    clearBeat()
    inFlight = true
    sentAt = at
    let answer: Beat
    try {
      answer = await trackNotificationCall(convex, () =>
        convex.mutation(api.notifications.beat, { instance: id, can_notify: can, active }),
      )
    } catch (e) {
      inFlight = false
      if (mine !== leadership || stopped) throw e
      if (e instanceof CallOffline) socketWait = true
      else {
        const refusal = refusalOf(e)
        if (refusal) refuse(refusal, e)
        else if (can && capable) {
          // the retries in turn, then the server's pace, or the last retry's
          // wait before the server named one
          const last = NOTIFY_CLIENT.retry_ms[NOTIFY_CLIENT.retry_ms.length - 1] ?? 60_000
          const wait = NOTIFY_CLIENT.retry_ms[retry] ?? every ?? last
          retry += 1
          schedule(Math.min(wait, every ?? wait))
        }
      }
      throw e
    }
    inFlight = false
    if (mine !== leadership || stopped) return answer
    retry = 0
    socketWait = false
    beats += 1
    beatenSinceGain = true
    noReport = false
    lastBeatAt = answer.now
    if (counts) reportedAt = at
    every = clamp(answer.every_ms)
    if (can && capable) schedule(every)
    refreshOthers()
    if (capable) {
      feed.beaten(answer)
      if (!feedStarted && can) startFeed(answer)
    }
    postState()
    mirror()
    // use that came while it was in flight reports at once
    if (inputWaits) {
      inputWaits = false
      if (inputAt !== null && inputAt >= sentAt) took()
    }
    return answer
  }

  const link: FeedLink = {
    beat,
    moved: (state) => {
      ownState = state
      postState()
    },
  }

  /* How the feed starts after the beat `first`. */
  function startOf(first: Beat): FeedStart {
    const h = heard
    if (
      h &&
      h.beat_at <= first.now &&
      h.after <= first.now &&
      first.now - h.beat_at <= RESUME_GAP_MS
    )
      return { kind: 'takeover', after: h.after, keys: h.keys, baselined: h.baselined }
    if (freshLeft && h === null) return { kind: 'fresh' }
    return { kind: 'resume' }
  }

  function startFeed(first: Beat) {
    feedStarted = true
    const start = startOf(first)
    freshLeft = false
    // taken once: a later start, such as after the capability turned on
    // again, runs the resume order unless a newer handover comes
    heard = null
    feed.lead(start, link, first)
  }

  /* Starts the settings watch, the power watch and the first beat for a
     leader that can notify. */
  function begin() {
    noReport = true
    stopSettings ??= deps.watchSettings((delivery) => {
      if (delivery === null || !leading()) return
      const was = mode
      mode = delivery
      if (was !== null && was !== delivery && capable) void beat().catch(() => undefined)
    })
    void beat().catch(() => undefined)
  }

  /* Stops what a leader that can notify runs: the feed, the watch and the
     timers. */
  function halt() {
    clearBeat()
    retry = 0
    socketWait = false
    if (feedStarted) feed.stop()
    feedStarted = false
    ownState = null
    stopSettings?.()
    stopSettings = null
    mode = null
  }

  /* Reads the capability: on, it starts beating and the feed; off, it
     sends one beat with `can_notify: false` and halts. */
  function check() {
    if (!leading() || refused || stopped) return
    const can = deps.canNotify()
    if (can === capable) return
    capable = can
    mirror()
    if (can) {
      begin()
      return
    }
    halt()
    // records the handoff the server needs, best effort; it schedules no
    // next beat, since the page cannot notify
    if (instance !== null) void beat().catch(() => undefined)
  }

  function onTick() {
    const at = Date.now()
    const gap = at - lastTick
    lastTick = at
    check()
    if (!capable || refused) return
    if (socketWait && convex.connectionState().isWebSocketConnected) {
      socketWait = false
      if (feedStarted) feed.resume()
      else void beat().catch(() => undefined)
      return
    }
    if (!feedStarted) return
    if (gap > RESUME_GAP_MS) feed.resume()
    // the floor's raise and what a failed call left wait for this tick
    else feed.tick()
  }

  /* This tab now leads, holding the lock or alone. */
  function gain(as: 'leader' | 'alone') {
    role = as
    leadership += 1
    beatenSinceGain = false
    refreshOthers()
    lastTick = Date.now()
    tick = setInterval(onTick, NOTIFY_CLIENT.tick_ms)
    stopPower =
      deps.power?.onResume(() => {
        if (leading() && capable && feedStarted) feed.resume()
      }) ?? null
    capable = deps.canNotify()
    if (capable) begin()
    else freshLeft = false
    mirror()
  }

  /* Stops leading: the feed, the watch, the timers and the lock. */
  function stopLeading() {
    leadership += 1
    halt()
    if (tick) clearInterval(tick)
    tick = null
    stopPower?.()
    stopPower = null
    release?.()
    release = null
  }

  /* Ends the election in progress, whose callback then changes nothing
     and lets go of a lock it is granted. */
  function dropElection() {
    election += 1
    electing = false
  }

  /* Holds the lock for election `mine` until it is let go, leading
     meanwhile. A lock granted to an election that was replaced, or while
     this tab holds one, is let go at once. */
  function hold(mine: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (stopped || mine !== election || release !== null) {
        resolve()
        return
      }
      queued = null
      release = resolve
      gain('leader')
    })
  }

  /* Follows for election `mine`: says hello and queues for the lock,
     dropping any turn it queued before. */
  function follow(mine: number) {
    if (stopped || !locks) return
    queued?.abort()
    role = 'follower'
    mirror()
    post({ kind: 'hello' })
    const abort = new AbortController()
    queued = abort
    void locks
      .request(name, { signal: abort.signal }, () =>
        abort.signal.aborted ? undefined : hold(mine),
      )
      .catch(() => {
        /* aborted at pagehide or freeze, or at stop */
      })
  }

  /* Asks for the lock if it is free, else follows. One election runs at a
     time, so a page back from the cache, which hears both pageshow and the
     document's resume, asks once. */
  function elect() {
    if (stopped || electing) return
    if (!locks || !channel) {
      gain('alone')
      return
    }
    const mine = ++election
    electing = true
    try {
      void locks
        .request(name, { ifAvailable: true }, (lock) => {
          if (mine !== election) return undefined
          electing = false
          if (stopped) return undefined
          if (lock === null) {
            follow(mine)
            return undefined
          }
          return hold(mine)
        })
        .catch(() => {
          if (mine !== election) return
          electing = false
          if (!stopped && role === 'stopped') gain('alone')
        })
    } catch {
      electing = false
      gain('alone')
    }
  }

  /* The page goes into the back and forward cache, closes or freezes: a
     leader that beat since it gained leadership and sees no other tab
     waiting ends the session, and every tab lets go of the lock or its
     turn, whatever its role says, and of an election still waiting. */
  function leave() {
    if (stopped) return
    dropElection()
    if (role === 'stopped') return
    const led = leading()
    if (led && beatenSinceGain && !othersWaiting && instance !== null && !refused) {
      const id = instance
      ends += 1
      void trackNotificationCall(convex, () =>
        convex.mutation(api.notifications.end, { instance: id }),
      ).catch(() => undefined)
    }
    stopLeading()
    queued?.abort()
    queued = null
    if (!led) post({ kind: 'bye' })
    // what it heard before it left may be stale when it returns, so it
    // takes over only from a handover it hears after
    heard = null
    role = 'stopped'
    mirror()
  }

  /* The page is back from the cache or a freeze: it asks for the lock
     again, and leads with the resume order if it gets it. */
  function rejoin() {
    if (stopped || role !== 'stopped' || refused) return
    elect()
  }

  /* A report of use in this tab or a follower. */
  function took() {
    inputAt = Date.now()
    if (!leading() || !capable || refused || mode === 'all') return
    if (reportedAt !== null && inputAt - reportedAt < NOTIFY_CLIENT.report_ms) return
    if (inFlight) {
      inputWaits = true
      return
    }
    void beat().catch(() => undefined)
  }

  function onInput(event: Event) {
    if (!event.isTrusted) return
    if (doc && doc.visibilityState !== 'visible') return
    if (event.type === 'pointermove') {
      const { movementX, movementY }: PageEvent = event
      if (!movementX && !movementY) return
    }
    if (role === 'follower') {
      const at = Date.now()
      if (at - forwardedAt < NOTIFY_CLIENT.forward_ms || !deps.canNotify()) return
      forwardedAt = at
      post({ kind: 'input' })
      return
    }
    took()
  }

  function onMessage(event: MessageEvent) {
    const message = messageOf(event.data)
    if (!message || stopped) return
    switch (message.kind) {
      case 'hello':
        refreshOthers()
        postState()
        return
      case 'bye':
        refreshOthers()
        return
      case 'input':
        if (leading()) took()
        return
      case 'capability':
        check()
        return
      case 'state':
        if (!leading() && (heard === null || message.beat_at >= heard.beat_at)) {
          const { after, keys, baselined, beat_at } = message
          heard = { after, keys, baselined, beat_at }
          // a page that heard a tab lead is no first start
          freshLeft = false
        }
    }
  }

  /* listeners for the page's life */
  const listen = (
    target: LeaderTarget | null,
    type: string,
    fn: (e: Event) => void,
    options?: ListenOptions,
  ) => {
    if (!target) return
    target.addEventListener(type, fn, options)
    stops.push(() => target.removeEventListener(type, fn, options))
  }
  for (const type of deps.inputs ?? []) listen(win, type, onInput, { capture: true, passive: true })
  listen(win, 'pagehide', leave)
  listen(win, 'pageshow', (e: PageEvent) => {
    if (e.persisted) rejoin()
  })
  listen(doc, 'freeze', leave)
  listen(doc, 'resume', rejoin)
  stops.push(
    deps.watchCapability(() => {
      if (leading()) check()
      else if (role === 'follower') post({ kind: 'capability' })
    }),
  )
  if (locks && deps.openChannel) {
    try {
      channel = deps.openChannel(name)
      channel.onmessage = onMessage
    } catch {
      channel = null
    }
  }
  elect()

  return {
    /** Stops for good: lets go of the lock or its turn, whatever the role
        says, and of an election still waiting, closes the channel and the
        listeners, and sends no `end`. */
    stop() {
      if (stopped) return
      stopped = true
      dropElection()
      stopLeading()
      queued?.abort()
      queued = null
      for (const stop of stops.splice(0)) stop()
      channel?.close()
      channel = null
      role = 'stopped'
      mirror()
    },
    /** What the tab is now, for tests. */
    role: () => role,
    /** Whether the server refused the session, which stopped this leader
        for good; the store then starts a new one at its next boot. */
    refused: () => refused,
  }
}

export type NotificationLeader = ReturnType<typeof startNotificationLeader>

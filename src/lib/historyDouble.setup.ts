/* A window double whose session history moves as browsers move it, for the
   history tests (lib/pageHistory and lib/popRefusal). Its timers run on fake
   time. A test file calls fakeTime in beforeEach and vi.useRealTimers in
   afterEach, and settleMoves moves the clock.

   jsdom counts a move's distance from the entry the page called go on and
   has no Navigation API. Browsers queue every traversal, the person's and
   the page's, and count a relative one from the entry it runs on (the HTML
   spec's "traverse the history by a delta"); a move past either end fires
   nothing. With `navigation`, the double adds the Navigation API in the
   order the given engine fires its events, as measured on 2026-10-25 in
   Chromium 153, WebKit 26.6 and Firefox 155:

   - chromium and webkit: per traversal its navigate event, then its commit
     (currententrychange, popstate); the next one's navigate event comes
     after, with the new current entry. Chromium counts a relative
     traversal from the entry the one queued before it goes to, and keeps
     that entry, so a page's pushState meanwhile does not move it; WebKit
     counts it from the entry it runs on.
   - firefox: the navigate events of every traversal queued by then first,
     each counted from the one before it, then the commits. A script's
     relative traversal asked for while some of those have yet to land can
     count from the entry the page is on then, and keep that entry: the
     double always does so, Firefox in some runs only.

   WebKit runs each traversal in a task of its own, queued when it was
   asked for, and keeps one script traversal at a time: history.go and
   traverseTo wait for a zero-delay timer, and one issued before that timer
   fires replaces it (a replaced traverseTo rejects). The person's moves do
   not wait. Without `navigation`, the double queues scripts as the spec
   does.

   pushState and replaceState fire a push or replace navigate event. The
   browser's Reload fires beforeunload and no navigate event; a script's
   location.reload() or go(0) fires a cancelable reload navigate event
   first, then beforeunload. `ios` is WebKit on a phone, which never fires
   beforeunload (webkit.org/b/219102).

   A person's move to the entry a page's keyed traverseTo still waits for
   is merged with it: its navigate event carries the page's info. The
   page's request then runs again later without its info. WebKit turns it
   into a reload when its entry is current, with beforeunload and then a
   reload navigate event in one task (`reloads` counts one that nothing
   cancels); the others do nothing then.

   `elsewhere` puts another site's entry before the first: the Navigation
   API does not list it, and a traversal there leaves the document, firing
   no navigate event and no popstate in it.

   A limit: the double dispatches each popstate from script, so no
   microtask runs between its listeners, while a browser runs them after
   each listener (React commits App's popstate there, before the layers'
   listener). */

import { vi } from 'vitest'

type Engine = 'chromium' | 'webkit' | 'ios' | 'firefox'
type Entry = { state: unknown; url: string; key: string }
type Job = {
  person: boolean
  /** the entry it goes to, counted from the entry `from` it runs on */
  target: (from: number) => number | null
  info?: unknown
  key?: string
  merged?: boolean
  done?: { resolve: () => void; reject: (error: Error) => void }
}

const ORIGIN = 'https://qivo.test'
/** An address as the double keeps it, without the origin. */
const pathOf = (url: string | URL) => String(url).replace(ORIGIN, '')

/** A window on `url` whose history moves as a browser's does, with the
    Navigation API of `navigation` when given, after another site's entry
    at `elsewhere` when given. */
export function browserWindow(url: string, navigation?: Engine, elsewhere?: string) {
  const win = new EventTarget()
  const nav = new EventTarget()
  let keys = 0
  const entry = (state: unknown, at: string): Entry => {
    keys += 1
    return { state, url: at, key: `k${keys}` }
  }
  const entries: Entry[] = elsewhere
    ? [entry(null, elsewhere), entry(null, url)]
    : [entry(null, url)]
  // the first entry of this site's documents, the first the Navigation API lists
  const listed = elsewhere ? 1 : 0
  let index = listed
  let queue: Job[] = []
  let pumping = false
  let reloads = 0

  const navEntry = (n: number) => ({
    key: entries[n].key,
    index: n - listed,
    url: ORIGIN + entries[n].url,
  })
  const webkit = navigation === 'webkit' || navigation === 'ios'
  /** Fires beforeunload, which WebKit on a phone never does. */
  const unload = () => {
    if (navigation !== 'ios') win.dispatchEvent(new Event('beforeunload'))
  }
  /** A reload the page or a script starts: its navigate event, then the reload unless canceled. */
  const scriptReload = () => {
    if (!navigate(index, index, undefined, 'reload')) return
    unload()
    reloads += 1
  }
  /** Fires the navigate event of a move to `to` from `from`; true unless canceled. */
  const navigate = (to: number, from: number, info: unknown, type = 'traverse') => {
    if (!navigation || to < listed) return true
    const event = Object.assign(new Event('navigate', { cancelable: true }), {
      navigationType: type,
      info,
      destination: { key: entries[to]?.key, index: to - listed, url: ORIGIN + entries[to]?.url },
      currentFrom: from,
    })
    nav.dispatchEvent(event)
    return !event.defaultPrevented
  }
  const commit = (to: number) => {
    const from = index
    index = to
    // another site's document: this one is gone
    if (to < listed) return
    if (navigation)
      nav.dispatchEvent(
        Object.assign(new Event('currententrychange'), {
          navigationType: 'traverse',
          from: navEntry(from),
        }),
      )
    win.dispatchEvent(new PopStateEvent('popstate', { state: entries[to].state }))
  }
  /** The entry `job` goes to from `from`, or null when it goes nowhere. */
  const destination = (job: Job, from: number) => {
    const to = job.target(from)
    return to === null || to < 0 || to >= entries.length || to === from ? null : to
  }
  /** Merges a person's move to `to` with a keyed page step waiting for it. */
  const mergeInto = (job: Job, to: number) => {
    if (!job.person) return job.info
    // a page request still in the queue, or in WebKit still waiting for its timer
    const waiting = [...queue, ...(scheduled ? [scheduled.job] : [])].find(
      (other) => !other.person && other.key === entries[to].key && !other.merged,
    )
    if (!waiting) return job.info
    waiting.merged = true
    return waiting.info
  }
  /** Runs a merged page request again, without its info. */
  const rerun = (job: Job) => {
    const to = entries.findIndex((e) => e.key === job.key)
    if (to === index) {
      if (!webkit) return
      unload()
      if (navigate(index, index, undefined, 'reload')) reloads += 1
      return
    }
    if (to >= 0 && navigate(to, index, undefined)) commit(to)
  }
  const run = (job: Job) => {
    if (job.merged) {
      job.done?.resolve()
      return rerun(job)
    }
    if (job.key !== undefined && !entries.some((e) => e.key === job.key))
      return job.done?.reject(new Error('InvalidStateError'))
    const to = destination(job, index)
    if (to === null) return job.done?.resolve()
    if (navigate(to, index, mergeInto(job, to))) {
      commit(to)
      job.done?.resolve()
    } else job.done?.reject(new Error('AbortError'))
  }
  /** Firefox: the navigate events of the batch first, then its commits. */
  // Firefox: the commits of the batch still to land (runBatch)
  let landing = 0
  const runBatch = (batch: Job[]) => {
    let from = index
    const planned: { job: Job; to: number | null; go: boolean }[] = []
    for (const job of batch) {
      if (job.merged) {
        planned.push({ job, to: null, go: true })
        continue
      }
      const to = destination(job, from)
      if (to === null) {
        planned.push({ job, to, go: false })
        continue
      }
      const go = navigate(to, from, mergeInto(job, to))
      planned.push({ job, to, go })
      if (go) from = to
    }
    landing = planned.length
    for (const { job, to, go } of planned) {
      landing -= 1
      if (job.merged) rerun(job)
      else if (to !== null && go) commit(to)
      if (to === null || go) job.done?.resolve()
      else job.done?.reject(new Error('AbortError'))
    }
  }
  const pump = () => {
    if (pumping) return
    pumping = true
    setTimeout(() => {
      pumping = false
      if (navigation === 'firefox') {
        const batch = queue
        queue = []
        runBatch(batch)
      } else {
        const job = queue.shift()
        if (job) run(job)
      }
      if (queue.length) pump()
    }, 0)
  }
  // WebKit: the script traversal waiting for its timer (script)
  let scheduled: { job: Job; timer: ReturnType<typeof setTimeout> } | null = null
  /** Queues a script's traversal, in WebKit once its timer fires. */
  const script = (job: Job) => {
    if (!webkit) return traverse(job)
    if (scheduled) {
      clearTimeout(scheduled.timer)
      scheduled.job.done?.reject(new Error('AbortError'))
    }
    const timer = setTimeout(() => {
      scheduled = null
      traverse(job)
    }, 0)
    scheduled = { job, timer }
  }
  // Chromium: the entry the traversals queued so far go to (traverse)
  let planned: number | null = null
  const traverse = (job: Job) => {
    // WebKit runs each traversal in a task of its own, queued as it was
    // asked for, so a timer set later waits for it
    if (webkit) {
      queue.push(job)
      setTimeout(() => {
        const next = queue.shift()
        if (next) run(next)
      }, 0)
      return
    }
    if (navigation === 'firefox' && landing && !job.person && job.key === undefined) {
      const to = destination(job, index)
      const key = to === null ? undefined : entries[to].key
      job.target = () => (key === undefined ? null : entries.findIndex((e) => e.key === key))
    }
    if (navigation === 'chromium') {
      const from = queue.length && planned !== null ? planned : index
      const to = destination(job, from)
      const key = job.key ?? (to === null ? undefined : entries[to].key)
      planned = to ?? from
      job.target = () => (key === undefined ? null : entries.findIndex((e) => e.key === key))
    }
    queue.push(job)
    pump()
  }

  // methods on the prototype, as on History, which the wrappers' removal restores
  class BrowserHistory {
    get state() {
      return entries[index].state
    }
    get length() {
      return entries.length
    }
    pushState(state: unknown, _: string, next?: string | URL | null) {
      navigate(index + 1, index, undefined, 'push')
      entries.splice(
        index + 1,
        entries.length,
        entry(state, next ? pathOf(next) : entries[index].url),
      )
      index += 1
    }
    replaceState(state: unknown, _: string, next?: string | URL | null) {
      navigate(index, index, undefined, 'replace')
      entries[index] = { ...entries[index], state, url: next ? pathOf(next) : entries[index].url }
    }
    go(delta = 0) {
      if (!delta) return scriptReload()
      script({ person: false, target: (from) => from + delta })
    }
    back() {
      this.go(-1)
    }
    forward() {
      this.go(1)
    }
  }
  const history = new BrowserHistory()
  const location = {
    get href() {
      return ORIGIN + entries[index].url
    },
    get pathname() {
      return entries[index].url.split(/[?#]/)[0]
    },
    get hash() {
      const at = entries[index].url.indexOf('#')
      return at < 0 ? '' : entries[index].url.slice(at)
    },
    reload: scriptReload,
  }
  const navigator = {
    platform: navigation === 'ios' ? 'iPhone' : 'Linux x86_64',
    maxTouchPoints: 0,
  }
  if (navigation) Object.defineProperty(nav, 'currentEntry', { get: () => navEntry(index) })
  if (navigation)
    Object.assign(nav, {
      entries: () => entries.slice(listed).map((_, n) => navEntry(n + listed)),
      traverseTo(key: string, options?: { info?: unknown }) {
        let done: Job['done']
        const committed = new Promise<void>((resolve, reject) => {
          done = { resolve, reject }
        })
        script({
          person: false,
          key,
          info: options?.info,
          target: () => entries.findIndex((e) => e.key === key),
          done,
        })
        return { committed, finished: committed }
      },
    })
  const window = Object.assign(
    win,
    { history, location, navigator },
    navigation ? { navigation: nav } : {},
  )
  return {
    window: window as unknown as Window,
    history: history as unknown as History,
    /** The current entry's address. */
    here: () => entries[index].url,
    /** Every entry's address. */
    urls: () => entries.map((e) => e.url),
    /** The current entry's index. */
    index: () => index,
    /** Reloads that nothing canceled: the person's, a script's, or WebKit's
        turn of a merged request. */
    reloads: () => reloads,
    /** The person's moves: the browser's Back and Forward, a pick from its
        Back or Forward menu of the entry at `to`, and its Reload. */
    person: {
      back: () => traverse({ person: true, target: (from) => from - 1 }),
      forward: () => traverse({ person: true, target: (from) => from + 1 }),
      pick: (to: number) => traverse({ person: true, target: () => to }),
      reload: () => {
        unload()
        reloads += 1
      },
    },
  }
}

/** Puts a history test on fake time, for its beforeEach. It fakes the
    timers the double and the page set, and Date, which an unsent scope's
    Discard reads (lib/leaveGuard). Microtasks stay real, as a layer's
    marker waits for one (openLayer). So do setInterval, setImmediate,
    requestAnimationFrame and performance, which none of them uses. Add one
    here before the page or the double starts to. */
export function fakeTime() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
}

/** Lets every move on its way land, and what they started. It runs the
    timers due in the next 40 ms of fake time (fakeTime) in order, each with
    the microtasks it queued before the next timer. */
export const settleMoves = () => vi.advanceTimersByTimeAsync(40)

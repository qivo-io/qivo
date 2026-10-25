/* The page's place in this tab's session history, and the few moves the
   page makes in it.

   Every entry's state carries its position as `qivoAt`, stamped by the
   pushState and replaceState wrappers installPageHistory puts in place. A
   phone layer (lib/useMobile) marks its Back step with an entry of its own,
   a *marker*: a copy of the entry below with the same address and
   `qivoLayer` (the layer's token), `qivoDepth` (how many markers up from
   the page's entry) and `qivoPageUrl` (the page's address when the first
   marker over it went on). A page's entry and the markers over it are its
   *run*: a Back within a run shows the same page, and closes the layers
   whose markers it leaves. Each open layer has its own marker, so Backs
   that the browser has queued before the page runs each close one layer,
   in every engine, without any step of the page's.

   A layer that closes without the person's Back, as a finished dialog does,
   never moves the history: its marker stays as a *spare*. The next page the
   app opens takes the place of the spare it is on (pushPage), the next layer
   takes it over, and a Back from a spare to an entry of its run that shows
   the same, so changes nothing on screen, goes on one entry more in that
   Back's own popstate. Each going-on is a single step that commutes with
   the person's own Backs, also when they are queued (Chromium and Firefox
   count a queued Back from the one before it), so a Back still leaves one
   page per press. A spare a Back went on from stays as a Forward entry that
   shows the same page, so a Forward onto it changes nothing on screen: no
   step can remove it, since the History and Navigation APIs drop Forward
   entries only by adding one, and a spare that is the last entry has
   nowhere to go on to.

   Every step the page takes starts inside a move or tap of the person's
   own, or, for the first-entry step, where only a Back can race it. A move
   of the person's can race one only within that task, since a page cannot
   cancel a traversal the browser has queued: then it may land one entry
   off. Every engine fires one popstate per traversal, so nothing here
   counts steps any other way or tells moves apart by timing. WebKit keeps
   one script traversal at a time, so every script traversal, the page's
   and other scripts' history.go, back and forward, waits for the one before
   it to start (serially); the person's own Back and Forward are not
   scripts there.

   A Back or Forward the app refuses (lib/popRefusal) returns to the entry it
   left, hidden from every other listener: by key with the Navigation API,
   which lands there whatever moved first, and by position without it, one
   step back over each refused move, which add up to the entry left. */

/** A phone layer's place in the history (useMobileBackLayer). */
export type BackLayer = {
  /** `deciding` while its onBack runs, so a second close is dropped */
  state: 'open' | 'deciding' | 'closed'
  /** its marker's token, and that marker's position, null until it is on */
  readonly marker: string
  at: number | null
  readonly onBack: () => unknown
}

/** An entry as the page last saw it: its position, state, address and, with
    the Navigation API, its key. */
type Entry = { at: number | null; state: unknown; url: string; key: string | null }

/* Markers carry the document's load in their token, so the markers of an
   earlier load (after a reload) are spares. */
const LOAD = Math.random().toString(36).slice(2, 8)
let seq = 0

let win: Window | null = null
let push: History['pushState'] | null = null
let replace: History['replaceState'] | null = null
// the current position, and the highest one known to exist: Infinity after
// booting on an entry that had a position, as entries may follow it
let at = 0
let top = 0
// the entry the page is on, the one whose page the app shows, and the one
// the app showed before the latest popstate, which a refused move returns to
let last: Entry = { at: 0, state: null, url: '', key: null }
let shown: Entry = last
let left: Entry = last
// the latest popstate's step, null when an end of it has no position
let moved: number | null = null
// open layers in the order they opened, and those the last popstate left,
// top first, for the layers' listener (listenBackLayers)
const open = new Set<BackLayer>()
let popped: BackLayer[] = []
// the first-entry step on its way (firstEntryStep)
let settling = false
// a phone close's step past the page on its way (leavePage)
let leaving = false
// the refusal's return on its way (returnTo): with the Navigation API the
// key it goes to, the token its navigate event carries and whether that
// event fired; without it the position it returns to and its steps not yet
// landed, the oldest first. What it runs once landed, and, by key, `voided`
// once the app took another move meanwhile.
let ret: {
  key: string | null
  at: number | null
  steps: number[]
  token: string
  started: boolean
  voided: boolean
  landed: () => void
} | null = null
// returns whose navigate event fired since the page last pushed an entry:
// WebKit runs a return that a person's move merged with once more, as a
// reload of the entry it reached, which the page cancels (onNavigate)
let reruns = 0
// a beforeunload in this task: WebKit fires it before that reload's navigate
// event, and a script's location.reload() only after its own
let unloading = false
// what waits for the page's own move to land (whenQuiet, onHistorySettled)
let waiting: (() => void)[] = []
const settledListeners = new Set<() => void>()
// a page step issued in this task, after which nothing may write history
let stepped = false
// the history's own go, and the script traversals waiting for the one
// issued before them to start (serially)
let rawGo: History['go'] | null = null
// with the Navigation API, the index the latest traversal goes to: Firefox
// fires the navigate events of the traversals queued by then before the
// first lands, so it can lie past the entry the page is on (goOn)
let ahead: number | null = null
let issuing = false
let queued: (() => void)[] = []

const record = (state: unknown) => (state !== null && typeof state === 'object' ? state : null)
const positionIn = (state: unknown) => {
  const to = record(state) && Reflect.get(record(state)!, 'qivoAt')
  return typeof to === 'number' ? to : null
}
const tokenIn = (state: unknown) => {
  const token = record(state) && Reflect.get(record(state)!, 'qivoLayer')
  return typeof token === 'string' ? token : null
}
/** How many markers up from its page's entry `state` is: 0 for a page's
    entry, 1 for a marker of an older load that carries no depth. */
const depthIn = (state: unknown) => {
  if (!tokenIn(state)) return 0
  const depth = Reflect.get(record(state)!, 'qivoDepth')
  return typeof depth === 'number' && depth > 0 ? depth : 1
}
const withPosition = (state: unknown, index: number) => ({ ...record(state), qivoAt: index })
const navigationOf = (w: Window) => ('navigation' in w ? w.navigation : null)
/** Whether `state` is a marker whose layer is no longer open: a spare. */
const isSpare = (state: unknown) => {
  const token = tokenIn(state)
  return token !== null && ![...open].some((layer) => layer.marker === token)
}
/** Whether an open layer's marker is above `from` and at most `to`. */
const openWithin = (from: number, to: number) =>
  [...open].some((layer) => layer.at !== null && layer.at > from && layer.at <= to)
/** The window the page's history is installed on, or this one before then,
    as in a test that renders App alone. */
const current = () => win ?? window
/** Whether the page is on the session's last entry, never known without
    the Navigation API after booting on an entry that had a position. */
function onLastEntry(w: Window) {
  const nav = navigationOf(w)
  return nav ? nav.currentEntry?.index === nav.entries().length - 1 : at === top
}
/** Whether `w` fires beforeunload: WebKit on iOS and iPadOS never does
    (webkit.org/b/219102). */
function firesBeforeUnload(w: Window) {
  const platform = w.navigator?.platform ?? ''
  return (
    !/^iP(hone|ad|od)/.test(platform) &&
    !(platform === 'MacIntel' && w.navigator.maxTouchPoints > 1)
  )
}

/** Notes the entry the page is on now. */
function note() {
  const w = current()
  last = {
    at,
    state: w.history.state,
    url: w.location.href,
    key: navigationOf(w)?.currentEntry?.key ?? null,
  }
}

/** Notes a page step: nothing may write history in the rest of this task,
    as Firefox then drops the step. */
function stepping() {
  stepped = true
  setTimeout(() => {
    stepped = false
  }, 0)
}

/** Runs `traverse`, a script's traversal, now, or once the one issued
    before it has started: WebKit keeps one script traversal at a time, and
    one issued before the last has started replaces it. Its timer for that
    traversal fires before a timer set after it. */
function serially(traverse: () => void) {
  if (issuing) {
    queued.push(traverse)
    return
  }
  issuing = true
  traverse()
  setTimeout(() => {
    issuing = false
    const next = queued.shift()
    if (next) serially(next)
  }, 0)
}

/** Moves `delta` entries as the page's own step, in turn (serially). */
function go(delta: number) {
  serially(() => {
    stepping()
    if (rawGo) rawGo(delta)
    else current().history.go(delta)
  })
}

/** Goes one entry back for a Back from a spare, in turn (serially). When
    Firefox has queued a later traversal, the step goes by key to the entry
    before that one's: Firefox may count a relative step from the entry the
    page is on, so it would land where the queued traversal does. */
function goOn() {
  serially(() => {
    const nav = navigationOf(current())
    const here = nav?.currentEntry?.index
    const key = ahead !== null && ahead !== here ? nav?.entries()[ahead - 1]?.key : undefined
    if (!nav || key === undefined) {
      stepping()
      if (rawGo) rawGo(-1)
      else current().history.go(-1)
      return
    }
    stepping()
    nav.traverseTo(key).finished.catch(() => {})
  })
}

/** Runs what waited for the page's own move, once none is on its way, after
    the other listeners and React's commit of its popstate. */
function settleSoon() {
  setTimeout(() => {
    if (historyBusy()) return
    const ready = waiting
    waiting = []
    for (const fn of ready) fn()
    for (const listener of settledListeners) listener()
  }, 0)
}

/** Closes the open `layer`: its onBack (its onClose) runs once, and the
    layer closes or answers false and stays open. A close while it decides,
    or after it closed, does nothing. Answers whether it closed. */
export function closeLayer(layer: BackLayer) {
  if (layer.state !== 'open') return false
  layer.state = 'deciding'
  const kept = layer.onBack() === false
  // an unmount while it decided has finished it already
  if (!open.has(layer)) return true
  if (kept) {
    layer.state = 'open'
    return false
  }
  finishLayer(layer)
  return true
}

/** Lands the refusal's return when this popstate is its own: its key with
    the Navigation API, else its next step. Answers true when the popstate
    is the return's and so ends here, unheard unless the app took another
    move meanwhile. */
function landReturn(event: PopStateEvent) {
  const done = ret!
  if (done.key !== null) {
    // with the Navigation API a move elsewhere first is a move like any
    // other, and the return lands later
    if (last.key !== done.key) return false
  } else {
    // by position: a step of another move is a move like any other, and the
    // return's steps still land after it (joinReturn adds one back over it)
    if (moved === null || moved !== done.steps[0]) return false
    done.steps.shift()
    if (done.steps.length) {
      event.stopImmediatePropagation()
      popped = []
      return true
    }
  }
  ret = null
  settleSoon()
  // a move of the person's by the same step, after which the return's own
  // lands as a move like any other
  if (done.key === null && last.at !== done.at) return false
  if (done.voided) return false
  event.stopImmediatePropagation()
  popped = []
  done.landed()
  return true
}

/** The page's first popstate listener. It records the move, lands the
    refusal's return unheard, carries an address written in place over a
    marker down to the entry a Back reaches in its run, and goes on from a
    spare. Everything here runs before App reads the address. */
function onPop(event: PopStateEvent) {
  const w = current()
  const from = last
  const here = positionIn(w.history.state)
  if (here !== null) at = here
  note()
  left = shown
  shown = last
  leaving = false
  moved = here !== null && from.at !== null ? here - from.at : null
  // the open layers this move left, top first (an entry without a position
  // is below them all), for the layers' listener after App's
  popped = [...open]
    .filter((layer) => layer.at !== null && (here === null || layer.at > here))
    .sort((a, b) => b.at! - a.at!)
  if (ret && landReturn(event)) return
  const firstEntry = settling
  settling = false
  // a Back from a marker to an entry of its run, which shows the same page
  const inRun =
    moved !== null && moved < 0 && tokenIn(from.state) !== null && -moved <= depthIn(from.state)
  if (inRun && last.url !== from.url) replace!(last.state, '', from.url)
  if (firstEntry) {
    // the person's Back came first and stopped on a spare over the first
    // entry: the step goes on from there, as only a Back can race it
    if (inRun && isSpare(last.state) && !openWithin(here! - depthIn(last.state), here!)) {
      settling = true
      go(-depthIn(last.state))
    }
    return settleSoon()
  }
  // a Back from a spare that changed nothing on screen: one entry more
  if (inRun && isSpare(from.state) && !popped.length && !ret) {
    event.stopImmediatePropagation()
    goOn()
  }
}

/** The layers' popstate listener, which App adds right after its own, so a
    move App refuses never reaches it. Each open layer the move left closes,
    the top one first; one that answers false stays, and it and the layers
    under it that the move also left get their markers back. */
function onLayersPop() {
  const gone = popped
  popped = []
  for (const [n, layer] of gone.entries()) {
    if (layer.state !== 'open') continue
    if (closeLayer(layer)) continue
    const kept = gone
      .slice(n)
      .filter((other) => other.state === 'open')
      .reverse()
    whenQuiet(() => {
      for (const other of kept) markLayer(other)
    })
    return
  }
}

/** Puts `layer`'s marker on: it takes over the spare the page is on when no
    entry follows it, or goes on top of the current entry. */
function markLayer(layer: BackLayer) {
  if (layer.state !== 'open') return
  const w = current()
  const state = w.history.state
  if (isSpare(state) && onLastEntry(w))
    w.history.replaceState({ ...record(state), qivoLayer: layer.marker }, '')
  else
    w.history.pushState(
      {
        ...record(state),
        qivoLayer: layer.marker,
        qivoDepth: depthIn(state) + 1,
        qivoPageUrl: tokenIn(state) ? Reflect.get(record(state)!, 'qivoPageUrl') : w.location.href,
      },
      '',
      w.location.href,
    )
  layer.at = at
}

/** Spares over the session's first entry with no entry after them: a Back
    from them would have nowhere to go on to, so the page steps off them to
    that entry now. Only a Back of the person's can race the step; one that
    lands first on a spare there is followed by the rest of the step
    (onPop), and the step itself then goes nowhere. */
function firstEntryStep() {
  const w = current()
  const state = w.history.state
  const depth = depthIn(state)
  // the length holds only the run, so its page's entry is the first
  if (!isSpare(state) || historyBusy() || w.history.length !== depth + 1) return
  if (openWithin(at - depth, at)) return
  settling = true
  go(-depth)
}

/** Stamps the current entry and every entry the page adds or replaces from
    now on, adds the page's first popstate listener and the listeners the
    reload guard and leavePage need, and steps off spares the page booted
    on over the session's first entry. Call it before anything adds an entry
    (main.tsx). `target` lets tests pass a browser double. Answers a function
    that removes all of it. */
export function installPageHistory(target: Window = window) {
  const h = target.history
  win = target
  push = h.pushState.bind(h)
  const rawReplace = h.replaceState.bind(h)
  replace = (state, unused, url) => {
    if (stepped && import.meta.env.DEV) console.error('History written right after a page step')
    rawReplace(withPosition(state, at), unused, url)
    note()
    shown = last
  }
  const booted = positionIn(h.state)
  at = booted ?? 0
  top = booted === null ? at : Infinity
  rawReplace(withPosition(h.state, at), '')
  note()
  shown = last
  left = last
  h.pushState = (state, unused, url) => {
    if (stepped && import.meta.env.DEV) console.error('History written right after a page step')
    at += 1
    top = at
    push!(withPosition(state, at), unused, url)
    note()
    shown = last
  }
  h.replaceState = replace
  // every script's Back, Forward and go takes its turn with the page's own
  const ownGo = h.go.bind(h)
  rawGo = ownGo
  h.go = (delta?: number) => {
    if (!delta) return ownGo(delta)
    serially(() => ownGo(delta))
  }
  h.back = () => h.go(-1)
  h.forward = () => h.go(1)
  target.addEventListener('popstate', onPop)
  const guardsAll = !firesBeforeUnload(target)
  const nav = navigationOf(target)
  /* The reload guard, measured on 2026-10-25 in Chromium 153, WebKit 26.6
     and Firefox 155. The browser's Reload fires no navigate event, and a
     script's location.reload() fires its navigate event before its
     beforeunload. Only WebKit runs a return merged with a person's move
     once more, as a reload of the entry the return reached, whose
     beforeunload comes first, in the same task. That reload alone is
     canceled. Where no beforeunload fires (iOS), a reload without info is
     canceled while a return may still run once more, until the page next
     pushes an entry: the return's entry is then not the current one, so
     its re-run is no reload. */
  const onNavigate = (event: NavigateEvent) => {
    if (event.navigationType === 'traverse') ahead = event.destination.index
    if (event.navigationType === 'push') reruns = 0
    if (
      event.navigationType === 'reload' &&
      event.info === undefined &&
      reruns > 0 &&
      (unloading || guardsAll)
    ) {
      event.preventDefault()
      reruns -= 1
      return
    }
    if (ret && event.info === ret.token) {
      ret.started = true
      reruns += 1
    }
  }
  const onUnload = () => {
    unloading = true
    // a cross-document step past the page ends here: it leaves or the
    // person stays, so the next close may step again (leavePage)
    leaving = false
    setTimeout(() => {
      unloading = false
    }, 0)
  }
  // shown again from the back/forward cache, as after a cross-document step
  const onShow = () => {
    leaving = false
  }
  nav?.addEventListener('navigate', onNavigate)
  target.addEventListener('beforeunload', onUnload)
  target.addEventListener('pageshow', onShow)
  firstEntryStep()
  return () => {
    for (const key of ['pushState', 'replaceState', 'go', 'back', 'forward'])
      Reflect.deleteProperty(h, key)
    target.removeEventListener('popstate', onPop)
    nav?.removeEventListener('navigate', onNavigate)
    target.removeEventListener('beforeunload', onUnload)
    target.removeEventListener('pageshow', onShow)
    win = null
    open.clear()
    popped = []
    moved = null
    settling = false
    leaving = false
    ret = null
    reruns = 0
    unloading = false
    waiting = []
    stepped = false
    rawGo = null
    ahead = null
    issuing = false
    queued = []
  }
}

/** Adds the layers' listener (onLayersPop); App adds it right after its own
    popstate listener. Answers a function that removes it. */
export function listenBackLayers(target: Window = current()) {
  target.addEventListener('popstate', onLayersPop)
  return () => target.removeEventListener('popstate', onLayersPop)
}

/** The current entry's position. */
export const position = () => at

/** Adds a page entry with `state` at `url`, or takes the place of the spare
    the page is on when nothing was written on it in place and no entry
    follows it. */
export function pushPage(state: object, url: string) {
  const w = current()
  const here = w.history.state
  if (
    isSpare(here) &&
    onLastEntry(w) &&
    w.location.href === Reflect.get(record(here)!, 'qivoPageUrl')
  )
    w.history.replaceState(state, '', url)
  else w.history.pushState(state, '', url)
}

/** Registers an open phone layer; its marker goes on in a microtask, after
    the address sync of the commit that opened it, once no page move is on
    its way. `onBack` runs when a Back leaves its marker, the top layer
    first, and answers false to keep it open. */
export function openLayer(onBack: () => unknown): BackLayer {
  seq += 1
  const layer: BackLayer = { state: 'open', marker: `${LOAD}:${seq}`, at: null, onBack }
  open.add(layer)
  queueMicrotask(() => whenQuiet(() => markLayer(layer)))
  return layer
}

/** The layer closed or unmounted. Its marker, if any, is a spare from now
    on, and the page steps off spares over the session's first entry
    (firstEntryStep) once what closed the layer has committed. Idempotent. */
export function finishLayer(layer: BackLayer) {
  if (layer.state === 'closed') return
  layer.state = 'closed'
  open.delete(layer)
  if (layer.at !== null) setTimeout(() => win && firstEntryStep(), 0)
}

/** Leaves the page as a phone close does: one step back past its entry and
    the markers over it. A second one before that step lands adds nothing; a
    step past the document that the person stays from (beforeunload) or that
    keeps it in the back/forward cache (pageshow) no longer counts. */
export function leavePage() {
  if (leaving) return
  leaving = true
  go(-depthIn(current().history.state) - 1)
}

/** Whether the refusal's return or the first-entry step is on its way. */
export const historyBusy = () => !!ret || settling

/** Runs `fn` now, or once the page's own move on its way has landed. */
export function whenQuiet(fn: () => void) {
  if (historyBusy()) waiting.push(fn)
  else fn()
}

/** Calls `listener` each time a page move the app waited for has landed.
    Answers a function that stops it. */
export function onHistorySettled(listener: () => void) {
  settledListeners.add(listener)
  return () => {
    settledListeners.delete(listener)
  }
}

/** Takes the latest popstate's move as refused, so the app still shows the
    page it showed before. Answers the entry of that page, which the move is
    to return to, and the entry the move reached. */
export function refuseMove() {
  shown = left
  return { from: left, to: last }
}

/** Returns to `to`, the entry a refused move left, as the page's own move
    that reaches no other listener; then runs `landed`. With the Navigation
    API it goes by key and lands there whatever moved first; one that
    cannot start, as when the entry is gone, lands at once. Without the API
    it steps back over the move (joinReturn adds one for each later refused
    move). Answers false, moving nothing, when `to` has no key or position,
    or is the entry the page is on. */
export function returnTo(to: Entry, landed: () => void) {
  const nav = navigationOf(current())
  const key = nav ? to.key : null
  const delta = to.at === null || last.at === null ? 0 : to.at - last.at
  if (nav ? key === null || key === last.key : !delta || moved !== -delta) return false
  seq += 1
  const step = {
    key,
    at: to.at,
    steps: nav ? [] : [delta],
    token: `${LOAD}:return:${seq}`,
    started: false,
    voided: false,
    landed,
  }
  ret = step
  if (!nav || key === null) {
    go(delta)
    return true
  }
  /** Lands the return that fired no navigate event, so moved nothing. */
  const unmoved = () => {
    if (ret !== step || step.started) return
    ret = null
    landed()
    settleSoon()
  }
  serially(() => {
    stepping()
    const { committed, finished } = nav.traverseTo(key, { info: step.token })
    // Firefox can reject although the step commits: only the popstate counts
    finished.catch(() => {})
    committed.then(unmoved, unmoved)
  })
  return true
}

/** A move refused while the return is on its way joins it. With the
    Navigation API the return lands on its entry whatever moved first; by
    position it also steps back over this move, so its steps still add up
    to the entry left. Answers false when this move's step is not known. */
export function joinReturn() {
  if (!ret) return false
  if (ret.key !== null) return true
  if (!moved) return false
  ret.steps.push(-moved)
  go(-moved)
  return true
}

/** The app took another move while a return is on its way: by key the
    return then lands heard, and by position its steps are moves like any
    other from then on. */
export function voidReturn() {
  if (ret?.key === null) ret = null
  else if (ret) ret.voided = true
}

/** Whether the refusal's return is on its way. */
export const returning = () => !!ret

/** Moves to `to` as the person's own move, heard: Discard taking a refused
    move again. By key with the Navigation API, else by position; nothing
    when that entry is gone or current. */
export function goTo(to: Entry) {
  const nav = navigationOf(current())
  let delta = to.at === null ? 0 : to.at - at
  if (nav) {
    const here = nav.currentEntry?.index
    const there = nav.entries().findIndex((entry) => entry.key === to.key)
    delta = there < 0 || here === undefined ? 0 : there - here
  }
  if (!delta) return
  go(delta)
}

/** Reloads the page, past the guard that cancels WebKit's turn of a merged
    return into a reload. Every reload the app starts goes through this. */
export function reloadPage() {
  reruns = 0
  current().location.reload()
}

/** Lets the next reload through, as a development server's. */
export function disarmReloadGuard() {
  reruns = 0
}

/* The page's place in this tab's session history, and the few moves the
   page makes in it.

   Every entry's state carries its position as `qivoAt`, stamped by the
   pushState and replaceState wrappers installPageHistory puts in place. The
   phone layers (lib/useMobile) open over a page share one Back step, its
   *marker*: an entry of its own right over the page's entry, a copy of it
   with the same address and `qivoLayer` (the marker's token) and
   `qivoPageUrl` (the page's address when the marker went on). A Back from
   the marker closes the top layer, and the marker goes on again for the
   layers still open; a Back from the page's entry leaves the page.

   A layer that closes without the person's Back, as a finished dialog does,
   never moves the history. Once no layer over the page is open, its marker
   is a *spare*: the next page the app opens takes its place (pushPage), the
   next layer takes it over, and a Back from it to the page's entry, which
   shows the same page, goes on one entry more in that Back's own popstate,
   so one Back still leaves the page. A page has one marker at most, so a
   Back never crosses two spares, and each going-on is a single step that
   commutes with the person's own moves. A spare a Back went on from stays
   as a Forward entry that shows the same page; going on forward too could
   loop with a Back, so a Forward onto it changes nothing on screen.

   Every step the page takes starts inside a move or tap of the person's
   own, or, for the first-entry step, where only a Back can race it. A move
   of the person's can race one only within that task, since a page cannot
   cancel a traversal the browser has queued: then it may land one entry
   off. Nothing here tells moves apart by timing.

   A Back or Forward the app refuses (lib/popRefusal) returns to the entry it
   left, hidden from every other listener: by key with the Navigation API,
   which lands there whatever moved first, and by position without it. */

/** A phone layer's place in the history (useMobileBackLayer). */
export type BackLayer = {
  /** `deciding` while its onBack runs, so a second close is dropped */
  state: 'open' | 'deciding' | 'closed'
  /** the token of the marker it shares with the other layers open over its
      page, and that marker's position, null until the marker is on */
  marker: string | null
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
// open layers in the order they opened, and those the last popstate left,
// top first, for the layers' listener (listenBackLayers)
const open = new Set<BackLayer>()
let popped: BackLayer[] = []
// the first-entry step on its way (firstEntryStep)
let settling = false
// a phone close's step past the page on its way (leavePage)
let leaving = false
// the refusal's return on its way (returnTo): its key, or without the
// Navigation API its position; the token its navigate event carries,
// whether that event fired, and what it runs once landed. `voided` once the
// app took another move meanwhile.
let ret: {
  key: string | null
  at: number | null
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

const record = (state: unknown) => (state !== null && typeof state === 'object' ? state : null)
const positionIn = (state: unknown) => {
  const to = record(state) && Reflect.get(record(state)!, 'qivoAt')
  return typeof to === 'number' ? to : null
}
const tokenIn = (state: unknown) => {
  const token = record(state) && Reflect.get(record(state)!, 'qivoLayer')
  return typeof token === 'string' ? token : null
}
const withPosition = (state: unknown, index: number) => ({ ...record(state), qivoAt: index })
const navigationOf = (w: Window) => ('navigation' in w ? w.navigation : null)
/** Whether `state` is a marker no open layer shares: a spare. */
const isSpare = (state: unknown) => {
  const token = tokenIn(state)
  return token !== null && ![...open].some((layer) => layer.marker === token)
}
/** The window the page's history is installed on, or this one before then,
    as in a test that renders App alone. */
const current = () => win ?? window
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

/** The page's first popstate listener. It records the move, lands the
    refusal's return unheard, carries an address written in place over a
    marker down to the page's entry a Back reaches, and goes on from a
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
  // a Back from a marker to its page's entry, which shows the same page
  const down =
    from.at !== null && here === from.at - 1 && tokenIn(from.state) !== null && !tokenIn(last.state)
  // the open layers this move left, top first (an entry without a position
  // is below them all); a Back to the page's entry leaves only the top one
  const gone = [...open]
    .reverse()
    .filter((layer) => layer.at !== null && (here === null || layer.at > here))
    .sort((a, b) => b.at! - a.at!)
  popped = down ? gone.filter((layer) => layer.marker === tokenIn(from.state)).slice(0, 1) : gone
  if (ret) {
    const done = ret
    if (done.key !== null ? last.key === done.key : here === done.at) {
      ret = null
      // unless the app took another move meanwhile (voidReturn), when this
      // landing is a move like any other
      if (!done.voided) {
        event.stopImmediatePropagation()
        popped = []
        done.landed()
      }
      return settleSoon()
    }
    // a return by position that another move overtook: that move is the
    // move now, and the return lands later as one more
    if (done.key === null) {
      ret = null
      settleSoon()
    }
  }
  const firstEntry = settling
  settling = false
  if (down && last.url !== from.url) replace!(last.state, '', from.url)
  if (down && isSpare(from.state) && !firstEntry && !ret) {
    event.stopImmediatePropagation()
    popped = []
    stepping()
    w.history.go(-1)
  }
  if (firstEntry) settleSoon()
}

/** The layers' popstate listener, which App adds right after its own, so a
    move App refuses never reaches it. Each open layer the move left closes,
    the top one first, until one answers false; then every open layer whose
    marker the move left behind, as those under the one a Back closed, gets
    one again over the entry reached. */
function onLayersPop() {
  const gone = popped
  popped = []
  for (const layer of gone) if (layer.state === 'open' && !closeLayer(layer)) break
  const stranded = [...open].filter((layer) => layer.at !== null && layer.at > at)
  if (stranded.length) whenQuiet(() => markLayers(stranded))
}

/** Puts on the marker of `layers`, which are open over the page shown: they
    join the marker the page is on while a layer shares it, or take over a
    spare the page is on, or get one pushed over the page's entry. */
function markLayers(layers: BackLayer[]) {
  const marking = layers.filter((layer) => layer.state === 'open')
  if (!marking.length) return
  const w = current()
  const state = w.history.state
  let token = tokenIn(state)
  if (token === null || isSpare(state)) {
    seq += 1
    token = `${LOAD}:${seq}`
    const marker = { ...record(state), qivoLayer: token }
    if (isSpare(state)) w.history.replaceState(marker, '')
    else w.history.pushState({ ...marker, qivoPageUrl: w.location.href }, '', w.location.href)
  }
  for (const layer of marking) {
    layer.marker = token
    layer.at = at
  }
}

/** A spare over the session's first entry with no entry after it: a Back
    from it would have nowhere to go on to, so the page steps off it now.
    Only a Back of the person's can race the step, which then goes nowhere,
    so exactly one popstate follows. */
function firstEntryStep() {
  const w = current()
  if (!isSpare(w.history.state) || historyBusy() || w.history.length !== 2) return
  settling = true
  stepping()
  w.history.go(-1)
}

/** Stamps the current entry and every entry the page adds or replaces from
    now on, adds the page's first popstate listener and the listeners the
    reload guard and leavePage need, and steps off a spare the page booted
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
    for (const key of ['pushState', 'replaceState']) Reflect.deleteProperty(h, key)
    target.removeEventListener('popstate', onPop)
    nav?.removeEventListener('navigate', onNavigate)
    target.removeEventListener('beforeunload', onUnload)
    target.removeEventListener('pageshow', onShow)
    win = null
    open.clear()
    popped = []
    settling = false
    leaving = false
    ret = null
    reruns = 0
    unloading = false
    waiting = []
    stepped = false
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
  const nav = navigationOf(w)
  const lastEntry = nav ? nav.currentEntry?.index === nav.entries().length - 1 : at === top
  if (isSpare(here) && lastEntry && w.location.href === Reflect.get(record(here)!, 'qivoPageUrl'))
    w.history.replaceState(state, '', url)
  else w.history.pushState(state, '', url)
}

/** Registers an open phone layer; its marker goes on in a microtask, after
    the address sync of the commit that opened it, once no page move is on
    its way. `onBack` runs when a Back leaves its marker while it is the top
    layer there, and answers false to keep it open. */
export function openLayer(onBack: () => unknown): BackLayer {
  const layer: BackLayer = { state: 'open', marker: null, at: null, onBack }
  open.add(layer)
  queueMicrotask(() => whenQuiet(() => markLayers([layer])))
  return layer
}

/** The layer closed or unmounted. Its marker, if any, is a spare once no
    open layer shares it, and the page steps off a spare over the session's
    first entry (firstEntryStep) once what closed the layer has committed.
    Idempotent. */
export function finishLayer(layer: BackLayer) {
  if (layer.state === 'closed') return
  layer.state = 'closed'
  open.delete(layer)
  if (layer.at !== null) setTimeout(() => win && firstEntryStep(), 0)
}

/** Leaves the page as a phone close does: one step back past its entry and
    its marker, if any. A second one before that step lands adds nothing; a
    step past the document that the person stays from (beforeunload) or that
    keeps it in the back/forward cache (pageshow) no longer counts. */
export function leavePage() {
  if (leaving) return
  leaving = true
  stepping()
  const w = current()
  w.history.go(tokenIn(w.history.state) ? -2 : -1)
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
    it goes by position, and a popstate elsewhere first ends it. Answers
    false, moving nothing, when `to` has no key or position, or is the entry
    the page is on. */
export function returnTo(to: Entry, landed: () => void) {
  const nav = navigationOf(current())
  const key = nav ? to.key : null
  const delta = to.at === null || last.at === null ? 0 : to.at - last.at
  if (nav ? key === null || key === last.key : !delta) return false
  seq += 1
  const step = {
    key,
    at: to.at,
    token: `${LOAD}:return:${seq}`,
    started: false,
    voided: false,
    landed,
  }
  ret = step
  stepping()
  if (!nav || key === null) {
    current().history.go(delta)
    return true
  }
  /** Lands the return that fired no navigate event, so moved nothing. */
  const unmoved = () => {
    if (ret !== step || step.started) return
    ret = null
    landed()
    settleSoon()
  }
  const { committed, finished } = nav.traverseTo(key, { info: step.token })
  // Firefox can reject although the step commits: only the popstate counts
  finished.catch(() => {})
  committed.then(unmoved, unmoved)
  return true
}

/** The app took another move while a return is on its way: the return then
    lands heard. */
export function voidReturn() {
  if (ret) ret.voided = true
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
  stepping()
  current().history.go(delta)
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

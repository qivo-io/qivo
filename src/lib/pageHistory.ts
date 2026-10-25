/* The page's place in this tab's session history, and the few moves the
   page makes in it.

   Every entry's state carries its position as `qivoAt`, stamped by the
   pushState and replaceState wrappers installPageHistory puts in place. A
   phone layer (lib/useMobile) marks its Back step with an entry of its own, a
   *marker*: a copy of the entry below with the same address and
   `qivoLayer` (the layer's token), `qivoDepth` (how many markers up from the
   page's entry) and `qivoPageUrl` (the page's address when the first marker
   went on). A page's entry and the markers over it are its *run*: a Back
   within a run shows the same page.

   A layer that closes without its Back step, as a finished dialog does,
   never moves the history: its marker stays as a *spare*. The next page the
   app opens takes the spare's place (pushPage), the next layer reuses it,
   and a Back that leaves a spare for its own run goes on, in that Back's own
   popstate, to the entry before the page (or to an open layer under it), so
   one Back still leaves the page. Every page-started move happens inside a
   move or tap of the person's own, so a move of the person's can only race
   it within one task, and no move is ever told apart by timing.

   A Back or Forward the app refuses (lib/popRefusal) returns to the entry it
   left with a keyed navigation.traverseTo, which lands there whatever moved
   first and is hidden from every other listener. */

/** A phone layer's place in the history (useMobileBackLayer). */
export type BackLayer = {
  readonly token: string
  /** `deciding` while its onClose runs, so a second close is dropped */
  state: 'open' | 'deciding' | 'closed'
  /** its marker's position, null until the marker is on */
  at: number | null
  readonly onBack: () => unknown
}

type Entry = { at: number | null; state: unknown; url: string }

/* Markers carry the document's load in their token, so the markers of an
   earlier load (after a reload) are spares. */
const LOAD = Math.random().toString(36).slice(2, 8)
let seq = 0

let win: Window | null = null
let push: History['pushState'] | null = null
let replace: History['replaceState'] | null = null
// the current position, the highest one this document reached, and the entry
// the page is on, which the next popstate leaves
let at = 0
let top = 0
let last: Entry = { at: 0, state: null, url: '' }
// open layers by token, and those the last popstate left, top first, for the
// layers' listener (listenBackLayers)
const open = new Map<string, BackLayer>()
let popped: BackLayer[] = []
// the first-entry step on its way (firstEntryStep)
let settling = false
// the refusal's return on its way (returnTo): the key it goes to, the token
// its navigate event carries, whether that event fired, and what it runs
// once landed. `voided` once the app took another move meanwhile.
let ret: {
  key: string
  token: string
  started: boolean
  voided: boolean
  landed: () => void
} | null = null
// from the return's navigate event to the next one: a reload navigate then is
// WebKit's turn of a return the person's move to the same entry merged with
let armed = false
// the key of the entry the last traversal left
let lastFrom: string | null = null
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
/** How many markers up from its page's entry `state` is, 0 for a page entry. */
const depthIn = (state: unknown) => {
  const depth = tokenIn(state) && Reflect.get(record(state)!, 'qivoDepth')
  return typeof depth === 'number' ? depth : 0
}
const withPosition = (state: unknown, index: number) => ({ ...record(state), qivoAt: index })
const navigationOf = (w: Window) => ('navigation' in w ? w.navigation : null)
/** Whether `state` is a marker whose layer is no longer open: a spare. */
const isSpare = (state: unknown) => {
  const token = tokenIn(state)
  return token !== null && !open.has(token)
}
/** The window the page's history is installed on, or this one before then,
    as in a test that renders App alone. */
const current = () => win ?? window

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

/** The page's entry position of the run the marker `left` heads, when the
    move to `state` at `here` went down within that run, else null. */
function runLeft(left: Entry, state: unknown, here: number | null) {
  if (left.at === null || here === null || here >= left.at || !tokenIn(left.state)) return null
  const base = left.at - depthIn(left.state)
  const landed = tokenIn(state) ? here - depthIn(state) === base : here === base
  return landed ? base : null
}

/** The highest open layer whose marker is in [from, to]. */
function openLayerIn(from: number, to: number) {
  let found: BackLayer | null = null
  for (const layer of open.values())
    if (layer.at !== null && layer.at >= from && layer.at <= to && (!found || layer.at > found.at!))
      found = layer
  return found
}

/** Closes the open `layer`: its onBack (its onClose) runs once, and the
    layer closes, its marker now a spare, or answers false and stays open.
    A close while it decides, or after it closed, does nothing. Answers
    whether it closed. */
export function closeLayer(layer: BackLayer) {
  if (layer.state !== 'open') return false
  layer.state = 'deciding'
  const kept = layer.onBack() === false
  // an unmount while it decided has finished it already
  if (!open.has(layer.token)) return true
  if (kept) {
    layer.state = 'open'
    return false
  }
  finishLayer(layer)
  return true
}

/** The page's first popstate listener. It records the move, lands the
    refusal's return unheard, carries an address written in place over a
    marker down to the entry a Back reaches in its run, and goes on from a
    spare. Everything here runs before App reads the address. */
function onPop(event: PopStateEvent) {
  const w = current()
  const left = last
  const state = w.history.state
  const here = positionIn(state)
  if (here !== null) at = here
  last = { at: here, state, url: w.location.href }
  // the open layers this move left, top first (an entry without a position
  // is below them all), for the layers' listener after App's
  popped = [...open.values()]
    .filter((layer) => layer.at !== null && (here === null || layer.at > here))
    .sort((a, b) => b.at! - a.at!)
  if (ret && currentKey() === ret.key) {
    const done = ret
    ret = null
    // unless the app took another move meanwhile (accepted), when this
    // landing is a move like any other
    if (!done.voided) {
      event.stopImmediatePropagation()
      popped = []
      done.landed()
    }
    return settleSoon()
  }
  const firstEntry = settling
  settling = false
  const base = runLeft(left, state, here)
  if (base !== null && w.location.href !== left.url) replace!(state, '', left.url)
  if (base !== null && isSpare(left.state) && !firstEntry && !ret) {
    // a Back from a spare: the same page shows, so it goes on to the open
    // layer under it, which closes, or past the page's entry
    event.stopImmediatePropagation()
    popped = []
    const live = openLayerIn(base + 1, here!)
    if (live?.at === here) closeLayer(live)
    else {
      stepping()
      w.history.go(live ? live.at! - 1 - here! : base - 1 - here!)
    }
  }
  if (firstEntry) settleSoon()
}

/** The layers' popstate listener, which App adds right after its own, so a
    move App refuses never reaches it. Each open layer whose marker the move
    left closes, the top one first; one that answers false stays, and it and
    the layers under it that the move also left get their markers back. */
function onLayersPop() {
  const left = popped
  popped = []
  for (const [n, layer] of left.entries()) {
    if (layer.state !== 'open') continue
    if (closeLayer(layer)) continue
    for (const kept of left
      .slice(n)
      .filter((other) => other.state === 'open')
      .reverse())
      whenQuiet(() => markLayer(kept))
    return
  }
}

/** Puts `layer`'s marker on: it takes the place of a spare the page is on,
    or goes on top of the current entry. */
function markLayer(layer: BackLayer) {
  if (layer.state !== 'open') return
  const w = current()
  const state = w.history.state
  if (isSpare(state)) w.history.replaceState({ ...record(state), qivoLayer: layer.token }, '')
  else
    w.history.pushState(
      {
        ...record(state),
        qivoLayer: layer.token,
        qivoDepth: depthIn(state) + 1,
        qivoPageUrl: tokenIn(state) ? Reflect.get(record(state)!, 'qivoPageUrl') : w.location.href,
      },
      '',
      w.location.href,
    )
  layer.at = at
}

/** The session's first entry under a spare, with no open layer in its run:
    a Back from the spare would have nowhere to go on to, so the page steps
    off the spare now. Exactly one popstate follows, the step's or that of
    the person's Back that came first (the step then goes nowhere). */
function firstEntryStep() {
  const w = current()
  const state = w.history.state
  const depth = depthIn(state)
  if (!isSpare(state) || historyBusy() || openLayerIn(at - depth + 1, at)) return
  const nav = navigationOf(w)
  const first = nav
    ? nav.currentEntry?.index === depth && w.history.length === nav.entries().length
    : w.history.length === depth + 1
  if (!first) return
  settling = true
  stepping()
  w.history.go(-depth)
}

/** Stamps the current entry and every entry the page adds or replaces from
    now on, adds the page's first popstate listener and, with the Navigation
    API, the listeners the refusal's return needs, and steps off a spare the
    page booted on over the session's first entry. Call it before anything
    adds an entry (main.tsx). `target` lets tests pass a browser double.
    Answers a function that removes all of it. */
export function installPageHistory(target: Window = window) {
  const h = target.history
  win = target
  push = h.pushState.bind(h)
  const rawReplace = h.replaceState.bind(h)
  replace = (state, unused, url) => {
    if (stepped && import.meta.env.DEV) console.error('History written right after a page step')
    rawReplace(withPosition(state, at), unused, url)
    last = { at, state: h.state, url: target.location.href }
  }
  at = positionIn(h.state) ?? 0
  top = at
  rawReplace(withPosition(h.state, at), '')
  last = { at, state: h.state, url: target.location.href }
  h.pushState = (state, unused, url) => {
    if (stepped && import.meta.env.DEV) console.error('History written right after a page step')
    at += 1
    top = at
    push!(withPosition(state, at), unused, url)
    last = { at, state: h.state, url: target.location.href }
  }
  h.replaceState = replace
  target.addEventListener('popstate', onPop)
  const nav = navigationOf(target)
  const onNavigate = (event: NavigateEvent) => {
    if (event.navigationType === 'reload' && armed && event.info === undefined) {
      event.preventDefault()
      armed = false
      return
    }
    armed = !!ret && event.info === ret.token
    if (armed && ret) ret.started = true
  }
  const onEntryChange = (event: NavigationCurrentEntryChangeEvent) => {
    if (event.navigationType === 'traverse') lastFrom = event.from?.key ?? null
  }
  nav?.addEventListener('navigate', onNavigate)
  nav?.addEventListener('currententrychange', onEntryChange)
  firstEntryStep()
  return () => {
    for (const key of ['pushState', 'replaceState']) Reflect.deleteProperty(h, key)
    target.removeEventListener('popstate', onPop)
    nav?.removeEventListener('navigate', onNavigate)
    nav?.removeEventListener('currententrychange', onEntryChange)
    win = null
    open.clear()
    popped = []
    settling = false
    ret = null
    armed = false
    lastFrom = null
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

/** How many markers sit over the current entry's page entry, 0 on a page
    entry. */
export const stepsToPage = () => depthIn(current().history.state)

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
    its way. `onBack` runs when a Back leaves its marker or reaches it from a
    spare, and answers false to keep it open. */
export function openLayer(onBack: () => unknown): BackLayer {
  seq += 1
  const layer: BackLayer = { token: `${LOAD}:${seq}`, state: 'open', at: null, onBack }
  open.set(layer.token, layer)
  queueMicrotask(() => whenQuiet(() => markLayer(layer)))
  return layer
}

/** The layer closed or unmounted: its marker, if any, is a spare from now
    on, and the page steps off it when it sits over the session's first
    entry (firstEntryStep), once what closed it has committed. Idempotent. */
export function finishLayer(layer: BackLayer) {
  if (layer.state === 'closed') return
  layer.state = 'closed'
  open.delete(layer.token)
  if (layer.at !== null) setTimeout(() => win && firstEntryStep(), 0)
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

/** Whether a refused move can return by key (the Navigation API). */
export const canReturn = () => !!win && !!navigationOf(win)

/** The key of the entry the last traversal left, the page the app shows
    while a refused move's popstate runs. */
export const lastFromKey = () => lastFrom

/** The current entry's key, null without the Navigation API. */
export const currentKey = () => (win && navigationOf(win)?.currentEntry?.key) ?? null

/** Returns to the entry `key` as the page's own move, which lands there
    whatever moved first and reaches no other listener; then runs `landed`.
    One that cannot start, as when the entry is gone, ends at once: the
    address sync then writes the page's address back. */
export function returnTo(key: string, landed: () => void) {
  const nav = navigationOf(current())!
  seq += 1
  const step = { key, token: `${LOAD}:return:${seq}`, started: false, voided: false, landed }
  ret = step
  stepping()
  const { committed, finished } = nav.traverseTo(key, { info: step.token })
  // Firefox can reject although the step commits: only the popstate counts
  finished.catch(() => {})
  committed.catch(() => {
    if (ret !== step || step.started) return
    ret = null
    landed()
    settleSoon()
  })
}

/** The app took another move while a return is on its way: the return then
    lands heard. */
export function voidReturn() {
  if (ret) ret.voided = true
}

/** Whether the refusal's return is on its way. */
export const returning = () => !!ret

/** Moves to the entry `key` as the person's own move, heard: Discard taking
    a refused move again. Nothing when that entry is gone or current. */
export function goToKey(key: string) {
  const nav = navigationOf(current())
  const here = nav?.currentEntry?.index
  const to = nav?.entries().findIndex((entry) => entry.key === key) ?? -1
  if (to < 0 || here === undefined || to === here) return
  stepping()
  current().history.go(to - here)
}

/** Reloads the page, past the guard that cancels WebKit's turn of a merged
    return into a reload. Every reload the app starts goes through this. */
export function reloadPage() {
  armed = false
  location.reload()
}

/** Lets the next reload through, as a development server's full reload. */
export function disarmReloadGuard() {
  armed = false
}

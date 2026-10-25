/* Where the page's current entry sits in this tab's session history.

   A popstate cannot be cancelled. When the app refuses a Back or Forward
   (a window holds unsent text, lib/popRefusal), it steps back to the entry
   it left with history.go, which keeps the entries on both sides, and needs
   the direction and distance for that. Every entry's state carries its
   position as `qivoAt`, stamped by the pushState and replaceState wrappers
   that installHistoryIndex puts in place at start. Its own popstate
   listener, the page's first, records each move, also while no view that
   reads it is mounted.

   A move the page starts (history.back, forward or go) lands later, and
   until it does history.state is still the entry the page is leaving, so
   code that reads it to decide a move waits for the page's moves to land
   (afterTraversal). The page's own steps (stepBack), such as a phone layer
   stepping back over its marker (lib/useMobile), are bookkeeping, not the
   person's: this listener ends the popstate that lands where one aimed, so
   no other listener takes it for a Back. A move that lands anywhere else
   first, such as a pick from the browser's Back menu, is the person's: it
   reaches the other listeners. The step still lands after it, since a
   browser counts its distance from the entry the person reached, so the
   page then steps back to that entry, and neither popstate reaches another
   listener. */

let at = 0
let moved: number | null = null
// the page's moves on their way, and what waits for them to land
let traveling = 0
let waiting: (() => void)[] = []
let lost: ReturnType<typeof setTimeout> | undefined
// the page's own step on its way (stepBack): the position it aims for, null
// without the index, and what hears whether it landed there. A move of the
// person's that overtook it marks it `overtaken`, and `stray` until the
// step lands past the person's entry.
let own: {
  to: number | null
  done: (landed: boolean) => void
  overtaken: boolean
  stray: boolean
} | null = null
// the history the index stamps, and its go as the page found it
let stamped: History | null = null
let go: ((delta: number) => void) | null = null

/** How long a move the page started may take to land. One that has not by
    then, such as one past the end of the history, which fires no popstate,
    stops counting, so nothing waits for it for good, and a step of the
    page's own ends as not landed. */
const LOST_MS = 1000

/** The position `state` carries, or null. */
const positionIn = (state: unknown) => {
  const to = state !== null && typeof state === 'object' ? Reflect.get(state, 'qivoAt') : null
  return typeof to === 'number' ? to : null
}

/** The state `state` with the position `index` added. */
const withPosition = (state: unknown, index: number) => ({
  ...(state !== null && typeof state === 'object' ? state : {}),
  qivoAt: index,
})

/** Runs what waits for the page's moves, once none is on its way. */
function release() {
  if (traveling) return
  const ready = waiting
  waiting = []
  for (const fn of ready) fn()
}

/** Counts a move the page starts. */
function started() {
  traveling += 1
  clearTimeout(lost)
  lost = setTimeout(() => {
    traveling = 0
    const step = own
    own = null
    step?.done(false)
    release()
  }, LOST_MS)
}

/** Moves `delta` entries as the page's own move, counted. */
function travel(delta: number) {
  started()
  ;(go ?? ((by: number) => history.go(by)))(delta)
}

/** Records the move a popstate made. One that lands where the page's own
    step aimed ends that step and its popstate. Any other is the person's
    and reaches the other listeners, and a step it overtook, which lands
    past it next, steps back to the person's entry, unheard. */
function record(event: PopStateEvent) {
  const from = at
  const to = positionIn((stamped ?? history).state)
  const step = own
  // the page counts itself on the entry its own step aims for
  moved = to === null ? null : to - (step?.to ?? at)
  if (to !== null) at = to
  if (step && !step.stray && step.to !== null && to !== null && to !== step.to) {
    // the person's move, and the step, still on its way, lands next
    step.overtaken = true
    step.stray = true
    return
  }
  if (traveling) traveling -= 1
  if (!traveling) clearTimeout(lost)
  if (step?.stray && to !== null && to !== from) {
    event.stopImmediatePropagation()
    step.stray = false
    step.to = from
    travel(from - to)
    return
  }
  own = null
  // without the index the step's aim is unknown, and the next popstate is its own
  const landed = !!step && (step.to === null || step.to === to)
  if (landed) event.stopImmediatePropagation()
  step?.done(landed && !step.overtaken)
  // what waits runs once the other listeners have had this popstate
  if (!traveling && waiting.length) setTimeout(release, 0)
}

/** Stamps the current entry and every entry the page adds or replaces from
    now on, records each popstate's move and counts the page's moves on
    their way. Answers a function that removes the wrappers and the
    listener. */
export function installHistoryIndex(win: Window = window) {
  const h = win.history
  const push = h.pushState.bind(h)
  const replace = h.replaceState.bind(h)
  const back = h.back.bind(h)
  const forward = h.forward.bind(h)
  const travel = h.go.bind(h)
  at = positionIn(h.state) ?? 0
  replace(withPosition(h.state, at), '')
  h.pushState = (state, unused, url) => {
    at += 1
    push(withPosition(state, at), unused, url)
  }
  h.replaceState = (state, unused, url) => replace(withPosition(state, at), unused, url)
  h.back = () => {
    started()
    back()
  }
  h.forward = () => {
    started()
    forward()
  }
  // go(0) reloads the page, which lands nowhere
  h.go = (delta) => {
    if (delta) started()
    travel(delta)
  }
  stamped = h
  go = travel
  win.addEventListener('popstate', record)
  return () => {
    for (const key of ['pushState', 'replaceState', 'back', 'forward', 'go'])
      Reflect.deleteProperty(h, key)
    win.removeEventListener('popstate', record)
    clearTimeout(lost)
    traveling = 0
    waiting = []
    own = null
    stamped = null
    go = null
  }
}

/** For a popstate listener: how many entries this popstate moved, negative
    for Back, or null for an entry without a position, such as one a page
    before this one added. A move that overtook the page's own step counts
    from the entry that step aims for. */
export const lastStep = () => moved

/** The current entry's position. */
export const position = () => at

/** Runs `fn` once the page's moves on their way have landed, at once when
    none is. */
export function afterTraversal(fn: () => void) {
  if (traveling) waiting.push(fn)
  else fn()
}

/** Steps `distance` entries back as the page's own move. The index records
    it, and the popstate that lands where it aimed reaches no other
    listener. A move that lands elsewhere first, such as a pick from the
    browser's Back menu, is the person's and reaches them. The step then
    lands past it, and the page steps back to the person's entry; neither
    popstate reaches another listener. Without the index installed, as in a
    test of one component, the others still hear it, and the next popstate
    ends it. Resolves once that is done or the step is lost (LOST_MS), with
    whether it landed where it aimed. */
export function stepBack(distance: number): Promise<boolean> {
  return new Promise((resolve) => {
    own = { to: stamped ? at - distance : null, done: resolve, overtaken: false, stray: false }
    if (!stamped) window.addEventListener('popstate', record, { once: true })
    travel(-distance)
  })
}

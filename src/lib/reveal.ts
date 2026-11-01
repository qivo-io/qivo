import { type RefObject, useEffect, useRef } from 'react'
import { useLatest } from './useLatest'

/** How long a revealed task keeps its ring, on the Roadmap and the Board. */
export const REVEAL_MS = 2400

/** A request to show one task: `n` is a nonce, so asking again for the
    same task reveals it again. `atOnce` says the jump opens no task window
    over the pane (the crumb on a phone closes it), so the ring's time runs
    from the start and no later window holds it. */
export type RevealRequest = { id: string; n: number; atOnce?: boolean }

/** The state update for a request that a view took, given its nonce `n`:
    it drops the request unless a newer one replaced it, which a kept view
    shown again with a request it held (components/KeptView) must leave. */
export const withoutTaken =
  (n: number) =>
  <R extends { n: number }>(request: R | null) =>
    request?.n === n ? null : request

const ROWS = '[data-card], [data-parent-heading]'

/** The element that shows task `id` in `pane` and takes the ring: a card
    of its own, or the row of a task that shares its card with a parent
    heading or siblings. A parent task rings the first card under its
    heading. Values are compared, not put in a selector, so any id works. */
export function revealTarget(pane: ParentNode, id: string): HTMLElement | null {
  const row = [...pane.querySelectorAll<HTMLElement>(ROWS)].find(
    (element) => (element.dataset.card ?? element.dataset.parentHeading) === id,
  )
  if (!row) return null
  const card = row.closest<HTMLElement>('.board-card')
  if (!card) return row
  const parent = row.dataset.card === undefined
  return parent || card.querySelectorAll(ROWS).length === 1 ? card : row
}

/** Where `pane` scrolls to put `target` in its middle, and to bring it
    into view across when it is not. A target taller than half the pane
    keeps its top a quarter down the pane, so its start shows. */
function placeOf(pane: HTMLElement, target: HTMLElement) {
  const view = pane.getBoundingClientRect()
  const box = target.getBoundingClientRect()
  const middle =
    box.height > pane.clientHeight / 2
      ? box.top - view.top - pane.clientHeight / 4
      : box.top + box.height / 2 - view.top - pane.clientHeight / 2
  const across =
    box.left < view.left || box.right > view.left + pane.clientWidth
      ? box.left + box.width / 2 - view.left - pane.clientWidth / 2
      : 0
  const clamp = (value: number, most: number) => Math.max(0, Math.min(most, value))
  return {
    top: clamp(pane.scrollTop + middle, pane.scrollHeight - pane.clientHeight),
    left: clamp(pane.scrollLeft + across, pane.scrollWidth - pane.clientWidth),
  }
}

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Shows the task a request names in the list `pane` holds, and rings it
    with `data-board-revealed` for REVEAL_MS of the time the pane is in
    view: while a task window over it makes it inert, the ring waits, so it
    still shows when the window closes (unless the request is `atOnce`), on the task's card wherever a
    change made meanwhile moved it. `mount` mounts the task's card
    first when its list still waits for it; it may commit a render. Two
    frames later the pane scrolls the card to its middle, smoothly unless
    reduced motion is on or the card is more than two screens away, and
    corrects once where cards that rendered meanwhile moved it. Scrolling
    yields to the person: a wheel, touch, press or key stops the
    correction. `onConsumed` gets the request's nonce as soon as it is taken. A
    request is taken once: a view that shows again (KeptView) runs its
    effects again, and may still hold a request it took before it hid.
    Nothing happens when the pane does not show the task, or when `drop`
    says the view shows a message in place of its tasks: the request is
    taken all the same, so no other view takes it later. */
export function useReveal(
  request: RevealRequest | null | undefined,
  onConsumed: ((n: number) => void) | undefined,
  pane: RefObject<HTMLElement | null>,
  mount: (id: string) => void,
  drop = false,
) {
  const consumed = useLatest((n: number) => onConsumed?.(n))
  const mountTask = useLatest(mount)
  // the running reveal's cancel; consuming the request must not stop it
  const cancel = useRef(() => {})
  const taken = useRef<number | null>(null)
  useEffect(() => () => cancel.current(), [])
  useEffect(() => {
    if (!request || request.n === taken.current) return
    taken.current = request.n
    cancel.current()
    consumed(request.n)
    if (drop) return
    const frames: number[] = []
    let timer = 0
    let ringed: HTMLElement | null = null
    let stopCorrection = () => {}
    let inertWatch: MutationObserver | null = null
    cancel.current = () => {
      for (const frame of frames) cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      stopCorrection()
      inertWatch?.disconnect()
      ringed?.removeAttribute('data-board-revealed')
    }
    frames.push(
      requestAnimationFrame(() => {
        // a render now, outside React's commit
        mountTask(request.id)
        frames.push(
          requestAnimationFrame(() => {
            const scroller = pane.current
            const target = scroller && revealTarget(scroller, request.id)
            if (!scroller || !target) return
            const place = placeOf(scroller, target)
            const far = Math.abs(place.top - scroller.scrollTop) > scroller.clientHeight * 2
            const behavior = reducedMotion() || far ? 'instant' : 'smooth'
            scroller.scrollTo({ ...place, behavior })
            ringed = target
            target.setAttribute('data-board-revealed', '')
            /* The ring's time runs once the pane is out from under the
               window the jump opened: while it is inert the ring waits, and
               when it comes back, later windows (another task opened
               meanwhile) no longer hold it. A change made in that window
               can move the task to another cell, a new card, so the ring
               and the scroll follow it. */
            let phase: 'start' | 'held' | 'released' = 'start'
            const ring = () => {
              timer = window.setTimeout(() => {
                inertWatch?.disconnect()
                ringed?.removeAttribute('data-board-revealed')
                ringed = null
              }, REVEAL_MS)
            }
            const time = () => {
              if (phase === 'released') return
              if (scroller.closest('[inert]')) {
                if (phase === 'start') {
                  window.clearTimeout(timer)
                  phase = 'held'
                }
                return
              }
              if (phase === 'start') {
                if (!timer) ring()
                return
              }
              phase = 'released'
              if (ringed && !ringed.isConnected) {
                mountTask(request.id)
                ringed = revealTarget(scroller, request.id)
                if (ringed) {
                  ringed.setAttribute('data-board-revealed', '')
                  scroller.scrollTo({ ...placeOf(scroller, ringed), behavior: 'instant' })
                }
              }
              ring()
            }
            if (request.atOnce) ring()
            else {
              if (typeof MutationObserver === 'function') {
                inertWatch = new MutationObserver(time)
                inertWatch.observe(document.body, {
                  attributes: true,
                  attributeFilter: ['inert'],
                  subtree: true,
                })
              }
              time()
            }
            stopCorrection = correctOnce(scroller, target, behavior === 'smooth')
          }),
        )
      }),
    )
    // a request is new when its nonce is
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.n])
}

/** Puts `target` back in the middle of `pane` once the scroll ends, when
    cards that rendered during it moved it, unless the person scrolls or
    acts first. A smooth scroll ends on scrollend, or after a second at
    most; an instant one after two frames. Returns the cancel. */
function correctOnce(pane: HTMLElement, target: HTMLElement, smooth: boolean) {
  let frame = 0
  let timer = 0
  const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
  const stop = () => {
    cancelAnimationFrame(frame)
    window.clearTimeout(timer)
    pane.removeEventListener('scrollend', correct)
    for (const name of inputs) window.removeEventListener(name, stop, true)
  }
  function correct() {
    stop()
    if (!target.isConnected) return
    const place = placeOf(pane, target)
    if (Math.abs(place.top - pane.scrollTop) > 1 || Math.abs(place.left - pane.scrollLeft) > 1)
      pane.scrollTo({ ...place, behavior: 'instant' })
  }
  for (const name of inputs) window.addEventListener(name, stop, { capture: true, passive: true })
  if (smooth) {
    pane.addEventListener('scrollend', correct)
    timer = window.setTimeout(correct, 1000)
  } else
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(correct)
    })
  return stop
}

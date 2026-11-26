/* A change to the page between a pointer's press and its click moves what
   was under the pointer, so the click can land elsewhere than the press and
   miss the control the person pressed. What the page shows in answer to a
   press, such as a line under a field the press took focus from, waits
   here until the press is over. Only what is shown waits: a write that the
   press sets off goes at once.

   A press lasts from the primary pointer's pointerdown until its click has
   been delivered. A tap's compatibility mouse events, among them the
   mousedown that moves focus, come after its pointerup, so where no click
   follows the press ends CLICK_WAIT_MS after the pointerup. A pointer held
   down has no time limit. A release the page never hears is noticed by the
   next event of that pointer with no button down, the window losing focus
   or the page being hidden. */

import { useLayoutEffect, useRef, useState } from 'react'

/** How long a press lasts after its pointerup where no click follows. */
export const CLICK_WAIT_MS = 600

/** The primary pointer that is down, by pointer type. */
const down = new Map<string, number>()
let released: ReturnType<typeof setTimeout> | undefined
const waiting = new Set<() => void>()

/** Whether a press is going on. */
export function pressing() {
  return down.size > 0 || released !== undefined
}

function end() {
  clearTimeout(released)
  released = undefined
  down.clear()
  for (const work of waiting) {
    waiting.delete(work)
    work()
  }
}

function endAfter(ms: number) {
  clearTimeout(released)
  released = setTimeout(end, ms)
}

if (typeof window !== 'undefined') {
  const listen = { capture: true, passive: true }
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isPrimary || e.button !== 0) return
      clearTimeout(released)
      released = undefined
      down.set(e.pointerType, e.pointerId)
    },
    listen,
  )
  window.addEventListener(
    'pointerup',
    (e) => {
      if (down.get(e.pointerType) !== e.pointerId) return
      down.delete(e.pointerType)
      if (down.size === 0) endAfter(CLICK_WAIT_MS)
    },
    listen,
  )
  window.addEventListener(
    'pointercancel',
    (e) => {
      if (down.get(e.pointerType) !== e.pointerId) return
      down.delete(e.pointerType)
      if (down.size === 0) endAfter(0)
    },
    listen,
  )
  for (const type of ['pointermove', 'pointerover'] as const)
    window.addEventListener(
      type,
      (e) => {
        if (e.buttons !== 0 || !down.has(e.pointerType)) return
        down.delete(e.pointerType)
        if (down.size === 0 && released === undefined) end()
      },
      listen,
    )
  // the click's own handlers run first, in the task that dispatches it
  window.addEventListener(
    'click',
    () => {
      if (down.size === 0 && released !== undefined) endAfter(0)
    },
    listen,
  )
  window.addEventListener('blur', (e) => {
    if (e.target === e.currentTarget && pressing()) end()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pressing()) end()
  })
}

/**
 * Runs `work` now where no press is going on, else once the press is over.
 * Returns a function that drops `work` while it waits.
 */
export function afterPress(work: () => void): () => void {
  if (!pressing()) {
    work()
    return () => {}
  }
  const once = () => work()
  waiting.add(once)
  return () => {
    waiting.delete(once)
  }
}

/**
 * `value` as the page shows it: a change during a press shows once the
 * press is over, and any other change at once.
 */
export function useAfterPress<T>(value: T): T {
  const [shown, setShown] = useState(value)
  const latest = useRef(value)
  latest.current = value
  const changed = !Object.is(value, shown)
  useLayoutEffect(() => {
    if (changed) return afterPress(() => setShown(() => latest.current))
  }, [changed])
  return changed && pressing() ? shown : value
}

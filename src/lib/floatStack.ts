import { useSyncExternalStore } from 'react'

/* The fixed column that holds the floating notices and the toasts.

   Each layer portals into its own slot of one column, so they stack instead
   of covering each other. On a desktop the column sits at the bottom with the
   toasts on top, then the app update notice, then the snapshot notice. On a
   phone the notices sit at the top and the toasts above the tab bar. The
   column centers on the workspace content column, the axis of the page
   header (styles/float-stack.css).

   The notices stay until what they report ends, so the page makes room for
   them instead of sliding under them. The column measures the band the
   notices take at the top or bottom of the window and publishes it as
   --float-inset-top and --float-inset-bottom on <html>. Every layout that
   fills the window leaves those bands free, and so does the landscape phone
   Roadmap through useFloatInsets. Toasts pass on their own, so they take no
   room.

   The column is a [data-top-layer] child of <body>, so modal layers leave it
   exposed and usable (lib/useHideOthers, the task window's inert siblings). */

const SLOTS = ['toasts', 'update', 'snapshot'] as const
export type FloatSlot = (typeof SLOTS)[number]

/** The bands of the window the notices take, in CSS pixels. */
export type FloatInsets = { top: number; bottom: number }

const NONE: FloatInsets = { top: 0, bottom: 0 }
let insets = NONE
const listeners = new Set<() => void>()

/** The band the notices take at the top or bottom of a window `height`
    high, given the box of their slots (empty when there are none). A
    notice at the top takes the window down to its box's bottom, one at the
    bottom from its box's top, and the slots hold the notices' margins.
    Neither band takes more than half the window, so the page never
    disappears behind notices that do not fit. */
export function noticeInsets(box: { top: number; bottom: number } | null, height: number) {
  if (!box || box.bottom <= box.top) return NONE
  const cap = (value: number) => Math.round(Math.min(Math.max(0, value), height / 2))
  return box.top + box.bottom < height
    ? { top: cap(box.bottom), bottom: 0 }
    : { top: 0, bottom: cap(height - box.top) }
}

/** The part of `view`, a box of the visible viewport in window
    coordinates, that the notices leave free in a window `height` high. The
    notices stay put in the window, so once the visible viewport has panned
    past a band (a phone's keyboard can do that), the band takes nothing. */
export function roomBeside(
  view: { top: number; height: number },
  band: FloatInsets,
  height: number,
): { top: number; height: number } {
  const top = Math.max(view.top, band.top)
  const bottom = Math.min(view.top + view.height, height - band.bottom)
  return { top, height: Math.max(0, bottom - top) }
}

/** Measures the notices and publishes their bands when they changed. */
function measure(stack: HTMLElement) {
  const boxes = [
    ...stack.querySelectorAll<HTMLElement>('[data-float-slot]:not([data-float-slot="toasts"])'),
  ]
    .map((slot) => slot.getBoundingClientRect())
    .filter((rect) => rect.height > 0)
  const box = boxes.length
    ? { top: Math.min(...boxes.map((b) => b.top)), bottom: Math.max(...boxes.map((b) => b.bottom)) }
    : null
  const next = noticeInsets(box, window.innerHeight)
  if (next.top === insets.top && next.bottom === insets.bottom) return
  insets = next
  const root = document.documentElement.style
  root.setProperty('--float-inset-top', `${next.top}px`)
  root.setProperty('--float-inset-bottom', `${next.bottom}px`)
  for (const listener of listeners) listener()
}

/** The element a floating layer portals into. Creates the column on first
    use, and starts measuring the notices' bands. */
export function floatSlot(slot: FloatSlot): HTMLElement {
  let stack = document.querySelector<HTMLElement>('body > [data-float-stack]')
  if (!stack) {
    const column = document.createElement('div')
    column.className = 'float-stack'
    column.setAttribute('data-float-stack', '')
    column.setAttribute('data-top-layer', '')
    for (const name of SLOTS) {
      const element = document.createElement('div')
      element.setAttribute('data-float-slot', name)
      column.append(element)
    }
    document.body.append(column)
    // A slot changes size when a notice comes, goes or reflows, and the
    // window decides which edge the column puts the notices on.
    const observer = new ResizeObserver(() => measure(column))
    for (const element of column.children) observer.observe(element)
    window.addEventListener('resize', () => measure(column))
    stack = column
  }
  const element = stack.querySelector<HTMLElement>(`[data-float-slot="${slot}"]`)
  if (!element) throw new Error(`The floating column has no ${slot} slot`)
  return element
}

/** The bands the notices take now (see floatSlot). */
export function useFloatInsets(): FloatInsets {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => insets,
  )
}

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
   room, except a sticky one ([data-float-sticky], the notice of an edit the
   server refused), which stays until the person closes it and takes a band
   of its own. The two notice slots share one box that takes at most half
   the window and scrolls inside, so notices that do not fit there never
   cover the page beyond its band.

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
    past a band (a phone's keyboard can do that), the band takes nothing.
    Without a bottom band the visible viewport's own bottom holds, whatever
    `height` a browser reports while its keyboard is open. */
export function roomBeside(
  view: { top: number; height: number },
  band: FloatInsets,
  height: number,
): { top: number; height: number } {
  const top = Math.max(view.top, band.top)
  const end = view.top + view.height
  const bottom = band.bottom ? Math.min(end, height - band.bottom) : end
  return { top, height: Math.max(0, bottom - top) }
}

/* The box of the notices: their shared box, which holds the notices with
   their margins and stays put while they scroll inside. While they fit, its
   padding only keeps their shadows and is left out. Once they overflow they
   show through the padding, so it counts too. Without a laid-out box
   (jsdom) the slots count. */
function noticesBox(stack: HTMLElement): { top: number; bottom: number } | null {
  const notices = stack.querySelector<HTMLElement>('[data-float-notices]')
  const shown = notices?.getBoundingClientRect()
  if (notices && shown?.height) {
    const style = getComputedStyle(notices)
    const overflows = notices.scrollHeight > notices.clientHeight + 1
    const pad = (value: string) => (overflows ? 0 : Number.parseFloat(value) || 0)
    const top = shown.top + pad(style.paddingTop)
    const bottom = shown.bottom - pad(style.paddingBottom)
    return bottom > top ? { top, bottom } : null
  }
  return boxOf(stack, '[data-float-slot]:not([data-float-slot="toasts"])')
}

/* The box around the elements `selector` finds in `stack`, or null. */
function boxOf(stack: HTMLElement, selector: string): { top: number; bottom: number } | null {
  const boxes = [...stack.querySelectorAll<HTMLElement>(selector)]
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.height > 0)
  return boxes.length
    ? { top: Math.min(...boxes.map((b) => b.top)), bottom: Math.max(...boxes.map((b) => b.bottom)) }
    : null
}

/** Measures the notices and publishes their bands when they changed. The
    notices and the sticky toasts are measured apart, because on a phone the
    notices sit at the top and the toasts at the bottom. */
function measure(stack: HTMLElement) {
  const height = window.innerHeight
  const notices = noticeInsets(noticesBox(stack), height)
  const sticky = noticeInsets(boxOf(stack, '[data-float-slot="toasts"] [data-float-sticky]'), height)
  const next = {
    top: Math.max(notices.top, sticky.top),
    bottom: Math.max(notices.bottom, sticky.bottom),
  }
  if (next.top === insets.top && next.bottom === insets.bottom) return
  insets = next
  const root = document.documentElement.style
  root.setProperty('--float-inset-top', `${next.top}px`)
  root.setProperty('--float-inset-bottom', `${next.bottom}px`)
  for (const listener of listeners) listener()
}

/* The column this module instance measures. A hot update in development
   loads a new instance, which measures the column it finds as well; the
   instance it replaced writes the same bands until the page reloads. */
let measured: HTMLElement | null = null

/** Measures `column`'s notices from now on. A slot changes size when a
    notice comes, goes or reflows, and the window decides which edge the
    column puts the notices on. */
function watch(column: HTMLElement) {
  measured = column
  const observer = new ResizeObserver(() => measure(column))
  // the slots too: the notices' box stops growing once they overflow it
  for (const element of column.querySelectorAll('[data-float-slot], [data-float-notices]'))
    observer.observe(element)
  window.addEventListener('resize', () => measure(column))
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
    const notices = document.createElement('div')
    notices.setAttribute('data-float-notices', '')
    // An open dialog's scroll lock cancels wheel and touch moves outside it
    // where they reach the document. The notices scroll on their own, so
    // those moves stop here and the page behind stays put (float-stack.css).
    for (const type of ['wheel', 'touchmove'])
      notices.addEventListener(type, (event) => event.stopPropagation(), { passive: true })
    for (const name of SLOTS) {
      const element = document.createElement('div')
      element.setAttribute('data-float-slot', name)
      ;(name === 'toasts' ? column : notices).append(element)
    }
    column.append(notices)
    document.body.append(column)
    stack = column
  }
  if (measured !== stack) watch(stack)
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

import { act } from 'react'
import { vi } from 'vitest'

/* For tests of a window's closing render (lib/closingWords.ts). jsdom
   applies no stylesheet, so Radix's Presence sees no exit animation and
   unmounts a closed dialog, popover or menu at once. */

// the dialog, alert dialog and popover parts that animate as they close
const ANIMATED = '[data-slot$="-content"], [data-slot$="-overlay"]'

/** Makes the animated window parts report the animations a browser plays,
    `enter` while open and `exit` once closed, so a closed window stays in
    the document until endClosing. Undo with vi.restoreAllMocks() and
    vi.unstubAllGlobals(). */
export function playClosingAnimations() {
  // Presence matches an animation's name through CSS.escape, which jsdom lacks
  if (!globalThis.CSS?.escape) vi.stubGlobal('CSS', { escape: (value: string) => value })
  const computed = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    if (!element.matches(ANIMATED)) return computed(element, pseudo)
    // live, as the browser's is: Presence keeps the style it read on mount
    return new Proxy(computed(element, pseudo), {
      get: (style, key) =>
        key === 'animationName'
          ? element.getAttribute('data-state') === 'closed'
            ? 'exit'
            : 'enter'
          : Reflect.get(style, key, style),
    })
  })
}

/** Ends the exit animation of every closing window part, as the browser
    does once it has played, and waits for the timer in which Radix then
    gives focus back. */
export async function endClosing() {
  await act(async () => {
    for (const element of document.querySelectorAll(ANIMATED))
      if (element.getAttribute('data-state') === 'closed')
        element.dispatchEvent(Object.assign(new Event('animationend'), { animationName: 'exit' }))
  })
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

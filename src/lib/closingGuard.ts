import type { DOMAttributes, SyntheticEvent } from 'react'

/* Radix keeps a closed dialog, alert dialog, popover or select list on
   screen for its closing animation, marked data-state="closed", and its
   buttons, fields and items still act on a press. The shared contents in
   components/ui take every press on a closing window themselves, so a
   fading window does nothing. */

/** The class that takes the pointer off a closing window's parts. A click,
    a tap or a drop on it lands on the window's own box, which does nothing,
    rather than on a part or on the page beneath, and nothing in it
    hovers. */
export const CLOSING_INERT = 'data-[state=closed]:*:pointer-events-none'

type Presses<T> = Pick<DOMAttributes<T>, 'onClickCapture' | 'onKeyDownCapture'>

/** Cancels an event inside a closing window's content and says whether it
    did. An event from a window that only the React tree nests in it, such
    as a list opened from it, belongs to that window. */
function taken(event: SyntheticEvent<Element>) {
  const content = event.currentTarget
  if (content.getAttribute('data-state') !== 'closed') return false
  if (!(event.target instanceof Node) || !content.contains(event.target)) return false
  event.preventDefault()
  event.stopPropagation()
  return true
}

/** A window content's capture handlers, with the caller's own. While the
    window closes they take every click in it (a press, Enter or Space on a
    button, an assistive tool's activation) and every key but Escape, which
    Radix's close answers as before. */
export function closingGuard<T extends Element>({
  onClickCapture,
  onKeyDownCapture,
}: Presses<T>): Presses<T> {
  return {
    onClickCapture: (event) => {
      if (!taken(event)) onClickCapture?.(event)
    },
    onKeyDownCapture: (event) => {
      if (event.key === 'Escape' || !taken(event)) onKeyDownCapture?.(event)
    },
  }
}

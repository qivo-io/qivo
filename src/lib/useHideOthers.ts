import { hideOthers } from 'aria-hidden'
import { type RefObject, useEffect, useLayoutEffect, useState } from 'react'

/** Hides everything outside `ref`'s element from assistive technology while
    `active`, the way Radix modal layers do. Use it in place of
    aria-modal="true", which would also silence the announcer (lib/announce).

    Live regions, [data-top-layer] chrome and the elements matching `keep`
    stay exposed, including ones already open when the hiding starts. Layers
    opened later stay exposed too.

    With `whileFocusInside`, the page is hidden only while focus is inside the
    element or a kept layer, as browsers apply aria-modal. Use it for a window
    that does not move focus into itself, so focus never sits in hidden
    content. */
export function useHideOthers(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  { keep, whileFocusInside = false }: { keep?: string; whileFocusInside?: boolean } = {},
) {
  const [focusInside, setFocusInside] = useState(false)
  useEffect(() => {
    if (!active || !whileFocusInside) return
    // a kept layer such as a focus window opened from the element counts too
    const inside = (node: EventTarget | null) =>
      node instanceof Node &&
      (!!ref.current?.contains(node) || (!!keep && node instanceof Element && !!node.closest(keep)))
    setFocusInside(inside(document.activeElement))
    const onFocusIn = (event: FocusEvent) => setFocusInside(inside(event.target))
    // relatedTarget is where focus goes next, null when it falls to <body>
    const onFocusOut = (event: FocusEvent) => setFocusInside(inside(event.relatedTarget))
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [ref, active, whileFocusInside, keep])

  const hiding = active && (!whileFocusInside || focusInside)
  useLayoutEffect(() => {
    const element = ref.current
    if (!hiding || !element) return
    const kept = document.querySelectorAll<HTMLElement>(
      keep ? `[data-top-layer], ${keep}` : '[data-top-layer]',
    )
    return hideOthers([element, ...kept])
  }, [ref, hiding, keep])
}

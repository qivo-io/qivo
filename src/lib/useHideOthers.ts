import { hideOthers } from 'aria-hidden'
import { type RefObject, useLayoutEffect } from 'react'

/** Hides everything outside `ref`'s element from assistive technology while
    `active`, the way Radix modal layers do. Use it in place of
    aria-modal="true", which would also silence the announcer (lib/announce).
    Live regions and [data-top-layer] chrome stay exposed, including ones
    already open when the hiding starts, and so do layers opened later. */
export function useHideOthers(ref: RefObject<HTMLElement | null>, active: boolean) {
  useLayoutEffect(() => {
    const element = ref.current
    if (!active || !element) return
    return hideOthers([element, ...document.querySelectorAll<HTMLElement>('[data-top-layer]')])
  }, [ref, active])
}

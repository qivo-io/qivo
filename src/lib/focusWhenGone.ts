import { type RefObject, useLayoutEffect, useRef } from 'react'
import { restoreFocus } from './focusVisibility'

/** Gives focus to `target()` when a control leaves the page (`shown` turns
    false) while focus is nowhere, as when a dialog gave focus back to its
    button before the change it asked for arrived and took that button
    away. Focus that has moved on stays where it is, and a control that
    never showed moves nothing. While the content of `dialog` is on screen,
    as it waits or fades, its own close gives focus instead: a button it
    disabled leaves focus nowhere then too. */
export function useFocusWhenGone(
  shown: boolean,
  target: () => HTMLElement | null,
  dialog?: RefObject<HTMLElement | null>,
) {
  const was = useRef(shown)
  useLayoutEffect(() => {
    const before = was.current
    was.current = shown
    if (!before || shown || dialog?.current?.isConnected) return
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    restoreFocus(target())
  }, [shown])
}

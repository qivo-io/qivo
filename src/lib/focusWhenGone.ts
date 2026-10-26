import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { restoreFocus } from './focusVisibility'
import { OUT_OF_USE } from './viewHidden'

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

/** Whether focus is nowhere: on the page itself, or on an element that
    has left it. */
const focusIsNowhere = () => {
  const active = document.activeElement
  return !active || active === document.body || !active.isConnected
}

/** A focus move for the render of a change about to be made. Call the
    answer with `target` as the change starts. Once the calling component
    has rendered it, `target()` takes focus if focus is nowhere, as when the
    change took away the control that held it, or a write that disabled it
    has ended. Focus that has moved on stays where it is. */
export function useFocusAfterRender() {
  const pending = useRef<(() => HTMLElement | null) | null>(null)
  const [, rendered] = useState(0)
  useLayoutEffect(() => {
    const target = pending.current
    pending.current = null
    if (target && focusIsNowhere()) restoreFocus(target())
  })
  return (target: () => HTMLElement | null) => {
    pending.current = target
    rendered((n) => n + 1)
  }
}

/** Where focus goes once the row `id` of a list may have left: `pick` of
    that row while it is listed, else of the next row with one, else of the
    nearest row before it, else `rest()`. Rows carry their id in the
    attribute `attr`. Their order is read now, while the row is listed, so
    call this when the action starts, and the answer when focus moves. An
    element that is not in the page does not count, and neither does a row
    in a kept view hidden behind another page (OUT_OF_USE). */
export function focusAround(
  attr: string,
  id: string,
  pick: (row: HTMLElement) => HTMLElement | null | undefined,
  rest: () => HTMLElement | null | undefined = () => null,
): () => HTMLElement | null {
  const rows = () =>
    [...document.querySelectorAll<HTMLElement>(`[${attr}]`)].filter(
      (row) => !row.closest(OUT_OF_USE),
    )
  const ids = rows().map((row) => row.getAttribute(attr))
  const at = ids.indexOf(id)
  const order = at < 0 ? [id] : [id, ...ids.slice(at + 1), ...ids.slice(0, at).reverse()]
  const usable = (element: HTMLElement | null | undefined) =>
    element?.isConnected ? element : null
  return () => {
    const shown = rows()
    for (const key of order) {
      const row = shown.find((element) => element.getAttribute(attr) === key)
      const target = row && usable(pick(row))
      if (target) return target
    }
    return usable(rest())
  }
}

/** The button that opened the menu `row` is in, read while the menu is
    open. A row that opens a window gives the window this to focus as it
    closes, because the row leaves with the menu. Both kinds of Popover
    (components/qivo) name their open content in the trigger's
    aria-controls. */
export function menuTrigger(row: Element): HTMLElement | null {
  const id = row.closest('[role="dialog"]')?.id
  if (!id) return null
  return (
    [...document.querySelectorAll<HTMLElement>('[aria-controls]')].find(
      (element) => element.getAttribute('aria-controls') === id,
    ) ?? null
  )
}

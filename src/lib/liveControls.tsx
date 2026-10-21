import {
  createContext,
  type PointerEvent,
  type RefObject,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { lastInputWasPointer } from './focusVisibility'
import { markTaskFocus, type TaskFocusMark } from './taskFocus'
import { useLatest } from './useLatest'

/* Static controls for long lists. A row in a static scope renders today's
   DOM but mounts no Radix tooltip or popover roots: HoverTooltip clones its
   child and Popover renders a plain trigger. The row goes live, for good,
   when a mouse points at it, keyboard focus enters it, or someone presses
   one of its popover triggers. A live row renders the full controls. */

/** What a static scope's controls call to make their row live. A popover
    trigger passes its `[data-popover-wrap]`, so the live trigger opens. */
export type StaticControls = { activate: (wrap?: HTMLElement | null) => void }

/** Null (the default) means live, so controls outside a static row are
    unchanged. */
export const StaticControlsContext = createContext<StaticControls | null>(null)

/** The static scope the calling control is in, or null when it is live. */
export function useStaticControls() {
  return useContext(StaticControlsContext)
}

const ROWS = '[data-card], [data-parent-heading]'

/** The control `mark` names among the rows `root` holds. */
function markedControl(root: HTMLElement, mark: TaskFocusMark) {
  for (const row of root.querySelectorAll<HTMLElement>(ROWS)) {
    if ((row.dataset.card ?? row.dataset.parentHeading) !== mark.taskId) continue
    const control = [row, ...row.querySelectorAll<HTMLElement>('[data-focus-key]')].find(
      (element) => element.dataset.focusKey === mark.control,
    )
    if (control) return control
  }
  return null
}

/** Keeps the row `root` points at static until it is used. Spread
    `rootProps` on the row's element and provide `value` through
    StaticControlsContext around its controls. Going live remounts the
    controls that carry a tooltip or a popover, so focus on one of them is
    put back on the same control, and a press on a popover trigger opens
    the live trigger's popover. */
export function useLiveControls(root: RefObject<HTMLElement | null>) {
  const [live, setLive] = useState(false)
  // what to restore once the live controls are in
  const handover = useRef<{ focus: TaskFocusMark | null; wrap: number } | null>(null)
  const activate = useLatest((wrap?: HTMLElement | null) => {
    const element = root.current
    if (!element || handover.current) return
    const active = document.activeElement
    handover.current = {
      focus: active && element.contains(active) ? markTaskFocus(active) : null,
      wrap: wrap ? [...element.querySelectorAll('[data-popover-wrap]')].indexOf(wrap) : -1,
    }
    setLive(true)
  })
  useLayoutEffect(() => {
    const next = handover.current
    const element = root.current
    handover.current = null
    if (!live || !next || !element) return
    if (next.focus?.control && !element.contains(document.activeElement)) {
      markedControl(element, next.focus)?.focus({ preventScroll: true })
    }
    if (next.wrap < 0) return
    const trigger = element.querySelectorAll('[data-popover-wrap]')[next.wrap]?.firstElementChild
    if (!(trigger instanceof HTMLElement)) return
    trigger.focus({ preventScroll: true })
    // the live trigger opens through its own Radix toggle
    trigger.click()
  }, [live, root])
  const value = useMemo(() => (live ? null : { activate }), [live, activate])
  /* A mouse that points at the row, never a touch, and never while a button
     is held: a press or drag keeps the node it started on. */
  const pointed = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' && event.buttons === 0) activate()
  }
  const rootProps = live
    ? { 'data-card-live': '' }
    : {
        onPointerOver: pointed,
        onPointerMove: pointed,
        onFocus: () => {
          if (!lastInputWasPointer()) activate()
        },
      }
  return { live, rootProps, value }
}

import {
  createContext,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { lastInputWasPointer } from './focusVisibility'
import { markTaskFocus, type TaskFocusMark } from './taskFocus'

/* Static controls for long lists. A row in a static scope renders today's
   DOM but mounts no Radix tooltip or popover roots: HoverTooltip clones its
   child and Popover renders a plain trigger. The row goes live, for good,
   when a mouse points at it, keyboard focus enters it, or someone presses
   one of its popover triggers. A live row renders the full controls. */

/** What a static scope's controls call to make their row live. A popover
    trigger passes its `[data-popover-wrap]`, so the live trigger opens; a
    mouse passes where it points, so the live control under it sees it. */
export type StaticControls = {
  activate: (wrap?: HTMLElement | null, pointer?: { x: number; y: number }) => void
}

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
  const handover = useRef<{
    focus: TaskFocusMark | null
    wrap: number
    pointer?: { x: number; y: number }
  } | null>(null)
  // made once: it reads only the refs and the setter, which keep their identity
  const [statics] = useState<StaticControls>(() => ({
    activate: (wrap, pointer) => {
      const element = root.current
      if (!element) return
      const wrapAt = wrap ? [...element.querySelectorAll('[data-popover-wrap]')].indexOf(wrap) : -1
      // Already going live, as a mouse that arrives renders the row later:
      // a press that lands first still opens its popover.
      if (handover.current) {
        if (wrapAt >= 0) handover.current.wrap = wrapAt
        return
      }
      const active = document.activeElement
      handover.current = {
        focus: active && element.contains(active) ? markTaskFocus(active) : null,
        wrap: wrapAt,
        pointer,
      }
      setLive(true)
    },
  }))
  const { activate } = statics
  useLayoutEffect(() => {
    const next = handover.current
    const element = root.current
    handover.current = null
    if (!live || !next || !element) return
    if (next.focus?.control && !element.contains(document.activeElement)) {
      markedControl(element, next.focus)?.focus({ preventScroll: true })
    }
    // The mouse that made the row live already rests on a control the switch
    // replaced. A tooltip opens on a move over its trigger, so the new
    // control under the mouse gets one.
    const under =
      next.pointer && typeof document.elementFromPoint === 'function'
        ? document.elementFromPoint(next.pointer.x, next.pointer.y)
        : null
    if (next.pointer && under && element.contains(under) && typeof PointerEvent === 'function')
      under.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          clientX: next.pointer.x,
          clientY: next.pointer.y,
          pointerType: 'mouse',
          isPrimary: true,
        }),
      )
    if (next.wrap < 0) return
    const trigger = element.querySelectorAll('[data-popover-wrap]')[next.wrap]?.firstElementChild
    if (!(trigger instanceof HTMLElement)) return
    trigger.focus({ preventScroll: true })
    // the live trigger opens through its own Radix toggle
    trigger.click()
  }, [live, root])
  const value = live ? null : statics
  /* A mouse that points at the row, never a touch, and never while a button
     is held: a press or drag keeps the node it started on. */
  const pointed = (event: ReactPointerEvent) => {
    if (event.pointerType !== 'touch' && event.buttons === 0)
      activate(null, { x: event.clientX, y: event.clientY })
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

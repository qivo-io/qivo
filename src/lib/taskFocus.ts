import { type FocusEvent, type RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import { lastInputWasPointer } from './focusVisibility'

/* Focus that follows a task's card. A card that moves to another cell (its
   status or owner changed, here or elsewhere) is a new element, so the
   browser drops the focus it held to the page. These helpers remember where
   in which task focus was, by the task and the control's data-focus-key,
   and put it back on the card wherever the task now is. */

/** Where focus was: the task, its row kind, the control and the cell the
    card was in, with the card's index there. */
export type TaskFocusMark = {
  taskId: string
  row: 'card' | 'parent'
  control: string | null
  cell: string | null
  status: string | null
  index: number
}

const ROWS = '[data-card], [data-parent-heading]'

/** The mark for focus on `element`, or null outside a task row. */
export function markTaskFocus(element: Element | null): TaskFocusMark | null {
  const row = element?.closest<HTMLElement>(ROWS)
  if (!element || !row) return null
  const card = row.hasAttribute('data-card')
  const control = element.closest('[data-focus-key]')
  const cell = row.closest<HTMLElement>('[data-board-cell]')
  return {
    taskId: (card ? row.dataset.card : row.dataset.parentHeading) ?? '',
    row: card ? 'card' : 'parent',
    control: control && row.contains(control) ? control.getAttribute('data-focus-key') : null,
    cell: cell?.dataset.boardCell ?? null,
    status: cell?.dataset.status ?? null,
    index: cell ? [...cell.querySelectorAll(ROWS)].indexOf(row) : -1,
  }
}

const mounts = new Set<(mark: TaskFocusMark) => void>()

/** Registers `mount`, which restoreTaskFocus calls before it searches so a
    view that mounts its cards later can mount the marked task's card.
    Returns the registration's removal. */
export function registerTaskMount(mount: (mark: TaskFocusMark) => void) {
  mounts.add(mount)
  return () => {
    mounts.delete(mount)
  }
}

const usable = (element: HTMLElement | null | undefined): element is HTMLElement =>
  !!element?.isConnected && !element.closest('[inert]')

/** Focuses the control `mark` names, wherever its task is now, or the
    nearest thing to it: another control of the task's row, then, only when
    the task is no longer shown, the card now at the remembered place in the
    remembered cell. Scrolls it into view only when `scroll` is set. Returns
    whether focus moved. */
export function restoreTaskFocus(mark: TaskFocusMark, { scroll }: { scroll: boolean }) {
  for (const mount of mounts) mount(mark)
  // Both kinds of row: a parent whose last subtask left becomes a card, and
  // a card that gains a subtask becomes a parent heading. Attribute values
  // are compared, not put in selectors, so any id works.
  const rows = [...document.querySelectorAll<HTMLElement>(ROWS)].filter(
    (row) => (row.dataset.card ?? row.dataset.parentHeading) === mark.taskId && usable(row),
  )
  const kind = (row: HTMLElement) => (row.dataset.card !== undefined ? 'card' : 'parent')
  // Prefer the remembered kind of row, then, because a parent heading repeats
  // in every cell that holds one of its children, the remembered cell and
  // then the remembered lane.
  const rank = (row: HTMLElement) => {
    const cell = row.closest<HTMLElement>('[data-board-cell]')
    const place =
      cell?.dataset.boardCell !== mark.cell ? 2 : cell?.dataset.status === mark.status ? 0 : 1
    return (kind(row) === mark.row ? 0 : 3) + place
  }
  rows.sort((a, b) => rank(a) - rank(b))
  /** The row's control `key`, or its first control. */
  const keyed = (row: HTMLElement, key?: string | null) =>
    [row, ...row.querySelectorAll<HTMLElement>('[data-focus-key]')].find((element) =>
      key ? element.dataset.focusKey === key : element.dataset.focusKey !== undefined,
    )
  let target = mark.control ? rows.map((row) => keyed(row, mark.control)).find(usable) : undefined
  target ??= rows.map((row) => keyed(row)).find(usable)
  if (!target && !rows.length && mark.cell !== null && mark.status !== null) {
    const cell = [...document.querySelectorAll<HTMLElement>('[data-board-cell]')].find(
      (element) =>
        element.dataset.boardCell === mark.cell && element.dataset.status === mark.status,
    )
    const others = cell ? [...cell.querySelectorAll<HTMLElement>(ROWS)] : []
    const row = others[Math.min(mark.index, others.length - 1)]
    if (row) target = keyed(row)
  }
  if (!usable(target)) return false
  target.focus({ preventScroll: true })
  if (document.activeElement !== target) return false
  if (scroll) target.scrollIntoView({ block: 'nearest' })
  return true
}

/** Keeps keyboard focus on a task's card in the list `container` holds
    when a render moves that card. Spread the returned handlers on the
    container. Focus is followed only while the page has it, nothing else
    took it, and the list is not behind a modal window. A pointer press
    elsewhere, or focus moving out of the control, forgets it. */
export function useFollowTaskFocus(container: RefObject<HTMLElement | null>) {
  const followed = useRef<{ mark: TaskFocusMark; element: Element } | null>(null)
  useEffect(() => {
    const forget = (event: PointerEvent) => {
      const current = followed.current
      if (current && !(event.target instanceof Node && current.element.contains(event.target)))
        followed.current = null
    }
    window.addEventListener('pointerdown', forget, true)
    return () => window.removeEventListener('pointerdown', forget, true)
  }, [])
  useLayoutEffect(() => {
    const current = followed.current
    const list = container.current
    if (
      !current ||
      !list ||
      !document.hasFocus() ||
      document.activeElement !== document.body ||
      list.closest('[inert]')
    )
      return
    restoreTaskFocus(current.mark, { scroll: !lastInputWasPointer() })
  })
  return {
    onFocus: (event: FocusEvent) => {
      const mark = markTaskFocus(event.target)
      followed.current = mark ? { mark, element: event.target } : null
    },
    onBlur: (event: FocusEvent) => {
      const current = followed.current
      const next = event.relatedTarget
      if (current && next && !current.element.contains(next)) followed.current = null
    },
  }
}

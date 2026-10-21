import { type FocusEvent, type RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import { lastInputWasPointer } from './focusVisibility'

/* Focus that follows a task's card. A card that moves to another cell (its
   status or owner changed, here or elsewhere) is a new element, so the
   browser drops the focus it held to the page. These helpers remember where
   in which task focus was, by the task and the control's data-focus-key,
   and put it back on the card wherever the task now is. */

/** Where focus was: the task, its row kind, the control, and the cell the
    card was in (its lane key, status and element) with the card's index
    there. */
export type TaskFocusMark = {
  taskId: string
  row: 'card' | 'parent'
  control: string | null
  cell: string | null
  status: string | null
  place: HTMLElement | null
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
    place: cell,
    index: cell ? [...cell.querySelectorAll(ROWS)].indexOf(row) : -1,
  }
}

const mounts = new Set<(mark: TaskFocusMark) => void>()

/** Registers `mount`, which restoreTaskFocus calls before it searches so a
    view that mounts its cards later can mount the marked task's card. It
    may commit a render synchronously, so it never runs inside a commit.
    Returns the registration's removal. */
export function registerTaskMount(mount: (mark: TaskFocusMark) => void) {
  mounts.add(mount)
  return () => {
    mounts.delete(mount)
  }
}

const usable = (element: HTMLElement | null | undefined): element is HTMLElement =>
  !!element?.isConnected && !element.closest('[inert]')

/** Focuses the control `mark` names, wherever its task is now, or another
    control of the task's row. With `nearby`, and only when the task is no
    longer shown, it falls back to the card now at the remembered index in
    the remembered cell, as long as that cell is still on the page; a lane
    key alone repeats across scopes. Scrolls into view only when `scroll` is
    set. With `mount` false it searches only what is mounted, as it must
    inside a React commit; with `exact` it takes only the remembered row,
    in the same kind and cell, so a mounted copy of a parent heading in
    another cell does not stand in for one that still waits to mount.
    Returns whether focus moved. */
export function restoreTaskFocus(
  mark: TaskFocusMark,
  {
    scroll,
    nearby = true,
    mount = true,
    exact = false,
  }: { scroll: boolean; nearby?: boolean; mount?: boolean; exact?: boolean },
) {
  if (mount) for (const register of mounts) register(mark)
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
  if (exact) {
    const other = rows.findIndex((row) => rank(row) > 0)
    if (other >= 0) rows.length = other
  }
  /** The row's control `key`, or its first control. */
  const keyed = (row: HTMLElement, key?: string | null) =>
    [row, ...row.querySelectorAll<HTMLElement>('[data-focus-key]')].find((element) =>
      key ? element.dataset.focusKey === key : element.dataset.focusKey !== undefined,
    )
  let target = mark.control ? rows.map((row) => keyed(row, mark.control)).find(usable) : undefined
  target ??= rows.map((row) => keyed(row)).find(usable)
  if (!target && !rows.length && nearby && usable(mark.place)) {
    const others = [...mark.place.querySelectorAll<HTMLElement>(ROWS)]
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
    when a render moves that card. Spread the returned handler on the
    container. Focus is followed only while the page has it, nothing else
    took it, and the list is not behind a modal window. Focus in a popover a
    card opened (outside the list's DOM but inside its React tree) keeps
    following the card, so a pick that moves the card brings focus back.
    Focus landing anywhere else, a pointer press outside the control, wheel
    or touch scrolling, or a restore that finds nothing forgets it. */
export function useFollowTaskFocus(container: RefObject<HTMLElement | null>) {
  const followed = useRef<{ mark: TaskFocusMark; element: Element } | null>(null)
  // the last focus event the list's own handler saw
  const seen = useRef<Event | null>(null)
  useEffect(() => {
    const forget = () => {
      followed.current = null
    }
    const pressed = (event: PointerEvent) => {
      const current = followed.current
      if (current && !(event.target instanceof Node && current.element.contains(event.target)))
        forget()
    }
    // Bubbling on window, so after React handled the event for the list.
    const landed = (event: Event) => {
      if (event !== seen.current) forget()
    }
    window.addEventListener('pointerdown', pressed, true)
    window.addEventListener('focusin', landed)
    window.addEventListener('wheel', forget, { passive: true })
    window.addEventListener('touchmove', forget, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', pressed, true)
      window.removeEventListener('focusin', landed)
      window.removeEventListener('wheel', forget)
      window.removeEventListener('touchmove', forget)
    }
  }, [])
  useLayoutEffect(() => {
    /** Whether focus was lost from the followed card and can come back. */
    const lost = () => {
      const list = container.current
      return (
        !!followed.current &&
        !!list &&
        document.hasFocus() &&
        document.activeElement === document.body &&
        !list.closest('[inert]')
      )
    }
    /* Follows the control focus landed on, whether or not React delivered
       its focus event during the commit. */
    const follow = () => {
      const landed = document.activeElement
      const mark = markTaskFocus(landed)
      followed.current = mark && landed ? { mark, element: landed } : null
    }
    const current = followed.current
    if (!current || !lost()) return
    const scroll = !lastInputWasPointer()
    // the card as it is mounted now, without mounting anything in the commit
    if (restoreTaskFocus(current.mark, { scroll, nearby: false, mount: false, exact: true }))
      return follow()
    // Then once the commit is done, mounting the task's card if its cell
    // still waits for it. A mark that finds nothing now would find something
    // unrelated later.
    queueMicrotask(() => {
      if (followed.current !== current || !lost()) return
      if (restoreTaskFocus(current.mark, { scroll })) follow()
      else followed.current = null
    })
  })
  return {
    onFocus: (event: FocusEvent) => {
      seen.current = event.nativeEvent
      // a popover a card opened: keep following the card
      if (container.current && !container.current.contains(event.target)) return
      const mark = markTaskFocus(event.target)
      followed.current = mark ? { mark, element: event.target } : null
    },
  }
}

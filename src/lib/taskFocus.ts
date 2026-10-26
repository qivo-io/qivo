import { type FocusEvent, type RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import { lastInputWasPointer } from './focusVisibility'
import { OUT_OF_USE } from './viewHidden'

/* Focus that follows a task's card. A card that moves to another cell (its
   status or owner changed, here or elsewhere) is a new element, so the
   browser drops the focus it held to the page. These helpers remember where
   in which task focus was, by the task and the control's data-focus-key,
   and put it back on the card wherever the task now is. A row of another
   view that names its task in a data attribute, such as an Overview or
   Roadmap row, is remembered the same way within its view. */

/** Where focus was: the task, its row kind, the control, the cell the
    card was in (its lane key, status and element) with the card's index
    there, the shown view (data-workspace-view) it was in and the cell's
    index among that view's cells. Another
    view's row ('other') keeps that view as the place too, the attribute
    that names its task, its index among the view's rows with that
    attribute, and the heading above it there. */
export type TaskFocusMark = {
  taskId: string
  row: 'card' | 'parent' | 'other'
  control: string | null
  cell: string | null
  status: string | null
  place: HTMLElement | null
  index: number
  view?: HTMLElement | null
  cellIndex?: number
  attribute?: string
  heading?: HTMLElement | null
}

const ROWS = '[data-card], [data-parent-heading]'
const CELLS = '[data-board-cell]'
// with the button that names a Roadmap track or sub-project band
const HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"], [data-lane-open]'

/** The mark for focus on `element`, or null outside a task row. Outside a
    Board row, `taskId` names the task of another view's row: `element`, or
    its nearest ancestor in a shown view (data-workspace-view), with a data
    attribute whose value is `taskId`. */
export function markTaskFocus(
  element: Element | null,
  taskId?: string | null,
): TaskFocusMark | null {
  const row = element?.closest<HTMLElement>(ROWS)
  if (!element) return null
  if (!row) return taskId ? markViewRow(element, taskId) : null
  const card = row.hasAttribute('data-card')
  const control = element.closest('[data-focus-key]')
  const cell = row.closest<HTMLElement>(CELLS)
  const view = row.closest<HTMLElement>('[data-workspace-view]')
  return {
    taskId: (card ? row.dataset.card : row.dataset.parentHeading) ?? '',
    row: card ? 'card' : 'parent',
    control: control && row.contains(control) ? control.getAttribute('data-focus-key') : null,
    cell: cell?.dataset.boardCell ?? null,
    status: cell?.dataset.status ?? null,
    place: cell,
    index: cell ? [...cell.querySelectorAll(ROWS)].indexOf(row) : -1,
    view,
    cellIndex: cell && view ? [...view.querySelectorAll(CELLS)].indexOf(cell) : -1,
  }
}

/** The mark for focus on `element` in another view's row of `taskId`, or
    null when no element up to the view names the task. */
function markViewRow(element: Element, taskId: string): TaskFocusMark | null {
  const view = element.closest<HTMLElement>('[data-workspace-view]')
  let row: Element | null = element
  let attribute: string | undefined
  while (view && row && row !== view) {
    attribute = [...row.attributes].find(
      (a) => a.name.startsWith('data-') && a.value === taskId,
    )?.name
    if (attribute) break
    row = row.parentElement
  }
  if (!view || !row || !attribute) return null
  const named = row
  const control = element.closest('[data-focus-key]')
  const above = [...view.querySelectorAll<HTMLElement>(HEADINGS)].filter(
    (heading) => !!(heading.compareDocumentPosition(named) & Node.DOCUMENT_POSITION_FOLLOWING),
  )
  return {
    taskId,
    row: 'other',
    control: control && row.contains(control) ? control.getAttribute('data-focus-key') : null,
    cell: null,
    status: null,
    place: view,
    index: [...view.querySelectorAll(`[${attribute}]`)].indexOf(row),
    view,
    attribute,
    heading: above.at(-1) ?? null,
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
  !!element?.isConnected && !element.closest(OUT_OF_USE)

/** Focuses the control `mark` names, wherever its task is now, or another
    control of the task's row. With `nearby`, and only when the task is no
    longer shown, it falls back to the row now at the remembered index in
    the remembered place, as long as that place is still on the page: the
    card in the Board cell (a lane key alone repeats across scopes), or
    another view's row with the same attribute in that view. With `beside`
    too, a place left without such rows falls back further (besideTarget).
    Scrolls into view only when `scroll` is set. With `mount` false it
    searches only what is mounted, as it must inside a React commit; with
    `exact` it takes only the remembered row, in the same kind and cell, so
    a mounted copy of a parent heading in another cell does not stand in
    for one that still waits to mount. Returns whether focus moved. */
export function restoreTaskFocus(
  mark: TaskFocusMark,
  {
    scroll,
    nearby = true,
    beside = false,
    mount = true,
    exact = false,
  }: { scroll: boolean; nearby?: boolean; beside?: boolean; mount?: boolean; exact?: boolean },
) {
  const { attribute } = mark
  // what registers mounts Board cards only
  if (mount && !attribute) for (const register of mounts) register(mark)
  // Both kinds of Board row: a parent whose last subtask left becomes a
  // card, and a card that gains a subtask becomes a parent heading.
  // Attribute values are compared, not put in selectors, so any id works.
  const select = attribute ? `[${attribute}]` : ROWS
  const taskOf = (row: HTMLElement) =>
    attribute ? row.getAttribute(attribute) : (row.dataset.card ?? row.dataset.parentHeading)
  const rows = [...document.querySelectorAll<HTMLElement>(select)].filter(
    (row) => taskOf(row) === mark.taskId && usable(row),
  )
  const kind = (row: HTMLElement) =>
    attribute ? 'other' : row.dataset.card !== undefined ? 'card' : 'parent'
  // Prefer the remembered kind of row, then, because a parent heading repeats
  // in every cell that holds one of its children, the remembered cell and
  // then the remembered lane.
  const rank = (row: HTMLElement) => {
    const cell = row.closest<HTMLElement>(CELLS)
    const place =
      cell?.dataset.boardCell !== mark.cell ? 2 : cell?.dataset.status === mark.status ? 0 : 1
    return (kind(row) === mark.row ? 0 : 3) + place
  }
  rows.sort((a, b) => rank(a) - rank(b))
  if (exact) {
    const other = rows.findIndex((row) => rank(row) > 0)
    if (other >= 0) rows.length = other
  }
  /** The row's control `key`, or its first control. Another view's row
      without one, such as a Roadmap title, is the control itself. */
  const keyed = (row: HTMLElement, key?: string | null) =>
    [row, ...row.querySelectorAll<HTMLElement>('[data-focus-key]')].find((element) =>
      key ? element.dataset.focusKey === key : element.dataset.focusKey !== undefined,
    ) ?? (attribute && !key ? row : undefined)
  /** The row of `place` at the remembered index, or its last one. */
  const atIndex = (place: HTMLElement) => {
    const others = [...place.querySelectorAll<HTMLElement>(select)]
    const row = others[Math.min(mark.index, others.length - 1)]
    return row && keyed(row)
  }
  let target = mark.control ? rows.map((row) => keyed(row, mark.control)).find(usable) : undefined
  target ??= rows.map((row) => keyed(row)).find(usable)
  // exact takes the remembered row or nothing, never a neighbour
  if (!target && !rows.length && nearby && !exact) {
    if (usable(mark.place)) target = atIndex(mark.place)
    if (!target && beside) target = besideTarget(mark, atIndex)
  }
  if (!usable(target)) return false
  target.focus({ preventScroll: true })
  if (document.activeElement !== target) return false
  if (scroll) target.scrollIntoView({ block: 'nearest' })
  return true
}

/** Where focus goes, with `beside`, once the place `mark` remembers holds
    no row, as long as the view it was in is still shown. A Board cell on
    the page gives its column's new task button (data-status-add), else a
    card in the nearest cell beside it in its lane. A cell that left with
    its lane, as filters hide a lane with no card, gives the column's
    button, else a card in another cell of the column, else, on the phone,
    whose Board lists one cell for each status (data-board-cell="phone"), a
    card in the cell now in its place, else in the one before. Another
    view's row gives the heading above it. Then comes the empty state the
    view shows in place of its rows (data-empty-state): its control, else
    its title. A Board card's last resort is the first control of the
    Board's filter row (App's data-filter-row), whose filters can hide a
    lane and its column's cards. `pick` finds the row of a cell at the
    remembered index. */
function besideTarget(mark: TaskFocusMark, pick: (cell: HTMLElement) => HTMLElement | undefined) {
  const { place, view, status } = mark
  let target: HTMLElement | undefined
  if (mark.attribute) target = headingTarget(mark.heading)
  else if (usable(place)) target = columnAdd(view ?? document, status) ?? besideCell(place, pick)
  else if (usable(view))
    target =
      columnAdd(view, status) ??
      inColumn(view, status, pick) ??
      (mark.cell === 'phone' ? nearCell(view, mark.cellIndex ?? -1, pick) : undefined)
  if (target || !usable(view)) return target
  return emptyState(view) ?? (mark.attribute ? undefined : filterControl())
}

/** The first control of the Board's filter row. */
function filterControl() {
  const control = document
    .querySelector('[data-filter-row]')
    ?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)')
  return usable(control) ? control : undefined
}

/** The new task button of the column `status` names in `view`. */
function columnAdd(view: ParentNode, status: string | null) {
  return [...view.querySelectorAll<HTMLElement>('[data-status-add]')].find(
    (button) => button.dataset.statusAdd === status && usable(button),
  )
}

/** What `pick` finds in the first Board cell of the column `status` names
    in `view`. */
function inColumn(
  view: HTMLElement,
  status: string | null,
  pick: (cell: HTMLElement) => HTMLElement | undefined,
) {
  for (const cell of view.querySelectorAll<HTMLElement>(CELLS)) {
    const target = cell.dataset.status === status ? pick(cell) : undefined
    if (target) return target
  }
  return undefined
}

/** What `pick` finds in the cell of `view` now at `at`, else in the one
    before it. */
function nearCell(
  view: HTMLElement,
  at: number,
  pick: (cell: HTMLElement) => HTMLElement | undefined,
) {
  const cells = [...view.querySelectorAll<HTMLElement>(CELLS)].filter(usable)
  for (const cell of [cells[at], cells[at - 1]]) {
    const target = cell && pick(cell)
    if (target) return target
  }
  return undefined
}

/** The control of the empty state that the shown view shows in place of
    its rows, else its title. */
export function shownEmptyState() {
  const view = document.querySelector<HTMLElement>('[data-workspace-view]')
  return (view && emptyState(view)) ?? null
}

/** The control of the empty state `view` shows, else its title. */
function emptyState(view: HTMLElement) {
  const state = view.querySelector<HTMLElement>('[data-empty-state]')
  if (!state) return undefined
  return (
    state.querySelector<HTMLElement>('button:not(:disabled)') ??
    headingTarget(state.querySelector<HTMLElement>('[data-empty-state-title]'))
  )
}

/** What `pick` finds in the nearest Board cell beside `cell` in its lane,
    the next one first at an equal distance. */
function besideCell(cell: HTMLElement, pick: (cell: HTMLElement) => HTMLElement | undefined) {
  const cells = [...(cell.parentElement?.children ?? [])].filter(
    (other): other is HTMLElement => other instanceof HTMLElement && other.matches(CELLS),
  )
  const at = cells.indexOf(cell)
  for (let step = 1; step < cells.length; step++) {
    for (const other of [cells[at + step], cells[at - step]]) {
      const target = other && pick(other)
      if (target) return target
    }
  }
  return undefined
}

/** `heading`, or a title that stands for one, focusable until it loses
    focus unless it already was, or undefined once it is gone. */
function headingTarget(heading: HTMLElement | null | undefined) {
  if (!usable(heading)) return undefined
  if (heading.tabIndex < 0 && !heading.hasAttribute('tabindex')) {
    heading.tabIndex = -1
    heading.addEventListener('blur', () => heading.removeAttribute('tabindex'), { once: true })
  }
  return heading
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
        !list.closest(OUT_OF_USE)
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

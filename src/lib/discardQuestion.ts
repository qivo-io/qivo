import type { UnsentScope } from '@/lib/leaveGuard'
import { OUT_OF_USE } from '@/lib/viewHidden'

/* The question before a window closes with text it has not sent.

   Nothing typed is kept anywhere, so closing a window that holds a comment,
   a title or another field's unsent text throws it away. Every close of
   such a window (its close button, Escape, a press outside it, Back, another
   task opened in it, a move elsewhere in the app) goes through closeOrAsk,
   which asks "Discard your unsent comment?" with Keep editing and Discard.
   The editors' leases (lib/leaveGuard) say what each window holds. One
   prompt, mounted once at the root, serves every window. */

// `field` is the field that held focus, which Keep editing returns to
export type Ask = {
  what: string[]
  scopes: UnsentScope[]
  go: () => void
  field: HTMLElement | null
}

let asking: Ask | null = null
// the field focus returns to once the question closes, unless Discard
let returnTo: HTMLElement | null = null
// the last text field that had focus, for a close whose button press moved
// focus off it (DiscardPrompt records it through noteFocus)
let lastField: HTMLElement | null = null

/** Whether `el` takes typed text. */
const typesText = (el: unknown): el is HTMLElement =>
  el instanceof HTMLElement &&
  (el.isContentEditable ||
    el.matches(
      'textarea, input:not([type="button"], [type="checkbox"], [type="radio"], [type="submit"], [type="reset"], [type="file"])',
    ))
const listeners = new Set<() => void>()
const show = (next: Ask | null) => {
  if (next) returnTo = next.field
  asking = next
  for (const listener of listeners) listener()
}
export const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const heldIn = (scopes: UnsentScope[]) => [...new Set(scopes.flatMap((scope) => scope.held()))]

/** Whether the question is open, for a window's own Escape and outside
    handlers, which must leave both to it. */
export const questionOpen = () => asking !== null

/** The dialog, window or pop `el` sits in. */
const layerOf = (el: Element) =>
  el.closest('[role="dialog"], [role="alertdialog"], [data-modal-shell], [data-task-scrim]')

/** The field Keep editing returns focus to: the focused one when it takes
    text, else the last text field, if it is in the same layer as the
    focused element, such as the window whose close button took focus. */
function returnFieldFor(focused: HTMLElement | null) {
  if (typesText(focused)) return focused
  const last = lastField
  if (
    last?.isConnected &&
    !last.closest(OUT_OF_USE) &&
    (!focused || focused === document.body || layerOf(last) === layerOf(focused))
  )
    return last
  return focused
}

/** Runs `then` once React has rendered what the current task scheduled:
    two macrotasks, so a render a timer of the first one posts commits. */
const afterRenders = (then: () => void) => setTimeout(() => setTimeout(then, 0), 0)

/** "comment", "comment and title", "comment, title and description". */
export function unsentList(what: readonly string[]) {
  if (what.length < 2) return what[0] ?? 'text'
  return `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}`
}

/** Runs `go`, the close of the windows `scopes` belong to, at once while
    they hold no unsent text, and answers true. Otherwise answers false and
    leaves the focused field, as a press on a close button would, so a field
    that saves when it loses focus saves and ends its lease. Once that has
    rendered it runs `go` if nothing is left, or asks the person and runs it
    only after Discard. */
export function closeOrAsk(
  scopes: readonly (UnsentScope | null | undefined | false)[],
  go: () => void,
): boolean {
  const live = scopes.filter((scope): scope is UnsentScope => !!scope)
  if (!heldIn(live).length) {
    go()
    return true
  }
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const field = returnFieldFor(focused)
  focused?.blur()
  afterRenders(() => {
    const what = heldIn(live)
    if (what.length) show({ what, scopes: live, go, field })
    else go()
  })
  return false
}

/** The open question, or null. */
export const currentQuestion = () => asking

/** Records `target` as the last text field, if it takes text. */
export function noteFocus(target: EventTarget | null) {
  if (typesText(target)) lastField = target
}

/** Closes the question. Unless Discard closed it, focus then goes back to
    the field it was asked from (takeReturnField). */
export const closeQuestion = () => show(null)

/** The field focus returns to once the question closes, at most once. */
export function takeReturnField() {
  const field = returnTo
  returnTo = null
  return field
}

/** Discards the text `ask` was about and runs its close. */
export function discardAndClose(ask: Ask) {
  for (const scope of ask.scopes) scope.discard()
  returnTo = null
  show(null)
  ask.go()
}

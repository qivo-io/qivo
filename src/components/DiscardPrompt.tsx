import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { restoreFocus } from '@/lib/focusVisibility'
import type { UnsentScope } from '@/lib/leaveGuard'

/* The question before a window closes with text it has not sent.

   Nothing typed is kept anywhere, so closing a window that holds a comment,
   a title or another field's unsent text throws it away. Every close of
   such a window (its close button, Escape, a press outside it, Back, another
   task opened in it, a move elsewhere in the app) goes through closeOrAsk,
   which asks "Discard your unsent comment?" with Keep editing and Discard.
   The editors' leases (lib/leaveGuard) say what each window holds. One
   prompt, mounted once at the root, serves every window. */

// `field` is the field that held focus, which Keep editing returns to
type Ask = { what: string[]; scopes: UnsentScope[]; go: () => void; field: HTMLElement | null }

let asking: Ask | null = null
// the field focus returns to once the question closes, unless Discard
let returnTo: HTMLElement | null = null
// the last text field that had focus, for a close whose button press moved
// focus off it (DiscardPrompt records it)
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
const subscribe = (listener: () => void) => {
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
    !last.closest('[inert]') &&
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

/** The one Keep editing or Discard question, mounted once at the root. */
export function DiscardPrompt() {
  const ask = useSyncExternalStore(subscribe, () => asking)
  // the last question's words, for its last render as it closes
  const shown = useRef(ask)
  if (ask) shown.current = ask
  useEffect(() => {
    const record = (event: FocusEvent) => {
      if (typesText(event.target)) lastField = event.target
    }
    document.addEventListener('focusin', record)
    return () => document.removeEventListener('focusin', record)
  }, [])
  return (
    <AlertDialog
      open={!!ask}
      onOpenChange={(open) => {
        if (!open) show(null)
      }}
    >
      <AlertDialogContent
        data-discard-prompt
        // no fade-out: a fading question would still hold focus and Escape
        overlayClassName="z-[130] data-[state=closed]:animate-none"
        className="z-[131] data-[state=closed]:animate-none"
        onCloseAutoFocus={(event) => {
          // back to the text after Keep editing or Escape
          const field = returnTo
          returnTo = null
          if (!field?.isConnected || field.closest('[inert]')) return
          event.preventDefault()
          restoreFocus(field)
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            Discard your unsent {unsentList(shown.current?.what ?? [])}?
          </AlertDialogTitle>
          <AlertDialogDescription>It was not sent, and Qivo keeps no copy.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-discard-keep>Keep editing</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-discard-confirm
            onClick={() => {
              if (!ask) return
              for (const scope of ask.scopes) scope.discard()
              returnTo = null
              show(null)
              ask.go()
            }}
          >
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

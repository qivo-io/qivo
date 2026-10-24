import {
  createContext,
  type FocusEvent,
  type FormEvent,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { useUpdateBlocker } from './updateSafety'
import { useLatest } from './useLatest'

/* The warning before the page closes or reloads with work that is not saved.

   Nothing is saved locally, so closing the page loses a change the server
   has not confirmed and text typed into an editor that was never sent. The
   app's one `beforeunload` handler (installLeaveGuard) asks the browser to
   warn while either exists. Editors and uploads hold a lease while they
   have something unsent (holdUnsaved, useUnsaved). Convex's own warning is
   off (lib/convex.ts), because it misses writes made after the socket
   closed. The desktop app shows its own Leave or Stay dialog for the same
   warning (desktop/main.ts).

   A lease taken inside a window also counts in that window's UnsentScope,
   under a name such as "comment", so closing the window can ask before it
   throws the text away (components/DiscardPrompt). */

const leases = new Set<symbol>()
// set once the page leaves on purpose, after the person was told what it loses
let leaving = false

/** Whether an editor or an upload holds something unsent. */
export const hasUnsaved = () => leases.size > 0

/** Holds a lease until the answered function is called. */
export function holdUnsaved(): () => void {
  const lease = Symbol()
  leases.add(lease)
  return () => {
    leases.delete(lease)
  }
}

/** The unsent text one window holds, so a close can ask first. A lease held
    in a window inside another one counts for both. */
export type UnsentScope = {
  /** What the window holds unsent, such as "comment", each name once. */
  held: () => string[]
  /** Holds `what` until the answered function is called. `onDiscard` runs
      when a Discard on this window or one around it throws `what` away, for
      a holder that may outlive the close, so the text goes all the same. */
  hold: (what: string, onDiscard?: () => void) => () => void
  /** Lets the close the person chose to discard go ahead, which can land a
      moment later, after a history step: the window, and every window
      inside it, reports nothing for DISCARD_MS, or until a new lease
      begins. A window that stays open after all asks again from then on.
      Runs the leases' onDiscard. `how` is 'chosen' when the person chose
      Discard or a notice names what went, and 'unasked' for a close that
      goes ahead without the question, such as after the task was archived,
      whose editors still say what went. */
  discard: (how?: 'chosen' | 'unasked') => void
  /** Whether a Discard on this window or one around it is letting a close
      go ahead now, also while that close ends the window's leases. */
  discarded: () => boolean
  /** Whether that Discard was chosen (discard), so an editor that unmounts
      with the close says nothing more of its text. */
  chosen: () => boolean
}

/** How long a Discard lets the close it answered go ahead. */
export const DISCARD_MS = 1500

/** A window's scope, inside `parent` when the window opens in another. */
export function createUnsentScope(parent: UnsentScope | null = null): UnsentScope {
  const own = new Map<symbol, { what: string; onDiscard?: () => void }>()
  let discardedAt: number | null = null
  let chosenAt: number | null = null
  const lasts = (at: number | null) => at !== null && Date.now() - at < DISCARD_MS
  const discarded = () => lasts(discardedAt) || !!parent?.discarded()
  return {
    held: () => (discarded() ? [] : [...new Set([...own.values()].map((lease) => lease.what))]),
    discarded,
    chosen: () => lasts(chosenAt) || !!parent?.chosen(),
    hold: (what, onDiscard) => {
      const lease = Symbol()
      own.set(lease, { what, onDiscard })
      discardedAt = null
      chosenAt = null
      // the window around runs it, as a Discard there throws `what` away too
      const outer = parent?.hold(what, onDiscard)
      return () => {
        own.delete(lease)
        outer?.()
      }
    },
    discard: (how = 'chosen') => {
      if (!own.size) return
      discardedAt = Date.now()
      chosenAt = how === 'chosen' ? discardedAt : null
      for (const lease of Array.from(own.values())) lease.onDiscard?.()
    },
  }
}

/** The window whose scope the leases below it count in. */
export const UnsentScopeContext = createContext<UnsentScope | null>(null)

/** A scope for this component's window, inside the window around it. */
export function useUnsentScope() {
  const parent = useContext(UnsentScopeContext)
  const [scope] = useState(() => createUnsentScope(parent))
  return scope
}

/** Holds a lease while `unsaved` is true, for an editor with typed text it
    has not sent. `what` names the text in the window's question; null keeps
    the lease out of it, for a lease that only the page's close warns about.
    `within` holds it in a scope of the component's own inside the window's
    (useUnsentScope). `onDiscard` runs when the person chooses Discard for
    it (UnsentScope.hold). */
export function useUnsaved(
  unsaved: boolean,
  what: string | null = 'text',
  within?: UnsentScope,
  onDiscard?: () => void,
) {
  const windowScope = useContext(UnsentScopeContext)
  const scope = within ?? windowScope
  const discarded = useLatest(() => onDiscard?.())
  useLayoutEffect(() => {
    if (!unsaved) return
    const release = holdUnsaved()
    const leave = what === null ? undefined : scope?.hold(what, discarded)
    return () => {
      release()
      leave?.()
    }
  }, [unsaved, scope, what, discarded])
}

/** Lets the page leave without the warning, for a reload the person chose
    after Qivo said what it would lose, such as a confirmed sign-out. */
export function leaveDeliberately() {
  leaving = true
}

/** Warns before the page unloads while `unsaved()` holds. Answers a function
    that removes the handler. */
export function installLeaveGuard(unsaved: () => boolean, win: Window = window) {
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (leaving || !unsaved()) return
    event.preventDefault()
    // older browsers show the warning only for a returnValue
    event.returnValue = ''
  }
  win.addEventListener('beforeunload', onBeforeUnload)
  return () => win.removeEventListener('beforeunload', onBeforeUnload)
}

/** Holds a lease from the person's first keystroke in a form until `reset`,
    for fields that keep typed text without a draft state of their own. Put
    `typed` on the form's `onInputCapture`. The text also holds back a
    version reload, which would otherwise stop at the close warning. `what`
    is as for useUnsaved, and so is `onDiscard`. */
export function useTypedUnsaved(what: string | null = 'text', onDiscard?: () => void) {
  const [typed, setTyped] = useState(false)
  useUnsaved(typed, what, undefined, onDiscard)
  useUpdateBlocker(typed)
  return { typed: () => setTyped(true), reset: () => setTyped(false) }
}

/** Props for an uncontrolled field that saves on blur and is keyed by its
    `saved` value. They hold a lease from the first keystroke until a blur
    leaves nothing unsent, which they check once the field's own blur
    handler has run. A blur keeps the lease when the field still shows
    another value than the saved one and the save did not go out, either
    because `paused()` holds or because the field's handler refused the
    value and marked the field `aria-invalid`, such as a number out of
    range. A new saved value remounts the field and ends the draft, and the
    lease with it. A Discard puts the saved value back in the field, which
    can stay in the page, hidden, after the close (components/KeptView).
    `what` names the field in a window's question. The lease ends in the
    same task as the blur's check, so a close that left the field
    (DiscardPrompt) already finds it gone. */
export function useFieldUnsaved(paused: () => boolean, saved: string, what = 'text') {
  // the field typed in, for a Discard
  const typedIn = useRef<HTMLInputElement | null>(null)
  const { typed, reset } = useTypedUnsaved(what, () => {
    if (typedIn.current) typedIn.current.value = typedIn.current.defaultValue
    reset()
  })
  // a new saved value is the trigger, not a hidden page shown again, whose
  // effects run again (components/KeptView)
  const savedFor = useRef(saved)
  useLayoutEffect(() => {
    if (savedFor.current === saved) return
    savedFor.current = saved
    reset()
  }, [saved])
  return {
    onInput: (event: FormEvent<HTMLInputElement>) => {
      typedIn.current = event.currentTarget
      typed()
    },
    onBlurCapture: (event: FocusEvent<HTMLInputElement>) => {
      const field = event.currentTarget
      setTimeout(() => {
        const same =
          field.value === field.defaultValue ||
          (field.type === 'number' &&
            field.value.trim() !== '' &&
            Number(field.value) === Number(field.defaultValue))
        // the handler's refusal mark has rendered by now, because React
        // commits a blur's state update before this timer runs
        const refused = field.getAttribute('aria-invalid') === 'true'
        if (same || (!paused() && !refused)) flushSync(reset)
      }, 0)
    },
  }
}

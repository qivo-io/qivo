import { type FocusEvent, useLayoutEffect, useState } from 'react'
import { useUpdateBlocker } from './updateSafety'

/* The warning before the page closes or reloads with work that is not saved.

   Nothing is saved locally, so closing the page loses a change the server
   has not confirmed and text typed into an editor that was never sent. The
   app's one `beforeunload` handler (installLeaveGuard) asks the browser to
   warn while either exists. Editors and uploads hold a lease while they
   have something unsent (holdUnsaved, useUnsaved). Convex's own warning is
   off (lib/convex.ts), because it misses writes made after the socket
   closed. The desktop app shows its own Leave or Stay dialog for the same
   warning (desktop/main.ts). */

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

/** Holds a lease while `unsaved` is true, for an editor with typed text it
    has not sent. */
export function useUnsaved(unsaved: boolean) {
  useLayoutEffect(() => {
    if (unsaved) return holdUnsaved()
  }, [unsaved])
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
    version reload, which would otherwise stop at the close warning. */
export function useTypedUnsaved() {
  const [typed, setTyped] = useState(false)
  useUnsaved(typed)
  useUpdateBlocker(typed)
  return { typed: () => setTyped(true), reset: () => setTyped(false) }
}

/** Props for an uncontrolled field that saves on blur and is keyed by its
    `saved` value. They hold a lease from the first keystroke until a blur
    leaves nothing unsent, which they check once the field's own blur
    handler has run. A blur while `paused()` holds keeps the lease when the
    field still shows another value than the saved one, because the save
    was refused and the draft stays. A new saved value remounts the field
    and ends the draft, and the lease with it. */
export function useFieldUnsaved(paused: () => boolean, saved: string) {
  const { typed, reset } = useTypedUnsaved()
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new saved value is the trigger
  useLayoutEffect(reset, [saved])
  return {
    onInput: typed,
    onBlurCapture: (event: FocusEvent<HTMLInputElement>) => {
      const field = event.currentTarget
      setTimeout(() => {
        const same =
          field.value === field.defaultValue ||
          (field.type === 'number' &&
            field.value.trim() !== '' &&
            Number(field.value) === Number(field.defaultValue))
        if (!paused() || same) reset()
      }, 0)
    },
  }
}

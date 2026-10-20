import { type FocusEvent, useLayoutEffect, useState } from 'react'

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

/** Warns before the page unloads while `unsaved()` holds. Answers a function
    that removes the handler. */
export function installLeaveGuard(unsaved: () => boolean, win: Window = window) {
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!unsaved()) return
    event.preventDefault()
    // older browsers show the warning only for a returnValue
    event.returnValue = ''
  }
  win.addEventListener('beforeunload', onBeforeUnload)
  return () => win.removeEventListener('beforeunload', onBeforeUnload)
}

/** Holds a lease from the person's first keystroke in a form until `reset`,
    for fields that keep typed text without a draft state of their own. Put
    `typed` on the form's `onInputCapture`. */
export function useTypedUnsaved() {
  const [typed, setTyped] = useState(false)
  useUnsaved(typed)
  return { typed: () => setTyped(true), reset: () => setTyped(false) }
}

/** Props for an uncontrolled field that saves on blur. They hold a lease
    from the first keystroke until a blur leaves nothing unsent, which they
    check once the field's own blur handler has run. A blur while `paused()`
    holds keeps the lease when the field still shows text other than its
    saved value, because the save was refused and the draft stays. */
export function useFieldUnsaved(paused: () => boolean) {
  const { typed, reset } = useTypedUnsaved()
  return {
    onInput: typed,
    onBlurCapture: (event: FocusEvent<HTMLInputElement>) => {
      const field = event.currentTarget
      setTimeout(() => {
        if (!paused() || field.value === field.defaultValue) reset()
      }, 0)
    },
  }
}

/* The removal press of the Settings pages that take access away: a team's
   Delete on Teams, a member's Remove on a team's page, and a person's or a
   team's Remove in a project's access editor. One hook beside the removal
   window, so the three pages share its code, and each page that calls it
   holds its own press. It lives apart from Modals.tsx, which exports
   components only. */
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useFocusAfterRender } from '../lib/focusWhenGone'
import { type AccessRemoval, P, type RemovalAnswer } from '../store/planner'
import { AccessRemovalModal } from './Modals'

/* One removal as a key, to tell the pressed control apart. */
const keyOf = (change: AccessRemoval) => JSON.stringify(change)

/** What a press says while another removal of the page is being checked,
    as it then removes nothing. */
const REMOVAL_BUSY = 'Another removal is still being checked. Try again once it finishes.'

/**
 * The press that starts a removal on a Settings page, and the removal
 * window it may open. `press(change, focus)` asks the server's preview
 * (P.startRemoval). While another press of the page is being checked it
 * removes nothing and says so (REMOVAL_BUSY), as only the pressed control
 * is disabled. When the answer asks, it opens the window with it, and
 * `focus` takes focus as the window closes; otherwise the store has done
 * what the answer called for, and `focus` takes focus once the page renders
 * the outcome, after the pressed control is enabled again.
 * `checking(change)` says whether that removal is being checked, so the
 * page can disable its control (aria-busy, store/planner.ts
 * REMOVAL_CHECKING). `window` is the open window, or null, for the page to
 * render. Leaving the page drops the answer, and one that arrives after
 * that does nothing.
 */
export function useAccessRemoval(): {
  press: (change: AccessRemoval, focus: () => HTMLElement | null) => void
  checking: (change: AccessRemoval) => boolean
  window: ReactNode
} {
  const [checking, setChecking] = useState<string | null>(null)
  // the same, at once, so a second press before the render sends nothing
  const busy = useRef(false)
  const [open, setOpen] = useState<{ change: AccessRemoval; answer: RemovalAnswer } | null>(null)
  const focusRef = useRef<() => HTMLElement | null>(() => null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const focusAfterRender = useFocusAfterRender()
  const press = (change: AccessRemoval, focus: () => HTMLElement | null) => {
    if (busy.current) {
      window.showToast?.(REMOVAL_BUSY, 'info')
      return
    }
    busy.current = true
    focusRef.current = focus
    setChecking(keyOf(change))
    void P.startRemoval(change, () => mounted.current).then((answer) => {
      busy.current = false
      if (!mounted.current) return
      // the control is enabled again before focus moves to a target
      setChecking(null)
      if (answer) setOpen({ change, answer })
      else focusAfterRender(focus)
    })
  }
  return {
    press,
    checking: (change) => checking === keyOf(change),
    window: open && (
      <AccessRemovalModal
        key={keyOf(open.change)}
        change={open.change}
        answer={open.answer}
        onClose={() => setOpen(null)}
        focusAfterClose={() => focusRef.current()}
      />
    ),
  }
}

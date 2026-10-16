/* The timing behind every in-place "click again to confirm" button in the
   planner and the operator console. It imports nothing from the planner
   store, so the console can use it too. */
import { useCallback, useEffect, useRef, useState } from 'react'

/** A click this soon after arming is ignored, so a double click cannot arm and confirm at once. */
export const CONFIRM_IGNORE_MS = 500
/** An armed control that is not clicked again disarms after this long. */
export const CONFIRM_DISARM_MS = 3500

/** In-place "click again to confirm". `press(key, action)` arms `key` on the
    first click. Another click on the same key within CONFIRM_IGNORE_MS is
    ignored and leaves it armed. A later click disarms and then runs
    `action`, so a click while an async action runs arms the key again
    instead of sending the action twice. Every arm lapses CONFIRM_DISARM_MS
    after it was set, and a click after that arms again even when the lapse
    timer has not run yet. One hook holds one armed key, so rows that share it
    disarm each other, and a single button passes a constant key. `disarm`
    drops the arm when something else happens first. `press` and `disarm`
    keep their identity across renders. */
export function useConfirmArm<K extends string>() {
  const [armed, setArmed] = useState<K | null>(null)
  // Handlers read these refs, so two clicks before a re-render count once.
  const current = useRef<K | null>(null)
  const armedAt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const set = useCallback((key: K | null) => {
    clearTimeout(timer.current)
    current.current = key
    setArmed(key)
    if (key === null) return
    armedAt.current = Date.now()
    timer.current = setTimeout(() => {
      current.current = null
      setArmed(null)
    }, CONFIRM_DISARM_MS)
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])

  const press = useCallback(
    (key: K, action: () => void) => {
      const held = Date.now() - armedAt.current
      // A browser can run the lapse timer late, for example in a background
      // tab, so an arm older than CONFIRM_DISARM_MS counts as lapsed here too.
      if (current.current !== key || held >= CONFIRM_DISARM_MS) {
        set(key)
        return
      }
      if (held < CONFIRM_IGNORE_MS) return
      set(null)
      action()
    },
    [set],
  )
  const disarm = useCallback(() => set(null), [set])
  return { armed, press, disarm }
}

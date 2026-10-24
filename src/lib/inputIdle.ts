import { useEffect } from 'react'
import { useLatest } from './useLatest'

/** What counts as the person using the app. */
const INPUTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'] as const

/** Calls `onIdle` once `ms` pass with no pointer, key, touch or wheel input
    in the page, whether it is visible or not, and again each time `ms` pass
    without input after that. Any input starts the wait again. The clock is
    the wall clock, so a computer that slept counts the time it slept. */
export function useInputIdle(ms: number, onIdle: () => void) {
  const idle = useLatest(onIdle)
  useEffect(() => {
    let last = Date.now()
    let timer = 0
    const input = () => {
      last = Date.now()
    }
    // the timer is not moved on every input: it looks again when it fires
    const check = () => {
      const left = last + ms - Date.now()
      if (left <= 0) {
        idle()
        last = Date.now()
      }
      timer = window.setTimeout(check, left <= 0 ? ms : left)
    }
    timer = window.setTimeout(check, ms)
    for (const name of INPUTS)
      window.addEventListener(name, input, { capture: true, passive: true })
    return () => {
      window.clearTimeout(timer)
      for (const name of INPUTS) window.removeEventListener(name, input, { capture: true })
    }
  }, [ms, idle])
}

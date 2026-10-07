import { isoFromDate } from './dates'

/** Refresh at local midnight and after sleep. Calendar arithmetic preserves DST days. */
export function watchLocalDay(receive: (now: Date) => void, now = () => new Date()): () => void {
  let stopped = false
  let day: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = () => {
    if (stopped) return
    clearTimeout(timer)
    const current = now()
    const nextDay = isoFromDate(current)
    if (nextDay !== day) {
      day = nextDay
      receive(current)
    }
    const midnight = new Date(current)
    midnight.setHours(24, 0, 0, 0)
    if (!stopped) timer = setTimeout(check, midnight.getTime() - current.getTime())
  }
  const onVisibility = () => {
    if (document.visibilityState === 'visible') check()
  }
  window.addEventListener('focus', check)
  window.addEventListener('pageshow', check)
  document.addEventListener('visibilitychange', onVisibility)
  check()
  return () => {
    stopped = true
    clearTimeout(timer)
    window.removeEventListener('focus', check)
    window.removeEventListener('pageshow', check)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

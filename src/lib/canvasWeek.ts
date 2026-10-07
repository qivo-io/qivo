const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Refresh the weekly selection at Monday 00:00 UTC, including after a suspended tab wakes. */
export function watchCanvasWeek(receive: (date: string) => void): () => void {
  let stopped = false
  let currentWeek: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const check = () => {
    if (stopped) return
    clearTimeout(timer)

    const now = new Date()
    const monday = new Date(now)
    monday.setUTCHours(0, 0, 0, 0)
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
    const week = monday.getTime()
    if (week !== currentWeek) {
      currentWeek = week
      receive(now.toISOString().slice(0, 10))
    }

    if (!stopped) timer = setTimeout(check, week + WEEK_MS - now.getTime())
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') check()
  }

  window.addEventListener('focus', check)
  window.addEventListener('pageshow', check)
  document.addEventListener('visibilitychange', onVisibilityChange)
  check()

  return () => {
    stopped = true
    clearTimeout(timer)
    window.removeEventListener('focus', check)
    window.removeEventListener('pageshow', check)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

/* Tells the page when the computer wakes from sleep, so the app's
   notification leader runs its resume order at once (a beat, then the
   catch-up, then claims; src/lib/notificationLeader.ts) rather than at its
   next timer gap or reconnect. No suspend is forwarded: the session's three
   minutes of liveness cover a sleep, and the next input elsewhere moves
   the alerts. */

/** The channel the page hears a wake on (preload.cts power.onResume). */
export const POWER_RESUME = 'qivo:power:resume'

/** What forwardResume needs of Electron's powerMonitor. */
export type ResumeSource = {
  on(event: 'resume', listener: () => void): unknown
  removeListener(event: 'resume', listener: () => void): unknown
}

/** What forwardResume sends to: the main window, while one exists. */
export type ResumeTarget = {
  isDestroyed(): boolean
  webContents: { send(channel: string): void }
}

/**
 * Sends POWER_RESUME, with no payload, to the window `target()` answers on
 * each `resume` of `monitor`, and nothing while there is no window or it
 * was destroyed. Answers the way to stop.
 */
export function forwardResume(
  monitor: ResumeSource,
  target: () => ResumeTarget | null,
): () => void {
  const listener = () => {
    const win = target()
    if (!win || win.isDestroyed()) return
    win.webContents.send(POWER_RESUME)
  }
  monitor.on('resume', listener)
  return () => {
    monitor.removeListener('resume', listener)
  }
}

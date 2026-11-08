/* A stand-in for the notification session functions the app's desktop
   alert client calls (convex/notifications.ts beat, claimAlerts and
   claimSummary), for the jsdom store tests that turn notifications on and
   for the browser benchmark's server (scripts/perf/server.mjs). It keeps
   one session's records and nothing else: a beat answers the default
   mode's pace (one minute while the session can notify, else six hours),
   three minutes of liveness and the time; a claim grants each key once and
   records it, never `limited`, `not_target` or `summarize_first`; and a
   summary answers `none`, or `summary` once after summaryNext(), as after
   a sleep or a lost connection with something new. The server's own rules,
   its floors, targets and handoffs, are convex-test's
   (convex/tests/notificationFeedClient.test.ts), which this stand-in does
   not copy. It imports nothing the benchmark's worker cannot load. */

/** One call the stand-in answered, with its arguments. */
export type NotificationCall = { name: string; args: Record<string, unknown> }

/** The function names the stand-in answers. */
export const NOTIFICATION_CALLS = [
  'notifications:beat',
  'notifications:claimAlerts',
  'notifications:claimSummary',
] as const

/** A stand-in of one session's notification functions, whose `now` is the
    server's clock. */
export function createNotificationsStandIn(now: () => number = () => Date.now()) {
  const granted = new Set<string>()
  const calls: NotificationCall[] = []
  let summaryNext = false
  return {
    /** Every call answered, oldest first. */
    calls,
    /** Makes the next claimSummary answer `summary`. */
    summaryNext() {
      summaryNext = true
    },
    /** Whether the stand-in answers function `name`. */
    answers: (name: string) => (NOTIFICATION_CALLS as readonly string[]).includes(name),
    /** What function `name` answers `args`. */
    answer(name: string, args: Record<string, unknown>): unknown {
      calls.push({ name, args })
      if (name === 'notifications:beat')
        return {
          every_ms: args.can_notify === true ? 60_000 : 21_600_000,
          live_ms: 180_000,
          now: now(),
        }
      if (name === 'notifications:claimAlerts') {
        const events = (args.events ?? []) as { key: string }[]
        const keys: string[] = []
        for (const { key } of events)
          if (!granted.has(key)) {
            granted.add(key)
            keys.push(key)
          }
        return { state: 'granted', keys, limited: false }
      }
      if (name === 'notifications:claimSummary') {
        const summary = summaryNext
        summaryNext = false
        return { state: summary ? 'summary' : 'none' }
      }
      throw new Error(`the notifications stand-in does not answer ${name}`)
    },
  }
}

export type NotificationsStandIn = ReturnType<typeof createNotificationsStandIn>

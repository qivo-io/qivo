/* A stand-in for the notification session functions the app calls
   (convex/notifications.ts): the leader tab's beat and end and its watch
   of settings, the Notification delivery field's settings and setDelivery,
   and the alert client's claimAlerts and claimSummary. It serves the jsdom
   tests that turn notifications on or render the field, and the browser
   benchmark's server (scripts/perf/server.mjs). It keeps one account's
   mode, `recent` until a setDelivery, and one session's records and
   nothing else: a beat answers the server's pace for the mode (one minute
   in `recent` while the session can notify, else six hours), three
   minutes of liveness and the time; setDelivery answers the mode and, when
   it changed, sends settings again to every watch; end answers null; a
   claim grants each key once and records it, never `limited`, `not_target`
   or `summarize_first`; and a summary answers `none`, or `summary` once
   after summaryNext(), as after a sleep or a lost connection with
   something new. `force` makes settings never answer (`loading`) or fail
   (`failed`), and setDelivery refuse with the demo's sentence
   (`demo-limit`). The server's own rules, its floors, targets and
   handoffs, are convex-test's (convex/tests/notificationFeedClient.test.ts),
   which this stand-in does not copy; store/notificationsParity.test.ts
   holds its answers to the server's for settings, setDelivery, beat and
   end. It imports nothing the benchmark's worker cannot load. */

/** One call the stand-in answered, with its arguments. */
export type NotificationCall = { name: string; args: Record<string, unknown> }

/** The mutation names the stand-in answers. */
export const NOTIFICATION_CALLS = [
  'notifications:beat',
  'notifications:end',
  'notifications:setDelivery',
  'notifications:claimAlerts',
  'notifications:claimSummary',
] as const

/** The query the stand-in answers. */
export const NOTIFICATION_SETTINGS = 'notifications:settings'

/** The delivery mode. */
type Delivery = 'recent' | 'all'

/** The states a test or a page forces. */
export type ForcedNotifications = {
  settings?: 'loading' | 'failed'
  setDelivery?: 'demo-limit'
}

/** The demo's refusal of a change past its limit, as convex/lib/demo.ts
    words it. */
export const DEMO_CHANGE_LIMIT = 'Your demo has reached its change limit. Try again later.'

/** The server's pace: a minute in `recent` for a session that can notify,
    else six hours (convex/model/notificationSessions.ts NOTIFY). */
const BEAT_MS = 60_000
const IDLE_BEAT_MS = 21_600_000
const LIVE_MS = 180_000

/** A stand-in of one account's and one session's notification functions,
    whose `now` is the server's clock and whose mode starts as `delivery`. */
export function createNotificationsStandIn(
  now: () => number = () => Date.now(),
  delivery: Delivery = 'recent',
) {
  const granted = new Set<string>()
  const calls: NotificationCall[] = []
  const watches = new Set<(value: { delivery: Delivery }) => void>()
  let mode = delivery
  let summaryNext = false
  return {
    /** Every call answered, oldest first. */
    calls,
    /** Makes the next claimSummary answer `summary`. */
    summaryNext() {
      summaryNext = true
    },
    /** The mode the stand-in holds. */
    delivery: () => mode,
    /** Whether the stand-in answers mutation `name`. */
    answers: (name: string) => (NOTIFICATION_CALLS as readonly string[]).includes(name),
    /** What settings answers, or 'loading' for no answer, or throws as
        `force` asks. */
    settings(force: ForcedNotifications = {}): { delivery: Delivery } | 'loading' {
      if (force.settings === 'loading') return 'loading'
      if (force.settings === 'failed') throw new Error('notifications.settings fails, as forced')
      return { delivery: mode }
    },
    /** Watches settings: answers at once and after each change, fails at
        once, or never answers, as `force` asks. Answers the way to stop. */
    watch(
      next: (value: { delivery: Delivery }) => void,
      fail: (error: Error) => void,
      force: ForcedNotifications = {},
    ): () => void {
      if (force.settings === 'loading') return () => {}
      if (force.settings === 'failed') {
        fail(new Error('notifications.settings fails, as forced'))
        return () => {}
      }
      watches.add(next)
      next({ delivery: mode })
      return () => {
        watches.delete(next)
      }
    },
    /** What mutation `name` answers `args`, or throws as `force` asks. */
    answer(name: string, args: Record<string, unknown>, force: ForcedNotifications = {}): unknown {
      calls.push({ name, args })
      if (name === 'notifications:beat')
        return {
          every_ms: mode === 'recent' && args.can_notify === true ? BEAT_MS : IDLE_BEAT_MS,
          live_ms: LIVE_MS,
          now: now(),
        }
      if (name === 'notifications:end') return null
      if (name === 'notifications:setDelivery') {
        // the refusal's data, as Convex sends a ConvexError's
        if (force.setDelivery === 'demo-limit')
          throw Object.assign(new Error(DEMO_CHANGE_LIMIT), {
            data: { code: 'forbidden', message: DEMO_CHANGE_LIMIT, reason: 'demo_limit' },
          })
        const next = args.delivery === 'all' ? 'all' : 'recent'
        if (next !== mode) {
          mode = next
          for (const watch of watches) watch({ delivery: mode })
        }
        return { delivery: mode }
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

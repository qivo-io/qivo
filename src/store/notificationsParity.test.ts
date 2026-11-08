/* The notification stand-in (store/notificationsStandIn.setup.ts) held to
 * the real session functions (convex/notifications.ts) for the calls the
 * leader tab and the Notification delivery field make: settings,
 * setDelivery, beat and end, in one sequence run on convex-test as one
 * planted Better Auth session and on the stand-in, answer by answer, with
 * the clock fixed so `now` agrees. The claims are the feed client's
 * (convex/tests/notificationFeedClient.test.ts), which the stand-in does
 * not copy. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import {
  NOW,
  newT,
  runInAuth,
  type T,
  uuid,
  withReadingAdmin,
} from '../../convex/tests/helpers.setup'
import { createNotificationsStandIn } from './notificationsStandIn.setup'

const DAY = 86_400_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse(NOW))
})
afterEach(() => {
  vi.useRealTimers()
})

/** A live Better Auth session of login `authUserId`, and its caller. */
async function session(t: T, authUserId: string) {
  const now = Date.now()
  const sessionId: string = await runInAuth(t, (ctx) =>
    ctx.db.insert('session', {
      token: uuid(),
      userId: authUserId,
      expiresAt: now + 7 * DAY,
      createdAt: now,
      updatedAt: now,
    }),
  )
  return t.withIdentity({ subject: authUserId, sessionId })
}

/** One step of the sequence: a call and its arguments. */
type Step =
  | { name: 'settings' }
  | { name: 'setDelivery'; args: { delivery: 'recent' | 'all' } }
  | { name: 'beat'; args: { instance: string; can_notify: boolean; active: boolean } }
  | { name: 'end'; args: { instance: string } }

const beat = (can_notify: boolean, active = false): Step => ({
  name: 'beat',
  args: { instance: 'tab-1', can_notify, active },
})

/* A session's life: its first beat, a report, the switch to All enabled
   sessions and back, a beat that cannot notify, the same mode again, and
   the end at the last tab's close. */
const SEQUENCE: Step[] = [
  { name: 'settings' },
  beat(true),
  beat(true, true),
  { name: 'setDelivery', args: { delivery: 'all' } },
  { name: 'settings' },
  beat(true),
  beat(false),
  { name: 'setDelivery', args: { delivery: 'all' } },
  { name: 'setDelivery', args: { delivery: 'recent' } },
  { name: 'settings' },
  beat(true, true),
  { name: 'end', args: { instance: 'tab-1' } },
  { name: 'end', args: { instance: 'another-tab' } },
]

describe('the notification stand-in', () => {
  it('answers settings, setDelivery, beat and end as the server does', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const caller = await session(t, f.guest.auth_user_id as string)
    const stand = createNotificationsStandIn()
    for (const step of SEQUENCE) {
      vi.setSystemTime(Date.now() + 20_000)
      const server =
        step.name === 'settings'
          ? await caller.query(api.notifications.settings, {})
          : step.name === 'setDelivery'
            ? await caller.mutation(api.notifications.setDelivery, step.args)
            : step.name === 'beat'
              ? await caller.mutation(api.notifications.beat, step.args)
              : await caller.mutation(api.notifications.end, step.args)
      const standIn =
        step.name === 'settings'
          ? stand.settings()
          : stand.answer(`notifications:${step.name}`, step.args)
      expect(standIn, `${step.name} ${JSON.stringify('args' in step ? step.args : {})}`).toEqual(
        server,
      )
    }
  })

  it('refuses setDelivery past the demo’s limit with the server’s sentence and data', () => {
    const stand = createNotificationsStandIn()
    let refusal: unknown
    try {
      stand.answer('notifications:setDelivery', { delivery: 'all' }, { setDelivery: 'demo-limit' })
    } catch (e) {
      refusal = e
    }
    expect(refusal).toMatchObject({
      message: 'Your demo has reached its change limit. Try again later.',
      data: {
        code: 'forbidden',
        message: 'Your demo has reached its change limit. Try again later.',
        reason: 'demo_limit',
      },
    })
    expect(stand.delivery()).toBe('recent')
  })
})

/* The nightly audit log expiry (auditRetention.ts): rows from before the
 * 90-day cutoff go, newer rows stay, a backlog larger than one step is
 * deleted in chained steps, and each run writes one expire_audit_log row. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import { AUDIT_EXPIRY, AUDIT_RETENTION_DAYS } from '../auditRetention'
import { newT, type T } from './helpers.setup'

const NOW = Date.parse('2026-10-19T04:45:00.000Z')
const DAY = 86_400_000
const DEFAULT_EXPIRY = { ...AUDIT_EXPIRY }

afterEach(() => {
  Object.assign(AUDIT_EXPIRY, DEFAULT_EXPIRY)
  vi.useRealTimers()
})

/* Plants one audit row `days` days before NOW. */
const plant = (t: T, days: number, action = 'invite_member') =>
  t.run((ctx) =>
    ctx.db.insert('platform_audit_log', {
      ts: new Date(NOW - days * DAY).toISOString(),
      actor_email: 'operator@example.com',
      action,
      detail: { email: 'invitee@example.com' },
    }),
  )

const rows = (t: T) => t.run((ctx) => ctx.db.query('platform_audit_log').collect())

/* Runs one expiry from empty arguments, and every step it schedules, at NOW. */
async function expire(t: T) {
  vi.useFakeTimers({ now: NOW })
  await t.mutation(internal.auditRetention.expire, {})
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
}

describe('audit log expiry', () => {
  it('deletes rows older than the retention period and keeps the rest', async () => {
    const t = newT()
    await plant(t, AUDIT_RETENTION_DAYS + 1)
    await plant(t, AUDIT_RETENTION_DAYS + 400, 'recovery_link')
    const kept = await plant(t, AUDIT_RETENTION_DAYS - 1)
    const today = await plant(t, 0)

    await expire(t)

    const left = await rows(t)
    expect(left.filter((r) => r.action !== 'expire_audit_log').map((r) => r._id)).toEqual([
      kept,
      today,
    ])
    expect(left.filter((r) => r.action === 'expire_audit_log')).toMatchObject([
      {
        actor_email: 'system',
        detail: { deleted: 2, before: new Date(NOW - AUDIT_RETENTION_DAYS * DAY).toISOString() },
      },
    ])
  })

  it('deletes a backlog larger than one step in chained steps with one row for the run', async () => {
    const t = newT()
    Object.assign(AUDIT_EXPIRY, { page: 2 })
    for (let n = 0; n < 5; n++) await plant(t, AUDIT_RETENTION_DAYS + 1 + n)
    await plant(t, 10)

    await expire(t)

    const left = await rows(t)
    expect(left.map((r) => r.action).sort()).toEqual(['expire_audit_log', 'invite_member'])
    expect(left.find((r) => r.action === 'expire_audit_log')?.detail).toMatchObject({ deleted: 5 })
  })

  it('writes a row with zero deleted when nothing is old enough', async () => {
    const t = newT()
    await plant(t, AUDIT_RETENTION_DAYS - 1)

    await expire(t)

    const left = await rows(t)
    expect(left).toHaveLength(2)
    expect(left.find((r) => r.action === 'expire_audit_log')?.detail).toMatchObject({ deleted: 0 })
  })
})

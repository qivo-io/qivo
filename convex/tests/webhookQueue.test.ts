import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import type { EventOwner } from '../lib/taskEvents'
import { archiveIssueCore } from '../model/issues'
import { emitTaskEvent } from '../model/taskEvents'
import {
  dispatchWebhooksRef,
  expandWebhookEventsRef,
  runWebhookWorkerRef,
} from '../model/webhookQueue'
import { flushWebhookEvents, newT, plantIssue, type T, uuid, withOrg } from './helpers.setup'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime('2026-10-04T12:00:00Z')
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

async function fixture() {
  const t = newT({ transactionLimits: true })
  const fx = await withOrg(t)
  const owner = await t.run(async (ctx): Promise<EventOwner> => {
    const id = uuid()
    const row = await ctx.db.insert('mcp_tokens', {
      id,
      profile_id: fx.guest.id,
      name: 'Queue tests',
      token_prefix: 'qvt_test',
      token_hash: 'test',
      created_at: new Date().toISOString(),
    })
    return {
      profile_id: fx.guest.id,
      credential_table: 'mcp_tokens',
      credential_id: id,
      credential_row_id: row,
    }
  })
  const issue = await plantIssue(t, { org_id: fx.org.id, project_id: fx.sub.id })
  const subscribe = (index = 0) =>
    t.mutation(internal.webhooks.save, {
      owner,
      id: uuid(),
      name: 'task.updated',
      filters: {},
      url: `https://receiver.example/${index}`,
      encrypted_secret: 'test-key',
    })
  const emit = async () => {
    await t.run((ctx) =>
      emitTaskEvent(ctx, {
        name: 'task.updated',
        issue: { ...issue, title: 'Updated task' },
        before: issue,
        actor: fx.user,
        now: new Date().toISOString(),
      }),
    )
    await flushWebhookEvents(t)
  }
  const rows = () => t.run((ctx) => ctx.db.query('webhook_deliveries').collect())
  return { t, fx, issue, subscribe, emit, rows }
}

async function readWorker(t: T, kind: 'expand' | 'dispatch') {
  return t.run((ctx) =>
    ctx.db
      .query('webhook_workers')
      .withIndex('by_kind', (q) => q.eq('kind', kind))
      .unique(),
  )
}

async function reservedWorker(t: T, kind: 'expand' | 'dispatch') {
  await t.mutation(kind === 'expand' ? expandWebhookEventsRef : dispatchWebhooksRef, {})
  const worker = await readWorker(t, kind)
  if (!worker) throw new Error('Webhook worker was not reserved')
  return worker
}

async function dispatchQueue(t: T): Promise<void> {
  const worker = (await readWorker(t, 'dispatch')) ?? (await reservedWorker(t, 'dispatch'))
  await t.mutation(runWebhookWorkerRef, { kind: 'dispatch', generation: worker.generation })
}

/** Inspect the batch's new jobs without executing network delivery actions. */
async function recordJobs(
  t: T,
  calls: { name: string; delay: number }[],
  run?: () => Promise<unknown>,
): Promise<void> {
  if (!run) {
    const worker = (await readWorker(t, 'dispatch')) ?? (await reservedWorker(t, 'dispatch'))
    run = () => t.mutation(runWebhookWorkerRef, { kind: 'dispatch', generation: worker.generation })
  }
  const before = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
  const ids = new Set(before.map((job) => job._id))
  await run()
  const after = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
  for (const job of after) {
    if (!ids.has(job._id)) calls.push({ name: job.name, delay: job.scheduledTime - Date.now() })
  }
}

describe('bounded durable webhook dispatch', () => {
  it.each(['expand', 'dispatch'] as const)(
    'coalesces %s wakes, recovers cancellation, and fences stale generations',
    async (kind) => {
      const f = await fixture()
      const first = await reservedWorker(f.t, kind)
      const calls: { name: string; delay: number }[] = []
      for (let wake = 0; wake < 20; wake++)
        await recordJobs(f.t, calls, () => reservedWorker(f.t, kind))
      expect(calls).toEqual([])
      vi.setSystemTime(Date.now() + 120_000)
      expect((await reservedWorker(f.t, kind)).generation).toBe(first.generation)
      await f.t.run((ctx) => ctx.scheduler.cancel(first.scheduled_job))
      const replacement = await reservedWorker(f.t, kind)
      expect(replacement.generation).not.toBe(first.generation)
      await f.t.mutation(runWebhookWorkerRef, { kind, generation: first.generation })
      expect((await readWorker(f.t, kind))?.generation).toBe(replacement.generation)
      await f.t.mutation(runWebhookWorkerRef, { kind, generation: replacement.generation })
      expect(await f.t.run((ctx) => ctx.db.query('webhook_workers').collect())).toEqual([])
      calls.length = 0
      await recordJobs(f.t, calls, () =>
        f.t.mutation(runWebhookWorkerRef, { kind, generation: replacement.generation }),
      )
      expect(calls).toEqual([])
    },
  )

  it.each(['expand', 'dispatch'] as const)(
    'guarantees one fresh %s pass after repeated wakes on a live reservation',
    async (kind) => {
      const f = await fixture()
      const worker = await reservedWorker(f.t, kind)
      for (let wake = 0; wake < 20; wake++) await reservedWorker(f.t, kind)
      expect((await readWorker(f.t, kind))?.rerun).toBe(true)
      const calls: { name: string; delay: number }[] = []
      await recordJobs(f.t, calls, () =>
        f.t.mutation(runWebhookWorkerRef, { kind, generation: worker.generation }),
      )
      expect(calls).toEqual([{ name: 'webhookQueue:run', delay: 0 }])
      const successor = (await readWorker(f.t, kind))!
      expect(successor.generation).not.toBe(worker.generation)
      expect(successor.rerun).toBe(false)
      calls.length = 0
      await recordJobs(f.t, calls, () =>
        f.t.mutation(runWebhookWorkerRef, { kind, generation: successor.generation }),
      )
      expect(calls).toEqual([])
      expect(await readWorker(f.t, kind)).toBeNull()
    },
  )

  it('archives 51 tasks for 20 guest callbacks atomically, then expands and dispatches bounded work', async () => {
    const f = await fixture()
    for (let index = 0; index < 20; index++) await f.subscribe(index)
    for (let index = 0; index < 50; index++)
      await plantIssue(f.t, {
        org_id: f.fx.org.id,
        project_id: f.fx.sub.id,
        parent_id: f.issue.id,
      })
    const calls: { name: string; delay: number }[] = []
    await f.t.run(async (ctx) => {
      const result = await archiveIssueCore(ctx, {
        me: f.fx.user,
        issue: f.issue,
        now: new Date().toISOString(),
      })
      expect(result.descendants).toBe(50)
    })
    expect(await f.rows()).toHaveLength(0)
    expect(await f.t.run((ctx) => ctx.db.query('webhook_events').collect())).toHaveLength(51)
    const jobs = await f.t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    expect(jobs.map((job) => ({ name: job.name, delay: job.scheduledTime - Date.now() }))).toEqual([
      { name: 'webhookQueue:expand', delay: 0 },
    ])

    await flushWebhookEvents(f.t)
    expect(await f.rows()).toHaveLength(1020)
    await recordJobs(f.t, calls)
    expect(calls.filter((call) => call.name === 'webhookActions:deliver')).toHaveLength(5)
    expect(calls.filter((call) => call.name === 'webhookQueue:run')).toEqual([
      { name: 'webhookQueue:run', delay: 0 },
    ])
    const queued = (await f.rows()).filter((row) => row.status === 'queued')
    expect(queued).toHaveLength(5)
    expect(new Set(queued.map((row) => row.subscription_row_id)).size).toBe(5)
    expect(queued.every((row) => row.scheduled_job !== undefined)).toBe(true)
  })

  it.each(['queued', 'sending'] as const)(
    'retains a canceled %s reservation until its deadline, then recovers its slot',
    async (status) => {
      const f = await fixture()
      for (let index = 0; index < 6; index++) await f.subscribe(index)
      await f.emit()
      await dispatchQueue(f.t)
      const rows = await f.rows()
      const reserved = rows[0]
      if (status === 'sending')
        expect(await f.t.mutation(internal.webhooks.claim, { id: reserved.id })).not.toBeNull()
      await f.t.run((ctx) => ctx.scheduler.cancel(reserved.scheduled_job!))
      expect(await f.t.mutation(internal.webhooks.claim, { id: rows[5].id })).toBeNull()
      expect((await f.rows())[0].status).toBe(status)
      vi.setSystemTime(reserved.scheduled_for!)
      expect(await f.t.mutation(internal.webhooks.claim, { id: rows[5].id })).not.toBeNull()
      expect((await f.rows())[0]).toMatchObject({ status: 'pending' })
      expect((await f.rows()).filter((row) => row.status === 'queued')).toHaveLength(4)
    },
  )

  it('keeps pending scheduler jobs after a minute and recovers canceled jobs and expired leases', async () => {
    const f = await fixture()
    await f.subscribe()
    await f.emit()
    const original = (await f.rows())[0]
    await dispatchQueue(f.t)
    const reserved = (await f.rows())[0]
    expect(reserved).toMatchObject({
      status: 'queued',
      attempts: 0,
      scheduled_for: Date.now() + 60_000,
    })
    expect(reserved.scheduled_job).toBeDefined()
    vi.setSystemTime(reserved.scheduled_for!)
    const calls: { name: string; delay: number }[] = []
    await recordJobs(f.t, calls)
    expect(calls).toEqual([])
    expect((await f.rows())[0].scheduled_job).toBe(reserved.scheduled_job)

    await f.t.run((ctx) => ctx.scheduler.cancel(reserved.scheduled_job!))
    vi.setSystemTime((await f.rows())[0].scheduled_for!)
    await recordJobs(f.t, calls)
    expect(calls.filter((call) => call.name === 'webhookActions:deliver')).toHaveLength(1)
    expect((await f.t.mutation(internal.webhooks.claim, { id: original.id }))?.attempt).toBe(1)
    const sending = (await f.rows())[0]
    vi.setSystemTime(sending.scheduled_for!)
    calls.length = 0
    await recordJobs(f.t, calls)
    expect(calls).toEqual([])
    await f.t.run((ctx) => ctx.scheduler.cancel(sending.scheduled_job!))
    vi.setSystemTime((await f.rows())[0].scheduled_for!)
    await dispatchQueue(f.t)
    const recovered = await f.t.mutation(internal.webhooks.claim, { id: original.id })
    expect(recovered?.attempt).toBe(2)
    expect(recovered?.delivery.payload).toBe(original.payload)
    await f.t.mutation(internal.webhooks.finish, { id: original.id, attempt: 2, status: 204 })
    expect((await f.rows())[0].status).toBe('delivered')
  })

  it.each([1, 6])(
    'recovers stale reservations across %s subscriptions without deadlock',
    async (subscriptions) => {
      const f = await fixture()
      for (let index = 0; index < subscriptions; index++) await f.subscribe(index)
      await f.emit()
      if (subscriptions === 1) await f.emit()
      await f.t.run(async (ctx) => {
        for (const row of await ctx.db.query('webhook_deliveries').collect())
          await ctx.db.patch(row._id, {
            status: 'sending',
            attempts: 1,
            lease_until: Date.now() - 1,
            scheduled_for: Date.now() - 1,
            scheduled_job: undefined,
          })
      })
      const calls: { name: string; delay: number }[] = []
      await recordJobs(f.t, calls)
      const queued = (await f.rows()).filter((row) => row.status === 'queued')
      expect(queued).toHaveLength(Math.min(subscriptions, 5))
      expect(new Set(queued.map((row) => row.subscription_row_id)).size).toBe(queued.length)
      expect(calls.filter((call) => call.name === 'webhookActions:deliver')).toHaveLength(
        queued.length,
      )
    },
  )

  it('does not hide a live action behind more than 50 stale reservations', async () => {
    const f = await fixture()
    await f.subscribe()
    await f.emit()
    await dispatchQueue(f.t)
    const live = (await f.rows())[0]
    await f.t.run(async (ctx) => {
      const { _id: _row, _creationTime: _created, ...delivery } = live
      for (let index = 0; index < 51; index++)
        await ctx.db.insert('webhook_deliveries', {
          ...delivery,
          id: uuid(),
          scheduled_job: undefined,
          scheduled_for: Date.now() - 1,
        })
    })
    for (let round = 0; round < 8; round++) {
      const calls: { name: string; delay: number }[] = []
      await recordJobs(f.t, calls)
      expect(calls.filter((call) => call.name === 'webhookActions:deliver')).toHaveLength(0)
      expect(calls.filter((call) => call.name === 'webhookQueue:run').length).toBeLessThanOrEqual(1)
      expect(
        calls.every(
          (call) =>
            ['webhookQueue:dispatch', 'webhookQueue:run'].includes(call.name) && call.delay === 0,
        ),
      ).toBe(true)
      expect((await f.rows()).find((row) => row.id === live.id)?.scheduled_job).toBe(
        live.scheduled_job,
      )
    }
    expect((await f.rows()).filter((row) => row.status === 'queued')).toHaveLength(1)
    expect((await f.rows()).filter((row) => row.status === 'pending')).toHaveLength(51)
  })

  it('enforces five organization slots and one per subscription at claim and frees completed slots', async () => {
    const f = await fixture()
    for (let index = 0; index < 6; index++) await f.subscribe(index)
    await f.emit()
    await f.emit()
    const rows = await f.rows()
    for (const row of rows.slice(0, 5))
      expect(await f.t.mutation(internal.webhooks.claim, { id: row.id })).not.toBeNull()
    expect(await f.t.mutation(internal.webhooks.claim, { id: rows[5].id })).toBeNull()
    expect(await f.t.mutation(internal.webhooks.claim, { id: rows[6].id })).toBeNull()
    await f.t.mutation(internal.webhooks.finish, { id: rows[0].id, attempt: 1, status: 204 })
    expect(await f.t.mutation(internal.webhooks.claim, { id: rows[5].id })).not.toBeNull()
    expect(await f.t.mutation(internal.webhooks.claim, { id: rows[6].id })).toBeNull()
    await f.t.mutation(internal.webhooks.finish, { id: rows[5].id, attempt: 1, status: 204 })
    expect(await f.t.mutation(internal.webhooks.claim, { id: rows[6].id })).not.toBeNull()
  })

  it('stops duplicate empty wakes and schedules each retry without a future dispatch chain', async () => {
    const f = await fixture()
    await f.subscribe()
    await f.emit()
    const row = (await f.rows())[0]
    await f.t.mutation(internal.webhooks.claim, { id: row.id })
    const calls: { name: string; delay: number }[] = []
    await recordJobs(f.t, calls, () =>
      f.t.mutation(internal.webhooks.finish, {
        id: row.id,
        attempt: 1,
        status: 503,
      }),
    )
    expect(calls).toEqual([{ name: 'webhookQueue:dispatch', delay: 10_000 }])
    calls.length = 0
    for (let wake = 0; wake < 3; wake++) await recordJobs(f.t, calls)
    expect(calls).toEqual([])
    vi.setSystemTime(Date.now() + 10_000)
    await recordJobs(f.t, calls)
    expect(calls).toEqual([{ name: 'webhookActions:deliver', delay: 0 }])
    calls.length = 0
    for (let minute = 0; minute < 3; minute++) {
      vi.setSystemTime(Date.now() + 60_000)
      await recordJobs(f.t, calls)
    }
    expect(calls).toEqual([])
  })

  it('wakes waiting organization work after a terminal claim refusal without shortening retry backoff', async () => {
    const f = await fixture()
    for (let index = 0; index < 7; index++) await f.subscribe(index)
    await f.emit()
    const original = await f.rows()
    const retry = original[6]
    await f.t.mutation(internal.webhooks.claim, { id: retry.id })
    await f.t.mutation(internal.webhooks.finish, { id: retry.id, attempt: 1, status: 503 })
    const retryAt = Date.now() + 10_000
    await dispatchQueue(f.t)
    expect((await f.rows()).filter((row) => row.status === 'queued')).toHaveLength(5)
    expect((await f.rows()).find((row) => row.id === original[5].id)).toMatchObject({
      status: 'pending',
      scheduled_for: Date.now() + 60_000,
    })
    await f.t.run((ctx) =>
      ctx.db.patch(original[0].subscription_row_id!, {
        disabled_at: Date.now(),
        disabled_reason: 'delivery_failures',
      }),
    )
    const calls: { name: string; delay: number }[] = []
    await recordJobs(f.t, calls, async () => {
      expect(await f.t.mutation(internal.webhooks.claim, { id: original[0].id })).toBeNull()
    })
    expect(calls).toEqual([{ name: 'webhookQueue:dispatch', delay: 0 }])
    const rows = await f.rows()
    expect(rows.find((row) => row.id === original[0].id)).toMatchObject({
      status: 'failed',
      attempts: 0,
    })
    expect(rows.find((row) => row.id === original[5].id)).toMatchObject({
      status: 'pending',
      scheduled_for: Date.now(),
    })
    expect(rows.find((row) => row.id === retry.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lease_until: retryAt,
      scheduled_for: retryAt,
    })
    calls.length = 0
    await recordJobs(f.t, calls)
    expect(calls).toEqual([{ name: 'webhookActions:deliver', delay: 0 }])
    expect((await f.rows()).find((row) => row.id === original[5].id)?.status).toBe('queued')
    expect(await f.t.mutation(internal.webhooks.claim, { id: retry.id })).toBeNull()
  })

  it('retires old unbound work without sending and never requeues completed deliveries', async () => {
    const f = await fixture()
    await f.subscribe()
    await f.emit()
    const row = (await f.rows())[0]
    await f.t.run((ctx) =>
      ctx.db.patch(row._id, {
        subscription_row_id: undefined,
        scheduled_for: undefined,
      }),
    )
    const calls: { name: string; delay: number }[] = []
    await recordJobs(f.t, calls)
    expect(calls).toEqual([])
    expect((await f.rows())[0]).toMatchObject({ status: 'failed', completed_at: Date.now() })
    await dispatchQueue(f.t)
    expect((await f.rows())[0].attempts).toBe(0)
  })

  it('refuses legacy move payloads that lack a source-project authorization binding', async () => {
    const f = await fixture()
    await f.subscribe()
    await f.emit()
    const row = (await f.rows())[0]
    const payload = JSON.parse(row.payload)
    payload.data.changed_fields = ['project_id']
    await f.t.run((ctx) => ctx.db.patch(row._id, { payload: JSON.stringify(payload) }))
    expect(await f.t.mutation(internal.webhooks.claim, { id: row.id })).toBeNull()
    expect((await f.rows())[0]).toMatchObject({ status: 'failed', attempts: 0 })
  })

  it('continues retention beyond 200 expired subscriptions and 500 completed deliveries', async () => {
    const f = await fixture()
    await f.subscribe()
    await f.emit()
    const old = Date.now() - 8 * 24 * 60 * 60_000
    const initialHealth = await f.t.run((ctx) => ctx.db.query('webhook_health').collect())
    await f.t.run(async (ctx) => {
      const subscription = (await ctx.db.query('webhook_subscriptions').first())!
      const delivery = (await ctx.db.query('webhook_deliveries').first())!
      const { _id: _subscriptionRow, _creationTime: _subscriptionTime, ...sub } = subscription
      const { _id: _deliveryRow, _creationTime: _deliveryTime, ...event } = delivery
      for (let index = 0; index < 201; index++) {
        const subscription_row_id = await ctx.db.insert('webhook_subscriptions', {
          ...sub,
          id: uuid(),
          expires_at: old,
        })
        await ctx.db.insert('webhook_health', {
          subscription_row_id,
          org_id: f.fx.org.id,
          last_status: 204,
        })
      }
      for (let index = 0; index < 501; index++)
        await ctx.db.insert('webhook_deliveries', {
          ...event,
          id: uuid(),
          status: 'delivered',
          completed_at: old,
          scheduled_for: undefined,
        })
    })
    await f.t.mutation(internal.webhooks.sweep, {})
    expect(await f.t.run((ctx) => ctx.db.query('webhook_subscriptions').collect())).toHaveLength(2)
    expect(await f.rows()).toHaveLength(2)
    expect(await f.t.run((ctx) => ctx.db.query('webhook_health').collect())).toHaveLength(
      initialHealth.length + 1,
    )
    const jobs = await f.t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    expect(
      jobs.filter((job) => job.name === 'webhooks:sweep' && job.scheduledTime === Date.now()),
    ).toHaveLength(1)
    await f.t.mutation(internal.webhooks.sweep, {})
    expect(await f.t.run((ctx) => ctx.db.query('webhook_subscriptions').collect())).toHaveLength(1)
    expect(await f.rows()).toHaveLength(1)
    expect((await f.rows())[0].status).toBe('pending')
    expect(await f.t.run((ctx) => ctx.db.query('webhook_health').collect())).toEqual(initialHealth)
  })
})

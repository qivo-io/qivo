import { v } from 'convex/values'
import type { MutationCtx } from './_generated/server'
import { internalMutation } from './_generated/server'
import { byId } from './lib/db'
import { subscriptionActive, WEBHOOK_LEASE_MS, WEBHOOK_ORG_CONCURRENCY } from './lib/taskEvents'
import { newUuid } from './model/orgs'
import { readableEventProject } from './model/taskEvents'
import { deliverEventRef, requestWebhookDispatch, runWebhookWorkerRef } from './model/webhookQueue'
import { occupiedDeliveries } from './webhooks'

const BATCH_SIZE = 50
const RECIPIENT_BATCH_SIZE = 25

type WorkerKind = 'expand' | 'dispatch'

/** Coalesce background wakes without making task transactions read shared queue state. */
async function reserveWorker(ctx: MutationCtx, kind: WorkerKind): Promise<void> {
  const current = await ctx.db
    .query('webhook_workers')
    .withIndex('by_kind', (q) => q.eq('kind', kind))
    .unique()
  const job = current ? await ctx.db.system.get(current.scheduled_job) : null
  if (current && (job?.state.kind === 'pending' || job?.state.kind === 'inProgress')) {
    // One fresh batch must follow any wake arriving during this reservation.
    // Repeated wakes share it instead of repeatedly invalidating the worker.
    if (!current.rerun) await ctx.db.patch(current._id, { rerun: true })
    return
  }
  const generation = newUuid()
  const scheduled_job = await ctx.scheduler.runAfter(0, runWebhookWorkerRef, { kind, generation })
  if (current) await ctx.db.patch(current._id, { generation, scheduled_job, rerun: false })
  else await ctx.db.insert('webhook_workers', { kind, generation, scheduled_job, rerun: false })
}

export const expand = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    await reserveWorker(ctx, 'expand')
    return null
  },
})

export const dispatch = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    await reserveWorker(ctx, 'dispatch')
    return null
  },
})

/** A generation owns one batch and atomically replaces or releases its reservation. */
export const run = internalMutation({
  args: { kind: v.union(v.literal('expand'), v.literal('dispatch')), generation: v.string() },
  handler: async (ctx, { kind, generation }): Promise<null> => {
    const worker = await ctx.db
      .query('webhook_workers')
      .withIndex('by_kind', (q) => q.eq('kind', kind))
      .unique()
    if (!worker || worker.generation !== generation) return null
    const job = await ctx.db.system.get(worker.scheduled_job)
    if (job?.state.kind !== 'pending' && job?.state.kind !== 'inProgress') return null
    const more = kind === 'expand' ? await expandBatch(ctx) : await dispatchBatch(ctx)
    if (more || worker.rerun) {
      const next = newUuid()
      const scheduled_job = await ctx.scheduler.runAfter(0, runWebhookWorkerRef, {
        kind,
        generation: next,
      })
      await ctx.db.patch(worker._id, { generation: next, scheduled_job, rerun: false })
    } else await ctx.db.delete(worker._id)
    return null
  },
})

/** Expand original recipients in small transactions, rechecking their current access. */
async function expandBatch(ctx: MutationCtx): Promise<boolean> {
  let budget = RECIPIENT_BATCH_SIZE
  let inserted = false
  while (budget > 0) {
    const event = await ctx.db.query('webhook_events').first()
    if (!event) break
    const task = await byId(ctx, 'issues', event.task_id)
    const end = Math.min(event.subscription_rows.length, event.next_recipient + budget)
    for (let index = event.next_recipient; index < end; index++) {
      budget--
      const sub = await ctx.db.get(event.subscription_rows[index])
      if (
        !sub ||
        sub.org_id !== event.org_id ||
        !subscriptionActive(sub) ||
        (!task && event.name !== 'task.deleted') ||
        !(await readableEventProject(ctx, sub.owner, event.project_id)) ||
        (event.source_project_id &&
          !(await readableEventProject(ctx, sub.owner, event.source_project_id))) ||
        (task && !(await readableEventProject(ctx, sub.owner, task.project_id)))
      )
        continue
      await ctx.db.insert('webhook_deliveries', {
        id: newUuid(),
        org_id: event.org_id,
        subscription_id: sub.id,
        subscription_row_id: sub._id,
        project_id: event.project_id,
        source_project_id: event.source_project_id,
        task_id: event.task_id,
        name: event.name,
        payload: event.payload,
        status: 'pending',
        attempts: 0,
        created_at: event.created_at,
        scheduled_for: Date.now(),
      })
      inserted = true
    }
    if (end === event.subscription_rows.length) await ctx.db.delete(event._id)
    else await ctx.db.patch(event._id, { next_recipient: end })
  }
  if (inserted) await requestWebhookDispatch(ctx)
  return budget === 0
}

/** Reserve slots before scheduling. A pending or running action retains its slot. */
async function dispatchBatch(ctx: MutationCtx): Promise<boolean> {
  const now = Date.now()
  const due = (
    await Promise.all(
      (['pending', 'queued', 'sending'] as const).map((status) =>
        ctx.db
          .query('webhook_deliveries')
          .withIndex('by_status_scheduled', (q) => q.eq('status', status).lte('scheduled_for', now))
          .take(BATCH_SIZE),
      ),
    )
  )
    .flat()
    .sort(
      (a, b) =>
        (a.scheduled_for ?? 0) - (b.scheduled_for ?? 0) || a._creationTime - b._creationTime,
    )
    .slice(0, BATCH_SIZE)
  const occupied = new Map<string, Awaited<ReturnType<typeof occupiedDeliveries>>>()
  for (const row of due) {
    if (!row.subscription_row_id) {
      await ctx.db.patch(row._id, {
        status: 'failed',
        completed_at: now,
        scheduled_for: undefined,
        lease_until: undefined,
        scheduled_job: undefined,
      })
      continue
    }
    const job = row.scheduled_job ? await ctx.db.system.get(row.scheduled_job) : null
    if (job && (job.state.kind === 'pending' || job.state.kind === 'inProgress')) {
      await ctx.db.patch(row._id, { scheduled_for: now + WEBHOOK_LEASE_MS })
      continue
    }
    let active = occupied.get(row.org_id)
    if (!active) {
      active = await occupiedDeliveries(ctx, row.org_id)
      occupied.set(row.org_id, active)
    }
    const other = active.rows.filter((work) => work._id !== row._id)
    if (
      active.hasMore ||
      other.length >= WEBHOOK_ORG_CONCURRENCY ||
      other.some((work) => work.subscription_row_id === row.subscription_row_id)
    ) {
      await ctx.db.patch(row._id, {
        scheduled_for: active.recovering ? now : now + WEBHOOK_LEASE_MS,
      })
      continue
    }
    const scheduled_job = await ctx.scheduler.runAfter(0, deliverEventRef, { id: row.id })
    await ctx.db.patch(row._id, {
      status: 'queued',
      scheduled_job,
      scheduled_for: now + WEBHOOK_LEASE_MS,
    })
    occupied.set(row.org_id, {
      hasMore: false,
      recovering: false,
      rows: [...other, { ...row, status: 'queued' }],
    })
  }
  if (!due.length) return false
  // Only continue a batch that still has due work. Future leases are recovered
  // by the cron; completions and retry timers wake their own newly ready work.
  // Keeping future timer chains alive multiplies every expansion/finish wake.
  const dueRemains = await Promise.all(
    (['pending', 'queued', 'sending'] as const).map((status) =>
      ctx.db
        .query('webhook_deliveries')
        .withIndex('by_status_scheduled', (q) => q.eq('status', status).lte('scheduled_for', now))
        .first(),
    ),
  )
  return dueRemains.some((row) => row !== null)
}

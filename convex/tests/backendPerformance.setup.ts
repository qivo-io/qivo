/// <reference types="vite/client" />
import type { FunctionReturnType } from 'convex/server'
import { convexTest } from 'convex-test'
import type { api } from '../_generated/api'
import type { QueryCtx } from '../_generated/server'
import { logActivity } from '../model/activity'
import schema from '../schema'
import { forMe } from '../snapshot'
import { NOW, withOrg } from './helpers.setup'

declare const performance: { now(): number }

type Snapshot = FunctionReturnType<typeof api.snapshot.forMe>
export const invokeSnapshot = (ctx: QueryCtx, snapshot = forMe): Promise<Snapshot> =>
  (
    snapshot as unknown as {
      _handler: (ctx: QueryCtx, args: Record<string, never>) => Promise<Snapshot>
    }
  )._handler(ctx, {})

type Baseline = {
  snapshot: typeof forMe
  activity: typeof logActivity
  assertEqual: (actual: unknown, expected: unknown) => void
  report: (row: unknown) => void
  guardsOnly?: boolean
  currentOnly?: boolean
}

export async function benchmarkBackend(baseline: Baseline) {
  const results: Record<string, string | number>[] = []
  for (const count of [100, 1000, 10000]) {
    const t = convexTest(schema, import.meta.glob('../**/*.*s'))
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.org._id, { next_issue_num: count, activity_count: 500 })
      for (let i = 0; i < count; i++) {
        await ctx.db.insert('issues', {
          id: `benchmark-task-${i}`,
          org_id: f.org.id,
          project_id: i % 20 === 0 ? f.hidden.id : f.sub.id,
          num: i + 1,
          title: `Task ${i + 1}`,
          description: '',
          status: i % 11 === 0 ? 'review' : 'progress',
          priority: 'medium',
          paused: false,
          assignee_id: f.user.id,
          remaining_hours: i % 30,
          start_week: '2026-01-05',
          end_week: '2026-02-02',
          created_at: NOW,
          updated_at: NOW,
        })
        if (i % 20 === 1) {
          await ctx.db.insert('issue_labels', {
            org_id: f.org.id,
            issue_id: `benchmark-task-${i}`,
            label_id: 'benchmark-label',
          })
        }
        if (i % 50 === 2) {
          await ctx.db.insert('issue_links', {
            org_id: f.org.id,
            id: `benchmark-link-${i}`,
            source_id: `benchmark-task-${i}`,
            target_id: `benchmark-task-${i - 1}`,
            type: 'blocks',
            pair_key: `benchmark-task-${i}:benchmark-task-${i - 1}`,
            created_at: NOW,
          })
        }
      }
      for (let i = 0; i < 500; i++) {
        await ctx.db.insert('activity_events', {
          id: `benchmark-event-${i}`,
          org_id: f.org.id,
          actor_id: f.user.id,
          ts: NOW,
          verb: 'created',
          target_type: 'issue',
          target_id: `benchmark-task-${i % count}`,
          label: 'Task',
          project_id: f.sub.id,
        })
      }
    })
    const authed = t.withIdentity({ subject: f.user.auth_user_id! })
    const snapshot = async (handler: typeof forMe, identity = authed) => {
      const started = performance.now()
      const measured = await identity.query(async (ctx) => ({
        result: await invokeSnapshot(ctx, handler),
        metrics: await ctx.meta.getTransactionMetrics(),
      }))
      return { ...measured, ms: performance.now() - started }
    }
    const compare = async (operation: string, identity = authed) => {
      const old = baseline.currentOnly ? null : await snapshot(baseline.snapshot, identity)
      const current = await snapshot(forMe, identity)
      if (old !== null && old.result !== null) {
        for (const row of old.result.orgs)
          delete (row as { activity_count?: number }).activity_count
        for (const rows of [old.result.links, old.result.issueLabels, old.result.attachments]) {
          for (const row of rows) delete (row as { org_id?: string }).org_id
        }
      }
      if (old !== null) baseline.assertEqual(current.result, old.result)
      const row = {
        operation,
        tasks: count,
        baselineQueries: old?.metrics.databaseQueries.used ?? '—',
        queries: current.metrics.databaseQueries.used,
        baselineDocuments: old?.metrics.documentsRead.used ?? '—',
        documents: current.metrics.documentsRead.used,
        baselineMs: old === null ? '—' : Math.round(old.ms),
        ms: Math.round(current.ms),
      }
      results.push(row)
      baseline.report(row)
    }
    if (!baseline.guardsOnly) await compare('snapshot')
    for (const [name, write] of [
      ['baseline', baseline.activity],
      ['optimized', logActivity],
    ] as const) {
      const started = performance.now()
      const metrics = await t.run(async (ctx) => {
        await write(ctx, {
          org_id: f.org.id,
          actor_id: f.user.id,
          ts: '2026-02-01T00:00:00.000Z',
          verb: 'updated',
          target_type: 'issue',
          target_id: 'benchmark-task-0',
          label: 'Task',
        })
        return ctx.meta.getTransactionMetrics()
      })
      results.push({
        operation: `activity ${name}`,
        tasks: count,
        queries: metrics.databaseQueries.used,
        documents: metrics.documentsRead.used,
        ms: Math.round(performance.now() - started),
      })
    }
    if (baseline.currentOnly) continue
    // Guard cases retain 1% of tasks in the visible working set. Relation
    // rows stay populated so accidentally scanning their archive is measured.
    const taskRows = await t.run((ctx) => ctx.db.query('issues').collect())
    await t.run(async (ctx) => {
      for (const [i, task] of taskRows.entries()) {
        await ctx.db.patch(task._id, { project_id: i < count / 100 ? f.sub.id : f.hidden.id })
      }
      for (const event of await ctx.db.query('activity_events').collect())
        await ctx.db.delete(event._id)
      await ctx.db.patch(f.org._id, { activity_count: 0 })
    })
    await compare('restricted 1%', t.withIdentity({ subject: f.guest.auth_user_id! }))
    await t.run(async (ctx) => {
      for (const [i, task] of taskRows.entries()) {
        if (i >= count / 100) await ctx.db.patch(task._id, { archived_at: NOW })
      }
    })
    await compare('active 1%')
  }
  return results
}

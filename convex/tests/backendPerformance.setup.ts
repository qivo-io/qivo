import type { QueryCtx } from '../_generated/server'
import * as inbox from '../inbox'
import { logActivity } from '../model/activity'
import * as workspace from '../workspace'
import { as, newT, uuid, withOrg } from './helpers.setup'
import { everyday } from './inboxItems.setup'

declare const performance: { now(): number }

/** What scripts/benchmark-backend.mjs compares the working tree with: a
    baseline revision's logActivity, or with `currentOnly` nothing, when only
    the working tree is measured. The workspace's root part and the feed
    have no counterpart before them, so they are measured on the working
    tree alone. */
type Baseline = {
  report: (row: unknown) => void
} & ({ currentOnly: true } | { currentOnly?: false; activity: typeof logActivity })

/* A caller as convex-test's withIdentity gives one. */
type Identity = { query: <R>(fn: (ctx: QueryCtx) => Promise<R>) => Promise<R> }

/** Public query `fn` of workspace.ts or inbox.ts run inside `ctx`, its
    wrapper included, so the transaction's metrics after it are the part's. */
const run = (fn: unknown, ctx: QueryCtx, args: Record<string, unknown>) =>
  (fn as { _handler: (ctx: QueryCtx, args: Record<string, unknown>) => Promise<unknown> })._handler(
    ctx,
    args,
  )

/** The workspace's root part and the Inbox feed the leader tab of a
    session that can show desktop alerts watches, each read in its own
    transaction as the app subscribes to them: per part its milliseconds,
    index ranges, documents and bytes read. */
async function readParts(identity: Identity) {
  const measured = async (name: string, fn: unknown, args: Record<string, unknown>) => {
    const started = performance.now()
    const out = await identity.query(async (ctx) => {
      const answer = await run(fn, ctx, args)
      // a read that refused measures nothing the app shows
      const state = (answer as { state?: string } | null)?.state
      if (state !== undefined && state !== 'ok') throw new Error(`${name} answered ${state}`)
      const m = await ctx.meta.getTransactionMetrics()
      return {
        ranges: m.databaseQueries.used,
        documents: m.documentsRead.used,
        bytes: m.bytesRead.used,
      }
    })
    return { name, ...out, ms: performance.now() - started }
  }
  // the root carries the caller's own profiles, memberships and teams, so
  // there is no people or catalog part to measure, and no part sends a
  // task or a project: the app reads them from its views' and its window's
  // own answers and by id (projectNav.byIds)
  return [
    await measured('root', workspace.root, {}),
    await measured('feed', inbox.feed, { after: 0 }),
  ]
}

/**
 * The root part and the feed, then one activity write, against the
 * baseline's write unless `currentOnly`, in withOrg's organization. The
 * parts are read by a reader of everyday reach (inboxItems.setup.ts
 * everyday), a member of 3 teams that each share about 20 sub-projects,
 * since the root carries the caller's memberships and teams. Neither part
 * reads a task, a project or the history, so the benchmark seeds no task
 * and no history; the activity write reads only the organization's row.
 * Answers one row per part and per write.
 */
export async function benchmarkBackend(baseline: Baseline) {
  const results: Record<string, string | number>[] = []
  const t = newT()
  const f = await withOrg(t)
  const { me } = await everyday(t, f)
  for (const part of await readParts(as(t, me))) {
    const row = {
      operation: 'workspace',
      part: part.name,
      queries: part.ranges,
      documents: part.documents,
      bytes: part.bytes,
      ms: Math.round(part.ms),
    }
    results.push(row)
    baseline.report(row)
  }
  // only a comparison has a baseline write to time
  const writes = [
    ...(baseline.currentOnly ? [] : [['baseline', baseline.activity] as const]),
    ['optimized', logActivity] as const,
  ]
  const target = uuid()
  for (const [name, write] of writes) {
    const started = performance.now()
    const metrics = await t.run(async (ctx) => {
      await write(ctx, {
        org_id: f.org.id,
        actor_id: f.user.id,
        ts: '2026-02-01T00:00:00.000Z',
        verb: 'updated',
        target_type: 'issue',
        target_id: target,
        label: 'Task',
        named_task_nums: [],
      })
      return ctx.meta.getTransactionMetrics()
    })
    const row = {
      operation: `activity ${name}`,
      queries: metrics.databaseQueries.used,
      documents: metrics.documentsRead.used,
      ms: Math.round(performance.now() - started),
    }
    results.push(row)
    baseline.report(row)
  }
  return results
}

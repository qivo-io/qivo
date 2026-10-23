import type { QueryCtx } from '../_generated/server'
import { idWindows, WINDOW_ROWS, windowCount } from '../lib/idWindows'
import { logActivity } from '../model/activity'
import * as workspace from '../workspace'
import { NOW, newT, patchCounters, withOrg } from './helpers.setup'

declare const performance: { now(): number }

/** What scripts/benchmark-backend.mjs compares the working tree with: a
    baseline revision's logActivity, or with `currentOnly` nothing, when only
    the working tree is measured. The workspace parts have no counterpart
    before them, so they are measured on the working tree alone. */
type Baseline = {
  report: (row: unknown) => void
  guardsOnly?: boolean
} & ({ currentOnly: true } | { currentOnly?: false; activity: typeof logActivity })

/** The id of benchmark task `i`: a UUID whose first part is a hash, spread
    over the id space as the server's random window keys are
    (lib/idWindows.ts), and which is also its window key (keyOf). */
function taskId(i: number): string {
  let hash = 0x811c9dc5
  for (const ch of `task:${i}`) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193) >>> 0
  return `${hash.toString(16).padStart(8, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`
}

/** The window key of benchmark task `i`, the first part of its id. */
const keyOf = (i: number) => taskId(i).slice(0, 8)

/* A caller as convex-test's withIdentity gives one. */
type Identity = { query: <R>(fn: (ctx: QueryCtx) => Promise<R>) => Promise<R> }

/** Public query `fn` of workspace.ts run inside `ctx`, its wrapper
    included, so the transaction's metrics after it are the part's. */
const run = (fn: unknown, ctx: QueryCtx, args: Record<string, unknown>) =>
  (fn as { _handler: (ctx: QueryCtx, args: Record<string, unknown>) => Promise<unknown> })._handler(
    ctx,
    args,
  )

/** Every part of the caller's workspace in `orgId`, each read in its own
    transaction as the app subscribes to them: per part its answer as JSON,
    milliseconds, index ranges, documents and bytes read, in the windows
    the app would choose. */
async function readParts(identity: Identity, orgId: string) {
  const measured = async (name: string, fn: unknown, args: Record<string, unknown>) => {
    const started = performance.now()
    const out = await identity.query(async (ctx) => {
      const answer = await run(fn, ctx, args)
      // a window that overflowed or refused measures nothing the app shows
      const state = (answer as { state?: string } | null)?.state
      if (state !== undefined && state !== 'ok') throw new Error(`${name} answered ${state}`)
      const m = await ctx.meta.getTransactionMetrics()
      return {
        answer: JSON.stringify(answer),
        ranges: m.databaseQueries.used,
        documents: m.documentsRead.used,
        bytes: m.bytesRead.used,
      }
    })
    return { name, ...out, ms: performance.now() - started }
  }
  /* The windows of `kind`, as the app chooses them from the counters. */
  const windowsOf = async (kind: string) => {
    const root = (await identity.query(async (ctx) => await run(workspace.root, ctx, {}))) as {
      orgs: { id: string; next_issue_num: number; next_project_num: number }[]
    }
    const org = root.orgs.find((o) => o.id === orgId)
    const n =
      kind === 'people'
        ? 1
        : kind === 'projects'
          ? windowCount(org?.next_project_num ?? 0, WINDOW_ROWS.projects)
          : windowCount(org?.next_issue_num ?? 0, WINDOW_ROWS.tasks)
    return idWindows(n)
  }
  const parts = [
    await measured('root', workspace.root, {}),
    await measured('catalog', workspace.catalog, { org_id: orgId }),
    await measured('inbox', workspace.inbox, { org_id: orgId }),
  ]
  const windowed = {
    tasks: workspace.tasks,
    people: workspace.people,
    projects: workspace.projects,
  }
  for (const [kind, fn] of Object.entries(windowed)) {
    for (const [i, w] of (await windowsOf(kind)).entries())
      parts.push(await measured(`${kind} ${i}`, fn, { org_id: orgId, ...w }))
  }
  return parts
}

/** The busiest window of each kind, and how many windows it has. */
function summary(parts: Awaited<ReturnType<typeof readParts>>) {
  const kinds = new Map<string, { windows: number; busiest: (typeof parts)[number] }>()
  for (const part of parts) {
    const kind = part.name.split(' ')[0]
    const was = kinds.get(kind)
    if (!was || part.ms > was.busiest.ms)
      kinds.set(kind, { windows: (was?.windows ?? 0) + 1, busiest: part })
    else was.windows++
  }
  return kinds
}

export async function benchmarkBackend(baseline: Baseline) {
  const results: Record<string, string | number>[] = []
  for (const count of [100, 1000, 10000]) {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await patchCounters(ctx, f.org.id, { next_issue_num: count })
      for (let i = 0; i < count; i++) {
        await ctx.db.insert('issues', {
          id: taskId(i),
          window_key: keyOf(i),
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
            issue_id: taskId(i),
            label_id: 'benchmark-label',
            task_key: keyOf(i),
          })
        }
        if (i % 50 === 2) {
          await ctx.db.insert('issue_links', {
            org_id: f.org.id,
            id: `benchmark-link-${i}`,
            source_id: taskId(i),
            target_id: taskId(i - 1),
            type: 'blocks',
            pair_key: `${taskId(i)}:${taskId(i - 1)}`,
            created_at: NOW,
            task_key: keyOf(i),
          })
        }
      }
      // task rows that name no task, as the app writes them
      for (let i = 0; i < 500; i++) {
        await ctx.db.insert('activity_events', {
          id: `benchmark-event-${i}`,
          org_id: f.org.id,
          actor_id: f.user.id,
          ts: NOW,
          verb: 'created',
          target_type: 'issue',
          target_id: taskId(i % count),
          label: 'Task',
          project_id: f.sub.id,
          named_task_nums: [],
        })
      }
    })
    const authed = t.withIdentity({ subject: f.user.auth_user_id! })
    /* One row per kind of part: how many parts it has and its busiest. */
    const compare = async (operation: string, identity: Identity = authed) => {
      for (const [kind, { windows, busiest }] of summary(await readParts(identity, f.org.id))) {
        const row = {
          operation,
          tasks: count,
          part: kind,
          windows,
          queries: busiest.ranges,
          documents: busiest.documents,
          ms: Math.round(busiest.ms),
        }
        results.push(row)
        baseline.report(row)
      }
    }
    if (!baseline.guardsOnly) {
      await compare('workspace')
      // what one task rename re-sends: the parts whose answer changed
      const before = await readParts(authed, f.org.id)
      await t.run(async (ctx) => {
        const task = await ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', taskId(count >> 1)))
          .unique()
        if (task) await ctx.db.patch(task._id, { title: 'Renamed by someone else' })
      })
      const after = await readParts(authed, f.org.id)
      const changed = after.filter((part, i) => part.answer !== before[i]?.answer)
      const row = {
        operation: 'rename re-sends',
        tasks: count,
        part: changed.map((part) => part.name).join(', '),
        bytes: changed.reduce((n, part) => n + part.answer.length, 0),
        of: after.reduce((n, part) => n + part.answer.length, 0),
      }
      results.push(row)
      baseline.report(row)
    }
    // only a comparison has a baseline write to time
    const writes = [
      ...(baseline.currentOnly ? [] : [['baseline', baseline.activity] as const]),
      ['optimized', logActivity] as const,
    ]
    for (const [name, write] of writes) {
      const started = performance.now()
      const metrics = await t.run(async (ctx) => {
        await write(ctx, {
          org_id: f.org.id,
          actor_id: f.user.id,
          ts: '2026-02-01T00:00:00.000Z',
          verb: 'updated',
          target_type: 'issue',
          target_id: taskId(0),
          label: 'Task',
          named_task_nums: [],
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
    // Guard cases retain 1% of tasks in the visible working set. Relation
    // rows stay populated so accidentally scanning their archive is measured.
    const taskRows = await t.run((ctx) => ctx.db.query('issues').collect())
    await t.run(async (ctx) => {
      for (const [i, task] of taskRows.entries()) {
        await ctx.db.patch(task._id, { project_id: i < count / 100 ? f.sub.id : f.hidden.id })
      }
      for (const event of await ctx.db.query('activity_events').collect())
        await ctx.db.delete(event._id)
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

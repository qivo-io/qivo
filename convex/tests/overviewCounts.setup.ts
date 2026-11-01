/* The Overview's counts in fixtures (model/overviewCounts.ts): a fixture
 * that plants its rows directly leaves its organization uncounted, so task
 * writes in it move no count, unlike production, where every organization
 * is counted from its creation or by internal/overviewCountsBackfill. A
 * test that measures a writer's cost counts its fixture first.
 *
 * Named *.setup.ts: two dots in the basename is the Convex CLI's skip rule
 * (see helpers.setup.ts). */

import { expect } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { byId } from '../lib/db'
import { ISSUE_STATUSES } from '../lib/enums'
import { taskOwnerId } from '../lib/review'
import {
  addCounts,
  type LeafCounts,
  noCounts,
  OVERVIEW_SHARDS,
  subProjectCounts,
} from '../model/overviewCounts'
import type { T } from './helpers.setup'

/** Counts organization `org_id` with the backfill's own steps, each its
 * own transaction as on a deployment, each count step going on after the
 * creation time the one before counted through, until it is counted. */
export async function countOrg(t: T, org_id: string): Promise<void> {
  let after: number | undefined
  for (let n = 0; n < 400; n++) {
    const got = await t.mutation(internal.internal.overviewCountsBackfill.step, {
      org_id,
      ...(after === undefined ? {} : { after }),
    })
    if (got.done) return
    if (got.through !== undefined) after = got.through
  }
  throw new Error('the count did not end')
}

/** Count rows as a test compares them: by sub-project, owner and shard,
 * all-zero rows left out. */
export type Rows = Record<string, LeafCounts>

const isZero = (c: LeafCounts) =>
  c.paused === 0 && c.left_tenths === 0 && ISSUE_STATUSES.every((s) => c.leaves[s] === 0)

/** What the organization's tasks give, counted from the rows themselves
 * by the stored rule (model/overviewCounts.ts hasLiveSubtask: an active
 * subtask in a live project, whatever the parent's project) and
 * lib/review.ts taskOwnerId: the rows of every sub-project (live or
 * archived) and owner, and the active tasks with an active subtask in a
 * live project. */
export const truth = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const projects = new Map(
      (
        await ctx.db
          .query('projects')
          .withIndex('by_org', (q) => q.eq('org_id', orgId))
          .collect()
      ).map((p) => [p.id, p]),
    )
    const tasks = await ctx.db
      .query('issues')
      .withIndex('by_org_archived', (q) => q.eq('org_id', orgId).eq('archived_at', undefined))
      .collect()
    const live = (id: string) => projects.get(id)?.archived_at === undefined && projects.has(id)
    const active = new Set(tasks.map((task) => task.id))
    const groups = new Set<string>()
    for (const kid of tasks)
      if (kid.parent_id !== undefined && live(kid.project_id) && active.has(kid.parent_id))
        groups.add(kid.parent_id)
    const rows: Rows = {}
    const add = (key: string, task: Doc<'issues'>) => {
      const c = noCounts()
      c.leaves[task.status] = 1
      c.paused = task.paused ? 1 : 0
      c.left_tenths = task.status === 'done' ? 0 : Math.round((task.remaining_hours ?? 0) * 10)
      rows[key] = addCounts(rows[key] ?? noCounts(), c)
    }
    for (const task of tasks) {
      const project = projects.get(task.project_id)
      if (groups.has(task.id) || project === undefined || project.parent_id === undefined) continue
      add(`${project.id}||${task.num % OVERVIEW_SHARDS}`, task)
      const owner = taskOwnerId(task, false)
      if (owner !== undefined) add(`${project.id}|${owner}|${task.num % OVERVIEW_SHARDS}`, task)
    }
    for (const key of Object.keys(rows)) if (isZero(rows[key])) delete rows[key]
    return { rows, groups: [...groups].sort() }
  })

/** What the organization's count rows hold, and the tasks its task rows
 * hold as groups, those of an earlier project or task with the same id left
 * out. */
export const stored = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const rows: Rows = {}
    for (const row of await ctx.db
      .query('overview_counts')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()) {
      const project = await byId(ctx, 'projects', row.project_id)
      if (project === null || project._creationTime !== row.project_at) continue
      const key = `${row.project_id}|${row.owner_id ?? ''}|${row.shard}`
      expect(rows[key], `two rows for ${key}`).toBeUndefined()
      const counts = { leaves: row.leaves, paused: row.paused, left_tenths: row.left_tenths }
      if (!isZero(counts)) rows[key] = counts
    }
    const groups: string[] = []
    for (const row of await ctx.db
      .query('overview_tasks')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()) {
      const task = await byId(ctx, 'issues', row.task_id)
      // a row holds only an active task's state
      expect(task?.archived_at, `the task row of ${row.task_id}`).toBeUndefined()
      if (task !== null && task._creationTime === row.task_at && row.group) groups.push(row.task_id)
    }
    return { rows, groups: groups.sort() }
  })

/** Expects the organization's rows to equal a recount, and every live
 * sub-project's counts to read whole and as the recount gives. */
export async function expectCountsExact(t: T, orgId: string, label = ''): Promise<void> {
  const want = await truth(t, orgId)
  expect(await stored(t, orgId), label).toEqual(want)
  const read = await t.run(async (ctx) => {
    const out: Record<string, LeafCounts | null> = {}
    for (const p of await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect())
      if (p.parent_id !== undefined && p.archived_at === undefined)
        out[p.id] = await subProjectCounts(ctx.db, p)
    return out
  })
  for (const [projectId, counts] of Object.entries(read)) {
    let sum = noCounts()
    for (const [key, c] of Object.entries(want.rows))
      if (key.startsWith(`${projectId}||`)) sum = addCounts(sum, c)
    expect(counts, `${label} ${projectId}`).toEqual(sum)
  }
}

/* A one-time backfill for attachment rows stored before every row carried
 * its task's organization and project (schema.ts issue_attachments). The
 * oldest rows may lack org_id, and every row stored before this backfill
 * existed lacks project_id. No reader depends on it for correctness.
 * model/billing.ts storageUsage resolves a row without its project or its
 * organization through its task, and reads the deployment's rows without
 * an organization on every call. While any such row exists anywhere,
 * lib/snapshotRelations.ts reads the app snapshot's attachments task by
 * task. The backfill only makes those reads cheaper.
 *
 * One sequential chain of `start` steps, so the last one can log one
 * summary. Empty arguments start a run. Each step schedules the next.
 * - Phase `tasks` takes the first organization whose id is not before
 *   `org` and reads one page of its tasks (issues by_org, bounded by count
 *   and bytes, as task descriptions have no size cap on older rows). Each
 *   task's attachment rows that name another organization or project get
 *   the task's. A row that changes organization enters the new range
 *   unmarked, and the step schedules the archive mark steps for the
 *   archived tasks among those (model/archiveMarks.ts), as every archive
 *   does. A row that named another organization is logged by id. The next
 *   step continues the organization's tasks, then the next organization,
 *   then phase `legacy`.
 * - Phase `legacy` pages through the rows still without org_id. After phase
 *   `tasks` only rows whose task is gone remain. Each is logged by id and
 *   counted in `orphans`, and left alone, because deleting it would delete
 *   bytes and is a separate decision. While one remains, storageUsage reads
 *   it on every call and the snapshot keeps reading attachments task by
 *   task. A row whose task does exist, outside every organization the
 *   first phase walked, is filled like the others.
 * The last step logs 'Attachment scope backfill done' with the tasks it
 * visited, the rows it wrote (`filled`) and `orphans`.
 *
 * Running it twice, or while it runs, is safe. A step reads a task and its
 * rows in one transaction, so a concurrent move (model/issues.ts
 * moveIssueCore, which moves the rows' project too) cannot interleave, and a
 * row that already matches its task is not written. A second run reports
 * `filled: 0`. Organizations created or deleted during a run, as on the demo
 * deployment, are harmless.
 *
 * Run it once per deployment. Running it on any hosted deployment
 * (development, staging, production or demo) needs the user's approval
 * first, each time. From a Qivo checkout, the private helper names the
 * deployment and refuses to run without its key, for example development:
 *
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment" \
 *     development npx convex run internal/attachmentScopeBackfill:start
 *
 * The other targets are staging, production and demo, the demo backend. The
 * command returns once the first step is scheduled. Follow the progress in
 * the deployment's logs. After every deployment has run it and reported
 * `orphans: 0`, a later change may remove storageUsage's read of rows
 * without org_id. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import { internalMutation, type MutationCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { scheduleArchiveMarks } from '../model/archiveMarks'

/** The most tasks and task bytes one `tasks` step reads, and the most rows
 * without org_id one `legacy` step reads. A task costs one attachment range
 * and a legacy row one task lookup, so a step stays far below Convex's 4,096
 * ranges per transaction. Tests lower these. */
export const SCOPE_PAGE = { tasks: 200, bytes: 8 * 1024 * 1024, legacy: 100 }

/** One step's arguments: the phase, the organization and page cursor it
 * continues from, and the running counts for the final log. */
type ScopeStep = {
  phase?: 'tasks' | 'legacy'
  org?: string
  cursor?: string
  tasks?: number
  filled?: number
  orphans?: number
}

const startRef = makeFunctionReference<'mutation', ScopeStep, null>(
  'internal/attachmentScopeBackfill:start',
)

/* Gives each of `rows` the organization and project of `task` where they
 * differ. A row that changes organization also drops any archive mark,
 * which belonged to its old range. Answers how many rows it wrote and
 * whether one changed organization. */
async function fill(
  ctx: MutationCtx,
  task: Doc<'issues'>,
  rows: readonly Doc<'issue_attachments'>[],
): Promise<{ filled: number; rescoped: boolean }> {
  let filled = 0
  let rescoped = false
  for (const row of rows) {
    if (row.org_id === task.org_id && row.project_id === task.project_id) continue
    if (row.org_id === task.org_id) {
      await ctx.db.patch(row._id, { project_id: task.project_id })
    } else {
      if (row.org_id !== undefined) {
        console.warn('Attachment scope backfill corrected an organization', { id: row.id })
      }
      await ctx.db.patch(row._id, {
        org_id: task.org_id,
        project_id: task.project_id,
        task_archived: undefined,
      })
      rescoped = true
    }
    filled += 1
  }
  return { filled, rescoped }
}

/** One step of the backfill, then the next one scheduled. Empty arguments
 * start a run at the first organization. */
export const start = internalMutation({
  args: {
    phase: v.optional(v.union(v.literal('tasks'), v.literal('legacy'))),
    org: v.optional(v.string()),
    cursor: v.optional(v.string()),
    tasks: v.optional(v.number()),
    filled: v.optional(v.number()),
    orphans: v.optional(v.number()),
  },
  handler: async (ctx, a): Promise<null> => {
    let tasks = a.tasks ?? 0
    let filled = a.filled ?? 0
    let orphans = a.orphans ?? 0
    let next: ScopeStep

    if ((a.phase ?? 'tasks') === 'tasks') {
      const org = await ctx.db
        .query('organizations')
        .withIndex('by_uuid', (q) => q.gte('id', a.org ?? ''))
        .first()
      if (org === null) {
        next = { phase: 'legacy' }
      } else {
        // a cursor belongs to the organization it was read for, which may
        // have been deleted since
        const page = await ctx.db
          .query('issues')
          .withIndex('by_org', (q) => q.eq('org_id', org.id))
          .paginate({
            cursor: org.id === a.org ? (a.cursor ?? null) : null,
            numItems: Math.max(1, SCOPE_PAGE.tasks),
            maximumBytesRead: SCOPE_PAGE.bytes,
          })
        const marks = new Set<string>()
        for (const task of page.page) {
          const rows = await ctx.db
            .query('issue_attachments')
            .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
            .collect()
          const done = await fill(ctx, task, rows)
          filled += done.filled
          if (done.rescoped && task.archived_at !== undefined) marks.add(task.id)
        }
        await scheduleArchiveMarks(ctx, [...marks])
        tasks += page.page.length
        if (!page.isDone) {
          next = { phase: 'tasks', org: org.id, cursor: page.continueCursor }
        } else {
          const after = await ctx.db
            .query('organizations')
            .withIndex('by_uuid', (q) => q.gt('id', org.id))
            .first()
          next = after === null ? { phase: 'legacy' } : { phase: 'tasks', org: after.id }
        }
      }
    } else {
      const page = await ctx.db
        .query('issue_attachments')
        .withIndex('by_org_task_archived_issue', (q) => q.eq('org_id', undefined))
        .paginate({ cursor: a.cursor ?? null, numItems: Math.max(1, SCOPE_PAGE.legacy) })
      const marks = new Set<string>()
      for (const row of page.page) {
        const task = await byId(ctx, 'issues', row.issue_id)
        if (task === null) {
          console.warn('Attachment scope backfill found a row without a task', { id: row.id })
          orphans += 1
          continue
        }
        const done = await fill(ctx, task, [row])
        filled += done.filled
        if (done.rescoped && task.archived_at !== undefined) marks.add(task.id)
      }
      await scheduleArchiveMarks(ctx, [...marks])
      if (page.isDone) {
        console.info('Attachment scope backfill done', { tasks, filled, orphans })
        return null
      }
      next = { phase: 'legacy', cursor: page.continueCursor }
    }

    await ctx.scheduler.runAfter(0, startRef, { ...next, tasks, filled, orphans })
    return null
  },
})

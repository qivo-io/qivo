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
 * One sequential chain of `start` steps over every attachment row in task
 * order (issue_attachments by_issue), so the last one can log one summary.
 * Empty arguments start a run. Each step reads one page of rows, bounded by
 * count and bytes, and the task of each row, each task once. A row that
 * names another organization or project, or none, gets its task's. A row
 * that changes organization enters the new range unmarked, and the step
 * schedules the archive mark steps for the archived tasks among those
 * (model/archiveMarks.ts), as every archive does. A row that named another
 * organization is logged by id. A row whose task is gone is logged by id,
 * counted in `orphans` and left alone, because deleting it would delete
 * bytes and is a separate decision. That includes a row of a task in
 * Deleted items while its move or restore runs, or while a move that got
 * stuck waits for an admin's Delete now, because the task is out of issues
 * until then (model/deletedItems.ts). The backfill reads no deleted_rows,
 * so a stored row keeps what it held, and a restore gives it its task's
 * project (writeRowBack). While one without org_id remains,
 * storageUsage reads it on every call and the snapshot keeps reading
 * attachments task by task.
 *
 * Tasks are the larger documents, as their descriptions hold up to about
 * 60 KB and older ones up to the 1 MiB document limit. A step stops before
 * the first task that would take it past SCOPE_PAGE.taskBytes, and the next
 * step starts its walk at that task. The rows before it belong to earlier
 * tasks, so the walk skips and repeats nothing.
 *
 * The last step logs 'Attachment scope backfill done' with the rows it
 * visited, the rows it wrote (`filled`) and `orphans`.
 *
 * Running it twice, or while it runs, is safe. A step reads a row and its
 * task in one transaction, so a concurrent move (model/issues.ts
 * moveIssueCore, which moves the rows' project too) cannot interleave, and a
 * row that already matches its task is not written. Rows stored during a run
 * already carry both fields (model/attachments.ts attachFileCore). A second
 * run reports `filled: 0`. Organizations created or deleted during a run, as
 * on the demo deployment, are harmless.
 *
 * Run it once per deployment. Running it on any hosted deployment
 * (development, staging, production or demo) needs the user's approval
 * first, each time. From a Qivo checkout, the private helper names the
 * deployment and refuses to run without its key, for example development:
 *
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment" \
 *     development npx convex run internal/attachmentScopeBackfill:start
 *
 * The other targets are staging and production. The demo backend's stored
 * key cannot run internal functions or read logs, so on the demo the private
 * with-temp-deploy-key helper runs the command with a short-lived key that
 * allows only the listed actions, then deletes it (qivo-internal
 * docs/public-demo-operations.md):
 *
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-temp-deploy-key" \
 *     demo --allow deployment:functions:runInternalMutations \
 *     --purpose attachment-scope -- npx convex run internal/attachmentScopeBackfill:start
 *
 * The command returns once the first step is scheduled. Follow the progress
 * in the deployment's logs. On the demo, `npx convex logs` also needs a
 * temporary key, with deployment:logs:view. After every deployment has run
 * it and reported `orphans: 0`, a later change may remove storageUsage's
 * read of rows without org_id. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import { internalMutation, type MutationCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { scheduleArchiveMarks } from '../model/archiveMarks'
import { estimateDocumentBytes } from '../model/demoMetrics'

/** The most rows (`rows`) and row bytes (`bytes`) one step reads, and about
 * the most bytes of tasks it reads for them (`taskBytes`). A row costs at
 * most one task lookup and one write, so a step stays far below Convex's
 * 4,096 index ranges, 16 MiB read and 16,000 documents written per
 * transaction. Tests lower these. */
export const SCOPE_PAGE = { rows: 200, bytes: 4 * 1024 * 1024, taskBytes: 8 * 1024 * 1024 }

/** One step's arguments: the task id the walk started at (`from`, absent
 * for the first task), the page cursor of that walk, and the running counts
 * for the final log. */
type ScopeStep = {
  from?: string
  cursor?: string
  rows?: number
  filled?: number
  orphans?: number
}

const startRef = makeFunctionReference<'mutation', ScopeStep, null>(
  'internal/attachmentScopeBackfill:start',
)

/* Gives `row` the organization and project of `task` where they differ. A
 * row that changes organization also drops any archive mark, which belonged
 * to its old range. Answers what it wrote. */
async function fill(
  ctx: MutationCtx,
  task: Doc<'issues'>,
  row: Doc<'issue_attachments'>,
): Promise<'none' | 'project' | 'organization'> {
  if (row.org_id === task.org_id) {
    if (row.project_id === task.project_id) return 'none'
    await ctx.db.patch(row._id, { project_id: task.project_id })
    return 'project'
  }
  if (row.org_id !== undefined) {
    console.warn('Attachment scope backfill corrected an organization', { id: row.id })
  }
  await ctx.db.patch(row._id, {
    org_id: task.org_id,
    project_id: task.project_id,
    task_archived: undefined,
  })
  return 'organization'
}

/** One step of the backfill, then the next one scheduled. Empty arguments
 * start a run at the first row. */
export const start = internalMutation({
  args: {
    from: v.optional(v.string()),
    cursor: v.optional(v.string()),
    rows: v.optional(v.number()),
    filled: v.optional(v.number()),
    orphans: v.optional(v.number()),
  },
  handler: async (ctx, a): Promise<null> => {
    let rows = a.rows ?? 0
    let filled = a.filled ?? 0
    let orphans = a.orphans ?? 0
    const from = a.from
    const walk =
      from === undefined
        ? ctx.db.query('issue_attachments').withIndex('by_issue')
        : ctx.db.query('issue_attachments').withIndex('by_issue', (q) => q.gte('issue_id', from))
    const page = await walk.paginate({
      cursor: a.cursor ?? null,
      numItems: Math.max(1, SCOPE_PAGE.rows),
      maximumBytesRead: SCOPE_PAGE.bytes,
    })
    let next: ScopeStep | null = page.isDone ? null : { from, cursor: page.continueCursor }
    const tasks = new Map<string, Doc<'issues'> | null>()
    let taskBytes = 0
    const marks = new Set<string>()
    for (const row of page.page) {
      let task = tasks.get(row.issue_id)
      if (task === undefined) {
        // rows are in task order, so every row before this one is done
        if (taskBytes >= SCOPE_PAGE.taskBytes) {
          next = { from: row.issue_id }
          break
        }
        task = await byId(ctx, 'issues', row.issue_id)
        tasks.set(row.issue_id, task)
        if (task !== null) taskBytes += estimateDocumentBytes(task)
      }
      rows += 1
      if (task === null) {
        console.warn('Attachment scope backfill found a row without a task', { id: row.id })
        orphans += 1
        continue
      }
      const wrote = await fill(ctx, task, row)
      if (wrote !== 'none') filled += 1
      if (wrote === 'organization' && task.archived_at !== undefined) marks.add(task.id)
    }
    await scheduleArchiveMarks(ctx, [...marks])
    if (next === null) {
      console.info('Attachment scope backfill done', { rows, filled, orphans })
      return null
    }
    await ctx.scheduler.runAfter(0, startRef, { ...next, rows, filled, orphans })
    return null
  },
})

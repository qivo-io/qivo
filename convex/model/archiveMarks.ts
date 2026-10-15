/* Marks on the relation rows of archived tasks (schema.ts `task_archived`).
 * The app snapshot reads an organization's links, label assignments and
 * attachments, and the caller's own follows, by an index that leaves marked
 * rows out (lib/snapshotRelations.ts, snapshot.ts). Its cost then follows the
 * active tasks instead of everything the organization ever archived.
 *
 * The rule that keeps those reads exact is that a marked row always belongs
 * to an archived task, and a marked link to one with an archived end:
 * - inserts never set the mark;
 * - only markArchivedTask sets it, for a task the caller read archived in the
 *   same transaction. The background steps (markArchivedTasks) read each task
 *   again when they run, and every task archive schedules them through
 *   model/messages.ts scheduleArchivedReads, the call that also marks the
 *   task's messages read. Those paths are archiveIssueCore and the machine
 *   toggle in updateIssueCore with the subtree they stamp, and the nightly
 *   sweep (jobs.ts). A project archive stamps no task, so it marks nothing.
 *   The Northstar demo writer runs it on the archived tasks it inserts
 *   (model/demoSeed.ts);
 * - every restore clears the marks of each task it restores, in the
 *   restoring transaction (clearArchiveMarks). A link loses its mark when
 *   either end returns, which is always safe because an unmarked row may
 *   belong to an archived task and readers filter it as before.
 * Deleting a task or a profile deletes rows, which needs nothing here. */

import { makeFunctionReference } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { byId } from '../lib/db'

/** The most rows one step marks (`rows`) and the most tasks it visits
 * (`tasks`). A visit reads six index ranges whether or not it marks a row, so
 * 250 tasks stay far below Convex's 4,096 ranges per transaction. Tests lower
 * both. */
export const ARCHIVE_MARKS = { rows: 500, tasks: 250 }

/* The step in convex/archiveMarks.ts, referenced by name as model/messages.ts
 * references its steps. */
const markTasksRef = makeFunctionReference<'mutation', { issues: string[] }, null>(
  'archiveMarks:markTasks',
)

/* The five index ranges that hold one task's relation rows. A link is in the
 * range of each of its ends. */
function relationRanges(ctx: MutationCtx, issueId: string) {
  return [
    ctx.db.query('issue_labels').withIndex('by_issue', (q) => q.eq('issue_id', issueId)),
    ctx.db.query('issue_attachments').withIndex('by_issue', (q) => q.eq('issue_id', issueId)),
    ctx.db.query('issue_subscriptions').withIndex('by_issue', (q) => q.eq('issue_id', issueId)),
    ctx.db.query('issue_links').withIndex('by_source', (q) => q.eq('source_id', issueId)),
    ctx.db.query('issue_links').withIndex('by_target', (q) => q.eq('target_id', issueId)),
  ]
}

/**
 * Schedules the background steps that mark the relation rows of the archived
 * `issues`, at most ARCHIVE_MARKS.tasks ids per step. model/messages.ts
 * scheduleArchivedReads calls it, so every task archive path reaches it.
 */
export async function scheduleArchiveMarks(
  ctx: MutationCtx,
  issues: readonly string[],
): Promise<void> {
  const size = Math.max(1, ARCHIVE_MARKS.tasks)
  for (let i = 0; i < issues.length; i += size) {
    await ctx.scheduler.runAfter(0, markTasksRef, { issues: issues.slice(i, i + size) })
  }
}

/**
 * Marks up to `budget` unmarked relation rows of `issue`, which the caller
 * read archived in this transaction. Rows already marked are passed over, so
 * running it again marks nothing. `more` says unmarked rows remain.
 */
export async function markArchivedTask(
  ctx: MutationCtx,
  issue: Doc<'issues'>,
  budget: number,
): Promise<{ marked: number; more: boolean }> {
  if (issue.archived_at === undefined) return { marked: 0, more: false }
  let marked = 0
  for (const range of relationRanges(ctx, issue.id)) {
    for await (const row of range) {
      if (row.task_archived === true) continue
      if (marked >= budget) return { marked, more: true }
      await ctx.db.patch(row._id, { task_archived: true })
      marked += 1
    }
  }
  return { marked, more: false }
}

/**
 * One background step over the tasks `issues`, in order, then the next one
 * scheduled with the ids left. A task that is archived when the step runs
 * has its unmarked relation rows marked. One that was restored or deleted
 * meanwhile is skipped, so a restore before the step leaves its rows as they
 * were. The step stops after ARCHIVE_MARKS.rows rows or ARCHIVE_MARKS.tasks
 * tasks, and the next one starts at the task it did not finish. A step that
 * runs twice marks nothing more.
 */
export async function markArchivedTasks(
  ctx: MutationCtx,
  issues: readonly string[],
): Promise<void> {
  let budget = Math.max(1, ARCHIVE_MARKS.rows)
  const tasks = Math.max(1, ARCHIVE_MARKS.tasks)
  let rest: readonly string[] = []
  for (const [i, issueId] of issues.entries()) {
    if (budget === 0 || i === tasks) {
      rest = issues.slice(i)
      break
    }
    const issue = await byId(ctx, 'issues', issueId)
    if (issue === null || issue.archived_at === undefined) continue
    const step = await markArchivedTask(ctx, issue, budget)
    budget -= step.marked
    if (step.more) {
      rest = issues.slice(i)
      break
    }
  }
  if (rest.length > 0) await ctx.scheduler.runAfter(0, markTasksRef, { issues: [...rest] })
}

/**
 * Clears the marks on every relation row of the task `issueId`, its links
 * at either end included. Each restore runs it, in the restoring transaction,
 * for every task it restores, so the next snapshot reads those rows again.
 */
export async function clearArchiveMarks(ctx: MutationCtx, issueId: string): Promise<void> {
  for (const range of relationRanges(ctx, issueId)) {
    for await (const row of range) {
      if (row.task_archived === true) await ctx.db.patch(row._id, { task_archived: undefined })
    }
  }
}

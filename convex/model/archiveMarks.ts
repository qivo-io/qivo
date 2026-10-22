/* Marks on the relation rows of archived tasks (schema.ts `task_archived`,
 * and `relations_marked` on the task). The label search of REST and MCP
 * (lib/core.ts activeLabelNames) reads a label's assignments by an index
 * that leaves marked rows out, so its cost follows the active tasks instead
 * of everything the organization ever archived, and reads a task with the
 * flag through its own assignments. The archive steps below read one task's
 * marked or unmarked rows. Every other reader sees marked rows like any
 * other: the app reads each shown task's rows through the task's own
 * indexes (lib/workspaceParts.ts readTasks), and billing's storage totals
 * count marked attachments too.
 *
 * The rule that keeps the label search exact is that every marked row
 * belongs to a task with relations_marked, a link through at least one end.
 * These keep it:
 * - Inserts never set a mark.
 * - Only markArchivedTask sets marks, for a task the caller read archived in
 *   the same transaction, and it sets the task's flag in that transaction.
 *   The background steps (markArchivedTasks) read each task again when they
 *   run. Every task archive schedules them through model/messages.ts
 *   scheduleArchivedReads, the call that also marks the task's messages
 *   read. Those paths are archiveIssueCore and the machine toggle in
 *   updateIssueCore with the subtree they stamp, and the nightly sweep
 *   (jobs.ts). A project archive stamps no task, so it marks nothing. The
 *   Northstar demo writer runs markArchivedTask on the archived tasks it
 *   inserts (model/demoSeed.ts).
 * - A restore from the archive writes no relation row. Every such restore
 *   path schedules clear steps (clearMarkedTasks) for each task it restores
 *   that has the flag. A restore from Deleted items (model/deletedItems.ts)
 *   writes the task and its rows back without the flag or any mark, and
 *   schedules the mark steps for the archived tasks it writes back. A
 *   step clears marks in bounded batches while the task is active and unsets
 *   the flag in the transaction that finds no mark left in the task's five
 *   ranges. A step that finds the task archived again stops and leaves its
 *   rows to the mark steps that archive scheduled. Clearing a link while its
 *   other end is archived is safe, because an unmarked row may belong to an
 *   archived task and readers filter it.
 * Until its flag is gone, the app shows an active task's marked follow, and
 * its other rows come from the task's own indexes, which include marked
 * rows, so its rows are back the moment it is restored and stay right if a
 * clear step fails. The nightly
 * sweep (jobs.ts) schedules clears again for active tasks still flagged.
 *
 * Both kinds of step read only the rows they change, from indexes that hold
 * the mark (organization, mark and task for labels, attachments and each
 * link end; task and mark for follows). A row they change leaves the range
 * they read, so a step that continues needs no cursor and reads no row twice.
 * Deleting a task or a profile deletes rows, which needs nothing here. */

import { makeFunctionReference } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { byId } from '../lib/db'

/** The most rows one step marks or clears (`rows`) and the most tasks it
 * visits (`tasks`). A visit reads the task and five index ranges whether or
 * not it changes a row, so 250 tasks stay far below Convex's 4,096 ranges
 * per transaction. Tests lower both. */
export const ARCHIVE_MARKS = { rows: 500, tasks: 250 }

/* The steps in convex/archiveMarks.ts, referenced by name as
 * model/messages.ts references its steps. */
const markTasksRef = makeFunctionReference<'mutation', { issues: string[] }, null>(
  'archiveMarks:markTasks',
)
const clearTasksRef = makeFunctionReference<'mutation', { issues: string[] }, null>(
  'archiveMarks:clearTasks',
)

/* The five index ranges that hold one task's rows with the mark (`marked`)
 * or without it. A link is in the range of each of its ends. */
function markRanges(ctx: MutationCtx, issue: Doc<'issues'>, marked: boolean) {
  const mark = marked ? true : undefined
  return [
    ctx.db
      .query('issue_labels')
      .withIndex('by_org_task_archived_issue', (q) =>
        q.eq('org_id', issue.org_id).eq('task_archived', mark).eq('issue_id', issue.id),
      ),
    ctx.db
      .query('issue_attachments')
      .withIndex('by_org_task_archived_issue', (q) =>
        q.eq('org_id', issue.org_id).eq('task_archived', mark).eq('issue_id', issue.id),
      ),
    ctx.db
      .query('issue_subscriptions')
      .withIndex('by_issue_task_archived', (q) =>
        q.eq('issue_id', issue.id).eq('task_archived', mark),
      ),
    ctx.db
      .query('issue_links')
      .withIndex('by_org_task_archived_source', (q) =>
        q.eq('org_id', issue.org_id).eq('task_archived', mark).eq('source_id', issue.id),
      ),
    ctx.db
      .query('issue_links')
      .withIndex('by_org_task_archived_target', (q) =>
        q.eq('org_id', issue.org_id).eq('task_archived', mark).eq('target_id', issue.id),
      ),
  ]
}

/* Sets (`marked`) or clears the mark on up to `budget` rows of the task's
 * ranges. `more` says rows were left; seeing that costs one row read. */
async function changeMarks(
  ctx: MutationCtx,
  issue: Doc<'issues'>,
  marked: boolean,
  budget: number,
): Promise<{ changed: number; more: boolean }> {
  let changed = 0
  for (const range of markRanges(ctx, issue, !marked)) {
    const room = budget - changed
    const rows = Number.isFinite(room) ? await range.take(room + 1) : await range.collect()
    for (const row of rows.slice(0, room)) {
      await ctx.db.patch(row._id, { task_archived: marked ? true : undefined })
      changed += 1
    }
    if (rows.length > room) return { changed, more: true }
  }
  return { changed, more: false }
}

/**
 * Marks up to `budget` unmarked relation rows of `issue`, which the caller
 * read archived in this transaction, and flags the task once it marks one.
 * `more` says unmarked rows remain.
 */
export async function markArchivedTask(
  ctx: MutationCtx,
  issue: Doc<'issues'>,
  budget: number,
): Promise<{ changed: number; more: boolean }> {
  if (issue.archived_at === undefined) return { changed: 0, more: false }
  const step = await changeMarks(ctx, issue, true, budget)
  if (step.changed > 0 && issue.relations_marked === undefined) {
    await ctx.db.patch(issue._id, { relations_marked: true })
  }
  return step
}

/* One background step of `change` over the tasks `issues`, in order, then
 * the next one scheduled at `ref` with the ids left. The step stops after
 * ARCHIVE_MARKS.rows rows or ARCHIVE_MARKS.tasks tasks, and the next one
 * starts at the task it did not finish. */
async function step(
  ctx: MutationCtx,
  issues: readonly string[],
  ref: typeof markTasksRef,
  change: (issue: Doc<'issues'>, budget: number) => Promise<{ changed: number; more: boolean }>,
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
    if (issue === null) continue
    const done = await change(issue, budget)
    budget -= done.changed
    if (done.more) {
      rest = issues.slice(i)
      break
    }
  }
  if (rest.length > 0) await ctx.scheduler.runAfter(0, ref, { issues: [...rest] })
}

/**
 * One background step that marks the relation rows of the archived tasks
 * `issues`. A task restored or deleted since is skipped, so a restore before
 * the step leaves its rows unmarked. A step that runs twice marks nothing
 * more.
 */
export async function markArchivedTasks(
  ctx: MutationCtx,
  issues: readonly string[],
): Promise<void> {
  await step(ctx, issues, markTasksRef, (issue, budget) => markArchivedTask(ctx, issue, budget))
}

/**
 * One background step that clears the marks of the restored tasks `issues`
 * and unsets each task's flag in the transaction that finds none left. A
 * task archived again since keeps its marks and flag for the mark steps. A
 * deleted task took its rows along, and an active one without the flag has
 * none of its own to clear.
 */
export async function clearMarkedTasks(ctx: MutationCtx, issues: readonly string[]): Promise<void> {
  await step(ctx, issues, clearTasksRef, async (issue, budget) => {
    if (issue.archived_at !== undefined || issue.relations_marked === undefined) {
      return { changed: 0, more: false }
    }
    const done = await changeMarks(ctx, issue, false, budget)
    if (!done.more) await ctx.db.patch(issue._id, { relations_marked: undefined })
    return done
  })
}

/* Schedules `ref` over `issues`, at most ARCHIVE_MARKS.tasks ids per step. */
async function schedule(
  ctx: MutationCtx,
  ref: typeof markTasksRef,
  issues: readonly string[],
): Promise<void> {
  const size = Math.max(1, ARCHIVE_MARKS.tasks)
  for (let i = 0; i < issues.length; i += size) {
    await ctx.scheduler.runAfter(0, ref, { issues: issues.slice(i, i + size) })
  }
}

/**
 * Schedules the steps that mark the relation rows of the archived `issues`.
 * model/messages.ts scheduleArchivedReads calls it, so every task archive
 * path reaches it.
 */
export async function scheduleArchiveMarks(
  ctx: MutationCtx,
  issues: readonly string[],
): Promise<void> {
  await schedule(ctx, markTasksRef, issues)
}

/**
 * Schedules the steps that clear the marks of the tasks among `issues` that
 * have the flag. Every restore path calls it for the tasks it restores, and
 * the nightly sweep for active tasks still flagged.
 */
export async function scheduleMarkClears(
  ctx: MutationCtx,
  issues: readonly Pick<Doc<'issues'>, 'id' | 'relations_marked'>[],
): Promise<void> {
  const flagged = issues.filter((issue) => issue.relations_marked === true)
  await schedule(
    ctx,
    clearTasksRef,
    flagged.map((issue) => issue.id),
  )
}

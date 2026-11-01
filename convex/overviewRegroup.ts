/* After a project archive, restore, move to Deleted items or reveal by a
 * restore from there, the overview counts of its tasks and of the parents
 * they stop or start making groups (model/overviewCounts.ts).
 *
 * A task counts only in a project of its organization that exists, and is
 * a group while it has an active subtask in a live project
 * (lib/liveTasks.ts countsAsSubtask). So a project that comes or goes, or
 * stops or starts being live, changes what its tasks add and which of
 * their parents are groups, in any sub-project of its top-level project
 * (model/issues.ts parentChainCheck keeps a subtask in its parent's
 * top-level project), without a task write. The archive, the restore, the
 * move and the reveal (model/projects.ts archiveProjectCore and
 * unarchiveProjectCore, model/deletedItems.ts moveProjectToTrash and
 * revealProjects) call model/overviewCounts.ts startRegroup in their
 * transaction. It adds the projects to the top-level project's
 * overview_regroups row and starts one chain of steps, each its own
 * transaction, which reads the projects' active tasks a page at a time
 * (issues by_project_archived) and reconciles each task and its parent with
 * what the counts hold for them (reconcileTask), reading their subtasks
 * again. While the row exists, that top-level project's counts answer
 * `counting` (countsReady). A task written meanwhile reconciles itself and
 * its parents; either may come first, and the second finds nothing to
 * move. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation } from './_generated/server'
import { byId, usedMoreThan } from './lib/db'
import { MIB } from './lib/limits'
import {
  isZero,
  keptIn,
  orgCountState,
  overviewRegroupOf,
  reconcileTask,
} from './model/overviewCounts'
import { finishedBefore, positionAfter } from './regroup'

/** Sizes of one step: the tasks and bytes of tasks one page reads, the
 * count rows of a project gone to Deleted items it deletes at once, its
 * shards and its owners' rows, and the share of any of Convex's limits for
 * one transaction past which a step stops before its next task and leaves
 * the rest of the page to the next step. A task's check reads its subtasks until one is in a live project,
 * so its cost has no fixed bound. Tests lower these. */
export const OVERVIEW_REGROUP = { tasks: 200, bytes: 4 * MIB, rows: 2000, room: 0.5 }

/* This module's step, referenced by name, as regroup.ts references its
 * own. */
const stepRef = makeFunctionReference<'mutation', { family_id: string }, null>(
  'overviewRegroup:step',
)

/** One step of a top-level project's regroup, scheduled by name from
 * model/overviewCounts.ts startRegroup and from itself. It deletes the row
 * once its last project is read, or at once when its organization's counts
 * are no longer kept (a teardown, or a backfill deleting them to count
 * again, which reconciles every task). */
export const step = internalMutation({
  args: { family_id: v.string() },
  handler: async (ctx, { family_id }): Promise<null> => {
    const row = await overviewRegroupOf(ctx.db, family_id)
    if (row === null) return null
    const state = await orgCountState(ctx.db, row.org_id)
    const projectId = row.projects[row.at]
    if (!keptIn(state) || projectId === undefined) {
      await ctx.db.delete(row._id)
      return null
    }
    const now = new Date().toISOString()
    const goOn = async (fields: Partial<Doc<'overview_regroups'>>): Promise<null> => {
      await ctx.db.patch(row._id, { ...fields, progress_at: now })
      await ctx.scheduler.runAfter(0, stepRef, { family_id })
      return null
    }
    const page = await ctx.db
      .query('issues')
      .withIndex('by_project_archived', (q) =>
        q.eq('project_id', projectId).eq('archived_at', undefined),
      )
      .paginate({
        cursor: row.cursor ?? null,
        numItems: OVERVIEW_REGROUP.tasks,
        maximumBytesRead: OVERVIEW_REGROUP.bytes,
      })
    // where this step stands in the page, and whether it finished a task
    let position = row.after
    let finishedOne = false
    const checked = new Set<string>()
    for (const task of page.page) {
      if (finishedBefore(task, row.after)) continue
      // a step always finishes one task, so the walk moves on
      if (finishedOne && (await usedMoreThan(ctx, OVERVIEW_REGROUP.room)))
        return await goOn({ after: position })
      if (task.org_id === row.org_id && !checked.has(task.id)) {
        checked.add(task.id)
        await reconcileTask(ctx.db, row.org_id, task.id, task, 'read')
      }
      const parentId = task.parent_id
      if (parentId !== undefined && !checked.has(parentId)) {
        checked.add(parentId)
        const parent = await byId(ctx, 'issues', parentId)
        if (parent !== null && parent.org_id === row.org_id)
          await reconcileTask(ctx.db, row.org_id, parent.id, parent, 'read')
      }
      position = positionAfter(position, task)
      finishedOne = true
    }
    if (!page.isDone) return await goOn({ cursor: page.continueCursor, after: undefined })
    // a project gone to Deleted items counts for nobody: its tasks left
    // its rows, which go too, unless one still holds a leaf (a negative or
    // stray count the backfill's dry run reports)
    if ((await byId(ctx, 'projects', projectId)) === null)
      for (const r of await ctx.db
        .query('overview_counts')
        .withIndex('by_project_owner_shard', (q) => q.eq('project_id', projectId))
        .take(OVERVIEW_REGROUP.rows))
        if (r.org_id === row.org_id && isZero(r)) await ctx.db.delete(r._id)
    if (row.at + 1 >= row.projects.length) {
      await ctx.db.delete(row._id)
      return null
    }
    return await goOn({ at: row.at + 1, cursor: undefined, after: undefined })
  },
})

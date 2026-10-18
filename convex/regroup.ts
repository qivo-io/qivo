/* After a project restore, the parents its tasks make groups again.
 *
 * A task in an active project is a group only through active subtasks in
 * active projects (lib/liveTasks.ts countsAsSubtask). While a sub-project is
 * archived, its tasks make no task in an active project a group, so such a
 * parent may take remaining hours and keep a review hand-off of its own. A
 * restore makes them count again, and a group holds neither, so these steps
 * clear both, as an attach does (model/issues.ts clearParentRemaining). The
 * parent's followers read 'Remaining cleared', said by the restorer, or by
 * no one when the restorer's profile is gone.
 *
 * The restore (model/projects.ts unarchiveProjectCore) schedules one chain
 * with the sub-projects it restored. Each step reads one page of one of them,
 * its active tasks through by_project_archived, at most RESTORE_REGROUP.tasks
 * tasks and RESTORE_REGROUP.bytes bytes, and clears the own hours and hand-off
 * of each parent that is active, in an active project outside the restore,
 * and holds either. A parent the restore brought back too was in an archived
 * project, which counts every active subtask, so nothing changed for it. A
 * sub-project archived again or deleted before its turn is skipped. Until the
 * steps run, such a parent is a group everywhere while its stored hours
 * remain, and no reader uses a group's own hours. */

import { makeFunctionReference } from 'convex/server'
import { type ObjectType, v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { byId } from './lib/db'
import { projectLiveness } from './lib/liveTasks'
import { clearParentRemaining } from './model/issues'

/** Sizes of one regroup step. Tests lower them. */
export const RESTORE_REGROUP = { tasks: 200, bytes: 4 * 1024 * 1024 }

const restoredStepArgs = {
  /** every sub-project the restore brought back, in the order they are read */
  projects: v.array(v.string()),
  /** the one this step reads, by its place in `projects` */
  at: v.optional(v.number()),
  /** where its page starts, a pagination cursor, absent for its first page */
  cursor: v.optional(v.string()),
  restorer_id: v.string(),
}

/* This module's own step, referenced by name, as model/messages.ts
 * references its steps, to keep the module's `internal` type out of its own
 * inference. */
const restoredStepRef = makeFunctionReference<
  'mutation',
  ObjectType<typeof restoredStepArgs>,
  null
>('regroup:restoredStep')

/** One step of a restore's regroup chain, scheduled by name from the
 * restore and from itself. */
export const restoredStep = internalMutation({
  args: restoredStepArgs,
  handler: async (ctx, a): Promise<null> => {
    const at = a.at ?? 0
    const projectId = a.projects[at]
    if (projectId === undefined) return null
    // the same sub-project from `cursor`, else the next one when there is one
    const next = async (cursor?: string): Promise<void> => {
      if (cursor === undefined && at + 1 >= a.projects.length) return
      await ctx.scheduler.runAfter(0, restoredStepRef, {
        ...a,
        at: cursor === undefined ? at + 1 : at,
        cursor,
      })
    }
    const project = await byId(ctx, 'projects', projectId)
    if (project === null || project.archived_at !== undefined) {
      await next()
      return null
    }
    const page = await ctx.db
      .query('issues')
      .withIndex('by_project_archived', (q) =>
        q.eq('project_id', project.id).eq('archived_at', undefined),
      )
      .paginate({
        cursor: a.cursor ?? null,
        numItems: RESTORE_REGROUP.tasks,
        maximumBytesRead: RESTORE_REGROUP.bytes,
      })
    const restored = new Set(a.projects)
    const live = projectLiveness(ctx)
    const restorer = (await byId(ctx, 'profiles', a.restorer_id)) ?? undefined
    const now = new Date().toISOString()
    const checked = new Set<string>()
    for (const task of page.page) {
      if (task.parent_id === undefined || checked.has(task.parent_id)) continue
      checked.add(task.parent_id)
      const parent = await byId(ctx, 'issues', task.parent_id)
      if (parent === null || parent.archived_at !== undefined) continue
      if (parent.remaining_hours === undefined && parent.review_at === undefined) continue
      if (restored.has(parent.project_id) || !(await live(parent.project_id))) continue
      await clearParentRemaining(ctx, { parentId: parent.id, actor: restorer, now })
    }
    await next(page.isDone ? undefined : page.continueCursor)
    return null
  },
})

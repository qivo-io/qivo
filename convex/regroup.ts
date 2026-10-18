/* After a project restore, the tasks it makes groups again.
 *
 * A task in an active project is a group only through active subtasks in
 * active projects (lib/liveTasks.ts countsAsSubtask). While a sub-project is
 * archived, its tasks make no task in an active project a group, so such a
 * task may take remaining hours and keep a review hand-off of its own. A
 * restore makes them count again, and a group holds neither, so these steps
 * clear both, as an attach does (model/issues.ts clearParentRemaining). The
 * task's followers read 'Remaining cleared', said by the restorer, or by no
 * one when the restorer's profile is gone.
 *
 * The restore (model/projects.ts unarchiveProjectCore) schedules one chain
 * with the projects it restored. Each step reads one page of one of them,
 * its active tasks through by_project_archived, at most RESTORE_REGROUP.tasks
 * tasks and RESTORE_REGROUP.bytes bytes. It clears the own hours and
 * hand-off of two kinds of task that hold either:
 *   - the parent of a page task, when the parent is active and in an active
 *     project, which the live page task makes a group;
 *   - a page task that is a group now, such as one whose subtasks are in a
 *     sub-project restored before its own. Archiving its project made it a
 *     group with the hours it took as a leaf, and no step cleared them then.
 * A project archived again or deleted before its turn is skipped. Until
 * the steps run, such a task is a group everywhere while its stored hours
 * remain, and no app reader uses a group's own hours. */

import { makeFunctionReference } from 'convex/server'
import { type Infer, type ObjectType, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, type MutationCtx } from './_generated/server'
import { byId } from './lib/db'
import { projectLiveness } from './lib/liveTasks'
import { clearParentRemaining, hasSubtasks } from './model/issues'
import { loadNotifyPreload, type NotifyPreload } from './model/messages'

/** Sizes of one regroup step. It reads at most `tasks` tasks and `bytes`
 * bytes of them, and clears about `clears` tasks at most. A page task's
 * subtask check reads its subtasks, and each clear notifies the task's
 * followers and its task.updated subscribers, so neither has a fixed cost.
 * Before each page task after its first, a step therefore also stops once
 * it has used the share `room` of any of Convex's limits for one
 * transaction, as the subtask family backfill does
 * (internal/subtaskFamilyBackfill.ts). A step that stops leaves the next one
 * the same page from the task after the last it finished. Tests lower
 * these. */
export const RESTORE_REGROUP = { tasks: 200, bytes: 4 * 1024 * 1024, clears: 50, room: 0.5 }

/* Where an earlier step stopped in a page, as the creation time of the last
 * task it finished and the ids of every finished task with that time.
 * Tasks can share a creation time, so the ids tell those apart. */
const vPosition = v.object({ time: v.number(), ids: v.array(v.string()) })
type Position = Infer<typeof vPosition>

const restoredStepArgs = {
  /** every project the restore brought back, in the order they are read */
  projects: v.array(v.string()),
  /** the one this step reads, by its place in `projects` */
  at: v.optional(v.number()),
  /** where its page starts, a pagination cursor, absent for its first page */
  cursor: v.optional(v.string()),
  /** where an earlier step stopped in this page, absent for a fresh page */
  after: v.optional(vPosition),
  restorer_id: v.string(),
}
type RestoredStep = ObjectType<typeof restoredStepArgs>

/** Whether an earlier step finished this page task, by where it stopped. */
export function finishedBefore(
  task: Pick<Doc<'issues'>, '_creationTime' | 'id'>,
  after: Position | undefined,
): boolean {
  if (after === undefined) return false
  return (
    task._creationTime < after.time ||
    (task._creationTime === after.time && after.ids.includes(task.id))
  )
}

/** Where a step stands once it has finished `task`, the next page task
 * after `at`. */
export function positionAfter(
  at: Position | undefined,
  task: Pick<Doc<'issues'>, '_creationTime' | 'id'>,
): Position {
  return at?.time === task._creationTime
    ? { time: at.time, ids: [...at.ids, task.id] }
    : { time: task._creationTime, ids: [task.id] }
}

/* This module's own step, referenced by name, as model/messages.ts
 * references its steps, to keep the module's `internal` type out of its own
 * inference. */
const restoredStepRef = makeFunctionReference<'mutation', RestoredStep, null>(
  'regroup:restoredStep',
)

/* Whether the step has used more than RESTORE_REGROUP.room of any of
 * Convex's limits for one transaction. */
async function stepIsFull(ctx: MutationCtx): Promise<boolean> {
  const metrics = await ctx.meta.getTransactionMetrics()
  return Object.values(metrics).some(
    ({ used, remaining }) => used > (used + remaining) * RESTORE_REGROUP.room,
  )
}

/* Whether a task holds remaining hours or a review hand-off of its own. */
const holdsOwn = (task: Doc<'issues'>): boolean =>
  task.remaining_hours !== undefined || task.review_at !== undefined

/** One step of a restore's regroup chain, scheduled by name from the
 * restore and from itself. */
export const restoredStep = internalMutation({
  args: restoredStepArgs,
  handler: async (ctx, a): Promise<null> => {
    const at = a.at ?? 0
    const projectId = a.projects[at]
    if (projectId === undefined) return null
    const schedule = (args: RestoredStep) => ctx.scheduler.runAfter(0, restoredStepRef, args)
    // the same project from `cursor`, else the next one when there is one
    const next = async (cursor?: string): Promise<void> => {
      if (cursor === undefined && at + 1 >= a.projects.length) return
      await schedule({ ...a, at: cursor === undefined ? at + 1 : at, cursor, after: undefined })
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
    const live = projectLiveness(ctx)
    const restorer = (await byId(ctx, 'profiles', a.restorer_id)) ?? undefined
    const now = new Date().toISOString()
    // A step changes no profile, project, grant or team, so one preload,
    // read at the first clear, serves every notice (NotifyPreload).
    let preload: NotifyPreload | undefined
    let cleared = 0
    const clear = async (task: Doc<'issues'>): Promise<void> => {
      preload ??= await loadNotifyPreload(ctx, project.org_id)
      await clearParentRemaining(ctx, { parentId: task.id, actor: restorer, now, preload })
      cleared += 1
    }
    // tasks this step has looked at, as page tasks or parents; a page row
    // of one it cleared still holds the old hours
    const checked = new Set<string>()
    // where this step stands in the page, and whether it finished a task
    let position = a.after
    let finishedOne = false
    for (const task of page.page) {
      if (finishedBefore(task, a.after)) continue
      // a step always finishes one task, so the walk moves on
      if (finishedOne && (cleared >= RESTORE_REGROUP.clears || (await stepIsFull(ctx)))) {
        await schedule({ ...a, after: position })
        return null
      }
      // the task itself, when subtasks restored before it make it a group
      if (!checked.has(task.id)) {
        checked.add(task.id)
        if (holdsOwn(task) && (await hasSubtasks(ctx, task, live))) await clear(task)
      }
      // its parent, which this live task makes a group when the parent is
      // active and in an active project
      const parentId = task.parent_id
      if (parentId !== undefined && !checked.has(parentId)) {
        checked.add(parentId)
        const parent = await byId(ctx, 'issues', parentId)
        if (
          parent !== null &&
          parent.archived_at === undefined &&
          holdsOwn(parent) &&
          (await live(parent.project_id))
        ) {
          await clear(parent)
        }
      }
      position = positionAfter(position, task)
      finishedOne = true
    }
    await next(page.isDone ? undefined : page.continueCursor)
    return null
  },
})

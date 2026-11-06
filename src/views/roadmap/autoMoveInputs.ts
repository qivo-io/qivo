/* Auto-move's tasks from the Roadmap's dependency answer
   (convex/lib/roadmap.ts AutoMoveInputs): the parts of the dependency graph
   that hold a task of the selection, inside it and outside it, as the
   solver reads them (src/lib/schedule.ts autoMoves). The Roadmap
   (views/Roadmap.tsx) builds them with the dates on screen, and the parity
   test (store/roadmapParity.test.ts) with the answer's own, so the parity
   pins this code. It imports no store, so the test can load it beside the
   store it boots. */

import type { AutoMoveInputs, DependencyRow } from '../../../convex/lib/roadmap'
import { type AutoMove, autoMoves, type ScheduleTask } from '../../lib/schedule'

/** A task of a part as the solver reads it, by uuid, with its row. */
export type PartTask = ScheduleTask & { id: string; project: string; row: DependencyRow }

/** The weeks and status the Roadmap or the workspace shows of a part's
    task now, painted with the person's pending writes. */
export type ShownDates = { start: number | null; end: number | null; status: string }

/**
 * The solver's tasks of `inputs`, weeks on the grid `toWeek` reads (the
 * grid of now), each by uuid: a task without subtasks by its stored dates,
 * an end at least its start; a group by its span, with its children from
 * the parent ids in the same answer; and each task's links from the
 * answer's pairs in their order, which is the order the app lists a task's
 * links in. Where `shown` gives a task's dates and status on screen, the
 * Roadmap's or the workspace's model with pending edits, those count
 * instead, so the count follows a drag at once.
 */
export function autoMoveTasks(
  inputs: AutoMoveInputs,
  toWeek: (iso: string) => number,
  shown: (uuid: string) => ShownDates | undefined = () => undefined,
): PartTask[] {
  const week = (iso: string | undefined) => (iso === undefined ? null : toWeek(iso))
  const children = new Map<string, string[]>()
  for (const row of inputs.tasks)
    if (row.parent_id !== undefined) {
      const kids = children.get(row.parent_id)
      if (kids) kids.push(row.id)
      else children.set(row.parent_id, [row.id])
    }
  const links = new Map<string, { type: string; id: string }[]>()
  const link = (from: string, entry: { type: string; id: string }) => {
    const list = links.get(from)
    if (list) list.push(entry)
    else links.set(from, [entry])
  }
  for (const pair of inputs.pairs) {
    link(pair.blocker, { type: 'blocks', id: pair.blocked })
    link(pair.blocked, { type: 'blocked_by', id: pair.blocker })
  }
  return inputs.tasks.map((row) => {
    const group = row.has_subtasks
    const start = group ? week(row.span?.start_week) : week(row.start_week)
    const endWeek = group ? week(row.span?.end_week) : week(row.end_week)
    const end = group || endWeek === null ? endWeek : Math.max(start ?? endWeek, endWeek)
    // a leaf's dates as the screen shows them; a group's span follows its
    // leaves in the solver, so its own stays the answer's
    const now = group ? undefined : shown(row.id)
    return {
      id: row.id,
      status: now?.status ?? row.status,
      project: row.project_id,
      isGroup: group,
      children: children.get(row.id) ?? [],
      start: now ? now.start : start,
      end: now
        ? now.end === null || now.start === null
          ? now.end
          : Math.max(now.start, now.end)
        : end,
      links: links.get(row.id) ?? [],
      row,
    }
  })
}

/** Auto-move's moves over `tasks` (autoMoveTasks), each by uuid, where the
    reader may edit a task's project (`inputs.editable_projects`). */
export function autoMoveMoves(inputs: AutoMoveInputs, tasks: readonly PartTask[]): AutoMove[] {
  const editable = new Set(inputs.editable_projects)
  return autoMoves({
    issues: tasks,
    byId: Object.fromEntries(tasks.map((it) => [it.id, it])),
    canWrite: (it) => editable.has(it.project),
  })
}

/* The tasks the task window's parent and subtask pickers offer. A subtask
   stays in its parent's top-level project, in any of its sub-projects, so
   both lists keep only tasks of the open task's top-level project. Setting a
   parent changes both tasks, so the server needs Edit on each, and only tasks
   in editable projects are offered. Every relation is same-organization by
   the server's guard, so the blended snapshot is narrowed to the task's own
   organization first. The task's own sub-project comes first.

   A task has one level of subtasks, at most LIMITS.subtasks.max active
   ones (convex/lib/limits.ts), so neither picker offers a link the server
   would refuse: no subtask as a parent, no task with subtasks as a subtask
   and no parent that is full. Archived subtasks do not count toward a full
   parent, as on the server, though the server still refuses a parent for a
   task whose only subtasks are archived. The view counts the active
   subtasks it shows, so a task whose other active subtasks are hidden from
   the reader, or sit in an archived sub-project, can still be refused, with
   the server's sentence. A full task's tooltip is that sentence too. */

import { LIMITS } from '../../convex/lib/limits'

/** A task as the pickers read it. */
export type RelationTask = {
  id: string
  org: string
  project: string
  parent?: string | null
  children?: readonly string[]
  hasHiddenParent?: boolean
  hasHiddenSubtasks?: boolean
}

/** What the pickers need from the store. `topLevelOf` answers the top-level
 * project of a project, or undefined for one outside this view. */
export type RelationView<T extends RelationTask> = {
  byId: Readonly<Record<string, T | undefined>>
  topLevelOf: (projectId: string) => string | undefined
  canWrite: (projectId: string) => boolean
}

const isSubtask = (x: RelationTask): boolean => !!x.parent || !!x.hasHiddenParent
const hasSubtasks = (x: RelationTask): boolean =>
  (x.children?.length ?? 0) > 0 || !!x.hasHiddenSubtasks
const subtasksFull = (x: RelationTask): boolean => (x.children?.length ?? 0) >= LIMITS.subtasks.max

/** Why `it` can take no more subtasks, as a control's tooltip, or undefined
 * when it can. The tooltip sits on the full task's own window, so it speaks of
 * "this task" where the server's refusal names the parent. */
export function subtaskBlock(it: RelationTask): string | undefined {
  if (isSubtask(it)) return 'A subtask cannot have subtasks'
  if (subtasksFull(it))
    return `This task has ${LIMITS.subtasks.max} active subtasks, the most a task can have. Archive or remove one of them first.`
  return undefined
}

/** Why `it` cannot get a parent, as a control's tooltip, or undefined when
 * it can. */
export function parentBlock(it: RelationTask): string | undefined {
  return hasSubtasks(it) ? 'A task with subtasks cannot become a subtask' : undefined
}

/* Whether `x` is in `it`'s organization and top-level project. A project
   outside this view matches nothing. */
function sameFamily<T extends RelationTask>(it: T, x: T, view: RelationView<T>): boolean {
  const top = view.topLevelOf(it.project)
  return x.org === it.org && top !== undefined && view.topLevelOf(x.project) === top
}

const sameProjectFirst =
  <T extends RelationTask>(it: T) =>
  (a: T, b: T): number =>
    Number(b.project === it.project) - Number(a.project === it.project)

/** The tasks `it` can be attached under: tasks that are no subtask and have
 * room for one more. A task with subtasks gets none. The current parent
 * stays listed, wherever it is, so it can be cleared. */
export function parentCandidatesFor<T extends RelationTask>(
  it: T,
  tasks: readonly T[],
  view: RelationView<T>,
): T[] {
  const open = parentBlock(it) === undefined
  return tasks
    .filter(
      (x) =>
        x.id === it.parent ||
        (open &&
          x.id !== it.id &&
          !isSubtask(x) &&
          !subtasksFull(x) &&
          sameFamily(it, x, view) &&
          view.canWrite(x.project)),
    )
    .sort(sameProjectFirst(it))
}

/** The tasks that can become `it`'s subtasks: tasks without subtasks of
 * their own. A subtask, or a task that is full, gets none. A current
 * subtask stays listed, wherever it is, so it can be removed; removing one
 * needs Edit on it like adding one. */
export function subtaskCandidatesFor<T extends RelationTask>(
  it: T,
  tasks: readonly T[],
  view: RelationView<T>,
): T[] {
  const open = subtaskBlock(it) === undefined
  return tasks
    .filter(
      (x) =>
        x.org === it.org &&
        x.id !== it.id &&
        (x.parent === it.id || (open && !hasSubtasks(x) && sameFamily(it, x, view))) &&
        view.canWrite(x.project),
    )
    .sort(sameProjectFirst(it))
}

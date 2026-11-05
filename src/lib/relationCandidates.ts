/* Why the task window's own task can take no parent or no more subtasks,
   as its Parent and Subtasks buttons and pickers word it. A task has one
   level of subtasks, at most LIMITS.subtasks.max active ones
   (convex/lib/limits.ts). The window counts the subtasks it shows, the
   larger of the workspace's list and the whole section list
   (store/planner.ts capInputs), so a list it holds only part of disables
   more and never allows more. The tasks each picker offers come from the
   server (convex/lib/relationPicker.ts), which applies the write's own
   rules, archived and hidden subtasks included, before it answers, and
   the server's own block code for the task is worded here too
   (panels/RelationPicker.tsx). */

import { LIMITS } from '../../convex/lib/limits'

/** A task as the blocks read it. */
export type RelationTask = {
  id: string
  org: string
  project: string
  parent?: string | null
  children?: readonly string[]
  hasHiddenParent?: boolean
  hasHiddenSubtasks?: boolean
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

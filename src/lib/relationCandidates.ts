/* The tasks the task window's parent and subtask pickers offer. A subtask
   stays in its parent's top-level project, in any of its sub-projects, so
   both lists keep only tasks of the open task's top-level project. Setting a
   parent changes both tasks, so the server needs Edit on each, and only tasks
   in editable projects are offered. Every relation is same-organization by
   the server's guard, so the blended snapshot is narrowed to the task's own
   organization first. The task's own sub-project comes first. */

/** A task as the pickers read it. */
export type RelationTask = {
  id: string
  org: string
  project: string
  parent?: string | null
  children?: readonly string[]
}

/** What the pickers need from the store. `topLevelOf` answers the top-level
 * project of a project, or undefined for one outside this view. */
export type RelationView<T extends RelationTask> = {
  byId: Readonly<Record<string, T | undefined>>
  topLevelOf: (projectId: string) => string | undefined
  canWrite: (projectId: string) => boolean
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

/** The tasks `it` can be attached under. The task itself and everything below
 * it would form a cycle and are left out. The current parent stays listed,
 * wherever it is, so it can be cleared. */
export function parentCandidatesFor<T extends RelationTask>(
  it: T,
  tasks: readonly T[],
  view: RelationView<T>,
): T[] {
  const below = new Set<string>()
  const stack = [...(it.children ?? [])]
  while (stack.length) {
    const id = stack.pop() as string
    if (below.has(id)) continue
    below.add(id)
    stack.push(...(view.byId[id]?.children ?? []))
  }
  return tasks
    .filter(
      (x) =>
        x.id === it.parent ||
        (x.id !== it.id && !below.has(x.id) && sameFamily(it, x, view) && view.canWrite(x.project)),
    )
    .sort(sameProjectFirst(it))
}

/** The tasks that can become `it`'s subtasks. The task itself and everything
 * above it would form a cycle and are left out. A current subtask stays
 * listed, wherever it is, so it can be removed; removing one needs Edit on
 * it like adding one. */
export function subtaskCandidatesFor<T extends RelationTask>(
  it: T,
  tasks: readonly T[],
  view: RelationView<T>,
): T[] {
  const above = new Set<string>()
  for (let up = it.parent; up && !above.has(up); up = view.byId[up]?.parent) above.add(up)
  return tasks
    .filter(
      (x) =>
        x.org === it.org &&
        x.id !== it.id &&
        !above.has(x.id) &&
        (x.parent === it.id || sameFamily(it, x, view)) &&
        view.canWrite(x.project),
    )
    .sort(sameProjectFirst(it))
}

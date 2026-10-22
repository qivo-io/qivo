import { useRef } from 'react'

/* A result over every task that a delivery changing one task should not
   work out again. The store keeps a task's object while it does not change
   (P.issues), so comparing the list with the last one by identity finds the
   changed tasks in one pass of pointer comparisons; the result is worked
   out again only when one of them changed in a value it reads. */

type Last<T, R> = { tasks: readonly T[]; deps: readonly unknown[]; result: R }

/** Whether `tasks` reads the same as `last` for `read`: the same tasks in
    the same order, each changed one with the same values. */
export function sameReads<T extends { id: string }>(
  last: readonly T[],
  tasks: readonly T[],
  read: (task: T) => readonly unknown[],
) {
  if (last === tasks) return true
  if (last.length !== tasks.length) return false
  for (let i = 0; i < tasks.length; i++) {
    const before = last[i]
    const after = tasks[i]
    if (before === after) continue
    if (before.id !== after.id) return false
    const a = read(before)
    const b = read(after)
    if (a.length !== b.length || a.some((value, k) => !Object.is(value, b[k]))) return false
  }
  return true
}

/** `compute(tasks)`, worked out again only when `deps` changed or a task
    changed in one of the values `read` lists for it. */
export function useTaskMemo<T extends { id: string }, R>(
  tasks: readonly T[],
  read: (task: T) => readonly unknown[],
  compute: (tasks: readonly T[]) => R,
  deps: readonly unknown[],
): R {
  const last = useRef<Last<T, R> | null>(null)
  const held = last.current
  if (
    held &&
    held.deps.length === deps.length &&
    held.deps.every((value, i) => Object.is(value, deps[i])) &&
    sameReads(held.tasks, tasks, read)
  ) {
    held.tasks = tasks
    return held.result
  }
  const result = compute(tasks)
  last.current = { tasks, deps, result }
  return result
}

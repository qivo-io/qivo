// The combined load benchmark's plan of the organization it grows
// (scripts/benchmark-load.mjs setup), kept here so a test can check it
// without a backend.

/** The statuses of a task that an assignment hands to its new assignee
    with an Inbox message (convex/model/messages.ts notifyIssueUpdate): open
    and not in Review, whose owner is the reviewer (lib/review.ts). */
const ASSIGNABLE = new Set(['backlog', 'todo', 'progress'])

/**
 * The assignments that give each of `owners` (profile ids) `each` open
 * tasks of `tasks` (Board rows), so the people setup adds hold tasks and,
 * from each assignment's "Assigned to you" message, Inbox items as an
 * everyday person does. A task is taken only when it is open outside
 * Review, has no subtasks and no parent, and is not `keep`'s (Nora's, whose
 * views the recorded sets show), in id order. A task an owner already holds
 * counts toward that owner's `each`, so a second run adds only what is
 * missing. Answers [task id, owner] pairs and the owners left short.
 */
export function everydayAssignments(owners, tasks, each, keep) {
  const mine = new Set(owners)
  const held = new Map(owners.map((owner) => [owner, 0]))
  for (const task of tasks)
    if (mine.has(task.assignee_id)) held.set(task.assignee_id, held.get(task.assignee_id) + 1)
  const free = tasks
    .filter(
      (task) =>
        ASSIGNABLE.has(task.status) &&
        !task.has_subtasks &&
        !task.parent_id &&
        task.assignee_id !== keep &&
        !mine.has(task.assignee_id),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const pairs = []
  const short = []
  for (const owner of owners) {
    for (let n = held.get(owner); n < each; n++) {
      const task = free.shift()
      if (!task) break
      pairs.push([task.id, owner])
      held.set(owner, n + 1)
    }
    if (held.get(owner) < each) short.push(owner)
  }
  return { pairs, short }
}

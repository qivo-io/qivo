/** Backlog stays off the roadmap. A group's own status is dormant, so a group
 * is never hidden as Backlog. Completed tasks (`done` is true for a leaf in
 * Done or a group whose leaves are all done, as P.isDone answers) remain only
 * while their planned period intersects the inclusive visible window. Active
 * tasks also appear when unplanned or outside it so they can still be
 * scheduled. */
export function isRoadmapTaskVisible(
  task: { status: string; isGroup: boolean; start?: number | null; end?: number | null },
  done: boolean,
  windowStart: number,
  windowEnd: number,
): boolean {
  if (!task.isGroup && task.status === 'backlog') return false
  if (!done) return true
  return (
    task.start != null && task.end != null && task.start <= windowEnd && task.end >= windowStart
  )
}

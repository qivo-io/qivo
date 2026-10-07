/** Backlog stays off the roadmap. Completed tasks remain only while their
 * planned period intersects the inclusive visible window; active tasks also
 * appear when unplanned or outside it so they can still be scheduled. */
export function isRoadmapTaskVisible(
  task: { status: string; start?: number | null; end?: number | null },
  windowStart: number,
  windowEnd: number,
): boolean {
  if (task.status === 'backlog') return false
  if (task.status !== 'done') return true
  return (
    task.start != null && task.end != null && task.start <= windowEnd && task.end >= windowStart
  )
}

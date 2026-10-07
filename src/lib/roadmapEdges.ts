export type RoadmapEdge = {
  kind: 'continuation' | 'outside'
  /** Hidden task weeks for a continuation; complete intervening weeks otherwise. */
  weeks: number
  /** The task endpoint to reveal when the marker is activated. */
  endpoint: number
}

/** Compare a scheduled task with the visible window, both in inclusive week indexes.
 * These describe planned dates, independently of the task's completion status. */
export function roadmapEdges(
  start: number,
  end: number,
  windowStart: number,
  windowEnd: number,
): { left: RoadmapEdge | null; right: RoadmapEdge | null } {
  if (end < windowStart) {
    return {
      left: { kind: 'outside', weeks: windowStart - end - 1, endpoint: end },
      right: null,
    }
  }
  if (start > windowEnd) {
    return {
      left: null,
      right: { kind: 'outside', weeks: start - windowEnd - 1, endpoint: start },
    }
  }
  return {
    left:
      start < windowStart
        ? { kind: 'continuation', weeks: windowStart - start, endpoint: start }
        : null,
    right: end > windowEnd ? { kind: 'continuation', weeks: end - windowEnd, endpoint: end } : null,
  }
}

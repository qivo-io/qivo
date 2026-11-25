/* A person's weekly figures as the Roadmap's Team utilization
   (views/Resources.tsx) and the Overview's Load this week
   (views/overview/ProjectOverview.tsx) spread them from the owner-load
   cache's work (P.ownerItems): the hours each week holds and the weeks
   with paused work, from the projects the reader can see only. */

import { issueLoadByPerson, type LoadIssue, pausedWeeksByPerson } from '../lib/workload'
import type { OwnerItem } from '../store/viewDelay'

/** What the strip knows of one person's weeks: still loading, unknown, or
    the hours each shown week holds and the weeks with paused work. */
export type Figures =
  | { state: 'waiting' }
  | { state: 'unknown' }
  | {
      state: 'ok'
      hours: Map<number, number>
      paused: Set<number>
      /** the work the figures spread, for a drag's spread again */
      items: readonly OwnerItem[]
    }

/** Person `id`'s figures over the weeks `range` from their work `items`
    (P.ownerItems), keeping, under This project, the work whose project
    `inScope` keeps, and with the weeks of the tasks in `live` (by uuid)
    replaced by their drafts. Work without a project, busy time the reader
    cannot see, stays out. */
export function figuresOf(
  id: string,
  items: readonly OwnerItem[],
  range: { from: number; to: number },
  inScope: ((pid: string) => boolean) | undefined,
  live?: Record<string, { start: number; end: number }>,
): Extract<Figures, { state: 'ok' }> {
  const issues: LoadIssue[] = []
  for (const item of items) {
    if (item.project === null) continue
    const draft = item.uuid ? live?.[item.uuid] : undefined
    issues.push({
      owner: id,
      project: item.project,
      start: draft ? draft.start : item.start,
      end: draft ? draft.end : item.end,
      remaining: item.remaining,
      remainingSet: item.remainingSet,
      paused: item.paused,
    })
  }
  const hours = new Map<number, number>()
  issueLoadByPerson(issues, inScope, range)
    .get(id)
    ?.forEach((byProject, week) => {
      let total = 0
      byProject.forEach((h) => {
        total += h
      })
      hours.set(week, total)
    })
  const paused = pausedWeeksByPerson(issues, inScope, range).get(id) ?? new Set<number>()
  return { state: 'ok', hours, paused, items }
}

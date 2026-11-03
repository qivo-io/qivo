/* The Overview's figures as the page derived them from the workspace's
 * tasks before it read the server's (convex/overview.ts), kept unchanged
 * as the oracle store/overviewParity.test.ts compares the server's answers
 * with: the store's rules drive the Board and the Roadmap too, so a drift
 * between them and the server shows here while the workspace holds every
 * task. The stage that stops loading every task ends or rewrites it. The
 * test imports it after the store it boots, so it reads that store. */

import { type IssueVM, P, type ScopeInfo } from './planner'

/** The summary's figures over `scoped`, the scope's tasks
 * (P.scopedIssues(info)): Completion over the leaves, In progress and In
 * review leaves, the paused leaves (a group's own pause is dormant), the
 * tasks not done and due before today, and the Overdue & at risk list, the
 * overdue ones and, in projects that track delay, those projected late,
 * by due date. */
export function overviewFigures(info: ScopeInfo, scoped: IssueVM[]) {
  const prog = P.progressIn(info.subIds, info.only)
  const inProgress = scoped.filter((i) => !P.isGroup(i) && i.status === 'progress').length
  const inReview = scoped.filter((i) => !P.isGroup(i) && i.status === 'review').length
  const pausedIssues = scoped.filter((i) => P.isPaused(i))
  /* The two halves of "at risk", counted apart for the summary sentence: a date
     already lost reads differently from one the plan says is about to be. The
     list below merges them because the ROWS are the same shape; the sentence
     must not, because the advice differs. */
  const overdueCount = scoped.filter((i) => !P.isDone(i) && i.due && i.due < P.TODAY_ISO).length
  // deadlines lost or being lost: past-due (any project) plus, for
  // delay-tracking projects, issues the capacity projection says will miss
  // their due date (0064). A 'late' verdict implies a due date, so every
  // row has one to sort and render by.
  const atRiskIssues = scoped
    .filter((i) => {
      if (P.isDone(i)) return false
      if (i.due && i.due < P.TODAY_ISO) return true
      const d = P.tracksDelay(i) ? P.delayOf(i) : null
      return !!(d && d.status === 'late')
    })
    .sort((a, b) => (a.due < b.due ? -1 : 1))
  return { prog, inProgress, inReview, pausedIssues, overdueCount, atRiskIssues }
}

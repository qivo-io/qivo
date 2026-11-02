/* The Overview's figures over a scope's tasks as the page shows them, in
 * one place that src/views/Overview.tsx renders from and the server's
 * parity test (src/store/overviewParity.test.ts) compares with: the
 * summary strip and sentence, the two lists, the status distribution and
 * the health rows. Pure reads of the store; nothing here renders. The
 * server's reads (convex/lib/overview.ts) answer the same figures without
 * loading every task. */

import { type IssueVM, P, type ScopeInfo } from '../store/planner'

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

/** The status distribution of `items`: how many of them without subtasks
 * hold each status. */
export function statusCounts(items: IssueVM[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(P.STATUSES.map((s) => [s.id, 0]))
  for (const it of items) if (!P.isGroup(it) && it.status in out) out[it.status]++
  return out
}

/** The health table's rows, a row per group of `info` over the group's
 * tasks among `scoped`, unsorted: Completion, Left, Delayed, Slipping and
 * Paused. In My view a project holding none of the person's tasks has no
 * row. */
export function healthRows(info: ScopeInfo, scoped: IssueVM[], mine: boolean) {
  /* A row per group, over the group's issues as this scope sees them.
     In My view a project I have nothing in gets no row at all — an
     all-zero health row would say "this project is stalled" when it
     only means the work there isn't mine. */
  // one pass over the scope's tasks for every group, not one per group
  const groupOf = new Map<string, number[]>()
  info.groups.forEach((g, i) => {
    for (const id of g.subIds) groupOf.set(id, [...(groupOf.get(id) ?? []), i])
  })
  const held: IssueVM[][] = info.groups.map(() => [])
  for (const it of scoped) for (const i of groupOf.get(it.project) ?? []) held[i].push(it)
  const subIdLists = info.groups.map((g) => g.subIds)
  const progress = P.progressByGroups(subIdLists, info.only)
  const remaining = P.remainingByGroups(subIdLists, info.only)
  return info.groups
    .map((g, gi) => {
      const issues = held[gi]
      const gp = progress[gi]
      const leadId = P.leadOf(g.proj.id)
      /* Projected verdicts (0064), gated PER ISSUE: `delayOf` returns the
       raw projection for every issue — only `delayColor` consults the
       tracking toggle — so the gate has to be asked here, and asking it
       per issue is what a group spanning several sub-projects needs. */
      const delayCount = (s: string) =>
        issues.filter((i) => {
          if (!P.tracksDelay(i)) return false
          const d = P.delayOf(i)
          return d && d.status === s
        }).length
      return {
        proj: g.proj,
        issues,
        pct: gp.pct,
        done: gp.done,
        total: gp.total,
        remaining: remaining[gi],
        lead: leadId ? P.user(leadId) : null,
        late: delayCount('late'),
        behind: delayCount('behind'),
        paused: issues.filter((i) => P.isPaused(i)).length,
      }
    })
    .filter((r) => !mine || r.issues.length > 0)
}

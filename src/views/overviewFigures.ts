/* The Overview's figures that still come from the workspace's tasks, in
 * one place that src/views/Overview.tsx renders from and the server's
 * parity test (src/store/overviewParity.test.ts) compares with: the
 * health table's rows and its sparkbars' status distribution. Pure reads
 * of the store; nothing here renders. The page reads its summary, its
 * delays and its two lists from the server (convex/overview.ts), and the
 * health stage (t3/limits-overview-health) moves these onto the per
 * sub-project reader (convex/lib/overview.ts subProjectHealth) the same
 * way, keeping them as the test's oracle. */

import { type IssueVM, P, type ScopeInfo } from '../store/planner'

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

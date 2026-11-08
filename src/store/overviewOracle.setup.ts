/* The Overview's figures as the page derived them from the workspace's
 * tasks before it read the server's (convex/overview.ts), kept as the
 * oracle store/overviewParity.test.ts compares the server's answers with:
 * the page's former summary, its two lists and its health rows with their
 * sparkbars' status distribution, and the health table's order as the
 * server documents it (healthOrder). It pins the server's summary, lists
 * and health table to the store's rules (P.isDone, P.isPaused, P.delayOf),
 * which the Roadmap, Team sync and the task window still use, over a store
 * that asked for every task, until the stage that removes the workspace's
 * load rows. The task sums the page read (progressIn, remainingIn,
 * progressByGroups) live here since the store stopped offering them. The
 * test imports it after the store it boots, so it reads that store. */

import { compareValues, type Value } from 'convex/values'
import { nameKey } from '../../convex/lib/nameKey'
import type { HealthSort } from '../../convex/lib/overview'
import { type IssueVM, P, type ScopeInfo } from './planner'

type Only = ((it: IssueVM) => boolean) | null | undefined

/** Completion over the leaf tasks of sub-projects `subIds` that `only`
 * keeps (My view counts the person's own), from the workspace's tasks. */
export function progressIn(subIds: string[], only?: Only) {
  const set = new Set(subIds)
  const list = P.issues.filter((i) => set.has(i.project) && !P.isGroup(i) && (!only || only(i)))
  const total = list.length
  const done = list.filter((i) => i.status === 'done').length
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0 }
}

/** The summed remaining hours of the not-done leaf tasks of sub-projects
 * `subIds` that `only` keeps, own hours only (0066). */
export function remainingIn(subIds: string[], only?: Only) {
  const set = new Set(subIds)
  const sum = P.issues
    .filter((i) => set.has(i.project) && !P.isGroup(i) && i.status !== 'done' && (!only || only(i)))
    .reduce((s, i) => s + (i.remaining || 0), 0)
  return Math.round(sum * 10) / 10
}

/** progressIn for each of `groups`, lists of sub-projects, in one pass
 * over the tasks; each result is what progressIn gives for that list. */
export function progressByGroups(groups: string[][], only?: Only) {
  const counts = groups.map(() => ({ total: 0, done: 0 }))
  for (const it of P.issuesInGroups(groups, only))
    for (const i of it.groups) {
      counts[i].total++
      if (it.issue.status === 'done') counts[i].done++
    }
  return counts.map(({ total, done }) => ({
    total,
    done,
    pct: total ? Math.round((done / total) * 100) : 0,
  }))
}

/** The summary's figures over `scoped`, the scope's tasks
 * (P.scopedIssues(info)): Completion over the leaves, In progress and In
 * review leaves, the paused leaves (a group's own pause is dormant), the
 * tasks not done and due before today, and the Overdue & at risk list, the
 * overdue ones and, in projects that track delay, those projected late,
 * by due date. */
export function overviewFigures(info: ScopeInfo, scoped: IssueVM[]) {
  const prog = progressIn(info.subIds, info.only)
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
     In My view a project I have nothing in gets no row at all. An
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
  const progress = progressByGroups(subIdLists, info.only)
  const remaining = P.remainingByGroups(subIdLists, info.only)
  return info.groups
    .map((g, gi) => {
      const issues = held[gi]
      const gp = progress[gi]
      const leadId = P.leadOf(g.proj.id)
      // the lead as the store names them, the signed-in person's own
      // profile or a face of the profile cache, which the test names
      const lead = leadId ? P.person(leadId) : null
      /* Projected verdicts (0064), gated PER ISSUE: `delayOf` returns the
       raw projection for every issue; only `delayColor` consults the
       tracking toggle, so the gate has to be asked here, and asking it
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
        lead: lead?.state === 'ok' ? lead : null,
        late: delayCount('late'),
        behind: delayCount('behind'),
        paused: issues.filter((i) => P.isPaused(i)).length,
      }
    })
    .filter((r) => !mine || r.issues.length > 0)
}

/** A health row of the oracle (healthRows). */
export type OracleHealthRow = ReturnType<typeof healthRows>[number]

/** `rows` in the order convex/lib/overview.ts readHealth documents for
 * column `key` and direction `dir`: the column's value in `dir` (a name by
 * its name key, a lead by its name's key with a row without one after
 * every lead ascending and before them descending, Progress as the
 * rounded percent, Done as done over all, Left in tenths), then the name
 * key and the project id ascending, as Convex orders values (strings by
 * their UTF-8 bytes); for the name, the key in `dir` and then the id. The
 * page's former comparator ordered names by `toLowerCase` with `<` and
 * tied by localeCompare; the server's order replaces it. */
export function healthOrder(
  rows: readonly OracleHealthRow[],
  key: HealthSort,
  dir: 'asc' | 'desc',
): OracleHealthRow[] {
  const value = (r: OracleHealthRow): Value => {
    switch (key) {
      case 'name':
        return nameKey(r.proj.name)
      case 'lead':
        return r.lead ? [0, nameKey(r.lead.name)] : [1]
      case 'progress':
        return r.pct
      case 'done':
        return r.total ? r.done / r.total : 0
      case 'left':
        return Math.round(r.remaining * 10)
      case 'late':
        return r.late
      case 'behind':
        return r.behind
      case 'paused':
        return r.paused
    }
  }
  return [...rows].sort((a, b) => {
    const d = compareValues(value(a), value(b))
    const asked = dir === 'asc' ? d : -d
    if (asked !== 0) return asked
    const byName = key === 'name' ? 0 : compareValues(nameKey(a.proj.name), nameKey(b.proj.name))
    return byName !== 0 ? byName : compareValues(a.proj.id, b.proj.id)
  })
}

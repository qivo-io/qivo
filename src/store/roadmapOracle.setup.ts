/* The Roadmap's rows, headings, tracks and dependency inputs as the app's
 * Roadmap derives them from the workspace's tasks (src/views/Roadmap.tsx,
 * src/views/MobileRoadmap.tsx), kept as the oracle
 * store/roadmapParity.test.ts compares the server's Roadmap reads with
 * (convex/lib/roadmap.ts), and which the Roadmap view stage's stand-in can
 * use. The stage that stops loading every task ends or rewrites it. The
 * test imports it after the store it boots, so it reads that store. */

import { isRoadmapTaskVisible } from '../lib/roadmapVisibility'
import { type AutoMove, autoMoves, type DepPair, dependencyPairs } from '../lib/schedule'
import { type IssueFilters, type IssueVM, P, type ScopeInfo } from './planner'

/** The Roadmap's rows of `info` in the weeks `w0` to `w1` with `filters`,
 * as the phone's agenda derives them (MobileRoadmap.tsx) and the desktop
 * buckets them (Roadmap.tsx passes), where the task with store id
 * `session`, the planning session's, skips the filters alone. */
export function roadmapRows(
  info: ScopeInfo,
  w0: number,
  w1: number,
  filters: IssueFilters,
  session?: string,
): IssueVM[] {
  return P.scopedIssues(info).filter(
    (it) =>
      isRoadmapTaskVisible(it, P.isDone(it), w0, w1) &&
      (it.id === session || P.passesFilters(it, filters)),
  )
}

/** Each sub-project's heading Remaining of `info` in whole tenths of an
 * hour, as P.remainingByGroups sums it for one sub-project, before the
 * filters, by sub-project id. */
export function remainingTenths(info: ScopeInfo): Record<string, number> {
  const sums = P.remainingByGroups(
    info.subIds.map((id) => [id]),
    info.only,
  )
  return Object.fromEntries(info.subIds.map((id, i) => [id, Math.round(sums[i] * 10)]))
}

/** The sub-projects My view's Roadmap keeps a track or band for
 * (Roadmap.tsx held), those holding a task the scope's `only` keeps,
 * before the toolbar filters and the window, by id; null outside My view. */
export function heldSubProjects(info: ScopeInfo): string[] | null {
  if (!info.only) return null
  const held = new Set<string>()
  for (const it of P.issues)
    if (info.subIdSet.has(it.project) && info.only(it)) held.add(it.project)
  return [...held].sort()
}

/** The parts of the dependency graph over every task the workspace holds
 * that hold a task of `selected` and a blocks pair. Its nodes are the tasks
 * with a span, as autoMoves takes them (schedule.ts scheduledIds), and its
 * edges the pairs between two nodes and each group's link to its subtasks
 * with a span. */
export function dependencyParts(selected: readonly IssueVM[]): {
  tasks: IssueVM[]
  pairs: DepPair[]
} {
  const nodes = new Map(P.issues.filter((it) => it.start != null).map((it) => [it.id, it]))
  const root = new Map<string, string>()
  const find = (id: string): string => {
    let at = id
    for (let up = root.get(at); up !== undefined && up !== at; up = root.get(at)) at = up
    root.set(id, at)
    return at
  }
  const join = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) root.set(ra, rb)
  }
  for (const id of nodes.keys()) root.set(id, id)
  for (const it of nodes.values()) if (it.parent && nodes.has(it.parent)) join(it.id, it.parent)
  const pairs = dependencyPairs(P.issues).filter(
    (p) => nodes.has(p.blocker) && nodes.has(p.blocked),
  )
  for (const p of pairs) join(p.blocker, p.blocked)
  const linked = new Set(pairs.map((p) => find(p.blocker)))
  const chosen = new Set(selected.filter((it) => nodes.has(it.id)).map((it) => find(it.id)))
  const tasks = [...nodes.values()].filter(
    (it) => linked.has(find(it.id)) && chosen.has(find(it.id)),
  )
  const ids = new Set(tasks.map((it) => it.id))
  return { tasks, pairs: pairs.filter((p) => ids.has(p.blocker)) }
}

/** Auto-move's moves over every task the workspace holds, with the store's
 * write access, as the Roadmap's pendingMoves (Roadmap.tsx). */
export const workspaceMoves = (): AutoMove[] =>
  autoMoves({ issues: P.issues, byId: P.issueById, canWrite: (it) => P.canWrite(it.project) })

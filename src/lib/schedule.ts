/* Auto-move only pushes tasks forward, and only leaves have dates of their
   own. A group's dates are the calculated span of its visible scheduled
   leaves: pushing a group pushes those leaves, and a leaf that moves later
   can stretch its group's calculated end without moving any sibling.
   Model m:X (X moves) and w:X (X's span reaches later) separately, with edges:
     w:blocker → m:blocked, m:group → m:child, w:child → w:group, m:X → w:X.
   A dependency on a cycle cannot be satisfied by pushing. Exclude its edge
   from correction to prevent runaway future dates; keep its conflict visible. */

import { type GroupIssue, isIssueGroup } from './issueGroups'

export type DepPair = { blocker: string; blocked: string }

/** Filter dep pairs to those the push-forward solver can satisfy.
    `kids` maps a group to its DIRECT visible children that have a span (a
    leaf's own dates or a nested group's calculated span); `scheduledIds`
    lists every task with a span. */
export function solvablePairs(
  pairs: DepPair[],
  kids: Record<string, string[]>,
  scheduledIds: string[],
): DepPair[] {
  const adj: Record<string, string[]> = {}
  const edge = (a: string, b: string) => {
    adj[a] ||= []
    adj[a].push(b)
  }
  pairs.forEach((p) => {
    edge(`w:${p.blocker}`, `m:${p.blocked}`)
  })
  Object.keys(kids).forEach((par) => {
    kids[par].forEach((k) => {
      edge(`m:${par}`, `m:${k}`)
      edge(`w:${k}`, `w:${par}`)
    })
  })
  scheduledIds.forEach((id) => {
    edge(`m:${id}`, `w:${id}`)
  })

  // Tarjan SCC over the layered nodes, seeded from the pair endpoints
  const sccOf: Record<string, number> = {}
  const cyclic = new Set<number>()
  let n = 0
  let comp = 0
  const idx: Record<string, number> = {}
  const low: Record<string, number> = {}
  const on = new Set<string>()
  const stk: string[] = []
  const strong = (v: string) => {
    idx[v] = low[v] = n++
    stk.push(v)
    on.add(v)
    ;(adj[v] || []).forEach((w) => {
      if (idx[w] == null) {
        strong(w)
        low[v] = Math.min(low[v], low[w])
      } else if (on.has(w)) low[v] = Math.min(low[v], idx[w])
    })
    if (low[v] === idx[v]) {
      comp++
      const members: string[] = []
      for (;;) {
        const w = stk.pop() as string
        on.delete(w)
        sccOf[w] = comp
        members.push(w)
        if (w === v) break
      }
      if (members.length > 1) cyclic.add(comp)
    }
  }
  pairs.forEach((p) => {
    if (idx[`w:${p.blocker}`] == null) strong(`w:${p.blocker}`)
    if (idx[`m:${p.blocked}`] == null) strong(`m:${p.blocked}`)
  })
  return pairs.filter(
    (p) =>
      !(sccOf[`w:${p.blocker}`] === sccOf[`m:${p.blocked}`] && cyclic.has(sccOf[`w:${p.blocker}`])),
  )
}

type Linked = { id: string; links?: readonly { type: string; id: string }[] }

/** Every blocks / blocked-by link as one blocker → blocked pair, in link order. */
export function dependencyPairs(issues: readonly Linked[]): DepPair[] {
  const seen = new Set<string>()
  const pairs: DepPair[] = []
  for (const it of issues) {
    for (const l of it.links || []) {
      let pair: DepPair
      if (l.type === 'blocked_by') pair = { blocker: l.id, blocked: it.id }
      else if (l.type === 'blocks') pair = { blocker: it.id, blocked: l.id }
      else continue
      const key = `${pair.blocker}>${pair.blocked}`
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push(pair)
    }
  }
  return pairs
}

/** A task as the solver reads it. A group's start and end are its calculated
    span (null when none of its visible leaves is scheduled). */
export type ScheduleTask = GroupIssue &
  Linked & {
    start: number | null
    end: number | null
  }

export type AutoMove = { id: string; start: number; end: number }

/** The date writes that start every blocked task after its blocker ends,
    cascading. Leaves are the only work units: a group's bounds are the
    earliest start and latest end of the leaves under it, and pushing a group
    shifts those leaves by the same weeks, so positions inside a family are
    kept. A pair whose push would move a leaf `canWrite` refuses is skipped
    and keeps its red conflict, so a batch never holds a read-only task. Weeks
    are unbounded, so nothing clamps the result to a viewport. */
export function autoMoves<T extends ScheduleTask>({
  issues,
  byId,
  canWrite,
}: {
  issues: readonly T[]
  byId: Readonly<Record<string, T>>
  canWrite: (task: T) => boolean
}): AutoMove[] {
  const kids: Record<string, string[]> = {}
  const work: Record<string, { start: number; end: number }> = {}
  const scheduledIds: string[] = []
  for (const it of issues) {
    if (it.start == null) continue
    scheduledIds.push(it.id)
    if (isIssueGroup(it))
      kids[it.id] = (it.children || []).filter((id) => byId[id] && byId[id].start != null)
    else work[it.id] = { start: it.start, end: Math.max(it.start, it.end ?? it.start) }
  }
  const before = Object.fromEntries(Object.entries(work).map(([id, w]) => [id, { ...w }]))
  // the pickers keep the hierarchy acyclic; `seen` is a corrupt-data backstop
  const leafCache = new Map<string, string[]>()
  const leavesOf = (id: string): string[] => {
    let leaves = leafCache.get(id)
    if (leaves) return leaves
    leaves = []
    const seen = new Set<string>()
    const stack = [id]
    while (stack.length) {
      const cur = stack.pop() as string
      if (seen.has(cur)) continue
      seen.add(cur)
      if (work[cur]) leaves.push(cur)
      else stack.push(...(kids[cur] || []))
    }
    leafCache.set(id, leaves)
    return leaves
  }
  const pairs = dependencyPairs(issues).filter(
    ({ blocker, blocked }) =>
      leavesOf(blocker).length > 0 &&
      leavesOf(blocked).length > 0 &&
      leavesOf(blocked).every((leaf) => canWrite(byId[leaf])),
  )
  const solvable = solvablePairs(pairs, kids, scheduledIds)
  const startOf = (id: string) => Math.min(...leavesOf(id).map((leaf) => work[leaf].start))
  const endOf = (id: string) => Math.max(...leavesOf(id).map((leaf) => work[leaf].end))
  const push = (id: string, weeks: number) => {
    for (const leaf of leavesOf(id)) {
      work[leaf].start += weeks
      work[leaf].end += weeks
    }
  }
  let changed = true
  let guard = 0
  while (changed && guard++ < issues.length + 5) {
    changed = false
    for (const { blocker, blocked } of solvable) {
      const need = endOf(blocker) + 1
      const cur = startOf(blocked)
      if (cur < need) {
        push(blocked, need - cur)
        changed = true
      }
    }
  }
  return Object.entries(work)
    .filter(([id, w]) => w.start !== before[id].start || w.end !== before[id].end)
    .map(([id, w]) => ({ id, start: w.start, end: w.end }))
}

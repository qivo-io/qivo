/* Auto-move only pushes tasks forward. Parent moves push scheduled children;
   child ends widen parents, but widening alone must not move sibling tasks.
   Model m:X (move) and w:X (widen) separately, with edges:
     w:blocker → m:blocked, m:parent → m:child, w:child → w:parent, m:X → w:X.
   A dependency on a cycle cannot be satisfied by pushing. Exclude its edge
   from correction to prevent runaway future dates; keep its conflict visible. */

export type DepPair = { blocker: string; blocked: string }

/** Filter dep pairs to those the push-forward solver can satisfy.
    `kids` maps a scheduled parent to its DIRECT scheduled children (an
    unscheduled link breaks the chain — matching the envelope rule);
    `scheduledIds` lists every issue with dates. */
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

import { describe, expect, it } from 'vitest'
import { autoMoves, type ScheduleTask, solvablePairs } from './schedule'

const pair = (blocker: string, blocked: string) => ({ blocker, blocked })

describe('solvablePairs (auto-move with calculated group spans)', () => {
  it('keeps plain chains, skips plain dependency cycles', () => {
    const chain = [pair('a', 'b'), pair('b', 'c')]
    expect(solvablePairs(chain, {}, ['a', 'b', 'c'])).toEqual(chain)
    const cycle = [pair('a', 'b'), pair('b', 'a')]
    expect(solvablePairs(cycle, {}, ['a', 'b'])).toEqual([])
    // the cycle members' other deps are also inside the SCC-skip only when
    // they lie on the cycle — a dep out of the cycle stays solvable
    const mixed = [pair('a', 'b'), pair('b', 'a'), pair('b', 'x')]
    expect(solvablePairs(mixed, {}, ['a', 'b', 'x'])).toEqual([pair('b', 'x')])
  })

  it('skips deps within one scheduled parent chain (both directions)', () => {
    const kids = { P: ['c'] }
    // child blocks parent: pushing P pushes c, chasing the blocker forever
    expect(solvablePairs([pair('c', 'P')], kids, ['P', 'c'])).toEqual([])
    // parent blocks child: pushing c stretches P's calculated end, same chase
    expect(solvablePairs([pair('P', 'c')], kids, ['P', 'c'])).toEqual([])
    // grandchild through a SCHEDULED middle
    const deep = { G: ['m'], m: ['g'] }
    expect(solvablePairs([pair('g', 'G')], deep, ['G', 'm', 'g'])).toEqual([])
    expect(solvablePairs([pair('G', 'g')], deep, ['G', 'm', 'g'])).toEqual([])
  })

  it('keeps opposite-direction deps between DIFFERENT children of two families', () => {
    // A{a1,a2} and B{b1,b2}: a1 blocks b1, b2 blocks a2 — satisfiable by
    // pushing b1 and a2 (their parents' spans only stretch; the dep-holding siblings
    // a1/b2 never move). The one-layer SCC over-merge used to skip both.
    const kids = { A: ['a1', 'a2'], B: ['b1', 'b2'] }
    const deps = [pair('a1', 'b1'), pair('b2', 'a2')]
    expect(solvablePairs(deps, kids, ['A', 'a1', 'a2', 'B', 'b1', 'b2'])).toEqual(deps)
  })

  it('keeps a dep chain passing through two siblings of one family', () => {
    // a blocks x, x blocks b, with a and b siblings under P: pushing x then b
    // stretches P but never moves a, so it is solvable
    const kids = { P: ['a', 'b'] }
    const deps = [pair('a', 'x'), pair('x', 'b')]
    expect(solvablePairs(deps, kids, ['P', 'a', 'b', 'x'])).toEqual(deps)
  })

  it('skips a true cross-family runaway', () => {
    // a1 blocks b1, and b1 blocks A (a1's parent): pushing b1 forces A, which
    // pushes a1, which moves a1's own end and re-forces b1, a runaway
    const kids = { A: ['a1'], B: ['b1'] }
    const deps = [pair('a1', 'b1'), pair('b1', 'A')]
    expect(solvablePairs(deps, kids, ['A', 'a1', 'B', 'b1'])).toEqual([])
  })

  it('keeps a dep into a family child from an outside blocker', () => {
    // e blocks c (child of P): pushing c stretches P, nothing feeds back to e
    const kids = { P: ['c'] }
    expect(solvablePairs([pair('e', 'c')], kids, ['P', 'c', 'e'])).toEqual([pair('e', 'c')])
  })
})

describe('autoMoves', () => {
  // A task with children is a group; its start and end are its calculated
  // span, as the store hands it over.
  const task = (
    id: string,
    start: number | null,
    end: number | null,
    extra = {},
  ): ScheduleTask => ({
    id,
    status: 'todo',
    start,
    end,
    children: [],
    links: [],
    ...extra,
  })
  const blocks = (blocker: ScheduleTask, blocked: ScheduleTask) => {
    blocker.links = [...(blocker.links || []), { type: 'blocks', id: blocked.id }]
  }
  const solve = (tasks: ScheduleTask[], readOnly: string[] = []) =>
    autoMoves({
      issues: tasks,
      byId: Object.fromEntries(tasks.map((t) => [t.id, t])),
      canWrite: (t) => !readOnly.includes(t.id),
    })

  it('cascades a plain leaf chain', () => {
    const a = task('a', 0, 3)
    const b = task('b', 2, 4)
    const c = task('c', 4, 5)
    const free = task('free', 0, 1)
    blocks(a, b)
    blocks(b, c)
    expect(solve([a, b, c, free])).toEqual([
      { id: 'b', start: 4, end: 6 },
      { id: 'c', start: 7, end: 8 },
    ])
    // already in order: nothing moves
    expect(solve([a, task('b', 4, 6), free])).toEqual([])
  })

  it('moves only the leaves of a blocked group, keeping their positions', () => {
    const blocker = task('blocker', 0, 5)
    const g = task('g', 2, 9, { children: ['g1', 'g2', 'gu'] })
    const g1 = task('g1', 2, 3)
    const g2 = task('g2', 7, 9)
    const unplanned = task('gu', null, null)
    blocks(blocker, g)
    const moves = solve([blocker, g, g1, g2, unplanned])
    expect(moves).toEqual([
      { id: 'g1', start: 6, end: 7 },
      { id: 'g2', start: 11, end: 13 },
    ])
    expect(moves.map((m) => m.id)).not.toContain('g')
  })

  it('pushes through a nested group to its leaves', () => {
    const blocker = task('blocker', 0, 4)
    const outer = task('outer', 3, 6, { children: ['inner'] })
    const inner = task('inner', 3, 6, { children: ['leaf'] })
    const leaf = task('leaf', 3, 6)
    blocks(blocker, outer)
    expect(solve([blocker, outer, inner, leaf])).toEqual([{ id: 'leaf', start: 5, end: 8 }])
  })

  it('waits for the latest leaf end of a group blocker', () => {
    // the blocker group's own row could say anything; its leaves end at week 8
    const g = task('g', 1, 8, { children: ['early', 'late'] })
    const early = task('early', 1, 2)
    const late = task('late', 5, 8)
    const blocked = task('blocked', 3, 4)
    blocks(g, blocked)
    expect(solve([g, early, late, blocked])).toEqual([{ id: 'blocked', start: 9, end: 10 }])
  })

  it('skips a pair whose push would move a read-only leaf', () => {
    const a = task('a', 0, 3)
    const b = task('b', 2, 4)
    blocks(a, b)
    expect(solve([a, b], ['b'])).toEqual([])
    // one read-only leaf under a blocked group holds back the whole group
    const g = task('g', 1, 6, { children: ['mine', 'theirs'] })
    const mine = task('mine', 1, 2)
    const theirs = task('theirs', 5, 6)
    const blocker = task('blocker', 0, 4)
    blocks(blocker, g)
    expect(solve([blocker, g, mine, theirs], ['theirs'])).toEqual([])
    expect(solve([blocker, g, mine, theirs])).toEqual([
      { id: 'mine', start: 5, end: 6 },
      { id: 'theirs', start: 9, end: 10 },
    ])
  })

  it('still moves what it may when a later link in the chain is read-only', () => {
    const a = task('a', 0, 3)
    const b = task('b', 2, 4)
    const c = task('c', 4, 5)
    blocks(a, b)
    blocks(b, c)
    expect(solve([a, b, c], ['c'])).toEqual([{ id: 'b', start: 4, end: 6 }])
  })

  it('never moves a Done or Backlog task, which still blocks others', () => {
    for (const status of ['done', 'backlog']) {
      const a = task('a', 0, 3)
      const fixed = task('fixed', 2, 4, { status })
      const after = task('after', 3, 5)
      blocks(a, fixed)
      blocks(fixed, after)
      // the fixed task keeps its dates and its conflict; what follows it moves
      expect(solve([a, fixed, after])).toEqual([{ id: 'after', start: 5, end: 7 }])
    }
    // one Done subtask holds back its blocked group
    const g = task('g', 1, 6, { children: ['open', 'finished'] })
    const open = task('open', 5, 6)
    const finished = task('finished', 1, 2, { status: 'done' })
    const blocker = task('blocker', 0, 4)
    blocks(blocker, g)
    expect(solve([blocker, g, open, finished])).toEqual([])
    // other statuses still move
    for (const status of ['todo', 'progress', 'review']) {
      const b = task('b', 2, 4, { status })
      const first = task('first', 0, 3)
      blocks(first, b)
      expect(solve([first, b])).toEqual([{ id: 'b', start: 4, end: 6 }])
    }
  })

  it('leaves a dependency between a group and its own leaf alone', () => {
    const g = task('g', 1, 4, { children: ['leaf'] })
    const leaf = task('leaf', 1, 4)
    blocks(leaf, g)
    expect(solve([g, leaf])).toEqual([])
  })
})

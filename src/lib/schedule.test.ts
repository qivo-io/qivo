import { describe, expect, it } from 'vitest'
import { solvablePairs } from './schedule'

const pair = (blocker: string, blocked: string) => ({ blocker, blocked })

describe('solvablePairs (auto-schedule under the date envelope)', () => {
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
    // parent blocks child: pushing c widens P's effective end, same chase
    expect(solvablePairs([pair('P', 'c')], kids, ['P', 'c'])).toEqual([])
    // grandchild through a SCHEDULED middle
    const deep = { G: ['m'], m: ['g'] }
    expect(solvablePairs([pair('g', 'G')], deep, ['G', 'm', 'g'])).toEqual([])
    expect(solvablePairs([pair('G', 'g')], deep, ['G', 'm', 'g'])).toEqual([])
  })

  it('an unscheduled middle breaks the chain — the dep becomes solvable', () => {
    // middle m has no dates: pushing G does not move g, so no chase
    const kids = { G: [] as string[] } // m not a scheduled child of G
    expect(solvablePairs([pair('g', 'G')], kids, ['G', 'g'])).toEqual([pair('g', 'G')])
  })

  it('keeps opposite-direction deps between DIFFERENT children of two families', () => {
    // A{a1,a2} and B{b1,b2}: a1 blocks b1, b2 blocks a2 — satisfiable by
    // pushing b1 and a2 (their parents only widen; the dep-holding siblings
    // a1/b2 never move). The one-layer SCC over-merge used to skip both.
    const kids = { A: ['a1', 'a2'], B: ['b1', 'b2'] }
    const deps = [pair('a1', 'b1'), pair('b2', 'a2')]
    expect(solvablePairs(deps, kids, ['A', 'a1', 'a2', 'B', 'b1', 'b2'])).toEqual(deps)
  })

  it('keeps a dep chain passing through two siblings of one family', () => {
    // a blocks x, x blocks b, with a and b siblings under P: pushing x then b
    // widens P but never moves a — solvable
    const kids = { P: ['a', 'b'] }
    const deps = [pair('a', 'x'), pair('x', 'b')]
    expect(solvablePairs(deps, kids, ['P', 'a', 'b', 'x'])).toEqual(deps)
  })

  it('skips a true cross-family runaway', () => {
    // a1 blocks b1, and b1 blocks A (a1's parent): pushing b1 forces A, which
    // pushes a1, which widens a1's own end and re-forces b1 — runaway
    const kids = { A: ['a1'], B: ['b1'] }
    const deps = [pair('a1', 'b1'), pair('b1', 'A')]
    expect(solvablePairs(deps, kids, ['A', 'a1', 'B', 'b1'])).toEqual([])
  })

  it('keeps a dep into a family child from an outside blocker', () => {
    // e blocks c (child of P): pushing c widens P, nothing feeds back to e
    const kids = { P: ['c'] }
    expect(solvablePairs([pair('e', 'c')], kids, ['P', 'c', 'e'])).toEqual([pair('e', 'c')])
  })
})

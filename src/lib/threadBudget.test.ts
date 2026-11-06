import { describe, expect, it } from 'vitest'
import {
  type HeldKind,
  type HeldRow,
  joinNewer,
  NEWER_PAGE,
  newerAnchor,
  type ReleaseMove,
  releaseThread,
} from './threadBudget'

/* Row `n` of kind `k` ('c' for comments, 'e' for changes) at minute `ts`,
   by default its own number. */
const row = (k: string, n: number, ts = n): HeldRow => ({ id: `${k}${n}`, ts })
/* Rows `from` to `to` (exclusive) of kind `k`, each at its own minute. */
const rows = (k: string, from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => row(k, from + i))
const ids = (list: readonly { id: string }[]) => list.map((r) => r.id)
const kind = (
  older: HeldRow[],
  live: HeldRow[],
  gap: string[] | null = null,
  newer: HeldRow[] = [],
): HeldKind => ({ older, gap, newer, live })

/* A release of comments `comments` (and changes `history`) down to
   `budget` on `moves`, keeping `keep` and passing over `pinned`. */
function release(
  comments: HeldKind,
  moves: ReleaseMove[],
  budget: number,
  {
    history = null,
    keep = [],
    pinned = [],
  }: {
    history?: HeldKind | null
    keep?: string[]
    pinned?: string[]
  } = {},
) {
  return releaseThread({
    comments,
    history,
    keep: new Set(keep),
    pinned: new Set(pinned),
    moves,
    budget,
  })
}

describe('the thread budget', () => {
  it('takes nothing while the thread holds at most the budget', () => {
    expect(release(kind(rows('c', 0, 50), rows('c', 50, 100)), ['top'], 100)).toBeNull()
    // one row over, and something goes
    expect(release(kind(rows('c', 0, 51), rows('c', 51, 101)), ['top'], 100)).not.toBeNull()
  })

  it('after an earlier page opens the gap just above the live window, then grows it up', () => {
    // 100 earlier comments, the newest 50 live, a budget of 120: the 30
    // just above the live window go, the page just added stays
    const after = release(kind(rows('c', 0, 100), rows('c', 100, 150)), ['down', 'up'], 120, {
      keep: ids(rows('c', 0, 50)),
    })
    expect(after?.comments).toMatchObject({
      older: rows('c', 0, 70),
      gap: ids(rows('c', 70, 100)),
      newer: [],
      fromTop: false,
    })
    expect(ids(after?.comments.released ?? [])).toEqual(ids(rows('c', 70, 100)))
  })

  it('after an earlier page takes the newer run from the gap down first, then the older run from its newest row', () => {
    // older run 0-59, gap of 60-99, newer run 100-129, live 130-179
    const held = kind(
      rows('c', 0, 60),
      rows('c', 130, 180),
      ids(rows('c', 60, 100)),
      rows('c', 100, 130),
    )
    const after = release(held, ['down', 'up'], 100, { keep: ids(rows('c', 0, 50)) })
    // 140 held: the 30 of the newer run go first, then 10 of the older run
    expect(after?.comments).toMatchObject({
      older: rows('c', 0, 50),
      gap: ids(rows('c', 50, 130)),
      newer: [],
    })
    // a smaller excess takes only from the newer run, from the gap down
    const less = release(held, ['down', 'up'], 130, { keep: ids(rows('c', 0, 50)) })
    expect(less?.comments).toMatchObject({
      older: rows('c', 0, 60),
      gap: ids(rows('c', 60, 110)),
      newer: rows('c', 110, 130),
    })
  })

  it('after a newer page takes the older run from its oldest row, and joins the gap to the start once it empties', () => {
    // older run 0-99, gap 100-149, live 150-199; the page just added is 50-99
    const held = kind(rows('c', 0, 100), rows('c', 150, 200), ids(rows('c', 100, 150)))
    const after = release(held, ['top'], 120, { keep: ids(rows('c', 50, 100)) })
    expect(after?.comments).toMatchObject({
      older: rows('c', 30, 100),
      gap: ids(rows('c', 100, 150)),
      fromTop: true,
    })
    // a short older run empties: the gap and its ids go, and the newer run
    // is the only one, with its start not loaded
    const short = kind(
      rows('c', 0, 20),
      rows('c', 150, 200),
      ids(rows('c', 20, 120)),
      rows('c', 120, 150),
    )
    const joined = release(short, ['top'], 70)
    expect(joined?.comments).toMatchObject({
      older: rows('c', 130, 150),
      gap: null,
      newer: [],
      fromTop: true,
    })
    expect(ids(joined?.comments.released ?? [])).toEqual([
      ...ids(rows('c', 0, 20)),
      ...ids(rows('c', 120, 130)),
    ])
  })

  it('never takes the live window or the rows it must keep', () => {
    // everything but the live window may go, and no more
    const after = release(kind(rows('c', 0, 100), rows('c', 100, 150)), ['top'], 10)
    expect(after?.comments.older).toEqual([])
    expect(ids(after?.comments.released ?? [])).toEqual(ids(rows('c', 0, 100)))
    // a kept row stops the walk there, and only the rows before it go
    const kept = release(kind(rows('c', 0, 100), rows('c', 100, 150)), ['top'], 10, {
      keep: ['c40'],
    })
    expect(kept?.comments.older).toEqual(rows('c', 40, 100))
    // the page just added stops the newer side's walk
    const page = release(kind(rows('c', 0, 100), rows('c', 100, 150)), ['down', 'up'], 60, {
      keep: ids(rows('c', 0, 50)),
    })
    expect(page?.comments).toMatchObject({ older: rows('c', 0, 50), gap: ids(rows('c', 50, 100)) })
  })

  it('passes over the comment in an editor and says it went', () => {
    const after = release(kind(rows('c', 0, 100), rows('c', 100, 150)), ['down', 'up'], 100, {
      keep: ids(rows('c', 0, 40)),
      pinned: ['c60'],
    })
    // the walk takes c50 to c99, the pinned one among them, which the store
    // holds apart
    expect(after?.comments.gap).toEqual(ids(rows('c', 50, 100)))
    expect(ids(after?.comments.released ?? [])).toContain('c60')
  })

  it('never splits an instant: three changes of one write go or stay together', () => {
    // changes 0-59 at their own minutes but 57, 58 and 59 written at once
    const write = [...rows('e', 0, 57), row('e', 57, 57), row('e', 58, 57), row('e', 59, 57)]
    const history = kind(write, rows('e', 60, 110))
    const comments = kind([], [row('c', 0, 200)])
    // two rows over: the walk up from the live page meets the write's
    // three changes and takes all three
    const after = release(comments, ['down', 'up'], 109, { history, keep: ['e0'] })
    expect(after?.history?.gap).toEqual(['e57', 'e58', 'e59'])
    // a write the walk can only take part of stays whole: e58 must stay
    const stuck = release(comments, ['down', 'up'], 109, { history, keep: ['e58'] })
    expect(stuck).toBeNull()
  })

  it('opens the gap above the changes of a write the live page starts among', () => {
    // 17 label changes a write, as a PATCH of 17 labels logs them, each
    // write at one minute, so changes 0-16 are at minute 100, 17-33 at
    // minute 101 and so on. The live page, the newest 50 of 200, starts at
    // change 150, inside the write of changes 136-152, and the comments are
    // all older
    const write = (n: number) => row('e', n, 100 + Math.floor(n / 17))
    const changes = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => write(from + i))
    const history = kind(changes(50, 150), changes(150, 200))
    const comments = kind([], rows('c', 0, 50))
    // Show earlier added changes 50-99, 34 rows over the budget. The writes
    // of 102-118 and 119-135 go whole, and 136-149 stay below the gap with
    // the rest of their write
    const after = release(comments, ['down', 'up'], 166, {
      history,
      keep: [...ids(changes(50, 100)), 'c0'],
    })
    expect(after?.history).toMatchObject({
      older: changes(50, 102),
      gap: ids(changes(102, 136)),
      newer: changes(136, 150),
    })
    expect(after?.comments.gap).toBeNull()
    // a budget the whole writes cannot meet keeps the last place that
    // splits none, over the budget, rather than nothing
    const over = release(comments, ['down', 'up'], 150, {
      history,
      keep: [...ids(changes(50, 100)), 'c0'],
    })
    expect(over?.history?.gap).toEqual(ids(changes(102, 136)))
    // the same changes at their own minutes open the gap right above the
    // live page
    const own = kind(rows('e', 50, 150), rows('e', 150, 200))
    const plain = release(comments, ['down', 'up'], 166, {
      history: own,
      keep: [...ids(rows('e', 50, 100)), 'c0'],
    })
    expect(plain?.history).toMatchObject({ gap: ids(rows('e', 116, 150)), newer: [] })
  })

  it('moves the cut past a comment and a change at one instant', () => {
    // comments 0-59 and changes 0-59, each at its own minute, both live
    // from 60; under All a press keeps the oldest rows of each kind
    const comments = kind(rows('c', 0, 60), rows('c', 60, 110))
    const history = kind(rows('e', 0, 60), rows('e', 60, 110))
    const after = release(comments, ['down', 'up'], 219, { history, keep: ['c0', 'e0'] })
    // one row over: the walk takes the comment and the change at minute 59
    // together, so neither shows beside the other's gap
    expect(after?.comments.gap).toEqual(['c59'])
    expect(after?.history?.gap).toEqual(['e59'])
  })

  it('moves the cut until every row kept above is older than every row kept below, in a thread whose times run against its order', () => {
    // a seeded thread: in thread order c0 to c9, but c5's time is minute 90
    const seeded = [...rows('c', 0, 5), row('c', 5, 90), ...rows('c', 6, 10)]
    const after = release(kind(seeded, rows('c', 100, 150)), ['down', 'up'], 58, {
      keep: ['c0'],
    })
    // taking c9 alone would leave c5 (minute 90) above rows below at
    // minute 100, which is fine, so one row goes; with a budget that
    // stops the cut right under c5, the cut moves past it
    expect(after?.comments.gap).toEqual(['c8', 'c9'])
    const past = release(
      kind(seeded, [row('c', 100, 80), ...rows('c', 101, 150)]),
      ['down', 'up'],
      58,
      {
        keep: ['c0'],
      },
    )
    // now the live window starts at minute 80, under c5's 90: every row
    // from c5 on must go before the rows above are all older
    expect(past?.comments.older).toEqual(rows('c', 0, 5))
    expect(past?.comments.gap).toEqual(ids(seeded.slice(5)))
  })

  it('takes nothing where no cut exists outside the rows it must keep', () => {
    // the live window starts at minute 3, older than every row above it,
    // and c0 must stay: no cut keeps the rows above older than the rows below
    const after = release(
      kind(rows('c', 5, 10), [row('c', 10, 3), ...rows('c', 11, 20)]),
      ['up'],
      5,
      {
        keep: ['c5'],
      },
    )
    expect(after).toBeNull()
  })

  it('opens the history gap at the comments gap, not above the live page', () => {
    // comments: older 0-39, gap 40-99, live 100-149; changes 0-149 held
    // whole, the newest 50 live. The walk down from the comments gap takes
    // the changes inside it first, from minute 40 on
    const comments = kind(rows('c', 0, 40), rows('c', 100, 150), ids(rows('c', 40, 100)))
    const history = kind(rows('e', 0, 100), rows('e', 100, 150))
    const after = release(comments, ['down', 'up'], 210, { history, keep: ['c0', 'e0'] })
    expect(after?.history).toMatchObject({
      older: rows('e', 0, 40),
      gap: ids(rows('e', 40, 70)),
      newer: rows('e', 70, 100),
    })
    expect(after?.comments.gap).toEqual(ids(rows('c', 40, 100)))
  })

  it('reads a released span back from the 50th id, or from the first row below a shorter gap', () => {
    const gap = ids(rows('c', 100, 180))
    expect(newerAnchor(gap, 'c180')).toBe('c149')
    expect(newerAnchor(gap.slice(0, NEWER_PAGE), 'c150')).toBe('c149')
    expect(newerAnchor(gap.slice(0, NEWER_PAGE - 1), 'c149')).toBe('c149')
    expect(newerAnchor([], 'c100')).toBe('c100')
  })

  it('joins a page that holds a row of the run above, the rows after it and a deleted id included', () => {
    const older = rows('c', 0, 100)
    const gap = ids(rows('c', 100, 180))
    // the page before c149: c99 and c100 to c148, but c120 was deleted
    const page = [row('c', 98), row('c', 99), ...rows('c', 100, 149).filter((r) => r.id !== 'c120')]
    const joined = joinNewer(older, gap, 'c149', page, false, false)
    expect(joined).toMatchObject({ kind: 'join', gap: ids(rows('c', 149, 180)) })
    if (joined.kind !== 'join') return
    expect(ids(joined.added)).toEqual(ids(page.slice(2)))
    expect(ids(joined.older)).toEqual([...ids(older), ...ids(page.slice(2))])
    // a page before the first row below closes the gap
    const closing = joinNewer(
      older,
      ['c100', 'c101'],
      'c102',
      [row('c', 99), row('c', 100), row('c', 101)],
      false,
      false,
    )
    expect(closing).toMatchObject({ kind: 'join', gap: null })
    // the run's rows after the newest one the page holds were deleted
    const lost = joinNewer(older, gap, 'c149', [row('c', 97), ...rows('c', 100, 149)], false, false)
    expect(lost.kind === 'join' && ids(lost.older).slice(96, 99)).toEqual(['c96', 'c97', 'c100'])
  })

  it('reads on from a page that holds no row of the run, and starts the history over from one it cannot prove', () => {
    const older = rows('e', 0, 100)
    const gap = ids(rows('e', 100, 180))
    // a page of released rows only, stopped short: read on before it
    expect(joinNewer(older, gap, 'e149', rows('e', 120, 149), false, true)).toEqual({
      kind: 'short',
    })
    // a history page with a row the store never had, and none of the run
    expect(
      joinNewer(older, gap, 'e149', [row('x', 1), ...rows('e', 120, 149)], false, true),
    ).toEqual({
      kind: 'restart',
    })
    // the same page of comments reads on
    expect(
      joinNewer(older, gap, 'e149', [row('x', 1), ...rows('e', 120, 149)], false, false),
    ).toEqual({
      kind: 'short',
    })
    // a page that starts the thread and holds no row of the run replaces it
    const start = joinNewer(older, gap, 'e149', rows('e', 120, 149), true, true)
    expect(start).toMatchObject({ kind: 'join', older: rows('e', 120, 149) })
  })
})

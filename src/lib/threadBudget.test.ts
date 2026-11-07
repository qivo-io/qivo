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

  it('holds apart a row inside a run that shares its instant with a live row of the other kind, so the release passes it', () => {
    // Under All, a task archived with a reason. The archive's change and its
    // reason comment share minute 160. More than 50 comments followed, so
    // the reason comment c160 sits inside the run above the live window
    // c170 to c219, while the archive's change is on the live page
    const live = [
      row('e', 0, 160),
      ...Array.from({ length: 19 }, (_, i) => row('e', i + 1, 300 + i)),
    ]
    const history = kind([], live)
    // Show earlier comments loaded c120 to c169, then c70 to c119
    const first = release(kind(rows('c', 70, 170), rows('c', 170, 220)), ['down', 'up'], 150, {
      history,
      keep: ['c120', ...ids(rows('c', 70, 120)), 'e0'],
    })
    // the gap opens just above the live window, and the walk up passes
    // c160, which goes into the gap's ids but is held apart and counted, so
    // 20 rows go for good and the store is at its budget
    expect(first?.comments).toMatchObject({
      older: rows('c', 70, 149),
      gap: ids(rows('c', 149, 170)),
      newer: [],
      apart: [row('c', 160)],
    })
    // the next press, c20 to c69, lets 50 rows go above the gap, its budget
    // one less for the row held apart
    const before = first?.comments
    if (!before) throw new Error('the first press let nothing go')
    const second = release(
      kind([...rows('c', 20, 70), ...before.older], rows('c', 170, 220), before.gap, before.newer),
      ['down', 'up'],
      149,
      { history, keep: ['c70', ...ids(rows('c', 20, 70))] },
    )
    expect(second?.comments).toMatchObject({
      older: rows('c', 20, 99),
      gap: ids(rows('c', 99, 170)),
      apart: [],
    })
    // and the mirror, with the reason comment live and the archive's change inside
    // the history's run, walked back with Show earlier activity
    const comments = kind(
      [],
      [row('c', 0, 160), ...Array.from({ length: 29 }, (_, i) => row('c', i + 1, 400 + i))],
    )
    const changes = release(comments, ['down', 'up'], 150, {
      history: kind(rows('e', 70, 170), rows('e', 170, 220)),
      keep: ['e120', ...ids(rows('e', 70, 120)), 'c0'],
    })
    expect(changes?.history).toMatchObject({
      older: rows('e', 70, 139),
      gap: ids(rows('e', 139, 170)),
      apart: [row('e', 160)],
    })
    // walking down from a gap passes such a row the same way: c105, which
    // slid below the gap, shares minute 105 with a live change
    const down = release(
      kind(rows('c', 0, 50), rows('c', 120, 170), ids(rows('c', 50, 100)), rows('c', 100, 120)),
      ['down', 'up'],
      130,
      {
        history: kind([], [row('e', 0, 105), ...rows('e', 1, 20).map((r) => ({ ...r, ts: 300 }))]),
      },
    )
    expect(down?.comments).toMatchObject({ newer: rows('c', 111, 120), apart: [row('c', 105)] })
    // a walk that can only hold rows apart lets nothing go: c160 is the
    // newest above the gap and c159 is on a reader's screen
    const stuck = release(
      kind(rows('c', 150, 161), rows('c', 170, 220), ids(rows('c', 161, 170))),
      ['up'],
      70,
      { history, keep: ['c159'] },
    )
    expect(stuck).toBeNull()
  })

  /* A thread of `count` comments at their own minutes, the newest 50 live,
     under All with a history whose live page holds the change at minute
     `twin`, the archive the reason comment c`twin` was posted with, and 19
     changes after every comment. The store, as the release sees it: the
     runs and gap of each kind, and the rows it holds apart, which count in
     the budget and stay while the change is live. */
  function archivedThread(count: number, twin: number) {
    const history = kind(
      [],
      [row('e', 0, twin), ...Array.from({ length: 19 }, (_, i) => row('e', i + 1, 5000 + i))],
    )
    let comments = kind([], rows('c', count - 50, count))
    let apart: HeldRow[] = []
    const all = rows('c', 0, count)
    const held = () =>
      comments.older.length +
      comments.newer.length +
      comments.live.length +
      history.live.length +
      apart.length
    /* Applies a release on `moves`, keeping `keep`, as keepThread does. */
    function settle(moves: ReleaseMove[], keep: string[]) {
      if (held() <= 150) return
      const after = release(comments, moves, 150 - apart.length, { history, keep })
      if (!after) return
      const { older, gap, newer } = after.comments
      comments = { ...comments, older, gap, newer }
      apart = [...apart, ...after.comments.apart]
    }
    return {
      held,
      apart: () => ids(apart),
      gap: () => comments.gap ?? [],
      /* Show earlier comments: the page before the oldest held comment,
         kept with the row it was read before. */
      earlier() {
        const oldest = comments.older[0] ?? comments.newer[0] ?? comments.live[0]
        const at = all.findIndex((r) => r.id === oldest.id)
        const page = all.slice(Math.max(0, at - 50), at)
        comments = { ...comments, older: [...page, ...comments.older] }
        settle(['down', 'up'], [oldest.id, ...ids(page)])
      },
      /* A comment arrives with the reader at the newest end: the oldest
         live one slides into the run just above the live window. */
      arrive() {
        const [slid, ...rest] = comments.live
        const live = [...rest, row('c', Number(slid.id.slice(1)) + 50)]
        comments =
          comments.gap === null
            ? { ...comments, older: [...comments.older, slid], live }
            : { ...comments, newer: [...comments.newer, slid], live }
        settle(['top'], [])
      },
    }
  }

  it('keeps letting rows go on every Show earlier press past a row held apart that loaded above an existing gap', () => {
    // 400 comments, the newest 50 live; the reason comment c200 loads with
    // the third press, after the gap opened above the live window
    const thread = archivedThread(400, 200)
    for (let press = 1; press <= 4; press++) {
      thread.earlier()
      expect(thread.held()).toBeLessThanOrEqual(150)
    }
    expect(thread.apart()).toEqual([])
    // the next three presses walk the gap up past c200
    for (let press = 5; press <= 7; press++) {
      thread.earlier()
      expect(thread.held()).toBe(150)
    }
    expect(thread.apart()).toEqual(['c200'])
    expect(thread.gap()).toContain('c200')
  })

  it('keeps letting rows go as comments arrive once a row held apart is the oldest held', () => {
    // 100 comments, the newest 50 live with the reason comment c90 among
    // them. Arrivals slide it into the run, and the oldest rows go until
    // it is the oldest held comment
    const thread = archivedThread(100, 90)
    for (let n = 1; n <= 150; n++) {
      thread.arrive()
      expect(thread.held()).toBeLessThanOrEqual(150)
    }
    expect(thread.held()).toBe(150)
    expect(thread.apart()).toEqual(['c90'])
  })

  it('stops a move before an instant it cannot take whole, so the next move still runs', () => {
    // The comments hold an older run of 0-59, a gap of 60-69, a newer run of
    // 70-79 and live rows from 80. The change at minute 70 is on a reader's screen and must stay, so
    // `down` cannot take c70 without splitting that instant
    const comments = kind(
      rows('c', 0, 60),
      rows('c', 80, 130),
      ids(rows('c', 60, 70)),
      rows('c', 70, 80),
    )
    const history = kind([row('e', 1, 5), row('e', 2, 70), row('e', 3, 75)], [row('e', 4, 200)])
    const after = release(comments, ['down', 'up'], 104, { history, keep: ['c0', 'e2'] })
    // `down` stops before c70, and `up` lets the 20 newest rows above go
    expect(after?.comments).toMatchObject({
      older: rows('c', 0, 40),
      gap: ids(rows('c', 40, 70)),
      newer: rows('c', 70, 80),
    })
    expect(after?.history?.gap).toBeNull()
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

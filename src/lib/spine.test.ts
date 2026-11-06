import { describe, expect, it } from 'vitest'
import {
  type GapSide,
  itemUnreadStart,
  mergeSpine,
  newerRow,
  spineGap,
  spineWindow,
  splitSpine,
  unreadMark,
} from './spine'

const c = (id: string, ts: number) => ({ id, ts, body: id })
const e = (id: string, ts: number) => ({ id, ts, verb: 'moved' })

describe('mergeSpine', () => {
  it('interleaves comments and events oldest first', () => {
    const s = mergeSpine([c('c1', 300), c('c2', 100)], [e('e1', 200)])
    expect(s.map((x) => x.id)).toEqual(['c2', 'e1', 'c1'])
    expect(s.map((x) => x.kind)).toEqual(['c', 'e', 'c'])
  })

  it('carries the source row through under c / e', () => {
    const row = c('c1', 1)
    const s = mergeSpine([row], [e('e1', 2)])
    expect(s[0].c).toBe(row)
    expect(s[0].e).toBeUndefined()
    expect(s[1].e).toBeDefined()
  })

  it('breaks a tie of comments by id, ascending, so a refetch cannot swap two rows', () => {
    expect(mergeSpine([c('c9', 500), c('c1', 500)], []).map((x) => x.id)).toEqual(['c1', 'c9'])
  })

  it('puts the changes of one instant before its comments, in the order they were written', () => {
    // whatever the ids: a change's id sorting after the comment's changes nothing
    expect(mergeSpine([c('c5', 500)], [e('a1', 500)]).map((x) => x.id)).toEqual(['a1', 'c5'])
    expect(mergeSpine([c('c5', 500)], [e('z1', 500)]).map((x) => x.id)).toEqual(['z1', 'c5'])
    // three changes of one write keep the store's insertion order, not their ids'
    const write = [e('e3', 500), e('e1', 500), e('e2', 500)]
    expect(mergeSpine([c('c1', 400), c('c2', 500)], write).map((x) => x.id)).toEqual([
      'c1',
      'e3',
      'e1',
      'e2',
      'c2',
    ])
  })

  it('handles empty inputs', () => {
    expect(mergeSpine([], [])).toEqual([])
    expect(mergeSpine([c('c1', 1)], []).map((x) => x.id)).toEqual(['c1'])
    expect(mergeSpine([], [e('e1', 1)]).map((x) => x.id)).toEqual(['e1'])
  })

  it('leaves the caller’s arrays alone', () => {
    const comments = [c('c2', 200), c('c1', 100)]
    mergeSpine(comments, [])
    expect(comments.map((x) => x.id)).toEqual(['c2', 'c1'])
  })
})

describe('unreadMark', () => {
  const feed = [{ ts: 100 }, { ts: 200 }, { ts: 300 }]

  it('draws nothing when there is nothing unread', () => {
    expect(unreadMark(feed, null)).toEqual({ place: 'none', index: -1 })
  })

  it('marks above the first item at or after the timestamp', () => {
    expect(unreadMark(feed, 150)).toEqual({ place: 'mark', index: 1 })
    expect(unreadMark(feed, 50)).toEqual({ place: 'mark', index: 0 })
  })

  it('marks ABOVE an item sharing the timestamp — a comment and its message are one transaction', () => {
    expect(unreadMark(feed, 200)).toEqual({ place: 'mark', index: 1 })
    expect(unreadMark(feed, 300)).toEqual({ place: 'mark', index: 2 })
  })

  it('falls back to tail when nothing rendered is at or after the mark', () => {
    // a status change with the Comments filter on, or a since-deleted comment
    expect(unreadMark(feed, 400)).toEqual({ place: 'tail', index: -1 })
    expect(unreadMark([], 400)).toEqual({ place: 'tail', index: -1 })
  })

  it('says none, not tail, for an empty feed with nothing unread', () => {
    expect(unreadMark([], null)).toEqual({ place: 'none', index: -1 })
  })
})

describe('spineWindow', () => {
  const side = (rows: { ts: number }[], whole: boolean) => ({ rows, whole })
  const comments = [c('c1', 300), c('c2', 600)]
  const events = [e('e1', 100), e('e2', 300), e('e3', 500)]

  it('shows everything once both the thread and the history are whole', () => {
    expect(spineWindow(side(comments, true), side(events, true))).toEqual({
      start: Number.NEGATIVE_INFINITY,
      load: { comments: false, events: false },
    })
  })

  it('hides changes older than the oldest loaded comment while earlier comments remain', () => {
    expect(spineWindow(side(comments, false), side(events, true))).toEqual({
      start: 300,
      load: { comments: true, events: false },
    })
  })

  it('hides comments older than the oldest loaded change while earlier history remains', () => {
    const recent = [e('e4', 450), e('e5', 700)]
    expect(spineWindow(side(comments, true), side(recent, false))).toEqual({
      start: 450,
      load: { comments: false, events: true },
    })
  })

  it('starts at the later side, and loads both when they meet at one instant', () => {
    expect(spineWindow(side(comments, false), side([e('e9', 200)], false)).load).toEqual({
      comments: true,
      events: false,
    })
    expect(spineWindow(side(comments, false), side([e('e9', 300)], false)).load).toEqual({
      comments: true,
      events: true,
    })
  })

  it('hides everything while a side with earlier rows has none loaded', () => {
    expect(spineWindow(side([], false), side(events, true))).toEqual({
      start: Number.POSITIVE_INFINITY,
      load: { comments: true, events: false },
    })
  })
})

describe('itemUnreadStart', () => {
  const AT = '2026-09-14T08:05:00.000Z'

  it('starts nowhere for no item and for an item with nothing unread', () => {
    expect(itemUnreadStart(null)).toEqual({ ts: null, change: false })
    expect(itemUnreadStart({ first_unread_at: null, unread_change: false })).toEqual({
      ts: null,
      change: false,
    })
    // the server answers no change for a read item, and none is taken
    expect(itemUnreadStart({ first_unread_at: null, unread_change: true })).toEqual({
      ts: null,
      change: false,
    })
  })

  it("starts at the oldest unread message's created_at, with the server's change", () => {
    expect(itemUnreadStart({ first_unread_at: AT, unread_change: false })).toEqual({
      ts: Date.parse(AT),
      change: false,
    })
    expect(itemUnreadStart({ first_unread_at: AT, unread_change: true })).toEqual({
      ts: Date.parse(AT),
      change: true,
    })
  })

  it('marks above a comment that shares its created_at, and the tail after every row', () => {
    const { ts } = itemUnreadStart({ first_unread_at: AT, unread_change: false })
    const rows = [{ ts: Date.parse(AT) - 1 }, { ts: Date.parse(AT) }, { ts: Date.parse(AT) + 1 }]
    expect(unreadMark(rows, ts)).toEqual({ place: 'mark', index: 1 })
    expect(unreadMark(rows.slice(0, 1), ts)).toEqual({ place: 'tail', index: -1 })
  })
})

describe('spineGap and splitSpine', () => {
  const side = (end: number, below: number, above: string[]): GapSide => ({
    end,
    below,
    above: new Set(above),
  })
  const ids = (items: readonly { id: string }[]) => items.map((x) => x.id)

  it('places the newer row between the rows kept above and below a comment gap', () => {
    const comments = side(300, 700, ['c1', 'c3'])
    const gap = spineGap(comments, null)
    expect(gap).toEqual({ end: 300, below: 700, load: { comments: true, events: false } })
    const spine = mergeSpine([c('c1', 100), c('c3', 300), c('c7', 700), c('c8', 800)], [])
    const parts = splitSpine(spine, gap, { comments, events: null })
    expect(ids(parts.above)).toEqual(['c1', 'c3'])
    expect(ids(parts.below)).toEqual(['c7', 'c8'])
    // no gap: every row above, nothing below
    expect(spineGap(null, null)).toBeNull()
    expect(ids(splitSpine(spine, null, { comments: null, events: null }).above)).toHaveLength(4)
  })

  it('hides the rows strictly between the two kinds’ gaps and keeps those at both instants', () => {
    // comments kept to 300 and from 700; changes kept to 400 and from 600
    const comments = side(300, 700, ['c1', 'c3'])
    const events = side(400, 600, ['e1', 'e3', 'e4'])
    const gap = spineGap(comments, events)
    // the earliest end and the latest below, and only the comments load
    expect(gap).toEqual({ end: 300, below: 700, load: { comments: true, events: false } })
    const spine = mergeSpine(
      [c('c1', 100), c('c3', 300), c('c7', 700), c('c8', 800)],
      [e('e1', 100), e('e3', 300), e('e4', 400), e('e6', 600), e('e7', 700)],
    )
    const parts = splitSpine(spine, gap, { comments, events })
    // e4 and e6 sit beside the comments' gap: held, but hidden
    expect(ids(parts.above)).toEqual(['e1', 'c1', 'e3', 'c3'])
    expect(ids(parts.below)).toEqual(['e7', 'c7', 'c8'])
    // a gap in one kind hides the other kind's rows inside it
    const lone = spineGap(comments, null)
    const only = splitSpine(spine, lone, { comments, events: null })
    expect(ids(only.above)).toEqual(['e1', 'c1', 'e3', 'c3'])
    expect(ids(only.below)).toEqual(['e7', 'c7', 'c8'])
    // and both kinds at the gap's start load when their ends meet
    expect(spineGap(side(300, 700, []), side(300, 600, []))?.load).toEqual({
      comments: true,
      events: true,
    })
  })

  it('keeps the comment in this window’s editor whatever the gap hides', () => {
    const comments = side(300, 700, ['c1', 'c3'])
    const spine = mergeSpine([c('c1', 100), c('c3', 300), c('c5', 500), c('c7', 700)], [])
    const gap = spineGap(comments, null)
    expect(ids(splitSpine(spine, gap, { comments, events: null }).above)).toEqual(['c1', 'c3'])
    expect(ids(splitSpine(spine, gap, { comments, events: null }, 'c5').above)).toEqual([
      'c1',
      'c3',
      'c5',
    ])
  })

  it('splits by run when a seeded thread’s times run past the rows below', () => {
    // c4 is above the gap by thread order, but its time is after c7's
    const comments = side(900, 700, ['c1', 'c4'])
    const spine = mergeSpine([c('c1', 100), c('c4', 900), c('c7', 700), c('c8', 800)], [])
    const parts = splitSpine(spine, spineGap(comments, null), { comments, events: null })
    expect(ids(parts.above)).toEqual(['c1', 'c4'])
    expect(ids(parts.below)).toEqual(['c7', 'c8'])
  })

  it('places the New line under the newer row, above the first row after the gap', () => {
    const comments = side(300, 700, ['c1', 'c3'])
    const spine = mergeSpine([c('c1', 100), c('c3', 300), c('c7', 700), c('c8', 800)], [])
    const parts = splitSpine(spine, spineGap(comments, null), { comments, events: null })
    const shown = [...parts.above, ...parts.below]
    // the unread part starts among released rows, at 500
    expect(unreadMark(shown, 500)).toEqual({ place: 'mark', index: parts.above.length })
  })

  it('shows no newer row for a gap wholly above where All starts', () => {
    // the history's start is not loaded and its oldest change is at 800
    const from = spineWindow(
      { rows: [{ ts: 100 }, { ts: 300 }, { ts: 700 }], whole: false },
      { rows: [{ ts: 800 }], whole: false },
    )
    const gap = spineGap(side(300, 700, []), null)
    expect(newerRow(gap, from.start, ['more', 'none'])).toBe('none')
    // a gap whose first row below is where All starts is above it too
    expect(newerRow(gap, 700, ['more', 'none'])).toBe('none')
    // with the history's oldest change at 600, the rows below the gap show
    const later = spineWindow(
      { rows: [{ ts: 100 }, { ts: 300 }, { ts: 700 }], whole: false },
      { rows: [{ ts: 600 }], whole: false },
    )
    expect(newerRow(gap, later.start, ['more', 'none'])).toBe('more')
    // under Comments nothing is above where the spine starts
    expect(newerRow(gap, Number.NEGATIVE_INFINITY, ['more'])).toBe('more')
  })

  it('says what the newer row shows, loading before failed before more', () => {
    const gap = spineGap(side(300, 700, []), null)
    expect(newerRow(null, Number.NEGATIVE_INFINITY, ['more'])).toBe('none')
    expect(newerRow(gap, Number.NEGATIVE_INFINITY, ['none', 'none'])).toBe('none')
    expect(newerRow(gap, Number.NEGATIVE_INFINITY, ['failed', 'loading'])).toBe('loading')
    expect(newerRow(gap, Number.NEGATIVE_INFINITY, ['more', 'failed'])).toBe('failed')
    expect(newerRow(gap, Number.NEGATIVE_INFINITY, ['none', 'more'])).toBe('more')
  })
})

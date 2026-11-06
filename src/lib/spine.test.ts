import { describe, expect, it } from 'vitest'
import { itemUnreadStart, mergeSpine, spineWindow, unreadMark } from './spine'

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

  it('breaks a timestamp tie by id, ascending — so a refetch cannot swap two rows', () => {
    expect(mergeSpine([c('c9', 500), c('c1', 500)], []).map((x) => x.id)).toEqual(['c1', 'c9'])
    expect(mergeSpine([c('c5', 500)], [e('a1', 500)]).map((x) => x.id)).toEqual(['a1', 'c5'])
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

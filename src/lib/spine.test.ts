import { describe, expect, it } from 'vitest'
import { firstUnreadTs, mergeSpine, unreadMark } from './spine'

const c = (id: string, ts: number) => ({ id, ts, body: id })
const e = (id: string, ts: number) => ({ id, ts, verb: 'moved' })
const msg = (issueUuid: string, ts: number, read: boolean) => ({ issueUuid, ts, read })

const A = 'aaaaaaaa-0000-0000-0000-000000000000'
const B = 'bbbbbbbb-0000-0000-0000-000000000000'

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

describe('firstUnreadTs', () => {
  it('is null when nothing is unread', () => {
    expect(firstUnreadTs([msg(A, 100, true), msg(A, 200, true)], A)).toBe(null)
    expect(firstUnreadTs([], A)).toBe(null)
  })

  it('returns the OLDEST unread, not the first one in the list', () => {
    // P.messages arrives newest-first — a .find() here would answer 300
    expect(firstUnreadTs([msg(A, 300, false), msg(A, 200, false), msg(A, 100, true)], A)).toBe(200)
  })

  it('ignores unread messages about another task', () => {
    expect(firstUnreadTs([msg(B, 100, false), msg(A, 400, false)], A)).toBe(400)
    expect(firstUnreadTs([msg(B, 100, false)], A)).toBe(null)
  })

  it('is null without an issue', () => {
    expect(firstUnreadTs([msg(A, 100, false)], null)).toBe(null)
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

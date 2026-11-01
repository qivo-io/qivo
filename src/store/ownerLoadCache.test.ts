import { describe, expect, it } from 'vitest'
import type { OwnerLoadsJson } from '../../convex/planning'
import { isoToWeek, setWeekConfig } from '../lib/dates'
import type { LiveTransition } from '../lib/liveQueries'
import type { Visibility } from '../lib/viewVisibility'
import { CALL_OWNERS, createOwnerLoadCache, GUEST_CALLS, staffCalls } from './ownerLoadCache'

/* The owner-load cache (store/ownerLoadCache.ts) over a stand-in transport:
   which planning.ownerLoads calls it holds for what the views need, and what
   it says of each owner. */

type Sub = { args: { org_id: string; owner_ids: string[] }; value?: unknown; error?: unknown }

/** A transport whose calls the test answers, and a page whose visibility
    the test sets. */
function setup(staff = true) {
  const subs = new Map<string, Sub>()
  const handlers = new Set<(t: LiveTransition) => void>()
  const visibility = new Set<(v: Visibility) => void>()
  let next = 0
  let changes = 0
  const cache = createOwnerLoadCache({
    live: {
      watch: (_ref, args) => {
        const token = `t${++next}`
        subs.set(token, { args: args as Sub['args'] })
        return { token, joined: false, stop: () => subs.delete(token) }
      },
      read: (token) => {
        const sub = subs.get(token)
        if (sub?.error) throw sub.error
        return sub?.value
      },
      onTransition: (fn) => {
        handlers.add(fn)
        return () => handlers.delete(fn)
      },
    },
    staffIn: () => staff,
    changed: () => changes++,
    watchVisibility: (listener) => {
      visibility.add(listener)
      listener({ visible: true, shownAt: 0 })
      return () => visibility.delete(listener)
    },
  })
  const tell = (token: string) => {
    for (const fn of handlers) fn({ tokens: new Set([token]), at: 0, connection: 1 })
  }
  return {
    cache,
    changes: () => changes,
    calls: () => [...subs].map(([token, sub]) => ({ token, owners: sub.args.owner_ids })),
    /** Answers call `token` with `answer`. */
    answer(token: string, answer: OwnerLoadsJson) {
      const sub = subs.get(token)
      if (!sub) throw new Error(`no call ${token}`)
      sub.value = answer
      tell(token)
    },
    fail(token: string) {
      const sub = subs.get(token)
      if (!sub) throw new Error(`no call ${token}`)
      sub.error = new Error('failed')
      tell(token)
    },
    show(visible: boolean) {
      for (const listener of visibility) listener({ visible, shownAt: 0 })
    },
  }
}

const needs = (n: number, cards = (i: number) => i + 1) =>
  Array.from({ length: n }, (_, i) => ({ org: 'org', owner: `p${i}`, cards: cards(i) }))

const span = (issue: string | null, hours = 4) => ({
  issue_id: issue,
  start_week: '2026-09-07',
  end_week: '2026-09-14',
  remaining: hours,
  remaining_set_at: null,
})

describe('the owner-load cache', () => {
  it('asks for a staff seat in calls of at most CALL_OWNERS owners, each owner once, by hash', () => {
    const s = setup(true)
    s.cache.register('board', needs(60))
    const calls = s.calls()
    expect(calls.every((c) => c.owners.length <= CALL_OWNERS)).toBe(true)
    const asked = calls.flatMap((c) => c.owners).sort()
    expect(asked).toEqual(
      needs(60)
        .map((n) => n.owner)
        .sort(),
    )
    // one more owner changes one call, and every other call stays
    const before = new Set(calls.map((c) => c.token))
    s.cache.register('board', needs(61))
    const after = s.calls()
    expect(after.filter((c) => !before.has(c.token))).toHaveLength(1)
    expect(after.filter((c) => before.has(c.token))).toHaveLength(calls.length - 1)
    // and the same owners make the same calls whatever order they come in
    expect(staffCalls('org', ['a', 'b', 'c'])).toEqual(staffCalls('org', ['c', 'a', 'b']))
  })

  it('asks for a guest or Viewer one owner a call, at most GUEST_CALLS, most cards first', () => {
    const s = setup(false)
    // owner i has i + 1 cards, so the first ten have the fewest
    s.cache.register('board', needs(GUEST_CALLS + 10))
    const calls = s.calls()
    expect(calls).toHaveLength(GUEST_CALLS)
    expect(calls.every((c) => c.owners.length === 1)).toBe(true)
    for (let i = 0; i < 10; i++) expect(s.cache.loadOf('org', `p${i}`)).toEqual({ state: 'capped' })
    expect(s.cache.loadOf('org', 'p59')).toEqual({ state: 'waiting' })
    // a capped owner is never a load (src/store/viewDelay.ts reads it as unknown)
    expect(s.cache.loadOf('org', 'p0').state).not.toBe('ok')
  })

  it('says waiting until the first answer, then each owner as answered, its spans as weeks', () => {
    const s = setup(true)
    s.cache.register('board', needs(3))
    expect(s.cache.loadOf('org', 'p1')).toEqual({ state: 'waiting' })
    const [call] = s.calls()
    if (!call) throw new Error('no call')
    s.answer(call.token, {
      hidden: 'counted',
      owners: [
        // the server answers ids in lowercase, in the order asked
        { owner_id: 'p0', state: 'ok', spans: [span('task-1'), span(null, 2)] },
        { owner_id: 'p1', state: 'unavailable' },
        { owner_id: 'p2', state: 'ok', spans: [] },
      ],
    })
    expect(s.cache.loadOf('org', 'p0')).toEqual({
      state: 'ok',
      hidden: 'counted',
      spans: [
        {
          issueUuid: 'task-1',
          start: isoToWeek('2026-09-07'),
          end: isoToWeek('2026-09-14'),
          remaining: 4,
          remainingSet: null,
        },
        {
          issueUuid: null,
          start: isoToWeek('2026-09-07'),
          end: isoToWeek('2026-09-14'),
          remaining: 2,
          remainingSet: null,
        },
      ],
    })
    expect(s.cache.loadOf('org', 'p1')).toEqual({ state: 'unavailable' })
    expect(s.changes()).toBeGreaterThan(0)
  })

  it('reads its kept spans on the week grid of now, the same object while it holds', () => {
    const s = setup(true)
    s.cache.register('board', needs(1))
    const [call] = s.calls()
    if (!call) throw new Error('no call')
    s.answer(call.token, {
      hidden: 'counted',
      owners: [{ owner_id: 'p0', state: 'ok', spans: [span('task-1')] }],
    })
    const startOf = (load: ReturnType<typeof s.cache.loadOf>) =>
      load.state === 'ok' ? load.spans[0]?.start : undefined
    const before = s.cache.loadOf('org', 'p0')
    expect(s.cache.loadOf('org', 'p0')).toBe(before)
    expect(startOf(before)).toBe(isoToWeek('2026-09-07'))
    // a week later the grid's anchor moved one week on (src/lib/dates.ts)
    const later = new Date()
    later.setDate(later.getDate() + 7)
    try {
      setWeekConfig(null, null, later)
      const after = s.cache.loadOf('org', 'p0')
      expect(after).not.toBe(before)
      expect(startOf(after)).toBe(isoToWeek('2026-09-07'))
      expect(startOf(after)).toBe((startOf(before) ?? 0) - 1)
    } finally {
      setWeekConfig(null, null, new Date())
    }
  })

  it('asks again for the owners a call answered not_read, and says failed when a call fails', () => {
    const s = setup(true)
    s.cache.register('board', needs(3))
    const [call] = s.calls()
    if (!call) throw new Error('no call')
    s.answer(call.token, {
      hidden: 'counted',
      owners: [
        { owner_id: 'p0', state: 'ok', spans: [] },
        { owner_id: 'p1', state: 'not_read' },
        { owner_id: 'p2', state: 'not_read' },
      ],
    })
    // not_read is no answer: still waiting, and asked again in a call of its own
    expect(s.cache.loadOf('org', 'p1')).toEqual({ state: 'waiting' })
    const again = s.calls().find((c) => c.token !== call.token)
    expect(again?.owners).toEqual(['p1', 'p2'])
    if (!again) throw new Error('not asked again')
    s.fail(again.token)
    expect(s.cache.loadOf('org', 'p1')).toEqual({ state: 'failed' })
    expect(s.cache.loadOf('org', 'p0').state).toBe('ok')
  })

  it('holds no call while the page is hidden or the view does not read, and keeps the answers', () => {
    const s = setup(true)
    s.cache.register('board', needs(2))
    const [call] = s.calls()
    if (!call) throw new Error('no call')
    s.answer(call.token, {
      hidden: 'counted',
      owners: [
        { owner_id: 'p0', state: 'ok', spans: [span('a')] },
        { owner_id: 'p1', state: 'ok', spans: [] },
      ],
    })
    s.show(false)
    expect(s.calls()).toEqual([])
    expect(s.cache.loadOf('org', 'p0').state).toBe('ok')
    s.show(true)
    expect(s.calls()).toHaveLength(1)
    // kept until the fresh answer, which the views mark as refreshing
    expect(s.cache.loadOf('org', 'p0').state).toBe('ok')
    // a kept page that hides stops reading too, and keeps its owners
    s.cache.setLive('board', false)
    expect(s.calls()).toEqual([])
    expect(s.cache.loadOf('org', 'p0').state).toBe('ok')
    // a view that closes forgets them
    s.cache.release('board')
    expect(s.cache.loadOf('org', 'p0')).toEqual({ state: 'waiting' })
  })

  it('shares an owner two views need, and stops a call only once neither needs it', () => {
    const s = setup(true)
    s.cache.register('desktop', [{ org: 'org', owner: 'p0', cards: 1 }])
    s.cache.register('phone', [{ org: 'org', owner: 'p0', cards: 2 }])
    expect(s.calls()).toHaveLength(1)
    s.cache.release('desktop')
    expect(s.calls()).toHaveLength(1)
    s.cache.release('phone')
    expect(s.calls()).toEqual([])
  })
})

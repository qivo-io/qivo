import { afterEach, describe, expect, it } from 'vitest'
import type { PersonFaceRow } from '../../convex/model/peopleSettings'
import type { LiveTransition } from '../lib/liveQueries'
import type { Visibility } from '../lib/viewVisibility'
import { createProfileCache, type NamedPerson, PROFILE_CACHE } from './profileCache'

/* The profile cache (store/profileCache.ts) over a stand-in transport:
   which people.byIds reads it holds for the people the views name, and
   what it says of each person. No store is involved. */

type Sub = { args: { org_id: string; ids: string[] }; value?: unknown; error?: unknown }

/** A transport whose reads the test answers, a workspace that holds the
    people in `held`, and a page whose visibility the test sets. */
function setup(held: ReadonlySet<string> = new Set()) {
  const subs = new Map<string, Sub>()
  const handlers = new Set<(t: LiveTransition) => void>()
  const visibility = new Set<(v: Visibility) => void>()
  let next = 0
  let changes = 0
  let namedChanges = 0
  let watched = 0
  const cache = createProfileCache({
    live: {
      watch: (_ref, args) => {
        const token = `t${++next}`
        watched++
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
    held: (_org, id) => held.has(id),
    changed: () => changes++,
    namedChanged: () => namedChanges++,
    watchVisibility: (listener) => {
      visibility.add(listener)
      listener({ visible: true, shownAt: 0 })
      return () => visibility.delete(listener)
    },
  })
  const tell = (...tokens: string[]) => {
    for (const fn of handlers) fn({ tokens: new Set(tokens), at: 0, connection: 1 })
  }
  const reads = () =>
    [...subs].map(([token, sub]) => ({ token, org: sub.args.org_id, ids: sub.args.ids }))
  return {
    cache,
    reads,
    changes: () => changes,
    namedChanges: () => namedChanges,
    watched: () => watched,
    /** Answers read `token` with the rows of `ids` (all its ids by default). */
    answer(token: string, ids?: readonly string[]) {
      const sub = subs.get(token)
      if (!sub) throw new Error(`no read ${token}`)
      sub.value = { rows: (ids ?? sub.args.ids).map((id) => face(id)) }
      sub.error = undefined
      tell(token)
    },
    fail(token: string) {
      const sub = subs.get(token)
      if (!sub) throw new Error(`no read ${token}`)
      sub.error = new Error('failed')
      tell(token)
    },
    show(visible: boolean) {
      for (const listener of visibility) listener({ visible, shownAt: 0 })
    },
  }
}

/** Person `id`'s row as people.byIds answers it. */
const face = (id: string, name = `Person ${id}`): PersonFaceRow => ({
  id,
  name,
  org_role: 'user',
  kind: 'person',
  active: true,
  pending: false,
  color: '#7a7ad0',
  initials: 'PP',
  avatar: null,
  sample_avatar: null,
  plannable_hours: 32,
})

const people = (n: number, from = 0, org = 'org'): NamedPerson[] =>
  Array.from({ length: n }, (_, i) => ({ org, id: `p${from + i}` }))

const most = PROFILE_CACHE.most
afterEach(() => {
  PROFILE_CACHE.most = most
})

describe('the profile cache', () => {
  it("reads a view's people the workspace does not hold in chunks of 100, in the order first named", () => {
    const s = setup(new Set(['p3', 'p150']))
    s.cache.name('board', people(250))
    const reads = s.reads()
    // the people the workspace holds are never read
    expect(reads.map((r) => r.ids.length)).toEqual([100, 100, 48])
    expect(reads.flatMap((r) => r.ids)).toEqual(
      people(250)
        .map((p) => p.id)
        .filter((id) => id !== 'p3' && id !== 'p150'),
    )
    expect(reads.flatMap((r) => r.ids)).not.toContain('p3')
    // Load more changes only the last chunk
    const before = reads.map((r) => r.token)
    s.cache.name('board', people(260))
    const after = s.reads()
    expect(after.slice(0, 2).map((r) => r.token)).toEqual(before.slice(0, 2))
    expect(after).toHaveLength(3)
    expect(after[2]?.ids).toHaveLength(58)
    // a reorder of the view's rows changes no chunk
    const tokens = after.map((r) => r.token)
    s.cache.name('board', [...people(260)].reverse())
    expect(s.reads().map((r) => r.token)).toEqual(tokens)
  })

  it('reads each id in one chunk whatever the number of views naming it, and stops on release', () => {
    const s = setup()
    s.cache.name('board', people(3))
    s.cache.name('picker', people(4, 1))
    // p1 and p2 sit in the board's chunk; p4 joins it
    expect(
      s
        .reads()
        .flatMap((r) => r.ids)
        .sort(),
    ).toEqual(['p0', 'p1', 'p2', 'p3', 'p4'])
    s.cache.name('board', [])
    expect(
      s
        .reads()
        .flatMap((r) => r.ids)
        .sort(),
    ).toEqual(['p1', 'p2', 'p3', 'p4'])
    s.cache.name('picker', [])
    expect(s.reads()).toEqual([])
  })

  it('moves an id a view now names in another organization to a read there, out of the old chunk', () => {
    const s = setup()
    s.cache.name('board', [
      { org: 'a', id: 'p0' },
      { org: 'a', id: 'p1' },
    ])
    s.answer(s.reads()[0]?.token ?? '')
    expect(s.cache.look('p0')).toMatchObject({ state: 'face', org: 'a' })
    s.cache.name('board', [
      { org: 'b', id: 'p0' },
      { org: 'a', id: 'p1' },
    ])
    // A's chunk reads p1 alone, and one read of B reads p0
    expect(s.reads().map((r) => [r.org, r.ids])).toEqual([
      ['a', ['p1']],
      ['b', ['p0']],
    ])
    const [a, b] = s.reads()
    s.answer(b?.token ?? '')
    expect(s.cache.look('p0')).toMatchObject({ state: 'face', org: 'b' })
    // A's answer, which no longer asks for p0, says nothing of them
    s.answer(a?.token ?? '')
    expect(s.cache.look('p0')).toMatchObject({ state: 'face', org: 'b' })
    expect(s.cache.look('p1')).toMatchObject({ state: 'face', org: 'a' })
  })

  it('answers gone only in the organization whose answer leaves an id out, keeping a name taken under another', () => {
    const s = setup()
    // a picker of organization A gives p0's name, and two views name p0,
    // one under B first, so B's read asks for them
    s.cache.take('a', [face('p0', 'Pat Picked')])
    s.cache.name('b-view', [{ org: 'b', id: 'p0' }])
    s.cache.name('a-view', [{ org: 'a', id: 'p0' }])
    expect(s.reads().map((r) => [r.org, r.ids])).toEqual([['b', ['p0']]])
    s.answer(s.reads()[0]?.token ?? '', [])
    expect(s.cache.look('p0', 'b').state).toBe('gone')
    expect(s.cache.look('p0', 'a')).toMatchObject({ state: 'name', name: { name: 'Pat Picked' } })
    // a face cached under A is no person of B
    s.cache.name('b-view', [])
    s.answer(s.reads()[0]?.token ?? '')
    expect(s.cache.look('p0', 'a')).toMatchObject({ state: 'face', org: 'a' })
    expect(s.cache.look('p0', 'b').state).toBe('loading')
  })

  it('stops every read while the page is hidden and starts them again on return', () => {
    const s = setup()
    s.cache.name('board', people(150))
    expect(s.reads()).toHaveLength(2)
    s.show(false)
    expect(s.reads()).toEqual([])
    s.show(true)
    expect(s.reads().map((r) => r.ids.length)).toEqual([100, 50])
  })

  it('answers gone only from the current answer of the chunk that holds the id', () => {
    const s = setup()
    s.cache.name('board', people(3))
    expect(s.cache.look('p0').state).toBe('loading')
    const [read] = s.reads()
    s.answer(read?.token ?? '', ['p0', 'p1'])
    expect(s.cache.look('p0')).toMatchObject({ state: 'face', face: { name: 'Person p0' } })
    expect(s.cache.look('p2').state).toBe('gone')
    // a restarted chunk holds no answer until its new one arrives
    s.cache.name('board', people(4))
    expect(s.cache.look('p2').state).toBe('loading')
    expect(s.cache.look('p0').state).toBe('face')
    // a person a later answer leaves out loses their face
    const [again] = s.reads()
    s.answer(again?.token ?? '', ['p1', 'p2', 'p3'])
    expect(s.cache.look('p0').state).toBe('gone')
    expect(s.cache.look('p2').state).toBe('face')
  })

  it('leaves held faces and names ok after a failed read and marks the rest failed', () => {
    const s = setup()
    s.cache.name('board', people(1))
    s.answer(s.reads()[0]?.token ?? '', ['p0'])
    s.cache.take('org', [{ ...face('p1'), name: 'Pat Picked' }])
    // the chunk reads again with p1 and p2 added, and fails
    s.cache.name('board', people(3))
    const [again] = s.reads()
    expect(again?.ids).toEqual(['p0', 'p1', 'p2'])
    // a name says its read is on its way until it fails
    expect(s.cache.look('p1')).toMatchObject({ state: 'name', reading: true })
    expect(s.cache.names()).toEqual([expect.objectContaining({ reading: true })])
    s.fail(again?.token ?? '')
    expect(s.cache.look('p0').state).toBe('face')
    expect(s.cache.look('p1')).toMatchObject({
      state: 'name',
      name: { name: 'Pat Picked' },
      reading: false,
    })
    expect(s.cache.names()).toEqual([expect.objectContaining({ reading: false })])
    expect(s.cache.look('p2').state).toBe('failed')
    // a failed read is never taken as gone
    expect(people(3).some((p) => s.cache.look(p.id).state === 'gone')).toBe(false)
  })

  it("shows a picker's name at once, and a face replaces it, never the other way", () => {
    const s = setup()
    s.cache.take('org', [face('p0', 'Pat From Picker')])
    expect(s.cache.look('p0')).toMatchObject({ state: 'name', name: { name: 'Pat From Picker' } })
    s.cache.name('board', people(1))
    s.answer(s.reads()[0]?.token ?? '', ['p0'])
    expect(s.cache.look('p0')).toMatchObject({ state: 'face', face: { name: 'Person p0' } })
    s.cache.take('org', [face('p0', 'Older Picker Name')])
    expect(s.cache.look('p0')).toMatchObject({ state: 'face', face: { name: 'Person p0' } })
  })

  it('drops the face shown least recently that no view names, never a named one', () => {
    PROFILE_CACHE.most = 5
    const s = setup()
    // p0 to p4 named and answered, then released one by one, p0 first
    s.cache.name('board', people(5))
    s.answer(s.reads()[0]?.token ?? '', undefined)
    s.cache.name('board', [])
    expect(s.cache.size()).toBe(5)
    // a sixth face drops the least recently shown
    s.cache.name('picker', people(1, 5))
    s.answer(s.reads()[0]?.token ?? '', undefined)
    expect(s.cache.size()).toBe(5)
    expect(s.cache.look('p5').state).toBe('face')
    // the one dropped is a released one, never the named p5
    const kept = ['p0', 'p1', 'p2', 'p3', 'p4'].filter((id) => s.cache.look(id).state === 'face')
    expect(kept).toHaveLength(4)
  })

  it('keeps every face while every entry is named, past the bound', () => {
    PROFILE_CACHE.most = 5
    const s = setup()
    s.cache.name('board', people(7))
    s.answer(s.reads()[0]?.token ?? '', undefined)
    expect(s.cache.size()).toBe(7)
    expect(people(7).every((p) => s.cache.look(p.id).state === 'face')).toBe(true)
    // released, the cache keeps only the bound
    s.cache.name('board', [])
    s.cache.name('picker', people(1, 7))
    expect(s.cache.size()).toBe(5)
  })

  it('turns its version for a changed entry or state, never for a registration that names the same people', () => {
    const s = setup()
    s.cache.name('board', people(2))
    const v = s.cache.version()
    const changes = s.changes()
    s.cache.name('board', people(2))
    expect(s.cache.version()).toBe(v)
    expect(s.changes()).toBe(changes)
    expect(s.namedChanges()).toBe(1)
    s.answer(s.reads()[0]?.token ?? '', undefined)
    expect(s.cache.version()).toBeGreaterThan(v)
    expect(s.changes()).toBe(changes + 1)
    // the same answer again changes nothing
    const after = s.cache.version()
    s.answer(s.reads()[0]?.token ?? '', undefined)
    expect(s.cache.version()).toBe(after)
  })

  it('stops reading a person the workspace comes to hold, and reads one it no longer holds', () => {
    const held = new Set<string>()
    const s = setup(held)
    s.cache.name('board', people(2))
    expect(s.reads().flatMap((r) => r.ids)).toEqual(['p0', 'p1'])
    held.add('p1')
    s.cache.sync()
    expect(s.reads().flatMap((r) => r.ids)).toEqual(['p0'])
    held.delete('p1')
    s.cache.sync()
    expect(s.reads().flatMap((r) => r.ids)).toEqual(['p0', 'p1'])
  })

  it('empties itself and stops its reads on clear, and reads the named people again on sync', () => {
    const s = setup()
    s.cache.name('board', people(2))
    s.answer(s.reads()[0]?.token ?? '', undefined)
    expect(s.cache.size()).toBe(2)
    s.cache.clear()
    expect(s.cache.size()).toBe(0)
    expect(s.reads()).toEqual([])
    expect(s.cache.look('p0').state).toBe('loading')
    // the view still shows them, and the next session reads them again
    s.cache.sync()
    expect(s.reads().flatMap((r) => r.ids)).toEqual(['p0', 'p1'])
  })

  it('names the views most recently registered first, each in its own order', () => {
    const s = setup()
    s.cache.name('board', people(3))
    s.cache.name('picker', [
      { org: 'org', id: 'p9' },
      { org: 'org', id: 'p1' },
    ])
    expect(s.cache.named().map((p) => p.id)).toEqual(['p9', 'p1', 'p0', 'p2'])
    // a view that loads more keeps its place
    s.cache.name('board', people(4))
    expect(s.cache.named().map((p) => p.id)).toEqual(['p9', 'p1', 'p0', 'p2', 'p3'])
  })

  it('reads 1,000 people a view names in 10 chunks of 100, each id once, and holds 1,000 faces', () => {
    const s = setup()
    s.cache.name('settings', people(1000))
    const reads = s.reads()
    expect(reads).toHaveLength(10)
    expect(reads.every((r) => r.ids.length === 100)).toBe(true)
    expect(new Set(reads.flatMap((r) => r.ids)).size).toBe(1000)
    for (const read of reads) s.answer(read.token)
    expect(s.cache.size()).toBe(1000)
    expect(s.watched()).toBe(10)
  })
})

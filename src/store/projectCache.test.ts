import { afterEach, describe, expect, it } from 'vitest'
import type { NavByIdRow } from '../../convex/model/projectNavReads'
import type { LiveTransition } from '../lib/liveQueries'
import type { Visibility } from '../lib/viewVisibility'
import { createProjectCache, PROJECT_CACHE } from './projectCache'

/* The project cache (store/projectCache.ts) over a stand-in transport:
   which projectNav.byIds reads it holds for the projects the owners name,
   and what it says of each project. No store is involved. */

type Sub = { args: { ids: string[] }; value?: unknown; error?: unknown }

/** A transport whose reads the test answers, a projects part that holds
    the projects in `held`, and a page whose visibility the test sets. */
function setup(held: Set<string> = new Set()) {
  const subs = new Map<string, Sub>()
  const handlers = new Set<(t: LiveTransition) => void>()
  const visibility = new Set<(v: Visibility) => void>()
  let next = 0
  let changes = 0
  // the socket's connection count, which reconnect() moves on
  let connection = 1
  const cache = createProjectCache({
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
    held: (id) => held.has(id),
    changed: () => changes++,
    watchVisibility: (listener) => {
      visibility.add(listener)
      listener({ visible: true, shownAt: 0 })
      return () => visibility.delete(listener)
    },
  })
  const tell = (...tokens: string[]) => {
    for (const fn of handlers) fn({ tokens: new Set(tokens), at: 0, connection })
  }
  const reads = () => [...subs].map(([token, sub]) => ({ token, ids: sub.args.ids }))
  const sub = (token: string) => {
    const found = subs.get(token)
    if (!found) throw new Error(`no read ${token}`)
    return found
  }
  return {
    cache,
    held,
    reads,
    changes: () => changes,
    /** Answers read `token` with `rows` (every id's row by default), and
        `unchecked` apart. */
    answer(token: string, rows?: readonly NavByIdRow[], unchecked: readonly string[] = []) {
      const s = sub(token)
      s.value = {
        rows: rows ?? s.args.ids.filter((id) => !unchecked.includes(id)).map((id) => project(id)),
        unchecked,
        message: unchecked.length > 0 ? 'Qivo could not finish checking.' : null,
      }
      s.error = undefined
      tell(token)
    },
    fail(token: string) {
      sub(token).error = new Error('failed')
      tell(token)
    },
    show(visible: boolean) {
      for (const listener of visibility) listener({ visible, shownAt: 0 })
    },
    /** Drops the socket and connects again: the connection count moves on
        and a transition brings again only the reads `tokens` name, as
        between the transitions that bring every result again. */
    reconnect(...tokens: string[]) {
      connection++
      tell(...tokens)
    },
  }
}

/** Project `id`'s row as projectNav.byIds answers it. */
const project = (id: string, extra: Partial<NavByIdRow> = {}): NavByIdRow => ({
  id,
  org_id: 'org',
  name: `Project ${id}`,
  num: Number(id.replace(/\D/g, '')) || 1,
  parent_id: null,
  level: 'user',
  track_delay: true,
  lead_id: null,
  review_hours: 2,
  ...extra,
})

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `p${from + i}`)

const DEFAULT = { ...PROJECT_CACHE }
afterEach(() => {
  Object.assign(PROJECT_CACHE, DEFAULT)
})

describe('the project cache', () => {
  it('answers a named project loading, then ok from an answer, gone when an answer leaves it out, and unchecked with the sentence', () => {
    const s = setup()
    s.cache.name('board', ['p1', 'p2', 'p3'])
    expect(s.cache.look('p1')).toEqual({ state: 'loading', row: null, message: null })
    const [read] = s.reads()
    s.answer(read.token, [project('p1')], ['p3'])
    expect(s.cache.look('p1')).toEqual({ state: 'ok', row: project('p1'), message: null })
    expect(s.cache.look('p2').state).toBe('gone')
    expect(s.cache.look('p3')).toMatchObject({
      state: 'unchecked',
      message: 'Qivo could not finish checking.',
    })
    // the same answer object while nothing changed
    expect(s.cache.look('p1')).toBe(s.cache.look('p1'))
  })

  it('answers failed on a failed read, keeps the names of an ok entry without its level, and ok again once the read answers', () => {
    const s = setup()
    s.cache.name('board', ['p1', 'p2'])
    const [read] = s.reads()
    s.answer(read.token, [project('p1')])
    s.fail(read.token)
    // the row still names p1, and only a current answer gives a level
    expect(s.cache.look('p1')).toEqual({ state: 'failed', row: project('p1'), message: null })
    expect(s.cache.look('p2')).toEqual({ state: 'failed', row: null, message: null })
    s.answer(read.token)
    expect(s.cache.look('p1').state).toBe('ok')
    expect(s.cache.look('p2').state).toBe('ok')
  })

  it('drops the row of a project an answer makes gone, also of a parent another read stops bringing', () => {
    const s = setup()
    s.cache.name('board', ['p1'])
    const [read] = s.reads()
    s.answer(read.token)
    expect(s.cache.rows().map((row) => row.id)).toEqual(['p1'])
    // the person's access went, and the answer leaves p1 out
    s.answer(read.token, [])
    expect(s.cache.look('p1')).toEqual({ state: 'gone', row: null, message: null })
    expect(s.cache.rows()).toEqual([])
    // a hide and a show later it loads with no row, never by its old name
    s.show(false)
    expect(s.cache.look('p1')).toEqual({ state: 'loading', row: null, message: null })
    s.show(true)
    // a parent its own read leaves out, kept while a sub-project's read
    // brings it, goes once that read stops bringing it
    PROJECT_CACHE.chunk = 1
    s.cache.name('task', ['meta', 'sub'])
    const own = s.reads().find((r) => r.ids.includes('meta'))
    const other = s.reads().find((r) => r.ids.includes('sub'))
    if (!own || !other) throw new Error('no read of meta or sub')
    s.answer(own.token, [])
    s.answer(other.token, [project('sub', { parent_id: 'meta' }), project('meta')])
    expect(s.cache.look('meta').state).toBe('ok')
    s.answer(other.token, [])
    expect(s.cache.look('meta').state).toBe('gone')
    expect(s.cache.look('sub').state).toBe('gone')
    expect(s.cache.rows().filter((row) => row.id !== 'p1')).toEqual([])
  })

  it("keeps a chunk's answered read until the read of its new ids answers, so the ids it kept stay ok", () => {
    const s = setup()
    PROJECT_CACHE.chunk = 5
    s.cache.name('list', ids(3))
    const [first] = s.reads()
    s.answer(first.token)
    const states = (asked: readonly string[]) => asked.map((id) => s.cache.look(id).state)
    expect(states(ids(3))).toEqual(['ok', 'ok', 'ok'])
    s.cache.name('list', ids(4))
    // the answered read runs beside the read of the new ids
    expect(s.reads().map((r) => r.ids)).toEqual([ids(3), ids(4)])
    expect(states(ids(3))).toEqual(['ok', 'ok', 'ok'])
    expect(s.cache.look('p0').row?.level).toBe('user')
    // the id that joined loads, never gone
    expect(s.cache.look('p3').state).toBe('loading')
    const second = s.reads().find((r) => r.ids.length === 4)
    if (!second) throw new Error('no read of the new ids')
    s.answer(second.token, [project('p0'), project('p1'), project('p3')])
    // the old read stopped, and the new answer speaks for every id
    expect(s.reads().map((r) => r.ids)).toEqual([ids(4)])
    expect(states(ids(4))).toEqual(['ok', 'ok', 'gone', 'ok'])
  })

  it('follows ids that change again before the read of the new ids answers', () => {
    const s = setup()
    PROJECT_CACHE.chunk = 5
    s.cache.name('list', ids(3))
    const [first] = s.reads()
    s.answer(first.token)
    s.cache.name('list', ids(4))
    s.cache.name('list', ids(5))
    // the read of four ids stopped for the read of five, the answered one
    // still runs
    expect(s.reads().map((r) => r.ids)).toEqual([ids(3), ids(5)])
    expect(ids(3).map((id) => s.cache.look(id).row?.level)).toEqual(['user', 'user', 'user'])
    expect(['p3', 'p4'].map((id) => s.cache.look(id).state)).toEqual(['loading', 'loading'])
    const second = s.reads().find((r) => r.ids.length === 5)
    if (!second) throw new Error('no read of five ids')
    s.answer(second.token)
    expect(s.reads().map((r) => r.ids)).toEqual([ids(5)])
    expect(ids(5).map((id) => s.cache.look(id).state)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
  })

  it('marks the chunk failed, its kept rows without a level, when the read of its new ids fails', () => {
    const s = setup()
    PROJECT_CACHE.chunk = 5
    s.cache.name('list', ids(3))
    const [first] = s.reads()
    s.answer(first.token)
    s.cache.name('list', ids(4))
    const second = s.reads().find((r) => r.ids.length === 4)
    if (!second) throw new Error('no read of the new ids')
    s.fail(second.token)
    // the failed read is the chunk's now, and the answered one stopped
    expect(s.reads().map((r) => r.ids)).toEqual([ids(4)])
    expect(s.cache.look('p0')).toEqual({ state: 'failed', row: project('p0'), message: null })
    expect(s.cache.look('p3')).toEqual({ state: 'failed', row: null, message: null })
    s.answer(second.token)
    expect(ids(4).map((id) => s.cache.look(id).state)).toEqual(['ok', 'ok', 'ok', 'ok'])
  })

  it('stops both reads while the page hides, and on show reads the new ids once', () => {
    const s = setup()
    PROJECT_CACHE.chunk = 5
    s.cache.name('list', ids(3))
    s.answer(s.reads()[0].token)
    s.cache.name('list', ids(4))
    expect(s.reads()).toHaveLength(2)
    s.show(false)
    expect(s.reads()).toEqual([])
    // the names stay, with no level, and the id that joined loads
    expect(s.cache.look('p0')).toEqual({ state: 'loading', row: project('p0'), message: null })
    expect(s.cache.look('p3')).toEqual({ state: 'loading', row: null, message: null })
    s.show(true)
    expect(s.reads().map((r) => r.ids)).toEqual([ids(4)])
    s.answer(s.reads()[0].token)
    expect(ids(4).map((id) => s.cache.look(id).state)).toEqual(['ok', 'ok', 'ok', 'ok'])
  })

  it('takes a new answer of the answered read while the read of the new ids has not answered', () => {
    const s = setup()
    PROJECT_CACHE.chunk = 5
    s.cache.name('list', ids(3))
    const [first] = s.reads()
    s.answer(first.token)
    s.cache.name('list', ids(4))
    // the server answers the first read again: p0 is read-only now, and p1 went
    s.answer(first.token, [project('p0', { level: 'viewer' }), project('p2')])
    expect(s.cache.look('p0')).toMatchObject({ state: 'ok', row: { level: 'viewer' } })
    expect(s.cache.look('p1')).toEqual({ state: 'gone', row: null, message: null })
    expect(s.cache.look('p2').state).toBe('ok')
    // the id that joined still loads, never gone
    expect(s.cache.look('p3').state).toBe('loading')
    expect(s.reads()).toHaveLength(2)
  })

  it('answers a project the part stops holding as loading, with no level, until its read answers', () => {
    const s = setup(new Set(['p1']))
    s.cache.name('board', ['p1', 'p2'])
    const [first] = s.reads()
    s.answer(first.token)
    // the part's access went, so the part leaves p1 out from now on
    s.held.delete('p1')
    s.cache.sync()
    expect(s.cache.look('p1')).toEqual({ state: 'loading', row: null, message: null })
    expect(s.cache.look('p2').state).toBe('ok')
    const second = s.reads().find((r) => r.ids.includes('p1'))
    if (!second) throw new Error('no read of p1')
    s.answer(second.token, [project('p1', { level: 'viewer' }), project('p2')])
    expect(s.cache.look('p1')).toMatchObject({ state: 'ok', row: { level: 'viewer' } })
  })

  it("gives no level after a reconnect until each chunk's read answers again, a parent row another chunk brought included, keeping the names", () => {
    const s = setup()
    PROJECT_CACHE.chunk = 1
    s.cache.name('task', ['sub', 'other'])
    const [subRead, otherRead] = s.reads()
    const subRows = [project('sub', { parent_id: 'meta' }), project('meta', { level: 'lead' })]
    s.answer(subRead.token, subRows)
    s.answer(otherRead.token)
    expect(s.cache.look('meta')).toMatchObject({ state: 'ok', row: { level: 'lead' } })
    const changes = s.changes()
    // the socket connects again, and only the other read's answer arrived
    s.reconnect(otherRead.token)
    expect(s.changes()).toBeGreaterThan(changes)
    expect(s.cache.look('other').state).toBe('ok')
    expect(s.cache.look('sub')).toEqual({ state: 'loading', row: subRows[0], message: null })
    expect(s.cache.look('meta')).toEqual({ state: 'loading', row: subRows[1], message: null })
    // the sub-project's read answers on the new connection
    s.answer(subRead.token, subRows)
    expect(s.cache.look('sub')).toMatchObject({ state: 'ok', row: { level: 'user' } })
    expect(s.cache.look('meta')).toMatchObject({ state: 'ok', row: { level: 'lead' } })
  })

  it("drops a parent row only a named sub-project's answer brought once that answer stops bringing it", () => {
    const s = setup()
    s.cache.name('board', ['sub'])
    const [read] = s.reads()
    const rows = [project('sub', { parent_id: 'meta' }), project('meta', { level: 'viewer' })]
    s.answer(read.token, rows)
    expect(s.cache.look('meta').state).toBe('ok')
    // a stopped check keeps the sub-project's row, and its parent's with it
    s.answer(read.token, [], ['sub'])
    expect(s.cache.look('sub')).toMatchObject({ state: 'unchecked', row: rows[0] })
    expect(s.cache.look('meta')).toEqual({ state: 'loading', row: rows[1], message: null })
    // the person's access went, and the answer leaves both out
    s.answer(read.token, [])
    expect(s.cache.look('sub')).toEqual({ state: 'gone', row: null, message: null })
    expect(s.cache.look('meta')).toEqual({ state: 'loading', row: null, message: null })
    expect(s.cache.rows()).toEqual([])
  })

  it("answers a parent a sub-project brought ok, also when the parent's own chunk left it out", () => {
    const s = setup()
    PROJECT_CACHE.chunk = 1
    s.cache.name('task', ['meta', 'sub'])
    const [own, other] = s.reads()
    expect(own.ids).toEqual(['meta'])
    expect(other.ids).toEqual(['sub'])
    s.answer(own.token, [])
    expect(s.cache.look('meta').state).toBe('gone')
    s.answer(other.token, [
      project('sub', { parent_id: 'meta' }),
      project('meta', { level: 'viewer' }),
    ])
    expect(s.cache.look('meta')).toMatchObject({ state: 'ok', row: { level: 'viewer' } })
  })

  it('never reads a project the part holds, and reads one once the part stops holding it', () => {
    const s = setup(new Set(['p1']))
    s.cache.name('board', ['p1', 'p2'])
    expect(s.reads().map((r) => r.ids)).toEqual([['p2']])
    s.held.delete('p1')
    s.cache.sync()
    expect(s.reads().map((r) => r.ids)).toEqual([['p2', 'p1']])
    // a held one leaves its chunk again
    s.held.add('p2')
    s.cache.sync()
    expect(s.reads().map((r) => r.ids)).toEqual([['p1']])
  })

  it('reads in chunks in the order first named, a list that loads more changing only its last chunk', () => {
    const s = setup()
    PROJECT_CACHE.chunk = 3
    s.cache.name('list', ids(5))
    expect(s.reads().map((r) => r.ids)).toEqual([
      ['p0', 'p1', 'p2'],
      ['p3', 'p4'],
    ])
    const first = s.reads()[0].token
    s.cache.name('list', ids(7))
    expect(s.reads().map((r) => r.ids)).toEqual([['p0', 'p1', 'p2'], ['p3', 'p4', 'p5'], ['p6']])
    expect(s.reads()[0].token).toBe(first)
  })

  it('reads 100 ids a chunk by default, each id once whatever the owners naming it', () => {
    const s = setup()
    s.cache.name('board', ids(150))
    s.cache.name('overview', ids(50, 100))
    expect(s.reads().map((r) => r.ids.length)).toEqual([100, 50])
  })

  it("stops an owner's reads on release, and keeps an id a second owner names", () => {
    const s = setup()
    s.cache.name('board', ['p1', 'p2'])
    s.cache.name('task', ['p2'])
    s.cache.name('board', [])
    expect(s.reads().map((r) => r.ids)).toEqual([['p2']])
    expect(s.cache.isNamed('p1')).toBe(false)
    expect(s.cache.isNamed('p2')).toBe(true)
    s.cache.name('task', [])
    expect(s.reads()).toEqual([])
  })

  it('drops the least recently shown unnamed entry past the bound, never a named one or the parent of one', () => {
    const s = setup()
    PROJECT_CACHE.most = 5
    s.cache.name('a', ['p0', 'p1', 'p2'])
    const [first] = s.reads()
    s.answer(first.token)
    s.cache.name('a', [])
    s.cache.name('b', ['p3', 'sub'])
    const [second] = s.reads()
    s.answer(second.token, [
      project('p3'),
      project('sub', { parent_id: 'meta' }),
      project('meta', { level: 'viewer' }),
    ])
    expect(s.cache.size()).toBe(5)
    s.cache.name('c', ['p4', 'p5'])
    const third = s.reads().find((r) => r.ids.includes('p4'))
    if (!third) throw new Error('no read of p4')
    // the read that holds sub answers its parent again
    const rowsOf = (asked: readonly string[]) => [
      ...asked.map((id) => (id === 'sub' ? project('sub', { parent_id: 'meta' }) : project(id))),
      ...(asked.includes('sub') ? [project('meta', { level: 'viewer' })] : []),
    ]
    s.answer(third.token, rowsOf(third.ids))
    // the released p0, p1 and p2 went, the least recently shown first;
    // meta stays as sub's parent
    expect(s.cache.size()).toBe(5)
    for (const id of ['p0', 'p1', 'p2']) expect(s.cache.look(id).row).toBeNull()
    expect(s.cache.look('meta').row).not.toBeNull()
    // past the bound the cache holds what is named
    PROJECT_CACHE.most = 1
    s.cache.name('c', ['p4', 'p5', 'p6'])
    expect(s.cache.size()).toBe(5)
    for (const id of ['p3', 'sub', 'meta', 'p4', 'p5']) expect(s.cache.look(id).row).not.toBeNull()
  })

  it('stops every read while the page is hidden and reads again on show, the names kept', () => {
    const s = setup()
    s.cache.name('board', ['p1'])
    s.answer(s.reads()[0].token)
    s.show(false)
    expect(s.reads()).toEqual([])
    // no current answer, so no level, and the name stays
    expect(s.cache.look('p1')).toEqual({ state: 'loading', row: project('p1'), message: null })
    s.show(true)
    expect(s.reads().map((r) => r.ids)).toEqual([['p1']])
    s.answer(s.reads()[0].token)
    expect(s.cache.look('p1').state).toBe('ok')
  })

  it('reads nothing for a project no owner names, which stays loading', () => {
    const s = setup()
    expect(s.cache.look('p9')).toEqual({ state: 'loading', row: null, message: null })
    expect(s.reads()).toEqual([])
  })

  it('turns its version on a change and not on a registration naming the same projects', () => {
    const s = setup()
    s.cache.name('board', ['p1'])
    const v = s.cache.version()
    s.cache.name('board', ['p1'])
    expect(s.cache.version()).toBe(v)
    s.answer(s.reads()[0].token)
    expect(s.cache.version()).toBeGreaterThan(v)
    const after = s.cache.version()
    const changes = s.changes()
    s.answer(s.reads()[0].token)
    expect(s.cache.version()).toBe(after)
    expect(s.changes()).toBe(changes)
  })

  it('empties itself and stops its reads on clear, and reads again for the owners on the next sync', () => {
    const s = setup()
    s.cache.name('board', ['p1'])
    s.answer(s.reads()[0].token)
    s.cache.clear()
    expect(s.reads()).toEqual([])
    expect(s.cache.size()).toBe(0)
    expect(s.cache.look('p1').state).toBe('loading')
    s.cache.sync()
    expect(s.reads().map((r) => r.ids)).toEqual([['p1']])
  })
})

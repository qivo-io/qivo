import { afterEach, describe, expect, it } from 'vitest'
import type { NavByIdRow } from '../../convex/model/projectNavReads'
import type { LiveTransition } from '../lib/liveQueries'
import type { Visibility } from '../lib/viewVisibility'
import { createProjectCache, PROJECT_CACHE } from './projectCache'

/* The project cache (store/projectCache.ts) over a stand-in transport:
   which projectNav.byIds reads it holds for the projects the owners name,
   and what it says of each project. No store is involved. */

type Sub = {
  args: { ids: string[] }
  value?: unknown
  error?: unknown
  watches: number
  answered: boolean
}

/** A transport whose reads the test answers and a page whose visibility the
    test sets. With
    `share`, watches of the same ids share one read and its token, as
    Convex shares them, and a watch is `joined` once a transition named
    that token, on any connection, as lib/liveQueries.ts says. */
function setup({ share = false } = {}) {
  const subs = new Map<string, Sub>()
  const handlers = new Set<(t: LiveTransition) => void>()
  const visibility = new Set<(v: Visibility) => void>()
  let next = 0
  let changes = 0
  // whether each watch asked for a fresh run, in order
  const fresh: boolean[] = []
  // the socket's connection count, which reconnect() moves on
  let connection = 1
  const cache = createProjectCache({
    live: {
      watch: (_ref, args, sharing) => {
        const token = share ? `ids:${JSON.stringify(args)}` : `t${++next}`
        const known = subs.get(token)
        if (known) known.watches++
        else subs.set(token, { args: args as Sub['args'], watches: 1, answered: false })
        // a fresh watch runs the shared read again, so no watch has its
        // answer until a transition brings the new run's
        if (known && sharing?.fresh) {
          known.answered = false
          known.value = undefined
        }
        fresh.push(!!sharing?.fresh)
        let stopped = false
        return {
          token,
          joined: (!sharing?.fresh && known?.answered) ?? false,
          stop: () => {
            if (stopped) return
            stopped = true
            const sub = subs.get(token)
            if (sub && --sub.watches === 0) subs.delete(token)
          },
        }
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
    changed: () => changes++,
    watchVisibility: (listener) => {
      visibility.add(listener)
      listener({ visible: true, shownAt: 0 })
      return () => visibility.delete(listener)
    },
  })
  const tell = (...tokens: string[]) => {
    for (const token of tokens) {
      const sub = subs.get(token)
      if (sub) sub.answered = true
    }
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
    reads,
    fresh,
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
    /** Drops the socket and connects again. The connection count moves on
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
    // the server answers the first read again, p0 read-only now and p1 gone
    s.answer(first.token, [project('p0', { level: 'viewer' }), project('p2')])
    expect(s.cache.look('p0')).toMatchObject({ state: 'ok', row: { level: 'viewer' } })
    expect(s.cache.look('p1')).toEqual({ state: 'gone', row: null, message: null })
    expect(s.cache.look('p2').state).toBe('ok')
    // the id that joined still loads, never gone
    expect(s.cache.look('p3').state).toBe('loading')
    expect(s.reads()).toHaveLength(2)
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

  it('takes no state from a read a chunk joins that answered before a reconnect, until it answers on the new connection', () => {
    const s = setup({ share: true })
    PROJECT_CACHE.chunk = 2
    s.cache.name('board', ['p0', 'p1'])
    const [first] = s.reads()
    s.answer(first.token)
    // the Board names two other projects, and its answered read of p0 and
    // p1 runs beside the read of the new ones
    s.cache.name('board', ['p2', 'p3'])
    expect(s.reads().map((r) => r.ids)).toEqual([
      ['p0', 'p1'],
      ['p2', 'p3'],
    ])
    // the socket connects again, and neither read has answered on it
    s.reconnect()
    // the task window names p0 and p1 in that order, so its chunk joins the
    // Board's answered read
    s.cache.name('task', ['p0', 'p1'])
    expect(s.reads().map((r) => r.ids)).toEqual([
      ['p0', 'p1'],
      ['p2', 'p3'],
    ])
    expect(s.cache.look('p0')).toEqual({ state: 'loading', row: project('p0'), message: null })
    expect(s.cache.look('p1')).toEqual({ state: 'loading', row: project('p1'), message: null })
    // the read answers on the new connection, p0 read-only now and p1 gone
    s.answer(first.token, [project('p0', { level: 'viewer' })])
    expect(s.cache.look('p0')).toMatchObject({ state: 'ok', row: { level: 'viewer' } })
    expect(s.cache.look('p1')).toEqual({ state: 'gone', row: null, message: null })
    // the task window closes and opens again on them, and its new chunk
    // takes at once the answer of the read it joins, which came on this
    // connection
    s.cache.name('task', [])
    s.cache.name('task', ['p0', 'p1'])
    expect(s.cache.look('p1')).toEqual({ state: 'gone', row: null, message: null })
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

  it("keeps the rows of a sub-project an owner let go and of its parent when its chunk's next answer speaks for another owner's alone", () => {
    const s = setup()
    s.cache.name('board', ['a'])
    s.cache.name('task', ['b'])
    const [read] = s.reads()
    expect(read.ids).toEqual(['a', 'b'])
    const rowA = project('a', { parent_id: 'pa' })
    const parentA = project('pa', { level: 'viewer' })
    const rowB = project('b', { parent_id: 'pb' })
    const parentB = project('pb', { level: 'viewer' })
    s.answer(read.token, [rowA, parentA, rowB, parentB])
    // the Board's kept page hides and lets a go, and the read of b alone
    // answers
    s.cache.name('board', [])
    const next = s.reads().find((r) => r.token !== read.token)
    if (!next) throw new Error('no read of b')
    expect(next.ids).toEqual(['b'])
    s.answer(next.token, [rowB, parentB])
    expect(s.reads().map((r) => r.ids)).toEqual([['b']])
    // no answer made a gone, so its row and its parent's stay for the bound
    expect(s.cache.look('a')).toEqual({ state: 'loading', row: rowA, message: null })
    expect(s.cache.look('pa')).toEqual({ state: 'loading', row: parentA, message: null })
    // the Board shows again and names a by its kept row at once
    s.cache.name('board', ['a'])
    expect(s.cache.look('a')).toEqual({ state: 'loading', row: rowA, message: null })
    const again = s.reads().find((r) => r.ids.includes('a'))
    if (!again) throw new Error('no read of a')
    s.answer(again.token, [rowB, parentB, rowA, parentA])
    expect(s.cache.look('a')).toMatchObject({ state: 'ok', row: { level: 'user' } })
  })

  it('keeps the row of a parent its own read answered once its owner lets it go and its sub-project goes', () => {
    const s = setup()
    PROJECT_CACHE.chunk = 1
    s.cache.name('board', ['sub'])
    const [subRead] = s.reads()
    const parent = project('meta', { level: 'viewer' })
    s.answer(subRead.token, [project('sub', { parent_id: 'meta' }), parent])
    // the task window opens on meta, whose own read answers it, and closes
    s.cache.name('task', ['meta'])
    const own = s.reads().find((r) => r.ids.includes('meta'))
    if (!own) throw new Error('no read of meta')
    s.answer(own.token, [parent])
    s.cache.name('task', [])
    // the person's access to sub went, and its answer leaves it out
    s.answer(subRead.token, [])
    expect(s.cache.look('sub')).toEqual({ state: 'gone', row: null, message: null })
    expect(s.cache.look('meta')).toEqual({ state: 'loading', row: parent, message: null })
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

  it('reads every project an owner names, as the workspace holds none', () => {
    const s = setup()
    s.cache.name('board', ['p1', 'p2'])
    expect(s.reads().map((r) => r.ids)).toEqual([['p1', 'p2']])
  })

  it('opens a seeded project with its facts and no level until its read answers, and drops the seed once an answer leaves it out', () => {
    const s = setup()
    s.cache.seed([{ id: 'p1', org_id: 'org', name: 'Plan', num: 3, parent_id: null }])
    s.cache.name('scope', ['p1'])
    expect(s.cache.seeds().map((x) => x.id)).toEqual(['p1'])
    expect(s.cache.look('p1').state).toBe('loading')
    // must fail: a seed gives no row and so no level
    expect(s.cache.look('p1').row).toBeNull()
    s.answer(s.reads()[0].token, [])
    expect(s.cache.look('p1').state).toBe('gone')
    expect(s.cache.seeds()).toEqual([])
  })

  it('takes no seed for a project the current answer left out, until an answer brings it again', () => {
    const s = setup()
    s.cache.name('scope', ['p1'])
    s.answer(s.reads()[0].token, [])
    expect(s.cache.look('p1').state).toBe('gone')
    // a navigation row that showed it before seeds it again
    s.cache.seed([{ id: 'p1', org_id: 'org', name: 'Plan', num: 1, parent_id: null }])
    // must fail for a seed that names a gone project
    expect(s.cache.seedOf('p1')).toBeUndefined()
    expect(s.cache.seeds()).toEqual([])
    // once an answer brings it again, it is the row's
    s.answer(s.reads()[0].token)
    expect(s.cache.look('p1').state).toBe('ok')
  })

  it('gives a seed way to the row an answer brings, and never replaces a row with a seed', () => {
    const s = setup()
    s.cache.seed([{ id: 'p1', org_id: 'org', name: 'Seeded', num: 3, parent_id: null }])
    s.cache.name('scope', ['p1'])
    s.answer(s.reads()[0].token)
    expect(s.cache.seeds()).toEqual([])
    expect(s.cache.look('p1').state).toBe('ok')
    s.cache.seed([{ id: 'p1', org_id: 'org', name: 'Seeded again', num: 3, parent_id: null }])
    expect(s.cache.seeds()).toEqual([])
  })

  it('reads a failed chunk again from a fresh read on retry, and leaves an answered one alone', () => {
    const s = setup()
    s.cache.name('scope', ['p1'])
    const [first] = s.reads()
    s.fail(first.token)
    expect(s.cache.look('p1').state).toBe('failed')
    s.cache.retry('scope')
    const [again] = s.reads()
    expect(again.token).not.toBe(first.token)
    expect(s.cache.look('p1').state).toBe('loading')
    s.answer(again.token)
    expect(s.cache.look('p1').state).toBe('ok')
    s.cache.retry('scope')
    expect(s.reads()[0].token).toBe(again.token)
  })

  it("keeps a chunk's answer on retry of a project it listed apart, the others' levels included, until a fresh run answers", () => {
    for (const share of [false, true]) {
      const s = setup({ share })
      s.cache.name('scope', ['p1'])
      s.cache.name('board', ['p1', 'p2'])
      const [first] = s.reads()
      s.answer(first.token, undefined, ['p1'])
      expect(s.cache.look('p1').state).toBe('unchecked')
      expect(s.cache.look('p2')).toMatchObject({ state: 'ok', row: { level: 'user' } })
      s.cache.retry('scope')
      // must fail for a retry that drops the answer the chunk holds
      expect(s.cache.look('p2')).toMatchObject({ state: 'ok', row: { level: 'user' } })
      expect(s.cache.look('p1').state).toBe('unchecked')
      // a fresh run of the chunk's ids, which Convex runs again also where
      // the answered read shares its subscription
      expect(s.fresh.at(-1)).toBe(true)
      const again = s.reads().at(-1)
      if (!again) throw new Error('no fresh read')
      if (!share) expect(again.token).not.toBe(first.token)
      s.answer(again.token)
      expect(s.cache.look('p1').state).toBe('ok')
      expect(s.cache.look('p2').state).toBe('ok')
      // the chunk holds one read again
      expect(s.cache.reads()).toEqual([['p1', 'p2']])
      expect(s.reads()).toHaveLength(1)
    }
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

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
    for (const fn of handlers) fn({ tokens: new Set(tokens), at: 0, connection: 1 })
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

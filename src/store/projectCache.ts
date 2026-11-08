/* The projects the open views name that the workspace's projects part does
   not hold, read by id from the server (convex/projectNav.ts byIds) and kept
   in one bounded cache, so every project lookup of the store
   (store/planner.ts P.project, P.levelOn and the rest) answers a project a
   view shows without the store holding every project.

   - An owner (a view slot, the task window) names the projects it shows
     (`name`), in its order, under its own key, replacing what it named
     before, and releases them when it closes or a kept page hides. Owners
     only name ids; the cache owns the reads.
   - For the named projects the part does not hold (`held`, archived ones
     included), the cache keeps live projectNav.byIds reads, `chunk` ids a
     read, in the order the owners first named them. A new id joins the last
     chunk, or a new one when that is full, so a list that loads more
     changes only its last chunk, and each id sits in one chunk at a time
     whatever the number of owners naming it. An id no owner names any more,
     or one the part now holds, leaves its chunk, and one the part stops
     holding, as when access goes, is read from then on. A chunk whose ids
     change keeps its answered read until the read of its new ids answers,
     so the ids it kept keep their state, levels included, meanwhile, and an
     id that joined reads as `loading`. Every read stops while the page is
     hidden and starts again on return, the entries kept.
   - An answer keeps each row, the parent of every sub-project it answers
     among them. A project is `ok` while a current answer holds its row,
     the only state that gives a level. An id its chunk's current answer
     lists apart is `unchecked` with the answer's sentence, and one it
     leaves out is `gone` while that answer is current, unless another
     current answer holds its row, since a parent row counts as an answer
     for that parent. A failed chunk marks its ids `failed`, and one whose
     read restarts holds no answer, so its ids read as `loading`, until the
     new one arrives. A row kept from an earlier answer still names the
     project in every state but `gone`, never with a right, so stale rights
     are never kept. An answer that makes a project `gone` drops its row,
     so nothing the cache keeps names it any more.
   - A project no owner names stays `loading` until one names it: the cache
     has no safety net for an unnamed miss, so every reader's host names
     what it shows.
   - "Shown" means named by an open owner. A released entry keeps the
     moment its last owner let it go, and the parent of a named sub-project
     counts as named. Past PROJECT_CACHE.most entries the cache drops the
     one shown least recently that no owner names, so an open view never
     loses a project it shows, and past the design size the cache holds
     what open views name and nothing more.
   - It writes nothing and takes no paint: a write to a project only the
     cache holds sends what its page showed, and the live answer follows.
   - `version` turns on every change of an entry or a state, never on a
     registration that names the same projects. */

import type { FunctionReference } from 'convex/server'
import type { Value } from 'convex/values'
import { api } from '../../convex/_generated/api'
import { BY_IDS_MAX } from '../../convex/lib/limits'
import type { NavByIdRow, NavByIds } from '../../convex/model/projectNavReads'
import type { LiveQueries } from '../lib/liveQueries'
import type { Visibility } from '../lib/viewVisibility'

/** The cache's bounds, an object tests lower. `most`: the entries it keeps,
    the named ones among them; past it only entries an open view names
    stay. The design size's live and archived projects and sub-projects
    together are 2,000 (200 and 300 projects, 500 and 1,000 sub-projects),
    and the cache holds live projects only, so an organization at the design
    size needs at most 700 entries and 2,000 also covers a login with seats
    in several organizations. An entry is a few hundred bytes, so 2,000 cost
    well under a megabyte. `chunk`: the ids one live read asks for, the
    server's BY_IDS_MAX (100), since every design-size case of 100 ids
    answers whole (convex/tests/projectNavByIds.test.ts). */
export const PROJECT_CACHE = { most: 2_000, chunk: BY_IDS_MAX }

/** Where a project stands in the cache: `ok` while a current answer holds
    its row, `loading` until one answers, `failed` after a failed read,
    `unchecked` where the answer listed it apart, and `gone` where the
    current answer left it out. */
export type CachedState = 'ok' | 'loading' | 'failed' | 'unchecked' | 'gone'

/** What the cache knows of one project: its state, the row that names it
    (the current one for `ok`, else the last one an answer brought, never
    for `gone`), and for `unchecked` the answer's sentence. Only `ok` gives
    the row's level. */
export type CachedProject = {
  state: CachedState
  row: NavByIdRow | null
  message: string | null
}

/** What the cache needs from the store and the transport. */
export type ProjectCacheDeps = {
  live: Pick<LiveQueries, 'watch' | 'read' | 'onTransition'>
  /** Whether the workspace's projects part holds project `id`, archived
      ones included. */
  held: (id: string) => boolean
  /** Called once after a transition or a registration that changed an
      entry or a state, so the store repaints. */
  changed: () => void
  /** The hidden-tab gate (lib/viewVisibility.ts watchVisibility). */
  watchVisibility: (listener: (visibility: Visibility) => void) => () => void
}

const QUERY = api.projectNav.byIds as FunctionReference<'query'>

/** A chunk's subscription: the ids it asked, as JSON too. */
type Sub = { token: string; stop: () => void; ids: readonly string[]; args: string }

/** One live read: its ids in the order first named, its subscription while
    the page shows, the subscription of its new ids while that has not
    answered (`next`), and its current answer, which says what it asked,
    `failed`, or null while it has none. */
type Chunk = {
  ids: string[]
  sub: Sub | null
  next: Sub | null
  result:
    | {
        asked: ReadonlySet<string>
        rows: Map<string, NavByIdRow>
        unchecked: Map<string, string>
      }
    | 'failed'
    | null
}

const LOADING: CachedProject = Object.freeze({ state: 'loading', row: null, message: null })
const FAILED: CachedProject = Object.freeze({ state: 'failed', row: null, message: null })
const GONE: CachedProject = Object.freeze({ state: 'gone', row: null, message: null })

/** Creates the cache over `deps`. */
export function createProjectCache(deps: ProjectCacheDeps) {
  // the projects each owner names, by its key, in the order owners first named
  const owners = new Map<string, readonly string[]>()
  // how many owners name each id
  let namedCount = new Map<string, number>()
  // the rows the answers brought, the least recently shown first (Map order)
  const entries = new Map<string, NavByIdRow>()
  // the chunks, oldest first, and the chunk of each id
  let chunks: Chunk[] = []
  const chunkOf = new Map<string, Chunk>()
  // the answer of each project as `look` gave it, so each keeps its identity
  const looks = new Map<string, CachedProject>()
  let visible = true
  let revision = 0
  let dirty = false
  let stopTransitions: (() => void) | null = null
  let watching = false

  const touch = () => {
    revision++
    dirty = true
    looks.clear()
  }

  /** Tells the store once that an entry or a state changed. */
  function flush() {
    if (!dirty) return
    dirty = false
    deps.changed()
  }

  /** Whether an owner names `id`, or names a sub-project whose parent it is. */
  function isNamed(id: string, parents: ReadonlySet<string>) {
    return namedCount.has(id) || parents.has(id)
  }

  /** The parents of every named project the cache holds a row for. */
  function namedParents(): Set<string> {
    const out = new Set<string>()
    for (const id of namedCount.keys()) {
      const parent = entries.get(id)?.parent_id
      if (parent) out.add(parent)
    }
    return out
  }

  /** Drops the entries past PROJECT_CACHE.most, the least recently shown
      first, never one an owner names or the parent of one. */
  function bound() {
    if (entries.size <= PROJECT_CACHE.most) return
    const parents = namedParents()
    for (const id of entries.keys()) {
      if (entries.size <= PROJECT_CACHE.most) return
      if (isNamed(id, parents)) continue
      entries.delete(id)
      touch()
    }
  }

  /** Takes in chunk `chunk`'s result from the transport. */
  function take(chunk: Chunk) {
    const sub = chunk.sub
    if (!sub) return
    let answer: NavByIds | undefined
    try {
      answer = deps.live.read(sub.token) as NavByIds | undefined
    } catch {
      if (chunk.result !== 'failed') {
        chunk.result = 'failed'
        touch()
      }
      return
    }
    if (!answer) return
    const asked = new Set(sub.ids)
    const unchecked = new Map(answer.unchecked.map((id) => [id, answer.message ?? '']))
    for (const row of answer.rows) {
      const was = entries.get(row.id)
      if (was && JSON.stringify(was) === JSON.stringify(row)) continue
      entries.set(row.id, row)
      touch()
    }
    // the kept rows, so an unchanged project keeps its row's identity
    const rows = new Map(answer.rows.map((row) => [row.id, entries.get(row.id) ?? row]))
    const before = chunk.result
    const same =
      before !== null &&
      before !== 'failed' &&
      before.asked.size === asked.size &&
      [...asked].every((id) => before.asked.has(id)) &&
      before.rows.size === rows.size &&
      [...rows].every(([id, row]) => before.rows.get(id) === row) &&
      before.unchecked.size === unchecked.size &&
      [...unchecked].every(([id, message]) => before.unchecked.get(id) === message)
    if (same) return
    chunk.result = { asked, rows, unchecked }
    touch()
    // a project this answer makes gone, one it asked or a parent row it
    // stopped bringing, keeps no row, so no lookup names it from an
    // earlier answer
    const dropped = before && before !== 'failed' ? [...before.rows.keys()] : []
    for (const id of new Set([...asked, ...dropped]))
      if (entries.has(id) && lookUp(id).state === 'gone') entries.delete(id)
    bound()
  }

  /** Takes in the first result of chunk `chunk`'s read of its new ids, if
      it has one: that read becomes the chunk's, and the one it replaces
      stops. */
  function promote(chunk: Chunk) {
    const next = chunk.next
    if (!next) return
    let settled: boolean
    try {
      settled = deps.live.read(next.token) !== undefined
    } catch {
      settled = true
    }
    if (!settled) return
    chunk.sub?.stop()
    chunk.sub = next
    chunk.next = null
    take(chunk)
  }

  /** Hears every transition once for every chunk, so the answers one
      transition brings repaint once. */
  function listen() {
    stopTransitions ??= deps.live.onTransition(
      (transition) => {
        for (const chunk of chunks) {
          if (chunk.next && transition.tokens.has(chunk.next.token)) promote(chunk)
          if (chunk.sub && transition.tokens.has(chunk.sub.token)) take(chunk)
        }
        flush()
      },
      { view: true },
    )
  }

  /** A live read of `ids`. */
  function watchIds(ids: readonly string[]): { sub: Sub; joined: boolean } {
    listen()
    const w = deps.live.watch(QUERY, { ids: [...ids] } as Record<string, Value>)
    return {
      sub: { token: w.token, stop: w.stop, ids: [...ids], args: JSON.stringify(ids) },
      joined: w.joined,
    }
  }

  /** Starts, restarts or stops `chunk`'s read to match its ids and the
      page's visibility. A chunk whose ids change while its read holds an
      answer keeps that read until the read of the new ids answers
      (promote); one with no answer to keep restarts at once. */
  function follow(chunk: Chunk) {
    const args = JSON.stringify(chunk.ids)
    const idle = !visible || chunk.ids.length === 0
    if (chunk.next && (idle || chunk.next.args !== args)) {
      chunk.next.stop()
      chunk.next = null
    }
    const answered = chunk.result !== null && chunk.result !== 'failed'
    if (chunk.sub && (idle || (chunk.sub.args !== args && !answered))) {
      chunk.sub.stop()
      chunk.sub = null
      if (chunk.result !== null) {
        chunk.result = null
        touch()
      }
    }
    if (idle) return
    if (!chunk.sub) {
      const { sub, joined } = watchIds(chunk.ids)
      chunk.sub = sub
      if (joined) take(chunk)
      return
    }
    if (chunk.sub.args === args || chunk.next) return
    const { sub, joined } = watchIds(chunk.ids)
    chunk.next = sub
    if (joined) promote(chunk)
  }

  /** Brings the chunks in line with the projects the owners name now and
      the projects the part holds. */
  function sync() {
    const wanted = new Set<string>()
    for (const ids of owners.values())
      for (const id of ids) if (!wanted.has(id) && !deps.held(id)) wanted.add(id)
    const changed = new Set<Chunk>()
    // an id no owner names, or one the part holds now, leaves its chunk
    for (const [id, chunk] of chunkOf) {
      if (wanted.has(id)) continue
      chunk.ids = chunk.ids.filter((x) => x !== id)
      chunkOf.delete(id)
      changed.add(chunk)
    }
    // a new id joins the last chunk, or a new one
    for (const id of wanted) {
      if (chunkOf.has(id)) continue
      let last = chunks.at(-1)
      if (!last || last.ids.length >= PROJECT_CACHE.chunk) {
        last = { ids: [], sub: null, next: null, result: null }
        chunks.push(last)
      }
      last.ids.push(id)
      chunkOf.set(id, last)
      changed.add(last)
    }
    const empty = chunks.filter((chunk) => chunk.ids.length === 0)
    if (empty.length > 0) {
      for (const chunk of empty) follow(chunk)
      chunks = chunks.filter((chunk) => chunk.ids.length > 0)
    }
    for (const chunk of changed) if (chunk.ids.length > 0) follow(chunk)
    if (changed.size > 0) touch()
  }

  /** Follows the hidden-tab gate from the first registration on. */
  function watchPage() {
    if (watching) return
    watching = true
    deps.watchVisibility((now) => {
      if (now.visible === visible) return
      visible = now.visible
      for (const chunk of chunks) follow(chunk)
      flush()
    })
  }

  /** Counts each named id once an owner, and answers whether the named
      projects changed. */
  function recount(): boolean {
    const next = new Map<string, number>()
    for (const ids of owners.values()) {
      const seen = new Set<string>()
      for (const id of ids) {
        if (seen.has(id)) continue
        seen.add(id)
        next.set(id, (next.get(id) ?? 0) + 1)
      }
    }
    // a released entry keeps the moment its last owner let it go, and a
    // named one counts as shown now
    for (const id of new Set([...namedCount.keys(), ...next.keys()])) {
      const entry = entries.get(id)
      if (!entry) continue
      entries.delete(id)
      entries.set(id, entry)
    }
    const same = next.size === namedCount.size && [...next.keys()].every((id) => namedCount.has(id))
    namedCount = next
    return !same
  }

  const sameList = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((id, i) => id === b[i])

  /** The current answer's row of project `id`, from its own chunk or, for a
      parent another chunk's sub-project brought, from any chunk. */
  function currentRow(id: string): NavByIdRow | undefined {
    const own = chunkOf.get(id)?.result
    if (own && own !== 'failed') {
      const row = own.rows.get(id)
      if (row) return row
    }
    for (const chunk of chunks) {
      const result = chunk.result
      if (result && result !== 'failed') {
        const row = result.rows.get(id)
        if (row) return row
      }
    }
    return undefined
  }

  /** What the cache knows of `id`, worked out (look keeps the answers). */
  function lookUp(id: string): CachedProject {
    const row = currentRow(id)
    if (row) return { state: 'ok', row, message: null }
    const kept = entries.get(id) ?? null
    const result = chunkOf.get(id)?.result
    if (result === 'failed') return kept ? { state: 'failed', row: kept, message: null } : FAILED
    // an answer speaks only of the ids it asked, so an id that joined the
    // chunk since loads until the read of the new ids answers
    if (result?.asked.has(id)) {
      const message = result.unchecked.get(id)
      if (message !== undefined) return { state: 'unchecked', row: kept, message }
      return GONE
    }
    return kept ? { state: 'loading', row: kept, message: null } : LOADING
  }

  return {
    /** Names project `ids` under owner `owner`, in its order, replacing what
        it named before; an empty list releases them. */
    name(owner: string, ids: readonly string[]) {
      const was = owners.get(owner)
      if (ids.length === 0) {
        if (!was) return
        owners.delete(owner)
      } else {
        if (was && sameList(was, ids)) return
        owners.set(owner, [...ids])
      }
      watchPage()
      recount()
      sync()
      bound()
      flush()
    },
    /** Whether an owner names project `id`. */
    isNamed: (id: string) => namedCount.has(id),
    /** What the cache knows of project `id`, marking nothing, so a render,
        also one of a hidden kept page, changes no order. The same object
        while nothing changed. */
    look(id: string): CachedProject {
      let known = looks.get(id)
      if (!known) {
        known = lookUp(id)
        looks.set(id, known)
      }
      return known
    },
    /** Every row the cache keeps, never one of a `gone` project, for the
        store's cached facts and number tags. */
    rows(): NavByIdRow[] {
      return [...entries.values()]
    },
    /** Turns on every change of an entry or a state. */
    version: () => revision,
    /** Follows a change of the projects the part holds: an id it holds now
        leaves its chunk, and one it no longer holds is read. */
    sync() {
      if (owners.size === 0) return
      sync()
      flush()
    },
    /** The live reads now, each chunk's ids in order, for the tests and the
        measurement. */
    reads(): string[][] {
      return chunks.filter((chunk) => chunk.sub).map((chunk) => [...chunk.ids])
    },
    /** How many entries the cache holds, for the tests and the measurement. */
    size: () => entries.size,
    /** Empties the cache and stops its reads, for sign-out, a demo's end and
        reinitialization. The owners' registrations stay, since a view that
        stays mounted names the same projects, and the store's next `sync`
        reads them again for the new session. */
    clear() {
      for (const chunk of chunks) {
        chunk.sub?.stop()
        chunk.next?.stop()
        chunk.sub = null
        chunk.next = null
      }
      chunks = []
      chunkOf.clear()
      entries.clear()
      looks.clear()
      stopTransitions?.()
      stopTransitions = null
      revision++
      dirty = false
    },
  }
}

export type ProjectCache = ReturnType<typeof createProjectCache>

/* The projects the app shows, read by id from the server
   (convex/projectNav.ts byIds) and kept in one bounded cache, the store's
   only source of project facts and of the caller's levels: the workspace
   holds no project, so every project lookup of the store
   (store/planner.ts P.project, P.levelOn and the rest) answers from here.

   - An owner (a view slot, the scope, a dialog, the task window) names
     the projects it shows (`name`), in its order, under its own key,
     replacing what it named before, and releases them when it closes or a
     kept page hides. Owners only name ids; the cache owns the reads.
   - For the named projects the cache keeps live projectNav.byIds reads,
     `chunk` ids a read, in the order the owners first named them. A new id
     joins the last chunk, or a new one when that is full, so a list that
     loads more changes only its last chunk, and each id sits in one chunk
     at a time whatever the number of owners naming it. An id no owner
     names any more leaves its chunk. A chunk whose ids
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
     new one arrives. A reconnect leaves every answer to arrive again
     before it counts (lib/liveQueries.ts), so from a transition of a newer
     connection a chunk's answer gives no state but `loading` until its
     read answers on that connection, a parent row it brought included,
     and a chunk that joins a read another chunk holds takes that read's
     answer only if it arrived on the newest connection. A row kept from
     an earlier answer still names the project in every state but `gone`,
     never with a right, so stale rights are never kept. An answer that
     makes a project `gone` drops its row, so nothing the cache keeps names
     it any more, and with it the row of a parent it stopped bringing, or
     of the gone project's parent, that only answers as a parent ever
     brought, while no owner names it, no chunk reads it, no kept row names
     it as its parent and no current answer holds it. A project a read
     asked for keeps its row once its owners let it go, as its parent
     does, until the bound drops it or an answer makes it gone.
   - A project no owner names stays `loading` until one names it: the cache
     has no safety net for an unnamed miss, so every reader's host names
     what it shows.
   - A navigation row that opens a project seeds its facts (`seed`): its
     organization, name, number and parent, never a level, so a scope
     opened from the row names its project and its views ask at once while
     the cache reads it. A seed reads as `loading` and gives way to the
     first row an answer brings, and an answer that makes the project `gone`
     drops it. It never replaces a row the cache keeps.
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
    the named ones among them, and as many seeds; past it only entries an
    open view names stay. The design size's live and archived projects and
    sub-projects together are 2,000 (200 and 300 projects, 500 and 1,000
    sub-projects), and the cache holds live projects only, so an
    organization at the design size names at most 700 live projects (200
    top-level and 500 sub-projects) and 2,000 also covers a login with
    seats in several organizations. An entry is a few hundred bytes, so 2,000 cost
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

/** The facts a navigation row gives of a project it shows
    (projectNav.page, children, search and resolve rows): no level. */
export type ProjectSeed = Pick<NavByIdRow, 'id' | 'org_id' | 'name' | 'num' | 'parent_id'>

/** What the cache needs from the store and the transport. */
export type ProjectCacheDeps = {
  live: Pick<LiveQueries, 'watch' | 'read' | 'onTransition'>
  /** Called once after a transition or a registration that changed an
      entry or a state, so the store repaints. */
  changed: () => void
  /** The hidden-tab gate (lib/viewVisibility.ts watchVisibility). */
  watchVisibility: (listener: (visibility: Visibility) => void) => () => void
}

const QUERY = api.projectNav.byIds as FunctionReference<'query'>

/** A chunk's subscription: the ids it asked, as JSON too, and the
    connection on which its token last answered, the same for every chunk
    that holds the token (`answeredOn`, null before its first answer). */
type Sub = {
  token: string
  stop: () => void
  ids: readonly string[]
  args: string
  answeredOn: number | null
}

/** One live read: its ids in the order first named, its subscription while
    the page shows, the subscription of its new ids while that has not
    answered (`next`), its last answer, which says what it asked, `failed`,
    or null while it has none, and whether that answer arrived on the
    newest connection the cache heard (`fresh`), the only one that counts. */
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
  fresh: boolean
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
  // the entries only answers as a parent brought, never a read that asked
  // for them, which go once nothing keeps them (take)
  const parentOnly = new Set<string>()
  // the facts navigation rows seeded for projects with no row yet, oldest
  // first (seed)
  const seeds = new Map<string, ProjectSeed>()
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
  // the socket's connection count of the newest transition the cache heard
  let connection: number | null = null

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

  /** Drops project `id`'s row and seed. */
  function forget(id: string) {
    entries.delete(id)
    parentOnly.delete(id)
    seeds.delete(id)
  }

  /** Whether an owner names `id`, or it is one of `parents` (namedParents,
      keptParents). */
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

  /** The parents of every row the cache keeps. */
  function keptParents(): Set<string> {
    const out = new Set<string>()
    for (const row of entries.values()) if (row.parent_id) out.add(row.parent_id)
    return out
  }

  /** Drops the entries past PROJECT_CACHE.most, the least recently shown
      first, never one an owner names or the parent of one. */
  function bound() {
    for (const id of seeds.keys()) {
      if (seeds.size <= PROJECT_CACHE.most) break
      if (namedCount.has(id)) continue
      seeds.delete(id)
      touch()
    }
    if (entries.size <= PROJECT_CACHE.most) return
    const parents = namedParents()
    for (const id of entries.keys()) {
      if (entries.size <= PROJECT_CACHE.most) return
      if (isNamed(id, parents)) continue
      forget(id)
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
      if (chunk.result !== 'failed' || !chunk.fresh) {
        chunk.result = 'failed'
        chunk.fresh = true
        touch()
      }
      return
    }
    if (!answer) return
    const asked = new Set(sub.ids)
    const unchecked = new Map(answer.unchecked.map((id) => [id, answer.message ?? '']))
    for (const row of answer.rows) {
      if (asked.has(row.id)) parentOnly.delete(row.id)
      else if (!entries.has(row.id)) parentOnly.add(row.id)
      if (seeds.delete(row.id)) touch()
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
    if (same && chunk.fresh) return
    chunk.result = { asked, rows, unchecked }
    chunk.fresh = true
    touch()
    // a project this answer makes gone, one it asked or a parent row it
    // stopped bringing, keeps no row, so no lookup names it from an
    // earlier answer
    const dropped = before && before !== 'failed' ? [...before.rows.keys()] : []
    const parentsOfGone: string[] = []
    for (const id of new Set([...asked, ...dropped])) {
      const row = entries.get(id)
      if ((!row && !seeds.has(id)) || lookUp(id).state !== 'gone') continue
      forget(id)
      if (row?.parent_id) parentsOfGone.push(row.parent_id)
    }
    // and so does a parent row it stopped bringing, or the parent of a
    // project it made gone, that only answers as a parent ever brought,
    // while no owner names it, no chunk reads it, no kept row names it as
    // its parent and no current answer holds it, since nothing the cache
    // keeps would bring it again. A project a read asked for keeps its row
    // for the bound once its owners let it go, and so does its parent.
    const parents = keptParents()
    for (const id of new Set([...dropped, ...parentsOfGone]))
      if (
        parentOnly.has(id) &&
        !chunkOf.has(id) &&
        !isNamed(id, parents) &&
        currentRow(id) === undefined
      )
        forget(id)
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
      transition brings repaint once. A transition of a newer connection
      first makes every chunk's answer stale until its read answers again
      (Chunk `fresh`), and each read a transition names records its
      connection (Sub `answeredOn`). */
  function listen() {
    stopTransitions ??= deps.live.onTransition(
      (transition) => {
        if (connection !== null && transition.connection !== connection)
          for (const chunk of chunks) {
            if (chunk.result === null || !chunk.fresh) continue
            chunk.fresh = false
            touch()
          }
        connection = transition.connection
        for (const chunk of chunks)
          for (const sub of [chunk.sub, chunk.next])
            if (sub && transition.tokens.has(sub.token)) sub.answeredOn = transition.connection
        for (const chunk of chunks) {
          if (chunk.next && transition.tokens.has(chunk.next.token)) promote(chunk)
          if (chunk.sub && transition.tokens.has(chunk.sub.token)) take(chunk)
        }
        flush()
      },
      { view: true },
    )
  }

  /** A live read of `ids`, `joined` when it shares the token of another
      chunk's read whose answer arrived on the newest connection the cache
      heard. The transport says `joined` of an answer from any connection
      (lib/liveQueries.ts), so a read that joins one answered before a
      reconnect waits for the transition that brings its answer again. */
  function watchIds(ids: readonly string[]): { sub: Sub; joined: boolean } {
    listen()
    const w = deps.live.watch(QUERY, { ids: [...ids] } as Record<string, Value>)
    const answeredOn =
      chunks.flatMap((chunk) => [chunk.sub, chunk.next]).find((sub) => sub?.token === w.token)
        ?.answeredOn ?? null
    return {
      sub: { token: w.token, stop: w.stop, ids: [...ids], args: JSON.stringify(ids), answeredOn },
      joined: w.joined && answeredOn !== null && answeredOn === connection,
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

  /** Brings the chunks in line with the projects the owners name now. */
  function sync() {
    const wanted = new Set<string>()
    for (const ids of owners.values()) for (const id of ids) wanted.add(id)
    const changed = new Set<Chunk>()
    // an id no owner names leaves its chunk
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
        last = { ids: [], sub: null, next: null, result: null, fresh: false }
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

  /** The answer of `chunk` that counts now, the one that arrived on the
      newest connection, else none. */
  const currentOf = (chunk: Chunk | undefined) => (chunk?.fresh ? chunk.result : null)

  /** The current answer's row of project `id`, from its own chunk or, for a
      parent another chunk's sub-project brought, from any chunk. */
  function currentRow(id: string): NavByIdRow | undefined {
    const own = currentOf(chunkOf.get(id))
    if (own && own !== 'failed') {
      const row = own.rows.get(id)
      if (row) return row
    }
    for (const chunk of chunks) {
      const result = currentOf(chunk)
      if (result && result !== 'failed') {
        const row = result.rows.get(id)
        if (row) return row
      }
    }
    return undefined
  }

  /** What the cache knows of `id`, worked out (look keeps the answers). A
      chunk whose answer arrived before a reconnect answers for none of its
      ids until it answers again, so they load, keeping their rows. */
  function lookUp(id: string): CachedProject {
    const row = currentRow(id)
    if (row) return { state: 'ok', row, message: null }
    const kept = entries.get(id) ?? null
    const result = currentOf(chunkOf.get(id))
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
    /** Brings the reads in line with the projects the owners name, as after
        clear, whose registrations stay while their views stay mounted, so
        the store's next rebuild reads them again for the new session. */
    sync() {
      if (owners.size === 0) return
      sync()
      flush()
    },
    /** Reads owner `owner`'s projects again from fresh subscriptions where
        their chunk's read failed or listed one of them apart, as a Retry
        asks: Convex keeps no failed run, and a check a bound stopped may
        finish now. A failed chunk starts again with no answer. A chunk that
        holds an answer keeps it, so its other projects keep their state
        and levels, while a fresh run of its ids reads as the chunk's next
        read, which takes over once it answers (promote), as follow() keeps
        an answered read. */
    retry(owner: string) {
      const ids = owners.get(owner)
      if (!ids) return
      const again = new Set<Chunk>()
      for (const id of ids) {
        const chunk = chunkOf.get(id)
        if (!chunk) continue
        const result = chunk.result
        if (result === 'failed' || result?.unchecked.has(id)) again.add(chunk)
      }
      for (const chunk of again) {
        chunk.next?.stop()
        chunk.next = null
        if (chunk.result !== null && chunk.result !== 'failed' && chunk.sub && visible) {
          // a fresh run of the chunk's ids, which Convex runs again also
          // where the answered read shares its subscription
          listen()
          const w = deps.live.watch(QUERY, { ids: [...chunk.ids] } as Record<string, Value>, {
            fresh: true,
          })
          chunk.next = {
            token: w.token,
            stop: w.stop,
            ids: [...chunk.ids],
            args: JSON.stringify(chunk.ids),
            answeredOn: null,
          }
          continue
        }
        chunk.sub?.stop()
        chunk.sub = null
        chunk.result = null
        chunk.fresh = false
        touch()
        follow(chunk)
      }
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
    /** The seeds of projects the cache keeps no row for yet. */
    seeds(): ProjectSeed[] {
      return [...seeds.values()]
    },
    /** The seed of project `id` while the cache keeps no row for it. */
    seedOf: (id: string): ProjectSeed | undefined => seeds.get(id),
    /** Seeds the facts of `list`, projects a navigation row showed, where
        the cache keeps no row for them, a later seed replacing an earlier
        one. A seed reads as `loading` until an answer brings the
        project's row or leaves it out. A project the current answer left
        out (`gone`) takes no seed, so no lookup names it from a row that
        showed it before. */
    seed(list: readonly ProjectSeed[]) {
      for (const s of list) {
        if (entries.has(s.id) || lookUp(s.id).state === 'gone') continue
        const was = seeds.get(s.id)
        if (
          was &&
          was.org_id === s.org_id &&
          was.name === s.name &&
          was.num === s.num &&
          was.parent_id === s.parent_id
        )
          continue
        seeds.delete(s.id)
        seeds.set(s.id, { ...s })
        touch()
      }
      bound()
      flush()
    },
    /** Turns on every change of an entry or a state. */
    version: () => revision,
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
      parentOnly.clear()
      seeds.clear()
      looks.clear()
      stopTransitions?.()
      stopTransitions = null
      connection = null
      revision++
      dirty = false
    },
  }
}

export type ProjectCache = ReturnType<typeof createProjectCache>

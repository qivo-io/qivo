/* The people the open views show that the workspace's people part does
   not hold, read by id from the server (convex/people.ts byIds) and kept in
   one bounded cache, so every place that shows another person can name and
   paint them (store/planner.ts P.person).

   - A view names the people its loaded rows show (`name`), by organization
     and id in its rows' order, under its own key, and releases them when it
     closes or a kept page hides (components/usePeople.ts). Owners only name
     ids; the cache owns the reads.
   - For the named people the workspace does not hold, the cache keeps live
     people.byIds reads of each organization's ids, BY_IDS_MAX a chunk, in
     the order the views first named them. A new id joins the last chunk,
     or a new one when that is full, so a list that loads more changes only
     its last chunk, and a reorder of a view's rows changes none. Each id
     sits in one chunk at a time, whatever the number of views naming it. An
     id no view names any more, or one the workspace now holds, leaves its
     chunk. Every read stops while the page is hidden and starts again on
     return.
   - An answer keeps each row as the person's face. An id the current answer
     of its chunk leaves out is `gone`, and its face goes, while that answer
     is current; a chunk whose read restarts holds no answer until the new
     one arrives. A failed chunk marks its ids `failed`, except those that
     hold a face or a name, which stay as they are.
   - A picker's rows and picks are taken as names (`take`), which name a
     person at once until a face arrives and never replace one.
   - `look` answers a person from the cache without marking anything, so a
     render, also one of a hidden kept page, changes no order.
   - "Shown" means named by an open view. A released entry keeps the moment
     its last view let it go. Past PROFILE_CACHE.most entries the cache
     drops the one shown least recently that no view names, so an open view
     never loses a person it shows, and past the design size the cache holds
     what open views name and nothing more.
   - `version` turns on every change of an entry or a state, never on a
     registration that names the same people, so a render that names its
     people does not render itself again. */

import type { FunctionReference } from 'convex/server'
import type { Value } from 'convex/values'
import { api } from '../../convex/_generated/api'
import { BY_IDS_MAX } from '../../convex/lib/limits'
import type { PersonFaceRow } from '../../convex/model/peopleSettings'
import type { PersonRow } from '../../convex/model/projectSettings'
import type { LiveQueries } from '../lib/liveQueries'
import type { Visibility } from '../lib/viewVisibility'

/** The most entries the cache keeps, the named ones among them; past it
    only entries an open view names stay. The design size's 1,000 people
    of one organization fit, so an organization at the design size never
    drops a person a view shows. Tests lower it.
    Measured on the benchmark page (scripts/perf, people=1000 with
    unheldpeople=50 and pictures=1, 1440 by 1000, 7 November 2026): the
    Board named 101 people and read the 2 the workspace did not hold in one
    people.byIds read, and Settings › Users searched for "99" named 19 and
    read the 10 it did not hold in one read. 1,000 people a view names are
    read in 10 reads of 100 ids, each id once (profileCache.test.ts). */
export const PROFILE_CACHE = { most: 1_000 }

/** A person a view names: the organization to ask and the profile id. */
export type NamedPerson = { org: string; id: string }

/** What the cache knows of one person: their face (a people.byIds row),
    their name from a picker's answer, or no row yet (`loading`), a read
    that failed (`failed`) or a current answer that left them out
    (`gone`). */
export type CachedPerson =
  | { state: 'face'; org: string; face: PersonFaceRow }
  | { state: 'name'; org: string; name: PersonRow }
  | { state: 'loading' | 'failed' | 'gone' }

/** What the cache needs from the store and the transport. */
export type ProfileCacheDeps = {
  live: Pick<LiveQueries, 'watch' | 'read' | 'onTransition'>
  /** Whether the workspace's people part holds person `id` of `org`. */
  held: (org: string, id: string) => boolean
  /** Called once after a transition, a registration or a take that changed
      an entry or a state, so the store repaints. */
  changed: () => void
  /** Called once after the people the views name changed, so the store
      follows them with its pictures. */
  namedChanged?: () => void
  /** The hidden-tab gate (lib/viewVisibility.ts watchVisibility). */
  watchVisibility: (listener: (visibility: Visibility) => void) => () => void
}

const QUERY = api.people.byIds as FunctionReference<'query'>

type Entry = { org: string; face?: PersonFaceRow; name?: PersonRow }

/** One live read: an organization's ids in the order first named, its
    subscription while the page shows, and its current answer, the ids it
    held, `failed`, or null while it has none. */
type Chunk = {
  org: string
  ids: string[]
  sub: { token: string; stop: () => void; args: string } | null
  result: Set<string> | 'failed' | null
}

/** Creates the cache over `deps`. */
export function createProfileCache(deps: ProfileCacheDeps) {
  // the people each view names, by its key, in the order views first named
  const owners = new Map<string, readonly NamedPerson[]>()
  // how many views name each id
  let namedCount = new Map<string, number>()
  // the entries, the least recently shown first (Map order)
  const entries = new Map<string, Entry>()
  // the chunks of each organization, oldest first, and the chunk of each id
  const chunks = new Map<string, Chunk[]>()
  const chunkOf = new Map<string, Chunk>()
  let visible = true
  let revision = 0
  let dirty = false
  let stopTransitions: (() => void) | null = null
  // whether the cache follows the hidden-tab gate, which it does from the
  // first registration for as long as the store lives
  let watching = false

  const touch = () => {
    revision++
    dirty = true
  }

  /** Tells the store once that an entry or a state changed. */
  function flush() {
    if (!dirty) return
    dirty = false
    deps.changed()
  }

  /** Drops the entries past PROFILE_CACHE.most, the least recently shown
      first, never one a view names. */
  function bound() {
    if (entries.size <= PROFILE_CACHE.most) return
    for (const id of entries.keys()) {
      if (entries.size <= PROFILE_CACHE.most) return
      if (namedCount.has(id)) continue
      entries.delete(id)
      touch()
    }
  }

  /** Takes in chunk `chunk`'s result from the transport. */
  function take(chunk: Chunk) {
    const sub = chunk.sub
    if (!sub) return
    let rows: PersonFaceRow[] | undefined
    try {
      rows = (deps.live.read(sub.token) as { rows: PersonFaceRow[] } | undefined)?.rows
    } catch {
      if (chunk.result !== 'failed') {
        chunk.result = 'failed'
        touch()
      }
      return
    }
    if (!rows) return
    const answered = new Set<string>()
    for (const row of rows) {
      if (chunkOf.get(row.id) !== chunk) continue
      answered.add(row.id)
      const was = entries.get(row.id)
      if (was?.face && JSON.stringify(was.face) === JSON.stringify(row)) continue
      entries.set(row.id, { org: chunk.org, face: row })
      touch()
    }
    // a person the current answer leaves out is not one of the organization
    for (const id of chunk.ids) if (!answered.has(id) && entries.delete(id)) touch()
    const same =
      chunk.result instanceof Set &&
      chunk.result.size === answered.size &&
      [...answered].every((id) => (chunk.result as Set<string>).has(id))
    if (!same) {
      chunk.result = answered
      touch()
    }
    bound()
  }

  /** Hears every transition once for every chunk, so the answers one
      transition brings repaint once. */
  function listen() {
    stopTransitions ??= deps.live.onTransition(
      (transition) => {
        for (const list of chunks.values())
          for (const chunk of list)
            if (chunk.sub && transition.tokens.has(chunk.sub.token)) take(chunk)
        flush()
      },
      { view: true },
    )
  }

  /** Starts, restarts or stops `chunk`'s read to match its ids and the
      page's visibility. */
  function follow(chunk: Chunk) {
    const args = JSON.stringify(chunk.ids)
    if (chunk.sub && (!visible || chunk.sub.args !== args || chunk.ids.length === 0)) {
      chunk.sub.stop()
      chunk.sub = null
      if (chunk.result !== null) {
        chunk.result = null
        touch()
      }
    }
    if (chunk.sub || !visible || chunk.ids.length === 0) return
    listen()
    const w = deps.live.watch(QUERY, { org_id: chunk.org, ids: chunk.ids } as Record<string, Value>)
    chunk.sub = { token: w.token, stop: w.stop, args }
    if (w.joined) take(chunk)
  }

  /** Brings the chunks in line with the people the views name now and the
      people the workspace holds. */
  function sync() {
    const wanted = new Map<string, NamedPerson>()
    for (const people of owners.values())
      for (const person of people)
        if (!wanted.has(person.id) && !deps.held(person.org, person.id))
          wanted.set(person.id, person)
    const changed = new Set<Chunk>()
    // an id no view names, or one the workspace holds now, leaves its chunk
    for (const [id, chunk] of chunkOf) {
      const want = wanted.get(id)
      if (want && want.org === chunk.org) continue
      chunk.ids = chunk.ids.filter((x) => x !== id)
      chunkOf.delete(id)
      changed.add(chunk)
    }
    // a new id joins its organization's last chunk, or a new one
    for (const [id, person] of wanted) {
      if (chunkOf.has(id)) continue
      const list = chunks.get(person.org) ?? []
      chunks.set(person.org, list)
      let last = list.at(-1)
      if (!last || last.ids.length >= BY_IDS_MAX) {
        last = { org: person.org, ids: [], sub: null, result: null }
        list.push(last)
      }
      last.ids.push(id)
      chunkOf.set(id, last)
      changed.add(last)
    }
    for (const [org, list] of chunks) {
      const kept = list.filter((chunk) => chunk.ids.length > 0)
      for (const chunk of list) if (chunk.ids.length === 0) follow(chunk)
      if (kept.length === 0) chunks.delete(org)
      else if (kept.length !== list.length) chunks.set(org, kept)
    }
    for (const chunk of changed) follow(chunk)
  }

  /** Follows the hidden-tab gate from the first registration on. */
  function watchPage() {
    if (watching) return
    watching = true
    deps.watchVisibility((now) => {
      if (now.visible === visible) return
      visible = now.visible
      for (const list of chunks.values()) for (const chunk of list) follow(chunk)
      flush()
    })
  }

  /** Counts each named id once a view, and answers whether the named
      people changed. */
  function recount(): boolean {
    const next = new Map<string, number>()
    for (const people of owners.values()) {
      const seen = new Set<string>()
      for (const { id } of people) {
        if (seen.has(id)) continue
        seen.add(id)
        next.set(id, (next.get(id) ?? 0) + 1)
      }
    }
    // a released entry keeps the moment its last view let it go
    for (const id of namedCount.keys()) {
      if (next.has(id)) continue
      const entry = entries.get(id)
      if (!entry) continue
      entries.delete(id)
      entries.set(id, entry)
    }
    const same = next.size === namedCount.size && [...next.keys()].every((id) => namedCount.has(id))
    namedCount = next
    return !same
  }

  const sameList = (a: readonly NamedPerson[], b: readonly NamedPerson[]) =>
    a.length === b.length && a.every((p, i) => p.id === b[i]?.id && p.org === b[i]?.org)

  return {
    /** Names `people` under view `owner`, in its rows' order, replacing
        what it named before; an empty list releases them. */
    name(owner: string, people: readonly NamedPerson[]) {
      const was = owners.get(owner)
      if (people.length === 0) {
        if (!was) return
        owners.delete(owner)
      } else {
        if (was && sameList(was, people)) return
        // a view keeps the place it first named in
        owners.set(owner, [...people])
      }
      watchPage()
      const namedNow = recount()
      sync()
      bound()
      if (namedNow) deps.namedChanged?.()
      flush()
    },
    /** Every named person once, the view registered most recently first and
        each view in its own order, which orders the wanted pictures. */
    named(): NamedPerson[] {
      const out: NamedPerson[] = []
      const seen = new Set<string>()
      for (const people of [...owners.values()].reverse())
        for (const person of people) {
          if (seen.has(person.id)) continue
          seen.add(person.id)
          out.push(person)
        }
      return out
    },
    /** Whether an open view names person `id`. */
    isNamed: (id: string) => namedCount.has(id),
    /** Keeps the person rows of a picker's answer or pick in organization
        `org` as names, which never replace a face. */
    take(org: string, rows: readonly PersonRow[]) {
      for (const row of rows) {
        if (deps.held(org, row.id)) continue
        const was = entries.get(row.id)
        if (was?.face) continue
        if (was?.name && JSON.stringify(was.name) === JSON.stringify(row)) continue
        entries.delete(row.id)
        entries.set(row.id, {
          org,
          name: {
            id: row.id,
            name: row.name,
            org_role: row.org_role,
            kind: row.kind,
            active: row.active,
            pending: row.pending,
          },
        })
        touch()
      }
      bound()
      flush()
    },
    /** What the cache knows of person `id`, marking nothing. */
    look(id: string): CachedPerson {
      const chunk = chunkOf.get(id)
      if (chunk && chunk.result instanceof Set && !chunk.result.has(id)) return { state: 'gone' }
      const entry = entries.get(id)
      if (entry?.face) return { state: 'face', org: entry.org, face: entry.face }
      if (entry?.name) return { state: 'name', org: entry.org, name: entry.name }
      if (chunk?.result === 'failed') return { state: 'failed' }
      return { state: 'loading' }
    },
    /** Every face the cache holds, for the store's view models and its
        pictures. */
    faces(): { org: string; face: PersonFaceRow }[] {
      const out: { org: string; face: PersonFaceRow }[] = []
      for (const entry of entries.values())
        if (entry.face) out.push({ org: entry.org, face: entry.face })
      return out
    },
    /** Every name without a face the cache holds, for the store's views. */
    names(): { org: string; name: PersonRow }[] {
      const out: { org: string; name: PersonRow }[] = []
      for (const entry of entries.values())
        if (entry.name && !entry.face) out.push({ org: entry.org, name: entry.name })
      return out
    },
    /** Turns on every change of an entry or a state. */
    version: () => revision,
    /** Follows a change of the people the workspace holds: an id it holds
        now leaves its chunk, and one it no longer holds is read. */
    sync() {
      if (owners.size === 0) return
      sync()
      flush()
    },
    /** The live reads now, each organization's chunks in order, for the
        tests and the measurement. */
    reads(): { org: string; ids: string[] }[] {
      const out: { org: string; ids: string[] }[] = []
      for (const list of chunks.values())
        for (const chunk of list) if (chunk.sub) out.push({ org: chunk.org, ids: [...chunk.ids] })
      return out
    },
    /** How many entries the cache holds, for the tests and the measurement. */
    size: () => entries.size,
    /** Empties the cache and stops its reads, for sign-out, a demo's end and
        reinitialization. The views' registrations stay, since a view that
        stays mounted names the same people, and the store's next `sync`
        reads them again for the new session. */
    clear() {
      for (const list of chunks.values())
        for (const chunk of list) {
          chunk.sub?.stop()
          chunk.sub = null
        }
      chunks.clear()
      chunkOf.clear()
      entries.clear()
      stopTransitions?.()
      stopTransitions = null
      revision++
      dirty = false
    },
  }
}

export type ProfileCache = ReturnType<typeof createProfileCache>

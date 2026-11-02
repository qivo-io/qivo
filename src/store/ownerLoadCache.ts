/* One cache of people's loads, read live through planning.ownerLoads
   (convex/planning.ts), for the delays of tasks the workspace does not
   hold: today the Board's cards a view's answer brings (store/planner.ts
   viewDelay), later the task window and the Roadmap.

   - A view registers the owners whose loads its cards need, by
     organization, and releases them when it closes. The cache subscribes
     only to what some view needs while it reads, and stops the rest. A view
     whose read stops, as a kept page that hides, keeps its owners' last
     answers, which its delays read, unmarked, until the calls answer again.
     The Board's refreshing state covers only the wait for its own answer.
   - A call names one organization. For the person's own staff seat there
     (an admin or user, convex/lib/access.ts isOrgStaff) the owners go into
     calls of at most CALL_OWNERS, each owner in a fixed group by a hash of
     its id, and a change to one owner's spans sends that owner's call
     again, not all of them. The groups are the fewest that hold the
     owners, a power of two, so 1,000 owners make 64 groups, about 64 calls
     (a group the hash fills past CALL_OWNERS is cut into calls of at most
     CALL_OWNERS each, in id order). One new owner usually changes one
     call. In a cut group it changes the calls from its own to the group's
     last, and when the owners pass CALL_OWNERS times the groups, the
     groups double and almost every call changes. A guest or Viewer gets
     one owner a call (the server answers one), and a view gets at most
     GUEST_CALLS of those, its owners with the most cards first; the others
     are `capped`.
   - An owner a call answered `not_read` (its room ran out) is asked again in
     a call of its own owners, which the server always starts reading.
   - The cache follows the hidden-tab gate (lib/viewVisibility.ts): while the
     page is hidden it holds no subscription, and it keeps each owner's last
     answer, which the views read as it is until the calls answer again.
   - An owner's state is `waiting` until its first answer, then `ok` with its
     spans, `unavailable` (past the reader's bounds), `failed` (the call
     failed) or `capped`. None of them but `ok` is a load: the delay rules
     never read missing work as free time (src/lib/delay.ts). */

import type { FunctionReference } from 'convex/server'
import type { Value } from 'convex/values'
import { api } from '../../convex/_generated/api'
import type { OwnerLoadsJson } from '../../convex/planning'
import { isoToWeek, TIMELINE_START, tsToWeek } from '../lib/dates'
import type { LiveQueries } from '../lib/liveQueries'
import type { Visibility } from '../lib/viewVisibility'
import type { LoadSpan } from '../lib/workload'

/** The most owners one staff call names. */
export const CALL_OWNERS = 25
/** The most owner calls one view holds for a guest or Viewer. */
export const GUEST_CALLS = 50

/** What the cache knows of one owner's load. */
export type OwnerLoad =
  | { state: 'waiting' }
  | { state: 'ok'; spans: readonly LoadSpan[]; hidden: OwnerLoadsJson['hidden'] }
  | { state: 'unavailable' | 'failed' | 'capped' }

/** An owner a view's cards need, with how many cards, which orders a
    guest's or Viewer's calls under the cap. */
export type OwnerNeed = { org: string; owner: string; cards: number }

/** What the cache needs from the store and the transport. */
export type OwnerLoadDeps = {
  live: Pick<LiveQueries, 'watch' | 'read' | 'onTransition'>
  /** Whether the person's own seat in organization `org` is staff. */
  staffIn: (org: string) => boolean
  /** Called once after the answers of one transition, or a change of what
      the views need, changed any owner's load or the cap. */
  changed: () => void
  /** The hidden-tab gate (lib/viewVisibility.ts watchVisibility). */
  watchVisibility: (listener: (visibility: Visibility) => void) => () => void
}

const QUERY = api.planning.ownerLoads as FunctionReference<'query'>

/* FNV-1a of `s`, an owner's fixed group. */
function fnv(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

const keyOf = (org: string, owner: string) => `${org}\u0000${owner.toLowerCase()}`

/** One planning.ownerLoads call: its organization and owners, in a fixed
    order, and what it last answered. */
type Call = { org: string; owners: string[] }

/** The calls a staff seat makes for `owners` of one organization: groups of
    at most CALL_OWNERS by hash, among the fewest groups, a power of two,
    that hold them. */
export function staffCalls(org: string, owners: readonly string[]): Call[] {
  let groups = 1
  while (groups * CALL_OWNERS < owners.length) groups *= 2
  const out: string[][] = Array.from({ length: groups }, () => [])
  for (const owner of [...owners].sort())
    (out[fnv(owner.toLowerCase()) % groups] as string[]).push(owner)
  // a hash can fill a group past CALL_OWNERS; such a group is cut into calls
  // of at most CALL_OWNERS each
  const calls: Call[] = []
  for (const group of out) {
    for (let i = 0; i < group.length; i += CALL_OWNERS)
      calls.push({ org, owners: group.slice(i, i + CALL_OWNERS) })
  }
  return calls.filter((call) => call.owners.length > 0)
}

/** One owner's spans as an answer sends them, in ISO weeks and stamps. */
type AnswerSpans = Extract<OwnerLoadsJson['owners'][number], { state: 'ok' }>['spans']

/** What one owner of a planning.ownerLoads answer says, as the views read
    it, or null for `not_read`, which is no answer. */
export function ownerLoadOf(
  one: OwnerLoadsJson['owners'][number],
  hidden: OwnerLoadsJson['hidden'],
): OwnerLoad | null {
  if (one.state === 'not_read') return null
  return one.state === 'ok'
    ? { state: 'ok', spans: spansOf(one.spans), hidden }
    : { state: 'unavailable' }
}

/** The spans of one owner of an answer, as the app's load spans on the week
    grid of now. */
const spansOf = (spans: AnswerSpans) =>
  spans.map(
    (span): LoadSpan => ({
      issueUuid: span.issue_id,
      start: isoToWeek(span.start_week),
      end: isoToWeek(span.end_week),
      remaining: Number(span.remaining),
      remainingSet: span.remaining_set_at != null ? tsToWeek(span.remaining_set_at) : null,
    }),
  )

/** What the cache keeps of one owner's answer: an ok answer's spans as the
    server sent them, so they convert on the week grid of the moment they
    are read (loadOf). */
type Kept =
  | { state: 'ok'; spans: AnswerSpans; hidden: OwnerLoadsJson['hidden'] }
  | { state: 'unavailable' | 'failed' }

/** Creates the cache over `deps`. */
export function createOwnerLoadCache(deps: OwnerLoadDeps) {
  // what each view needs, and whether it reads now
  const needs = new Map<string, { owners: OwnerNeed[]; live: boolean }>()
  // each owner's last answer, kept while the page hides
  const loads = new Map<string, Kept>()
  // each kept ok answer converted on the grid it was last read on
  const converted = new Map<string, { kept: Kept; grid: number; load: OwnerLoad }>()
  // the owners past a guest's or Viewer's cap in every view that needs them
  let capped = new Set<string>()
  // the live calls by key: the call, its transport token and stop, and the
  // owners its last answer did not read
  const subs = new Map<
    string,
    { call: Call; token: string; stop: () => void; notRead: string[] | null }
  >()
  let visible = true
  // sync() runs again once it ends when an answer it took asks for it
  let syncing = false
  let again = false
  // whether an owner's load or the cap changed since the views were told
  // (flush), so one transition or sync tells them once
  let dirty = false
  // the one transition handler every call's answers come through
  let stopTransitions: (() => void) | null = null

  const callKey = (call: Call) => `${call.org}\u0000${call.owners.join(',')}`

  /** Tells the views once that loads changed, outside a sync. */
  function flush() {
    if (!dirty || syncing) return
    dirty = false
    deps.changed()
  }

  /** Takes in call `call`'s result from the transport. Answers whether any
      owner's load changed, and the owners it answered not_read. */
  function take(call: Call, token: string): { changed: boolean; notRead: string[] } {
    let answer: OwnerLoadsJson | undefined
    let failed = false
    try {
      answer = deps.live.read(token) as OwnerLoadsJson | undefined
    } catch {
      failed = true
    }
    let changed = false
    const notRead: string[] = []
    const set = (owner: string, load: Kept) => {
      const key = keyOf(call.org, owner)
      const was = loads.get(key)
      if (was && JSON.stringify(was) === JSON.stringify(load)) return
      loads.set(key, load)
      changed = true
    }
    if (failed) {
      for (const owner of call.owners) set(owner, { state: 'failed' })
      return { changed, notRead }
    }
    if (!answer) return { changed, notRead }
    // the server answers each owner once, in lowercase, in the order asked
    const byOwner = new Map(answer.owners.map((o) => [o.owner_id.toLowerCase(), o]))
    for (const owner of call.owners) {
      const one = byOwner.get(owner.toLowerCase())
      if (!one || one.state === 'not_read') notRead.push(owner)
      else
        set(
          owner,
          one.state === 'ok'
            ? { state: 'ok', spans: one.spans, hidden: answer.hidden }
            : { state: 'unavailable' },
        )
    }
    return { changed, notRead }
  }

  /** Subscribes to `call` unless it is live already, keeping `keep`. */
  function watch(call: Call, keep: Set<string>) {
    const key = callKey(call)
    keep.add(key)
    if (subs.has(key)) {
      const sub = subs.get(key)
      // the owners it answered not_read, asked again in a call of their own
      if (sub?.notRead?.length) watch({ org: call.org, owners: sub.notRead }, keep)
      return
    }
    listen()
    const args: Record<string, Value> = { org_id: call.org, owner_ids: call.owners }
    const w = deps.live.watch(QUERY, args)
    const sub = { call, token: w.token, stop: w.stop, notRead: null as string[] | null }
    subs.set(key, sub)
    // a result the transport holds already, taken in the sync under way
    if (w.joined && answered(sub)) again = true
  }

  /** Takes in `sub`'s result. Answers whether the owners it did not read
      changed, which the live calls follow (sync). */
  function answered(sub: { call: Call; token: string; notRead: string[] | null }): boolean {
    const { changed, notRead } = take(sub.call, sub.token)
    if (changed) dirty = true
    const was = sub.notRead?.join() ?? ''
    sub.notRead = notRead
    return notRead.join() !== was
  }

  /** Hears every transition once for all the calls, so the answers one
      transition brings repaint the views once. */
  function listen() {
    stopTransitions ??= deps.live.onTransition(
      (transition) => {
        let resync = false
        for (const sub of subs.values())
          if (transition.tokens.has(sub.token) && answered(sub)) resync = true
        if (resync) sync()
        else flush()
      },
      { view: true },
    )
  }

  /** Brings the live calls in line with what the views need now. */
  function sync() {
    if (syncing) {
      again = true
      return
    }
    syncing = true
    try {
      do {
        again = false
        syncOnce()
      } while (again)
    } finally {
      syncing = false
    }
    flush()
  }

  function syncOnce() {
    // every owner a view needs, by organization, and the guest's caps
    const wanted = new Map<string, Map<string, number>>()
    const guestKept = new Set<string>()
    const guestSeen = new Set<string>()
    for (const { owners: list, live } of needs.values()) {
      if (!live) continue
      const guests = list.filter((need) => !deps.staffIn(need.org))
      // most cards first, then by id, so the cap keeps the same owners
      guests.sort((a, b) => b.cards - a.cards || (a.owner < b.owner ? -1 : 1))
      guests.forEach((need, i) => {
        guestSeen.add(keyOf(need.org, need.owner))
        if (i < GUEST_CALLS) guestKept.add(keyOf(need.org, need.owner))
      })
      for (const need of list) {
        if (!deps.staffIn(need.org) && !guestKept.has(keyOf(need.org, need.owner))) continue
        const org = wanted.get(need.org) ?? new Map<string, number>()
        org.set(need.owner, (org.get(need.owner) ?? 0) + need.cards)
        wanted.set(need.org, org)
      }
    }
    const nowCapped = new Set([...guestSeen].filter((key) => !guestKept.has(key)))
    const cappedChanged =
      nowCapped.size !== capped.size || [...nowCapped].some((key) => !capped.has(key))
    capped = nowCapped
    const keep = new Set<string>()
    if (visible)
      for (const [org, owners] of wanted) {
        const ids = [...owners.keys()]
        const calls = deps.staffIn(org)
          ? staffCalls(org, ids)
          : ids.sort().map((owner) => ({ org, owners: [owner] }))
        for (const call of calls) watch(call, keep)
      }
    for (const [key, sub] of subs)
      if (!keep.has(key)) {
        sub.stop()
        subs.delete(key)
      }
    // an owner no view needs any more is forgotten
    const needed = new Set<string>()
    for (const { owners: list } of needs.values())
      for (const need of list) needed.add(keyOf(need.org, need.owner))
    let forgot = false
    for (const key of loads.keys())
      if (!needed.has(key)) {
        loads.delete(key)
        converted.delete(key)
        forgot = true
      }
    if (cappedChanged || forgot) dirty = true
  }

  const stopVisibility = deps.watchVisibility((now) => {
    if (now.visible === visible) return
    visible = now.visible
    sync()
  })

  return {
    /** Registers what view `view` needs now, replacing what it registered
        before, and whether it reads now (`live`): a view that does not
        keeps its owners' last answers without reading them. */
    register(view: string, owners: readonly OwnerNeed[], live = true) {
      const was = needs.get(view)
      const same =
        was &&
        was.live === live &&
        was.owners.length === owners.length &&
        was.owners.every(
          (need, i) =>
            need.org === owners[i]?.org &&
            need.owner === owners[i]?.owner &&
            need.cards === owners[i]?.cards,
        )
      if (same) return
      needs.set(view, { owners: [...owners], live })
      sync()
    },
    /** Says whether view `view` reads now, keeping what it needs. */
    setLive(view: string, live: boolean) {
      const was = needs.get(view)
      if (!was || was.live === live) return
      needs.set(view, { ...was, live })
      sync()
    },
    /** Releases what view `view` needs. */
    release(view: string) {
      if (!needs.delete(view)) return
      sync()
    },
    /** Owner `owner` of organization `org`'s load as the cache knows it,
        its spans on the week grid of now: the same object while neither
        the answer nor the grid changed. */
    loadOf(org: string, owner: string): OwnerLoad {
      const key = keyOf(org, owner)
      if (capped.has(key)) return { state: 'capped' }
      const kept = loads.get(key)
      if (!kept) return { state: 'waiting' }
      if (kept.state !== 'ok') return kept
      const grid = TIMELINE_START.getTime()
      const was = converted.get(key)
      if (was?.kept === kept && was.grid === grid) return was.load
      const load: OwnerLoad = { state: 'ok', spans: spansOf(kept.spans), hidden: kept.hidden }
      converted.set(key, { kept, grid, load })
      return load
    },
    /** The calls live now, for tests and the report: organization and
        owners of each. */
    calls: (): Call[] => [...subs.values()].map((sub) => sub.call),
    /** Stops every call and forgets everything (a disposed store). */
    clear() {
      for (const sub of subs.values()) sub.stop()
      subs.clear()
      stopTransitions?.()
      stopTransitions = null
      dirty = false
      needs.clear()
      loads.clear()
      converted.clear()
      capped = new Set()
    },
    /** Stops following the gate (tests). */
    dispose() {
      stopVisibility()
    },
  }
}

export type OwnerLoadCache = ReturnType<typeof createOwnerLoadCache>

/* The workspace's live parts (convex/workspace.ts) as the store adopts
   them: once per Convex transition, all together (lib/liveQueries.ts).

   The registry subscribes to the root part, and for each organization it
   names to the catalog, the inbox, and windows of its task, people and
   project ids (convex/lib/idWindows.ts), as many as its counters say it
   fills. After each transition it
   tells the store (report) whether every part it needs holds a current
   answer. Only then is the workspace complete, joined from them
   (convex/lib/workspaceJoin.ts); otherwise the store keeps what it shows,
   and nothing a transition brought is dropped, since the next complete one
   holds it.

   - A window that answers `split` keeps serving while its two halves load,
     and gives way to them in the first complete transition that holds both.
   - A window that answers `overflow` has no rows to show, so the workspace
     waits for its pieces: as many as the answer names, else its halves
     (convex/lib/idWindows.ts piecesAfter).
   - A new seat's organization waits for its parts. A seat that
     goes leaves with the root part's answer, quietly.
   - After the socket reconnects, Convex sends every result again, and none
     counts until it arrived again.
   - A part that failed, or refused to load with a sentence, makes the
     workspace fail when nothing else can show its rows: a window that
     asked to be cut and then failed gives way to its pieces once they
     answer, and a piece's failure waits while its window still shows.
     Retry runs only the parts whose failure holds the workspace again.
   - A workspace that stays incomplete while online, with no part answering
     for STALL.ms, from the start on, fails, so a part that never answers shows instead of a
     frozen screen. Convex sends the first answers of parts subscribed
     together in one transition, so a large organization on a busy backend
     can take many seconds before anything arrives.

   One side query rides along, the open task's thread, so a transition that
   brings both repaints once. Its failure is its own and never holds the
   workspace. */

import type { FunctionReference } from 'convex/server'
import { ConvexError, type Value } from 'convex/values'
import { api } from '../../convex/_generated/api'
import {
  type IdWindow,
  idWindows,
  piecesAfter,
  WINDOW_ROWS,
  windowCount,
} from '../../convex/lib/idWindows'
import {
  type CatalogPart,
  type InboxPart,
  joinParts,
  type OrgParts,
  type PeoplePart,
  type ProjectsPart,
  partRows,
  type RootAnswer,
  type TasksPart,
  type Workspace,
} from '../../convex/lib/workspaceJoin'
import type { LiveQueries } from '../lib/liveQueries'

/** How long an incomplete workspace may go without any part answering
    while online before it fails. Tests lower it. */
export const STALL = { ms: 60_000 }

/** What the store hears after each transition, and when the workspace
    fails outside one. */
export type PartsReport = {
  /** the server time of the state, in ms */
  at: number
  workspace:
    | {
        state: 'complete'
        /** null when the caller holds no seat */
        value: Workspace | null
        /** whether any part changed since the last complete report */
        changed: boolean
      }
    | { state: 'held' }
    | { state: 'failed'; error: unknown }
  /** the side query's news, when this transition brought some */
  side?: { value: unknown } | { error: unknown }
}

type Kind = 'tasks' | 'people' | 'projects'
const KINDS: readonly Kind[] = ['tasks', 'people', 'projects']
const WINDOWED = {
  tasks: api.workspace.tasks,
  people: api.workspace.people,
  projects: api.workspace.projects,
} as const

/* One subscription and what the transitions brought it. */
type Slot = {
  token: string
  stop: () => void
  ref: FunctionReference<'query'>
  args: Record<string, Value>
  /** the latest answer, undefined before one arrived */
  value?: unknown
  error?: unknown
  /** whether the answer arrived since the socket last connected */
  fresh: boolean
}

/* A window of one kind, its own part, and the pieces it gives way to once
   it asked to be cut. */
type Node = IdWindow & { slot: Slot; pieces: Node[] | null }

/* What the registry holds for one organization. */
type Org = {
  id: string
  catalog: Slot
  inbox: Slot
  /** the windows of each kind */
  kinds: Record<Kind, Node[]>
}

/* An answer with rows of a part. */
type Answer = { state: string; split?: boolean; pieces?: number; message?: string }

const isAnswer = (value: unknown): value is Answer =>
  typeof value === 'object' && value !== null && 'state' in value

/** Creates a registry over `live` that reports to `report`. `online` says
    whether the stall check may fail the workspace, false while the socket
    is down or saves pause offline. */
export function createLiveParts(
  live: LiveQueries,
  report: (news: PartsReport) => void,
  online: () => boolean,
) {
  let stopped = false
  let connection: number | null = null
  const slots = new Map<string, Slot>()
  let root: Slot | null = null
  const orgs = new Map<string, Org>()
  // whether a part changed since the last complete report
  let dirty = true
  let side: Slot | null = null
  let lastAt = 0
  let stallTimer: ReturnType<typeof setTimeout> | null = null

  const watch = (ref: FunctionReference<'query'>, args: Record<string, Value>): Slot => {
    const { token, stop } = live.watch(ref, args)
    const slot: Slot = { token, stop, ref, args, fresh: false }
    slots.set(token, slot)
    return slot
  }
  const drop = (slot: Slot) => {
    slot.stop()
    if (slots.get(slot.token) === slot) slots.delete(slot.token)
  }

  const node = (orgId: string, kind: Kind, w: IdWindow): Node => ({
    ...w,
    slot: watch(WINDOWED[kind], { org_id: orgId, from: w.from, to: w.to }),
    pieces: null,
  })

  /** Brings the organizations in line with the root part's answer, and
      windows in line with their parts' answers. Answers
      whether anything changed. */
  function reconcile(): boolean {
    let moved = false
    const answer = root?.fresh && root.error === undefined ? (root.value as RootAnswer) : undefined
    if (answer === undefined) return false
    const wanted = new Set(answer === null ? [] : answer.orgs.map((org) => org.id))
    for (const [id, org] of orgs) {
      if (wanted.has(id)) continue
      for (const slot of orgSlots(org)) drop(slot)
      orgs.delete(id)
      moved = true
    }
    for (const row of answer === null ? [] : answer.orgs) {
      if (orgs.has(row.id)) continue
      // as many windows as the counters say the organization fills
      const count = (rows: number, kind: keyof typeof WINDOW_ROWS) =>
        idWindows(windowCount(rows, WINDOW_ROWS[kind]))
      const windows = (kind: Kind, list: IdWindow[]) => list.map((w) => node(row.id, kind, w))
      orgs.set(row.id, {
        id: row.id,
        catalog: watch(api.workspace.catalog, { org_id: row.id }),
        inbox: watch(api.workspace.inbox, { org_id: row.id }),
        kinds: {
          tasks: windows('tasks', count(row.next_issue_num, 'tasks')),
          people: windows('people', idWindows(1)),
          projects: windows('projects', count(row.next_project_num, 'projects')),
        },
      })
      moved = true
    }
    // a window that asked to be cut gets its pieces
    for (const org of orgs.values())
      for (const kind of KINDS)
        for (const n of nodesOf(org.kinds[kind]))
          if (n.pieces === null && n.slot.fresh && isAnswer(n.slot.value)) {
            const pieces = piecesAfter(n, n.slot.value)
            if (pieces) {
              n.pieces = pieces.map((w) => node(org.id, kind, w))
              moved = true
            }
          }
    return moved
  }

  /** Every node of `list`, pieces included. */
  function* nodesOf(list: readonly Node[]): Generator<Node> {
    for (const n of list) {
      yield n
      if (n.pieces) yield* nodesOf(n.pieces)
    }
  }
  function* orgSlots(org: Org): Generator<Slot> {
    yield org.catalog
    yield org.inbox
    for (const kind of KINDS) for (const n of nodesOf(org.kinds[kind])) yield n.slot
  }

  /** The rows of the part `slot` answered, or null without a current
      answer that has rows. */
  function rowsOfSlot<P>(slot: Slot): P | null {
    if (!slot.fresh || !isAnswer(slot.value) || slot.value.state !== 'ok') return null
    // the transport hands out the server's answer as it came
    return partRows(slot.value as Answer & { state: 'ok' }) as P
  }

  /** The rows of `n`'s window from its pieces when all are ready, else its
      own answer, or null while neither can show it. */
  function rowsOf<P>(n: Node): P[] | null {
    if (n.pieces) {
      const rows: P[] = []
      let ready = true
      for (const piece of n.pieces) {
        const got = ready ? rowsOf<P>(piece) : null
        if (got === null) ready = false
        else rows.push(...got)
      }
      if (ready) return rows
    }
    const own = rowsOfSlot<P>(n.slot)
    return own === null ? null : [own]
  }

  /** `list` with each window whose pieces are all ready replaced by
      them, as a complete transition just showed them. */
  function adoptPieces(list: readonly Node[]): Node[] {
    return list.flatMap((n) => {
      if (!n.pieces?.every((piece) => rowsOf(piece) !== null)) return [n]
      drop(n.slot)
      return adoptPieces(n.pieces)
    })
  }

  /** The error `slot` holds, a refusal as one, or undefined. */
  function errorOf(slot: Slot): unknown {
    if (slot.error !== undefined) return slot.error
    if (slot.fresh && isAnswer(slot.value) && slot.value.state === 'refused')
      return new ConvexError({ code: 'rule', message: slot.value.message })
    return undefined
  }

  /** The slots complete() needs an answer from: the root, each
      organization's catalog and inbox, and each window that shows its
      rows neither itself nor through its pieces (rowsOf), or, when it
      has pieces, the pieces that cannot. */
  function* needed(): Generator<Slot> {
    if (root) yield root
    for (const org of orgs.values()) {
      yield org.catalog
      yield org.inbox
      for (const kind of KINDS) for (const n of org.kinds[kind]) yield* neededIn(n)
    }
  }
  function* neededIn(n: Node): Generator<Slot> {
    if (rowsOf(n) !== null) return
    if (n.pieces === null) yield n.slot
    else for (const piece of n.pieces) yield* neededIn(piece)
  }

  /** The first error of a slot complete() needs, or undefined. */
  function failure(): unknown {
    for (const slot of needed()) {
      const error = errorOf(slot)
      if (error !== undefined) return error
    }
    return undefined
  }

  /** The workspace when every part it needs is current, else null. */
  function complete(): { value: Workspace | null } | null {
    if (!root?.fresh || root.error !== undefined) return null
    const answer = root.value as RootAnswer | undefined
    if (answer === undefined) return null
    if (answer === null) return { value: null }
    const parts: OrgParts[] = []
    for (const { id } of answer.orgs) {
      const org = orgs.get(id)
      if (!org) return null
      /** Every window of `kind` in order, or null while one is not ready. */
      const windowsOf = <P>(kind: Kind): P[] | null => {
        const list = org.kinds[kind]
        if (!list) return null
        const rows: P[] = []
        for (const n of list) {
          const got = rowsOf<P>(n)
          if (got === null) return null
          rows.push(...got)
        }
        return rows
      }
      const catalog = rowsOfSlot<CatalogPart>(org.catalog)
      const inbox = rowsOfSlot<InboxPart>(org.inbox)
      const tasks = windowsOf<TasksPart>('tasks')
      const people = windowsOf<PeoplePart>('people')
      const projects = windowsOf<ProjectsPart>('projects')
      if (!catalog || !inbox || !tasks || !people || !projects) return null
      parts.push({ catalog, inbox, tasks, people, projects })
    }
    return { value: joinParts(answer, parts, new Date(lastAt).toISOString()) }
  }

  /** Tells the store the workspace's state after a transition, `news` the
      side query's. Outside one, after Retry, it tells only of a failure: the workspace cannot be newer than the last transition, so a
      complete answer then would let the store take writes as shown that
      no transition brought yet. */
  function settle(transition?: { news?: PartsReport['side']; progress?: boolean }) {
    if (stopped) return
    if (reconcile()) dirty = true
    const error = failure()
    let workspace: PartsReport['workspace']
    if (error !== undefined) workspace = { state: 'failed', error }
    else {
      const done = transition ? complete() : null
      if (done === null) workspace = { state: 'held' }
      else {
        workspace = { state: 'complete', value: done.value, changed: dirty }
        dirty = false
        for (const org of orgs.values())
          for (const kind of KINDS) {
            const list = org.kinds[kind]
            // the pieces hold the rows the window held, so nothing changes
            if (list?.some((n) => n.pieces)) org.kinds[kind] = adoptPieces(list)
          }
      }
    }
    watchStall(workspace.state === 'held', transition?.progress === true)
    if (transition || workspace.state === 'failed')
      report({ at: lastAt, workspace, ...(transition?.news ? { side: transition.news } : {}) })
  }

  /** Starts or ends the stall check of an incomplete workspace, starting
      it over when a part answered (`progress`). */
  function watchStall(held: boolean, progress: boolean) {
    if (!held || progress) {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = null
      if (!held) return
    }
    stallTimer ??= setTimeout(function check() {
      if (stopped) return
      if (!online()) {
        stallTimer = setTimeout(check, STALL.ms)
        return
      }
      stallTimer = null
      report({
        at: lastAt,
        workspace: {
          state: 'failed',
          error: new ConvexError({
            code: 'rule',
            message: 'Part of the workspace did not arrive in time. Try again in a moment.',
          }),
        },
      })
    }, STALL.ms)
  }

  const stopTransitions = live.onTransition((transition) => {
    if (stopped) return
    lastAt = Math.max(lastAt, transition.at)
    if (connection !== null && transition.connection !== connection)
      for (const slot of slots.values()) slot.fresh = false
    connection = transition.connection
    let news: PartsReport['side']
    let progress = false
    for (const token of transition.tokens) {
      const slot = slots.get(token)
      if (!slot) continue
      let value: unknown
      let error: unknown
      try {
        value = live.read(token)
      } catch (e) {
        error = e ?? new Error('query failed')
      }
      if (value === undefined && error === undefined) {
        slot.fresh = false
        continue
      }
      slot.value = value
      slot.error = error
      slot.fresh = true
      if (slot === side) news = error === undefined ? { value } : { error }
      else {
        // the side query never holds the workspace, so it is no progress
        progress = true
        dirty = true
      }
    }
    settle({ news, progress })
  })

  root = watch(api.workspace.root, {})
  // the wait runs from the start, so a root that never answers fails too
  watchStall(true, false)

  return {
    /** Runs every failed part the workspace needs again, from a fresh
        subscription (Convex never keeps a failed run). Answers whether
        there was one. */
    retry(): boolean {
      const failed = [...needed()].filter((slot) => errorOf(slot) !== undefined)
      for (const slot of failed) {
        slot.stop()
        const again = live.watch(slot.ref, slot.args)
        slots.delete(slot.token)
        Object.assign(slot, {
          token: again.token,
          stop: again.stop,
          value: undefined,
          error: undefined,
          fresh: false,
        })
        slots.set(slot.token, slot)
      }
      if (failed.length > 0) settle()
      return failed.length > 0
    },
    /** Watches `ref` with `args` as the side query, replacing any before. */
    watchSide(ref: FunctionReference<'query'>, args: Record<string, Value>) {
      if (side) drop(side)
      side = watch(ref, args)
    },
    /** Stops the side query. */
    stopSide() {
      if (side) drop(side)
      side = null
    },
    /** Stops every subscription. */
    stop() {
      stopped = true
      stopTransitions()
      if (stallTimer) clearTimeout(stallTimer)
      // a Map lets its loop delete the entry it is on
      for (const slot of slots.values()) drop(slot)
      orgs.clear()
    },
  }
}

export type LiveParts = ReturnType<typeof createLiveParts>

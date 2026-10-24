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

   One socket runs one update at a time, and every part subscribed before
   an update starts arrives with it, so a workspace subscribed all at once
   shows nothing until all of it arrived. A workspace of more than
   STAGES.most parts therefore loads in two stages: each organization's
   catalog, inbox, people and projects and the first STAGES.first task
   windows, then, once every part watched answered, the other task
   windows. Each stage repaints the whole workspace, so there are two,
   whatever number of waves (below) brings them. Until its first complete
   transition, such a workspace is partial at the end of a stage, once
   every part watched answered: the store shows the tasks of the windows
   that arrived, and every person and project, and knows the share of tasks
   still to come. Convex sends the first subscription of a stage in a
   transition of its own, so reporting per stage rather than per transition
   halves the repaints. The task windows of a stage subscribe before the
   people and project windows, so the slow project windows of a workspace
   with thousands of projects run last. A
   partial transition holds no write for certain, since the window a write
   changed may not have arrived. A workspace of
   fewer parts loads in one stage and is never partial, and so do the
   organizations added once the workspace was complete and a boot that
   waits for the whole workspace (createLiveParts `whole`). A part that
   fails ends the stage: no other part subscribes while it holds the
   workspace.

   A deployment runs a limited number of queries at once, shared by every
   client (16 on a local backend and the Free plan, 256 on Pro), and
   refuses one that waits 5 s for a turn, closing the socket with 1013
   TooManyConcurrentRequests. The server runs one socket's new
   subscriptions in updates of up to 20 queries at once, each update the
   subscriptions that arrived while the one before ran. So parts subscribe
   in waves (BOUND): a wave of parts while at most a wave is unanswered,
   which keeps the next update waiting behind the running one without
   making it larger. The wave starts small and grows while the server
   answers fast, up to the 20 the server would run anyway, so a lone boot
   on a deployment with turns to spare runs few small updates. It halves when answers slow down, which is when queries
   wait for a turn: a backend short of processors or busy with other
   clients then runs each query for less time and leaves turns for them.

   - A window that answers `split` keeps serving while its two halves load,
     and gives way to them in the first complete transition that holds both.
   - A window that answers `overflow` has no rows to show, so the workspace
     waits for its pieces: as many as the answer names, else its halves
     (convex/lib/idWindows.ts piecesAfter). A partial workspace leaves its
     tasks out until they arrive.
   - A new seat's organization waits for its parts. A seat that
     goes leaves with the root part's answer, quietly.
   - After the socket reconnects, Convex sends every result again, and none
     counts until it arrived again. Convex sends every subscription the
     moment it connects, so when the socket drops the registry keeps one
     wave subscribed and puts the other parts back in line; they subscribe
     in waves again as the earlier ones answer, while the workspace holds.
     After a close for the server's load the wave halves, down to
     BOUND.least, until the workspace is complete, so a busy server is not
     sent the same set again. The workspace waits for the server
     (`onWait`) from the drop until a part answers.
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
  idShare,
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

/** How a large workspace loads in stages: with more than `most` parts it
    subscribes every part but its task windows, and `first` of those, then
    `batch` more each time every part watched so far answered, all of them
    unless a probe sets fewer. */
export const STAGES = { most: 32, first: 16, batch: Number.POSITIVE_INFINITY }

/** How many part queries the registry has the server run at once: it
    subscribes at most a wave of parts while at most a wave is unanswered,
    so each server update holds about one wave. The wave starts at `wave`
    and stays between `least` and `most`, the most queries the server runs
    at once for one socket. It grows by half once a wave's worth of parts
    each answered within `fast` ms of the server having parts to run, and
    halves when a part took more than `slow` or the server closed the
    socket for its load; after such a close it does not grow until the
    workspace is complete. */
export const BOUND = { wave: 8, least: 2, most: 20, fast: 1_000, slow: 2_000 }

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
    | {
        /** a large workspace before its first complete transition, with
            every part but some task windows current */
        state: 'partial'
        value: Workspace
        changed: boolean
        /** the share of task windows that arrived, from 0 to 1 */
        loaded: number
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

/* One part, its subscription while it has one, and what the transitions
   brought it. */
type Slot = {
  /** the subscription, null while the part waits for its turn (BOUND),
      with the number of subscriptions made before it */
  sub: { token: string; stop: () => void; turn: number } | null
  /** the part's place in line: parts made earlier subscribe first */
  seq: number
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
  /** the task windows a staged load has not watched yet, in order */
  later: IdWindow[]
}

/* An answer with rows of a part. */
type Answer = { state: string; split?: boolean; pieces?: number; message?: string }

const isAnswer = (value: unknown): value is Answer =>
  typeof value === 'object' && value !== null && 'state' in value

/** Creates a registry over `live` that reports to `report`. `online` says
    whether the stall check may fail the workspace, false while the socket
    is down or saves pause offline. With `whole`, the caller shows only a
    complete workspace, so nothing loads in stages. `onWait` hears whether
    the workspace waits for the server: from a drop of the socket, or a
    close for the server's load, until a part answers again. */
export function createLiveParts(
  live: LiveQueries,
  report: (news: PartsReport) => void,
  online: () => boolean,
  opts?: { whole?: boolean; onWait?: (waiting: boolean) => void },
) {
  let stopped = false
  let connection: number | null = null
  // the subscribed parts and the side query, by token
  const slots = new Map<string, Slot>()
  // the parts waiting for their turn, in line
  const queue: Slot[] = []
  let seq = 0
  // the most parts a wave subscribes (BOUND), and whether a close for the
  // server's load keeps it from growing
  let wave = BOUND.wave
  let strained = false
  // subscriptions made so far, and how many there were when the wave
  // last changed: only parts asked for after that tell of the new size
  let turns = 0
  let paced = 0
  // parts asked for at the present size that answered fast in a row
  let quick = 0
  // when the server last got parts to run with none unanswered before, or
  // last answered some while it had more, null with none unanswered
  let since: number | null = null
  // whether the socket dropped and has not connected again
  let down = false
  let waitingNow = false
  let root: Slot | null = null
  const orgs = new Map<string, Org>()
  // whether a part changed since the last complete report
  let dirty = true
  let side: Slot | null = null
  let lastAt = 0
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  // whether the first organizations load in stages, and whether a complete
  // report went out, after which the workspace is never partial again, so
  // nothing loads in stages any more
  let staged = false
  let completed = false

  /** A part for `ref` with `args`, in line for its turn (pump). */
  const watch = (ref: FunctionReference<'query'>, args: Record<string, Value>): Slot => {
    const slot: Slot = { sub: null, seq: seq++, ref, args, fresh: false }
    queue.push(slot)
    return slot
  }
  const subscribe = (slot: Slot) => {
    slot.sub = { ...live.watch(slot.ref, slot.args), turn: turns++ }
    slots.set(slot.sub.token, slot)
  }
  /** Ends `slot`'s subscription, or its wait in line. */
  const unsubscribe = (slot: Slot) => {
    if (!slot.sub) {
      const at = queue.indexOf(slot)
      if (at >= 0) queue.splice(at, 1)
      return
    }
    slot.sub.stop()
    if (slots.get(slot.sub.token) === slot) slots.delete(slot.sub.token)
    slot.sub = null
  }
  const drop = unsubscribe
  const inLine = (slot: Slot) => {
    const at = queue.findIndex((other) => other.seq > slot.seq)
    queue.splice(at < 0 ? queue.length : at, 0, slot)
  }

  /** How many subscribed parts have no answer since the socket last
      connected. */
  function unanswered(): number {
    let n = 0
    for (const slot of slots.values()) if (slot !== side && !slot.fresh) n++
    return n
  }

  /** Subscribes the next wave of parts in line while at most a wave is
      unanswered. The server runs the subscriptions that arrived during an
      update in the next one, so a wave sent while one runs keeps it busy
      without making its update larger, and none of this client's queries
      waits for a turn (BOUND). Nothing subscribes while the socket is down:
      the next connection sends every subscription at once. */
  function pump() {
    if (stopped || down || queue.length === 0 || unanswered() > wave) return
    if (since === null) since = Date.now()
    for (const slot of queue.splice(0, wave)) subscribe(slot)
  }

  /** Sizes the wave by how long the server took for the `n` parts that
      just answered, asked for at the present size (BOUND), of the `first`
      parts that answered for the first time on this connection. A part
      that answers again only because its data changed tells nothing of
      how long the server takes for those still unanswered. */
  function pace(n: number, first: number) {
    if (first === 0) return
    const now = Date.now()
    if (since !== null && n > 0) {
      const took = now - since
      const before = wave
      quick = took < BOUND.fast ? quick + n : 0
      if (took > BOUND.slow) wave = Math.max(BOUND.least, Math.floor(wave / 2))
      else if (quick >= wave && !strained) wave = Math.min(BOUND.most, Math.ceil(wave * 1.5))
      if (wave !== before) {
        paced = turns
        quick = 0
      }
    }
    since = unanswered() > 0 ? now : null
  }

  /** On a drop of the socket, keeps the first wave of subscribed parts
      and puts the others back in line, so the next connection sends one
      wave, not every part; after a close for the server's load, a smaller
      one. */
  function park(overloaded: boolean) {
    if (overloaded) {
      wave = Math.max(BOUND.least, Math.floor(wave / 2))
      strained = true
      paced = turns
      quick = 0
    }
    since = null
    const on = [...slots.values()].filter((slot) => slot !== side).sort((a, b) => a.seq - b.seq)
    for (const slot of on.slice(wave)) {
      unsubscribe(slot)
      inLine(slot)
    }
    for (const slot of on) slot.fresh = false
  }

  /** Tells onWait when waiting for the server begins or ends. */
  function setWaiting(waiting: boolean) {
    if (waiting === waitingNow) return
    waitingNow = waiting
    opts?.onWait?.(waiting)
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
    // as many windows as the counters say each new organization fills
    const count = (rows: number, kind: keyof typeof WINDOW_ROWS) =>
      idWindows(windowCount(rows, WINDOW_ROWS[kind]))
    const added = (answer === null ? [] : answer.orgs)
      .filter((row) => !orgs.has(row.id))
      .map((row) => ({
        row,
        tasks: count(row.next_issue_num, 'tasks'),
        projects: count(row.next_project_num, 'projects'),
      }))
    // the catalog, the inbox and one people window besides the windows
    const parts = added.reduce((n, o) => n + 3 + o.tasks.length + o.projects.length, 0)
    // stages only while a partial workspace can show
    const stage = parts > STAGES.most && !completed && !opts?.whole
    if (stage) staged = true
    const windows = (orgId: string, kind: Kind, list: IdWindow[]) =>
      list.map((w) => node(orgId, kind, w))
    for (const { row, tasks } of added) {
      orgs.set(row.id, {
        id: row.id,
        catalog: watch(api.workspace.catalog, { org_id: row.id }),
        inbox: watch(api.workspace.inbox, { org_id: row.id }),
        kinds: { tasks: windows(row.id, 'tasks', stage ? [] : tasks), people: [], projects: [] },
        later: stage ? tasks : [],
      })
      moved = true
    }
    // the organizations just added get the first windows
    if (stage)
      watchLater(
        STAGES.first,
        added.map(({ row }) => row.id),
      )
    // People and projects subscribe after the task windows, so the backend,
    // which runs the parts in the order they came, runs the slow project
    // windows last, with nothing waiting behind them (STAGES)
    for (const { row, projects } of added) {
      const org = orgs.get(row.id) as Org
      org.kinds.people = windows(row.id, 'people', idWindows(1))
      org.kinds.projects = windows(row.id, 'projects', projects)
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

  /** Watches up to `n` of the task windows a staged load holds back, each
      organization's next in turn, of the organizations `ids` when given. */
  function watchLater(n: number, ids?: readonly string[]) {
    const from = [...orgs.values()].filter((org) => !ids || ids.includes(org.id))
    while (n > 0 && from.some((org) => org.later.length > 0))
      for (const org of from) {
        if (n === 0) break
        const w = org.later.shift()
        if (!w) continue
        org.kinds.tasks.push(node(org.id, 'tasks', w))
        n--
      }
  }

  /** Whether a part watched has no answer since the socket last connected. */
  function waiting(): boolean {
    for (const org of orgs.values()) for (const slot of orgSlots(org)) if (!slot.fresh) return true
    return false
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

  /** The first error of a slot complete() needs, or undefined. With
      `current`, only an error that came over this connection. */
  function failure(current = false): unknown {
    for (const slot of needed()) {
      if (current && !slot.fresh) continue
      const error = errorOf(slot)
      if (error !== undefined) return error
    }
    return undefined
  }

  /** The workspace when every part it needs is current, else null. With
      `partial`, the workspace when every part but some task windows is,
      from the task windows that are, with the share of tasks they cover,
      each organization weighted by its task count; null unless at least
      one is. */
  function join(partial: boolean): { value: Workspace | null; loaded: number } | null {
    if (!root?.fresh || root.error !== undefined) return null
    const answer = root.value as RootAnswer | undefined
    if (answer === undefined) return null
    if (answer === null) return partial ? null : { value: null, loaded: 1 }
    const parts: OrgParts[] = []
    let loaded = 0
    const tasksIn = (row: (typeof answer.orgs)[number]) => Math.max(1, row.next_issue_num)
    const allTasks = answer.orgs.reduce((n, row) => n + tasksIn(row), 0)
    for (const row of answer.orgs) {
      const { id } = row
      const org = orgs.get(id)
      if (!org) return null
      /** Every window of `kind` in order, or null while one is not ready.
          With `some`, the ready ones. */
      const windowsOf = <P>(kind: Kind, some = false): P[] | null => {
        const rows: P[] = []
        for (const n of org.kinds[kind]) {
          const got = rowsOf<P>(n)
          if (got === null && !some) return null
          if (got === null) continue
          rows.push(...got)
          if (kind === 'tasks') loaded += (idShare(n) * tasksIn(row)) / allTasks
        }
        return rows
      }
      if (!partial && org.later.length > 0) return null
      const catalog = rowsOfSlot<CatalogPart>(org.catalog)
      const inbox = rowsOfSlot<InboxPart>(org.inbox)
      const tasks = windowsOf<TasksPart>('tasks', partial)
      const people = windowsOf<PeoplePart>('people')
      const projects = windowsOf<ProjectsPart>('projects')
      if (!catalog || !inbox || !tasks || !people || !projects) return null
      parts.push({ catalog, inbox, tasks, people, projects })
    }
    if (partial && loaded === 0) return null
    return { value: joinParts(answer, parts, new Date(lastAt).toISOString()), loaded }
  }

  /** Tells the store the workspace's state after a transition, `news` the
      side query's. Outside one, after Retry, it tells only of a failure: the workspace cannot be newer than the last transition, so a
      complete answer then would let the store take writes as shown that
      no transition brought yet. */
  function settle(transition?: { news?: PartsReport['side']; progress?: boolean }) {
    if (stopped) return
    if (reconcile()) dirty = true
    // every part watched so far answered: the next stage starts, unless the
    // workspace failed, and a partial workspace shows, once per stage rather
    // than per transition
    const answered = transition !== undefined && !waiting()
    const error = failure()
    if (answered && error === undefined) watchLater(STAGES.batch)
    // a part that fails ends the stage, and its line waits with it; an
    // error from before the socket dropped does not, or a part put back in
    // line with one would never subscribe again to replace it
    if (failure(true) === undefined) pump()
    let workspace: PartsReport['workspace']
    if (error !== undefined) workspace = { state: 'failed', error }
    else {
      const done = transition ? join(false) : null
      const some = answered && !done && staged && !completed ? join(true) : null
      if (done) {
        workspace = { state: 'complete', value: done.value, changed: dirty }
        dirty = false
        completed = true
        wave = BOUND.wave
        strained = false
        for (const org of orgs.values())
          for (const kind of KINDS) {
            const list = org.kinds[kind]
            // the pieces hold the rows the window held, so nothing changes
            if (list.some((n) => n.pieces)) org.kinds[kind] = adoptPieces(list)
          }
      } else if (some?.value) {
        workspace = { state: 'partial', value: some.value, changed: dirty, loaded: some.loaded }
        dirty = false
      } else workspace = { state: 'held' }
    }
    watchStall(
      workspace.state === 'held' || workspace.state === 'partial',
      transition?.progress === true,
    )
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
    // a transition comes over a connected socket, whenever Convex reports it
    down = false
    let news: PartsReport['side']
    let progress = false
    // the parts that answered for the first time on this connection, and
    // those of them asked for at the present size
    let first = 0
    let arrived = 0
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
      if (slot !== side && !slot.fresh) {
        first++
        if ((slot.sub?.turn ?? -1) >= paced) arrived++
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
    if (progress) setWaiting(false)
    pace(arrived, first)
    settle({ news, progress })
  })

  const stopConnection = live.onConnection(({ connected, overloaded }) => {
    if (stopped || connected !== down) return
    down = !connected
    if (!down) {
      // the parts kept subscribed run again from now. They go out with the
      // new connection's query set, and the server runs it after
      // authenticating, together with whatever arrived meanwhile, so the
      // next wave waits for their answer (settle)
      since = unanswered() > 0 ? Date.now() : null
      if (since === null) pump()
      return
    }
    park(overloaded)
    setWaiting(true)
  })

  root = watch(api.workspace.root, {})
  pump()
  // the wait runs from the start, so a root that never answers fails too
  watchStall(true, false)

  return {
    /** Runs every failed part the workspace needs again, from a fresh
        subscription (Convex never keeps a failed run). Answers whether
        there was one. */
    retry(): boolean {
      const failed = [...needed()].filter((slot) => errorOf(slot) !== undefined)
      for (const slot of failed) {
        unsubscribe(slot)
        Object.assign(slot, { value: undefined, error: undefined, fresh: false })
        inLine(slot)
      }
      if (failed.length > 0) settle()
      return failed.length > 0
    },
    /** Watches `ref` with `args` as the side query, replacing any before.
        It takes no turn in line. */
    watchSide(ref: FunctionReference<'query'>, args: Record<string, Value>) {
      if (side) drop(side)
      side = { sub: null, seq: -1, ref, args, fresh: false }
      subscribe(side)
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
      stopConnection()
      if (stallTimer) clearTimeout(stallTimer)
      // a Map lets its loop delete the entry it is on
      for (const slot of slots.values()) drop(slot)
      queue.length = 0
      orgs.clear()
    },
  }
}

export type LiveParts = ReturnType<typeof createLiveParts>

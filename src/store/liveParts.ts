/* The workspace's live parts (convex/workspace.ts) as the store adopts
   them: once per Convex transition, all together (lib/liveQueries.ts).

   The registry subscribes to the root part, and for each organization it
   names to the catalog, the inbox, and windows of its people and projects
   (convex/lib/idWindows.ts), as many as its counts of projects say it
   fills (startWindows), chosen once when it adds the organization. After
   each transition it tells the store (report) whether every part it needs
   holds a current answer. Only then is the workspace complete, joined from
   them (convex/lib/workspaceJoin.ts); otherwise the store keeps what it
   shows, and nothing a transition brought is dropped, since the next
   complete one holds it.

   Tasks load on demand. The windows of the workspace's tasks
   (workspace.tasks) are subscribed only once something that needs every
   task asks (askTasks), or from the start for a registry created with
   `ask`. Until then a complete report holds no task (`tasks:
   'not_asked'`), and the views show the server's own answers. The ask
   sizes each organization's task windows from the root part's current
   answer and subscribes all of them at once, never while another part
   waits for its answer, so no window queues behind running project
   windows. From the ask until every task window answered, a transition
   with every other part current reports `partial` with no task at all and
   the share of task windows that answered, so the projects, people and
   Inbox stay live during the load while the store never holds part of the
   tasks. The first transition in which every task window answered reports
   `complete` with `tasks: 'all'`, and the registry is never partial again.
   A partial transition holds no write for certain, since the window a
   write changed may not have arrived.

   One socket runs one update at a time, and every part subscribed before
   an update starts arrives with it. An organization added once tasks were
   asked subscribes its task windows before its people and project
   windows: a deployment runs a limited number of queries at once (16 on a
   local backend) and refuses one that waits too long for a turn, closing
   the socket with 1013 TooManyConcurrentRequests, and the project windows
   of a workspace with thousands of projects run long enough that a part
   queued behind them can wait that long.

   - A window that answers `split` keeps serving while its two halves load,
     and gives way to them in the first complete transition that holds both.
   - A window that answers `overflow` has no rows to show, so the workspace
     waits for its pieces: as many as the answer names, else its halves
     (convex/lib/idWindows.ts piecesAfter).
   - A new seat's organization waits for its parts. A seat that
     goes leaves with the root part's answer, quietly. When the last seats
     go because their organization is being deleted, the root part says so
     and the report passes it on.
   - After the socket reconnects, Convex sends every result again, and none
     counts until it arrived again.
   - A part that failed, or refused to load with a sentence, makes the
     workspace fail when nothing else can show its rows: a window that
     asked to be cut and then failed gives way to its pieces once they
     answer, and a piece's failure waits while its window still shows.
     Retry runs only the parts whose failure holds the workspace again.
     Until every task arrived once, a task window that fails holds only the
     task load: the report stays `partial` and names the failure
     (`tasksFailed`), so the rest of the tab keeps working, and retryTasks
     runs those windows again. After that, a task window that fails holds
     the workspace as any part does.
   - A workspace that stays incomplete while online, with no part answering
     for STALL.ms, from the start on, fails, so a part that never answers
     shows instead of a frozen screen. Where only task windows are silent,
     only the task load fails. Convex sends the first answers of parts
     subscribed together in one transition, so a large organization on a
     busy backend can take many seconds before anything arrives.

   Named side queries ride along (SideName): the open task's comment thread
   and, while a window shows All, its history, and while a window shows the
   task's details, its subtasks, links and attachments
   (convex/taskWindow.ts), the task with its subtasks also while a window
   shows a task the workspace does not hold from it, and the read of a
   task a window names by a reference before it knows the task's uuid and
   organization (store/planner.ts P.watchTaskRef). A boot on a task's
   address subscribes that read itself, once the root part names the
   organization the address's slug names and before any task window
   (createLiveParts `address`), so the task's answer comes with the first
   parts. A transition that brings the workspace and the sides repaints
   once. Each side is its own. Its failure never holds the workspace or
   another side.

   Watching one query with the same arguments twice shares one Convex
   subscription and one token (lib/liveQueries.ts), and a watch that joins
   one hears no transition for an answer that arrived already. So a side
   whose query and arguments the `reference` side watches takes that
   subscription over (watchSide), with its answer, rather than watching
   again, as the task side does when it reads the task a reference read
   named. No side takes another's: the store never starts a reference read
   with the arguments the task side reads with (store/planner.ts
   runRefRead). */

import { type FunctionReference, getFunctionName } from 'convex/server'
import { ConvexError, type Value } from 'convex/values'
import { api } from '../../convex/_generated/api'
import {
  type IdWindow,
  idShare,
  idWindows,
  piecesAfter,
  startWindows,
  tasksIn,
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
  rootOrgs,
  type Seatless,
  type TasksPart,
  type Workspace,
} from '../../convex/lib/workspaceJoin'
import type { LiveQueries } from '../lib/liveQueries'

/** How long an incomplete workspace may go without any part answering
    while online before it fails. Tests lower it. */
export const STALL = { ms: 60_000 }

/* Where a test build keeps TASKS.atBoot: on globalThis, so every fresh copy
   of this module that vi.resetModules makes reads the choice the test setup
   or a suite made before it loaded. */
type TasksAtBoot = { qivoTasksAtBoot?: boolean }
const TEST_BUILD = import.meta.env.MODE === 'test'
let atBoot = false

/** Whether a store asks for every task as it boots (store/planner.ts
    startParts). The app boots without (false). The test setup turns it on
    for the suites that test the store with every task held
    (store/guard/tasksAtBoot.setup.ts), and the Board and not-asked suites
    turn it off. */
export const TASKS = {
  get atBoot(): boolean {
    return TEST_BUILD ? (globalThis as TasksAtBoot).qivoTasksAtBoot === true : atBoot
  },
  set atBoot(on: boolean) {
    if (TEST_BUILD) (globalThis as TasksAtBoot).qivoTasksAtBoot = on
    else atBoot = on
  },
}

/** The sentence of a task load whose windows stayed silent for STALL.ms. */
export const TASKS_STALLED = 'Every task did not arrive in time. Try again in a moment.'

/** The side queries that ride along with the workspace: the open task's
    comment thread and, while a window shows All, its history, and while a
    window shows the task's details, the task with its subtasks, its links
    and its attachments (convex/taskWindow.ts task, links and
    attachments). The task side also runs while a window shows a task the
    workspace does not hold, from that answer (store/planner.ts
    P.taskDetail). `reference` reads a task a window names by a reference
    (lib/taskReference.ts) by its number, or by its uuid in one
    organization after another, until an answer names its uuid and
    organization (store/planner.ts P.watchTaskRef). */
export const SIDE_NAMES = [
  'thread',
  'history',
  'task',
  'links',
  'attachments',
  'reference',
] as const
export type SideName = (typeof SIDE_NAMES)[number]

/** What one transition brought a side query: its answer or its failure. */
export type SideNews = { value: unknown } | { error: unknown }

/** What the store hears after each transition, and when the workspace
    fails outside one. */
export type PartsReport = {
  /** the server time of the state, in ms */
  at: number
  /** the socket's connection count of the newest transition the registry
      heard, 0 before the first: after a reconnect every result arrives
      again, and a side's news counts as current only once it arrived on
      the newest connection (store/planner.ts latestConnection) */
  connection: number
  workspace:
    | {
        state: 'complete'
        /** null when the caller holds no seat it can open */
        value: Workspace | null
        /** with no such seat, the root part's answer when an organization
            deletion holds the caller's seats or an organization
            deactivated it (convex/lib/workspaceParts.ts readRoot) */
        seatless?: Seatless
        /** whether any part changed since the last complete report */
        changed: boolean
        /** whether the workspace holds every task the caller may see
            ('all'), or none since nothing asked for them ('not_asked') */
        tasks: 'not_asked' | 'all'
      }
    | {
        /** tasks were asked and some task windows have not answered yet,
            with every other part current: the workspace holds no task */
        state: 'partial'
        value: Workspace
        /** whether a part other than a task window changed since the last
            report that held the workspace's rows */
        changed: boolean
        /** the share of task windows that answered, from 0 to 1 */
        loaded: number
        /** why the task load stopped: a task window failed or refused, or
            every silent one stayed silent for STALL.ms */
        tasksFailed?: unknown
      }
    | { state: 'held' }
    | { state: 'failed'; error: unknown }
  /** the news of each side query this transition brought news of, when
      it brought any */
  sides?: Partial<Record<SideName, SideNews>>
}

type Kind = 'tasks' | 'people' | 'projects'
const KINDS: readonly Kind[] = ['tasks', 'people', 'projects']
/* The kinds whose windows every workspace needs, asked or not. */
const PART_KINDS: readonly Kind[] = ['people', 'projects']
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
  /** the side query it is, for a side query's slot */
  side?: SideName
  /** whether it is a window of the workspace's tasks */
  task?: true
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
  /** whether its task windows were subscribed, which they are once tasks
      were asked */
  tasksStarted: boolean
}

/* An answer with rows of a part. */
type Answer = { state: string; split?: boolean; pieces?: number; message?: string }

const isAnswer = (value: unknown): value is Answer =>
  typeof value === 'object' && value !== null && 'state' in value

/** The root part's arguments: this app shows a login that an organization
    deactivated its own screen, so it asks to hear of one
    (convex/workspace.ts root). */
export const ROOT_ARGS = { seatless: 'all' } as const

/** The task a boot's address names under an organization's slug
    (lib/router.ts addressedTask), with its ref as taskWindow.task reads it,
    `QN-12` or a lowercase uuid. */
export type AddressedTask = { slug: string; ref: string }

/* Whether side slot `slot` watches query `ref` with `args`. */
const sameQuery = (slot: Slot, ref: FunctionReference<'query'>, args: Record<string, Value>) =>
  getFunctionName(slot.ref) === getFunctionName(ref) &&
  JSON.stringify(slot.args) === JSON.stringify(args)

/** Creates a registry over `live` that reports to `report`. `online` says
    whether the stall check may fail the workspace, false while the socket
    is down or saves pause offline. With `ask`, the registry subscribes
    every organization's task windows from the start, as after askTasks.
    With `address`, it subscribes the `reference` side to the task the
    boot's address names, taskWindow.task in the organization its slug
    names, once the root part names that organization, and before any task
    window. A slug the root part does not name subscribes nothing. */
export function createLiveParts(
  live: LiveQueries,
  report: (news: PartsReport) => void,
  online: () => boolean,
  opts?: { ask?: boolean; address?: AddressedTask },
) {
  let stopped = false
  let connection: number | null = null
  const slots = new Map<string, Slot>()
  let root: Slot | null = null
  const orgs = new Map<string, Org>()
  // whether a part other than a task window changed since the last report
  // that held the workspace's rows, and whether a task window did since
  // the last complete one
  let dirty = true
  let tasksDirty = false
  const sides = new Map<SideName, Slot>()
  let lastAt = 0
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  // whether every task is wanted, whether the ask still waits for a settle
  // in which no part waits, and whether a complete report with every task
  // went out, after which the workspace is never partial again
  let asked = !!opts?.ask
  let askWaits = false
  let completed = false
  // whether the task windows' silence stopped the task load (watchStall)
  let tasksStalled = false
  // whether the root part's first answer was read for the boot's address
  let addressed = !opts?.address

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

  const node = (orgId: string, kind: Kind, w: IdWindow): Node => {
    const slot = watch(WINDOWED[kind], { org_id: orgId, from: w.from, to: w.to })
    if (kind === 'tasks') slot.task = true
    return { ...w, slot, pieces: null }
  }
  const windows = (orgId: string, kind: Kind, list: IdWindow[]) =>
    list.map((w) => node(orgId, kind, w))

  /** The root part's current answer, or undefined while it has none. */
  const rootAnswer = (): RootAnswer | undefined =>
    root?.fresh && root.error === undefined ? (root.value as RootAnswer) : undefined

  /** Subscribes the task windows of every organization whose windows were
      not started, as many as the root part's current answer says it
      fills. */
  function startTasks(answer: RootAnswer) {
    for (const row of rootOrgs(answer)) {
      const org = orgs.get(row.id)
      if (!org || org.tasksStarted) continue
      org.kinds.tasks = windows(row.id, 'tasks', idWindows(startWindows(row).tasks))
      org.tasksStarted = true
      tasksDirty = true
    }
  }

  /** Brings the organizations in line with the root part's answer, and
      windows in line with their parts' answers. Answers
      whether anything changed. */
  function reconcile(): boolean {
    let moved = false
    const answer = rootAnswer()
    if (answer === undefined) return false
    if (!addressed && opts?.address) {
      addressed = true
      const { slug, ref } = opts.address
      const org = rootOrgs(answer).find((row) => row.slug === slug.toLowerCase())
      if (org) watchSide('reference', api.taskWindow.task, { org_id: org.id, ref })
    }
    const wanted = new Set(rootOrgs(answer).map((org) => org.id))
    for (const [id, org] of orgs) {
      if (wanted.has(id)) continue
      for (const slot of orgSlots(org)) drop(slot)
      orgs.delete(id)
      moved = true
    }
    // as many windows as each new organization's counts say it fills, its
    // task windows only once tasks were asked and the ask no longer waits
    const tasksNow = asked && !askWaits
    const added = rootOrgs(answer)
      .filter((row) => !orgs.has(row.id))
      .map((row) => {
        const start = startWindows(row)
        return {
          row,
          tasks: tasksNow ? idWindows(start.tasks) : [],
          projects: idWindows(start.projects),
        }
      })
    for (const { row, tasks } of added) {
      orgs.set(row.id, {
        id: row.id,
        catalog: watch(api.workspace.catalog, { org_id: row.id }),
        inbox: watch(api.workspace.inbox, { org_id: row.id }),
        kinds: { tasks: windows(row.id, 'tasks', tasks), people: [], projects: [] },
        tasksStarted: tasksNow,
      })
      moved = true
    }
    // People and projects subscribe after the task windows, so the backend,
    // which runs the parts in the order they came, runs the slow project
    // windows last, with nothing waiting behind them
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

  /** Whether the root part or a part watched has no answer since the
      socket last connected. */
  function waiting(): boolean {
    if (root && !root.fresh) return true
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

  /** The slots complete() needs an answer from other than task windows:
      the root, each organization's catalog and inbox, and each people or
      project window that shows its rows neither itself nor through its
      pieces (rowsOf), or, when it has pieces, the pieces that cannot. */
  function* neededParts(): Generator<Slot> {
    if (root) yield root
    for (const org of orgs.values()) {
      yield org.catalog
      yield org.inbox
      for (const kind of PART_KINDS) for (const n of org.kinds[kind]) yield* neededIn(n)
    }
  }
  /** The task window slots complete() needs an answer from, as
      neededParts. */
  function* neededTasks(): Generator<Slot> {
    for (const org of orgs.values()) for (const n of org.kinds.tasks) yield* neededIn(n)
  }
  function* neededIn(n: Node): Generator<Slot> {
    if (rowsOf(n) !== null) return
    if (n.pieces === null) yield n.slot
    else for (const piece of n.pieces) yield* neededIn(piece)
  }

  /** The first error among `list`, or undefined. */
  function firstError(list: Iterable<Slot>): unknown {
    for (const slot of list) {
      const error = errorOf(slot)
      if (error !== undefined) return error
    }
    return undefined
  }

  /** The first error that fails the workspace, or undefined: a part's, and
      a task window's once every task arrived (`completed`). Before that a
      task window's error fails only the task load (tasksFailure). */
  function failure(): unknown {
    const error = firstError(neededParts())
    if (error !== undefined || !completed) return error
    return firstError(neededTasks())
  }

  /** Why the task load stopped while it has not completed, or undefined. */
  function tasksFailure(): unknown {
    if (completed || !asked) return undefined
    const error = firstError(neededTasks())
    if (error !== undefined) return error
    return tasksStalled ? new ConvexError({ code: 'rule', message: TASKS_STALLED }) : undefined
  }

  /** The workspace when every part it needs is current, else null. With
      `withTasks`, every task window must be current too once tasks were
      asked, and every organization's task windows started, and the
      workspace holds their tasks; without, the task windows do not count
      and the workspace holds no task. `loaded` is the share of task windows
      that answered, each organization weighted by its task count. */
  function join(
    withTasks: boolean,
  ): { value: Workspace | null; loaded: number; seatless?: Seatless } | null {
    if (!root?.fresh || root.error !== undefined) return null
    const answer = root.value as RootAnswer | undefined
    if (answer === undefined) return null
    if (answer === null) return withTasks ? { value: null, loaded: 1 } : null
    if ('deleting' in answer) return withTasks ? { value: null, loaded: 1, seatless: answer } : null
    const parts: OrgParts[] = []
    let loaded = 0
    const weight = (row: (typeof answer.orgs)[number]) => Math.max(1, tasksIn(row))
    const allTasks = answer.orgs.reduce((n, row) => n + weight(row), 0)
    for (const row of answer.orgs) {
      const org = orgs.get(row.id)
      if (!org) return null
      if (withTasks && asked && !org.tasksStarted) return null
      /** Every window of `kind` in order, or null while one is not ready. */
      const windowsOf = <P>(kind: Kind): P[] | null => {
        const rows: P[] = []
        for (const n of org.kinds[kind]) {
          const got = rowsOf<P>(n)
          if (got === null) return null
          rows.push(...got)
        }
        return rows
      }
      for (const n of org.kinds.tasks)
        if (rowsOf(n) !== null) loaded += (idShare(n) * weight(row)) / allTasks
      const catalog = rowsOfSlot<CatalogPart>(org.catalog)
      const inbox = rowsOfSlot<InboxPart>(org.inbox)
      const tasks = withTasks ? windowsOf<TasksPart>('tasks') : []
      const people = windowsOf<PeoplePart>('people')
      const projects = windowsOf<ProjectsPart>('projects')
      if (!catalog || !inbox || !tasks || !people || !projects) return null
      parts.push({ catalog, inbox, tasks, people, projects })
    }
    return { value: joinParts(answer, parts, new Date(lastAt).toISOString()), loaded }
  }

  /** The report of a task load in progress, with no task: the partial
      workspace when every part but some task windows is current, else
      null. */
  function arriving(): PartsReport['workspace'] | null {
    if (!asked || completed) return null
    const some = join(false)
    if (!some?.value) return null
    const tasksFailed = tasksFailure()
    const workspace: PartsReport['workspace'] = {
      state: 'partial',
      value: some.value,
      changed: dirty,
      loaded: some.loaded,
      ...(tasksFailed === undefined ? {} : { tasksFailed }),
    }
    dirty = false
    return workspace
  }

  /** Tells the store the workspace's state after a transition, `news` the
      side queries'. Outside one, after Retry, it tells only of a failure:
      the workspace cannot be newer than the last transition, so a complete
      answer then would let the store take writes as shown that no
      transition brought yet. */
  function settle(transition?: { news?: PartsReport['sides']; progress?: boolean }) {
    if (stopped) return
    if (reconcile()) dirty = true
    // an ask that waited starts its task windows once no part waits
    const answer = rootAnswer()
    if (askWaits && answer !== undefined && !waiting()) {
      askWaits = false
      startTasks(answer)
    }
    const error = failure()
    let workspace: PartsReport['workspace']
    if (error !== undefined) workspace = { state: 'failed', error }
    else {
      const done = transition ? join(true) : null
      if (done) {
        workspace = {
          state: 'complete',
          value: done.value,
          changed: dirty || tasksDirty,
          tasks: asked ? 'all' : 'not_asked',
          ...(done.seatless ? { seatless: done.seatless } : {}),
        }
        dirty = false
        tasksDirty = false
        if (asked) {
          completed = true
          tasksStalled = false
        }
        for (const org of orgs.values())
          for (const kind of KINDS) {
            const list = org.kinds[kind]
            // the pieces hold the rows the window held, so nothing changes
            if (list.some((n) => n.pieces)) org.kinds[kind] = adoptPieces(list)
          }
      } else workspace = (transition && arriving()) || { state: 'held' }
    }
    watchStall(
      workspace.state === 'held' || workspace.state === 'partial',
      transition?.progress === true,
    )
    if (transition || workspace.state === 'failed')
      report({
        at: lastAt,
        connection: connection ?? 0,
        workspace,
        ...(transition?.news ? { sides: transition.news } : {}),
      })
  }

  /** Starts or ends the stall check of an incomplete workspace, starting
      it over when a part answered (`progress`). Where every part but some
      task windows is current when it fires, only the task load stops. */
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
      if (!completed && asked && join(false)?.value) {
        tasksStalled = true
        const workspace = arriving()
        if (workspace) report({ at: lastAt, connection: connection ?? 0, workspace })
        return
      }
      report({
        at: lastAt,
        connection: connection ?? 0,
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

  /** Watches `ref` with `args` as side `name`, replacing that side's
      subscription. A fresh subscription runs the query again, so its
      answer is never one held from before. A `reference` side that
      watches the same query with the same arguments holds the one
      subscription Convex keeps for both, so side `name` takes it over
      instead, and the news it answers is that subscription's current
      answer, when one arrived on the newest connection, else undefined.
      Only the reference side's is handed over: a read that another side
      needs goes on, and the caller never watches its arguments again. */
  function watchSide(
    name: SideName,
    ref: FunctionReference<'query'>,
    args: Record<string, Value>,
  ): SideNews | undefined {
    const before = sides.get(name)
    for (const [other, slot] of sides) {
      if (other !== 'reference' || other === name || !sameQuery(slot, ref, args)) continue
      if (before) drop(before)
      sides.delete(other)
      slot.side = name
      sides.set(name, slot)
      if (!slot.fresh) return undefined
      if (slot.error !== undefined) return { error: slot.error }
      return slot.value === undefined ? undefined : { value: slot.value }
    }
    if (before) drop(before)
    const slot = watch(ref, args)
    slot.side = name
    sides.set(name, slot)
    return undefined
  }

  /** Runs `slots` again from fresh subscriptions (Convex never keeps a
      failed run). */
  function rerun(list: readonly Slot[]) {
    for (const slot of list) {
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
  }

  const stopTransitions = live.onTransition((transition) => {
    if (stopped) return
    lastAt = Math.max(lastAt, transition.at)
    if (connection !== null && transition.connection !== connection)
      for (const slot of slots.values()) slot.fresh = false
    connection = transition.connection
    let news: PartsReport['sides']
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
      if (slot.side) {
        news ??= {}
        news[slot.side] = error === undefined ? { value } : { error }
      } else {
        // a side query never holds the workspace, so it is no progress
        progress = true
        // a task window's answer moves the share until the load ends, and
        // the complete report after it holds the tasks
        if (slot.task) tasksDirty = true
        else dirty = true
      }
    }
    settle({ news, progress })
  })

  root = watch(api.workspace.root, ROOT_ARGS)
  // the wait runs from the start, so a root that never answers fails too
  watchStall(true, false)

  return {
    /** Subscribes every organization's task windows, once: at once when no
        part waits for its answer, else at the first settle in which none
        does, so no window queues behind running project windows. Each
        organization's windows are sized from the root part's current
        answer. The stall check runs from here, so windows that never answer
        stop the task load STALL.ms later. */
    askTasks() {
      if (asked || stopped) return
      asked = true
      const answer = rootAnswer()
      if (answer !== undefined && !waiting()) startTasks(answer)
      else askWaits = true
      settle()
    },
    /** Runs the task windows that failed again from fresh subscriptions,
        and after a stall the ones with no current answer, while the task
        load has not completed. Answers whether there was one. */
    retryTasks(): boolean {
      if (completed || !asked) return false
      const failed = [...neededTasks()].filter(
        (slot) => errorOf(slot) !== undefined || (tasksStalled && !slot.fresh),
      )
      tasksStalled = false
      rerun(failed)
      if (failed.length > 0) settle()
      return failed.length > 0
    },
    /** Runs every failed part the workspace needs again, from a fresh
        subscription (Convex never keeps a failed run), task windows
        included. Answers whether there was one. */
    retry(): boolean {
      const failed = [...neededParts(), ...neededTasks()].filter(
        (slot) => errorOf(slot) !== undefined,
      )
      rerun(failed)
      if (failed.length > 0) settle()
      return failed.length > 0
    },
    watchSide,
    /** The arguments side `name` watches with, or undefined while it does
        not run. */
    sideArgs: (name: SideName): Record<string, Value> | undefined => sides.get(name)?.args,
    /** Stops the side query `name`, and keeps the others. */
    stopSide(name: SideName) {
      const slot = sides.get(name)
      if (slot) drop(slot)
      sides.delete(name)
    },
    /** Stops every subscription, the side queries included. */
    stop() {
      stopped = true
      stopTransitions()
      if (stallTimer) clearTimeout(stallTimer)
      // a Map lets its loop delete the entry it is on
      for (const slot of slots.values()) drop(slot)
      orgs.clear()
      sides.clear()
    },
  }
}

export type LiveParts = ReturnType<typeof createLiveParts>

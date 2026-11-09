import { getFunctionName } from 'convex/server'
import { act, type ReactNode, useLayoutEffect, useState } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, expect, vi } from 'vitest'
import type { BoardAnswer } from '../../convex/lib/board'
import type { AgendaAnswer } from '../../convex/lib/teamSyncAgenda'
import type { RevealRequest } from '../lib/reveal'
import { type BoardArgs, boardStandIn, type ForcedBoard } from '../store/boardStandIn.setup'
import {
  answerMilestones,
  type ForcedMilestones,
  isMilestoneRead,
} from '../store/milestoneStandIn.setup'
import type { OverviewQuery } from '../store/overviewLists'
import {
  type ForcedOverview,
  type OverviewArgs,
  overviewStandIn,
} from '../store/overviewStandIn.setup'
import { type OwnerLoadsArgs, ownerLoadsStandIn } from '../store/ownerLoadsStandIn.setup'
import { isOwnerPickerRead, ownerPickersStandIn } from '../store/ownerPickersStandIn.setup'
import { peopleSettingsStandIn } from '../store/peopleSettingsStandIn.setup'
import type { IssueFilters, ScopeInfo } from '../store/planner'
import { plannerFixture, type Snapshot, underProgram } from '../store/plannerFixture.setup'
import {
  answerProjectNav,
  type ForcedProjectNav,
  isProjectNavRead,
  type ProjectNavRead,
} from '../store/projectNavStandIn.setup'
import { answerRoadmap, type ForcedRoadmap } from '../store/roadmapStandIn.setup'
import { type ForcedSync, type SyncArgs, teamSyncStandIn } from '../store/teamSyncStandIn.setup'

/* The Board on the real store for jsdom tests. A test file mocks
   ../lib/convex with `network` and ../lib/auth as memoRows.test.tsx does,
   then loads the store with loadBoard and renders board() in its own root.
   Writes never answer, so an edit stays applied locally. The Board's query
   (tasks:board) answers from the snapshot through the shared stand-in
   (store/boardStandIn.setup.ts), at once and again on each delivery, unless
   a test holds, forces or fails it (`server`), and so do the owner loads
   the delays of tasks only its answer brings read (planning:ownerLoads,
   store/ownerLoadsStandIn.setup.ts), past `server.unavailable`, unless a
   test holds or fails them (`server.holdLoads`, `server.failLoads`). The
   Overview's queries (overview:summary, risk, attention and paused) answer
   through their stand-in (store/overviewStandIn.setup.ts) the same way,
   unless a test holds, forces, fails or edits them (`server.overview`), so
   renderView can show the Overview over the same store. Team sync's agenda
   (teamSync:agenda) answers through its stand-in
   (store/teamSyncStandIn.setup.ts) the same way (`server.sync`), and its
   last comments with none, so renderView can show Team sync too. So do the
   Roadmap's two reads (tasks:roadmap and tasks:roadmapDependencies,
   store/roadmapStandIn.setup.ts, `server.roadmap`), so renderView shows the
   Roadmap from the server's answer too, and the milestone reads
   (milestones:get, section and between, store/milestoneStandIn.setup.ts,
   `server.milestones`), from the snapshot's milestones, which no workspace
   part sends, so the Roadmap shows its flags from its range read. A
   task's people pickers (pickers:taskOwners, syncRecipients and
   canOwn) answer through their stand-in
   (store/ownerPickersStandIn.setup.ts, `server.owners`), and people:byIds
   through store/peopleSettingsStandIn.setup.ts, so the owner lists and
   Team sync's Mention window list people; every other one-shot read
   answers null. The store holds nobody but the signed-in person (the
   live double's root, convex/lib/workspaceJoin.ts rootOf), so everyone
   else the views name reaches it through people:byIds, and
   `server.people` holds back, fails or empties those answers, so a test
   reaches a person who is loading, failed or gone. */

type Network = {
  mutation: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
  onUpdate: ReturnType<typeof vi.fn>
}
type Row = Snapshot['issues'][number]
/** What renders beside the Board for the task it opened, given a close and
    a way to open another task. */
type Window = (opened: string | null, close: () => void, open: (id: string) => void) => ReactNode

const AT = '2026-09-14T08:00:00.000Z'

/** A test's budget on the Board, below vitest.config.mts's 60 s default.
    On 2 November 2026 the Board cases that use it took 1.6 s at most each
    under a shard's load on a Boat sandbox. */
export const BOARD_TEST_TIMEOUT = 20_000

/* The test-build probe of the store the last loadBoard loaded. */
let lastProbe: { faults(): unknown[] } | null = null

/* After each case of a file that uses loadBoard: the store reported no
   fault (store/planner.ts reportFault), so no write went out on a path that
   needs every task before an ask and no paint threw. A case that expects a
   fault reads it from `probe.faults()`, which forgets it. */
afterEach(() => {
  const probe = lastProbe
  lastProbe = null
  if (probe) expect(probe.faults()).toEqual([])
})

/** A task row in the fixture's one project, owned by its one person. */
export function taskRow(snapshot: Snapshot, id: string, status: Row['status'], num: number): Row {
  return {
    id,
    org_id: snapshot.orgs[0].id,
    project_id: snapshot.projects[0].id,
    num,
    title: `Task ${id}`,
    description: '',
    status,
    priority: 'medium',
    assignee_id: snapshot.profiles[0].id,
    created_at: AT,
    updated_at: AT,
    paused: false,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  }
}

/** A top-level project, Plan, over three sub-projects, the fixture's and
    two more, with `perSub` tasks in each, numbered from 1 across them and
    To Do unless `statusOf` gives task number n another status: from 101 a
    sub-project, more cards than one Board mounts at once (SYNC_LIMIT).
    Keep within the design size: 300 open and 150 Done tasks a sub-project,
    and 800 open and 200 Done tasks in the project, so at most 266 open
    tasks a sub-project. The Board shows it with `scope: 'plan'`. */
export const spread =
  (perSub: number, statusOf: (num: number) => Row['status'] = () => 'todo') =>
  (snap: Snapshot) => {
    const base = snap.projects[0]
    snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
    Object.assign(base, { parent_id: 'plan', name: 'One' })
    snap.projects.push(
      { ...base, id: 'two', key: 'TWO', num: 3, name: 'Two' },
      { ...base, id: 'three', key: 'THR', num: 4, name: 'Three' },
    )
    let num = 0
    for (const project of [base.id, 'two', 'three'])
      for (let n = 0; n < perSub; n++) {
        num++
        snap.issues.push({ ...taskRow(snap, `t${num}`, statusOf(num), num), project_id: project })
      }
  }

/** Boots a fresh store on the fixture with the tasks `prepare` adds, and
    returns it with the Board and a way to deliver a changed snapshot. The
    Board is drawn in the `metaViz` layout, or as the phone's task list,
    over the project `scope` (by default the fixture's one project). The
    store boots without the workspace's tasks, as the app does, unless
    `tasks` asks for every task at boot; a case that tests the Board over
    tasks the workspace holds asks (`ask`). */
export async function loadBoard(
  network: Network,
  prepare: (snapshot: Snapshot) => void,
  { metaViz = 'swimlanes', phone = false, scope: scopeId = '', tasks = false } = {},
) {
  vi.resetModules()
  const { TASKS } = await import('../store/liveParts')
  TASKS.atBoot = tasks
  const snapshot = plannerFixture()
  prepare(snapshot)
  // the fixture's project as a sub-project, which the Board's query answers,
  // unless the test placed it
  if (snapshot.projects[0].parent_id === undefined && snapshot.projects[0].type !== 'meta')
    underProgram(snapshot)
  let deliver: (snap: Snapshot) => void = () => {}
  /** What the Board's query does: `hold` keeps answers back until
      `answer()`, `force` answers a state, `fail` fails the read and `edit`
      changes an answer. */
  const server: {
    hold: boolean
    force: ForcedBoard | null
    fail: unknown
    edit: ((answer: BoardAnswer) => BoardAnswer) | null
    /** the arguments of every subscription, newest last */
    asked: BoardArgs[]
    /** the subscriptions open now */
    open: Set<{ args: BoardArgs; next: (value: unknown) => void; fail?: (e: unknown) => void }>
    /** the owners whose loads answer unavailable */
    unavailable: string[]
    /** whether the owner-load calls wait for `answer()` */
    holdLoads: boolean
    /** what the owner-load calls fail with, while set */
    failLoads: unknown
    /** the owner-load calls open now */
    loads: Set<{
      args: OwnerLoadsArgs
      next: (value: unknown) => void
      fail?: (e: unknown) => void
    }>
    /** the Overview's queries: `hold` keeps their answers back, or those
        of the queries it names, `force` answers states the workspace
        cannot reach, `fail` fails a query `failing` names, `edit` changes
        an answer, `asked` is every subscription's query and arguments,
        newest last, and `open` those
        open now */
    /** the Roadmap's two reads: `hold` keeps their answers back, or those
        of the query it names, `force` answers states the workspace cannot
        reach, `fail` fails them, `ceiling` and `partTasks` lower the
        Roadmap's bounds, `edit` changes an answer, `asked` is every
        subscription's query and arguments, newest last, and `open` those
        open now */
    roadmap: {
      hold: boolean | ((name: string) => boolean)
      force: ForcedRoadmap[]
      fail: unknown
      ceiling?: number
      partTasks?: number
      edit: ((name: string, answer: unknown, args: unknown) => unknown) | null
      asked: { name: string; args: unknown }[]
      open: Set<{
        name: string
        args: unknown
        next: (value: unknown) => void
        fail?: (e: unknown) => void
      }>
    }
    overview: {
      hold: boolean | ((query: OverviewQuery) => boolean)
      force: ForcedOverview
      fail: unknown
      failing: (query: OverviewQuery, args: OverviewArgs) => boolean
      edit: ((query: OverviewQuery, answer: unknown, args: OverviewArgs) => unknown) | null
      asked: { query: OverviewQuery; args: OverviewArgs }[]
      open: Set<{
        query: OverviewQuery
        args: OverviewArgs
        next: (value: unknown) => void
        fail?: (e: unknown) => void
      }>
    }
    /** Team sync's agenda: `hold` keeps its answers back, `force` answers
        states and unknown figures the workspace cannot reach, `fail`
        fails the read, `edit` changes an answer, `asked` is every
        subscription's arguments, newest last, and `open` those open now */
    sync: {
      hold: boolean
      force: ForcedSync
      fail: unknown
      edit: ((answer: AgendaAnswer, args: SyncArgs) => AgendaAnswer) | null
      asked: SyncArgs[]
      open: Set<{ args: SyncArgs; next: (value: unknown) => void; fail?: (e: unknown) => void }>
    }
    /** the last comments' subscriptions open now, each with its owners */
    comments: Set<{ owners: string[] }>
    /** a task's people pickers (pickers:taskOwners, syncRecipients and
        canOwn) and people:byIds: `force` answers the stand-in's states,
        `asked` is every read's name and arguments, oldest first */
    owners: { force: Set<string>; asked: { name: string; args: unknown }[] }
    /** people.byIds' answers: `hold` keeps them back until `answer()`,
        `force` answers every read failed (`error`) or without any asked
        id (`gone`), and `open` holds the reads open now */
    people: {
      hold: boolean
      force: 'error' | 'gone' | null
      open: Set<{ args: unknown; next: (value: unknown) => void; fail?: (e: unknown) => void }>
    }
    /** the milestone reads: `hold` keeps their answers back, `force`
        answers states the workspace cannot reach, `asked` is every
        subscription's query and arguments, newest last, and `open` those
        open now, which a delivery answers again */
    milestones: {
      hold: boolean
      force: ForcedMilestones
      asked: { name: string; args: unknown }[]
      open: Set<{
        name: string
        args: unknown
        next: (value: unknown) => void
        fail?: (e: unknown) => void
      }>
    }
    /** the navigation reads the views and dialogs subscribe to (children,
        page, search, resolve, targets and holds; the double answers the
        project cache's byIds), which answer from the snapshot through
        their stand-in, `force` forcing its states; `open` holds those open
        now, which a delivery answers again */
    nav: {
      force: ForcedProjectNav
      open: Set<{
        name: ProjectNavRead
        args: unknown
        next: (value: unknown) => void
        fail?: (e: unknown) => void
      }>
    }
  } = {
    hold: false,
    force: null,
    fail: undefined,
    edit: null,
    asked: [],
    open: new Set(),
    unavailable: [],
    holdLoads: false,
    failLoads: undefined,
    loads: new Set(),
    roadmap: {
      hold: false,
      force: [],
      fail: undefined,
      edit: null,
      asked: [],
      open: new Set(),
    },
    overview: {
      hold: false,
      force: {},
      fail: undefined,
      failing: () => true,
      edit: null,
      asked: [],
      open: new Set(),
    },
    sync: { hold: false, force: {}, fail: undefined, edit: null, asked: [], open: new Set() },
    comments: new Set(),
    owners: { force: new Set(), asked: [] },
    people: { hold: false, force: null, open: new Set() },
    milestones: { hold: false, force: {}, asked: [], open: new Set() },
    nav: { force: {}, open: new Set() },
  }
  /** Answers people:byIds read `read` from the snapshot as it is now, with
      the state the test forces. */
  const answerPeople = (read: {
    args: unknown
    next: (value: unknown) => void
    fail?: (e: unknown) => void
  }) => {
    try {
      read.next(
        peopleSettingsStandIn(
          snapshot,
          'people:byIds',
          read.args as Record<string, unknown>,
          server.people.force ? { byIds: server.people.force } : {},
        ),
      )
    } catch (e) {
      read.fail?.(e)
    }
  }
  /* What the caller reads and writes by the server's rule, the navigation
     reads' levels (store/oracleScope.setup.ts oracleLevels) judged from the
     snapshot as it is now, once per answer: the store holds no project, so
     its own canSee and canWrite know only the projects its cache named. */
  let serverRule = () => ({
    sees: (_id: string) => true,
    writes: (_id: string) => true,
  })
  /** Answers Team sync subscription `sub` from the snapshot as it is now,
      or fails it. */
  const answerSync = (sub: {
    args: SyncArgs
    next: (value: unknown) => void
    fail?: (e: unknown) => void
  }) => {
    const s = server.sync
    if (s.fail !== undefined) return sub.fail?.(s.fail)
    const { sees, writes } = serverRule()
    const answer = teamSyncStandIn(snapshot, sub.args, { sees, writes, force: s.force })
    sub.next(structuredClone(s.edit ? s.edit(answer, sub.args) : answer))
  }
  /** Answers Roadmap subscription `sub` from the snapshot as it is now, or
      fails it, as the test says. */
  const answerRoadmapSub = (sub: {
    name: string
    args: unknown
    next: (value: unknown) => void
    fail?: (e: unknown) => void
  }) => {
    const r = server.roadmap
    if (r.fail !== undefined) return sub.fail?.(r.fail)
    const { sees, writes } = serverRule()
    const answer = answerRoadmap(snapshot, sub.name, sub.args, {
      sees,
      canEdit: writes,
      force: r.force,
      ceiling: r.ceiling,
      partTasks: r.partTasks,
    })
    sub.next(structuredClone(r.edit ? r.edit(sub.name, answer, sub.args) : answer))
  }
  /** Answers owner-load call `call` from the snapshot as it is now, or
      fails it, as the test says. */
  const answerLoads = (call: {
    args: OwnerLoadsArgs
    next: (value: unknown) => void
    fail?: (e: unknown) => void
  }) =>
    server.failLoads !== undefined
      ? call.fail?.(server.failLoads)
      : call.next(ownerLoadsStandIn(snapshot, call.args, { unavailable: server.unavailable }))
  const answerOf = (args: BoardArgs): BoardAnswer => {
    const { sees } = serverRule()
    const answer = boardStandIn(snapshot, args, { sees, force: server.force ?? undefined })
    return server.edit ? server.edit(answer) : answer
  }
  /** Answers Overview subscription `sub` from the snapshot as it is now,
      or fails it: as the test says, or where its stand-in refuses a
      position. */
  const answerOverview = (sub: {
    query: OverviewQuery
    args: OverviewArgs
    next: (value: unknown) => void
    fail?: (e: unknown) => void
  }) => {
    const o = server.overview
    if (o.fail !== undefined && o.failing(sub.query, sub.args)) return sub.fail?.(o.fail)
    let answer: unknown
    const { sees } = serverRule()
    try {
      answer = overviewStandIn(snapshot, sub.query, sub.args, { sees, force: o.force })
    } catch (error) {
      return sub.fail?.(error)
    }
    sub.next(structuredClone(o.edit ? o.edit(sub.query, answer, sub.args) : answer))
  }
  /** Answers milestone subscription `sub` from the snapshot as it is now,
      with the states the test forces. */
  const answerMilestoneSub = (sub: {
    name: string
    args: unknown
    next: (value: unknown) => void
    fail?: (e: unknown) => void
  }) => answerMilestones(snapshot, sub.name, sub.args, sub.next, sub.fail, server.milestones.force)
  /** Answers every open subscription of the Board's query from the
      snapshot as it is now, and the other views' reads. */
  const answerBoards = () => {
    for (const sub of server.open)
      if (server.fail !== undefined) sub.fail?.(server.fail)
      else sub.next(structuredClone(answerOf(sub.args)))
    for (const call of server.loads) answerLoads(call)
    for (const sub of server.overview.open) answerOverview(sub)
    for (const sub of server.sync.open) answerSync(sub)
    for (const sub of server.roadmap.open) answerRoadmapSub(sub)
    if (!server.milestones.hold) for (const sub of server.milestones.open) answerMilestoneSub(sub)
    if (!server.people.hold) for (const read of server.people.open) answerPeople(read)
    for (const sub of server.nav.open)
      answerProjectNav(snapshot, sub.name, sub.args, sub.next, sub.fail, {
        force: server.nav.force,
      })
  }
  // a task's people pickers answer through their stand-in, and every other
  // one-shot read with nothing
  network.query.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    if (!isOwnerPickerRead(name)) return null
    server.owners.asked.push({ name, args })
    return structuredClone(ownerPickersStandIn(snapshot, name, args, server.owners.force))
  })
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'people:byIds') {
      server.owners.asked.push({ name, args })
      const read = { args, next, fail }
      server.people.open.add(read)
      if (!server.people.hold) answerPeople(read)
      return () => server.people.open.delete(read)
    }
    if (name === 'workspace:whole') {
      deliver = (snap) => next(structuredClone(snap))
      deliver(snapshot)
    } else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'tasks:board') {
      const sub = { args: args as BoardArgs, next, fail }
      server.asked.push(sub.args)
      server.open.add(sub)
      if (!server.hold)
        if (server.fail !== undefined) fail?.(server.fail)
        else next(structuredClone(answerOf(sub.args)))
      return () => server.open.delete(sub)
    }
    if (name === 'tasks:roadmap' || name === 'tasks:roadmapDependencies') {
      const sub = { name, args, next, fail }
      server.roadmap.asked.push({ name, args })
      server.roadmap.open.add(sub)
      const hold = server.roadmap.hold
      if (!(typeof hold === 'function' ? hold(name) : hold)) answerRoadmapSub(sub)
      return () => server.roadmap.open.delete(sub)
    }
    if (isMilestoneRead(name)) {
      const sub = { name, args, next, fail }
      server.milestones.asked.push({ name, args })
      server.milestones.open.add(sub)
      if (!server.milestones.hold) answerMilestoneSub(sub)
      return () => server.milestones.open.delete(sub)
    }
    if (name === 'planning:ownerLoads') {
      const call = { args: args as OwnerLoadsArgs, next, fail }
      server.loads.add(call)
      if (!server.holdLoads) answerLoads(call)
      return () => server.loads.delete(call)
    }
    if (name === 'teamSync:agenda') {
      const sub = { args: args as SyncArgs, next, fail }
      server.sync.asked.push(sub.args)
      server.sync.open.add(sub)
      if (!server.sync.hold) answerSync(sub)
      return () => server.sync.open.delete(sub)
    }
    if (isProjectNavRead(name) && name !== 'projectNav:byIds') {
      const sub = { name, args, next, fail }
      server.nav.open.add(sub)
      answerProjectNav(snapshot, name, args, next, fail, { force: server.nav.force })
      return () => server.nav.open.delete(sub)
    }
    if (name === 'teamSync:lastComments') {
      const sub = { owners: [...((args as { owner_ids: string[] }).owner_ids ?? [])] }
      server.comments.add(sub)
      next({ rows: [], complete: true })
      return () => server.comments.delete(sub)
    }
    if (name.startsWith('overview:')) {
      const sub = {
        query: name.slice('overview:'.length) as OverviewQuery,
        args: args as OverviewArgs,
        next,
        fail,
      }
      server.overview.asked.push({ query: sub.query, args: sub.args })
      server.overview.open.add(sub)
      const hold = server.overview.hold
      if (!(typeof hold === 'function' ? hold(sub.query) : hold)) answerOverview(sub)
      return () => server.overview.open.delete(sub)
    }
    return () => {}
  })
  network.mutation.mockImplementation((ref) =>
    getFunctionName(ref) === 'identity:claimMySeats'
      ? Promise.resolve(null)
      : new Promise(() => {}),
  )
  const store = await import('../store/planner')
  await store.initStore()
  // the scope opens as App opens it from a row, its facts seeded and
  // named with the project cache, which answers from the whole
  const { openScope, oracleLevels } = await import('../store/oracleScope.setup')
  openScope(store.P, snapshot, scopeId || snapshot.projects[0].id)
  lastProbe = store.__layerProbe
  serverRule = () => {
    const levels = oracleLevels(snapshot)
    return {
      sees: (id) => levels.has(id),
      writes: (id) => levels.get(id) === 'lead' || levels.get(id) === 'user',
    }
  }
  const { usePlannerVersion } = await import('../store/usePlannerVersion')
  const { TooltipProvider } = await import('../components/ui/tooltip')
  const { Kanban } = await import('./Kanban')
  const { MobileTaskList } = await import('../components/MobileWorkspace')
  const { P } = store
  const scope = scopeId || snapshot.projects[0].id
  let setSearch: (text: string) => void = () => {}
  let setRow: (row: Partial<IssueFilters>) => void = () => {}
  let setReveal: (request: RevealRequest | null) => void = () => {}
  let reveals = 0
  // the Board's other actions, which tests read
  const board: Record<string, ReturnType<typeof vi.fn>> = {
    setScope: vi.fn(),
    openProject: vi.fn(),
    openPalette: vi.fn(),
    clearFilters: vi.fn(),
    newIssue: vi.fn(),
    newProject: vi.fn(),
  }
  // how many reveal requests the Board took
  const consumed = { count: 0 }
  /** The Board as App renders it, again on every store change. `window`
      renders beside it in the same root, with the task the Board opened. */
  function Screen({ window }: { window?: Window }) {
    usePlannerVersion()
    const [opened, setOpened] = useState<string | null>(null)
    const [search, typeSearch] = useState('')
    const [row, changeRow] = useState<IssueFilters>({
      mine: false,
      assignees: [],
      priority: null,
      stale: false,
      focus: false,
      search: '',
    })
    const [revealTask, revealIt] = useState<RevealRequest | null>(null)
    useLayoutEffect(() => {
      setSearch = typeSearch
      setRow = (next) => changeRow((was) => ({ ...was, ...next }))
      setReveal = revealIt
    }, [])
    const filters = { ...row, search }
    const info = P.scopeInfo(scope)
    const actions = { ...board, openIssue: setOpened as (...args: unknown[]) => void }
    return (
      <TooltipProvider>
        {phone ? (
          <MobileTaskList
            info={info}
            filters={{ ...filters, search }}
            setFilters={() => {}}
            actions={actions}
            revealTask={revealTask}
            onRevealConsumed={() => {
              consumed.count++
              revealIt(null)
            }}
          />
        ) : (
          <Kanban
            info={info}
            filters={{ ...filters, search }}
            tweaks={{ metaViz }}
            actions={actions}
            revealTask={revealTask}
            onRevealConsumed={() => {
              consumed.count++
              revealIt(null)
            }}
          />
        )}
        {window?.(opened, () => setOpened(null), setOpened)}
      </TooltipProvider>
    )
  }
  /** Another view over the same scope, again on every store change. */
  function View({ view }: { view: (info: ScopeInfo) => ReactNode }) {
    usePlannerVersion()
    const info = P.scopeInfo(scope)
    return <TooltipProvider>{view(info)}</TooltipProvider>
  }
  return {
    P,
    /** The store's test-build probe (store/planner.ts __layerProbe). */
    probe: store.__layerProbe,
    snapshot,
    /** The Board's row for the task stored as `uuid`; the Board names a
        task by its key, also one only the Board's answer brings
        (P.handleNow). */
    card: (uuid: string) => {
      const row = snapshot.issues.find((it) => it.id === uuid)
      const handle =
        P.handleOf(uuid) ??
        P.viewTask('board:desktop', uuid)?.id ??
        P.viewTask('board:phone', uuid)?.id ??
        (row ? P.handleNow(uuid, row.org_id, row.num) : undefined)
      return document.querySelector<HTMLElement>(`[data-card="${handle}"]`)
    },
    /** Asks the Board to reveal the task `id`, as App does for a jump;
        `atOnce` as the phone's crumb does. */
    reveal: (id: string, atOnce?: boolean) =>
      act(async () => setReveal({ id, n: ++reveals, atOnce })),
    /** Types `text` into the Board's search filter. */
    search: (text: string) => act(async () => setSearch(text)),
    /** Sets fields of the filter row other than the search. */
    filter: (row: Partial<IssueFilters>) => act(async () => setRow(row)),
    /** Delivers `snapshot` as it is now, as the server would after a
        change, and then the Board's answer for it. */
    deliver: () =>
      act(async () => {
        deliver(snapshot)
        if (!server.hold) answerBoards()
      }),
    /** The Board's query as the server answers it (see `server` above). */
    server,
    /** The Board's actions other than opening a task, as mocks. */
    actions: board,
    /** How many reveal requests the Board took. */
    consumed,
    /** Answers the Board's open subscriptions now, as after a hold. */
    answer: () => act(async () => answerBoards()),
    /** Answers the open people.byIds reads now and nothing else, so a
        case can bring a person's details while the owner loads stay
        held. */
    answerPeople: () =>
      act(async () => {
        for (const read of server.people.open) answerPeople(read)
      }),
    /** Asks for every task, as a page that needs them does, and waits
        until the workspace holds them. */
    ask: () =>
      act(async () => {
        P.askTasks('script')
        for (let i = 0; i < 10 && !P.tasksHeld(); i++)
          await new Promise((resolve) => setTimeout(resolve, 0))
        if (!P.tasksHeld()) throw new Error('every task did not load')
      }),
    render: (root: Root, window?: Window) =>
      act(async () => root.render(<Screen window={window} />)),
    /** Renders `view` for the scope in place of the Board. A test imports
        the view after loadBoard, so it shares this store. */
    renderView: (root: Root, view: (info: ScopeInfo) => ReactNode) =>
      act(async () => root.render(<View view={view} />)),
  }
}

/** loadBoard, then an ask for every task (`ask`), for the suites whose
    cases test the Board over tasks the workspace holds: a task window's
    edits, drags, reveals, focus and the Roadmap. */
export async function loadBoardWithTasks(...args: Parameters<typeof loadBoard>) {
  const board = await loadBoard(...args)
  await board.ask()
  return board
}

/* The data of the drag in progress. As in a browser, every event of one
   drag carries the same transfer, from its dragstart on. */
let dragData = new Map<string, string>()

/** A drag event of `type` jsdom can carry. A dragstart begins a new drag. */
export function dragEvent(type: string) {
  if (type === 'dragstart') dragData = new Map()
  const data = dragData
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      effectAllowed: 'all',
      dropEffect: 'none',
      get types() {
        return [...data.keys()]
      },
      setData: (format: string, value: string) => data.set(format, value),
      getData: (format: string) => data.get(format) ?? '',
    },
  })
  return event
}

/** The Board cell of `status` in the pooled lane. */
export const cell = (status: string) =>
  document.querySelector<HTMLElement>(`[data-board-cell][data-status="${status}"]`)

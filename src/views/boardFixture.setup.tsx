import { getFunctionName } from 'convex/server'
import { act, type ReactNode, useLayoutEffect, useState } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, expect, vi } from 'vitest'
import type { RevealRequest } from '../lib/reveal'
import { type ServerRule, viewReadsOver } from '../store/guard/viewReads.setup'
import type { IssueFilters, ScopeInfo } from '../store/planner'
import { plannerFixture, type Snapshot, underProgram } from '../store/plannerFixture.setup'

/* The Board on the real store for jsdom tests. A test file mocks
   ../lib/convex with `network` and ../lib/auth as memoRows.test.tsx does,
   then loads the store with loadBoard and renders board() in its own root.
   Writes never answer, so an edit stays applied locally. The views' reads
   (the Board's, the owner loads, the Overview's, Team sync's, the
   Roadmap's, the milestones', the navigation reads, people:byIds and a
   task's people pickers) answer from the snapshot through the shared
   stand-ins (store/guard/viewReads.setup.ts), at once and again on each
   delivery, unless a test holds, forces, fails or edits them (`server`),
   so renderView shows the Overview, Team sync and the Roadmap over the
   same store. Every other one-shot read answers null. The store holds
   nobody but the signed-in person (the live double's root,
   convex/lib/workspaceJoin.ts rootOf), so everyone else the views name
   reaches it through people:byIds. */

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
   fault (store/planner.ts reportFault), so no paint threw. A case that
   expects a fault reads it from `probe.faults()`, which forgets it. */
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
    store boots as the app does, and the Board shows the tasks of its
    answer. */
export async function loadBoard(
  network: Network,
  prepare: (snapshot: Snapshot) => void,
  { metaViz = 'swimlanes', phone = false, scope: scopeId = '' } = {},
) {
  vi.resetModules()
  const snapshot = plannerFixture()
  prepare(snapshot)
  // the fixture's project as a sub-project, which the Board's query answers,
  // unless the test placed it
  if (snapshot.projects[0].parent_id === undefined && snapshot.projects[0].type !== 'meta')
    underProgram(snapshot)
  let deliver: (snap: Snapshot) => void = () => {}
  // the views' reads, judged by the server's rule once the store booted
  let serverRule: () => ServerRule = () => ({ sees: () => true, writes: () => true })
  const views = viewReadsOver(snapshot, () => serverRule())
  const { server } = views
  // a task's people pickers answer through their stand-in, and every other
  // one-shot read with nothing
  network.query.mockImplementation(async (ref, args) => views.query(getFunctionName(ref), args))
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      deliver = (snap) => next(structuredClone(snap))
      deliver(snapshot)
      return () => {}
    }
    if (name === 'snapshot:threadComments') {
      next({ comments: [], earlier: false })
      return () => {}
    }
    return views.watch(name, args, next, fail) ?? (() => {})
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
        task by the handle of its model (P.handleNow). */
    card: (uuid: string) => {
      const row = snapshot.issues.find((it) => it.id === uuid)
      const handle =
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
        if (!server.hold) views.answerAll()
      }),
    /** The Board's query as the server answers it (see `server` above). */
    server,
    /** The Board's actions other than opening a task, as mocks. */
    actions: board,
    /** How many reveal requests the Board took. */
    consumed,
    /** Answers the Board's open subscriptions now, as after a hold. */
    answer: () => act(async () => views.answerAll()),
    /** Answers the open people.byIds reads now and nothing else, so a
        case can bring a person's details while the owner loads stay
        held. */
    answerPeople: () =>
      act(async () => {
        for (const read of server.people.open) views.answerPeople(read)
      }),
    render: (root: Root, window?: Window) =>
      act(async () => root.render(<Screen window={window} />)),
    /** Renders `view` for the scope in place of the Board. A test imports
        the view after loadBoard, so it shares this store. */
    renderView: (root: Root, view: (info: ScopeInfo) => ReactNode) =>
      act(async () => root.render(<View view={view} />)),
  }
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

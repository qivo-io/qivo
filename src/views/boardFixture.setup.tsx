import { getFunctionName } from 'convex/server'
import { act, type ReactNode, useLayoutEffect, useState } from 'react'
import type { Root } from 'react-dom/client'
import { vi } from 'vitest'
import type { BoardAnswer } from '../../convex/lib/board'
import type { RevealRequest } from '../lib/reveal'
import { type BoardArgs, boardStandIn, type ForcedBoard } from '../store/boardStandIn.setup'
import type { IssueFilters, ScopeInfo } from '../store/planner'
import { plannerFixture, type Snapshot, underProgram } from '../store/plannerFixture.setup'

/* The Board on the real store for jsdom tests. A test file mocks
   ../lib/convex with `network` and ../lib/auth as memoRows.test.tsx does,
   then loads the store with loadBoard and renders board() in its own root.
   Writes never answer, so an edit stays applied locally. The Board's query
   (tasks:board) answers from the snapshot through the shared stand-in
   (store/boardStandIn.setup.ts), at once and again on each delivery, unless
   a test holds, forces or fails it (`server`). */

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

/** A test's budget on the Board: booting the store and drawing the Board
    with a task window takes about three seconds alone, and more on a busy
    shared machine than the default five allow. */
export const BOARD_TEST_TIMEOUT = 20_000

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

/** Boots a fresh store on the fixture with the tasks `prepare` adds, and
    returns it with the Board and a way to deliver a changed snapshot. The
    Board is drawn in the `metaViz` layout, or as the phone's task list,
    over the project `scope` (by default the fixture's one project). */
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
  } = { hold: false, force: null, fail: undefined, edit: null, asked: [], open: new Set() }
  // the store's canSee, once the store loaded
  let sees: (id: string) => boolean = () => true
  const answerOf = (args: BoardArgs): BoardAnswer => {
    const answer = boardStandIn(snapshot, args, { sees, force: server.force ?? undefined })
    return server.edit ? server.edit(answer) : answer
  }
  /** Answers every open subscription of the Board's query from the
      snapshot as it is now. */
  const answerBoards = () => {
    for (const sub of server.open)
      if (server.fail !== undefined) sub.fail?.(server.fail)
      else sub.next(structuredClone(answerOf(sub.args)))
  }
  network.query.mockResolvedValue(null)
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
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
    return () => {}
  })
  network.mutation.mockImplementation((ref) =>
    getFunctionName(ref) === 'identity:claimMySeats'
      ? Promise.resolve(null)
      : new Promise(() => {}),
  )
  const store = await import('../store/planner')
  await store.initStore()
  sees = (id) => store.P.canSee(id)
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
    if (!info) throw new Error('missing the scope')
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
    if (!info) throw new Error('missing the scope')
    return <TooltipProvider>{view(info)}</TooltipProvider>
  }
  return {
    P,
    snapshot,
    /** The Board's row for the task stored as `uuid`; the Board names a
        task by its key. */
    card: (uuid: string) =>
      document.querySelector<HTMLElement>(
        `[data-card="${P.issues.find((it) => it.uuid === uuid)?.id}"]`,
      ),
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

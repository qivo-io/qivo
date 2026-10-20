// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IssueVM } from '../store/planner'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The Board's cards and the Roadmap's rows on the real store skip a task
   whose view model kept its identity (store/repaint.test.ts). The owner's
   portrait renders once per task row, so the test counts its renders per
   task: a delivery that renames one task renders that task's row again and
   no other, and a change every row reads (a person's name) renders them
   all. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))
const portraits = vi.hoisted(() => ({ rendered: [] as string[] }))
vi.mock('@/components/AssigneeAvatar', () => ({
  AssigneeAvatar: ({ issue }: { issue: IssueVM }) => {
    portraits.rendered.push(issue.uuid)
    return null
  },
}))

const AT = '2026-09-14T08:00:00.000Z'
const TASKS = ['one', 'two', 'three']
const noop = () => {}

let snapshot: Snapshot
let deliver: (snap: Snapshot) => void
let container: HTMLDivElement
let root: Root

/* Boots a fresh store on three tasks, then loads the views on it. */
async function load() {
  vi.resetModules()
  snapshot = plannerFixture()
  for (const [n, id] of TASKS.entries())
    snapshot.issues.push({
      id,
      org_id: snapshot.orgs[0].id,
      project_id: snapshot.projects[0].id,
      num: n + 1,
      title: `Task ${id}`,
      description: '',
      status: 'todo',
      priority: 'medium',
      assignee_id: snapshot.profiles[0].id,
      created_at: AT,
      updated_at: AT,
      paused: false,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
  network.query.mockResolvedValue(null)
  network.onUpdate.mockImplementation((ref, _args, next) => {
    if (getFunctionName(ref) === 'snapshot:forMe') {
      deliver = (snap) => next(structuredClone(snap))
      deliver(snapshot)
    }
    return () => {}
  })
  network.mutation.mockImplementation((ref) =>
    getFunctionName(ref) === 'identity:claimMySeats' ? Promise.resolve(null) : new Promise(noop),
  )
  const store = await import('../store/planner')
  await store.initStore()
  return {
    P: store.P,
    usePlannerVersion: (await import('../store/usePlannerVersion')).usePlannerVersion,
    TooltipProvider: (await import('../components/ui/tooltip')).TooltipProvider,
    BoardCard: (await import('./kanbanCards')).BoardCard,
    groupBoardCell: (await import('../lib/boardGroups')).groupBoardCell,
    TimelineRow: (await import('./roadmap/TimelineRow')).TimelineRow,
  }
}
type Loaded = Awaited<ReturnType<typeof load>>

/* Renders `view` again on every store change, as App does. */
async function mount(view: (loaded: Loaded) => ReactNode) {
  const loaded = await load()
  const { usePlannerVersion, TooltipProvider } = loaded
  function Screen() {
    usePlannerVersion()
    return <TooltipProvider>{view(loaded)}</TooltipProvider>
  }
  await act(async () => root.render(<Screen />))
}

/* The tasks whose rows rendered while `change` was delivered. */
async function renderedBy(change: (snap: Snapshot) => void) {
  portraits.rendered = []
  change(snapshot)
  await act(async () => deliver(snapshot))
  return [...portraits.rendered].sort()
}

const rename = (id: string) => (snap: Snapshot) => {
  snap.issues.find((issue) => issue.id === id)!.title = `Renamed ${id}`
}
const renamePerson = (snap: Snapshot) => {
  snap.profiles[0].name = 'Someone else'
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/* The Board's cards as Kanban renders them. */
const board = ({ P, BoardCard, groupBoardCell }: Loaded) =>
  groupBoardCell(P.issues, P.issueById).map((group) => (
    <BoardCard
      key={group.key}
      group={group}
      place={() => null}
      dimmed={false}
      onOpen={noop}
      onDragStart={noop}
      onDragEnd={noop}
      dragId={null}
      context={P.contextVersion}
      stale={group.issues
        .filter((it) => P.isStale(it))
        .map((it) => it.id)
        .join()}
    />
  ))

describe('memoized task rows', () => {
  it('render a Board card again only for the task that changed', async () => {
    await mount(board)
    expect(await renderedBy(rename('two'))).toEqual(['two'])
    expect(await renderedBy(() => {})).toEqual([])
    expect(await renderedBy(renamePerson)).toEqual(['one', 'three', 'two'])
  })

  it('render a Board card again once its task turns stale', async () => {
    // a minute before the tasks, last updated at AT, are 120 days old
    const stale = Date.parse(AT) + 120 * 86_400_000
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(stale - 60_000)
      await mount(board)
      vi.setSystemTime(stale + 60_000)
      // the next delivery renders every card whose task crossed the age
      expect(await renderedBy(rename('two'))).toEqual(['one', 'three', 'two'])
      expect(await renderedBy(rename('one'))).toEqual(['one'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('render a Roadmap row again only for the task that changed', async () => {
    // rows show their controls once the observer reports them near the view
    const observer = {
      setRoot: noop,
      observe: (_: Element, show: () => void) => {
        show()
        return noop
      },
      dispose: noop,
    }
    await mount(({ P, TimelineRow }) => {
      const proj = P.projects[0]
      return P.issues.map((issue, n) => (
        <TimelineRow
          key={issue.uuid}
          row={{ kind: 'task', pid: proj.id, proj, issue }}
          top={n * 35}
          h={34}
          remH={0}
          open
          planning={false}
          revealing={false}
          fade={1}
          due={null}
          start={issue.start}
          end={issue.end}
          w0={0}
          w1={12}
          weekW={36}
          timelineW={468}
          hasSubHeads={false}
          context={P.contextVersion}
          observer={observer}
          guidesKey=""
          renderGuides={() => null}
          onToggle={noop}
          onScope={noop}
          onOpen={noop}
          onSchedule={noop}
          onCommit={noop}
          onEdgeReveal={noop}
        />
      ))
    })
    // hydrated rows show the portrait
    expect(new Set(portraits.rendered)).toEqual(new Set(TASKS))
    expect(await renderedBy(rename('three'))).toEqual(['three'])
    expect(await renderedBy(() => {})).toEqual([])
    expect(await renderedBy(renamePerson)).toEqual(['one', 'three', 'two'])
  })
})

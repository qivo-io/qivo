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
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('../store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))
/* A row renders its owner's portrait each time it renders: a live row
   through AssigneeAvatar, a static Board card through staticOwnerPortrait. */
const portraits = vi.hoisted(() => ({ rendered: [] as string[] }))
vi.mock('@/components/AssigneeAvatar', () => ({
  AssigneeAvatar: ({ issue }: { issue: IssueVM }) => {
    portraits.rendered.push(issue.uuid)
    return null
  },
  OwnerPickList: () => null,
}))
vi.mock('@/components/rowElements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/rowElements')>()),
  staticOwnerPortrait: (_statics: unknown, issue: IssueVM) => {
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

/* Boots a fresh store on three tasks, changed by `prepare`, then loads the
   views on it. */
async function load(prepare: (snap: Snapshot) => void = noop) {
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
  prepare(snapshot)
  network.query.mockResolvedValue(null)
  network.onUpdate.mockImplementation((ref, _args, next) => {
    if (getFunctionName(ref) === 'workspace:whole') {
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
    SyncCard: (await import('./teamSync/SyncCard')).SyncCard,
    TeamOpening: (await import('./teamSync/TeamOpening')).TeamOpening,
    syncDay: (await import('../lib/teamSync')).syncDay,
  }
}
type Loaded = Awaited<ReturnType<typeof load>>

/* The mounted screen, for a render that no store change asks for. */
let Screen: () => ReactNode

/* Renders `view` again on every store change, as App does. */
async function mount(view: (loaded: Loaded) => ReactNode, prepare?: (snap: Snapshot) => void) {
  const loaded = await load(prepare)
  const { usePlannerVersion, TooltipProvider } = loaded
  Screen = function Screen() {
    usePlannerVersion()
    return <TooltipProvider>{view(loaded)}</TooltipProvider>
  }
  await act(async () => root.render(<Screen />))
}

/* The tasks whose rows rendered when the screen rendered again after
   `change`, which changes what the page itself holds. */
async function rerenderedBy(change: () => void) {
  portraits.rendered = []
  change()
  await act(async () => root.render(<Screen />))
  return [...portraits.rendered].sort()
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
  // the reviewer prompt's popover measures its anchor
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
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

  it('render a Team sync card again only for its task and the tasks it is linked to', async () => {
    const blockedByTwo = (snap: Snapshot) => {
      snap.links.push({
        id: 'link-1',
        // stored as the blocker's link
        source_id: 'two',
        target_id: 'one',
        type: 'blocks',
        pair_key: 'one:two',
        created_at: AT,
      })
    }
    // what the page holds besides the store, as TeamSync keeps it
    const page = {
      ticked: new Set<string>(),
      prompt: null as string | null,
      since: 0,
      now: Date.now(),
    }
    await mount(({ P, SyncCard, syncDay }) => {
      // a new page context every render, as TeamSync builds it
      const ctx = {
        owner: P.CURRENT_USER,
        since: page.since,
        now: page.now,
        day: syncDay(page.now),
        mobile: false,
        reviewed: {
          has: (uuid: string) => page.ticked.has(uuid),
          mark: noop,
          toggle: noop,
          count: () => 0,
        },
        stamp: () => {},
        touched: () => {},
        prompt: page.prompt,
        setPrompt: noop,
        onOpenTask: noop,
        onShowTask: noop,
        cards: new Map(),
      }
      return P.issues.map((it) => (
        <SyncCard
          key={it.uuid}
          it={it}
          ctx={ctx}
          context={P.contextVersion}
          lastComment={P.lastComments.get(it.uuid)}
          reviewed={ctx.reviewed.has(it.uuid)}
        />
      ))
    }, blockedByTwo)
    const { P } = await import('../store/planner')
    const handle = (id: string) => P.issues.find((it) => it.uuid === id)!.id
    // nothing changed: no card renders
    expect(await rerenderedBy(noop)).toEqual([])
    // a tick, and the reviewer prompt opening and closing, render that card
    expect(await rerenderedBy(() => page.ticked.add('two'))).toEqual(['two'])
    expect(await rerenderedBy(() => (page.prompt = handle('three')))).toEqual(['three'])
    expect(await rerenderedBy(() => (page.prompt = null))).toEqual(['three'])
    // another reading point or another day renders them all
    expect(await rerenderedBy(() => (page.since = 1))).toEqual(['one', 'three', 'two'])
    expect(await rerenderedBy(() => (page.now += 86_400_000))).toEqual(['one', 'three', 'two'])
    expect(await renderedBy(rename('three'))).toEqual(['three'])
    expect(await renderedBy(() => {})).toEqual([])
    // the blocker is done, so the card it blocks drops its mark
    expect(
      await renderedBy((snap) => {
        snap.issues.find((issue) => issue.id === 'two')!.status = 'done'
      }),
    ).toEqual(['one', 'two'])
    expect(document.querySelector('[data-sync-blocked]')).toBeNull()
    expect(await renderedBy(renamePerson)).toEqual(['one', 'three', 'two'])
  })

  it('render a Needs an owner row again only for the task that changed', async () => {
    const unowned = (snap: Snapshot) => {
      // urgent enough to ask for an owner
      for (const issue of snap.issues) {
        delete issue.assignee_id
        issue.priority = 'high'
      }
    }
    await mount(({ P, TeamOpening, syncDay }) => {
      const now = Date.now()
      return (
        <TeamOpening
          rows={P.issues}
          humans={P.users}
          subIds={new Set(P.projects.map((p) => p.id))}
          metaIds={new Set()}
          day={syncDay(now)}
          now={now}
          onOpenTask={noop}
        />
      )
    }, unowned)
    expect(document.querySelectorAll('[data-sync-needs-owner]')).toHaveLength(3)
    expect(await renderedBy(rename('two'))).toEqual(['two'])
    expect(await renderedBy(renamePerson)).toEqual(['one', 'three', 'two'])
  })
})

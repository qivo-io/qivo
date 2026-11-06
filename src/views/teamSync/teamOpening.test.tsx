// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerMilestones,
  type ForcedMilestones,
  isMilestoneRead,
  MILESTONES_TOO_LARGE,
} from '../../store/milestoneStandIn.setup'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'

/* Team sync's opening (views/teamSync/TeamOpening.tsx) reads its next
   milestone (milestones.section, one upcoming row) and the milestones of
   this week and next (milestones.between) over the scope's top-level
   projects, on the real store, through the milestone stand-in
   (store/milestoneStandIn.setup.ts). It shows them in the server's order,
   says none only when the server answered whole, and says why when it
   could not read them. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../../lib/convex', async () => ({
  convex: network,
  live: (await import('../../store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'

let container: HTMLDivElement
let root: Root
let snap: Snapshot
let force: ForcedMilestones
let subs: {
  name: string
  args: Record<string, unknown>
  next: (v: unknown) => void
  fail: (e: unknown) => void
  stopped: boolean
}[]
let loaded: Awaited<ReturnType<typeof load>>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  force = {}
  subs = []
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  setHidden(false)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** The Monday `weeks` weeks after this week's, as a milestone's week. */
function mondayIn(weeks: number) {
  const day = new Date()
  day.setDate(day.getDate() + 7 * weeks - ((day.getDay() + 6) % 7))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

/** A top-level project `id` of the fixture's organization. */
function top(id: string, name: string, num: number) {
  return {
    ...snap.projects[0],
    id,
    type: 'meta' as const,
    key: `P${num}`,
    num,
    name,
  }
}

/** Two top-level projects, Ship and Plan, with milestones on both, the
    first on each Monday and the one of this week and next on one day. */
function fixture() {
  snap = plannerFixture()
  snap.projects = [top('ship', 'Ship', 1), top('plan', 'Plan', 2)]
  const ms = (id: string, project: string, name: string, week: string) => ({
    id,
    project_id: project,
    name,
    week,
    created_at: AT,
  })
  snap.milestones.push(
    ms('old', 'plan', 'Kickoff', mondayIn(-2)),
    // one day, two projects: the server orders them by name
    ms('zed', 'plan', 'Zed review', mondayIn(0)),
    ms('beta', 'ship', 'Beta build', mondayIn(0)),
    ms('next', 'ship', 'Field test', mondayIn(1)),
    ms('far', 'plan', 'Launch', mondayIn(5)),
  )
}

/** Boots the store over the fixture and loads the opening. */
async function load() {
  vi.resetModules()
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (isMilestoneRead(name)) {
      const sub = { name, args, next, fail, stopped: false }
      subs.push(sub)
      answerMilestones(snap, name, args, next, fail, force)
      return () => {
        sub.stopped = true
      }
    }
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  const store = await import('../../store/planner')
  await store.initStore()
  return {
    store,
    TeamOpening: (await import('./TeamOpening')).TeamOpening,
    syncDay: (await import('../../lib/teamSync')).syncDay,
    usePlannerVersion: (await import('../../store/usePlannerVersion')).usePlannerVersion,
    TooltipProvider: (await import('../../components/ui/tooltip')).TooltipProvider,
  }
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

/** Renders the opening over top-level projects `metaIds`, `weeks` weeks
    after this one. */
async function render(metaIds: string[], weeks = 0) {
  const { TeamOpening, syncDay, usePlannerVersion, TooltipProvider, store } = loaded
  const now = Date.now()
  const day = syncDay(now)
  function Screen() {
    usePlannerVersion()
    return (
      <TooltipProvider>
        <TeamOpening
          rows={[]}
          humans={store.P.users}
          subIds={new Set()}
          metaIds={new Set(metaIds)}
          day={{ ...day, todayWeek: day.todayWeek + weeks }}
          now={now}
          onOpenTask={() => {}}
        />
      </TooltipProvider>
    )
  }
  await act(async () => root.render(<Screen />))
  await settle()
}

/** Answers the live milestone reads again. */
async function rerun() {
  for (const sub of subs)
    if (!sub.stopped) answerMilestones(snap, sub.name, sub.args, sub.next, sub.fail, force)
  await settle()
}

/** Hides or shows the page. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

const q = (selector: string) => document.querySelector<HTMLElement>(selector)
const cell = () => q('[data-sync-next-milestone]')
const listed = () =>
  [...(q('[data-sync-milestones]')?.querySelectorAll('.font-semibold, .text-text-1') ?? [])]
    .filter((el) => el.tagName === 'SPAN' && el.classList.contains('truncate'))
    .map((el) => el.textContent)
const note = () => q('[data-sync-milestones-note]')
const live = (name: string) => subs.filter((s) => s.name === name && !s.stopped)

describe('the next milestone and those of this week and next', () => {
  it("reads both over the scope's projects and shows them in the server's order", async () => {
    fixture()
    loaded = await load()
    await render(['ship', 'plan', 'ship'])
    const [next] = live('milestones:section')
    const [ahead] = live('milestones:between')
    expect(next.args).toEqual({
      projects: ['plan', 'ship'],
      from: mondayIn(0),
      side: 'upcoming',
      limit: 1,
    })
    expect(ahead.args).toEqual({ projects: ['plan', 'ship'], from: mondayIn(0), to: mondayIn(2) })
    expect(cell()?.getAttribute('data-sync-next-milestone')).toBe('milestone')
    expect(cell()?.textContent).toContain('Beta build')
    expect(listed()).toEqual(['Beta build', 'Zed review', 'Field test'])
    // the next milestone is the list's bold row
    const bold = [...(q('[data-sync-milestones]')?.querySelectorAll('span.font-semibold') ?? [])]
    expect(bold.map((el) => el.textContent)).toEqual(['Beta build'])
    expect(note()).toBeNull()
  })

  it('says none only for whole empty answers, and asks nothing for no project', async () => {
    fixture()
    snap.milestones = []
    loaded = await load()
    await render(['plan'])
    expect(cell()?.textContent).toContain('None scheduled')
    expect(q('[data-sync-milestones]')?.textContent).toContain('No milestones this week or next')
    await render([])
    expect(cell()?.textContent).toContain('None scheduled')
    expect(subs.filter((s) => !s.stopped)).toHaveLength(0)
  })

  it('must fail: says unknown and that some may be missing for reads that stopped', async () => {
    fixture()
    force = { section: 'stopped', between: 'stopped' }
    snap.milestones = snap.milestones.filter((m) => m.id !== 'beta' && m.id !== 'zed')
    loaded = await load()
    await render(['plan', 'ship'])
    // the section stopped after its first row: it shows that row
    expect(cell()?.textContent).toContain('Field test')
    expect(note()?.getAttribute('data-sync-milestones-note')).toBe('partial')
    expect(listed()).toEqual(['Field test'])
    // a section that stopped before any row is unknown, never none
    snap.milestones = snap.milestones.filter((m) => m.id === 'old')
    await rerun()
    expect(cell()?.getAttribute('data-sync-next-milestone')).toBe('unknown')
    expect(cell()?.textContent).toContain('unknown')
    expect(cell()?.textContent).not.toContain('None scheduled')
    expect(q('[data-sync-milestones]')?.textContent).not.toContain('No milestones')
  })

  it('waits, then says why it could not read them, with Retry for a failure', async () => {
    fixture()
    force = { section: 'loading', between: 'loading' }
    loaded = await load()
    await render(['plan', 'ship'])
    expect(cell()?.getAttribute('data-sync-next-milestone')).toBe('loading')
    expect(q('[data-sync-milestones]')?.textContent).toContain('Loading milestones…')
    force = { section: 'error', between: 'error' }
    await rerun()
    expect(cell()?.getAttribute('data-sync-next-milestone')).toBe('unknown')
    expect(note()?.textContent).toContain("Couldn't load milestones.")
    force = {}
    const retry = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry')
    await act(async () => retry?.click())
    await settle()
    expect(listed()).toEqual(['Beta build', 'Zed review', 'Field test'])
    force = { section: 'refused', between: 'refused' }
    await rerun()
    expect(note()?.getAttribute('data-sync-milestones-note')).toBe('refused')
    expect(note()?.textContent).toContain(MILESTONES_TOO_LARGE.slice(1))
    // the rows it showed stay under the refusal
    expect(listed()).toEqual(['Beta build', 'Zed review', 'Field test'])
  })
})

describe('the projects figure', () => {
  it('asks once with 200 top-level projects and shows the answer', async () => {
    fixture()
    // 200 top-level projects of the home organization, 100 of them with
    // two sub-projects, which the scope never names: milestones sit on
    // top-level projects
    const ids: string[] = []
    for (let n = 0; n < 200; n++) {
      const id = `p${String(n).padStart(3, '0')}`
      ids.push(id)
      snap.projects.push(top(id, `Project ${n}`, 10 + n))
      if (n < 100)
        for (const k of [0, 1])
          snap.projects.push({
            ...top(`${id}-${k}`, `Project ${n}.${k}`, 1000 + 2 * n + k),
            type: 'project',
            parent_id: id,
          })
    }
    snap.milestones.push({
      id: 'deep',
      project_id: 'p199',
      name: 'Last project review',
      week: mondayIn(0),
      created_at: AT,
    })
    loaded = await load()
    await render(ids)
    expect(subs.filter((s) => s.name === 'milestones:section')).toHaveLength(1)
    expect((live('milestones:section')[0].args.projects as string[]).length).toBe(200)
    expect(cell()?.textContent).toContain('Last project review')
  })

  it('must fail: asks nothing past the cap and says so, never a next milestone', async () => {
    fixture()
    snap.projects.push(top('docs', 'Docs', 3), top('ops', 'Ops', 4))
    loaded = await load()
    const cap = loaded.store.MILESTONE_READS.projects
    loaded.store.MILESTONE_READS.projects = 3
    try {
      await render(['plan', 'ship', 'docs', 'ops'])
      expect(subs.filter((s) => isMilestoneRead(s.name))).toHaveLength(0)
      expect(cell()?.getAttribute('data-sync-next-milestone')).toBe('unknown')
      expect(note()?.getAttribute('data-sync-milestones-note')).toBe('too_many')
      expect(note()?.textContent).toBe(
        'The app reads the milestones of at most 200 projects at once. Choose fewer projects. ' +
          'Pick a team or a project with fewer top-level projects.',
      )
    } finally {
      loaded.store.MILESTONE_READS.projects = cap
    }
  })
})

describe('the hidden tab and the week', () => {
  it('stops while hidden, keeps what it showed as refreshing, and reads a new week anew', async () => {
    fixture()
    loaded = await load()
    await render(['plan', 'ship'])
    await act(async () => setHidden(true))
    await settle()
    expect(live('milestones:between')).toHaveLength(0)
    expect(listed()).toEqual(['Beta build', 'Zed review', 'Field test'])
    expect(q('[data-sync-milestones]')?.getAttribute('aria-busy')).toBe('true')
    force = { between: 'loading' }
    await act(async () => setHidden(false))
    await settle()
    expect(live('milestones:between')).toHaveLength(1)
    expect(q('[data-sync-milestones]')?.getAttribute('aria-busy')).toBe('true')
    force = {}
    await rerun()
    expect(q('[data-sync-milestones]')?.hasAttribute('aria-busy')).toBe(false)
    // the next week asks new keys
    await render(['plan', 'ship'], 1)
    expect(live('milestones:between')[0].args).toMatchObject({
      from: mondayIn(1),
      to: mondayIn(3),
    })
    expect(listed()).toEqual(['Field test'])
  })
})

// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { milestoneWeekTaken } from '../../convex/lib/limits'
import { TooltipProvider } from '../components/ui/tooltip'
import { type BoardArgs, boardStandIn } from '../store/boardStandIn.setup'
import {
  answerMilestones,
  type ForcedMilestones,
  isMilestoneRead,
  MILESTONES_TOO_LARGE,
  MILESTONES_UNCHECKED,
} from '../store/milestoneStandIn.setup'
import { answerOverview } from '../store/overviewStandIn.setup'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import { answerRoadmap, type ForcedRoadmap } from '../store/roadmapStandIn.setup'

/* The Roadmap's milestone flags on App and the real store, from the
   server's range read (convex/milestones.ts between) as the milestone
   stand-in answers it (store/milestoneStandIn.setup.ts): which projects
   and days each scope asks, My view's flags on their own projects' rows
   with their guides in those rows only, a project's in its header, a
   window move's two reads, the line for each state the read can be in,
   the places it reads nothing, and a drag's write. */

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

const AT = '2026-09-14T08:00:00.000Z'

/** One subscription of a milestone read: its query, arguments and
    callbacks, whether it stopped, and whether it answered. */
type Sub = {
  name: string
  args: { projects?: string[]; from?: string; to?: string }
  next: (value: unknown) => void
  fail?: (error: unknown) => void
  stopped: boolean
}

let container: HTMLDivElement
let root: Root
let phone = false
// what the server holds, and the milestone reads it was asked
let server: Snapshot
let subs: Sub[] = []
// the milestone reads it holds back, and the states it forces
let holds: (sub: Sub) => boolean = () => false
let force: ForcedMilestones = {}
// whether the Roadmap's own read holds back its answers, and what it forces
let holdRoadmap = false
let roadmapForce: ForcedRoadmap[] = []
let heldRoadmaps: (() => void)[] = []
// every write App sent, by name and arguments
let sent: { name: string; args: Record<string, unknown> }[] = []

beforeEach(() => {
  phone = false
  subs = []
  holds = () => false
  force = {}
  holdRoadmap = false
  roadmapForce = []
  heldRoadmaps = []
  sent = []
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.scrollTo = () => {}
  Element.prototype.getAnimations = () => []
  Element.prototype.setPointerCapture = () => {}
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: phone && query === '(max-width: 760px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
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
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

/** The Monday `weeks` weeks after this week's, as a stored day, and the
    day `days` after it. */
function mondayIn(weeks: number, days = 0) {
  const day = new Date()
  day.setDate(day.getDate() + 7 * weeks + days - ((day.getDay() + 6) % 7))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

/** The Monday of the week of stored day `day`, as the fixture's
    organization starts its weeks. */
function mondayOf(day: string) {
  const date = new Date(`${day}T00:00:00`)
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  return date.toDateString()
}

/** Plan, Luma and Cloud, three top-level projects with one sub-project
    each. The person holds a task in Plan's and Luma's, none in Cloud's.
    Each has a milestone next week. */
function world(): Snapshot {
  const snap = plannerFixture()
  const me = snap.profiles[0].id
  const base = snap.projects[0]
  const org = snap.orgs[0].id
  snap.projects = []
  let num = 0
  for (const [id, name] of [
    ['plan', 'Plan'],
    ['luma', 'Luma'],
    ['cloud', 'Cloud'],
  ] as const) {
    snap.projects.push(
      { ...base, id, type: 'meta', key: id.toUpperCase(), num: ++num, name },
      {
        ...base,
        id: `${id}-a`,
        type: 'project',
        key: `${id.slice(0, 2).toUpperCase()}A`,
        num: ++num,
        name: `${name} work`,
        parent_id: id,
      },
    )
    snap.issues.push({
      id: `t-${id}`,
      org_id: org,
      project_id: `${id}-a`,
      num,
      title: `${name} task`,
      description: '',
      status: 'todo',
      priority: 'medium',
      ...(id === 'cloud' ? {} : { assignee_id: me }),
      paused: false,
      created_at: AT,
      updated_at: AT,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    snap.milestones.push({
      id: `m-${id}`,
      project_id: id,
      name: `${name} launch`,
      week: mondayIn(1),
      created_at: AT,
    })
  }
  return snap
}

/** Answers milestone read `sub` from what the server holds now, with the
    states it forces. */
const answer = (sub: Sub) => answerMilestones(server, sub.name, sub.args, sub.next, sub.fail, force)

/** Boots the real store on `snap` and renders App at `path`. `held`
    changes the workspace App is sent, so it can differ from what the
    milestone reads answer; `before` runs on the store before App renders. */
async function app(
  snap: Snapshot,
  path: string,
  {
    held = () => {},
    before = () => {},
  }: {
    held?: (copy: Snapshot) => void
    before?: (store: typeof import('../store/planner')) => void
  } = {},
) {
  vi.resetModules()
  history.replaceState(null, '', path)
  server = snap
  let publish = () => {}
  // the server's journal of the visit's changes, for Undo
  const journal: { id: string; week: string }[] = []
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      publish = () => {
        const copy = structuredClone(server)
        held(copy)
        next(copy)
      }
      publish()
    } else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'tasks:board') next(boardStandIn(server, args as BoardArgs))
    else if (name === 'tasks:roadmap' || name === 'tasks:roadmapDependencies') {
      const send = () => next(answerRoadmap(server, name, args, { force: roadmapForce }))
      if (holdRoadmap) heldRoadmaps.push(send)
      else send()
    } else if (name.startsWith('overview:')) answerOverview(server, name, args, next, fail)
    else if (isMilestoneRead(name)) {
      const sub: Sub = { name, args: args as Sub['args'], next, fail, stopped: false }
      subs.push(sub)
      if (!holds(sub)) answer(sub)
      return () => {
        sub.stopped = true
      }
    }
    return () => {}
  })
  /** Delivers what the server holds now to every live read, as Convex
      does before a write answers. */
  const deliver = () => {
    publish()
    for (const sub of subs) if (!sub.stopped && !holds(sub)) answer(sub)
  }
  network.query.mockResolvedValue(null)
  network.mutation.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    sent.push({ name, args })
    if (name === 'roadmap:undo') {
      const last = journal.pop()
      const row = server.milestones.find((m) => m.id === last?.id)
      if (row && last) row.week = last.week
      deliver()
      return { count: journal.length }
    }
    if (name !== 'roadmap:change' && name !== 'projects:updateMilestone') return null
    const ops = (
      name === 'roadmap:change'
        ? args.operations
        : [{ kind: 'milestone_update', id: args.id, patch: args.patch }]
    ) as { kind: string; id: string; patch: { week?: string } }[]
    for (const op of ops) {
      const row = server.milestones.find((m) => m.id === op.id)
      if (op.kind !== 'milestone_update' || !row || !op.patch.week) continue
      const holder = server.milestones.find(
        (m) =>
          m.id !== row.id &&
          m.project_id === row.project_id &&
          mondayOf(m.week) === mondayOf(op.patch.week ?? ''),
      )
      if (holder)
        throw new ConvexError({
          code: 'rule',
          reason: 'milestone_week_taken',
          message: milestoneWeekTaken('that week', holder.name),
        })
      journal.push({ id: row.id, week: row.week })
      row.week = op.patch.week
    }
    deliver()
    return name === 'roadmap:change' ? { count: journal.length } : null
  })
  const store = await import('../store/planner')
  await store.initStore()
  before(store)
  const { syncStatus } = await import('../lib/syncStatus')
  syncStatus.setSocket({ connected: true, everConnected: true })
  const { default: App } = await import('../App')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <App />
      </TooltipProvider>,
    ),
  )
  return { store, deliver }
}

/** Waits for `find` to answer, through lazy views that can take seconds
    to load on a busy worker. */
function waitFor<T>(find: () => T | null | undefined | false, what: string) {
  return vi.waitFor(
    () => {
      const found = find()
      if (!found) throw new Error(`missing ${what}`)
      return found
    },
    { timeout: 10_000 },
  )
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

/** The Roadmap's root once it shows its tasks, with its flags `state`. */
const roadmap = (state = 'ok') =>
  waitFor(
    () =>
      document.querySelector<HTMLElement>(
        `[data-workspace-view] [data-roadmap-root][data-roadmap-state="ok"][data-roadmap-milestones="${state}"]`,
      ),
    `the Roadmap with its flags ${state}`,
  )
/** The flag of milestone `id`, or null. */
const flag = (id: string) =>
  document.querySelector<HTMLElement>(`[data-workspace-view] [data-msflag="${id}"]`)
/** The range reads asked so far, and those live now. */
const ranges = () => subs.filter((s) => s.name === 'milestones:between')
const liveRanges = () => ranges().filter((s) => !s.stopped)
/** The line beside the toolbar about the flags, or null. */
const line = () => document.querySelector<HTMLElement>('p[data-roadmap-milestones]')
/** The labels of the rows that draw milestone `id`'s guide: a track's or
    sub-project's id, or a task row's title. */
const guideRows = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(`[data-workspace-view] [data-msguide="${id}"]`)].map(
    (guide) => {
      const row = guide.closest<HTMLElement>(
        '[data-track], [data-subtrack], [data-roadmap-task-top]',
      )
      return (
        row?.dataset.track ??
        row?.dataset.subtrack ??
        row?.querySelector('[data-roadmap-task-open]')?.textContent ??
        '?'
      )
    },
  )

/** The app's week grid, as the store booted it. */
async function grid() {
  const { P } = await import('../store/planner')
  const dates = await import('../lib/dates')
  const { w0, w1 } = P.resolveWin(P.DEFAULT_WIN)
  return { P, w0, w1, iso: dates.weekToISO, week: dates.isoToWeek }
}

describe("My view's milestones", { timeout: 30_000 }, () => {
  it("draws each milestone on its own project's row, in the same place, with no header band", async () => {
    await app(world(), '/app/~/roadmap/mine')
    await roadmap()
    const plan = await waitFor(() => flag('m-plan'), "Plan's flag")
    const luma = await waitFor(() => flag('m-luma'), "Luma's flag")
    expect(plan.closest('[data-track]')?.getAttribute('data-track')).toBe('plan')
    expect(luma.closest('[data-track]')?.getAttribute('data-track')).toBe('luma')
    expect(plan.style.left).toBe(luma.style.left)
    expect(plan.textContent).toBe('Plan launch')
    // the header holds the weeks alone
    expect(document.querySelector('[data-workspace-view] [data-msband]')).toBeNull()
    expect(document.querySelector('[data-roadmap-header] [data-msflag]')).toBeNull()
    // one read, of the person's two projects, for the weeks on screen
    const { w0, w1, iso } = await grid()
    expect(liveRanges().map((s) => s.args)).toEqual([
      { projects: ['luma', 'plan'], from: iso(w0), to: iso(w1 + 1) },
    ])
    // must not: Cloud, where the person holds no task, is neither asked nor drawn
    expect(flag('m-cloud')).toBeNull()
  })

  it("runs each guide through its own project's rows and no other", async () => {
    await app(world(), '/app/~/roadmap/mine')
    await roadmap()
    await waitFor(() => flag('m-plan'), "Plan's flag")
    expect(guideRows('m-plan').sort()).toEqual(['Plan task', 'plan', 'plan-a'])
    expect(guideRows('m-luma').sort()).toEqual(['Luma task', 'luma', 'luma-a'])
  })

  it('keeps the read and its flags through a Priority change, which reloads the tasks', async () => {
    const snap = world()
    // Luma's task is Low, so the Medium filter prunes Luma's track
    const lumaTask = snap.issues.find((t) => t.id === 't-luma')
    if (lumaTask) lumaTask.priority = 'low'
    await app(snap, '/app/~/roadmap/mine')
    await roadmap()
    await waitFor(() => flag('m-plan'), "Plan's flag")
    await waitFor(() => flag('m-luma'), "Luma's flag")
    expect(ranges()).toHaveLength(1)
    // the Roadmap's answer for the new filter row waits
    holdRoadmap = true
    const menu = await waitFor(
      () => document.querySelector<HTMLElement>('[data-filter-prio-menu]'),
      'Priority',
    )
    await act(async () => menu.click())
    const medium = await waitFor(
      () => document.querySelector<HTMLElement>('[data-filter-prio="medium"]'),
      'Medium',
    )
    await act(async () => medium.click())
    await waitFor(
      () => document.querySelector('[data-workspace-view] [data-roadmap-state="loading"]'),
      'the reload',
    )
    // the tracks of the last answer hold, so the read stays the one live read
    expect(ranges()).toHaveLength(1)
    expect(liveRanges()).toHaveLength(1)
    holdRoadmap = false
    await act(async () => {
      for (const send of heldRoadmaps.splice(0)) send()
    })
    await roadmap()
    // the flags return with the rows, on the same read
    await waitFor(() => flag('m-plan'), "Plan's flag again")
    expect(ranges()).toHaveLength(1)
    // must fail: a read that follows the pruned tracks names Plan alone
    expect(liveRanges()).toHaveLength(1)
    expect(liveRanges()[0].args.projects).toEqual(['luma', 'plan'])
    // the filter pruned Luma's track, and its flag with it
    expect(flag('m-luma')).toBeNull()
    // cleared, Luma's flag returns from the same read
    const clear = await waitFor(
      () => document.querySelector<HTMLElement>('[aria-label="Clear priority filter"]'),
      'the clear button',
    )
    await act(async () => clear.click())
    await roadmap()
    await waitFor(() => flag('m-luma'), "Luma's flag again")
    expect(ranges()).toHaveLength(1)
  })

  it('stands three milestones of one project in one week each in sight, each opening on Enter', async () => {
    const snap = world()
    for (const n of [1, 2])
      snap.milestones.push({
        id: `m-plan-${n}`,
        project_id: 'plan',
        name: `Plan extra ${n}`,
        week: mondayIn(1, n),
        created_at: AT,
      })
    await app(snap, '/app/~/roadmap/mine')
    await roadmap()
    const ids = ['m-plan', 'm-plan-1', 'm-plan-2']
    const flags = await waitFor(() => {
      const found = ids.map(flag)
      return found.every(Boolean) && (found as HTMLElement[])
    }, 'the three flags')
    const places = flags.map((f) => `${f.style.left}|${f.style.bottom}`)
    expect(new Set(places).size).toBe(3)
    for (const f of flags) {
      expect(f.closest('[data-track]')?.getAttribute('data-track')).toBe('plan')
      // inside the row's two rows of flags, none below or above them
      const bottom = Number.parseFloat(f.style.bottom)
      expect(bottom).toBeGreaterThanOrEqual(0)
      expect(bottom + 16).toBeLessThanOrEqual(36)
      expect(f.tabIndex).toBe(0)
    }
    await act(async () => {
      flags[2].focus()
      flags[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await waitFor(
      () =>
        [...(document.querySelector('[role="dialog"]')?.querySelectorAll('input') ?? [])].some(
          (field) => (field as HTMLInputElement).value === 'Plan extra 2',
        ),
      "the third one's editor",
    )
  })

  it('shows no flag or guide while Team fills the panel, and a project keeps its header flags', async () => {
    await app(world(), '/app/~/roadmap/mine')
    await roadmap()
    await waitFor(() => flag('m-plan'), "Plan's flag")
    const mode = (name: string) =>
      waitFor(
        () => document.querySelector<HTMLElement>(`[data-workspace-view] [data-strip-${name}]`),
        `Team's ${name}`,
      )
    await act(async () => (await mode('expand')).click())
    await settle()
    // the rows hide with their flags and guides, and the read stops,
    // keeping them
    for (const shown of document.querySelectorAll(
      '[data-workspace-view] [data-msflag], [data-workspace-view] [data-msguide]',
    ))
      expect(shown.closest('[hidden]')).not.toBeNull()
    expect(document.querySelector('[data-roadmap-header] [data-msflag]')).toBeNull()
    expect(liveRanges()).toHaveLength(0)
    // back to rows and Team: the kept flags show at once, refreshing
    holds = () => true
    await act(async () => (await mode('split')).click())
    await roadmap('refreshing')
    expect(flag('m-plan')?.closest('[hidden]')).toBeNull()
    expect(liveRanges()).toHaveLength(1)
    holds = () => false
    await act(async () => root.unmount())
    root = createRoot(container)
    subs = []
    await app(world(), '/app/testbed/roadmap/p/1')
    await roadmap()
    await waitFor(() => document.querySelector('[data-msband] [data-msflag="m-plan"]'), 'its flag')
    await act(async () => (await mode('expand')).click())
    await settle()
    expect(
      document.querySelector('[data-msband] [data-msflag="m-plan"]')?.closest('[hidden]'),
    ).toBeNull()
    expect(liveRanges()).toHaveLength(1)
  })
})

describe("My view's milestones while Team fills the panel", { timeout: 30_000 }, () => {
  it('says nothing of the flags when the first answer arrives with Team expanded', async () => {
    // the Roadmap's first answer, which names the tracks, waits
    holdRoadmap = true
    await app(world(), '/app/~/roadmap/mine')
    const expand = await waitFor(
      () => document.querySelector<HTMLElement>('[data-workspace-view] [data-strip-expand]'),
      "Team's expand",
    )
    await act(async () => expand.click())
    holdRoadmap = false
    await act(async () => {
      for (const send of heldRoadmaps.splice(0)) send()
    })
    await roadmap('loading')
    await settle()
    // the read stops before it starts, and the flags show nowhere
    expect(ranges()).toHaveLength(0)
    // must fail: "Loading milestones…" over rows that are hidden
    expect(line()).toBeNull()
    const split = await waitFor(
      () => document.querySelector<HTMLElement>('[data-workspace-view] [data-strip-split]'),
      "Team's split",
    )
    await act(async () => split.click())
    await roadmap('ok')
    expect(flag('m-plan')?.closest('[hidden]')).toBeNull()
    expect(liveRanges()).toHaveLength(1)
  })
})

describe("a project's milestones", { timeout: 30_000 }, () => {
  it('keeps them in the header with guides through every row, read for its top-level project', async () => {
    await app(world(), '/app/testbed/roadmap/p/1')
    await roadmap()
    const plan = await waitFor(
      () => document.querySelector('[data-msband] [data-msflag="m-plan"]'),
      "Plan's header flag",
    )
    expect(plan.closest('[data-track]')).toBeNull()
    expect(guideRows('m-plan').sort()).toEqual(['Plan task', 'plan-a'])
    expect(liveRanges().map((s) => s.args.projects)).toEqual([['plan']])
    // a sub-project reads its top-level project, never a sibling
    await act(async () => root.unmount())
    root = createRoot(container)
    subs = []
    await app(world(), '/app/testbed/roadmap/p/2')
    await roadmap()
    await waitFor(() => document.querySelector('[data-msband] [data-msflag="m-plan"]'), 'its flag')
    expect(liveRanges().map((s) => s.args.projects)).toEqual([['plan']])
    expect(flag('m-luma')).toBeNull()
  })

  it('marks the header band busy while its flags are on their way, and says so at once', async () => {
    holds = () => true
    await app(world(), '/app/testbed/roadmap/p/1')
    await roadmap('loading')
    const band = () => document.querySelector('[data-workspace-view] [data-msband]')
    expect(band()?.getAttribute('aria-busy')).toBe('true')
    // a wait with no flag to show says so at once, not after a stall
    expect(line()?.textContent).toBe('Loading milestones…')
    holds = () => false
    await act(async () => {
      for (const sub of liveRanges()) answer(sub)
    })
    await roadmap('ok')
    expect(band()?.getAttribute('aria-busy')).toBeNull()
    expect(line()).toBeNull()
  })
})

describe('a window move', { timeout: 30_000 }, () => {
  /** world() with Plan's milestones in the week before this one, two weeks
      on and eight weeks on: the default window shows the first two, the
      window two weeks on the last two. */
  const spread = () => {
    const snap = world()
    snap.milestones = [
      { id: 'early', project_id: 'plan', name: 'Early', week: mondayIn(-1), created_at: AT },
      { id: 'both', project_id: 'plan', name: 'Both', week: mondayIn(2), created_at: AT },
      { id: 'late', project_id: 'plan', name: 'Late', week: mondayIn(8), created_at: AT },
    ]
    return snap
  }
  const forward = () =>
    act(async () =>
      document.querySelector<HTMLElement>('[data-workspace-view] [data-win="fwd"]')?.click(),
    )
  const back = () =>
    act(async () =>
      document.querySelector<HTMLElement>('[data-workspace-view] [data-win="back"]')?.click(),
    )

  it('asks the new days beside the live read, shows the shared weeks meanwhile, and swaps once it answers', async () => {
    await app(spread(), '/app/~/roadmap/mine')
    await roadmap()
    await waitFor(() => flag('early') && flag('both'), 'the first window')
    const { iso, w0, w1 } = await grid()
    // the new window's read waits
    holds = (sub) => sub.args.from !== iso(w0)
    await forward()
    await settle()
    expect(liveRanges()).toHaveLength(2)
    const pending = liveRanges().find((s) => s.args.from !== iso(w0))
    expect(pending?.args).toMatchObject({ from: iso(w0 + 2), to: iso(w1 + 3) })
    await roadmap('refreshing')
    // the shared week's flag stays, the left week's goes, the new week's waits
    expect(flag('both')).not.toBeNull()
    expect(flag('early')).toBeNull()
    expect(flag('late')).toBeNull()
    holds = () => false
    await act(async () => {
      if (pending) answer(pending)
    })
    await roadmap('ok')
    expect(flag('late')).not.toBeNull()
    expect(liveRanges()).toHaveLength(1)
    expect(liveRanges()[0]).toBe(pending)
  })

  /** Sets a window of the weeks `start` to `end` from this week's through
      the window menu's Custom range, the end first. */
  async function customWindow(start: number, end: number) {
    const glyph = await waitFor(
      () => document.querySelector<HTMLElement>('[data-workspace-view] [data-win="menu"]'),
      "the window menu's glyph",
    )
    await act(async () => glyph.click())
    const custom = await waitFor(
      () => document.querySelector<HTMLElement>('[data-win-custom]'),
      'Custom range',
    )
    await act(async () => custom.click())
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    for (const [which, value] of [
      ['end', end],
      ['start', start],
    ] as const) {
      const input = await waitFor(
        () => document.querySelector<HTMLInputElement>(`[data-win-weeks="${which}"]`),
        `the ${which} weeks field`,
      )
      await act(async () => {
        setter?.call(input, String(value))
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await settle()
  }

  it.each([
    ['My view', '/app/~/roadmap/mine'],
    ['a project', '/app/testbed/roadmap/p/1'],
  ])(
    'says the flags are loading in %s after a window that shares no week with the last, until its read answers',
    async (_, path) => {
      await app(spread(), path)
      await roadmap()
      await waitFor(() => flag('early') && flag('both'), 'the first window')
      const { iso, w0, w1 } = await grid()
      // every read but the first window's waits; the tasks answer at once
      holds = (sub) => sub.args.from !== iso(w0) || sub.args.to !== iso(w1 + 1)
      await customWindow(8, 14)
      await roadmap('refreshing')
      const pending = liveRanges().find((s) => s.args.from === iso(w0 + 10))
      expect(pending?.args.to).toBe(iso(w0 + 17))
      // the first window's read stays live, none of its flags in the new one
      expect(liveRanges()).toHaveLength(2)
      expect(document.querySelector('[data-workspace-view] [data-msflag]')).toBeNull()
      // must fail: an empty display with nothing said, which reads as finished
      expect(line()?.textContent).toBe('Loading milestones…')
      holds = () => false
      await act(async () => {
        if (pending) answer(pending)
      })
      await roadmap('ok')
      expect(flag('late')).not.toBeNull()
      expect(line()).toBeNull()
      expect(liveRanges()).toEqual([pending])
    },
  )

  it('drops the new window’s read on a pan back before it answers', async () => {
    await app(spread(), '/app/~/roadmap/mine')
    await roadmap()
    await waitFor(() => flag('early'), 'the first window')
    const { iso, w0 } = await grid()
    holds = (sub) => sub.args.from !== iso(w0)
    await forward()
    await settle()
    expect(liveRanges()).toHaveLength(2)
    await back()
    await settle()
    expect(liveRanges()).toHaveLength(1)
    expect(liveRanges()[0].args.from).toBe(iso(w0))
    await roadmap('ok')
    expect(flag('early')).not.toBeNull()
  })
})

describe('the line about the flags', { timeout: 30_000 }, () => {
  it('says the read failed with Retry, which asks again and keeps the flags', async () => {
    await app(world(), '/app/testbed/roadmap/p/1')
    await roadmap()
    await waitFor(() => flag('m-plan'), "Plan's flag")
    const first = liveRanges()[0]
    await act(async () => first.fail?.(new Error('the read failed')))
    await roadmap('failed')
    expect(line()?.textContent).toContain("Couldn't load milestones.")
    expect(flag('m-plan')).not.toBeNull()
    const retry = [...(line()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Retry',
    )
    expect(retry).toBeDefined()
    await act(async () => retry?.click())
    await roadmap('ok')
    expect(ranges().length).toBeGreaterThan(1)
    expect(line()).toBeNull()
  })

  it("gives a refusal in the server's words", async () => {
    force = { between: 'refused' }
    await app(world(), '/app/~/roadmap/mine')
    await roadmap('refused')
    expect(line()?.textContent).toBe(
      `${MILESTONES_TOO_LARGE.charAt(0).toUpperCase()}${MILESTONES_TOO_LARGE.slice(1)} Open a project to see its milestones.`,
    )
    await act(async () => root.unmount())
    root = createRoot(container)
    force = { between: 'unchecked' }
    await app(world(), '/app/testbed/roadmap/p/1')
    await roadmap('refused')
    expect(line()?.textContent).toBe(MILESTONES_UNCHECKED)
  })

  it('draws a stopped read up to where it stopped, and says from when flags may be missing', async () => {
    const snap = world()
    snap.milestones.push({
      id: 'later',
      project_id: 'plan',
      name: 'Later',
      week: mondayIn(3),
      created_at: AT,
    })
    force = { between: 'stopped' }
    await app(snap, '/app/testbed/roadmap/p/1')
    await roadmap('partial')
    expect(flag('m-plan')).not.toBeNull()
    expect(flag('later')).toBeNull()
    const { P } = await grid()
    expect(line()?.textContent).toBe(
      `Milestones from ${P.fmtISO(mondayIn(1))} on may be missing. Choose a shorter window.`,
    )
  })

  it('names the limit and asks nothing for more top-level projects than one read names', async () => {
    let reads: { projects: number } | null = null
    try {
      await app(world(), '/app/~/roadmap/mine', {
        before: (store) => {
          reads = store.MILESTONE_READS
          store.MILESTONE_READS.projects = 1
        },
      })
      await roadmap('too_many')
      expect(line()?.textContent).toBe(
        'The app reads the milestones of at most 200 projects at once. Choose fewer projects. Open a project to see its milestones.',
      )
      expect(ranges()).toHaveLength(0)
      expect(document.querySelector('[data-workspace-view] [data-msflag]')).toBeNull()
    } finally {
      if (reads) (reads as { projects: number }).projects = 200
    }
  })

  it('stands down where the Roadmap says that access could not be checked', async () => {
    force = { between: 'unchecked' }
    roadmapForce = ['access_unchecked']
    await app(world(), '/app/testbed/roadmap/p/1')
    await waitFor(
      () =>
        document.querySelector(
          '[data-workspace-view] [data-roadmap-state="unavailable"][data-roadmap-milestones="refused"]',
        ),
      "the Roadmap's note and the refused read",
    )
    // the note gives the reason once; the frame stays behind it
    expect(document.body.textContent).toContain('This Roadmap is not available')
    expect(document.querySelector('[data-workspace-view] [data-roadmap-header]')).not.toBeNull()
    expect(line()).toBeNull()
  })
})

describe('where the Roadmap reads no flags', { timeout: 30_000 }, () => {
  it('reads none in All projects, which shows its note alone', async () => {
    await app(world(), '/app/~/roadmap/all')
    await waitFor(
      () => document.querySelector('[data-workspace-view] [data-roadmap-state="choose"]'),
      "All projects' chooser",
    )
    await settle()
    expect(ranges()).toHaveLength(0)
    expect(document.querySelector('[data-workspace-view] [data-roadmap-header]')).toBeNull()
  })

  it("reads none in My view before its answer names the tracks, then the tracks'", async () => {
    holdRoadmap = true
    await app(world(), '/app/~/roadmap/mine')
    await waitFor(
      () => document.querySelector('[data-workspace-view] [data-roadmap-state="loading"]'),
      'the wait',
    )
    await settle()
    expect(ranges()).toHaveLength(0)
    holdRoadmap = false
    await act(async () => {
      for (const send of heldRoadmaps.splice(0)) send()
    })
    await roadmap()
    expect(liveRanges().map((s) => s.args.projects)).toEqual([['luma', 'plan']])
  })

  it('stops while the tab hides, and shows the kept flags refreshing on return', async () => {
    await app(world(), '/app/~/roadmap/mine')
    const page = await roadmap()
    await waitFor(() => flag('m-plan'), "Plan's flag")
    holds = () => true
    const hide = (state: 'hidden' | 'visible') =>
      act(async () => {
        Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
      })
    await hide('hidden')
    expect(liveRanges()).toHaveLength(0)
    expect(flag('m-plan')).not.toBeNull()
    await hide('visible')
    await roadmap('refreshing')
    expect(flag('m-plan')).not.toBeNull()
    expect(liveRanges()).toHaveLength(1)
    // the Roadmap's own wait mark is the tasks', not the flags'
    expect(page.getAttribute('aria-busy')).toBeNull()
    expect(line()).toBeNull()
  })

  it("reads none while the phone's agenda shows", async () => {
    phone = true
    await app(world(), '/app/~/roadmap/mine')
    await waitFor(
      () => document.querySelector('.mobile-roadmap-open-timeline'),
      "the phone's agenda",
    )
    await settle()
    expect(ranges()).toHaveLength(0)
  })
})

describe('a flag dragged on a row', { timeout: 30_000 }, () => {
  /** Drags flag `id` by `weeks` weeks of the Roadmap's week width (36 px
      in jsdom, which lays nothing out) and lets it go. */
  async function drag(id: string, weeks: number) {
    const handle = flag(id)
    if (!handle) throw new Error(`no flag of ${id}`)
    const pointer = (type: string, clientX: number) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX, pointerId: 1 })
    await act(async () => handle.dispatchEvent(pointer('pointerdown', 100)))
    await act(async () => handle.dispatchEvent(pointer('pointermove', 100 + weeks * 36)))
    await act(async () => handle.dispatchEvent(pointer('pointerup', 100 + weeks * 36)))
    await settle()
  }
  /** The milestone moves sent, with their expected values. */
  type Move = { kind: string; id: unknown; patch: unknown; expected?: unknown }
  const moves = () =>
    sent.flatMap(({ name, args }): Move[] =>
      name === 'roadmap:change'
        ? (args.operations as Move[])
        : name === 'projects:updateMilestone'
          ? [{ kind: 'milestone_update', id: args.id, patch: args.patch, expected: args.expected }]
          : [],
    )

  it("sends the new week with the answer's stored day as expected, while the workspace's differs", async () => {
    const snap = world()
    // the server stores Plan's on the Tuesday; the workspace App holds says Monday
    const stored = mondayIn(1, 1)
    snap.milestones[0].week = stored
    await app(snap, '/app/~/roadmap/mine', {
      held: (copy) => {
        copy.milestones[0].week = mondayIn(1)
      },
    })
    await roadmap()
    await waitFor(() => flag('m-plan'), "Plan's flag")
    await drag('m-plan', 2)
    expect(moves()).toEqual([
      expect.objectContaining({
        kind: 'milestone_update',
        id: 'm-plan',
        patch: { week: mondayIn(3) },
        expected: { week: stored },
      }),
    ])
    // the saved move shows, and Undo puts the flag back
    const { P, w0, week } = await grid()
    await waitFor(
      () => flag('m-plan')?.style.left === `${(week(mondayIn(3)) - w0) * 36 - 4.5}px`,
      'the moved flag',
    )
    await act(async () => P.undoRoadmap())
    await settle()
    await waitFor(
      () => flag('m-plan')?.style.left === `${(week(mondayIn(1)) - w0) * 36 - 4.5}px`,
      'the flag back in its week',
    )
  })

  it('goes back with the server’s sentence on a week its project holds', async () => {
    const snap = world()
    snap.milestones.push({
      id: 'm-plan-later',
      project_id: 'plan',
      name: 'Plan review',
      week: mondayIn(3),
      created_at: AT,
    })
    await app(snap, '/app/~/roadmap/mine')
    await roadmap()
    const before = (await waitFor(() => flag('m-plan'), "Plan's flag")).style.left
    await drag('m-plan', 2)
    // App's toast, in the server's words, names the milestone that week holds
    await waitFor(
      () => document.body.textContent?.includes('the milestone “Plan review”'),
      'the refusal',
    )
    await waitFor(() => flag('m-plan')?.style.left === before, 'the flag back')
  })

  it("never moves a Viewer's flag, and sends nothing", async () => {
    const snap = world()
    snap.profiles[0].org_role = 'viewer'
    for (const id of ['plan', 'luma'])
      snap.access.push({ project_id: id, profile_id: snap.profiles[0].id, level: 'viewer' })
    await app(snap, '/app/~/roadmap/mine')
    await roadmap()
    const before = (await waitFor(() => flag('m-plan'), "Plan's flag")).style.left
    await drag('m-plan', 2)
    expect(moves()).toEqual([])
    expect(flag('m-plan')?.style.left).toBe(before)
  })
})

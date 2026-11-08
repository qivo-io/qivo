// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { type BoardArgs, boardStandIn } from './store/boardStandIn.setup'
import { answerMilestones, isMilestoneRead } from './store/milestoneStandIn.setup'
import { answerOverview } from './store/overviewStandIn.setup'
import { plannerFixture, type Snapshot } from './store/plannerFixture.setup'
import {
  answerProjectNav,
  isProjectNavRead,
  queryProjectNav,
} from './store/projectNavStandIn.setup'
import { answerRoadmap } from './store/roadmapStandIn.setup'

/* The pages of a person who can see no active project, on the real store
   and App: with nothing remembered they land on the project chooser, whose
   empty state says they have no active projects and who can give access,
   and every other page says why it is empty without a
   word about projects they cannot see. New project shows only to a person
   who may create one. A person with a project and nothing remembered lands
   on the chooser too, never on their first project, and one who loses the
   project they are in sees the chooser with a note, and nothing opens by
   itself once a project is shared again. Startup's own cases are in
   startupSelection.test.tsx. Team sync, which covers the home organization
   only, asks about that organization's projects. The phone's Roadmap gives the desktop's note for
   every scope with nothing to schedule. A project's Roadmap keeps its
   timeline with the milestones of its window behind the note, and the
   phone's agenda lists the scope's milestones under it, as the Overview
   does under its own note; My view's flags sit on its rows, so it shows
   none, and an address that once named all projects opens the chooser.
   The Roadmap's flags and
   the Milestones window a flag opens read the milestone stand-in
   (store/milestoneStandIn.setup.ts). */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('./lib/convex', async () => ({
  convex: network,
  live: (await import('./store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('./lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const MEMBER =
  'No active projects are shared with you. Ask an organization admin or a project lead for access.'
const ADMIN =
  'You take part in no active projects. Settings › Projects › All projects lists every project of your organization.'
// the chooser's empty state words it as the All projects directory does,
// which tells a standard user this and an admin what every page does
// (ADMIN)
const CHOOSER_MEMBER =
  'You have no active projects. Ask an organization admin or a project lead for access.'

let container: HTMLDivElement
let root: Root
let phone = false
// the milestone reads App subscribed, by query
let milestoneReads: string[] = []

beforeEach(() => {
  phone = false
  milestoneReads = []
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.scrollTo = () => {}
  Element.prototype.getAnimations = () => []
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
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** The fixture's organization with no project, its one person holding
    `role`. */
function noProjects(role: 'admin' | 'user' | 'viewer'): Snapshot {
  const snap = plannerFixture()
  snap.projects = []
  snap.profiles[0].org_role = role
  return snap
}

/** Boots the real store on `snap` and renders App at `path`. Returns a
    function that publishes another workspace. */
async function app(snap: Snapshot, path = '/app/testbed') {
  vi.resetModules()
  history.replaceState(null, '', path)
  let publish = (_: Snapshot) => {}
  // what the server holds: the workspace last published
  let server = snap
  // the navigation reads open now, which the server answers again after
  // a change of access, as Convex reruns them
  const navReads = new Set<() => void>()
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      publish = (value) => {
        server = value
        next(structuredClone(value))
        for (const answer of navReads) answer()
      }
      publish(snap)
    } else if (isProjectNavRead(name)) {
      const answer = () => answerProjectNav(server, name, args, next, fail)
      navReads.add(answer)
      answer()
      return () => {
        navReads.delete(answer)
      }
    } else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'tasks:board') next(boardStandIn(server, args as BoardArgs))
    else if (name === 'tasks:roadmap' || name === 'tasks:roadmapDependencies')
      next(answerRoadmap(server, name, args))
    else if (name.startsWith('overview:')) answerOverview(server, name, args, next, fail)
    else if (isMilestoneRead(name)) {
      milestoneReads.push(name)
      answerMilestones(server, name, args, next, fail)
    }
    return () => {}
  })
  // a project address by number resolves through projectNav.resolve
  network.query.mockImplementation(async (ref, args) =>
    getFunctionName(ref) === 'projectNav:resolve'
      ? queryProjectNav(server, 'projectNav:resolve', args)
      : null,
  )
  network.mutation.mockResolvedValue(null)
  const store = await import('./store/planner')
  await store.initStore()
  const { syncStatus } = await import('./lib/syncStatus')
  syncStatus.setSocket({ connected: true, everConnected: true })
  const { default: App } = await import('./App')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <App />
      </TooltipProvider>,
    ),
  )
  return (next: Snapshot) => act(async () => publish(next))
}

/** Waits for `text` on the page, through lazy views that can take seconds
    to load on a busy worker. */
const shows = (text: string) =>
  vi.waitFor(() => expect(document.body.textContent).toContain(text), { timeout: 10_000 })
const button = (label: string) =>
  [...document.querySelectorAll('main button')].find(
    (button) => button.textContent?.trim() === label,
  )
const newProject = () => button('New project')
/** The project chooser's state, once it shows one. */
const chooser = (state: string) =>
  vi.waitFor(
    () =>
      expect(
        document
          .querySelector('[data-project-chooser]')
          ?.getAttribute('data-project-chooser-state'),
      ).toBe(state),
    { timeout: 10_000 },
  )
/** The project App remembers for the fixture's person. */
const remembered = (snap: Snapshot) =>
  JSON.parse(localStorage.getItem(`planner.ui.v1:${snap.profiles[0].id}`) ?? '{}').lastProject
    ?.project_id

/** Unmounts App, as leaving the page does. */
async function reload() {
  await act(async () => root.unmount())
  root = createRoot(container)
  vi.restoreAllMocks()
}

/** The fixture with its one person a member of Plan, a project over the
    fixture's sub-project. */
function member(): Snapshot {
  const snap = plannerFixture()
  const base = snap.projects[0]
  // the share alone gives access, so its removal takes it away
  delete base.lead_id
  snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
  base.parent_id = 'plan'
  snap.profiles[0].org_role = 'user'
  snap.access.push({ project_id: 'plan', profile_id: snap.profiles[0].id, level: 'user' })
  return snap
}

describe('a person who can see no project', () => {
  it('lands on the project chooser, whose empty state says why and offers New project', async () => {
    await app(noProjects('user'))
    await chooser('empty')
    await shows(CHOOSER_MEMBER)
    expect(document.body.textContent).not.toContain(MEMBER)
    // the front door, never All projects
    expect(location.pathname).toBe('/app/testbed')
    expect(document.querySelector('[data-workspace-view]')).toBeNull()
    expect(newProject()).toBeDefined()
    // the sidebar's tree says so once the server's list ended empty
    await vi.waitFor(() =>
      expect(document.querySelector('aside [data-sidebar-end]')?.textContent).toBe(
        'No active projects.',
      ),
    )
  })

  it('offers no New project to a person who may not create one', async () => {
    const snap = noProjects('user')
    snap.orgs[0].project_creators = 'admins'
    await app(snap, '/app/testbed/board')
    await chooser('empty')
    await shows(CHOOSER_MEMBER)
    expect(newProject()).toBeUndefined()
    await act(async () => root.unmount())
    root = createRoot(container)
    await app(noProjects('viewer'), '/app/testbed/roadmap')
    await chooser('empty')
    expect(newProject()).toBeUndefined()
  })

  it('tells an admin where every project of the organization is listed', async () => {
    await app(noProjects('admin'))
    await chooser('empty')
    await shows(ADMIN)
    expect(document.body.textContent).not.toContain(CHOOSER_MEMBER)
    expect(newProject()).toBeDefined()
  })

  it('says why Team sync and the Inbox are empty', async () => {
    await app(noProjects('user'), '/app/testbed/sync')
    await shows('Nothing to review yet')
    expect(document.body.textContent).toContain(MEMBER)
    await act(async () => root.unmount())
    root = createRoot(container)
    await app(noProjects('user'), '/app/~/inbox')
    await shows(`No messages yet. ${MEMBER}`)
  })

  it('on the phone, says why its task list and roadmap are empty', async () => {
    phone = true
    // My tasks and My view's Roadmap, which need no project
    await app(noProjects('user'), '/app/~/board/mine')
    await shows(MEMBER)
    expect(document.body.textContent).not.toContain('Create a task to get started.')
    expect(newProject()).toBeDefined()
    await act(async () => root.unmount())
    root = createRoot(container)
    await app(noProjects('user'), '/app/~/roadmap/mine')
    await shows('Nothing to schedule yet')
    expect(document.body.textContent).toContain(MEMBER)
    // the agenda has no milestone or task to plan
    expect(document.body.textContent).not.toContain('Upcoming milestones')
  })
})

describe('a person with a project', () => {
  it('lands on the chooser with nothing remembered, never on the first project', async () => {
    await app(member())
    await chooser('choose')
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-project-chooser] [data-project-pick]')?.textContent,
      ).toBe('Plan'),
    )
    expect(location.pathname).toBe('/app/testbed')
    expect(document.querySelector('[data-workspace-view]')).toBeNull()
    expect(document.body.textContent).not.toContain(MEMBER)
  })

  it('shows the chooser with a note when the last share goes, and opens nothing once it returns', async () => {
    const snap = member()
    const publish = await app(snap, '/app/testbed/overview/p/2')
    await shows('No tasks yet')
    // the project the person opened by its address is remembered
    await vi.waitFor(() => expect(remembered(snap)).toBe('plan'))
    await publish({ ...snap, access: [], delivered_at: '2026-09-15T09:00:00.000Z' })
    // the note over the empty state, as no project is left to choose
    await chooser('empty')
    expect(document.querySelector('[data-project-chooser-note]')?.textContent).toBe(
      'Plan is no longer available to you.',
    )
    expect(document.body.textContent).toContain(CHOOSER_MEMBER)
    // its address gives way to the front door, never All projects, and the
    // loss leaves what is remembered
    expect(location.pathname).toBe('/app/testbed')
    expect(remembered(snap)).toBe('plan')
    await publish({ ...snap, delivered_at: '2026-09-15T10:00:00.000Z' })
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 50)))
    expect(location.pathname).toBe('/app/testbed')
    expect(document.querySelector('[data-workspace-view]')).toBeNull()
  })

  it('keeps My view when the person opened it, whatever they see', async () => {
    const snap = member()
    const publish = await app(snap, '/app/~/overview/mine')
    await vi.waitFor(() =>
      expect(document.querySelector('[data-workspace-view="overview"]')).not.toBeNull(),
    )
    await publish({ ...snap, access: [], delivered_at: '2026-09-15T09:00:00.000Z' })
    await shows(MEMBER)
    await publish({ ...snap, delivered_at: '2026-09-15T10:00:00.000Z' })
    await vi.waitFor(() => expect(document.body.textContent).not.toContain(MEMBER))
    expect(location.pathname).toBe('/app/~/overview/mine')
    // My view is never remembered
    expect(remembered(snap)).toBeUndefined()
  })

  it('opens an address that once named all projects as the startup rule does, on the chooser', async () => {
    const snap = member()
    await app(snap, '/app/~/roadmap/all')
    await chooser('choose')
    // the front door, in place, with no view and nothing remembered
    expect(location.pathname).toBe('/app/testbed')
    expect(document.querySelector('[data-workspace-view]')).toBeNull()
    expect(document.querySelector('[data-project-chooser]')?.textContent).toContain(
      'The project you choose opens on the Roadmap.',
    )
    expect(remembered(snap)).toBeUndefined()
  })
})

describe('Team sync, which covers the home organization', () => {
  /** A person of the fixture's organization holding `role`, who sees no
      project there and is a guest on a project of Other Labs. */
  function guestElsewhere(role: 'admin' | 'user'): Snapshot {
    const snap = noProjects(role)
    const org = { ...snap.orgs[0], id: crypto.randomUUID(), name: 'Other Labs', slug: 'other' }
    const guest = { ...snap.profiles[0], id: crypto.randomUUID(), org_id: org.id }
    snap.orgs.push(org)
    snap.profiles.push({ ...guest, org_role: 'guest' })
    snap.myProfileIds.push(guest.id)
    const base = plannerFixture().projects[0]
    snap.projects.push({ ...base, id: 'away', org_id: org.id, type: 'meta', name: 'Away' })
    snap.access.push({ project_id: 'away', profile_id: guest.id, level: 'user' })
    return snap
  }

  it('says which organization it covers when none of its projects is shared', async () => {
    await app(guestElsewhere('user'), '/app/testbed/sync')
    await shows('Nothing to review yet')
    expect(document.body.textContent).toContain(
      'Team sync covers Testbed Labs, where no active projects are shared with you. Ask an organization admin or a project lead for access.',
    )
    await act(async () => root.unmount())
    root = createRoot(container)
    await app(guestElsewhere('admin'), '/app/testbed/sync')
    await shows(
      'Team sync covers Testbed Labs, where you take part in no active projects. Settings › Projects › All projects lists every project of your organization.',
    )
  })

  it('leaves the other pages to the projects of every organization', async () => {
    // the chooser at the front door lists them
    await app(guestElsewhere('user'), '/app/testbed')
    await shows('Away')
    expect(document.body.textContent).not.toContain('Team sync covers')
    expect(document.body.textContent).not.toContain(MEMBER)
  })
})

/** member() with Bare, a project without sub-projects that the person
    leads. */
function bare(): Snapshot {
  const snap = member()
  const me = snap.profiles[0].id
  const bare = { id: 'bare', key: 'BARE', num: 3, name: 'Bare', lead_id: me }
  snap.projects.push({ ...snap.projects[1], ...bare })
  snap.access.push({ project_id: 'bare', profile_id: me, level: 'user' })
  return snap
}

/** bare() without Bare's lead, so the person, holding `role`, sees it by
    their User grant alone. */
function granted(role: 'admin' | 'user'): Snapshot {
  const snap = bare()
  const project = snap.projects.find((p) => p.id === 'bare')
  if (project) delete project.lead_id
  snap.profiles[0].org_role = role
  return snap
}

describe('New sub-project in a project without one', () => {
  // whoever manages the project gets it: an organization admin by their
  // role, and a standard user only as its lead, never by a grant
  for (const [role, offered] of [
    ['admin', true],
    ['user', false],
  ] as const)
    it(`${offered ? 'offers' : 'does not offer'} it to ${role === 'admin' ? 'an admin' : 'a standard user'} who sees the project by a grant without leading it`, async () => {
      for (const view of ['overview', 'roadmap', 'board']) {
        await app(granted(role), `/app/testbed/${view}/p/3`)
        await shows('Tasks live in sub-projects.')
        expect(button('New sub-project') !== undefined, view).toBe(offered)
        await reload()
      }
    })
})

/** `snap` with a milestone `name` on `project` a week from now, inside the
    Roadmap's default window. Several may share the week. */
function withMilestone(snap: Snapshot, project: string, name: string): Snapshot {
  const day = new Date()
  day.setDate(day.getDate() + 7 - ((day.getDay() + 6) % 7))
  const pad = (n: number) => String(n).padStart(2, '0')
  const week = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
  const created_at = '2026-09-14T08:00:00.000Z'
  const id = `ms-${project}-${snap.milestones.length}`
  snap.milestones.push({ id, project_id: project, name, week, created_at })
  return snap
}

describe('the Roadmap of a scope with nothing to schedule', () => {
  it("keeps a project's timeline and flags behind the note on a computer, and no flag in My view or on the chooser", async () => {
    const header = () => document.querySelector('[data-workspace-view] [data-roadmap-header]')
    await app(bare(), '/app/testbed/roadmap/p/3')
    await shows('Tasks live in sub-projects.')
    // a project keeps its frame behind any note, also without a milestone
    expect(header()).not.toBeNull()
    expect(document.querySelector('[data-msflag]')).toBeNull()
    await reload()
    await app(withMilestone(bare(), 'bare', 'Bare launch'), '/app/testbed/roadmap/p/3')
    await shows('Tasks live in sub-projects.')
    // the flags of its window, once the range read answered
    await vi.waitFor(() =>
      expect(document.querySelector('[data-msband] [data-msflag]')?.textContent).toBe(
        'Bare launch',
      ),
    )
    expect(document.querySelector('[data-no-match]')).toBeNull()
    await reload()
    milestoneReads = []
    await app(withMilestone(member(), 'plan', 'Plan launch'), '/app/~/roadmap/mine')
    await shows('Nothing assigned to you')
    // My view keeps its frame, and with no row no flag and no read
    expect(header()).not.toBeNull()
    expect(document.querySelector('[data-msflag]')).toBeNull()
    expect(milestoneReads).not.toContain('milestones:between')
    // an address that once named all projects, when no project the person
    // sees has a sub-project: the chooser, with no frame, flag or read
    await reload()
    milestoneReads = []
    const only = withMilestone(bare(), 'bare', 'Bare launch')
    only.access = only.access.filter((grant) => grant.project_id === 'bare')
    await app(only, '/app/~/roadmap/all')
    await chooser('choose')
    expect(header()).toBeNull()
    expect(document.querySelector('[data-msflag]')).toBeNull()
    expect(milestoneReads).not.toContain('milestones:between')
    expect(document.querySelector('[data-track]')).toBeNull()
  })

  it('stands the milestones of one week in rows of their own', async () => {
    const snap = withMilestone(withMilestone(bare(), 'bare', 'Bare launch'), 'bare', 'Bare review')
    await app(snap, '/app/testbed/roadmap/p/3')
    await shows('Tasks live in sub-projects.')
    await vi.waitFor(() => expect(document.querySelectorAll('[data-msflag]')).toHaveLength(2))
    const flags = [...document.querySelectorAll<HTMLElement>('[data-msflag]')]
    expect(flags.map((flag) => flag.textContent)).toEqual(['Bare launch', 'Bare review'])
    expect(new Set(flags.map((flag) => flag.style.bottom)).size).toBe(2)
  })

  it('opens a milestone from its flag with the keyboard', async () => {
    await app(withMilestone(bare(), 'bare', 'Bare launch'), '/app/testbed/roadmap/p/3')
    await shows('Tasks live in sub-projects.')
    const flag = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-msflag]')
      if (!found) throw new Error('no flag yet')
      return found
    })
    // a button in the tab order, named by the whole name however it is cut
    expect(flag?.getAttribute('role')).toBe('button')
    expect(flag?.tabIndex).toBe(0)
    expect(flag?.textContent).toBe('Bare launch')
    await act(async () => {
      flag?.focus()
      flag?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    // the Milestones window, with that milestone's editor open
    await vi.waitFor(
      () => {
        const dialog = document.querySelector('[role="dialog"]')
        expect(dialog?.textContent).toContain('Milestones')
        const fields = [...(dialog?.querySelectorAll('input') ?? [])]
        expect(fields.map((field) => field.value)).toContain('Bare launch')
      },
      { timeout: 10_000 },
    )
  }, 20_000)
})

/** The milestone rows of the Overview's Milestones section. */
const milestoneRows = () => [...document.querySelectorAll('main .overview-milestone')]

describe('the Overview of a scope with nothing to summarize', () => {
  it('keeps the scope’s milestones under the note on a computer', async () => {
    await app(bare(), '/app/testbed/overview/p/3')
    await shows('Tasks live in sub-projects.')
    expect(document.querySelector('main .overview-section')).toBeNull()
    await reload()
    await app(withMilestone(bare(), 'bare', 'Bare launch'), '/app/testbed/overview/p/3')
    await shows('Tasks live in sub-projects.')
    expect(milestoneRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('Bare launch'),
    ])
    expect(button('New sub-project')).toBeDefined()
    expect(document.querySelector('main [aria-label="New milestone"]')).not.toBeNull()
    // nothing counted, so no summary and no status strip
    expect(document.querySelector('[data-ov-summary], [data-ov-strip]')).toBeNull()
    // My view whose sub-project holds no task of the person's lists no
    // milestone, as it covers only the projects that hold their own work
    // (owner, 28 October 2026), so its note is the whole page
    await reload()
    const plan = withMilestone(member(), 'plan', 'Plan launch')
    await app(plan, '/app/~/overview/mine')
    await shows('Nothing assigned to you')
    expect(milestoneRows()).toHaveLength(0)
    expect(document.querySelector('[data-overview-milestones]')).toBeNull()
    // an address that once named all projects opens the chooser, which
    // lists no milestone
    await reload()
    await app(plan, '/app/~/overview/all')
    await chooser('choose')
    expect(milestoneRows()).toHaveLength(0)
    await reload()
    await app(plan, '/app/testbed/overview/p/2')
    await shows('No tasks yet')
    expect(button('New task')).toBeDefined()
    expect(milestoneRows()).toHaveLength(1)
    // and so does it when no project the person sees has a sub-project
    await reload()
    const only = withMilestone(bare(), 'bare', 'Bare launch')
    only.access = only.access.filter((grant) => grant.project_id === 'bare')
    await app(only, '/app/~/overview/all')
    await chooser('choose')
    expect(milestoneRows()).toHaveLength(0)
  })

  it('keeps them on the phone too', async () => {
    phone = true
    await app(withMilestone(bare(), 'bare', 'Bare launch'), '/app/testbed/overview/p/3')
    await shows('Tasks live in sub-projects.')
    expect(milestoneRows()).toHaveLength(1)
    await reload()
    await app(withMilestone(member(), 'plan', 'Plan launch'), '/app/~/overview/mine')
    await shows('Nothing assigned to you')
    expect(milestoneRows()).toHaveLength(0)
  })
})

describe('the phone Roadmap of a scope with nothing to schedule', () => {
  beforeEach(() => {
    phone = true
  })

  it('says that tasks live in sub-projects, in a project without one', async () => {
    await app(bare(), '/app/testbed/roadmap/p/3')
    await shows('Nothing to schedule yet')
    expect(document.body.textContent).toContain('Tasks live in sub-projects.')
    expect(button('New sub-project')).toBeDefined()
    // what the desktop's toolbar keeps, and no agenda of nothing; with no
    // task to move, Auto-move is there and disabled
    expect(button('New milestone')).toBeDefined()
    expect(button('Auto-move')).toHaveProperty('disabled', true)
    expect(document.body.textContent).not.toContain('Upcoming milestones')
  })

  it('says that nothing is assigned to the person, in My view', async () => {
    await app(member(), '/app/~/roadmap/mine')
    await shows('Nothing assigned to you')
    expect(document.body.textContent).not.toContain('Upcoming milestones')
  })

  it('lists the scope’s milestones under the note', async () => {
    await app(withMilestone(bare(), 'bare', 'Bare launch'), '/app/testbed/roadmap/p/3')
    await shows('Tasks live in sub-projects.')
    expect(document.body.textContent).toContain('Upcoming milestones')
    expect(document.body.textContent).toContain('Bare launch')
    // My view's agenda lists only the projects that hold the person's own
    // work, so none here, and its note is all it shows
    await reload()
    await app(withMilestone(member(), 'plan', 'Plan launch'), '/app/~/roadmap/mine')
    await shows('Nothing assigned to you')
    expect(document.body.textContent).not.toContain('Plan launch')
    expect(document.body.textContent).not.toContain('Upcoming milestones')
    expect(document.body.textContent).not.toContain('Task schedule')
  })
})

// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { plannerFixture, type Snapshot } from './store/plannerFixture.setup'

/* The pages of a person who can see no active project, on the real store
   and App: they land on All projects rather than on a page with no view,
   and every page says why it is empty and who can give access, without a
   word about projects they cannot see. New project shows only to a person
   who may create one. A person with a project lands on it, as before, also
   once one is shared with a person who landed on All projects for want of
   one. Team sync, which covers the home organization only, asks about that
   organization's projects. The phone's Roadmap gives the desktop's note for
   every scope with nothing to schedule, and both keep showing the scope's
   milestones, as the Overview does under its own note. */

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
const ADMIN = 'Your organization has no active projects.'

let container: HTMLDivElement
let root: Root
let phone = false

beforeEach(() => {
  phone = false
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
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      publish = (value) => next(structuredClone(value))
      publish(snap)
    } else if (name === 'snapshot:commentThread') next({ comments: [], earlier: false, events: [] })
    return () => {}
  })
  network.query.mockResolvedValue(null)
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
/** The scope App saved for the fixture's person. */
const savedScope = (snap: Snapshot) =>
  JSON.parse(localStorage.getItem(`planner.ui.v1:${snap.profiles[0].id}`) ?? '{}').scope

/** Unmounts App, as leaving the page does. With `type`, the next page load
    is a reload ('reload') or Back or Forward ('back_forward'), as
    PerformanceNavigationTiming says; without it, one that opens an address
    anew. */
async function reload(type?: 'reload' | 'back_forward') {
  await act(async () => root.unmount())
  root = createRoot(container)
  vi.restoreAllMocks()
  const load = {
    name: '',
    entryType: 'navigation',
    startTime: 0,
    duration: 0,
    toJSON: () => ({}),
    type,
  }
  if (type) vi.spyOn(performance, 'getEntriesByType').mockReturnValue([load])
}

/** The fixture with its one person a member of Plan, a project over the
    fixture's sub-project. */
function member(): Snapshot {
  const snap = plannerFixture()
  const base = snap.projects[0]
  snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
  base.parent_id = 'plan'
  snap.profiles[0].org_role = 'user'
  snap.access.push({ project_id: 'plan', profile_id: snap.profiles[0].id, level: 'user' })
  return snap
}

describe('a person who can see no project', () => {
  it('lands on All projects, which says why it is empty and offers New project', async () => {
    await app(noProjects('user'))
    await shows('Nothing to summarize yet')
    expect(document.body.textContent).toContain(MEMBER)
    expect(location.pathname).toBe('/app/~/overview/all')
    expect(newProject()).toBeDefined()
  })

  it('offers no New project to a person who may not create one', async () => {
    const snap = noProjects('user')
    snap.orgs[0].project_creators = 'admins'
    await app(snap, '/app/testbed/board')
    await shows('Nothing to show yet')
    expect(document.body.textContent).toContain(MEMBER)
    expect(newProject()).toBeUndefined()
    await act(async () => root.unmount())
    root = createRoot(container)
    await app(noProjects('viewer'), '/app/testbed/roadmap')
    await shows('Nothing to schedule yet')
    expect(newProject()).toBeUndefined()
  })

  it('tells an admin that the organization has none', async () => {
    await app(noProjects('admin'))
    await shows(ADMIN)
    expect(document.body.textContent).not.toContain(MEMBER)
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
    await app(noProjects('user'), '/app/~/board/all')
    await shows(MEMBER)
    expect(document.body.textContent).not.toContain('Create a task to get started.')
    expect(newProject()).toBeDefined()
    await act(async () => root.unmount())
    root = createRoot(container)
    await app(noProjects('user'), '/app/~/roadmap/all')
    await shows('Nothing to schedule yet')
    expect(document.body.textContent).toContain(MEMBER)
    // the agenda has no milestone or task to plan
    expect(document.body.textContent).not.toContain('Upcoming milestones')
  })
})

describe('a person with a project', () => {
  it('lands on it, with no word about missing projects', async () => {
    await app(member())
    await shows('No tasks yet')
    expect(location.pathname).toBe('/app/testbed/overview/p/2')
    expect(document.body.textContent).not.toContain(MEMBER)
  })

  it('moves to All projects when the last share goes, and back when it returns', async () => {
    const snap = member()
    const publish = await app(snap)
    await shows('No tasks yet')
    await publish({ ...snap, access: [], delivered_at: '2026-09-15T09:00:00.000Z' })
    await shows(MEMBER)
    expect(location.pathname).toBe('/app/~/overview/all')
    expect(savedScope(snap)).toBe('plan')
    await publish({ ...snap, delivered_at: '2026-09-15T10:00:00.000Z' })
    await vi.waitFor(() => expect(location.pathname).toBe('/app/testbed/overview/p/2'))
  })

  it('lands on the first one shared after landing on All projects, which it never saves', async () => {
    const snap = member()
    const publish = await app({ ...snap, access: [] })
    await shows(MEMBER)
    expect(location.pathname).toBe('/app/~/overview/all')
    expect(savedScope(snap)).toBeUndefined()
    await publish({ ...snap, delivered_at: '2026-09-15T09:00:00.000Z' })
    await vi.waitFor(() => expect(location.pathname).toBe('/app/testbed/overview/p/2'))
    expect(savedScope(snap)).toBe('plan')
  })

  it('keeps All projects that the person chose, after a reload while they see none', async () => {
    const snap = member()
    const publish = await app(snap, '/app/~/overview/all')
    await shows('No tasks yet')
    await publish({ ...snap, access: [], delivered_at: '2026-09-15T09:00:00.000Z' })
    await shows(MEMBER)
    await reload()
    const again = await app({ ...snap, access: [] }, '/app/~/overview/all')
    await shows(MEMBER)
    await again({ ...snap, delivered_at: '2026-09-15T10:00:00.000Z' })
    await vi.waitFor(() => expect(document.body.textContent).not.toContain(MEMBER))
    expect(location.pathname).toBe('/app/~/overview/all')
    expect(savedScope(snap)).toBe('all')
  })

  it('keeps All projects that the person picks while it is App’s', async () => {
    const snap = member()
    const publish = await app({ ...snap, access: [] })
    await shows(MEMBER)
    const all = document.querySelector<HTMLElement>('[data-all-nav]')
    await act(async () => all?.click())
    expect(savedScope(snap)).toBe('all')
    await publish({ ...snap, delivered_at: '2026-09-15T09:00:00.000Z' })
    await vi.waitFor(() => expect(document.body.textContent).not.toContain(MEMBER))
    expect(location.pathname).toBe('/app/~/overview/all')
  })

  it('opens the project shared meanwhile on a reload of App’s All projects', async () => {
    const snap = member()
    await app({ ...snap, access: [] })
    await shows(MEMBER)
    await reload('reload')
    await app({ ...snap, access: [] }, '/app/~/overview/all')
    await shows(MEMBER)
    expect(savedScope(snap)).toBeUndefined()
    await reload('back_forward')
    await app(snap, '/app/~/overview/all')
    await vi.waitFor(() => expect(location.pathname).toBe('/app/testbed/overview/p/2'))
    expect(savedScope(snap)).toBe('plan')
  })

  it('keeps an All projects address opened anew in the tab where App had it', async () => {
    const snap = member()
    await app({ ...snap, access: [] })
    await shows(MEMBER)
    await reload()
    await app(snap, '/app/~/roadmap/all')
    await vi.waitFor(() => expect(savedScope(snap)).toBe('all'))
    expect(location.pathname).toBe('/app/~/roadmap/all')
  })

  it('keeps All projects when the person opened it', async () => {
    const snap = member()
    const publish = await app(snap, '/app/~/overview/all')
    await shows('No tasks yet')
    await publish({ ...snap, access: [], delivered_at: '2026-09-15T09:00:00.000Z' })
    await shows(MEMBER)
    await publish({ ...snap, delivered_at: '2026-09-15T10:00:00.000Z' })
    await vi.waitFor(() => expect(document.body.textContent).not.toContain(MEMBER))
    expect(location.pathname).toBe('/app/~/overview/all')
    expect(savedScope(snap)).toBe('all')
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
    await shows('Team sync covers Testbed Labs, which has no active projects.')
  })

  it('leaves the other pages to the projects of every organization', async () => {
    await app(guestElsewhere('user'), '/app/~/overview/all')
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
  it('keeps the flags of its milestones behind the note on a computer', async () => {
    await app(bare(), '/app/testbed/roadmap/p/3')
    await shows('Tasks live in sub-projects.')
    expect(document.querySelector('[data-msflag]')).toBeNull()
    await reload()
    await app(withMilestone(bare(), 'bare', 'Bare launch'), '/app/testbed/roadmap/p/3')
    await shows('Tasks live in sub-projects.')
    expect(document.querySelector('[data-msflag]')?.textContent).toBe('Bare launch')
    expect(document.querySelector('[data-no-match]')).toBeNull()
    await reload()
    await app(withMilestone(member(), 'plan', 'Plan launch'), '/app/~/roadmap/mine')
    await shows('Nothing assigned to you')
    expect(document.querySelector('[data-msflag]')?.textContent).toBe('Plan launch')
    // All projects, when no project the person sees has a sub-project
    await reload()
    const only = withMilestone(bare(), 'bare', 'Bare launch')
    only.access = only.access.filter((grant) => grant.project_id === 'bare')
    await app(only, '/app/~/roadmap/all')
    await shows('Tasks live in sub-projects.')
    expect(document.querySelector('[data-msflag]')?.textContent).toBe('Bare launch')
    // and no empty heading for that project above the note
    expect(document.querySelector('[data-track]')).toBeNull()
  })

  it('stands the milestones of one week in rows of their own', async () => {
    const snap = withMilestone(withMilestone(bare(), 'bare', 'Bare launch'), 'bare', 'Bare review')
    await app(snap, '/app/testbed/roadmap/p/3')
    await shows('Tasks live in sub-projects.')
    const flags = [...document.querySelectorAll<HTMLElement>('[data-msflag]')]
    expect(flags.map((flag) => flag.textContent)).toEqual(['Bare launch', 'Bare review'])
    expect(new Set(flags.map((flag) => flag.style.bottom)).size).toBe(2)
  })

  it('opens a milestone from its flag with the keyboard', async () => {
    await app(withMilestone(bare(), 'bare', 'Bare launch'), '/app/testbed/roadmap/p/3')
    await shows('Tasks live in sub-projects.')
    const flag = document.querySelector<HTMLElement>('[data-msflag]')
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
    // a project and My view whose sub-project holds no task
    await reload()
    const plan = withMilestone(member(), 'plan', 'Plan launch')
    await app(plan, '/app/~/overview/mine')
    await shows('Nothing assigned to you')
    expect(milestoneRows()).toHaveLength(1)
    await reload()
    await app(plan, '/app/~/overview/all')
    await shows('No tasks yet')
    expect(milestoneRows()).toHaveLength(1)
    await reload()
    await app(plan, '/app/testbed/overview/p/2')
    await shows('No tasks yet')
    expect(button('New task')).toBeDefined()
    expect(milestoneRows()).toHaveLength(1)
    // All projects, when no project the person sees has a sub-project
    await reload()
    const only = withMilestone(bare(), 'bare', 'Bare launch')
    only.access = only.access.filter((grant) => grant.project_id === 'bare')
    await app(only, '/app/~/overview/all')
    await shows('Tasks live in sub-projects.')
    expect(milestoneRows()).toHaveLength(1)
  })

  it('keeps them on the phone too', async () => {
    phone = true
    await app(withMilestone(bare(), 'bare', 'Bare launch'), '/app/testbed/overview/p/3')
    await shows('Tasks live in sub-projects.')
    expect(milestoneRows()).toHaveLength(1)
    await reload()
    await app(withMilestone(member(), 'plan', 'Plan launch'), '/app/~/overview/mine')
    await shows('Nothing assigned to you')
    expect(milestoneRows()).toHaveLength(1)
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
    // what the desktop's toolbar keeps, and no agenda of nothing
    expect(button('New milestone')).toBeDefined()
    expect(document.body.textContent).toContain('Planning tools')
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
    await reload()
    await app(withMilestone(member(), 'plan', 'Plan launch'), '/app/~/roadmap/mine')
    await shows('Nothing assigned to you')
    expect(document.body.textContent).toContain('Plan launch')
    expect(document.body.textContent).not.toContain('Task schedule')
  })
})

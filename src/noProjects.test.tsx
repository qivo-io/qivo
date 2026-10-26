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
   every scope with nothing to schedule. */

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

describe('the phone Roadmap of a scope with nothing to schedule', () => {
  beforeEach(() => {
    phone = true
  })

  it('says that tasks live in sub-projects, in a project without one', async () => {
    const snap = member()
    const me = snap.profiles[0].id
    const bare = { id: 'bare', key: 'BARE', num: 3, name: 'Bare', lead_id: me }
    snap.projects.push({ ...snap.projects[1], ...bare })
    snap.access.push({ project_id: 'bare', profile_id: me, level: 'user' })
    await app(snap, '/app/testbed/roadmap/p/3')
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
})

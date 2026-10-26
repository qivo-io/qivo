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
   who may create one. A person with a project lands on it, as before. */

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
const newProject = () =>
  [...document.querySelectorAll('main button')].find(
    (button) => button.textContent?.trim() === 'New project',
  )

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

  it('lands on it, with no word about missing projects', async () => {
    await app(member())
    await shows('No tasks yet')
    expect(location.pathname).toBe('/app/testbed/overview/p/2')
    expect(document.body.textContent).not.toContain(MEMBER)
  })

  it('moves to All projects, which says why it is empty, when the last share goes', async () => {
    const snap = member()
    const publish = await app(snap)
    await shows('No tasks yet')
    await publish({ ...snap, access: [], delivered_at: '2026-09-15T09:00:00.000Z' })
    await shows(MEMBER)
    expect(location.pathname).toBe('/app/~/overview/all')
  })
})

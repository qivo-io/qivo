// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrgCreate } from '../convex/lib/billingAccess'
import { TooltipProvider } from './components/ui/tooltip'
import { plannerFixture, type Snapshot } from './store/plannerFixture.setup'

/* The sidebar's and the phone project list's "Create your organization"
   entry, on the real store, for a login whose only seat it can open is a
   guest seat. It shows only while the root part says the server would
   create the organization (P.orgCreate), so not while a home seat the login
   cannot open blocks it, as a deactivated member's does, and it appears
   without a reload once the server would, as when an admin removes that
   seat. An answer without a create state, from an older backend, keeps the
   entry. */

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

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
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

/** The fixture with its one seat a guest's on its one project, and the
    root part's create state `create`, or none. */
function guestOnly(create?: OrgCreate): Snapshot {
  const snap = plannerFixture()
  snap.profiles[0].org_role = 'guest'
  snap.access.push({
    project_id: snap.projects[0].id,
    profile_id: snap.profiles[0].id,
    level: 'user',
  })
  if (create) snap.create = create
  return snap
}

/** Boots the real store on `snap`, and answers it with a function that
    publishes `snap` again with the create state `create`. */
async function boot(snap: Snapshot) {
  vi.resetModules()
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
  const answer = (create: OrgCreate) =>
    act(async () =>
      publish({ ...structuredClone(snap), create, delivered_at: '2026-09-15T09:00:00.000Z' }),
    )
  return { store, answer }
}

/** Renders `node` and waits for `selector`, through lazy modules that can
    take seconds to load on a busy worker. */
async function show(node: ReactNode, selector: string) {
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
  await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull(), {
    timeout: 10_000,
  })
}

describe('the sidebar', () => {
  const entry = () => document.querySelector('[data-org-create]')

  /** Boots App on `snap` with the socket connected, as App's views wait for. */
  async function app(snap: Snapshot) {
    const booted = await boot(snap)
    const { syncStatus } = await import('./lib/syncStatus')
    syncStatus.setSocket({ connected: true, everConnected: true })
    const { default: App } = await import('./App')
    await show(<App />, '[aria-label="Workspace navigation"]')
    return booted
  }

  it('offers no new organization while a home seat blocks it, and one once the server would', async () => {
    const { store, answer } = await app(guestOnly('blocked'))
    expect(store.P.homeOrg).toBe('')
    expect(store.P.orgCreate).toBe('blocked')
    expect(entry()).toBeNull()
    // only the create state changes, as when an admin removes the home seat
    await answer('now')
    expect(store.P.orgCreate).toBe('now')
    await vi.waitFor(() => expect(entry()?.textContent).toBe('Create your organization…'))
  })

  it('offers one for a root answer without a create state, from an older backend', async () => {
    const { store } = await app(guestOnly())
    expect(store.P.orgCreate).toBe('now')
    expect(entry()).not.toBeNull()
  })
})

describe('the phone project list', () => {
  const entry = () =>
    [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Create your organization',
    )

  /** Renders the list on the real store, as App's phone Projects page
      does, with `createOrg` as its action. */
  async function list(snap: Snapshot, createOrg = vi.fn()) {
    const booted = await boot(snap)
    const { ProjectDirectory } = await import('./components/MobileWorkspace')
    const { usePlannerVersion } = await import('./store/usePlannerVersion')
    function Live() {
      usePlannerVersion()
      return <ProjectDirectory actions={{ createOrg, openAll: vi.fn() }} />
    }
    await show(<Live />, '.mobile-project-directory')
    return booted
  }

  it('offers no new organization while a home seat blocks it, and one once the server would', async () => {
    const createOrg = vi.fn()
    const { answer } = await list(guestOnly('blocked'), createOrg)
    expect(entry()).toBeUndefined()
    await answer('now')
    await vi.waitFor(() => expect(entry()).toBeDefined())
    await act(async () => entry()?.click())
    expect(createOrg).toHaveBeenCalledOnce()
  })
})

/** Has the server create the organization, and the workspace read after
    it hold the login's new admin seat. */
function createsOrganization(snap: Snapshot) {
  const created = structuredClone(snap)
  created.orgs.push({ ...snap.orgs[0], id: 'mine', name: 'Mine', slug: 'mine' })
  created.profiles.push({ ...snap.profiles[0], id: 'me', org_id: 'mine', org_role: 'admin' })
  created.myProfileIds.push('me')
  network.mutation.mockImplementation((ref) => {
    if (getFunctionName(ref) === 'identity:createOrganization')
      network.onUpdate.mockImplementation((r, _args, next) => {
        if (getFunctionName(r) === 'workspace:whole') next(structuredClone(created))
        return () => {}
      })
    return Promise.resolve(null)
  })
}

/** Focuses and presses `opener`, then names the organization and creates
    it, or cancels the dialog. */
async function createFrom(opener: HTMLElement, create: boolean) {
  opener.focus()
  await act(async () => opener.click())
  const name = await vi.waitFor(
    () => {
      const found = document.querySelector<HTMLInputElement>('[data-create-org]')
      if (!found) throw new Error('missing the name field')
      return found
    },
    { timeout: 10_000 },
  )
  if (create)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'Mine')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
  const press = [...document.querySelectorAll<HTMLButtonElement>('[data-modal-shell] button')].find(
    (b) => b.textContent === (create ? 'Create' : 'Cancel'),
  )
  await act(async () => press?.click())
  await vi.waitFor(() => expect(document.querySelector('[data-modal-shell]')).toBeNull())
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

describe("the sidebar's Create your organization", () => {
  /** Boots App on a guest-only login, and answers its sidebar entry. */
  async function entry() {
    const snap = guestOnly()
    await boot(snap)
    createsOrganization(snap)
    const { syncStatus } = await import('./lib/syncStatus')
    syncStatus.setSocket({ connected: true, everConnected: true })
    const { default: App } = await import('./App')
    await show(<App />, '[data-org-create]')
    return document.querySelector<HTMLElement>('[data-org-create]') as HTMLElement
  }

  it('is a button the keyboard reaches, and takes focus back after Cancel', async () => {
    const button = await entry()
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type')).toBe('button')
    await createFrom(button, false)
    expect(document.activeElement).toBe(button)
  })

  it("gives focus to the rail's New project once the organization exists, as it leaves", async () => {
    const button = await entry()
    await createFrom(button, true)
    expect(button.isConnected).toBe(false)
    expect(document.activeElement).toBe(document.querySelector('aside [aria-label="New project"]'))
  })
})

describe('Create your organization on the Projects page', () => {
  it('gives focus to New project once the organization exists, as its button leaves', async () => {
    const snap = guestOnly()
    history.replaceState(null, '', '/app/testbed/projects')
    await boot(snap)
    createsOrganization(snap)
    const { syncStatus } = await import('./lib/syncStatus')
    syncStatus.setSocket({ connected: true, everConnected: true })
    const { default: App } = await import('./App')
    const list = '.mobile-project-directory'
    await show(<App />, list)
    const button = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>(`${list} button`)].find(
        (b) => b.textContent?.trim() === text,
      )
    const opener = await vi.waitFor(() => {
      const found = button('Create your organization')
      if (!found) throw new Error('missing the entry')
      return found
    })
    await createFrom(opener, true)
    expect(opener.isConnected).toBe(false)
    expect(document.activeElement).toBe(button('New project'))
  })
})

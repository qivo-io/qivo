// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { plannerFixture, type Snapshot } from './store/plannerFixture.setup'
import { isProjectListRead, projectListsServer } from './store/projectSettingsListsStandIn.setup'
import { isProjectSettingsRead, projectSettingsServer } from './store/projectSettingsStandIn.setup'

/* The address of a project's Settings page whose project the workspace
   does not hold, on App and the real store (lib/router.ts
   noteProjectPage). The server holds Away, a top-level project of Testbed
   Labs that I manage as its organization admin, and the workspace leaves
   it out, as it will for a project an admin only manages once the admin
   access split lands. Its page reads from the server
   (projectSettings.get) and names it by its uuid under its organization,
   so a reload, Back and Forward open it again, and the server's
   `unavailable` sends the page to Your preferences. */

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

const AWAY = '9b0e4c1a-0000-4000-8000-00000000a1a1'

let container: HTMLDivElement
let root: Root
/* What the server holds, and the way to answer its open reads again. */
let server: Snapshot
let rerun: () => void

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
  vi.spyOn(console, 'error').mockImplementation(() => {})
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

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}
/** Waits for `find` to answer, through lazy modules that can take seconds
    to load on a busy worker. */
function waitFor<T>(find: () => T | null | undefined, what: string) {
  return vi.waitFor(
    () => {
      const found = find()
      if (!found) throw new Error(`missing ${what}`)
      return found
    },
    { timeout: 10_000 },
  )
}
const heading = () => document.querySelector('[data-settings-page] h1')?.textContent ?? ''

/** Boots App at `address`, the server holding Away and the workspace
    leaving it out. */
async function boot(address: string) {
  vi.resetModules()
  history.replaceState(null, '', address)
  const snap = plannerFixture()
  server = structuredClone(snap)
  server.projects.push({
    ...snap.projects[0],
    id: AWAY,
    type: 'meta',
    key: 'AWAY',
    num: 7,
    name: 'Away',
  })
  const settings = projectSettingsServer(() => server)
  const lists = projectListsServer(() => server)
  rerun = () => {
    settings.rerun()
    lists.rerun()
  }
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (isProjectSettingsRead(name)) return settings.watch(name, args, next, fail)
    if (isProjectListRead(name)) return lists.watch(name, args, next, fail)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
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
  await settle()
  return store.P
}

/** Moves through the page's history as the browser's Back or Forward
    does, and lets App follow. */
async function go(step: -1 | 1) {
  const moved = new Promise((resolve) =>
    window.addEventListener('popstate', resolve, { once: true }),
  )
  await act(async () => {
    history.go(step)
    await moved
  })
  await settle()
}

describe('the address of a project page the workspace does not hold', { timeout: 30_000 }, () => {
  it('opens on a reload of its uuid address, and Back and Forward open it again', async () => {
    const P = await boot(`/app/testbed/settings/project/${AWAY}`)
    expect(P.project(AWAY)).toBeUndefined()
    await waitFor(() => heading().includes('Away'), 'the page')
    expect(location.pathname).toBe(`/app/testbed/settings/project/${AWAY}`)
    // to Settings › Projects, whose server list holds Away for its admin
    const all = await waitFor(
      () => document.querySelector<HTMLElement>('[data-settings-item="projects"]'),
      'All projects',
    )
    await act(async () => all.click())
    await waitFor(() => document.querySelector(`[data-project-row="${AWAY}"]`), 'Away’s row')
    expect(location.pathname).toBe('/app/testbed/settings/projects')
    await go(-1)
    await waitFor(() => heading().includes('Away'), 'the page again')
    expect(location.pathname).toBe(`/app/testbed/settings/project/${AWAY}`)
    await go(1)
    await waitFor(() => document.querySelector('[data-settings-projects]'), 'the list again')
    expect(location.pathname).toBe('/app/testbed/settings/projects')
  })

  it('names its organization in place once its read answers, and goes to Your preferences once the server says unavailable', async () => {
    await boot(`/app/~/settings/project/${AWAY}`)
    const entries = history.length
    await waitFor(() => heading().includes('Away'), 'the page')
    await waitFor(
      () => location.pathname === `/app/testbed/settings/project/${AWAY}` || null,
      'the address',
    )
    expect(history.length).toBe(entries)
    server.projects = server.projects.filter((p) => p.id !== AWAY)
    await act(async () => rerun())
    await settle()
    await waitFor(() => location.pathname === '/app/~/settings/account' || null, 'the reset')
  })

  it('keeps its uuid address while its Archive or delete window is open, and after it closes', async () => {
    await boot(`/app/testbed/settings/project/${AWAY}`)
    await waitFor(() => heading().includes('Away'), 'the page')
    const remove = await waitFor(
      () => document.querySelector<HTMLButtonElement>(`[data-remove-project="${AWAY}"]`),
      'Archive or delete…',
    )
    await act(async () => remove.click())
    await settle()
    const shell = await waitFor(() => document.querySelector('[data-modal-shell]'), 'the window')
    expect(location.pathname).toBe(`/app/testbed/settings/project/${AWAY}`)
    const cancel = [...shell.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Cancel',
    )
    if (!cancel) throw new Error('no Cancel')
    await act(async () => cancel.click())
    await settle()
    expect(document.querySelector('[data-modal-shell]')).toBeNull()
    expect(location.pathname).toBe(`/app/testbed/settings/project/${AWAY}`)
  })

  it('never opens a uuid under an organization this login cannot resolve', async () => {
    await boot(`/app/elsewhere/settings/project/${AWAY}`)
    await waitFor(() => location.pathname === '/app/~/settings/account' || null, 'the reset')
    expect(heading()).not.toContain('Away')
  })
})

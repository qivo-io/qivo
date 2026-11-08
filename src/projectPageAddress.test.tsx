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
   it out, as it does for a project an admin only manages since the admin
   access split. Its page reads from the server
   (projectSettings.get) and names it by its uuid under its organization,
   so a reload, Back and Forward open it again, and the server's
   `unavailable` sends the page to Your preferences. A numbered address of
   it opens a numbered page, which reads projectSettings.get by its
   organization and number and keeps the address it was opened by, and an
   unpinned one reads the number in the home organization only, never as
   the project of that number another organization holds in the
   workspace. */

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
const PARTNER = '9b0e4c1a-0000-4000-8000-00000000b2b2'

let container: HTMLDivElement
let root: Root
/* What the server holds, and the way to answer its open reads again. */
let server: Snapshot
let rerun: () => void
// the arguments of every projectSettings.get the page asked
let gets: unknown[]

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

/** Gives the login a guest seat in Partner Co, whose project number 7,
    Partner launch, the workspace holds, beside the home organization's
    Away of the same number, which it does not. */
function partnerSeven(snap: Snapshot) {
  const org = crypto.randomUUID()
  const seat = crypto.randomUUID()
  snap.orgs.push({ ...snap.orgs[0], id: org, name: 'Partner Co', slug: 'partner' })
  snap.profiles.push({ ...snap.profiles[0], id: seat, org_id: org, org_role: 'guest' })
  snap.myProfileIds.push(seat)
  snap.projects.push({
    ...snap.projects[0],
    id: PARTNER,
    org_id: org,
    type: 'meta',
    key: 'PART',
    num: 7,
    name: 'Partner launch',
    lead_id: seat,
  })
  snap.access.push({ project_id: PARTNER, profile_id: seat, level: 'user' })
}

/** Boots App at `address`, the server holding Away and the workspace
    leaving it out. `shape` changes the workspace first, which the server
    then holds too. */
async function boot(address: string, shape?: (snap: Snapshot) => void) {
  vi.resetModules()
  history.replaceState(null, '', address)
  const snap = plannerFixture()
  shape?.(snap)
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
  gets = []
  rerun = () => {
    settings.rerun()
    lists.rerun()
  }
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'projectSettings:get') gets.push(args)
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

describe('the numbered address of a project page the workspace does not hold', {
  timeout: 30_000,
}, () => {
  it('opens the page of a project an admin only manages by its organization and number, keeping its numbered address through a reload, Back and Forward', async () => {
    let P = await boot('/app/testbed/settings/project/7')
    expect(P.project(AWAY)).toBeUndefined()
    await waitFor(() => heading().includes('Away'), 'the page')
    const org = P.homeOrg
    expect(gets).toEqual([{ org_id: org, num: 7 }])
    expect(location.pathname).toBe('/app/testbed/settings/project/7')
    expect(
      document
        .querySelector('[data-project-settings-state]')
        ?.getAttribute('data-project-settings-state'),
    ).toBe('ok')
    // a reload opens it again by its number, in the fixture's organization
    // of this boot
    P = await boot('/app/testbed/settings/project/7')
    await waitFor(() => heading().includes('Away'), 'the page after a reload')
    const home = P.homeOrg
    expect(gets).toEqual([{ org_id: home, num: 7 }])
    expect(location.pathname).toBe('/app/testbed/settings/project/7')
    // to Settings › Projects, and Back and Forward
    const all = await waitFor(
      () => document.querySelector<HTMLElement>('[data-settings-item="projects"]'),
      'All projects',
    )
    await act(async () => all.click())
    await waitFor(() => document.querySelector(`[data-project-row="${AWAY}"]`), 'Away’s row')
    expect(location.pathname).toBe('/app/testbed/settings/projects')
    await go(-1)
    await waitFor(() => heading().includes('Away'), 'the page again')
    expect(location.pathname).toBe('/app/testbed/settings/project/7')
    await go(1)
    await waitFor(() => document.querySelector('[data-settings-projects]'), 'the list again')
    await go(-1)
    await waitFor(() => heading().includes('Away'), 'the page once more')
    expect(location.pathname).toBe('/app/testbed/settings/project/7')
    expect(gets.every((a) => JSON.stringify(a) === JSON.stringify({ org_id: home, num: 7 }))).toBe(
      true,
    )
  })

  it('keeps the page while its Archive or delete window holds it after the project leaves, and then goes to Your preferences', async () => {
    await boot('/app/testbed/settings/project/7')
    await waitFor(() => heading().includes('Away'), 'the page')
    const remove = await waitFor(
      () => document.querySelector<HTMLButtonElement>(`[data-remove-project="${AWAY}"]`),
      'Archive or delete…',
    )
    await act(async () => remove.click())
    await settle()
    const shell = await waitFor(() => document.querySelector('[data-modal-shell]'), 'the window')
    // someone else deletes Away while the window is open
    server.projects = server.projects.filter((p) => p.id !== AWAY)
    await act(async () => rerun())
    await settle()
    expect(document.querySelector('[data-modal-shell]')).not.toBeNull()
    expect(heading()).toContain('Away')
    expect(location.pathname).toBe('/app/testbed/settings/project/7')
    // the window says the project went, and closes on Close
    const close = await waitFor(
      () =>
        [...shell.querySelectorAll<HTMLButtonElement>('button')].find(
          (b) => b.textContent?.trim() === 'Close',
        ),
      "the window's Close",
    )
    await act(async () => close.click())
    await settle()
    await waitFor(() => location.pathname === '/app/~/settings/account' || null, 'the reset')
  })

  it('goes to Your preferences for a number no project holds, and reads nothing for one outside the numbers a project can have', async () => {
    await boot('/app/testbed/settings/project/99')
    await waitFor(() => location.pathname === '/app/~/settings/account' || null, 'the reset')
    expect(heading()).not.toContain('Away')
    expect(gets.length).toBeGreaterThan(0)
    for (const n of ['0', String(Number.MAX_SAFE_INTEGER + 1)]) {
      await boot(`/app/testbed/settings/project/${n}`)
      await waitFor(() => location.pathname === '/app/~/settings/account' || null, `the reset ${n}`)
      expect(gets, n).toEqual([])
    }
  })

  it('reads an unpinned number in the home organization, never as the project of that number the workspace holds in another organization', async () => {
    for (const address of ['/app/~/settings/project/7', '/app#/settings/project/7']) {
      const P = await boot(address, partnerSeven)
      expect(P.project(PARTNER)?.num).toBe(7)
      await waitFor(() => heading().includes('Away'), `the page at ${address}`)
      expect(gets).toEqual([{ org_id: P.homeOrg, num: 7 }])
      expect(location.pathname).toBe('/app/testbed/settings/project/7')
      expect(heading()).not.toContain('Partner')
    }
    // a login without a home organization reads no number under `~`
    for (const address of ['/app/~/settings/project/7', '/app#/settings/project/7']) {
      const P = await boot(address, (snap) => {
        partnerSeven(snap)
        snap.profiles[0].org_role = 'guest'
      })
      expect(P.homeOrg).toBe('')
      expect(P.project(PARTNER)?.num).toBe(7)
      await waitFor(() => location.pathname === '/app/~/settings/account' || null, 'the reset')
      expect(gets).toEqual([])
      expect(heading()).not.toContain('Partner')
    }
  })
})

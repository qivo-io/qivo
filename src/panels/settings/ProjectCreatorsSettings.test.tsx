// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'

/* "Who can create new projects?" in Organization settings and the
   "Can create projects" column in Organization > Users, on the real store.
   Nora (me) is the org admin; the roster holds one member of every kind. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../../lib/convex', () => ({ convex: network }))
vi.mock('../../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

type Planner = typeof import('../../store/planner')['P']
type Profile = Snapshot['profiles'][number]
type Setting = Snapshot['orgs'][number]['project_creators']

let P: Planner
let pages: {
  general: typeof import('./OrganizationSettings')
  users: typeof import('./UsersSettings')
  settings: typeof import('../Settings')
  version: typeof import('../../store/usePlannerVersion')
}
let snap: Snapshot
let requests: { name: string; args: Record<string, unknown> }[]
let container: HTMLDivElement
let root: Root

async function load(setting: Setting) {
  vi.resetModules()
  snap = plannerFixture()
  snap.orgs[0].project_creators = setting
  const me = snap.profiles[0]
  Object.assign(me, { id: 'nora', name: 'Nora Berg', created_at: '2026-09-01T08:00:00.000Z' })
  snap.myProfileIds = ['nora']
  let day = 1
  const member = (id: string, name: string, extra: Partial<Profile> = {}): Profile => ({
    ...me,
    id,
    name,
    org_role: 'user',
    auth_user_id: `account-${id}`,
    created_at: `2026-09-1${day++}T08:00:00.000Z`,
    ...extra,
  })
  snap.profiles.push(
    member('leo', 'Leo Martins', { can_create_projects: true }),
    member('aisha', 'Aisha Rahman'),
    member('mira', 'Mira Lind', { auth_user_id: undefined, can_create_projects: true }),
    member('emil', 'Emil Strand', { active: false, can_create_projects: true }),
    member('ingrid', 'Ingrid Holm', { org_role: 'viewer' }),
    member('atlas', 'Atlas', { kind: 'agent' }),
  )
  requests = []
  // the Users page lists agent keys on mount
  network.query.mockResolvedValue([])
  network.onUpdate.mockImplementation((_ref, _args, next) => {
    next(structuredClone(snap))
    return () => {}
  })
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    requests.push({ name, args })
    return new Promise(() => {})
  })
  const store = await import('../../store/planner')
  P = store.P
  await store.initStore()
  pages = {
    general: await import('./OrganizationSettings'),
    users: await import('./UsersSettings'),
    settings: await import('../Settings'),
    version: await import('../../store/usePlannerVersion'),
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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

/* Re-renders on every store change, as the app's shell does. */
function Live({ page }: { page: () => React.ReactNode }) {
  pages.version.usePlannerVersion()
  return page()
}

async function render(page: () => React.ReactNode) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Live page={page} />
      </TooltipProvider>,
    ),
  )
}

const query = <T extends Element>(selector: string) => container.querySelector<T>(selector)
const summary = () => query('[data-project-creators-summary]')?.textContent
const segment = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[data-project-creators] button')].find(
    (button) => button.textContent === label,
  )

describe('Who can create new projects?', () => {
  it('names who can create projects under each setting', async () => {
    await load('admins')
    const setPage = vi.fn()
    await render(() => <pages.general.OrgGeneralPage setPage={setPage} />)
    expect(summary()).toBe(
      'Nora Berg can create projects. Project leads still create sub-projects.',
    )

    await act(async () => segment('Standard users')?.click())
    // admins first, then standard users in roster order; Mira is invited
    expect(summary()).toBe('Nora Berg, Leo Martins and 2 more can create projects.')

    await act(async () => segment('Selected users')?.click())
    expect(summary()).toBe(
      'Nora Berg, Leo Martins and Mira Lind can create projects. Choose people in Users.',
    )
    expect(query('[data-project-creators-summary] .text-text-1')?.textContent).toBe('Nora Berg')
  })

  it('saves the setting, says so, and links to Users under Selected users', async () => {
    await load(undefined)
    const setPage = vi.fn()
    await render(() => <pages.general.OrgGeneralPage setPage={setPage} />)
    expect(segment('Standard users')?.getAttribute('data-state')).toBe('on')
    expect(query('[data-project-creators-users]')).toBeNull()

    await act(async () => segment('Selected users')?.click())
    expect(requests.at(-1)).toMatchObject({
      name: 'orgs:update',
      args: { patch: { project_creators: 'selected' } },
    })
    expect(window.showToast).toHaveBeenCalledWith('Selected users can create projects')

    await act(async () => query<HTMLButtonElement>('[data-project-creators-users]')?.click())
    expect(setPage).toHaveBeenCalledWith('org-users')

    await act(async () => segment('Org admins')?.click())
    expect(window.showToast).toHaveBeenCalledWith('Only org admins can create projects')
  })

  it('keeps keyboard focus when the Users link replaces the page', async () => {
    await load('selected')
    function Screen() {
      const [page, setPage] = useState('org-general')
      return (
        <pages.settings.SettingsScreen
          page={page}
          setPage={setPage}
          onExit={vi.fn()}
          onNewProject={vi.fn()}
          onNewSubProject={vi.fn()}
          onOpenArchive={vi.fn()}
        />
      )
    }
    await render(() => <Screen />)
    const link = query<HTMLButtonElement>('[data-project-creators-users]')
    link?.focus()
    await act(async () => link?.click())
    // the link left with the General page; the Users page's title has focus
    expect(query('[data-project-creators-header]')).not.toBeNull()
    expect(document.activeElement?.tagName).toBe('H1')
    expect(document.activeElement?.textContent).toBe('Users')

    // the rail outlives the page, so a rail item keeps its own focus
    const rail = query<HTMLButtonElement>('[data-settings-item="org-general"]')
    rail?.focus()
    await act(async () => rail?.click())
    expect(summary()).toContain('can create projects.')
    expect(document.activeElement).toBe(rail)
  })
})

describe('Can create projects in Organization > Users', () => {
  const boxes = () =>
    [...container.querySelectorAll<HTMLInputElement>('[data-can-create-projects]')].map(
      (box) => box.dataset.canCreateProjects,
    )

  it('shows no column unless the setting is Selected users', async () => {
    await load('users')
    await render(() => <pages.users.OrgUsersPage setPage={vi.fn()} />)
    expect(query('[data-project-creators-header]')).toBeNull()
    expect(boxes()).toEqual([])
  })

  it('offers the checkbox only to active standard users who are people', async () => {
    await load('selected')
    await render(() => <pages.users.OrgUsersPage setPage={vi.fn()} />)
    expect(query('[data-project-creators-header]')?.textContent).toBe('Can create projects')
    expect(boxes()).toEqual(['leo', 'aisha', 'mira'])
    // every desktop row keeps a cell, so the column lines up
    expect(container.querySelectorAll('[data-project-right-cell]')).toHaveLength(
      snap.profiles.length,
    )
    const leo = query<HTMLInputElement>('[data-can-create-projects="leo"]')
    expect(leo?.checked).toBe(true)
    expect(leo?.getAttribute('aria-label')).toBe('Leo Martins can create projects')
    expect(query<HTMLInputElement>('[data-can-create-projects="aisha"]')?.checked).toBe(false)
  })

  it('saves the right and says so', async () => {
    await load('selected')
    await render(() => <pages.users.OrgUsersPage setPage={vi.fn()} />)
    await act(async () => query<HTMLInputElement>('[data-can-create-projects="aisha"]')?.click())
    expect(requests.at(-1)).toMatchObject({
      name: 'profiles:update',
      args: { id: 'aisha', patch: { can_create_projects: true } },
    })
    expect(window.showToast).toHaveBeenCalledWith('Aisha Rahman can create projects')
    expect(P.user('aisha')?.canCreateProjects).toBe(true)

    await act(async () => query<HTMLInputElement>('[data-can-create-projects="leo"]')?.click())
    expect(window.showToast).toHaveBeenCalledWith('Leo Martins can no longer create projects')
  })

  it('labels the checkbox on the phone user page, which has no column header', async () => {
    await load('selected')
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    await render(() => <pages.users.OrgUsersPage narrow userId="leo" setPage={vi.fn()} />)
    expect(query('[data-project-creators-header]')).toBeNull()
    expect(query('[data-project-right-cell="leo"]')?.textContent).toBe('Can create projects')

    await render(() => <pages.users.OrgUsersPage narrow userId="nora" setPage={vi.fn()} />)
    expect(query('[data-project-right-cell]')).toBeNull()
  })
})

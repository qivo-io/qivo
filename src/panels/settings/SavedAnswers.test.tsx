// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'

/* Create forms and rename toasts wait for the server's answer, on the real
   store. A create keeps the typed name until the server accepts it, and
   keeps it after a refusal; a success toast shows only for a saved change.
   I am the admin of Testbed Labs, with one team and the Luma Sensor
   project. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../../lib/convex', () => ({ convex: network }))
vi.mock('../../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const NOW = '2026-09-14T08:00:00.000Z'

type Pending = { name: string; resolve: (value: unknown) => void; reject: (e: unknown) => void }

let pages: {
  teams: typeof import('./TeamSettings')
  labels: typeof import('./LabelsSettings')
  general: typeof import('./OrganizationSettings')
  project: typeof import('./ProjectSettings')
  modals: typeof import('../Modals')
  detail: typeof import('../IssueDetail')
  version: typeof import('../../store/usePlannerVersion')
}
let requests: Pending[]
let toast: ReturnType<typeof vi.fn<(message: string, tone?: string) => void>>
let container: HTMLDivElement
let root: Root

async function load(crewName = 'Crew') {
  vi.resetModules()
  const snap: Snapshot = plannerFixture()
  const org = snap.orgs[0].id
  snap.teams.push({
    id: 'crew',
    org_id: org,
    name: crewName,
    stale_days: 14,
    archive_days: 30,
    track_delay_default: false,
    created_at: NOW,
  })
  snap.projects.push({
    id: 'sensor',
    org_id: org,
    type: 'meta',
    key: 'SEN',
    num: 2,
    name: 'Luma Sensor',
    description: '',
    sort_order: 1,
    track_delay: true,
    created_at: NOW,
  })
  snap.milestones.push(
    { id: 'beta', project_id: 'sensor', name: 'Beta', week: '2026-10-05', created_at: NOW },
    { id: 'gamma', project_id: 'sensor', name: 'Gamma', week: '2026-11-02', created_at: NOW },
  )
  snap.issues.push({
    id: 'task',
    org_id: org,
    project_id: snap.projects[0].id,
    num: 4,
    title: 'Calibrate the sensor',
    description: '',
    status: 'progress',
    priority: 'medium',
    paused: false,
    created_at: NOW,
    updated_at: NOW,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  requests = []
  network.query.mockResolvedValue(null)
  network.onUpdate.mockImplementation((_ref, _args, next) => {
    next(structuredClone(snap))
    return () => {}
  })
  network.mutation.mockImplementation((ref) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    return new Promise((resolve, reject) => requests.push({ name, resolve, reject }))
  })
  const store = await import('../../store/planner')
  await store.initStore()
  pages = {
    teams: await import('./TeamSettings'),
    labels: await import('./LabelsSettings'),
    general: await import('./OrganizationSettings'),
    project: await import('./ProjectSettings'),
    modals: await import('../Modals'),
    detail: await import('../IssueDetail'),
    version: await import('../../store/usePlannerVersion'),
  }
}

beforeEach(async () => {
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
  toast = vi.fn<(message: string, tone?: string) => void>()
  window.showToast = toast
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await load()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
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

const input = (selector: string) => document.querySelector<HTMLInputElement>(selector)
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  )

/* Types into a React-controlled input. */
async function type(field: HTMLInputElement | null, value: string) {
  if (!field) throw new Error('no such field')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function answer(name: string, outcome: 'accept' | 'refuse') {
  const request = requests.find((r) => r.name === name)
  if (!request) throw new Error(`${name} was not sent`)
  await act(async () => {
    if (outcome === 'accept') request.resolve(null)
    else request.reject(new ConvexError({ code: 'rule', message: 'the server said no' }))
  })
}

const toasts = () => toast.mock.calls.map(([message]) => message)

describe('a team saved with a blank name', () => {
  it('opens from the list by a label of its own', async () => {
    await load('  ')
    const setPage = vi.fn()
    await render(() => <pages.teams.OrgTeamsPage setPage={setPage} />)
    await act(async () => button('Unnamed team')?.click())
    expect(setPage).toHaveBeenCalledWith('team:crew')
  })
})

describe('create forms', () => {
  it('keeps a new team name until the server creates the team', async () => {
    await render(() => <pages.teams.OrgTeamsPage setPage={vi.fn()} />)
    const field = input('input[placeholder="New team name"]')
    await type(field, 'Field crew')
    await act(async () => button('Add team')?.click())
    expect(requests.map((r) => r.name)).toEqual(['teams:create'])
    expect(field?.value).toBe('Field crew')
    expect(button('Add team')?.disabled).toBe(true)
    expect(toasts()).toEqual([])
    await answer('teams:create', 'accept')
    expect(field?.value).toBe('')
    expect(toasts()).toEqual(['Team “Field crew” created'])
  })

  it('keeps a refused team name for another try', async () => {
    await render(() => <pages.teams.OrgTeamsPage setPage={vi.fn()} />)
    const field = input('input[placeholder="New team name"]')
    await type(field, 'Field crew')
    await act(async () => button('Add team')?.click())
    await answer('teams:create', 'refuse')
    expect(field?.value).toBe('Field crew')
    expect(button('Add team')?.disabled).toBe(false)
    expect(toasts()).toEqual(['The server said no. Change reverted.'])
    // the painted team left with the refusal
    expect(document.querySelector('[data-org-teams]')?.textContent).not.toContain('Field crew')
  })

  it('keeps a new label name until the server creates the label', async () => {
    await render(() => <pages.labels.OrgLabelsPage />)
    const field = input('input[placeholder="New label name"]')
    await type(field, 'Firmware')
    await act(async () => button('Add label')?.click())
    expect(field?.value).toBe('Firmware')
    expect(toasts()).toEqual([])
    await answer('labels:create', 'refuse')
    expect(field?.value).toBe('Firmware')
    await act(async () => button('Add label')?.click())
    await act(async () => requests.at(-1)?.resolve(null))
    expect(field?.value).toBe('')
    expect(toasts()).toEqual(['The server said no. Change reverted.', 'Label “Firmware” created'])
  })

  it('keeps a new milestone name until the server creates the milestone', async () => {
    await render(() => (
      <pages.modals.MilestoneModal init={{ project: 'sensor' }} onClose={vi.fn()} />
    ))
    const field = input('[data-milestone-new]')
    await type(field, 'Launch')
    await act(async () => button('Add')?.click())
    expect(requests.map((r) => r.name)).toEqual(['projects:addMilestone'])
    expect(field?.value).toBe('Launch')
    expect(button('Add')?.disabled).toBe(true)
    await answer('projects:addMilestone', 'refuse')
    expect(field?.value).toBe('Launch')
    expect(toasts()).toEqual(['The server said no. Change reverted.'])
    await act(async () => button('Add')?.click())
    await act(async () => requests.at(-1)?.resolve(null))
    expect(field?.value).toBe('')
    expect(toasts().at(-1)).toBe('Milestone “Launch” added')
  })
})

describe('the label picker in the task window', () => {
  it('creates a label at once and puts a refused name back', async () => {
    const { P } = await import('../../store/planner')
    const task = P.issues.find((t) => t.title === 'Calibrate the sensor')
    if (!task) throw new Error('no task')
    await render(() => (
      <pages.detail.LabelPickerPopup it={task} anchor={{ x: 0, y: 0 }} onDone={vi.fn()} />
    ))
    const field = input('input[placeholder="Add labels…"]')
    await type(field, 'Firmware')
    await act(async () =>
      field?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    )
    expect(requests.map((r) => r.name)).toEqual(['labels:create', 'labels:toggle'])
    expect(field?.value).toBe('')
    await answer('labels:create', 'refuse')
    expect(field?.value).toBe('Firmware')
  })
})

describe('the milestone editor', () => {
  it('leaves another editor open when an earlier save is answered', async () => {
    await render(() => <pages.modals.MilestoneModal init={{ id: 'beta' }} onClose={vi.fn()} />)
    await type(input('[data-milestone-editor] input[aria-label="Name"]'), 'Beta 2')
    await act(async () => button('Save')?.click())
    expect(input('[data-milestone-editor] input[aria-label="Name"]')?.readOnly).toBe(true)
    const edit = document.querySelector<HTMLButtonElement>('button[aria-label="Edit Gamma"]')
    await act(async () => edit?.click())
    await answer('projects:updateMilestone', 'accept')
    expect(document.querySelector('[data-milestone-editor="gamma"]')).not.toBeNull()
  })
})

describe('rename toasts', () => {
  async function rename(field: HTMLInputElement | null, value: string) {
    await act(async () => field?.focus())
    await type(field, value)
    await act(async () => field?.blur())
  }

  it('says a team was renamed only once the server saved it', async () => {
    await render(() => <pages.teams.TeamPage teamId="crew" setPage={vi.fn()} />)
    await rename(input('input[aria-label="Team name"]'), 'Bench crew')
    expect(requests.map((r) => r.name)).toEqual(['teams:update'])
    expect(toasts()).toEqual([])
    await answer('teams:update', 'accept')
    expect(toasts()).toEqual(['Team renamed'])
  })

  it('says nothing of a renamed organization the server refused', async () => {
    await render(() => <pages.general.OrgGeneralPage setPage={vi.fn()} />)
    const field = input('[data-org-name]')
    await rename(field, 'Northstar Labs')
    expect(toasts()).toEqual([])
    await answer('orgs:update', 'refuse')
    expect(toasts()).toEqual(['The server said no. Change reverted.'])
    expect(field?.value).toBe('Testbed Labs')
  })

  it('says a project setting changed only once the server saved it', async () => {
    await render(() => <pages.project.ProjectPage projectId="sensor" setPage={vi.fn()} />)
    const field = input('[data-project-review-hours]')
    await act(async () => field?.focus())
    await type(field, '3')
    await act(async () => field?.blur())
    expect(requests.map((r) => r.name)).toEqual(['projects:update'])
    expect(toasts()).toEqual([])
    await answer('projects:update', 'accept')
    expect(toasts()).toEqual(['Review time set to 3 h'])
  })

  it('keeps a milestone editor open until the server saved the rename', async () => {
    const onClose = vi.fn()
    await render(() => <pages.modals.MilestoneModal init={{ id: 'beta' }} onClose={onClose} />)
    const field = input('[data-milestone-editor] input[aria-label="Name"]')
    await type(field, 'Beta 2')
    await act(async () => button('Save')?.click())
    expect(input('[data-milestone-editor]')).not.toBeNull()
    expect(toasts()).toEqual([])
    await answer('projects:updateMilestone', 'refuse')
    // the refusal keeps the editor open with the draft
    expect(field?.value).toBe('Beta 2')
    await act(async () => button('Save')?.click())
    await act(async () => requests.at(-1)?.resolve(null))
    expect(input('[data-milestone-editor]')).toBeNull()
    expect(toasts().at(-1)).toBe('Milestone updated')
  })
})

// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The New project and New sub-project dialogs on the real store, fed one
   snapshot: Aisha (me) and Leo are standard users, Nora is an org admin, Leo
   is in the Crew team and Aisha is not, and Aisha leads Luma Sensor. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

type Planner = typeof import('../store/planner')['P']
type Modals = typeof import('./Modals')
type Profile = Snapshot['profiles'][number]

const NOW = '2026-09-14T08:00:00.000Z'

let P: Planner
let dialogs: Modals
let snap: Snapshot
let container: HTMLDivElement
let root: Root

function fixture(myRole: Profile['org_role']) {
  const next = plannerFixture()
  const org = next.orgs[0].id
  const me = next.profiles[0]
  Object.assign(me, { id: 'aisha', name: 'Aisha Rahman', org_role: myRole })
  next.myProfileIds = ['aisha']
  const person = (id: string, name: string, org_role: Profile['org_role']): Profile => ({
    ...me,
    id,
    name,
    org_role,
    auth_user_id: `account-${id}`,
  })
  next.profiles.push(person('leo', 'Leo Martins', 'user'), person('nora', 'Nora Berg', 'admin'))
  next.teams.push({
    id: 'crew',
    org_id: org,
    name: 'Crew',
    stale_days: 14,
    archive_days: 30,
    track_delay_default: false,
    created_at: NOW,
  })
  next.teamMembers.push({ team_id: 'crew', profile_id: 'leo', is_leader: false })
  next.projects.push({
    id: 'sensor',
    org_id: org,
    type: 'meta',
    key: 'SEN',
    num: 2,
    name: 'Luma Sensor',
    lead_id: 'aisha',
    description: '',
    sort_order: 1,
    track_delay: true,
    created_at: NOW,
  })
  return next
}

async function load(myRole: Profile['org_role']) {
  vi.resetModules()
  snap = fixture(myRole)
  network.query.mockResolvedValue(null)
  network.onUpdate.mockImplementation((_ref, _args, next) => {
    next(structuredClone(snap))
    return () => {}
  })
  network.mutation.mockImplementation((ref) => {
    if (getFunctionName(ref) === 'identity:claimMySeats') return Promise.resolve(null)
    return new Promise(() => {})
  })
  const store = await import('../store/planner')
  P = store.P
  await store.initStore()
  dialogs = await import('./Modals')
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  // Radix measures its popover anchor
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
  vi.unstubAllGlobals()
})

async function render(node: React.ReactNode) {
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
}

function find<T extends Element>(selector: string) {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}

async function pickLead(id: string) {
  const select = find<HTMLSelectElement>('select[aria-label="Lead"]')
  await act(async () => {
    select.value = id
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function click(selector: string) {
  const element = find<HTMLElement>(selector)
  await act(async () => element.click())
}

const note = () => document.querySelector('[data-footer-note]')
const accessField = () => find('[data-new-project-access]').textContent

describe('New project for a standard user', () => {
  beforeEach(() => load('user'))

  it('adds the creator to access when someone else leads, and names the lead', async () => {
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    expect(note()).toBeNull()
    expect(accessField()).toBe('Select teams and users…')
    // the live region is there before the note, so the note is announced
    const status = find('[role="status"]')
    expect(status.textContent).toBe('')

    await pickLead('leo')
    expect(accessField()).toBe('Aisha Rahman (you)')
    expect(note()?.getAttribute('data-footer-note')).toBe('muted')
    expect(note()?.textContent).toBe('Only Leo Martins and org admins can manage it.')
    expect(note()?.closest('[role="status"]')).toBe(status)

    await click('[data-new-project-access]')
    const checkbox = find('[data-project-access-user-option="aisha"]')
    expect(checkbox.getAttribute('aria-label')).toBe('Aisha Rahman (you)')
    expect(checkbox.closest('div')?.textContent).toContain('Aisha Rahman (you)')
  })

  it('names the creator first beside other shares', async () => {
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    await pickLead('leo')
    await click('[data-new-project-access]')
    await click('[data-project-access-team-option="crew"]')
    expect(accessField()).toBe('You, 1 team')
  })

  it('shows only the no-access line once the creator removes their entry', async () => {
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    await pickLead('leo')
    await click('[data-new-project-access]')
    await click('[data-project-access-user-option="aisha"]')

    expect(document.querySelectorAll('[data-footer-note]')).toHaveLength(1)
    expect(note()?.getAttribute('data-footer-note')).toBe('warn')
    expect(note()?.textContent).toBe("You won't see this project.")
  })

  it('counts a team share only when the creator is in the team', async () => {
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    await pickLead('leo')
    await click('[data-new-project-access]')
    await click('[data-project-access-user-option="aisha"]')
    await click('[data-project-access-team-option="crew"]')
    expect(note()?.textContent).toBe("You won't see this project.")
  })

  it('drops the note and the automatic entry when the creator leads again', async () => {
    const onCreate = vi.fn()
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={onCreate} />)
    await pickLead('leo')
    await pickLead('aisha')
    expect(note()).toBeNull()
    expect(accessField()).toBe('Select teams and users…')

    await pickLead('leo')
    const name = find<HTMLInputElement>('input[aria-label="Name"]')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'Mount')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submit = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Create project',
    )
    await act(async () => submit?.click())
    // the automatic entry is the server's own rule, so the dialog sends none
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ lead: 'leo', access: {}, teamAccess: {} }),
      { withStarter: false },
    )
  })

  it('sends a removed entry as null, so the server adds no grant', async () => {
    const onCreate = vi.fn()
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={onCreate} />)
    await pickLead('leo')
    await click('[data-new-project-access]')
    await click('[data-project-access-user-option="aisha"]')
    const name = find<HTMLInputElement>('input[aria-label="Name"]')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'Mount')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submit = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Create project',
    )
    await act(async () => submit?.click())
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ lead: 'leo', access: { aisha: null } }),
      { withStarter: false },
    )
  })
})

describe('New project for an org admin', () => {
  beforeEach(() => load('admin'))

  it('shows no note and adds no entry for another lead', async () => {
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    await pickLead('leo')
    expect(note()).toBeNull()
    expect(accessField()).toBe('Select teams and users…')
  })
})

describe('New sub-project', () => {
  it('names the lead to a standard user only when someone else leads', async () => {
    await load('user')
    await render(
      <dialogs.NewSubProjectModal
        init={{ parent: 'sensor' }}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    )
    expect(note()).toBeNull()
    await pickLead('leo')
    expect(note()?.getAttribute('data-footer-note')).toBe('muted')
    expect(note()?.textContent).toBe('Only Leo Martins and org admins can manage it.')
    await pickLead('aisha')
    expect(note()).toBeNull()
  })

  it('shows an org admin no note', async () => {
    await load('admin')
    await render(
      <dialogs.NewSubProjectModal
        init={{ parent: 'sensor' }}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    )
    await pickLead('leo')
    expect(note()).toBeNull()
    expect(P.isAdmin()).toBe(true)
  })
})

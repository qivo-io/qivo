// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../convex/lib/limits'
import { TooltipProvider } from '../components/ui/tooltip'
import { endClosing, playClosingAnimations } from '../lib/closingAnimation.setup'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import {
  type ForcedProjectLists,
  isProjectListRead,
  projectListsServer,
} from '../store/projectSettingsListsStandIn.setup'
import {
  type ForcedProjectSettings,
  isProjectSettingsRead,
  projectSettingsServer,
} from '../store/projectSettingsStandIn.setup'

/* The New project and New sub-project dialogs on the real store, their
   reads answered by the project settings stand-ins
   (store/projectSettingsStandIn.setup.ts and
   projectSettingsListsStandIn.setup.ts) over a workspace the test holds as
   the server's. The store holds its own copy, which a test can make differ
   from the server's, so a dialog that read the workspace instead of the
   server shows up.

   Testbed Labs: Aisha (me) and Leo are standard users, Nora is an org
   admin and Vic an org Viewer; Leo is in the Crew team and Aisha is not.
   Aisha leads Luma Sensor, with its sub-project Firmware, and two
   projects named Test; Leo leads Beam, on which Aisha has User; Old rig,
   Aisha's, is archived. In Beacon, another organization, Aisha holds a
   guest seat that leads Beacon plan, beside Bea, Beacon's admin. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('../store/guard/liveDouble.setup')).liveOver(network),
}))
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
type Project = Snapshot['projects'][number]

const NOW = '2026-09-14T08:00:00.000Z'

let P: Planner
let dialogs: Modals
let caps: typeof import('../lib/accessCaps')['ACCESS_CAPS']
let container: HTMLDivElement
let root: Root
let home: string
let beacon: string
/* What the server holds, the states it is asked to force and its reads. */
let server: {
  snap: Snapshot
  force: ForcedProjectSettings
  listForce: ForcedProjectLists
  reads: ReturnType<typeof projectSettingsServer>
  lists: ReturnType<typeof projectListsServer>
}
/* Every one-shot read the dialogs asked for, by name and arguments. */
let asked: { name: string; args: Record<string, unknown> }[]

function fixture(myRole: Profile['org_role']): Snapshot {
  const next = plannerFixture()
  home = next.orgs[0].id
  beacon = crypto.randomUUID()
  next.orgs.push({ ...next.orgs[0], id: beacon, name: 'Beacon', slug: 'beacon' })
  const me = next.profiles[0]
  Object.assign(me, { id: 'aisha', name: 'Aisha Rahman', org_role: myRole })
  next.myProfileIds = ['aisha', 'aisha-b']
  const person = (
    id: string,
    name: string,
    org_role: Profile['org_role'],
    org_id = home,
  ): Profile => ({ ...me, id, name, org_role, org_id, auth_user_id: `account-${id}` })
  next.profiles.push(
    person('leo', 'Leo Martins', 'user'),
    person('nora', 'Nora Berg', 'admin'),
    person('vic', 'Vic Viewer', 'viewer'),
    { ...person('aisha-b', 'Aisha Rahman', 'guest', beacon), auth_user_id: 'test-account' },
    person('bea', 'Bea Lund', 'admin', beacon),
  )
  next.teams.push({
    id: 'crew',
    org_id: home,
    name: 'Crew',
    track_delay_default: false,
    created_at: NOW,
  })
  next.teamMembers.push({ team_id: 'crew', profile_id: 'leo', is_leader: false })
  const project = (id: string, name: string, num: number, extra: Partial<Project> = {}) => ({
    id,
    org_id: home,
    type: 'meta' as const,
    key: id.slice(0, 4).toUpperCase(),
    num,
    name,
    lead_id: 'aisha',
    description: '',
    sort_order: num,
    track_delay: true,
    created_at: NOW,
    ...extra,
  })
  next.projects = [
    project('sensor', 'Luma Sensor', 2),
    project('beam', 'Beam', 3, { lead_id: 'leo' }),
    project('fw', 'Firmware', 4, { type: 'project', parent_id: 'sensor', lead_id: undefined }),
    project('old', 'Old rig', 5, { archived_at: NOW }),
    project('test-a', 'Test', 7),
    project('test-b', 'Test', 9),
    project('beacon-plan', 'Beacon plan', 1, { org_id: beacon, lead_id: 'aisha-b' }),
  ]
  next.access = [{ project_id: 'beam', profile_id: 'aisha', level: 'user' }]
  return next
}

/** Loads the store from the fixture with `myRole`, which `shape` changes
    first; `held` changes the store's own copy after that, so it differs
    from the server's. */
async function load(
  myRole: Profile['org_role'],
  shape?: (snap: Snapshot) => void,
  held?: (snap: Snapshot) => void,
) {
  vi.resetModules()
  const snap = fixture(myRole)
  shape?.(snap)
  asked = []
  server = {
    snap,
    force: {},
    listForce: {},
    reads: projectSettingsServer(
      () => server.snap,
      () => server.force,
    ),
    lists: projectListsServer(
      () => server.snap,
      () => server.listForce,
    ),
  }
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (isProjectSettingsRead(name)) return server.reads.watch(name, args, next, fail)
    if (name === 'workspace:whole') {
      const copy = structuredClone(server.snap)
      held?.(copy)
      next(copy)
    }
    return () => {}
  })
  network.query.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    asked.push({ name, args })
    if (isProjectSettingsRead(name)) return server.reads.query(name, args)
    if (isProjectListRead(name)) return server.lists.query(name, args)
    return null
  })
  network.mutation.mockImplementation((ref) => {
    if (getFunctionName(ref) === 'identity:claimMySeats') return Promise.resolve(null)
    return new Promise(() => {})
  })
  const store = await import('../store/planner')
  P = store.P
  await store.initStore()
  dialogs = await import('./Modals')
  caps = (await import('../lib/accessCaps')).ACCESS_CAPS
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
  Reflect.deleteProperty(document, 'visibilityState')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render(node: React.ReactNode) {
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
  await settle()
}

/** Lets the dialogs take every answer on their way. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}
/** Waits out the search delay (250 ms) and the reads it sends. */
const rest = async () => {
  await act(async () => await new Promise((r) => setTimeout(r, 300)))
  await settle()
}
/** Answers every open read again from the server's workspace. */
const rerun = async () => {
  await act(async () => server.reads.rerun())
  await settle()
}

function find<T extends Element>(selector: string) {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}
const has = (selector: string) => document.querySelector(selector) !== null
const all = (selector: string) => [...document.querySelectorAll(selector)]

async function click(target: string | HTMLElement) {
  const element = typeof target === 'string' ? find<HTMLElement>(target) : target
  await act(async () => element.click())
  await settle()
}

/* Types `value` into `input` as one change, the way a paste lands. */
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function button(label: string) {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`Missing button ${label}`)
  return found
}

/** Presses Escape on `element`, focused, as a keyboard does. */
async function pressEscape(element: HTMLElement) {
  await act(async () => {
    element.focus()
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
  })
  await settle()
}

/** The one-shot reads the dialogs asked for named `name`, by arguments. */
const askedFor = (name: string) => asked.filter((a) => a.name === name).map((a) => a.args)

const note = () => document.querySelector('[data-footer-note]')
const accessField = () => find('[data-new-project-access]').textContent
const nameField = () => find<HTMLInputElement>('input[aria-label="Name"]')

/** Picks `id` as lead through the Lead popover. */
async function pickLead(id: string) {
  await click('[data-project-lead-picker]')
  await click(`[data-lead-choice="${id}"]`)
}

/** The teams and users the access popover lists from the server, by id. */
const listed = () =>
  all('[data-project-access-team-option], [data-project-access-user-option]').map(
    (option) =>
      option.getAttribute('data-project-access-team-option') ??
      option.getAttribute('data-project-access-user-option'),
  )
const accessSearch = () => find<HTMLInputElement>('[data-project-access-search]')
const popupText = () => find('[data-new-project-access-popup]').textContent ?? ''
/** Whether the open popover is modal. A modal Radix popover hides the
    dialog behind it from screen readers and keeps wheel and touch
    scrolling inside itself, which a list over a modal dialog needs, since
    the dialog's scroll lock cancels those events everywhere else. */
const popoverIsModal = () => find('[data-modal-shell]').closest('[aria-hidden="true"]') !== null

describe('New project for a standard user', () => {
  beforeEach(() => load('user'))

  it('adds the creator to access when someone else leads, and names the lead', async () => {
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    expect(note()).toBeNull()
    expect(accessField()).toBe('Select teams and users…')
    expect(find('[data-project-lead-picker]').getAttribute('aria-label')).toBe('Lead: Aisha Rahman')
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
    expect(checkbox.getAttribute('data-state')).toBe('checked')
    expect(checkbox.closest('div')?.textContent).toContain('Aisha Rahman (you)')
  })

  it('keeps a pasted name and description over their caps, marks them and holds Create', async () => {
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    const name = nameField()
    const description = find<HTMLInputElement>('input[aria-label="Description"]')
    await type(name, 'n'.repeat(81))
    await type(description, 'd'.repeat(501))
    expect(name.value).toHaveLength(81)
    expect(description.value).toHaveLength(501)
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(description.getAttribute('aria-invalid')).toBe('true')
    const counts = [...document.querySelectorAll('[data-limit-count]')].map((c) => c.textContent)
    expect(counts).toEqual([
      '81/80 A project name must be at most 80 characters. Shorten it.',
      '501/500 A project description must be at most 500 characters. Shorten it.',
    ])
    expect(button('Create project').disabled).toBe(true)
    await type(name, 'n'.repeat(80))
    await type(description, 'd'.repeat(500))
    expect(name.getAttribute('aria-invalid')).toBeNull()
    expect(document.querySelector('[data-limit-count]')?.getAttribute('data-limit-count')).toBe(
      'near',
    )
    expect(button('Create project').disabled).toBe(false)
  })

  it('shows no count far from the cap and holds Create for a new organization over it', async () => {
    await render(<dialogs.CreateOrgModal onClose={vi.fn()} />)
    const name = find<HTMLInputElement>('input[aria-label="Organization name"]')
    await type(name, 'n'.repeat(71))
    expect(document.querySelector('[data-limit-count]')).toBeNull()
    await type(name, 'n'.repeat(72))
    expect(document.querySelector('[data-limit-count]')?.textContent).toBe('72/80')
    await type(name, 'n'.repeat(81))
    expect(name.maxLength).toBe(-1)
    expect(button('Create').disabled).toBe(true)
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
    await type(nameField(), 'Mount')
    await click(button('Create project'))
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
    await type(nameField(), 'Mount')
    await click(button('Create project'))
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

describe("New project's Lead", () => {
  it('reads nothing until it opens, then the organization’s people from the server, not the roster', async () => {
    // Sam joined on the server, and the store does not hold him yet
    await load(
      'user',
      (snap) => snap.profiles.push({ ...snap.profiles[1], id: 'sam', name: 'Sam Ode' }),
      (copy) => {
        copy.profiles = copy.profiles.filter((p) => p.id !== 'sam')
      },
    )
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    expect(askedFor('projectSettings:leadCandidates')).toEqual([])
    await click('[data-project-lead-picker]')
    expect(askedFor('projectSettings:leadCandidates')).toEqual([{ org_id: home }])
    // the server's admins and users in name order, Vic the Viewer left out
    expect(all('[data-lead-choice]').map((c) => c.getAttribute('data-lead-choice'))).toEqual([
      'aisha',
      'leo',
      'nora',
      'sam',
    ])
    await click('[data-lead-choice="sam"]')
    expect(find('[data-project-lead-picker]').getAttribute('aria-label')).toBe('Lead: Sam Ode')
  })

  it('opens modal, so its list scrolls inside the dialog', async () => {
    await load('user')
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    expect(popoverIsModal()).toBe(false)
    await click('[data-project-lead-picker]')
    expect(has('[data-lead-choices]')).toBe(true)
    expect(popoverIsModal()).toBe(true)
  })

  it('keeps the creator and says why when the server refuses or is not ready', async () => {
    await load('user')
    server.force = { refused: true }
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    await type(nameField(), 'Mount')
    await click('[data-project-lead-picker]')
    expect(find('[data-lead-choices]').textContent).toContain(
      'Only org admins and standard users can create projects.',
    )
    expect(has('[data-lead-choice]')).toBe(false)
    expect(find('[data-project-lead-picker]').getAttribute('aria-label')).toBe('Lead: Aisha Rahman')
    // Create keeps its state, as the create checks the lead again
    expect(button('Create project').disabled).toBe(false)
  })
})

describe("New project's Project access", () => {
  beforeEach(async () => {
    await load('user')
    playClosingAnimations()
  })

  it('reads nothing while closed, then the server’s teams and people with the lead left out and admins offered', async () => {
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    expect(askedFor('projectSettings:candidates')).toEqual([])
    await click('[data-new-project-access]')
    expect(askedFor('projectSettings:candidates')).toEqual([{ org_id: home, lead_id: 'aisha' }])
    // teams first, then people in the server's order; Aisha leads, and
    // Nora, an org admin, is offered like anyone else
    expect(listed()).toEqual(['crew', 'leo', 'nora', 'vic'])
    expect(find('[data-project-access-teams] legend').textContent).toBe('Teams')
    expect(find('[data-project-access-users] legend').textContent).toBe('Users')
    await click('[data-project-access-user-option="nora"]')
    expect(accessField()).toBe('Nora Berg')
    // an org Viewer is offered as Viewer only
    await click('[data-project-access-user-option="vic"]')
    const vic = find<HTMLSelectElement>('[data-project-role="vic"]')
    expect(vic.value).toBe('viewer')
    expect(vic.disabled).toBe(true)
    expect([...vic.options].map((o) => o.value)).toEqual(['viewer'])
    expect(find('[data-project-access-user-option="vic"]').closest('div')?.textContent).toContain(
      'viewer',
    )
    expect(accessField()).toBe('2 users')
  })

  it('reads again for a new lead, whom the server leaves out', async () => {
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    await pickLead('leo')
    await click('[data-new-project-access]')
    expect(askedFor('projectSettings:candidates')).toEqual([{ org_id: home, lead_id: 'leo' }])
    expect(listed()).toEqual(['crew', 'aisha', 'nora', 'vic'])
  })

  it('keeps its search while it closes, and starts empty when it opens again', async () => {
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    await click('[data-new-project-access]')
    expect(listed()).toEqual(['crew', 'leo', 'nora', 'vic'])
    await type(accessSearch(), 'Leo')
    await rest()
    expect(listed()).toEqual(['leo'])
    expect(askedFor('projectSettings:candidates').at(-1)).toEqual({
      org_id: home,
      lead_id: 'aisha',
      search: 'Leo',
    })
    const reads = asked.length
    await click('[data-new-project-access]')
    expect(find('[data-new-project-access-popup]').getAttribute('data-state')).toBe('closed')
    expect(accessSearch().value).toBe('Leo')
    expect(listed()).toEqual(['leo'])
    await endClosing()
    expect(document.querySelector('[data-new-project-access-popup]')).toBeNull()
    // a closed popover reads nothing
    await rest()
    expect(asked.length).toBe(reads)
    await click('[data-new-project-access]')
    expect(accessSearch().value).toBe('')
    expect(listed()).toEqual(['crew', 'leo', 'nora', 'vic'])
  })

  it('keeps a checked choice named and checked through a search, Load more and a close, and sends it', async () => {
    server.force = { batch: 2 }
    const onCreate = vi.fn()
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={onCreate} />)
    await click('[data-new-project-access]')
    expect(listed()).toEqual(['crew', 'leo'])
    await type(accessSearch(), 'nora')
    await rest()
    await click('[data-project-access-user-option="nora"]')
    const role = find<HTMLSelectElement>('[data-project-role="nora"]')
    await act(async () => {
      role.value = 'viewer'
      role.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // a search that hides her row keeps her checked, named and at Viewer
    await type(accessSearch(), 'crew')
    await rest()
    expect(listed()).toEqual(['crew'])
    expect(accessField()).toBe('Nora Berg')
    await type(accessSearch(), '')
    await rest()
    // Selected lists her before the server's rows while the search is empty
    const chosen = find('[data-project-access-selected]')
    expect(chosen.textContent).toContain('Nora Berg')
    expect(
      find('[data-project-access-selected-option="user:nora"]').getAttribute('data-state'),
    ).toBe('checked')
    expect(find<HTMLSelectElement>('[data-project-access-selected-role="user:nora"]').value).toBe(
      'viewer',
    )
    // Load more goes on past the first batch
    await click('[data-new-project-access-more]')
    expect(listed()).toEqual(['crew', 'leo', 'nora', 'vic'])
    expect(find('[data-project-access-user-option="nora"]').getAttribute('data-state')).toBe(
      'checked',
    )
    await click('[data-new-project-access]')
    await endClosing()
    expect(accessField()).toBe('Nora Berg')
    await type(nameField(), 'Mount')
    await click(button('Create project'))
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ lead: 'aisha', access: { nora: 'viewer' }, teamAccess: {} }),
      { withStarter: false },
    )
  })

  it('takes Selected as it opens and as the search changes, never on a check, with checkboxes of its own', async () => {
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    await click('[data-new-project-access]')
    expect(has('[data-project-access-selected]')).toBe(false)
    await click('[data-project-access-team-option="crew"]')
    await click('[data-project-access-user-option="leo"]')
    // checking adds no row above the pointer
    expect(has('[data-project-access-selected]')).toBe(false)
    await type(accessSearch(), 'x')
    expect(has('[data-project-access-selected]')).toBe(false)
    await type(accessSearch(), '')
    expect(
      all('[data-project-access-selected-option]').map((b) =>
        b.getAttribute('data-project-access-selected-option'),
      ),
    ).toEqual(['team:crew', 'user:leo'])
    // each role select is marked as its checkbox is, as a team's id can
    // equal a person's
    expect(
      all('[data-project-access-selected-role]').map((select) =>
        select.getAttribute('data-project-access-selected-role'),
      ),
    ).toEqual(['team:crew', 'user:leo'])
    // unchecking in Selected keeps the row until Selected is taken again
    await click('[data-project-access-selected-option="user:leo"]')
    expect(has('[data-project-access-selected-option="user:leo"]')).toBe(true)
    expect(find('[data-project-access-user-option="leo"]').getAttribute('data-state')).toBe(
      'unchecked',
    )
    expect(accessField()).toBe('Crew')
    await click('[data-new-project-access]')
    await endClosing()
    await click('[data-new-project-access]')
    expect(
      all('[data-project-access-selected-option]').map((b) =>
        b.getAttribute('data-project-access-selected-option'),
      ),
    ).toEqual(['team:crew'])
  })

  it('says a group is empty only once the list has passed into the next group or ended', async () => {
    server.force = { batch: 1 }
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    await click('[data-new-project-access]')
    // a batch of the team alone: no word on the people yet
    expect(listed()).toEqual(['crew'])
    expect(has('[data-picker-group-none]')).toBe(false)
    expect(has('[data-project-access-users]')).toBe(false)
    server.force = {}
    await type(accessSearch(), 'nora')
    await rest()
    expect(listed()).toEqual(['nora'])
    expect(find('[data-picker-group-none="team"]').textContent).toBe('No teams match.')
    await type(accessSearch(), 'crew')
    await rest()
    expect(find('[data-picker-group-none="user"]').textContent).toBe('No one matches.')
  })

  it.each<[string, ForcedProjectSettings, string]>([
    ['a refusal', { refused: true }, 'Only org admins and standard users can create projects.'],
    ['not ready', { notReady: true }, "Teams and people can't be listed yet."],
    ['a failure', { fail: ['candidates'] }, "Couldn't load teams and people."],
  ])('says so for %s, and never that nothing is there', async (_, force, line) => {
    server.force = force
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    await click('[data-new-project-access]')
    expect(popupText()).toContain(line)
    expect(popupText()).not.toContain('No teams or people to add.')
    expect(popupText()).not.toContain('Nothing matches.')
    expect(listed()).toEqual([])
  })

  it('tries a failed read again', async () => {
    server.force = { fail: ['candidates'] }
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    await click('[data-new-project-access]')
    server.force = {}
    await click(button('Try again'))
    expect(listed()).toEqual(['crew', 'leo', 'nora', 'vic'])
  })

  it('shows a stopped batch with Load more, the cap and a search past its limit', async () => {
    // each read stops after two looked at, Aisha, the lead, among them
    server.force = { stop: 2 }
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    await click('[data-new-project-access]')
    expect(listed()).toEqual(['crew'])
    expect(popupText()).toContain('Showing the teams and people found so far.')
    expect(has('[data-new-project-access-more]')).toBe(true)
    expect(popupText()).not.toContain('No one to add.')
    // Load more keeps focus while it reads, then gives it to the first new row
    const more = find<HTMLElement>('[data-new-project-access-more]')
    await act(async () => more.focus())
    await click(more)
    expect(listed()).toEqual(['crew', 'leo', 'nora'])
    expect(document.activeElement).toBe(find('[data-project-access-user-option="leo"]'))
    await click('[data-new-project-access]')
    await endClosing()
    // the cap, lowered to two choices
    const was = caps.choices
    caps.choices = 2
    try {
      server.force = { batch: 2 }
      await click('[data-new-project-access]')
      expect(listed()).toEqual(['crew', 'leo'])
      expect(popupText()).toContain('Search to narrow the list.')
      expect(has('[data-new-project-access-more]')).toBe(false)
    } finally {
      caps.choices = was
    }
    await type(accessSearch(), 'x'.repeat(LIMITS.search.max + 1))
    expect(popupText()).toContain(String(LIMITS.search.max))
  })

  it('clears a typed search on Escape first, then closes the popover alone', async () => {
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    await click('[data-new-project-access]')
    await type(accessSearch(), 'Leo')
    await pressEscape(accessSearch())
    expect(accessSearch().value).toBe('')
    expect(find('[data-new-project-access-popup]').getAttribute('data-state')).toBe('open')
    await pressEscape(accessSearch())
    expect(find('[data-new-project-access-popup]').getAttribute('data-state')).toBe('closed')
    expect(has('[data-modal-shell]')).toBe(true)
  })
})

describe("New project's Project access at its end", () => {
  it('says the list is empty at its real end with no row', async () => {
    await load('user', (snap) => {
      snap.teams = []
      snap.profiles = snap.profiles.filter((p) => p.id === 'aisha' || p.org_id !== home)
    })
    await render(<dialogs.NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />)
    await click('[data-new-project-access]')
    expect(popupText()).toContain('No teams or people to add.')
    await type(accessSearch(), 'zz')
    await rest()
    expect(popupText()).toContain('Nothing matches.')
  })
})

/* ------------------------------------------------------- New sub-project */

/** Renders New sub-project on `parent`, with `onCreate`. */
async function openSub(parent: string, onCreate = vi.fn()) {
  await render(
    <dialogs.NewSubProjectModal init={{ parent }} onClose={vi.fn()} onCreate={onCreate} />,
  )
  return onCreate
}
const parentButton = () => find<HTMLButtonElement>('[data-new-subproject-parent]')
const parentNote = () => document.querySelector('[data-new-subproject-parent-note]')?.textContent
const create = () => button('Create sub-project')
const parentRows = () =>
  all('[data-new-subproject-parent-choice]').map((row) => row.textContent?.trim())

describe('New sub-project', () => {
  it('names the lead to a standard user only when someone else leads', async () => {
    await load('user')
    await openSub('sensor')
    expect(note()).toBeNull()
    await pickLead('leo')
    expect(note()?.getAttribute('data-footer-note')).toBe('muted')
    expect(note()?.textContent).toBe('Only Leo Martins and org admins can manage it.')
    await pickLead('aisha')
    expect(note()).toBeNull()
  })

  it('shows an org admin no note', async () => {
    await load('admin')
    await openSub('sensor')
    await pickLead('leo')
    expect(note()).toBeNull()
    expect(P.isAdmin()).toBe(true)
  })

  it('checks its parent on the server and turns Create on only once the answer allows it', async () => {
    await load('user')
    server.reads.hold(true)
    await openSub('sensor')
    await type(nameField(), 'Docs')
    expect(parentButton().textContent).toBe('Loading…')
    expect(parentButton().disabled).toBe(true)
    expect(create().disabled).toBe(true)
    // the workspace holds the parent, so its Lead may open meanwhile
    expect(find<HTMLButtonElement>('[data-project-lead-picker]').disabled).toBe(false)
    expect(server.reads.open()).toEqual([{ name: 'projectSettings:get', args: { id: 'sensor' } }])
    server.reads.hold(false)
    await rerun()
    expect(parentButton().textContent).toBe('Luma Sensor')
    expect(parentButton().getAttribute('aria-label')).toBe('Project: Luma Sensor')
    expect(parentNote()).toBeUndefined()
    expect(create().disabled).toBe(false)
  })

  it.each<[string, string, (s: typeof server) => void, string]>([
    [
      'a project it does not lead',
      'beam',
      () => {},
      'Only the lead of “Beam” or an organization admin can add sub-projects to it.',
    ],
    ['a sub-project', 'fw', () => {}, "“Firmware” can't take a sub-project."],
    [
      'an archived project',
      'old',
      () => {},
      '“Old rig” is archived, so restore it before adding a sub-project.',
    ],
    [
      'a project it cannot see',
      'gone',
      () => {},
      'The project you opened this from is no longer available.',
    ],
    [
      'a failed check',
      'sensor',
      (s) => (s.force = { fail: ['get'] }),
      "Couldn't check the project.",
    ],
  ])('says why it cannot create under %s and keeps Create off', async (_, parent, force, line) => {
    await load('user')
    force(server)
    await openSub(parent)
    await type(nameField(), 'Docs')
    expect(parentNote()).toContain(line)
    expect(parentButton().textContent).toBe('Choose a project…')
    expect(parentButton().getAttribute('aria-label')).toBe('Project: none chosen')
    expect(create().disabled).toBe(true)
  })

  it('keeps Create off after a failure of a check that answered, until Try again answers', async () => {
    await load('user')
    await openSub('sensor')
    await type(nameField(), 'Docs')
    expect(create().disabled).toBe(false)
    server.force = { fail: ['get'] }
    await rerun()
    expect(parentNote()).toContain("Couldn't check “Luma Sensor” again.")
    expect(parentButton().textContent).toBe('Luma Sensor')
    expect(create().disabled).toBe(true)
    server.force = {}
    server.reads.hold(true)
    await click(button('Try again'))
    // Try again's wait keeps it off
    expect(create().disabled).toBe(true)
    server.reads.hold(false)
    await rerun()
    expect(parentNote()).toBeUndefined()
    expect(create().disabled).toBe(false)
  })

  it('keeps the answer it had while it refreshes after the tab showed again, and reads nothing while hidden', async () => {
    await load('user')
    await openSub('sensor')
    await type(nameField(), 'Docs')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await settle()
    expect(server.reads.open()).toEqual([])
    server.reads.hold(true)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await settle()
    expect(server.reads.open()).toHaveLength(1)
    expect(parentButton().textContent).toBe('Luma Sensor')
    expect(create().disabled).toBe(false)
    // a parent archived meanwhile shows once the answer comes
    server.snap.projects = server.snap.projects.map((p) =>
      p.id === 'sensor' ? { ...p, archived_at: NOW } : p,
    )
    server.reads.hold(false)
    await rerun()
    expect(parentNote()).toContain('is archived')
    expect(create().disabled).toBe(true)
  })

  it('says a picked parent that went is no longer available, by its name, and turns Create off', async () => {
    await load('user')
    await openSub('beam')
    await click(parentButton())
    await click('[data-new-subproject-parent-choice="test-b"]')
    await type(nameField(), 'Docs')
    expect(create().disabled).toBe(false)
    server.snap.projects = server.snap.projects.filter((p) => p.id !== 'test-b')
    await rerun()
    expect(parentNote()).toBe('“Test” is no longer available.')
    expect(parentButton().textContent).toBe('Choose a project…')
    expect(create().disabled).toBe(true)
  })

  it('says the opener’s parent is no longer available once a check that answered turns unavailable, and turns Create off', async () => {
    await load('user')
    await openSub('sensor')
    await type(nameField(), 'Docs')
    expect(create().disabled).toBe(false)
    server.snap.projects = server.snap.projects.filter((p) => p.id !== 'sensor')
    await rerun()
    expect(parentNote()).toBe('The project you opened this from is no longer available.')
    expect(parentButton().textContent).toBe('Choose a project…')
    expect(create().disabled).toBe(true)
  })

  it('reads its parents only once the Project popover opens, in the parent’s organization, tagged by equal names', async () => {
    await load('user')
    const label = vi.spyOn(P, 'projectLabel')
    let tagReads = 0
    let tags = P.projectTags
    Object.defineProperty(P, 'projectTags', {
      configurable: true,
      get: () => {
        tagReads++
        return tags
      },
      set: (value) => {
        tags = value
      },
    })
    await openSub('beam')
    expect(askedFor('projectSettings:projects')).toEqual([])
    await click(parentButton())
    expect(askedFor('projectSettings:projects')).toEqual([
      { org_id: home, sub_project_parents: true },
    ])
    // the projects Aisha leads, Beam and Old rig left out
    expect(parentRows()).toEqual(['Luma Sensor', 'Test#7', 'Test#9'])
    expect(label).not.toHaveBeenCalled()
    expect(tagReads).toBe(0)
    // a pick is checked on the server in turn
    await click('[data-new-subproject-parent-choice="test-b"]')
    expect(server.reads.open().map((r) => r.args)).toEqual([{ id: 'test-b' }])
    expect(parentButton().textContent).toBe('Test #9')
    expect(parentNote()).toBeUndefined()
    await type(nameField(), 'Docs')
    expect(create().disabled).toBe(false)
  })

  it('shows a stopped batch and the not ready and unchecked answers as such, and the empty line only at a real end', async () => {
    await load('user')
    server.listForce = { stop: 1 }
    await openSub('beam')
    await click(parentButton())
    const text = () => find('[data-new-subproject-parents]').textContent ?? ''
    expect(parentRows()).toEqual(['Luma Sensor'])
    expect(text()).toContain('Showing the projects found so far.')
    expect(text()).not.toContain('Project Lead access is required to create sub-projects.')
    await click(button('Load more'))
    // one Test loaded, so nothing to tell apart yet
    expect(parentRows()).toEqual(['Luma Sensor', 'Test'])
    await click(parentButton())
    server.listForce = { notReady: true }
    await click(parentButton())
    expect(text()).toContain("Projects can't be listed yet.")
    expect(text()).not.toContain('Project Lead access is required to create sub-projects.')
    await click(parentButton())
    server.listForce = { unchecked: 'Qivo could not finish checking which projects you can see.' }
    await click(parentButton())
    expect(text()).toContain('Qivo could not finish checking which projects you can see.')
    expect(text()).not.toContain('no longer available')
    await click(parentButton())
    server.listForce = { fail: ['projects'] }
    await click(parentButton())
    expect(text()).toContain("Couldn't load projects.")
    await click(parentButton())
    // a person who leads nothing in the organization
    server.listForce = {}
    server.snap.projects = server.snap.projects.map((p) =>
      p.org_id === home ? { ...p, lead_id: 'leo' } : p,
    )
    await click(parentButton())
    expect(text()).toContain('Project Lead access is required to create sub-projects.')
    const search = find<HTMLInputElement>('[data-new-subproject-parent-search]')
    await type(search, 'zz')
    await rest()
    expect(text()).toContain('No projects match.')
  })

  it('opens its Project and Lead popovers modal, so their lists scroll inside the dialog', async () => {
    await load('user')
    await openSub('sensor')
    expect(popoverIsModal()).toBe(false)
    await click(parentButton())
    expect(has('[data-new-subproject-parents]')).toBe(true)
    expect(popoverIsModal()).toBe(true)
    await pressEscape(find('[data-new-subproject-parent-search]'))
    expect(has('[data-new-subproject-parents]')).toBe(false)
    expect(popoverIsModal()).toBe(false)
    await click('[data-project-lead-picker]')
    expect(has('[data-lead-choices]')).toBe(true)
    expect(popoverIsModal()).toBe(true)
  })

  it('reads its Lead with the parent, in the parent’s organization', async () => {
    await load('user')
    await openSub('sensor')
    await click('[data-project-lead-picker]')
    expect(askedFor('projectSettings:leadCandidates')).toEqual([
      { org_id: home, parent_id: 'sensor' },
    ])
    // admins, users and guests, Vic the Viewer left out
    expect(all('[data-lead-choice]').map((c) => c.getAttribute('data-lead-choice'))).toEqual([
      'aisha',
      'leo',
      'nora',
    ])
  })

  it('creates under a parent of another organization as the seat there, and sends that organization', async () => {
    await load('user')
    const onCreate = await openSub('beacon-plan')
    expect(find('[data-new-subproject-org]').textContent).toBe('In Beacon')
    expect(find('[data-project-lead-picker]').getAttribute('data-project-lead-picker')).toBe(
      'aisha-b',
    )
    // the seat there leads it, so the footer says nothing
    expect(note()).toBeNull()
    await pickLead('bea')
    expect(askedFor('projectSettings:leadCandidates')).toEqual([
      { org_id: beacon, parent_id: 'beacon-plan' },
    ])
    expect(note()?.textContent).toBe('Only Bea Lund and org admins can manage it.')
    await pickLead('aisha-b')
    await type(nameField(), 'Docs')
    await click(create())
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'project', parent: 'beacon-plan', lead: 'aisha-b' }),
      { withStarter: true, shown: { orgId: beacon } },
    )
  })

  it('offers a starter task only under a parent the workspace holds', async () => {
    // the server holds Test #9, and the store's copy leaves it out
    await load('user', undefined, (copy) => {
      copy.projects = copy.projects.filter((p) => p.id !== 'test-b')
    })
    const onCreate = await openSub('test-b')
    expect(has('#subproject-starter')).toBe(false)
    // the check names the organization, so the popovers wait for it
    expect(parentButton().textContent).toBe('Test')
    await type(nameField(), 'Docs')
    await click(create())
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ parent: 'test-b', lead: 'aisha' }),
      { withStarter: false, shown: { orgId: home } },
    )
  })

  it('waits for the check before its popovers under a parent the workspace does not hold', async () => {
    await load('user', undefined, (copy) => {
      copy.projects = copy.projects.filter((p) => p.id !== 'beacon-plan')
    })
    server.reads.hold(true)
    await openSub('beacon-plan')
    expect(find<HTMLButtonElement>('[data-project-lead-picker]').disabled).toBe(true)
    // no seat is known yet, so the Lead names nobody
    expect(find('[data-project-lead-picker]').getAttribute('aria-label')).toBe('Lead: Loading…')
    expect(parentButton().disabled).toBe(true)
    server.reads.hold(false)
    await rerun()
    expect(find<HTMLButtonElement>('[data-project-lead-picker]').disabled).toBe(false)
    expect(find('[data-project-lead-picker]').getAttribute('data-project-lead-picker')).toBe(
      'aisha-b',
    )
    expect(find('[data-project-lead-picker]').getAttribute('aria-label')).toBe('Lead: Aisha Rahman')
  })
})

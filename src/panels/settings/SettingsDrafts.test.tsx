// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FieldChange } from '../../../convex/lib/functions'
import { TooltipProvider } from '../../components/ui/tooltip'
import { WHOLE } from '../../store/guard/liveDouble.setup'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'

/* Drafts in the settings fields on the real store (lib/savedDraft.ts). A
   field keeps what the person types when the same setting changes in
   another session, shows the new value under it and saves nothing until
   they choose Use saved or Keep mine, and a save sends the value the draft
   began from as the one seen. I am Planner, the admin of Testbed Labs,
   with Leo Martins and the Crew and Ops teams. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../../lib/convex', async () => ({
  convex: network,
  live: (await import('../../store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const NOW = '2026-10-28T08:00:00.000Z'
const LEO = 'leo'

type Pending = {
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (e: unknown) => void
}

let pages: {
  general: typeof import('./OrganizationSettings')
  account: typeof import('./AccountSettings')
  profile: typeof import('./ProfileControls')
  users: typeof import('./UsersSettings')
  teams: typeof import('./TeamSettings')
  version: typeof import('../../store/usePlannerVersion')
}
let store: typeof import('../../store/planner')
let leaveGuard: typeof import('../../lib/leaveGuard')
let snap: Snapshot
let publish: (value: Snapshot) => void
let requests: Pending[]
let toast: ReturnType<typeof vi.fn<(message: string, tone?: string) => void>>
let container: HTMLDivElement
let root: Root
let me: string

/* Builds the workspace and imports the store and pages, without loading. */
async function prepare() {
  vi.resetModules()
  snap = plannerFixture()
  const org = snap.orgs[0].id
  me = snap.profiles[0].id
  snap.profiles.push({
    ...snap.profiles[0],
    id: LEO,
    auth_user_id: 'leo-account',
    name: 'Leo Martins',
    initials: 'LM',
    org_role: 'user',
    email: 'leo@testbed.test',
    plannable_hours: 40,
  })
  for (const [id, name] of [
    ['crew', 'Crew'],
    ['ops', 'Ops'],
  ])
    snap.teams.push({ id, org_id: org, name, track_delay_default: false, created_at: NOW })
  snap.teamMembers.push({ team_id: 'crew', profile_id: LEO, is_leader: false })
  requests = []
  network.query.mockResolvedValue([])
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === WHOLE) publish = next
    const answers: Record<string, unknown> = {
      [WHOLE]: structuredClone(snap),
      'invites:deliveries': [],
      'billing:status': { writable: true },
    }
    next(answers[name] ?? null)
    return () => {}
  })
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    return new Promise((resolve, reject) => requests.push({ name, args, resolve, reject }))
  })
  store = await import('../../store/planner')
  leaveGuard = await import('../../lib/leaveGuard')
  pages = {
    general: await import('./OrganizationSettings'),
    account: await import('./AccountSettings'),
    profile: await import('./ProfileControls'),
    users: await import('./UsersSettings'),
    teams: await import('./TeamSettings'),
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
  await prepare()
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

/* Loads the store, then renders `page`. */
async function open(page: () => React.ReactNode) {
  await store.initStore()
  await render(page)
}

function find<T extends HTMLElement = HTMLInputElement>(selector: string): T {
  const element = container.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}
const conflict = (within: ParentNode = container) => within.querySelector('[data-draft-conflict]')
const button = (label: string, within: ParentNode = container) => {
  const found = [...within.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  )
  if (!found) throw new Error(`Missing the ${label} button`)
  return found
}

/* Focuses `field` and types `value`, as a person would. */
async function type(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    field.focus()
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const blur = (field: HTMLElement) => act(async () => field.blur())
const click = (element: HTMLElement) => act(async () => element.click())
const enter = (field: HTMLElement) =>
  act(async () => {
    field.focus()
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })

/* Another session changes the workspace, and the change arrives. */
async function elsewhere(change: (s: Snapshot) => void) {
  change(snap)
  await act(async () => publish(structuredClone(snap)))
}

const sent = () => requests.map((r) => r.name)
const last = (name: string) => {
  const request = requests.filter((r) => r.name === name).at(-1)
  if (!request) throw new Error(`${name} was not sent`)
  return request
}
const accept = (name: string) => act(async () => last(name).resolve(null))

/* The server refuses `name` because `by` changed `field` first. */
const refuseChanged = (name: string, change: Omit<FieldChange, 'at'>) =>
  act(async () =>
    last(name).reject(
      new ConvexError({
        code: 'conflict',
        reason: 'field_changed',
        message: `${change.field} changed since you read it`,
        changes: [{ ...change, at: NOW }],
      }),
    ),
  )

const toasts = () => toast.mock.calls.map(([message]) => message)
const orgId = () => snap.orgs[0].id

describe('the organization name', () => {
  const general = () => <pages.general.OrgGeneralPage setPage={vi.fn()} />

  it('keeps the typed name over a rename elsewhere, and saves it over that one after Keep mine', async () => {
    await open(general)
    const field = find('[data-org-name]')
    await type(field, 'Testbed Robotics')
    await elsewhere((s) => {
      s.orgs[0].name = 'Testbed Labs AB'
    })
    expect(field.value).toBe('Testbed Robotics')
    expect(conflict()?.textContent).toContain('Changed elsewhere to “Testbed Labs AB”.')
    expect(field.getAttribute('aria-describedby')).toBe(conflict()?.id)
    expect(conflict()?.getAttribute('aria-live')).toBe('polite')
    await blur(field)
    expect(sent()).toEqual([])
    expect(field.value).toBe('Testbed Robotics')
    expect(leaveGuard.hasUnsaved()).toBe(true)
    await click(button('Keep mine'))
    expect(conflict()).toBeNull()
    // focus is back in the field, so Enter saves
    expect(document.activeElement).toBe(field)
    await enter(field)
    expect(last('orgs:update').args).toMatchObject({
      patch: { name: 'Testbed Robotics' },
      expected: { name: 'Testbed Labs AB' },
    })
  })

  it('keeps the text of a save refused over another change, and names who made it', async () => {
    await open(general)
    const field = find('[data-org-name]')
    await type(field, 'Testbed Robotics')
    await blur(field)
    expect(last('orgs:update').args).toMatchObject({ expected: { name: 'Testbed Labs' } })
    await elsewhere((s) => {
      s.orgs[0].name = 'Testbed Labs AB'
    })
    await refuseChanged('orgs:update', {
      record: 'organization',
      id: orgId(),
      field: 'name',
      by: LEO,
    })
    expect(field.value).toBe('Testbed Robotics')
    expect(conflict()?.textContent).toContain('Leo Martins changed it to “Testbed Labs AB”.')
    expect(toasts().at(-1)).toBe(
      'Not saved. Leo Martins changed the name of the organization. Your text is still in the field. Choose Keep mine under it to replace their version.',
    )
    await click(button('Use saved'))
    expect(field.value).toBe('Testbed Labs AB')
    expect(leaveGuard.hasUnsaved()).toBe(false)
  })

  it('keeps the typed name when a save fails with an error after its value showed', async () => {
    await open(general)
    const field = find('[data-org-name]')
    await type(field, 'Testbed Robotics')
    await blur(field)
    // the store painted the session's own name, which the field took as saved
    expect(field.value).toBe('Testbed Robotics')
    expect(leaveGuard.hasUnsaved()).toBe(false)
    await act(async () => last('orgs:update').reject(new Error('[Request ID: 1] Server Error')))
    expect(field.value).toBe('Testbed Robotics')
    expect(conflict()).toBeNull()
    expect(leaveGuard.hasUnsaved()).toBe(true)
    // blur saves it again, against the name it began from
    await act(async () => field.focus())
    await blur(field)
    expect(last('orgs:update').args).toMatchObject({
      patch: { name: 'Testbed Robotics' },
      expected: { name: 'Testbed Labs' },
    })
  })

  it('takes its own save as no conflict, and keeps what was typed after it', async () => {
    await open(general)
    const field = find('[data-org-name]')
    await type(field, 'Testbed Robotics')
    await blur(field)
    await type(field, 'Testbed Robotics AB')
    await accept('orgs:update')
    await elsewhere((s) => {
      s.orgs[0].name = 'Testbed Robotics'
    })
    expect(field.value).toBe('Testbed Robotics AB')
    expect(conflict()).toBeNull()
    await enter(field)
    expect(last('orgs:update').args).toMatchObject({
      patch: { name: 'Testbed Robotics AB' },
      expected: { name: 'Testbed Robotics' },
    })
  })

  it('goes back to the name it began from when two quick saves are refused', async () => {
    await open(general)
    const field = find('[data-org-name]')
    await type(field, 'Testbed Robotics')
    await blur(field)
    await type(field, 'Testbed Robotics AB')
    await blur(field)
    const [first, second] = requests.filter((r) => r.name === 'orgs:update')
    expect(second.args).toMatchObject({ expected: { name: 'Testbed Robotics' } })
    const changed = new ConvexError({
      code: 'conflict',
      reason: 'field_changed',
      message: 'name changed since you read it',
      changes: [{ record: 'organization', id: orgId(), field: 'name', by: null, at: NOW }],
    })
    await act(async () => first.reject(changed))
    await act(async () => second.reject(changed))
    // the other change has not arrived: the name it began from is no conflict
    expect(field.value).toBe('Testbed Robotics AB')
    expect(conflict()).toBeNull()
    expect(leaveGuard.hasUnsaved()).toBe(true)
    await elsewhere((s) => {
      s.orgs[0].name = 'Testbed Labs AB'
    })
    expect(conflict()?.textContent).toContain('Changed elsewhere to “Testbed Labs AB”.')
    await click(button('Keep mine'))
    await enter(field)
    expect(last('orgs:update').args).toMatchObject({
      patch: { name: 'Testbed Robotics AB' },
      expected: { name: 'Testbed Labs AB' },
    })
  })

  it('keeps a draft when another setting of the organization changes', async () => {
    await open(general)
    const field = find('[data-org-name]')
    await type(field, 'Testbed Robotics')
    await elsewhere((s) => {
      s.orgs[0].slug = 'testbed-labs'
      s.orgs[0].default_plannable_hours = 36
    })
    expect(field.value).toBe('Testbed Robotics')
    expect(conflict()).toBeNull()
    expect(find('[data-org-plannable]').value).toBe('36')
    expect(find('[data-org-slug]').value).toBe('testbed-labs')
  })
})

describe('the organization address', () => {
  const general = () => <pages.general.OrgGeneralPage setPage={vi.fn()} />

  it('waits on an address changed elsewhere and saves after Keep mine', async () => {
    await open(general)
    const field = find('[data-org-slug]')
    await type(field, 'testbed-ab')
    await elsewhere((s) => {
      s.orgs[0].slug = 'testbed-labs'
    })
    expect(field.value).toBe('testbed-ab')
    expect(conflict()?.textContent).toContain('Changed elsewhere to “testbed-labs”.')
    expect(find<HTMLButtonElement>('[data-org-slug-save]').disabled).toBe(true)
    await click(button('Keep mine'))
    await click(find<HTMLButtonElement>('[data-org-slug-save]'))
    expect(last('orgs:setSlug').args).toMatchObject({
      slug: 'testbed-ab',
      expected: { slug: 'testbed-labs' },
    })
  })

  it('shows who changed it after a refused save, in place of the refusal line', async () => {
    await open(general)
    const field = find('[data-org-slug]')
    await type(field, 'testbed-ab')
    await click(find<HTMLButtonElement>('[data-org-slug-save]'))
    expect(last('orgs:setSlug').args).toMatchObject({ expected: { slug: 'testbed' } })
    await elsewhere((s) => {
      s.orgs[0].slug = 'testbed-labs'
    })
    await refuseChanged('orgs:setSlug', {
      record: 'organization',
      id: orgId(),
      field: 'slug',
      by: LEO,
    })
    expect(field.value).toBe('testbed-ab')
    expect(conflict()?.textContent).toContain('Leo Martins changed it to “testbed-labs”.')
    expect(container.querySelector('[data-org-slug-error]')).toBeNull()
    // Use saved takes the refusal away with the draft it was about
    await click(button('Use saved'))
    expect(field.value).toBe('testbed-labs')
    expect(container.querySelector('[data-org-slug-error]')).toBeNull()
  })

  it('says why a save was refused before the other change arrived', async () => {
    await open(general)
    const field = find('[data-org-slug]')
    await type(field, 'testbed-ab')
    await click(find<HTMLButtonElement>('[data-org-slug-save]'))
    await refuseChanged('orgs:setSlug', {
      record: 'organization',
      id: orgId(),
      field: 'slug',
      by: LEO,
    })
    expect(field.value).toBe('testbed-ab')
    expect(find('[data-org-slug-error]').textContent).toBe(
      'Not saved. Leo Martins changed the address of the organization. Your text is still in the field. Choose Keep mine under it to replace their version.',
    )
    // the change arrives: the conflict says the same, with the way out
    await elsewhere((s) => {
      s.orgs[0].slug = 'testbed-labs'
    })
    expect(conflict()?.textContent).toContain('Leo Martins changed it to “testbed-labs”.')
    expect(container.querySelector('[data-org-slug-error]')).toBeNull()
  })
})

describe('default plannable hours', () => {
  it('keeps typed hours over hours changed elsewhere and saves nothing on blur', async () => {
    await open(() => <pages.general.OrgGeneralPage setPage={vi.fn()} />)
    const field = find('[data-org-plannable]')
    await type(field, '32')
    await elsewhere((s) => {
      s.orgs[0].default_plannable_hours = 36
    })
    expect(field.value).toBe('32')
    expect(conflict()?.textContent).toContain('Changed elsewhere to “36”.')
    await blur(field)
    expect(sent()).toEqual([])
    await click(button('Keep mine'))
    await enter(field)
    expect(last('orgs:update').args).toMatchObject({
      patch: { default_plannable_hours: 32 },
      expected: { default_plannable_hours: 36 },
    })
    // the session's own value arrives: no conflict
    await accept('orgs:update')
    await elsewhere((s) => {
      s.orgs[0].default_plannable_hours = 32
    })
    expect(field.value).toBe('32')
    expect(conflict()).toBeNull()
    expect(leaveGuard.hasUnsaved()).toBe(false)
  })

  it('takes the refused mark away with the draft on Use saved', async () => {
    await open(() => <pages.general.OrgGeneralPage setPage={vi.fn()} />)
    const field = find('[data-org-plannable]')
    await type(field, '0')
    await blur(field)
    expect(field.getAttribute('aria-invalid')).toBe('true')
    await elsewhere((s) => {
      s.orgs[0].default_plannable_hours = 36
    })
    expect(field.getAttribute('aria-invalid')).toBe('true')
    await click(button('Use saved'))
    expect(field.value).toBe('36')
    expect(field.getAttribute('aria-invalid')).toBeNull()
  })

  it('takes a person’s refused hours and their mark away on a Discard', async () => {
    const { PlannableHoursInput } = await import('./UserControls')
    const scope = leaveGuard.createUnsentScope()
    await open(() => {
      const leo = store.P.user(LEO)
      return leo ? (
        <leaveGuard.UnsentScopeContext.Provider value={scope}>
          <PlannableHoursInput user={leo} canEdit />
        </leaveGuard.UnsentScopeContext.Provider>
      ) : null
    })
    const field = find(`[data-plannable-for="${LEO}"]`)
    await type(field, '0')
    await blur(field)
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(scope.held()).toEqual(['plannable hours'])
    await act(async () => scope.discard())
    expect(field.value).toBe('40')
    expect(field.getAttribute('aria-invalid')).toBeNull()
    expect(sent()).toEqual([])
  })

  it('sends the stored limit as the one seen while the organization stores no attachment limit', async () => {
    delete snap.orgs[0].max_attachment_mb
    await open(() => <pages.general.OrgGeneralPage setPage={vi.fn()} />)
    const field = find('[data-org-attachment-limit]')
    expect(field.value).toBe('20')
    await type(field, '10')
    await blur(field)
    expect(last('orgs:update').args).toMatchObject({
      patch: { max_attachment_mb: 10 },
      expected: { max_attachment_mb: null },
    })
  })
})

describe('your name', () => {
  const nameField = () => {
    const profile = store.P.user(store.P.CURRENT_USER)
    return profile ? <pages.profile.NameField me={profile} /> : null
  }

  it('keeps the typed name over a name saved elsewhere until Use saved', async () => {
    await open(nameField)
    const field = find('[data-account-name]')
    await type(field, 'Planner Prime')
    await elsewhere((s) => {
      s.profiles[0].name = 'Planner Two'
    })
    expect(field.value).toBe('Planner Prime')
    expect(conflict()?.textContent).toContain('Changed elsewhere to “Planner Two”.')
    expect(find<HTMLButtonElement>('[data-account-name-save]').disabled).toBe(true)
    await click(button('Use saved'))
    expect(field.value).toBe('Planner Two')
    expect(conflict()).toBeNull()
    expect(leaveGuard.hasUnsaved()).toBe(false)
  })

  it('sends the name it began from, and says You for a change from another tab', async () => {
    await open(nameField)
    const field = find('[data-account-name]')
    await type(field, 'Planner Prime')
    await click(find<HTMLButtonElement>('[data-account-name-save]'))
    expect(last('profiles:setDisplayName').args).toMatchObject({
      name: 'Planner Prime',
      expected: { profile_id: me, name: 'Planner' },
    })
    await elsewhere((s) => {
      s.profiles[0].name = 'Planner Two'
    })
    await refuseChanged('profiles:setDisplayName', {
      record: 'profile',
      id: me,
      field: 'name',
      by: me,
    })
    expect(field.value).toBe('Planner Prime')
    expect(conflict()?.textContent).toContain('You changed it elsewhere to “Planner Two”.')
    await click(button('Keep mine'))
    await click(find<HTMLButtonElement>('[data-account-name-save]'))
    expect(last('profiles:setDisplayName').args).toMatchObject({
      expected: { profile_id: me, name: 'Planner Two' },
    })
  })

  it('shows no refusal after Use saved drops the draft it was about', async () => {
    await open(nameField)
    const field = find('[data-account-name]')
    await type(field, 'Planner Prime')
    await click(find<HTMLButtonElement>('[data-account-name-save]'))
    await elsewhere((s) => {
      s.profiles[0].name = 'Planner Two'
    })
    await refuseChanged('profiles:setDisplayName', {
      record: 'profile',
      id: me,
      field: 'name',
      by: null,
    })
    expect(conflict()).not.toBeNull()
    expect(container.querySelector('[data-account-name-error]')).toBeNull()
    await click(button('Use saved'))
    expect(field.value).toBe('Planner Two')
    expect(container.querySelector('[data-account-name-error]')).toBeNull()
  })

  it('takes its own saved name as no conflict, also with more typed before it arrives', async () => {
    await open(nameField)
    const field = find('[data-account-name]')
    await type(field, 'Planner Prime')
    await click(find<HTMLButtonElement>('[data-account-name-save]'))
    await type(field, 'Planner Prime II')
    await elsewhere((s) => {
      s.profiles[0].name = 'Planner Prime'
    })
    await accept('profiles:setDisplayName')
    expect(field.value).toBe('Planner Prime II')
    expect(conflict()).toBeNull()
    await click(find<HTMLButtonElement>('[data-account-name-save]'))
    expect(last('profiles:setDisplayName').args).toMatchObject({
      expected: { name: 'Planner Prime' },
    })
  })
})

describe('the Users page', () => {
  const users = () => <pages.users.OrgUsersPage setPage={vi.fn()} />

  it('keeps a typed roster name over a rename elsewhere, and saves over it after Keep mine', async () => {
    await open(users)
    const field = find(`[data-user-name="${LEO}"]`)
    await type(field, 'Leo M.')
    await elsewhere((s) => {
      const leo = s.profiles.find((p) => p.id === LEO)
      if (leo) leo.name = 'Leo Martinez'
    })
    expect(field.value).toBe('Leo M.')
    const row = find<HTMLElement>(`[data-user-row="${LEO}"]`)
    expect(conflict(row)?.textContent).toContain('Changed elsewhere to “Leo Martinez”.')
    await blur(field)
    expect(sent()).not.toContain('profiles:update')
    await click(button('Keep mine', row))
    await enter(field)
    expect(last('profiles:update').args).toMatchObject({
      id: LEO,
      patch: { name: 'Leo M.' },
      expected: { name: 'Leo Martinez' },
    })
  })

  it('puts the saved name and address back on Escape and saves nothing', async () => {
    snap.profiles.push({
      ...snap.profiles[1],
      id: 'ana',
      name: 'Ana Berg',
      auth_user_id: undefined,
      email: 'ana@testbed.test',
    })
    await open(users)
    for (const [selector, saved] of [
      [`[data-user-name="${LEO}"]`, 'Leo Martins'],
      ['input[data-user-email="ana"]', 'ana@testbed.test'],
    ]) {
      const field = find(selector)
      await type(field, 'Someone else')
      await act(async () =>
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      )
      // the field's open tooltip takes the press and sends it on (passEscapeOn)
      await vi.waitFor(() => expect(field.value).toBe(saved))
      expect(document.activeElement).not.toBe(field)
    }
    expect(sent()).toEqual([])
  })

  it('keeps typed plannable hours over hours changed elsewhere', async () => {
    await open(users)
    const field = find(`[data-plannable-for="${LEO}"]`)
    await type(field, '30')
    await elsewhere((s) => {
      const leo = s.profiles.find((p) => p.id === LEO)
      if (leo) leo.plannable_hours = 32
    })
    expect(field.value).toBe('30')
    await blur(field)
    expect(sent()).not.toContain('profiles:setPlannableHours')
    await click(button('Keep mine', find<HTMLElement>(`[data-user-row="${LEO}"]`)))
    await enter(field)
    expect(last('profiles:setPlannableHours').args).toMatchObject({
      hours: 30,
      expected: { plannable_hours: 32 },
    })
  })
})

describe('the team name', () => {
  it('keeps a typed team name over a rename elsewhere, and saves over it after Keep mine', async () => {
    await open(() => <pages.teams.TeamPage teamId="crew" setPage={vi.fn()} />)
    const field = find('input[aria-label="Team name"]')
    await type(field, 'Bench crew')
    await elsewhere((s) => {
      const crew = s.teams.find((t) => t.id === 'crew')
      if (crew) crew.name = 'Field crew'
    })
    expect(field.value).toBe('Bench crew')
    expect(conflict()?.textContent).toContain('Changed elsewhere to “Field crew”.')
    await blur(field)
    expect(sent()).toEqual([])
    await click(button('Keep mine'))
    await enter(field)
    expect(last('teams:update').args).toMatchObject({
      id: 'crew',
      patch: { name: 'Bench crew' },
      expected: { name: 'Field crew' },
    })
  })

  it('starts another team’s page untouched', async () => {
    let team = 'crew'
    await open(() => <pages.teams.TeamPage teamId={team} setPage={vi.fn()} />)
    await type(find('input[aria-label="Team name"]'), 'Bench crew')
    team = 'ops'
    await render(() => <pages.teams.TeamPage teamId={team} setPage={vi.fn()} />)
    expect(find('input[aria-label="Team name"]').value).toBe('Ops')
    expect(leaveGuard.hasUnsaved()).toBe(false)
  })
})

describe('pages without their saved values', () => {
  it('say they are loading until the store has loaded', async () => {
    await render(() => (
      <>
        <pages.account.AccountPage narrow section="profile" setPage={vi.fn()} />
        <pages.general.OrgGeneralPage setPage={vi.fn()} />
      </>
    ))
    expect(find<HTMLElement>('[data-account-profile]').textContent).toBe('Loading your profile…')
    expect(find<HTMLElement>('[data-org-state]').textContent).toBe('Loading the organization…')
    expect(container.querySelector('[data-account-name]')).toBeNull()
    expect(container.querySelector('[data-account-email]')).toBeNull()
    expect(container.querySelector('[data-org-name]')).toBeNull()
  })

  it('say the profile and the organization could not be loaded when the store has none', async () => {
    // the seat the server names is not in the roster this store holds
    snap.myProfileIds = ['gone']
    await open(() => (
      <>
        <pages.account.AccountPage narrow section="profile" setPage={vi.fn()} />
        <pages.general.OrgGeneralPage setPage={vi.fn()} />
      </>
    ))
    expect(store.P.loaded).toBe(true)
    expect(find<HTMLElement>('[data-account-profile]').textContent).toBe(
      'Your profile could not be loaded.',
    )
    expect(find<HTMLElement>('[data-org-state]').textContent).toBe(
      'The organization could not be loaded.',
    )
    expect(container.textContent).not.toContain('no email address')
    expect(container.querySelector('[data-org-name]')).toBeNull()
    // signing out stays possible
    expect(button('Sign out')).toBeDefined()
  })
})

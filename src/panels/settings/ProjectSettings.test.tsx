// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'
import {
  type ForcedProjectLists,
  isProjectListRead,
  projectListsServer,
} from '../../store/projectSettingsListsStandIn.setup'
import {
  type ForcedProjectSettings,
  isProjectSettingsRead,
  projectSettingsServer,
} from '../../store/projectSettingsStandIn.setup'

/* A project's Settings page on the real store, its reads answered by the
   project settings stand-in (store/projectSettingsStandIn.setup.ts) over a
   workspace the test holds as the server's, which it can change and answer
   again as Convex reruns the open reads. The store holds its own copy,
   which a test can make differ from the server's, so a page that read the
   workspace instead of the server shows up.

   Testbed Labs: I am Planner, an organization admin. Plan is a top-level
   project led by Mira Holm, with User grants for Leo Berg and Viewer grants
   for Ada Lind and Vic Viewer (an organization Viewer), and the Crew team
   at User; Work is a legacy sub-project of Plan without a lead of its own;
   Docs is led by Build Bot, an agent. Nora Admin, Gus Guest and Val Viewer
   hold nothing on Plan, and neither does the Bench team. */

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

const NOW = '2026-09-14T08:00:00.000Z'

type Pending = {
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (e: unknown) => void
}

let P: typeof import('../../store/planner')['P']
let version: typeof import('../../store/usePlannerVersion')
let requests: Pending[]
let toast: ReturnType<typeof vi.fn<(message: string, tone?: string) => void>>
let container: HTMLDivElement
let root: Root
let me: string
/* What the server holds, the states it is asked to force, its reads, and
   the way to publish the store's copy of the workspace. */
let server: {
  snap: Snapshot
  force: ForcedProjectSettings
  reads: ReturnType<typeof projectSettingsServer>
  /** the Sub-projects section's read (projectSettings.subProjects) */
  lists: ReturnType<typeof projectListsServer>
  listForce: ForcedProjectLists
  publish: (snap: Snapshot) => void
}
// what the removal preview answers
let preview: (args: Record<string, unknown>) => Promise<unknown>

/** The fixture the server holds (see the header). */
function fixture(): Snapshot {
  const snap = plannerFixture()
  const org = snap.orgs[0].id
  const self = snap.profiles[0]
  const person = (
    id: string,
    name: string,
    org_role: Snapshot['profiles'][number]['org_role'] = 'user',
    extra: Partial<Snapshot['profiles'][number]> = {},
  ) =>
    snap.profiles.push({
      ...self,
      id,
      auth_user_id: `account-${id}`,
      name,
      org_role,
      initials: name.slice(0, 1),
      email: `${id}@example.test`,
      ...extra,
    })
  person('mira', 'Mira Holm')
  person('leo', 'Leo Berg')
  person('ada', 'Ada Lind')
  person('vic', 'Vic Viewer', 'viewer')
  person('val', 'Val Viewer', 'viewer')
  person('gus', 'Gus Guest', 'guest')
  person('nora', 'Nora Admin', 'admin')
  person('bot', 'Build Bot', 'user', { kind: 'agent', auth_user_id: undefined, email: undefined })
  for (const [id, name] of [
    ['crew', 'Crew'],
    ['bench', 'Bench'],
  ])
    snap.teams.push({ id, org_id: org, name, track_delay_default: false, created_at: NOW })
  snap.teamMembers.push({ team_id: 'crew', profile_id: 'leo', is_leader: false })
  // the fixture's lead stays with its own project, which this replaces
  const { lead_id: _lead, ...base } = snap.projects[0]
  snap.projects = [
    {
      ...base,
      id: 'plan',
      type: 'meta',
      key: 'PLAN',
      num: 1,
      name: 'Plan',
      lead_id: 'mira',
      review_hours: 2,
    },
    { ...base, id: 'work', type: 'project', key: 'WORK', num: 2, name: 'Work', parent_id: 'plan' },
    { ...base, id: 'docs', type: 'meta', key: 'DOC', num: 3, name: 'Docs', lead_id: 'bot' },
  ]
  snap.access = [
    { project_id: 'plan', profile_id: 'leo', level: 'user' },
    { project_id: 'plan', profile_id: 'ada', level: 'viewer' },
    { project_id: 'plan', profile_id: 'vic', level: 'viewer' },
  ]
  snap.teamAccess = [{ project_id: 'plan', team_id: 'crew', level: 'user' }]
  return snap
}

/** Loads the store from the fixture, which `shape` changes first; `held`
    changes the store's own copy after that, so it differs from the
    server's. */
async function load(
  shape?: (snap: Snapshot) => void,
  held?: (snap: Snapshot) => void,
): Promise<void> {
  vi.resetModules()
  const snap = fixture()
  shape?.(snap)
  me = snap.profiles[0].id
  requests = []
  server = {
    snap,
    force: {},
    reads: projectSettingsServer(
      () => server.snap,
      () => server.force,
    ),
    lists: projectListsServer(
      () => server.snap,
      () => server.listForce,
    ),
    listForce: {},
    publish: () => {},
  }
  preview = async () => ({ state: 'ok', pending: true, ...noTasks })
  const storeCopy = (from: Snapshot) => {
    const copy = structuredClone(from)
    held?.(copy)
    return copy
  }
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (isProjectSettingsRead(name)) return server.reads.watch(name, args, next, fail)
    if (isProjectListRead(name)) return server.lists.watch(name, args, next, fail)
    if (name === 'workspace:whole') {
      server.publish = (value) => next(storeCopy(value))
      server.publish(server.snap)
    }
    return () => {}
  })
  network.query.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    if (isProjectSettingsRead(name)) return server.reads.query(name, args)
    if (name === 'accessRemovals:preview') return preview(args)
    if (name === 'projects:removalSummary') return { sub_projects: [], tasks: 0, more: false }
    return null
  })
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    return new Promise((resolve, reject) => requests.push({ name, args, resolve, reject }))
  })
  const store = await import('../../store/planner')
  await store.initStore()
  P = store.P
  version = await import('../../store/usePlannerVersion')
}

/* A preview in which nobody loses sight of a task. */
const noTasks = {
  leave_only: false,
  people: [],
  tasks: 0,
  items: [],
  items_total: 0,
  hidden: 0,
  projects: [],
  keep: { targets: [], changers: [], allowed: true, refusal: null, offered: true, permitted: true },
  reassign: { allowed: true, refusal: null, permitted: true },
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
  document.body.innerHTML = ''
  Reflect.deleteProperty(document, 'visibilityState')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  network.mutation.mockReset()
  network.query.mockReset()
  network.onUpdate.mockReset()
})

/** Lets the page take every answer on its way. */
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
  await act(async () => {
    server.reads.rerun()
    server.lists.rerun()
  })
  await settle()
}
/** Changes what the server holds, as another session's write does, and
    publishes it to the store and the open reads. */
async function elsewhere(edit: (snap: Snapshot) => void) {
  const next = structuredClone(server.snap)
  edit(next)
  next.delivered_at = '2026-09-15T09:00:00.000Z'
  server.snap = next
  await act(async () => server.publish(next))
  await rerun()
}

/* Re-renders on every store change, as the app's shell does. */
function Live({ page }: { page: () => React.ReactNode }) {
  version.usePlannerVersion()
  return page()
}

const setPage = vi.fn()
async function open(projectId = 'plan') {
  const settings = await import('./ProjectSettings')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Live page={() => <settings.ProjectPage projectId={projectId} setPage={setPage} />} />
      </TooltipProvider>,
    ),
  )
  await settle()
}

const find = <E extends Element = HTMLElement>(selector: string) => {
  const el = document.querySelector<E>(selector)
  if (!el) throw new Error(`no ${selector}`)
  return el
}
const has = (selector: string) => document.querySelector(selector) !== null
const button = (label: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  )
const text = (selector: string) => document.querySelector(selector)?.textContent ?? ''
const pageState = () => find('[data-project-settings-state]').dataset.projectSettingsState
const listState = (kind: 'team' | 'user') =>
  find(`[data-project-access-list="${kind}"]`).dataset.projectAccessState
const rows = (kind: 'team' | 'user') =>
  [...document.querySelectorAll<HTMLElement>(`[data-project-access-${kind}]`)].map(
    // the name, without its chips
    (row) => row.querySelector('span.truncate')?.firstChild?.textContent,
  )
const listText = (kind: 'team' | 'user') => text(`[data-project-access-list="${kind}"]`)
const toasts = () => toast.mock.calls.map(([message]) => message)
const reads = (name: string) =>
  network.query.mock.calls.filter(([ref]) => getFunctionName(ref) === name).map(([, a]) => a)
const sent = (name: string) => requests.filter((r) => r.name === name).map((r) => r.args)

async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function select(el: HTMLSelectElement, value: string) {
  await act(async () => {
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}
const click = async (el: HTMLElement | null | undefined) => {
  if (!el) throw new Error('nothing to click')
  await act(async () => el.click())
  await settle()
}
/** Types `value` into `field` and leaves it. */
async function enter(field: HTMLInputElement, value: string) {
  await act(async () => field.focus())
  await type(field, value)
  await act(async () => field.blur())
  await settle()
}
async function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await settle()
}
/** Answers the oldest write named `name`: accepted, after `edit` lands on
    the server and its reads answered again, as Convex delivers a write's
    results before its answer, or refused with `error`. */
async function answer(
  name: string,
  edit?: ((snap: Snapshot) => void) | Error,
  value: unknown = null,
) {
  const at = requests.findIndex((r) => r.name === name)
  if (at < 0) throw new Error(`${name} was not sent`)
  const [request] = requests.splice(at, 1)
  if (edit instanceof Error) await act(async () => request?.reject(edit))
  else {
    if (edit) await elsewhere(edit)
    await act(async () => request?.resolve(value))
  }
  await settle()
}
const fieldChanged = (field: string) =>
  new ConvexError({
    code: 'conflict',
    reason: 'field_changed',
    message: `${field} changed since you read it`,
    changes: [],
  })

const reviewField = () => find<HTMLInputElement>('[data-project-review-hours]')
const nameField = () => find<HTMLInputElement>('input[aria-label="Name"]')
const roleOf = (id: string) => find<HTMLSelectElement>(`[data-project-role="${id}"]`)
const removeOf = (id: string) =>
  find<HTMLButtonElement>(`[data-project-access-user="${id}"] [data-project-access-remove]`)
const picker = () => find<HTMLButtonElement>('[data-project-access-picker]')
const choices = () =>
  [...document.querySelectorAll<HTMLElement>('[data-project-access-choice]')].map(
    (c) => c.querySelector('span.truncate')?.textContent,
  )
/** The Sub-projects section's rows, as they read. */
const subProjects = () =>
  [...document.querySelectorAll<HTMLElement>('[data-project-subproject]')].map((b) =>
    b.textContent?.trim(),
  )
/** The Archive or delete section's sentence. */
const archiveLine = () => text('[data-project-removal] p')
/** The name the Lead field's button shows. */
const leadName = () => text('[data-project-lead-picker] span.truncate')
const addButton = () => find<HTMLButtonElement>('[data-add-project-user]')

describe('the page before and after its answer', () => {
  it('shows the title and one line until get answers, and no field, right or list', async () => {
    server.reads.hold(true)
    await open()
    expect(pageState()).toBe('loading')
    expect(find('[data-project-settings-state]').getAttribute('aria-busy')).toBe('true')
    expect(text('h1')).toBe('Project settings')
    expect(document.body.textContent).toContain('Loading project settings…')
    for (const selector of [
      '[data-project-review-hours]',
      '[data-project-access]',
      '[data-remove-project]',
      'input[aria-label="Name"]',
    ])
      expect(has(selector), selector).toBe(false)
    server.reads.hold(false)
    await rerun()
    expect(pageState()).toBe('ok')
    expect(text('h1')).toContain('Plan')
    expect(nameField().value).toBe('Plan')
  })

  it('keeps focus on the heading Settings focused while the page loaded once the answer comes', async () => {
    server.reads.hold(true)
    await open()
    const heading = find('h1')
    // Settings gives the new page's heading focus as it opens by keyboard
    await act(async () => heading.focus())
    server.reads.hold(false)
    await rerun()
    expect(pageState()).toBe('ok')
    expect(find('h1').textContent).toContain('Plan')
    expect(document.activeElement).toBe(heading)
    expect(heading.isConnected).toBe(true)
  })

  it('says it could not load, with Try again, and loads on Try again', async () => {
    server.force = { fail: ['get'] }
    await open()
    expect(pageState()).toBe('failed')
    expect(document.body.textContent).toContain("Couldn't load project settings.")
    expect(has('[data-project-access]')).toBe(false)
    server.force = {}
    await click(button('Try again'))
    expect(pageState()).toBe('ok')
    expect(has('[data-project-access]')).toBe(true)
  })

  it('keeps the page and a typed name through a failure after its answer, with every write control off', async () => {
    await open()
    await act(async () => nameField().focus())
    await type(nameField(), 'Plan B')
    server.force = { fail: ['get'] }
    await rerun()
    expect(pageState()).toBe('failed')
    expect(text('[data-project-settings-failed]')).toContain("Couldn't load project settings.")
    expect(nameField().value).toBe('Plan B')
    expect(nameField().readOnly).toBe(true)
    for (const control of [
      find<HTMLButtonElement>('[data-project-delay-toggle] button'),
      find<HTMLButtonElement>('[data-project-lead-picker]'),
      picker(),
      addButton(),
      removeOf('leo'),
      roleOf('leo'),
      find<HTMLButtonElement>('[data-remove-project]'),
      find<HTMLButtonElement>('[data-invite-send]'),
    ])
      expect(control.disabled, control.outerHTML.slice(0, 80)).toBe(true)
    await act(async () => nameField().blur())
    await settle()
    expect(requests).toEqual([])
    // once an answer is current again the typed name saves with what it began from
    server.force = {}
    await click(button('Try again'))
    expect(pageState()).toBe('ok')
    expect(nameField().value).toBe('Plan B')
    await act(async () => nameField().focus())
    await act(async () => nameField().blur())
    await settle()
    expect(sent('projects:update')).toEqual([
      expect.objectContaining({ patch: { name: 'Plan B' }, expected: { name: 'Plan' } }),
    ])
  })

  it("keeps a project's writes off after its failure when another project's read failed in between, until its own answer comes", async () => {
    await open()
    server.force = { fail: ['get'] }
    await rerun()
    expect(pageState()).toBe('failed')
    // another project's read fails too, then the first project's read is
    // on its way again with its last answer kept
    await open('work')
    expect(pageState()).toBe('failed')
    server.force = {}
    server.reads.hold(true)
    await open()
    expect(pageState()).toBe('refreshing')
    expect(has('[data-project-settings-failed]')).toBe(true)
    expect(find<HTMLButtonElement>('[data-project-lead-picker]').disabled).toBe(true)
    expect(nameField().readOnly).toBe(true)
    server.reads.hold(false)
    await rerun()
    expect(pageState()).toBe('ok')
    expect(has('[data-project-settings-failed]')).toBe(false)
    expect(find<HTMLButtonElement>('[data-project-lead-picker]').disabled).toBe(false)
  })

  it('keeps every write control off and the failure line while Try again waits for an answer', async () => {
    await open()
    server.force = { fail: ['get'] }
    await rerun()
    expect(pageState()).toBe('failed')
    server.force = {}
    server.reads.hold(true)
    await click(button('Try again'))
    expect(pageState()).toBe('refreshing')
    expect(has('[data-project-settings-failed]')).toBe(true)
    const controls = () => [
      find<HTMLButtonElement>('[data-project-delay-toggle] button'),
      find<HTMLButtonElement>('[data-project-lead-picker]'),
      picker(),
      roleOf('leo'),
      removeOf('leo'),
      find<HTMLButtonElement>('[data-remove-project]'),
      find<HTMLInputElement>('[data-invite-email]'),
    ]
    for (const control of controls())
      expect(control.disabled, control.outerHTML.slice(0, 80)).toBe(true)
    expect(nameField().readOnly).toBe(true)
    // a current answer turns them on again
    server.reads.hold(false)
    await rerun()
    expect(pageState()).toBe('ok')
    expect(has('[data-project-settings-failed]')).toBe(false)
    for (const control of controls())
      expect(control.disabled, control.outerHTML.slice(0, 80)).toBe(false)
    expect(nameField().readOnly).toBe(false)
  })

  it('reads nothing while the tab is hidden, and is refreshing on return with what was typed', async () => {
    await open()
    await act(async () => reviewField().focus())
    await type(reviewField(), '5')
    expect(server.reads.open().length).toBeGreaterThan(0)
    await setVisibility('hidden')
    expect(server.reads.open()).toEqual([])
    server.reads.hold(true)
    await setVisibility('visible')
    expect(pageState()).toBe('refreshing')
    expect(find('[data-project-settings-state]').getAttribute('aria-busy')).toBe('true')
    expect(listState('user')).toBe('refreshing')
    expect(reviewField().value).toBe('5')
    server.reads.hold(false)
    await rerun()
    expect(pageState()).toBe('ok')
    expect(listState('user')).toBe('ok')
    expect(reviewField().value).toBe('5')
  })

  it('opens with the project settings reads alone, reads no task, and leaves no read behind', async () => {
    let taskReads = 0
    let issues = P.issues
    Object.defineProperty(P, 'issues', {
      configurable: true,
      get: () => {
        taskReads++
        return issues
      },
      set: (value) => {
        issues = value
      },
    })
    const before = network.onUpdate.mock.calls.length
    await open()
    const opened = network.onUpdate.mock.calls.slice(before).map(([ref]) => getFunctionName(ref))
    // the project's settings and lists, its sub-projects included
    expect([...new Set(opened)].sort()).toEqual([
      'projectSettings:get',
      'projectSettings:subProjects',
      'projectSettings:teams',
      'projectSettings:users',
    ])
    expect(taskReads).toBe(0)
    // the pickers read nothing while closed
    expect(
      network.query.mock.calls.map(([ref]) => getFunctionName(ref)).filter(isProjectSettingsRead),
    ).toEqual([])
    await act(async () => root.unmount())
    expect(server.reads.open()).toEqual([])
    expect(server.lists.open()).toEqual([])
    root = createRoot(container)
  })
})

describe('the rights', () => {
  it("follows every right of the server's answer, never the workspace's", async () => {
    // the store still holds me as the admin; the server says a Viewer
    await load(
      (snap) => {
        snap.profiles[0].org_role = 'user'
        snap.access.push({ project_id: 'plan', profile_id: snap.profiles[0].id, level: 'viewer' })
      },
      (copy) => {
        copy.profiles[0].org_role = 'admin'
      },
    )
    expect(P.isAdmin()).toBe(true)
    await open()
    for (const control of [
      nameField(),
      reviewField(),
      find<HTMLButtonElement>('[data-project-delay-toggle] button'),
      find<HTMLButtonElement>('[data-project-lead-picker]'),
      picker(),
      addButton(),
      roleOf('leo'),
      removeOf('leo'),
      find<HTMLButtonElement>('[data-remove-project]'),
      find<HTMLButtonElement>('[data-invite-send]'),
    ])
      expect(control.disabled, control.outerHTML.slice(0, 80)).toBe(true)
    expect(document.body.textContent).toContain('Project access is read-only for your role.')
    expect(button('View project access')).toBeDefined()
  })

  it('lets an agent that leads a project edit it, but not change its access', async () => {
    const agent = (snap: Snapshot) => {
      Object.assign(snap.profiles[0], { kind: 'agent', org_role: 'user' })
      const docs = snap.projects.find((p) => p.id === 'docs')
      if (docs) docs.lead_id = snap.profiles[0].id
    }
    await load(agent)
    await open('docs')
    expect(nameField().disabled).toBe(false)
    expect(find<HTMLButtonElement>('[data-project-lead-picker]').disabled).toBe(true)
    expect(picker().disabled).toBe(true)
    expect(document.body.textContent).toContain('Project access is read-only for your role.')
    expect(find<HTMLButtonElement>('[data-remove-project]').disabled).toBe(false)
  })

  it('names the picker Add user… without the right to change team access', async () => {
    const { ProjectAccessEditor } = await import('../../components/ProjectAccessEditor')
    const grantRole = 'user' as const
    const org = server.snap.orgs[0].id
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ProjectAccessEditor
            project={{ id: 'plan', org_id: org }}
            canManageUsers
            canManageTeams={false}
            canChangeLead
            current
            role={grantRole}
            onRoleChange={() => {}}
            onLevel={async () => true}
            onRemove={() => {}}
            checking={() => false}
            removing={() => false}
          />
        </TooltipProvider>,
      ),
    )
    await settle()
    expect(picker().textContent).toContain('Add user…')
    expect(document.body.textContent).toContain('Your role cannot change team access.')
    expect(find<HTMLButtonElement>('[data-project-team-role="crew"]').disabled).toBe(true)
  })
})

describe('Review time on the draft model', () => {
  it('saves a rounded number with the value it began from, and puts back one that rounds to it', async () => {
    await open()
    await enter(reviewField(), '2.04')
    expect(reviewField().value).toBe('2')
    expect(requests).toEqual([])
    await enter(reviewField(), '3.04')
    expect(reviewField().value).toBe('3')
    expect(sent('projects:update')).toEqual([
      expect.objectContaining({ patch: { review_hours: 3 }, expected: { review_hours: 2 } }),
    ])
    await answer('projects:update', (snap) => {
      snap.projects[0].review_hours = 3
    })
    expect(toasts()).toEqual(['Review time set to 3 h'])
    expect(reviewField().value).toBe('3')
  })

  it('puts back the saved value for an unparsable entry, which a number input reads as empty', async () => {
    await open()
    await act(async () => reviewField().focus())
    // an entry such as 2e: the browser marks it badInput and its value ''
    Object.defineProperty(reviewField(), 'validity', {
      configurable: true,
      value: { badInput: true },
    })
    await type(reviewField(), '')
    await act(async () => reviewField().blur())
    await settle()
    expect(requests).toEqual([])
    expect(reviewField().value).toBe('2')
  })

  it('clears to the inherited value, and keeps a number outside 0 to 999 typed and marked', async () => {
    await open()
    await enter(reviewField(), '1000')
    expect(reviewField().getAttribute('aria-invalid')).toBe('true')
    expect(toasts()).toEqual([
      'Review hours must be a number from 0 to 999. Enter a number in that range.',
    ])
    expect(requests).toEqual([])
    await enter(reviewField(), '')
    expect(sent('projects:update')).toEqual([
      expect.objectContaining({ patch: { review_hours: null }, expected: { review_hours: 2 } }),
    ])
    await answer('projects:update', (snap) => {
      snap.projects[0].review_hours = undefined
    })
    expect(toasts().at(-1)).toBe('Review time set to 2 h')
    expect(reviewField().placeholder).toBe('2')
  })

  it('keeps a number just outside 0 to 999 marked and unsaved, though it rounds to the saved value', async () => {
    for (const [saved, typed] of [
      [0, '-0.04'],
      [999, '999.04'],
    ] as const) {
      await load((snap) => {
        snap.projects[0].review_hours = saved
      })
      await open()
      const { hasUnsaved } = await import('../../lib/leaveGuard')
      await enter(reviewField(), typed)
      expect(reviewField().value, typed).toBe(typed)
      expect(reviewField().getAttribute('aria-invalid'), typed).toBe('true')
      expect(hasUnsaved(), typed).toBe(true)
      expect(requests).toEqual([])
      await act(async () => root.unmount())
      root = createRoot(container)
    }
  })

  it('keeps the draft when the saved value changes elsewhere, and saves only after Keep mine', async () => {
    await open()
    await act(async () => reviewField().focus())
    await type(reviewField(), '5')
    await elsewhere((snap) => {
      snap.projects[0].review_hours = 3
    })
    expect(reviewField().value).toBe('5')
    expect(text('[data-draft-conflict]')).toContain('Changed elsewhere to “3”.')
    await act(async () => reviewField().blur())
    await settle()
    expect(requests).toEqual([])
    // an empty field saves nothing over a conflict either
    await enter(reviewField(), '')
    expect(requests).toEqual([])
    await type(reviewField(), '5')
    await click(find('[data-draft-keep-mine]'))
    await act(async () => reviewField().blur())
    await settle()
    expect(sent('projects:update')).toEqual([
      expect.objectContaining({ patch: { review_hours: 5 }, expected: { review_hours: 3 } }),
    ])
  })
})

describe('the access lists', () => {
  it("lists teams and people in the server's order, the lead first, each with a search of its own", async () => {
    await open()
    expect(rows('team')).toEqual(['Crew'])
    expect(rows('user')).toEqual(['Mira Holm', 'Ada Lind', 'Leo Berg', 'Vic Viewer'])
    expect(find('[data-project-access-lead]').dataset.projectAccessUser).toBe('mira')
    expect(roleOf('mira').disabled).toBe(true)
    expect(roleOf('mira').value).toBe('lead')
    // an organization Viewer may be given Viewer alone
    expect([...roleOf('vic').options].map((o) => o.value)).toEqual(['viewer'])
    expect([...roleOf('leo').options].map((o) => o.value)).toEqual(['lead', 'user', 'viewer'])
    // a search of the people keeps the teams, and a typed name
    await act(async () => nameField().focus())
    await type(nameField(), 'Plan B')
    await type(find('[data-project-access-list-search="user"]'), 'leo')
    await rest()
    expect(rows('user')).toEqual(['Leo Berg'])
    expect(rows('team')).toEqual(['Crew'])
    expect(nameField().value).toBe('Plan B')
    await type(find('[data-project-access-list-search="user"]'), 'nobody')
    await rest()
    expect(listText('user')).toBe('No one matches.')
  })

  it("finds the lead by a search with no no-match line under the lead's row", async () => {
    await open()
    // the server answers the lead beside the rows, which hold none
    await type(find('[data-project-access-list-search="user"]'), 'mira')
    await rest()
    expect(rows('user')).toEqual(['Mira Holm'])
    expect(listText('user')).not.toContain('No one matches.')
    expect(has('[data-project-access-end="none"]')).toBe(false)
  })

  it('loads more a batch at a time, moves focus to the first new row and asks for a search past the cap', async () => {
    server.force = { batch: 1 }
    // the module the page holds, which load() imported afresh
    const { ACCESS_CAPS } = await import('../../lib/accessCaps')
    const cap = ACCESS_CAPS.list
    // two live batches at most
    ACCESS_CAPS.list = 50
    try {
      await open()
      expect(rows('user')).toEqual(['Mira Holm', 'Ada Lind'])
      const more = find<HTMLButtonElement>('[data-project-access-more="user"]')
      more.focus()
      await click(more)
      await rerun()
      expect(rows('user')).toEqual(['Mira Holm', 'Ada Lind', 'Leo Berg'])
      expect(document.activeElement).toBe(roleOf('leo'))
      expect(listText('user')).toContain('Search to find more people.')
    } finally {
      ACCESS_CAPS.list = cap
    }
  })

  it('moves focus after the last Load more to the search box for a reader who cannot change access', async () => {
    await load((snap) => {
      const self = snap.profiles[0]
      self.org_role = 'user'
      snap.access.push({ project_id: 'plan', profile_id: self.id, level: 'viewer' })
      // 26 direct user grants with Leo's, Ada's, Vic's and mine: one past a batch
      for (let i = 0; i < 22; i++) {
        const id = `person-${String(i).padStart(2, '0')}`
        snap.profiles.push({
          ...self,
          id,
          auth_user_id: `account-${id}`,
          name: `Person ${String(i).padStart(2, '0')}`,
          initials: 'P',
          email: `${id}@example.test`,
        })
        snap.access.push({ project_id: 'plan', profile_id: id, level: 'user' })
      }
    })
    await open()
    // the lead's row and a batch of 25
    expect(rows('user')).toHaveLength(26)
    expect(roleOf('leo').disabled).toBe(true)
    const more = find<HTMLButtonElement>('[data-project-access-more="user"]')
    more.focus()
    await click(more)
    await rerun()
    expect(rows('user').at(-1)).toBe('Vic Viewer')
    expect(has('[data-project-access-more="user"]')).toBe(false)
    expect(roleOf('vic').disabled).toBe(true)
    expect(document.activeElement).toBe(find('[data-project-access-list-search="user"]'))
  })

  it('never says a list is empty where it was not ready, stopped or failed', async () => {
    server.force = { notReady: true }
    await open()
    for (const kind of ['team', 'user'] as const) {
      expect(listText(kind)).toBe("Project access can't be listed yet. Try again in a few minutes.")
      expect(has(`[data-project-access-none="${kind}"]`)).toBe(false)
    }
    // a batch that stopped before it found a match
    server.force = { stop: 1 }
    await type(find('[data-project-access-list-search="user"]'), 'zz')
    await rest()
    expect(listText('user')).toContain('Qivo checked part of the list. Load more continues.')
    expect(listText('user')).not.toContain('match')
    // a failed read, with Retry
    server.force = { fail: ['users'] }
    await type(find('[data-project-access-list-search="user"]'), '')
    await rest()
    expect(listText('user')).toContain("Couldn't load people.")
    expect(listState('user')).toBe('failed')
    expect(has('[data-project-access-none="user"]')).toBe(false)
    server.force = {}
    await click(button('Retry', find('[data-project-access-list="user"]')))
    expect(rows('user')).toEqual(['Mira Holm', 'Ada Lind', 'Leo Berg', 'Vic Viewer'])
  })

  it('says the project is no longer available rather than an empty list', async () => {
    await open()
    server.force = { unavailable: true }
    await rerun()
    expect(pageState()).toBe('unavailable')
    for (const kind of ['team', 'user'] as const) {
      expect(listText(kind)).toBe('This project is no longer available.')
      expect(has(`[data-project-access-none="${kind}"]`)).toBe(false)
    }
    expect(nameField().readOnly).toBe(true)
  })

  it("shows a legacy sub-project's lead from its project, and no empty line beside it", async () => {
    await open('work')
    expect(rows('user')).toEqual(['Mira Holm (from the project)'])
    expect(leadName()).toBe('Mira Holm (from the project)')
    expect(has('[data-project-access-none="user"]')).toBe(false)
    expect(find('[data-project-access-none="team"]').textContent).toBe('No teams added.')
    expect(document.body.textContent).toContain(
      'Parent project permissions also apply. Changes here affect only this sub-project.',
    )
  })
})

describe('changing access', () => {
  it('sends a level with the level its row showed, busy until answered, and shows the server’s after a refusal', async () => {
    // the store holds Leo as a Viewer already, which the page must not send
    await load(undefined, (copy) => {
      const leo = copy.access.find((a) => a.profile_id === 'leo')
      if (leo) leo.level = 'viewer'
    })
    await open()
    expect(roleOf('leo').value).toBe('user')
    await select(roleOf('leo'), 'viewer')
    expect(sent('projects:setAccess')).toEqual([
      expect.objectContaining({ user_id: 'leo', level: 'viewer', expected: { level: 'user' } }),
    ])
    expect(roleOf('leo').disabled).toBe(true)
    expect(roleOf('leo').getAttribute('aria-busy')).toBe('true')
    expect(roleOf('leo').value).toBe('viewer')
    await answer('projects:setAccess', fieldChanged('level'))
    expect(roleOf('leo').disabled).toBe(false)
    expect(roleOf('leo').value).toBe('user')
    // a team's level the same way
    await select(find<HTMLSelectElement>('[data-project-team-role="crew"]'), 'viewer')
    expect(sent('projects:setAccess').at(-1)).toMatchObject({
      team_id: 'crew',
      level: 'viewer',
      expected: { level: 'user' },
    })
  })

  it('adds a person found by a search, an admin included, and keeps the choice and its role through a search', async () => {
    await open()
    expect(reads('projectSettings:candidates')).toEqual([])
    await click(picker())
    expect(reads('projectSettings:candidates')).toHaveLength(1)
    // what the project holds is left out, and so is its lead; admins stay
    expect(choices()).toEqual([
      'Bench',
      'Build Bot',
      'Gus Guest',
      'Nora Admin',
      'Planner',
      'Val Viewer',
    ])
    expect(text('[data-project-access-choices]')).toContain('Teams')
    expect(text('[data-project-access-choices]')).toContain('Users')
    await type(find('[data-project-access-picker-search]'), 'nora')
    await rest()
    expect(choices()).toEqual(['Nora Admin'])
    await click(find('[data-project-access-choice="nora"]'))
    expect(has('[data-project-access-choices]')).toBe(false)
    expect(picker().textContent).toContain('Nora Admin')
    const role = find<HTMLSelectElement>('[data-project-access-new-role]')
    expect([...role.options].map((o) => o.value)).toEqual(['lead', 'user', 'viewer'])
    await select(role, 'viewer')
    // another search keeps the choice; Escape clears it, then closes
    await click(picker())
    await type(find('[data-project-access-picker-search]'), 'bench')
    await rest()
    expect(choices()).toEqual(['Bench'])
    const search = find<HTMLInputElement>('[data-project-access-picker-search]')
    await act(async () =>
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    await settle()
    expect(search.value).toBe('')
    expect(picker().textContent).toContain('Nora Admin')
    await act(async () =>
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    await settle()
    expect(has('[data-project-access-choices]')).toBe(false)
    expect(picker().textContent).toContain('Nora Admin')
    await click(addButton())
    expect(sent('projects:setAccess')).toEqual([
      expect.objectContaining({ user_id: 'nora', level: 'viewer', expected: { level: null } }),
    ])
    await answer('projects:setAccess', (snap) => {
      snap.access.push({ project_id: 'plan', profile_id: 'nora', level: 'viewer' })
    })
    expect(rows('user')).toContain('Nora Admin')
    expect(has('[data-project-access-kept]')).toBe(false)
    expect(picker().textContent).toContain('Add team or user…')
  })

  it('keeps a grant added past the loaded rows as Added until a loaded batch holds it', async () => {
    server.force = { batch: 1 }
    await open()
    expect(rows('user')).toEqual(['Mira Holm', 'Ada Lind'])
    await click(picker())
    await type(find('[data-project-access-picker-search]'), 'nora')
    await rest()
    await click(find('[data-project-access-choice="nora"]'))
    await select(find<HTMLSelectElement>('[data-project-access-new-role]'), 'user')
    await click(addButton())
    await answer('projects:setAccess', (snap) => {
      snap.access.push({ project_id: 'plan', profile_id: 'nora', level: 'user' })
    })
    const kept = find('[data-project-access-kept="nora"]')
    expect(kept.textContent).toBe('NNora AdminUser · Added')
    expect(kept.querySelector('select, button')).toBeNull()
    for (let i = 0; i < 3; i++) {
      await click(find('[data-project-access-more="user"]'))
      await rerun()
    }
    expect(rows('user')).toContain('Nora Admin')
    expect(has('[data-project-access-kept]')).toBe(false)
  })

  it('drops a kept Added row once the Lead field makes that person the lead', async () => {
    server.force = { batch: 1 }
    await open()
    await click(picker())
    await type(find('[data-project-access-picker-search]'), 'nora')
    await rest()
    await click(find('[data-project-access-choice="nora"]'))
    await select(find<HTMLSelectElement>('[data-project-access-new-role]'), 'user')
    await click(addButton())
    await answer('projects:setAccess', (snap) => {
      snap.access.push({ project_id: 'plan', profile_id: 'nora', level: 'user' })
    })
    expect(has('[data-project-access-kept="nora"]')).toBe(true)
    // the lead answer names them now, and the loaded batch never reached them
    await click(find('[data-project-lead-picker]'))
    await type(find('[data-lead-picker-search]'), 'nora')
    await rest()
    await click(find('[data-lead-choice="nora"]'))
    await answer('projects:update', (snap) => {
      snap.projects[0].lead_id = 'nora'
    })
    expect(find('[data-project-access-lead]').dataset.projectAccessUser).toBe('nora')
    expect(has('[data-project-access-kept]')).toBe(false)
    expect(rows('user').filter((name) => name === 'Nora Admin')).toHaveLength(1)
  })

  it("gives an organization Viewer Viewer alone, and reads the picker's batches, cap and refusal", async () => {
    server.force = { batch: 2 }
    await open()
    await click(picker())
    expect(choices()).toEqual(['Bench', 'Build Bot'])
    await click(button('Load more', find('[data-project-access-choices]')))
    expect(choices()).toHaveLength(4)
    expect(reads('projectSettings:candidates')).toHaveLength(2)
    await type(find('[data-project-access-picker-search]'), 'val')
    await rest()
    await click(find('[data-project-access-choice="val"]'))
    const role = find<HTMLSelectElement>('[data-project-access-new-role]')
    expect([...role.options].map((o) => o.value)).toEqual(['viewer'])
    // past the cap a search narrows the list
    const { ACCESS_CAPS } = await import('../../lib/accessCaps')
    const cap = ACCESS_CAPS.choices
    ACCESS_CAPS.choices = 2
    try {
      await click(picker())
      expect(text('[data-project-access-choices]')).toContain('Search to narrow the list.')
    } finally {
      ACCESS_CAPS.choices = cap
    }
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    )
    // a picker the server refuses says why
    server.force = { refused: true }
    await click(picker())
    expect(text('[data-picker-held]')).toBe('No permission to manage users on this project.')
  })

  it('picks a lead from the server and sends the lead the page showed', async () => {
    await open()
    await click(find('[data-project-lead-picker]'))
    expect(reads('projectSettings:leadCandidates')).toEqual([
      { org_id: server.snap.orgs[0].id, project_id: 'plan' },
    ])
    // the people a lead write accepts: no Viewer, the guest and the agent kept
    expect(
      [...document.querySelectorAll('[data-lead-choice]')].map((c) =>
        c.getAttribute('data-lead-choice'),
      ),
    ).toEqual(['ada', 'bot', 'gus', 'leo', 'mira', 'nora', me])
    await click(find('[data-lead-choice="leo"]'))
    expect(sent('projects:update')).toEqual([
      expect.objectContaining({ patch: { lead_id: 'leo' }, expected: { lead_id: 'mira' } }),
    ])
    const lead = find<HTMLButtonElement>('[data-project-lead-picker]')
    expect(lead.disabled).toBe(true)
    expect(lead.getAttribute('aria-busy')).toBe('true')
    expect(leadName()).toBe('Leo Berg')
    await answer('projects:update', (snap) => {
      snap.projects[0].lead_id = 'leo'
      snap.access = snap.access.map((a) =>
        a.profile_id === 'leo' ? { ...a, profile_id: 'mira' } : a,
      )
    })
    expect(find('[data-project-access-lead]').dataset.projectAccessUser).toBe('leo')
    expect(rows('user')).toContain('Mira Holm')
  })

  it("sends nothing for a pick of a legacy sub-project's lead from its project", async () => {
    await open('work')
    await click(find('[data-project-lead-picker]'))
    const mira = find<HTMLButtonElement>('[data-lead-choice="mira"]')
    // shown as the chosen lead, with its check, though the sub-project stores none
    expect(mira.querySelector('svg')).not.toBeNull()
    expect(find('[data-lead-choice="leo"]').querySelector('svg')).toBeNull()
    await click(mira)
    expect(sent('projects:update')).toEqual([])
    expect(leadName()).toBe('Mira Holm (from the project)')
    // another person still becomes its own lead
    await click(find('[data-project-lead-picker]'))
    await click(find('[data-lead-choice="leo"]'))
    expect(sent('projects:update')).toEqual([
      expect.objectContaining({ patch: { lead_id: 'leo' }, expected: { lead_id: null } }),
    ])
  })

  it("turns an open Lead picker's choices off once the page's read fails, and sends nothing", async () => {
    await open()
    await click(find('[data-project-lead-picker]'))
    expect(find<HTMLButtonElement>('[data-lead-choice="leo"]').disabled).toBe(false)
    server.force = { fail: ['get'] }
    await rerun()
    expect(pageState()).toBe('failed')
    const leo = find<HTMLButtonElement>('[data-lead-choice="leo"]')
    expect(leo.disabled).toBe(true)
    await click(leo)
    expect(sent('projects:update')).toEqual([])
    expect(leadName()).toBe('Mira Holm')
  })

  it('looks the address up at the press and sends the level it found as expected', async () => {
    await open()
    const email = find<HTMLInputElement>('[data-invite-email]')
    await type(email, 'leo@example.test')
    await click(find('[data-invite-send]'))
    expect(reads('projectSettings:inviteTarget')).toHaveLength(1)
    expect(sent('projects:inviteGuest')).toEqual([
      expect.objectContaining({
        email: 'leo@example.test',
        level: 'user',
        expected: { level: 'user' },
      }),
    ])
    expect(find<HTMLButtonElement>('[data-invite-send]').textContent).toBe('Inviting…')
    expect(email.disabled).toBe(true)
    await answer('projects:inviteGuest', undefined, { id: 'leo', emailed: false })
    expect(toasts().at(-1)).toBe('leo@example.test was added to “Plan”')
    // a new address sends none found
    await type(email, 'new@example.test')
    await click(find('[data-invite-send]'))
    expect(sent('projects:inviteGuest').at(-1)).toMatchObject({ expected: { level: null } })
    await answer('projects:inviteGuest', undefined, { id: 'new', emailed: true })
    // an organization Viewer can be given Viewer alone, which it says first
    await type(email, 'val@example.test')
    await click(find('[data-invite-send]'))
    expect(text('[data-invite-note]')).toBe(
      'Val Viewer is an organization viewer, so they can only be given Viewer. Invite again to give them Viewer.',
    )
    expect([...find<HTMLSelectElement>('[data-invite-level]').options].map((o) => o.value)).toEqual(
      ['viewer'],
    )
    expect(sent('projects:inviteGuest')).toHaveLength(0)
    await click(find('[data-invite-send]'))
    expect(sent('projects:inviteGuest').at(-1)).toMatchObject({
      level: 'viewer',
      expected: { level: null },
    })
    await answer('projects:inviteGuest', undefined, { id: 'val', emailed: false })
    // a lookup that fails sends nothing
    network.query.mockImplementation(async (ref) => {
      if (getFunctionName(ref) === 'projectSettings:inviteTarget') throw new Error('offline')
      return null
    })
    await type(email, 'other@example.test')
    await click(find('[data-invite-send]'))
    expect(text('[data-invite-note]')).toBe("Couldn't check this address. Nothing was sent.")
    expect(requests).toEqual([])
  })

  it("keeps the invitation's chosen level once an organization Viewer's address is gone", async () => {
    await open()
    const email = find<HTMLInputElement>('[data-invite-email]')
    const level = () => find<HTMLSelectElement>('[data-invite-level]')
    await type(email, 'val@example.test')
    await click(find('[data-invite-send]'))
    expect(level().value).toBe('viewer')
    // another address goes back to the level chosen, User
    await type(email, 'leo@example.test')
    expect(level().value).toBe('user')
    expect([...level().options].map((o) => o.value)).toEqual(['user', 'viewer'])
    await type(email, 'val@example.test')
    await click(find('[data-invite-send]'))
    expect(sent('projects:inviteGuest')).toEqual([
      expect.objectContaining({ email: 'val@example.test', level: 'viewer' }),
    ])
    await answer('projects:inviteGuest', undefined, { id: 'val', emailed: false })
    // and so does the next invitation
    expect(level().value).toBe('user')
    await type(email, 'new@example.test')
    await click(find('[data-invite-send]'))
    expect(sent('projects:inviteGuest')).toEqual([
      expect.objectContaining({ email: 'new@example.test', level: 'user' }),
    ])
  })

  it("gives the server's sentence for an address past the limit, and sends nothing", async () => {
    await open()
    // 255 characters, one past LIMITS.email, which the lookup refuses
    await type(find<HTMLInputElement>('[data-invite-email]'), `${'a'.repeat(250)}@x.io`)
    await click(find('[data-invite-send]'))
    expect(reads('projectSettings:inviteTarget')).toHaveLength(1)
    expect(text('[data-invite-note]')).toBe(
      'An email address must be at most 254 characters. Use a shorter address.',
    )
    expect(requests).toEqual([])
  })

  it("removes a grant through the press with the page's organization, hides its row while the write runs and brings it back on a refusal", async () => {
    await open()
    removeOf('leo').focus()
    await click(removeOf('leo'))
    expect(reads('accessRemovals:preview')).toEqual([
      expect.objectContaining({
        org_id: server.snap.orgs[0].id,
        change: { kind: 'user_grant', project_id: 'plan', user_id: 'leo' },
      }),
    ])
    expect(sent('projects:removeAccess')).toEqual([
      expect.objectContaining({ id: 'plan', user_id: 'leo', on_held_tasks: 'leave' }),
    ])
    expect(rows('user')).toEqual(['Mira Holm', 'Ada Lind', 'Vic Viewer'])
    expect(document.activeElement).toBe(removeOf('vic'))
    await answer('projects:removeAccess', new ConvexError({ code: 'forbidden', message: 'no' }))
    expect(rows('user')).toEqual(['Mira Holm', 'Ada Lind', 'Leo Berg', 'Vic Viewer'])
  })
})

describe('a project the workspace does not hold', () => {
  it("works from the server's answer and sends every write with its organization, painting nothing", async () => {
    await load(undefined, (copy) => {
      copy.projects = copy.projects.filter((p) => p.id !== 'plan' && p.id !== 'work')
      copy.access = []
      copy.teamAccess = []
    })
    const org = server.snap.orgs[0].id
    expect(P.project('plan')).toBeUndefined()
    await open()
    expect(pageState()).toBe('ok')
    expect(nameField().value).toBe('Plan')
    expect(rows('user')).toEqual(['Mira Holm', 'Ada Lind', 'Leo Berg', 'Vic Viewer'])
    // its sub-projects come from the server too
    expect(subProjects()).toEqual(['Work'])
    await click(find('[data-project-delay-toggle] button'))
    expect(sent('projects:update')).toEqual([
      { org_id: org, id: 'plan', patch: { track_delay: true }, expected: { track_delay: false } },
    ])
    expect(find('[data-project-delay-toggle]').getAttribute('aria-busy')).toBe('true')
    await answer('projects:update', (snap) => {
      snap.projects[0].track_delay = true
    })
    expect(find('[data-project-delay-toggle] button').getAttribute('aria-checked')).toBe('true')
    await select(roleOf('leo'), 'viewer')
    expect(sent('projects:setAccess')).toEqual([
      { org_id: org, id: 'plan', user_id: 'leo', level: 'viewer', expected: { level: 'user' } },
    ])
    await answer('projects:setAccess', (snap) => {
      snap.access[0].level = 'viewer'
    })
    expect(roleOf('leo').value).toBe('viewer')
    await click(removeOf('ada'))
    expect(sent('projects:removeAccess')).toEqual([
      expect.objectContaining({ org_id: org, id: 'plan', user_id: 'ada' }),
    ])
    await answer('projects:removeAccess', (snap) => {
      snap.access = snap.access.filter((a) => a.profile_id !== 'ada')
    })
    expect(rows('user')).toEqual(['Mira Holm', 'Leo Berg', 'Vic Viewer'])
    // the workspace still holds none of it
    expect(P.project('plan')).toBeUndefined()
    expect(P.projects.some((p) => p.id === 'plan')).toBe(false)
    await click(find('[data-remove-project]'))
    expect(reads('projects:removalSummary')).toEqual([{ org_id: org, id: 'plan' }])
  })
})

describe("a project page's Sub-projects section", () => {
  it('lists the server’s sub-projects and counts them in the archive sentence once the list is whole', async () => {
    await open()
    expect(subProjects()).toEqual(['Work'])
    expect(archiveLine()).toBe(
      'Archive hides it and its 1 sub-project. Delete moves them and their tasks to Deleted items.',
    )
    expect(server.lists.open().map((r) => [r.name, r.args.org_id, r.args.project_id])).toEqual([
      ['projectSettings:subProjects', server.snap.orgs[0].id, 'plan'],
    ])
    // a sub-project added elsewhere shows, and counts
    await elsewhere((snap) =>
      snap.projects.push({ ...snap.projects[1], id: 'spec', num: 9, name: 'Spec' }),
    )
    expect(subProjects()).toEqual(['Spec', 'Work'])
    expect(archiveLine()).toContain('its 2 sub-projects.')
  })

  it('never counts a partial list nor says none where the list stopped, failed or is held', async () => {
    await load((snap) =>
      snap.projects.push({ ...snap.projects[1], id: 'spec', num: 9, name: 'Spec' }),
    )
    const partial =
      'Archive hides it and its sub-projects. Delete moves them and their tasks to Deleted items.'
    // a batch the server stopped after one row
    server.listForce = { stop: 1 }
    await open()
    expect(subProjects()).toEqual(['Spec'])
    expect(text('[data-project-subprojects-end]')).toBe(
      'Qivo checked part of the list. Load more continues.Load more',
    )
    expect(archiveLine()).toBe(partial)
    // a whole batch with more after it
    server.listForce = { batch: 1 }
    await rerun()
    expect(subProjects()).toEqual(['Spec'])
    expect(text('[data-project-subprojects-end]')).toBe('Load more')
    expect(archiveLine()).toBe(partial)
    server.listForce = { notReady: true }
    await rerun()
    expect(text('[data-project-subprojects-end]')).toBe(
      "Sub-projects can't be listed yet. Try again in a few minutes.",
    )
    server.listForce = { fail: ['subProjects'] }
    await rerun()
    expect(text('[data-project-subprojects-end]')).toBe("Couldn't load its sub-projects.Retry")
    expect(document.body.textContent).not.toContain('No sub-projects yet.')
    expect(archiveLine()).toContain('and its sub-projects.')
  })

  it('says No sub-projects yet. only at the real end of an empty list, and goes alone in the sentence', async () => {
    await load((snap) => {
      snap.projects = snap.projects.filter((p) => p.id !== 'work')
    })
    await open()
    expect(subProjects()).toEqual([])
    expect(text('[data-project-subprojects-end]')).toBe('No sub-projects yet.')
    expect(archiveLine()).toBe('Archive hides it. Delete moves it and its tasks to Deleted items.')
  })

  it('shows no Sub-projects section on a sub-project’s page, which reads none', async () => {
    await open('work')
    expect(has('[data-project-subprojects]')).toBe(false)
    expect(server.lists.open()).toEqual([])
    expect(archiveLine()).toBe('Archive hides it. Delete moves it and its tasks to Deleted items.')
  })
})

describe('Settings around a project page', () => {
  async function settingsAt(page: string, narrow = false) {
    if (narrow)
      vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({
          matches: query.includes('max-width'),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      )
    const { SettingsScreen } = await import('../Settings')
    const resetPage = vi.fn()
    const onBackPage = vi.fn()
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Live
            page={() => (
              <SettingsScreen
                page={page}
                setPage={vi.fn()}
                resetPage={resetPage}
                onBackPage={onBackPage}
                onExit={vi.fn()}
                onNewProject={vi.fn()}
                onNewSubProject={vi.fn()}
                onOpenArchivedTasks={vi.fn()}
              />
            )}
          />
        </TooltipProvider>,
      ),
    )
    await settle()
    return { resetPage, onBackPage }
  }

  it('moves off the page once the server answers unavailable or archived, and never while it loads or failed', async () => {
    server.reads.hold(true)
    const { resetPage } = await settingsAt('project:plan')
    expect(pageState()).toBe('loading')
    expect(resetPage).not.toHaveBeenCalled()
    server.reads.hold(false)
    server.force = { fail: ['get'] }
    await rerun()
    expect(pageState()).toBe('failed')
    expect(resetPage).not.toHaveBeenCalled()
    server.force = {}
    await click(button('Try again'))
    expect(pageState()).toBe('ok')
    await elsewhere((snap) => {
      snap.projects[0].archived_at = NOW
    })
    expect(resetPage).toHaveBeenCalledWith('account')
  })

  it('holds one watch of the settings read with the page, which Try again starts afresh', async () => {
    /* Settings hands its read to the page rather than the page watching
       it a second time. The double gives each watch its own subscription,
       so count them. */
    const gets = () =>
      network.onUpdate.mock.calls.filter(([ref]) => getFunctionName(ref) === 'projectSettings:get')
        .length
    const getsOpen = () => server.reads.open().filter((r) => r.name === 'projectSettings:get')
    server.force = { fail: ['get'] }
    const before = gets()
    await settingsAt('project:plan')
    expect(pageState()).toBe('failed')
    expect(gets() - before).toBe(1)
    expect(getsOpen()).toHaveLength(1)
    server.force = {}
    await click(button('Try again'))
    expect(pageState()).toBe('ok')
    expect(gets() - before).toBe(2)
    expect(getsOpen()).toHaveLength(1)
  })

  it("keeps the page for a project the workspace does not hold, and takes the phone's Back to the parent the answer names", async () => {
    await load(undefined, (copy) => {
      copy.projects = copy.projects.filter((p) => p.id !== 'work')
    })
    const { resetPage, onBackPage } = await settingsAt('project:work', true)
    expect(pageState()).toBe('ok')
    expect(resetPage).not.toHaveBeenCalled()
    const back = find<HTMLButtonElement>('.settings-mobile-header-back')
    expect(back.getAttribute('aria-label')).toBe('Back to Plan')
    await click(back)
    expect(onBackPage).toHaveBeenCalledWith('project:plan')
  })
})

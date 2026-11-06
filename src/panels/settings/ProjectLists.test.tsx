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
  LISTS_UNCHECKED,
  projectListsServer,
  projectListsStandIn,
} from '../../store/projectSettingsListsStandIn.setup'
import {
  isProjectSettingsRead,
  projectSettingsServer,
  readsServer,
} from '../../store/projectSettingsStandIn.setup'

/* Settings › Projects and Archived projects on the real store, their reads
   answered by the Settings project lists' stand-in
   (store/projectSettingsListsStandIn.setup.ts) over a workspace the test
   holds as the server's, which it can change and answer again as Convex
   reruns the open reads. The store holds its own copy, which a test can
   make differ from the server's, so a page that read the workspace instead
   of the server shows up.

   Testbed Labs: I am Planner, an organization admin, unless a case makes
   me someone else. Plan is led by Mira Holm, with Work and Docs under it,
   Leo Berg's User grant and Vic Viewer's Viewer grant; Ops is led by Leo,
   with Ops board under it; two projects are named Design, #7 led by Mira
   and #8 by Leo. Old platform, led by Mira, was archived carrying Old API,
   after Old app was archived on its own; Side, a sub-project of Ops, was
   archived after them. */

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
const T1 = '2026-09-01T08:00:00.000Z'
const T2 = '2026-09-05T08:00:00.000Z'
const T3 = '2026-09-10T08:00:00.000Z'

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
let org: string
/* What the server holds, the states it is asked to force, its reads, and
   the way to publish the store's copy of the workspace. */
let server: {
  snap: Snapshot
  force: ForcedProjectLists
  lists: ReturnType<typeof projectListsServer>
  settings: ReturnType<typeof projectSettingsServer>
  publish: (snap: Snapshot) => void
}
/* The live reads every watch opened, by name, in order. */
let watched: string[]

/** The fixture the server holds (see the header). */
function fixture(): Snapshot {
  const snap = plannerFixture()
  const home = snap.orgs[0].id
  const self = snap.profiles[0]
  const person = (id: string, name: string, org_role: Snapshot['profiles'][number]['org_role']) =>
    snap.profiles.push({
      ...self,
      id,
      auth_user_id: `account-${id}`,
      name,
      org_role,
      initials: name.slice(0, 1),
      email: `${id}@example.test`,
    })
  person('mira', 'Mira Holm', 'user')
  person('leo', 'Leo Berg', 'user')
  person('vic', 'Vic Viewer', 'viewer')
  const base = { ...snap.projects[0], org_id: home, created_at: NOW }
  const meta = (id: string, num: number, name: string, extra: Partial<typeof base> = {}) => ({
    ...base,
    id,
    type: 'meta' as const,
    key: id.slice(0, 4).toUpperCase(),
    num,
    name,
    ...extra,
  })
  const sub = (id: string, num: number, name: string, parent: string, extra = {}) => ({
    ...base,
    id,
    type: 'project' as const,
    key: id.slice(0, 4).toUpperCase(),
    num,
    name,
    parent_id: parent,
    ...extra,
  })
  snap.projects = [
    meta('plan', 1, 'Plan', { lead_id: 'mira' }),
    sub('work', 2, 'Work', 'plan'),
    sub('docs', 3, 'Docs', 'plan'),
    meta('ops', 4, 'Ops', { lead_id: 'leo' }),
    sub('board', 5, 'Ops board', 'ops'),
    sub('side', 6, 'Side', 'ops', { archived_at: T3 }),
    meta('design7', 7, 'Design', { lead_id: 'mira' }),
    meta('design8', 8, 'Design', { lead_id: 'leo' }),
    meta('old', 9, 'Old platform', { lead_id: 'mira', archived_at: T2 }),
    sub('old-api', 10, 'Old API', 'old', { archived_at: T2 }),
    sub('old-app', 11, 'Old app', 'old', { archived_at: T1 }),
  ]
  snap.access = [
    { project_id: 'plan', profile_id: 'leo', level: 'user' },
    { project_id: 'plan', profile_id: 'vic', level: 'viewer' },
  ]
  return snap
}

/** Signs in as `id` instead of Planner, the organization admin. */
const signInAs = (id: string) => (snap: Snapshot) => {
  snap.myProfileIds = [id]
  for (const p of snap.profiles) p.auth_user_id = p.id === id ? 'test-account' : `account-${p.id}`
}

/** Gives me a guest seat in a second organization, Acme, where a User
    grant shows me Acme rollout, live, Acme pilot, archived, and `extra`
    more live projects, Acme 0, Acme 1 and on. */
function acmeSeat(snap: Snapshot, extra = 0) {
  const acme = { ...snap.orgs[0], id: 'acme', name: 'Acme', slug: 'acme' }
  snap.orgs.push(acme)
  snap.profiles.push({ ...snap.profiles[0], id: 'me-acme', org_id: 'acme', org_role: 'guest' })
  snap.myProfileIds.push('me-acme')
  const top = {
    ...snap.projects[0],
    org_id: 'acme',
    lead_id: undefined,
    parent_id: undefined,
    type: 'meta' as const,
    archived_at: undefined,
  }
  const mine = [
    { ...top, id: 'acme-p', num: 1, name: 'Acme rollout' },
    { ...top, id: 'acme-old', num: 2, name: 'Acme pilot', archived_at: T1 },
    ...Array.from({ length: extra }, (_, i) => ({
      ...top,
      id: `acme-${i}`,
      num: 10 + i,
      name: `Acme ${i}`,
    })),
  ]
  snap.projects.push(...mine)
  for (const p of mine) snap.access.push({ project_id: p.id, profile_id: 'me-acme', level: 'user' })
}

/** Takes my Acme seat away, as the workspace answers once it is removed. */
function noAcmeSeat(snap: Snapshot) {
  snap.orgs = snap.orgs.filter((o) => o.id !== 'acme')
  snap.profiles = snap.profiles.filter((p) => p.id !== 'me-acme')
  snap.myProfileIds = snap.myProfileIds.filter((id) => id !== 'me-acme')
  snap.projects = snap.projects.filter((p) => p.org_id !== 'acme')
  snap.access = snap.access.filter((a) => a.profile_id !== 'me-acme')
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
  org = snap.orgs[0].id
  requests = []
  watched = []
  server = {
    snap,
    force: {},
    lists: projectListsServer(
      () => server.snap,
      () => server.force,
    ),
    settings: projectSettingsServer(() => server.snap),
    publish: () => {},
  }
  const storeCopy = (from: Snapshot) => {
    const copy = structuredClone(from)
    held?.(copy)
    return copy
  }
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    watched.push(name)
    if (isProjectListRead(name)) return server.lists.watch(name, args, next, fail)
    if (isProjectSettingsRead(name)) return server.settings.watch(name, args, next, fail)
    if (name === 'workspace:whole') {
      server.publish = (value) => next(storeCopy(value))
      server.publish(server.snap)
    }
    return () => {}
  })
  network.query.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'projects:removalSummary') return { sub_projects: [], tasks: 3, more: false }
    if (isProjectSettingsRead(name)) return server.settings.query(name, args)
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

/* Lets IntersectionObserver report the markers in view, as a scroll to a
   list's end does. */
let observers: { fire: (inView: boolean) => void; gone: boolean }[]

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
  observers = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      entry: { fire: (inView: boolean) => void; gone: boolean }
      constructor(receive: (entries: { isIntersecting: boolean }[]) => void) {
        this.entry = { fire: (inView) => receive([{ isIntersecting: inView }]), gone: false }
        observers.push(this.entry)
      }
      observe() {}
      disconnect() {
        this.entry.gone = true
      }
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
    server.lists.rerun()
    server.settings.rerun()
  })
  await settle()
}
/** Changes what the server holds, as another session's write does, and
    publishes it to the store and the open reads. */
async function elsewhere(edit: (snap: Snapshot) => void) {
  const next = structuredClone(server.snap)
  edit(next)
  next.delivered_at = new Date(Date.parse(server.snap.delivered_at) + 1000).toISOString()
  server.snap = next
  await act(async () => server.publish(next))
  await rerun()
}
/** Lets every list marker in view, as a scroll to the end does. */
const scrollToEnd = async () => {
  await act(async () => {
    for (const o of observers) if (!o.gone) o.fire(true)
  })
  await settle()
}

/* Re-renders on every store change, as the app's shell does. */
function Live({ page }: { page: () => React.ReactNode }) {
  version.usePlannerVersion()
  return page()
}

const setPage = vi.fn()
const onNewSubProject = vi.fn()
const onOpenArchivedTasks = vi.fn()

/** Shows Settings › Projects. */
async function projects() {
  const lists = await import('./ProjectLists')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Live
          page={() => (
            <lists.OrgProjectsPage
              setPage={setPage}
              onNewProject={() => {}}
              onNewSubProject={onNewSubProject}
              onOpenArchivedTasks={onOpenArchivedTasks}
            />
          )}
        />
      </TooltipProvider>,
    ),
  )
  await settle()
}

/** Shows Archived projects, with the question a window asks before it
    closes with unsent text. */
async function archived() {
  const lists = await import('./ProjectLists')
  const { DiscardPrompt } = await import('../../components/DiscardPrompt')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Live page={() => <lists.ArchivedProjectsPage />} />
        <DiscardPrompt />
      </TooltipProvider>,
    ),
  )
  await settle()
}

/** Leaves the page, as a move to another Settings page does. */
async function leave() {
  await act(async () => root.render(<div />))
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
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
  )
const text = (selector: string) => document.querySelector(selector)?.textContent ?? ''
const click = async (el: HTMLElement | null | undefined) => {
  if (!el) throw new Error('nothing to click')
  await act(async () => el.click())
  await settle()
}
/** Presses `el` as a keyboard user does, with focus on it. */
const press = async (el: HTMLElement | null | undefined) => {
  if (!el) throw new Error('nothing to press')
  el.focus()
  await click(el)
}
async function type(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
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
const sent = (name: string) => requests.filter((r) => r.name === name).map((r) => r.args)
/** Answers the oldest write named `name`: accepted, after `edit` lands on
    the server, or refused with `error`. */
async function answer(name: string, edit?: ((snap: Snapshot) => void) | Error) {
  const at = requests.findIndex((r) => r.name === name)
  if (at < 0) throw new Error(`${name} was not sent`)
  const [request] = requests.splice(at, 1)
  if (edit instanceof Error) await act(async () => request?.reject(edit))
  else {
    if (edit) await elsewhere(edit)
    await act(async () => request?.resolve(null))
  }
  await settle()
}
/** The live list reads open now, by name without the module, with their
    arguments. */
const openLists = () =>
  server.lists.open().map((r) => ({ name: r.name.slice('projectSettings:'.length), ...r.args }))

/* -------------------------------------------------------- Settings › Projects */

/** The names of Settings › Projects' rows, top-level and search hits, as
    they read. */
const projectNames = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[data-settings-projects] > div > [data-project-row] > button, [data-settings-projects] > [data-subproject-row] > button',
    ),
  ].map((b) => b.textContent)
/* The tooltip of `element`, which a Button draws from its title, as a
   pointer over it opens it. */
async function hintOf(element: Element | null | undefined) {
  const trigger = element?.closest<HTMLElement>('[data-tooltip-trigger]')
  if (!trigger) return null
  const pointer = (type: string) =>
    Object.assign(new MouseEvent(type, { bubbles: true }), { pointerType: 'mouse' })
  await act(async () => {
    trigger.dispatchEvent(pointer('pointermove'))
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
  const tip = document.querySelector('[data-slot="tooltip-content"]')
  const said = tip?.firstChild?.textContent ?? null
  await act(async () => trigger.dispatchEvent(pointer('pointerleave')))
  await settle()
  return said
}
const projectsEnd = () => find('[data-settings-projects-end]')
const projectsState = () => find('[data-settings-projects]').dataset.settingsProjectsState
const projectMenu = async (id: string) => {
  await click(find(`[data-project-row="${id}"] button[aria-label="Project actions"]`))
  return [...document.querySelectorAll<HTMLElement>('[data-slot="popover-content"] button')].map(
    (b) => b.textContent?.trim(),
  )
}
const subNames = (parent: string) =>
  [
    ...document.querySelectorAll<HTMLElement>(
      `[data-subproject-list="${parent}"] [data-subproject-row] > button`,
    ),
  ].map((b) => b.textContent)

describe('Settings › Projects', () => {
  it('shows a loading frame, then the server’s projects in name order with twins tagged', async () => {
    server.lists.hold(true)
    await projects()
    expect(projectsState()).toBe('loading')
    expect(find('[data-settings-projects]').getAttribute('aria-busy')).toBe('true')
    expect(projectsEnd().textContent).toBe('Loading projects…')
    server.lists.hold(false)
    await rerun()
    expect(projectsState()).toBe('ok')
    expect(find('[data-settings-projects]').getAttribute('aria-busy')).toBeNull()
    expect(projectNames()).toEqual(['Design #7', 'Design #8', 'Ops', 'Plan'])
    expect(has('[data-settings-projects-end]')).toBe(false)
    expect(openLists()).toEqual([{ name: 'projects', org_id: org }])
  })

  it('says why the list is held, refused or failed, never that there are no projects', async () => {
    server.force = { notReady: true }
    await projects()
    expect(projectsEnd().textContent).toBe(
      "Projects can't be listed yet. Try again in a few minutes.",
    )
    server.force = { unchecked: LISTS_UNCHECKED }
    await rerun()
    expect(projectsEnd().textContent).toContain(LISTS_UNCHECKED)
    server.force = { fail: ['projects'] }
    await rerun()
    expect(projectsState()).toBe('failed')
    expect(projectsEnd().textContent).toBe("Couldn't load projects.Try again")
    for (const none of ['You don’t have access to any project yet.', 'No projects match.'])
      expect(document.body.textContent).not.toContain(none)
    server.force = {}
    await click(button('Try again'))
    expect(projectNames()).toHaveLength(4)
  })

  it('says no project only at the real end of an empty first page', async () => {
    await load(signInAs('vic'), undefined)
    server.snap.access = []
    await projects()
    expect(projectsEnd().textContent).toBe('You don’t have access to any project yet.')
  })

  it('pages through Next and Previous, replacing the page and moving focus to its first row', async () => {
    server.force = { batch: 2 }
    await projects()
    expect(projectNames()).toEqual(['Design #7', 'Design #8'])
    const next = find('[data-settings-projects-next]')
    server.lists.hold(true)
    await press(next)
    // the page stays until the next one answers, with its Next reading Loading…
    expect(projectNames()).toEqual(['Design #7', 'Design #8'])
    expect(find('[data-settings-projects-next]').textContent).toBe('Loading…')
    expect(document.activeElement).toBe(find('[data-settings-projects-next]'))
    server.lists.hold(false)
    await rerun()
    expect(projectNames()).toEqual(['Ops', 'Plan'])
    expect(document.activeElement).toBe(find('[data-project-row="ops"] button'))
    expect(has('[data-settings-projects-next]')).toBe(false)
    await press(find('[data-settings-projects-previous]'))
    expect(projectNames()).toEqual(['Design #7', 'Design #8'])
    expect(document.activeElement).toBe(find('[data-project-row="design7"] button'))
  })

  it('keeps focus through Retry of a failed Next, on Retry while it fails and on the first new row once it answers', async () => {
    // a later page's read fails while `later` says so
    let later = true
    server.lists = readsServer((name, args) => {
      if (later && 'after' in args) throw new Error('offline')
      return projectListsStandIn(server.snap, name, args, server.force)
    })
    server.force = { batch: 2 }
    await projects()
    await press(find('[data-settings-projects-next]'))
    const retry = () => find('[data-settings-projects-end] [data-page-retry]')
    expect(projectsEnd().textContent).toContain("Couldn't load the next page.")
    expect(document.activeElement).toBe(retry())
    // Retry leaves while Next reads again, and comes back with the focus
    // when that fails too
    server.lists.hold(true)
    await press(retry())
    expect(has('[data-page-retry]')).toBe(false)
    server.lists.hold(false)
    await rerun()
    expect(document.activeElement).toBe(retry())
    later = false
    server.lists.hold(true)
    await press(retry())
    server.lists.hold(false)
    await rerun()
    expect(projectNames()).toEqual(['Ops', 'Plan'])
    expect(document.activeElement).toBe(find('[data-project-row="ops"] button'))
  })

  it('offers Next beside a page the server stopped, which never ends the list', async () => {
    server.force = { stop: 1 }
    await projects()
    // twins on two pages stay untagged
    expect(projectNames()).toEqual(['Design'])
    expect(projectsEnd().textContent).toBe('Qivo checked part of the list. Next continues.Next')
    await click(find('[data-settings-projects-next]'))
    expect(projectNames()).toEqual(['Design'])
    expect(has('[data-project-row="design8"]')).toBe(true)
  })

  it('searches projects and sub-projects on the server, sub-projects with their project', async () => {
    await projects()
    await type(find('[data-settings-projects-search]'), 'o')
    await rest()
    expect(projectNames()).toEqual(['Docs in Plan', 'Ops', 'Ops board in Ops', 'Work in Plan'])
    expect(openLists()).toEqual([{ name: 'projects', org_id: org, search: 'o' }])
    await click(find('[data-subproject-row="work"] > button'))
    expect(setPage).toHaveBeenLastCalledWith('project:work')
    // past the search limit the last list stays, with the limit's sentence
    await type(find('[data-settings-projects-search]'), `o${'x'.repeat(500)}`)
    await rest()
    expect(projectsEnd().dataset.settingsProjectsEnd).toBe('too_long')
    expect(projectsEnd().textContent).toMatch(/search/i)
    expect(projectNames()).toEqual(['Docs in Plan', 'Ops', 'Ops board in Ops', 'Work in Plan'])
    await type(find('[data-settings-projects-search]'), 'zebra')
    await rest()
    expect(projectsEnd().textContent).toBe('No projects match.')
  })

  it('offers New sub-project… where the row’s right allows it, whatever the store’s copy says', async () => {
    // I hold a User grant on Ops, which Leo leads; the store's copy makes me
    // its lead, and takes Design #7, which I lead, from me. The New
    // sub-project dialog checks its parent on the server, so the row's own
    // right decides
    await load(
      (snap) => {
        signInAs('mira')(snap)
        snap.access.push({ project_id: 'ops', profile_id: 'mira', level: 'user' })
      },
      (copy) => {
        for (const p of copy.projects) {
          if (p.id === 'ops') p.lead_id = 'mira'
          if (p.id === 'design7') p.lead_id = 'leo'
        }
      },
    )
    await projects()
    expect(projectNames()).toEqual(['Design', 'Ops', 'Plan'])
    expect(await projectMenu('plan')).toEqual([
      'New sub-project…',
      'Project settings',
      'Archived tasks',
    ])
    expect(await projectMenu('design7')).toEqual([
      'New sub-project…',
      'Project settings',
      'Archived tasks',
    ])
    expect(await projectMenu('ops')).toEqual(['Project settings', 'Archived tasks'])
    // and Add sub-project at the end of Design #7's empty list
    await click(find('[data-project-row="design7"] > button'))
    expect(button('Add sub-project')).toBeDefined()
    // Leo sees Plan by a User grant, which gives no right to a sub-project
    await load(signInAs('leo'))
    await projects()
    expect(projectNames()).toEqual(['Design', 'Ops', 'Plan'])
    expect(await projectMenu('plan')).toEqual(['Project settings', 'Archived tasks'])
    expect(await projectMenu('ops')).toContain('New sub-project…')
    // a Viewer has none anywhere
    await load(signInAs('vic'))
    await projects()
    expect(projectNames()).toEqual(['Plan'])
    expect(await projectMenu('plan')).toEqual(['Project settings', 'Archived tasks'])
  })

  it('reads one organization at a time, the home one first, with New project only there', async () => {
    await load(acmeSeat)
    await projects()
    const choice = find<HTMLSelectElement>('[data-settings-projects-org]')
    expect([...choice.options].map((o) => o.textContent)).toEqual(['Testbed Labs', 'Acme'])
    expect(has('[data-new-settings-project]')).toBe(true)
    await select(choice, 'acme')
    expect(projectNames()).toEqual(['Acme rollout'])
    expect(openLists()).toEqual([{ name: 'projects', org_id: 'acme' }])
    expect(has('[data-new-settings-project]')).toBe(false)
  })

  it('lists the home organization from its first page once the chosen one’s seat goes while it shows', async () => {
    await load((snap) => acmeSeat(snap, 3))
    server.force = { batch: 2 }
    // every sub-project list the page opens, with its arguments
    const subLists: Record<string, unknown>[] = []
    const watch = server.lists.watch
    server.lists.watch = (name, args, next, fail) => {
      if (name === 'projectSettings:subProjects') subLists.push(args)
      return watch(name, args, next, fail)
    }
    await projects()
    await select(find('[data-settings-projects-org]'), 'acme')
    await click(find('[data-settings-projects-next]'))
    expect(projectNames()).toEqual(['Acme 2', 'Acme rollout'])
    await click(find('[data-project-row="acme-p"] button'))
    expect(openLists()).toContainEqual({
      name: 'subProjects',
      org_id: 'acme',
      project_id: 'acme-p',
    })
    await elsewhere(noAcmeSeat)
    expect(openLists()).toEqual([{ name: 'projects', org_id: org }])
    // Acme rollout's list closed with Acme, never asking the home
    // organization for it, not even for one render
    expect(subLists).toContainEqual({ org_id: 'acme', project_id: 'acme-p' })
    expect(subLists.filter((args) => args.org_id !== 'acme')).toEqual([])
    expect(projectNames()).toEqual(['Design #7', 'Design #8'])
    expect(has('[data-settings-projects-previous]')).toBe(false)
    expect(has('[data-settings-projects-org]')).toBe(false)
  })

  it('opens one project at a time, its sub-projects read only while open, and keeps it across a visit to a project page', async () => {
    await projects()
    await click(find('[data-project-row="plan"] button'))
    expect(subNames('plan')).toEqual(['Docs', 'Work'])
    expect(openLists()).toContainEqual({ name: 'subProjects', org_id: org, project_id: 'plan' })
    await click(find('[data-project-row="ops"] button'))
    expect(has('[data-subproject-list="plan"]')).toBe(false)
    expect(subNames('ops')).toEqual(['Ops board'])
    expect(openLists().filter((r) => r.name === 'subProjects')).toEqual([
      { name: 'subProjects', org_id: org, project_id: 'ops' },
    ])
    // a project's page and Back: the same project open, read again
    await leave()
    expect(openLists()).toEqual([])
    await projects()
    expect(subNames('ops')).toEqual(['Ops board'])
    // collapsing stops its read
    await click(find('[data-project-row="ops"] button'))
    expect(openLists()).toEqual([{ name: 'projects', org_id: org }])
  })

  it('comes back to the page it left, and starts again for another login', async () => {
    server.force = { batch: 2 }
    await projects()
    await click(find('[data-settings-projects-next]'))
    expect(projectNames()).toEqual(['Ops', 'Plan'])
    await leave()
    await projects()
    expect(projectNames()).toEqual(['Ops', 'Plan'])
    expect(has('[data-settings-projects-previous]')).toBe(true)
    await leave()
    await load(signInAs('mira'))
    server.force = { batch: 2 }
    await projects()
    expect(projectNames()).toEqual(['Design', 'Plan'])
    expect(has('[data-settings-projects-previous]')).toBe(false)
  })

  it('loads an open project’s next sub-projects as its end scrolls into view and on Load more, up to its cap', async () => {
    await load((snap) => {
      for (let i = 0; i < 6; i++)
        snap.projects.push({
          ...snap.projects[1],
          id: `more-${i}`,
          num: 20 + i,
          name: `More ${i}`,
        })
    })
    // the page's own copy, which load() imports afresh
    const { PROJECT_LIST_LIMITS } = await import('./projectListReads')
    const was = PROJECT_LIST_LIMITS.subProjects
    // two batches at most, as the list gathers most / LIST_BATCH of them
    PROJECT_LIST_LIMITS.subProjects = 26
    try {
      await projects()
      // batches of two for the sub-projects the open project reads
      server.force = { batch: 2 }
      await click(find('[data-project-row="plan"] button'))
      expect(subNames('plan')).toEqual(['Docs', 'More 0'])
      await scrollToEnd()
      expect(subNames('plan')).toEqual(['Docs', 'More 0', 'More 1', 'More 2'])
      // the cap: a search finds the rest
      expect(text('[data-subprojects-end]')).toBe('Search to find more sub-projects.')
      PROJECT_LIST_LIMITS.subProjects = 100
      await click(find('[data-project-row="plan"] button'))
      await click(find('[data-project-row="plan"] button'))
      const more = find('[data-subproject-more]')
      await press(more)
      expect(subNames('plan')).toEqual(['Docs', 'More 0', 'More 1', 'More 2'])
      expect(document.activeElement).toBe(find('[data-subproject-more]'))
    } finally {
      PROJECT_LIST_LIMITS.subProjects = was
    }
  })

  it('offers Add sub-project at the real end of an empty list with the right, and says No sub-projects. without', async () => {
    await load(signInAs('mira'))
    await projects()
    await click(find('[data-project-row="design7"] button'))
    expect(button('Add sub-project')).toBeDefined()
    await click(button('Add sub-project'))
    expect(onNewSubProject).toHaveBeenLastCalledWith('design7', undefined, expect.any(Function))
    await load(signInAs('leo'))
    server.snap.projects = server.snap.projects.filter((p) => p.parent_id !== 'plan')
    await projects()
    await click(find('[data-project-row="plan"] button'))
    expect(text('[data-subprojects-end]')).toBe('No sub-projects.')
    expect(button('Add sub-project')).toBeUndefined()
    // never for a list that is held or failed
    server.force = { fail: ['subProjects'] }
    await rerun()
    expect(text('[data-subprojects-end]')).toBe("Couldn't load its sub-projects.Retry")
  })

  /** Specs, the sub-project of Plan that New sub-project makes here. */
  const specs = () => ({ ...server.snap.projects[1], id: 'specs', num: 30, name: 'Specs' })
  /** Creates sub-project `made` from Plan's New sub-project… as the
      dialog does: the store paints it, which the server's list lacks, and
      the page hears its id. Answers how to tell the page whether the
      server stored it. */
  async function create(made: ReturnType<typeof specs>) {
    await click(find('[data-project-row="plan"] button[aria-label="Project actions"]'))
    await click(button('New sub-project…'))
    const [, , onCreated] = onNewSubProject.mock.lastCall ?? []
    await act(async () =>
      server.publish({ ...server.snap, projects: [...server.snap.projects, made] }),
    )
    let stored: (ok: boolean) => void = () => {}
    const saved = new Promise<boolean>((resolve) => {
      stored = resolve
    })
    await act(async () => onCreated(made.id, saved))
    await settle()
    return async (ok: boolean) => {
      await act(async () => stored(ok))
      await settle()
    }
  }

  it('keeps a sub-project made here in its open list until the server’s list holds it', async () => {
    await projects()
    await click(find('[data-project-row="plan"] button'))
    const made = specs()
    const stored = await create(made)
    // before the server stored it, a list that ended without it keeps it
    expect(subNames('plan')).toEqual(['Specs', 'Docs', 'Work'])
    const kept = find('[data-subproject-row="specs"] button')
    kept.focus()
    await elsewhere((snap) => snap.projects.push(made))
    expect(subNames('plan')).toEqual(['Docs', 'Specs', 'Work'])
    // the row the server's list took in keeps its element and its focus
    expect(document.activeElement).toBe(find('[data-subproject-row="specs"] button'))
    await stored(true)
    expect(subNames('plan')).toEqual(['Docs', 'Specs', 'Work'])
  })

  it('lets a sub-project made here go once a loaded batch held it, so a rename past the loaded batches leaves it there', async () => {
    // batches of two, so a name after Work's falls behind Load more, and
    // Plan shows on the second page
    server.force = { batch: 2 }
    await projects()
    await click(find('[data-settings-projects-next]'))
    expect(projectNames()).toEqual(['Ops', 'Plan'])
    await click(find('[data-project-row="plan"] button'))
    const made = specs()
    const stored = await create(made)
    expect(subNames('plan')).toEqual(['Specs', 'Docs', 'Work'])
    await elsewhere((snap) => snap.projects.push(made))
    await stored(true)
    expect(subNames('plan')).toEqual(['Docs', 'Specs'])
    await elsewhere((snap) => {
      const p = snap.projects.find((x) => x.id === 'specs')
      if (p) p.name = 'Zeta'
    })
    // Zeta follows Work, past the loaded batch, so it shows only there
    expect(subNames('plan')).toEqual(['Docs', 'Work'])
    await click(find('[data-subproject-more]'))
    expect(subNames('plan')).toEqual(['Docs', 'Work', 'Zeta'])
  })

  it('lets a sub-project made here go once the server stored it and a loaded list tells it does not hold it', async () => {
    await projects()
    await click(find('[data-project-row="plan"] button'))
    // the store holds Specs and the server's list never does
    const stored = await create(specs())
    expect(subNames('plan')).toEqual(['Specs', 'Docs', 'Work'])
    // while the page is hidden its list's answers may be from before
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await stored(true)
    expect(subNames('plan')).toEqual(['Specs', 'Docs', 'Work'])
    // and while it refreshes on return
    server.lists.hold(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await settle()
    expect(subNames('plan')).toEqual(['Specs', 'Docs', 'Work'])
    server.lists.hold(false)
    await rerun()
    expect(subNames('plan')).toEqual(['Docs', 'Work'])
  })

  it('shows no sub-project made here while its list answers that the sub-projects can’t be listed', async () => {
    await projects()
    await click(find('[data-project-row="plan"] button'))
    await create(specs())
    expect(subNames('plan')).toEqual(['Specs', 'Docs', 'Work'])
    server.force = { unavailable: true }
    await rerun()
    expect(subNames('plan')).toEqual([])
    expect(text('[data-subprojects-end]')).toBe("This project's sub-projects can't be listed.")
    // it shows again with the list, which still lacks it
    server.force = {}
    await rerun()
    expect(subNames('plan')).toEqual(['Specs', 'Docs', 'Work'])
  })

  it('reads nothing of the store’s catalogue, no level and no task', async () => {
    const shown = vi.spyOn(P, 'visibleProjects')
    const sees = vi.spyOn(P, 'canSee')
    const level = vi.spyOn(P, 'levelOn')
    let archivedReads = 0
    let held = P.archivedProjects
    Object.defineProperty(P, 'archivedProjects', {
      configurable: true,
      get: () => {
        archivedReads++
        return held
      },
      set: (value) => {
        held = value
      },
    })
    watched = []
    await projects()
    await click(find('[data-project-row="plan"] button'))
    await archived()
    await type(find('[data-archived-projects-search]'), 'old')
    await rest()
    await click(find('[data-archived-subs-toggle="old"]'))
    expect(shown).not.toHaveBeenCalled()
    expect(sees).not.toHaveBeenCalled()
    // New sub-project… follows the row's own right
    expect(level).not.toHaveBeenCalled()
    expect(archivedReads).toBe(0)
    expect(new Set(watched)).toEqual(
      new Set([
        'projectSettings:projects',
        'projectSettings:subProjects',
        'projectSettings:archived',
        'projectSettings:archivedSubProjects',
      ]),
    )
  })

  it('stops while the tab is hidden, keeps its rows and refreshes on return', async () => {
    await projects()
    await click(find('[data-project-row="plan"] button'))
    const before = openLists()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await settle()
    expect(openLists()).toEqual([])
    expect(projectNames()).toHaveLength(4)
    expect(subNames('plan')).toEqual(['Docs', 'Work'])
    server.lists.hold(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await settle()
    const byName = (reads: { name: string }[]) =>
      [...reads].sort((a, b) => a.name.localeCompare(b.name))
    expect(byName(openLists())).toEqual(byName(before))
    expect(projectsState()).toBe('refreshing')
    expect(find('[data-settings-projects]').getAttribute('aria-busy')).toBe('true')
    server.lists.hold(false)
    await rerun()
    expect(projectsState()).toBe('ok')
  })
})

/* ---------------------------------------------------------- Archived projects */

const entries = () =>
  [...document.querySelectorAll<HTMLElement>('[data-archived-project]')].map(
    (row) => `${row.dataset.archivedProject}${row.dataset.archivedUnder === '' ? ' under' : ''}`,
  )
const archivedEnd = () => find('[data-archived-projects-end]')
const chips = () =>
  [...document.querySelectorAll<HTMLElement>('[data-archived-sub]')].map(
    (c) => `${c.textContent}${c.dataset.withParent === '' ? ' with' : ' alone'}`,
  )

describe('Archived projects', () => {
  it('lists entries newest archived first, never a sub-project beneath an archived one', async () => {
    await archived()
    expect(entries()).toEqual(['side', 'old'])
    expect(text('[data-archived-project="side"]')).toContain('sub-project of Ops')
    expect(openLists()).toEqual([{ name: 'archived', org_id: org }])
  })

  it('shows Restore and Delete by each entry’s own rights', async () => {
    await load(signInAs('leo'))
    await archived()
    expect(entries()).toEqual(['side'])
    expect(has('[data-restore-project="side"]')).toBe(true)
    expect(has('[data-delete-project="side"]')).toBe(true)
    await load(signInAs('vic'), (snap) => {
      // the store's copy says I lead Old platform
      const old = snap.projects.find((p) => p.id === 'old')
      if (old) old.lead_id = 'vic'
    })
    server.snap.access.push({ project_id: 'old', profile_id: 'vic', level: 'viewer' })
    await archived()
    expect(entries()).toEqual(['old'])
    expect(has('[data-restore-project="old"]')).toBe(false)
    expect(text('[data-archived-project="old"]')).toContain(
      "only the project's lead can restore it",
    )
  })

  it('restores with the page’s organization; the row leaves with the live answer and focus goes to the next one', async () => {
    // the store's copy leaves Side out, so only the page's organization
    // can name it
    await load(undefined, (copy) => {
      copy.projects = copy.projects.filter((p) => p.id !== 'side')
    })
    await archived()
    const restore = find<HTMLButtonElement>('[data-restore-project="side"]')
    await press(restore)
    expect(sent('projects:unarchive')).toEqual([{ org_id: org, id: 'side' }])
    expect(restore.disabled).toBe(true)
    expect(restore.textContent).toBe('Restoring…')
    await answer('projects:unarchive', (snap) => {
      const side = snap.projects.find((p) => p.id === 'side')
      if (side) side.archived_at = undefined
    })
    expect(entries()).toEqual(['old'])
    expect(document.activeElement).toBe(find('[data-restore-project="old"]'))
    expect(toast).toHaveBeenCalledWith('Restored “Side”')
  })

  it('keeps the row of a refused restore and gives its Restore the focus back', async () => {
    await archived()
    await press(find('[data-restore-project="side"]'))
    await answer('projects:unarchive', new ConvexError({ code: 'forbidden', message: 'no' }))
    expect(entries()).toEqual(['side', 'old'])
    expect(find<HTMLButtonElement>('[data-restore-project="side"]').disabled).toBe(false)
    expect(document.activeElement).toBe(find('[data-restore-project="side"]'))
  })

  it('opens Delete’s window with the entry’s organization', async () => {
    // the store's copy leaves Old platform and its sub-projects out, so
    // only the page's organization can name them
    await load(undefined, (copy) => {
      const gone = new Set(['old', 'old-api', 'old-app'])
      copy.projects = copy.projects.filter((p) => !gone.has(p.id))
    })
    await archived()
    await click(find('[data-delete-project="old"]'))
    expect(text('[data-modal-shell] h2')).toBe('Delete “Old platform”?')
    expect(
      network.query.mock.calls
        .filter(([ref]) => getFunctionName(ref) === 'projects:removalSummary')
        .map(([, a]) => a),
    ).toEqual([{ org_id: org, id: 'old' }])
  })

  it('reads an entry’s sub-projects only on request, one entry at a time, solid and dashed', async () => {
    await load((snap) => {
      snap.projects.push(
        {
          ...snap.projects[8],
          id: 'gone',
          num: 40,
          name: 'Gone app',
          archived_at: '2026-09-02T08:00:00.000Z',
        },
        {
          ...snap.projects[9],
          id: 'gone-a',
          num: 41,
          name: 'Gone API',
          parent_id: 'gone',
          archived_at: '2026-09-02T08:00:00.000Z',
        },
      )
    })
    server.force = { batch: 1 }
    await archived()
    // pages of one entry: Side, then Old platform, then Gone app
    await click(find('[data-archived-projects-next]'))
    expect(entries()).toEqual(['old'])
    expect(openLists()).toEqual([expect.objectContaining({ name: 'archived' })])
    const restore = () => hintOf(find('[data-restore-project="old"]'))
    expect(await restore()).toBe(
      'Restore “Old platform”. Sub-projects archived with it come back too.',
    )
    await click(find('[data-archived-subs-toggle="old"]'))
    expect(find('[data-archived-subs-toggle="old"]').getAttribute('aria-expanded')).toBe('true')
    expect(chips()).toEqual(['Old API with'])
    expect(await restore()).toBe('Restore “Old platform” and the sub-projects archived with it')
    await click(find('[data-archived-subs-more]'))
    expect(chips()).toEqual(['Old API with', 'Old app alone'])
    // a page change closes them and stops their read
    await click(find('[data-archived-projects-next]'))
    expect(entries()).toEqual(['gone'])
    expect(chips()).toEqual([])
    expect(openLists().map((r) => r.name)).toEqual(['archived'])
  })

  it('finds sub-projects beneath an archived project, each acting only through its project’s Restore', async () => {
    await archived()
    await type(find('[data-archived-projects-search]'), 'old')
    await rest()
    expect(entries()).toEqual(['old-api under', 'old', 'old-app under'].sort(byPlace))
    const api = find('[data-archived-project="old-api"]')
    expect(api.textContent).toContain('sub-project of Old platform (archived)')
    expect(api.textContent).toContain('Comes back when “Old platform” is restored.')
    expect(text('[data-archived-project="old-app"]')).toContain(
      'Archived separately. Restore “Old platform” first, then restore this sub-project.',
    )
    expect(has('[data-archived-project="old-api"] [data-delete-project]')).toBe(false)
    expect(has('[data-archived-project="old-api"] [data-restore-project]')).toBe(false)
    const parent = find<HTMLButtonElement>('[data-restore-parent="old-app"]')
    expect(parent.textContent).toBe('Restore “Old platform”')
    await press(parent)
    expect(sent('projects:unarchive')).toEqual([{ org_id: org, id: 'old' }])
    // every row that restores Old platform waits with it
    expect(find<HTMLButtonElement>('[data-restore-parent="old-api"]').disabled).toBe(true)
    expect(find<HTMLButtonElement>('[data-restore-project="old"]').disabled).toBe(true)
    await answer('projects:unarchive', (snap) => {
      for (const p of snap.projects)
        if (p.id === 'old' || (p.parent_id === 'old' && p.archived_at === T2))
          p.archived_at = undefined
    })
    // Old app, archived on its own, stays and is now an entry of its own
    expect(entries()).toEqual(['old-app'])
    expect(document.activeElement).toBe(find('[data-restore-project="old-app"]'))
    // without the right, a hit says so and offers nothing
    await leave()
    await load(signInAs('leo'), undefined)
    server.snap.access.push({ project_id: 'old-api', profile_id: 'leo', level: 'user' })
    await archived()
    await type(find('[data-archived-projects-search]'), 'api')
    await rest()
    expect(entries()).toEqual(['old-api under'])
    expect(has('[data-restore-parent]')).toBe(false)
    expect(text('[data-archived-project="old-api"]')).toContain(
      "only the project's lead can restore it",
    )
  })

  it('lists the home organization once the chosen one’s seat goes while it shows, and keeps a typed deletion reason to copy', async () => {
    // an admin of Acme, so Acme pilot offers Delete, with Pilot API
    // archived with it
    await load((snap) => {
      acmeSeat(snap)
      const seat = snap.profiles.find((p) => p.id === 'me-acme')
      if (seat) seat.org_role = 'admin'
      const pilot = snap.projects.find((p) => p.id === 'acme-old')
      if (pilot)
        snap.projects.push({
          ...pilot,
          id: 'acme-old-api',
          num: 3,
          name: 'Pilot API',
          type: 'project',
          parent_id: 'acme-old',
        })
    })
    // every chip list the page opens, with its arguments
    const chipLists: Record<string, unknown>[] = []
    const watch = server.lists.watch
    server.lists.watch = (name, args, next, fail) => {
      if (name === 'projectSettings:archivedSubProjects') chipLists.push(args)
      return watch(name, args, next, fail)
    }
    await archived()
    await select(find('[data-archived-projects-org]'), 'acme')
    expect(entries()).toEqual(['acme-old'])
    await click(find('[data-archived-subs-toggle="acme-old"]'))
    expect(chipLists).toEqual([{ org_id: 'acme', project_id: 'acme-old' }])
    await click(find('[data-delete-project="acme-old"]'))
    expect(text('[data-modal-shell] h2')).toBe('Delete “Acme pilot”?')
    const reason = find<HTMLTextAreaElement>('[data-fate-reason]')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        reason,
        'Pilot ended',
      )
      reason.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await elsewhere(noAcmeSeat)
    // the chips close with Acme, never asking the home organization for
    // Acme pilot, not even for one render
    expect(chipLists.filter((args) => args.org_id !== 'acme')).toEqual([])
    expect(openLists()).toEqual([{ name: 'archived', org_id: org }])
    expect(entries()).toEqual(['side', 'old'])
    expect(has('[data-archived-projects-org]')).toBe(false)
    // the Delete window stays with Acme, says Acme pilot is gone, sends
    // nothing and keeps the reason to copy
    expect(text('[data-modal-shell] h2')).toBe('Delete “Acme pilot”?')
    expect(text('[data-fate-gone]')).toBe(
      'Acme pilot is no longer here. It was archived or deleted, or you can no longer open it. The reason you typed for it was not used. Copy it to keep it.',
    )
    expect(text('[data-fate-gone-reason] p')).toBe('Pilot ended')
    const shell = find('[data-modal-shell]')
    expect([...shell.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([
      '',
      'Copy reason',
      'Close',
    ])
    expect(sent('projects:deleteDeep')).toEqual([])
    expect(
      network.query.mock.calls
        .filter(([ref]) => getFunctionName(ref) === 'projects:removalSummary')
        .map(([, a]) => a.org_id),
    ).toEqual(['acme'])
    // until the reason is copied, Close asks first
    await click(button('Close', shell))
    expect(text('[data-discard-prompt] h2')).toBe('Discard your unsent reason?')
    await click(button('Keep editing'))
    expect(has('[data-modal-shell]')).toBe(true)
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await click(button('Copy reason'))
    expect(writeText).toHaveBeenCalledWith('Pilot ended')
    await click(button('Close'))
    expect(has('[data-discard-prompt]')).toBe(false)
    expect(has('[data-modal-shell]')).toBe(false)
    expect(sent('projects:deleteDeep')).toEqual([])
  })

  it('says each state at the end of the page, and no archived project only at a real end', async () => {
    server.force = { notReady: true }
    await archived()
    expect(archivedEnd().textContent).toBe(
      "Archived projects can't be listed yet. Try again in a few minutes.",
    )
    server.force = { unchecked: LISTS_UNCHECKED }
    await rerun()
    expect(archivedEnd().textContent).toContain(LISTS_UNCHECKED)
    server.force = { fail: ['archived'] }
    await rerun()
    expect(archivedEnd().textContent).toBe("Couldn't load archived projects.Try again")
    server.force = { stop: 1 }
    await click(button('Try again'))
    expect(archivedEnd().textContent).toBe('Qivo checked part of the list. Next continues.Next')
    expect(document.body.textContent).not.toContain('No archived projects.')
    server.force = {}
    await type(find('[data-archived-projects-search]'), 'zebra')
    await rest()
    expect(archivedEnd().textContent).toBe('No archived projects match.')
    server.snap.projects = server.snap.projects.filter((p) => !p.archived_at)
    await type(find('[data-archived-projects-search]'), '')
    await rest()
    expect(archivedEnd().textContent).toBe('No archived projects.')
  })
})

/** Search rows in the server's order, newest archived first, equal times
    by creation and id, newest first. */
function byPlace(a: string, b: string) {
  const at: Record<string, string> = { 'old-api under': T2, old: T2, 'old-app under': T1 }
  const ta = at[a] ?? ''
  const tb = at[b] ?? ''
  if (ta !== tb) return ta < tb ? 1 : -1
  const ia = a.split(' ')[0] ?? ''
  const ib = b.split(' ')[0] ?? ''
  return ia < ib ? 1 : -1
}

/* --------------------------------------------------------- the design size */

describe('at the design size, one figure at a time, and a read over several at their sum', () => {
  it('walks an admin’s 200 live top-level projects through eight pages and back', async () => {
    await load((snap) => {
      snap.projects = snap.projects.filter((p) => p.parent_id === undefined && !p.archived_at)
      const base = snap.projects[0]
      for (let i = snap.projects.length; i < 200; i++)
        snap.projects.push({
          ...base,
          id: `p-${i}`,
          num: 100 + i,
          name: `Project ${String(i).padStart(3, '0')}`,
          lead_id: undefined,
        })
    })
    await projects()
    const seen = new Set<string>()
    for (let page = 1; page <= 8; page++) {
      for (const name of projectNames()) seen.add(name ?? '')
      expect(projectNames()).toHaveLength(25)
      if (page < 8) await click(find('[data-settings-projects-next]'))
    }
    expect(seen.size).toBe(200)
    expect(has('[data-settings-projects-next]')).toBe(false)
    for (let page = 8; page > 1; page--) await click(find('[data-settings-projects-previous]'))
    expect(projectNames()[0]).toBe('Design #7')
    expect(has('[data-settings-projects-previous]')).toBe(false)
  })

  it('walks an admin’s 300 archived top-level projects through twelve pages', async () => {
    await load((snap) => {
      snap.projects = snap.projects.filter((p) => p.parent_id === undefined && !p.archived_at)
      const base = snap.projects[0]
      for (let i = 0; i < 300; i++)
        snap.projects.push({
          ...base,
          id: `a-${i}`,
          num: 100 + i,
          name: `Archived ${i}`,
          archived_at: new Date(Date.parse(T1) + i * 60_000).toISOString(),
        })
    })
    await archived()
    const seen = new Set<string>()
    for (let page = 1; page <= 12; page++) {
      for (const id of entries()) seen.add(id)
      expect(entries()).toHaveLength(25)
      if (page < 12) await click(find('[data-archived-projects-next]'))
    }
    expect(seen.size).toBe(300)
    expect(entries().at(-1)).toBe('a-0')
    expect(has('[data-archived-projects-next]')).toBe(false)
  })

  it('searches an admin’s live projects and sub-projects at their sum, 200 and 500, to the end', async () => {
    await load((snap) => {
      // the fixture's four live top-level projects and 196 more, with 500
      // live sub-projects under them, all named so one search finds them
      const live = snap.projects.filter((p) => p.parent_id === undefined && !p.archived_at)
      for (const p of live) p.name = `Live ${p.name}`
      const base = live[0]
      for (let i = live.length; i < 200; i++)
        live.push({
          ...base,
          id: `p-${i}`,
          num: 1000 + i,
          name: `Live project ${String(i).padStart(3, '0')}`,
          lead_id: undefined,
        })
      snap.projects = [...live]
      for (let i = 0; i < 500; i++)
        snap.projects.push({
          ...base,
          type: 'project',
          id: `s-${i}`,
          num: 2000 + i,
          name: `Live sub ${String(i).padStart(3, '0')}`,
          parent_id: live[i % 200]?.id,
          lead_id: undefined,
        })
    })
    await projects()
    await type(find('[data-settings-projects-search]'), 'live')
    await rest()
    const shown = () =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-settings-projects] > div > [data-project-row], [data-settings-projects] > [data-subproject-row]',
        ),
      ].map((row) => row.dataset.projectRow ?? row.dataset.subprojectRow ?? '')
    const seen = new Set<string>()
    let pages = 1
    for (; pages <= 40; pages++) {
      for (const id of shown()) seen.add(id)
      expect(shown()).toHaveLength(25)
      if (!has('[data-settings-projects-next]')) break
      await click(find('[data-settings-projects-next]'))
    }
    expect(pages).toBe(28)
    expect(seen.size).toBe(700)
    expect(openLists()).toEqual([expect.objectContaining({ name: 'projects', search: 'live' })])
  })

  it('walks an admin’s archive at its sum, 300 archived top-level projects and 1,000 archived sub-projects of live parents, to its end', async () => {
    await load((snap) => {
      // 167 live top-level parents, the fixture's four and 163 more, with
      // no live sub-project, beside the archive's two figures at their sum,
      // 300 archived top-level projects and 1,000 archived sub-projects,
      // about 6 under each parent. Only that sum is raised. The 167
      // parents stay under the 200 live projects of the design size, no
      // live sub-project is seeded, and 6 archived sub-projects stay under
      // the 40 of one project
      const live = snap.projects.filter((p) => p.parent_id === undefined && !p.archived_at)
      const base = { ...live[0], lead_id: undefined }
      for (let i = live.length; i < 167; i++)
        live.push({ ...base, id: `l-${i}`, num: 1000 + i, name: `Live ${i}` })
      snap.projects = [...live]
      // archived a minute apart, the sub-projects after the projects
      const at = (i: number) => new Date(Date.parse(T1) + i * 60_000).toISOString()
      for (let i = 0; i < 300; i++)
        snap.projects.push({
          ...base,
          id: `a-${i}`,
          num: 2000 + i,
          name: `Archived ${i}`,
          archived_at: at(i),
        })
      for (let i = 0; i < 1000; i++)
        snap.projects.push({
          ...base,
          type: 'project',
          id: `s-${i}`,
          num: 3000 + i,
          name: `Archived sub ${i}`,
          parent_id: live[i % 167]?.id,
          archived_at: at(300 + i),
        })
    })
    await archived()
    // newest archived first, the last sub-project
    expect(entries()[0]).toBe('s-999')
    const seen = new Set<string>()
    let pages = 1
    for (; pages <= 60; pages++) {
      for (const id of entries()) seen.add(id)
      expect(entries()).toHaveLength(25)
      if (!has('[data-archived-projects-next]')) break
      await click(find('[data-archived-projects-next]'))
    }
    expect(pages).toBe(52)
    expect(seen.size).toBe(1300)
    expect(entries().at(-1)).toBe('a-0')
  })

  it('reads an open project’s 30 live sub-projects in two batches', async () => {
    await load((snap) => {
      snap.projects = snap.projects.filter((p) => p.parent_id !== 'plan')
      for (let i = 0; i < 30; i++)
        snap.projects.push({
          ...snap.projects[0],
          type: 'project',
          id: `s-${i}`,
          num: 100 + i,
          name: `Sub ${String(i).padStart(2, '0')}`,
          parent_id: 'plan',
          lead_id: undefined,
        })
    })
    await projects()
    await click(find('[data-project-row="plan"] button'))
    expect(subNames('plan')).toHaveLength(25)
    await scrollToEnd()
    expect(subNames('plan')).toHaveLength(30)
    expect(has('[data-subprojects-end]')).toBe(false)
  })

  it('reads an archived entry’s 40 archived sub-projects in two batches', async () => {
    await load((snap) => {
      for (let i = 0; i < 38; i++)
        snap.projects.push({
          ...snap.projects[9],
          id: `c-${i}`,
          num: 100 + i,
          name: `Chip ${String(i).padStart(2, '0')}`,
        })
    })
    await archived()
    await click(find('[data-archived-subs-toggle="old"]'))
    expect(chips()).toHaveLength(25)
    await click(find('[data-archived-subs-more]'))
    expect(chips()).toHaveLength(40)
    expect(await hintOf(find('[data-restore-project="old"]'))).toBe(
      'Restore “Old platform” and the sub-projects archived with it',
    )
  })
})

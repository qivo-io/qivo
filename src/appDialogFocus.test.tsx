// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { CONFIRM_IGNORE_MS } from './lib/useConfirmArm'
import { answerMilestones, isMilestoneRead } from './store/milestoneStandIn.setup'
import { answerOverview } from './store/overviewStandIn.setup'
import { plannerFixture, type Snapshot } from './store/plannerFixture.setup'
import {
  answerProjectNav,
  isProjectNavRead,
  queryProjectNav,
} from './store/projectNavStandIn.setup'
import { isProjectListRead, projectListsServer } from './store/projectSettingsListsStandIn.setup'
import { isProjectSettingsRead, projectSettingsServer } from './store/projectSettingsStandIn.setup'
import { answerRoadmap } from './store/roadmapStandIn.setup'

/* Where focus goes as App's New sub-project and Milestones dialogs close,
   on App and the real store. The Planner leads Plan. New sub-project opens
   from buttons that leave once the new sub-project shows, and from menu
   rows that leave with their menu; the server holds the create until the
   test answers it, and App then moves into the new sub-project, and makes
   its starter task, only once the server confirms that its creator sees
   it (P.resolveProject). The sidebar's tree lists the server's navigation reads, which take in an
   accepted create and answer again before the create answers, as Convex
   does, so the tree shows the new project only with the save, or only
   once the test answers the reads it holds. Milestones opens on a
   milestone that it then deletes. A store that boots without the tasks,
   as the app does, asks for every task only for a create with a starter
   task. */

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

const AT = '2026-09-14T08:00:00.000Z'

let container: HTMLDivElement
let root: Root
// answers the held projects.create, or refuses it
let saved: () => void
let refused: () => void
// every write App sent, by name and arguments
let sent: { name: string; args: Record<string, unknown> }[]
/** A subscription of a navigation read, open until App drops it. */
type NavRead = {
  name: string
  args: unknown
  next: (value: unknown) => void
  fail: (error: unknown) => void
  open: boolean
}
// the navigation reads' subscriptions, which a create answers again, and
// whether they wait for the test to answer them, both a new one and the
// answers a create would send; a test sets it before boot to hold the
// first answers
let navReads: NavRead[]
let holdNav: boolean
// what the server holds
let server: Snapshot

beforeEach(() => {
  holdNav = false
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.getAnimations = () => []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  phone(false)
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Lays the app out for a phone, or for a desktop. */
function phone(on: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: on, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
}

/** Lays the app out for a phone, or for a desktop, as phone does, and
    answers what crosses the breakpoint while App runs. */
function crossable(on: boolean) {
  const list = Object.assign(new EventTarget(), { matches: on, media: '(max-width: 760px)' })
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => list),
  )
  return async (next: boolean) => {
    list.matches = next
    await act(async () => list.dispatchEvent(new Event('change')))
    await settle()
  }
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
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}
/** The button named `name` by its text or label, outside hidden views. */
const named = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) =>
      (b.textContent?.trim() === name || b.getAttribute('aria-label') === name) &&
      !b.closest('[data-hidden-view]'),
  )
const find = (name: string, scope?: ParentNode) => waitFor(() => named(name, scope), name)
/** Focuses and presses `button`, as a keyboard user would. */
async function press(button: HTMLElement) {
  button.focus()
  await act(async () => button.click())
  await settle()
}

/** Whether the Roadmap read's `args` name My view or a project `snap`
    holds. */
const knownScope = (snap: Snapshot, args: unknown) => {
  const { scope } = args as { scope: { kind: string; project_id?: string } }
  return scope.kind === 'mine' || snap.projects.some((p) => p.id === scope.project_id)
}

/** Boots App on Plan, with what `prepare` adds; `held` changes the
    workspace App holds, so it differs from the server's. */
async function boot(
  prepare: (snap: Snapshot) => void = () => {},
  held: (copy: Snapshot) => void = () => {},
) {
  vi.resetModules()
  const snap = plannerFixture()
  server = snap
  const base = snap.projects[0]
  snap.projects = [
    { ...base, id: 'plan', type: 'meta', key: 'PLAN', name: 'Plan', lead_id: snap.profiles[0].id },
  ]
  // a desktop case that names no page opens Plan by its address, so it
  // does not depend on startup's check of a remembered project
  // (startupSelection.test.tsx); a phone at the bare address opens the Inbox
  if (location.pathname === '/' && !matchMedia('(max-width: 760px)').matches)
    history.replaceState(null, '', '/app/testbed/overview/p/1')
  prepare(snap)
  /* The workspace is delivered once, and again only as a milestone's
     delete changes it (projects.removeMilestone, or roadmap.change during
     a Roadmap visit) or a project's create is accepted, before the write
     answers, as Convex delivers a write, with the navigation reads that
     list the new project; any other write's paint is the only copy of what
     it changed.
     The Overview's reads answer from it until the first write: an answer
     after one would be a transition the store takes for a delivery that
     holds the write, which this double does not send, and the paint would
     end. The Milestones window's read of the milestone it opens on
     (milestones.get) answers from it at any time, so a window opened after
     a delete reads its milestone; that transition is a delivery that holds
     the delete, which the workspace delivered already. */
  let wrote = false
  let creating = false
  // Settings › Projects reads the server's lists, which hold Plan, and New
  // sub-project checks its parent on the server (projectSettings.get)
  const lists = projectListsServer(() => snap)
  const settings = projectSettingsServer(() => snap)
  navReads = []
  let publish: ((value: Snapshot) => void) | null = null
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (isProjectListRead(name)) return lists.watch(name, args, next, fail)
    if (isProjectSettingsRead(name)) return settings.watch(name, args, next, fail)
    // the All projects directory and the sidebar's tree list the server's
    // navigation reads
    if (isProjectNavRead(name)) {
      const read = { name, args, next, fail, open: true }
      navReads.push(read)
      if (!holdNav) answerProjectNav(snap, name, args, next, fail)
      return () => {
        read.open = false
      }
    }
    if (name === 'workspace:whole') {
      publish = (value) => {
        const copy = structuredClone(value)
        held(copy)
        next(copy)
      }
      publish(snap)
    } else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name.startsWith('overview:') && !wrote) answerOverview(snap, name, args, next, fail)
    // the milestone reads answer at any time but while a project create
    // waits, which this double never commits: the section reads of the
    // Overview App moves into would end that create's paint
    else if (isMilestoneRead(name) && (!creating || name === 'milestones:get'))
      answerMilestones(snap, name, args, next, fail)
    // the Roadmap's reads answer whenever they subscribe, for a project the
    // server holds: a milestone's write paints the workspace's rows, which
    // their answers do not hold, and a project still being created stays on
    // its way, as this double never commits it
    else if (
      (name === 'tasks:roadmap' || name === 'tasks:roadmapDependencies') &&
      knownScope(snap, args)
    )
      next(answerRoadmap(snap, name, args))
    return () => {}
  })
  // a one-shot navigation read, such as App's check that the creator sees
  // a new sub-project (P.resolveProject), answers from the server
  network.query.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    return isProjectNavRead(name) ? queryProjectNav(snap, name, args) : Promise.resolve(null)
  })
  sent = []
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    sent.push({ name, args })
    // the person's preferences, such as the project App remembers, paint
    // nothing and hold no write a delivery would take
    if (name !== 'identity:claimMySeats' && name !== 'prefs:save') wrote = true
    // a delete from the window, or from it during a Roadmap visit
    const operations = (args.operations ?? []) as { kind: string; id: string }[]
    const removed =
      name === 'projects:removeMilestone'
        ? [args.id]
        : operations.filter((o) => o.kind === 'milestone_remove').map((o) => o.id)
    if (removed.length) {
      snap.milestones = snap.milestones.filter((m) => !removed.includes(m.id))
      publish?.(snap)
    }
    if (name === 'projects:create') creating = true
    if (name === 'projects:create')
      return new Promise((resolve, reject) => {
        saved = () => {
          // the server stores the project and delivers the workspace and
          // the navigation reads that hold it before the create answers,
          // the reads only while the test does not hold them
          snap.projects.push({
            ...snap.projects[0],
            id: String(args.id),
            type: args.type as 'meta' | 'project',
            parent_id: (args.parent_id as string | null) ?? undefined,
            key: 'DOCS',
            num: 2,
            name: String(args.name),
            lead_id: (args.lead_id as string | null) ?? undefined,
          })
          publish?.(snap)
          lists.rerun()
          settings.rerun()
          for (const read of navReads)
            if (read.open && !holdNav)
              answerProjectNav(snap, read.name as never, read.args, read.next, read.fail)
          resolve({ num: 2, key: 'DOCS' })
        }
        refused = () => reject(new ConvexError({ message: 'Qivo cannot save changes right now.' }))
      })
    // a starter task's create answers with its number, as the server's does
    if (name === 'issues:create') return Promise.resolve({ num: 1 })
    return Promise.resolve(null)
  })
  const store = await import('./store/planner')
  await store.initStore()
  // App's views load their code only while the socket counts as connected
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
}

/** Opens Plan from the phone's Projects page, in `view`. */
async function openOnPhone(view: string) {
  await press(await find('Projects'))
  await press(
    await waitFor(() => document.querySelector<HTMLElement>('.mobile-project-open'), 'Plan'),
  )
  await press(await find(view))
}

/** Names the new project or sub-project Docs in the open dialog and
    creates it with `submit`, once the dialog turns it on (New
    sub-project's parent check answered), or cancels it. */
async function finish(create: boolean, submit = 'Create sub-project') {
  const name = await waitFor(
    () => document.querySelector<HTMLInputElement>('[data-modal-shell] input[aria-label="Name"]'),
    'the Name field',
  )
  if (create)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'Docs')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
  const shell = await waitFor(() => document.querySelector('[data-modal-shell]'), 'the dialog')
  const action = create
    ? await waitFor(() => {
        const found = named(submit, shell)
        return found && !found.disabled ? found : null
      }, `${submit} turned on`)
    : await find('Cancel', shell)
  await press(action)
  expect(document.querySelector('[data-modal-shell]')).toBeNull()
}
/** Answers the create, after which App moves into the new sub-project. */
async function save() {
  await act(async () => saved())
  await settle()
}

describe('New sub-project', { timeout: 30_000 }, () => {
  /** The new sub-project's row in the sidebar's tree, named Docs. */
  const treeRow = () =>
    [...document.querySelectorAll<HTMLElement>('aside [data-subproject-row] > button')].find(
      (button) => button.textContent === 'Docs',
    )

  it.each([
    ["the sidebar's Add sub-project", async () => find('Add sub-project')],
    [
      "the Roadmap's empty state",
      async () => {
        await press(await find('Roadmap'))
        return find('New sub-project', document.querySelector('main') ?? document)
      },
    ],
  ])(
    "gives focus to the new sub-project's sidebar row once the server's list holds it, after a create from %s",
    async (where, opener) => {
      await boot()
      const button = await opener()
      await press(button)
      await finish(true)
      // the tree shows the sub-project only once the server's list holds
      // it, so the dialog gave focus back to its opener, where it stays
      expect(treeRow()).toBeUndefined()
      if (where === "the sidebar's Add sub-project") expect(document.activeElement).toBe(button)
      await save()
      const row = await waitFor(treeRow, "Docs's row")
      // App moved into the saved sub-project, and its row took focus
      expect(row.getAttribute('aria-current')).toBe('page')
      expect(document.activeElement).toBe(row)
    },
  )

  it('keeps focus on Add sub-project when the server refuses the sub-project', async () => {
    await boot()
    const add = await find('Add sub-project')
    await press(add)
    await finish(true)
    expect(document.activeElement).toBe(add)
    await act(async () => refused())
    await settle()
    // the tree never showed the refused sub-project, and focus stays on
    // its opener, which the refusal leaves in place
    expect(treeRow()).toBeUndefined()
    expect(add.isConnected).toBe(true)
    expect(document.activeElement).toBe(add)
  })

  it("gives focus to the phone header's New task after a create from the Roadmap", async () => {
    phone(true)
    await boot()
    // the Roadmap of a project without sub-projects shows its empty note
    await openOnPhone('Roadmap')
    await press(await find('New sub-project', document.querySelector('main') ?? document))
    await finish(true)
    const add = await waitFor(
      () => document.querySelector<HTMLElement>('[data-mobile-new-task]'),
      'New task',
    )
    expect(document.activeElement).toBe(add)
    // the header stays as App moves into the saved sub-project
    await save()
    expect(document.activeElement).toBe(add)
  })

  it("gives focus to the new sub-project's row in Settings › Projects after a create from its Add sub-project", async () => {
    history.replaceState(null, '', '/app/testbed/settings/projects')
    await boot()
    await press(
      await find(
        'Plan',
        await waitFor(() => document.querySelector('[data-settings-projects]'), 'the list'),
      ),
    )
    await press(await find('Add sub-project'))
    await finish(true)
    // the row shows once the create answers, never before, as the store
    // paints nothing
    expect(document.querySelector('[data-subproject-row]')).toBeNull()
    await save()
    const row = await waitFor(
      () => document.querySelector<HTMLElement>('[data-subproject-row] button'),
      'the new row',
    )
    expect(row.textContent).toBe('Docs')
    expect(document.activeElement).toBe(row)
  })

  it("stays in Settings › Projects after a create from a row's menu there, painting nothing before the create answers", async () => {
    history.replaceState(null, '', '/app/testbed/settings/projects')
    // the server holds Ops, which the person leads, and the store holds no
    // project, so no parent is the workspace's
    await boot((snap) =>
      snap.projects.push({ ...snap.projects[0], id: 'ops', key: 'OPS', num: 3, name: 'Ops' }),
    )
    const row = await waitFor(
      () => document.querySelector('[data-settings-projects] [data-project-row="ops"]'),
      "Ops's row",
    )
    await press(await find('Project actions', row))
    const menu = await waitFor(
      () => document.querySelector('[data-slot="popover-content"]'),
      'the menu',
    )
    await press(await find('New sub-project…', menu))
    await waitFor(() => document.querySelector('[data-new-subproject-parent="ops"]'), 'the check')
    // the parent's check says the person edits Ops, so the starter task is
    // offered
    expect(document.querySelector('#subproject-starter')).not.toBeNull()
    await finish(true)
    const create = sent.find((w) => w.name === 'projects:create')
    expect(create?.args).toMatchObject({ type: 'project', parent_id: 'ops', name: 'Docs' })
    expect(create?.args).not.toHaveProperty('sort_order')
    // nothing paints as the create goes
    const id = String(create?.args.id)
    const { P } = await import('./store/planner')
    expect(P.project(id)).toBeUndefined()
    expect(document.querySelector(`[data-subproject-row="${id}"]`)).toBeNull()
    const saves = vi.spyOn(P, 'saveUINow')
    await save()
    expect(document.body.textContent).toContain('Sub-project “Docs” created')
    // App stays in Settings › Projects and never remembers the sub-project,
    // and its starter task goes to Docs once the server's read by id
    // showed the creator Docs with Edit
    expect(document.querySelector('[data-settings-projects]')).not.toBeNull()
    expect(location.pathname).toBe('/app/testbed/settings/projects')
    expect(saves.mock.calls.some(([patch]) => patch.lastProject?.project_id === id)).toBe(false)
    await waitFor(() => sent.find((w) => w.name === 'issues:create'), 'the starter task')
    expect(sent.find((w) => w.name === 'issues:create')?.args).toMatchObject({ project_id: id })
  })

  /* The Planner, an organization admin, creates Docs, led by Leo, under
     Ops from Settings › Projects. Leo leads Ops, and the Planner holds User
     on its sub-project Bench alone, so the workspace holds Ops for
     navigation and the Planner manages it as an admin. Ops' parent check
     (projectSettings.get) stopped before it knew their level, as past a
     read bound, and answers level and accessible null to a manager, so the
     dialog cannot tell whether they will see Docs: it warns of nothing and
     offers no starter task, as an unknown level gives no Edit. So only
     App's check that the creator sees it, one projectNav.byIds read of it
     (P.projectsByIds), keeps App from opening it. `resolve` answers that
     check from the navigation stand-in, which leaves Docs out as the
     Planner holds no level on it, or fails it. She opens Settings from Plan's Overview, so App
     shows and remembers Plan beneath it. Answers the way out of Settings,
     which checks that Plan shows again as it did, since App writes no
     preference while Settings shows and a move into Docs there would show
     only once she leaves. */
  async function createUnderOps(resolve: 'answered' | 'failed') {
    await boot((snap) => {
      const me = snap.profiles[0]
      snap.profiles.push({
        ...me,
        id: 'leo',
        auth_user_id: 'leo-account',
        name: 'Leo',
        initials: 'LE',
        org_role: 'user',
      })
      snap.projects.push(
        { ...snap.projects[0], id: 'ops', key: 'OPS', num: 3, name: 'Ops', lead_id: 'leo' },
        {
          ...snap.projects[0],
          id: 'bench',
          type: 'project',
          parent_id: 'ops',
          key: 'BEN',
          num: 4,
          name: 'Bench',
          lead_id: undefined,
        },
      )
      snap.access.push({ project_id: 'bench', profile_id: me.id, level: 'user' })
    })
    const { P } = await import('./store/planner')
    // Plan's Overview shows at its address, with Plan's row lit in the
    // sidebar, and App remembers Plan
    const planRow = () => document.querySelector('aside [data-project-row="plan"] > button')
    await waitFor(
      () =>
        document.querySelector('[data-workspace-view="overview"]') &&
        planRow()?.getAttribute('aria-current') === 'page',
      "Plan's Overview",
    )
    expect(location.pathname).toBe('/app/testbed/overview/p/1')
    expect(P.loadUI().lastProject?.project_id).toBe('plan')
    const watch = network.onUpdate.getMockImplementation()
    network.onUpdate.mockImplementation((ref, args, next, fail) =>
      getFunctionName(ref) === 'projectSettings:get' && (args as { id: string }).id === 'ops'
        ? watch?.(
            ref,
            args,
            (value: { state: string }) =>
              next(value.state === 'ok' ? { ...value, level: null, accessible: null } : value),
            fail,
          )
        : watch?.(ref, args, next, fail),
    )
    // the Lead picker's one-shot read (projectSettings.leadCandidates)
    // answers from the stand-in too
    const reads = projectSettingsServer(() => server)
    const ask = network.query.getMockImplementation()
    network.query.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (resolve === 'failed' && name === 'projectNav:byIds')
        return Promise.reject(new Error('the navigation read failed'))
      return isProjectSettingsRead(name) ? reads.query(name, args) : ask?.(ref, args)
    })
    // Settings › Projects, from the rail
    await press(await find('Settings'))
    await press(
      await waitFor(
        () => document.querySelector<HTMLElement>('[data-settings-item="projects"]'),
        'Projects',
      ),
    )
    const row = await waitFor(
      () => document.querySelector('[data-settings-projects] [data-project-row="ops"]'),
      "Ops's row",
    )
    await press(await find('Project actions', row))
    const menu = await waitFor(
      () => document.querySelector('[data-slot="popover-content"]'),
      'the menu',
    )
    await press(await find('New sub-project…', menu))
    await waitFor(() => document.querySelector('[data-new-subproject-parent="ops"]'), 'the check')
    await press(
      await waitFor(
        () => document.querySelector<HTMLElement>('[data-project-lead-picker]'),
        'the Lead picker',
      ),
    )
    await press(
      await waitFor(
        () => document.querySelector<HTMLElement>('[data-lead-choice="leo"]'),
        "Leo's choice",
      ),
    )
    // an unknown sight warns of nothing, and an unknown level offers no
    // starter task
    const shell = await waitFor(() => document.querySelector('[data-modal-shell]'), 'the dialog')
    expect(shell.textContent).not.toContain("You won't see this sub-project.")
    expect(document.querySelector('#subproject-starter')).toBeNull()
    await finish(true)
    const create = sent.find((w) => w.name === 'projects:create')
    expect(create?.args).toMatchObject({ parent_id: 'ops', lead_id: 'leo', name: 'Docs' })
    const id = String(create?.args.id)
    const saves = vi.spyOn(P, 'saveUINow')
    await save()
    // App asked the server whether the creator sees Docs, by one read of
    // its id
    expect(
      network.query.mock.calls.some(
        ([ref, args]) =>
          getFunctionName(ref) === 'projectNav:byIds' &&
          (args as { ids?: string[] }).ids?.includes(id),
      ),
    ).toBe(true)
    // it stays in Settings › Projects and makes no starter task
    expect(document.querySelector('[data-settings-projects]')).not.toBeNull()
    expect(sent.some((w) => w.name.startsWith('issues:'))).toBe(false)
    return async () => {
      await press(await find('Back'))
      // Plan is still the scope and its Overview shows at its address, with
      // no lost-project note or chooser from the access guard
      expect(document.querySelector('[data-settings-projects]')).toBeNull()
      expect(location.pathname).toBe('/app/testbed/overview/p/1')
      expect(
        document.querySelector('[data-workspace-view]')?.getAttribute('data-workspace-view'),
      ).toBe('overview')
      expect(planRow()?.getAttribute('aria-current')).toBe('page')
      expect(document.querySelector('[data-project-chooser]')).toBeNull()
      expect(document.body.textContent).not.toContain('is no longer available to you.')
      // App never remembered Docs, under Settings or after it, and still
      // remembers Plan
      expect(saves.mock.calls.some(([patch]) => patch.lastProject?.project_id === id)).toBe(false)
      expect(P.loadUI().lastProject?.project_id).toBe('plan')
    }
  }

  it("says the creator can't see a sub-project the server does not show them, without opening it or making its starter task", async () => {
    const leave = await createUnderOps('answered')
    expect(document.body.textContent).toContain(
      "Sub-project “Docs” created. You don't have access to it.",
    )
    await leave()
  })

  it('stays put with the plain toast when the check that the creator sees the sub-project fails', async () => {
    const leave = await createUnderOps('failed')
    expect(document.body.textContent).toContain('Sub-project “Docs” created')
    expect(document.body.textContent).not.toContain("You don't have access to it.")
    await leave()
  })

  /* The Planner, an organization admin with a Viewer grant on Ops, which
     Leo leads, creates Docs led by Leo under it from Settings › Projects.
     Docs inherits Viewer, so she sees it and may add no task there, which
     the server's task create refuses. `level` 'user' has Ops' parent check
     answer User, as a check that knew more than the workspace would, so
     the dialog offers the starter task and only App's own check of Edit
     (P.canWrite) keeps the task from being sent. Answers whether the
     dialog offered the starter task. */
  async function createAsViewer(level: 'answered' | 'user') {
    history.replaceState(null, '', '/app/testbed/settings/projects')
    await boot((snap) => {
      const me = snap.profiles[0]
      snap.profiles.push({
        ...me,
        id: 'leo',
        auth_user_id: 'leo-account',
        name: 'Leo',
        initials: 'LE',
        org_role: 'user',
      })
      snap.projects.push({
        ...snap.projects[0],
        id: 'ops',
        key: 'OPS',
        num: 3,
        name: 'Ops',
        lead_id: 'leo',
      })
      snap.access.push({ project_id: 'ops', profile_id: me.id, level: 'viewer' })
    })
    if (level === 'user') {
      const watch = network.onUpdate.getMockImplementation()
      network.onUpdate.mockImplementation((ref, args, next, fail) =>
        getFunctionName(ref) === 'projectSettings:get' && (args as { id: string }).id === 'ops'
          ? watch?.(
              ref,
              args,
              (value: { state: string }) =>
                next(value.state === 'ok' ? { ...value, level: 'user', accessible: true } : value),
              fail,
            )
          : watch?.(ref, args, next, fail),
      )
    }
    // the Lead picker's one-shot read (projectSettings.leadCandidates)
    // answers from the stand-in too
    const reads = projectSettingsServer(() => server)
    const ask = network.query.getMockImplementation()
    network.query.mockImplementation((ref, args) =>
      isProjectSettingsRead(getFunctionName(ref))
        ? reads.query(getFunctionName(ref), args)
        : ask?.(ref, args),
    )
    const row = await waitFor(
      () => document.querySelector('[data-settings-projects] [data-project-row="ops"]'),
      "Ops's row",
    )
    await press(await find('Project actions', row))
    const menu = await waitFor(
      () => document.querySelector('[data-slot="popover-content"]'),
      'the menu',
    )
    await press(await find('New sub-project…', menu))
    await waitFor(() => document.querySelector('[data-new-subproject-parent="ops"]'), 'the check')
    await press(
      await waitFor(
        () => document.querySelector<HTMLElement>('[data-project-lead-picker]'),
        'the Lead picker',
      ),
    )
    await press(
      await waitFor(
        () => document.querySelector<HTMLElement>('[data-lead-choice="leo"]'),
        "Leo's choice",
      ),
    )
    // she will see Docs, as a Viewer
    const shell = await waitFor(() => document.querySelector('[data-modal-shell]'), 'the dialog')
    expect(shell.textContent).not.toContain("You won't see this sub-project.")
    const offered = document.querySelector<HTMLInputElement>('#subproject-starter')?.checked
    await finish(true)
    const create = sent.find((w) => w.name === 'projects:create')
    expect(create?.args).toMatchObject({ parent_id: 'ops', lead_id: 'leo', name: 'Docs' })
    await save()
    // App confirmed that she sees Docs, said so with the plain toast and
    // sent no task
    expect(document.body.textContent).toContain('Sub-project “Docs” created')
    expect(document.body.textContent).not.toContain("You don't have access to it.")
    expect(sent.some((w) => w.name.startsWith('issues:'))).toBe(false)
    return offered === true
  }

  it('offers no starter task to an admin who views the parent and names another lead, and sends none', async () => {
    expect(await createAsViewer('answered')).toBe(false)
  })

  it('sends no starter task where the workspace gives the creator no Edit, also when the dialog offered it', async () => {
    expect(await createAsViewer('user')).toBe(true)
  })

  it.each([
    ['sidebar', 'Create', '', 'Project actions', 'New sub-project…'],
    ['sidebar', 'Cancel', '', 'Project actions', 'New sub-project…'],
    ['phone header', 'Create', '', 'Project actions', 'New sub-project'],
    ['phone header', 'Cancel', '', 'Project actions', 'New sub-project'],
    ['Settings › Projects', 'Create', 'settings/projects', 'Project actions', 'New sub-project…'],
    ['Projects page', 'Create', 'projects', 'Plan actions', 'New sub-project…'],
  ])(
    "gives focus back to the %s menu's button after %s",
    async (where, choice, path, label, item) => {
      phone(where === 'phone header')
      if (path) history.replaceState(null, '', `/app/testbed/${path}`)
      await boot()
      if (where === 'phone header') await openOnPhone('Overview')
      const trigger = await find(label)
      // the second time, the dialog's code is loaded and it opens at once
      for (const create of [false, choice === 'Create']) {
        await press(trigger)
        const menu = await waitFor(
          () => document.querySelector('[data-slot="popover-content"]'),
          'the menu',
        )
        await press(await find(item, menu))
        await finish(create)
      }
      expect(document.activeElement).toBe(trigger)
    },
  )
})

describe("New sub-project's starter task under tasks on demand", { timeout: 30_000 }, () => {
  beforeEach(async () => {
    const { TASKS } = await import('./store/liveParts')
    TASKS.atBoot = false
  })

  // the starter task paints the new sub-project's views and asks for no
  // task, as every create does (store/planner.ts P.addIssue)
  it.each<[string, boolean, string[]]>([
    ['with', true, []],
    ['without', false, []],
  ])('asks for no task for a create %s a starter task', async (_, starter, asks) => {
    await boot()
    const { __layerProbe } = await import('./store/planner')
    // the boot asks for no task, as the app's does on a project
    expect(__layerProbe?.asks()).toEqual([])
    await press(await find('Add sub-project'))
    const box = await waitFor(
      () => document.querySelector<HTMLInputElement>('#subproject-starter'),
      'Create a starter task',
    )
    if (!starter) await press(box)
    expect(box.checked).toBe(starter)
    await finish(true)
    await save()
    expect(sent.some((w) => w.name === 'issues:create')).toBe(starter)
    expect(__layerProbe?.asks()).toEqual(asks)
    expect(__layerProbe?.faults()).toEqual([])
  })
})

describe('a project saved from the Projects page', { timeout: 30_000 }, () => {
  // the new project's or sub-project's row in the sidebar, named Docs
  const sidebarRow = (kind: string) =>
    [...document.querySelectorAll<HTMLElement>(`aside [${kind}] button`)].find(
      (button) => button.textContent === 'Docs',
    )
  const header = (hook: string) => document.querySelector<HTMLElement>(`[${hook}]`)
  /** 25 top-level projects the Planner leads, Alpha 00 to Alpha 24, which
      sort before Docs and fill the tree's first batch. They come first in
      the workspace, so the boot's scope is one of them and the tree reads
      no further batch before the create. */
  const alphas = (snap: Snapshot) => {
    const plan = snap.projects[0]
    snap.projects.unshift(
      ...Array.from({ length: 25 }, (_, i) => ({
        ...plan,
        id: `alpha-${i}`,
        key: `A${i}`,
        num: 10 + i,
        name: `Alpha ${String(i).padStart(2, '0')}`,
      })),
    )
  }
  it.each([
    ['desktop', 'New project', '', () => sidebarRow('data-project-row')],
    [
      'desktop',
      'New project',
      ", a project the tree's first batch does not reach",
      () => sidebarRow('data-project-row'),
      alphas,
    ],
    ['phone', 'New project', '', () => header('data-mobile-project-actions')],
    ['desktop', "a menu's New sub-project", '', () => sidebarRow('data-subproject-row')],
  ])(
    "on a %s, gives focus to the project's own control once App has moved into it from %s%s",
    (layout, opener, past, target, prepare?: (snap: Snapshot) => void) =>
      savedProjectFocus(layout, opener, past, target, prepare),
  )
  // KNOWN DEFECT: on the app's boot the phone header shows New task for the
  // new sub-project only once the project cache answers for it (P.canWrite),
  // after App moved focus to Project actions. It held before only because
  // the held arm knew the sub-project's access at once.
  it.fails("on a phone, gives focus to the project's own control once App has moved into it from a menu's New sub-project", () =>
    savedProjectFocus('phone', "a menu's New sub-project", '', () =>
      header('data-mobile-new-task'),
    ))
  /* Saves a project or sub-project from the Projects page on `layout` with
     `opener`, and checks focus lands on `target` once App moved into it. */
  async function savedProjectFocus(
    layout: string,
    opener: string,
    _past: string,
    target: () => HTMLElement | null | undefined,
    prepare?: (snap: Snapshot) => void,
  ) {
    {
      phone(layout === 'phone')
      history.replaceState(null, '', '/app/testbed/projects')
      // the boot's scope is the workspace's first project, not one an
      // earlier case saved
      localStorage.clear()
      await boot(prepare)
      if (prepare) {
        // the tree's first batch holds the 25 Alpha projects and not Plan,
        // which sorts after them, as Docs will
        await waitFor(
          () => document.querySelectorAll('aside [data-project-row]').length === 25,
          "the tree's first batch",
        )
        expect(document.querySelector('aside [data-project-row="plan"]')).toBeNull()
      }
      const page = await waitFor(
        () => document.querySelector('.mobile-project-directory'),
        'the page',
      )
      let held: HTMLElement
      if (opener === 'New project') {
        held = await waitFor(
          () => page.querySelector<HTMLElement>('[data-new-project]'),
          'New project',
        )
        await press(held)
        await finish(true, 'Create project')
      } else {
        held = await find('Plan actions', page)
        await press(held)
        const menu = await waitFor(
          () => document.querySelector('[data-slot="popover-content"]'),
          'the menu',
        )
        // the item comes once the project's settings answer
        await press(await find('New sub-project…', menu))
        await finish(true)
      }
      // the dialog gives focus back to its opener on the page
      expect(document.activeElement).toBe(held)
      // which hides as App moves into the saved project
      await save()
      expect(held.closest('[data-hidden-view]')).not.toBeNull()
      // a project past the tree's first batch shows once the scope rule
      // has read the second, a commit after the move, where the tree's
      // focus request gives its row focus
      const own = prepare ? await waitFor(target, "Docs's row") : target()
      expect(own).toBeTruthy()
      expect(own?.closest('[data-hidden-view]')).toBeNull()
      expect(document.activeElement).toBe(own)
    }
  }
})

describe('Milestones', { timeout: 30_000 }, () => {
  /** Plan with its sub-project Work, a task in it, and milestones Alpha
      and Beta. */
  const plan = (snap: Snapshot) => {
    const base = snap.projects[0]
    snap.projects.push({
      ...base,
      id: 'work',
      type: 'project',
      key: 'WORK',
      num: 2,
      name: 'Work',
      parent_id: 'plan',
    })
    snap.issues.push({
      id: 't1',
      org_id: snap.orgs[0].id,
      project_id: 'work',
      num: 1,
      title: 'Ship it',
      description: '',
      status: 'todo',
      priority: 'low',
      paused: false,
      created_at: AT,
      updated_at: AT,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    // a past one and one of this week, whatever the day the test runs on
    snap.milestones.push(
      { id: 'alpha', project_id: 'plan', name: 'Alpha', week: mondayIn(-4), created_at: AT },
      { id: 'beta', project_id: 'plan', name: 'Beta', week: mondayIn(0), created_at: AT },
    )
  }
  /** The Monday `weeks` weeks after this week's, as a milestone's week. */
  function mondayIn(weeks: number) {
    const day = new Date()
    day.setDate(day.getDate() + 7 * weeks - ((day.getDay() + 6) % 7))
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
  }
  /** Opens the window from `row` and deletes its milestone there, then
      closes it with Done. A Roadmap flag opens on Enter, as it is a drag
      handle that a click does not open. */
  async function deleteFrom(row: HTMLElement) {
    if (row.hasAttribute('data-msflag')) {
      row.focus()
      await act(async () => {
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      await settle()
    } else await press(row)
    // the window reads its milestone, and shows its editor once it answers
    await waitFor(
      () => document.querySelector('[data-milestone-window][data-milestone-open-state="ok"]'),
      "the window's answer",
    )
    const del = await find(
      'Delete',
      await waitFor(() => document.querySelector('[data-milestone-editor]'), 'the editor'),
    )
    await press(del)
    vi.setSystemTime(Date.now() + CONFIRM_IGNORE_MS)
    await press(del)
    const shell = await waitFor(() => document.querySelector('[data-modal-shell]'), 'the window')
    await press(await find('Done', shell))
    expect(document.querySelector('[data-modal-shell]')).toBeNull()
  }

  it.each([
    ['Overview', false, 'data-overview-milestone', 'New milestone'],
    ['phone agenda', true, 'data-agenda-milestone', 'New milestone'],
    ['Roadmap flag', false, 'data-msflag', 'Milestone'],
    ['phone timeline flag', true, 'data-msflag', 'Filters & planning'],
  ])(
    'gives focus to the next row, else the previous one, else New milestone, after the %s deleted its milestone',
    async (where, onPhone, attr, add) => {
      phone(onPhone)
      await boot((snap) => {
        plan(snap)
        // the Roadmap's flags show the weeks of its window, from this one
        // on, and the Overview's and the agenda's Upcoming the weeks from
        // this one on, as a collapsed Past shows no row
        snap.milestones.forEach((m, n) => {
          m.week = mondayIn(n + 1)
        })
      })
      if (onPhone) await openOnPhone('Roadmap')
      if (where === 'Roadmap flag') await press(await find('Roadmap'))
      if (where === 'phone timeline flag') await press(await find('Timeline & team'))
      vi.useFakeTimers({ toFake: ['Date'] })
      const row = (id: string) =>
        waitFor(() => document.querySelector<HTMLElement>(`[${attr}="${id}"]`), id)
      await deleteFrom(await row('alpha'))
      expect(document.activeElement).toBe(await row('beta'))
      await deleteFrom(await row('beta'))
      expect(document.querySelector(`[${attr}]`)).toBeNull()
      // the Roadmap's toolbar sits above main, and the phone timeline folds
      // it into a closed Filters & planning, whose summary takes focus
      if (where === 'phone timeline flag') expect(document.activeElement?.textContent).toBe(add)
      else {
        const scope = where === 'Roadmap flag' ? document : document.querySelector('main')
        expect(document.activeElement).toBe(await find(add, scope ?? document))
      }
    },
  )

  it("gives focus to the next flag on My view's row, else the previous one, else the filter field, after the flag deleted its milestone", async () => {
    // My view, where Plan's task is the person's, so Plan has a row
    history.replaceState(null, '', '/app/~/roadmap/mine')
    await boot((snap) => {
      plan(snap)
      snap.issues[0].assignee_id = snap.profiles[0].id
      snap.milestones.forEach((m, n) => {
        m.week = mondayIn(n + 1)
      })
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    const row = (id: string) =>
      waitFor(
        () => document.querySelector<HTMLElement>(`[data-track="plan"] [data-msflag="${id}"]`),
        id,
      )
    await deleteFrom(await row('alpha'))
    expect(document.activeElement).toBe(await row('beta'))
    await deleteFrom(await row('beta'))
    expect(document.querySelector('[data-msflag]')).toBeNull()
    // My view's toolbar has no Milestone, so its filter field takes focus
    expect(named('Milestone')).toBeUndefined()
    const field = document.querySelector('[data-roadmap-toolbar] [data-filter-group] input')
    expect(field).not.toBeNull()
    expect(document.activeElement).toBe(field)
  })

  it.each([
    ['Overview', false, 'overview', 'data-overview-milestone', '[data-overview-milestones]'],
    ['phone agenda', true, 'roadmap', 'data-agenda-milestone', '[data-agenda-milestones]'],
  ])(
    "gives focus to Upcoming's empty line once the %s row in My view deleted the last milestone",
    async (_, onPhone, view, attr, root) => {
      phone(onPhone)
      // My view, where Plan's task is the person's; it has no New milestone
      history.replaceState(null, '', `/app/~/${view}/mine`)
      await boot((snap) => {
        plan(snap)
        snap.issues[0].assignee_id = snap.profiles[0].id
        // in Upcoming, as a collapsed Past shows no row
        snap.milestones.forEach((m, n) => {
          m.week = mondayIn(n + 1)
        })
      })
      vi.useFakeTimers({ toFake: ['Date'] })
      const row = (id: string) =>
        waitFor(() => document.querySelector<HTMLElement>(`[${attr}="${id}"]`), id)
      await deleteFrom(await row('alpha'))
      expect(document.activeElement).toBe(await row('beta'))
      await deleteFrom(await row('beta'))
      expect(document.querySelector(`[${attr}]`)).toBeNull()
      // must fail for a fallback that leaves focus on the page's body
      const empty = await waitFor(
        () =>
          document.querySelector<HTMLElement>(
            `${root} [data-milestone-section="upcoming"] [data-milestone-note="empty"]`,
          ),
        "Upcoming's empty line",
      )
      expect(empty.textContent).toBe('No milestones in any of your projects yet.')
      expect(document.activeElement).toBe(empty)
    },
  )

  it.each([
    ['Overview', false, 'data-overview-milestone', 'New sub-project'],
    ['phone agenda', true, 'data-agenda-milestone', 'New milestone'],
  ])(
    "gives focus to the page's empty note once the %s row deleted the last milestone of a project without sub-projects",
    async (_, onPhone, attr, target) => {
      phone(onPhone)
      await boot((snap) => {
        plan(snap)
        snap.projects = snap.projects.filter((p) => p.id === 'plan')
        snap.issues = []
        // in Upcoming, as a collapsed Past shows no row
        snap.milestones.forEach((m, n) => {
          m.week = mondayIn(n + 1)
        })
      })
      if (onPhone) await openOnPhone('Roadmap')
      // the Overview's note waits for the answer that says it has no
      // sub-project, which comes before the first write
      else
        await waitFor(
          () => document.querySelector('[data-overview-root][data-overview-state="ok"]'),
          "the Overview's answer",
        )
      vi.useFakeTimers({ toFake: ['Date'] })
      const row = (id: string) =>
        waitFor(() => document.querySelector<HTMLElement>(`[${attr}="${id}"]`), id)
      await deleteFrom(await row('alpha'))
      await deleteFrom(await row('beta'))
      expect(document.querySelector(`[${attr}]`)).toBeNull()
      expect(document.activeElement).toBe(
        await find(target, document.querySelector('main') ?? document),
      )
    },
  )
})

describe("the sidebar's tree across Settings", { timeout: 30_000 }, () => {
  it('keeps its rows hidden while Settings shows, reads again on return, and takes no focus for a create made there', async () => {
    await boot()
    const row = await waitFor(
      () => document.querySelector<HTMLElement>('aside [data-project-row="plan"]'),
      "Plan's row",
    )
    const tree = () => document.querySelector<HTMLElement>('aside [data-sidebar-projects]')
    const opened = () => navReads.filter((r) => r.open)
    expect(opened().map((r) => r.name)).toEqual(['projectNav:page', 'projectNav:children'])
    // Settings › Projects, from the rail
    await press(await find('Settings'))
    await press(
      await waitFor(
        () => document.querySelector<HTMLElement>('[data-settings-item="projects"]'),
        'Projects',
      ),
    )
    const list = await waitFor(() => document.querySelector('[data-settings-projects]'), 'the list')
    // the tree stays, hidden with the workspace and out of use, its reads
    // stopped
    expect(row.isConnected).toBe(true)
    expect(row.closest('[data-hidden-view]')).not.toBeNull()
    expect(opened()).toEqual([])
    // a sub-project made there takes the focus of Settings' own new row
    await press(await find('Plan', list))
    await press(await find('Add sub-project'))
    await finish(true)
    await save()
    const made = await waitFor(
      () =>
        [
          ...document.querySelectorAll<HTMLElement>(
            '[data-settings-projects] [data-subproject-row] button',
          ),
        ].find((button) => button.textContent === 'Docs'),
      "Settings' Docs row",
    )
    expect(document.activeElement).toBe(made)
    // back in the workspace the tree shows what it held at once and reads
    // the same lists again, refreshing until they answer
    holdNav = true
    await press(await find('Back'))
    expect(document.querySelector('[data-settings-projects]')).toBeNull()
    expect(row.isConnected).toBe(true)
    expect(row.closest('[data-hidden-view]')).toBeNull()
    expect(tree()?.dataset.sidebarProjectsState).toBe('refreshing')
    // with focus nowhere as the answers come, nothing in the tree takes it
    await act(async () => (document.activeElement as HTMLElement | null)?.blur())
    await act(async () => {
      for (const read of opened())
        answerProjectNav(server, read.name as never, read.args, read.next, read.fail)
    })
    await settle()
    expect(tree()?.dataset.sidebarProjectsState).toBe('ok')
    // the create made in Settings moved App into Docs, whose row shows and
    // lights, and takes no focus
    const docs = await waitFor(
      () =>
        [...document.querySelectorAll<HTMLElement>('aside [data-subproject-row] > button')].find(
          (button) => button.textContent === 'Docs',
        ),
      "the tree's Docs row",
    )
    expect(docs.getAttribute('aria-current')).toBe('page')
    expect(document.activeElement).toBe(document.body)
  })
})

describe("the sidebar's focus request", { timeout: 30_000 }, () => {
  /** The new project's row in the sidebar's tree, named Docs. */
  const docsRow = () =>
    [...document.querySelectorAll<HTMLElement>('aside [data-project-row] > button')].find(
      (button) => button.textContent === 'Docs',
    )
  /** Makes the project Docs from the Projects page, after which App moves
      into it; `hold` keeps every navigation read unanswered, so the tree
      still loads as App asks it for Docs's row. */
  async function createDocs(hold = false) {
    history.replaceState(null, '', '/app/testbed/projects')
    localStorage.clear()
    holdNav = hold
    await boot()
    const page = await waitFor(
      () => document.querySelector('.mobile-project-directory'),
      'the page',
    )
    await press(
      await waitFor(() => page.querySelector<HTMLElement>('[data-new-project]'), 'New project'),
    )
    await finish(true, 'Create project')
    await save()
  }
  const blur = () => act(async () => (document.activeElement as HTMLElement | null)?.blur())
  /** Stops holding the navigation reads and answers the open ones from
      what the server holds, Docs among it. */
  async function release() {
    holdNav = false
    await act(async () => {
      for (const read of navReads)
        if (read.open) answerProjectNav(server, read.name as never, read.args, read.next, read.fail)
    })
    await settle()
  }

  it('is taken once, so a later commit or a tree mounted again after the phone layout moves no focus', async () => {
    const cross = crossable(false)
    await createDocs()
    const row = await waitFor(docsRow, "Docs's row")
    expect(document.activeElement).toBe(row)
    // with focus nowhere, a later commit of the tree leaves it there
    await blur()
    await act(async () => window.showToast?.('Saved'))
    await settle()
    expect(document.activeElement).toBe(document.body)
    // as does the tree the desktop mounts again after the phone's layout
    await cross(true)
    expect(document.querySelector('aside [data-sidebar-projects]')).toBeNull()
    await blur()
    await cross(false)
    const again = await waitFor(docsRow, "Docs's row again")
    await settle()
    expect(again).not.toBe(row)
    expect(again.getAttribute('aria-current')).toBe('page')
    expect(document.activeElement).toBe(document.body)
  })

  it('waits while the tree still loads, so the row takes focus once it shows', async () => {
    await createDocs(true)
    const tree = document.querySelector<HTMLElement>('aside [data-sidebar-projects]')
    expect(tree?.dataset.sidebarProjectsState).toBe('loading')
    expect(docsRow()).toBeUndefined()
    await blur()
    await release()
    const row = await waitFor(docsRow, "Docs's row")
    expect(row.getAttribute('aria-current')).toBe('page')
    expect(document.activeElement).toBe(row)
  })

  it.each([
    [
      'the rail goes to the phone and back',
      async (cross: (next: boolean) => Promise<void>) => {
        await cross(true)
        expect(document.querySelector('aside [data-sidebar-projects]')).toBeNull()
        await cross(false)
      },
    ],
    [
      'Settings opens and Back returns',
      async () => {
        await press(await find('Settings'))
        await waitFor(() => document.querySelector('.settings-navigation'), 'Settings')
        await press(await find('Back'))
        expect(document.querySelector('.settings-navigation')).toBeNull()
      },
    ],
    [
      'the scope moves to My view and Back returns to Docs',
      async () => {
        const docs = location.pathname
        await press(await find('My view'))
        const mine = () => document.querySelector('aside [data-mine-nav]')
        expect(mine()?.getAttribute('aria-current')).toBe('page')
        await act(async () => history.back())
        await waitFor(
          () => location.pathname === docs && !mine()?.hasAttribute('aria-current'),
          "Docs's address",
        )
      },
    ],
  ])('ends unseen once %s while the tree still loads, and never comes back', async (_, move) => {
    const cross = crossable(false)
    await createDocs(true)
    expect(docsRow()).toBeUndefined()
    await move(cross)
    // focus nowhere, where the tree would give it to Docs's row
    await blur()
    await release()
    const row = await waitFor(docsRow, "Docs's row")
    await settle()
    expect(row.getAttribute('aria-current')).toBe('page')
    expect(document.activeElement).toBe(document.body)
  })

  it('is not made on the phone, so the tree the desktop mounts later moves no focus', async () => {
    const cross = crossable(true)
    await createDocs()
    // the phone's header takes focus as App moves into Docs
    expect(document.activeElement).toBe(document.querySelector('[data-mobile-project-actions]'))
    await blur()
    await cross(false)
    const row = await waitFor(docsRow, "Docs's row")
    await settle()
    expect(row.getAttribute('aria-current')).toBe('page')
    expect(document.activeElement).toBe(document.body)
  })
})

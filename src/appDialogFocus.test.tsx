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
import { answerProjectNav, isProjectNavRead } from './store/projectNavStandIn.setup'
import { isProjectListRead, projectListsServer } from './store/projectSettingsListsStandIn.setup'
import { isProjectSettingsRead, projectSettingsServer } from './store/projectSettingsStandIn.setup'
import { answerRoadmap } from './store/roadmapStandIn.setup'

/* Where focus goes as App's New sub-project and Milestones dialogs close,
   on App and the real store. The Planner leads Plan. New sub-project opens
   from buttons that leave once the new sub-project shows, and from menu
   rows that leave with their menu; the server holds the create until the
   test answers it, and App then moves into the new sub-project. Milestones
   opens on a milestone that it then deletes. A store that boots without
   the tasks, as the app does, asks for every task only for a create with
   a starter task. */

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

beforeEach(() => {
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
  const base = snap.projects[0]
  snap.projects = [
    { ...base, id: 'plan', type: 'meta', key: 'PLAN', name: 'Plan', lead_id: snap.profiles[0].id },
  ]
  prepare(snap)
  /* The workspace is delivered once, and again only as a milestone's
     delete changes it (projects.removeMilestone, or roadmap.change during
     a Roadmap visit), before the delete answers, as Convex delivers a
     write; any other write's paint is the only copy of what it changed.
     The Overview's reads answer from it until the first write: an answer
     after one would be a transition the store takes for a delivery that
     holds the write, which this double does not send, and the paint would
     end. The Milestones window's read of the milestone it opens on
     (milestones.get) answers from it at any time, so a window opened after
     a delete reads its milestone; that transition is a delivery that holds
     the delete, which the workspace delivered already. */
  let wrote = false
  // Settings › Projects reads the server's lists, which hold Plan, and New
  // sub-project checks its parent on the server (projectSettings.get)
  const lists = projectListsServer(() => snap)
  const settings = projectSettingsServer(() => snap)
  let publish: ((value: Snapshot) => void) | null = null
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (isProjectListRead(name)) return lists.watch(name, args, next, fail)
    if (isProjectSettingsRead(name)) return settings.watch(name, args, next, fail)
    // the All projects directory lists the server's navigation reads
    if (isProjectNavRead(name)) answerProjectNav(snap, name, args, next, fail)
    else if (name === 'workspace:whole') {
      publish = (value) => {
        const copy = structuredClone(value)
        held(copy)
        next(copy)
      }
      publish(snap)
    } else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name.startsWith('overview:') && !wrote) answerOverview(snap, name, args, next, fail)
    else if (isMilestoneRead(name)) answerMilestones(snap, name, args, next, fail)
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
  network.query.mockResolvedValue(null)
  sent = []
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    sent.push({ name, args })
    if (name !== 'identity:claimMySeats') wrote = true
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
    if (name === 'projects:create')
      return new Promise((resolve, reject) => {
        saved = () => resolve({ num: 2, key: 'DOCS' })
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
    "gives focus to the new sub-project's sidebar row after a create from %s",
    async (_, opener) => {
      await boot()
      await press(await opener())
      await finish(true)
      const row = await find('Docs', document.querySelector('aside') ?? document)
      expect(document.activeElement).toBe(row)
      // the row stays as App moves into the saved sub-project
      await save()
      expect(row.getAttribute('aria-current')).toBe('page')
      expect(document.activeElement).toBe(row)
    },
  )

  it("gives focus to the project's sidebar row when the server refuses the sub-project", async () => {
    await boot()
    await press(await find('Add sub-project'))
    await finish(true)
    const row = await find('Docs', document.querySelector('aside') ?? document)
    expect(document.activeElement).toBe(row)
    await act(async () => refused())
    await settle()
    expect(row.isConnected).toBe(false)
    expect(document.activeElement).toBe(
      document.querySelector('aside [data-project-row="plan"] button'),
    )
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
    const row = await waitFor(
      () => document.querySelector<HTMLElement>('[data-subproject-row] button'),
      'the new row',
    )
    expect(row.textContent).toBe('Docs')
    expect(document.activeElement).toBe(row)
  })

  it('stays where it is after a create under a parent the workspace does not hold, with no starter task', async () => {
    history.replaceState(null, '', '/app/testbed/settings/projects')
    // the server holds Ops, which the workspace leaves out, as after the
    // admin access split for a project an admin only manages
    await boot(
      (snap) =>
        snap.projects.push({ ...snap.projects[0], id: 'ops', key: 'OPS', num: 3, name: 'Ops' }),
      (copy) => {
        copy.projects = copy.projects.filter((p) => p.id !== 'ops')
      },
    )
    const row = await waitFor(
      () => document.querySelector('[data-settings-projects] [data-project-row="ops"]'),
      "Ops's row",
    )
    // its own right offers New sub-project, held by the workspace or not
    await press(await find('Project actions', row))
    const menu = await waitFor(
      () => document.querySelector('[data-slot="popover-content"]'),
      'the menu',
    )
    await press(await find('New sub-project…', menu))
    await waitFor(() => document.querySelector('[data-new-subproject-parent="ops"]'), 'the check')
    // no starter task under a parent the workspace does not hold
    expect(document.querySelector('#subproject-starter')).toBeNull()
    await finish(true)
    const create = sent.find((w) => w.name === 'projects:create')
    expect(create?.args).toMatchObject({ type: 'project', parent_id: 'ops', name: 'Docs' })
    expect(create?.args).not.toHaveProperty('sort_order')
    // nothing paints under a parent the workspace does not hold, neither
    // as the create goes nor once it is answered
    const id = String(create?.args.id)
    const { P } = await import('./store/planner')
    expect(P.project(id)).toBeUndefined()
    const scopes = vi.spyOn(P, 'saveUI')
    await save()
    expect(document.body.textContent).toContain('Sub-project “Docs” created')
    expect(P.project(id)).toBeUndefined()
    // App stays in Settings › Projects, never moves into the sub-project,
    // and creates no task
    expect(document.querySelector('[data-settings-projects]')).not.toBeNull()
    expect(scopes.mock.calls.some(([patch]) => (patch as { scope?: string }).scope === id)).toBe(
      false,
    )
    expect(sent.some((w) => w.name.startsWith('issues:'))).toBe(false)
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
  afterEach(async () => {
    const { TASKS } = await import('./store/liveParts')
    TASKS.atBoot = true
  })

  it.each<[string, boolean, string[]]>([
    ['with', true, ['create']],
    ['without', false, []],
  ])('asks for every task only for a create %s a starter task', async (_, starter, asks) => {
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
  it.each([
    ['desktop', 'New project', () => sidebarRow('data-project-row')],
    ['phone', 'New project', () => header('data-mobile-project-actions')],
    ['desktop', "a menu's New sub-project", () => sidebarRow('data-subproject-row')],
    ['phone', "a menu's New sub-project", () => header('data-mobile-new-task')],
  ])(
    "on a %s, gives focus to the project's own control once App has moved into it from %s",
    async (layout, opener, target) => {
      phone(layout === 'phone')
      history.replaceState(null, '', '/app/testbed/projects')
      await boot()
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
      const own = target()
      expect(own).toBeTruthy()
      expect(own?.closest('[data-hidden-view]')).toBeNull()
      expect(document.activeElement).toBe(own)
    },
  )
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
        // the Roadmap's flags show the weeks of its window, from this one on
        if (attr === 'data-msflag')
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

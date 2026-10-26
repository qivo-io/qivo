// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { CONFIRM_IGNORE_MS } from './lib/useConfirmArm'
import { plannerFixture, type Snapshot } from './store/plannerFixture.setup'

/* Where focus goes as App's New sub-project and Milestones dialogs close,
   on App and the real store. The Planner leads Plan. New sub-project opens
   from buttons that leave once the new sub-project shows, and from menu
   rows that leave with their menu; the server holds the create until the
   test answers it, and App then moves into the new sub-project. Milestones
   opens on a milestone that it then deletes. */

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

/** Boots App on Plan, with what `prepare` adds. */
async function boot(prepare: (snap: Snapshot) => void = () => {}) {
  vi.resetModules()
  const snap = plannerFixture()
  const base = snap.projects[0]
  snap.projects = [
    { ...base, id: 'plan', type: 'meta', key: 'PLAN', name: 'Plan', lead_id: snap.profiles[0].id },
  ]
  prepare(snap)
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'snapshot:commentThread') next({ comments: [], earlier: false, events: [] })
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockImplementation((ref) => {
    const name = getFunctionName(ref)
    if (name === 'projects:create')
      return new Promise((resolve, reject) => {
        saved = () => resolve({ num: 2, key: 'DOCS' })
        refused = () => reject(new ConvexError({ message: 'Qivo cannot save changes right now.' }))
      })
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
    creates it with `submit`, or cancels it. */
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
  await press(await find(create ? submit : 'Cancel', shell))
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

  it.each([
    ['sidebar', 'Create', '', 'Project actions', 'New sub-project…'],
    ['sidebar', 'Cancel', '', 'Project actions', 'New sub-project…'],
    ['phone header', 'Create', '', 'Project actions', 'New sub-project'],
    ['phone header', 'Cancel', '', 'Project actions', 'New sub-project'],
    ['Settings › Projects', 'Create', 'settings/projects', 'Project actions', 'New sub-project…'],
    ['Projects page', 'Create', 'projects', 'Plan actions', 'New sub-project'],
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
        await press(await find('New sub-project', menu))
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
    snap.milestones.push(
      { id: 'alpha', project_id: 'plan', name: 'Alpha', week: '2026-10-05', created_at: AT },
      { id: 'beta', project_id: 'plan', name: 'Beta', week: '2026-11-02', created_at: AT },
    )
  }
  /** The Monday `weeks` weeks after this week's, as a milestone's week. */
  const mondayIn = (weeks: number) => {
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

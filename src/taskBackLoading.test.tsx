// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { plannerFixture, type Snapshot } from './store/plannerFixture.setup'

/* Back or Forward to a task's address while a large workspace still loads
   its tasks in stages (store/liveParts.ts), on App and the real store: the
   task window waits for a task still to arrive, the address keeps naming
   it, and the task opens once it arrives, in its own scope. The waiting
   window closes, and a task that never arrives closes it once every task
   has loaded. A task address Back reaches during the first load, before
   App shows, is held the same way. A project in scope deleted meanwhile
   goes with the task's arrival, and the task opens in the one left. A page
   moved meanwhile names itself, and earns an entry where it would with the
   task open. A task that arrives while a refused Back steps back is named
   once that step lands. A held address of another organization never
   shows a home task with the same number. Settings opens meanwhile, but
   its pages that read every task wait. Back to a task or project that is
   gone, once every task has loaded, names the page it shows in place. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { holdWindow(from: string | null): void },
}))
vi.mock('./lib/convex', async () => {
  const { liveOver } = await import('./store/guard/liveDouble.setup')
  double.live = liveOver(network)
  return { convex: network, live: double.live }
})
/* App refuses a Back or Forward only when it would close unsent text,
   which no window holds while these tasks load, so a test that needs a
   refused one's step back on its way stands it in (`on`) until a popstate
   lands it. Otherwise App's refusal is the real one. */
const refusing = vi.hoisted(() => ({ on: false }))
vi.mock('./lib/popRefusal', async (importOriginal) => {
  const real = await importOriginal<typeof import('./lib/popRefusal')>()
  return {
    createPopRefusal: (...args: Parameters<typeof real.createPopRefusal>) => {
      const refusal = real.createPopRefusal(...args)
      return {
        ...refusal,
        stepping: () => refusing.on || refusal.stepping(),
        landed(event: PopStateEvent) {
          if (!refusing.on) return refusal.landed(event)
          refusing.on = false
          event.stopImmediatePropagation()
          return true
        },
      }
    },
  }
})
vi.mock('./lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'
// All projects' Board, which names no organization
const ALL_BOARD = '/app/~/board/all'
// 12,800 task numbers make 64 task windows; the last starts at fc000000
const LAST_WINDOW = 'fc000000'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  // closing a task returns focus to its card, which then scrolls into view
  Element.prototype.scrollIntoView = () => {}
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
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  refusing.on = false
  await act(async () => root.unmount())
  double.live?.holdWindow(null)
  container.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

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

type Task = Snapshot['issues'][number]
/** Task number `num` with id `id` in project `project` of organization `org`. */
const task = (id: string, org: string, project: string, num: number, title: string): Task => ({
  id,
  org_id: org,
  project_id: project,
  num,
  title,
  description: '',
  status: 'progress',
  priority: 'medium',
  paused: false,
  created_at: AT,
  updated_at: AT,
  has_hidden_subtasks: false,
  has_hidden_parent: false,
})

/** Gives the login a guest seat in a large organization, Partner Co at
    /app/partner, whose task QN-2 is in the last task window, and moves the
    home organization's QN-2 into the first one, which arrives first. */
function partner(snap: Snapshot) {
  const org = crypto.randomUUID()
  const seat = crypto.randomUUID()
  const project = crypto.randomUUID()
  snap.orgs.push({ ...snap.orgs[0], id: org, name: 'Partner Co', slug: 'partner' })
  snap.profiles.push({ ...snap.profiles[0], id: seat, org_id: org, org_role: 'guest' })
  snap.myProfileIds.push(seat)
  snap.projects.push({ ...snap.projects[0], id: project, org_id: org, key: 'PART' })
  snap.access.push({ project_id: project, profile_id: seat, level: 'user' })
  snap.issues[0] = { ...snap.issues[0], id: '10000000-b', title: 'Home task two' }
  snap.issues.push(task('fd000000-p', org, project, 2, 'Partner task two'))
}

/** Boots App on a large workspace whose last task window, holding task
    QN-2, is still to arrive, or with every task loaded when not `held`.
    With `reached`, Back or Forward reaches the address it builds from the
    organization's slug after the load began and before App's first render.
    `shape` changes the workspace first. Answers the store, the
    organization's slug and a function that publishes the workspace again
    with a change. */
async function bootLoading(
  held = true,
  reached?: (org: string) => string,
  shape?: (snap: Snapshot) => void,
) {
  vi.resetModules()
  const snap: Snapshot = plannerFixture()
  snap.orgs[0].next_issue_num = 64 * 200
  snap.issues.push(task('fd000000-b', snap.orgs[0].id, snap.projects[0].id, 2, 'Run the soak test'))
  shape?.(snap)
  let publish = (_: Snapshot) => {}
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      publish = (value) => next(structuredClone(value))
      publish(snap)
    } else if (name === 'snapshot:commentThread') next({ comments: [], earlier: false, events: [] })
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  const store = await import('./store/planner')
  if (held) double.live?.holdWindow(LAST_WINDOW)
  await store.initStore()
  expect(store.P.stillLoading() !== null).toBe(held)
  if (reached) history.pushState(null, '', reached(store.P.org.slug))
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
  const change = (edit: (snap: Snapshot) => void) =>
    act(async () => {
      const next = structuredClone(snap)
      edit(next)
      next.delivered_at = '2026-09-15T09:00:00.000Z'
      publish(next)
    })
  return { store, org: location.pathname.split('/')[2], change }
}

/** Makes the project at board/p/1 top-level, so the sidebar lists it, adds
    another, Second project at board/p/2, and moves task QN-2 into it. */
function secondProject(snap: Snapshot) {
  snap.projects[0].type = 'meta'
  const project = {
    ...snap.projects[0],
    id: crypto.randomUUID(),
    key: 'TWO',
    num: 2,
    name: 'Second project',
  }
  snap.projects.push(project)
  const soak = snap.issues.find((issue) => issue.id === 'fd000000-b')
  if (soak) soak.project_id = project.id
}

/** Goes to `address` as Back or Forward would, to an entry from earlier in
    this session's history. */
const back = (address: string) =>
  act(async () => {
    history.pushState(null, '', address)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

/** Closes the task window with Escape, as a person would. */
const close = () =>
  act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })

/** Switches the page to the view `label` with the top bar's switch. The
    waiting window makes the page behind it inert, so a person cannot. The
    click stands in for a move of the page while the task loads. */
const switchView = async (label: string) => {
  const button = await waitFor(
    () =>
      [...document.querySelectorAll<HTMLElement>('[data-view-switch] button')].find(
        (b) => b.textContent?.trim() === label,
      ),
    label,
  )
  await act(async () => button.click())
}

/** Presses the sidebar's scope `label`, a stand-in click as switchView's. */
const pressScope = async (label: string) => {
  const button = await waitFor(
    () =>
      [...document.querySelectorAll<HTMLElement>('aside button')].find(
        (b) => b.textContent?.trim() === label,
      ),
    label,
  )
  await act(async () => button.click())
}

/** Lets the last task window answer. */
const arrive = () =>
  act(async () => {
    double.live?.holdWindow(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

describe('Back to a task still to arrive', { timeout: 30_000 }, () => {
  it('holds its address in a window that shows, and opens the task in its own scope once it arrives', async () => {
    const { store, org } = await bootLoading()
    // from All projects, which Back to a task address leaves
    await back(`/app/${org}/board/all`)
    const address = `/app/${org}/board/tasks/qn-2`
    await back(address)
    const waiting = await waitFor(
      () => document.querySelector('[data-task-loading]'),
      'the waiting window',
    )
    const dialog = waiting.closest<HTMLElement>('[role="dialog"]')
    expect(dialog?.getAttribute('aria-hidden')).toBeNull()
    expect(dialog?.style.opacity).toBe('1')
    expect(location.pathname).toBe(address)

    await arrive()
    expect(store.P.stillLoading()).toBeNull()
    await waitFor(
      () => document.body.textContent?.includes('Run the soak test'),
      "the task's window",
    )
    expect(document.querySelector('[data-task-loading]')).toBeNull()
    expect(location.pathname).toBe(address)
    // it opened in its own project, so closing it shows that project's
    // Board, not All projects
    await close()
    expect(location.pathname).toBe(`/app/${org}/board/p/1`)
  })

  it('closes from the waiting window, and the task does not open when it arrives', async () => {
    const { store, org } = await bootLoading()
    await back(`/app/${org}/board/all`)
    await back(`/app/${org}/board/tasks/qn-2`)
    const waiting = await waitFor(
      () => document.querySelector('[data-task-loading]'),
      'the waiting window',
    )
    const closing = [...waiting.querySelectorAll('button')].find((b) => b.textContent === 'Close')
    await act(async () => closing?.click())
    expect(document.querySelector('[data-task-loading]')).toBeNull()
    expect(location.pathname).toBe(ALL_BOARD)

    await arrive()
    expect(store.P.stillLoading()).toBeNull()
    expect(document.body.textContent).not.toContain('Run the soak test')
    expect(location.pathname).toBe(ALL_BOARD)
  })

  it('closes the window once every task has loaded without the task', async () => {
    const { store, org } = await bootLoading()
    await back(`/app/${org}/board/all`)
    // no task has number 3
    await back(`/app/${org}/board/tasks/qn-3`)
    await waitFor(() => document.querySelector('[data-task-loading]'), 'the waiting window')
    expect(location.pathname).toBe(`/app/${org}/board/tasks/qn-3`)

    await arrive()
    expect(store.P.stillLoading()).toBeNull()
    await waitFor(() => !document.querySelector('[data-task-loading]'), 'the closed window')
    expect(location.pathname).toBe(ALL_BOARD)
  })

  it('names a page moved to while it waits, then that page with the task once it arrives', async () => {
    const { org } = await bootLoading()
    await back(`/app/${org}/board/all`)
    await back(`/app/${org}/board/tasks/qn-2`)
    await waitFor(() => document.querySelector('[data-task-loading]'), 'the waiting window')
    const entries = history.length
    // the page moves under the waiting window, which stays
    await switchView('Overview')
    expect(document.querySelector('[data-task-loading]')).not.toBeNull()
    expect(location.pathname).toBe('/app/~/overview/all')
    expect(history.length).toBe(entries + 1)

    await arrive()
    await waitFor(
      () => document.body.textContent?.includes('Run the soak test'),
      "the task's window",
    )
    expect(location.pathname).toBe(`/app/${org}/overview/all/tasks/qn-2`)
    // the task joined the moved page's entry, as it would have opened there
    expect(history.length).toBe(entries + 1)
  })

  it('names the page it moved back to while it waits, then opens the task there', async () => {
    const { org } = await bootLoading()
    await back(`/app/${org}/board/all`)
    await back(`/app/${org}/board/tasks/qn-2`)
    await waitFor(() => document.querySelector('[data-task-loading]'), 'the waiting window')
    await switchView('Overview')
    await switchView('Board')
    expect(location.pathname).toBe(ALL_BOARD)

    await arrive()
    await waitFor(
      () => document.body.textContent?.includes('Run the soak test'),
      "the task's window",
    )
    // the page Back reached: the task opens in its own scope
    expect(location.pathname).toBe(`/app/${org}/board/tasks/qn-2`)
  })

  it('keeps its address while the project in scope goes, then opens the task in the one left', async () => {
    const { org, change } = await bootLoading(true, undefined, secondProject)
    await back(`/app/${org}/board/p/1`)
    const address = `/app/${org}/board/tasks/qn-2`
    await back(address)
    await waitFor(() => document.querySelector('[data-task-loading]'), 'the waiting window')
    const entries = history.length
    // deleted meanwhile, which the staged load shows only with the last tasks
    await change((snap) => {
      snap.projects = snap.projects.filter((project) => project.num !== 1)
    })
    expect(location.pathname).toBe(address)

    await arrive()
    await waitFor(
      () => document.body.textContent?.includes('Run the soak test'),
      "the task's window",
    )
    expect(location.pathname).toBe(address)
    expect(history.length).toBe(entries)
    // the page moved to the project left
    await close()
    expect(location.pathname).toBe(`/app/${org}/board/p/2`)
  })

  it.each([
    // the task's address names no project, so the move takes its entry
    ['Second project', (org: string) => `/app/${org}/board/p/2`, 'board/tasks/qn-2', 0],
    // under All projects the task's address names the scope, so a new entry
    ['All projects', () => ALL_BOARD, 'board/all/tasks/qn-2', 1],
  ])(
    'names %s moved to while it waits as it would with the task open',
    async (label, page, withTask, more) => {
      const { org } = await bootLoading(true, undefined, secondProject)
      await back(`/app/${org}/board/p/1`)
      await back(`/app/${org}/board/tasks/qn-2`)
      await waitFor(() => document.querySelector('[data-task-loading]'), 'the waiting window')
      const entries = history.length
      // a stand-in click (pressScope)
      await pressScope(label)
      expect(location.pathname).toBe(page(org))
      expect(history.length).toBe(entries + more)

      await arrive()
      await waitFor(
        () => document.body.textContent?.includes('Run the soak test'),
        "the task's window",
      )
      expect(location.pathname).toBe(`/app/${org}/${withTask}`)
      expect(history.length).toBe(entries + more)
    },
  )

  it('names the task that arrived while a refused Back stepped back, once it landed', async () => {
    const { org } = await bootLoading()
    await back(`/app/${org}/board/all`)
    await back(`/app/${org}/board/tasks/QN-2`)
    await waitFor(() => document.querySelector('[data-task-loading]'), 'the waiting window')
    // a refused Back steps back to this entry, and the task arrives meanwhile
    refusing.on = true
    await arrive()
    await waitFor(
      () => document.body.textContent?.includes('Run the soak test'),
      "the task's window",
    )
    expect(location.pathname).toBe(`/app/${org}/board/tasks/QN-2`)
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')))
    // the task's own address, in place
    expect(location.pathname).toBe(`/app/${org}/board/tasks/qn-2`)
    const entries = history.length
    // and the next move earns its entry
    await switchView('Overview')
    expect(history.length).toBe(entries + 1)
  })

  it('says in the Inbox that the task still loads, then opens it there', async () => {
    const { org } = await bootLoading()
    await back(`/app/${org}/inbox/tasks/qn-2`)
    await waitFor(() => document.querySelector('[data-task-loading]'), 'the loading note')
    expect(document.body.textContent).not.toContain('No message selected.')
    await arrive()
    await waitFor(() => document.body.textContent?.includes('Run the soak test'), "the task's pane")
    expect(document.querySelector('[data-task-loading]')).toBeNull()
  })
})

describe("Back to another organization's task still to arrive", { timeout: 30_000 }, () => {
  it.each([
    ['Back', 'QN-2'],
    ['Back', 'qn-2'],
    ['the first load', 'QN-2'],
  ])('never shows the home task with its number when %s reaches %s', async (when, ref) => {
    const address = `/app/partner/board/tasks/${ref}`
    const first = when === 'Back' ? undefined : () => address
    const { org } = await bootLoading(true, first, partner)
    if (when === 'Back') {
      await back(`/app/${org}/board/all`)
      await back(address)
    }
    await waitFor(() => document.querySelector('[data-task-loading]'), 'the waiting window')
    expect(document.body.textContent).not.toContain('Home task two')
    expect(location.pathname).toBe(address)
    await arrive()
    await waitFor(
      () => document.body.textContent?.includes('Partner task two'),
      "the partner's task",
    )
    expect(document.body.textContent).not.toContain('Home task two')
  })
})

describe('Back to a task during the first load', { timeout: 30_000 }, () => {
  it('holds its address when the load began in stages, then opens the task', async () => {
    const { store } = await bootLoading(true, (slug) => `/app/${slug}/inbox/tasks/qn-2`)
    const address = `/app/${store.P.org.slug}/inbox/tasks/qn-2`
    expect(location.pathname).toBe(address)
    await waitFor(() => document.querySelector('[data-task-loading]'), 'the loading note')
    await arrive()
    await waitFor(() => document.body.textContent?.includes('Run the soak test'), "the task's pane")
    expect(location.pathname).toBe(address)
  })

  it('opens the task in its own project when it is not in the saved scope', async () => {
    const { store } = await bootLoading(
      true,
      (slug) => `/app/${slug}/board/tasks/qn-2`,
      // My view, saved, holds only my tasks, and nobody has QN-2
      (snap) =>
        localStorage.setItem(
          `planner.ui.v1:${snap.profiles[0].id}`,
          JSON.stringify({ scope: 'mine', view: 'kanban' }),
        ),
    )
    await waitFor(() => document.querySelector('[data-task-loading]'), 'the waiting window')
    await arrive()
    await waitFor(
      () => document.body.textContent?.includes('Run the soak test'),
      "the task's window",
    )
    // closing it shows its project's Board, not My view
    await close()
    expect(location.pathname).toBe(`/app/${store.P.org.slug}/board/p/1`)
  })

  it('closes the window in place once every task has loaded without the task', async () => {
    const { store } = await bootLoading(true, (slug) => `/app/${slug}/board/tasks/qn-3`)
    expect(location.pathname).toBe(`/app/${store.P.org.slug}/board/tasks/qn-3`)
    await waitFor(() => document.querySelector('[data-task-loading]'), 'the waiting window')
    const entries = history.length
    await arrive()
    await waitFor(() => !document.querySelector('[data-task-loading]'), 'the closed window')
    // the page it shows, named in place as Back to a gone task names it
    expect(location.pathname).toBe(`/app/${store.P.org.slug}`)
    expect(history.length).toBe(entries)
  })
})

describe('Settings while tasks load', { timeout: 30_000 }, () => {
  it('opens, with Sign out, while a page that reads every task waits', async () => {
    const { org } = await bootLoading()
    await back(`/app/${org}/settings/account`)
    await waitFor(
      () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Sign out'),
      'Sign out',
    )
    expect(document.querySelector('[data-tasks-loading-view]')).toBeNull()
    await back(`/app/${org}/settings/org-labels`)
    await waitFor(() => document.querySelector('[data-tasks-loading-view]'), 'the waiting page')
    await arrive()
    await waitFor(
      () =>
        !document.querySelector('[data-tasks-loading-view]') &&
        document.querySelector('[data-settings-page="org-labels"]'),
      'the Labels page',
    )
  })
})

describe('Back to an address that is gone', { timeout: 30_000 }, () => {
  it.each([
    ['a task', 'board/tasks/qn-3'],
    ['a project', 'board/p/9'],
  ])(
    'names the page it shows in place when Back reaches %s that is gone, once every task loaded',
    async (_, gone) => {
      const { org } = await bootLoading(false)
      await back(`/app/${org}/board/all`)
      expect(location.pathname).toBe(ALL_BOARD)
      const entries = history.length
      // the page stays All projects' Board
      await back(`/app/${org}/${gone}`)
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(location.pathname).toBe(ALL_BOARD)
      // replaced, not pushed: Back from here leaves the page
      expect(history.length).toBe(entries + 1)
    },
  )
})

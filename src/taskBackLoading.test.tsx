// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { type BoardArgs, boardStandIn } from './store/boardStandIn.setup'
import { answerLabelPages } from './store/labelPagesStandIn.setup'
import { answerOverview } from './store/overviewStandIn.setup'
import { plannerFixture, type Snapshot } from './store/plannerFixture.setup'
import {
  answerProjectNav,
  isProjectNavRead,
  queryProjectNav,
} from './store/projectNavStandIn.setup'
import { isProjectListRead, projectListsServer } from './store/projectSettingsListsStandIn.setup'
import { isProjectSettingsRead, projectSettingsServer } from './store/projectSettingsStandIn.setup'
import { isTeamSettingsRead, teamSettingsServer } from './store/teamSettingsStandIn.setup'

/* Back or Forward to a task's address while every task loads
   (store/liveParts.ts), on App and the real store: the
   task window opens the task the workspace does not hold by a reference
   (lib/taskReference.ts), which the store reads from the server, the
   address keeps naming it, and the task opens once its answer or the
   workspace brings it, in its own scope. The window closes only when the
   person closes it: a task that never arrives keeps it and its address
   once every task has loaded, and the server's answer says it can't be
   opened. A task address Back reaches during the first load, before App
   shows, opens the same way. A project in scope deleted meanwhile goes
   with the task's arrival, and the task opens in the one left. A page
   moved meanwhile names itself with the task, and earns an entry where it
   would with the task open. A task that arrives while a refused Back
   steps back is named once that step lands. An address of another
   organization never shows a home task with the same number. Settings
   and every one of its pages open meanwhile: Teams, a team, Projects and
   a project, where a removal asks the server which tasks it affects,
   Labels, with the server's counts, and Archived tasks. Back to a project
   that is gone, once every task has loaded, names the page it shows in
   place. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { holdWindow(from: string | null): void },
}))
vi.mock('./lib/convex', async () => {
  const { liveOver } = await import('./store/guard/liveDouble.setup')
  double.live = liveOver(network, { taskWindow: 'client' })
  return { convex: network, live: double.live }
})
/* App refuses a Back or Forward only when it would close unsent text,
   which no window holds while these tasks load, so a test that needs a
   refused one's return on its way stands it in (`on`), and lands it by
   calling what waits for it (`landed`). Otherwise the page's history is the
   real one. */
const refusing = vi.hoisted(() => ({ on: false, settled: [] as (() => void)[] }))
vi.mock('./lib/pageHistory', async (importOriginal) => {
  const real = await importOriginal<typeof import('./lib/pageHistory')>()
  return {
    ...real,
    historyBusy: () => refusing.on || real.historyBusy(),
    onHistorySettled: (listener: () => void) => {
      refusing.settled.push(listener)
      const stop = real.onHistorySettled(listener)
      return () => {
        refusing.settled = refusing.settled.filter((other) => other !== listener)
        stop()
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
// My view's Board, which names no organization
const MINE_BOARD = '/app/~/board/mine'
// 12,800 task numbers make 64 task windows; the last starts at fc000000
const LAST_WINDOW = 'fc000000'

let container: HTMLDivElement
let root: Root
/* The reads of a task by its reference or the window's own read
   (taskWindow.task), which the test answers. */
let reads: {
  args: Record<string, unknown>
  next: (value: unknown) => void
  fail?: (error: unknown) => void
}[]

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
  reads = []
  const snap: Snapshot = plannerFixture()
  snap.orgs[0].next_issue_num = 64 * 200
  snap.issues.push(task('fd000000-b', snap.orgs[0].id, snap.projects[0].id, 2, 'Run the soak test'))
  shape?.(snap)
  let publish = (_: Snapshot) => {}
  // what the server holds: the workspace last published
  let server = snap
  // a project's Settings page, Settings' project lists and its team pages
  // read from the workspace last published
  const settings = projectSettingsServer(() => server)
  const lists = projectListsServer(() => server)
  const teams = teamSettingsServer(() => server)
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (isProjectSettingsRead(name)) return settings.watch(name, args, next, fail)
    if (isProjectListRead(name)) return lists.watch(name, args, next, fail)
    if (isTeamSettingsRead(name)) return teams.watch(name, args, next, fail)
    if (name === 'workspace:whole') {
      publish = (value) => {
        server = value
        next(structuredClone(value))
        settings.rerun()
        lists.rerun()
        teams.rerun()
      }
      publish(snap)
    } else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'taskWindow:task') reads.push({ args, next, fail })
    else if (name === 'tasks:board') next(boardStandIn(server, args as BoardArgs))
    else if (name.startsWith('overview:')) answerOverview(server, name, args, next, fail)
    else if (name === 'labels:settingsPage') answerLabelPages(server, args, next, fail)
    else if (isProjectNavRead(name)) answerProjectNav(server, name, args, next, fail)
    return () => {}
  })
  // a project address by number resolves through projectNav.resolve
  network.query.mockImplementation(async (ref, args) =>
    getFunctionName(ref) === 'projectNav:resolve'
      ? queryProjectNav(server, 'projectNav:resolve', args)
      : null,
  )
  network.mutation.mockResolvedValue(null)
  const store = await import('./store/planner')
  if (held) double.live?.holdWindow(LAST_WINDOW)
  await store.initStore()
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
  return { store, org: location.pathname.split('/')[2], change, snap }
}

/** Makes the project at board/p/1 top-level, so the sidebar lists it, adds
    another, Second project at board/p/2, and moves task QN-2 into it. The
    Planner holds a grant on both, as the sidebar lists an admin's projects
    by ordinary access. */
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
  for (const p of snap.projects)
    snap.access.push({ project_id: p.id, profile_id: snap.profiles[0].id, level: 'user' })
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
  it('closes the waiting window when All projects opens the directory, whose address names no task', async () => {
    const { org } = await bootLoading(true, undefined, secondProject)
    await back(`/app/${org}/board/p/1`)
    await back(`/app/${org}/board/tasks/qn-2`)
    await waitFor(() => document.querySelector('[data-task-loading]'), 'the waiting window')
    const entries = history.length
    await pressScope('All projects')
    expect(location.pathname).toBe('/app/~/projects')
    expect(history.length).toBe(entries + 1)
    expect(document.querySelector('[data-task-loading]')).toBeNull()
    // the task arrives, and no window opens over the directory
    await arrive()
    await waitFor(() => document.querySelector('[data-project-directory]'), 'the directory')
    expect(location.pathname).toBe('/app/~/projects')
    expect(document.querySelector('[data-task-close]')).toBeNull()
  })
})

describe('Back to a task during the first load', { timeout: 30_000 }, () => {
  it('keeps the window and the address once every task has loaded without the task', async () => {
    const { store } = await bootLoading(true, (slug) => `/app/${slug}/board/tasks/qn-3`)
    const address = `/app/${store.P.org.slug}/board/tasks/qn-3`
    expect(location.pathname).toBe(address)
    await waitFor(() => document.querySelector('[data-task-loading]'), 'the waiting window')
    const entries = history.length
    await arrive()
    expect(document.querySelector('[data-task-loading]')?.textContent).toContain('Loading QN-3…')
    expect(location.pathname).toBe(address)
    // a failed read keeps both, with Retry
    await act(async () => reads[0]?.fail?.(new Error('Server Error')))
    await waitFor(() => document.body.textContent?.includes("Couldn't open QN-3."), 'the failure')
    expect(
      [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Retry')),
    ).toBe(true)
    expect(location.pathname).toBe(address)
    expect(history.length).toBe(entries)
  })
})

describe.each([
  ['while every task loads', true],
  ['in a session that never asked for every task', false],
])('Settings %s', { timeout: 30_000 }, (_session, asked) => {
  beforeEach(async () => {
    const { TASKS } = await import('./store/liveParts')
    TASKS.atBoot = asked
  })
  afterEach(async () => {
    // a page of Settings asks for no task, and sends no write on a path
    // that needs every task
    if (!asked && settingsStore) {
      expect(settingsStore.P.taskLoad()).toEqual({ state: 'not_asked' })
      expect(settingsStore.__layerProbe?.asks()).toEqual([])
      expect(settingsStore.__layerProbe?.faults()).toEqual([])
    }
    settingsStore = null
  })
  let settingsStore: typeof import('./store/planner') | null = null
  /* Boots as bootLoading does, keeping the store for the check above. */
  const bootSettings = async (shape?: (snap: Snapshot) => void) => {
    const booted = await bootLoading(true, undefined, shape)
    settingsStore = booted.store
    return booted
  }

  it('opens Teams, a team, Projects and a project at once, and a removal there asks the server', async () => {
    const { org } = await bootSettings((snap) => {
      const home = snap.orgs[0].id
      snap.projects[0].type = 'meta'
      snap.profiles.push({
        ...snap.profiles[0],
        id: 'leo',
        auth_user_id: 'account-leo',
        name: 'Leo Berg',
        org_role: 'user',
      })
      snap.access.push({ project_id: snap.projects[0].id, profile_id: 'leo', level: 'user' })
      for (const id of ['crew', 'bench'])
        snap.teams.push({ id, org_id: home, name: id, track_delay_default: false, created_at: AT })
      snap.teamMembers.push({ team_id: 'crew', profile_id: 'leo', is_leader: false })
      // the held window's task is Leo's
      const held = snap.issues.find((issue) => issue.id === 'fd000000-b')
      if (held) held.assignee_id = 'leo'
    })
    await back(`/app/${org}/settings/account`)
    await waitFor(
      () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Sign out'),
      'Sign out',
    )
    for (const [page, address, shows] of [
      ['org-teams', 'org-teams', '[data-org-teams] [data-team-row="crew"]'],
      ['team:crew', 'team:crew', '[data-settings-team-member="leo"]'],
      // the server's rows, which come without a task
      ['projects', 'projects', '[data-settings-projects] [data-project-row]'],
      [undefined, 'project/1', '[data-project-access-user="leo"]'],
    ] as const) {
      await back(`/app/${org}/settings/${address}`)
      const scope = page ? `[data-settings-page="${page}"] ` : ''
      await waitFor(() => document.querySelector(`${scope}${shows}`), address)
    }
    // the press asks the server, which lists the held task that has not arrived
    network.query.mockImplementation(async (ref, args) =>
      getFunctionName(ref) === 'accessRemovals:preview'
        ? {
            state: 'ok',
            pending: true,
            leave_only: false,
            people: [{ id: 'leo', name: 'Leo Berg', kind: 'person', org_role: 'user' }],
            tasks: 1,
            items: [
              {
                task_id: 'fd000000-b',
                num: 2,
                title: 'Run the soak test',
                project_id: (args as { change: { project_id: string } }).change.project_id,
                holder_id: 'leo',
                role: 'assignee',
              },
            ],
            items_total: 1,
            hidden: 0,
            projects: [],
            keep: {
              targets: [],
              changers: [],
              allowed: true,
              refusal: null,
              offered: true,
              permitted: true,
            },
            reassign: { allowed: true, refusal: null, permitted: true },
          }
        : null,
    )
    const remove = document.querySelector<HTMLButtonElement>(
      '[data-project-access-user="leo"] [data-project-access-remove]',
    )
    await act(async () => remove?.click())
    const dialog = await waitFor(
      () => document.querySelector('[data-access-removal]'),
      'the window',
    )
    expect(dialog.textContent).toContain('QN-2')
    expect(dialog.textContent).toContain('Run the soak test')
  })

  it("opens Labels at once with the server's counts, though the task that carries a label is still to arrive", async () => {
    const { org } = await bootSettings((snap) => {
      snap.labels.push({
        id: 'soak',
        org_id: snap.orgs[0].id,
        name: 'Soak test',
        name_lower: 'soak test',
        color: '#335577',
        created_at: '2026-09-14T08:00:00.000Z',
      })
      // the held window's task carries it
      snap.issueLabels.push({ issue_id: 'fd000000-b', label_id: 'soak' })
    })
    await back(`/app/${org}/settings/org-labels`)
    const count = await waitFor(
      () =>
        document.querySelector(
          '[data-settings-page="org-labels"] [data-label-row="soak"] [data-label-count]',
        ),
      'the Labels row',
    )
    expect(count.textContent).toBe('1 active task')
  })

  it('opens Archived tasks at once, with the projects the person leads in its picker', async () => {
    const { org } = await bootSettings((snap) => {
      secondProject(snap)
      // the navigation reads judge the admin by ordinary access, so the
      // person leads both projects to see them listed
      for (const project of snap.projects) project.lead_id = snap.profiles[0].id
    })
    network.query.mockImplementation(async (ref) =>
      getFunctionName(ref) === 'issues:archivedPage'
        ? { rows: [], next_cursor: null, scanned: 0 }
        : null,
    )
    await back(`/app/${org}/settings/projects-archived-tasks`)
    const page = '[data-settings-page="projects-archived-tasks"]'
    await waitFor(() => document.querySelector(`${page} [data-archived-tasks]`), 'Archived tasks')
    await act(async () =>
      document.querySelector<HTMLElement>(`${page} [data-archive-project]`)?.click(),
    )
    await waitFor(() => document.querySelector('[data-project-pick]'), 'the picker rows')
    const rows = [...document.querySelectorAll('[data-project-pick], [data-project-pick-all]')]
    expect(rows.map((row) => row.textContent)).toEqual([
      'All projects',
      'Second project',
      'Task creation fixture',
    ])
  })
})

describe('Back and Forward in a session that never asked for every task', {
  timeout: 30_000,
}, () => {
  beforeEach(async () => {
    const { TASKS } = await import('./store/liveParts')
    TASKS.atBoot = false
  })

  it('opens a task from its own read on Back, and again on Forward, with no ask', async () => {
    const { store, org, snap } = await bootLoading()
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
    const row = snap.issues.find((issue) => issue.id === 'fd000000-b')
    if (!row) throw new Error('no soak test')
    const okAnswer = {
      state: 'ok',
      task: { ...row, has_subtasks: false },
      level: 'lead',
      labels: [],
      follow: null,
      parent: null,
      subtasks: { rows: [], complete: true },
    }
    /* Answers every read of the soak test, by its number or its uuid. */
    const answerReads = () =>
      act(async () => {
        for (const read of reads)
          if (read.args.ref === 'QN-2' || read.args.ref === row.id) read.next(okAnswer)
      })
    const title = () => document.querySelector('[data-task-title]')?.textContent
    const board = `/app/${org}/board/mine`
    const address = `/app/${org}/board/tasks/qn-2`
    await back(board)
    await back(address)
    // the window reads the task by its number, as no task is held
    expect(reads.map((read) => read.args)).toContainEqual({ org_id: store.P.org.id, ref: 'QN-2' })
    await answerReads()
    await waitFor(() => title() === 'Run the soak test', "the task's window")
    await answerReads()
    expect(location.pathname).toBe(address)
    // Back to the Board closes it, and Forward opens it again from its read
    await back(board)
    expect(title()).toBeUndefined()
    await back(address)
    await answerReads()
    await waitFor(() => title() === 'Run the soak test', "the task's window again")
    expect(location.pathname).toBe(address)
    expect(store.__layerProbe?.asks()).toEqual([])
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
    expect(store.P.handleOf(row.id)).toBeNull()
    expect(store.__layerProbe?.faults()).toEqual([])
  })
})

describe('Back to an address that is gone', { timeout: 30_000 }, () => {
  it('checks a project address the workspace does not hold on Back, keeping its entry, and shows the chooser where it is not available', async () => {
    const { store, org } = await bootLoading(false)
    await back(`/app/${org}/board/mine`)
    expect(location.pathname).toBe(MINE_BOARD)
    const entries = history.length
    // the server is asked by the address's organization and number; a
    // failed check keeps the address, with Retry, and no other page
    network.query.mockResolvedValue(null)
    await back(`/app/${org}/board/p/9`)
    await waitFor(
      () => document.querySelector('[data-project-chooser-state="retry"]'),
      'the failed check',
    )
    expect(document.querySelector('[data-project-chooser-line]')?.textContent).toBe(
      "Couldn't check that project.",
    )
    expect(network.query.mock.calls.at(-1)?.[1]).toEqual({ org_id: store.P.org.id, num: 9 })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(location.pathname).toBe(`/app/${org}/board/p/9`)
    expect(history.length).toBe(entries + 1)
    // Retry asks again; unavailable shows the chooser, the front door in
    // place of the address, not pushed: Back from here leaves the page
    network.query.mockImplementation(async (ref) =>
      getFunctionName(ref) === 'projectNav:resolve' ? { state: 'unavailable' } : null,
    )
    await act(async () =>
      document.querySelector<HTMLElement>('[data-project-chooser-retry]')?.click(),
    )
    // the fixture's project is no top-level one the lists show, so the
    // chooser's list ends empty beneath the note
    await waitFor(
      () =>
        document.querySelector('[data-project-chooser-note]')?.textContent ===
        'That project is not available to you.',
      'the chooser',
    )
    expect(location.pathname).toBe(`/app/${org}`)
    expect(history.length).toBe(entries + 1)
  })

  it("keeps the address of a task the workspace does not hold and asks the server, which says it can't be opened", async () => {
    const { store, org } = await bootLoading(false)
    await back(`/app/${org}/board/mine`)
    const entries = history.length
    const address = `/app/${org}/board/tasks/qn-3`
    await back(address)
    // a complete workspace without the task is no word on it
    await waitFor(() => document.querySelector('[data-task-loading]'), 'the loading window')
    expect(location.pathname).toBe(address)
    expect(reads.at(-1)?.args).toEqual({ org_id: store.P.org.id, ref: 'QN-3' })
    await act(async () => reads.at(-1)?.next({ state: 'unavailable' }))
    await waitFor(
      () =>
        document.body.textContent?.includes(
          "QN-3 can't be opened. It may not exist, or you may not have access to it.",
        ),
      'the note',
    )
    expect(location.pathname).toBe(address)
    expect(history.length).toBe(entries + 1)
    // closing it shows the page, by an entry of its own
    await close()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { type BoardArgs, boardStandIn } from './store/boardStandIn.setup'
import { answerOverview } from './store/overviewStandIn.setup'
import { plannerFixture, type Snapshot } from './store/plannerFixture.setup'
import { isProjectSettingsRead, projectSettingsServer } from './store/projectSettingsStandIn.setup'
import { answerRoadmap } from './store/roadmapStandIn.setup'

/* The entries App's pages and phone layers leave, on App and the real
   store. A layer that closes with the move it started, as Create and a
   search result do, gives that move its entry, so Back returns to the page
   the layer opened on. A task that someone else removes keeps the address
   its window shows. A refused Back returns to the entry it left. A Back
   that closes a layer over a task the workspace does not hold leaves its
   window open. An archived task Search opened closes with an entry of its
   own, and Back and Forward to its address open its window again. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('./lib/convex', async () => {
  const { liveOver } = await import('./store/guard/liveDouble.setup')
  return { convex: network, live: liveOver(network) }
})
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
let removeHistory = () => {}
// the archived tasks Search finds with Include archived tasks and the
// task window's own read answers (taskWindow.task), which a test sets
// after boot
let archive: (Snapshot['issues'][number] & { archived_at: string })[] = []
// the active tasks the workspace does not hold, which Search finds and the
// task window's own read answers, which a test sets after boot
let unheld: Snapshot['issues'] = []
// how many times the window subscribed its read of a task
let reads = 0

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.scrollTo = () => {}
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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
  removeHistory()
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

/** Presses the button named `name`. */
const press = async (name: string) => {
  const button = await waitFor(
    () =>
      [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"], [cmdk-item]')].find(
        (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
      ),
    name,
  )
  await act(async () => button.click())
}

/** Lets the page's history moves land. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

/** Types `text` into the input `input`. */
async function type(input: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    set?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Boots App at `address`, after an earlier /before entry, on a phone or
    not, with the page's history main.tsx installs and task QN-1, and QN-2
    when `second`. Answers a function that publishes the workspace without
    the tasks. */
async function boot(address: string, phone: boolean, second = false) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: phone, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  vi.resetModules()
  const snap: Snapshot = plannerFixture()
  snap.orgs[0].next_issue_num = 1
  // a project the person leads, with a sub-project that holds the task
  const base = snap.projects[0]
  snap.projects = [
    { ...base, type: 'meta', lead_id: snap.profiles[0].id },
    { ...base, id: 'work', key: 'WORK', num: 2, name: 'Work', parent_id: base.id },
  ]
  snap.issues.push({
    id: crypto.randomUUID(),
    org_id: snap.orgs[0].id,
    project_id: 'work',
    num: 1,
    title: 'Calibrate the sensor',
    description: '',
    status: 'todo',
    priority: 'medium',
    paused: false,
    created_at: AT,
    updated_at: AT,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  if (second) {
    snap.orgs[0].next_issue_num = 2
    snap.issues.push({
      ...snap.issues.at(-1)!,
      id: crypto.randomUUID(),
      num: 2,
      title: 'Order the parts',
    })
  }
  let publish = (_: Snapshot) => {}
  reads = 0
  // what the server holds: the workspace last published
  let server = snap
  // a project's Settings page reads from the workspace last published
  const settings = projectSettingsServer(() => server)
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (isProjectSettingsRead(name)) return settings.watch(name, args, next, fail)
    if (name === 'workspace:whole') {
      publish = (value) => {
        server = value
        next(structuredClone(value))
        settings.rerun()
      }
      publish(snap)
    } else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'tasks:board') next(boardStandIn(server, args as BoardArgs))
    else if (name.startsWith('overview:')) answerOverview(server, name, args, next, fail)
    else if (name === 'tasks:roadmap' || name === 'tasks:roadmapDependencies')
      next(answerRoadmap(server, name, args))
    else if (name === 'taskWindow:task') {
      // the server's answer, a moment later, as from Convex: an archived
      // task with its text, or the task the workspace holds, by its uuid or
      // its key in the organization asked (convex/lib/taskWindow.ts taskByRef)
      reads++
      let closed = false
      const named = (task: { id: string; org_id: string; num: number }) =>
        task.id === args.ref || (task.org_id === args.org_id && `QN-${task.num}` === args.ref)
      setTimeout(() => {
        if (closed) return
        const row = archive.find(named)
        const live = server.issues.find(named) ?? unheld.find(named)
        next(
          row
            ? {
                state: 'archived',
                task: { ...row, is_group: false },
                description: row.description,
                labels: [],
                level: 'lead',
              }
            : live
              ? {
                  state: 'ok',
                  task: live,
                  level: 'lead',
                  labels: [],
                  follow: null,
                  parent: null,
                  subtasks: { rows: [], complete: true },
                }
              : { state: 'unavailable' },
        )
      }, 0)
      return () => {
        closed = true
      }
    }
    return () => {}
  })
  // main Search (search:page) answers the tasks whose titles hold every
  // word of the text, in the Work sub-project, and with Include archived
  // tasks the archived ones too
  archive = []
  unheld = []
  network.query.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    if (name !== 'search:page') return null
    const words: string[] = args.text.toLowerCase().split(/\s+/).filter(Boolean)
    const rows = [...snap.issues, ...unheld, ...(args.include_archived ? archive : [])]
      .filter((issue) => words.every((word) => issue.title.toLowerCase().includes(word)))
      .map((issue) => ({
        kind: 'task',
        org_id: issue.org_id,
        id: issue.id,
        num: issue.num,
        title: issue.title,
        status: issue.status,
        is_group: false,
        archived: 'archived_at' in issue,
        project: { id: 'work', name: 'Work' },
        parent: { id: base.id, name: base.name },
      }))
    return { rows, next_cursor: null, coverage: { complete: true } }
  })
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name.startsWith('comments:')) return new Promise(() => {})
    if (name !== 'issues:create') return Promise.resolve(null)
    // the server stores a create and delivers it before it answers with the
    // stored row, as Convex does: a window the server took the create of
    // reads the task (store/planner.ts tookCreate)
    const org = server.orgs[0]
    const row: Snapshot['issues'][number] = {
      id: args.id,
      org_id: org.id,
      project_id: args.project_id,
      num: (org.next_issue_num ?? 0) + 1,
      title: args.title,
      description: args.description ?? '',
      status: args.status ?? 'backlog',
      priority: args.priority ?? 'low',
      paused: false,
      created_at: AT,
      updated_at: AT,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    }
    const next = structuredClone(server)
    next.orgs[0].next_issue_num = row.num
    next.issues.push(row)
    publish(next)
    const { description: _text, has_hidden_subtasks: _h, has_hidden_parent: _p, ...stored } = row
    return Promise.resolve(stored)
  })
  history.pushState(null, '', '/before')
  history.pushState(null, '', address)
  const pageHistory = await import('./lib/pageHistory')
  removeHistory = pageHistory.installPageHistory()
  const store = await import('./store/planner')
  await store.initStore()
  const { syncStatus } = await import('./lib/syncStatus')
  syncStatus.setSocket({ connected: true, everConnected: true })
  const { default: App } = await import('./App')
  // the question main.tsx mounts at the root
  const { DiscardPrompt } = await import('./components/DiscardPrompt')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <App />
        <DiscardPrompt />
      </TooltipProvider>,
    ),
  )
  const gone = structuredClone(snap)
  gone.issues = []
  gone.delivered_at = '2026-09-15T09:00:00.000Z'
  const drop = () => act(async () => publish(gone))
  // publishes the workspace without the Work sub-project and its task
  const dropWork = () => {
    const next = structuredClone(gone)
    next.projects = next.projects.filter((p) => p.id !== 'work')
    return act(async () => publish(next))
  }
  // publishes the workspace after `edit`, as a later delivery
  const change = (edit: (next: Snapshot) => void) => {
    const next = structuredClone(snap)
    edit(next)
    next.delivered_at = '2026-09-15T09:00:00.000Z'
    return act(async () => publish(next))
  }
  return Object.assign(drop, { dropWork, change })
}

describe('a phone layer that closes with the move it started', { timeout: 30_000 }, () => {
  it("gives a created task the create dialog's entry, and Back returns to the Board", async () => {
    // a project's Board, which holds the task list
    await boot('/app/testbed/board/p/1', true)
    await waitFor(() => document.querySelector('.mobile-task-row'), 'the task list')
    await settle()
    const entries = history.length
    await press('New task')
    await waitFor(() => document.querySelector('[data-modal-shell]'), 'the dialog')
    await settle()
    expect(history.state?.qivoLayer).toBeTruthy()
    const where = document.querySelector<HTMLSelectElement>('[data-modal-shell] select')
    if (where) {
      const next = [...where.options].find((o) => !o.disabled && o.value)
      if (next) {
        where.value = next.value
        await act(async () => where.dispatchEvent(new Event('change', { bubbles: true })))
      }
    }
    await type(
      await waitFor(
        () => document.querySelector<HTMLInputElement>('input[aria-label="Title"]'),
        'the Title field',
      ),
      'Run the soak test',
    )
    await press('Create')
    await waitFor(() => document.querySelector('[data-task-chrome]'), 'the task window')
    await settle()
    expect(location.pathname).toMatch(/\/tasks\/qn-2$/)
    expect(history.state?.qivoLayer).toBeUndefined()
    expect(history.length).toBe(entries + 1)
    await act(async () => history.back())
    await settle()
    expect(location.pathname).toBe('/app/testbed/board/p/1')
    expect(document.querySelector('[data-task-chrome]')).toBeNull()
  })

  it("gives a search result's task the search's entry, and Back returns to the page the search began on", async () => {
    await boot('/app/testbed/board/p/1', true)
    await waitFor(() => document.querySelector('.mobile-task-row'), 'the task list')
    await settle()
    const entries = history.length
    await press('Search tasks and projects')
    const search = await waitFor(
      () => document.querySelector<HTMLInputElement>('[cmdk-root] input'),
      'the search box',
    )
    await settle()
    expect(history.state?.qivoLayer).toBeTruthy()
    await type(search, 'Calibrate')
    const result = await waitFor(
      () =>
        [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find((item) =>
          item.textContent?.includes('Calibrate the sensor'),
        ),
      'the result',
    )
    await act(async () => result.click())
    await waitFor(() => document.querySelector('[data-task-chrome]'), 'the task window')
    await settle()
    expect(location.pathname).toBe('/app/testbed/board/tasks/qn-1')
    expect(history.state?.qivoLayer).toBeUndefined()
    expect(history.length).toBe(entries + 1)
    await act(async () => history.back())
    await settle()
    expect(location.pathname).toBe('/app/testbed/board/p/1')
  })
})

describe('a phone layer over the project chooser', { timeout: 30_000 }, () => {
  it('closes with Back and leaves the chooser at its front door, not the Inbox a boot there opens', async () => {
    // nothing remembered, so a phone's Board address shows the chooser,
    // whose entry takes the front door in place
    await boot('/app/testbed/board', true)
    await waitFor(
      () => document.querySelector('[data-project-chooser][data-project-chooser-state="choose"]'),
      'the project chooser',
    )
    await settle()
    expect(location.pathname).toBe('/app/testbed')
    await press('Search tasks and projects')
    await waitFor(() => document.querySelector('[cmdk-root] input'), 'the search box')
    await settle()
    expect(history.state?.qivoLayer).toBeTruthy()
    // Back to the chooser's own entry closes the search and moves nothing
    await act(async () => history.back())
    await settle()
    await waitFor(() => !document.querySelector('[cmdk-root]'), 'the search closed')
    expect(location.pathname).toBe('/app/testbed')
    expect(
      document.querySelector('[data-project-chooser]')?.getAttribute('data-project-chooser-state'),
    ).toBe('choose')
    expect(document.querySelector('.mobile-page-title')?.textContent).toBe('Projects')
  })
})

describe('a task someone else removes while the Inbox shows it', { timeout: 30_000 }, () => {
  it("keeps the address in the task's organization, with no new entry", async () => {
    const drop = await boot('/app/testbed/inbox/tasks/qn-1', false)
    await waitFor(() => document.querySelector('[data-task-chrome]'), 'the task pane')
    await settle()
    expect(location.pathname).toBe('/app/testbed/inbox/tasks/qn-1')
    const entries = history.length
    await drop()
    await waitFor(() => document.querySelector('[data-task-gone]'), 'the note')
    await settle()
    expect(location.pathname).toBe('/app/testbed/inbox/tasks/qn-1')
    expect(history.length).toBe(entries)
  })
})

describe('a project page whose project leaves while its delete waits', { timeout: 30_000 }, () => {
  it("keeps the page and its waiting window on a phone's Back", async () => {
    const live = await boot('/app/testbed/settings/project/2', true)
    const summary = { tasks: 1, archived_tasks: 0, more: false, sub_projects: [] }
    network.query.mockImplementation((ref) =>
      Promise.resolve(getFunctionName(ref) === 'projects:removalSummary' ? summary : null),
    )
    let accept = () => {}
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'projects:deleteDeep'
        ? new Promise((resolve) => {
            accept = () => resolve(null)
          })
        : Promise.resolve(null),
    )
    await press('Archive or delete…')
    const remove = await waitFor(
      () =>
        document.querySelector<HTMLInputElement>('[data-fate-card="delete"] input[type="radio"]'),
      'the delete choice',
    )
    await act(async () => remove.click())
    const deleteButton = await waitFor(
      () =>
        [...document.querySelectorAll<HTMLButtonElement>('[data-modal-shell] button')].find((b) =>
          b.textContent?.trim().startsWith('Delete '),
        ),
      'the delete button',
    )
    await act(async () => deleteButton.click())
    await settle()
    const address = location.pathname
    // the delivery that drops the sub-project lands before the answer
    await live.dropWork()
    await settle()
    expect(location.pathname).toBe(address)
    // the person's Back from the window's marker reaches the page's entry
    await act(async () => history.back())
    await settle()
    expect(document.querySelector('[data-modal-shell]')).not.toBeNull()
    expect(location.pathname).toBe(address)
    await act(async () => accept())
    await settle()
    expect(document.querySelector('[data-modal-shell]')).toBeNull()
  })
})

describe('a Forward that would close a comment not yet sent', { timeout: 30_000 }, () => {
  it('returns to the task by position without the Navigation API, keeps the entry after it, and Discard takes the Forward', async () => {
    await boot('/app/testbed/board/p/1', true, true)
    const row = await waitFor(
      () =>
        [...document.querySelectorAll<HTMLElement>('.mobile-task-row')].find((r) =>
          r.textContent?.includes('Calibrate the sensor'),
        ),
      'the task row',
    )
    await act(async () => row.click())
    await waitFor(() => document.querySelector('[data-task-chrome]'), 'the task window')
    await settle()
    // the other task from the search, then Back to the first
    await press('Search tasks and projects')
    await type(
      await waitFor(
        () => document.querySelector<HTMLInputElement>('[cmdk-root] input'),
        'the search box',
      ),
      'Order the parts',
    )
    const result = await waitFor(
      () =>
        [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find((item) =>
          item.textContent?.includes('Order the parts'),
        ),
      'the result',
    )
    await act(async () => result.click())
    await settle()
    expect(location.pathname).toBe('/app/testbed/board/tasks/qn-2')
    await act(async () => history.back())
    await settle()
    const task = location.pathname
    expect(task).toBe('/app/testbed/board/tasks/qn-1')
    const entries = history.length
    const composer = await waitFor(
      () =>
        document.querySelector<TiptapEditorHTMLElement>(
          '[role="textbox"][aria-label="Leave a comment"]',
        )?.editor,
      'the comment editor',
    )
    await act(async () => composer.commands.insertContent('Drift is under 2%'))
    const question = () => document.querySelector('[data-discard-prompt] h2')?.textContent ?? null
    await act(async () => history.forward())
    await settle()
    await waitFor(() => question(), 'the question')
    // nothing moved: the task's entry and the one after it stay
    expect(location.pathname).toBe(task)
    expect(history.length).toBe(entries)
    await press('Keep editing')
    await settle()
    expect(location.pathname).toBe(task)
    expect(composer.getText()).toBe('Drift is under 2%')
    await act(async () => history.forward())
    await settle()
    await waitFor(() => question(), 'the question again')
    await press('Discard')
    await settle()
    expect(location.pathname).toBe('/app/testbed/board/tasks/qn-2')
    expect(history.length).toBe(entries)
  })
})

describe('a pick from the Back menu past a task with a comment not yet sent', {
  timeout: 30_000,
}, () => {
  /** Opens task QN-1's window on a phone from the Board and types a comment
      in it. Answers the task's address. */
  async function taskWithComment() {
    await boot('/app/testbed/board/p/1', true)
    const row = await waitFor(
      () => document.querySelector<HTMLElement>('.mobile-task-row'),
      'the task row',
    )
    await act(async () => row.click())
    await waitFor(() => document.querySelector('[data-task-chrome]'), 'the task window')
    // the window takes focus once it opened, which would close a menu
    await waitFor(
      () => document.activeElement?.closest('[role="dialog"]'),
      'focus in the task window',
    )
    const composer = await waitFor(
      () =>
        document.querySelector<TiptapEditorHTMLElement>(
          '[role="textbox"][aria-label="Leave a comment"]',
        )?.editor,
      'the comment editor',
    )
    await act(async () => composer.commands.insertContent('Drift is under 2%'))
    await settle()
    return location.pathname
  }
  const question = () => document.querySelector('[data-discard-prompt] h2')?.textContent ?? null

  it('asks first and keeps the search open over the task', async () => {
    const task = await taskWithComment()
    // a layer that closes on any Back
    await press('Search tasks and projects')
    await waitFor(() => document.querySelector('[cmdk-root] input'), 'the search box')
    await settle()
    expect(history.state?.qivoLayer).toBeTruthy()
    // past the task's page, to the Board
    await act(async () => history.go(-2))
    await settle()
    await waitFor(() => question(), 'the question')
    expect(document.querySelector('[cmdk-root]')).not.toBeNull()
    expect(location.pathname).toBe(task)
  })

  it('holds the page for a dialog whose request still runs, and asks nothing', async () => {
    const task = await taskWithComment()
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'issues:archive' ? new Promise(() => {}) : Promise.resolve(null),
    )
    await press('Task actions')
    await press('Archive or delete…')
    // unfinished work needs a reason to be archived
    const reason = await waitFor(
      () => document.querySelector<HTMLTextAreaElement>('[data-modal-shell] textarea'),
      'the reason',
    )
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        reason,
        'Replaced by the new rig',
      )
      reason.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await press('Archive')
    await settle()
    expect(history.state?.qivoLayer).toBeTruthy()
    await act(async () => history.go(-2))
    await settle()
    expect(question()).toBeNull()
    expect(document.querySelector('[data-modal-shell]')).not.toBeNull()
    expect(location.pathname).toBe(task)
  })
})

describe('a Back that closes a phone layer over a task the workspace does not hold', {
  timeout: 30_000,
}, () => {
  it('keeps the window and its comment, asks nothing and reads the task no more', async () => {
    await boot('/app/testbed/board/p/1', true)
    await waitFor(() => document.querySelector('.mobile-task-row'), 'the task list')
    const { P } = await import('./store/planner')
    unheld = [
      {
        id: crypto.randomUUID(),
        org_id: P.homeOrg,
        project_id: 'work',
        num: 3,
        title: 'Replace the cable',
        description: '',
        status: 'todo',
        priority: 'medium',
        paused: false,
        created_at: AT,
        updated_at: AT,
        has_hidden_subtasks: false,
        has_hidden_parent: false,
      },
    ]
    await settle()
    await press('Search tasks and projects')
    await type(
      await waitFor(
        () => document.querySelector<HTMLInputElement>('[cmdk-root] input'),
        'the search box',
      ),
      'Replace',
    )
    const result = await waitFor(
      () =>
        [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find((item) =>
          item.textContent?.includes('Replace the cable'),
        ),
      'the result',
    )
    await act(async () => result.click())
    // the window shows the task from its own read, by a reference
    await waitFor(
      () =>
        document
          .querySelector('[data-task-chrome]')
          ?.closest('[role="dialog"]')
          ?.textContent?.includes('Replace the cable'),
      'the task window',
    )
    await settle()
    const task = location.pathname
    expect(task).toBe('/app/testbed/board/tasks/qn-3')
    const composer = await waitFor(
      () =>
        document.querySelector<TiptapEditorHTMLElement>(
          '[role="textbox"][aria-label="Leave a comment"]',
        )?.editor,
      'the comment editor',
    )
    await act(async () => composer.commands.insertContent('The old one is frayed'))
    const read = reads
    // a layer over the task, on an entry of the task's own address
    await press('Search tasks and projects')
    await waitFor(() => document.querySelector('[cmdk-root] input'), 'the search box again')
    await settle()
    expect(history.state?.qivoLayer).toBeTruthy()
    await act(async () => history.back())
    await settle()
    // Back closes the search and nothing else
    expect(document.querySelector('[cmdk-root]')).toBeNull()
    expect(document.querySelector('[data-discard-prompt] h2')).toBeNull()
    expect(location.pathname).toBe(task)
    expect(composer.getText()).toBe('The old one is frayed')
    expect(reads).toBe(read)
  })
})

describe('an archived task Search opened', { timeout: 30_000 }, () => {
  /** Boots on the project's Board on a desktop, opens Search, and opens
      from it the archived QN-7, or with `active` the active QN-1. Answers
      the page's address, the task's, and boot's publisher of a change. */
  async function openFromSearch(active = false) {
    const booted = await boot('/app/testbed/board/p/1', false)
    network.query.mockClear()
    const board = location.pathname
    archive = [
      {
        id: crypto.randomUUID(),
        org_id: (await import('./store/planner')).P.homeOrg,
        project_id: 'work',
        num: 7,
        title: 'Recalibrate the old sensor',
        description: '',
        status: 'done',
        priority: 'medium',
        paused: false,
        created_at: AT,
        updated_at: AT,
        archived_at: '2026-09-14T09:00:00.000Z',
        has_hidden_subtasks: false,
        has_hidden_parent: false,
      },
    ]
    const open = await waitFor(
      () => document.querySelector<HTMLButtonElement>('button[data-sidebar-search]'),
      'the sidebar search',
    )
    await settle()
    await act(async () => open.click())
    const search = await waitFor(
      () => document.querySelector<HTMLInputElement>('[cmdk-root] input'),
      'the search box',
    )
    await type(search, active ? 'Calibrate' : 'Recalibrate')
    if (!active) {
      const toggle = await waitFor(
        () => document.querySelector<HTMLElement>('[data-palette-archived]'),
        'the toggle',
      )
      await act(async () => toggle.click())
    }
    const result = await waitFor(
      () =>
        [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find((item) =>
          active
            ? item.textContent?.includes('Calibrate the sensor')
            : item.querySelector('[data-result-archived]'),
        ),
      'the result',
    )
    await act(async () => result.click())
    if (active) await shows('Calibrate the sensor')
    else await archivedNote()
    await settle()
    return { board, task: location.pathname, change: booted.change }
  }
  const openArchived = () => openFromSearch()
  /* Waits for an open task window that shows `title`. */
  const shows = (title: string) =>
    waitFor(
      () =>
        document
          .querySelector('[data-task-chrome]')
          ?.closest('[role="dialog"]')
          ?.textContent?.includes(title),
      title,
    )
  /* Makes the Testbed seat a guest seat and Other Co, a new seat, the home
     organization, whose active QN-1 and QN-7 take the numbers of Testbed's
     tasks. The Testbed seat keeps its grant on the project. */
  let otherOrg = ''
  const swapHome = (next: Snapshot) => {
    otherOrg = crypto.randomUUID()
    const seat = crypto.randomUUID()
    const meta = crypto.randomUUID()
    const sub = crypto.randomUUID()
    const [base, work] = next.projects
    next.orgs.push({ ...next.orgs[0], id: otherOrg, name: 'Other Co', slug: 'other' })
    next.profiles[0].org_role = 'guest'
    next.profiles.push({ ...next.profiles[0], id: seat, org_id: otherOrg, org_role: 'user' })
    next.myProfileIds.push(seat)
    next.access.push({ project_id: base.id, profile_id: next.profiles[0].id, level: 'user' })
    next.projects.push(
      { ...base, id: meta, org_id: otherOrg, key: 'OTH', num: 1, name: 'Other', lead_id: seat },
      {
        ...work,
        id: sub,
        org_id: otherOrg,
        key: 'OTHW',
        num: 2,
        name: 'Other work',
        parent_id: meta,
      },
    )
    for (const [num, title] of [
      [1, 'Plan the other rollout'],
      [7, 'Ship the other kit'],
    ] as const)
      next.issues.push({
        ...next.issues[0],
        id: crypto.randomUUID(),
        org_id: otherOrg,
        project_id: sub,
        num,
        title,
      })
  }
  /* Waits for the window's note that the task was archived. */
  const archivedNote = () =>
    waitFor(
      () =>
        document
          .querySelector('[data-task-gone] [role="status"]')
          ?.textContent?.includes('was archived'),
      'the archived note',
    )
  const asked = () => reads

  it('closes with an entry of its own, so Back opens it again', async () => {
    const { board, task } = await openArchived()
    expect(task).toBe('/app/testbed/board/tasks/qn-7')
    const entries = history.length
    const close = [...document.querySelectorAll<HTMLButtonElement>('[data-task-gone] button')].find(
      (b) => b.textContent === 'Close',
    )
    await act(async () => close?.click())
    await waitFor(() => !document.querySelector('[data-task-gone]'), 'the window to close')
    await settle()
    // the page below gets a new entry, as closing a loaded task does
    expect(location.pathname).toBe(board)
    expect(history.length).toBe(entries + 1)
    await act(async () => history.back())
    await settle()
    expect(location.pathname).toBe(task)
    await archivedNote()
    // the window reads the task again, by the number its address names in
    // its organization, then by its uuid
    expect(asked()).toBe(3)
  })

  it('opens again on Forward after the home organization changed, not the new home task of its number', async () => {
    const { board, task, change } = await openArchived()
    await act(async () => history.back())
    await waitFor(() => !document.querySelector('[data-task-gone]'), 'the window to close')
    await settle()
    expect(location.pathname).toBe(board)
    // Testbed becomes a guest seat, and Other Co's active QN-7 the home QN-7
    await change(swapHome)
    await settle()
    const { P } = await import('./store/planner')
    expect(P.homeOrg).toBe(otherOrg)
    expect(P.issueById['QN-7']?.title).toBe('Ship the other kit')
    await act(async () => history.forward())
    await settle()
    expect(location.pathname).toBe(task)
    await archivedNote()
    const window = document.querySelector('[data-task-gone]')?.closest('[role="dialog"]')
    expect(window?.textContent).toContain('Recalibrate the old sensor')
    expect(document.body.textContent).not.toContain('Ship the other kit')
  })

  it('opens an active result again after the home organization changed', async () => {
    const { board, task, change } = await openFromSearch(true)
    expect(task).toBe('/app/testbed/board/tasks/qn-1')
    await act(async () => history.back())
    await waitFor(() => !document.querySelector('[data-task-chrome]'), 'the window to close')
    await settle()
    expect(location.pathname).toBe(board)
    await change(swapHome)
    await settle()
    const { P } = await import('./store/planner')
    expect(P.issueById['QN-1']?.title).toBe('Plan the other rollout')
    await act(async () => history.forward())
    await settle()
    expect(location.pathname).toBe(task)
    await shows('Calibrate the sensor')
    expect(
      document.querySelector('[data-task-chrome]')?.closest('[role="dialog"]')?.textContent,
    ).not.toContain('Plan the other rollout')
  })

  it('opens again on Forward after Back closed it', async () => {
    const { board, task } = await openArchived()
    await act(async () => history.back())
    await waitFor(() => !document.querySelector('[data-task-gone]'), 'the window to close')
    await settle()
    expect(location.pathname).toBe(board)
    await act(async () => history.forward())
    await settle()
    expect(location.pathname).toBe(task)
    await archivedNote()
    expect(asked()).toBe(3)
  })
})

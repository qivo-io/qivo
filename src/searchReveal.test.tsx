// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIELD_CHANGED, printOf, trimmedForm } from '../convex/lib/fieldPrints'
import { TooltipProvider } from './components/ui/tooltip'
import { type BoardArgs, boardStandIn } from './store/boardStandIn.setup'
import { answerOverview } from './store/overviewStandIn.setup'
import { plannerFixture, type Snapshot, underProgram } from './store/plannerFixture.setup'
import { queryProjectNav } from './store/projectNavStandIn.setup'

/* A task picked in Search while the Board shows, and a task an Inbox row
   or the Inbox pane's Task actions open with Open task in board, on App
   and the real store in a session that never asked for every task. The task window opens over the Board,
   and the Board rings the task's card, which only its answer brings, as
   the workspace holds no task: App reveals the handle the Board names a
   referenced task by (P.handleOfOpen). And an Inbox row of another
   organization's task with the id of the home organization's task, which
   the Inbox pane shows with that organization's New mark, reads on open,
   comments on, saves a title to and uploads an image to in that
   organization, through that task's own answer, never as the home task,
   whose files its lists never show. A refused title save there rebases on
   that task's own title, and an upload there that the person discarded is
   removed in that organization once the pane shows the home task. And two
   unread rows of one task id in two organizations, where the pane goes
   from the first row's task to the second's and reads the second's
   item. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('./lib/convex', async () => {
  const { liveOver } = await import('./store/guard/liveDouble.setup')
  return { convex: network, live: liveOver(network, { taskWindow: 'client' }) }
})
vi.mock('./lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'
const SOAK = 'fd000000-0000-4000-8000-000000000002'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
  // jsdom has no element scrollTo, which the reveal scrolls the Board with
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
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
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
  localStorage.clear()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/* The arguments of each write of mutation `name` the store sent, in
   order. */
const sentArgs = (name: string) =>
  network.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === name)
    .map(([, args]) => args as Record<string, unknown>)

/* Types `value` into text field `field`, as a person does. */
const typeInto = (field: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
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

describe('a task picked in Search over the Board', { timeout: 30_000 }, () => {
  it("rings the Board's card of a task only the Board's answer brings, with no ask", async () => {
    vi.resetModules()
    history.replaceState(null, '', '/app/testbed/board/p/1')
    const snap: Snapshot = underProgram(plannerFixture())
    snap.orgs[0].next_issue_num = 2
    const project = snap.projects[0]
    snap.issues.push({
      id: SOAK,
      org_id: snap.orgs[0].id,
      project_id: project.id,
      num: 2,
      title: 'Run the soak test',
      description: '',
      status: 'progress',
      priority: 'medium',
      paused: false,
      created_at: AT,
      updated_at: AT,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    network.onUpdate.mockImplementation((ref, args, next, fail) => {
      const name = getFunctionName(ref)
      if (name === 'workspace:whole') next(structuredClone(snap))
      else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
      else if (name === 'tasks:board') next(boardStandIn(snap, args as BoardArgs))
      else if (name.startsWith('overview:')) answerOverview(snap, name, args, next, fail)
      return () => {}
    })
    // Search finds the task on the server, and the Board's address by
    // number resolves through projectNav.resolve
    network.query.mockImplementation(async (ref, args) =>
      getFunctionName(ref) === 'projectNav:resolve'
        ? queryProjectNav(snap, 'projectNav:resolve', args)
        : getFunctionName(ref) === 'search:page'
          ? {
              rows: [
                {
                  kind: 'task',
                  org_id: snap.orgs[0].id,
                  id: SOAK,
                  num: 2,
                  title: 'Run the soak test',
                  status: 'progress',
                  is_group: false,
                  archived: false,
                  project: { id: project.id, name: project.name },
                  parent: null,
                },
              ],
              next_cursor: null,
              coverage: { complete: true },
            }
          : null,
    )
    network.mutation.mockResolvedValue(null)
    const store = await import('./store/planner')
    await store.initStore()
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
    const card = () => document.querySelector<HTMLElement>('[data-card="QN-2"]')
    await waitFor(card, "the Board's card")
    await act(async () => document.querySelector<HTMLElement>('[data-sidebar-search]')?.click())
    const input = await waitFor(
      () =>
        document.querySelector<HTMLInputElement>('input[aria-label="Search tasks and projects"]'),
      'Search',
    )
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'soak')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const result = await waitFor(
      () => document.querySelector<HTMLElement>('[cmdk-item][data-value="issue-QN-2"]'),
      'the result',
    )
    await act(async () => result.click())
    // the window opens over the Board, which rings the card
    await waitFor(() => location.pathname.endsWith('/tasks/qn-2'), "the task's address")
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    await waitFor(
      () => card()?.closest('.board-card')?.hasAttribute('data-board-revealed'),
      'the ring',
    )
  })
})

describe("an Inbox row's Open task in board", { timeout: 30_000 }, () => {
  it("rings the Board's card of a task the workspace does not hold, by its handle", async () => {
    vi.resetModules()
    history.replaceState(null, '', '/app/~/inbox')
    const snap: Snapshot = underProgram(plannerFixture())
    snap.orgs[0].next_issue_num = 2
    const project = snap.projects[0]
    snap.issues.push({
      id: SOAK,
      org_id: snap.orgs[0].id,
      project_id: project.id,
      num: 2,
      title: 'Run the soak test',
      description: '',
      status: 'progress',
      priority: 'medium',
      paused: false,
      created_at: AT,
      updated_at: AT,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    snap.messages.push({
      id: 'message-soak',
      org_id: snap.orgs[0].id,
      recipient_id: snap.profiles[0].id,
      issue_id: SOAK,
      issue_title: 'Run the soak test',
      kind: 'comment',
      detail: 'New comment',
      created_at: AT,
    })
    network.onUpdate.mockImplementation((ref, args, next, fail) => {
      const name = getFunctionName(ref)
      if (name === 'workspace:whole') next(structuredClone(snap))
      else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
      else if (name === 'tasks:board') next(boardStandIn(snap, args as BoardArgs))
      else if (name.startsWith('overview:')) answerOverview(snap, name, args, next, fail)
      return () => {}
    })
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
    const store = await import('./store/planner')
    await store.initStore()
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
    const row = await waitFor(
      () => document.querySelector<HTMLElement>(`[data-message="${SOAK}"]`),
      "the Inbox's row",
    )
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    const board = await waitFor(
      () => document.querySelector<HTMLElement>('[data-msg-menu-board]'),
      'Open task in board',
    )
    await act(async () => board.click())
    // the Board of the task's project, its window over it and its card ringed
    const card = () => document.querySelector<HTMLElement>('[data-card="QN-2"]')
    await waitFor(
      () => card()?.closest('.board-card')?.hasAttribute('data-board-revealed'),
      'the ring',
    )
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
})

describe("the Inbox pane's Open task in board", { timeout: 30_000 }, () => {
  it("rings the Board's card of a task the pane shows from its answer, by its reference", async () => {
    vi.resetModules()
    history.replaceState(null, '', '/app/~/inbox')
    const snap: Snapshot = underProgram(plannerFixture())
    snap.orgs[0].next_issue_num = 2
    const project = snap.projects[0]
    snap.issues.push({
      id: SOAK,
      org_id: snap.orgs[0].id,
      project_id: project.id,
      num: 2,
      title: 'Run the soak test',
      description: '',
      status: 'progress',
      priority: 'medium',
      paused: false,
      created_at: AT,
      updated_at: AT,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    snap.messages.push({
      id: 'message-soak',
      org_id: snap.orgs[0].id,
      recipient_id: snap.profiles[0].id,
      issue_id: SOAK,
      issue_title: 'Run the soak test',
      kind: 'comment',
      detail: 'New comment',
      created_at: AT,
    })
    network.onUpdate.mockImplementation((ref, args, next, fail) => {
      const name = getFunctionName(ref)
      const a = args as { org_id?: string; ref?: string }
      if (name === 'workspace:whole') next(structuredClone(snap))
      else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
      else if (name === 'tasks:board') next(boardStandIn(snap, args as BoardArgs))
      else if (name.startsWith('overview:')) answerOverview(snap, name, args, next, fail)
      else if (name === 'taskWindow:task') {
        // the window's own read, of the task the workspace does not hold
        const row = snap.issues.find((it) => it.org_id === a.org_id && it.id === a.ref)
        if (row)
          next({
            state: 'ok',
            task: { ...row, has_subtasks: false },
            level: 'lead',
            labels: [],
            follow: null,
            parent: null,
            subtasks: { rows: [], complete: true },
          })
      }
      return () => {}
    })
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
    const store = await import('./store/planner')
    await store.initStore()
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
    const open = await waitFor(
      () => document.querySelector<HTMLElement>(`[data-message="${SOAK}"] .inbox-message-open`),
      "the Inbox's row",
    )
    await act(async () => open.click())
    // the pane shows the task from its own read
    await waitFor(
      () => document.querySelector('[data-task-title]')?.textContent === 'Run the soak test',
      "the pane's task",
    )
    const actions = await waitFor(
      () => document.querySelector<HTMLElement>('[aria-label="Task actions"]'),
      'Task actions',
    )
    await act(async () => actions.click())
    const board = await waitFor(
      () => document.querySelector<HTMLElement>('[data-task-open-board]'),
      'Open task in board',
    )
    await act(async () => board.click())
    // the Board of the task's project, its window over it and its card ringed
    const card = () => document.querySelector<HTMLElement>('[data-card="QN-2"]')
    await waitFor(
      () => card()?.closest('.board-card')?.hasAttribute('data-board-revealed'),
      'the ring',
    )
    await waitFor(
      () => document.querySelector('[role="dialog"] [data-task-title]')?.textContent,
      "the window's task",
    )
    expect(document.querySelector('[role="dialog"] [data-task-title]')?.textContent).toBe(
      'Run the soak test',
    )
    // the window opened the task by the same reference as the row menu
    const { refParts } = await import('./lib/taskReference')
    expect(refParts(store.P.reference?.ref)).toEqual({ org: snap.orgs[0].id, num: 2, uuid: SOAK })
  })
})

/* The guest organization of the two-organization Inbox cases. */
const GUEST = 'org-guest'
/* The home task's file in the two-organization Inbox cases. */
const HOME_FILE = 'fa000000-0000-4000-8000-000000000001'

/* Two organizations that each hold a task of id SOAK, on App's Inbox: the
   home organization's QN-2 'Run the soak test', with a file, HOME_FILE,
   when `homeFile`, and the guest organization's QN-7 'Calibrate the guest
   rig'. Only the server holds them. Each has an Inbox
   item, the home one read when `homeRead`, and the guest one unread with
   a comment on its thread after it. The window's own read answers the
   task of the organization it names, and its links and attachments reads
   never answer. */
async function twoOrganizations({ homeFile, homeRead }: { homeFile: boolean; homeRead: boolean }) {
  vi.resetModules()
  history.replaceState(null, '', '/app/~/inbox')
  const snap: Snapshot = underProgram(plannerFixture())
  const me = snap.profiles[0]
  const home = snap.orgs[0].id
  snap.orgs.push({ ...snap.orgs[0], id: GUEST, slug: 'guest', name: 'Guest Co' })
  snap.profiles.push({ ...me, id: 'me-guest', org_id: GUEST })
  snap.myProfileIds.push('me-guest')
  // my guest seat leads Guest work, so it edits that organization's task;
  // like the home seat it is an organization admin, which gives no level.
  // It sits under a top-level project of its own organization, as every
  // writer stores one that holds tasks
  const guestProgram = {
    ...snap.projects[0],
    id: 'guest-program',
    org_id: GUEST,
    type: 'meta' as const,
    key: 'GPRG',
    name: 'Guest program',
    parent_id: undefined,
    lead_id: 'me-guest',
  }
  const guestProject = {
    ...snap.projects[0],
    id: 'guest-work',
    org_id: GUEST,
    name: 'Guest work',
    parent_id: guestProgram.id,
    lead_id: 'me-guest',
  }
  snap.projects.push(guestProgram, guestProject)
  const task = (org: string, project: string, num: number, title: string) => ({
    id: SOAK,
    org_id: org,
    project_id: project,
    num,
    title,
    description: '',
    status: 'progress' as const,
    priority: 'medium' as const,
    paused: false,
    created_at: AT,
    updated_at: AT,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  // the tasks the parts do not send, which only the server holds
  const homeTask = task(home, snap.projects[0].id, 2, 'Run the soak test')
  const guestTask = task(GUEST, guestProject.id, 7, 'Calibrate the guest rig')
  if (homeFile) {
    snap.issues.push(homeTask)
    snap.attachments.push({
      id: HOME_FILE,
      issue_id: SOAK,
      name: 'soak-log.txt',
      mime: 'text/plain',
      size_bytes: 1200,
      storage_id: 'storage-soak-log',
      inline: false,
      created_at: AT,
    } as Snapshot['attachments'][number])
  }
  const unheld = homeFile ? [guestTask] : [homeTask, guestTask]
  Object.assign(snap, { unheld: { issues: unheld } })
  for (const [org, recipient, read] of [
    [home, me.id, homeRead],
    [GUEST, 'me-guest', false],
  ] as const)
    snap.messages.push({
      id: `message-${org}`,
      org_id: org,
      recipient_id: recipient,
      issue_id: SOAK,
      issue_title: 'News',
      kind: 'comment',
      detail: 'New comment',
      created_at: AT,
      ...(read ? { read_at: AT } : {}),
    })
  const guestComment = {
    id: 'fe000000-0000-4000-8000-000000000001',
    issue_id: SOAK,
    author: 'me-guest',
    body: 'The rig drifts',
    created_at: '2026-09-14T08:05:00.000Z',
  }
  const taskAnswer = (row: typeof homeTask) => ({
    state: 'ok',
    task: { ...row, has_subtasks: false },
    level: 'lead',
    labels: [],
    follow: null,
    parent: null,
    subtasks: { rows: [], complete: true },
  })
  // the watches of the window's own read of the guest task
  const guestReads = new Set<(value: unknown) => void>()
  network.onUpdate.mockImplementation((ref, args, next) => {
    const name = getFunctionName(ref)
    const a = args as { org_id?: string; ref?: string }
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'snapshot:threadComments')
      next({ comments: a.org_id === GUEST ? [guestComment] : [], earlier: false })
    else if (name === 'taskWindow:task') {
      // the window's own read, of the task of the organization it names
      const row = [homeTask, guestTask].find((it) => it.org_id === a.org_id && it.id === a.ref)
      if (row) next(taskAnswer(row))
      if (row === guestTask) guestReads.add(next)
    }
    return () => {}
  })
  network.query.mockResolvedValue(null)
  // only this case's writes
  network.mutation.mockReset()
  network.mutation.mockResolvedValue(null)
  const store = await import('./store/planner')
  await store.initStore()
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
  return {
    store,
    home,
    /** The open control of organization `org`'s row of the task. */
    rowOpen: (org: string) =>
      waitFor(
        () =>
          document.querySelector<HTMLElement>(
            `[data-message-key="${org}:${SOAK}"] .inbox-message-open`,
          ),
        `the row of ${org}`,
      ),
    /** The pane's task title. */
    title: () => document.querySelector('[data-task-title]')?.textContent,
    /** The reads of an item the store sent, in order. */
    reads: () => sentArgs('messages:readItem'),
    /** Renames the guest task to `title` on the server, as another member
        does, and answers the window's reads of it again. */
    renameGuest: (title: string) =>
      act(async () => {
        guestTask.title = title
        for (const next of guestReads) next(taskAnswer(guestTask))
      }),
  }
}

/* Answers each image upload's post with a stored file, at once, or with
   `hold` only once release() lets it, and answers the upload's writes as
   the server does. */
function stubUploads({ hold }: { hold: boolean }) {
  let release = () => {}
  const answer = { ok: true, status: 200, json: async () => ({ storageId: 'st-1' }) }
  const posted = hold
    ? new Promise((resolve) => {
        release = () => resolve(answer)
      })
    : Promise.resolve(answer)
  const fetch = vi.fn(() => posted)
  vi.stubGlobal('fetch', fetch)
  network.query.mockImplementation((ref) =>
    Promise.resolve(
      getFunctionName(ref) === 'files:mintUrls' ? { attachments: {}, avatars: {} } : null,
    ),
  )
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'files:uploadUrl') return Promise.resolve('https://convex.example/upload')
    if (name !== 'files:attach') return Promise.resolve(null)
    return Promise.resolve({
      attachment: {
        id: args.id,
        issue_id: args.issue_id,
        name: args.name,
        mime: args.mime,
        size_bytes: 3,
        storage_id: 'st-1',
        inline: true,
        created_at: AT,
      },
    })
  })
  return { posts: () => fetch.mock.calls.length, release: () => act(async () => release()) }
}

/* Opens the description editor of the task the Inbox pane shows and
   pastes an image into it. */
async function pasteImage() {
  await act(async () =>
    document.querySelector<HTMLElement>('.inbox-detail-frame [data-desc-toggle]')?.click(),
  )
  const description = await waitFor(
    () =>
      document.querySelector<TiptapEditorHTMLElement>(
        '[role="textbox"][aria-label="Task description"]',
      )?.editor,
    'the description editor',
  )
  const image = new File(['png'], 'photo.png', { type: 'image/png' })
  await act(async () => {
    description.view.pasteHTML('', {
      clipboardData: { files: [image], getData: () => '' },
      preventDefault: () => {},
    } as unknown as ClipboardEvent)
  })
}

describe("an Inbox row of another organization's task with the home task's id", {
  timeout: 30_000,
}, () => {
  it("shows, reads and edits that organization's task in the pane, never the home one", async () => {
    const { store, home, rowOpen, title, reads, renameGuest } = await twoOrganizations({
      homeFile: true,
      homeRead: true,
    })
    const divider = () => document.querySelector('.inbox-detail-frame [data-unread-divider]')
    // the home task's row opens it, whose item is read, so it shows no New
    // mark and sends no read
    const homeRow = await rowOpen(home)
    await act(async () => homeRow.click())
    await waitFor(() => title() === 'Run the soak test', "the home task's title")
    await waitFor(
      () =>
        store.P.inboxItem?.org === home &&
        store.P.inboxItem.state === 'ok' &&
        store.P.inboxItem.current,
      "the home task's item",
    )
    expect(divider()).toBeNull()
    const pane = () => document.querySelector('.inbox-detail-frame > *')
    const homePane = pane()
    expect(homePane).not.toBeNull()
    // the guest organization's row of the same id shows that task instead,
    // in a window of its own, as another task's
    const guestRow = await rowOpen(GUEST)
    await act(async () => guestRow.click())
    await waitFor(() => title() === 'Calibrate the guest rig', "the guest task's title")
    expect(pane()).not.toBe(homePane)
    // with that organization's New mark, frozen from its own item, not the
    // home task's read one
    await waitFor(divider, "the guest task's New mark")
    expect(divider()?.getAttribute('data-unread-divider')).toBe('mark')
    // and its read on open reads that organization's item
    await waitFor(() => reads().length === 1, 'the read on open')
    expect(reads()).toEqual([expect.objectContaining({ org_id: GUEST, issue_id: SOAK })])
    expect(location.pathname).toBe('/app/guest/inbox/tasks/qn-7')
    expect(title()).toBe('Calibrate the guest rig')
    // its pop-out shows its lists, which wait for its own answers and never
    // list the home task's file, which a Remove there would delete
    await act(async () =>
      document.querySelector<HTMLElement>('.inbox-detail-frame [data-task-popout]')?.click(),
    )
    const popOut = () => document.querySelector('[role="dialog"]:not(.inbox-detail-frame *)')
    const files = await waitFor(
      () => popOut()?.querySelector('[data-section="attachments"]'),
      "the pop-out's attachments",
    )
    expect(store.P.detail?.org).toBe(GUEST)
    expect(store.P.sections?.task).toBe(SOAK)
    expect(store.P.sections?.attachments.rows).toEqual([])
    expect(files.textContent).not.toContain('soak-log.txt')
    await act(async () => popOut()?.querySelector<HTMLElement>('[data-task-close]')?.click())
    expect(popOut()).toBeNull()
    // a comment typed there goes to that organization's task too
    const composer = await waitFor(
      () =>
        document.querySelector<TiptapEditorHTMLElement>(
          '[role="textbox"][aria-label="Leave a comment"]',
        )?.editor,
      'the comment editor',
    )
    await act(async () => composer.chain().focus().insertContent('Rig calibrated').run())
    const send = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Comment')
    await act(async () => send?.click())
    expect(sentArgs('comments:create').map((args) => args.org_id)).toEqual([GUEST])
    // a title saved there goes to that organization's task through its own
    // answer. Another member renames the task while the field is open, so
    // the server refuses the first save over that rename, and the field
    // opens again with the draft over that organization's title, never the
    // home task's. It refuses the next save for another reason, and the
    // field opens again with the draft, whose last save goes through over
    // the rename
    const refusals: unknown[] = [
      new ConvexError({
        code: 'conflict',
        reason: FIELD_CHANGED,
        message: 'The title of QN-7 changed since you read it',
        changes: [{ record: 'task', id: SOAK, field: 'title', by: 'guest-member', at: AT }],
      }),
      new ConvexError({ code: 'rule', message: 'The title is locked.' }),
    ]
    network.mutation.mockImplementation((ref) => {
      const refusal = getFunctionName(ref) === 'issues:update' ? refusals.shift() : undefined
      return refusal ? Promise.reject(refusal) : Promise.resolve(null)
    })
    const titleField = () =>
      waitFor(
        () => document.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]'),
        'the title field',
      )
    await act(async () => document.querySelector<HTMLElement>('[data-task-title]')?.click())
    const first = await titleField()
    await typeInto(first, 'Calibrate the guest rig twice')
    await renameGuest('Calibrate the guest rig at noon')
    await act(async () => first.blur())
    for (let refusal = 0; refusal < 2; refusal++) {
      const kept = await titleField()
      expect(kept.value).toBe('Calibrate the guest rig twice')
      await act(async () => kept.blur())
    }
    const save = { org_id: GUEST, id: SOAK, patch: { title: 'Calibrate the guest rig twice' } }
    const seen = (shown: string) => ({ ...save, expected: { title: printOf(trimmedForm(shown)) } })
    expect(sentArgs('issues:update')).toEqual([
      seen('Calibrate the guest rig'),
      seen('Calibrate the guest rig at noon'),
      seen('Calibrate the guest rig at noon'),
    ])
    expect(title()).toBe('Calibrate the guest rig twice')
    // an image pasted into its description uploads to that organization's
    // task too
    stubUploads({ hold: false })
    await pasteImage()
    await waitFor(() => sentArgs('files:attach').length === 1, "the image's attach")
    expect(sentArgs('files:uploadUrl')).toEqual([
      { org_id: GUEST, issue_id: SOAK, size: 3, name: 'photo.png' },
    ])
    expect(sentArgs('files:attach')).toEqual([
      expect.objectContaining({ org_id: GUEST, issue_id: SOAK, inline: true }),
    ])
  })

  it('removes an image of that task whose draft was discarded in that organization, though the pane moved to the home task before it uploaded', async () => {
    const { store, home, rowOpen, title } = await twoOrganizations({
      homeFile: true,
      homeRead: true,
    })
    const guestRow = await rowOpen(GUEST)
    await act(async () => guestRow.click())
    await waitFor(() => title() === 'Calibrate the guest rig', "the guest task's title")
    // an image pasted into its description uploads, and the person
    // discards the draft and opens the home task's row before it finished
    const upload = stubUploads({ hold: true })
    await pasteImage()
    await waitFor(() => upload.posts() === 1, "the image's post")
    const discard = await waitFor(
      () =>
        [...document.querySelectorAll('.inbox-detail-frame button')].find(
          (b): b is HTMLElement => b.textContent === 'Discard changes',
        ),
      "the description's Discard changes",
    )
    await act(async () => discard.click())
    const homeRow = await rowOpen(home)
    await act(async () => homeRow.click())
    await waitFor(() => title() === 'Run the soak test', "the home task's title")
    await waitFor(() => store.P.detail?.org !== GUEST, 'the store on the home task')
    // the upload finishes in that organization's task, which no text holds,
    // so its file goes again, in that organization, never the home task's
    await upload.release()
    await waitFor(() => sentArgs('files:removeAttachment').length === 1, "the image's removal")
    const [attach] = sentArgs('files:attach')
    expect(attach).toEqual(expect.objectContaining({ org_id: GUEST, issue_id: SOAK }))
    expect(sentArgs('files:removeAttachment')).toEqual([{ org_id: GUEST, id: attach.id }])
  })
})

describe('two Inbox rows of one task id in two organizations, both unread', {
  timeout: 30_000,
}, () => {
  it("switches the pane from the first row's task to the second's and reads it there", async () => {
    const { store, home, rowOpen, title, reads } = await twoOrganizations({
      homeFile: false,
      homeRead: false,
    })
    // the home organization's row opens its task from its own read, and
    // reads its item
    const homeRow = await rowOpen(home)
    await act(async () => homeRow.click())
    await waitFor(() => title() === 'Run the soak test', "the home task's title")
    await waitFor(() => reads().length === 1, "the home task's read on open")
    // the guest organization's row of the same id then shows that task,
    // from a read of its own, and reads that organization's item
    const guestRow = await rowOpen(GUEST)
    await act(async () => guestRow.click())
    await waitFor(() => title() === 'Calibrate the guest rig', "the guest task's title")
    await waitFor(() => reads().length === 2, "the guest task's read on open")
    expect(reads()).toEqual([
      expect.objectContaining({ org_id: home, issue_id: SOAK }),
      expect.objectContaining({ org_id: GUEST, issue_id: SOAK }),
    ])
    expect(store.P.detail?.org).toBe(GUEST)
    expect(location.pathname).toBe('/app/guest/inbox/tasks/qn-7')
  })
})

// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { type BoardArgs, boardStandIn } from './store/boardStandIn.setup'
import { answerOverview } from './store/overviewStandIn.setup'
import { plannerFixture, type Snapshot, underProgram } from './store/plannerFixture.setup'

/* A task picked in Search while the Board shows, and a task an Inbox row
   or the Inbox pane's Task actions open with Open task in board, on App
   and the real store in a session that never asked for every task. The task window opens over the Board,
   and the Board rings the task's card, which only its answer brings, as
   the workspace holds no task: App reveals the handle the Board names a
   referenced task by (P.handleOfOpen). And an Inbox row of another
   organization's task with the id of a task the workspace holds, which
   the Inbox pane shows with that organization's New mark, reads on open,
   comments on, saves a title to and uploads an image to in that
   organization, through that task's own answer, never as the held task.
   And two rows of one task id
   in two organizations, neither held, where the pane goes from the first
   row's task to the second's and reads the second's item. */

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
  const { TASKS } = await import('./store/liveParts')
  TASKS.atBoot = true
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
    // Search finds the task on the server
    network.query.mockImplementation(async (ref) =>
      getFunctionName(ref) === 'search:page'
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
    const { TASKS } = await import('./store/liveParts')
    // the app's boot, without the test default's every task
    TASKS.atBoot = false
    const store = await import('./store/planner')
    await store.initStore()
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
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
    expect(store.P.handleOf(SOAK)).toBeNull()
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
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
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
    const { TASKS } = await import('./store/liveParts')
    TASKS.atBoot = false
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
    expect(store.P.handleOf(SOAK)).toBeNull()
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
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
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
    const { TASKS } = await import('./store/liveParts')
    TASKS.atBoot = false
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
    expect(store.P.handleOf(SOAK)).toBeNull()
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
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
  })
})

/* The guest organization of the two-organization Inbox cases. */
const GUEST = 'org-guest'

/* Two organizations that each hold a task of id SOAK, on App's Inbox: the
   home organization's QN-2 'Run the soak test', which the workspace holds
   when `homeHeld`, else only the server does, and the guest
   organization's QN-7 'Calibrate the guest rig', which only the server
   holds. Each has an Inbox item, the home one read when `homeRead`, and
   the guest one unread with a comment on its thread after it. The
   window's own read answers the task of the organization it names. */
async function twoOrganizations({ homeHeld, homeRead }: { homeHeld: boolean; homeRead: boolean }) {
  vi.resetModules()
  history.replaceState(null, '', '/app/~/inbox')
  const snap: Snapshot = underProgram(plannerFixture())
  const me = snap.profiles[0]
  const home = snap.orgs[0].id
  snap.orgs.push({ ...snap.orgs[0], id: GUEST, slug: 'guest', name: 'Guest Co' })
  snap.profiles.push({ ...me, id: 'me-guest', org_id: GUEST })
  snap.myProfileIds.push('me-guest')
  const guestProject = {
    ...snap.projects[0],
    id: 'guest-work',
    org_id: GUEST,
    name: 'Guest work',
    parent_id: undefined,
  }
  snap.projects.push(guestProject)
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
  if (homeHeld) snap.issues.push(homeTask)
  const unheld = homeHeld ? [guestTask] : [homeTask, guestTask]
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
  network.onUpdate.mockImplementation((ref, args, next) => {
    const name = getFunctionName(ref)
    const a = args as { org_id?: string; ref?: string }
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'snapshot:threadComments')
      next({ comments: a.org_id === GUEST ? [guestComment] : [], earlier: false })
    else if (name === 'taskWindow:task') {
      // the window's own read, of the task of the organization it names
      const row = [homeTask, guestTask].find((it) => it.org_id === a.org_id && it.id === a.ref)
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
  }
}

describe("an Inbox row of another organization's task with a held task's id", {
  timeout: 30_000,
}, () => {
  it("shows, reads and edits that organization's task in the pane, never the held one", async () => {
    const { store, home, rowOpen, title, reads } = await twoOrganizations({
      homeHeld: true,
      homeRead: true,
    })
    expect(store.P.issueById[store.P.handleOf(SOAK) ?? '']?.org).toBe(home)
    const divider = () => document.querySelector('.inbox-detail-frame [data-unread-divider]')
    // the held task's row opens it, whose item is read, so it shows no New
    // mark and sends no read
    const homeRow = await rowOpen(home)
    await act(async () => homeRow.click())
    await waitFor(() => title() === 'Run the soak test', "the held task's title")
    await waitFor(
      () =>
        store.P.inboxItem?.org === home &&
        store.P.inboxItem.state === 'ok' &&
        store.P.inboxItem.current,
      "the held task's item",
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
    // held task's read one
    await waitFor(divider, "the guest task's New mark")
    expect(divider()?.getAttribute('data-unread-divider')).toBe('mark')
    // and its read on open reads that organization's item
    await waitFor(() => reads().length === 1, 'the read on open')
    expect(reads()).toEqual([expect.objectContaining({ org_id: GUEST, issue_id: SOAK })])
    expect(location.pathname).toBe('/app/guest/inbox/tasks/qn-7')
    expect(title()).toBe('Calibrate the guest rig')
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
    // answer. The server refuses the first save, and the field opens again
    // with the draft, whose next save goes through, while the held task of
    // the same id keeps its title
    let refuse = true
    network.mutation.mockImplementation((ref) => {
      if (getFunctionName(ref) !== 'issues:update' || !refuse) return Promise.resolve(null)
      refuse = false
      return Promise.reject(new ConvexError({ code: 'rule', message: 'The title is locked.' }))
    })
    const held = () => store.P.issueById[store.P.handleOf(SOAK) ?? '']
    await act(async () => document.querySelector<HTMLElement>('[data-task-title]')?.click())
    const titleField = await waitFor(
      () => document.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]'),
      'the title field',
    )
    await typeInto(titleField, 'Calibrate the guest rig twice')
    await act(async () => titleField.blur())
    const kept = await waitFor(
      () => document.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]'),
      'the title field after the refusal',
    )
    expect(kept.value).toBe('Calibrate the guest rig twice')
    await act(async () => kept.blur())
    const save = { org_id: GUEST, id: SOAK, patch: { title: 'Calibrate the guest rig twice' } }
    expect(sentArgs('issues:update')).toEqual([
      expect.objectContaining(save),
      expect.objectContaining(save),
    ])
    expect(title()).toBe('Calibrate the guest rig twice')
    expect(held()?.title).toBe('Run the soak test')
    // the id alone names either task, so a write by it fails closed
    expect(await store.P.updateIssue(SOAK, { title: 'Calibrate by id' })).toBe(false)
    expect(sentArgs('issues:update')).toHaveLength(2)
    // an image pasted into its description uploads to that organization's
    // task too, and its file never shows on the held task
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ storageId: 'st-1' }) })),
    )
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
    await waitFor(() => sentArgs('files:attach').length === 1, "the image's attach")
    expect(sentArgs('files:uploadUrl')).toEqual([
      { org_id: GUEST, issue_id: SOAK, size: 3, name: 'photo.png' },
    ])
    expect(sentArgs('files:attach')).toEqual([
      expect.objectContaining({ org_id: GUEST, issue_id: SOAK, inline: true }),
    ])
    expect(held()?.attachmentCount).toBe(0)
  })
})

describe('two Inbox rows of one task id in two organizations, neither held', {
  timeout: 30_000,
}, () => {
  it("switches the pane from the first row's task to the second's and reads it there", async () => {
    const { store, home, rowOpen, title, reads } = await twoOrganizations({
      homeHeld: false,
      homeRead: false,
    })
    expect(store.P.handleOf(SOAK)).toBeNull()
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

// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { type BoardArgs, boardStandIn } from '../store/boardStandIn.setup'
import { answerOverview } from '../store/overviewStandIn.setup'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The New task dialog's Create on App's own create wiring, in a store that
   never asked for every task, as the app boots: the window opens on the
   new task by a reference with focus in it, App toasts the task's key,
   the Board shows its card, and the window takes a change at once while
   its controls that read the server wait until the task is saved. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('../store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

let container: HTMLDivElement
let root: Root
let toast: MockInstance
/* The writes the store sent, in order, with their arguments, and the
   create's answer. */
let sent: string[]
let sentArgs: { name: string; args: Record<string, unknown> }[]
let accept: (num: number) => void
/* The window's reads of its task (taskWindow:task), oldest first, and the
   row the server stored for the create once it answered. */
let taskReads: {
  args: Record<string, unknown>
  next: (value: unknown) => void
  fail: (error: unknown) => void
}[]
let storedRow: Snapshot['issues'][number] | null
/* When the server stored the create. */
const STORED_AT = '2026-10-20T10:00:05.000Z'

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.getAnimations = () => []
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
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
  const { TASKS } = await import('../store/liveParts')
  TASKS.atBoot = true
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
const buttonNamed = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)

/** Renders App at `path` on a project the person leads, Plan, over its
    sub-project Work (QN numbers from 41), in a store that never asked for
    every task. The Board answers from the server's rows, and the create
    waits until `accept`. */
async function app(path: string) {
  vi.resetModules()
  history.replaceState(null, '', path)
  const snap: Snapshot = plannerFixture()
  const base = snap.projects[0]
  snap.projects = [
    { ...base, id: 'plan', type: 'meta', key: 'PLAN', name: 'Plan', lead_id: snap.profiles[0].id },
    { ...base, id: 'work', key: 'WORK', num: 2, name: 'Work', parent_id: 'plan' },
  ]
  snap.orgs[0].next_issue_num = 40
  let server = snap
  const boards = new Set<{ args: BoardArgs; next: (value: unknown) => void }>()
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'tasks:board') {
      const read = { args: args as BoardArgs, next }
      boards.add(read)
      next(boardStandIn(server, read.args))
      return () => boards.delete(read)
    } else if (name === 'taskWindow:task') taskReads.push({ args, next, fail })
    else if (name.startsWith('overview:')) answerOverview(snap, name, args, next, fail)
    return () => {}
  })
  network.query.mockResolvedValue(null)
  sent = []
  sentArgs = []
  taskReads = []
  storedRow = null
  // Convex answers one client's writes in the order sent: a write sent
  // behind the create answers after it
  let behind: Promise<unknown> = Promise.resolve()
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    sent.push(name)
    sentArgs.push({ name, args })
    if (name.startsWith('issues:') && name !== 'issues:create') return behind.then(() => null)
    if (name !== 'issues:create')
      return name.startsWith('comments:') ? new Promise(() => {}) : Promise.resolve(null)
    const answered = new Promise((resolve) => {
      accept = (num) => {
        // the Board's answer holds the stored task before the create
        // answers; the server stores no field the create sent as null, and
        // stamps the row
        const kept = Object.entries(args as Record<string, unknown>).filter(
          ([, value]) => value !== null,
        )
        const row = {
          ...(Object.fromEntries(kept) as Snapshot['issues'][number]),
          num,
          org_id: snap.orgs[0].id,
          status_at: STORED_AT,
          created_at: STORED_AT,
          updated_at: STORED_AT,
          has_hidden_subtasks: false,
          has_hidden_parent: false,
        }
        storedRow = row
        server = { ...server, issues: [...server.issues, row] }
        for (const read of boards) read.next(boardStandIn(server, read.args))
        // issues.create answers the stored row without its text
        const { description: _text, ...answer } = row
        resolve(answer)
      }
    })
    behind = answered
    return answered
  })
  const { TASKS } = await import('../store/liveParts')
  TASKS.atBoot = false
  const store = await import('../store/planner')
  await store.initStore()
  const { syncStatus } = await import('../lib/syncStatus')
  syncStatus.setSocket({ connected: true, everConnected: true })
  const { default: App } = await import('../App')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <App />
      </TooltipProvider>,
    ),
  )
  toast = vi.spyOn(window as { showToast: NonNullable<typeof window.showToast> }, 'showToast')
  return store
}

/** Creates `title` through the New task button and the dialog. */
async function createTask(title: string) {
  const add = await waitFor(() => buttonNamed('New task'), 'the New task button')
  await act(async () => add.click())
  const field = await waitFor(
    () => document.querySelector<HTMLInputElement>('input[aria-label="Title"]'),
    'the Title field',
  )
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    set?.call(field, title)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => buttonNamed('Create')?.click())
}

const toasts = () => toast.mock.calls.map(([text]) => text)

/** The editor labelled `label`, once its lazy module has loaded. */
const editorOf = (label: string) =>
  waitFor(
    () =>
      document.querySelector<TiptapEditorHTMLElement>(`[role="textbox"][aria-label="${label}"]`)
        ?.editor,
    `the ${label} editor`,
  )

/** Presses Enter in title editor `field`, which saves from the focused
    field as it blurs. */
const enterIn = (field: HTMLTextAreaElement) =>
  act(async () => {
    field.focus()
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })

/** Opens the window's title editor and types `text` in it, unsaved. */
async function typeTitle(text: string) {
  const title = await waitFor(
    () => document.querySelector<HTMLElement>('[data-task-title]'),
    'the title',
  )
  await act(async () => title.click())
  const input = await waitFor(
    () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task title"]'),
    'the title editor',
  )
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    set?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return input
}

/** The tooltip of `element`, which a Button draws from its title, as a
    pointer over it opens it; a disabled control takes no focus. */
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
  const text = tip?.firstChild?.textContent ?? null
  await act(async () => trigger.dispatchEvent(pointer('pointerleave')))
  return text
}

describe('the window of a task just created', { timeout: 30_000 }, () => {
  it('opens by its reference with focus in it, toasts its key and shows its card, asking for no task', async () => {
    const store = await app('/app/testbed/board/p/2')
    await createTask('Run the soak test')
    // the window shows the task from what its create sent
    await waitFor(
      () => document.querySelector('[data-task-title]')?.textContent?.includes('Run the soak test'),
      'the new task in its window',
    )
    expect(document.querySelector('[data-issue-key]')?.textContent).toBe('QN-41')
    expect(toasts()).toEqual(['Created QN-41'])
    await waitFor(
      () => document.querySelector('[role="dialog"]')?.contains(document.activeElement),
      'focus in the window',
    )
    // its card shows on the Board under the window
    expect(document.querySelector('[data-card="QN-41"]')).not.toBeNull()
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
    expect(store.__layerProbe?.asks()).toEqual([])
  })

  it("shows the new task on the window's first render, before the window watches it", async () => {
    const store = await app('/app/testbed/board/p/2')
    // the window watches its task from an effect, after its first render;
    // held back here, the window shows what its first render shows
    const watch = vi.spyOn(store.P, 'watchComments').mockImplementation(() => {})
    // every text the page shows from the press of Create on
    const shown: string[] = []
    const note = (records: MutationRecord[]) => {
      for (const record of records) {
        if (record.type === 'characterData') shown.push(record.target.textContent ?? '')
        for (const node of record.addedNodes) shown.push(node.textContent ?? '')
      }
    }
    const observer = new MutationObserver(note)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    try {
      await createTask('Run the soak test')
      await waitFor(
        () =>
          document.querySelector('[data-task-title]')?.textContent?.includes('Run the soak test'),
        'the new task in its window',
      )
    } finally {
      note(observer.takeRecords())
      observer.disconnect()
    }
    expect(watch).toHaveBeenCalled()
    expect(document.querySelector('[data-issue-key]')?.textContent).toBe('QN-41')
    expect(shown.filter((text) => text.includes('Loading QN-41'))).toEqual([])
  })

  it('takes a title change at once behind the create, and says why its waiting controls wait', async () => {
    await app('/app/testbed/board/p/2')
    await createTask('Run the soak test')
    const title = await waitFor(
      () => document.querySelector<HTMLElement>('[data-task-title]'),
      'the title',
    )
    await act(async () => title.click())
    const input = await waitFor(
      () =>
        document.querySelector<HTMLInputElement>(
          'input[aria-label="Task title"], textarea[aria-label="Task title"]',
        ),
      'the title editor',
    )
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set
    await act(async () => {
      set?.call(input, 'Run the long soak test')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    )
    // the change went out at once, after the create, which still waits
    expect(sent.filter((name) => name.startsWith('issues:'))).toEqual([
      'issues:create',
      'issues:update',
    ])
    await waitFor(
      () =>
        document
          .querySelector('[data-task-title]')
          ?.textContent?.includes('Run the long soak test'),
      'the new title',
    )
    // the controls that read the server about the task wait, and say so
    for (const label of ['Add subtask', 'Link task', 'Set parent']) {
      const control = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
      expect(control?.disabled, label).toBe(true)
      expect(await hintOf(control), label).toBe('Available once this task is saved')
    }
    // the Roadmap's answer holds no task the server has not stored, so
    // planning it there waits too
    const plan = document.querySelector<HTMLButtonElement>('button[data-plan-on-roadmap]')
    expect(plan?.textContent).toContain('Plan on roadmap')
    expect(plan?.disabled).toBe(true)
    expect(await hintOf(plan)).toBe('Available once this task is saved')
    // the server took it: the controls read the server once the window's
    // own read answers, which this test leaves on its way
    await act(async () => accept(41))
    expect(
      document.querySelector<HTMLButtonElement>('button[aria-label="Add subtask"]')?.disabled,
    ).toBe(true)
  })

  it('keeps the text typed in it when its first read fails after the create, and saves it once Retry reads the task', async () => {
    const store = await app('/app/testbed/board/p/2')
    await createTask('Run the soak test')
    const uuid = await waitFor(() => store.P.detail?.task, 'the watched task')
    // a title and a comment typed while the create waits, neither sent
    const input = await typeTitle('Run the long soak test')
    const composer = await editorOf('Leave a comment')
    await act(async () => composer.commands.insertContent('Drift is under 2%'))
    await act(async () => accept(41))
    const own = () => taskReads.filter((read) => read.args.ref === uuid).at(-1)
    const first = await waitFor(own, "the window's read of its task")
    await act(async () => first.fail(new Error('Server Error')))
    // the window goes on showing the task with the typed text, says that
    // its read failed and offers Retry
    const stale = await waitFor(
      () => document.querySelector<HTMLElement>('[data-task-stale="failed"]'),
      'the failure line',
    )
    expect(stale.textContent).toContain(
      "Couldn't check QN-41 for changes, so it shows as you made it.",
    )
    expect(input.isConnected).toBe(true)
    expect(input.value).toBe('Run the long soak test')
    expect((await editorOf('Leave a comment')).getText()).toBe('Drift is under 2%')
    expect(toasts().filter((text) => String(text).startsWith('Unsaved'))).toEqual([])
    // its controls that read the server still wait for the saved task
    expect(
      document.querySelector<HTMLButtonElement>('button[aria-label="Add subtask"]')?.disabled,
    ).toBe(true)
    // a save that needs the stored task waits, and the draft stays
    await enterIn(input)
    expect(sent.filter((name) => name === 'issues:update')).toEqual([])
    expect(toasts()).toContain(
      "Couldn't save yet. Saving is available once Qivo can check this task for changes.",
    )
    expect(input.value).toBe('Run the long soak test')
    // Retry reads the task again, and the server's answer serves the window
    const retry = [...stale.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Retry'),
    )
    await act(async () => retry?.click())
    const again = await waitFor(() => (own() !== first ? own() : null), 'the read run again')
    const row = storedRow
    if (!row) throw new Error('the create was not stored')
    await act(async () =>
      again.next({
        state: 'ok',
        task: { ...row, has_subtasks: false },
        level: 'lead',
        labels: [],
        follow: null,
        parent: null,
        subtasks: { rows: [], complete: true },
      }),
    )
    await waitFor(() => !document.querySelector('[data-task-stale]'), 'the failure line gone')
    expect(store.P.taskDetail(uuid)).toMatchObject({ state: 'ok', saving: false })
    // the typed text saves now
    const field = await waitFor(
      () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task title"]'),
      'the title editor',
    )
    expect(field.value).toBe('Run the long soak test')
    await enterIn(field)
    const update = sentArgs.filter((write) => write.name === 'issues:update')
    expect(update.map((write) => write.args.patch)).toEqual([{ title: 'Run the long soak test' }])
    const post = buttonNamed('Comment')
    await act(async () => post?.click())
    const comment = sentArgs.filter((write) => write.name === 'comments:create')
    expect(comment.map((write) => [write.args.issue_id, write.args.body])).toEqual([
      [uuid, 'Drift is under 2%'],
    ])
  })
})

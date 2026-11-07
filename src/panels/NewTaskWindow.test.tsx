// @vitest-environment jsdom
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
/* The writes the store sent, in order, and the create's answer. */
let sent: string[]
let accept: (num: number) => void

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
    } else if (name.startsWith('overview:')) answerOverview(snap, name, args, next, fail)
    return () => {}
  })
  network.query.mockResolvedValue(null)
  sent = []
  // Convex answers one client's writes in the order sent: a write sent
  // behind the create answers after it
  let behind: Promise<unknown> = Promise.resolve()
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    sent.push(name)
    if (name.startsWith('issues:') && name !== 'issues:create') return behind.then(() => null)
    if (name !== 'issues:create')
      return name.startsWith('comments:') ? new Promise(() => {}) : Promise.resolve(null)
    const answered = new Promise((resolve) => {
      accept = (num) => {
        // the Board's answer holds the stored task before the create answers
        const row = {
          ...(args as Snapshot['issues'][number]),
          num,
          org_id: snap.orgs[0].id,
          has_hidden_subtasks: false,
          has_hidden_parent: false,
        }
        server = { ...server, issues: [...server.issues, row] }
        for (const read of boards) read.next(boardStandIn(server, read.args))
        resolve({ ...args, num })
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
})

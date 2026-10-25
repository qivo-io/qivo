// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { plannerFixture, type Snapshot } from './store/plannerFixture.setup'

/* Archiving a task on a phone, on App and the real store: the task leaves
   the board while its Archive or delete dialog is open, and the window
   closes once the server answers. However the delivery that drops the
   task and the answer come, the page ends on the Board's own entry, so
   Back leaves the page instead of landing on the same Board again. */

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
let removeIndex = () => {}

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // a phone
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
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
  removeIndex()
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
      [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(
        (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
      ),
    name,
  )
  await act(async () => button.click())
}

/** Lets the page's history moves land. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

/** Boots App on a phone at the Board, after an earlier /before entry, with
    the history index main.tsx installs, and opens task QN-1's Archive or
    delete dialog. Answers the server's answer to the archive and the
    delivery that drops the task. */
async function openArchive() {
  vi.resetModules()
  const snap: Snapshot = plannerFixture()
  snap.orgs[0].next_issue_num = 1
  snap.issues.push({
    id: crypto.randomUUID(),
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: 1,
    title: 'Calibrate the sensor',
    description: '',
    status: 'done',
    priority: 'medium',
    paused: false,
    created_at: AT,
    updated_at: AT,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  let publish = (_: Snapshot) => {}
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      publish = (value) => next(structuredClone(value))
      publish(snap)
    } else if (name === 'snapshot:commentThread') next({ comments: [], earlier: false, events: [] })
    return () => {}
  })
  let answer = () => {}
  network.query.mockResolvedValue(null)
  network.mutation.mockImplementation((ref) =>
    getFunctionName(ref) === 'issues:archive'
      ? new Promise((resolve) => {
          answer = () => resolve(null)
        })
      : Promise.resolve(null),
  )
  history.pushState(null, '', '/before')
  history.pushState(null, '', '/app/testbed/board/p/1')
  removeIndex = (await import('./lib/historyIndex')).installHistoryIndex()
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
  await press('Task actions')
  await press('Archive or delete…')
  await waitFor(() => document.querySelector('[data-modal-shell]'), 'the dialog')
  await settle()
  expect(location.pathname).toBe('/app/testbed/board/tasks/qn-1')
  expect(history.state?.qivoLayer).toBeTruthy()
  const gone = structuredClone(snap)
  gone.issues = []
  gone.delivered_at = '2026-09-15T09:00:00.000Z'
  return {
    answer: () => act(async () => answer()),
    drop: () => act(async () => publish(gone)),
  }
}

describe('Archive on a phone', { timeout: 30_000 }, () => {
  it.each([
    ['the delivery that drops the task comes first', ['drop', 'answer']],
    ['the answer comes first', ['answer', 'drop']],
  ] as const)('ends on the Board, from which Back leaves, when %s', async (_, order) => {
    const server = await openArchive()
    await press('Archive')
    for (const step of order) {
      await server[step]()
      await settle()
    }
    await waitFor(() => !document.querySelector('[role="dialog"]'), 'the closed window')
    expect(location.pathname).toBe('/app/testbed/board/p/1')
    expect(history.state?.qivoLayer).toBeUndefined()
    await act(async () => history.back())
    await settle()
    expect(location.pathname).toBe('/before')
  })
})

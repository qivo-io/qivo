// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* Opening a task reads its unread messages on its own (IssueDetail). While
   edits pause the store refuses that read without a word, and the window
   sends it once the pause ends. The pause here is the connection's
   (lib/syncStatus), driven the way the Convex socket would drive it. */

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

const UP = { connected: true, everConnected: true }
const DOWN = { connected: false, everConnected: true }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  localStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the automatic read in the task window', { timeout: 20_000 }, () => {
  it('is refused quietly while edits pause and goes out once the pause ends', async () => {
    vi.resetModules()
    const snap: Snapshot = plannerFixture()
    snap.issues.push({
      id: 'task-a',
      org_id: snap.orgs[0].id,
      project_id: snap.projects[0].id,
      num: 27,
      title: 'Run the soak test',
      description: '',
      status: 'progress',
      priority: 'medium',
      paused: false,
      created_at: '2026-09-14T08:00:00.000Z',
      updated_at: '2026-09-14T08:00:00.000Z',
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    snap.messages.push({
      id: 'message-a',
      org_id: snap.orgs[0].id,
      recipient_id: snap.profiles[0].id,
      issue_id: 'task-a',
      issue_title: 'Run the soak test',
      kind: 'comment',
      detail: 'New comment',
      created_at: '2026-09-14T09:00:00.000Z',
    })
    network.onUpdate.mockImplementation((ref, _args, next) => {
      if (getFunctionName(ref) === 'workspace:whole') next(structuredClone(snap))
      return () => {}
    })
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
    const reads = () =>
      network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === 'messages:markRead')
    const { syncStatus, OFFLINE_DELAY_MS } = await import('../lib/syncStatus')
    const store = await import('../store/planner')
    await store.initStore()
    const { IssueDetail } = await import('./IssueDetail')
    syncStatus.setSocket(UP)
    syncStatus.setSocket(DOWN)
    vi.advanceTimersByTime(OFFLINE_DELAY_MS)
    expect(store.P.editsPaused()).toBe(true)

    const task = store.P.issues.find((it) => it.uuid === 'task-a')
    if (!task) throw new Error('missing the task')
    await act(async () =>
      root.render(
        <TooltipProvider>
          <IssueDetail issueId={task.id} onClose={vi.fn()} onOpen={vi.fn()} />
        </TooltipProvider>,
      ),
    )
    expect(reads()).toHaveLength(0)
    expect(window.showToast).not.toHaveBeenCalled()

    // no probe is set, so the server's answer counts as immediate
    await act(async () => syncStatus.setSocket(UP))
    expect(reads()).toHaveLength(1)
    expect(reads()[0][1]).toEqual({ org_id: snap.orgs[0].id, ids: ['message-a'] })
  })
})

// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The task window reads P.editsPaused(): opening a task marks its messages
   read unless edits pause, and sends the mark once they no longer do. The
   end of snapshot trouble emits only the store's health, so the window
   follows it on its own. A lost sign-in pauses every write, inbox reads
   included. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  window.showToast = vi.fn()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the task window while snapshot trouble pauses edits', { timeout: 30_000 }, () => {
  it('marks the task read once the trouble ends', async () => {
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
      created_at: AT,
      updated_at: AT,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    snap.messages = [
      {
        id: 'message-a',
        org_id: snap.orgs[0].id,
        recipient_id: snap.profiles[0].id,
        issue_id: 'task-a',
        issue_title: 'Run the soak test',
        kind: 'change',
        detail: 'Status changed',
        created_at: AT,
      },
    ]
    let live: { deliver: (value: Snapshot) => void; fail: (error: unknown) => void } | null = null
    network.onUpdate.mockImplementation((ref, _args, next, fail) => {
      const name = getFunctionName(ref)
      if (name === 'snapshot:forMe') {
        live = { deliver: next, fail }
        next(structuredClone(snap))
      } else if (name === 'snapshot:commentThread')
        next({ comments: [], earlier: false, events: [] })
      return () => {}
    })
    network.query.mockResolvedValue(null)
    network.mutation.mockImplementation(() => new Promise(() => {}))
    const sent = () => network.mutation.mock.calls.map(([ref]) => getFunctionName(ref))
    network.mutation.mockImplementationOnce(() => Promise.resolve(null))
    const store = await import('../store/planner')
    await store.initStore()
    const { IssueDetail } = await import('./IssueDetail')
    // the sign-in is lost mid-session: every write pauses, inbox reads too
    await act(async () =>
      live?.fail(new ConvexError({ code: 'forbidden', message: 'not signed in' })),
    )
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
    expect(sent()).not.toContain('messages:markRead')
    // a delivery with nothing new on screen ends the trouble
    await act(async () => {
      live?.deliver({ ...structuredClone(snap), delivered_at: '2026-09-15T08:00:00.000Z' })
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(store.P.editsPaused()).toBe(false)
    expect(sent()).toContain('messages:markRead')
  })
})

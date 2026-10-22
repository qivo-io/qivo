import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* The workspace parts and the open task's thread come in Convex
   transitions (store/liveParts.ts). One transition that changes both a
   task and the thread repaints once and tells the views once, and one that
   changes nothing on screen tells them nothing. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { batch(step: () => void): void },
}))
vi.mock('../lib/convex', async () => {
  const { liveOver } = await import('./guard/liveDouble.setup')
  double.live = liveOver(network)
  return { convex: network, live: double.live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'

describe('one transition', () => {
  let store: typeof import('./planner')
  let snapshot: Snapshot
  let deliver: (snap: Snapshot) => void
  let deliverThread: (page: unknown) => void
  let emits: number

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
    snapshot = plannerFixture()
    snapshot.issues.push({
      id: 'task-a',
      org_id: snapshot.orgs[0].id,
      project_id: snapshot.projects[0].id,
      num: 1,
      title: 'Task A',
      description: '',
      status: 'todo',
      priority: 'medium',
      created_at: AT,
      updated_at: AT,
      paused: false,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      const name = getFunctionName(ref)
      if (name === 'workspace:whole') {
        deliver = receive
        receive(structuredClone(snapshot))
      } else if (name === 'snapshot:commentThread') deliverThread = receive
      return () => {}
    })
    store = await import('./planner')
    await store.initStore()
    store.P.watchComments('task-a')
    await new Promise((resolve) => setTimeout(resolve, 0))
    deliverThread({
      comments: [],
      earlier: false,
      events: [],
      events_earlier: false,
      events_next: null,
    })
    emits = 0
    store.P.subscribe(() => emits++)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('repaints a task change and a new comment of one transition once', () => {
    const comment = {
      id: 'comment-1',
      issue_id: 'task-a',
      author: snapshot.profiles[0].id,
      body: 'Looks good',
      created_at: AT,
    }
    double.live?.batch(() => {
      snapshot.issues[0].title = 'Renamed elsewhere'
      deliver(structuredClone(snapshot))
      deliverThread({
        comments: [comment],
        earlier: false,
        events: [],
        events_earlier: false,
        events_next: null,
      })
    })
    expect(store.P.issues.find((i) => i.uuid === 'task-a')?.title).toBe('Renamed elsewhere')
    expect(store.P.comments.map((c) => c.body)).toEqual(['Looks good'])
    expect(emits).toBe(1)
  })

  it('tells no view of a transition that changes no part', () => {
    deliver(structuredClone(snapshot))
    expect(emits).toBe(0)
  })
})

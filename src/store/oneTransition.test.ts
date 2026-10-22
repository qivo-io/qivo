import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* The workspace parts and the open task's thread come in Convex
   transitions (store/liveParts.ts). One transition that changes both a
   task and the thread repaints once and tells the views once, and one that
   changes nothing on screen tells them nothing. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { batch(step: () => void): void; hold(orgId: string | null): void },
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

  it('keeps a write accepted while a new seat holds the workspace, until a transition completes it', async () => {
    let answer: (value: null) => void = () => {}
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'issues:update'
        ? new Promise((resolve) => (answer = resolve))
        : Promise.resolve(null),
    )
    const title = () => store.P.issues.find((i) => i.uuid === 'task-a')?.title
    store.P.updateIssue(store.P.issues.find((i) => i.uuid === 'task-a')?.id ?? '', {
      title: 'Mine',
    })
    // a complete transition from before the server applied the write
    snapshot.issues[0].description = 'Changed elsewhere'
    deliver(structuredClone(snapshot))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(title()).toBe('Mine')
    // a new seat's organization, whose parts load after the root names it
    double.live?.hold('org-2')
    snapshot.orgs.push({ ...snapshot.orgs[0], id: 'org-2', name: 'Second' })
    snapshot.profiles.push({ ...snapshot.profiles[0], id: 'me-2', org_id: 'org-2' })
    snapshot.myProfileIds.push('me-2')
    // the server applied the write in the same state
    snapshot.issues[0].title = 'Mine'
    deliver(structuredClone(snapshot))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // the write answers while the workspace is held, and its paint stays
    answer(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(title()).toBe('Mine')
    // the transition that completes the workspace holds the write, so its
    // saved paint goes, and a later change elsewhere shows
    double.live?.hold(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    snapshot.issues[0].title = 'Elsewhere'
    deliver(structuredClone(snapshot))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(title()).toBe('Elsewhere')
  })

  it('tells no view of a transition that changes no part', () => {
    deliver(structuredClone(snapshot))
    expect(emits).toBe(0)
  })
})

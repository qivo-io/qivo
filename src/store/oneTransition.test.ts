import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* The workspace parts and the open task's thread, history and sections
   come in Convex transitions (store/liveParts.ts). One transition that
   changes a task, the thread, the history and a section, or the answer of
   a task a window shows from its own read, repaints once and tells the
   views once, and one that changes nothing on screen tells them
   nothing. */

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
  let deliverHistory: (page: unknown) => void
  let deliverSection: Record<string, (answer: unknown) => void>
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
    deliverSection = {}
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      const name = getFunctionName(ref)
      if (name === 'workspace:whole') {
        deliver = receive
        receive(structuredClone(snapshot))
      } else if (name === 'snapshot:threadComments') deliverThread = receive
      else if (name === 'snapshot:threadHistory') deliverHistory = receive
      else if (name.startsWith('taskWindow:')) deliverSection[name] = receive
      return () => {}
    })
    store = await import('./planner')
    await store.initStore()
    store.P.watchComments('task-a')
    await new Promise((resolve) => setTimeout(resolve, 0))
    deliverThread({ comments: [], earlier: false })
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
      deliverThread({ comments: [comment], earlier: false })
    })
    expect(store.P.issues.find((i) => i.uuid === 'task-a')?.title).toBe('Renamed elsewhere')
    expect(store.P.comments.map((c) => c.body)).toEqual(['Looks good'])
    expect(emits).toBe(1)
  })

  it('repaints a task change, a new comment and a new change of one transition once', async () => {
    store.P.showHistory({}, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    deliverHistory({ events: [], earlier: false, next: null })
    emits = 0
    const event = {
      id: 'event-1',
      org_id: snapshot.orgs[0].id,
      ts: AT,
      actor_id: snapshot.profiles[0].id,
      verb: 'renamed',
      target_type: 'issue',
      target_id: 'task-a',
      label: 'QN-1',
    }
    double.live?.batch(() => {
      snapshot.issues[0].title = 'Renamed elsewhere'
      deliver(structuredClone(snapshot))
      deliverThread({ comments: [], earlier: false })
      deliverHistory({ events: [event], earlier: false, next: null })
    })
    expect(store.P.issues.find((i) => i.uuid === 'task-a')?.title).toBe('Renamed elsewhere')
    expect(store.P.threadEvents.map((e) => e.id)).toEqual(['event-1'])
    expect(emits).toBe(1)
  })

  it('repaints a task change, a new comment and a section answer of one transition once', async () => {
    store.P.showSections({}, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const short = (row: Snapshot['issues'][number]) => {
      const { description: _text, has_hidden_subtasks: _h, has_hidden_parent: _p, ...rest } = row
      return { ...rest, has_subtasks: false, level: 'lead' }
    }
    const task = (title: string) => ({
      state: 'ok',
      task: { ...snapshot.issues[0], title, has_subtasks: false },
      level: 'lead',
      labels: [],
      follow: null,
      parent: null,
      subtasks: { rows: [], complete: true },
    })
    deliverSection['taskWindow:task'](task('Task A'))
    emits = 0
    // a subtask elsewhere, which only the section answer holds
    const kid = { ...snapshot.issues[0], id: 'kid-elsewhere', num: 2, title: 'Elsewhere' }
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
      deliverThread({ comments: [comment], earlier: false })
      deliverSection['taskWindow:task']({
        ...task('Renamed elsewhere'),
        subtasks: { rows: [short(kid)], complete: true },
      })
    })
    expect(store.P.issues.find((i) => i.uuid === 'task-a')?.title).toBe('Renamed elsewhere')
    expect(store.P.comments.map((c) => c.body)).toEqual(['Looks good'])
    expect(store.P.sections?.subtasks.rows.map((r) => r.title)).toEqual(['Elsewhere'])
    expect(emits).toBe(1)
    // an answer that changes no section, as after a description save, tells
    // no view
    deliverSection['taskWindow:task']({
      ...task('Renamed elsewhere'),
      task: { ...snapshot.issues[0], description: 'Saved text', has_subtasks: true },
      subtasks: { rows: [short(kid)], complete: true },
    })
    expect(emits).toBe(1)
  })

  it('repaints a task change, a new comment and the answer of a task the workspace does not hold of one transition once', async () => {
    // a task a window shows from its own read (P.taskDetail)
    store.P.watchComments('far-1', snapshot.orgs[0].id)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const answer = (title: string) => ({
      state: 'ok',
      task: { ...snapshot.issues[0], id: 'far-1', num: 40, title, has_subtasks: false },
      level: 'lead',
      labels: [],
      follow: null,
      parent: null,
      subtasks: { rows: [], complete: true },
    })
    deliverThread({ comments: [], earlier: false })
    deliverSection['taskWindow:task'](answer('Far task'))
    expect(store.P.taskDetail('far-1')?.view?.title).toBe('Far task')
    emits = 0
    const comment = {
      id: 'comment-1',
      issue_id: 'far-1',
      author: snapshot.profiles[0].id,
      body: 'Looks good',
      created_at: AT,
    }
    double.live?.batch(() => {
      snapshot.issues[0].title = 'Renamed elsewhere'
      deliver(structuredClone(snapshot))
      deliverThread({ comments: [comment], earlier: false })
      deliverSection['taskWindow:task'](answer('Far task renamed'))
    })
    expect(store.P.issues.find((i) => i.uuid === 'task-a')?.title).toBe('Renamed elsewhere')
    expect(store.P.comments.map((c) => c.body)).toEqual(['Looks good'])
    expect(store.P.taskDetail('far-1')?.view?.title).toBe('Far task renamed')
    expect(emits).toBe(1)
    // an answer that changes nothing on screen tells no view
    deliverSection['taskWindow:task'](answer('Far task renamed'))
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

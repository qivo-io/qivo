import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture as fixture, type Snapshot } from './plannerFixture.setup'

type Planner = typeof import('./planner')['P']

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const NOW = '2026-09-14T08:00:00.000Z'

type Pending = {
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

describe('task creation through the client store', () => {
  let P: Planner
  let snap: Snapshot
  let publish: (value: Snapshot) => void
  let requests: Pending[]
  let showToast: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    showToast = vi.fn()
    vi.stubGlobal('window', { showToast })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snap = fixture()
    requests = []
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((ref, _args, next) => {
      if (getFunctionName(ref) !== 'snapshot:forMe') return () => {}
      publish = next
      next(structuredClone(snap))
      return () => {}
    })
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      return new Promise((resolve, reject) => requests.push({ name, args, resolve, reject }))
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const settled = () => vi.waitFor(() => expect(P.roadmapUndo.busy).toBe(false))

  it('keeps the handle when creation succeeds with the previewed number', async () => {
    const moved = vi.fn()
    P.watchHandles(moved)
    const key = P.addIssue({ project: snap.projects[0].id, title: 'New task' })!
    const task = P.issueById[key]
    expect(task.title).toBe('New task')
    expect(requests[0]).toMatchObject({
      name: 'issues:create',
      args: { id: task.uuid, title: 'New task', project_id: snap.projects[0].id },
    })

    requests[0].resolve({ num: snap.orgs[0].next_issue_num + 1 })
    await settled()
    expect(P.issueById[key].uuid).toBe(task.uuid)
    expect(moved).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })

  it("subscribes to a new task's thread only once a delivery holds the task", async () => {
    // the server refuses the thread of a task it does not hold yet
    const threads = () =>
      network.onUpdate.mock.calls.filter(
        ([ref]) => getFunctionName(ref) === 'snapshot:commentThread',
      )
    const key = P.addIssue({ project: snap.projects[0].id, title: 'New task' })!
    const task = P.issueById[key]
    P.watchComments(task.uuid)
    expect(threads()).toHaveLength(0)
    expect(P.commentsLoaded).toBe(true)
    expect(P.comments).toEqual([])

    // a delivery without it, such as another person's change, still waits
    publish(structuredClone(snap))
    expect(threads()).toHaveLength(0)

    snap.issues = [
      {
        id: task.uuid,
        org_id: snap.orgs[0].id,
        project_id: snap.projects[0].id,
        num: task.num,
        title: 'New task',
        description: '',
        status: 'backlog',
        priority: 'low',
        paused: false,
        created_at: NOW,
        updated_at: NOW,
        has_hidden_subtasks: false,
        has_hidden_parent: false,
      },
    ]
    publish(structuredClone(snap))
    expect(threads()).toHaveLength(1)
    expect(threads()[0][1]).toEqual({ org_id: snap.orgs[0].id, issue_id: task.uuid })
    // later deliveries keep the one subscription
    publish(structuredClone(snap))
    expect(threads()).toHaveLength(1)
    P.watchComments(null)
  })

  it('corrects an open preview after successful renumbering without reporting a refusal', async () => {
    const moved = vi.fn()
    P.watchHandles(moved)
    const onRefused = vi.fn()
    const key = P.addIssue({ project: snap.projects[0].id, title: 'New task' }, onRefused)!
    const task = P.issueById[key]
    const correctedNum = snap.orgs[0].next_issue_num + 2
    requests[0].resolve({ num: correctedNum })
    await settled()

    const correctedKey = `${P.ISSUE_PREFIX}-${correctedNum}`
    expect(moved).toHaveBeenCalledExactlyOnceWith(new Map([[key, correctedKey]]))
    expect(P.issueById[correctedKey].uuid).toBe(task.uuid)
    expect(P.issueById[key]).toBeUndefined()
    expect(onRefused).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('moves an open preview past a competing create while the write waits, never sharing a handle', async () => {
    vi.useFakeTimers()
    const onKeyFixed = vi.fn()
    P.watchHandles(onKeyFixed)
    const key = P.addIssue({ project: snap.projects[0].id, title: 'Mine' })!
    const mine = P.issueById[key].uuid
    const next = snap.orgs[0].next_issue_num + 1
    const competing: Snapshot['issues'][number] = {
      id: crypto.randomUUID(),
      org_id: snap.orgs[0].id,
      project_id: snap.projects[0].id,
      num: next,
      title: 'Task created by another user',
      description: '',
      status: 'backlog',
      priority: 'low',
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    }
    snap.orgs[0].next_issue_num = next
    snap.issues = [competing]
    publish(structuredClone(snap))
    vi.advanceTimersByTime(0)
    const moved = `${P.ISSUE_PREFIX}-${next + 1}`
    expect(onKeyFixed).toHaveBeenCalledExactlyOnceWith(new Map([[key, moved]]))
    expect(P.issueById[moved].uuid).toBe(mine)
    expect(P.issueById[key].uuid).toBe(competing.id)
    expect(new Set(P.issues.map((task) => task.key)).size).toBe(P.issues.length)
    // Convex delivers the create before it answers
    snap.orgs[0].next_issue_num = next + 1
    snap.issues = [competing, { ...competing, id: mine, num: next + 1, title: 'Mine' }]
    publish(structuredClone(snap))
    requests[0].resolve({ num: next + 1 })
    await settled()
    expect(onKeyFixed).toHaveBeenCalledOnce()
    expect(P.issueById[moved].uuid).toBe(mine)
    vi.useRealTimers()
  })

  it('moves two waiting creates together, so a window follows its own task', async () => {
    vi.useFakeTimers()
    const moves: ReadonlyMap<string, string>[] = []
    const stop = P.watchHandles((moved) => moves.push(moved))
    const first = P.addIssue({ project: snap.projects[0].id, title: 'First' })!
    const second = P.addIssue({ project: snap.projects[0].id, title: 'Second' })!
    const [a, b] = [P.issueById[first].uuid, P.issueById[second].uuid]
    const next = snap.orgs[0].next_issue_num + 1
    snap.orgs[0].next_issue_num = next
    snap.issues = [
      {
        id: crypto.randomUUID(),
        org_id: snap.orgs[0].id,
        project_id: snap.projects[0].id,
        num: next,
        title: 'Task created by another user',
        description: '',
        status: 'backlog',
        priority: 'low',
        paused: false,
        created_at: NOW,
        updated_at: NOW,
        has_hidden_subtasks: false,
        has_hidden_parent: false,
      },
    ]
    publish(structuredClone(snap))
    vi.advanceTimersByTime(0)
    // one map for the repaint: the open window applies it at once
    expect(moves).toHaveLength(1)
    const open = (handle: string) => moves[0].get(handle) ?? handle
    expect(P.issueById[open(first)].uuid).toBe(a)
    expect(P.issueById[open(second)].uuid).toBe(b)
    stop()
    vi.useRealTimers()
  })

  it('shows the parent number the server answers while no delivery holds it', async () => {
    const child = P.addIssue({ project: snap.projects[0].id, title: 'Child' })!
    requests.splice(0)[0].resolve({ num: snap.orgs[0].next_issue_num + 1 })
    await settled()
    const uuid = P.issueById[child].uuid
    P.createParent(child, 'New parent')
    expect(P.issues.find((task) => task.title === 'New parent')?.key).toBe(`${P.ISSUE_PREFIX}-2`)
    // the snapshot fails before the answer, so no delivery shows the create
    // or the other person's that took number 2
    const subscription = network.onUpdate.mock.calls.find(
      ([ref]) => getFunctionName(ref) === 'snapshot:forMe',
    )!
    subscription[3](new Error('[CONVEX Q(snapshot:forMe)] Server Error'))
    requests[0].resolve({ id: uuid, parent_num: 5 })
    await settled()
    expect(P.issues.find((task) => task.title === 'New parent')?.key).toBe(`${P.ISSUE_PREFIX}-5`)
  })

  it('paints a new parent at once and takes it away again on a refusal', async () => {
    const child = P.addIssue({ project: snap.projects[0].id, title: 'Child' })!
    const uuid = P.issueById[child].uuid
    snap.orgs[0].next_issue_num = 1
    snap.issues = [
      {
        id: uuid,
        org_id: snap.orgs[0].id,
        project_id: snap.projects[0].id,
        num: 1,
        title: 'Child',
        description: '',
        status: 'backlog',
        priority: 'low',
        paused: false,
        created_at: NOW,
        updated_at: NOW,
        has_hidden_subtasks: false,
        has_hidden_parent: false,
      },
    ]
    publish(structuredClone(snap))
    requests.splice(0)[0].resolve({ num: 1 })
    await settled()
    P.createParent(child, 'New parent')
    const parent = P.issues.find((task) => task.title === 'New parent')
    expect(parent?.key).toBe(`${P.ISSUE_PREFIX}-2`)
    expect(P.issueById[child].parent).toBe(parent?.id)
    expect(requests[0]).toMatchObject({ name: 'issues:createParent', args: { id: uuid } })
    requests[0].reject(new ConvexError({ code: 'rule', message: 'a task with archived subtasks' }))
    await settled()
    expect(P.issues.some((task) => task.title === 'New parent')).toBe(false)
    expect(P.issueById[child].parent).toBeNull()
  })

  it('notifies the caller once before rollback can reuse the preview number for another task', async () => {
    const onKeyFixed = vi.fn()
    P.watchHandles(onKeyFixed)
    let taskAtRefusal: string | undefined
    const onRefused = vi.fn(() => {
      taskAtRefusal = P.issueById[key]?.uuid
    })
    const key = P.addIssue({ project: snap.projects[0].id, title: 'Refused task' }, onRefused)!
    const preview = P.issueById[key]
    const competing: Snapshot['issues'][number] = {
      id: crypto.randomUUID(),
      org_id: snap.orgs[0].id,
      project_id: snap.projects[0].id,
      num: snap.orgs[0].next_issue_num + 1,
      title: 'Task created by another user',
      description: '',
      status: 'backlog',
      priority: 'low',
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    }
    snap.orgs[0].next_issue_num = competing.num
    snap.issues = [competing]
    publish(structuredClone(snap))
    expect(P.issueById[key].uuid).toBe(preview.uuid)

    requests[0].reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await settled()

    expect(onRefused).toHaveBeenCalledExactlyOnceWith(key)
    expect(taskAtRefusal).toBe(preview.uuid)
    expect(P.issues.some((task) => task.uuid === preview.uuid)).toBe(false)
    expect(P.issueById[key].uuid).toBe(competing.id)
    expect(onKeyFixed).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      "You don't have permission for that. Change reverted.",
      'error',
    )
  })
})

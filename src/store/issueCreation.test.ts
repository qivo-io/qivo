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
    network.onUpdate.mockImplementation((_ref, _args, next) => {
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

  it('keeps the existing two-argument API when creation succeeds', async () => {
    const onKeyFixed = vi.fn()
    const key = P.addIssue({ project: snap.projects[0].id, title: 'New task' }, onKeyFixed)!
    const task = P.issueById[key]
    expect(task.title).toBe('New task')
    expect(requests[0]).toMatchObject({
      name: 'issues:create',
      args: { id: task.uuid, title: 'New task', project_id: snap.projects[0].id },
    })

    requests[0].resolve({ num: snap.orgs[0].next_issue_num + 1 })
    await settled()
    expect(P.issueById[key].uuid).toBe(task.uuid)
    expect(onKeyFixed).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('corrects an open preview after successful renumbering without reporting a refusal', async () => {
    const onKeyFixed = vi.fn()
    const onRefused = vi.fn()
    const key = P.addIssue(
      { project: snap.projects[0].id, title: 'New task' },
      onKeyFixed,
      onRefused,
    )!
    const task = P.issueById[key]
    const correctedNum = snap.orgs[0].next_issue_num + 2
    requests[0].resolve({ num: correctedNum })
    await settled()

    expect(onKeyFixed).toHaveBeenCalledExactlyOnceWith(`${P.ISSUE_PREFIX}-${correctedNum}`)
    const correctedKey = onKeyFixed.mock.calls[0][0]
    expect(P.issueById[correctedKey].uuid).toBe(task.uuid)
    expect(P.issueById[key]).toBeUndefined()
    expect(onRefused).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('notifies the caller once before rollback can reuse the preview number for another task', async () => {
    const onKeyFixed = vi.fn()
    let taskAtRefusal: string | undefined
    const onRefused = vi.fn(() => {
      taskAtRefusal = P.issueById[key]?.uuid
    })
    const key = P.addIssue(
      { project: snap.projects[0].id, title: 'Refused task' },
      onKeyFixed,
      onRefused,
    )!
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
    }
    snap.orgs[0].next_issue_num = competing.num
    snap.issues = [competing]
    publish(structuredClone(snap))
    expect(P.issueById[key].uuid).toBe(preview.uuid)

    requests[0].reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await settled()

    expect(onRefused).toHaveBeenCalledExactlyOnceWith()
    expect(taskAtRefusal).toBe(preview.uuid)
    expect(P.issues.some((task) => task.uuid === preview.uuid)).toBe(false)
    expect(P.issueById[key].uuid).toBe(competing.id)
    expect(onKeyFixed).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      "You don't have permission for that — reverted",
    )
  })
})

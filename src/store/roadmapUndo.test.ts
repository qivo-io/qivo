import { type FunctionReturnType, getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { api } from '../../convex/_generated/api'

type Snapshot = NonNullable<FunctionReturnType<typeof api.snapshot.forMe>>
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

function fixture(): Snapshot {
  const org = crypto.randomUUID()
  const profile = crypto.randomUUID()
  const project = crypto.randomUUID()
  return {
    auth_user_id: 'test-account',
    myProfileIds: [profile],
    orgs: [
      {
        id: org,
        name: 'Testbed Labs',
        slug: 'testbed',
        created_at: NOW,
        next_issue_num: 2,
        next_project_num: 1,
        date_format: 'iso',
        week_start: 1,
        week_one_rule: 'first4day',
        default_plannable_hours: 40,
        gravatar_avatars: false,
      },
    ],
    profiles: [
      {
        id: profile,
        org_id: org,
        auth_user_id: 'test-account',
        name: 'Planner',
        initials: 'PL',
        color: '#335577',
        org_role: 'admin',
        active: true,
        kind: 'person',
        created_at: NOW,
      },
    ],
    projects: [
      {
        id: project,
        org_id: org,
        type: 'project',
        key: 'PLAN',
        num: 1,
        name: 'Planning fixture',
        description: '',
        sort_order: 0,
        track_delay: false,
        created_at: NOW,
      },
    ],
    issues: [1, 2].map((num) => ({
      id: crypto.randomUUID(),
      org_id: org,
      project_id: project,
      num,
      title: `Planning task ${num}`,
      description: '',
      status: 'todo',
      priority: 'low',
      start_week: '2026-09-14',
      end_week: '2026-09-21',
      remaining_hours: 8,
      remaining_set_at: NOW,
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      has_hidden_subtasks: false,
    })),
    teams: [],
    teamMembers: [],
    access: [],
    teamAccess: [],
    links: [],
    milestones: [],
    activity: [],
    labels: [],
    issueLabels: [],
    issueSubs: [],
    attachments: [],
    orgLoad: [],
    messages: [],
    readMessageCount: 0,
  }
}

type Pending = {
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

describe('roadmap undo through the client store', () => {
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
    P.roadmapContext(true, false)
  })

  afterEach(() => {
    P?.roadmapContext(false, false)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const settled = () => vi.waitFor(() => expect(P.roadmapUndo.busy).toBe(false))
  const task = () => P.issues.find((item) => item.title === 'Planning task 1')!
  const latest = () => requests.at(-1)!

  it('expires a long-open visit without reviving its cleared server journal', async () => {
    await savePlan()
    const sent = requests.length
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60 * 1000 + 1)
    P.undoRoadmap(true)
    expect(requests).toHaveLength(sent)
    expect(P.roadmapUndo).toEqual({ count: 0, busy: false, disabled: true })
    P.updateIssue(task().id, { remaining: 16 })
    expect(latest().name).toBe('issues:update')
    latest().resolve(null)
    await settled()
  })

  async function savePlan() {
    P.updateIssue(task().id, { remaining: 12 })
    expect(latest().name).toBe('roadmap:change')
    snap.issues[0].remaining_hours = 12
    publish(structuredClone(snap))
    latest().resolve({ count: 1 })
    await settled()
  }

  it('keeps a late response from an earlier visit out of a newly entered roadmap', async () => {
    P.updateIssue(task().id, { remaining: 12 })
    const earlier = latest()
    expect(P.roadmapUndo).toEqual({ count: 0, busy: true, disabled: false })

    P.roadmapContext(false, false)
    P.roadmapContext(true, false)
    P.updateIssue(task().id, { remaining: 16 })
    const current = latest()
    expect(current.args.session_id).not.toBe(earlier.args.session_id)

    earlier.resolve({ count: 5 })
    await vi.waitFor(() => expect(P.roadmapUndo.count).toBe(0))
    current.resolve({ count: 1 })
    await settled()
    expect(P.roadmapUndo).toEqual({ count: 1, busy: false, disabled: false })

    P.undoRoadmap()
    expect(latest()).toMatchObject({
      name: 'roadmap:undo',
      args: { session_id: current.args.session_id, all: false },
    })
    latest().resolve({ count: 0 })
    await settled()
  })

  it('retains history while inspecting a task and after a refused task edit, then disables it after a saved edit', async () => {
    await savePlan()
    const visit = latest().args.session_id
    P.roadmapContext(true, true)
    P.roadmapContext(true, false)
    expect(P.roadmapUndo.count).toBe(1)

    P.roadmapContext(true, true)
    P.updateIssue(task().id, { remaining: 20 })
    expect(latest().name).toBe('issues:update')
    expect(task().remaining).toBe(20)
    // The refusal changes no server data, so there is no new snapshot to
    // rescue the optimistic value: rollback must use the last saved one.
    latest().reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await settled()
    expect(task().remaining).toBe(12)
    expect(showToast).toHaveBeenCalledWith("You don't have permission for that — reverted")
    expect(P.roadmapUndo).toEqual({ count: 1, busy: false, disabled: false })

    P.updateIssue(task().id, { remaining: 24 })
    expect(latest().name).toBe('issues:update')
    latest().resolve(null)
    await settled()
    P.roadmapContext(true, false)
    expect(P.roadmapUndo).toEqual({ count: 0, busy: false, disabled: true })
    const sent = requests.length
    P.undoRoadmap(true)
    expect(requests).toHaveLength(sent)

    P.updateIssue(task().id, { remaining: 28 })
    expect(latest().name).toBe('issues:update')
    latest().resolve(null)
    await settled()
    P.roadmapContext(false, false)
    P.roadmapContext(true, false)
    await savePlan()
    expect(latest().args.session_id).not.toBe(visit)
    expect(P.roadmapUndo.disabled).toBe(false)
  })

  it('does not let an ordinary task write from an earlier visit disable the new visit', async () => {
    await savePlan()
    P.roadmapContext(true, true)
    P.updateIssue(task().id, { title: 'Saved task detail' })
    const detail = latest()
    expect(detail.name).toBe('issues:update')
    P.roadmapContext(false, false)
    P.roadmapContext(true, false)
    detail.resolve(null)
    await settled()
    expect(P.roadmapUndo).toEqual({ count: 0, busy: false, disabled: false })
  })

  it('reconciles a rounded planning no-op without adding history or needing a new snapshot', async () => {
    P.updateIssue(task().id, { remaining: 8.01 })
    expect(task().remaining).toBe(8.01)
    expect(latest().name).toBe('roadmap:change')
    // The server rounds to the existing eight hours. With no data change,
    // the mutation returns the unchanged history count and publishes nothing.
    latest().resolve({ count: 0 })
    await settled()

    expect(task().remaining).toBe(8)
    expect(P.roadmapUndo).toEqual({ count: 0, busy: false, disabled: false })
  })

  it('rolls back a refused roadmap change and its optimistic parent widening without another snapshot', async () => {
    const parent = {
      ...snap.issues[1],
      id: crypto.randomUUID(),
      num: 3,
      title: 'Parent planning task',
    }
    delete parent.remaining_hours
    delete parent.remaining_set_at
    snap.issues[0].parent_id = parent.id
    snap.issues.push(parent)
    publish(structuredClone(snap))
    const child = task()
    const parentKey = P.issues.find((item) => item.uuid === parent.id)!.id
    const original = { start: child.start, end: child.end }
    const proposed = { start: child.start - 1, end: child.end + 1 }

    P.updateIssue(child.id, proposed)
    expect(requests).toHaveLength(1)
    expect(latest().name).toBe('roadmap:change')
    expect(P.issueById[child.id]).toMatchObject(proposed)
    expect(P.issueById[parentKey]).toMatchObject(proposed)
    latest().reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await settled()

    expect(showToast).toHaveBeenCalledWith("You don't have permission for that — reverted")
    expect(P.issueById[child.id]).toMatchObject(original)
    expect(P.issueById[parentKey]).toMatchObject(original)
    expect(P.roadmapUndo).toEqual({ count: 0, busy: false, disabled: false })
  })

  it('groups a planning action into one step and waits for all saves before undo or revert all', async () => {
    const [first, second] = P.issues
    P.batchRoadmapChanges(() => {
      P.updateIssue(first.id, { remaining: 12 })
      P.updateIssue(second.id, { remaining: 16 })
    })
    expect(requests).toHaveLength(1)
    expect(latest()).toMatchObject({
      name: 'roadmap:change',
      args: {
        operations: [
          { kind: 'task', id: first.uuid, patch: { remaining_hours: 12 } },
          { kind: 'task', id: second.uuid, patch: { remaining_hours: 16 } },
        ],
      },
    })
    const batch = latest()
    P.updateIssue(first.id, { remaining: 20 })
    const next = latest()
    P.undoRoadmap()
    expect(requests).toHaveLength(2)

    batch.resolve({ count: 1 })
    await vi.waitFor(() => expect(P.roadmapUndo.count).toBe(1))
    expect(P.roadmapUndo.busy).toBe(true)
    P.undoRoadmap(true)
    expect(requests).toHaveLength(2)
    next.resolve({ count: 2 })
    await settled()

    // A remounted Roadmap in another scope still belongs to the same visit.
    P.roadmapContext(true, false)
    P.undoRoadmap()
    expect(latest()).toMatchObject({
      name: 'roadmap:undo',
      args: { session_id: batch.args.session_id, all: false },
    })
    expect(P.roadmapUndo.busy).toBe(true)
    P.undoRoadmap(true)
    expect(requests).toHaveLength(3)
    snap.issues[0].remaining_hours = 12
    snap.issues[1].remaining_hours = 16
    publish(structuredClone(snap))
    latest().resolve({ count: 1 })
    await settled()
    expect(P.issueById[first.id].remaining).toBe(12)
    expect(P.issueById[second.id].remaining).toBe(16)
    expect(P.roadmapUndo.count).toBe(1)

    P.undoRoadmap(true)
    expect(latest()).toMatchObject({
      name: 'roadmap:undo',
      args: { session_id: batch.args.session_id, all: true },
    })
    snap.issues.forEach((item) => {
      item.remaining_hours = 8
    })
    publish(structuredClone(snap))
    latest().resolve({ count: 0 })
    await settled()
    expect(P.issues.map((item) => item.remaining)).toEqual([8, 8])
    expect(P.roadmapUndo).toEqual({ count: 0, busy: false, disabled: false })
  })
})

describe('private demo store disposal', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('discards cached content and refuses late snapshots and write responses after expiry', async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('VITE_APP_MODE', 'demo')
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    })
    vi.stubGlobal('window', { showToast: vi.fn(), clearTimeout })
    const snap = fixture()
    let publish: (snapshot: Snapshot) => void
    let rejectWrite: (error: unknown) => void
    const unsubscribe = vi.fn()
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((_ref, _args, next) => {
      publish = next
      next(structuredClone(snap))
      return unsubscribe
    })
    network.mutation.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject
        }),
    )
    const { P, initStore, disposeDemoStore } = await import('./planner')
    await initStore()
    expect(network.mutation).not.toHaveBeenCalled() // no normal seat-claim path
    const prefKey = `planner.ui.v1:${P.CURRENT_USER}`
    stored.set(prefKey, JSON.stringify({ draft: 'private data' }))
    stored.set('unrelated-app', 'keep')
    P.updateIssue(P.issues[0].id, { remaining: 20 })
    expect(P.issues[0].remaining).toBe(20)
    disposeDemoStore()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(P.loaded).toBe(false)
    expect(P.issues).toEqual([])
    expect(P.users).toEqual([])
    expect(P.projects).toEqual([])
    expect(stored.has(prefKey)).toBe(false)
    expect(stored.get('unrelated-app')).toBe('keep')
    publish!(structuredClone(snap))
    rejectWrite!(new ConvexError({ code: 'forbidden', message: 'Expired demo' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(P.issues).toEqual([])
    expect(P.users).toEqual([])
    expect(P.roadmapUndo.busy).toBe(false)
  })
})

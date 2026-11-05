import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* Tasks load on demand (store/liveParts.ts, store/planner.ts P.askTasks):
   a store boots without them, as the app does, asks for every task once
   something needs them, keeps the projects, people and Inbox live while
   they arrive, and keeps every write accepted meanwhile painted until the
   complete delivery holds it. A load that stops stops only the readers
   that need every task. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
type Double = ReturnType<typeof import('./guard/liveDouble.setup').liveOver>
const double = vi.hoisted(() => ({ live: null as Double | null }))
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
// the desktop notifications the store raises, by their tag (a message id)
const notes = vi.hoisted(() => ({ tags: [] as string[] }))
vi.mock('../lib/notify', async (original) => ({
  ...(await original<typeof import('../lib/notify')>()),
  desktopNotify: (tag: string) => notes.tags.push(tag),
}))
// a demo store, which disposeDemoStore clears, only where a test asks
const demo = vi.hoisted(() => ({ on: false }))
vi.mock('../lib/demoMode', async (original) => {
  const real = await original<typeof import('../lib/demoMode')>()
  return {
    ...real,
    get DEMO_MODE() {
      return demo.on
    },
  }
})

const AT = '2026-09-14T08:00:00.000Z'
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// 128 task windows of 200 task numbers; the last starts at fe000000
const LAST_OF_128 = 'fe000000'

/** A task row of the fixture's project. */
function task(snapshot: Snapshot, id: string, num: number): Snapshot['issues'][number] {
  return {
    id,
    org_id: snapshot.orgs[0].id,
    project_id: snapshot.projects[0].id,
    num,
    title: `Task ${num}`,
    description: '',
    status: 'todo',
    priority: 'medium',
    assignee_id: snapshot.profiles[0].id,
    created_at: AT,
    updated_at: AT,
    paused: false,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  }
}

describe('tasks on demand', () => {
  let store: typeof import('./planner')
  let liveParts: typeof import('./liveParts')
  let snapshot: Snapshot
  let deliver: (snap: Snapshot) => void
  let toasts: string[]

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    toasts = []
    vi.stubGlobal('window', {
      showToast: (msg: string) => toasts.push(msg),
      setTimeout,
      clearTimeout,
    })
    snapshot = plannerFixture()
    snapshot.orgs[0].next_issue_num = 3
    snapshot.issues.push(
      task(snapshot, '01000000-a', 1),
      { ...task(snapshot, '02000000-b', 2), has_subtasks: true },
      { ...task(snapshot, '03000000-c', 3), parent_id: '02000000-b', remaining_hours: 4 },
    )
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      if (getFunctionName(ref) === 'workspace:whole') {
        deliver = receive
        receive(structuredClone(snapshot))
      }
      return () => {}
    })
    liveParts = await import('./liveParts')
    // the app's boot, without the test default's every task
    liveParts.TASKS.atBoot = false
    store = await import('./planner')
  })

  afterEach(() => {
    double.live?.holdWindow(null)
    double.live?.failWindow(null)
    liveParts.STALL.ms = 60_000
    liveParts.TASKS.atBoot = true
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** The task windows the store's registry watched since `spy` began. */
  const taskWatches = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.filter(([ref]) => getFunctionName(ref as never) === 'workspace:tasks').length

  const boot = async () => {
    await store.initStore()
    await tick()
  }
  const held = (uuid: string) => store.P.handleOf(uuid) !== null

  it('boots with no task, asks once, and holds every task once every window answered', async () => {
    const watch = vi.spyOn(double.live as Double, 'watch')
    await boot()
    expect(store.P.loaded).toBe(true)
    expect(taskWatches(watch)).toBe(0)
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
    expect(store.P.tasksHeld()).toBe(false)
    expect(store.P.tasksArriving()).toBe(false)
    // a wait that reads the share keeps waiting
    expect(store.P.stillLoading()).toBe(0)
    expect(held('01000000-a')).toBe(false)
    // the projects and people are there
    expect(store.P.projects).toHaveLength(1)
    store.P.askTasks('roadmap')
    expect(store.P.taskLoad()).toEqual({ state: 'arriving' })
    expect(store.P.tasksArriving()).toBe(true)
    expect(taskWatches(watch)).toBe(1)
    await tick()
    await tick()
    expect(store.P.taskLoad()).toEqual({ state: 'all' })
    expect(store.P.tasksHeld()).toBe(true)
    expect(store.P.tasksArriving()).toBe(false)
    expect(store.P.stillLoading()).toBeNull()
    expect(held('01000000-a')).toBe(true)
    // a second ask subscribes nothing more
    store.P.askTasks('create')
    expect(taskWatches(watch)).toBe(1)
  })

  it('shows no share while the windows arrive, also once most of 128 answered', async () => {
    snapshot.orgs[0].next_issue_num = 128 * 200
    await boot()
    double.live?.holdWindow(LAST_OF_128)
    store.P.askTasks('roadmap')
    for (let i = 0; i < 4; i++) await tick()
    expect(store.P.stillLoading()).toBeCloseTo(127 / 128)
    expect(store.P.taskLoad()).toEqual({ state: 'arriving' })
    // the store holds no task of the windows that arrived
    expect(held('01000000-a')).toBe(false)
    double.live?.holdWindow(null)
    await tick()
    await tick()
    expect(store.P.taskLoad()).toEqual({ state: 'all' })
    expect(held('01000000-a')).toBe(true)
  })

  it('keeps the projects live while tasks arrive, and a write accepted meanwhile painted until the load ends', async () => {
    await boot()
    double.live?.holdWindow('')
    store.P.askTasks('roadmap')
    await tick()
    const project = snapshot.projects[0]
    // someone renames the project: the partial delivery repaints it
    project.name = 'Renamed elsewhere'
    deliver(structuredClone(snapshot))
    await tick()
    expect(store.P.taskLoad()).toEqual({ state: 'arriving' })
    expect(store.P.project(project.id)?.name).toBe('Renamed elsewhere')
    // the person's rename, accepted, stays painted over a later delivery
    // that does not hold it yet
    await store.P.updateProject(project.id, { name: 'Mine' })
    await tick()
    project.description = 'changed too'
    deliver(structuredClone(snapshot))
    await tick()
    expect(store.P.project(project.id)?.name).toBe('Mine')
    // the server applies it and every window answers: the complete
    // delivery holds the write, so the server's rows show from then on
    project.name = 'Mine'
    deliver(structuredClone(snapshot))
    double.live?.holdWindow(null)
    await tick()
    await tick()
    expect(store.P.tasksHeld()).toBe(true)
    project.name = 'Later'
    deliver(structuredClone(snapshot))
    await tick()
    expect(store.P.project(project.id)?.name).toBe('Later')
  })

  it('stops only the task load on a failing window, and keeps writes as made until Try again', async () => {
    await boot()
    double.live?.failWindow('', new Error('boom'))
    store.P.askTasks('roadmap')
    for (let i = 0; i < 3; i++) await tick()
    const load = store.P.taskLoad()
    expect(load.state).toBe('failed')
    expect(load.state === 'failed' && load.reason).toBeTruthy()
    expect(store.TASKS_FAILED_TEXT).toContain('Changes you make show as you made them')
    // not snapshot trouble: edits go on, and the Roadmap keeps waiting
    expect(store.P.snapshotTrouble()).toBeNull()
    expect(store.P.editsPaused()).toBe(false)
    expect(store.P.tasksHeld()).toBe(false)
    expect(store.P.tasksArriving()).toBe(false)
    // a project rename stays painted over someone else's later one
    const project = snapshot.projects[0]
    await store.P.updateProject(project.id, { name: 'Mine' })
    project.name = 'Theirs'
    deliver(structuredClone(snapshot))
    await tick()
    expect(store.P.project(project.id)?.name).toBe('Mine')
    // a create goes ahead, and asks nothing more
    const created = store.P.addIssue({ project: project.id, title: 'New during the failure' })
    expect(created).not.toBeNull()
    expect(
      network.mutation.mock.calls.some(([ref]) => getFunctionName(ref) === 'issues:create'),
    ).toBe(true)
    // Try again ends the failure, and the server's rows show
    double.live?.failWindow(null)
    store.P.retryTasks()
    expect(store.P.taskLoad()).toMatchObject({ state: 'failed', retrying: true })
    for (let i = 0; i < 3; i++) await tick()
    expect(store.P.taskLoad()).toEqual({ state: 'all' })
    expect(store.P.project(project.id)?.name).toBe('Theirs')
  })

  it('stops the task load when the windows stay silent, never as a load without tasks', async () => {
    liveParts.STALL.ms = 30
    await boot()
    double.live?.holdWindow('')
    store.P.askTasks('roadmap')
    await wait(80)
    const load = store.P.taskLoad()
    expect(load.state).toBe('failed')
    expect(load.state === 'failed' && load.reason).toContain('did not arrive in time')
    expect(store.P.tasksHeld()).toBe(false)
    expect(store.P.snapshotTrouble()).toBeNull()
    double.live?.holdWindow(null)
    store.P.retryTasks()
    for (let i = 0; i < 3; i++) await tick()
    expect(store.P.taskLoad()).toEqual({ state: 'all' })
  })

  it('keeps asking through Try again, a fresh registry and a new organization’s re-init', async () => {
    await boot()
    store.P.askTasks('roadmap')
    await tick()
    await tick()
    expect(store.P.tasksHeld()).toBe(true)
    // after a reconnect the parts stay silent, the workspace stalls, and
    // Try again starts every part afresh
    liveParts.STALL.ms = 30
    double.live?.reconnect(['workspace:root'])
    await wait(80)
    expect(store.P.snapshotTrouble()?.kind).toBe('failed')
    const watch = vi.spyOn(double.live as Double, 'watch')
    store.P.retrySnapshot()
    for (let i = 0; i < 4; i++) await tick()
    // the fresh registry asked for every task from its start
    expect(taskWatches(watch)).toBeGreaterThan(0)
    expect(store.P.tasksHeld()).toBe(true)
    expect(held('01000000-a')).toBe(true)
    // a new organization's re-init keeps every task on screen and asks too
    watch.mockClear()
    expect(await store.P.createOrg('Second')).toBe(true)
    expect(taskWatches(watch)).toBeGreaterThan(0)
    expect(store.P.tasksHeld()).toBe(true)
    expect(held('01000000-a')).toBe(true)
  })

  it('fails a new organization’s re-init after an ask whose windows stall, and runs its fallback', async () => {
    await boot()
    store.P.askTasks('roadmap')
    await tick()
    await tick()
    liveParts.STALL.ms = 30
    double.live?.holdWindow('')
    expect(await store.P.createOrg('Second')).toBe(true)
    expect(toasts.some((t) => t.includes('could not load it'))).toBe(true)
    expect(store.P.snapshotTrouble()?.kind).toBe('failed')
    // the fallback's registry asks for every task too
    expect(store.P.tasksHeld()).toBe(true)
  })

  it('fails a new organization’s re-init after an ask whose window fails, and runs its fallback', async () => {
    await boot()
    store.P.askTasks('roadmap')
    await tick()
    await tick()
    double.live?.failWindow('', new Error('boom'), true)
    expect(await store.P.createOrg('Second')).toBe(true)
    expect(toasts.some((t) => t.includes('could not load it'))).toBe(true)
    expect(store.P.snapshotTrouble()?.kind).toBe('failed')
  })

  it('asks without a running registry, and the next one starts with the windows', async () => {
    // a boot that failed leaves no registry
    let first = true
    network.onUpdate.mockImplementation((ref, _args, receive, failed) => {
      if (getFunctionName(ref) === 'workspace:whole') {
        deliver = receive
        if (first) failed(new Error('boom'))
        else receive(structuredClone(snapshot))
        first = false
      }
      return () => {}
    })
    await expect(store.initStore()).rejects.toThrow('boom')
    store.P.askTasks('create')
    // a load on its way, not the not-asked state
    expect(store.P.taskLoad()).toEqual({ state: 'arriving' })
    double.live?.holdWindow('')
    const watch = vi.spyOn(double.live as Double, 'watch')
    await store.initStore()
    for (let i = 0; i < 3; i++) await tick()
    expect(taskWatches(watch)).toBeGreaterThan(0)
    expect(store.P.taskLoad()).toEqual({ state: 'arriving' })
    double.live?.holdWindow(null)
    for (let i = 0; i < 3; i++) await tick()
    expect(store.P.tasksHeld()).toBe(true)
  })

  it('reads a held task’s family, sections, group remaining, parent and delay as still to come while not asked', async () => {
    // a store that holds tasks without every task and without an ask, which
    // the app never reaches since a create asks first, so only checks keyed
    // on every task held (not on the share loaded, null before an ask) pass
    snapshot.projects[0].track_delay = true
    await boot()
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
    const [, group, child] = snapshot.issues
    store.__layerProbe?.plantTasks([
      { ...task(snapshot, '0a000000-due', 7), due_date: '2020-01-06' },
      group,
      // a subtask whose parent the workspace does not hold
      { ...child, id: '0b000000-orphan', num: 8, parent_id: '0f000000-absent' },
    ])
    const of = (uuid: string) => store.P.issueById[store.P.handleOf(uuid) ?? '']
    expect(of('02000000-b')).toBeTruthy()
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
    // the group's subtasks may be still to come
    expect(store.P.isGroup(of('02000000-b'))).toBe(true)
    expect(store.P.remainingOf(of('02000000-b'))).toBeUndefined()
    expect(store.P.familyOf(of('02000000-b'))).toBeNull()
    expect(store.P.sectionsFor('02000000-b')).toBeNull()
    // the subtask's parent is still to come: hidden, never none
    expect(store.P.parentLoading(of('0b000000-orphan'))).toBe(true)
    expect(of('0b000000-orphan')?.hasHiddenParent).toBe(true)
    // no verdict without every owner's work
    expect(store.P.delayOf(of('0a000000-due'))).toBeNull()
    expect(store.P.delayColor(of('0a000000-due'))).toBeNull()
    const before = of('0a000000-due')
    // once every task is held, the workspace judges and lists them
    store.P.askTasks('roadmap')
    for (let i = 0; i < 3; i++) await tick()
    expect(store.P.tasksHeld()).toBe(true)
    expect(store.P.remainingOf(of('02000000-b'))).toBe(4)
    expect(store.P.familyOf(of('02000000-b'))).not.toBeNull()
    expect(store.P.sectionsFor('02000000-b')).not.toBeNull()
    expect(store.P.delayOf(of('0a000000-due'))).toMatchObject({ status: 'late' })
    expect(store.P.delayColor(of('0a000000-due'))).not.toBeNull()
    // views compare tasks by identity, so the task the delay now shows on
    // is a new object though its row did not change
    expect(of('0a000000-due')).not.toBe(before)
  })

  it('keeps a new task’s card from a verdict until every task is held', async () => {
    snapshot.projects[0].track_delay = true
    await boot()
    double.live?.holdWindow('')
    // a new task of the person's, past its due date, its create on its way
    network.mutation.mockImplementation(() => new Promise(() => {}))
    const key = store.P.addIssue({
      project: snapshot.projects[0].id,
      title: 'Ship the late part',
      status: 'todo',
      assignee: snapshot.profiles[0].id,
      remaining: '4',
      due: '2020-01-06',
    })
    await tick()
    expect(store.P.taskLoad()).toEqual({ state: 'arriving' })
    const it = store.P.issueById[key ?? '']
    // the card waits for every task, and the window, which judges a task
    // the workspace cannot judge yet from its owner's load (P.windowDelay),
    // is told to by tasksHeld
    expect(store.P.delayOf(it)).toBeNull()
    expect(store.P.delayColor(it)).toBeNull()
    expect(store.P.tasksHeld()).toBe(false)
    double.live?.holdWindow(null)
    for (let i = 0; i < 3; i++) await tick()
    expect(store.P.tasksHeld()).toBe(true)
    // once every task is held the card shows the verdict too
    expect(store.P.delayOf(store.P.issueById[key ?? ''])).toMatchObject({ status: 'late' })
  })

  it('reads a new task’s family and sections from its own answers during the load', async () => {
    await boot()
    double.live?.holdWindow('')
    store.P.askTasks('roadmap')
    await tick()
    const key = store.P.addIssue({ project: snapshot.projects[0].id, title: 'A new task' })
    const it = store.P.issueById[key ?? '']
    expect(it).toBeTruthy()
    expect(store.P.tasksHeld()).toBe(false)
    expect(store.P.familyOf(it)).toBeNull()
    expect(store.P.sectionsFor(it.uuid)).toBeNull()
    expect(store.P.delayOf(it)).toBeNull()
  })

  /** An unread message to the signed-in person about task `task`, made at
      `at`, of `kind`. */
  const message = (id: string, task: string, at: string, kind = 'change') => ({
    id,
    org_id: snapshot.orgs[0].id,
    recipient_id: snapshot.profiles[0].id,
    issue_id: task,
    issue_title: `Task ${task}`,
    kind: kind as 'change',
    detail: 'Status changed',
    created_at: at,
  })

  it('raises no notification for the stored messages of a task that comes back into view while not asked, and one for a new one', async () => {
    snapshot.delivered_at = '2026-09-14T09:00:00.000Z'
    await boot()
    notes.tags.length = 0
    // access to task x returns: the Inbox part brings its stored message,
    // made before the previous delivery; no task enters the rows
    snapshot.messages.push(message('stored', 'x', '2026-09-14T08:00:00.000Z'))
    snapshot.delivered_at = '2026-09-14T09:30:00.000Z'
    deliver(structuredClone(snapshot))
    await tick()
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
    expect(store.P.messages.some((m) => m.id === 'stored')).toBe(true)
    expect(notes.tags).toEqual([])
    // a new mention on it, made after, notifies
    snapshot.messages.push(message('mention', 'x', '2026-09-14T10:00:00.000Z', 'mention'))
    snapshot.delivered_at = '2026-09-14T10:30:00.000Z'
    deliver(structuredClone(snapshot))
    await tick()
    expect(notes.tags).toEqual(['mention'])
  })

  it('raises no notification for the messages a restore brings back while not asked', async () => {
    snapshot.delivered_at = '2026-09-14T09:00:00.000Z'
    await boot()
    notes.tags.length = 0
    network.mutation.mockResolvedValue({})
    expect(
      await store.P.unarchiveIssue('y', 'Task y', snapshot.projects[0].id, snapshot.orgs[0].id),
    ).toBe(true)
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
    // its stored message, and the Restored notice written after the restore
    snapshot.messages.push(
      message('kept', 'y', '2026-09-14T08:00:00.000Z'),
      message('restored', 'y', '2026-09-14T09:10:00.000Z'),
    )
    snapshot.delivered_at = '2026-09-14T09:30:00.000Z'
    deliver(structuredClone(snapshot))
    await tick()
    expect(store.P.messages.filter((m) => m.issueUuid === 'y')).toHaveLength(2)
    expect(notes.tags).toEqual([])
  })

  it('resets the ask when the demo store is disposed', async () => {
    demo.on = true
    try {
      await boot()
      store.P.askTasks('roadmap')
      await tick()
      await tick()
      expect(store.P.tasksHeld()).toBe(true)
      store.disposeDemoStore()
      expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
      expect(store.P.tasksHeld()).toBe(false)
    } finally {
      demo.on = false
    }
  })
})

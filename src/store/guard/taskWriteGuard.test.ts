import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from '../plannerFixture.setup'

/* The test-build guard against task writes before the store asked for
   every task (store/planner.ts guardTaskWrite, in start): a write that needs
   a task the workspace holds cannot go out while tasks are not asked, since
   none is held then. A write whose task comes from a server answer carries
   that mark (WriteAbout.answer) and passes, and so does a restore. A
   create of a task of its own passes by its name: it paints the views'
   rows and its window, never a task row of the workspace, so it needs no
   ask. A new parent or linked task writes on an existing task too, and
   takes the rule of every task write. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../../lib/convex', async () => {
  const { liveOver } = await import('./liveDouble.setup')
  return { convex: network, live: liveOver(network) }
})
vi.mock('../../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/* The task writes: every api.issues mutation the store sends and the label,
   file and Roadmap task writes, which need a held task as much. A Roadmap
   change needs one only for a task operation, and its undo none. */
const HELD_WRITES = [
  'issues:update',
  'issues:move',
  'issues:archive',
  'issues:deleteDeep',
  'issues:subscribe',
  'issues:unsubscribe',
  'issues:setSubscriber',
  'issues:addLink',
  'issues:removeLink',
  'labels:toggle',
  'files:attach',
  'files:removeAttachment',
  'roadmap:change',
]
/* What a Roadmap change of a task operation sends. */
const TASK_CHANGE = { operations: [{ kind: 'task', id: 'task-1', patch: {} }] }
const argsOf = (name: string) => (name === 'roadmap:change' ? TASK_CHANGE : undefined)
/* The creates that write on an existing task besides making a new one. */
const RELATION_CREATES = ['issues:createParent', 'issues:createLinked']

describe('the guard against task writes before the ask', () => {
  let store: typeof import('../planner')
  let snapshot: Snapshot
  let probe: NonNullable<typeof import('../planner').__layerProbe>

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snapshot = plannerFixture()
    snapshot.orgs[0].next_issue_num = 1
    network.query.mockResolvedValue(null)
    // writes stay on their way, but the boot's seat claim
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'identity:claimMySeats'
        ? Promise.resolve(null)
        : new Promise(() => {}),
    )
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      if (getFunctionName(ref) === 'workspace:whole') receive(structuredClone(snapshot))
      return () => {}
    })
    const { TASKS } = await import('../liveParts')
    TASKS.atBoot = false
    store = await import('../planner')
    await store.initStore()
    await tick()
    if (!store.__layerProbe) throw new Error('no probe in a test build')
    probe = store.__layerProbe
    probe.faults()
  })

  afterEach(async () => {
    const { TASKS } = await import('../liveParts')
    TASKS.atBoot = true
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** A task row of the fixture's project. */
  const row = (id: string, num: number): Snapshot['issues'][number] => ({
    id,
    org_id: snapshot.orgs[0].id,
    project_id: snapshot.projects[0].id,
    num,
    title: `Task ${num}`,
    description: '',
    status: 'todo',
    priority: 'medium',
    created_at: AT,
    updated_at: AT,
    paused: false,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })

  it('faults a write that needs a held task, and passes one a server answer names', () => {
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
    for (const name of HELD_WRITES)
      expect(probe.guardWrite(name, undefined, argsOf(name)), name).toHaveLength(1)
    // the window's answer writes, the pickers' relation writes, the view
    // writes and a Roadmap change of a task an answer brings carry the mark
    for (const name of HELD_WRITES)
      expect(probe.guardWrite(name, { task: 'task-1', answer: true }, argsOf(name)), name).toEqual(
        [],
      )
    // a Roadmap undo restores the server's journal and paints nothing, and a
    // change of milestones alone holds no task
    expect(probe.guardWrite('roadmap:undo')).toEqual([])
    expect(
      probe.guardWrite('roadmap:change', undefined, {
        operations: [{ kind: 'milestone_update', id: 'm-1', patch: {} }],
      }),
    ).toEqual([])
    // a mark that names the task alone is no answer's
    expect(probe.guardWrite('issues:update', { task: 'task-1' })).toHaveLength(1)
    // a restore, and writes that are no task writes
    expect(probe.guardWrite('issues:unarchive')).toEqual([])
    for (const name of ['comments:add', 'messages:markRead', 'projects:update', 'identity:x'])
      expect(probe.guardWrite(name), name).toEqual([])
  })

  it('passes a create of its own by its name, faults a held new parent or linked task, and passes every write after the ask', () => {
    expect(probe.guardWrite('issues:create')).toEqual([])
    for (const name of RELATION_CREATES) {
      expect(probe.guardWrite(name), name).toHaveLength(1)
      expect(probe.guardWrite(name, { task: 'task-1', answer: true }), name).toEqual([])
    }
    store.P.askTasks('script')
    for (const name of ['issues:create', ...RELATION_CREATES, ...HELD_WRITES])
      expect(probe.guardWrite(name, undefined, argsOf(name)), name).toEqual([])
  })

  it("faults a held task's edit and archive sent before the ask, also an awaited one", async () => {
    // a store that holds a task without the ask, which the app never
    // reaches, since a create asks first
    probe.plantTasks([row('task-1', 1)])
    const handle = store.P.handleOf('task-1') ?? ''
    void store.P.updateIssue(handle, { title: 'Renamed' })
    void store.P.archiveIssue(handle)
    await tick()
    const faults = probe.faults().map(String)
    expect(faults.some((f) => f.includes('issues:update went out before'))).toBe(true)
    expect(faults.some((f) => f.includes('issues:archive went out before'))).toBe(true)
  })

  it('lets a create through without an ask, and paints no task row of the workspace', async () => {
    const key = store.P.addIssue({ project: snapshot.projects[0].id, title: 'A new task' })
    expect(key).not.toBeNull()
    await tick()
    expect(probe.faults()).toEqual([])
    expect(probe.asks()).toEqual([])
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
    const { refParts } = await import('../../lib/taskReference')
    expect(store.P.handleOf(refParts(key)?.uuid ?? '')).toBeNull()
    expect(
      network.mutation.mock.calls.some(([ref]) => getFunctionName(ref) === 'issues:create'),
    ).toBe(true)
  })

  it('lets a restore through with no ask', async () => {
    void store.P.unarchiveIssue('task-9', 'Task 9', snapshot.projects[0].id)
    await tick()
    expect(probe.faults()).toEqual([])
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
    expect(
      network.mutation.mock.calls.some(([ref]) => getFunctionName(ref) === 'issues:unarchive'),
    ).toBe(true)
  })
})

import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* A delivery that changes one task costs work for that task and the tasks
   around it, not for every task in the workspace. The store keeps the
   server's unchanged rows (store/workspaceBase.ts), copies only the rows a
   paint reaches (store/rowMap.ts) and reshapes only the tasks a change
   reaches (store/taskIndex.ts). The counts below would each be about 2,000
   if a delivery rebuilt everything. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))
const shapes = vi.hoisted(() => ({ count: 0 }))
vi.mock('./viewModels', async (original) => {
  const actual = await original<typeof import('./viewModels')>()
  return {
    ...actual,
    shapeIssue: (...args: Parameters<typeof actual.shapeIssue>) => {
      shapes.count++
      return actual.shapeIssue(...args)
    },
  }
})

const AT = '2026-09-14T08:00:00.000Z'
const TASKS = 2000

describe('the cost of a delivery', () => {
  let store: typeof import('./planner')
  let snapshot: Snapshot
  let deliver: (snap: Snapshot) => void
  let held: ((value: unknown) => void)[]

  const P = () => store.P
  const row = (id: string) => snapshot.issues.find((issue) => issue.id === id)!

  /** The next delivery: the last one with `change` applied. */
  async function deliverChange(change: () => void) {
    deliverNow(change)
    // a delivery that arrives while an edit waits paints on a 0 ms timer
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  /** deliverChange's delivery, which paints at once while no edit waits. */
  function deliverNow(change: () => void) {
    change()
    snapshot.delivered_at = new Date(Date.parse(snapshot.delivered_at) + 1000).toISOString()
    const next = structuredClone(snapshot)
    deliver(next)
  }

  /** The number of times Map iteration ran over a Map of every task while
      `step` ran. */
  function bigMapWalks(step: () => void): number {
    const proto = Map.prototype
    const originals = {
      entries: proto.entries,
      values: proto.values,
      keys: proto.keys,
      forEach: proto.forEach,
      iterator: proto[Symbol.iterator],
    }
    let walks = 0
    const count = (map: Map<unknown, unknown>) => {
      if (map.size >= TASKS) walks++
    }
    proto.entries = function (this: Map<unknown, unknown>) {
      count(this)
      return originals.entries.call(this)
    }
    proto.values = function (this: Map<unknown, unknown>) {
      count(this)
      return originals.values.call(this)
    }
    proto.keys = function (this: Map<unknown, unknown>) {
      count(this)
      return originals.keys.call(this)
    }
    proto.forEach = function (
      this: Map<unknown, unknown>,
      ...args: Parameters<Map<unknown, unknown>['forEach']>
    ) {
      count(this)
      return originals.forEach.apply(this, args)
    }
    proto[Symbol.iterator] = proto.entries
    try {
      step()
    } finally {
      Object.assign(proto, {
        entries: originals.entries,
        values: originals.values,
        keys: originals.keys,
        forEach: originals.forEach,
      })
      proto[Symbol.iterator] = originals.iterator
    }
    return walks
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snapshot = plannerFixture()
    const task = (n: number, parent?: string): Snapshot['issues'][number] => ({
      id: `task-${n}`,
      org_id: snapshot.orgs[0].id,
      project_id: snapshot.projects[0].id,
      num: n + 1,
      title: `Task ${n + 1}`,
      description: '',
      status: 'todo',
      priority: 'medium',
      assignee_id: snapshot.profiles[0].id,
      start_week: '2026-09-14',
      end_week: '2026-09-21',
      remaining_hours: 4,
      remaining_set_at: AT,
      created_at: AT,
      updated_at: AT,
      paused: false,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
      ...(parent ? { parent_id: parent } : {}),
    })
    // task-0 is a parent of task-1 and task-2; the rest stand alone
    snapshot.issues = Array.from({ length: TASKS }, (_, n) =>
      task(n, n === 1 || n === 2 ? 'task-0' : undefined),
    )
    snapshot.orgs[0].next_issue_num = TASKS + 1
    held = []
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((ref, _args, next) => {
      if (getFunctionName(ref) === 'snapshot:forMe') {
        deliver = next
        next(structuredClone(snapshot))
      }
      return vi.fn()
    })
    network.mutation.mockImplementation((ref) => {
      if (getFunctionName(ref) === 'identity:claimMySeats') return Promise.resolve(null)
      return new Promise((resolve) => held.push(resolve))
    })
    store = await import('./planner')
    await store.initStore()
    // what the steps below cost outside tests
    store.__layerProbe!.uncheck(true)
  })
  afterEach(() => {
    store.__layerProbe!.uncheck(false)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('shapes only the renamed subtask and its family', async () => {
    shapes.count = 0
    await deliverChange(() => {
      row('task-1').title = 'Renamed elsewhere'
    })
    expect(P().issueById['QN-2'].title).toBe('Renamed elsewhere')
    // the subtask, its parent and its sibling
    expect(shapes.count).toBeLessThanOrEqual(3)
  })

  it('copies only the rows a waiting edit paints when another task changes', async () => {
    void P().updateIssue('QN-100', { title: 'Waiting edit' })
    expect(held).toHaveLength(1)
    const copies = store.__layerProbe!.rowCopies()
    shapes.count = 0
    await deliverChange(() => {
      row('task-500').title = 'Renamed elsewhere'
    })
    expect(P().issueById['QN-501'].title).toBe('Renamed elsewhere')
    expect(P().issueById['QN-100'].title).toBe('Waiting edit')
    // the waiting edit paints its task again, on a copy of that row alone
    expect(store.__layerProbe!.rowCopies() - copies).toBeLessThanOrEqual(2)
    expect(shapes.count).toBeLessThanOrEqual(2)
  })

  it('walks no map of every task on a rename', () => {
    const walks = bigMapWalks(() =>
      deliverNow(() => {
        row('task-700').title = 'Renamed elsewhere'
      }),
    )
    expect(P().issueById['QN-701'].title).toBe('Renamed elsewhere')
    expect(walks).toBe(0)
  })
})

import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot, underProgram } from './plannerFixture.setup'

/* A repaint shapes every view model again. The memoized views (Roadmap rows,
   Board cards) skip a task by identity, so the store's contract is that a
   task keeps its object exactly while it, its delay and every task above and
   below it hold the same data, and that P.contextVersion moves when anything
   else a task's view reads changes. A delivery that changes nothing on
   screen notifies no view. The network double captures the snapshot
   subscription, and every write waits until the test answers it. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

type Pending = { name: string; resolve: (value: unknown) => void }
const AT = '2026-09-14T08:00:00.000Z'

describe('view model identity across repaints', () => {
  let store: typeof import('./planner')
  let snapshot: Snapshot
  let deliver: (snap: Snapshot) => void
  let sent: Pending[]
  let emits: number
  let stop: () => void

  const P = () => store.P

  /* The next delivery: the last one with `change` applied, as the server
     holds it. */
  function deliverChange(change: (snap: Snapshot) => void) {
    change(snapshot)
    snapshot.delivered_at = new Date(Date.parse(snapshot.delivered_at) + 1000).toISOString()
    deliver(structuredClone(snapshot))
  }

  function addTask(id: string, parent?: string) {
    snapshot.issues.push({
      id,
      org_id: snapshot.orgs[0].id,
      project_id: snapshot.projects[0].id,
      num: snapshot.issues.length + 1,
      title: `Task ${id}`,
      description: '',
      status: 'todo',
      priority: 'medium',
      assignee_id: snapshot.profiles[0].id,
      created_at: AT,
      updated_at: AT,
      paused: false,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
      ...(parent ? { parent_id: parent } : {}),
    })
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // the project under a top-level project, as every writer stores one
    // that holds tasks, so the navigation reads name it
    snapshot = underProgram(plannerFixture())
    snapshot.projects[0].track_delay = true
    // a parent with two subtasks, and two tasks on their own
    addTask('parent')
    addTask('child-a', 'parent')
    addTask('child-b', 'parent')
    addTask('alone')
    addTask('other')
    sent = []
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((ref, _args, next) => {
      if (getFunctionName(ref) === 'workspace:whole') {
        deliver = next
        next(structuredClone(snapshot))
      }
      return vi.fn()
    })
    network.mutation.mockImplementation((ref) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      return new Promise((resolve) => sent.push({ name, resolve }))
    })
    store = await import('./planner')
    await store.initStore()
    // the views name the projects they show; this suite names them all
    await (await import('./oracleScope.setup')).nameProjects(store.P, snapshot)
    emits = 0
    stop = P().subscribe(() => emits++)
  })
  afterEach(() => {
    stop()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps contextVersion for the organization load and Team sync stamps', () => {
    const context = P().contextVersion
    const people = P().users
    // another person's hours outside this view: only the delays read them
    deliverChange((snap) => {
      snap.orgLoad.push({
        issue_id: null,
        owner_id: snap.profiles[0].id,
        start_week: '2026-09-14',
        end_week: '2026-09-21',
        remaining: 12,
        remaining_set_at: AT,
      })
    })
    expect(P().contextVersion).toBe(context)
    // a change made on a person through Team sync stamps them, which no
    // part sends: the agenda reads the stamps (convex/teamSync.ts agenda)
    deliverChange((snap) => {
      snap.profiles[0].sync_at = '2026-09-16T08:00:00.000Z'
    })
    expect(P().users).toBe(people)
    expect(P().contextVersion).toBe(context)
  })

  it('still notifies for a delivery that changes only rows no view model holds', () => {
    const shown = emits
    // another person's task in a project this person cannot see takes the
    // next number, which only the New task preview reads
    deliverChange((snap) => {
      snap.orgs[0].next_issue_num = 40
    })
    expect(emits).toBe(shown + 1)
  })
})

import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* A large workspace loads in stages (store/liveParts.ts): the store shows
   the task windows that arrived, says it still loads, and keeps every write
   accepted meanwhile painted until the complete transition holds it. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { holdWindow(from: string | null): void },
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
// 12,800 task numbers make 64 task windows; the last starts at fc000000
const LAST_WINDOW = 'fc000000'
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

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
    created_at: AT,
    updated_at: AT,
    paused: false,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  }
}

describe('a staged load', () => {
  let store: typeof import('./planner')
  let snapshot: Snapshot
  let deliver: (snap: Snapshot) => void

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
    snapshot = plannerFixture()
    snapshot.orgs[0].next_issue_num = 64 * 200
    snapshot.projects[0].track_delay = true
    // one task in the first window, one in the last, and a group in the
    // first whose one subtask is done and the other has hours left
    snapshot.issues.push(
      task(snapshot, '01000000-a', 1),
      task(snapshot, 'fd000000-b', 2),
      task(snapshot, '01100000-c', 3),
      { ...task(snapshot, '01200000-d', 4), parent_id: '01100000-c', status: 'done' },
      { ...task(snapshot, '01300000-e', 5), parent_id: '01100000-c', remaining_hours: 3 },
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
    store = await import('./planner')
    // the double this store's module graph made
    double.live?.holdWindow(LAST_WINDOW)
    await store.initStore()
    await tick()
  })

  afterEach(() => {
    double.live?.holdWindow(null)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const shown = (uuid: string) => store.P.issues.some((i) => i.uuid === uuid)
  const title = () => store.P.issues.find((i) => i.uuid === '01000000-a')?.title

  it('shows the tasks that arrived and says it still loads, until every window arrived', async () => {
    expect(store.P.loaded).toBe(true)
    // the stages before the one holding the last window
    const { STAGES } = await import('./liveParts')
    expect(store.P.stillLoading()).toBe(STAGES.first / 64)
    expect(shown('01000000-a')).toBe(true)
    expect(shown('fd000000-b')).toBe(false)
    double.live?.holdWindow(null)
    await tick()
    expect(store.P.stillLoading()).toBeNull()
    expect(shown('fd000000-b')).toBe(true)
  })

  it('keeps a write accepted while it loads painted until the complete transition holds it', async () => {
    store.P.updateIssue(store.P.issues.find((i) => i.uuid === '01000000-a')?.id ?? '', {
      title: 'Mine',
    })
    await tick()
    expect(title()).toBe('Mine')
    // a partial transition from before the server applied the write
    snapshot.issues[0].description = 'Changed elsewhere'
    deliver(structuredClone(snapshot))
    await tick()
    expect(title()).toBe('Mine')
    // the server applied it, and the last window arrives: the complete
    // transition holds the write, so its paint goes
    snapshot.issues[0].title = 'Mine'
    deliver(structuredClone(snapshot))
    double.live?.holdWindow(null)
    await tick()
    expect(store.P.stillLoading()).toBeNull()
    snapshot.issues[0].title = 'Elsewhere'
    deliver(structuredClone(snapshot))
    await tick()
    expect(title()).toBe('Elsewhere')
    expect(shown('fd000000-b')).toBe(true)
  })

  it('gives a group no total and an unknown progress while it loads', async () => {
    const group = store.P.issues.find((i) => i.uuid === '01100000-c')?.id ?? ''
    expect(store.P.isGroup(group)).toBe(true)
    expect(store.P.progressOf(group)).toMatchObject({ unknown: true })
    expect(store.P.remainingOf(group)).toBeUndefined()
    expect(store.P.delayOf(group)).toBeNull()
    double.live?.holdWindow(null)
    await tick()
    expect(store.P.progressOf(group)).toMatchObject({ done: 1, total: 2, unknown: false })
    expect(store.P.remainingOf(group)).toBe(3)
  })
})

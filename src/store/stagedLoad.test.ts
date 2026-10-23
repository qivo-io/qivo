import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* A large workspace loads in stages (store/liveParts.ts): the store shows
   the task windows that arrived, says it still loads, and keeps every write
   accepted meanwhile painted until the complete transition holds it. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | {
    holdWindow(from: string | null): void
    drop(overloaded?: boolean): void
    reconnect(): void
    watchedParts(): number
  },
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
// 12,800 task numbers make 64 task windows; the 17th starts at 40000000,
// the last at fc000000
const SEVENTEENTH_WINDOW = '40000000'
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
  let fail: (error: unknown) => void

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
      { ...task(snapshot, '01100000-c', 3), has_subtasks: true },
      { ...task(snapshot, '01200000-d', 4), parent_id: '01100000-c', status: 'done' },
      { ...task(snapshot, '01300000-e', 5), parent_id: '01100000-c', remaining_hours: 3 },
      // a parent in the first window whose one subtask is in the last
      { ...task(snapshot, '01400000-f', 6), has_subtasks: true },
      { ...task(snapshot, 'fd100000-g', 7), parent_id: '01400000-f' },
      // a group whose done subtask is in the first window and whose open
      // one is in the last
      { ...task(snapshot, '01500000-h', 8), has_subtasks: true },
      { ...task(snapshot, '01600000-i', 9), parent_id: '01500000-h', status: 'done' },
      { ...task(snapshot, 'fd200000-j', 10), parent_id: '01500000-h' },
      // a task due before today: late
      { ...task(snapshot, '01700000-k', 11), due_date: '2020-01-06' },
      // a subtask in the first window whose parent is in the last
      { ...task(snapshot, '01800000-l', 12), parent_id: 'fd300000-m' },
      { ...task(snapshot, 'fd300000-m', 13), has_subtasks: true },
    )
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
    network.onUpdate.mockImplementation((ref, _args, receive, failed) => {
      if (getFunctionName(ref) === 'workspace:whole') {
        deliver = receive
        fail = failed
        receive(structuredClone(snapshot))
      }
      return () => {}
    })
    store = await import('./planner')
  })

  afterEach(() => {
    double.live?.holdWindow(null)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Boots with the task window that starts at `held` answering nothing,
      watching `batch` more task windows each stage, all of them unless
      given. */
  const boot = async (held = LAST_WINDOW, batch = Number.POSITIVE_INFINITY) => {
    const { STAGES } = await import('./liveParts')
    STAGES.batch = batch
    // the double this store's module graph made
    double.live?.holdWindow(held)
    await store.initStore()
    await tick()
  }

  const shown = (uuid: string) => store.P.issues.some((i) => i.uuid === uuid)
  const title = () => store.P.issues.find((i) => i.uuid === '01000000-a')?.title

  it('shows the tasks that arrived and says it still loads, until every window arrived', async () => {
    await boot()
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
    // stages of 16 task windows, the second waiting for its first
    await boot(SEVENTEENTH_WINDOW, 16)
    const { STAGES } = await import('./liveParts')
    expect(store.P.stillLoading()).toBe(STAGES.first / 64)
    store.P.updateIssue(store.P.issues.find((i) => i.uuid === '01000000-a')?.id ?? '', {
      title: 'Mine',
    })
    await tick()
    expect(title()).toBe('Mine')
    // another person's change, then the later stages up to the last window:
    // partial transitions from before the server applied the write
    const other = snapshot.issues.find((i) => i.id === '01100000-c')
    if (other) other.title = 'Changed elsewhere'
    deliver(structuredClone(snapshot))
    double.live?.holdWindow(LAST_WINDOW)
    await tick()
    expect(store.P.stillLoading()).toBe(48 / 64)
    expect(store.P.issues.find((i) => i.uuid === '01100000-c')?.title).toBe('Changed elsewhere')
    expect(title()).toBe('Mine')
    // the server applied it, and the last window arrives: the complete
    // transition holds the write, so its paint goes
    const mine = snapshot.issues.find((i) => i.id === '01000000-a')
    if (mine) mine.title = 'Mine'
    deliver(structuredClone(snapshot))
    double.live?.holdWindow(null)
    await tick()
    expect(store.P.stillLoading()).toBeNull()
    if (mine) mine.title = 'Elsewhere'
    deliver(structuredClone(snapshot))
    await tick()
    expect(title()).toBe('Elsewhere')
    expect(shown('fd000000-b')).toBe(true)
  })

  it('after a drop, asks for one wave and keeps the workspace and a write made meanwhile until a complete transition holds it', async () => {
    await boot()
    double.live?.holdWindow(null)
    await tick()
    expect(store.P.stillLoading()).toBeNull()
    const { BOUND } = await import('./liveParts')
    double.live?.drop()
    expect(double.live?.watchedParts()).toBe(BOUND.wave)
    expect(store.P.waitingForServer()).toBe(true)
    // the parts arrive again in waves; the last window holds the workspace
    double.live?.holdWindow(LAST_WINDOW)
    double.live?.reconnect()
    await tick()
    expect(double.live?.watchedParts()).toBeGreaterThan(BOUND.wave)
    expect(store.P.waitingForServer()).toBe(false)
    store.P.updateIssue(store.P.issues.find((i) => i.uuid === '01000000-a')?.id ?? '', {
      title: 'Mine',
    })
    await tick()
    expect(title()).toBe('Mine')
    // another person's change from before the server applied the write:
    // the workspace shown stays, with every task it had
    const other = snapshot.issues.find((i) => i.id === '01100000-c')
    if (other) other.title = 'Changed elsewhere'
    deliver(structuredClone(snapshot))
    await tick()
    const otherTitle = () => store.P.issues.find((i) => i.uuid === '01100000-c')?.title
    expect(otherTitle()).toBe('Task 3')
    expect(title()).toBe('Mine')
    expect(shown('fd000000-b')).toBe(true)
    // the server applied it, and the last window arrives: the complete
    // transition holds the write, so its paint goes
    const mine = snapshot.issues.find((i) => i.id === '01000000-a')
    if (mine) mine.title = 'Mine'
    deliver(structuredClone(snapshot))
    double.live?.holdWindow(null)
    await tick()
    expect(otherTitle()).toBe('Changed elsewhere')
    expect(title()).toBe('Mine')
    if (mine) mine.title = 'Elsewhere'
    deliver(structuredClone(snapshot))
    await tick()
    expect(title()).toBe('Elsewhere')
  })

  it('takes a parent whose subtasks are still to come for a group, never a leaf', async () => {
    await boot()
    const parent = store.P.issues.find((i) => i.uuid === '01400000-f')?.id ?? ''
    expect(store.P.isGroup(parent)).toBe(true)
    expect(store.P.progressOf(parent)).toMatchObject({ unknown: true })
    double.live?.holdWindow(null)
    await tick()
    expect(store.P.isGroup(parent)).toBe(true)
    expect(store.P.progressOf(parent)).toMatchObject({ done: 0, total: 1, unknown: false })
    expect(store.P.issueById[parent]?.hasHiddenSubtasks).toBe(false)
  })

  it('never calls a group done while a subtask may be still to come', async () => {
    await boot()
    const group = store.P.issues.find((i) => i.uuid === '01500000-h')?.id ?? ''
    expect(store.P.isDone(group)).toBe(false)
    double.live?.holdWindow(null)
    await tick()
    expect(store.P.isDone(group)).toBe(false)
    expect(store.P.progressOf(group)).toMatchObject({ done: 1, total: 2, unknown: false })
  })

  it('paints a delay again once every task arrived, though the task did not change', async () => {
    await boot()
    const late = () => store.P.issues.find((i) => i.uuid === '01700000-k')
    const plain = () => store.P.issues.find((i) => i.uuid === '01000000-a')
    const before = late()
    const plainBefore = plain()
    expect(store.P.delayColor(before?.id ?? '')).toBeNull()
    double.live?.holdWindow(null)
    await tick()
    // views compare tasks by identity, so the task the delay shows on is a
    // new object
    expect(late()).not.toBe(before)
    expect(store.P.delayOf(late()?.id ?? '')).toMatchObject({ status: 'late' })
    expect(store.P.delayColor(late()?.id ?? '')).not.toBeNull()
    // one with no delay keeps its object
    expect(plain()).toBe(plainBefore)
  })

  it('gives a group no total and an unknown progress while it loads', async () => {
    await boot()
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
  it('never shows a subtask whose parent is still to come as one without a parent', async () => {
    await boot()
    const child = () => store.P.issues.find((i) => i.uuid === '01800000-l')
    expect(child()?.parent).toBeNull()
    expect(child()?.hasHiddenParent).toBe(true)
    expect(store.P.parentLoading(child()?.id ?? '')).toBe(true)
    double.live?.holdWindow(null)
    await tick()
    expect(child()?.parent).toBe(store.P.issues.find((i) => i.uuid === 'fd300000-m')?.id)
    expect(child()?.hasHiddenParent).toBe(false)
    expect(store.P.parentLoading(child()?.id ?? '')).toBe(false)
  })

  it('settles a boot that waits for the whole workspace only on the complete transition', async () => {
    double.live?.holdWindow(LAST_WINDOW)
    let settled = false
    const booted = store.initStore(undefined, undefined, { whole: true }).then(() => {
      settled = true
    })
    for (let i = 0; i < 5; i++) await tick()
    expect(settled).toBe(false)
    double.live?.holdWindow(null)
    await booted
    expect(store.P.stillLoading()).toBeNull()
    expect(shown('fd000000-b')).toBe(true)
  })

  it('keeps saying it loads, with the tasks shown, when a later stage fails', async () => {
    await boot()
    const share = store.P.stillLoading()
    fail(new Error('boom'))
    await tick()
    expect(store.P.snapshotTrouble()?.kind).toBe('failed')
    expect(store.P.stillLoading()).toBe(share)
    expect(shown('01000000-a')).toBe(true)
  })

  it('ends the load with the paint of the complete delivery, after a write answered later', async () => {
    await boot()
    let answer = (_value: unknown) => {}
    network.mutation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    store.P.updateIssue(store.P.issues.find((i) => i.uuid === '01000000-a')?.id ?? '', {
      title: 'Mine',
    })
    await tick()
    const mine = snapshot.issues.find((i) => i.id === '01000000-a')
    if (mine) mine.title = 'Mine'
    deliver(structuredClone(snapshot))
    double.live?.holdWindow(null)
    // the complete delivery waits for the write's answer or a 0 ms timer,
    // and the rows on screen are the partial ones until it paints
    expect(store.P.stillLoading()).not.toBeNull()
    expect(shown('fd000000-b')).toBe(false)
    await tick()
    expect(store.P.stillLoading()).toBeNull()
    expect(shown('fd000000-b')).toBe(true)
    answer(null)
    await tick()
    expect(title()).toBe('Mine')
    if (mine) mine.title = 'Elsewhere'
    deliver(structuredClone(snapshot))
    await tick()
    expect(title()).toBe('Elsewhere')
  })
})

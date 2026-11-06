import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeletedRow, DeletedTarget } from '../lib/deletedItems'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* A Deleted items restore and Delete now as the store runs them
   (planner.ts runDeletedItems) on the shared runner, with the network
   mocked: every restore or purge call waits until the test answers or
   refuses it, and the store's deletedItems.item watches of deferred items
   take the rows the test delivers. Restores of more than 25 items use 30
   to 60 items, never a design-size figure. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

type Call = {
  name: string
  args: { org_id: string; ids: string[]; bulk?: boolean }
  resolve: (answer: unknown) => void
  reject: (error: unknown) => void
}
type Watch = {
  id: string
  next: (row: DeletedRow | null) => void
  open: boolean
}

const A = 'org-a'
const B = 'org-b'
const C = 'org-c'
const NAMES: Record<string, string> = { [A]: 'Testbed Labs', [B]: 'Partner Co', [C]: 'Field Ops' }

let store: typeof import('./planner')
let P: typeof import('./planner')['P']
let calls: Call[]
let watches: Watch[]
let showToast: ReturnType<typeof vi.fn>
let dismissToast: ReturnType<typeof vi.fn>

async function load() {
  vi.resetModules()
  showToast = vi.fn()
  dismissToast = vi.fn()
  vi.stubGlobal('window', { showToast, dismissToast })
  calls = []
  watches = []
  const snap: Snapshot = plannerFixture()
  network.query.mockResolvedValue(null)
  network.onUpdate.mockImplementation((ref, args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    if (name === 'deletedItems:item') {
      const watch: Watch = { id: args.id, next, open: true }
      watches.push(watch)
      return () => {
        watch.open = false
      }
    }
    return () => {}
  })
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    return new Promise((resolve, reject) => calls.push({ name, args, resolve, reject }))
  })
  store = await import('./planner')
  await store.initStore()
  P = store.P
}

afterEach(() => {
  vi.unstubAllGlobals()
  network.mutation.mockReset()
  network.query.mockReset()
  network.onUpdate.mockReset()
})

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** `n` task items of organization `org`, numbered from `from`. */
const tasks = (org: string, n: number, from = 1): DeletedTarget[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${org}:t${from + i}`,
    org_id: org,
    org_name: NAMES[org],
    kind: 'task',
    path: ['Luma Sensor', 'Firmware'],
    key: `QN-${from + i}`,
    title: `Task ${from + i}`,
  }))
const project = (org: string, id: string, path: string[] = []): DeletedTarget => ({
  id,
  org_id: org,
  org_name: NAMES[org],
  kind: 'project',
  path,
  key: id.toUpperCase(),
  title: `Project ${id}`,
})

/** A call's answer: every id restored, unless `patch` says otherwise. */
function restored(call: Call, patch: Record<string, unknown> = {}) {
  call.resolve({ restored: call.args.ids, refused: [], deferred: [], stepping: [], ...patch })
}
/** Answers the oldest call still waiting. */
async function answerNext(patch?: Record<string, unknown>) {
  const call = calls.shift()
  if (!call) throw new Error('no call waits')
  restored(call, patch)
  await settle()
  return call
}

/** A deferred item's row as deletedItems.item answers it. */
const row = (id: string, patch: Partial<DeletedRow> = {}): DeletedRow => ({
  id,
  org_id: A,
  org_name: NAMES[A],
  kind: 'task',
  key: 'QN-7',
  title: 'Book test sites',
  counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
  projects: [],
  path: ['Field trial Q3', 'Sites'],
  archived: false,
  deleted_at: '2026-10-15T16:40:00.000Z',
  deleter: { you: true, profile_id: 'me', name: 'Planner', kind: 'app', who: 'me|app' },
  state: 'ready',
  can_restore: false,
  blocked: { reason: 'project_deleted', item_id: 'trial' },
  can_purge: false,
  ...patch,
})
const watchOf = (id: string) => watches.filter((w) => w.id === id && w.open)
const toastTexts = () => showToast.mock.calls.map(([text]) => text as string)

describe('a restore of more than one round', () => {
  it('sends 60 items of one organization in calls of 25, 25 and 10, one at a time, projects first', async () => {
    await load()
    const items = [...tasks(A, 58), project(A, 'sub', ['Luma Sensor']), project(A, 'top')]
    const done = P.restoreDeletedItems(items, { bulk: true })
    await settle()
    expect(calls).toHaveLength(1)
    expect(calls[0].args.ids).toHaveLength(25)
    // the top-level project item, then the sub-project item, then tasks
    expect(calls[0].args.ids.slice(0, 3)).toEqual(['top', 'sub', `${A}:t1`])
    expect(calls[0].args).toMatchObject({ org_id: A, bulk: true })
    expect(P.deletedAction).toMatchObject({
      state: 'running',
      long: true,
      total: 60,
      done: 0,
      lanes: 1,
      lanesDone: 0,
    })
    expect(P.deletedAction?.pending).toHaveLength(60)
    await answerNext()
    expect(P.deletedAction).toMatchObject({ done: 25, lanesDone: 0 })
    expect(P.deletedAction?.pending).toHaveLength(35)
    // the next call only once the first answered, never two at once
    expect(calls).toHaveLength(1)
    expect(calls[0].args.ids).toHaveLength(25)
    expect(calls[0].args.bulk).toBe(true)
    await answerNext()
    expect(calls[0].args.ids).toEqual(tasks(A, 10, 49).map((t) => t.id))
    await answerNext()
    const outcome = await done
    expect(outcome.done).toHaveLength(60)
    expect(P.deletedAction).toMatchObject({ state: 'finished', done: 60, lanesDone: 1 })
    expect(P.deletedAction?.pending).toEqual([])
    expect(showToast).toHaveBeenCalledWith('Restored 60 items.', 'success')
  })

  it('runs on the lanes every large action shares', async () => {
    await load()
    const { LANE_POOL } = await import('../lib/batchRunner')
    const done = P.restoreDeletedItems([...tasks(A, 30), ...tasks(B, 30)], { bulk: true })
    await settle()
    expect(calls.map((c) => c.args.org_id)).toEqual([A, B])
    // both shared places are taken, so another large action would wait
    const taken = LANE_POOL.take()
    expect(taken).toBeInstanceOf(Promise)
    for (let i = 0; i < 4; i++) await answerNext()
    expect((await done).done).toHaveLength(60)
    const release = await taken
    release?.()
  })

  it('runs two organizations at once and the third once one finishes', async () => {
    await load()
    const done = P.restoreDeletedItems([...tasks(A, 3), ...tasks(B, 2), ...tasks(C, 4)], {
      bulk: true,
    })
    await settle()
    expect(calls.map((c) => c.args.org_id)).toEqual([A, B])
    expect(P.deletedAction).toMatchObject({ long: true, lanes: 3 })
    restored(calls[1])
    calls.splice(1, 1)
    await settle()
    expect(calls.map((c) => c.args.org_id)).toEqual([A, C])
    expect(P.deletedAction?.lanesDone).toBe(1)
    await answerNext()
    await answerNext()
    expect((await done).done).toHaveLength(9)
    expect(showToast).toHaveBeenCalledWith('Restored 9 tasks.', 'success')
  })

  it('stops an organization at a call refused whole, leaves its later ids unsent and lets the other finish', async () => {
    await load()
    const done = P.restoreDeletedItems([...tasks(A, 60), ...tasks(B, 10)], { bulk: true })
    await settle()
    // A's first call and B's only one
    await answerNext()
    expect(calls.map((c) => c.args.org_id)).toEqual([B, A])
    calls[1].reject(new Error('offline'))
    calls.splice(1, 1)
    await settle()
    // A sends nothing after its refusal
    expect(calls.map((c) => c.args.org_id)).toEqual([B])
    await answerNext()
    const outcome = await done
    expect(outcome.done).toHaveLength(35)
    expect(outcome.failed).toEqual(tasks(A, 25, 26).map((t) => t.id))
    expect(outcome.unsent).toEqual(tasks(A, 10, 51).map((t) => t.id))
    expect(P.deletedAction).toMatchObject({ state: 'stopped', done: 35, refused: 25 })
    expect(showToast).toHaveBeenCalledWith(
      "Restoring stopped after 25 of 60 tasks in Testbed Labs. 25 couldn't be restored and 10 were not sent. They stay in Deleted items. Try again.",
      'error',
      expect.objectContaining({ sticky: true, key: `deleted-restore:${A}` }),
    )
    // no end toast claims the action done
    expect(toastTexts().some((text) => text.startsWith('Restored'))).toBe(false)
  })

  it('stops every organization at the pause with one toast, the queued one before it sends', async () => {
    await load()
    const done = P.restoreDeletedItems([...tasks(A, 30), ...tasks(B, 30), ...tasks(C, 5)], {
      bulk: true,
    })
    await settle()
    expect(calls.map((c) => c.args.org_id)).toEqual([A, B])
    calls[0].reject(new ConvexError({ code: 'paused', message: 'Qivo is offline.' }))
    calls.shift()
    await settle()
    // B's call in flight lands, then B stops; C never sends
    await answerNext()
    const outcome = await done
    expect(calls).toEqual([])
    expect(network.mutation.mock.calls.map(([, args]) => args.org_id)).not.toContain(C)
    expect(outcome.done).toHaveLength(25)
    expect(outcome.unsent).toHaveLength(5 + 5 + 5)
    const stops = showToast.mock.calls.filter(([, , o]) => o?.sticky)
    expect(stops).toEqual([
      [
        "Restoring stopped after 25 tasks in Partner Co. 25 couldn't be restored and 15 were not sent. They stay in Deleted items. Qivo is offline.",
        'error',
        expect.objectContaining({ key: 'deleted-restore:pause' }),
      ],
    ])
  })

  it('says how many go on restoring in the background', async () => {
    await load()
    const items = tasks(A, 30)
    const done = P.restoreDeletedItems(items, { bulk: true })
    await settle()
    await answerNext({ stepping: [items[0].id, items[1].id] })
    await answerNext({ stepping: [items[29].id] })
    await done
    expect(showToast).toHaveBeenCalledWith(
      'Restored 30 tasks. 3 of them finish restoring in the background.',
      'success',
    )
  })

  it('takes away an earlier stop toast of an organization that now finishes', async () => {
    await load()
    const first = P.restoreDeletedItems(tasks(A, 30), { bulk: true })
    await settle()
    calls.shift()?.reject(new Error('offline'))
    await first
    expect(dismissToast).not.toHaveBeenCalled()
    const second = P.restoreDeletedItems(tasks(A, 30), { bulk: true })
    await settle()
    await answerNext()
    await answerNext()
    await second
    expect(dismissToast).toHaveBeenCalledWith(`deleted-restore:${A}`)
  })

  it('ends at a fault with the ids of the call in flight unknown, and says so', async () => {
    await load()
    const broken = tasks(A, 2).map((t) => ({
      ...t,
      get org_name(): string {
        throw new Error('a name that throws')
      },
    }))
    const done = P.restoreDeletedItems([...broken, ...tasks(B, 2), ...tasks(C, 1)], {
      bulk: true,
    })
    await settle()
    // A's refusal reaches onStop, whose organization name throws
    calls.shift()?.reject(new Error('offline'))
    const outcome = await done
    expect(outcome.unknown).toEqual(tasks(B, 2).map((t) => t.id))
    expect(outcome.unsent).toEqual(tasks(C, 1).map((t) => t.id))
    expect(P.deletedAction?.state).toBe('stopped')
    expect(showToast).toHaveBeenCalledWith(
      'Restoring stopped after a fault in Qivo. What it already did stays done.',
      'error',
    )
    // B's answer, when it lands, sends nothing more
    restored(calls[0])
    await settle()
    expect(network.mutation.mock.calls.map(([, a]) => a.org_id)).not.toContain(C)
  })
})

describe('an action of one round', () => {
  it('sends at once, never claims long and never toasts from the store', async () => {
    await load()
    const done = P.restoreDeletedItems(tasks(A, 2), { bulk: true })
    await settle()
    expect(P.deletedAction).toMatchObject({ state: 'running', long: false })
    await answerNext()
    expect((await done).done).toHaveLength(2)
    expect(showToast).not.toHaveBeenCalled()
    expect(P.deletedAction).toMatchObject({ state: 'finished', long: false })
  })

  it('runs on lanes of its own, so it never waits behind a large action', async () => {
    await load()
    const { LANE_POOL } = await import('../lib/batchRunner')
    const done = P.restoreDeletedItems([...tasks(A, 2), ...tasks(B, 2)], { bulk: true })
    await settle()
    expect(calls.map((c) => c.args.org_id)).toEqual([A, B])
    expect(P.deletedAction).toMatchObject({ long: false, lanes: 2 })
    // both of its calls are in flight, and the shared places are free
    const first = LANE_POOL.take()
    const second = LANE_POOL.take()
    expect(first).toBeTypeOf('function')
    expect(second).toBeTypeOf('function')
    for (const ticket of [first, second]) if (typeof ticket === 'function') ticket()
    await answerNext()
    await answerNext()
    expect((await done).done).toHaveLength(4)
  })

  it('refuses a second action while one runs, sending nothing', async () => {
    await load()
    void P.restoreDeletedItems(tasks(A, 30), { bulk: true })
    await settle()
    const second = await P.purgeDeletedItems(tasks(B, 1))
    expect(second).toMatchObject({
      done: [],
      failed: [`${B}:t1`],
      error: store.DELETED_BUSY_TEXT,
    })
    expect(calls.map((c) => c.name)).toEqual(['deletedItems:restore'])
  })

  it('deletes one item for good through the same runner', async () => {
    await load()
    const [item] = tasks(A, 1)
    const done = P.purgeDeletedItems([item])
    await settle()
    expect(calls[0]).toMatchObject({
      name: 'deletedItems:purge',
      args: { org_id: A, ids: [item.id] },
    })
    calls.shift()?.resolve({ purged: [item.id], refused: [] })
    expect(await done).toMatchObject({ done: [item.id], failed: [], unsent: [] })
    expect(showToast).not.toHaveBeenCalled()
  })
})

describe('items a restore deferred', () => {
  /** Restores Field trial Q3 with QN-7, which the server defers. */
  async function deferOne(bulk = false) {
    await load()
    const trial = project(A, 'trial')
    const [task] = tasks(A, 1, 7)
    const done = P.restoreDeletedItems([trial, task], { bulk })
    await settle()
    await answerNext({ restored: ['trial'], deferred: [task.id], stepping: ['trial'] })
    const outcome = await done
    return { task, outcome }
  }

  it('watches a deferred item and sends it again once its row says it can be restored', async () => {
    const { task, outcome } = await deferOne(true)
    expect(outcome).toMatchObject({ done: ['trial'], deferred: [task.id] })
    expect(P.deletedWaiting.has(task.id)).toBe(true)
    expect(watchOf(task.id)).toHaveLength(1)
    // still behind its project, whose restore goes on in steps
    watchOf(task.id)[0].next(row(task.id))
    await settle()
    expect(watchOf('trial')).toHaveLength(1)
    watchOf('trial')[0].next(row('trial', { kind: 'project', state: 'restoring' }))
    await settle()
    expect(calls).toEqual([])
    watchOf('trial')[0].next(null)
    watchOf(task.id)[0].next(row(task.id, { can_restore: true, blocked: undefined }))
    await settle()
    expect(calls[0]).toMatchObject({
      name: 'deletedItems:restore',
      args: { org_id: A, ids: [task.id], bulk: true },
    })
    await answerNext()
    expect(watchOf(task.id)).toEqual([])
    expect(watchOf('trial')).toEqual([])
    expect(P.deletedWaiting.size).toBe(0)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('drops the watch of an item that left Deleted items', async () => {
    const { task } = await deferOne()
    watchOf(task.id)[0].next(null)
    await settle()
    expect(watchOf(task.id)).toEqual([])
    expect(calls).toEqual([])
    expect(P.deletedWaiting.size).toBe(0)
  })

  it('says a second send the server refuses, by the item’s key', async () => {
    const { task } = await deferOne()
    watchOf(task.id)[0].next(row(task.id, { can_restore: true, blocked: undefined }))
    await settle()
    expect(calls[0].args).toEqual({ org_id: A, ids: [task.id] })
    await answerNext({ restored: [], refused: [{ id: task.id, reason: 'view_only' }] })
    expect(showToast).toHaveBeenCalledWith(
      "Couldn't restore QN-7. You can only view its project now.",
      'error',
    )
    expect(watchOf(task.id)).toEqual([])
  })

  it('ends with the reason when its project is back but it still cannot come back', async () => {
    const { task } = await deferOne()
    watchOf(task.id)[0].next(
      row(task.id, { blocked: { reason: 'project_archived', project: 'Sites' } }),
    )
    await settle()
    expect(showToast).toHaveBeenCalledWith(
      "Couldn't restore QN-7. Restore Sites from Archived projects first.",
      'error',
    )
    expect(calls).toEqual([])
  })

  it('ends when the project item it waits for went back after a failed restore', async () => {
    const { task } = await deferOne()
    watchOf(task.id)[0].next(row(task.id))
    await settle()
    watchOf('trial')[0].next(row('trial', { kind: 'project', state: 'ready' }))
    await settle()
    expect(showToast).toHaveBeenCalledWith(
      "Couldn't restore QN-7. Its project couldn't be restored.",
      'error',
    )
    expect(watchOf(task.id)).toEqual([])
  })

  it('lets a new action run beside the watch, whose second send skips the busy rule', async () => {
    const { task } = await deferOne()
    expect(P.deletedAction?.state).toBe('finished')
    void P.restoreDeletedItems(tasks(B, 30), { bulk: true })
    await settle()
    expect(P.deletedAction?.state).toBe('running')
    watchOf(task.id)[0].next(row(task.id, { can_restore: true, blocked: undefined }))
    await settle()
    expect(calls.map((c) => c.args.ids)).toContainEqual([task.id])
  })

  it('counts deferred items past 25 as not sent', async () => {
    await load()
    const trial = project(A, 'trial')
    const items = [trial, ...tasks(A, 24)]
    const more = tasks(A, 4, 30)
    const done = P.restoreDeletedItems([...items, ...more], { bulk: true })
    await settle()
    await answerNext({ restored: ['trial'], deferred: items.slice(1).map((t) => t.id) })
    await answerNext({ restored: [], deferred: more.map((t) => t.id) })
    const outcome = await done
    expect(outcome.deferred).toHaveLength(25)
    expect(outcome.unsent).toEqual(more.slice(1).map((t) => t.id))
    expect(P.deletedWaiting.size).toBe(25)
    expect(showToast).toHaveBeenCalledWith(
      'Restored 1 of 29 items. 25 follow once their project is back. QN-31, QN-32 and QN-33 were not sent and stay in Deleted items.',
      'error',
      expect.objectContaining({ sticky: true }),
    )
  })
})

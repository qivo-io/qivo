import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

type Planner = typeof import('./planner')['P']

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

const NOW = '2026-09-14T08:00:00.000Z'

/* Deleting a task moves it to Deleted items, where it can be restored, so
 * the store takes it off the board and a later delivery may bring it back.
 * The signed-in person edits Work and only views Specs, both under Plan. The
 * root task in Work has subtasks a (Work, with aa in Work and ab in Specs
 * under it) and b (Specs, with ba under it). Each test says which tasks also
 * have subtasks in projects they cannot see. */
describe('moving a task that has subtasks to Deleted items', () => {
  let P: Planner
  let org: string
  // what the server holds now; deliver() sends it as the next snapshot
  let server: Snapshot
  let deliver: () => void
  let requests: { name: string; args: Record<string, unknown> }[]
  // the server's answer per mutation name; a write without one never settles
  let answers: Record<string, () => Promise<unknown>>

  // the tasks that have subtasks in projects the person cannot see
  async function load(hidden: string[]) {
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    requests = []
    answers = {}
    network.query.mockResolvedValue(null)
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      requests.push({ name, args })
      return answers[name]?.() ?? new Promise(() => {})
    })
    server = plannerFixture()
    org = server.orgs[0].id
    const me = server.profiles[0]
    me.org_role = 'user'
    const base = server.projects[0]
    server.projects = [
      { ...base, id: 'plan', type: 'meta', key: 'PLAN', name: 'Plan' },
      {
        ...base,
        id: 'work',
        type: 'project',
        key: 'WORK',
        num: 2,
        name: 'Work',
        parent_id: 'plan',
      },
      {
        ...base,
        id: 'specs',
        type: 'project',
        key: 'SPEC',
        num: 3,
        name: 'Specs',
        parent_id: 'plan',
      },
    ]
    server.access.push(
      { project_id: 'work', profile_id: me.id, level: 'user' },
      { project_id: 'specs', profile_id: me.id, level: 'viewer' },
    )
    const task = (id: string, num: number, project_id: string, parent_id?: string) => ({
      id,
      org_id: org,
      project_id,
      parent_id,
      num,
      title: id,
      description: '',
      status: 'todo' as const,
      priority: 'low' as const,
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      has_hidden_subtasks: hidden.includes(id),
      has_hidden_parent: false,
    })
    server.issues.push(
      task('root', 1, 'work'),
      task('a', 2, 'work', 'root'),
      task('b', 3, 'specs', 'root'),
      task('aa', 4, 'work', 'a'),
      task('ba', 5, 'work', 'b'),
      task('ab', 6, 'specs', 'a'),
    )
    network.onUpdate.mockImplementation((ref, _args, next) => {
      if (getFunctionName(ref) === 'workspace:whole') {
        deliver = () => next(structuredClone(server))
        deliver()
      }
      return () => {}
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
  }

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const vm = (uuid: string) => P.issues.find((it) => it.uuid === uuid)
  const handle = (uuid: string) => vm(uuid)?.id ?? ''
  const accept = (name: string, value: unknown = null) => {
    answers[name] = () => Promise.resolve(value)
  }
  /* The server's tasks after it moved `gone` to Deleted items. Every task
     left under a moved one becomes top-level. */
  const moveToTrash = (gone: string[]) => {
    const kept = server.issues.filter((t) => !gone.includes(t.id))
    for (const t of kept) if (t.parent_id && gone.includes(t.parent_id)) t.parent_id = undefined
    const moved = server.issues.filter((t) => gone.includes(t.id))
    server.issues = kept
    return moved
  }

  it('lists what can be deleted, and stops under a subtask that cannot', async () => {
    await load(['a']) // a subtask that would be deleted has unseen subtasks
    const plan = P.deletePlan(handle('root'))
    expect(plan.rows.map((r) => [r.task.uuid, r.depth, r.deletable])).toEqual([
      ['a', 0, true],
      ['aa', 1, true],
      ['ab', 1, false], // view only
      ['b', 0, false], // view only; ba stays under it, so it is not listed
    ])
    expect(plan.deletable.map((t) => t.uuid)).toEqual(['a', 'aa'])
    expect(plan.hidden).toBe(true)
  })

  it('does not count unseen subtasks under a subtask that stays', async () => {
    await load(['b'])
    expect(P.deletePlan(handle('root')).hidden).toBe(false)
    await load(['root'])
    expect(P.deletePlan(handle('root')).hidden).toBe(true)
  })

  it('takes the chosen subtasks off the board and leaves the others as top-level tasks', async () => {
    await load([])
    const plan = P.deletePlan(handle('root'))
    P.deleteIssue(
      handle('root'),
      plan.deletable.map((t) => t.id),
    )
    expect(['root', 'a', 'aa'].map(vm)).toEqual([undefined, undefined, undefined])
    expect(vm('b')?.parent).toBeNull()
    expect(vm('ab')?.parent).toBeNull() // its parent a was deleted
    expect(vm('ba')?.parent).toBe(handle('b'))
    expect(requests).toEqual([
      {
        name: 'issues:deleteDeep',
        args: expect.objectContaining({ id: 'root', subtask_ids: ['a', 'aa'] }),
      },
    ])
  })

  it('keeps every subtask when none are chosen', async () => {
    await load([])
    P.deleteIssue(handle('root'))
    expect(vm('a')?.parent).toBeNull()
    expect(vm('aa')?.parent).toBe(handle('a'))
    expect(requests[0].args).not.toHaveProperty('subtask_ids')
  })

  it('waits for the server when asked, and changes nothing on a refusal', async () => {
    await load([])
    let settle: (value: null) => void = () => {}
    answers['issues:deleteDeep'] = () => new Promise((resolve) => (settle = resolve))
    const deleted = P.deleteIssue(handle('root'), [handle('a')], true)
    expect(vm('root')).toBeDefined() // nothing changes before the server answers
    settle(null)
    expect(await deleted).toBe(true)
    expect(vm('root')).toBeUndefined()
    expect(vm('a')).toBeUndefined()
    expect(vm('aa')?.parent).toBeNull()
    answers['issues:deleteDeep'] = () => Promise.reject(new Error('the subtasks changed'))
    expect(await P.deleteIssue(handle('b'), [], true)).toBe(false)
    expect(vm('b')).toBeDefined()
    // nothing painted, so the toast says nothing was reverted
    expect(vi.mocked(window.showToast).mock.calls.at(-1)?.[0]).toBe("Couldn't save.")
  })

  it('shows a restored task again under its key, while the subtasks it left stay top-level', async () => {
    await load([])
    const key = handle('root')
    accept('issues:deleteDeep')
    expect(await P.deleteIssue(key, [handle('a'), handle('aa')], true)).toBe(true)
    const moved = moveToTrash(['root', 'a', 'aa'])
    deliver()
    expect(vm('root')).toBeUndefined()

    accept('deletedItems:restore', { restored: ['item-1'], refused: [], deferred: [] })
    const outcome = await P.restoreDeletedItems([{ id: 'item-1', org_id: org }])
    expect(outcome.done).toEqual(['item-1'])
    expect(requests.at(-1)).toEqual({
      name: 'deletedItems:restore',
      args: { org_id: org, ids: ['item-1'] },
    })
    // the store waits for the delivery that holds the restored tasks
    expect(vm('root')).toBeUndefined()
    server.issues.push(...moved)
    deliver()
    expect(vm('root')?.id).toBe(key)
    expect(vm('a')?.parent).toBe(key)
    expect(vm('aa')?.parent).toBe(handle('a'))
    // b and ab stayed when their parents left, and do not go back under them
    expect(vm('b')?.parent).toBeNull()
    expect(vm('ab')?.parent).toBeNull()
  })

  it('leaves a task in Deleted items when the server refuses to restore it', async () => {
    await load([])
    accept('issues:deleteDeep')
    expect(await P.deleteIssue(handle('aa'), [], true)).toBe(true)
    moveToTrash(['aa'])
    deliver()

    accept('deletedItems:restore', {
      restored: [],
      refused: [{ id: 'item-2', reason: 'view_only' }],
      deferred: [],
    })
    const refused = await P.restoreDeletedItems([{ id: 'item-2', org_id: org }])
    expect(refused).toMatchObject({ done: [], refused: [{ id: 'item-2', reason: 'view_only' }] })
    answers['deletedItems:restore'] = () => Promise.reject(new Error('offline'))
    const failed = await P.restoreDeletedItems([{ id: 'item-2', org_id: org }])
    expect(failed).toMatchObject({ done: [], failed: ['item-2'] })
    expect(failed.error).toMatch(/^Couldn't restore/)
    deliver()
    expect(vm('aa')).toBeUndefined()
    expect(vm('a')?.parent).toBe(handle('root'))
  })
})

import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

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

/* Deleting a task with subtasks. The signed-in person edits Work and only
 * views Specs, both under Plan. The root task in Work has subtasks a (Work,
 * with aa in Work and ab in Specs under it) and b (Specs, with ba under it).
 * Each test says which tasks also have subtasks in projects they cannot see. */
describe('deleting a task that has subtasks', () => {
  let P: Planner
  let requests: { name: string; args: Record<string, unknown> }[]
  // how the server answers deleteDeep: never, accept or refuse
  let answer: Promise<null> | null

  // the tasks that have subtasks in projects the person cannot see
  async function load(hidden: string[]) {
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    requests = []
    network.query.mockResolvedValue(null)
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      requests.push({ name, args })
      return answer ?? new Promise(() => {})
    })
    const snap: Snapshot = plannerFixture()
    const org = snap.orgs[0].id
    const me = snap.profiles[0]
    me.org_role = 'user'
    const base = snap.projects[0]
    snap.projects = [
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
    snap.access.push(
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
    snap.issues.push(
      task('root', 1, 'work'),
      task('a', 2, 'work', 'root'),
      task('b', 3, 'specs', 'root'),
      task('aa', 4, 'work', 'a'),
      task('ba', 5, 'work', 'b'),
      task('ab', 6, 'specs', 'a'),
    )
    network.onUpdate.mockImplementation((ref, _args, next) => {
      if (getFunctionName(ref) === 'snapshot:forMe') next(structuredClone(snap))
      return () => {}
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
  }

  beforeEach(() => {
    vi.resetModules()
    answer = null
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const vm = (uuid: string) => P.issues.find((it) => it.uuid === uuid)
  const handle = (uuid: string) => vm(uuid)?.id ?? ''

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

  it('deletes the chosen subtasks and leaves the others as top-level tasks', async () => {
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
    let accept = (_: null) => {}
    answer = new Promise((resolve) => {
      accept = resolve
    })
    const deleted = P.deleteIssue(handle('root'), [handle('a')], true)
    expect(vm('root')).toBeDefined() // nothing changes before the server answers
    accept(null)
    expect(await deleted).toBe(true)
    expect(vm('root')).toBeUndefined()
    expect(vm('a')).toBeUndefined()
    expect(vm('aa')?.parent).toBeNull()
    answer = Promise.reject(new Error('the subtasks changed'))
    answer.catch(() => {})
    expect(await P.deleteIssue(handle('b'), [], true)).toBe(false)
    expect(vm('b')).toBeDefined()
    expect(window.showToast).toHaveBeenCalled()
  })
})

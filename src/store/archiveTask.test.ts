import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

type Planner = typeof import('./planner')['P']
type Task = Snapshot['issues'][number]

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

/* What the Archive or delete window asks of the store. The signed-in member
 * edits Work under Plan. The root task in Work has subtasks a (with aa under
 * it) and b; c is a task of its own. The server's answer to each write is
 * set per test, and no new delivery arrives, so the snapshot the store holds
 * stays the one from before the write, as when a write is accepted but its
 * delivery has not landed yet. */
describe('archiving and deleting from the Archive or delete window', () => {
  let P: Planner
  let requests: { name: string; args: Record<string, unknown> }[]
  // the server's answer per mutation name; a write without one never settles
  let answers: Record<string, () => Promise<null>>
  let deliverSnap: (edit: (snap: Snapshot) => void) => Promise<void>

  async function load() {
    vi.resetModules()
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
    const snap: Snapshot = plannerFixture()
    const org = snap.orgs[0].id
    const me = snap.profiles[0]
    me.org_role = 'user'
    const base = snap.projects[0]
    snap.projects = [
      { ...base, id: 'plan', type: 'meta', key: 'PLAN', name: 'Plan', lead_id: me.id },
      {
        ...base,
        id: 'work',
        type: 'project',
        key: 'WORK',
        num: 2,
        name: 'Work',
        parent_id: 'plan',
      },
    ]
    const task = (id: string, num: number, parent_id?: string): Task => ({
      id,
      org_id: org,
      project_id: 'work',
      parent_id,
      num,
      title: id,
      description: '',
      status: 'todo',
      priority: 'low',
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    snap.issues.push(
      task('root', 1),
      task('a', 2, 'root'),
      task('b', 3, 'root'),
      task('aa', 4, 'a'),
      task('c', 5),
    )
    network.onUpdate.mockImplementation((ref, _args, next) => {
      if (getFunctionName(ref) === 'snapshot:forMe') {
        next(structuredClone(snap))
        // a later delivery of the server's snapshot, as `edit` leaves it
        deliverSnap = async (edit) => {
          const later = structuredClone(snap)
          edit(later)
          next(later)
          await Promise.resolve()
        }
      }
      return () => {}
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
  }

  beforeEach(load)

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const vm = (uuid: string) => P.issues.find((it) => it.uuid === uuid)
  const handle = (uuid: string) => vm(uuid)?.id ?? ''
  const accept = (name: string) => {
    answers[name] = () => Promise.resolve(null)
  }
  const refuse = (name: string, message: string) => {
    answers[name] = () => Promise.reject(new Error(message))
  }
  /* Another write is refused, so the store rolls back to the snapshot it
     holds, from before the archive. */
  const rollBack = async () => {
    refuse('issues:update', 'refused')
    P.updateIssue(handle('c'), { title: 'renamed' })
    await vi.waitFor(() => expect(window.showToast).toHaveBeenCalled())
  }

  /* Another write is in flight, so deliveries are held. `remove` is accepted
     while the held snapshot still holds the work; a held delivery then drops
     it, as `drop` says, and another brings it back, as a restore does, before
     the write settles and the last delivery is painted. */
  async function restoredWhileHeld(remove: () => Promise<boolean>, drop: (snap: Snapshot) => void) {
    let saved: (value: null) => void = () => {}
    answers['labels:create'] = () => new Promise((resolve) => (saved = resolve))
    P.addLabel({ name: 'Bench' })
    expect(await remove()).toBe(true)
    await deliverSnap(drop)
    await deliverSnap((snap) => {
      snap.orgs[0].name = 'Restored Labs'
    })
    saved(null)
    await vi.waitFor(() => expect(P.org.name).toBe('Restored Labs'))
  }

  it('shows an archived subtree restored while deliveries were held', async () => {
    accept('issues:archive')
    const subtree = new Set(['root', 'a', 'b', 'aa'])
    await restoredWhileHeld(
      () => P.archiveIssue(handle('root'), ''),
      (snap) => {
        snap.issues = snap.issues.filter((issue) => !subtree.has(issue.id))
      },
    )
    expect(['root', 'a', 'b', 'aa'].map((id) => vm(id)?.uuid)).toEqual(['root', 'a', 'b', 'aa'])
  })

  it('shows a deleted task and its subtask restored while deliveries were held', async () => {
    accept('issues:deleteDeep')
    await restoredWhileHeld(
      () => P.deleteIssue(handle('a'), [handle('aa')], true),
      (snap) => {
        snap.issues = snap.issues.filter((issue) => issue.id !== 'a' && issue.id !== 'aa')
      },
    )
    expect(vm('a')).toBeDefined()
    expect(vm('aa')?.parent).toBe(handle('a'))
  })

  it('shows a deleted project restored while deliveries were held', async () => {
    accept('projects:deleteDeep')
    await restoredWhileHeld(
      () => P.removeProject('plan'),
      (snap) => {
        snap.projects = []
        snap.issues = []
      },
    )
    expect(P.project('plan')).toBeDefined()
    expect(P.project('work')).toBeDefined()
    expect(vm('root')).toBeDefined()
  })

  it('archives the task alone when its subtasks are kept, and keeps them through a rollback', async () => {
    accept('issues:archive')
    const archived = P.archiveIssue(handle('root'), '  Moved to the next release  ', true)
    expect(vm('root')).toBeDefined() // nothing changes before the server answers
    expect(await archived).toBe(true)
    expect(requests).toEqual([
      {
        name: 'issues:archive',
        args: expect.objectContaining({
          id: 'root',
          reason: 'Moved to the next release',
          keep_subtasks: true,
        }),
      },
    ])
    expect(vm('root')).toBeUndefined()
    // the direct subtasks become top-level tasks; theirs stay under them
    expect(vm('a')?.parent).toBeNull()
    expect(vm('b')?.parent).toBeNull()
    expect(vm('aa')?.parent).toBe(handle('a'))

    await rollBack()
    expect(vm('root')).toBeUndefined()
    expect(vm('a')?.parent).toBeNull()
    expect(vm('b')).toBeDefined()
    expect(vm('aa')?.parent).toBe(handle('a'))
    expect(vm('c')?.title).toBe('c')
  })

  it('keeps an accepted archive gone when another write paints a delivery held from before it', async () => {
    let saved: (value: null) => void = () => {}
    answers['issues:update'] = () => new Promise((resolve) => (saved = resolve))
    P.updateIssue(handle('c'), { title: 'renamed' })
    // while that write is in flight, a delivery that still holds the task is held
    await deliverSnap((snap) => {
      const c = snap.issues.find((issue) => issue.id === 'c')
      if (c) c.title = 'renamed on the server'
    })
    accept('issues:archive')
    expect(await P.archiveIssue(handle('root'), '')).toBe(true)
    expect(vm('root')).toBeUndefined()
    // the write settles, and the held delivery is painted
    saved(null)
    await vi.waitFor(() => expect(vm('c')?.title).toBe('renamed on the server'))
    expect(['root', 'a', 'b', 'aa'].map(vm)).toEqual([undefined, undefined, undefined, undefined])
  })

  it('keeps no marker for an archive a held delivery already holds, so a restore shows', async () => {
    let saved: (value: null) => void = () => {}
    answers['issues:update'] = () => new Promise((resolve) => (saved = resolve))
    P.updateIssue(handle('c'), { title: 'renamed' })
    const subtree = new Set(['root', 'a', 'b', 'aa'])
    // while that write is in flight, the delivery without the subtree is held
    await deliverSnap((snap) => {
      snap.issues = snap.issues.filter((issue) => !subtree.has(issue.id))
    })
    accept('issues:archive')
    expect(await P.archiveIssue(handle('root'), '')).toBe(true)
    expect(vm('root')).toBeUndefined()
    // the subtree is restored before the write settles, and that delivery is held too
    await deliverSnap((snap) => {
      const c = snap.issues.find((issue) => issue.id === 'c')
      if (c) c.title = 'renamed on the server'
    })
    saved(null)
    await vi.waitFor(() => expect(vm('c')?.title).toBe('renamed on the server'))
    expect(['root', 'a', 'b', 'aa'].map((id) => vm(id)?.uuid)).toEqual(['root', 'a', 'b', 'aa'])
  })

  it('archives the whole subtree otherwise, and keeps it gone through a rollback', async () => {
    accept('issues:archive')
    expect(await P.archiveIssue(handle('root'), '')).toBe(true)
    expect(requests[0].args).not.toHaveProperty('keep_subtasks')
    expect(requests[0].args).not.toHaveProperty('reason')
    expect(['root', 'a', 'b', 'aa'].map(vm)).toEqual([undefined, undefined, undefined, undefined])
    await rollBack()
    expect(['root', 'a', 'b', 'aa'].map(vm)).toEqual([undefined, undefined, undefined, undefined])
    expect(vm('c')).toBeDefined()
  })

  it('changes nothing when the server refuses the archive, and a rollback brings nothing back', async () => {
    refuse('issues:archive', 'a subtask is in a project you cannot edit')
    expect(await P.archiveIssue(handle('root'), 'why', true)).toBe(false)
    expect(window.showToast).toHaveBeenCalled()
    expect(vm('root')).toBeDefined()
    expect(vm('a')?.parent).toBe(handle('root'))
    await rollBack()
    expect(vm('root')).toBeDefined()
    expect(vm('a')?.parent).toBe(handle('root'))
  })

  it('sends a delete reason trimmed, and none when it is blank', async () => {
    accept('issues:deleteDeep')
    expect(await P.deleteIssue(handle('c'), [], true, '  Duplicate  ')).toBe(true)
    expect(requests[0]).toEqual({
      name: 'issues:deleteDeep',
      args: expect.objectContaining({ id: 'c', reason: 'Duplicate' }),
    })
    expect(await P.deleteIssue(handle('b'), [], true, '   ')).toBe(true)
    expect(requests[1].args).not.toHaveProperty('reason')
  })

  it('waits for the server before a project leaves, and keeps it on a refusal', async () => {
    refuse('projects:deleteDeep', 'requires the project lead')
    expect(await P.removeProject('plan', 'Wrapped up')).toBe(false)
    expect(P.project('plan')).toBeDefined()
    expect(P.project('work')).toBeDefined()
    expect(vm('root')).toBeDefined()

    let settle: (value: null) => void = () => {}
    answers['projects:deleteDeep'] = () => new Promise((resolve) => (settle = resolve))
    const deleted = P.removeProject('plan', '  Wrapped up  ')
    expect(requests.at(-1)).toEqual({
      name: 'projects:deleteDeep',
      args: expect.objectContaining({ id: 'plan', reason: 'Wrapped up' }),
    })
    expect(P.project('plan')).toBeDefined() // still there while the server works
    settle(null)
    expect(await deleted).toBe(true)
    expect(P.project('plan')).toBeUndefined()
    expect(P.project('work')).toBeUndefined()
    expect(vm('root')).toBeUndefined()
  })

  it('keeps an accepted task delete through a rollback, with the subtasks it left behind detached', async () => {
    accept('issues:deleteDeep')
    expect(await P.deleteIssue(handle('a'), [], true)).toBe(true)
    expect(vm('a')).toBeUndefined()
    expect(vm('aa')?.parent).toBeNull()
    await rollBack()
    expect(vm('a')).toBeUndefined()
    expect(vm('aa')?.parent).toBeNull()
    expect(vm('root')).toBeDefined()
    expect(vm('c')?.title).toBe('c')
  })

  it('keeps no marker for a delete whose delivery came first, so a restored task stays through a rollback', async () => {
    let settle: (value: null) => void = () => {}
    answers['issues:deleteDeep'] = () => new Promise((resolve) => (settle = resolve))
    const deleted = P.deleteIssue(handle('c'), [], true)
    // the delivery without the task lands before the answer
    await deliverSnap((snap) => {
      snap.issues = snap.issues.filter((issue) => issue.id !== 'c')
    })
    settle(null)
    expect(await deleted).toBe(true)
    expect(vm('c')).toBeUndefined()
    // the task comes back from Deleted items
    await deliverSnap(() => {})
    expect(vm('c')).toBeDefined()
    refuse('issues:update', 'refused')
    P.updateIssue(handle('b'), { title: 'renamed' })
    await vi.waitFor(() => expect(window.showToast).toHaveBeenCalled())
    expect(vm('c')).toBeDefined()
  })

  it('keeps an accepted project delete through a rollback', async () => {
    accept('projects:deleteDeep')
    expect(await P.removeProject('plan')).toBe(true)
    // a refused write outside the deleted project rolls the store back
    refuse('labels:create', 'refused')
    P.addLabel({ name: 'Firmware' })
    await vi.waitFor(() => expect(window.showToast).toHaveBeenCalled())
    expect(P.project('plan')).toBeUndefined()
    expect(P.project('work')).toBeUndefined()
    expect(['root', 'a', 'b', 'aa', 'c'].map(vm)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })
})

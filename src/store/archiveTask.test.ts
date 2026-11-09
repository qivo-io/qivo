import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

type Planner = typeof import('./planner')['P']
type Task = Snapshot['issues'][number]

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
  let answers: Record<string, () => Promise<unknown>>
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
    // Work under the top-level Plan, as every writer stores a project that
    // holds tasks, so the navigation reads name both
    const snap: Snapshot = plannerFixture()
    const org = snap.orgs[0].id
    const me = snap.profiles[0]
    me.org_role = 'user'
    const base = snap.projects[0]
    snap.projects = [
      {
        ...base,
        id: 'plan',
        type: 'meta',
        parent_id: undefined,
        key: 'PLAN',
        name: 'Plan',
        lead_id: me.id,
      },
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
      if (getFunctionName(ref) === 'workspace:whole') {
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
    // the views name the projects they show; this suite names them all
    await (await import('./oracleScope.setup')).nameProjects(store.P, snap)
  }

  beforeEach(load)

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const accept = (name: string) => {
    answers[name] = () => Promise.resolve(null)
  }
  const refuse = (name: string, message: string) => {
    answers[name] = () => Promise.reject(new Error(message))
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

  it('shows a deleted project restored while deliveries were held', async () => {
    accept('projects:deleteDeep')
    const org = P.project('plan')?.org ?? ''
    await restoredWhileHeld(
      () => P.removeProject('plan', undefined, { orgId: org }),
      (snap) => {
        snap.projects = []
        snap.issues = []
      },
    )
    expect(P.project('plan')).toBeDefined()
    expect(P.project('work')).toBeDefined()
  })

  it('waits for the server before a project leaves, and keeps it on a refusal', async () => {
    const shown = { orgId: P.project('plan')?.org ?? '' }
    // the page that showed the project names its organization; without it
    // nothing is sent
    expect(await P.removeProject('plan', 'Wrapped up')).toBe(false)
    expect(requests).toEqual([])
    refuse('projects:deleteDeep', 'requires the project lead')
    expect(await P.removeProject('plan', 'Wrapped up', shown)).toBe(false)
    // nothing painted, so the toast says nothing was reverted
    expect(vi.mocked(window.showToast).mock.calls.at(-1)?.[0]).toBe("Couldn't save.")
    expect(P.project('plan')).toBeDefined()
    expect(P.project('work')).toBeDefined()

    let settle: (value: null) => void = () => {}
    answers['projects:deleteDeep'] = () => new Promise((resolve) => (settle = resolve))
    const deleted = P.removeProject('plan', '  Wrapped up  ', shown)
    expect(requests.at(-1)).toEqual({
      name: 'projects:deleteDeep',
      args: expect.objectContaining({ id: 'plan', org_id: shown.orgId, reason: 'Wrapped up' }),
    })
    expect(P.project('plan')).toBeDefined() // still there while the server works
    settle(null)
    expect(await deleted).toBe(true)
    // the write paints nothing: the project and its tasks leave with the
    // delivery that no longer holds them, which the project cache's read of
    // them answers gone
    expect(P.project('plan')).toBeDefined()
    await deliverSnap((snap) => {
      snap.projects = snap.projects.filter((p) => p.id !== 'plan' && p.id !== 'work')
      snap.issues = snap.issues.filter((issue) => issue.project_id !== 'work')
    })
    await vi.waitFor(() => expect(P.projectState('plan')).toBe('gone'))
    expect(P.project('plan')).toBeUndefined()
    expect(P.project('work')).toBeUndefined()
  })

  it('keeps an accepted project delete through a rollback', async () => {
    // the delivery without the project comes before the write's answer, as
    // Convex hands it over
    answers['projects:deleteDeep'] = async () => {
      await deliverSnap((snap) => {
        snap.projects = snap.projects.filter((p) => p.id !== 'plan' && p.id !== 'work')
        snap.issues = snap.issues.filter((issue) => issue.project_id !== 'work')
      })
      return null
    }
    expect(await P.removeProject('plan', undefined, { orgId: P.project('plan')?.org ?? '' })).toBe(
      true,
    )
    await vi.waitFor(() => expect(P.projectState('plan')).toBe('gone'))
    // a refused write outside the deleted project rolls the store back
    refuse('labels:create', 'refused')
    P.addLabel({ name: 'Firmware' })
    await vi.waitFor(() => expect(window.showToast).toHaveBeenCalled())
    expect(P.project('plan')).toBeUndefined()
    expect(P.project('work')).toBeUndefined()
  })
})

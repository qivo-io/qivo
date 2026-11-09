import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot, underProgram } from './plannerFixture.setup'

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/demoMode', () => ({ DEMO_MODE: true }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

/* The snapshot omits the id of a parent outside the working set and flags
 * the task instead (has_hidden_parent). The store keeps the task top-level
 * everywhere and tells the task window that a parent exists. */
describe('a parent outside the working set', () => {
  let store: typeof import('./planner')
  let snapshot: Snapshot
  let reject: (reason: unknown) => void
  let resolve: (value: null) => void
  // a later delivery of the server's whole, as `edit` leaves it
  let deliver: (edit: (whole: Snapshot) => void) => Promise<void>

  const task = (id: string, num: number, project_id: string, extra = {}) => ({
    id,
    org_id: snapshot.orgs[0].id,
    project_id,
    num,
    title: id,
    description: '',
    status: 'todo' as const,
    priority: 'medium' as const,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    paused: false,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
    ...extra,
  })

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), { setTimeout, clearTimeout, showToast: vi.fn() }),
    )
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // the project under a top-level project, as every writer stores one
    // that holds tasks, so the navigation reads name it
    snapshot = underProgram(plannerFixture())
    const here = snapshot.projects[0].id
    const there = crypto.randomUUID()
    snapshot.projects.push({
      ...snapshot.projects[0],
      id: there,
      key: 'THERE',
      num: 2,
      name: 'There',
    })
    snapshot.issues.push(
      task('orphan', 1, here, { has_hidden_parent: true }),
      task('candidate', 2, here),
      task('far-parent', 3, there),
      task('near-child', 4, here, { parent_id: 'far-parent' }),
      task('near-parent', 5, here),
      task('far-child', 6, there, { parent_id: 'near-parent' }),
    )
    network.query.mockResolvedValue(null)
    network.mutation.mockImplementation(
      () =>
        new Promise((yes, no) => {
          resolve = yes
          reject = no
        }),
    )
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      if (getFunctionName(ref) === 'workspace:whole') {
        receive(structuredClone(snapshot))
        deliver = async (edit) => {
          const later = structuredClone(snapshot)
          edit(later)
          receive(later)
          for (let i = 0; i < 8; i++) await Promise.resolve()
        }
      }
      return vi.fn()
    })
    store = await import('./planner')
    await store.initStore()
    // the views name the projects they show; this suite names them all
    await (await import('./oracleScope.setup')).nameProjects(store.P, snapshot)
    await Promise.resolve()
  })
  afterEach(() => {
    store?.disposeDemoStore()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const vm = (uuid: string) => store.P.issues.find((i) => i.uuid === uuid)
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }

  it('stays top-level and says it has a parent', () => {
    expect(vm('orphan')).toMatchObject({ parent: null, hasHiddenParent: true })
    expect(vm('candidate')).toMatchObject({ parent: null, hasHiddenParent: false })
  })

  it('a new parent or a detach replaces the hidden one; a refusal brings it back', async () => {
    const { P } = store
    P.updateIssue(vm('orphan')!.id, { parent: vm('candidate')!.id })
    expect(vm('orphan')).toMatchObject({ parent: vm('candidate')!.id, hasHiddenParent: false })
    const [, args] = network.mutation.mock.calls.at(-1) as [unknown, { patch: unknown }]
    expect(args.patch).toEqual({ parent_id: 'candidate' })
    reject(new Error('refused'))
    await settle()
    expect(vm('orphan')).toMatchObject({ parent: null, hasHiddenParent: true })

    P.updateIssue(vm('orphan')!.id, { parent: null })
    expect(vm('orphan')).toMatchObject({ parent: null, hasHiddenParent: false })
  })

  // the sub-project There, which holds far-parent and far-child
  const thereId = () => snapshot.projects.find((p) => p.key === 'THERE')?.id ?? ''

  /* The server's whole once project `id` is archived: the project marked
     archived, its tasks out of the working set, and a task whose parent
     left with them sent with a hidden parent (convex/lib/workingSet.ts
     parentLink). */
  const archived = (id: string) => (whole: Snapshot) => {
    const project = whole.projects.find((p) => p.id === id)
    if (project) project.archived_at = '2026-10-02T00:00:00.000Z'
    const gone = new Set(whole.issues.filter((t) => t.project_id === id).map((t) => t.id))
    whole.issues = whole.issues
      .filter((t) => !gone.has(t.id))
      .map((t) =>
        t.parent_id && gone.has(t.parent_id)
          ? { ...t, parent_id: undefined, has_hidden_parent: true }
          : t,
      )
  }

  it("archiving a subtask's project leaves its parent in another project without it", async () => {
    const { P } = store
    const there = thereId()
    expect(vm('near-parent')).toMatchObject({ isGroup: true, hasHiddenSubtasks: false })
    P.archiveProject(there, { orgId: snapshot.orgs[0].id })
    expect(network.mutation.mock.calls.at(-1)?.[1]).toEqual({
      org_id: snapshot.orgs[0].id,
      id: there,
    })
    // the write paints nothing; the delivery without the archived tasks
    // takes them away
    expect(vm('near-parent')).toMatchObject({ isGroup: true })
    await deliver(archived(there))
    // deliveries wait while the write is on its way
    resolve(null)
    await settle()
    // a subtask in an archived project makes no task in an active one a group
    await vi.waitFor(() =>
      expect(vm('near-parent')).toMatchObject({ isGroup: false, hasHiddenSubtasks: false }),
    )
  })

  it("archiving the parent's project leaves its child with a parent outside this view", async () => {
    const { P } = store
    const there = thereId()
    expect(vm('near-child')?.parent).toBe(vm('far-parent')?.id)
    P.archiveProject(there, { orgId: snapshot.orgs[0].id })
    expect(vm('far-parent')).toBeDefined()
    await deliver(archived(there))
    // deliveries wait while the write is on its way
    resolve(null)
    await settle()
    await vi.waitFor(() => expect(vm('far-parent')).toBeUndefined())
    expect(vm('near-child')).toMatchObject({ parent: null, hasHiddenParent: true })
  })

  it('sends no archive without the organization of the page that showed the project', () => {
    const { P } = store
    const calls = network.mutation.mock.calls.length
    P.archiveProject(thereId())
    expect(network.mutation.mock.calls.length).toBe(calls)
  })
})

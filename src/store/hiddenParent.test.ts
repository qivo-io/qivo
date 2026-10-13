import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
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
    snapshot = plannerFixture()
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
    )
    network.query.mockResolvedValue(null)
    network.mutation.mockImplementation(
      () =>
        new Promise((_yes, no) => {
          reject = no
        }),
    )
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      if (getFunctionName(ref) === 'snapshot:forMe') receive(structuredClone(snapshot))
      return vi.fn()
    })
    store = await import('./planner')
    await store.initStore()
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

  it("archiving the parent's project leaves its child with a parent outside this view", () => {
    const { P } = store
    expect(vm('near-child')?.parent).toBe(vm('far-parent')?.id)
    P.archiveProject(snapshot.projects[1].id)
    expect(vm('far-parent')).toBeUndefined()
    expect(vm('near-child')).toMatchObject({ parent: null, hasHiddenParent: true })
  })
})

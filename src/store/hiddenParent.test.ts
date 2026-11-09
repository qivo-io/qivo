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
    network.mutation.mockImplementation(() => new Promise(() => {}))
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      if (getFunctionName(ref) === 'workspace:whole') receive(structuredClone(snapshot))
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

  // the sub-project There, which holds far-parent and far-child
  const thereId = () => snapshot.projects.find((p) => p.key === 'THERE')?.id ?? ''

  it('sends no archive without the organization of the page that showed the project', () => {
    const { P } = store
    const calls = network.mutation.mock.calls.length
    P.archiveProject(thereId())
    expect(network.mutation.mock.calls.length).toBe(calls)
  })
})

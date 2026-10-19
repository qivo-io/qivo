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

/* A large organization's snapshot sends each long list in parts: the first
 * under its own name and the rest in `more` (convex/lib/arrayLimit.ts). The
 * store shows every part. */
describe('a snapshot whose lists arrive in parts', () => {
  let store: typeof import('./planner')

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), { setTimeout, clearTimeout, showToast: vi.fn() }),
    )
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
    network.query.mockResolvedValue(null)
  })
  afterEach(() => {
    store?.disposeDemoStore()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('shows the tasks and labels of every part, in order', async () => {
    const snapshot = plannerFixture()
    const project = snapshot.projects[0].id
    const task = (n: number): Snapshot['issues'][number] => ({
      id: `task-${n}`,
      org_id: snapshot.orgs[0].id,
      project_id: project,
      num: n,
      title: `Task ${n}`,
      description: '',
      status: 'todo',
      priority: 'medium',
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z',
      paused: false,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    const label = 'label-1'
    const parts: Snapshot = {
      ...snapshot,
      labels: [
        {
          id: label,
          org_id: snapshot.orgs[0].id,
          name: 'Firmware',
          name_lower: 'firmware',
          color: '#4f46e5',
          created_at: '2026-10-01T00:00:00.000Z',
        },
      ],
      issues: [task(1), task(2)],
      issueLabels: [{ issue_id: 'task-1', label_id: label }],
      more: {
        issues: [[task(3), task(4)], [task(5)]],
        issueLabels: [[{ issue_id: 'task-5', label_id: label }]],
      },
    }
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      if (getFunctionName(ref) === 'snapshot:forMe') receive(structuredClone(parts))
      return vi.fn()
    })
    store = await import('./planner')
    await store.initStore()
    await Promise.resolve()
    expect(store.P.issues.map((i) => i.uuid)).toEqual([1, 2, 3, 4, 5].map((n) => `task-${n}`))
    const labelled = store.P.issues.filter((i) => i.labels.length > 0).map((i) => i.uuid)
    expect(labelled).toEqual(['task-1', 'task-5'])
  })
})

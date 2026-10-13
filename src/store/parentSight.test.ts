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

/* Whoever holds a subtask must see every task above it. "both" can edit the
 * Plans and Work projects; "workOnly" can edit Work alone, so the epic in
 * Plans is out of their sight. */
describe('assignees must see the tasks above a subtask', () => {
  let P: Planner
  let requests: { name: string; args: Record<string, unknown> }[]

  async function load(change?: (snap: Snapshot) => void) {
    const snap: Snapshot = plannerFixture()
    const org = snap.orgs[0].id
    const work = snap.projects[0]
    const plans = { ...work, id: crypto.randomUUID(), key: 'PLAN', num: 2, name: 'Plans' }
    snap.projects.push(plans)
    const person = (id: string, name: string) =>
      snap.profiles.push({
        id,
        org_id: org,
        name,
        initials: 'PE',
        color: '#335577',
        org_role: 'user',
        active: true,
        kind: 'person',
        created_at: NOW,
      })
    person('both', 'Both')
    person('workOnly', 'Work only')
    snap.access.push(
      { project_id: work.id, profile_id: 'both', level: 'user' },
      { project_id: plans.id, profile_id: 'both', level: 'user' },
      { project_id: work.id, profile_id: 'workOnly', level: 'user' },
    )
    const task = (id: string, num: number, project_id: string, extra = {}) => ({
      id,
      org_id: org,
      project_id,
      num,
      title: id,
      description: '',
      status: 'todo' as const,
      priority: 'low' as const,
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
      ...extra,
    })
    snap.issues.push(
      task('epic', 1, plans.id),
      task('sub', 2, work.id, { parent_id: 'epic' }),
      task('free', 3, work.id, { assignee_id: 'workOnly' }),
    )
    change?.(snap)
    network.onUpdate.mockImplementation((ref, _args, next) => {
      if (getFunctionName(ref) === 'snapshot:forMe') next(structuredClone(snap))
      return () => {}
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
    return { work }
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    requests = []
    network.query.mockResolvedValue(null)
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      requests.push({ name, args })
      return new Promise(() => {})
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const vm = (uuid: string) => P.issues.find((it) => it.uuid === uuid)!
  const ids = (users: { id: string }[]) => users.map((u) => u.id).sort()

  it('offers only people who can see every task above', async () => {
    const { work } = await load()
    expect(ids(P.issueAssigneesFor(work.id))).toContain('workOnly')
    expect(ids(P.taskAssigneesFor(vm('sub')))).not.toContain('workOnly')
    expect(ids(P.taskAssigneesFor(vm('sub')))).toContain('both')
    // a task without a parent keeps the project's list
    expect(ids(P.taskAssigneesFor(vm('free')))).toEqual(ids(P.issueAssigneesFor(work.id)))
  })

  it('refuses a blind assignee or reviewer before anything is sent', async () => {
    await load()
    P.updateIssue(vm('sub').id, { assignee: 'workOnly' })
    P.updateIssue(vm('sub').id, { reviewer: 'workOnly' })
    expect(requests).toEqual([])
    expect(vm('sub').assignee).toBeFalsy()
    expect(window.showToast).toHaveBeenCalledTimes(2)
    P.updateIssue(vm('sub').id, { assignee: 'both' })
    expect(requests.map((r) => r.name)).toEqual(['issues:update'])
  })

  it('refuses a parent that someone holding the task cannot see', async () => {
    await load()
    P.updateIssue(vm('free').id, { parent: vm('epic').id })
    expect(requests).toEqual([])
    expect(vm('free').parent).toBeNull()
    expect(window.showToast).toHaveBeenCalledTimes(1)
    P.updateIssue(vm('free').id, { assignee: 'both' })
    P.updateIssue(vm('free').id, { parent: vm('epic').id })
    expect(requests.map((r) => r.name)).toEqual(['issues:update', 'issues:update'])
    expect(vm('free').parent).toBe(vm('epic').id)
  })

  it('ignores a switched-off holder, as the server does', async () => {
    await load((snap) => {
      for (const p of snap.profiles) if (p.id === 'workOnly') p.active = false
    })
    expect(P.holdersSeeParent(vm('free'), vm('epic').id)).toBe(true)
    P.updateIssue(vm('free').id, { parent: vm('epic').id })
    expect(requests.map((r) => r.name)).toEqual(['issues:update'])
  })
})

import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
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

/* Whoever holds a subtask must see every task above it. "both" can edit the
 * Plans and Work sub-projects of one top-level project, where a subtask and
 * its parent may live; "workOnly" can edit Work alone, so the epic in Plans
 * is out of their sight. */
describe('assignees must see the tasks above a subtask', () => {
  let P: Planner
  let requests: { name: string; args: Record<string, unknown> }[]
  // the sentence the server refuses the next write with, or none
  let refusal: string | null

  async function load(change?: (snap: Snapshot) => void) {
    const snap: Snapshot = plannerFixture()
    const org = snap.orgs[0].id
    const top = { ...snap.projects[0], type: 'meta' as const, key: 'TOP', num: 3, name: 'Top' }
    const work = { ...snap.projects[0], id: crypto.randomUUID(), parent_id: top.id }
    const plans = { ...work, id: crypto.randomUUID(), key: 'PLAN', num: 2, name: 'Plans' }
    snap.projects = [top, work, plans]
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
      if (getFunctionName(ref) === 'workspace:whole') next(structuredClone(snap))
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
    refusal = null
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      requests.push({ name, args })
      return refusal === null
        ? new Promise(() => {})
        : Promise.reject(new ConvexError({ code: 'rule', message: refusal }))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('holds nobody but the signed-in person, so it judges no one else', async () => {
    await load()
    expect(P.users.map((u) => u.id)).toEqual(P.myProfileIds)
    expect(P.user('both')).toBeUndefined()
  })
})

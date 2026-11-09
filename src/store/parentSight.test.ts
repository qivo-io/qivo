import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ASSIGNEE_RULE,
  ASSIGNEE_SIGHT_RULE,
  HOLDER_SIGHT_RULE,
  MOVE_HOLDER_RULE,
  REVIEWER_SIGHT_RULE,
} from '../../convex/model/issues'
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
// the fixture's Plans sub-project and its parent, for the move cases
let snapPlans = ''
let snapTop = ''

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
    snapPlans = plans.id
    snapTop = top.id
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

  const vm = (uuid: string) => P.issues.find((it) => it.uuid === uuid)!

  /* Lets the refusal's promise settle and its toast show. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
  const toasted = (rule: string) =>
    expect(window.showToast).toHaveBeenCalledWith(
      expect.stringContaining(rule.slice(1, 40)),
      'error',
    )

  it('holds nobody but the signed-in person, so it judges no one else', async () => {
    await load()
    expect(P.users.map((u) => u.id)).toEqual(P.myProfileIds)
    expect(P.user('both')).toBeUndefined()
  })

  it("sends a blind assignee or reviewer and takes the paint back on the server's refusal", async () => {
    await load()
    refusal = ASSIGNEE_SIGHT_RULE
    void P.updateIssue(vm('sub').id, { assignee: 'workOnly' })
    expect(requests.map((r) => r.name)).toEqual(['issues:update'])
    await settle()
    toasted(ASSIGNEE_SIGHT_RULE)
    expect(vm('sub').assignee).toBeFalsy()
    refusal = REVIEWER_SIGHT_RULE
    void P.updateIssue(vm('sub').id, { reviewer: 'workOnly' })
    await settle()
    toasted(REVIEWER_SIGHT_RULE)
    expect(vm('sub').reviewer).toBeFalsy()
    // a holder the server takes paints and stays
    refusal = null
    void P.updateIssue(vm('sub').id, { assignee: 'both' })
    expect(vm('sub').assignee).toBe('both')
    expect(requests.map((r) => r.name)).toEqual(['issues:update', 'issues:update', 'issues:update'])
  })

  it("sends a parent someone holding the task cannot see and takes it back on the server's refusal", async () => {
    await load()
    refusal = HOLDER_SIGHT_RULE
    void P.updateIssue(vm('free').id, { parent: vm('epic').id })
    expect(requests.map((r) => r.name)).toEqual(['issues:update'])
    await settle()
    toasted(HOLDER_SIGHT_RULE)
    expect(vm('free').parent).toBeNull()
  })

  it('sends a move with another person on a subtask, says it moved only once the server took it, and takes a refused one back', async () => {
    await load((snap) => {
      // free's subtask belongs to workOnly, who cannot see Plans
      const free = snap.issues.find((i) => i.id === 'free')!
      free.assignee_id = undefined
      snap.issues.push({
        ...free,
        id: 'kid',
        num: 9,
        title: 'kid',
        parent_id: 'free',
        assignee_id: 'workOnly',
      })
    })
    // the target as the Move window seeds it from its targets row
    const plans = { id: snapPlans, name: 'Plans' }
    P.seedProjects([
      { id: snapPlans, org_id: P.homeOrg, name: 'Plans', num: 2, parent_id: snapTop },
    ])
    const work = vm('free').project
    refusal = MOVE_HOLDER_RULE
    const saved: boolean[] = []
    expect(P.moveIssue(vm('free').id, plans.id, (ok) => saved.push(ok))).toBe(vm('free').id)
    expect(requests.map((r) => r.name)).toEqual(['issues:move'])
    await settle()
    toasted(MOVE_HOLDER_RULE)
    expect(saved).toEqual([false])
    expect(vm('free').project).toBe(work)
    // the moved task's own assignee needs Edit where it lands, which the
    // server checks with the people fields' sentence
    refusal = ASSIGNEE_RULE
    P.moveIssue(vm('kid').id, plans.id, (ok) => saved.push(ok))
    await settle()
    toasted(ASSIGNEE_RULE)
    expect(saved).toEqual([false, false])
  })
})

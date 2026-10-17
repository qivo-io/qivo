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
 * Plans and Work sub-projects of one top-level project, where a subtask and
 * its parent may live; "workOnly" can edit Work alone, so the epic in Plans
 * is out of their sight. */
describe('assignees must see the tasks above a subtask', () => {
  let P: Planner
  let requests: { name: string; args: Record<string, unknown> }[]

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

  it('names who would lose access, for a move and for a new parent', async () => {
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
    const plans = P.projects.find((p) => p.name === 'Plans')!
    const moving = P.moveBlockers(vm('free'), plans.id)
    expect(moving.map((b) => [b.uid, b.task.uuid, b.role, b.edit])).toEqual([
      ['workOnly', 'kid', 'assignee', false],
    ])
    expect(P.blockerText(moving[0])).toBe(
      `Work only is assigned to ${vm('kid').key} but has no access to ${P.projectLabel(plans)}. Give them access or reassign ${vm('kid').key} first.`,
    )
    // the task's own assignee needs edit access at the destination
    P.updateIssue(vm('free').id, { assignee: 'workOnly' })
    expect(P.moveBlockers(vm('free'), plans.id).map((b) => [b.task.uuid, b.edit])).toEqual([
      ['free', true],
      ['kid', false],
    ])
    // a new parent in Plans is refused with the same named sentence
    P.updateIssue(vm('free').id, { parent: vm('epic').id })
    expect(window.showToast).toHaveBeenLastCalledWith(
      P.blockerText(P.parentBlockers(vm('free'), vm('epic').id)[0]),
      'error',
    )
  })

  it("names the moved task's switched-off assignee, whom the server still refuses", async () => {
    await load((snap) => {
      for (const p of snap.profiles) if (p.id === 'both') p.active = false
      const free = snap.issues.find((i) => i.id === 'free')!
      free.assignee_id = 'both'
    })
    const plans = P.projects.find((p) => p.name === 'Plans')!
    const blockers = P.moveBlockers(vm('free'), plans.id)
    expect(blockers.map((b) => [b.uid, b.task.uuid, b.edit])).toEqual([['both', 'free', true]])
    expect(P.blockerText(blockers[0])).toBe(
      `Both is switched off and is assigned to ${vm('free').key}. Reassign ${vm('free').key} first.`,
    )
  })
})

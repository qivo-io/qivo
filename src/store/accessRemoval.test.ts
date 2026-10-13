import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

type Planner = typeof import('./planner')['P']
type IssueRow = Snapshot['issues'][number]
type Task = (id: string, num: number, extra?: Partial<IssueRow>) => IssueRow

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

/* Removing a grant asks first when someone would lose sight of tasks they
 * work on. Leo and Dan hold direct User grants on the Work project; Ann
 * reaches it through the Crew team's grant. */
describe('removing someone who has work in the project', () => {
  let P: Planner
  let requests: { name: string; args: Record<string, unknown> }[]
  // tasks whose update the server refuses
  let refused: Set<string>
  let work: string

  async function load(change?: (snap: Snapshot, task: Task) => void) {
    const snap: Snapshot = plannerFixture()
    const org = snap.orgs[0].id
    work = snap.projects[0].id
    const person = (id: string) =>
      snap.profiles.push({
        id,
        org_id: org,
        name: `${id[0].toUpperCase()}${id.slice(1)} Person`,
        initials: 'PE',
        color: '#335577',
        org_role: 'user',
        active: true,
        kind: 'person',
        created_at: NOW,
      })
    for (const id of ['leo', 'dan', 'ann']) person(id)
    snap.teams.push({
      id: 'crew',
      org_id: org,
      name: 'Crew',
      stale_days: 14,
      archive_days: 30,
      track_delay_default: false,
      created_at: NOW,
    })
    snap.teamMembers.push({ team_id: 'crew', profile_id: 'ann', is_leader: false })
    snap.teamAccess.push({ project_id: work, team_id: 'crew', level: 'user' })
    snap.access.push(
      { project_id: work, profile_id: 'leo', level: 'user' },
      { project_id: work, profile_id: 'dan', level: 'user' },
    )
    const task: Task = (id, num, extra = {}) => ({
      id,
      org_id: org,
      project_id: work,
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
      task('t1', 1, { assignee_id: 'leo' }),
      task('t2', 2, { assignee_id: 'dan', reviewer_id: 'leo', status: 'review' as const }),
      task('t3', 3, { assignee_id: 'leo', status: 'done' as const }),
      task('t4', 4, { assignee_id: 'ann' }),
    )
    change?.(snap, task)
    network.onUpdate.mockImplementation((ref, _args, next) => {
      if (getFunctionName(ref) === 'snapshot:forMe') next(structuredClone(snap))
      return () => {}
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    requests = []
    refused = new Set()
    network.query.mockResolvedValue(null)
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      requests.push({ name, args })
      if (name === 'issues:update')
        return refused.has(args.id) ? Promise.reject(new Error('refused')) : Promise.resolve(null)
      return new Promise(() => {})
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const vm = (uuid: string) => P.issues.find((it) => it.uuid === uuid)!
  const held = (r: ReturnType<Planner['accessRemoval']>) =>
    r.items.map((i) => [i.task.uuid, i.uid, i.role])

  it('lists the open tasks a person would lose sight of, and no one else', async () => {
    await load()
    const leo = P.accessRemoval(work, { userId: 'leo' })
    expect(leo.people).toEqual(['leo'])
    // the Done task keeps its history and is not listed
    expect(held(leo)).toEqual([
      ['t1', 'leo', 'assignee'],
      ['t2', 'leo', 'reviewer'],
    ])
    expect(held(P.accessRemoval(work, { teamId: 'crew' }))).toEqual([['t4', 'ann', 'assignee']])
    expect(P.accessRemoval(work, { userId: 'dan' }).items.map((i) => i.task.uuid)).toEqual(['t2'])
  })

  it('lists nobody whom another grant still covers', async () => {
    await load((snap) => {
      snap.teamMembers.push({ team_id: 'crew', profile_id: 'leo', is_leader: false })
    })
    expect(P.accessRemoval(work, { userId: 'leo' }).items).toEqual([])
  })

  it('offers people who keep Edit access, never the people being removed', async () => {
    await load()
    const leo = P.accessRemoval(work, { userId: 'leo' })
    const ids = P.reassignChoices(work, { userId: 'leo' }, leo.items).map((u) => u.id)
    expect(ids).toContain('dan')
    expect(ids).toContain('ann')
    expect(ids).not.toContain('leo')
    const crew = P.accessRemoval(work, { teamId: 'crew' })
    expect(P.reassignChoices(work, { teamId: 'crew' }, crew.items).map((u) => u.id)).not.toContain(
      'ann',
    )
  })

  /* Plan is a parent project over Work and Specs, and Crew's only grant is
     on Plan. Dan, in Crew, also edits Work through his own grant; Leo edits
     Work alone. With `epic`, Ann's subtask in Work sits under a Specs task. */
  const inPlan = (epic: boolean) => (snap: Snapshot, task: Task) => {
    const base = snap.projects[0]
    snap.projects.push(
      { ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' },
      { ...base, id: 'specs', key: 'SPEC', num: 3, name: 'Specs', parent_id: 'plan' },
    )
    base.parent_id = 'plan'
    snap.teamAccess = [{ project_id: 'plan', team_id: 'crew', level: 'user' }]
    snap.teamMembers.push({ team_id: 'crew', profile_id: 'dan', is_leader: false })
    if (epic)
      snap.issues.push(
        task('epic', 5, { project_id: 'specs' }),
        task('sub', 6, { parent_id: 'epic', assignee_id: 'ann' }),
      )
  }

  it('offers people who edit only the affected sub-project', async () => {
    await load(inPlan(false))
    const crew = P.accessRemoval('plan', { teamId: 'crew' })
    expect(held(crew)).toEqual([['t4', 'ann', 'assignee']])
    const ids = P.reassignChoices('plan', { teamId: 'crew' }, crew.items).map((u) => u.id)
    expect(ids).toContain('leo') // no grant on Plan itself
    expect(ids).toContain('dan')
    expect(ids).not.toContain('ann')
  })

  it('offers nobody who would lose sight of a task above once the grant is gone', async () => {
    await load(inPlan(true))
    const crew = P.accessRemoval('plan', { teamId: 'crew' })
    expect(crew.people).toEqual(['ann'])
    expect(crew.items.map((i) => i.task.uuid)).toEqual(['t4', 'sub'])
    const ids = P.reassignChoices('plan', { teamId: 'crew' }, crew.items).map((u) => u.id)
    expect(P.seesTasksAbove(vm('sub'), 'dan')).toBe(true) // today, through Crew
    expect(ids).not.toContain('dan')
    expect(ids).not.toContain('leo') // never saw Specs
    expect(ids).toHaveLength(1) // the organization admin
  })

  it('keeps a person as a Viewer with their tasks', async () => {
    await load()
    const leo = P.accessRemoval(work, { userId: 'leo' })
    expect(await P.removeAccess(work, { userId: 'leo' }, { keep: true }, leo.items)).toBe(true)
    expect(P.levelOn(work, 'leo')).toBe('viewer')
    expect(vm('t1').assignee).toBe('leo')
    expect(requests.map((r) => r.name)).toEqual(['projects:update'])
  })

  it('reassigns the reviewed tasks, then removes the grant once all are saved', async () => {
    await load()
    const leo = P.accessRemoval(work, { userId: 'leo' })
    const removed = P.removeAccess(work, { userId: 'leo' }, { to: 'dan' }, leo.items.slice(0, 1))
    expect(vm('t1').assignee).toBe('dan')
    expect(vm('t2').reviewer).toBe('leo') // not in the reviewed list
    expect(P.levelOn(work, 'leo')).toBe('user') // waits for the server
    expect(await removed).toBe(true)
    expect(P.levelOn(work, 'leo')).toBeNull()
    expect(vm('t3').assignee).toBe('leo') // Done stays
    expect(requests.map((r) => r.name)).toEqual(['issues:update', 'projects:update'])
    // Unassigned clears them instead
    const crew = P.accessRemoval(work, { teamId: 'crew' })
    expect(await P.removeAccess(work, { teamId: 'crew' }, { to: null }, crew.items)).toBe(true)
    expect(vm('t4').assignee).toBeFalsy()
  })

  it('keeps the grant when the server refuses a reassignment', async () => {
    await load()
    refused.add('t2')
    const leo = P.accessRemoval(work, { userId: 'leo' })
    expect(await P.removeAccess(work, { userId: 'leo' }, { to: 'dan' }, leo.items)).toBe(false)
    expect(P.levelOn(work, 'leo')).toBe('user')
    expect(requests.map((r) => r.name)).toEqual(['issues:update', 'issues:update'])
    expect(window.showToast).toHaveBeenCalledWith(
      'Leo Person keeps access, because not every task could be reassigned.',
      'error',
    )
  })

  it('removes a team in one write, keeping the people who would lose sight as Viewers', async () => {
    await load()
    const crew = P.accessRemoval(work, { teamId: 'crew' })
    expect(await P.removeAccess(work, { teamId: 'crew' }, { keep: true }, crew.items)).toBe(true)
    expect(P.levelOn(work, 'ann')).toBe('viewer')
    expect(requests.map((r) => r.name)).toEqual(['projects:update'])
    expect(requests[0].args).toMatchObject({
      patch: { access: { ann: 'viewer', leo: 'user', dan: 'user' }, team_access: {} },
    })
  })
})

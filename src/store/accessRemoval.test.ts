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

/* Removing access asks first when someone would lose sight of tasks they
 * work on. Leo and Dan hold direct User grants on the Work project; Ann
 * reaches it through the Crew team's grant. The signed-in Planner is an
 * organization admin. */
describe('removing someone who has work in the project', () => {
  let P: Planner
  let requests: { name: string; args: Record<string, unknown> }[]
  // tasks and projects whose update the server refuses
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
      return refused.has(args.id) ? Promise.reject(new Error('refused')) : Promise.resolve(null)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const vm = (uuid: string) => P.issues.find((it) => it.uuid === uuid)!
  const held = (r: ReturnType<Planner['accessRemoval']>) =>
    r.items.map((i) => [i.task.uuid, i.uid, i.role])
  const user = (userId: string) => ({ kind: 'userGrant', projectId: work, userId }) as const
  const crewGrant = (projectId = work) =>
    ({ kind: 'teamGrant', projectId, teamId: 'crew' }) as const
  const leaving = (userId: string) => ({ kind: 'teamMember', teamId: 'crew', userId }) as const
  const deleteCrew = { kind: 'deleteTeam', teamId: 'crew' } as const

  it('lists the open tasks a person would lose sight of, and no one else', async () => {
    await load()
    const leo = P.accessRemoval(user('leo'))
    expect(leo.people).toEqual(['leo'])
    // the Done task keeps its history and is not listed
    expect(held(leo)).toEqual([
      ['t1', 'leo', 'assignee'],
      ['t2', 'leo', 'reviewer'],
    ])
    expect(held(P.accessRemoval(crewGrant()))).toEqual([['t4', 'ann', 'assignee']])
    expect(P.accessRemoval(user('dan')).items.map((i) => i.task.uuid)).toEqual(['t2'])
  })

  it('lists nobody whom another grant still covers', async () => {
    await load((snap) => {
      snap.teamMembers.push({ team_id: 'crew', profile_id: 'leo', is_leader: false })
    })
    expect(P.accessRemoval(user('leo')).items).toEqual([])
  })

  it('offers people who keep Edit access, never the people being removed', async () => {
    await load()
    const leo = P.accessRemoval(user('leo'))
    const ids = P.reassignChoices(user('leo'), leo.items).map((u) => u.id)
    expect(ids).toContain('dan')
    expect(ids).toContain('ann')
    expect(ids).not.toContain('leo')
    const crew = P.accessRemoval(crewGrant())
    expect(P.reassignChoices(crewGrant(), crew.items).map((u) => u.id)).not.toContain('ann')
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
    const crew = P.accessRemoval(crewGrant('plan'))
    expect(held(crew)).toEqual([['t4', 'ann', 'assignee']])
    const ids = P.reassignChoices(crewGrant('plan'), crew.items).map((u) => u.id)
    expect(ids).toContain('leo') // no grant on Plan itself
    expect(ids).toContain('dan')
    expect(ids).not.toContain('ann')
  })

  it('offers nobody who would lose sight of a task above once the grant is gone', async () => {
    await load(inPlan(true))
    const crew = P.accessRemoval(crewGrant('plan'))
    expect(crew.people).toEqual(['ann'])
    expect(crew.items.map((i) => i.task.uuid)).toEqual(['t4', 'sub'])
    const ids = P.reassignChoices(crewGrant('plan'), crew.items).map((u) => u.id)
    expect(P.seesTasksAbove(vm('sub'), 'dan')).toBe(true) // today, through Crew
    expect(ids).not.toContain('dan')
    expect(ids).not.toContain('leo') // never saw Specs
    expect(ids).toHaveLength(1) // the organization admin
  })

  it('keeps a person as a Viewer with their tasks', async () => {
    await load()
    const leo = P.accessRemoval(user('leo'))
    expect(await P.removeAccess(user('leo'), { keep: true }, leo.items)).toBe(true)
    expect(P.levelOn(work, 'leo')).toBe('viewer')
    expect(vm('t1').assignee).toBe('leo')
    expect(requests.map((r) => r.name)).toEqual(['projects:update'])
  })

  it('reassigns the reviewed tasks, then removes the grant once all are saved', async () => {
    await load()
    const leo = P.accessRemoval(user('leo'))
    const removed = P.removeAccess(user('leo'), { to: 'dan' }, leo.items.slice(0, 1))
    expect(vm('t1').assignee).toBe('dan')
    expect(vm('t2').reviewer).toBe('leo') // not in the reviewed list
    expect(P.levelOn(work, 'leo')).toBe('user') // waits for the server
    expect(await removed).toBe(true)
    expect(P.levelOn(work, 'leo')).toBeNull()
    expect(vm('t3').assignee).toBe('leo') // Done stays
    expect(requests.map((r) => r.name)).toEqual(['issues:update', 'projects:update'])
    // Unassigned clears them instead
    const crew = P.accessRemoval(crewGrant())
    expect(await P.removeAccess(crewGrant(), { to: null }, crew.items)).toBe(true)
    expect(vm('t4').assignee).toBeFalsy()
  })

  it('keeps the grant when the server refuses a reassignment', async () => {
    await load()
    refused.add('t2')
    const leo = P.accessRemoval(user('leo'))
    expect(await P.removeAccess(user('leo'), { to: 'dan' }, leo.items)).toBe(false)
    expect(P.levelOn(work, 'leo')).toBe('user')
    expect(requests.map((r) => r.name)).toEqual(['issues:update', 'issues:update'])
    expect(window.showToast).toHaveBeenCalledWith(
      'Leo Person keeps access, because not every task could be reassigned.',
      'error',
    )
  })

  it('keeps the grant and the window when the server refuses the Viewer grant', async () => {
    await load()
    refused.add(work)
    const leo = P.accessRemoval(user('leo'))
    expect(await P.removeAccess(user('leo'), { keep: true }, leo.items)).toBe(false)
    expect(P.levelOn(work, 'leo')).toBe('user')
    expect(P.accessRemoval(user('leo')).items).toHaveLength(2) // what the window lists again
  })

  it('removes a team in one write, keeping the people who would lose sight as Viewers', async () => {
    await load()
    const crew = P.accessRemoval(crewGrant())
    expect(await P.removeAccess(crewGrant(), { keep: true }, crew.items)).toBe(true)
    expect(P.levelOn(work, 'ann')).toBe('viewer')
    expect(requests.map((r) => r.name)).toEqual(['projects:update'])
    expect(requests[0].args).toMatchObject({
      patch: { access: { ann: 'viewer', leo: 'user', dan: 'user' }, team_access: {} },
    })
  })

  it('lists what a member leaving a team would lose, wherever the team reached', async () => {
    await load()
    const ann = P.accessRemoval(leaving('ann'))
    expect(held(ann)).toEqual([['t4', 'ann', 'assignee']])
    expect(ann.projects).toEqual([work]) // the team's grant is on the task's own project
    expect(P.accessRemoval(leaving('dan')).items).toEqual([]) // never in the team
    await load(inPlan(false))
    expect(P.accessRemoval(leaving('ann')).projects).toEqual(['plan']) // shared through the parent
    expect(P.accessRemoval(leaving('dan')).items).toEqual([]) // his own grant still covers him
  })

  it('offers people who keep the team when one member leaves, but not when it is deleted', async () => {
    await load(inPlan(true))
    const ann = P.accessRemoval(leaving('ann'))
    expect(ann.items.map((i) => i.task.uuid)).toEqual(['t4', 'sub'])
    // Dan sees Specs through Crew, which he keeps when only Ann leaves
    expect(P.reassignChoices(leaving('ann'), ann.items).map((u) => u.id)).toContain('dan')
    const all = P.accessRemoval(deleteCrew)
    expect(P.reassignChoices(deleteCrew, all.items).map((u) => u.id)).not.toContain('dan')
  })

  it('saves the Viewer grants before a member leaves the team', async () => {
    await load(inPlan(false))
    const ann = P.accessRemoval(leaving('ann'))
    expect(await P.removeAccess(leaving('ann'), { keep: true }, ann.items)).toBe(true)
    expect(requests.map((r) => r.name)).toEqual(['projects:update', 'teams:removeMember'])
    expect(requests[0].args).toMatchObject({ id: 'plan', patch: { access: { ann: 'viewer' } } })
    expect(P.levelOn(work, 'ann')).toBe('viewer')
    expect(P.user('ann')?.teams).toEqual([])
    expect(vm('t4').assignee).toBe('ann')
  })

  it('keeps the member in the team when a Viewer grant is refused', async () => {
    await load(inPlan(false))
    refused.add('plan')
    const ann = P.accessRemoval(leaving('ann'))
    expect(await P.removeAccess(leaving('ann'), { keep: true }, ann.items)).toBe(false)
    expect(requests.map((r) => r.name)).toEqual(['projects:update'])
    expect(P.user('ann')?.teams).toEqual(['crew'])
    expect(window.showToast).toHaveBeenCalledWith(
      'Ann Person stays in the Crew team, because not every Viewer grant could be saved.',
      'error',
    )
  })

  it('keeps a deleted team as Viewers without lowering a grant someone keeps', async () => {
    // Crew shares Work and Specs; Dan edits Work on his own and works in Specs
    await load((snap, task) => {
      inPlan(false)(snap, task)
      snap.teams.push({ ...snap.teams[0], id: 'other', name: 'Other' })
      snap.teamAccess = [
        { project_id: work, team_id: 'crew', level: 'user' },
        { project_id: 'specs', team_id: 'crew', level: 'user' },
      ]
      snap.issues.push(task('spec', 5, { project_id: 'specs', assignee_id: 'dan' }))
    })
    const all = P.accessRemoval(deleteCrew)
    expect(all.people).toEqual(['ann', 'dan'])
    expect(all.projects).toEqual([work, 'specs'])
    expect(await P.removeAccess(deleteCrew, { keep: true }, all.items)).toBe(true)
    expect(P.levelOn(work, 'dan')).toBe('user')
    expect(P.levelOn('specs', 'dan')).toBe('viewer')
    expect(P.levelOn(work, 'ann')).toBe('viewer')
    expect(P.levelOn('specs', 'ann')).toBe('viewer')
    expect(requests.map((r) => r.name)).toEqual([
      'projects:update',
      'projects:update',
      'teams:deleteDeep',
    ])
  })

  it('saves nothing when the team to delete is the last one', async () => {
    await load()
    const all = P.accessRemoval(deleteCrew)
    expect(await P.removeAccess(deleteCrew, { to: 'dan' }, all.items)).toBe(false)
    expect(requests).toEqual([])
    expect(vm('t4').assignee).toBe('ann')
    expect(window.showToast).toHaveBeenCalledWith(
      "The Crew team can't be deleted, because it is the organization's last team.",
      'error',
    )
  })

  it('tells whether the access is still there to remove', async () => {
    await load()
    expect(P.removalPending(leaving('ann'))).toBe(true)
    expect(P.removalPending(leaving('dan'))).toBe(false)
    expect(P.removalPending(user('leo'))).toBe(true)
    expect(P.removalPending(user('ann'))).toBe(false) // Crew's grant, not her own
    expect(P.removalPending(deleteCrew)).toBe(true)
  })

  it('reassigns the tasks, then deletes the team', async () => {
    // the last team cannot be deleted
    await load((snap) => snap.teams.push({ ...snap.teams[0], id: 'other', name: 'Other' }))
    const all = P.accessRemoval(deleteCrew)
    expect(held(all)).toEqual([['t4', 'ann', 'assignee']])
    expect(await P.removeAccess(deleteCrew, { to: 'dan' }, all.items)).toBe(true)
    expect(requests.map((r) => r.name)).toEqual(['issues:update', 'teams:deleteDeep'])
    expect(vm('t4').assignee).toBe('dan')
    expect(P.teams.map((t) => t.id)).not.toContain('crew')
  })

  it('asks an admin first, and removes at once with a notice for a leader without project authority', async () => {
    await load(inPlan(false))
    expect(P.startRemoval(leaving('ann'))).toBe(true)
    expect(requests).toEqual([])
    // the signed-in Planner leads Crew and edits Work through it, but does not lead Plan
    await load((snap, task) => {
      inPlan(false)(snap, task)
      const me = snap.profiles[0]
      me.org_role = 'user'
      snap.teamMembers.push({ team_id: 'crew', profile_id: me.id, is_leader: true })
    })
    expect(P.canWrite(work)).toBe(true)
    expect(P.startRemoval(leaving('ann'))).toBe(false)
    await vi.waitFor(() => expect(requests.map((r) => r.name)).toEqual(['teams:removeMember']))
    expect(window.showToast).toHaveBeenCalledWith(
      'Ann Person can no longer see a task they are assigned to or reviewing. A project lead can reassign it.',
      'info',
    )
  })
})

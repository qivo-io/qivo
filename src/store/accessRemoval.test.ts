import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BILLING_READ_ONLY } from '../../convex/lib/billingAccess'
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
  // tasks, projects and team members whose write the server refuses, and how
  let refused: Set<string>
  let refusal: unknown
  let work: string
  // what billing.status says about writing to the organization and a
  // pending deletion, and a way to send it again
  let writable: boolean
  let deletion: { delete_after: string } | null
  let status: () => void
  let stopWatch: () => void
  let deliver: (change: (snap: Snapshot) => void) => void

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
      const name = getFunctionName(ref)
      if (name === 'snapshot:forMe') {
        next(structuredClone(snap))
        // another person's change, as the server delivers it
        deliver = (change) => {
          change(snap)
          next(structuredClone(snap))
        }
      }
      if (name === 'billing:status') {
        status = () => next({ writable, deletion })
        status()
      }
      return () => {}
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
    // as the settings pages that start removals do
    stopWatch = P.watchWriteBlock(org)
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    requests = []
    writable = true
    deletion = null
    refused = new Set()
    // what the server answers when settling the held tasks fails
    refusal = new ConvexError({ code: 'rule', message: 'refused', reason: 'held_tasks' })
    network.query.mockResolvedValue(null)
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      requests.push({ name, args })
      return refused.has(args.id ?? args.profile_id)
        ? Promise.reject(refusal)
        : Promise.resolve(null)
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

  it('keeps a person as a Viewer with their tasks, in one server write', async () => {
    await load()
    const leo = P.accessRemoval(user('leo'))
    expect(await P.removeAccess(user('leo'), { keep: true }, leo.items)).toBe(true)
    expect(P.levelOn(work, 'leo')).toBe('viewer')
    expect(vm('t1').assignee).toBe('leo')
    expect(requests).toEqual([
      {
        name: 'projects:removeAccess',
        args: {
          org_id: expect.any(String),
          id: work,
          user_id: 'leo',
          on_held_tasks: 'keep_as_viewer',
        },
      },
    ])
  })

  it('reassigns the tasks and removes the grant in one server write', async () => {
    await load()
    const leo = P.accessRemoval(user('leo'))
    const removed = P.removeAccess(user('leo'), { to: 'dan' }, leo.items)
    // painted at once; a refusal re-adopts the server's rows
    expect(vm('t1').assignee).toBe('dan')
    expect(vm('t2').reviewer).toBe('dan')
    expect(P.levelOn(work, 'leo')).toBeNull()
    expect(await removed).toBe(true)
    expect(vm('t3').assignee).toBe('leo') // Done stays
    expect(requests.map((r) => [r.name, r.args.on_held_tasks])).toEqual([
      ['projects:removeAccess', { reassign_to: 'dan' }],
    ])
    // Unassigned clears them instead
    const crew = P.accessRemoval(crewGrant())
    expect(await P.removeAccess(crewGrant(), { to: null }, crew.items)).toBe(true)
    expect(vm('t4').assignee).toBeFalsy()
    expect(requests.at(-1)?.args).toMatchObject({
      team_id: 'crew',
      on_held_tasks: { reassign_to: null },
    })
  })

  it('leaves a task someone else reassigned meanwhile with them while the removal waits', async () => {
    await load()
    const leo = P.accessRemoval(user('leo'))
    let answer: (value: unknown) => void = () => {}
    network.mutation.mockImplementationOnce(
      (ref, args) =>
        new Promise((resolve) => {
          requests.push({ name: getFunctionName(ref), args })
          answer = resolve
        }),
    )
    const removed = P.removeAccess(user('leo'), { to: 'dan' }, leo.items)
    expect(vm('t1').assignee).toBe('dan')
    // another admin gives t1 to Ann before the server settles Leo's tasks
    deliver((snap) => {
      const t1 = snap.issues.find((task) => task.id === 't1')!
      t1.assignee_id = 'ann'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // the server settles only what Leo still holds at commit
    expect(vm('t1').assignee).toBe('ann')
    expect(vm('t2').reviewer).toBe('dan')
    answer(null)
    expect(await removed).toBe(true)
  })

  it('removes a grant nobody loses work through without settling anything', async () => {
    await load()
    expect(await P.removeAccess(user('leo'), { to: null }, [])).toBe(true)
    expect(requests.map((r) => [r.name, r.args.on_held_tasks])).toEqual([
      ['projects:removeAccess', 'leave'],
    ])
  })

  it('keeps the grant and every task when the server refuses a reassignment', async () => {
    await load()
    refused.add(work)
    const leo = P.accessRemoval(user('leo'))
    expect(await P.removeAccess(user('leo'), { to: 'dan' }, leo.items)).toBe(false)
    expect(P.levelOn(work, 'leo')).toBe('user')
    expect(vm('t1').assignee).toBe('leo')
    expect(requests.map((r) => r.name)).toEqual(['projects:removeAccess'])
    expect(window.showToast).toHaveBeenCalledWith(
      'Leo Person keeps access, because not every task could be reassigned.',
      'error',
    )
  })

  it('names the reason when the server refuses the removal itself', async () => {
    await load()
    refused.add(work)
    const leo = P.accessRemoval(user('leo'))
    refusal = new ConvexError({
      code: 'forbidden',
      message: 'no permission to manage users on this project',
    })
    expect(await P.removeAccess(user('leo'), { to: 'dan' }, leo.items)).toBe(false)
    expect(window.showToast).toHaveBeenLastCalledWith(
      "You don't have permission for that. Change reverted.",
      'error',
    )
    refusal = new ConvexError({
      code: 'forbidden',
      reason: 'billing_required',
      message: 'This organization is read-only.',
    })
    expect(await P.removeAccess(user('leo'), { to: 'dan' }, leo.items)).toBe(false)
    expect(window.showToast).toHaveBeenLastCalledWith(
      'This organization is read-only. Change reverted.',
      'error',
    )
    refusal = new Error('network down')
    expect(await P.removeAccess(user('leo'), { to: 'dan' }, leo.items)).toBe(false)
    expect(window.showToast).toHaveBeenLastCalledWith("Couldn't save. Change reverted.", 'error')
    expect(window.showToast).not.toHaveBeenCalledWith(
      'Leo Person keeps access, because not every task could be reassigned.',
      'error',
    )
    expect(P.levelOn(work, 'leo')).toBe('user')
    expect(vm('t1').assignee).toBe('leo')
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
    expect(P.project(work)?.teamAccess?.crew).toBeUndefined()
    expect(requests.map((r) => r.name)).toEqual(['projects:removeAccess'])
    expect(requests[0].args).toMatchObject({
      id: work,
      team_id: 'crew',
      on_held_tasks: 'keep_as_viewer',
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

  /* inPlan with Work named, so the sentences read as the window shows them.
     `also` adds what each case needs. */
  const keeping = (also: (snap: Snapshot, task: Task) => void) => (snap: Snapshot, task: Task) => {
    inPlan(false)(snap, task)
    snap.projects[0].name = 'Work'
    also(snap, task)
  }
  const keepText = (change: Parameters<Planner['keepText']>[0]) =>
    P.keepText(change, P.accessRemoval(change))

  it('says a kept Viewer can change nothing in the project when that is so', async () => {
    await load(keeping(() => {}))
    expect(keepText(crewGrant('plan'))).toBe(
      "Ann keeps the task and can see the whole project, but can't change anything in it, including this task.",
    )
  })

  it('names the sub-project a kept Viewer still edits through their own User grant', async () => {
    await load(
      keeping((snap) =>
        snap.access.push({ project_id: 'specs', profile_id: 'ann', level: 'user' }),
      ),
    )
    expect(keepText(crewGrant('plan'))).toBe(
      'Ann keeps the task and can see the whole project, but can change only Specs in it, not this task.',
    )
  })

  it('says several kept Viewers can change nothing when none of them can', async () => {
    await load(
      keeping((snap) => {
        snap.access = snap.access.filter((a) => a.profile_id !== 'leo')
        snap.teamMembers.push({ team_id: 'crew', profile_id: 'leo', is_leader: false })
      }),
    )
    expect(keepText(crewGrant('plan'))).toBe(
      "They keep their tasks and can see the whole project, but can't change anything in it, including these tasks.",
    )
  })

  it('names who of several kept Viewers still edits part of the project, and who does not', async () => {
    // Dan works on a Specs task and keeps his own User grant on Work
    const dans = (snap: Snapshot, task: Task) =>
      snap.issues.push(task('spec', 8, { project_id: 'specs', assignee_id: 'dan' }))
    await load(keeping(dans))
    expect(keepText(crewGrant('plan'))).toBe(
      "They keep their tasks and can see the whole project, but can't change the tasks they keep. Dan can still change Work, and Ann can't change anything in it.",
    )
    await load(
      keeping((snap, task) => {
        dans(snap, task)
        snap.access.push({ project_id: 'specs', profile_id: 'ann', level: 'user' })
      }),
    )
    expect(keepText(crewGrant('plan'))).toBe(
      "They keep their tasks and can see the whole project, but can't change the tasks they keep. Ann can still change Specs and Dan can still change Work.",
    )
  })

  it('names the projects one kept Viewer of a deleted team sees, without "each"', async () => {
    // Crew shares Work and Specs themselves; Ann works in both
    await load(
      keeping((snap, task) => {
        snap.teamAccess = [
          { project_id: work, team_id: 'crew', level: 'user' },
          { project_id: 'specs', team_id: 'crew', level: 'user' },
        ]
        snap.issues.push(task('spec', 8, { project_id: 'specs', assignee_id: 'ann' }))
      }),
    )
    expect(keepText(deleteCrew)).toBe(
      "Ann keeps the 2 tasks and can see Work and Specs, but can't change anything in them, including these tasks.",
    )
  })

  it('names a kept Viewer who edits another listed project of a deleted team', async () => {
    // Crew shares Work and Specs themselves; Dan edits Work, where Ann's task is
    await load(
      keeping((snap, task) => {
        snap.teamAccess = [
          { project_id: work, team_id: 'crew', level: 'user' },
          { project_id: 'specs', team_id: 'crew', level: 'user' },
        ]
        snap.issues.push(task('spec', 8, { project_id: 'specs', assignee_id: 'dan' }))
      }),
    )
    expect(P.accessRemoval(deleteCrew).projects).toEqual([work, 'specs'])
    expect(keepText(deleteCrew)).toBe(
      "They keep their tasks and can each see the projects that hold them, but can't change the tasks they keep. Dan can still change Work, and Ann can't change anything in them.",
    )
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

  it('keeps a member leaving a team as a Viewer, in one server write', async () => {
    await load(inPlan(false))
    const ann = P.accessRemoval(leaving('ann'))
    expect(await P.removeAccess(leaving('ann'), { keep: true }, ann.items)).toBe(true)
    expect(requests).toEqual([
      {
        name: 'teams:removeMember',
        args: {
          org_id: expect.any(String),
          team_id: 'crew',
          profile_id: 'ann',
          on_held_tasks: 'keep_as_viewer',
        },
      },
    ])
    // painted where the server puts it: Plan, the project Crew shared
    expect(P.levelOn('plan', 'ann')).toBe('viewer')
    expect(P.levelOn(work, 'ann')).toBe('viewer')
    expect(P.user('ann')?.teams).toEqual([])
    expect(vm('t4').assignee).toBe('ann')
  })

  it('reassigns the tasks of a member leaving a team in the same write', async () => {
    await load(inPlan(false))
    const ann = P.accessRemoval(leaving('ann'))
    expect(await P.removeAccess(leaving('ann'), { to: 'dan' }, ann.items)).toBe(true)
    expect(requests.map((r) => [r.name, r.args.on_held_tasks])).toEqual([
      ['teams:removeMember', { reassign_to: 'dan' }],
    ])
    expect(vm('t4').assignee).toBe('dan')
    expect(P.user('ann')?.teams).toEqual([])
  })

  it('keeps the member in the team and every task when the server refuses', async () => {
    await load(inPlan(false))
    refused.add('ann')
    const ann = P.accessRemoval(leaving('ann'))
    expect(await P.removeAccess(leaving('ann'), { keep: true }, ann.items)).toBe(false)
    expect(requests.map((r) => r.name)).toEqual(['teams:removeMember'])
    expect(P.user('ann')?.teams).toEqual(['crew'])
    expect(P.project('plan')?.access?.ann).toBeUndefined() // no Viewer grant either
    expect(window.showToast).toHaveBeenCalledWith(
      'Ann Person stays in the Crew team, because not every Viewer grant could be saved.',
      'error',
    )
    expect(await P.removeAccess(leaving('ann'), { to: 'dan' }, ann.items)).toBe(false)
    expect(vm('t4').assignee).toBe('ann')
    expect(P.user('ann')?.teams).toEqual(['crew'])
    expect(window.showToast).toHaveBeenCalledWith(
      'Ann Person stays in the Crew team, because not every task could be reassigned.',
      'error',
    )
    // a billing pause refuses the removal itself, so it names the pause
    refusal = new ConvexError({
      code: 'forbidden',
      reason: 'billing_required',
      message: 'This organization is read-only.',
    })
    expect(await P.removeAccess(leaving('ann'), { keep: true }, ann.items)).toBe(false)
    expect(window.showToast).toHaveBeenLastCalledWith(
      'This organization is read-only. Change reverted.',
      'error',
    )
    expect(P.user('ann')?.teams).toEqual(['crew'])
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
    // each person keeps sight of the projects that hold their own tasks
    expect(P.levelOn('specs', 'ann')).toBeNull()
    expect(P.teams.map((t) => t.id)).not.toContain('crew')
    // the server gives the Viewer grants and deletes the team in one write
    expect(requests).toEqual([
      {
        name: 'teams:deleteDeep',
        args: {
          org_id: expect.any(String),
          id: 'crew',
          on_held_tasks: 'keep_as_viewer',
          expected: { name: 'Crew' },
        },
      },
    ])
  })

  it('keeps the team and every task when the server refuses to settle them', async () => {
    await load((snap, task) => {
      inPlan(false)(snap, task)
      snap.teams.push({ ...snap.teams[0], id: 'other', name: 'Other' })
    })
    refused.add('crew')
    const all = P.accessRemoval(deleteCrew)
    expect(await P.removeAccess(deleteCrew, { to: 'dan' }, all.items)).toBe(false)
    expect(vm('t4').assignee).toBe('ann')
    expect(P.teams.map((t) => t.id)).toContain('crew')
    expect(window.showToast).toHaveBeenLastCalledWith(
      'The Crew team stays, because not every task could be reassigned.',
      'error',
    )
    expect(await P.removeAccess(deleteCrew, { keep: true }, all.items)).toBe(false)
    expect(P.project('plan')?.access?.ann).toBeUndefined()
    expect(P.user('ann')?.teams).toEqual(['crew'])
    expect(window.showToast).toHaveBeenLastCalledWith(
      'The Crew team stays, because not every Viewer grant could be saved.',
      'error',
    )
    expect(requests.map((r) => r.name)).toEqual(['teams:deleteDeep', 'teams:deleteDeep'])
  })

  it('blames no Viewer grant when the server refuses a team deletion as read-only, and refuses the next one up front', async () => {
    await load((snap, task) => {
      inPlan(false)(snap, task)
      snap.teams.push({ ...snap.teams[0], id: 'other', name: 'Other' })
    })
    // access ended at a set time, which billing.status has not said yet
    refusal = new ConvexError({
      code: 'forbidden',
      reason: 'billing_required',
      message: 'This organization is read-only.',
    })
    refused.add('crew')
    const all = P.accessRemoval(deleteCrew)
    expect(P.startRemoval(deleteCrew)).toBe(true)
    expect(await P.removeAccess(deleteCrew, { keep: true }, all.items)).toBe(false)
    expect(window.showToast).toHaveBeenLastCalledWith(
      'This organization is read-only. Change reverted.',
      'error',
    )
    expect(P.removalRefused(deleteCrew)).toBe(true)
    expect(P.startRemoval(deleteCrew)).toBe(false)
    expect(window.showToast).toHaveBeenLastCalledWith('This organization is read-only.', 'error')
    expect(P.teams.some((t) => t.id === 'crew')).toBe(true)
    expect(requests.map((r) => r.name)).toEqual(['teams:deleteDeep'])
  })

  it('saves nothing when the team to delete is the last one', async () => {
    await load()
    const all = P.accessRemoval(deleteCrew)
    expect(await P.removeAccess(deleteCrew, { to: 'dan' }, all.items)).toBe(false)
    expect(requests).toEqual([])
    expect(vm('t4').assignee).toBe('ann')
    expect(window.showToast).toHaveBeenCalledWith(
      "The Crew team can't be deleted, because an organization needs at least one team. Create another team first.",
      'error',
    )
  })

  it('hands over the lead with the lead alone; the outgoing lead keeps User', async () => {
    await load((snap) => {
      snap.projects[0].lead_id = 'dan'
    })
    expect(await P.setProjectAccess(work, 'leo', 'lead')).toBe(true)
    // the server applies the same rule (convex/lib/projectGrants.ts)
    expect(requests.map((r) => [r.name, r.args.patch])).toEqual([
      ['projects:update', { lead_id: 'leo' }],
    ])
    expect(P.project(work)?.lead).toBe('leo')
    expect(P.project(work)?.access).toEqual({ dan: 'user', leo: 'lead' })
  })

  it("changes one person's or team's level with that grant alone", async () => {
    await load()
    expect(P.levelOn(work, 'leo')).toBe('user')
    expect(await P.setProjectAccess(work, 'leo', 'viewer')).toBe(true)
    expect(await P.setProjectTeamAccess(work, 'crew', 'viewer')).toBe(true)
    // the level a person already has sends nothing
    expect(await P.setProjectAccess(work, 'leo', 'viewer')).toBe(true)
    const org = P.orgOf(work)
    expect(requests.map((r) => [r.name, r.args])).toEqual([
      [
        'projects:setAccess',
        {
          org_id: org,
          id: work,
          user_id: 'leo',
          level: 'viewer',
          expected: { level: 'user' },
        },
      ],
      [
        'projects:setAccess',
        {
          org_id: org,
          id: work,
          team_id: 'crew',
          level: 'viewer',
          expected: { level: 'user' },
        },
      ],
    ])
    expect(P.levelOn(work, 'leo')).toBe('viewer')
    expect(P.project(work)?.teamAccess).toEqual({ crew: 'viewer' })
  })

  it('invites a seat whose stored address predates the address rule with the level it holds', async () => {
    await load((snap) => {
      const leo = snap.profiles.find((p) => p.id === 'leo')
      if (leo) leo.email = 'jørn@example.no'
    })
    network.mutation.mockImplementation((ref, args) => {
      requests.push({ name: getFunctionName(ref), args })
      return Promise.resolve({ id: 'leo', emailed: false })
    })
    expect(await P.inviteToProject(work, ' Jørn@Example.no ', 'viewer')).toEqual({ emailed: null })
    expect(requests.map((r) => [r.name, r.args.expected])).toEqual([
      ['projects:inviteGuest', { level: 'user' }],
    ])
  })

  it('tells whether the access is still there to remove', async () => {
    await load()
    expect(P.removalPending(leaving('ann'))).toBe(true)
    expect(P.removalPending(leaving('dan'))).toBe(false)
    expect(P.removalPending(user('leo'))).toBe(true)
    expect(P.removalPending(user('ann'))).toBe(false) // Crew's grant, not her own
    expect(P.removalPending(deleteCrew)).toBe(true)
  })

  it('reassigns the tasks and deletes the team in one server write', async () => {
    // the last team cannot be deleted
    await load((snap) => snap.teams.push({ ...snap.teams[0], id: 'other', name: 'Other' }))
    const all = P.accessRemoval(deleteCrew)
    expect(held(all)).toEqual([['t4', 'ann', 'assignee']])
    const deleted = P.removeAccess(deleteCrew, { to: 'dan' }, all.items)
    // painted at once
    expect(vm('t4').assignee).toBe('dan')
    expect(P.teams.map((t) => t.id)).not.toContain('crew')
    expect(await deleted).toBe(true)
    expect(requests.map((r) => [r.name, r.args.on_held_tasks])).toEqual([
      ['teams:deleteDeep', { reassign_to: 'dan' }],
    ])
    expect(window.showToast).toHaveBeenLastCalledWith('Team “Crew” deleted', 'success')
  })

  it('asks an admin first, and removes at once with a notice for a leader without project authority', async () => {
    await load(inPlan(false))
    expect(P.startRemoval(leaving('ann'))).toBe(true)
    expect(requests).toEqual([])
    // the signed-in Planner leads Crew and edits Work through it, but does not lead Plan;
    // Ann also reviews her own task, which still counts once
    await load((snap, task) => {
      inPlan(false)(snap, task)
      snap.issues.find((i) => i.id === 't4')!.reviewer_id = 'ann'
      const me = snap.profiles[0]
      me.org_role = 'user'
      snap.teamMembers.push({ team_id: 'crew', profile_id: me.id, is_leader: true })
    })
    expect(P.canWrite(work)).toBe(true)
    const notice =
      'Ann Person can no longer see a task they are assigned to or reviewing. A project lead can reassign it.'
    refused.add('ann')
    expect(P.startRemoval(leaving('ann'))).toBe(false)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await vi.waitFor(() => expect(P.user('ann')?.teams).toEqual(['crew'])) // refused, rolled back
    expect(window.showToast).not.toHaveBeenCalledWith(notice, 'info')
    refused.clear()
    expect(P.startRemoval(leaving('ann'))).toBe(false)
    await vi.waitFor(() => expect(window.showToast).toHaveBeenCalledWith(notice, 'info'))
    // nothing to settle for a leader without that authority: the tasks stay
    expect(requests.map((r) => [r.name, r.args.on_held_tasks])).toEqual([
      ['teams:removeMember', 'leave'],
      ['teams:removeMember', 'leave'],
    ])
  })

  /* While billing or a pending deletion makes the organization read-only,
     the server takes access away for an organization admin only with
     'leave', and refuses both choices of the window. */
  const readOnly =
    (change?: (snap: Snapshot, task: Task) => void) => (snap: Snapshot, task: Task) => {
      inPlan(false)(snap, task)
      writable = false
      change?.(snap, task)
    }

  it('removes at once with a notice for an admin while the organization is read-only', async () => {
    await load(inPlan(false))
    expect(P.startRemoval(user('leo'))).toBe(true)
    // billing pauses editing while the page is open
    writable = false
    status()
    expect(P.startRemoval(user('leo'))).toBe(false)
    await vi.waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith(
        'Leo Person can no longer see 2 tasks they are assigned to or reviewing. A project lead can reassign them.',
        'info',
      ),
    )
    expect(P.levelOn(work, 'leo')).toBeNull()
    expect(vm('t1').assignee).toBe('leo')
    expect(P.startRemoval(leaving('ann'))).toBe(false)
    await vi.waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith(
        'Ann Person can no longer see a task they are assigned to or reviewing. A project lead can reassign it.',
        'info',
      ),
    )
    expect(P.user('ann')?.teams).toEqual([])
    expect(vm('t4').assignee).toBe('ann')
    expect(requests.map((r) => [r.name, r.args.on_held_tasks])).toEqual([
      ['projects:removeAccess', 'leave'],
      ['teams:removeMember', 'leave'],
    ])
  })

  it('leaves the tasks once a removal is refused as read-only, until the status answers again', async () => {
    await load(inPlan(false))
    refused.add('ann')
    const ann = P.accessRemoval(leaving('ann'))
    // a refusal for any other reason says nothing about the organization
    expect(await P.removeAccess(leaving('ann'), { keep: true }, ann.items)).toBe(false)
    expect(P.startRemoval(user('leo'))).toBe(true)
    // access ended at a set time, which billing.status has not said yet
    refusal = new ConvexError({
      code: 'forbidden',
      reason: 'billing_required',
      message: 'This organization is read-only.',
    })
    expect(await P.removeAccess(leaving('ann'), { keep: true }, ann.items)).toBe(false)
    expect(P.user('ann')?.teams).toEqual(['crew'])
    expect(P.startRemoval(user('leo'))).toBe(false)
    expect(P.levelOn(work, 'leo')).toBeNull()
    await vi.waitFor(() =>
      expect(window.showToast).toHaveBeenLastCalledWith(
        'Leo Person can no longer see 2 tasks they are assigned to or reviewing. A project lead can reassign them.',
        'info',
      ),
    )
    expect(requests.map((r) => [r.name, r.args.on_held_tasks])).toEqual([
      ['teams:removeMember', 'keep_as_viewer'],
      ['teams:removeMember', 'keep_as_viewer'],
      ['projects:removeAccess', 'leave'],
    ])
    // the status answers again and says the organization can be edited
    status()
    expect(P.startRemoval(crewGrant('plan'))).toBe(true)
    expect(requests).toHaveLength(3)
  })

  it('still asks while the organization can be edited, or once nothing watches', async () => {
    await load(inPlan(false))
    expect(P.startRemoval(user('leo'))).toBe(true)
    expect(P.startRemoval(crewGrant('plan'))).toBe(true)
    await load((snap, task) => {
      inPlan(false)(snap, task)
      snap.teams.push({ ...snap.teams[0], id: 'other', name: 'Other' })
    })
    expect(P.startRemoval(deleteCrew)).toBe(true)
    expect(P.removalRefused(deleteCrew)).toBe(false)
    // nothing follows the status once no settings page watches it
    await load(readOnly())
    stopWatch()
    expect(P.startRemoval(user('leo'))).toBe(true)
    expect(requests).toEqual([])
  })

  it('refuses a team deletion, and any removal by someone who is not an admin, while the organization is read-only', async () => {
    const other = (snap: Snapshot) =>
      snap.teams.push({ ...snap.teams[0], id: 'other', name: 'Other' })
    await load(readOnly(other))
    // the server refuses deleting a team for everyone, so no window opens
    expect(P.startRemoval(deleteCrew)).toBe(false)
    expect(P.removalRefused(deleteCrew)).toBe(true)
    expect(window.showToast).toHaveBeenLastCalledWith(BILLING_READ_ONLY, 'error')
    // a pending deletion says so in its own words
    deletion = { delete_after: '2026-11-01T00:00:00.000Z' }
    status()
    expect(P.startRemoval(deleteCrew)).toBe(false)
    expect(window.showToast).toHaveBeenLastCalledWith(
      'This organization is read-only and will be deleted on 2026-11-01. An organization admin can export its data in Settings.',
      'error',
    )
    // the signed-in Planner leads Plan but is not an admin, so the server
    // refuses even 'leave'
    deletion = null
    await load(
      readOnly((snap) => {
        snap.profiles[0].org_role = 'user'
        snap.projects.find((p) => p.id === 'plan')!.lead_id = snap.profiles[0].id
      }),
    )
    expect(P.startRemoval(user('leo'))).toBe(false)
    expect(window.showToast).toHaveBeenLastCalledWith(BILLING_READ_ONLY, 'error')
    expect(P.levelOn(work, 'leo')).toBe('user')
    expect(requests).toEqual([])
  })
})

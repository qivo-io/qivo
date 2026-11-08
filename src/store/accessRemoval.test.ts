import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemovalAnswer } from './planner'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

type Planner = typeof import('./planner')['P']
type IssueRow = Snapshot['issues'][number]
type Task = (id: string, num: number, extra?: Partial<IssueRow>) => IssueRow

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

/** A preview the server answers (accessRemovals.preview), built from its
    own type: someone loses sight, both choices allowed, unless `o` says
    otherwise. */
function answer(
  o: Partial<Omit<RemovalAnswer, 'keep' | 'reassign'>> & {
    keep?: Partial<RemovalAnswer['keep']>
    reassign?: Partial<RemovalAnswer['reassign']>
  } = {},
): RemovalAnswer {
  const { keep, reassign, ...rest } = o
  return {
    state: 'ok',
    pending: true,
    leave_only: false,
    people: [],
    tasks: 0,
    items: [],
    items_total: 0,
    hidden: 0,
    projects: [],
    ...rest,
    keep: {
      targets: [],
      changers: [],
      allowed: true,
      refusal: null,
      offered: true,
      permitted: true,
      ...keep,
    },
    reassign: { allowed: true, refusal: null, permitted: true, ...reassign },
  }
}

/** A person as a preview names them. */
const person = (id: string, name: string) =>
  ({ id, name, kind: 'person', org_role: 'user' }) as const

/** A holding as a preview lists it. */
const item = (
  task: string,
  num: number,
  holder: string,
  role: 'assignee' | 'reviewer',
  project: string,
) => ({
  task_id: task,
  num,
  title: task,
  project_id: project,
  holder_id: holder,
  role,
})

/* The store's removal on the server's answers. Leo and Dan hold direct User
 * grants on the Work project; Ann reaches it through the Crew team's grant.
 * The signed-in Planner is an organization admin and the store holds
 * nobody else and no team of theirs, so each change carries the
 * organization and the names the page showed, as the Settings pages press
 * them (grantRemoval, teamRemoval). The network answers the preview with
 * `preview` and records every query and write. */
describe('removing access through the server preview', () => {
  let P: Planner
  let requests: { name: string; args: Record<string, unknown> }[]
  let queries: { name: string; args: Record<string, unknown> }[]
  // tasks, projects and team members whose write the server refuses, and how
  let refused: Set<string>
  let refusal: unknown
  let work: string
  let org: string
  // what the server's preview answers, or how it fails
  let preview: () => Promise<unknown>
  let deliver: (change: (snap: Snapshot) => void) => void

  async function load(change?: (snap: Snapshot, task: Task) => void) {
    // a store of its own, so no paint of an earlier load stays
    vi.resetModules()
    requests = []
    queries = []
    const snap: Snapshot = plannerFixture()
    org = snap.orgs[0].id
    work = snap.projects[0].id
    const someone = (id: string) =>
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
    for (const id of ['leo', 'dan', 'ann']) someone(id)
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
      if (getFunctionName(ref) === 'workspace:whole') {
        next(structuredClone(snap))
        // another person's change, as the server delivers it
        deliver = (change) => {
          change(snap)
          next(structuredClone(snap))
        }
      }
      return () => {}
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
    // the views name the projects they show; this suite names them all
    await (await import('./oracleScope.setup')).nameProjects(store.P, snap)
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    requests = []
    queries = []
    refused = new Set()
    preview = async () => answer()
    // what the server answers when settling the held tasks fails
    refusal = new ConvexError({ code: 'rule', message: 'refused', reason: 'held_tasks' })
    network.query.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      queries.push({ name, args })
      return name === 'accessRemovals:preview' ? preview() : Promise.resolve(null)
    })
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
  const shownName = (id: string) => `${id[0].toUpperCase()}${id.slice(1)} Person`
  const user = (userId: string) =>
    ({ kind: 'userGrant', projectId: work, userId, label: shownName(userId) }) as const
  const crewGrant = (projectId = work) =>
    ({ kind: 'teamGrant', projectId, teamId: 'crew', label: 'Crew' }) as const
  const leaving = (userId: string) =>
    ({
      kind: 'teamMember',
      teamId: 'crew',
      userId,
      orgId: org,
      label: shownName(userId),
      team: 'Crew',
    }) as const
  const deleteCrew = () =>
    ({ kind: 'deleteTeam', teamId: 'crew', orgId: org, label: 'Crew' }) as const
  const shown = () => true
  const toasts = () => (window.showToast as ReturnType<typeof vi.fn>).mock.calls
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  /* What the server previews for Leo's grant: his task and his review. */
  const leoAnswer = () =>
    answer({
      people: [person('leo', 'Leo Person')],
      tasks: 2,
      items: [item('t1', 1, 'leo', 'assignee', work), item('t2', 2, 'leo', 'reviewer', work)],
      items_total: 2,
      projects: [{ id: work, name: 'Work', key: 'TEST', parent_id: null }],
      keep: { targets: [work] },
    })
  /* What the server previews for Ann leaving Crew, or Crew's grant going. */
  const annAnswer = (target = work) =>
    answer({
      people: [person('ann', 'Ann Person')],
      tasks: 1,
      items: [item('t4', 4, 'ann', 'assignee', work)],
      items_total: 1,
      projects: [{ id: target, name: 'Work', key: 'TEST', parent_id: null }],
      keep: { targets: [target] },
    })

  describe('the press (P.startRemoval)', () => {
    it('answers the preview when someone loses sight and the caller can carry out both choices', async () => {
      await load()
      preview = async () => leoAnswer()
      expect(await P.startRemoval(user('leo'), shown)).toEqual(leoAnswer())
      expect(requests).toEqual([])
      // a removed Viewer grant is no choice, so Keep's authority decides nothing
      preview = async () => answer({ ...leoAnswer(), keep: { offered: false, permitted: false } })
      expect(await P.startRemoval(user('leo'), shown)).not.toBeNull()
      expect(requests).toEqual([])
    })

    it('asks the server with the removal in its own words, in a fixed key order', async () => {
      await load()
      await P.startRemoval(user('leo'), shown)
      await P.startRemoval(leaving('ann'), shown)
      await P.previewRemoval(deleteCrew(), 'dan')
      await P.reassignChoices(crewGrant(), '', null)
      await P.reassignChoices(crewGrant(), 'da', 'cursor')
      const removalReads = queries.filter((q) => q.name.startsWith('accessRemovals:'))
      expect(removalReads.map((q) => [q.name, JSON.stringify(q.args)])).toEqual([
        [
          'accessRemovals:preview',
          JSON.stringify({
            org_id: org,
            change: { kind: 'user_grant', project_id: work, user_id: 'leo' },
          }),
        ],
        [
          'accessRemovals:preview',
          JSON.stringify({
            org_id: org,
            change: { kind: 'team_member', team_id: 'crew', user_id: 'ann' },
          }),
        ],
        [
          'accessRemovals:preview',
          JSON.stringify({
            org_id: org,
            change: { kind: 'delete_team', team_id: 'crew' },
            reassign_to: 'dan',
          }),
        ],
        [
          'accessRemovals:reassignChoices',
          JSON.stringify({
            org_id: org,
            change: { kind: 'team_grant', project_id: work, team_id: 'crew' },
          }),
        ],
        [
          'accessRemovals:reassignChoices',
          JSON.stringify({
            org_id: org,
            change: { kind: 'team_grant', project_id: work, team_id: 'crew' },
            search: 'da',
            after: 'cursor',
          }),
        ],
      ])
    })

    it('removes nothing when the preview fails, cannot be read or comes from an older backend', async () => {
      await load()
      const older = { ...leoAnswer(), keep: { ...leoAnswer().keep } } as Record<string, unknown>
      // a backend before this release answers without these fields
      delete (older.keep as Record<string, unknown>).permitted
      for (const fails of [
        () => Promise.reject(new Error('offline')),
        async () => ({ state: 'something new' }),
        async () => older,
        async () => ({ ...leoAnswer(), reassign: { allowed: true, refusal: null } }),
      ]) {
        preview = fails
        expect(await P.startRemoval(user('leo'), shown)).toBeNull()
      }
      expect(requests).toEqual([])
      expect(toasts().map(([text]) => text)).toEqual(
        Array(4).fill("Couldn't check which tasks this removal affects. Nothing was removed."),
      )
      // the store holds no one else's level; the requests say what changed
      // the check of a chosen person needs its answer too
      preview = async () => leoAnswer()
      expect(await P.previewRemoval(user('leo'), 'dan')).toBeNull()
    })

    it('says the access is already gone, and changes nothing', async () => {
      await load()
      for (const [change, said] of [
        [user('leo'), 'Leo Person no longer has this access. Nothing was changed.'],
        [crewGrant(), 'The Crew team no longer has this access. Nothing was changed.'],
        [leaving('ann'), 'Ann Person has already left the Crew team. Nothing was changed.'],
        [deleteCrew(), 'The Crew team was already deleted. Nothing was changed.'],
      ] as const) {
        preview = async () => ({ state: 'unavailable' })
        expect(await P.startRemoval(change, shown)).toBeNull()
        expect(window.showToast).toHaveBeenLastCalledWith(said, 'info')
        preview = async () => answer({ pending: false })
        expect(await P.startRemoval(change, shown)).toBeNull()
        expect(window.showToast).toHaveBeenLastCalledWith(said, 'info')
      }
      expect(requests).toEqual([])
    })

    it('names the person and the team as the page showed them, from the change, whether or not the store holds them', async () => {
      await load()
      const { teamRemoval, grantRemoval } = await import('./planner')
      for (const [change, said] of [
        // the names the page showed, the change's label and a member's team
        [{ ...user('leo'), label: 'Leo As Shown' }, 'Leo As Shown no longer has this access.'],
        [
          teamRemoval('crew', 'ann', org, 'Ann As Shown', 'Crew As Shown'),
          'Ann As Shown has already left the Crew As Shown team.',
        ],
        [
          teamRemoval('crew', null, org, 'Crew As Shown'),
          'The Crew As Shown team was already deleted.',
        ],
        // a member's team the page did not name, which the store does not
        // hold either
        [
          teamRemoval('crew', 'ann', org, 'Ann As Shown'),
          'Ann As Shown has already left the team.',
        ],
        // a person and a team the store does not hold, named only by the page
        [
          grantRemoval('user', work, 'nobody-held', org, false, 'Nina Unheld'),
          'Nina Unheld no longer has this access.',
        ],
        [teamRemoval('far-team', null, org, 'Far Team'), 'The Far Team was already deleted.'],
      ] as const) {
        preview = async () => ({ state: 'unavailable' })
        expect(await P.startRemoval(change, shown)).toBeNull()
        expect(window.showToast).toHaveBeenLastCalledWith(`${said} Nothing was changed.`, 'info')
      }
      expect(requests).toEqual([])
    })

    it('sends a team change to the organization it names, with no early last-team refusal for one that names it', async () => {
      await load()
      const { teamRemoval } = await import('./planner')
      // a member of a team the store does not hold
      preview = async () => answer({ tasks: 0 })
      expect(await P.startRemoval(teamRemoval('far-team', 'ann', org, 'Ann'), shown)).toBeNull()
      await settle()
      expect(requests.at(-1)).toMatchObject({
        name: 'teams:removeMember',
        args: { org_id: org, team_id: 'far-team', profile_id: 'ann' },
      })
      // the server, not the store, refuses the last team for a change that
      // names its organization
      const deleting = P.removeAccess(teamRemoval('far-team', null, org, 'Far Team'), { to: null })
      // a press and its check are told apart without the label
      expect(P.removingAccess(teamRemoval('far-team', null, org, ''))).toBe(true)
      await deleting
      expect(requests.at(-1)).toMatchObject({
        name: 'teams:deleteDeep',
        args: { org_id: org, id: 'far-team', expected: { name: 'Far Team' } },
      })
    })

    it("refuses with the server's sentence what it refuses or cannot check in one request", async () => {
      await load()
      for (const state of ['refused', 'too_large'] as const) {
        preview = async () => ({ state, message: 'only organization admins can delete teams' })
        expect(await P.startRemoval(deleteCrew(), shown)).toBeNull()
        expect(window.showToast).toHaveBeenLastCalledWith(
          'Only organization admins can delete teams.',
          'error',
        )
      }
      expect(requests).toEqual([])
    })

    it('removes at once when nobody loses sight of a task', async () => {
      await load()
      preview = async () => answer({ tasks: 0 })
      expect(await P.startRemoval(user('leo'), shown)).toBeNull()
      await settle()
      expect(requests.map((r) => [r.name, r.args.on_held_tasks])).toEqual([
        ['projects:removeAccess', 'leave'],
      ])
      // the store holds no one else's level; the requests say what changed
    })

    it('opens the window with Keep as Viewer alone for a caller who may keep the people but not reassign', async () => {
      await load()
      // an organization admin who manages Work without Edit on its tasks
      const keepOnly = answer({
        ...leoAnswer(),
        reassign: { allowed: false, refusal: 'no write access to this project', permitted: false },
      })
      preview = async () => keepOnly
      expect(await P.startRemoval(user('leo'), shown)).toEqual(keepOnly)
      expect(requests).toEqual([])
      // a removed Viewer grant offers no Keep, so such a caller gets the notice
      preview = async () =>
        answer({
          ...leoAnswer(),
          keep: { offered: false, permitted: true },
          reassign: { allowed: false, permitted: false },
        })
      expect(await P.startRemoval(user('leo'), shown)).toBeNull()
      await vi.waitFor(() => expect(requests.map((r) => r.args.on_held_tasks)).toEqual(['leave']))
    })

    it('removes at once with a notice for a caller who cannot carry out both choices, counting tasks the caller cannot see', async () => {
      await load()
      const notice = (n: string) =>
        `Ann Person can no longer see ${n} they are assigned to or reviewing. A project lead can reassign ${n === 'a task' ? 'it' : 'them'}.`
      // a team leader who may make neither choice once the access is gone
      preview = async () =>
        answer({
          ...annAnswer(),
          keep: { allowed: false, permitted: false },
          reassign: { allowed: false, permitted: false },
        })
      expect(await P.startRemoval(leaving('ann'), shown)).toBeNull()
      await vi.waitFor(() =>
        expect(window.showToast).toHaveBeenLastCalledWith(notice('a task'), 'info'),
      )
      // or a team leader with Edit who does not manage the users of a Keep
      // target, with two tasks out of sight: the rule is one-sided, so a
      // caller who may reassign but not keep gets the notice
      await load()
      preview = async () =>
        answer({ ...annAnswer(), tasks: 3, hidden: 2, keep: { allowed: false, permitted: false } })
      expect(await P.startRemoval(leaving('ann'), shown)).toBeNull()
      await vi.waitFor(() =>
        expect(window.showToast).toHaveBeenLastCalledWith(notice('3 tasks'), 'info'),
      )
      expect(requests.map((r) => [r.name, r.args.on_held_tasks])).toEqual([
        ['teams:removeMember', 'leave'],
      ])
      // a refused removal says no notice
      await load()
      refused.add('ann')
      preview = async () =>
        answer({
          ...annAnswer(),
          keep: { allowed: false, permitted: false },
          reassign: { allowed: false, permitted: false },
        })
      ;(window.showToast as ReturnType<typeof vi.fn>).mockClear()
      expect(await P.startRemoval(leaving('ann'), shown)).toBeNull()
      await vi.waitFor(() => expect(requests).toHaveLength(1))
      // refused with its toast, and no notice
      await vi.waitFor(() => expect(toasts().map(([, tone]) => tone)).toContain('error'))
      expect(toasts().map(([, tone]) => tone)).not.toContain('info')
    })

    it('removes at once with a notice for an admin while the organization is read-only', async () => {
      await load()
      preview = async () =>
        answer({
          ...leoAnswer(),
          leave_only: true,
          keep: { allowed: false, refusal: 'This organization is read-only.' },
          reassign: { allowed: false, refusal: 'This organization is read-only.' },
        })
      expect(await P.startRemoval(user('leo'), shown)).toBeNull()
      await vi.waitFor(() =>
        expect(window.showToast).toHaveBeenCalledWith(
          'Leo Person can no longer see 2 tasks they are assigned to or reviewing. A project lead can reassign them.',
          'info',
        ),
      )
      // the store holds no one else's level; the requests say what changed
      expect(vm('t1').assignee).toBe('leo')
      expect(requests.map((r) => [r.name, r.args.on_held_tasks])).toEqual([
        ['projects:removeAccess', 'leave'],
      ])
    })

    it('does nothing once the page that pressed is left before the preview answers', async () => {
      await load()
      for (const answered of [leoAnswer(), answer({ tasks: 0 }), { state: 'unavailable' }]) {
        preview = async () => answered
        expect(await P.startRemoval(user('leo'), () => false)).toBeNull()
      }
      preview = () => Promise.reject(new Error('offline'))
      expect(await P.startRemoval(user('leo'), () => false)).toBeNull()
      await settle()
      expect(requests).toEqual([])
      expect(window.showToast).not.toHaveBeenCalled()
    })
  })

  describe('the write (P.removeAccess)', () => {
    it('keeps a person as a Viewer with their tasks, in one server write', async () => {
      await load()
      expect(await P.removeAccess(user('leo'), { keep: true }, leoAnswer())).toBe(true)
      // the store holds no one else's level; the requests say what changed
      expect(vm('t1').assignee).toBe('leo')
      expect(requests).toEqual([
        {
          name: 'projects:removeAccess',
          args: { org_id: org, id: work, user_id: 'leo', on_held_tasks: 'keep_as_viewer' },
        },
      ])
    })

    it('reassigns the listed tasks and removes the grant in one server write', async () => {
      await load()
      const removed = P.removeAccess(user('leo'), { to: 'dan' }, leoAnswer())
      // painted at once; a refusal re-adopts the server's rows
      expect(vm('t1').assignee).toBe('dan')
      expect(vm('t2').reviewer).toBe('dan')
      // the store holds no one else's level; the requests say what changed
      expect(await removed).toBe(true)
      expect(vm('t3').assignee).toBe('leo') // Done stays
      expect(requests.map((r) => [r.name, r.args.on_held_tasks])).toEqual([
        ['projects:removeAccess', { reassign_to: 'dan' }],
      ])
      // Unassigned clears them instead
      expect(await P.removeAccess(crewGrant(), { to: null }, annAnswer())).toBe(true)
      expect(vm('t4').assignee).toBeFalsy()
      expect(requests.at(-1)?.args).toMatchObject({
        team_id: 'crew',
        on_held_tasks: { reassign_to: null },
      })
    })

    it('leaves a task someone else reassigned meanwhile with them while the removal waits', async () => {
      await load()
      let answered: (value: unknown) => void = () => {}
      network.mutation.mockImplementationOnce(
        (ref, args) =>
          new Promise((resolve) => {
            requests.push({ name: getFunctionName(ref), args })
            answered = resolve
          }),
      )
      const removed = P.removeAccess(user('leo'), { to: 'dan' }, leoAnswer())
      expect(vm('t1').assignee).toBe('dan')
      // another admin gives t1 to Ann before the server settles Leo's tasks
      deliver((snap) => {
        const t1 = snap.issues.find((task) => task.id === 't1')!
        t1.assignee_id = 'ann'
      })
      await settle()
      // the server settles only what Leo still holds at commit
      expect(vm('t1').assignee).toBe('ann')
      expect(vm('t2').reviewer).toBe('dan')
      answered(null)
      expect(await removed).toBe(true)
    })

    it('sends leave and paints the removal alone without a preview, or with one that lists nothing', async () => {
      await load()
      expect(await P.removeAccess(user('leo'), { keep: true })).toBe(true)
      // the store holds no one else's level; the requests say what changed
      expect(vm('t1').assignee).toBe('leo')
      expect(await P.removeAccess(user('dan'), { to: 'ann' }, answer())).toBe(true)
      expect(requests.map((r) => [r.name, r.args.on_held_tasks])).toEqual([
        ['projects:removeAccess', 'leave'],
        ['projects:removeAccess', 'leave'],
      ])
    })

    it('keeps the grant and every task when the server refuses a reassignment', async () => {
      await load()
      refused.add(work)
      expect(await P.removeAccess(user('leo'), { to: 'dan' }, leoAnswer())).toBe(false)
      // the store holds no one else's level; the requests say what changed
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
      refusal = new ConvexError({
        code: 'forbidden',
        message: 'no permission to manage users on this project',
      })
      expect(await P.removeAccess(user('leo'), { to: 'dan' }, leoAnswer())).toBe(false)
      expect(window.showToast).toHaveBeenLastCalledWith(
        "You don't have permission for that. Change reverted.",
        'error',
      )
      refusal = new ConvexError({
        code: 'forbidden',
        reason: 'billing_required',
        message: 'This organization is read-only.',
      })
      expect(await P.removeAccess(user('leo'), { to: 'dan' }, leoAnswer())).toBe(false)
      expect(window.showToast).toHaveBeenLastCalledWith(
        'This organization is read-only. Change reverted.',
        'error',
      )
      refusal = new Error('network down')
      expect(await P.removeAccess(user('leo'), { to: 'dan' }, leoAnswer())).toBe(false)
      expect(window.showToast).toHaveBeenLastCalledWith("Couldn't save. Change reverted.", 'error')
      expect(window.showToast).not.toHaveBeenCalledWith(
        'Leo Person keeps access, because not every task could be reassigned.',
        'error',
      )
      // the store holds no one else's level; the requests say what changed
      expect(vm('t1').assignee).toBe('leo')
    })

    it("paints a team's grant kept as Viewers on its project, and takes it away on a refusal", async () => {
      await load()
      expect(await P.removeAccess(crewGrant(), { keep: true }, annAnswer())).toBe(true)
      // the store holds no one else's level; the requests say what changed
      expect(requests).toEqual([
        {
          name: 'projects:removeAccess',
          args: { org_id: org, id: work, team_id: 'crew', on_held_tasks: 'keep_as_viewer' },
        },
      ])
      await load()
      refused.add(work)
      expect(await P.removeAccess(crewGrant(), { keep: true }, annAnswer())).toBe(false)
    })

    it('paints no Viewer grant for a team change, which the delivery brings', async () => {
      await load()
      let answered: (value: unknown) => void = () => {}
      network.mutation.mockImplementationOnce(
        (ref, args) =>
          new Promise((resolve) => {
            requests.push({ name: getFunctionName(ref), args })
            answered = resolve
          }),
      )
      const removed = P.removeAccess(leaving('ann'), { keep: true }, annAnswer())
      expect(vm('t4').assignee).toBe('ann')
      deliver((snap) => {
        snap.teamMembers = snap.teamMembers.filter((m) => m.profile_id !== 'ann')
        snap.access.push({ project_id: work, profile_id: 'ann', level: 'viewer' })
      })
      answered(null)
      expect(await removed).toBe(true)
      // the store holds no one else's level; the requests say what changed
      expect(requests).toEqual([
        {
          name: 'teams:removeMember',
          args: {
            org_id: org,
            team_id: 'crew',
            profile_id: 'ann',
            on_held_tasks: 'keep_as_viewer',
          },
        },
      ])
    })

    it('reassigns the tasks of a member leaving a team in the same write', async () => {
      await load()
      expect(await P.removeAccess(leaving('ann'), { to: 'dan' }, annAnswer())).toBe(true)
      expect(requests.map((r) => [r.name, r.args.on_held_tasks])).toEqual([
        ['teams:removeMember', { reassign_to: 'dan' }],
      ])
      expect(vm('t4').assignee).toBe('dan')
    })

    it('keeps the member in the team and every task when the server refuses', async () => {
      await load()
      refused.add('ann')
      expect(await P.removeAccess(leaving('ann'), { keep: true }, annAnswer())).toBe(false)
      expect(requests.map((r) => r.name)).toEqual(['teams:removeMember'])
      expect(vm('t4').assignee).toBe('ann')
      expect(window.showToast).toHaveBeenCalledWith(
        'Ann Person stays in the Crew team, because not every Viewer grant could be saved.',
        'error',
      )
      expect(await P.removeAccess(leaving('ann'), { to: 'dan' }, annAnswer())).toBe(false)
      expect(vm('t4').assignee).toBe('ann')
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
      expect(await P.removeAccess(leaving('ann'), { keep: true }, annAnswer())).toBe(false)
      expect(window.showToast).toHaveBeenLastCalledWith(
        'This organization is read-only. Change reverted.',
        'error',
      )
    })

    it('reassigns the tasks and deletes the team in one server write, and keeps it when refused', async () => {
      // the signed-in person is in Crew, so the store holds it and paints
      // its delete
      const inCrew = (snap: Snapshot) => {
        snap.teams.push({ ...snap.teams[0], id: 'other', name: 'Other' })
        snap.teamMembers.push({
          team_id: 'crew',
          profile_id: snap.myProfileIds[0],
          is_leader: false,
        })
      }
      await load(inCrew)
      const deleted = P.removeAccess(deleteCrew(), { to: 'dan' }, annAnswer())
      // painted at once
      expect(vm('t4').assignee).toBe('dan')
      expect(P.teams.map((t) => t.id)).not.toContain('crew')
      expect(await deleted).toBe(true)
      expect(requests.map((r) => [r.name, r.args.on_held_tasks])).toEqual([
        ['teams:deleteDeep', { reassign_to: 'dan' }],
      ])
      expect(window.showToast).toHaveBeenLastCalledWith('Team “Crew” deleted', 'success')
      await load(inCrew)
      refused.add('crew')
      expect(await P.removeAccess(deleteCrew(), { keep: true }, annAnswer())).toBe(false)
      expect(P.teams.map((t) => t.id)).toContain('crew')
      expect(window.showToast).toHaveBeenLastCalledWith(
        'The Crew team stays, because not every Viewer grant could be saved.',
        'error',
      )
    })

    it('leaves the last team to the server, which refuses its delete with its sentence', async () => {
      // the store holds no team of anyone else, so it cannot tell the last
      // one; the server refuses it (convex/model/orgs.ts assertNotLastTeam)
      await load()
      refused.add('crew')
      refusal = new ConvexError({
        code: 'rule',
        message:
          'an organization needs at least one team; create another team before deleting this one',
      })
      expect(await P.removeAccess(deleteCrew(), { to: 'dan' }, annAnswer())).toBe(false)
      expect(requests.map((r) => r.name)).toEqual(['teams:deleteDeep'])
      expect(vm('t4').assignee).toBe('ann')
      expect(window.showToast).toHaveBeenLastCalledWith(
        'An organization needs at least one team; create another team before deleting this one. Change reverted.',
        'error',
      )
    })
  })

  describe("Keep as Viewer's text (P.keepText)", () => {
    /* Plan is a top-level project over Work and Specs. */
    const plan = { id: 'plan', name: 'Plan', key: 'PLAN', parent_id: null }
    const workRef = () => ({ id: work, name: 'Work', key: 'TEST', parent_id: 'plan' })
    const specs = { id: 'specs', name: 'Specs', key: 'SPEC', parent_id: 'plan' }
    const text = (change: Parameters<Planner['keepText']>[0], o: Parameters<typeof answer>[0]) =>
      P.keepText(change, answer(o))
    const ann = person('ann', 'Ann Person')
    const dan = person('dan', 'Dan Person')

    it('says a kept Viewer can change nothing in the project when that is so', async () => {
      await load()
      expect(
        text(crewGrant('plan'), {
          people: [ann],
          tasks: 1,
          projects: [plan],
          keep: { targets: ['plan'] },
        }),
      ).toBe(
        "Ann keeps the task and can see the whole project, but can't change anything in it, including this task.",
      )
      expect(
        text(crewGrant(work), {
          people: [ann],
          tasks: 1,
          projects: [workRef()],
          keep: { targets: [work] },
        }),
      ).toBe(
        "Ann keeps the task and can see the whole sub-project, but can't change anything in it, including this task.",
      )
    })

    it('names the sub-project a kept Viewer still edits through their own User grant', async () => {
      await load()
      expect(
        text(crewGrant('plan'), {
          people: [ann],
          tasks: 1,
          projects: [plan, specs],
          keep: { targets: ['plan'], changers: [{ id: 'ann', projects: ['specs'], more: 0 }] },
        }),
      ).toBe(
        'Ann keeps the task and can see the whole project, but can change only Specs in it, not this task.',
      )
    })

    it('counts the projects a kept Viewer still edits past the ones the server names', async () => {
      await load()
      const refs = ['a', 'b', 'c'].map((id) => ({
        id,
        name: id.toUpperCase(),
        key: id,
        parent_id: 'plan',
      }))
      expect(
        text(crewGrant('plan'), {
          people: [ann],
          tasks: 2,
          projects: [plan, ...refs],
          keep: {
            targets: ['plan'],
            changers: [{ id: 'ann', projects: ['a', 'b', 'c'], more: 3 }],
          },
        }),
      ).toBe(
        'Ann keeps the 2 tasks and can see the whole project, but can change only A, B and 4 other projects in it, not these tasks.',
      )
    })

    it('says several kept Viewers can change nothing when none of them can', async () => {
      await load()
      expect(
        text(crewGrant('plan'), {
          people: [ann, dan],
          tasks: 2,
          projects: [plan],
          keep: { targets: ['plan'] },
        }),
      ).toBe(
        "They keep their tasks and can see the whole project, but can't change anything in it, including these tasks.",
      )
    })

    it('names who of several kept Viewers still edits part of the project, and who does not', async () => {
      await load()
      expect(
        text(crewGrant('plan'), {
          people: [ann, dan],
          tasks: 2,
          projects: [plan, workRef()],
          keep: { targets: ['plan'], changers: [{ id: 'dan', projects: [work], more: 0 }] },
        }),
      ).toBe(
        "They keep their tasks and can see the whole project, but can't change the tasks they keep. Dan can still change Work, and Ann can't change anything in it.",
      )
      expect(
        text(crewGrant('plan'), {
          people: [ann, dan],
          tasks: 2,
          projects: [plan, workRef(), specs],
          keep: {
            targets: ['plan'],
            changers: [
              { id: 'ann', projects: ['specs'], more: 0 },
              { id: 'dan', projects: [work], more: 0 },
            ],
          },
        }),
      ).toBe(
        "They keep their tasks and can see the whole project, but can't change the tasks they keep. Ann can still change Specs and Dan can still change Work.",
      )
    })

    it('names the projects one kept Viewer of a deleted team sees, without "each"', async () => {
      await load()
      expect(
        text(deleteCrew(), {
          people: [ann],
          tasks: 2,
          projects: [workRef(), specs],
          keep: { targets: [work, 'specs'] },
        }),
      ).toBe(
        "Ann keeps the 2 tasks and can see Work and Specs, but can't change anything in them, including these tasks.",
      )
    })

    it('names a kept Viewer who edits another listed project of a deleted team, and several places', async () => {
      await load()
      expect(
        text(deleteCrew(), {
          people: [ann, dan],
          tasks: 2,
          projects: [workRef(), specs],
          keep: { targets: [work, 'specs'], changers: [{ id: 'dan', projects: [work], more: 0 }] },
        }),
      ).toBe(
        "They keep their tasks and can each see the projects that hold them, but can't change the tasks they keep. Dan can still change Work, and Ann can't change anything in them.",
      )
      const four = ['a', 'b', 'c', 'd'].map((id) => ({
        id,
        name: id.toUpperCase(),
        key: id,
        parent_id: null,
      }))
      expect(
        text(leaving('ann'), {
          people: [ann],
          tasks: 4,
          projects: four,
          keep: { targets: four.map((p) => p.id) },
        }),
      ).toBe(
        "Ann keeps the 4 tasks and can see A, B and 2 other projects, but can't change anything in them, including these tasks.",
      )
    })
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
  })

  it("changes one person's or team's level with that grant alone", async () => {
    await load()
    // the store holds no one else's level; the requests say what changed
    // the page sends the level it showed, as the store holds no one else's
    const shown = (level: 'user' | 'viewer') => ({ orgId: org, leadId: null, level })
    expect(await P.setProjectAccess(work, 'leo', 'viewer', shown('user'))).toBe(true)
    expect(await P.setProjectTeamAccess(work, 'crew', 'viewer')).toBe(true)
    // the level a person already has sends nothing
    expect(await P.setProjectAccess(work, 'leo', 'viewer', shown('viewer'))).toBe(true)
    expect(requests.map((r) => [r.name, r.args])).toEqual([
      [
        'projects:setAccess',
        { org_id: org, id: work, user_id: 'leo', level: 'viewer', expected: { level: 'user' } },
      ],
      [
        'projects:setAccess',
        { org_id: org, id: work, team_id: 'crew', level: 'viewer', expected: { level: 'user' } },
      ],
    ])
    // the store holds no one else's level; the requests say what changed
  })

  it('invites with the level the page’s lookup found as expected, and none without a lookup', async () => {
    await load()
    network.mutation.mockImplementation((ref, args) => {
      requests.push({ name: getFunctionName(ref), args })
      return Promise.resolve({ id: 'leo', emailed: false })
    })
    // the server's lookup finds a seat by its stored address, also one that
    // predates the address rule (projectSettings.inviteTarget)
    expect(
      await P.inviteToProject(work, ' Jørn@Example.no ', 'viewer', { orgId: org, level: 'user' }),
    ).toEqual({ emailed: null })
    // the store holds nobody else to look the address up in
    expect(await P.inviteToProject(work, 'leo@example.test', 'viewer')).toEqual({ emailed: null })
    expect(requests.map((r) => [r.name, r.args.expected])).toEqual([
      ['projects:inviteGuest', { level: 'user' }],
      ['projects:inviteGuest', undefined],
    ])
  })
})

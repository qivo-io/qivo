import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture as fixture, type Snapshot } from './plannerFixture.setup'

type Planner = typeof import('./planner')['P']
type Profile = Snapshot['profiles'][number]
type Setting = Snapshot['orgs'][number]['project_creators']

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

type Pending = {
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

describe('project creation through the client store', () => {
  let P: Planner
  let snap: Snapshot
  let requests: Pending[]
  let showToast: ReturnType<typeof vi.fn>
  let deliver: (next: Snapshot) => void

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    showToast = vi.fn()
    vi.stubGlobal('window', { showToast })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snap = fixture()
    requests = []
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((ref, _args, next) => {
      if (getFunctionName(ref) === 'workspace:whole') deliver = next
      next(structuredClone(snap))
      return () => {}
    })
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      return new Promise((resolve, reject) => requests.push({ name, args, resolve, reject }))
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const settled = () => vi.waitFor(() => expect(P.roadmapUndo.busy).toBe(false))

  it('adopts the key the server chose in place of a taken preview', async () => {
    const id = P.addProject({ type: 'meta', key: 'TES', name: 'Test' })!
    expect(P.project(id)?.key).toBe('TES')
    expect(requests[0]).toMatchObject({ name: 'projects:create', args: { id, key: 'TES' } })

    requests[0].resolve({ id, num: snap.orgs[0].next_project_num + 1, key: 'TES2' })
    await settled()
    expect(P.project(id)?.key).toBe('TES2')
    expect(showToast).not.toHaveBeenCalled()
  })

  it('reports success only after the server stores the project', async () => {
    const onSaved = vi.fn()
    const onRefused = vi.fn()
    const id = P.addProject({ type: 'meta', key: 'NEW', name: 'New' }, onSaved, onRefused)!
    expect(P.project(id)?.name).toBe('New')
    expect(onSaved).not.toHaveBeenCalled()

    requests[0].resolve({ id, num: snap.orgs[0].next_project_num + 1, key: 'NEW' })
    await settled()
    expect(onSaved).toHaveBeenCalledOnce()
    expect(onRefused).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })

  it.each([
    ['bad_request', 'meta', 'refused', "Couldn't create project “Test”"],
    ['not_found', 'meta', 'refused', "Couldn't create project “Test”"],
    [
      'forbidden',
      'meta',
      'only org admins can create projects',
      'No permission to create project “Test”. Only org admins can create projects.',
    ],
    ['forbidden', 'meta', '', 'No permission to create project “Test”'],
    [
      'rule',
      'project',
      'parent project not found',
      "Couldn't create sub-project “Test”. Parent project not found.",
    ],
  ] as const)(
    'a %s refusal of a %s saying “%s” names it and removes it',
    async (code, type, reason, message) => {
      const onSaved = vi.fn()
      const onRefused = vi.fn()
      const parent =
        type === 'project' ? P.addProject({ type: 'meta', key: 'PAR', name: 'Parent' }) : undefined
      const id = P.addProject({ type, key: 'TES', name: 'Test', parent }, onSaved, onRefused)!
      const request = requests.find((r) => r.args.id === id)!
      request.reject(new ConvexError({ code, message: reason }))
      await vi.waitFor(() => expect(onRefused).toHaveBeenCalledOnce())
      expect(onSaved).not.toHaveBeenCalled()
      expect(showToast).toHaveBeenCalledExactlyOnceWith(message, 'error')
      expect(P.project(id)).toBeUndefined()
    },
  )

  it('keeps a free preview key unchanged', async () => {
    const id = P.addProject({ type: 'meta', key: 'NEW', name: 'New' })!
    requests[0].resolve({ id, num: snap.orgs[0].next_project_num + 1, key: 'NEW' })
    await settled()
    expect(P.project(id)?.key).toBe('NEW')
  })

  describe('canCreateProject', () => {
    /* Me (the fixture's org admin) beside one seat of each kind in the home
       org. Every seat but `plain` and `agent` carries the right, which only
       counts for an active standard user, person or agent, while the setting
       is 'selected'. */
    const seat = (id: string, org_role: Profile['org_role'], extra: Partial<Profile> = {}) => ({
      id,
      org_id: snap.orgs[0].id,
      name: id,
      initials: 'SE',
      color: '#335577',
      org_role,
      active: true,
      kind: 'person' as const,
      can_create_projects: true,
      created_at: '2026-09-14T08:00:00.000Z',
      ...extra,
    })
    const ask = (setting: Setting) => {
      snap.orgs[0].project_creators = setting
      deliver(structuredClone(snap))
      const ids = [
        'plain',
        'flagged',
        'viewer',
        'guest',
        'inactive',
        'agent',
        'flaggedAgent',
        'viewerAgent',
      ]
      return {
        me: P.canCreateProject(),
        ...Object.fromEntries(ids.map((id) => [id, P.canCreateProject(id)])),
      }
    }

    beforeEach(() => {
      snap.profiles.push(
        seat('plain', 'user', { can_create_projects: undefined }),
        seat('flagged', 'user'),
        seat('viewer', 'viewer'),
        seat('guest', 'guest'),
        seat('inactive', 'user', { active: false }),
        seat('agent', 'user', { kind: 'agent', can_create_projects: undefined }),
        seat('flaggedAgent', 'user', { kind: 'agent' }),
        seat('viewerAgent', 'viewer', { kind: 'agent' }),
      )
    })

    const nobodyElse = {
      plain: false,
      flagged: false,
      viewer: false,
      guest: false,
      inactive: false,
      agent: false,
      flaggedAgent: false,
      viewerAgent: false,
    }

    it('lets every active standard user, person or agent, create while the setting is missing or users', () => {
      for (const setting of [undefined, 'users'] as const) {
        expect(ask(setting)).toEqual({
          ...nobodyElse,
          me: true,
          plain: true,
          flagged: true,
          agent: true,
          flaggedAgent: true,
        })
      }
    })

    it('needs the right under selected users', () => {
      expect(ask('selected')).toEqual({
        ...nobodyElse,
        me: true,
        flagged: true,
        flaggedAgent: true,
      })
    })

    it('lets only org admins create under admins or a setting it does not know', () => {
      expect(ask('admins')).toEqual({ ...nobodyElse, me: true })
      expect(ask('everyone' as unknown as Setting)).toEqual({ ...nobodyElse, me: true })
    })

    it('reads my own seat when asked without a user', () => {
      snap.profiles[0].org_role = 'user'
      expect(ask('selected').me).toBe(false)
      snap.profiles[0].can_create_projects = true
      expect(ask('selected').me).toBe(true)
      expect(ask('admins').me).toBe(false)
    })
  })

  describe('a project its creator may not see', () => {
    /* Me as a standard user beside Leo; Crew holds Leo, Mine holds me and
       Ingrid, an org viewer. */
    let me: string
    const NOW = '2026-09-14T08:00:00.000Z'

    beforeEach(() => {
      const org = snap.orgs[0].id
      const mine = snap.profiles[0]
      me = mine.id
      mine.org_role = 'user'
      const other = (id: string, org_role: Profile['org_role']): Profile => ({
        ...mine,
        id,
        name: id,
        org_role,
        auth_user_id: `account-${id}`,
      })
      snap.profiles.push(other('leo', 'user'), other('ingrid', 'viewer'))
      const team = (id: string) => ({
        id,
        org_id: org,
        name: id,
        track_delay_default: false,
        created_at: NOW,
      })
      snap.teams.push(team('crew'), team('mine'))
      snap.teamMembers.push(
        { team_id: 'crew', profile_id: 'leo', is_leader: false },
        { team_id: 'mine', profile_id: me, is_leader: false },
        { team_id: 'mine', profile_id: 'ingrid', is_leader: false },
      )
      deliver(structuredClone(snap))
    })

    it('predicts that the lead, an individual grant or a share with my team lets me see it', () => {
      expect(P.seesNewProject({ lead: me })).toBe(true)
      expect(P.seesNewProject({ lead: 'leo', access: { [me]: 'user' } })).toBe(true)
      expect(P.seesNewProject({ lead: 'leo', access: { [me]: 'viewer' } })).toBe(true)
      expect(P.seesNewProject({ lead: 'leo', teamAccess: { mine: 'viewer' } })).toBe(true)
    })

    it('predicts the User grant the server gives me when someone else leads', () => {
      expect(P.seesNewProject({ lead: 'leo' })).toBe(true)
      const id = P.addProject({ type: 'meta', key: 'NEW', name: 'New', lead: 'leo' })!
      expect(P.levelOn(id)).toBe('user')
      expect(requests.at(-1)?.args).toMatchObject({ lead_id: 'leo', access: {} })
    })

    it('predicts that I lose sight of it once I decline my own entry', () => {
      const none = { [me]: null }
      expect(P.seesNewProject({ lead: 'leo', access: none })).toBe(false)
      expect(P.seesNewProject({ lead: 'leo', access: { ...none, ingrid: 'viewer' } })).toBe(false)
      expect(P.seesNewProject({ lead: 'leo', access: none, teamAccess: { crew: 'user' } })).toBe(
        false,
      )
    })

    it('lets an org admin see every project, and a viewer see one shared with their team', () => {
      expect(P.seesNewProject({ lead: 'leo' }, 'ingrid')).toBe(false)
      expect(P.seesNewProject({ lead: 'leo', teamAccess: { mine: 'user' } }, 'ingrid')).toBe(true)
      snap.profiles[0].org_role = 'admin'
      deliver(structuredClone(snap))
      expect(P.seesNewProject({ lead: 'leo' })).toBe(true)
    })

    /* App's toast after a create reads the draft through seesNewProject, so
       a rollback of another write cannot change it. The draft must therefore
       give the answer canSee gives for the project addProject paints. */
    it.each<[string, boolean, (me: string) => Parameters<Planner['seesNewProject']>[0]]>([
      [
        'a share with a team I am not in',
        false,
        (me) => ({ lead: 'leo', access: { [me]: null }, teamAccess: { crew: 'user' } }),
      ],
      ['no entry of mine', true, () => ({ lead: 'leo' })],
      ['my own Viewer entry', true, (me) => ({ lead: 'leo', access: { [me]: 'viewer' } })],
      ['a share with my team', true, () => ({ lead: 'leo', teamAccess: { mine: 'viewer' } })],
    ])('predicts what addProject paints for %s', (_label, expected, toDraft) => {
      const draft = toDraft(me)
      const id = P.addProject({ type: 'meta', key: 'NEW', name: 'New', ...draft })!
      expect(P.seesNewProject(draft)).toBe(expected)
      expect(P.canSee(id)).toBe(expected)
    })
  })
})

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

  it("sends the name's first key, paints nothing, and hands on the key and number the server chose", async () => {
    const onSaved = vi.fn()
    const id = P.addProject({ type: 'meta', key: 'TES', name: 'Test' }, onSaved)!
    // the workspace holds no project, so nothing paints
    expect(P.project(id)).toBeUndefined()
    expect(requests[0]).toMatchObject({ name: 'projects:create', args: { id, key: 'TES' } })
    requests[0].resolve({ id, num: 7, key: 'TES2' })
    await settled()
    // with the organization the create went to, the home one
    await vi.waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({ id, org: P.homeOrg, num: 7, key: 'TES2' }),
    )
    expect(showToast).not.toHaveBeenCalled()
  })

  it('reports success only after the server stores the project', async () => {
    const onSaved = vi.fn()
    const onRefused = vi.fn()
    const id = P.addProject({ type: 'meta', key: 'NEW', name: 'New' }, onSaved, onRefused)!
    // the store holds no project, so the create paints none
    expect(P.project(id)).toBeUndefined()
    expect(onSaved).not.toHaveBeenCalled()

    requests[0].resolve({ id, num: 2, key: 'NEW' })
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

  describe('where a create goes and where it paints', () => {
    /* Me as the home organization's admin with a guest seat in Beacon,
       another organization. Home holds the fixture's sub-project at 0 and
       the top-level projects Alpha at 3 and an archived Old at 8; Beacon
       holds Beacon plan at 40, led by my guest seat, with its sub-project
       Pier at 6. */
    const NOW = '2026-09-14T08:00:00.000Z'
    let beacon: string

    beforeEach(() => {
      beacon = crypto.randomUUID()
      snap.orgs.push({ ...snap.orgs[0], id: beacon, name: 'Beacon', slug: 'beacon' })
      snap.myProfileIds.push('guest-me')
      snap.profiles.push({
        ...snap.profiles[0],
        id: 'guest-me',
        org_id: beacon,
        org_role: 'guest',
      })
      const project = (over: Partial<Snapshot['projects'][number]>) => ({
        ...snap.projects[0],
        type: 'meta' as const,
        parent_id: undefined,
        description: '',
        created_at: NOW,
        ...over,
      })
      snap.projects.push(
        project({ id: 'alpha', key: 'ALP', num: 2, name: 'Alpha', sort_order: 3 }),
        project({ id: 'old', key: 'OLD', num: 3, name: 'Old', sort_order: 8, archived_at: NOW }),
        project({
          id: 'plan-b',
          org_id: beacon,
          key: 'BCN',
          num: 1,
          name: 'Beacon plan',
          sort_order: 40,
          lead_id: 'guest-me',
        }),
        project({
          id: 'pier',
          org_id: beacon,
          type: 'project',
          parent_id: 'plan-b',
          key: 'PIER',
          num: 2,
          name: 'Pier',
          sort_order: 6,
        }),
      )
      deliver(structuredClone(snap))
    })

    it('sends a create with `shown` to that organization, with my seat there as lead, and paints nothing for a parent it does not hold', async () => {
      const onSaved = vi.fn()
      const onRefused = vi.fn()
      const id = P.addProject(
        { type: 'project', key: 'DOCS', name: 'Docs', parent: 'unheld' },
        onSaved,
        onRefused,
        { orgId: beacon },
      )!
      expect(id).toBeTruthy()
      expect(requests.at(-1)).toMatchObject({
        name: 'projects:create',
        args: { org_id: beacon, parent_id: 'unheld', lead_id: 'guest-me', type: 'project' },
      })
      expect(requests.at(-1)?.args).not.toHaveProperty('sort_order')
      expect(P.project(id)).toBeUndefined()
      requests.at(-1)?.resolve({ id, num: 3, key: 'DOCS' })
      await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
      expect(onRefused).not.toHaveBeenCalled()
      expect(P.project(id)).toBeUndefined()
    })

    it('sends nothing and says so for an organization the workspace has no row for', () => {
      const id = P.addProject(
        { type: 'project', key: 'DOCS', name: 'Docs', parent: 'unheld' },
        undefined,
        undefined,
        { orgId: 'no-such-org' },
      )
      expect(id).toBeUndefined()
      expect(requests.filter((r) => r.name === 'projects:create')).toEqual([])
      expect(showToast).toHaveBeenCalledWith(
        "Couldn't create sub-project “Docs”. Its organization hasn't loaded, so reload Qivo and try again.",
        'error',
      )
    })
  })

  describe('canCreateProject', () => {
    /* The signed-in person's own seat, the one the store holds, under each
       setting. The rule over every kind of seat is
       convex/tests/projectCreators.test.ts's (lib/projectCreators.ts). */
    const ask = (setting: Setting) => {
      snap.orgs[0].project_creators = setting
      deliver(structuredClone(snap))
      return P.canCreateProject()
    }

    it('lets an org admin create under every setting', () => {
      for (const setting of [undefined, 'users', 'selected', 'admins'] as const)
        expect(ask(setting)).toBe(true)
      expect(ask('everyone' as unknown as Setting)).toBe(true)
    })

    it('reads my own seat’s role and right', () => {
      snap.profiles[0].org_role = 'user'
      expect(ask('users')).toBe(true)
      expect(ask(undefined)).toBe(true)
      expect(ask('selected')).toBe(false)
      snap.profiles[0].can_create_projects = true
      expect(ask('selected')).toBe(true)
      expect(ask('admins')).toBe(false)
      expect(ask('everyone' as unknown as Setting)).toBe(false)
      snap.profiles[0].org_role = 'viewer'
      expect(ask('users')).toBe(false)
      expect(ask('selected')).toBe(false)
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
      // no entry of mine goes, so the server gives me User (convex/lib/
      // projectGrants.ts), which the project cache reads once it names it
      expect(requests.at(-1)?.args).toMatchObject({ id, lead_id: 'leo', access: {} })
      expect(P.levelOn(id)).toBeNull()
    })

    it('predicts that I lose sight of it once I decline my own entry', () => {
      const none = { [me]: null }
      expect(P.seesNewProject({ lead: 'leo', access: none })).toBe(false)
      expect(P.seesNewProject({ lead: 'leo', access: { ...none, ingrid: 'viewer' } })).toBe(false)
      expect(P.seesNewProject({ lead: 'leo', access: none, teamAccess: { crew: 'user' } })).toBe(
        false,
      )
    })

    it('lets a viewer see one shared with their team, and an org admin only by their own rows', () => {
      // the store judges the signed-in person alone, here as a viewer
      snap.profiles[0].org_role = 'viewer'
      deliver(structuredClone(snap))
      const declined = { [me]: null }
      expect(P.seesNewProject({ lead: 'leo', access: declined })).toBe(false)
      expect(
        P.seesNewProject({ lead: 'leo', access: declined, teamAccess: { mine: 'user' } }),
      ).toBe(true)
      snap.profiles[0].org_role = 'admin'
      deliver(structuredClone(snap))
      // admin status gives no sight of a project someone else leads
      expect(P.seesNewProject({ lead: 'leo', access: { [me]: null } })).toBe(false)
      expect(P.seesNewProject({ lead: 'leo', access: { [me]: 'viewer' } })).toBe(true)
    })

    /* App's toast after a create reads the draft through seesNewProject, so
       a rollback of another write cannot change it. addProject paints
       nothing, so the prediction stands alone until the project cache reads
       the stored project; each draft goes out as it was drawn. */
    it.each<[string, boolean, (me: string) => Parameters<Planner['seesNewProject']>[0]]>([
      [
        'a share with a team I am not in',
        false,
        (me) => ({ lead: 'leo', access: { [me]: null }, teamAccess: { crew: 'user' } }),
      ],
      ['no entry of mine', true, () => ({ lead: 'leo' })],
      ['my own Viewer entry', true, (me) => ({ lead: 'leo', access: { [me]: 'viewer' } })],
      ['a share with my team', true, () => ({ lead: 'leo', teamAccess: { mine: 'viewer' } })],
    ])('predicts whether I see it for %s, and paints nothing', (_label, expected, toDraft) => {
      const draft = toDraft(me)
      const id = P.addProject({ type: 'meta', key: 'NEW', name: 'New', ...draft })!
      expect(P.seesNewProject(draft)).toBe(expected)
      expect(requests.at(-1)?.args).toMatchObject({ id, lead_id: 'leo' })
      expect(P.canSee(id)).toBe(false)
    })
  })
})

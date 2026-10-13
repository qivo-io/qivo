import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture as fixture, type Snapshot } from './plannerFixture.setup'

type Planner = typeof import('./planner')['P']
type Profile = Snapshot['profiles'][number]
type Setting = Snapshot['orgs'][number]['project_creators']

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
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
      if (getFunctionName(ref) === 'snapshot:forMe') deliver = next
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
       org. Every seat but `plain` carries the right, which only counts for an
       active standard user who is a person while the setting is 'selected'. */
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
      const ids = ['plain', 'flagged', 'viewer', 'guest', 'inactive', 'agent']
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
        seat('agent', 'user', { kind: 'agent' }),
      )
    })

    const nobodyElse = {
      plain: false,
      flagged: false,
      viewer: false,
      guest: false,
      inactive: false,
      agent: false,
    }

    it('lets every active standard user who is a person create while the setting is missing or users', () => {
      for (const setting of [undefined, 'users'] as const) {
        expect(ask(setting)).toEqual({ ...nobodyElse, me: true, plain: true, flagged: true })
      }
    })

    it('needs the right under selected users', () => {
      expect(ask('selected')).toEqual({ ...nobodyElse, me: true, flagged: true })
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
})

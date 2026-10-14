import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture as fixture, type Snapshot } from './plannerFixture.setup'

/* Inline settings editors restore their draft when the store reports that
   it wrote nothing. updateLabel returns false for a refusal or an unchanged
   name; updateUser returns false when a client rule refuses the patch. Both
   return true once a change is painted and sent. */

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

type Pending = {
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

const NOW = '2026-09-14T08:00:00.000Z'

describe('settings edits through the client store', () => {
  let P: Planner
  let snap: Snapshot
  let requests: Pending[]
  let showToast: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    showToast = vi.fn()
    vi.stubGlobal('window', { showToast })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snap = fixture()
    const org = snap.orgs[0].id
    const label = (id: string, name: string, orgId = org) => ({
      id,
      org_id: orgId,
      name,
      name_lower: name.toLowerCase(),
      color: '#2563EB',
      created_at: NOW,
    })
    // a guest's cache also holds the host organization's labels
    snap.labels = [
      label('l-bug', 'Bug'),
      label('l-feat', 'Feature'),
      label('l-host', 'Hardware', 'host-org'),
    ]
    const invited = (id: string, name: string, email: string) => ({
      id,
      org_id: org,
      name,
      initials: name.slice(0, 2).toUpperCase(),
      color: '#335577',
      email,
      org_role: 'user' as const,
      active: true,
      kind: 'person' as const,
      created_at: NOW,
    })
    snap.profiles.push(
      invited('u-ana', 'Ana', 'ana@example.test'),
      invited('u-ben', 'Ben', 'ben@example.test'),
      // a viewer still holding the project-creation right from before
      {
        ...invited('u-cat', 'Cat', 'cat@example.test'),
        org_role: 'viewer' as const,
        can_create_projects: true,
      },
    )
    requests = []
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((_ref, _args, next) => {
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

  describe('updateLabel', () => {
    it('refuses a name another label in the organization has', () => {
      expect(P.updateLabel('l-feat', { name: ' bug ' })).toBe(false)
      expect(showToast).toHaveBeenCalledExactlyOnceWith(
        'A label with that name already exists',
        'error',
      )
      expect(requests).toEqual([])
      expect(P.labelById['l-feat'].name).toBe('Feature')
    })

    it('writes a trimmed new name', () => {
      expect(P.updateLabel('l-feat', { name: '  Firmware ' })).toBe(true)
      expect(P.labelById['l-feat'].name).toBe('Firmware')
      expect(requests).toMatchObject([
        { name: 'labels:update', args: { id: 'l-feat', patch: { name: 'Firmware' } } },
      ])
    })

    it('allows a case change of its own name', () => {
      expect(P.updateLabel('l-feat', { name: 'feature' })).toBe(true)
      expect(P.labelById['l-feat'].name).toBe('feature')
    })

    it("ignores another organization's labels", () => {
      expect(P.updateLabel('l-feat', { name: 'Hardware' })).toBe(true)
      expect(showToast).not.toHaveBeenCalled()
    })

    it('reports a name that shortens to the stored one as nothing written', () => {
      const long = 'A'.repeat(40)
      expect(P.updateLabel('l-feat', { name: long })).toBe(true)
      requests = []
      expect(P.updateLabel('l-feat', { name: `${long} and more` })).toBe(false)
      expect(requests).toEqual([])
      expect(P.labelById['l-feat'].name).toBe(long)
    })

    it('restores the stored name when the server refuses', async () => {
      expect(P.updateLabel('l-feat', { name: 'Firmware' })).toBe(true)
      requests[0].reject(
        new ConvexError({ code: 'rule', message: 'a label with that name already exists' }),
      )
      await vi.waitFor(() => expect(P.labelById['l-feat'].name).toBe('Feature'))
      expect(showToast).toHaveBeenCalledExactlyOnceWith(
        'A label with that name already exists — reverted',
        'error',
      )
    })
  })

  describe('updateUser', () => {
    it("refuses an invited seat's email that another seat has", () => {
      expect(P.updateUser('u-ben', { email: 'ANA@example.test' })).toBe(false)
      expect(showToast).toHaveBeenCalledExactlyOnceWith(
        'ana@example.test already has a seat in this organization',
        'error',
      )
      expect(requests).toEqual([])
      expect(P.user('u-ben')?.email).toBe('ben@example.test')
    })

    it('writes a free address, lowercased', () => {
      expect(P.updateUser('u-ben', { email: 'Ben.New@Example.test' })).toBe(true)
      expect(P.user('u-ben')?.email).toBe('ben.new@example.test')
      expect(requests).toMatchObject([
        {
          name: 'profiles:update',
          args: { id: 'u-ben', patch: { email: 'ben.new@example.test' } },
        },
      ])
    })

    it('turns the project-creation right on and off', () => {
      expect(P.user('u-ana')?.canCreateProjects).toBe(false)
      expect(P.updateUser('u-ana', { canCreateProjects: true })).toBe(true)
      expect(P.user('u-ana')?.canCreateProjects).toBe(true)
      expect(P.updateUser('u-ana', { canCreateProjects: false })).toBe(true)
      expect(P.user('u-ana')?.canCreateProjects).toBe(false)
      expect(requests.map((r) => [r.name, r.args.patch])).toEqual([
        ['profiles:update', { can_create_projects: true }],
        ['profiles:update', { can_create_projects: false }],
      ])
    })

    it('clears the right on a role change but keeps it on deactivation or an unchanged role', () => {
      P.updateUser('u-ana', { canCreateProjects: true })
      P.updateUser('u-ana', { active: false })
      expect(P.user('u-ana')?.canCreateProjects).toBe(true)
      // the role select sends the role it shows, changed or not
      P.updateUser('u-ana', { orgRole: 'user', active: true })
      expect(P.user('u-ana')?.canCreateProjects).toBe(true)
      P.updateUser('u-ana', { orgRole: 'viewer', active: true })
      expect(P.user('u-ana')?.canCreateProjects).toBe(false)
      expect(requests.at(-1)?.args.patch).toEqual({ org_role: 'viewer', active: true })
    })

    it('sends deactivation alone to its own door and reactivation through update', () => {
      P.updateUser('u-ana', { active: false })
      expect(P.user('u-ana')?.active).toBe(false)
      P.updateUser('u-ana', { orgRole: 'user', active: true })
      expect(requests.map((r) => [r.name, r.args])).toEqual([
        ['profiles:deactivate', { org_id: snap.orgs[0].id, id: 'u-ana' }],
        [
          'profiles:update',
          { org_id: snap.orgs[0].id, id: 'u-ana', patch: { org_role: 'user', active: true } },
        ],
      ])
    })

    it('sets the right with the standard user role only when the same patch turns it on', () => {
      // a stale right on a viewer never comes back with the role
      P.updateUser('u-cat', { orgRole: 'user', active: true })
      expect(P.user('u-cat')?.canCreateProjects).toBe(false)
      P.updateUser('u-cat', { orgRole: 'viewer', active: true })
      P.updateUser('u-cat', { orgRole: 'user', canCreateProjects: true })
      expect(P.user('u-cat')).toMatchObject({ orgRole: 'user', canCreateProjects: true })
      expect(requests.at(-1)?.args.patch).toEqual({ org_role: 'user', can_create_projects: true })
    })
  })

  describe('setOrg', () => {
    it('writes who can create projects locally and on the wire', () => {
      expect(P.org.projectCreators).toBe('users')
      P.setOrg({ projectCreators: 'selected' })
      expect(P.org.projectCreators).toBe('selected')
      expect(requests).toMatchObject([
        { name: 'orgs:update', args: { patch: { project_creators: 'selected' } } },
      ])
    })

    it('ignores a value that is not a setting', () => {
      P.setOrg({ projectCreators: 'everyone' as unknown as 'users' })
      expect(P.org.projectCreators).toBe('users')
      expect(requests).toEqual([])
    })
  })
})

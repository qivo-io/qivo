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
    snap.teams.push({
      id: 't-crew',
      org_id: org,
      name: 'Crew',
      track_delay_default: false,
      created_at: NOW,
    })
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
        'A label with that name already exists. Change reverted.',
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
      // the role select sends the role it shows, changed or not, and only
      // the fields that differ from the screen go out, each as expected
      P.updateUser('u-ana', { orgRole: 'user', active: true })
      expect(P.user('u-ana')?.canCreateProjects).toBe(true)
      P.updateUser('u-ana', { orgRole: 'viewer', active: true })
      expect(P.user('u-ana')?.canCreateProjects).toBe(false)
      expect(requests.at(-1)?.args.patch).toEqual({ org_role: 'viewer' })
      expect(requests.at(-1)?.args.expected).toEqual({ org_role: 'user' })
    })

    it('sends deactivation alone to its own door and reactivation through update', () => {
      P.updateUser('u-ana', { active: false })
      expect(P.user('u-ana')?.active).toBe(false)
      P.updateUser('u-ana', { orgRole: 'user', active: true })
      // the role is unchanged, so only the reactivation goes out, over the
      // deactivation still on screen
      expect(requests.map((r) => [r.name, r.args])).toEqual([
        ['profiles:deactivate', { org_id: snap.orgs[0].id, id: 'u-ana' }],
        [
          'profiles:update',
          {
            org_id: snap.orgs[0].id,
            id: 'u-ana',
            patch: { active: true },
            expected: { active: false },
          },
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

  /* A settings field sends the value its draft began from as the one seen
     (lib/savedDraft.ts), and hears of a refusal over someone else's change
     with the value the server keeps and who wrote it. */
  describe('the value a settings field began from', () => {
    const latest = () => requests.at(-1) as Pending
    const changed = (record: string, id: string, field: string, by = 'u-ana') =>
      new ConvexError({
        code: 'conflict',
        reason: 'field_changed',
        message: `${field} changed since you read it`,
        changes: [{ record, id, field, by, at: NOW }],
      })
    const settle = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
    }

    it('sends it as expected from setOrg, and the value on screen without it', () => {
      P.setOrg({ name: 'Testbed Robotics' })
      expect(latest().args.expected).toEqual({ name: 'Testbed Labs' })
      P.setOrg({ name: 'Testbed AB' }, undefined, { seen: { name: 'Testbed Labs' } })
      // the screen shows the first save's paint; the field began before it
      expect(latest().args.expected).toEqual({ name: 'Testbed Labs' })
      P.setOrg({ defaultPlannableHours: 32 }, undefined, {
        seen: { default_plannable_hours: 36 },
      })
      expect(latest().args).toMatchObject({
        patch: { default_plannable_hours: 32 },
        expected: { default_plannable_hours: 36 },
      })
    })

    it('sends the stored attachment limit for the default a field showed, and any other as seen', () => {
      // the fixture's organization stores no limit; the field shows 20
      P.setOrg({ maxAttachmentMb: 10 }, undefined, { seen: { max_attachment_mb: 20 } })
      expect(latest().args.expected).toEqual({ max_attachment_mb: null })
      P.setOrg({ maxAttachmentMb: 12 }, undefined, { seen: { max_attachment_mb: 15 } })
      expect(latest().args.expected).toEqual({ max_attachment_mb: 15 })
    })

    it('sends it from updateTeam and updateProject', () => {
      P.updateTeam('t-crew', { name: 'Bench crew' })
      expect(latest().args.expected).toEqual({ name: 'Crew' })
      P.updateTeam('t-crew', { name: 'Field crew' }, { seen: { name: 'Crew' } })
      expect(latest().args.expected).toEqual({ name: 'Crew' })
      const project = snap.projects[0].id
      P.updateProject(project, { name: 'Sensor' })
      expect(latest().args.expected).toEqual({ name: 'Task creation fixture' })
      P.updateProject(project, { description: 'New text' }, { seen: { description: 'Old text' } })
      expect(latest().args.expected).toEqual({ description: 'Old text' })
    })

    it('sends it from both writes of updateUser', () => {
      P.updateUser('u-ana', { name: 'Ana Berg' })
      expect(latest()).toMatchObject({
        name: 'profiles:update',
        args: { expected: { name: 'Ana' } },
      })
      P.updateUser('u-ana', { name: 'Ana B.' }, { seen: { name: 'Ana' } })
      expect(latest().args.expected).toEqual({ name: 'Ana' })
      P.updateUser('u-ana', { plannableHours: 30 })
      expect(latest()).toMatchObject({
        name: 'profiles:setPlannableHours',
        args: { expected: { plannable_hours: null } },
      })
      P.updateUser('u-ana', { plannableHours: 28 }, { seen: { plannable_hours: 32 } })
      expect(latest().args.expected).toEqual({ plannable_hours: 32 })
    })

    it('sends it from setDisplayName and setOrgSlug', () => {
      void P.setDisplayName('Planner Prime')
      expect(latest().args.expected).toMatchObject({ name: 'Planner' })
      void P.setDisplayName('Planner Two', { seen: { name: 'Planner One' } })
      expect(latest().args.expected).toMatchObject({ name: 'Planner One' })
      void P.setOrgSlug('testbed-ab')
      expect(latest().args.expected).toEqual({ slug: 'testbed' })
      void P.setOrgSlug('testbed-cd', { seen: { slug: 'testbed-labs' } })
      expect(latest().args.expected).toEqual({ slug: 'testbed-labs' })
    })

    it('runs keepDraft with the value on screen and its writer, for each kind of record', async () => {
      const kept: unknown[] = []
      const keepDraft = (shown: unknown, by: unknown) => {
        kept.push([shown, by])
        return true
      }
      const org = snap.orgs[0].id
      const project = snap.projects[0].id
      P.setOrg({ name: 'Testbed Robotics' }, undefined, { keepDraft })
      latest().reject(changed('organization', org, 'name'))
      P.updateTeam('t-crew', { name: 'Bench crew' }, { keepDraft })
      latest().reject(changed('team', 't-crew', 'name', 'u-ben'))
      P.updateProject(project, { name: 'Sensor' }, { keepDraft })
      latest().reject(changed('project', project, 'name', P.CURRENT_USER))
      P.updateUser('u-ana', { plannableHours: 30 }, { keepDraft })
      latest().reject(changed('profile', 'u-ana', 'plannable_hours'))
      await settle()
      expect(kept).toEqual([
        ['Testbed Labs', { name: 'Ana' }],
        ['Crew', { name: 'Ben' }],
        ['Task creation fixture', 'you'],
        [undefined, { name: 'Ana' }],
      ])
      expect(showToast.mock.calls.at(-1)?.[0]).toContain('Your text is still in the editor.')
    })

    it('runs keepUnsaved for a painted save that fails with an error, as for a refusal', async () => {
      const calls: string[] = []
      const save = { keepUnsaved: () => calls.push('keepUnsaved') }
      P.setOrg({ name: 'Testbed Robotics' }, undefined, save)
      expect(P.org.name).toBe('Testbed Robotics')
      // a server fault reaches the app as an Error, not a ConvexError
      latest().reject(new Error('[Request ID: 1] Server Error'))
      P.updateUser('u-ana', { plannableHours: 30 }, save)
      latest().reject(new ConvexError({ code: 'rule', message: 'the server said no' }))
      await settle()
      expect(calls).toEqual(['keepUnsaved', 'keepUnsaved'])
      expect(P.org.name).toBe('Testbed Labs')
    })

    it('runs keepDraft for an awaited rename refused over another change, and keepUnsaved for another refusal', async () => {
      const calls: unknown[] = []
      const save = {
        keepDraft: (shown: unknown, by: unknown) => {
          calls.push(['keepDraft', shown, by])
          return true
        },
        keepUnsaved: () => calls.push(['keepUnsaved']),
      }
      const renamed = P.setDisplayName('Planner Prime', save)
      latest().reject(changed('profile', P.CURRENT_USER, 'name', 'u-ana'))
      expect(await renamed).toBe(
        'Not saved. Ana changed the name of Planner. Your text is still in the editor. Save again to replace their version.',
      )
      const moved = P.setOrgSlug('testbed-ab', save)
      latest().reject(new ConvexError({ code: 'conflict', reason: 'slug_taken', message: 'taken' }))
      await moved
      P.setOrg({ name: 'Testbed Robotics' }, undefined, save)
      latest().reject(new ConvexError({ code: 'rule', message: 'the server said no' }))
      await settle()
      expect(calls).toEqual([['keepDraft', 'Planner', { name: 'Ana' }], ['keepUnsaved']])
    })

    it('gives a late answer for the store before an account change to no field', async () => {
      vi.resetModules()
      vi.stubEnv('VITE_APP_MODE', 'demo')
      requests = []
      const store = await import('./planner')
      P = store.P
      await store.initStore()
      const calls: string[] = []
      const save = {
        keepDraft: () => {
          calls.push('keepDraft')
          return true
        },
        keepUnsaved: () => calls.push('keepUnsaved'),
      }
      P.setOrg({ name: 'Testbed Robotics' }, undefined, save)
      const painted = latest()
      const renamed = P.setDisplayName('Planner Prime', save)
      const awaited = latest()
      store.disposeDemoStore()
      painted.reject(changed('organization', snap.orgs[0].id, 'name'))
      awaited.reject(changed('profile', snap.profiles[0].id, 'name'))
      await renamed
      await settle()
      expect(calls).toEqual([])
      vi.unstubAllEnvs()
    })
  })
})

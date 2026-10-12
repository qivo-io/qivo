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
  })
})

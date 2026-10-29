// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* P.fetchArchivedPage, the Archived tasks page's read, over a mocked
   network: what it asks issues.archivedPage for and how it shapes the
   answer. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

describe('P.fetchArchivedPage', () => {
  let store: typeof import('./planner')
  let snapshot: Snapshot

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snapshot = plannerFixture()
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      if (getFunctionName(ref) === 'workspace:whole') receive(structuredClone(snapshot))
      return vi.fn()
    })
    network.mutation.mockResolvedValue(null)
    store = await import('./planner')
    await store.initStore()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** The arguments of each issues.archivedPage call. */
  const asked = () =>
    network.query.mock.calls
      .filter(([ref]) => getFunctionName(ref) === 'issues:archivedPage')
      .map(([, args]) => args)
  const org = () => snapshot.orgs[0].id
  const project = () => snapshot.projects[0].id
  const row = (patch: Record<string, unknown> = {}) => ({
    id: 'archived-1',
    org_id: org(),
    project_id: project(),
    num: 12,
    title: 'Calibrate the drift sensor',
    status: 'review',
    priority: 'high',
    assignee_id: 'assignee',
    reviewer_id: 'reviewer',
    paused: false,
    created_at: '2026-08-01T08:00:00.000Z',
    updated_at: '2026-09-01T08:00:00.000Z',
    archived_at: '2026-10-01T08:00:00.000Z',
    is_group: false,
    place: { project_name: 'Firmware', parent_name: 'Luma Sensor' },
    owner_name: 'Rui Costa',
    can_restore: true,
    ...patch,
  })

  it('asks for one page of a scope and shapes its rows', async () => {
    network.query.mockResolvedValue({ rows: [row()], next_cursor: '3~ab', scanned: 40 })
    const page = await store.P.fetchArchivedPage(
      { org: org(), projectIds: [project()] },
      { cursor: '3~cd', search: 'drift', limit: 25 },
    )
    expect(asked()).toEqual([
      {
        scope: { org_id: org(), project_ids: [project()] },
        cursor: '3~cd',
        search: 'drift',
        limit: 25,
      },
    ])
    expect(page?.nextCursor).toBe('3~ab')
    expect(page?.scanned).toBe(40)
    expect(page?.rows[0]).toMatchObject({
      key: 'QN-12',
      uuid: 'archived-1',
      org: org(),
      project: project(),
      isGroup: false,
      // In Review belongs to the reviewer (lib/review.ts)
      owner: 'reviewer',
      archivedAt: Date.parse('2026-10-01T08:00:00.000Z'),
      // where it lives, who owns it and Restore come from the server
      place: 'Luma Sensor › Firmware',
      ownerName: 'Rui Costa',
      canRestore: true,
    })
    expect(page?.rows[0]).not.toHaveProperty('description')
  })

  it('names a project without a parent alone, and asks for All projects only when told', async () => {
    network.query.mockResolvedValue({
      rows: [row({ place: { project_name: 'Skunkworks', parent_name: null }, owner_name: null })],
      next_cursor: null,
      scanned: 1,
    })
    const page = await store.P.fetchArchivedPage({ org: org(), all: true })
    expect(asked()).toEqual([{ scope: { org_id: org(), all: true } }])
    expect(page?.rows[0]).toMatchObject({ place: 'Skunkworks', ownerName: null })
  })

  it('sends no cursor or search for the first page of the whole list', async () => {
    network.query.mockResolvedValue({ rows: [], next_cursor: null, scanned: 0 })
    await store.P.fetchArchivedPage(
      { org: org(), projectIds: [project()] },
      { cursor: null, search: '' },
    )
    expect(asked()).toEqual([{ scope: { org_id: org(), project_ids: [project()] } }])
  })

  it('answers null when the read fails', async () => {
    network.query.mockRejectedValue(new Error('Too many index ranges read'))
    expect(await store.P.fetchArchivedPage({ org: org(), all: true })).toBeNull()
    expect(asked()).toHaveLength(1)
  })
})

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
    snapshot.issues.push({
      id: 'live-task',
      org_id: snapshot.orgs[0].id,
      project_id: snapshot.projects[0].id,
      num: 3,
      title: 'Active',
      description: '',
      status: 'todo',
      priority: 'medium',
      created_at: '2026-09-01T08:00:00.000Z',
      updated_at: '2026-09-01T08:00:00.000Z',
      paused: false,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
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
    ...patch,
  })

  it('asks for one page and shapes its rows', async () => {
    network.query.mockResolvedValue({ rows: [row()], next_cursor: '1~5~k1~x', scanned: 40 })
    const page = await store.P.fetchArchivedPage(project(), {
      cursor: '1~9~k2~y',
      search: 'drift',
      limit: 100,
    })
    expect(asked()).toEqual([
      {
        project_id: project(),
        cursor: '1~9~k2~y',
        search: 'drift',
        limit: 100,
      },
    ])
    expect(page?.nextCursor).toBe('1~5~k1~x')
    expect(page?.scanned).toBe(40)
    expect(page?.rows[0]).toMatchObject({
      key: 'QN-12',
      uuid: 'archived-1',
      project: project(),
      isGroup: false,
      // In Review belongs to the reviewer (lib/review.ts)
      owner: 'reviewer',
      archivedAt: Date.parse('2026-10-01T08:00:00.000Z'),
    })
    expect(page?.rows[0]).not.toHaveProperty('description')
  })

  it('sends no cursor or search for the first page of the whole list', async () => {
    network.query.mockResolvedValue({ rows: [], next_cursor: null, scanned: 0 })
    await store.P.fetchArchivedPage(project(), { cursor: null, search: '' })
    expect(asked()).toEqual([{ project_id: project() }])
  })

  it('answers null when the read fails, and for either sentinel scope', async () => {
    network.query.mockRejectedValue(new Error('Too many index ranges read'))
    expect(await store.P.fetchArchivedPage(project())).toBeNull()
    expect(asked()).toHaveLength(1)
    expect(await store.P.fetchArchivedPage(store.ALL_SCOPE)).toBeNull()
    expect(await store.P.fetchArchivedPage(store.MINE_SCOPE)).toBeNull()
    expect(asked()).toHaveLength(1)
  })

  it('tells an active task from an archived one', () => {
    expect(store.P.isLiveTask('live-task')).toBe(true)
    expect(store.P.isLiveTask('archived-1')).toBe(false)
  })
})

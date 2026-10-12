import { afterEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture as fixture, type Snapshot } from './plannerFixture.setup'
import { duplicateNameTags, type TaggableProject } from './viewModels'

type Project = TaggableProject

const project = (over: Partial<Project> & Pick<Project, 'id' | 'name' | 'num'>): Project => ({
  org: 'org-a',
  parent: undefined,
  ...over,
})

describe('duplicateNameTags', () => {
  it('tags every project that shares a name, trimmed and case-insensitively', () => {
    const tags = duplicateNameTags([
      project({ id: 'a', name: 'Test', num: 1 }),
      project({ id: 'b', name: ' test ', num: 4 }),
      project({ id: 'c', name: 'Roadmap', num: 2 }),
    ])
    expect(Object.fromEntries(tags)).toEqual({ a: '#1', b: '#4' })
  })

  it('compares case the same way in every browser locale', () => {
    const tags = duplicateNameTags([
      project({ id: 'a', name: 'Istanbul', num: 1 }),
      project({ id: 'b', name: 'istanbul', num: 2 }),
    ])
    expect(Object.fromEntries(tags)).toEqual({ a: '#1', b: '#2' })
  })

  it('tags sub-projects only against siblings under the same parent', () => {
    const tags = duplicateNameTags([
      project({ id: 's1', name: 'Design', num: 5, parent: 'p1' }),
      project({ id: 's2', name: 'Design', num: 6, parent: 'p1' }),
      project({ id: 's3', name: 'Design', num: 7, parent: 'p2' }),
    ])
    expect(Object.fromEntries(tags)).toEqual({ s1: '#5', s2: '#6' })
  })

  it('leaves projects of different organizations and different lists apart', () => {
    const tags = duplicateNameTags(
      [
        project({ id: 'a', name: 'Test', num: 1 }),
        project({ id: 'x', name: 'Test', num: 1, org: 'org-b' }),
      ],
      [project({ id: 'archived', name: 'Test', num: 9 })],
    )
    expect(tags.size).toBe(0)
  })
})

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

describe('project labels in the store', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function boot(names: { name: string; archived?: boolean }[]) {
    vi.resetModules()
    vi.stubGlobal('window', { showToast: vi.fn() })
    const snap: Snapshot = fixture()
    const org = snap.orgs[0].id
    snap.projects = names.map(({ name, archived }, i) => ({
      id: `p${i + 1}`,
      org_id: org,
      type: 'meta',
      key: `K${i + 1}`,
      num: i + 1,
      name,
      description: '',
      sort_order: i,
      track_delay: true,
      created_at: '2026-09-14T08:00:00.000Z',
      ...(archived ? { archived_at: '2026-09-15T08:00:00.000Z' } : {}),
    }))
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
    network.onUpdate.mockImplementation((_ref, _args, next) => {
      next(structuredClone(snap))
      return () => {}
    })
    const store = await import('./planner')
    await store.initStore()
    return store.P
  }

  it('adds the number only where two shown projects share a name', async () => {
    const P = await boot([{ name: 'Test' }, { name: 'Test' }, { name: 'Roadmap' }])
    expect(P.projectLabel({ id: 'p1', name: 'Test' })).toBe('Test #1')
    expect(P.projectLabelOf('p2')).toBe('Test #2')
    expect(P.projectLabelOf('p3')).toBe('Roadmap')
    expect(P.projectTag('p3')).toBeNull()
    expect(P.projectLabelOf('missing')).toBe('')
  })

  it('does not tag an active project because of an archived namesake', async () => {
    const P = await boot([{ name: 'Test' }, { name: 'Test', archived: true }])
    expect(P.projectTag('p1')).toBeNull()
    expect(P.projectTag('p2')).toBeNull()
  })
})

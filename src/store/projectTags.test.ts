import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import { as, newT, plantSeat, uuid, withOrg, workspaceOf } from '../../convex/tests/helpers.setup'
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
    // a Turkish locale lowers "I" to a dotless "ı"
    const turkish = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (
      this: string,
    ) {
      return this.replace(/I/g, 'ı').toLowerCase()
    })
    const tags = duplicateNameTags([
      project({ id: 'a', name: 'Istanbul', num: 1 }),
      project({ id: 'b', name: 'istanbul', num: 2 }),
    ])
    turkish.mockRestore()
    expect(Object.fromEntries(tags)).toEqual({ a: '#1', b: '#2' })
  })

  it('treats names that differ only in inner spacing as the same', () => {
    const tags = duplicateNameTags([
      project({ id: 'a', name: 'Release QA', num: 1 }),
      project({ id: 'b', name: 'Release  QA', num: 2 }),
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

describe('project labels in the store', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // a fresh store whose first delivery is `snap`
  async function start(snap: Snapshot) {
    vi.resetModules()
    vi.stubGlobal('window', { showToast: vi.fn() })
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

  // parent is the 1-based number of an earlier entry, making this a sub-project
  async function boot(names: { name: string; archived?: boolean; parent?: number }[]) {
    const snap: Snapshot = fixture()
    const org = snap.orgs[0].id
    snap.projects = names.map(({ name, archived, parent }, i) => ({
      id: `p${i + 1}`,
      org_id: org,
      type: parent ? 'project' : 'meta',
      ...(parent ? { parent_id: `p${parent}` } : {}),
      key: `K${i + 1}`,
      num: i + 1,
      name,
      description: '',
      sort_order: i,
      track_delay: true,
      created_at: '2026-09-14T08:00:00.000Z',
      ...(archived ? { archived_at: '2026-09-15T08:00:00.000Z' } : {}),
    }))
    return start(snap)
  }

  it('adds the number only where two shown projects share a name', async () => {
    const P = await boot([{ name: 'Test' }, { name: 'Test' }, { name: 'Roadmap' }])
    expect(P.projectLabel({ id: 'p1', name: 'Test' })).toBe('Test #1')
    expect(P.projectLabelOf('p2')).toBe('Test #2')
    expect(P.projectLabelOf('p3')).toBe('Roadmap')
    expect(P.projectTag('p3')).toBeNull()
    expect(P.projectLabelOf('missing')).toBe('')
  })

  it('names a sub-project after its project, with every shared name numbered', async () => {
    const P = await boot([
      { name: 'Test' },
      { name: 'Test' },
      { name: 'Design', parent: 1 },
      { name: 'Design', parent: 1 },
      { name: 'Launch', parent: 2 },
    ])
    const sub = P.projectPlace('p3')
    expect(sub?.owner?.id).toBe('p1')
    expect(sub && P.placeLabel(sub)).toBe('Test #1, Design #3')
    const unique = P.projectPlace('p5')
    expect(unique && P.placeLabel(unique)).toBe('Test #2, Launch')
    // without the owner, or for a top-level project, the project stands alone
    const alone = P.projectPlace('p4', false)
    expect(alone?.owner).toBeNull()
    expect(alone && P.placeLabel(alone)).toBe('Design #4')
    expect(P.projectPlace('p1')?.owner).toBeNull()
    expect(P.projectPlace('missing')).toBeNull()
  })

  it('does not tag an active project because of an archived namesake', async () => {
    const P = await boot([{ name: 'Test' }, { name: 'Test', archived: true }])
    expect(P.projectTag('p1')).toBeNull()
    expect(P.projectTag('p2')).toBeNull()
  })

  /* Duplicates are judged per viewer, from the projects the server lets that
     person see. This runs the real project creation and snapshot query, so a
     server change that starts sending other people's projects, or a client
     change that compares names across the whole organization, fails here. */
  it('numbers a shared name only for someone who can see both projects', async () => {
    const t = newT()
    const f = await withOrg(t)
    const colleague = await plantSeat(t, { org_id: f.org.id, auth_user_id: `auth_${uuid()}` })
    // each member creates a "Test" that only they lead and nobody is granted
    const create = (by: Doc<'profiles'>) =>
      as(t, by).mutation(api.projects.create, {
        org_id: f.org.id,
        id: uuid(),
        type: 'meta',
        key: 'TEST',
        name: 'Test',
        sort_order: 9,
      })
    const mine = await create(f.user)
    const theirs = await create(colleague)
    const snapshotOf = async (profile: Doc<'profiles'>) => {
      const snap = await workspaceOf(as(t, profile))
      if (snap === null) throw new Error(`no snapshot for ${profile.name}`)
      return snap
    }
    const forUser = await snapshotOf(f.user)
    const forColleague = await snapshotOf(colleague)
    const forAdmin = await snapshotOf(f.admin)

    let P = await start(forUser)
    expect(P.project(theirs.id)).toBeUndefined()
    expect(P.projectLabelOf(mine.id)).toBe('Test')

    P = await start(forColleague)
    expect(P.project(mine.id)).toBeUndefined()
    expect(P.projectLabelOf(theirs.id)).toBe('Test')

    // an organization admin sees both, so both carry their numbers
    P = await start(forAdmin)
    expect(P.projectLabelOf(mine.id)).toBe(`Test #${mine.num}`)
    expect(P.projectLabelOf(theirs.id)).toBe(`Test #${theirs.num}`)
  })
})

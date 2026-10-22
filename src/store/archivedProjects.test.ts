import { getFunctionName } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture as fixture, type Snapshot } from './plannerFixture.setup'

type Planner = typeof import('./planner')['P']
type ProjectRow = Snapshot['projects'][number]
type NewRow = Partial<ProjectRow> & Pick<ProjectRow, 'name'>

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

const ARCHIVED = '2026-09-10T08:00:00.000Z'

/* Settings › Archived projects reads P.archivedProjects: rows are the entries
   without an archived parent, and a project's chips are its archived
   sub-projects in the same list. Its Delete moves a project to Deleted items,
   and a project restored from there comes back to this list. */
describe('archived projects for a member of one sub-project', () => {
  let P: Planner
  // what the server holds now; deliver() sends it as the next snapshot
  let server: Snapshot
  let deliver: () => void
  let requests: { name: string; args: Record<string, unknown> }[]

  async function boot(edit: (me: string, project: (over: NewRow) => ProjectRow) => void) {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    requests = []
    server = fixture()
    const me = server.myProfileIds[0]
    server.profiles[0].org_role = 'user'
    server.profiles.push({ ...server.profiles[0], id: 'lead', auth_user_id: 'other', name: 'Lead' })
    server.projects = []
    edit(me, (over) => row(server, over))
    network.query.mockResolvedValue(null)
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name !== 'identity:claimMySeats') requests.push({ name, args })
      return Promise.resolve(null)
    })
    network.onUpdate.mockImplementation((ref, _args, next) => {
      if (getFunctionName(ref) === 'workspace:whole') deliver = () => next(structuredClone(server))
      next(structuredClone(server))
      return () => {}
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
  }

  function row(snap: Snapshot, over: NewRow): ProjectRow {
    const project: ProjectRow = {
      id: crypto.randomUUID(),
      org_id: snap.orgs[0].id,
      type: 'meta',
      key: over.name.slice(0, 3).toUpperCase(),
      num: snap.projects.length + 1,
      description: '',
      sort_order: snap.projects.length,
      track_delay: true,
      created_at: ARCHIVED,
      archived_at: ARCHIVED,
      lead_id: 'lead',
      ...over,
    }
    snap.projects.push(project)
    return project
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const listed = () =>
    P.archivedProjects.map((p) => ({ name: p.name, row: !p.parentArchived, manage: p.manage }))

  it('lists the archived parent as a read-only row holding that sub-project', async () => {
    await boot((me, project) => {
      // led by someone else; this member leads only Alpha
      const parent = project({ name: 'Test' })
      project({ name: 'Alpha', type: 'project', parent_id: parent.id, lead_id: me })
    })
    expect(listed()).toEqual([
      { name: 'Alpha', row: false, manage: true },
      { name: 'Test', row: true, manage: false },
    ])
  })

  it('keeps out an archived project without any access', async () => {
    await boot((_me, project) => {
      project({ name: 'Hidden' })
    })
    expect(listed()).toEqual([])
  })

  it('moves an archived project with its sub-projects to Deleted items, and lists it again once restored', async () => {
    let parent: ProjectRow | undefined
    await boot((me, project) => {
      parent = project({ name: 'Test', lead_id: me })
      project({ name: 'Alpha', type: 'project', parent_id: parent.id, lead_id: me })
    })
    const id = parent?.id ?? ''
    const before = listed()
    expect(before).toEqual([
      { name: 'Alpha', row: false, manage: true },
      { name: 'Test', row: true, manage: true },
    ])

    expect(await P.removeProject(id, '  Wrapped up  ')).toBe(true)
    expect(requests).toEqual([
      {
        name: 'projects:deleteDeep',
        args: expect.objectContaining({ id, reason: 'Wrapped up' }),
      },
    ])
    expect(listed()).toEqual([])
    // the server moved both rows to Deleted items
    const moved = server.projects
    server.projects = []
    deliver()
    expect(listed()).toEqual([])

    // a restore brings them back archived, as they were deleted
    server.projects = moved
    deliver()
    expect(listed()).toEqual(before)
  })

  it('keeps an archived project listed when the server refuses to delete it', async () => {
    let parent: ProjectRow | undefined
    await boot((me, project) => {
      parent = project({ name: 'Test', lead_id: me })
      project({ name: 'Alpha', type: 'project', parent_id: parent.id, lead_id: me })
    })
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'projects:deleteDeep'
        ? Promise.reject(new Error('requires the project lead'))
        : Promise.resolve(null),
    )
    expect(await P.removeProject(parent?.id ?? '')).toBe(false)
    expect(window.showToast).toHaveBeenCalled()
    expect(listed().map((p) => p.name)).toEqual(['Alpha', 'Test'])
  })
})

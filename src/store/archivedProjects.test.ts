import { afterEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture as fixture, type Snapshot } from './plannerFixture.setup'

type Planner = typeof import('./planner')['P']
type ProjectRow = Snapshot['projects'][number]
type NewRow = Partial<ProjectRow> & Pick<ProjectRow, 'name'>

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
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
   sub-projects in the same list. */
describe('archived projects for a member of one sub-project', () => {
  let P: Planner

  async function boot(edit: (me: string, project: (over: NewRow) => ProjectRow) => void) {
    vi.resetModules()
    vi.stubGlobal('window', { showToast: vi.fn() })
    const snap = fixture()
    const me = snap.myProfileIds[0]
    snap.profiles[0].org_role = 'user'
    snap.profiles.push({ ...snap.profiles[0], id: 'lead', auth_user_id: 'other', name: 'Lead' })
    snap.projects = []
    edit(me, (over) => row(snap, over))
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
    network.onUpdate.mockImplementation((_ref, _args, next) => {
      next(structuredClone(snap))
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
})

import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture as fixture, type Snapshot, underProgram } from './plannerFixture.setup'

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

describe('task creation through the client store', () => {
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
    // the project under a top-level project, as every writer stores one
    // that holds tasks, so the navigation reads name it
    snap = underProgram(fixture())
    requests = []
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((ref, _args, next) => {
      if (getFunctionName(ref) !== 'workspace:whole') return () => {}
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
    // the views name the projects they show; this suite names them all
    await (await import('./oracleScope.setup')).nameProjects(store.P, snap)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('sends no create into a project the project cache has not answered, and says why', async () => {
    // a sub-project the New task picker only seeded, which no read answered
    P.seedProjects([
      {
        id: 'seeded-only',
        org_id: snap.orgs[0].id,
        name: 'Seeded',
        num: 77,
        parent_id: snap.projects[0].parent_id ?? null,
      },
    ])
    expect(P.projectState('seeded-only')).toBe('loading')
    expect(P.addIssue({ project: 'seeded-only', title: 'Too early' })).toBeNull()
    expect(requests).toEqual([])
    expect(showToast).toHaveBeenCalledWith('Loading this project…', 'error')
    // an answered one creates
    expect(P.addIssue({ project: snap.projects[0].id, title: 'In time' })).not.toBeNull()
    expect(requests.map((r) => r.name)).toEqual(['issues:create'])
  })
})

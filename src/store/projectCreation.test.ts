import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture as fixture, type Snapshot } from './plannerFixture.setup'

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

describe('project creation through the client store', () => {
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

  const settled = () => vi.waitFor(() => expect(P.roadmapUndo.busy).toBe(false))

  it('adopts the key the server chose in place of a taken preview', async () => {
    const id = P.addProject({ type: 'meta', key: 'TES', name: 'Test' })!
    expect(P.project(id)?.key).toBe('TES')
    expect(requests[0]).toMatchObject({ name: 'projects:create', args: { id, key: 'TES' } })

    requests[0].resolve({ id, num: snap.orgs[0].next_project_num + 1, key: 'TES2' })
    await settled()
    expect(P.project(id)?.key).toBe('TES2')
    expect(showToast).not.toHaveBeenCalled()
  })

  it('reports success only after the server stores the project', async () => {
    const onSaved = vi.fn()
    const onRefused = vi.fn()
    const id = P.addProject({ type: 'meta', key: 'NEW', name: 'New' }, onSaved, onRefused)!
    expect(P.project(id)?.name).toBe('New')
    expect(onSaved).not.toHaveBeenCalled()

    requests[0].resolve({ id, num: snap.orgs[0].next_project_num + 1, key: 'NEW' })
    await settled()
    expect(onSaved).toHaveBeenCalledOnce()
    expect(onRefused).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })

  it.each([
    ['bad_request', 'meta', "Couldn't create project “Test”"],
    ['not_found', 'meta', "Couldn't create project “Test”"],
    ['forbidden', 'meta', 'No permission to create project “Test”'],
    ['rule', 'project', "Couldn't create sub-project “Test”. Parent project not found."],
  ] as const)('a %s refusal of a %s names it and removes it', async (code, type, message) => {
    const onSaved = vi.fn()
    const onRefused = vi.fn()
    const parent =
      type === 'project' ? P.addProject({ type: 'meta', key: 'PAR', name: 'Parent' }) : undefined
    const id = P.addProject({ type, key: 'TES', name: 'Test', parent }, onSaved, onRefused)!
    const request = requests.find((r) => r.args.id === id)!
    request.reject(
      new ConvexError({ code, message: code === 'rule' ? 'parent project not found' : 'refused' }),
    )
    await vi.waitFor(() => expect(onRefused).toHaveBeenCalledOnce())
    expect(onSaved).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledExactlyOnceWith(message, 'error')
    expect(P.project(id)).toBeUndefined()
  })

  it('keeps a free preview key unchanged', async () => {
    const id = P.addProject({ type: 'meta', key: 'NEW', name: 'New' })!
    requests[0].resolve({ id, num: snap.orgs[0].next_project_num + 1, key: 'NEW' })
    await settled()
    expect(P.project(id)?.key).toBe('NEW')
  })
})

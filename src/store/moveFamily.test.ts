import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'
import { PROJECT_CACHE } from './projectCache'
import { projectNavStandIn } from './projectNavStandIn.setup'

type Planner = typeof import('./planner')['P']

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
// the live double of the store that loaded last, whose project cache reads
// a case can leave to the client's onUpdate
const double = vi.hoisted(() => ({
  live: null as null | { forceProjectNav(force: 'client' | null): void },
}))
vi.mock('../lib/convex', async () => {
  double.live = (await import('./guard/liveDouble.setup')).liveOver(network)
  return { convex: network, live: double.live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const NOW = '2026-09-14T08:00:00.000Z'
const DEFAULT_CHUNK = PROJECT_CACHE.chunk

/* A subtask stays in its parent's top-level project. WEB holds the FE and BE
 * sub-projects, HW holds FW. A move to another top-level project carries the
 * subtasks along and leaves the task's parent. */
describe('moving a task with its family', () => {
  let P: Planner
  let requests: { name: string; args: Record<string, unknown> }[]
  let ids: Record<'web' | 'fe' | 'be' | 'hw' | 'fw', string>

  /** Loads the store on the world above, which `change` may change. With
      `byIds`, the project cache reads one project a read and the client's
      onUpdate answers them, through `byIds` (which may fail them), and the
      suite names nothing itself. */
  async function load(
    change?: (snap: Snapshot) => void,
    byIds?: (ids: string[], answer: () => void, fail: () => void) => void,
  ) {
    const snap: Snapshot = plannerFixture()
    const org = snap.orgs[0].id
    const base = snap.projects[0]
    const project = (key: string, num: number, extra = {}) => ({
      ...base,
      id: crypto.randomUUID(),
      key,
      num,
      name: key,
      ...extra,
    })
    const web = project('WEB', 1, { type: 'meta' as const })
    const hw = project('HW', 2, { type: 'meta' as const })
    const fe = project('FE', 3, { parent_id: web.id })
    const be = project('BE', 4, { parent_id: web.id })
    const fw = project('FW', 5, { parent_id: hw.id })
    snap.projects = [web, hw, fe, be, fw]
    ids = { web: web.id, fe: fe.id, be: be.id, hw: hw.id, fw: fw.id }
    snap.profiles.push({
      id: 'webOnly',
      org_id: org,
      name: 'Web only',
      initials: 'WO',
      color: '#335577',
      org_role: 'user',
      active: true,
      kind: 'person',
      created_at: NOW,
    })
    snap.access.push({ project_id: web.id, profile_id: 'webOnly', level: 'user' })
    const task = (id: string, num: number, project_id: string, extra = {}) => ({
      id,
      org_id: org,
      project_id,
      num,
      title: id,
      description: '',
      status: 'todo' as const,
      priority: 'low' as const,
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
      ...extra,
    })
    snap.issues.push(
      task('epic', 1, fe.id),
      task('feature', 2, fe.id, { parent_id: 'epic' }),
      task('api', 3, be.id, { parent_id: 'feature' }),
      task('lone', 4, fe.id),
    )
    change?.(snap)
    network.onUpdate.mockImplementation((ref, args, next, fail) => {
      const name = getFunctionName(ref)
      if (name === 'workspace:whole') next(structuredClone(snap))
      if (name === 'projectNav:byIds' && byIds) {
        const asked = (args as { ids: string[] }).ids
        byIds(
          asked,
          () => next(projectNavStandIn(snap, 'projectNav:byIds', { ids: asked })),
          () => fail?.(new Error('the byIds read failed')),
        )
      }
      return () => {}
    })
    const store = await import('./planner')
    P = store.P
    // the double outlives the store, so each load says where its reads go
    if (byIds) (await import('./projectCache')).PROJECT_CACHE.chunk = 1
    double.live?.forceProjectNav(byIds ? 'client' : null)
    await store.initStore()
    // the views name the projects they show; this suite names them all
    if (!byIds) await (await import('./oracleScope.setup')).nameProjects(store.P, snap)
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    requests = []
    network.query.mockResolvedValue(null)
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      requests.push({ name, args })
      return new Promise(() => {})
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    ;(await import('./projectCache')).PROJECT_CACHE.chunk = DEFAULT_CHUNK
  })

  const vm = (uuid: string) => P.issues.find((it) => it.uuid === uuid)!
  const moves = () => requests.filter((r) => r.name === 'issues:move').map((r) => r.args)

  it("sends no move while the project cache has no facts of the task's sub-project, and no detach once it has them for a move within the project", async () => {
    // FE's read fails until the case lets it answer; every other project
    // answers, BE among them
    let feFails = true
    await load(undefined, (asked, answer, fail) => {
      if (asked.includes(ids.fe) && feFails) fail()
      else answer()
    })
    P.nameProjects('test', [ids.be])
    await vi.waitFor(() => expect(P.projectState(ids.fe)).toBe('failed'))
    await vi.waitFor(() => expect(P.canWrite(ids.be)).toBe(true))
    // FE has no facts, so its top-level project is unknown, never another
    expect(P.project(ids.fe)).toBeUndefined()
    expect(P.moveWaits(vm('feature'))).toMatchObject({ project: ids.fe, state: 'failed' })
    // must fail for a move that reads an unknown project as another
    // top-level project and detaches the subtask from its parent
    expect(P.moveIssue(vm('feature').id, ids.be)).toBeNull()
    expect(moves()).toEqual([])
    // FE answers on a fresh read, and the move within WEB keeps the parent
    feFails = false
    P.retryProjects('held tasks')
    await vi.waitFor(() => expect(P.projectState(ids.fe)).toBe('ok'))
    expect(P.moveWaits(vm('feature'))).toBeNull()
    expect(P.moveIssue(vm('feature').id, ids.be)).toBe(vm('feature').id)
    expect(moves()).toEqual([expect.not.objectContaining({ detach_parent: true })])
    expect(moves()[0]).toMatchObject({ id: 'feature', project_id: ids.be })
  })

  it('carries the subtasks to another top-level project and keeps the links', async () => {
    await load()
    expect(P.moveFamily(vm('epic'), ids.fw)).toMatchObject({
      leavesParent: false,
      carriesSubtasks: true,
    })
    P.moveIssue(vm('epic').id, ids.fw)
    for (const uuid of ['epic', 'feature', 'api']) expect(vm(uuid).project).toBe(ids.fw)
    expect(vm('api').parent).toBe(vm('feature').id)
    expect(moves()).toEqual([expect.not.objectContaining({ detach_parent: expect.anything() })])
  })

  it('keeps the remaining-hours measurement of the task and each subtask it carries', async () => {
    const measured = { remaining_hours: 4, remaining_set_at: '2026-08-03T08:00:00.000Z' }
    // the leaves hold the hours, as a group holds none
    await load((snap) => {
      for (const row of snap.issues)
        if (row.id === 'api' || row.id === 'lone') Object.assign(row, measured)
      const api = snap.issues.find((row) => row.id === 'api')
      Object.assign(api!, { status: 'review', review_at: measured.remaining_set_at })
    })
    const week = vm('lone').remainingSet!
    const handed = vm('api').reviewAt!
    P.moveIssue(vm('epic').id, ids.fw)
    expect(vm('api').project).toBe(ids.fw)
    expect(vm('api').remainingSet).toBe(week)
    // the same move restarts the review hand-off it carries
    expect(vm('api').reviewAt).toBeGreaterThan(handed)
    // a task without hours gains no measurement
    expect(vm('epic').remainingSet).toBeNull()
    P.moveIssue(vm('lone').id, ids.be)
    expect(vm('lone').remainingSet).toBe(week)
  })

  it('moves only the task within its top-level project', async () => {
    await load()
    expect(P.moveFamily(vm('feature'), ids.be)).toEqual({
      leavesParent: false,
      carriesSubtasks: false,
      carried: [],
    })
    P.moveIssue(vm('feature').id, ids.be)
    expect(vm('feature')).toMatchObject({ project: ids.be, parent: vm('epic').id })
    expect(vm('epic').project).toBe(ids.fe)
    expect(moves()[0]).not.toHaveProperty('detach_parent')
  })

  it('leaves the parent when a subtask moves to another top-level project', async () => {
    await load()
    expect(P.moveFamily(vm('feature'), ids.fw)).toMatchObject({
      leavesParent: true,
      carriesSubtasks: true,
    })
    P.moveIssue(vm('feature').id, ids.fw)
    expect(vm('feature')).toMatchObject({ project: ids.fw, parent: null })
    expect(vm('api').project).toBe(ids.fw)
    expect(vm('epic').project).toBe(ids.fe)
    expect(moves()).toEqual([expect.objectContaining({ detach_parent: true })])
  })

  it("treats a hidden parent as one in the task's own top-level project", async () => {
    await load((snap) => {
      const lone = snap.issues.find((i) => i.id === 'lone')!
      lone.has_hidden_parent = true
    })
    expect(P.moveFamily(vm('lone'), ids.be).leavesParent).toBe(false)
    expect(P.moveFamily(vm('lone'), ids.fw).leavesParent).toBe(true)
    P.moveIssue(vm('lone').id, ids.fw)
    expect(vm('lone').hasHiddenParent).toBe(false)
    expect(moves()).toEqual([expect.objectContaining({ detach_parent: true })])
  })

  it('sends a move whose carried subtask is held by someone the store does not hold, for the server to check', async () => {
    await load((snap) => {
      const api = snap.issues.find((i) => i.id === 'api')!
      api.assignee_id = 'webOnly'
    })
    // the server refuses with its sentence where webOnly cannot edit the
    // destination (convex/model/issues.ts MOVE_SUBTREE_HOLDER_RULE); the
    // store judges no one but the signed-in person
    expect(P.user('webOnly')).toBeUndefined()
    P.moveIssue(vm('epic').id, ids.fw)
    expect(moves()).toHaveLength(1)
  })
})

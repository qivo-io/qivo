import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

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

const NOW = '2026-09-14T08:00:00.000Z'

/* A subtask stays in its parent's top-level project. WEB holds the FE and BE
 * sub-projects, HW holds FW. A move to another top-level project carries the
 * subtasks along and leaves the task's parent. */
describe('moving a task with its family', () => {
  let P: Planner
  let requests: { name: string; args: Record<string, unknown> }[]
  let ids: Record<'web' | 'fe' | 'be' | 'hw' | 'fw', string>

  async function load(change?: (snap: Snapshot) => void) {
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
    network.onUpdate.mockImplementation((ref, _args, next) => {
      if (getFunctionName(ref) === 'snapshot:forMe') next(structuredClone(snap))
      return () => {}
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
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

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const vm = (uuid: string) => P.issues.find((it) => it.uuid === uuid)!
  const moves = () => requests.filter((r) => r.name === 'issues:move').map((r) => r.args)

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

  it('restarts the remaining-hours measurement of the task and each subtask it carries', async () => {
    const measured = { remaining_hours: 4, remaining_set_at: '2026-08-03T08:00:00.000Z' }
    // the leaves hold the hours, as a group holds none
    await load((snap) => {
      for (const row of snap.issues)
        if (row.id === 'api' || row.id === 'lone') Object.assign(row, measured)
    })
    const week = vm('lone').remainingSet!
    P.moveIssue(vm('epic').id, ids.fw)
    expect(vm('api').remainingSet).toBeGreaterThan(week)
    expect(vm('lone').remainingSet).toBe(week)
    // a task without hours gains no measurement
    expect(vm('epic').remainingSet).toBeNull()
    // naming the current sub-project changes nothing
    expect(P.moveIssue(vm('lone').id, ids.fe)).toBeNull()
    expect(vm('lone').remainingSet).toBe(week)
    P.moveIssue(vm('lone').id, ids.be)
    expect(vm('lone').remainingSet).toBeGreaterThan(week)
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

  it('needs edit access for the people on a carried subtask', async () => {
    await load((snap) => {
      const api = snap.issues.find((i) => i.id === 'api')!
      api.assignee_id = 'webOnly'
    })
    const blockers = P.moveBlockers(vm('epic'), ids.fw)
    expect(blockers.map((b) => [b.uid, b.task.uuid, b.edit])).toEqual([['webOnly', 'api', true]])
    // within the top-level project the subtask stays, and Web only sees BE
    expect(P.moveBlockers(vm('epic'), ids.be)).toEqual([])
  })
})

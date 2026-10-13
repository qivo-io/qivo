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

/* A group's dates are calculated from its visible scheduled leaves; its own
 * stored dates stay dormant in the row and are never written by the client. */
describe('calculated group dates in the client store', () => {
  let P: Planner
  let snap: Snapshot
  let requests: { name: string; args: Record<string, unknown> }[]

  // group (stored 2026-12-07..12-14, dormant)
  //   nested group (stored 2026-01-05..2027-06-07, dormant)
  //     a  2026-09-14..09-21, todo, 8h
  //     b  2026-10-05..10-12, done, 5h
  //   c  2026-09-28, no end, todo, 3h
  //   u  unplanned, todo
  const task = (id: string, num: number, extra: Partial<Snapshot['issues'][number]> = {}) => ({
    id,
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
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

  async function load(change?: (s: Snapshot) => void) {
    snap = plannerFixture()
    snap.issues.push(
      task('group', 1, { start_week: '2026-12-07', end_week: '2026-12-14' }),
      task('nested', 2, {
        parent_id: 'group',
        start_week: '2026-01-05',
        end_week: '2027-06-07',
      }),
      task('a', 3, {
        parent_id: 'nested',
        start_week: '2026-09-14',
        end_week: '2026-09-21',
        remaining_hours: 8,
      }),
      task('b', 4, {
        parent_id: 'nested',
        status: 'done',
        start_week: '2026-10-05',
        end_week: '2026-10-12',
        remaining_hours: 5,
      }),
      task('c', 5, { parent_id: 'group', start_week: '2026-09-28', remaining_hours: 3 }),
      task('u', 6, { parent_id: 'group' }),
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
      // writes stay pending: the optimistic paint is what these tests read
      return new Promise(() => {})
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const vm = (uuid: string) => P.issues.find((it) => it.uuid === uuid)!
  const week = (iso: string) => P.isoToWeek(iso)

  it('spans the visible scheduled leaves and shrinks when a child moves inward', async () => {
    await load()
    // nested stored dates are ignored; the Done leaf b still counts
    expect(vm('nested')).toMatchObject({ start: week('2026-09-14'), end: week('2026-10-12') })
    expect(vm('group')).toMatchObject({ start: week('2026-09-14'), end: week('2026-10-12') })

    P.updateIssue(vm('b').id, { start: week('2026-09-21'), end: week('2026-09-21') })
    P.updateIssue(vm('a').id, { start: week('2026-09-21'), end: week('2026-09-21') })
    expect(vm('nested')).toMatchObject({ start: week('2026-09-21'), end: week('2026-09-21') })
    // c has no end and counts as its start week
    expect(vm('group')).toMatchObject({ start: week('2026-09-21'), end: week('2026-09-28') })
  })

  it('has no dates when no visible leaf is scheduled', async () => {
    await load((s) => {
      for (const row of s.issues) {
        if (row.id === 'group' || row.id === 'nested') continue
        delete row.start_week
        delete row.end_week
      }
    })
    expect(vm('group')).toMatchObject({ start: null, end: null })
    expect(vm('nested')).toMatchObject({ start: null, end: null })
  })

  it('does not widen for hidden subtasks and limits the delay verdict to late', async () => {
    // the whole visible plan lies in the past, so a complete view would call
    // an unfinished group behind its plan
    const past = (s: Snapshot) => {
      for (const row of s.issues) {
        if (row.id === 'a') Object.assign(row, { start_week: '2020-01-06', end_week: '2020-01-13' })
        if (row.id === 'b') Object.assign(row, { start_week: '2020-01-20', end_week: '2020-01-27' })
        if (row.id === 'c') row.start_week = '2020-01-13'
      }
      const group = s.issues.find((row) => row.id === 'group')!
      group.has_hidden_subtasks = true
      return group
    }
    await load((s) => {
      past(s)
    })
    expect(vm('group')).toMatchObject({ start: week('2020-01-06'), end: week('2020-01-27') })
    expect(P.delayOf(vm('nested'))?.status).toBe('behind')
    expect(P.delayOf(vm('group'))).toBeNull()

    vi.resetModules()
    await load((s) => {
      past(s).due_date = '2020-02-03'
    })
    expect(P.delayOf(vm('group'))?.status).toBe('late')
  })

  it('sends no date write for a group and leaves its stored dates dormant', async () => {
    await load()
    const span = { start: vm('group').start, end: vm('group').end }
    P.updateIssue(vm('group').id, { start: week('2027-01-04'), end: week('2027-01-11') })
    P.updateIssue(vm('group').id, { start: null, end: null })
    expect(requests).toEqual([])
    expect(vm('group')).toMatchObject(span)

    P.updateIssue(vm('group').id, { title: 'Renamed group', end: week('2027-01-11') })
    expect(requests).toEqual([
      {
        name: 'issues:update',
        args: expect.objectContaining({ patch: { title: 'Renamed group' } }),
      },
    ])

    // once its last subtasks leave, the stored dates apply again
    for (const id of ['nested', 'c', 'u']) P.updateIssue(vm(id).id, { parent: null })
    expect(P.isGroup(vm('group'))).toBe(false)
    expect(vm('group')).toMatchObject({ start: week('2026-12-07'), end: week('2026-12-14') })
  })

  it('writes only the child when a subtask moves the group span', async () => {
    await load()
    P.updateIssue(vm('a').id, { start: week('2026-08-31'), end: week('2026-09-07') })
    expect(requests).toEqual([
      {
        name: 'issues:update',
        args: expect.objectContaining({
          id: 'a',
          patch: { start_week: '2026-08-31', end_week: '2026-09-07' },
        }),
      },
    ])
    expect(vm('group')).toMatchObject({ start: week('2026-08-31'), end: week('2026-10-12') })
    expect(window.showToast).not.toHaveBeenCalled()
  })

  it('sums remaining hours over unfinished leaves only', async () => {
    await load()
    // a 8h + c 3h; Done b's 5h is no remaining work
    expect(P.remainingOf(vm('group'))).toBe(11)
    expect(P.remainingOf(vm('nested'))).toBe(8)
    P.updateIssue(vm('a').id, { status: 'done' })
    expect(P.remainingOf(vm('nested'))).toBeUndefined()
    expect(P.remainingOf(vm('group'))).toBe(3)
    // a Done leaf still answers with its own hours
    expect(P.remainingOf(vm('b'))).toBe(5)
  })

  it("ignores a group's own pause, which is dormant like its status", async () => {
    await load((s) => {
      for (const row of s.issues) if (row.id === 'group' || row.id === 'a') row.paused = true
    })
    expect(vm('group').paused).toBe(true)
    expect(P.isPaused(vm('group'))).toBe(false)
    expect(P.isPaused(vm('a'))).toBe(true)
    expect(P.isPaused(vm('c'))).toBe(false)
  })
})

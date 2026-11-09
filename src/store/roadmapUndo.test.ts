import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { milestoneWeekTaken } from '../../convex/lib/limits'
import { answerMilestones, isMilestoneRead } from './milestoneStandIn.setup'
import type { Snapshot } from './plannerFixture.setup'

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

const NOW = '2026-09-14T08:00:00.000Z'

function fixture(): Snapshot {
  const org = crypto.randomUUID()
  const profile = crypto.randomUUID()
  const project = crypto.randomUUID()
  return {
    auth_user_id: 'test-account',
    myProfileIds: [profile],
    orgs: [
      {
        id: org,
        name: 'Testbed Labs',
        slug: 'testbed',
        created_at: NOW,
        next_issue_num: 2,
        date_format: 'iso',
        week_start: 1,
        week_one_rule: 'first4day',
        default_plannable_hours: 40,
      },
    ],
    profiles: [
      {
        id: profile,
        org_id: org,
        auth_user_id: 'test-account',
        name: 'Planner',
        initials: 'PL',
        color: '#335577',
        org_role: 'admin',
        active: true,
        kind: 'person',
        created_at: NOW,
      },
    ],
    projects: [
      {
        id: project,
        org_id: org,
        type: 'project',
        key: 'PLAN',
        num: 1,
        name: 'Planning fixture',
        description: '',
        sort_order: 0,
        track_delay: false,
        created_at: NOW,
      },
    ],
    issues: [1, 2].map((num) => ({
      id: crypto.randomUUID(),
      org_id: org,
      project_id: project,
      num,
      title: `Planning task ${num}`,
      description: '',
      status: 'todo',
      priority: 'low',
      start_week: '2026-09-14',
      end_week: '2026-09-21',
      remaining_hours: 8,
      remaining_set_at: NOW,
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })),
    teams: [],
    teamMembers: [],
    access: [],
    teamAccess: [],
    links: [],
    milestones: [],
    labels: [],
    issueLabels: [],
    issueSubs: [],
    attachments: [],
    orgLoad: [],
    messages: [],
    delivered_at: '2026-09-15T08:00:00.000Z',
  }
}

type Pending = {
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

describe('roadmap undo through the client store', () => {
  let P: Planner
  // the Roadmap's two slots of its range reads (ROADMAP_MILESTONE_SLOTS)
  let roadmapSlots: readonly string[]
  let snap: Snapshot
  let publish: (value: Snapshot) => void
  let fail: (error: Error) => void
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
    network.onUpdate.mockImplementation((ref, args, next, failed) => {
      // the milestone reads answer from the server's milestones, which no
      // workspace part sends
      const name = getFunctionName(ref)
      if (isMilestoneRead(name)) {
        answerMilestones(snap, name, args, next, failed)
        return () => {}
      }
      publish = next
      fail = failed
      next(structuredClone(snap))
      return () => {}
    })
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      return new Promise((resolve, reject) => requests.push({ name, args, resolve, reject }))
    })
    // these cases edit the tasks the store holds, which only a store that asked for every task has
    const { TASKS } = await import('./liveParts')
    TASKS.atBoot = true
    const store = await import('./planner')
    P = store.P
    roadmapSlots = store.ROADMAP_MILESTONE_SLOTS
    await store.initStore()
    P.roadmapContext(true, false)
  })

  afterEach(() => {
    P?.roadmapContext(false, false)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const settled = () => vi.waitFor(() => expect(P.roadmapUndo.busy).toBe(false))
  const task = () => P.issues.find((item) => item.title === 'Planning task 1')!
  const latest = () => requests.at(-1)!
  const iso = (week: number) => P.isoFromDate(P.weekToDate(week))
  /** The dates `by` weeks after the ones `it` holds. */
  const moved = (it: { start: number | null; end: number | null }, by: number) => ({
    start: (it.start ?? 0) + by,
    end: (it.end ?? 0) + by,
  })

  it('expires a long-open visit without reviving its cleared server journal', async () => {
    await savePlan()
    const sent = requests.length
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60 * 1000 + 1)
    P.undoRoadmap(true)
    expect(requests).toHaveLength(sent)
    expect(P.roadmapUndo).toEqual({ count: 0, busy: false, disabled: true })
    // An expired history is a notice, not a failure.
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      'Roadmap undo history expired. Leave Roadmap and return to start a new history.',
      'info',
    )
    P.updateIssue(task().id, moved(task(), 1))
    expect(latest().name).toBe('issues:update')
    latest().resolve(null)
    await settled()
  })

  /** Saves a date change of the first task in the visit's history. */
  async function savePlan() {
    const plan = moved(task(), 1)
    P.updateIssue(task().id, plan)
    expect(latest().name).toBe('roadmap:change')
    snap.issues[0].start_week = iso(plan.start)
    snap.issues[0].end_week = iso(plan.end)
    publish(structuredClone(snap))
    latest().resolve({ count: 1 })
    await settled()
  }

  it('ends the history after an undo refused because a milestone took the week since', async () => {
    await savePlan()
    // the server's refusal of an undo into a week another milestone took
    // (convex/roadmap.ts weekTakenSince): freeing the week on the Roadmap
    // would be one more step, which the next undo takes back
    const sentence =
      'the milestone “Gamma” has taken the week of 2026-09-14 (W38) since that change, and a project can have at most 1 milestone a week. Leave and reopen the roadmap to start a new undo history.'
    P.undoRoadmap()
    expect(latest().name).toBe('roadmap:undo')
    latest().reject(
      new ConvexError({ code: 'conflict', reason: 'roadmap_changed', message: sentence }),
    )
    await settled()
    expect(showToast).toHaveBeenCalledWith(
      `Couldn't undo: ${sentence.slice(0, -1)}. No changes reverted.`,
      'error',
    )
    expect(P.roadmapUndo).toEqual({ count: 0, busy: false, disabled: true })
  })

  it('takes back a Roadmap milestone move refused over an occupied week, and keeps the history', async () => {
    await savePlan()
    // milestones sit on a top-level project, here one the planner leads
    // above the fixture's project, which the Roadmap names with the project
    // cache, so a flag's move finds its organization
    const program = {
      ...snap.projects[0],
      id: crypto.randomUUID(),
      type: 'meta' as const,
      key: 'PROG',
      num: 9,
      name: 'Planning program',
      lead_id: snap.profiles[0].id,
    }
    snap.projects[0].parent_id = program.id
    snap.projects.push(program)
    publish(structuredClone(snap))
    P.nameProjects('the roadmap', [program.id])
    await vi.waitFor(() => expect(P.projectState(program.id)).toBe('ok'))
    const id = crypto.randomUUID()
    snap.milestones.push({
      id,
      project_id: program.id,
      name: 'Beta',
      week: '2026-09-21',
      created_at: NOW,
    })
    // the Roadmap's range read of the weeks on screen shows its flag, the
    // only copy of the milestone the store holds
    const slot = roadmapSlots[0]
    P.watchMilestones(slot, {
      kind: 'between',
      projects: [program.id],
      from: '2026-09-07',
      to: '2026-10-05',
    })
    await vi.waitFor(() => expect(P.milestoneRead(slot).state).toBe('ok'))
    await settled()
    const milestone = () => {
      const read = P.milestoneRead(slot)
      return read.state === 'ok' ? read.answer.rows.find((m) => m.id === id) : undefined
    }
    const week = milestone()?.week ?? 0
    expect(week).toBe(P.isoToWeek('2026-09-21'))
    P.setMilestone(id, week - 1)
    expect(latest()).toMatchObject({
      name: 'roadmap:change',
      args: { operations: [{ kind: 'milestone_update', id, patch: { week: '2026-09-14' } }] },
    })
    expect(milestone()?.week).toBe(week - 1)
    const sentence = milestoneWeekTaken('the week of 2026-09-14 (W38)', 'Gamma')
    latest().reject(
      new ConvexError({ code: 'rule', reason: 'milestone_week_taken', message: sentence }),
    )
    await settled()
    expect(showToast).toHaveBeenCalledWith(
      `This project already has the milestone “Gamma” in the week of 2026-09-14 (W38), and a project can have at most 1 milestone a week. Pick another week, or move that milestone first. Change reverted.`,
      'error',
    )
    expect(milestone()?.week).toBe(week)
    expect(P.roadmapUndo).toEqual({ count: 1, busy: false, disabled: false })
    P.releaseMilestones(slot)
  })

  it('keeps a late response from an earlier visit out of a newly entered roadmap', async () => {
    P.updateIssue(task().id, moved(task(), 1))
    const earlier = latest()
    expect(P.roadmapUndo).toEqual({ count: 0, busy: true, disabled: false })

    P.roadmapContext(false, false)
    P.roadmapContext(true, false)
    P.updateIssue(task().id, moved(task(), 1))
    const current = latest()
    expect(current.args.session_id).not.toBe(earlier.args.session_id)

    earlier.resolve({ count: 5 })
    await vi.waitFor(() => expect(P.roadmapUndo.count).toBe(0))
    current.resolve({ count: 1 })
    await settled()
    expect(P.roadmapUndo).toEqual({ count: 1, busy: false, disabled: false })

    P.undoRoadmap()
    expect(latest()).toMatchObject({
      name: 'roadmap:undo',
      args: { session_id: current.args.session_id, all: false },
    })
    latest().resolve({ count: 0 })
    await settled()
    expect(showToast).toHaveBeenCalledExactlyOnceWith('Roadmap change undone', 'success')
  })

  it('retains history while inspecting a task and after a refused task edit, then disables it after a saved edit', async () => {
    await savePlan()
    const visit = latest().args.session_id
    P.roadmapContext(true, true)
    P.roadmapContext(true, false)
    expect(P.roadmapUndo.count).toBe(1)

    P.roadmapContext(true, true)
    const planned = { start: task().start, end: task().end }
    P.updateIssue(task().id, moved(planned, 1))
    expect(latest().name).toBe('issues:update')
    expect(task()).toMatchObject(moved(planned, 1))
    // The refusal changes no server data, so there is no new snapshot to
    // rescue the optimistic value: rollback must use the last saved one.
    latest().reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await settled()
    expect(task()).toMatchObject(planned)
    expect(showToast).toHaveBeenCalledWith(
      "You don't have permission for that. Change reverted.",
      'error',
    )
    expect(P.roadmapUndo).toEqual({ count: 1, busy: false, disabled: false })

    P.updateIssue(task().id, moved(planned, 2))
    expect(latest().name).toBe('issues:update')
    latest().resolve(null)
    await settled()
    P.roadmapContext(true, false)
    expect(P.roadmapUndo).toEqual({ count: 0, busy: false, disabled: true })
    const sent = requests.length
    P.undoRoadmap(true)
    expect(requests).toHaveLength(sent)

    P.updateIssue(task().id, moved(planned, 3))
    expect(latest().name).toBe('issues:update')
    latest().resolve(null)
    await settled()
    P.roadmapContext(false, false)
    P.roadmapContext(true, false)
    await savePlan()
    expect(latest().args.session_id).not.toBe(visit)
    expect(P.roadmapUndo.disabled).toBe(false)
  })

  it('keeps Undo busy while a comment from a task opened on Roadmap waits', async () => {
    await savePlan()
    expect(P.roadmapUndo).toEqual({ count: 1, busy: false, disabled: false })
    // a comment paints only the thread of the task, and clears the history
    // once the server accepts it
    void P.addComment(task().uuid, 'Posted from Roadmap')
    expect(latest().name).toBe('comments:create')
    expect(P.roadmapUndo.busy).toBe(true)
    const sent = requests.length
    P.undoRoadmap()
    expect(requests).toHaveLength(sent)
    latest().resolve(null)
    await settled()
    expect(P.roadmapUndo).toEqual({ count: 0, busy: false, disabled: true })
  })

  it('renders Undo busy while a write that paints nothing waits, and ready once it answers', async () => {
    await savePlan()
    // what Undo showed at each render the store asked for
    const shown: boolean[] = []
    const stop = P.subscribe(() => shown.push(P.roadmapUndo.busy))
    P.saveUINow({ roadmapWin: P.DEFAULT_WIN })
    expect(latest().name).toBe('prefs:save')
    expect(shown).toEqual([true])
    latest().resolve(null)
    await settled()
    expect(shown).toEqual([true, false])
    stop()
    expect(P.roadmapUndo).toEqual({ count: 1, busy: false, disabled: false })
  })

  it('does not let an ordinary task write from an earlier visit disable the new visit', async () => {
    await savePlan()
    P.roadmapContext(true, true)
    P.updateIssue(task().id, { title: 'Saved task detail' })
    const detail = latest()
    expect(detail.name).toBe('issues:update')
    P.roadmapContext(false, false)
    P.roadmapContext(true, false)
    detail.resolve(null)
    await settled()
    expect(P.roadmapUndo).toEqual({ count: 0, busy: false, disabled: false })
  })

  it('sends nothing for hours that round to the stored ones', async () => {
    const sent = requests.length
    // the server stores hours to the tenth, so 8.01 is the eight hours shown
    expect(await P.updateIssue(task().id, { remaining: 8.01 })).toBe(true)
    expect(requests).toHaveLength(sent)
    expect(task().remaining).toBe(8)
    expect(P.roadmapUndo).toEqual({ count: 0, busy: false, disabled: false })
  })

  it('sends Remaining as an ordinary task write, which ends the history once it saves', async () => {
    await savePlan()
    P.updateIssue(task().id, { remaining: 9.04 })
    expect(task().remaining).toBe(9)
    expect(latest()).toMatchObject({ name: 'issues:update', args: { id: task().uuid } })
    // rounded as the server stores them, with the hours on screen as expected
    expect([latest().args.patch, latest().args.expected]).toEqual([
      { remaining_hours: 9 },
      { remaining_hours: 8 },
    ])
    expect(P.roadmapUndo).toEqual({ count: 1, busy: true, disabled: false })
    latest().resolve(null)
    await settled()
    expect(P.roadmapUndo).toEqual({ count: 0, busy: false, disabled: true })
  })

  it('drops a planning no-op during trouble and keeps a saved edit on screen', async () => {
    // someone else stored these dates meanwhile, so the server changes
    // nothing and answers the unchanged history count
    const planned = { start: task().start, end: task().end }
    P.updateIssue(task().id, moved(planned, 1))
    const change = latest()
    expect(change.name).toBe('roadmap:change')
    const other = P.issues.find((item) => item.title === 'Planning task 2')!
    P.updateIssue(other.id, { title: 'Order the gaskets' })
    const rename = latest()
    expect(rename.name).toBe('issues:update')
    fail(new Error('[CONVEX Q(workspace:whole)] Server Error'))
    // saved, but the failing snapshot never delivers it
    rename.resolve(null)
    change.resolve({ count: 0 })
    await settled()
    expect(P.issues.some((item) => item.title === 'Order the gaskets')).toBe(true)
    // the server changed nothing, so the dates last delivered are right
    expect(task()).toMatchObject(planned)
  })

  it('rolls back a refused roadmap change and the group span that followed it without another snapshot', async () => {
    // the group's own stored dates are far away and stay dormant
    const parent = {
      ...snap.issues[1],
      id: crypto.randomUUID(),
      num: 3,
      title: 'Parent planning task',
      start_week: '2026-12-07',
      end_week: '2026-12-14',
    }
    delete parent.remaining_hours
    delete parent.remaining_set_at
    snap.issues[0].parent_id = parent.id
    snap.issues.push(parent)
    publish(structuredClone(snap))
    const child = task()
    const parentKey = P.issues.find((item) => item.uuid === parent.id)!.id
    const original = { start: child.start, end: child.end }
    const proposed = { start: child.start - 1, end: child.end + 1 }
    expect(P.issueById[parentKey]).toMatchObject(original)

    P.updateIssue(child.id, proposed)
    expect(requests).toHaveLength(1)
    expect(latest()).toMatchObject({
      name: 'roadmap:change',
      args: { operations: [{ kind: 'task', id: child.uuid }] },
    })
    expect(latest().args.operations).toHaveLength(1)
    expect(P.issueById[child.id]).toMatchObject(proposed)
    expect(P.issueById[parentKey]).toMatchObject(proposed)
    expect(showToast).not.toHaveBeenCalled()
    latest().reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await settled()

    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      "You don't have permission for that. Change reverted.",
      'error',
    )
    expect(requests).toHaveLength(1)
    expect(P.issueById[child.id]).toMatchObject(original)
    expect(P.issueById[parentKey]).toMatchObject(original)
    expect(P.roadmapUndo).toEqual({ count: 0, busy: false, disabled: false })
  })

  it("answers a recorded date change, alone or in a batch, with the server's answer", async () => {
    const [first, second] = P.issues
    let alone: boolean | undefined
    void P.updateIssue(first.id, { start: first.start + 1, end: first.end + 1 }).then((saved) => {
      alone = saved
    })
    await Promise.resolve()
    // nothing is claimed before the server answers
    expect(alone).toBeUndefined()
    latest().reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await settled()
    expect(alone).toBe(false)
    let batched: Promise<boolean>[] = []
    P.batchRoadmapChanges(() => {
      batched = [
        P.updateIssue(first.id, moved(first, 1)),
        P.updateIssue(second.id, moved(second, 2)),
      ]
    })
    expect(requests).toHaveLength(2)
    latest().resolve({ count: 1 })
    expect(await Promise.all(batched)).toEqual([true, true])
  })

  it('groups a planning action into one step and waits for all saves before undo or revert all', async () => {
    const [first, second] = P.issues
    const plan = (it: typeof first, by: number) => ({
      start_week: iso(moved(it, by).start),
      end_week: iso(moved(it, by).end),
    })
    P.batchRoadmapChanges(() => {
      P.updateIssue(first.id, moved(first, 1))
      P.updateIssue(second.id, moved(second, 2))
    })
    expect(requests).toHaveLength(1)
    expect(latest()).toMatchObject({
      name: 'roadmap:change',
      args: {
        operations: [
          { kind: 'task', id: first.uuid, patch: plan(first, 1) },
          { kind: 'task', id: second.uuid, patch: plan(second, 2) },
        ],
      },
    })
    const batch = latest()
    P.updateIssue(first.id, moved(first, 3))
    const next = latest()
    P.undoRoadmap()
    expect(requests).toHaveLength(2)

    batch.resolve({ count: 1 })
    await vi.waitFor(() => expect(P.roadmapUndo.count).toBe(1))
    expect(P.roadmapUndo.busy).toBe(true)
    P.undoRoadmap(true)
    expect(requests).toHaveLength(2)
    next.resolve({ count: 2 })
    await settled()

    // A remounted Roadmap in another scope still belongs to the same visit.
    P.roadmapContext(true, false)
    P.undoRoadmap()
    expect(latest()).toMatchObject({
      name: 'roadmap:undo',
      args: { session_id: batch.args.session_id, all: false },
    })
    expect(P.roadmapUndo.busy).toBe(true)
    P.undoRoadmap(true)
    expect(requests).toHaveLength(3)
    Object.assign(snap.issues[0], plan(first, 1))
    Object.assign(snap.issues[1], plan(second, 2))
    publish(structuredClone(snap))
    latest().resolve({ count: 1 })
    await settled()
    expect(P.issueById[first.id]).toMatchObject(moved(first, 1))
    expect(P.issueById[second.id]).toMatchObject(moved(second, 2))
    expect(P.roadmapUndo.count).toBe(1)

    P.undoRoadmap(true)
    expect(latest()).toMatchObject({
      name: 'roadmap:undo',
      args: { session_id: batch.args.session_id, all: true },
    })
    Object.assign(snap.issues[0], plan(first, 0))
    Object.assign(snap.issues[1], plan(second, 0))
    publish(structuredClone(snap))
    latest().resolve({ count: 0 })
    await settled()
    expect(P.issueById[first.id]).toMatchObject(moved(first, 0))
    expect(P.issueById[second.id]).toMatchObject(moved(second, 0))
    expect(P.roadmapUndo).toEqual({ count: 0, busy: false, disabled: false })
  })
})

describe('private demo store disposal', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('discards cached content and refuses late snapshots and write responses after expiry', async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('VITE_APP_MODE', 'demo')
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    })
    vi.stubGlobal('window', { showToast: vi.fn(), clearTimeout })
    const snap = fixture()
    let publish: (snapshot: Snapshot) => void
    let rejectWrite: (error: unknown) => void
    const unsubscribe = vi.fn()
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((_ref, _args, next) => {
      publish = next
      next(structuredClone(snap))
      return unsubscribe
    })
    network.mutation.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject
        }),
    )
    const { P, initStore, disposeDemoStore } = await import('./planner')
    await initStore()
    expect(network.mutation).not.toHaveBeenCalled() // no normal seat-claim path
    const prefKey = `planner.ui.v1:${P.CURRENT_USER}`
    stored.set(prefKey, JSON.stringify({ draft: 'private data' }))
    stored.set('unrelated-app', 'keep')
    P.updateIssue(P.issues[0].id, { remaining: 20 })
    expect(P.issues[0].remaining).toBe(20)
    disposeDemoStore()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(P.loaded).toBe(false)
    // the disposed store holds no task and has asked for none
    expect(P.issueById).toEqual({})
    expect(P.taskLoad()).toEqual({ state: 'not_asked' })
    expect(P.users).toEqual([])
    expect(P.projectTags.size).toBe(0)
    expect(stored.has(prefKey)).toBe(false)
    expect(stored.get('unrelated-app')).toBe('keep')
    publish!(structuredClone(snap))
    rejectWrite!(new ConvexError({ code: 'forbidden', message: 'Expired demo' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(P.issueById).toEqual({})
    expect(P.users).toEqual([])
    expect(P.roadmapUndo.busy).toBe(false)
  })
})

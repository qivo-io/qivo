import { type FunctionReturnType, getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { api } from '../../convex/_generated/api'
import { firstSittingDay, SYNC_OWNERS_MAX, SYNC_SITTING_MS } from '../../convex/lib/teamSync'

type Snapshot = NonNullable<FunctionReturnType<typeof api.snapshot.forMe>>
type Planner = typeof import('./planner')['P']
type Role = Snapshot['profiles'][number]['org_role']

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const NOW = new Date().toISOString()
const HOUR = 3600000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

/* Testbed Labs: me (the role under test), Aisha with a stamp from an
   earlier sitting, Ben with none, and three tasks: one Done, one In Review
   handed to Aisha five hours ago, one To Do. */
function fixture(myRole: Role) {
  const org = crypto.randomUUID()
  const [meta, sub] = [crypto.randomUUID(), crypto.randomUUID()]
  const person = (
    name: string,
    role: Role,
    extra: Partial<Snapshot['profiles'][number]> = {},
  ): Snapshot['profiles'][number] => ({
    id: crypto.randomUUID(),
    org_id: org,
    name,
    initials: name.slice(0, 2).toUpperCase(),
    color: '#335577',
    org_role: role,
    active: true,
    kind: 'person',
    created_at: NOW,
    ...extra,
  })
  const me = person('Me', myRole, { auth_user_id: 'test-account' })
  const aisha = person('Aisha', 'user', { sync_at: ago(30 * HOUR), sync_since: ago(80 * HOUR) })
  const ben = person('Ben', 'user')
  let num = 0
  const task = (
    title: string,
    extra: Partial<Snapshot['issues'][number]>,
  ): Snapshot['issues'][number] => ({
    id: crypto.randomUUID(),
    org_id: org,
    project_id: sub,
    num: ++num,
    title,
    description: '',
    status: 'todo',
    priority: 'low',
    paused: false,
    created_at: ago(200 * HOUR),
    updated_at: NOW,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
    ...extra,
  })
  const done = task('Done one', {
    status: 'done',
    assignee_id: aisha.id,
    done_at: ago(2 * HOUR),
  })
  const review = task('In review', {
    status: 'review',
    assignee_id: ben.id,
    reviewer_id: aisha.id,
    remaining_hours: 2,
    remaining_set_at: ago(5 * HOUR),
    review_at: ago(5 * HOUR),
  })
  const todo = task('To do', { assignee_id: aisha.id, status_at: ago(100 * HOUR) })
  const snap: Snapshot = {
    auth_user_id: 'test-account',
    myProfileIds: [me.id],
    orgs: [
      {
        id: org,
        name: 'Testbed Labs',
        slug: 'testbed-labs',
        created_at: NOW,
        next_issue_num: num,
        next_project_num: 3,
        date_format: 'iso',
        week_start: 1,
        week_one_rule: 'first4day',
        default_plannable_hours: 32,
        gravatar_avatars: false,
      },
    ],
    profiles: [me, aisha, ben],
    projects: [
      {
        id: meta,
        org_id: org,
        type: 'meta',
        key: 'P1',
        num: 1,
        name: 'Project',
        description: '',
        sort_order: 1,
        track_delay: true,
        created_at: NOW,
      },
      {
        id: sub,
        org_id: org,
        type: 'project',
        key: 'P2',
        num: 2,
        name: 'Sub-project',
        description: '',
        sort_order: 2,
        track_delay: true,
        created_at: NOW,
        parent_id: meta,
      },
    ],
    issues: [done, review, todo],
    teams: [],
    teamMembers: [],
    access: [{ project_id: meta, profile_id: aisha.id, level: 'user' }],
    teamAccess: [],
    links: [],
    milestones: [],
    labels: [],
    issueLabels: [],
    issueSubs: [],
    attachments: [],
    // Aisha: 10 h over two weeks on a visible task, 6 h in one week on a
    // task in a project this viewer cannot see (identity nulled); Ben: 4 h
    orgLoad: [
      {
        issue_id: todo.id,
        owner_id: aisha.id,
        start_week: '2026-09-14',
        end_week: '2026-09-21',
        remaining: 10,
        remaining_set_at: null,
      },
      {
        issue_id: null,
        owner_id: aisha.id,
        start_week: '2026-09-21',
        end_week: '2026-09-21',
        remaining: 6,
        remaining_set_at: null,
      },
      {
        issue_id: review.id,
        owner_id: ben.id,
        start_week: '2026-09-14',
        end_week: '2026-09-14',
        remaining: 4,
        remaining_set_at: null,
      },
    ],
    messages: [],
    readMessageCount: 0,
    unreadTruncated: false,
    readTruncated: false,
    delivered_at: '2026-09-15T08:00:00.000Z',
  }
  return { snap, org, me: me.id, aisha: aisha.id, ben: ben.id, done, review, todo }
}

type Sent = { name: string; args: Record<string, unknown> }
type Watch = {
  args: Record<string, unknown>
  next: (value: unknown) => void
  fail: (error: unknown) => void
  unsub: ReturnType<typeof vi.fn>
}

describe('the Team sync store', () => {
  let P: Planner
  let f: ReturnType<typeof fixture>
  let sent: Sent[]
  let watches: Watch[]
  let refuse: boolean
  let deliver: (snap: Snapshot) => void

  async function boot(role: Role) {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    f = fixture(role)
    sent = []
    watches = []
    refuse = false
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((ref, args, next, fail) => {
      if (getFunctionName(ref) === 'teamSync:lastComments') {
        const unsub = vi.fn()
        watches.push({ args, next, fail, unsub })
        return unsub
      }
      deliver = (snap) => next(structuredClone(snap))
      deliver(f.snap)
      return () => {}
    })
    // writes stay pending, so assertions read the optimistic paint; a refused
    // one rejects on the next tick
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      sent.push({ name, args })
      if (refuse) return Promise.reject(new Error('forbidden'))
      return new Promise(() => {})
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
  }

  beforeEach(() => boot('admin'))

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const task = (title: string) => P.issues.find((issue) => issue.title === title)!
  const stamps = () => sent.filter((w) => w.name === 'teamSync:stamp')

  it('shapes each profile stamp, and none when the columns are absent', () => {
    const aisha = f.snap.profiles[1]
    expect(P.user(f.aisha)?.sync).toEqual({ at: aisha.sync_at, since: aisha.sync_since })
    expect(P.user(f.ben)?.sync).toBeNull()
  })

  it('carries the Done, created and review hand-off instants on each task', () => {
    expect(task('Done one').doneAt).toBe(Date.parse(f.done.done_at!))
    expect(task('To do').doneAt).toBeNull()
    expect(task('To do').createdAt).toBe(Date.parse(f.todo.created_at))
    expect(task('In review').reviewAt).toBe(Date.parse(f.review.review_at!))
    expect(task('To do').reviewAt).toBeNull()
    expect(task('To do').statusAt).toBe(Date.parse(f.todo.status_at!))
    expect(task('In review').statusAt).toBeNull()
  })

  it('paints the status stamp the way the server stamps and clears it', () => {
    // a second top-level project to move into, and a leaf to become a subtask
    const [meta2, sub2] = [crypto.randomUUID(), crypto.randomUUID()]
    const project = f.snap.projects[1]
    deliver({
      ...f.snap,
      projects: [
        ...f.snap.projects,
        { ...f.snap.projects[0], id: meta2, key: 'P3', num: 3, name: 'Other' },
        { ...project, id: sub2, key: 'P4', num: 4, name: 'Other sub', parent_id: meta2 },
      ],
      issues: [
        ...f.snap.issues,
        { ...f.todo, id: crypto.randomUUID(), num: 9, title: 'Child', status_at: undefined },
      ],
    })
    // a clock that moves a minute before each write, so a stamp a later
    // write repainted would differ
    let clock = Date.parse('2026-10-19T10:00:00.000Z')
    const tick = () => {
      clock += 60_000
      vi.setSystemTime(clock)
    }
    vi.useFakeTimers({ toFake: ['Date'] })
    tick()
    const before = Date.now()
    // a status change stamps now
    P.updateIssue(task('To do').id, { status: 'progress' })
    const stamped = task('To do').statusAt
    expect(stamped).toBe(before)
    // a patch that resends the title and the status changes nothing, so
    // nothing goes out and nothing is stamped
    const touched = task('To do').updatedAt
    tick()
    P.updateIssue(task('To do').id, { title: 'To do' })
    tick()
    P.updateIssue(task('To do').id, { status: 'progress' })
    expect(task('To do').updatedAt).toBe(touched)
    expect(task('To do').statusAt).toBe(stamped)
    // a move to another project clears it on the task and the subtask it carries
    P.updateIssue(task('Child').id, { status: 'progress' })
    expect(task('Child').statusAt).toBeGreaterThanOrEqual(before)
    P.updateIssue(task('Child').id, { parent: task('To do').id })
    expect(P.moveFamily(task('To do'), sub2).carried.map((c) => c.title)).toEqual(['Child'])
    P.moveIssue(task('To do').id, sub2)
    expect(task('To do').project).toBe(sub2)
    expect(task('To do').statusAt).toBeNull()
    expect(task('Child').statusAt).toBeNull()
    // a new task starts with the stamp at its creation
    const key = P.addIssue({ project: project.id, title: 'Fresh', status: 'todo' })!
    expect(P.issueById[key].statusAt).not.toBeNull()
    expect(P.issueById[key].statusAt).toBe(P.issueById[key].createdAt)
  })

  it('paints the review hand-off the way the server stamps it', () => {
    const handed = Date.parse(f.review.review_at!)
    const before = Date.now()
    // a Remaining edit or a same reviewer is no hand-off
    P.updateIssue(task('In review').id, { remaining: 5 })
    P.updateIssue(task('In review').id, { reviewer: f.aisha })
    expect(task('In review').reviewAt).toBe(handed)
    // a different reviewer while in Review is
    P.updateIssue(task('In review').id, { reviewer: f.me })
    expect(task('In review').reviewAt).toBeGreaterThanOrEqual(before)
    // reviewed to Done keeps it; out of Done to To Do clears it
    const reviewedAt = task('In review').reviewAt
    P.updateIssue(task('In review').id, { status: 'done' })
    expect(task('In review').reviewAt).toBe(reviewedAt)
    P.updateIssue(task('In review').id, { status: 'todo' })
    expect(task('In review').reviewAt).toBeNull()
    // entering Review stamps; leaving it for In Progress clears
    P.updateIssue(task('To do').id, { status: 'review' })
    expect(task('To do').reviewAt).toBeGreaterThanOrEqual(before)
    P.updateIssue(task('To do').id, { status: 'progress' })
    expect(task('To do').reviewAt).toBeNull()
    // Done without passing through Review carries none
    P.updateIssue(task('To do').id, { reviewer: f.ben })
    P.updateIssue(task('To do').id, { status: 'done' })
    expect(task('To do').reviewAt).toBeNull()
  })

  it('paints a move to another sub-project restarting the hand-off and Done time', () => {
    // a sibling sub-project, and a second top-level project to carry a subtask into
    const [sibling, meta2, sub2] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    const project = f.snap.projects[1]
    deliver({
      ...f.snap,
      projects: [
        ...f.snap.projects,
        { ...project, id: sibling, key: 'P3', num: 3, name: 'Sibling' },
        { ...f.snap.projects[0], id: meta2, key: 'P4', num: 4, name: 'Other' },
        { ...project, id: sub2, key: 'P5', num: 5, name: 'Other sub', parent_id: meta2 },
      ],
    })
    const [handed, done] = [task('In review').reviewAt, task('Done one').doneAt]
    // naming the current sub-project changes nothing
    expect(P.moveIssue(task('Done one').id, project.id)).toBeNull()
    expect(task('Done one').doneAt).toBe(done)
    const before = Date.now()
    P.moveIssue(task('In review').id, sibling)
    expect(task('In review').reviewAt).toBeGreaterThanOrEqual(before)
    expect(task('In review').reviewAt).not.toBe(handed)
    // a task that carries neither gains neither
    P.moveIssue(task('To do').id, sibling)
    expect([task('To do').reviewAt, task('To do').doneAt]).toEqual([null, null])
    // a subtask the move carries restarts too
    P.updateIssue(task('Done one').id, { parent: task('To do').id })
    expect(P.moveFamily(task('To do'), sub2).carried.map((c) => c.title)).toEqual(['Done one'])
    P.moveIssue(task('To do').id, sub2)
    expect(task('Done one').project).toBe(sub2)
    expect(task('Done one').doneAt).toBeGreaterThanOrEqual(before)
    expect(task('Done one').doneAt).not.toBe(done)
  })

  it('paints Done now on a move into Done and clears it on a move out', () => {
    const before = Date.now()
    P.updateIssue(task('To do').id, { status: 'done' })
    expect(task('To do').doneAt).toBeGreaterThanOrEqual(before)
    P.updateIssue(task('Done one').id, { status: 'progress' })
    expect(task('Done one').doneAt).toBeNull()
    // a write that leaves the status alone keeps the server's stamp
    P.updateIssue(task('To do').id, { title: 'Renamed' })
    expect(P.issues.find((i) => i.title === 'Renamed')!.doneAt).toBeGreaterThanOrEqual(before)
  })

  it('reads each person’s org-wide hours per week, hidden projects included', () => {
    const w14 = P.isoToWeek('2026-09-14')
    const w21 = P.isoToWeek('2026-09-21')
    expect(P.weekLoadOf(f.aisha, w14)).toBe(5)
    expect(P.weekLoadOf(f.aisha, w21)).toBe(11)
    expect(P.weekLoadOf(f.ben, w14)).toBe(4)
    expect(P.weekLoadOf(f.ben, w21)).toBe(0)
    expect(P.weekLoadOf(f.me, w14)).toBe(0)
    // the next delivery's load, not the first answer kept
    deliver({
      ...f.snap,
      orgLoad: f.snap.orgLoad.map((l) => ({ ...l, remaining: 2 * l.remaining })),
    })
    expect(P.weekLoadOf(f.ben, w14)).toBe(8)
  })

  it('reads a week of a plan that runs to the year 9999 without spreading the rest', async () => {
    // the store's own instance, which counts the week entries it spreads
    const { weeksSpreadSoFar } = await import('../lib/workload')
    const w14 = P.isoToWeek('2026-09-14')
    const end = '9999-12-27'
    const span = P.isoToWeek(end) - w14 + 1
    expect(span).toBeGreaterThan(416_000)
    // five such plans of an hour a week beside Ben's one-week task
    const long = { ...f.snap.orgLoad[2], issue_id: null, end_week: end, remaining: span }
    const before = weeksSpreadSoFar()
    deliver({ ...f.snap, orgLoad: [...f.snap.orgLoad, ...Array(5).fill(long)] })
    const delivered = weeksSpreadSoFar()
    expect(P.weekLoadOf(f.ben, w14)).toBe(9)
    expect(P.weekLoadOf(f.ben, w14 + 1)).toBe(5)
    expect(P.weekLoadOf(f.ben, P.isoToWeek('9999-12-20'))).toBe(5)
    // each read spreads its one week of every plan that covers it: 6, 5 and 5
    expect(weeksSpreadSoFar() - delivered).toBe(16)
    // the rebuild's delay projections spread less than one such plan in full
    expect(delivered - before).toBeLessThan(span)
  })

  it('stamps a person optimistically and on the wire, keeping a sitting’s reading point', () => {
    P.syncStamp(f.ben)
    const first = P.user(f.ben)!.sync!
    expect(Date.now() - Date.parse(first.at)).toBeLessThan(5000)
    // a first stamp keeps the day the page was reading from, and says so
    const day = firstSittingDay(Date.now())
    expect(first.since).toBe(day)
    expect(stamps()).toEqual([
      { name: 'teamSync:stamp', args: { org_id: f.org, profile_id: f.ben, first_since: day } },
    ])
    P.syncStamp(f.ben)
    expect(P.user(f.ben)!.sync!.since).toBe(day)
    expect(stamps()[1].args.first_since).toBeUndefined()
    sent.length = 0
    // Aisha's last stamp is older than a sitting: it becomes her reading point
    const previous = P.user(f.aisha)!.sync!.at
    P.syncStamp(f.aisha)
    expect(P.user(f.aisha)!.sync!.since).toBe(previous)
    // a second change in the same sitting keeps it
    P.syncStamp(f.aisha)
    expect(P.user(f.aisha)!.sync!.since).toBe(previous)
    expect(Date.now() - Date.parse(previous)).toBeGreaterThan(SYNC_SITTING_MS)
    expect(stamps()).toHaveLength(2)
    expect(stamps().every((w) => w.args.first_since === undefined)).toBe(true)
  })

  it('rolls a refused stamp back to the server’s', async () => {
    refuse = true
    P.syncStamp(f.ben)
    expect(P.user(f.ben)!.sync).not.toBeNull()
    await vi.waitFor(() => expect(P.user(f.ben)!.sync).toBeNull())
  })

  it('sends nothing for an unknown person or from a viewer', async () => {
    P.syncStamp(crypto.randomUUID())
    expect(stamps()).toHaveLength(0)
    await boot('viewer')
    P.syncStamp(f.ben)
    expect(stamps()).toHaveLength(0)
    expect(P.user(f.ben)!.sync).toBeNull()
  })

  it('watches the latest comments of the people the page shows', () => {
    // no people, no subscription
    P.watchTeamSync(f.org)
    P.watchTeamSync(f.org, [])
    expect(watches).toHaveLength(0)

    P.watchTeamSync(f.org, [f.ben, f.aisha])
    P.watchTeamSync(f.org, [f.ben, f.aisha, f.ben]) // the same people again subscribes nothing new
    expect(watches).toHaveLength(1)
    // in the order asked, so an answer cut short covers the first person
    expect(watches[0].args).toEqual({ org_id: f.org, owner_ids: [f.ben, f.aisha] })
    const at = ago(HOUR)
    watches[0].next({
      rows: [
        { issue_id: f.todo.id, at },
        { issue_id: f.review.id, at: null },
      ],
      complete: true,
    })
    expect(P.lastComments.get(f.todo.id)).toBe(Date.parse(at))
    // covered with no comment, unlike a task the answer did not cover
    expect(P.lastComments.has(f.review.id)).toBe(true)
    expect(P.lastComments.get(f.review.id)).toBeNull()
    expect(P.lastComments.has(f.done.id)).toBe(false)

    // other people in the same organization keep the marks until their answer
    P.watchTeamSync(f.org, [f.ben])
    expect(watches[0].unsub).toHaveBeenCalledOnce()
    expect(watches).toHaveLength(2)
    expect(watches[1].args).toEqual({ org_id: f.org, owner_ids: [f.ben] })
    expect(P.lastComments.get(f.todo.id)).toBe(Date.parse(at))
    watches[0].next({ rows: [{ issue_id: f.done.id, at }], complete: true })
    expect(P.lastComments.has(f.done.id)).toBe(false)
    watches[1].next({ rows: [{ issue_id: f.review.id, at }], complete: true })
    expect([...P.lastComments]).toEqual([[f.review.id, Date.parse(at)]])

    // leaving the page empties them, and a late delivery lands nowhere
    P.watchTeamSync(null)
    expect(watches[1].unsub).toHaveBeenCalledOnce()
    expect(P.lastComments.size).toBe(0)
    watches[1].next({ rows: [{ issue_id: f.todo.id, at }], complete: true })
    expect(P.lastComments.size).toBe(0)
  })

  it(`asks for every person in parts of ${SYNC_OWNERS_MAX}, halves a part cut short, and names who stays cut short alone`, () => {
    const people = Array.from({ length: 2 * SYNC_OWNERS_MAX + 20 }, () => crypto.randomUUID())
    P.watchTeamSync(f.org, people)
    expect(watches.map((w) => w.args.owner_ids)).toEqual([
      people.slice(0, SYNC_OWNERS_MAX),
      people.slice(SYNC_OWNERS_MAX, 2 * SYNC_OWNERS_MAX),
      people.slice(2 * SYNC_OWNERS_MAX),
    ])
    const at = ago(HOUR)
    watches[0].next({ rows: [{ issue_id: f.todo.id, at }], complete: true })
    // each part's marks show as its answer arrives
    expect(P.lastComments.get(f.todo.id)).toBe(Date.parse(at))
    // a part cut short is asked again in halves, and its answer is not used
    watches[1].next({ rows: [{ issue_id: f.done.id, at }], complete: false })
    expect(watches[1].unsub).toHaveBeenCalledOnce()
    expect(watches.slice(3).map((w) => w.args.owner_ids)).toEqual([
      people.slice(SYNC_OWNERS_MAX, SYNC_OWNERS_MAX * 1.5),
      people.slice(SYNC_OWNERS_MAX * 1.5, 2 * SYNC_OWNERS_MAX),
    ])
    expect(P.lastComments.has(f.done.id)).toBe(false)
    watches[3].next({ rows: [{ issue_id: f.done.id, at }], complete: true })
    watches[4].next({ rows: [{ issue_id: f.review.id, at: null }], complete: true })
    watches[2].next({ rows: [], complete: true })
    expect(P.lastComments.get(f.done.id)).toBe(Date.parse(at))
    expect(P.lastComments.get(f.review.id)).toBeNull()
    expect(P.lastCommentsCut).toEqual([])

    // one person whose own answer is still cut short is named
    P.watchTeamSync(f.org, [f.aisha])
    watches.at(-1)?.next({ rows: [{ issue_id: f.review.id, at }], complete: false })
    expect(P.lastCommentsCut).toEqual([f.aisha])
    expect(P.lastComments.get(f.review.id)).toBe(Date.parse(at))
  })

  it('empties the marks of another organization', () => {
    P.watchTeamSync(f.org, [f.aisha])
    watches[0].next({ rows: [{ issue_id: f.todo.id, at: NOW }], complete: true })
    P.watchTeamSync(crypto.randomUUID(), [f.aisha])
    expect(watches[0].unsub).toHaveBeenCalledOnce()
    expect(P.lastComments.size).toBe(0)
  })

  it('reads a failed subscription as covering no task', () => {
    P.watchTeamSync(f.org, [f.aisha])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    watches[0].next({ rows: [{ issue_id: f.todo.id, at: NOW }], complete: true })
    watches[0].fail(new Error('not_found'))
    expect(P.lastComments.size).toBe(0)
    // the subscription stays, and its next good answer brings the marks back
    expect(watches[0].unsub).not.toHaveBeenCalled()
    watches[0].next({ rows: [{ issue_id: f.todo.id, at: NOW }], complete: true })
    expect(P.lastComments.has(f.todo.id)).toBe(true)
  })

  it('blanks only the failed part, and keeps the marks of the others', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const people = Array.from({ length: SYNC_OWNERS_MAX + 1 }, () => crypto.randomUUID())
    P.watchTeamSync(f.org, people)
    watches[0].next({ rows: [{ issue_id: f.todo.id, at: NOW }], complete: true })
    watches[1].next({ rows: [{ issue_id: f.review.id, at: NOW }], complete: true })
    watches[1].fail(new Error('offline'))
    expect([...P.lastComments.keys()]).toEqual([f.todo.id])
  })
})

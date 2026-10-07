import { type FunctionReturnType, getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { api } from '../../convex/_generated/api'
import { firstSittingDay, SYNC_SITTING_MS } from '../../convex/lib/teamSync'

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
  const todo = task('To do', { assignee_id: aisha.id })
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
    activity: [],
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

  it('watches the latest comments of one organization while the page is open', () => {
    expect(P.lastCommentsLoaded).toBe(false)
    P.watchTeamSync(f.org)
    P.watchTeamSync(f.org) // the same org again subscribes nothing new
    expect(watches).toHaveLength(1)
    expect(watches[0].args).toEqual({ org_id: f.org })
    const at = ago(HOUR)
    watches[0].next([{ issue_id: f.todo.id, at }])
    expect(P.lastCommentsLoaded).toBe(true)
    expect(P.lastComments.get(f.todo.id)).toBe(Date.parse(at))
    expect(P.lastComments.has(f.review.id)).toBe(false)

    P.watchTeamSync(null)
    expect(watches[0].unsub).toHaveBeenCalledOnce()
    expect(P.lastCommentsLoaded).toBe(false)
    expect(P.lastComments.size).toBe(0)
    // a delivery that was already on its way lands nowhere
    watches[0].next([{ issue_id: f.todo.id, at }])
    expect(P.lastComments.size).toBe(0)
  })

  it('reads a failed subscription as loaded with no comments', () => {
    P.watchTeamSync(f.org)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    watches[0].next([{ issue_id: f.todo.id, at: NOW }])
    watches[0].fail(new Error('not_found'))
    expect(P.lastCommentsLoaded).toBe(true)
    expect(P.lastComments.size).toBe(0)
  })
})

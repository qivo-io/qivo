import { type FunctionReturnType, getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { api } from '../../convex/_generated/api'

type Snapshot = NonNullable<FunctionReturnType<typeof api.snapshot.forMe>>
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

const NOW = new Date().toISOString()
// three weeks back, so a fresh review-time stamp moves the measured week.
// Calendar days at local noon, not 21 x 24 h: across a DST change the fixed
// span can land in the adjacent local week
const earlier = new Date()
earlier.setDate(earlier.getDate() - 21)
earlier.setHours(12, 0, 0, 0)
const EARLIER = earlier.toISOString()

/* Testbed Labs with a project that sets a 4 h review time, a sub-project
   that inherits it, one that sets 1 h, and a second project that sets
   nothing (the 2 h default). Tasks A-D and group G cover each ownership
   case the Reviewer rule has. */
function fixture() {
  const org = crypto.randomUUID()
  const [meta, sub, sub2, meta2] = [1, 2, 3, 4].map(() => crypto.randomUUID())
  const person = (name: string, role: 'admin' | 'user'): Snapshot['profiles'][number] => ({
    id: crypto.randomUUID(),
    org_id: org,
    name,
    initials: name.slice(0, 2).toUpperCase(),
    color: '#335577',
    org_role: role,
    active: true,
    kind: 'person',
    created_at: NOW,
  })
  const me = { ...person('Me', 'admin'), auth_user_id: 'test-account' }
  const other = person('Other', 'user')
  const project = (
    id: string,
    num: number,
    extra: Partial<Snapshot['projects'][number]>,
  ): Snapshot['projects'][number] => ({
    id,
    org_id: org,
    type: 'project',
    key: `P${num}`,
    num,
    name: `Project ${num}`,
    description: '',
    sort_order: num,
    track_delay: true,
    created_at: NOW,
    ...extra,
  })
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
    created_at: NOW,
    updated_at: NOW,
    has_hidden_subtasks: false,
    ...extra,
  })
  const a = task('A', {
    status: 'review',
    assignee_id: other.id,
    reviewer_id: me.id,
    remaining_hours: 3,
    remaining_set_at: EARLIER,
  })
  const b = task('B', {
    status: 'progress',
    assignee_id: me.id,
    reviewer_id: other.id,
    remaining_hours: 6,
    remaining_set_at: EARLIER,
  })
  const c = task('C', { status: 'review', assignee_id: me.id, reviewer_id: other.id })
  const g = task('G', { status: 'review', assignee_id: me.id, reviewer_id: other.id })
  const child = task('G child', { assignee_id: me.id, parent_id: g.id })
  const d = task('D', { project_id: sub2, assignee_id: me.id })
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
        next_project_num: 5,
        date_format: 'iso',
        week_start: 1,
        week_one_rule: 'first4day',
        default_plannable_hours: 32,
        gravatar_avatars: false,
      },
    ],
    profiles: [me, other],
    projects: [
      project(meta, 1, { type: 'meta', review_hours: 4 }),
      project(sub, 2, { parent_id: meta }),
      project(sub2, 3, { parent_id: meta, review_hours: 1 }),
      project(meta2, 4, { type: 'meta' }),
    ],
    issues: [a, b, c, g, child, d],
    teams: [],
    teamMembers: [],
    access: [{ project_id: meta, profile_id: other.id, level: 'user' }],
    teamAccess: [],
    links: [],
    milestones: [],
    activity: [],
    labels: [],
    issueLabels: [],
    issueSubs: [],
    attachments: [],
    orgLoad: [
      {
        issue_id: a.id,
        owner_id: me.id,
        start_week: '2026-09-14',
        end_week: '2026-09-21',
        remaining: 3,
        remaining_set_at: EARLIER,
      },
    ],
    messages: [],
    readMessageCount: 0,
  }
  return { snap, me: me.id, other: other.id, sub, sub2, meta2 }
}

type Sent = { name: string; args: Record<string, unknown> }

describe('the Reviewer rule in the client store', () => {
  let P: Planner
  let f: ReturnType<typeof fixture>
  let sent: Sent[]

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    f = fixture()
    sent = []
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((_ref, _args, next) => {
      next(structuredClone(f.snap))
      return () => {}
    })
    // writes stay pending, so each assertion reads the optimistic paint
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      sent.push({ name, args })
      return new Promise(() => {})
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const task = (title: string) => P.issues.find((issue) => issue.title === title)!
  const lastPatch = (name: string) => sent.filter((w) => w.name === name).at(-1)?.args

  it('hands ownership to the reviewer only while a leaf task waits In Review', () => {
    expect([task('A').owner, task('A').ownerField]).toEqual([f.me, 'reviewer'])
    expect([task('B').owner, task('B').ownerField]).toEqual([f.me, 'assignee'])
    expect([task('G').owner, task('G').ownerField]).toEqual([f.me, 'assignee'])
    expect(task('G').reviewer).toBe(f.other)
  })

  it('counts what I own as mine, and my task another person reviews as theirs', () => {
    expect(P.isMine(task('A'))).toBe(true)
    expect(P.isMine(task('B'))).toBe(true)
    expect(P.isMine(task('C'))).toBe(false)
    const filters = {
      mine: false,
      assignees: [f.other],
      priority: null,
      stale: false,
      focus: false,
      search: '',
    }
    expect(P.passesFilters(task('C'), filters)).toBe(true)
    expect(P.passesFilters(task('B'), filters)).toBe(false)
  })

  it('resolves the review time from the sub-project, its project, then the default', () => {
    expect(P.reviewHoursFor(f.sub)).toBe(4)
    expect(P.reviewHoursFor(f.sub2)).toBe(1)
    expect(P.reviewHoursFor(f.meta2)).toBe(2)
  })

  it('paints the review time on entering Review without sending it', () => {
    P.updateIssue(task('B').id, { status: 'review' })
    expect(task('B').remaining).toBe(4)
    expect(task('B').remainingSet).toBe(P.TODAY_WEEK)
    expect(task('B').owner).toBe(f.other)
    expect(lastPatch('issues:update')?.patch).toStrictEqual({ status: 'review' })

    P.updateIssue(task('D').id, { status: 'review' })
    expect(task('D').remaining).toBe(1)
  })

  it('lets stated hours win and keeps the remaining time on leaving Review', () => {
    P.updateIssue(task('B').id, { status: 'review', remaining: 5 })
    expect(task('B').remaining).toBe(5)
    expect(lastPatch('issues:update')?.patch).toStrictEqual({
      status: 'review',
      remaining_hours: 5,
    })

    P.updateIssue(task('A').id, { status: 'progress' })
    expect(task('A').remaining).toBe(3)
    expect(task('A').remainingSet).toBe(P.TODAY_WEEK - 3)
    expect(task('A').owner).toBe(f.other)
  })

  it('paints the review time on a task created In Review while the wire states no hours', () => {
    const key = P.addIssue({ project: f.sub, title: 'Born in review', status: 'review' })!
    expect(P.issueById[key].remaining).toBe(4)
    expect(lastPatch('issues:create')).toMatchObject({ remaining_hours: null, reviewer_id: null })
  })

  it('sends reviewer changes as reviewer_id and mirrors a cleared one as absent', () => {
    P.updateIssue(task('B').id, { reviewer: f.me })
    expect(lastPatch('issues:update')?.patch).toStrictEqual({ reviewer_id: f.me })
    P.updateIssue(task('C').id, { reviewer: null })
    expect(lastPatch('issues:update')?.patch).toStrictEqual({ reviewer_id: null })
    expect(task('C').reviewer).toBeUndefined()
    expect(task('C').owner).toBe(f.me)
  })

  it('clears a removed person from the tasks they review', () => {
    P.removeUser(f.other)
    expect(task('C').reviewer).toBeUndefined()
    expect(task('C').owner).toBe(f.me)
  })

  it('sends a cleared project review time as null', () => {
    P.updateProject(f.sub2, { reviewHours: null })
    expect(lastPatch('projects:update')?.patch).toStrictEqual({ review_hours: null })
    expect(P.reviewHoursFor(f.sub2)).toBe(4)
  })
})

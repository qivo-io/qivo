import { describe, expect, it } from 'vitest'
import {
  DEMO_SYNC_TIME,
  MARKETING_DEMO,
  marketingInstant,
  northstarTaskTimes,
} from '../../convex/internal/marketingDemoData'
import { taskOwnerId } from '../../convex/lib/review'
import { syncSince } from '../../convex/lib/teamSync'
import { parseMd } from './md'
import {
  type BlockerIssue,
  bannerVerdict,
  blockersOf,
  dayLabel,
  doneSince,
  loadFigure,
  mentionBody,
  milestonesAhead,
  nearCapacity,
  needsOwner,
  needsReviewer,
  nextMilestone,
  openingFacts,
  parseSyncScope,
  personGroups,
  previousSync,
  resolveSyncScope,
  rowMarks,
  type ScopeWorld,
  type SentencePart,
  type SinceMark,
  type SyncDay,
  type SyncIssue,
  type SyncProject,
  scopeMetaIds,
  scopeProjectIds,
  stampLabel,
  syncDay,
  syncRoster,
  syncRows,
  syncScopeKey,
  syncSentence,
  waitingLabel,
  waitingOnReview,
} from './teamSync'

/* A sync morning: Tuesday 29 Sep 2026, 10:00 local, week index 11. */
const at = (d: number, h = 9) => new Date(2026, 8, d, h).getTime()
const NOW = at(29, 10)
const DAY: SyncDay = { todayWeek: 11, today: '2026-09-29', weekEnd: '2026-10-04' }

/* A task with the owner rule applied (convex/lib/review.ts): the reviewer
   while In Review with one, else the assignee. */
const task = (o: Partial<SyncIssue> & { key: string }): SyncIssue => {
  const t: SyncIssue = {
    id: o.key,
    uuid: `uuid-${o.key}`,
    project: 'S1',
    status: 'todo',
    priority: 'medium',
    assignee: undefined,
    reviewer: undefined,
    owner: undefined,
    isGroup: false,
    children: [],
    hasHiddenSubtasks: false,
    links: [],
    start: null,
    due: undefined,
    remaining: 4,
    paused: false,
    updatedAt: at(20),
    doneAt: null,
    reviewAt: null,
    statusAt: null,
    createdAt: at(1),
    ...o,
  }
  if (!('owner' in o)) t.owner = t.status === 'review' && t.reviewer ? t.reviewer : t.assignee
  return t
}
const keys = (list: readonly { key: string }[]) => list.map((t) => t.key)
const byId = (...list: SyncIssue[]): Record<string, BlockerIssue> =>
  Object.fromEntries(list.map((t) => [t.id, t]))

describe('sync scope', () => {
  it('round-trips the saved forms and reads anything else as all', () => {
    for (const key of ['all', 'team:t-1', 'project:p-1']) {
      expect(syncScopeKey(parseSyncScope(key))).toBe(key)
    }
    expect(parseSyncScope('team:t-1')).toEqual({ kind: 'team', id: 't-1' })
    expect(parseSyncScope('project:p-1')).toEqual({ kind: 'project', id: 'p-1' })
    for (const bad of [undefined, null, '', 'mine', 'team:', 'p-1', 'org:o-1']) {
      expect(parseSyncScope(bad)).toEqual({ kind: 'all' })
    }
  })

  // M1 (S1, hidden S2) and M2 (S3) at home; a foreign org's F1 (FS1).
  // Team T1 is shared with M1 and, on its own, with S3.
  const meta = (id: string, children: string[], o: Partial<SyncProject> = {}): SyncProject => ({
    id,
    type: 'meta',
    org: 'home',
    parent: undefined,
    children,
    teamAccess: {},
    ...o,
  })
  const sub = (id: string, parent: string, o: Partial<SyncProject> = {}): SyncProject => ({
    id,
    type: 'project',
    org: 'home',
    parent,
    children: undefined,
    teamAccess: {},
    ...o,
  })
  const world: ScopeWorld = {
    homeOrg: 'home',
    projects: [
      meta('M1', ['S1', 'S2'], { teamAccess: { T1: 'user' } }),
      sub('S1', 'M1'),
      sub('S2', 'M1'),
      meta('M2', ['S3']),
      sub('S3', 'M2', { teamAccess: { T1: 'viewer' } }),
      meta('F1', ['FS1'], { org: 'away' }),
      sub('FS1', 'F1', { org: 'away' }),
    ],
    teams: [
      { id: 'T1', org: 'home' },
      { id: 'T2', org: 'away' },
    ],
    canSee: (id) => id !== 'S2',
  }
  const ids = (s: Set<string>) => [...s].sort()

  it('covers every visible home sub-project for all', () => {
    expect(ids(scopeProjectIds({ kind: 'all' }, world))).toEqual(['S1', 'S3'])
    expect(ids(scopeMetaIds({ kind: 'all' }, world))).toEqual(['M1', 'M2'])
  })
  it("covers a team's shares, a meta's through its visible children", () => {
    const team = { kind: 'team', id: 'T1' } as const
    expect(ids(scopeProjectIds(team, world))).toEqual(['S1', 'S3'])
    expect(ids(scopeMetaIds(team, world))).toEqual(['M1', 'M2'])
  })
  it('covers one project, or one sub-project', () => {
    expect(ids(scopeProjectIds({ kind: 'project', id: 'M1' }, world))).toEqual(['S1'])
    expect(ids(scopeProjectIds({ kind: 'project', id: 'S3' }, world))).toEqual(['S3'])
    expect(ids(scopeMetaIds({ kind: 'project', id: 'S3' }, world))).toEqual(['M2'])
  })
  it('falls back to all for a team or project that is gone, foreign or hidden', () => {
    for (const s of [
      { kind: 'team', id: 'gone' },
      { kind: 'team', id: 'T2' },
      { kind: 'project', id: 'gone' },
      { kind: 'project', id: 'F1' },
      { kind: 'project', id: 'S2' },
    ] as const) {
      expect(resolveSyncScope(s, world)).toEqual({ kind: 'all' })
      expect(ids(scopeProjectIds(s, world))).toEqual(['S1', 'S3'])
    }
    expect(resolveSyncScope({ kind: 'team', id: 'T1' }, world)).toEqual({ kind: 'team', id: 'T1' })
  })
})

describe('rows and roster', () => {
  const scope = new Set(['S1'])
  const rows = syncRows(
    [
      task({ key: 'QN-1', status: 'todo', assignee: 'ben' }),
      task({ key: 'QN-2', status: 'progress', assignee: 'aisha' }),
      task({ key: 'QN-3', status: 'review', assignee: 'leo', reviewer: 'nora' }),
      task({ key: 'QN-4', status: 'progress', assignee: 'atlas' }),
      task({ key: 'QN-5', status: 'backlog', assignee: 'emil' }),
      task({ key: 'QN-6', status: 'done', assignee: 'emil' }),
      task({ key: 'QN-7', status: 'todo', assignee: 'emil', project: 'S9' }),
      task({ key: 'QN-8', status: 'todo', assignee: 'emil', children: ['QN-1'] }),
      task({ key: 'QN-9', status: 'todo' }),
    ],
    scope,
  )
  const users = [
    { id: 'nora', name: 'Nora Berg', isAgent: false, teams: ['T1'] },
    { id: 'aisha', name: 'Aisha Rahman', isAgent: false, teams: [] },
    { id: 'atlas', name: 'Atlas', isAgent: true, teams: ['T1'] },
    { id: 'ben', name: 'Ben Carter', isAgent: false, teams: ['T1'] },
    { id: 'leo', name: 'Leo Martins', isAgent: false, teams: ['T1'] },
    { id: 'emil', name: 'Emil Strand', isAgent: false, teams: ['T1'] },
  ]

  it('keeps open leaf tasks in scope only', () => {
    expect(keys(rows)).toEqual(['QN-1', 'QN-2', 'QN-3', 'QN-4', 'QN-9'])
  })
  it('walks the owners by name, agents last, a reviewer in place of the assignee', () => {
    const r = syncRoster(rows, users, { kind: 'all' })
    expect(r.humans.map((u) => u.id)).toEqual(['aisha', 'ben', 'nora'])
    expect(r.agents.map((u) => u.id)).toEqual(['atlas'])
  })
  it("keeps only the team's members in team scope", () => {
    const r = syncRoster(rows, users, { kind: 'team', id: 'T1' })
    expect(r.humans.map((u) => u.id)).toEqual(['ben', 'nora'])
    expect(r.agents.map((u) => u.id)).toEqual(['atlas'])
  })
})

describe('personGroups', () => {
  const mine = (o: Partial<SyncIssue> & { key: string }) => task({ assignee: 'aisha', ...o })
  const rows = [
    mine({ key: 'QN-10', status: 'progress', start: 10 }),
    mine({ key: 'QN-9', status: 'progress', start: 10 }),
    mine({ key: 'QN-11', status: 'progress', start: 9, remaining: undefined }),
    mine({ key: 'QN-12', status: 'progress', start: 8 }),
    mine({ key: 'QN-13', status: 'progress', due: '2026-10-01' }),
    mine({ key: 'QN-14', status: 'progress' }),
    // reviews: one Aisha does, her own with no reviewer, her own someone else reviews
    task({ key: 'QN-20', status: 'review', assignee: 'ben', reviewer: 'aisha' }),
    mine({ key: 'QN-21', status: 'review' }),
    mine({ key: 'QN-22', status: 'review', reviewer: 'leo' }),
    // To Do: this week by plan or by an unplanned due date, else later
    mine({ key: 'QN-30', start: 11 }),
    mine({ key: 'QN-31', start: 12 }),
    mine({ key: 'QN-32', due: '2026-10-04' }),
    mine({ key: 'QN-33', due: '2026-10-05' }),
    mine({ key: 'QN-34', due: '2026-09-01' }),
    mine({ key: 'QN-35' }),
    mine({ key: 'QN-36', start: 12, due: '2026-10-01' }),
    task({ key: 'QN-40', status: 'progress', assignee: 'ben' }),
  ]
  const groups = Object.fromEntries(
    personGroups('aisha', rows, DAY).map((g) => [g.id, keys(g.rows)]),
  )

  it('orders no estimate first, then start week, then due date, then key', () => {
    expect(groups.progress).toEqual(['QN-11', 'QN-12', 'QN-9', 'QN-10', 'QN-13', 'QN-14'])
  })
  it('holds the reviews a person does and their own reviews nobody does', () => {
    expect(groups.review).toEqual(['QN-20', 'QN-21'])
  })
  it('splits To Do into this week and later', () => {
    expect(groups.week).toEqual(['QN-30', 'QN-34', 'QN-32'])
    // equal start weeks fall to the due date, dated first
    expect(groups.later).toEqual(['QN-36', 'QN-31', 'QN-33', 'QN-35'])
  })
  it('always returns the four groups in order', () => {
    expect(personGroups('nobody', rows, DAY).map((g) => [g.id, g.rows.length])).toEqual([
      ['progress', 0],
      ['review', 0],
      ['week', 0],
      ['later', 0],
    ])
  })
})

describe('rowMarks', () => {
  const SINCE = at(25, 0)
  const base = {
    person: 'aisha',
    since: SINCE,
    verdict: null,
    issueById: {},
    lastCommentAt: null,
  } as const

  it('marks In Progress with nothing since as untouched, from the last touch', () => {
    const t = task({ key: 'QN-1', status: 'progress', assignee: 'aisha', updatedAt: at(23) })
    expect(rowMarks(t, base).since).toEqual({ kind: 'untouched', at: at(23) })
    expect(rowMarks(t, { ...base, lastCommentAt: at(24) }).since).toEqual({
      kind: 'untouched',
      at: at(24),
    })
    // a comment since the sync is a touch, and the change mark says so
    expect(rowMarks(t, { ...base, lastCommentAt: at(28) }).since).toEqual({
      kind: 'changed',
      what: 'commented',
      at: at(28),
    })
    // any other write since the sync is a touch too, with nothing to say
    expect(rowMarks({ ...t, updatedAt: at(28) }, base).since).toBeNull()
  })
  it('says no since mark while the latest comment is not known', () => {
    const { lastCommentAt, ...unknown } = base
    expect(lastCommentAt).toBeNull()
    const t = task({ key: 'QN-1', status: 'progress', assignee: 'aisha', updatedAt: at(23) })
    expect(rowMarks(t, unknown).since).toBeNull()
    expect(rowMarks(t, { ...base, lastCommentAt: undefined }).since).toBeNull()
    // a hand-off would be marked too once the comment is known
    const r = task({ key: 'QN-2', status: 'review', reviewer: 'aisha', reviewAt: at(28) })
    expect(rowMarks(r, base).since).toEqual({ kind: 'handed', at: at(28) })
    expect(rowMarks(r, unknown).since).toBeNull()
    // the other marks do not wait for it
    expect(rowMarks({ ...t, remaining: undefined }, unknown).noEstimate).toBe(true)
  })
  it('says the latest status change or comment since the sync', () => {
    const t = task({
      key: 'QN-1',
      status: 'progress',
      assignee: 'aisha',
      updatedAt: at(27),
      statusAt: at(27),
    })
    // worded from the task's current status
    expect(rowMarks(t, base).since).toEqual({
      kind: 'changed',
      what: 'moved to In Progress',
      at: at(27),
    })
    expect(rowMarks(t, { ...base, lastCommentAt: at(28) }).since).toMatchObject({
      what: 'commented',
    })
    expect(rowMarks(t, { ...base, lastCommentAt: at(26) }).since).toMatchObject({
      what: 'moved to In Progress',
    })
    // a change before the sync is not a change since
    expect(rowMarks({ ...t, status: 'todo', statusAt: at(24) }, base).since).toBeNull()
    // the status a task was created with is no change, however new the task
    expect(rowMarks({ ...t, status: 'todo', createdAt: at(27) }, base).since).toBeNull()
    // no stamp (an older task, or one moved to another project) says nothing
    expect(rowMarks({ ...t, status: 'todo', statusAt: null }, base).since).toBeNull()
  })
  it("says only a comment on a reviewer's review without a recorded hand-off", () => {
    // a leaf again after its subtasks went: In Review with a reviewer, a
    // status stamp and no hand-off (model/issues.ts clearParentRemaining)
    const r = task({
      key: 'QN-2',
      status: 'review',
      assignee: 'ben',
      reviewer: 'aisha',
      reviewAt: null,
      statusAt: at(27),
      updatedAt: at(27),
    })
    expect(rowMarks(r, base).since).toBeNull()
    expect(rowMarks(r, { ...base, lastCommentAt: at(28) }).since).toEqual({
      kind: 'changed',
      what: 'commented',
      at: at(28),
    })
    // the assignee's page reads the status change as on any other row
    expect(rowMarks(r, { ...base, person: 'ben' }).since).toEqual({
      kind: 'changed',
      what: 'moved to In Review',
      at: at(27),
    })
  })
  it("reads a review on the reviewer's page as handed or waiting", () => {
    const r = task({ key: 'QN-2', status: 'review', assignee: 'ben', reviewer: 'aisha' })
    const m = rowMarks({ ...r, reviewAt: at(28), updatedAt: at(28) }, base)
    expect(m.since).toEqual({ kind: 'handed', at: at(28) })
    expect(m.reviewFor).toBe('ben')
    expect(m.noReviewer).toBe(false)

    // handed before the sync, and nothing since the hand-off's own write
    const r2 = { ...r, reviewAt: at(23), updatedAt: at(23) + 400 }
    expect(rowMarks(r2, base).since).toEqual({ kind: 'waiting', at: at(23) })
    // however long ago that sync was: the brief tests the hand-off only
    expect(rowMarks(r2, { ...base, since: at(27) }).since).toEqual({ kind: 'waiting', at: at(23) })
    // a comment or a later write since the hand-off is a touch
    expect(rowMarks(r2, { ...base, lastCommentAt: at(24) }).since).toBeNull()
    expect(rowMarks({ ...r2, updatedAt: at(24) }, base).since).toBeNull()
    expect(rowMarks(r2, { ...base, lastCommentAt: at(27) }).since).toEqual({
      kind: 'changed',
      what: 'commented',
      at: at(27),
    })
  })
  it('keeps an old hand-off when Remaining is edited later', () => {
    const r = task({
      key: 'QN-2',
      status: 'review',
      assignee: 'ben',
      reviewer: 'aisha',
      reviewAt: at(23),
      updatedAt: at(23),
    })
    // re-estimated in the sync: a later write, not a hand-off
    const edited = { ...r, remaining: 3, updatedAt: at(29, 9) }
    expect(edited.reviewAt).toBe(at(23))
    expect(rowMarks(edited, base).since).toBeNull()
  })
  it('says neither handed nor waiting when the hand-off is unknown', () => {
    const r = task({
      key: 'QN-2',
      status: 'review',
      assignee: 'ben',
      reviewer: 'aisha',
      updatedAt: at(28),
    })
    expect(rowMarks(r, base).since).toBeNull()
    expect(rowMarks({ ...r, updatedAt: at(23) }, base).since).toBeNull()
    expect(rowMarks(r, { ...base, lastCommentAt: at(28, 12) }).since).toMatchObject({
      kind: 'changed',
      what: 'commented',
    })
  })
  it("flags a review nobody does on the assignee's page", () => {
    const r = task({ key: 'QN-3', status: 'review', assignee: 'aisha' })
    const m = rowMarks(r, base)
    expect(m.noReviewer).toBe(true)
    expect(m.reviewFor).toBeNull()
    // reviewing your own task is not "for" anyone
    const own = task({ key: 'QN-4', status: 'review', assignee: 'aisha', reviewer: 'aisha' })
    expect(rowMarks(own, base).reviewFor).toBeNull()
  })
  it('carries the verdict, the pause, a missing estimate and the open blockers', () => {
    const open = task({ key: 'QN-12', status: 'progress' })
    const done = task({ key: 'QN-13', status: 'done' })
    const t = task({
      key: 'QN-1',
      paused: true,
      remaining: undefined,
      links: [
        { type: 'blocked_by', id: 'QN-12' },
        { type: 'blocked_by', id: 'QN-13' },
        { type: 'blocked_by', id: 'QN-99' }, // not visible to the viewer
        { type: 'blocks', id: 'QN-14' },
      ],
    })
    const m = rowMarks(t, { ...base, verdict: 'late', issueById: byId(open, done) })
    expect(m).toMatchObject({
      verdict: 'late',
      paused: true,
      noEstimate: true,
      blockedBy: ['QN-12'],
    })
    expect(rowMarks(task({ key: 'QN-2' }), base)).toMatchObject({
      verdict: null,
      paused: false,
      noEstimate: false,
      blockedBy: [],
    })
  })
})

describe('bannerVerdict and blockersOf', () => {
  it('follows the board banner: tracked, and never on track', () => {
    expect(bannerVerdict({ status: 'late' }, true)).toBe('late')
    expect(bannerVerdict({ status: 'behind' }, true)).toBe('behind')
    expect(bannerVerdict({ status: 'ok' }, true)).toBeNull()
    expect(bannerVerdict({ status: 'late' }, false)).toBeNull()
    expect(bannerVerdict(null, true)).toBeNull()
  })
  it('treats a group blocker as open until all its leaves are done', () => {
    const leafA = task({ key: 'QN-2', status: 'done' })
    const leafB = task({ key: 'QN-3', status: 'progress' })
    const group = task({ key: 'QN-1', status: 'todo', children: ['QN-2', 'QN-3'] })
    const t = task({ key: 'QN-9', links: [{ type: 'blocked_by', id: 'QN-1' }] })
    expect(blockersOf(t, byId(group, leafA, leafB))).toEqual(['QN-1'])
    expect(blockersOf(t, byId(group, leafA, { ...leafB, status: 'done' }))).toEqual([])
  })
})

describe('waitingOnReview and doneSince', () => {
  it("lists the person's own tasks someone else reviews, longest waiting first", () => {
    const rows = [
      task({
        key: 'QN-1',
        status: 'review',
        assignee: 'aisha',
        reviewer: 'leo',
        reviewAt: at(26),
      }),
      task({
        key: 'QN-2',
        status: 'review',
        assignee: 'aisha',
        reviewer: 'ben',
        updatedAt: at(27),
      }),
      task({ key: 'QN-3', status: 'review', assignee: 'aisha', reviewer: 'aisha' }),
      task({ key: 'QN-4', status: 'review', assignee: 'aisha' }),
      task({ key: 'QN-5', status: 'progress', assignee: 'aisha', reviewer: 'leo' }),
      task({ key: 'QN-6', status: 'review', assignee: 'aisha', reviewer: 'nora' }),
    ]
    // an unknown hand-off (QN-2, QN-6) is listed, last and without an age
    expect(waitingOnReview('aisha', rows)).toEqual([
      { issue: rows[0], reviewer: 'leo', since: at(26) },
      { issue: rows[1], reviewer: 'ben', since: null },
      { issue: rows[5], reviewer: 'nora', since: null },
    ])
  })
  it('lists what the person finished or reviewed since, newest first', () => {
    const since = at(25, 0)
    const reviewed = { status: 'done', assignee: 'ben', reviewer: 'aisha' } as const
    const issues = [
      task({ key: 'QN-1', status: 'done', assignee: 'aisha', doneAt: at(26) }),
      task({ key: 'QN-2', ...reviewed, reviewAt: at(27), doneAt: at(28) }),
      // named reviewer ahead of time, moved In Progress to Done: never reviewed
      task({ key: 'QN-8', ...reviewed, doneAt: at(28) }),
      task({ key: 'QN-3', status: 'done', assignee: 'aisha', doneAt: at(24) }),
      task({ key: 'QN-4', status: 'done', assignee: 'aisha', doneAt: at(27), project: 'S9' }),
      task({ key: 'QN-5', status: 'done', assignee: 'ben', doneAt: at(27) }),
      task({ key: 'QN-6', status: 'progress', assignee: 'aisha', doneAt: null }),
      task({ key: 'QN-7', status: 'done', assignee: 'aisha', doneAt: at(25, 0) }),
    ]
    const got = doneSince('aisha', issues, new Set(['S1']), since)
    expect(got.map((d) => [d.issue.key, d.kind])).toEqual([
      ['QN-2', 'reviewed'],
      ['QN-1', 'done'],
      ['QN-7', 'done'],
    ])
  })
})

describe('the team opening', () => {
  const verdicts: Record<string, 'behind' | 'late' | null> = {
    'QN-1': 'late',
    'QN-2': 'late',
    'QN-3': 'behind',
  }
  const blocker = task({ key: 'QN-50', status: 'todo' })
  const rows = [
    task({ key: 'QN-1', due: '2026-09-20' }), // overdue and Delayed
    task({ key: 'QN-2', due: '2026-10-20' }), // projected to miss
    task({ key: 'QN-3', paused: true }), // slipping, paused
    task({ key: 'QN-4', links: [{ type: 'blocked_by', id: 'QN-50' }] }),
    task({ key: 'QN-5', due: '2026-09-28' }), // overdue, not tracked
    task({ key: 'QN-6', due: '2026-09-29' }), // due today is not overdue
    task({ key: 'QN-7', due: '2026-09-01', status: 'done' }),
    task({ key: 'QN-8', due: '2026-09-01', children: ['QN-1'] }),
  ]
  const facts = openingFacts(rows, {
    verdictOf: (it) => verdicts[it.key] ?? null,
    issueById: byId(blocker),
    today: DAY.today,
  })

  it('counts over open leaf tasks, overdue ungated, projected not past due', () => {
    expect(facts).toEqual({
      overdue: 2,
      projected: 1,
      delayed: 2,
      slipping: 1,
      blocked: 1,
      paused: 1,
    })
  })

  const text = (parts: SentencePart[]) =>
    parts.map((p) => (typeof p === 'string' ? p : String(p.n))).join('')
  it('says overdue, then projected, then blocked, in one sentence', () => {
    const parts = syncSentence({ overdue: 13, projected: 6, blocked: 4 })
    expect(text(parts)).toBe(
      '13 tasks are overdue, 6 more are projected to miss their due date, and 4 are blocked.',
    )
    expect(parts.filter((p) => typeof p !== 'string')).toEqual([
      { n: 13, tone: 'danger' },
      { n: 6, tone: 'danger' },
      { n: 4, tone: 'warning' },
    ])
    expect(text(syncSentence({ overdue: 1, projected: 0, blocked: 1 }))).toBe(
      '1 task is overdue and 1 is blocked.',
    )
    expect(text(syncSentence({ overdue: 0, projected: 1, blocked: 0 }))).toBe(
      '1 task is projected to miss its due date.',
    )
    expect(text(syncSentence({ overdue: 0, projected: 0, blocked: 3 }))).toBe(
      '3 tasks are blocked.',
    )
  })
  it('still says something when nothing is wrong', () => {
    expect(syncSentence({ overdue: 0, projected: 0, blocked: 0 })).toEqual([
      'No task is overdue, projected to miss its due date, or blocked.',
    ])
  })
})

describe('needsOwner and needsReviewer', () => {
  const scope = new Set(['S1'])
  it('asks about unassigned committed work, soonest due first', () => {
    const issues = [
      task({ key: 'QN-1', priority: 'urgent' }),
      task({ key: 'QN-2', priority: 'high', status: 'progress', due: '2026-10-09' }),
      task({ key: 'QN-3', start: 11 }),
      task({ key: 'QN-4', status: 'backlog', due: '2026-10-13' }),
      task({ key: 'QN-5', status: 'review', owner: 'nora', reviewer: 'nora', due: '2026-10-02' }),
      task({ key: 'QN-6', priority: 'low', due: '2026-10-09' }),
    ]
    expect(keys(needsOwner(issues, scope, DAY))).toEqual([
      'QN-5',
      'QN-2',
      'QN-6',
      'QN-4',
      'QN-1',
      'QN-3',
    ])
  })
  it('leaves out uncommitted, assigned, finished, group and out-of-scope work', () => {
    const issues = [
      task({ key: 'QN-1', start: 12 }), // planned later, medium, no due date
      task({ key: 'QN-2', status: 'backlog', priority: 'urgent' }), // Backlog without a date
      task({ key: 'QN-3', status: 'backlog', due: '2026-10-14' }), // due in 15 days
      task({ key: 'QN-4', priority: 'urgent', assignee: 'ben' }),
      task({ key: 'QN-5', status: 'done', due: '2026-10-01' }),
      task({ key: 'QN-6', priority: 'urgent', children: ['QN-7'] }),
      task({ key: 'QN-7', priority: 'urgent', project: 'S9' }),
    ]
    expect(needsOwner(issues, scope, DAY)).toEqual([])
  })
  it('lists reviews nobody does, longest waiting first, an unknown wait last', () => {
    const rows = [
      task({ key: 'QN-1', status: 'review', assignee: 'ben', updatedAt: at(27) }),
      task({ key: 'QN-2', status: 'review', assignee: 'ben', reviewAt: at(24) }),
      task({ key: 'QN-3', status: 'review', assignee: 'ben', reviewer: 'leo' }),
      task({ key: 'QN-4', status: 'progress', assignee: 'ben' }),
      task({ key: 'QN-5', status: 'review', assignee: 'ben', updatedAt: at(20) }),
      task({ key: 'QN-6', status: 'review', assignee: 'ben', reviewAt: at(26) }),
    ]
    const order = (list: SyncIssue[]) => needsReviewer(list).map((r) => [r.issue.key, r.since])
    expect(order(rows)).toEqual([
      ['QN-2', at(24)],
      ['QN-6', at(26)],
      ['QN-1', null],
      ['QN-5', null],
    ])
    // a Remaining edit on the oldest review keeps its place
    const edited = rows.map((t) => (t.key === 'QN-2' ? { ...t, remaining: 1, updatedAt: NOW } : t))
    expect(order(edited)).toEqual(order(rows))
  })
})

describe('milestones', () => {
  const ms = [
    { id: 'a', name: 'Pilot', week: 12, project: 'M1' },
    { id: 'b', name: 'Proto', week: 11, project: 'M1' },
    { id: 'c', name: 'Launch', week: 13, project: 'M1' },
    { id: 'd', name: 'Past', week: 10, project: 'M1' },
    { id: 'e', name: 'Elsewhere', week: 11, project: 'M9' },
  ]
  it('keeps this week and next, in scope, by week', () => {
    expect(milestonesAhead(ms, new Set(['M1']), 11).map((m) => m.id)).toEqual(['b', 'a'])
  })
  it('finds the next one however far, or none', () => {
    expect(nextMilestone(ms, new Set(['M1']), 11)?.id).toBe('b')
    expect(nextMilestone(ms, new Set(['M1']), 13)?.id).toBe('c')
    expect(nextMilestone(ms, new Set(['M1']), 14)).toBeNull()
  })
})

describe('load figures', () => {
  it('states a person as a percentage in the strip tone, an agent as hours', () => {
    expect(loadFigure(28.2, 32)).toEqual({ hours: 28.2, capacity: 32, pct: 88, tone: 'normal' })
    expect(loadFigure(28.8, 32)).toMatchObject({ pct: 90, tone: 'near' })
    expect(loadFigure(32, 32)).toMatchObject({ pct: 100, tone: 'near' })
    expect(loadFigure(32.4, 32)).toMatchObject({ pct: 101, tone: 'over' })
    expect(loadFigure(12, Infinity)).toEqual({
      hours: 12,
      capacity: null,
      pct: null,
      tone: 'agent',
    })
  })
  it('lists the people near or over capacity, highest first', () => {
    const people = [
      { id: 'a', name: 'Aisha', isAgent: false, teams: [] },
      { id: 'b', name: 'Ben', isAgent: false, teams: [] },
      { id: 'd', name: 'Daniel', isAgent: false, teams: [] },
      { id: 'x', name: 'Atlas', isAgent: true, teams: [] },
    ]
    const hours: Record<string, number> = { a: 28, b: 32, d: 42, x: 400 }
    const got = nearCapacity(people, (u) => loadFigure(hours[u.id], u.isAgent ? Infinity : 32))
    expect(got.map((x) => [x.user.id, x.figure.pct])).toEqual([
      ['d', 131],
      ['b', 100],
    ])
  })
})

describe('dates', () => {
  it('names today, yesterday, else the weekday and date', () => {
    expect(dayLabel(at(29, 1), NOW)).toBe('today')
    expect(dayLabel(at(28, 23), NOW)).toBe('yesterday')
    expect(dayLabel(at(24), NOW)).toBe('Thu 24 Sep')
    expect(stampLabel(at(24), NOW)).toBe('Last sync Thu 24 Sep')
    expect(stampLabel(at(28), NOW)).toBe('Last sync yesterday')
  })
  it('names the sync before the current sitting', () => {
    const iso = (ms: number) => new Date(ms).toISOString()
    expect(previousSync(null, NOW)).toBeNull()
    // a sitting over: the stamp itself
    expect(previousSync({ at: iso(at(24)) }, NOW)).toBe(at(24))
    // a sitting on (an hour ago): its since, never the sitting's own change
    expect(previousSync({ at: iso(at(29, 9)), since: iso(at(24)) }, NOW)).toBe(at(24))
    expect(previousSync({ at: iso(at(29, 9)), since: iso(at(24)) }, NOW)).not.toBe(at(29, 9))
    // the first sitting ever: nothing before it, its reading day included
    expect(previousSync({ at: iso(at(29, 9)) }, NOW)).toBeNull()
    expect(previousSync({ at: iso(at(29, 9)), since: '2026-09-28' }, NOW)).toBeNull()
    // once that sitting is over, it is the last sync
    expect(previousSync({ at: iso(at(28, 9)), since: '2026-09-25' }, NOW)).toBe(at(28, 9))
  })
  it('counts the wait in calendar days', () => {
    expect(waitingLabel(at(29, 8), NOW)).toBe('waiting since today')
    expect(waitingLabel(at(28, 23), NOW)).toBe('waiting 1 day')
    expect(waitingLabel(at(26), NOW)).toBe('waiting 3 days')
  })
  it("builds today's comparisons from the clock", () => {
    const d = syncDay(NOW)
    expect(d.today).toBe('2026-09-29')
    // the default week starts on Monday, so it ends on Sunday
    expect(d.weekEnd).toBe('2026-10-04')
    expect(d.weekEnd).not.toBe('2026-10-05')
  })
})

describe('mentionBody', () => {
  // the server's pattern, copied from convex/model/messages.ts
  const MENTION_RE =
    /@\[[^\][]*\]\([ \t]*user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[ \t]*\)/gi
  const uuid = '0b7d6f4e-1c2a-4d3b-9e8f-7a6b5c4d3e2f'
  const mentioned = (body: string) => [...body.matchAll(MENTION_RE)].map((m) => m[1])

  it('posts a mention the server notifies, then the note', () => {
    const body = mentionBody({ id: uuid, name: 'Aisha Rahman' }, '  is the review blocking you?  ')
    expect(body).toBe(`@[Aisha Rahman](user:${uuid}) is the review blocking you?`)
    expect(mentioned(body)).toEqual([uuid])
  })
  it('keeps a bracketed name and markdown in the note from breaking the mention', () => {
    const body = mentionBody({ id: uuid, name: 'Aisha [K] Khan' }, '*now* [x](user:y) #1')
    expect(mentioned(body)).toEqual([uuid])
    expect(body.startsWith('@[Aisha _K_ Khan]')).toBe(true)
    // the note reads back as text, not as emphasis or a link
    const [p] = parseMd(body)
    expect(p).toMatchObject({ t: 'p' })
    const inline = p.t === 'p' ? p.children : []
    expect(inline.filter((n) => n.t === 'mention')).toHaveLength(1)
    expect(inline.some((n) => n.t === 'italic' || n.t === 'link')).toBe(false)
  })
  it('keeps the lines of a longer note', () => {
    const body = mentionBody({ id: uuid, name: 'Ben' }, 'first\nsecond')
    expect(body).toBe(`@[Ben](user:${uuid}) first\nsecond`)
    // a hand-built body without the serializer is not a mention at all
    expect(mentioned(`@Ben(user:${uuid}) first`)).toEqual([])
  })
})

/* The Northstar seed (convex/internal/marketingDemoData.ts) through these
   rules: a public demo provisioned on its anchor Monday and synced on the
   Wednesday. Every state the page can say appears somewhere. */
describe('the Northstar seed', () => {
  const { people, issues, comments, projects } = MARKETING_DEMO
  const ANCHOR = '2026-09-28'
  const instant = (day: number, time: string) => Date.parse(marketingInstant(ANCHOR, day, time))
  const seeded = instant(0, '08:00:00.000Z')
  const now = instant(2, '10:00:00.000Z')
  // the latest comment per task, dated as the seed dates them (14:00, then a
  // minute per same-day reply)
  const lastComment = new Map<string, number>()
  const replies = new Map<string, number>()
  for (const c of [...comments].sort((a, b) => a.day - b.day)) {
    const n = replies.get(`${c.issue}:${c.day}`) ?? 0
    replies.set(`${c.issue}:${c.day}`, n + 1)
    const at = instant(c.day, '14:00:00.000Z') + n * 60_000
    lastComment.set(c.issue, Math.max(lastComment.get(c.issue) ?? 0, at))
  }
  const parents = new Set(issues.map((i) => i.parent))
  const tasks = issues
    .filter((i) => !i.archived && !parents.has(i.key))
    .map((i) => {
      const times = northstarTaskTimes(ANCHOR, new Date(seeded).toISOString(), i)
      const ms = (iso: string | undefined) => (iso === undefined ? null : Date.parse(iso))
      return task({
        key: i.key,
        project: i.project,
        status: i.status,
        priority: i.priority,
        assignee: i.assignee,
        reviewer: i.reviewer,
        owner: taskOwnerId({ status: i.status, assignee_id: i.assignee, reviewer_id: i.reviewer }),
        remaining: i.remaining,
        paused: !!i.paused,
        updatedAt: Date.parse(times.updated),
        doneAt: ms(times.done),
        reviewAt: ms(times.review),
        statusAt: Date.parse(times.status),
        createdAt: Date.parse(times.created),
      })
    })
  const sinceOf = (key: string) => {
    const day = people.find((p) => p.key === key)?.syncDay
    const stamp = day === undefined ? null : { at: marketingInstant(ANCHOR, day, DEMO_SYNC_TIME) }
    return syncSince(stamp, now)
  }

  it('reads untouched work, waiting and handed reviews on the owners’ pages', () => {
    const byKind = new Map<SinceMark['kind'], string[]>()
    const moves: [string, string][] = []
    for (const t of tasks) {
      // the page's rows: To Do, In Progress and In Review
      if (t.status === 'backlog' || t.status === 'done' || !t.owner) continue
      if (t.owner === 'atlas') continue // an agent is not synced
      const m = rowMarks(t, {
        person: t.owner,
        since: sinceOf(t.owner),
        verdict: null,
        issueById: {},
        lastCommentAt: lastComment.get(t.key) ?? null,
      }).since
      if (m) byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), t.key].sort())
      if (m?.kind === 'changed' && m.what !== 'commented') moves.push([t.key, m.what])
    }
    expect(byKind.get('untouched')).toEqual(['landing-copy', 'room-cards'])
    // Nora, never synced, reads from Tuesday; Ben synced on Friday
    expect(byKind.get('waiting')).toEqual(['installation-checklist', 'onboarding-guide'])
    expect(byKind.get('handed')).toEqual([
      'bom-alternates',
      'dashboard-regression',
      'device-onboarding-design',
      'pcb-review',
      'wifi-setup',
    ])
    expect(byKind.get('changed')).toEqual(
      expect.arrayContaining(['support-playbook', 'offline-buffer']),
    )
    // Ben moved it into To Do on Friday after his sync; its last comment is older
    expect(moves).toEqual([['birch-installation', 'moved to To Do']])
  })

  it('credits a review to Done to its reviewer, and the work to its assignee', () => {
    const all = new Set(projects.map((p) => p.key))
    const done = (key: string) =>
      doneSince(key, tasks, all, sinceOf(key)).map((d) => [d.issue.key, d.kind])
    expect(done('daniel')).toContainEqual(['design-tokens', 'reviewed'])
    expect(done('sofia')).toContainEqual(['design-tokens', 'done'])
  })
})

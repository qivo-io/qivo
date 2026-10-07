/* Team sync: the pure rules behind the meeting page (docs/team-sync-brief.md).
   Everything here is a function of plain inputs (tasks, people, projects, the
   activity feed, the latest comment per task, a reading point and today), so
   the page reads the store once per render and the rules test on small
   fixtures. Nothing here writes, and nothing imports the store at runtime.

   Vocabulary, as the brief uses it:
   · a ROW is an open (To Do, In Progress, In Review) leaf task in scope;
   · a task's OWNER is `IssueVM.owner`: the reviewer while it waits In Review
     with one, else the assignee (convex/lib/review.ts);
   · `since` is the page owner's reading point in ms (convex/lib/teamSync.ts
     `syncSince`): "Done since", "untouched" and "changed" all read from it. */
import { isReadingDay, SYNC_SITTING_MS, type SyncStamp } from '../../convex/lib/teamSync'
import type { ActivityVM, IssueVM, MilestoneVM, ProjectVM, TeamVM, UserVM } from '../store/planner'
import { fmtDate, isoFromDate, isoToDate, TODAY_WEEK, WEEKDAYS, weekStartOf } from './dates'
import type { DelayInfo } from './delay'
import { isIssueDone, isIssueGroup } from './issueGroups'
import type { MdInline } from './md'
import { astToMd } from './mdSerialize'
import { hasPlannableWeek, type LoadTone, loadTone } from './workload'

/* ---- input shapes: the slices of the store's view models the rules read -- */

export type SyncIssue = Pick<
  IssueVM,
  | 'id'
  | 'key'
  | 'uuid'
  | 'project'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'reviewer'
  | 'owner'
  | 'isGroup'
  | 'children'
  | 'hasHiddenSubtasks'
  | 'links'
  | 'start'
  | 'due'
  | 'remaining'
  | 'paused'
  | 'updatedAt'
  | 'doneAt'
  | 'reviewAt'
>
export type SyncStatus = IssueVM['status']
export type SyncUser = Pick<UserVM, 'id' | 'name' | 'isAgent' | 'teams'>
export type SyncEvent = Pick<ActivityVM, 'ts' | 'verb' | 'targetType' | 'targetId' | 'detail'>
export type SyncProject = Pick<
  ProjectVM,
  'id' | 'type' | 'org' | 'parent' | 'children' | 'teamAccess'
>
export type SyncTeam = Pick<TeamVM, 'id' | 'org'>
export type SyncMilestone = Pick<MilestoneVM, 'id' | 'name' | 'week' | 'project'>
/** What a blocker lookup needs: its display key and whether it is finished
    (a group is finished when all its known leaves are, as `P.isDone`). */
export type BlockerIssue = Pick<
  IssueVM,
  'id' | 'key' | 'status' | 'children' | 'isGroup' | 'hasHiddenSubtasks'
>

/** The board banner's verdict: Slipping (`behind`), Delayed (`late`), or nothing. */
export type Verdict = 'behind' | 'late' | null

const OPEN = new Set<SyncStatus>(['todo', 'progress', 'review'])
const DAY = 86400000
/* The hand-off's own write lands with it (one server `now`); this much slack
   keeps a client paint or a later event of the same write from reading as
   activity after the hand-off. */
const HANDOFF_SLACK_MS = 1000

/* The activity feed's status names (convex/model/activity.ts STATUS_NAMES),
   which the narrations below are parsed from and the marks are worded in. */
const STATUS_NAMES: Record<SyncStatus, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  progress: 'In Progress',
  review: 'In Review',
  done: 'Done',
}
const STATUS_BY_NAME = new Map(
  Object.entries(STATUS_NAMES).map(([id, name]) => [name, id as SyncStatus]),
)
const PRIORITY_RANK: Record<IssueVM['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 }

/* ---- today ---------------------------------------------------------------- */

/** Today in the terms the rules compare with: the grid's week index, and
    today's and this week's last day as ISO dates (due dates are ISO strings). */
export type SyncDay = { todayWeek: number; today: string; weekEnd: string }

/** The `SyncDay` of `now`, on the org's week grid (dates.ts, which the store
    configures). Computed from `now` rather than `TODAY_ISO`, which is fixed
    at module load and goes stale in a tab left open past midnight. */
export function syncDay(now: number): SyncDay {
  const end = weekStartOf(new Date(now))
  end.setDate(end.getDate() + 6)
  return { todayWeek: TODAY_WEEK, today: isoFromDate(new Date(now)), weekEnd: isoFromDate(end) }
}

function addDays(iso: string, days: number): string {
  const d = isoToDate(iso)
  d.setDate(d.getDate() + days)
  return isoFromDate(d)
}

/** Whole calendar days from `at` to `now`, by local midnights. */
function daysBetween(at: number, now: number): number {
  const a = new Date(at)
  const b = new Date(now)
  a.setHours(0, 0, 0, 0)
  b.setHours(0, 0, 0, 0)
  return Math.round((b.getTime() - a.getTime()) / DAY)
}

/** A moment as the sync says it: "today", "yesterday", else "Thu 24 Sep"
    (the weekday, then the date in the org's day/month order). */
export function dayLabel(at: number, now: number): string {
  const days = daysBetween(at, now)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  const d = new Date(at)
  return `${WEEKDAYS[d.getDay()].slice(0, 3)} ${fmtDate(d)}`
}

/** The person header's "Last sync Thu 24 Sep" for a stamp's `at` (ms). */
export function stampLabel(at: number, now: number): string {
  return `Last sync ${dayLabel(at, now)}`
}

/** The previous sync the person header names (ms): the stamp once its
    sitting is over; while a sitting is on, the sync before it, which is the
    stamp's `since`. Null for a person never synced, or whose first sitting
    this is: the sitting's own changes are not a previous sync, and a first
    sitting's `since` is the day it reads from, not a sync. */
export function previousSync(stamp: SyncStamp | null, now: number): number | null {
  if (!stamp) return null
  const at = Date.parse(stamp.at)
  if (now - at > SYNC_SITTING_MS) return at
  return stamp.since && !isReadingDay(stamp.since) ? Date.parse(stamp.since) : null
}

/** How long a review has waited: "waiting since today", "waiting 1 day",
    "waiting 3 days". An unknown hand-off shows no age at all. */
export function waitingLabel(at: number, now: number): string {
  const days = Math.max(0, daysBetween(at, now))
  if (days === 0) return 'waiting since today'
  return `waiting ${days} ${days === 1 ? 'day' : 'days'}`
}

/* ---- scope ------------------------------------------------------------------ */

/** Which projects a sync covers: every project, a team's projects, or one. */
export type SyncScope =
  | { kind: 'all' }
  | { kind: 'team'; id: string }
  | { kind: 'project'; id: string }

/** The saved form (`UIPrefs.syncScope`, the route's scope): `'all'`,
    `'team:<uuid>'` or `'project:<uuid>'`. Anything else reads as all. */
export function parseSyncScope(pref: string | null | undefined): SyncScope {
  const m = /^(team|project):(.+)$/.exec(pref || '')
  if (!m) return { kind: 'all' }
  return m[1] === 'team' ? { kind: 'team', id: m[2] } : { kind: 'project', id: m[2] }
}

export function syncScopeKey(scope: SyncScope): string {
  return scope.kind === 'all' ? 'all' : `${scope.kind}:${scope.id}`
}

/** What scope resolution reads: the home organization (the sync is always
    about it), the projects and teams the viewer has, and the visibility test
    (`P.canSee`). */
export type ScopeWorld = {
  homeOrg: string
  projects: readonly SyncProject[]
  teams: readonly SyncTeam[]
  canSee: (projectId: string) => boolean
}

/** The scope as it can be honoured: a team or project that no longer exists,
    belongs to another organization or is out of sight falls back to all. */
export function resolveSyncScope(scope: SyncScope, w: ScopeWorld): SyncScope {
  if (scope.kind === 'team') {
    return w.teams.some((t) => t.id === scope.id && t.org === w.homeOrg) ? scope : { kind: 'all' }
  }
  if (scope.kind === 'project') {
    const p = w.projects.find((x) => x.id === scope.id)
    return p && p.org === w.homeOrg && w.canSee(p.id) ? scope : { kind: 'all' }
  }
  return scope
}

/* The top-level projects a scope reaches (metas, or sub-projects shared on
   their own), each with the sub-projects it contributes. */
function scopeRoots(scope: SyncScope, w: ScopeWorld): SyncProject[] {
  const s = resolveSyncScope(scope, w)
  const home = w.projects.filter((p) => p.org === w.homeOrg && w.canSee(p.id))
  if (s.kind === 'project') return home.filter((p) => p.id === s.id)
  if (s.kind === 'team') return home.filter((p) => p.teamAccess[s.id] !== undefined)
  return home.filter((p) => p.type === 'meta')
}

/** The sub-project ids in scope (tasks live only in sub-projects): all = every
    visible sub-project of the home organization; team = the sub-projects of
    every project shared with the team (a meta's share reaches its children);
    project = that project's sub-projects, or the sub-project itself. */
export function scopeProjectIds(scope: SyncScope, w: ScopeWorld): Set<string> {
  const out = new Set<string>()
  for (const p of scopeRoots(scope, w)) {
    if (p.type !== 'meta') out.add(p.id)
    else for (const id of p.children || []) if (w.canSee(id)) out.add(id)
  }
  return out
}

/** The meta project ids in scope, whose milestones the team opening lists. */
export function scopeMetaIds(scope: SyncScope, w: ScopeWorld): Set<string> {
  const out = new Set<string>()
  for (const p of scopeRoots(scope, w)) {
    if (p.type === 'meta') out.add(p.id)
    else if (p.parent) out.add(p.parent)
  }
  return out
}

/* ---- rows, roster, a person's page ------------------------------------------ */

/** The walk's rows: open (To Do, In Progress, In Review) leaf tasks whose
    sub-project is in scope. The store holds no archived task. */
export function syncRows<I extends SyncIssue>(issues: readonly I[], subIds: Set<string>): I[] {
  return issues.filter((it) => OPEN.has(it.status) && !isIssueGroup(it) && subIds.has(it.project))
}

/** Everyone who owns a row, in walk order: humans by name, then the agents
    (one collapsed final step). Team scope keeps only that team's members.
    Deactivated owners stay: the work is still theirs. */
export function syncRoster<U extends SyncUser>(
  rows: readonly SyncIssue[],
  users: readonly U[],
  scope: SyncScope,
): { humans: U[]; agents: U[] } {
  const owners = new Set(rows.map((it) => it.owner).filter(Boolean))
  const walk = users
    .filter((u) => owners.has(u.id) && (scope.kind !== 'team' || u.teams.includes(scope.id)))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return { humans: walk.filter((u) => !u.isAgent), agents: walk.filter((u) => u.isAgent) }
}

/** The order inside every group, stable from day to day: no estimate first,
    then the Estimates walk's order (planned start week, planned before
    unplanned; then due date, undated last), then the key. */
export function syncRowOrder(a: SyncIssue, b: SyncIssue): number {
  const ea = a.remaining == null ? 0 : 1
  const eb = b.remaining == null ? 0 : 1
  if (ea !== eb) return ea - eb
  if (a.start != null && b.start != null && a.start !== b.start) return a.start - b.start
  if ((a.start != null) !== (b.start != null)) return a.start != null ? -1 : 1
  if (a.due !== b.due) return !a.due ? 1 : !b.due ? -1 : a.due.localeCompare(b.due)
  return a.key.localeCompare(b.key, undefined, { numeric: true })
}

export type SyncGroupId = 'progress' | 'review' | 'week' | 'later'
export type SyncGroup<I> = { id: SyncGroupId; rows: I[] }

/** A person's rows, always the four groups in this order (empty ones
    included; the page decides what an empty group shows):
    · progress: In Progress;
    · review: In Review they own, which is the reviews they do plus their own
      tasks In Review with no reviewer (`rowMarks().noReviewer`);
    · week: To Do planned to start this week or earlier, or unplanned and due
      by the end of this week;
    · later: the other To Do. */
export function personGroups<I extends SyncIssue>(
  person: string,
  rows: readonly I[],
  day: SyncDay,
): SyncGroup<I>[] {
  const mine = rows.filter((it) => it.owner === person).sort(syncRowOrder)
  const thisWeek = (it: I) =>
    it.start != null ? it.start <= day.todayWeek : !!it.due && it.due <= day.weekEnd
  return [
    { id: 'progress', rows: mine.filter((it) => it.status === 'progress') },
    { id: 'review', rows: mine.filter((it) => it.status === 'review') },
    { id: 'week', rows: mine.filter((it) => it.status === 'todo' && thisWeek(it)) },
    { id: 'later', rows: mine.filter((it) => it.status === 'todo' && !thisWeek(it)) },
  ]
}

/* Longest waiting first; an unknown hand-off (null) last. */
function byHandoff(a: number | null, b: number | null): number {
  if (a === b) return 0
  if (a === null) return 1
  return b === null ? -1 : a - b
}

/** The quiet "Waiting on review" foot: the person's own tasks In Review with
    someone else reviewing, longest waiting first (`since` is the hand-off,
    null when unknown, and those last). Not rows of theirs. */
export function waitingOnReview<I extends SyncIssue>(
  person: string,
  rows: readonly I[],
  activity: readonly SyncEvent[],
): { issue: I; reviewer: string; since: number | null }[] {
  return rows
    .filter(
      (it) =>
        it.status === 'review' && it.assignee === person && !!it.reviewer && it.reviewer !== person,
    )
    .map((issue) => ({ issue, reviewer: issue.reviewer, since: handoffInstant(issue, activity) }))
    .sort((a, b) => byHandoff(a.since, b.since) || syncRowOrder(a.issue, b.issue))
}

/** "Done since": leaf tasks in scope that reached Done at or after `since`,
    newest first. `done` when the person was the assignee; `reviewed` when
    they reviewed someone else's task to Done: its reviewer, with a review
    hand-off that the move into Done kept (`reviewAt`, which any other way
    into Done clears). */
export function doneSince<I extends SyncIssue>(
  person: string,
  issues: readonly I[],
  subIds: Set<string>,
  since: number,
): { issue: I; kind: 'done' | 'reviewed' }[] {
  const out: { issue: I; kind: 'done' | 'reviewed' }[] = []
  for (const it of issues) {
    if (it.status !== 'done' || isIssueGroup(it) || !subIds.has(it.project)) continue
    if (it.doneAt == null || it.doneAt < since) continue
    if (it.assignee === person) out.push({ issue: it, kind: 'done' })
    else if (it.reviewer === person && it.reviewAt != null) {
      out.push({ issue: it, kind: 'reviewed' })
    }
  }
  return out.sort(
    (a, b) =>
      b.issue.doneAt - a.issue.doneAt ||
      a.issue.key.localeCompare(b.issue.key, undefined, { numeric: true }),
  )
}

/* ---- the activity feed ------------------------------------------------------- */

/* The machine grammar's status clause, `status In Progress → In Review`, as
   one element of the `(a → b, c → d)` diff (model/activity.ts issueChanges).
   Free text there has its arrows replaced, so a title cannot forge one. */
const MACHINE_STATUS =
  /(?:^\(|, )status (Backlog|To Do|In Progress|In Review|Done) → (Backlog|To Do|In Progress|In Review|Done)(?=[,)])/
const MACHINE_REVIEWER = /(?:^\(|, )reviewer [^,→]+ → (?!unset[,)])[^,→)]+(?=[,)])/

/** The status a task moved INTO, read from one activity event, or null.
    Browser writes narrate verb `moved` with `from <Status> to <Status>`;
    machine writes a diff holding `status <A> → <B>`. The other `moved`
    events (a parent or sub-project change) are not status moves. */
export function statusMoveOf(verb: string, detail: string | undefined): SyncStatus | null {
  if (!detail) return null
  if (verb === 'moved') {
    const m = /^from (.+) to (.+)$/.exec(detail)
    if (!m || m[1] === m[2] || !STATUS_BY_NAME.has(m[1])) return null
    return STATUS_BY_NAME.get(m[2]) || null
  }
  const m = MACHINE_STATUS.exec(detail)
  return m && m[1] !== m[2] ? STATUS_BY_NAME.get(m[2]) || null : null
}

/* A reviewer was named (not removed): the browser verb or a machine diff. */
function reviewerSet(e: SyncEvent): boolean {
  return e.verb === 'set the reviewer of' || (!!e.detail && MACHINE_REVIEWER.test(e.detail))
}

function eventsOf(handle: string, activity: readonly SyncEvent[]): SyncEvent[] {
  return activity
    .filter((e) => e.targetType === 'issue' && e.targetId === handle)
    .sort((a, b) => a.ts - b.ts)
}

/** When a task that is In Review now was handed to review, from the feed:
    its latest move into In Review, or a reviewer named later while it stayed
    there (moving in and then naming the reviewer are two writes). A reviewer
    named with no status move in the feed at all is a hand-off too: the feed
    drops its oldest events first, so the task has been In Review since.
    Null when the feed does not say: the task never moved in within the kept
    events (500 per org), or it has moved out since. `handle` is `IssueVM.id`,
    the feed's `targetId`. */
export function handoffAt(handle: string, activity: readonly SyncEvent[]): number | null {
  let at: number | null = null
  let moved = false
  for (const e of eventsOf(handle, activity)) {
    const to = statusMoveOf(e.verb, e.detail)
    if (to) {
      moved = true
      at = to === 'review' ? e.ts : null
    } else if ((at != null || !moved) && reviewerSet(e)) at = e.ts
  }
  return at
}

/** The hand-off instant of a task In Review: the server's stamp
    (`issues.review_at`), else the feed (a task handed over before the stamp
    existed), else null. Never a Remaining or last-write time, which move on
    edits that hand nothing over. */
export function handoffInstant(
  it: Pick<SyncIssue, 'id' | 'reviewAt'>,
  activity: readonly SyncEvent[],
): number | null {
  return it.reviewAt ?? handoffAt(it.id, activity)
}

/* ---- per-row marks -------------------------------------------------------------- */

/** The board banner's rule, from `P.delayOf` and `P.tracksDelay`: a verdict
    only for a project that tracks delay, and never for on track. */
export function bannerVerdict(delay: Pick<DelayInfo, 'status'> | null, tracks: boolean): Verdict {
  return tracks && delay && delay.status !== 'ok' ? delay.status : null
}

/** The display keys of the open tasks blocking this one ("is blocked by"
    links whose task is not Done). `issueById` is `P.issueById`; a blocker the
    viewer cannot see is not in it and says nothing. */
export function blockersOf(
  it: Pick<SyncIssue, 'links'>,
  issueById: Readonly<Record<string, BlockerIssue>>,
): string[] {
  const out: string[] = []
  for (const l of it.links) {
    const b = l.type === 'blocked_by' ? issueById[l.id] : undefined
    if (b && !isIssueDone(b, issueById)) out.push(b.key)
  }
  return out
}

/** The one "since the last sync" mark a row can carry. */
export type SinceMark =
  /** In Progress with nothing since `since`; `at` is the last touch */
  | { kind: 'untouched'; at: number }
  /** a review handed to the page owner after `since` */
  | { kind: 'handed'; at: number }
  /** a review handed over before `since` with nothing since the hand-off (no
      write, comment or activity event); `at` is the hand-off */
  | { kind: 'waiting'; at: number }
  /** the latest status move or comment after `since`, in the feed's words */
  | { kind: 'changed'; what: string; at: number }

export type RowMarks = {
  verdict: Verdict
  paused: boolean
  /** keys of open blockers */
  blockedBy: string[]
  noEstimate: boolean
  /** In Review with no reviewer: on the assignee's page */
  noReviewer: boolean
  /** on a reviewer's page, whose task it is ("for Aisha"); null for their own */
  reviewFor: string | null
  since: SinceMark | null
}

/** Everything a row says about itself on `person`'s page. `lastCommentAt` is
    the task's latest comment (`P.lastComments` by uuid); `activity` may be
    the whole feed or the task's own events. */
export function rowMarks(
  it: SyncIssue,
  o: {
    person: string
    since: number
    verdict: Verdict
    issueById: Readonly<Record<string, BlockerIssue>>
    lastCommentAt?: number
    activity: readonly SyncEvent[]
  },
): RowMarks {
  const reviewing = it.status === 'review' && !!it.reviewer && it.reviewer === o.person
  return {
    verdict: o.verdict,
    paused: !!it.paused,
    blockedBy: blockersOf(it, o.issueById),
    noEstimate: it.remaining == null,
    noReviewer: it.status === 'review' && !it.reviewer,
    reviewFor: reviewing && it.assignee && it.assignee !== o.person ? it.assignee : null,
    since: sinceMark(it, reviewing, o),
  }
}

function sinceMark(
  it: SyncIssue,
  reviewing: boolean,
  o: { since: number; lastCommentAt?: number; activity: readonly SyncEvent[] },
): SinceMark | null {
  const events = eventsOf(it.id, o.activity)
  const comment = o.lastCommentAt ?? null
  const lastTouch = Math.max(it.updatedAt, comment ?? 0, events.at(-1)?.ts ?? 0)
  if (it.status === 'progress' && lastTouch < o.since) return { kind: 'untouched', at: lastTouch }
  // an unknown hand-off (no stamp, not in the feed) says neither
  const handoff = reviewing ? handoffInstant(it, events) : null
  if (handoff != null) {
    if (handoff > o.since) return { kind: 'handed', at: handoff }
    if (lastTouch <= handoff + HANDOFF_SLACK_MS) return { kind: 'waiting', at: handoff }
  }
  let changed: SinceMark | null = null
  for (const e of events) {
    const to = e.ts > o.since ? statusMoveOf(e.verb, e.detail) : null
    if (to) changed = { kind: 'changed', what: `moved to ${STATUS_NAMES[to]}`, at: e.ts }
  }
  if (comment != null && comment > o.since && (!changed || comment >= changed.at)) {
    changed = { kind: 'changed', what: 'commented', at: comment }
  }
  return changed
}

/* ---- the team opening ------------------------------------------------------------- */

export type OpeningFacts = {
  /** due before today */
  overdue: number
  /** Delayed and not yet past due: projected to miss the due date */
  projected: number
  /** the board's Delayed, past due or not */
  delayed: number
  /** the board's Slipping */
  slipping: number
  /** with an open blocker the viewer can see */
  blocked: number
  paused: number
}

/** The opening's counts over the walk's rows (leaf, open, in scope; Done and
    groups never count). Overdue is not gated by delay tracking, as on the
    Overview; the verdicts are (`bannerVerdict`). */
export function openingFacts<I extends SyncIssue>(
  rows: readonly I[],
  o: {
    verdictOf: (it: I) => Verdict
    issueById: Readonly<Record<string, BlockerIssue>>
    today: string
  },
): OpeningFacts {
  const f: OpeningFacts = {
    overdue: 0,
    projected: 0,
    delayed: 0,
    slipping: 0,
    blocked: 0,
    paused: 0,
  }
  for (const it of rows) {
    if (it.status === 'done' || isIssueGroup(it)) continue
    const overdue = !!it.due && it.due < o.today
    const verdict = o.verdictOf(it)
    if (overdue) f.overdue++
    if (verdict === 'late') f.delayed++
    if (verdict === 'late' && !overdue) f.projected++
    if (verdict === 'behind') f.slipping++
    if (blockersOf(it, o.issueById).length) f.blocked++
    if (it.paused) f.paused++
  }
  return f
}

/** One piece of the opening sentence: text, or a count the page paints. */
export type SentencePart = string | { n: number; tone: 'danger' | 'warning' }

/** The one-sentence summary: overdue first, then projected misses, then
    blocked, stating only numbers the opening also shows; a calm line when
    all three are zero, so the sentence is never missing. */
export function syncSentence(
  f: Pick<OpeningFacts, 'overdue' | 'projected' | 'blocked'>,
): SentencePart[] {
  const tasks = (n: number) => (n === 1 ? 'task' : 'tasks')
  const is = (n: number) => (n === 1 ? 'is' : 'are')
  const clauses: SentencePart[][] = []
  if (f.overdue > 0) {
    clauses.push([
      { n: f.overdue, tone: 'danger' },
      ` ${tasks(f.overdue)} ${is(f.overdue)} overdue`,
    ])
  }
  if (f.projected > 0) {
    const n = f.projected
    const who = clauses.length ? `more ${is(n)}` : `${tasks(n)} ${is(n)}`
    const its = n === 1 ? 'its' : 'their'
    clauses.push([{ n, tone: 'danger' }, ` ${who} projected to miss ${its} due date`])
  }
  if (f.blocked > 0) {
    const n = f.blocked
    const who = clauses.length ? is(n) : `${tasks(n)} ${is(n)}`
    clauses.push([{ n, tone: 'warning' }, ` ${who} blocked`])
  }
  if (!clauses.length) return ['No task is overdue, projected to miss its due date, or blocked.']
  const out: SentencePart[] = []
  clauses.forEach((c, i) => {
    if (i > 0) out.push(clauses.length > 2 ? (i === clauses.length - 1 ? ', and ' : ', ') : ' and ')
    out.push(...c)
  })
  out.push('.')
  // adjacent text runs merge, so the parts alternate text and count
  return out.reduce<SentencePart[]>((acc, p) => {
    const last = acc.at(-1)
    if (typeof p === 'string' && typeof last === 'string') acc[acc.length - 1] = last + p
    else acc.push(p)
    return acc
  }, [])
}

/** "Needs an owner": unassigned leaf tasks in scope that someone has to pick
    up. Listed when open and Urgent or High, when open and planned to start
    this week or earlier, or when due within two weeks (or overdue) in any
    status but Done, Backlog included. Due date first (undated last), then
    priority, then key. `issues` is every task (Backlog is not a row). */
export function needsOwner<I extends SyncIssue>(
  issues: readonly I[],
  subIds: Set<string>,
  day: SyncDay,
): I[] {
  const horizon = addDays(day.today, 14)
  return issues
    .filter((it) => {
      if (it.assignee || isIssueGroup(it) || !subIds.has(it.project)) return false
      const open = OPEN.has(it.status)
      if (open && (it.priority === 'urgent' || it.priority === 'high')) return true
      if (open && it.start != null && it.start <= day.todayWeek) return true
      return it.status !== 'done' && !!it.due && it.due <= horizon
    })
    .sort(
      (a, b) =>
        (a.due === b.due ? 0 : !a.due ? 1 : !b.due ? -1 : a.due.localeCompare(b.due)) ||
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        a.key.localeCompare(b.key, undefined, { numeric: true }),
    )
}

/** "Needs a reviewer": rows In Review with no reviewer, longest waiting
    first (`since` is the hand-off instant; an unknown one, null, last). */
export function needsReviewer<I extends SyncIssue>(
  rows: readonly I[],
  activity: readonly SyncEvent[],
): { issue: I; since: number | null }[] {
  return rows
    .filter((it) => it.status === 'review' && !it.reviewer && !isIssueGroup(it))
    .map((issue) => ({ issue, since: handoffInstant(issue, activity) }))
    .sort(
      (a, b) =>
        byHandoff(a.since, b.since) ||
        a.issue.key.localeCompare(b.issue.key, undefined, { numeric: true }),
    )
}

/** The milestones of the metas in scope due this week or next, by week. */
export function milestonesAhead<M extends SyncMilestone>(
  milestones: readonly M[],
  metaIds: Set<string>,
  todayWeek: number,
): M[] {
  return milestones
    .filter((m) => metaIds.has(m.project) && m.week >= todayWeek && m.week <= todayWeek + 1)
    .sort((a, b) => a.week - b.week)
}

/** The strip's "Next milestone": the first in scope from this week on,
    however far (ties keep the store's creation order, as the Overview). */
export function nextMilestone<M extends SyncMilestone>(
  milestones: readonly M[],
  metaIds: Set<string>,
  todayWeek: number,
): M | null {
  const ahead = milestones
    .filter((m) => metaIds.has(m.project) && m.week >= todayWeek)
    .sort((a, b) => a.week - b.week)
  return ahead[0] || null
}

/* ---- load --------------------------------------------------------------------------- */

/** A person's week as the Team strip states it: hours over plannable hours,
    the rounded percentage and its tone. An agent has no week to divide by
    (`hasPlannableWeek`): hours only, tone `agent`. */
export type LoadFigure = {
  hours: number
  capacity: number | null
  pct: number | null
  tone: LoadTone | 'agent'
}

export function loadFigure(hours: number, capacity: number): LoadFigure {
  if (!hasPlannableWeek(capacity)) return { hours, capacity: null, pct: null, tone: 'agent' }
  const pct = Math.round((hours / capacity) * 100)
  return { hours, capacity, pct, tone: loadTone(pct) }
}

/** "Near or over capacity": the people whose week is near (90%) or over,
    highest first. `figureOf` reads the org-wide load (`P.weekLoadOf` over
    `plannableHoursOf`). */
export function nearCapacity<U extends SyncUser>(
  users: readonly U[],
  figureOf: (u: U) => LoadFigure,
): { user: U; figure: LoadFigure }[] {
  return users
    .map((user) => ({ user, figure: figureOf(user) }))
    .filter((x) => x.figure.tone === 'near' || x.figure.tone === 'over')
    .sort((a, b) => b.figure.pct - a.figure.pct || a.user.name.localeCompare(b.user.name))
}

/* ---- mention ------------------------------------------------------------------------ */

/** The comment the mention window posts: `@[Name](user:<uuid>)` and the note,
    through the canonical serializer, so the note's markdown characters are
    escaped and the label cannot break the server's mention pattern. Line
    breaks in the note are kept as hard breaks. */
export function mentionBody(user: Pick<UserVM, 'id' | 'name'>, text: string): string {
  const children: MdInline[] = [{ t: 'mention', id: user.id, name: user.name }]
  text
    .trim()
    .split(/\s*\n\s*/)
    .forEach((line, i) => {
      if (i > 0) children.push({ t: 'br' })
      children.push({ t: 'text', text: i === 0 ? ` ${line}` : line })
    })
  return astToMd([{ t: 'p', children }])
}

/* Team sync: the pure rules behind the meeting page (deviation #316, and the
   guide's docs/guide/planning-against-real-capacity.md#team-sync).
   Everything here is a function of plain inputs (tasks, people, the tasks'
   stamps, the latest comment per task, a reading point and today), so the
   page reads the store once per render and the rules test on small
   fixtures. The page runs them over the tasks the server's agenda names
   (convex/teamSync.ts agenda, views/teamSync/useSyncMeeting.ts), which
   decides the scope, the walk's people, the blockers, the verdicts and the
   week hours; the rules only sort, group and narrow. The page's former
   scope and blocker rules, which derived all that from the workspace's
   tasks, are the parity oracle's now (store/teamSyncOracle.setup.ts).
   Nothing here writes, and nothing imports the store at runtime.

   Vocabulary:
   · a ROW is an open (To Do, In Progress, In Review) leaf task in scope;
   · a task's OWNER is `IssueVM.owner`: the reviewer while it waits In Review
     with one, else the assignee (convex/lib/review.ts);
   · `since` is the page owner's reading point in ms (convex/lib/teamSync.ts
     `syncSince`): "Done since", "untouched" and "changed" all read from it. */
import { type LoadTask, loadRowFor } from '../../convex/lib/loadRows'
import { STATUS_NAMES } from '../../convex/lib/taskRefs'
import {
  askHorizon,
  doneSinceKind,
  isReadingDay,
  needsAnOwner,
  SYNC_SITTING_MS,
  type SyncStamp,
} from '../../convex/lib/teamSync'
import type { AgendaScope } from '../../convex/lib/teamSyncAgenda'
import type { Figure } from '../../convex/lib/viewLoads'
import type { IssueVM, UserVM } from '../store/planner'
import {
  fmtDate,
  isoFromDate,
  isoToWeek,
  TODAY_WEEK,
  tsToWeek,
  WEEKDAYS,
  weekStartOf,
} from './dates'
import type { DelayInfo } from './delay'
import { isIssueGroup } from './issueGroups'
import type { MdInline } from './md'
import { astToMd } from './mdSerialize'
import { committedByWeek, hasPlannableWeek, type LoadTone, loadTone } from './workload'

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
  | 'statusAt'
  | 'createdAt'
>
export type SyncStatus = IssueVM['status']
export type SyncUser = Pick<UserVM, 'id' | 'name' | 'isAgent'>

/** One person the meeting walks, as the agenda names them
    (convex/lib/teamSyncAgenda.ts AgendaPerson): their name, kind and
    activity, plannable hours as stored, their sync stamp, which their
    reading point reads, and their hours this week, or why they are not
    given. The page draws faces from the roster by id (components/qivo
    Avatar). */
export type SyncPerson = {
  id: string
  name: string
  isAgent: boolean
  active: boolean
  plannableHours: number | null
  stamp: SyncStamp | null
  week: Figure<{ hours: number }>
}

/** The board banner's verdict: Slipping (`behind`), Delayed (`late`), or nothing. */
export type Verdict = 'behind' | 'late' | null

/** A row's verdict as the agenda gives it: the banner's, or `unknown` where
    it needs its owner's load and the load was not read, never on track. */
export type SyncVerdict = Verdict | 'unknown'

const OPEN = new Set<SyncStatus>(['todo', 'progress', 'review'])
const DAY = 86400000
/* The hand-off's own write sets updated_at to the same instant (one server
   now, and the paint uses the row's updated_at); this slack keeps a write a
   moment later from reading as an edit after the hand-off. */
const HANDOFF_SLACK_MS = 1000
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

/** What a place's scope key names: a scope to ask the server for, none
    (nothing saved and none in the address), or a project an address names
    that the app cannot resolve (`segment`, as typed). Neither of the last
    two is ever read as another scope: the page asks to choose. */
export type SyncPlaceScope = SyncScope | { kind: 'none' } | { kind: 'unresolved'; segment: string }

/** The saved and routed form of a scope (`UIPrefs.teamSyncScope`, the
    route's scope): `'all'`, `'team:<uuid>'`, `'project:<uuid>'` or
    `'unresolved:<segment>'`. All projects is `'all'` alone; an empty key
    and anything else read as none, never as All projects. */
export function parseSyncScope(pref: string | null | undefined): SyncPlaceScope {
  if (pref === 'all') return { kind: 'all' }
  const unresolved = /^unresolved:(.*)$/s.exec(pref || '')
  if (unresolved) return { kind: 'unresolved', segment: unresolved[1] }
  const m = /^(team|project):(.+)$/.exec(pref || '')
  if (!m) return { kind: 'none' }
  return m[1] === 'team' ? { kind: 'team', id: m[2] } : { kind: 'project', id: m[2] }
}

/** The key of `scope` (parseSyncScope's form), `''` for none. */
export function syncScopeKey(scope: SyncPlaceScope): string {
  if (scope.kind === 'none') return ''
  if (scope.kind === 'all') return 'all'
  if (scope.kind === 'unresolved') return `unresolved:${scope.segment}`
  return `${scope.kind}:${scope.id}`
}

/* ---- the agenda's request ---------------------------------------------------- */

/** What Team sync asks the server for (convex/teamSync.ts agenda): the home
    organization, the scope and the client's clock, in this key order. */
export type SyncAgendaArgs = {
  org_id: string
  scope: AgendaScope
  day: string
  week: string
  week_starts: number[]
  week_end: number
}

/** The agenda's scope for `scope`, as the server takes it. */
export function agendaScopeOf(scope: SyncScope): AgendaScope {
  if (scope.kind === 'team') return { kind: 'team', team_id: scope.id }
  if (scope.kind === 'project') return { kind: 'project', project_id: scope.id }
  return { kind: 'all' }
}

/** The key of the agenda's arguments `args`, JSON in a fixed key order, so
    equal arguments share one subscription. */
export const syncAgendaKey = (args: SyncAgendaArgs): string =>
  JSON.stringify({
    org_id: args.org_id,
    scope: args.scope,
    day: args.day,
    week: args.week,
    week_starts: args.week_starts,
    week_end: args.week_end,
  })

/* The arguments a key of syncAgendaKey names, or null. */
function argsOfKey(key: string): SyncAgendaArgs | null {
  try {
    const args = JSON.parse(key) as Partial<SyncAgendaArgs> | null
    return args && typeof args.org_id === 'string' && args.scope && typeof args.day === 'string'
      ? (args as SyncAgendaArgs)
      : null
  } catch {
    return null
  }
}

/** The meeting key `key` asks for, its organization and scope as one
    string, so two keys of the same meeting on other days or week grids
    compare equal; null for a key that is not one. */
export function syncMeetingOf(key: string): string | null {
  const args = argsOfKey(key)
  return args ? JSON.stringify([args.org_id, args.scope]) : null
}

/** The client's day, YYYY-MM-DD, and the first day of its week that key
    `key` asks with, or null. */
export function syncClockOf(key: string): { day: string; week: string } | null {
  const args = argsOfKey(key)
  return args ? { day: args.day, week: args.week } : null
}

/* ---- rows, roster, a person's page ------------------------------------------ */

/** The walk's rows: open (To Do, In Progress, In Review) leaf tasks whose
    sub-project is in scope. The store holds no archived task. */
export function syncRows<I extends SyncIssue>(issues: readonly I[], subIds: Set<string>): I[] {
  return issues.filter((it) => OPEN.has(it.status) && !isIssueGroup(it) && subIds.has(it.project))
}

/** The walk's people in walk order: humans by name, then the agents (one
    collapsed final step). The agenda decides who they are, the owners of
    its rows, in a team only its members; deactivated owners stay, as the
    work is still theirs. */
export function syncWalk<U extends SyncUser>(people: readonly U[]): { humans: U[]; agents: U[] } {
  const walk = [...people].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return { humans: walk.filter((u) => !u.isAgent), agents: walk.filter((u) => u.isAgent) }
}

/** The order inside every group, stable from day to day: no estimate first,
    then planned start week, planned before unplanned; then due date, undated
    last; then the key. */
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
): { issue: I; reviewer: string; since: number | null }[] {
  return rows
    .filter(
      (it) =>
        it.status === 'review' && it.assignee === person && !!it.reviewer && it.reviewer !== person,
    )
    .map((issue) => ({ issue, reviewer: issue.reviewer, since: issue.reviewAt }))
    .sort((a, b) => byHandoff(a.since, b.since) || syncRowOrder(a.issue, b.issue))
}

/** "Done since": leaf tasks in scope that reached Done, or moved to another
    sub-project while Done (`doneAt` restarts at the move), at or after
    `since`, newest first. `done` when the person was the assignee; `reviewed` when
    they reviewed someone else's task to Done: its reviewer, with a review
    hand-off that the move into Done kept (`reviewAt`, which any other way
    into Done clears). The rule is convex/lib/teamSync.ts doneSinceKind,
    which the server's agenda shares. */
export function doneSince<I extends SyncIssue>(
  person: string,
  issues: readonly I[],
  subIds: Set<string>,
  since: number,
): { issue: I; kind: 'done' | 'reviewed' }[] {
  const out: { issue: I; kind: 'done' | 'reviewed' }[] = []
  for (const it of issues) {
    if (it.status !== 'done' || !subIds.has(it.project)) continue
    const kind = doneSinceKind(
      {
        status: it.status,
        group: isIssueGroup(it),
        doneAt: it.doneAt ?? null,
        assignee: it.assignee || null,
        reviewer: it.reviewer || null,
        handedOff: it.reviewAt != null,
      },
      person,
      since,
    )
    if (kind !== null) out.push({ issue: it, kind })
  }
  return out.sort(
    (a, b) =>
      b.issue.doneAt - a.issue.doneAt ||
      a.issue.key.localeCompare(b.issue.key, undefined, { numeric: true }),
  )
}

/* ---- per-row marks -------------------------------------------------------------- */

/** The board banner's rule, from `P.delayOf` and `P.tracksDelay`: a verdict
    only for a project that tracks delay, and never for on track. The
    agenda's verdicts follow it (convex/lib/teamSyncAgenda.ts AgendaRow
    delay), and the parity oracle reads it. */
export function bannerVerdict(delay: Pick<DelayInfo, 'status'> | null, tracks: boolean): Verdict {
  return tracks && delay && delay.status !== 'ok' ? delay.status : null
}

/** The one "since the last sync" mark a row can carry. */
export type SinceMark =
  /** In Progress with nothing since `since`; `at` is the last touch */
  | { kind: 'untouched'; at: number }
  /** a review handed to the page owner, or moved to another sub-project
      (`reviewAt` restarts at the move), after `since` */
  | { kind: 'handed'; at: number }
  /** a review handed over before `since` with no edit or comment since the
      hand-off; `at` is the hand-off */
  | { kind: 'waiting'; at: number }
  /** the latest status change or comment after `since` */
  | { kind: 'changed'; what: string; at: number }

export type RowMarks = {
  verdict: SyncVerdict
  paused: boolean
  /** keys of open blockers */
  blockedBy: readonly string[]
  noEstimate: boolean
  /** In Review with no reviewer: on the assignee's page */
  noReviewer: boolean
  /** on a reviewer's page, whose task it is ("for Aisha"); null for their own */
  reviewFor: string | null
  since: SinceMark | null
}

/** Everything a row says about itself on `person`'s page. `blockedBy` is
    the keys of its open blockers the agenda names. `lastCommentAt` is the
    task's latest comment (`P.lastComments` by uuid), null when it has
    none. Left out, the comment is not known yet, so the row carries no since
    mark rather than call a discussed task untouched. */
export function rowMarks(
  it: SyncIssue,
  o: {
    person: string
    since: number
    verdict: SyncVerdict
    blockedBy: readonly string[]
    lastCommentAt?: number | null
  },
): RowMarks {
  const reviewing = it.status === 'review' && !!it.reviewer && it.reviewer === o.person
  return {
    verdict: o.verdict,
    paused: !!it.paused,
    blockedBy: o.blockedBy,
    noEstimate: it.remaining == null,
    noReviewer: it.status === 'review' && !it.reviewer,
    reviewFor: reviewing && it.assignee && it.assignee !== o.person ? it.assignee : null,
    since:
      o.lastCommentAt === undefined ? null : sinceMark(it, reviewing, o.lastCommentAt, o.since),
  }
}

function sinceMark(
  it: SyncIssue,
  reviewing: boolean,
  comment: number | null,
  since: number,
): SinceMark | null {
  const lastTouch = Math.max(it.updatedAt, comment ?? 0)
  if (it.status === 'progress' && lastTouch < since) return { kind: 'untouched', at: lastTouch }
  const commented: SinceMark | null =
    comment != null && comment > since ? { kind: 'changed', what: 'commented', at: comment } : null
  if (reviewing) {
    // No recorded hand-off: handed over before review_at existed, or a leaf
    // again after subtasks cleared it (model/issues.ts clearParentRemaining).
    // Such a review says neither handed nor waiting, nor its status move.
    if (it.reviewAt == null) return commented
    if (it.reviewAt > since) return { kind: 'handed', at: it.reviewAt }
    if (lastTouch <= it.reviewAt + HANDOFF_SLACK_MS) return { kind: 'waiting', at: it.reviewAt }
  }
  // creation stamps status_at too, and the status a task starts with is no move
  const movedAt =
    it.statusAt != null && it.statusAt > since && it.statusAt > it.createdAt ? it.statusAt : null
  if (commented && (movedAt == null || commented.at >= movedAt)) return commented
  return movedAt == null
    ? null
    : { kind: 'changed', what: `moved to ${STATUS_NAMES[it.status]}`, at: movedAt }
}

/* ---- the team opening ------------------------------------------------------------- */

export type OpeningFacts = {
  /** due before today */
  overdue: number
  /** Delayed and not yet past due: projected to miss the due date; null
      where some row's verdict is unknown, so the count is not known */
  projected: number | null
  /** the board's Delayed, past due or not; null as `projected` */
  delayed: number | null
  /** the board's Slipping; null as `projected` */
  slipping: number | null
  /** with an open blocker the agenda names */
  blocked: number
  paused: number
}

/** The opening's counts over the walk's rows (leaf, open, in scope; Done and
    groups never count). Overdue, Blocked and Paused count stored facts and
    are always whole. The verdicts' counts are null as soon as one row's
    verdict is unknown, never a count that leaves some out. Overdue is not
    gated by delay tracking, as on the Overview; the verdicts are
    (`bannerVerdict`). */
export function openingFacts<I extends SyncIssue>(
  rows: readonly I[],
  o: {
    verdictOf: (it: I) => SyncVerdict
    blockedOf: (it: I) => readonly string[]
    today: string
  },
): OpeningFacts {
  let overdue = 0
  let projected = 0
  let delayed = 0
  let slipping = 0
  let blocked = 0
  let paused = 0
  let unknown = false
  for (const it of rows) {
    if (it.status === 'done' || isIssueGroup(it)) continue
    const late = !!it.due && it.due < o.today
    const verdict = o.verdictOf(it)
    if (late) overdue++
    if (verdict === 'unknown') unknown = true
    if (verdict === 'late') delayed++
    if (verdict === 'late' && !late) projected++
    if (verdict === 'behind') slipping++
    if (o.blockedOf(it).length) blocked++
    if (it.paused) paused++
  }
  return {
    overdue,
    projected: unknown ? null : projected,
    delayed: unknown ? null : delayed,
    slipping: unknown ? null : slipping,
    blocked,
    paused,
  }
}

/** One piece of the opening sentence: text, or a count the page paints. */
export type SentencePart = string | { n: number; tone: 'danger' | 'warning' }

/** The sentence that ends the summary where some projected delay is not
    known (OpeningFacts projected null). */
export const PROJECTED_UNKNOWN = 'Qivo could not work out every projected delay.'

/** The one-sentence summary: overdue first, then projected misses, then
    blocked, stating only numbers the opening also shows; a calm line when
    all three are zero, so the sentence is never missing. Where the
    projected misses are not known it leaves their clause out, never says
    that none is projected, and ends with PROJECTED_UNKNOWN. */
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
  if (f.projected !== null && f.projected > 0) {
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
  if (!clauses.length && f.projected === null)
    return [`No task is overdue or blocked. ${PROJECTED_UNKNOWN}`]
  if (!clauses.length) return ['No task is overdue, projected to miss its due date, or blocked.']
  const out: SentencePart[] = []
  clauses.forEach((c, i) => {
    if (i > 0) out.push(clauses.length > 2 ? (i === clauses.length - 1 ? ', and ' : ', ') : ' and ')
    out.push(...c)
  })
  out.push(f.projected === null ? `. ${PROJECTED_UNKNOWN}` : '.')
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
    priority, then key. `issues` is every task (Backlog is not a row). The
    rule is convex/lib/teamSync.ts needsAnOwner, which the server's agenda
    shares. */
export function needsOwner<I extends SyncIssue>(
  issues: readonly I[],
  subIds: Set<string>,
  day: SyncDay,
): I[] {
  const horizon = askHorizon(day.today)
  return issues
    .filter(
      (it) =>
        subIds.has(it.project) &&
        needsAnOwner(
          {
            status: it.status,
            pressing: it.priority === 'urgent' || it.priority === 'high',
            assigned: !!it.assignee,
            group: isIssueGroup(it),
            startsByThisWeek: it.start != null && it.start <= day.todayWeek,
            due: it.due || null,
          },
          horizon,
        ),
    )
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
): { issue: I; since: number | null }[] {
  return rows
    .filter((it) => it.status === 'review' && !it.reviewer && !isIssueGroup(it))
    .map((issue) => ({ issue, since: issue.reviewAt }))
    .sort(
      (a, b) =>
        byHandoff(a.since, b.since) ||
        a.issue.key.localeCompare(b.issue.key, undefined, { numeric: true }),
    )
}

/* ---- milestones ---------------------------------------------------------------------- */

/** The store's slots of the opening's two milestone reads
    (store/planner.ts P.watchMilestones): its next milestone, a one-row
    upcoming section, and the milestones of this week and next, a range.
    App releases them once the Team sync page is no longer kept. */
export const SYNC_MILESTONE_SLOTS = {
  next: 'milestones:sync-next',
  ahead: 'milestones:sync-ahead',
} as const

/** One milestone read as the opening takes it, the store's MilestoneRead
    narrowed to what the opening shows: its rows in the server's order,
    and whether the server answered whole (`next` and `stopped` null). */
export type SyncMilestoneRead<M> =
  | { state: 'loading' | 'too_many' }
  | { state: 'refused'; sentence: string; kept: SyncMilestoneAnswer<M> | null }
  | { state: 'failed'; kept: SyncMilestoneAnswer<M> | null }
  | { state: 'ok'; current: boolean; answer: SyncMilestoneAnswer<M> }
export type SyncMilestoneAnswer<M> = {
  rows: readonly M[]
  next: unknown
  stopped: string | null
}

/** What the strip's "Next milestone" shows: the section's first row, "None
    scheduled" only for a whole answer with no row, a wait, or "unknown"
    for an answer that stopped or names more without a row, a failure, a
    refusal, or more projects than one read names. */
export type SyncNextMilestone<M> =
  | { kind: 'milestone'; milestone: M }
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'unknown' }

/** What the opening's Milestones list shows: the rows of this week and
    next in the server's order and what goes with them. `empty` says "No
    milestones this week or next", for a whole answer with no row only;
    `partial` says some may be missing, for an answer that stopped; and
    `loading`, `failed` (with Retry), `refused` (the server's sentence) and
    `too_many` say why the list is not there, a failure or refusal under
    the rows it kept. `refreshing` marks a kept answer shown until it is
    current again. */
export type SyncMilestoneList<M> = {
  rows: readonly M[]
  note: 'empty' | 'partial' | 'loading' | 'failed' | 'refused' | 'too_many' | null
  sentence?: string
  refreshing: boolean
}

/** What the opening says of its next-milestone read where the list's own
    note does not say it already: that the read failed, with Retry, or the
    server's sentence for its refusal. */
export type SyncNextNote = { note: 'failed' } | { note: 'refused'; sentence: string } | null

/** Whether `answer` holds every milestone it was asked for. */
const whole = (answer: SyncMilestoneAnswer<unknown>) =>
  answer.next === null && answer.stopped === null

/** What the opening shows of its two milestone reads: `next`, the one-row
    upcoming section, and `ahead`, the range of this week and next, each
    with its own failure or refusal (`nextNote` for the next one's). A
    failure or refusal after an answer keeps that answer. Neither says
    there are none unless the server answered whole, and nothing here
    sorts or cuts the server's rows. */
export function syncMilestones<M>(
  next: SyncMilestoneRead<M>,
  ahead: SyncMilestoneRead<M>,
): { next: SyncNextMilestone<M>; ahead: SyncMilestoneList<M>; nextNote: SyncNextNote } {
  const answerOf = (read: SyncMilestoneRead<M>) =>
    read.state === 'ok'
      ? read.answer
      : read.state === 'failed' || read.state === 'refused'
        ? read.kept
        : null
  const nextAnswer = answerOf(next)
  const first = nextAnswer?.rows[0]
  const nextShown: SyncNextMilestone<M> =
    first !== undefined
      ? { kind: 'milestone', milestone: first }
      : nextAnswer && whole(nextAnswer)
        ? { kind: 'none' }
        : next.state === 'loading'
          ? { kind: 'loading' }
          : { kind: 'unknown' }
  // the next read's failure or refusal, unless the list says the same
  const nextNote: SyncNextNote =
    next.state === 'failed' && ahead.state !== 'failed'
      ? { note: 'failed' }
      : next.state === 'refused' && !(ahead.state === 'refused' && ahead.sentence === next.sentence)
        ? { note: 'refused', sentence: next.sentence }
        : null
  const kept = answerOf(ahead)
  const rows = kept?.rows ?? []
  const refreshing = ahead.state === 'ok' && !ahead.current
  const list = (shown: SyncMilestoneList<M>) => ({ next: nextShown, ahead: shown, nextNote })
  if (ahead.state === 'failed') return list({ rows, note: 'failed', refreshing })
  if (ahead.state === 'refused')
    return list({ rows, note: 'refused', sentence: ahead.sentence, refreshing })
  if (ahead.state === 'loading' || ahead.state === 'too_many')
    return list({ rows: [], note: ahead.state, refreshing })
  const note = !kept || !whole(kept) ? 'partial' : rows.length ? null : 'empty'
  return list({ rows, note, refreshing })
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

/** A person's week as the page shows it: a figure, `waiting` while an
    organization Viewer's read of it is on its way, or `unknown` where it
    could not be read. Never a figure for a load nobody read. */
export type SyncLoad =
  | { state: 'ok'; figure: LoadFigure }
  | { state: 'waiting' }
  | { state: 'unknown' }

/** "Near or over capacity": the people whose week is known and near (90%)
    or over, highest first, and how many people's week is unknown or still
    loading, so the list never reads as whole while some are left out.
    `loadOf` is the page's week figure (views/teamSync/useSyncMeeting.ts). */
export function nearCapacity<U extends Pick<SyncUser, 'name'>>(
  users: readonly U[],
  loadOf: (u: U) => SyncLoad,
): { busy: { user: U; figure: LoadFigure }[]; unknown: number } {
  const busy: { user: U; figure: LoadFigure }[] = []
  let unknown = 0
  for (const user of users) {
    const load = loadOf(user)
    if (load.state !== 'ok') unknown++
    else if (load.figure.tone === 'near' || load.figure.tone === 'over')
      busy.push({ user, figure: load.figure })
  }
  busy.sort(
    (a, b) => (b.figure.pct ?? 0) - (a.figure.pct ?? 0) || a.user.name.localeCompare(b.user.name),
  )
  return { busy, unknown }
}

/** What weekHoursOf reads of a task besides its row, as
    convex/lib/loadRows.ts loadRowFor takes it: whether it has subtasks,
    whether its project is live, and whether a person is of its
    organization. */
export type WeekFacts = {
  isGroup: boolean
  projectLive: boolean
  ownerInOrg: (id: string) => boolean
}

/** The hours task row `row` adds to week `week` (the app's week index) and
    whose they are: its load row through the server's fence
    (convex/lib/loadRows.ts loadRowFor, so a Done, paused, unscheduled or
    unestimated task and a group add none) spread over its window the
    server's way (lib/workload.ts committedByWeek), unrounded; null where it
    adds none. Team sync re-counts a pending edit with it, the saved row's
    hours out and the row on screen's in (store/planner.ts
    P.syncLoadChanges). */
export function weekHoursOf(
  row: LoadTask,
  facts: WeekFacts,
  week: number,
): { owner: string; hours: number } | null {
  const filed = loadRowFor(row, { ...facts, visible: true, staff: true, meId: '' })
  if (!filed) return null
  const span = {
    issueUuid: filed.issue_id,
    start: isoToWeek(filed.start_week),
    end: isoToWeek(filed.end_week),
    remaining: Number(filed.remaining),
    remainingSet: filed.remaining_set_at != null ? tsToWeek(filed.remaining_set_at) : null,
  }
  const hours = committedByWeek([span], null, { from: week, to: week }).get(week) ?? 0
  return hours > 0 ? { owner: filed.owner_id, hours } : null
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

/** A card on the Team sync page: its task, and the person whose section
    shows it (the page owner, or an agent on the agents step). A scope
    switch asks about every card that holds unsent text, as the new scope's
    walk is not known until its answer arrives. */
export type SyncCardPlace = { task: string; owner: string }

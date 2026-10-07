/* The issue-domain model layer: the successor to the issue triggers
 * (0050/0057/0066/0067/0070/0071/0072/0078/0102/0106, LAST definitions) and
 * to the guards the machine core shares with them. Browser mutations
 * (convex/issues.ts) and the machine surface (phase 8's lib/core.ts) both
 * compose these with an explicit actor — one model layer, two skins.
 *
 * ORDER inside one mutation — the SQL relied on ALPHABETICAL
 * trigger order; here the order is code, so it is written down; do not
 * shuffle it in a refactor):
 *   guards      resolve project (not_found) → meta guard → archived-project
 *               arrival → num assign + org pin (0057: the org MUST be pinned
 *               from the project before the parent same-org check can run) →
 *               parent chain guard incl. same-org → archive-parent guard →
 *               assignee guard (only when changed) → reviewer guard (only
 *               when changed; refused on a task with subtasks) → remaining
 *               guard (0072: the guard raises BEFORE the stamp)
 *   stamps      done stamp (0071) → remaining stamp (server-owned) →
 *               review-time stamp (status INTO review, no explicit hours:
 *               the project review time with a fresh remaining_set_at) →
 *               review hand-off stamp (review_at, lib/review.ts) → touch
 *   clamp       parent side, on the incoming values (0070) — the row lands
 *               already covering, and narration/notify diff the clamped row
 *   write       the row insert/patch
 *   widen loop  child side (0070), plain loop depth ≤ 20 — EACH touched
 *               ancestor is touched (updated_at) AND notified: "envelope
 *               cascade writes keep notifying: dates moving on YOUR issue is
 *               real news" (0075 fix 4)
 *   clear       clearParentRemaining on attach (0066/0067) — also notifies
 *               and touches the parent
 *   notify      notifyIssueInsert/Update fan-out for the row itself
 *   activity    logActivity + newest-500 trim
 *
 * The archive cascade's descendant/ancestor echoes are the ONE suppressed
 * notification (0114:308-313, pg_trigger_depth's successor): only the
 * Archived/Restored line is dropped — an ancestor whose remaining_hours the
 * restore cleared still narrates that. Archived-down descendants change
 * nothing else, so their notify is skipped outright; restored-up ancestors
 * pass notifyIssueUpdate's suppressNotify.
 *
 * Refusal grammar: `rule` sentences are toasted verbatim by the client.
 * `badRequest` sentences name machine fields where useful to API callers.
 * Both surfaces call the work items tasks and their children subtasks. */

import type { WithoutSystemFields } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { profileCanBeAssigned, profileCanSeeProject } from '../lib/access'
import { byId, insertUnique } from '../lib/db'
import type { IssuePriority, IssueStatus } from '../lib/enums'
import { badRequest, notFound, require, rule } from '../lib/functions'
import { reviewStamp } from '../lib/review'
import { ISSUE_PREFIX } from '../lib/taskRefs'
import { issueChanges, logActivity, machineDetail, PRIORITY_NAMES, STATUS_NAMES } from './activity'
import { notifyIssueInsert, notifyIssueUpdate } from './messages'
import { nextIssueNum } from './orgs'
import { reviewHoursFor } from './projects'
import { emitTaskEvent } from './taskEvents'
import { assertWeekPair, cleanRemaining, cleanTaskDate, roundTenths } from './taskValues'

export { ISSUE_PREFIX } from '../lib/taskRefs'
export { assertWeekPair, cleanRemaining } from './taskValues'
/* char_length in the DB CHECK (0061), so codepoints here too. */
export const TITLE_MAX = 80

/* num and org_id are immutable — structural here (no public patch carries
 * them), but the sentence stays exported for the machine surface and tests. */
export const NUM_IMMUTABLE_SENTENCE =
  'task numbers are assigned once by the server and never change'
export const REPORTER_IMMUTABLE_SENTENCE =
  'reporter_id is set when a task is created and cannot be changed'

/* The browser backstop's sentences for the two people fields (one sentence
 * per field for every failure, foreign uuids included: no oracle), and the
 * refusal for a reviewer on a group, parallel to the status-on-group rule. */
export const ASSIGNEE_RULE =
  'a task can only be assigned to an active user with Edit permission or higher on its project'
export const REVIEWER_RULE =
  'a task can only be reviewed by an active user with Edit permission or higher on its project'
export const REVIEWER_ON_GROUP =
  'a task with subtasks has no reviewer of its own; set reviewers on its subtasks'

/* ------------------------------------------------------- shared guards
 * core.ts grammar (bad_request) — the machine surface's readable errors,
 * built here because the browser mutations need the same predicates. */

export function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('title must be a non-empty string')
  const title = raw.trim()
  if (!title) throw badRequest('title must not be blank')
  // codepoints, matching the DB CHECK's char_length (0061)
  if ([...title].length > TITLE_MAX)
    throw badRequest(`title must be at most ${TITLE_MAX} characters`)
  return title
}

/* assertOwnUser + assertAssignable (core.ts:327-347). Checked in this order
 * so a uuid from another organization still gets the "not found" answer
 * rather than a report on that person's role (the 0056 no-existence-oracle
 * discipline). The reviewer passes the same checks; only the last sentence
 * names the role. */
export async function assertAssignable(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  profileId: string,
  role: 'assignee' | 'reviewer' = 'assignee',
): Promise<void> {
  const p = await byId(ctx, 'profiles', profileId)
  if (p === null || p.org_id !== project.org_id) {
    throw badRequest(`user "${profileId}" not found in your organization`)
  }
  if (!p.active) throw badRequest(`user "${profileId}" is switched off and can hold no new work`)
  if (p.org_role === 'viewer') {
    throw badRequest(
      `user "${profileId}" is a viewer — a viewer reads the projects they are added to and is never assigned work`,
    )
  }
  if (!(await profileCanSeeProject(ctx, p, project))) {
    throw badRequest(`user "${profileId}" has no access to this project`)
  }
  if (!(await profileCanBeAssigned(ctx, p, project))) {
    throw badRequest(
      `user "${profileId}" needs Edit permission or higher on this project to ${role === 'reviewer' ? 'review work' : 'be assigned work'}`,
    )
  }
}

/* Reporter is immutable attribution, not workload: an inactive user or viewer
 * may be credited, but at creation the profile must be real, in the issue's
 * organization and able to see its project. Machine surfaces use the readable
 * per-cause errors here before the generic model backstop below. */
export async function assertReporter(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  profileId: string,
): Promise<void> {
  const p = await byId(ctx, 'profiles', profileId)
  if (p === null || p.org_id !== project.org_id) {
    throw badRequest(`user "${profileId}" not found in your organization`)
  }
  if (!(await profileCanSeeProject(ctx, p, project))) {
    throw badRequest(`user "${profileId}" has no access to this project`)
  }
}

/* The DB trigger's one-sentence twin (issue_assignee_same_org, 0102:283-300):
 * the browser path's backstop for both people fields, fired only when the
 * assignee or reviewer actually CHANGES to a non-null value (and on create,
 * and at a move's destination) — deactivating someone leaves existing
 * assignments alone. One sentence per role for every failure, foreign uuids
 * included (no oracle). */
export async function assertAssigneeRule(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  profileId: string,
  role: 'assignee' | 'reviewer' = 'assignee',
): Promise<void> {
  if (!(await canHoldTaskIn(ctx, project, profileId))) {
    throw rule(role === 'reviewer' ? REVIEWER_RULE : ASSIGNEE_RULE)
  }
}

/* The predicate behind assertAssigneeRule: an active same-org profile with
 * Edit or higher on the project. */
async function canHoldTaskIn(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  profileId: string,
): Promise<boolean> {
  const p = await byId(ctx, 'profiles', profileId)
  return p !== null && p.org_id === project.org_id && (await profileCanBeAssigned(ctx, p, project))
}

/* Creation-time reporter counterpart to assertAssigneeRule. One sentence
 * covers unknown, foreign and same-org-but-hidden profiles so the model
 * backstop stays a no-existence oracle. */
export async function assertReporterRule(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  profileId: string,
): Promise<void> {
  const p = await byId(ctx, 'profiles', profileId)
  const ok =
    p !== null && p.org_id === project.org_id && (await profileCanSeeProject(ctx, p, project))
  if (!ok) throw rule("a task's reporter must be a user who can see its project")
}

/* Archived projects take no new work — machine sentence (core.ts:379-383). */
export function assertLive(project: Doc<'projects'>): void {
  if (project.archived_at !== undefined) {
    throw badRequest(`${project.key} is archived — restore it in the app before adding tasks to it`)
  }
}

/* …and the DB backstop's sentence (issue_project_archived_guard, 0106:123-139).
 * Arrivals ONLY — created there, moved there; editing a task already inside
 * an archived project stays allowed (the nightly sweep updates rows in one). */
export function assertProjectArrival(project: Doc<'projects'>): void {
  if (project.archived_at !== undefined) throw rule('that project is archived — restore it first')
}

export const SUB_MUST_NAME = 'sub_project must name a sub-project by key, number or uuid'

/* The task lands in a sub-project OF the stated project (core.ts:358-362). */
export function pairRule(project: Doc<'projects'>, sub: Doc<'projects'>): void {
  if (sub.type !== 'project' || (sub.id !== project.id && sub.parent_id !== project.id)) {
    throw badRequest(
      `sub-project ${sub.key} does not belong to project ${project.key} — tasks are never created under another project's sub-project`,
    )
  }
}

/* The sentence a bare meta gets (core.ts:368-374): only live, caller-writable
 * sub-projects are offered. */
export function metaNeedsSub(
  project: Doc<'projects'>,
  liveKids: Doc<'projects'>[],
  writable: (id: string) => boolean,
): never {
  const mine = liveKids
    .filter((c) => writable(c.id))
    .map((c) => c.key)
    .sort()
  throw badRequest(
    `${project.key} is a project — tasks live in its sub-projects; ${
      mine.length
        ? `pass sub_project (one of: ${mine.join(', ')})`
        : liveKids.length
          ? 'you have no write access to any of them'
          : 'it has no sub-projects yet — create one in the app first'
    }`,
  )
}

/* Machine pre-check twin of the remaining guard (core.ts:397-402), naming
 * the remaining_hours field that the caller needs to correct. */
export async function assertNoSubtasks(ctx: QueryCtx, issueId: string): Promise<void> {
  const kids = ctx.db.query('issues').withIndex('by_parent', (q) => q.eq('parent_id', issueId))
  for await (const c of kids) {
    if (c.archived_at === undefined) {
      throw badRequest(
        'remaining_hours cannot be set on a task with subtasks — it is the sum of their remaining time',
      )
    }
  }
}

/* An active task is a grouping while it has an unarchived direct child.
 * Archived groups retain their hierarchy for display until restored. The
 * stored status stays dormant, ready to resume after the last active child
 * is detached, deleted or archived. Child visibility must not change this
 * fact: readers disclose only the boolean, never hidden child identities. */
export async function hasSubtasks(
  ctx: QueryCtx,
  issueId: string,
  includeArchived = false,
): Promise<boolean> {
  const kids = ctx.db.query('issues').withIndex('by_parent', (q) => q.eq('parent_id', issueId))
  for await (const child of kids) {
    if (includeArchived || child.archived_at === undefined) return true
  }
  return false
}

export function subtaskParentIds(
  issues: Iterable<Pick<Doc<'issues'>, 'parent_id' | 'archived_at'>>,
  includeArchived = false,
): Set<string> {
  const parents = new Set<string>()
  for (const issue of issues) {
    if (issue.parent_id !== undefined && (includeArchived || issue.archived_at === undefined)) {
      parents.add(issue.parent_id)
    }
  }
  return parents
}

/* The trigger's sentence (issue_remaining_guard, 0066:44 + 0070:184 child
 * filter): the browser mutation's backstop, fired only when the value
 * actually changes to non-null; clearing always passes. */
export async function assertOwnRemaining(ctx: QueryCtx, issueId: string): Promise<void> {
  const kids = ctx.db.query('issues').withIndex('by_parent', (q) => q.eq('parent_id', issueId))
  for await (const c of kids) {
    if (c.archived_at === undefined) {
      throw rule(
        'a task with subtasks has no remaining time of its own — it shows the sum of its subtasks',
      )
    }
  }
}

/* A pause is work on hold, so only a task that is under way (or queued to
 * be) holds one: Done and Backlog tasks are never paused. A pause asked for
 * on such a task is refused with PAUSE_RULE; a status write that lands on
 * one clears a standing pause. The task window hides Pause/Resume and the
 * paused glyph for the same two statuses. */
const PAUSABLE: ReadonlySet<IssueStatus> = new Set(['todo', 'progress', 'review'])
export const isPausable = (status: IssueStatus): boolean => PAUSABLE.has(status)
export const PAUSE_RULE = 'a Done or Backlog task cannot be paused'

/* -------------------------------------------------- the parent link fence
 * issues_check_parent (0057:38-85, final). Caller must pass the row's PINNED
 * org (0057:27-30: org from the project first, THEN this check). A
 * nonexistent parent is not_found — deliberately never mislabeled as an org
 * mismatch (0057:52-55). Returns the parent row for the follow-up guards. */
export async function assertParentChain(
  ctx: QueryCtx,
  issue: { id: string; org_id: string },
  parentId: string,
): Promise<Doc<'issues'>> {
  if (parentId === issue.id) throw rule('a task cannot be its own parent')
  const parent = await byId(ctx, 'issues', parentId)
  if (parent === null) throw notFound('parent task not found')
  if (parent.org_id !== issue.org_id) {
    throw rule('a subtask and its parent must belong to the same organization')
  }
  // upward walk: bound the chain above the attach point
  let cur: string | undefined = parentId
  let up = 0
  while (cur !== undefined) {
    up += 1
    if (up > 20) throw rule('task hierarchy too deep or cyclic')
    const row: Doc<'issues'> | null = await byId(ctx, 'issues', cur)
    cur = row?.parent_id
    if (cur === issue.id) throw rule('task parent cycle detected')
  }
  // downward measure (0038 fix 1): the height of the subtree hanging under
  // the row, capped at 24 so the walk stays finite over corrupt cycles — a
  // reparent must not merge two legal chains into one deeper than the
  // cascade budget
  let down = 0
  let frontier = [issue.id]
  while (frontier.length > 0 && down < 24) {
    const next: string[] = []
    for (const id of frontier) {
      const kids = ctx.db.query('issues').withIndex('by_parent', (q) => q.eq('parent_id', id))
      for await (const c of kids) next.push(c.id)
    }
    if (next.length === 0) break
    down += 1
    frontier = next
  }
  if (up + 1 + down > 20) throw rule('task hierarchy too deep')
  return parent
}

/* issue_archive_parent_guard (0070:65-82): an ACTIVE row under an ARCHIVED
 * parent is refused. Archived children under an active parent are normal —
 * that IS archiving (the survey had this backwards; the SQL wins). */
export function assertParentActive(
  parent: Doc<'issues'>,
  childArchivedAt: string | undefined,
): void {
  if (childArchivedAt === undefined && parent.archived_at !== undefined) {
    throw rule('the parent task is archived — restore it first')
  }
}

/* issue_links_same_org (0078:407-421): missing rows get the SAME sentence as
 * an org mismatch — a link endpoint is never an existence oracle. */
export async function assertLinkableIssues(
  ctx: QueryCtx,
  sourceId: string,
  targetId: string,
): Promise<{ source: Doc<'issues'>; target: Doc<'issues'> }> {
  const source = await byId(ctx, 'issues', sourceId)
  const target = await byId(ctx, 'issues', targetId)
  if (source === null || target === null || source.org_id !== target.org_id) {
    throw rule('linked tasks must belong to the same organization')
  }
  return { source, target }
}

/* --------------------------------------------------------- done stamp (0071)
 * done_at is fully derived, immune to direct writes; no public arg carries it. */

export function doneStampInsert(status: IssueStatus, now: string): string | undefined {
  return status === 'done' ? now : undefined
}

export function doneStampUpdate(
  old: Pick<Doc<'issues'>, 'status' | 'done_at' | 'archived_at'>,
  next: { status: IssueStatus; archived_at: string | undefined },
  now: string,
): string | undefined {
  if (next.status !== 'done') return undefined
  if (old.status !== 'done') return now // a genuine transition into done
  if (old.archived_at !== undefined && next.archived_at === undefined) {
    return now // restored while still done: the auto-archive clock restarts (0071 fix 1)
  }
  return old.done_at // steady state: a side-effect write must not stamp a stampless row
}

/* ------------------------------------------------- envelope, parent side
 * issue_envelope_clamp (0070:117-139): BEFORE-write adjustment of incoming
 * values on UPDATE of start/end — never on INSERT (a brand new row cannot
 * have children). Cleared or malformed shapes pass through untouched so the
 * pair CHECK decides uniformly with childless rows (0038 fix 3); archived
 * children do not constrain. */
export async function clampEnvelope(
  ctx: QueryCtx,
  issueId: string,
  start: string | undefined,
  end: string | undefined,
): Promise<{ start: string | undefined; end: string | undefined }> {
  if (start === undefined || end === undefined || start > end) return { start, end }
  let min: string | undefined
  let max: string | undefined
  const kids = ctx.db.query('issues').withIndex('by_parent', (q) => q.eq('parent_id', issueId))
  for await (const c of kids) {
    if (c.start_week === undefined || c.archived_at !== undefined) continue
    const ce = c.end_week ?? c.start_week
    if (min === undefined || c.start_week < min) min = c.start_week
    if (max === undefined || ce > max) max = ce
  }
  if (min === undefined) return { start, end }
  return { start: start < min ? start : min, end: end > (max as string) ? end : max }
}

/* -------------------------------------------------- envelope, child side
 * issue_envelope_widen (0070:141-167) as the design's plain loop: walk
 * parent_id upward, patch each non-covering scheduled ancestor wider, stop at
 * an unscheduled or already-covering one (no opportunistic repair of
 * violations the edit didn't touch — same rule as the client mirror). Every
 * touched ancestor is TOUCHED (updated_at — the stale-dimming filter reads
 * it) and NOTIFIED (its subscribers get a real Schedule message — 0075 fix 4;
 * in SQL the inner UPDATE fired issues_touch and issues_notify_update).
 * Archived rows don't constrain their ancestors. The depth raise is 0070's
 * backstop for a corrupt chain — unreachable while assertParentChain bounds
 * chains at 20 nodes, but better than committing a chain whose top was
 * silently never widened. */
export async function widenFrom(
  ctx: MutationCtx,
  a: { row: Doc<'issues'>; actor: Doc<'profiles'>; now: string },
): Promise<void> {
  let cur = a.row
  const seen = new Set<string>([cur.id])
  for (let depth = 0; ; depth++) {
    if (cur.archived_at !== undefined) return
    if (cur.start_week === undefined || cur.parent_id === undefined) return
    if (depth >= 20 || seen.has(cur.parent_id)) {
      throw rule('task hierarchy too deep for the envelope cascade')
    }
    const parent = await byId(ctx, 'issues', cur.parent_id)
    if (parent === null) return
    seen.add(parent.id)
    if (parent.start_week === undefined) return // unscheduled parents have no dates to violate
    const cs = cur.start_week
    const ce = cur.end_week ?? cs
    const ps = parent.start_week
    const pe = parent.end_week ?? ps
    if (ps <= cs && pe >= ce) return // already covering
    const before = { ...parent }
    await ctx.db.patch(parent._id, {
      start_week: ps < cs ? ps : cs,
      end_week: pe > ce ? pe : ce,
      updated_at: a.now,
    })
    const after = (await ctx.db.get(parent._id)) as Doc<'issues'>
    await notifyIssueUpdate(ctx, { before, after, actor: a.actor, now: a.now })
    cur = after
  }
}

/* --------------------------------------------- remaining clear-on-attach
 * issue_remaining_clear (0066/0067): a parent gaining a sub-issue loses its
 * own hours (adapt, don't reject). The stamp clears with them (0072 pairing),
 * and so does a review hand-off from its leaf days (a group has none), and
 * the parent is touched AND notified — in SQL this inner UPDATE fired the
 * stamp, touch and notify triggers, so its subscribers saw
 * "Remaining cleared (was N h)". 0067's row lock is subsumed by Convex
 * serializability. */
export async function clearParentRemaining(
  ctx: MutationCtx,
  a: { parentId: string; actor: Doc<'profiles'>; now: string },
): Promise<void> {
  const parent = await byId(ctx, 'issues', a.parentId)
  if (parent === null) return
  if (parent.remaining_hours === undefined && parent.review_at === undefined) return
  const before = { ...parent }
  await ctx.db.patch(parent._id, {
    remaining_hours: undefined,
    remaining_set_at: undefined,
    review_at: undefined,
    updated_at: a.now,
  })
  const after = (await ctx.db.get(parent._id)) as Doc<'issues'>
  await notifyIssueUpdate(ctx, { before, after, actor: a.actor, now: a.now })
}

/* ------------------------------------------------------- browser narration
 * The client's updateIssue verb/detail strings, moved server-side VERBATIM
 * (old planner.ts:1885-1933). The feed icon substring-matches the verb
 * (IssueDetail.tsx evIcon) — changing any verb string breaks icon selection
 * silently. First matching patch key decides ONE verb, in this order. Dates
 * render in the organization's configured format, as the client's
 * fmtISO/fmtRange did; free-text excerpts use the machine clean() (whitespace
 * collapse, curly quotes → ', → → -, 80-codepoint cap) so a crafted value
 * cannot forge phantom clauses. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function isoParts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number)
  return { y, m, d }
}

/* The client's fmtFullWith (src/lib/dates.ts:98-109), off the ISO string. */
export function fmtFullWith(format: string, iso: string): string {
  const { y, m, d } = isoParts(iso)
  const p2 = (n: number) => String(n).padStart(2, '0')
  switch (format) {
    case 'DD/MM/YYYY':
      return `${p2(d)}/${p2(m)}/${y}`
    case 'MM/DD/YYYY':
      return `${p2(m)}/${p2(d)}/${y}`
    case 'DD.MM.YYYY':
      return `${p2(d)}.${p2(m)}.${y}`
    case 'D MMM YYYY':
      return `${d} ${MONTHS[m - 1]} ${y}`
    case 'MMM D, YYYY':
      return `${MONTHS[m - 1]} ${d}, ${y}`
    default:
      return `${y}-${p2(m)}-${p2(d)}`
  }
}

/* The client's compact fmtDate: day/month order follows the org format. */
function fmtDateWith(format: string, iso: string): string {
  const { m, d } = isoParts(iso)
  const monthFirst = format === 'MM/DD/YYYY' || format === 'MMM D, YYYY'
  return monthFirst ? `${MONTHS[m - 1]} ${d}` : `${d} ${MONTHS[m - 1]}`
}

/* The client's fmtRange (dates.ts:142-144): compact dates joined ' → '. */
export function fmtRangeWith(format: string, aIso: string, bIso: string): string {
  return `${fmtDateWith(format, aIso)} → ${fmtDateWith(format, bIso)}`
}

const excerpt = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').replace(/[“”]/g, "'").replace(/→/g, '-').trim()
  const cp = [...t]
  return cp.length > 80 ? `${cp.slice(0, 79).join('')}…` : t
}

export async function browserVerbDetail(
  ctx: QueryCtx,
  a: { before: Doc<'issues'>; after: Doc<'issues'>; patch: IssuePatch },
): Promise<{ verb: string; detail: string | undefined }> {
  const { before, after, patch } = a
  const fmt = async () =>
    (await byId(ctx, 'organizations', before.org_id))?.date_format ?? 'YYYY-MM-DD'
  const name = async (id: string | undefined) =>
    id === undefined ? null : ((await byId(ctx, 'profiles', id))?.name ?? null)
  const keyOf = async (id: string | undefined) => {
    if (id === undefined) return null
    const r = await byId(ctx, 'issues', id)
    return r === null ? null : `${ISSUE_PREFIX}-${r.num}`
  }
  // 1 decimal, matching numeric(6,1) — the feed states what is stored
  const hours = (n: number) => `${roundTenths(n)} h`
  if ('status' in patch) {
    return {
      verb: 'moved',
      detail: `from ${STATUS_NAMES[before.status]} to ${STATUS_NAMES[after.status]}`,
    }
  }
  if ('assignee_id' in patch) {
    const from = await name(before.assignee_id)
    if (after.assignee_id === undefined) {
      return { verb: 'unassigned', detail: from ? `(was ${from})` : undefined }
    }
    return {
      verb: 'assigned',
      detail: `to ${(await name(after.assignee_id)) ?? 'no one'}${from ? ` (was ${from})` : ''}`,
    }
  }
  if ('reviewer_id' in patch) {
    const from = await name(before.reviewer_id)
    if (after.reviewer_id === undefined) {
      return { verb: 'removed the reviewer from', detail: from ? `(was ${from})` : undefined }
    }
    return {
      verb: 'set the reviewer of',
      detail: `to ${(await name(after.reviewer_id)) ?? 'no one'}${from ? ` (was ${from})` : ''}`,
    }
  }
  if ('due_date' in patch) {
    const f = await fmt()
    if (after.due_date === undefined) {
      return {
        verb: 'cleared the due date on',
        detail:
          before.due_date !== undefined ? `(was ${fmtFullWith(f, before.due_date)})` : undefined,
      }
    }
    if (before.due_date !== undefined) {
      return {
        verb: 'moved the due date on',
        detail: `from ${fmtFullWith(f, before.due_date)} to ${fmtFullWith(f, after.due_date)}`,
      }
    }
    return { verb: 'set a due date on', detail: `to ${fmtFullWith(f, after.due_date)}` }
  }
  if ('start_week' in patch || 'end_week' in patch) {
    const f = await fmt()
    const was =
      before.start_week !== undefined
        ? fmtRangeWith(f, before.start_week, before.end_week ?? before.start_week)
        : null
    if (after.start_week === undefined) {
      return { verb: 'removed from the roadmap', detail: was ? `(was ${was})` : undefined }
    }
    const to = fmtRangeWith(f, after.start_week, after.end_week ?? after.start_week)
    if (was) return { verb: 'rescheduled', detail: `from ${was} to ${to}` }
    return { verb: 'scheduled', detail: `for ${to}` }
  }
  if ('title' in patch) return { verb: 'renamed', detail: `from “${before.title}”` }
  if ('paused' in patch) return { verb: after.paused ? 'paused' : 'resumed', detail: undefined }
  if ('priority' in patch) {
    return {
      verb: 'reprioritized',
      detail: `from ${PRIORITY_NAMES[before.priority]} to ${PRIORITY_NAMES[after.priority]}`,
    }
  }
  if ('parent_id' in patch) {
    const from = await keyOf(before.parent_id)
    if (after.parent_id !== undefined) {
      const to = await keyOf(after.parent_id)
      return {
        verb: 'moved',
        detail: `under ${to ?? 'its parent'}${from ? ` (from ${from})` : ''}`,
      }
    }
    return { verb: 'detached', detail: from ? `from ${from}` : 'from its parent' }
  }
  if ('remaining_hours' in patch) {
    const prev = before.remaining_hours
    if (after.remaining_hours === undefined) {
      return {
        verb: 'cleared the remaining time on',
        detail: prev !== undefined ? `(was ${hours(prev)})` : undefined,
      }
    }
    if (prev !== undefined) {
      return {
        verb: 'changed the remaining time on',
        detail: `from ${hours(prev)} to ${hours(after.remaining_hours)}`,
      }
    }
    return { verb: 'set the remaining time on', detail: `to ${hours(after.remaining_hours)}` }
  }
  if ('description' in patch) {
    const to = after.description
    if (to === '') {
      return {
        verb: 'removed the description from',
        detail: before.description !== '' ? `(was “${excerpt(before.description)}”)` : undefined,
      }
    }
    if (before.description !== '') {
      return {
        verb: 'updated the description of',
        detail: `from “${excerpt(before.description)}” to “${excerpt(to)}”`,
      }
    }
    return { verb: 'added a description to', detail: `“${excerpt(to)}”` }
  }
  return { verb: 'updated', detail: undefined }
}

/* ------------------------------------------ machine-narration override
 * The TRUSTED activity-grammar seam. Only internal
 * entry points may pass it — the public wrappers' args validators carry no
 * slot for it (v.object refuses unknown keys), the same only-internal-can-
 * pass pattern as the seeds — so no browser call can ever reach it. Absent,
 * every core narrates exactly as before (browser verbs, no provenance).
 * Present:
 *   create  verb 'created', detail = the provenance string alone
 *   update  verb 'changed' — or 'archived'/'restored' when `archive`
 *           actually toggles (the toggle verb wins over any field change,
 *           core.ts:510) — detail = machineDetail(issueChanges diff,
 *           provenance); a pure toggle diffs nothing (archived_at is not a
 *           diff field), so its detail is the provenance alone
 *   update's `archive` folds the toggle into the SAME row write as the field
 *           patch: ONE write, ONE notifyIssueUpdate fan-out (whose diff
 *           carries the Archived/Restored line), ONE activity row, plus the
 *           cascade with its usual suppression semantics (descendants: no
 *           notify; restored ancestors: suppressNotify). A value matching the
 *           current state is a no-op slot, not a toggle.
 * Machine deletes need no seam: the surface composes deleteIssueDeep +
 * logActivity('deleted', detail: provenance) itself, as the browser wrapper
 * does. */
export type MachineNarration = { provenance: string }
export type MachineUpdate = MachineNarration & { archive?: boolean }

/* ----------------------------------------------------------- create core */

export type CreateIssueArgs = {
  id: string // the client-generated uuid (schema keeps client ids)
  project_id: string
  title: string
  description?: string | null
  status?: IssueStatus | null
  priority?: IssuePriority | null
  assignee_id?: string | null
  reviewer_id?: string | null
  reporter_id?: string // creation-only override, exposed by machine callers
  parent_id?: string | null
  start_week?: string | null
  end_week?: string | null
  due_date?: string | null
  remaining_hours?: number | null
  paused?: boolean | null
}

export async function createIssueCore(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; args: CreateIssueArgs; now: string; machine?: MachineNarration },
): Promise<Doc<'issues'>> {
  const { me, args, now } = a
  // resolve → meta guard → arrival guard (0050's issues_assign_num fires
  // before 0106's archived guard: the meta sentence wins on an archived meta)
  const project = await byId(ctx, 'projects', args.project_id)
  if (project === null) throw notFound(`project ${args.project_id} not found`)
  if (project.type !== 'project') {
    throw rule('tasks can only be created in sub-projects, not meta-projects')
  }
  assertProjectArrival(project)
  // org pinned from the project — any client-sent value is ignored (0050:72);
  // MUST precede the parent same-org check (0057:27-30)
  const org = await byId(ctx, 'organizations', project.org_id)
  require(org !== null, notFound('organization not found'))
  const org_id = project.org_id
  const num = await nextIssueNum(ctx, org)
  const title = cleanTitle(args.title)
  const parent_id = args.parent_id ?? undefined
  if (parent_id !== undefined) {
    const parent = await assertParentChain(ctx, { id: args.id, org_id }, parent_id)
    assertParentActive(parent, undefined) // a fresh row is active
  }
  const assignee_id = args.assignee_id ?? undefined
  if (assignee_id !== undefined) await assertAssigneeRule(ctx, project, assignee_id)
  const reviewer_id = args.reviewer_id ?? undefined
  if (reviewer_id !== undefined) await assertAssigneeRule(ctx, project, reviewer_id, 'reviewer')
  // Browser callers expose no override. Machine callers may credit a real
  // profile with access at creation; omission uses the authenticated actor.
  // Reporter attribution is immutable after this write, including on moves.
  if (args.reporter_id !== undefined && typeof args.reporter_id !== 'string') {
    throw badRequest('reporter_id must be a user uuid')
  }
  const reporter_id = args.reporter_id ?? me.id
  await assertReporterRule(ctx, project, reporter_id)
  const start_week = args.start_week ?? undefined
  const end_week = args.end_week ?? undefined
  assertWeekPair(start_week, end_week)
  const status = args.status ?? 'backlog'
  // created straight into Review: the project review time, unless the
  // caller states hours (a new row has no subtasks)
  const remaining_hours =
    cleanRemaining(args.remaining_hours) ??
    (status === 'review' ? await reviewHoursFor(ctx, project) : undefined)
  const paused = args.paused ?? false
  if (paused && !isPausable(status)) throw rule(PAUSE_RULE)
  await insertUnique(
    ctx,
    'issues',
    'by_uuid',
    { id: args.id },
    {
      id: args.id,
      project_id: project.id,
      org_id,
      num,
      title,
      description: args.description ?? '',
      status,
      priority: args.priority ?? 'low',
      assignee_id,
      reviewer_id,
      parent_id,
      start_week,
      end_week,
      due_date: cleanTaskDate(args.due_date, 'due_date'),
      remaining_hours,
      remaining_set_at: remaining_hours === undefined ? undefined : now, // 0072 stamp
      paused,
      created_by: me.id, // pinned to the creating user (0081), never an arg
      reporter_id,
      done_at: doneStampInsert(status, now),
      review_at: reviewStamp(null, { status, reviewer_id }, now), // created In Review: now
      archived_at: undefined,
      created_at: now,
      updated_at: now,
    },
    badRequest('a task with this id already exists'),
  )
  const issue = (await byId(ctx, 'issues', args.id)) as Doc<'issues'>
  // SQL widen fired on INSERT too; then the attach clears the parent's hours
  if (issue.parent_id !== undefined && issue.start_week !== undefined) {
    await widenFrom(ctx, { row: issue, actor: me, now })
  }
  if (issue.parent_id !== undefined) {
    await clearParentRemaining(ctx, { parentId: issue.parent_id, actor: me, now })
  }
  await notifyIssueInsert(ctx, { issue, actor: me, now })
  const event = {
    org_id,
    actor_id: me.id,
    verb: 'created',
    target_type: 'issue' as const,
    target_id: issue.id,
    label: issue.title,
    // machine creates sign themselves: detail is exactly the provenance
    // string ('via MCP' / 'via the REST API (<keyName>)'); browser creates
    // keep their detail-less row
    detail: a.machine?.provenance,
    project_id: issue.project_id,
    ts: now,
  }
  await logActivity(ctx, event)
  return issue
}

/* ----------------------------------------------------------- update core */

/* A key's PRESENCE means "set this field"; null clears (Convex strips
 * undefined from args, so null is the wire form of a clear — stored rows
 * still hold ABSENT, never null). reporter_id/num/org_id/done_at/remaining_set_at/
 * review_at/archived_at deliberately have no slot: immutable or server-owned. */
export type IssuePatch = {
  title?: string
  description?: string | null
  status?: IssueStatus
  priority?: IssuePriority
  assignee_id?: string | null
  reviewer_id?: string | null
  parent_id?: string | null
  start_week?: string | null
  end_week?: string | null
  due_date?: string | null
  remaining_hours?: number | null
  paused?: boolean
}

export async function updateIssueCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    issue: Doc<'issues'>
    patch: IssuePatch
    now: string
    machine?: MachineUpdate
  },
): Promise<Doc<'issues'>> {
  const { me, issue, patch, now } = a
  // Public validators omit this field; also fail explicitly at the shared
  // model boundary so trusted callers cannot accidentally alter attribution.
  if ('reporter_id' in patch) throw badRequest(REPORTER_IMMUTABLE_SENTENCE)
  const w: Partial<WithoutSystemFields<Doc<'issues'>>> = {}
  // trusted archive/restore toggle (machine only — see MachineUpdate above):
  // folded into this one row write; matching the current state never toggles
  const wantArchive = a.machine?.archive
  const toggle: 'archived' | 'restored' | undefined =
    wantArchive === undefined || wantArchive === (issue.archived_at !== undefined)
      ? undefined
      : wantArchive
        ? 'archived'
        : 'restored'
  // -- guards, in trigger order: parent chain → archive-parent → user refs →
  //    remaining guard (which must raise BEFORE the stamp — 0072)
  const nextParent = 'parent_id' in patch ? (patch.parent_id ?? undefined) : issue.parent_id
  if ('parent_id' in patch) {
    if (nextParent !== undefined) {
      const parent = await assertParentChain(ctx, issue, nextParent)
      assertParentActive(parent, issue.archived_at)
    }
    w.parent_id = nextParent
  }
  // the task's project, read at most once and only by the guards that need it
  let project: Doc<'projects'> | undefined
  const loadProject = async (): Promise<Doc<'projects'>> => {
    if (project === undefined) {
      const p = await byId(ctx, 'projects', issue.project_id)
      if (p === null) throw notFound('project not found')
      project = p
    }
    return project
  }
  // whether the task has active subtasks, read before the write, at most once
  // and only by the status and reviewer guards (a group's are dormant)
  let group: boolean | undefined
  const isGroup = async (): Promise<boolean> =>
    (group ??= await hasSubtasks(ctx, issue.id, issue.archived_at !== undefined))
  if ('assignee_id' in patch) {
    const next = patch.assignee_id ?? undefined
    // fires only when the assignee actually CHANGES (0099/0102): deactivating
    // someone leaves existing assignments alone
    if (next !== undefined && next !== issue.assignee_id) {
      await assertAssigneeRule(ctx, await loadProject(), next)
    }
    w.assignee_id = next
  }
  if ('reviewer_id' in patch) {
    const next = patch.reviewer_id ?? undefined
    // the assignee's rule, on change only; a group has no reviewer of its
    // own (clearing always passes, and one kept from its leaf days is
    // dormant). Any change reads the group flag for the fan-out below.
    if (next !== issue.reviewer_id) {
      const onGroup = await isGroup()
      if (next !== undefined) {
        if (onGroup) throw rule(REVIEWER_ON_GROUP)
        await assertAssigneeRule(ctx, await loadProject(), next, 'reviewer')
      }
    }
    w.reviewer_id = next
  }
  if ('remaining_hours' in patch) {
    const next = cleanRemaining(patch.remaining_hours)
    const changed = (issue.remaining_hours ?? null) !== (next ?? null)
    if (changed && next !== undefined) await assertOwnRemaining(ctx, issue.id)
    w.remaining_hours = next
    // server-owned stamp (0072): stamped exactly when the value changes; a
    // client-sent stamp cannot stick because no arg carries one
    if (changed) w.remaining_set_at = next === undefined ? undefined : now
  }
  if ('title' in patch) w.title = cleanTitle(patch.title)
  if ('description' in patch) w.description = patch.description ?? ''
  const entersReview = patch.status === 'review' && issue.status !== 'review'
  if ('status' in patch && patch.status !== undefined) {
    if (await isGroup()) {
      throw rule('status cannot be set on a task with subtasks — update its subtasks instead')
    }
    w.status = patch.status
  }
  // -- review-time stamp: entering Review is a fresh measurement, so the
  //    project review time lands with a new stamp even when the hours are
  //    unchanged. An explicit non-null remaining_hours in the same write
  //    wins; leaving Review changes nothing; groups were refused above.
  if (entersReview && patch.remaining_hours == null) {
    w.remaining_hours = await reviewHoursFor(ctx, await loadProject())
    w.remaining_set_at = now
  }
  if ('priority' in patch && patch.priority !== undefined) w.priority = patch.priority
  if ('due_date' in patch) w.due_date = cleanTaskDate(patch.due_date, 'due_date')
  // -- stamps: done (derived on EVERY update — immune to direct writes) → touch
  //    doneStampUpdate must see the NEXT archived_at: a machine PATCH that
  //    restores a still-done row restarts the auto-archive clock (0071 fix 1)
  const nextStatus = w.status ?? issue.status
  // -- the pause follows the status: a pause request on a Done or Backlog
  //    task is refused, and a move into either clears a standing pause
  if ('paused' in patch && patch.paused !== undefined) {
    if (patch.paused && !isPausable(nextStatus)) throw rule(PAUSE_RULE)
    w.paused = patch.paused
  } else if (issue.paused && !isPausable(nextStatus)) w.paused = false
  const nextArchivedAt =
    toggle === 'archived' ? now : toggle === 'restored' ? undefined : issue.archived_at
  w.done_at = doneStampUpdate(issue, { status: nextStatus, archived_at: nextArchivedAt }, now)
  // the review hand-off: entering Review, or a different reviewer while there
  const nextReviewer = 'reviewer_id' in patch ? w.reviewer_id : issue.reviewer_id
  w.review_at = reviewStamp(issue, { status: nextStatus, reviewer_id: nextReviewer }, now)
  if (toggle !== undefined) w.archived_at = nextArchivedAt // undefined clears via patch
  w.updated_at = now
  // -- clamp the incoming values against the active scheduled children; the
  //    clamped span is what lands, returns, and gets narrated
  if ('start_week' in patch || 'end_week' in patch) {
    const s0 = 'start_week' in patch ? (patch.start_week ?? undefined) : issue.start_week
    const e0 = 'end_week' in patch ? (patch.end_week ?? undefined) : issue.end_week
    assertWeekPair(s0, e0)
    const clamped = await clampEnvelope(ctx, issue.id, s0, e0)
    w.start_week = clamped.start
    w.end_week = clamped.end
  }
  // -- the row write: ONE patch, the folded archive toggle included
  await ctx.db.patch(issue._id, w)
  const after = (await ctx.db.get(issue._id)) as Doc<'issues'>
  // -- cascade + widen loop (per-ancestor notify + touch), then clear-on-attach
  if (toggle === 'restored') {
    // the restore cascade: surface the ancestor chain (suppressed echoes),
    // then every restored row re-covers upward — unarchiveIssueCore's bodies
    const ancestors = await restoreAncestors(ctx, { row: after, actor: me, now })
    for (const r of [after, ...ancestors]) {
      const fresh = (await ctx.db.get(r._id)) as Doc<'issues'>
      await widenFrom(ctx, { row: fresh, actor: me, now })
    }
  } else {
    // archive branch: descendants stamped, never notified (their only change
    // is the suppressed Archived line — archiveIssueCore's walk)
    if (toggle === 'archived') await archiveSubtree(ctx, issue.id, now, me)
    if ('start_week' in patch || 'end_week' in patch || 'parent_id' in patch) {
      await widenFrom(ctx, { row: after, actor: me, now }) // no-op on an archived row
    }
  }
  if ('parent_id' in patch && nextParent !== undefined) {
    await clearParentRemaining(ctx, { parentId: nextParent, actor: me, now })
  }
  // -- ONE fan-out for the row itself (diffs only the trigger's column list;
  //    the Archived/Restored line rides the same message as the field changes).
  //    `group` is known whenever the status or reviewer changed; an assignee
  //    change alone subscribes the same people either way.
  await notifyIssueUpdate(ctx, { before: issue, after, actor: me, now, isGroup: group === true })
  // -- activity: ONE row — machine grammar when the trusted override is
  //    present (verb archived/restored wins, else 'changed'; multi-field diff
  //    + provenance), else the browser verb/detail strings, ported verbatim
  let verb: string
  let detail: string | undefined
  if (a.machine !== undefined) {
    // The diff's user labels — built from the before/after profile ids; a
    // missing profile leaves the uuid standing (issueChanges' own fallback).
    const names = new Map<string, string>()
    for (const pid of [
      issue.assignee_id,
      after.assignee_id,
      issue.reviewer_id,
      after.reviewer_id,
    ]) {
      if (pid !== undefined && !names.has(pid)) {
        names.set(pid, (await byId(ctx, 'profiles', pid))?.name ?? pid)
      }
    }
    verb = toggle ?? 'changed'
    detail = machineDetail(issueChanges(issue, after, names), a.machine.provenance)
  } else {
    const browser = await browserVerbDetail(ctx, { before: issue, after, patch })
    verb = browser.verb
    detail = browser.detail
  }
  const event = {
    org_id: issue.org_id,
    actor_id: me.id,
    verb,
    target_type: 'issue' as const,
    target_id: issue.id,
    label: after.title,
    detail,
    project_id: after.project_id,
    ts: now,
  }
  await logActivity(ctx, event)
  return after
}

/* ------------------------------------------------------------- move core
 * issues_move_guard (0078:127-145) + the arrival guard (0106), in trigger
 * order: not-found → meta ("live", not "created" — a different sentence from
 * the insert guard) → cross-org → archived target → destination eligibility
 * for the assignee and the reviewer. A group's reviewer is dormant and hidden
 * in the app, so it never refuses a move: one the destination would refuse
 * is cleared in the move's patch instead (adapt, don't reject, as
 * clearParentRemaining does). num is org-scoped and immutable: the key
 * survives the move; labels survive too (org vocabulary). The activity row is
 * keyed to the SOURCE project. Access ('member' on BOTH ends) is the mutation
 * layer's job. */
export async function moveIssueCore(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; issue: Doc<'issues'>; project_id: string; now: string },
): Promise<Doc<'issues'>> {
  const { me, issue, project_id, now } = a
  if (issue.project_id === project_id) return issue // no-op, as in SQL
  const target = await byId(ctx, 'projects', project_id)
  if (target === null) throw notFound(`project ${project_id} not found`)
  if (target.type !== 'project') {
    throw rule('tasks can only live in sub-projects, not meta-projects')
  }
  if (target.org_id !== issue.org_id) throw rule('tasks cannot move between organizations')
  assertProjectArrival(target)
  // The assignee and a leaf's reviewer must be eligible in the destination;
  // a group's dormant reviewer who is not is cleared instead. Immutable
  // reporter and creator attribution survive moves and changes to those
  // users' access.
  if (issue.assignee_id !== undefined) {
    await assertAssigneeRule(ctx, target, issue.assignee_id)
  }
  const w: Partial<WithoutSystemFields<Doc<'issues'>>> = { project_id, updated_at: now }
  // only a reviewer can change hands in a move, so without one the group
  // flag is never needed
  let isGroup = false
  if (issue.reviewer_id !== undefined) {
    isGroup = await hasSubtasks(ctx, issue.id, issue.archived_at !== undefined)
    if (!isGroup) {
      await assertAssigneeRule(ctx, target, issue.reviewer_id, 'reviewer')
    } else if (!(await canHoldTaskIn(ctx, target, issue.reviewer_id))) {
      w.reviewer_id = undefined // ctx.db.patch unsets it
    }
  }
  const source = await byId(ctx, 'projects', issue.project_id)
  const before = { ...issue }
  await ctx.db.patch(issue._id, w)
  const after = (await ctx.db.get(issue._id)) as Doc<'issues'>
  // a group stays with its assignee: clearing its reviewer hands nothing over
  await notifyIssueUpdate(ctx, { before, after, actor: me, now, isGroup })
  const event = {
    org_id: issue.org_id,
    actor_id: me.id,
    verb: 'moved',
    target_type: 'issue' as const,
    target_id: issue.id,
    label: after.title,
    detail: `to the ${target.name} sub-project${source ? ` (from ${source.name})` : ''}`,
    project_id: issue.project_id, // the SOURCE project (old planner.ts:2063-2066)
    ts: now,
  }
  await logActivity(ctx, event)
  return after
}

/* ---------------------------------------------------------- archive core
 * issue_archive_cascade (0071:51-79), archive branch: subtree-atomic, only
 * ACTIVE children follow (an already-archived subtree keeps its older stamp).
 * One archive click = one message — the descendants' only change is the
 * suppressed Archived line, so their notify is skipped outright; each is
 * still touched, and the whole subtree shares the mutation's one `now`.
 * The reason-comment (early archive) is the mutation layer's job (comments
 * model, phase 5) — it must share this same `now`. */

/* The descendant walk, shared with updateIssueCore's folded machine toggle:
 * stamps active descendants (touched, NEVER notified), returns the count. */
async function archiveSubtree(
  ctx: MutationCtx,
  rootId: string,
  now: string,
  actor: Doc<'profiles'>,
): Promise<number> {
  let descendants = 0
  let frontier = [rootId]
  const seen = new Set<string>([rootId])
  for (let depth = 0; frontier.length > 0; depth++) {
    if (depth >= 20) throw rule('task hierarchy too deep for the archive cascade')
    const next: string[] = []
    for (const pid of frontier) {
      const kids = ctx.db.query('issues').withIndex('by_parent', (q) => q.eq('parent_id', pid))
      for await (const c of kids) {
        if (c.archived_at !== undefined || seen.has(c.id)) continue
        seen.add(c.id)
        await ctx.db.patch(c._id, { archived_at: now, updated_at: now })
        const after = (await ctx.db.get(c._id)) as Doc<'issues'>
        await emitTaskEvent(ctx, { name: 'task.updated', issue: after, before: c, actor, now })
        descendants += 1
        next.push(c.id)
      }
    }
    frontier = next
  }
  return descendants
}

export async function archiveIssueCore(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; issue: Doc<'issues'>; now: string },
): Promise<{ issue: Doc<'issues'>; descendants: number }> {
  const { me, issue, now } = a
  if (issue.archived_at !== undefined) return { issue, descendants: 0 }
  const before = { ...issue }
  await ctx.db.patch(issue._id, { archived_at: now, updated_at: now })
  const descendants = await archiveSubtree(ctx, issue.id, now, me)
  const after = (await ctx.db.get(issue._id)) as Doc<'issues'>
  await notifyIssueUpdate(ctx, { before, after, actor: me, now }) // the root's own write narrates
  const event = {
    org_id: issue.org_id,
    actor_id: me.id,
    verb: 'archived',
    target_type: 'issue' as const,
    target_id: issue.id,
    label: issue.title,
    detail:
      descendants > 0 ? `with ${descendants} subtask${descendants > 1 ? 's' : ''}` : undefined,
    project_id: issue.project_id,
    ts: now,
  }
  await logActivity(ctx, event)
  return { issue: after, descendants }
}

/* -------------------------------------------------------- unarchive core
 * Restore branch (0071:66-75): the whole ancestor chain surfaces, each
 * restored parent also loses its own hours (it has sub-issues again — 0066,
 * like attach) with the stamp pairing kept and any review hand-off, and a
 * restored still-done row's done_at restarts (0071 fix 1). Ancestors are
 * restored FIRST, then the widen loop re-covers from the restored rows
 * (0070:169-171 — the SQL relied on alphabetical trigger order for this). Cascade echoes mask ONLY the
 * Archived/Restored line out of the diff: a cleared remaining still narrates
 * to that ancestor's subscribers. The walk stops at an active ancestor —
 * one that merely held hours loses them but the chain above it never was
 * archived. */
/* The ancestor walk, shared with updateIssueCore's folded machine toggle:
 * restores/clears the chain above `row` (each echo notified with the Restored
 * line suppressed), returning the patched ancestor rows bottom-up — the row
 * itself is the caller's to notify and widen. */
async function restoreAncestors(
  ctx: MutationCtx,
  a: { row: Doc<'issues'>; actor: Doc<'profiles'>; now: string },
): Promise<Doc<'issues'>[]> {
  const { actor, now } = a
  const restored: Doc<'issues'>[] = []
  let cur: Doc<'issues'> = a.row
  const seen = new Set<string>([a.row.id])
  for (let depth = 0; cur.parent_id !== undefined; depth++) {
    if (depth >= 20 || seen.has(cur.parent_id)) {
      throw rule('task hierarchy too deep for the archive cascade')
    }
    const parent = await byId(ctx, 'issues', cur.parent_id)
    if (parent === null) break
    seen.add(parent.id)
    const wasArchived = parent.archived_at !== undefined
    // own hours, or a review hand-off from its leaf days: a group has neither
    const hadOwn = parent.remaining_hours !== undefined || parent.review_at !== undefined
    if (!wasArchived && !hadOwn) break
    const pBefore = { ...parent }
    await ctx.db.patch(parent._id, {
      archived_at: undefined,
      remaining_hours: undefined,
      remaining_set_at: undefined,
      review_at: undefined,
      done_at: doneStampUpdate(parent, { status: parent.status, archived_at: undefined }, now),
      updated_at: now,
    })
    const pAfter = (await ctx.db.get(parent._id)) as Doc<'issues'>
    // cascade echo: only the Restored line is suppressed — a cleared
    // remaining still narrates to this ancestor's subscribers
    await notifyIssueUpdate(ctx, {
      before: pBefore,
      after: pAfter,
      actor,
      now,
      suppressNotify: true,
    })
    restored.push(pAfter)
    if (!wasArchived) break
    cur = pAfter
  }
  return restored
}

export async function unarchiveIssueCore(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; issue: Doc<'issues'>; now: string },
): Promise<Doc<'issues'>> {
  const { me, issue, now } = a
  if (issue.archived_at === undefined) return issue
  const before = { ...issue }
  await ctx.db.patch(issue._id, {
    archived_at: undefined,
    done_at: doneStampUpdate(issue, { status: issue.status, archived_at: undefined }, now),
    updated_at: now,
  })
  const rootAfter = (await ctx.db.get(issue._id)) as Doc<'issues'>
  const ancestors = await restoreAncestors(ctx, { row: rootAfter, actor: me, now })
  // ancestors are restored — now every restored row re-covers upward, exactly
  // as each SQL row's own widen firing did (re-read: the loop above or a
  // previous widen may have changed the row since)
  for (const r of [rootAfter, ...ancestors]) {
    const fresh = (await ctx.db.get(r._id)) as Doc<'issues'>
    await widenFrom(ctx, { row: fresh, actor: me, now })
  }
  await notifyIssueUpdate(ctx, { before, after: rootAfter, actor: me, now }) // 'Restored'
  const event = {
    org_id: issue.org_id,
    actor_id: me.id,
    verb: 'restored',
    target_type: 'issue' as const,
    target_id: issue.id,
    label: issue.title,
    detail: 'from the archive',
    project_id: issue.project_id,
    ts: now,
  }
  await logActivity(ctx, event)
  return rootAfter
}

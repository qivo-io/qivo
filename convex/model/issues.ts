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
 *               parent chain guard incl. same-org and same top-level
 *               project → archive-parent guard →
 *               assignee guard (only when changed) → reviewer guard (only
 *               when changed; refused on a task with subtasks) → remaining
 *               guard (0072: the guard raises BEFORE the stamp) → status
 *               and group-dates guards (a task with subtasks takes neither,
 *               whatever the value)
 *   stamps      done stamp (0071) → remaining stamp (server-owned) →
 *               review-time stamp (status INTO review, no explicit hours:
 *               the project review time with a fresh remaining_set_at) →
 *               review hand-off stamp (review_at, lib/review.ts) → status
 *               stamp (status_at, only when the status changes) → touch
 *   write       the row insert/patch. A group's dates are calculated from
 *               its leaves by every reader, so no write ever changes an
 *               ancestor's dates because a child changed
 *   clear       clearParentRemaining on attach (0066/0067) — also notifies
 *               and touches the parent
 *   notify      notifyIssueInsert/Update fan-out for the row itself
 *   activity    logActivity (a task keeps its whole history,
 *               model/activity.ts); a save that changes nothing it
 *               narrates writes none (narratedChange)
 *
 * The archive cascade's descendant/ancestor echoes are the ONE suppressed
 * notification (0114:308-313, pg_trigger_depth's successor): only the
 * Archived/Restored line is dropped — an ancestor whose remaining_hours the
 * restore cleared still narrates that. Archived-down descendants change
 * nothing else, so their notify is skipped outright; restored-up ancestors
 * pass notifyIssueUpdate's suppressNotify. Both archive writers (the core
 * and the machine toggle) schedule the background steps that mark every
 * message about the archived subtree read and mark the subtree's relation
 * rows (model/messages.ts scheduleArchivedReads). Both restore writers
 * schedule the steps that clear those marks again for every task they
 * restore, the row itself and each archived ancestor (model/archiveMarks.ts
 * scheduleMarkClears). Readers that skip marked rows read such a task
 * through its own indexes until they finish, so a restore writes no
 * relation row.
 *
 * Every core that changes a task (create, update, move on both ends,
 * archive, restore, delete) first runs the write gate, assertCanEdit, which
 * refuses an actor without Edit on the task's project. Each caller still
 * checks access itself, before the core, in its own order and with its own
 * sentence (the app's 'no write access to this project', REST's and MCP's
 * per-caller ones). The gate is defense in depth, so a new caller that
 * forgets its check still fails closed.
 *
 * Refusal grammar: `rule` sentences are toasted verbatim by the client.
 * `badRequest` sentences name machine fields where useful to API callers.
 * Both surfaces call the work items tasks and their children subtasks. */

import type { TransactionMetrics } from 'convex/server'
import { getDocumentSize, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import {
  canSeeProject,
  hasProjectLevel,
  profileCanBeAssigned,
  profileCanSeeProject,
} from '../lib/access'
import { HISTORY_PAGE_MAX, receivedRows } from '../lib/activityVisibility'
import { assertNewRowId, byId, newWindowKey, usedIdRow, usedMoreThan } from '../lib/db'
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  type IssuePriority,
  type IssueStatus,
  vIssuePriority,
  vIssueStatus,
} from '../lib/enums'
import { descriptionForm, printOf, trimmedForm } from '../lib/fieldPrints'
import { badRequest, forbidden, notFound, require, rule } from '../lib/functions'
import { shownImages } from '../lib/imageRefs'
import { limitedMarkdown, limitedText } from '../lib/limitRules'
import { grouped, LIMITS, PARENT_IS_SUBTASK, SUBTASK_WITH_SUBTASKS } from '../lib/limits'
import { countsAsSubtask, type Liveness, projectLiveness } from '../lib/liveTasks'
import { tooManyMentions } from '../lib/mentions'
import { reviewStamp } from '../lib/review'
import { issueKey, PRIORITY_NAMES, STATUS_NAMES } from '../lib/taskRefs'
import { inWorkingSet } from '../lib/workingSet'
import { excerpt, issueChanges, logActivity, machineDetail, narratedChange } from './activity'
import { scheduleMarkClears } from './archiveMarks'
import { startCount } from './commentLimits'
import { IMAGE_NOT_ATTACHED, settleDescriptionImages } from './descriptionImages'
import { insertTask, patchTask, type TaskFields } from './descriptions'
import {
  assertExpected,
  BOOLEAN,
  changedPrints,
  dayOf,
  exact,
  type Fields,
  filledText,
  hoursOrNull,
  idForm,
  oneOf,
  type Read,
  sentKeys,
  textOrNull,
  uuidOf,
  type View,
  type Writers,
} from './expected'
import { rekeyItems } from './inboxItems'
import {
  type NotifyPreload,
  newNotifyPreload,
  notifyIssueInsert,
  notifyIssueUpdate,
  orgProfile,
  scheduleArchivedReads,
} from './messages'
import { nextIssueNum, tallyRow, tallyRows } from './orgs'
import { reviewHoursFor } from './projects'
import { moveTaskFiles } from './storageTotals'
import { emitTaskEvent } from './taskEvents'
import { assertWeekPair, cleanRemaining, cleanTaskDate, roundTenths } from './taskValues'

export { ISSUE_PREFIX } from '../lib/taskRefs'
export { assertRemainingShape, assertWeekPair, cleanRemaining } from './taskValues'

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
/* The parent carries a subtask's context, so whoever works on a subtask
 * must be able to see every task above it. */
export const ASSIGNEE_SIGHT_RULE =
  'a subtask can only be assigned to someone who can see every task above it'
export const REVIEWER_SIGHT_RULE =
  'a subtask can only be reviewed by someone who can see every task above it'
export const HOLDER_SIGHT_RULE =
  'everyone assigned to or reviewing this task or its subtasks must be able to see the new parent and every task above it'
export const MOVE_HOLDER_RULE =
  'someone assigned to or reviewing a subtask of this task has no access to that sub-project; give them access there, or change who works on that subtask first'
export const REVIEWER_ON_GROUP =
  'a task with subtasks has no reviewer of its own; set reviewers on its subtasks'

/* A group's dates run from the earliest start to the latest end of its
 * scheduled leaves, so a direct date write on one is refused like its
 * status. The first sentence is the app's, the second the machine one that
 * names both REST fields. */
export const GROUP_DATES_RULE =
  'a task with subtasks takes its dates from them; plan its subtasks instead'
export const GROUP_DATES_MACHINE =
  'start_week and end_week cannot be set on a task with subtasks; its dates come from its subtasks'

/* The write gate's sentence. It names no caller kind, because each surface
 * refuses with its own sentence before any core runs. */
export const NO_WRITE_ACCESS = 'no write access to this project'

/** Refuses an actor without Edit (or Lead) on the project, the write gate
 * every task core runs first. A missing or foreign project refuses too. */
export async function assertCanEdit(
  ctx: QueryCtx,
  actor: Doc<'profiles'>,
  projectId: string,
): Promise<void> {
  if (!(await hasProjectLevel(ctx, actor, projectId, 'user'))) throw forbidden(NO_WRITE_ACCESS)
}

/* ------------------------------------------------------- shared guards
 * core.ts grammar (bad_request) — the machine surface's readable errors,
 * built here because the browser mutations need the same predicates. */

/** The title to store: trimmed, refused when blank or past LIMITS.title. */
export function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('title must be a non-empty string')
  const title = limitedText(LIMITS.title, raw)
  if (!title) throw rule('title must not be blank')
  return title
}

/** The description to store: trimmed, or '' for null or absent. Refuses
 * text past LIMITS.description or mentioning more people than
 * LIMITS.mentions allows. */
export function cleanDescription(raw: string | null | undefined): string {
  const text = limitedMarkdown(LIMITS.description, raw ?? '')
  if (tooManyMentions(text)) throw rule(LIMITS.mentions.refusal)
  return text
}

/* ------------------------------------------------------- the field check
 * A task edit's `expected` (model/expected.ts) takes these keys. The
 * parent compares as the pair a read shows: parent_id when the reader is
 * shown the parent, else has_hidden_parent. project_id is a move's. */

/** Whether `parentId` is shown to the reader as a parent: a task of the
 * reader's organization in a project it can see, and in the app also active
 * in an active project (lib/workingSet.ts inWorkingSet). */
async function parentShown(read: Read, parentId: string): Promise<boolean> {
  const parent = await byId(read.ctx, 'issues', parentId)
  if (parent === null || parent.org_id !== read.me.org_id) return false
  const project = await byId(read.ctx, 'projects', parent.project_id)
  if (project === null || !(await canSeeProject(read.ctx, read.me, project))) return false
  return read.view === 'machine' || inWorkingSet(parent, project, true)
}

const hoursForm = (value: unknown): unknown =>
  typeof value === 'number' ? roundTenths(value) : (value ?? null)

/** The keys of a task's `expected`, in the order refusals name them. */
export const TASK_FIELDS: Fields<Doc<'issues'>> = {
  // cleanTitle's rule
  title: { sends: 'title', type: filledText(LIMITS.title), form: trimmedForm, printed: true },
  description: {
    sends: 'description',
    type: textOrNull(LIMITS.description),
    form: descriptionForm,
    printed: true,
  },
  status: { sends: 'status', type: oneOf(ISSUE_STATUSES), form: exact },
  priority: { sends: 'priority', type: oneOf(ISSUE_PRIORITIES), form: exact },
  assignee_id: { sends: 'assignee_id', type: uuidOf('profile', true), form: idForm },
  reviewer_id: { sends: 'reviewer_id', type: uuidOf('profile', true), form: idForm },
  start_week: { sends: 'start_week', type: dayOf(true), form: exact },
  end_week: { sends: 'end_week', type: dayOf(true), form: exact },
  due_date: { sends: 'due_date', type: dayOf(true), form: exact },
  remaining_hours: {
    sends: 'remaining_hours',
    // cleanRemaining's rule
    type: hoursOrNull({
      min: 0,
      max: LIMITS.remainingHours.max,
      says: `a number from 0 to ${grouped(LIMITS.remainingHours.max)}, or null`,
    }),
    form: hoursForm,
    // REST and MCP read an active group's hours as null, even while it
    // still stores hours from before its subtasks (lib/core.ts issueOut)
    stored: async (issue, read) =>
      read.view === 'machine' &&
      issue.archived_at === undefined &&
      (await hasSubtasks(read.ctx, issue))
        ? null
        : issue.remaining_hours,
  },
  paused: { sends: 'paused', type: BOOLEAN, form: exact },
  parent_id: {
    sends: 'parent',
    type: uuidOf('task', true),
    form: idForm,
    pair: 'has_hidden_parent',
    shape: (expected) =>
      expected.parent_id != null && expected.has_hidden_parent === true
        ? 'expected.has_hidden_parent must be false when expected.parent_id names a task'
        : undefined,
    // A parent seen by id matches while it is stored. A parent seen hidden
    // matches any stored parent the reader is not shown, so a change from
    // one hidden parent to another goes unseen: telling it would tell of
    // tasks the reader cannot see. For the same reason an id the reader is
    // not shown now counts as a hidden parent, so the answer never says
    // whether a task the reader cannot see is the parent.
    compare: async ({ row, read, expected, next }) => {
      const stored = idForm(row.parent_id)
      const seenId = idForm(expected.parent_id)
      const hidden = async () => stored !== null && !(await parentShown(read, String(stored)))
      const seen =
        seenId !== null
          ? (await parentShown(read, String(seenId)))
            ? stored === seenId
            : await hidden()
          : expected.has_hidden_parent === true
            ? await hidden()
            : stored === null
      return { seen, next: idForm(next.parent_id) === stored }
    },
  },
  has_hidden_parent: { sends: 'parent', type: BOOLEAN, form: exact, pair: 'parent_id' },
  project_id: { sends: 'project', type: uuidOf('project', false), form: idForm },
}

/** The keys of a task's `expected` whose fields a REST body or MCP call
 * sends, a move by `project` or `sub_project` included. */
export function taskSentKeys(body: Readonly<Record<string, unknown>>): string[] {
  const keys = sentKeys(TASK_FIELDS, body)
  return 'sub_project' in body && !keys.includes('project_id') ? [...keys, 'project_id'] : keys
}

const nullableText = v.optional(v.union(v.string(), v.null()))

/** The app's `expected` for a task edit (TASK_FIELDS): the title and the
 * description as their prints (lib/fieldPrints.ts), every other key as the
 * value read. */
export const vTaskExpected = v.object({
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  status: v.optional(vIssueStatus),
  priority: v.optional(vIssuePriority),
  assignee_id: nullableText,
  reviewer_id: nullableText,
  start_week: nullableText,
  end_week: nullableText,
  due_date: nullableText,
  remaining_hours: v.optional(v.union(v.number(), v.null())),
  paused: v.optional(v.boolean()),
  parent_id: nullableText,
  has_hidden_parent: v.optional(v.boolean()),
  project_id: v.optional(v.string()),
})

/** Rows above this share of the transaction's budget leave the writers
 * unnamed, so a refusal late in a large batch still refuses cleanly. */
const WRITERS_ROOM = 0.5

/** Who wrote each of a task's `fields` as stored now: the actor of the
 * newest activity row whose field_prints holds the field, when that print is
 * the stored value's (`printed`, the print of the stored compare form) and
 * the caller may see the row (lib/activityVisibility.ts receivedRows). The
 * writers that log no row (a carried subtask, a cleared holder or parent's
 * hours, a detach) touch the task, so a task touched after its newest row
 * names nobody: such a writer may have put back a value an older row
 * printed. A newer row the caller cannot see hides the person rather than
 * naming an older one. It reads the task's newest HISTORY_PAGE_MAX rows, so
 * a field last written before them names nobody. */
export async function taskWriters(
  read: Read,
  issue: Doc<'issues'>,
  fields: readonly string[],
  printed: (field: string) => string,
): Promise<Writers> {
  const out = new Map<string, { by: string; at: string }>()
  if (await usedMoreThan(read.ctx, WRITERS_ROOM)) return out
  const newest = await read.ctx.db
    .query('activity_events')
    .withIndex('by_target', (q) =>
      q.eq('org_id', issue.org_id).eq('target_type', 'issue').eq('target_id', issue.id),
    )
    .order('desc')
    .take(HISTORY_PAGE_MAX)
  if (newest[0] === undefined || issue.updated_at > newest[0].ts) return out
  const visible = new Set(
    (await receivedRows(read.ctx, read.me, issue, newest)).map((row) => row.id),
  )
  for (const field of fields) {
    const row = newest.find((r) => r.field_prints?.[field] !== undefined)
    if (row === undefined || row.actor_id === undefined) continue
    if (row.field_prints?.[field] !== printed(field) || !visible.has(row.id)) continue
    out.set(field, { by: row.actor_id, at: row.ts })
  }
  return out
}

/** Refuses a task edit over a field someone else changed since `expected`
 * was read (model/expected.ts assertExpected), naming who where an activity
 * row proves it. `next` holds the value the edit sends for each key; hours
 * cleared by an edit that enters Review compare as the review time the core
 * stores instead, from `destination` for a move. */
export async function assertTaskExpected(
  ctx: QueryCtx,
  a: {
    me: Doc<'profiles'>
    issue: Doc<'issues'>
    view: View
    expected: Readonly<Record<string, unknown>> | undefined
    next: Readonly<Record<string, unknown>>
    destination?: Doc<'projects'>
  },
): Promise<void> {
  if (a.expected === undefined) return
  const read: Read = { ctx, me: a.me, view: a.view }
  let next = a.next
  if (
    'remaining_hours' in next &&
    next.remaining_hours == null &&
    next.status === 'review' &&
    a.issue.status !== 'review'
  ) {
    const project = a.destination ?? (await byId(ctx, 'projects', a.issue.project_id))
    if (project !== null) next = { ...next, remaining_hours: await reviewHoursFor(ctx, project) }
  }
  await assertExpected({
    read,
    fields: TASK_FIELDS,
    record: 'task',
    id: a.issue.id,
    label: issueKey(a.issue.num),
    row: a.issue,
    expected: a.expected,
    next,
    writers: (fields) =>
      taskWriters(read, a.issue, fields, (field) =>
        printOf(TASK_FIELDS[field].form((a.issue as Record<string, unknown>)[field])),
      ),
  })
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
      `user "${profileId}" is a viewer, who reads the projects they are added to and is never assigned work`,
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

/* assertAssignable for an update. As in the app (updateIssueCore), only a
 * change is checked. Sending the task's current assignee or reviewer again
 * hands over no new work, so it passes even after that person was switched
 * off or lost access. */
export async function assertAssignableChange(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  current: string | undefined,
  next: string,
  role: 'assignee' | 'reviewer' = 'assignee',
): Promise<void> {
  if (next !== current) await assertAssignable(ctx, project, next, role)
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

/* The tasks from `parentId` up, nearest first. Under the one level of
 * subtasks that is the parent alone; the seen set stops a corrupt cycle. */
async function ancestorsFrom(
  ctx: QueryCtx,
  parentId: string | undefined,
): Promise<Doc<'issues'>[]> {
  const chain: Doc<'issues'>[] = []
  const seen = new Set<string>()
  let cur = parentId
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur)
    const row = await byId(ctx, 'issues', cur)
    if (row === null) break
    chain.push(row)
    cur = row.parent_id
  }
  return chain
}

/* Whether a person can see every task in `chain`, through their own access
 * to each task's project. Answers per person, read once per project. A bulk
 * writer's `bulk` serves the profiles and projects from its preload and
 * keeps each sight that passed (sightKey), so a handover of many subtasks
 * asks it once per person and project. */
function chainSight(ctx: QueryCtx, chain: readonly Doc<'issues'>[], bulk?: BulkUpdate) {
  const projectIds = [...new Set(chain.map((t) => t.project_id))]
  const orgId = chain[0]?.org_id
  const known = new Map<string, Promise<boolean>>()
  return (profileId: string): Promise<boolean> => {
    let sees = known.get(profileId)
    if (sees === undefined) {
      sees = (async () => {
        const profile =
          bulk === undefined || orgId === undefined
            ? await byId(ctx, 'profiles', profileId)
            : ((await orgProfile(ctx, bulk.preload.profiles, orgId, profileId)) ?? null)
        if (profile === null) return false
        for (const id of projectIds) {
          const key = sightKey(profileId, id)
          if (bulk?.checked.has(key)) continue
          const project = bulk?.preload.projects.get(id) ?? (await byId(ctx, 'projects', id))
          if (project === null || !(await canSeeProject(ctx, profile, project))) return false
          bulk?.checked.add(key)
        }
        return true
      })()
      known.set(profileId, sees)
    }
    return sees
  }
}

/** How full a change that walks a task's subtasks may let its transaction
 * get (lib/db.ts usedMoreThan). Every walk has a fixed bound: at most
 * LIMITS.subtasks.max active subtasks, and a move carries at most LIMITS.moveSubtree.max
 * subtasks. The room is the backstop for the rest, such as the sight checks
 * of every person working on them or a write whose earlier work filled the
 * transaction. The walk asks every `every` queries or rows, and sooner once
 * the rows since it last asked may hold `bytes`. Past `room` the change is
 * refused with SUBTREE_TOO_LARGE rather than failing on one of Convex's
 * limits for one transaction. Before each task a change patches, it is
 * refused already when that patch would take it past `room`
 * (assertStepRoom). Tests lower these. */
export const SUBTREE_ROOM = { room: 0.9, every: 64, bytes: 512 * 1024 }

/** The refusal of a change whose task and subtasks are too large for one
 * transaction (SUBTREE_ROOM). */
export const SUBTREE_TOO_LARGE =
  'this task and its subtasks are too large to change in one request; detach some subtasks first'

/** The refusal of a move to another project whose task and subtasks are
 * too large for one transaction (SUBTREE_ROOM), such as
 * LIMITS.moveSubtree.max subtasks with very long descriptions. */
export const MOVE_TOO_LARGE =
  'this task and its subtasks are too large to move to another project in one request; remove some subtasks from this task first, restoring archived ones to do so, or move it within its project'

/* Refuses with `refusal`, SUBTREE_TOO_LARGE unless a move names its own,
 * once the transaction passed SUBTREE_ROOM's `room`. Run before each step
 * of a change whose cost has no fixed bound, such as one holder's sight
 * check, and through roomCheck for walks. */
async function assertRoom(ctx: QueryCtx, refusal = SUBTREE_TOO_LARGE): Promise<void> {
  if (await usedMoreThan(ctx, SUBTREE_ROOM.room)) throw rule(refusal)
}

/* A check to run before each query and after each row of a walk under
 * SUBTREE_ROOM, given the row's size (subtaskBytes). It asks the
 * transaction's use every `every` calls, or once the sizes since it last
 * asked reach `bytes` (assertRoom, with `refusal`). */
function roomCheck(ctx: QueryCtx, refusal = SUBTREE_TOO_LARGE): (bytes?: number) => Promise<void> {
  let calls = 0
  let pending = 0
  return async (bytes = 0) => {
    calls += 1
    pending += bytes
    if (calls % SUBTREE_ROOM.every !== 0 && pending < SUBTREE_ROOM.bytes) return
    pending = 0
    await assertRoom(ctx, refusal)
  }
}

/* An upper estimate of a task row's size for roomCheck: its title and
 * description, up to 3 bytes a UTF-16 unit, and 1 KiB for the rest. */
const subtaskBytes = (task: Doc<'issues'>): number =>
  3 * (task.title.length + (task.description?.length ?? 0)) + 1024

/* The bytes one step of a change reads and writes. */
type StepCost = { reads: number; writes: number }

/* What patching task `task` reads and writes (model/descriptions.ts
 * patchTask): the task row again and its description row twice, as it is
 * found and as its write reads it again, and both rows written. Neither
 * row is larger than the task row while issues.description holds the
 * text, so a task stored before the caps, which can come close to Convex's
 * document size limit, costs about three times that limit in reads. */
const patchCost = (task: Doc<'issues'>): StepCost => {
  const size = getDocumentSize(task)
  return { reads: 3 * size, writes: 2 * size }
}

/* Refuses with `refusal` unless the transaction can take one more step
 * that costs `step`, and `reserve` bytes of reads after the change, and
 * still stay within SUBTREE_ROOM's `room` of each of Convex's limits. Run
 * before each task a change patches: one step can read more than the
 * share of the limits that `room` keeps back for the rest of the change,
 * so asking only whether the transaction has passed `room` (assertRoom)
 * could let the step pass Convex's limit. */
async function assertStepRoom(
  ctx: QueryCtx,
  step: StepCost,
  refusal: string,
  reserve = 0,
): Promise<void> {
  const metrics = await ctx.meta.getTransactionMetrics()
  const more: Partial<Record<keyof TransactionMetrics, number>> = {
    bytesRead: step.reads + reserve,
    bytesWritten: step.writes,
  }
  const full = (Object.keys(metrics) as Array<keyof TransactionMetrics>).some((key) => {
    const { used, remaining } = metrics[key]
    return used + (more[key] ?? 0) > (used + remaining) * SUBTREE_ROOM.room
  })
  if (full) throw rule(refusal)
}

/* The active subtasks of the task `parentId`, one by_parent_archived range,
 * at most LIMITS.subtasks.max rows. */
const activeSubtasks = (ctx: QueryCtx, parentId: string) =>
  ctx.db
    .query('issues')
    .withIndex('by_parent_archived', (q) =>
      q.eq('parent_id', parentId).eq('archived_at', undefined),
    )

/* The people working on a task and its active subtasks: each assignee, and
 * each reviewer of a task that is no group (a group's reviewer is dormant).
 * `self` holds the task's own next values. Callers skip switched-off people,
 * who hold no new work. A subtask has no subtasks of its own, so each one's
 * reviewer counts, and the walk reads one range of at most
 * LIMITS.subtasks.max active subtasks, under SUBTREE_ROOM, unless the caller
 * already read them all (`kids`, every subtask, archived ones too, which do
 * not count). `refusal` is the room refusal (assertRoom). */
async function holdersUnder(
  ctx: QueryCtx,
  rootId: string,
  self: { assignee_id?: string; reviewer_id?: string; group: boolean },
  read: { kids?: readonly Doc<'issues'>[]; refusal?: string } = {},
): Promise<string[]> {
  const holders = new Set<string>()
  if (self.assignee_id !== undefined) holders.add(self.assignee_id)
  if (self.reviewer_id !== undefined && !self.group) holders.add(self.reviewer_id)
  const room = roomCheck(ctx, read.refusal)
  await room()
  const kids = read.kids?.filter((c) => c.archived_at === undefined) ?? activeSubtasks(ctx, rootId)
  for await (const c of kids) {
    await room(subtaskBytes(c))
    if (c.assignee_id !== undefined) holders.add(c.assignee_id)
    if (c.reviewer_id !== undefined) holders.add(c.reviewer_id)
  }
  return [...holders]
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
    throw badRequest(
      `${project.key} is archived, so restore it in the app before adding tasks to it`,
    )
  }
}

/* …and the DB backstop's sentence (issue_project_archived_guard, 0106:123-139).
 * Arrivals ONLY — created there, moved there; editing a task already inside
 * an archived project stays allowed (the nightly sweep updates rows in one). */
export function assertProjectArrival(project: Doc<'projects'>): void {
  if (project.archived_at !== undefined) throw rule('that project is archived, so restore it first')
}

export const SUB_MUST_NAME = 'sub_project must name a sub-project by key, number or uuid'

/* The task lands in a sub-project OF the stated project (core.ts:358-362). */
export function pairRule(project: Doc<'projects'>, sub: Doc<'projects'>): void {
  if (sub.type !== 'project' || (sub.id !== project.id && sub.parent_id !== project.id)) {
    throw badRequest(
      `sub-project ${sub.key} does not belong to project ${project.key}, and tasks are never created under another project's sub-project`,
    )
  }
}

/* The sentence a bare meta gets (core.ts:368-374). Sub-projects the caller
 * cannot read are neither offered nor counted, and only live,
 * caller-writable ones are offered. */
export function metaNeedsSub(
  project: Doc<'projects'>,
  liveKids: Doc<'projects'>[],
  can: { readable: (id: string) => boolean; writable: (id: string) => boolean },
): never {
  const seen = liveKids.filter((c) => can.readable(c.id))
  const mine = seen
    .filter((c) => can.writable(c.id))
    .map((c) => c.key)
    .sort()
  throw badRequest(
    `${project.key} is a project, and tasks live in its sub-projects; ${
      mine.length
        ? `pass sub_project (one of: ${mine.join(', ')})`
        : seen.length
          ? 'you have no write access to any of them'
          : 'it has no sub-projects yet, so create one in the app first'
    }`,
  )
}

/* The task fields the group rule reads. */
type GroupRow = Pick<Doc<'issues'>, 'id' | 'archived_at' | 'project_id'>

/* Whether `child` makes `parent` a group (countsAsSubtask), with each
 * project's state read through `live`. */
async function subtaskOf(parent: GroupRow, child: GroupRow, live: Liveness): Promise<boolean> {
  return countsAsSubtask(
    { archived: parent.archived_at !== undefined, projectLive: await live(parent.project_id) },
    { archived: child.archived_at !== undefined, projectLive: await live(child.project_id) },
  )
}

/* Whether the task has an active subtask that makes it a group
 * (countsAsSubtask). This is the remaining guards' test, which leaves
 * archived subtasks out even under an archived task (0070). One
 * by_parent_archived range and each subtask's project once. */
async function hasActiveSubtasks(
  ctx: QueryCtx,
  issue: GroupRow,
  live: Liveness = projectLiveness(ctx),
): Promise<boolean> {
  const archived = issue.archived_at !== undefined
  // an archived task counts every subtask, whatever its project
  const parent = { archived, projectLive: !archived && (await live(issue.project_id)) }
  const kids = ctx.db
    .query('issues')
    .withIndex('by_parent_archived', (q) =>
      q.eq('parent_id', issue.id).eq('archived_at', undefined),
    )
  for await (const kid of kids) {
    if (countsAsSubtask(parent, { archived: false, projectLive: await live(kid.project_id) })) {
      return true
    }
  }
  return false
}

/* Machine pre-check twin of the remaining guard (core.ts:397-402), naming
 * the remaining_hours field that the caller needs to correct. */
export async function assertNoSubtasks(ctx: QueryCtx, issue: GroupRow): Promise<void> {
  if (await hasActiveSubtasks(ctx, issue)) {
    throw badRequest(
      'remaining_hours cannot be set on a task with subtasks, because it is the sum of their remaining time',
    )
  }
}

/* A task is a group while a subtask makes it one (lib/liveTasks.ts
 * countsAsSubtask). An active task in an active project is one through an
 * active subtask in an active project, an active task in an archived
 * project through any active subtask, and an archived task through any
 * subtask, so archived groups retain their hierarchy for display until
 * restored. The stored status, start_week and end_week stay dormant, ready
 * to resume after the last such subtask is detached, deleted or archived,
 * or its project is archived. Nothing reads, clears or migrates them while
 * the task is a group; readers calculate its dates from its leaves instead.
 * Child visibility must not change this fact: readers disclose only the
 * boolean, never hidden child identities. `live` reads each project once;
 * callers that hold the organization's projects pass them. */
export async function hasSubtasks(
  ctx: QueryCtx,
  issue: GroupRow,
  live: Liveness = projectLiveness(ctx),
): Promise<boolean> {
  if (issue.archived_at === undefined) return await hasActiveSubtasks(ctx, issue, live)
  const kid = await ctx.db
    .query('issues')
    .withIndex('by_parent', (q) => q.eq('parent_id', issue.id))
    .first()
  return kid !== null
}

/* Machine pre-check twin of the group-dates guard in updateIssueCore,
 * naming both REST fields. The caller runs it whenever start_week or
 * end_week is present, so null and unchanged values are refused too. */
export async function assertNoGroupDates(ctx: QueryCtx, issue: Doc<'issues'>): Promise<void> {
  if (await hasSubtasks(ctx, issue)) {
    throw badRequest(GROUP_DATES_MACHINE)
  }
}

/* The trigger's sentence (issue_remaining_guard, 0066:44 + 0070:184 child
 * filter): the browser mutation's backstop, fired only when the value
 * actually changes to non-null; clearing always passes. */
export async function assertOwnRemaining(ctx: QueryCtx, issue: GroupRow): Promise<void> {
  if (await hasActiveSubtasks(ctx, issue)) {
    throw rule(
      'a task with subtasks has no remaining time of its own, because it shows the sum of its subtasks',
    )
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
/* A group holds no work of its own (its pause is dormant like its status),
 * so a pause asked for on one is refused; clearing a stored one passes. */
export const GROUP_PAUSE_RULE = 'a task with subtasks cannot be paused; pause its subtasks instead'

/* -------------------------------------------------- the parent link fence
 * issues_check_parent (0057:38-85, final), plus the subtask family rule and
 * the one level of subtasks (lib/limits.ts). The caller must pass the
 * row's PINNED org (0057:27-30: org from the project first, THEN this
 * check). A parent the actor cannot see (missing, in another organization or
 * in a hidden project) answers 'parent task not found' before any other
 * guard describes it. Attaching changes the parent (it becomes a group and
 * loses its own hours), so it also needs Edit on the parent's project, like
 * any other change to it. A subtask stays in its parent's top-level project,
 * in any of its sub-projects. */

/** The top-level project a project belongs to, which is its parent or itself. */
export const topLevelOf = (project: Pick<Doc<'projects'>, 'id' | 'parent_id'>): string =>
  project.parent_id ?? project.id

/** Whether projects `child` and `parent` are in the same top-level project,
 * so that a task in `child` may be a subtask of a task in `parent`.
 * parentChainCheck and the restore from Deleted items (model/deletedItems.ts
 * keptParent) share it. */
export const sameTopLevel = (
  child: Pick<Doc<'projects'>, 'id' | 'parent_id'>,
  parent: Pick<Doc<'projects'>, 'id' | 'parent_id'>,
): boolean => topLevelOf(child) === topLevelOf(parent)

/* Refused by assertParentChain for a parent in another top-level project. */
export const SUBTASK_PROJECT_RULE =
  'a subtask must be in the same project as its parent task, in any of its sub-projects'

/** Why parentChainCheck refuses a parent, in the order it checks.
 * `parent_is_subtask` means the parent has a parent of its own,
 * `has_subtasks` that the child has subtasks, archived ones included, and
 * `parent_full` that the parent already has LIMITS.subtasks.max active
 * subtasks, whether the child is active or not. Any of them would break the
 * one level of subtasks or its size. */
export type ParentProblem =
  | 'self'
  | 'not_found'
  | 'no_write'
  | 'other_project'
  | 'parent_is_subtask'
  | 'has_subtasks'
  | 'parent_full'

/** How many active subtasks `parentId` has, counted up to
 * LIMITS.subtasks.max: one by_parent_archived range of at most that many
 * rows, under SUBTREE_ROOM. */
export async function subtaskCount(ctx: QueryCtx, parentId: string): Promise<number> {
  const room = roomCheck(ctx)
  await room()
  let count = 0
  for await (const kid of activeSubtasks(ctx, parentId)) {
    count += 1
    if (count >= LIMITS.subtasks.max) break
    await room(subtaskBytes(kid))
  }
  return count
}

/** Whether the task has any subtask, archived or not. */
export async function hasAnySubtask(ctx: QueryCtx, issueId: string): Promise<boolean> {
  const kid = await ctx.db
    .query('issues')
    .withIndex('by_parent', (q) => q.eq('parent_id', issueId))
    .first()
  return kid !== null
}

/** Checks a proposed parent link, answering a problem rather than throwing
 * one, for writers that adapt instead of refusing; assertParentChain throws
 * from it. `child.project_id` is the project the child will be in after the
 * write. Checks the cheapest facts first, and a parent the actor cannot see
 * is `not_found` before anything else describes it. A parent without a
 * parent of its own and a child without subtasks can form no cycle and no
 * chain deeper than two tasks, so neither chain is walked. */
export async function parentChainCheck(
  ctx: QueryCtx,
  child: { id: string; org_id: string; project_id: string },
  parentId: string,
  actor: Doc<'profiles'>,
): Promise<{ ok: true; parent: Doc<'issues'> } | { ok: false; problem: ParentProblem }> {
  const no = (problem: ParentProblem) => ({ ok: false, problem }) as const
  if (parentId === child.id) return no('self')
  const parent = await byId(ctx, 'issues', parentId)
  const parentProject =
    parent === null || parent.org_id !== child.org_id
      ? null
      : await byId(ctx, 'projects', parent.project_id)
  if (
    parent === null ||
    parentProject === null ||
    !(await canSeeProject(ctx, actor, parentProject))
  ) {
    return no('not_found')
  }
  if (!(await hasProjectLevel(ctx, actor, parentProject.id, 'user'))) return no('no_write')
  const childProject = await byId(ctx, 'projects', child.project_id)
  if (childProject === null || !sameTopLevel(childProject, parentProject)) {
    return no('other_project')
  }
  if (parent.parent_id !== undefined) return no('parent_is_subtask')
  if (await hasAnySubtask(ctx, child.id)) return no('has_subtasks')
  if ((await subtaskCount(ctx, parent.id)) >= LIMITS.subtasks.max) return no('parent_full')
  return { ok: true, parent }
}

/* The refusal for each problem: `rule` sentences for the family's shape,
 * the uniform not-found answer and the parent's write refusal. */
const PARENT_REFUSALS: Record<ParentProblem, () => ReturnType<typeof rule>> = {
  self: () => rule('a task cannot be its own parent'),
  not_found: () => notFound('parent task not found'),
  no_write: () => forbidden('no write access to the parent task'),
  other_project: () => rule(SUBTASK_PROJECT_RULE),
  parent_is_subtask: () => rule(PARENT_IS_SUBTASK),
  has_subtasks: () => rule(SUBTASK_WITH_SUBTASKS),
  parent_full: () => rule(LIMITS.subtasks.refusal),
}

/** parentChainCheck as a guard. It refuses a parent that does not qualify
 * and returns the parent row for the follow-up guards. */
export async function assertParentChain(
  ctx: QueryCtx,
  child: { id: string; org_id: string; project_id: string },
  parentId: string,
  actor: Doc<'profiles'>,
): Promise<Doc<'issues'>> {
  const check = await parentChainCheck(ctx, child, parentId, actor)
  // compared, not tested for truth, because the app's loose tsconfig narrows only so
  if (check.ok === false) throw PARENT_REFUSALS[check.problem]()
  return check.parent
}

/* issue_archive_parent_guard (0070:65-82): an ACTIVE row under an ARCHIVED
 * parent is refused. Archived children under an active parent are normal —
 * that IS archiving (the survey had this backwards; the SQL wins). */
export function assertParentActive(
  parent: Doc<'issues'>,
  childArchivedAt: string | undefined,
): void {
  if (childArchivedAt === undefined && parent.archived_at !== undefined) {
    throw rule('the parent task is archived, so restore it first')
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

/* Who may add or remove a link (0008:12-21), one rule for every surface. The
 * caller must see both tasks' projects and hold Edit on at least one end.
 * 'hidden' covers a missing, foreign or unseen end alike, so callers answer
 * all three with one sentence and no answer describes a task the caller
 * cannot see; 'read' means both ends are visible but neither is editable. */
export async function linkAccess(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: Doc<'issues'> | null,
  b: Doc<'issues'> | null,
): Promise<'hidden' | 'read' | 'write'> {
  if (a === null || b === null) return 'hidden'
  for (const end of [a, b]) {
    if (end.org_id !== me.org_id) return 'hidden'
    const project = await byId(ctx, 'projects', end.project_id)
    if (project === null || !(await canSeeProject(ctx, me, project))) return 'hidden'
  }
  for (const end of [a, b]) {
    if (await hasProjectLevel(ctx, me, end.project_id, 'user')) return 'write'
  }
  return 'read'
}

/* --------------------------------------------------------- done stamp (0071)
 * done_at is fully derived, immune to direct writes; no public arg carries it.
 * A move to another sub-project restarts it (movedStamps). */

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

/* --------------------------------------------- remaining clear-on-attach
 * issue_remaining_clear (0066/0067): a parent gaining a sub-issue loses its
 * own hours (adapt, don't reject). The stamp clears with them (0072 pairing),
 * and so does a review hand-off from its leaf days (a group has none), and
 * the parent is touched AND notified — in SQL this inner UPDATE fired the
 * stamp, touch and notify triggers, so its subscribers saw
 * "Remaining cleared (was N h)". 0067's row lock is subsumed by Convex
 * serializability. `actor` is absent only for a background step whose
 * person is gone, and `preload` is that step's (regroup.ts). */
export async function clearParentRemaining(
  ctx: MutationCtx,
  a: {
    parentId: string
    actor: Doc<'profiles'> | undefined
    now: string
    preload?: NotifyPreload
  },
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
  await notifyIssueUpdate(ctx, { before, after, actor: a.actor, now: a.now, preload: a.preload })
}

/* ------------------------------------------------------------- detaching
 * A subtask its parent leaves behind: when the parent moves to Deleted
 * items (model/deletedItems.ts) or is archived alone (archiveIssueCore with
 * keepSubtasks). The child becomes a top-level task with the SET NULL's
 * touch, and its followers read 'Detached from its parent' with
 * task.updated, as the SQL schema's SET NULL did. The child's
 * project needs no Edit: only the link to the parent goes, as a delete has
 * always detached such children. The child is not read again, because its
 * new state is `child` with the patch applied: a delete detaches up to
 * LIMITS.subtasks.max children, whose descriptions a second read would count twice
 * against the transaction's 16 MiB. */
export async function detachChild(
  ctx: MutationCtx,
  child: Doc<'issues'>,
  actor: Doc<'profiles'> | undefined,
  now: string,
  preload?: NotifyPreload,
): Promise<void> {
  await ctx.db.patch(child._id, { parent_id: undefined, updated_at: now })
  const { parent_id: _parentId, ...rest } = child
  const after: Doc<'issues'> = { ...rest, updated_at: now }
  await notifyIssueUpdate(ctx, { before: child, after, actor, now, preload })
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

/** The app's verb and detail for an update of `before` to `after`, chosen
 * by the highest-ranked key `patch` holds (status first), and `named`, the numbers of
 * the tasks the detail names in text order ([] when none), which the row
 * stores for the visibility rule. */
export async function browserVerbDetail(
  ctx: QueryCtx,
  a: { before: Doc<'issues'>; after: Doc<'issues'>; patch: IssuePatch },
): Promise<{ verb: string; detail: string | undefined; named: number[] }> {
  const { before, after, patch } = a
  const fmt = async () =>
    (await byId(ctx, 'organizations', before.org_id))?.date_format ?? 'YYYY-MM-DD'
  const name = async (id: string | undefined) =>
    id === undefined ? null : ((await byId(ctx, 'profiles', id))?.name ?? null)
  const numOf = async (id: string | undefined) => {
    if (id === undefined) return null
    return (await byId(ctx, 'issues', id))?.num ?? null
  }
  // 1 decimal, matching numeric(6,1) — the feed states what is stored
  const hours = (n: number) => `${roundTenths(n)} h`
  if ('status' in patch) {
    return {
      verb: 'moved',
      detail: `from ${STATUS_NAMES[before.status]} to ${STATUS_NAMES[after.status]}`,
      named: [],
    }
  }
  if ('assignee_id' in patch) {
    const from = await name(before.assignee_id)
    if (after.assignee_id === undefined) {
      return { verb: 'unassigned', detail: from ? `(was ${from})` : undefined, named: [] }
    }
    return {
      verb: 'assigned',
      detail: `to ${(await name(after.assignee_id)) ?? 'no one'}${from ? ` (was ${from})` : ''}`,
      named: [],
    }
  }
  if ('reviewer_id' in patch) {
    const from = await name(before.reviewer_id)
    if (after.reviewer_id === undefined) {
      return {
        verb: 'removed the reviewer from',
        detail: from ? `(was ${from})` : undefined,
        named: [],
      }
    }
    return {
      verb: 'set the reviewer of',
      detail: `to ${(await name(after.reviewer_id)) ?? 'no one'}${from ? ` (was ${from})` : ''}`,
      named: [],
    }
  }
  if ('due_date' in patch) {
    const f = await fmt()
    if (after.due_date === undefined) {
      return {
        verb: 'cleared the due date on',
        detail:
          before.due_date !== undefined ? `(was ${fmtFullWith(f, before.due_date)})` : undefined,
        named: [],
      }
    }
    if (before.due_date !== undefined) {
      return {
        verb: 'moved the due date on',
        detail: `from ${fmtFullWith(f, before.due_date)} to ${fmtFullWith(f, after.due_date)}`,
        named: [],
      }
    }
    return { verb: 'set a due date on', detail: `to ${fmtFullWith(f, after.due_date)}`, named: [] }
  }
  if ('start_week' in patch || 'end_week' in patch) {
    const f = await fmt()
    const was =
      before.start_week !== undefined
        ? fmtRangeWith(f, before.start_week, before.end_week ?? before.start_week)
        : null
    if (after.start_week === undefined) {
      return {
        verb: 'removed from the roadmap',
        detail: was ? `(was ${was})` : undefined,
        named: [],
      }
    }
    const to = fmtRangeWith(f, after.start_week, after.end_week ?? after.start_week)
    if (was) return { verb: 'rescheduled', detail: `from ${was} to ${to}`, named: [] }
    return { verb: 'scheduled', detail: `for ${to}`, named: [] }
  }
  if ('title' in patch) return { verb: 'renamed', detail: `from “${before.title}”`, named: [] }
  if ('paused' in patch)
    return { verb: after.paused ? 'paused' : 'resumed', detail: undefined, named: [] }
  if ('priority' in patch) {
    return {
      verb: 'reprioritized',
      detail: `from ${PRIORITY_NAMES[before.priority]} to ${PRIORITY_NAMES[after.priority]}`,
      named: [],
    }
  }
  if ('parent_id' in patch) {
    const from = await numOf(before.parent_id)
    if (after.parent_id !== undefined) {
      const to = await numOf(after.parent_id)
      return {
        verb: 'moved',
        detail: `under ${to === null ? 'its parent' : issueKey(to)}${from === null ? '' : ` (from ${issueKey(from)})`}`,
        named: [to, from].filter((num) => num !== null),
      }
    }
    return {
      verb: 'detached',
      detail: from === null ? 'from its parent' : `from ${issueKey(from)}`,
      named: from === null ? [] : [from],
    }
  }
  if ('remaining_hours' in patch) {
    const prev = before.remaining_hours
    if (after.remaining_hours === undefined) {
      return {
        verb: 'cleared the remaining time on',
        detail: prev !== undefined ? `(was ${hours(prev)})` : undefined,
        named: [],
      }
    }
    if (prev !== undefined) {
      return {
        verb: 'changed the remaining time on',
        detail: `from ${hours(prev)} to ${hours(after.remaining_hours)}`,
        named: [],
      }
    }
    return {
      verb: 'set the remaining time on',
      detail: `to ${hours(after.remaining_hours)}`,
      named: [],
    }
  }
  if ('description' in patch) {
    const from = before.description ?? ''
    const to = after.description ?? ''
    if (to === '') {
      return {
        verb: 'removed the description from',
        detail: from !== '' ? `(was “${excerpt(from)}”)` : undefined,
        named: [],
      }
    }
    if (from !== '') {
      return {
        verb: 'updated the description of',
        detail: `from “${excerpt(from)}” to “${excerpt(to)}”`,
        named: [],
      }
    }
    return { verb: 'added a description to', detail: `“${excerpt(to)}”`, named: [] }
  }
  return { verb: 'updated', detail: undefined, named: [] }
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
 *   update's `appGrammar` keeps the browser verb and detail and appends the
 *           provenance instead. A parent change uses it, because the
 *           machine diff cannot name tasks; the row stores the numbers of
 *           the tasks the browser detail names (named_task_nums), which the
 *           activity reader checks
 *   move    detail = the browser's destination sentence plus the provenance
 *   delete  model/deletedItems.ts moveTasksToTrash's `provenance` is the
 *           'deleted' row's detail
 *   move's and update's `later` name the people a later write of the same
 *           machine update sets (LaterPeople)
 *   move's `laterParent` is the parent the same machine update sets after
 *           the move (a task id, or null to detach); absent when the update
 *           leaves the parent alone */
export type MachineNarration = { provenance: string }
export type MachineUpdate = MachineNarration & {
  archive?: boolean
  appGrammar?: boolean
  later?: LaterPeople
  /** The update names the task's current parent, so a restore under it
   * that is full is refused with LIMITS.subtasks' sentence rather than
   * leaving it. */
  keepParent?: boolean
  /** An earlier write of the same update gave the task its parent, so a
   * pending detach of that parent's subtasks never concerned it
   * (restoreLeavesParent). */
  parentChosen?: boolean
}
export type MachineMove = MachineNarration & {
  later?: LaterPeople
  laterParent?: string | null
  /** The caller answers with the task's full read, which reads its active
   * subtasks again (lib/core.ts taskOut), as REST's PATCH does. MCP's
   * update_task answers with the task's id alone. */
  answerReadsSubtasks?: boolean
}

/**
 * The assignee and reviewer that a later write of the same machine update
 * sets (lib/core.ts applyTaskUpdate's field patch), with IssuePatch's
 * presence rule, so a key present replaces the field and null clears it. A move
 * or a parent change does not check a person this replaces, because the task
 * will not keep them. The later write checks the replacement at the task's
 * project and against its parents, as any change of assignee or reviewer is
 * checked, and the whole update rolls back if it is refused.
 */
export type LaterPeople = Pick<IssuePatch, 'assignee_id' | 'reviewer_id'>

/** Whether `later` gives the task someone other than its current `field`. */
function replacedLater(
  issue: Doc<'issues'>,
  later: LaterPeople | undefined,
  field: keyof LaterPeople,
): boolean {
  return later !== undefined && field in later && (later[field] ?? undefined) !== issue[field]
}

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

/* The refusal of a create whose client-chosen id names a task already. */
const DUPLICATE_TASK_ID = 'a task with this id already exists'

/** Creates the task `args` describes as `me`, who needs Edit on its
 * sub-project, and answers the stored row. The app, REST and MCP all create
 * through it, so every shared field rule runs here, including the title cap
 * and the description cap (LIMITS.description). */
export async function createIssueCore(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; args: CreateIssueArgs; now: string; machine?: MachineNarration },
): Promise<Doc<'issues'>> {
  const { me, args, now } = a
  assertNewRowId(args.id)
  await assertCanEdit(ctx, me, args.project_id)
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
  const description = cleanDescription(args.description)
  // a new task has no attachments, so its description can show no image of
  // its own (model/descriptionImages.ts)
  if (shownImages(description).size > 0) throw rule(IMAGE_NOT_ATTACHED)
  const parent_id = args.parent_id ?? undefined
  if (parent_id !== undefined) {
    // a used id, live, held by Deleted items or recorded in used_ids, is
    // refused first, so the subtask check below, which reads the subtasks
    // of the id it is given, tells nothing about another task
    const held = await ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) => q.eq('table', 'issues').eq('row_id', args.id))
      .first()
    if (
      (await byId(ctx, 'issues', args.id)) !== null ||
      held !== null ||
      (await usedIdRow(ctx, 'issues', args.id)) !== null
    ) {
      throw badRequest(DUPLICATE_TASK_ID)
    }
    const child = { id: args.id, org_id, project_id: project.id }
    const parent = await assertParentChain(ctx, child, parent_id, me)
    assertParentActive(parent, undefined) // a fresh row is active
  }
  const assignee_id = args.assignee_id ?? undefined
  if (assignee_id !== undefined) await assertAssigneeRule(ctx, project, assignee_id)
  const reviewer_id = args.reviewer_id ?? undefined
  if (reviewer_id !== undefined) await assertAssigneeRule(ctx, project, reviewer_id, 'reviewer')
  // whoever holds a subtask must see every task above it
  if (parent_id !== undefined && (assignee_id !== undefined || reviewer_id !== undefined)) {
    const sees = chainSight(ctx, await ancestorsFrom(ctx, parent_id))
    if (assignee_id !== undefined && !(await sees(assignee_id))) throw rule(ASSIGNEE_SIGHT_RULE)
    if (reviewer_id !== undefined && !(await sees(reviewer_id))) throw rule(REVIEWER_SIGHT_RULE)
  }
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
  await insertTask(
    ctx.db,
    {
      id: args.id,
      project_id: project.id,
      org_id,
      num,
      title,
      description,
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
      status_at: now,
      archived_at: undefined,
      window_key: newWindowKey(),
      created_at: now,
      updated_at: now,
    },
    badRequest(DUPLICATE_TASK_ID),
  )
  const issue = (await byId(ctx, 'issues', args.id)) as Doc<'issues'>
  await tallyRow(ctx, 'issues', null, issue)
  await startCount(ctx, issue)
  // the attach clears the parent's hours; its dates are calculated, never
  // written. A new task is active in an active project (the arrival guard),
  // so it always makes its parent a group.
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
    named_task_nums: [],
  }
  await logActivity(ctx, event)
  return issue
}

/* ----------------------------------------------------------- update core */

/* A key's PRESENCE means "set this field"; null clears (Convex strips
 * undefined from args, so null is the wire form of a clear — stored rows
 * still hold ABSENT, never null). reporter_id/num/org_id/done_at/remaining_set_at/
 * review_at/status_at/archived_at deliberately have no slot: immutable or
 * server-owned. */
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

/** Reused answers for a bulk writer that runs updateIssueCore for many
 * tasks in one transaction, which changes no profile, project, grant, team or
 * team membership while it runs (model/messages.ts NotifyPreload). `checked`
 * holds the checks already passed, under gateKey, holderKey and sightKey, so
 * the write gate runs once per project, and each assignee or reviewer rule
 * and each sight of a parent chain's project once per person and project.
 * No single task write passes one. */
export type BulkUpdate = { preload: NotifyPreload; checked: Set<string> }

/* The BulkUpdate key of `actorId`'s passed write gate on a project. */
const gateKey = (actorId: string, projectId: string): string => `gate:${actorId}:${projectId}`

/** The BulkUpdate key of a passed assignee or reviewer rule for a profile on
 * a project (assertAssigneeRule). */
export const holderKey = (
  role: 'assignee' | 'reviewer',
  profileId: string,
  projectId: string,
): string => `holder:${role}:${profileId}:${projectId}`

/* The BulkUpdate key of a profile's passed sight of a project (chainSight). */
const sightKey = (profileId: string, projectId: string): string => `sight:${profileId}:${projectId}`

/* Runs `check` unless the bulk writer already passed `key`, and records the
 * key once it passes. Without a bulk writer it always runs. */
async function checkOnce(
  bulk: BulkUpdate | undefined,
  key: string,
  check: () => Promise<void>,
): Promise<void> {
  if (bulk?.checked.has(key)) return
  await check()
  bulk?.checked.add(key)
}

/** Applies `patch` to `issue` as `me`, who needs Edit on its project, and
 * answers the stored row. A key present in the patch sets that field and null
 * clears it. `machine` carries a REST or MCP caller's provenance and
 * archive toggle (MachineUpdate). `bulk` lets a bulk writer skip the write
 * gate and the assignee and reviewer rules it already passed for the
 * project, and notify from its preload (BulkUpdate). */
export async function updateIssueCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    issue: Doc<'issues'>
    patch: IssuePatch
    now: string
    machine?: MachineUpdate
    bulk?: BulkUpdate
  },
): Promise<Doc<'issues'>> {
  const { me, issue, now, bulk } = a
  await checkOnce(bulk, gateKey(me.id, issue.project_id), () =>
    assertCanEdit(ctx, me, issue.project_id),
  )
  // An unchanged parent is no attach: it is dropped, so no access check,
  // write, hours clear or narration runs for a parent the caller may not
  // even see.
  const patch: IssuePatch =
    'parent_id' in a.patch && (a.patch.parent_id ?? undefined) === issue.parent_id
      ? (({ parent_id: _unchanged, ...rest }) => rest)(a.patch)
      : a.patch
  // Public validators omit this field; also fail explicitly at the shared
  // model boundary so trusted callers cannot accidentally alter attribution.
  if ('reporter_id' in patch) throw badRequest(REPORTER_IMMUTABLE_SENTENCE)
  const w: TaskFields = {}
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
  // a restore that leaves a full or deleted parent (restoreLeavesParent)
  // makes the task top-level, so the guards below check it without that
  // parent; a machine restore that names that parent is refused
  const leaves =
    !('parent_id' in patch) && toggle === 'restored'
      ? await restoreLeavesParent(ctx, issue, a.machine?.parentChosen === true)
      : undefined
  if (leaves !== undefined && a.machine?.keepParent === true) throw rule(leaves)
  const leavesParent = leaves !== undefined
  const nextParent =
    'parent_id' in patch
      ? (patch.parent_id ?? undefined)
      : leavesParent
        ? undefined
        : issue.parent_id
  // the new parent's row, for the clear-on-attach below
  let attachedTo: Doc<'issues'> | undefined
  if ('parent_id' in patch) {
    if (nextParent !== undefined) {
      attachedTo = await assertParentChain(ctx, issue, nextParent, me)
      assertParentActive(attachedTo, issue.archived_at)
    }
    w.parent_id = nextParent
  } else if (leavesParent) {
    w.parent_id = undefined // ctx.db.patch unsets it
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
  // and only by the status, dates, pause and reviewer guards (a group's are
  // dormant)
  let group: boolean | undefined
  const live = projectLiveness(ctx)
  const isGroup = async (): Promise<boolean> => (group ??= await hasSubtasks(ctx, issue, live))
  if ('assignee_id' in patch) {
    const next = patch.assignee_id ?? undefined
    // fires only when the assignee actually CHANGES (0099/0102): deactivating
    // someone leaves existing assignments alone
    if (next !== undefined && next !== issue.assignee_id) {
      await checkOnce(bulk, holderKey('assignee', next, issue.project_id), async () =>
        assertAssigneeRule(ctx, await loadProject(), next),
      )
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
        await checkOnce(bulk, holderKey('reviewer', next, issue.project_id), async () =>
          assertAssigneeRule(ctx, await loadProject(), next, 'reviewer'),
        )
      }
    }
    w.reviewer_id = next
  }
  // whoever holds a subtask must see every task above it: a new assignee or
  // reviewer is checked against the chain, and a new parent against
  // everyone holding this task or its subtasks. Someone a later write of the
  // same machine update replaces (LaterPeople) holds nothing; that write
  // checks the replacement against the chain.
  const heldAssignee = 'assignee_id' in patch ? w.assignee_id : issue.assignee_id
  const heldReviewer = 'reviewer_id' in patch ? w.reviewer_id : issue.reviewer_id
  const newAssignee = heldAssignee !== undefined && heldAssignee !== issue.assignee_id
  const newReviewer = heldReviewer !== undefined && heldReviewer !== issue.reviewer_id
  const newParent =
    'parent_id' in patch && nextParent !== undefined && nextParent !== issue.parent_id
  if (nextParent !== undefined && (newAssignee || newReviewer || newParent)) {
    const sees = chainSight(ctx, await ancestorsFrom(ctx, nextParent), bulk)
    if (newAssignee && !(await sees(heldAssignee))) throw rule(ASSIGNEE_SIGHT_RULE)
    if (newReviewer && !(await sees(heldReviewer))) throw rule(REVIEWER_SIGHT_RULE)
    if (newParent) {
      // `later` only speaks for a field this write leaves alone
      const replaced = (field: keyof LaterPeople): boolean =>
        !(field in patch) && replacedLater(issue, a.machine?.later, field)
      const holders = await holdersUnder(ctx, issue.id, {
        assignee_id: replaced('assignee_id') ? undefined : heldAssignee,
        reviewer_id: replaced('reviewer_id') ? undefined : heldReviewer,
        group: await isGroup(),
      })
      for (const holder of holders) {
        await assertRoom(ctx)
        // a switched-off person holds no new work, so their sight is not checked
        if (!(await byId(ctx, 'profiles', holder))?.active) continue
        if (!(await sees(holder))) throw rule(HOLDER_SIGHT_RULE)
      }
    }
  }
  if ('remaining_hours' in patch) {
    const next = cleanRemaining(patch.remaining_hours)
    const changed = (issue.remaining_hours ?? null) !== (next ?? null)
    if (changed && next !== undefined) await assertOwnRemaining(ctx, issue)
    w.remaining_hours = next
    // server-owned stamp (0072): stamped exactly when the value changes; a
    // client-sent stamp cannot stick because no arg carries one
    if (changed) w.remaining_set_at = next === undefined ? undefined : now
  }
  if ('title' in patch) w.title = cleanTitle(patch.title)
  if ('description' in patch) {
    w.description = cleanDescription(patch.description)
    // the images the save takes out, brings back or adds (model/descriptionImages.ts)
    if (w.description !== (issue.description ?? '')) {
      await settleDescriptionImages(ctx, {
        me,
        issue,
        description: w.description,
        now,
        provenance: a.machine?.provenance,
      })
    }
  }
  const entersReview = patch.status === 'review' && issue.status !== 'review'
  if ('status' in patch && patch.status !== undefined) {
    if (await isGroup()) {
      throw rule('status cannot be set on a task with subtasks, so update its subtasks instead')
    }
    w.status = patch.status
  }
  // a group's dates come from its leaves, so any date key is refused, null
  // and unchanged values included, and the stored pair stays dormant
  const datesInPatch = 'start_week' in patch || 'end_week' in patch
  if (datesInPatch && (await isGroup())) throw rule(GROUP_DATES_RULE)
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
    if (patch.paused && (await isGroup())) throw rule(GROUP_PAUSE_RULE)
    if (patch.paused && !isPausable(nextStatus)) throw rule(PAUSE_RULE)
    w.paused = patch.paused
  } else if (issue.paused && !isPausable(nextStatus)) w.paused = false
  const nextArchivedAt =
    toggle === 'archived' ? now : toggle === 'restored' ? undefined : issue.archived_at
  w.done_at = doneStampUpdate(issue, { status: nextStatus, archived_at: nextArchivedAt }, now)
  // the review hand-off: entering Review, or a different reviewer while there
  const nextReviewer = 'reviewer_id' in patch ? w.reviewer_id : issue.reviewer_id
  w.review_at = reviewStamp(issue, { status: nextStatus, reviewer_id: nextReviewer }, now)
  // the status stamp: the status changed in this project (moveIssueCore
  // clears it). Set only on a change, because ctx.db.patch unsets a key
  // whose value is undefined.
  if (nextStatus !== issue.status) w.status_at = now
  if (toggle !== undefined) w.archived_at = nextArchivedAt // undefined clears via patch
  w.updated_at = now
  // -- a leaf's plan lands as given once the resulting pair holds
  if (datesInPatch) {
    const start = 'start_week' in patch ? (patch.start_week ?? undefined) : issue.start_week
    const end = 'end_week' in patch ? (patch.end_week ?? undefined) : issue.end_week
    assertWeekPair(start, end)
    w.start_week = start
    w.end_week = end
  }
  // -- the row write: ONE patch, the folded archive toggle included, and
  //    the description row with it (model/descriptions.ts)
  await patchTask(ctx.db, issue, w)
  const after = (await ctx.db.get(issue._id)) as Doc<'issues'>
  await tallyRow(ctx, 'issues', issue, after)
  // -- cascade, then clear-on-attach
  if (toggle === 'restored') {
    // the restore cascade: the ancestor chain surfaces (suppressed echoes),
    // and the marks on the restored tasks' relation rows are cleared in the
    // background, as unarchiveIssueCore does
    const restored = await restoreAncestors(ctx, { row: after, actor: me, now })
    await scheduleMarkClears(ctx, [after, ...restored])
  } else if (toggle === 'archived') {
    // archive branch: descendants stamped, never notified (their only change
    // is the suppressed Archived line, archiveIssueCore's walk), and every
    // message about the subtree marked read in the background
    const descendants = await archiveSubtree(ctx, issue.id, now, me)
    await scheduleArchivedReads(ctx, { issues: [issue.id, ...descendants] })
  }
  // the attach makes the parent a group only when this task counts for it,
  // so a task in an archived project leaves a parent in an active one alone
  if (attachedTo !== undefined && (await subtaskOf(attachedTo, after, live))) {
    await clearParentRemaining(ctx, { parentId: attachedTo.id, actor: me, now })
  }
  // -- ONE fan-out for the row itself (diffs only the trigger's column list;
  //    the Archived/Restored line rides the same message as the field changes).
  //    `group` is known whenever the status, dates or reviewer changed; an assignee
  //    change alone subscribes the same people either way.
  await notifyIssueUpdate(ctx, {
    before: issue,
    after,
    actor: me,
    now,
    isGroup: group === true,
    preload: bulk?.preload,
  })
  // -- activity: ONE row, or none when the save changed nothing the history
  //    narrates (narratedChange). Machine grammar when the trusted override
  //    is present (verb archived/restored wins, else 'changed'; multi-field
  //    diff + provenance), else the browser verb/detail strings, ported
  //    verbatim
  if (!narratedChange(issue, after)) return after
  let verb: string
  let detail: string | undefined
  // the diff names no task (DIFF_FIELDS has no parent_id)
  let named: number[] = []
  if (a.machine?.appGrammar === true) {
    const browser = await browserVerbDetail(ctx, { before: issue, after, patch })
    verb = browser.verb
    detail = machineDetail(browser.detail, a.machine.provenance)
    named = browser.named
  } else if (a.machine !== undefined) {
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
    named = browser.named
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
    named_task_nums: named,
    field_prints: changedPrints(TASK_FIELDS, issue, after),
  }
  await logActivity(ctx, event)
  // a restore that left a full parent gets the row a detach writes
  if (toggle === 'restored' && !('parent_id' in patch) && issue.parent_id !== after.parent_id) {
    await logLeftParent(ctx, { me, before: issue, after, now, provenance: a.machine?.provenance })
  }
  return after
}

/* ------------------------------------------------------------- move core
 * issues_move_guard (0078:127-145) + the arrival guard (0106), in trigger
 * order: not-found → meta ("live", not "created" — a different sentence from
 * the insert guard) → cross-org → archived target → the subtask family rule
 * → destination eligibility for the assignee and the reviewer → the carried
 * subtasks → sight for the people on the subtasks. A group's reviewer is
 * dormant and hidden in the app, so it never refuses a move: one the
 * destination would refuse is cleared in the move's patch instead (adapt,
 * don't reject, as clearParentRemaining does). num is org-scoped and
 * immutable: the key survives the move; labels survive too (org vocabulary).
 * The activity row is keyed to the SOURCE project and records the
 * destination as its related project. issues.move and the machine moves
 * check Edit on BOTH ends before calling this, and the write gate here
 * checks them again before any guard, so these guards only ever describe a
 * destination the caller can write. A machine update that also sets the
 * assignee or reviewer (MachineMove.later) is checked with the people the
 * task ends up with. Attachment rows name no project, so none is written.
 *
 * A subtask stays in its parent's top-level project. A move within the
 * task's top-level project changes nothing else. A move to another one
 * carries every subtask outside the destination's top-level project along,
 * archived ones included, and a subtask must land in its parent's top-level
 * project or leave its parent in the same change, through the app's
 * `detachParent` or a machine update's later parent
 * (MachineMove.laterParent). The carried
 * subtasks are touched and send a task.updated event each. They get no
 * message or activity row of their own, because the task's one message and
 * row tell the move, as the archive cascade does. */

export const MOVE_SUBTASK_RULE =
  "a subtask stays in its parent task's project; to move it to another project, detach it from its parent in the same change"
export const MOVE_SUBTREE_EDIT_RULE =
  'moving this task would move a subtask in a project you cannot edit; an organization admin can move it'
export const MOVE_SUBTREE_HOLDER_RULE =
  'someone assigned to or reviewing a subtask of this task cannot edit that sub-project; give them Edit access there, or change who works on that subtask first'
/* A task moving to another top-level project may have at most
 * LIMITS.moveSubtree.max subtasks, archived ones included. The move reads
 * them all, including any already in the destination's top-level project,
 * and carries the rest. LIMITS.subtasks.max bounds only the active ones, so
 * this bounds what the move reads and writes: LIMITS.subtasks.max active
 * subtasks and as many archived. Each carried subtask is read twice, once by
 * the move and once by its write, and so is its description row, found and
 * then read again by its own write (model/descriptions.ts patchTask). So
 * about 60 subtasks with descriptions at TEXT_MAX of three-byte characters
 * fit in one request while issues.description holds the text too, and
 * about 50 active ones in a REST move, whose answer reads them again.
 * A larger family is refused with MOVE_TOO_LARGE. */

/* Per-call cache from a project id to its top-level project id, null for a
 * missing project. */
function topLevelCache(ctx: QueryCtx): (projectId: string) => Promise<string | null> {
  const seen = new Map<string, Promise<string | null>>()
  return (projectId) => {
    let top = seen.get(projectId)
    if (top === undefined) {
      top = byId(ctx, 'projects', projectId).then((p) => (p === null ? null : topLevelOf(p)))
      seen.set(projectId, top)
    }
    return top
  }
}

/* The subtasks of the task `rootId`, active or archived, at most
 * LIMITS.moveSubtree.max + 1 of them, so a caller can tell a task with more than
 * LIMITS.moveSubtree.max. A subtask has no subtasks of its own, so one by_parent
 * range holds them all. */
const subtasksOf = (ctx: QueryCtx, rootId: string): Promise<Doc<'issues'>[]> =>
  ctx.db
    .query('issues')
    .withIndex('by_parent', (q) => q.eq('parent_id', rootId))
    .take(LIMITS.moveSubtree.max + 1)

/** Whether moving `issue` to `target` would carry subtasks along, for the
 * app's Move window, whose view holds no archived subtasks. A move within
 * the task's top-level project carries none. Past LIMITS.moveSubtree.max, where
 * moveIssueCore refuses, it answers false, because such a move carries
 * nothing. */
export async function subtasksWouldMove(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  target: Doc<'projects'>,
): Promise<boolean> {
  const source = await byId(ctx, 'projects', issue.project_id)
  const dst = topLevelOf(target)
  if (source === null || topLevelOf(source) === dst) return false
  const topOf = topLevelCache(ctx)
  const below = await subtasksOf(ctx, issue.id)
  if (below.length > LIMITS.moveSubtree.max) return false
  for (const row of below) {
    if ((await topOf(row.project_id)) !== dst) return true
  }
  return false
}

/* The subtasks a move to `target` carries, which are the subtasks of
 * `root`, active or archived, whose project is outside the target's
 * top-level project. Before anything is written, each needs Edit on its
 * project, and an active one needs an assignee and a reviewer who can hold
 * it at the target. A subtask has no subtasks of its own, so its reviewer is
 * never a group's dormant one. Archived subtasks keep their people
 * unchecked, as an archived task's people are. `below` holds every subtask
 * (subtasksOf), and the walk refuses past LIMITS.moveSubtree.max of them. */
async function subtreeToCarry(
  ctx: QueryCtx,
  a: {
    below: readonly Doc<'issues'>[]
    target: Doc<'projects'>
    actor: Doc<'profiles'>
    topOf: (projectId: string) => Promise<string | null>
  },
): Promise<Doc<'issues'>[]> {
  const { below } = a
  if (below.length > LIMITS.moveSubtree.max) throw rule(LIMITS.moveSubtree.refusal)
  const dst = topLevelOf(a.target)
  const edits = editableBy(ctx, a.actor)
  const holds = new Map<string, Promise<boolean>>()
  const canHold = (profileId: string): Promise<boolean> => {
    let result = holds.get(profileId)
    if (result === undefined) {
      result = canHoldTaskIn(ctx, a.target, profileId)
      holds.set(profileId, result)
    }
    return result
  }
  const carried: Doc<'issues'>[] = []
  for (const c of below) {
    if ((await a.topOf(c.project_id)) === dst) continue
    const editable = await edits(c.project_id)
    if (editable === null) throw rule(SUBTASK_BEING_DELETED)
    if (!editable) throw rule(MOVE_SUBTREE_EDIT_RULE)
    if (c.archived_at === undefined) {
      for (const holder of [c.assignee_id, c.reviewer_id]) {
        if (holder !== undefined && !(await canHold(holder))) throw rule(MOVE_SUBTREE_HOLDER_RULE)
      }
    }
    carried.push(c)
  }
  return carried
}

/** The stamps a task writes as it moves to another sub-project. A time
 * from the source project may predate the reader's access there, so the
 * status stamp clears (ctx.db.patch unsets it), and a review hand-off
 * (review_at) or a Done time (done_at) the task carries restarts at the
 * move. A moved Done task therefore waits the full auto-archive threshold
 * again (jobs.ts). A task that lands as a group loses its hand-off with its
 * hours in the move's own patch (moveIssueCore). The remaining-hours measurement
 * (remaining_set_at) stays on purpose: it is the planning anchor
 * (lib/delay.ts, lib/workload.ts), so restarting it would move the task's
 * forecast and load with no change in the work. The accepted cost is that
 * the task JSON keeps showing when the hours were last set in the source
 * project, which can be the time it entered review there. created_at and
 * archived_at stay too: the archive time is the archive state, whose change
 * the history and inbox narrate. */
function movedStamps(task: Doc<'issues'>, now: string) {
  return {
    status_at: undefined,
    ...(task.review_at !== undefined ? { review_at: now } : {}),
    ...(task.done_at !== undefined ? { done_at: now } : {}),
  }
}

export async function moveIssueCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    issue: Doc<'issues'>
    project_id: string
    now: string
    /* the app's detach_parent, with which the task also leaves its parent */
    detachParent?: boolean
    machine?: MachineMove
  },
): Promise<Doc<'issues'>> {
  const { me, issue, project_id, now } = a
  await assertCanEdit(ctx, me, issue.project_id)
  if (issue.project_id === project_id) return issue // no-op, as in SQL
  await assertCanEdit(ctx, me, project_id)
  const target = await byId(ctx, 'projects', project_id)
  if (target === null) throw notFound(`project ${project_id} not found`)
  if (target.type !== 'project') {
    throw rule(
      'tasks can only live in sub-projects, not meta-projects; move it to one of its sub-projects',
    )
  }
  if (target.org_id !== issue.org_id) throw rule('tasks cannot move between organizations')
  assertProjectArrival(target)
  const topOf = topLevelCache(ctx)
  const dst = topLevelOf(target)
  const source = await byId(ctx, 'projects', issue.project_id)
  const crosses = source !== null && topLevelOf(source) !== dst
  // A subtask moving to another top-level project must land in its parent's
  // or leave the parent in the same change. A later parent in the
  // destination's top-level project is checked in full by the write that
  // sets it. A parent the mover cannot see counts as being in the task's own
  // top-level project, as the app counts it, so the answer tells nothing
  // about where it is.
  const detach = a.detachParent === true && issue.parent_id !== undefined
  if (crosses && issue.parent_id !== undefined && !detach) {
    const seenTop = async (task: Doc<'issues'>): Promise<string | null> => {
      const project = await byId(ctx, 'projects', task.project_id)
      if (project === null) return null
      return (await canSeeProject(ctx, me, project)) ? topLevelOf(project) : topLevelOf(source)
    }
    const parent = await byId(ctx, 'issues', issue.parent_id)
    if (parent !== null && (await seenTop(parent)) !== dst) {
      const laterParent = a.machine?.laterParent
      const next = laterParent ? await byId(ctx, 'issues', laterParent) : null
      const leaves = laterParent === null || (next !== null && (await seenTop(next)) === dst)
      if (!leaves) throw rule(MOVE_SUBTASK_RULE)
    }
  }
  // The assignee and a leaf's reviewer must be eligible in the destination;
  // a group's dormant reviewer who is not is cleared instead. Someone a later
  // write of the same machine update replaces is left to that write, which
  // checks the replacement in the destination. Immutable reporter and
  // creator attribution survive moves and changes to those users' access.
  const later = a.machine?.later
  if (issue.assignee_id !== undefined && !replacedLater(issue, later, 'assignee_id')) {
    await assertAssigneeRule(ctx, target, issue.assignee_id)
  }
  const w: TaskFields = {
    project_id,
    updated_at: now,
    ...movedStamps(issue, now),
  }
  if (detach) w.parent_id = undefined // ctx.db.patch unsets it
  const live = projectLiveness(ctx)
  // Which projects are live once the move lands, for the group tests of the
  // task and its subtasks. A subtask the move carries lands in the
  // destination, which is active, and every other task stays where it is.
  const liveAfter: Liveness = async (projectId) =>
    (crosses && (await topOf(projectId)) !== dst) || (await live(projectId))
  const holdsOwn = issue.remaining_hours !== undefined || issue.review_at !== undefined
  // only a reviewer can change hands in a move, and only a group must lose
  // its own hours, so the group flag is read only for those
  let isGroup = false
  if (issue.reviewer_id !== undefined || (holdsOwn && issue.archived_at === undefined)) {
    isGroup = await hasSubtasks(ctx, { ...issue, project_id }, liveAfter)
  }
  // a group holds no hours of its own, so hours the task held as a leaf go,
  // as on an attach (clearParentRemaining). That happens when a subtask the
  // move carries leaves an archived project.
  if (isGroup && holdsOwn && issue.archived_at === undefined) {
    w.remaining_hours = undefined
    w.remaining_set_at = undefined
    w.review_at = undefined
  }
  if (issue.reviewer_id !== undefined) {
    if (!isGroup) {
      if (!replacedLater(issue, later, 'reviewer_id')) {
        await assertAssigneeRule(ctx, target, issue.reviewer_id, 'reviewer')
      }
    } else if (!(await canHoldTaskIn(ctx, target, issue.reviewer_id))) {
      w.reviewer_id = undefined // ctx.db.patch unsets it
    }
  }
  // to another top-level project, the subtasks outside it come along. They
  // are read once, for the carry and the holders below: a subtask can be
  // about 60 KB within TEXT_MAX, so LIMITS.moveSubtree.max of them take most of
  // what one transaction may read
  const below = crosses ? await subtasksOf(ctx, issue.id) : undefined
  const carried =
    below !== undefined ? await subtreeToCarry(ctx, { below, target, actor: me, topOf }) : []
  // whoever works on a subtask must still see this task once it moves, so
  // every active assignee or reviewer below it needs access to the
  // destination (the sentence names no one: some subtasks may be hidden)
  const holders = await holdersUnder(
    ctx,
    issue.id,
    { group: true },
    { kids: below, refusal: MOVE_TOO_LARGE },
  )
  for (const holder of holders) {
    await assertRoom(ctx, MOVE_TOO_LARGE)
    const profile = await byId(ctx, 'profiles', holder)
    if (!profile?.active) continue
    if (!(await canSeeProject(ctx, profile, target))) throw rule(MOVE_HOLDER_RULE)
  }
  // A caller that answers with the task's full read, which reads its
  // active subtasks again (MachineMove.answerReadsSubtasks), gets a move
  // that leaves room for that read. An archived task's read walks under a
  // ceiling instead.
  const answer =
    a.machine?.answerReadsSubtasks === true &&
    issue.archived_at === undefined &&
    below !== undefined
      ? below
          .filter((c) => c.archived_at === undefined)
          .reduce((sum, c) => sum + getDocumentSize(c), 0)
      : 0
  const before = { ...issue }
  // the task and its description row (model/descriptions.ts); a move that
  // read the subtree to carry it asks the room first, and any other patches
  // one task, as a single task's update does
  if (below !== undefined) await assertStepRoom(ctx, patchCost(issue), MOVE_TOO_LARGE, answer)
  await patchTask(ctx.db, issue, w)
  const after = (await ctx.db.get(issue._id)) as Doc<'issues'>
  // the stored-byte totals follow the task and every subtask it carries, at
  // one totals row each, however many files they hold
  // (model/storageTotals.ts), before the room checks of the carry below
  await moveTaskFiles(ctx, [issue, ...carried], target)
  for (const row of carried) {
    await assertStepRoom(ctx, patchCost(row), MOVE_TOO_LARGE, answer)
    // a carried subtask's stamps change as the task's above; the row as it
    // lands is built from the patch rather than read again, which would
    // read every carried subtask a second time
    const moved = { project_id, updated_at: now, ...movedStamps(row, now) }
    await patchTask(ctx.db, row, moved)
    const landed: Doc<'issues'> = { ...row, ...moved }
    if (landed.status_at === undefined) delete landed.status_at
    await emitTaskEvent(ctx, { name: 'task.updated', issue: landed, before: row, actor: me, now })
  }
  // a group stays with its assignee: clearing its reviewer hands nothing over
  await notifyIssueUpdate(ctx, { before, after, actor: me, now, isGroup })
  // the inbox items of the task and its carried subtasks follow them
  // (model/inboxItems.ts), after the notices above, whose arrivals give
  // their own items the new project already
  await rekeyItems(ctx, [issue.id, ...carried.map((row) => row.id)], project_id)
  // A task that leaves an archived project counts for its parent again
  // (countsAsSubtask), so a parent it makes a group loses its own hours, as
  // on an attach. That is the task's parent, unless the task leaves it or a
  // later write of this update gives it another, and each carried subtask's.
  // A later parent equal to the current one changes nothing, so that write
  // is skipped (lib/core.ts applyTaskUpdate) and this one clears the hours.
  const regrouped = new Set(carried.map((row) => row.parent_id))
  const laterParent = a.machine?.laterParent
  if (!detach && (laterParent === undefined || laterParent === issue.parent_id)) {
    regrouped.add(issue.parent_id)
  }
  regrouped.delete(issue.id) // its own hours went with the move's patch
  for (const parentId of regrouped) {
    const parent = parentId === undefined ? null : await byId(ctx, 'issues', parentId)
    if (parent === null || parent.archived_at !== undefined) continue
    if (parent.remaining_hours === undefined && parent.review_at === undefined) continue
    if (await hasSubtasks(ctx, parent, live)) {
      await clearParentRemaining(ctx, { parentId: parent.id, actor: me, now })
    }
  }
  // lib/activityVisibility.ts isUnrecordedProjectMove recognizes older rows by
  // this wording
  const moved = `to the ${target.name} sub-project${source ? ` (from ${source.name})` : ''}${
    carried.length > 0 ? ' with its subtasks' : ''
  }`
  const event = {
    org_id: issue.org_id,
    actor_id: me.id,
    verb: 'moved',
    target_type: 'issue' as const,
    target_id: issue.id,
    label: after.title,
    detail: a.machine === undefined ? moved : machineDetail(moved, a.machine.provenance),
    project_id: issue.project_id, // the SOURCE project (old planner.ts:2063-2066)
    related_project_id: target.id, // the detail names it, so readers need it too
    ts: now,
    named_task_nums: [],
    // every field the move changed, the parent of a detach included
    field_prints: changedPrints(TASK_FIELDS, issue, after),
  }
  await logActivity(ctx, event)
  // leaving the parent gets the row a detach writes, as a machine update's
  // later parent step does
  if (detach) {
    await logLeftParent(ctx, { me, before, after, now, provenance: a.machine?.provenance })
  }
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

/* Both name who can finish the change: an organization admin edits every
 * project, so neither refusal is a dead end. */
export const ARCHIVE_CASCADE_RULE =
  'archiving this task would change a subtask in a project you cannot edit; an organization admin can archive it'
export const RESTORE_CASCADE_RULE =
  'restoring this task would change a parent task in a project you cannot edit; an organization admin can restore it'

/* The refusals for a cascade that meets a subtask or parent whose project
 * Deleted items is moving (model/deletedItems.ts). The task still names the
 * project until the move reaches it, and changing it could bring it back
 * into a live project, so the change is refused until the move is done. No
 * one can edit a project that is gone, an admin included. */
export const SUBTASK_BEING_DELETED =
  'a subtask of this task is being moved to Deleted items; try again when that finishes'
export const PARENT_BEING_DELETED =
  'a parent of this task is being moved to Deleted items; try again when that finishes'

/* Per-call cache of the actor's Edit access, null for a project whose row
 * is gone while Deleted items moves it. A cascade changes only tasks in
 * projects the actor could edit directly; otherwise the whole write is
 * refused and rolls back. */
function editableBy(
  ctx: QueryCtx,
  actor: Doc<'profiles'>,
): (projectId: string) => Promise<boolean | null> {
  const seen = new Map<string, Promise<boolean | null>>()
  return (projectId) => {
    let result = seen.get(projectId)
    if (result === undefined) {
      result = byId(ctx, 'projects', projectId).then((p) =>
        p === null ? null : hasProjectLevel(ctx, actor, p.id, 'user'),
      )
      seen.set(projectId, result)
    }
    return result
  }
}

/* The subtask walk, shared with updateIssueCore's folded machine toggle:
 * stamps active subtasks (touched, NEVER notified). An active subtask in a
 * project the actor cannot edit refuses the archive, because an active task
 * may never sit under an archived parent. A subtask has no subtasks of its
 * own, so the walk reads one range of at most LIMITS.subtasks.max active subtasks,
 * under SUBTREE_ROOM. Returns the ids it stamped. */
async function archiveSubtree(
  ctx: MutationCtx,
  rootId: string,
  now: string,
  actor: Doc<'profiles'>,
): Promise<string[]> {
  const edits = editableBy(ctx, actor)
  const room = roomCheck(ctx)
  await room()
  // read in full before the first patch, which moves a row out of the range
  const kids = await activeSubtasks(ctx, rootId).take(LIMITS.subtasks.max)
  for (const c of kids) {
    await room(subtaskBytes(c))
    const editable = await edits(c.project_id)
    if (editable === null) throw rule(SUBTASK_BEING_DELETED)
    if (!editable) throw rule(ARCHIVE_CASCADE_RULE)
  }
  for (const c of kids) {
    await assertStepRoom(ctx, patchCost(c), SUBTREE_TOO_LARGE)
    await patchTask(ctx.db, c, { archived_at: now, updated_at: now })
    // built from the patch rather than read again, which would read every
    // subtask a second time
    const after: Doc<'issues'> = { ...c, archived_at: now, updated_at: now }
    await emitTaskEvent(ctx, { name: 'task.updated', issue: after, before: c, actor, now })
  }
  await tallyRows(
    ctx,
    'issues',
    kids.map((c) => [c, { ...c, archived_at: now }] as const),
  )
  return kids.map((c) => c.id)
}

/* The 'archived' row names no subtask count, because subtasks can sit in
 * projects some readers of the root cannot access. The Archived notice is
 * stored read, and the messages already stored about the root and the
 * subtree are marked read in the background (model/messages.ts
 * scheduleArchivedReads).
 * keepSubtasks (the app's archive window only; REST and MCP archive the
 * subtree): every active direct child is detached first, as a delete
 * detaches it (detachChild), so the cascade finds only archived children,
 * which stay attached, and the task is archived alone. */
export async function archiveIssueCore(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; issue: Doc<'issues'>; now: string; keepSubtasks?: boolean },
): Promise<Doc<'issues'>> {
  const { me, issue, now } = a
  await assertCanEdit(ctx, me, issue.project_id)
  if (issue.archived_at !== undefined) return issue
  if (a.keepSubtasks === true) {
    // read in full before the first detach, which moves a row out of the range
    const kids = await activeSubtasks(ctx, issue.id).take(LIMITS.subtasks.max)
    // the detaches change only tasks, so one preload serves them all
    const preload = newNotifyPreload()
    for (const kid of kids) {
      await assertRoom(ctx)
      await detachChild(ctx, kid, me, now, preload)
    }
  }
  const before = { ...issue }
  await patchTask(ctx.db, issue, { archived_at: now, updated_at: now })
  await tallyRow(ctx, 'issues', issue, { ...issue, archived_at: now })
  const descendants = await archiveSubtree(ctx, issue.id, now, me)
  const after = (await ctx.db.get(issue._id)) as Doc<'issues'>
  await notifyIssueUpdate(ctx, { before, after, actor: me, now }) // the root's own write narrates
  await scheduleArchivedReads(ctx, { issues: [issue.id, ...descendants] })
  const event = {
    org_id: issue.org_id,
    actor_id: me.id,
    verb: 'archived',
    target_type: 'issue' as const,
    target_id: issue.id,
    label: issue.title,
    project_id: issue.project_id,
    ts: now,
    named_task_nums: [],
  }
  await logActivity(ctx, event)
  return after
}

/* -------------------------------------------------------- unarchive core
 * Restore branch (0071:66-75): the whole ancestor chain surfaces, each
 * restored parent also loses its own hours (it has sub-issues again — 0066,
 * like attach, when the task below counts for it, lib/liveTasks.ts
 * countsAsSubtask) with the stamp pairing kept and any review hand-off, and a
 * restored still-done row's done_at restarts (0071 fix 1). No ancestor's
 * dates change, because a restored group's span is calculated from its
 * leaves.
 * Cascade echoes mask ONLY the Archived/Restored line out of the diff: a
 * cleared remaining still narrates to that ancestor's subscribers. The walk
 * stops at an active ancestor — one that merely held hours loses them but
 * the chain above it never was archived. */
/* The ancestor walk, shared with updateIssueCore's folded machine toggle:
 * restores/clears the chain above `row` (each echo notified with the Restored
 * line suppressed) and returns the ancestors it restored from the archive.
 * The row itself is the caller's to notify. An ancestor it would change in a
 * project the actor cannot edit refuses the restore. */
async function restoreAncestors(
  ctx: MutationCtx,
  a: { row: Doc<'issues'>; actor: Doc<'profiles'>; now: string },
): Promise<Doc<'issues'>[]> {
  const { actor, now } = a
  const edits = editableBy(ctx, actor)
  const live = projectLiveness(ctx)
  const restored: Doc<'issues'>[] = []
  let cur: Doc<'issues'> = a.row
  const seen = new Set<string>([a.row.id])
  // one level of subtasks: the chain is the parent alone, and the seen set
  // stops a corrupt cycle
  while (cur.parent_id !== undefined && !seen.has(cur.parent_id)) {
    const parent = await byId(ctx, 'issues', cur.parent_id)
    if (parent === null) break
    seen.add(parent.id)
    const wasArchived = parent.archived_at !== undefined
    // own hours, or a review hand-off from its leaf days: a group has
    // neither. They go only when the restored task makes the parent a group
    // once both are active (countsAsSubtask), so a task in an archived
    // project leaves the hours of a parent in an active one alone.
    const hadOwn = parent.remaining_hours !== undefined || parent.review_at !== undefined
    const clears = hadOwn && (await subtaskOf({ ...parent, archived_at: undefined }, cur, live))
    if (!wasArchived && !clears) break
    const editable = await edits(parent.project_id)
    if (editable === null) throw rule(PARENT_BEING_DELETED)
    if (!editable) throw rule(RESTORE_CASCADE_RULE)
    const pBefore = { ...parent }
    const ownHours = clears
      ? { remaining_hours: undefined, remaining_set_at: undefined, review_at: undefined }
      : {}
    await patchTask(ctx.db, parent, {
      archived_at: undefined,
      ...ownHours,
      done_at: doneStampUpdate(parent, { status: parent.status, archived_at: undefined }, now),
      updated_at: now,
    })
    const pAfter = (await ctx.db.get(parent._id)) as Doc<'issues'>
    await tallyRow(ctx, 'issues', parent, pAfter)
    if (wasArchived) restored.push(pAfter)
    // cascade echo: only the Restored line is suppressed — a cleared
    // remaining still narrates to this ancestor's subscribers
    await notifyIssueUpdate(ctx, {
      before: pBefore,
      after: pAfter,
      actor,
      now,
      suppressNotify: true,
    })
    if (!wasArchived) break
    cur = pAfter
  }
  return restored
}

/** The refusal of a machine restore that names, as the task's parent to
 * keep, a parent whose delete still has to detach the task
 * (restoreLeavesParent). */
export const PARENT_DELETED_SINCE =
  "this task's parent was deleted after this task was archived, so the task comes back as a top-level task; restore it without naming that parent"

/** Why restoring the archived task `issue` from the archive brings it back
 * as a top-level task, as the refusal a machine restore that names the
 * parent gets, or undefined when it keeps its parent. It leaves a parent
 * that is active and already has LIMITS.subtasks.max active subtasks. A
 * restore from Deleted items clears such a parent the same way
 * (model/deletedItems.ts keptParent), so no restore refuses over it or
 * passes the cap. An archived parent holds no active subtask, because an
 * active task never sits under an archived one, so the restore brings it
 * back too, as before. It also leaves a parent whose delete
 * after the task was archived left it to the steps that detach archived
 * subtasks (model/deletedItems.ts detachArchivedChildren), whether that
 * parent is gone, as one in Deleted items is, or came back from Deleted
 * items before the steps reached the task. So no restored task keeps a
 * parent that is not there, and no restore undoes what a delete began. A
 * parent the same machine update just gave the task (`chosen`) was not its
 * parent at that delete, so only a full one is left. */
async function restoreLeavesParent(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  chosen = false,
): Promise<string | undefined> {
  if (issue.parent_id === undefined) return undefined
  const parent = await byId(ctx, 'issues', issue.parent_id)
  if (parent === null) return PARENT_DELETED_SINCE
  if (issue.archived_at !== undefined && !chosen) {
    const detach = await ctx.db
      .query('archived_detaches')
      .withIndex('by_parent', (q) =>
        q.eq('parent_id', parent.id).gte('deleted_at', issue.archived_at as string),
      )
      .first()
    if (detach !== null) return PARENT_DELETED_SINCE
  }
  if (parent.archived_at !== undefined) return undefined
  return (await subtaskCount(ctx, parent.id)) >= LIMITS.subtasks.max
    ? LIMITS.subtasks.refusal
    : undefined
}

/* The activity row of a task that left its parent `before.parent_id` in
 * another change, such as a move or a restore, as a detach writes it,
 * signed with `provenance` for a machine caller. */
async function logLeftParent(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    before: Doc<'issues'>
    after: Doc<'issues'>
    now: string
    provenance?: string
  },
): Promise<void> {
  const { me, before, after } = a
  const detached = await browserVerbDetail(ctx, { before, after, patch: { parent_id: null } })
  await logActivity(ctx, {
    org_id: after.org_id,
    actor_id: me.id,
    verb: detached.verb,
    target_type: 'issue',
    target_id: after.id,
    label: after.title,
    detail:
      a.provenance === undefined ? detached.detail : machineDetail(detached.detail, a.provenance),
    project_id: after.project_id,
    ts: a.now,
    named_task_nums: detached.named,
  })
}

/** Restores the archived task `issue` and the archived parent above it
 * (restoreAncestors). A task whose active parent is full, or whose parent's
 * delete still has to detach it, comes back as a top-level task
 * (restoreLeavesParent), with a detach's activity row, and its followers
 * read that it left its parent. Answers the restored row and, when it left
 * its parent, why: LIMITS.subtasks.refusal or PARENT_DELETED_SINCE. */
export async function unarchiveIssueCore(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; issue: Doc<'issues'>; now: string },
): Promise<{ after: Doc<'issues'>; left?: string }> {
  const { me, issue, now } = a
  await assertCanEdit(ctx, me, issue.project_id)
  if (issue.archived_at === undefined) return { after: issue }
  const before = { ...issue }
  const left = await restoreLeavesParent(ctx, issue)
  const leaves = left !== undefined
  await patchTask(ctx.db, issue, {
    archived_at: undefined,
    ...(leaves ? { parent_id: undefined } : {}),
    done_at: doneStampUpdate(issue, { status: issue.status, archived_at: undefined }, now),
    updated_at: now,
  })
  const rootAfter = (await ctx.db.get(issue._id)) as Doc<'issues'>
  await tallyRow(ctx, 'issues', issue, rootAfter)
  const restored = await restoreAncestors(ctx, { row: rootAfter, actor: me, now })
  // the relation rows' marks are cleared in the background; the label
  // search reads these tasks through their own indexes until then
  await scheduleMarkClears(ctx, [rootAfter, ...restored])
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
    named_task_nums: [],
  }
  await logActivity(ctx, event)
  if (leaves) await logLeftParent(ctx, { me, before, after: rootAfter, now })
  return { after: rootAfter, left }
}

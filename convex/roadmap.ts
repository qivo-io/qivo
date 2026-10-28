/* A roadmap visit is an owner-scoped undo journal. Clients supply commands,
 * never restoration values. Each mutation is one serializable undo step that
 * journals only the tasks its operations name. A group's dates are
 * calculated from its subtasks, so no write changes another task's dates.
 * A save that would leave two milestones of one project in one week is
 * refused whole with the weekly rule's `rule` refusal, and the history stays
 * (model/milestones.ts assertWeekFree). An undo that would is an edit made
 * elsewhere, refused as a conflict that ends the history. History expires
 * after 24 hours. */
import { makeFunctionReference, type WithoutSystemFields } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, type MutationCtx } from './_generated/server'
import { canSeeProject, hasProjectLevel } from './lib/access'
import { assertOrgWritable } from './lib/billingAccess'
import { assertNewRowId, byId, insertUnique, usedMoreThan } from './lib/db'
import { authedMutation, badRequest, conflict, forbidden, notFound, rule } from './lib/functions'
import { LIMITS } from './lib/limits'
import { logActivity } from './model/activity'
import { changedPrints, DELETES } from './model/expected'
import {
  assertOwnRemaining,
  assertRemainingShape,
  assertTaskExpected,
  assertWeekPair,
  type BulkUpdate,
  cleanRemaining,
  GROUP_DATES_RULE,
  hasSubtasks,
  TASK_FIELDS,
  updateIssueCore,
} from './model/issues'
import { newNotifyPreload, notifyIssueUpdate } from './model/messages'
import {
  assertMilestoneExpected,
  changeableMilestone,
  cleanMilestoneName,
  cleanMilestoneWeek,
  milestoneTarget,
  vMilestoneExpected,
  weekHolder,
  weekTaken,
} from './model/milestones'
import { weekLabel, weekPhrase } from './model/orgs'

type Context = MutationCtx & { authUserId: string; myProfiles: Map<string, Doc<'profiles'>> }
const TTL = 24 * 60 * 60 * 1000
const LIMIT = 1000
const taskFields = ['start_week', 'end_week', 'remaining_hours', 'remaining_set_at'] as const
type TaskField = (typeof taskFields)[number]
type TaskValues = Pick<Doc<'issues'>, TaskField>
type TaskChange = {
  kind: 'task'
  id: string
  guard: string
  fields: TaskField[]
  before: TaskValues
  after: TaskValues
}
type Milestone = WithoutSystemFields<Doc<'milestones'>>
type MilestoneChange = { kind: 'milestone'; id: string; before?: Milestone; after?: Milestone }
type Change = TaskChange | MilestoneChange

const stale = () =>
  conflict(
    'Some roadmap changes were edited elsewhere. Leave and reopen the roadmap to start a new undo history.',
    'roadmap_changed',
  )
const expired = () =>
  conflict(
    'This roadmap undo history has expired. Leave and reopen the roadmap to start again.',
    'roadmap_expired',
  )
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const taskValues = (row: Doc<'issues'>): TaskValues => ({
  start_week: row.start_week,
  end_week: row.end_week,
  remaining_hours: row.remaining_hours,
  remaining_set_at: row.remaining_set_at,
})
const milestoneValues = ({ _id, _creationTime, ...row }: Doc<'milestones'>): Milestone => row

async function checkWriter(ctx: Context, projectId: string) {
  const project = await byId(ctx, 'projects', projectId)
  const me = project && ctx.myProfiles.get(project.org_id)
  if (!project || !me || !(await canSeeProject(ctx, me, project)))
    throw notFound('project not found')
  if (!(await hasProjectLevel(ctx, me, projectId, 'user')))
    throw forbidden('no write access to this project')
  await assertOrgWritable(ctx, project.org_id)
  return { project, me }
}

/* Each mutation's passed write checks by project id. */
const writers = new WeakMap<Context, Map<string, ReturnType<typeof checkWriter>>>()

/* The project and the caller's seat in it, once the caller may write there.
 * A roadmap mutation changes only tasks, milestones and activity, never a
 * project, profile, grant, team or the organization's plan, so each project
 * is checked once per mutation however many operations name it. */
function writer(ctx: Context, projectId: string): ReturnType<typeof checkWriter> {
  let known = writers.get(ctx)
  if (known === undefined) {
    known = new Map()
    writers.set(ctx, known)
  }
  let result = known.get(projectId)
  if (result === undefined) {
    result = checkWriter(ctx, projectId)
    known.set(projectId, result)
  }
  return result
}

/** The share of each of Convex's limits for one transaction that a roadmap
 * save or undo may have used before it changes, journals or notifies about
 * another task. The tasks' followers hear from background steps
 * (model/messages.ts NotifyPreload.deferFollowers), but each task write
 * still checks the organization's webhook subscriptions, so no count of
 * operations bounds a save (LIMIT counts them). The rest of each limit is
 * room for one task's own reads and writes and the journal entry. */
export const ROADMAP_ROOM = 0.95

/** The refusals of a save or an undo too large for one transaction. The app
 * quotes them in its toasts, so they carry no closing period. */
export const ROADMAP_CHANGE_TOO_LARGE =
  'this roadmap change is too large to save at once; change fewer tasks at a time'
export const ROADMAP_UNDO_TOO_LARGE =
  'these roadmap changes are too large to undo at once; undo them one step at a time'
export const ROADMAP_STEP_TOO_LARGE = 'this roadmap change is too large to undo at once'

/* What one roadmap mutation shares across its task writes: one BulkUpdate
 * per organization, built at its first task there (model/issues.ts
 * BulkUpdate), and the room check that refuses with `tooLarge`. A roadmap
 * mutation changes only tasks, milestones and activity, so the preload stays
 * valid for the whole mutation (model/messages.ts NotifyPreload). Its guard
 * runs the room check before each webhook subscription a task write checks
 * and each mention it notifies. Followers hear from background steps
 * moments later (NotifyPreload.deferFollowers). */
type Batch = { bulkOf: (orgId: string) => Promise<BulkUpdate>; room: () => Promise<void> }

function batchOf(ctx: Context, tooLarge: string): Batch {
  const room = async () => {
    if (await usedMoreThan(ctx, ROADMAP_ROOM)) throw rule(tooLarge)
  }
  const bulks = new Map<string, Promise<BulkUpdate>>()
  const bulkOf = (orgId: string) => {
    let bulk = bulks.get(orgId)
    if (bulk === undefined) {
      bulk = Promise.resolve({
        preload: { ...newNotifyPreload(), guard: room, deferFollowers: true },
        checked: new Set<string>(),
      })
      bulks.set(orgId, bulk)
    }
    return bulk
  }
  return { bulkOf, room }
}

/* The caller's seat in the organization that holds `projectId`, if any.
 * The shared milestone rules (model/milestones.ts) then decide for it. */
async function seatFor(ctx: Context, projectId: string | undefined) {
  const project = projectId === undefined ? null : await byId(ctx, 'projects', projectId)
  return project ? ctx.myProfiles.get(project.org_id) : undefined
}

/* What an undo of a roadmap change to `row` checks is unchanged: the task's
 * place and archive state and its active subtasks, which decide whether it
 * is a group. Archived subtasks have no bound (LIMITS.subtasks counts only
 * active ones), so they are left out; one range of at most
 * LIMITS.subtasks.max active ones is read. */
async function taskGuard(ctx: MutationCtx, row: Doc<'issues'>): Promise<string> {
  const children = await ctx.db
    .query('issues')
    .withIndex('by_parent_archived', (q) => q.eq('parent_id', row.id).eq('archived_at', undefined))
    .take(LIMITS.subtasks.max)
  return JSON.stringify({
    row: row._id,
    org: row.org_id,
    project: row.project_id,
    parent: row.parent_id,
    archived: row.archived_at,
    children: children.map((c) => c._id).sort((a, b) => String(a).localeCompare(String(b))),
  })
}

/* The refusal of an undo that would bring a milestone back into a week that
 * `holder`, another milestone of its project, took since. It is an edit made
 * elsewhere, which stale() refuses too. Freeing the week on the Roadmap would
 * be one more step, which the next undo takes back, so the history ends. */
const weekTakenSince = (holder: Doc<'milestones'>, org: Doc<'organizations'>) =>
  conflict(
    `the milestone “${holder.name}” has taken ${weekPhrase(holder.week, org)} since that change, and a project can have at most 1 milestone a week. Leave and reopen the roadmap to start a new undo history.`,
    'roadmap_changed',
  )

/* Refuses the mutation when one of the milestones `ids`, as it stands now,
 * shares its week with another milestone of its project (model/milestones.ts
 * weekHolder), a save with the weekly rule's refusal and an undo with
 * weekTakenSince. Each runs it once every operation has run, so one that
 * swaps the weeks of two milestones passes. */
async function assertWeeksFree(ctx: Context, ids: Set<string>, batch: Batch, undo: boolean) {
  for (const id of ids) {
    await batch.room()
    const row = await byId(ctx, 'milestones', id)
    if (!row) continue
    const { project } = await writer(ctx, row.project_id)
    const org = await byId(ctx, 'organizations', project.org_id)
    if (!org) throw notFound('organization not found')
    const holder = await weekHolder(ctx, {
      org,
      projectId: row.project_id,
      day: row.week,
      except: row._id,
    })
    if (holder) throw undo ? weekTakenSince(holder, org) : weekTaken(holder, org)
  }
}

/* Undo of a task needs current write access on that task's own project, the
 * same access the original operation needed. */
async function taskWriter(ctx: Context, row: Doc<'issues'>) {
  const { me } = await writer(ctx, row.project_id)
  if (me.org_id !== row.org_id) throw stale()
  return me
}

async function history(ctx: Context, session: string) {
  if (!session || session.length > 200) throw badRequest('invalid roadmap session')
  const rows = await ctx.db
    .query('roadmap_history')
    .withIndex('by_owner_session', (q) =>
      q.eq('auth_user_id', ctx.authUserId).eq('session_key', session),
    )
    .collect()
  if (rows.some((row) => row.expires_at <= Date.now())) throw expired()
  return rows.sort((a, b) => a.position - b.position)
}

const expireRef = makeFunctionReference<
  'mutation',
  { auth_user_id: string; session_id: string; expires_at: number },
  null
>('roadmap:expire')
export const expire = internalMutation({
  args: { auth_user_id: v.string(), session_id: v.string(), expires_at: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('roadmap_history')
      .withIndex('by_owner_session', (q) =>
        q.eq('auth_user_id', args.auth_user_id).eq('session_key', args.session_id),
      )
      .collect()
    for (const row of rows)
      if (row.expires_at <= args.expires_at && row.expires_at <= Date.now())
        await ctx.db.delete(row._id)
    return null
  },
})

const planValues = v.object({
  start_week: v.optional(v.union(v.string(), v.null())),
  end_week: v.optional(v.union(v.string(), v.null())),
  remaining_hours: v.optional(v.union(v.number(), v.null())),
})

/* One change of a batch. A task or milestone operation may carry
 * `expected`, the values its sender read (model/expected.ts); one that
 * conflicts refuses the whole batch. */
const operation = v.union(
  v.object({
    kind: v.literal('task'),
    id: v.string(),
    patch: planValues,
    expected: v.optional(planValues),
  }),
  v.object({
    kind: v.literal('milestone_create'),
    id: v.string(),
    project_id: v.string(),
    name: v.string(),
    week: v.string(),
  }),
  v.object({
    kind: v.literal('milestone_update'),
    id: v.string(),
    patch: v.object({ name: v.optional(v.string()), week: v.optional(v.string()) }),
    expected: v.optional(vMilestoneExpected),
  }),
  v.object({
    kind: v.literal('milestone_remove'),
    id: v.string(),
    expected: v.optional(vMilestoneExpected),
  }),
)

async function logMilestone(
  ctx: Context,
  before: Milestone | undefined,
  after: Milestone | undefined,
  now: string,
) {
  const subject = after ?? before
  if (!subject) return
  const { project, me } = await writer(ctx, subject.project_id)
  const org = await byId(ctx, 'organizations', project.org_id)
  if (!org) throw notFound('organization not found')
  const moved = before && after && before.week !== after.week
  const renamed = before && after && before.name !== after.name
  await logActivity(ctx, {
    org_id: project.org_id,
    actor_id: me.id,
    target_type: 'milestone',
    target_id: subject.id,
    project_id: subject.project_id,
    label: subject.name,
    ts: now,
    verb: !before
      ? 'added milestone'
      : !after
        ? 'deleted milestone'
        : moved
          ? 'moved milestone'
          : renamed
            ? 'renamed milestone'
            : 'updated milestone',
    detail: !before
      ? `at ${weekLabel(subject.week, org)}`
      : moved && after
        ? `from ${weekLabel(before.week, org)} to ${weekLabel(after.week, org)}${renamed ? ` (renamed from “${before.name}”)` : ''}`
        : renamed
          ? `from “${before.name}”`
          : undefined,
  })
}

export const change = authedMutation({
  args: { session_id: v.string(), operations: v.array(operation) },
  handler: async (ctx, { session_id, operations }): Promise<{ count: number }> => {
    const entries = await history(ctx, session_id)
    if (operations.length > LIMIT || entries.length >= LIMIT)
      throw rule(
        'This roadmap visit is too large. Leave and reopen the roadmap before making more changes.',
      )
    const beforeTasks = new Map<string, Doc<'issues'>>()
    const beforeMilestones = new Map<string, Milestone | undefined>()
    // the milestones this save gives a week, checked once all have run
    const dated = new Set<string>()
    const now = new Date().toISOString()
    const batch = batchOf(ctx, ROADMAP_CHANGE_TOO_LARGE)
    for (const op of operations) {
      await batch.room()
      if (op.kind === 'task') {
        const row = await byId(ctx, 'issues', op.id)
        if (!row) throw notFound('task not found')
        const { me } = await writer(ctx, row.project_id)
        const patch = { ...op.patch }
        assertRemainingShape(patch.remaining_hours)
        if ('start_week' in patch || 'end_week' in patch) {
          // A group takes its dates from its subtasks. Refused before the
          // no-op skip, so a group's date operation never passes silently.
          if (await hasSubtasks(ctx, row)) throw rule(GROUP_DATES_RULE)
          const start = 'start_week' in patch ? (patch.start_week ?? undefined) : row.start_week
          const end = 'end_week' in patch ? (patch.end_week ?? undefined) : row.end_week
          assertWeekPair(start, end)
        }
        // before the no-op skip, so a malformed expected is refused even
        // on an operation that changes nothing
        await assertTaskExpected(ctx, {
          me,
          issue: row,
          view: 'app',
          expected: op.expected,
          next: patch,
        })
        // the cap after the field check, so stale hours answer as changed
        if ('remaining_hours' in patch)
          patch.remaining_hours = cleanRemaining(patch.remaining_hours) ?? null
        if (
          Object.entries(patch).every(
            ([field, value]) => (row[field as keyof typeof patch] ?? null) === value,
          )
        )
          continue
        if (!beforeTasks.has(row.id)) beforeTasks.set(row.id, row)
        await updateIssueCore(ctx, {
          me,
          issue: row,
          patch,
          now,
          bulk: await batch.bulkOf(row.org_id),
        })
      } else {
        const existing = await byId(ctx, 'milestones', op.id)
        if (!beforeMilestones.has(op.id))
          beforeMilestones.set(op.id, existing ? milestoneValues(existing) : undefined)
        if (op.kind === 'milestone_create') {
          assertNewRowId(op.id)
          // A sub-project folds up to the top-level project that stores it.
          const me = await seatFor(ctx, op.project_id)
          if (!me) throw notFound('project not found')
          const project = await milestoneTarget(ctx, me, op.project_id)
          await assertOrgWritable(ctx, project.org_id)
          const after = {
            id: op.id,
            project_id: project.id,
            name: cleanMilestoneName(op.name),
            week: cleanMilestoneWeek(op.week),
            created_at: now,
          }
          await insertUnique(
            ctx,
            'milestones',
            'by_uuid',
            { id: op.id },
            after,
            badRequest('a milestone with this id already exists'),
          )
          dated.add(op.id)
          await logMilestone(ctx, undefined, after, now)
        } else {
          const me = await seatFor(ctx, existing?.project_id)
          if (!existing || !me) throw notFound('milestone not found')
          await changeableMilestone(ctx, me, op.id)
          await assertOrgWritable(ctx, me.org_id)
          const before = milestoneValues(existing)
          await assertMilestoneExpected(ctx, {
            me,
            milestone: existing,
            view: 'app',
            expected: op.expected,
            next:
              op.kind === 'milestone_remove'
                ? DELETES
                : {
                    ...(op.patch.name !== undefined ? { name: op.patch.name } : {}),
                    ...(op.patch.week !== undefined ? { week: op.patch.week } : {}),
                  },
          })
          if (op.kind === 'milestone_remove') {
            await ctx.db.delete(existing._id)
            await logMilestone(ctx, before, undefined, now)
          } else {
            const patch = { ...op.patch }
            if (patch.name !== undefined) patch.name = cleanMilestoneName(patch.name)
            if (patch.week !== undefined) patch.week = cleanMilestoneWeek(patch.week)
            const after = { ...before, ...patch }
            if (same(before, after)) continue
            await ctx.db.patch(existing._id, patch)
            if (after.week !== before.week) dated.add(op.id)
            await logMilestone(ctx, before, after, now)
          }
        }
      }
    }
    await assertWeeksFree(ctx, dated, batch, false)
    const changes: Change[] = []
    for (const before of beforeTasks.values()) {
      await batch.room()
      const after = await byId(ctx, 'issues', before.id)
      if (!after) throw stale()
      // Amount and measurement time form one value, including two writes
      // landing in the same millisecond. A later re-estimate must conflict
      // even if someone eventually returns to the recorded amount.
      const estimateChanged =
        before.remaining_hours !== after.remaining_hours ||
        before.remaining_set_at !== after.remaining_set_at
      const fields = taskFields.filter((field) =>
        field === 'remaining_hours' || field === 'remaining_set_at'
          ? estimateChanged
          : before[field] !== after[field],
      )
      if (!fields.length) continue
      changes.push({
        kind: 'task',
        id: before.id,
        fields,
        guard: await taskGuard(ctx, after),
        before: taskValues(before),
        after: taskValues(after),
      })
    }
    for (const [id, before] of beforeMilestones) {
      const row = await byId(ctx, 'milestones', id)
      const after = row ? milestoneValues(row) : undefined
      if (!same(before, after)) changes.push({ kind: 'milestone', id, before, after })
    }
    if (!changes.length) return { count: entries.length }
    const expires_at = entries[0]?.expires_at ?? Date.now() + TTL
    await ctx.db.insert('roadmap_history', {
      auth_user_id: ctx.authUserId,
      session_key: session_id,
      position: (entries.at(-1)?.position ?? 0) + 1,
      expires_at,
      changes: JSON.stringify(changes),
    })
    if (!entries.length)
      await ctx.scheduler.runAt(expires_at, expireRef, {
        auth_user_id: ctx.authUserId,
        session_id,
        expires_at,
      })
    return { count: entries.length + 1 }
  },
})

/* Exact restoration is deliberately internal to this endpoint. Calling the
 * ordinary update core would re-stamp estimates. Validate the complete
 * transaction, then send normal notifications and activity for the actual
 * reverse changes. Each step restores only the rows it journaled. */
async function restoreStep(
  ctx: Context,
  changes: Change[],
  now: string,
  batch: Batch,
  dated: Set<string>,
) {
  const tasks: { change: TaskChange; before: Doc<'issues'>; me: Doc<'profiles'> }[] = []
  for (const change of changes) {
    await batch.room()
    if (change.kind === 'task') {
      // A receipt that still carries `authorities` was written while child
      // edits widened their ancestors, so it may restore ancestor dates that
      // no write changes any more. Receipts live 24 hours, so such a visit
      // simply expires.
      if ('authorities' in change) throw expired()
      const row = await byId(ctx, 'issues', change.id)
      if (!row) throw stale()
      const me = await taskWriter(ctx, row)
      if (
        (await taskGuard(ctx, row)) !== change.guard ||
        change.fields.some((field) => row[field] !== change.after[field])
      )
        throw stale()
      tasks.push({ change, before: row, me })
    } else {
      const subject = change.before ?? change.after
      if (!subject) throw stale()
      const { project } = await writer(ctx, subject.project_id)
      const row = await byId(ctx, 'milestones', change.id)
      const actual = row ? milestoneValues(row) : undefined
      if (change.before && change.after) {
        // An update owns only fields it changed; independent renames/moves survive.
        if (
          !row ||
          !actual ||
          actual.project_id !== change.after.project_id ||
          actual.created_at !== change.after.created_at
        )
          throw stale()
        const patch: Partial<Milestone> = {}
        for (const field of ['name', 'week'] as const)
          if (change.before[field] !== change.after[field]) {
            if (actual[field] !== change.after[field]) throw stale()
            patch[field] = change.before[field]
          }
        await ctx.db.patch(row._id, patch)
        if (patch.week !== undefined) dated.add(change.id)
        await logMilestone(ctx, actual, { ...actual, ...patch }, now)
      } else {
        if (!same(actual, change.after)) throw stale()
        if (change.before && project.archived_at !== undefined)
          throw rule('that project is archived, so restore it first')
        if (row) await ctx.db.delete(row._id)
        if (change.before) {
          await ctx.db.insert('milestones', change.before)
          dated.add(change.id)
        }
        await logMilestone(ctx, actual, change.before, now)
      }
    }
  }
  for (const { change, before } of tasks) {
    await batch.room()
    const patch: Partial<TaskValues> = {}
    for (const field of change.fields) Object.assign(patch, { [field]: change.before[field] })
    await ctx.db.patch(before._id, { ...patch, updated_at: now })
  }
  // Each restored row must still hold a valid plan of its own, with a
  // complete week pair and restored hours only on a task without active
  // subtasks.
  for (const { change, before, me } of tasks) {
    await batch.room()
    const after = await byId(ctx, 'issues', before.id)
    if (!after) throw stale()
    assertWeekPair(after.start_week, after.end_week)
    if (change.fields.includes('remaining_hours') && after.remaining_hours !== undefined)
      await assertOwnRemaining(ctx, after)
    const { preload } = await batch.bulkOf(after.org_id)
    await notifyIssueUpdate(ctx, { before, after, actor: me, now, preload })
    await logActivity(ctx, {
      org_id: after.org_id,
      actor_id: me.id,
      verb: 'changed',
      target_type: 'issue',
      target_id: after.id,
      label: after.title,
      detail: 'undid roadmap changes',
      project_id: after.project_id,
      ts: now,
      named_task_nums: [],
      field_prints: changedPrints(TASK_FIELDS, before, after),
    })
  }
}

export const undo = authedMutation({
  args: { session_id: v.string(), all: v.boolean() },
  handler: async (ctx, { session_id, all }): Promise<{ count: number }> => {
    const entries = await history(ctx, session_id)
    if (!entries.length) throw expired()
    const selected = all ? entries.slice().reverse() : entries.slice(-1)
    const now = new Date().toISOString()
    const batch = batchOf(ctx, all ? ROADMAP_UNDO_TOO_LARGE : ROADMAP_STEP_TOO_LARGE)
    // the milestones the undo moves back or brings back, checked once every
    // step has run
    const dated = new Set<string>()
    for (const entry of selected) {
      await restoreStep(ctx, JSON.parse(entry.changes) as Change[], now, batch, dated)
      await ctx.db.delete(entry._id)
    }
    await assertWeeksFree(ctx, dated, batch, true)
    return { count: entries.length - selected.length }
  },
})

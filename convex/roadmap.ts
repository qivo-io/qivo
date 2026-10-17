/* A roadmap visit is an owner-scoped undo journal. Clients supply commands,
 * never restoration values. Each mutation is one serializable undo step that
 * journals only the tasks its operations name. A group's dates are
 * calculated from its subtasks, so no write changes another task's dates.
 * History expires after 24 hours. */
import { makeFunctionReference, type WithoutSystemFields } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, type MutationCtx } from './_generated/server'
import { canSeeProject, hasProjectLevel } from './lib/access'
import { assertOrgWritable } from './lib/billingAccess'
import { byId, insertUnique } from './lib/db'
import { authedMutation, badRequest, conflict, forbidden, notFound, rule } from './lib/functions'
import { logActivity } from './model/activity'
import {
  assertOwnRemaining,
  assertWeekPair,
  cleanRemaining,
  GROUP_DATES_RULE,
  hasSubtasks,
  updateIssueCore,
} from './model/issues'
import { notifyIssueUpdate } from './model/messages'
import {
  changeableMilestone,
  cleanMilestoneName,
  cleanMilestoneWeek,
  milestoneTarget,
} from './model/milestones'
import { weekLabel } from './model/orgs'

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

async function writer(ctx: Context, projectId: string) {
  const project = await byId(ctx, 'projects', projectId)
  const me = project && ctx.myProfiles.get(project.org_id)
  if (!project || !me || !(await canSeeProject(ctx, me, project)))
    throw notFound('project not found')
  if (!(await hasProjectLevel(ctx, me, projectId, 'user')))
    throw forbidden('no write access to this project')
  await assertOrgWritable(ctx, project.org_id)
  return { project, me }
}

/* The caller's seat in the organization that holds `projectId`, if any.
 * The shared milestone rules (model/milestones.ts) then decide for it. */
async function seatFor(ctx: Context, projectId: string | undefined) {
  const project = projectId === undefined ? null : await byId(ctx, 'projects', projectId)
  return project ? ctx.myProfiles.get(project.org_id) : undefined
}

async function taskGuard(ctx: MutationCtx, row: Doc<'issues'>): Promise<string> {
  const children = await ctx.db
    .query('issues')
    .withIndex('by_parent', (q) => q.eq('parent_id', row.id))
    .collect()
  return JSON.stringify({
    row: row._id,
    org: row.org_id,
    project: row.project_id,
    parent: row.parent_id,
    archived: row.archived_at,
    children: children
      .map((c) => [c._id, c.archived_at ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  })
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

const operation = v.union(
  v.object({
    kind: v.literal('task'),
    id: v.string(),
    patch: v.object({
      start_week: v.optional(v.union(v.string(), v.null())),
      end_week: v.optional(v.union(v.string(), v.null())),
      remaining_hours: v.optional(v.union(v.number(), v.null())),
    }),
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
  }),
  v.object({ kind: v.literal('milestone_remove'), id: v.string() }),
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
    const now = new Date().toISOString()
    for (const op of operations) {
      if (op.kind === 'task') {
        const row = await byId(ctx, 'issues', op.id)
        if (!row) throw notFound('task not found')
        const { me } = await writer(ctx, row.project_id)
        const patch = { ...op.patch }
        if ('remaining_hours' in patch)
          patch.remaining_hours = cleanRemaining(patch.remaining_hours) ?? null
        if ('start_week' in patch || 'end_week' in patch) {
          // A group takes its dates from its subtasks. Refused before the
          // no-op skip, so a group's date operation never passes silently.
          if (await hasSubtasks(ctx, row.id, row.archived_at !== undefined))
            throw rule(GROUP_DATES_RULE)
          const start = 'start_week' in patch ? (patch.start_week ?? undefined) : row.start_week
          const end = 'end_week' in patch ? (patch.end_week ?? undefined) : row.end_week
          assertWeekPair(start, end)
        }
        if (
          Object.entries(patch).every(
            ([field, value]) => (row[field as keyof typeof patch] ?? null) === value,
          )
        )
          continue
        if (!beforeTasks.has(row.id)) beforeTasks.set(row.id, row)
        await updateIssueCore(ctx, { me, issue: row, patch, now })
      } else {
        const existing = await byId(ctx, 'milestones', op.id)
        if (!beforeMilestones.has(op.id))
          beforeMilestones.set(op.id, existing ? milestoneValues(existing) : undefined)
        if (op.kind === 'milestone_create') {
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
          await logMilestone(ctx, undefined, after, now)
        } else {
          const me = await seatFor(ctx, existing?.project_id)
          if (!existing || !me) throw notFound('milestone not found')
          await changeableMilestone(ctx, me, op.id)
          await assertOrgWritable(ctx, me.org_id)
          const before = milestoneValues(existing)
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
            await logMilestone(ctx, before, after, now)
          }
        }
      }
    }
    const changes: Change[] = []
    for (const before of beforeTasks.values()) {
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
async function restoreStep(ctx: Context, changes: Change[], now: string) {
  const tasks: { change: TaskChange; before: Doc<'issues'>; me: Doc<'profiles'> }[] = []
  for (const change of changes) {
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
        await logMilestone(ctx, actual, { ...actual, ...patch }, now)
      } else {
        if (!same(actual, change.after)) throw stale()
        if (change.before && project.archived_at !== undefined)
          throw rule('that project is archived — restore it first')
        if (row) await ctx.db.delete(row._id)
        if (change.before) await ctx.db.insert('milestones', change.before)
        await logMilestone(ctx, actual, change.before, now)
      }
    }
  }
  for (const { change, before } of tasks) {
    const patch: Partial<TaskValues> = {}
    for (const field of change.fields) Object.assign(patch, { [field]: change.before[field] })
    await ctx.db.patch(before._id, { ...patch, updated_at: now })
  }
  // Each restored row must still hold a valid plan of its own, with a
  // complete week pair and restored hours only on a task without active
  // subtasks.
  for (const { change, before, me } of tasks) {
    const after = await byId(ctx, 'issues', before.id)
    if (!after) throw stale()
    assertWeekPair(after.start_week, after.end_week)
    if (change.fields.includes('remaining_hours') && after.remaining_hours !== undefined)
      await assertOwnRemaining(ctx, after.id)
    await notifyIssueUpdate(ctx, { before, after, actor: me, now })
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
    for (const entry of selected) {
      await restoreStep(ctx, JSON.parse(entry.changes) as Change[], now)
      await ctx.db.delete(entry._id)
    }
    return { count: entries.length - selected.length }
  },
})

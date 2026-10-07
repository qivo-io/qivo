/* A roadmap visit is an owner-scoped undo journal. Clients supply commands,
 * never restoration values. Each mutation is one serializable undo step,
 * including all envelope cascades. History expires after 24 hours. */
import { makeFunctionReference, type WithoutSystemFields } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, type MutationCtx } from './_generated/server'
import { canSeeProject, hasProjectLevel } from './lib/access'
import { assertBillingWritable } from './lib/billingAccess'
import { byId, insertUnique } from './lib/db'
import { authedMutation, badRequest, conflict, forbidden, notFound, rule } from './lib/functions'
import { logActivity } from './model/activity'
import {
  assertOwnRemaining,
  assertWeekPair,
  clampEnvelope,
  cleanRemaining,
  updateIssueCore,
} from './model/issues'
import { notifyIssueUpdate } from './model/messages'
import { weekLabel } from './model/orgs'

type Context = MutationCtx & { authUserId: string; myProfiles: Map<string, Doc<'profiles'>> }
const TTL = 24 * 60 * 60 * 1000
const LIMIT = 1000
const taskFields = ['start_week', 'end_week', 'remaining_hours', 'remaining_set_at'] as const
type TaskField = (typeof taskFields)[number]
type TaskValues = Pick<Doc<'issues'>, TaskField>
type TaskAuthority = { id: string; path: { id: string; guard: string }[] }
type TaskChange = {
  kind: 'task'
  id: string
  guard: string
  fields: TaskField[]
  before: TaskValues
  after: TaskValues
  authorities: TaskAuthority[]
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

const ancestryGuard = (row: Doc<'issues'>) =>
  JSON.stringify({
    row: row._id,
    org: row.org_id,
    project: row.project_id,
    parent: row.parent_id,
    archived: row.archived_at,
  })

async function writer(ctx: Context, projectId: string) {
  const project = await byId(ctx, 'projects', projectId)
  const me = project && ctx.myProfiles.get(project.org_id)
  if (!project || !me || !(await canSeeProject(ctx, me, project)))
    throw notFound('project not found')
  if (!(await hasProjectLevel(ctx, me, projectId, 'user')))
    throw forbidden('no write access to this project')
  await assertBillingWritable(ctx, project.org_id)
  return { project, me }
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

/* Automatic widening has the same authority as the original child edit,
 * even when an ancestor's project is hidden or read-only. The journal pins
 * each directly edited task and its complete ancestry path. Undo requires
 * current write access on those original tasks and unchanged paths; it does
 * not grant direct editing rights on any ancestor. */
async function taskWriter(ctx: Context, row: Doc<'issues'>, change: TaskChange) {
  // Receipts created before authority paths were introduced cannot replay.
  if (!Array.isArray(change.authorities) || !change.authorities.length) throw expired()
  let actor: Doc<'profiles'> | undefined
  for (const authority of change.authorities) {
    if (authority.path[0]?.id !== authority.id || authority.path.at(-1)?.id !== row.id)
      throw stale()
    const root = await byId(ctx, 'issues', authority.id)
    if (!root) throw stale()
    const { me } = await writer(ctx, root.project_id)
    if (me.org_id !== row.org_id) throw stale()
    actor = me
    for (const node of authority.path) {
      const current = node.id === root.id ? root : await byId(ctx, 'issues', node.id)
      if (!current || ancestryGuard(current) !== node.guard) throw stale()
    }
  }
  if (!actor) throw expired()
  return actor
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

function cleanWeek(week: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week))
    throw badRequest('a milestone week is an ISO date (YYYY-MM-DD)')
  return week
}

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
    const taskAuthorities = new Map<string, Map<string, TaskAuthority>>()
    const beforeMilestones = new Map<string, Milestone | undefined>()
    const captureChain = async (row: Doc<'issues'>) => {
      let current: Doc<'issues'> | null = row
      const seen = new Set<string>()
      const path: TaskAuthority['path'] = []
      while (current) {
        if (seen.has(current.id) || seen.size > 20)
          throw rule('task hierarchy too deep for the envelope cascade')
        seen.add(current.id)
        if (!beforeTasks.has(current.id)) beforeTasks.set(current.id, current)
        path.push({ id: current.id, guard: ancestryGuard(current) })
        let authorities = taskAuthorities.get(current.id)
        if (!authorities) {
          authorities = new Map()
          taskAuthorities.set(current.id, authorities)
        }
        authorities.set(row.id, { id: row.id, path: [...path] })
        current = current.parent_id ? await byId(ctx, 'issues', current.parent_id) : null
      }
    }
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
          const start = 'start_week' in patch ? (patch.start_week ?? undefined) : row.start_week
          const end = 'end_week' in patch ? (patch.end_week ?? undefined) : row.end_week
          assertWeekPair(start, end)
          const clamped = await clampEnvelope(ctx, row.id, start, end)
          patch.start_week = clamped.start ?? null
          patch.end_week = clamped.end ?? null
        }
        if (
          Object.entries(patch).every(
            ([field, value]) => (row[field as keyof typeof patch] ?? null) === value,
          )
        )
          continue
        await captureChain(row)
        await updateIssueCore(ctx, { me, issue: row, patch, now })
      } else {
        const existing = await byId(ctx, 'milestones', op.id)
        if (!beforeMilestones.has(op.id))
          beforeMilestones.set(op.id, existing ? milestoneValues(existing) : undefined)
        if (op.kind === 'milestone_create') {
          const { project } = await writer(ctx, op.project_id)
          if (project.archived_at !== undefined)
            throw rule('that project is archived — restore it first')
          const after = {
            id: op.id,
            project_id: op.project_id,
            name: op.name,
            week: cleanWeek(op.week),
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
          if (!existing) throw notFound('milestone not found')
          await writer(ctx, existing.project_id)
          const before = milestoneValues(existing)
          if (op.kind === 'milestone_remove') {
            await ctx.db.delete(existing._id)
            await logMilestone(ctx, before, undefined, now)
          } else {
            const patch = { ...op.patch }
            if (patch.week !== undefined) patch.week = cleanWeek(patch.week)
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
        authorities: [...(taskAuthorities.get(before.id)?.values() ?? [])],
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
 * ordinary update core would re-stamp estimates and clamp a parent before
 * its children had been restored. Validate the complete transaction, then
 * send normal notifications and activity for the actual reverse changes. */
async function restoreStep(ctx: Context, changes: Change[], now: string) {
  const tasks: { change: TaskChange; before: Doc<'issues'>; me: Doc<'profiles'> }[] = []
  for (const change of changes) {
    if (change.kind === 'task') {
      const row = await byId(ctx, 'issues', change.id)
      if (!row) throw stale()
      const me = await taskWriter(ctx, row, change)
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
  // Check both restored rows and the current ancestors: external changes to
  // children or an untouched ancestor must never produce an invalid envelope.
  const validated = new Set<string>()
  for (const { before, me } of tasks) {
    let row = await byId(ctx, 'issues', before.id)
    while (row && !validated.has(row.id)) {
      validated.add(row.id)
      assertWeekPair(row.start_week, row.end_week)
      if (row.remaining_hours !== undefined) await assertOwnRemaining(ctx, row.id)
      const clamped = await clampEnvelope(ctx, row.id, row.start_week, row.end_week)
      if (clamped.start !== row.start_week || clamped.end !== row.end_week) throw stale()
      row = row.parent_id ? await byId(ctx, 'issues', row.parent_id) : null
    }
    const after = await byId(ctx, 'issues', before.id)
    if (!after) throw stale()
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

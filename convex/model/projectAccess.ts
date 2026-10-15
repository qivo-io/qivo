/* Who has access to a project, changed one person or one team at a time.
 * The app's removal window, REST and MCP all remove a grant through
 * removeProjectGrantCore, and REST and MCP give or change one through
 * setProjectGrantCore, so the rule exists once.
 *
 * Only a person who controls the project's access may change it: an
 * organization admin or the project's lead (lib/access.ts
 * canManageProjectUsers, canManageProjectTeams), never an agent
 * (canChangeAccess). The lead's own access comes with the lead role, so it is
 * changed by handing over the lead (model/projects.ts updateProjectCore), not
 * here.
 *
 * Removing access can hide open tasks from the people working on them. As in
 * the app's removal window (src/store/planner.ts accessRemoval), those are
 * the open tasks of the project and its sub-projects, in projects that are
 * not archived, whose active assignee, or whose reviewer when the task has no
 * subtasks, could see them before and cannot after. The caller chooses what
 * happens to them, and the removal and that choice land in one transaction or
 * not at all. */

import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import {
  ACCESS_NEEDS_A_PERSON,
  canChangeAccess,
  canManageProjectTeams,
  canManageProjectUsers,
  type OrgProjectLevels,
  projectLevelsForOrg,
  rootMetaOf,
} from '../lib/access'
import { byId } from '../lib/db'
import type { GrantLevel } from '../lib/enums'
import { badRequest, forbidden, rule } from '../lib/functions'
import { logActivity, signedDetail } from './activity'
import { assertAssigneeRule, hasSubtasks, updateIssueCore } from './issues'
import { assertGrantee, assertTeamGrantee } from './projects'

/** The one person or team whose access a write changes, already resolved in
 * the caller's organization. */
export type AccessSubject = { profile: Doc<'profiles'> } | { team: Doc<'teams'> }

/** What happens to the open tasks a removal hides from the people working on
 * them: they stay hidden (listed in the result), the people keep a Viewer
 * grant on the project so they still see them, or every one goes to one
 * user (null leaves them unassigned). */
export type HeldTasks = 'leave' | 'keep_as_viewer' | { reassign_to: string | null }

export const vHeldTasks = v.union(
  v.literal('leave'),
  v.literal('keep_as_viewer'),
  v.object({ reassign_to: v.union(v.string(), v.null()) }),
)

export const HELD_TASKS_SHAPE =
  'on_held_tasks must be "leave", "keep_as_viewer" or {"reassign_to": a user id or null}'

/** on_held_tasks in an MCP tool's input schema. */
export const ON_HELD_TASKS_SCHEMA = {
  anyOf: [
    { type: 'string', enum: ['leave', 'keep_as_viewer'] },
    {
      type: 'object',
      properties: { reassign_to: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      required: ['reassign_to'],
    },
  ],
}

/** A machine request's on_held_tasks, checked before anything resolves.
 * Absent or null means 'leave'. */
export function parseHeldTasks(raw: unknown): HeldTasks {
  if (raw === undefined || raw === null || raw === 'leave') return 'leave'
  if (raw === 'keep_as_viewer') return raw
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const keys = Object.keys(raw)
    const to = (raw as { reassign_to?: unknown }).reassign_to
    if (keys.length === 1 && keys[0] === 'reassign_to') {
      if (to === null) return { reassign_to: null }
      if (typeof to === 'string') return { reassign_to: to.toLowerCase() }
    }
  }
  throw badRequest(HELD_TASKS_SHAPE)
}

/** One open task someone works on, by role. */
export type Holding = { task: Doc<'issues'>; profile_id: string; role: 'assignee' | 'reviewer' }

/** What a removal did: whether a grant went, the tasks left out of their
 * holders' sight, the people kept as Viewers and the tasks handed over. */
export type AccessRemoval = {
  removed: boolean
  stranded: Holding[]
  kept_as_viewer: string[]
  reassigned: Holding[]
}

export const LEAD_ACCESS_RULE = 'that user leads this project; hand the lead to someone else first'

/* Refuses a caller who may not change this project's access for the
 * subject's kind of grant. */
async function assertManagesAccess(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  project: Doc<'projects'>,
  subject: AccessSubject,
): Promise<void> {
  if (!canChangeAccess(me)) throw forbidden(ACCESS_NEEDS_A_PERSON)
  const allowed =
    'team' in subject
      ? await canManageProjectTeams(ctx, me, project)
      : await canManageProjectUsers(ctx, me, project)
  if (!allowed) throw forbidden('no permission to manage users on this project')
}

/* The lead's access is the lead role; a sub-project without its own lead
 * (legacy rows) is led by its parent's. */
async function assertNotLead(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  subject: AccessSubject,
): Promise<void> {
  if (!('profile' in subject)) return
  const lead = project.lead_id ?? (await rootMetaOf(ctx, project)).lead_id
  if (lead === subject.profile.id) throw rule(LEAD_ACCESS_RULE)
}

/* The subject's grant row on the project, if any. */
async function grantOf(ctx: QueryCtx, project: Doc<'projects'>, subject: AccessSubject) {
  return 'team' in subject
    ? await ctx.db
        .query('project_team_access')
        .withIndex('by_project_team', (q) =>
          q.eq('project_id', project.id).eq('team_id', subject.team.id),
        )
        .unique()
    : await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', project.id).eq('profile_id', subject.profile.id),
        )
        .unique()
}

/* One activity row per access change, as the app's access writes narrate. */
async function narrateAccess(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; project: Doc<'projects'>; now: string; provenance?: string },
): Promise<void> {
  await logActivity(ctx, {
    org_id: a.me.org_id,
    actor_id: a.me.id,
    verb: 'changed access on',
    target_type: 'project',
    target_id: a.project.id,
    label: a.project.name,
    detail: signedDetail(undefined, a.provenance),
    project_id: a.project.id,
    ts: a.now,
  })
}

/**
 * Gives one person or one team `level` on the project, or changes the level
 * they have. A viewer-role person only ever receives Viewer, and the lead's
 * access is the lead role. Returns whether anything changed; a level the
 * subject already has narrates nothing.
 */
export async function setProjectGrantCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    project: Doc<'projects'>
    subject: AccessSubject
    level: GrantLevel
    now: string
    provenance?: string
  },
): Promise<{ changed: boolean }> {
  const { project, subject, level } = a
  await assertManagesAccess(ctx, a.me, project, subject)
  await assertNotLead(ctx, project, subject)
  if ('team' in subject) await assertTeamGrantee(ctx, project, subject.team.id)
  else await assertGrantee(ctx, project, subject.profile.id, level)
  const row = await grantOf(ctx, project, subject)
  if (row?.level === level) return { changed: false }
  if (row !== null) await ctx.db.patch(row._id, { level })
  else if ('team' in subject) {
    await ctx.db.insert('project_team_access', {
      project_id: project.id,
      team_id: subject.team.id,
      level,
    })
  } else {
    await ctx.db.insert('project_access', {
      project_id: project.id,
      profile_id: subject.profile.id,
      level,
    })
  }
  await narrateAccess(ctx, a)
  return { changed: true }
}

/* The projects whose tasks a grant on `project` reaches: itself and, for a
 * top-level project, its sub-projects, leaving out archived ones as the
 * app's working set does. */
async function reachedProjects(
  ctx: QueryCtx,
  project: Doc<'projects'>,
): Promise<Doc<'projects'>[]> {
  if (project.archived_at !== undefined) return []
  const out = [project]
  if (project.type === 'meta') {
    const subs = ctx.db
      .query('projects')
      .withIndex('by_parent', (q) => q.eq('parent_id', project.id))
    for await (const sub of subs) if (sub.archived_at === undefined) out.push(sub)
  }
  return out
}

/* One person's role on an open task a removal takes out of their sight, with
 * the task's project. */
type Lost = Holding & { project: Doc<'projects'> }

/**
 * Runs `remove` and answers the open tasks in `projects` that someone in
 * `people` works on and could see before and cannot see after. A
 * switched-off person holds no work, and a group's reviewer is dormant.
 *
 * The reads are bounded by what the app's snapshot reads, never by history.
 * Only the active tasks of `projects` are read (by_project_archived). Each
 * person holding one of them gets their sight worked out once before and once
 * after, for every project at a time (lib/access.ts projectLevelsForOrg, over
 * one read of the organization's projects). Only a reviewer who lost sight
 * costs a subtask lookup.
 */
async function removeAndFindLost(
  ctx: MutationCtx,
  a: {
    projects: readonly Doc<'projects'>[]
    people: ReadonlyMap<string, Doc<'profiles'>>
    remove: () => Promise<void>
  },
): Promise<Lost[]> {
  const candidates: Lost[] = []
  for (const project of a.projects) {
    const tasks = ctx.db
      .query('issues')
      .withIndex('by_project_archived', (q) =>
        q.eq('project_id', project.id).eq('archived_at', undefined),
      )
    for await (const task of tasks) {
      if (task.status === 'done') continue
      for (const role of ['assignee', 'reviewer'] as const) {
        const holder = role === 'assignee' ? task.assignee_id : task.reviewer_id
        if (holder !== undefined && a.people.get(holder)?.active) {
          candidates.push({ task, project, profile_id: holder, role })
        }
      }
    }
  }
  const holders = [...new Set(candidates.map((h) => h.profile_id))]
  const orgProjects =
    holders.length === 0
      ? []
      : await ctx.db
          .query('projects')
          .withIndex('by_org', (q) => q.eq('org_id', a.projects[0].org_id))
          .collect()
  const sight = async (): Promise<Map<string, OrgProjectLevels>> => {
    const out = new Map<string, OrgProjectLevels>()
    for (const id of holders) {
      const person = a.people.get(id)
      if (person !== undefined) out.set(id, await projectLevelsForOrg(ctx, person, orgProjects))
    }
    return out
  }
  const before = await sight()
  await a.remove()
  // Convex reads this transaction's own writes, so sight is now as it will be
  const after = await sight()
  const sees = (levels: Map<string, OrgProjectLevels>, h: Lost) =>
    (levels.get(h.profile_id)?.levelOf(h.project) ?? null) !== null
  const lost: Lost[] = []
  for (const h of candidates) {
    if (!sees(before, h) || sees(after, h)) continue
    if (h.role === 'reviewer' && (await hasSubtasks(ctx, h.task.id))) continue
    lost.push(h)
  }
  return lost
}

/* The people a removal can take access from: the person, or every member of
 * the team. */
async function peopleOf(
  ctx: QueryCtx,
  subject: AccessSubject,
): Promise<Map<string, Doc<'profiles'>>> {
  if ('profile' in subject) return new Map([[subject.profile.id, subject.profile]])
  const people = new Map<string, Doc<'profiles'>>()
  const members = ctx.db
    .query('team_members')
    .withIndex('by_team', (q) => q.eq('team_id', subject.team.id))
  for await (const m of members) {
    const profile = await byId(ctx, 'profiles', m.profile_id)
    if (profile !== null && profile.org_id === subject.team.org_id) people.set(profile.id, profile)
  }
  return people
}

/* Refuses a reassignment target who cannot work on every task handed over,
 * checked once per project and role after the access is gone.
 * updateIssueCore checks a holder only when it changes, so without this a
 * task handed back to the person who just lost sight of it would stay with
 * them. */
async function assertCanTakeOver(ctx: QueryCtx, lost: readonly Lost[], to: string) {
  const checked = new Set<string>()
  for (const h of lost) {
    const key = `${h.project.id}:${h.role}`
    if (checked.has(key)) continue
    checked.add(key)
    await assertAssigneeRule(ctx, h.project, to, h.role)
  }
}

/**
 * Removes one person's or one team's grant from the project and settles the
 * open tasks that leave their holders' sight by `held`. 'keep_as_viewer'
 * gives each of those people a Viewer grant on the project, which a person
 * whose removed grant was already Viewer cannot be given. `reassign_to` hands
 * each of those tasks, by role, to that user or to nobody, with every rule of
 * a task update (model/issues.ts updateIssueCore), so the new holder needs
 * Edit access and sight of every task above once the grant is gone. A
 * refusal anywhere leaves everything as it was. No grant to remove changes
 * nothing.
 */
export async function removeProjectGrantCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    project: Doc<'projects'>
    subject: AccessSubject
    held: HeldTasks
    now: string
    provenance?: string
  },
): Promise<AccessRemoval> {
  const { me, project, subject, held, now } = a
  await assertManagesAccess(ctx, me, project, subject)
  await assertNotLead(ctx, project, subject)
  const row = await grantOf(ctx, project, subject)
  if (row === null) return { removed: false, stranded: [], kept_as_viewer: [], reassigned: [] }
  const lost = await removeAndFindLost(ctx, {
    projects: await reachedProjects(ctx, project),
    people: await peopleOf(ctx, subject),
    remove: () => ctx.db.delete(row._id),
  })
  const stranded = lost.map(({ project: _where, ...h }) => h)
  const result: AccessRemoval = { removed: true, stranded, kept_as_viewer: [], reassigned: [] }
  if (stranded.length > 0 && held === 'keep_as_viewer') {
    if ('profile' in subject && row.level === 'viewer') {
      throw rule('a Viewer grant cannot be kept as Viewer; leave the tasks or reassign them')
    }
    const keep = [...new Set(stranded.map((h) => h.profile_id))]
    for (const uid of keep) {
      await ctx.db.insert('project_access', {
        project_id: project.id,
        profile_id: uid,
        level: 'viewer',
      })
    }
    result.stranded = []
    result.kept_as_viewer = keep
  } else if (stranded.length > 0 && typeof held === 'object') {
    const to = held.reassign_to
    if (to !== null) await assertCanTakeOver(ctx, lost, to)
    const byTask = new Map<string, Holding[]>()
    for (const h of stranded) byTask.set(h.task.id, [...(byTask.get(h.task.id) ?? []), h])
    for (const holdings of byTask.values()) {
      const patch: { assignee_id?: string | null; reviewer_id?: string | null } = {}
      for (const h of holdings) patch[h.role === 'assignee' ? 'assignee_id' : 'reviewer_id'] = to
      await updateIssueCore(ctx, {
        me,
        issue: holdings[0].task,
        patch,
        now,
        machine: a.provenance === undefined ? undefined : { provenance: a.provenance },
      })
    }
    result.stranded = []
    result.reassigned = stranded
  }
  await narrateAccess(ctx, a)
  return result
}

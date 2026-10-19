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
 * not at all (removeAndSettle). Removing a team member (model/teams.ts)
 * settles the member's tasks through the same function. While billing or a
 * pending deletion makes the organization read-only, an organization admin
 * can still remove access, in the app and over REST and MCP, but only by
 * leaving the tasks, because the other choices write more. */

import { ConvexError, v } from 'convex/values'
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
import { assertOrgWritable } from '../lib/billingAccess'
import { byId, usedMoreThan } from '../lib/db'
import type { GrantLevel } from '../lib/enums'
import { badRequest, forbidden, type Refusal, rule } from '../lib/functions'
import { liveIn } from '../lib/liveTasks'
import { logActivity, signedDetail } from './activity'
import { assertAssigneeRule, hasSubtasks, holderKey, updateIssueCore } from './issues'
import { loadNotifyPreload } from './messages'
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

/** One `changed access on` activity row for a project, as the app's access
 * writes narrate, signed with a machine write's provenance. */
export async function narrateAccess(
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

/** The projects whose tasks a grant on `project` reaches: itself and, for a
 * top-level project, its sub-projects, leaving out archived ones as the
 * app's working set does. */
export async function reachedProjects(
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

/** The most tasks one access removal reassigns. Each task's reassignment
 * runs every rule of a task update and notifies its followers inside the
 * removal's one transaction, so a larger handover would pass Convex's limits
 * for one transaction. Set at about 60% of the largest count that passed the
 * measurement behind tests/bulkReassign.test.ts (196 tasks with four
 * followers each, in an organization of 100 people), taken when each
 * follower's sight was still checked on its own. */
export const REASSIGN_MAX = 120

/** The share of each of Convex's limits for one transaction that a removal
 * may have used before it reassigns another task or notifies another
 * follower. A task costs more the more followers it has, and the first
 * follower in a project costs a read of every grant and team share there
 * (model/messages.ts RecipientSight). So a handover under REASSIGN_MAX can
 * still be too large, and no fixed cost per task or follower bounds it. The removal checks what the transaction used, as the
 * deployment reports it (ctx.meta.getTransactionMetrics), before each task
 * and, through the preload's guard (model/messages.ts NotifyPreload), before
 * each follower it notifies. The rest of each limit is room for one
 * follower or one task's own reads and writes and the removal's narration.
 * In tests/bulkReassign.test.ts, REASSIGN_MAX tasks with four followers each
 * use about 40% of the index ranges, and with 21 followers each about 90%. */
export const REASSIGN_ROOM = 0.95

/** The refusal of a handover too large for one removal: more than
 * REASSIGN_MAX tasks, or fewer whose followers fill REASSIGN_ROOM. It
 * suggests keeping the people as Viewers only when the removal would accept
 * that choice (`canKeep`). */
export const reassignTooLarge = (canKeep: boolean): string =>
  `a removal can reassign at most ${REASSIGN_MAX} tasks at once, fewer when they have many followers, so ${canKeep ? 'keep the people as Viewers or ' : ''}reassign some of the tasks first`

/* Thrown by a reassignment's guard once the transaction has used more than
 * REASSIGN_ROOM of a limit (lib/db.ts usedMoreThan), and turned into
 * reassignTooLarge by removeAndSettle. It is no ConvexError, so settling
 * passes it on without HELD_TASKS_REFUSED. */
class RemovalFull extends Error {}

/**
 * Runs `remove` and answers the open tasks in `projects` that someone in
 * `people` works on and could see before and cannot see after, with the
 * organization's projects it read (none when nobody holds such a task). A
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
): Promise<{ lost: Lost[]; orgProjects: Doc<'projects'>[] }> {
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
  const live = liveIn(new Map(orgProjects.map((p) => [p.id, p])))
  for (const h of candidates) {
    if (!sees(before, h) || sees(after, h)) continue
    if (h.role === 'reviewer' && (await hasSubtasks(ctx, h.task, live))) continue
    lost.push(h)
  }
  return { lost, orgProjects }
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
 * checked once per project and role after the access is gone, and records
 * each passed rule in `checked` (model/issues.ts holderKey) so the task
 * updates do not check it again. updateIssueCore checks a holder only when
 * it changes, so without this a task handed back to the person who just lost
 * sight of it would stay with them. */
async function assertCanTakeOver(
  ctx: QueryCtx,
  lost: readonly Lost[],
  to: string,
  checked: Set<string>,
) {
  for (const h of lost) {
    const key = holderKey(h.role, to, h.project.id)
    if (checked.has(key)) continue
    await assertAssigneeRule(ctx, h.project, to, h.role)
    checked.add(key)
  }
}

/* Whether the removal in `a` would accept 'keep_as_viewer' for `lost`: it
 * has no keepRefusal, and `a.me` may manage the users of each project the
 * Viewer grants would go to, as the keep branch of removeAndSettle checks. */
async function canKeepAsViewers(
  ctx: QueryCtx,
  a: {
    me: Doc<'profiles'>
    viewerOn: (project: Doc<'projects'>) => Promise<Doc<'projects'>>
    keepRefusal?: string
  },
  lost: readonly Lost[],
): Promise<boolean> {
  if (a.keepRefusal !== undefined) return false
  const projects = new Map(lost.map((h) => [h.project.id, h.project]))
  for (const project of projects.values()) {
    if (!(await canManageProjectUsers(ctx, a.me, await a.viewerOn(project)))) return false
  }
  return true
}

/** The reason a refusal carries when it comes from settling a removal's
 * held tasks (a Viewer grant or a reassignment), so the app can say the
 * access stays because of the tasks rather than because the removal itself
 * was refused. REST and MCP answer the refusal's sentence as before. */
export const HELD_TASKS_REFUSED = 'held_tasks'

/* Runs one part of a removal's settlement and marks its refusals with
 * HELD_TASKS_REFUSED. A refusal that already has a reason, such as a billing
 * pause, keeps it. */
async function settling(step: () => Promise<void>): Promise<void> {
  try {
    await step()
  } catch (e) {
    if (!(e instanceof ConvexError)) throw e
    const data = e.data as Refusal
    throw new ConvexError<Refusal>({ ...data, reason: data.reason ?? HELD_TASKS_REFUSED })
  }
}

/** What settling a removal did, besides the removal itself. `viewer_grants`
 * are the projects that received a Viewer grant, for the caller's
 * narration. */
export type Settlement = Omit<AccessRemoval, 'removed'> & { viewer_grants: Doc<'projects'>[] }

/**
 * Takes access away with `remove` and settles, by `held`, the open tasks in
 * `projects` that someone in `people` worked on and could see before and
 * cannot after. 'leave' lists them as stranded. 'keep_as_viewer' gives each
 * of those people a Viewer grant on `viewerOn(project)` of each such task,
 * which the caller must be allowed to give (canManageProjectUsers);
 * `keepRefusal`, when set, refuses that choice instead. `reassign_to` hands
 * each of those tasks, by role, to that user or to nobody, with every rule of
 * a task update (model/issues.ts updateIssueCore), so the new holder needs
 * Edit access and sight of every task above once the access is gone. A
 * handover of more than REASSIGN_MAX tasks, or one that fills REASSIGN_ROOM
 * of the transaction before its last task or follower, is refused with
 * reassignTooLarge, which blames its size rather than the tasks. Any refusal
 * throws, so the removal and its settlement land together or not at all, and
 * one while settling the tasks carries HELD_TASKS_REFUSED. Project grant
 * removal and team member removal (model/teams.ts) both run through this, as
 * the app, REST and MCP do.
 *
 * An organization admin's removal passes the read-only gate of a billing
 * pause or a pending deletion (lib/functions.ts accessRemovalMutation,
 * lib/core.ts asMachineCaller 'access_removal'). Keeping people as Viewers
 * or reassigning their tasks writes more than a removal, so each caller
 * refuses any `held` but 'leave' while the organization is read-only before
 * it reads anything, even for an organization admin.
 */
export async function removeAndSettle(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    people: ReadonlyMap<string, Doc<'profiles'>>
    projects: readonly Doc<'projects'>[]
    remove: () => Promise<void>
    held: HeldTasks
    viewerOn: (project: Doc<'projects'>) => Promise<Doc<'projects'>>
    keepRefusal?: string
    now: string
    provenance?: string
  },
): Promise<Settlement> {
  const { me, held, now } = a
  const { lost, orgProjects } = await removeAndFindLost(ctx, a)
  const stranded = lost.map(({ project: _where, ...h }) => h)
  const result: Settlement = { stranded, kept_as_viewer: [], reassigned: [], viewer_grants: [] }
  if (stranded.length > 0 && held === 'keep_as_viewer') {
    await settling(async () => {
      if (a.keepRefusal !== undefined) throw rule(a.keepRefusal)
      const granted = new Set<string>()
      for (const h of lost) {
        const where = await a.viewerOn(h.project)
        const key = `${h.profile_id}:${where.id}`
        if (granted.has(key)) continue
        granted.add(key)
        if (!result.viewer_grants.some((p) => p.id === where.id)) {
          if (!(await canManageProjectUsers(ctx, me, where))) {
            throw forbidden('no permission to manage users on this project')
          }
          result.viewer_grants.push(where)
        }
        const existing = await ctx.db
          .query('project_access')
          .withIndex('by_project_profile', (q) =>
            q.eq('project_id', where.id).eq('profile_id', h.profile_id),
          )
          .unique()
        if (existing === null) {
          await ctx.db.insert('project_access', {
            project_id: where.id,
            profile_id: h.profile_id,
            level: 'viewer',
          })
        }
      }
    })
    result.stranded = []
    result.kept_as_viewer = [...new Set(lost.map((h) => h.profile_id))]
  } else if (stranded.length > 0 && typeof held === 'object') {
    const to = held.reassign_to
    const byTask = new Map<string, Holding[]>()
    for (const h of stranded) byTask.set(h.task.id, [...(byTask.get(h.task.id) ?? []), h])
    // The size of the handover is at fault, not one of its tasks, so these
    // refusals carry no HELD_TASKS_REFUSED, and a refusal after some tasks
    // were reassigned rolls them back with the removal. The advice is worked
    // out first, because a refusal from the guard leaves little room to read.
    const tooLarge = rule(reassignTooLarge(await canKeepAsViewers(ctx, a, lost)))
    if (byTask.size > REASSIGN_MAX) throw tooLarge
    const full = async () => {
      if (await usedMoreThan(ctx, REASSIGN_ROOM)) throw new RemovalFull()
    }
    // The access is gone and the loop below writes only tasks, follows,
    // messages and activity, so one preload serves every task update.
    const preload = await loadNotifyPreload(ctx, me.org_id, orgProjects)
    const bulk = { preload: { ...preload, guard: full }, checked: new Set<string>() }
    if (to !== null) await settling(() => assertCanTakeOver(ctx, lost, to, bulk.checked))
    try {
      for (const holdings of byTask.values()) {
        await full()
        const patch: { assignee_id?: string | null; reviewer_id?: string | null } = {}
        for (const h of holdings) patch[h.role === 'assignee' ? 'assignee_id' : 'reviewer_id'] = to
        await settling(async () => {
          await updateIssueCore(ctx, {
            me,
            issue: holdings[0].task,
            patch,
            now,
            machine: a.provenance === undefined ? undefined : { provenance: a.provenance },
            bulk,
          })
        })
      }
    } catch (e) {
      throw e instanceof RemovalFull ? tooLarge : e
    }
    result.stranded = []
    result.reassigned = stranded
  }
  return result
}

/**
 * Removes one person's or one team's grant from the project and settles the
 * open tasks that leave their holders' sight by `held` (removeAndSettle).
 * 'keep_as_viewer' gives each of those people a Viewer grant on the project,
 * which a person whose removed grant was already Viewer cannot be given.
 * Keeping people as Viewers or reassigning their tasks writes more than a
 * removal, so it needs an organization that allows changes, even for an
 * organization admin, and the first line refuses it before anything is read,
 * a grant that does not exist included. A refusal anywhere leaves everything
 * as it was. No grant to remove changes nothing.
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
  const { me, project, subject } = a
  if (a.held !== 'leave') await assertOrgWritable(ctx, me.org_id)
  await assertManagesAccess(ctx, me, project, subject)
  await assertNotLead(ctx, project, subject)
  const row = await grantOf(ctx, project, subject)
  if (row === null) return { removed: false, stranded: [], kept_as_viewer: [], reassigned: [] }
  const settled = await removeAndSettle(ctx, {
    me,
    people: await peopleOf(ctx, subject),
    projects: await reachedProjects(ctx, project),
    remove: () => ctx.db.delete(row._id),
    held: a.held,
    viewerOn: async () => project,
    keepRefusal:
      'profile' in subject && row.level === 'viewer'
        ? 'a Viewer grant cannot be kept as Viewer; leave the tasks or reassign them'
        : undefined,
    now: a.now,
    provenance: a.provenance,
  })
  await narrateAccess(ctx, a)
  const { viewer_grants: _granted, ...settlement } = settled
  return { removed: true, ...settlement }
}

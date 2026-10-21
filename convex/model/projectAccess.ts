/* Who has access to a project, changed one person or one team at a time.
 * The app's removal window, REST and MCP all remove a grant through
 * removeProjectGrantCore, and give or change one through setProjectGrantCore
 * (the app through projects.setAccess), so the rule exists once.
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
 * not at all (removeAndSettle). Removing a team member and deleting a team
 * (model/teams.ts) settle the members' tasks through the same function. While billing or a
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
  projectLevelsForPeople,
  rootMetaOf,
} from '../lib/access'
import { assertOrgWritable } from '../lib/billingAccess'
import { usedMoreThan } from '../lib/db'
import { GRANT_LEVELS, type GrantLevel, vGrantLevel } from '../lib/enums'
import { badRequest, forbidden, type Refusal, rule } from '../lib/functions'
import { liveIn } from '../lib/liveTasks'
import { REASSIGN_MAX, REMOVAL_HOLDERS_MAX } from '../lib/projectGrants'
import { logActivity, signedDetail } from './activity'
import { assertExpected, exact, type Fields, oneOf } from './expected'
import { assertAssigneeRule, hasSubtasks, holderKey, updateIssueCore } from './issues'
import { newNotifyPreload } from './messages'
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

/** One person's or team's grant on a project as the field check reads
 * it: its level, null when there is none. */
type Grant = { level: GrantLevel | null }

/** The key of a grant's `expected`, the level the caller read, null for
 * "no grant". */
export const GRANT_FIELDS: Fields<Grant> = {
  level: { sends: 'level', type: oneOf(GRANT_LEVELS, true), form: exact },
}

/** The app's `expected` for a grant write. */
export const vGrantExpected = v.object({ level: v.union(vGrantLevel, v.null()) })

/** Refuses a grant write over a level someone else changed since `expected`
 * was read (model/expected.ts). `of` is the person or team the grant is
 * for, by id and name, `level` the grant held now, null for none, and
 * `next` the level the write stores. */
export async function assertGrantExpected(
  ctx: QueryCtx,
  a: {
    me: Doc<'profiles'>
    project: Doc<'projects'>
    of: { id: string; name: string }
    level: GrantLevel | null
    expected: Readonly<Record<string, unknown>> | undefined
    next: GrantLevel
  },
): Promise<void> {
  const { of } = a
  await assertExpected({
    read: { ctx, me: a.me, view: 'app' },
    fields: GRANT_FIELDS,
    record: 'grant',
    id: a.project.id,
    of: of.id,
    label: `the access of ${of.name} to project ${a.project.key}`,
    row: { level: a.level },
    expected: a.expected,
    next: { level: a.next },
  })
}

/**
 * Gives one person or one team `level` on the project, or changes the level
 * they have. A viewer-role person only ever receives Viewer, and the lead's
 * access is the lead role. Returns whether anything changed; a level the
 * subject already has narrates nothing. `expected` holds the level the
 * caller read (assertGrantExpected).
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
    expected?: Readonly<Record<string, unknown>>
  },
): Promise<{ changed: boolean }> {
  const { project, subject, level } = a
  await assertManagesAccess(ctx, a.me, project, subject)
  await assertNotLead(ctx, project, subject)
  if ('team' in subject) await assertTeamGrantee(ctx, project, subject.team.id)
  else await assertGrantee(ctx, project, subject.profile.id, level)
  const row = await grantOf(ctx, project, subject)
  await assertGrantExpected(ctx, {
    me: a.me,
    project,
    // a team saved blank before names were required is named by its id
    of:
      'team' in subject
        ? { id: subject.team.id, name: subject.team.name.trim() || `team ${subject.team.id}` }
        : subject.profile,
    level: row?.level ?? null,
    expected: a.expected,
    next: level,
  })
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

/** The share of each of Convex's limits for one transaction that a removal
 * may have used before it reads another holder's sight, gives another Viewer
 * grant, reassigns another task or checks another webhook subscription. The
 * tasks' followers hear from background steps
 * (model/messages.ts NotifyPreload.deferFollowers), so they cost the removal
 * nothing, but a task update still checks each webhook subscription of the
 * organization (taskEvents.ts emitTaskEvent), and no fixed cost per task
 * bounds that. The removal checks what the transaction used, as the
 * deployment reports it (ctx.meta.getTransactionMetrics), before each task
 * and, through the preload's guard, before each subscription it checks. The
 * rest of each limit is room for one task's own reads and writes and the
 * removal's narration. */
export const REASSIGN_ROOM = 0.95

/** The refusal of a handover too large for one removal: more than
 * REASSIGN_MAX tasks, or fewer that fill REASSIGN_ROOM. It suggests keeping
 * the people as Viewers only when the removal would accept that choice
 * (`canKeep`). */
export const reassignTooLarge = (canKeep: boolean): string =>
  `a removal can reassign at most ${REASSIGN_MAX} tasks at once, fewer when the change is too large for one request, so ${canKeep ? 'keep the people as Viewers or ' : ''}reassign some of the tasks first`

/** The refusal of Viewer grants too many for one removal: they would fill
 * REASSIGN_ROOM of the transaction before the last one is saved. */
export const KEEP_TOO_LARGE =
  'a removal can keep only as many people as Viewers as fit in one request, so remove some of these people first or reassign the tasks'

/** The refusal of a removal that keeps people as Viewers or reassigns their
 * tasks while more than REMOVAL_HOLDERS_MAX people hold open tasks in the
 * projects it reaches. Only a team's removal or deletion has that many, so
 * the next steps are leaving the tasks or removing some of the team's
 * members first. */
export const REMOVAL_TOO_LARGE = `a removal that keeps people as Viewers or reassigns their tasks can take access from at most ${REMOVAL_HOLDERS_MAX} people with open tasks at once, so leave the tasks with them, or remove some of the team's members first`

/** The refusal of a removal whose reads to work out who loses sight would
 * pass REASSIGN_ROOM of the transaction, whatever it does with the tasks. */
export const REMOVAL_FULL =
  "a removal can check only as many people and tasks as fit in one request, so remove fewer people at once, such as some of a team's members, or reassign some of the tasks first"

/* Thrown by a removal's guard once the transaction has used more than
 * REASSIGN_ROOM of a limit (lib/db.ts usedMoreThan), and turned into
 * REMOVAL_FULL, reassignTooLarge or KEEP_TOO_LARGE by removeAndSettle
 * and removeAndFindLost. It is no ConvexError, so settling passes it on
 * without HELD_TASKS_REFUSED. */
class RemovalFull extends Error {}

/** The guard each step of a removal runs before it reads or writes more. Its
 * refusal is turned into REMOVAL_FULL when it stops the reads that find who
 * loses sight or the removal itself (withinRoom), and into the settlement's
 * own refusal when it stops a Viewer grant or a handover. */
export async function assertRoom(ctx: QueryCtx): Promise<void> {
  if (await usedMoreThan(ctx, REASSIGN_ROOM)) throw new RemovalFull()
}

/** Runs `step`, a part of a removal that checks the room with assertRoom, and
 * refuses with REMOVAL_FULL once the transaction is full: the size of the
 * removal is at fault, not one of its people. */
export async function withinRoom<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (e) {
    throw e instanceof RemovalFull ? rule(REMOVAL_FULL) : e
  }
}

/* How many tasks the scan for held work reads between two room checks: ten
 * descriptions at their cap (lib/textLimits.ts TEXT_MAX) stay well under the
 * 5% of Convex's 16 MiB a removal keeps. */
const TASK_GUARD_ROWS = 10

/* How many small rows (projects, memberships, profiles) a removal reads
 * between two room checks. */
const ROW_GUARD_ROWS = 500

/**
 * Runs `remove` and answers the open tasks in `projects` that someone in
 * `people` works on and could see before and cannot see after, with the
 * organization's projects it read (none when nobody holds such a task). A
 * switched-off person holds no work, and a group's reviewer is dormant.
 *
 * The reads are bounded by what the app's snapshot reads, never by history.
 * Only the active tasks of `projects` are read (by_project_archived). The
 * people holding them get their sight worked out once before and once after,
 * for every project at a time and, when there are many of them, all together
 * (lib/access.ts projectLevelsForPeople, over one read of the organization's
 * projects). Only a reviewer who lost sight costs a subtask lookup. A
 * removal that keeps people as Viewers or reassigns their tasks is refused
 * with REMOVAL_TOO_LARGE before their sight is read when more than
 * REMOVAL_HOLDERS_MAX people hold such tasks. The room (REASSIGN_ROOM) is
 * checked before and during each read, the task scan included, and before
 * each subtask lookup, so any removal too large for one request is refused
 * with REMOVAL_FULL before a read passes Convex's limits.
 */
async function removeAndFindLost(
  ctx: MutationCtx,
  a: {
    projects: readonly Doc<'projects'>[]
    people: ReadonlyMap<string, Doc<'profiles'>>
    remove: () => Promise<void>
    held: HeldTasks
  },
): Promise<{ lost: Lost[]; orgProjects: Doc<'projects'>[] }> {
  return withinRoom(async () => {
    const candidates: Lost[] = []
    let read = 0
    for (const project of a.projects) {
      await assertRoom(ctx)
      const tasks = ctx.db
        .query('issues')
        .withIndex('by_project_archived', (q) =>
          q.eq('project_id', project.id).eq('archived_at', undefined),
        )
      for await (const task of tasks) {
        if (++read % TASK_GUARD_ROWS === 0) await assertRoom(ctx)
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
    if (a.held !== 'leave' && holders.length > REMOVAL_HOLDERS_MAX) throw rule(REMOVAL_TOO_LARGE)
    const orgProjects: Doc<'projects'>[] = []
    if (holders.length > 0) {
      await assertRoom(ctx)
      const rows = ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', a.projects[0].org_id))
      for await (const p of rows) {
        if (orgProjects.push(p) % ROW_GUARD_ROWS === 0) await assertRoom(ctx)
      }
    }
    const holding = holders.flatMap((id) => a.people.get(id) ?? [])
    const sight = (): Promise<Map<string, OrgProjectLevels>> =>
      projectLevelsForPeople(ctx, holding, orgProjects, () => assertRoom(ctx))
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
      if (h.role === 'reviewer') {
        await assertRoom(ctx)
        if (await hasSubtasks(ctx, h.task, live)) continue
      }
      lost.push(h)
    }
    return { lost, orgProjects }
  })
}

/** The people a removal can take access from: the person, or every member of
 * the team in its organization. A team's members are matched against one read
 * of the organization's profiles rather than read one at a time, so a large
 * team costs two index ranges, not one per member. It checks the room as it
 * reads, so call it within withinRoom. */
export async function peopleOf(
  ctx: QueryCtx,
  subject: AccessSubject,
): Promise<Map<string, Doc<'profiles'>>> {
  if ('profile' in subject) return new Map([[subject.profile.id, subject.profile]])
  const members = new Set<string>()
  const memberships = ctx.db
    .query('team_members')
    .withIndex('by_team', (q) => q.eq('team_id', subject.team.id))
  await assertRoom(ctx)
  for await (const m of memberships) {
    if (members.add(m.profile_id).size % ROW_GUARD_ROWS === 0) await assertRoom(ctx)
  }
  const people = new Map<string, Doc<'profiles'>>()
  if (members.size === 0) return people
  const profiles = ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', subject.team.org_id))
  let read = 0
  for await (const profile of profiles) {
    if (++read % ROW_GUARD_ROWS === 0) await assertRoom(ctx)
    if (members.has(profile.id)) people.set(profile.id, profile)
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
 * of the transaction before its last task, is refused with
 * reassignTooLarge, which blames its size rather than the tasks. Viewer
 * grants that fill REASSIGN_ROOM before the last one is saved are refused
 * the same way with KEEP_TOO_LARGE. A removal whose people are too many to
 * work out who loses sight is refused with REMOVAL_TOO_LARGE or REMOVAL_FULL
 * before it reads past Convex's limits (removeAndFindLost). Any refusal
 * throws, so the removal and its settlement land together or not at all, and
 * one while settling the tasks carries HELD_TASKS_REFUSED. Project grant
 * removal, team member removal and team deletion (model/teams.ts) all run
 * through this.
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
  // Each Viewer grant and each reassigned task first checks the room left
  const full = () => assertRoom(ctx)
  const keepAsViewers = async () => {
    await settling(async () => {
      if (a.keepRefusal !== undefined) throw rule(a.keepRefusal)
      // a task's project and a grant already worked out cost no more room
      const placed = new Map<string, Doc<'projects'>>()
      const granted = new Set<string>()
      for (const h of lost) {
        let where = placed.get(h.project.id)
        if (where === undefined) {
          await full()
          where = await a.viewerOn(h.project)
          placed.set(h.project.id, where)
        }
        const key = `${h.profile_id}:${where.id}`
        if (granted.has(key)) continue
        granted.add(key)
        await full()
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
  }
  if (stranded.length > 0 && held === 'keep_as_viewer') {
    try {
      await keepAsViewers()
    } catch (e) {
      // the number of grants is at fault, not one of them
      throw e instanceof RemovalFull ? rule(KEEP_TOO_LARGE) : e
    }
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
    // The access is gone and the loop below writes only tasks, follows,
    // messages and activity, so one preload serves every task update. The
    // followers hear from background steps (NotifyPreload.deferFollowers).
    const preload = newNotifyPreload(orgProjects)
    const bulk = {
      preload: { ...preload, guard: full, deferFollowers: true as const },
      checked: new Set<string>(),
    }
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
    people: await withinRoom(() => peopleOf(ctx, subject)),
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

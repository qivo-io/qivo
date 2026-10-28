/* What an access removal would do, worked out on the server without writing
 * anything: who would lose sight of open tasks they are assigned to or
 * reviewing, which of those tasks the caller may read, and whether the
 * caller could keep those people as Viewers or reassign their tasks. The
 * app's removal window asks it (accessRemovals.preview) before it removes a
 * person's or a team's project access, a member from a team or a whole team.
 *
 * It runs the write's own checks in the write's order, with their sentences
 * (model/projectAccess.ts removeProjectGrantCore, model/teams.ts
 * removeTeamMemberCore and deleteTeamCore), and the write's own reads
 * (model/projectAccess.ts findLost). Where the write deletes the rows and
 * reads sight again, the preview leaves those rows out of the same reads
 * (lib/access.ts RemovedAccess), so the two agree on who loses sight of
 * which tasks and, but for the checks of a new holder of reassigned tasks
 * (RemovalEffect), on the rules each choice meets. Each write's other
 * changes decide no one's sight: a grant's or share's reach rows
 * (model/projectNav.ts), a membership's team count
 * (model/teamCounts.ts), and for a deleted team also its reach rows, its
 * count and the legacy team_id it clears on projects (model/cascade.ts
 * deleteTeamDeep). Levels come only from grants, shares, memberships, the
 * team rows and the projects' tree and leads (lib/access.ts levelsFrom).
 *
 * The room each uses in its one transaction can differ, both ways. The
 * preview also reads the caller's sight and whether the caller manages each
 * Keep target, so it can answer too_large where a 'leave' write of the same
 * grant or member removal goes through, and a team deletion with 'leave'
 * reads no tasks at all (model/teams.ts deleteTeamCore). Keeping people as
 * Viewers or reassigning their tasks spends room on what the write writes,
 * for a team deletion also on deleting its shares, reach rows and
 * memberships before it reads sight again, none of which the preview does,
 * so near the limit such a write can refuse with REMOVAL_FULL,
 * KEEP_TOO_LARGE or reassignTooLarge where the preview allowed the choice.
 *
 * Reading tasks needs ordinary access to their project, so the caller gets
 * the number, title and holder of a lost task only in a project they can
 * see, and only a count of the others. */

import { ConvexError, getConvexSize, type Infer, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import {
  levelRank,
  type OrgProjectLevels,
  projectLevelsForPeople,
  type RemovedAccess,
} from '../lib/access'
import { orgWriteBlock } from '../lib/billingAccess'
import { byId } from '../lib/db'
import type { Refusal } from '../lib/functions'
import { LIMITS } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { NO_WRITE_ACCESS } from './issues'
import {
  type AccessSubject,
  assertManagesAccess,
  assertNotLead,
  assertRoom,
  canKeepAsViewers,
  findLost,
  grantKeepRefusal,
  grantOf,
  type Lost,
  NO_USER_MANAGEMENT,
  peopleOf,
  REMOVAL_FULL,
  reachedProjects,
  reassignTooLarge,
  withinRoom,
} from './projectAccess'
import {
  assertDeletesTeam,
  assertManagesMembers,
  assertTeamFits,
  membershipOf,
  teamReach,
  viewerProjectFor,
} from './teams'

/** The access a removal takes away, the app's AccessRemoval
 * (src/store/planner.ts) in the server's snake case: a person's or a team's
 * grant on a project (projects.removeAccess), a member leaving a team
 * (teams.removeMember), or a team being deleted (teams.deleteDeep). */
export const vRemovalChange = v.union(
  v.object({ kind: v.literal('user_grant'), project_id: v.string(), user_id: v.string() }),
  v.object({ kind: v.literal('team_grant'), project_id: v.string(), team_id: v.string() }),
  v.object({ kind: v.literal('team_member'), team_id: v.string(), user_id: v.string() }),
  v.object({ kind: v.literal('delete_team'), team_id: v.string() }),
)

export type RemovalChange = Infer<typeof vRemovalChange>

/** The bounds of one answer. `items`: of how many held tasks the caller
 * may read the preview lists the holdings, by task number; 100 fill the
 * removal window's scroll box several times over.
 * `changerProjects`: how many of the projects one person can still change
 * it names, as many as the window's Keep text names before it counts the
 * rest. `bytes`: the most one answer holds, as Convex sizes a value
 * (getConvexSize). 1 MiB is many times what the window shows, and an
 * answer past Convex's own limit would fail instead of answering, so a
 * larger one answers too_large. Tests change them. */
export const PREVIEW = { items: 100, changerProjects: 3, bytes: 1024 * 1024 }

/* Convex's limit on the elements of one array in a value. */
const ARRAY_MAX = 8192

/** A project as the preview names it. */
export type ProjectRef = { id: string; name: string; key: string; parent_id: string | null }

/** What the removal would do. `people` lose sight of at least one open task
 * they hold, and `tasks` counts those tasks once each. A holding is one
 * person's role on one such task, so a task can have two. `items` lists the
 * holdings of the first PREVIEW.items such tasks in projects the caller can
 * see, by task number, never only some of one task's holdings;
 * `items_total` counts every holding the caller can see, and `hidden` the
 * tasks in projects the caller cannot see. `keep` and `reassign` say
 * whether the removal window's two choices would pass the write's rules,
 * and with which sentence the write would refuse them. `reassign` covers
 * the rules that do not depend on who takes the tasks, so it answers for a
 * new holder who passes the write's own checks of them once the access is
 * gone (model/projectAccess.ts assertCanTakeOver, then the task update's
 * holder rules). The write checks the new holder first, so for one who
 * fails them it refuses with that holder's sentence instead, marked
 * HELD_TASKS_REFUSED; the window offers only new holders who pass. The
 * preview leaves the new holder out because those checks read their access
 * as it is before the removal, which may be one of its people.
 * `keep.targets` are the projects Keep as Viewer would grant
 * Viewer on, and `keep.changers` name, for each person who can still change
 * a listed project or one of its sub-projects once the access is gone, the
 * first PREVIEW.changerProjects such projects and how many more there are
 * (`more`), for the window's Keep text. Both give project ids, and
 * `projects` names each project they give once. Both leave out a project
 * the caller neither sees nor manages as an organization admin, whose name
 * the caller does not know; the caller then cannot keep anyone as Viewer
 * there, so Keep as Viewer is refused. */
export type RemovalEffect = {
  pending: boolean
  leave_only: boolean
  people: {
    id: string
    name: string
    kind: Doc<'profiles'>['kind']
    org_role: Doc<'profiles'>['org_role']
  }[]
  tasks: number
  items: {
    task_id: string
    num: number
    title: string
    project_id: string
    holder_id: string
    role: Lost['role']
  }[]
  items_total: number
  hidden: number
  projects: ProjectRef[]
  keep: {
    targets: string[]
    changers: { id: string; projects: string[]; more: number }[]
    allowed: boolean
    refusal: string | null
  }
  reassign: { allowed: boolean; refusal: string | null }
}

/** The preview's answer. `unavailable`: the project or team, or a grant's
 * person, is not one of the organization's; a member removal looks for the
 * membership only, so one of someone without a membership answers `ok` with
 * `pending: false`, as the write removes nothing. `refused`: the write
 * would refuse the removal itself, with its sentence. `too_large`: working
 * out who loses sight would not fit in one request, or the answer would
 * pass PREVIEW.bytes or hold a list longer than Convex allows
 * (REMOVAL_FULL). */
export type RemovalPreview =
  | { state: 'unavailable' }
  | { state: 'refused'; message: string }
  | { state: 'too_large'; message: string }
  | ({ state: 'ok' } & RemovalEffect)

/* What the write removes and what it reads to settle the held tasks, for a
 * removal that has something to remove. */
type Plan = {
  people: ReadonlyMap<string, Doc<'profiles'>>
  projects: readonly Doc<'projects'>[]
  viewerOn: (project: Doc<'projects'>) => Promise<Doc<'projects'>>
  keepRefusal?: string
  without: RemovedAccess
}

/* The organization's project, team or person with this id, null for an
 * unknown or foreign one, which projects.ts myProject and accessSubject and
 * teams.ts myTeam refuse as not found. */
async function ownRow<T extends 'projects' | 'teams' | 'profiles'>(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  table: T,
  id: string,
): Promise<Doc<T> | null> {
  const row = await byId(ctx, table, id)
  return row !== null && row.org_id === me.org_id ? row : null
}

/* The checks of the write `change` names, in its order, and what it would
 * remove: 'unavailable' for a project, team or grant's person that is not
 * the organization's, null when there is nothing to remove. A refusal
 * throws the write's own error. */
async function planOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  change: RemovalChange,
): Promise<Plan | null | 'unavailable'> {
  if (change.kind === 'user_grant' || change.kind === 'team_grant') {
    // projects.removeAccess: the project, then the person or team
    const project = await ownRow(ctx, me, 'projects', change.project_id)
    if (project === null) return 'unavailable'
    let subject: AccessSubject
    if (change.kind === 'user_grant') {
      const profile = await ownRow(ctx, me, 'profiles', change.user_id)
      if (profile === null) return 'unavailable'
      subject = { profile }
    } else {
      const team = await ownRow(ctx, me, 'teams', change.team_id)
      if (team === null) return 'unavailable'
      subject = { team }
    }
    // removeProjectGrantCore
    await assertManagesAccess(ctx, me, project, subject)
    await assertNotLead(ctx, project, subject)
    const row = await grantOf(ctx, project, subject)
    if (row === null) return null
    return {
      people: await withinRoom(() => peopleOf(ctx, subject)),
      projects: await reachedProjects(ctx, project),
      viewerOn: async () => project,
      keepRefusal: grantKeepRefusal(subject, row),
      without: 'team_id' in row ? { share: row._id } : { grant: row._id },
    }
  }
  const team = await ownRow(ctx, me, 'teams', change.team_id)
  if (team === null) return 'unavailable'
  if (change.kind === 'team_member') {
    // removeTeamMemberCore, which looks the person up only after the
    // membership
    await assertManagesMembers(ctx, me, team)
    const row = await membershipOf(ctx, team.id, change.user_id)
    if (row === null) return null
    const member = await byId(ctx, 'profiles', change.user_id)
    const people = new Map<string, Doc<'profiles'>>()
    if (member !== null && member.org_id === team.org_id) people.set(member.id, member)
    const reach = await withinRoom(() => teamReach(ctx, team))
    return {
      people,
      projects: reach.projects,
      viewerOn: (project) => viewerProjectFor(ctx, reach.shared, project),
      without: { membership: { team_id: team.id, profile_id: row.profile_id } },
    }
  }
  // deleteTeamCore, whose deletion takes every share and membership of the
  // team with it and nothing else that decides sight (see above)
  await assertDeletesTeam(ctx, me, team)
  await assertTeamFits(ctx, team)
  const reach = await withinRoom(() => teamReach(ctx, team))
  return {
    people: await withinRoom(() => peopleOf(ctx, { team })),
    projects: reach.projects,
    viewerOn: (project) => viewerProjectFor(ctx, reach.shared, project),
    without: { team: team.id },
  }
}

/* The preview's answer for a refusal the write's own checks or reads threw,
 * or null for anything else. */
function answerOf(e: unknown): RemovalPreview | null {
  if (!(e instanceof ConvexError)) return null
  const { code, message } = e.data as Refusal
  if (code === 'not_found') return { state: 'unavailable' }
  if (message === REMOVAL_FULL) return { state: 'too_large', message }
  if (code === 'forbidden' || code === 'rule') return { state: 'refused', message }
  return null
}

const projectRef = (p: Doc<'projects'>): ProjectRef => ({
  id: p.id,
  name: p.name,
  key: p.key,
  parent_id: p.parent_id ?? null,
})

/* Whether `effect` fits in one answer: no list past ARRAY_MAX, and the
 * whole within PREVIEW.bytes. A changer names at most
 * PREVIEW.changerProjects projects. */
function fits(effect: RemovalEffect): boolean {
  const { people, items, projects, keep } = effect
  return (
    [people, items, projects, keep.targets, keep.changers].every((l) => l.length <= ARRAY_MAX) &&
    getConvexSize(effect) <= PREVIEW.bytes
  )
}

/* Projects in the app's stored order. */
const bySortOrder = (a: Doc<'projects'>, b: Doc<'projects'>) =>
  a.sort_order - b.sort_order || a.id.localeCompare(b.id)

/**
 * What removing `change` would do, worked out by `me` without writing, as
 * accessRemovals.preview answers it (see there). The read-only block comes
 * first, as the wrappers check it before the write reads anything: a team
 * deletion is an orgMutation and the other removals accessRemovalMutations
 * (lib/functions.ts), which let an organization admin leave the tasks only.
 */
export async function previewRemoval(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  change: RemovalChange,
): Promise<RemovalPreview> {
  const block = await orgWriteBlock(ctx, me.org_id)
  if (block !== null && (change.kind === 'delete_team' || me.org_role !== 'admin'))
    return { state: 'refused', message: block.message }
  const readOnly = block?.message ?? null
  try {
    const plan = await planOf(ctx, me, change)
    if (plan === 'unavailable') return { state: 'unavailable' }
    if (plan === null) return { state: 'ok', ...nothing(readOnly) }
    const effect = await withinRoom(() => effectOf(ctx, me, plan, readOnly))
    // an answer too large to send says so, as one too large to work out does
    if (!fits(effect)) return { state: 'too_large', message: REMOVAL_FULL }
    return { state: 'ok', ...effect }
  } catch (e) {
    const answer = answerOf(e)
    if (answer === null) throw e
    return answer
  }
}

/* The effect of a removal with nothing to remove: someone else removed the
 * access first. Either choice then removes nothing, unless `readOnly`, the
 * read-only block's sentence, refuses it. */
function nothing(readOnly: string | null): RemovalEffect {
  const settles = { allowed: readOnly === null, refusal: readOnly }
  return {
    pending: false,
    leave_only: readOnly !== null,
    people: [],
    tasks: 0,
    items: [],
    items_total: 0,
    hidden: 0,
    projects: [],
    keep: { targets: [], changers: [], ...settles },
    reassign: settles,
  }
}

/* The effect of `plan`. `readOnly`, the read-only block's sentence, refuses
 * both choices. It checks the room before each read of its own, so call it
 * within withinRoom. */
async function effectOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  plan: Plan,
  readOnly: string | null,
): Promise<RemovalEffect> {
  // what a 'leave' write of a grant or member removal reads to find who
  // loses sight; it settles nothing
  const found = await findLost(ctx, {
    projects: plan.projects,
    people: plan.people,
    held: 'leave',
    after: { without: plan.without },
  })
  const { lost } = found
  const capped = found.holders > LIMITS.removalHolders.max

  // The caller's sight now, for what they may read, and after, for what they
  // may still edit, read only when someone loses sight of a task. The
  // removal takes access from the caller only when they are one of its
  // people.
  const sightOfMe = async (without?: RemovedAccess) =>
    (
      await projectLevelsForPeople(ctx, [me], found.orgProjects, () => assertRoom(ctx), without)
    ).get(me.id)
  let now: OrgProjectLevels | undefined
  let later: OrgProjectLevels | undefined
  if (lost.length > 0) {
    now = found.before.get(me.id) ?? (await sightOfMe())
    later = found.after.get(me.id) ?? (plan.people.has(me.id) ? await sightOfMe(plan.without) : now)
  }
  const sees = (p: Doc<'projects'>) => (now?.levelOf(p) ?? null) !== null
  // a project the caller may know the name of: one they see, or any for an
  // organization admin (Settings > Projects)
  const known = (p: Doc<'projects'>) => me.org_role === 'admin' || sees(p)

  const readable = lost
    .filter((h) => sees(h.project))
    .sort(
      (a, b) =>
        a.task.num - b.task.num ||
        a.role.localeCompare(b.role) ||
        a.profile_id.localeCompare(b.profile_id),
    )
  // the holdings of the first PREVIEW.items tasks, each task's together
  const rows: Lost[] = []
  const rowTasks = new Set<string>()
  for (const h of readable) {
    if (!rowTasks.has(h.task.id) && rowTasks.size === PREVIEW.items) break
    rowTasks.add(h.task.id)
    rows.push(h)
  }
  const people = [...new Set(lost.map((h) => h.profile_id))]
    .flatMap((id) => plan.people.get(id) ?? [])
    .map((p) => ({ p, key: p.name_key ?? nameKey(p.name) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.p.id.localeCompare(b.p.id)))
    .map(({ p }) => p)

  // Keep as Viewer: the project each lost task's Viewer grant would go to
  const targetOf = new Map<string, Doc<'projects'>>()
  for (const h of lost) {
    if (targetOf.has(h.project.id)) continue
    await assertRoom(ctx)
    targetOf.set(h.project.id, await plan.viewerOn(h.project))
  }
  const targets = [...new Map([...targetOf.values()].map((p) => [p.id, p])).values()]
  const canKeep =
    lost.length === 0 ||
    (await canKeepAsViewers(
      ctx,
      {
        me,
        viewerOn: async (project) => {
          // before it reads whether the caller manages the project
          await assertRoom(ctx)
          return targetOf.get(project.id) ?? (await plan.viewerOn(project))
        },
        keepRefusal: plan.keepRefusal,
      },
      lost,
    ))
  const keepAllowed = readOnly === null && !capped && canKeep
  // what each person can still change in the listed projects and their
  // sub-projects once the access is gone, for the window's Keep text
  // (src/store/planner.ts keepText)
  const listed = targets.filter(known).sort(bySortOrder)
  const listedIds = new Set(listed.map((p) => p.id))
  const shown = found.orgProjects
    .filter(
      (p) =>
        p.archived_at === undefined &&
        (listedIds.has(p.id) || (p.parent_id !== undefined && listedIds.has(p.parent_id))) &&
        known(p),
    )
    .sort(bySortOrder)
  // each project the answer names, once
  const named = new Map(listed.map((p) => [p.id, p]))
  const changers = people.flatMap((person) => {
    const levels = found.after.get(person.id)
    const changes = shown.filter((p) => {
      const level = levels?.levelOf(p) ?? null
      return level === 'user' || level === 'lead'
    })
    if (changes.length === 0) return []
    const first = changes.slice(0, PREVIEW.changerProjects)
    for (const p of first) named.set(p.id, p)
    return [
      { id: person.id, projects: first.map((p) => p.id), more: changes.length - first.length },
    ]
  })

  // Reassign: the caller needs Edit on every lost task's project once the
  // access is gone (model/issues.ts assertCanEdit), checked after the count
  // and, in the write, after the new holder's own checks (see RemovalEffect)
  const tasks = new Set(lost.map((h) => h.task.id)).size
  const edits = lost.every((h) => levelRank(later?.levelOf(h.project) ?? null) >= levelRank('user'))
  const reassignRefusal =
    readOnly ??
    (capped
      ? LIMITS.removalHolders.refusal
      : tasks > LIMITS.reassign.max
        ? reassignTooLarge(keepAllowed)
        : edits
          ? null
          : NO_WRITE_ACCESS)

  return {
    pending: true,
    leave_only: readOnly !== null,
    people: people.map((p) => ({ id: p.id, name: p.name, kind: p.kind, org_role: p.org_role })),
    tasks,
    items: rows.map((h) => ({
      task_id: h.task.id,
      num: h.task.num,
      title: h.task.title,
      project_id: h.project.id,
      holder_id: h.profile_id,
      role: h.role,
    })),
    items_total: readable.length,
    hidden: new Set(lost.filter((h) => !sees(h.project)).map((h) => h.task.id)).size,
    projects: [...named.values()].sort(bySortOrder).map(projectRef),
    keep: {
      targets: listed.map((p) => p.id),
      changers,
      allowed: keepAllowed,
      refusal: keepAllowed
        ? null
        : (readOnly ??
          (capped ? LIMITS.removalHolders.refusal : (plan.keepRefusal ?? NO_USER_MANAGEMENT))),
    },
    reassign: { allowed: reassignRefusal === null, refusal: reassignRefusal },
  }
}

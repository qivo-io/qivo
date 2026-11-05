/* What an access removal would do, worked out on the server without writing
 * anything: who would lose sight of open tasks they are assigned to or
 * reviewing, which of those tasks the caller may read, and whether the
 * caller could keep those people as Viewers or reassign their tasks. The
 * app's removal window asks it (accessRemovals.preview) when a removal is
 * pressed and again before it saves, for a person's or a team's project
 * access, a member leaving a team or a whole team, and its Reassign picker
 * lists who could take the tasks from the same reads
 * (accessRemovals.reassignChoices, reassignChoicesOf).
 *
 * It runs the write's own checks in the write's order, with their sentences
 * (model/projectAccess.ts removeProjectGrantCore, model/teams.ts
 * removeTeamMemberCore and deleteTeamCore), and the write's own reads
 * (model/projectAccess.ts findLost). Where the write deletes the rows and
 * reads sight again, the preview leaves those rows out of the same reads
 * (lib/access.ts RemovedAccess), so the two agree on who loses sight of
 * which tasks and on the rules each choice meets. A new holder of
 * reassigned tasks is checked the same way, with the removed rows left out
 * (takerRule). Each write's other changes decide no one's sight: a grant's
 * or share's reach rows (model/projectNav.ts), a membership's team count
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
  canHoldWork,
  levelRank,
  NO_USER_MANAGEMENT,
  type OrgProjectLevels,
  projectLevelReads,
  projectLevelsForPeople,
  projectLevelsForProfiles,
  type RemovedAccess,
} from '../lib/access'
import { orgWriteBlock } from '../lib/billingAccess'
import { byId } from '../lib/db'
import type { AccessLevel } from '../lib/enums'
import type { Refusal } from '../lib/functions'
import { LIMITS, LIST_BATCH } from '../lib/limits'
import { indexAfter, type ListBatch, listBatch, mergeNamed, namedCeiling } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { allWordsMatcher } from '../lib/search'
import { ancestorsFrom, NO_WRITE_ACCESS } from './issues'
import { nameKeysReady, profileRoleIndex } from './nameKeys'
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
  peopleOf,
  REMOVAL_FULL,
  reachedProjects,
  reassignTooLarge,
  withinRoom,
} from './projectAccess'
import { listAsk, type PersonRow, personRow } from './projectSettings'
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

/** The bounds of one answer. `items`: for how many held tasks the caller
 * may read the preview lists their holdings, by task number. It is
 * LIMITS.reassign.max, the most tasks one reassignment hands over, so the
 * removal window lists every task Reassign changes and a choice applies
 * only to tasks the person read; past it Reassign is refused anyway, and
 * the window counts the rest. `changerProjects`: how many of the projects
 * one person can still change it names, as many as the window's Keep text
 * names before it counts the rest. `bytes`: the most one answer holds, as
 * Convex sizes a value (getConvexSize). 1 MiB is many times what the window
 * shows, and an answer past Convex's own limit would fail instead of
 * answering, so a larger one answers too_large. Tests change them. */
export const PREVIEW: { items: number; changerProjects: number; bytes: number } = {
  items: LIMITS.reassign.max,
  changerProjects: 3,
  bytes: 1024 * 1024,
}

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
 * and with which sentence the write would refuse them.
 *
 * `keep.offered` is false only for a person's removed Viewer grant, which
 * cannot be kept as Viewer (model/projectAccess.ts grantKeepRefusal), and
 * `keep.permitted` says whether the caller manages the users of every
 * project Keep as Viewer would grant Viewer on. `reassign.permitted` says
 * whether the caller can still edit every lost task's project once the
 * access is gone (model/issues.ts assertCanEdit). Both answer the caller's
 * authority whatever the size or the read-only block, which a `refusal`
 * names first, so the window can tell a removal the caller may settle
 * from one they may not (src/store/planner.ts startRemoval).
 *
 * `reassign` covers the rules that do not depend on who takes the tasks, so
 * it answers for a new holder who passes the write's own checks of them
 * once the access is gone (model/projectAccess.ts assertCanTakeOver, then
 * the task update's holder rules). The write checks a new holder's standing
 * on each task's project (assertCanTakeOver) before the caller's Edit
 * access, so a new holder who fails that is refused with their own
 * sentence, marked HELD_TASKS_REFUSED. It checks whether the new holder can
 * see a subtask's parent only after the caller's Edit access
 * (updateIssueCore), so where the caller loses Edit the write refuses with
 * the caller's sentence first. Those checks read the new holder's access as
 * it is before the removal, so the preview reads it with the removed rows
 * left out instead (takerRule): asked with `reassign_to`, it answers
 * `reassign.holder_eligible`, whether that person could take every task
 * once the access is gone, false while Reassign itself is refused. The
 * Reassign picker lists the people that rule lets take them
 * (reassignChoicesOf).
 *
 * `keep.targets` are the projects Keep as Viewer would grant Viewer on, and
 * `keep.changers` name, for each person who can still change a listed
 * project or one of its sub-projects once the access is gone, the first
 * PREVIEW.changerProjects such projects and how many more there are
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
    offered: boolean
    permitted: boolean
  }
  reassign: {
    allowed: boolean
    refusal: string | null
    permitted: boolean
    holder_eligible?: boolean
  }
}

/** The answers the preview and the Reassign picker give alike for a removal
 * they cannot go on with. `unavailable`: the project or team, or a grant's
 * person, is not one of the organization's; a member removal looks for the
 * membership only, so one of someone without a membership answers as a
 * removal with nothing to remove, as the write removes nothing.
 * `refused`: the write would refuse the removal itself, with its sentence.
 * `too_large`: working out who loses sight would not fit in one request,
 * or the answer would pass PREVIEW.bytes or hold a list longer than Convex
 * allows (REMOVAL_FULL). */
export type Unanswered =
  | { state: 'unavailable' }
  | { state: 'refused'; message: string }
  | { state: 'too_large'; message: string }

/** The preview's answer: one of Unanswered, or `ok` with the effect, whose
 * `pending` is false when there is nothing left to remove. */
export type RemovalPreview = Unanswered | ({ state: 'ok' } & RemovalEffect)

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

/* The answer for a refusal the write's own checks or reads threw, or null
 * for anything else. */
function answerOf(e: unknown): Unanswered | null {
  if (!(e instanceof ConvexError)) return null
  const { code, message } = e.data as Refusal
  if (code === 'not_found') return { state: 'unavailable' }
  if (message === REMOVAL_FULL) return { state: 'too_large', message }
  if (code === 'forbidden' || code === 'rule') return { state: 'refused', message }
  return null
}

/* What `step` answers, or the answer for a refusal it threw (answerOf). */
async function answering<T>(step: () => Promise<T>): Promise<T | Unanswered> {
  try {
    return await step()
  } catch (e) {
    const answer = answerOf(e)
    if (answer === null) throw e
    return answer
  }
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

/* A removal read as the preview answers it, with what a check of a new
 * holder reads further: the holdings the write would settle, the rows it
 * takes away and the organization's projects findLost read. */
type Taken = {
  state: 'taken'
  effect: RemovalEffect
  lost: readonly Lost[]
  without: RemovedAccess
  orgProjects: readonly Doc<'projects'>[]
}

/* The preview's reads of removing `change`, as `me`, and the effect they
 * give, or the answer for a removal it cannot go on with. The read-only
 * block comes first, as the wrappers check it before the write reads
 * anything: a team deletion is an orgMutation and the other removals
 * accessRemovalMutations (lib/functions.ts), which let an organization
 * admin leave the tasks only. A refusal of the write's own checks throws;
 * run it inside answering. */
async function removalOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  change: RemovalChange,
): Promise<Unanswered | Taken> {
  const block = await orgWriteBlock(ctx, me.org_id)
  if (block !== null && (change.kind === 'delete_team' || me.org_role !== 'admin'))
    return { state: 'refused', message: block.message }
  const readOnly = block?.message ?? null
  const plan = await planOf(ctx, me, change)
  if (plan === 'unavailable') return { state: 'unavailable' }
  if (plan === null)
    return { state: 'taken', effect: nothing(readOnly), lost: [], without: {}, orgProjects: [] }
  const read = await withinRoom(() => effectOf(ctx, me, plan, readOnly))
  // an answer too large to send says so, as one too large to work out does
  if (!fits(read.effect)) return { state: 'too_large', message: REMOVAL_FULL }
  return { state: 'taken', ...read, without: plan.without }
}

/**
 * What removing `change` would do, worked out by `me` without writing, as
 * accessRemovals.preview answers it (see there). With `reassignTo`, the
 * answer also says whether that person could take every task the removal
 * takes out of sight once the access is gone (reassign.holder_eligible,
 * takerRule), false for an unknown or foreign id and while Reassign is
 * refused. That check reads the levels of the lost tasks' projects and of
 * the projects of the tasks above them, in the same room as the rest.
 */
export async function previewRemoval(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  change: RemovalChange,
  reassignTo?: string,
): Promise<RemovalPreview> {
  return await answering(async (): Promise<RemovalPreview> => {
    const taken = await removalOf(ctx, me, change)
    if (taken.state !== 'taken') return taken
    const { effect } = taken
    if (reassignTo === undefined) return { state: 'ok', ...effect }
    let eligible = false
    if (effect.reassign.allowed) {
      const person = await byId(ctx, 'profiles', reassignTo)
      if (person !== null && person.org_id === me.org_id)
        eligible = (await withinRoom(() => takerRule(ctx, me, taken)))(person)
    }
    return { state: 'ok', ...effect, reassign: { ...effect.reassign, holder_eligible: eligible } }
  })
}

/* The effect of a removal with nothing to remove: someone else removed the
 * access first. Either choice then removes nothing, unless `readOnly`, the
 * read-only block's sentence, refuses it. The caller's authority over
 * nothing is not in question, so both choices are offered and permitted. */
function nothing(readOnly: string | null): RemovalEffect {
  const settles = { allowed: readOnly === null, refusal: readOnly, permitted: true }
  return {
    pending: false,
    leave_only: readOnly !== null,
    people: [],
    tasks: 0,
    items: [],
    items_total: 0,
    hidden: 0,
    projects: [],
    keep: { targets: [], changers: [], ...settles, offered: true },
    reassign: settles,
  }
}

/* The effect of `plan`, with the holdings it found and the organization's
 * projects findLost read. `readOnly`, the read-only block's sentence,
 * refuses both choices. It checks the room before each read of its own, so
 * call it within withinRoom. */
async function effectOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  plan: Plan,
  readOnly: string | null,
): Promise<{ effect: RemovalEffect; lost: Lost[]; orgProjects: Doc<'projects'>[] }> {
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
  // whether the caller manages the users of every target, the check
  // canKeepAsViewers makes after the removal's own keepRefusal, asked
  // without it so a removed Viewer grant still answers the caller's
  // authority
  const permitted =
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
      },
      lost,
    ))
  const canKeep = lost.length === 0 || (plan.keepRefusal === undefined && permitted)
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
  // and, in the write, after the new holder's own checks (see RemovalEffect).
  // The Reassign picker refuses with this sentence too (reassignChoicesOf).
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

  const effect: RemovalEffect = {
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
      offered: plan.keepRefusal === undefined,
      permitted,
    },
    reassign: { allowed: reassignRefusal === null, refusal: reassignRefusal, permitted: edits },
  }
  return { effect, lost, orgProjects: found.orgProjects }
}

/**
 * Whether a person could take every task `taken` takes out of its holders'
 * sight, once the access is gone: the rule of the write's handover, read
 * with the removed rows left out. They can hold work (lib/access.ts
 * canHoldWork: an active admin, user or guest of the caller's
 * organization, an agent with the user role included), are not one of the
 * people who lose sight of those tasks (row 329 of the design
 * specification; the level rule below leaves them out anyway, since each
 * lost sight of a listed task's project), hold User or Lead on every lost
 * task's project (model/projectAccess.ts assertCanTakeOver, model/issues.ts
 * assertAssigneeRule), and hold a level on the project of every task above
 * a lost subtask (the chain check of model/issues.ts updateIssueCore,
 * ASSIGNEE_SIGHT_RULE and REVIEWER_SIGHT_RULE). A subtask may sit in
 * another sub-project of its parent's top-level project, so the second
 * check can leave out someone the first lets in, and it answers about a
 * project the caller may not see, which the write's refusal answers for
 * one chosen person too.
 *
 * It reads the tasks above each lost subtask (model/issues.ts
 * ancestorsFrom) and, once for each of those projects and each lost task's
 * project, every profile's level from the project's side
 * (lib/access.ts projectLevelsForProfiles with the removal's rows left
 * out), sharing the reads of a top-level project and of a team between
 * them, then answers each person without a read. Levels come only from
 * levelsFrom, so an organization admin can take every task while it gives
 * them Lead, and follows ordinary access after the admin access split. It
 * checks the room before each read, so call it within withinRoom. With
 * nothing lost it lets in everyone who can hold work, as the write then
 * checks no new holder.
 */
async function takerRule(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  taken: Taken,
): Promise<(profile: Doc<'profiles'>) => boolean> {
  const { lost, without } = taken
  const losing = new Set(taken.effect.people.map((p) => p.id))
  const projects = new Map(taken.orgProjects.map((p) => [p.id, p]))
  const guard = () => assertRoom(ctx)
  // the projects whose Edit the write asks of a new holder, and those whose
  // sight its chain check asks
  const edit = new Map(lost.map((h) => [h.project.id, h.project]))
  const sight = new Set<string>()
  const parents = new Set<string>()
  for (const h of lost) {
    const parent = h.task.parent_id
    if (parent === undefined || parents.has(parent)) continue
    parents.add(parent)
    for (const above of await ancestorsFrom(ctx, parent, guard)) sight.add(above.project_id)
  }
  const reads = projectLevelReads()
  const levels = new Map<string, (profile: Doc<'profiles'>) => AccessLevel | null>()
  for (const id of new Set([...edit.keys(), ...sight])) {
    const project = edit.get(id) ?? projects.get(id)
    // a task above whose project is gone: the chain check lets nobody in
    levels.set(
      id,
      project === undefined
        ? () => null
        : await projectLevelsForProfiles(ctx, project, { without, guard, reads }),
    )
  }
  const levelOn = (id: string, profile: Doc<'profiles'>) => levels.get(id)?.(profile) ?? null
  return (profile) =>
    profile.org_id === me.org_id &&
    canHoldWork(profile) &&
    !losing.has(profile.id) &&
    [...edit.keys()].every((id) => levelRank(levelOn(id, profile)) >= levelRank('user')) &&
    [...sight].every((id) => levelOn(id, profile) !== null)
}

/** What the Reassign picker answers: one of Unanswered as the preview
 * answers it, `refused` with Reassign's own sentence while Reassign is
 * refused, `not_ready` until the organization's people hold their name
 * keys, or one batch of people in name order. */
export type ReassignChoices =
  | Unanswered
  | { state: 'not_ready' }
  | ({ state: 'ready' } & ListBatch<PersonRow>)

/** What the Reassign picker is asked for: the removal, a search, and the
 * cursor of the batch's start. */
export type ReassignArgs = { change: RemovalChange; search?: string; after?: string }

/* The roles that can hold work (lib/access.ts canHoldWork). */
const HOLDER_ROLES = ['admin', 'user', 'guest'] as const

/* The removal's kind and ids in a fixed order, which a picker cursor seals
 * beside the organization and the search. */
function changeScope(change: RemovalChange): string[] {
  switch (change.kind) {
    case 'user_grant':
      return [change.kind, change.project_id, change.user_id]
    case 'team_grant':
      return [change.kind, change.project_id, change.team_id]
    case 'team_member':
      return [change.kind, change.team_id, change.user_id]
    case 'delete_team':
      return [change.kind, change.team_id]
  }
}

/**
 * accessRemovals.reassignChoices for `me`: one batch of LIST_BATCH people
 * who could take every open task removing `a.change` takes out of its
 * holders' sight, once the access is gone (takerRule), in name order, with
 * a search. It works the removal out from the change itself on every
 * batch, never from tasks the app names. In order:
 *
 * 1. The arguments (model/projectSettings.ts listAsk): a search past
 *    LIMITS.search is refused with that limit's sentence, and a cursor
 *    that is not one of this list's for the same organization, removal and
 *    search with badRequest.
 * 2. The removal, read as the preview reads it (removalOf): the read-only
 *    block, the write's own checks in the write's order, then findLost,
 *    the caller's sight and the Keep checks. Its `unavailable`, `refused`
 *    and `too_large` answer as the preview's do.
 * 3. Reassign's refusal, as the preview answers it: the read-only block,
 *    LIMITS.removalHolders past 700 holders, reassignTooLarge past
 *    LIMITS.reassign.max tasks, or NO_WRITE_ACCESS for a caller without
 *    Edit on every lost task's project once the access is gone. It answers
 *    `refused` with that sentence and no row, so the list says nothing
 *    about a removal the caller cannot reassign.
 * 4. `not_ready` until the organization's rows hold their name keys
 *    (model/nameKeys.ts nameKeysReady), as the project settings pickers.
 * 5. The levels of takerRule, inside the room; past it `too_large`.
 * 6. The walk: the admins, users and guests of the organization merged in
 *    name order (model/nameKeys.ts profileRoleIndex) after the cursor,
 *    keeping each person takerRule lets in whose name holds every word of
 *    the search, ignoring case and accents, as a person row. It reads its
 *    own share of the request past steps 1 to 5 (lib/namedPages.ts
 *    namedCeiling, NAMED_READ), and a kept row reads nothing more, so a
 *    batch costs one document a person it passes. Past its share it stops
 *    and says so, never answering an end it did not reach.
 *
 * With nothing left to remove no task is lost and the write checks no new
 * holder, so the batch lists everyone who can hold work.
 *
 * Its reads are the preview's (accessRemovals.preview), the tasks above
 * the lost subtasks, a few index ranges for each of their projects and
 * the lost tasks' projects and each team that shares them, and the
 * profiles it walks. Measured with convex-test at the design size on 5
 * November 2026 (tests/reassignChoices.test.ts "inside Convex's limits"),
 * one figure at a time, a first batch read:
 * - a member of a 995-member team who holds two tasks leaving, in an
 *   organization of 1,000 people: 37 index ranges, 1,091 documents and
 *   219 KB, and a search for the last name, which walks every person,
 *   2,063 documents and 605 KB;
 * - the same with three people keeping Edit through their own grants
 *   beside the team's Viewer share: 35 ranges, 2,065 documents, 606 KB;
 * - the 995-member team's share removed, 29 members holding a task, and the
 *   team deleted: 100 ranges, 9,033 documents and 2.1 MB, the most of
 *   these, of which the preview's own reads are 8,034 documents;
 * - a member holding a task in each of 50 shared sub-projects, beside 150
 *   archived shares: 511 ranges, 2,501 documents, 978 KB;
 * - a grant removed from a sub-project shared with five teams: 38 ranges,
 *   193 documents, 54 KB;
 * - 800 open and 200 Done tasks in one project, one person holding 100:
 *   35 ranges, 1,036 documents, 474 KB;
 * - a project of 30 live and 40 archived sub-projects, the person holding
 *   one of the 3 open tasks in each live one: 143 ranges, 283 documents,
 *   112 KB;
 * - an organization of 2,000 projects, live and archived: 28 ranges, 2,083
 *   documents, 769 KB.
 * The app reads it once a batch and never subscribes, as it reads the
 * preview.
 */
export async function reassignChoicesOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: ReassignArgs,
): Promise<ReassignChoices> {
  const ask = await listAsk(
    'accessRemovals.reassignChoices',
    [me.org_id, ...changeScope(a.change)],
    {
      search: a.search,
      after: a.after,
    },
  )
  const gate = await answering(async () => {
    const taken = await removalOf(ctx, me, a.change)
    if (taken.state !== 'taken') return taken
    const refusal = taken.effect.reassign.refusal
    if (refusal !== null) return { state: 'refused' as const, message: refusal }
    if (!(await nameKeysReady(ctx, me.org_id))) return { state: 'not_ready' as const }
    return { state: 'walk' as const, canTake: await withinRoom(() => takerRule(ctx, me, taken)) }
  })
  if (gate.state !== 'walk') return gate
  const { canTake } = gate
  const streams = HOLDER_ROLES.map((role) =>
    indexAfter(profileRoleIndex(ctx, me.org_id, role), ask.after),
  )
  const matches = allWordsMatcher(nameKey(ask.search))
  const batch = await listBatch(ctx, ask, {
    stream: (reads) => mergeNamed(streams.map((stream) => stream(reads))),
    keep: async (profile: Doc<'profiles'>) =>
      canTake(profile) && matches(nameKey(profile.name)) ? personRow(profile) : null,
    limit: LIST_BATCH,
    ceiling: await namedCeiling(ctx),
  })
  return { state: 'ready', ...batch }
}

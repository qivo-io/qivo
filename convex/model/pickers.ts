/* The readers behind the people pickers of a task (pickers.ts): who could
 * become a task's assignee or reviewer (taskOwnersOf), whom Team sync's
 * Mention window may notify about it (syncRecipientsOf), and whether a few
 * named people could be chosen in one of those pickers now (canOwnOf).
 * The editor's @ mention popup reads the people who have access to its
 * task's project, behind the same gate (mentionsOf), and the view filter's
 * Assignee menu reads every person of the organization with no task, gate
 * or rule (orgPeopleOf), both without an email. The REST and MCP project
 * user list (lib/core.ts
 * projectUserPage) asks the owner rule's helpers for one project, without
 * a task, within the rule's share (withinRule).
 *
 * Each task picker runs one gate first (pickerTask): the task, its projects and the
 * caller's level, in that order, with the write's own sentences, before it
 * reads any person. An unknown task, one of another organization, a deleted
 * or archived one, one in an archived project or under an archived
 * top-level project, and one in a project the caller cannot see all answer
 * `unavailable` alike. A caller without Edit on the task's project is
 * `refused` with the write gate's sentence (model/issues.ts
 * NO_WRITE_ACCESS), which issues.update and comments.create both run first,
 * and a reviewer asked for a task with an active subtask is `refused` with
 * REVIEWER_ON_GROUP, after the Edit check. An organization whose billing
 * or deletion made it read-only is listed as any other, and the write
 * refuses the pick with the block's sentence.
 *
 * Each person is then judged by a rule worked out once from the project's
 * side (ownerRule, recipientRule) through the shared access helpers
 * (lib/access.ts canBeAssignedFor and canSeeProjectFor), so a batch reads
 * the access rows once and a person costs no read of their own. Levels
 * come only from levelsFrom, as the writes' per-person checks come from
 * levelUnder. Neither gives an organization admin a level of their own; the
 * role only caps an organization Viewer at Viewer and decides who receives
 * team shares. So an admin is offered and accepted only through their own
 * leads, grants and team shares, like anyone else, and an admin without
 * any is in none of the lists. tests/pickerParity.test.ts holds the
 * pickers to the writes over every access shape.
 *
 * The lists walk the organization's people in name order (lib/namedPages.ts
 * listBatch over model/nameKeys.ts indexes), keep each person the rule lets
 * in whose name holds every whitespace-separated word of the search,
 * ignoring case and accents, and answer PersonRow rows
 * (model/projectSettings.ts), never an email, a picture, a team, a level, a
 * task or a project. They answer `not_ready` until the organization's names
 * are keyed. The rule's reads keep to a share of their own (PICKERS.rule)
 * and answer `over_budget` with no row past it; the walk keeps to
 * NAMED_READ and answers `stopped` with a cursor past it, never an end it
 * did not reach.
 *
 * Nothing here reads a task's title, description, comments or files, and
 * nothing writes. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import {
  canBeAssignedFor,
  canManageOwnProjectAccess,
  canSeeProject,
  canSeeProjectFor,
  inMetaTree,
  keepsInbox,
  levelRank,
  type ProjectLevelReads,
  projectLevel,
  projectLevelReads,
} from '../lib/access'
import type { ReadCeiling } from '../lib/archivedTasks'
import { byId } from '../lib/db'
import { badRequest } from '../lib/functions'
import { BY_IDS_MAX, LIST_BATCH, MENTION_BATCH, MIB } from '../lib/limits'
import {
  indexAfter,
  type ListBatch,
  listBatch,
  mergeNamed,
  type NamedReads,
  type NamedStream,
  namedCeiling,
  type ReadGuard,
  readGuard,
} from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { allWordsMatcher, searchWords } from '../lib/search'
import { ancestorsFrom, hasSubtasks, NO_WRITE_ACCESS, REVIEWER_ON_GROUP } from './issues'
import { idTieOf, nameKeysReady, profileIndex, profileRoleIndex } from './nameKeys'
import { shownAvatarColor } from './people'
import {
  type ListArgs,
  type ListAsk,
  orderedListAsk,
  type PersonRow,
  personRow,
} from './projectSettings'

/* ------------------------------------------------------------ the bounds */

/**
 * What one call may read to work out its rule, past what the gate read,
 * counted from the rule's start with Convex's own transaction metrics: the
 * tasks above the task, their projects, every profile's levels on each
 * project and, for a top-level project, on each of its sub-projects, the
 * members of each team sharing them, and canOwn's lookups. Past it the
 * call answers `over_budget` with no row. With the gate's reads, NAMED_READ
 * for the walk and NAMED_RESERVE it stays under Convex's 4,096 index
 * ranges, 32,000 documents and 16 MiB. Tests lower it.
 *
 * The largest rules at the design size read the members of a team of 995
 * sharing the task's sub-project, or a top-level project of 30 live and 40
 * archived sub-projects whose navigation the rule reads
 * (tests/pickers.test.ts "the pickers inside Convex's limits" logs both),
 * and 1,000 ranges, 8,000 documents and 4 MiB hold each of those several
 * times over. Past the design size a rule that reads more fails closed
 * as `over_budget` rather than as Convex's own error.
 */
export const PICKERS: { rule: ReadCeiling } = {
  rule: { ranges: 1000, documents: 8000, bytes: 4 * MIB },
}

/* Thrown by the rule's guard once its share is used, and answered as
 * `over_budget`. */
class RuleFull extends Error {}

/** `step` with a guard for its access reads that throws RuleFull once
 * PICKERS.rule past what the request has read is used, and the ReadGuard
 * behind it, which canOwn's lookups count against. Answers null for
 * RuleFull. The REST and MCP project user list (lib/core.ts
 * projectUserPage) works out its rule within it too. The guard looks
 * before each block of access reads and before each lookup, not after the
 * last one, so the share can end one block over
 * (at most one block of profiles' reads, far inside Convex's limits beside
 * the budgets above). An answer whose last block finished is whole, so it
 * stays `ready` rather than turning into `over_budget` after the fact. */
export async function withinRule<T>(
  ctx: QueryCtx,
  step: (guard: () => Promise<void>, share: ReadGuard) => Promise<T>,
): Promise<T | null> {
  const share = readGuard(ctx, await namedCeiling(ctx, PICKERS.rule))
  const guard = async () => {
    if (!(await share.settle())) throw new RuleFull()
  }
  try {
    return await step(guard, share)
  } catch (e) {
    if (e instanceof RuleFull) return null
    throw e
  }
}

/* ----------------------------------------------------------- the answers */

/** The task field a list or check is for: the task's assignee or
 * reviewer, or Team sync's mention recipient. */
export type PickerField = 'assignee' | 'reviewer' | 'recipient'

/** The task fields the owner picker fills. */
export type OwnerField = Exclude<PickerField, 'recipient'>

/** What a people picker answers: `unavailable` alike for every task the
 * caller cannot pick for, `refused` with the write's sentence, `not_ready`
 * until the organization's names are keyed, `over_budget` when its rule
 * could not be worked out within PICKERS.rule, or one batch of people in
 * name order (lib/namedPages.ts ListBatch: rows, next, stopped). */
export type PeopleBatch =
  | { state: 'unavailable' }
  | { state: 'refused'; message: string }
  | { state: 'not_ready' }
  | { state: 'over_budget' }
  | ({ state: 'ready' } & ListBatch<PersonRow>)

/** One person canOwn was asked about: their row, null for an id the
 * organization does not hold, and whether they could be chosen now. */
export type OwnerCheck = { id: string; person: PersonRow | null; eligible: boolean }

/** What canOwn answers: the gate's states, `over_budget` as the lists
 * answer it, or a check for each distinct id asked, in the order asked. */
export type OwnerChecks =
  | { state: 'unavailable' }
  | { state: 'refused'; message: string }
  | { state: 'over_budget' }
  | { state: 'ready'; rows: OwnerCheck[] }

const UNAVAILABLE = { state: 'unavailable' } as const
const NOT_READY = { state: 'not_ready' } as const
const OVER_BUDGET = { state: 'over_budget' } as const
const refused = (message: string) => ({ state: 'refused' as const, message })

/* -------------------------------------------------------------- the gate */

/** The task a picker is for, as the gate found it: its project and its
 * top-level project, which is the project itself for a task stored on
 * one. */
type PickerTask = { task: Doc<'issues'>; project: Doc<'projects'>; top: Doc<'projects'> }

/* The gate of every picker here, before it reads any person:
 * 1. the task by id, `unavailable` when there is none or it is another
 *    organization's;
 * 2. its project and, for a sub-project, its top-level project by id,
 *    `unavailable` when either is missing, they are not a meta tree
 *    (lib/access.ts inMetaTree), or the task, its project or its top-level
 *    project is archived, the tasks no control offers an owner for
 *    (lib/workingSet.ts inWorkingSet, as lib/relationPicker.ts openedTask
 *    leaves them out); reading the top-level project first keeps
 *    projectLevel from throwing on a broken chain;
 * 3. the caller's level on the project, navigation included (projectLevel,
 *    the rule behind canSeeProject), `unavailable` when there is none, and
 *    `refused` with NO_WRITE_ACCESS, the write gate's sentence, when it is
 *    below User, a verdict navigation never changes since it only ever
 *    adds Viewer;
 * 4. for a reviewer, a task with an active subtask in a live project
 *    (model/issues.ts hasSubtasks) is `refused` with REVIEWER_ON_GROUP.
 * Its reads are the write's own: the task, two projects and the caller's
 * grants and team shares on both, about 25 index ranges with five teams on
 * each. For a task stored directly on a top-level project and a caller
 * without a level of their own there, projectLevel's navigation also reads
 * every sub-project, live and archived, until one gives a level, about 143
 * ranges at the design size's 30 live and 40 archived ones, unguarded, as
 * in the write. */
async function pickerTask(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  issueId: string,
  field: PickerField,
): Promise<{ state: 'unavailable' } | { state: 'refused'; message: string } | PickerTask> {
  const task = await byId(ctx, 'issues', issueId)
  if (task === null || task.org_id !== me.org_id) return UNAVAILABLE
  const project = await byId(ctx, 'projects', task.project_id)
  if (project === null) return UNAVAILABLE
  const top =
    project.parent_id === undefined ? project : await byId(ctx, 'projects', project.parent_id)
  if (top === null || !inMetaTree(project, top)) return UNAVAILABLE
  if ([task, project, top].some((row) => row.archived_at !== undefined)) return UNAVAILABLE
  const level = await projectLevel(ctx, me, project)
  if (level === null) return UNAVAILABLE
  if (levelRank(level) < levelRank('user')) return refused(NO_WRITE_ACCESS)
  if (field === 'reviewer' && (await hasSubtasks(ctx, task))) return refused(REVIEWER_ON_GROUP)
  return { task, project, top }
}

/* ------------------------------------------------------------- the rules */

/** Whether a profile passes a picker's rule, answered without a read. */
type Rule = (profile: Doc<'profiles'>) => boolean

/* Whether `id`'s project shows to each profile, or null when nobody can
 * see it, because the project is gone, or its parent is, or the parent is
 * not top-level, where the write's chain check refuses everyone
 * (model/issues.ts chainSight reads a missing project as unseen, and
 * rootMetaOf throws on a broken chain). */
async function sightOn(
  ctx: QueryCtx,
  id: string,
  o: { guard: () => Promise<void>; reads: ProjectLevelReads },
): Promise<Rule | null> {
  await o.guard()
  const project = await byId(ctx, 'projects', id)
  if (project === null) return null
  if (project.parent_id !== undefined) {
    await o.guard()
    const parent = await byId(ctx, 'projects', project.parent_id)
    if (parent === null || parent.parent_id !== undefined) return null
  }
  return await canSeeProjectFor(ctx, project, o)
}

/**
 * The write's rule for a new assignee or reviewer of the gate's task
 * (model/issues.ts updateIssueCore). It lets in someone who can hold work
 * with User or Lead on the task's project (assertAssigneeRule,
 * lib/access.ts canBeAssignedFor) who sees the project of every task above
 * it (ancestorsFrom and chainSight, canSeeProjectFor, navigation included).
 * The task's own project and, for a task in a sub-project, its top-level
 * project are not asked again, since User on the task's project shows
 * both, the second for navigation. A task above whose project, or whose
 * project's parent, is gone lets nobody in. A task above may sit in a
 * project the caller cannot see, so the rule tells, for each person
 * listed, whether they see it, as the write's refusal tells for one chosen
 * person and the Reassign picker does (model/removalPreview.ts takerRule).
 * The write accepts an unchanged holder in any state; the picker judges
 * every person as a new one.
 */
async function ownerRule(
  ctx: QueryCtx,
  gate: PickerTask,
  guard: () => Promise<void>,
): Promise<Rule> {
  const reads = projectLevelReads()
  const assignable = await canBeAssignedFor(ctx, gate.project, { guard, reads })
  const above = new Set<string>()
  for (const task of await ancestorsFrom(ctx, gate.task.parent_id, guard))
    above.add(task.project_id)
  above.delete(gate.project.id)
  above.delete(gate.top.id)
  const sights: Rule[] = []
  for (const id of above) {
    const sees = await sightOn(ctx, id, { guard, reads })
    if (sees === null) return () => false
    sights.push(sees)
  }
  return (profile) => assignable(profile) && sights.every((sees) => sees(profile))
}

/**
 * Whom Team sync's Mention window may notify about the gate's task, by the
 * mention fan-out's rule, sight of the task's project (model/messages.ts
 * postMessage, navigation included, so a task stored on a top-level
 * project counts whoever reaches one of its sub-projects), with the
 * window's own filters, a person (no agent), active, and not the caller.
 * It asks nothing of the tasks above. The fan-out itself still notifies a
 * person switched off after the batch was read, so the app checks a choice
 * with canOwn before it sends.
 */
async function recipientRule(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  gate: PickerTask,
  guard: () => Promise<void>,
): Promise<Rule> {
  const sees = await canSeeProjectFor(ctx, gate.project, { guard, reads: projectLevelReads() })
  return (profile) =>
    profile.kind === 'person' && profile.active && profile.id !== me.id && sees(profile)
}

/* -------------------------------------------------------------- the lists */

/* The roles that can hold work (lib/access.ts canHoldWork), the owner
 * pickers' streams, so organization viewers are never read. */
const HOLDER_ROLES = ['admin', 'user', 'guest'] as const

/** The list names the cursors are sealed with. */
const TASK_OWNERS = 'pickers.taskOwners'
const SYNC_RECIPIENTS = 'pickers.syncRecipients'

/* The refusals of a cursor that is not one of the list's for the same
 * arguments and search. */
const OWNERS_CURSOR =
  'after and through must be cursors from an earlier answer of this list, for the same task, field and search; start again from the first batch'
const RECIPIENTS_CURSOR =
  'after and through must be cursors from an earlier answer of this list, for the same task and search; start again from the first batch'

/** What the owner picker is asked for: the task, the field and a list's
 * search and cursors. */
export type TaskOwnersArgs = ListArgs & { issue_id: string; field: OwnerField }

/** What the recipient picker is asked for: the task and a list's search
 * and cursors. */
export type SyncRecipientsArgs = ListArgs & { issue_id: string }

/* One batch of `ask` over `stream`, keeping each person `rule` lets in
 * whose name holds every word of the search, as a person row. A kept row
 * reads nothing more, so a batch costs one document a person it passes,
 * within NAMED_READ past what the request has read. */
async function peopleBatch(
  ctx: QueryCtx,
  ask: ListAsk,
  stream: (reads: NamedReads) => NamedStream<Doc<'profiles'>>,
  rule: Rule,
): Promise<PeopleBatch> {
  const matches = allWordsMatcher(nameKey(ask.search))
  const batch = await listBatch(ctx, ask, {
    stream,
    keep: async (profile: Doc<'profiles'>) =>
      rule(profile) && matches(nameKey(profile.name)) ? personRow(profile) : null,
    limit: LIST_BATCH,
    ceiling: await namedCeiling(ctx),
  })
  return { state: 'ready', ...batch }
}

/**
 * pickers.taskOwners for `me`: one batch of LIST_BATCH people who could
 * become the task's assignee or reviewer (`a.field`), in name order, with
 * a search over every one of them. In order:
 *
 * 1. The arguments: a search past LIMITS.search is refused with that
 *    limit's sentence, and a cursor that is not one of this list's for the
 *    same organization, task, field and search with badRequest
 *    (model/projectSettings.ts orderedListAsk).
 * 2. The gate (pickerTask): `unavailable`, or `refused` with
 *    NO_WRITE_ACCESS or, for a reviewer on a group, REVIEWER_ON_GROUP.
 * 3. `not_ready` until the organization's names are keyed
 *    (model/nameKeys.ts nameKeysReady).
 * 4. The rule (ownerRule) within PICKERS.rule, else `over_budget`.
 * 5. The walk: the organization's admins, users and guests merged in name
 *    order (profileRoleIndex), after the cursor, keeping each person the
 *    rule lets in whose name matches the search. Past NAMED_READ it stops
 *    and says so.
 *
 * Its reads are the gate's, the rule's (a few index ranges for the task's
 * project and its top-level project, for the project of a task above and,
 * when that is a top-level project, for each of its sub-projects, and each
 * sharing team's members) and one document a person walked.
 * tests/pickers.test.ts ("the pickers inside Convex's limits") logs what a
 * batch reads at the design size, one figure at a time, among 1,000 people,
 * 995 of them in a team sharing the task's sub-project, or 3 holding Edit
 * by grants, where the first batch walks to the end to find them, for a
 * sub-project shared with five teams under a top-level project shared with
 * five others, and for a reviewer of a subtask whose parent sits on a
 * top-level project of 30 live and 40 archived sub-projects. The app reads
 * it once a batch and never subscribes.
 */
export async function taskOwnersOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: TaskOwnersArgs,
): Promise<PeopleBatch> {
  const ask = await orderedListAsk(TASK_OWNERS, [me.org_id, a.issue_id, a.field], a, {
    tieOf: idTieOf,
    refusal: OWNERS_CURSOR,
  })
  const gate = await pickerTask(ctx, me, a.issue_id, a.field)
  if (!('task' in gate)) return gate
  if (!(await nameKeysReady(ctx, me.org_id))) return NOT_READY
  const rule = await withinRule(ctx, (guard) => ownerRule(ctx, gate, guard))
  if (rule === null) return OVER_BUDGET
  const streams = HOLDER_ROLES.map((role) =>
    indexAfter(profileRoleIndex(ctx, me.org_id, role), ask.after),
  )
  return await peopleBatch(
    ctx,
    ask,
    (reads) => mergeNamed(streams.map((stream) => stream(reads))),
    rule,
  )
}

/**
 * pickers.syncRecipients for `me`: one batch of LIST_BATCH people Team
 * sync's Mention window may notify about the task (recipientRule), in name
 * order, with a search. Its steps are taskOwnersOf's, with the gate's
 * Edit check (a mention is sent in a comment, which needs Edit) and no
 * group check, and the walk over every profile of the organization
 * (profileIndex), since an organization viewer who sees the task receives
 * mentions; agents and switched-off people are read and left out.
 *
 * tests/pickers.test.ts ("the pickers inside Convex's limits") logs what a
 * batch reads at the design size, one figure at a time: a search that
 * matches nobody among 1,000 people, which walks every profile, a
 * sub-project shared with five teams under a top-level project shared with
 * five others, and a task stored on a top-level project of 30 live and 40
 * archived sub-projects, whose navigation the rule reads, with the gate
 * alone for a caller who reaches that project only through its last
 * sub-project and is refused.
 * The app reads it once a batch while the window is open and never
 * subscribes.
 */
export async function syncRecipientsOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: SyncRecipientsArgs,
): Promise<PeopleBatch> {
  const ask = await orderedListAsk(SYNC_RECIPIENTS, [me.org_id, a.issue_id], a, {
    tieOf: idTieOf,
    refusal: RECIPIENTS_CURSOR,
  })
  const gate = await pickerTask(ctx, me, a.issue_id, 'recipient')
  if (!('task' in gate)) return gate
  if (!(await nameKeysReady(ctx, me.org_id))) return NOT_READY
  const rule = await withinRule(ctx, (guard) => recipientRule(ctx, me, gate, guard))
  if (rule === null) return OVER_BUDGET
  return await peopleBatch(ctx, ask, indexAfter(profileIndex(ctx, me.org_id), ask.after), rule)
}

/* ------------------------------------------------------------- the check */

/** What canOwn is asked: the task, the field and the people by id. */
export type CanOwnArgs = { issue_id: string; field: PickerField; ids: readonly string[] }

/**
 * pickers.canOwn for `me`: for each distinct id of `a.ids`, in the order
 * asked, the person's row and whether they could be chosen now in the
 * picker of `a.field`, by the rule its list judges by (ownerRule for an
 * assignee or reviewer, recipientRule for a recipient). More than
 * BY_IDS_MAX ids are refused before anything is read, counted as sent, as
 * labels.byIds counts them. The gate runs first for every field, the
 * recipient's too, since a mention is sent in a comment, which needs Edit;
 * then the rule and one lookup an id, all within PICKERS.rule, else
 * `over_budget`. An id the organization does not hold, unknown or another
 * organization's alike, answers `person: null` and not eligible. An id it
 * holds answers its row, also when the person is switched off or no longer
 * eligible, so a current holder stays readable; `eligible: false` for
 * them means readable, not a new choice, and the write still accepts the
 * holder sent unchanged. It reads no name key, so it never answers
 * `not_ready`. With 100 ids among 1,000 people it read 109 index ranges,
 * 108 documents and 0.04 MiB at the design size (tests/pickers.test.ts).
 */
export async function canOwnOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: CanOwnArgs,
): Promise<OwnerChecks> {
  if (a.ids.length > BY_IDS_MAX) throw badRequest(`ids must name at most ${BY_IDS_MAX} people`)
  const gate = await pickerTask(ctx, me, a.issue_id, a.field)
  if (!('task' in gate)) return gate
  const rows = await withinRule(ctx, async (guard, share) => {
    const rule =
      a.field === 'recipient'
        ? await recipientRule(ctx, me, gate, guard)
        : await ownerRule(ctx, gate, guard)
    const out: OwnerCheck[] = []
    for (const id of new Set(a.ids)) {
      if (share.full) throw new RuleFull()
      const profile = await share.lookup(() => byId(ctx, 'profiles', id))
      out.push(
        profile === null || profile.org_id !== me.org_id
          ? { id, person: null, eligible: false }
          : { id, person: personRow(profile), eligible: rule(profile) },
      )
    }
    return out
  })
  return rows === null ? OVER_BUDGET : { state: 'ready', rows }
}

/* ---------------------------------------------------------- the mentions */

/** A person as the editor's @ mention popup and the view filter's Assignee
 * menu show and match them: the name, the initials and the color of their
 * portrait (a legacy color sent as gray, model/people.ts shownAvatarColor).
 * It holds no email, which neither list shows or matches for anyone (the
 * owner's decision of 12 November 2026), and no team, level, task or
 * project. */
export type MentionRow = {
  id: string
  name: string
  initials: string
  color: string
}

/** `profile` as a mention row. */
const mentionRow = (profile: Doc<'profiles'>): MentionRow => ({
  id: profile.id,
  name: profile.name,
  initials: profile.initials,
  color: shownAvatarColor(profile.color),
})

/* What the two lists match a search against: the name and the initials,
 * one a line, never the email. */
const mentionText = (profile: Doc<'profiles'>) => `${profile.name}\n${profile.initials}`

/** What the mention popup is asked for: the task whose text holds the "@"
 * and a list's search and cursors. */
export type MentionsArgs = ListArgs & { issue_id: string }

/** What the mention popup's read answers: the task pickers' gate states,
 * `not_ready` until the organization's names are keyed, `over_budget` when
 * its rule could not be worked out within PICKERS.rule, or one batch of
 * people in name order (lib/namedPages.ts ListBatch: rows, next,
 * stopped). */
export type MentionBatch =
  | { state: 'unavailable' }
  | { state: 'refused'; message: string }
  | { state: 'not_ready' }
  | { state: 'over_budget' }
  | ({ state: 'ready' } & ListBatch<MentionRow>)

/** What the view filter's Assignee menu's read answers: `not_ready` until
 * the organization's names are keyed, or one batch of people in name
 * order. */
export type OrgPeopleBatch = { state: 'not_ready' } | ({ state: 'ready' } & ListBatch<MentionRow>)

/** The list names the cursors are sealed with. */
const MENTIONS = 'pickers.mentions'
const ORG_PEOPLE = 'pickers.orgPeople'

/* The refusals of a cursor that is not one of the list's for the same
 * arguments and search. */
const MENTIONS_CURSOR =
  'after and through must be cursors from an earlier answer of these suggestions, for the same task and search; start again from the first batch'
const ORG_PEOPLE_CURSOR =
  'after and through must be cursors from an earlier answer of this list, with the same search; start again from the first batch'

/**
 * pickers.mentions for `me`: one batch of MENTION_BATCH people the editor's
 * @ mention popup offers in a text of task `a.issue_id`, its description or
 * one of its comments, in name order. It offers only the people who have
 * access to the task's project (the owner's decision of 12 November 2026):
 * an active profile that sees the project, navigation included
 * (lib/access.ts canSeeProjectFor, the rule the mention fan-out notifies
 * by), a person or an agent, the caller too. A switched-off profile and
 * anyone without a level on the project are left out, an organization
 * admin without one included. In order:
 *
 * 1. The arguments: a search past LIMITS.search is refused with that
 *    limit's sentence, and a cursor that is not one of these suggestions'
 *    for the same organization, task and search with badRequest
 *    (model/projectSettings.ts orderedListAsk). The cursor's scope holds
 *    the search as the match reads it (lib/search.ts searchWords), so
 *    "Café" and "cafe", which match different people here, never share a
 *    cursor.
 * 2. The gate (pickerTask), before any person is read: `unavailable` alike
 *    for every task the caller cannot write a text in, and `refused` with
 *    NO_WRITE_ACCESS for a caller below User on its project, since a
 *    description and a comment both need Edit.
 * 3. `not_ready` until the organization's names are keyed.
 * 4. The rule within PICKERS.rule, else `over_budget`, with no row.
 * 5. The walk over every profile of the organization in name key order,
 *    ties by id (profileIndex), after the cursor, keeping each profile the
 *    rule lets in whose name and initials, one a line, hold every
 *    whitespace-separated word of the search in any order, ignoring case
 *    but not accents (lib/search.ts allWordsMatcher). Past NAMED_READ it
 *    stops and says so, with a cursor, and never answers an end it did not
 *    reach.
 *
 * Its reads are syncRecipientsOf's: the gate's, the rule's and one
 * document a person walked. The app reads it once a batch while the popup
 * is open and never subscribes. tests/mentionAccess.test.ts holds who it
 * offers to whom.
 */
export async function mentionsOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: MentionsArgs,
): Promise<MentionBatch> {
  const scope = [me.org_id, a.issue_id, searchWords(a.search ?? '')]
  const ask = await orderedListAsk(MENTIONS, scope, a, {
    tieOf: idTieOf,
    refusal: MENTIONS_CURSOR,
  })
  const gate = await pickerTask(ctx, me, a.issue_id, 'recipient')
  if (!('task' in gate)) return gate
  if (!(await nameKeysReady(ctx, me.org_id))) return NOT_READY
  const sees = await withinRule(ctx, (guard) =>
    canSeeProjectFor(ctx, gate.project, { guard, reads: projectLevelReads() }),
  )
  if (sees === null) return OVER_BUDGET
  const matches = allWordsMatcher(ask.search)
  const batch = await listBatch(ctx, ask, {
    stream: indexAfter(profileIndex(ctx, me.org_id), ask.after),
    keep: async (profile: Doc<'profiles'>) =>
      profile.active && sees(profile) && matches(mentionText(profile)) ? mentionRow(profile) : null,
    limit: MENTION_BATCH,
    ceiling: await namedCeiling(ctx),
  })
  return { state: 'ready', ...batch }
}

/**
 * pickers.orgPeople for `me`: one batch of MENTION_BATCH people of the
 * organization the view filter's Assignee menu offers, in name order. It
 * walks every profile of the organization in name key order, ties by id
 * (profileIndex), after the cursor, people, agents, switched-off people,
 * unclaimed seats and the caller alike, as the menu has always listed
 * them, since a filter may name anyone whose tasks the caller sees. It
 * keeps each whose name and initials hold every word of the search, by
 * mentionsOf's match. The arguments, readiness and stops are mentionsOf's,
 * with a cursor's scope of the organization and the search.
 *
 * No task, project, grant or team is read, so the read cannot widen access
 * to work, and any active seat of the organization may read it, guests and
 * viewers too. That every seat reads every name here is an agent decision
 * of 12 November 2026 that waits for the owner, who that day took the
 * email out of both lists and narrowed the mention popup to the task's
 * project. With `through` a batch holds every match up to it and stops
 * past four batches (lib/namedPages.ts listBatch); the app reads without
 * it, once a batch, and never subscribes. A kept row reads nothing more,
 * so a batch costs one document a person walked.
 * tests/mentionSuggestions.test.ts ("the list inside Convex's limits")
 * logs what a batch reads among 1,000 people, without the login's own
 * reads. NAMED_READ's documents hold the longest walk several times over.
 */
export async function orgPeopleOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: ListArgs,
): Promise<OrgPeopleBatch> {
  const ask = await orderedListAsk(ORG_PEOPLE, [me.org_id, searchWords(a.search ?? '')], a, {
    tieOf: idTieOf,
    refusal: ORG_PEOPLE_CURSOR,
  })
  if (!(await nameKeysReady(ctx, me.org_id))) return NOT_READY
  const matches = allWordsMatcher(ask.search)
  const batch = await listBatch(ctx, ask, {
    stream: indexAfter(profileIndex(ctx, me.org_id), ask.after),
    keep: async (profile: Doc<'profiles'>) =>
      matches(mentionText(profile)) ? mentionRow(profile) : null,
    limit: MENTION_BATCH,
    ceiling: await namedCeiling(ctx),
  })
  return { state: 'ready', ...batch }
}

/* ---------------------------------------------------------- the followers */

/** A person as the follower popover shows them (src/components/
 * IssueSubscribers.tsx): the name, the initials and the color of their
 * portrait (a legacy color sent as gray), and whether their seat is on, so
 * a switched-off follower shows and can be removed. It holds no email,
 * team, level, task or project. */
export type FollowerRow = {
  id: string
  name: string
  initials: string
  color: string
  active: boolean
}

/** `profile` as a follower row. */
export const followerRow = (profile: Doc<'profiles'>): FollowerRow => ({
  id: profile.id,
  name: profile.name,
  initials: profile.initials,
  color: shownAvatarColor(profile.color),
  active: profile.active,
})

/** What the follower popover's Add list is asked for: the task and a
 * list's search and cursors. */
export type TaskFollowersArgs = ListArgs & { issue_id: string }

/** What the follower popover's Add list answers: `unavailable` for a task
 * the caller cannot see, `refused` with the write's sentence for a caller
 * who may not manage other followers, `not_ready` until the names are
 * keyed, `over_budget` past PICKERS.rule, or one batch of rows. */
export type FollowerBatch =
  | { state: 'unavailable' }
  | { state: 'refused'; message: string }
  | { state: 'not_ready' }
  | { state: 'over_budget' }
  | ({ state: 'ready' } & ListBatch<FollowerRow>)

/** The sentence issues.setSubscriber refuses another person's follow
 * with, for a caller who may not manage the task's followers. */
export const MANAGE_FOLLOWERS_RULE =
  'only project leads and organization admins can manage other subscribers'

/** The list name the follower cursors are sealed with. */
const TASK_FOLLOWERS = 'pickers.taskFollowers'

/* The refusal of a cursor that is not one of the list's for the same task
 * and search. */
const FOLLOWERS_CURSOR =
  'after and through must be cursors from an earlier answer of this list, for the same task and search; start again from the first batch'

/**
 * pickers.taskFollowers for `me`: one batch of LIST_BATCH people the
 * follower popover's Add list offers for task `a.issue_id`, in name order,
 * by issues.setSubscriber's own rule for a new follower: an active person
 * or a Standard user agent with an inbox (lib/access.ts keepsInbox) who
 * sees the task's project, navigation included (canSeeProject, through
 * canSeeProjectFor for every person at once), and who does not follow the
 * task yet. The caller is left out, as the popover's Me row is their own.
 * In order:
 *
 * 1. The arguments, as the other lists refuse them (orderedListAsk).
 * 2. The task by id in the caller's organization and its project, which
 *    the caller must see, else `unavailable`, alike for a missing, foreign
 *    or hidden task, as issues.subscribers refuses them; then
 *    `refused` with MANAGE_FOLLOWERS_RULE unless the caller may manage the
 *    task's followers (canManageOwnProjectAccess), the write's check.
 * 3. `not_ready` until the organization's names are keyed.
 * 4. The rule within PICKERS.rule, else `over_budget`.
 * 5. The walk over every profile of the organization in name order
 *    (profileIndex), keeping each person the rule lets in whose name or
 *    email holds every word of the search in any order, ignoring case and
 *    accents, and whose follow of the task one lookup finds missing. Past
 *    NAMED_READ it stops and says so.
 *
 * The app reads it once a batch while the Add list is open and never
 * subscribes. The write checks again.
 *
 * tests/subscribers.test.ts answers the Add list a batch at a time at the
 * design size's people.
 */
export async function followerChoicesOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: TaskFollowersArgs,
): Promise<FollowerBatch> {
  const ask = await orderedListAsk(TASK_FOLLOWERS, [me.org_id, a.issue_id], a, {
    tieOf: idTieOf,
    refusal: FOLLOWERS_CURSOR,
  })
  const task = await byId(ctx, 'issues', a.issue_id)
  if (task === null || task.org_id !== me.org_id) return UNAVAILABLE
  const project = await byId(ctx, 'projects', task.project_id)
  if (project === null || !(await canSeeProject(ctx, me, project))) return UNAVAILABLE
  if (!(await canManageOwnProjectAccess(ctx, me, project))) return refused(MANAGE_FOLLOWERS_RULE)
  if (!(await nameKeysReady(ctx, me.org_id))) return NOT_READY
  const sees = await withinRule(ctx, (guard) =>
    canSeeProjectFor(ctx, project, { guard, reads: projectLevelReads() }),
  )
  if (sees === null) return OVER_BUDGET
  const matches = allWordsMatcher(nameKey(ask.search))
  const batch = await listBatch(ctx, ask, {
    stream: indexAfter(profileIndex(ctx, me.org_id), ask.after),
    keep: async (profile: Doc<'profiles'>, guard): Promise<FollowerRow | null> => {
      if (profile.id === me.id || !profile.active || !keepsInbox(profile) || !sees(profile))
        return null
      if (!matches(`${nameKey(profile.name)}\n${nameKey(profile.email ?? '')}`)) return null
      const follows = await guard.lookup(() =>
        ctx.db
          .query('issue_subscriptions')
          .withIndex('by_issue_profile', (q) =>
            q.eq('issue_id', task.id).eq('profile_id', profile.id),
          )
          .first(),
      )
      return follows === null ? followerRow(profile) : null
    },
    limit: LIST_BATCH,
    ceiling: await namedCeiling(ctx),
  })
  return { state: 'ready', ...batch }
}

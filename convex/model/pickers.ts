/* The readers behind the people pickers of a task (pickers.ts): who could
 * become a task's assignee or reviewer (taskOwnersOf), whom Team sync's
 * Mention window may notify about it (syncRecipientsOf), and whether a few
 * named people could be chosen in one of those pickers now (canOwnOf).
 *
 * Each runs one gate first (pickerTask): the task, its projects and the
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
 * levelUnder. An organization admin is offered while both give admins
 * Lead, and follows ordinary access after the admin access split removes
 * both branches. tests/pickerParity.test.ts holds the pickers to the writes
 * over every access shape.
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
  canSeeProjectFor,
  inMetaTree,
  levelRank,
  type ProjectLevelReads,
  projectLevel,
  projectLevelReads,
} from '../lib/access'
import type { ReadCeiling } from '../lib/archivedTasks'
import { byId } from '../lib/db'
import { badRequest } from '../lib/functions'
import { BY_IDS_MAX, LIST_BATCH, MIB } from '../lib/limits'
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
import { allWordsMatcher } from '../lib/search'
import { ancestorsFrom, hasSubtasks, NO_WRITE_ACCESS, REVIEWER_ON_GROUP } from './issues'
import { idTieOf, nameKeysReady, profileIndex, profileRoleIndex } from './nameKeys'
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
 * The largest rules at the design size read about 1,000 documents and
 * 0.2 MiB, the members of a team of 995 sharing the task's sub-project, or
 * about 220 index ranges, a top-level project of 30 live and 40 archived
 * sub-projects whose navigation the rule reads, measured with convex-test
 * on 6 November 2026 (tests/pickers.test.ts "inside Convex's limits").
 * 1,000 ranges, 8,000 documents and 4 MiB hold each of those four times
 * over or more. Past the design size a rule that reads more fails closed
 * as `over_budget` rather than as Convex's own error.
 */
export const PICKERS: { rule: ReadCeiling } = {
  rule: { ranges: 1000, documents: 8000, bytes: 4 * MIB },
}

/* Thrown by the rule's guard once its share is used, and answered as
 * `over_budget`. */
class RuleFull extends Error {}

/* `step` with a guard for its access reads that throws RuleFull once
 * PICKERS.rule past what the request has read is used, and the ReadGuard
 * behind it, which canOwn's lookups count against. Answers null for
 * RuleFull. */
async function withinRule<T>(
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
 * sharing team's members) and one document a person walked. Measured with
 * convex-test at the design size on 6 November 2026
 * (tests/pickers.test.ts "inside Convex's limits"), one figure at a time:
 * - among 1,000 people, 995 of them in a team sharing the task's
 *   sub-project at User: a first batch 15 index ranges, 1,033 documents
 *   and 0.19 MiB, and a search that matches nobody, which walks every
 *   admin, user and guest, 15 ranges, 2,006 documents and 0.57 MiB;
 * - among 1,000 people of whom 3 hold Edit by grants, the first batch
 *   walks to the end to find them: 13 ranges, 1,008 documents, 0.39 MiB;
 * - a sub-project shared with five teams under a top-level project shared
 *   with five others: 33 ranges, 235 documents, 0.05 MiB;
 * - a reviewer of a subtask whose parent sits on a top-level project of
 *   30 live and 40 archived sub-projects: 230 ranges, 161 documents,
 *   0.05 MiB.
 * The app reads it once a batch and never subscribes.
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
 * Measured with convex-test at the design size on 6 November 2026
 * (tests/pickers.test.ts "inside Convex's limits"), one figure at a time:
 * - a search that matches nobody among 1,000 people, which walks every
 *   profile: 13 index ranges, 2,007 documents and 0.57 MiB;
 * - a sub-project shared with five teams under a top-level project shared
 *   with five others: 31 ranges, 234 documents, 0.05 MiB;
 * - a task stored on a top-level project of 30 live and 40 archived
 *   sub-projects, whose navigation the rule reads: 219 ranges, 153
 *   documents, 0.05 MiB, and the gate alone, for a caller who reaches
 *   that project only through its last sub-project and is refused, 145
 *   ranges and 73 documents.
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

/* The reader behind the task window's relation pickers
 * (taskWindow.ts relationCandidates). It answers the tasks the Parent,
 * Subtasks and Linked tasks pickers offer for the opened task, a batch at a
 * time, under ordinary access, the picker's scope, the write's own rules
 * and the search, so the app no longer filters the workspace's whole task
 * list.
 *
 * A batch answers the next RELATION_PICKER.rows tasks of a fixed order that
 * pass the write's rules below, and a sealed cursor for the next batch. The
 * scope, in order:
 *
 * 1. the opened task's own sub-project;
 * 2. the other live sub-projects of its top-level project the reader can
 *    see, by creation, then the top-level project itself, where older code
 *    stored tasks (the family);
 * 3. for the Linked tasks picker only, and only once the person chooses
 *    Search all your projects at the family's end (`all_projects`), the
 *    organization's other live top-level projects by creation, each with
 *    its live sub-projects the reader can see by creation and then itself.
 *
 * Parent and Subtasks keep the projects where the reader has Edit, since
 * both ends of a parent change need it (issues.ts assertWritable, which is
 * model/issues.ts assertCanEdit, and parentChainCheck's no_write), and
 * refuse a reader without Edit on the opened task. Linked tasks keeps
 * every visible live project for a reader with Edit on the opened task,
 * and else the projects they can edit (model/issues.ts linkAccess).
 * Levels are the writes' levels of the reader (lib/access.ts
 * projectLevel), so an organization admin holds lead on every project, as
 * the writes give it, never ordinaryOf's level. The family's come from
 * viewAccess.levels and the rest of the organization's from
 * projectLevelsForOrg, which the tests compare with projectLevel.
 *
 * Within each project the batch reads its active tasks by creation (issues
 * by_project_archived), one project after another, so a batch ends at one
 * position. That is a project's place in the order above with the creation
 * time and ids of the last tasks the batch looked at. The cursor seals the
 * position with the reader, the opened task, the picker and the search
 * (lib/archiveCursorSeal.ts), so it opens for nothing else. A place names
 * its project by fields that never change, so a project that leaves the
 * scope between batches costs no row, and no row comes twice while the data
 * stays the same. Every task the scan reads is in the reader's working set.
 *
 * A task matches when every fragment of the search occurs in its ID or its
 * title (lib/search.ts allWordsMatcher), the rule the app's pickers apply.
 * A search that is one task ID (QN-12 or 12) also looks that number up in
 * the organization in the first batch. When the reader may pick that task
 * it is the batch's first row, marked `exact`, and the cursor carries that,
 * so every batch's scan then leaves the number out. Without that row a
 * scan offers the task where it meets it, as after a check of its project
 * that a bound stopped. The Linked tasks picker takes it from anywhere in
 * the organization the reader can link to.
 *
 * Eligibility follows the write. A picker never offers the opened task or
 * its current parent, subtasks or linked tasks, which the window shows from
 * its own lists. The Parent picker offers a task without a parent of its
 * own and with fewer than LIMITS.subtasks.max active subtasks in any
 * project. The Subtasks picker offers a task without any subtask, archived
 * ones included, and another task's subtask, which a pick moves. The opened
 * task's own block comes first (`blocked`), and the answer then holds no
 * row. A task with any subtask takes no parent, a subtask or a task with
 * LIMITS.subtasks.max active subtasks takes no subtask, and a task with
 * LIMITS.links.max links takes no link. That count holds links to tasks the
 * reader may not see, so a Linked tasks reader without Edit on the opened
 * task, who may edit no project at all, gets the block only from a batch
 * that could offer them a task, one whose scope holds a project or whose
 * typed task ID names a row, as a link they send would be refused for it.
 * Any other such batch reads on as if unblocked. The write keeps the rest
 * with its own sentence, which is the holders' sight of a new parent
 * (design specification row 328), the link limit on the other end, and
 * anything that changed since the batch was read.
 *
 * Reads that can touch rows the reader may not see, and what each costs:
 *
 * - before the batch, the opened task by id and its access, its own block
 *   (a by_parent row, its active subtasks up to the limit, or its links up
 *   to the limit), the family's sub-projects, live and archived, and the
 *   reader's access to the live ones (lib/viewReads.ts viewAccess), and for
 *   Search all your projects the organization's projects and the reader's
 *   own grants and team shares (projectLevelsForOrg). These run within
 *   RELATION_PICKER.whole, each document the reader may not be shown
 *   counted at its fixed size (viewBudget charge). Their cost never moves
 *   where a batch stops, because a batch counts from its own start, and a
 *   request without room for a batch's whole budget after them answers
 *   `over_budget`;
 * - in the batch, each taken at its worst case before it is read, from the
 *   batch's own count (RELATION_PICKER.reads), which never looks at what a
 *   read returned. These are a parent candidate's active subtasks
 *   (LIMITS.subtasks.max rows of TASK_ROW_MAX_BYTES), a subtask candidate's
 *   first subtask (one row), a subtask candidate's parent, which costs one
 *   read by id and one access question (PROJECT_ASK and PROJECT_READ)
 *   whatever it finds, also where an earlier candidate read the same
 *   parent or the parent sits in the family and no question is asked, and
 *   a typed task ID's lookup with one access question, whatever it finds.
 *   Only a parent the batch's scan read before costs nothing, as the reader
 *   is shown it. The question is asked only for a parent outside the
 *   family, which only data stored before the rule that a subtask stays in
 *   its parent's top-level project holds.
 *
 * So where a batch stops follows only the tasks the reader is shown and
 * their own facts. How many subtasks a candidate has that the reader cannot
 * see, which hidden parent a subtask candidate has and where it sits, how
 * many hidden or archived sub-projects the family has and what any hidden
 * title holds move no stop. A candidate's subtasks the reader cannot see
 * remove it only where the write would refuse its pick for them, a Parent
 * candidate they make full and a Subtasks candidate that has any, so
 * excluding a candidate for its hidden or archived subtasks tells no more
 * than the write's refusal of that pick does. A subtask row names its
 * parent only when the reader is shown it (lib/workingSet.ts parentLink),
 * and else says it has a hidden one.
 *
 * RELATION_PICKER names the budgets and the reads measured at the design
 * size. */

import { getDocumentSize } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { NO_WRITE_ACCESS } from '../model/issues'
import {
  ACCESS_UNCHECKED,
  accessRowsOf,
  inMetaTree,
  isAccessUnchecked,
  levelRank,
  levelsFrom,
  orgProjects,
} from './access'
import { openCursorText, sealCursorText } from './archiveCursorSeal'
import { byId } from './db'
import type { AccessLevel } from './enums'
import { badRequest } from './functions'
import { limitedText } from './limitRules'
import { LIMITS, MIB, PROJECT_ROW_MAX_BYTES, TASK_ROW_MAX_BYTES } from './limits'
import { LINK_ROW_BYTES } from './roadmap'
import { allWordsMatcher } from './search'
import { issueKey, parseIssueRef } from './taskRefs'
import type { ShortRow } from './taskWindow'
import {
  BY_ID,
  inSteps,
  isOverBudget,
  OverBudget,
  PROJECT_ASK,
  PROJECT_READ,
  RANGE,
  type Reads,
  ROW,
  type StepRange,
  type ViewAccess,
  type ViewBudget,
  viewAccess,
  viewBudget,
  withoutSubtasks,
} from './viewReads'
import { parentLink } from './workingSet'
import { taskFields } from './workspaceParts'

/**
 * The relation pickers' sizes and budgets, which tests lower and set back
 * with structuredClone.
 *
 * `rows` is a batch, the tasks one press of Load more adds. `scan` stops a
 * batch after it looked at that many tasks. `reads` is a batch's own
 * budget, which the reader counts from the batch's start (see the header).
 * It counts the scope's task rows at their size, each step keeping room for
 * its rows at lib/viewReads.ts ROW_BYTES, and every read that can touch
 * rows the reader may not see at its worst case. `whole` caps what the
 * request reads in all, the reads before the batch included, below Convex's
 * 16 MiB, 4,096 ranges and 32,000 documents, with room for what one access
 * question can read past its last look (lib/access.ts OWN_READS). A request
 * that cannot hold `reads` after the reads before the batch answers
 * `over_budget`.
 *
 * Measured on 5 November 2026 in convex/tests/relationPickerScale.test.ts
 * under convex-test's transaction limits, at the design size with ordinary
 * text, one figure raised a case, in what the whole request read. Every
 * first batch answered whole within these budgets.
 *
 * - In a family at everyday values a full batch reads at most 41 ranges,
 *   39 documents and 0.02 MiB, while the Parent picker's own count holds
 *   4.9 MiB of its 8 for its 25 checks at their worst case. A rare word
 *   reads the family to its end in 20 ranges and 99 documents, and after
 *   Search all your projects the member's 57 other sub-projects in 101
 *   ranges, 1,829 documents and 0.81 MiB.
 * - A rare word reads a project of 800 open tasks whole in 34 ranges, 884
 *   documents and 0.4 MiB, a sub-project of 300 in 24 ranges and 373
 *   documents, a project of 30 live and 40 archived sub-projects of 20
 *   tasks each in 102 ranges, 677 documents and 0.3 MiB (a full batch 98
 *   ranges), and a project with 200 Done tasks in 25 ranges.
 * - A full batch reads at most 41 ranges for a member in 5 teams, as at
 *   everyday values, and 45 where the family is shared with 5 teams, and a
 *   rare word in all your projects 105 ranges and 1,833 documents in each.
 * - With the catalogue at its sum, 2,000 projects live and archived, a
 *   rare word in all your projects reads 101 ranges, 2,170 documents and
 *   1 MiB for a member, the catalogue's 2,000 documents included, and 707
 *   ranges, 3,089 documents and 1.65 MiB for an organization admin over
 *   its 700 live projects.
 * - One batch at its full `scan` for an admin, over 167 sub-projects of
 *   about 30 tasks, reads 242 ranges, 5,642 documents and 3.82 MiB, and
 *   stops at `scan` with its own count at 3.72 MiB.
 * - Search all your projects reads 288 ranges, 1,407 documents and 0.85
 *   MiB for a member who reads 200 sub-projects, and 131 ranges, 1,099
 *   documents and 0.58 MiB for one whose team shares 50 live and 150
 *   archived projects.
 *
 * The Boat timing of its slowest calls (owner, 31 October 2026) takes the
 * admin's rare word over the catalogue's 700 live projects, the admin's
 * batch at its full `scan`, and a member's rare word over the project of
 * 800 open tasks, as those cases build them. If the slowest call's
 * JavaScript passes 0.5 s, lower `scan`.
 */
export const RELATION_PICKER = {
  rows: 25,
  scan: 5000,
  reads: { bytes: 8 * MIB, documents: 16_000, ranges: 2000 },
  whole: { bytes: 12 * MIB, documents: 24_000, ranges: 3600 },
}

/** The picker that asks, Parent, Subtasks or Linked tasks. */
export type RelationKind = 'parent' | 'subtask' | 'link'

/** Why the opened task can take no new relation of the picker's kind, as
 * the write would refuse it. With `has_subtasks` it has a subtask, archived
 * ones included, so it takes no parent. With `is_subtask` it is a subtask,
 * so it takes no subtask. With `full` it holds LIMITS.subtasks.max active
 * subtasks and takes no more, or LIMITS.links.max links and takes no more
 * links. The app words each as the window's own tooltip does. */
export type RelationBlock = 'has_subtasks' | 'is_subtask' | 'full'

/** One task a picker offers, as the window's short row of it
 * (lib/taskWindow.ts ShortRow) with the reader's level on its project and
 * without its group fact, which a pick decides. A new parent has the opened
 * task as a subtask, and a new subtask has none of its own. */
export type RelationCandidate = Omit<ShortRow, 'has_subtasks'> & {
  /** In the Subtasks picker only, the task's parent as the reader is shown
   * it (lib/workingSet.ts parentLink), the pair a pick sends as its
   * expected values. The other pickers leave both out. */
  parent_id?: string
  has_hidden_parent?: boolean
  /** the task a search of exactly its task ID names, found by its number
   * whatever the list's end, which Enter may pick */
  exact?: true
}

/** What taskWindow.relationCandidates answers. */
export type RelationCandidates =
  | {
      state: 'ok'
      /** the next eligible tasks in the picker's order, at most
       * RELATION_PICKER.rows */
      rows: RelationCandidate[]
      /** the cursor of the next batch, or null once the batch read the
       * scope to its end, which is the family's end for a picker that has
       * not chosen Search all your projects, else the organization's */
      next: string | null
      /** in the Linked tasks picker at the family's end, the cursor that
       * goes on into the organization's other projects once the person
       * chooses Search all your projects, else null */
      all_projects: string | null
      /** the batch reached `scan` or its read budget before it held a
       * full batch, so `next` goes on from where it stopped */
      stopped: boolean
      /** the opened task's own block, with no row. A Linked tasks reader
       * without Edit on the opened task gets it only from a batch that could
       * offer them a task (see the header). */
      blocked: RelationBlock | null
    }
  | { state: 'unavailable'; reason?: typeof ACCESS_UNCHECKED; message?: string }
  | { state: 'refused'; message: string }
  | { state: 'over_budget' }

/** The arguments of taskWindow.relationCandidates. */
export type RelationArgs = {
  issue_id: string
  kind: RelationKind
  search?: string
  cursor?: string
}

/** What the reader answers for an opened task the reader may not open,
 * alike for every reason, a check of its access a bound stopped included,
 * as taskWindow.task answers it. */
const UNAVAILABLE = { state: 'unavailable' as const }

// --- costs --------------------------------------------------------------------

/** No reads. */
const NONE: Reads = { bytes: 0, documents: 0, ranges: 0 }

/* `a` and `b` together. */
const plus = (a: Reads, b: Reads): Reads => ({
  bytes: a.bytes + b.bytes,
  documents: a.documents + b.documents,
  ranges: a.ranges + b.ranges,
})

/* `n` reads of `cost`. */
const times = (cost: Reads, n: number): Reads => ({
  bytes: n * cost.bytes,
  documents: n * cost.documents,
  ranges: n * cost.ranges,
})

/** A task the reader may not be shown, read by id or as the first row of a
 * range, at its fixed size (lib/limits.ts TASK_ROW_MAX_BYTES). */
const HIDDEN_BY_ID: Reads = { bytes: TASK_ROW_MAX_BYTES, documents: 1, ranges: 1 }

/** A task's active subtasks up to LIMITS.subtasks.max, one range, each row
 * at its fixed size, as a parent candidate's check and the Subtasks
 * picker's block read them. */
const SUBTASKS: Reads = {
  bytes: LIMITS.subtasks.max * TASK_ROW_MAX_BYTES,
  documents: LIMITS.subtasks.max,
  ranges: 1,
}

/** The opened task's links up to LIMITS.links.max, its two link ranges,
 * each row at lib/roadmap.ts LINK_ROW_BYTES. */
const LINKS: Reads = {
  bytes: LIMITS.links.max * LINK_ROW_BYTES,
  documents: LIMITS.links.max,
  ranges: 2,
}

/** One access question about a project not asked before, with the
 * project's row for whether it is live (lib/viewReads.ts PROJECT_ASK and
 * PROJECT_READ). */
const ASK: Reads = plus(PROJECT_ASK, PROJECT_READ)

/** A typed task ID's lookup, the task by its number at its fixed size and
 * one access question, whatever the number names. */
const TYPED: Reads = plus(HIDDEN_BY_ID, ASK)

/** A subtask candidate's parent, read by id at its fixed size, and one
 * access question about its project, whatever the parent is. */
const PARENT: Reads = plus(HIDDEN_BY_ID, ASK)

/** One project row of the family's listing, at its fixed size. */
const PROJECT_ROW: Reads = { bytes: PROJECT_ROW_MAX_BYTES, documents: 1, ranges: 0 }

/** The sub-projects under one top-level project at the design size, live
 * and archived (AGENTS.md), which the family's listing reads in one step. */
const FAMILY_ROWS = 30 + 40

/** How many projects one step of a batch reads side by side at most, the
 * most rows it asks each for, and the fewest it gives each before it reads
 * fewer side by side. A step reads one project at first, and twice as many
 * after each step whose every range ended, so the small projects of an
 * organization go side by side while a project that does not end in one
 * step is read on its own. */
const STEP = { projects: 16, rows: 64, share: 32 }

// --- the batch's own count ------------------------------------------------------

/**
 * A batch's read count against `cap`, kept by the reader, which never looks
 * at the request's totals, so what a read returned moves it only where the
 * reader is shown the rows. A read that may touch rows the reader may not
 * see takes its worst case before it starts (take), and a range of the
 * scope's tasks counts its range and its rows at their size once read
 * (rows). The request's own guard (lib/viewReads.ts
 * viewBudget) takes the same reads besides, so Convex's limits hold
 * whatever the rows weigh.
 */
function batchCount(cap: Reads) {
  let used = NONE
  /** How many reads of `cost` fit beside `base`, -1 when `base` does not. */
  const room = (cost: Reads, base: Reads = NONE): number => {
    const left = {
      bytes: cap.bytes - used.bytes - base.bytes,
      documents: cap.documents - used.documents - base.documents,
      ranges: cap.ranges - used.ranges - base.ranges,
    }
    if (left.bytes < 0 || left.documents < 0 || left.ranges < 0) return -1
    return Math.min(
      cost.bytes > 0 ? Math.floor(left.bytes / cost.bytes) : Number.POSITIVE_INFINITY,
      cost.documents > 0 ? Math.floor(left.documents / cost.documents) : Number.POSITIVE_INFINITY,
      cost.ranges > 0 ? Math.floor(left.ranges / cost.ranges) : Number.POSITIVE_INFINITY,
    )
  }
  return {
    room,
    /** What the batch counted so far. */
    get used(): Reads {
      return used
    },
    /** Whether one read of `cost` fits. */
    fits: (cost: Reads): boolean => room(cost) >= 1,
    /** Counts one read of `cost`. */
    take(cost: Reads): void {
      used = plus(used, cost)
    },
    /** Counts a range of the scope's tasks and the rows it returned, at
     * their size as Convex counts them. */
    rows(rows: readonly Doc<'issues'>[], bytes: number): void {
      used = plus(used, { bytes, documents: rows.length, ranges: 1 })
    },
  }
}

/** What batchCount answers. */
type BatchCount = ReturnType<typeof batchCount>

// --- the order and the cursor -----------------------------------------------------

/** A project's place in the picker's order, compared field by field. [0]
 * is the opened task's sub-project, [1, created, id] another sub-project of
 * its family, [2] its top-level project, [3, created, id, 0, created, id] a
 * sub-project of another top-level project and [3, created, id, 1] that
 * project itself. A place names its project by fields that never change,
 * so it holds while projects come and go. */
type Place = readonly (number | string)[]

/* -1, 0 or 1 as place `a` comes before, at or after `b`, a prefix first. */
function comparePlaces(a: Place, b: Place): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    return String(x) < String(y) ? -1 : 1
  }
  return a.length - b.length
}

/** The place where the organization's other projects start. */
const OTHERS: Place = [3]

/** Where a batch stands, just after the tasks of the project at `place`
 * created at `time` with these `ids` and every one created before them, or
 * at the start of that place's project when `time` is null. */
type Position = { place: Place; time: number | null; ids: string[] }

/** What a cursor carries, where the next batch starts and whether the
 * first batch answered a typed task ID's task as its `exact` row, which
 * every later scan then leaves out. Without that row a later scan offers
 * the task where it meets it. */
type Cursor = { at: Position; typedTaken: boolean }

/* The version a cursor carries outside and inside its sealed text. Every
 * sealed cursor shares one key (lib/archiveCursorSeal.ts), so the version
 * inside keeps a body sealed for another list from opening here. */
const CURSOR_PREFIX = 'rp2~'
const CURSOR_VERSION = 'relation-picker-2'

/* The longest cursor text that may open, far above what a position and a
 * 200-character search write, so only junk is refused unopened. */
const CURSOR_MAX = 64 << 10

/** The refusal of a cursor that is not the `next` or `all_projects` of an
 * earlier batch of the same picker, task and search for the same person. */
export const RELATION_CURSOR_REFUSAL =
  'cursor must come from an earlier batch of this picker for this task and search'

/* What a cursor is sealed with, the reader, the opened task, the picker
 * and the search. */
const scopeKey = (me: Doc<'profiles'>, issueId: string, kind: RelationKind, search: string) =>
  JSON.stringify([me.org_id, me.id, issueId, kind, search])

/** Cursor `c` as the text of a cursor of the batches of `key`. */
const cursorOf = async (key: string, c: Cursor): Promise<string> =>
  `${CURSOR_PREFIX}${await sealCursorText(
    JSON.stringify([CURSOR_VERSION, key, c.at.place, c.at.time, c.at.ids, c.typedTaken]),
  )}`

/** The cursor `text` names for the batches of `key`, or a refusal when it
 * is not one cursorOf wrote for them. */
async function cursorFrom(text: string, key: string): Promise<Cursor> {
  const refuse = () => badRequest(RELATION_CURSOR_REFUSAL)
  if (!text.startsWith(CURSOR_PREFIX) || text.length > CURSOR_MAX) throw refuse()
  const opened = await openCursorText(text.slice(CURSOR_PREFIX.length))
  if (opened === null) throw refuse()
  let body: unknown
  try {
    body = JSON.parse(opened)
  } catch {
    throw refuse()
  }
  if (!Array.isArray(body) || body.length !== 6) throw refuse()
  const [version, from, place, time, ids, typedTaken] = body as unknown[]
  if (version !== CURSOR_VERSION || from !== key) throw refuse()
  const field = (x: unknown) =>
    typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x))
  if (!Array.isArray(place) || place.length === 0 || !place.every(field)) throw refuse()
  // compared, not narrowed by its type, because the app's loose tsconfig
  // narrows `unknown` only so
  const at = typeof time === 'number' && Number.isFinite(time) ? time : null
  if (time !== null && at === null) throw refuse()
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) throw refuse()
  if (typedTaken !== true && typedTaken !== false) throw refuse()
  return { at: { place: place as Place, time: at, ids: ids as string[] }, typedTaken }
}

// --- the opened task and its family ---------------------------------------------

/** A project of the picker's scope, at its place, with the reader's level. */
type ScopeProject = { place: Place; project: Doc<'projects'>; level: AccessLevel }

/** The opened task with its project, its top-level project and the
 * reader's level on its project, when it is in the reader's working set,
 * else null, alike for every reason, a check a bound stopped included. */
async function openedTask(
  ctx: QueryCtx,
  guard: ViewBudget,
  seat: ViewAccess,
  issueId: string,
): Promise<{
  task: Doc<'issues'>
  project: Doc<'projects'>
  top: Doc<'projects'>
  level: AccessLevel
} | null> {
  try {
    await guard.take(BY_ID)
    const task = await byId(ctx, 'issues', issueId)
    if (task === null || task.org_id !== seat.me.org_id) return null
    guard.charge(task, TASK_ROW_MAX_BYTES)
    if (!(await seat.holds([task]))[0]) return null
    guard.refund(task, TASK_ROW_MAX_BYTES)
    const project = await seat.project(task.project_id)
    if (project === null) return null
    const top = project.parent_id === undefined ? project : await seat.project(project.parent_id)
    if (top === null || top.archived_at !== undefined) return null
    const [level] = await seat.levels([project.id])
    return level === null ? null : { task, project, top, level }
  } catch (e) {
    if (isAccessUnchecked(e)) return null
    throw e
  }
}

/** The opened task's own block for picker `kind`, with, for Linked tasks,
 * the ids of the tasks it is linked to, which the picker leaves out. Each
 * read is taken at its cap, its rows at their fixed size, as they may be
 * tasks or links the reader is not shown. */
async function blockOf(
  ctx: QueryCtx,
  guard: ViewBudget,
  task: Doc<'issues'>,
  kind: RelationKind,
): Promise<{ blocked: RelationBlock | null; linked: Set<string> }> {
  const linked = new Set<string>()
  if (kind === 'parent') {
    // model/issues.ts hasAnySubtask, archived ones included
    await guard.take(HIDDEN_BY_ID)
    const kid = await ctx.db
      .query('issues')
      .withIndex('by_parent', (q) => q.eq('parent_id', task.id))
      .first()
    if (kid === null) return { blocked: null, linked }
    guard.charge(kid, TASK_ROW_MAX_BYTES)
    return { blocked: 'has_subtasks', linked }
  }
  if (kind === 'subtask') {
    if (task.parent_id !== undefined) return { blocked: 'is_subtask', linked }
    // model/issues.ts subtaskCount, in any project
    await guard.take(SUBTASKS)
    const kids = await activeKids(ctx, task.id).take(LIMITS.subtasks.max)
    for (const kid of kids) guard.charge(kid, TASK_ROW_MAX_BYTES)
    return { blocked: kids.length >= LIMITS.subtasks.max ? 'full' : null, linked }
  }
  // model/links.ts linksFullAt, which reads every link below the cap
  await guard.take(LINKS)
  const asSource = await ctx.db
    .query('issue_links')
    .withIndex('by_source', (q) => q.eq('source_id', task.id))
    .take(LIMITS.links.max)
  const asTarget =
    asSource.length >= LIMITS.links.max
      ? []
      : await ctx.db
          .query('issue_links')
          .withIndex('by_target', (q) => q.eq('target_id', task.id))
          .take(LIMITS.links.max - asSource.length)
  for (const link of [...asSource, ...asTarget]) {
    guard.charge(link, LINK_ROW_BYTES)
    linked.add(link.source_id === task.id ? link.target_id : link.source_id)
  }
  const full = asSource.length + asTarget.length >= LIMITS.links.max
  return { blocked: full ? 'full' : null, linked }
}

/** The opened task's family as the picker reads it. */
type Family = {
  top: Doc<'projects'>
  /** each project of the family by id, the top-level project and its
   * sub-projects of the organization, live or archived, with the reader's
   * level where it is live, else null */
  projects: Map<string, { project: Doc<'projects'>; live: boolean; level: AccessLevel | null }>
}

/**
 * The family of the opened task's top-level project `top`, which is its
 * sub-projects, live and archived, and the reader's level on `top` and on
 * each live one (viewAccess levels). The sub-projects are read in steps of
 * FAMILY_ROWS rows, each counted at its fixed size, as the reader may not
 * see them, as lib/viewReads.ts projectSelection reads them. A check of the
 * reader's access a bound stopped rejects with accessUnchecked.
 */
async function familyOf(
  ctx: QueryCtx,
  guard: ViewBudget,
  seat: ViewAccess,
  top: Doc<'projects'>,
): Promise<Family> {
  const children: Doc<'projects'>[] = []
  if (inMetaTree(top, top)) {
    const range: StepRange<Doc<'projects'>> = {
      open: (from) =>
        ctx.db
          .query('projects')
          .withIndex('by_parent', (q) =>
            from === undefined
              ? q.eq('parent_id', top.id)
              : q.eq('parent_id', top.id).gte('_creationTime', from),
          ),
    }
    const charge = (child: Doc<'projects'>) => guard.charge(child, PROJECT_ROW_MAX_BYTES)
    for await (const step of inSteps(guard, [range], PROJECT_ROW, charge, FAMILY_ROWS))
      for (const child of step) {
        seat.seen(child, true)
        if (child.org_id === top.org_id) children.push(child)
      }
  }
  const live = children.filter((c) => c.archived_at === undefined)
  const levels = await seat.levels([top.id, ...live.map((c) => c.id)])
  const projects: Family['projects'] = new Map()
  projects.set(top.id, { project: top, live: true, level: levels[0] ?? null })
  for (const child of children)
    projects.set(child.id, { project: child, live: child.archived_at === undefined, level: null })
  for (const [i, child] of live.entries()) {
    const known = projects.get(child.id)
    if (known !== undefined) known.level = levels[i + 1] ?? null
  }
  return { top, projects }
}

/* Projects by creation, then id. */
const byCreation = (a: Doc<'projects'>, b: Doc<'projects'>) =>
  a._creationTime - b._creationTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The family's projects of the scope in their order (see the header),
 * those whose level `fits`. */
function familyScope(
  family: Family,
  own: Doc<'projects'>,
  fits: (level: AccessLevel | null) => level is AccessLevel,
): ScopeProject[] {
  const scope: ScopeProject[] = []
  const at = (id: string) => family.projects.get(id)
  const ownLevel = at(own.id)?.level ?? null
  if (fits(ownLevel)) scope.push({ place: [0], project: own, level: ownLevel })
  const subs = [...family.projects.values()]
    .filter((p) => p.live && p.project.id !== family.top.id && p.project.id !== own.id)
    .map((p) => p.project)
    .sort(byCreation)
  for (const sub of subs) {
    const level = at(sub.id)?.level ?? null
    if (fits(level)) scope.push({ place: [1, sub._creationTime, sub.id], project: sub, level })
  }
  const topLevel = at(family.top.id)?.level ?? null
  if (family.top.id !== own.id && fits(topLevel))
    scope.push({ place: [2], project: family.top, level: topLevel })
  return scope
}

/**
 * The organization's other projects of the scope in their order, which
 * Search all your projects reads. They are its live top-level projects but
 * the family's, by creation, each with its live sub-projects by creation
 * and then itself, those whose level `fits`. It reads every project of the organization and
 * the reader's own grants and team shares once (lib/access.ts
 * projectLevelsForOrg), outside the request's guard, as REST's active list
 * reads its catalogue before its page.
 */
async function otherScope(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  family: Family,
  fits: (level: AccessLevel | null) => level is AccessLevel,
): Promise<ScopeProject[]> {
  const [catalogue, rows] = await Promise.all([orgProjects(ctx, me.org_id), accessRowsOf(ctx, me)])
  const levels = levelsFrom(me, catalogue, rows.grants, rows.shares)
  const live = catalogue.filter((p) => p.org_id === me.org_id && p.archived_at === undefined)
  const under = new Map<string, Doc<'projects'>[]>()
  for (const p of live)
    if (p.parent_id !== undefined) under.set(p.parent_id, [...(under.get(p.parent_id) ?? []), p])
  const scope: ScopeProject[] = []
  const tops = live.filter((p) => p.parent_id === undefined && p.id !== family.top.id)
  for (const top of tops.sort(byCreation)) {
    for (const sub of (under.get(top.id) ?? []).sort(byCreation)) {
      const level = levels.levelOf(sub)
      if (fits(level))
        scope.push({
          place: [3, top._creationTime, top.id, 0, sub._creationTime, sub.id],
          project: sub,
          level,
        })
    }
    const level = levels.levelOf(top)
    if (fits(level)) scope.push({ place: [3, top._creationTime, top.id, 1], project: top, level })
  }
  return scope
}

// --- the reads ----------------------------------------------------------------------

/* The active subtasks of the task with this id, oldest first. */
const activeKids = (ctx: QueryCtx, id: string) =>
  ctx.db
    .query('issues')
    .withIndex('by_parent_archived', (q) => q.eq('parent_id', id).eq('archived_at', undefined))

/* The active tasks of project `id` from creation time `from` on, or all. */
const projectTasks = (ctx: QueryCtx, id: string, from: number | null) =>
  ctx.db.query('issues').withIndex('by_project_archived', (q) => {
    const active = q.eq('project_id', id).eq('archived_at', undefined)
    return from === null ? active : active.gte('_creationTime', from)
  })

/* What one task decides, a row, left out, or a stop before it because the
 * batch cannot hold the reads its checks need. */
type Verdict = { row: RelationCandidate } | 'out' | 'stop'

/* A task's parent as a row states it (lib/workingSet.ts parentLink). */
type Pair = { parent_id?: string; has_hidden_parent: boolean }

/**
 * The task window's relation picker of kind `args.kind` for the task with
 * id `args.issue_id`, one batch (see the header and RelationCandidates). It
 * answers
 *
 * - `{ state: 'ok', rows, next, all_projects, stopped, blocked }`;
 * - `{ state: 'unavailable' }` for a task outside the reader's working
 *   set, alike for every reason, a check of its access a bound of the
 *   reader's own reads stopped included;
 * - `{ state: 'unavailable', reason: 'access_unchecked', message }` where
 *   such a bound stopped a check of the family's projects, or of the
 *   project of a parent a row names, so the picker says Qivo could not
 *   check them;
 * - `{ state: 'refused', message }` for the Parent or Subtasks picker of a
 *   reader without Edit on the task's project, which the write refuses
 *   with the same sentence (model/issues.ts NO_WRITE_ACCESS);
 * - `{ state: 'over_budget' }` where the reads before the batch leave no
 *   room for its whole budget, which only a reader past the design size
 *   meets, or where a batch's reads pass the request's guard, which only
 *   rows stored past the caps can make them do.
 *
 * A search past LIMITS.search is refused with that limit's sentence, and a
 * cursor that is not an earlier batch's of the same reader, task, picker
 * and search with RELATION_CURSOR_REFUSAL, before anything is read.
 * `o.measured` hears the batch's own count once a batch is read, for the
 * measurements at the design size. The query passes none.
 */
export async function readRelationCandidates(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  args: RelationArgs,
  o: { measured?: (batch: Reads) => void } = {},
): Promise<RelationCandidates> {
  const search = limitedText(LIMITS.search, args.search ?? '')
  const key = scopeKey(me, args.issue_id, args.kind, search)
  const from = args.cursor === undefined ? null : await cursorFrom(args.cursor, key)
  if (from !== null && args.kind !== 'link' && comparePlaces(from.at.place, OTHERS) >= 0)
    throw badRequest(RELATION_CURSOR_REFUSAL)
  const guard = viewBudget(ctx, RELATION_PICKER.whole)
  try {
    return await batchOf(ctx, guard, me, args.issue_id, args.kind, search, key, from, o.measured)
  } catch (e) {
    if (isOverBudget(e)) return { state: 'over_budget' }
    if (isAccessUnchecked(e))
      return { state: 'unavailable', reason: ACCESS_UNCHECKED, message: e.data.message }
    throw e
  }
}

/* readRelationCandidates once its arguments are checked. */
async function batchOf(
  ctx: QueryCtx,
  guard: ViewBudget,
  me: Doc<'profiles'>,
  issueId: string,
  kind: RelationKind,
  search: string,
  key: string,
  from: Cursor | null,
  measured?: (batch: Reads) => void,
): Promise<RelationCandidates> {
  const at = from?.at ?? null
  const seat = viewAccess(ctx, guard, me)
  const opened = await openedTask(ctx, guard, seat, issueId)
  if (opened === null) return UNAVAILABLE
  const open = opened.task
  const editsOpen = levelRank(opened.level) >= levelRank('user')
  if (kind !== 'link' && !editsOpen) return { state: 'refused', message: NO_WRITE_ACCESS }
  const { blocked, linked } = await blockOf(ctx, guard, open, kind)
  const blockedBatch = (b: RelationBlock): RelationCandidates => ({
    state: 'ok',
    rows: [],
    next: null,
    all_projects: null,
    stopped: false,
    blocked: b,
  })
  // a reader who edits the opened task learns its block at once, as the
  // write would refuse them for it; a Linked tasks reader without Edit on
  // it learns it only from a batch that could offer them a task, since the
  // count holds links to tasks they may not see
  if (blocked !== null && (kind !== 'link' || editsOpen)) return blockedBatch(blocked)

  const family = await familyOf(ctx, guard, seat, opened.top)
  // Edit for Parent and Subtasks, and for Linked tasks unless the reader
  // edits the opened task, when any project they see will do
  const fits = (level: AccessLevel | null): level is AccessLevel =>
    kind === 'link' && editsOpen ? level !== null : levelRank(level) >= levelRank('user')
  const others = at !== null && comparePlaces(at.place, OTHERS) >= 0
  const scope = others
    ? await otherScope(ctx, me, family, fits)
    : familyScope(family, opened.project, fits)
  if (blocked !== null && scope.length > 0) return blockedBatch(blocked)
  // the batch's whole budget, after every read before it, the catalogue's
  // included, which the guard sees at its next look
  guard.forget()
  if ((await guard.count(RELATION_PICKER.reads, 1)) < 1) throw new OverBudget()
  const count = batchCount(RELATION_PICKER.reads)

  const matches = allWordsMatcher(search)
  const ref = parseIssueRef(search)
  const typed = ref !== null && 'num' in ref ? ref.num : null
  // the tasks the batch looked at, which the reader is shown, and the
  // parents of those, which have a subtask
  const read = new Set<string>()
  const parents = new Set<string>()
  // each parent's pair as the reader is shown it, read once
  const pairs = new Map<string, Pair>()

  /* The parent of `task` as the reader is shown it, or 'stop'. */
  const pairOf = async (task: Doc<'issues'>): Promise<Pair | 'stop'> => {
    const id = task.parent_id
    if (id === undefined) return { has_hidden_parent: false }
    if (read.has(id)) return parentLink(task, () => true)
    // the parent by id and one access question, taken whatever the parent
    // is and wherever it sits, also when an earlier candidate read it, so
    // a hidden parent moves no stop; the guard takes only the real reads
    if (!count.fits(PARENT)) return 'stop'
    count.take(PARENT)
    const known = pairs.get(id)
    if (known !== undefined) return known
    await guard.take(HIDDEN_BY_ID)
    const parent = await byId(ctx, 'issues', id)
    if (parent !== null) guard.charge(parent, TASK_ROW_MAX_BYTES)
    let shown = false
    if (parent !== null && parent.org_id === me.org_id && parent.archived_at === undefined) {
      const home = family.projects.get(parent.project_id)
      if (home !== undefined) shown = home.live && home.level !== null
      else {
        // a parent outside the family, only in data stored before the
        // rule that a subtask stays in its parent's top-level project;
        // viewAccess takes the question's room from the guard itself
        shown = (await seat.holds([parent]))[0] === true
      }
    }
    const pair = parentLink(task, () => shown)
    pairs.set(id, pair)
    return pair
  }

  /* Whether `task`, a task of scope project `p`, may be picked, by the
   * write's rules, and its row. */
  const decide = async (task: Doc<'issues'>, p: ScopeProject): Promise<Verdict> => {
    if (task.id === open.id) return 'out'
    let pair: Pair | null = null
    if (kind === 'parent') {
      if (task.parent_id !== undefined || task.id === open.parent_id) return 'out'
      // model/issues.ts subtaskCount, active subtasks in any project
      if (!count.fits(SUBTASKS)) return 'stop'
      count.take(SUBTASKS)
      await guard.take(SUBTASKS)
      const kids = await activeKids(ctx, task.id).take(LIMITS.subtasks.max)
      for (const kid of kids) guard.charge(kid, TASK_ROW_MAX_BYTES)
      if (kids.length >= LIMITS.subtasks.max) return 'out'
    } else if (kind === 'subtask') {
      if (task.parent_id === open.id || parents.has(task.id)) return 'out'
      // model/issues.ts hasAnySubtask, archived ones included; a subtask
      // created under the rule of one level has none (withoutSubtasks)
      if (!withoutSubtasks(task)) {
        if (!count.fits(HIDDEN_BY_ID)) return 'stop'
        count.take(HIDDEN_BY_ID)
        await guard.take(HIDDEN_BY_ID)
        const kid = await ctx.db
          .query('issues')
          .withIndex('by_parent', (q) => q.eq('parent_id', task.id))
          .first()
        if (kid !== null) {
          guard.charge(kid, TASK_ROW_MAX_BYTES)
          return 'out'
        }
      }
      const got = await pairOf(task)
      if (got === 'stop') return 'stop'
      pair = got
    } else if (linked.has(task.id)) return 'out'
    return { row: { ...taskFields(task), level: p.level, ...pair } }
  }

  const rows: RelationCandidate[] = []
  // a typed task ID, looked up in the first batch only, at one cost
  // whatever it names
  if (typed !== null && at === null) {
    if (!count.fits(TYPED)) throw new OverBudget()
    count.take(TYPED)
    await guard.take(HIDDEN_BY_ID)
    const found = await ctx.db
      .query('issues')
      .withIndex('by_org_num', (q) => q.eq('org_id', me.org_id).eq('num', typed))
      .unique()
    if (found !== null) guard.charge(found, TASK_ROW_MAX_BYTES)
    const home =
      found === null || found.archived_at !== undefined
        ? undefined
        : await typedHome(seat, scope, family, found, kind, fits)
    if (found !== null && home !== undefined) {
      guard.refund(found, TASK_ROW_MAX_BYTES)
      const verdict = await decide(found, home)
      if (verdict === 'stop') throw new OverBudget()
      if (verdict !== 'out') {
        // a task the reader could link, so the block holds for them
        if (blocked !== null) return blockedBatch(blocked)
        rows.push({ ...verdict.row, exact: true })
      }
    }
  }
  // the typed task, once a batch answered it, is left out of every scan;
  // until then a scan offers it where it meets it, as after a check of its
  // project that a bound stopped
  const typedTaken = from?.typedTaken ?? rows.some((r) => r.exact === true)

  const scan = await scanScope(
    ctx,
    guard,
    count,
    scope,
    at,
    async (task, p) => {
      read.add(task.id)
      if (task.parent_id !== undefined) parents.add(task.parent_id)
      if ((typedTaken && task.num === typed) || !matches(`${issueKey(task.num)}\n${task.title}`))
        return 'out'
      return await decide(task, p)
    },
    RELATION_PICKER.rows - rows.length,
  )
  rows.push(...scan.rows)
  measured?.(count.used)
  const next = scan.end ? null : await cursorOf(key, { at: scan.at, typedTaken })
  const familyEnd = kind === 'link' && !others && next === null
  const allAt: Position = { place: OTHERS, time: null, ids: [] }
  return {
    state: 'ok',
    rows,
    next,
    all_projects: familyEnd ? await cursorOf(key, { at: allAt, typedTaken }) : null,
    stopped: scan.stopped,
    blocked: null,
  }
}

/**
 * The scan of a batch. It reads the active tasks of the projects of
 * `scope` from position `from` on, one project after another, each by
 * creation, and gives each task to `decide` in that order, until `want`
 * rows, until RELATION_PICKER.scan tasks were looked at, or until the
 * batch's count stops a read (a step's rows, or a check `decide` answers
 * 'stop' for). It
 * answers the rows, the position after the last task whose answer is
 * final, whether it read the scope to its end, and whether it stopped short
 * of `want` rows before that end.
 *
 * A step reads the current project's range with as many rows as the count
 * holds at lib/viewReads.ts ROW, at most STEP.rows, and, after steps whose
 * every range ended, the next projects' side by side. A step whose range
 * does not end leaves the batch inside that project and drops what it read
 * of the projects after it, which the count still holds. A range goes on
 * from the creation time of the last task looked at and reads the tasks at
 * that instant again, skipped by id, since Convex does not make creation
 * times unique.
 */
async function scanScope(
  ctx: QueryCtx,
  guard: ViewBudget,
  count: BatchCount,
  scope: readonly ScopeProject[],
  from: Position | null,
  decide: (task: Doc<'issues'>, p: ScopeProject) => Promise<Verdict>,
  want: number,
): Promise<{ rows: RelationCandidate[]; at: Position; end: boolean; stopped: boolean }> {
  const queue = from === null ? scope : scope.filter((p) => comparePlaces(p.place, from.place) >= 0)
  // where the batch stands, after the tasks of `at`'s project at its
  // instant, or at the start of its project
  let at: Position = from ?? { place: queue[0]?.place ?? [0], time: null, ids: [] }
  const rows: RelationCandidate[] = []
  if (want <= 0) return { rows, at, end: false, stopped: false }
  let looked = 0
  let width = 1
  let pi = 0
  while (pi < queue.length) {
    const first = queue[pi] as ScopeProject
    // the first project goes on from `at` when `at` is inside it
    const resume = comparePlaces(first.place, at.place) === 0 && at.time !== null ? at : null
    const again = resume?.ids.length ?? 0
    const left = RELATION_PICKER.scan - looked
    if (left <= 0) return { rows, at, end: false, stopped: true }
    // as many projects as the count holds STEP.share rows each for, and at
    // least a row each, beside their ranges and the rows the first reads
    // again
    const share = Math.floor(
      Math.max(0, count.room(ROW, plus(RANGE, times(ROW, again)))) / STEP.share,
    )
    let k = Math.max(1, Math.min(width, queue.length - pi, share))
    let per = 0
    for (; k > 0; k = k > 1 ? 1 : 0) {
      const n = count.room(ROW, plus(times(RANGE, k), times(ROW, again)))
      per = Math.min(STEP.rows, left, Math.floor(Math.max(0, n) / k))
      if (per >= 1) break
    }
    if (k === 0) return { rows, at, end: false, stopped: true }
    const step = queue.slice(pi, pi + k)
    const asks = step.map((_, i) => per + (i === 0 ? again : 0))
    const asked = asks.reduce((n, m) => n + m, 0)
    await guard.take(plus(times(RANGE, k), times(ROW, asked)))
    const got = await Promise.all(
      step.map((p, i) =>
        projectTasks(ctx, p.project.id, i === 0 && resume !== null ? resume.time : null).take(
          asks[i] as number,
        ),
      ),
    )
    for (const tasks of got)
      count.rows(
        tasks,
        tasks.reduce((n, t) => n + sizeOf(t), 0),
      )
    guard.giveBack(ROW, asked - got.reduce((n, tasks) => n + tasks.length, 0))
    let ended = true
    for (const [i, p] of step.entries()) {
      const tasks = got[i] as Doc<'issues'>[]
      const skip = i === 0 && resume !== null ? resume : null
      for (const [j, task] of tasks.entries()) {
        if (skip !== null && task._creationTime === skip.time && skip.ids.includes(task.id))
          continue
        if (looked >= RELATION_PICKER.scan) return { rows, at, end: false, stopped: true }
        const verdict = await decide(task, p)
        if (verdict === 'stop') return { rows, at, end: false, stopped: true }
        looked += 1
        at = after(at, p.place, task)
        if (verdict !== 'out') rows.push(verdict.row)
        if (rows.length >= want) {
          // the scope's end when this was its last task
          const end =
            j === tasks.length - 1 &&
            tasks.length < (asks[i] as number) &&
            pi + i === queue.length - 1
          return { rows, at, end, stopped: false }
        }
      }
      if (tasks.length >= (asks[i] as number)) {
        // the range goes on, so the batch stays in this project and drops
        // what the step read of the projects after it
        pi += i
        ended = false
        break
      }
      // every task of this project is looked at, so the batch stands at
      // the start of the next
      const following = queue[pi + i + 1]
      if (following !== undefined) at = { place: following.place, time: null, ids: [] }
    }
    if (ended) pi += step.length
    width = ended ? Math.min(STEP.projects, width * 2) : 1
  }
  return { rows, at, end: true, stopped: false }
}

/* The size of `task` as Convex counts a document. */
const sizeOf = (task: Doc<'issues'>): number =>
  getDocumentSize(task as Parameters<typeof getDocumentSize>[0])

/* The position just after `task`, the next task looked at in the project
 * at `place`, from position `p`. */
function after(p: Position, place: Place, task: Doc<'issues'>): Position {
  const same = comparePlaces(p.place, place) === 0 && p.time === task._creationTime
  return { place, time: task._creationTime, ids: same ? [...p.ids, task.id] : [task.id] }
}

/**
 * The scope project in which a typed task ID's task `task`, active and
 * read by its number, is a candidate. That is its project of the scope, or
 * for Linked tasks any live project of the organization outside the family
 * whose level `fits`, asked within the lookup's cost (TYPED). A check a
 * bound stopped leaves it without one, as for a task the reader cannot
 * see. Undefined when there is none.
 */
async function typedHome(
  seat: ViewAccess,
  scope: readonly ScopeProject[],
  family: Family,
  task: Doc<'issues'>,
  kind: RelationKind,
  fits: (level: AccessLevel | null) => level is AccessLevel,
): Promise<ScopeProject | undefined> {
  if (task.org_id !== seat.me.org_id) return undefined
  const inScope = scope.find((p) => p.project.id === task.project_id)
  if (inScope !== undefined || kind !== 'link' || family.projects.has(task.project_id))
    return inScope
  try {
    const [live] = await seat.live([task.project_id])
    if (live !== true) return undefined
    const [level] = await seat.levels([task.project_id])
    const project = await seat.project(task.project_id)
    if (project === null || level === undefined || !fits(level)) return undefined
    return { place: OTHERS, project, level }
  } catch (e) {
    if (isAccessUnchecked(e)) return undefined
    throw e
  }
}

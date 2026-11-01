/* The Overview's stored-fact figures (schema.ts overview_counts): for each
 * sub-project, and for each person in it, the leaves among its active
 * tasks by status, the paused leaves and the remaining hours of the leaves
 * not Done, in whole tenths. They keep Completion, In progress, In review,
 * the status distribution, Paused, and a health row's Completion, Left and
 * Paused whole at any size, where a read of the tasks would stop at a
 * budget. Figures that follow the day or the reader, Overdue and the
 * projections, are read from the tasks within a budget and answer
 * "unavailable" past it; they are never counted here.
 *
 * A task is a leaf unless it has an active subtask in a live project
 * (lib/liveTasks.ts countsAsSubtask), whoever reads it, as the app's
 * P.isGroup decides, and a leaf's owner is lib/review.ts taskOwnerId's.
 * overview_tasks holds, for each active task, what the counts hold for it:
 * whether a group, and the leaf it adds to its rows (its slot). Each write
 * reconciles a task with that row (reconcileTask), moving the rows by the
 * difference between what the row holds and what the task gives now, so
 * every way of changing the counts can run in any order and a second run
 * finds nothing to do. What reconciles:
 *
 *   an insert   model/descriptions.ts insertTask: a create, a task written
 *               back from Deleted items, a seed
 *   a patch     model/descriptions.ts patchTask and patchTaskRow, which
 *               every writer of a task's status, pause, hours, assignee,
 *               reviewer, parent, project or archived state goes through
 *   a delete    model/deletedItems.ts deleteLive, a move to Deleted items
 *
 * each of them for the task it writes (tallyOverview), and for the parent
 * it stops or starts making a group, whose subtasks it reads again.
 *
 * A project archived, restored, moved to Deleted items or revealed again
 * by a restore changes which of its tasks' parents are groups, and whether
 * its tasks count at all, without a task write. It starts background steps
 * (startRegroup, overviewRegroup.ts) that reconcile its tasks and their
 * parents, which share its top-level project (model/issues.ts
 * parentChainCheck), and that top-level project's counts answer
 * `counting` until they end.
 *
 * An organization is counted from its org_ready overview_counts_at: from
 * its creation (model/orgs.ts insertOrgRows), from a Northstar seed's last
 * step (countWhole), or once internal/overviewCountsBackfill has reconciled
 * every task. Until then writes leave its counts alone, as they do while
 * that backfill deletes its rows to count again. The teardowns that delete
 * an organization's work unset the stamp and delete its counts before its
 * tasks (OVERVIEW_TABLES).
 *
 * A sub-project's leaves, and each person's leaves in it, are split over
 * OVERVIEW_SHARDS rows by task number (rowKeysOf), so two concurrent edits
 * there write the same row about a quarter as often. On a local backend,
 * two and four writers changing statuses of one person's tasks in one
 * sub-project in tight loops lost none and at most 1.3% of their calls to
 * write conflicts after Convex's retries, and of five people's tasks none
 * and 0.3% (2026-11-01). With one row a person in a sub-project they lost
 * 5% to 27%. People editing by hand stay far below those rates. If Convex
 * Insights shows conflicts on overview_counts, the next step is delta rows
 * that writers insert and never read, which a scheduled step folds in.
 *
 * A row that would go below zero is a bug. It is written as it is and
 * logged, and the readers answer `counting` for its scope, never a clamped
 * figure. internal/overviewCountsBackfill's dry run finds it, and a
 * recount mends it, as after a rollback to a release that kept no counts. */

import { makeFunctionReference } from 'convex/server'
import { getDocumentSize } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { uncountedWriter } from '../lib/demo'
import { ISSUE_STATUSES, type IssueStatus } from '../lib/enums'
import { taskOwnerId } from '../lib/review'
import { DOCUMENT_MAX_BYTES } from './comments'

type Reader = QueryCtx['db']
type Writer = MutationCtx['db']

/** How many rows a sub-project's leaves, and each person's leaves in it,
 * are split over by task number (see the header on write conflicts). */
export const OVERVIEW_SHARDS = 4

/** Leaves by stored status, the paused leaves, and the remaining hours of
 * the leaves not Done in whole tenths. */
export type LeafCounts = {
  leaves: Record<IssueStatus, number>
  paused: number
  left_tenths: number
}

/** Counts of no leaf. */
export const noCounts = (): LeafCounts => ({
  leaves: { backlog: 0, todo: 0, progress: 0, review: 0, done: 0 },
  paused: 0,
  left_tenths: 0,
})

/** `a` plus `by` times `b`. */
export function addCounts(a: LeafCounts, b: LeafCounts, by = 1): LeafCounts {
  const leaves = { ...a.leaves }
  for (const s of ISSUE_STATUSES) leaves[s] += by * b.leaves[s]
  return {
    leaves,
    paused: a.paused + by * b.paused,
    left_tenths: a.left_tenths + by * b.left_tenths,
  }
}

/** Whether every figure of `c` is zero. */
export const isZero = (c: LeafCounts): boolean =>
  c.paused === 0 && c.left_tenths === 0 && ISSUE_STATUSES.every((s) => c.leaves[s] === 0)

/** Whether any figure of `c` is below zero, which no write may leave. */
export const isNegative = (c: LeafCounts): boolean =>
  c.paused < 0 || c.left_tenths < 0 || ISSUE_STATUSES.some((s) => c.leaves[s] < 0)

// --- where the counts stand ------------------------------------------------------

/** Whether an organization's counts are kept, and the backfill's run over
 * it, if any. */
export type OrgCountState = { stamped: boolean; run: Doc<'overview_count_runs'> | null }

/** The organization's running count (overview_count_runs), or null. */
export const overviewCountRun = (db: Reader, orgId: string) =>
  db
    .query('overview_count_runs')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .unique()

/** The regroup of top-level project `familyId` (overview_regroups), or
 * null. */
export const overviewRegroupOf = (db: Reader, familyId: string) =>
  db
    .query('overview_regroups')
    .withIndex('by_family', (q) => q.eq('family_id', familyId))
    .unique()

/** Whether the organization's counts are kept (org_ready
 * overview_counts_at), and the run counting it. */
export async function orgCountState(db: Reader, orgId: string): Promise<OrgCountState> {
  const ready = await db
    .query('org_ready')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .unique()
  return {
    stamped: ready?.overview_counts_at !== undefined,
    run: await overviewCountRun(db, orgId),
  }
}

/** Whether a write may move an organization's counts in `state`: while it
 * is counted, and while the backfill reconciles its tasks, but not while
 * the backfill deletes its rows to count again. */
export const keptIn = (state: OrgCountState): boolean =>
  state.run === null ? state.stamped : state.run.counting

/* Each transaction's organization states, by its database writer, which
 * one transaction reads once: only the backfill's steps, a seed's last
 * step and the teardowns change them, and none writes a task in the same
 * transaction after doing so. A public demo's writer and the one under it
 * are one transaction's (lib/demo.ts uncountedWriter). */
const states = new WeakMap<object, Map<string, Promise<OrgCountState>>>()

/* orgCountState, once a transaction. */
function stateOf(db: Writer, orgId: string): Promise<OrgCountState> {
  const key = uncountedWriter(db)
  let byOrg = states.get(key)
  if (byOrg === undefined) {
    byOrg = new Map()
    states.set(key, byOrg)
  }
  let state = byOrg.get(orgId)
  if (state === undefined) {
    state = orgCountState(db, orgId)
    byOrg.set(orgId, state)
  }
  return state
}

/** Whether writes in this transaction move organization `orgId`'s counts
 * (keptIn). A writer asks before it reads anything for the counts, so a
 * write to an organization not counted, such as a seed's, costs nothing
 * more (orgCountState once a transaction). */
export async function countsKept(db: Writer, orgId: string): Promise<boolean> {
  return keptIn(await stateOf(db, orgId))
}

// --- leaves and their rows ---------------------------------------------------------

/** Where one leaf counts: its sub-project's row of its shard and its
 * owner's row of that shard there, and what it adds. As overview_tasks
 * stores it. */
export type Slot = NonNullable<Doc<'overview_tasks'>['slot']>

/** The slot of `task` in `project`, as both are now, or undefined where it
 * counts nowhere: archived, a group (`group`), or in no sub-project of its
 * organization, as a task older code stored on a top-level project is in
 * no Overview scope, and a task whose project is in Deleted items. */
export function slotOf(
  task: Doc<'issues'>,
  project: Doc<'projects'> | null,
  group: boolean,
): Slot | undefined {
  if (task.archived_at !== undefined || group) return undefined
  if (project === null || project.parent_id === undefined || project.org_id !== task.org_id)
    return undefined
  const owner = taskOwnerId(task, false)
  return {
    project_id: project.id,
    project_at: project._creationTime,
    ...(owner === undefined ? {} : { owner_id: owner }),
    shard: task.num % OVERVIEW_SHARDS,
    status: task.status,
    paused: task.paused,
    left_tenths: task.status === 'done' ? 0 : Math.round((task.remaining_hours ?? 0) * 10),
  }
}

/** What `slot` adds to each of its rows. */
export function countsOf(slot: Slot): LeafCounts {
  const counts = noCounts()
  counts.leaves[slot.status] = 1
  counts.paused = slot.paused ? 1 : 0
  counts.left_tenths = slot.left_tenths
  return counts
}

/** A count row's key: its sub-project, its owner (none for a sub-project
 * row) and its shard. */
export type RowKey = { project_id: string; owner_id: string | undefined; shard: number }

/** The keys of the rows `slot` adds to: its sub-project's row of its shard
 * and, for a leaf with an owner, the owner's row of the same shard. */
export function rowKeysOf(slot: Slot): RowKey[] {
  const key = { project_id: slot.project_id, owner_id: undefined, shard: slot.shard }
  return slot.owner_id === undefined ? [key] : [key, { ...key, owner_id: slot.owner_id }]
}

/** The count row with `key`, or null. */
export const countRow = (db: Reader, key: RowKey) =>
  db
    .query('overview_counts')
    .withIndex('by_project_owner_shard', (q) =>
      q.eq('project_id', key.project_id).eq('owner_id', key.owner_id).eq('shard', key.shard),
    )
    .unique()

/** Moves of count rows, added up by row before any is written, so a write
 * whose leaf stays in its rows writes each once. */
export class CountMoves {
  private readonly rows = new Map<
    string,
    { key: RowKey; org_id: string; project_at: number; counts: LeafCounts }
  >()

  /** Adds `by` times `slot`'s counts to its sub-project's row and its
   * owner's, of organization `orgId`. */
  add(orgId: string, slot: Slot, by: 1 | -1): void {
    const at = { org_id: orgId, project_at: slot.project_at }
    for (const key of rowKeysOf(slot)) this.addRow(key, at, countsOf(slot), by)
  }

  /** Adds `by` times `counts` to the row with `key` of a sub-project of
   * organization `at.org_id` whose row was created at `at.project_at`. */
  addRow(
    key: RowKey,
    at: { org_id: string; project_at: number },
    counts: LeafCounts,
    by = 1,
  ): void {
    const id = `${key.project_id}|${key.owner_id ?? ''}|${key.shard}|${at.project_at}`
    const row = this.rows.get(id) ?? { key, ...at, counts: noCounts() }
    row.counts = addCounts(row.counts, counts, by)
    this.rows.set(id, row)
  }

  /** Writes every row that moved. A row of an earlier project with the
   * same id (project_at) starts again from zero; a missing row is inserted
   * without spending a public demo's record limit (lib/demo.ts
   * uncountedWriter). Logs a row that goes below zero (see the header). */
  async apply(db: Writer): Promise<void> {
    for (const { key, org_id, project_at, counts } of this.rows.values()) {
      if (isZero(counts)) continue
      const row = await countRow(db, key)
      const fresh = row !== null && row.org_id === org_id && row.project_at === project_at
      const next = addCounts(fresh ? row : noCounts(), counts)
      if (isNegative(next))
        console.error('An overview count went below zero', { org_id, ...key, project_at, next })
      const doc = {
        org_id,
        project_id: key.project_id,
        project_at,
        ...(key.owner_id === undefined ? {} : { owner_id: key.owner_id }),
        shard: key.shard,
        ...next,
      }
      if (row === null) await uncountedWriter(db).insert('overview_counts', { ...doc, revision: 0 })
      else await db.replace(row._id, { ...doc, revision: row.revision + 1 })
    }
    this.rows.clear()
  }
}

// --- reconciling a task --------------------------------------------------------------

/** The overview_tasks row of the task with this id, or null. */
export const taskRecord = (db: Reader, taskId: string) =>
  db
    .query('overview_tasks')
    .withIndex('by_task', (q) => q.eq('task_id', taskId))
    .unique()

/** Whether the project with this id is live: it exists and is not
 * archived (lib/liveTasks.ts). */
async function isLive(db: Reader, projectId: string): Promise<boolean> {
  const project = await byId({ db }, 'projects', projectId)
  return project !== null && project.archived_at === undefined
}

/** Whether the task with id `taskId` of organization `orgId` has an active
 * subtask in a live project, read a subtask at a time until one is found,
 * so it usually reads one. `live` holds the projects known live or not,
 * which a caller checking many tasks shares. */
export async function hasLiveSubtask(
  db: Reader,
  taskId: string,
  orgId: string,
  live: Map<string, boolean> = new Map(),
): Promise<boolean> {
  const kids = db
    .query('issues')
    .withIndex('by_parent_archived', (q) => q.eq('parent_id', taskId).eq('archived_at', undefined))
  for await (const kid of kids) {
    if (kid.org_id !== orgId) continue
    let known = live.get(kid.project_id)
    if (known === undefined) {
      known = await isLive(db, kid.project_id)
      live.set(kid.project_id, known)
    }
    if (known) return true
  }
  return false
}

/** Whether two slots add the same to the same rows. */
const sameSlot = (a: Slot | undefined, b: Slot | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.project_id === b.project_id &&
    a.project_at === b.project_at &&
    a.owner_id === b.owner_id &&
    a.shard === b.shard &&
    a.status === b.status &&
    a.paused === b.paused &&
    a.left_tenths === b.left_tenths)

/** How reconcileTask settles whether a task is a group: by reading its
 * subtasks (`read`), from what its overview_tasks row holds, reading them
 * only for a task without one (`kept`), or as a task just created with a
 * new id, which has none (`fresh`). */
export type GroupBy = 'read' | 'kept' | 'fresh'

/**
 * Reconciles task `taskId` of organization `orgId` with what the counts hold
 * for it (overview_tasks): `task` is the task as stored now, or null when
 * it is gone. An active task's slot moves into its rows and out of the
 * ones the row held, and the row follows; a task gone or archived takes its
 * slot out and its row goes. Whether it is a group follows `by` (GroupBy):
 * a write that cannot have changed its subtasks keeps what the row holds,
 * and one that may have, a task without a row and a background step read
 * them. Answers whether anything moved. Every caller asks countsKept first.
 */
export async function reconcileTask(
  db: Writer,
  orgId: string,
  taskId: string,
  task: Doc<'issues'> | null,
  by: GroupBy,
): Promise<boolean> {
  const record = await taskRecord(db, taskId)
  // a row of an earlier task with the same id holds nothing
  const held =
    record !== null &&
    record.org_id === orgId &&
    (task === null || record.task_at === task._creationTime)
      ? record
      : null
  const had = held?.slot
  const active = task !== null && task.org_id === orgId && task.archived_at === undefined
  let group = false
  let want: Slot | undefined
  if (active) {
    group =
      by === 'fresh'
        ? false
        : by === 'kept' && held !== null
          ? held.group
          : await hasLiveSubtask(db, task.id, orgId)
    want = slotOf(task, await byId({ db }, 'projects', task.project_id), group)
  }
  if (!sameSlot(had, want)) {
    const moves = new CountMoves()
    if (had !== undefined) moves.add(orgId, had, -1)
    if (want !== undefined) moves.add(orgId, want, 1)
    await moves.apply(db)
  }
  if (!active) {
    if (record !== null) await db.delete(record._id)
    return had !== undefined
  }
  const doc = {
    org_id: orgId,
    task_id: task.id,
    task_at: task._creationTime,
    group,
    ...(want === undefined ? {} : { slot: want }),
  }
  if (record === null) await uncountedWriter(db).insert('overview_tasks', doc)
  else if (held === null || held.group !== group || !sameSlot(had, want))
    await db.replace(record._id, doc)
  return !sameSlot(had, want)
}

// --- the writes ------------------------------------------------------------------

/** One task write: the stored task before it and the task after it, null
 * for none. A task written back from Deleted items is a new document. */
export type TaskWrite = readonly [before: Doc<'issues'> | null, after: Doc<'issues'> | null]

/** The parent that `task` makes a group: its parent while it is active in
 * a live project, else undefined. */
async function parentMade(db: Reader, task: Doc<'issues'> | null): Promise<string | undefined> {
  if (task === null || task.archived_at !== undefined || task.parent_id === undefined) return
  return (await isLive(db, task.project_id)) ? task.parent_id : undefined
}

/**
 * Moves the overview counts for `writes`, each of which turned a stored
 * `before` task into an `after` one in this transaction, in the order they
 * were written: it reconciles the task (reconcileTask), reading its
 * subtasks only where the write may have changed what it knows of them (a
 * task written back or made active again), then each parent the task
 * stopped or started making a group, whose subtasks it reads. `fresh` says
 * `after` is a task just created with a new id, which has no subtask yet.
 * The caller asked countsKept for the organization.
 */
export async function tallyOverview(
  db: Writer,
  writes: readonly TaskWrite[],
  o: { fresh?: boolean } = {},
): Promise<void> {
  for (const [before, after] of writes) {
    const task = after ?? before
    if (task === null || !(await countsKept(db, task.org_id))) continue
    const back =
      after !== null &&
      after.archived_at === undefined &&
      (before === null ||
        before.archived_at !== undefined ||
        before._creationTime !== after._creationTime)
    await reconcileTask(
      db,
      task.org_id,
      task.id,
      after,
      o.fresh === true ? 'fresh' : back ? 'read' : 'kept',
    )
    const was = await parentMade(db, before)
    const now = await parentMade(db, after)
    if (was === now) continue
    for (const parentId of [was, now]) {
      if (parentId === undefined) continue
      const parent = await byId({ db }, 'issues', parentId)
      if (parent !== null && parent.org_id === task.org_id)
        await reconcileTask(db, task.org_id, parent.id, parent, 'read')
    }
  }
}

// --- projects whose presence or liveness changed ------------------------------------

/* overviewRegroup.ts step, referenced by name, so this module does not
 * import the steps' module. */
const regroupStepRef = makeFunctionReference<'mutation', { family_id: string }, null>(
  'overviewRegroup:step',
)

/**
 * Starts reconciling the tasks of `projects`, projects of top-level project
 * `family` (itself among them when it is one of them) just archived,
 * restored, moved to Deleted items or revealed again, and the parents of
 * those tasks, in the transaction that changed them. A regroup of the same
 * top-level project under way reads them after its own. An organization
 * whose counts are not kept needs none.
 */
export async function startRegroup(
  ctx: MutationCtx,
  family: Pick<Doc<'projects'>, 'id' | 'org_id'>,
  projects: readonly string[],
): Promise<void> {
  if (projects.length === 0) return
  if (!keptIn(await orgCountState(ctx.db, family.org_id))) return
  const now = new Date().toISOString()
  const row = await overviewRegroupOf(ctx.db, family.id)
  if (row !== null) {
    await ctx.db.patch(row._id, { projects: [...row.projects, ...projects], progress_at: now })
    return
  }
  await ctx.db.insert('overview_regroups', {
    org_id: family.org_id,
    family_id: family.id,
    projects: [...projects],
    at: 0,
    progress_at: now,
  })
  await ctx.scheduler.runAfter(0, regroupStepRef, { family_id: family.id })
}

// --- counting from the tasks --------------------------------------------------

/** One page of an organization's active tasks: those it read, the
 * _creationTime it read through, and their bytes. */
export type TaskPage = { tasks: Doc<'issues'>[]; through: number }

/** One page of the organization's active tasks created after `after`, or
 * null when no active task is past `after`. The page reads tasks in parts,
 * each no larger than its unspent bytes could hold at Convex's document
 * size limit, and ends at `limits.tasks` tasks or `limits.bytes`. Every
 * task with a part's last _creationTime is in it, should two share one, as
 * a seed can leave. */
export async function taskPage(
  db: Reader,
  orgId: string,
  after: number,
  limits: { tasks: number; bytes: number },
): Promise<TaskPage | null> {
  let through = after
  let bytes = 0
  const tasks: Doc<'issues'>[] = []
  for (;;) {
    const fits = Math.max(1, Math.floor((limits.bytes - bytes) / DOCUMENT_MAX_BYTES))
    const want = Math.min(limits.tasks - tasks.length, fits)
    const from = through
    const part = await db
      .query('issues')
      .withIndex('by_org_archived', (q) =>
        q.eq('org_id', orgId).eq('archived_at', undefined).gt('_creationTime', from),
      )
      .take(want)
    const last = part.at(-1)?._creationTime
    if (last === undefined) break
    const tail =
      part.length < want
        ? []
        : await db
            .query('issues')
            .withIndex('by_org_archived', (q) =>
              q.eq('org_id', orgId).eq('archived_at', undefined).eq('_creationTime', last),
            )
            .collect()
    for (const row of [...part, ...tail]) bytes += getDocumentSize(row)
    tasks.push(...part.filter((row) => row._creationTime < last || tail.length === 0), ...tail)
    through = last
    if (part.length < want || tasks.length >= limits.tasks || bytes >= limits.bytes) break
  }
  return through === after ? null : { tasks, through }
}

/** A count row's key, with its sub-project's generation. */
export const keyOf = (r: {
  project_id: string
  owner_id?: string | undefined
  shard: number
  project_at: number
}) => `${r.project_id}|${r.owner_id ?? ''}|${r.shard}|${r.project_at}`

/** What `tasks`, active tasks of organization `orgId`, add to each row by
 * key (keyOf), as a recount gives it, each checked for subtasks, and how
 * many of them are groups. A dry run adds the pages up without writing. */
export async function countTasks(
  db: Reader,
  orgId: string,
  tasks: readonly Doc<'issues'>[],
): Promise<{ rows: Map<string, LeafCounts>; groups: number }> {
  const rows = new Map<string, LeafCounts>()
  const projects = new Map<string, Doc<'projects'> | null>()
  let groups = 0
  for (const task of tasks) {
    const group = await hasLiveSubtask(db, task.id, orgId)
    if (group) groups++
    if (!projects.has(task.project_id))
      projects.set(task.project_id, await byId({ db }, 'projects', task.project_id))
    const slot = slotOf(task, projects.get(task.project_id) ?? null, group)
    if (slot === undefined) continue
    for (const k of rowKeysOf(slot)) {
      const key = keyOf({ ...k, project_at: slot.project_at })
      rows.set(key, addCounts(rows.get(key) ?? noCounts(), countsOf(slot)))
    }
  }
  return { rows, groups }
}

/** Writes the overview_tasks rows of `tasks`, active tasks of organization
 * `orgId` that have none, each checked for subtasks, and moves no count: a
 * count that starts from no row, which countRecords then adds up. `live`
 * holds the projects known live or not, shared between calls. */
export async function recordTasks(
  db: Writer,
  orgId: string,
  tasks: readonly Doc<'issues'>[],
  live: Map<string, boolean> = new Map(),
): Promise<void> {
  const projects = new Map<string, Doc<'projects'> | null>()
  for (const task of tasks) {
    if (task.org_id !== orgId || task.archived_at !== undefined) continue
    const group = await hasLiveSubtask(db, task.id, orgId, live)
    if (!projects.has(task.project_id))
      projects.set(task.project_id, await byId({ db }, 'projects', task.project_id))
    const slot = slotOf(task, projects.get(task.project_id) ?? null, group)
    await uncountedWriter(db).insert('overview_tasks', {
      org_id: orgId,
      task_id: task.id,
      task_at: task._creationTime,
      group,
      ...(slot === undefined ? {} : { slot }),
    })
  }
}

/** Writes organization `orgId`'s count rows from its overview_tasks rows,
 * after deleting any it has, and stamps it counted at `now`. Every active
 * task must have its row (recordTasks), and no write may have moved the
 * counts meanwhile, as none does while the organization is not stamped. */
export async function countRecords(db: Writer, orgId: string, now: string): Promise<void> {
  for (const row of await db
    .query('overview_counts')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect())
    await db.delete(row._id)
  const moves = new Map<string, { key: RowKey; project_at: number; counts: LeafCounts }>()
  for (const { slot } of await db
    .query('overview_tasks')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()) {
    if (slot === undefined) continue
    for (const k of rowKeysOf(slot)) {
      const id = keyOf({ ...k, project_at: slot.project_at })
      const row = moves.get(id) ?? { key: k, project_at: slot.project_at, counts: noCounts() }
      row.counts = addCounts(row.counts, countsOf(slot))
      moves.set(id, row)
    }
  }
  for (const { key, project_at, counts } of moves.values())
    await uncountedWriter(db).insert('overview_counts', {
      org_id: orgId,
      project_id: key.project_id,
      project_at,
      ...(key.owner_id === undefined ? {} : { owner_id: key.owner_id }),
      shard: key.shard,
      ...counts,
      revision: 0,
    })
  await stampOverview(db, orgId, now)
}

/** Deletes organization `orgId`'s count and task rows, so a seed counts it
 * from the start (recordTasks, countRecords). */
export async function clearCounts(db: Writer, orgId: string): Promise<void> {
  for (const table of ['overview_counts', 'overview_tasks'] as const)
    for (const row of await db
      .query(table)
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect())
      await db.delete(row._id)
}

/** Counts every active task of organization `orgId` in this transaction,
 * from the start, and stamps it counted at `now` (clearCounts, recordTasks,
 * countRecords), for a small organization whose tasks were written while it
 * was not stamped. A Northstar seed does the same over several steps
 * (model/demoSeed.ts); anything larger goes through
 * internal/overviewCountsBackfill. */
export async function countWhole(db: Writer, orgId: string, now: string): Promise<void> {
  await clearCounts(db, orgId)
  const live = new Map<string, boolean>()
  let after = Number.MIN_SAFE_INTEGER
  for (;;) {
    const page = await taskPage(db, orgId, after, { tasks: 100, bytes: 4 * 1024 * 1024 })
    if (page === null) break
    await recordTasks(db, orgId, page.tasks, live)
    after = page.through
  }
  await countRecords(db, orgId, now)
}

// --- the readers --------------------------------------------------------------------

/** Whether the counts of top-level project `familyId`'s sub-projects are
 * whole: its organization is counted, no backfill counts it, and no
 * regroup of the project is under way. */
export async function countsReady(db: Reader, orgId: string, familyId: string): Promise<boolean> {
  const state = await orgCountState(db, orgId)
  if (!state.stamped || state.run !== null) return false
  return (await overviewRegroupOf(db, familyId)) === null
}

/** The counts `rows` of one project hold for `project`: the sum of those of
 * its current generation (project_at), or null where one went negative. */
export function countsOfRows(
  rows: readonly Doc<'overview_counts'>[],
  project: Pick<Doc<'projects'>, 'org_id' | '_creationTime'>,
): LeafCounts | null {
  let sum = noCounts()
  for (const row of rows) {
    if (row.org_id !== project.org_id || row.project_at !== project._creationTime) continue
    if (isNegative(row)) return null
    sum = addCounts(sum, row)
  }
  return sum
}

/** The rows of sub-project `projectId` without an owner, its shards. */
export const subProjectRows = (db: Reader, projectId: string) =>
  db
    .query('overview_counts')
    .withIndex('by_project_owner_shard', (q) =>
      q.eq('project_id', projectId).eq('owner_id', undefined),
    )
    .take(OVERVIEW_SHARDS)

/**
 * The leaf counts of sub-project `project` (a project of its organization
 * with a parent), or null while they are not whole (countsReady) or a row
 * went negative: never a partial figure or a zero for one not counted. It
 * reads the organization's readiness and the regroup of the project's
 * top-level project (three ranges) and the project's OVERVIEW_SHARDS rows
 * (one range). The counts hold every leaf, whoever reads them; a caller
 * keeps to the sub-projects its reader may see. REST's and MCP's project
 * completion is leaves.done over the sum of the leaves of the readable live
 * sub-projects of a family, a range for each beside the three.
 */
export async function subProjectCounts(
  db: Reader,
  project: Doc<'projects'>,
): Promise<LeafCounts | null> {
  if (project.parent_id === undefined) return null
  if (!(await countsReady(db, project.org_id, project.parent_id))) return null
  return countsOfRows(await subProjectRows(db, project.id), project)
}

/** Every count row of person `ownerId`, by sub-project, up to
 * OVERVIEW_SHARDS rows each, in one range. A caller keeps the rows of the
 * sub-projects the person may see and whose counts are whole
 * (countsReady), each of its current generation (countsOfRows), as My view
 * does. */
export const ownerRows = (db: Reader, ownerId: string) =>
  db.query('overview_counts').withIndex('by_owner_project', (q) => q.eq('owner_id', ownerId))

// --- teardown ------------------------------------------------------------------------

/** The tables that hold an organization's overview counts, which every
 * teardown deletes by organization before the tasks they count. */
export const OVERVIEW_TABLES = [
  'overview_counts',
  'overview_tasks',
  'overview_count_runs',
  'overview_regroups',
] as const

/** Unsets the organization's org_ready overview_counts_at, so its counts
 * read as `counting` and writes leave them alone while a teardown deletes
 * them and the tasks they count. */
export async function unstampOverview(db: Writer, orgId: string): Promise<void> {
  const ready = await db
    .query('org_ready')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .unique()
  if (ready !== null && ready.overview_counts_at !== undefined)
    await db.patch(ready._id, { overview_counts_at: undefined })
}

/** Sets the organization's org_ready overview_counts_at to `now`, for an
 * organization whose counts are whole. */
export async function stampOverview(db: Writer, orgId: string, now: string): Promise<void> {
  const ready = await db
    .query('org_ready')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .unique()
  if (ready === null) await db.insert('org_ready', { org_id: orgId, overview_counts_at: now })
  else if (ready.overview_counts_at === undefined)
    await db.patch(ready._id, { overview_counts_at: now })
}

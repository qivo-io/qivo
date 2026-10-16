/* Deleted items, the trash of tasks and projects.
 *
 * Deleting a task or a project moves it, with every row that travels with
 * it, out of the live tables into deleted_rows (schema.ts), so every reader
 * already treats it as gone. One deleted_items row describes the deletion.
 * Messages are deleted, not stored. Restore writes the rows back; the
 * nightly expiry (TRASH_DAYS after the deletion) and an admin's Delete now
 * purge them for good.
 *
 * Hide first, then drain. A task item's user transaction stores every task
 * row at once (moveTasksToTrash); the tasks' comments, label assignments,
 * follows, attachments and links follow in the same transaction when they
 * fit, otherwise in steps. A project item's user transaction stores the
 * project rows (moveProjectToTrash), which hides every task in them, and
 * steps then move each task: relation rows, messages, children outside the
 * item's projects, then the task row. While an item drains, its leftover
 * rows name a task or project that is absent, so readers skip them.
 *
 * The step machine. Each step spends one budget, TRASH_BUDGET scaled by the
 * job's budget_scale: rows moved, their bytes, task rows moved and index
 * ranges read. `metered` counts the ranges of every read a step makes,
 * notifications included. Progress is counted in rows. A step always moves
 * at least one row, documents without a size cap are read
 * LARGE_ROWS_PER_READ at a time, and most phases read the start of a range
 * again rather than keep a cursor, because moving a row takes it out of the
 * range. The user's mutation spends the first budget itself, so most
 * deletes never schedule a step. Convex drops what a failed step scheduled,
 * so `recoverJobs` restarts a stalled job at half the budget, and an item
 * whose step still fails RETRY.atFloor times at the smallest budget becomes
 * stuck, for an admin's Delete now. A step that commits resets the job to
 * the full budget and no retries.
 *
 * Steps need neither the deleter's nor the restorer's profile: notices and
 * events then go out without an actor. A step returns without work when its
 * item or job is gone, or while its demo organization is being deleted. */

import {
  type FilterBuilder,
  makeFunctionReference,
  type NamedTableInfo,
  type WithoutSystemFields,
} from 'convex/server'
import type { DataModel, Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { demoForOrg, isDemoDeployment } from '../lib/demo'
import { type ProjectType, STORED_TABLES, type StoredTable, type TrashPhase } from '../lib/enums'
import { notFound, rule } from '../lib/functions'
import { logActivity } from './activity'
import { LARGE_ROWS_PER_READ } from './cascade'
import { estimateDocumentBytes } from './demoMetrics'
import { assertCanEdit } from './issues'
import { type NotifyPreload, notifyIssueUpdate } from './messages'
import { newUuid } from './orgs'
import { emitTaskEvent } from './taskEvents'

/** How long a deleted item waits before the nightly expiry purges it. */
export const TRASH_DAYS = 30
const DAY_MS = 86_400_000

/** What one step may do at budget_scale 1: rows moved, deleted or
 * detached, their estimated bytes, task rows moved and index ranges read.
 * A mutable object, so tests can lower it. */
export const TRASH_BUDGET = { rows: 300, bytes: 4 * 1024 * 1024, tasks: 100, ranges: 2500 }

/** Adaptive retries: each restart halves budget_scale down to `floor`, and
 * an item whose step failed `atFloor` more times there becomes stuck. */
export const RETRY = { floor: 1 / 16, atFloor: 5 }

/** A job whose last step committed longer ago than this is restarted. */
export const STALLED_MS = 60_000

/** The items one expiry run starts purging before it schedules the next. */
export const EXPIRY = { batch: 64 }

/* A stored document adds about 300 bytes to the original, and Convex caps a
 * document at 1 MiB. A row whose stored document would pass this is deleted
 * instead, as today's hard delete would have deleted it. */
export const STORED_ROW_MAX_BYTES = 1_000_000

/** The longest reason the app's delete window may send, in characters. */
export const REASON_MAX = 500

const RECOVER_BATCH = 32
/* The most stalled jobs one recovery looks at, oldest progress first (the
 * profileRemovals.ts recover pattern). */
const RECOVER_SCAN = 512
// deleted_tasks rows are small, so a cursor walk reads them in pages.
const TASK_PAGE = 64
// No cap of its own: a read takes as many rows as the budget has left.
const ALL = Number.MAX_SAFE_INTEGER

const stepRef = makeFunctionReference<'mutation', { item_id: string }, null>('deletedItems:step')

type Item = Doc<'deleted_items'>
type Job = Doc<'deleted_item_jobs'>
type Tally = NonNullable<Job['tally']>
/** Where a job is: what a step reads first and saves last. */
type JobState = Pick<Job, 'phase' | 'cursor' | 'tally'>
export type Via = NonNullable<Item['via']>

/** A live document of one of the stored tables, tagged with its table. */
export type LiveRow = { [T in StoredTable]: { table: T; doc: Doc<T> } }[StoredTable]

/* ------------------------------------------------------------ references */

type Stamp = Pick<Item, 'org_id' | 'deleted_at'>

/** Whether `target`, found by an id an item stored, still names what the
 * item named: it is in the item's organization and existed when the item
 * was deleted, so a uuid reused after a purge fails. `type` adds the
 * hierarchy rule where one applies: a task's project is 'project', a
 * sub-project's parent 'meta'. */
export function sameReference<D extends { org_id: string; created_at: string }>(
  target: D | null | undefined,
  item: Stamp,
  type?: ProjectType,
): target is D {
  if (target === null || target === undefined) return false
  if (target.org_id !== item.org_id || target.created_at > item.deleted_at) return false
  return type === undefined || ('type' in target && target.type === type)
}

/** Whether profile `id`, as an item stored it (its deleter, a credential's
 * owner, a stored lead), is the person `me`. */
export const namesProfile = (item: Stamp, id: string | undefined, me: Doc<'profiles'>): boolean =>
  id === me.id && sameReference(me, item)

/* --------------------------------------------------------------- liveness */

/** Where a task is. Live: its row is in issues and its project row in
 * projects. In trash: an item that is not purging holds it, either as a
 * stored task (deleted_tasks) or, while a project item is still moving, as a
 * task left under one of that item's absent projects. Otherwise gone. */
export type TaskWhere =
  | { where: 'live'; issue: Doc<'issues'>; project: Doc<'projects'> }
  | { where: 'trash'; item: Item }
  | { where: 'gone' }

export async function whereIsTask(ctx: QueryCtx, taskId: string): Promise<TaskWhere> {
  const issue = await byId(ctx, 'issues', taskId)
  if (issue !== null) {
    const project = await byId(ctx, 'projects', issue.project_id)
    if (project !== null) return { where: 'live', issue, project }
    const held = await ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) => q.eq('table', 'projects').eq('row_id', issue.project_id))
      .first()
    return inTrash(held === null ? null : await byId(ctx, 'deleted_items', held.item_id))
  }
  const stored = await ctx.db
    .query('deleted_tasks')
    .withIndex('by_task', (q) => q.eq('task_id', taskId))
    .first()
  return inTrash(stored === null ? null : await byId(ctx, 'deleted_items', stored.item_id))
}

const inTrash = (item: Item | null): TaskWhere =>
  item === null || item.state === 'purging' ? { where: 'gone' } : { where: 'trash', item }

/* ----------------------------------------------------------------- budget */

type Budget = {
  rows: number
  bytes: number
  tasks: number
  ranges: number
  /** Set once the step moved a row or scanned a task; until then it never stops. */
  moved: boolean
}

/** One step's budget at `scale`; each count keeps at least one unit. */
function budgetFor(scale: number): Budget {
  return {
    rows: Math.max(1, Math.floor(TRASH_BUDGET.rows * scale)),
    bytes: TRASH_BUDGET.bytes * scale,
    tasks: Math.max(1, Math.floor(TRASH_BUDGET.tasks * scale)),
    ranges: Math.max(1, Math.floor(TRASH_BUDGET.ranges * scale)),
    moved: false,
  }
}

/** Whether a step must stop. Never before its first row, so every step
 * makes progress whatever its budget. */
const spent = (b: Budget): boolean =>
  b.moved && (b.rows <= 0 || b.bytes <= 0 || b.tasks <= 0 || b.ranges <= 0)

/** Charges one row moved, deleted or detached. */
function charge(b: Budget, doc: unknown): void {
  b.rows -= 1
  b.bytes -= estimateDocumentBytes(doc)
  b.moved = true
}

/** Clears the rows `read` returns until the range is empty (true) or the
 * budget is spent (false). `clear` must take each row out of the range,
 * because every read starts at the beginning of the range again
 * (model/cascade.ts sweep, with this file's budget). */
async function drain<Row>(
  b: Budget,
  read: (n: number) => Promise<Row[]>,
  clear: (row: Row) => Promise<void>,
  perRead: number,
): Promise<boolean> {
  while (!spent(b)) {
    const n = Math.max(1, Math.min(b.rows, perRead))
    const rows = await read(n)
    for (const row of rows) {
      await clear(row)
      charge(b, row)
      if (spent(b)) return false
    }
    if (rows.length < n) return true
  }
  return false
}

/* Query methods that read their range. Convex counts each such read, and
 * each db.get, as one of a transaction's 4,096 index ranges. */
const READS = new Set<string | symbol>([
  'collect',
  'take',
  'first',
  'unique',
  'paginate',
  Symbol.asyncIterator,
])

/** `query` whose reads each spend one range of `budget`. The queries it
 * returns (withIndex, filter, order) are metered too. */
function meterQuery<Q extends object>(query: Q, budget: Budget): Q {
  return new Proxy(query, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (READS.has(key)) budget.ranges -= 1
        const result: unknown = value.apply(target, args)
        return typeof result === 'object' && result !== null && 'take' in result
          ? meterQuery(result, budget)
          : result
      }
    },
  })
}

/** `ctx` whose database reads each spend one range of `budget`, wherever in
 * the step they happen. It wraps the database the way lib/demo.ts
 * demoWriter does for its own accounting. */
function metered(ctx: MutationCtx, budget: Budget): MutationCtx {
  const db = new Proxy(ctx.db, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      if (key === 'get')
        return (...args: unknown[]) => {
          budget.ranges -= 1
          return value.apply(target, args)
        }
      if (key === 'query')
        return (...args: unknown[]) => meterQuery(value.apply(target, args), budget)
      return value.bind(target)
    },
  })
  return { ...ctx, db }
}

/* ------------------------------------------------------------ stored rows */

/** The deleted_rows document `live` becomes in `item`, travelling with
 * `ownerId`. `table` and `row.table` both come from the one tag, so they
 * always agree. */
function wrapRow(
  item: Pick<Item, 'id' | 'org_id'>,
  live: LiveRow,
  ownerId: string,
): WithoutSystemFields<Doc<'deleted_rows'>> {
  const { _id, _creationTime, ...doc } = live.doc
  return {
    item_id: item.id,
    org_id: item.org_id,
    table: live.table,
    owner_id: ownerId,
    row_id: 'id' in doc ? doc.id : undefined,
    created_ts: _creationTime,
    storage_id: live.table === 'issue_attachments' ? live.doc.storage_id : undefined,
    project_key: live.table === 'projects' ? live.doc.key : undefined,
    // the tag and its document, so row.table names doc's table
    row: { table: live.table, doc } as Doc<'deleted_rows'>['row'],
  }
}

/** Whether `live`'s stored document would be too large to store. */
const tooLarge = (item: Pick<Item, 'id' | 'org_id'>, live: LiveRow, ownerId: string): boolean =>
  estimateDocumentBytes(wrapRow(item, live, ownerId)) > STORED_ROW_MAX_BYTES

/** Deletes a live row for good, an attachment with its bytes. */
async function discard(ctx: MutationCtx, live: LiveRow): Promise<void> {
  if (live.table === 'issue_attachments') await ctx.storage.delete(live.doc.storage_id)
  await ctx.db.delete(live.doc._id)
}

/** Moves `live` into `item`'s stored rows, travelling with `ownerId`, and
 * deletes it from its table. The only insert into deleted_rows. A row too
 * large to store (STORED_ROW_MAX_BYTES) is deleted instead, an attachment
 * with its bytes; that is logged with the item id and returns false. */
export async function storeRow(
  ctx: MutationCtx,
  item: Pick<Item, 'id' | 'org_id'>,
  live: LiveRow,
  ownerId: string,
): Promise<boolean> {
  const stored = wrapRow(item, live, ownerId)
  if (estimateDocumentBytes(stored) > STORED_ROW_MAX_BYTES) {
    console.error('A deleted item dropped a row too large to store', {
      item_id: item.id,
      table: live.table,
    })
    await discard(ctx, live)
    return false
  }
  await ctx.db.insert('deleted_rows', stored)
  await ctx.db.delete(live.doc._id)
  return true
}

/** One kind of row that travels with a task or a project, read through the
 * same index as the hard deletes (model/cascade.ts), so rows with archive
 * marks and legacy rows without org_id are included. */
type Relation = {
  /** Up to `n` rows from the start of the range. */
  read: (ctx: QueryCtx, ownerId: string, n: number) => Promise<LiveRow[]>
  /** Rows per read: few for documents without a size cap. */
  perRead: number
}

/* A task's rows, in the order a move takes them. Links go both ways; a link
 * between two tasks of the item travels with whichever of them moves first. */
const TASK_ROWS: Relation[] = [
  {
    read: async (ctx, id, n) =>
      (
        await ctx.db
          .query('issue_links')
          .withIndex('by_source', (q) => q.eq('source_id', id))
          .take(n)
      ).map((doc) => ({ table: 'issue_links', doc })),
    perRead: ALL,
  },
  {
    read: async (ctx, id, n) =>
      (
        await ctx.db
          .query('issue_links')
          .withIndex('by_target', (q) => q.eq('target_id', id))
          .take(n)
      ).map((doc) => ({ table: 'issue_links', doc })),
    perRead: ALL,
  },
  {
    read: async (ctx, id, n) =>
      (
        await ctx.db
          .query('issue_labels')
          .withIndex('by_issue', (q) => q.eq('issue_id', id))
          .take(n)
      ).map((doc) => ({ table: 'issue_labels', doc })),
    perRead: ALL,
  },
  {
    read: async (ctx, id, n) =>
      (
        await ctx.db
          .query('issue_subscriptions')
          .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', id))
          .take(n)
      ).map((doc) => ({ table: 'issue_subscriptions', doc })),
    perRead: ALL,
  },
  {
    read: async (ctx, id, n) =>
      (
        await ctx.db
          .query('comments')
          .withIndex('by_issue', (q) => q.eq('issue_id', id))
          .take(n)
      ).map((doc) => ({ table: 'comments', doc })),
    perRead: LARGE_ROWS_PER_READ,
  },
  {
    read: async (ctx, id, n) =>
      (
        await ctx.db
          .query('issue_attachments')
          .withIndex('by_issue', (q) => q.eq('issue_id', id))
          .take(n)
      ).map((doc) => ({ table: 'issue_attachments', doc })),
    perRead: LARGE_ROWS_PER_READ, // file names have no size cap
  },
]

/* A project's own rows besides the project row itself. */
const PROJECT_ROWS: Relation[] = [
  {
    read: async (ctx, id, n) =>
      (
        await ctx.db
          .query('milestones')
          .withIndex('by_project', (q) => q.eq('project_id', id))
          .take(n)
      ).map((doc) => ({ table: 'milestones', doc })),
    perRead: ALL,
  },
  {
    read: async (ctx, id, n) =>
      (
        await ctx.db
          .query('project_access')
          .withIndex('by_project', (q) => q.eq('project_id', id))
          .take(n)
      ).map((doc) => ({ table: 'project_access', doc })),
    perRead: ALL,
  },
  {
    read: async (ctx, id, n) =>
      (
        await ctx.db
          .query('project_team_access')
          .withIndex('by_project', (q) => q.eq('project_id', id))
          .take(n)
      ).map((doc) => ({ table: 'project_team_access', doc })),
    perRead: ALL,
  },
]

/** Whether any of `relations` still holds a row of `ownerId`. */
async function holdsRows(ctx: QueryCtx, relations: Relation[], ownerId: string): Promise<boolean> {
  for (const relation of relations)
    if ((await relation.read(ctx, ownerId, 1)).length > 0) return true
  return false
}

/** Clears every row of `relations` owned by `ownerId` in one transaction,
 * with no budget: for the user's own transaction, as bounded as today's
 * hard delete. `clear` must take each row out of its range. */
async function clearAll(
  ctx: QueryCtx,
  relations: Relation[],
  ownerId: string,
  clear: (live: LiveRow) => Promise<void>,
): Promise<void> {
  const PAGE = 256
  for (const relation of relations) {
    for (;;) {
      const rows = await relation.read(ctx, ownerId, PAGE)
      for (const row of rows) await clear(row)
      if (rows.length < PAGE) break
    }
  }
}

/* ------------------------------------------------------------------- runs */

/** What a running step holds. `ctx` is metered against `budget`. */
type Run = {
  ctx: MutationCtx
  item: Item
  state: JobState
  budget: Budget
  /** The deleter, for notices and events; absent once their profile is gone. */
  actor: Doc<'profiles'> | undefined
  /** Read once per step, when the first detach needs it. */
  preload: NotifyPreload | undefined
  now: string
}

type Mode = 'keep' | 'purge'

/** The tally a move counts into, created on first use. */
function tallyOf(run: Pick<Run, 'state' | 'item'>): Tally {
  run.state.tally ??= emptyTally(run.item)
  return run.state.tally
}

const emptyTally = (item: Pick<Item, 'projects'>): Tally => ({
  tasks: 0,
  archived_tasks: 0,
  dropped_rows: 0,
  projects: item.projects.map((p) => ({ id: p.id, tasks: 0, archived_tasks: 0 })),
})

/** Stores `live` (keep) or deletes it for good (purge). */
async function clearRow(run: Run, live: LiveRow, ownerId: string, mode: Mode): Promise<void> {
  if (mode === 'purge') return await discard(run.ctx, live)
  if (!(await storeRow(run.ctx, run.item, live, ownerId))) tallyOf(run).dropped_rows += 1
}

/** Stores a task row with its deleted_tasks row, and counts it. */
async function storeTask(
  ctx: MutationCtx,
  item: Item,
  tally: Tally,
  task: Doc<'issues'>,
): Promise<void> {
  if (!(await storeRow(ctx, item, { table: 'issues', doc: task }, task.id))) {
    tally.dropped_rows += 1
    return
  }
  const archived = task.archived_at !== undefined
  await ctx.db.insert('deleted_tasks', {
    org_id: item.org_id,
    item_id: item.id,
    task_id: task.id,
    num: task.num,
    title: task.title,
    project_id: task.project_id,
    archived,
  })
  tally.tasks += 1
  if (archived) tally.archived_tasks += 1
  const project = tally.projects.find((p) => p.id === task.project_id)
  if (project !== undefined) {
    project.tasks += 1
    if (archived) project.archived_tasks += 1
  }
}

/** Detaches `child` from its deleted parent with the SET NULL's touch, the
 * 'Detached from its parent' notice and task.updated, as model/cascade.ts
 * deleteIssueDeep does. */
async function detach(
  ctx: MutationCtx,
  child: Doc<'issues'>,
  actor: Doc<'profiles'> | undefined,
  now: string,
  preload?: NotifyPreload,
): Promise<void> {
  await ctx.db.patch(child._id, { parent_id: undefined, updated_at: now })
  const after = await ctx.db.get(child._id)
  if (after === null) return
  await notifyIssueUpdate(ctx, { before: child, after, actor, now, preload })
}

/** The step's NotifyPreload. A step changes no profile, grant, team or
 * project after it starts, so one read serves every detach. */
async function preloadOf(run: Run): Promise<NotifyPreload> {
  run.preload ??= {
    orgProfiles: await run.ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', run.item.org_id))
      .collect(),
    projects: new Map(),
    visibility: new Map(),
  }
  return run.preload
}

/** The project ids of a project item, the projects whose tasks it moves. */
const itemProjectIds = (item: Item): string[] => item.projects.map((p) => p.id)

/** Moves (keep) or deletes (purge) task `task` of a project item with what
 * travels with it, in order: its rows, its messages, its children outside
 * the item's projects, then the task row. True once the task row is gone.
 * A task left half done stays hidden, because its project is absent, and
 * the next step picks it up. A task too large to store is purged instead.
 * Tasks of a deleted project emit no task.deleted. */
async function clearTask(run: Run, task: Doc<'issues'>, mode: Mode): Promise<boolean> {
  const live = { table: 'issues', doc: task } as const
  const how = mode === 'keep' && tooLarge(run.item, live, task.id) ? 'purge' : mode
  for (const relation of TASK_ROWS) {
    const done = await drain(
      run.budget,
      (n) => relation.read(run.ctx, task.id, n),
      (row) => clearRow(run, row, task.id, how),
      relation.perRead,
    )
    if (!done) return false
  }
  const messagesDone = await drain(
    run.budget,
    (n) =>
      run.ctx.db
        .query('messages')
        .withIndex('by_issue_read', (q) => q.eq('issue_id', task.id))
        .take(n),
    (message) => run.ctx.db.delete(message._id),
    ALL,
  )
  if (!messagesDone) return false
  const ids = itemProjectIds(run.item)
  const preload = await preloadOf(run)
  const detached = await drain(
    run.budget,
    (n) =>
      run.ctx.db
        .query('issues')
        .withIndex('by_parent', (q) => q.eq('parent_id', task.id))
        .filter((q) => q.and(...ids.map((id) => q.neq(q.field('project_id'), id))))
        .take(n),
    (child) => detach(run.ctx, child, run.actor, run.now, preload),
    LARGE_ROWS_PER_READ,
  )
  if (!detached) return false
  if (how === 'keep') await storeTask(run.ctx, run.item, tallyOf(run), task)
  else {
    if (mode === 'keep') {
      console.error('A deleted item dropped a task too large to store', {
        item_id: run.item.id,
        task_id: task.id,
      })
      tallyOf(run).dropped_rows += 1
    }
    await run.ctx.db.delete(task._id)
  }
  run.budget.tasks -= 1
  charge(run.budget, task)
  return true
}

/** Clears (keep or purge) the tasks left in project `projectId`. */
async function clearProjectTasks(run: Run, projectId: string, mode: Mode): Promise<boolean> {
  while (!spent(run.budget)) {
    const tasks = await run.ctx.db
      .query('issues')
      .withIndex('by_project', (q) => q.eq('project_id', projectId))
      .take(LARGE_ROWS_PER_READ)
    for (const task of tasks) if (!(await clearTask(run, task, mode))) return false
    if (tasks.length < LARGE_ROWS_PER_READ) return true
  }
  return false
}

/** Clears (keep or purge) project `projectId`'s milestones and grants. */
async function clearProjectRows(run: Run, projectId: string, mode: Mode): Promise<boolean> {
  for (const relation of PROJECT_ROWS) {
    const done = await drain(
      run.budget,
      (n) => relation.read(run.ctx, projectId, n),
      (row) => clearRow(run, row, projectId, mode),
      relation.perRead,
    )
    if (!done) return false
  }
  return true
}

/** Runs `clear` for each task the item stores, in deleted_tasks order from
 * the job's cursor. False when the budget ran out first; the cursor then
 * names the last task fully done. A task the cursor skips on a tie of
 * _creationTime is found by the finish check, which starts over. */
async function eachStoredTask(
  run: Run,
  clear: (taskId: string) => Promise<boolean>,
): Promise<boolean> {
  const cursor = run.state.cursor ?? { index: 0, after: 0 }
  for (;;) {
    if (spent(run.budget)) {
      run.state.cursor = cursor
      return false
    }
    const tasks = await run.ctx.db
      .query('deleted_tasks')
      .withIndex('by_item', (q) => q.eq('item_id', run.item.id).gt('_creationTime', cursor.after))
      .take(TASK_PAGE)
    for (const task of tasks) {
      if (!(await clear(task.task_id))) {
        run.state.cursor = cursor
        return false
      }
      cursor.after = task._creationTime
      run.budget.moved = true
    }
    if (tasks.length < TASK_PAGE) return true
  }
}

/* ------------------------------------------------------------------ moves */

/* Tasks other people see move first: those with a parent or an open child
 * outside the item's projects, so a surviving parent stops being a group
 * and a surviving child stops showing a hidden parent as early as possible.
 * Only open tasks have either effect, because an open task never sits under
 * an archived one. The scan keeps a cursor, because the tasks it passes
 * over stay in its range. */
async function moveEdges(run: Run): Promise<boolean> {
  const ids = itemProjectIds(run.item)
  const cursor = run.state.cursor ?? { index: 0, after: 0 }
  while (cursor.index < ids.length) {
    if (spent(run.budget)) {
      run.state.cursor = cursor
      return false
    }
    const projectId = ids[cursor.index]
    const tasks = await run.ctx.db
      .query('issues')
      .withIndex('by_project_archived', (q) =>
        q
          .eq('project_id', projectId)
          .eq('archived_at', undefined)
          .gt('_creationTime', cursor.after),
      )
      .take(LARGE_ROWS_PER_READ)
    for (const task of tasks) {
      if ((await isEdge(run.ctx, task, ids)) && !(await clearTask(run, task, 'keep'))) {
        run.state.cursor = cursor
        return false
      }
      cursor.after = task._creationTime
      run.budget.moved = true
      if (spent(run.budget)) {
        run.state.cursor = cursor
        return false
      }
    }
    if (tasks.length < LARGE_ROWS_PER_READ) {
      cursor.index += 1
      cursor.after = 0
    }
  }
  return true
}

/** Whether open task `task` has a parent or an open child outside `ids`. */
async function isEdge(ctx: QueryCtx, task: Doc<'issues'>, ids: string[]): Promise<boolean> {
  if (task.parent_id !== undefined) {
    const parent = await byId(ctx, 'issues', task.parent_id)
    if (parent !== null && !ids.includes(parent.project_id)) return true
  }
  const child = await ctx.db
    .query('issues')
    .withIndex('by_parent', (q) => q.eq('parent_id', task.id))
    .filter((q) =>
      q.and(
        q.eq(q.field('archived_at'), undefined),
        ...ids.map((id) => q.neq(q.field('project_id'), id)),
      ),
    )
    .first()
  return child !== null
}

/* Every task left in the item's projects, after any milestone or grant that
 * reached a project after the user's transaction stored its rows. */
async function moveProjectTasks(run: Run): Promise<boolean> {
  for (const id of itemProjectIds(run.item)) {
    if (!(await clearProjectRows(run, id, 'keep'))) return false
    if (!(await clearProjectTasks(run, id, 'keep'))) return false
  }
  return true
}

/* A task item's stored tasks: the rows that travel with each. */
const moveDrain = (run: Run): Promise<boolean> =>
  eachStoredTask(run, async (taskId) => {
    for (const relation of TASK_ROWS) {
      const done = await drain(
        run.budget,
        (n) => relation.read(run.ctx, taskId, n),
        (row) => clearRow(run, row, taskId, 'keep'),
        relation.perRead,
      )
      if (!done) return false
    }
    return true
  })

/** The phase to go back to when a range the move drains holds a row again,
 * else null. Once a task row has left issues nothing can add a row naming
 * it, so a project item's ranges are its projects' tasks and rows. */
async function moveLeft(run: Run): Promise<TrashPhase | null> {
  if (run.item.kind === 'task') {
    const tasks = await run.ctx.db
      .query('deleted_tasks')
      .withIndex('by_item', (q) => q.eq('item_id', run.item.id))
      .collect()
    for (const task of tasks)
      if (await holdsRows(run.ctx, TASK_ROWS, task.task_id)) return 'move_drain'
    return null
  }
  for (const id of itemProjectIds(run.item)) {
    if (await holdsRows(run.ctx, PROJECT_ROWS, id)) return 'move_tasks'
    const task = await run.ctx.db
      .query('issues')
      .withIndex('by_project', (q) => q.eq('project_id', id))
      .first()
    if (task !== null) return 'move_tasks'
  }
  return null
}

/** Makes a moved item ready, with the counts its steps gathered. */
async function finishMove(run: Run): Promise<void> {
  const tally = tallyOf(run)
  await run.ctx.db.patch(run.item._id, {
    state: 'ready',
    counts: { ...run.item.counts, tasks: tally.tasks, archived_tasks: tally.archived_tasks },
    projects: run.item.projects.map((p) => {
      const counted = tally.projects.find((c) => c.id === p.id)
      return { ...p, tasks: counted?.tasks ?? 0, archived_tasks: counted?.archived_tasks ?? 0 }
    }),
    dropped_rows: tally.dropped_rows > 0 ? tally.dropped_rows : undefined,
  })
}

/* ----------------------------------------------------------------- purges */

/* Purging a project item also purges what could never come back without
 * it: the task items whose project was in it, and the sub-project items
 * whose parent was. Items still moving or restoring are left to their own
 * expiry. */
async function purgeDependents(run: Run): Promise<boolean> {
  const purgeable = (
    q: FilterBuilder<NamedTableInfo<DataModel, 'deleted_items'>>,
    kind: Item['kind'],
  ) =>
    q.and(
      q.eq(q.field('kind'), kind),
      q.or(q.eq(q.field('state'), 'ready'), q.eq(q.field('state'), 'stuck')),
    )
  const { org_id } = run.item
  for (const id of itemProjectIds(run.item)) {
    const reads = [
      (n: number) =>
        run.ctx.db
          .query('deleted_items')
          .withIndex('by_org_project', (q) => q.eq('org_id', org_id).eq('project_id', id))
          .filter((q) => purgeable(q, 'task'))
          .take(n),
      (n: number) =>
        run.ctx.db
          .query('deleted_items')
          .withIndex('by_org_parent', (q) => q.eq('org_id', org_id).eq('parent_project_id', id))
          .filter((q) => purgeable(q, 'project'))
          .take(n),
    ]
    for (const read of reads)
      if (!(await drain(run.budget, read, (dependent) => startPurge(run.ctx, dependent), ALL)))
        return false
  }
  return true
}

/* Rows the item still holds in the live tables. A project item that got
 * stuck can leave tasks, with their rows, messages and children, and
 * project rows under its absent projects; they are deleted as the hard
 * delete would have. A task item can leave rows of its stored tasks. */
async function purgeLive(run: Run): Promise<boolean> {
  if (run.item.kind === 'task')
    return await eachStoredTask(run, async (taskId) => {
      for (const relation of TASK_ROWS) {
        const done = await drain(
          run.budget,
          (n) => relation.read(run.ctx, taskId, n),
          (row) => discard(run.ctx, row),
          relation.perRead,
        )
        if (!done) return false
      }
      return true
    })
  for (const id of await absentProjects(run)) {
    if (!(await clearProjectRows(run, id, 'purge'))) return false
    if (!(await clearProjectTasks(run, id, 'purge'))) return false
  }
  return true
}

/** The item's projects that have no live row, which only an item can
 * strand rows under. */
async function absentProjects(run: Run): Promise<string[]> {
  const ids: string[] = []
  for (const id of itemProjectIds(run.item))
    if ((await byId(run.ctx, 'projects', id)) === null) ids.push(id)
  return ids
}

/** Deletes the item's stored rows of `table`, attachment bytes with their
 * row in the same transaction. */
const purgeStored = (run: Run, table: StoredTable): Promise<boolean> =>
  drain(
    run.budget,
    (n) =>
      run.ctx.db
        .query('deleted_rows')
        .withIndex('by_item_table_owner', (q) => q.eq('item_id', run.item.id).eq('table', table))
        .take(n),
    async (row) => {
      if (row.storage_id !== undefined) await run.ctx.storage.delete(row.storage_id)
      await run.ctx.db.delete(row._id)
    },
    table === 'issues' || table === 'comments' || table === 'issue_attachments'
      ? LARGE_ROWS_PER_READ
      : ALL,
  )

/* Every stored row but the project rows, then the deleted_tasks rows. */
async function purgeRows(run: Run): Promise<boolean> {
  for (const table of STORED_TABLES)
    if (table !== 'projects' && !(await purgeStored(run, table))) return false
  return await drain(
    run.budget,
    (n) =>
      run.ctx.db
        .query('deleted_tasks')
        .withIndex('by_item', (q) => q.eq('item_id', run.item.id))
        .take(n),
    (task) => run.ctx.db.delete(task._id),
    ALL,
  )
}

/* Clears project_id on the organization's activity rows filed under the
 * item's projects, as deleteProjectDeep does, while the stored project rows
 * still reserve their uuids. The feed keeps at most 500 rows
 * (model/activity.ts), so one pass fits. */
async function purgeActivity(run: Run): Promise<boolean> {
  if (run.item.kind !== 'project') return true
  const ids = new Set(itemProjectIds(run.item))
  const events = run.ctx.db
    .query('activity_events')
    .withIndex('by_org_ts', (q) => q.eq('org_id', run.item.org_id))
  for await (const event of events)
    if (event.project_id !== undefined && ids.has(event.project_id))
      await run.ctx.db.patch(event._id, { project_id: undefined })
  return true
}

/** Whether a range the purge empties holds a row again. */
async function purgeLeft(run: Run): Promise<boolean> {
  const stored = await run.ctx.db
    .query('deleted_rows')
    .withIndex('by_item_owner', (q) => q.eq('item_id', run.item.id))
    .first()
  if (stored !== null) return true
  const task = await run.ctx.db
    .query('deleted_tasks')
    .withIndex('by_item', (q) => q.eq('item_id', run.item.id))
    .first()
  if (task !== null) return true
  if (run.item.kind === 'task') return false
  for (const id of await absentProjects(run)) {
    if (await holdsRows(run.ctx, PROJECT_ROWS, id)) return true
    const stranded = await run.ctx.db
      .query('issues')
      .withIndex('by_project', (q) => q.eq('project_id', id))
      .first()
    if (stranded !== null) return true
  }
  return false
}

/* --------------------------------------------------------------- the jobs */

/* The work each phase does, true when it is complete, and the phase that
 * follows it. The finish phases are handled in `work`. */
const PHASES: Record<
  Exclude<TrashPhase, 'move_finish' | 'purge_finish'>,
  { run: (run: Run) => Promise<boolean>; next: TrashPhase }
> = {
  move_edges: { run: moveEdges, next: 'move_tasks' },
  move_tasks: { run: moveProjectTasks, next: 'move_finish' },
  move_drain: { run: moveDrain, next: 'move_finish' },
  purge_dependents: { run: purgeDependents, next: 'purge_live' },
  purge_live: { run: purgeLive, next: 'purge_rows' },
  purge_rows: { run: purgeRows, next: 'purge_activity' },
  purge_activity: { run: purgeActivity, next: 'purge_projects' },
  purge_projects: { run: (run) => purgeStored(run, 'projects'), next: 'purge_finish' },
}

/** Runs `item`'s phases from `state` with `budget`, which `ctx` is metered
 * against. Returns null when the item's work is done: a move made it ready,
 * a purge deleted it. Otherwise returns where the next step starts. */
async function work(
  ctx: MutationCtx,
  budget: Budget,
  item: Item,
  state: JobState,
): Promise<JobState | null> {
  const deleter =
    item.deleted_by === undefined ? null : await byId(ctx, 'profiles', item.deleted_by)
  const run: Run = {
    ctx,
    item,
    state: { phase: state.phase, cursor: state.cursor, tally: state.tally },
    budget,
    // purges are nobody's act; a deleter whose id was reused is not the deleter
    actor: !state.phase.startsWith('purge') && sameReference(deleter, item) ? deleter : undefined,
    preload: undefined,
    // stamps each step with its own time, as profileRemovals.ts does
    now: new Date().toISOString(),
  }
  for (;;) {
    const { phase } = run.state
    if (phase === 'move_finish') {
      const back = await moveLeft(run)
      if (back === null) {
        await finishMove(run)
        return null
      }
      console.warn('A deleted item move starts again', { item_id: item.id, phase: back })
      return { ...run.state, phase: back, cursor: undefined }
    }
    if (phase === 'purge_finish') {
      if (await purgeLeft(run)) {
        console.warn('A deleted item purge starts again', { item_id: item.id })
        return { ...run.state, phase: 'purge_live', cursor: undefined }
      }
      await ctx.db.delete(item._id)
      return null
    }
    if (!(await PHASES[phase].run(run))) return run.state
    run.state = { ...run.state, phase: PHASES[phase].next, cursor: undefined }
  }
}

const jobOf = (ctx: QueryCtx, itemId: string) =>
  ctx.db
    .query('deleted_item_jobs')
    .withIndex('by_item', (q) => q.eq('item_id', itemId))
    .unique()

/** Saves where `item`'s job goes on and schedules its next step. A step
 * that got here committed, which resets the retries. */
async function saveJob(
  ctx: MutationCtx,
  item: Pick<Item, 'id'>,
  state: JobState,
  job: Job | null,
): Promise<void> {
  const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { item_id: item.id })
  const fields = {
    phase: state.phase,
    cursor: state.cursor,
    tally: state.tally,
    progress_at: new Date().toISOString(),
    scheduled_id,
    attempts: 0,
    budget_scale: 1,
  }
  if (job === null) await ctx.db.insert('deleted_item_jobs', { item_id: item.id, ...fields })
  else await ctx.db.patch(job._id, fields)
}

/** One step of an item's job (deletedItems.step). Safe to run twice or
 * after the item is gone: a missing item or job ends it, a job left by a
 * deleted item is deleted, and a demo organization being deleted gets no
 * further work (its cleanup deletes the items). */
export async function runStep(ctx: MutationCtx, itemId: string): Promise<void> {
  const job = await jobOf(ctx, itemId)
  const item = await byId(ctx, 'deleted_items', itemId)
  if (item === null) {
    if (job !== null) await ctx.db.delete(job._id)
    return
  }
  if (job === null) return
  if (isDemoDeployment() && (await demoForOrg(ctx, item.org_id))?.status === 'deleting') return
  const budget = budgetFor(job.budget_scale)
  const next = await work(metered(ctx, budget), budget, item, job)
  if (next === null) await ctx.db.delete(job._id)
  else await saveJob(ctx, item, next, job)
}

/** Restarts jobs whose last step committed more than STALLED_MS ago and
 * whose next step neither waits nor runs, as profileRemovals.ts recover
 * does, at half the budget each time. A job that already failed
 * RETRY.atFloor times at the smallest budget makes its item stuck instead:
 * it leaves the steps and waits for an admin's Delete now. */
export async function recoverJobs(ctx: MutationCtx): Promise<void> {
  const now = Date.now()
  const halvings = Math.round(Math.log2(1 / RETRY.floor))
  const stalled = await ctx.db
    .query('deleted_item_jobs')
    .withIndex('by_progress', (q) => q.lt('progress_at', new Date(now - STALLED_MS).toISOString()))
    .take(RECOVER_SCAN)
  let restarted = 0
  for (const job of stalled) {
    if (restarted === RECOVER_BATCH) break
    const next = job.scheduled_id === undefined ? null : await ctx.db.system.get(job.scheduled_id)
    if (next?.state.kind === 'pending' || next?.state.kind === 'inProgress') continue
    restarted += 1
    const item = await byId(ctx, 'deleted_items', job.item_id)
    if (item === null) {
      await ctx.db.delete(job._id)
      continue
    }
    if (job.budget_scale <= RETRY.floor && job.attempts >= halvings + RETRY.atFloor) {
      await ctx.db.patch(item._id, { state: 'stuck' })
      await ctx.db.delete(job._id)
      console.error('A deleted item is stuck', {
        item_id: item.id,
        phase: job.phase,
        attempts: job.attempts,
      })
      continue
    }
    const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { item_id: job.item_id })
    await ctx.db.patch(job._id, {
      budget_scale: Math.max(RETRY.floor, job.budget_scale / 2),
      attempts: job.attempts + 1,
      progress_at: new Date(now).toISOString(),
      scheduled_id,
    })
    console.warn('A deleted item step resumed', {
      item_id: job.item_id,
      phase: job.phase,
      attempts: job.attempts + 1,
      stalled_ms: now - Date.parse(job.progress_at),
    })
  }
}

/** Starts purging the ready items whose time is over, at most EXPIRY.batch
 * of them. Returns whether more may be due. */
export async function expireItems(ctx: MutationCtx): Promise<boolean> {
  const due = await ctx.db
    .query('deleted_items')
    .withIndex('by_state_purge', (q) => q.eq('state', 'ready').lte('purge_after', Date.now()))
    .take(EXPIRY.batch)
  for (const item of due) await startPurge(ctx, item)
  return due.length === EXPIRY.batch
}

/** Starts deleting `item` for good. It leaves Deleted items at once, because
 * purging items are not listed, and its steps delete what it stores. Only
 * ready and stuck items can be purged: the nightly expiry passes ready ones,
 * Delete now either. `inline` spends the first budget in the caller's
 * transaction, for a caller that purges one item. */
export async function startPurge(
  ctx: MutationCtx,
  item: Item,
  opts: { inline?: boolean } = {},
): Promise<void> {
  if (item.state !== 'ready' && item.state !== 'stuck')
    throw new Error(`A ${item.state} deleted item cannot be purged`)
  // ready and stuck items have no job; one left over would make two chains
  const stale = await jobOf(ctx, item.id)
  if (stale !== null) await ctx.db.delete(stale._id)
  await ctx.db.patch(item._id, { state: 'purging' })
  const purging: Item = { ...item, state: 'purging' }
  const state: JobState = { phase: item.kind === 'project' ? 'purge_dependents' : 'purge_live' }
  if (opts.inline) await startJob(ctx, purging, state)
  else await saveJob(ctx, purging, state, null)
}

/** Spends the first budget of `item`'s work in the caller's transaction and
 * schedules a step for what is left. `budget` may already hold what the
 * caller spent on the same work. */
async function startJob(
  ctx: MutationCtx,
  item: Item,
  state: JobState,
  budget = budgetFor(1),
): Promise<void> {
  const next = await work(metered(ctx, budget), budget, item, state)
  if (next !== null) await saveJob(ctx, item, next, null)
}

/* ------------------------------------------------------------- deleting */

/** The reason a delete window sent: trimmed, absent when blank, refused
 * past REASON_MAX characters. */
export function cleanReason(raw: string | undefined): string | undefined {
  const reason = raw?.trim()
  if (reason === undefined || reason === '') return undefined
  if ([...reason].length > REASON_MAX)
    throw rule(`a reason can be at most ${REASON_MAX} characters`)
  return reason
}

type Deletion = {
  actor: Doc<'profiles'>
  now: string
  reason?: string
  /** The credential of a REST or MCP delete, as named now. */
  via?: Via
}

/** Inserts a moving item and returns it as stored. */
async function insertItem(
  ctx: MutationCtx,
  d: Deletion,
  fields: Pick<
    Item,
    | 'kind'
    | 'target_id'
    | 'num'
    | 'name'
    | 'key'
    | 'status'
    | 'archived'
    | 'project_id'
    | 'parent_project_id'
    | 'path'
    | 'projects'
    | 'counts'
  >,
): Promise<Item> {
  const _id = await ctx.db.insert('deleted_items', {
    ...fields,
    id: newUuid(),
    org_id: d.actor.org_id,
    deleted_at: d.now,
    deleted_by: d.actor.id,
    via: d.via,
    reason: d.reason,
    state: 'moving',
    purge_after: Date.parse(d.now) + TRASH_DAYS * DAY_MS,
  })
  const item = await ctx.db.get(_id)
  if (item === null) throw new Error('A deleted item vanished on insert')
  return item
}

/** The project a stored row names, which must be live while it is deleted. */
async function liveProject(ctx: QueryCtx, id: string): Promise<Doc<'projects'>> {
  const project = await byId(ctx, 'projects', id)
  if (project === null) throw notFound('project not found')
  return project
}

/**
 * Moves task `root` and the chosen `subtasks` (deletion order, deepest
 * first) to Deleted items as one task item, as the app's, REST and MCP
 * deletes do. The callers check access and the subtask choice; each task's
 * Edit check is repeated here as defense in depth (model/issues.ts
 * assertCanEdit). In this transaction, for each task: its messages are
 * deleted, its live children outside the item are detached (the SET NULL's
 * touch, 'Detached from its parent' and task.updated), task.deleted is
 * emitted, the task row is stored and the 'deleted' activity row written as
 * before, its detail the machine `provenance`. A child inside the item keeps
 * its parent. The tasks are then hidden; their other rows follow within the
 * same budget, and steps take the rest. A task too large to store is
 * deleted with its rows instead, as today. Returns the item.
 */
export async function moveTasksToTrash(
  ctx: MutationCtx,
  a: Deletion & { root: Doc<'issues'>; subtasks: Doc<'issues'>[]; provenance?: string },
): Promise<Item> {
  const { actor, root, now } = a
  const budget = budgetFor(1)
  const counted = metered(ctx, budget)
  const tasks = [...a.subtasks, root]
  const doomed = new Set(tasks.map((task) => task.id))
  const project = await liveProject(counted, root.project_id)
  const top =
    project.parent_id === undefined ? null : await byId(counted, 'projects', project.parent_id)
  const projects: Item['projects'] = []
  for (const task of [root, ...a.subtasks]) {
    if (projects.some((p) => p.id === task.project_id)) continue
    const p = task.project_id === project.id ? project : await liveProject(counted, task.project_id)
    projects.push({ id: p.id, name: p.name, key: p.key, type: p.type, tasks: 0, archived_tasks: 0 })
  }
  const item = await insertItem(counted, a, {
    kind: 'task',
    target_id: root.id,
    num: root.num,
    name: root.title,
    status: root.status,
    archived: root.archived_at !== undefined,
    project_id: project.id,
    parent_project_id: top?.id,
    path: top === null ? [project.name] : [top.name, project.name],
    projects,
    counts: {
      tasks: tasks.length,
      archived_tasks: tasks.filter((task) => task.archived_at !== undefined).length,
      subtasks: a.subtasks.length,
      sub_projects: 0,
    },
  })
  const tally = emptyTally(item)
  for (const task of tasks) {
    await assertCanEdit(counted, actor, task.project_id)
    const messages = counted.db
      .query('messages')
      .withIndex('by_issue_read', (q) => q.eq('issue_id', task.id))
    for await (const message of messages) await counted.db.delete(message._id)
    const kids = await counted.db
      .query('issues')
      .withIndex('by_parent', (q) => q.eq('parent_id', task.id))
      .collect()
    for (const kid of kids) if (!doomed.has(kid.id)) await detach(counted, kid, actor, now)
    await emitTaskEvent(counted, { name: 'task.deleted', issue: task, actor, now })
    if (tooLarge(item, { table: 'issues', doc: task }, task.id)) {
      // deleted as before, with every row that would have travelled with it
      console.error('A deleted item dropped a task too large to store', {
        item_id: item.id,
        task_id: task.id,
      })
      await clearAll(counted, TASK_ROWS, task.id, (row) => discard(counted, row))
      await counted.db.delete(task._id)
      tally.dropped_rows += 1
    } else await storeTask(counted, item, tally, task)
    await logActivity(counted, {
      org_id: task.org_id,
      actor_id: actor.id,
      verb: 'deleted',
      target_type: 'issue',
      target_id: task.id,
      label: task.title,
      detail: a.provenance,
      project_id: task.project_id,
      ts: now,
    })
  }
  await startJob(ctx, item, { phase: 'move_drain', tally }, budget)
  return item
}

/**
 * Moves `project` with its sub-projects, archived ones included, and every
 * task in them to Deleted items as one project item. The caller checks Lead
 * and writes the 'deleted' activity row. This transaction stores the
 * project rows with their milestones, grants and team grants, which hides
 * the projects and so every task in them; the tasks then move within the
 * same budget and in steps (clearTask). Tasks of the item emit no
 * task.deleted; children in surviving projects are detached with
 * task.updated. Returns the item.
 */
export async function moveProjectToTrash(
  ctx: MutationCtx,
  a: Deletion & { project: Doc<'projects'> },
): Promise<Item> {
  const { project } = a
  const budget = budgetFor(1)
  const counted = metered(ctx, budget)
  const subs = await counted.db
    .query('projects')
    .withIndex('by_parent', (q) => q.eq('parent_id', project.id))
    .collect()
  const parent =
    project.parent_id === undefined ? null : await byId(counted, 'projects', project.parent_id)
  const doomed = [project, ...subs]
  const item = await insertItem(counted, a, {
    kind: 'project',
    target_id: project.id,
    num: project.num,
    name: project.name,
    key: project.key,
    archived: project.archived_at !== undefined,
    project_id: project.id,
    parent_project_id: project.parent_id,
    path: parent === null ? [] : [parent.name],
    projects: doomed.map((p) => ({
      id: p.id,
      name: p.name,
      key: p.key,
      type: p.type,
      tasks: 0,
      archived_tasks: 0,
    })),
    counts: { tasks: 0, archived_tasks: 0, subtasks: 0, sub_projects: subs.length },
  })
  const tally = emptyTally(item)
  const keep = async (live: LiveRow, ownerId: string) => {
    if (!(await storeRow(counted, item, live, ownerId))) tally.dropped_rows += 1
  }
  for (const p of doomed) {
    await clearAll(counted, PROJECT_ROWS, p.id, (row) => keep(row, p.id))
    await keep({ table: 'projects', doc: p }, p.id)
  }
  await startJob(ctx, item, { phase: 'move_edges', tally }, budget)
  return item
}

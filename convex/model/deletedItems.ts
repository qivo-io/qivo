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
 * Fill first, reveal last (restoreItems). A restore mirrors the move: steps
 * write the rows back while what they name is still absent, and one
 * transaction at the end, the reveal, writes the item's root rows (a task
 * item's tasks; a project item's projects, milestones and grants), so the
 * work appears complete in one delivery. A task item first hands each
 * subtask whose project is no longer live to the item that holds that
 * project. References that no longer name what the item stored are dropped
 * (sameReference). A reveal whose checks fail sends the item back to
 * moving, and the move takes the rows back.
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
 * events then go out without an actor. Only a reveal needs the restorer,
 * whose permission it checks again; without them it sends the item back. A
 * step returns without work when its item or job is gone, or while its demo
 * organization is being deleted. */

import {
  type FilterBuilder,
  makeFunctionReference,
  type NamedTableInfo,
  type WithoutSystemFields,
} from 'convex/server'
import type { DataModel, Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import {
  canHoldWork,
  canLeadProjects,
  canSeeProject,
  hasProjectLevel,
  levelRank,
  levelsFrom,
  type OrgProjectLevels,
} from '../lib/access'
import { billingReadOnly } from '../lib/billingAccess'
import { byId } from '../lib/db'
import { demoForOrg, isDemoDeployment } from '../lib/demo'
import {
  LEVEL_RANK,
  type ProjectType,
  STORED_TABLES,
  type StoredTable,
  type TrashPhase,
} from '../lib/enums'
import { notFound, rule } from '../lib/functions'
import { logActivity } from './activity'
import { LARGE_ROWS_PER_READ } from './cascade'
import { estimateDocumentBytes } from './demoMetrics'
import { assertCanEdit, clearParentRemaining, parentChain } from './issues'
import {
  type NotifyPreload,
  notifyIssueUpdate,
  postMessage,
  scheduleArchivedReads,
} from './messages'
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
type JobState = Pick<Job, 'phase' | 'cursor' | 'tally' | 'alone'>
export type Via = NonNullable<Item['via']>

/** A live document of one of the stored tables, tagged with its table. */
export type LiveRow = { [T in StoredTable]: { table: T; doc: Doc<T> } }[StoredTable]

/** A stored document of `T`, as deleted_rows keeps it: the live document
 * without its system fields. */
type Stored<T extends StoredTable> = Extract<Doc<'deleted_rows'>['row'], { table: T }>['doc']

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
 * stored task or as a task in issues under one of that item's absent
 * projects (while a project item moves or restores). `task` is its row
 * there, for the reference predicate. Otherwise gone. */
export type TaskWhere =
  | { where: 'live'; issue: Doc<'issues'>; project: Doc<'projects'> }
  | { where: 'trash'; item: Item; task: Stored<'issues'> }
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
    return inTrash(held === null ? null : await byId(ctx, 'deleted_items', held.item_id), issue)
  }
  const stored = await ctx.db
    .query('deleted_rows')
    .withIndex('by_row', (q) => q.eq('table', 'issues').eq('row_id', taskId))
    .first()
  if (stored?.row.table !== 'issues') return { where: 'gone' }
  return inTrash(await byId(ctx, 'deleted_items', stored.item_id), stored.row.doc)
}

const inTrash = (item: Item | null, task: Stored<'issues'>): TaskWhere =>
  item === null || item.state === 'purging' ? { where: 'gone' } : { where: 'trash', item, task }

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

/** Reads a restore repeats for many rows, kept for one item in one
 * transaction. Nothing the restore writes changes them before its reveal. */
type Memo = {
  profiles: Map<string, Promise<Doc<'profiles'> | null>>
  teams: Map<string, Promise<Doc<'teams'> | null>>
  labels: Map<string, Promise<Doc<'labels'> | null>>
  projects: Map<string, Promise<Doc<'projects'> | null>>
  hierarchy: Promise<Hierarchy> | undefined
  levels: Map<string, Promise<OrgProjectLevels>>
  holders: Map<string, Promise<boolean>>
}

const newMemo = (): Memo => ({
  profiles: new Map(),
  teams: new Map(),
  labels: new Map(),
  projects: new Map(),
  hierarchy: undefined,
  levels: new Map(),
  holders: new Map(),
})

/** One item as the restore rules read it (design 5.2, 5.3), in a query or
 * in a step. */
type Scope<C extends QueryCtx = QueryCtx> = { ctx: C; item: Item; memo: Memo }

/** What one transaction's items share. A restore call works on several
 * items; a step on one. */
type Txn = {
  /** The archived tasks written back, for one scheduleArchivedReads call. */
  archived: string[]
  /** Collects the items revealed, when the caller narrates them together
   * (a restore call); otherwise each reveal writes its own activity row. */
  revealed: Revealed[] | undefined
  /** Restores whose reveal failed, with the reason. */
  failed: Map<string, RestoreBlock>
  /** The person restoring, as the restore call knows them. */
  restorer?: Doc<'profiles'>
  now?: string
}

const newTxn = (): Txn => ({ archived: [], revealed: undefined, failed: new Map() })

/** What a running step holds. `ctx` is metered against `budget`. */
type Run = Scope<MutationCtx> & {
  state: JobState
  budget: Budget
  /** The deleter for a move, the restorer for a restore, for notices and
   * events; absent once their profile is gone, and for purges. */
  actor: Doc<'profiles'> | undefined
  /** Read once per step, when the first detach needs it. */
  preload: NotifyPreload | undefined
  now: string
  txn: Txn
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
 * names the last task fully done. When all are done the cursor stays at
 * the end, so the phase does not walk them again. A task the cursor skips
 * on a tie of _creationTime is found by the finish check, which starts
 * over. */
async function eachStoredTask(
  run: Run,
  clear: (task: Doc<'deleted_tasks'>) => Promise<boolean>,
): Promise<boolean> {
  const cursor = run.state.cursor ?? { index: 0, after: 0 }
  run.state.cursor = cursor
  for (;;) {
    const tasks = await run.ctx.db
      .query('deleted_tasks')
      .withIndex('by_item', (q) => q.eq('item_id', run.item.id).gt('_creationTime', cursor.after))
      .take(TASK_PAGE)
    for (const task of tasks) {
      if (spent(run.budget) || !(await clear(task))) return false
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
  eachStoredTask(run, async ({ task_id }) => {
    for (const relation of TASK_ROWS) {
      const done = await drain(
        run.budget,
        (n) => relation.read(run.ctx, task_id, n),
        (row) => clearRow(run, row, task_id, 'keep'),
        relation.perRead,
      )
      if (!done) return false
    }
    return true
  })

/** The phase to go back to when a range the move drains holds a row again,
 * else null. Once a task row has left issues nothing can add a row naming
 * it, so a project item's ranges are its projects' tasks and rows. A failed
 * restore also wrote rows of tasks it left stored back; its move drains
 * those first (move_drain), and the finish does not read them again,
 * because that would read each of the item's tasks in one transaction. */
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
    restore_by: undefined,
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
 * delete would have. A task item can leave rows of its stored tasks, and so
 * can a project item that got stuck during or after a restore (restore_by
 * set). */
async function purgeLive(run: Run): Promise<boolean> {
  if (run.item.kind === 'task' || run.item.restore_by !== undefined) {
    const done = await eachStoredTask(run, async ({ task_id }) => {
      for (const relation of TASK_ROWS) {
        const drained = await drain(
          run.budget,
          (n) => relation.read(run.ctx, task_id, n),
          (row) => discard(run.ctx, row),
          relation.perRead,
        )
        if (!drained) return false
      }
      return true
    })
    if (!done || run.item.kind === 'task') return done
  }
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

/* --------------------------------------------------------------- restores */

/** The most items one restore call takes. */
export const RESTORE_MAX = 25

/* The index ranges a reveal may read per task it writes back. A task item
 * of 41 tasks with holders, a parent outside, task.restored subscriptions
 * and the Restored notice measured about 6, so this leaves room. */
const REVEAL_RANGES_PER_TASK = 16

/** Why an item cannot be restored now (design 5.3). The item's state while
 * it is not ready; read_only while billing pauses editing; then the blocked
 * reasons of the design's table. no_access: the person has no level on the
 * project the item goes back to (the list's redacted row). conflict: a live
 * row holds a uuid or key the item needs, which the reservations
 * (lib/db.ts insertUnique, model/projects.ts keyHolder) should prevent. */
export type RestoreBlock =
  | Exclude<Item['state'], 'ready'>
  | 'read_only'
  | 'project_deleted'
  | 'parent_deleted'
  | 'no_access'
  | 'view_only'
  | 'not_lead'
  | 'subtask_project'
  | 'project_archived'
  | 'parent_archived'
  | 'conflict'

/** What one restore call answers per item (deletedItems.restore). Items
 * that do not finish in the call are restored, and go on in steps as
 * restoring. A deferred item waits for a project item in the same call. */
export type RestoreResult = {
  restored: string[]
  refused: { id: string; reason: RestoreBlock }[]
  deferred: string[]
}

/** An item a reveal brought back, for the activity row. */
type Revealed = { item: Item; tasks: number }

/** The relation rows a restore writes back before its links and reveal. */
const RESTORED_ROWS = [
  'comments',
  'issue_labels',
  'issue_subscriptions',
  'issue_attachments',
] as const

/* `read`, run once per key for one item in one transaction (Memo). */
function memoRead<V>(cache: Map<string, Promise<V>>, key: string, read: () => Promise<V>) {
  let value = cache.get(key)
  if (value === undefined) {
    value = read()
    cache.set(key, value)
  }
  return value
}

const profileOf = (s: Scope, id: string) =>
  memoRead(s.memo.profiles, id, () => byId(s.ctx, 'profiles', id))
const teamOf = (s: Scope, id: string) => memoRead(s.memo.teams, id, () => byId(s.ctx, 'teams', id))
const labelOf = (s: Scope, id: string) =>
  memoRead(s.memo.labels, id, () => byId(s.ctx, 'labels', id))

/** `id` when the profile it names passes the reference predicate, else
 * undefined: how a restore keeps authors, uploaders, creators and
 * reporters. */
async function keptProfile(s: Scope, id: string | undefined): Promise<string | undefined> {
  if (id === undefined) return undefined
  return sameReference(await profileOf(s, id), s.item) ? id : undefined
}

/** The live project `id` when it is the one the item stored (the reference
 * predicate, with the type rule when `type` is given). */
async function namedProject(s: Scope, id: string, type?: ProjectType) {
  const project = await memoRead(s.memo.projects, id, () => byId(s.ctx, 'projects', id))
  return sameReference(project, s.item, type) ? project : null
}

/** The item's stored rows of `table`, whole. For a project item's own rows,
 * which organization size bounds, and for what a reveal writes back. */
const storedOf = (s: Scope, table: StoredTable) =>
  s.ctx.db
    .query('deleted_rows')
    .withIndex('by_item_table_owner', (q) => q.eq('item_id', s.item.id).eq('table', table))
    .collect()

/** The stored document of `row`, read as a row of `table`. */
function docOf<T extends StoredTable>(row: Doc<'deleted_rows'>, table: T): Stored<T> {
  if (row.row.table !== table) throw new Error(`A ${row.row.table} row is not a ${table} row`)
  // checked against the tag just above
  return row.row.doc as Stored<T>
}

/** A stored project as its reveal writes it back: its lead only while that
 * profile passes the reference predicate and may lead (design 6.1), its
 * legacy team only while the team passes the predicate. */
async function cleanProject(s: Scope, p: Stored<'projects'>): Promise<Stored<'projects'>> {
  const lead = p.lead_id === undefined ? null : await profileOf(s, p.lead_id)
  const team = p.team_id === undefined ? null : await teamOf(s, p.team_id)
  return {
    ...p,
    lead_id: sameReference(lead, s.item) && canLeadProjects(lead) ? p.lead_id : undefined,
    team_id: sameReference(team, s.item) ? p.team_id : undefined,
  }
}

/** A stored grant as its reveal writes it back: none when its profile fails
 * the reference predicate, a viewer grant for someone who is a viewer now
 * (model/projects.ts assertGrantee). */
async function cleanGrant(
  s: Scope,
  g: Stored<'project_access'>,
): Promise<Stored<'project_access'> | null> {
  const profile = await profileOf(s, g.profile_id)
  if (!sameReference(profile, s.item)) return null
  return profile.org_role === 'viewer' ? { ...g, level: 'viewer' } : g
}

/** A stored team share as its reveal writes it back, or none when its team
 * fails the reference predicate. */
async function cleanShare(
  s: Scope,
  g: Stored<'project_team_access'>,
): Promise<Stored<'project_team_access'> | null> {
  return sameReference(await teamOf(s, g.team_id), s.item) ? g : null
}

/** A project item's projects as its reveal writes them back, with their
 * grants and shares, and a sub-project item's live parent: what levels
 * inside the item are computed over while it is in Deleted items. */
type Hierarchy = {
  root: Stored<'projects'> | undefined
  projects: Stored<'projects'>[]
  grants: Stored<'project_access'>[]
  shares: Stored<'project_team_access'>[]
  parent: Doc<'projects'> | null
}

function hierarchyOf(s: Scope): Promise<Hierarchy> {
  s.memo.hierarchy ??= (async () => {
    const projects: Stored<'projects'>[] = []
    for (const row of await storedOf(s, 'projects'))
      projects.push(await cleanProject(s, docOf(row, 'projects')))
    const grants: Stored<'project_access'>[] = []
    for (const row of await storedOf(s, 'project_access')) {
      const grant = await cleanGrant(s, docOf(row, 'project_access'))
      if (grant !== null) grants.push(grant)
    }
    const shares: Stored<'project_team_access'>[] = []
    for (const row of await storedOf(s, 'project_team_access')) {
      const share = await cleanShare(s, docOf(row, 'project_team_access'))
      if (share !== null) shares.push(share)
    }
    const { parent_project_id } = s.item
    return {
      root: projects.find((p) => p.id === s.item.target_id),
      projects,
      grants,
      shares,
      parent:
        parent_project_id === undefined ? null : await namedProject(s, parent_project_id, 'meta'),
    }
  })()
  return s.memo.hierarchy
}

/** `profile`'s levels on a project item's projects while they are in
 * Deleted items (design 6.1): lib/access.ts levelsFrom over the projects as
 * the reveal writes them back, the profile's stored grants, the stored
 * shares of the teams it belongs to now, and the live grants and shares on
 * a sub-project item's parent. */
function storedLevels(s: Scope, profile: Doc<'profiles'>): Promise<OrgProjectLevels> {
  return memoRead(s.memo.levels, profile.id, async () => {
    const h = await hierarchyOf(s)
    const teams = new Set<string>()
    const memberships = s.ctx.db
      .query('team_members')
      .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
    for await (const m of memberships)
      if ((await teamOf(s, m.team_id))?.org_id === profile.org_id) teams.add(m.team_id)
    const grants: Pick<Doc<'project_access'>, 'project_id' | 'level'>[] = h.grants.filter(
      (g) => g.profile_id === profile.id,
    )
    const shares: Pick<Doc<'project_team_access'>, 'project_id' | 'level'>[] = h.shares.filter(
      (g) => teams.has(g.team_id),
    )
    if (h.parent === null) return levelsFrom(profile, h.projects, grants, shares)
    const parentId = h.parent.id
    const own = await s.ctx.db
      .query('project_access')
      .withIndex('by_project_profile', (q) =>
        q.eq('project_id', parentId).eq('profile_id', profile.id),
      )
      .unique()
    if (own !== null) grants.push(own)
    const parentShares = s.ctx.db
      .query('project_team_access')
      .withIndex('by_project', (q) => q.eq('project_id', parentId))
    for await (const share of parentShares) if (teams.has(share.team_id)) shares.push(share)
    return levelsFrom(profile, [...h.projects, h.parent], grants, shares)
  })
}

/** Whether `id` can stay a task's assignee or reviewer in `projectId`: the
 * profile passes the reference predicate and today's assignment rule there
 * (lib/access.ts profileCanBeAssigned). While the project is still in
 * Deleted items, its level comes from the stored rows. */
function keepsHolder(s: Scope, id: string, projectId: string): Promise<boolean> {
  return memoRead(s.memo.holders, `${id}:${projectId}`, async () => {
    const profile = await profileOf(s, id)
    if (!sameReference(profile, s.item) || !canHoldWork(profile)) return false
    if ((await byId(s.ctx, 'projects', projectId)) !== null)
      return await hasProjectLevel(s.ctx, profile, projectId, 'user')
    const level = (await storedLevels(s, profile)).levelOf({ id: projectId, org_id: s.item.org_id })
    return levelRank(level) >= LEVEL_RANK.user
  })
}

const keptHolder = async (s: Scope, id: string | undefined, projectId: string) =>
  id !== undefined && (await keepsHolder(s, id, projectId)) ? id : undefined

/** Why `me` cannot restore `item` now, else null (design 5.3). Callers
 * check the item's state; the reveal asks again for the restorer. */
async function blockOf(s: Scope, me: Doc<'profiles'>): Promise<RestoreBlock | null> {
  if (me.org_id !== s.item.org_id) return 'no_access'
  if (await billingReadOnly(s.ctx, s.item.org_id)) return 'read_only'
  return s.item.kind === 'task' ? await taskItemBlock(s, me) : await projectItemBlock(s, me)
}

/* A task item goes back into its root's project, which must be live and
 * not archived, and the person needs Edit on every live project its tasks
 * go back to. A subtask project that is no longer live does not block: the
 * restore moves that subtask to the item that holds its project. */
async function taskItemBlock(s: Scope, me: Doc<'profiles'>): Promise<RestoreBlock | null> {
  const project = await namedProject(s, s.item.project_id, 'project')
  if (project === null) return 'project_deleted'
  if (!(await canSeeProject(s.ctx, me, project))) return 'no_access'
  if (!(await hasProjectLevel(s.ctx, me, project.id, 'user'))) return 'view_only'
  for (const { id } of s.item.projects) {
    if (id === project.id || (await namedProject(s, id, 'project')) === null) continue
    if (!(await hasProjectLevel(s.ctx, me, id, 'user'))) return 'subtask_project'
  }
  if (project.archived_at !== undefined) return 'project_archived'
  if ((await byId(s.ctx, 'issues', s.item.target_id)) !== null) return 'conflict'
  return null
}

/* A project item needs an organization admin or the effective lead of its
 * root, computed over the stored rows; restore works like unarchive, so
 * there is no project_creators check and a sub-project's own lead
 * suffices. A sub-project item needs its parent live and not archived. */
async function projectItemBlock(s: Scope, me: Doc<'profiles'>): Promise<RestoreBlock | null> {
  const h = await hierarchyOf(s)
  if (h.root === undefined) return 'conflict'
  if (s.item.parent_project_id !== undefined && h.parent === null) return 'parent_deleted'
  const level = (await storedLevels(s, me)).levelOf(h.root)
  if (level !== 'lead')
    return level === null ? 'no_access' : level === 'viewer' ? 'view_only' : 'not_lead'
  if (h.parent !== null && h.parent.archived_at !== undefined) return 'parent_archived'
  for (const p of h.projects) {
    const holder = await s.ctx.db
      .query('projects')
      .withIndex('by_org_key', (q) => q.eq('org_id', s.item.org_id).eq('key', p.key))
      .first()
    if (holder !== null || (await byId(s.ctx, 'projects', p.id)) !== null) return 'conflict'
  }
  return null
}

/** Why `me` cannot restore `item` now, or null when they can (design 5.3,
 * also the list's can_restore and blocked). Visibility (design 6.1) is the
 * caller's to check first. */
export async function restoreBlock(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  item: Item,
): Promise<RestoreBlock | null> {
  if (item.state !== 'ready') return item.state
  return await blockOf({ ctx, item, memo: newMemo() }, me)
}

/** The tally of what `item` stores now, which a restore subtracts from. */
const tallyFromItem = (item: Item): Tally => ({
  tasks: item.counts.tasks,
  archived_tasks: item.counts.archived_tasks,
  dropped_rows: item.dropped_rows ?? 0,
  projects: item.projects.map((p) => ({
    id: p.id,
    tasks: p.tasks,
    archived_tasks: p.archived_tasks,
  })),
})

/** Adds `delta` tasks like `task` to `tally`. */
function tallyTask(
  tally: Tally,
  task: Pick<Doc<'deleted_tasks'>, 'project_id' | 'archived'>,
  delta: number,
): void {
  const archived = task.archived ? delta : 0
  tally.tasks += delta
  tally.archived_tasks += archived
  const project = tally.projects.find((p) => p.id === task.project_id)
  if (project === undefined) return
  project.tasks += delta
  project.archived_tasks += archived
}

/* ------------------------------------------------------------- the fill */

/* A task item's subtasks whose project is no longer live leave the item
 * before anything is written back (design 5.2): to the item that holds
 * their project, which brings them back with it, or for good when their
 * project is gone. */
const restoreSplit = (run: Run): Promise<boolean> =>
  run.item.kind === 'project'
    ? Promise.resolve(true)
    : eachStoredTask(run, async (task) => {
        if (task.task_id === run.item.target_id) return true
        if ((await namedProject(run, task.project_id, 'project')) !== null) return true
        return await splitOff(run, task)
      })

/** Moves subtask `task` with every row it owns to the item that holds its
 * project, keeping its parent; when no item that is not purging holds the
 * project, deletes them for good with their bytes. Both items' counts
 * follow. */
async function splitOff(run: Run, task: Doc<'deleted_tasks'>): Promise<boolean> {
  const held = await run.ctx.db
    .query('deleted_rows')
    .withIndex('by_row', (q) => q.eq('table', 'projects').eq('row_id', task.project_id))
    .first()
  const holder = held === null ? null : await byId(run.ctx, 'deleted_items', held.item_id)
  const into =
    holder !== null && holder.state !== 'purging' && holder.org_id === run.item.org_id
      ? holder
      : null
  const done = await drain(
    run.budget,
    (n) =>
      run.ctx.db
        .query('deleted_rows')
        .withIndex('by_item_owner', (q) =>
          q.eq('item_id', run.item.id).eq('owner_id', task.task_id),
        )
        .take(n),
    (row) =>
      into === null ? dropStored(run.ctx, row) : run.ctx.db.patch(row._id, { item_id: into.id }),
    LARGE_ROWS_PER_READ,
  )
  if (!done) return false
  await run.ctx.db.delete(task._id)
  await countOut(run, task)
  if (into === null) {
    console.warn('A restore deleted a subtask whose project is gone', {
      item_id: run.item.id,
      task_id: task.task_id,
    })
    return true
  }
  const { _id, _creationTime, ...light } = task
  // a new row, so that a restore of `into` past its cursor still meets it
  await run.ctx.db.insert('deleted_tasks', { ...light, item_id: into.id })
  await countInto(run.ctx, into, task)
  return true
}

/** Takes subtask `task` out of the counts of the item restoring it: from
 * its tally, and on the item row from the subtask count and, once no task
 * of the item is left in the subtask's project, the projects. */
async function countOut(run: Run, task: Doc<'deleted_tasks'>): Promise<void> {
  const tally = tallyOf(run)
  tallyTask(tally, task, -1)
  const left = tally.projects.find((p) => p.id === task.project_id)?.tasks ?? 0
  const fields = {
    counts: { ...run.item.counts, subtasks: Math.max(0, run.item.counts.subtasks - 1) },
    projects:
      left > 0 ? run.item.projects : run.item.projects.filter((p) => p.id !== task.project_id),
  }
  await run.ctx.db.patch(run.item._id, fields)
  run.item = { ...run.item, ...fields }
}

/** Counts `task` into item `into`: into the tally of its job while it moves
 * or restores, else on the item row. */
async function countInto(
  ctx: MutationCtx,
  into: Item,
  task: Pick<Doc<'deleted_tasks'>, 'project_id' | 'archived'>,
): Promise<void> {
  const job = await jobOf(ctx, into.id)
  if (job !== null && (into.state === 'moving' || into.state === 'restoring')) {
    const tally = job.tally ?? emptyTally(into)
    tallyTask(tally, task, 1)
    await ctx.db.patch(job._id, { tally })
    return
  }
  const archived = task.archived ? 1 : 0
  await ctx.db.patch(into._id, {
    counts: {
      ...into.counts,
      tasks: into.counts.tasks + 1,
      archived_tasks: into.counts.archived_tasks + archived,
    },
    projects: into.projects.map((p) =>
      p.id === task.project_id
        ? { ...p, tasks: p.tasks + 1, archived_tasks: p.archived_tasks + archived }
        : p,
    ),
  })
}

/** Deletes a stored row for good, attachment bytes with it. */
async function dropStored(ctx: MutationCtx, row: Doc<'deleted_rows'>): Promise<void> {
  if (row.storage_id !== undefined) await ctx.storage.delete(row.storage_id)
  await ctx.db.delete(row._id)
}

/* The rows that travel with the item's tasks, while those tasks are still
 * absent from issues, so readers skip them (design 5.1). They go back in
 * their original order per task: a move stores a task's rows in the order
 * of the index it reads them by, which for comments and attachments is
 * their creation order, and this reads them back in the order stored. */
async function restoreRows(run: Run): Promise<boolean> {
  for (const table of RESTORED_ROWS) {
    const done = await drain(
      run.budget,
      (n) =>
        run.ctx.db
          .query('deleted_rows')
          .withIndex('by_item_table_owner', (q) => q.eq('item_id', run.item.id).eq('table', table))
          .take(n),
      (row) => writeRowBack(run, row),
      table === 'comments' || table === 'issue_attachments' ? LARGE_ROWS_PER_READ : ALL,
    )
    if (!done) return false
  }
  return true
}

/** Writes a stored relation row back without its archive mark, with org_id
 * where the table has it (design 5.2): a comment keeps its author and
 * editor, an attachment its uploader, only while they pass the reference
 * predicate; a follow and a label assignment stay only while their profile
 * or label passes it. Deletes the stored row. */
async function writeRowBack(run: Run, row: Doc<'deleted_rows'>): Promise<void> {
  const { org_id } = run.item
  const r = row.row
  if (r.table === 'comments')
    await run.ctx.db.insert('comments', {
      ...r.doc,
      author: await keptProfile(run, r.doc.author),
      edited_by: await keptProfile(run, r.doc.edited_by),
    })
  else if (r.table === 'issue_labels') {
    if (sameReference(await labelOf(run, r.doc.label_id), run.item))
      await run.ctx.db.insert('issue_labels', { ...r.doc, org_id, task_archived: undefined })
  } else if (r.table === 'issue_subscriptions') {
    if ((await keptProfile(run, r.doc.profile_id)) !== undefined)
      await run.ctx.db.insert('issue_subscriptions', { ...r.doc, task_archived: undefined })
  } else if (r.table === 'issue_attachments')
    await run.ctx.db.insert('issue_attachments', {
      ...r.doc,
      org_id,
      uploaded_by: await keptProfile(run, r.doc.uploaded_by),
      task_archived: undefined,
    })
  else throw new Error(`A restore cannot write a ${r.table} row back here`)
  await run.ctx.db.delete(row._id)
}

/* The item's links, after the rows above and before a project item's
 * tasks, so the archive steps scheduled for an archived task written back
 * (finishTxn) find every row of it in place. Writing a link before the
 * reveal shows nobody anything, because a read sends a link only when its
 * reader is shown both ends (lib/workingSet.ts linkShown), and a task of
 * the item is absent until then. Links that reach the item later are placed
 * by the reveal (design 5.2). */
const restoreLinks = (run: Run): Promise<boolean> =>
  drain(
    run.budget,
    (n) =>
      run.ctx.db
        .query('deleted_rows')
        .withIndex('by_item_table_owner', (q) =>
          q.eq('item_id', run.item.id).eq('table', 'issue_links'),
        )
        .take(n),
    (row) => placeLink(run, row),
    ALL,
  )

/** Where stored link `row` goes (design 5.2). Both ends live in the
 * organization, by the reference predicate, or tasks of this item: written
 * back unless a link already holds its pair. A task of this item is absent
 * until the reveal, so nobody sees the link before then, and a failed
 * reveal's move takes it back with the task. An end in another item that is
 * ready, moving or restoring: the link moves to that item, owned by that
 * end. Otherwise it is dropped. */
async function placeLink(run: Run, row: Doc<'deleted_rows'>): Promise<void> {
  const link = docOf(row, 'issue_links')
  let away: { item: Item; end: string } | null = null
  for (const end of [link.source_id, link.target_id]) {
    const where = await whereIsTask(run.ctx, end)
    const kept =
      where.where === 'live'
        ? sameReference(where.issue, run.item)
        : where.where === 'trash' &&
          sameReference(where.task, run.item) &&
          (where.item.id === run.item.id ||
            where.item.state === 'ready' ||
            where.item.state === 'moving' ||
            where.item.state === 'restoring')
    if (!kept) return await run.ctx.db.delete(row._id)
    if (where.where === 'trash' && where.item.id !== run.item.id) away ??= { item: where.item, end }
  }
  if (away !== null)
    return await run.ctx.db.patch(row._id, { item_id: away.item.id, owner_id: away.end })
  const taken = await run.ctx.db
    .query('issue_links')
    .withIndex('by_pair', (q) => q.eq('pair_key', link.pair_key))
    .first()
  if (taken === null)
    await run.ctx.db.insert('issue_links', {
      ...link,
      org_id: run.item.org_id,
      task_archived: undefined,
    })
  await run.ctx.db.delete(row._id)
}

type StoredTask = { row: Doc<'deleted_rows'>; doc: Stored<'issues'> }

/* A project item's tasks, written back under its projects, which stay
 * absent until the reveal (design 5.1), so these tasks stay hidden. A task
 * whose parent is in the item keeps it. A task whose parent is outside the
 * item stays stored: its parent is decided at the reveal, by the state
 * then (design 5.2), and writing it now would make that parent a group
 * before the reveal. */
const restoreTasks = (run: Run): Promise<boolean> =>
  run.item.kind === 'task'
    ? Promise.resolve(true)
    : eachStoredTask(run, async (task) => {
        const row = await run.ctx.db
          .query('deleted_rows')
          .withIndex('by_item_table_owner', (q) =>
            q.eq('item_id', run.item.id).eq('table', 'issues').eq('owner_id', task.task_id),
          )
          .first()
        if (row === null) return true
        const doc = docOf(row, 'issues')
        if (doc.parent_id !== undefined && !(await inThisItem(run, doc.parent_id))) return true
        await writeTask(run, { row, doc }, doc.parent_id)
        return true
      })

/** Whether task `taskId` belongs to this project item while it fills: a
 * task already written back sits under one of its absent projects, the
 * others are still stored in it. */
async function inThisItem(run: Run, taskId: string): Promise<boolean> {
  const issue = await byId(run.ctx, 'issues', taskId)
  if (issue !== null) return itemProjectIds(run.item).includes(issue.project_id)
  const stored = await run.ctx.db
    .query('deleted_rows')
    .withIndex('by_row', (q) => q.eq('table', 'issues').eq('row_id', taskId))
    .first()
  return stored?.item_id === run.item.id
}

/** Writes stored task `t` back into issues with parent `parentId` (design
 * 5.2): its holders kept only by the reference predicate and today's
 * assignment rule, creator and reporter only by the predicate, a fresh
 * done_at for an active Done task so the nightly sweep does not archive it
 * the next night (as a restore from the archive restarts it,
 * model/issues.ts doneStampUpdate), no archive mark, updated_at now.
 * Deletes the stored row and the task's deleted_tasks row, and counts the
 * task out of the tally. Returns the task as written. */
async function writeTask(
  run: Run,
  t: StoredTask,
  parentId: string | undefined,
): Promise<Doc<'issues'>> {
  const { doc } = t
  const active = doc.archived_at === undefined
  const _id = await run.ctx.db.insert('issues', {
    ...doc,
    parent_id: parentId,
    assignee_id: await keptHolder(run, doc.assignee_id, doc.project_id),
    reviewer_id: await keptHolder(run, doc.reviewer_id, doc.project_id),
    created_by: await keptProfile(run, doc.created_by),
    reporter_id: await keptProfile(run, doc.reporter_id),
    done_at: active && doc.status === 'done' ? run.now : doc.done_at,
    relations_marked: undefined,
    updated_at: run.now,
  })
  await run.ctx.db.delete(t.row._id)
  const light = await run.ctx.db
    .query('deleted_tasks')
    .withIndex('by_task', (q) => q.eq('task_id', doc.id))
    .collect()
  for (const row of light) if (row.item_id === run.item.id) await run.ctx.db.delete(row._id)
  tallyTask(tallyOf(run), { project_id: doc.project_id, archived: !active }, -1)
  if (!active) run.txn.archived.push(doc.id)
  run.budget.tasks -= 1
  charge(run.budget, t.row)
  const written = await run.ctx.db.get(_id)
  if (written === null) throw new Error('A restored task vanished on insert')
  return written
}

/* ----------------------------------------------------------- the reveal */

/** The reveal (design 5.1), one transaction. Relation rows that reached
 * the item after their phase send it back to restore_rows, and a subtask
 * whose project left since restore_split back there. A failed check (design
 * 5.3, asked again for the restorer) sends it back to moving. Otherwise it
 * writes back a project item's own rows, then the tasks still stored (every
 * task of a task item; a project item's tasks whose parent is outside it,
 * and late arrivals) and the links left, deletes the item and its
 * deleted_tasks rows, and narrates. Returns where to go on, or null once the
 * item is gone. */
async function reveal(run: Run): Promise<JobState | null> {
  for (const table of RESTORED_ROWS) {
    const late = await run.ctx.db
      .query('deleted_rows')
      .withIndex('by_item_table_owner', (q) => q.eq('item_id', run.item.id).eq('table', table))
      .first()
    if (late !== null) return { ...run.state, phase: 'restore_rows', cursor: undefined }
  }
  const restorer = run.actor
  if (restorer === undefined) return await sendBack(run, 'no_access')
  const block = await blockOf(run, restorer)
  if (block !== null) return await sendBack(run, block)
  const tasks = (await storedOf(run, 'issues')).map((row) => ({ row, doc: docOf(row, 'issues') }))
  for (const { doc } of tasks) {
    if ((await byId(run.ctx, 'issues', doc.id)) !== null) return await sendBack(run, 'conflict')
    if (run.item.kind === 'task' && (await namedProject(run, doc.project_id, 'project')) === null)
      return { ...run.state, phase: 'restore_split', cursor: undefined }
  }
  if (run.item.kind === 'project') await revealProjects(run)
  const written = await revealTasks(run, tasks, restorer)
  for (;;) {
    const links = await run.ctx.db
      .query('deleted_rows')
      .withIndex('by_item_table_owner', (q) =>
        q.eq('item_id', run.item.id).eq('table', 'issue_links'),
      )
      .take(TASK_PAGE)
    for (const row of links) await placeLink(run, row)
    if (links.length < TASK_PAGE) break
  }
  const left = await run.ctx.db
    .query('deleted_tasks')
    .withIndex('by_item', (q) => q.eq('item_id', run.item.id))
    .collect()
  for (const row of left) await run.ctx.db.delete(row._id)
  await run.ctx.db.delete(run.item._id)
  await announce(run, written, restorer)
  return null
}

/** A failed reveal: the item goes back to moving, and its steps take what
 * the restore wrote back into storage again (design 5.1), the rows of its
 * stored tasks first (move_drain). restore_by stays until the item is ready,
 * so a purge of an item that got stuck before then looks for those rows too
 * (purgeLive). The list shows the reason from the live state. */
async function sendBack(run: Run, reason: RestoreBlock): Promise<JobState> {
  const log = reason === 'conflict' ? console.error : console.warn
  log('A deleted item restore was sent back at its reveal', { item_id: run.item.id, reason })
  run.txn.failed.set(run.item.id, reason)
  await run.ctx.db.patch(run.item._id, { state: 'moving' })
  run.item = { ...run.item, state: 'moving' }
  return { phase: 'move_drain', tally: run.state.tally }
}

/* A project item's own rows as the hierarchy cleans them: its projects,
 * then their milestones, grants and team shares. */
async function revealProjects(run: Run): Promise<void> {
  for (const table of [
    'projects',
    'milestones',
    'project_access',
    'project_team_access',
  ] as const) {
    for (const row of await storedOf(run, table)) {
      const r = row.row
      if (r.table === 'projects')
        await run.ctx.db.insert('projects', await cleanProject(run, r.doc))
      else if (r.table === 'milestones') await run.ctx.db.insert('milestones', r.doc)
      else if (r.table === 'project_access') {
        const grant = await cleanGrant(run, r.doc)
        if (grant !== null) await run.ctx.db.insert('project_access', grant)
      } else if (r.table === 'project_team_access') {
        const share = await cleanShare(run, r.doc)
        if (share !== null) await run.ctx.db.insert('project_team_access', share)
      }
      await run.ctx.db.delete(row._id)
    }
  }
}

/** Writes the stored tasks `tasks` back, parents before children, each
 * keeping a parent inside the item. Then, with every task in place, a
 * parent outside the item is kept or cleared by the parent table (design
 * 5.2). Returns the tasks as written. */
async function revealTasks(
  run: Run,
  tasks: StoredTask[],
  restorer: Doc<'profiles'>,
): Promise<Doc<'issues'>[]> {
  const byTask = new Map(tasks.map((t) => [t.doc.id, t]))
  const depthOf = (t: StoredTask): number => {
    let depth = 0
    for (let up = t.doc.parent_id; up !== undefined && depth <= 20; depth++)
      up = byTask.get(up)?.doc.parent_id
    return depth
  }
  const own = new Set(itemProjectIds(run.item))
  const written = new Map<string, Doc<'issues'>>()
  const outside: (Doc<'issues'> & { parent_id: string })[] = []
  for (const t of [...tasks].sort((a, b) => depthOf(a) - depthOf(b))) {
    const parentId = t.doc.parent_id
    let inside = parentId !== undefined && byTask.has(parentId)
    if (parentId !== undefined && !inside && run.item.kind === 'project') {
      // a project item's tasks already back sit in its projects, live now
      const parent = await byId(run.ctx, 'issues', parentId)
      inside = parent !== null && own.has(parent.project_id)
    }
    const issue = await writeTask(run, t, inside ? parentId : undefined)
    written.set(issue.id, issue)
    if (parentId !== undefined && !inside) outside.push({ ...issue, parent_id: parentId })
  }
  for (const issue of outside) {
    const kept = await keptParent(run, issue, restorer)
    if (kept === null) continue
    await run.ctx.db.patch(issue._id, { parent_id: kept.parent.id })
    if (kept.grouped)
      await clearParentRemaining(run.ctx, {
        parentId: kept.parent.id,
        actor: restorer,
        now: run.now,
      })
    const after = await run.ctx.db.get(issue._id)
    if (after !== null) written.set(after.id, after)
  }
  return [...written.values()]
}

/** The parent `issue` (written back with none) keeps from outside the item,
 * by the parent table (design 5.2), or null to clear it. Only a live parent
 * in the organization that existed at deletion can stay. An active one
 * stays when the restorer passes the boolean form of assertParentChain
 * (sight and Edit on its project, at most 20 levels); an archived one only
 * for an archived task, within the same depth. `grouped`: the attach makes
 * the parent a group (an active task under an active parent, any task under
 * an archived one), so the parent loses its own remaining hours as on a
 * reparent (model/issues.ts clearParentRemaining). An archived parent that
 * holds hours of its own therefore needs the restorer's Edit too, so a
 * restore never changes a task in a project the restorer cannot edit. */
async function keptParent(
  run: Run,
  issue: Doc<'issues'> & { parent_id: string },
  restorer: Doc<'profiles'>,
): Promise<{ parent: Doc<'issues'>; grouped: boolean } | null> {
  const where = await whereIsTask(run.ctx, issue.parent_id)
  if (where.where !== 'live' || !sameReference(where.issue, run.item)) return null
  const { issue: parent } = where
  const active = parent.archived_at === undefined
  if (!active && issue.archived_at === undefined) return null
  const grouped = !active || issue.archived_at === undefined
  const clears = parent.remaining_hours !== undefined || parent.review_at !== undefined
  const checked = active || clears ? restorer : undefined
  const chain = await parentChain(run.ctx, issue, issue.parent_id, checked)
  return 'parent' in chain ? { parent: chain.parent, grouped } : null
}

/* What a reveal tells (design 5.4). A task item sends task.restored for
 * each task it wrote back, and its root's followers get the Restored notice
 * when the restore call held this item alone. A project item sends
 * neither, as its delete sent no task.deleted. The activity row is the
 * call's when it collects reveals, else the item's own. */
async function announce(
  run: Run,
  written: Doc<'issues'>[],
  restorer: Doc<'profiles'>,
): Promise<void> {
  if (run.item.kind === 'task') {
    for (const issue of written)
      await emitTaskEvent(run.ctx, { name: 'task.restored', issue, actor: restorer, now: run.now })
    const root = written.find((issue) => issue.id === run.item.target_id)
    if (run.state.alone === true && root !== undefined) await noticeRestored(run, root, restorer)
  }
  const revealed = { item: run.item, tasks: written.length }
  if (run.txn.revealed !== undefined) run.txn.revealed.push(revealed)
  else await narrate(run.ctx, [revealed], restorer, run.now)
}

/* The Restored notice to the followers of `root`, the one a restore from
 * the archive sends (model/issues.ts unarchiveIssueCore). */
async function noticeRestored(
  run: Run,
  root: Doc<'issues'>,
  restorer: Doc<'profiles'>,
): Promise<void> {
  const follows = run.ctx.db
    .query('issue_subscriptions')
    .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', root.id))
  for await (const follow of follows)
    await postMessage(run.ctx, {
      org_id: root.org_id,
      recipient_id: follow.profile_id,
      issue_id: root.id,
      kind: 'change',
      body: 'Restored',
      actor_id: restorer.id,
      now: run.now,
      issue: root,
    })
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** One activity row for the items one transaction revealed (design 5.4):
 * a single task item's row on its root task, a single project item's row on
 * its project, or for several one row that counts them ("restored 3 tasks
 * from Deleted items"). That row is filed under the project the items
 * share; otherwise it is a project row without project_id, which only
 * organization admins receive (lib/activityVisibility.ts), so its count
 * names no project to anyone else. */
async function narrate(
  ctx: MutationCtx,
  revealed: Revealed[],
  actor: Doc<'profiles'>,
  now: string,
): Promise<void> {
  const [first] = revealed
  if (first === undefined) return
  const row = { org_id: first.item.org_id, actor_id: actor.id, verb: 'restored', ts: now }
  const detail = 'from Deleted items'
  if (revealed.length === 1) {
    const { item } = first
    await logActivity(ctx, {
      ...row,
      target_type: item.kind === 'task' ? 'issue' : 'project',
      target_id: item.target_id,
      label: item.name,
      detail,
      project_id: item.project_id,
    })
    return
  }
  const projects = revealed.filter((r) => r.item.kind === 'project').length
  const tasks = revealed.reduce((n, r) => n + (r.item.kind === 'task' ? r.tasks : 0), 0)
  const shared = revealed.every((r) => r.item.project_id === first.item.project_id)
    ? first.item.project_id
    : undefined
  await logActivity(ctx, {
    ...row,
    target_type: 'project',
    target_id: shared ?? first.item.org_id,
    label: [projects > 0 && plural(projects, 'project'), tasks > 0 && plural(tasks, 'task')]
      .filter((part) => part !== false)
      .join(' and '),
    detail,
    project_id: shared,
  })
}

/* ------------------------------------------------------------ restoring */

/**
 * Restores `items` for `me`, as deletedItems.restore will (design 5). The
 * caller loads each item through the visibility fence (design 6.1); this
 * checks the rest per item and never throws for one item's problem.
 * Project items go first. A task item whose project, or a sub-project item
 * whose parent, is in a project item this call restores is deferred, for
 * the client to send again once that item has left the list. Every other
 * item is refused with its RestoreBlock or restored: it becomes restoring,
 * with restore_by, and the call's one shared budget fills and reveals as
 * much as it can; the rest goes on in steps. The reveals of this call share
 * one activity row, and an item revealed by a later step writes its own.
 * The Restored notice goes out only when the call held a single task item,
 * whichever transaction reveals it.
 */
export async function restoreItems(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; items: Item[]; now: string },
): Promise<RestoreResult> {
  if (a.items.length > RESTORE_MAX)
    throw rule(`at most ${RESTORE_MAX} items can be restored at a time`)
  const budget = budgetFor(1)
  const counted = metered(ctx, budget)
  const result: RestoreResult = { restored: [], refused: [], deferred: [] }
  const ids = new Set<string>()
  const ordered = [
    ...a.items.filter((item) => item.kind === 'project'),
    ...a.items.filter((item) => item.kind === 'task'),
  ].filter((item) => !ids.has(item.id) && ids.add(item.id))
  const txn: Txn = { ...newTxn(), revealed: [], restorer: a.me, now: a.now }
  const started: Item[] = []
  for (const given of ordered) {
    // an earlier item of the call may have counted a subtask into this one
    const item = (await byId(counted, 'deleted_items', given.id)) ?? given
    const above = item.kind === 'task' ? item.project_id : item.parent_project_id
    if (started.some((p) => p.kind === 'project' && p.projects.some((x) => x.id === above))) {
      result.deferred.push(item.id)
      continue
    }
    const block = await restoreBlock(counted, a.me, item)
    if (block !== null) {
      result.refused.push({ id: item.id, reason: block })
      continue
    }
    started.push(item)
    const fields = { state: 'restoring' as const, restore_by: a.me.id }
    await counted.db.patch(item._id, fields)
    const restoring: Item = { ...item, ...fields }
    const state: JobState = {
      phase: 'restore_split',
      tally: tallyFromItem(item),
      alone: ordered.length === 1 || undefined,
    }
    const next = await work(counted, budget, restoring, state, txn)
    if (next !== null) await saveJob(ctx, restoring, next, null)
    const failed = txn.failed.get(item.id)
    if (failed === undefined) result.restored.push(item.id)
    else result.refused.push({ id: item.id, reason: failed })
  }
  await narrate(ctx, txn.revealed ?? [], a.me, a.now)
  await finishTxn(ctx, txn)
  return result
}

/* --------------------------------------------------------------- the jobs */

/* The work each phase does, true when it is complete, and the phase that
 * follows it. The finish phases and the reveal are handled in `work`. A
 * project item drains its stored tasks' rows only after a failed restore
 * (sendBack), and then moves its projects' tasks again. */
const PHASES: Record<
  Exclude<TrashPhase, 'move_finish' | 'purge_finish' | 'restore_reveal'>,
  { run: (run: Run) => Promise<boolean>; next: (item: Item) => TrashPhase }
> = {
  move_edges: { run: moveEdges, next: () => 'move_tasks' },
  move_tasks: { run: moveProjectTasks, next: () => 'move_finish' },
  move_drain: {
    run: moveDrain,
    next: (item) => (item.kind === 'project' ? 'move_edges' : 'move_finish'),
  },
  restore_split: { run: restoreSplit, next: () => 'restore_rows' },
  restore_rows: { run: restoreRows, next: () => 'restore_links' },
  restore_links: { run: restoreLinks, next: () => 'restore_tasks' },
  restore_tasks: { run: restoreTasks, next: () => 'restore_reveal' },
  purge_dependents: { run: purgeDependents, next: () => 'purge_live' },
  purge_live: { run: purgeLive, next: () => 'purge_rows' },
  purge_rows: { run: purgeRows, next: () => 'purge_activity' },
  purge_activity: { run: purgeActivity, next: () => 'purge_projects' },
  purge_projects: { run: (run) => purgeStored(run, 'projects'), next: () => 'purge_finish' },
}

/** Who acts in `item`'s phase: nobody for a purge; the deleter for a move,
 * unless their id was reused; the restorer for a restore, while their seat
 * in the item's organization is active. */
async function actorOf(
  ctx: QueryCtx,
  item: Item,
  phase: TrashPhase,
  txn: Txn,
): Promise<Doc<'profiles'> | undefined> {
  if (phase.startsWith('purge')) return undefined
  if (phase.startsWith('restore')) {
    if (txn.restorer !== undefined) return txn.restorer
    const restorer =
      item.restore_by === undefined ? null : await byId(ctx, 'profiles', item.restore_by)
    return restorer?.org_id === item.org_id && restorer.active ? restorer : undefined
  }
  const deleter =
    item.deleted_by === undefined ? null : await byId(ctx, 'profiles', item.deleted_by)
  return sameReference(deleter, item) ? deleter : undefined
}

/** Whether what is left of `run`'s budget holds its reveal, which writes the
 * item's stored tasks back in one transaction whatever their number. */
function revealFits(run: Run): boolean {
  const tasks = run.state.tally?.tasks ?? 0
  const b = run.budget
  return (
    !spent(b) && tasks <= b.tasks && tasks <= b.rows && tasks * REVEAL_RANGES_PER_TASK <= b.ranges
  )
}

/** Runs `item`'s phases from `state` with `budget`, which `ctx` is metered
 * against. Returns null when the item's work is done: a move made it ready,
 * a restore revealed it, a purge deleted it. Otherwise returns where the
 * next step starts. The reveal runs in one transaction whatever its size, so
 * it runs where the budget left holds it (revealFits), else at the start of
 * a step of its own. */
async function work(
  ctx: MutationCtx,
  budget: Budget,
  item: Item,
  state: JobState,
  txn: Txn,
): Promise<JobState | null> {
  const run: Run = {
    ctx,
    item,
    memo: newMemo(),
    state: { phase: state.phase, cursor: state.cursor, tally: state.tally, alone: state.alone },
    budget,
    actor: await actorOf(ctx, item, state.phase, txn),
    preload: undefined,
    // stamps each step with its own time, as profileRemovals.ts does
    now: txn.now ?? new Date().toISOString(),
    txn,
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
    if (phase === 'restore_reveal') {
      if (run.budget.moved && !revealFits(run)) return run.state
      const next = await reveal(run)
      if (next === null) return null
      run.state = next
      continue
    }
    if (!(await PHASES[phase].run(run))) return run.state
    run.state = { ...run.state, phase: PHASES[phase].next(run.item), cursor: undefined }
  }
}

/** Schedules what a transaction's items left for after it: the archive
 * steps of the archived tasks it wrote back, in one call. */
async function finishTxn(ctx: MutationCtx, txn: Txn): Promise<void> {
  if (txn.archived.length > 0) await scheduleArchivedReads(ctx, { issues: txn.archived })
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
    alone: state.alone,
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
  const txn = newTxn()
  const next = await work(metered(ctx, budget), budget, item, job, txn)
  await finishTxn(ctx, txn)
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
  const txn = newTxn()
  const next = await work(metered(ctx, budget), budget, item, state, txn)
  await finishTxn(ctx, txn)
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

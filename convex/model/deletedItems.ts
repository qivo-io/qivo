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
 * work appears complete in one delivery. A project item's tasks whose
 * parent is outside it go back without that parent and get it after the
 * reveal, by the state then (attachParents). That happens in the reveal's
 * own transaction when they fit in what its budget has left, otherwise in
 * steps just after it, while the tasks show without their parent. A task
 * item first hands each subtask whose project is no longer live to the item
 * that holds that project. References that no longer name what the item stored
 * are dropped (sameReference). A parent outside the item stays only by the
 * parent table (keptParent), which also asks, as a reparent does, that
 * everyone working on the task or its subtasks can see that parent. A
 * reveal whose checks fail sends the item back to moving, and the move
 * takes the rows back.
 *
 * Who sees and restores what (design 5.3, 6.1). viewOf decides what one
 * seat sees of an item, restoreBlock why that seat cannot restore it, and
 * myItem fences every public load with viewOf. A task item is judged over
 * the live projects it goes back to, a project item over its stored rows
 * (storedLevels), each with the seat in the item's organization. A Memo
 * keeps the reads they repeat; a list read seeds one per seat (sightOf).
 *
 * The step machine. Each step spends one budget, TRASH_BUDGET scaled by the
 * job's budget_scale: rows moved, their bytes, task rows moved and index
 * ranges read. `metered` counts the ranges of every read a step makes,
 * notifications included. The parent checks of a restore (keptParent) also
 * count the bytes they read, and a check that runs out of the step's reads
 * waits for the next step, where it comes first and runs whole within
 * HEIGHT_READ and SIGHT_READ. Progress is counted in rows. A step always
 * moves at least one row, documents without a size cap are read
 * LARGE_ROWS_PER_READ at a time, and most phases read the start of a range
 * again rather than keep a cursor, because moving a row takes it out of the
 * range. The user's mutation spends the first budget itself, so most
 * deletes never schedule a step. Convex drops what a failed step scheduled,
 * so `recoverJobs` restarts a stalled job at half the budget, and an item
 * whose step still fails RETRY.atFloor times at the smallest budget becomes
 * stuck, for an admin's Delete now; a restore that fails that often goes
 * back to moving instead, as a failed reveal does, and one past its reveal
 * leaves the tasks it has not attached without their parent. A step that
 * commits resets the job to the full budget and no retries.
 *
 * Steps need neither the deleter's nor the restorer's profile: notices and
 * events then go out without an actor. Only a reveal needs the restorer,
 * whose permission it checks again; without them it sends the item back.
 * The attach after a reveal keeps no parent that needs their Edit once
 * they are gone. A step returns without work when its item or job is gone,
 * or once its organization is being deleted: a demo organization whose
 * cleanup has begun, or any organization whose deletion has begun
 * (orgRemovals.ts). Recovery and the expiry leave such an organization's
 * items and jobs alone too. Before its deletion begins, while the
 * organization is read-only, restores are refused as other writes are
 * (orgReadOnly), but steps, recovery and the expiry go on.
 *
 * In a public demo, the rows a move or restore carries between the live
 * tables and Deleted items, with the bookkeeping rows that go with them,
 * spend none of the visitor's record limit and skip its payload check
 * (lib/demo.ts uncountedWriter): the number of records stays as it was. The
 * item row, activity rows and notices count as any write does, and each user
 * transaction counts as one demo change.
 *
 * A task's comment count (model/commentCounts.ts) does not travel with it.
 * It is deleted before the task's other rows wherever they leave the live
 * tables: when the move drains them, or a purge or teardown deletes them
 * (dropCommentCount). The user's own transaction so reads nothing more per
 * task, and no count comes back with a task, whose thread a restore writes
 * anew. A restored task is counted again at its next post, as any task
 * without a count is.
 *
 * Teardowns that delete an organization's work outright (deleteOrgDeep, an
 * organization's deletion in steps, the public demo's cleanup, the
 * Northstar wipe) empty its Deleted items with clearOrgTrash, whatever
 * state the items are in. */

import {
  type FilterBuilder,
  makeFunctionReference,
  type NamedTableInfo,
  type WithoutSystemFields,
} from 'convex/server'
import { compareValues } from 'convex/values'
import type { DataModel, Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import {
  canHoldWork,
  canLeadProjects,
  hasProjectLevel,
  levelRank,
  levelsFrom,
  type OrgProjectLevels,
  projectLevel,
  projectLevelsForOrg,
} from '../lib/access'
import { deletionBegun, orgWriteBlock } from '../lib/billingAccess'
import { byId, LARGE_ROWS_PER_READ } from '../lib/db'
import { demoForOrg, isDemoDeployment, uncountedWriter } from '../lib/demo'
import {
  type AccessLevel,
  LEVEL_RANK,
  type ProjectType,
  STORED_TABLES,
  type StoredTable,
  type TrashPhase,
} from '../lib/enums'
import { notFound, rule } from '../lib/functions'
import { DELETE_REASON_MAX } from '../lib/textLimits'
import { logActivity } from './activity'
import { storageIdInUse } from './attachments'
import { dropCommentCount } from './commentCounts'
import { estimateDocumentBytes } from './demoMetrics'
import { assertCanEdit, clearParentRemaining, detachChild } from './issues'
import { type NotifyPreload, postMessage, scheduleArchivedReads } from './messages'
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

/** Charges the bytes of a document a step reads and leaves where it is, so
 * that a scan which passes over large documents stops on the byte budget
 * too. Returns the bytes charged. */
function chargeRead(b: Budget, doc: unknown): number {
  const bytes = estimateDocumentBytes(doc)
  b.bytes -= bytes
  return bytes
}

/** Whether a step has no reads left, once it has moved a row and spent its
 * index ranges or bytes. A parent check that would read past them waits
 * for the next step (allSee). */
const readsSpent = (b: Budget): boolean => b.moved && (b.ranges <= 0 || b.bytes <= 0)

/** Clears the rows `read` returns until the range is empty (true) or the
 * budget is spent (false). `clear` must take each row out of the range,
 * because every read starts at the beginning of the range again
 * (model/cascade.ts sweep, with this file's budget). A `clear` that answers
 * false leaves its row where it is, for the next step, and ends the drain
 * (false). */
async function drain<Row>(
  b: Budget,
  read: (n: number) => Promise<Row[]>,
  clear: (row: Row) => Promise<void> | Promise<boolean>,
  perRead: number,
): Promise<boolean> {
  while (!spent(b)) {
    const n = Math.max(1, Math.min(b.rows, perRead))
    const rows = await read(n)
    for (const row of rows) {
      if ((await clear(row)) === false) return false
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

/** How a metered database counts its reads. `range` runs once for each
 * index range a read takes, and `doc`, when given, for each document a read
 * returns. */
type Meter = { range: () => void; doc?: (doc: unknown) => void }

/** What reads cost, in index ranges and the bytes of the documents they
 * return. */
type Cost = { ranges: number; bytes: number }

/** `query` whose reads `meter` counts. The queries it returns (withIndex,
 * filter, order) are metered too. */
function meterQuery<Q extends object>(query: Q, meter: Meter): Q {
  return new Proxy(query, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const reads = READS.has(key)
        if (reads) meter.range()
        const result: unknown = value.apply(target, args)
        if (reads) return weighed(key, result, meter.doc)
        return typeof result === 'object' && result !== null && 'take' in result
          ? meterQuery(result, meter)
          : result
      }
    },
  })
}

/** What read `key` (a READS method or db.get) returns, passing each
 * document it yields to `doc`. Those are the rows of collect, take and
 * paginate, the row of first, unique and get, and each row an iteration
 * reaches. */
function weighed(key: string | symbol, result: unknown, doc: Meter['doc']): unknown {
  if (doc === undefined) return result
  if (key === Symbol.asyncIterator) {
    // the query itself, which iterates its rows (convex/server QueryImpl)
    const rows = result as AsyncIterator<unknown>
    const iterator: AsyncIterableIterator<unknown> = {
      async next() {
        const next = await rows.next()
        if (next.done !== true) doc(next.value)
        return next
      },
      async return(value?: unknown) {
        return (await rows.return?.(value)) ?? { done: true, value }
      },
      [Symbol.asyncIterator]: () => iterator,
    }
    return iterator
  }
  return (result as Promise<unknown>).then((out) => {
    const docs = key === 'paginate' ? (out as { page: unknown[] }).page : out
    for (const row of Array.isArray(docs) ? docs : [docs]) if (row !== null) doc(row)
    return out
  })
}

/** `ctx` whose database reads `meter` counts, wherever they happen. It
 * wraps the database the way lib/demo.ts demoWriter does for its own
 * accounting, and passes properties that are not functions on as they are,
 * demoWriter's uncounted writer included. */
function meterDb(ctx: MutationCtx, meter: Meter): MutationCtx {
  const db = new Proxy(ctx.db, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      if (key === 'get')
        return (...args: unknown[]) => {
          meter.range()
          return weighed(key, value.apply(target, args), meter.doc)
        }
      if (key === 'query')
        return (...args: unknown[]) => meterQuery(value.apply(target, args), meter)
      return value.bind(target)
    },
  })
  return { ...ctx, db }
}

/** `ctx` whose database reads each spend one range of `budget`, wherever in
 * the step they happen. */
const metered = (ctx: MutationCtx, budget: Budget): MutationCtx =>
  meterDb(ctx, {
    range: () => {
      budget.ranges -= 1
    },
  })

/** `ctx` whose reads also add to `cost`, one range each and the bytes of
 * each document they return. Over a step's metered ctx, the step's budget
 * still counts the ranges, and the caller charges the bytes. */
const measured = (ctx: MutationCtx, cost: Cost): MutationCtx =>
  meterDb(ctx, {
    range: () => {
      cost.ranges += 1
    },
    doc: (doc) => {
      cost.bytes += estimateDocumentBytes(doc)
    },
  })

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
    lead_id: live.table === 'projects' ? live.doc.lead_id : undefined,
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
  await uncountedWriter(ctx.db).insert('deleted_rows', stored)
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
    // file names stored before attachFileCore capped them have no size cap
    perRead: LARGE_ROWS_PER_READ,
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

/** Reads the restore and visibility rules repeat, kept for one transaction:
 * for one item in a restore or a step, where nothing the restore writes
 * changes them before its reveal, or for every item one person's list read
 * looks at (sightOf). Entries that depend on the item are keyed by its id. */
export type Memo = {
  /** Whether a restore check also looks for a live row holding the item's
   * uuids or keys (the 'conflict' block). A list read leaves that to the
   * restore, which the reservations should make pass anyway. */
  conflicts: boolean
  profiles: Map<string, Promise<Doc<'profiles'> | null>>
  teams: Map<string, Promise<Doc<'teams'> | null>>
  labels: Map<string, Promise<Doc<'labels'> | null>>
  /** live projects by id */
  projects: Map<string, Promise<Doc<'projects'> | null>>
  /** a person's level on a live project, keyed `profile:project` */
  live: Map<string, Promise<AccessLevel | null>>
  /** a person's live teams in the organization, by profile */
  teamsOf: Map<string, Promise<Set<string>>>
  /** a person's live grant and team shares on a live parent, keyed `parent:profile` */
  parentAccess: Map<string, Promise<LevelGrants>>
  /** whether the organization is read-only, by organization (orgReadOnly) */
  readOnly: Map<string, Promise<boolean>>
  /** the item holding a stored project, by project */
  heldBy: Map<string, Promise<string | undefined>>
  /** a project item's hierarchy, by item */
  hierarchy: Map<string, Promise<Hierarchy>>
  /** a person's levels inside a project item, keyed `item:profile` */
  levels: Map<string, Promise<OrgProjectLevels>>
  /** whether a holder stays, keyed `item:profile:project` */
  holders: Map<string, Promise<boolean>>
  /** whether a task belongs to the project item a step restores, by task
   * (inThisItem); its answer holds for the whole step */
  inItem: Map<string, Promise<boolean>>
  /** the project a task of the item a step restores goes back to, by task
   * (restoredProject) */
  restoredProjects: Map<string, Promise<string | undefined>>
}

export const newMemo = (): Memo => ({
  conflicts: true,
  profiles: new Map(),
  teams: new Map(),
  labels: new Map(),
  projects: new Map(),
  live: new Map(),
  teamsOf: new Map(),
  parentAccess: new Map(),
  readOnly: new Map(),
  heldBy: new Map(),
  hierarchy: new Map(),
  levels: new Map(),
  holders: new Map(),
  inItem: new Map(),
  restoredProjects: new Map(),
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
  await uncountedWriter(ctx.db).insert('deleted_tasks', {
    org_id: item.org_id,
    item_id: item.id,
    task_id: task.id,
    num: task.num,
    title: task.title,
    project_id: task.project_id,
    archived,
    cross_project_id:
      item.kind === 'task' && task.project_id !== item.project_id ? task.project_id : undefined,
  })
  tally.tasks += 1
  if (archived) tally.archived_tasks += 1
  const project = tally.projects.find((p) => p.id === task.project_id)
  if (project !== undefined) {
    project.tasks += 1
    if (archived) project.archived_tasks += 1
  }
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

/** The children of task `parentId` whose project is not one of `ids`, as
 * one query per range of project ids that `ids` leaves out: below the
 * first, between each two and above the last, in Convex's order of strings
 * (issues.by_parent_project). Each call gives a fresh query. Together they
 * read every such child and none of the others, so a task with many
 * children inside a project item costs a few ranges, not their bytes,
 * which a `.filter` would read and the step's budget would never see. */
function childrenOutside(ctx: QueryCtx, parentId: string, ids: string[]) {
  const bounds = [...new Set(ids)].sort(compareValues)
  return [undefined, ...bounds].map((above, i) => {
    const below: string | undefined = bounds[i]
    return () =>
      ctx.db.query('issues').withIndex('by_parent_project', (q) => {
        const children = q.eq('parent_id', parentId)
        if (above === undefined)
          return below === undefined ? children : children.lt('project_id', below)
        const from = children.gt('project_id', above)
        return below === undefined ? from : from.lt('project_id', below)
      })
  })
}

/** Moves (keep) or deletes (purge) task `task` of a project item with what
 * travels with it, in order: its comment count, which is deleted, its rows,
 * its messages, its children outside the item's projects (childrenOutside),
 * then the task row. True once the task row is gone.
 * A task left half done stays hidden, because its project is absent, and
 * the next step picks it up. A task too large to store is purged instead.
 * A task that a restore wrote back without its parent, and that still waits
 * for it, is stored with that parent again (takeParent). Tasks of a deleted
 * project emit no task.deleted. */
async function clearTask(run: Run, task: Doc<'issues'>, mode: Mode): Promise<boolean> {
  const live = { table: 'issues', doc: task } as const
  const how = mode === 'keep' && tooLarge(run.item, live, task.id) ? 'purge' : mode
  await dropCommentCount(run.ctx, task.id)
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
  const preload = await preloadOf(run)
  for (const children of childrenOutside(run.ctx, task.id, itemProjectIds(run.item))) {
    const detached = await drain(
      run.budget,
      (n) => children().take(n),
      (child) => detachChild(run.ctx, child, run.actor, run.now, preload),
      LARGE_ROWS_PER_READ,
    )
    if (!detached) return false
  }
  const parent_id = await takeParent(run.ctx, task, run.item)
  if (how === 'keep') await storeTask(run.ctx, run.item, tallyOf(run), { ...task, parent_id })
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

/** Whether `task`, which a restore of project item `item` wrote back
 * without its parent outside the item, still waits for that parent: it has
 * no parent of its own and is in one of the item's projects. Otherwise
 * someone changed it since, and it stays as they left it. */
const waitsFor = (item: Item, task: Doc<'issues'>): boolean =>
  task.parent_id === undefined && itemProjectIds(item).includes(task.project_id)

/** The parent `task` is stored with as it moves to `mover`. A project
 * item's restore may have written the task back without its parent outside
 * that item, to give it back after the reveal (deleted_item_parents). While
 * the task still waits for it (waitsFor) it is that parent; otherwise it is
 * the task's own. Every move asks, and so does a purge of a live task, and
 * the row goes either way. A task that goes to Deleted items again before
 * its turn therefore keeps the parent it had there, and the restore that
 * wrote it back does not attach it when it shows again. A task has at most
 * one such row, because a move takes it before another restore can write
 * one. */
async function takeParent(
  ctx: MutationCtx,
  task: Doc<'issues'>,
  mover: Item,
): Promise<string | undefined> {
  const waiting = await ctx.db
    .query('deleted_item_parents')
    .withIndex('by_task', (q) => q.eq('task_id', task.id))
    .first()
  if (waiting === null) return task.parent_id
  await ctx.db.delete(waiting._id)
  const restoring =
    waiting.item_id === mover.id ? mover : await byId(ctx, 'deleted_items', waiting.item_id)
  return restoring !== null && waitsFor(restoring, task) ? waiting.parent_id : task.parent_id
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
 * on a tie of _creationTime is found by the finish check, which walks the
 * range again from its start. */
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

/* Tasks other people see move first. They are the open tasks with a
 * parent or a child outside the item's projects (isEdge), so a surviving
 * parent stops being a group and a surviving child stops showing a hidden
 * parent as early as possible (design 4.1). Only open tasks have either effect, because an
 * open task never sits under an archived one. The scan keeps a cursor,
 * because the tasks it passes over stay in its range, and charges the bytes
 * of every task, parent and child it reads, so a step over large tasks it
 * passes over stays within its budget (the first step runs in the user's
 * own delete). It reads no child inside the item to find one outside
 * (childrenOutside), so the children of one task cannot pass the
 * transaction's read limit either. */
async function moveEdges(run: Run): Promise<boolean> {
  const ids = itemProjectIds(run.item)
  const parents = new Map<string, Doc<'issues'> | null>()
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
      chargeRead(run.budget, task)
      if ((await isEdge(run, task, ids, parents)) && !(await clearTask(run, task, 'keep'))) {
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

/** Whether open task `task` has a parent or a child outside `ids`. An
 * archived child outside counts too. Finding only open ones would read past
 * every archived child outside, and moving such a task early only detaches
 * those children sooner, as its move does anyway. `parents` keeps the
 * parents the step read: a move changes no task's project, so each answer
 * holds for the step. */
async function isEdge(
  run: Run,
  task: Doc<'issues'>,
  ids: string[],
  parents: Map<string, Doc<'issues'> | null>,
): Promise<boolean> {
  const { parent_id } = task
  if (parent_id !== undefined) {
    let parent = parents.get(parent_id)
    if (parent === undefined) {
      parent = await byId(run.ctx, 'issues', parent_id)
      parents.set(parent_id, parent)
      if (parent !== null) chargeRead(run.budget, parent)
    }
    if (parent !== null && !ids.includes(parent.project_id)) return true
  }
  for (const children of childrenOutside(run.ctx, task.id, ids)) {
    const child = await children().first()
    if (child !== null) {
      chargeRead(run.budget, child)
      return true
    }
  }
  return false
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

/* A task item's stored tasks: the rows that travel with each, after its
 * comment count, which is deleted. */
const moveDrain = (run: Run): Promise<boolean> =>
  eachStoredTask(run, async ({ task_id }) => {
    await dropCommentCount(run.ctx, task_id)
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
 * else null, or move_finish while the check has more to read. Once a task
 * row has left issues nothing can add a row naming it, so a project item's
 * ranges are its projects' tasks and rows. A failed restore also wrote rows
 * of tasks it left stored back; its move drains those first (move_drain),
 * and the finish does not read them again, because that would read each of
 * the item's tasks in one transaction. A task item's check reads the rows of
 * each stored task, a few ranges each, so it walks them with the job's
 * cursor within the step's budget, as move_drain does, and goes on in the
 * next step when the budget runs out. */
async function moveLeft(run: Run): Promise<TrashPhase | null> {
  if (run.item.kind === 'task') {
    let held = false
    const done = await eachStoredTask(run, async ({ task_id }) => {
      held = await holdsRows(run.ctx, TASK_ROWS, task_id)
      return !held
    })
    if (held) return 'move_drain'
    return done ? null : 'move_finish'
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
      await dropCommentCount(run.ctx, task_id)
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

/* The index ranges a reveal may read per task it writes back or attaches.
 * A task item of 41 tasks with holders, a parent outside, task.restored
 * subscriptions and the Restored notice measured about 6. With a different
 * assignee and reviewer on each task, 80 people who must all see the
 * parent's project (keptParent), it measured about 22, most of it each
 * person's assignment check (keepsHolder). Convex's 4,096 ranges leave room
 * for that above TRASH_BUDGET's 2,500, and a check of who sees a parent that
 * runs out of what the budget has left makes the reveal wait for a step of
 * its own (revealTasks). */
const REVEAL_RANGES_PER_TASK = 20

/** Why an item cannot be restored now (design 5.3). The item's state while
 * it is not ready; read_only while billing or a pending deletion makes the
 * organization read-only (orgReadOnly); then the blocked
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

/* `read`, run once per key in one transaction (Memo). */
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

/** The live project `id`, or null. */
const projectOf = (s: Scope, id: string) =>
  memoRead(s.memo.projects, id, () => byId(s.ctx, 'projects', id))

/** The live project `id` when it is the one the item stored (the reference
 * predicate, with the type rule when `type` is given). */
async function namedProject(s: Scope, id: string, type?: ProjectType) {
  const project = await projectOf(s, id)
  return sameReference(project, s.item, type) ? project : null
}

/** `me`'s level on live project `project` (lib/access.ts projectLevel). */
const liveLevel = (s: Scope, me: Doc<'profiles'>, project: Doc<'projects'>) =>
  memoRead(s.memo.live, `${me.id}:${project.id}`, () => projectLevel(s.ctx, me, project))

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
  return memoRead(s.memo.hierarchy, s.item.id, async () => {
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
  })
}

/** `profile`'s levels on a project item's projects while they are in
 * Deleted items (design 6.1): lib/access.ts levelsFrom over the projects as
 * the reveal writes them back, the profile's stored grants, the stored
 * shares of the teams it belongs to now, and the live grants and shares on
 * a sub-project item's parent. */
function storedLevels(s: Scope, profile: Doc<'profiles'>): Promise<OrgProjectLevels> {
  return memoRead(s.memo.levels, `${s.item.id}:${profile.id}`, async () => {
    const h = await hierarchyOf(s)
    const teams = await teamsOf(s, profile)
    const grants: LevelGrants['grants'] = h.grants.filter((g) => g.profile_id === profile.id)
    const shares: LevelGrants['shares'] = h.shares.filter((g) => teams.has(g.team_id))
    if (h.parent === null) return levelsFrom(profile, h.projects, grants, shares)
    const parent = await parentAccess(s, h.parent, profile)
    return levelsFrom(
      profile,
      [...h.projects, h.parent],
      [...grants, ...parent.grants],
      [...shares, ...parent.shares],
    )
  })
}

/** Grants and team shares as lib/access.ts levelsFrom takes them. */
type LevelGrants = {
  grants: Pick<Doc<'project_access'>, 'project_id' | 'level'>[]
  shares: Pick<Doc<'project_team_access'>, 'project_id' | 'level'>[]
}

/** The live teams `profile` belongs to in its organization. */
const teamsOf = (s: Scope, profile: Doc<'profiles'>) =>
  memoRead(s.memo.teamsOf, profile.id, async () => {
    const teams = new Set<string>()
    const memberships = s.ctx.db
      .query('team_members')
      .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
    for await (const m of memberships)
      if ((await teamOf(s, m.team_id))?.org_id === profile.org_id) teams.add(m.team_id)
    return teams
  })

/** `profile`'s own grant and its teams' shares on live project `parent`. */
const parentAccess = (s: Scope, parent: Doc<'projects'>, profile: Doc<'profiles'>) =>
  memoRead(s.memo.parentAccess, `${parent.id}:${profile.id}`, async (): Promise<LevelGrants> => {
    const teams = await teamsOf(s, profile)
    const own = await s.ctx.db
      .query('project_access')
      .withIndex('by_project_profile', (q) =>
        q.eq('project_id', parent.id).eq('profile_id', profile.id),
      )
      .unique()
    const shares: LevelGrants['shares'] = []
    const parentShares = s.ctx.db
      .query('project_team_access')
      .withIndex('by_project', (q) => q.eq('project_id', parent.id))
    for await (const share of parentShares) if (teams.has(share.team_id)) shares.push(share)
    return { grants: own === null ? [] : [own], shares }
  })

/** Whether `id` can stay a task's assignee or reviewer in `projectId`: the
 * profile passes the reference predicate and today's assignment rule there
 * (lib/access.ts profileCanBeAssigned). While the project is still in
 * Deleted items, its level comes from the stored rows. */
function keepsHolder(s: Scope, id: string, projectId: string): Promise<boolean> {
  return memoRead(s.memo.holders, `${s.item.id}:${id}:${projectId}`, async () => {
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

/** The assignee and reviewer stored task `doc` comes back with (keepsHolder). */
const restoredHolders = async (
  s: Scope,
  doc: Pick<Stored<'issues'>, 'assignee_id' | 'reviewer_id' | 'project_id'>,
) => ({
  assignee_id: await keptHolder(s, doc.assignee_id, doc.project_id),
  reviewer_id: await keptHolder(s, doc.reviewer_id, doc.project_id),
})

/** Whether organization `orgId` is read-only, because billing pauses
 * editing or the organization waits for its deletion (lib/billingAccess.ts
 * orgWriteBlock), read once per memo. The restore and Delete now wrappers
 * refuse then (lib/functions.ts orgMutation, adminMutation), so the list
 * offers neither, and a reveal sends its item back. The expiry and the
 * steps go on: items keep expiring while the organization is read-only. */
export const orgReadOnly = (ctx: QueryCtx, memo: Memo, orgId: string): Promise<boolean> =>
  memoRead(memo.readOnly, orgId, async () => (await orgWriteBlock(ctx, orgId)) !== null)

/** Why `me` cannot restore `item` now, else null (design 5.3). Callers
 * check the item's state; the reveal asks again for the restorer. */
async function blockOf(s: Scope, me: Doc<'profiles'>): Promise<RestoreBlock | null> {
  const { org_id } = s.item
  if (me.org_id !== org_id) return 'no_access'
  if (await orgReadOnly(s.ctx, s.memo, org_id)) return 'read_only'
  return s.item.kind === 'task' ? await taskItemBlock(s, me) : await projectItemBlock(s, me)
}

/* A task item goes back into its root's project, which must be live and
 * not archived, and the person needs Edit on every live project its tasks
 * go back to. A subtask project that is no longer live does not block: the
 * restore moves that subtask to the item that holds its project. */
async function taskItemBlock(s: Scope, me: Doc<'profiles'>): Promise<RestoreBlock | null> {
  const project = await namedProject(s, s.item.project_id, 'project')
  if (project === null) return 'project_deleted'
  const level = await liveLevel(s, me, project)
  if (level === null) return 'no_access'
  if (levelRank(level) < LEVEL_RANK.user) return 'view_only'
  for (const { id } of s.item.projects) {
    const other = id === project.id ? null : await namedProject(s, id, 'project')
    if (other !== null && levelRank(await liveLevel(s, me, other)) < LEVEL_RANK.user)
      return 'subtask_project'
  }
  if (project.archived_at !== undefined) return 'project_archived'
  if (s.memo.conflicts && (await byId(s.ctx, 'issues', s.item.target_id)) !== null)
    return 'conflict'
  return null
}

/* A project item needs an organization admin or the effective lead of its
 * root, computed over the stored rows; restore works like unarchive, so
 * there is no project_creators check and a sub-project's own lead
 * suffices. A person whose level on the root is only for navigation to a
 * sub-project they lead or can access reads not_lead, as the root has a
 * lead of its own. A sub-project item needs its parent live and not
 * archived. An admin needs no stored row read, so a list of many project
 * items stays cheap for them. */
async function projectItemBlock(s: Scope, me: Doc<'profiles'>): Promise<RestoreBlock | null> {
  const parentId = s.item.parent_project_id
  const parent = parentId === undefined ? null : await namedProject(s, parentId, 'meta')
  if (parentId !== undefined && parent === null) return 'parent_deleted'
  if (me.org_role !== 'admin') {
    const h = await hierarchyOf(s)
    if (h.root === undefined) return 'conflict'
    const levels = await storedLevels(s, me)
    const level = levels.levelOf(h.root)
    if (level === null) return 'no_access'
    if (level === 'viewer' && !levels.navigationOnly(h.root.id)) return 'view_only'
    if (level !== 'lead') return 'not_lead'
  }
  if (parent !== null && parent.archived_at !== undefined) return 'parent_archived'
  if (!s.memo.conflicts) return null
  const h = await hierarchyOf(s)
  if (h.root === undefined) return 'conflict'
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
 * caller's to check first. `memo` lets a list read share its reads across
 * items (sightOf). */
export async function restoreBlock(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  item: Item,
  memo = newMemo(),
): Promise<RestoreBlock | null> {
  if (item.state !== 'ready') return item.state
  return await blockOf({ ctx, item, memo }, me)
}

/* ------------------------------------------------------------ visibility */

/** What one person sees of an item (design 6.1). */
export type ItemView = {
  /** The entries of the item's projects whose tasks the person may see. */
  projects: Item['projects']
  /** A task item whose root's project the person cannot see. It is listed
   * only through a task they can see, without the root, its path or the
   * reason, and cannot be restored by them. */
  redacted: boolean
}

/**
 * What `me` sees of `item`, or null when it is hidden from them (design
 * 6.1). `me` is their seat in the item's organization, never another one.
 * Organization admins see every item that is not purging. Nobody else sees
 * a stuck item, or one whose project (a task item) or parent (a sub-project
 * item) is no longer live: those wait for an admin.
 *
 * A task item shows to the person who deleted it and to the lead of one of
 * its projects or of that project's top-level project, while they can see
 * one of its projects. It shows only the tasks in projects they can see, and
 * is redacted when that leaves out the root's project.
 *
 * A project item is read over its stored rows (storedLevels). It shows to
 * the effective lead of its root, the lead of a sub-project item's live
 * parent, the lead of one of its sub-projects, and the person who deleted it
 * while they have a level on its root. It shows only the projects their
 * level reaches, so a sub-project's lead sees nothing of its siblings.
 */
export async function viewOf(
  ctx: QueryCtx,
  memo: Memo,
  me: Doc<'profiles'>,
  item: Item,
): Promise<ItemView | null> {
  if (item.org_id !== me.org_id || item.state === 'purging') return null
  if (me.org_role === 'admin') return { projects: item.projects, redacted: false }
  if (item.state === 'stuck') return null
  const s = { ctx, item, memo }
  return item.kind === 'task' ? await taskItemView(s, me) : await projectItemView(s, me)
}

async function taskItemView(s: Scope, me: Doc<'profiles'>): Promise<ItemView | null> {
  const root = await namedProject(s, s.item.project_id, 'project')
  if (root === null) return null
  const projects: Item['projects'] = []
  let leads = false
  for (const entry of s.item.projects) {
    const project = await namedProject(s, entry.id, 'project')
    const level = project === null ? null : await liveLevel(s, me, project)
    if (project === null || level === null) continue
    projects.push(entry)
    if (level === 'lead' || (await leadsTop(s, me, project))) leads = true
  }
  if (projects.length === 0) return null
  if (!leads && !namesProfile(s.item, s.item.deleted_by, me)) return null
  return { projects, redacted: !projects.some((p) => p.id === root.id) }
}

/** Whether `me` leads the top-level project above live project `project`. */
async function leadsTop(s: Scope, me: Doc<'profiles'>, project: Doc<'projects'>) {
  const top = project.parent_id === undefined ? null : await projectOf(s, project.parent_id)
  return top !== null && (await liveLevel(s, me, top)) === 'lead'
}

async function projectItemView(s: Scope, me: Doc<'profiles'>): Promise<ItemView | null> {
  const h = await hierarchyOf(s)
  if (h.root === undefined) return null
  if (s.item.parent_project_id !== undefined && h.parent === null) return null
  const levels = await storedLevels(s, me)
  const levelOf = (p: Pick<Doc<'projects'>, 'id'>) =>
    levels.levelOf({ id: p.id, org_id: s.item.org_id })
  const leads =
    (h.parent !== null && levelOf(h.parent) === 'lead') ||
    h.projects.some((p) => levelOf(p) === 'lead')
  const deleted = namesProfile(s.item, s.item.deleted_by, me) && levelOf(h.root) !== null
  if (!leads && !deleted) return null
  return { projects: s.item.projects.filter((p) => levelOf(p) !== null), redacted: false }
}

/** The item `id` when `me` can see it (viewOf), else null. An unknown id,
 * another organization's item and one hidden from `me` answer alike, so no
 * answer tells them apart (design 6.2); public callers turn null into
 * not_found('item not found'). */
export async function myItem(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  id: string,
  memo = newMemo(),
): Promise<Item | null> {
  const item = await byId(ctx, 'deleted_items', id)
  return item !== null && (await viewOf(ctx, memo, me, item)) !== null ? item : null
}

/** One person's sight of their organization for a list read, read once for
 * every item it looks at: the live projects, `levels` on them, the
 * profiles, and a memo seeded with those and with the organization's teams.
 * The memo leaves the conflict checks to the restore. */
export type Sight = {
  me: Doc<'profiles'>
  memo: Memo
  projects: Map<string, Doc<'projects'>>
  levels: OrgProjectLevels
  profiles: Map<string, Doc<'profiles'>>
}

export async function sightOf(ctx: QueryCtx, me: Doc<'profiles'>): Promise<Sight> {
  const { org_id } = me
  const projects = await ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('org_id', org_id))
    .collect()
  const levels = await projectLevelsForOrg(ctx, me, projects)
  const memo: Memo = { ...newMemo(), conflicts: false }
  for (const p of projects) {
    memo.projects.set(p.id, Promise.resolve(p))
    memo.live.set(`${me.id}:${p.id}`, Promise.resolve(levels.levelOf(p)))
  }
  const profiles = new Map<string, Doc<'profiles'>>()
  const seats = ctx.db.query('profiles').withIndex('by_org', (q) => q.eq('org_id', org_id))
  for await (const p of seats) {
    profiles.set(p.id, p)
    memo.profiles.set(p.id, Promise.resolve(p))
  }
  const teams = ctx.db.query('teams').withIndex('by_org', (q) => q.eq('org_id', org_id))
  for await (const team of teams) memo.teams.set(team.id, Promise.resolve(team))
  return { me, memo, projects: new Map(projects.map((p) => [p.id, p])), levels, profiles }
}

/** The names a blocked row's sentence needs (design 5.3): the project it
 * speaks of and, for view_only and not_lead, that project's effective lead
 * when it has one. For project_deleted and parent_deleted (admins only),
 * the item holding the deleted project, which must be restored first. */
export type BlockDetail = {
  reason: RestoreBlock
  project?: string
  lead?: string
  item_id?: string
}

export async function blockDetail(
  ctx: QueryCtx,
  memo: Memo,
  item: Item,
  reason: RestoreBlock,
): Promise<BlockDetail> {
  const s: Scope = { ctx, item, memo }
  // a stored lead has passed the reference predicate already (cleanProject)
  const named = async (id: string | undefined) => {
    const profile = id === undefined ? null : await profileOf(s, id)
    return profile !== null && canLeadProjects(profile) ? profile.name : undefined
  }
  if (reason === 'project_deleted' || reason === 'parent_deleted') {
    const id = reason === 'project_deleted' ? item.project_id : item.parent_project_id
    return { reason, item_id: id === undefined ? undefined : await holderOf(s, id) }
  }
  if (item.kind === 'task') {
    const project = await namedProject(s, item.project_id, 'project')
    if (project === null || (reason !== 'view_only' && reason !== 'project_archived'))
      return { reason }
    const top = project.parent_id === undefined ? null : await projectOf(s, project.parent_id)
    const lead = reason === 'view_only' ? await named(project.lead_id ?? top?.lead_id) : undefined
    return { reason, project: project.name, lead }
  }
  if (reason === 'parent_archived') {
    const id = item.parent_project_id
    const parent = id === undefined ? null : await namedProject(s, id, 'meta')
    return { reason, project: parent?.name }
  }
  if (reason !== 'view_only' && reason !== 'not_lead') return { reason }
  const h = await hierarchyOf(s)
  return { reason, project: item.name, lead: await named(h.root?.lead_id ?? h.parent?.lead_id) }
}

/** The id of the item that holds stored project `projectId`, unless it is
 * purging. Many task items can wait for one deleted project, so it is read
 * once per list. */
const holderOf = (s: Scope, projectId: string) =>
  memoRead(s.memo.heldBy, projectId, async () => {
    const row = await s.ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) => q.eq('table', 'projects').eq('row_id', projectId))
      .first()
    const holder = row === null ? null : await byId(s.ctx, 'deleted_items', row.item_id)
    return holder !== null && holder.org_id === s.item.org_id && holder.state !== 'purging'
      ? holder.id
      : undefined
  })

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
 * project, deletes them for good with their bytes. Its rows the restore
 * already wrote back to the live tables go first, the same way: a split the
 * reveal sends back here (its project left after restore_rows) finds the
 * subtask's comments, labels, follows, attachments and links live, naming a
 * task that will not come back with this item. Both items' counts follow. */
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
  for (const relation of TASK_ROWS) {
    const taken = await drain(
      run.budget,
      (n) => relation.read(run.ctx, task.task_id, n),
      async (live) => {
        if (into === null) await discard(run.ctx, live)
        else if (!(await storeRow(run.ctx, into, live, task.task_id)))
          await droppedInto(run.ctx, into)
      },
      relation.perRead,
    )
    if (!taken) return false
  }
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
  // a new row, so that a restore of `into` past its cursor still meets it;
  // in the project item that holds its project it is no cross-project task
  await uncountedWriter(run.ctx.db).insert('deleted_tasks', {
    ...light,
    item_id: into.id,
    cross_project_id: undefined,
  })
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

/** Counts a row too large to store into item `into`, which a split moved
 * it to: into the tally of its job while it moves or restores, else on the
 * item row. */
async function droppedInto(ctx: MutationCtx, into: Item): Promise<void> {
  const job = await jobOf(ctx, into.id)
  if (job !== null && (into.state === 'moving' || into.state === 'restoring')) {
    const tally = job.tally ?? emptyTally(into)
    await ctx.db.patch(job._id, { tally: { ...tally, dropped_rows: tally.dropped_rows + 1 } })
    return
  }
  const fresh = await ctx.db.get(into._id)
  if (fresh !== null) await ctx.db.patch(into._id, { dropped_rows: (fresh.dropped_rows ?? 0) + 1 })
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
 * or label passes it. An attachment takes the project its task goes back
 * to (restoredProject), whatever project the stored row named, so the
 * storage totals count it there once that project is live
 * (model/billing.ts storageUsage). Deletes the stored row. */
async function writeRowBack(run: Run, row: Doc<'deleted_rows'>): Promise<void> {
  const { org_id } = run.item
  const r = row.row
  const db = uncountedWriter(run.ctx.db)
  if (r.table === 'comments')
    await db.insert('comments', {
      ...r.doc,
      author: await keptProfile(run, r.doc.author),
      edited_by: await keptProfile(run, r.doc.edited_by),
    })
  else if (r.table === 'issue_labels') {
    if (sameReference(await labelOf(run, r.doc.label_id), run.item))
      await db.insert('issue_labels', { ...r.doc, org_id, task_archived: undefined })
  } else if (r.table === 'issue_subscriptions') {
    if ((await keptProfile(run, r.doc.profile_id)) !== undefined)
      await db.insert('issue_subscriptions', { ...r.doc, task_archived: undefined })
  } else if (r.table === 'issue_attachments')
    await db.insert('issue_attachments', {
      ...r.doc,
      org_id,
      project_id: await restoredProject(run, row.owner_id),
      uploaded_by: await keptProfile(run, r.doc.uploaded_by),
      task_archived: undefined,
    })
  else throw new Error(`A restore cannot write a ${r.table} row back here`)
  await run.ctx.db.delete(row._id)
}

/** The project task `taskId` of the restoring item goes back to, read
 * once per step. Rows stored before attachments carried their project
 * have none, so this is where a restored attachment gets it. A task of the
 * item has its deleted_tasks row until the restore writes the task, which
 * usually comes after the task's relation rows. A project item can meet a
 * task's rows after it wrote the task, when a split (splitOff) hands it a
 * subtask past restore_rows and restore_tasks writes that subtask before
 * the reveal sends the item back for its rows. That task is live under one
 * of the item's projects, and answers that project. Any other task answers
 * undefined, and a row without a project counts in its task's, as
 * storageUsage reads it, so it never counts in a project its task is not
 * in. */
function restoredProject(run: Run, taskId: string): Promise<string | undefined> {
  return memoRead(run.memo.restoredProjects, taskId, async () => {
    const light = await run.ctx.db
      .query('deleted_tasks')
      .withIndex('by_task', (q) => q.eq('task_id', taskId))
      .collect()
    const stored = light.find((row) => row.item_id === run.item.id)
    if (stored !== undefined) return stored.project_id
    const written = await byId(run.ctx, 'issues', taskId)
    if (written === null) return undefined
    chargeRead(run.budget, written)
    return itemProjectIds(run.item).includes(written.project_id) ? written.project_id : undefined
  })
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
    await uncountedWriter(run.ctx.db).insert('issue_links', {
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
 * item goes back without it, and deleted_item_parents keeps that parent
 * for attachParents, which applies the parent table after the reveal, by
 * the state then (design 5.2). Writing the parent now would make it a group
 * before the reveal (model/issues.ts hasSubtasks counts every child). A
 * deleted_tasks row whose stored task is gone is deleted, so the reveal,
 * which sends the item back here while the item has one, always moves on. */
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
        if (row === null) {
          await run.ctx.db.delete(task._id)
          return true
        }
        const doc = docOf(row, 'issues')
        const { parent_id } = doc
        if (parent_id === undefined || (await inThisItem(run, parent_id))) {
          await writeTask(run, { row, doc }, parent_id)
          return true
        }
        await writeTask(run, { row, doc }, undefined)
        await uncountedWriter(run.ctx.db).insert('deleted_item_parents', {
          item_id: run.item.id,
          task_id: doc.id,
          parent_id,
        })
        return true
      })

/** Whether task `taskId` belongs to this project item while it fills: a
 * task already written back sits under one of its absent projects, the
 * others are still stored in it. Read once per step (Memo.inItem): a task
 * the step writes back stays in the item. Only for project items, whose
 * projects are absent while they restore. */
function inThisItem(run: Run, taskId: string): Promise<boolean> {
  return memoRead(run.memo.inItem, taskId, async () => {
    const issue = await byId(run.ctx, 'issues', taskId)
    if (issue !== null) {
      chargeRead(run.budget, issue)
      return itemProjectIds(run.item).includes(issue.project_id)
    }
    const stored = await run.ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) => q.eq('table', 'issues').eq('row_id', taskId))
      .first()
    if (stored !== null) chargeRead(run.budget, stored)
    return stored?.item_id === run.item.id
  })
}

/** Writes stored task `t` back into issues with parent `parentId` (design
 * 5.2): its holders kept only by the reference predicate and today's
 * assignment rule, creator and reporter only by the predicate, a fresh
 * done_at for an active Done task so the nightly sweep does not archive it
 * the next night (as a restore from the archive restarts it,
 * model/issues.ts doneStampUpdate), no archive mark, updated_at now.
 * Deletes the stored row and, outside the reveal, the task's deleted_tasks
 * row (the reveal deletes the item's remaining ones together), and counts
 * the task out of the tally. Returns the id of the task as written. */
async function writeTask(
  run: Run,
  t: StoredTask,
  parentId: string | undefined,
  inReveal = false,
): Promise<Id<'issues'>> {
  const { doc } = t
  const active = doc.archived_at === undefined
  const _id = await uncountedWriter(run.ctx.db).insert('issues', {
    ...doc,
    parent_id: parentId,
    ...(await restoredHolders(run, doc)),
    created_by: await keptProfile(run, doc.created_by),
    reporter_id: await keptProfile(run, doc.reporter_id),
    done_at: active && doc.status === 'done' ? run.now : doc.done_at,
    relations_marked: undefined,
    updated_at: run.now,
  })
  await run.ctx.db.delete(t.row._id)
  if (!inReveal) {
    const light = await run.ctx.db
      .query('deleted_tasks')
      .withIndex('by_task', (q) => q.eq('task_id', doc.id))
      .collect()
    for (const row of light) if (row.item_id === run.item.id) await run.ctx.db.delete(row._id)
  }
  tallyTask(tallyOf(run), { project_id: doc.project_id, archived: !active }, -1)
  if (!active) run.txn.archived.push(doc.id)
  run.budget.tasks -= 1
  charge(run.budget, t.row)
  return _id
}

/* ----------------------------------------------------------- the reveal */

/** The reveal (design 5.1), one transaction. Relation rows that reached
 * the item after their phase send it back to restore_rows, a task that
 * reached a project item after restore_tasks back there, and a subtask
 * whose project left since restore_split back there. A failed check (design
 * 5.3, asked again for the restorer) sends it back to moving. Otherwise it
 * writes back a task item's tasks, or a project item's own rows, then the
 * links left, deletes the item's deleted_tasks rows, and narrates. A task
 * item is then gone (null). A project item goes on to restore_attach
 * (attachParents), which deletes the item once no task waits for its
 * parent.
 *
 * So a project item's reveal reads none of its tasks, however many it has.
 * A task item holds no more tasks than its delete handled in one
 * transaction, and the reveal checks each of their uuids and decides each
 * parent outside it once (outsideParent), reading nothing back after a
 * write. */
async function reveal(run: Run): Promise<JobState | null> {
  for (const table of RESTORED_ROWS) {
    const late = await run.ctx.db
      .query('deleted_rows')
      .withIndex('by_item_table_owner', (q) => q.eq('item_id', run.item.id).eq('table', table))
      .first()
    if (late !== null) return { ...run.state, phase: 'restore_rows', cursor: undefined }
  }
  if (run.item.kind === 'project') {
    // a subtask another restore's split moved here (splitOff)
    const late = await run.ctx.db
      .query('deleted_tasks')
      .withIndex('by_item', (q) => q.eq('item_id', run.item.id))
      .first()
    if (late !== null) return { ...run.state, phase: 'restore_tasks', cursor: undefined }
  }
  const restorer = run.actor
  if (restorer === undefined) return await sendBack(run, 'no_access')
  const block = await blockOf(run, restorer)
  if (block !== null) return await sendBack(run, block)
  let written: Id<'issues'>[] = []
  if (run.item.kind === 'task') {
    const tasks = (await storedOf(run, 'issues')).map((row) => ({ row, doc: docOf(row, 'issues') }))
    for (const { doc } of tasks) {
      if ((await byId(run.ctx, 'issues', doc.id)) !== null) return await sendBack(run, 'conflict')
      if ((await namedProject(run, doc.project_id, 'project')) === null)
        return { ...run.state, phase: 'restore_split', cursor: undefined }
    }
    const back = await revealTasks(run, tasks, restorer)
    // a parent check ran out of reads before any task was written
    if (back === null) return run.state
    written = back
  } else await revealProjects(run)
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
  await announce(run, written, restorer)
  if (run.item.kind === 'project')
    return { ...run.state, phase: 'restore_attach', cursor: undefined }
  await run.ctx.db.delete(run.item._id)
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
  const db = uncountedWriter(run.ctx.db)
  for (const table of [
    'projects',
    'milestones',
    'project_access',
    'project_team_access',
  ] as const) {
    for (const row of await storedOf(run, table)) {
      const r = row.row
      if (r.table === 'projects') await db.insert('projects', await cleanProject(run, r.doc))
      else if (r.table === 'milestones') await db.insert('milestones', r.doc)
      else if (r.table === 'project_access') {
        const grant = await cleanGrant(run, r.doc)
        if (grant !== null) await db.insert('project_access', grant)
      } else if (r.table === 'project_team_access') {
        const share = await cleanShare(run, r.doc)
        if (share !== null) await db.insert('project_team_access', share)
      }
      await run.ctx.db.delete(row._id)
    }
  }
}

/** Writes a task item's stored tasks `tasks` back, parents before
 * children. A task keeps a parent inside the item. A parent outside the
 * item is kept or cleared by the parent table (design 5.2), from what the
 * reveal reads once per parent (outsideParent) and the task's subtasks
 * among `tasks`, with the people they come back with, and each parent the
 * restore makes a group loses its own hours once. Every parent is decided
 * before the first task is written, and no decision reads a task the
 * reveal writes. Returns the ids of the tasks written, or null, with
 * nothing written, when a check runs out of the reads the transaction has
 * left ('later'). The reveal then waits for a step of its own, where no
 * check waits. */
async function revealTasks(
  run: Run,
  tasks: StoredTask[],
  restorer: Doc<'profiles'>,
): Promise<Id<'issues'>[] | null> {
  const byTask = new Map(tasks.map((t) => [t.doc.id, t]))
  const children: StoredChildren = new Map()
  for (const { doc } of tasks) {
    if (doc.parent_id === undefined) continue
    const siblings = children.get(doc.parent_id)
    if (siblings === undefined) children.set(doc.parent_id, [doc])
    else siblings.push(doc)
  }
  const depthOf = (t: StoredTask): number => {
    let depth = 0
    for (let up = t.doc.parent_id; up !== undefined && depth <= 20; depth++)
      up = byTask.get(up)?.doc.parent_id
    return depth
  }
  const ordered = [...tasks].sort((a, b) => depthOf(a) - depthOf(b))
  const reads = newParentReads()
  const grouped = new Set<string>()
  // the parent each task with a parent outside the item comes back with
  const outsideKept = new Map<string, string | undefined>()
  for (const t of ordered) {
    const parentId = t.doc.parent_id
    if (parentId === undefined || byTask.has(parentId)) continue
    const outside = await memoRead(reads.parents, parentId, () =>
      outsideParent(run, parentId, restorer, reads),
    )
    const task = { ...t.doc, ...(await restoredHolders(run, t.doc)) }
    const kept = await keptParent(run, task, outside, children, reads)
    if (kept === 'later') return null
    if (kept?.grouped) grouped.add(parentId)
    outsideKept.set(t.doc.id, kept?.id)
  }
  const written: Id<'issues'>[] = []
  for (const t of ordered) {
    const kept = outsideKept.has(t.doc.id) ? outsideKept.get(t.doc.id) : t.doc.parent_id
    written.push(await writeTask(run, t, kept, true))
  }
  for (const parentId of grouped)
    await clearParentRemaining(run.ctx, { parentId, actor: restorer, now: run.now })
  return written
}

/** The live tasks one reveal or attach step read for the parent table, by
 * id, null for one that is gone. An attach step puts back each task it
 * gives a parent, so the map stays as the transaction left the tasks. */
type LiveTasks = Map<string, Doc<'issues'> | null>

/** What one reveal or attach step reads once for the parent table, after
 * the reveal wrote back what it writes. That is the live tasks of the
 * parent chains it walks, each parent's OutsideParent, the organization's
 * projects (liveProjects) and what each person sees of them (seenBy). */
type ParentReads = {
  tasks: LiveTasks
  parents: Map<string, Promise<OutsideParent | null>>
  projects: Promise<Doc<'projects'>[]> | undefined
  people: Map<string, Promise<Seen>>
}

const newParentReads = (): ParentReads => ({
  tasks: new Map(),
  parents: new Map(),
  projects: undefined,
  people: new Map(),
})

/** Live task `id` from `live`, read and charged to the step's budget the
 * first time. */
async function liveTaskOf(run: Run, live: LiveTasks, id: string): Promise<Doc<'issues'> | null> {
  let task = live.get(id)
  if (task === undefined) {
    task = await byId(run.ctx, 'issues', id)
    if (task !== null) chargeRead(run.budget, task)
    live.set(id, task)
  }
  return task
}

/** The organization's projects, every one of them, as lib/access.ts
 * projectLevelsForOrg works levels out over them, read once per reveal or
 * attach step and charged to its budget. */
function liveProjects(run: Run, reads: ParentReads): Promise<Doc<'projects'>[]> {
  reads.projects ??= (async () => {
    const projects = await run.ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', run.item.org_id))
      .collect()
    for (const project of projects) chargeRead(run.budget, project)
    return projects
  })()
  return reads.projects
}

/** What one person sees for the parent table, their levels on the
 * organization's projects (null for someone switched off or gone), with
 * what reading them costs from the start. SIGHT_READ counts that cost
 * whether the step read them for an earlier task or not. */
type Seen = { levels: OrgProjectLevels | null; cost: Cost }

/** What profile `id` sees (Seen), read once per reveal or attach step. It
 * reads the profile, then its grants and team shares in one batched read
 * (lib/access.ts projectLevelsForOrg), which answers every project at once.
 * The step's budget counts the ranges and the bytes of every document read. */
function seenBy(run: Run, reads: ParentReads, id: string): Promise<Seen> {
  return memoRead(reads.people, id, async () => {
    const profile = await profileOf(run, id)
    const cost: Cost = { ranges: 1, bytes: profile === null ? 0 : chargeRead(run.budget, profile) }
    if (profile === null || !profile.active) return { levels: null, cost }
    const projects = await liveProjects(run, reads)
    const read: Cost = { ranges: 0, bytes: 0 }
    const levels = await projectLevelsForOrg(measured(run.ctx, read), profile, projects)
    run.budget.bytes -= read.bytes
    return { levels, cost: { ranges: cost.ranges + read.ranges, bytes: cost.bytes + read.bytes } }
  })
}

/** A live task outside the item that tasks of the item name as their
 * parent, as a reveal or an attach step reads it once for all of them: the
 * task, whether the restorer may change it (sight and Edit on its project,
 * as assertParentChain asks) and whether it holds hours of its own that a
 * new child takes away. No task the step gives a parent is such a parent,
 * because the item stored only parents outside it, so this holds for the
 * whole step. */
type OutsideParent = { parent: Doc<'issues'>; edits: boolean; clears: boolean }

/** The OutsideParent for `parentId`, or null when no task of the item can
 * keep it: it is not live, or it is not the task the item stored (the
 * reference predicate). Without a restorer, whose profile is gone since the
 * reveal, it edits nothing. The restorer's level comes from what they see
 * (seenBy). */
async function outsideParent(
  run: Run,
  parentId: string,
  restorer: Doc<'profiles'> | undefined,
  reads: ParentReads,
): Promise<OutsideParent | null> {
  const parent = await liveTaskOf(run, reads.tasks, parentId)
  if (parent === null || !sameReference(parent, run.item)) return null
  const project = await byId(run.ctx, 'projects', parent.project_id)
  if (project === null) return null
  chargeRead(run.budget, project)
  const levels = restorer === undefined ? null : (await seenBy(run, reads, restorer.id)).levels
  return {
    parent,
    edits: levelRank(levels?.levelOf(project) ?? null) >= LEVEL_RANK.user,
    clears: parent.remaining_hours !== undefined || parent.review_at !== undefined,
  }
}

/** A task as the parent table reads its people: its assignee and reviewer
 * as they come back (a stored task's through keepsHolder, a live task's as
 * they are), and whether it is archived. */
type Worker = Pick<Doc<'issues'>, 'id' | 'archived_at' | 'assignee_id' | 'reviewer_id'>

/** A task item's stored tasks by the id of their parent among them. */
type StoredChildren = Map<string, Stored<'issues'>[]>

/** What the parent table answers for one task. That is the parent it keeps
 * from outside the item, undefined to clear it, or 'later' when the check
 * ran out of the step's reads (allSee) and must run again in the next step. */
type Kept = { id: string; grouped: boolean } | undefined | 'later'

/** The parent `task` of the item keeps from outside it, by the parent
 * table (design 5.2), or undefined to clear it. Only a live parent that is
 * the task the item stored can stay. An active one stays when the restorer
 * may change it, within 20 levels; an archived one only for an archived
 * task, within the same depth. `grouped`: the attach makes the parent a
 * group (an active task under an active parent, any task under an archived
 * one), so the parent loses its own remaining hours as on a reparent
 * (model/issues.ts clearParentRemaining). An archived parent that holds
 * hours of its own therefore needs the restorer's Edit too, so a restore
 * never changes a task in a project the restorer cannot edit.
 *
 * Whoever works on the task or on the open subtasks that come back under
 * it must also see the parent and every task above it, the rule a
 * reparent follows (model/issues.ts updateIssueCore, HOLDER_SIGHT_RULE).
 * Where an edit refuses, the task comes back without the parent and keeps
 * its people, as for the table's other refusals. The chain above the parent
 * (chainOver) and the subtree under `task` (workersBelow) are read only for
 * a parent that passes the rest, and for each task, because an attach
 * earlier in the step can deepen a chain. Who sees the chain (allSee) is
 * read last, and answers 'later' when the step's reads run out first. */
async function keptParent(
  run: Run,
  task: Worker,
  outside: OutsideParent | null,
  children: StoredChildren,
  reads: ParentReads,
): Promise<Kept> {
  if (outside === null) return undefined
  const active = outside.parent.archived_at === undefined
  const taskActive = task.archived_at === undefined
  if (!active && taskActive) return undefined
  if ((active || outside.clears) && !outside.edits) return undefined
  const chain = await chainOver(run, outside.parent, task.id, reads.tasks)
  if (chain === null) return undefined
  const workers = await workersBelow(run, task, 20 - chain.levels - 1, children)
  if (workers === null) return undefined
  const sees = await allSee(run, reads, task, workers, chain.projects)
  if (sees === 'later') return 'later'
  return sees ? { id: outside.parent.id, grouped: !active || taskActive } : undefined
}

/** The chain from a live task to the top: how many levels it holds and the
 * projects of its tasks. */
type Chain = { levels: number; projects: Set<string> }

/** The chain from live task `parent` to the top, `parent` included, as the
 * upward walk of model/issues.ts assertParentChain counts its levels and
 * ancestorsFrom collects its tasks, or null past 20 levels or when the
 * chain runs through task `taskId`, so attaching it there would close a
 * cycle. Only a task that shows without its parent after a project item's
 * reveal can meet a cycle. It reads through `live`, so the tasks of a step
 * read the chains they share once, and an attach sees the levels an earlier
 * attach of its step added. */
async function chainOver(
  run: Run,
  parent: Doc<'issues'>,
  taskId: string,
  live: LiveTasks,
): Promise<Chain | null> {
  const projects = new Set([parent.project_id])
  let levels = 1
  let at = parent
  while (at.parent_id !== undefined) {
    if (at.parent_id === taskId) return null
    levels += 1
    if (levels > 20) return null
    const above = await liveTaskOf(run, live, at.parent_id)
    if (above === null) break
    projects.add(above.project_id)
    at = above
  }
  return { levels, projects }
}

/** The most one check of who sees a parent (allSee) reads, counted from the
 * start. Each person counts their profile and the batched read of their
 * levels (seenBy), whether the step read them for an earlier task or not,
 * so the answer depends only on the data. A check past it does not fit, so
 * its task keeps no parent from outside, with a warning, as for HEIGHT_READ,
 * and a retry answers the same. Someone with Edit can still give the task
 * that parent by hand. A person without teams costs 3 ranges and each team
 * 2 more, so 2,000 ranges hold several hundred people. The first check of a
 * step, which never waits, then reads at most these 2,000 ranges and 2 MiB,
 * the walk under the task (HEIGHT_READ) and a chain of 20 tasks, within
 * Convex's 4,096 ranges and 16 MiB. A mutable object, so tests can lower
 * it. */
export const SIGHT_READ = { ranges: 2000, bytes: 2 * 1024 * 1024 }

/**
 * Whether everyone in `people`, the people working on `task` and the open
 * subtasks under it (workersBelow), can see each of `projects`, the
 * projects of the parent's chain (model/issues.ts chainSight), passing over
 * someone switched off or gone, as a reparent does, because they take on no
 * new work. Each person costs one read of what they see, however many
 * projects the chain crosses (seenBy).
 *
 * A step whose reads run out (readsSpent) before the check has read
 * everyone answers 'later', and the task waits for the next step. There it
 * comes first, before the step has moved a row, so its check runs whole. A
 * check that reads past SIGHT_READ answers false, with a warning naming the
 * item and the task.
 */
async function allSee(
  run: Run,
  reads: ParentReads,
  task: Worker,
  people: Set<string>,
  projects: Set<string>,
): Promise<boolean | 'later'> {
  const cost: Cost = { ranges: 0, bytes: 0 }
  for (const id of people) {
    if (!reads.people.has(id) && readsSpent(run.budget)) return 'later'
    const seen = await seenBy(run, reads, id)
    cost.ranges += seen.cost.ranges
    cost.bytes += seen.cost.bytes
    if (cost.ranges > SIGHT_READ.ranges || cost.bytes > SIGHT_READ.bytes) {
      console.warn('A deleted item restore cannot check who sees the parent of a task', {
        item_id: run.item.id,
        task_id: task.id,
      })
      return false
    }
    const { levels } = seen
    if (levels === null) continue
    for (const projectId of projects)
      if (levels.levelOf({ id: projectId, org_id: run.item.org_id }) === null) return false
  }
  return true
}

/** The most one walk under a task (workersBelow) reads: tasks and their
 * bytes. A subtree past it counts as too deep, so its task keeps no parent
 * from outside, and the walk stays within what one step can read next to
 * its own budget. Someone with Edit can still give the task that parent by
 * hand, which reads the whole subtree (model/issues.ts assertParentChain).
 * A mutable object, so tests can lower it. */
export const HEIGHT_READ = { tasks: 500, bytes: 4 * 1024 * 1024 }

/**
 * The people who work on task `task` and its subtasks once they are back,
 * as model/issues.ts holdersUnder names them for a reparent, or null when
 * the subtree under it is more than `room` levels high. They are the
 * assignee of the task and of each open subtask reached through open ones,
 * and the reviewer of each of those without open subtasks; a group's
 * reviewer is dormant (an archived task is a group with any subtask).
 *
 * The subtree is the task's children among the tasks the reveal writes
 * (`children`), with the people they come back with, and, for a project
 * item, the tasks under it in issues, which restore_tasks wrote back or,
 * after the reveal, anyone attached. A task item's tasks have no other
 * children, because its delete detached every live child outside it and
 * nothing can attach to a task in Deleted items. The walk stops a level
 * past `room`. A subtree it cannot read within HEIGHT_READ does not fit
 * either, with a warning. The bytes of what it reads count against the
 * step's budget.
 */
async function workersBelow(
  run: Run,
  task: Worker,
  room: number,
  children: StoredChildren,
): Promise<Set<string> | null> {
  const read = { tasks: 0, bytes: 0 }
  const people = new Set<string>()
  // each task of a level, and whether its people count, which they do for
  // the task itself and for an open subtask reached through open ones
  let level = [{ at: task, counts: true }]
  for (let height = 0; height <= room; height++) {
    const next: typeof level = []
    for (const { at, counts } of level) {
      const kids: Worker[] = []
      for (const kid of children.get(at.id) ?? [])
        kids.push({ ...kid, ...(await restoredHolders(run, kid)) })
      if (run.item.kind === 'project') {
        const live = run.ctx.db
          .query('issues')
          .withIndex('by_parent', (q) => q.eq('parent_id', at.id))
        for await (const kid of live) {
          read.tasks += 1
          read.bytes += chargeRead(run.budget, kid)
          if (read.tasks > HEIGHT_READ.tasks || read.bytes > HEIGHT_READ.bytes) {
            console.warn('A deleted item restore cannot check the depth under a task', {
              item_id: run.item.id,
              task_id: task.id,
            })
            return null
          }
          kids.push(kid)
        }
      }
      if (counts) {
        const group =
          at === task && at.archived_at !== undefined
            ? kids.length > 0
            : kids.some((kid) => kid.archived_at === undefined)
        if (at.assignee_id !== undefined) people.add(at.assignee_id)
        if (at.reviewer_id !== undefined && !group) people.add(at.reviewer_id)
      }
      for (const kid of kids)
        next.push({ at: kid, counts: counts && kid.archived_at === undefined })
    }
    if (next.length === 0) return people
    level = next
  }
  return null
}

/* What a reveal tells (design 5.4). A task item sends task.restored for
 * each task it wrote back, and its root's followers get the Restored notice
 * when the restore call held this item alone. A project item sends
 * neither, as its delete sent no task.deleted, and so reads none of the
 * tasks it wrote. The activity row is the call's when it collects reveals,
 * else the item's own. */
async function announce(
  run: Run,
  written: Id<'issues'>[],
  restorer: Doc<'profiles'>,
): Promise<void> {
  if (run.item.kind === 'task') {
    let root: Doc<'issues'> | undefined
    for (const _id of written) {
      const issue = await run.ctx.db.get(_id)
      if (issue === null) continue
      await emitTaskEvent(run.ctx, { name: 'task.restored', issue, actor: restorer, now: run.now })
      if (issue.id === run.item.target_id) root = issue
    }
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
  const parts: string[] = []
  if (projects > 0) parts.push(plural(projects, 'project'))
  if (tasks > 0) parts.push(plural(tasks, 'task'))
  await logActivity(ctx, {
    ...row,
    target_type: 'project',
    target_id: shared ?? first.item.org_id,
    label: parts.join(' and '),
    detail,
    project_id: shared,
  })
}

/* ----------------------------------------------------------- the attach */

/** Up to `n` of the tasks a project item's restore wrote back without
 * their parent outside the item (restoreTasks), in task order. */
const waitingParents = (run: Run, n: number) =>
  run.ctx.db
    .query('deleted_item_parents')
    .withIndex('by_item_task', (q) => q.eq('item_id', run.item.id))
    .take(n)

/** What one attach step reads once, which is what any parent check reads
 * (ParentReads), with the live tasks as its own attaches leave them, and
 * whether a project is live. It also keeps the parents it made a group. */
type Attach = ParentReads & {
  live: Map<string, Promise<boolean>>
  grouped: Set<string>
}

/**
 * After a project item's reveal (restore_attach), gives each task that
 * restore_tasks wrote back without its parent outside the item that
 * parent, by the parent table (design 5.2) as it reads now and with the
 * helpers a task item's reveal uses. Each step stays within its budget,
 * however many tasks wait. A task whose check runs out of the step's reads
 * keeps its row for the next step, where it comes first and its check runs
 * whole (allSee). work runs the first in the reveal's own transaction, so
 * a small item comes back whole there, and steps do the rest just after.
 * Meanwhile the tasks show without their parent, and a parent that fails
 * the table by the time its turn comes leaves them that way. Each parent a
 * step makes a group loses its own hours once, with its notice (design
 * 5.4); later steps find no hours left to clear. With `attach` false
 * (restore_detach, after restore_attach failed its retries) the tasks left
 * keep no parent. True once no task waits.
 */
async function attachParents(run: Run, attach: boolean): Promise<boolean> {
  const step: Attach = { ...newParentReads(), live: new Map(), grouped: new Set() }
  const done = await drain(
    run.budget,
    (n) => waitingParents(run, n),
    (row) => (attach ? attachParent(run, row, step) : run.ctx.db.delete(row._id)),
    TASK_PAGE,
  )
  // a parent the restorer cannot edit never becomes a group with hours left
  const restorer = run.actor
  if (restorer !== undefined)
    for (const parentId of step.grouped)
      await clearParentRemaining(run.ctx, { parentId, actor: restorer, now: run.now })
  return done
}

/** Gives the task of `row` its parent when the parent table keeps it, and
 * takes the row out of the item's waiting tasks. A task that is gone or
 * that someone changed since the reveal (waitsFor) stays as it is. A task
 * whose project went to Deleted items again is hidden with it, and the item
 * that holds that project takes the row, so its move stores the task with
 * this parent (takeParent). Restoring a project item sends no notice for
 * its tasks, so the task changes without one. False, leaving the row as it
 * is, when the check ran out of the step's reads ('later'). */
async function attachParent(
  run: Run,
  row: Doc<'deleted_item_parents'>,
  step: Attach,
): Promise<boolean> {
  const settle = async (holder?: string) => {
    if (holder === undefined) await run.ctx.db.delete(row._id)
    else await run.ctx.db.patch(row._id, { item_id: holder })
    return true
  }
  const task = await liveTaskOf(run, step.tasks, row.task_id)
  if (task === null) return await settle()
  run.budget.tasks -= 1
  if (!waitsFor(run.item, task)) return await settle()
  const live = await memoRead(
    step.live,
    task.project_id,
    async () => (await byId(run.ctx, 'projects', task.project_id)) !== null,
  )
  if (!live) return await settle(await holderOf(run, task.project_id))
  const outside = await memoRead(step.parents, row.parent_id, () =>
    outsideParent(run, row.parent_id, run.actor, step),
  )
  const kept = await keptParent(run, task, outside, new Map(), step)
  if (kept === 'later') return false
  if (kept !== undefined) {
    const fields = { parent_id: kept.id, updated_at: run.now }
    await run.ctx.db.patch(task._id, fields)
    step.tasks.set(task.id, { ...task, ...fields })
    if (kept.grouped) step.grouped.add(kept.id)
  }
  return await settle()
}

/* ------------------------------------------------------------ restoring */

/**
 * Restores `items` for `me`, for deletedItems.restore (design 5). The
 * caller loads each item through the visibility fence (myItem); this
 * checks the rest per item and never throws for one item's problem.
 * Project items go first, those of top-level projects before those of
 * sub-projects, whatever order the call gives. A task item whose project,
 * or a sub-project item whose parent, is in a project item this call
 * restores or defers is deferred, for the client to send again once that
 * item has left the list. Every other item is refused with its
 * RestoreBlock or restored: it becomes restoring, with restore_by, and the
 * call's one shared budget fills, reveals and attaches as much as it can;
 * the rest goes on in steps. The reveals of this call share one activity
 * row, and an item revealed by a later step writes its own.
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
  // a sub-project's parent is a top-level project, so two tiers order them
  const ordered = [
    ...a.items.filter((item) => item.kind === 'project' && item.parent_project_id === undefined),
    ...a.items.filter((item) => item.kind === 'project' && item.parent_project_id !== undefined),
    ...a.items.filter((item) => item.kind === 'task'),
  ].filter((item) => !ids.has(item.id) && ids.add(item.id))
  const txn: Txn = { ...newTxn(), revealed: [], restorer: a.me, now: a.now }
  /** The projects of the project items this call restores or defers. */
  const coming = new Set<string>()
  const addComing = (item: Item) => {
    if (item.kind === 'project') for (const { id } of item.projects) coming.add(id)
  }
  for (const given of ordered) {
    // an earlier item of the call may have counted a subtask into this one
    const item = (await byId(counted, 'deleted_items', given.id)) ?? given
    const above = item.kind === 'task' ? item.project_id : item.parent_project_id
    if (above !== undefined && coming.has(above)) {
      result.deferred.push(item.id)
      addComing(item)
      continue
    }
    const block = await restoreBlock(counted, a.me, item)
    if (block !== null) {
      result.refused.push({ id: item.id, reason: block })
      continue
    }
    addComing(item)
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
 * follows it. The finish phases, the reveal and the attach after it are
 * handled in `work`. A project item drains its stored tasks' rows only
 * after a failed restore (sendBack), and then moves its projects' tasks
 * again. */
const PHASES: Record<
  Exclude<
    TrashPhase,
    'move_finish' | 'purge_finish' | 'restore_reveal' | 'restore_attach' | 'restore_detach'
  >,
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

/** Whether what is left of `run`'s budget holds its reveal, which writes a
 * task item's stored tasks back in one transaction whatever their number,
 * and, for a project item, the attach of every task that waits for its
 * parent (attachParents), so that a small item comes back whole in one
 * transaction. It counts tasks, not the bytes their parents' chains and
 * subtrees hold. An attach that spends the bytes left stops there, as any
 * step does, and steps finish it. A check of who sees a parent that runs
 * out of what is left waits too, a task item's reveal for a step of its
 * own and a project item's task for the next attach step. It reads at most
 * one more waiting task than the budget holds. */
async function revealFits(run: Run): Promise<boolean> {
  const b = run.budget
  if (spent(b)) return false
  const stored = run.state.tally?.tasks ?? 0
  const waiting = run.item.kind === 'project' ? (await waitingParents(run, b.tasks + 1)).length : 0
  const tasks = stored + waiting
  return tasks <= b.tasks && tasks <= b.rows && tasks * REVEAL_RANGES_PER_TASK <= b.ranges
}

/** Runs `item`'s phases from `state` with `budget`, which `ctx` is metered
 * against. Returns null when the item's work is done: a move made it ready,
 * a restore revealed it and gave its tasks their parents, a purge deleted
 * it. Otherwise returns where the next step starts. The reveal runs in one
 * transaction whatever its size, so it runs where the budget left holds it
 * and the attach after it (revealFits), else at the start of a step of its
 * own. A project item's attach runs on with what the reveal left of the
 * budget, and in steps after it when that is not enough. */
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
      // the check goes on from its cursor in the next step
      if (back === 'move_finish') return run.state
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
      if (run.budget.moved && !(await revealFits(run))) return run.state
      const next = await reveal(run)
      // restore_reveal again when a parent check ran out of what the
      // transaction had left, for a step of its own
      if (next === null || next.phase === 'restore_reveal') return next
      run.state = next
      continue
    }
    if (phase === 'restore_attach' || phase === 'restore_detach') {
      if (!(await attachParents(run, phase === 'restore_attach'))) return run.state
      await ctx.db.delete(item._id)
      return null
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
  if (job === null)
    await uncountedWriter(ctx.db).insert('deleted_item_jobs', { item_id: item.id, ...fields })
  else await ctx.db.patch(job._id, fields)
}

/** One step of an item's job (deletedItems.step). Safe to run twice or
 * after the item is gone: a missing item or job ends it, a job left by a
 * deleted item is deleted, and an organization being deleted gets no
 * further work. That is a demo organization whose cleanup has begun
 * (internal/demoCleanup.ts) or any organization whose deletion has begun
 * (orgRemovals.ts); each deletes the items with their jobs. */
export async function runStep(ctx: MutationCtx, itemId: string): Promise<void> {
  const job = await jobOf(ctx, itemId)
  const item = await byId(ctx, 'deleted_items', itemId)
  if (item === null) {
    if (job !== null) await ctx.db.delete(job._id)
    return
  }
  if (job === null) return
  if (isDemoDeployment() && (await demoForOrg(ctx, item.org_id))?.status === 'deleting') return
  if (await deletionBegun(ctx, item.org_id)) return
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
 * it leaves the steps and waits for an admin's Delete now. A restore that
 * fails that often before its reveal goes back to moving, as a failed
 * reveal does (sendBack): the move takes back what it wrote, and the item
 * is ready again for whoever could restore it, rather than stuck. After the
 * reveal its projects are live, so neither applies. An attach that fails
 * that often goes on as restore_detach, which leaves the tasks still
 * waiting without their parent and deletes the item. restore_detach only
 * deletes the item's own small rows, so it is retried until it finishes.
 * A job of an organization whose deletion has begun stays as it is: its
 * steps stand down (runStep), and the deletion deletes the job with its
 * item (model/orgDeletion.ts). */
export async function recoverJobs(ctx: MutationCtx): Promise<void> {
  const now = Date.now()
  const halvings = Math.round(Math.log2(1 / RETRY.floor))
  const stalled = await ctx.db
    .query('deleted_item_jobs')
    .withIndex('by_progress', (q) => q.lt('progress_at', new Date(now - STALLED_MS).toISOString()))
    .take(RECOVER_SCAN)
  const deleting = new Map<string, Promise<boolean>>()
  let restarted = 0
  for (const job of stalled) {
    if (restarted === RECOVER_BATCH) break
    const next = job.scheduled_id === undefined ? null : await ctx.db.system.get(job.scheduled_id)
    if (next?.state.kind === 'pending' || next?.state.kind === 'inProgress') continue
    const item = await byId(ctx, 'deleted_items', job.item_id)
    if (
      item !== null &&
      (await memoRead(deleting, item.org_id, () => deletionBegun(ctx, item.org_id)))
    )
      continue
    restarted += 1
    if (item === null) {
      await ctx.db.delete(job._id)
      continue
    }
    const exhausted =
      job.phase !== 'restore_detach' &&
      job.budget_scale <= RETRY.floor &&
      job.attempts >= halvings + RETRY.atFloor
    if (exhausted && job.phase === 'restore_attach') {
      await ctx.db.patch(job._id, {
        phase: 'restore_detach',
        cursor: undefined,
        progress_at: new Date(now).toISOString(),
        scheduled_id: await ctx.scheduler.runAfter(0, stepRef, { item_id: job.item_id }),
        attempts: 0,
        budget_scale: 1,
      })
      console.error(
        'A deleted item restore leaves the tasks it could not attach without a parent',
        {
          item_id: item.id,
          attempts: job.attempts,
        },
      )
      continue
    }
    if (exhausted && job.phase.startsWith('restore')) {
      await ctx.db.patch(item._id, { state: 'moving' })
      await ctx.db.patch(job._id, {
        phase: 'move_drain',
        cursor: undefined,
        progress_at: new Date(now).toISOString(),
        scheduled_id: await ctx.scheduler.runAfter(0, stepRef, { item_id: job.item_id }),
        attempts: 0,
        budget_scale: 1,
      })
      console.error('A deleted item restore could not finish and goes back', {
        item_id: item.id,
        phase: job.phase,
        attempts: job.attempts,
      })
      continue
    }
    if (exhausted) {
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

/** One page of an expiry run: where it starts (none for the first) and
 * the run's start, epoch milliseconds, which every page reads up to. */
export type ExpiryPage = { cursor?: string; now: number }

/** Starts purging the ready items whose time was over at `page.now`, one
 * page of at most EXPIRY.batch of them. It also runs while an organization
 * is read-only before its deletion, so items keep expiring then. Once the
 * deletion has begun (orgRemovals.ts), the organization's items stay as
 * they are for that deletion to delete, and the page passes over them.
 * Returns the cursor of the next page, or null when the run is done. */
export async function expireItems(ctx: MutationCtx, page: ExpiryPage): Promise<string | null> {
  const due = await ctx.db
    .query('deleted_items')
    .withIndex('by_state_purge', (q) => q.eq('state', 'ready').lte('purge_after', page.now))
    .paginate({ cursor: page.cursor ?? null, numItems: EXPIRY.batch })
  const deleting = new Map<string, Promise<boolean>>()
  for (const item of due.page)
    if (!(await memoRead(deleting, item.org_id, () => deletionBegun(ctx, item.org_id))))
      await startPurge(ctx, item)
  return due.isDone ? null : due.continueCursor
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
  await beginPurge(ctx, item, opts.inline ? budgetFor(1) : undefined)
}

/** startPurge, spending `budget` in this transaction when one is given. */
async function beginPurge(ctx: MutationCtx, item: Item, budget?: Budget): Promise<void> {
  if (item.state !== 'ready' && item.state !== 'stuck')
    throw new Error(`A ${item.state} deleted item cannot be purged`)
  // ready and stuck items have no job; one left over would make two chains
  const stale = await jobOf(ctx, item.id)
  if (stale !== null) await ctx.db.delete(stale._id)
  await ctx.db.patch(item._id, { state: 'purging' })
  const purging: Item = { ...item, state: 'purging' }
  const state: JobState = { phase: item.kind === 'project' ? 'purge_dependents' : 'purge_live' }
  if (budget !== undefined) await startJob(ctx, purging, state, budget)
  else await saveJob(ctx, purging, state, null)
}

/** The most items one Delete now takes. */
export const PURGE_MAX = RESTORE_MAX

/** What one Delete now answers per item (deletedItems.purge). A purged item
 * left the list; its steps finish deleting it. */
export type PurgeResult = {
  purged: string[]
  refused: { id: string; reason: 'moving' | 'restoring' }[]
}

/**
 * Deletes `items` for good, for an organization admin's Delete now (design
 * 7). The caller loads each item through myItem, which never passes a
 * purging one. Ready and stuck items start purging and share one budget in
 * this transaction, which most small items finish in; the rest goes on in
 * steps. An item moving or restoring is refused with its state: one answer
 * per item, never a throw for one item's problem.
 */
export async function purgeItems(ctx: MutationCtx, items: Item[]): Promise<PurgeResult> {
  if (items.length > PURGE_MAX)
    throw rule(`at most ${PURGE_MAX} items can be deleted for good at a time`)
  const budget = budgetFor(1)
  const result: PurgeResult = { purged: [], refused: [] }
  const ids = new Set<string>()
  for (const { id } of items) {
    if (ids.has(id)) continue
    ids.add(id)
    const item = await byId(ctx, 'deleted_items', id)
    if (item === null || item.state === 'purging') {
      // purged earlier in this call, with a project item it needed
      result.purged.push(id)
    } else if (item.state === 'ready' || item.state === 'stuck') {
      await beginPurge(ctx, item, budget)
      result.purged.push(id)
    } else result.refused.push({ id, reason: item.state })
  }
  return result
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

/* --------------------------------------------------------------- teardown */

/** What one teardown transaction may still delete: `left` rows and, when
 * given, `bytes` of them, estimated from each deleted document as
 * model/cascade.ts sweep does. A bounded step needs the bytes, because a
 * stored row can hold a document of almost 1 MB. */
export type Teardown = { left: number; bytes?: number }

/* The most rows a teardown reads at once. */
const TEARDOWN_PAGE = 256

/** Whether `budget` has run out of rows or of bytes. */
const teardownSpent = (budget: Teardown): boolean =>
  budget.left <= 0 || (budget.bytes !== undefined && budget.bytes <= 0)

/** Removes the rows `read` returns (up to `n`, from the start of the range),
 * page by page, until the range is empty (true) or `budget` is spent
 * (false). A budget not yet spent removes at least one row. `remove` must
 * take its row out of the range, and answers false when the budget ran out
 * before it could. */
async function clearPages<Row>(
  budget: Teardown,
  read: (n: number) => Promise<Row[]>,
  remove: (row: Row) => Promise<boolean>,
  perRead = TEARDOWN_PAGE,
): Promise<boolean> {
  for (;;) {
    if (teardownSpent(budget)) return false
    const n = Math.min(budget.left, perRead, TEARDOWN_PAGE)
    const rows = await read(n)
    for (const row of rows) {
      if (teardownSpent(budget) || !(await remove(row))) return false
      budget.left -= 1
      if (budget.bytes !== undefined) budget.bytes -= estimateDocumentBytes(row)
    }
    if (rows.length < n) return true
  }
}

/** Deletes the bytes of `storageId` unless a row still names them
 * (model/attachments.ts storageIdInUse), for a teardown that has just
 * deleted the row it read them from. Bytes already gone stay gone. */
async function releaseFile(ctx: MutationCtx, storageId: Id<'_storage'>): Promise<void> {
  if (await storageIdInUse(ctx, storageId)) return
  if ((await ctx.db.system.get(storageId)) !== null) await ctx.storage.delete(storageId)
}

/** Deletes the rows task `taskId` still has in the live tables, its comment
 * count first, attachment bytes with their row unless another row names
 * them, then its messages. */
async function clearLiveRows(ctx: MutationCtx, taskId: string, budget: Teardown): Promise<boolean> {
  await dropCommentCount(ctx, taskId)
  for (const relation of TASK_ROWS) {
    const cleared = await clearPages(
      budget,
      (n) => relation.read(ctx, taskId, n),
      async (row) => {
        await ctx.db.delete(row.doc._id)
        if (row.table === 'issue_attachments') await releaseFile(ctx, row.doc.storage_id)
        return true
      },
      relation.perRead,
    )
    if (!cleared) return false
  }
  return await clearPages(
    budget,
    (n) =>
      ctx.db
        .query('messages')
        .withIndex('by_issue_read', (q) => q.eq('issue_id', taskId))
        .take(n),
    async (message) => {
      await ctx.db.delete(message._id)
      return true
    },
  )
}

/**
 * Deletes everything organization `orgId` keeps in Deleted items for good,
 * whatever state its items are in, for the teardowns that delete the
 * organization's work outright: model/cascade.ts deleteOrgDeep, an
 * organization's deletion in steps (model/orgDeletion.ts), the public
 * demo's cleanup (internal/demoCleanup.ts) and the Northstar wipe's
 * deletedItems:purgeOrg. Items go first with their jobs and the parents
 * their restores wait to attach, so a step still scheduled finds nothing to
 * do. Then each stored task goes with the rows a move or restore left of it
 * in the live tables, and each stored row, a project after the tasks still
 * live under it. An attachment's bytes go with its row unless another row,
 * live or stored, still names them (releaseFile).
 * Nothing is narrated or detached, because the caller deletes the rest of
 * the organization's work too. Spends at most what `budget` holds, give or
 * take the last row, and returns true once nothing is left. Each call reads
 * every range from its start, so a caller that stops on the budget calls
 * again and loses nothing.
 */
export async function clearOrgTrash(
  ctx: MutationCtx,
  orgId: string,
  budget: Teardown,
): Promise<boolean> {
  const items = await clearPages(
    budget,
    (n) =>
      ctx.db
        .query('deleted_items')
        .withIndex('by_org_deleted', (q) => q.eq('org_id', orgId))
        .take(n),
    async (item) => {
      const waiting = await clearPages(
        budget,
        (n) =>
          ctx.db
            .query('deleted_item_parents')
            .withIndex('by_item_task', (q) => q.eq('item_id', item.id))
            .take(n),
        async (row) => {
          await ctx.db.delete(row._id)
          return true
        },
      )
      if (!waiting) return false
      const job = await jobOf(ctx, item.id)
      if (job !== null) await ctx.db.delete(job._id)
      await ctx.db.delete(item._id)
      return true
    },
  )
  if (!items) return false
  const tasks = await clearPages(
    budget,
    (n) =>
      ctx.db
        .query('deleted_tasks')
        .withIndex('by_org_num', (q) => q.eq('org_id', orgId))
        .take(n),
    async (task) => {
      if (!(await clearLiveRows(ctx, task.task_id, budget))) return false
      await ctx.db.delete(task._id)
      return true
    },
  )
  if (!tasks) return false
  return await clearPages(
    budget,
    (n) =>
      ctx.db
        .query('deleted_rows')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .take(n),
    async (row) => {
      if (row.table === 'projects') {
        const stranded = await clearPages(
          budget,
          (n) =>
            ctx.db
              .query('issues')
              .withIndex('by_project', (q) => q.eq('project_id', row.owner_id))
              .take(n),
          async (task) => {
            if (!(await clearLiveRows(ctx, task.id, budget))) return false
            await ctx.db.delete(task._id)
            return true
          },
          LARGE_ROWS_PER_READ,
        )
        if (!stranded) return false
      }
      await ctx.db.delete(row._id)
      if (row.storage_id !== undefined) await releaseFile(ctx, row.storage_id)
      return true
    },
    LARGE_ROWS_PER_READ,
  )
}

/* ------------------------------------------------------------- deleting */

/* Counts the trimmed text, which is what is stored, in UTF-16 code units
 * like the other text caps (lib/textLimits.ts). A `rule` refusal, so the app
 * shows the sentence. */
export const DELETE_REASON_TOO_LONG = `a delete reason must be at most ${DELETE_REASON_MAX} characters`

/** The reason a delete window sent: trimmed, absent when blank, refused
 * past DELETE_REASON_MAX characters. */
export function cleanReason(raw: string | undefined): string | undefined {
  const reason = raw?.trim()
  if (reason === undefined || reason === '') return undefined
  if (reason.length > DELETE_REASON_MAX) throw rule(DELETE_REASON_TOO_LONG)
  return reason
}

type Deletion = {
  actor: Doc<'profiles'>
  now: string
  reason?: string
  /** The credential of a REST or MCP delete, as named now. */
  via?: Via
}

/** Inserts a moving item with uuid `id` and returns it as stored. */
async function insertItem(
  ctx: MutationCtx,
  d: Deletion,
  id: string,
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
    id,
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
 * its parent, and a task that still waits for its parent after a project
 * item's restore is stored with it (takeParent). The tasks are then hidden;
 * their other rows follow within the same budget, and steps take the rest.
 * A task too large to store is deleted with its rows instead, as today; the
 * item neither counts it nor lists its project, so nobody needs access
 * there to restore the rest. Returns the item.
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
  const id = newUuid()
  // the size check needs the item's id and organization, which the stored
  // rows carry
  const dropped = new Set(
    tasks
      .filter((task) =>
        tooLarge({ id, org_id: actor.org_id }, { table: 'issues', doc: task }, task.id),
      )
      .map((task) => task.id),
  )
  const stored = tasks.filter((task) => !dropped.has(task.id))
  const project = await liveProject(counted, root.project_id)
  const top =
    project.parent_id === undefined ? null : await byId(counted, 'projects', project.parent_id)
  // the root's project even when the root itself was too large: the item
  // sits there
  const projects: Item['projects'] = []
  for (const task of [root, ...a.subtasks.filter((s) => !dropped.has(s.id))]) {
    if (projects.some((p) => p.id === task.project_id)) continue
    const p = task.project_id === project.id ? project : await liveProject(counted, task.project_id)
    projects.push({ id: p.id, name: p.name, key: p.key, type: p.type, tasks: 0, archived_tasks: 0 })
  }
  const item = await insertItem(counted, a, id, {
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
      tasks: stored.length,
      archived_tasks: stored.filter((task) => task.archived_at !== undefined).length,
      subtasks: stored.filter((task) => task.id !== root.id).length,
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
    for (const kid of kids) if (!doomed.has(kid.id)) await detachChild(counted, kid, actor, now)
    await emitTaskEvent(counted, { name: 'task.deleted', issue: task, actor, now })
    if (dropped.has(task.id)) {
      // deleted as before, with every row that would have travelled with it
      console.error('A deleted item dropped a task too large to store', {
        item_id: item.id,
        task_id: task.id,
      })
      await dropCommentCount(counted, task.id)
      await clearAll(counted, TASK_ROWS, task.id, (row) => discard(counted, row))
      await counted.db.delete(task._id)
      tally.dropped_rows += 1
    } else
      await storeTask(counted, item, tally, {
        ...task,
        parent_id: await takeParent(counted, task, item),
      })
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
  const item = await insertItem(counted, a, newUuid(), {
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

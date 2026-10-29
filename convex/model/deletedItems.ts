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
 * row at once (moveTasksToTrash); the tasks' messages, comments, label
 * assignments, follows, attachments and links follow in the same
 * transaction when they fit, otherwise in steps. A project item's user
 * transaction stores the project rows (moveProjectToTrash), at most
 * LIMITS.projectDeleteSubProjects.max + 1, which hides every task, milestone and grant
 * in them, and steps then move the milestones and grants, and each task:
 * relation rows, messages, children outside the item's projects, then the
 * task row. While an item drains, its leftover rows name a task or project
 * that is absent, so readers skip them.
 *
 * Fill first, reveal last (restoreItems). A restore mirrors the move: steps
 * write the rows back while what they name is still absent, a project
 * item's milestones among them, and one transaction at the end, the reveal,
 * writes the item's root rows (a task item's tasks; a project item's
 * projects), so the work appears complete in one delivery. A project item's
 * grants and team grants, with the reach rows of its grants, shares and
 * leads (model/projectNav.ts), are written back before the reveal too
 * (restoreAccess), and their stored rows go after it (restoreGrants), so
 * everyone who had access sees the projects at once. A move deletes the
 * reach rows of its projects with their grants (clearProjectRows); nothing
 * stores them. A project item's
 * tasks whose parent is outside it go back without that parent and get it
 * after the reveal, by the state then
 * (attachParents). That happens in the reveal's
 * own transaction when they fit in what its budget has left, otherwise in
 * steps just after it, while the tasks show without their parent. A task
 * item first hands each subtask whose project is no longer live to the item
 * that holds that project. References that no longer name what the item stored
 * are dropped (sameReference). A parent outside the item stays only by the
 * parent table (keptParent), which also asks, as a reparent does, that
 * everyone working on the task or its subtasks can see that parent. No
 * restore leaves a subtask under a parent in another top-level project
 * (model/issues.ts sameTopLevel), inside the item or outside it. A reveal
 * whose checks fail sends the item back to moving, and the move takes the
 * rows back.
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
 * COUNT_READ and SIGHT_READ. Progress is counted in rows. A
 * step always moves at least one row, and most phases read a range from
 * its start, in one pass (drain), rather than keep a cursor, because moving
 * a row takes it out of the range. The person's own mutation spends a
 * quarter of a step's budget itself (CALL), so most small deletes never
 * schedule a step. Convex drops what a failed step scheduled,
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
 * The stored-byte totals (model/storageTotals.ts) count an attachment once,
 * live or stored, so moves and restores leave them as they are, retries
 * included. Each delete of an attachment row for good (discard, dropStored
 * and the teardowns below) takes it out in the same transaction.
 *
 * Teardowns that delete an organization's work outright (deleteOrgDeep, an
 * organization's deletion in steps, the public demo's cleanup, the
 * Northstar wipe) empty its Deleted items with clearOrgTrash, whatever
 * state the items are in. */

import { makeFunctionReference, type WithoutSystemFields } from 'convex/server'
import { compareValues } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import {
  accessRowsOf,
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
import { byId, insertUsed, newWindowKey, strayRows, usedMoreThan } from '../lib/db'
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
import { limitedText } from '../lib/limitRules'
import { cutText, LIMITS, TEXT_MAX } from '../lib/limits'
import { countsAsSubtask } from '../lib/liveTasks'
import { nameKey } from '../lib/nameKey'
import { insertActivity, logActivity } from './activity'
import { recheckParent, recheckProject, waitsForChildren } from './archiveRechecks'
import { beginCount, type CommentWrite, deleteCommentRows, tallyComments } from './commentLimits'
import { estimateDocumentBytes } from './demoMetrics'
import { scheduleImageReap } from './descriptionImages'
import { dropDescription, insertTask, withDescription } from './descriptions'
import { releaseFile } from './fileHolds'
import { taskItems } from './inboxItems'
import { assertCanEdit, clearParentRemaining, detachChild, sameTopLevel } from './issues'
import { tallyAssignment } from './labelCounts'
import { linksFullAt } from './links'
import {
  type NotifyPreload,
  newNotifyPreload,
  notifyFollowersOfChange,
  scheduleArchivedReads,
} from './messages'
import { newUuid, tallyRow } from './orgs'
import {
  archiveStateOf,
  type Grantee,
  grantee,
  insertGrant,
  insertShare,
  type ProjectRead,
  type ReachProject,
  reachFollows,
  syncLeads,
  syncReach,
} from './projectNav'
import { uncountFile, uncountStored } from './storageTotals'
import { emitTaskEvent } from './taskEvents'

/** How long a deleted item waits before the nightly expiry purges it. */
export const TRASH_DAYS = 30
const DAY_MS = 86_400_000

/** What one step may do at budget_scale 1: rows moved, deleted or
 * detached, their estimated bytes, task rows moved and index ranges read.
 * A mutable object, so tests can lower it. */
export const TRASH_BUDGET = { rows: 300, bytes: 4 * 1024 * 1024, tasks: 100, ranges: 2500 }

/* The share of TRASH_BUDGET a person's own delete, restore or Delete now
 * spends before steps take over. Convex ends a function whose database
 * calls wait 15 s in all ("too many system operations"), and a step that
 * does is retried at half its budget (recoverJobs), but a person's call is
 * not retried. On a local backend busy removing a person with 18,000
 * tokens, each call of a restore waited 3.8 to 7.6 ms, so a restore of four
 * 200-project items that made 1,977 calls failed, and so did deleting a
 * sub-project of 5,000 tasks. A quarter of the budget, about 700 calls with
 * the writes, stays near 5 s at that rate. A mutable object, so tests can
 * change it. */
export const CALL = { scale: 1 / 4 }

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

const stepRef = makeFunctionReference<'mutation', { item_id: string }, null>('deletedItems:step')

type Item = Doc<'deleted_items'>
type Job = Doc<'deleted_item_jobs'>
type Tally = NonNullable<Job['tally']>
/** Where a job is: what a step reads first and saves last. */
type JobState = Pick<Job, 'phase' | 'cursor' | 'tally' | 'alone' | 'purge_history' | 'granted'>
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
 * for the next step (liveSubtasks, allSee). */
const readsSpent = (b: Budget): boolean => b.moved && (b.ranges <= 0 || b.bytes <= 0)

/** Clears the rows of `rows`, an index range read in one pass, until it
 * ends (true) or the budget is spent (false). `clear` must take each row
 * out of the range, because the next step reads it from its start again
 * (model/cascade.ts sweep, which says why one pass, with this file's
 * budget). A `clear` that answers false leaves its row where it is, for the
 * next step, and ends the drain (false). */
async function drain<Row>(
  b: Budget,
  rows: AsyncIterable<Row>,
  clear: (row: Row) => Promise<void> | Promise<boolean>,
): Promise<boolean> {
  if (spent(b)) return false
  for await (const row of rows) {
    if ((await clear(row)) === false) return false
    charge(b, row)
    if (spent(b)) return false
  }
  return true
}

/** The documents of `query`, each tagged with its table `table`, read in
 * one pass. */
async function* tagged<T extends StoredTable>(
  table: T,
  query: AsyncIterable<Doc<T>>,
): AsyncGenerator<{ table: T; doc: Doc<T> }> {
  for await (const doc of query) yield { table, doc }
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
export type Meter = { range: () => void; doc?: (doc: unknown) => void }

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
 * demoWriter's uncounted writer included. A step meters a mutation; the
 * Deleted items list and search meter a query (model/deletedItemsList.ts). */
export function meterDb<C extends QueryCtx>(ctx: C, meter: Meter): C {
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
    grantee:
      live.table === 'project_access'
        ? live.doc.profile_id
        : live.table === 'project_team_access'
          ? live.doc.team_id
          : undefined,
    // the tag and its document, so row.table names doc's table
    row: { table: live.table, doc } as Doc<'deleted_rows'>['row'],
  }
}

/** Whether `live`'s stored document would be too large to store. */
const tooLarge = (item: Pick<Item, 'id' | 'org_id'>, live: LiveRow, ownerId: string): boolean =>
  estimateDocumentBytes(wrapRow(item, live, ownerId)) > STORED_ROW_MAX_BYTES

/** Deletes `live` from its table, a task or project out of its
 * organization's live counts (model/orgs.ts tallyRow), a label assignment
 * of a live task out of its label's count (model/labelCounts.ts), and a
 * comment out of its task's comment count (model/commentLimits.ts
 * tallyComments), at the end of the transaction when `txn` collects the
 * comments (finishTxn). A task's count row stays while the task is stored,
 * so a restore that writes its comments back counts them in again. `task`
 * is the live task a relation row belongs to when the caller holds it, so
 * the label count need not read the task again for each of its rows;
 * without it the task is read, which finds none for the stored tasks most
 * callers move rows of. A task's description row is its caller's
 * (dropTaskDescription). */
async function deleteLive(
  ctx: MutationCtx,
  live: LiveRow,
  txn?: Txn,
  task?: Doc<'issues'>,
): Promise<void> {
  await ctx.db.delete(live.doc._id)
  if (live.table === 'issues') await tallyRow(ctx, live.table, live.doc, null)
  else if (live.table === 'projects') await tallyRow(ctx, live.table, live.doc, null)
  else if (live.table === 'issue_labels') await tallyAssignment(ctx, live.doc, -1, task)
  else if (live.table !== 'comments') return
  else if (txn !== undefined) txn.comments.push([live.doc, -1])
  else await tallyComments(ctx, [[live.doc, -1]])
}

/** Deletes a live row for good, taking an attachment out of the stored-byte
 * totals of its task, numbered `num` when the caller holds the task
 * (model/storageTotals.ts), and letting go of its file (model/fileHolds.ts
 * releaseFile), and a task with its comment count and post logs
 * (model/commentLimits.ts deleteCommentRows), which a task that takes its
 * freed id must not find. `txn` collects a comment's count and `task` is as
 * for deleteLive. */
async function discard(
  ctx: MutationCtx,
  live: LiveRow,
  num?: number,
  txn?: Txn,
  task?: Doc<'issues'>,
): Promise<void> {
  await deleteLive(ctx, live, txn, task)
  if (live.table === 'issue_attachments') {
    await uncountFile(ctx, live.doc, num)
    await releaseFile(ctx, live.doc.storage_id)
  } else if (live.table === 'issues') await deleteCommentRows(ctx, live.doc.id)
}

/** Moves `live` into `item`'s stored rows, travelling with `ownerId`, and
 * deletes it from its table. The only insert into deleted_rows. A row too
 * large to store (STORED_ROW_MAX_BYTES) is deleted instead, letting go of
 * an attachment's file; that is logged with the item id and returns false.
 * `txn` collects a comment's count (deleteLive), and `task` is as for
 * deleteLive. */
export async function storeRow(
  ctx: MutationCtx,
  item: Pick<Item, 'id' | 'org_id'>,
  live: LiveRow,
  ownerId: string,
  txn?: Txn,
  task?: Doc<'issues'>,
): Promise<boolean> {
  const stored = wrapRow(item, live, ownerId)
  if (estimateDocumentBytes(stored) > STORED_ROW_MAX_BYTES) {
    console.error('A deleted item dropped a row too large to store', {
      item_id: item.id,
      table: live.table,
    })
    await discard(ctx, live, undefined, txn, task)
    return false
  }
  await uncountedWriter(ctx.db).insert('deleted_rows', stored)
  await deleteLive(ctx, live, txn, task)
  return true
}

/** One kind of row that travels with a task or a project, read through the
 * same index as the hard deletes (model/cascade.ts), so rows with archive
 * marks are included. */
type Relation = (ctx: QueryCtx, ownerId: string) => AsyncIterable<LiveRow>

/* A task's rows, in the order a move takes them. Links go both ways; a link
 * between two tasks of the item travels with whichever of them moves first. */
const TASK_ROWS: Relation[] = [
  (ctx, id) =>
    tagged(
      'issue_links',
      ctx.db.query('issue_links').withIndex('by_source', (q) => q.eq('source_id', id)),
    ),
  (ctx, id) =>
    tagged(
      'issue_links',
      ctx.db.query('issue_links').withIndex('by_target', (q) => q.eq('target_id', id)),
    ),
  (ctx, id) =>
    tagged(
      'issue_labels',
      ctx.db.query('issue_labels').withIndex('by_issue', (q) => q.eq('issue_id', id)),
    ),
  (ctx, id) =>
    tagged(
      'issue_subscriptions',
      ctx.db
        .query('issue_subscriptions')
        .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', id)),
    ),
  (ctx, id) =>
    tagged(
      'comments',
      ctx.db.query('comments').withIndex('by_issue', (q) => q.eq('issue_id', id)),
    ),
  (ctx, id) =>
    tagged(
      'issue_attachments',
      ctx.db.query('issue_attachments').withIndex('by_issue', (q) => q.eq('issue_id', id)),
    ),
]

/* A project's own rows besides the project row itself. */
const PROJECT_ROWS: Relation[] = [
  (ctx, id) =>
    tagged(
      'milestones',
      ctx.db.query('milestones').withIndex('by_project', (q) => q.eq('project_id', id)),
    ),
  (ctx, id) =>
    tagged(
      'project_access',
      ctx.db.query('project_access').withIndex('by_project', (q) => q.eq('project_id', id)),
    ),
  (ctx, id) =>
    tagged(
      'project_team_access',
      ctx.db.query('project_team_access').withIndex('by_project', (q) => q.eq('project_id', id)),
    ),
]

/** Whether any of `relations` still holds a row of `ownerId`. */
async function holdsRows(ctx: QueryCtx, relations: Relation[], ownerId: string): Promise<boolean> {
  for (const relation of relations) for await (const _ of relation(ctx, ownerId)) return true
  return false
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
  /** a person's live grants and their teams' live shares, by profile (pendingAccess) */
  liveAccess: Map<string, Promise<LiveAccess>>
  /** an item's stored grants or shares without a grantee, keyed `item:table` (storedFor) */
  legacyGrants: Map<string, Promise<Doc<'deleted_rows'>[]>>
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
  liveAccess: new Map(),
  legacyGrants: new Map(),
  readOnly: new Map(),
  heldBy: new Map(),
  hierarchy: new Map(),
  levels: new Map(),
  holders: new Map(),
  inItem: new Map(),
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
  /** The comments moved out of the live tables or written back, which
   * finishTxn counts out of or into their tasks' comment counts at once,
   * reading each task's count once. */
  comments: CommentWrite[]
}

const newTxn = (): Txn => ({ archived: [], revealed: undefined, failed: new Map(), comments: [] })

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

/** Stores `live` (keep) or deletes it for good (purge). A grant or share
 * the item already stores is only deleted (storedAlready). `num` is the
 * number of the task a task's row travels with, and `task` is as for
 * deleteLive. */
async function clearRow(
  run: Run,
  live: LiveRow,
  ownerId: string,
  mode: Mode,
  num?: number,
  task?: Doc<'issues'>,
): Promise<void> {
  if (mode === 'purge' || (await storedAlready(run, live, ownerId)))
    return await discard(run.ctx, live, num, run.txn, task)
  if (!(await storeRow(run.ctx, run.item, live, ownerId, run.txn, task)))
    tallyOf(run).dropped_rows += 1
}

/** Whether `run`'s item already stores grant or team grant `live` of
 * project `ownerId`. A restore writes them back before its reveal and keeps
 * the stored rows until after it (restoreAccess), so a restore sent back to
 * moving finds both, and only then (restore_by is set). */
async function storedAlready(run: Run, live: LiveRow, ownerId: string): Promise<boolean> {
  if (run.item.restore_by === undefined) return false
  if (live.table !== 'project_access' && live.table !== 'project_team_access') return false
  const grantee = live.table === 'project_access' ? live.doc.profile_id : live.doc.team_id
  const stored = await storedFor(run, live.table, grantee)
  return stored.some((row) => row.owner_id === ownerId)
}

/** Stores a task row with its deleted_tasks row, and counts it. `task`
 * carries its description (model/descriptions.ts withDescription), which
 * the stored copy keeps. Answers whether it stored the task, which a row
 * too large to store is not (storeRow). */
async function storeTask(
  ctx: MutationCtx,
  item: Item,
  tally: Tally,
  task: Doc<'issues'>,
): Promise<boolean> {
  if (!(await storeRow(ctx, item, { table: 'issues', doc: task }, task.id))) {
    tally.dropped_rows += 1
    return false
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
  return true
}

/** Deletes the description row of task `taskId` (model/descriptions.ts),
 * or `known`, the one the caller read, and charges `budget` for reading it
 * and for its delete, which reads it again. Its stored copy keeps the text,
 * so a step or a teardown deletes the row with or after the task row. */
async function dropTaskDescription(
  ctx: MutationCtx,
  budget: Budget,
  taskId: string,
  known?: Doc<'issue_descriptions'> | null,
): Promise<void> {
  const row = await dropDescription(ctx.db, taskId, known)
  if (row === null) return
  if (known === undefined) chargeRead(budget, row)
  chargeRead(budget, row)
}

/** Deletes the description rows a task item's stored task `taskId` still
 * has (model/descriptions.ts), in the step's budget, which counts each
 * row's read and its delete's. The person's delete leaves them to the
 * steps, so that it reads none (moveTasksToTrash). A split or a purge can
 * stop after the stored task row is gone, which frees the id, so the rows
 * of a live task that took it since, and those of another organization,
 * stay (ownDescription). */
async function dropDescriptions(run: Run, taskId: string): Promise<boolean> {
  const live = await byId(run.ctx, 'issues', taskId)
  if (live !== null) {
    chargeRead(run.budget, live)
    return true
  }
  return await drain(run.budget, descriptionRange(run.ctx, taskId), async (row) => {
    if (!ownDescription(run.item.org_id, row)) return
    chargeRead(run.budget, row)
    await run.ctx.db.delete(row._id)
  })
}

/** Whether a stored task's description row `row` is its organization
 * `orgId`'s, for Deleted items to delete. A create in another organization
 * can take the id once the stored task row is gone, and its row then names
 * that organization (model/descriptions.ts putDescription). */
const ownDescription = (orgId: string, row: Doc<'issue_descriptions'>): boolean =>
  row.org_id === orgId

/** Whether stored task `taskId` still has a description row its item
 * deletes (dropDescriptions). */
async function holdsDescription(run: Run, taskId: string): Promise<boolean> {
  if ((await byId(run.ctx, 'issues', taskId)) !== null) return false
  for await (const row of descriptionRange(run.ctx, taskId))
    if (ownDescription(run.item.org_id, row)) return true
  return false
}

/** The description rows of task `taskId`, one unless a release before
 * this one wrote another. */
const descriptionRange = (ctx: QueryCtx, taskId: string) =>
  ctx.db.query('issue_descriptions').withIndex('by_issue', (q) => q.eq('issue_id', taskId))

/** The step's NotifyPreload. A step changes no profile or team, and no
 * live project or its grants, after it starts (the grants it moves are of
 * absent projects), so one read serves every detach. */
async function preloadOf(run: Run): Promise<NotifyPreload> {
  run.preload ??= newNotifyPreload()
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

/** Task `taskId`'s activity rows, rows without a list included. */
const history = (run: Run, taskId: string) =>
  run.ctx.db
    .query('activity_events')
    .withIndex('by_target', (q) =>
      q.eq('org_id', run.item.org_id).eq('target_type', 'issue').eq('target_id', taskId),
    )

/** Deletes task `taskId`'s activity rows, rows without a list included,
 * within the step's budget, or with `upTo` only the rows written at or
 * before it. True once none is left. */
const purgeHistory = (run: Run, taskId: string, upTo?: string): Promise<boolean> =>
  drain(
    run.budget,
    upTo === undefined
      ? history(run, taskId)
      : history(run, taskId).filter((q) => q.lte(q.field('ts'), upTo)),
    (row) => run.ctx.db.delete(row._id),
  )

/** Deletes the inbox messages about task `taskId` within the step's
 * budget, then their inbox items (model/inboxItems.ts). True once none is
 * left. Messages are not stored, so a restore never brings them back.
 * Nothing posts about a task while it is absent (notifyFollowersStep reads
 * the task first) and a stored task keeps its id reserved, so the range
 * only shrinks. Until it is empty the inbox hides what is left, because the
 * task is absent (lib/inbox.ts). The items go last, so a write to a message
 * still waiting cannot build one again. */
const dropMessages = async (run: Run, taskId: string): Promise<boolean> =>
  (await drain(
    run.budget,
    run.ctx.db.query('messages').withIndex('by_issue_read', (q) => q.eq('issue_id', taskId)),
    (message) => run.ctx.db.delete(message._id),
  )) && (await drain(run.budget, taskItems(run.ctx, taskId), (item) => run.ctx.db.delete(item._id)))

/** Whether any message about task `taskId`, or its inbox item, is left. */
const holdsMessages = async (run: Run, taskId: string): Promise<boolean> =>
  (await run.ctx.db
    .query('messages')
    .withIndex('by_issue_read', (q) => q.eq('issue_id', taskId))
    .first()) !== null || (await taskItems(run.ctx, taskId).first()) !== null

/** Whether another task now holds the id of task `taskId` of this item: a
 * live task, or one another item stores. Only a purge the release before
 * left part done can free such an id, by deleting the stored task row
 * before the rest (purgeRows, splitOff). */
async function idTaken(run: Run, taskId: string): Promise<boolean> {
  if ((await byId(run.ctx, 'issues', taskId)) !== null) return true
  const stored = await run.ctx.db
    .query('deleted_rows')
    .withIndex('by_row', (q) => q.eq('table', 'issues').eq('row_id', taskId))
    .first()
  return stored !== null && stored.item_id !== run.item.id
}

/** Moves (keep) or deletes (purge) task `task` of a project item with what
 * travels with it, in order: its rows, its messages, its children outside
 * the item's projects (childrenOutside), on a purge its history
 * (purgeHistory), then the task row. True once the task row is gone.
 * A task left half done stays hidden, because its project is absent, and
 * the next step picks it up. A task too large to store goes in cut to the
 * caps (fitToStore). A task that a restore wrote back without its parent, and that still waits
 * for it, is stored with that parent again (takeParent). Tasks of a deleted
 * project emit no task.deleted. A purge marks the project of an open task's
 * parent outside the item for the nightly archive (markPurgedParent). */
async function clearTask(run: Run, task: Doc<'issues'>, mode: Mode): Promise<boolean> {
  for (const relation of TASK_ROWS) {
    // the task stays live until its own row goes, below
    const done = await drain(run.budget, relation(run.ctx, task.id), (row) =>
      clearRow(run, row, task.id, mode, task.num, task),
    )
    if (!done) return false
  }
  // a task deleted for good takes the files the move stored before it
  // with it, while its number is still known (dropFilesOf)
  if (mode === 'purge' && !(await dropFilesOf(run, task))) return false
  if (!(await dropMessages(run, task.id))) return false
  const preload = await preloadOf(run)
  for (const children of childrenOutside(run.ctx, task.id, itemProjectIds(run.item))) {
    const detached = await drain(run.budget, children(), (child) =>
      detachChild(run.ctx, child, run.actor, run.now, preload),
    )
    if (!detached) return false
  }
  // a task deleted for good loses its history; before takeParent, which
  // deletes the deleted_item_parents row a later step would need
  if (mode === 'purge' && !(await purgeHistory(run, task.id))) return false
  const parent_id = await takeParent(run.ctx, task, run.item)
  // its description row goes in this transaction, once the stored copy
  // holds the text, because no later step comes back to this task
  let row: Doc<'issue_descriptions'> | null | undefined
  if (mode === 'keep') {
    const described = await withDescription(run.ctx.db, task)
    if (described.row !== null) {
      row = described.row
      chargeRead(run.budget, row)
    }
    const stored = fitToStore(run.item, { ...described.task, parent_id })
    await storeTask(run.ctx, run.item, tallyOf(run), stored)
  } else {
    await discard(run.ctx, { table: 'issues', doc: task })
    await markPurgedParent(run, task)
  }
  await dropTaskDescription(run.ctx, run.budget, task.id, row)
  run.budget.tasks -= 1
  charge(run.budget, task)
  return true
}

/* The parents a purge step read for its open tasks, so the siblings of a
 * task read theirs no more that step (markPurgedParent). */
const purgedParents = new WeakMap<Run, Set<string>>()

/** Marks the project of `task`'s parent for the nightly archive
 * (model/archiveRechecks.ts) as a purge deletes `task`, an open task, for
 * good, when the parent lies outside the item and waits for its children.
 * Only a project item whose move got stuck before moveEdges reached the
 * task leaves it live; moveEdges would have marked the parent. The parent's
 * project is known only from the parent, so the step reads each parent
 * once, charged to its budget, and a parent inside the item, which goes
 * too, marks nothing. */
async function markPurgedParent(run: Run, task: Doc<'issues'>): Promise<void> {
  if (task.archived_at !== undefined || task.parent_id === undefined) return
  const read = purgedParents.get(run) ?? new Set<string>()
  purgedParents.set(run, read)
  if (read.has(task.parent_id)) return
  read.add(task.parent_id)
  const parent = await byId(run.ctx, 'issues', task.parent_id)
  if (parent !== null) chargeRead(run.budget, parent)
  if (waitsForChildren(parent) && !itemProjectIds(run.item).includes(parent.project_id))
    await recheckProject(run.ctx.db, { org_id: parent.org_id, project_id: parent.project_id })
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

/** Clears (keep or purge) the tasks left in project `projectId`, read in
 * one pass (drain). */
async function clearProjectTasks(run: Run, projectId: string, mode: Mode): Promise<boolean> {
  if (spent(run.budget)) return false
  const tasks = run.ctx.db
    .query('issues')
    .withIndex('by_project', (q) => q.eq('project_id', projectId))
  for await (const task of tasks) if (!(await clearTask(run, task, mode))) return false
  return true
}

/** Clears (keep or purge) project `projectId`'s milestones and grants,
 * then deletes its reach rows (model/projectNav.ts), which nothing stores,
 * because a restore writes them again from the grants (restoreAccess). */
async function clearProjectRows(run: Run, projectId: string, mode: Mode): Promise<boolean> {
  for (const relation of PROJECT_ROWS) {
    const done = await drain(run.budget, relation(run.ctx, projectId), (row) =>
      clearRow(run, row, projectId, mode),
    )
    if (!done) return false
  }
  return await clearReach(run, projectId)
}

/** The reach rows on project `id`, every grantee's. */
const reachOn = (ctx: QueryCtx, id: string) =>
  ctx.db.query('project_reach').withIndex('by_project_grantee', (q) => q.eq('project_id', id))

/** Deletes the reach rows on absent project `projectId` in one pass
 * (drain), each with syncReach, which also takes its grantee's row off the
 * live top-level project above a sub-project once nothing else of theirs is
 * under it. Each sync's reads count against the step's budget, the bytes
 * of the projects and teams it reads included. Until its row goes, a
 * navigation-only parent can still list a grantee whose sub-project is
 * already absent, which readers find gone when they check the live
 * projects. */
async function clearReach(run: Run, projectId: string): Promise<boolean> {
  return await drain(run.budget, reachOn(run.ctx, projectId), (row) =>
    syncReachOf(run, (ctx) => syncReach(ctx, row, projectId)),
  )
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
 * transaction's read limit either. A Done parent outside the item may have
 * waited for a task that moves, so the next nightly archive checks the
 * parent's project (model/archiveRechecks.ts). */
async function moveEdges(run: Run): Promise<boolean> {
  const ids = itemProjectIds(run.item)
  const parents = new Map<string, Doc<'issues'> | null>()
  const cursor = run.state.cursor ?? { index: 0, after: 0 }
  const stop = () => {
    run.state.cursor = cursor
    return false
  }
  for (; cursor.index < ids.length; cursor.index += 1, cursor.after = 0) {
    if (spent(run.budget)) return stop()
    const projectId = ids[cursor.index]
    if (await takenAgain(run, projectId)) continue
    const tasks = run.ctx.db
      .query('issues')
      .withIndex('by_project_archived', (q) =>
        q
          .eq('project_id', projectId)
          .eq('archived_at', undefined)
          .gt('_creationTime', cursor.after),
      )
    for await (const task of tasks) {
      chargeRead(run.budget, task)
      if (await isEdge(run, task, ids, parents)) {
        if (!(await clearTask(run, task, 'keep'))) return stop()
        // a parent outside the item stays live and may have waited for this
        // task alone (model/archiveRechecks.ts); isEdge read it
        const parent = task.parent_id === undefined ? null : (parents.get(task.parent_id) ?? null)
        if (waitsForChildren(parent) && !ids.includes(parent.project_id))
          await recheckProject(run.ctx.db, { org_id: parent.org_id, project_id: parent.project_id })
      }
      cursor.after = task._creationTime
      run.budget.moved = true
      if (spent(run.budget)) return stop()
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

/** Whether a live project holds the id of one of a moving item's projects.
 * Only a project row the move dropped as too large to store frees its id
 * (storeRow), and the project that took it since keeps its own rows, so
 * the move leaves them alone, as a purge does (absentProjects). */
const takenAgain = async (run: Run, id: string): Promise<boolean> =>
  (await byId(run.ctx, 'projects', id)) !== null

/* Each of the item's projects' milestones, grants and team grants, then
 * every task left in it. The user's transaction stored only the project
 * rows, which hide the rest. */
async function moveProjectTasks(run: Run): Promise<boolean> {
  for (const id of itemProjectIds(run.item)) {
    if (await takenAgain(run, id)) continue
    if (!(await clearProjectRows(run, id, 'keep'))) return false
    if (!(await clearProjectTasks(run, id, 'keep'))) return false
  }
  return true
}

/* A task item's stored tasks: for each, its messages, which are deleted,
 * then the rows that travel with it. Messages go first, because the inbox
 * walk still passes over them while they wait (lib/inbox.ts). First the
 * history of each task in purge_history, which only the release before
 * set: its move deleted a task too large to store for good. Only the rows
 * written up to the deletion go, because a new task may take the freed id. */
const moveDrain = async (run: Run): Promise<boolean> => {
  const purge = run.state.purge_history ?? []
  while (purge.length > 0) {
    if (!(await purgeHistory(run, purge[0], run.item.deleted_at))) return false
    purge.shift()
  }
  run.state.purge_history = undefined
  return await eachStoredTask(run, async ({ task_id }) => {
    if (!(await dropMessages(run, task_id))) return false
    if (!(await dropDescriptions(run, task_id))) return false
    for (const relation of TASK_ROWS) {
      const done = await drain(run.budget, relation(run.ctx, task_id), (row) =>
        clearRow(run, row, task_id, 'keep'),
      )
      if (!done) return false
    }
    return true
  })
}

/** The phase to go back to when a range the move drains holds a row again,
 * else null, or move_finish while the check has more to read. Once a task
 * row has left issues nothing can add a row naming it, so a project item's
 * ranges are its projects' tasks and rows. A failed restore also wrote rows
 * of tasks it left stored back; its move drains those first (move_drain),
 * and the finish does not read them again, because that would read each of
 * the item's tasks in one transaction. A task item's check reads the
 * messages and rows of each stored task, a few ranges each, so it walks them with the job's
 * cursor within the step's budget, as move_drain does, and goes on in the
 * next step when the budget runs out. */
async function moveLeft(run: Run): Promise<TrashPhase | null> {
  if (run.item.kind === 'task') {
    let held = false
    const done = await eachStoredTask(run, async ({ task_id }) => {
      held =
        (await holdsMessages(run, task_id)) ||
        (await holdsDescription(run, task_id)) ||
        (await holdsRows(run.ctx, TASK_ROWS, task_id))
      return !held
    })
    if (held) return 'move_drain'
    return done ? null : 'move_finish'
  }
  for (const id of itemProjectIds(run.item)) {
    if (await takenAgain(run, id)) continue
    if (await holdsRows(run.ctx, PROJECT_ROWS, id)) return 'move_tasks'
    if ((await reachOn(run.ctx, id).first()) !== null) return 'move_tasks'
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

/** The states an item can be purged from (beginPurge). */
const PURGEABLE = ['ready', 'stuck'] as const

/* Purging a project item also purges what could never come back without
 * it: the task items whose project was in it, and the sub-project items
 * whose parent was. Items still moving or restoring are left to their own
 * expiry. Each read asks an index for one kind in one purgeable state
 * (by_org_project_kind_state, by_org_parent_kind_state), so it reads only
 * items it purges, however many items in other states name the project,
 * and the step's budget counts every item it reads. */
async function purgeDependents(run: Run): Promise<boolean> {
  const { org_id } = run.item
  for (const id of itemProjectIds(run.item))
    for (const state of PURGEABLE) {
      const reads = [
        run.ctx.db
          .query('deleted_items')
          .withIndex('by_org_project_kind_state', (q) =>
            q.eq('org_id', org_id).eq('project_id', id).eq('kind', 'task').eq('state', state),
          ),
        run.ctx.db
          .query('deleted_items')
          .withIndex('by_org_parent_kind_state', (q) =>
            q
              .eq('org_id', org_id)
              .eq('parent_project_id', id)
              .eq('kind', 'project')
              .eq('state', state),
          ),
      ]
      for (const read of reads)
        if (!(await drain(run.budget, read, (dependent) => startPurge(run.ctx, dependent))))
          return false
    }
  return true
}

/* Rows the item still holds in the live tables. A project item that got
 * stuck can leave tasks, with their rows, messages and children, and
 * project rows under its absent projects; they are deleted as the hard
 * delete would have. A task item can leave rows of its stored tasks, and so
 * can a project item that got stuck during or after a restore (restore_by
 * set). A task item stuck before its move drained them can leave messages
 * too. */
async function purgeLive(run: Run): Promise<boolean> {
  if (run.item.kind === 'task' || run.item.restore_by !== undefined) {
    const done = await eachStoredTask(run, async ({ task_id, num }) => {
      // a move that got stuck can leave messages and description rows,
      // before the id is freed
      if (!(await dropMessages(run, task_id))) return false
      if (!(await dropDescriptions(run, task_id))) return false
      for (const relation of TASK_ROWS) {
        const drained = await drain(run.budget, relation(run.ctx, task_id), (row) =>
          discard(run.ctx, row, num, run.txn),
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

/** Deletes the item's stored rows of `table`, taking each attachment out of
 * the stored-byte totals and letting go of its file in the same
 * transaction. */
const purgeStored = (run: Run, table: StoredTable): Promise<boolean> =>
  drain(
    run.budget,
    run.ctx.db
      .query('deleted_rows')
      .withIndex('by_item_table_owner', (q) => q.eq('item_id', run.item.id).eq('table', table)),
    (row) => dropStored(run.ctx, row),
  )

/* Deletes the attachments the item stores of task `task` for good, taking
 * each out of the stored-byte totals of the task with its number, which the
 * caller holds. Callers run it before the task's deleted_tasks row or live
 * row goes, after which no row tells the number any more
 * (model/storageTotals.ts). */
const dropFilesOf = (run: Run, task: { id: string; num: number }): Promise<boolean> =>
  drain(
    run.budget,
    run.ctx.db
      .query('deleted_rows')
      .withIndex('by_item_table_owner', (q) =>
        q.eq('item_id', run.item.id).eq('table', 'issue_attachments').eq('owner_id', task.id),
      ),
    (row) => dropStored(run.ctx, row, task.num),
  )

/* Each deleted_tasks row once its task's history is gone (purgeHistory),
 * then every stored row but the project rows. A task's stored issues row
 * reserves its uuid (lib/db.ts) until its history is deleted, so a new task
 * with that id cannot lose rows to the drain. A purge the release before
 * left in this phase may already have deleted the stored row, and another
 * task may hold the id since (idTaken). Then only the rows written up to
 * the item's deletion go, which are the deleted task's: the new task was
 * created after it. */
async function purgeRows(run: Run): Promise<boolean> {
  const tasksDone = await drain(
    run.budget,
    run.ctx.db.query('deleted_tasks').withIndex('by_item', (q) => q.eq('item_id', run.item.id)),
    async (task) => {
      const upTo = (await idTaken(run, task.task_id)) ? run.item.deleted_at : undefined
      if (!(await purgeHistory(run, task.task_id, upTo))) return false
      if (!(await dropFilesOf(run, { id: task.task_id, num: task.num }))) return false
      // the comment count and post logs go with the task, before its stored
      // row frees the id, unless the id is another's now
      if (upTo === undefined)
        for (const row of await deleteCommentRows(run.ctx, task.task_id)) charge(run.budget, row)
      await run.ctx.db.delete(task._id)
      return true
    },
  )
  if (!tasksDone) return false
  for (const table of STORED_TABLES)
    if (table !== 'projects' && !(await purgeStored(run, table))) return false
  return true
}

/* Clears project_id on the organization's activity rows filed under the
 * item's projects while the stored project rows still reserve their uuids.
 * The item's own task rows are gone by now (purgeRows); what remains are
 * the rows of tasks that moved out earlier and the project and milestone
 * rows. Each patch takes its row out of the by_project range, so the drain
 * needs no cursor. */
async function purgeActivity(run: Run): Promise<boolean> {
  if (run.item.kind !== 'project') return true
  for (const id of itemProjectIds(run.item)) {
    const done = await drain(
      run.budget,
      run.ctx.db
        .query('activity_events')
        .withIndex('by_project', (q) => q.eq('org_id', run.item.org_id).eq('project_id', id)),
      (row) => run.ctx.db.patch(row._id, { project_id: undefined }),
    )
    if (!done) return false
  }
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
    if ((await reachOn(run.ctx, id).first()) !== null) return true
    const stranded = await run.ctx.db
      .query('issues')
      .withIndex('by_project', (q) => q.eq('project_id', id))
      .first()
    if (stranded !== null) return true
  }
  return false
}

/* --------------------------------------------------------------- restores */

/* The index ranges a reveal may read per task it writes back or attaches.
 * A task item of 41 tasks with holders, a parent outside, task.restored
 * subscriptions and the Restored notice measured about 6. With a different
 * assignee and reviewer on each task, 80 people who must all see the
 * parent's project (keptParent), it measured about 22, most of it each
 * person's assignment check (keepsHolder). Since then each task also reads
 * the used_ids row of its id (lib/db.ts insertUsed), one range more.
 * Convex's 4,096 ranges leave room for that above TRASH_BUDGET's 2,500, and
 * a check of who sees a parent that runs out of what the budget has left
 * makes the reveal wait for a step of its own (revealTasks). */
const REVEAL_RANGES_PER_TASK = 20

/** The index ranges a reveal reads per project of a project item, with a
 * delete or patch counted as one for the row it reads: the conflict check's
 * key and uuid reads, its lead and legacy team, the used_ids row of its id
 * (lib/db.ts insertUsed), the counters and, in a counted organization, their
 * patch (tallyRow), the stored row it deletes, and the reach rows of its
 * stored lead it brings in line (revealProjects), which read the projects
 * the reveal wrote. A lead who became a Viewer after restore_access wrote
 * their rows comes back without the project (cleanProject), and taking their
 * rows costs six reads and two deletes. Counted as a step's budget counts
 * reads (meterDb), a reveal of 5 and of 10 sub-projects in a counted
 * organization, each with a legacy team and such a lead, spent 16 a project,
 * and 12 with each lead kept (tests/projectReach.test.ts). The largest item,
 * 201 projects, so reads about 3,200 in a step of its own, inside Convex's
 * 4,096. */
export const REVEAL_RANGES_PER_PROJECT = 16

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
  /** The restored ids too large for the call, which go on in steps. */
  stepping: string[]
  refused: { id: string; reason: RestoreBlock }[]
  deferred: string[]
}

/** An item a reveal brought back, for the activity row. */
type Revealed = { item: Item; tasks: number }

/** The rows a restore writes back before its links and reveal: a project
 * item's milestones and the relation rows of the item's tasks. Its grants
 * and team grants go back after its tasks (restoreAccess). */
const RESTORED_ROWS = [
  'milestones',
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
 * legacy team only while the team passes the predicate, the name key of
 * its name, which a copy stored before keys lacks, and without the legacy
 * icon and its color, which internal/legacyIconsBackfill clears. */
async function cleanProject(s: Scope, p: Stored<'projects'>): Promise<Stored<'projects'>> {
  const lead = p.lead_id === undefined ? null : await profileOf(s, p.lead_id)
  const team = p.team_id === undefined ? null : await teamOf(s, p.team_id)
  const { icon: _icon, icon_color: _iconColor, ...project } = p
  return {
    ...project,
    window_key: p.window_key ?? newWindowKey(),
    name_key: nameKey(p.name),
    lead_id: sameReference(lead, s.item) && canLeadProjects(lead) ? p.lead_id : undefined,
    team_id: sameReference(team, s.item) ? p.team_id : undefined,
  }
}

/** A stored grant as the restore writes it back: none when its profile fails
 * the reference predicate, a viewer grant for someone who is a viewer now
 * (model/projects.ts assertGrantee), with the key of the person's name now,
 * which a rename while the grant was stored changed (model/nameKeys.ts). */
async function cleanGrant(
  s: Scope,
  g: Stored<'project_access'>,
): Promise<Stored<'project_access'> | null> {
  const profile = await profileOf(s, g.profile_id)
  if (!sameReference(profile, s.item)) return null
  const grant = { ...g, name_key: nameKey(profile.name) }
  return profile.org_role === 'viewer' ? { ...grant, level: 'viewer' } : grant
}

/** A stored team share as the restore writes it back, with the key of the
 * team's name now, as cleanGrant, or none when its team fails the reference
 * predicate. */
async function cleanShare(
  s: Scope,
  g: Stored<'project_team_access'>,
): Promise<Stored<'project_team_access'> | null> {
  const team = await teamOf(s, g.team_id)
  return sameReference(team, s.item) ? { ...g, name_key: nameKey(team.name) } : null
}

/** A project item's projects as its reveal writes them back, and a
 * sub-project item's live parent: what levels inside the item are computed
 * over while it is in Deleted items. At most
 * LIMITS.projectDeleteSubProjects.max + 1 projects; the grants and shares,
 * which have no bound, are read per person (storedLevels). */
type Hierarchy = {
  root: Stored<'projects'> | undefined
  projects: Stored<'projects'>[]
  parent: Doc<'projects'> | null
}

function hierarchyOf(s: Scope): Promise<Hierarchy> {
  return memoRead(s.memo.hierarchy, s.item.id, async () => {
    const projects: Stored<'projects'>[] = []
    for (const row of await storedOf(s, 'projects'))
      projects.push(await cleanProject(s, docOf(row, 'projects')))
    const { parent_project_id } = s.item
    return {
      root: projects.find((p) => p.id === s.item.target_id),
      projects,
      parent:
        parent_project_id === undefined ? null : await namedProject(s, parent_project_id, 'meta'),
    }
  })
}

/** The stored tables of a project item's grants and team grants. */
const GRANT_TABLES = ['project_access', 'project_team_access'] as const
type GrantTable = (typeof GRANT_TABLES)[number]

/** The grantee a grant or team grant names: its profile or its team. */
const granteeOf = (row: Doc<'deleted_rows'>['row']): string | undefined =>
  row.table === 'project_access'
    ? row.doc.profile_id
    : row.table === 'project_team_access'
      ? row.doc.team_id
      : undefined

/* Items deleted before this can hold grants and shares stored without a
 * grantee: the release that added deleted_rows.grantee reached every
 * hosted deployment on 22 October 2026. The expiry purges such items by 22
 * November 2026, after which no item is older than this. */
const GRANTEE_SINCE = '2026-10-23T00:00:00.000Z'

/** The most stored rows without a grantee one read takes for an item and
 * table (storedFor). A restore call reads them for its view and its check
 * of each of up to 25 items, so a hundred keep that under 11,000 documents.
 * A mutable object, so tests can lower it. */
export const LEGACY_READ = { max: 100 }

/** The item's stored rows of `table` that name `grantee`: a profile's
 * grants or a team's shares. A row stored before deleted_rows.grantee
 * existed has none, so for an item deleted before GRANTEE_SINCE the rows
 * without one are read too, once per item and table, and kept when their
 * document names `grantee`. Past LEGACY_READ.max such rows none of them
 * count, so the item shows to fewer people, never to more. A restore sets
 * their grantee before it checks the people its tasks keep (restoreRows,
 * keepsHolder), but checks the restorer before that, and
 * internal/storedGrantees backfill sets it on every item. */
async function storedFor(s: Scope, table: GrantTable, grantee: string) {
  const named = await s.ctx.db
    .query('deleted_rows')
    .withIndex('by_item_table_grantee', (q) =>
      q.eq('item_id', s.item.id).eq('table', table).eq('grantee', grantee),
    )
    .collect()
  if (s.item.deleted_at >= GRANTEE_SINCE) return named
  const legacy = await memoRead(s.memo.legacyGrants, `${s.item.id}:${table}`, async () => {
    const rows = await s.ctx.db
      .query('deleted_rows')
      .withIndex('by_item_table_grantee', (q) =>
        q.eq('item_id', s.item.id).eq('table', table).eq('grantee', undefined),
      )
      .take(LEGACY_READ.max + 1)
    return rows.length > LEGACY_READ.max ? [] : rows
  })
  return [...named, ...legacy.filter((row) => granteeOf(row.row) === grantee)]
}

/** `profile`'s levels on a project item's projects while they are in
 * Deleted items (design 6.1): lib/access.ts levelsFrom over the projects as
 * the reveal writes them back, the profile's stored grants and the stored
 * shares of the teams it belongs to now, as the restore writes them back,
 * and the live grants and shares on a sub-project item's parent. While the
 * item moves, the grants and shares its steps have not stored yet are still
 * live, on projects nobody can grant again while they are absent, so they
 * count too (pendingAccess), and the item shows to the same people
 * throughout. A restore keeps the stored rows until after its reveal
 * (restoreAccess). */
function storedLevels(s: Scope, profile: Doc<'profiles'>): Promise<OrgProjectLevels> {
  return memoRead(s.memo.levels, `${s.item.id}:${profile.id}`, async () => {
    const h = await hierarchyOf(s)
    const grants: LevelGrants['grants'] = []
    for (const row of await storedFor(s, 'project_access', profile.id)) {
      const grant = await cleanGrant(s, docOf(row, 'project_access'))
      if (grant !== null) grants.push(grant)
    }
    const shares: LevelGrants['shares'] = []
    for (const teamId of await teamsOf(s, profile))
      for (const row of await storedFor(s, 'project_team_access', teamId)) {
        const share = await cleanShare(s, docOf(row, 'project_team_access'))
        if (share !== null) shares.push(share)
      }
    if (s.item.state === 'moving') {
      const pending = await pendingAccess(s, profile)
      grants.push(...pending.grants)
      shares.push(...pending.shares)
    }
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

/** `profile`'s live grants and its teams' live shares on a moving project
 * item's projects, as the restore would write them back (cleanGrant,
 * cleanShare). It reads all of them as lib/access.ts projectLevelsForOrg
 * does, once per profile for a whole list read (liveAccess), whose sight
 * already holds the viewer's (sightOf). */
async function pendingAccess(s: Scope, profile: Doc<'profiles'>): Promise<LevelGrants> {
  const ids = new Set(itemProjectIds(s.item))
  const live = await memoRead(s.memo.liveAccess, profile.id, () => accessRowsOf(s.ctx, profile))
  const out: LevelGrants = { grants: [], shares: [] }
  for (const g of live.grants) {
    const grant = ids.has(g.project_id) ? await cleanGrant(s, g) : null
    if (grant !== null) out.grants.push(grant)
  }
  for (const g of live.shares) {
    const share = ids.has(g.project_id) ? await cleanShare(s, g) : null
    if (share !== null) out.shares.push(share)
  }
  return out
}

/** A person's live grants and their teams' live shares, whole (accessRowsOf). */
type LiveAccess = Awaited<ReturnType<typeof accessRowsOf>>

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
 * profiles, and a memo seeded with those, with the person's grants and
 * team shares and with the organization's teams.
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
  const rows = await accessRowsOf(ctx, me)
  const levels = levelsFrom(me, projects, rows.grants, rows.shares)
  const memo: Memo = { ...newMemo(), conflicts: false }
  // a moving item reads them again (pendingAccess)
  memo.liveAccess.set(me.id, Promise.resolve(rows))
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
 * project, deletes them for good with their bytes and its history. Its rows the restore
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
  // a description row the move left, whose text the stored copy keeps
  if (!(await dropDescriptions(run, task.task_id))) return false
  for (const relation of TASK_ROWS) {
    const taken = await drain(run.budget, relation(run.ctx, task.task_id), async (live) => {
      if (into === null) await discard(run.ctx, live, task.num, run.txn)
      else if (!(await storeRow(run.ctx, into, live, task.task_id, run.txn)))
        await droppedInto(run.ctx, into)
    })
    if (!taken) return false
  }
  // deleted for good: its history goes while its stored row still reserves
  // its uuid. A step that ran out of budget after the stored task row went
  // has done this already, and the id may be another task's by now.
  if (into === null && !(await idTaken(run, task.task_id))) {
    if (!(await purgeHistory(run, task.task_id))) return false
    for (const row of await deleteCommentRows(run.ctx, task.task_id)) charge(run.budget, row)
  }
  const done = await drain(
    run.budget,
    run.ctx.db
      .query('deleted_rows')
      .withIndex('by_item_owner', (q) => q.eq('item_id', run.item.id).eq('owner_id', task.task_id)),
    (row) =>
      into === null
        ? dropStored(run.ctx, row, task.num)
        : run.ctx.db.patch(row._id, { item_id: into.id }),
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

/** Deletes a stored row for good, taking an attachment out of the
 * stored-byte totals of its task, numbered `num` when the caller holds the
 * task (model/storageTotals.ts), and letting go of its file. */
async function dropStored(ctx: MutationCtx, row: Doc<'deleted_rows'>, num?: number): Promise<void> {
  await ctx.db.delete(row._id)
  await uncountStored(ctx, row, num)
  await releaseFile(ctx, row.storage_id)
}

/* A project item's own rows besides its projects, while those projects are
 * still absent, and the rows that travel with the item's tasks, while those
 * tasks are still absent from issues, so readers skip them (design 5.1).
 * The item's grants and team grants go back later (restoreAccess). The
 * relation rows go back in
 * their original order per task: a move stores a task's rows in the order
 * of the index it reads them by, which for comments and attachments is
 * their creation order, and this reads them back in the order stored. */
async function restoreRows(run: Run): Promise<boolean> {
  // grants and shares stored before they named their grantee get it first,
  // so the level checks of restore_tasks read them by index (storedFor)
  if (run.item.kind === 'project')
    for (const table of GRANT_TABLES) {
      const legacy = run.ctx.db
        .query('deleted_rows')
        .withIndex('by_item_table_grantee', (q) =>
          q.eq('item_id', run.item.id).eq('table', table).eq('grantee', undefined),
        )
      if (
        !(await drain(run.budget, legacy, (row) =>
          run.ctx.db.patch(row._id, { grantee: granteeOf(row.row) }),
        ))
      )
        return false
    }
  for (const table of RESTORED_ROWS) {
    const done = await drain(
      run.budget,
      run.ctx.db
        .query('deleted_rows')
        .withIndex('by_item_table_owner', (q) => q.eq('item_id', run.item.id).eq('table', table)),
      (row) => writeRowBack(run, row),
    )
    if (!done) return false
  }
  return true
}

/* The window key a task's restored relation row carries (schema.ts
 * taskKey): its task's while the task is in issues, which a backfill may
 * have given a key since the row was stored, else the one its stored copy
 * goes back with (storedTaskKey), else the row's stored one. Each task is
 * read once per run. */
const liveKeys = new WeakMap<Run, Map<string, Promise<string | undefined>>>()
function taskKeyOf(run: Run, taskId: string, stored: string | undefined) {
  const keys = liveKeys.get(run) ?? new Map<string, Promise<string | undefined>>()
  liveKeys.set(run, keys)
  let key = keys.get(taskId)
  if (key === undefined) {
    key = byId(run.ctx, 'issues', taskId).then(async (task) =>
      task !== null ? task.window_key : await storedTaskKey(run, taskId),
    )
    keys.set(taskId, key)
  }
  return key.then((live) => live ?? stored)
}

/* The window key stored task `taskId` goes back with, or undefined when
 * Deleted items holds no copy of it. A copy stored before tasks had keys
 * gets one here (firstTaskKey), written into the copy, so its relation
 * rows, which go back before it and maybe in earlier steps, carry the key
 * that writeTask then writes with the task. */
async function storedTaskKey(run: Run, taskId: string): Promise<string | undefined> {
  const row = await run.ctx.db
    .query('deleted_rows')
    .withIndex('by_row', (q) => q.eq('table', 'issues').eq('row_id', taskId))
    .first()
  if (row === null) return undefined
  const doc = docOf(row, 'issues')
  if (doc.window_key !== undefined) {
    chargeRead(run.budget, row)
    return doc.window_key
  }
  const window_key = await firstTaskKey(run, taskId)
  await run.ctx.db.patch(row._id, { row: { table: 'issues', doc: { ...doc, window_key } } })
  charge(run.budget, row)
  return window_key
}

/* A new window key for stored task `taskId`, which has none, given also to
 * the relation rows of it already written back. A restore that began before
 * restores gave keys wrote those without one, and they would load in the
 * first window, away from their task (lib/workspaceParts.ts). The writes
 * count toward the step's budget but do not stop at it: a restore step
 * goes past it by at most one task's relation rows (LIMITS), and a reveal
 * too large for one transaction goes back to moving (recoverJobs), after
 * which a restore keys the rows in budgeted steps. Only a restore spanning
 * that release finds any such rows. */
async function firstTaskKey(run: Run, taskId: string): Promise<string> {
  const window_key = newWindowKey()
  for (const row of await strayRows(run.ctx, taskId, null)) {
    await run.ctx.db.patch(row._id, { task_key: window_key })
    charge(run.budget, row)
  }
  return window_key
}

/** Writes a stored relation row back without its archive mark, with org_id
 * where the table has it (design 5.2), and with its task's window key
 * (taskKeyOf): a comment keeps its author and editor, an attachment its
 * uploader, only while they pass the reference predicate; a follow and a
 * label assignment stay only while their profile or label passes it.
 * Deletes the stored row. */
async function writeRowBack(run: Run, row: Doc<'deleted_rows'>): Promise<void> {
  const { org_id } = run.item
  const r = row.row
  const db = uncountedWriter(run.ctx.db)
  if (r.table === 'milestones') await db.insert('milestones', r.doc)
  else if (r.table === 'comments') {
    const id = await db.insert('comments', {
      ...r.doc,
      author: await keptProfile(run, r.doc.author),
      edited_by: await keptProfile(run, r.doc.edited_by),
    })
    // back in its task's comment count, which stayed while it was stored
    run.txn.comments.push([{ _id: id, issue_id: r.doc.issue_id }, 1])
  } else if (r.table === 'issue_labels') {
    if (sameReference(await labelOf(run, r.doc.label_id), run.item)) {
      await db.insert('issue_labels', {
        ...r.doc,
        org_id,
        task_archived: undefined,
        task_key: await taskKeyOf(run, r.doc.issue_id, r.doc.task_key),
      })
      // counted here when its task is back already, else with the task
      // (writeTask), which a restore usually writes after its rows
      const task = await byId(run.ctx, 'issues', r.doc.issue_id)
      if (task !== null) chargeRead(run.budget, task)
      await tallyAssignment(run.ctx, r.doc, 1, task)
    }
  } else if (r.table === 'issue_subscriptions') {
    if ((await keptProfile(run, r.doc.profile_id)) !== undefined)
      await db.insert('issue_subscriptions', {
        ...r.doc,
        task_archived: undefined,
        task_key: await taskKeyOf(run, r.doc.issue_id, r.doc.task_key),
      })
  } else if (r.table === 'issue_attachments') {
    await db.insert('issue_attachments', {
      ...r.doc,
      org_id,
      uploaded_by: await keptProfile(run, r.doc.uploaded_by),
      task_archived: undefined,
      task_key: await taskKeyOf(run, r.doc.issue_id, r.doc.task_key),
    })
    // the step its drop scheduled found it here, so a dropped image gets
    // its step again, due when the drop's was (model/descriptionImages.ts)
    if (r.doc.dropped_at !== undefined) await scheduleImageReap(run.ctx, r.doc.id, r.doc.dropped_at)
  } else throw new Error(`A restore cannot write a ${r.table} row back here`)
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
    run.ctx.db
      .query('deleted_rows')
      .withIndex('by_item_table_owner', (q) =>
        q.eq('item_id', run.item.id).eq('table', 'issue_links'),
      ),
    (row) => placeLink(run, row),
  )

/** Where stored link `row` goes (design 5.2). Each end, by the reference
 * predicate, is live in the organization, a task of this item, or a task of
 * another item that is restoring: the link is written back unless a link
 * already holds its pair. A task of an item that restores is absent until
 * its reveal, so nobody sees the link before then, and a restore that fails
 * takes it back with its task (move_drain). An end in another item that is
 * ready or moving: the link moves to that item, owned by that end.
 * Otherwise it is dropped, and so is a link one of whose ends is an end of
 * LIMITS.links.max links already (model/links.ts linksFullAt). A link never
 * moves to an item that restores,
 * because that item's own restore_links would hand it straight back, and
 * two items restoring together would trade their links for ever. */
async function placeLink(run: Run, row: Doc<'deleted_rows'>): Promise<void> {
  const link = docOf(row, 'issue_links')
  // An end can be a legacy task near 1 MiB, so the step pays for what it
  // reads about both ends and its drain stops between links once spent.
  const cost: Cost = { ranges: 0, bytes: 0 }
  const read = measured(run.ctx, cost)
  try {
    await placeLinkBy(run, read, row, link)
  } finally {
    run.budget.bytes -= cost.bytes
  }
}

async function placeLinkBy(
  run: Run,
  read: MutationCtx,
  row: Doc<'deleted_rows'>,
  link: Stored<'issue_links'>,
): Promise<void> {
  let away: { item: Item; end: string } | null = null
  for (const end of [link.source_id, link.target_id]) {
    const where = await whereIsTask(read, end)
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
    if (
      where.where === 'trash' &&
      where.item.id !== run.item.id &&
      where.item.state !== 'restoring'
    )
      away ??= { item: where.item, end }
  }
  if (away !== null)
    return await run.ctx.db.patch(row._id, { item_id: away.item.id, owner_id: away.end })
  const taken = await run.ctx.db
    .query('issue_links')
    .withIndex('by_pair', (q) => q.eq('pair_key', link.pair_key))
    .first()
  // an end that reached LIMITS.links.max while this link was in Deleted
  // items takes no more, so the link stays out, as one to a task
  // deleted for good does. An end of this item counts the links written
  // back before this one.
  let full = false
  for (const end of [link.source_id, link.target_id]) full ||= await linksFullAt(read, end)
  if (taken === null && !full)
    await uncountedWriter(run.ctx.db).insert('issue_links', {
      ...link,
      org_id: run.item.org_id,
      task_archived: undefined,
      task_key: await taskKeyOf(run, link.source_id, link.task_key),
    })
  await run.ctx.db.delete(row._id)
}

type StoredTask = { row: Doc<'deleted_rows'>; doc: Stored<'issues'> }

/** A task item's stored task with the live project it goes back to. */
type HomedTask = StoredTask & { home: Doc<'projects'> }

/* A project item's tasks, written back under its projects, which stay
 * absent until the reveal (design 5.1), so these tasks stay hidden. A task
 * whose parent is in the item keeps it. A task whose parent is outside the
 * item goes back without it, and deleted_item_parents keeps that parent
 * for attachParents, which applies the parent table after the reveal, by
 * the state then (design 5.2). Writing the parent now could make it a group
 * before the reveal, as a parent in an archived project counts every active
 * subtask (lib/liveTasks.ts countsAsSubtask). A
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
 * model/issues.ts doneStampUpdate), no archive mark, updated_at now, and a
 * window key when it was stored without one (firstTaskKey).
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
  // with its description row, from the text the stored copy keeps
  // (model/descriptions.ts), and the used_ids row of its id, which a task
  // stored before used_ids existed gets now
  const _id = await insertTask(
    uncountedWriter(run.ctx.db),
    {
      ...doc,
      // a copy stored before tasks had keys, whose relation rows gave it
      // none (storedTaskKey)
      window_key: doc.window_key ?? (await firstTaskKey(run, doc.id)),
      parent_id: parentId,
      ...(await restoredHolders(run, doc)),
      created_by: await keptProfile(run, doc.created_by),
      reporter_id: await keptProfile(run, doc.reporter_id),
      done_at: active && doc.status === 'done' ? run.now : doc.done_at,
      relations_marked: undefined,
      updated_at: run.now,
    },
    'restore',
  )
  await tallyRow(run.ctx, 'issues', null, doc)
  // a task stored before comment counts starts its count
  await beginCount(run.ctx, doc)
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
 * item is then gone (null). A project item goes on to restore_grants,
 * which deletes its stored grants (restoreGrants), and then restore_attach (attachParents), which deletes
 * the item once no task waits for its parent.
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
    // a job the release before saved here has not written the grants back
    if (!run.state.granted) return { ...run.state, phase: 'restore_access', cursor: undefined }
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
    const tasks: HomedTask[] = []
    for (const row of await storedOf(run, 'issues')) {
      const doc = docOf(row, 'issues')
      if ((await byId(run.ctx, 'issues', doc.id)) !== null) return await sendBack(run, 'conflict')
      const home = await namedProject(run, doc.project_id, 'project')
      if (home === null) return { ...run.state, phase: 'restore_split', cursor: undefined }
      tasks.push({ row, doc, home })
    }
    const back = await revealTasks(run, tasks, restorer)
    // a parent check ran out of reads before any task was written
    if (back === null) return run.state
    written = back
  } else await revealProjects(run)
  const links = run.ctx.db
    .query('deleted_rows')
    .withIndex('by_item_table_owner', (q) =>
      q.eq('item_id', run.item.id).eq('table', 'issue_links'),
    )
  for await (const row of links) await placeLink(run, row)
  const left = await run.ctx.db
    .query('deleted_tasks')
    .withIndex('by_item', (q) => q.eq('item_id', run.item.id))
    .collect()
  for (const row of left) await run.ctx.db.delete(row._id)
  await announce(run, written, restorer)
  if (run.item.kind === 'project')
    return { ...run.state, phase: 'restore_grants', cursor: undefined }
  await run.ctx.db.delete(run.item._id)
  return null
}

/* A project item's grants and team grants, written back before its reveal
 * (restore_access), so that the reveal shows the projects to everyone who
 * had access in one delivery. Each one written back writes its reach rows
 * too, and then each project's lead does (model/projectNav.ts), from the
 * projects as their reveal writes them back (restoreRead), so the
 * navigation lists have them at the reveal as well. The stored rows stay
 * until after the reveal (restoreGrants): until then a level check keeps
 * reading one person's grants of the item by index (storedLevels), however
 * many grants the item holds, and the live copies name projects that are
 * still absent, which readers skip as they do while a move drains. The step
 * walks each project's stored rows of each table with the job's cursor,
 * because the rows stay in their range. Each step goes on from the creation
 * time of the last row it wrote, that row included, so a tie of
 * _creationTime skips nothing. A grant whose profile, or a share whose
 * team, fails the reference predicate stays out (cleanGrant, cleanShare),
 * and so does one a live row on the same project already holds: the row a
 * step starts with, or one a walk repeated after the reveal sent the item
 * back to an earlier phase finds. Every grant is back before the reveal, so
 * nothing writes one after it, when an admin may already have removed it. */
async function restoreAccess(run: Run): Promise<boolean> {
  if (run.item.kind !== 'project') return true
  const ids = itemProjectIds(run.item)
  const cursor = run.state.cursor ?? { index: 0, after: 0 }
  const stop = () => {
    run.state.cursor = cursor
    return false
  }
  // each project's grants, then its team grants, then its lead
  for (
    ;
    cursor.index < (GRANT_TABLES.length + 1) * ids.length;
    cursor.index += 1, cursor.after = 0
  ) {
    if (spent(run.budget)) return stop()
    const at = Math.floor(cursor.index / ids.length)
    const owner = ids[cursor.index % ids.length]
    if (at === GRANT_TABLES.length) {
      // the stored project's lead, read through the measured ctx, so the
      // step counts the stored rows when this reads them first
      await syncReachOf(run, async (ctx) => {
        const project = (await hierarchyOf({ ...run, ctx })).projects.find((p) => p.id === owner)
        const lead = project?.lead_id
        if (lead === undefined) return
        await syncLeads(ctx, owner, [lead], restoreRead(run, ctx))
        run.budget.moved = true
      })
      continue
    }
    const table = GRANT_TABLES[at]
    const rows = run.ctx.db
      .query('deleted_rows')
      .withIndex('by_item_table_owner', (q) =>
        q
          .eq('item_id', run.item.id)
          .eq('table', table)
          .eq('owner_id', owner)
          .gte('_creationTime', cursor.after),
      )
    for await (const row of rows) {
      // a row already back, the one the step starts with among them, costs
      // only its reads, so every step gets past it
      if (await writeGrantBack(run, row)) charge(run.budget, row)
      else {
        chargeRead(run.budget, row)
        run.budget.moved = true
      }
      cursor.after = row._creationTime
      if (spent(run.budget)) return stop()
    }
  }
  run.state.granted = true
  return true
}

/* After the reveal, deletes a project item's stored grants and team
 * grants within the step's budget, before the attach. It writes none back:
 * restore_access wrote every one before the reveal (granted), and a grant
 * an admin removed since must stay removed. A job the release before left
 * past its reveal wrote its grants back here, so without `granted` this
 * writes back each one still missing on a live project first. A stored row
 * whose grantee holds no reach row on the project, live now, or one whose
 * copies differ from it (model/projectNav.ts reachFollows), gets its rows
 * written again (syncReach), as for a job an earlier release left past
 * restore_access, which wrote grants back without them; a row that follows
 * the project costs one read, and each project is read once a step. */
async function restoreGrants(run: Run): Promise<boolean> {
  // each project the step reads, once, its bytes charged to the budget
  const projects = new Map<string, Promise<Doc<'projects'> | null>>()
  const project = (id: string) => {
    let read = projects.get(id)
    if (read === undefined) {
      read = (async () => {
        const cost = { ranges: 0, bytes: 0 }
        const doc = await byId(measured(run.ctx, cost), 'projects', id)
        run.budget.bytes -= cost.bytes
        return doc
      })()
      projects.set(id, read)
    }
    return read
  }
  for (const table of GRANT_TABLES) {
    const done = await drain(
      run.budget,
      run.ctx.db
        .query('deleted_rows')
        .withIndex('by_item_table_owner', (q) => q.eq('item_id', run.item.id).eq('table', table)),
      async (row) => {
        const live = await project(row.owner_id)
        if (!run.state.granted && live !== null) await writeGrantBack(run, row)
        // the grantee's reach rows on the project, live now, which
        // restore_access wrote from the stored copy. They are written again
        // where they are missing, as for a job an earlier release left past
        // restore_access, or where a copy differs from the project the
        // reveal wrote.
        const g = granteeOfStored(row)
        if (g !== null && live !== null && !(await reachFollows(run.ctx, g, live)))
          await syncReachOf(run, (ctx) => syncReach(ctx, g, row.owner_id))
        await run.ctx.db.delete(row._id)
      },
    )
    if (!done) return false
  }
  return true
}

/** The grantee of stored grant or team grant `row`, null for another row. */
function granteeOfStored(row: Doc<'deleted_rows'>): Grantee | null {
  const r = row.row
  if (r.table === 'project_access') return grantee.profile(r.doc.profile_id)
  if (r.table === 'project_team_access') return grantee.team(r.doc.team_id)
  return null
}

/** Writes stored grant or team grant `row` back to its live table, with
 * its reach rows (model/projectNav.ts insertGrant, insertShare), unless it
 * fails the reference predicate (cleanGrant, cleanShare) or a live row on
 * the same project already holds it. Leaves the stored row. True when it
 * wrote one. */
async function writeGrantBack(run: Run, row: Doc<'deleted_rows'>): Promise<boolean> {
  const db = uncountedWriter(run.ctx.db)
  const r = row.row
  if (r.table === 'project_access') {
    const grant = await cleanGrant(run, r.doc)
    const held = await run.ctx.db
      .query('project_access')
      .withIndex('by_project_profile', (q) =>
        q.eq('project_id', r.doc.project_id).eq('profile_id', r.doc.profile_id),
      )
      .first()
    if (grant === null || held !== null) return false
    await syncReachOf(run, (ctx) =>
      insertGrant(ctx, grant, { db, read: restoreRead(run, ctx), org: run.item.org_id }),
    )
    return true
  } else if (r.table === 'project_team_access') {
    const share = await cleanShare(run, r.doc)
    const held = await run.ctx.db
      .query('project_team_access')
      .withIndex('by_project_team', (q) =>
        q.eq('project_id', r.doc.project_id).eq('team_id', r.doc.team_id),
      )
      .first()
    if (share === null || held !== null) return false
    await syncReachOf(run, (ctx) =>
      insertShare(ctx, share, { db, read: restoreRead(run, ctx), org: run.item.org_id }),
    )
    return true
  }
  return false
}

/** Reads projects through `ctx` for the reach rows a project item's
 * restore writes before its reveal: a live project, else one of the item's
 * stored projects as its reveal writes it back (hierarchyOf). It reads the
 * live table each time rather than through the Memo, which would keep an
 * item's project absent after the reveal of the same transaction writes
 * it. */
const restoreRead =
  (run: Run, ctx: QueryCtx): ProjectRead =>
  async (id) =>
    (await byId(ctx, 'projects', id)) ??
    // through `ctx`, so the step counts the stored rows when this reads
    // them first
    (await hierarchyOf({ ...run, ctx })).projects.find((p) => p.id === id) ??
    null

/** Runs `write`, which brings reach rows in line, on the step's ctx with
 * the bytes it reads, the projects and teams included, charged to the
 * step's budget, which counts its index ranges already. */
async function syncReachOf(run: Run, write: (ctx: MutationCtx) => Promise<void>): Promise<void> {
  const cost = { ranges: 0, bytes: 0 }
  await write(measured(run.ctx, cost))
  run.budget.bytes -= cost.bytes
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

/* A project item's projects as the hierarchy cleans them, at most
 * LIMITS.projectDeleteSubProjects.max + 1, each with the archive state its
 * archive time and its parent's give it now (model/projectNav.ts
 * archiveStateOf), which a copy stored before archive states lacks. Their
 * milestones, grants, team shares and reach rows went back before
 * (restoreRows, restoreAccess), so the projects show with them. Each
 * counts against the rows and bytes of the budget, so a later item of the
 * same restore call waits for a step when they leave no room for its
 * reveal (revealFits). The attach after it still checks its first parent
 * whole when nothing moved before the reveal. */
async function revealProjects(run: Run): Promise<void> {
  const rows = await storedOf(run, 'projects')
  const docs = rows.map((row) => docOf(row, 'projects'))
  // the parent of the item's top-level row is live; the parent of each of
  // its sub-projects is that row (model/projectNav.ts archiveStateOf)
  const parent =
    run.item.parent_project_id === undefined
      ? null
      : await byId(run.ctx, 'projects', run.item.parent_project_id)
  if (parent !== null) run.budget.bytes -= estimateDocumentBytes(parent)
  const top = docs.find((p) => p.id === run.item.target_id) ?? null
  // the projects as the reveal writes them, which the leads' rows read
  const written = new Map<string, ReachProject>()
  for (const [index, row] of rows.entries()) {
    const stored = docs[index]
    const project = {
      ...(await cleanProject(run, stored)),
      archive_state: archiveStateOf(stored, stored.id === top?.id ? parent : top),
    }
    // with the used_ids row of its id, which a project stored before
    // used_ids existed gets now
    await insertUsed(uncountedWriter(run.ctx.db), 'projects', project, 'restore')
    await tallyRow(run.ctx, 'projects', null, project)
    await run.ctx.db.delete(row._id)
    written.set(project.id, project)
    run.budget.rows -= 1
    run.budget.bytes -= estimateDocumentBytes(row)
  }
  // Once every project is in, the reach rows of each stored lead follow the
  // lead the reveal wrote, which a role change since restore_access can
  // have dropped or brought back (cleanProject). They read the projects
  // from what the reveal wrote and the outside parent it read, so a
  // sub-project costs no read of its top-level project, which a legacy icon
  // can make near 1 MiB; the reveal runs whole in one transaction.
  const read =
    (ctx: QueryCtx): ProjectRead =>
    async (id) =>
      written.get(id) ?? (id === parent?.id ? parent : await byId(ctx, 'projects', id))
  for (const stored of docs)
    if (stored.lead_id !== undefined) {
      const lead = stored.lead_id
      await syncReachOf(run, (ctx) => syncLeads(ctx, stored.id, [lead], read(ctx)))
    }
}

/** Writes a task item's stored tasks `tasks` back, parents before
 * children. A task keeps a parent inside the item when both are in the same
 * top-level project (model/issues.ts sameTopLevel), and comes back without
 * it otherwise, which only a subtask stored before that rule meets. A
 * parent outside the item is kept or cleared by the parent table (design
 * 5.2), from what the reveal reads once per parent (outsideParent) and the
 * task's subtasks among `tasks`, with the people they come back with, and
 * each parent the restore makes a group loses its own hours once. Every
 * parent is decided before the first task is written, and no decision
 * reads a task the reveal writes. Returns the ids of the tasks written, or
 * null, with nothing written, when a check runs out of the reads the
 * transaction has left ('later'). The reveal then waits for a step of its
 * own, where no check waits. */
async function revealTasks(
  run: Run,
  tasks: HomedTask[],
  restorer: Doc<'profiles'>,
): Promise<Id<'issues'>[] | null> {
  const byTask = new Map(tasks.map((t) => [t.doc.id, t]))
  // the parent inside the item that `t` keeps
  const keptInside = (t: HomedTask): HomedTask | undefined => {
    const parent = t.doc.parent_id === undefined ? undefined : byTask.get(t.doc.parent_id)
    return parent !== undefined && sameTopLevel(t.home, parent.home) ? parent : undefined
  }
  const children: StoredChildren = new Map()
  for (const t of tasks) {
    const parent = keptInside(t)
    if (parent === undefined) continue
    const siblings = children.get(parent.doc.id)
    if (siblings === undefined) children.set(parent.doc.id, [t.doc])
    else siblings.push(t.doc)
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
  // the parent each task comes back with where it is not the stored one
  const decided = new Map<string, string | undefined>()
  for (const t of ordered) {
    const parentId = t.doc.parent_id
    if (parentId === undefined) continue
    if (byTask.has(parentId)) {
      if (keptInside(t) === undefined) decided.set(t.doc.id, undefined)
      continue
    }
    const outside = await memoRead(reads.parents, parentId, () =>
      outsideParent(run, parentId, restorer, reads),
    )
    const task = { ...t.doc, ...(await restoredHolders(run, t.doc)) }
    const kept = await keptParent(run, task, t.home, outside, children, reads)
    if (kept === 'later') return null
    if (kept?.grouped) grouped.add(parentId)
    decided.set(t.doc.id, kept?.id)
  }
  const written: Id<'issues'>[] = []
  for (const t of ordered) {
    const kept = decided.has(t.doc.id) ? decided.get(t.doc.id) : t.doc.parent_id
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
 * the reveal wrote back what it writes. That is the live parents it reads,
 * each parent's OutsideParent and its subtasks, the organization's projects
 * (liveProjects) and what each person sees of them (seenBy). */
type ParentReads = {
  tasks: LiveTasks
  /* each parent's subtasks as the step leaves them (liveSubtasks) */
  subtasks: Map<string, number>
  parents: Map<string, Promise<OutsideParent | null>>
  projects: Promise<Doc<'projects'>[]> | undefined
  people: Map<string, Promise<Seen>>
}

const newParentReads = (): ParentReads => ({
  tasks: new Map(),
  subtasks: new Map(),
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
 * task, its project, whether the restorer may change it (sight and Edit on
 * its project, as assertParentChain asks) and whether it holds hours of its
 * own that a new child takes away. No task the step gives a parent is such
 * a parent, because the item stored only parents outside it, so this holds
 * for the whole step. */
type OutsideParent = {
  parent: Doc<'issues'>
  project: Doc<'projects'>
  edits: boolean
  clears: boolean
}

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
    project,
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
 * ran out of the step's reads (liveSubtasks, allSee) and must run again in the
 * next step. */
type Kept = { id: string; grouped: boolean } | undefined | 'later'

/** The parent `task` of the item keeps from outside it, by the parent table
 * (design 5.2), or undefined to clear it. Only a live parent that is the
 * task the item stored can stay, and only in the top-level project of
 * `home`, the live project the task comes back in, by the subtask rule
 * (model/issues.ts sameTopLevel). A parent that moved to another top-level
 * project since the delete fails it, as can a subtask stored before the
 * rule. The one level of subtasks (lib/limits.ts) also clears a
 * parent that is a subtask itself, the parent of a task that comes back
 * with subtasks, and, for an active task, a parent that already has
 * LIMITS.subtasks.max active subtasks, as a restore from the archive does
 * (model/issues.ts unarchiveIssueCore). An
 * active parent stays when the restorer may change it; an archived one only
 * for an archived task.
 * `grouped`: the attach makes the parent a group (lib/liveTasks.ts
 * countsAsSubtask). Any task under an archived parent does, and so does an
 * active task under an active parent unless the task's project is archived
 * while the parent's is not. The parent then loses its own remaining hours
 * as on a reparent (model/issues.ts clearParentRemaining). An archived
 * parent that holds hours of its own
 * therefore needs the restorer's Edit too, so a restore never changes a
 * task in a project the restorer cannot edit.
 *
 * This applies the checks of model/issues.ts parentChainCheck without
 * calling it. It asks issues whether the task has subtasks, and a task
 * item's subtasks are not there yet. It also needs a restorer, and their
 * Edit even on an archived parent. This table reads the same facts within
 * the step's budget instead.
 *
 * Whoever works on the task must also see the parent, the rule a reparent
 * follows (model/issues.ts updateIssueCore, HOLDER_SIGHT_RULE). Where an
 * edit refuses, the task comes back without the parent and keeps its
 * people, as for the table's other refusals. Whether the task has a
 * subtask (workersOf) is read only for a parent that passes the rest, and
 * who sees the parent (allSee) last. The count of the parent's subtasks and
 * who sees it answer 'later' when the step's reads run out before they read
 * what the step has not read yet. */
async function keptParent(
  run: Run,
  task: Worker,
  home: Doc<'projects'>,
  outside: OutsideParent | null,
  children: StoredChildren,
  reads: ParentReads,
): Promise<Kept> {
  if (outside === null || !sameTopLevel(home, outside.project)) return undefined
  // one level of subtasks (lib/limits.ts): no parent that is a subtask
  if (outside.parent.parent_id !== undefined) return undefined
  const active = outside.parent.archived_at === undefined
  const taskActive = task.archived_at === undefined
  if (!active && taskActive) return undefined
  if ((active || outside.clears) && !outside.edits) return undefined
  // nor a task with subtasks under one
  const workers = await workersOf(run, task, children)
  if (workers === null) return undefined
  // only an active task counts toward the parent's LIMITS.subtasks.max
  const subtasks = taskActive ? await liveSubtasks(run, reads, outside.parent.id) : 0
  if (subtasks === 'later') return 'later'
  if (subtasks >= LIMITS.subtasks.max) return undefined
  const sees = await allSee(run, reads, task, workers, outside.parent.project_id)
  if (sees === 'later') return 'later'
  if (sees && taskActive) reads.subtasks.set(outside.parent.id, subtasks + 1)
  // the attach makes the parent a group only when the task counts for it
  const grouped = countsAsSubtask(
    { archived: !active, projectLive: outside.project.archived_at === undefined },
    { archived: !taskActive, projectLive: home.archived_at === undefined },
  )
  return sees ? { id: outside.parent.id, grouped } : undefined
}

/** The most bytes one count of a parent's subtasks (liveSubtasks) reads.
 * A subtask within TEXT_MAX stores up to about 120 KB as JSON
 * (chargeRead), so a parent's 100 active subtasks can pass what a step can
 * read. A count past it stops, counts the parent as full, with a warning,
 * and its task comes back without it. Someone with Edit can still give the
 * task that parent by hand. A mutable object, so tests can lower it. */
export const COUNT_READ = { bytes: 8 * 1024 * 1024 }

/** How many active subtasks live task `parentId` has, counted up to
 * LIMITS.subtasks.max, with the ones the step gave it, or
 * LIMITS.subtasks.max for a count past COUNT_READ. Read once per step and
 * charged to its budget; 'later' when the step's reads are spent before it
 * is read. */
async function liveSubtasks(
  run: Run,
  reads: ParentReads,
  parentId: string,
): Promise<number | 'later'> {
  const known = reads.subtasks.get(parentId)
  if (known !== undefined) return known
  if (readsSpent(run.budget)) return 'later'
  let count = 0
  let bytes = 0
  const kids = run.ctx.db
    .query('issues')
    .withIndex('by_parent_archived', (q) =>
      q.eq('parent_id', parentId).eq('archived_at', undefined),
    )
  for await (const kid of kids) {
    count += 1
    bytes += chargeRead(run.budget, kid)
    if (count >= LIMITS.subtasks.max) break
    if (bytes > COUNT_READ.bytes) {
      console.warn('A deleted item restore cannot count the subtasks of a parent', {
        item_id: run.item.id,
        parent_id: parentId,
      })
      count = LIMITS.subtasks.max
      break
    }
  }
  reads.subtasks.set(parentId, count)
  return count
}

/** The most one check of who sees a parent (allSee) reads, counted from the
 * start. Each person counts their profile and the batched read of their
 * levels (seenBy), whether the step read them for an earlier task or not,
 * so the answer depends only on the data. A check past it does not fit, so
 * its task keeps no parent from outside, with a warning, as for COUNT_READ,
 * and a retry answers the same. Someone with Edit can still give the task
 * that parent by hand. A person without teams costs 3 ranges and each team
 * 2 more, so 2,000 ranges hold several hundred people. The first check of a
 * step, which never waits, then reads at most these 2,000 ranges and 2 MiB,
 * the parent (under 1 MiB), the first subtask under the task (under 1 MiB)
 * and the parent's subtasks (COUNT_READ, 8 MiB), within Convex's 4,096
 * ranges and 16 MiB. A mutable object, so tests can lower it. */
export const SIGHT_READ = { ranges: 2000, bytes: 2 * 1024 * 1024 }

/**
 * Whether everyone in `people`, the people working on `task` (workersOf),
 * can see `projectId`, the parent's project (model/issues.ts chainSight),
 * passing over someone switched off or gone, as a reparent does, because
 * they take on no new work. Each person costs one read of what they see
 * (seenBy).
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
  projectId: string,
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
    if (levels.levelOf({ id: projectId, org_id: run.item.org_id }) === null) return false
  }
  return true
}

/**
 * The people who work on task `task` once it is back, as model/issues.ts
 * holdersUnder names them for a reparent: its assignee and reviewer. Null
 * when the task has a subtask, because one level of subtasks
 * (lib/limits.ts) keeps a task with subtasks from taking a parent. Its
 * subtasks are its children among the tasks the reveal writes (`children`)
 * and, for a project item, the tasks under it in issues, which restore_tasks
 * wrote back or, after the reveal, anyone attached. Only the first one
 * found is read, and charged to the step's budget. A task item's tasks are
 * read too: its delete detached every active child outside it, but its
 * archived children leave in steps after the delete
 * (detachArchivedChildren), which a quick restore can overtake.
 */
async function workersOf(
  run: Run,
  task: Worker,
  children: StoredChildren,
): Promise<Set<string> | null> {
  if ((children.get(task.id) ?? []).length > 0) return null
  const kid = await run.ctx.db
    .query('issues')
    .withIndex('by_parent', (q) => q.eq('parent_id', task.id))
    .first()
  if (kid !== null) {
    chargeRead(run.budget, kid)
    return null
  }
  const people = new Set<string>()
  if (task.assignee_id !== undefined) people.add(task.assignee_id)
  if (task.reviewer_id !== undefined) people.add(task.reviewer_id)
  return people
}

/* What a reveal tells (design 5.4). A task item sends task.restored for
 * each task it wrote back, and its root's followers get the Restored notice
 * when the restore call held this item alone and was not part of a bulk
 * restore. A project item sends
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
 * the archive sends (model/issues.ts unarchiveIssueCore). The rows are back
 * by now. Past its first followers, background steps tell the rest
 * (model/messages.ts notifyFollowersOfChange). */
async function noticeRestored(
  run: Run,
  root: Doc<'issues'>,
  restorer: Doc<'profiles'>,
): Promise<void> {
  const project = await byId(run.ctx, 'projects', root.project_id)
  if (project === null) return
  await notifyFollowersOfChange(run.ctx, {
    issue: root,
    project,
    actor: restorer,
    now: run.now,
    parts: ['Restored'],
  })
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** One activity row for the items one transaction revealed (design 5.4):
 * a single task item's row on its root task, a single project item's row on
 * its project, or for several one row that counts them ("restored 3 tasks
 * from Deleted items"). That row is filed under the project the items
 * share; otherwise it is a project row without project_id. Project rows
 * reach no client; organization admins read them in the export
 * (lib/activityVisibility.ts). */
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
    const common = {
      ...row,
      target_id: item.target_id,
      label: item.name,
      detail,
      project_id: item.project_id,
    }
    await logActivity(
      ctx,
      item.kind === 'task'
        ? { ...common, target_type: 'issue', named_task_nums: [] }
        : { ...common, target_type: 'project' },
    )
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

/** The tasks a project item's restore wrote back without their parent
 * outside the item (restoreTasks), in task order. */
const waitingParents = (run: Run) =>
  run.ctx.db
    .query('deleted_item_parents')
    .withIndex('by_item_task', (q) => q.eq('item_id', run.item.id))

/** What one attach step reads once, which is what any parent check reads
 * (ParentReads), with the live tasks as its own attaches leave them, and
 * each project its tasks are in, by id, null for one that is not live. It
 * also keeps the parents it made a group. */
type Attach = ParentReads & {
  live: Map<string, Promise<Doc<'projects'> | null>>
  grouped: Set<string>
}

/**
 * After a project item's reveal (restore_attach), gives each task that
 * restore_tasks wrote back without its parent outside the item that
 * parent, by the parent table (design 5.2) as it reads now and with the
 * helpers a task item's reveal uses. Each step stays within its budget,
 * however many tasks wait. A task whose check runs out of the step's reads
 * keeps its row for the next step, where it comes first and its check runs
 * whole (liveSubtasks, allSee). work runs the first in the reveal's own transaction, so
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
  const done = await drain(run.budget, waitingParents(run), (row) =>
    attach ? attachParent(run, row, step) : run.ctx.db.delete(row._id),
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
  const home = await memoRead(step.live, task.project_id, () =>
    byId(run.ctx, 'projects', task.project_id),
  )
  if (home === null) return await settle(await holderOf(run, task.project_id))
  const outside = await memoRead(step.parents, row.parent_id, () =>
    outsideParent(run, row.parent_id, run.actor, step),
  )
  const kept = await keptParent(run, task, home, outside, new Map(), step)
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
 * call's one shared budget, a quarter of a step's (CALL),
 * fills, reveals and attaches as much as it can, revealing an item only
 * when the reveal fits what is left (revealFits); the rest goes on in
 * steps. The call's checks leave the conflict check to the reveal. The reveals of this call share one activity
 * row, and an item revealed by a later step writes its own.
 * The Restored notice goes out only when the call held a single task item
 * and is not `bulk`, whichever transaction reveals it. A client that sends
 * one restore of several items in several calls marks each call `bulk`, so
 * a call that happens to hold one item sends no notice either.
 */
export async function restoreItems(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; items: Item[]; now: string; bulk?: boolean },
): Promise<RestoreResult> {
  const budget = budgetFor(CALL.scale)
  const counted = metered(ctx, budget)
  const result: RestoreResult = { restored: [], stepping: [], refused: [], deferred: [] }
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
    // the reveal looks for conflicts (blockOf), so the call does not read
    // two rows per project of each item for them
    const block = await restoreBlock(counted, a.me, item, { ...newMemo(), conflicts: false })
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
      alone: (a.bulk !== true && ordered.length === 1) || undefined,
    }
    const next = await work(counted, budget, restoring, state, txn)
    // the next item's phases and reveal stop on what this one spent, even
    // when it only revealed projects
    budget.moved = true
    if (next !== null) await saveJob(ctx, restoring, next, null)
    const failed = txn.failed.get(item.id)
    if (failed !== undefined) result.refused.push({ id: item.id, reason: failed })
    else {
      result.restored.push(item.id)
      if (next !== null) result.stepping.push(item.id)
    }
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
  restore_tasks: { run: restoreTasks, next: () => 'restore_access' },
  restore_access: { run: restoreAccess, next: () => 'restore_reveal' },
  restore_grants: { run: restoreGrants, next: () => 'restore_attach' },
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
 * or a project item's projects, and, for a project item, the attach of every
 * task that waits for its parent (attachParents), so that an item whose
 * reveal and attach fit what the transaction has left comes back whole in
 * it. It counts tasks, not the bytes their parents and subtasks
 * hold. An attach that spends the bytes left stops there, as any step
 * does, and steps finish it. A parent check whose subtask count or people
 * (liveSubtasks, allSee) run out of what is left waits too, a task item's
 * reveal for a step of its own and a project item's task for the next
 * attach step. It reads at most
 * one more waiting task than the budget holds. */
async function revealFits(run: Run): Promise<boolean> {
  const b = run.budget
  if (spent(b)) return false
  const stored = run.state.tally?.tasks ?? 0
  const waiting =
    run.item.kind === 'project' ? (await waitingParents(run).take(b.tasks + 1)).length : 0
  const tasks = stored + waiting
  const projects = run.item.kind === 'project' ? run.item.projects.length : 0
  return (
    tasks <= b.tasks &&
    tasks + projects <= b.rows &&
    tasks * REVEAL_RANGES_PER_TASK + projects * REVEAL_RANGES_PER_PROJECT <= b.ranges
  )
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
    state: {
      phase: state.phase,
      cursor: state.cursor,
      tally: state.tally,
      alone: state.alone,
      purge_history: state.purge_history,
      granted: state.granted,
    },
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
      // a step reveals whatever its size; a person's call only what fits
      const call = run.txn.restorer !== undefined
      if ((run.budget.moved || call) && !(await revealFits(run))) return run.state
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

/** Finishes what a transaction's items left for its end: the comment
 * counts of the comments it moved, and the archive steps of the archived
 * tasks it wrote back, scheduled in one call. */
async function finishTxn(ctx: MutationCtx, txn: Txn): Promise<void> {
  if (txn.comments.length > 0) await tallyComments(ctx, txn.comments)
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
    purge_history: state.purge_history,
    granted: state.granted,
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
 * deletes the item's own small rows, and restore_grants deletes the small
 * stored grant rows (writing back the missing ones only for a job the
 * release before left), so each is retried until it finishes.
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
      job.phase !== 'restore_grants' &&
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
        granted: undefined,
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
 * Delete now either. `inline` spends a person's call's share of a budget
 * (CALL) in the caller's transaction, for a caller that purges one item. */
export async function startPurge(
  ctx: MutationCtx,
  item: Item,
  opts: { inline?: boolean } = {},
): Promise<void> {
  await beginPurge(ctx, item, opts.inline ? budgetFor(CALL.scale) : undefined)
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
  const budget = budgetFor(CALL.scale)
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

/** Spends the first budget of `item`'s work, by default a person's call's
 * share (CALL), in the caller's transaction and schedules a step for what
 * is left. `budget` may already hold what the
 * caller spent on the same work. */
async function startJob(
  ctx: MutationCtx,
  item: Item,
  state: JobState,
  budget = budgetFor(CALL.scale),
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

/** Whether `budget` has run out of rows or of bytes. */
export const teardownSpent = (budget: Teardown): boolean =>
  budget.left <= 0 || (budget.bytes !== undefined && budget.bytes <= 0)

/** Removes the rows of `rows`, an index range read in one pass (drain),
 * until it ends (true) or `budget` is spent (false). A budget not yet spent
 * removes at least one row. `remove` must take its row out of the range,
 * and answers false when the budget ran out before it could. */
async function clearPages<Row>(
  budget: Teardown,
  rows: AsyncIterable<Row>,
  remove: (row: Row) => Promise<boolean>,
): Promise<boolean> {
  if (teardownSpent(budget)) return false
  for await (const row of rows) {
    if (teardownSpent(budget) || !(await remove(row))) return false
    budget.left -= 1
    if (budget.bytes !== undefined) budget.bytes -= estimateDocumentBytes(row)
  }
  return true
}

/** Deletes the rows task `task` still has in the live tables, taking each
 * attachment out of the stored-byte totals of the task and letting go of
 * its file (model/fileHolds.ts releaseFile), then the attachments the
 * organization stores of it, then its messages, their inbox items
 * (model/inboxItems.ts), its comment count and post logs. The caller deletes the task after, so its number is still known for
 * each file. `live` is the task when the caller holds it live, such as one
 * a moving project left behind, whose labels still count it; without it a
 * label assignment's count reads the task (model/labelCounts.ts). */
async function clearLiveRows(
  ctx: MutationCtx,
  orgId: string,
  task: { id: string; num: number },
  budget: Teardown,
  live?: Doc<'issues'>,
): Promise<boolean> {
  for (const relation of TASK_ROWS) {
    const cleared = await clearPages(budget, relation(ctx, task.id), async (row) => {
      await ctx.db.delete(row.doc._id)
      if (row.table === 'issue_attachments') {
        await uncountFile(ctx, row.doc, task.num)
        await releaseFile(ctx, row.doc.storage_id)
      }
      if (row.table === 'issue_labels') await tallyAssignment(ctx, row.doc, -1, live)
      return true
    })
    if (!cleared) return false
  }
  const stored = await clearPages(
    budget,
    ctx.db
      .query('deleted_rows')
      .withIndex('by_table_org_owner', (q) =>
        q.eq('table', 'issue_attachments').eq('org_id', orgId).eq('owner_id', task.id),
      ),
    async (row) => {
      await ctx.db.delete(row._id)
      await uncountStored(ctx, row, task.num)
      await releaseFile(ctx, row.storage_id)
      return true
    },
  )
  if (!stored) return false
  const messages = await clearPages(
    budget,
    ctx.db.query('messages').withIndex('by_issue_read', (q) => q.eq('issue_id', task.id)),
    async (message) => {
      await ctx.db.delete(message._id)
      return true
    },
  )
  if (!messages) return false
  // the inbox items after their messages
  const items = await clearPages(budget, taskItems(ctx, task.id), async (item) => {
    await ctx.db.delete(item._id)
    return true
  })
  if (!items) return false
  // its comment count and post logs, before its stored row frees the id
  for (const table of ['task_comment_counts', 'comment_rates'] as const) {
    const cleared = await clearPages(
      budget,
      ctx.db.query(table).withIndex('by_issue', (q) => q.eq('issue_id', task.id)),
      async (row) => {
        await ctx.db.delete(row._id)
        return true
      },
    )
    if (!cleared) return false
  }
  return true
}

/** Deletes the description rows of task `taskId` (model/descriptions.ts)
 * for a teardown of organization `orgId`'s Deleted items. clearPages
 * charges each row's read, and this its delete's. `own` is the live task
 * the teardown deletes itself. Otherwise the stored task row may be gone,
 * so the rows of a live task that took the id since, and those of another
 * organization, stay (ownDescription). */
async function clearDescriptions(
  ctx: MutationCtx,
  budget: Teardown,
  orgId: string,
  taskId: string,
  own: boolean,
): Promise<boolean> {
  const live = own ? null : await byId(ctx, 'issues', taskId)
  if (live !== null) {
    if (budget.bytes !== undefined) budget.bytes -= estimateDocumentBytes(live)
    return true
  }
  return await clearPages(budget, descriptionRange(ctx, taskId), async (row) => {
    if (!ownDescription(orgId, row)) return true
    if (budget.bytes !== undefined) budget.bytes -= estimateDocumentBytes(row)
    await ctx.db.delete(row._id)
    return true
  })
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
 * in the live tables, and each stored row, a project after the milestones,
 * grants, reach rows and tasks still live under it, so no live row is left
 * to a project that takes its id later. An attachment leaves the
 * stored-byte totals with its row (model/storageTotals.ts), and its file is
 * let go unless another row, live or stored, still names it, and is held
 * for a restore before it is erased (model/fileHolds.ts releaseFile).
 * Nothing is narrated or detached, and the stored tasks' history stays,
 * because the caller deletes the rest of the organization's work, its
 * activity included. Spends at most what `budget` holds, give or
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
    ctx.db.query('deleted_items').withIndex('by_org_deleted', (q) => q.eq('org_id', orgId)),
    async (item) => {
      const waiting = await clearPages(
        budget,
        ctx.db
          .query('deleted_item_parents')
          .withIndex('by_item_task', (q) => q.eq('item_id', item.id)),
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
    ctx.db.query('deleted_tasks').withIndex('by_org_num', (q) => q.eq('org_id', orgId)),
    async (task) => {
      if (!(await clearLiveRows(ctx, orgId, { id: task.task_id, num: task.num }, budget)))
        return false
      if (!(await clearDescriptions(ctx, budget, orgId, task.task_id, false))) return false
      await ctx.db.delete(task._id)
      return true
    },
  )
  if (!tasks) return false
  return await clearPages(
    budget,
    ctx.db.query('deleted_rows').withIndex('by_org', (q) => q.eq('org_id', orgId)),
    async (row) => {
      if (row.table === 'projects') {
        // the milestones and grants a move had not stored yet
        for (const relation of PROJECT_ROWS) {
          const cleared = await clearPages(budget, relation(ctx, row.owner_id), async (live) => {
            await ctx.db.delete(live.doc._id)
            return true
          })
          if (!cleared) return false
        }
        // and its reach rows, which go before the stored row frees its id
        // (model/projectNav.ts)
        const reached = await clearPages(budget, reachOn(ctx, row.owner_id), async (reach) => {
          await ctx.db.delete(reach._id)
          return true
        })
        if (!reached) return false
        const stranded = await clearPages(
          budget,
          ctx.db.query('issues').withIndex('by_project', (q) => q.eq('project_id', row.owner_id)),
          async (task) => {
            if (!(await clearLiveRows(ctx, orgId, task, budget, task))) return false
            if (!(await clearDescriptions(ctx, budget, orgId, task.id, true))) return false
            await deleteLive(ctx, { table: 'issues', doc: task })
            return true
          },
        )
        if (!stranded) return false
      }
      await ctx.db.delete(row._id)
      await uncountStored(ctx, row)
      if (row.storage_id !== undefined) await releaseFile(ctx, row.storage_id)
      return true
    },
  )
}

/* ------------------------------------------------------------- deleting */

/** The reason a delete window sent: trimmed, absent when blank, refused
 * past LIMITS.deleteReason. */
export function cleanReason(raw: string | undefined): string | undefined {
  const reason = limitedText(LIMITS.deleteReason, raw ?? '')
  return reason === '' ? undefined : reason
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

/** How many children of a deleted task one step of detachArchivedChildren
 * detaches, and the share of any of Convex's limits for one transaction it
 * may use before it leaves the rest to the next step. A child is a task
 * row, up to about 120 KB within TEXT_MAX, and each detach also notifies
 * and sends task.updated, whose costs have no fixed bound. Each restart by
 * recoverArchivedDetaches halves the page, down to one child. Tests lower
 * them. */
export const ARCHIVED_DETACH = { page: 100, room: 0.5 }

const detachArchivedRef = makeFunctionReference<
  'mutation',
  { job_id: Id<'archived_detaches'> },
  null
>('deletedItems:detachArchived')

/* Records that the delete of task `parent_id` at `deleted_at` by `actor_id`
 * left archived subtasks, and schedules the first step that detaches them
 * (detachArchivedChildren). */
async function startArchivedDetach(
  ctx: MutationCtx,
  a: { parent_id: string; actor_id: string; deleted_at: string },
): Promise<void> {
  const job_id = await ctx.db.insert('archived_detaches', {
    ...a,
    progress_at: new Date().toISOString(),
    attempts: 0,
  })
  const scheduled_id = await ctx.scheduler.runAfter(0, detachArchivedRef, { job_id })
  await ctx.db.patch(job_id, { scheduled_id })
}

/**
 * One step of detaching the archived subtasks the delete of a task left,
 * which the job `jobId` (archived_detaches) names, a page per step, as the
 * delete detaches its active children: each becomes a top-level task, and
 * its followers read that it left its parent, told in background steps
 * (NotifyPreload.deferFollowers). LIMITS.subtasks.max does not bound archived
 * subtasks, so the delete's own transaction leaves them to these steps.
 * Only subtasks archived by the delete go, so a restore of the parent from
 * Deleted items in the meantime keeps a subtask archived under it later,
 * and the steps go on until the ones the delete left are all detached. A
 * subtask restored from the archive meanwhile leaves its parent as these
 * steps would have made it (model/issues.ts restoreLeavesParent). A step
 * that leaves work saves its progress and schedules the next; the last one
 * deletes the job. A step that fails or stops leaves the job for
 * recoverArchivedDetaches.
 */
export async function detachArchivedChildren(
  ctx: MutationCtx,
  jobId: Id<'archived_detaches'>,
): Promise<void> {
  const job = await ctx.db.get(jobId)
  if (job === null) return
  const page = Math.max(1, Math.floor(ARCHIVED_DETACH.page / 2 ** job.attempts))
  const kids = await ctx.db
    .query('issues')
    .withIndex('by_parent_archived', (q) =>
      q.eq('parent_id', job.parent_id).gt('archived_at', '').lte('archived_at', job.deleted_at),
    )
    .take(page)
  const actor = (await byId(ctx, 'profiles', job.actor_id)) ?? undefined
  const preload: NotifyPreload = { ...newNotifyPreload(), deferFollowers: true }
  let detached = 0
  for (const kid of kids) {
    // a detached row leaves the range, so the next step needs no cursor
    if (detached > 0 && (await usedMoreThan(ctx, ARCHIVED_DETACH.room))) break
    await detachChild(ctx, kid, actor, job.deleted_at, preload)
    detached += 1
  }
  if (detached < kids.length || kids.length === page) {
    const scheduled_id = await ctx.scheduler.runAfter(0, detachArchivedRef, { job_id: job._id })
    await ctx.db.patch(job._id, {
      progress_at: new Date().toISOString(),
      scheduled_id,
      attempts: 0,
    })
  } else await ctx.db.delete(job._id)
}

/** Restarts the detach steps (detachArchivedChildren) whose last step
 * committed more than STALLED_MS ago and whose next step neither waits nor
 * runs, because it failed or stopped. Each restart halves the step's page
 * until a step commits, so a step too large for one transaction gets
 * smaller; at one subtask a step keeps being restarted. */
export async function recoverArchivedDetaches(ctx: MutationCtx): Promise<void> {
  const now = Date.now()
  const stalled = await ctx.db
    .query('archived_detaches')
    .withIndex('by_progress', (q) => q.lt('progress_at', new Date(now - STALLED_MS).toISOString()))
    .take(RECOVER_SCAN)
  let restarted = 0
  for (const job of stalled) {
    if (restarted === RECOVER_BATCH) break
    const next = job.scheduled_id === undefined ? null : await ctx.db.system.get(job.scheduled_id)
    if (next?.state.kind === 'pending' || next?.state.kind === 'inProgress') continue
    restarted += 1
    const scheduled_id = await ctx.scheduler.runAfter(0, detachArchivedRef, { job_id: job._id })
    await ctx.db.patch(job._id, {
      progress_at: new Date(now).toISOString(),
      scheduled_id,
      attempts: job.attempts + 1,
    })
    console.warn('Detaching the archived subtasks of a deleted task resumed', {
      parent_id: job.parent_id,
      attempts: job.attempts + 1,
    })
  }
}

/**
 * Moves task `root` and the chosen `subtasks`, its direct subtasks,
 * to Deleted items as one task item, as the app's, REST and MCP
 * deletes do. The callers check access and the subtask choice; each task's
 * Edit check is repeated here as defense in depth (model/issues.ts
 * assertCanEdit). In this transaction, for each task: its active children
 * outside the item are detached (the SET NULL's touch and task.updated, and
 * 'Detached from its parent' for their followers from background steps,
 * NotifyPreload.deferFollowers), and its archived ones in steps just after
 * (detachArchivedChildren), task.deleted is emitted, the task row is stored
 * and the 'deleted' activity row written as before, its detail the machine
 * `provenance`. A child inside the item keeps its parent, and a task that
 * still waits for its parent after a project item's restore is stored with
 * it (takeParent). A Done parent of the root may have waited for it alone,
 * so the next nightly archive checks the parent's project
 * (model/archiveRechecks.ts recheckParent). `children` are the root's
 * active children when the caller read them in this transaction, so they
 * are not read twice. The
 * tasks are then hidden; their messages and other rows follow within the
 * same budget, and steps take the rest (moveDrain). A task too large to
 * store goes in cut to the caps (fitToStore). Returns the item.
 */
export async function moveTasksToTrash(
  ctx: MutationCtx,
  a: Deletion & {
    root: Doc<'issues'>
    children?: Doc<'issues'>[]
    subtasks: Doc<'issues'>[]
    provenance?: string
  },
): Promise<Item> {
  const { actor, now } = a
  const budget = budgetFor(CALL.scale)
  const counted = metered(ctx, budget)
  // the caller read them, and the steps' reads come on top
  for (const task of [...a.subtasks, a.root]) chargeRead(budget, task)
  // each task as it is stored (model/descriptions.ts withDescription),
  // which reads no description row while the task row holds the text; the
  // steps delete the rows (moveDrain)
  const described = async (task: Doc<'issues'>) => {
    const { task: doc, row } = await withDescription(counted.db, task)
    if (row !== null) chargeRead(budget, row)
    return doc
  }
  const root = await described(a.root)
  const subtasks: Doc<'issues'>[] = []
  for (const task of a.subtasks) subtasks.push(await described(task))
  const tasks = [...subtasks, root]
  // Only the root can have a parent outside the item, which stays live and
  // may have waited for the root alone (model/archiveRechecks.ts).
  const above = await recheckParent(counted, a.root)
  if (above !== null) chargeRead(budget, above)
  const doomed = new Set(tasks.map((task) => task.id))
  const id = newUuid()
  const project = await liveProject(counted, root.project_id)
  const top =
    project.parent_id === undefined ? null : await byId(counted, 'projects', project.parent_id)
  const projects: Item['projects'] = []
  for (const task of [root, ...subtasks]) {
    if (projects.some((p) => p.id === task.project_id)) continue
    const p = task.project_id === project.id ? project : await liveProject(counted, task.project_id)
    projects.push({ id: p.id, name: p.name, key: p.key, type: p.type, tasks: 0, archived_tasks: 0 })
  }
  const item = await insertItem(counted, a, id, {
    kind: 'task',
    target_id: root.id,
    num: root.num,
    // as the root is stored, without logging the cut a second time
    name: tooLarge({ id, org_id: actor.org_id }, { table: 'issues', doc: root }, root.id)
      ? cutToCaps(root).title
      : root.title,
    status: root.status,
    archived: root.archived_at !== undefined,
    project_id: project.id,
    parent_project_id: top?.id,
    path: top === null ? [project.name] : [top.name, project.name],
    projects,
    counts: {
      tasks: tasks.length,
      archived_tasks: tasks.filter((task) => task.archived_at !== undefined).length,
      subtasks: subtasks.length,
      sub_projects: 0,
    },
  })
  const tally = emptyTally(item)
  // This transaction changes no profile, project, grant or team, so one
  // preload, read at the first detach, serves every detach notice
  // (NotifyPreload). Without it each notice reads every profile again. It
  // leaves the followers to background steps, because up to LIMITS.subtasks.max
  // children with FOLLOWER_FANOUT.inline followers each would pass the
  // transaction's limits.
  let preload: NotifyPreload | undefined
  // the tasks of a family share few projects, so each is checked once
  const editable = new Set<string>()
  for (const task of tasks) {
    if (!editable.has(task.project_id)) {
      await assertCanEdit(counted, actor, task.project_id)
      editable.add(task.project_id)
    }
    // A subtask has no subtasks of its own, so only a top-level task has
    // children to leave behind. The active ones, at most LIMITS.subtasks.max, are
    // detached here, and the archived ones, which have no bound, in
    // background steps.
    if (task.parent_id === undefined) {
      const kids =
        task === root && a.children !== undefined
          ? a.children
          : await counted.db
              .query('issues')
              .withIndex('by_parent_archived', (q) =>
                q.eq('parent_id', task.id).eq('archived_at', undefined),
              )
              .take(LIMITS.subtasks.max)
      for (const kid of kids) {
        chargeRead(budget, kid)
        if (doomed.has(kid.id)) continue
        preload ??= { ...newNotifyPreload(), deferFollowers: true }
        await detachChild(counted, kid, actor, now, preload)
      }
      const archivedKid = await counted.db
        .query('issues')
        .withIndex('by_parent_archived', (q) => q.eq('parent_id', task.id).gt('archived_at', ''))
        .first()
      if (archivedKid !== null) {
        await startArchivedDetach(ctx, { parent_id: task.id, actor_id: actor.id, deleted_at: now })
      }
    }
    await emitTaskEvent(counted, { name: 'task.deleted', issue: task, actor, now })
    const stored = await storeTask(
      counted,
      item,
      tally,
      fitToStore(item, { ...task, parent_id: await takeParent(counted, task, item) }),
    )
    // a task too large to store is gone for good, and no step visits it
    if (!stored) await dropTaskDescription(counted, budget, task.id)
    await insertActivity(counted, {
      org_id: task.org_id,
      actor_id: actor.id,
      verb: 'deleted',
      target_type: 'issue',
      target_id: task.id,
      label: task.title,
      detail: a.provenance,
      project_id: task.project_id,
      ts: now,
      named_task_nums: [],
    })
  }
  // the work above counts as progress, so a budget it has spent, the bytes
  // of large tasks included, stops the drain at once and leaves it to steps
  budget.moved = true
  await startJob(ctx, item, { phase: 'move_drain', tally }, budget)
  return item
}

/** `task` as a task item stores it. Only a task stored before the caps can
 * be too large to store (STORED_ROW_MAX_BYTES), because a LIMITS.title title
 * and a TEXT_MAX description are at most about 120 KB as
 * estimateDocumentBytes counts them. Such a task goes in with its title and
 * description cut to those limits, so its rows and messages follow
 * in steps and it comes back as the others do, and that is logged with the
 * item id. */
function fitToStore(item: Pick<Item, 'id' | 'org_id'>, task: Doc<'issues'>): Doc<'issues'> {
  if (!tooLarge(item, { table: 'issues', doc: task }, task.id)) return task
  console.error('A deleted item cut a task too large to store', {
    item_id: item.id,
    task_id: task.id,
  })
  return cutToCaps(task)
}

/** `task` with its title cut to LIMITS.title and its description to
 * TEXT_MAX UTF-16 units, neither cut splitting a surrogate pair. */
function cutToCaps(task: Doc<'issues'>): Doc<'issues'> {
  return {
    ...task,
    title: cutText(task.title, LIMITS.title.max),
    description: cutText(task.description ?? '', TEXT_MAX),
  }
}

/**
 * Moves `project` with its sub-projects, archived ones included, and every
 * task in them to Deleted items as one project item. The caller checks Lead
 * and writes the 'deleted' activity row. A project with more than
 * LIMITS.projectDeleteSubProjects.max sub-projects is refused. This transaction stores
 * the project rows, which hides the projects and so every task, milestone,
 * grant and team grant in them; those then move within the same budget and
 * in steps (moveEdges, moveProjectTasks). The budget is a quarter of a
 * person's call's share (CALL), because moveEdges reads two ranges for
 * each open task: with a quarter of a step's budget, a delete of a
 * sub-project with 5,000 tasks read 684 ranges and failed on a busy local
 * backend. Tasks of the item emit no
 * task.deleted; children in surviving projects are detached with
 * task.updated. Returns the item.
 */
export async function moveProjectToTrash(
  ctx: MutationCtx,
  a: Deletion & { project: Doc<'projects'> },
): Promise<Item> {
  const { project } = a
  const budget = budgetFor(CALL.scale / 4)
  const counted = metered(ctx, budget)
  const subs = await counted.db
    .query('projects')
    .withIndex('by_parent', (q) => q.eq('parent_id', project.id))
    .take(LIMITS.projectDeleteSubProjects.max + 1)
  if (subs.length > LIMITS.projectDeleteSubProjects.max)
    throw rule(LIMITS.projectDeleteSubProjects.refusal)
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
  for (const p of doomed) {
    if (!(await storeRow(counted, item, { table: 'projects', doc: p }, p.id)))
      tally.dropped_rows += 1
    charge(budget, p)
  }
  await startJob(ctx, item, { phase: 'move_edges', tally }, budget)
  return item
}

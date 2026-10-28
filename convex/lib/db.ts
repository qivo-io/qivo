/* Uuid-key lookup, the race-free unique insert, the used_ids record of every
 * task and project id, the room check of bulk writers and window keys.
 * Serializable mutations make check-then-insert safe: two concurrent
 * insertUnique calls on the same key conflict and one retries, re-running
 * the check. So do two inserts of one task or project id by any path, in
 * one organization or two, since each reads the used_ids range of the id
 * that the other writes its row into (claimId). */

import type {
  GenericDatabaseReader,
  GenericDatabaseWriter,
  IndexRange,
  QueryMeta,
  WithoutSystemFields,
} from 'convex/server'
import type { ConvexError, Value } from 'convex/values'
import type { DataModel, Doc, Id, TableNames } from '../_generated/dataModel'
import { uncountedWriter } from './demo'
import { isStoredTable, isUsedIdTable, type UsedIdTable } from './enums'
import { badRequest, type Refusal } from './functions'

/* Tables that declare .index('by_uuid', ['id']) — the app-key tables.
 * Pure join/platform tables (team_members, user_prefs, …) are excluded
 * by construction. */
export type UuidTables = {
  [T in TableNames]: 'by_uuid' extends keyof DataModel[T]['indexes'] ? T : never
}[TableNames]

type ReaderCtx = { db: GenericDatabaseReader<DataModel> }
type WriterCtx = { db: GenericDatabaseWriter<DataModel> }

/** Whether the transaction has used more than the share `room` of any of
 * Convex's limits for one transaction, as the deployment reports them
 * (ctx.meta.getTransactionMetrics). A bulk writer whose items have no fixed
 * cost checks it before each one, and stops or refuses once it is true. */
export async function usedMoreThan(
  ctx: { meta: Pick<QueryMeta, 'getTransactionMetrics'> },
  room: number,
): Promise<boolean> {
  const metrics = await ctx.meta.getTransactionMetrics()
  return Object.values(metrics).some(({ used, remaining }) => used > (used + remaining) * room)
}

/* Look up a row by its application uuid through the table's by_uuid index. */
export function byId<T extends UuidTables>(
  ctx: ReaderCtx,
  table: T,
  uuid: string,
): Promise<Doc<T> | null>
export async function byId(
  ctx: ReaderCtx,
  table: UuidTables,
  uuid: string,
): Promise<Doc<UuidTables> | null> {
  return await ctx.db
    .query(table)
    .withIndex('by_uuid', (q) => q.eq('id', uuid))
    .unique()
}

/* The form of crypto.randomUUID: lowercase hex in 8-4-4-4-12 groups. */
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The refusal of a new row id that is not a lowercase UUID. */
export const ROW_ID_SHAPE =
  'an id must be a lowercase UUID, such as 0b7d6f4e-1c2a-4d3b-9e8f-7a6b5c4d3e2f'

/** Refuses the id a client chose for a new row unless it is a lowercase
 * UUID, the form the app generates. REST and MCP lowercase an id before
 * they look it up, so a row stored under any other string could not be
 * found by id. Every create that takes the caller's id checks it. */
export function assertNewRowId(id: string): void {
  if (!ROW_ID.test(id)) throw badRequest(ROW_ID_SHAPE)
}

declare const crypto: { randomUUID(): string }

/** A new window key for a task or project: 8 random hex digits, the point
 * of lib/idWindows.ts's space that places the row in the app's windows
 * (lib/workspaceParts.ts). The server picks it, never the writer, so no
 * writer can crowd its rows into one window, which could then not load.
 * Every insert of a task or project sets it. */
export const newWindowKey = (): string => crypto.randomUUID().slice(0, 8)

/** The relation rows of task `id` (label assignments, attachments, the
 * links from it and follows) whose task_key is not `key`, every one for null
 * (a task about to get its first key). Whoever gives a task a key gives
 * these rows the same one (schema.ts taskKey). */
export async function strayRows(ctx: ReaderCtx, id: string, key: string | null) {
  const [labels, attachments, links, follows] = await Promise.all([
    ctx.db
      .query('issue_labels')
      .withIndex('by_issue', (q) => q.eq('issue_id', id))
      .collect(),
    ctx.db
      .query('issue_attachments')
      .withIndex('by_issue', (q) => q.eq('issue_id', id))
      .collect(),
    ctx.db
      .query('issue_links')
      .withIndex('by_source', (q) => q.eq('source_id', id))
      .collect(),
    ctx.db
      .query('issue_subscriptions')
      .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', id))
      .collect(),
  ])
  return [...labels, ...attachments, ...links, ...follows].filter(
    (row) => key === null || row.task_key !== key,
  )
}

/* Chainable eq shape shared by every IndexRangeBuilder — the generic index
 * types can't be threaded through a runtime field list, so the builder is
 * driven through this erased view. */
type EqChain = { eq: (field: string, value: Value | undefined) => EqChain }

/* Insert doc unless a row already matches keyFields on the named index; on a
 * match, throw err instead. keyFields' entries MUST follow the index's declared
 * field order (the runtime builder refuses out-of-order eq chains). A uuid of a
 * table that Deleted items stores (lib/enums.ts STORED_TABLES) is also taken
 * while a deleted_rows row holds it, so a restore never meets a new row with
 * its id; the refusal is the same err. A task or project also writes the
 * used_ids row of its id, and an id that used_ids holds already is refused
 * with err too (claimId). */
export async function insertUnique<T extends TableNames>(
  ctx: WriterCtx,
  table: T,
  indexName: Extract<keyof DataModel[T]['indexes'], string>,
  keyFields: Record<string, Value | undefined>,
  doc: WithoutSystemFields<Doc<T>>,
  err: ConvexError<Refusal>,
): Promise<Id<T>> {
  const existing = await ctx.db
    .query(table)
    .withIndex(indexName, (q) => {
      let range = q as unknown as EqChain
      for (const [field, value] of Object.entries(keyFields)) {
        range = range.eq(field, value)
      }
      return range as unknown as IndexRange
    })
    .first()
  if (existing !== null) throw err
  if (indexName === 'by_uuid' && isStoredTable(table) && typeof keyFields.id === 'string') {
    const id = keyFields.id
    const held = await ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) => q.eq('table', table).eq('row_id', id))
      .first()
    if (held !== null) throw err
  }
  // a task's and a project's row both hold its id and organization
  if (isUsedIdTable(table)) await claimId(ctx.db, table, doc as unknown as Owner, err)
  return await ctx.db.insert(table, doc)
}

/* ------------------------------------------------------------- used ids */

/** The id and organization of a task or project, which its used_ids row
 * records. */
type Owner = { id: string; org_id: string }

/** The used_ids row (schema.ts) of the id `id` of `table` that organization
 * `orgId` holds, or with `orgId` left out any organization's, or null. One
 * index range. */
export async function usedIdRow(
  ctx: ReaderCtx,
  table: UsedIdTable,
  id: string,
  orgId?: string,
): Promise<Doc<'used_ids'> | null> {
  return await ctx.db
    .query('used_ids')
    .withIndex('by_row', (q) => {
      const row = q.eq('table', table).eq('row_id', id)
      return orgId === undefined ? row : row.eq('org_id', orgId)
    })
    .first()
}

/** Writes the used_ids row of new task or project `owner`, refusing with
 * `err` an id that any organization's row holds already. In a public demo
 * the row spends none of the visitor's record limit (lib/demo.ts
 * uncountedWriter), as it is part of its task or project, which counts. */
async function claimId(
  db: GenericDatabaseWriter<DataModel>,
  table: UsedIdTable,
  owner: Owner,
  err: ConvexError<Refusal>,
): Promise<void> {
  if ((await usedIdRow({ db }, table, owner.id)) !== null) throw err
  await uncountedWriter(db).insert('used_ids', {
    table,
    row_id: owner.id,
    org_id: owner.org_id,
  })
}

/** Writes the used_ids row of the id `id` of `table` for organization
 * `orgId` unless that organization holds one, and answers whether it wrote.
 * For a restore from Deleted items, whose task or project may have been
 * stored before used_ids had its row, and for internal/usedIdsBackfill.
 * Reads one index range. */
export async function keepUsedId(
  db: GenericDatabaseWriter<DataModel>,
  table: UsedIdTable,
  id: string,
  orgId: string,
): Promise<boolean> {
  if ((await usedIdRow({ db }, table, id, orgId)) !== null) return false
  await uncountedWriter(db).insert('used_ids', { table, row_id: id, org_id: orgId })
  return true
}

/** How insertUsed takes the id of the task or project it inserts: a
 * refusal, which meets an id that any organization's used_ids row holds,
 * for an id the server chose; or 'restore', for a row Deleted items writes
 * back, which keeps the row its id has or writes one (keepUsedId). */
export type IdClaim = ConvexError<Refusal> | 'restore'

/** Inserts task or project `doc` with the used_ids row of its id, in one
 * transaction, for an id the server chose (seeds and fixtures) or a restore
 * (`claim`). It reads one index range. Every other insert of a task or
 * project, one whose id a caller chose, goes through insertUnique, which
 * also refuses an id a live row or Deleted items holds. Nothing else
 * inserts tasks or projects (scripts/check-task-writes.mjs). */
export async function insertUsed<T extends UsedIdTable>(
  db: GenericDatabaseWriter<DataModel>,
  table: T,
  doc: WithoutSystemFields<Doc<T>>,
  claim: IdClaim,
): Promise<Id<T>> {
  const owner = doc as unknown as Owner
  if (claim === 'restore') await keepUsedId(db, table, owner.id, owner.org_id)
  else await claimId(db, table, owner, claim)
  return await db.insert(table, doc)
}

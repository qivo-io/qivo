/* Uuid-key lookup, the race-free unique insert and the room check of bulk
 * writers. Serializable mutations make check-then-insert safe: two
 * concurrent insertUnique calls on the same key conflict and one retries,
 * re-running the check. */

import type {
  GenericDatabaseReader,
  GenericDatabaseWriter,
  IndexRange,
  QueryMeta,
  WithoutSystemFields,
} from 'convex/server'
import type { ConvexError, Value } from 'convex/values'
import type { DataModel, Doc, Id, TableNames } from '../_generated/dataModel'
import { isStoredTable } from './enums'
import { badRequest, type Refusal } from './functions'

/* Comments and tasks can approach Convex's 1 MiB document limit, so their
 * ranges are read a few rows at a time. Unused rows of the last read then
 * add at most three such documents to what a transaction reads. */
export const LARGE_ROWS_PER_READ = 4

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

/* Chainable eq shape shared by every IndexRangeBuilder — the generic index
 * types can't be threaded through a runtime field list, so the builder is
 * driven through this erased view. */
type EqChain = { eq: (field: string, value: Value | undefined) => EqChain }

/* Insert doc unless a row already matches keyFields on the named index; on a
 * match, throw err instead. keyFields' entries MUST follow the index's declared
 * field order (the runtime builder refuses out-of-order eq chains). A uuid of a
 * table that Deleted items stores (lib/enums.ts STORED_TABLES) is also taken
 * while a deleted_rows row holds it, so a restore never meets a new row with
 * its id; the refusal is the same err. */
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
  return await ctx.db.insert(table, doc)
}

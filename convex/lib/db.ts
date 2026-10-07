/* Uuid-key lookup and the race-free unique insert. Serializable mutations
 * make check-then-insert safe: two
 * concurrent insertUnique calls on the same key conflict and one retries,
 * re-running the check. */

import type {
  GenericDatabaseReader,
  GenericDatabaseWriter,
  IndexRange,
  WithoutSystemFields,
} from 'convex/server'
import type { ConvexError, Value } from 'convex/values'
import type { DataModel, Doc, Id, TableNames } from '../_generated/dataModel'
import type { Refusal } from './functions'

/* Tables that declare .index('by_uuid', ['id']) — the app-key tables.
 * Pure join/platform tables (team_members, user_prefs, …) are excluded
 * by construction. */
export type UuidTables = {
  [T in TableNames]: 'by_uuid' extends keyof DataModel[T]['indexes'] ? T : never
}[TableNames]

type ReaderCtx = { db: GenericDatabaseReader<DataModel> }
type WriterCtx = { db: GenericDatabaseWriter<DataModel> }

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

/* Chainable eq shape shared by every IndexRangeBuilder — the generic index
 * types can't be threaded through a runtime field list, so the builder is
 * driven through this erased view. */
type EqChain = { eq: (field: string, value: Value | undefined) => EqChain }

/* Insert doc unless a row already matches keyFields on the named index; on a
 * match, throw err instead. keyFields' entries MUST follow the index's declared
 * field order (the runtime builder refuses out-of-order eq chains). */
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
  return await ctx.db.insert(table, doc)
}

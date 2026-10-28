/* Uuid-key lookup, the race-free unique insert, the room check of bulk
 * writers and window keys. Serializable mutations make check-then-insert
 * safe: two concurrent insertUnique calls on the same key conflict and one
 * retries, re-running the check. */

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
 * its id, and a task's or project's uuid while its stored-byte totals row
 * holds it (model/storageTotals.ts), which can outlive its stored copy until
 * a purge deletes its last file, so a new task or project in any
 * organization never takes over those totals. The refusal is the same err. */
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
  if (indexName === 'by_uuid' && typeof keyFields.id === 'string') {
    const id = keyFields.id
    const totals =
      table === 'issues'
        ? await ctx.db
            .query('storage_task_totals')
            .withIndex('by_issue', (q) => q.eq('issue_id', id))
            .first()
        : table === 'projects'
          ? await ctx.db
              .query('storage_project_totals')
              .withIndex('by_project', (q) => q.eq('project_id', id))
              .first()
          : null
    if (totals !== null) throw err
  }
  return await ctx.db.insert(table, doc)
}

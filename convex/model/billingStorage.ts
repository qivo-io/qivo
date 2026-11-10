/* Billing's Storage by project list (billing.storageProjects): the
 * organization's projects with counted task files, a batch of LIST_BATCH at
 * a time, largest first, from the stored-byte totals
 * (storage_project_totals by_org_bytes, model/storageTotals.ts), never from
 * the attachment rows. Every project the totals hold is listed, active,
 * archived, in Deleted items or removed for good while files of its tasks
 * still count, so the rows add up to the organization's current storage.
 *
 * The list reads through the shared name-ordered reader
 * (lib/namedPages.ts) in descending order, with a constant key '' and the
 * tie [bytes, _creationTime, _id], the fields the index orders a row by
 * after its organization, so equal bytes come newest row first. A cursor
 * is sealed to the list, the organization and the search's name key, and
 * the batch reads under a read share (STORAGE_PROJECTS) and answers
 * `stopped` where the share ended it.
 *
 * Bytes change while an admin browses, and nothing freezes a snapshot (the
 * owner, 31 October 2026). A project whose bytes cross the cursor between
 * two batches can be missed until the list starts again, or answered
 * twice, which the app shows once. The organization's total never depends
 * on the rows loaded.
 *
 * Nothing subscribes to it. The app reads each batch once (convex.query),
 * so attaches, moves and purges rerun nothing. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { ReadCeiling } from '../lib/archivedTasks'
import type { StorageProjectRow, StorageProjects } from '../lib/billingTypes'
import { byId } from '../lib/db'
import { badRequest } from '../lib/functions'
import { limitedText } from '../lib/limitRules'
import { LIMITS, LIST_BATCH } from '../lib/limits'
import {
  indexAfter,
  listBatch,
  NAMED_READ,
  type NamedAt,
  type NamedIndex,
  namedCeiling,
  openNamedCursor,
  type ReadGuard,
} from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { allWordsMatcher } from '../lib/search'
import { storageTotalsOf } from './storageTotals'

/** What one batch of Storage by project may read, past what the call read
 * before it: NAMED_READ's share, 2,000 index ranges, 8,000 documents and
 * 4 MiB. A totals row holds two uuids, a number, a name of at most 80
 * characters and two counts, about 290 bytes as Convex counts a row with
 * an 80-character name. At the design size an organization holds up to
 * 1,500 such rows (500 live and 1,000 archived sub-projects, summed
 * because one read covers both), about 0.43 MB in at most three index
 * ranges, and a kept row adds at most two lookups, so even a search that
 * matches only the smallest row answers in one call.
 * convex/tests/billingStorage.test.ts ("reads at the design size") logs
 * what the reader alone reads, without the caller's seat check, for a
 * first batch whose 25 rows are all in Deleted items and for a search that
 * matches only the smallest of the 1,500 rows. Past the share
 * the batch answers `stopped` and Load more goes on. Tests lower it. */
export const STORAGE_PROJECTS: { reads: ReadCeiling } = { reads: { ...NAMED_READ } }

/** The list's name, which seals its cursors (lib/namedPages.ts namedCursor). */
export const STORAGE_PROJECTS_LIST = 'billing.storageProjects'

/** The refusal of a cursor that is not one of this list for the same
 * search. */
export const NOT_STORAGE_CURSOR =
  'cursor must come from an earlier answer of Storage by project, with the same search; start the list again'

/** The tie of a Storage by project position: the row's bytes, then its
 * _creationTime and _id, the fields by_org_bytes orders a row by after its
 * organization. */
type BytesTie = readonly [bytes: number, created: number, id: string]

/* The position of totals row `row`. */
const bytesAt = (row: Doc<'storage_project_totals'>): NamedAt<BytesTie> => ({
  key: '',
  tie: [row.bytes, row._creationTime, row._id],
})

/* A Storage by project position's tie, or null for any other shape. */
function bytesTieOf(at: NamedAt): BytesTie | null {
  const [bytes, created, id] = at.tie
  return at.key === '' &&
    at.tie.length === 3 &&
    typeof bytes === 'number' &&
    typeof created === 'number' &&
    typeof id === 'string'
    ? [bytes, created, id]
    : null
}

/** The project totals rows of organization `orgId`, largest first
 * (storage_project_totals by_org_bytes read descending), equal bytes newest
 * row first. After a position it reads the rest of its instant at its
 * bytes, leaving out the rows not past it (lib/namedPages.ts indexAfter),
 * the rest of its bytes, then every smaller figure. */
function bytesIndex(
  ctx: QueryCtx,
  orgId: string,
): NamedIndex<Doc<'storage_project_totals'>, BytesTie> {
  const rows = () => ctx.db.query('storage_project_totals')
  return {
    all: () =>
      rows()
        .withIndex('by_org_bytes', (q) => q.eq('org_id', orgId))
        .order('desc'),
    after: ({ tie: [bytes, created] }) => [
      () =>
        rows()
          .withIndex('by_org_bytes', (q) =>
            q.eq('org_id', orgId).eq('bytes', bytes).eq('_creationTime', created),
          )
          .order('desc'),
      () =>
        rows()
          .withIndex('by_org_bytes', (q) =>
            q.eq('org_id', orgId).eq('bytes', bytes).lt('_creationTime', created),
          )
          .order('desc'),
      () =>
        rows()
          .withIndex('by_org_bytes', (q) => q.eq('org_id', orgId).lt('bytes', bytes))
          .order('desc'),
    ],
    at: bytesAt,
  }
}

/**
 * Totals row `row` of organization `orgId` as the list answers it, with
 * where its project is now, counting its lookups with `guard`. The live
 * project counts only when it belongs to the organization and has the
 * row's number, else the copy Deleted items stores of the same
 * organization and number; neither makes it removed, and so does a row
 * without a number. The number check is what keeps a row from taking the
 * name and state of another project, since uuids freed before used_ids
 * existed stay reusable and a later project can hold a row's id. At most two
 * lookups. The name is the live project's, else the stored copy's, else
 * the row's own copy.
 */
async function rowOf(
  ctx: QueryCtx,
  guard: ReadGuard,
  orgId: string,
  row: Doc<'storage_project_totals'>,
): Promise<StorageProjectRow> {
  const base = {
    project_id: row.project_id,
    num: row.num ?? null,
    bytes: row.bytes,
    files: row.files,
  }
  const removed: StorageProjectRow = {
    ...base,
    key: null,
    name: row.name ?? null,
    status: 'removed',
  }
  if (row.num === undefined) return removed
  const live = await guard.lookup(() => byId(ctx, 'projects', row.project_id))
  if (live?.org_id === orgId && live.num === row.num)
    return {
      ...base,
      key: live.key,
      name: live.name,
      status: live.archived_at === undefined ? 'active' : 'archived',
    }
  // insertUnique refuses an id that a stored copy holds, so one copy at most
  const stored = await guard.lookup(() =>
    ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) => q.eq('table', 'projects').eq('row_id', row.project_id))
      .first(),
  )
  if (stored?.org_id === orgId && stored.row.table === 'projects' && stored.row.doc.num === row.num)
    return { ...base, key: stored.row.doc.key, name: stored.row.doc.name, status: 'deleted' }
  return removed
}

/**
 * One batch of Storage by project for organization `orgId` (the caller's,
 * never the cursor's), after `a.cursor` or from the start, matching
 * `a.search` when given. Refuses a search longer than LIMITS.search and a
 * cursor that is not this list's for the same organization and search.
 * Answers `counting` while the organization's totals are not complete,
 * before it reads any project row, since a counting organization's rows
 * are incomplete; never a partial list as a whole one. A search keeps the
 * rows whose stored name holds every whitespace-separated fragment of it,
 * ignoring case and accents, and a row without a name matches none. Reads
 * no task, file or comment.
 */
export async function storageProjectsBatch(
  ctx: QueryCtx,
  orgId: string,
  a: { search?: string; cursor?: string },
): Promise<StorageProjects> {
  const search = limitedText(LIMITS.search, a.search ?? '')
  const scope = [orgId, nameKey(search)]
  let after: NamedAt<BytesTie> | null = null
  if (a.cursor !== undefined) {
    const at = await openNamedCursor(a.cursor, STORAGE_PROJECTS_LIST, scope)
    const tie = at === null ? null : bytesTieOf(at)
    if (tie === null) throw badRequest(NOT_STORAGE_CURSOR)
    after = { key: '', tie }
  }
  if ((await storageTotalsOf(ctx, orgId)) === null) return { state: 'counting' }
  const matches = allWordsMatcher(nameKey(search))
  const batch = await listBatch(
    ctx,
    { list: STORAGE_PROJECTS_LIST, scope, after, through: null },
    {
      stream: indexAfter(bytesIndex(ctx, orgId), after, 'desc'),
      keep: async (row: Doc<'storage_project_totals'>, guard: ReadGuard) => {
        if (search !== '' && (row.name === undefined || !matches(nameKey(row.name)))) return null
        return await rowOf(ctx, guard, orgId, row)
      },
      limit: LIST_BATCH,
      ceiling: await namedCeiling(ctx, STORAGE_PROJECTS.reads),
      order: 'desc',
    },
  )
  return { state: 'ready', ...batch }
}

/* Lets go of the ids an organization's tasks and projects held (schema.ts
 * used_ids) at the end of its teardown, the one place used_ids rows are
 * deleted. Every teardown calls it once nothing else of the organization is
 * left: organization deletion in steps (model/orgDeletion.ts deleteOrgStep)
 * and deleteOrgDeep (model/cascade.ts) after the organization row, the
 * public demo's cleanup (internal/demoCleanup.ts) after it too, and the
 * Northstar wipe (model/orgDeletion.ts wipeWorkStep), which keeps the
 * organization, after its tasks and projects.
 *
 * An id that something outside the organization still names stays retired
 * (heldOutside): the row is marked `kept`, which takes it out of the range
 * a teardown reads first, so a later step never reads it there again and
 * each step makes progress. A later teardown of the same organization, the
 * next Northstar wipe or guest fixture rebuild, looks at its kept rows again
 * once the others are gone and deletes those nothing names any more. */

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { type Teardown, teardownSpent } from './deletedItems'
import { estimateDocumentBytes } from './demoMetrics'

/** The index ranges heldOutside reads for a row of each table. */
const HOLDER_READS = { issues: 3, projects: 2 } as const

/** What still names the id of used_ids row `row` once its organization's
 * rows are gone, each read in one index range (HOLDER_READS): a live task
 * or project with the id, or a Deleted items copy of one, in another
 * organization, which only an earlier release writes after a rollback, and
 * which keeps the id until internal/usedIdsBackfill gives it a row of its
 * own; and for a task a pending detach of its archived subtasks
 * (schema.ts archived_detaches), which has no organization and runs on
 * after it. Answers the rows it found. */
async function heldOutside(ctx: QueryCtx, row: Doc<'used_ids'>): Promise<object[]> {
  const id = row.row_id
  const found = [
    await byId(ctx, row.table, id),
    await ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) => q.eq('table', row.table).eq('row_id', id))
      .first(),
    row.table === 'issues'
      ? await ctx.db
          .query('archived_detaches')
          .withIndex('by_parent', (q) => q.eq('parent_id', id))
          .first()
      : null,
  ]
  return found.filter((doc) => doc !== null)
}

/** Reads the rows of organization `orgId` that are kept or not, one index
 * range in one pass, deletes each whose id nothing outside names
 * (heldOutside), and marks a row it does not delete kept, until the range
 * ends (true) or `budget` is spent (false). Each row counts as one of
 * `budget`'s rows for itself and one for each index range heldOutside
 * reads, and its bytes count with those of what heldOutside found. */
async function pass(
  ctx: MutationCtx,
  orgId: string,
  kept: true | undefined,
  budget: Teardown,
): Promise<boolean> {
  if (teardownSpent(budget)) return false
  const rows = ctx.db
    .query('used_ids')
    .withIndex('by_org_kept', (q) => q.eq('org_id', orgId).eq('kept', kept))
  for await (const row of rows) {
    const holders = await heldOutside(ctx, row)
    if (holders.length === 0) await ctx.db.delete(row._id)
    else if (kept === undefined) await ctx.db.patch(row._id, { kept: true })
    budget.left -= 1 + HOLDER_READS[row.table]
    if (budget.bytes !== undefined)
      for (const doc of [row, ...holders]) budget.bytes -= estimateDocumentBytes(doc)
    if (teardownSpent(budget)) return false
  }
  return true
}

/** Deletes organization `orgId`'s used_ids rows until they are gone (true)
 * or `budget` is spent (false), keeping each whose id something outside the
 * organization still names (heldOutside). A budget not yet spent handles at
 * least one row, and reads no more index ranges than it has rows. Each row
 * leaves the range it is read in, deleted or marked kept, as the next step
 * reads that range from its start again. Once the others are gone it looks
 * at the rows kept before, in what the budget has left, and deletes those
 * nothing names any more; one still named stays, so this pass never holds
 * the teardown back. The caller runs it once every other row of the
 * organization is gone, its tasks and projects in Deleted items included. */
export async function releaseUsedIds(
  ctx: MutationCtx,
  orgId: string,
  budget: Teardown,
): Promise<boolean> {
  if (!(await pass(ctx, orgId, undefined, budget))) return false
  await pass(ctx, orgId, true, budget)
  return true
}

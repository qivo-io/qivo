/* Lets go of the ids an organization's tasks and projects held (schema.ts
 * used_ids) at the end of its teardown, the one place used_ids rows are
 * deleted. Every teardown calls it once the organization's tasks and
 * projects are gone: organization deletion in steps (model/orgDeletion.ts
 * deleteOrgStep), deleteOrgDeep (model/cascade.ts) and the public demo's
 * cleanup (internal/demoCleanup.ts) after the organization row and every
 * other row of it, and the Northstar wipe (model/orgDeletion.ts
 * wipeWorkStep), which keeps the organization, after its work. The guest
 * fixture (internal/guestOrg.ts) also calls it for its organization's id
 * once no row of that organization is left, also when another teardown
 * deleted the organization.
 *
 * An id that something outside the organization still names stays retired
 * (heldOutside). Each teardown runs in a round (schema.ts used_id_rounds):
 * it looks at the rows never kept and those kept in an earlier round, and
 * marks a row still named kept in this round, which takes it out of what
 * the next step reads, so every step makes progress and a held row never
 * keeps the rows behind it from being looked at. It is done once no row of
 * an earlier round is left. A later teardown of the same organization, the
 * next Northstar wipe or guest fixture rebuild, starts a new round and
 * looks at every kept row again. */

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
 * after it. Answers the rows it found.
 *
 * Stored-byte totals rows (model/storageTotals.ts) are no holders. Each
 * names its organization and the task's or project's number, which every
 * writer matches, so a task or project that takes the id elsewhere gets a
 * row of its own. Every teardown takes the organization's rows out before
 * this runs: its deletion in steps and the public demo's cleanup drain
 * them, deleteOrgDeep deletes them, and the Northstar wipe takes out every
 * counted file with its task, which deletes a row once it holds none. */
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

/** The round of organization `orgId`'s running release, which its first
 * step starts one past the last round a row was kept in. Two index
 * ranges. */
async function roundOf(ctx: MutationCtx, orgId: string): Promise<Doc<'used_id_rounds'>> {
  const running = await ctx.db
    .query('used_id_rounds')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .unique()
  if (running !== null) return running
  const last = await ctx.db
    .query('used_ids')
    .withIndex('by_org_kept', (q) => q.eq('org_id', orgId))
    .order('desc')
    .first()
  const _id = await ctx.db.insert('used_id_rounds', { org_id: orgId, round: (last?.kept ?? 0) + 1 })
  return (await ctx.db.get(_id)) as Doc<'used_id_rounds'>
}

/** Reads the rows of organization `orgId` in one range, one pass, those
 * never kept or kept before `round`, deletes each whose id nothing outside
 * names (heldOutside) and marks the others kept in `round`, which takes
 * each out of the range, until the range ends (true) or `budget` is spent
 * (false). Each row counts as one of `budget`'s rows for itself and one for
 * each index range heldOutside reads, and its bytes count with those of
 * what heldOutside found. */
async function pass(
  ctx: MutationCtx,
  orgId: string,
  round: number,
  kept: boolean,
  budget: Teardown,
): Promise<boolean> {
  if (teardownSpent(budget)) return false
  const rows = ctx.db
    .query('used_ids')
    .withIndex('by_org_kept', (q) =>
      kept
        ? q.eq('org_id', orgId).gte('kept', 0).lt('kept', round)
        : q.eq('org_id', orgId).eq('kept', undefined),
    )
  for await (const row of rows) {
    const holders = await heldOutside(ctx, row)
    if (holders.length === 0) await ctx.db.delete(row._id)
    else await ctx.db.patch(row._id, { kept: round })
    budget.left -= 1 + HOLDER_READS[row.table]
    if (budget.bytes !== undefined)
      for (const doc of [row, ...holders]) budget.bytes -= estimateDocumentBytes(doc)
    if (teardownSpent(budget)) return false
  }
  return true
}

/** Deletes organization `orgId`'s used_ids rows, keeping each whose id
 * something outside the organization still names (heldOutside), until it
 * has looked at every row this teardown has not (true) or `budget` is spent
 * (false). A budget not yet spent handles at least one row. Reading the
 * round counts as two of `budget`'s rows, so it reads no more index ranges
 * than the rows it spends, plus one for each of its two passes. Each row leaves the range it is read in, deleted or kept in this round, as
 * the next step reads from the start of the range again. The rows never
 * kept come first, then those kept in an earlier round, and once neither is
 * left it deletes the round. The caller runs it once the organization's
 * tasks and projects are gone, those in Deleted items included. */
export async function releaseUsedIds(
  ctx: MutationCtx,
  orgId: string,
  budget: Teardown,
): Promise<boolean> {
  if (teardownSpent(budget)) return false
  const round = await roundOf(ctx, orgId)
  let done = true
  for (const kept of [false, true])
    if (!(await pass(ctx, orgId, round.round, kept, budget))) {
      done = false
      break
    }
  // the round's two reads, after the first row so that one is always handled
  budget.left -= 2
  if (done) await ctx.db.delete(round._id)
  return done
}

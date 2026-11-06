/* The count of an organization's live attachment rows, for the suites that
 * check where a delete, a restore or a hold leaves them
 * (deletedItems.test.ts, deletedItemsRestore.test.ts, fileHolds.test.ts).
 * No billing figure comes from it: Billing, a paid period's storage sample
 * and the daily storage samples read the stored-byte totals, which count
 * files in Deleted items too (model/storageTotals.ts).
 *
 * Two dots in the basename keep the Convex CLI from deploying this module,
 * the same rule as helpers.setup.ts. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'

/**
 * The bytes of organization `orgId`'s live attachment rows, in total and
 * per project, largest first. Counts every attachment and description
 * image of its tasks, archived ones included, whose project still exists,
 * so a row whose task is gone, or whose task is left under a removed
 * project, counts nowhere. Reads the organization's attachment rows in one
 * index range and each task once.
 *
 * A task item's rows leave issue_attachments with its move to Deleted
 * items, in the delete's transaction or in the steps just after it, and
 * count nowhere once their task has left issues. A project item's project
 * rows leave projects first, so the rows of its tasks still moving count
 * nowhere. A restore writes the rows back before it reveals the task, and
 * they count from then on where its project is live.
 */
export async function liveAttachmentUsage(ctx: QueryCtx, orgId: string) {
  const projects = await ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  const totals = new Map(
    projects.map((p) => [p.id, { project_id: p.id, name: p.name, storage_bytes: 0 }]),
  )
  const tasks = new Map<string, Doc<'issues'> | null>()
  let bytes = 0
  const files = ctx.db
    .query('issue_attachments')
    .withIndex('by_org_task_archived_issue', (q) => q.eq('org_id', orgId))
  for await (const file of files) {
    let task = tasks.get(file.issue_id)
    if (task === undefined) {
      task = await byId(ctx, 'issues', file.issue_id)
      tasks.set(file.issue_id, task)
    }
    const project = task === null ? undefined : totals.get(task.project_id)
    if (project === undefined) continue
    project.storage_bytes += file.size_bytes
    bytes += file.size_bytes
  }
  return {
    bytes,
    projects: [...totals.values()]
      .filter((p) => p.storage_bytes > 0)
      .sort((a, b) => b.storage_bytes - a.storage_bytes),
  }
}

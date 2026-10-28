/* Label usage counts (schema.ts label_counts): for each label, the live
 * tasks without archived_at that carry it. Every write that changes that
 * set moves the counts in its own transaction:
 *
 *   an assignment     setTaskLabel, and Deleted items moving one out,
 *                     writing it back or emptying an organization's items
 *                     (tallyAssignment)
 *   a task            every insert, delete, archive and restore, through
 *                     model/orgs.ts tallyRows (tallyTaskLabels)
 *   a label           creating one adds its row at zero (insertLabelCount),
 *                     deleting one deletes it (deleteLabelCount), so the
 *                     assignments a label removal leaves count nowhere
 *
 * The teardowns that delete an organization's work over many steps delete
 * its counts before its tasks (model/orgDeletion.ts, internal/demoCleanup.ts),
 * so none reads wrong meanwhile. While internal/labelCountsBackfill counts
 * an organization, its label_count_runs row holds where the count has
 * reached, and a write moves the counts only for a task the backfill has
 * already read: one created at or before the run's `through`. The backfill
 * reads any other task later, in its state then. A missing row means the
 * label is not counted, and a write leaves it missing. */

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { uncountedWriter } from '../lib/demo'

/** The label's label_counts row, or null. */
export const labelCountRow = (ctx: QueryCtx, labelId: string) =>
  ctx.db
    .query('label_counts')
    .withIndex('by_label', (q) => q.eq('label_id', labelId))
    .unique()

/** The organization's running label count (label_count_runs), or null. */
export const labelCountRun = (ctx: QueryCtx, orgId: string) =>
  ctx.db
    .query('label_count_runs')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .unique()

/** The active tasks carrying `label` as a reader may show them, which no
 * reader does yet: null while the label is not counted or its organization
 * is being counted. */
export async function activeTaskCount(
  ctx: QueryCtx,
  label: Pick<Doc<'labels'>, 'id' | 'org_id'>,
): Promise<number | null> {
  const row = await labelCountRow(ctx, label.id)
  if (row === null || row.org_id !== label.org_id) return null
  return (await labelCountRun(ctx, label.org_id)) === null ? row.active_tasks : null
}

/** Adds the row of a label just created, at zero: no task can carry a
 * label before it exists. Every path that creates a label calls it. A row
 * that an earlier label with the same id left, which only a delete by an
 * earlier release leaves, is replaced, so the new label never takes its
 * count. */
export async function insertLabelCount(
  ctx: MutationCtx,
  label: Pick<Doc<'labels'>, 'id' | 'org_id'>,
): Promise<void> {
  const left = await labelCountRow(ctx, label.id)
  const row = { label_id: label.id, org_id: label.org_id, active_tasks: 0, revision: 0 }
  // the label spends a public demo's record limit, and its count row none
  // (lib/demo.ts uncountedWriter)
  if (left === null) await uncountedWriter(ctx.db).insert('label_counts', row)
  else await ctx.db.replace(left._id, { ...row, revision: left.revision + 1 })
}

/** Deletes the label's row, if any, in the transaction that deletes the
 * label, and answers whether it had one. */
export async function deleteLabelCount(ctx: MutationCtx, labelId: string): Promise<boolean> {
  const row = await labelCountRow(ctx, labelId)
  if (row !== null) await ctx.db.delete(row._id)
  return row !== null
}

/** Adds `by` to the count of label `labelId` of organization `orgId`. A
 * missing row stays missing, and a row of another organization is left
 * alone, as an assignment never joins a task and a label of two
 * organizations. */
async function moveCount(ctx: MutationCtx, labelId: string, orgId: string, by: number) {
  if (by === 0) return
  const row = await labelCountRow(ctx, labelId)
  if (row === null || row.org_id !== orgId) return
  await ctx.db.patch(row._id, { active_tasks: row.active_tasks + by, revision: row.revision + 1 })
}

/** Whether a write may move the counts for `task`: always, unless the
 * backfill counts its organization and has not read the task yet. */
const counted = (run: Doc<'label_count_runs'> | null, task: Pick<Doc<'issues'>, '_creationTime'>) =>
  run === null || task._creationTime <= run.through

/** Moves the counts for one assignment of `row.issue_id` to `row.label_id`
 * that this transaction inserted (`by` 1) or deleted (-1), if its task is
 * live and active. `task` is the task as this transaction holds it now when
 * the caller has it, else it is read. */
export async function tallyAssignment(
  ctx: MutationCtx,
  row: Pick<Doc<'issue_labels'>, 'issue_id' | 'label_id'>,
  by: 1 | -1,
  task?: Doc<'issues'> | null,
): Promise<void> {
  const live = task === undefined ? await byId(ctx, 'issues', row.issue_id) : task
  if (live === null || live.archived_at !== undefined) return
  if (!counted(await labelCountRun(ctx, live.org_id), live)) return
  await moveCount(ctx, row.label_id, live.org_id, by)
}

/** A task before a write, as tallyTaskLabels reads it. */
export type TaskBefore = Pick<Doc<'issues'>, 'id' | 'org_id' | 'archived_at' | '_creationTime'>

/** A task after a write. A task written back from Deleted items is a new
 * document, so it needs no position. */
export type TaskAfter = Pick<Doc<'issues'>, 'id' | 'org_id' | 'archived_at'>

/** Moves the counts for writes that each turned a `before` task into an
 * `after` one, null for none: an insert, a delete, or a patch of
 * archived_at. A task that becomes active adds one to each label it
 * carries, one that stops being active takes one off, read through its
 * assignments as they are when this runs. An insert is a new document,
 * which a running backfill has not read. Reads each organization's run
 * once, and only for a task with labels. */
export async function tallyTaskLabels(
  ctx: MutationCtx,
  writes: readonly (readonly [before: TaskBefore | null, after: TaskAfter | null])[],
): Promise<void> {
  const active = (task: TaskAfter | null) => task !== null && task.archived_at === undefined
  const runs = new Map<string, Promise<Doc<'label_count_runs'> | null>>()
  // per organization, label id → how far its count moves
  const moves = new Map<string, Map<string, number>>()
  for (const [before, after] of writes) {
    const by = Number(active(after)) - Number(active(before))
    const task = after ?? before
    if (by === 0 || task === null) continue
    const rows = await ctx.db
      .query('issue_labels')
      .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
      .collect()
    if (rows.length === 0) continue
    let run = runs.get(task.org_id)
    if (run === undefined) {
      run = labelCountRun(ctx, task.org_id)
      runs.set(task.org_id, run)
    }
    const read = await run
    if (read !== null && (before === null || !counted(read, before))) continue
    const labels = moves.get(task.org_id) ?? new Map<string, number>()
    moves.set(task.org_id, labels)
    for (const row of rows) labels.set(row.label_id, (labels.get(row.label_id) ?? 0) + by)
  }
  for (const [orgId, labels] of moves)
    for (const [labelId, by] of labels) await moveCount(ctx, labelId, orgId, by)
}

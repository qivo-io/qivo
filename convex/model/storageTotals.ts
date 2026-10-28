/* Stored task-file totals (schema.ts storage_org_totals,
 * storage_project_totals, storage_task_totals) count the bytes and files of
 * an organization's task attachments and description images, live and in
 * Deleted items. The transactions that change them keep them exact.
 *
 * - countFile adds a file in the transaction that attaches it
 *   (model/attachments.ts attachFileCore, for the app, REST and MCP).
 * - uncountFile and uncountStored take a file out in the transaction that
 *   deletes its last row for good, such as a removal, a dropped description
 *   image's deletion, a purge or split of Deleted items, or a teardown.
 * - moveTaskFiles shifts tasks' files to the project a move takes them to
 *   (model/issues.ts moveIssueCore).
 * Nothing else changes a total. A move to Deleted items stores a file's row
 * and a restore writes it back, so the file keeps counting once, where its
 * task counts, through every step and retry.
 *
 * An organization without a storage_org_totals row is not counted yet, and
 * every writer leaves it alone until internal/storageTotalsBackfill counts
 * it. While the backfill counts, a file counts only once its task does. A
 * task numbered past `counting.through` has no task row yet, and the
 * backfill counts its files in one transaction when it reaches it. A task
 * row therefore exists only for a counted task, and a removal or move
 * changes the totals exactly when the file's task has one.
 *
 * Every total is a row of its own, read by none of the queries the app
 * keeps open, so the writes rerun none of them. Attaches and purges in one
 * organization all write its row and conflict with each other, and Convex
 * runs the one that lost again. Inserts go through uncountedWriter, so they
 * spend none of a public demo visitor's record limit (lib/demo.ts).
 *
 * It imports neither model/issues.ts nor model/attachments.ts, which import
 * it, as model/descriptionImages.ts does too. */

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { uncountedWriter } from '../lib/demo'

/** Bytes and files, as a total or as a change to one. */
export type Amount = { bytes: number; files: number }

/** What a total reads of an attachment, live or as Deleted items stores it. */
export type CountedFile = Pick<Doc<'issue_attachments'>, 'org_id' | 'issue_id' | 'size_bytes'>

/** The task a file is added to, as attachFileCore holds it. */
type CountedTask = Pick<Doc<'issues'>, 'id' | 'org_id' | 'num' | 'project_id'>

/** The organization's totals row, or null while it is not counted. */
export const orgTotalsRow = (ctx: QueryCtx, orgId: string) =>
  ctx.db
    .query('storage_org_totals')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .unique()

/** Task `issueId`'s totals row, or null when no counted file is its. */
export const taskTotalsRow = (ctx: QueryCtx, issueId: string) =>
  ctx.db
    .query('storage_task_totals')
    .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
    .unique()

/** Project `projectId`'s totals row, or null when no counted file is in it. */
export const projectTotalsRow = (ctx: QueryCtx, projectId: string) =>
  ctx.db
    .query('storage_project_totals')
    .withIndex('by_project', (q) => q.eq('project_id', projectId))
    .unique()

/**
 * The organization's stored task-file bytes and files, Deleted items
 * included, or null while they are not complete, before the backfill counts
 * the organization and while it counts. A reader must never show null as
 * zero.
 */
export async function storageTotalsOf(ctx: QueryCtx, orgId: string): Promise<Amount | null> {
  const row = await orgTotalsRow(ctx, orgId)
  return row === null || row.counting !== undefined ? null : { bytes: row.bytes, files: row.files }
}

/** The name a project totals row copies for `projectId`: the live
 * project's, else the one Deleted items stores, else none. */
export async function projectNameOf(ctx: QueryCtx, projectId: string): Promise<string | undefined> {
  const live = await byId(ctx, 'projects', projectId)
  if (live !== null) return live.name
  const stored = await ctx.db
    .query('deleted_rows')
    .withIndex('by_row', (q) => q.eq('table', 'projects').eq('row_id', projectId))
    .first()
  return stored?.row.table === 'projects' ? stored.row.doc.name : undefined
}

/* Logs a total that would go below its files, which only a writer that
 * missed a change can cause. The row is still kept or deleted by its files,
 * so the dry run of internal/storageTotalsBackfill lists it. */
function checkLeft(table: string, id: string, next: Amount): void {
  if (next.files < 0 || next.bytes < 0 || (next.files === 0 && next.bytes !== 0))
    console.error('Storage totals went out of step', { table, id, ...next })
}

/**
 * Adds `by` to project `projectId`'s totals in organization `orgId`. A
 * project without a row gets one, named `name` or else as projectNameOf
 * finds it, and a row left with no file is deleted.
 */
export async function addToProject(
  ctx: MutationCtx,
  orgId: string,
  projectId: string,
  by: Amount,
  name?: string,
): Promise<void> {
  if (by.bytes === 0 && by.files === 0) return
  const row = await projectTotalsRow(ctx, projectId)
  if (row === null) {
    checkLeft('storage_project_totals', projectId, by)
    if (by.files <= 0) return
    await uncountedWriter(ctx.db).insert('storage_project_totals', {
      org_id: orgId,
      project_id: projectId,
      name: name ?? (await projectNameOf(ctx, projectId)),
      ...by,
    })
    return
  }
  const next = { bytes: row.bytes + by.bytes, files: row.files + by.files }
  checkLeft('storage_project_totals', projectId, next)
  if (next.files > 0) await ctx.db.patch(row._id, next)
  else await ctx.db.delete(row._id)
}

/** Adds `by` to organization row `org`. */
export async function addToOrg(
  ctx: MutationCtx,
  org: Doc<'storage_org_totals'>,
  by: Amount,
): Promise<void> {
  if (by.bytes === 0 && by.files === 0) return
  const next = { bytes: org.bytes + by.bytes, files: org.files + by.files }
  checkLeft('storage_org_totals', org.org_id, next)
  await ctx.db.patch(org._id, next)
}

/* Adds `by` to task row `task`, deleting it once it holds no file, and to
 * its project's totals and `org`, the organization's row if it has one. */
async function addToTask(
  ctx: MutationCtx,
  task: Doc<'storage_task_totals'>,
  org: Doc<'storage_org_totals'> | null,
  by: Amount,
): Promise<void> {
  const next = { bytes: task.bytes + by.bytes, files: task.files + by.files }
  checkLeft('storage_task_totals', task.issue_id, next)
  if (next.files > 0) await ctx.db.patch(task._id, next)
  else await ctx.db.delete(task._id)
  await addToProject(ctx, task.org_id, task.project_id, by)
  if (org !== null) await addToOrg(ctx, org, by)
}

/**
 * Counts a file of `size` bytes that this transaction attaches to `issue`,
 * in the task's project and organization. Does nothing for an organization
 * not counted yet, or for a task the backfill has not reached, which counts
 * the file when it does.
 */
export async function countFile(ctx: MutationCtx, issue: CountedTask, size: number): Promise<void> {
  const org = await orgTotalsRow(ctx, issue.org_id)
  if (org === null) return
  const by = { bytes: size, files: 1 }
  const task = await taskTotalsRow(ctx, issue.id)
  if (task !== null) return await addToTask(ctx, task, org, by)
  if (org.counting !== undefined && issue.num > org.counting.through) return
  await uncountedWriter(ctx.db).insert('storage_task_totals', {
    org_id: issue.org_id,
    issue_id: issue.id,
    project_id: issue.project_id,
    ...by,
  })
  await addToProject(ctx, issue.org_id, issue.project_id, by)
  await addToOrg(ctx, org, by)
}

/**
 * Takes `file` out of the totals once this transaction deleted its row for
 * good, live or stored. Call it for every such delete, whatever the file's
 * task is now. The task's totals row holds the project the file counts in,
 * and a task without one has no counted file.
 */
export async function uncountFile(ctx: MutationCtx, file: CountedFile): Promise<void> {
  const task = await taskTotalsRow(ctx, file.issue_id)
  if (task === null) return
  const org = await orgTotalsRow(ctx, file.org_id)
  await addToTask(ctx, task, org, { bytes: -file.size_bytes, files: -1 })
}

/** uncountFile for stored row `row` of Deleted items, which this
 * transaction deleted for good, when it is an attachment. */
export async function uncountStored(ctx: MutationCtx, row: Doc<'deleted_rows'>): Promise<void> {
  if (row.row.table === 'issue_attachments') await uncountFile(ctx, row.row.doc)
}

/**
 * Moves the counted files of the tasks `taskIds` to project `target`,
 * which this transaction moved them to. One read per task, and one write
 * per task with files and per project they leave or enter, so a move with
 * every subtask it carries reads none of their attachment rows.
 */
export async function moveTaskFiles(
  ctx: MutationCtx,
  taskIds: readonly string[],
  target: Doc<'projects'>,
): Promise<void> {
  const left = new Map<string, Amount>()
  const into = { bytes: 0, files: 0 }
  for (const id of taskIds) {
    const row = await taskTotalsRow(ctx, id)
    if (row === null || row.project_id === target.id) continue
    const from = left.get(row.project_id) ?? { bytes: 0, files: 0 }
    from.bytes += row.bytes
    from.files += row.files
    left.set(row.project_id, from)
    into.bytes += row.bytes
    into.files += row.files
    await ctx.db.patch(row._id, { project_id: target.id })
  }
  for (const [projectId, by] of left)
    await addToProject(ctx, target.org_id, projectId, { bytes: -by.bytes, files: -by.files })
  await addToProject(ctx, target.org_id, target.id, into, target.name)
}

/** Copies a project's new name onto its totals row, if it has one. */
export async function renameProjectTotals(
  ctx: MutationCtx,
  project: Pick<Doc<'projects'>, 'id' | 'name'>,
): Promise<void> {
  const row = await projectTotalsRow(ctx, project.id)
  if (row !== null && row.name !== project.name) await ctx.db.patch(row._id, { name: project.name })
}

/** Starts a new organization's totals at zero, counted from its start
 * (model/orgs.ts insertOrgRows). */
export async function startOrgTotals(ctx: MutationCtx, orgId: string): Promise<void> {
  await ctx.db.insert('storage_org_totals', { org_id: orgId, bytes: 0, files: 0 })
}

/** Deletes the organization's totals row, if any, with its other
 * bookkeeping (model/orgs.ts deleteOrgBookkeeping). Its project and task
 * rows go with its files, and each teardown drains any left. */
export async function deleteOrgTotals(ctx: MutationCtx, orgId: string): Promise<void> {
  const row = await orgTotalsRow(ctx, orgId)
  if (row !== null) await ctx.db.delete(row._id)
}

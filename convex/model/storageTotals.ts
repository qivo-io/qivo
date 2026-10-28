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
 * task counts, through every step and retry. Every write raises the
 * organization row's `revision`, so a dry run of the backfill can tell that
 * nothing changed while it counted.
 *
 * An organization without a storage_org_totals row is not counted yet, and
 * every writer leaves it alone until internal/storageTotalsBackfill counts
 * it. While the backfill counts, a file counts only once its task does. A
 * task numbered past `counting.through` has no task row yet, and the
 * backfill counts its files in one transaction when it reaches it. A task
 * row therefore exists only for a counted task, and a removal or move
 * changes the totals exactly when the file's task has one.
 *
 * Project and task rows are found by id, and an id stays taken while its
 * row exists (lib/db.ts insertUnique). Each writer still leaves alone a row
 * that is not the one of the task or project it writes for: a row of
 * another organization, or a task row with another task number or project,
 * which only a release without these rules, a fixture or a bug can leave.
 * It logs the row, and the backfill's dry run lists the difference.
 *
 * Every total is a row of its own, read by none of the queries the app
 * keeps open, so the writes rerun none of them. Attaches, moves and purges
 * in one organization all write its row and conflict with each other, and
 * Convex runs the one that lost again. Inserts go through uncountedWriter,
 * so they spend none of a public demo visitor's record limit (lib/demo.ts).
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

/** A task as the totals know it: the task a file is attached to, or one a
 * move takes to another project, before the move. */
type CountedTask = Pick<Doc<'issues'>, 'id' | 'org_id' | 'num' | 'project_id'>

/** The organization's totals row, or null while it is not counted. */
export const orgTotalsRow = (ctx: QueryCtx, orgId: string) =>
  ctx.db
    .query('storage_org_totals')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .unique()

/** The totals row keyed by task id `issueId`, or null when none is. */
export const taskTotalsRow = (ctx: QueryCtx, issueId: string) =>
  ctx.db
    .query('storage_task_totals')
    .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
    .unique()

/** The totals row keyed by project id `projectId`, or null when none is. */
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

/* Whether `row`, found by the id of a task or project of organization
 * `orgId`, is another's, which a writer must leave alone. Logs it. */
function another(
  table: 'storage_task_totals' | 'storage_project_totals',
  row: { org_id: string },
  orgId: string,
  id: string,
): boolean {
  if (row.org_id === orgId) return false
  console.error('Storage totals left alone a row of another organization', {
    table,
    id,
    org_id: orgId,
  })
  return true
}

/* Whether task row `row` is not `task`'s: of another organization, another
 * task number or, when `project` is set, another project. Logs it. */
function notTasks(row: Doc<'storage_task_totals'>, task: CountedTask, project: boolean): boolean {
  if (another('storage_task_totals', row, task.org_id, task.id)) return true
  if (row.num === task.num && (!project || row.project_id === task.project_id)) return false
  console.error("Storage totals left alone a task row that is not the task's", {
    id: task.id,
    num: task.num,
    row_num: row.num,
  })
  return true
}

/**
 * Adds `by` to project `projectId`'s totals in organization `orgId`. A
 * project without a row gets one, named `name` or else as projectNameOf
 * finds it, and a row left with no file is deleted. A row of another
 * organization is left alone.
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
  if (another('storage_project_totals', row, orgId, projectId)) return
  const next = { bytes: row.bytes + by.bytes, files: row.files + by.files }
  checkLeft('storage_project_totals', projectId, next)
  if (next.files > 0) await ctx.db.patch(row._id, next)
  else await ctx.db.delete(row._id)
}

/** Adds `by` to organization row `org` and raises its revision. */
export async function addToOrg(
  ctx: MutationCtx,
  org: Doc<'storage_org_totals'>,
  by: Amount,
): Promise<void> {
  const next = { bytes: org.bytes + by.bytes, files: org.files + by.files }
  checkLeft('storage_org_totals', org.org_id, next)
  await ctx.db.patch(org._id, { ...next, revision: org.revision + 1 })
}

/* Raises the revision of organization `orgId`'s row, if it has one, for a
 * write that moves no organization total. */
async function touchOrg(ctx: MutationCtx, orgId: string): Promise<void> {
  const org = await orgTotalsRow(ctx, orgId)
  if (org !== null) await ctx.db.patch(org._id, { revision: org.revision + 1 })
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
 * not counted yet, for a task the backfill has not reached, which counts
 * the file when it does, or when the task's id holds a row that is not
 * this task's.
 */
export async function countFile(ctx: MutationCtx, issue: CountedTask, size: number): Promise<void> {
  const org = await orgTotalsRow(ctx, issue.org_id)
  if (org === null) return
  const by = { bytes: size, files: 1 }
  const task = await taskTotalsRow(ctx, issue.id)
  if (task !== null) {
    if (notTasks(task, issue, true)) return
    return await addToTask(ctx, task, org, by)
  }
  if (org.counting !== undefined && issue.num > org.counting.through) return
  await uncountedWriter(ctx.db).insert('storage_task_totals', {
    org_id: issue.org_id,
    issue_id: issue.id,
    num: issue.num,
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
 * and a task without one has no counted file. A row of another
 * organization's task is left alone.
 */
export async function uncountFile(ctx: MutationCtx, file: CountedFile): Promise<void> {
  const task = await taskTotalsRow(ctx, file.issue_id)
  if (task === null || another('storage_task_totals', task, file.org_id, file.issue_id)) return
  const org = await orgTotalsRow(ctx, file.org_id)
  await addToTask(ctx, task, org, { bytes: -file.size_bytes, files: -1 })
}

/** uncountFile for stored row `row` of Deleted items, which this
 * transaction deleted for good, when it is an attachment. */
export async function uncountStored(ctx: MutationCtx, row: Doc<'deleted_rows'>): Promise<void> {
  if (row.row.table === 'issue_attachments') await uncountFile(ctx, row.row.doc)
}

/**
 * Moves the counted files of `tasks`, as they were before this transaction
 * moved them, to project `target`. One read per task, and one write per
 * task with files, per project they leave or enter and for the
 * organization's revision, so a move with every subtask it carries reads
 * none of their attachment rows.
 */
export async function moveTaskFiles(
  ctx: MutationCtx,
  tasks: readonly CountedTask[],
  target: Doc<'projects'>,
): Promise<void> {
  const left = new Map<string, Amount>()
  const into = { bytes: 0, files: 0 }
  for (const task of tasks) {
    const row = await taskTotalsRow(ctx, task.id)
    if (row === null || row.project_id === target.id || notTasks(row, task, false)) continue
    const from = left.get(row.project_id) ?? { bytes: 0, files: 0 }
    from.bytes += row.bytes
    from.files += row.files
    left.set(row.project_id, from)
    into.bytes += row.bytes
    into.files += row.files
    await ctx.db.patch(row._id, { project_id: target.id })
  }
  if (left.size === 0) return
  for (const [projectId, by] of left)
    await addToProject(ctx, target.org_id, projectId, { bytes: -by.bytes, files: -by.files })
  await addToProject(ctx, target.org_id, target.id, into, target.name)
  await touchOrg(ctx, target.org_id)
}

/** Copies a project's new name onto its totals row, if it has one of its
 * own organization. */
export async function renameProjectTotals(
  ctx: MutationCtx,
  project: Pick<Doc<'projects'>, 'id' | 'org_id' | 'name'>,
): Promise<void> {
  const row = await projectTotalsRow(ctx, project.id)
  if (row === null || row.name === project.name) return
  if (another('storage_project_totals', row, project.org_id, project.id)) return
  await ctx.db.patch(row._id, { name: project.name })
  await touchOrg(ctx, project.org_id)
}

/**
 * Starts a new organization's totals at zero, counted from its start
 * (model/orgs.ts insertOrgRows). Rows left under its id, which only a
 * release without these totals can leave by deleting an organization of
 * that id, are not trusted. The organization's row is replaced, and while
 * project or task rows of the id are left it stays not counted, so the
 * backfill deletes them before it counts it.
 */
export async function startOrgTotals(ctx: MutationCtx, orgId: string): Promise<void> {
  const stale = await orgTotalsRow(ctx, orgId)
  if (stale !== null) await ctx.db.delete(stale._id)
  const left =
    (await ctx.db
      .query('storage_task_totals')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .first()) ??
    (await ctx.db
      .query('storage_project_totals')
      .withIndex('by_org_bytes', (q) => q.eq('org_id', orgId))
      .first())
  if (left === null)
    await ctx.db.insert('storage_org_totals', { org_id: orgId, bytes: 0, files: 0, revision: 0 })
}

/** Deletes the organization's totals row, if any, with its other
 * bookkeeping (model/orgs.ts deleteOrgBookkeeping). Its project and task
 * rows go with its files, and each teardown drains any left. */
export async function deleteOrgTotals(ctx: MutationCtx, orgId: string): Promise<void> {
  const row = await orgTotalsRow(ctx, orgId)
  if (row !== null) await ctx.db.delete(row._id)
}

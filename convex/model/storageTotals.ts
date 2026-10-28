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
 * A project or task row is found by its organization, its id and its
 * number, which the organization never gives another project or task. A
 * task or project that takes the id of a purged one, in the same
 * organization or another, therefore gets a row of its own, and no writer
 * reads or changes the row of another object. A writer always knows the
 * number of the task it writes for. A removal whose caller does not hold
 * the task reads it from the task, live or as Deleted items keeps it
 * (taskNumOf), and every path that deletes a task for good takes its stored
 * files out first, while its number can still be read.
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

/** A project as a totals row names it: its number and name, both absent
 * when no copy of the project is left. */
export type ProjectKey = { num?: number; name?: string }

/** The organization's totals row, or null while it is not counted. */
export const orgTotalsRow = (ctx: QueryCtx, orgId: string) =>
  ctx.db
    .query('storage_org_totals')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .unique()

/** The totals row of task `issueId` numbered `num` of organization
 * `orgId`, or null when it has none. */
export const taskTotalsRow = (ctx: QueryCtx, orgId: string, issueId: string, num: number) =>
  ctx.db
    .query('storage_task_totals')
    .withIndex('by_org_issue', (q) => q.eq('org_id', orgId).eq('issue_id', issueId).eq('num', num))
    .unique()

/** The totals row of project `projectId` numbered `num` of organization
 * `orgId`, or null when it has none. */
export const projectTotalsRow = (
  ctx: QueryCtx,
  orgId: string,
  projectId: string,
  num: number | undefined,
) =>
  ctx.db
    .query('storage_project_totals')
    .withIndex('by_org_project', (q) =>
      q.eq('org_id', orgId).eq('project_id', projectId).eq('num', num),
    )
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

/** Project `projectId` of organization `orgId` as a totals row names it,
 * from the live project, else the copy Deleted items stores, else neither. */
export async function projectOf(
  ctx: QueryCtx,
  orgId: string,
  projectId: string,
): Promise<ProjectKey> {
  const live = await byId(ctx, 'projects', projectId)
  if (live?.org_id === orgId) return { num: live.num, name: live.name }
  const stored = await ctx.db
    .query('deleted_rows')
    .withIndex('by_row', (q) => q.eq('table', 'projects').eq('row_id', projectId))
    .first()
  if (stored?.org_id === orgId && stored.row.table === 'projects')
    return { num: stored.row.doc.num, name: stored.row.doc.name }
  return {}
}

/**
 * The number of the task of organization `orgId` that a file of task id
 * `issueId` belongs to, for a removal whose caller does not hold the task,
 * or null when no such task is left, and the file counts nowhere. A live
 * attachment row belongs to the live task, else to the one Deleted items
 * stores while a move or restore carries it. A stored copy belongs only to
 * the stored task, from deleted_tasks or its stored row, never to a live
 * task that may have taken the id since; the paths that delete a live task
 * for good take its stored copies out first, with its number.
 */
export async function taskNumOf(
  ctx: QueryCtx,
  orgId: string,
  issueId: string,
  stored: boolean,
): Promise<number | null> {
  const live = async () => {
    const task = await byId(ctx, 'issues', issueId)
    return task?.org_id === orgId ? task.num : null
  }
  const kept = async () => {
    const light = await ctx.db
      .query('deleted_tasks')
      .withIndex('by_task', (q) => q.eq('task_id', issueId))
      .first()
    if (light?.org_id === orgId) return light.num
    const copy = await ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) => q.eq('table', 'issues').eq('row_id', issueId))
      .first()
    return copy?.org_id === orgId && copy.row.table === 'issues' ? copy.row.doc.num : null
  }
  return stored ? await kept() : ((await live()) ?? (await kept()))
}

/* Logs a total that would go below its files, which only a writer that
 * missed a change can cause. The row is still kept or deleted by its files,
 * so the dry run of internal/storageTotalsBackfill lists it. */
function checkLeft(table: string, id: string, next: Amount): void {
  if (next.files < 0 || next.bytes < 0 || (next.files === 0 && next.bytes !== 0))
    console.error('Storage totals went out of step', { table, id, ...next })
}

/**
 * Adds `by` to the totals of project `projectId` numbered `num` in
 * organization `orgId`. A project without a row gets one, named `name` or
 * else as projectOf finds it while that is still the project numbered
 * `num`, and a row left with no file is deleted.
 */
export async function addToProject(
  ctx: MutationCtx,
  orgId: string,
  projectId: string,
  num: number | undefined,
  by: Amount,
  name?: string,
): Promise<void> {
  if (by.bytes === 0 && by.files === 0) return
  const row = await projectTotalsRow(ctx, orgId, projectId, num)
  if (row === null) {
    checkLeft('storage_project_totals', projectId, by)
    if (by.files <= 0) return
    const found = name === undefined ? await projectOf(ctx, orgId, projectId) : undefined
    await uncountedWriter(ctx.db).insert('storage_project_totals', {
      org_id: orgId,
      project_id: projectId,
      num,
      name: name ?? (found?.num === num ? found?.name : undefined),
      ...by,
    })
    return
  }
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
  await addToProject(ctx, task.org_id, task.project_id, task.project_num, by)
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
  const task = await taskTotalsRow(ctx, issue.org_id, issue.id, issue.num)
  if (task !== null) return await addToTask(ctx, task, org, by)
  if (org.counting !== undefined && issue.num > org.counting.through) return
  const project = await projectOf(ctx, issue.org_id, issue.project_id)
  await uncountedWriter(ctx.db).insert('storage_task_totals', {
    org_id: issue.org_id,
    issue_id: issue.id,
    num: issue.num,
    project_id: issue.project_id,
    project_num: project.num,
    ...by,
  })
  await addToProject(ctx, issue.org_id, issue.project_id, project.num, by, project.name)
  await addToOrg(ctx, org, by)
}

/* Takes `file` out of the totals of its task numbered `num`. */
async function takeOut(ctx: MutationCtx, file: CountedFile, num: number | null): Promise<void> {
  if (num === null) return
  const task = await taskTotalsRow(ctx, file.org_id, file.issue_id, num)
  if (task === null) return
  const org = await orgTotalsRow(ctx, file.org_id)
  await addToTask(ctx, task, org, { bytes: -file.size_bytes, files: -1 })
}

/**
 * Takes live attachment row `file` out of the totals once this transaction
 * deleted it for good. `num` is its task's number, which the caller passes
 * when it holds the task and taskNumOf reads otherwise. A task without a
 * row has no counted file, and the row of another task, of another number
 * or organization, is never touched.
 */
export async function uncountFile(
  ctx: MutationCtx,
  file: CountedFile,
  num?: number,
): Promise<void> {
  await takeOut(ctx, file, num ?? (await taskNumOf(ctx, file.org_id, file.issue_id, false)))
}

/** uncountFile for stored row `row` of Deleted items, which this
 * transaction deleted for good, when it is an attachment; `num` is its
 * task's number when the caller holds the task. */
export async function uncountStored(
  ctx: MutationCtx,
  row: Doc<'deleted_rows'>,
  num?: number,
): Promise<void> {
  if (row.row.table !== 'issue_attachments') return
  const file = row.row.doc
  await takeOut(ctx, file, num ?? (await taskNumOf(ctx, file.org_id, file.issue_id, true)))
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
  const left = new Map<string, { project_id: string; num?: number; by: Amount }>()
  const into = { bytes: 0, files: 0 }
  for (const task of tasks) {
    const row = await taskTotalsRow(ctx, task.org_id, task.id, task.num)
    if (row === null || (row.project_id === target.id && row.project_num === target.num)) continue
    const key = `${row.project_id}:${row.project_num ?? ''}`
    const from = left.get(key) ?? {
      project_id: row.project_id,
      num: row.project_num,
      by: { bytes: 0, files: 0 },
    }
    from.by.bytes += row.bytes
    from.by.files += row.files
    left.set(key, from)
    into.bytes += row.bytes
    into.files += row.files
    await ctx.db.patch(row._id, { project_id: target.id, project_num: target.num })
  }
  if (left.size === 0) return
  for (const { project_id, num, by } of left.values())
    await addToProject(ctx, target.org_id, project_id, num, {
      bytes: -by.bytes,
      files: -by.files,
    })
  await addToProject(ctx, target.org_id, target.id, target.num, into, target.name)
  await touchOrg(ctx, target.org_id)
}

/** Copies a project's new name onto its totals row, if it has one. */
export async function renameProjectTotals(
  ctx: MutationCtx,
  project: Pick<Doc<'projects'>, 'id' | 'org_id' | 'num' | 'name'>,
): Promise<void> {
  const row = await projectTotalsRow(ctx, project.org_id, project.id, project.num)
  if (row === null || row.name === project.name) return
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
      .withIndex('by_org_issue', (q) => q.eq('org_id', orgId))
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

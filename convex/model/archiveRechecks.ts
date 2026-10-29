/* The projects the next nightly archive checks in full (schema.ts
 * archive_rechecks). A run reads only the active Done tasks whose done_at
 * passed its threshold since the last finished run (jobs.ts windowStep), so
 * a task that falls due without a new done_at needs its project marked here:
 * - a project restored from the archive, whose Done tasks keep their
 *   done_at (model/projects.ts unarchiveProjectCore);
 * - a Done parent that waited for an unarchived child, once that child
 *   stops counting for it: the child is archived (model/issues.ts
 *   archiveIssueCore, updateIssueCore's machine toggle, jobs.ts archiveLeg),
 *   leaves the parent (updateIssueCore, moveIssueCore), moves to Deleted
 *   items without it (model/deletedItems.ts moveTasksToTrash, moveEdges) or
 *   is deleted for good with a project item whose move got stuck
 *   (model/deletedItems.ts clearTask);
 * - a seeded Done task whose done_at may already lie before the last run's
 *   threshold (model/demoSeed.ts).
 * A write that sets done_at to its own time needs no row, because the
 * window reaches the task when its age passes the threshold. Every task
 * restore, from the archive or from Deleted items, and every move of a task
 * to another sub-project restamps done_at (model/issues.ts doneStampUpdate,
 * movedStamps, model/deletedItems.ts writeTask).
 *
 * Rows are written without a read first, through the writer that leaves a
 * public demo's record limit alone (lib/demo.ts uncountedWriter), because a
 * row only asks for a check and holds nothing of the visitor's. On a demo
 * deployment a writer reads first instead and adds no row while the project
 * has one without from_run, so a visitor's rows stay bounded by projects,
 * not by writes; a row a running chain deletes at that moment can then hide
 * the visitor's change from the next run, which only lets a demo task
 * archive late. Elsewhere the blind insert keeps writers free of read
 * conflicts with the archive. The run's full pass every few weeks (jobs.ts
 * ARCHIVE_FULL_AFTER_MS) covers a write that marked nothing, such as data
 * written outside the app or by an earlier release. */

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { isDemoDeployment, uncountedWriter } from '../lib/demo'
import { DEFAULT_ARCHIVE_DAYS } from './orgs'

const DAY = 86_400_000

/** A run's threshold: an active Done task with done_at at or before it is
 * due in a run at `now`. */
export const archiveCutoff = (now: string): string =>
  new Date(Date.parse(now) - DEFAULT_ARCHIVE_DAYS * DAY).toISOString()

/** Whether a task written in this transaction with `doneAt`, an earlier
 * done_at than the write's own time, such as a seed's, may already lie at
 * or before the threshold of a run that read its window, so that no later
 * window reaches it and its project needs a row. A run's threshold is
 * archiveCutoff of its `now`, and a run that read its window before this
 * write commits started before then, so a day past the later of `now` and
 * the transaction's clock covers it, however long a seed's steps take. */
export const behindWindow = (doneAt: string, now: string): boolean =>
  doneAt <= archiveCutoff(new Date(Math.max(Date.parse(now), Date.now()) + DAY).toISOString())

/** The rechecks of organization `orgId`'s projects, which its teardowns
 * delete. */
export const rechecksOfOrg = (ctx: QueryCtx, orgId: string) =>
  ctx.db.query('archive_rechecks').withIndex('by_org_project_run', (q) => q.eq('org_id', orgId))

/** Asks the next nightly archive to check project `project_id` of
 * organization `org_id` in full. `from_run` is the `now` of the run whose
 * leg writes the row, which that run leaves for the next one, and `due_by`
 * the threshold of the run whose find phase writes it, which an older run
 * leaves for it. A writer's row has neither, and on a demo deployment it is
 * added only while the project has no row without from_run (header). */
export async function recheckProject(
  db: MutationCtx['db'],
  row: { org_id: string; project_id: string; from_run?: string; due_by?: string },
): Promise<void> {
  if (row.from_run === undefined && row.due_by === undefined && isDemoDeployment()) {
    const held = await db
      .query('archive_rechecks')
      .withIndex('by_org_project_run', (q) =>
        q.eq('org_id', row.org_id).eq('project_id', row.project_id).eq('from_run', undefined),
      )
      .first()
    if (held !== null) return
  }
  await uncountedWriter(db).insert('archive_rechecks', row)
}

/** Whether `parent` is a task the nightly archive can have left only for an
 * unarchived child: active, Done and with a done_at. */
export const waitsForChildren = (parent: Doc<'issues'> | null): parent is Doc<'issues'> =>
  parent !== null &&
  parent.archived_at === undefined &&
  parent.status === 'done' &&
  parent.done_at !== undefined

/** For `task`, as it was before a write that stops it counting as an
 * unarchived child of its parent (an archive, a detach or a parent change,
 * a move to Deleted items without the parent): reads the parent once and
 * asks the next nightly archive to check the parent's project when the
 * parent waits for its children (waitsForChildren). A task without a
 * parent, or archived already, counted for none, so nothing is read.
 * Returns the parent it read, else null, for a caller that budgets its
 * reads. */
export async function recheckParent(
  ctx: { db: MutationCtx['db'] },
  task: Pick<Doc<'issues'>, 'parent_id' | 'archived_at'>,
): Promise<Doc<'issues'> | null> {
  if (task.parent_id === undefined || task.archived_at !== undefined) return null
  const parent = await byId(ctx, 'issues', task.parent_id)
  if (waitsForChildren(parent))
    await recheckProject(ctx.db, { org_id: parent.org_id, project_id: parent.project_id })
  return parent
}

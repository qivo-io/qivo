import type { QueryCtx } from '../_generated/server'

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const id = key(row)
    const group = groups.get(id)
    if (group === undefined) groups.set(id, [row])
    else group.push(row)
  }
  return groups
}

/** When a view's relation rows are read task by task. Each visible task costs
 * four index ranges, so `tasks` keeps that read at 1,024 of Convex's 4,096
 * ranges. Up to that size, a view is read task by task while `ratio` times
 * its tasks is under the organization's active tasks, else in bulk. Tests
 * change these to force either read. */
export const SELECTIVE_READ = { tasks: 256, ratio: 2 }

/* The rows per visible task that a bulk read of a view of at most
 * SELECTIVE_READ.tasks tasks takes from one table before it reads that table
 * task by task instead. */
const BULK_ROWS_PER_TASK = 8

const TABLES = ['issue_links', 'issue_labels', 'issue_attachments'] as const

/**
 * Reads the relation rows of a member's visible tasks in one organization
 * and returns a lookup that gives one task's links (as source and as target),
 * label assignments and attachments, each in creation order. `visible` is
 * the number of tasks in the member's working set, `active` the number of
 * the organization's tasks that are not archived.
 *
 * The bulk read takes the organization's unmarked rows of each table from
 * by_org_task_archived, six index ranges whatever the size of the view.
 * Background steps mark the rows of each task once it is archived
 * (model/archiveMarks.ts), so its cost follows the active tasks, not
 * everything ever archived. Rows it returns about tasks outside the view are
 * never looked up. The task-by-task read uses each task's own indexes, four
 * ranges per task, and pays off for a small view in a large organization.
 * SELECTIVE_READ decides between them.
 *
 * A bulk read for a view of at most SELECTIVE_READ.tasks tasks takes at most
 * BULK_ROWS_PER_TASK rows per task from each table. A table with more is read
 * task by task, which costs a bounded number of ranges at that size and
 * bounds the documents read while many rows are still unmarked (an archive
 * whose step has not run yet, or rows stored before marks existed). A larger
 * view always reads in bulk and in full. Falling back there would cost four
 * ranges per task and fail the whole snapshot past about 1,000 tasks, so
 * unmarked rows of archived tasks only cost documents read, and the marks
 * keep those few.
 *
 * Rows stored without org_id, from before the field existed, are outside the
 * organization's range. While an unmarked one exists, in any organization,
 * every view is read task by task as before, also a view larger than
 * SELECTIVE_READ.tasks. No writer stores such rows any more, and none
 * rewrites them. A marked one belongs to an archived task, which no view
 * reads, so it does not force this.
 */
export async function snapshotRelations(
  ctx: QueryCtx,
  a: { orgId: string; visible: number; active: number },
) {
  const small = a.visible <= SELECTIVE_READ.tasks
  const selective = small && SELECTIVE_READ.ratio * a.visible < a.active
  const legacy = selective
    ? [null, null, null]
    : await Promise.all(
        TABLES.map((table) =>
          ctx.db
            .query(table)
            .withIndex('by_org_task_archived', (q) =>
              q.eq('org_id', undefined).eq('task_archived', undefined),
            )
            .first(),
        ),
      )
  const bulk = !selective && legacy.every((row) => row === null)
  const cap = BULK_ROWS_PER_TASK * a.visible
  // A capped read returns cap + 1 rows when the table has more than cap.
  const fits = <Row>(rows: Row[] | null): rows is Row[] =>
    rows !== null && (!small || rows.length <= cap)
  const read = <Row>(rows: { take(n: number): Promise<Row[]>; collect(): Promise<Row[]> }) =>
    small ? rows.take(cap + 1) : rows.collect()
  const [links, labels, attachments] = bulk
    ? await Promise.all([
        read(
          ctx.db
            .query('issue_links')
            .withIndex('by_org_task_archived', (q) =>
              q.eq('org_id', a.orgId).eq('task_archived', undefined),
            ),
        ),
        read(
          ctx.db
            .query('issue_labels')
            .withIndex('by_org_task_archived', (q) =>
              q.eq('org_id', a.orgId).eq('task_archived', undefined),
            ),
        ),
        read(
          ctx.db
            .query('issue_attachments')
            .withIndex('by_org_task_archived', (q) =>
              q.eq('org_id', a.orgId).eq('task_archived', undefined),
            ),
        ),
      ])
    : [null, null, null]
  const sources = fits(links) ? groupBy(links, (row) => row.source_id) : null
  const targets = fits(links) ? groupBy(links, (row) => row.target_id) : null
  const issueLabels = fits(labels) ? groupBy(labels, (row) => row.issue_id) : null
  const issueAttachments = fits(attachments) ? groupBy(attachments, (row) => row.issue_id) : null
  // Both reads keep creation order within a task, because the bulk read's
  // range holds one org and no mark, and each task index holds one task.
  // Returning rows task by task keeps the snapshot's stable array order.
  return async (issueId: string) =>
    Promise.all([
      sources?.get(issueId) ??
        (sources === null
          ? ctx.db
              .query('issue_links')
              .withIndex('by_source', (q) => q.eq('source_id', issueId))
              .collect()
          : []),
      targets?.get(issueId) ??
        (targets === null
          ? ctx.db
              .query('issue_links')
              .withIndex('by_target', (q) => q.eq('target_id', issueId))
              .collect()
          : []),
      issueLabels?.get(issueId) ??
        (issueLabels === null
          ? ctx.db
              .query('issue_labels')
              .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
              .collect()
          : []),
      issueAttachments?.get(issueId) ??
        (issueAttachments === null
          ? ctx.db
              .query('issue_attachments')
              .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
              .collect()
          : []),
    ])
}

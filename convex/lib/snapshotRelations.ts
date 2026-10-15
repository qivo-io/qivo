import type { Doc } from '../_generated/dataModel'
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

/** The bounds of a view's relation reads. `ranges` is the most index ranges
 * that reads task by task may spend for one view. A view is read wholly task
 * by task when four ranges per task fit and `ratio` times its tasks is under
 * the organization's active tasks. Tests change these to force a read. */
export const RELATION_READ = { ranges: 2048, ratio: 2 }

/* A bulk read of a table that the view could still afford to read task by
 * task stops after this many rows per range that read would cost. Convex
 * allows about 8 documents per index range (32,000 to 4,096), and stopping at
 * half that leaves room for the other tables and the rest of the snapshot.
 * With all three tables at their caps, a view reads at most 16 rows per
 * visible task. */
const BULK_ROWS_PER_RANGE = 4

/* One task's links as source and as target, label assignments and
 * attachments. */
type TaskRows = [
  Doc<'issue_links'>[],
  Doc<'issue_links'>[],
  Doc<'issue_labels'>[],
  Doc<'issue_attachments'>[],
]

/* One table's rows grouped by task, or null when it is read task by task. */
type Groups<Row> = Map<string, Row[]> | null

/* The task's rows from its own indexes, marked rows included. */
const readTask = (ctx: QueryCtx, issueId: string): Promise<TaskRows> =>
  Promise.all([
    ctx.db
      .query('issue_links')
      .withIndex('by_source', (q) => q.eq('source_id', issueId))
      .collect(),
    ctx.db
      .query('issue_links')
      .withIndex('by_target', (q) => q.eq('target_id', issueId))
      .collect(),
    ctx.db
      .query('issue_labels')
      .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
      .collect(),
    ctx.db
      .query('issue_attachments')
      .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
      .collect(),
  ])

const byCreation = <Row extends { _creationTime: number }>(rows: Row[]): Row[] =>
  rows.sort((a, b) => a._creationTime - b._creationTime)

/**
 * Reads the relation rows of a member's visible tasks (`tasks`, the working
 * set) in one organization and returns a lookup that gives one task's links
 * as source and as target, label assignments and attachments, each in
 * creation order. `active` is the number of the organization's tasks that are
 * not archived.
 *
 * A view of at most RELATION_READ.ranges / 4 tasks (512) that holds under
 * half the active tasks is read task by task, four ranges per task. That is
 * the cheapest read for a restricted view in a large organization.
 *
 * Any other view reads each table in bulk, the organization's rows without
 * the archive mark (by_org_task_archived_*). Background steps mark the rows
 * of each task once it is archived (model/archiveMarks.ts), so these reads
 * follow the active tasks, not everything ever archived. The tables go
 * cheapest first: labels and attachments cost one range per task read task
 * by task, links two. While that cost fits what is left of
 * RELATION_READ.ranges, the bulk read stops after BULK_ROWS_PER_RANGE rows per
 * such range, and a table with more is read task by task, spending the
 * budget. Otherwise the table is read in full, as no read with bounded ranges
 * remains. A large view reads the active tasks' rows in bulk this way, and a
 * restricted one in a dense organization reads its own rows task by task.
 *
 * A task restored from the archive keeps marked rows until background steps
 * clear them, and carries relations_marked meanwhile. Each such visible task
 * is read through its own indexes, which include marked rows, before the
 * tables are, at four ranges each, taken from the budget first. Its links,
 * marked ones included, are also listed for their other end, so every task
 * gets the rows its own indexes would give.
 *
 * So the reads cost 4 ranges per visible task in the first case. Otherwise
 * they cost 6 ranges plus RELATION_READ.ranges at most, or plus 4 per
 * restored visible task if that is more. A table that falls back first read
 * at most BULK_ROWS_PER_RANGE documents per range it then spends, and a table
 * read in bulk reads at most that many when the budget allowed a fallback,
 * else every unmarked row of the organization's table.
 *
 * Rows stored without org_id, from before the field existed, are outside the
 * organization's range. While an unmarked one exists, in any organization,
 * every view is read task by task as before, also one of more than 512 tasks.
 * No writer stores such rows any more, and none rewrites them. The archive
 * steps never mark one (model/archiveMarks.ts), so probing for unmarked rows
 * finds them all.
 */
export async function snapshotRelations(
  ctx: QueryCtx,
  a: { orgId: string; tasks: readonly Doc<'issues'>[]; active: number },
): Promise<(issueId: string) => Promise<TaskRows>> {
  const visible = a.tasks.length
  const perTask = (issueId: string) => readTask(ctx, issueId)
  if (4 * visible <= RELATION_READ.ranges && RELATION_READ.ratio * visible < a.active) {
    return perTask
  }
  const legacy = await Promise.all([
    ctx.db
      .query('issue_links')
      .withIndex('by_org_task_archived_source', (q) =>
        q.eq('org_id', undefined).eq('task_archived', undefined),
      )
      .first(),
    ctx.db
      .query('issue_labels')
      .withIndex('by_org_task_archived_issue', (q) =>
        q.eq('org_id', undefined).eq('task_archived', undefined),
      )
      .first(),
    ctx.db
      .query('issue_attachments')
      .withIndex('by_org_task_archived_issue', (q) =>
        q.eq('org_id', undefined).eq('task_archived', undefined),
      )
      .first(),
  ])
  if (legacy.some((row) => row !== null)) return perTask

  // Restored tasks whose marks are not cleared yet, read through their own
  // indexes before the tables, so the budget left is known.
  const restored = new Map<string, TaskRows>()
  for (const task of a.tasks) {
    if (task.relations_marked === true) restored.set(task.id, await readTask(ctx, task.id))
  }
  let budget = RELATION_READ.ranges - 4 * restored.size
  const others = visible - restored.size
  /* One table's unmarked rows in bulk, or null to read it task by task
   * (`cost` ranges per task) when it holds more than the cap and the budget
   * allows, or when every visible task was read already. */
  const bulk = async <Row>(
    rows: { take(n: number): Promise<Row[]>; collect(): Promise<Row[]> },
    cost: number,
  ): Promise<Row[] | null> => {
    if (others === 0) return null
    const ranges = cost * others
    if (ranges > budget) return await rows.collect()
    const cap = BULK_ROWS_PER_RANGE * ranges
    const read = await rows.take(cap + 1)
    if (read.length <= cap) return read
    budget -= ranges
    return null
  }
  const labels = await bulk(
    ctx.db
      .query('issue_labels')
      .withIndex('by_org_task_archived_issue', (q) =>
        q.eq('org_id', a.orgId).eq('task_archived', undefined),
      ),
    1,
  )
  const attachments = await bulk(
    ctx.db
      .query('issue_attachments')
      .withIndex('by_org_task_archived_issue', (q) =>
        q.eq('org_id', a.orgId).eq('task_archived', undefined),
      ),
    1,
  )
  const links = await bulk(
    ctx.db
      .query('issue_links')
      .withIndex('by_org_task_archived_source', (q) =>
        q.eq('org_id', a.orgId).eq('task_archived', undefined),
      ),
    2,
  )
  const issueLabels: Groups<Doc<'issue_labels'>> = labels && groupBy(labels, (row) => row.issue_id)
  const issueAttachments: Groups<Doc<'issue_attachments'>> =
    attachments && groupBy(attachments, (row) => row.issue_id)
  let sources: Groups<Doc<'issue_links'>> = null
  let targets: Groups<Doc<'issue_links'>> = null
  if (links !== null) {
    // A restored task's links, marked or not, also belong to the other end.
    const seen = new Set(links.map((link) => link._id))
    for (const [asSource, asTarget] of restored.values()) {
      for (const link of [...asSource, ...asTarget]) {
        if (seen.has(link._id)) continue
        seen.add(link._id)
        links.push(link)
      }
    }
    sources = groupBy(links, (row) => row.source_id)
    targets = groupBy(links, (row) => row.target_id)
    for (const group of [...sources.values(), ...targets.values()]) byCreation(group)
  }
  // Rows grouped from one index range keep its creation order within a task,
  // and merged links are sorted by it, so every task gets its rows in the
  // order its own indexes give.
  return async (issueId: string) =>
    restored.get(issueId) ??
    Promise.all([
      sources === null
        ? ctx.db
            .query('issue_links')
            .withIndex('by_source', (q) => q.eq('source_id', issueId))
            .collect()
        : (sources.get(issueId) ?? []),
      targets === null
        ? ctx.db
            .query('issue_links')
            .withIndex('by_target', (q) => q.eq('target_id', issueId))
            .collect()
        : (targets.get(issueId) ?? []),
      issueLabels === null
        ? ctx.db
            .query('issue_labels')
            .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
            .collect()
        : (issueLabels.get(issueId) ?? []),
      issueAttachments === null
        ? ctx.db
            .query('issue_attachments')
            .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
            .collect()
        : (issueAttachments.get(issueId) ?? []),
    ])
}

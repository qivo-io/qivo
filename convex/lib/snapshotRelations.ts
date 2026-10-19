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

/** When a view's relation reads go task by task. A view of at most `tasks`
 * tasks that holds under 1 / `ratio` of the organization's live tasks is
 * read wholly task by task. In any other view, a table over its bulk cap is
 * read task by task while the reads task by task so far fit `ranges`, which
 * is Convex's limit per transaction. A table kept in bulk reads at most
 * `legacy` of the deployment's rows stored without org_id, and is read task
 * by task when it holds more. Tests change these to force a read. */
export const RELATION_READ = { tasks: 512, ratio: 2, ranges: 4096, legacy: 256 }

/* The rows a bulk read of one table takes, per range its read task by task
 * would cost (one per task for labels and attachments, two for links),
 * before it reads that table task by task instead. Convex allows about 8
 * documents per index range (32,000 to 4,096), and half that leaves room for
 * the other tables and the rest of the snapshot. With all three tables at
 * their caps, a view reads at most 16 rows per visible task. */
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

/* Each group of `groups` in creation order, the order a task's own index
 * gives. */
function inCreationOrder<Row extends { _creationTime: number }>(
  groups: Map<string, Row[]>,
): Map<string, Row[]> {
  for (const group of groups.values()) byCreation(group)
  return groups
}

/**
 * Reads the relation rows of a member's visible tasks (`tasks`, the working
 * set) in one organization and returns a lookup that gives one task's links
 * as source and as target, label assignments and attachments, each in
 * creation order. `active` is the number of the organization's live tasks,
 * the active ones in active projects (lib/liveTasks.ts liveTasksOf).
 *
 * A view of at most RELATION_READ.tasks tasks (512) that holds under half the
 * live tasks is read task by task, four ranges per task, the cheapest read
 * for a restricted view in a large organization.
 *
 * Any other view reads each table in bulk, the organization's rows without
 * the archive mark (by_org_task_archived_*). Background steps mark the rows
 * of each task once it is archived (model/archiveMarks.ts), so these reads
 * follow the active tasks, not everything ever archived. The tables go
 * cheapest first, labels, attachments, then links. A bulk read stops after
 * BULK_ROWS_PER_RANGE rows per range the table's read task by task would
 * cost, and a table with more is read task by task while the reads task by
 * task so far fit RELATION_READ.ranges, else in full. A table kept in bulk
 * also reads the deployment's unmarked rows stored without org_id, which the
 * organization's range cannot hold, up to RELATION_READ.legacy of them in
 * one more range, and adds those of the view's tasks (a link when either end
 * is one). Rows of other organizations, of tasks outside the view and of
 * tasks that are gone are left out unread, so such rows anywhere in the
 * deployment cost one range, not a read task by task. A table with more
 * such rows than that is read task by task as before. No writer stores such
 * rows any more, and internal/attachmentScopeBackfill gives older attachment
 * rows their organization. Nothing rewrites older label and link rows, and
 * the archive steps never mark a row without org_id.
 *
 * A task restored from the archive keeps marked rows until background steps
 * clear them, and carries relations_marked meanwhile. Each such visible task
 * is read through its own indexes, which include marked rows, before the
 * tables are, at four ranges each. Its links, marked ones included, are also
 * listed for their other end, so every task gets the rows its own indexes
 * would give.
 *
 * The rule this replaced read a view task by task unless the view held half
 * the tasks ever created, and otherwise each table in bulk up to 2 rows per
 * visible task (at most 4,096), task by task past that, after probing all
 * three tables. Not counting restored tasks, this rule costs at most 3
 * ranges more than that one did:
 * - A view it read task by task cost one range per task for labels and
 *   attachments and two for links. Here it is read the same way, or each
 *   table costs its capped read plus either its probe or those ranges, which
 *   is at most one range more per table. In a view of 4 tasks or more, a
 *   table kept in bulk saves at least what the other two can add.
 * - A view it read in bulk: these caps are at least its caps and count only
 *   unmarked rows, so a table read task by task here was read so there too,
 *   at the same cost, and it probed every table. It costs at most as much.
 *   A table it read task by task for a row without org_id elsewhere in the
 *   deployment stays in bulk here while there are at most
 *   RELATION_READ.legacy such rows.
 * - A table is read in full only when reading it task by task would take the
 *   reads task by task past 4,096 ranges. The old read included those
 *   ranges, so it had passed the limit.
 * In documents, a table under its cap reads at most its cap, and one over it
 * reads its cap plus one before the visible tasks' own rows, which the old
 * rule read too. A table read in full reads every unmarked row of the
 * organization's table.
 *
 * Both rules fail for a restricted view of about 1,000 tasks whose three
 * tables are all dense, where these reads alone take about 4,000 ranges. A
 * larger view fails here only if reading a dense table in full passes 32,000
 * documents, and the old rule could not read such a view at all.
 */
export async function snapshotRelations(
  ctx: QueryCtx,
  a: { orgId: string; tasks: readonly Doc<'issues'>[]; active: number },
): Promise<(issueId: string) => Promise<TaskRows>> {
  const visible = a.tasks.length
  const perTask = (issueId: string) => readTask(ctx, issueId)
  if (visible <= RELATION_READ.tasks && RELATION_READ.ratio * visible < a.active) {
    return perTask
  }

  // Restored tasks whose marks are not cleared yet, read through their own
  // indexes before the tables, so the ranges spent are known.
  const restored = new Map<string, TaskRows>()
  for (const task of a.tasks) {
    if (task.relations_marked === true) restored.set(task.id, await readTask(ctx, task.id))
  }
  let budget = RELATION_READ.ranges - 4 * restored.size
  const others = visible - restored.size
  const viewed = new Set(a.tasks.map((task) => task.id))
  /* One table's unmarked rows in bulk, with its rows stored without org_id
   * that belong to the view (`mine`), or null to read it task by task
   * (`cost` ranges per task), as only that reaches rows without org_id when
   * `legacy` holds more than RELATION_READ.legacy of them. */
  const bulk = async <Row extends { _creationTime: number }>(
    rows: { take(n: number): Promise<Row[]>; collect(): Promise<Row[]> },
    legacy: { take(n: number): Promise<Row[]> },
    mine: (row: Row) => boolean,
    cost: number,
  ): Promise<Row[] | null> => {
    if (others === 0) return null
    const ranges = cost * others
    const taskByTask = () => {
      budget -= ranges
      return null
    }
    const legacyRows = async (): Promise<Row[] | null> => {
      const found = await legacy.take(RELATION_READ.legacy + 1)
      return found.length > RELATION_READ.legacy ? null : found.filter(mine)
    }
    if (ranges > budget) {
      const own = await legacyRows()
      return own === null ? taskByTask() : [...(await rows.collect()), ...own]
    }
    const cap = BULK_ROWS_PER_RANGE * ranges
    const capped = await rows.take(cap + 1)
    if (capped.length > cap) return taskByTask()
    const own = await legacyRows()
    return own === null ? taskByTask() : [...capped, ...own]
  }
  const labels = await bulk(
    ctx.db
      .query('issue_labels')
      .withIndex('by_org_task_archived_issue', (q) =>
        q.eq('org_id', a.orgId).eq('task_archived', undefined),
      ),
    ctx.db
      .query('issue_labels')
      .withIndex('by_org_task_archived_issue', (q) =>
        q.eq('org_id', undefined).eq('task_archived', undefined),
      ),
    (row) => viewed.has(row.issue_id),
    1,
  )
  const attachments = await bulk(
    ctx.db
      .query('issue_attachments')
      .withIndex('by_org_task_archived_issue', (q) =>
        q.eq('org_id', a.orgId).eq('task_archived', undefined),
      ),
    ctx.db
      .query('issue_attachments')
      .withIndex('by_org_task_archived_issue', (q) =>
        q.eq('org_id', undefined).eq('task_archived', undefined),
      ),
    (row) => viewed.has(row.issue_id),
    1,
  )
  const links = await bulk(
    ctx.db
      .query('issue_links')
      .withIndex('by_org_task_archived_source', (q) =>
        q.eq('org_id', a.orgId).eq('task_archived', undefined),
      ),
    ctx.db
      .query('issue_links')
      .withIndex('by_org_task_archived_source', (q) =>
        q.eq('org_id', undefined).eq('task_archived', undefined),
      ),
    (row) => viewed.has(row.source_id) || viewed.has(row.target_id),
    2,
  )
  // a row without org_id joins its task's group out of the range's order
  const issueLabels: Groups<Doc<'issue_labels'>> =
    labels && inCreationOrder(groupBy(labels, (row) => row.issue_id))
  const issueAttachments: Groups<Doc<'issue_attachments'>> =
    attachments && inCreationOrder(groupBy(attachments, (row) => row.issue_id))
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
  // Every task's group is sorted by creation, so every task gets its rows in
  // the order its own indexes give.
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

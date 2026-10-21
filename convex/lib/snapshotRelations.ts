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
 * read task by task while the reads task by task so far fit the ranges the
 * transaction has left besides the table reads' own (OWN_RANGES), and at
 * most `ranges`, Convex's limit per transaction, which binds only when tests
 * lower it. Tests change these to force a read. */
export const RELATION_READ = { tasks: 512, ratio: 2, ranges: 4096 }

/* The rows a bulk read of one table takes, per range its read task by task
 * would cost (one per task for labels and attachments, two for links),
 * before it reads that table task by task instead. Convex allows about 8
 * documents per index range (32,000 to 4,096), and half that leaves room for
 * the other tables and the rest of the snapshot. With all three tables at
 * their caps, a view reads at most 16 rows per visible task. A task holds at
 * most ATTACHMENT_MAX attachments, LINK_MAX links and LABEL_MAX labels
 * (lib/taskLimits.ts), and as many dropped description images as
 * attachments (model/descriptionImages.ts DROPPED_IMAGES_MAX), so a read
 * task by task reads at most that many rows of each table per task. */
const BULK_ROWS_PER_RANGE = 4

/* The ranges the table reads take at once, before any read task by task:
 * for each of the three tables its capped or full read. */
const OWN_RANGES = 3

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
 * task so far fit RELATION_READ.ranges and the ranges the transaction has
 * left besides the table reads' own, else in full. Every row carries its
 * organization, so the organization's range holds all of them.
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
 * three tables. Not counting restored tasks, this rule costs no more ranges
 * than that one did:
 * - A view it read task by task cost one range per task for labels and
 *   attachments and two for links. Here it is read the same way, or each
 *   table costs its capped read, or that read plus those ranges.
 * - A view it read in bulk: these caps are at least its caps and count only
 *   unmarked rows, so a table read task by task here was read so there too,
 *   at the same cost, and it probed every table. It costs at most as much.
 * - A table is read in full only when reading it task by task would take the
 *   reads task by task past the ranges the transaction has left. The old read
 *   included those ranges, so it had passed the limit.
 * In documents, a table under its cap reads at most its cap, and one over it
 * reads its cap plus one before the visible tasks' own rows, which the old
 * rule read too. A table read in full reads every unmarked row of the
 * organization's table.
 *
 * The old rule failed for a restricted view of about 1,000 tasks whose three
 * tables are all dense, where those reads alone take about 4,000 ranges.
 * Here the last table that would not fit is read in full instead, so such a
 * view fails only if a full read passes 32,000 documents. The table reads'
 * own ranges are kept back, and the snapshot makes its seat's other reads
 * (labels, follows, inbox) before these, so the ranges left
 * already count them. A later seat of the same person is not counted: one
 * whose earlier seat's reads task by task used nearly all the ranges left
 * can still pass the limit in that later seat's own reads.
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
  // The ranges the transaction has left, which earlier reads of the
  // snapshot, such as another organization's relations, have used up part
  // of, less what the table reads take themselves.
  const { databaseQueries } = await ctx.meta.getTransactionMetrics()
  let budget = Math.min(
    RELATION_READ.ranges - 4 * restored.size,
    databaseQueries.remaining - OWN_RANGES,
  )
  const others = visible - restored.size
  /* One table's unmarked rows in bulk, or null to read it task by task
   * (`cost` ranges per task). */
  const bulk = async <Row>(
    rows: { take(n: number): Promise<Row[]>; collect(): Promise<Row[]> },
    cost: number,
  ): Promise<Row[] | null> => {
    if (others === 0) return null
    const ranges = cost * others
    if (ranges > budget) return await rows.collect()
    const cap = BULK_ROWS_PER_RANGE * ranges
    const capped = await rows.take(cap + 1)
    if (capped.length <= cap) return capped
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
  // the range orders each task's rows by creation, as its own index does
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

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

// The allocation counter bounds the org's task count without reading its
// archive. Small/restricted/archive-heavy views keep selective issue indexes.
// Cap each bulk read so an unusually dense relation table also falls back.
export async function snapshotRelations(
  ctx: QueryCtx,
  org: Doc<'organizations'>,
  visibleTaskCount: number,
) {
  const bulk = visibleTaskCount >= 32 && visibleTaskCount * 2 >= org.next_issue_num
  const limit = Math.min(4096, visibleTaskCount * 2)
  // Existing deployments can contain unscoped rows. A bounded probe keeps
  // their original indexed read path until those rows are replaced/deleted.
  // A foreign org's legacy row conservatively disables batching too.
  const legacy = bulk
    ? await Promise.all(
        (['issue_links', 'issue_labels', 'issue_attachments'] as const).map((table) =>
          ctx.db
            .query(table)
            .withIndex('by_org', (q) => q.eq('org_id', undefined))
            .first(),
        ),
      )
    : null
  const [links, labels, attachments] = bulk
    ? await Promise.all([
        legacy?.[0] === null
          ? ctx.db
              .query('issue_links')
              .withIndex('by_org', (q) => q.eq('org_id', org.id))
              .take(limit + 1)
          : null,
        legacy?.[1] === null
          ? ctx.db
              .query('issue_labels')
              .withIndex('by_org', (q) => q.eq('org_id', org.id))
              .take(limit + 1)
          : null,
        legacy?.[2] === null
          ? ctx.db
              .query('issue_attachments')
              .withIndex('by_org', (q) => q.eq('org_id', org.id))
              .take(limit + 1)
          : null,
      ])
    : [null, null, null]
  const sources =
    links !== null && links.length <= limit ? groupBy(links, (row) => row.source_id) : null
  const targets =
    links !== null && links.length <= limit ? groupBy(links, (row) => row.target_id) : null
  const issueLabels =
    labels !== null && labels.length <= limit ? groupBy(labels, (row) => row.issue_id) : null
  const issueAttachments =
    attachments !== null && attachments.length <= limit
      ? groupBy(attachments, (row) => row.issue_id)
      : null
  // Both index forms preserve creation order within an issue. Returning rows
  // issue by issue preserves the snapshot's existing stable array ordering.
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

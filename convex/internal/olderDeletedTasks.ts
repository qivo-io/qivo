/* A read-only count of the Deleted items rows stored before v0.1.122, the
 * first release that wrote the page's fields on deleted_tasks
 * (model/deletedItemsPage.ts olderRows). Such a row has neither
 * assignee_id nor deleted_at, so the page finds its task by number alone
 * and says `legacy` on a search or Assigned to page while one may exist.
 * Items expire 30 days after their delete, but a stuck item never does, so
 * only a look tells when none is left. It exists for the closing review's
 * one run per deployment, and goes with olderRows and `legacy` once that
 * run finds no such row anywhere.
 *
 * `count` reads one page of organizations (`page_size`, at most
 * PAGE.orgs) and, for each, the rows of deleted_tasks by_org_assignee with
 * both fields absent, at most `row_cap` (at most PAGE.rows) and one more
 * to tell whether there are more. For the distinct items those rows name,
 * up to PAGE.items an organization, it reads the deleted_items row for the
 * item's state and purge_after, which tell whether it waits for its expiry
 * or is stuck. It answers only the organizations that hold such a row, and
 * the cursor of the next page of organizations, null after the last. It
 * writes nothing and answers no task title. A page reads at most PAGE.orgs
 * organizations, PAGE.orgs x (PAGE.rows + 1) light rows (a row from before
 * v0.1.122 holds no search text) and PAGE.orgs x PAGE.items items, well
 * inside one query's limits.
 *
 * Run it read-only with the private helper, page by page until `next` is
 * null, passing `next` back as `cursor`:
 *   ~/projects/qivo-internal/scripts/with-deployment staging npx convex run internal/olderDeletedTasks:count '{}'
 *   ~/projects/qivo-internal/scripts/with-deployment staging npx convex run internal/olderDeletedTasks:count '{"cursor": "<next>"}'
 * On the demo, whose stored key cannot run internal functions, only with
 * the owner's approval of the one short-lived key command:
 *   ~/projects/qivo-internal/scripts/with-temp-deploy-key demo --allow deployment:functions:runInternalQueries -- npx convex run internal/olderDeletedTasks:count '{}'
 */
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import { internalQuery, type QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { badRequest } from '../lib/functions'

/** The most organizations a page reads (`orgs`), stored rows it reads in
 * one organization (`rows`, with one more to tell `more`) and items it
 * names there (`items`). `page_size` and `row_cap` lower the first two. */
export const PAGE = { orgs: 100, rows: 100, items: 10 }

/** One organization that holds rows stored before v0.1.122: how many the
 * page read (`rows`), whether more exist (`more`), and up to PAGE.items of
 * the items they belong to with their state and purge_after, null where
 * the item is gone. */
export type OlderRowsOfOrg = {
  org_id: string
  rows: number
  more: boolean
  items: {
    item_id: string
    state: Doc<'deleted_items'>['state'] | null
    purge_after: number | null
  }[]
}

/** One page of the count, and the cursor of the next, null after the last. */
export type OlderRowsPage = { orgs: OlderRowsOfOrg[]; next: string | null }

/* Whether `n` is a whole number from 1 to `most`. */
const within = (n: number, most: number) => Number.isInteger(n) && n >= 1 && n <= most

/**
 * One page of the count from `cursor` (none or null for the first), with
 * `page_size` organizations and `row_cap` rows an organization, each a
 * whole number from 1 to its PAGE default (the defaults when absent).
 */
export async function olderRowsPage(
  ctx: QueryCtx,
  a: { cursor?: string | null; page_size?: number; row_cap?: number },
): Promise<OlderRowsPage> {
  const size = a.page_size ?? PAGE.orgs
  const cap = a.row_cap ?? PAGE.rows
  if (!within(size, PAGE.orgs) || !within(cap, PAGE.rows))
    throw badRequest(
      `page_size takes 1 to ${PAGE.orgs} and row_cap 1 to ${PAGE.rows}, whole numbers`,
    )
  const page = await ctx.db
    .query('organizations')
    .paginate({ cursor: a.cursor ?? null, numItems: size })
  const orgs: OlderRowsOfOrg[] = []
  for (const org of page.page) {
    const rows = await ctx.db
      .query('deleted_tasks')
      .withIndex('by_org_assignee', (q) =>
        q.eq('org_id', org.id).eq('assignee_id', undefined).eq('deleted_at', undefined),
      )
      .take(cap + 1)
    if (rows.length === 0) continue
    const named = [...new Set(rows.slice(0, cap).map((row) => row.item_id))]
    const items: OlderRowsOfOrg['items'] = []
    for (const item_id of named.slice(0, PAGE.items)) {
      const item = await byId(ctx, 'deleted_items', item_id)
      items.push({ item_id, state: item?.state ?? null, purge_after: item?.purge_after ?? null })
    }
    orgs.push({ org_id: org.id, rows: Math.min(rows.length, cap), more: rows.length > cap, items })
  }
  return { orgs, next: page.isDone ? null : page.continueCursor }
}

/** One page of the count (the file comment), read-only. */
export const count = internalQuery({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    page_size: v.optional(v.number()),
    row_cap: v.optional(v.number()),
  },
  handler: (ctx, a): Promise<OlderRowsPage> => olderRowsPage(ctx, a),
})

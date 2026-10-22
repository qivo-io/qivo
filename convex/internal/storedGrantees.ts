/* One-time migration: give each grant and team share that Deleted items
 * stored before deleted_rows.grantee existed its grantee, the profile of a
 * grant or the team of a share. A project item's level checks read one
 * person's stored grants and their teams' stored shares by that field
 * (model/deletedItems.ts storedLevels), so a stored row without it counts for
 * nobody: the item lists for fewer people than it should, and a restore can
 * drop an assignee or reviewer whose access came from it. The restore itself
 * still writes every stored row back (restoreGrants).
 *
 * Run it once a deployment serves this release. The dry run writes nothing
 * and counts the rows it would change; running it again is safe. With the
 * private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/storedGrantees:backfill '{"dry_run": true}'
 *   "$H" staging npx convex run internal/storedGrantees:backfill '{"dry_run": false}'
 */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalAction, internalMutation } from '../_generated/server'

/** Stored rows per page; `page_size` lowers it in tests. */
const PAGE = 500

const TABLES = ['project_access', 'project_team_access'] as const
const vTable = v.union(v.literal('project_access'), v.literal('project_team_access'))

type Page = { missing: number; set: number; cursor: string; done: boolean }

const pageRef = makeFunctionReference<
  'mutation',
  {
    table: (typeof TABLES)[number]
    dry_run: boolean
    cursor: string | null
    page_size?: number
  },
  Page
>('internal/storedGrantees:page')

/** One page of `table`'s stored rows: how many lack their grantee, and how
 * many this call set (none in a dry run). */
export const page = internalMutation({
  args: {
    table: vTable,
    dry_run: v.boolean(),
    cursor: v.union(v.string(), v.null()),
    page_size: v.optional(v.number()),
  },
  handler: async (ctx, a): Promise<Page> => {
    const result = await ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) => q.eq('table', a.table))
      .paginate({ cursor: a.cursor, numItems: a.page_size ?? PAGE })
    let missing = 0
    let set = 0
    for (const row of result.page) {
      if (row.grantee !== undefined) continue
      const r = row.row
      const grantee =
        r.table === 'project_access'
          ? r.doc.profile_id
          : r.table === 'project_team_access'
            ? r.doc.team_id
            : undefined
      if (grantee === undefined) continue
      missing += 1
      if (a.dry_run) continue
      await ctx.db.patch(row._id, { grantee })
      set += 1
    }
    return { missing, set, cursor: result.continueCursor, done: result.isDone }
  },
})

/** Walks both tables page by page and answers, per table, the stored rows
 * that lacked their grantee and how many this run set. */
export const backfill = internalAction({
  args: { dry_run: v.boolean(), page_size: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const out: Record<(typeof TABLES)[number], { missing: number; set: number }> = {
      project_access: { missing: 0, set: 0 },
      project_team_access: { missing: 0, set: 0 },
    }
    for (const table of TABLES) {
      let cursor: string | null = null
      for (;;) {
        const p: Page = await ctx.runMutation(pageRef, {
          table,
          dry_run: a.dry_run,
          cursor,
          page_size: a.page_size,
        })
        out[table].missing += p.missing
        out[table].set += p.set
        if (p.done) break
        cursor = p.cursor
      }
    }
    return out
  },
})

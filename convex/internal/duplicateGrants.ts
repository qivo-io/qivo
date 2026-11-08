/* A read-only report of duplicate grant rows: two or more user grants of one
 * person on one project (project_access), or team shares of one team on one
 * project (project_team_access). No writer makes them, but a row that one
 * did would make every reader that expects one row a holder throw: the
 * access checks (lib/access.ts accessOf, grantOn and teamGrantOn) and the
 * name-ordered grant lists (lib/namedPages.ts readBatch, which refuses a
 * position that does not move), so a project with such rows cannot be read
 * or updated over REST and MCP until they are repaired. The closing review
 * runs this once on each hosted deployment, under the owner's decision of
 * 7 November 2026 that such reports run there and not before a release.
 *
 * `count` walks one table's holder index (by_project_profile or
 * by_project_team) in pages of `page_size` rows, never through the access
 * checks, which throw on the rows it looks for, and answers each run of
 * rows with one project and holder, their ids, and how many rows past the
 * first each organization holds (project_access has no org_id, so it reads
 * the project of each run it finds). Pass `cursor` and `last` from one
 * answer to the next until `done` is true; a run that spans two pages is
 * reported on both, each answer counting its own extra rows once. It writes
 * nothing, so a key that may run internal queries can run it:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/duplicateGrants:count \
 *     '{"table": "project_access", "cursor": null, "page_size": 1000}' */

import { v } from 'convex/values'
import { internalQuery } from '../_generated/server'
import { byId } from '../lib/db'

/* One row of the walk: its id, its project and its holder. */
const vRow = v.object({ id: v.string(), project_id: v.string(), holder_id: v.string() })

/** One page of the walk of `table`'s rows in project and holder order. */
export const count = internalQuery({
  args: {
    table: v.union(v.literal('project_access'), v.literal('project_team_access')),
    cursor: v.union(v.string(), v.null()),
    page_size: v.number(),
    /** the last row of the page before, so a run across two pages is found */
    last: v.optional(v.union(vRow, v.null())),
  },
  handler: async (ctx, a) => {
    if (!Number.isInteger(a.page_size) || a.page_size < 1 || a.page_size > 2000)
      throw new Error('page_size must be a whole number from 1 to 2000')
    const page =
      a.table === 'project_access'
        ? await ctx.db
            .query('project_access')
            .withIndex('by_project_profile')
            .paginate({ cursor: a.cursor, numItems: a.page_size })
        : await ctx.db
            .query('project_team_access')
            .withIndex('by_project_team')
            .paginate({ cursor: a.cursor, numItems: a.page_size })
    const rows = page.page.map((row) => ({
      id: row._id,
      project_id: row.project_id,
      holder_id: 'profile_id' in row ? row.profile_id : row.team_id,
    }))
    const runs: { project_id: string; holder_id: string; ids: string[] }[] = []
    let prev = a.last ?? null
    for (const row of rows) {
      if (prev !== null && prev.project_id === row.project_id && prev.holder_id === row.holder_id) {
        const run = runs.at(-1)
        if (
          run !== undefined &&
          run.project_id === row.project_id &&
          run.holder_id === row.holder_id
        )
          run.ids.push(row.id)
        else
          runs.push({
            project_id: row.project_id,
            holder_id: row.holder_id,
            ids: [prev.id, row.id],
          })
      }
      prev = row
    }
    const byOrg: Record<string, number> = {}
    const duplicates: {
      org_id: string | null
      project_id: string
      holder_id: string
      ids: string[]
    }[] = []
    for (const run of runs) {
      const project = await byId(ctx, 'projects', run.project_id)
      const orgId = project?.org_id ?? null
      const key = orgId ?? 'no project'
      byOrg[key] = (byOrg[key] ?? 0) + run.ids.length - 1
      duplicates.push({ org_id: orgId, ...run })
    }
    return {
      table: a.table,
      duplicates,
      by_org: byOrg,
      cursor: page.continueCursor,
      done: page.isDone,
      last: prev,
    }
  },
})

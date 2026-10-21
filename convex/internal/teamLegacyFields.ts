/* One-time migration: clear the retired team columns archive_days,
 * stale_days and max_attachment_mb.
 *
 * Nothing reads or writes them any more. The nightly archive uses
 * DEFAULT_ARCHIVE_DAYS for every project (jobs.ts), the Stale filter its own
 * 120 days, and uploads the organization's limit. The schema keeps them
 * optional (schema.ts teams) so that a deployment whose teams still hold
 * them accepts this release. Once every deployment reports zero, a later
 * release drops them from the schema, and this file with them.
 *
 * Check a deployment before changing it. `check` is a query, so it cannot
 * write, and a key that may only run internal queries can run it. It counts
 * the teams of one page that still hold a column. Pass the returned
 * `cursor` back until `done` is true. If every page reports zero `teams`,
 * the deployment has nothing to clear. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/teamLegacyFields:check
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). Read the dry run, which writes nothing:
 *   "$H" staging npx convex run internal/teamLegacyFields:clear '{"dry_run": true}'
 * Then clear the columns and check again:
 *   "$H" staging npx convex run internal/teamLegacyFields:clear '{"dry_run": false}'
 *
 * On the demo, whose stored key cannot run internal functions, the private
 * with-temp-deploy-key helper runs each command with a short-lived key:
 * `check` needs deployment:functions:runInternalQueries and `clear`, an
 * internal action, deployment:functions:runInternalActions.
 *
 * The results hold counts only. Running it again is safe, and a clean
 * deployment reports zeros. It writes no activity and changes nothing a
 * person sees. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import {
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from '../_generated/server'

/** Teams per page, for the check and for each step of the clear. A team
 * row is small, so a page stays far inside one transaction's limits. */
const PAGE = 500

/** What one page found, and where the next one starts. */
type PageResult = { teams: number; cursor: string; done: boolean }

const pageRef = makeFunctionReference<
  'mutation',
  { dry_run: boolean; cursor: string | null },
  PageResult
>('internal/teamLegacyFields:page')

/* Whether a team still holds one of the retired columns. */
const holdsLegacy = (team: Doc<'teams'>): boolean =>
  team.archive_days !== undefined ||
  team.stale_days !== undefined ||
  team.max_attachment_mb !== undefined

/* One page of teams from `cursor`, with the ones holding a retired column.
 * The check and the clear share it, so both find the same teams. */
async function legacyTeams(ctx: QueryCtx, cursor: string | null) {
  const result = await ctx.db.query('teams').paginate({ cursor, numItems: PAGE })
  return {
    teams: result.page.filter(holdsLegacy),
    cursor: result.continueCursor,
    done: result.isDone,
  }
}

/** One page of teams in its own transaction: clears the retired columns,
 * or only counts them with `dry_run`. Clearing changes no index, so the
 * cursor stays valid. */
export const page = internalMutation({
  args: { dry_run: v.boolean(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { dry_run, cursor }): Promise<PageResult> => {
    const found = await legacyTeams(ctx, cursor)
    if (!dry_run) {
      for (const team of found.teams) {
        // ctx.db.patch unsets a key whose value is undefined
        await ctx.db.patch(team._id, {
          archive_days: undefined,
          stale_days: undefined,
          max_attachment_mb: undefined,
        })
      }
    }
    return { teams: found.teams.length, cursor: found.cursor, done: found.done }
  },
})

/** Counts, without writing, the teams of one page that still hold a retired
 * column. Leave out `cursor`, or pass null, for the first page, then call
 * again with the returned `cursor` until `done`. */
export const check = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }): Promise<PageResult> => {
    const found = await legacyTeams(ctx, cursor ?? null)
    return { teams: found.teams.length, cursor: found.cursor, done: found.done }
  },
})

/** Walks every page and reports how many teams it cleared, or would clear. */
export const clear = internalAction({
  args: { dry_run: v.boolean() },
  handler: async (ctx, { dry_run }): Promise<{ dry_run: boolean; teams: number }> => {
    let teams = 0
    let cursor: string | null = null
    for (;;) {
      const result: PageResult = await ctx.runMutation(pageRef, { dry_run, cursor })
      teams += result.teams
      if (result.done) break
      cursor = result.cursor
    }
    return { dry_run, teams }
  },
})

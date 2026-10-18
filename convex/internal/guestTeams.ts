/* One-time repair: remove the team memberships guests still hold.
 *
 * A guest is never a team member (teams.addMember). Before every role change
 * followed that rule, a seat could become a guest and keep its team rows,
 * leadership included. Those rows grant nothing, because team access and
 * leadership ignore guests, but the snapshot still sends them, so the app
 * can list a guest under a team (Team Sync's team scope). Seats that become
 * guests now leave every team (leaveAllTeams), so only older data needs this.
 *
 * Check a deployment before repairing it. `check` is a query, so it cannot
 * write, and a key that may only run internal queries can run it. It counts
 * the rows guests hold in one page of team_members. Pass the returned
 * `cursor` back until `done` is true. `memberships` and `leaderships` add up
 * across pages, while `guests` counts the distinct guests of one page. If
 * every page reports zero `memberships`, the deployment has nothing to
 * repair.
 *
 * Name the deployment with the private helper, which refuses to run without
 * the target's key, because without a key the CLI runs against the
 * deployment in .env.local. For example, to check staging:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/guestTeams:check '{"cursor": null}'
 *
 * Where the check finds rows, and only with the user's approval, repair the
 * deployment once. On production, take and verify a backup first
 * (docs/deployment.md). Read the dry run, which writes nothing:
 *   "$H" staging npx convex run internal/guestTeams:repair '{"dry_run": true}'
 * Then run the repair, which deletes the rows, and check again:
 *   "$H" staging npx convex run internal/guestTeams:repair '{"dry_run": false}'
 * Record each check and run in qivo-internal docs/verification.md.
 *
 * The demo backend's stored key cannot run internal functions, so on the
 * demo the private with-temp-deploy-key helper runs each command with a
 * short-lived key that allows only the listed actions, then deletes it
 * (qivo-internal docs/public-demo-operations.md). `check` needs
 * deployment:functions:runInternalQueries, and `repair`, an internal
 * action, needs deployment:functions:runInternalActions:
 *   T="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-temp-deploy-key"
 *   "$T" demo --allow deployment:functions:runInternalQueries --purpose guest-teams -- \
 *     npx convex run internal/guestTeams:check '{"cursor": null}'
 *   "$T" demo --allow deployment:functions:runInternalActions --purpose guest-teams -- \
 *     npx convex run internal/guestTeams:repair '{"dry_run": true}'
 *
 * The results hold counts only. Re-running the repair is safe, and a clean
 * deployment reports zeros. Like leaveAllTeams it writes no activity. A team
 * whose only leader was a guest is left without one; its organization's
 * admins run it. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import {
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from '../_generated/server'
import { byId } from '../lib/db'

/* team_members rows per repair step. */
const PAGE = 256

/* The most team_members rows one `check` call reads, and its default. With
 * one profile read per row, a call stays far inside a query's read limits. */
const CHECK_PAGE = 1_000

type PageResult = {
  memberships: number
  leaderships: number
  guests: string[]
  cursor: string
  done: boolean
}

const pageRef = makeFunctionReference<
  'mutation',
  { dry_run: boolean; cursor: string | null },
  PageResult
>('internal/guestTeams:page')

/** Reads up to `numItems` team_members rows from `cursor` and keeps the ones
 * guests hold, with their counts, the distinct guests and where the next
 * page starts. Shared by the repair and the check so both find the same
 * rows. */
async function staleRows(ctx: QueryCtx, cursor: string | null, numItems: number) {
  const result = await ctx.db.query('team_members').paginate({ cursor, numItems })
  const rows: Doc<'team_members'>[] = []
  for (const row of result.page) {
    const profile = await byId(ctx, 'profiles', row.profile_id)
    if (profile?.org_role === 'guest') rows.push(row)
  }
  return {
    rows,
    memberships: rows.length,
    leaderships: rows.filter((row) => row.is_leader).length,
    guests: new Set(rows.map((row) => row.profile_id)),
    cursor: result.continueCursor,
    done: result.isDone,
  }
}

/** One page of team_members in its own transaction. A deleted row cannot
 * move the cursor, so the next page starts where this one ended. */
export const page = internalMutation({
  args: { dry_run: v.boolean(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { dry_run, cursor }): Promise<PageResult> => {
    const found = await staleRows(ctx, cursor, PAGE)
    if (!dry_run) for (const row of found.rows) await ctx.db.delete(row._id)
    return {
      memberships: found.memberships,
      leaderships: found.leaderships,
      guests: [...found.guests],
      cursor: found.cursor,
      done: found.done,
    }
  },
})

/** Counts, without writing, the team rows guests hold in one page of
 * team_members. Read-only by construction, so it can run with a key that
 * may only run internal queries. Call again with `cursor` until `done`.
 * `limit` sets the page size, CHECK_PAGE rows by default and at most.
 * `guests` counts the distinct guests of this page only. */
export const check = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), limit: v.optional(v.number()) },
  handler: async (ctx, { cursor, limit }) => {
    const numItems = Math.min(CHECK_PAGE, Math.max(1, Math.floor(limit ?? CHECK_PAGE)))
    const found = await staleRows(ctx, cursor, numItems)
    return {
      memberships: found.memberships,
      leaderships: found.leaderships,
      guests: found.guests.size,
      cursor: found.cursor,
      done: found.done,
    }
  },
})

/** Walks every page and reports what it removed, or would remove. */
export const repair = internalAction({
  args: { dry_run: v.boolean() },
  handler: async (ctx, { dry_run }) => {
    const guests = new Set<string>()
    let memberships = 0
    let leaderships = 0
    let cursor: string | null = null
    for (;;) {
      const result: PageResult = await ctx.runMutation(pageRef, { dry_run, cursor })
      memberships += result.memberships
      leaderships += result.leaderships
      for (const id of result.guests) guests.add(id)
      if (result.done) break
      cursor = result.cursor
    }
    return { dry_run, memberships, leaderships, guests: guests.size }
  },
})

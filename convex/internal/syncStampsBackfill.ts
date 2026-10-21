/* One-time migration: move each person's Team sync stamp off their profile
 * (the retired profiles.sync_at and sync_since) into a sync_stamps row
 * (model/syncStamps.ts), and clear the profile fields, so a later release
 * can drop them from the schema.
 *
 * A person who already has a row keeps it, because only the stamp mutation
 * writes rows and it reads the profile fields as the previous stamp, so the
 * row is the newer one. Their profile fields are only cleared. A profile
 * with sync_since but no sync_at holds no stamp (model/syncStamps.ts
 * legacyStamp), so it is only cleared too. Deleted items keep no profile
 * copies (lib/enums.ts STORED_TABLES), so profiles are the only table.
 *
 * The schema keeps the profile fields optional (schema.ts) so that a
 * deployment whose profiles still hold them accepts this release, and the
 * readers fall back to them until this has run. Once every deployment
 * reports zero, a later release drops the fields from the schema.
 *
 * Check a deployment before changing it. `remaining` is a query, so it
 * cannot write, and a key that may only run internal queries can run it. It
 * counts the profiles of one page that still hold a stamp field. Pass the
 * returned `cursor` back until `done` is true. If every page reports zero
 * `rows`, the deployment has nothing to move. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/syncStampsBackfill:remaining '{}'
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). Read the dry run, which writes nothing, then move
 * the stamps and check again:
 *   "$H" staging npx convex run internal/syncStampsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/syncStampsBackfill:run '{"dry_run": false}'
 *
 * On the demo, whose stored key cannot run internal functions, the private
 * with-temp-deploy-key helper runs each command with a short-lived key:
 * `remaining` needs deployment:functions:runInternalQueries and `run`, an
 * internal action, deployment:functions:runInternalActions.
 *
 * A run that writes adds one platform_audit_log row (action
 * 'sync_stamps_backfill', actor 'system') with its counts. The results hold
 * counts only. Running it again is safe, and a clean deployment reports
 * zeros. It writes no activity and changes nothing a person sees. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from '../_generated/server'
import { legacyStamp, stampRow, writeStamp } from '../model/syncStamps'

/** Profiles per page, for the check and for each step of the run, and the
 * bytes one page may read. Each profile that holds a field also reads its
 * stamp row and writes at most two documents, well inside Convex's limits.
 * Tests lower `rows`. */
export const BACKFILL_PAGE = { rows: 500, bytes: 4 * 1024 * 1024 }

/** What one page found, and where the next one starts. `moved` counts the
 * profiles whose stamp became a new row, the rest of `rows` were only
 * cleared. */
type PageResult = { rows: number; moved: number; cursor: string; done: boolean }

const pageRef = makeFunctionReference<
  'mutation',
  { dry_run: boolean; cursor: string | null },
  PageResult
>('internal/syncStampsBackfill:page')

const auditRef = makeFunctionReference<'mutation', { rows: number; moved: number }, null>(
  'internal/syncStampsBackfill:audit',
)

/* Whether a profile still holds a retired stamp field. */
const holds = (profile: Doc<'profiles'>): boolean =>
  profile.sync_at !== undefined || profile.sync_since !== undefined

/* One page of profiles from `cursor`: how many still hold a stamp field and
 * how many of those have no row yet, and, unless `write` is null, moves
 * each stamp into a row and clears the fields. The check and the run share
 * it, so both find the same profiles. Clearing changes no index the page is
 * read by, so the cursor stays valid. */
async function walk(
  ctx: QueryCtx,
  cursor: string | null,
  write: MutationCtx | null,
): Promise<PageResult> {
  const page = await ctx.db
    .query('profiles')
    .paginate({ cursor, numItems: BACKFILL_PAGE.rows, maximumBytesRead: BACKFILL_PAGE.bytes })
  const held = page.page.filter(holds)
  let moved = 0
  for (const profile of held) {
    const stamp = legacyStamp(profile)
    const fresh = stamp !== null && (await stampRow(ctx, profile.id)) === null
    if (fresh) moved++
    if (write === null) continue
    if (fresh) await writeStamp(write, profile, stamp)
    // ctx.db.patch unsets a key whose value is undefined
    await write.db.patch(profile._id, { sync_at: undefined, sync_since: undefined })
  }
  return { rows: held.length, moved, cursor: page.continueCursor, done: page.isDone }
}

/** One page in its own transaction: moves and clears the stamps, or only
 * counts them with `dry_run`. */
export const page = internalMutation({
  args: { dry_run: v.boolean(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { dry_run, cursor }): Promise<PageResult> =>
    await walk(ctx, cursor, dry_run ? null : ctx),
})

/** Counts, without writing, the profiles of one page that still hold a
 * stamp field, and how many of them have no row yet. Leave out `cursor`, or
 * pass null, for the first page, then call again with the returned `cursor`
 * until `done`. */
export const remaining = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }): Promise<PageResult> => await walk(ctx, cursor ?? null, null),
})

/** Records a run that wrote, with its counts. */
export const audit = internalMutation({
  args: { rows: v.number(), moved: v.number() },
  handler: async (ctx, counts) => {
    await ctx.db.insert('platform_audit_log', {
      ts: new Date().toISOString(),
      actor_email: 'system',
      action: 'sync_stamps_backfill',
      detail: counts,
    })
    return null
  },
})

/** Walks every page and reports how many profiles it cleared, or would
 * clear, and how many of their stamps became rows. A run that writes ends
 * with its audit row. */
export const run = internalAction({
  args: { dry_run: v.boolean() },
  handler: async (ctx, { dry_run }): Promise<{ dry_run: boolean; rows: number; moved: number }> => {
    const counts = { rows: 0, moved: 0 }
    let cursor: string | null = null
    for (;;) {
      const result: PageResult = await ctx.runMutation(pageRef, { dry_run, cursor })
      counts.rows += result.rows
      counts.moved += result.moved
      if (result.done) break
      cursor = result.cursor
    }
    if (!dry_run) await ctx.runMutation(auditRef, counts)
    return { dry_run, ...counts }
  },
})

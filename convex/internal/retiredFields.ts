/* One-time migration: clear the retired fields that no code reads or writes
 * any more, so a later release can drop them from the schema.
 *
 * - teams: archive_days, stale_days and max_attachment_mb. The nightly
 *   archive uses DEFAULT_ARCHIVE_DAYS for every project (jobs.ts), the Stale
 *   filter its own 120 days, and uploads the organization's limit.
 * - issue_attachments: project_id. Storage totals read a row's project
 *   through its task (model/billing.ts storagePage), so a move writes no
 *   attachment row. The copies Deleted items keeps (deleted_rows, table
 *   issue_attachments) are cleared too, because Convex validates them
 *   against the same table validator.
 *
 * The schema keeps these fields optional (schema.ts) so that a deployment
 * whose rows still hold them accepts this release. Once every deployment
 * reports zero, a later release drops them from the schema, and this file
 * with them.
 *
 * Check a deployment before changing it. `check` is a query, so it cannot
 * write, and a key that may only run internal queries can run it. It counts
 * the rows of one page of one `phase` that still hold a retired field. Pass
 * the returned `cursor` back until `done` is true, for each phase. If every
 * page reports zero `rows`, the deployment has nothing to clear. With the
 * private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/retiredFields:check '{"phase": "teams"}'
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). Read the dry run, which writes nothing, then clear
 * the fields and check again:
 *   "$H" staging npx convex run internal/retiredFields:clear '{"dry_run": true}'
 *   "$H" staging npx convex run internal/retiredFields:clear '{"dry_run": false}'
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
  type MutationCtx,
  type QueryCtx,
} from '../_generated/server'

/** Rows per page, for the check and for each step of the clear, and the
 * bytes one page may read. An attachment row stored before its name was
 * capped, or a stored copy, has no fixed size, so a page can end early,
 * and the cursor goes on from there. */
const PAGE = 500
const PAGE_BYTES = 4 * 1024 * 1024

/** The tables the migration walks, in the order the clear runs them. */
const PHASES = ['teams', 'attachments', 'stored_attachments'] as const
const vPhase = v.union(...PHASES.map((phase) => v.literal(phase)))
type Phase = (typeof PHASES)[number]

/** What one page found, and where the next one starts. */
type PageResult = { rows: number; cursor: string; done: boolean }

const pageRef = makeFunctionReference<
  'mutation',
  { phase: Phase; dry_run: boolean; cursor: string | null },
  PageResult
>('internal/retiredFields:page')

/* Whether a team still holds one of its retired fields. */
const teamHolds = (team: Doc<'teams'>): boolean =>
  team.archive_days !== undefined ||
  team.stale_days !== undefined ||
  team.max_attachment_mb !== undefined

/* Whether a stored row is an attachment copy that still holds project_id. */
const storedHolds = (row: Doc<'deleted_rows'>): boolean =>
  row.row.table === 'issue_attachments' && row.row.doc.project_id !== undefined

/* One page of `phase` from `cursor`: how many of its rows hold a retired
 * field, and, unless `write` is null, clears it on each with `write`. The
 * check and the clear share it, so both find the same rows. Clearing changes
 * no index a page is read by, so the cursor stays valid. */
async function walk(
  ctx: QueryCtx,
  phase: Phase,
  cursor: string | null,
  write: MutationCtx | null,
): Promise<PageResult> {
  if (phase === 'teams') {
    const page = await ctx.db
      .query('teams')
      .paginate({ cursor, numItems: PAGE, maximumBytesRead: PAGE_BYTES })
    const held = page.page.filter(teamHolds)
    for (const team of held) {
      // ctx.db.patch unsets a key whose value is undefined
      await write?.db.patch(team._id, {
        archive_days: undefined,
        stale_days: undefined,
        max_attachment_mb: undefined,
      })
    }
    return { rows: held.length, cursor: page.continueCursor, done: page.isDone }
  }
  if (phase === 'attachments') {
    const page = await ctx.db
      .query('issue_attachments')
      .paginate({ cursor, numItems: PAGE, maximumBytesRead: PAGE_BYTES })
    const held = page.page.filter((row) => row.project_id !== undefined)
    for (const row of held) await write?.db.patch(row._id, { project_id: undefined })
    return { rows: held.length, cursor: page.continueCursor, done: page.isDone }
  }
  const page = await ctx.db
    .query('deleted_rows')
    .withIndex('by_row', (q) => q.eq('table', 'issue_attachments'))
    .paginate({ cursor, numItems: PAGE, maximumBytesRead: PAGE_BYTES })
  const held = page.page.filter(storedHolds)
  for (const row of held) {
    if (row.row.table !== 'issue_attachments') continue
    const { project_id: _retired, ...doc } = row.row.doc
    await write?.db.patch(row._id, { row: { table: 'issue_attachments', doc } })
  }
  return { rows: held.length, cursor: page.continueCursor, done: page.isDone }
}

/** One page of one phase in its own transaction: clears the retired
 * fields, or only counts them with `dry_run`. */
export const page = internalMutation({
  args: { phase: vPhase, dry_run: v.boolean(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { phase, dry_run, cursor }): Promise<PageResult> =>
    await walk(ctx, phase, cursor, dry_run ? null : ctx),
})

/** Counts, without writing, the rows of one page of `phase` that still hold
 * a retired field. Leave out `cursor`, or pass null, for the first page,
 * then call again with the returned `cursor` until `done`. */
export const check = internalQuery({
  args: { phase: vPhase, cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { phase, cursor }): Promise<PageResult> =>
    await walk(ctx, phase, cursor ?? null, null),
})

/** Walks every page of every phase and reports, per phase, how many rows it
 * cleared, or would clear. */
export const clear = internalAction({
  args: { dry_run: v.boolean() },
  handler: async (ctx, { dry_run }): Promise<{ dry_run: boolean } & Record<Phase, number>> => {
    const counts: Record<Phase, number> = { teams: 0, attachments: 0, stored_attachments: 0 }
    for (const phase of PHASES) {
      let cursor: string | null = null
      for (;;) {
        const result: PageResult = await ctx.runMutation(pageRef, { phase, dry_run, cursor })
        counts[phase] += result.rows
        if (result.done) break
        cursor = result.cursor
      }
    }
    return { dry_run, ...counts }
  },
})

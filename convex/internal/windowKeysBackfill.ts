/* One-time migration: give every task and project stored before window
 * keys existed a window key (schema.ts `window_key`, lib/db.ts
 * newWindowKey), so the app's windows spread them (lib/workspaceParts.ts),
 * and each task's relation rows (label assignments, attachments, follows
 * and the links from it) the same key as `task_key`, in the transaction
 * that gives the task its key. A relation row whose key differs from its
 * task's gets the task's, too, so a run also repairs those.
 *
 * Until it runs, a row without a key sorts first and loads in the first
 * window of its kind, its relation rows with it, so the app still shows it,
 * but an organization with more such tasks than one window holds cannot
 * load. New rows get a key when they are inserted. Deleted items keep their
 * stored copies as they were, and a restore gives a copy stored before keys
 * a key as it writes it back, its relation rows with it
 * (model/deletedItems.ts storedTaskKey, cleanProject).
 *
 * Check a deployment before changing it. `remaining` is a query, so it
 * cannot write, and a key that may only run internal queries can run it. It
 * counts the rows of one page of a table that still have no key, and for
 * tasks that have one, their relation rows without it. Start with
 * `{"table": "issues"}`, pass the returned `cursor` back until `done` is
 * true, then do the same for `"projects"`. If every page reports zero
 * `rows`, the deployment has nothing to give a key. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/windowKeysBackfill:remaining '{"table": "issues"}'
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). Read the dry run, which writes nothing, then give
 * the keys and check again:
 *   "$H" staging npx convex run internal/windowKeysBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/windowKeysBackfill:run '{"dry_run": false}'
 *
 * On the demo, whose stored key cannot run internal functions, the private
 * with-temp-deploy-key helper runs each command with a short-lived key:
 * `remaining` needs deployment:functions:runInternalQueries and `run`, an
 * internal action, deployment:functions:runInternalActions.
 *
 * A run that writes adds one platform_audit_log row (action
 * 'window_keys_backfill', actor 'system') with its counts. The results hold
 * counts only. Running it again is safe, and a clean deployment reports
 * zeros. It writes no activity, sends no task event and changes nothing a
 * person sees, except which window of the app holds a row. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { newWindowKey } from '../lib/db'

/** Rows per page of each table, for the check and for each step of the
 * run, and the bytes one page may read. A project without a key writes one
 * patch. A task may write one for itself and each of its relation rows,
 * which LIMITS bounds to about 420, so 25 tasks stay inside Convex's 16,000
 * writes. Tests lower them. */
export const BACKFILL_PAGE = {
  rows: { issues: 25, projects: 500 },
  bytes: 4 * 1024 * 1024,
}

const vTable = v.union(v.literal('issues'), v.literal('projects'))
type KeyedTable = 'issues' | 'projects'
const TABLES: readonly KeyedTable[] = ['issues', 'projects']

/** What one page found, and where the next one starts. */
type PageResult = { rows: number; cursor: string; done: boolean }

const pageRef = makeFunctionReference<
  'mutation',
  { table: KeyedTable; dry_run: boolean; cursor: string | null },
  PageResult
>('internal/windowKeysBackfill:page')

const auditRef = makeFunctionReference<'mutation', { issues: number; projects: number }, null>(
  'internal/windowKeysBackfill:audit',
)

/* The relation rows of task `id` whose task_key is not `key`, every one
 * for null (a task about to get its first key). */
async function strayRows(ctx: QueryCtx, id: string, key: string | null) {
  const [labels, attachments, links, follows] = await Promise.all([
    ctx.db
      .query('issue_labels')
      .withIndex('by_issue', (q) => q.eq('issue_id', id))
      .collect(),
    ctx.db
      .query('issue_attachments')
      .withIndex('by_issue', (q) => q.eq('issue_id', id))
      .collect(),
    ctx.db
      .query('issue_links')
      .withIndex('by_source', (q) => q.eq('source_id', id))
      .collect(),
    ctx.db
      .query('issue_subscriptions')
      .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', id))
      .collect(),
  ])
  return [...labels, ...attachments, ...links, ...follows].filter(
    (row) => key === null || row.task_key !== key,
  )
}

/* One page of `table` from `cursor`: how many rows have no window key, and
 * how many relation rows of the page's tasks have not their task's, and,
 * unless `write` is null, gives each the key. The check and the run share
 * it, so both find the same rows. The page is read in creation order, which
 * a key does not change, so the cursor stays valid. */
async function walk(
  ctx: QueryCtx,
  table: KeyedTable,
  cursor: string | null,
  write: MutationCtx | null,
): Promise<PageResult> {
  const page = await ctx.db.query(table).paginate({
    cursor,
    numItems: BACKFILL_PAGE.rows[table],
    maximumBytesRead: BACKFILL_PAGE.bytes,
  })
  let rows = 0
  for (const row of page.page) {
    // a check writes nothing, so it picks no key
    const key = row.window_key ?? (write === null ? '' : newWindowKey())
    if (row.window_key === undefined) {
      rows++
      if (write !== null) await write.db.patch(row._id, { window_key: key })
    }
    if (table !== 'issues') continue
    const stray = await strayRows(ctx, row.id, row.window_key ?? null)
    rows += stray.length
    if (write !== null) for (const r of stray) await write.db.patch(r._id, { task_key: key })
  }
  return { rows, cursor: page.continueCursor, done: page.isDone }
}

/** One page in its own transaction: gives the keys, or only counts the rows
 * without one with `dry_run`. */
export const page = internalMutation({
  args: { table: vTable, dry_run: v.boolean(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, dry_run, cursor }): Promise<PageResult> =>
    await walk(ctx, table, cursor, dry_run ? null : ctx),
})

/** Counts, without writing, the rows of one page of `table` that have no
 * window key. Leave out `cursor`, or pass null, for the first page, then
 * call again with the returned `cursor` until `done`. */
export const remaining = internalQuery({
  args: { table: vTable, cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { table, cursor }): Promise<PageResult> =>
    await walk(ctx, table, cursor ?? null, null),
})

/** Records a run that wrote, with its counts. */
export const audit = internalMutation({
  args: { issues: v.number(), projects: v.number() },
  handler: async (ctx, counts) => {
    await ctx.db.insert('platform_audit_log', {
      ts: new Date().toISOString(),
      actor_email: 'system',
      action: 'window_keys_backfill',
      detail: counts,
    })
    return null
  },
})

/** Walks every page of both tables and reports how many rows it gave a key,
 * or would give one. A run that writes ends with its audit row. */
export const run = internalAction({
  args: { dry_run: v.boolean() },
  handler: async (
    ctx,
    { dry_run },
  ): Promise<{ dry_run: boolean; issues: number; projects: number }> => {
    const counts = { issues: 0, projects: 0 }
    for (const table of TABLES) {
      let cursor: string | null = null
      for (;;) {
        const result: PageResult = await ctx.runMutation(pageRef, { table, dry_run, cursor })
        counts[table] += result.rows
        if (result.done) break
        cursor = result.cursor
      }
    }
    if (!dry_run) await ctx.runMutation(auditRef, counts)
    return { dry_run, ...counts }
  },
})

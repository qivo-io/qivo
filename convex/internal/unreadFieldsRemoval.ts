/* One-time migration that unsets fields earlier releases stored and no code
 * sets now (schema.ts): the window keys, `window_key` on tasks and
 * projects and `task_key` on a task's label assignments, attachments,
 * follows and the links from it, and `last_export_at` on organizations and
 * `up_to` on upload tickets (attachment_uploads). It unsets them in the
 * live tables and, for the window keys, in the copies Deleted items keeps
 * of those rows (deleted_rows), which Convex checks against the same
 * validators. No code sets any of them: a create leaves them out, a move
 * to Deleted items stores a copy without a key, and a restore writes a row
 * back without one (model/deletedItems.ts wrapRow, cleanProject,
 * writeRowBack, placeLinkBy, writeTask). So the rows and copies that hold a
 * field only get fewer, a row that moves between a live table and
 * deleted_rows while a run is in progress loses its key on the way, and
 * once a full dry run reports zeros, this release gives no row or copy one
 * again. The schema can then drop the fields.
 *
 * A run walks the tables in FIELDS order, each table's live rows and then,
 * for a table Deleted items stores, its stored copies, a page at a time,
 * each page in its own transaction. Live rows are read in creation order
 * and stored copies through deleted_rows by_row, whose table and row id no
 * writer changes, so an unset moves no row and the cursor stays valid. It
 * unsets a field with a plain patch, not model/descriptions.ts patchTask or
 * patchTaskRow, so it writes no activity, sends no task event or webhook
 * and changes no updated_at, counter or search text. The app reads none of
 * the fields. The workspace's root part answers an organization's
 * `last_export_at`, and an organization export holds it, when the row holds
 * the field at the time they read it.
 *
 * Check a deployment first. `check` is a query, so it writes nothing, and a
 * key that may only run internal queries can run it. It counts the rows of
 * one page of one table that hold the table's field: its live rows, or its
 * stored copies with `"stored": true`. Leave out `cursor` for the first
 * page and pass the returned `cursor` back until `done` is true, for each
 * table, and for each table Deleted items stores with both values of
 * `stored`. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/unreadFieldsRemoval:check '{"table": "issues", "stored": false}'
 *
 * Run it only after the deployment serves this release, and only with
 * approval. On production, take and verify a backup first
 * (qivo-internal docs/deployment.md). Read the dry run, which writes
 * nothing, then unset the fields, then read the dry run again, which must
 * report zeros:
 *   "$H" staging npx convex run internal/unreadFieldsRemoval:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/unreadFieldsRemoval:run '{"dry_run": false}'
 * A call checks the time after each page and stops past RUN.ms, well inside
 * Convex's action time limit. It then answers `done: false` with a
 * `cursor`. Call it again with the same `dry_run` and `"cursor"` set to
 * that value until `done` is true. A page that throws stops the call with
 * `error`, the counts of the pages before it and the cursor of that page.
 * Each call counts from zero, so a dry run shows no field only
 * when it started without a cursor, went on until `done` was true, and
 * every call of it reported zeros.
 *
 * On the demo, whose stored key cannot run internal functions, the private
 * with-temp-deploy-key helper runs each command with a short-lived key:
 * `check` needs deployment:functions:runInternalQueries and `run`, an
 * internal action, deployment:functions:runInternalActions.
 *
 * A call with `"dry_run": false` that accepts its cursor ends by adding one
 * platform_audit_log row (action 'unread_fields_removal', actor 'system')
 * with its counts, whether it finished, its cursor and its error. A call
 * the backend ends before it answers can leave no row for the pages it
 * committed, so the dry run afterwards is what shows the state. Running it
 * again is safe, and a deployment without the fields reports zeros. A
 * backend rolled back to a release before this one writes window keys
 * again, so run it again once the deployment serves this release or a
 * later one again. */
import { makeFunctionReference } from 'convex/server'
import { type Infer, v } from 'convex/values'
import type { Doc, TableNames } from '../_generated/dataModel'
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from '../_generated/server'
import { isStoredTable } from '../lib/enums'
import { MIB } from '../lib/limits'
import { audit as writeAudit } from '../model/admin'

/** The field each table loses, in the order a run walks the tables. A
 * table that Deleted items stores (lib/enums.ts STORED_TABLES) has its
 * stored copies walked too, after its live rows. */
const FIELDS = {
  issues: 'window_key',
  projects: 'window_key',
  issue_labels: 'task_key',
  issue_attachments: 'task_key',
  issue_links: 'task_key',
  issue_subscriptions: 'task_key',
  organizations: 'last_export_at',
  attachment_uploads: 'up_to',
} as const satisfies { [T in TableNames]?: keyof Doc<T> }

type Table = keyof typeof FIELDS
type Field = (typeof FIELDS)[Table]

const UNSET = {
  window_key: { window_key: undefined },
  task_key: { task_key: undefined },
  last_export_at: { last_export_at: undefined },
  up_to: { up_to: undefined },
} as const satisfies { [F in Field]: { [K in F]: undefined } }

const TABLES = Object.keys(FIELDS) as Table[]
const vTable = v.union(...TABLES.map((table) => v.literal(table)))

type Phase = { table: Table; stored: boolean }
const PHASES = TABLES.flatMap((table): Phase[] =>
  isStoredTable(table)
    ? [
        { table, stored: false },
        { table, stored: true },
      ]
    : [{ table, stored: false }],
)

/** Rows one page reads and the bytes that read takes before it ends early.
 * A page reads its rows once, up to `bytes` and one more document of up to
 * Convex's 1 MiB, reads each row it patches again and writes it once: at
 * most 10 MiB read and 5 MiB written of Convex's 16 each, and at most
 * `rows` + 1 index ranges of the 4,096 a transaction may read. Tests lower
 * them. */
export const PAGE = { rows: 500, bytes: 4 * MIB }

/** How long one call of run goes on before it answers where to go on
 * from. It checks the time after each page, so a call tries at least one
 * page however low this is. Tests lower it. */
export const RUN = { ms: 5 * 60_000 }

/** How many rows of one page held their field, and where the next page
 * starts. */
type PageResult = { rows: number; cursor: string; done: boolean }

/* Counts the rows of one page of `phase` from `cursor` that hold their
 * table's field and, unless `write` is null, unsets it. The check and the
 * step share it, so both find the same rows. */
async function walk(
  ctx: QueryCtx,
  phase: Phase,
  cursor: string | null,
  write: MutationCtx | null,
): Promise<PageResult> {
  const opts = { cursor, numItems: PAGE.rows, maximumBytesRead: PAGE.bytes }
  const field = FIELDS[phase.table]
  let rows = 0
  if (phase.stored) {
    const { table } = phase
    if (!isStoredTable(table)) throw new Error(`Deleted items stores no ${table} rows`)
    const page = await ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) => q.eq('table', table))
      .paginate(opts)
    for (const stored of page.page) {
      if (!Object.hasOwn(stored.row.doc, field)) continue
      rows++
      if (write !== null)
        await write.db.patch(stored._id, {
          row: {
            table: stored.row.table,
            doc: { ...stored.row.doc, ...UNSET[field] },
          } as Doc<'deleted_rows'>['row'],
        })
    }
    return { rows, cursor: page.continueCursor, done: page.isDone }
  }
  const page = await ctx.db.query(phase.table).paginate(opts)
  for (const row of page.page) {
    if (!Object.hasOwn(row, field)) continue
    rows++
    if (write !== null) await write.db.patch(row._id, UNSET[field])
  }
  return { rows, cursor: page.continueCursor, done: page.isDone }
}

const vPageArgs = {
  table: vTable,
  stored: v.boolean(),
  cursor: v.optional(v.union(v.string(), v.null())),
}

export const step = internalMutation({
  args: vPageArgs,
  handler: async (ctx, { table, stored, cursor }): Promise<PageResult> =>
    await walk(ctx, { table, stored }, cursor ?? null, ctx),
})

/** Counts, without writing, the rows of one page of `table` that hold its
 * field: its live rows, or with `stored` its copies in Deleted items. Leave
 * out `cursor`, or pass null, for the first page, then call again with the
 * returned `cursor` until `done`. */
export const check = internalQuery({
  args: vPageArgs,
  handler: async (ctx, { table, stored, cursor }): Promise<PageResult> =>
    await walk(ctx, { table, stored }, cursor ?? null, null),
})

/** Where a call of run goes on from: the page `page` of a table's live rows
 * or stored copies, null for its first, in a dry run or a run that writes. */
const vRunCursor = v.object({
  dry_run: v.boolean(),
  table: vTable,
  stored: v.boolean(),
  page: v.union(v.string(), v.null()),
})
type RunCursor = Infer<typeof vRunCursor>

const vCounts = v.record(v.string(), v.number())
type Counts = Record<string, number>

const vTotals = {
  live: vCounts,
  stored: vCounts,
  done: v.boolean(),
  cursor: v.union(vRunCursor, v.null()),
  error: v.optional(v.string()),
}
type Totals = Infer<ReturnType<typeof v.object<typeof vTotals>>>

export const audit = internalMutation({
  args: vTotals,
  handler: async (ctx, totals) => {
    await writeAudit(ctx, {
      actor_email: 'system',
      action: 'unread_fields_removal',
      detail: totals,
    })
    return null
  },
})

type PageArgs = { table: Table; stored: boolean; cursor: string | null }
const stepRef = makeFunctionReference<'mutation', PageArgs, PageResult>(
  'internal/unreadFieldsRemoval:step',
)
const checkRef = makeFunctionReference<'query', PageArgs, PageResult>(
  'internal/unreadFieldsRemoval:check',
)
const auditRef = makeFunctionReference<'mutation', Totals, null>(
  'internal/unreadFieldsRemoval:audit',
)

/** Walks every table from `cursor` on and unsets the fields it finds, or in
 * a dry run only counts them. Answers the rows that held a field by table,
 * the live rows (`live`) apart from the copies in Deleted items (`stored`).
 * Past RUN.ms it stops after the page it is in and answers the `cursor` to
 * go on from, else `done`. A page that throws stops the call too, with
 * `error` and the cursor of that page. A call with dry_run false that
 * accepts its cursor ends with its audit row, also when a page threw. */
export const run = internalAction({
  args: { dry_run: v.boolean(), cursor: v.optional(vRunCursor) },
  handler: async (ctx, { dry_run, cursor: from }): Promise<Totals & { dry_run: boolean }> => {
    if (from !== undefined && from.dry_run !== dry_run)
      throw new Error('this cursor is from a call with the other dry_run')
    const first =
      from === undefined
        ? 0
        : PHASES.findIndex((phase) => phase.table === from.table && phase.stored === from.stored)
    if (first < 0) throw new Error('this cursor names no table the run walks')
    const until = Date.now() + RUN.ms
    const live: Counts = Object.fromEntries(TABLES.map((table) => [table, 0]))
    const stored: Counts = Object.fromEntries(
      PHASES.filter((phase) => phase.stored).map((phase) => [phase.table, 0]),
    )
    let page = from?.page ?? null
    let next: RunCursor | null = null
    let stopped = false
    let stepped = false
    let error: string | undefined
    try {
      walking: for (let at = first; at < PHASES.length; at++) {
        const phase = PHASES[at]
        for (;;) {
          next = { dry_run, ...phase, page }
          if (stepped && Date.now() >= until) {
            stopped = true
            break walking
          }
          const args: PageArgs = { ...phase, cursor: page }
          const got: PageResult = dry_run
            ? await ctx.runQuery(checkRef, args)
            : await ctx.runMutation(stepRef, args)
          stepped = true
          const counts = phase.stored ? stored : live
          counts[phase.table] += got.rows
          if (got.done) break
          page = got.cursor
        }
        page = null
      }
    } catch (e) {
      stopped = true
      error = e instanceof Error ? e.message : String(e)
    }
    const totals: Totals = {
      live,
      stored,
      done: !stopped,
      cursor: stopped ? next : null,
      ...(error === undefined ? {} : { error }),
    }
    if (!dry_run) await ctx.runMutation(auditRef, totals)
    return { dry_run, ...totals }
  },
})

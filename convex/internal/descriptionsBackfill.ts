/* One-time migration that gives every live task stored before
 * issue_descriptions existed its description row (schema.ts
 * issue_descriptions, model/descriptions.ts), copied from
 * issues.description, which stays the source of truth in this release.
 * Tasks created or changed since this release already have an equal row:
 * every writer keeps both copies in one transaction. Tasks in Deleted items
 * have none, and a restore writes theirs.
 *
 * The next release reads issue_descriptions, falling back to
 * issues.description for a task without a row, and ships only once a dry
 * run on every deployment (development, staging, production and the demo)
 * reports zero `missing`, `differ`, `duplicates` and `orphans`.
 *
 * A run walks two phases in creation order, each page its own transaction.
 * `tasks` reads every live task and its description row. A task without
 * one is `missing`, a row whose text is not the task's `differ`s, and a
 * second row for one task is a duplicate. `rows` reads every description
 * row and its task, and a row whose task is gone is an orphan. A task row and
 * a description row can each come close to Convex's document size limit
 * (internal/overCapRows.ts keeps the descriptions it finds), so a page reads
 * no more rows at a time than its unspent bytes could hold at twice that
 * size (walk), and a page stays inside Convex's 16 MiB of reads (PAGE).
 *
 * Read the dry run first. It runs in queries, so it writes nothing, and it
 * reports the counts with the first ids of each kind, never the text. A
 * call stops after RUN.ms, well inside Convex's action time limit, and then
 * answers `done: false` with a `cursor`; call it again with the same
 * arguments and `"cursor"` set to it until it answers `done: true`. With
 * the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/descriptionsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/descriptionsBackfill:run '{"dry_run": false}'
 * A run inserts the missing rows. `"repair": true` also rewrites each
 * differing row from issues.description, deletes the second row of a
 * duplicate and deletes orphans. None of those happens while every writer
 * keeps the copies, but a rollback to an earlier release leaves them, and a
 * repair after the roll forward mends them. Run the dry run again
 * afterwards, until it reports zeros.
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). On the demo, whose stored key cannot run internal
 * functions, the private with-temp-deploy-key helper runs each command with
 * a short-lived key. `run`, an internal action, needs
 * deployment:functions:runInternalActions, and its dry run's queries
 * deployment:functions:runInternalQueries as well.
 *
 * A call that wrote adds one platform_audit_log row (action
 * 'descriptions_backfill', actor 'system') with its counts. Running it again
 * is safe, and a deployment with nothing to do reports zeros. It writes no
 * activity, sends no task event and changes nothing a person sees. */
import { makeFunctionReference } from 'convex/server'
import { getDocumentSize, type Infer, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { MIB } from '../lib/limits'
import { audit as writeAudit } from '../model/admin'
import { DOCUMENT_MAX_BYTES } from '../model/comments'
import { putDescription } from '../model/descriptions'

/** Rows one page reads, the bytes it reads before it ends early, as Convex
 * counts a document's size, and the most ids a call lists of each kind.
 * Each read of rows stays within the unspent bytes at two documents of
 * Convex's size limit a row (walk), except a last read of one row, so a page
 * reads at most `bytes` and two such documents, 10 MiB, should no two rows
 * share a creation time. Tests lower them. */
export const PAGE = { rows: 200, bytes: 8 * MIB, listed: 100 }

/** How long one call of run goes on before it answers where to go on
 * from. Tests lower it. */
export const RUN = { ms: 5 * 60_000 }

const PHASES = ['tasks', 'rows'] as const
type Phase = (typeof PHASES)[number]
const vPhase = v.union(...PHASES.map((phase) => v.literal(phase)))

/** Where a call goes on from: the phase, and the creation time it read
 * through, every row of that time included. */
const vCursor = v.object({ phase: vPhase, after: v.number() })
type Cursor = Infer<typeof vCursor>

/** What one page or one call found, the first ids of each kind and, for a
 * page, the creation time it read through and whether its phase is done. */
type Found = {
  tasks: number
  missing: number
  differ: number
  duplicates: number
  orphans: number
  /** the tasks without a row, with a differing row and with two rows */
  missing_ids: string[]
  differ_ids: string[]
  duplicate_ids: string[]
  /** the tasks orphaned rows name */
  orphan_ids: string[]
}
type PageResult = Found & { after: number; done: boolean }

const empty = (): Found => ({
  tasks: 0,
  missing: 0,
  differ: 0,
  duplicates: 0,
  orphans: 0,
  missing_ids: [],
  differ_ids: [],
  duplicate_ids: [],
  orphan_ids: [],
})

/** Adds `from`'s counts and ids into `into`, each list cut to PAGE.listed. */
function add(into: Found, from: Found): void {
  for (const kind of ['missing', 'differ', 'duplicate', 'orphan'] as const) {
    const ids = into[`${kind}_ids`]
    ids.push(...from[`${kind}_ids`].slice(0, Math.max(0, PAGE.listed - ids.length)))
  }
  into.tasks += from.tasks
  into.missing += from.missing
  into.differ += from.differ
  into.duplicates += from.duplicates
  into.orphans += from.orphans
}

/** How a page writes. It inserts the missing rows, and with `repair` it
 * mends the rest. */
type Write = { ctx: MutationCtx; repair: boolean }

/** Checks task `task` against its description row, and mends it with
 * `write`. Answers the bytes it read. */
async function checkTask(
  ctx: QueryCtx,
  task: Doc<'issues'>,
  found: Found,
  write: Write | null,
): Promise<number> {
  found.tasks++
  const text = task.description ?? ''
  const range = () =>
    ctx.db.query('issue_descriptions').withIndex('by_issue', (q) => q.eq('issue_id', task.id))
  const rows = await range().take(2)
  let bytes = rows.reduce((sum, r) => sum + getDocumentSize(r), 0)
  const [row, second] = rows
  if (row === undefined) {
    found.missing++
    if (found.missing_ids.length < PAGE.listed) found.missing_ids.push(task.id)
    if (write !== null) await putDescription(write.ctx.db, task, text)
    return bytes
  }
  if (second !== undefined) {
    found.duplicates++
    if (found.duplicate_ids.length < PAGE.listed) found.duplicate_ids.push(task.id)
    // every row but the first; no writer makes a second, so they are few
    if (write?.repair)
      for (const extra of (await range().collect()).slice(1)) {
        bytes += getDocumentSize(extra)
        await write.ctx.db.delete(extra._id)
      }
  }
  if (row.description !== text) {
    found.differ++
    if (found.differ_ids.length < PAGE.listed) found.differ_ids.push(task.id)
    if (write?.repair) await putDescription(write.ctx.db, task, text)
  }
  return bytes
}

/** Checks description row `row` against its task, and deletes it with a
 * repair when the task is gone. Answers the bytes it read. */
async function checkRow(
  ctx: QueryCtx,
  row: Doc<'issue_descriptions'>,
  found: Found,
  write: Write | null,
): Promise<number> {
  const task = await byId(ctx, 'issues', row.issue_id)
  if (task !== null) return getDocumentSize(task)
  found.orphans++
  if (found.orphan_ids.length < PAGE.listed) found.orphan_ids.push(row.issue_id)
  if (write?.repair) await write.ctx.db.delete(row._id)
  return 0
}

/** Reads one page of `phase` from creation time `after` and answers what
 * it found, which it mends with `write` unless that is null. The dry run
 * and the run share it, so both find the same rows. It reads rows in
 * parts, each no larger than the unspent bytes could hold at twice
 * Convex's document size limit, since each row reads one more, and the
 * page ends at PAGE.rows or PAGE.bytes. Every row with a part's last
 * creation time is in it, should two share one. A write changes no
 * creation time the page reads by, so `after` stays valid. */
async function walk(
  ctx: QueryCtx,
  phase: Phase,
  after: number,
  write: Write | null,
): Promise<PageResult> {
  const table = phase === 'tasks' ? 'issues' : 'issue_descriptions'
  const found = empty()
  let through = after
  let read = 0
  let bytes = 0
  for (;;) {
    const fits = Math.max(1, Math.floor((PAGE.bytes - bytes) / (2 * DOCUMENT_MAX_BYTES)))
    const want = Math.min(PAGE.rows - read, fits)
    const from = through
    const part = await ctx.db
      .query(table)
      .withIndex('by_creation_time', (q) => q.gt('_creationTime', from))
      .take(want)
    const last = part.at(-1)?._creationTime
    if (last === undefined) return { ...found, after: through, done: true }
    const tail =
      part.length < want
        ? []
        : await ctx.db
            .query(table)
            .withIndex('by_creation_time', (q) => q.eq('_creationTime', last))
            .collect()
    const rows = [...part.filter((row) => row._creationTime < last || tail.length === 0), ...tail]
    for (const row of rows) {
      // a description row names its task; a task row has no issue_id
      const more =
        'issue_id' in row
          ? await checkRow(ctx, row, found, write)
          : await checkTask(ctx, row, found, write)
      bytes += getDocumentSize(row) + more
    }
    read += rows.length
    through = last
    if (part.length < want) return { ...found, after: through, done: true }
    if (read >= PAGE.rows || bytes >= PAGE.bytes) return { ...found, after: through, done: false }
  }
}

const pageArgs = { phase: vPhase, after: v.number() }

/** One page in its own transaction, which inserts the missing rows and,
 * with `repair`, mends the rest. */
export const page = internalMutation({
  args: { ...pageArgs, repair: v.boolean() },
  handler: async (ctx, { phase, after, repair }): Promise<PageResult> =>
    await walk(ctx, phase, after, { ctx, repair }),
})

/** One page, read without writing. */
export const check = internalQuery({
  args: pageArgs,
  handler: async (ctx, { phase, after }): Promise<PageResult> =>
    await walk(ctx, phase, after, null),
})

const vCounts = v.object({
  repair: v.boolean(),
  tasks: v.number(),
  missing: v.number(),
  differ: v.number(),
  duplicates: v.number(),
  orphans: v.number(),
})

/** Records a call that wrote, with its counts. */
export const audit = internalMutation({
  args: vCounts,
  handler: async (ctx, counts) => {
    await writeAudit(ctx, {
      actor_email: 'system',
      action: 'descriptions_backfill',
      detail: counts,
    })
    return null
  },
})

const pageRef = makeFunctionReference<
  'mutation',
  { phase: Phase; after: number; repair: boolean },
  PageResult
>('internal/descriptionsBackfill:page')
const checkRef = makeFunctionReference<'query', { phase: Phase; after: number }, PageResult>(
  'internal/descriptionsBackfill:check',
)
const auditRef = makeFunctionReference<'mutation', Infer<typeof vCounts>, null>(
  'internal/descriptionsBackfill:audit',
)

/** Walks both phases from `cursor`, or from the start, and answers what it
 * found, the counts with the first PAGE.listed ids of each kind. A dry run
 * writes nothing; a run inserts the missing rows, and with `repair` mends
 * the rest. Past RUN.ms it stops after a page and answers the `cursor` to
 * go on from, else `done`. A call that wrote ends with its audit row. */
export const run = internalAction({
  args: { dry_run: v.boolean(), repair: v.optional(v.boolean()), cursor: v.optional(vCursor) },
  handler: async (ctx, { dry_run, repair = false, cursor: from }) => {
    const until = Date.now() + RUN.ms
    const found = empty()
    let cursor: Cursor | null = from ?? { phase: PHASES[0], after: 0 }
    while (cursor !== null) {
      const { phase, after }: Cursor = cursor
      const result: PageResult = dry_run
        ? await ctx.runQuery(checkRef, { phase, after })
        : await ctx.runMutation(pageRef, { phase, after, repair })
      add(found, result)
      const next: Phase | undefined = PHASES[PHASES.indexOf(phase) + 1]
      cursor = !result.done
        ? { phase, after: result.after }
        : next === undefined
          ? null
          : { phase: next, after: 0 }
      if (Date.now() >= until) break
    }
    if (!dry_run) {
      const { tasks, missing, differ, duplicates, orphans } = found
      await ctx.runMutation(auditRef, { repair, tasks, missing, differ, duplicates, orphans })
    }
    return { dry_run, repair, ...found, done: cursor === null, cursor }
  },
})

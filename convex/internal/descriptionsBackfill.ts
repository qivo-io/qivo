/* One-time migration of task descriptions into issue_descriptions
 * (schema.ts issue_descriptions, model/descriptions.ts). It gives every
 * live task without a description row its row, gives every row the copies
 * of its task's organization, project and archived state, which rows
 * written before those copies lack, and unsets issues.description where
 * the task's row holds the same text.
 *
 * The move takes three releases. In the first every writer wrote the text
 * to both places, and this backfill gave the tasks stored before it their
 * rows. In the second every reader takes a task's text from its first row
 * in creation order that holds its copies, else from its first row, and
 * only a task without a row reads issues.description (model/descriptions.ts
 * descriptionOf). In the third, this one, writers write the text to the
 * row alone. A create writes no copy to the task row, and a description
 * write unsets the copy the task row holds (model/descriptions.ts
 * insertTask, patchTask). Every other task row keeps the copy an earlier
 * release wrote until a clear run unsets it. The second release, v0.1.98,
 * is the rollback floor. It reads the rows, and its writers write copies
 * equal to the rows again, which a clear after the roll forward unsets. A
 * release before it reads only issues.description, so it shows no text for
 * a task this release wrote, edited or cleared (docs/deployment.md).
 *
 * A call walks two phases in creation order, each page its own
 * transaction. `tasks` reads every live task and its first two description
 * rows. A task without a row is `missing`, with or without a copy, and a
 * second row for one task is a duplicate, also of a task without a copy.
 * For a task with a copy, a row whose text, organization, project or
 * archived state is not its task's `differ`s, one without the project and
 * archived copies included; else its one row holds the same text and the
 * copies, and the task is `held`, which a clear run unsets and counts as
 * `cleared` instead. A task without a copy is `skipped`. Its row is the
 * text, so nothing compares it, but its first row's copies are checked and
 * repaired from the task. `rows` reads every description row and its task.
 * A row whose task is not live is `waiting` when a running step or teardown
 * deletes it, because the task's Deleted items item has not finished
 * (model/deletedItems.ts), or its organization is being deleted
 * (orgRemovals.ts) or is a public demo being cleaned up
 * (internal/demoCleanup.ts). Any other such row is an orphan. The Northstar
 * wipe deletes tasks before their rows, so a dry run during a wipe counts
 * its rows as orphans for a moment.
 *
 * From this release `skipped` counts the tasks without a copy, the normal
 * state, which grows with every create and description edit. A deployment
 * is clean when `missing`, `differ`, `duplicates` and `orphans` are zero,
 * and `waiting` only while a teardown runs, and it is cleared once `held` is
 * zero too. Main Search's palette ships only once a dry run on every
 * deployment reports it clean (search.ts). The backfill of the releases
 * from v0.1.98 up to this one skips a task without a copy before it looks
 * for a second row, so after a rollback to one of them only this release's
 * dry run counts such duplicates.
 *
 * Every document a page reads counts toward PAGE.bytes, those a patch or a
 * delete reads again included. A task row and a description row can each
 * come close to Convex's document size limit (internal/overCapRows.ts
 * keeps the descriptions it finds), so a page reads no more rows at a time
 * than its unspent bytes could hold at that size times the documents one
 * row can read (walk), and it stays inside Convex's 16 MiB of reads
 * (PAGE).
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
 *   "$H" staging npx convex run internal/descriptionsBackfill:run '{"dry_run": false, "repair": true}'
 *   "$H" staging npx convex run internal/descriptionsBackfill:run '{"dry_run": false, "clear": true}'
 * A run inserts the missing rows, with the task's copy, or '' for a task
 * without one, which is the text readers show for it. `"repair": true` also
 * rewrites each differing row, from the task row's copy, which only a
 * release from before the table leaves different and which then holds the
 * later edit, or for a task without a copy with the text readers showed
 * (model/descriptions.ts shownText) and the task's copies. It gives the
 * first row of a duplicate that text and deletes the second, and deletes
 * orphans; a task with a third row needs a second repair. None of those
 * happens while every writer keeps the rows' copies. Rows written before the
 * project and archived copies hold none, as do rows restored from an older
 * backup, and differ until a repair stamps them. Code that lists the table
 * without the copies deploys only while no row holds them
 * (docs/deployment.md). A release from before the table still deploys, and
 * writes tasks without rows and changes descriptions and moves and
 * archives tasks without them. A repair after the roll forward mends what
 * either leaves, and since this release shows a row such a release left
 * stale, run a dry run and that repair before anyone relies on the text.
 * No call writes a waiting row, which its step or teardown deletes.
 *
 * `"clear": true` unsets the copy of each `held` task (model/descriptions.ts
 * clearTaskCopy) and never one of any other kind, so it removes no text the
 * row does not hold. It inserts missing rows as every run does, but it
 * repairs nothing, and a call with `repair` too is refused, so run the
 * repair, read a dry run, then clear. A dry run already reports as `held` what a
 * clear would unset, so a dry run with `clear` is refused as well. Clear a
 * deployment once it serves this release and a dry run reports it clean:
 * the dry run, then the clear with its `cursor` until `done`, then a second
 * dry run, which reports `held` 0. Each clear patches every held task row
 * once, without updated_at, an event or activity, so readers show the same
 * text, and every open tab's task parts run again as their rows change.
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md); the clear is the step a rollback past this release
 * cannot undo for the tasks it clears. On the demo, whose stored key cannot
 * run internal functions, the private with-temp-deploy-key helper runs each
 * command with a short-lived key. `run`, an internal action, needs
 * deployment:functions:runInternalActions, and its dry run's queries
 * deployment:functions:runInternalQueries as well.
 *
 * Every call that is not a dry run adds one platform_audit_log row (action
 * 'descriptions_backfill', actor 'system') with the counts of the pages it
 * committed and the `cursor` to go on from, also when a page fails partway
 * through the call. Running it again is safe, and a deployment with nothing
 * to do reports zeros but `skipped`. It writes no activity, sends no task
 * event and changes nothing a person sees. */
import { makeFunctionReference } from 'convex/server'
import { getDocumentSize, type Infer, type Value, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { MIB } from '../lib/limits'
import { audit as writeAudit } from '../model/admin'
import { DOCUMENT_MAX_BYTES } from '../model/comments'
import {
  clearTaskCopy,
  firstRows,
  holdsCopies,
  putDescription,
  shownText,
} from '../model/descriptions'

/** Rows one page reads, the bytes it reads before it ends early, as Convex
 * counts a document's size, and the most ids a call lists of each kind.
 * Each read of rows stays within the unspent bytes at ROW_DOCUMENTS
 * documents of Convex's size limit a row (walk), except a last read of one
 * row, which the second read of its last row follows. A page so reads at
 * most `bytes` and ROW_DOCUMENTS + 1 such documents, 12 MiB in a repair,
 * 11 MiB in a clear and 10 MiB otherwise, should no two rows share a
 * creation time. Tests lower them. */
export const PAGE = { rows: 200, bytes: 6 * MIB, listed: 100 }

/** The documents of up to Convex's size limit one row of a page can read:
 * a task, its two description rows, in a repair the second row's delete
 * and the first's patch, which each read their row again, and in a clear
 * the task's patch, which reads it again; or a description row, its task,
 * and in a repair the row's delete. The small rows that tell whether a row
 * waits are counted as they are read. */
const ROW_DOCUMENTS = { check: 3, clear: 4, repair: 5 }

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

const KINDS = [
  'missing',
  'differ',
  'duplicates',
  'orphans',
  'waiting',
  'skipped',
  'held',
  'cleared',
] as const
type Kind = (typeof KINDS)[number]

/** What one page or one call found: the tasks it read, how many rows of
 * each kind and the first ids of each, the task ids of a description row. */
type Found = { tasks: number } & Record<Kind, number> & { ids: Record<Kind, string[]> }

/** A page's findings, the bytes it read, the creation time it read through
 * and whether its phase is done. */
type PageResult = Found & { bytes: number; after: number; done: boolean }

const empty = (): Found => ({
  tasks: 0,
  missing: 0,
  differ: 0,
  duplicates: 0,
  orphans: 0,
  waiting: 0,
  skipped: 0,
  held: 0,
  cleared: 0,
  ids: {
    missing: [],
    differ: [],
    duplicates: [],
    orphans: [],
    waiting: [],
    skipped: [],
    held: [],
    cleared: [],
  },
})

/** Counts one row of `kind`, for task `id`. */
function note(found: Found, kind: Kind, id: string): void {
  found[kind] += 1
  if (found.ids[kind].length < PAGE.listed) found.ids[kind].push(id)
}

/** Adds `from`'s counts and ids into `into`, each list cut to PAGE.listed. */
function add(into: Found, from: Found): void {
  into.tasks += from.tasks
  for (const kind of KINDS) {
    into[kind] += from[kind]
    const ids = into.ids[kind]
    ids.push(...from.ids[kind].slice(0, Math.max(0, PAGE.listed - ids.length)))
  }
}

/** How a page writes. It inserts the missing rows, with `repair` it mends
 * the rest, and with `clear` it unsets the held copies. */
type Write = { ctx: MutationCtx; repair: boolean; clear: boolean }

/** What one page has read so far, and whether a row of an organization
 * waits for its teardown, read once a page. */
type Reads = { bytes: number; tearingDown: Map<string, boolean> }

/** Counts `doc` as read, when there is one, and answers it. */
function read<D extends Record<string, Value> | null>(reads: Reads, doc: D): D {
  if (doc !== null) reads.bytes += getDocumentSize(doc)
  return doc
}

/** Checks task `task` against its description rows, and mends them with
 * `write`. A task without a row gets one, with its copy or ''. A task
 * without issues.description is skipped: nothing checks its row's text,
 * but a repair gives its first row the task's copies with the text readers
 * showed before (model/descriptions.ts shownText), so a second row that
 * held the copies leaves its text shown, and then deletes that second row.
 * A task whose one row holds its copy and its copies is held, and a clear
 * unsets the copy (clearTaskCopy). A repair and a clear reuse the rows
 * read here. */
async function checkTask(
  ctx: QueryCtx,
  task: Doc<'issues'>,
  found: Found,
  write: Write | null,
  reads: Reads,
): Promise<void> {
  found.tasks++
  const rows = await firstRows(ctx.db, task.id)
  for (const row of rows) read(reads, row)
  const [row, second] = rows
  if (row === undefined) {
    note(found, 'missing', task.id)
    if (write !== null) await putDescription(write.ctx.db, task, task.description ?? '', null)
    return
  }
  if (task.description === undefined) {
    note(found, 'skipped', task.id)
    const stale = !holdsCopies(row, task)
    if (stale) note(found, 'differ', task.id)
    if (second !== undefined) note(found, 'duplicates', task.id)
    if (!write?.repair) return
    // the patch reads the row again, and the delete the second
    if (stale) await putDescription(write.ctx.db, task, shownText(rows, task), read(reads, row))
    if (second !== undefined) await write.ctx.db.delete(read(reads, second)._id)
    return
  }
  const text = task.description
  if (second !== undefined) {
    note(found, 'duplicates', task.id)
    // a delete reads its row again
    if (write?.repair) await write.ctx.db.delete(read(reads, second)._id)
  }
  if (row.description !== text || !holdsCopies(row, task)) {
    note(found, 'differ', task.id)
    // the patch reads the row again
    if (write?.repair) await putDescription(write.ctx.db, task, text, read(reads, row))
    return
  }
  if (second !== undefined) return
  // the patch reads the task again
  if (write?.clear && (await clearTaskCopy(write.ctx.db, task, rows))) {
    read(reads, task)
    note(found, 'cleared', task.id)
  } else note(found, 'held', task.id)
}

/** Whether a running teardown deletes organization `orgId`'s rows: its
 * deletion (orgRemovals.ts) or a public demo's cleanup
 * (internal/demoCleanup.ts). */
async function tearingDown(ctx: QueryCtx, orgId: string, reads: Reads): Promise<boolean> {
  const known = reads.tearingDown.get(orgId)
  if (known !== undefined) return known
  const removal = read(
    reads,
    await ctx.db
      .query('org_removals')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .first(),
  )
  const demo =
    removal !== null
      ? null
      : read(
          reads,
          await ctx.db
            .query('demo_sessions')
            .withIndex('by_org', (q) => q.eq('org_id', orgId))
            .first(),
        )
  const answer = removal !== null || demo?.status === 'deleting'
  reads.tearingDown.set(orgId, answer)
  return answer
}

/** Whether a Deleted items item that has not finished holds task `taskId`,
 * whose steps delete its description rows (model/deletedItems.ts). */
async function heldInSteps(ctx: QueryCtx, taskId: string, reads: Reads): Promise<boolean> {
  const light = read(
    reads,
    await ctx.db
      .query('deleted_tasks')
      .withIndex('by_task', (q) => q.eq('task_id', taskId))
      .first(),
  )
  if (light === null) return false
  const item = read(reads, await byId(ctx, 'deleted_items', light.item_id))
  return item !== null && item.state !== 'ready'
}

/** Checks description row `row` against its task. A row whose task is not
 * live waits for its step or teardown, or is an orphan, which a repair
 * deletes. */
async function checkRow(
  ctx: QueryCtx,
  row: Doc<'issue_descriptions'>,
  found: Found,
  write: Write | null,
  reads: Reads,
): Promise<void> {
  if (read(reads, await byId(ctx, 'issues', row.issue_id)) !== null) return
  if (
    (await tearingDown(ctx, row.org_id, reads)) ||
    (await heldInSteps(ctx, row.issue_id, reads))
  ) {
    note(found, 'waiting', row.issue_id)
    return
  }
  note(found, 'orphans', row.issue_id)
  // a delete reads its row again
  if (write?.repair) await write.ctx.db.delete(read(reads, row)._id)
}

/** Reads one page of `phase` from creation time `after` and answers what
 * it found, which it mends with `write` unless that is null. The dry run
 * and the run share it, so both find the same rows. It reads rows in
 * parts, each no larger than the unspent bytes could hold at ROW_DOCUMENTS
 * of Convex's document size limit a row, and the page ends at PAGE.rows or
 * PAGE.bytes. Every row with a part's last creation time is in it, read a
 * second time, should two share one. A write changes no creation time the
 * page reads by, so `after` stays valid. */
async function walk(
  ctx: QueryCtx,
  phase: Phase,
  after: number,
  write: Write | null,
): Promise<PageResult> {
  const table = phase === 'tasks' ? 'issues' : 'issue_descriptions'
  const perRow =
    (write?.repair
      ? ROW_DOCUMENTS.repair
      : write?.clear
        ? ROW_DOCUMENTS.clear
        : ROW_DOCUMENTS.check) * DOCUMENT_MAX_BYTES
  const found = empty()
  const reads: Reads = { bytes: 0, tearingDown: new Map() }
  const result = (through: number, done: boolean): PageResult => ({
    ...found,
    bytes: reads.bytes,
    after: through,
    done,
  })
  let through = after
  let rowsRead = 0
  for (;;) {
    const fits = Math.max(1, Math.floor((PAGE.bytes - reads.bytes) / perRow))
    const want = Math.min(PAGE.rows - rowsRead, fits)
    const from = through
    const part = await ctx.db
      .query(table)
      .withIndex('by_creation_time', (q) => q.gt('_creationTime', from))
      .take(want)
    for (const row of part) read(reads, row)
    const last = part.at(-1)?._creationTime
    if (last === undefined) return result(through, true)
    const tail =
      part.length < want
        ? []
        : await ctx.db
            .query(table)
            .withIndex('by_creation_time', (q) => q.eq('_creationTime', last))
            .collect()
    for (const row of tail) read(reads, row)
    const rows = [...part.filter((row) => row._creationTime < last || tail.length === 0), ...tail]
    for (const row of rows) {
      // a description row names its task; a task row has no issue_id
      if ('issue_id' in row) await checkRow(ctx, row, found, write, reads)
      else await checkTask(ctx, row, found, write, reads)
    }
    rowsRead += rows.length
    through = last
    if (part.length < want) return result(through, true)
    if (rowsRead >= PAGE.rows || reads.bytes >= PAGE.bytes) return result(through, false)
  }
}

const pageArgs = { phase: vPhase, after: v.number() }

/** One page in its own transaction, which inserts the missing rows and,
 * with `repair`, mends the rest, or with `clear` unsets the held copies. */
export const page = internalMutation({
  args: { ...pageArgs, repair: v.boolean(), clear: v.boolean() },
  handler: async (ctx, { phase, after, repair, clear }): Promise<PageResult> =>
    await walk(ctx, phase, after, { ctx, repair, clear }),
})

/** One page, read without writing. */
export const check = internalQuery({
  args: pageArgs,
  handler: async (ctx, { phase, after }): Promise<PageResult> =>
    await walk(ctx, phase, after, null),
})

const vRecord = v.object({
  repair: v.boolean(),
  clear: v.boolean(),
  tasks: v.number(),
  missing: v.number(),
  differ: v.number(),
  duplicates: v.number(),
  orphans: v.number(),
  waiting: v.number(),
  skipped: v.number(),
  held: v.number(),
  cleared: v.number(),
  done: v.boolean(),
  cursor: v.union(vCursor, v.null()),
})

/** Records a call that was not a dry run: the counts of the pages it
 * committed, and where to go on from. */
export const audit = internalMutation({
  args: vRecord,
  handler: async (ctx, record) => {
    await writeAudit(ctx, {
      actor_email: 'system',
      action: 'descriptions_backfill',
      detail: record,
    })
    return null
  },
})

const pageRef = makeFunctionReference<
  'mutation',
  { phase: Phase; after: number; repair: boolean; clear: boolean },
  PageResult
>('internal/descriptionsBackfill:page')
const checkRef = makeFunctionReference<'query', { phase: Phase; after: number }, PageResult>(
  'internal/descriptionsBackfill:check',
)
const auditRef = makeFunctionReference<'mutation', Infer<typeof vRecord>, null>(
  'internal/descriptionsBackfill:audit',
)

/** Walks both phases from `cursor`, or from the start, and answers what it
 * found, the counts with the first PAGE.listed ids of each kind. A dry run
 * writes nothing; a run inserts the missing rows, with `repair` mends the
 * rest, and with `clear` unsets the held copies. A call with `clear` and
 * either `repair` or a dry run is refused before it reads. Past RUN.ms it
 * stops after a page and answers the `cursor` to go on from, else `done`. A
 * call that is not a dry run ends with its audit row, also when a page
 * fails, and then throws that page's error. */
export const run = internalAction({
  args: {
    dry_run: v.boolean(),
    repair: v.optional(v.boolean()),
    clear: v.optional(v.boolean()),
    cursor: v.optional(vCursor),
  },
  handler: async (ctx, { dry_run, repair = false, clear = false, cursor: from }) => {
    if (clear && repair)
      throw new Error('a clear repairs nothing, so run the repair, read a dry run, then clear')
    if (clear && dry_run)
      throw new Error('a dry run reports as held what a clear unsets, so it takes no clear')
    const until = Date.now() + RUN.ms
    const found = empty()
    let cursor: Cursor | null = from ?? { phase: PHASES[0], after: 0 }
    try {
      while (cursor !== null) {
        const { phase, after }: Cursor = cursor
        const result: PageResult = dry_run
          ? await ctx.runQuery(checkRef, { phase, after })
          : await ctx.runMutation(pageRef, { phase, after, repair, clear })
        add(found, result)
        const next: Phase | undefined = PHASES[PHASES.indexOf(phase) + 1]
        cursor = !result.done
          ? { phase, after: result.after }
          : next === undefined
            ? null
            : { phase: next, after: 0 }
        if (Date.now() >= until) break
      }
    } finally {
      if (!dry_run) {
        const { ids: _ids, ...counts } = found
        await ctx.runMutation(auditRef, {
          repair,
          clear,
          ...counts,
          done: cursor === null,
          cursor,
        })
      }
    }
    return { dry_run, repair, clear, ...found, done: cursor === null, cursor }
  },
})

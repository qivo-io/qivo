/* One-time migration that counts, for every label, the active tasks that
 * carry it (schema.ts label_counts), which Settings > Labels and its delete
 * confirmation show. Until a label is counted it has no row, and a reader
 * shows its count as unavailable (model/labelCounts.ts activeTaskCount).
 * Labels created since this release start with a row at zero, and every
 * write keeps the rows that exist.
 *
 * An organization's count runs in steps, each its own transaction. The
 * first step adds its label_count_runs row. The reset steps then set every
 * label's row to zero, adding the rows missing, a page of labels at a
 * time, while every write leaves the organization's counts alone. The
 * count steps read the organization's active tasks in _creationTime order
 * (issues.by_org_archived) with their assignments, and add those to the
 * counts. The run row keeps the _creationTime counted through, and a write
 * in between moves the counts only for a task at or below it
 * (model/labelCounts.ts), so the count is exact however the rows change
 * while it runs. A task created later, or written back from Deleted items,
 * is a new document past every one counted, which a later step reads as it
 * is then. The last step deletes the run row. A reader shows none of the
 * organization's counts while it exists.
 *
 * Read the dry run first. It writes nothing and reports each organization
 * a run would count, with its labels, those without a row yet and the
 * counts it would write (`to_count`), and the labels counted already whose
 * stored count their tasks do not give (`differ`).
 * It reads an organization's stored counts before and after it counts its
 * tasks, and lists an organization whose counts writes kept moving as
 * unsettled, to check again with a later dry run (dryCount). With the
 * private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/labelCountsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/labelCountsBackfill:run '{"dry_run": false}'
 * A call stops after RUN.ms, well inside Convex's action time limit, and
 * then answers `done: false` with a `cursor`. Call it again with the same
 * arguments and `"cursor"` set to it until `done` is true. Each call
 * reports the organizations it went through.
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). On the demo, whose stored key cannot run internal
 * functions, the private with-temp-deploy-key helper runs each command with a
 * short-lived key; `run`, an internal action, needs
 * deployment:functions:runInternalActions.
 *
 * A run counts each organization that has a label without a row or a run
 * left unfinished, and leaves the others as they are. `"recount": true`
 * counts every organization again, to mend counts a dry run lists as
 * differing. After the organizations, a call goes through every row of
 * label_counts and label_count_runs and deletes the rows whose label or
 * organization is gone (`orphans`), which a dry run counts without
 * deleting. Only an earlier release leaves such rows: run back on a
 * deployment after this one, it deletes labels and organizations without
 * their rows and moves no count. After such a rollback, a dry run lists
 * the labels it created as to count, the counts it left wrong as differing
 * and the rows it left as orphans; a run, with `recount` for the differing
 * counts, mends them all. A call that wrote adds one platform_audit_log row
 * (action 'label_counts_backfill', actor 'system') with its totals.
 * Running it again is safe. It writes no activity, sends no task event and
 * changes nothing a person sees until a reader shows the counts. */
import { makeFunctionReference } from 'convex/server'
import { getDocumentSize, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { ActionCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { MIB } from '../lib/limits'
import { audit as writeAudit } from '../model/admin'
import { DOCUMENT_MAX_BYTES } from '../model/comments'
import { labelCountRow, labelCountRun } from '../model/labelCounts'

/** Active tasks one count step reads, the bytes of tasks and assignments
 * it reads before it ends early, as Convex counts a document's size, the
 * labels one reset step or dry-run page reads, and the most rows a dry run
 * lists. A stored description can come close to Convex's document size
 * limit, so a step reads no more tasks at a time than its unspent bytes
 * could hold at that size (taskPage). A step that counts a page then reads
 * and writes at most one count row for each label its tasks carry, at most
 * LIMITS.labels.max a task: 2,100 index ranges and 2,000 writes at most,
 * inside Convex's 4,096 and 16,000, and small rows. Tests lower them. */
export const COUNT_PAGE = { tasks: 100, labels: 500, bytes: 4 * MIB, listed: 100 }

/** Organizations one page of a run reads, label_counts or label_count_runs
 * rows one orphan step reads, and how long one call of run goes on before
 * it answers where to go on from. Tests lower them. */
export const RUN = { orgs: 100, rows: 500, ms: 5 * 60_000 }

/** Below every _creationTime: a run that has counted no task. */
const START = Number.MIN_SAFE_INTEGER

/** One page of active tasks: how many labels of each id they carry, how
 * many tasks it read and the _creationTime it counted through. */
type TaskPage = { uses: [label_id: string, tasks: number][]; tasks: number; through: number }

/** One page of the organization's active tasks created after `after`, with
 * their assignments, or null when no active task is past `after`. The page
 * reads tasks in parts, each no larger than its unspent bytes could hold at
 * Convex's document size limit, and ends at COUNT_PAGE.tasks tasks or
 * bytes. Every task with a part's last _creationTime is in it, should two
 * share one, as an import can leave. */
async function taskPage(ctx: QueryCtx, orgId: string, after: number): Promise<TaskPage | null> {
  let through = after
  let tasks = 0
  let bytes = 0
  const uses = new Map<string, number>()
  for (;;) {
    const fits = Math.max(1, Math.floor((COUNT_PAGE.bytes - bytes) / DOCUMENT_MAX_BYTES))
    const want = Math.min(COUNT_PAGE.tasks - tasks, fits)
    const from = through
    const part = await ctx.db
      .query('issues')
      .withIndex('by_org_archived', (q) =>
        q.eq('org_id', orgId).eq('archived_at', undefined).gt('_creationTime', from),
      )
      .take(want)
    const last = part.at(-1)?._creationTime
    if (last === undefined) break
    const tail =
      part.length < want
        ? []
        : await ctx.db
            .query('issues')
            .withIndex('by_org_archived', (q) =>
              q.eq('org_id', orgId).eq('archived_at', undefined).eq('_creationTime', last),
            )
            .collect()
    for (const row of [...part, ...tail]) bytes += getDocumentSize(row)
    const counted = [
      ...part.filter((row) => row._creationTime < last || tail.length === 0),
      ...tail,
    ]
    for (const task of counted) {
      const rows = await ctx.db
        .query('issue_labels')
        .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
        .collect()
      for (const row of rows) {
        bytes += getDocumentSize(row)
        uses.set(row.label_id, (uses.get(row.label_id) ?? 0) + 1)
      }
    }
    tasks += counted.length
    through = last
    if (part.length < want || tasks >= COUNT_PAGE.tasks || bytes >= COUNT_PAGE.bytes) break
  }
  return through === after ? null : { uses: [...uses], tasks, through }
}

/** What one step did: whether the organization is counted, the cursor of
 * the reset's next page of labels, and the labels it set to zero, the
 * tasks it read and the assignments it counted. */
type Step = { done: boolean; cursor: string | null; labels: number; tasks: number; uses: number }

/** One step of the organization's count, in its own transaction: it starts
 * the run, sets one page of labels to zero from `cursor`, or counts one
 * page of tasks, and ends the run once no active task is past where it
 * counted. A run left unfinished goes on where it stopped; the reset starts
 * from its first page again when `cursor` is null, which only sets rows to
 * zero once more. An organization deleted meanwhile is done. */
export const step = internalMutation({
  args: { org_id: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { org_id, cursor }): Promise<Step> => {
    const idle = { labels: 0, tasks: 0, uses: 0 }
    if ((await byId(ctx, 'organizations', org_id)) === null)
      return { done: true, cursor: null, ...idle }
    let run = await labelCountRun(ctx, org_id)
    if (run === null) {
      const _id = await ctx.db.insert('label_count_runs', {
        org_id,
        counting: false,
        through: START,
      })
      run = (await ctx.db.get(_id)) as Doc<'label_count_runs'>
    }
    if (!run.counting) {
      const page = await ctx.db
        .query('labels')
        .withIndex('by_org', (q) => q.eq('org_id', org_id))
        .paginate({ cursor, numItems: COUNT_PAGE.labels })
      for (const label of page.page) {
        const row = await labelCountRow(ctx, label.id)
        const zero = { label_id: label.id, org_id, active_tasks: 0 }
        if (row === null) await ctx.db.insert('label_counts', zero)
        else if (row.org_id !== org_id || row.active_tasks !== 0)
          await ctx.db.replace(row._id, zero)
      }
      if (page.isDone) await ctx.db.patch(run._id, { counting: true })
      const next = page.isDone ? null : page.continueCursor
      return { done: false, cursor: next, ...idle, labels: page.page.length }
    }
    const page = await taskPage(ctx, org_id, run.through)
    if (page === null) {
      await ctx.db.delete(run._id)
      return { done: true, cursor: null, ...idle }
    }
    let uses = 0
    for (const [labelId, tasks] of page.uses) {
      const row = await labelCountRow(ctx, labelId)
      // a deleted label's assignment that its removal still has to delete
      if (row === null || row.org_id !== org_id) continue
      await ctx.db.patch(row._id, { active_tasks: row.active_tasks + tasks })
      uses += tasks
    }
    await ctx.db.patch(run._id, { through: page.through })
    return { done: false, cursor: null, ...idle, tasks: page.tasks, uses }
  },
})

/** One page of an organization's labels, each with its stored count, null
 * for none, and whether a run counts the organization now. */
type LabelPage = {
  labels: { label_id: string; stored: number | null }[]
  running: boolean
  cursor: string
  done: boolean
}

/** One page of the organization's labels from `cursor`, with their stored
 * counts (LabelPage). */
export const labelPage = internalQuery({
  args: { org_id: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { org_id, cursor }): Promise<LabelPage> => {
    const page = await ctx.db
      .query('labels')
      .withIndex('by_org', (q) => q.eq('org_id', org_id))
      .paginate({ cursor, numItems: COUNT_PAGE.labels })
    const labels: LabelPage['labels'] = []
    for (const label of page.page) {
      const row = await labelCountRow(ctx, label.id)
      labels.push({ label_id: label.id, stored: row?.org_id === org_id ? row.active_tasks : null })
    }
    const running = (await labelCountRun(ctx, org_id)) !== null
    return { labels, running, cursor: page.continueCursor, done: page.isDone }
  },
})

/** Counts, without writing, one page of the organization's active tasks
 * created after `after` (taskPage). */
export const check = internalQuery({
  args: { org_id: v.string(), after: v.number() },
  handler: async (ctx, { org_id, after }): Promise<TaskPage | null> =>
    await taskPage(ctx, org_id, after),
})

/** One page of organization ids, by creation. */
export const orgPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('organizations').paginate({ cursor, numItems: RUN.orgs })
    return { orgs: page.page.map((org) => org.id), cursor: page.continueCursor, done: page.isDone }
  },
})

/** The tables whose rows can outlive their label or organization. */
const vOrphanTable = v.union(v.literal('label_counts'), v.literal('label_count_runs'))
type OrphanTable = 'label_counts' | 'label_count_runs'

/** One page of `table` from `cursor`: how many of its rows name a label or
 * organization that is gone, or a label of another organization, and,
 * unless `dry_run`, deletes them. */
export const orphans = internalMutation({
  args: { table: vOrphanTable, dry_run: v.boolean(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, dry_run, cursor }) => {
    const page = await ctx.db.query(table).paginate({ cursor, numItems: RUN.rows })
    let found = 0
    for (const row of page.page) {
      const gone =
        'label_id' in row
          ? (await byId(ctx, 'labels', row.label_id))?.org_id !== row.org_id
          : (await byId(ctx, 'organizations', row.org_id)) === null
      if (!gone) continue
      found++
      if (!dry_run) await ctx.db.delete(row._id)
    }
    return { found, cursor: page.continueCursor, done: page.isDone }
  },
})

/** Records a run that wrote, with its totals. */
export const audit = internalMutation({
  args: {
    counted: v.number(),
    labels: v.number(),
    tasks: v.number(),
    uses: v.number(),
    orphans: v.number(),
  },
  handler: async (ctx, totals) => {
    await writeAudit(ctx, {
      actor_email: 'system',
      action: 'label_counts_backfill',
      detail: totals,
    })
    return null
  },
})

const stepRef = makeFunctionReference<'mutation', { org_id: string; cursor: string | null }, Step>(
  'internal/labelCountsBackfill:step',
)
const labelPageRef = makeFunctionReference<
  'query',
  { org_id: string; cursor: string | null },
  LabelPage
>('internal/labelCountsBackfill:labelPage')
const checkRef = makeFunctionReference<'query', { org_id: string; after: number }, TaskPage | null>(
  'internal/labelCountsBackfill:check',
)
const orgPageRef = makeFunctionReference<
  'query',
  { cursor: string | null },
  { orgs: string[]; cursor: string; done: boolean }
>('internal/labelCountsBackfill:orgPage')
const orphansRef = makeFunctionReference<
  'mutation',
  { table: OrphanTable; dry_run: boolean; cursor: string | null },
  { found: number; cursor: string; done: boolean }
>('internal/labelCountsBackfill:orphans')
const auditRef = makeFunctionReference<
  'mutation',
  { counted: number; labels: number; tasks: number; uses: number; orphans: number },
  null
>('internal/labelCountsBackfill:audit')

/** An organization's labels with their stored counts, and whether a run
 * counts it. */
type Stored = { labels: Map<string, number | null>; running: boolean }

/** Reads every label of the organization with its stored count. */
async function storedOf(ctx: Pick<ActionCtx, 'runQuery'>, orgId: string): Promise<Stored> {
  const labels = new Map<string, number | null>()
  let running = false
  let cursor: string | null = null
  for (;;) {
    const page: LabelPage = await ctx.runQuery(labelPageRef, { org_id: orgId, cursor })
    for (const label of page.labels) labels.set(label.label_id, label.stored)
    running ||= page.running
    if (page.done) return { labels, running }
    cursor = page.cursor
  }
}

/** Whether a run counts the organization without `recount`: it has a
 * label without a row, or a run left unfinished. Stops reading at the
 * first page that shows one. */
async function due(ctx: Pick<ActionCtx, 'runQuery'>, orgId: string): Promise<boolean> {
  let cursor: string | null = null
  for (;;) {
    const page: LabelPage = await ctx.runQuery(labelPageRef, { org_id: orgId, cursor })
    if (page.running || page.labels.some((label) => label.stored === null)) return true
    if (page.done) return false
    cursor = page.cursor
  }
}

/** How many times a dry run counts an organization whose stored counts a
 * write moves while it counts. */
const DRY_TRIES = 3

/** Counts the organization's labels without writing, a page of tasks per
 * query, between two reads of its stored counts. Writes can land between
 * those queries, so the counts match the stored ones only when these held
 * still across the count; it counts again while they moved, at most
 * DRY_TRIES times. Answers the counts by label, the tasks read, the stored
 * counts read after them and whether they held still (`settled`). A write
 * undone within one count, such as an archive and its restore, leaves them
 * as they were and can still show as a difference, which a later dry run
 * no longer shows. */
export async function dryCount(
  ctx: Pick<ActionCtx, 'runQuery'>,
  orgId: string,
): Promise<{ counts: Map<string, number>; tasks: number; stored: Stored; settled: boolean }> {
  let before = await storedOf(ctx, orgId)
  for (let tries = 1; ; tries++) {
    const counts = new Map<string, number>()
    let tasks = 0
    let after = START
    for (;;) {
      const got = await ctx.runQuery(checkRef, { org_id: orgId, after })
      if (got === null) break
      for (const [labelId, n] of got.uses) counts.set(labelId, (counts.get(labelId) ?? 0) + n)
      tasks += got.tasks
      after = got.through
    }
    const stored = await storedOf(ctx, orgId)
    const settled =
      stored.running === before.running &&
      stored.labels.size === before.labels.size &&
      [...stored.labels].every(([id, n]) => before.labels.get(id) === n)
    if (settled || tries === DRY_TRIES) return { counts, tasks, stored, settled }
    before = stored
  }
}

/** Where a call of run goes on: a page of organizations from `cursor`,
 * from organization `org` on when it stopped inside one, then the orphan
 * rows of each table. */
type Position =
  | { table: 'organizations'; cursor: string | null; org?: string }
  | { table: OrphanTable; cursor: string | null }

const vPosition = v.union(
  v.object({
    table: v.literal('organizations'),
    cursor: v.union(v.string(), v.null()),
    org: v.optional(v.string()),
  }),
  v.object({ table: vOrphanTable, cursor: v.union(v.string(), v.null()) }),
)

/** Counts every organization due (due), or every one with `recount`, from
 * `cursor` on, then deletes the orphan rows, and answers how many it
 * counted with their totals. Past RUN.ms it stops between two steps and
 * answers the `cursor` to go on from, else `done`. A dry run writes
 * nothing. It counts each organization's labels (dryCount), answers the
 * same totals for those a run would count, lists up to COUNT_PAGE.listed of
 * them in `to_count`, lists the counted labels whose counts their tasks do
 * not give in `differ` (`differing` in all), the organizations whose counts
 * writes kept moving in `unsettled_orgs` (`unsettled` in all), and counts
 * the orphan rows. A call that wrote ends with its audit row. */
export const run = internalAction({
  args: { dry_run: v.boolean(), recount: v.optional(v.boolean()), cursor: v.optional(vPosition) },
  handler: async (ctx, { dry_run, recount = false, cursor: from }) => {
    const until = Date.now() + RUN.ms
    const totals = { orgs: 0, counted: 0, labels: 0, tasks: 0, uses: 0, orphans: 0 }
    const toCount: {
      org_id: string
      labels: number
      missing: number
      tasks: number
      uses: number
    }[] = []
    const differ: { org_id: string; label_id: string; active_tasks: number; stored: number }[] = []
    const unsettledOrgs: string[] = []
    let differing = 0
    let unsettled = 0
    let at: Position = from ?? { table: 'organizations', cursor: null }
    let done = false
    const late = () => Date.now() >= until
    // Each organization. Answers false when time ran out inside it.
    const count = async (org_id: string): Promise<boolean> => {
      if (!dry_run) {
        if (!recount && !(await due(ctx, org_id))) return true
        let cursor: string | null = null
        for (;;) {
          const got: Step = await ctx.runMutation(stepRef, { org_id, cursor })
          totals.labels += got.labels
          totals.tasks += got.tasks
          totals.uses += got.uses
          if (got.done) break
          // it stops only where the run row holds its place: a reset
          // stopped between two pages would start from its first again
          if (late() && got.cursor === null) return false
          cursor = got.cursor
        }
        totals.counted++
        return true
      }
      const { counts, tasks, stored, settled } = await dryCount(ctx, org_id)
      if (!settled) {
        if (unsettled++ < COUNT_PAGE.listed) unsettledOrgs.push(org_id)
      } else if (!stored.running)
        for (const [label_id, n] of stored.labels) {
          const active_tasks = counts.get(label_id) ?? 0
          if (n === null || n === active_tasks) continue
          if (differing++ < COUNT_PAGE.listed)
            differ.push({ org_id, label_id, active_tasks, stored: n })
        }
      // a run counts every label of an organization it counts again
      const missing = [...stored.labels.values()].filter((n) => n === null).length
      if (!recount && !stored.running && missing === 0) return true
      const labels = stored.labels.size
      const uses = [...stored.labels.keys()].reduce((n, id) => n + (counts.get(id) ?? 0), 0)
      totals.counted++
      totals.labels += labels
      totals.tasks += tasks
      totals.uses += uses
      if (toCount.length < COUNT_PAGE.listed) toCount.push({ org_id, labels, missing, tasks, uses })
      return true
    }
    for (;;) {
      if (at.table === 'organizations') {
        const page: { orgs: string[]; cursor: string; done: boolean } = await ctx.runQuery(
          orgPageRef,
          { cursor: at.cursor },
        )
        const resume = at.org === undefined ? -1 : page.orgs.indexOf(at.org)
        let stopped: string | undefined
        for (const org_id of page.orgs.slice(Math.max(0, resume))) {
          if (!(await count(org_id))) {
            stopped = org_id
            break
          }
          totals.orgs++
        }
        if (stopped !== undefined) at = { ...at, org: stopped }
        else if (page.done) at = { table: 'label_counts', cursor: null }
        else at = { table: 'organizations', cursor: page.cursor }
        if (stopped !== undefined) break
      } else {
        const got: { found: number; cursor: string; done: boolean } = await ctx.runMutation(
          orphansRef,
          { table: at.table, dry_run, cursor: at.cursor },
        )
        totals.orphans += got.found
        if (!got.done) at = { table: at.table, cursor: got.cursor }
        else if (at.table === 'label_counts') at = { table: 'label_count_runs', cursor: null }
        else {
          done = true
          break
        }
      }
      if (late()) break
    }
    if (!dry_run)
      await ctx.runMutation(auditRef, {
        counted: totals.counted,
        labels: totals.labels,
        tasks: totals.tasks,
        uses: totals.uses,
        orphans: totals.orphans,
      })
    return {
      dry_run,
      ...totals,
      differing,
      to_count: toCount,
      differ,
      unsettled,
      unsettled_orgs: unsettledOrgs,
      done,
      cursor: done ? null : at,
    }
  },
})

/* One-time migration that counts, for every label, the active tasks that
 * carry it (schema.ts label_counts), which labels.settingsPage answers for
 * Settings > Labels and its delete confirmation. Until a label is counted it
 * has no row, and that read answers its count as unavailable
 * (model/labelCounts.ts shownCount). Labels created since this release
 * start with a row at zero, and every write keeps the rows that exist.
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
 * is then. The last step deletes the run row. A reader is to show none of
 * the organization's counts while it exists.
 *
 * Read the dry run first. It writes nothing and reports each organization
 * a run would count, with its labels, those without a row yet and the
 * counts it would write (`to_count`), the labels counted already whose
 * stored count their tasks do not give (`differ`), and the organizations
 * with a count left unfinished (`running_orgs`), which it cannot check. It
 * reads an organization's stored counts and their revisions before and
 * after it counts its tasks, and lists an organization whose counts writes
 * kept moving as unsettled, to check again with a later dry run
 * (dryCount). With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/labelCountsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/labelCountsBackfill:run '{"dry_run": false}'
 * A call stops after RUN.ms, well inside Convex's action time limit, before
 * its next organization, step or page, and then answers `done: false` with
 * a `cursor`, which can point inside an organization. Call it again with
 * the same arguments and `"cursor"` set to it until `done` is true. Each
 * call reports the organizations it went through. A dry run checks the
 * time between every two pages too: an organization whose read the deadline
 * cuts short is listed as unchecked (`unchecked_orgs`), never as settled or
 * differing, and the next call goes on with the next organization, so a
 * dry run over one too large for a call checks it in none.
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). On the demo, whose stored key cannot run internal
 * functions, the private with-temp-deploy-key helper runs each command with a
 * short-lived key; `run`, an internal action, needs
 * deployment:functions:runInternalActions.
 *
 * A run counts each organization that has a label without a row or a run
 * left unfinished, going on with that run where it stopped, and leaves the
 * others as they are. `"recount": true` counts every organization again,
 * to mend counts a dry run lists as differing, and starts an unfinished run
 * again from its start unless the call goes on inside that organization
 * from its own cursor. After the organizations, a call goes through every
 * row of label_counts and label_count_runs and deletes the rows whose label
 * or organization is gone (`orphans`), which a dry run counts without
 * deleting. Only an earlier release leaves such rows, or wrong counts: run
 * back on a deployment after this one, it deletes labels and organizations
 * without their rows, moves no count, and leaves a run it finds unfinished
 * wrong below where it stopped. After such a rollback, read a dry run, then
 * run with `"recount": true` until `done`, which mends them all. Every call
 * that is no dry run adds one platform_audit_log row (action
 * 'label_counts_backfill', actor 'system') with its totals and where it
 * stopped, also when a step throws, with the error. Running it again is
 * safe. It writes no activity, sends no task event and changes nothing a
 * person sees. */
import { makeFunctionReference } from 'convex/server'
import { getDocumentSize, type Infer, v } from 'convex/values'
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
 * counted. A run left unfinished goes on where it stopped, unless
 * `restart`, which sets it back to its start, as a recount does: an earlier
 * release run in between moves no count, so a count it left unfinished can
 * be wrong below where it stopped. A run that starts, or starts again,
 * resets from its first page whatever `cursor` says. Every row it writes
 * gets a later revision. An organization deleted meanwhile is done. */
export const step = internalMutation({
  args: {
    org_id: v.string(),
    cursor: v.union(v.string(), v.null()),
    restart: v.optional(v.boolean()),
  },
  handler: async (ctx, { org_id, cursor: from, restart = false }): Promise<Step> => {
    const idle = { labels: 0, tasks: 0, uses: 0 }
    if ((await byId(ctx, 'organizations', org_id)) === null)
      return { done: true, cursor: null, ...idle }
    let cursor = from
    let run = await labelCountRun(ctx, org_id)
    if (run === null) {
      const _id = await ctx.db.insert('label_count_runs', {
        org_id,
        counting: false,
        through: START,
      })
      run = (await ctx.db.get(_id)) as Doc<'label_count_runs'>
      cursor = null
    } else if (restart) {
      await ctx.db.patch(run._id, { counting: false, through: START })
      run = { ...run, counting: false, through: START }
      cursor = null
    }
    if (!run.counting) {
      const page = await ctx.db
        .query('labels')
        .withIndex('by_org', (q) => q.eq('org_id', org_id))
        .paginate({ cursor, numItems: COUNT_PAGE.labels })
      for (const label of page.page) {
        const row = await labelCountRow(ctx, label.id)
        const zero = { label_id: label.id, org_id, active_tasks: 0 }
        if (row === null) await ctx.db.insert('label_counts', { ...zero, revision: 0 })
        else if (row.org_id !== org_id || row.active_tasks !== 0)
          await ctx.db.replace(row._id, { ...zero, revision: row.revision + 1 })
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
      await ctx.db.patch(row._id, {
        active_tasks: row.active_tasks + tasks,
        revision: row.revision + 1,
      })
      uses += tasks
    }
    await ctx.db.patch(run._id, { through: page.through })
    return { done: false, cursor: null, ...idle, tasks: page.tasks, uses }
  },
})

/** A label as a dry run reads it: its stored count and the revision of its
 * row, both null without a row. */
type StoredLabel = { stored: number | null; revision: number | null }

/** One page of an organization's labels, each with its stored count, and
 * whether a run counts the organization now. */
type LabelPage = {
  labels: ({ label_id: string } & StoredLabel)[]
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
      const own = row?.org_id === org_id ? row : null
      labels.push({
        label_id: label.id,
        stored: own?.active_tasks ?? null,
        revision: own?.revision ?? null,
      })
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

/** Where a call stopped inside organization `id`: in the check of whether
 * a run counts it, at the page of labels `due`, or among its steps, at the
 * reset's next page of labels `reset`, null once it counts tasks. With
 * neither, it stopped before the organization. */
const vInside = v.object({
  id: v.string(),
  due: v.optional(v.string()),
  reset: v.optional(v.union(v.string(), v.null())),
})
type Inside = Infer<typeof vInside>

/** Where a call of run goes on: a page of organizations from `cursor`,
 * inside organization `org` when it stopped there, then the orphan rows of
 * each table. */
const vPosition = v.union(
  v.object({
    table: v.literal('organizations'),
    cursor: v.union(v.string(), v.null()),
    org: v.optional(vInside),
  }),
  v.object({ table: vOrphanTable, cursor: v.union(v.string(), v.null()) }),
)
type Position = Infer<typeof vPosition>

/** Records a call that may have written, with its totals, where it
 * stopped (null once done) and the error that ended it, if any. */
export const audit = internalMutation({
  args: {
    counted: v.number(),
    labels: v.number(),
    tasks: v.number(),
    uses: v.number(),
    orphans: v.number(),
    cursor: v.union(vPosition, v.null()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, detail) => {
    await writeAudit(ctx, { actor_email: 'system', action: 'label_counts_backfill', detail })
    return null
  },
})

const stepRef = makeFunctionReference<
  'mutation',
  { org_id: string; cursor: string | null; restart?: boolean },
  Step
>('internal/labelCountsBackfill:step')
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
  {
    counted: number
    labels: number
    tasks: number
    uses: number
    orphans: number
    cursor: Position | null
    error?: string
  },
  null
>('internal/labelCountsBackfill:audit')

/** An organization's labels with their stored counts, and whether a run
 * counts it. */
type Stored = { labels: Map<string, StoredLabel>; running: boolean }

/** Reads every label of the organization with its stored count, or
 * answers null when `late` answers true before its last page. */
async function storedOf(
  ctx: Pick<ActionCtx, 'runQuery'>,
  orgId: string,
  late: () => boolean,
): Promise<Stored | null> {
  const labels = new Map<string, StoredLabel>()
  let running = false
  let cursor: string | null = null
  for (;;) {
    const page: LabelPage = await ctx.runQuery(labelPageRef, { org_id: orgId, cursor })
    for (const { label_id, ...stored } of page.labels) labels.set(label_id, stored)
    running ||= page.running
    if (page.done) return { labels, running }
    if (late()) return null
    cursor = page.cursor
  }
}

/** Whether nothing moved between two reads of an organization's stored
 * counts. A row's revision goes up with each write, so a write undone by
 * another still shows. */
const same = (a: Stored, b: Stored) =>
  a.running === b.running &&
  a.labels.size === b.labels.size &&
  [...a.labels].every(([id, x]) => {
    const y = b.labels.get(id)
    return y !== undefined && x.stored === y.stored && x.revision === y.revision
  })

/** How many times a dry run counts an organization whose stored counts a
 * write moves while it counts. */
const DRY_TRIES = 3

/** Counts the organization's labels without writing, a page of tasks per
 * query, between two reads of its stored counts. Writes can land between
 * those queries, so the counts match the stored ones only when no write
 * moved these across the count (`same`); it counts again while one did, at
 * most DRY_TRIES times, and no more once `late` answers true. Answers the
 * counts by label, the tasks read, the stored counts read after them and
 * whether nothing moved (`settled`). It asks `late` between every two
 * pages, and answers null when that says true in the middle of a read: the
 * organization is then unchecked, as no partial count says anything. */
export async function dryCount(
  ctx: Pick<ActionCtx, 'runQuery'>,
  orgId: string,
  late: () => boolean = () => false,
): Promise<{
  counts: Map<string, number>
  tasks: number
  stored: Stored
  settled: boolean
} | null> {
  let before = await storedOf(ctx, orgId, late)
  if (before === null) return null
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
      if (late()) return null
    }
    const stored = await storedOf(ctx, orgId, late)
    if (stored === null) return null
    const settled = same(before, stored)
    if (settled || tries === DRY_TRIES || late()) return { counts, tasks, stored, settled }
    before = stored
  }
}

/** Counts every organization due, one with a label without a row or a run
 * left unfinished, or every one with `recount`, from `cursor` on, then
 * deletes the orphan rows, and answers how many it counted with their
 * totals. A recount starts again from its start a run it does not resume
 * from its own cursor. Past RUN.ms it stops before the next organization,
 * step or page, after doing at least one, and answers the `cursor` to go
 * on from, else `done`. A dry run writes nothing. It counts each
 * organization's labels (dryCount), answers the same totals for those a
 * run would count, lists up to COUNT_PAGE.listed of them in `to_count`,
 * lists the counted labels whose counts their tasks do not give in
 * `differ` (`differing` in all), the organizations whose counts writes kept
 * moving in `unsettled_orgs` (`unsettled` in all), those a run counts now
 * in `running_orgs` (`running` in all), whose counts it cannot check and
 * which a recount starts again, and those whose read the deadline cut short
 * in `unchecked_orgs` (`unchecked` in all), for a later dry run to check,
 * and counts the orphan rows. A call that
 * is no dry run ends with its audit row, also when a step throws. */
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
    const runningOrgs: string[] = []
    const uncheckedOrgs: string[] = []
    let differing = 0
    let unsettled = 0
    let running = 0
    let unchecked = 0
    let at: Position = from ?? { table: 'organizations', cursor: null }
    let done = false
    const pastDeadline = () => Date.now() >= until
    // whether this call did anything yet, so it always gets somewhere
    let worked = false
    const late = () => worked && pastDeadline()
    // where the call is inside the organization it works on, for the audit
    // row of a call a step ends with an error
    let here: Inside | undefined
    /** A dry run of one organization. One whose read the deadline cut
     * short is unchecked, and the call goes on with the next. */
    const dryOrg = async (org_id: string): Promise<void> => {
      const counted = await dryCount(ctx, org_id, pastDeadline)
      if (counted === null) {
        if (unchecked++ < COUNT_PAGE.listed) uncheckedOrgs.push(org_id)
        return
      }
      const { counts, tasks, stored, settled } = counted
      if (stored.running) {
        if (running++ < COUNT_PAGE.listed) runningOrgs.push(org_id)
      } else if (!settled) {
        if (unsettled++ < COUNT_PAGE.listed) unsettledOrgs.push(org_id)
      } else
        for (const [label_id, { stored: n }] of stored.labels) {
          const active_tasks = counts.get(label_id) ?? 0
          if (n === null || n === active_tasks) continue
          if (differing++ < COUNT_PAGE.listed)
            differ.push({ org_id, label_id, active_tasks, stored: n })
        }
      // a run counts every label of an organization it counts again
      const missing = [...stored.labels.values()].filter((l) => l.stored === null).length
      if (!recount && !stored.running && missing === 0) return
      const labels = stored.labels.size
      const uses = [...stored.labels.keys()].reduce((n, id) => n + (counts.get(id) ?? 0), 0)
      totals.counted++
      totals.labels += labels
      totals.tasks += tasks
      totals.uses += uses
      if (toCount.length < COUNT_PAGE.listed) toCount.push({ org_id, labels, missing, tasks, uses })
    }
    /** A run of one organization, from `inside` when this call goes on
     * inside it. Answers where it stopped, or null once done with it. */
    const countOrg = async (org_id: string, inside?: Inside): Promise<Inside | null> => {
      if (inside?.reset === undefined && !recount) {
        // whether it is due
        let cursor = inside?.due ?? null
        for (;;) {
          const page: LabelPage = await ctx.runQuery(labelPageRef, { org_id, cursor })
          worked = true
          if (page.running || page.labels.some((label) => label.stored === null)) break
          if (page.done) return null
          cursor = page.cursor
          here = { id: org_id, due: cursor }
          if (late()) return here
        }
      }
      let cursor = inside?.reset ?? null
      let restart = recount && inside?.reset === undefined
      for (;;) {
        const got: Step = await ctx.runMutation(stepRef, { org_id, cursor, restart })
        worked = true
        restart = false
        totals.labels += got.labels
        totals.tasks += got.tasks
        totals.uses += got.uses
        if (got.done) {
          totals.counted++
          return null
        }
        cursor = got.cursor
        here = { id: org_id, reset: cursor }
        if (late()) return here
      }
    }
    let error: string | undefined
    try {
      for (;;) {
        if (at.table === 'organizations') {
          const page: { orgs: string[]; cursor: string; done: boolean } = await ctx.runQuery(
            orgPageRef,
            { cursor: at.cursor },
          )
          const inside = at.org
          const from = inside === undefined ? -1 : page.orgs.indexOf(inside.id)
          let stopped: Inside | null = null
          for (const org_id of page.orgs.slice(Math.max(0, from))) {
            if (late()) {
              stopped = { id: org_id }
              break
            }
            const resume = inside?.id === org_id ? inside : undefined
            here = resume ?? { id: org_id }
            if (dry_run) await dryOrg(org_id)
            else stopped = await countOrg(org_id, resume)
            worked = true
            here = undefined
            if (stopped !== null) break
            totals.orgs++
          }
          if (stopped !== null) {
            at = { table: 'organizations', cursor: at.cursor, org: stopped }
            break
          }
          at = page.done
            ? { table: 'label_counts', cursor: null }
            : { table: 'organizations', cursor: page.cursor }
        } else {
          const got: { found: number; cursor: string; done: boolean } = await ctx.runMutation(
            orphansRef,
            { table: at.table, dry_run, cursor: at.cursor },
          )
          worked = true
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
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      if (at.table === 'organizations' && here !== undefined) at = { ...at, org: here }
      throw e
    } finally {
      if (!dry_run)
        await ctx.runMutation(auditRef, {
          counted: totals.counted,
          labels: totals.labels,
          tasks: totals.tasks,
          uses: totals.uses,
          orphans: totals.orphans,
          cursor: done ? null : at,
          ...(error === undefined ? {} : { error }),
        })
    }
    return {
      dry_run,
      ...totals,
      differing,
      to_count: toCount,
      differ,
      unsettled,
      unsettled_orgs: unsettledOrgs,
      running,
      running_orgs: runningOrgs,
      unchecked,
      unchecked_orgs: uncheckedOrgs,
      done,
      cursor: done ? null : at,
    }
  },
})

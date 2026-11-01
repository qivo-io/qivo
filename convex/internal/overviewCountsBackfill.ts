/* One-time migration that counts every organization's overview counts
 * (schema.ts overview_counts, model/overviewCounts.ts): for each
 * sub-project, and for each person in it, the leaves among its active
 * tasks by status, the paused leaves and the remaining hours of the leaves
 * not Done, with the overview_tasks row of each active task, what the
 * counts hold for it.
 * Until an organization is counted its org_ready overview_counts_at is
 * absent and the counts' readers answer `counting` (countsReady). An
 * organization created since this release is counted from its creation.
 *
 * An organization's count runs in steps, each its own transaction. The
 * first step adds its overview_count_runs row. The reset steps then delete
 * its count rows and overview_tasks rows, a page at a time, while every
 * write leaves its counts alone. The count steps read its active tasks in
 * _creationTime order (issues.by_org_archived) and reconcile each
 * (model/overviewCounts.ts reconcileTask), checking it for an active
 * subtask in a live project, while every write in between reconciles the
 * tasks it writes. Reconciling moves the counts by what a task gives over
 * what its overview_tasks row holds, so whichever of a step and a write
 * comes first, the count is exact however the tasks change while it runs.
 * The run row keeps the _creationTime read through. The last step deletes
 * the run row and any overview_regroups row of the organization, which the
 * count leaves with nothing to do, and sets overview_counts_at.
 *
 * Read the dry run first. It writes nothing and reports each organization
 * a run would count, with its tasks and the rows it would write
 * (`to_count`), the rows counted already that its tasks do not give, or
 * that went below zero (`differ`), and the organizations with a count or a
 * regroup left unfinished (`running_orgs`), which it cannot check. It reads
 * an organization's stored rows and their revisions before and after it
 * counts its tasks, and lists one whose rows writes kept moving as
 * unsettled, to check again with a later dry run (dryCount). With the
 * private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/overviewCountsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/overviewCountsBackfill:run '{"dry_run": false}'
 * A call stops after RUN.ms, well inside Convex's action time limit, before
 * its next organization, step or page, and then answers `done: false` with
 * a `cursor`, which can point inside an organization. Call it again with
 * the same arguments and `"cursor"` set to it until `done` is true. Each
 * call reports the organizations it went through. A dry run checks the
 * time between every two pages too: an organization whose read the deadline
 * cuts short is listed as unchecked (`unchecked_orgs`), never as settled or
 * differing, and the next call goes on with the next organization.
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). On the demo, whose stored key cannot run internal
 * functions, the private with-temp-deploy-key helper runs each command with a
 * short-lived key; `run`, an internal action, needs
 * deployment:functions:runInternalActions.
 *
 * A run counts each organization that is not counted yet or has a run left
 * unfinished, going on with that run where it stopped, and leaves the
 * others as they are. `"recount": true` counts every organization again,
 * to mend counts a dry run lists as differing, and starts an unfinished run
 * again from its start unless the call goes on inside that organization
 * from its own cursor. After the organizations, a call goes through every
 * row of overview_counts, overview_tasks, overview_count_runs and
 * overview_regroups and deletes those whose organization, project or task
 * is gone, or whose project or task is a later one with the same id
 * (`orphans`), which a dry run counts without deleting. A release before
 * this one keeps no counts: run back on a deployment after this one, its
 * task writes move none, so the counts drift. After such a rollback, read a
 * dry run, then run with `"recount": true` until `done`, which mends them
 * all. Every call that is no dry run adds one platform_audit_log row
 * (action 'overview_counts_backfill', actor 'system') with its totals and
 * where it stopped, also when a step throws, with the error. Running it
 * again is safe. It writes no activity, sends no task event and changes
 * nothing a person sees. */
import { makeFunctionReference } from 'convex/server'
import { type Infer, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { ActionCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { MIB } from '../lib/limits'
import { audit as writeAudit } from '../model/admin'
import {
  addCounts,
  countTasks,
  isNegative,
  isZero,
  keyOf,
  type LeafCounts,
  noCounts,
  OVERVIEW_TABLES,
  orgCountState,
  overviewCountRun,
  reconcileTask,
  stampOverview,
  taskPage,
} from '../model/overviewCounts'

/** Active tasks one count step reads, the bytes of tasks it reads before
 * it ends early, as Convex counts a document's size, the count or group
 * rows one reset step, orphan step or dry-run page reads, and the most
 * rows a dry run lists. A stored description can come close to Convex's
 * document size limit, so a step reads no more tasks at a time than its
 * unspent bytes could hold at that size (taskPage). Each task's check
 * reads its subtasks until one is in a live project, usually one range,
 * and a page then reads and writes at most two count rows for each task
 * and one group row: inside Convex's 4,096 ranges and 16,000 writes, and
 * small rows. Tests lower them. */
export const COUNT_PAGE = { tasks: 100, rows: 500, bytes: 4 * MIB, listed: 100 }

/** Organizations one page of a run reads, and how long one call of run
 * goes on before it answers where to go on from. Tests lower them. */
export const RUN = { orgs: 100, ms: 5 * 60_000 }

/** Below every _creationTime: a run that has counted no task. */
const START = Number.MIN_SAFE_INTEGER

/** What one step did: whether the organization is counted, and the rows it
 * deleted, the tasks it read and how many of them moved the counts. */
type Step = { done: boolean; deleted: number; tasks: number; rows: number }

/** One page of a dry run: what its tasks add to each row by key
 * (model/overviewCounts.ts countTasks), how many tasks it read and the
 * _creationTime it read through. */
type Checked = { rows: [string, LeafCounts][]; tasks: number; through: number }

/**
 * One step of the organization's count, in its own transaction: it starts
 * the run, deletes a page of the organization's count and group rows, or
 * counts one page of tasks, and ends the run once no active task is past
 * where it counted. A run left unfinished goes on where it stopped, unless
 * `restart`, which sets it back to its start, as a recount does: an earlier
 * release run in between moves no count, so a count it left unfinished can
 * be wrong below where it stopped. An organization deleted meanwhile is
 * done.
 */
export const step = internalMutation({
  args: { org_id: v.string(), restart: v.optional(v.boolean()) },
  handler: async (ctx, { org_id, restart = false }): Promise<Step> => {
    const idle = { deleted: 0, tasks: 0, rows: 0 }
    if ((await byId(ctx, 'organizations', org_id)) === null) return { done: true, ...idle }
    let run = await overviewCountRun(ctx.db, org_id)
    if (run === null) {
      const _id = await ctx.db.insert('overview_count_runs', {
        org_id,
        counting: false,
        through: START,
      })
      run = (await ctx.db.get(_id)) as Doc<'overview_count_runs'>
    } else if (restart) {
      await ctx.db.patch(run._id, { counting: false, through: START })
      run = { ...run, counting: false, through: START }
    }
    if (!run.counting) {
      let deleted = 0
      for (const table of ['overview_counts', 'overview_tasks'] as const) {
        const rows = await ctx.db
          .query(table)
          .withIndex('by_org', (q) => q.eq('org_id', org_id))
          .take(COUNT_PAGE.rows - deleted)
        for (const row of rows) await ctx.db.delete(row._id)
        deleted += rows.length
        if (deleted >= COUNT_PAGE.rows) return { done: false, ...idle, deleted }
      }
      await ctx.db.patch(run._id, { counting: true })
      return { done: false, ...idle, deleted }
    }
    const page = await taskPage(ctx.db, org_id, run.through, COUNT_PAGE)
    if (page === null) {
      await ctx.db.delete(run._id)
      for (const regroup of await ctx.db
        .query('overview_regroups')
        .withIndex('by_org', (q) => q.eq('org_id', org_id))
        .collect())
        await ctx.db.delete(regroup._id)
      await stampOverview(ctx.db, org_id, new Date().toISOString())
      return { done: true, ...idle }
    }
    let rows = 0
    for (const task of page.tasks)
      if (await reconcileTask(ctx.db, org_id, task.id, task, 'read')) rows++
    await ctx.db.patch(run._id, { through: page.through })
    return { done: false, ...idle, tasks: page.tasks.length, rows }
  },
})

/** A stored count row as a dry run reads it: its key, its figures, its
 * revision, and whether it counts for its sub-project as it is now (its
 * organization's, of the sub-project's current row by project_at). */
type StoredRow = { key: string; counts: LeafCounts; revision: number; current: boolean }

/** One page of the organization's count rows from `cursor` (StoredRow),
 * and whether a run or a regroup works on the organization now. */
type StoredPage = { rows: StoredRow[]; running: boolean; cursor: string; done: boolean }

/** One page of the organization's stored count rows (StoredPage). */
export const storedPage = internalQuery({
  args: { org_id: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { org_id, cursor }): Promise<StoredPage> => {
    const page = await ctx.db
      .query('overview_counts')
      .withIndex('by_org', (q) => q.eq('org_id', org_id))
      .paginate({ cursor, numItems: COUNT_PAGE.rows })
    const projects = new Map<string, Doc<'projects'> | null>()
    const rows: StoredRow[] = []
    for (const row of page.page) {
      if (!projects.has(row.project_id))
        projects.set(row.project_id, await byId(ctx, 'projects', row.project_id))
      const project = projects.get(row.project_id) ?? null
      rows.push({
        key: keyOf(row),
        counts: { leaves: row.leaves, paused: row.paused, left_tenths: row.left_tenths },
        revision: row.revision,
        current:
          project !== null && project.org_id === org_id && project._creationTime === row.project_at,
      })
    }
    const regroup = await ctx.db
      .query('overview_regroups')
      .withIndex('by_org', (q) => q.eq('org_id', org_id))
      .first()
    const running = (await overviewCountRun(ctx.db, org_id)) !== null || regroup !== null
    return { rows, running, cursor: page.continueCursor, done: page.isDone }
  },
})

/** Counts, without writing, one page of the organization's active tasks
 * created after `after` (taskPage). */
export const check = internalQuery({
  args: { org_id: v.string(), after: v.number() },
  handler: async (ctx, { org_id, after }): Promise<Checked | null> => {
    const page = await taskPage(ctx.db, org_id, after, COUNT_PAGE)
    if (page === null) return null
    const counted = await countTasks(ctx.db, org_id, page.tasks)
    return { rows: [...counted.rows], tasks: page.tasks.length, through: page.through }
  },
})

/** Whether the organization is counted (org_ready overview_counts_at) and
 * whether a run counts it now. */
export const dueOf = internalQuery({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }) => {
    const state = await orgCountState(ctx.db, org_id)
    return { stamped: state.stamped, running: state.run !== null }
  },
})

/** One page of organization ids, by creation. */
export const orgPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('organizations').paginate({ cursor, numItems: RUN.orgs })
    return { orgs: page.page.map((org) => org.id), cursor: page.continueCursor, done: page.isDone }
  },
})

/** The tables whose rows can outlive their organization, project or task. */
const vOrphanTable = v.union(
  v.literal('overview_counts'),
  v.literal('overview_tasks'),
  v.literal('overview_count_runs'),
  v.literal('overview_regroups'),
)
type OrphanTable = (typeof OVERVIEW_TABLES)[number]

/** What the orphan sweep does with `row` of an overview table: nothing
 * (`keep`), delete it (`delete`), or reconcile its task, which takes the
 * leaf it holds out of the rows and deletes it (`reconcile`). A count row
 * goes with its organization, or once its sub-project is a later one with
 * the same id (project_at), or once its sub-project is gone and it holds
 * nothing: one gone that still holds a leaf waits for the tasks a move to
 * Deleted items has not taken yet, or for a recount. A task row goes with
 * its organization or once its task is a later one with the same id
 * (task_at), and is reconciled once its task is gone or archived. A run or
 * regroup row goes with its organization. */
async function orphanOf(
  ctx: QueryCtx,
  row: Doc<OrphanTable>,
  orgs: Map<string, boolean>,
): Promise<'keep' | 'delete' | 'reconcile'> {
  let org = orgs.get(row.org_id)
  if (org === undefined) {
    org = (await byId(ctx, 'organizations', row.org_id)) !== null
    orgs.set(row.org_id, org)
  }
  if (!org) return 'delete'
  if ('project_at' in row) {
    const project = await byId(ctx, 'projects', row.project_id)
    if (project === null) return isZero(row) ? 'delete' : 'keep'
    return project.org_id !== row.org_id || project._creationTime !== row.project_at
      ? 'delete'
      : 'keep'
  }
  if ('task_at' in row) {
    const task = await byId(ctx, 'issues', row.task_id)
    if (task !== null && task.org_id === row.org_id && task._creationTime !== row.task_at)
      return 'delete'
    return task === null || task.org_id !== row.org_id || task.archived_at !== undefined
      ? 'reconcile'
      : 'keep'
  }
  return 'keep'
}

/** One page of `table` from `cursor`: how many of its rows outlived what
 * they name (orphanOf), and, unless `dry_run`, deletes or reconciles them. */
export const orphans = internalMutation({
  args: { table: vOrphanTable, dry_run: v.boolean(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, dry_run, cursor }) => {
    const page = await ctx.db.query(table).paginate({ cursor, numItems: COUNT_PAGE.rows })
    const orgs = new Map<string, boolean>()
    let found = 0
    for (const row of page.page) {
      const what = await orphanOf(ctx, row, orgs)
      if (what === 'keep') continue
      found++
      if (dry_run) continue
      if (what === 'delete' || !('task_at' in row)) await ctx.db.delete(row._id)
      else {
        const task = await byId(ctx, 'issues', row.task_id)
        await reconcileTask(
          ctx.db,
          row.org_id,
          row.task_id,
          task?.org_id === row.org_id ? task : null,
          'kept',
        )
      }
    }
    return { found, cursor: page.continueCursor, done: page.isDone }
  },
})

/** Where a call stopped inside organization `id`, among the steps of its
 * run. Without it, a call stopped before the organization. */
const vInside = v.object({ id: v.string() })
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
    deleted: v.number(),
    tasks: v.number(),
    rows: v.number(),
    orphans: v.number(),
    cursor: v.union(vPosition, v.null()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, detail) => {
    await writeAudit(ctx, { actor_email: 'system', action: 'overview_counts_backfill', detail })
    return null
  },
})

const stepRef = makeFunctionReference<'mutation', { org_id: string; restart?: boolean }, Step>(
  'internal/overviewCountsBackfill:step',
)
const storedPageRef = makeFunctionReference<
  'query',
  { org_id: string; cursor: string | null },
  StoredPage
>('internal/overviewCountsBackfill:storedPage')
const checkRef = makeFunctionReference<'query', { org_id: string; after: number }, Checked | null>(
  'internal/overviewCountsBackfill:check',
)
const dueOfRef = makeFunctionReference<
  'query',
  { org_id: string },
  { stamped: boolean; running: boolean }
>('internal/overviewCountsBackfill:dueOf')
const orgPageRef = makeFunctionReference<
  'query',
  { cursor: string | null },
  { orgs: string[]; cursor: string; done: boolean }
>('internal/overviewCountsBackfill:orgPage')
const orphansRef = makeFunctionReference<
  'mutation',
  { table: OrphanTable; dry_run: boolean; cursor: string | null },
  { found: number; cursor: string; done: boolean }
>('internal/overviewCountsBackfill:orphans')
const auditRef = makeFunctionReference<
  'mutation',
  {
    counted: number
    deleted: number
    tasks: number
    rows: number
    orphans: number
    cursor: Position | null
    error?: string
  },
  null
>('internal/overviewCountsBackfill:audit')

/** An organization's stored count rows by key, and whether a run or a
 * regroup works on it. */
type Stored = { rows: Map<string, StoredRow>; running: boolean }

/** Reads every count row of the organization, or answers null when `late`
 * answers true before its last page. */
async function storedOf(
  ctx: Pick<ActionCtx, 'runQuery'>,
  orgId: string,
  late: () => boolean,
): Promise<Stored | null> {
  const rows = new Map<string, StoredRow>()
  let running = false
  let cursor: string | null = null
  for (;;) {
    const page: StoredPage = await ctx.runQuery(storedPageRef, { org_id: orgId, cursor })
    for (const row of page.rows) rows.set(row.key, row)
    running ||= page.running
    if (page.done) return { rows, running }
    if (late()) return null
    cursor = page.cursor
  }
}

/** Whether nothing moved between two reads of an organization's stored
 * rows. A row's revision goes up with each write, so a write undone by
 * another still shows. */
const same = (a: Stored, b: Stored) =>
  a.running === b.running &&
  a.rows.size === b.rows.size &&
  [...a.rows].every(([key, x]) => b.rows.get(key)?.revision === x.revision)

/** Whether two counts are equal. */
const equal = (a: LeafCounts, b: LeafCounts) => isZeroDiff(addCounts(a, b, -1))

const isZeroDiff = (c: LeafCounts) =>
  c.paused === 0 && c.left_tenths === 0 && Object.values(c.leaves).every((n) => n === 0)

/** How many times a dry run counts an organization whose rows a write
 * moves while it counts. */
const DRY_TRIES = 3

/** Counts the organization without writing, a page of tasks per query,
 * between two reads of its stored rows. Writes can land between those
 * queries, so the counts match the stored ones only when no write moved
 * these across the count (`same`); it counts again while one did, at most
 * DRY_TRIES times, and no more once `late` answers true. Answers the counts
 * by row key, the tasks read, the stored rows read after them and whether
 * nothing moved (`settled`), or null when `late` said true in the middle of
 * a read, as no partial count says anything. */
export async function dryCount(
  ctx: Pick<ActionCtx, 'runQuery'>,
  orgId: string,
  late: () => boolean = () => false,
): Promise<{
  counts: Map<string, LeafCounts>
  tasks: number
  stored: Stored
  settled: boolean
} | null> {
  let before = await storedOf(ctx, orgId, late)
  if (before === null) return null
  for (let tries = 1; ; tries++) {
    const counts = new Map<string, LeafCounts>()
    let tasks = 0
    let after = START
    for (;;) {
      const got = await ctx.runQuery(checkRef, { org_id: orgId, after })
      if (got === null) break
      for (const [key, c] of got.rows) counts.set(key, addCounts(counts.get(key) ?? noCounts(), c))
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

/** Counts every organization due, one not counted yet or with a run left
 * unfinished, or every one with `recount`, from `cursor` on, then deletes
 * the orphan rows, and answers how many it counted with their totals. A
 * recount starts again from its start a run it does not resume from its
 * own cursor. Past RUN.ms it stops before the next organization, step or
 * page, after doing at least one, and answers the `cursor` to go on from,
 * else `done`. A dry run writes nothing. It counts each organization
 * (dryCount), answers the same totals for those a run would count, lists
 * up to COUNT_PAGE.listed of them in `to_count`, lists the rows of a
 * counted organization that its tasks do not give, or that went below
 * zero, in `differ` (`differing` in all), the organizations whose rows
 * writes kept moving in `unsettled_orgs` (`unsettled` in all), those a run
 * or a regroup works on now in `running_orgs` (`running` in all), whose
 * counts it cannot check and which a recount starts again, and those whose
 * read the deadline cut short in `unchecked_orgs` (`unchecked` in all), and
 * counts the orphan rows. A call that is no dry run ends with its audit
 * row, also when a step throws. */
export const run = internalAction({
  args: { dry_run: v.boolean(), recount: v.optional(v.boolean()), cursor: v.optional(vPosition) },
  handler: async (ctx, { dry_run, recount = false, cursor: from }) => {
    const until = Date.now() + RUN.ms
    const totals = { orgs: 0, counted: 0, deleted: 0, tasks: 0, rows: 0, orphans: 0 }
    const toCount: { org_id: string; tasks: number; rows: number }[] = []
    const differ: { org_id: string; key: string; counted: LeafCounts; stored: LeafCounts }[] = []
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
    // the organization the call works inside, for the audit row of a call
    // a step ends with an error
    let here: Inside | undefined
    /** A dry run of one organization. One whose read the deadline cut
     * short is unchecked, and the call goes on with the next. */
    const dryOrg = async (org_id: string): Promise<void> => {
      const due = await ctx.runQuery(dueOfRef, { org_id })
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
      } else if (due.stamped) {
        const keys = new Set([...counts.keys(), ...stored.rows.keys()])
        for (const key of keys) {
          const row = stored.rows.get(key)
          if (row !== undefined && !row.current) continue
          const want = counts.get(key) ?? noCounts()
          const have = row?.counts ?? noCounts()
          if (equal(want, have) && !isNegative(have)) continue
          if (differing++ < COUNT_PAGE.listed)
            differ.push({ org_id, key, counted: want, stored: have })
        }
      }
      if (!recount && due.stamped && !due.running) return
      totals.counted++
      totals.tasks += tasks
      totals.rows += counts.size
      if (toCount.length < COUNT_PAGE.listed) toCount.push({ org_id, tasks, rows: counts.size })
    }
    /** A run of one organization, from inside it when this call goes on
     * there. Answers where it stopped, or null once done with it. */
    const countOrg = async (org_id: string, resume: boolean): Promise<Inside | null> => {
      if (!resume && !recount) {
        const due = await ctx.runQuery(dueOfRef, { org_id })
        worked = true
        if (due.stamped && !due.running) return null
      }
      let restart = recount && !resume
      for (;;) {
        const got: Step = await ctx.runMutation(stepRef, { org_id, restart })
        worked = true
        restart = false
        totals.deleted += got.deleted
        totals.tasks += got.tasks
        totals.rows += got.rows
        if (got.done) {
          totals.counted++
          return null
        }
        here = { id: org_id }
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
          const start = inside === undefined ? -1 : page.orgs.indexOf(inside.id)
          let stopped: Inside | null = null
          for (const org_id of page.orgs.slice(Math.max(0, start))) {
            if (late()) {
              stopped = { id: org_id }
              break
            }
            const resume = inside?.id === org_id
            here = { id: org_id }
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
            ? { table: OVERVIEW_TABLES[0], cursor: null }
            : { table: 'organizations', cursor: page.cursor }
        } else {
          const got: { found: number; cursor: string; done: boolean } = await ctx.runMutation(
            orphansRef,
            { table: at.table, dry_run, cursor: at.cursor },
          )
          worked = true
          totals.orphans += got.found
          const next = OVERVIEW_TABLES[OVERVIEW_TABLES.indexOf(at.table) + 1]
          if (!got.done) at = { table: at.table, cursor: got.cursor }
          else if (next !== undefined) at = { table: next, cursor: null }
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
          deleted: totals.deleted,
          tasks: totals.tasks,
          rows: totals.rows,
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

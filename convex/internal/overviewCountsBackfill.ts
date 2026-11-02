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
 * its count rows, overview_tasks rows and overview_regroups rows, a page at
 * a time, while every write leaves its counts alone and no project change
 * starts a regroup. The count steps read its active tasks in _creationTime
 * order (issues.by_org_archived) and reconcile each (model/overviewCounts.ts
 * reconcileTask), checking it for an active subtask in a live project,
 * while every write in between reconciles the tasks it writes and every
 * project archive, restore or move to Deleted items starts a regroup.
 * Reconciling moves the counts by what a task gives over what its
 * overview_tasks row holds, so whichever of a step, a write and a regroup
 * comes first, the count is exact however the tasks change while it runs.
 * The _creationTime a run counted through goes in the call's cursor, not
 * in the run row, which every task write reads, with the run's generation:
 * a position counts only in the run, and since the reset, it was counted
 * in, so a replayed cursor or one a recount overtook counts from the start
 * (step). The last step deletes the
 * run row and sets overview_counts_at; a regroup started while it counted
 * goes on, and its top-level project answers `counting` until it ends.
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
 * this one keeps no counts, and its schema does not accept org_ready
 * overview_counts_at, which every new organization and every counted one
 * holds: this release is a backend rollback floor once it deploys
 * (docs/deployment.md), and a fault is fixed forward. Counts that drift
 * for another reason, which a dry run lists in `differ`, are mended by a
 * run with `"recount": true` until `done`. Every call that is no dry run
 * adds one platform_audit_log row
 * (action 'overview_counts_backfill', actor 'system') with its totals and
 * where it stopped, also when a step throws, with the error. Running it
 * again is safe. It writes no activity, sends no task event and changes
 * nothing a person sees. */
import { makeFunctionReference } from 'convex/server'
import { type Infer, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { ActionCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId, usedMoreThan } from '../lib/db'
import { MIB } from '../lib/limits'
import { audit as writeAudit } from '../model/admin'
import { newUuid } from '../model/orgs'
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
  throughTasks,
} from '../model/overviewCounts'

/** Active tasks one count step reads, the bytes of tasks it reads before
 * it ends early, as Convex counts a document's size, the count or group
 * rows one reset step, orphan step or dry-run page reads, the most rows a
 * dry run lists, and the share of any of Convex's limits for one
 * transaction past which a count step or a dry-run page stops before its
 * next creation time and leaves the rest to the next. A stored description
 * can come close to Convex's document size limit, so a step reads no more
 * tasks at a time than its unspent bytes could hold at that size
 * (taskPage). Each task's check reads its subtasks until one is in a live
 * project, usually one range, but every one of them where none is, up to
 * LIMITS.subtasks rows and the rows' projects; a page asks about each
 * project once, so a page of 100 tasks whose 5,000 subtasks sit in 50
 * archived sub-projects read 416 ranges and 5,383 documents in convex-test
 * (tests/overviewCounts.test.ts). A task then
 * reads and writes at most four count rows and one group row. `room` stops
 * a page whose subtasks are many and large. Tests lower them. */
export const COUNT_PAGE = { tasks: 100, rows: 500, bytes: 4 * MIB, listed: 100, room: 0.5 }

/** Organizations one page of a run reads, and how long one call of run
 * goes on before it answers where to go on from. Tests lower them. */
export const RUN = { orgs: 100, ms: 5 * 60_000 }

/** Below every _creationTime: a run that has counted no task. */
const START = Number.MIN_SAFE_INTEGER

/** What one step did: whether the organization is counted, the rows it
 * deleted, the tasks it counted and how many of them moved the counts, the
 * generation of the run it worked in, and for a count step the
 * _creationTime it counted through, which the next count step of that run
 * goes on after. */
type Step = {
  done: boolean
  deleted: number
  tasks: number
  rows: number
  generation?: string
  through?: number
}

/** One page of a dry run: what its tasks add to each row by key
 * (model/overviewCounts.ts countTasks), how many tasks it read and the
 * _creationTime it read through. */
type Checked = { rows: [string, LeafCounts][]; tasks: number; through: number }

/**
 * One step of the organization's count, in its own transaction: it starts
 * the run, deletes a page of the organization's count, group and regroup
 * rows, or counts one page of the tasks created after `after`, and ends the
 * run once no active task is past where it counted. A run left unfinished
 * goes on where it is, unless `restart`, which sets it back to its reset,
 * as a recount does. Each run, and each reset of one, has a new
 * `generation`, which every step answers: `after` counts only with the
 * generation it was counted in, so a position from an earlier run or from
 * before a reset, such as a replayed cursor's or one a recount overtook,
 * counts from the start. A count step that passes COUNT_PAGE.room stops
 * before its next creation time (throughTasks) and answers the one it
 * counted through. An organization deleted meanwhile is done.
 */
export const step = internalMutation({
  args: {
    org_id: v.string(),
    restart: v.optional(v.boolean()),
    after: v.optional(v.number()),
    generation: v.optional(v.string()),
  },
  handler: async (ctx, { org_id, restart = false, after, generation }): Promise<Step> => {
    const idle = { deleted: 0, tasks: 0, rows: 0 }
    if ((await byId(ctx, 'organizations', org_id)) === null) return { done: true, ...idle }
    let run = await overviewCountRun(ctx.db, org_id)
    if (run === null) {
      const _id = await ctx.db.insert('overview_count_runs', {
        org_id,
        counting: false,
        generation: newUuid(),
      })
      run = (await ctx.db.get(_id)) as Doc<'overview_count_runs'>
    } else if (restart) {
      const reset = { counting: false, generation: newUuid() }
      await ctx.db.patch(run._id, reset)
      run = { ...run, ...reset }
    }
    if (!run.counting) {
      // no regroup starts while the run resets, so those left go now, and
      // those a project change starts while it counts go on after it
      let deleted = 0
      for (const table of ['overview_counts', 'overview_tasks', 'overview_regroups'] as const) {
        const rows = await ctx.db
          .query(table)
          .withIndex('by_org', (q) => q.eq('org_id', org_id))
          .take(COUNT_PAGE.rows - deleted)
        for (const row of rows) await ctx.db.delete(row._id)
        deleted += rows.length
        if (deleted >= COUNT_PAGE.rows)
          return { done: false, ...idle, deleted, generation: run.generation }
      }
      await ctx.db.patch(run._id, { counting: true })
      return { done: false, ...idle, deleted, generation: run.generation }
    }
    const from = after !== undefined && generation === run.generation ? after : START
    const page = await taskPage(ctx.db, org_id, from, COUNT_PAGE)
    if (page === null) {
      await ctx.db.delete(run._id)
      await stampOverview(ctx.db, org_id, new Date().toISOString())
      return { done: true, ...idle }
    }
    let rows = 0
    const live = new Map<string, boolean>()
    const went = await throughTasks(
      page.tasks,
      async (task) => {
        if (await reconcileTask(ctx.db, org_id, task.id, task, 'read', live)) rows++
      },
      () => usedMoreThan(ctx, COUNT_PAGE.room),
    )
    return {
      done: false,
      ...idle,
      tasks: went,
      rows,
      generation: run.generation,
      through: page.tasks[went - 1]._creationTime,
    }
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
 * created after `after` (taskPage), up to where it passes COUNT_PAGE.room
 * (countTasks), and answers the _creationTime it counted through. */
export const check = internalQuery({
  args: { org_id: v.string(), after: v.number() },
  handler: async (ctx, { org_id, after }): Promise<Checked | null> => {
    const page = await taskPage(ctx.db, org_id, after, COUNT_PAGE)
    if (page === null) return null
    const counted = await countTasks(ctx.db, org_id, page.tasks, () =>
      usedMoreThan(ctx, COUNT_PAGE.room),
    )
    return {
      rows: [...counted.rows],
      tasks: counted.counted,
      through: page.tasks[counted.counted - 1]._creationTime,
    }
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

/** Where a call stopped at organization `id`: inside its run, once a step
 * of it committed in that call, with the generation of that run and the
 * _creationTime its count steps counted through in it (`through`, absent
 * before the first count step), or before the organization (`before`),
 * which the next call takes up as if it came to it fresh. */
const vInside = v.object({
  id: v.string(),
  generation: v.optional(v.string()),
  through: v.optional(v.number()),
  before: v.optional(v.boolean()),
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

const stepRef = makeFunctionReference<
  'mutation',
  { org_id: string; restart?: boolean; after?: number; generation?: string },
  Step
>('internal/overviewCountsBackfill:step')
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
    // the organization the call works on, and where it is inside its run
    // once a step committed, for the cursor of a call a step ends with an
    // error
    let current: string | undefined
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
     * where an earlier one stopped inside it (`from`). Answers where it
     * stopped, or null once done with it. A run whose cursor is lost counts
     * from the start, which reconciling again leaves exact. */
    const countOrg = async (org_id: string, from: Inside | undefined): Promise<Inside | null> => {
      const resume = from !== undefined && from.before !== true
      if (!resume && !recount) {
        const due = await ctx.runQuery(dueOfRef, { org_id })
        worked = true
        if (due.stamped && !due.running) return null
      }
      let restart = recount && !resume
      let after = resume ? from.through : undefined
      let generation = resume ? from.generation : undefined
      // a call that goes on inside keeps that place should its first step fail
      if (resume) here = from
      for (;;) {
        const got: Step = await ctx.runMutation(stepRef, {
          org_id,
          restart,
          ...(after === undefined ? {} : { after }),
          ...(generation === undefined ? {} : { generation }),
        })
        worked = true
        restart = false
        totals.deleted += got.deleted
        totals.tasks += got.tasks
        totals.rows += got.rows
        if (got.done) {
          totals.counted++
          return null
        }
        // a new run, or a reset, starts the count again
        if (got.generation !== undefined && got.generation !== generation) {
          generation = got.generation
          after = undefined
        }
        if (got.through !== undefined) after = got.through
        here = {
          id: org_id,
          ...(generation === undefined ? {} : { generation }),
          ...(after === undefined ? {} : { through: after }),
        }
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
              stopped = { id: org_id, before: true }
              break
            }
            current = org_id
            if (dry_run) await dryOrg(org_id)
            else stopped = await countOrg(org_id, inside?.id === org_id ? inside : undefined)
            worked = true
            here = undefined
            current = undefined
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
      if (at.table === 'organizations' && current !== undefined)
        at = { ...at, org: here ?? { id: current, before: true } }
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

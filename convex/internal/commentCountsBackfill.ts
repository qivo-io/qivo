/* One-time migration that counts the comments of every live task stored
 * before comment counts existed into its task_comment_counts row
 * (schema.ts), the row the comment cap reads (model/commentLimits.ts).
 * Tasks created since this release are counted from their start
 * (startCount), and a task Deleted items writes back counts itself
 * (restartCount).
 *
 * Until a task is counted, each post on it counts its thread first, in the
 * post's own transaction, within COUNT_BUDGET.post. A thread longer than
 * that, about 2 MiB of comments, refuses every post and every archive with a
 * reason for now ("Qivo is still counting this task's comments"), so run
 * this soon after the deployment serves the release. A thread that holds
 * LIMITS.comments.max comments or more refuses them until comments are
 * deleted, as the cap asks.
 *
 * A count runs in steps, each its own transaction, in _creationTime order
 * (model/commentLimits.ts countPage), and keeps the time it has counted
 * through in `counted`. A post or delete in between moves the count only
 * for a comment created at or before that time (tallyComments), so the count
 * is exact however the thread changes while it runs.
 *
 * Read the dry run first. It writes nothing. For the tasks it went through
 * it reports how many a run would count and the comments they hold, the
 * tasks counted already whose counts their threads do not give (`differ`),
 * and the tasks that hold LIMITS.comments.max comments or more (`full`), with
 * ids and counts only. A task whose thread kept changing while it counted is
 * listed as unsettled, to check again with a later dry run. With the private
 * helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/commentCountsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/commentCountsBackfill:run '{"dry_run": false}'
 * A call stops after RUN.ms, well inside Convex's action time limit, and
 * then answers `done: false` with a `cursor`. Call it again with the same
 * arguments and `"cursor"` set to it until `done` is true. A deployment is
 * ready when a dry run to the end reports `to_count: 0`.
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). On the demo, whose stored key cannot run internal
 * functions, the private with-temp-deploy-key helper runs each command with
 * a short-lived key; `run`, an internal action, needs
 * deployment:functions:runInternalActions.
 *
 * A run counts the tasks not counted yet, finishes the counts under way and
 * leaves exact counts as they are. `"recount": true` counts every task
 * again, to mend counts a dry run lists as differing. A call that wrote adds
 * one platform_audit_log row (action 'comment_counts_backfill', actor
 * 'system') with its totals. Running it again is safe. It writes no
 * activity, sends no task event and changes nothing a person sees, except
 * that a post on a task it counted no longer counts the thread first. Tasks
 * in Deleted items are left alone; a restore counts them. */
import { makeFunctionReference } from 'convex/server'
import { getDocumentSize, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { ActionCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { LIMITS, MIB } from '../lib/limits'
import { audit as writeAudit } from '../model/admin'
import {
  COUNT_BUDGET,
  type CountPage,
  countPage,
  countRow,
  START,
  stepCount,
} from '../model/commentLimits'
import { DOCUMENT_MAX_BYTES } from '../model/comments'

/** Tasks one page reads, the bytes it reads before it ends early, as Convex
 * counts a document's size, and the most tasks a call lists in each report.
 * A stored description can come close to Convex's document size limit, so
 * a page reads no more tasks at a time than its unspent bytes could hold at
 * that size (taskPage). Tests lower them. */
export const TASK_PAGE = { rows: 100, bytes: 4 * MIB, listed: 100 }

/** Organizations one page of a run reads, and how long one call of run
 * goes on before it answers where to go on from. Tests lower them. */
export const RUN = { orgs: 100, ms: 5 * 60_000 }

/** How many times a dry run counts a task whose stored count a write moves
 * while it counts. */
const DRY_TRIES = 3

/** A task's count as its row holds it: none without a row, the count so
 * far while one is under way, and the exact count once it ends. */
type Stored =
  | { state: 'none' }
  | { state: 'counting'; count: number }
  | { state: 'exact'; count: number }

/** One live task with its stored count. */
type TaskState = { issue_id: string; stored: Stored }

/** A page of an organization's live tasks, and the task number it read
 * through. */
type TaskPage = { tasks: TaskState[]; through: number; done: boolean }

/** Where a call goes on from: organization `org`, its tasks numbered past
 * `num`. */
type Cursor = { org: string; num: number }

/** A task as a report lists it. */
type TaskReport = { issue_id: string; org_id: string; count: number }

const storedOf = (row: Doc<'task_comment_counts'> | null): Stored =>
  row === null
    ? { state: 'none' }
    : row.counted === undefined
      ? { state: 'exact', count: row.count }
      : { state: 'counting', count: row.count }

/** One page of organization `org_id`'s live tasks numbered past `after`,
 * by number, with their stored counts. The page reads in parts, each no
 * larger than its unspent bytes could hold at Convex's document size
 * limit, and ends at TASK_PAGE rows or bytes. Every task with a part's last
 * number is in it, should two share one. */
export const taskPage = internalQuery({
  args: { org_id: v.string(), after: v.number() },
  handler: async (ctx, { org_id, after }): Promise<TaskPage> => {
    let through = after
    let bytes = 0
    let done = false
    const read: Doc<'issues'>[] = []
    for (;;) {
      const fits = Math.max(1, Math.floor((TASK_PAGE.bytes - bytes) / DOCUMENT_MAX_BYTES))
      const want = Math.min(TASK_PAGE.rows - read.length, fits)
      const from = through
      const part = await ctx.db
        .query('issues')
        .withIndex('by_org_num', (q) => q.eq('org_id', org_id).gt('num', from))
        .take(want)
      const last = part.at(-1)?.num
      if (last === undefined) {
        done = true
        break
      }
      const tail =
        part.length < want
          ? []
          : await ctx.db
              .query('issues')
              .withIndex('by_org_num', (q) => q.eq('org_id', org_id).eq('num', last))
              .collect()
      for (const task of [...part, ...tail]) bytes += getDocumentSize(task)
      read.push(...part.filter((task) => task.num < last || tail.length === 0), ...tail)
      through = last
      if (part.length < want) {
        done = true
        break
      }
      if (read.length >= TASK_PAGE.rows || bytes >= TASK_PAGE.bytes) break
    }
    const tasks: TaskState[] = []
    for (const task of read)
      tasks.push({ issue_id: task.id, stored: storedOf(await countRow(ctx, task.id)) })
    return { tasks, through, done }
  },
})

/** One page of organization ids past `after`, in id order. */
export const orgPage = internalQuery({
  args: { after: v.union(v.string(), v.null()) },
  handler: async (ctx, { after }): Promise<{ orgs: string[]; done: boolean }> => {
    const orgs = await ctx.db
      .query('organizations')
      .withIndex('by_uuid', (q) => (after === null ? q : q.gt('id', after)))
      .take(RUN.orgs)
    return { orgs: orgs.map((org) => org.id), done: orgs.length < RUN.orgs }
  },
})

/** Task `issue_id`'s stored count, or null once it is no longer live. */
export const state = internalQuery({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }): Promise<Stored | null> =>
    (await byId(ctx, 'issues', issue_id)) === null ? null : storedOf(await countRow(ctx, issue_id)),
})

/** Counts, without writing, one page of task `issue_id`'s comments created
 * after `after` (model/commentLimits.ts countPage). */
export const check = internalQuery({
  args: { issue_id: v.string(), after: v.number() },
  handler: async (ctx, { issue_id, after }): Promise<CountPage> =>
    await countPage(ctx, issue_id, after, COUNT_BUDGET.step),
})

/** One step of the count of live task `issue_id`. It starts the count
 * where the task has no row, or with `restart` from the start of the
 * thread, and counts one page (model/commentLimits.ts stepCount). Answers
 * the count once it is exact, null while it counts, and 'skipped' for a
 * task no longer live, such as one deleted meanwhile. */
export const step = internalMutation({
  args: { issue_id: v.string(), restart: v.boolean() },
  handler: async (ctx, { issue_id, restart }): Promise<number | 'skipped' | null> => {
    const issue = await byId(ctx, 'issues', issue_id)
    if (issue === null) return 'skipped'
    const row = await countRow(ctx, issue_id)
    if (row === null)
      await ctx.db.insert('task_comment_counts', {
        org_id: issue.org_id,
        issue_id,
        count: 0,
        counted: START,
      })
    else if (restart) await ctx.db.patch(row._id, { count: 0, counted: START })
    return await stepCount(ctx, issue_id)
  },
})

/** Records a run that wrote, with its totals. */
export const audit = internalMutation({
  args: { counted: v.number(), comments: v.number(), full: v.number() },
  handler: async (ctx, totals) => {
    await writeAudit(ctx, {
      actor_email: 'system',
      action: 'comment_counts_backfill',
      detail: totals,
    })
    return null
  },
})

const orgPageRef = makeFunctionReference<
  'query',
  { after: string | null },
  { orgs: string[]; done: boolean }
>('internal/commentCountsBackfill:orgPage')
const taskPageRef = makeFunctionReference<'query', { org_id: string; after: number }, TaskPage>(
  'internal/commentCountsBackfill:taskPage',
)
const stateRef = makeFunctionReference<'query', { issue_id: string }, Stored | null>(
  'internal/commentCountsBackfill:state',
)
const checkRef = makeFunctionReference<'query', { issue_id: string; after: number }, CountPage>(
  'internal/commentCountsBackfill:check',
)
const stepRef = makeFunctionReference<
  'mutation',
  { issue_id: string; restart: boolean },
  number | 'skipped' | null
>('internal/commentCountsBackfill:step')
const auditRef = makeFunctionReference<
  'mutation',
  { counted: number; comments: number; full: number },
  null
>('internal/commentCountsBackfill:audit')

/** Counts task `issueId`'s comments without writing, page by page in
 * queries of their own, then reads its stored count again. Writes can land
 * between those queries, so the count matches a stored count only when it
 * held still across the count; it counts again while it moved, at most
 * DRY_TRIES times. Answers the count, the stored count read after it,
 * null once the task is no longer live, and whether it held still. */
async function dryCount(
  ctx: Pick<ActionCtx, 'runQuery'>,
  issueId: string,
  before: Stored,
): Promise<{ count: number; stored: Stored | null; settled: boolean }> {
  let stored = before
  for (let tries = 1; ; tries++) {
    let count = 0
    let after = START
    for (;;) {
      const page = await ctx.runQuery(checkRef, { issue_id: issueId, after })
      count += page.rows
      after = page.through
      if (page.done) break
    }
    const now = await ctx.runQuery(stateRef, { issue_id: issueId })
    if (now === null) return { count, stored: null, settled: true }
    // storedOf builds both, so their keys come in the same order
    const settled = JSON.stringify(now) === JSON.stringify(stored)
    if (settled || tries === DRY_TRIES) return { count, stored: now, settled }
    stored = now
  }
}

/** `raw`, a cursor a call answered, or a refusal of anything else. */
function parseCursor(raw: string): Cursor {
  const parsed: unknown = JSON.parse(raw)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('org' in parsed) ||
    !('num' in parsed) ||
    typeof parsed.org !== 'string' ||
    typeof parsed.num !== 'number'
  )
    throw new Error('cursor must be one a call of run answered')
  return { org: parsed.org, num: parsed.num }
}

/** Counts every live task not counted yet, finishes the counts under way,
 * or counts every task again with `recount`, from `cursor` on, organization
 * by organization in id order and task by task in number order. Answers how
 * many tasks it counted and the comments they hold, and lists up to
 * TASK_PAGE.listed of the tasks with LIMITS.comments.max comments or more
 * (`full_tasks`, `full` in all). Past RUN.ms it stops between pages of tasks,
 * after one page at least, and answers the `cursor` to go on from, else
 * `done`. A dry run writes nothing. It counts each task's thread (dryCount)
 * and answers the same
 * totals for the tasks it would count, lists up to TASK_PAGE.listed of
 * them, and lists the tasks counted already whose counts their threads do
 * not give (`differ`, `differing` in all). A task whose thread kept changing
 * through every count is listed in `unsettled_tasks` (`unsettled` in all)
 * instead, for a later dry run. A call that wrote ends with its audit row. */
export const run = internalAction({
  args: { dry_run: v.boolean(), recount: v.optional(v.boolean()), cursor: v.optional(v.string()) },
  handler: async (ctx, { dry_run, recount = false, cursor: from }) => {
    const until = Date.now() + RUN.ms
    const totals = { orgs: 0, tasks: 0, counted: 0, comments: 0, full: 0 }
    const toCount: TaskReport[] = []
    const full: TaskReport[] = []
    const differ: (TaskReport & { stored: number })[] = []
    const unsettledTasks: string[] = []
    let differing = 0
    let unsettled = 0
    const listFull = (report: TaskReport) => {
      if (report.count < LIMITS.comments.max) return
      if (totals.full++ < TASK_PAGE.listed) full.push(report)
    }

    const countTask = async (orgId: string, task: TaskState): Promise<void> => {
      const { issue_id, stored } = task
      totals.tasks++
      const due = recount || stored.state !== 'exact'
      if (!dry_run) {
        if (!due) {
          if (stored.state === 'exact') listFull({ issue_id, org_id: orgId, count: stored.count })
          return
        }
        let got: number | 'skipped' | null = null
        for (let first = true; got === null; first = false)
          got = await ctx.runMutation(stepRef, { issue_id, restart: recount && first })
        if (got === 'skipped') return
        totals.counted++
        totals.comments += got
        listFull({ issue_id, org_id: orgId, count: got })
        return
      }
      const dry = await dryCount(ctx, issue_id, stored)
      if (dry.stored === null) return
      const report: TaskReport = { issue_id, org_id: orgId, count: dry.count }
      if (!dry.settled) {
        if (unsettled++ < TASK_PAGE.listed) unsettledTasks.push(issue_id)
      } else if (dry.stored.state === 'exact' && dry.stored.count !== dry.count) {
        if (differing++ < TASK_PAGE.listed) differ.push({ ...report, stored: dry.stored.count })
      }
      listFull(report)
      if (!due) return
      totals.counted++
      totals.comments += dry.count
      if (toCount.length < TASK_PAGE.listed) toCount.push(report)
    }

    /** Goes through organization `orgId`'s tasks numbered past `after`, a
     * page at least. Answers null once it went through all of them, or the
     * number to go on from once RUN.ms has passed. */
    const countOrg = async (orgId: string, after: number): Promise<number | null> => {
      totals.orgs++
      for (let through = after; ; ) {
        const page = await ctx.runQuery(taskPageRef, { org_id: orgId, after: through })
        for (const task of page.tasks) await countTask(orgId, task)
        through = page.through
        if (page.done) return null
        if (Date.now() >= until) return through
      }
    }

    // each call goes through one page of tasks at least, so calls get on
    let stopped: Cursor | null = null
    let after: string | null = null
    let started = false
    if (from !== undefined) {
      const at = parseCursor(from)
      const left = await countOrg(at.org, at.num)
      if (left !== null) stopped = { org: at.org, num: left }
      after = at.org
      started = true
    }
    while (stopped === null) {
      const page = await ctx.runQuery(orgPageRef, { after })
      for (const org of page.orgs) {
        if (started && Date.now() >= until) {
          stopped = { org, num: START }
          break
        }
        const left = await countOrg(org, START)
        after = org
        started = true
        if (left !== null) {
          stopped = { org, num: left }
          break
        }
      }
      if (page.done) break
    }
    if (!dry_run)
      await ctx.runMutation(auditRef, {
        counted: totals.counted,
        comments: totals.comments,
        full: totals.full,
      })
    return {
      dry_run,
      ...totals,
      to_count: toCount,
      full_tasks: full,
      differing,
      differ,
      unsettled,
      unsettled_tasks: unsettledTasks,
      done: stopped === null,
      cursor: stopped === null ? null : JSON.stringify(stopped),
    }
  },
})

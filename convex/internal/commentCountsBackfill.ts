/* One-time migration that counts the comments of every live task stored
 * before comment counts existed into its task_comment_counts row
 * (schema.ts), the row the comment cap reads (model/commentLimits.ts).
 * Tasks created since this release are counted from their start
 * (startCount), and a task Deleted items writes back counts itself
 * (beginCount).
 *
 * Until a task is counted, each post on it counts its thread first, in the
 * post's own transaction, within COUNT_BUDGET.post. A thread longer than
 * that, about 1.5 MiB of comments, refuses the post and every archive with
 * a reason for now ("Qivo is still counting this task's comments"), and the
 * refusal starts the count in the background, so a later try passes. Run
 * this soon after the deployment serves the release anyway, so no post
 * waits. A thread that holds LIMITS.comments.max comments or more refuses
 * them until comments are deleted, as the cap asks.
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
 * the tasks that hold LIMITS.comments.max comments or more (`full`), the
 * counts the recovery gave up on (`stuck`), and the count rows that name no
 * live or deleted task of their organization (`drift`), with ids and counts
 * only. A task whose thread changed while it counted is counted again, and
 * one that kept changing is listed as unsettled, to check again with a
 * later dry run. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/commentCountsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/commentCountsBackfill:run '{"dry_run": false}'
 * A call stops after RUN.ms, well inside Convex's action time limit, between
 * any two steps or pages, and then answers `done: false` with a `cursor`,
 * which can go on inside an organization and inside a task's count. Call it
 * again with the same arguments and `"cursor"` set to it until `done` is
 * true. Every list is cut at TASK_PAGE.listed, so read the totals: a
 * deployment is ready when every call of a dry run, followed through its
 * cursors until `done`, answers `counted: 0`, `stuck: 0` and `drift: 0`.
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). On the demo, whose stored key cannot run internal
 * functions, the private with-temp-deploy-key helper runs each command with
 * a short-lived key; `run`, an internal action, needs
 * deployment:functions:runInternalActions.
 *
 * A run counts the tasks not counted yet, finishes the counts under way,
 * stuck ones included, deletes the drifting rows, and leaves exact counts as
 * they are. `"recount": true` counts every task again, to mend counts a dry
 * run lists as differing. After a rollback to a release before counts, whose
 * posts, deletes and Deleted items moves move no count, read a dry run and
 * run it with `"recount": true`. Each call that wrote adds one
 * platform_audit_log row (action 'comment_counts_backfill', actor 'system')
 * with its totals and the cursor to go on from, also when a step fails, and
 * then the call fails. Running it again is safe. It writes no activity,
 * sends no task event and changes nothing a person sees, except that a post
 * on a task it counted no longer counts the thread first. Tasks in Deleted
 * items are left alone; a restore counts them. */
import { makeFunctionReference } from 'convex/server'
import { getDocumentSize, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
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

/** Count rows one page of the drift check reads, and the bytes of the tasks
 * it reads for them before it ends early (rowPage). Tests lower them. */
export const ROW_PAGE = { rows: 200, bytes: 4 * MIB }

/** Organizations one page of a run reads, and how long one call of run
 * goes on before it answers where to go on from. Tests lower them. */
export const RUN = { orgs: 100, ms: 5 * 60_000 }

/** How many times a dry run counts a task whose thread changes while it
 * counts. */
const DRY_TRIES = 3

/** A task's count as its row holds it: none without a row, the count so
 * far while one is under way, and the exact count once it ends. */
type Stored = { state: 'none' } | { state: 'counting' | 'exact'; count: number; stuck: boolean }

/** What a dry run compares before and after it counts a task: the row's
 * revision, which every write that moves its count or the comments under
 * it raises, and the newest comment, which every new comment changes. A
 * thread that changed between the two reads cannot show both as they were.
 * A task without a row has only the newest comment, so a lone delete of an
 * older comment there can go unnoticed; such a task is due for a count
 * anyway. */
type Mark = { revision: number | null; newest: string | null }

/** One live task with its stored count. */
type TaskState = { issue_id: string; num: number; stored: Stored }

/** A page of an organization's live tasks, and the task number it read
 * through. */
type TaskPage = { tasks: TaskState[]; through: number; done: boolean }

/** A dry count a call stopped inside of: where it got to, what it counted,
 * the mark it started from and how many times it counted the task. */
type DryCount = { after: number; count: number; mark: Mark; tries: number }

/** Where a count row stands against its task: `live` and `stored` (in
 * Deleted items) in the row's organization, or drifting, `other_org` when
 * the id now names a live task of another organization and `orphan` when it
 * names no task. */
type RowWhere = 'live' | 'stored' | 'other_org' | 'orphan'

/** A page of an organization's count rows, and the _creationTime it read
 * through. */
type RowPage = { rows: { issue_id: string; where: RowWhere }[]; through: number; done: boolean }

/** Where a call goes on from: organization `org`, in its tasks numbered past
 * `after` (phase 'tasks'), or in its count rows created after `after` (phase
 * 'rows'). `task` names a task numbered past `after` that the call stopped
 * inside of, whose count a recount has restarted already, and for a dry run
 * `dry` holds how far it counted. */
type Cursor = {
  org: string
  phase: 'tasks' | 'rows'
  after: number
  task?: string
  dry?: DryCount
}

/** A task as a report lists it. */
type TaskReport = { issue_id: string; org_id: string; count: number }

const storedOf = (row: Doc<'task_comment_counts'> | null): Stored =>
  row === null
    ? { state: 'none' }
    : {
        state: row.counted === undefined ? 'exact' : 'counting',
        count: row.count,
        stuck: row.stuck === true,
      }

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
    for (const task of read) {
      const row = await countRow(ctx, task.id)
      // a row another organization's task left is no count of this one
      const own = row?.org_id === task.org_id ? row : null
      tasks.push({ issue_id: task.id, num: task.num, stored: storedOf(own) })
    }
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

/** Task `issue_id`'s stored count and its Mark, or null once it is no
 * longer live. */
export const state = internalQuery({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }): Promise<{ stored: Stored; mark: Mark } | null> => {
    const task = await byId(ctx, 'issues', issue_id)
    if (task === null) return null
    const found = await countRow(ctx, issue_id)
    const row = found?.org_id === task.org_id ? found : null
    const newest = await ctx.db
      .query('comments')
      .withIndex('by_issue', (q) => q.eq('issue_id', issue_id))
      .order('desc')
      .first()
    return {
      stored: storedOf(row),
      mark: {
        revision: row?.revision ?? null,
        newest: newest === null ? null : `${newest._creationTime}:${newest._id}`,
      },
    }
  },
})

/** Counts, without writing, one page of task `issue_id`'s comments created
 * after `after` (model/commentLimits.ts countPage). */
export const check = internalQuery({
  args: { issue_id: v.string(), after: v.number() },
  handler: async (ctx, { issue_id, after }): Promise<CountPage> =>
    await countPage(ctx, issue_id, after, COUNT_BUDGET.step),
})

/** Where count row `row` stands against its task (RowWhere), with the
 * bytes of what it read to tell. */
async function whereIs(
  ctx: QueryCtx,
  row: Doc<'task_comment_counts'>,
): Promise<{ where: RowWhere; bytes: number }> {
  const live = await byId(ctx, 'issues', row.issue_id)
  if (live !== null)
    return {
      where: live.org_id === row.org_id ? 'live' : 'other_org',
      bytes: getDocumentSize(live),
    }
  const stored = await ctx.db
    .query('deleted_rows')
    .withIndex('by_row', (q) => q.eq('table', 'issues').eq('row_id', row.issue_id))
    .first()
  return {
    where: stored?.org_id === row.org_id ? 'stored' : 'orphan',
    bytes: stored === null ? 0 : getDocumentSize(stored),
  }
}

/** One page of organization `org_id`'s count rows created after `after`,
 * each with where it stands against its task. It ends at ROW_PAGE rows or
 * once the rows and the tasks it read for them hold ROW_PAGE bytes, after
 * every row that shares the last one's _creationTime. */
export const rowPage = internalQuery({
  args: { org_id: v.string(), after: v.number() },
  handler: async (ctx, { org_id, after }): Promise<RowPage> => {
    const read = await ctx.db
      .query('task_comment_counts')
      .withIndex('by_org', (q) => q.eq('org_id', org_id).gt('_creationTime', after))
      .take(ROW_PAGE.rows)
    const out: RowPage['rows'] = []
    let bytes = 0
    for (const [i, row] of read.entries()) {
      const { where, bytes: more } = await whereIs(ctx, row)
      bytes += getDocumentSize(row) + more
      out.push({ issue_id: row.issue_id, where })
      const next = read[i + 1]
      // a page ends between two times, so the next page starts after this one
      if (next !== undefined && next._creationTime === row._creationTime) continue
      if (bytes >= ROW_PAGE.bytes || (next === undefined && read.length === ROW_PAGE.rows))
        return { rows: out, through: row._creationTime, done: false }
    }
    return { rows: out, through: read.at(-1)?._creationTime ?? after, done: true }
  },
})

/** Deletes organization `org_id`'s count row of `issue_id` while it still
 * drifts (whereIs). Answers whether it did. */
export const dropRow = internalMutation({
  args: { org_id: v.string(), issue_id: v.string() },
  handler: async (ctx, { org_id, issue_id }): Promise<boolean> => {
    const row = await countRow(ctx, issue_id)
    if (row === null || row.org_id !== org_id) return false
    const { where } = await whereIs(ctx, row)
    if (where === 'live' || where === 'stored') return false
    await ctx.db.delete(row._id)
    return true
  },
})

/** One step of the count of live task `issue_id`. It starts the count
 * where the task has no row or one of another organization, or with
 * `restart` from the start of the thread, and counts one page
 * (model/commentLimits.ts stepCount), a stuck count included. Answers the
 * count once it is exact, null while it counts, and 'skipped' for a task no
 * longer live, such as one deleted meanwhile. */
export const step = internalMutation({
  args: { issue_id: v.string(), restart: v.boolean() },
  handler: async (ctx, { issue_id, restart }): Promise<number | 'skipped' | null> => {
    const issue = await byId(ctx, 'issues', issue_id)
    if (issue === null) return 'skipped'
    const row = await countRow(ctx, issue_id)
    const fresh = {
      org_id: issue.org_id,
      issue_id,
      count: 0,
      counted: START,
      progress_at: Date.now(),
    }
    if (row === null) await ctx.db.insert('task_comment_counts', { ...fresh, revision: 0 })
    else if (restart || row.org_id !== issue.org_id)
      await ctx.db.replace(row._id, { ...fresh, revision: row.revision + 1 })
    return await stepCount(ctx, issue_id)
  },
})

/** Records a call of a run that wrote, with its totals, the cursor to go on
 * from, null once done, and the failure that ended it, if one did. */
export const audit = internalMutation({
  args: {
    counted: v.number(),
    comments: v.number(),
    full: v.number(),
    dropped: v.number(),
    cursor: v.union(v.string(), v.null()),
    failed: v.optional(v.string()),
  },
  handler: async (ctx, detail) => {
    await writeAudit(ctx, {
      actor_email: 'system',
      action: 'comment_counts_backfill',
      detail,
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
const rowPageRef = makeFunctionReference<'query', { org_id: string; after: number }, RowPage>(
  'internal/commentCountsBackfill:rowPage',
)
const stateRef = makeFunctionReference<
  'query',
  { issue_id: string },
  { stored: Stored; mark: Mark } | null
>('internal/commentCountsBackfill:state')
const checkRef = makeFunctionReference<'query', { issue_id: string; after: number }, CountPage>(
  'internal/commentCountsBackfill:check',
)
const stepRef = makeFunctionReference<
  'mutation',
  { issue_id: string; restart: boolean },
  number | 'skipped' | null
>('internal/commentCountsBackfill:step')
const dropRowRef = makeFunctionReference<'mutation', { org_id: string; issue_id: string }, boolean>(
  'internal/commentCountsBackfill:dropRow',
)
const auditRef = makeFunctionReference<
  'mutation',
  {
    counted: number
    comments: number
    full: number
    dropped: number
    cursor: string | null
    failed?: string
  },
  null
>('internal/commentCountsBackfill:audit')

/** `raw`, a cursor a call answered, or a refusal of anything else. */
function parseCursor(raw: string): Cursor {
  const parsed: unknown = JSON.parse(raw)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('org' in parsed && typeof parsed.org === 'string') ||
    !('phase' in parsed && (parsed.phase === 'tasks' || parsed.phase === 'rows')) ||
    !('after' in parsed && typeof parsed.after === 'number')
  )
    throw new Error('cursor must be one a call of run answered')
  return parsed as Cursor
}

/** The same Mark, read twice. */
const sameMark = (a: Mark, b: Mark): boolean => a.revision === b.revision && a.newest === b.newest

/** Counts every live task not counted yet, finishes the counts under way,
 * stuck ones included, or counts every task again with `recount`, from
 * `cursor` on, organization by organization in id order and task by task in
 * number order, then checks each organization's count rows against their
 * tasks and deletes those that drift. Answers how many tasks it counted and
 * the comments they hold, and lists up to TASK_PAGE.listed of the tasks with
 * LIMITS.comments.max comments or more (`full_tasks`, `full` in all), of the
 * stuck counts (`stuck_tasks`, `stuck` in all) and of the drifting rows
 * (`drift_rows`, `drift` in all; `dropped` deleted). Past RUN.ms it stops
 * between two steps or pages, after one at least, and answers the `cursor`
 * to go on from, else `done`. A dry run writes nothing. It counts each
 * task's thread in queries of their own, again while its Mark moved (at most
 * DRY_TRIES times), answers the same totals for the tasks it would count,
 * lists up to TASK_PAGE.listed of them, and lists the tasks counted already
 * whose counts their threads do not give (`differ`, `differing` in all). A
 * task whose thread kept changing is listed in `unsettled_tasks`
 * (`unsettled` in all) instead, for a later dry run. A call that wrote ends
 * with its audit row, also when a step throws, and then throws. */
export const run = internalAction({
  args: { dry_run: v.boolean(), recount: v.optional(v.boolean()), cursor: v.optional(v.string()) },
  handler: async (ctx, { dry_run, recount = false, cursor: from }) => {
    const until = Date.now() + RUN.ms
    const totals = { orgs: 0, tasks: 0, counted: 0, comments: 0, full: 0, stuck: 0, dropped: 0 }
    const toCount: TaskReport[] = []
    const full: TaskReport[] = []
    const stuckTasks: string[] = []
    const differ: (TaskReport & { stored: number })[] = []
    const unsettledTasks: string[] = []
    const driftRows: { issue_id: string; org_id: string; where: RowWhere }[] = []
    let differing = 0
    let unsettled = 0
    let drift = 0
    const listed = <T>(list: T[], total: number, item: T) => {
      if (total <= TASK_PAGE.listed) list.push(item)
    }
    const listFull = (report: TaskReport) => {
      if (report.count >= LIMITS.comments.max) listed(full, ++totals.full, report)
    }
    // each call moves its cursor or a count at least once, so calls get on
    let moved = false
    const late = () => moved && Date.now() >= until
    const at = from === undefined ? null : parseCursor(from)
    // where a call that ends now goes on from
    let resume: Cursor | null = at

    /** Counts task `task` of `orgId`, which `pos` stands before, going on
     * from `inside` when the call before stopped inside it. Answers null
     * once done with it, or how far it got once RUN.ms has passed. */
    const countTask = async (
      pos: Cursor,
      task: TaskState,
      inside: Cursor | null,
    ): Promise<{ dry?: DryCount } | null> => {
      const orgId = pos.org
      const { issue_id, stored } = task
      if (inside === null) {
        totals.tasks++
        if (stored.state !== 'none' && stored.stuck) listed(stuckTasks, ++totals.stuck, issue_id)
      }
      const due = recount || stored.state !== 'exact'
      if (!dry_run) {
        if (!due) {
          if (stored.state === 'exact') listFull({ issue_id, org_id: orgId, count: stored.count })
          return null
        }
        // a recount the call before stopped inside of has restarted already
        let restart = recount && inside === null
        for (;;) {
          const got = await ctx.runMutation(stepRef, { issue_id, restart })
          moved = true
          // a failure from here on goes on without restarting it again
          if (restart) resume = { ...pos, task: issue_id }
          restart = false
          if (got === 'skipped') return null
          if (got !== null) {
            totals.counted++
            totals.comments += got
            listFull({ issue_id, org_id: orgId, count: got })
            return null
          }
          if (late()) return {}
        }
      }
      let dry = inside?.dry
      if (dry === undefined) {
        const first = await ctx.runQuery(stateRef, { issue_id })
        if (first === null) return null
        dry = { after: START, count: 0, mark: first.mark, tries: 1 }
      }
      for (;;) {
        const page: CountPage = await ctx.runQuery(checkRef, { issue_id, after: dry.after })
        moved = true
        dry = { ...dry, after: page.through, count: dry.count + page.rows }
        if (page.done) {
          const now = await ctx.runQuery(stateRef, { issue_id })
          if (now === null) return null
          const settled = sameMark(now.mark, dry.mark)
          if (!settled && dry.tries < DRY_TRIES) {
            dry = { after: START, count: 0, mark: now.mark, tries: dry.tries + 1 }
            continue
          }
          const report: TaskReport = { issue_id, org_id: orgId, count: dry.count }
          if (!settled) listed(unsettledTasks, ++unsettled, issue_id)
          else if (now.stored.state === 'exact' && now.stored.count !== dry.count)
            listed(differ, ++differing, { ...report, stored: now.stored.count })
          listFull(report)
          if (due) {
            totals.counted++
            totals.comments += dry.count
            listed(toCount, totals.counted, report)
          }
          return null
        }
        if (late()) return { dry }
      }
    }

    /** Goes through organization `orgId` from `start`. Answers null once
     * done with it, or the cursor to go on from once RUN.ms has passed. */
    const countOrg = async (start: Cursor): Promise<Cursor | null> => {
      const orgId = start.org
      totals.orgs++
      let pos = start
      if (pos.phase === 'tasks') {
        for (;;) {
          if (late()) return pos
          const page = await ctx.runQuery(taskPageRef, { org_id: orgId, after: pos.after })
          for (const task of page.tasks) {
            if (late()) return pos
            const inside = pos.task === task.issue_id ? pos : null
            const stopped = await countTask(pos, task, inside)
            if (stopped !== null)
              return {
                org: orgId,
                phase: 'tasks',
                after: pos.after,
                task: task.issue_id,
                ...stopped,
              }
            pos = { org: orgId, phase: 'tasks', after: task.num }
            resume = pos
            moved = true
          }
          pos = { org: orgId, phase: 'tasks', after: page.through }
          resume = pos
          if (page.done) break
        }
        pos = { org: orgId, phase: 'rows', after: START }
        resume = pos
      }
      for (;;) {
        if (late()) return pos
        const page = await ctx.runQuery(rowPageRef, { org_id: orgId, after: pos.after })
        for (const row of page.rows) {
          if (row.where === 'live' || row.where === 'stored') continue
          listed(driftRows, ++drift, { issue_id: row.issue_id, org_id: orgId, where: row.where })
          if (
            !dry_run &&
            (await ctx.runMutation(dropRowRef, { org_id: orgId, issue_id: row.issue_id }))
          )
            totals.dropped++
        }
        pos = { org: orgId, phase: 'rows', after: page.through }
        resume = pos
        moved = true
        if (page.done) return null
      }
    }

    const report = (done: boolean) => ({
      dry_run,
      ...totals,
      to_count: toCount,
      full_tasks: full,
      stuck_tasks: stuckTasks,
      differing,
      differ,
      unsettled,
      unsettled_tasks: unsettledTasks,
      drift,
      drift_rows: driftRows,
      done,
      cursor: done || resume === null ? null : JSON.stringify(resume),
    })
    const record = (failed?: string) =>
      ctx.runMutation(auditRef, {
        counted: totals.counted,
        comments: totals.comments,
        full: totals.full,
        dropped: totals.dropped,
        cursor: resume === null ? null : JSON.stringify(resume),
        ...(failed === undefined ? {} : { failed }),
      })

    try {
      let after: string | null = null
      if (at !== null) {
        const stopped = await countOrg(at)
        if (stopped !== null) {
          resume = stopped
          if (!dry_run) await record()
          return report(false)
        }
        after = at.org
      }
      for (;;) {
        const page = await ctx.runQuery(orgPageRef, { after })
        for (const org of page.orgs) {
          resume = { org, phase: 'tasks', after: START }
          if (late()) {
            if (!dry_run) await record()
            return report(false)
          }
          const stopped = await countOrg(resume)
          if (stopped !== null) {
            resume = stopped
            if (!dry_run) await record()
            return report(false)
          }
          after = org
        }
        if (page.done) break
      }
      resume = null
      if (!dry_run) await record()
      return report(true)
    } catch (e) {
      console.error('The comment count backfill failed; go on from its cursor', {
        cursor: resume === null ? null : JSON.stringify(resume),
        error: e,
      })
      if (!dry_run) await record(e instanceof Error ? e.message : String(e))
      throw e
    }
  },
})

/* One-time repair: mark read the unread messages about tasks archived
 * before the archive paths marked them read (commit c311ec84, 2026-10-15,
 * model/messages.ts "archived tasks"). Such a message stays unread for
 * good: no inbox shows the task, retention never deletes an unread
 * message, and the unread summary (model/inboxReads.ts) reads the task of
 * every such item on every run, so about 2,000 of them keep a seat's
 * summary incomplete for good. A task archived since has its messages
 * marked read by the archive's own steps, and a message about an archived
 * task is stored read.
 *
 * It walks every organization's archived tasks (issues.by_org_archived,
 * whose key an archived task keeps), one page a query, and asks for each
 * whether it holds an unread message (messages.by_issue_read, one index
 * range). For those that do, it schedules the archive's own read steps
 * (messages:readArchivedTasks, model/messages.ts scheduleTaskReads). Each
 * step checks the archive again when it runs, so a task restored meanwhile
 * keeps its messages, and marks every unread or snoozed message of the task
 * read for every recipient, keeping the prune's invariant, the sweep rows
 * and the inbox items, as after any archive. Active tasks in an archived
 * project are left out: the summary skips such a project with one seek,
 * without reading its tasks, so they cost it nothing, and finding them
 * would mean walking every active task of every archived project.
 *
 * Check a deployment before changing it. `remaining` is a query, so it
 * cannot write, and a key that may only run internal queries can run it. It
 * counts the archived tasks on one page that hold an unread message and
 * lists the first of them. Start with `{}`, pass the returned `org_id` and
 * `cursor` back until `done` is true. If every page reports zero `tasks`,
 * the deployment has nothing to mark. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/archivedReadsBackfill:remaining '{}'
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). Read the dry run, which writes nothing, then run it,
 * wait for the scheduled read steps, which take seconds, and read a new dry
 * run, which then reports zero `tasks`:
 *   "$H" staging npx convex run internal/archivedReadsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/archivedReadsBackfill:run '{"dry_run": false}'
 * A call stops between two pages once RUN.ms has passed, well inside
 * Convex's action time limit, and then answers `done: false` with an
 * `org_id` and a `cursor`, which go on inside that organization. Call it
 * again with the same arguments and both of those, unchanged, until `done`
 * is true. A cursor without its org_id is refused. A page that fails ends
 * the call with `error`, after the audit row of what committed, and the
 * `org_id` and `cursor` of the page to read again.
 *
 * On the demo, whose stored key cannot run internal functions, the private
 * with-temp-deploy-key helper runs each command with a short-lived key:
 * `remaining` needs deployment:functions:runInternalQueries and `run`, an
 * internal action, deployment:functions:runInternalActions.
 *
 * A call that is not a dry run adds one platform_audit_log row (action
 * 'archived_reads_backfill', actor 'system') with its counts and where to
 * go on from. Running it again is safe: a task whose messages are all read
 * is not found, and a step that runs twice finds nothing left to mark. It
 * writes no activity and sends no task event. A person sees fewer unread
 * messages only about tasks no inbox shows, and finds them read if a
 * restore brings the task back, as after an archive since c311ec84. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { badRequest } from '../lib/functions'
import { MIB } from '../lib/limits'
import { audit as writeAudit } from '../model/admin'
import { scheduleTaskReads } from '../model/messages'

/** Archived tasks one page reads, the bytes it may read, and how many of
 * the tasks found a result lists. A page reads each task, up to about
 * 60 KB with a long description, and one index range for each, so 200
 * stay far inside Convex's 4,096 ranges. Tests lower them. */
export const PAGE = { tasks: 200, bytes: 4 * MIB, listed: 20 }

/** How long one call of run goes on before it answers where to go on from.
 * Tests lower it. */
export const RUN = { ms: 5 * 60_000 }

/** Where a walk goes on: an organization and a page cursor of its
 * archived tasks, null for its first page. */
type Where = { org_id: string; cursor: string | null }

/** What one page found: the archived tasks holding an unread message, and
 * where the next page starts, null after the last organization. */
type PageResult = { found: string[]; next: Where | null }

/* The id of the first organization after `after` in id order, or of the
 * first one without it, or null when none is left. An organization deleted
 * since it was named still orders the walk by its id. */
async function orgAfter(ctx: QueryCtx, after: string | null): Promise<string | null> {
  const org = await ctx.db
    .query('organizations')
    .withIndex('by_uuid', (q) => (after === null ? q : q.gt('id', after)))
    .first()
  return org?.id ?? null
}

/* One page of the archived tasks of the organization `at` names, or of the
 * first organization without `at`, read without writing. The check and the
 * run share it, so both find the same tasks. */
async function walk(ctx: QueryCtx, at: Where | null): Promise<PageResult> {
  const orgId = at?.org_id ?? (await orgAfter(ctx, null))
  if (orgId === null) return { found: [], next: null }
  const page = await ctx.db
    .query('issues')
    .withIndex('by_org_archived', (q) => q.eq('org_id', orgId).gt('archived_at', undefined))
    .paginate({
      cursor: at?.cursor ?? null,
      numItems: PAGE.tasks,
      maximumBytesRead: PAGE.bytes,
    })
  const found: string[] = []
  for (const task of page.page) {
    const unread = await ctx.db
      .query('messages')
      .withIndex('by_issue_read', (q) => q.eq('issue_id', task.id).eq('read_at', undefined))
      .first()
    if (unread !== null) found.push(task.id)
  }
  if (!page.isDone) return { found, next: { org_id: orgId, cursor: page.continueCursor } }
  const next = await orgAfter(ctx, orgId)
  return { found, next: next === null ? null : { org_id: next, cursor: null } }
}

const vWhere = {
  org_id: v.optional(v.union(v.string(), v.null())),
  cursor: v.optional(v.union(v.string(), v.null())),
}

/* `org_id` and `cursor` as a walk takes them, refusing a cursor without
 * its organization. */
function whereOf(a: { org_id?: string | null; cursor?: string | null }): Where | null {
  if ((a.org_id ?? null) === null) {
    if ((a.cursor ?? null) !== null)
      throw badRequest('a cursor goes back with the org_id it was answered with')
    return null
  }
  return { org_id: a.org_id as string, cursor: a.cursor ?? null }
}

/** One page of archived tasks and those of them holding an unread message
 * (walk). */
export const scan = internalQuery({
  args: vWhere,
  handler: async (ctx, a): Promise<PageResult> => await walk(ctx, whereOf(a)),
})

/** Schedules the archive's read steps for the tasks `issues`
 * (model/messages.ts scheduleTaskReads) and answers how many it named. */
export const mark = internalMutation({
  args: { issues: v.array(v.string()) },
  handler: async (ctx, { issues }): Promise<number> => {
    await scheduleTaskReads(ctx, issues)
    return issues.length
  },
})

/** Counts, without writing, the archived tasks on one page that hold an
 * unread message, and lists the first PAGE.listed. Leave out `org_id` and
 * `cursor` for the first page, then call again with the returned ones
 * until `done`. */
export const remaining = internalQuery({
  args: vWhere,
  handler: async (ctx, a) => {
    const { found, next } = await walk(ctx, whereOf(a))
    return {
      tasks: found.length,
      listed: found.slice(0, PAGE.listed),
      done: next === null,
      org_id: next?.org_id ?? null,
      cursor: next?.cursor ?? null,
    }
  },
})

/** The counts a call adds up and where it goes on from. */
const vRecord = v.object({
  tasks: v.number(),
  scheduled: v.number(),
  pages: v.number(),
  done: v.boolean(),
  org_id: v.union(v.string(), v.null()),
  cursor: v.union(v.string(), v.null()),
  error: v.optional(v.string()),
})

/** Records a call that was not a dry run, with its counts and where to go
 * on from. */
export const audit = internalMutation({
  args: vRecord,
  handler: async (ctx, record) => {
    await writeAudit(ctx, {
      actor_email: 'system',
      action: 'archived_reads_backfill',
      detail: record,
    })
    return null
  },
})

const scanRef = makeFunctionReference<
  'query',
  { org_id: string | null; cursor: string | null },
  PageResult
>('internal/archivedReadsBackfill:scan')
const markRef = makeFunctionReference<'mutation', { issues: string[] }, number>(
  'internal/archivedReadsBackfill:mark',
)
const auditRef = makeFunctionReference<
  'mutation',
  {
    tasks: number
    scheduled: number
    pages: number
    done: boolean
    org_id: string | null
    cursor: string | null
    error?: string
  },
  null
>('internal/archivedReadsBackfill:audit')

/** Walks the pages of archived tasks from `org_id` and `cursor` on, or from
 * the first organization, and reports how many tasks it found holding an
 * unread message (`tasks`, the first PAGE.listed of them in `listed`) and
 * for how many it scheduled the read steps (`scheduled`, none in a dry
 * run). Between two pages past RUN.ms, once it has read one, it answers the
 * `org_id` and `cursor` to go on from, else `done`. A page that fails ends
 * the call with `error` and the page to read again. A call that is not a
 * dry run ends with its audit row of what committed. */
export const run = internalAction({
  args: { dry_run: v.boolean(), ...vWhere },
  handler: async (ctx, a) => {
    let where = whereOf(a)
    const until = Date.now() + RUN.ms
    const counts = { tasks: 0, scheduled: 0, pages: 0 }
    const listed: string[] = []
    let done = false
    let error: string | null = null
    for (;;) {
      // every call reads one page before it may stop, so each moves on
      if (counts.pages > 0 && Date.now() >= until) break
      try {
        const page: PageResult = await ctx.runQuery(scanRef, {
          org_id: where?.org_id ?? null,
          cursor: where?.cursor ?? null,
        })
        if (!a.dry_run && page.found.length > 0)
          counts.scheduled += await ctx.runMutation(markRef, { issues: page.found })
        // counted once the page is through, as a stop before that reads
        // the page again
        counts.tasks += page.found.length
        listed.push(...page.found.slice(0, PAGE.listed - listed.length))
        counts.pages += 1
        if (page.next === null) {
          done = true
          break
        }
        where = page.next
      } catch (failure) {
        // what committed stays; the page is read again from its start
        error = failure instanceof Error ? failure.message : String(failure)
        break
      }
    }
    const at = {
      done,
      org_id: done ? null : (where?.org_id ?? null),
      cursor: done ? null : (where?.cursor ?? null),
    }
    const failed = error === null ? {} : { error }
    if (!a.dry_run) await ctx.runMutation(auditRef, { ...counts, ...at, ...failed })
    return { dry_run: a.dry_run, ...counts, listed, ...at, ...failed }
  },
})

/* A one-time backfill for tasks archived, or in projects archived, before
 * archiving did two things itself. It marks read the inbox messages about
 * them (model/messages.ts "archived tasks"), and it marks the relation rows
 * of the archived tasks so the app snapshot skips them
 * (model/archiveMarks.ts). Since then every archive path schedules both and
 * mark unread and snooze refuse an archived task, so only older data needs
 * this. No inbox lists such a task, and its unread rows fill the bounded
 * unread walk (lib/inbox.ts) until visible messages drop out of it. Its
 * unmarked rows cost the snapshot reads but are never shown.
 *
 * `start` reads one page of organizations and schedules `org` for each, then
 * the next page. `org` reads one page of the organization's archived tasks
 * (issues by_org_archived), then of its projects, keeping the archived
 * ones, and passes each page to scheduleArchivedReads, the call every
 * archive path makes. Each step schedules the next until the organization
 * is done and then logs 'Archived reads backfill scheduled' with its counts.
 * The steps scheduleArchivedReads starts mark the messages read, and the
 * archived tasks' rows, in the background shortly after. A project archive
 * marks no relation row, so the tasks of an archived project that are not
 * archived themselves keep theirs.
 *
 * Running it twice, or while it runs, is safe. The steps change only rows
 * that are still unread or snoozed, or still unmarked on a task that is
 * archived when the step runs, so a second run finds nothing to change, and
 * an overlap with a live archive is harmless. A task or project restored
 * before its step runs is left alone. An empty deployment schedules nothing.
 *
 * Run it once per deployment and only with the user's approval. From a Qivo
 * checkout, the private helper loads the keys and the command chooses the
 * deployment, for example development:
 *
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-env" \
 *     sh -c 'export CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY_DEVELOPMENT"; exec npx convex run internal/archivedReadsBackfill:start'
 *
 * Production uses CONVEX_DEPLOY_KEY_PRODUCTION and the demo backend
 * CONVEX_DEPLOY_KEY_DEMO_PRODUCTION in the same command. Staging's key is
 * loaded by the staging helper, which also selects it:
 *
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-staging" \
 *     npx convex run internal/archivedReadsBackfill:start
 *
 * The command returns once the first page is scheduled. Follow the progress
 * in the deployment's logs. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalMutation } from '../_generated/server'
import { ARCHIVED_READ_TASKS, scheduleArchivedReads } from '../model/messages'

/* Organizations per `start` step, each one scheduled call. */
const ORG_PAGE = 64

/* Archived tasks per `org` step. ARCHIVED_READ_TASKS is what one
 * scheduleArchivedReads step takes, so a page schedules one step. */
const TASK_PAGE = ARCHIVED_READ_TASKS

/* The most bytes of tasks one `org` step reads. Task descriptions have no
 * size cap, so a page also ends early on bytes. */
const TASK_PAGE_BYTES = 8 * 1024 * 1024

/* Projects per `org` step. Each archived one is one scheduled call. */
const PROJECT_PAGE = 256

/* A page size as a test lowered it, else `fallback`, and at least one. */
const pageSize = (page: number | undefined, fallback: number): number =>
  Math.max(1, Math.floor(page ?? fallback))

type OrgStep = {
  org_id: string
  phase: 'tasks' | 'projects'
  cursor?: string
  tasks: number
  projects: number
  page?: number
}

const startRef = makeFunctionReference<'mutation', { cursor?: string; page?: number }, null>(
  'internal/archivedReadsBackfill:start',
)
const orgRef = makeFunctionReference<'mutation', OrgStep, null>(
  'internal/archivedReadsBackfill:org',
)

/** Schedules the walk of each organization in one page from `cursor`
 * (absent to begin), then the next page. `page` lowers every page size in
 * tests. */
export const start = internalMutation({
  args: { cursor: v.optional(v.string()), page: v.optional(v.number()) },
  handler: async (ctx, { cursor, page }): Promise<null> => {
    const orgs = await ctx.db
      .query('organizations')
      .paginate({ cursor: cursor ?? null, numItems: pageSize(page, ORG_PAGE) })
    for (const org of orgs.page) {
      await ctx.scheduler.runAfter(0, orgRef, {
        org_id: org.id,
        phase: 'tasks',
        tasks: 0,
        projects: 0,
        page,
      })
    }
    if (!orgs.isDone) {
      await ctx.scheduler.runAfter(0, startRef, { cursor: orgs.continueCursor, page })
    }
    return null
  },
})

/** One page of an organization's archived tasks, or once those are done of
 * its projects, handed to scheduleArchivedReads, then the next page. `tasks`
 * and `projects` count what earlier steps handed over, for the final log. */
export const org = internalMutation({
  args: {
    org_id: v.string(),
    phase: v.union(v.literal('tasks'), v.literal('projects')),
    cursor: v.optional(v.string()),
    tasks: v.number(),
    projects: v.number(),
    page: v.optional(v.number()),
  },
  handler: async (ctx, a): Promise<null> => {
    let next: OrgStep
    if (a.phase === 'tasks') {
      const archived = await ctx.db
        .query('issues')
        .withIndex('by_org_archived', (q) => q.eq('org_id', a.org_id).gt('archived_at', undefined))
        .paginate({
          cursor: a.cursor ?? null,
          numItems: pageSize(a.page, TASK_PAGE),
          maximumBytesRead: TASK_PAGE_BYTES,
        })
      await scheduleArchivedReads(ctx, { issues: archived.page.map((task) => task.id) })
      const tasks = a.tasks + archived.page.length
      next = archived.isDone
        ? { ...a, phase: 'projects', cursor: undefined, tasks }
        : { ...a, cursor: archived.continueCursor, tasks }
    } else {
      const page = await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', a.org_id))
        .paginate({ cursor: a.cursor ?? null, numItems: pageSize(a.page, PROJECT_PAGE) })
      const archived = page.page.filter((p) => p.archived_at !== undefined).map((p) => p.id)
      await scheduleArchivedReads(ctx, { projects: archived })
      const projects = a.projects + archived.length
      if (page.isDone) {
        console.info('Archived reads backfill scheduled', {
          org_id: a.org_id,
          tasks: a.tasks,
          projects,
        })
        return null
      }
      next = { ...a, cursor: page.continueCursor, projects }
    }
    await ctx.scheduler.runAfter(0, orgRef, next)
    return null
  },
})

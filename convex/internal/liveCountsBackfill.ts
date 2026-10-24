/* One-time migration that counts every organization's active tasks and
 * live projects into its org_counters row (schema.ts `active_tasks`,
 * `live_projects`), the rows the app's windows read. The app sizes an
 * organization's first task and project windows by them
 * (lib/idWindows.ts startWindows). Until they are counted it sizes them by
 * the task and project numbers handed out, which count every task and
 * project ever created, as releases before did, so the workspace loads the
 * same before the backfill as it did before this release. Organizations
 * created since this release are counted from their start (model/orgs.ts
 * insertOrgRows).
 *
 * A count runs in steps, each its own transaction, in task and project
 * number order (index by_org_num). Each step reads the rows numbered past
 * where the one before stopped, every row of its last number included, so
 * the count reads each row once. The org_counters row keeps the
 * numbers counted through in `counted`, and a write in between moves the
 * counts only for a row at or below them (model/orgs.ts tallyRows), so the
 * count is exact however the rows change while it runs. The app ignores the
 * counts while `counted` is set.
 *
 * Read the dry run first. It writes nothing and reports, for every
 * organization, the counts it would write, and for one counted already
 * whether its counts match its rows. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/liveCountsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/liveCountsBackfill:run '{"dry_run": false}'
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). On the demo, whose stored key cannot run internal
 * functions, the private with-temp-deploy-key helper runs each command with a
 * short-lived key; `run`, an internal action, needs
 * deployment:functions:runInternalActions.
 *
 * A run counts the organizations not counted yet and leaves the others as
 * they are. `"recount": true` counts every organization again, for example
 * after a rollback to a release that did not keep the counts. A run that
 * wrote adds one platform_audit_log row (action 'live_counts_backfill',
 * actor 'system') with its totals. Running it again is safe. It writes no
 * activity, sends no task event and changes nothing a person sees, except
 * how many windows the app opens at its next load. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { countersRow, liveCountsOf } from '../model/orgs'

/** Rows of each table one step reads, and the most organizations a dry run
 * lists. 100 tasks of the largest stored descriptions read about 8 MiB,
 * inside Convex's 16 MiB. Tests lower them. */
export const COUNT_PAGE = { issues: 100, projects: 500, listed: 100 }

/** Where a count starts, below every task and project number. */
const START = Number.MIN_SAFE_INTEGER

type Table = 'issues' | 'projects'
const TABLES: readonly Table[] = ['issues', 'projects']
const KIND = { issues: 'tasks', projects: 'projects' } as const
const FIELD = { issues: 'active_tasks', projects: 'live_projects' } as const

/** One page of the organization's rows of `table` numbered past `after`:
 * how many the windows read, and the number counted through, or null when
 * no row is numbered past `after`. Every row with the page's last number
 * is in it, should two share one. */
async function countPage(
  ctx: QueryCtx,
  orgId: string,
  table: Table,
  after: number,
): Promise<{ rows: number; through: number } | null> {
  const past = (from: number) =>
    ctx.db.query(table).withIndex('by_org_num', (q) => q.eq('org_id', orgId).gt('num', from))
  const page: Doc<Table>[] = await past(after).take(COUNT_PAGE[table])
  const last = page.at(-1)?.num
  if (last === undefined) return null
  const tail =
    page.length < COUNT_PAGE[table]
      ? []
      : await ctx.db
          .query(table)
          .withIndex('by_org_num', (q) => q.eq('org_id', orgId).eq('num', last))
          .collect()
  const rows = [...page.filter((row) => row.num < last || tail.length === 0), ...tail]
  return {
    rows: rows.filter((row) => table === 'projects' || row.archived_at === undefined).length,
    through: last,
  }
}

/** The counts of one organization. */
type Counts = { active_tasks: number; live_projects: number }

/** One step of the organization's count, in its own transaction. It
 * starts the count, counts one page of each table not done, and ends the
 * count once no row is numbered past where it counted. Leaves an organization counted already
 * alone unless `recount`. Answers its counts once it is counted, else
 * null. */
export const step = internalMutation({
  args: { org_id: v.string(), recount: v.boolean() },
  handler: async (ctx, { org_id, recount }): Promise<Counts | null> => {
    let row = await countersRow(ctx, org_id)
    // an organization deleted meanwhile
    if (row === null) return { active_tasks: 0, live_projects: 0 }
    if (row.counted === undefined) {
      if (row.active_tasks !== undefined && row.live_projects !== undefined && !recount)
        return { active_tasks: row.active_tasks, live_projects: row.live_projects }
      await ctx.db.patch(row._id, {
        active_tasks: 0,
        live_projects: 0,
        counted: { tasks: START, projects: START },
      })
      row = (await ctx.db.get(row._id)) as Doc<'org_counters'>
    }
    const counted = { tasks: START, projects: START, ...row.counted }
    const counts = { active_tasks: row.active_tasks ?? 0, live_projects: row.live_projects ?? 0 }
    let done = true
    for (const table of TABLES) {
      const page = await countPage(ctx, org_id, table, counted[KIND[table]])
      if (page === null) continue
      done = false
      counted[KIND[table]] = page.through
      counts[FIELD[table]] += page.rows
    }
    await ctx.db.patch(row._id, { ...counts, counted: done ? undefined : counted })
    return done ? counts : null
  },
})

/** One organization as a dry run reports it, with the counts its rows
 * give and those it holds once counted. */
type OrgReport = Counts & { org_id: string; stored?: Counts }

/** A page of organizations with the counts they hold, null until counted. */
type OrgPage = {
  orgs: { org_id: string; stored: Counts | null }[]
  cursor: string
  done: boolean
}

/** One page of organizations, by id, with the counts they hold. */
export const orgPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<OrgPage> => {
    const page = await ctx.db.query('organizations').paginate({ cursor, numItems: 100 })
    const orgs: OrgPage['orgs'] = []
    for (const org of page.page) {
      const { active_tasks, live_projects } = liveCountsOf(await countersRow(ctx, org.id))
      const counted = active_tasks !== undefined && live_projects !== undefined
      orgs.push({ org_id: org.id, stored: counted ? { active_tasks, live_projects } : null })
    }
    return { orgs, cursor: page.continueCursor, done: page.isDone }
  },
})

/** Counts, without writing, one page of the organization's rows of `table`
 * numbered past `after` (countPage). */
export const check = internalQuery({
  args: {
    org_id: v.string(),
    table: v.union(v.literal('issues'), v.literal('projects')),
    after: v.number(),
  },
  handler: async (ctx, { org_id, table, after }) => await countPage(ctx, org_id, table, after),
})

/** Records a run that wrote, with its totals. */
export const audit = internalMutation({
  args: { counted: v.number(), active_tasks: v.number(), live_projects: v.number() },
  handler: async (ctx, totals) => {
    await ctx.db.insert('platform_audit_log', {
      ts: new Date().toISOString(),
      actor_email: 'system',
      action: 'live_counts_backfill',
      detail: totals,
    })
    return null
  },
})

const orgPageRef = makeFunctionReference<'query', { cursor: string | null }, OrgPage>(
  'internal/liveCountsBackfill:orgPage',
)
const checkRef = makeFunctionReference<
  'query',
  { org_id: string; table: Table; after: number },
  { rows: number; through: number } | null
>('internal/liveCountsBackfill:check')
const stepRef = makeFunctionReference<
  'mutation',
  { org_id: string; recount: boolean },
  Counts | null
>('internal/liveCountsBackfill:step')
const auditRef = makeFunctionReference<'mutation', Counts & { counted: number }, null>(
  'internal/liveCountsBackfill:audit',
)

/** Counts every organization not counted yet, or every one with
 * `recount`, and answers how many it counted and their totals. A dry run
 * writes nothing. It counts each organization's rows page by page,
 * answers the same totals for those it would count, lists up to
 * COUNT_PAGE.listed of them, and lists the organizations counted already
 * whose counts their rows do not give (`differ`, `differing` in all). A
 * run that wrote ends with its audit row. */
export const run = internalAction({
  args: { dry_run: v.boolean(), recount: v.optional(v.boolean()) },
  handler: async (ctx, { dry_run, recount = false }) => {
    const totals = { orgs: 0, counted: 0, active_tasks: 0, live_projects: 0 }
    const add = (counts: Counts) => {
      totals.counted++
      totals.active_tasks += counts.active_tasks
      totals.live_projects += counts.live_projects
    }
    const toCount: OrgReport[] = []
    const differ: OrgReport[] = []
    let differing = 0
    let cursor: string | null = null
    for (;;) {
      const page: OrgPage = await ctx.runQuery(orgPageRef, { cursor })
      for (const { org_id, stored } of page.orgs) {
        totals.orgs++
        const counts = stored === null || recount
        if (!dry_run) {
          if (!counts) continue
          let done: Counts | null = null
          while (done === null) done = await ctx.runMutation(stepRef, { org_id, recount })
          add(done)
          continue
        }
        const report: OrgReport = { org_id, active_tasks: 0, live_projects: 0 }
        for (const table of TABLES) {
          let after = START
          for (;;) {
            const got = await ctx.runQuery(checkRef, { org_id, table, after })
            if (got === null) break
            report[FIELD[table]] += got.rows
            after = got.through
          }
        }
        if (stored !== null) {
          report.stored = stored
          const same =
            stored.active_tasks === report.active_tasks &&
            stored.live_projects === report.live_projects
          if (!same && differing++ < COUNT_PAGE.listed) differ.push(report)
        }
        if (!counts) continue
        add(report)
        if (toCount.length < COUNT_PAGE.listed) toCount.push(report)
      }
      if (page.done) break
      cursor = page.cursor
    }
    if (!dry_run)
      await ctx.runMutation(auditRef, {
        counted: totals.counted,
        active_tasks: totals.active_tasks,
        live_projects: totals.live_projects,
      })
    return { dry_run, ...totals, differing, to_count: toCount, differ }
  },
})

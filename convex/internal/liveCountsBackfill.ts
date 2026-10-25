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
 * whether its counts match its rows. It lists an organization that writes
 * kept changing while it counted as unsettled, to check again with a later
 * dry run (dryCount). With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/liveCountsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/liveCountsBackfill:run '{"dry_run": false}'
 * A call stops after RUN.ms, well inside Convex's action time limit, and
 * then answers `done: false` with a `cursor`. Call it again with the same
 * arguments and `"cursor"` set to it until `done` is true. Each call reports
 * the organizations it went through.
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). On the demo, whose stored key cannot run internal
 * functions, the private with-temp-deploy-key helper runs each command with a
 * short-lived key; `run`, an internal action, needs
 * deployment:functions:runInternalActions.
 *
 * A run counts the organizations not counted yet and leaves the others as
 * they are. `"recount": true` counts every organization again, to mend
 * counts a dry run lists as differing from their rows. An organization
 * without an org_counters row has nothing to hold its counts: a run lists
 * it as skipped, and once its next create makes the row (model/orgs.ts
 * ensureCounters), a later run counts it. A call that wrote adds one
 * platform_audit_log row (action 'live_counts_backfill', actor 'system')
 * with its totals. Running it again is safe. It writes no
 * activity, sends no task event and changes nothing a person sees, except
 * how many windows the app opens at its next load. */
import { makeFunctionReference } from 'convex/server'
import { getDocumentSize, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { ActionCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { MIB } from '../lib/limits'
import { audit as writeAudit } from '../model/admin'
import { DOCUMENT_MAX_BYTES } from '../model/comments'
import { countersRow, liveCountsOf, numbersOf, type OrgCounters } from '../model/orgs'

/** Rows of each table one page reads, the bytes it reads before it ends
 * early, as Convex counts a document's size, and the most organizations a
 * dry run lists. A stored description can come close to Convex's document
 * size limit (internal/overCapRows.ts keeps those it finds), so a page reads
 * no more rows at a time than its unspent bytes could hold at that size
 * (countPage). While no two rows share a number, each table's page then
 * reads at most its bytes and two documents more, so a step's two pages
 * stay inside Convex's 16 MiB. Tests lower them. */
export const COUNT_PAGE = { issues: 100, projects: 100, bytes: 4 * MIB, listed: 100 }

/** Organizations one page of a run reads, and how long one call of run
 * goes on before it answers where to go on from. Tests lower them. */
export const RUN = { orgs: 100, ms: 5 * 60_000 }

/** Where a count starts, below every task and project number. */
const START = Number.MIN_SAFE_INTEGER

type Table = 'issues' | 'projects'
const TABLES: readonly Table[] = ['issues', 'projects']
const KIND = { issues: 'tasks', projects: 'projects' } as const
const FIELD = { issues: 'active_tasks', projects: 'live_projects' } as const

/** One page of the organization's rows of `table` numbered past `after`:
 * how many the windows read, and the number counted through, or null when
 * no row is numbered past `after`. The page reads in parts, each no larger
 * than its unspent bytes could hold at Convex's document size limit, and
 * ends at COUNT_PAGE rows or bytes. Every row with a part's last number is
 * in it, should two share one. */
async function countPage(
  ctx: QueryCtx,
  orgId: string,
  table: Table,
  after: number,
): Promise<{ rows: number; through: number } | null> {
  let through = after
  let read = 0
  let bytes = 0
  let rows = 0
  for (;;) {
    const fits = Math.max(1, Math.floor((COUNT_PAGE.bytes - bytes) / DOCUMENT_MAX_BYTES))
    const want = Math.min(COUNT_PAGE[table] - read, fits)
    const from = through
    const part: Doc<Table>[] = await ctx.db
      .query(table)
      .withIndex('by_org_num', (q) => q.eq('org_id', orgId).gt('num', from))
      .take(want)
    const last = part.at(-1)?.num
    if (last === undefined) break
    const tail =
      part.length < want
        ? []
        : await ctx.db
            .query(table)
            .withIndex('by_org_num', (q) => q.eq('org_id', orgId).eq('num', last))
            .collect()
    for (const row of [...part, ...tail]) bytes += getDocumentSize(row)
    const counted = [...part.filter((row) => row.num < last || tail.length === 0), ...tail]
    read += counted.length
    rows += counted.filter((row) => table === 'projects' || row.archived_at === undefined).length
    through = last
    if (part.length < want || read >= COUNT_PAGE[table] || bytes >= COUNT_PAGE.bytes) break
  }
  return through === after ? null : { rows, through }
}

/** The counts of one organization. */
type Counts = { active_tasks: number; live_projects: number }

/** One step of the organization's count, in its own transaction. It
 * starts the count, counts one page of each table not done, and ends the
 * count once no row is numbered past where it counted. Leaves an organization counted already
 * alone unless `recount`. Answers its counts once it is counted, null
 * while it counts, and 'skipped' without an org_counters row, such as for an
 * organization deleted meanwhile. */
export const step = internalMutation({
  args: { org_id: v.string(), recount: v.boolean() },
  handler: async (ctx, { org_id, recount }): Promise<Counts | 'skipped' | null> => {
    let row = await countersRow(ctx, org_id)
    if (row === null) return 'skipped'
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

/** What an organization holds: whether it has an org_counters row, its
 * counts, null until counted, and the numbers handed out, which every
 * create moves. */
type OrgState = { org_id: string; has_row: boolean; stored: Counts | null; numbers: OrgCounters }

/** The organization's state (OrgState). */
async function stateOf(ctx: QueryCtx, orgId: string): Promise<OrgState> {
  const row = await countersRow(ctx, orgId)
  const { active_tasks, live_projects } = liveCountsOf(row)
  const counted = active_tasks !== undefined && live_projects !== undefined
  return {
    org_id: orgId,
    has_row: row !== null,
    stored: counted ? { active_tasks, live_projects } : null,
    numbers: numbersOf(row),
  }
}

/** A page of organizations with their states. */
type OrgPage = { orgs: OrgState[]; cursor: string; done: boolean }

/** One page of organizations, by id, with their states. */
export const orgPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<OrgPage> => {
    const page = await ctx.db.query('organizations').paginate({ cursor, numItems: RUN.orgs })
    const orgs: OrgState[] = []
    for (const org of page.page) orgs.push(await stateOf(ctx, org.id))
    return { orgs, cursor: page.continueCursor, done: page.isDone }
  },
})

/** One organization's state, as a dry run reads it after a count. */
export const state = internalQuery({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<OrgState> => await stateOf(ctx, org_id),
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
    await writeAudit(ctx, { actor_email: 'system', action: 'live_counts_backfill', detail: totals })
    return null
  },
})

const orgPageRef = makeFunctionReference<'query', { cursor: string | null }, OrgPage>(
  'internal/liveCountsBackfill:orgPage',
)
const stateRef = makeFunctionReference<'query', { org_id: string }, OrgState>(
  'internal/liveCountsBackfill:state',
)
const checkRef = makeFunctionReference<
  'query',
  { org_id: string; table: Table; after: number },
  { rows: number; through: number } | null
>('internal/liveCountsBackfill:check')
const stepRef = makeFunctionReference<
  'mutation',
  { org_id: string; recount: boolean },
  Counts | 'skipped' | null
>('internal/liveCountsBackfill:step')
const auditRef = makeFunctionReference<'mutation', Counts & { counted: number }, null>(
  'internal/liveCountsBackfill:audit',
)

/** How many times a dry run counts an organization whose state a write
 * moves while it counts. */
const DRY_TRIES = 3

/** Counts the organization's rows without writing, page by page in queries
 * of their own, then reads its state again. Writes can land between those
 * queries, so the counts match a state only when it held still across the
 * count; it counts again while the state moved, at most DRY_TRIES times.
 * Answers the counts, the state read after them and whether it held still
 * (`settled`). A write undone within one count, such as an archive and its
 * restore, leaves the state as it was and can still show as a difference,
 * which a later dry run no longer shows. */
export async function dryCount(
  ctx: Pick<ActionCtx, 'runQuery'>,
  before: OrgState,
): Promise<{ counts: Counts; state: OrgState; settled: boolean }> {
  let state = before
  for (let tries = 1; ; tries++) {
    const counts = { active_tasks: 0, live_projects: 0 }
    for (const table of TABLES) {
      let after = START
      for (;;) {
        const got = await ctx.runQuery(checkRef, { org_id: state.org_id, table, after })
        if (got === null) break
        counts[FIELD[table]] += got.rows
        after = got.through
      }
    }
    const now = await ctx.runQuery(stateRef, { org_id: state.org_id })
    // stateOf builds both, so their keys come in the same order
    const settled = JSON.stringify(now) === JSON.stringify(state)
    if (settled || tries === DRY_TRIES) return { counts, state: now, settled }
    state = now
  }
}

/** Counts every organization not counted yet, or every one with
 * `recount`, from `cursor` on, and answers how many it counted and their
 * totals. Past RUN.ms it stops after a page of organizations and answers
 * the `cursor` to go on from, else `done`. A dry run writes nothing. It
 * counts each organization's rows (dryCount), answers
 * the same totals for those it would count, lists up to COUNT_PAGE.listed
 * of them, and lists the organizations counted already whose counts their
 * rows do not give (`differ`, `differing` in all). An organization that
 * writes kept changing through every count is listed in `unsettled_orgs`
 * (`unsettled` in all) instead, for a later dry run. Both list the
 * organizations without an org_counters row, which a run cannot count, in
 * `skipped_orgs` (`skipped` in all). A call that wrote ends with its audit
 * row. */
export const run = internalAction({
  args: { dry_run: v.boolean(), recount: v.optional(v.boolean()), cursor: v.optional(v.string()) },
  handler: async (ctx, { dry_run, recount = false, cursor: from }) => {
    const until = Date.now() + RUN.ms
    const totals = { orgs: 0, counted: 0, active_tasks: 0, live_projects: 0 }
    const add = (counts: Counts) => {
      totals.counted++
      totals.active_tasks += counts.active_tasks
      totals.live_projects += counts.live_projects
    }
    const toCount: OrgReport[] = []
    const differ: OrgReport[] = []
    const unsettledOrgs: string[] = []
    const skippedOrgs: string[] = []
    let differing = 0
    let unsettled = 0
    let skipped = 0
    const skip = (orgId: string) => {
      if (skipped++ < COUNT_PAGE.listed) skippedOrgs.push(orgId)
    }
    let cursor: string | null = from ?? null
    let done = false
    for (;;) {
      const page: OrgPage = await ctx.runQuery(orgPageRef, { cursor })
      for (const org of page.orgs) {
        const { org_id } = org
        totals.orgs++
        if (!org.has_row) {
          skip(org_id)
          continue
        }
        const due = org.stored === null || recount
        if (!dry_run) {
          if (!due) continue
          let got: Counts | 'skipped' | null = null
          while (got === null) got = await ctx.runMutation(stepRef, { org_id, recount })
          if (got === 'skipped') skip(org_id)
          else add(got)
          continue
        }
        const { counts, state, settled } = await dryCount(ctx, org)
        const report: OrgReport = { org_id, ...counts }
        if (!settled) {
          if (unsettled++ < COUNT_PAGE.listed) unsettledOrgs.push(org_id)
        } else if (state.stored !== null) {
          report.stored = state.stored
          const same =
            state.stored.active_tasks === counts.active_tasks &&
            state.stored.live_projects === counts.live_projects
          if (!same && differing++ < COUNT_PAGE.listed) differ.push(report)
        }
        if (!due) continue
        add(report)
        if (toCount.length < COUNT_PAGE.listed) toCount.push(report)
      }
      done = page.done
      cursor = page.cursor
      if (done || Date.now() >= until) break
    }
    if (!dry_run)
      await ctx.runMutation(auditRef, {
        counted: totals.counted,
        active_tasks: totals.active_tasks,
        live_projects: totals.live_projects,
      })
    return {
      dry_run,
      ...totals,
      differing,
      to_count: toCount,
      differ,
      unsettled,
      unsettled_orgs: unsettledOrgs,
      skipped,
      skipped_orgs: skippedOrgs,
      done,
      cursor: done ? null : cursor,
    }
  },
})

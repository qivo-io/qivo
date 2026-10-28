/* One-time migration: give every task and project id held before used_ids
 * existed its used_ids row (schema.ts used_ids), so that no new task or
 * project takes the id (lib/db.ts insertUnique). Tasks and projects created
 * since get their rows when they are inserted, and a restore from Deleted
 * items writes the row of one stored before (lib/db.ts insertUsed). A row
 * names the organization that holds the id, so a run also writes the row of
 * a task or project that an earlier release created, after a rollback, with
 * an id another organization had used.
 *
 * It reads six sources: the live tasks and projects (`issues`,
 * `projects`), their Deleted items copies (`stored_issues`,
 * `stored_projects`, deleted_rows), each stored task's light row
 * (`deleted_tasks`) and the projects each project item names
 * (`project_items`, deleted_items). The last two can name an id after its
 * stored copy is gone. A split of a task item that stopped partway can
 * leave a subtask's deleted_tasks row, with some of its other stored rows,
 * once its stored copy is gone, as can a purge that a release before this
 * one left partway; this release's purge deletes the deleted_tasks row
 * before the copy. A project item names its projects until its purge ends,
 * after their stored copies. A stored task is in two sources and a stored
 * project in up to two, so a dry run can count one id in each. An id freed
 * before this release is in none of them, so it is unknown and stays free
 * for a new task or project, as does an id an earlier release created and
 * freed during a rollback. A source row whose organization is gone is left
 * alone and counted in `orphans`; only an organization's teardown leaves
 * one, and it ends by deleting that organization's used_ids rows
 * (model/usedIds.ts).
 *
 * Check a deployment before changing it. `remaining` is a query, so it
 * cannot write, and a key that may only run internal queries can run it. It
 * counts the ids on one page of a source that have no row. Start with
 * `{"source": "issues"}`, pass the returned `cursor` back until `done` is
 * true, then do the same for `"projects"`, `"stored_issues"`,
 * `"stored_projects"`, `"deleted_tasks"` and `"project_items"`. If every
 * page reports zero `rows`, the deployment has nothing to record. With the
 * private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/usedIdsBackfill:remaining '{"source": "issues"}'
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). Read the dry run, which writes nothing, then record
 * the ids and check again:
 *   "$H" staging npx convex run internal/usedIdsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/usedIdsBackfill:run '{"dry_run": false}'
 * A call stops between two steps once RUN.ms has passed, well inside
 * Convex's action time limit, and then answers `done: false` with a
 * `source` and a `cursor`. Call it again with the same arguments and both
 * of those, unchanged, until `done` is true. The cursor is null where a
 * source starts, and a cursor without its source is refused. A run reads
 * each page in a query and writes the missing rows in small batches, each
 * checking its ids again. A page or batch that fails ends the call with
 * `error`, after the audit row of what committed, and the `source` and
 * `cursor` of the page to read again.
 *
 * On the demo, whose stored key cannot run internal functions, the private
 * with-temp-deploy-key helper runs each command with a short-lived key:
 * `remaining` needs deployment:functions:runInternalQueries and `run`, an
 * internal action, deployment:functions:runInternalActions.
 *
 * A call that is not a dry run adds one platform_audit_log row (action
 * 'used_ids_backfill', actor 'system') with its counts and where to go on
 * from. The results hold counts only. Running it again is safe, and a clean
 * deployment reports zeros. It writes no activity, sends no task event and
 * changes nothing a person sees, except that an id it records stays taken
 * once its task or project is deleted for good, as the ids of those created
 * since this release do. A Northstar wipe between a page and its batch can
 * leave the row of a task the wipe let go, which the next seed's check
 * steps refuse before it writes anything; running reset again lets it go.
 *
 * Earlier releases guarded each table keyed by a task id against a new task
 * that takes a freed id. Once a dry run on every deployment reports zero in
 * every source, and no such table holds a row whose task is gone (for
 * descriptions, internal/descriptionsBackfill reports no orphans), these
 * guards only cover ids nothing can take any more, and a later change may
 * remove them: putDescription resetting the organization of a row it finds
 * (model/descriptions.ts); the live-task and organization checks of
 * dropDescriptions, holdsDescription and clearDescriptions (ownDescription)
 * and idTaken before purgeHistory (model/deletedItems.ts); the bound of
 * purgeHistory to rows written up to the deletion in moveDrain; the live
 * and Deleted items reads before the parent check in createIssueCore
 * (model/issues.ts); and the live and Deleted items checks of tasks and
 * projects in internal/marketingDemo.ts assertReserved. insertUnique still
 * checks deleted_rows for the other tables Deleted items stores. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId, keepUsedId, usedIdRow } from '../lib/db'
import { type UsedIdTable, vUsedIdTable } from '../lib/enums'
import { badRequest } from '../lib/functions'
import { MIB } from '../lib/limits'
import { audit as writeAudit } from '../model/admin'

/** Rows of each source one page reads, the bytes it may read, and the ids
 * one batch of the run writes. A page reads one index range for each id it
 * finds and one for each organization, so up to 1,000 for 500 rows. A
 * project item names up to LIMITS.projectDeleteSubProjects.max + 1
 * projects, so a page of 10 finds up to 2,010 ids. A stored copy can come
 * close to Convex's document size limit, which the bytes bound. A batch
 * reads two ranges for each id and writes one small row. Tests lower them. */
export const BACKFILL_PAGE = {
  rows: {
    issues: 500,
    projects: 500,
    stored_issues: 200,
    stored_projects: 200,
    deleted_tasks: 500,
    project_items: 10,
  },
  bytes: 4 * MIB,
  batch: 200,
}

/** How long one call of run goes on before it answers where to go on from.
 * Tests lower it. */
export const RUN = { ms: 5 * 60_000 }

const SOURCES = [
  'issues',
  'projects',
  'stored_issues',
  'stored_projects',
  'deleted_tasks',
  'project_items',
] as const
type Source = (typeof SOURCES)[number]
const vSource = v.union(...SOURCES.map((source) => v.literal(source)))

/** One id a task or project holds, with the organization that holds it. */
type Use = { table: UsedIdTable; row_id: string; org_id: string }
const vUse = v.object({ table: vUsedIdTable, row_id: v.string(), org_id: v.string() })

/** The ids on one page of `source` from `cursor`, and where the next page
 * starts. Each source reads in an order the backfill does not change, so
 * the cursor stays valid. */
async function usesOf(
  ctx: QueryCtx,
  source: Source,
  cursor: string | null,
): Promise<{ uses: Use[]; cursor: string; done: boolean }> {
  const opts = {
    cursor,
    numItems: BACKFILL_PAGE.rows[source],
    maximumBytesRead: BACKFILL_PAGE.bytes,
  }
  if (source === 'issues' || source === 'projects') {
    const page = await ctx.db.query(source).paginate(opts)
    const uses = page.page.map((row) => ({ table: source, row_id: row.id, org_id: row.org_id }))
    return { uses, cursor: page.continueCursor, done: page.isDone }
  }
  if (source === 'stored_issues' || source === 'stored_projects') {
    const table: UsedIdTable = source === 'stored_issues' ? 'issues' : 'projects'
    const page = await ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) => q.eq('table', table))
      .paginate(opts)
    const uses = page.page.flatMap(({ row_id, org_id }) =>
      row_id === undefined ? [] : [{ table, row_id, org_id }],
    )
    return { uses, cursor: page.continueCursor, done: page.isDone }
  }
  if (source === 'deleted_tasks') {
    const page = await ctx.db.query('deleted_tasks').paginate(opts)
    const uses = page.page.map((row) => ({
      table: 'issues' as const,
      row_id: row.task_id,
      org_id: row.org_id,
    }))
    return { uses, cursor: page.continueCursor, done: page.isDone }
  }
  const page = await ctx.db.query('deleted_items').paginate(opts)
  const uses = page.page.flatMap((item) =>
    item.kind === 'project'
      ? item.projects.map((p) => ({
          table: 'projects' as const,
          row_id: p.id,
          org_id: item.org_id,
        }))
      : [],
  )
  return { uses, cursor: page.continueCursor, done: page.isDone }
}

/** Whether organization `orgId` exists, read once per `known`. */
function orgExists(
  ctx: QueryCtx,
  orgId: string,
  known: Map<string, Promise<boolean>>,
): Promise<boolean> {
  let exists = known.get(orgId)
  if (exists === undefined) {
    exists = byId(ctx, 'organizations', orgId).then((org) => org !== null)
    known.set(orgId, exists)
  }
  return exists
}

/** What one page found: the ids without the used_ids row of their
 * organization, how many it left because their organization is gone, and
 * where the next page starts. */
type PageResult = { missing: Use[]; orphans: number; cursor: string; done: boolean }

/* One page of `source` from `cursor`, read without writing. The check and
 * the run share it, so both find the same ids. */
async function walk(ctx: QueryCtx, source: Source, cursor: string | null): Promise<PageResult> {
  const page = await usesOf(ctx, source, cursor)
  const orgs = new Map<string, Promise<boolean>>()
  const missing: Use[] = []
  let orphans = 0
  for (const use of page.uses) {
    if ((await usedIdRow(ctx, use.table, use.row_id, use.org_id)) !== null) continue
    if (await orgExists(ctx, use.org_id, orgs)) missing.push(use)
    else orphans++
  }
  return { missing, orphans, cursor: page.cursor, done: page.done }
}

/** One page of `source` and the ids on it without their row (walk). */
export const scan = internalQuery({
  args: { source: vSource, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { source, cursor }): Promise<PageResult> => await walk(ctx, source, cursor),
})

/** Writes the used_ids row of each of `uses` that its organization does
 * not hold yet (lib/db.ts keepUsedId), and answers how many it wrote and
 * how many it left because their organization is gone by now. */
export const fix = internalMutation({
  args: { uses: v.array(vUse) },
  handler: async (ctx, { uses }): Promise<{ written: number; orphans: number }> => {
    const orgs = new Map<string, Promise<boolean>>()
    let written = 0
    let orphans = 0
    for (const use of uses) {
      if (!(await orgExists(ctx, use.org_id, orgs))) orphans++
      else if (await keepUsedId(ctx.db, use.table, use.row_id, use.org_id)) written++
    }
    return { written, orphans }
  },
})

/** Counts, without writing, the ids on one page of `source` that have no
 * row. Leave out `cursor`, or pass null, for the first page, then call
 * again with the returned `cursor` until `done`. */
export const remaining = internalQuery({
  args: { source: vSource, cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { source, cursor }) => {
    const { missing, ...rest } = await walk(ctx, source, cursor ?? null)
    return { rows: missing.length, ...rest }
  },
})

/** The counts a run adds up, per source, and where it goes on from. */
const vRecord = v.object({
  issues: v.number(),
  projects: v.number(),
  stored_issues: v.number(),
  stored_projects: v.number(),
  deleted_tasks: v.number(),
  project_items: v.number(),
  orphans: v.number(),
  done: v.boolean(),
  source: v.union(vSource, v.null()),
  cursor: v.union(v.string(), v.null()),
})
type Counts = Record<Source, number> & { orphans: number }

/** Records a call that was not a dry run, with its counts and where to go
 * on from. */
export const audit = internalMutation({
  args: vRecord,
  handler: async (ctx, record) => {
    await writeAudit(ctx, { actor_email: 'system', action: 'used_ids_backfill', detail: record })
    return null
  },
})

const scanRef = makeFunctionReference<
  'query',
  { source: Source; cursor: string | null },
  PageResult
>('internal/usedIdsBackfill:scan')
const fixRef = makeFunctionReference<
  'mutation',
  { uses: Use[] },
  { written: number; orphans: number }
>('internal/usedIdsBackfill:fix')
const auditRef = makeFunctionReference<
  'mutation',
  Counts & { done: boolean; source: Source | null; cursor: string | null },
  null
>('internal/usedIdsBackfill:audit')

/** Walks the pages of every source from `source` and `cursor` on, or from
 * the start, and reports per source how many ids it gave their row, or
 * would give one, and how many it left without an organization. Between
 * any two steps past RUN.ms, once it has written a batch or read a page
 * with nothing to write, it answers the `source` and `cursor` to go on
 * from, else `done`. A page or batch that fails ends the call with `error`
 * and the page to read again. A call that is not a dry run ends with its
 * audit row of what committed. */
export const run = internalAction({
  args: {
    dry_run: v.boolean(),
    source: v.optional(v.union(vSource, v.null())),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { dry_run, source, cursor: at }) => {
    const from = source ?? undefined
    if (from === undefined && at !== undefined && at !== null)
      throw badRequest('a cursor goes back with the source it was answered with')
    const until = Date.now() + RUN.ms
    const counts: Counts = {
      issues: 0,
      projects: 0,
      stored_issues: 0,
      stored_projects: 0,
      deleted_tasks: 0,
      project_items: 0,
      orphans: 0,
    }
    let next: { source: Source; cursor: string | null } | null = null
    let error: string | null = null
    // Every call gets through one batch, or one page with nothing to write,
    // before it may stop, so each call moves the walk on.
    let progressed = false
    const late = () => progressed && Date.now() >= until
    walking: for (const source of SOURCES.slice(from === undefined ? 0 : SOURCES.indexOf(from))) {
      let cursor: string | null = source === from ? (at ?? null) : null
      for (;;) {
        if (late()) {
          next = { source, cursor }
          break walking
        }
        try {
          const page: PageResult = await ctx.runQuery(scanRef, { source, cursor })
          if (dry_run) counts[source] += page.missing.length
          for (let i = 0; !dry_run && i < page.missing.length; i += BACKFILL_PAGE.batch) {
            if (late()) {
              next = { source, cursor }
              break walking
            }
            const uses = page.missing.slice(i, i + BACKFILL_PAGE.batch)
            const fixed = await ctx.runMutation(fixRef, { uses })
            counts[source] += fixed.written
            counts.orphans += fixed.orphans
            progressed = true
          }
          // counted once the page is through, as a stop before that reads
          // the page again
          counts.orphans += page.orphans
          progressed = true
          if (page.done) break
          cursor = page.cursor
        } catch (failure) {
          // what committed stays; the page is read again from its start
          error = failure instanceof Error ? failure.message : String(failure)
          next = { source, cursor }
          break walking
        }
      }
    }
    const where = {
      done: next === null,
      source: next?.source ?? null,
      cursor: next?.cursor ?? null,
    }
    if (!dry_run) await ctx.runMutation(auditRef, { ...counts, ...where })
    return { dry_run, ...counts, ...where, ...(error === null ? {} : { error }) }
  },
})

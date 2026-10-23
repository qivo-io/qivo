/* One-time migration: give every team membership and team share stored
 * before they had one an `org_id`, and every subtask stored before it had
 * one a `parent_key` (schema.ts), so the app's workspace parts read them in
 * one range: a people window its people's memberships, a person in many
 * teams their organization's shares, and a task window its tasks' active
 * subtasks (lib/workspaceParts.ts, lib/access.ts projectLevelsOf). A row
 * whose value differs from what it should be gets the right one, so a run
 * also repairs those.
 *
 * Until it runs, the readers find the rows without the field in one more
 * range and read as before for them: person by person, team by team, task
 * by task. So the app shows the same either way, only slower. New rows get
 * the fields when they are written, and a restore from Deleted items writes
 * them too, so the stored copies in deleted_rows need none.
 *
 * A membership takes its person's organization, else its team's; a share
 * its project's, else its team's; a subtask its parent's window key, from
 * the parent's stored copy while a restore has not written it back yet, ''
 * when the parent is gone, and a top-level task none. A row this cannot
 * place counts as an orphan and is left as it is: a membership or share
 * whose person or project and team are all gone, which grants nothing, and
 * a subtask whose parent has no window key yet. Run
 * internal/windowKeysBackfill to zero first, then this.
 *
 * Check a deployment before changing it. `remaining` is a query, so it
 * cannot write, and a key that may only run internal queries can run it. It
 * counts the rows of one page of a table that still need a write (`rows`)
 * and that it cannot place (`orphans`). Start with
 * `{"table": "team_members"}`, pass the returned `cursor` back until `done`
 * is true, then do the same for `"project_team_access"` and `"issues"`. A
 * page whose rows read too much counts nothing and answers `fewer`; ask
 * again with the same `cursor` and with `"rows"` set to it. If every page
 * reports zero of both, the deployment has nothing left, and the readers'
 * fallbacks never run there. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/rangeKeysBackfill:remaining '{"table": "team_members"}'
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). Read the dry run, which writes nothing, then write
 * the fields and check again. A run walks pages for about a minute and
 * answers `next`, which also holds the rows of a page that asked for
 * fewer. While it is not null, run again with it as `from`, for example
 * '{"dry_run": false, "from": {"table": "issues", "cursor": "..."}}':
 *   "$H" staging npx convex run internal/rangeKeysBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/rangeKeysBackfill:run '{"dry_run": false}'
 *
 * On the demo, whose stored key cannot run internal functions, the private
 * with-temp-deploy-key helper runs each command with a short-lived key:
 * `remaining` needs deployment:functions:runInternalQueries and `run`, an
 * internal action, deployment:functions:runInternalActions.
 *
 * A run that writes adds one platform_audit_log row (action
 * 'range_keys_backfill', actor 'system') with its counts. The results hold
 * counts only. Running it again is safe, and a clean deployment reports
 * zeros. It writes no activity, sends no task event and changes nothing a
 * person sees. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId, parentKeyOf } from '../lib/db'

/** Rows per page of each table, for the check and for each step of the
 * run, the bytes the page itself may read, the bytes the page and its rows'
 * reads may reach before it asks for fewer rows, and how long one run walks
 * pages. A membership or share reads its person or project and its team by
 * id, two ranges, and writes at most one patch. A subtask reads its
 * parent's body, and its stored copy while the parent is in Deleted items,
 * up to about 64 KB each today but up to 1 MiB for one stored before the
 * description cap, so `reads` stops a page with large parents short of
 * Convex's 16 MiB. Tests lower them. */
export const BACKFILL_PAGE = {
  rows: { team_members: 500, project_team_access: 500, issues: 50 },
  bytes: 4 * 1024 * 1024,
  reads: 8 * 1024 * 1024,
  runMs: 60_000,
}

const vTable = v.union(
  v.literal('team_members'),
  v.literal('project_team_access'),
  v.literal('issues'),
)
type KeyedTable = 'team_members' | 'project_team_access' | 'issues'
const TABLES: readonly KeyedTable[] = ['team_members', 'project_team_access', 'issues']

/** What one page found, and where the next one starts. A page whose reads
 * passed BACKFILL_PAGE.reads counts and writes nothing and answers `fewer`,
 * the rows to ask for again from the same `cursor`, which it answers. */
type PageResult = {
  rows: number
  orphans: number
  cursor: string | null
  done: boolean
  fewer?: number
}

const pageRef = makeFunctionReference<
  'mutation',
  { table: KeyedTable; dry_run: boolean; cursor: string | null; rows?: number },
  PageResult
>('internal/rangeKeysBackfill:page')

type Counts = Record<KeyedTable, { rows: number; orphans: number }>

const auditRef = makeFunctionReference<'mutation', { counts: Counts }, null>(
  'internal/rangeKeysBackfill:audit',
)

/* What a row's field should hold, `place`, none for a top-level task, and
 * whether the row cannot be placed (an orphan). An orphaned membership or
 * share is left as it is. A subtask under a parent without a key holds
 * none, so readers ask for it as before, until the parent gets a key. A
 * subtask whose parent is in Deleted items, as a project restore writes a
 * task before its parent, holds the key its parent comes back with, as
 * model/deletedItems.ts restoredParentKey gives it. */
type Want = { place: string | undefined; orphan: boolean }

/* The organization of the profile, project or team with these ids, read
 * once per page. */
function orgOf(ctx: QueryCtx) {
  const known = new Map<string, Promise<string | undefined>>()
  return (table: 'profiles' | 'projects' | 'teams', id: string) => {
    const key = `${table}:${id}`
    let org = known.get(key)
    if (org === undefined) {
      org = byId(ctx, table, id).then((row) => row?.org_id)
      known.set(key, org)
    }
    return org
  }
}

/* The parent_key of a task under the task with id `parentId`: from the
 * task while it is in issues, else from its stored copy in Deleted items,
 * and '' when it is in neither. */
async function storedParentKey(ctx: QueryCtx, parentId: string): Promise<string | undefined> {
  const live = await byId(ctx, 'issues', parentId)
  if (live !== null) return parentKeyOf(live)
  const stored = await ctx.db
    .query('deleted_rows')
    .withIndex('by_row', (q) => q.eq('table', 'issues').eq('row_id', parentId))
    .first()
  return stored?.row.table === 'issues' ? stored.row.doc.window_key : ''
}

/* One page of `table` from `cursor`, of `rows` rows: how many need a write
 * and how many cannot be placed, and, unless `write` is null, writes them.
 * The check and the run share it, so both find the same rows. The page is
 * read in creation order, which the fields do not change, so the cursor
 * stays valid. It finds what every row should hold before it writes, so a
 * page that stops at BACKFILL_PAGE.reads writes nothing. */
async function walk(
  ctx: QueryCtx,
  table: KeyedTable,
  cursor: string | null,
  rows: number,
  write: MutationCtx | null,
): Promise<PageResult> {
  const page = await ctx.db.query(table).paginate({
    cursor,
    numItems: rows,
    maximumBytesRead: BACKFILL_PAGE.bytes,
  })
  const org = orgOf(ctx)
  const parents = new Map<string, Promise<string | undefined>>()
  const parentKey = (id: string) => {
    let key = parents.get(id)
    if (key === undefined) {
      key = storedParentKey(ctx, id)
      parents.set(id, key)
    }
    return key
  }
  /* what `row` should hold */
  const wantOf = async (row: Doc<KeyedTable>): Promise<Want> => {
    if (!('team_id' in row)) {
      if (row.parent_id === undefined) return { place: undefined, orphan: false }
      const place = await parentKey(row.parent_id)
      return { place, orphan: place === undefined }
    }
    const first =
      'profile_id' in row
        ? await org('profiles', row.profile_id)
        : await org('projects', row.project_id)
    const place = first ?? (await org('teams', row.team_id))
    return { place, orphan: place === undefined }
  }
  const wants: Want[] = []
  for (const row of page.page) {
    // every row reads at most two documents, so one more stays inside 16 MiB
    const read = await ctx.meta.getTransactionMetrics()
    if (wants.length > 0 && read.bytesRead.used > BACKFILL_PAGE.reads)
      return { rows: 0, orphans: 0, cursor, done: false, fewer: wants.length }
    wants.push(await wantOf(row))
  }
  let changed = 0
  let orphans = 0
  for (const [i, row] of page.page.entries()) {
    const want = wants[i]
    if (want.orphan) orphans++
    if ('team_id' in row) {
      if (want.orphan || row.org_id === want.place) continue
      changed++
      if (write !== null) await write.db.patch(row._id, { org_id: want.place })
    } else {
      if (row.parent_key === want.place) continue
      changed++
      if (write !== null) await write.db.patch(row._id, { parent_key: want.place })
    }
  }
  return { rows: changed, orphans, cursor: page.continueCursor, done: page.isDone }
}

/* The rows of a page of `table`: `rows` when given, at least one and at
 * most BACKFILL_PAGE.rows. */
const pageRows = (table: KeyedTable, rows: number | undefined) =>
  Math.max(1, Math.min(Math.floor(rows ?? Infinity), BACKFILL_PAGE.rows[table]))

/** One page in its own transaction: writes the fields, or only counts the
 * rows that need them with `dry_run`. */
export const page = internalMutation({
  args: {
    table: vTable,
    dry_run: v.boolean(),
    cursor: v.union(v.string(), v.null()),
    rows: v.optional(v.number()),
  },
  handler: async (ctx, { table, dry_run, cursor, rows }): Promise<PageResult> =>
    await walk(ctx, table, cursor, pageRows(table, rows), dry_run ? null : ctx),
})

/** Counts, without writing, the rows of one page of `table` that need a
 * write and those it cannot place. Leave out `cursor`, or pass null, for
 * the first page, then call again with the returned `cursor` until `done`.
 * An answer with `fewer` counted nothing: call again with the same
 * `cursor` and `rows` set to it. */
export const remaining = internalQuery({
  args: {
    table: vTable,
    cursor: v.optional(v.union(v.string(), v.null())),
    rows: v.optional(v.number()),
  },
  handler: async (ctx, { table, cursor, rows }): Promise<PageResult> =>
    await walk(ctx, table, cursor ?? null, pageRows(table, rows), null),
})

const vCount = v.object({ rows: v.number(), orphans: v.number() })

/** Records a run that wrote, with its counts. */
export const audit = internalMutation({
  args: {
    counts: v.object({
      team_members: vCount,
      project_team_access: vCount,
      issues: vCount,
    }),
  },
  handler: async (ctx, { counts }) => {
    await ctx.db.insert('platform_audit_log', {
      ts: new Date().toISOString(),
      actor_email: 'system',
      action: 'range_keys_backfill',
      detail: counts,
    })
    return null
  },
})

const vFrom = v.object({
  table: vTable,
  cursor: v.union(v.string(), v.null()),
  rows: v.optional(v.number()),
})

/** Where a run goes on: a table, the cursor of its next page and, after a
 * page that asked for fewer rows, how many. */
type From = { table: KeyedTable; cursor: string | null; rows?: number }

/** Walks the pages of the three tables from `from`, the first page of the
 * first table when left out, until BACKFILL_PAGE.runMs has passed, and reports
 * how many rows it wrote, or would write, and how many it could not place.
 * `next` says where to go on: pass it back as `from` until it is null. One
 * action walking every page of a large deployment passes the time Convex
 * gives an action. A run that writes ends with its audit row. */
export const run = internalAction({
  args: { dry_run: v.boolean(), from: v.optional(vFrom) },
  handler: async (
    ctx,
    { dry_run, from },
  ): Promise<{ dry_run: boolean; next: From | null } & Counts> => {
    const counts: Counts = {
      team_members: { rows: 0, orphans: 0 },
      project_team_access: { rows: 0, orphans: 0 },
      issues: { rows: 0, orphans: 0 },
    }
    const started = Date.now()
    let next: From | null = from ?? { table: TABLES[0], cursor: null }
    // at least one page a run, so every run moves on
    while (next !== null) {
      const { table, cursor, rows }: From = next
      const result: PageResult = await ctx.runMutation(pageRef, { table, dry_run, cursor, rows })
      counts[table].rows += result.rows
      counts[table].orphans += result.orphans
      const after: KeyedTable | undefined = TABLES[TABLES.indexOf(table) + 1]
      next =
        result.fewer !== undefined
          ? { table, cursor, rows: result.fewer }
          : !result.done
            ? { table, cursor: result.cursor }
            : after === undefined
              ? null
              : { table: after, cursor: null }
      if (Date.now() - started >= BACKFILL_PAGE.runMs) break
    }
    if (!dry_run) await ctx.runMutation(auditRef, { counts })
    return { dry_run, ...counts, next }
  },
})

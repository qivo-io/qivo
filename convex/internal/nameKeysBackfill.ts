/* One-time migration that gives every profile, team and project stored
 * before name keys existed its `name_key` (schema.ts, lib/nameKey.ts), and
 * every membership, user grant and team share the key of its profile or
 * team, then stamps each organization it finished in org_ready
 * (`name_keys_at`). Lists in name order read those keys and refuse an
 * organization without the stamp (model/nameKeys.ts nameKeysReady), because
 * a row without a key sorts first and a search by name misses it. New rows
 * get their keys from their writers, renames bring the copies in line
 * (model/nameKeys.ts), and an organization created since this release is
 * stamped at its creation (model/orgs.ts insertOrgRows).
 *
 * A run walks each organization's profiles, then its teams, then its
 * projects, a page at a time in creation order (index by_org), each page in
 * its own transaction. For a profile or team it gives up to KEY_PAGE.copies
 * of its copies the key of its current name, found through the copies'
 * index by source and key (model/nameKeys.ts staleCopies), then the row its
 * own key. A page that runs out of that budget is walked again by the next
 * step, which finds only the rows still without the right key, so a source
 * with any number of copies finishes. Every pass reads the current name, so
 * a rename meanwhile cannot leave a key stale. Once the last page of an
 * organization is done, the organization gets its stamp. Deleted items keep
 * their stored copies of projects, grants and team shares as they were; a
 * restore computes their keys from the current names
 * (model/deletedItems.ts cleanProject, cleanGrant, cleanShare), so this
 * walks no deleted_rows. A membership or grant of a removed profile, which
 * its cleanup deletes (profileRemovals.ts), keeps no key.
 *
 * Read the dry run first. It writes nothing and reports, by table, how many
 * keys are missing or stale (`keys`), and lists the organizations with any
 * (`to_fix`) and those without a stamp (`unstamped`). It counts one chunk
 * of a source's copies in each table (model/nameKeys.ts NAME_COPIES.chunk)
 * and at most KEY_PAGE.copies a page; past that, `at_least` is true and the
 * copy counts are lower bounds. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/nameKeysBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/nameKeysBackfill:run '{"dry_run": false}'
 * A call checks the time after each step and stops past RUN.ms, well inside
 * Convex's action time limit, inside an organization if it is in one. It
 * then answers `done: false` with a `cursor`, the organization, table and
 * page to go on from. Call it again with the same arguments and `"cursor"`
 * set to it until `done` is true. A step that throws stops the call with
 * `error` and the cursor of that step, after the call has recorded what
 * committed. `check` reads one
 * page of one organization's table without writing, for a key that may only
 * run internal queries:
 *   "$H" staging npx convex run internal/nameKeysBackfill:check '{"org_id": "…", "table": "profiles"}'
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). On the demo, whose stored key cannot run internal
 * functions, the private with-temp-deploy-key helper runs each command with
 * a short-lived key; `run`, an internal action, needs
 * deployment:functions:runInternalActions, and `check`
 * deployment:functions:runInternalQueries.
 *
 * Every run walks every organization, stamped or not, so a run also mends
 * keys a dry run lists in a stamped organization. An earlier release cannot
 * deploy over a row that holds a key, as its schema has no such field, so a
 * rollback leaves rows without keys only before the first key is written,
 * and a run finds those as it finds any other. A call that wrote adds one
 * platform_audit_log row (action 'name_keys_backfill', actor 'system') with
 * its totals, whether it finished, its cursor and its error. Running it again is
 * safe, and a finished deployment's dry run reports zeros. It writes no
 * activity, sends no task event and changes nothing a person sees. */
import { makeFunctionReference } from 'convex/server'
import { type Infer, v } from 'convex/values'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { MIB } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { audit as writeAudit } from '../model/admin'
import { bringInLine, readyRow } from '../model/nameKeys'

/** Rows of a table one page reads, the bytes that read takes before it ends
 * early, the copies one page brings in line or counts, the bytes it may
 * read of them, and the most organizations a run lists. A team or project
 * stored before legacy icons were dropped can be large, so pages end at the
 * bytes too. Every read counts. A page reads its rows once, up to `bytes`
 * and one more document, under 4 MiB with a document near Convex's 1 MiB
 * limit, and again for each row it gives its key, so its rows cost at most
 * 8 MiB. Its copies cost `copy_bytes`, with both reads of each copy counted,
 * and at most one chunk more (model/nameKeys.ts bringInLine), and each
 * later source reads one copy a table to see whether more are left: under
 * 14 MiB of Convex's 16 in all. Index ranges: one for the page, two for
 * each chunk or probe of a source's copies and one for each patch, which
 * Convex reads by id first, about 2,600 of the 4,096 a transaction may
 * read. Tests lower them. */
export const KEY_PAGE = {
  rows: 100,
  bytes: 3 * MIB,
  copies: 2000,
  copy_bytes: 4 * MIB,
  listed: 100,
}

/** Organizations one read of a run takes, and how long one call of run goes
 * on before it answers where to go on from. It checks the time after each
 * step, so a call always makes progress. Tests lower them. */
export const RUN = { orgs: 100, ms: 5 * 60_000 }

/** The tables that hold their own name key, in the order a run walks them. */
const PHASES = ['profiles', 'teams', 'projects'] as const
type Phase = (typeof PHASES)[number]
const vPhase = v.union(...PHASES.map((phase) => v.literal(phase)))

/** Every table with a name key, copies included. */
const TABLES = [
  'profiles',
  'teams',
  'projects',
  'team_members',
  'project_access',
  'project_team_access',
] as const
type Table = (typeof TABLES)[number]

/** The source each phase's rows are for their copies, if any. */
const SOURCE = { profiles: 'profiles', teams: 'teams', projects: null } as const

/** Keys without a value and keys that are not their name's (or, for a
 * copy, its source's name's), by table. */
type Keys = Record<Table, { missing: number; stale: number }>
const noKeys = (): Keys =>
  Object.fromEntries(TABLES.map((table) => [table, { missing: 0, stale: 0 }])) as Keys

/** What one page found, and where the next one starts. After a step that
 * spent its whole copy budget that is the page's own cursor again
 * (`again`), so the next step walks the same page. `at_least` marks a dry
 * run's copy counts that reached the budget. */
type PageResult = {
  keys: Keys
  cursor: string | null
  done: boolean
  again: boolean
  at_least: boolean
}

/* Counts the missing and stale keys of one page of the organization's
 * `phase` table from `cursor` and, unless `write` is null, gives each its
 * key. The check and the run share it, so both find the same rows. A key
 * changes no index the page is read by, so the cursor stays valid. */
async function walk(
  ctx: QueryCtx,
  orgId: string,
  phase: Phase,
  cursor: string | null,
  write: MutationCtx | null,
): Promise<PageResult> {
  const page = await ctx.db
    .query(phase)
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .paginate({ cursor, numItems: KEY_PAGE.rows, maximumBytesRead: KEY_PAGE.bytes })
  const keys = noKeys()
  const tally = (table: Table, value: string | undefined) => {
    keys[table][value === undefined ? 'missing' : 'stale'] += 1
  }
  const budget = { rows: KEY_PAGE.copies, bytes: KEY_PAGE.copy_bytes }
  const source = SOURCE[phase]
  const found = (table: Table, copy: { name_key?: string }) => tally(table, copy.name_key)
  let full = false
  for (const row of page.page) {
    if (source !== null && (await bringInLine(ctx, source, row, budget, write, found))) full = true
    // a run gives a row its own key once its copies are done; a page it
    // walks again finds the rest
    if (full && write !== null) break
    const key = nameKey(row.name)
    if (row.name_key === key) continue
    tally(phase, row.name_key)
    if (write !== null) await write.db.patch(row._id, { name_key: key })
  }
  if (full && write !== null) return { keys, cursor, done: false, again: true, at_least: false }
  return {
    keys,
    cursor: page.continueCursor,
    done: page.isDone,
    again: false,
    at_least: full,
  }
}

const vArgs = {
  org_id: v.string(),
  table: vPhase,
  cursor: v.optional(v.union(v.string(), v.null())),
}

/** Gives one page the keys it is missing or holds stale, in its own
 * transaction. Answers `again` when the next step must walk the same page. */
export const step = internalMutation({
  args: vArgs,
  handler: async (ctx, { org_id, table, cursor }): Promise<PageResult> =>
    await walk(ctx, org_id, table, cursor ?? null, ctx),
})

/** Counts, without writing, the keys of one page of the organization's
 * `table` that are missing or stale. Leave out `cursor`, or pass null, for
 * the first page, then call again with the returned `cursor` until `done`. */
export const check = internalQuery({
  args: vArgs,
  handler: async (ctx, { org_id, table, cursor }): Promise<PageResult> =>
    await walk(ctx, org_id, table, cursor ?? null, null),
})

/** Stamps the organization's org_ready row once its walk is done, unless it
 * is gone or stamped already. Answers whether it stamped it. */
export const stamp = internalMutation({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<boolean> => {
    if ((await byId(ctx, 'organizations', org_id)) === null) return false
    const row = await readyRow(ctx, org_id)
    if (row?.name_keys_at !== undefined) return false
    const name_keys_at = new Date().toISOString()
    if (row === null) await ctx.db.insert('org_ready', { org_id, name_keys_at })
    else await ctx.db.patch(row._id, { name_keys_at })
    return true
  },
})

/** Organizations by id from `from`, `from` itself only when `inclusive`,
 * each with whether it holds its stamp. `done` when no more follow. */
type OrgPage = { orgs: { org_id: string; stamped: boolean }[]; done: boolean }

/** Up to RUN.orgs organizations by id from `from` on (OrgPage). */
export const orgPage = internalQuery({
  args: { from: v.union(v.string(), v.null()), inclusive: v.boolean() },
  handler: async (ctx, { from, inclusive }): Promise<OrgPage> => {
    const rows = await ctx.db
      .query('organizations')
      .withIndex('by_uuid', (q) =>
        from === null ? q : inclusive ? q.gte('id', from) : q.gt('id', from),
      )
      .take(RUN.orgs)
    const orgs: OrgPage['orgs'] = []
    for (const org of rows)
      orgs.push({
        org_id: org.id,
        stamped: (await readyRow(ctx, org.id))?.name_keys_at !== undefined,
      })
    return { orgs, done: rows.length < RUN.orgs }
  },
})

/** Where a call of run goes on from, in a dry run or a run that writes:
 * the page `page` of the organization's `table`, null for its first, or the
 * organization after the finished one `after`. */
const vRunCursor = v.union(
  v.object({
    dry_run: v.boolean(),
    org_id: v.string(),
    table: vPhase,
    page: v.union(v.string(), v.null()),
  }),
  v.object({ dry_run: v.boolean(), after: v.string() }),
)
type RunCursor = Infer<typeof vRunCursor>

/** The totals a run that wrote records. */
const vTotals = {
  orgs: v.number(),
  stamped: v.number(),
  missing: v.number(),
  stale: v.number(),
  done: v.boolean(),
  cursor: v.union(vRunCursor, v.null()),
  error: v.optional(v.string()),
}
type Totals = Infer<ReturnType<typeof v.object<typeof vTotals>>>

/** Records a call of run that wrote, with its totals, where to go on from
 * and the error that stopped it, if one did. */
export const audit = internalMutation({
  args: vTotals,
  handler: async (ctx, totals) => {
    await writeAudit(ctx, { actor_email: 'system', action: 'name_keys_backfill', detail: totals })
    return null
  },
})

type PageArgs = { org_id: string; table: Phase; cursor?: string | null }
const stepRef = makeFunctionReference<'mutation', PageArgs, PageResult>(
  'internal/nameKeysBackfill:step',
)
const checkRef = makeFunctionReference<'query', PageArgs, PageResult>(
  'internal/nameKeysBackfill:check',
)
const stampRef = makeFunctionReference<'mutation', { org_id: string }, boolean>(
  'internal/nameKeysBackfill:stamp',
)
const orgPageRef = makeFunctionReference<
  'query',
  { from: string | null; inclusive: boolean },
  OrgPage
>('internal/nameKeysBackfill:orgPage')
const auditRef = makeFunctionReference<'mutation', Totals, null>('internal/nameKeysBackfill:audit')

/** One organization as a run lists it, with the keys it found missing or
 * stale. */
type OrgReport = { org_id: string; missing: number; stale: number }

/** Walks every organization by id, from `cursor` on, gives the keys it
 * finds missing or stale and stamps each organization it finished. A dry
 * run writes nothing. Answers the keys by table, how many organizations it
 * finished and stamped, the first KEY_PAGE.listed organizations with keys to
 * fix and, in a dry run, those without a stamp. Past RUN.ms it stops after
 * the step it is in, inside an organization or between two, and answers the
 * `cursor` to go on from, else `done`. A step that throws stops the call
 * too, with `error` and the cursor of that step. A call that wrote ends
 * with its audit row, also when a step threw. */
export const run = internalAction({
  args: { dry_run: v.boolean(), cursor: v.optional(vRunCursor) },
  handler: async (ctx, { dry_run, cursor: from }) => {
    if (from !== undefined && from.dry_run !== dry_run)
      throw new Error('this cursor is from a call with the other dry_run')
    const until = Date.now() + RUN.ms
    const keys = noKeys()
    const toFix: OrgReport[] = []
    const unstamped: string[] = []
    let orgs = 0
    let stamped = 0
    let atLeast = false
    let stepped = false
    // the next step, which a call that stops answers as its cursor
    let next: RunCursor | null = from ?? null
    let done = false
    let error: string | undefined
    const due = () => stepped && Date.now() >= until
    try {
      let read =
        from === undefined
          ? { from: null, inclusive: false }
          : 'after' in from
            ? { from: from.after, inclusive: false }
            : { from: from.org_id, inclusive: true }
      walking: for (;;) {
        const page: OrgPage = await ctx.runQuery(orgPageRef, read)
        for (const org of page.orgs) {
          const resume =
            next !== null && 'org_id' in next && next.org_id === org.org_id ? next : null
          const first = PHASES.indexOf(resume?.table ?? 'profiles')
          next = { dry_run, org_id: org.org_id, table: PHASES[first], page: resume?.page ?? null }
          if (due()) break walking
          if (dry_run && !org.stamped && unstamped.length < KEY_PAGE.listed)
            unstamped.push(org.org_id)
          const report: OrgReport = { org_id: org.org_id, missing: 0, stale: 0 }
          for (let at = first; at < PHASES.length; at++) {
            const table = PHASES[at]
            let cursor = at === first ? (resume?.page ?? null) : null
            for (;;) {
              next = { dry_run, org_id: org.org_id, table, page: cursor }
              if (due()) break walking
              const args: PageArgs = { org_id: org.org_id, table, cursor }
              const got: PageResult = dry_run
                ? await ctx.runQuery(checkRef, args)
                : await ctx.runMutation(stepRef, args)
              stepped = true
              for (const name of TABLES) {
                keys[name].missing += got.keys[name].missing
                keys[name].stale += got.keys[name].stale
                report.missing += got.keys[name].missing
                report.stale += got.keys[name].stale
              }
              atLeast ||= got.at_least
              if (got.done) break
              cursor = got.cursor
            }
          }
          if (report.missing + report.stale > 0 && toFix.length < KEY_PAGE.listed)
            toFix.push(report)
          if (!dry_run && (await ctx.runMutation(stampRef, { org_id: org.org_id }))) stamped++
          orgs++
          next = { dry_run, after: org.org_id }
        }
        if (page.done) {
          done = true
          break
        }
        read = { from: page.orgs.at(-1)?.org_id ?? null, inclusive: false }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    const missing = TABLES.reduce((sum, table) => sum + keys[table].missing, 0)
    const stale = TABLES.reduce((sum, table) => sum + keys[table].stale, 0)
    const cursor = done ? null : next
    if (!dry_run)
      await ctx.runMutation(auditRef, {
        orgs,
        stamped,
        missing,
        stale,
        done,
        cursor,
        ...(error === undefined ? {} : { error }),
      })
    return {
      dry_run,
      orgs,
      stamped,
      keys,
      at_least: atLeast,
      to_fix: toFix,
      ...(dry_run ? { unstamped } : {}),
      done,
      cursor,
      ...(error === undefined ? {} : { error }),
    }
  },
})

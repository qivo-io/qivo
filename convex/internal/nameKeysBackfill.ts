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
 * (`to_fix`) and those without a stamp (`unstamped`). It counts at most
 * KEY_PAGE.copies copies a page; past that, `at_least` is true and the copy
 * counts are lower bounds. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/nameKeysBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/nameKeysBackfill:run '{"dry_run": false}'
 * A call stops after RUN.ms, well inside Convex's action time limit, and
 * then answers `done: false` with a `cursor`. Call it again with the same
 * arguments and `"cursor"` set to it until `done` is true. `check` reads one
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
 * A run walks the organizations without a stamp and leaves the others as
 * they are. `"recheck": true` walks every organization again, to mend keys
 * a dry run lists in a stamped one. A dry run walks every organization. A
 * call that wrote adds one platform_audit_log row (action
 * 'name_keys_backfill', actor 'system') with its totals. Running it again is
 * safe, and a finished deployment's dry run reports zeros. It writes no
 * activity, sends no task event and changes nothing a person sees. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { MIB } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { audit as writeAudit } from '../model/admin'
import { readyRow, staleCopies } from '../model/nameKeys'

/** Rows of a table one page reads, the bytes it reads before it ends early,
 * the copies one page brings in line or counts, and the most organizations
 * a run lists. A team or project stored before legacy icons were dropped
 * can be large, so pages end at the bytes too. A page reads its rows in one
 * range, each source's copies in up to four more (staleCopies), and patches
 * each copy and row it changes, which Convex reads by id first, so a page
 * uses about 2,500 of the 4,096 index ranges a transaction may read. Tests
 * lower them. */
export const KEY_PAGE = { rows: 100, bytes: 4 * MIB, copies: 2000, listed: 100 }

/** Organizations one page of a run reads, and how long one call of run
 * goes on before it answers where to go on from. Tests lower them. */
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

/** The tables that copy each phase's key. */
const COPIES = {
  profiles: ['team_members', 'project_access'],
  teams: ['project_team_access'],
  projects: [],
} as const satisfies Record<Phase, readonly Table[]>

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
  let left = KEY_PAGE.copies
  let full = false
  for (const row of page.page) {
    const key = nameKey(row.name)
    for (const table of COPIES[phase]) {
      const stale = await staleCopies(ctx, table, row.id, key, left + 1)
      const now = stale.slice(0, left)
      for (const copy of now) {
        tally(table, copy.name_key)
        if (write !== null) await write.db.patch(copy._id, { name_key: key })
      }
      left -= now.length
      if (stale.length > now.length) full = true
    }
    // a run gives a row its own key once its copies are done; a page it
    // walks again finds the rest
    if (full && write !== null) break
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

/** A page of organizations, each with whether it holds its stamp. */
type OrgPage = { orgs: { org_id: string; stamped: boolean }[]; cursor: string; done: boolean }

/** One page of organizations, by creation. */
export const orgPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<OrgPage> => {
    const page = await ctx.db.query('organizations').paginate({ cursor, numItems: RUN.orgs })
    const orgs: OrgPage['orgs'] = []
    for (const org of page.page)
      orgs.push({
        org_id: org.id,
        stamped: (await readyRow(ctx, org.id))?.name_keys_at !== undefined,
      })
    return { orgs, cursor: page.continueCursor, done: page.isDone }
  },
})

/** Records a run that wrote, with its totals. */
export const audit = internalMutation({
  args: { orgs: v.number(), stamped: v.number(), missing: v.number(), stale: v.number() },
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
const orgPageRef = makeFunctionReference<'query', { cursor: string | null }, OrgPage>(
  'internal/nameKeysBackfill:orgPage',
)
const auditRef = makeFunctionReference<
  'mutation',
  { orgs: number; stamped: number; missing: number; stale: number },
  null
>('internal/nameKeysBackfill:audit')

/** One organization as a run lists it, with the keys it found missing or
 * stale. */
type OrgReport = { org_id: string; missing: number; stale: number }

/** Walks every organization without a stamp, or every one with `recheck`,
 * from `cursor` on, gives the keys it finds missing or stale and stamps
 * each organization it finished. A dry run walks every organization and
 * writes nothing. Answers the keys by table, how many organizations it
 * walked and stamped, the first KEY_PAGE.listed organizations with keys to
 * fix and, in a dry run, those without a stamp. Past RUN.ms it stops after
 * a page of organizations and answers the `cursor` to go on from, else
 * `done`. A call that wrote ends with its audit row. */
export const run = internalAction({
  args: { dry_run: v.boolean(), recheck: v.optional(v.boolean()), cursor: v.optional(v.string()) },
  handler: async (ctx, { dry_run, recheck = false, cursor: from }) => {
    const until = Date.now() + RUN.ms
    const keys = noKeys()
    const toFix: OrgReport[] = []
    const unstamped: string[] = []
    let orgs = 0
    let stamped = 0
    let atLeast = false
    let cursor: string | null = from ?? null
    let done = false
    for (;;) {
      const page: OrgPage = await ctx.runQuery(orgPageRef, { cursor })
      for (const org of page.orgs) {
        if (dry_run && !org.stamped && unstamped.length < KEY_PAGE.listed)
          unstamped.push(org.org_id)
        if (!dry_run && org.stamped && !recheck) continue
        orgs++
        const report: OrgReport = { org_id: org.org_id, missing: 0, stale: 0 }
        for (const table of PHASES) {
          let at: string | null = null
          for (;;) {
            const args: PageArgs = { org_id: org.org_id, table, cursor: at }
            const got: PageResult = dry_run
              ? await ctx.runQuery(checkRef, args)
              : await ctx.runMutation(stepRef, args)
            for (const name of TABLES) {
              keys[name].missing += got.keys[name].missing
              keys[name].stale += got.keys[name].stale
              report.missing += got.keys[name].missing
              report.stale += got.keys[name].stale
            }
            atLeast ||= got.at_least
            if (got.done) break
            at = got.cursor
          }
        }
        if (report.missing + report.stale > 0 && toFix.length < KEY_PAGE.listed) toFix.push(report)
        if (!dry_run && (await ctx.runMutation(stampRef, { org_id: org.org_id }))) stamped++
      }
      done = page.done
      cursor = page.cursor
      if (done || Date.now() >= until) break
    }
    const missing = TABLES.reduce((sum, table) => sum + keys[table].missing, 0)
    const stale = TABLES.reduce((sum, table) => sum + keys[table].stale, 0)
    if (!dry_run) await ctx.runMutation(auditRef, { orgs, stamped, missing, stale })
    return {
      dry_run,
      orgs,
      stamped,
      keys,
      at_least: atLeast,
      to_fix: toFix,
      ...(dry_run ? { unstamped } : {}),
      done,
      cursor: done ? null : cursor,
    }
  },
})

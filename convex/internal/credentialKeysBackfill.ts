/* One-time migration: give every agent key and personal token stored before
 * credential keys existed its organization and name key (schema.ts
 * agent_keys and mcp_tokens `org_id`, `name_key`), and every OAuth
 * connection its name key, so API access can page them by organization or by
 * person in name order. New rows get them when they are inserted (tokens.ts,
 * machine/testing.ts, oauthConnections.ts). A row whose keys differ from
 * what its profile and name give gets them again, so a run also repairs
 * those. Nothing reads the keys yet; the readers that will page by them
 * check first that no row is left without them (schema.ts).
 *
 * An agent key or personal token whose profile is gone has no organization
 * to take. Only a profile removal leaves such rows, and its background steps
 * delete them (profileRemovals.ts), so a page leaves them alone and counts
 * them as `orphans`. A later check finds them gone.
 *
 * Check a deployment before changing it. `remaining` is a query, so it
 * cannot write, and a key that may only run internal queries can run it. It
 * counts the rows of one page of a table whose keys are missing or differ.
 * Start with `{"table": "agent_keys"}`, pass the returned `cursor` back
 * until `done` is true, then do the same for `"mcp_tokens"` and
 * `"oauth_connections"`. If every page reports zero `rows`, the deployment
 * has nothing to give a key. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/credentialKeysBackfill:remaining '{"table": "agent_keys"}'
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). Read the dry run, which writes nothing, then give
 * the keys and check again:
 *   "$H" staging npx convex run internal/credentialKeysBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/credentialKeysBackfill:run '{"dry_run": false}'
 * A call stops after RUN.ms, well inside Convex's action time limit, and
 * then answers `done: false` with a `table` and a `cursor`. Call it again
 * with the same arguments and those two until `done` is true.
 *
 * On the demo, whose stored key cannot run internal functions, the private
 * with-temp-deploy-key helper runs each command with a short-lived key:
 * `remaining` needs deployment:functions:runInternalQueries and `run`, an
 * internal action, deployment:functions:runInternalActions.
 *
 * A call that writes adds one platform_audit_log row (action
 * 'credential_keys_backfill', actor 'system') with its counts. The results
 * hold counts only, never a credential's name or hash. Running it again is
 * safe, and a clean deployment reports zeros. It writes no activity, sends
 * no task event and changes nothing a person sees. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { MIB } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { audit as writeAudit } from '../model/admin'

/** Rows per page of each table, for the check and for each step of the
 * run, and the bytes one page may read. A credential row is a few hundred
 * bytes, and a page reads at most one profile per row and writes at most one
 * patch per row, inside Convex's 4,096 index ranges and 16,000 writes. Tests
 * lower them. */
export const BACKFILL_PAGE = { rows: 500, bytes: 4 * MIB }

/** How long one call of run goes on before it answers where to go on from.
 * Tests lower it. */
export const RUN = { ms: 5 * 60_000 }

const TABLES = ['agent_keys', 'mcp_tokens', 'oauth_connections'] as const
type KeyedTable = (typeof TABLES)[number]
const vTable = v.union(...TABLES.map((table) => v.literal(table)))

/** What one page found, and where the next one starts. */
type PageResult = { rows: number; orphans: number; cursor: string; done: boolean }

/** The keys a credential row should hold, or null for an agent key or
 * personal token whose profile is gone. */
async function keysOf(
  ctx: QueryCtx,
  row: Doc<KeyedTable>,
  profiles: Map<string, Promise<Doc<'profiles'> | null>>,
): Promise<{ org_id?: string; name_key: string } | null> {
  if ('client_name' in row) return { name_key: nameKey(row.client_name) }
  let profile = profiles.get(row.profile_id)
  if (profile === undefined) {
    profile = byId(ctx, 'profiles', row.profile_id)
    profiles.set(row.profile_id, profile)
  }
  const owner = await profile
  return owner === null ? null : { org_id: owner.org_id, name_key: nameKey(row.name) }
}

/* One page of `table` from `cursor`: how many rows have keys that are
 * missing or differ, and how many have no profile to take an organization
 * from, and, unless `write` is null, gives each its keys. The check and the
 * run share it, so both find the same rows. The page is read in creation
 * order, which the keys do not change, so the cursor stays valid. */
async function walk(
  ctx: QueryCtx,
  table: KeyedTable,
  cursor: string | null,
  write: MutationCtx | null,
): Promise<PageResult> {
  const page = await ctx.db.query(table).paginate({
    cursor,
    numItems: BACKFILL_PAGE.rows,
    maximumBytesRead: BACKFILL_PAGE.bytes,
  })
  const profiles = new Map<string, Promise<Doc<'profiles'> | null>>()
  let rows = 0
  let orphans = 0
  for (const row of page.page) {
    const keys = await keysOf(ctx, row, profiles)
    if (keys === null) {
      orphans++
      continue
    }
    const stale = row.name_key !== keys.name_key || ('org_id' in keys && row.org_id !== keys.org_id)
    if (!stale) continue
    rows++
    if (write !== null) await write.db.patch(row._id, keys)
  }
  return { rows, orphans, cursor: page.continueCursor, done: page.isDone }
}

const pageRef = makeFunctionReference<
  'mutation',
  { table: KeyedTable; dry_run: boolean; cursor: string | null },
  PageResult
>('internal/credentialKeysBackfill:page')

/** The counts a run adds up, per table. */
type Counts = Record<KeyedTable, number> & { orphans: number }

const auditRef = makeFunctionReference<'mutation', Counts, null>(
  'internal/credentialKeysBackfill:audit',
)

/** One page in its own transaction: gives the keys, or only counts the rows
 * without them with `dry_run`. */
export const page = internalMutation({
  args: { table: vTable, dry_run: v.boolean(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, dry_run, cursor }): Promise<PageResult> =>
    await walk(ctx, table, cursor, dry_run ? null : ctx),
})

/** Counts, without writing, the rows of one page of `table` whose keys are
 * missing or differ. Leave out `cursor`, or pass null, for the first page,
 * then call again with the returned `cursor` until `done`. */
export const remaining = internalQuery({
  args: { table: vTable, cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { table, cursor }): Promise<PageResult> =>
    await walk(ctx, table, cursor ?? null, null),
})

/** Records a call that wrote, with its counts. */
export const audit = internalMutation({
  args: {
    agent_keys: v.number(),
    mcp_tokens: v.number(),
    oauth_connections: v.number(),
    orphans: v.number(),
  },
  handler: async (ctx, counts) => {
    await writeAudit(ctx, {
      actor_email: 'system',
      action: 'credential_keys_backfill',
      detail: counts,
    })
    return null
  },
})

/** Walks the pages of every table from `table` and `cursor` on, or from the
 * start, and reports per table how many rows it gave keys, or would give
 * them, and how many it left without a profile. Past RUN.ms it answers the
 * `table` and `cursor` to go on from, else `done`. A call that wrote ends
 * with its audit row. */
export const run = internalAction({
  args: { dry_run: v.boolean(), table: v.optional(vTable), cursor: v.optional(v.string()) },
  handler: async (ctx, { dry_run, table: from, cursor: at }) => {
    const until = Date.now() + RUN.ms
    const counts: Counts = { agent_keys: 0, mcp_tokens: 0, oauth_connections: 0, orphans: 0 }
    let next: { table: KeyedTable; cursor: string | null } | null = null
    let paged = false
    walking: for (const table of TABLES.slice(from === undefined ? 0 : TABLES.indexOf(from))) {
      let cursor: string | null = table === from ? (at ?? null) : null
      for (;;) {
        // every call gets through at least one page
        if (paged && Date.now() >= until) {
          next = { table, cursor }
          break walking
        }
        const result: PageResult = await ctx.runMutation(pageRef, { table, dry_run, cursor })
        paged = true
        counts[table] += result.rows
        counts.orphans += result.orphans
        if (result.done) break
        cursor = result.cursor
      }
    }
    if (!dry_run) await ctx.runMutation(auditRef, counts)
    return {
      dry_run,
      ...counts,
      done: next === null,
      table: next?.table ?? null,
      cursor: next?.cursor ?? null,
    }
  },
})

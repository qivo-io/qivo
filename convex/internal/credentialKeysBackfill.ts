/* One-time migration: give every agent key and personal token stored before
 * credential keys existed its organization and name key (schema.ts
 * agent_keys and mcp_tokens `org_id`, `name_key`), and every OAuth
 * connection its name key, so API access can page them by organization or by
 * person in name order. New rows get them when they are inserted (tokens.ts,
 * machine/testing.ts, oauthConnections.ts). A row whose keys differ from
 * what its profile and name give gets them again, so a run also repairs
 * those. API access pages by them (apiAccess.ts page), and checks first
 * that no row of its scope is left without them (schema.ts), answering that
 * it is not ready until then.
 *
 * An agent key or personal token whose profile is gone has no organization
 * to take. Only a profile removal leaves such rows, and its background steps
 * delete them (profileRemovals.ts), so a page leaves them alone and counts
 * them as `orphans`. A later check finds them gone. API access lists no
 * such row, so a few of them leave its pages ready (apiAccess.ts
 * credentialsKeyed).
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
 * A call stops between two steps once RUN.ms has passed, well inside
 * Convex's action time limit, and then answers `done: false` with a `table`
 * and a `cursor`. Call it again with the same arguments and both of those,
 * unchanged, until `done` is true. The cursor is null where a table starts,
 * and a cursor without its table is refused. A run reads each page in a
 * query and writes only the rows that need keys, each read again by id in a
 * small batch, so the credentials every API call stamps stay out of its
 * transactions. A page or batch that fails ends the call with `error`, after
 * the audit row of what committed, and the `table` and `cursor` of the page
 * to read again.
 *
 * On the demo, whose stored key cannot run internal functions, the private
 * with-temp-deploy-key helper runs each command with a short-lived key:
 * `remaining` needs deployment:functions:runInternalQueries and `run`, an
 * internal action, deployment:functions:runInternalActions.
 *
 * A call that is not a dry run adds one platform_audit_log row (action
 * 'credential_keys_backfill', actor 'system') with its counts. The results
 * hold counts only, never a credential's name or hash. Running it again is
 * safe, and a clean deployment reports zeros. It writes no activity, sends
 * no task event and changes nothing a person sees. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { badRequest } from '../lib/functions'
import { MIB } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { audit as writeAudit } from '../model/admin'

/** Rows per page of each table, the bytes one page may read, and the rows
 * one batch of the run writes. A credential row is a few hundred bytes, and
 * a page reads at most one profile per row, a few hundred bytes more. A
 * batch reads each row again and its profile, and writes one patch per row.
 * Tests lower them. */
export const BACKFILL_PAGE = { rows: 500, bytes: 4 * MIB, batch: 100 }

/** How long one call of run goes on before it answers where to go on from.
 * Tests lower it. */
export const RUN = { ms: 5 * 60_000 }

const TABLES = ['agent_keys', 'mcp_tokens', 'oauth_connections'] as const
type KeyedTable = (typeof TABLES)[number]
const vTable = v.union(...TABLES.map((table) => v.literal(table)))
const vCredentialId = v.union(v.id('agent_keys'), v.id('mcp_tokens'), v.id('oauth_connections'))
type CredentialId = Id<KeyedTable>

/** What one page found: how many rows have keys that are missing or differ,
 * which rows those are, how many have no profile, and where the next page
 * starts. */
type PageResult = {
  rows: number
  orphans: number
  stale: CredentialId[]
  cursor: string
  done: boolean
}

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

/** Whether `row` holds keys other than `keys`. */
const isStale = (row: Doc<KeyedTable>, keys: { org_id?: string; name_key: string }): boolean =>
  row.name_key !== keys.name_key || ('org_id' in keys && row.org_id !== keys.org_id)

/* One page of `table` from `cursor`, read without writing: the rows whose
 * keys are missing or differ, and the rows without a profile to take an
 * organization from. The check and the run share it, so both find the same
 * rows. The page is read in creation order, which the keys do not change,
 * so the cursor stays valid. */
async function walk(ctx: QueryCtx, table: KeyedTable, cursor: string | null): Promise<PageResult> {
  const page = await ctx.db.query(table).paginate({
    cursor,
    numItems: BACKFILL_PAGE.rows,
    maximumBytesRead: BACKFILL_PAGE.bytes,
  })
  const profiles = new Map<string, Promise<Doc<'profiles'> | null>>()
  const stale: CredentialId[] = []
  let orphans = 0
  for (const row of page.page) {
    const keys = await keysOf(ctx, row, profiles)
    if (keys === null) orphans++
    else if (isStale(row, keys)) stale.push(row._id)
  }
  return { rows: stale.length, orphans, stale, cursor: page.continueCursor, done: page.isDone }
}

/** One page of `table` and the rows on it that need keys (walk). */
export const scan = internalQuery({
  args: { table: vTable, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, cursor }): Promise<PageResult> => await walk(ctx, table, cursor),
})

/** Gives each of the rows `ids` the keys it needs, reading it again, and
 * answers how many it changed. A row gone, without a profile or with its
 * keys already is left alone. */
export const fix = internalMutation({
  args: { ids: v.array(vCredentialId) },
  handler: async (ctx, { ids }): Promise<number> => {
    const profiles = new Map<string, Promise<Doc<'profiles'> | null>>()
    let fixed = 0
    for (const id of ids) {
      const row = await ctx.db.get(id)
      const keys = row === null ? null : await keysOf(ctx, row, profiles)
      if (row === null || keys === null || !isStale(row, keys)) continue
      await ctx.db.patch(id, keys)
      fixed++
    }
    return fixed
  },
})

/** Counts, without writing, the rows of one page of `table` whose keys are
 * missing or differ. Leave out `cursor`, or pass null, for the first page,
 * then call again with the returned `cursor` until `done`. */
export const remaining = internalQuery({
  args: { table: vTable, cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { table, cursor }) => {
    const { stale: _ids, ...counts } = await walk(ctx, table, cursor ?? null)
    return counts
  },
})

/** The counts a run adds up, per table. */
type Counts = Record<KeyedTable, number> & { orphans: number }

/** Records a call that was not a dry run, with its counts. */
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

const scanRef = makeFunctionReference<
  'query',
  { table: KeyedTable; cursor: string | null },
  PageResult
>('internal/credentialKeysBackfill:scan')
const fixRef = makeFunctionReference<'mutation', { ids: CredentialId[] }, number>(
  'internal/credentialKeysBackfill:fix',
)
const auditRef = makeFunctionReference<'mutation', Counts, null>(
  'internal/credentialKeysBackfill:audit',
)

/** Walks the pages of every table from `table` and `cursor` on, or from the
 * start, and reports per table how many rows it gave keys, or would give
 * them, and how many it left without a profile. Between any two steps past
 * RUN.ms, once it has written a batch or read a page with nothing to write,
 * it answers the `table` and `cursor` to go on from, else `done`. A page or
 * batch that fails ends the call with `error` and the page to read again. A
 * call that is not a dry run ends with its audit row of what committed. */
export const run = internalAction({
  args: {
    dry_run: v.boolean(),
    table: v.optional(v.union(vTable, v.null())),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { dry_run, table, cursor: at }) => {
    const from = table ?? undefined
    if (from === undefined && at !== undefined && at !== null)
      throw badRequest('a cursor goes back with the table it was answered with')
    const until = Date.now() + RUN.ms
    const counts: Counts = { agent_keys: 0, mcp_tokens: 0, oauth_connections: 0, orphans: 0 }
    let next: { table: KeyedTable; cursor: string | null } | null = null
    let error: string | null = null
    // Every call gets through one batch, or one page with nothing to write,
    // before it may stop, so each call moves the walk on.
    let progressed = false
    const late = () => progressed && Date.now() >= until
    walking: for (const table of TABLES.slice(from === undefined ? 0 : TABLES.indexOf(from))) {
      let cursor: string | null = table === from ? (at ?? null) : null
      for (;;) {
        if (late()) {
          next = { table, cursor }
          break walking
        }
        try {
          const page: PageResult = await ctx.runQuery(scanRef, { table, cursor })
          if (dry_run) counts[table] += page.rows
          for (let i = 0; !dry_run && i < page.stale.length; i += BACKFILL_PAGE.batch) {
            if (late()) {
              next = { table, cursor }
              break walking
            }
            const ids = page.stale.slice(i, i + BACKFILL_PAGE.batch)
            counts[table] += await ctx.runMutation(fixRef, { ids })
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
          next = { table, cursor }
          break walking
        }
      }
    }
    if (!dry_run) await ctx.runMutation(auditRef, counts)
    return {
      dry_run,
      ...counts,
      done: next === null,
      table: next?.table ?? null,
      cursor: next?.cursor ?? null,
      ...(error === null ? {} : { error }),
    }
  },
})

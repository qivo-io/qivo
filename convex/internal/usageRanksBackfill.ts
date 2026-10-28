/* One-time migration: rank every API usage row stored before ranks existed
 * (schema.ts billing_usage `neg_calls`, `name_key`) and count its calls in
 * its account's billing_usage_accounts row and, for a calendar month, in the
 * organization's billing_month_totals, each row in the transaction that
 * ranks it (model/billingUsage.ts writeUsageRow). A row whose rank differs
 * from its calls and name is written again, with the aggregates moved by the
 * difference, so a run also repairs those. Every API call ranks the row it
 * counts on the same way, so a row ranked by a call is left alone, and no
 * row's calls are counted twice, whichever comes first. Nothing reads the
 * aggregates yet; the readers that will read them check first that the
 * bucket's rows are all ranked (usageRanked).
 *
 * Check a deployment before changing it. `remaining` is a query, so it
 * cannot write, and a key that may only run internal queries can run it. It
 * counts the rows of one page that a run would write and the calls they add
 * to the aggregates. Pass the returned `cursor` back until `done` is true.
 * `check` compares every account row and every bucket total of every
 * organization with the rows they count, and writes nothing. With the
 * private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/usageRanksBackfill:remaining '{}'
 *   "$H" staging npx convex run internal/usageRanksBackfill:check '{}'
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). Read the dry run, which writes nothing, then rank
 * the rows and check again:
 *   "$H" staging npx convex run internal/usageRanksBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/usageRanksBackfill:run '{"dry_run": false}'
 *   "$H" staging npx convex run internal/usageRanksBackfill:check '{}'
 * A call of `run` or `check` stops after RUN.ms, well inside Convex's action
 * time limit, and then answers `done: false` with a `cursor`. Call it again
 * with the same arguments and `"cursor"` set to it until `done` is true.
 * After a run, `check` should report no unranked bucket and no difference.
 * It lists a bucket whose total changed while it counted, as calls do in
 * the current period, as unsettled, to check again later, and the deleted
 * organizations whose account rows or month totals were left, which only an
 * organization deletion that an earlier release ran can leave and which
 * nothing reads.
 *
 * On the demo, whose stored key cannot run internal functions, the private
 * with-temp-deploy-key helper runs each command with a short-lived key:
 * `remaining` needs deployment:functions:runInternalQueries, and `run` and
 * `check`, internal actions, deployment:functions:runInternalActions. The
 * demo records no API calls, so it should have nothing to rank.
 *
 * A call of `run` that writes adds one platform_audit_log row (action
 * 'usage_ranks_backfill', actor 'system') with its counts. The results hold
 * counts and organization, profile and bucket ids only. Running it again is
 * safe, and a clean deployment reports zeros. It writes no activity, sends
 * no task event and changes nothing a person sees: the Billing and API
 * access pages still sum the usage rows. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { ActionCtx, MutationCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { MIB } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { audit as writeAudit } from '../model/admin'
import { isMonthKey, periodCalls, usageRanked, writeUsageRow } from '../model/billingUsage'

/** Usage rows per page of the run and the check, the bytes one page may
 * read, account rows per page of the check, and the most entries a check
 * lists of each kind. A usage row is a few hundred bytes, as its names are
 * capped, and an account or month row less. Ranking one writes the row, its
 * account row and at most one month shard after two index reads of small
 * rows, so a page stays inside Convex's 4,096 index ranges, 16,000 writes
 * and 16 MiB read. Tests lower them. */
export const BACKFILL_PAGE = { rows: 500, bytes: 4 * MIB, accounts: 200, listed: 100 }

/** Organizations one page of the check reads, buckets one query of the
 * check lists, and how long one call of run or check goes on before it
 * answers where to go on from. Tests lower them. */
export const RUN = { orgs: 50, buckets: 200, ms: 5 * 60_000 }

/** What one page found, and where the next one starts: the rows a run
 * writes and the calls that adds to the aggregates. */
type PageResult = { rows: number; calls: number; cursor: string; done: boolean }

/** The calls a usage row's aggregates hold of it now, and whether its rank
 * matches its calls and name. */
function rankOf(row: Doc<'billing_usage'>): { counted: number; current: boolean } {
  const counted = row.neg_calls === undefined ? 0 : -row.neg_calls
  return {
    counted,
    current:
      row.neg_calls !== undefined &&
      counted === row.calls &&
      row.name_key === nameKey(row.credential_name),
  }
}

/* One page of billing_usage from `cursor`: how many rows have no rank or
 * one that differs, and how many calls ranking them adds to the aggregates,
 * and, unless `write` is null, ranks each. The check and the run share it,
 * so both find the same rows. The page is read in creation order, which a
 * rank does not change, so the cursor stays valid. */
async function walk(
  ctx: QueryCtx,
  cursor: string | null,
  write: MutationCtx | null,
): Promise<PageResult> {
  const page = await ctx.db.query('billing_usage').paginate({
    cursor,
    numItems: BACKFILL_PAGE.rows,
    maximumBytesRead: BACKFILL_PAGE.bytes,
  })
  let rows = 0
  let calls = 0
  for (const row of page.page) {
    const { counted, current } = rankOf(row)
    if (current) continue
    rows++
    calls += row.calls - counted
    if (write !== null) await writeUsageRow(write, row, row, row.calls, row.credential_name)
  }
  return { rows, calls, cursor: page.continueCursor, done: page.isDone }
}

const pageRef = makeFunctionReference<
  'mutation',
  { dry_run: boolean; cursor: string | null },
  PageResult
>('internal/usageRanksBackfill:page')

const auditRef = makeFunctionReference<'mutation', { rows: number; calls: number }, null>(
  'internal/usageRanksBackfill:audit',
)

/** One page in its own transaction: ranks the rows, or only counts them
 * with `dry_run`. */
export const page = internalMutation({
  args: { dry_run: v.boolean(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { dry_run, cursor }): Promise<PageResult> =>
    await walk(ctx, cursor, dry_run ? null : ctx),
})

/** Counts, without writing, the rows of one page that a run would rank.
 * Leave out `cursor`, or pass null, for the first page, then call again with
 * the returned `cursor` until `done`. */
export const remaining = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }): Promise<PageResult> => await walk(ctx, cursor ?? null, null),
})

/** Records a call that wrote, with its counts. */
export const audit = internalMutation({
  args: { rows: v.number(), calls: v.number() },
  handler: async (ctx, counts) => {
    await writeAudit(ctx, { actor_email: 'system', action: 'usage_ranks_backfill', detail: counts })
    return null
  },
})

/** Walks the usage rows from `cursor` on, or from the start, and reports
 * how many it ranked, or would rank, and the calls that added to the
 * aggregates. Past RUN.ms it answers the `cursor` to go on from, else
 * `done`. A call that wrote ends with its audit row. */
export const run = internalAction({
  args: { dry_run: v.boolean(), cursor: v.optional(v.string()) },
  handler: async (ctx, { dry_run, cursor: from }) => {
    const until = Date.now() + RUN.ms
    const counts = { rows: 0, calls: 0 }
    let cursor: string | null = from ?? null
    let done = false
    for (;;) {
      const result: PageResult = await ctx.runMutation(pageRef, { dry_run, cursor })
      counts.rows += result.rows
      counts.calls += result.calls
      done = result.done
      cursor = result.cursor
      if (done || Date.now() >= until) break
    }
    if (!dry_run) await ctx.runMutation(auditRef, counts)
    return { dry_run, ...counts, done, cursor: done ? null : cursor }
  },
})

/* ------------------------------------------------------------------ check */

/** A page of organization ids. */
type OrgPage = { orgs: string[]; cursor: string; done: boolean }

/** One page of organizations, by id. */
export const orgPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<OrgPage> => {
    const page = await ctx.db.query('organizations').paginate({ cursor, numItems: RUN.orgs })
    return { orgs: page.page.map((org) => org.id), cursor: page.continueCursor, done: page.isDone }
  },
})

/** Up to RUN.buckets bucket keys of the organization's usage after `after`
 * in key order, one indexed read each, and whether more may follow. */
export const buckets = internalQuery({
  args: { org_id: v.string(), after: v.union(v.string(), v.null()) },
  handler: async (ctx, { org_id, after }): Promise<{ keys: string[]; more: boolean }> => {
    const keys: string[] = []
    let last = after
    while (keys.length < RUN.buckets) {
      const from = last
      const next = await ctx.db
        .query('billing_usage')
        .withIndex('by_org_period', (q) =>
          from === null ? q.eq('org_id', org_id) : q.eq('org_id', org_id).gt('period_start', from),
        )
        .first()
      if (next === null) return { keys, more: false }
      keys.push(next.period_start)
      last = next.period_start
    }
    return { keys, more: true }
  },
})

/** A bucket's state: whether its rows are all ranked, its total as readers
 * will read it (periodCalls), and, for a calendar month, whether a
 * billing_usage_totals row holds a total for it too. Releases v0.1.14 and
 * v0.1.15 counted calendar months there, and nothing has counted them there
 * since, so such a row holds only part of the month. */
type BucketState = { ranked: boolean; total: number | null; month_total_row: boolean }

/** The bucket's state (BucketState). */
export const bucketState = internalQuery({
  args: { org_id: v.string(), period: v.string() },
  handler: async (ctx, { org_id, period }): Promise<BucketState> => ({
    ranked: await usageRanked(ctx, org_id, period),
    total: await periodCalls(ctx, org_id, period),
    month_total_row:
      isMonthKey(period) &&
      (await ctx.db
        .query('billing_usage_totals')
        .withIndex('by_org_period', (q) => q.eq('org_id', org_id).eq('period_start', period))
        .first()) !== null,
  }),
})

/** Calls by profile in one page of a bucket's rows. */
type SumPage = { calls: Record<string, number>; cursor: string; done: boolean }

/** One page of the bucket's ranked usage rows, their calls added up by
 * profile. */
export const usagePage = internalQuery({
  args: { org_id: v.string(), period: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { org_id, period, cursor }): Promise<SumPage> => {
    const page = await ctx.db
      .query('billing_usage')
      .withIndex('by_org_period_profile_rank', (q) =>
        q.eq('org_id', org_id).eq('period_start', period),
      )
      .paginate({ cursor, numItems: BACKFILL_PAGE.rows, maximumBytesRead: BACKFILL_PAGE.bytes })
    const calls: Record<string, number> = {}
    for (const row of page.page)
      if (row.neg_calls !== undefined)
        calls[row.profile_id] = (calls[row.profile_id] ?? 0) + row.calls
    return { calls, cursor: page.continueCursor, done: page.isDone }
  },
})

/** One page of the bucket's account rows, their calls by profile. */
export const accountPage = internalQuery({
  args: { org_id: v.string(), period: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { org_id, period, cursor }): Promise<SumPage> => {
    const page = await ctx.db
      .query('billing_usage_accounts')
      .withIndex('by_org_period_profile', (q) => q.eq('org_id', org_id).eq('period_start', period))
      .paginate({
        cursor,
        numItems: BACKFILL_PAGE.accounts,
        maximumBytesRead: BACKFILL_PAGE.bytes,
      })
    const calls: Record<string, number> = {}
    for (const row of page.page) calls[row.profile_id] = row.calls
    return { calls, cursor: page.continueCursor, done: page.isDone }
  },
})

/** The aggregate tables a deleted organization's rows can be left in. */
const AGGREGATES = ['billing_usage_accounts', 'billing_month_totals'] as const
const vAggregate = v.union(...AGGREGATES.map((table) => v.literal(table)))

/** Up to RUN.buckets organization ids after `after` that rows of aggregate
 * `table` name although the organization is gone, two indexed reads per
 * organization the table names, and whether more may follow. Organization
 * deletion deletes them, so only a deletion that an earlier release ran
 * leaves them. */
export const goneOrgs = internalQuery({
  args: { table: vAggregate, after: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, after }): Promise<{ gone: string[]; last: string | null }> => {
    const gone: string[] = []
    let last = after
    for (let read = 0; read < RUN.buckets; read++) {
      const from = last
      const next =
        table === 'billing_usage_accounts'
          ? await ctx.db
              .query(table)
              .withIndex('by_org_period_profile', (q) => (from === null ? q : q.gt('org_id', from)))
              .first()
          : await ctx.db
              .query(table)
              .withIndex('by_org_period_shard', (q) => (from === null ? q : q.gt('org_id', from)))
              .first()
      if (next === null) return { gone, last: null }
      if ((await byId(ctx, 'organizations', next.org_id)) === null) gone.push(next.org_id)
      last = next.org_id
    }
    return { gone, last }
  },
})

const orgPageRef = makeFunctionReference<'query', { cursor: string | null }, OrgPage>(
  'internal/usageRanksBackfill:orgPage',
)
const bucketsRef = makeFunctionReference<
  'query',
  { org_id: string; after: string | null },
  { keys: string[]; more: boolean }
>('internal/usageRanksBackfill:buckets')
const bucketStateRef = makeFunctionReference<
  'query',
  { org_id: string; period: string },
  BucketState
>('internal/usageRanksBackfill:bucketState')
type SumArgs = { org_id: string; period: string; cursor: string | null }
const usagePageRef = makeFunctionReference<'query', SumArgs, SumPage>(
  'internal/usageRanksBackfill:usagePage',
)
const accountPageRef = makeFunctionReference<'query', SumArgs, SumPage>(
  'internal/usageRanksBackfill:accountPage',
)
const goneOrgsRef = makeFunctionReference<
  'query',
  { table: (typeof AGGREGATES)[number]; after: string | null },
  { gone: string[]; last: string | null }
>('internal/usageRanksBackfill:goneOrgs')

/** Adds up every page `ref` answers for the bucket, by profile. */
async function sumPages(
  ctx: Pick<ActionCtx, 'runQuery'>,
  ref: typeof usagePageRef,
  org_id: string,
  period: string,
): Promise<Map<string, number>> {
  const sums = new Map<string, number>()
  for (let cursor: string | null = null; ; ) {
    const page: SumPage = await ctx.runQuery(ref, { org_id, period, cursor })
    for (const [profile, calls] of Object.entries(page.calls))
      sums.set(profile, (sums.get(profile) ?? 0) + calls)
    if (page.done) return sums
    cursor = page.cursor
  }
}

/** A bucket as the check lists it. */
type BucketRef = { org_id: string; period: string }

/** An account whose row differs from its ranked usage rows. `stored` is
 * null when it has no row. */
type AccountDiff = BucketRef & { profile_id: string; stored: number | null; rows: number }

/** Checks every usage bucket of every organization from `cursor` on, and
 * writes nothing. A bucket with an unranked row is only counted
 * (`unranked`), since its aggregates are not complete until a run. For every
 * other bucket it lists the accounts whose row differs from their ranked
 * usage rows, or that have none (`differing_account_rows`), and the buckets
 * whose total, a month's shards or another bucket's billing_usage_totals
 * row, differs from the sum of their account rows
 * (`differing_total_buckets`). A bucket whose total changed while it was
 * read is listed as unsettled (`unsettled_buckets`) instead, to check again
 * later. It also lists the calendar months that hold a total in
 * billing_usage_totals from releases v0.1.14 and v0.1.15
 * (`month_total_buckets`), which nothing here reads, and, in its last call,
 * the deleted organizations whose aggregate rows were left
 * (`gone_org_ids`). Each list holds at most BACKFILL_PAGE.listed entries,
 * and the counts cover all. Past RUN.ms it stops after a page of
 * organizations and answers the `cursor` to go on from, else `done`. */
export const check = internalAction({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor: from }) => {
    const until = Date.now() + RUN.ms
    const counts = {
      orgs: 0,
      buckets: 0,
      unranked: 0,
      differing_accounts: 0,
      differing_totals: 0,
      unsettled: 0,
      month_total_rows: 0,
      gone_orgs: 0,
    }
    const differingAccounts: AccountDiff[] = []
    const differingTotals: (BucketRef & { total: number | null; accounts: number })[] = []
    const unsettled: BucketRef[] = []
    const monthTotalRows: BucketRef[] = []
    const goneOrgIds: string[] = []
    const listed = <T>(entries: T[], entry: T) => {
      if (entries.length < BACKFILL_PAGE.listed) entries.push(entry)
    }
    /* One bucket: its rows and account rows are read in pages of their own,
     * so its sums hold only if its total stayed the same meanwhile. */
    const checkBucket = async (org_id: string, period: string) => {
      const start: BucketState = await ctx.runQuery(bucketStateRef, { org_id, period })
      if (start.month_total_row) {
        counts.month_total_rows++
        listed(monthTotalRows, { org_id, period })
      }
      if (!start.ranked) {
        counts.unranked++
        return
      }
      const rows = await sumPages(ctx, usagePageRef, org_id, period)
      const accounts = await sumPages(ctx, accountPageRef, org_id, period)
      const end: BucketState = await ctx.runQuery(bucketStateRef, { org_id, period })
      if (end.total !== start.total || !end.ranked) {
        counts.unsettled++
        listed(unsettled, { org_id, period })
        return
      }
      for (const profile_id of new Set([...rows.keys(), ...accounts.keys()])) {
        const stored = accounts.get(profile_id) ?? null
        const counted = rows.get(profile_id) ?? 0
        if (stored === counted) continue
        counts.differing_accounts++
        listed(differingAccounts, { org_id, period, profile_id, stored, rows: counted })
      }
      const sum = [...accounts.values()].reduce((total, calls) => total + calls, 0)
      if (start.total !== sum) {
        counts.differing_totals++
        listed(differingTotals, { org_id, period, total: start.total, accounts: sum })
      }
    }
    let cursor: string | null = from ?? null
    let done = false
    for (;;) {
      const orgs: OrgPage = await ctx.runQuery(orgPageRef, { cursor })
      for (const org_id of orgs.orgs) {
        counts.orgs++
        for (let last: string | null = null, more = true; more; ) {
          const found: { keys: string[]; more: boolean } = await ctx.runQuery(bucketsRef, {
            org_id,
            after: last,
          })
          more = found.more
          for (const period of found.keys) {
            last = period
            counts.buckets++
            await checkBucket(org_id, period)
          }
        }
      }
      done = orgs.done
      cursor = orgs.cursor
      if (done || Date.now() >= until) break
    }
    if (done)
      for (const table of AGGREGATES)
        for (let after: string | null = null; ; ) {
          const page: { gone: string[]; last: string | null } = await ctx.runQuery(goneOrgsRef, {
            table,
            after,
          })
          for (const org_id of page.gone)
            if (!goneOrgIds.includes(org_id)) {
              counts.gone_orgs++
              listed(goneOrgIds, org_id)
            }
          if (page.last === null) break
          after = page.last
        }
    return {
      ...counts,
      differing_account_rows: differingAccounts,
      differing_total_buckets: differingTotals,
      unsettled_buckets: unsettled,
      month_total_buckets: monthTotalRows,
      gone_org_ids: goneOrgIds,
      done,
      cursor: done ? null : cursor,
    }
  },
})

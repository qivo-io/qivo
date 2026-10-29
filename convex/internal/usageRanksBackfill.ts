/* One-time migration: rank every API usage row stored before ranks existed
 * (schema.ts billing_usage `neg_calls`, `name_key`) and count its calls in
 * its account's billing_usage_accounts row and, for a calendar month, in the
 * organization's billing_month_totals, each row in the transaction that
 * ranks it (model/billingUsage.ts writeUsageRow). A row whose rank differs
 * from its calls and name is written again, with the aggregates moved by the
 * difference, so a run also repairs those. Every API call ranks the row it
 * counts on the same way, so a row ranked by a call is left alone, and no
 * row's calls are counted twice, whichever comes first. API access reads
 * the ranks and a month's total (apiAccess.ts page and summary), and checks
 * first that the bucket's rows are all ranked (usageRanked), answering that
 * it is not ready, or that the total is not available, until then.
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
 * A call of `run` or `check` stops between two steps once RUN.ms has passed,
 * well inside Convex's action time limit, and then answers `done: false`
 * with a `cursor`, a page of `run` and a place inside an organization and a
 * bucket of `check`. Call it again with the same arguments and `"cursor"`
 * set to it, unchanged, until `done` is true.
 *
 * A run reads each page in a query and writes only the rows that need it,
 * each read again by id in a small batch, so the rows of the current
 * period, which every call writes, stay out of its transactions. A page or
 * batch that fails ends the call with `error`, after the audit row of what
 * committed, and the `cursor` of the page to read again.
 *
 * After a run, `check` should report no unranked bucket and no difference.
 * It reads a bucket in several queries and lists it as unsettled when any of
 * its aggregates was written meanwhile (bucketRevision, a count that only
 * grows), as calls do in the current period, to check again later. It also
 * lists organizations that are gone but whose account rows or month totals
 * are left. Every path that deletes an organization deletes those
 * (model/orgDeletion.ts, model/cascade.ts deleteOrgDeep), so such an
 * organization points to a defect or a manual edit; nothing reads the rows.
 *
 * On the demo, whose stored key cannot run internal functions, the private
 * with-temp-deploy-key helper runs each command with a short-lived key:
 * `remaining` needs deployment:functions:runInternalQueries, and `run` and
 * `check`, internal actions, deployment:functions:runInternalActions. The
 * demo records no API calls, so it should have nothing to rank.
 *
 * A call of `run` that is not a dry run adds one platform_audit_log row
 * (action 'usage_ranks_backfill', actor 'system') with its counts. The
 * results hold counts and organization, profile and bucket ids only. Running
 * it again is safe, and a clean deployment reports zeros. It writes no
 * activity, sends no task event and changes nothing a person sees. The
 * Billing page still sums the usage rows. */
import { makeFunctionReference } from 'convex/server'
import { getDocumentSize, type Infer, v } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { MIB } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { audit as writeAudit } from '../model/admin'
import {
  bucketRevision,
  isMonthKey,
  periodCalls,
  usageRanked,
  writeUsageRow,
} from '../model/billingUsage'

/** Usage rows per page of the run and of the check's sums, the bytes one
 * query reads before it ends early, the rows one batch of the run writes,
 * the account rows and the documents one query of the check reads, the most
 * usage rows it reads for one account, and the most entries a check lists of
 * each kind. A usage row is a few hundred bytes, as its names are capped,
 * and an account or month row less. Ranking one writes the row, its account
 * row and at most one month shard or totals row after two index reads of
 * small rows. Every query and batch stays inside Convex's 4,096 index
 * ranges, 16,000 writes and 16 MiB read. Tests lower them. */
export const BACKFILL_PAGE = {
  rows: 500,
  bytes: 4 * MIB,
  batch: 50,
  accounts: 500,
  reads: 4_000,
  accountRows: 2_000,
  listed: 100,
}

/** Organizations one query of the gone-organization scan reads, and how long
 * one call of run or check goes on before it answers where to go on from.
 * Tests lower them. */
export const RUN = { orgs: 200, ms: 5 * 60_000 }

/* -------------------------------------------------------------------- run */

/** What one page found: how many rows a run writes, the calls that adds to
 * the aggregates, which rows those are, and where the next page starts. */
type PageResult = {
  rows: number
  calls: number
  stale: Id<'billing_usage'>[]
  cursor: string
  done: boolean
}

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

/* One page of billing_usage from `cursor`, read without writing: the rows
 * with no rank or one that differs, and the calls ranking them adds to the
 * aggregates. The check and the run share it, so both find the same rows.
 * The page is read in creation order, which a rank does not change, so the
 * cursor stays valid. */
async function walk(ctx: QueryCtx, cursor: string | null): Promise<PageResult> {
  const page = await ctx.db.query('billing_usage').paginate({
    cursor,
    numItems: BACKFILL_PAGE.rows,
    maximumBytesRead: BACKFILL_PAGE.bytes,
  })
  const stale: Id<'billing_usage'>[] = []
  let calls = 0
  for (const row of page.page) {
    const { counted, current } = rankOf(row)
    if (current) continue
    stale.push(row._id)
    calls += row.calls - counted
  }
  return { rows: stale.length, calls, stale, cursor: page.continueCursor, done: page.isDone }
}

/** One page of usage rows and the rows on it that need a rank (walk). */
export const scan = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<PageResult> => await walk(ctx, cursor),
})

/** Ranks each of the rows `ids`, reading it again, and answers how many it
 * wrote and the calls that added to the aggregates. A row gone, or ranked
 * since, is left alone. */
export const fix = internalMutation({
  args: { ids: v.array(v.id('billing_usage')) },
  handler: async (ctx, { ids }): Promise<{ rows: number; calls: number }> => {
    let rows = 0
    let calls = 0
    for (const id of ids) {
      const row = await ctx.db.get(id)
      if (row === null) continue
      const { counted, current } = rankOf(row)
      if (current) continue
      rows++
      calls += row.calls - counted
      await writeUsageRow(ctx, row, row, row.calls, row.credential_name)
    }
    return { rows, calls }
  },
})

/** Counts, without writing, the rows of one page that a run would rank.
 * Leave out `cursor`, or pass null, for the first page, then call again with
 * the returned `cursor` until `done`. */
export const remaining = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const { stale: _ids, ...counts } = await walk(ctx, cursor ?? null)
    return counts
  },
})

/** Records a call that was not a dry run, with its counts. */
export const audit = internalMutation({
  args: { rows: v.number(), calls: v.number() },
  handler: async (ctx, counts) => {
    await writeAudit(ctx, { actor_email: 'system', action: 'usage_ranks_backfill', detail: counts })
    return null
  },
})

const scanRef = makeFunctionReference<'query', { cursor: string | null }, PageResult>(
  'internal/usageRanksBackfill:scan',
)
const fixRef = makeFunctionReference<
  'mutation',
  { ids: Id<'billing_usage'>[] },
  { rows: number; calls: number }
>('internal/usageRanksBackfill:fix')
const auditRef = makeFunctionReference<'mutation', { rows: number; calls: number }, null>(
  'internal/usageRanksBackfill:audit',
)

/** Walks the usage rows from `cursor` on, or from the start, and reports
 * how many it ranked, or would rank, and the calls that added to the
 * aggregates. Between any two steps past RUN.ms, once it has written a
 * batch or read a page with nothing to write, it answers the `cursor` to go
 * on from, else `done`. A page or batch that fails ends the call with
 * `error` and the page to read again. A call that is not a dry run ends with
 * its audit row of what committed. */
export const run = internalAction({
  args: { dry_run: v.boolean(), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { dry_run, cursor: from }) => {
    const until = Date.now() + RUN.ms
    const counts = { rows: 0, calls: 0 }
    let cursor: string | null = from ?? null
    let next: string | null | undefined
    let error: string | null = null
    // Every call gets through one batch, or one page with nothing to write,
    // before it may stop, so each call moves the walk on.
    let progressed = false
    const late = () => progressed && Date.now() >= until
    walking: for (;;) {
      if (late()) {
        next = cursor
        break
      }
      try {
        const page: PageResult = await ctx.runQuery(scanRef, { cursor })
        if (dry_run) {
          counts.rows += page.rows
          counts.calls += page.calls
        }
        for (let i = 0; !dry_run && i < page.stale.length; i += BACKFILL_PAGE.batch) {
          if (late()) {
            next = cursor
            break walking
          }
          const ids = page.stale.slice(i, i + BACKFILL_PAGE.batch)
          const fixed = await ctx.runMutation(fixRef, { ids })
          counts.rows += fixed.rows
          counts.calls += fixed.calls
          progressed = true
        }
        progressed = true
        if (page.done) break
        cursor = page.cursor
      } catch (failure) {
        // what committed stays; the page is read again from its start
        error = failure instanceof Error ? failure.message : String(failure)
        next = cursor
        break
      }
    }
    if (!dry_run) await ctx.runMutation(auditRef, counts)
    return {
      dry_run,
      ...counts,
      done: next === undefined,
      cursor: next ?? null,
      ...(error === null ? {} : { error }),
    }
  },
})

/* ------------------------------------------------------------------ check */

/** A bucket's state: whether its rows are all ranked, its total as readers
 * will read it (periodCalls), a count of its aggregate writes that only
 * grows (bucketRevision), and, for a calendar month, whether a
 * billing_usage_totals row holds a total for it too. Releases v0.1.14 and
 * v0.1.15 counted calendar months there, and nothing has counted them there
 * since, so such a row holds only part of the month. */
const vBucketState = v.object({
  ranked: v.boolean(),
  total: v.union(v.number(), v.null()),
  revision: v.number(),
  month_total_row: v.boolean(),
})
type BucketState = Infer<typeof vBucketState>

/** The aggregate tables a gone organization's rows can be left in. */
const AGGREGATES = ['billing_usage_accounts', 'billing_month_totals'] as const
type Aggregate = (typeof AGGREGATES)[number]
const vAggregate = v.union(...AGGREGATES.map((table) => v.literal(table)))

/** Where a check goes on. `after_org` is the last organization it finished
 * and `org` the one under way, in id order, with `period`, the last of its
 * buckets finished, and `bucket`, the one under way, with its state when it
 * began and how far its sums of ranked usage rows and of account rows got.
 * `gone`, once every organization is checked, is the scan for gone
 * organizations' rows, by table and the last organization id read. */
const vCheckCursor = v.object({
  after_org: v.union(v.string(), v.null()),
  org: v.union(v.string(), v.null()),
  period: v.union(v.string(), v.null()),
  bucket: v.union(
    v.null(),
    v.object({
      period: v.string(),
      start: v.union(vBucketState, v.null()),
      rows_cursor: v.union(v.string(), v.null()),
      rows_calls: v.number(),
      rows_done: v.boolean(),
      accounts_after: v.union(v.string(), v.null()),
      accounts_calls: v.number(),
      accounts_done: v.boolean(),
    }),
  ),
  gone: v.union(v.null(), v.object({ table: vAggregate, after: v.union(v.string(), v.null()) })),
})
export type CheckCursor = Infer<typeof vCheckCursor>

/** The first organization after `after` in id order, or null. */
export const nextOrg = internalQuery({
  args: { after: v.union(v.string(), v.null()) },
  handler: async (ctx, { after }): Promise<string | null> => {
    const org = await ctx.db
      .query('organizations')
      .withIndex('by_uuid', (q) => (after === null ? q : q.gt('id', after)))
      .first()
    return org?.id ?? null
  },
})

/** The organization's first bucket key after `after` that its usage rows,
 * account rows or month totals name, or null. A bucket with aggregate rows
 * and no usage rows is checked too, so rows left there show as differences
 * from the rows they count, which are none. */
export const nextBucket = internalQuery({
  args: { org_id: v.string(), after: v.union(v.string(), v.null()) },
  handler: async (ctx, { org_id, after }): Promise<string | null> => {
    const firsts = await Promise.all([
      ctx.db
        .query('billing_usage')
        .withIndex('by_org_period', (q) =>
          after === null
            ? q.eq('org_id', org_id)
            : q.eq('org_id', org_id).gt('period_start', after),
        )
        .first(),
      ctx.db
        .query('billing_usage_accounts')
        .withIndex('by_org_period_profile', (q) =>
          after === null
            ? q.eq('org_id', org_id)
            : q.eq('org_id', org_id).gt('period_start', after),
        )
        .first(),
      ctx.db
        .query('billing_month_totals')
        .withIndex('by_org_period_shard', (q) =>
          after === null
            ? q.eq('org_id', org_id)
            : q.eq('org_id', org_id).gt('period_start', after),
        )
        .first(),
    ])
    // bucket keys are ASCII, so this order is the index order
    const keys = firsts.flatMap((row) => (row === null ? [] : [row.period_start])).sort()
    return keys[0] ?? null
  },
})

/** The bucket's state (BucketState). */
export const bucketState = internalQuery({
  args: { org_id: v.string(), period: v.string() },
  handler: async (ctx, { org_id, period }): Promise<BucketState> => ({
    ranked: await usageRanked(ctx, org_id, period),
    total: await periodCalls(ctx, org_id, period),
    revision: await bucketRevision(ctx, org_id, period),
    month_total_row:
      isMonthKey(period) &&
      (await ctx.db
        .query('billing_usage_totals')
        .withIndex('by_org_period', (q) => q.eq('org_id', org_id).eq('period_start', period))
        .first()) !== null,
  }),
})

/** One page of the bucket's usage rows: the calls of the ranked ones. */
export const rowsPage = internalQuery({
  args: { org_id: v.string(), period: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (
    ctx,
    { org_id, period, cursor },
  ): Promise<{ calls: number; cursor: string; done: boolean }> => {
    const page = await ctx.db
      .query('billing_usage')
      .withIndex('by_org_period', (q) => q.eq('org_id', org_id).eq('period_start', period))
      .paginate({ cursor, numItems: BACKFILL_PAGE.rows, maximumBytesRead: BACKFILL_PAGE.bytes })
    let calls = 0
    for (const row of page.page) if (row.neg_calls !== undefined) calls += row.calls
    return { calls, cursor: page.continueCursor, done: page.isDone }
  },
})

/** A bucket as the check lists it. */
type BucketRef = { org_id: string; period: string }

/** An account whose row differs from its ranked usage rows. */
type AccountDiff = BucketRef & { profile_id: string; stored: number; rows: number }

/** One page of a bucket's account rows (accountsPage). */
type AccountsPage = {
  calls: number
  differ: AccountDiff[]
  unchecked: (BucketRef & { profile_id: string })[]
  last: string | null
  done: boolean
}

/** The bucket's account rows after profile `after`, each compared in this
 * one transaction with the sum of its profile's ranked usage rows in the
 * bucket. It answers their calls together, those that differ, and those with
 * more than BACKFILL_PAGE.accountRows usage rows, which it leaves unchecked. It stops
 * after BACKFILL_PAGE.accounts accounts, or once the documents it read,
 * account and usage rows alike, reach BACKFILL_PAGE.reads or
 * BACKFILL_PAGE.bytes, and answers the last profile it checked. */
export const accountsPage = internalQuery({
  args: { org_id: v.string(), period: v.string(), after: v.union(v.string(), v.null()) },
  handler: async (ctx, { org_id, period, after }): Promise<AccountsPage> => {
    const page: AccountsPage = { calls: 0, differ: [], unchecked: [], last: after, done: false }
    let reads = 0
    let bytes = 0
    for (let accounts = 0; accounts < BACKFILL_PAGE.accounts; accounts++) {
      if (reads >= BACKFILL_PAGE.reads || bytes >= BACKFILL_PAGE.bytes) return page
      const from = page.last
      const account = await ctx.db
        .query('billing_usage_accounts')
        .withIndex('by_org_period_profile', (q) =>
          from === null
            ? q.eq('org_id', org_id).eq('period_start', period)
            : q.eq('org_id', org_id).eq('period_start', period).gt('profile_id', from),
        )
        .first()
      if (account === null) return { ...page, done: true }
      const rows = await ctx.db
        .query('billing_usage')
        .withIndex('by_org_period_profile_rank', (q) =>
          q.eq('org_id', org_id).eq('period_start', period).eq('profile_id', account.profile_id),
        )
        .take(BACKFILL_PAGE.accountRows + 1)
      reads += 1 + rows.length
      bytes += getDocumentSize(account)
      for (const row of rows) bytes += getDocumentSize(row)
      page.calls += account.calls
      page.last = account.profile_id
      const profile_id = account.profile_id
      if (rows.length > BACKFILL_PAGE.accountRows) {
        page.unchecked.push({ org_id, period, profile_id })
        continue
      }
      const counted = rows
        .filter((row) => row.neg_calls !== undefined)
        .reduce((sum, row) => sum + row.calls, 0)
      if (counted !== account.calls)
        page.differ.push({ org_id, period, profile_id, stored: account.calls, rows: counted })
    }
    return page
  },
})

/** Up to RUN.orgs organization ids after `after`, in id order, that rows of
 * aggregate `table` name although the organization is gone, two or three
 * indexed reads each, and the last id read, or null once the table has no
 * more. An organization that also has account rows is answered only for
 * billing_usage_accounts, so the two scans never count one twice. */
export const goneOrgs = internalQuery({
  args: { table: vAggregate, after: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, after }): Promise<{ gone: string[]; last: string | null }> => {
    const gone: string[] = []
    let last = after
    for (let read = 0; read < RUN.orgs; read++) {
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
      last = next.org_id
      if ((await byId(ctx, 'organizations', next.org_id)) !== null) continue
      const counted =
        table === 'billing_month_totals' &&
        (await ctx.db
          .query('billing_usage_accounts')
          .withIndex('by_org_period_profile', (q) => q.eq('org_id', next.org_id))
          .first()) !== null
      if (!counted) gone.push(next.org_id)
    }
    return { gone, last }
  },
})

const nextOrgRef = makeFunctionReference<'query', { after: string | null }, string | null>(
  'internal/usageRanksBackfill:nextOrg',
)
const nextBucketRef = makeFunctionReference<
  'query',
  { org_id: string; after: string | null },
  string | null
>('internal/usageRanksBackfill:nextBucket')
const bucketStateRef = makeFunctionReference<
  'query',
  { org_id: string; period: string },
  BucketState
>('internal/usageRanksBackfill:bucketState')
const rowsPageRef = makeFunctionReference<
  'query',
  { org_id: string; period: string; cursor: string | null },
  { calls: number; cursor: string; done: boolean }
>('internal/usageRanksBackfill:rowsPage')
const accountsPageRef = makeFunctionReference<
  'query',
  { org_id: string; period: string; after: string | null },
  AccountsPage
>('internal/usageRanksBackfill:accountsPage')
const goneOrgsRef = makeFunctionReference<
  'query',
  { table: Aggregate; after: string | null },
  { gone: string[]; last: string | null }
>('internal/usageRanksBackfill:goneOrgs')

/** Checks every usage bucket of every organization from `cursor` on, and
 * writes nothing. A bucket is any period that usage rows, account rows or
 * month totals name (nextBucket), so aggregate rows left in a period
 * without usage rows show as differences. A bucket with an unranked row is
 * only counted
 * (`unranked`), since its aggregates are not complete until a run. For every
 * other bucket it lists the account rows whose calls differ from their
 * ranked usage rows (`differing_account_rows`), each compared in one
 * transaction, and those it could not compare in one
 * (`unchecked_account_rows`). It lists the buckets whose total, a month's
 * shards or another bucket's billing_usage_totals row, differs from the sum
 * of their account rows or of their usage rows (`differing_total_buckets`),
 * unless an aggregate of the bucket was written while it read them; it then
 * lists the bucket as unsettled (`unsettled_buckets`) instead. It also lists
 * the calendar months that hold a total in billing_usage_totals from
 * releases v0.1.14 and v0.1.15 (`month_total_buckets`), which nothing here
 * reads, and the gone organizations whose aggregate rows are left
 * (`gone_org_ids`). Each list holds at most BACKFILL_PAGE.listed entries,
 * and the counts cover all. Between any two queries past RUN.ms it answers
 * the `cursor` to go on from, else `done`. */
export const check = internalAction({
  args: { cursor: v.optional(v.union(vCheckCursor, v.null())) },
  handler: async (ctx, { cursor: from }) => {
    const until = Date.now() + RUN.ms
    const counts = {
      orgs: 0,
      buckets: 0,
      unranked: 0,
      differing_accounts: 0,
      unchecked_accounts: 0,
      differing_totals: 0,
      unsettled: 0,
      month_total_rows: 0,
      gone_orgs: 0,
    }
    const lists = {
      differing_account_rows: [] as AccountDiff[],
      unchecked_account_rows: [] as (BucketRef & { profile_id: string })[],
      differing_total_buckets: [] as (BucketRef & {
        total: number | null
        accounts: number
        rows: number
      })[],
      unsettled_buckets: [] as BucketRef[],
      month_total_buckets: [] as BucketRef[],
      gone_org_ids: [] as string[],
    }
    const listed = <T>(entries: T[], entry: T) => {
      if (entries.length < BACKFILL_PAGE.listed) entries.push(entry)
    }
    const state: CheckCursor = from ?? {
      after_org: null,
      org: null,
      period: null,
      bucket: null,
      gone: null,
    }
    let stepped = false
    // One query a turn, so no call outruns RUN.ms by more than one query.
    for (; ; stepped = true) {
      // every call gets through at least one query
      if (stepped && Date.now() >= until) return { ...counts, ...lists, done: false, cursor: state }
      if (state.gone !== null) {
        const { table, after } = state.gone
        const page = await ctx.runQuery(goneOrgsRef, { table, after })
        for (const org_id of page.gone) {
          counts.gone_orgs++
          listed(lists.gone_org_ids, org_id)
        }
        if (page.last !== null) state.gone = { table, after: page.last }
        else {
          const nextTable = AGGREGATES[AGGREGATES.indexOf(table) + 1]
          if (nextTable === undefined) return { ...counts, ...lists, done: true, cursor: null }
          state.gone = { table: nextTable, after: null }
        }
        continue
      }
      if (state.org === null) {
        const org = await ctx.runQuery(nextOrgRef, { after: state.after_org })
        if (org === null) state.gone = { table: AGGREGATES[0], after: null }
        else {
          counts.orgs++
          Object.assign(state, { org, period: null, bucket: null })
        }
        continue
      }
      const org_id = state.org
      const bucket = state.bucket
      if (bucket === null) {
        const period = await ctx.runQuery(nextBucketRef, { org_id, after: state.period })
        if (period === null) Object.assign(state, { after_org: org_id, org: null })
        else {
          counts.buckets++
          state.bucket = {
            period,
            start: null,
            rows_cursor: null,
            rows_calls: 0,
            rows_done: false,
            accounts_after: null,
            accounts_calls: 0,
            accounts_done: false,
          }
        }
        continue
      }
      const { period } = bucket
      const ref = { org_id, period }
      const finish = () => Object.assign(state, { period, bucket: null })
      if (bucket.start === null) {
        const start = await ctx.runQuery(bucketStateRef, ref)
        if (start.month_total_row) {
          counts.month_total_rows++
          listed(lists.month_total_buckets, ref)
        }
        if (start.ranked) bucket.start = start
        else {
          counts.unranked++
          finish()
        }
        continue
      }
      if (!bucket.rows_done) {
        const page = await ctx.runQuery(rowsPageRef, { ...ref, cursor: bucket.rows_cursor })
        bucket.rows_calls += page.calls
        bucket.rows_cursor = page.cursor
        bucket.rows_done = page.done
        continue
      }
      if (!bucket.accounts_done) {
        const page = await ctx.runQuery(accountsPageRef, { ...ref, after: bucket.accounts_after })
        bucket.accounts_calls += page.calls
        bucket.accounts_after = page.last
        bucket.accounts_done = page.done
        for (const diff of page.differ) {
          counts.differing_accounts++
          listed(lists.differing_account_rows, diff)
        }
        for (const account of page.unchecked) {
          counts.unchecked_accounts++
          listed(lists.unchecked_account_rows, account)
        }
        continue
      }
      // The sums came from several queries, so they hold only if no
      // aggregate of the bucket was written since it began.
      const end = await ctx.runQuery(bucketStateRef, ref)
      if (end.revision !== bucket.start.revision || !end.ranked) {
        counts.unsettled++
        listed(lists.unsettled_buckets, ref)
      } else if (end.total !== bucket.accounts_calls || end.total !== bucket.rows_calls) {
        counts.differing_totals++
        listed(lists.differing_total_buckets, {
          ...ref,
          total: end.total,
          accounts: bucket.accounts_calls,
          rows: bucket.rows_calls,
        })
      }
      finish()
    }
  },
})

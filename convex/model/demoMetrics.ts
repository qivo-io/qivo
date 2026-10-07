/* Deployment-only counters contain no visitor identity or workspace data.
 * Every creation count and its receipt marker commit in the same transaction.
 * JSON sizes estimate application documents, not Convex's billed indexes/auth. */
import { convexToJson, type Value } from 'convex/values'
import type { Doc, Id, TableNames } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { DEMO_MAX_SESSIONS, isDemoDeployment } from '../lib/demo'
import type { DemoMetricsReport } from '../lib/demoMetricsReport'
import schema from '../schema'

declare class TextEncoder {
  encode(input: string): Uint8Array
}

export const METRICS_KEY = 'demo'
export const METRICS_DAYS = 800
const DAY_MS = 86_400_000

// Discover newly added application tables automatically. Auth component and
// Convex system tables are separate databases and intentionally excluded.
export const DEMO_STORAGE_TABLES = (Object.keys(schema.tables) as TableNames[])
  .filter((table) => table !== 'demo_metrics_scans')
  .sort()

export const utcDate = (at: number) => new Date(at).toISOString().slice(0, 10)
export const retainedSince = (now: number) => utcDate(now - (METRICS_DAYS - 1) * DAY_MS)
export const estimateDocumentBytes = (doc: unknown): number =>
  new TextEncoder().encode(JSON.stringify(convexToJson(doc as Value))).length

export async function ensureDemoMetrics(ctx: MutationCtx) {
  const existing = await ctx.db
    .query('demo_metrics')
    .withIndex('by_key', (q) => q.eq('key', METRICS_KEY))
    .unique()
  if (existing) return existing
  const id = await ctx.db.insert('demo_metrics', {
    key: METRICS_KEY,
    tracking_started_at: Date.now(),
    total_created: 0,
  })
  const created = await ctx.db.get(id)
  if (!created) throw new Error('Demo metrics initialization failed')
  return created
}

async function daily(ctx: MutationCtx, date: string): Promise<Doc<'demo_metrics_daily'>> {
  const existing = await ctx.db
    .query('demo_metrics_daily')
    .withIndex('by_date', (q) => q.eq('date', date))
    .unique()
  if (existing) return existing
  const id = await ctx.db.insert('demo_metrics_daily', {
    date,
    created: 0,
    samples: 0,
    database_bytes_sum: 0,
    file_bytes_sum: 0,
  })
  const created = await ctx.db.get(id)
  if (!created) throw new Error('Demo metrics day initialization failed')
  return created
}

function incrementAudience(
  counts: Record<string, number> | undefined,
  name: string,
  previousTotal: number,
  unknown: string,
): Record<string, number> {
  const next = { ...(counts ?? (previousTotal ? { [unknown]: previousTotal } : {})) }
  next[name] = (Object.hasOwn(next, name) ? next[name] : 0) + 1
  return next
}

function audienceRows(counts: Record<string, number> | undefined, total: number, unknown: string) {
  return Object.entries(counts ?? (total ? { [unknown]: total } : {}))
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

function audienceSummary(buckets: Doc<'demo_metrics_daily'>[], since: string) {
  const browsers: Record<string, number> = {}
  const operatingSystems: Record<string, number> = {}
  const countries: Record<string, number> = {}
  const add = (target: Record<string, number>, values: { name: string; count: number }[]) => {
    for (const { name, count } of values)
      target[name] = (Object.hasOwn(target, name) ? target[name] : 0) + count
  }
  for (const row of buckets) {
    if (row.date < since) continue
    add(browsers, audienceRows(row.browsers, row.created, 'Unknown'))
    add(operatingSystems, audienceRows(row.operating_systems, row.created, 'Unknown'))
    add(countries, audienceRows(row.countries, row.created, 'ZZ'))
  }
  return {
    browsers: audienceRows(browsers, 0, 'Unknown'),
    operatingSystems: audienceRows(operatingSystems, 0, 'Unknown'),
    countries: audienceRows(countries, 0, 'ZZ'),
  }
}

/** Also used before purge so old ready receipts cannot disappear uncounted.
 * Re-read the receipt: retries with a stale caller snapshot stay idempotent. */
export async function recordDemoCreated(
  ctx: MutationCtx,
  receiptId: Id<'demo_sessions'>,
  provisionedAt?: number,
): Promise<void> {
  if (!isDemoDeployment()) return
  const receipt = await ctx.db.get(receiptId)
  if (
    !receipt ||
    receipt.metrics_counted_at !== undefined ||
    !receipt.org_id ||
    receipt.seed_version === undefined ||
    receipt.status === 'unprovisioned'
  )
    return
  const summary = await ensureDemoMetrics(ctx)
  const org = provisionedAt === undefined ? await byId(ctx, 'organizations', receipt.org_id) : null
  const createdAt = provisionedAt ?? (org ? Date.parse(org.created_at) : receipt.created_at)
  const date = utcDate(Number.isFinite(createdAt) ? createdAt : receipt.created_at)
  await ctx.db.patch(summary._id, { total_created: summary.total_created + 1 })
  if (date >= retainedSince(Date.now())) {
    const bucket = await daily(ctx, date)
    await ctx.db.patch(bucket._id, {
      created: bucket.created + 1,
      browsers: incrementAudience(
        bucket.browsers,
        receipt.visitor_browser ?? 'Unknown',
        bucket.created,
        'Unknown',
      ),
      operating_systems: incrementAudience(
        bucket.operating_systems,
        receipt.visitor_os ?? 'Unknown',
        bucket.created,
        'Unknown',
      ),
      countries: incrementAudience(
        bucket.countries,
        receipt.visitor_country ?? 'ZZ',
        bucket.created,
        'ZZ',
      ),
    })
  }
  await ctx.db.patch(receipt._id, { metrics_counted_at: Date.now() })
}

export async function recordStorageSample(
  ctx: MutationCtx,
  databaseBytes: number,
  fileBytes: number,
): Promise<void> {
  const now = Date.now()
  const summary = await ensureDemoMetrics(ctx)
  await ctx.db.patch(summary._id, {
    sampled_at: now,
    database_bytes: databaseBytes,
    file_bytes: fileBytes,
  })
  const bucket = await daily(ctx, utcDate(now))
  await ctx.db.patch(bucket._id, {
    samples: bucket.samples + 1,
    database_bytes_sum: bucket.database_bytes_sum + databaseBytes,
    file_bytes_sum: bucket.file_bytes_sum + fileBytes,
  })
  // Bounded retention work. Lifetime totals remain even after daily expiry.
  const expired = await ctx.db
    .query('demo_metrics_daily')
    .withIndex('by_date', (q) => q.lt('date', retainedSince(now)))
    .take(32)
  for (const row of expired) await ctx.db.delete(row._id)
}

export async function demoMetricsSnapshot(ctx: QueryCtx): Promise<DemoMetricsReport> {
  const now = Date.now()
  const summary = await ctx.db
    .query('demo_metrics')
    .withIndex('by_key', (q) => q.eq('key', METRICS_KEY))
    .unique()
  const buckets = await ctx.db
    .query('demo_metrics_daily')
    .withIndex('by_date', (q) => q.gte('date', retainedSince(now)).lte('date', utcDate(now)))
    .take(METRICS_DAYS)
  // Admission transactionally caps all receipts, including abandoned/deleting,
  // at 500. This bounded read can therefore report exact current counts.
  const receipts = await ctx.db.query('demo_sessions').take(DEMO_MAX_SESSIONS)
  const today = new Date(now)
  const yearStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1)
  return {
    version: 1,
    generatedAt: now,
    trackingStartedAt: summary?.tracking_started_at ?? null,
    historyCompleteSince: summary
      ? Math.max(summary.tracking_started_at, Date.parse(`${retainedSince(now)}T00:00:00Z`))
      : null,
    totalCreated: summary?.total_created ?? 0,
    active: receipts.filter((r) => r.status === 'ready' && r.expires_at > now).length,
    deleting: receipts.filter((r) => r.status === 'deleting' && r.org_id !== undefined).length,
    counts: buckets.map((row) => ({ date: row.date, created: row.created })),
    audience: {
      last7Days: audienceSummary(buckets, utcDate(now - 6 * DAY_MS)),
      last30Days: audienceSummary(buckets, utcDate(now - 29 * DAY_MS)),
      last12Months: audienceSummary(buckets, utcDate(yearStart)),
    },
    storage:
      summary?.sampled_at !== undefined
        ? {
            sampledAt: summary.sampled_at,
            databaseBytes: summary.database_bytes ?? 0,
            fileBytes: summary.file_bytes ?? 0,
          }
        : null,
    storageDaily: buckets
      .filter((row) => row.samples > 0)
      .map((row) => ({
        date: row.date,
        samples: row.samples,
        databaseBytesSum: row.database_bytes_sum,
        fileBytesSum: row.file_bytes_sum,
      })),
  }
}

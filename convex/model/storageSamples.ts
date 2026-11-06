/* Sizes and reads of the daily storage samples (schema.ts
 * storage_daily_samples and storage_sample_runs), which storageSamples.ts
 * records once a UTC day from each counted organization's stored-byte
 * totals (model/storageTotals.ts). A sample is an actual reading only, so
 * an organization and day without one has no reading, never a zero. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { utcDate } from './demoMetrics'
import { DAY_MS } from './orgRetention'

/** How many organizations one step of a day's run reads, after the run's
 * cursor in id order. Each costs the same reads whatever it stores, its
 * removal, its totals row, its sample of the day and its sample of the
 * latest day, and at most one write. A step stays far inside one
 * transaction's limits, and a page this small keeps a step cheap to run
 * again when an attach in one of its organizations commits while it reads
 * that organization's totals. One step over 100 organizations, each
 * counted with no sample that day, read 202 documents over 402 index
 * ranges, about 49 KB, and wrote 101 documents, the samples and the run
 * row, in convex/tests/storageSamples.test.ts ("reads at the batch size");
 * the same step again with every sample present, as a retry, read 302
 * documents over 302 ranges, about 72 KB, and wrote the run row only.
 * Tests lower it. */
export const SAMPLE_PAGE = { orgs: 100 }

/** How long a day's run may go without a step before the hourly tick
 * resumes it under a new run id. A step runs in well under a second, so
 * only a run whose step failed or was lost waits this long. A tick counts a
 * run as stalled this long after its last step and ticks once an hour, so
 * a stall delays the rest of the day's samples by at most about 75 minutes
 * within the run's UTC day. A tick never resumes an earlier day's run, so a
 * run that stalls with its last step after 23:05 UTC stays unfinished, and
 * its remaining organizations have no sample that day. */
export const SAMPLE_STALLED_MS = 15 * 60_000

/** How many samples, and how many run rows, one expiry step deletes at
 * most, so a step stays small however many days fall out at once, such as
 * after the job was stopped for a while. Tests lower it. */
export const SAMPLE_EXPIRY = { page: 200 }

/** How many UTC days samples and run rows are kept, today included. That
 * is more than a year, so the owner can read a year of history and any
 * monthly period can fall back to a reading from the period before it.
 * About 400 rows an organization at the retention, each about 230 bytes as
 * Convex sizes a document (storageSamples.test.ts), about 90 KB. */
export const SAMPLE_RETENTION_DAYS = 400

/** A run's counters (schema.ts storage_sample_runs `counts`). */
export type SampleCounts = Doc<'storage_sample_runs'>['counts']

/** The counters of a run that has done nothing yet. */
export const NO_COUNTS: SampleCounts = {
  steps: 0,
  restarts: 0,
  orgs: 0,
  written: 0,
  present: 0,
  uncounted: 0,
  deleting: 0,
  failed: 0,
  revisions: 0,
  expired: 0,
  expiry_steps: 0,
  documents_read: 0,
  documents_written: 0,
  bytes_read: 0,
  bytes_written: 0,
  database_queries: 0,
}

/** `counts` with `more` added, counter by counter. */
export function addCounts(counts: SampleCounts, more: Partial<SampleCounts>): SampleCounts {
  const sum = { ...counts }
  for (const key of Object.keys(sum) as (keyof SampleCounts)[]) sum[key] += more[key] ?? 0
  return sum
}

/** The first UTC day kept at `now`; samples and run rows of days before it
 * go (storageSamples.ts expire). */
export const keptSince = (now: number) => utcDate(now - (SAMPLE_RETENTION_DAYS - 1) * DAY_MS)

/** The run row of UTC day `day` (YYYY-MM-DD), or null. */
export const runOf = (ctx: QueryCtx, day: string) =>
  ctx.db
    .query('storage_sample_runs')
    .withIndex('by_day', (q) => q.eq('day', day))
    .unique()

/** Organization `orgId`'s sample of UTC day `day`, or null. */
export const sampleOf = (ctx: QueryCtx, orgId: string, day: string) =>
  ctx.db
    .query('storage_daily_samples')
    .withIndex('by_org_day', (q) => q.eq('org_id', orgId).eq('day', day))
    .first()

/** Organization `orgId`'s sample of the latest day, or null when it has
 * none. One indexed read. */
export const latestSample = (ctx: QueryCtx, orgId: string) =>
  ctx.db
    .query('storage_daily_samples')
    .withIndex('by_org_day', (q) => q.eq('org_id', orgId))
    .order('desc')
    .first()

/** One day of storageSamples.costReport: its run's start, its end or null
 * while it has not finished, and its counters. */
export type DayCost = {
  day: string
  started_at: number
  finished_at: number | null
  counts: SampleCounts
}

/** What storageSamples.costReport answers for the UTC days `from` to `to`,
 * both included: `days_in_range`, the hourly ticks the range implies (24 a
 * day, each one indexed read of at most one run row and no write after the
 * day's first), the runs found and finished, each run's day and the sums of
 * their counters. It names no organization. */
export type CostReport = {
  from: string
  to: string
  days_in_range: number
  ticks: number
  runs: number
  finished: number
  total: SampleCounts
  days: DayCost[]
}

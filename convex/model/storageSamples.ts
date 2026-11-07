/* Sizes and reads of the daily storage samples (schema.ts
 * storage_daily_samples and storage_sample_runs), which storageSamples.ts
 * records once a UTC day from each counted organization's stored-byte
 * totals (model/storageTotals.ts). A sample is an actual reading only, so
 * an organization and day without one has no reading, never a zero. A paid
 * period on the daily basis averages its days' samples by the owner's rules
 * for missing days and the cutoff (periodAverage, billingSync.ts
 * finalizeStorage). */

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
 * is more than a year, so the owner can read a year of history and a
 * monthly period on the daily basis can fall back at its cutoff to a
 * reading from a period before it (sampleBefore).
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

/** An actual reading of organization storage for UTC day `day`, from its
 * sample. */
export type DayReading = { day: string; bytes: number }

/** Organization `orgId`'s first sample of a day after `day`, or null. One
 * indexed read. */
export const sampleAfter = (ctx: QueryCtx, orgId: string, day: string) =>
  ctx.db
    .query('storage_daily_samples')
    .withIndex('by_org_day', (q) => q.eq('org_id', orgId).gt('day', day))
    .first()

/** Organization `orgId`'s latest sample of a day before `day`, or null. One
 * indexed read, which reaches back as far as samples are kept
 * (SAMPLE_RETENTION_DAYS). */
export const sampleBefore = (ctx: QueryCtx, orgId: string, day: string) =>
  ctx.db
    .query('storage_daily_samples')
    .withIndex('by_org_day', (q) => q.eq('org_id', orgId).lt('day', day))
    .order('desc')
    .first()

/** Organization `orgId`'s samples of the UTC days `first` to `last`, both
 * included, as bytes by day. One index range of at most one row a day. */
export async function samplesOfDays(
  ctx: QueryCtx,
  orgId: string,
  first: string,
  last: string,
): Promise<Map<string, number>> {
  const rows = await ctx.db
    .query('storage_daily_samples')
    .withIndex('by_org_day', (q) => q.eq('org_id', orgId).gte('day', first).lte('day', last))
    .collect()
  return new Map(rows.map((row) => [row.day, row.bytes]))
}

/* The UTC midnight at or before ISO time `iso`, epoch milliseconds. */
const midnight = (iso: string) => Math.floor(Date.parse(iso) / DAY_MS) * DAY_MS

/** The UTC dates (YYYY-MM-DD) a daily period from `start` to `end`, ISO
 * times, averages, from its start's date up to the day before its end's
 * date, and at least the start's date. Consecutive periods of a
 * subscription share their boundary, so when they cross a UTC midnight
 * each date belongs to exactly one of them and none is skipped, and a
 * period's last date ends at or before its end, its last full UTC day. A
 * period that starts and ends on one date, which only a period Polar cut
 * short could, gets that date, which the next period starts on too. A
 * monthly period has 28 to 31, and a plan's product renews monthly
 * (lib/polar.ts validatePolarProduct). The first date's sample can come
 * from before the period began that day, which daily sampling's
 * approximation of time in storage allows. */
export function periodDays(start: string, end: string): string[] {
  const days: string[] = []
  for (let at = midnight(start); at < midnight(end); at += DAY_MS) days.push(utcDate(at))
  return days.length > 0 ? days : [utcDate(midnight(start))]
}

/** One day of a daily period's record (schema.ts billing_periods
 * storage_days), with the reading the average used, absent while the day
 * is unresolved, and for an estimate the day of the actual sample it
 * copied. */
export type StorageDay = { day: string; bytes?: number; from?: string }

/** What periodAverage answers, each day's entry for the record, how many
 * days were measured by their own sample, estimated from another day's
 * (`estimated`, of them `estimated_earlier` from an earlier day at the
 * cutoff) and left unresolved, and the average of the resolved days
 * rounded up to a whole byte, or null when none resolved. */
export type PeriodAverage = {
  days: StorageDay[]
  measured: number
  estimated: number
  estimated_earlier: number
  unresolved: number
  bytes: number | null
}

/* The mean of `values`, whole numbers of bytes, rounded up to a whole byte.
 * The sum is a BigInt, so the division is exact at any size, and the
 * quotient is checked against the sum, never taken from a float. */
function ceilAverage(values: readonly number[]): number {
  const n = BigInt(values.length)
  const sum = values.reduce((total, bytes) => total + BigInt(bytes), 0n)
  const whole = sum / n
  return Number(whole * n === sum ? whole : whole + 1n)
}

/** The average of a daily period's `days` (periodDays) from `readings`, the
 * organization's actual samples of those days by day, by the owner's rules
 * of 25 October 2026 (the limits plan's "Missing daily measurements" and
 * "Billing cutoff"). A day with its own reading is measured, a reading of
 * 0 bytes included. A day without one takes the first later actual
 * reading, of a later day of the period or `later`, the organization's
 * first sample after the period's last day, and records its day in
 * `from`; consecutive missing days take the same one, each counted once in
 * the average. Without `final` a day with no later reading stays
 * unresolved and out of the average, never 0, an earlier reading or an
 * average of the others. With `final`, at the cutoff, such a day takes the
 * most recent actual reading before it, a measured day of the period or
 * `earlier`, the organization's latest sample before the period's first
 * day, which can be an earlier period's. No source is ever another
 * estimate. With `final` every day resolves, or none when the organization
 * has no reading in, after or before the period. The average is rounded up
 * to a whole byte with integer arithmetic. That changes no block, since
 * the allowance A is a whole number of bytes (model/billing.ts
 * validatePlan keeps its settings whole) and GB is one too, so for any
 * average y, ceil(max(0, ceil(y) - A) / GB) equals
 * ceil(max(0, y - A) / GB). */
export function periodAverage(
  days: readonly string[],
  readings: ReadonlyMap<string, number>,
  {
    later = null,
    earlier = null,
    final,
  }: { later?: DayReading | null; earlier?: DayReading | null; final: boolean },
): PeriodAverage {
  const entries: StorageDay[] = days.map((day) => ({ day }))
  let next = later
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i]
    const bytes = readings.get(day)
    if (bytes !== undefined) {
      entries[i] = { day, bytes }
      next = { day, bytes }
    } else if (next !== null) entries[i] = { day, bytes: next.bytes, from: next.day }
  }
  if (final) {
    let last = earlier
    for (const [i, day] of days.entries()) {
      const bytes = readings.get(day)
      if (bytes !== undefined) last = { day, bytes }
      else if (entries[i].bytes === undefined && last !== null)
        entries[i] = { day, bytes: last.bytes, from: last.day }
    }
  }
  const resolved = entries.flatMap((entry) => (entry.bytes === undefined ? [] : [entry.bytes]))
  const estimates = entries.filter((entry) => entry.from !== undefined)
  return {
    days: entries,
    measured: resolved.length - estimates.length,
    estimated: estimates.length,
    estimated_earlier: estimates.filter((entry) => (entry.from ?? '') < entry.day).length,
    unresolved: entries.length - resolved.length,
    bytes: resolved.length === 0 ? null : ceilAverage(resolved),
  }
}

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
 * day, each one indexed read of at most one run row, and while billing is
 * on one more of at most one open daily period, none of it in the
 * counters; the day's first also writes the run row, and each one that
 * resumes the run, counted in `restarts`, reads and writes it again), the
 * runs found and finished, each run's day and the sums of their counters.
 * It names no organization. */
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

/* The daily storage samples. Once each UTC day a run records every counted
 * organization's stored-byte totals (model/storageTotals.ts), files in
 * Deleted items included, as one storage_daily_samples row an
 * organization, in steps of SAMPLE_PAGE.orgs organizations in id order. It
 * reads only each organization's totals row, never an attachment row, and
 * bills nothing. The samples are what a daily storage charge would
 * average, and the run rows say what recording them costs.
 *
 * The hourly cron (crons.ts 'storage-daily-samples', minute 20) calls tick.
 * The day's first tick starts its run; a later one resumes the run under a
 * new id when its last step is SAMPLE_STALLED_MS old, and otherwise reads
 * one row and writes nothing. A tick never resumes an earlier day's run.
 * Each step reads its page of organizations and, for each, its removal,
 * its totals row and its samples. It writes nothing for an organization
 * whose deletion has begun or whose totals are not complete, as before the
 * backfill counted it or while a recount runs, and writes at most one
 * sample per organization and day. An organization whose reads fail is
 * logged with its id and the error's name and counted in `failed`, and the
 * step goes on with the others. A step with a full page schedules the next
 * in its own transaction; the step after the last organization marks the
 * run finished, clears its cursor and starts the expiry of rows older than
 * SAMPLE_RETENTION_DAYS (expire). Each step adds its counters and what
 * Convex measured of its transaction to the run row, which costReport
 * answers for a range of days.
 *
 * A step reads organizations' totals rows, which every attach, removal,
 * move, rename and purge writes, so such a write that commits while a step
 * reads reruns the step, never the write, which reads nothing the job
 * writes. Two runs of one day that meet on an organization both read its
 * sample of the day, so Convex commits one insert and reruns the other,
 * which then finds it present. The job writes only its own two tables, does
 * nothing on the demo deployment, and a branch preview registers no cron.
 *
 * The cost reading on staging, a hosted read that needs the owner's
 * approval, with the private helper:
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment" \
 *     staging npx convex run storageSamples:costReport '{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}'
 * docs/deployment.md says how its sums become calls, reads, writes and
 * retained rows per organization and day. */

import { makeFunctionReference } from 'convex/server'
import { getDocumentSize, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server'
import { deletionBegun } from './lib/billingAccess'
import { isDemoDeployment } from './lib/demo'
import { badRequest, require } from './lib/functions'
import { utcDate } from './model/demoMetrics'
import { DAY_MS } from './model/orgRetention'
import { newUuid } from './model/orgs'
import {
  addCounts,
  type CostReport,
  keptSince,
  latestSample,
  NO_COUNTS,
  runOf,
  SAMPLE_EXPIRY,
  SAMPLE_PAGE,
  SAMPLE_STALLED_MS,
  type SampleCounts,
  sampleOf,
} from './model/storageSamples'
import { orgTotalsRow } from './model/storageTotals'

const stepRef = makeFunctionReference<'mutation', { day: string; run: string }, null>(
  'storageSamples:step',
)
const expireRef = makeFunctionReference<'mutation', { day: string }, null>('storageSamples:expire')

/** Starts today's run of the daily storage samples once, by the UTC date,
 * or resumes it from its cursor under a new run id when its last step is
 * SAMPLE_STALLED_MS old, so a step of the earlier run stops at its run
 * check. Does nothing once the day's run finished, while its steps go on,
 * and on the demo deployment. Such a call reads one row and writes none.
 * It never goes back to an earlier day's run, which keeps the samples it
 * wrote and, unfinished, its cursor until the row expires. The hourly cron
 * calls it. */
export const tick = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    if (isDemoDeployment()) return null
    const now = Date.now()
    const day = utcDate(now)
    const row = await runOf(ctx, day)
    if (row !== null && (row.finished_at !== undefined || now - row.step_at < SAMPLE_STALLED_MS))
      return null
    const run = newUuid()
    if (row === null)
      await ctx.db.insert('storage_sample_runs', {
        day,
        run,
        cursor: null,
        started_at: now,
        step_at: now,
        counts: NO_COUNTS,
      })
    else {
      console.warn('[storage samples] run stalled; resuming it', {
        day,
        stalled_ms: now - row.step_at,
      })
      await ctx.db.patch(row._id, {
        run,
        step_at: now,
        counts: addCounts(row.counts, { restarts: 1 }),
      })
    }
    await ctx.scheduler.runAfter(0, stepRef, { day, run })
    return null
  },
})

/* What sampling one organization added to a step's counters. */
type Tally = Partial<SampleCounts>

/* Samples organization `orgId` for `day` in run `run` at `at`, unless its
 * deletion has begun, its totals are not complete or it has the day's
 * sample already. Reads its removal, its totals row, its sample of the day
 * and its sample of the latest day, and inserts at most one row. Its
 * `revisions` are the totals' revisions since that latest sample, so each
 * write counts once. There are none for a first sample, for a totals row a
 * recount replaced since, or for a sample a late run takes after a later
 * day's sample, since that one counted the writes up to its own reading
 * and the next sample counts from it. */
async function sampleOrg(
  ctx: MutationCtx,
  orgId: string,
  day: string,
  run: string,
  at: number,
): Promise<Tally> {
  if (await deletionBegun(ctx, orgId)) return { deleting: 1 }
  const totals = await orgTotalsRow(ctx, orgId)
  if (totals === null || totals.counting !== undefined) return { uncounted: 1 }
  if ((await sampleOf(ctx, orgId, day)) !== null) return { present: 1 }
  const before = await latestSample(ctx, orgId)
  await ctx.db.insert('storage_daily_samples', {
    org_id: orgId,
    day,
    bytes: totals.bytes,
    files: totals.files,
    revision: totals.revision,
    at,
    run,
  })
  // A recount deletes the totals row and counts the organization again in a
  // new one from revision 0, so a row created after the previous sample adds
  // nothing, whatever revision its count ended at. The two creation times
  // follow the order Convex inserted the rows in, which `at` could tie. A
  // later day's run took any sample of a later day before this one, so this
  // late one adds nothing either.
  const recounted = before !== null && totals._creationTime > before._creationTime
  const grows = before !== null && !recounted && before.day < day
  const grown = grows ? totals.revision - before.revision : 0
  return { written: 1, revisions: Math.max(0, grown) }
}

/* Adds `tally` and what Convex measured of this transaction to run row
 * `row`, as this transaction read it last, and writes it with `patch`. The
 * metrics are read before that patch, so the patch's own work is added as
 * Convex measures it, one read of the row as it was and one write of the
 * row as it becomes. */
async function record(
  ctx: MutationCtx,
  row: Doc<'storage_sample_runs'>,
  tally: Tally,
  patch: Partial<Doc<'storage_sample_runs'>> = {},
): Promise<void> {
  const m = await ctx.meta.getTransactionMetrics()
  const measured = {
    ...tally,
    documents_read: m.documentsRead.used + 1,
    documents_written: m.documentsWritten.used + 1,
    bytes_read: m.bytesRead.used + getDocumentSize(row),
    bytes_written: m.bytesWritten.used,
    database_queries: m.databaseQueries.used,
  }
  // numbers are stored at a fixed size, so the row's size does not depend
  // on the counters' values
  const next = { ...row, ...patch, counts: addCounts(row.counts, measured) }
  next.counts.bytes_written += getDocumentSize(next)
  await ctx.db.patch(row._id, { ...patch, counts: next.counts })
}

/** One step of day `day`'s run `run`: up to SAMPLE_PAGE.orgs organizations
 * after the run's cursor, by id. A full page moves the cursor and schedules
 * the next step in this transaction; a shorter one marks the run finished,
 * clears its cursor and schedules the expiry. An organization created
 * behind the cursor waits for the next day. Does nothing unless the day's
 * run row holds this run and has not finished. */
export const step = internalMutation({
  args: { day: v.string(), run: v.string() },
  handler: async (ctx, { day, run }): Promise<null> => {
    const row = await runOf(ctx, day)
    if (row === null || row.run !== run || row.finished_at !== undefined) return null
    const cursor = row.cursor
    const orgs = await ctx.db
      .query('organizations')
      .withIndex('by_uuid', (q) => (cursor === null ? q : q.gt('id', cursor)))
      .take(SAMPLE_PAGE.orgs)
    const now = Date.now()
    let tally: SampleCounts = addCounts(NO_COUNTS, { steps: 1, orgs: orgs.length })
    for (const org of orgs) {
      try {
        tally = addCounts(tally, await sampleOrg(ctx, org.id, day, run, now))
      } catch (e) {
        tally = addCounts(tally, { failed: 1 })
        console.error('[storage samples] organization skipped', {
          org_id: org.id,
          day,
          name: (e as Error)?.name ?? 'error',
        })
      }
    }
    if (orgs.length === SAMPLE_PAGE.orgs) {
      await record(ctx, row, tally, { cursor: orgs[orgs.length - 1].id, step_at: now })
      await ctx.scheduler.runAfter(0, stepRef, { day, run })
    } else {
      await record(ctx, row, tally, { cursor: null, step_at: now, finished_at: now })
      await ctx.scheduler.runAfter(0, expireRef, { day })
    }
    return null
  },
})

/** Deletes up to SAMPLE_EXPIRY.page samples and as many run rows of days
 * before the retention (keptSince), oldest days first, and schedules itself
 * again while a page came back full. The run of `day`, whose last step
 * started it, counts the samples it deleted in `expired`, each call in
 * `expiry_steps` and what Convex measured of it. */
export const expire = internalMutation({
  args: { day: v.string() },
  handler: async (ctx, { day }): Promise<null> => {
    const cutoff = keptSince(Date.now())
    const samples = await ctx.db
      .query('storage_daily_samples')
      .withIndex('by_day', (q) => q.lt('day', cutoff))
      .take(SAMPLE_EXPIRY.page)
    for (const sample of samples) await ctx.db.delete(sample._id)
    const runs = await ctx.db
      .query('storage_sample_runs')
      .withIndex('by_day', (q) => q.lt('day', cutoff))
      .take(SAMPLE_EXPIRY.page)
    for (const run of runs) await ctx.db.delete(run._id)
    const row = await runOf(ctx, day)
    if (row !== null) await record(ctx, row, { expired: samples.length, expiry_steps: 1 })
    if (samples.length === SAMPLE_EXPIRY.page || runs.length === SAMPLE_EXPIRY.page)
      await ctx.scheduler.runAfter(0, expireRef, { day })
    return null
  },
})

/** The most days apart costReport's `from` and `to` may be. */
const REPORT_DAYS = 62

/* The time of UTC day `day` (YYYY-MM-DD) at midnight, refusing anything
 * else. */
function dayStart(day: string): number {
  const at = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00.000Z`) : Number.NaN
  require(Number.isFinite(at) && utcDate(at) === day, badRequest(
    'Give each day as a UTC date, YYYY-MM-DD.',
  ))
  return at
}

/** What the daily storage samples cost over the UTC days `from` to `to`,
 * both included and at most 62 days apart: each day's run with its
 * counters, their sums, the runs finished and the hourly ticks the range
 * implies (model/storageSamples.ts CostReport). Read only. It names no
 * organization, and leaves a run's cursor and id out. The staging reading
 * runs it, as this module's header says. */
export const costReport = internalQuery({
  args: { from: v.string(), to: v.string() },
  handler: async (ctx, { from, to }): Promise<CostReport> => {
    const span = (dayStart(to) - dayStart(from)) / DAY_MS
    require(span >= 0, badRequest('The report starts after it ends.'))
    require(span <= REPORT_DAYS, badRequest(`Choose days at most ${REPORT_DAYS} days apart.`))
    const rows = await ctx.db
      .query('storage_sample_runs')
      .withIndex('by_day', (q) => q.gte('day', from).lte('day', to))
      .collect()
    return {
      from,
      to,
      days_in_range: span + 1,
      ticks: 24 * (span + 1),
      runs: rows.length,
      finished: rows.filter((row) => row.finished_at !== undefined).length,
      total: rows.reduce((sum, row) => addCounts(sum, row.counts), NO_COUNTS),
      days: rows.map((row) => ({
        day: row.day,
        started_at: row.started_at,
        finished_at: row.finished_at ?? null,
        counts: row.counts,
      })),
    }
  },
})

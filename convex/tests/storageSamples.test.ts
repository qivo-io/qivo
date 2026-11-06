/* The daily storage samples (storageSamples.ts, model/storageSamples.ts).
 *
 *   1. A day's run samples every counted organization once, with its
 *      totals, their revision and the time it read them, a zero reading
 *      included, and writes nothing for one whose totals are not complete
 *      or whose deletion has begun; on the demo deployment it writes
 *      nothing at all.
 *   2. Steps read SAMPLE_PAGE.orgs organizations at a time in id order; one
 *      created behind the cursor waits for the next day, and one whose
 *      reads fail is counted and logged while the others are sampled.
 *   3. No organization gets two samples of a day, however a step repeats,
 *      a stalled run resumes or a day's late run meets the next day's, and
 *      such a meeting counts each write to the totals once.
 *   4. Ticks: the day's first starts its run, a later one reads one row and
 *      writes nothing, one past SAMPLE_STALLED_MS resumes the run from its
 *      cursor, and the next day starts its own run.
 *   5. The run row's counters: the revisions since each previous sample,
 *      none after a recount whatever revision it ends at, and Convex's
 *      transaction metrics, equal to what each step and expiry step
 *      measured in the end, the run row's own update included.
 *   6. Expiry goes a page at a time and keeps the days inside the
 *      retention.
 *   7. Teardowns: a deletion in steps and deleteOrgDeep leave none of an
 *      organization's samples, the Northstar wipe keeps them, and a step
 *      after a deletion began writes none.
 *   8. costReport sums a range, names no organization, cursor or run, also
 *      of a run under way, and refuses a malformed or longer one.
 *   9. The reads of one step at the batch size, logged for SAMPLE_PAGE.
 *
 * Totals are written only through their writers: the app's attach for a
 * small file, startOrgTotals, addToProject and addToOrg for the rest, and
 * the backfill's own recount steps for totals that are not complete. */

import { getDocumentSize } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { attach as attachFn, removeAttachment as removeFn } from '../files'
import { COUNT_PAGE } from '../internal/storageTotalsBackfill'
import { deleteOrgDeep } from '../model/cascade'
import { wipeWorkStep } from '../model/orgDeletion'
import { DAY_MS } from '../model/orgRetention'
import { newOrgDefaults } from '../model/orgs'
import {
  latestSample,
  runOf,
  SAMPLE_EXPIRY,
  SAMPLE_PAGE,
  SAMPLE_RETENTION_DAYS,
  SAMPLE_STALLED_MS,
} from '../model/storageSamples'
import { addToOrg, addToProject, orgTotalsRow, startOrgTotals } from '../model/storageTotals'
import { expire as expireFn, step as stepFn, tick as tickFn } from '../storageSamples'
import {
  as,
  expectRefusal,
  newT,
  type OrgFixture,
  plantIssue,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { plantTicket } from './uploadTickets.setup'

const DEFAULT_PAGE = { ...SAMPLE_PAGE }
const DEFAULT_EXPIRY = { ...SAMPLE_EXPIRY }
const DEFAULT_COUNT_PAGE = { ...COUNT_PAGE }

/** The day the cases start on, and its first tick at 00:20 UTC. */
const TODAY = '2026-11-06'
const AT = Date.parse(`${TODAY}T00:20:00.000Z`)
/** The UTC date `days` after TODAY. */
const dayAfter = (days: number) => new Date(AT + days * DAY_MS).toISOString().slice(0, 10)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(AT)
})
afterEach(() => {
  Object.assign(SAMPLE_PAGE, DEFAULT_PAGE)
  Object.assign(SAMPLE_EXPIRY, DEFAULT_EXPIRY)
  Object.assign(COUNT_PAGE, DEFAULT_COUNT_PAGE)
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/* -------------------------------------------------------------- helpers */

const tick = (t: T) => t.mutation(internal.storageSamples.tick, {})
const stepOf = (t: T, day: string, run: string) =>
  t.mutation(internal.storageSamples.step, { day, run })
/** Runs every scheduled call, the steps and the expiry. */
const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers)
/** The day's run as the cron starts it: a tick and every step after it. */
async function runDay(t: T): Promise<void> {
  await tick(t)
  await settle(t)
}
/** Runs the next scheduled call only. */
async function nextCall(t: T): Promise<void> {
  vi.advanceTimersToNextTimer()
  await t.finishInProgressScheduledFunctions()
}

const runRow = (t: T, day = TODAY) => t.run((ctx) => runOf(ctx, day))
const allSamples = (t: T) => t.run((ctx) => ctx.db.query('storage_daily_samples').collect())
/** Each sample as [organization, day, bytes], sorted. */
const readings = async (t: T) =>
  (await allSamples(t))
    .map((s) => [s.org_id, s.day, s.bytes] as const)
    .sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`))

/** Plants a new organization with a new one's defaults. With `bytes`, it
 * is counted from zero (startOrgTotals) with that many bytes in one file
 * of one project (addToProject, addToOrg); without, it is not counted.
 * `id` orders it among the others. */
async function plantIn(ctx: MutationCtx, id: string, bytes?: number): Promise<void> {
  await ctx.db.insert('organizations', {
    id,
    name: `Org ${id.slice(0, 8)}`,
    slug: `org-${id.slice(0, 8)}`,
    ...newOrgDefaults(new Date(AT).toISOString()),
  })
  if (bytes === undefined) return
  await startOrgTotals(ctx, id)
  if (bytes > 0) await store(ctx, id, bytes)
}

/** plantIn in a transaction of its own, answering the organization's id. */
async function plantOrg(t: T, bytes?: number, id: string = uuid()): Promise<string> {
  await t.run((ctx) => plantIn(ctx, id, bytes))
  return id
}

/** Adds `bytes` in one file of a new project to organization `orgId`'s
 * totals, raising its revision by one. */
async function store(ctx: MutationCtx, orgId: string, bytes: number): Promise<void> {
  await addToProject(ctx, orgId, uuid(), 1, { bytes, files: 1 }, 'Files')
  const org = await orgTotalsRow(ctx, orgId)
  if (org === null) throw new Error('the organization is not counted')
  await addToOrg(ctx, org, { bytes, files: 1 })
}

/** Attaches a file of `bytes` to a new task in Firmware in the app, as
 * f.user on an upload ticket of their own, so the totals count it. */
async function attach(t: T, f: OrgFixture, bytes: number): Promise<void> {
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-files-secret')
  const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
  const storage_id = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(bytes)])))
  await plantTicket(t, { profile: f.user, issue: task, storageId: storage_id })
  const out = await as(t, f.user).mutation(api.files.attach, {
    org_id: f.org.id,
    id: uuid(),
    issue_id: task.id,
    storage_id,
    name: 'spec.pdf',
    inline: false,
  })
  if (!('attachment' in out)) throw new Error(`the attach was refused: ${out.refused.message}`)
}

/** Takes a recount of organization `orgId`'s totals one backfill step at a
 * time (internal/storageTotalsBackfill step), as an operator's
 * `"recount": true` run does: `steps` steps, or until it ends. Answers
 * whether it ended. */
async function recount(t: T, orgId: string, steps = Number.POSITIVE_INFINITY) {
  const run = uuid()
  for (let n = 0; n < steps; n++) {
    const out = await t.mutation(internal.internal.storageTotalsBackfill.step, {
      org_id: orgId,
      recount: true,
      run,
    })
    if (out !== null) return true
  }
  return false
}

/** Marks organization `orgId`'s deletion begun at its first phase, as
 * orgRemovals.ts does once its date has passed. */
const beginDeletion = (t: T, orgId: string) =>
  t.run((ctx) =>
    ctx.db.insert('org_removals', {
      org_id: orgId,
      reason: 'requested',
      ended_at: new Date(AT).toISOString(),
      delete_after: new Date(AT).toISOString(),
      phase: 'profiles',
      created_at: new Date(AT).toISOString(),
    }),
  )

/** What one transaction read and wrote, from Convex's metrics. */
type Measured = {
  ranges: number
  documents: number
  bytes: number
  written: number
  written_bytes: number
}

/** What transaction `ctx` has read and written so far. */
async function metricsOf(ctx: MutationCtx): Promise<Measured> {
  const m = await ctx.meta.getTransactionMetrics()
  return {
    ranges: m.databaseQueries.used,
    documents: m.documentsRead.used,
    bytes: m.bytesRead.used,
    written: m.documentsWritten.used,
    written_bytes: m.bytesWritten.used,
  }
}

/** Registered mutation `fn` run inside one transaction of its own, with
 * what that transaction read and wrote in the end. */
const measured = (t: T, fn: unknown, args: Record<string, unknown>) =>
  t.run(async (ctx): Promise<Measured> => {
    await (
      fn as { _handler: (ctx: MutationCtx, args: Record<string, unknown>) => Promise<unknown> }
    )._handler(ctx, args)
    return await metricsOf(ctx)
  })

/* ------------------------------------------------------------ the cases */

describe('a day of samples', () => {
  it('samples every counted organization once with its totals, and writes nothing for one not counted or being deleted', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => startOrgTotals(ctx, f.org.id))
    await attach(t, f, 100)
    // the other organization's recount is under way
    await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    expect(await recount(t, f.otherOrg.id, 1)).toBe(false)
    expect(await t.run((ctx) => orgTotalsRow(ctx, f.otherOrg.id))).toMatchObject({
      counting: expect.anything(),
    })
    const uncounted = await plantOrg(t)
    const empty = await plantOrg(t, 0)
    const deleting = await plantOrg(t, 5_000_000_000)
    await beginDeletion(t, deleting)
    const totals = await t.run((ctx) => orgTotalsRow(ctx, f.org.id))

    await runDay(t)
    const samples = await allSamples(t)
    expect(
      samples
        .map(({ org_id, day, bytes, files, revision, at }) => ({
          org_id,
          day,
          bytes,
          files,
          revision,
          at,
        }))
        .sort((a, b) => a.org_id.localeCompare(b.org_id)),
    ).toEqual(
      [
        { org_id: f.org.id, day: TODAY, bytes: 100, files: 1, revision: totals?.revision, at: AT },
        // a counted organization without files has a real zero reading
        { org_id: empty, day: TODAY, bytes: 0, files: 0, revision: 0, at: AT },
      ].sort((a, b) => a.org_id.localeCompare(b.org_id)),
    )
    const run = await runRow(t)
    expect(samples.every((s) => s.run === run?.run)).toBe(true)
    expect(run).toMatchObject({
      cursor: null,
      finished_at: AT,
      counts: {
        steps: 1,
        orgs: 5,
        written: 2,
        present: 0,
        uncounted: 2,
        deleting: 1,
        failed: 0,
        expiry_steps: 1,
      },
    })
    expect(samples.map((s) => s.org_id)).not.toContain(uncounted)
    expect(samples.map((s) => s.org_id)).not.toContain(deleting)
  })

  it('writes nothing on the demo deployment', async () => {
    vi.stubEnv('APP_MODE', 'demo')
    const t = newT()
    await plantOrg(t, 1000)
    await runDay(t)
    expect(await runRow(t)).toBeNull()
    expect(await allSamples(t)).toEqual([])
  })

  it('takes its organizations SAMPLE_PAGE.orgs a step in id order, and one created behind the cursor waits for the next day', async () => {
    SAMPLE_PAGE.orgs = 2
    const t = newT()
    const ids = ['1', '2', '3', '4', '5'].map((n) => `${n}0000000-0000-4000-8000-000000000000`)
    for (const id of ids) await plantOrg(t, 10, id)
    await tick(t)
    await nextCall(t)
    expect(await runRow(t)).toMatchObject({ cursor: ids[1], counts: { steps: 1, written: 2 } })
    // created behind the cursor while the run goes on
    const behind = await plantOrg(t, 10, '00000000-0000-4000-8000-000000000000')
    await nextCall(t)
    expect(await runRow(t)).toMatchObject({ cursor: ids[3], counts: { steps: 2, written: 4 } })
    await nextCall(t)
    expect(await runRow(t)).toMatchObject({
      cursor: null,
      finished_at: AT,
      counts: { steps: 3, orgs: 5, written: 5 },
    })
    expect((await allSamples(t)).map((s) => s.org_id).sort()).toEqual(ids)

    vi.setSystemTime(AT + DAY_MS)
    await runDay(t)
    expect((await allSamples(t)).filter((s) => s.org_id === behind).map((s) => s.day)).toEqual([
      dayAfter(1),
    ])
  })

  it('counts and logs an organization whose reads fail, and samples the others', async () => {
    const t = newT()
    const fine = await plantOrg(t, 10, '10000000-0000-4000-8000-000000000000')
    const broken = await plantOrg(t, 10, '20000000-0000-4000-8000-000000000000')
    const after = await plantOrg(t, 10, '30000000-0000-4000-8000-000000000000')
    // two removal rows, which its removal's read refuses as not unique
    for (let i = 0; i < 2; i++)
      await t.run((ctx) =>
        ctx.db.insert('org_removals', {
          org_id: broken,
          reason: 'requested',
          ended_at: new Date(AT).toISOString(),
          delete_after: new Date(AT + 30 * DAY_MS).toISOString(),
          created_at: new Date(AT).toISOString(),
        }),
      )
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await runDay(t)
    expect((await allSamples(t)).map((s) => s.org_id).sort()).toEqual([fine, after])
    expect(await runRow(t)).toMatchObject({
      finished_at: AT,
      counts: { orgs: 3, written: 2, failed: 1 },
    })
    expect(errors).toHaveBeenCalledWith('[storage samples] organization skipped', {
      org_id: broken,
      day: TODAY,
      name: expect.any(String),
    })
  })
})

describe('one sample per organization and day', () => {
  it('writes each sample once however often a step of the run is called', async () => {
    SAMPLE_PAGE.orgs = 2
    const t = newT()
    for (let i = 0; i < 3; i++) await plantOrg(t, 10)
    await tick(t)
    const run = (await runRow(t))?.run ?? ''
    // the step called again by hand, before and after the scheduled ones
    await stepOf(t, TODAY, run)
    await stepOf(t, TODAY, run)
    await stepOf(t, TODAY, run)
    await settle(t)
    expect(await allSamples(t)).toHaveLength(3)
    expect(await runRow(t)).toMatchObject({ counts: { steps: 2, written: 3, present: 0 } })
  })

  it('resumes a stalled run from its cursor under a new id while the old run step does nothing', async () => {
    SAMPLE_PAGE.orgs = 1
    const t = newT()
    const ids = ['1', '2', '3'].map((n) => `${n}0000000-0000-4000-8000-000000000000`)
    for (const id of ids) await plantOrg(t, 10, id)
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await tick(t)
    await nextCall(t)
    const first = await runRow(t)
    expect(first).toMatchObject({ cursor: ids[0], counts: { steps: 1, restarts: 0 } })
    // the old run's next step is still queued when the run counts as stalled
    vi.setSystemTime(AT + SAMPLE_STALLED_MS - 1000)
    await tick(t)
    expect((await runRow(t))?.run).toBe(first?.run)
    vi.setSystemTime(AT + SAMPLE_STALLED_MS)
    await tick(t)
    const resumed = await runRow(t)
    expect(resumed?.run).not.toBe(first?.run)
    expect(resumed).toMatchObject({
      cursor: ids[0],
      step_at: AT + SAMPLE_STALLED_MS,
      counts: { restarts: 1 },
    })
    expect(warnings).toHaveBeenCalledTimes(1)
    await settle(t)
    expect((await allSamples(t)).map((s) => s.org_id).sort()).toEqual(ids)
    // the old run's step stopped at its run check, so three steps did the
    // work and the fourth found the end
    expect(await runRow(t)).toMatchObject({
      run: resumed?.run,
      counts: { steps: 4, orgs: 3, written: 3, present: 0, restarts: 1 },
    })
    // the first run took the first organization, the resumed one the rest
    const takenBy = Object.fromEntries((await allSamples(t)).map((s) => [s.org_id, s.run]))
    expect(takenBy).toEqual({
      [ids[0]]: first?.run,
      [ids[1]]: resumed?.run,
      [ids[2]]: resumed?.run,
    })
  })

  it("keeps one sample of a day when that day's late run meets the next day's, counts each write to the totals once, and keeps the first reading of a run of the same day again", async () => {
    SAMPLE_PAGE.orgs = 1
    const t = newT()
    const one = await plantOrg(t, 10, '10000000-0000-4000-8000-000000000000')
    const two = await plantOrg(t, 20, '20000000-0000-4000-8000-000000000000')
    // the day before, both are sampled, and then two writes to one's totals
    vi.setSystemTime(AT - DAY_MS)
    await runDay(t)
    await t.run(async (ctx) => {
      await store(ctx, one, 1)
      await store(ctx, one, 1)
    })
    vi.setSystemTime(AT)
    await tick(t)
    const late = (await runRow(t))?.run ?? ''
    // the next day's run samples both organizations first
    vi.setSystemTime(AT + DAY_MS)
    await tick(t)
    const next = (await runRow(t, dayAfter(1)))?.run ?? ''
    for (let n = 0; n < 3; n++) await stepOf(t, dayAfter(1), next)
    // a third write, then the first day's delayed steps reach them, and run
    // again
    await t.run((ctx) => store(ctx, one, 1))
    vi.setSystemTime(AT + DAY_MS + 60 * 60_000)
    for (let n = 0; n < 4; n++) await stepOf(t, TODAY, late)
    await settle(t)
    // and the day after the next
    vi.setSystemTime(AT + 2 * DAY_MS)
    await runDay(t)
    expect(await readings(t)).toEqual([
      [one, dayAfter(-1), 10],
      [one, TODAY, 13],
      [one, dayAfter(1), 12],
      [one, dayAfter(2), 13],
      [two, dayAfter(-1), 20],
      [two, TODAY, 20],
      [two, dayAfter(1), 20],
      [two, dayAfter(2), 20],
    ])
    // Three writes, each counted once. The next day's sample counts the
    // first two from the day before's, the late one, taken after the next
    // day's, counts none, and the day after counts the third from the next
    // day's sample.
    const runs = await t.run((ctx) => ctx.db.query('storage_sample_runs').collect())
    expect(runs.map((row) => [row.day, row.counts.revisions])).toEqual([
      [dayAfter(-1), 0],
      [TODAY, 0],
      [dayAfter(1), 2],
      [dayAfter(2), 1],
    ])

    // a second run of the first day, from its start, keeps the first readings
    await t.run(async (ctx) => {
      await store(ctx, one, 5)
      const row = await runOf(ctx, TODAY)
      await ctx.db.patch(row!._id, { run: 'again', cursor: null, finished_at: undefined })
    })
    for (let n = 0; n < 3; n++) await stepOf(t, TODAY, 'again')
    await settle(t)
    expect((await readings(t)).filter(([, day]) => day === TODAY)).toEqual([
      [one, TODAY, 13],
      [two, TODAY, 20],
    ])
    expect(await runRow(t)).toMatchObject({ counts: { written: 2, present: 2, revisions: 0 } })
  })
})

describe('the hourly tick', () => {
  it('starts the day once, then reads one row and writes nothing while the run goes on or is done', async () => {
    const t = newT()
    await plantOrg(t, 10)
    await tick(t)
    const started = await runRow(t)
    expect(started).toMatchObject({ cursor: null, started_at: AT, step_at: AT })
    expect(started).not.toHaveProperty('finished_at')
    // while the run's step waits
    expect(await measured(t, tickFn, {})).toMatchObject({ documents: 1, written: 0 })
    expect(await runRow(t)).toEqual(started)
    await settle(t)
    const done = await runRow(t)
    vi.setSystemTime(AT + 23 * 60 * 60_000)
    expect(await measured(t, tickFn, {})).toMatchObject({ ranges: 1, documents: 1, written: 0 })
    await tick(t)
    await settle(t)
    expect(await runRow(t)).toEqual(done)
    expect(await allSamples(t)).toHaveLength(1)
  })

  it("starts the next UTC day's run and leaves the earlier day's unfinished run as it was", async () => {
    SAMPLE_PAGE.orgs = 1
    const t = newT()
    for (let i = 0; i < 3; i++) await plantOrg(t, 10)
    await tick(t)
    await nextCall(t)
    const stalled = await runRow(t)
    expect(stalled).not.toHaveProperty('finished_at')
    // the queued step never runs, as after a lost call
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query('_scheduled_functions').collect())
        if (job.state.kind === 'pending') await ctx.scheduler.cancel(job._id)
    })
    vi.setSystemTime(AT + DAY_MS)
    await runDay(t)
    expect(await runRow(t)).toEqual(stalled)
    expect(await runRow(t, dayAfter(1))).toMatchObject({
      finished_at: AT + DAY_MS,
      counts: { written: 3 },
    })
    expect((await allSamples(t)).filter((s) => s.day === TODAY)).toHaveLength(1)
  })
})

describe("the run's counters", () => {
  it('adds the revisions since each previous sample, none after a recount, and the transaction metrics', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => startOrgTotals(ctx, f.org.id))
    for (let i = 0; i < 5; i++) await attach(t, f, 10)
    const growing = await plantOrg(t, 10)
    await runDay(t)
    const first = await runRow(t)
    // the first sample of each adds nothing
    expect(first).toMatchObject({ counts: { written: 2, revisions: 0 } })
    const before = await t.run((ctx) => orgTotalsRow(ctx, f.org.id))
    expect(before?.revision).toBeGreaterThanOrEqual(5)

    // the next day: two writes to one organization's totals, and a recount
    // of the other, which starts its revision again from 0
    await t.run(async (ctx) => {
      await store(ctx, growing, 1)
      await store(ctx, growing, 1)
    })
    expect(await recount(t, f.org.id)).toBe(true)
    const recounted = await t.run((ctx) => orgTotalsRow(ctx, f.org.id))
    expect(recounted?.revision).toBeLessThan(before?.revision ?? 0)
    expect(recounted).toMatchObject({ bytes: 50, files: 5 })
    vi.setSystemTime(AT + DAY_MS)
    await runDay(t)
    const second = await runRow(t, dayAfter(1))
    expect(second).toMatchObject({ counts: { written: 2, revisions: 2 } })
    expect(await t.run((ctx) => latestSample(ctx, f.org.id))).toMatchObject({
      day: dayAfter(1),
      bytes: 50,
      revision: recounted?.revision,
    })

    // what Convex measured: the step's reads, its two inserts and the run
    // row's own write, and the expiry step's reads and its write
    const counts = second?.counts
    expect(counts?.steps).toBe(1)
    expect(counts?.expiry_steps).toBe(1)
    expect(counts?.documents_written).toBe(2 + 1 + 1)
    expect(counts?.documents_read).toBeGreaterThan(2 * 3)
    expect(counts?.database_queries).toBeGreaterThan(2 * 4)
    expect(counts?.bytes_read).toBeGreaterThan(0)
    expect(counts?.bytes_written).toBeGreaterThan(0)
  })

  it("adds none of a recount's steps when the recount ends above the previous sample's revision", async () => {
    // one task a recount step, so the recount ends above the three
    // attaches' revision
    COUNT_PAGE.tasks = 1
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => startOrgTotals(ctx, f.org.id))
    for (let i = 0; i < 3; i++) await attach(t, f, 10)
    const growing = await plantOrg(t, 10)
    await runDay(t)
    const before = await t.run((ctx) => orgTotalsRow(ctx, f.org.id))

    // later that day the recount, and two writes to the other organization
    vi.setSystemTime(AT + 12 * 60 * 60_000)
    expect(await recount(t, f.org.id)).toBe(true)
    await t.run(async (ctx) => {
      await store(ctx, growing, 1)
      await store(ctx, growing, 1)
    })
    const recounted = await t.run((ctx) => orgTotalsRow(ctx, f.org.id))
    expect(recounted).toMatchObject({ bytes: 30, files: 3 })
    expect(recounted?.revision).toBeGreaterThan(before?.revision ?? Number.POSITIVE_INFINITY)
    vi.setSystemTime(AT + DAY_MS)
    await runDay(t)
    // the other organization's two writes, and nothing for the recounted one
    expect(await runRow(t, dayAfter(1))).toMatchObject({ counts: { written: 2, revisions: 2 } })
    expect(await t.run((ctx) => latestSample(ctx, f.org.id))).toMatchObject({
      day: dayAfter(1),
      revision: recounted?.revision,
    })
  })

  it('adds what each step and expiry step measured in the end, the read and write of the run row included', async () => {
    SAMPLE_PAGE.orgs = 2
    const t = newT()
    for (let i = 0; i < 3; i++) await plantOrg(t, 10)
    // a day past the retention, for the expiry to delete
    vi.setSystemTime(AT - SAMPLE_RETENTION_DAYS * DAY_MS)
    await runDay(t)
    vi.setSystemTime(AT)
    await tick(t)
    const run = (await runRow(t))?.run ?? ''
    const counts = async () => (await runRow(t))?.counts
    // a full page, the last page, which finishes the run, and the expiry
    for (const [fn, args] of [
      [stepFn, { day: TODAY, run }],
      [stepFn, { day: TODAY, run }],
      [expireFn, { day: TODAY }],
    ] as const) {
      const before = await counts()
      const m = await measured(t, fn, args)
      const after = await counts()
      expect({
        documents_read: (after?.documents_read ?? 0) - (before?.documents_read ?? 0),
        bytes_read: (after?.bytes_read ?? 0) - (before?.bytes_read ?? 0),
        documents_written: (after?.documents_written ?? 0) - (before?.documents_written ?? 0),
        bytes_written: (after?.bytes_written ?? 0) - (before?.bytes_written ?? 0),
        database_queries: (after?.database_queries ?? 0) - (before?.database_queries ?? 0),
      }).toEqual({
        documents_read: m.documents,
        bytes_read: m.bytes,
        documents_written: m.written,
        bytes_written: m.written_bytes,
        database_queries: m.ranges,
      })
    }
    expect(await runRow(t)).toMatchObject({
      finished_at: AT,
      counts: { steps: 2, written: 3, expired: 3, expiry_steps: 1 },
    })
  })
})

describe('expiry', () => {
  it('deletes the samples and runs of days before the retention a page at a time, and keeps the days inside it', async () => {
    SAMPLE_EXPIRY.page = 2
    const t = newT()
    for (let i = 0; i < 3; i++) await plantOrg(t, 10)
    // a run on each of the last two days past the retention and on the first
    // day inside it, as seen from SAMPLE_RETENTION_DAYS - 1 days later
    const kept = SAMPLE_RETENTION_DAYS - 1
    for (const back of [kept + 2, kept + 1, kept]) {
      vi.setSystemTime(AT - back * DAY_MS)
      await runDay(t)
    }
    expect(await allSamples(t)).toHaveLength(9)
    vi.setSystemTime(AT)
    await runDay(t)
    const days = (await allSamples(t)).map((s) => s.day)
    expect(new Set(days)).toEqual(new Set([dayAfter(-kept), TODAY]))
    expect(days).toHaveLength(6)
    expect(
      (await t.run((ctx) => ctx.db.query('storage_sample_runs').collect())).map((r) => r.day),
    ).toEqual([dayAfter(-kept), TODAY])
    // six samples and two run rows, two of each a page, take three full
    // pages and then one that found none
    expect(await runRow(t)).toMatchObject({ counts: { expired: 6, expiry_steps: 4 } })
  })
})

describe('teardowns', () => {
  it('leaves no sample of an organization deleted in steps, and samples none once its deletion began', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => startOrgTotals(ctx, f.org.id))
    await attach(t, f, 10)
    const other = await plantOrg(t, 10)
    await runDay(t)
    expect(await allSamples(t)).toHaveLength(2)

    await beginDeletion(t, f.org.id)
    vi.setSystemTime(AT + DAY_MS)
    await runDay(t)
    expect(await runRow(t, dayAfter(1))).toMatchObject({ counts: { written: 1, deleting: 1 } })
    await t.mutation(internal.orgRemovals.step, { org_id: f.org.id })
    await settle(t)
    expect(await t.run((ctx) => ctx.db.query('org_removals').collect())).toEqual([])
    expect((await allSamples(t)).map((s) => s.org_id)).toEqual([other, other])
  })

  it('leaves no sample of an organization deleted at once, and the Northstar wipe keeps them', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await startOrgTotals(ctx, f.org.id)
      await startOrgTotals(ctx, f.otherOrg.id)
    })
    await runDay(t)
    expect(await allSamples(t)).toHaveLength(2)
    // the wipe keeps the organization and its billing rows
    const profiles = await t.run((ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect(),
    )
    let wiped = false
    for (let n = 0; n < 50 && !wiped; n++)
      wiped = await t.run((ctx) =>
        wipeWorkStep(
          ctx,
          f.org.id,
          profiles.map((p) => p.id),
        ),
      )
    expect(wiped).toBe(true)
    expect(await allSamples(t)).toHaveLength(2)
    await t.run(async (ctx) => {
      const org = await ctx.db
        .query('organizations')
        .withIndex('by_uuid', (q) => q.eq('id', f.otherOrg.id))
        .unique()
      await deleteOrgDeep(ctx, org as Doc<'organizations'>)
    })
    expect((await allSamples(t)).map((s) => s.org_id)).toEqual([f.org.id])
  })
})

describe('costReport', () => {
  const report = (t: T, from: string, to: string) =>
    t.query(internal.storageSamples.costReport, { from, to })

  it("sums the days' runs, names no organization, cursor or run, also of a run under way, and counts the hourly ticks", async () => {
    const t = newT()
    for (let i = 0; i < 3; i++) await plantOrg(t, 10)
    await runDay(t)
    vi.setSystemTime(AT + DAY_MS)
    await runDay(t)
    const out = await report(t, dayAfter(-1), dayAfter(1))
    const [a, b] = [await runRow(t), await runRow(t, dayAfter(1))]
    expect(out).toMatchObject({
      from: dayAfter(-1),
      to: dayAfter(1),
      days_in_range: 3,
      ticks: 72,
      runs: 2,
      finished: 2,
      days: [
        { day: TODAY, started_at: AT, finished_at: AT, counts: a?.counts },
        { day: dayAfter(1), started_at: AT + DAY_MS, finished_at: AT + DAY_MS, counts: b?.counts },
      ],
    })
    expect(out.total.written).toBe(6)
    expect(out.total.documents_read).toBe(
      (a?.counts.documents_read ?? 0) + (b?.counts.documents_read ?? 0),
    )
    const text = JSON.stringify(out)
    for (const s of await allSamples(t)) expect(text).not.toContain(s.org_id)
    expect(text).not.toContain(a?.run)

    // a run under way, whose cursor names the last organization it did
    SAMPLE_PAGE.orgs = 1
    vi.setSystemTime(AT + 2 * DAY_MS)
    await tick(t)
    await nextCall(t)
    const open = await runRow(t, dayAfter(2))
    expect(open).not.toHaveProperty('finished_at')
    expect(open?.cursor).toEqual(expect.any(String))
    const under = await report(t, dayAfter(-1), dayAfter(2))
    expect(under).toMatchObject({ runs: 3, finished: 2 })
    expect(under.days[2]).toEqual({
      day: dayAfter(2),
      started_at: AT + 2 * DAY_MS,
      finished_at: null,
      counts: open?.counts,
    })
    const words = JSON.stringify(under)
    expect(words).not.toContain(open?.cursor)
    for (const s of await allSamples(t)) expect(words).not.toContain(s.org_id)
    for (const row of [a, b, open]) expect(words).not.toContain(row?.run)
    // 62 days apart is the widest range
    expect((await report(t, TODAY, dayAfter(62))).days_in_range).toBe(63)
  })

  it.each([
    [TODAY, dayAfter(63), /at most 62 days apart/],
    [dayAfter(1), TODAY, /starts after it ends/],
    ['2026-11-6', TODAY, /UTC date/],
    ['2026-02-30', '2026-03-01', /UTC date/],
    [TODAY, 'tomorrow', /UTC date/],
  ])('refuses %s to %s', async (from, to, message) => {
    await expectRefusal(report(newT(), from, to), 'bad_request', message)
  })
})

describe('what the totals add to the writes they count', () => {
  /* An attach in the app and the removal of that file for good, each in a
   * transaction of its own as f.user, with what the transaction read and
   * wrote, for an organization counted or not. */
  async function attachAndRemove(counted: boolean) {
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-files-secret')
    const t = newT()
    const f = await withOrg(t)
    if (counted) await t.run((ctx) => startOrgTotals(ctx, f.org.id))
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const storage_id = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(100)])))
    await plantTicket(t, { profile: f.user, issue: task, storageId: storage_id })
    const call = (fn: unknown, args: Record<string, unknown>) =>
      as(t, f.user).mutation(async (ctx): Promise<Measured> => {
        await (
          fn as { _handler: (ctx: MutationCtx, args: Record<string, unknown>) => Promise<unknown> }
        )._handler(ctx, { org_id: f.org.id, ...args })
        return await metricsOf(ctx)
      })
    const id = uuid()
    const attached = await call(attachFn, {
      id,
      issue_id: task.id,
      storage_id,
      name: 'spec.pdf',
      inline: false,
    })
    const revision = (await t.run((ctx) => orgTotalsRow(ctx, f.org.id)))?.revision
    const removed = await call(removeFn, { id })
    const after = await t.run((ctx) => orgTotalsRow(ctx, f.org.id))
    return { attached, removed, revision, after }
  }

  it('writes three totals rows and one revision for each attach and removal, and nothing without totals', async () => {
    const counted = await attachAndRemove(true)
    const not = await attachAndRemove(false)
    console.log(
      'totals on an attach and a removal',
      JSON.stringify({
        counted: [counted.attached, counted.removed],
        not: [not.attached, not.removed],
      }),
    )
    // one revision a call, the reading's `revisions`
    expect(counted.revision).toBe(1)
    expect(counted.after).toMatchObject({ bytes: 0, files: 0, revision: 2 })
    expect(not.after).toBeNull()
    // the task's, the project's and the organization's rows
    expect(counted.attached.written - not.attached.written).toBe(3)
    expect(counted.removed.written - not.removed.written).toBe(3)
    for (const call of ['attached', 'removed'] as const)
      expect(counted[call].documents).toBeGreaterThan(not[call].documents)
  })
})

describe('reads at the batch size', () => {
  it('reads the same few documents for each of SAMPLE_PAGE.orgs organizations, sampled or not', async () => {
    const t = newT()
    await t.run(async (ctx) => {
      for (let i = 0; i < SAMPLE_PAGE.orgs; i++) await plantIn(ctx, uuid(), 1000)
    })
    await tick(t)
    const run = (await runRow(t))?.run ?? ''
    const fresh = await measured(t, stepFn, { day: TODAY, run })
    expect(await runRow(t)).toMatchObject({
      counts: { orgs: SAMPLE_PAGE.orgs, written: SAMPLE_PAGE.orgs },
    })
    // the same step again, as a retry, with every sample present
    await t.run(async (ctx) => {
      const row = await runOf(ctx, TODAY)
      await ctx.db.patch(row!._id, { cursor: null })
    })
    const retry = await measured(t, stepFn, { day: TODAY, run })
    expect(await runRow(t)).toMatchObject({ counts: { present: SAMPLE_PAGE.orgs } })
    const sample = (await allSamples(t))[0]
    const row = await runRow(t)
    console.log(
      'daily sample step reads',
      JSON.stringify({
        fresh,
        retry,
        sample_bytes: getDocumentSize(sample),
        run_bytes: row && getDocumentSize(row),
      }),
    )
    // Each organization: its row, in the step's one page of organizations,
    // and four indexed reads, its removal, its totals row, its sample of
    // the day and its sample of the latest day, of which only the totals
    // row is there. With the run row, read once and again by its update,
    // and the samples and the run row written.
    const n = SAMPLE_PAGE.orgs
    expect(fresh).toMatchObject({ documents: 2 * n + 2, ranges: 4 * n + 2, written: n + 1 })
    // a sample of the day found ends the organization's reads, before its
    // sample of the latest day
    expect(retry).toMatchObject({ documents: 3 * n + 2, ranges: 3 * n + 2, written: 1 })
  })
})

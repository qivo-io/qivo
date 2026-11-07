/* Billing's reads of stored task files from the stored-byte totals:
 * billing.usageFigures (model/billing.ts usageFiguresOf) and
 * billing.storageProjects (model/billingStorage.ts storageProjectsBatch).
 *
 *   1. Current storage is the organization's totals. Files attached in
 *      several sub-projects add up, a task in Deleted items still counts
 *      until it is purged, profile pictures and backgrounds never count, and
 *      an organization not counted yet or counting answers null, never 0.
 *   2. The period's sample answers a paid period's finished sample only,
 *      with its basis; a daily period answers no sample but its average,
 *      while open from the job's samples so far, a missing day from the
 *      next and today left out until sampled, once recorded from its row,
 *      and never another subscription's or organization's.
 *   3. Storage by project pages 25 at a time, largest first, equal bytes
 *      each once, the rest of a cursor's creation instant included, adding
 *      up to the organization's total; labels active, archived, Deleted
 *      items and removed projects, a row without a name, a row whose
 *      number another live project does not have, and a row whose id and
 *      number another organization's live or stored project holds.
 *   4. Its search ignores accents, case and word order over the whole list
 *      and answers only this organization's rows; a row whose bytes cross
 *      the cursor between calls is missed or answered again, as the owner
 *      accepted.
 *   5. Both queries refuse anyone but an active admin of the organization,
 *      an organization being deleted, a long search and a foreign or
 *      malformed cursor (the demo's refusal is in demo.test.ts); Storage by
 *      project answers `counting` without reading a project row, and a
 *      lowered read share stops a batch and goes on without claiming an
 *      end.
 *   6. The reads at the design size, logged for the docstrings.
 *
 * Files count through the app's own attach (files.attach), and totals rows
 * that no attach could make cheaply are written only through addToProject
 * and addToOrg, the writers model/storageTotals.ts keeps exact. */

import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { StorageProjectRow, StorageProjects } from '../lib/billingTypes'
import type { Refusal } from '../lib/functions'
import { LIMITS, LIST_BATCH } from '../lib/limits'
import { namedCursor } from '../lib/namedPages'
import { usageFiguresOf } from '../model/billing'
import {
  NOT_STORAGE_CURSOR,
  STORAGE_PROJECTS,
  STORAGE_PROJECTS_LIST,
  storageProjectsBatch,
} from '../model/billingStorage'
import {
  type Amount,
  addToOrg,
  addToProject,
  orgTotalsRow,
  startOrgTotals,
} from '../model/storageTotals'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { deleteProject, deleteTask, installTrashTimers, itemFor, runSteps } from './trash.setup'
import { plantTicket } from './uploadTickets.setup'

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not
 * declare it. */
declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

/* Download links and upload URLs read this lazily (attachments.test.ts
 * plants the same). */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
g.process ??= { env: {} }
g.process.env.BETTER_AUTH_SECRET ??= 'test-files-secret'

const DEFAULT_READS = { ...STORAGE_PROJECTS.reads }
afterEach(() => {
  Object.assign(STORAGE_PROJECTS.reads, DEFAULT_READS)
})

/* ---------------------------------------------------------------- helpers */

/** withOrg with its organization counted from zero, as a new one starts. */
async function counted(t: T = newT()) {
  const f = await withOrg(t)
  await t.run((ctx) => startOrgTotals(ctx, f.org.id))
  return { t, f }
}

/** `bytes` zero bytes stored, with `type` as their content type when given. */
const storeBlob = (t: T, bytes: number, type?: string): Promise<Id<'_storage'>> =>
  t.run(async (ctx) => {
    const sid = await ctx.storage.store(new Blob([new Uint8Array(bytes)]) as never)
    if (type !== undefined) await ctx.db.patch(sid as never, { contentType: type } as never)
    return sid
  })

/** Attaches `bytes` new bytes to `issue` in the app as `f.user`, a
 * description image when `inline`, on an upload ticket of their own, as
 * the upload URL's receiver leaves one. */
async function attach(t: T, f: OrgFixture, issue: Doc<'issues'>, bytes: number, inline = false) {
  const storage_id = await storeBlob(t, bytes, inline ? 'image/png' : undefined)
  await plantTicket(t, { profile: f.user, issue, storageId: storage_id })
  const out = await as(t, f.user).mutation(api.files.attach, {
    org_id: f.org.id,
    id: uuid(),
    issue_id: issue.id,
    storage_id,
    name: inline ? 'shot.png' : 'spec.pdf',
    inline,
  })
  if (!('attachment' in out)) throw new Error(`the attach was refused: ${out.refused.message}`)
}

/** A sub-project of TBED, or of `extra.parent_id` when given, with one task
 * holding a file of `bytes`, attached in the app. */
async function withFile(
  t: T,
  f: OrgFixture,
  bytes: number,
  extra: Partial<Doc<'projects'>> = {},
): Promise<{ project: Doc<'projects'>; task: Doc<'issues'> }> {
  const project = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: f.meta.id,
    ...extra,
  })
  const task = await plantIssue(t, { org_id: f.org.id, project_id: project.id })
  await attach(t, f, task, bytes)
  return { project, task }
}

/** A totals row to write through addToProject: a project id, its number
 * and name (both absent when no copy is left), and its bytes. */
type Planted = { project_id: string; num?: number; name?: string; bytes: number }

/** Writes `rows` into the totals of organization `orgId`, one file each,
 * through addToProject and then addToOrg for their sum, 500 rows a
 * transaction. */
async function plantTotals(t: T, orgId: string, rows: readonly Planted[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500)
    await t.run(async (ctx) => {
      for (const row of rows.slice(i, i + 500))
        await addToProject(
          ctx,
          orgId,
          row.project_id,
          row.num,
          { bytes: row.bytes, files: 1 },
          row.name,
        )
    })
  const sum: Amount = { bytes: rows.reduce((n, r) => n + r.bytes, 0), files: rows.length }
  await t.run(async (ctx) => {
    const org = await orgTotalsRow(ctx, orgId)
    if (org === null) throw new Error('the organization is not counted')
    await addToOrg(ctx, org, sum)
  })
}

/** Billing's usage figures as `by` reads them. */
const usageOf = (t: T, by: Doc<'profiles'>) =>
  as(t, by).query(api.billing.usageFigures, { org_id: by.org_id })

/** One batch of Storage by project as `by` reads it. */
const batchOf = (t: T, by: Doc<'profiles'>, a: { search?: string; cursor?: string } = {}) =>
  as(t, by).query(api.billing.storageProjects, { org_id: by.org_id, ...a })

/** `answer` when it is ready, else a failure. */
function ready(answer: StorageProjects) {
  if (answer.state !== 'ready') throw new Error(`the list answered ${answer.state}`)
  return answer
}

/** Every batch of Storage by project for `by` from its start, following
 * each `next`. */
async function walk(t: T, by: Doc<'profiles'>, search?: string) {
  const batches: Extract<StorageProjects, { state: 'ready' }>[] = []
  let cursor: string | undefined
  for (let i = 0; i < 200; i++) {
    const batch = ready(await batchOf(t, by, { search, cursor }))
    batches.push(batch)
    if (batch.next === null) return { batches, rows: batches.flatMap((b) => b.rows) }
    cursor = batch.next
  }
  throw new Error('the list did not end')
}

/** What one transaction read, from Convex's metrics. */
type Read = { ranges: number; documents: number; bytes: number }

/** `run` in its own transaction, with what that transaction read. */
const measured = <R>(t: T, run: (ctx: QueryCtx) => Promise<R>) =>
  t.run(async (ctx) => {
    const out = await run(ctx)
    const m = await ctx.meta.getTransactionMetrics()
    const read: Read = {
      ranges: m.databaseQueries.used,
      documents: m.documentsRead.used,
      bytes: m.bytesRead.used,
    }
    return { out, read }
  })

/** The refusal `read` throws inside one transaction, with the index
 * ranges the transaction read before it. */
const refused = (t: T, read: (ctx: QueryCtx) => Promise<unknown>) =>
  t.run(async (ctx) => {
    const e = await read(ctx).then(
      () => null,
      (error: unknown) => error,
    )
    const m = await ctx.meta.getTransactionMetrics()
    if (!(e instanceof ConvexError)) throw new Error(`expected a refusal, got ${String(e)}`)
    return { data: e.data as Refusal, ranges: m.databaseQueries.used }
  })

/** A name of 80 characters, ordinary text, that starts with `head`. */
const named80 = (head: string) =>
  `${head} sub-project for the field trials and its review notes`.padEnd(80, '.').slice(0, 80)

/* ---------------------------------------------------------- current usage */

describe('current storage', () => {
  installTrashTimers()

  it('adds up the files of two sub-projects, counts a task in Deleted items until it is purged, and never counts a picture or a background', async () => {
    vi.stubEnv('CONVEX_SITE_URL', 'https://billing-storage.convex.site')
    const { t, f } = await counted()
    const inFw = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const inPcb = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    await attach(t, f, inFw, 100)
    await attach(t, f, inFw, 10, true)
    await attach(t, f, inPcb, 50)
    expect(await usageOf(t, f.admin)).toMatchObject({ storage_bytes: 160 })

    // the task goes to Deleted items with its files, which still count
    await deleteTask(t, f, inFw.id)
    await runSteps(t)
    expect(await t.run((ctx) => ctx.db.query('issue_attachments').collect())).toHaveLength(1)
    expect(await usageOf(t, f.admin)).toMatchObject({ storage_bytes: 160 })
    expect((await walk(t, f.admin)).rows.map((r) => [r.name, r.bytes, r.status])).toEqual([
      ['Firmware', 110, 'active'],
      ['Board rev', 50, 'active'],
    ])

    // deleted for good, they stop counting
    const item = await itemFor(t, inFw.id)
    await as(t, f.admin).mutation(api.deletedItems.purge, { org_id: f.org.id, ids: [item.id] })
    await runSteps(t)
    expect(await usageOf(t, f.admin)).toMatchObject({ storage_bytes: 50 })
    expect((await walk(t, f.admin)).rows.map((r) => r.name)).toEqual(['Board rev'])

    // a profile picture and a personal background count nowhere
    await as(t, f.user).mutation(api.files.setAvatar, {
      profile_id: f.user.id,
      storage_id: await storeBlob(t, 2048, 'image/png'),
    })
    const ticket = await as(t, f.user).mutation(api.appearance.createUpload, { name: 'Lake.jpg' })
    await t.mutation(internal.appearance.finalizeUpload, {
      ticket_id: ticket.ticket_id,
      minter: f.user.auth_user_id as string,
      storage_id: await storeBlob(t, 4096, 'image/jpeg'),
      width: 2400,
      height: 1200,
    })
    expect(await t.run((ctx) => ctx.db.query('custom_backgrounds').collect())).toHaveLength(1)
    expect(await usageOf(t, f.admin)).toMatchObject({ storage_bytes: 50 })
    expect((await walk(t, f.admin)).rows.map((r) => r.bytes)).toEqual([50])
  })

  it('answers null, never 0, without a totals row and while the totals count', async () => {
    const t = newT()
    const f = await withOrg(t)
    // withOrg's organization has no totals row, as one before the backfill
    expect(await usageOf(t, f.admin)).toMatchObject({ storage_bytes: null })
    expect(await batchOf(t, f.admin)).toEqual({ state: 'counting' })
    await t.run((ctx) => startOrgTotals(ctx, f.org.id))
    expect(await usageOf(t, f.admin)).toMatchObject({ storage_bytes: 0 })
    expect(await batchOf(t, f.admin)).toEqual({
      state: 'ready',
      rows: [],
      next: null,
      stopped: false,
    })
    await t.run(async (ctx) => {
      const org = await orgTotalsRow(ctx, f.org.id)
      await ctx.db.patch(org!._id, { counting: { through: 0 } })
    })
    expect(await usageOf(t, f.admin)).toMatchObject({ storage_bytes: null })
    expect(await batchOf(t, f.admin)).toEqual({ state: 'counting' })
  })
})

/* ------------------------------------------------------------- the sample */

describe("the period's storage sample", () => {
  const PERIOD = '2026-09-15T12:00:00.000Z'
  const END = '2026-10-15T12:00:00.000Z'
  beforeEach(() => {
    vi.stubEnv('BILLING_ENABLED', 'true')
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-20T12:00:00.000Z'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  /** A counted organization with an active provider subscription in its
   * period from PERIOD to END. */
  async function subscribed() {
    const { t, f } = await counted()
    const sub = await t.run(async (ctx) => {
      const plan_id = uuid()
      await ctx.db.insert('billing_plans', {
        id: plan_id,
        name: 'Team',
        currency: 'usd',
        seat_price_cents: 100,
        minimum_seats: 1,
        storage_gb_per_seat: 1,
        minimum_storage_gb: 5,
        api_calls_per_seat: 2,
        api_block_size: 2,
        api_block_price_cents: 100,
        storage_block_price_cents: 100,
        archived: false,
        created_at: PERIOD,
      })
      const id = await ctx.db.insert('billing_subscriptions', {
        id: uuid(),
        org_id: f.org.id,
        plan_id,
        status: 'active',
        polar_subscription_id: 'provider-sub',
        current_period_start: PERIOD,
        current_period_end: END,
        billed_seats: 2,
        next_seats: 2,
        cancel_at_period_end: false,
        created_at: PERIOD,
        updated_at: PERIOD,
      })
      return (await ctx.db.get(id))!
    })
    return { t, f, sub }
  }

  /** A billing_periods row starting at `start` with `fields`. */
  const period = (
    t: T,
    f: OrgFixture,
    sub: Doc<'billing_subscriptions'>,
    fields: Partial<Doc<'billing_periods'>> = {},
  ) =>
    t.run((ctx) =>
      ctx.db.insert('billing_periods', {
        org_id: f.org.id,
        subscription_id: 'provider-sub',
        plan_id: sub.plan_id,
        period_start: PERIOD,
        period_end: END,
        seats: 2,
        profile_ids: [],
        created_at: PERIOD,
        ...fields,
      }),
    )

  it("answers a paid period's finished sample beside current storage", async () => {
    const { t, f, sub } = await subscribed()
    await plantTotals(t, f.org.id, [
      { project_id: f.sub.id, num: f.sub.num, name: 'Firmware', bytes: 900 },
    ])
    await period(t, f, sub, { storage_bytes: 1234, storage_blocks: 0 })
    expect(await usageOf(t, f.admin)).toMatchObject({
      period_kind: 'paid',
      period_key: PERIOD,
      storage_bytes: 900,
      sampled_storage_bytes: 1234,
    })
  })

  it('answers null for a running or stopped sample and a period without a row', async () => {
    const { t, f, sub } = await subscribed()
    expect(await usageOf(t, f.admin)).toMatchObject({
      period_kind: 'paid',
      sampled_storage_bytes: null,
    })
    const row = await period(t, f, sub, { storage_run: 'run', storage_run_at: PERIOD })
    expect(await usageOf(t, f.admin)).toMatchObject({ sampled_storage_bytes: null })
    await t.run((ctx) =>
      ctx.db.patch(row, {
        storage_run: undefined,
        storage_run_at: undefined,
        storage_failed_at: PERIOD,
      }),
    )
    expect(await usageOf(t, f.admin)).toMatchObject({ sampled_storage_bytes: null })
    // the case that must answer, the same row once its sample finished
    await t.run((ctx) => ctx.db.patch(row, { storage_failed_at: undefined, storage_bytes: 7 }))
    expect(await usageOf(t, f.admin)).toMatchObject({ sampled_storage_bytes: 7 })
  })

  it("answers null for another subscription's or organization's row, a month and a pending interval, and the new bucket after the boundary", async () => {
    const { t, f, sub } = await subscribed()
    await period(t, f, sub, { subscription_id: 'another-sub', storage_bytes: 11 })
    // a row of the other organization under this subscription id and start
    const theirs = await period(t, f, sub, { org_id: f.otherOrg.id, storage_bytes: 22 })
    expect(await usageOf(t, f.admin)).toMatchObject({
      period_kind: 'paid',
      sampled_storage_bytes: null,
    })
    await t.run((ctx) => ctx.db.delete(theirs))

    await period(t, f, sub, { storage_bytes: 33 })
    expect(await usageOf(t, f.admin)).toMatchObject({ sampled_storage_bytes: 33 })
    // past the period's end with no renewal, the pending interval, whose
    // key a sampled row of the next period may share before the renewal
    // is confirmed; its sample is not this bucket's
    await period(t, f, sub, { period_start: END, period_end: END, storage_bytes: 44 })
    vi.mocked(Date.now).mockReturnValue(Date.parse(END) + 1000)
    expect(await usageOf(t, f.admin)).toMatchObject({
      period_kind: 'pending',
      period_key: END,
      sampled_storage_bytes: null,
    })
    // no provider subscription, so a calendar month
    await t.run((ctx) =>
      ctx.db.patch(sub._id, { status: 'pending', polar_subscription_id: undefined }),
    )
    expect(await usageOf(t, f.admin)).toMatchObject({
      period_kind: 'month',
      period_key: 'month:2026-10',
      sampled_storage_bytes: null,
    })
  })
})

/* ------------------------------------------------ the daily storage basis */

describe("a period's storage basis and a daily period's average", () => {
  /* A period of 31 days, 15 September to 15 October. */
  const PERIOD = '2026-09-15T12:00:00.000Z'
  const END = '2026-10-16T12:00:00.000Z'
  const at = (day: string, time = '00:20') => Date.parse(`${day}T${time}:00.000Z`)
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(at('2026-09-15', '13:00'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  /** A counted organization with an active provider subscription in its
   * period from PERIOD to END, holding `bytes`. */
  async function subscribed(bytes = 0) {
    const { t, f } = await counted()
    if (bytes > 0)
      await plantTotals(t, f.org.id, [
        { project_id: f.sub.id, num: f.sub.num, name: 'Firmware', bytes },
      ])
    const sub = await t.run(async (ctx) => {
      const plan_id = uuid()
      await ctx.db.insert('billing_plans', {
        id: plan_id,
        name: 'Team',
        currency: 'usd',
        seat_price_cents: 100,
        minimum_seats: 1,
        storage_gb_per_seat: 1,
        minimum_storage_gb: 5,
        api_calls_per_seat: 2,
        api_block_size: 2,
        api_block_price_cents: 100,
        storage_block_price_cents: 100,
        archived: false,
        created_at: PERIOD,
      })
      const id = await ctx.db.insert('billing_subscriptions', {
        id: uuid(),
        org_id: f.org.id,
        plan_id,
        status: 'active',
        polar_subscription_id: 'provider-sub',
        current_period_start: PERIOD,
        current_period_end: END,
        billed_seats: 2,
        next_seats: 2,
        cancel_at_period_end: false,
        created_at: PERIOD,
        updated_at: PERIOD,
      })
      return (await ctx.db.get(id))!
    })
    return { t, f, sub }
  }

  /** The billing_periods row of `sub` from PERIOD to END with `fields`,
   * daily unless they say otherwise. */
  const period = (
    t: T,
    f: OrgFixture,
    sub: Doc<'billing_subscriptions'>,
    fields: Partial<Doc<'billing_periods'>> = {},
  ) =>
    t.run((ctx) =>
      ctx.db.insert('billing_periods', {
        org_id: f.org.id,
        subscription_id: 'provider-sub',
        plan_id: sub.plan_id,
        period_start: PERIOD,
        period_end: END,
        seats: 2,
        profile_ids: [],
        storage_basis: 'daily',
        created_at: PERIOD,
        ...fields,
      }),
    )

  /** Runs the daily samples' run of UTC day `day` at 00:20, as the hourly
   * tick starts it, with billing off, so no finalize runs. */
  async function runDay(t: T, day: string) {
    vi.setSystemTime(at(day))
    await t.mutation(internal.storageSamples.tick, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
  }

  /** Adds `bytes` to organization `orgId`'s totals in one more file. */
  const store = (t: T, f: OrgFixture, bytes: number) =>
    plantTotals(t, f.org.id, [{ project_id: uuid(), num: 1, name: 'Files', bytes }])

  it("answers a period sampled at its start as before, with its basis, and no basis outside a paid period's row", async () => {
    const { t, f, sub } = await subscribed()
    expect(await usageOf(t, f.admin)).toMatchObject({
      period_kind: 'paid',
      storage_basis: null,
      storage_average: null,
      sampled_storage_bytes: null,
    })
    await period(t, f, sub, {
      storage_basis: undefined,
      storage_bytes: 1234,
      storage_blocks: 0,
      storage_sampled_at: PERIOD,
    })
    expect(await usageOf(t, f.admin)).toMatchObject({
      storage_basis: 'start',
      storage_average: null,
      sampled_storage_bytes: 1234,
      sampled_storage_at: PERIOD,
    })
    // the pending interval after it, and a calendar month
    vi.setSystemTime(Date.parse(END) + 1000)
    expect(await usageOf(t, f.admin)).toMatchObject({
      period_kind: 'pending',
      storage_basis: null,
      storage_average: null,
    })
    await t.run((ctx) =>
      ctx.db.patch(sub._id, { status: 'pending', polar_subscription_id: undefined }),
    )
    expect(await usageOf(t, f.admin)).toMatchObject({
      period_kind: 'month',
      storage_basis: null,
      storage_average: null,
    })
  })

  it("answers an open daily period's average so far from the job's samples, a missing day from the next, and today left out until it is sampled, never 0", async () => {
    const { t, f, sub } = await subscribed(100)
    await period(t, f, sub)
    await runDay(t, '2026-09-15')
    // no run on 16 September, and 400 bytes from the 17th
    await store(t, f, 300)
    await runDay(t, '2026-09-17')
    vi.setSystemTime(at('2026-09-17', '13:00'))
    const average = { bytes: 300, days: 31, measured: 2, estimated: 1, estimated_earlier: 0 }
    expect(await usageOf(t, f.admin)).toMatchObject({
      storage_basis: 'daily',
      sampled_storage_bytes: null,
      sampled_storage_at: null,
      storage_bytes: 400,
      storage_average: { ...average, final: false },
    })
    // the next morning before its run, today has no sample and is left
    // out, never counted as 0
    vi.setSystemTime(at('2026-09-18', '00:10'))
    await store(t, f, 600)
    expect(await usageOf(t, f.admin)).toMatchObject({
      storage_bytes: 1000,
      storage_average: { ...average, final: false },
    })
    // the first day of the period before any sample has no average
    const { t: t2, f: f2, sub: sub2 } = await subscribed(100)
    await period(t2, f2, sub2)
    expect(await usageOf(t2, f2.admin)).toMatchObject({
      storage_basis: 'daily',
      storage_average: { bytes: null, days: 31, measured: 0, estimated: 0, final: false },
    })
  })

  it('answers a recorded daily period from its row, and one recorded without any measurement as null', async () => {
    const { t, f, sub } = await subscribed()
    const row = await period(t, f, sub, {
      storage_bytes: 5_500_000_001,
      storage_blocks: 1,
      storage_sampled_at: '2026-10-15T00:20:00.000Z',
      storage_finalized_at: '2026-10-15T00:20:00.000Z',
      storage_days: [
        { day: '2026-10-13', bytes: 7, from: '2026-10-14' },
        { day: '2026-10-14', bytes: 7 },
        { day: '2026-10-15', bytes: 7, from: '2026-10-14' },
      ],
    })
    vi.setSystemTime(at('2026-10-15', '13:00'))
    expect(await usageOf(t, f.admin)).toMatchObject({
      storage_basis: 'daily',
      sampled_storage_bytes: null,
      sampled_storage_at: null,
      storage_average: {
        bytes: 5_500_000_001,
        days: 3,
        measured: 1,
        estimated: 2,
        estimated_earlier: 1,
        final: true,
      },
    })
    await t.run((ctx) =>
      ctx.db.patch(row, {
        storage_bytes: undefined,
        storage_blocks: undefined,
        storage_sampled_at: undefined,
        storage_unavailable: true,
        storage_days: [{ day: '2026-10-13' }, { day: '2026-10-14' }, { day: '2026-10-15' }],
      }),
    )
    expect(await usageOf(t, f.admin)).toMatchObject({
      storage_average: {
        bytes: null,
        days: 3,
        measured: 0,
        estimated: 0,
        estimated_earlier: 0,
        final: true,
      },
    })
  })

  it("never answers another subscription's or organization's daily row, or the other organization's samples", async () => {
    const { t, f, sub } = await subscribed(100)
    await t.run((ctx) => startOrgTotals(ctx, f.otherOrg.id))
    await plantTotals(t, f.otherOrg.id, [
      { project_id: uuid(), num: 1, name: 'Theirs', bytes: 900 },
    ])
    await runDay(t, '2026-09-15')
    vi.setSystemTime(at('2026-09-15', '13:00'))
    await period(t, f, sub, { subscription_id: 'another-sub' })
    const theirs = await period(t, f, sub, { org_id: f.otherOrg.id })
    expect(await usageOf(t, f.admin)).toMatchObject({
      period_kind: 'paid',
      storage_basis: null,
      storage_average: null,
    })
    // the case that must answer, the organization's own row, from its own
    // sample only
    await t.run((ctx) => ctx.db.delete(theirs))
    await period(t, f, sub)
    expect(await usageOf(t, f.admin)).toMatchObject({
      storage_basis: 'daily',
      storage_average: { bytes: 100, measured: 1 },
    })
  })

  it('reads at most 31 documents more for an open daily period on its last day with 31 samples than for a period sampled at its start', async () => {
    const { t, f, sub } = await subscribed(1000)
    const row = await period(t, f, sub)
    for (let d = 0; d < 31; d++) {
      await store(t, f, 10)
      await runDay(t, new Date(at('2026-09-15') + d * 86_400_000).toISOString().slice(0, 10))
    }
    vi.setSystemTime(at('2026-10-15', '13:00'))
    const daily = await measured(t, (ctx) => usageFiguresOf(ctx, f.org.id))
    expect(daily.out.storage_average).toMatchObject({ days: 31, measured: 31, final: false })
    // the same row sampled at its start
    await t.run((ctx) =>
      ctx.db.patch(row, { storage_basis: undefined, storage_bytes: 1310, storage_blocks: 0 }),
    )
    const start = await measured(t, (ctx) => usageFiguresOf(ctx, f.org.id))
    expect(start.out).toMatchObject({ storage_basis: 'start', sampled_storage_bytes: 1310 })
    console.log('usage figures reads', JSON.stringify({ daily: daily.read, start: start.read }))
    expect(daily.read.documents - start.read.documents).toBeLessThanOrEqual(31)
    expect(daily.read.ranges - start.read.ranges).toBeLessThanOrEqual(1)
  })
})

/* ------------------------------------------------------ order and paging */

describe('Storage by project, order and paging', () => {
  it('pages 60 sub-projects with files 25, 25 and 10, largest first, adding up to current storage', async () => {
    const { t, f } = await counted()
    // bytes 10 to 600 in an order that is not the order of creation, three
    // sub-projects under each of 20 projects, the everyday figure for one
    // project
    const bytes = Array.from({ length: 60 }, (_, i) => (((i * 37) % 60) + 1) * 10)
    for (let i = 0; i < bytes.length; i += 3) {
      const top = await plantProject(t, { org_id: f.org.id, lead_id: f.user.id })
      for (const b of bytes.slice(i, i + 3)) await withFile(t, f, b, { parent_id: top.id })
    }
    const { batches, rows } = await walk(t, f.admin)
    expect(batches.map((b) => b.rows.length)).toEqual([25, 25, 10])
    expect(batches.map((b) => b.stopped)).toEqual([false, false, false])
    expect(batches.map((b) => b.next === null)).toEqual([false, false, true])
    expect(rows.map((r) => r.bytes)).toEqual([...bytes].sort((a, b) => b - a))
    expect(new Set(rows.map((r) => r.project_id)).size).toBe(60)
    expect(rows.every((r) => r.status === 'active' && r.files === 1)).toBe(true)
    const total = rows.reduce((n, r) => n + r.bytes, 0)
    expect(await usageOf(t, f.admin)).toMatchObject({ storage_bytes: total })
    // the mutation check, as a list in creation order would fail the order
    expect(rows.map((r) => r.bytes)).not.toEqual(bytes)
  })

  it('answers each of 30 rows of equal bytes once, newest row first', async () => {
    const { t, f } = await counted()
    const rows = Array.from({ length: 30 }, (_, i) => ({
      project_id: uuid(),
      num: 1000 + i,
      name: `Equal ${i}`,
      bytes: 77,
    }))
    // fifteen in one transaction, then one a transaction. convex-test gives
    // every insert its own creation time, so no two of these rows share an
    // instant; the next case reads inside one
    await plantTotals(t, f.org.id, rows.slice(0, 15))
    for (const row of rows.slice(15)) await plantTotals(t, f.org.id, [row])
    const { batches, rows: got } = await walk(t, f.admin)
    expect(batches.map((b) => b.rows.length)).toEqual([25, 5])
    expect(got.map((r) => r.name)).toEqual(rows.map((r) => r.name).reverse())
    expect(new Set(got.map((r) => r.project_id)).size).toBe(30)
  })

  it('answers the rest of a cursor’s instant at its bytes, then its older rows and the smaller ones', async () => {
    const { t, f } = await counted()
    const rows = ['Larger', 'Newer', 'Held', 'Older', 'Smaller'].map((name, i) => ({
      project_id: uuid(),
      num: 2000 + i,
      name,
      bytes: name === 'Larger' ? 90 : name === 'Smaller' ? 30 : 60,
    }))
    // one a transaction from Smaller to Larger, so of the three rows at 60
    // bytes Newer is the newest and Older the oldest
    for (const row of [...rows].reverse()) await plantTotals(t, f.org.id, [row])
    const held = await t.run(async (ctx) => {
      const all = await ctx.db
        .query('storage_project_totals')
        .withIndex('by_org_bytes', (q) => q.eq('org_id', f.org.id))
        .collect()
      return all.find((r) => r.name === 'Held')!
    })
    // A position inside Held's instant just before Held in descending
    // order, as a cursor reads when Convex gave another row the same
    // creation time with a larger id. Held lies past it, so the batch must
    // answer Held from the cursor's own instant before the older rows.
    const cursor = await namedCursor(STORAGE_PROJECTS_LIST, [f.org.id, ''], {
      key: '',
      tie: [held.bytes, held._creationTime, `${held._id}~`],
    })
    const batch = ready(await t.run((ctx) => storageProjectsBatch(ctx, f.org.id, { cursor })))
    expect(batch.rows.map((r) => r.name)).toEqual(['Held', 'Older', 'Smaller'])
    expect(batch.next).toBeNull()
    // a cursor at Held itself answers only what follows it
    const at = await namedCursor(STORAGE_PROJECTS_LIST, [f.org.id, ''], {
      key: '',
      tie: [held.bytes, held._creationTime, held._id],
    })
    expect(
      ready(await t.run((ctx) => storageProjectsBatch(ctx, f.org.id, { cursor: at }))).rows.map(
        (r) => r.name,
      ),
    ).toEqual(['Older', 'Smaller'])
  })
})

/* ----------------------------------------------------------------- states */

describe('Storage by project, where each project is now', () => {
  installTrashTimers()

  it('labels active, archived, Deleted items and removed projects, a row without a name and a row another project took the id of', async () => {
    const { t, f } = await counted()
    // active
    const fw = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await attach(t, f, fw, 1000)
    // an archived sub-project, and a sub-project of an archived project
    const shelved = await withFile(t, f, 900, { name: 'Shelved', key: 'SHLF' })
    await as(t, f.admin).mutation(api.projects.archive, {
      org_id: f.org.id,
      id: shelved.project.id,
    })
    const oldTop = await plantProject(t, {
      org_id: f.org.id,
      name: 'Old line',
      key: 'OLD',
      lead_id: f.user.id,
    })
    const oldSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: oldTop.id,
      name: 'Old sub',
      key: 'OLDS',
    })
    await attach(t, f, await plantIssue(t, { org_id: f.org.id, project_id: oldSub.id }), 800)
    await as(t, f.admin).mutation(api.projects.archive, { org_id: f.org.id, id: oldTop.id })
    // a deleted sub-project, and a sub-project of a deleted project
    const dropped = await withFile(t, f, 700, { name: 'Dropped', key: 'DROP' })
    await deleteProject(t, f, dropped.project.id)
    const goneTop = await plantProject(t, {
      org_id: f.org.id,
      name: 'Gone line',
      key: 'GONE',
      lead_id: f.user.id,
    })
    const goneSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: goneTop.id,
      name: 'Gone sub',
      key: 'GNS',
    })
    await attach(t, f, await plantIssue(t, { org_id: f.org.id, project_id: goneSub.id }), 600)
    await deleteProject(t, f, goneTop.id)
    await runSteps(t)
    // removed: PCB deleted for good while a task item keeps a subtask's file there
    const root = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const kid = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      parent_id: root.id,
    })
    await attach(t, f, kid, 500)
    await deleteTask(t, f, root.id, { subtask_ids: [kid.id] })
    await runSteps(t)
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const pcb = await itemFor(t, f.sub2.id)
    await as(t, f.admin).mutation(api.deletedItems.purge, { org_id: f.org.id, ids: [pcb.id] })
    await runSteps(t)
    // a row without a copy of its project, and one whose id a live project
    // of another number holds now
    const nameless = uuid()
    const taken = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      name: 'Holder now',
      key: 'HOLD',
    })
    await plantTotals(t, f.org.id, [
      { project_id: nameless, bytes: 400 },
      {
        project_id: dropped.project.id,
        num: dropped.project.num + 1000,
        name: 'Earlier dropped',
        bytes: 350,
      },
      { project_id: taken.id, num: taken.num + 1000, name: 'Earlier owner', bytes: 300 },
    ])

    const { rows } = await walk(t, f.admin)
    const shown = rows.map(({ key, name, status, bytes }) => ({ key, name, status, bytes }))
    expect(shown).toEqual([
      { key: 'FW', name: 'Firmware', status: 'active', bytes: 1000 },
      { key: 'SHLF', name: 'Shelved', status: 'archived', bytes: 900 },
      { key: 'OLDS', name: 'Old sub', status: 'archived', bytes: 800 },
      { key: 'DROP', name: 'Dropped', status: 'deleted', bytes: 700 },
      { key: 'GNS', name: 'Gone sub', status: 'deleted', bytes: 600 },
      { key: null, name: 'Board rev', status: 'removed', bytes: 500 },
      { key: null, name: null, status: 'removed', bytes: 400 },
      { key: null, name: 'Earlier dropped', status: 'removed', bytes: 350 },
      { key: null, name: 'Earlier owner', status: 'removed', bytes: 300 },
    ])
    expect(rows.find((r) => r.project_id === nameless)?.num).toBeNull()
    expect(rows.find((r) => r.project_id === taken.id)?.num).toBe(taken.num + 1000)
    // the live project's name never names the row it does not own
    expect(JSON.stringify(rows)).not.toContain('Holder now')
    expect((await walk(t, f.admin, 'holder')).rows).toEqual([])
    expect((await walk(t, f.admin, 'removed project')).rows).toEqual([])
    expect((await walk(t, f.admin, 'owner earlier')).rows.map((r) => r.project_id)).toEqual([
      taken.id,
    ])
    // the rows add up to current storage, Deleted items included
    expect(await usageOf(t, f.admin)).toMatchObject({
      storage_bytes: rows.reduce((n, r) => n + r.bytes, 0),
    })
  })

  it("never names a row after another organization's live or stored project of the same id and number", async () => {
    const { t, f } = await counted()
    // the other organization's live project, and one of its projects that
    // its admin moved to Deleted items
    const live = f.otherProject
    const dropped = await plantProject(t, {
      org_id: f.otherOrg.id,
      name: 'Elsewhere dropped',
      key: 'OTHD',
      lead_id: f.otherAdmin.id,
    })
    await as(t, f.otherAdmin).mutation(api.projects.deleteDeep, {
      org_id: f.otherOrg.id,
      id: dropped.id,
    })
    await runSteps(t)
    const copy = await t.run((ctx) =>
      ctx.db
        .query('deleted_rows')
        .withIndex('by_row', (q) => q.eq('table', 'projects').eq('row_id', dropped.id))
        .first(),
    )
    expect(copy?.org_id).toBe(f.otherOrg.id)
    expect(copy?.row.table === 'projects' ? copy.row.doc.num : null).toBe(dropped.num)
    // this organization's rows hold the same ids and numbers
    await plantTotals(t, f.org.id, [
      { project_id: live.id, num: live.num, name: 'Own row', bytes: 300 },
      { project_id: dropped.id, num: dropped.num, name: 'Own dropped row', bytes: 200 },
    ])

    const { rows } = await walk(t, f.admin)
    expect(
      rows.map(({ project_id, num, key, name, status }) => ({
        project_id,
        num,
        key,
        name,
        status,
      })),
    ).toEqual([
      { project_id: live.id, num: live.num, key: null, name: 'Own row', status: 'removed' },
      {
        project_id: dropped.id,
        num: dropped.num,
        key: null,
        name: 'Own dropped row',
        status: 'removed',
      },
    ])
    const text = JSON.stringify(rows)
    for (const word of ['Elsewhere', live.key, 'OTHD']) expect(text).not.toContain(word)
  })
})

/* ----------------------------------------------------------------- search */

describe('Storage by project, search', () => {
  it('ignores accents, case and word order over the whole list, in byte order, from this organization only', async () => {
    const { t, f } = await counted()
    await t.run((ctx) => startOrgTotals(ctx, f.otherOrg.id))
    const design = Array.from({ length: 30 }, (_, i) => ({
      project_id: uuid(),
      num: 2000 + i,
      name: `Design lane ${i}`,
      bytes: 100 + ((i * 7) % 30),
    }))
    const filler = Array.from({ length: 40 }, (_, i) => ({
      project_id: uuid(),
      num: 3000 + i,
      name: `Assembly ${i}`,
      bytes: 5000 + i,
    }))
    await plantTotals(t, f.org.id, [
      ...filler,
      ...design,
      { project_id: uuid(), num: 1, name: 'Café Racer', bytes: 50 },
      { project_id: uuid(), num: 2, name: 'Racer café', bytes: 40 },
      { project_id: uuid(), num: 3, name: 'Cafe North', bytes: 30 },
    ])
    await plantTotals(t, f.otherOrg.id, [
      { project_id: uuid(), num: 1, name: 'Café Elsewhere', bytes: 999_999 },
    ])
    const names = async (search: string) => (await walk(t, f.admin, search)).rows.map((r) => r.name)

    expect(await names('cafe')).toEqual(['Café Racer', 'Racer café', 'Cafe North'])
    expect(await names('CAFÉ')).toEqual(['Café Racer', 'Racer café', 'Cafe North'])
    expect(await names('racer cafe')).toEqual(['Café Racer', 'Racer café'])
    expect(await names('north racer')).toEqual([])
    const lanes = await walk(t, f.admin, 'lane design')
    expect(lanes.batches.map((b) => b.rows.length)).toEqual([25, 5])
    expect(lanes.rows.map((r) => r.bytes)).toEqual(design.map((d) => d.bytes).sort((a, b) => b - a))
    // the other organization's list holds only its own row
    expect((await walk(t, f.otherAdmin, 'cafe')).rows.map((r) => r.name)).toEqual([
      'Café Elsewhere',
    ])
  })

  it('misses a row that grows past the cursor between calls and answers again one that shrinks past it', async () => {
    const { t, f } = await counted()
    const rows = Array.from({ length: 30 }, (_, i) => ({
      project_id: uuid(),
      num: 100 + i,
      name: `Row ${i}`,
      bytes: 1000 - i * 10,
    }))
    await plantTotals(t, f.org.id, rows)
    const first = ready(await batchOf(t, f.admin))
    expect(first.rows.map((r) => r.name)).toEqual(rows.slice(0, 25).map((r) => r.name))
    // Row 25 grows past the cursor; Row 0, already answered, shrinks below the rest
    await t.run(async (ctx) => {
      await addToProject(ctx, f.org.id, rows[25].project_id, rows[25].num, {
        bytes: 5000,
        files: 0,
      })
      await addToProject(ctx, f.org.id, rows[0].project_id, rows[0].num, { bytes: -999, files: 0 })
    })
    const next = ready(await batchOf(t, f.admin, { cursor: first.next! }))
    expect(next.rows.map((r) => r.name)).toEqual(['Row 26', 'Row 27', 'Row 28', 'Row 29', 'Row 0'])
    expect(next.next).toBeNull()
  })
})

/* --------------------------------------------------------------- refusals */

describe('Billing storage reads, refusals', () => {
  it('refuse a member, a Viewer, a guest, an admin of another organization, a deactivated admin and an organization being deleted', async () => {
    const { t, f } = await counted()
    await withFile(t, f, 10)
    // each read starts once the one before it is refused, so no refusal
    // lands before its handler is attached
    const refusedBoth = async (by: Doc<'profiles'>, message: RegExp) => {
      await expectRefusal(
        as(t, by).query(api.billing.usageFigures, { org_id: f.org.id }),
        'forbidden',
        message,
      )
      await expectRefusal(
        as(t, by).query(api.billing.storageProjects, { org_id: f.org.id }),
        'forbidden',
        message,
      )
    }
    // the case that must pass, the admin reading both
    expect(await usageOf(t, f.admin)).toMatchObject({ storage_bytes: 10 })
    expect(ready(await batchOf(t, f.admin)).rows).toHaveLength(1)
    for (const by of [f.user, f.viewer, f.guest]) await refusedBoth(by, /admin only/)
    await refusedBoth(f.otherAdmin, /no profile/)
    await t.run((ctx) => ctx.db.patch(f.admin._id, { active: false }))
    await refusedBoth(f.admin, /no profile/)
    await t.run((ctx) => ctx.db.patch(f.admin._id, { active: true }))
    await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        phase: 'profiles',
        created_at: NOW,
      }),
    )
    await refusedBoth(f.admin, /being deleted/)
  })

  it('refuses a search past LIMITS.search and a cursor that is not one of this list, organization and search, before it reads anything', async () => {
    const { t, f } = await counted()
    await t.run((ctx) => startOrgTotals(ctx, f.otherOrg.id))
    const rows = Array.from({ length: 30 }, (_, i) => ({
      project_id: uuid(),
      num: 100 + i,
      name: `Alpha ${i}`,
      bytes: 100 + i,
    }))
    await plantTotals(t, f.org.id, rows)
    await plantTotals(
      t,
      f.otherOrg.id,
      rows.map((r) => ({ ...r, project_id: uuid() })),
    )
    const long = 'a'.repeat(LIMITS.search.max + 1)
    expect(
      await refused(t, (ctx) => storageProjectsBatch(ctx, f.org.id, { search: long })),
    ).toEqual({
      data: { code: 'rule', message: LIMITS.search.refusal },
      ranges: 0,
    })
    // the search at the limit is read
    const atLimit = 'a'.repeat(LIMITS.search.max)
    expect(ready(await batchOf(t, f.admin, { search: atLimit })).rows).toEqual([])

    const plain = ready(await batchOf(t, f.admin)).next!
    const searched = ready(await batchOf(t, f.admin, { search: 'alpha' })).next!
    const theirs = ready(await batchOf(t, f.otherAdmin)).next!
    // the cursors that must open, each with its own list and search
    expect(ready(await batchOf(t, f.admin, { cursor: plain })).rows).toHaveLength(5)
    expect(
      ready(await batchOf(t, f.admin, { search: 'alpha', cursor: searched })).rows,
    ).toHaveLength(5)
    for (const [orgId, a] of [
      [f.org.id, { cursor: 'nope' }],
      [f.org.id, { cursor: searched }],
      [f.org.id, { search: 'alpha', cursor: plain }],
      [f.org.id, { cursor: theirs }],
      [f.otherOrg.id, { cursor: plain }],
    ] as const)
      expect(await refused(t, (ctx) => storageProjectsBatch(ctx, orgId, a))).toEqual({
        data: { code: 'bad_request', message: NOT_STORAGE_CURSOR },
        ranges: 0,
      })
    await expectRefusal(
      batchOf(t, f.admin, { cursor: theirs }),
      'bad_request',
      /start the list again/,
    )
  })

  it('answers counting without reading a project row, also for a later batch', async () => {
    const { t, f } = await counted()
    await plantTotals(
      t,
      f.org.id,
      Array.from({ length: 30 }, (_, i) => ({
        project_id: uuid(),
        num: 100 + i,
        name: `Row ${i}`,
        bytes: 100 + i,
      })),
    )
    const cursor = ready(await batchOf(t, f.admin)).next!
    await t.run(async (ctx) => {
      const org = await orgTotalsRow(ctx, f.org.id)
      await ctx.db.patch(org!._id, { counting: { through: 3 } })
    })
    for (const a of [{}, { cursor }]) {
      const { out, read } = await measured(t, (ctx) => storageProjectsBatch(ctx, f.org.id, a))
      expect(out).toEqual({ state: 'counting' })
      // the organization's totals row alone
      expect(read).toMatchObject({ ranges: 1, documents: 1 })
    }
    // and without a row at all
    await t.run(async (ctx) => {
      const org = await orgTotalsRow(ctx, f.org.id)
      await ctx.db.delete(org!._id)
    })
    const { out, read } = await measured(t, (ctx) => storageProjectsBatch(ctx, f.org.id, {}))
    expect(out).toEqual({ state: 'counting' })
    expect(read).toMatchObject({ ranges: 1, documents: 0 })
  })
})

/* ------------------------------------------------------------- the budget */

describe('Storage by project, the read share', () => {
  it('stops a search under a lowered share with no rows and a next, and reaches the match by following the cursors', async () => {
    const { t, f } = await counted()
    const rows = Array.from({ length: 40 }, (_, i) => ({
      project_id: uuid(),
      num: 100 + i,
      name: named80(`Common ${i}`),
      bytes: 1000 - i,
    }))
    rows[39].name = named80('Zephyrine')
    await plantTotals(t, f.org.id, rows)
    Object.assign(STORAGE_PROJECTS.reads, { documents: 6 })
    const calls: (Read & { rows: number; stopped: boolean; next: boolean })[] = []
    let cursor: string | undefined
    const found: StorageProjectRow[] = []
    for (let i = 0; i < 40; i++) {
      const { out, read } = await measured(t, (ctx) =>
        storageProjectsBatch(ctx, f.org.id, { search: 'zephyrine', cursor }),
      )
      const batch = ready(out)
      calls.push({
        ...read,
        rows: batch.rows.length,
        stopped: batch.stopped,
        next: batch.next !== null,
      })
      // until the match, every batch stopped with no rows and goes on;
      // none claims an end it did not reach
      if (found.length === 0 && batch.rows.length === 0) {
        expect(batch).toMatchObject({ stopped: true })
        expect(batch.next).not.toBeNull()
      }
      found.push(...batch.rows)
      if (batch.next === null) break
      cursor = batch.next
    }
    console.log(
      'storage by project, lowered share, a search for the last row',
      JSON.stringify(calls),
    )
    expect(calls.at(-1)?.next).toBe(false)
    expect(found.map((r) => r.project_id)).toEqual([rows[39].project_id])
    expect(calls.length).toBeGreaterThan(3)
    expect(calls.at(0)).toMatchObject({ rows: 0, stopped: true, next: true })
    // the default share reads the whole search in one call
    Object.assign(STORAGE_PROJECTS.reads, DEFAULT_READS)
    const whole = ready(
      await t.run((ctx) => storageProjectsBatch(ctx, f.org.id, { search: 'zephyrine' })),
    )
    expect(whole).toMatchObject({ next: null, stopped: false })
    expect(whole.rows).toHaveLength(1)
  })
})

/* ------------------------------------------------- reads at the design size */

describe('reads at the design size', () => {
  installTrashTimers()

  it('reads the first batch and a search for the smallest of 1,500 rows in one call each, the 25 largest in Deleted items', async () => {
    const { t, f } = await counted()
    // the 25 largest are sub-projects in Deleted items, so each kept row
    // takes both lookups
    const dropped: Doc<'projects'>[] = []
    for (let i = 0; i < 25; i++)
      dropped.push(
        await plantProject(t, {
          org_id: f.org.id,
          type: 'project',
          parent_id: f.meta.id,
          name: named80(`Dropped ${i}`),
        }),
      )
    for (const p of dropped) await deleteProject(t, f, p.id)
    await runSteps(t)
    const rows: Planted[] = dropped.map((p, i) => ({
      project_id: p.id,
      num: p.num,
      name: p.name,
      bytes: 10_000_000 - i,
    }))
    // 500 live and 1,000 archived sub-projects, summed because one read covers both
    for (let i = rows.length; i < 1500; i++)
      rows.push({
        project_id: uuid(),
        num: 10_000 + i,
        name: named80(i === 1499 ? 'Zephyrine' : `Lane ${i}`),
        bytes: 1_000_000 - i,
      })
    await plantTotals(t, f.org.id, rows)

    const first = await measured(t, (ctx) => storageProjectsBatch(ctx, f.org.id, {}))
    const firstBatch = ready(first.out)
    expect(firstBatch.rows).toHaveLength(LIST_BATCH)
    expect(firstBatch.rows.every((r) => r.status === 'deleted')).toBe(true)
    expect(firstBatch.stopped).toBe(false)
    const search = await measured(t, (ctx) =>
      storageProjectsBatch(ctx, f.org.id, { search: 'zephyrine' }),
    )
    const searchBatch = ready(search.out)
    expect(searchBatch).toMatchObject({ next: null, stopped: false })
    expect(searchBatch.rows.map((r) => r.project_id)).toEqual([rows[1499].project_id])
    console.log(
      'storage by project at the design size',
      JSON.stringify({ firstBatch: first.read, searchSmallest: search.read }),
    )
    for (const read of [first.read, search.read]) {
      expect(read.ranges).toBeLessThan(STORAGE_PROJECTS.reads.ranges)
      expect(read.documents).toBeLessThan(STORAGE_PROJECTS.reads.documents)
      expect(read.bytes).toBeLessThan(STORAGE_PROJECTS.reads.bytes)
    }
  })
})

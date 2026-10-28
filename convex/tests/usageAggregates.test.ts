/* API usage aggregates (schema.ts billing_usage `neg_calls` and `name_key`,
 * billing_usage_accounts and billing_month_totals), which the paged API
 * access and Billing lists and their totals read.
 *
 *   1. Every recorded call ranks its usage row and keeps its account row and
 *      its bucket's total exact: new rows, rows stored before ranks, paid and
 *      month buckets, a REST call through machine auth, deleted credentials,
 *      removed accounts and calls interleaved with the backfill's pages in
 *      any order. convex-test runs one transaction at a time, so each
 *      ordering is one sequence of transactions.
 *   2. The rank indexes read calls descending, then name, with ties broken
 *      by credential, and accounts by calls descending.
 *   3. A new seat never takes the id of a removed account its usage names.
 *   4. internal/usageRanksBackfill: the check, the dry run, a run across
 *      calls and pages, idempotence, repair and what the check reports.
 *
 * Organization deletion, the one-transaction teardown and the Northstar
 * seed are pinned where the rest of their rows are (orgRemovals.test.ts,
 * cascade.test.ts, marketingDemo.test.ts). */

import type { FunctionReturnType } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import type { CheckCursor } from '../internal/usageRanksBackfill'
import * as usageRanks from '../internal/usageRanksBackfill'
import { nameKey } from '../lib/nameKey'
import { sha256hex } from '../machine/auth'
import {
  MONTH_TOTAL_SHARDS,
  monthShard,
  periodCalls,
  recordApiCall,
  usageRanked,
  writeUsageRow,
} from '../model/billingUsage'
import { as, newT, type OrgFixture, type T, uuid, withOrg } from './helpers.setup'

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }

const NOW = '2026-09-20T12:00:00.000Z'
const MONTH = 'month:2026-09'
const AUGUST = 'month:2026-08'
const PERIOD = '2026-09-15T12:00:00.000Z'
const END = '2026-10-15T12:00:00.000Z'
const FREE = '2026-03-02T08:00:00.000Z'

/* A REST call mints nothing, but the auth config reads this secret lazily. */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
g.process ??= { env: {} }
g.process.env.BETTER_AUTH_SECRET ??= 'test-files-secret'

const defaults = { page: { ...usageRanks.BACKFILL_PAGE }, run: { ...usageRanks.RUN } }

beforeEach(() => {
  vi.stubEnv('APP_MODE', '')
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(NOW))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  Object.assign(usageRanks.BACKFILL_PAGE, defaults.page)
  Object.assign(usageRanks.RUN, defaults.run)
})

const hex = (): string => uuid().replace(/-/g, '').padEnd(64, '0')

/** One accepted call of `credential` by `profile`, as machine auth counts it. */
const call = (t: T, profile: Pick<Doc<'profiles'>, 'id'>, credential: string, name = credential) =>
  t.run((ctx) =>
    recordApiCall(ctx, {
      profile_id: profile.id,
      credential_id: credential,
      credential_name: name,
    }),
  )

const all = <Table extends 'billing_usage' | 'billing_usage_accounts' | 'billing_month_totals'>(
  t: T,
  table: Table,
) => t.run((ctx) => ctx.db.query(table).collect())

/** A usage row as releases before ranks stored it. */
const plantLegacyUsage = (
  t: T,
  row: Pick<Doc<'billing_usage'>, 'org_id' | 'profile_id' | 'credential_id' | 'period_start'> & {
    calls: number
    credential_name?: string
  },
) => t.run((ctx) => ctx.db.insert('billing_usage', { credential_name: row.credential_id, ...row }))

/** Checks that bucket `period` of organization `orgId` is ranked and that its
 * account rows, its total and its rank fields are exactly what its usage
 * rows give, and answers that total. */
async function expectExact(t: T, orgId: string, period: string): Promise<number> {
  const usage = (await all(t, 'billing_usage')).filter(
    (row) => row.org_id === orgId && row.period_start === period,
  )
  for (const row of usage)
    expect(row, row.credential_id).toMatchObject({
      neg_calls: -row.calls,
      name_key: nameKey(row.credential_name),
    })
  const perAccount: Record<string, number> = {}
  for (const row of usage)
    perAccount[row.profile_id] = (perAccount[row.profile_id] ?? 0) + row.calls
  const accounts = (await all(t, 'billing_usage_accounts')).filter(
    (row) => row.org_id === orgId && row.period_start === period,
  )
  expect(Object.fromEntries(accounts.map((row) => [row.profile_id, row.calls]))).toEqual(perAccount)
  const calls = usage.reduce((sum, row) => sum + row.calls, 0)
  expect(await t.run((ctx) => usageRanked(ctx, orgId, period))).toBe(true)
  expect(await t.run((ctx) => periodCalls(ctx, orgId, period))).toBe(calls)
  return calls
}

/** A live paid period for the organization, with its plan. */
async function paidPeriod(t: T, f: OrgFixture) {
  await t.run(async (ctx) => {
    const plan = uuid()
    await ctx.db.insert('billing_plans', {
      id: plan,
      name: 'Team',
      currency: 'usd',
      seat_price_cents: 100,
      minimum_seats: 5,
      storage_gb_per_seat: 1,
      minimum_storage_gb: 5,
      api_calls_per_seat: 25_000,
      api_block_size: 25_000,
      api_block_price_cents: 100,
      storage_block_price_cents: 100,
      archived: false,
      created_at: FREE,
    })
    await ctx.db.insert('billing_subscriptions', {
      id: uuid(),
      org_id: f.org.id,
      plan_id: plan,
      status: 'active',
      polar_subscription_id: 'provider-sub',
      current_period_start: PERIOD,
      current_period_end: END,
      billed_seats: 7,
      next_seats: 7,
      cancel_at_period_end: false,
      created_at: FREE,
      updated_at: FREE,
    })
  })
}

/** A personal token of `owner` on their seat `profile_id`, created by them. */
const createToken = (
  t: T,
  owner: Doc<'profiles'>,
  name: string,
  profile_id = owner.id,
  token_hash = hex(),
) =>
  as(t, owner).mutation(api.tokens.createMcpToken, {
    id: uuid(),
    profile_id,
    name,
    token_prefix: 'qvt_0123456',
    token_hash,
    access: 'write',
  })

/* ------------------------------------------------------------- aggregates */

describe('API usage aggregates', () => {
  it('ranks every call’s row and counts it on its account and the month total', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 3; i++) await call(t, f.user, 'mcp_tokens:a', 'Cursor')
    await call(t, f.user, 'mcp_tokens:b', 'Raycast')
    for (let i = 0; i < 2; i++) await call(t, f.agent, 'agent_keys:c', 'GitHub Actions')
    for (let i = 0; i < 2; i++) await call(t, f.admin, 'oauth_connections:d', 'Claude')
    // another organization's calls stay its own
    await call(t, f.otherAdmin, 'mcp_tokens:e', 'Elsewhere')

    expect(await expectExact(t, f.org.id, MONTH)).toBe(8)
    expect(await expectExact(t, f.otherOrg.id, MONTH)).toBe(1)
    const shards = (await all(t, 'billing_month_totals')).filter((row) => row.org_id === f.org.id)
    expect(shards.map((row) => row.shard).sort()).toEqual(
      [...new Set([f.user, f.agent, f.admin].map((p) => monthShard(p.id)))].sort(),
    )
    // a calendar month keeps no billing_usage_totals row
    expect(await t.run((ctx) => ctx.db.query('billing_usage_totals').collect())).toEqual([])
  })

  it('counts a paid period on accounts and keeps its total in billing_usage_totals only', async () => {
    const t = newT()
    const f = await withOrg(t)
    await paidPeriod(t, f)
    for (let i = 0; i < 3; i++) await call(t, f.user, 'mcp_tokens:a', 'Cursor')
    await call(t, f.agent, 'agent_keys:c', 'GitHub Actions')
    expect(await expectExact(t, f.org.id, PERIOD)).toBe(4)
    expect(await all(t, 'billing_month_totals')).toEqual([])
    const totals = await t.run((ctx) => ctx.db.query('billing_usage_totals').collect())
    expect(totals.map((row) => [row.period_start, row.calls])).toEqual([[PERIOD, 4]])
  })

  it('counts a REST call through machine auth', async () => {
    const t = newT()
    const f = await withOrg(t)
    const secret = `qvt_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
    await createToken(t, f.user, 'Shell', f.user.id, await sha256hex(secret))
    for (let i = 0; i < 2; i++) {
      const response = await (
        t as unknown as { fetch(path: string, init?: FetchInit): Promise<{ status: number }> }
      ).fetch('/v1/me', { method: 'GET', headers: { Authorization: `Bearer ${secret}` } })
      expect(response.status).toBe(200)
    }
    expect(await expectExact(t, f.org.id, MONTH)).toBe(2)
    const [row] = await all(t, 'billing_usage')
    expect(row).toMatchObject({ credential_name: 'Shell', name_key: 'shell', neg_calls: -2 })
  })

  it('adds all the calls of a row stored before ranks at its next call, and only then', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantLegacyUsage(t, {
      org_id: f.org.id,
      profile_id: f.user.id,
      credential_id: 'mcp_tokens:a',
      period_start: MONTH,
      calls: 5,
    })
    await plantLegacyUsage(t, {
      org_id: f.org.id,
      profile_id: f.agent.id,
      credential_id: 'agent_keys:c',
      period_start: MONTH,
      calls: 4,
    })
    // not complete, so no reader may take the month's total from its shards
    expect(await t.run((ctx) => usageRanked(ctx, f.org.id, MONTH))).toBe(false)
    expect(await t.run((ctx) => periodCalls(ctx, f.org.id, MONTH))).toBeNull()

    await call(t, f.user, 'mcp_tokens:a')
    const accounts = await all(t, 'billing_usage_accounts')
    expect(accounts.map((row) => [row.profile_id, row.calls])).toEqual([[f.user.id, 6]])
    expect(await t.run((ctx) => usageRanked(ctx, f.org.id, MONTH, f.user.id))).toBe(true)
    expect(await t.run((ctx) => usageRanked(ctx, f.org.id, MONTH, f.agent.id))).toBe(false)
    expect(await t.run((ctx) => periodCalls(ctx, f.org.id, MONTH))).toBeNull()
    // the next call adds one
    await call(t, f.user, 'mcp_tokens:a')
    expect((await all(t, 'billing_usage_accounts'))[0].calls).toBe(7)

    await t.action(internal.internal.usageRanksBackfill.run, { dry_run: false })
    expect(await expectExact(t, f.org.id, MONTH)).toBe(11)
  })

  it('keeps the calls of a deleted credential and a removed account', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { id } = await createToken(t, f.user, 'Zapier')
    for (let i = 0; i < 3; i++) await call(t, f.user, `mcp_tokens:${id}`, 'Zapier')
    await call(t, f.admin, 'mcp_tokens:kept', 'Kept')
    const before = await all(t, 'billing_usage_accounts')
    await as(t, f.user).mutation(api.tokens.deleteMcpToken, { id })
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: f.user.id })
    expect(await t.run((ctx) => ctx.db.get(f.user._id))).toBeNull()
    expect(await all(t, 'billing_usage_accounts')).toEqual(before)
    expect(await expectExact(t, f.org.id, MONTH)).toBe(4)
    // rows a removed account left before ranks are ranked like any other
    const gone = uuid()
    await plantLegacyUsage(t, {
      org_id: f.org.id,
      profile_id: gone,
      credential_id: 'agent_keys:departed',
      period_start: MONTH,
      calls: 7,
    })
    const run = await t.action(internal.internal.usageRanksBackfill.run, { dry_run: false })
    expect(run).toMatchObject({ rows: 1, calls: 7, done: true })
    expect(await expectExact(t, f.org.id, MONTH)).toBe(11)
  })

  it('stays exact however calls and backfill pages interleave', async () => {
    const t = newT()
    const f = await withOrg(t)
    usageRanks.BACKFILL_PAGE.rows = 1
    const people = [f.admin, f.user, f.viewer, f.agent]
    for (const [i, profile] of people.entries())
      await plantLegacyUsage(t, {
        org_id: f.org.id,
        profile_id: profile.id,
        credential_id: `mcp_tokens:legacy-${i}`,
        period_start: MONTH,
        calls: 10 + i,
      })
    // the run's steps, a page read in a query and then its rows ranked by id
    const scan = (cursor: string | null) =>
      t.query(internal.internal.usageRanksBackfill.scan, { cursor })
    const fix = async (ids: Id<'billing_usage'>[]) =>
      await t.mutation(internal.internal.usageRanksBackfill.fix, { ids })
    let next = await scan(null) // finds the first legacy row
    await call(t, f.admin, 'mcp_tokens:legacy-0') // ranks it between the read and the write
    expect(await fix(next.stale)).toEqual({ rows: 0, calls: 0 })
    await call(t, f.viewer, 'mcp_tokens:legacy-2') // absorbs a row the run has not reached
    next = await scan(next.cursor)
    expect(await fix(next.stale)).toEqual({ rows: 1, calls: 11 })
    await call(t, f.admin, 'mcp_tokens:legacy-0') // adds one to a row already ranked
    // calls in parallel, which convex-test runs one after another in any order
    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        call(t, people[i % people.length], `mcp_tokens:${['legacy-1', 'new-a', 'new-b'][i % 3]}`),
      ),
    )
    while (!next.done) {
      next = await scan(next.cursor)
      await fix(next.stale)
    }
    expect(await expectExact(t, f.org.id, MONTH)).toBe(10 + 11 + 12 + 13 + 3 + 24)
    // a second pass finds nothing left
    expect(
      await t.action(internal.internal.usageRanksBackfill.run, { dry_run: true }),
    ).toMatchObject({ rows: 0, calls: 0, done: true })
  })

  it('reads credentials by calls descending, then name, ties broken by credential, and accounts by calls', async () => {
    const t = newT()
    const f = await withOrg(t)
    const calls: [Doc<'profiles'>, string, string, number][] = [
      [f.user, 'mcp_tokens:2', 'beta', 3],
      [f.user, 'mcp_tokens:1', 'Alpha', 3],
      [f.agent, 'agent_keys:9', 'zeta', 1],
      [f.admin, 'oauth_connections:5', 'Émile', 1],
      [f.admin, 'oauth_connections:4', 'emile', 1],
      [f.agent, 'agent_keys:8', 'Gamma', 2],
    ]
    for (const [profile, credential, name, n] of calls)
      for (let i = 0; i < n; i++) await call(t, profile, credential, name)
    const ranked = await t.run((ctx) =>
      ctx.db
        .query('billing_usage')
        .withIndex('by_org_period_rank', (q) => q.eq('org_id', f.org.id).eq('period_start', MONTH))
        .collect(),
    )
    expect(ranked.map((row) => row.credential_id)).toEqual([
      'mcp_tokens:1',
      'mcp_tokens:2',
      'agent_keys:8',
      'oauth_connections:4',
      'oauth_connections:5',
      'agent_keys:9',
    ])
    const agent = await t.run((ctx) =>
      ctx.db
        .query('billing_usage')
        .withIndex('by_org_period_profile_rank', (q) =>
          q.eq('org_id', f.org.id).eq('period_start', MONTH).eq('profile_id', f.agent.id),
        )
        .collect(),
    )
    expect(agent.map((row) => row.credential_name)).toEqual(['Gamma', 'zeta'])
    const accounts = await t.run((ctx) =>
      ctx.db
        .query('billing_usage_accounts')
        .withIndex('by_org_period_calls', (q) => q.eq('org_id', f.org.id).eq('period_start', MONTH))
        .order('desc')
        .collect(),
    )
    expect(accounts.map((row) => [row.profile_id, row.calls])).toEqual([
      [f.user.id, 6],
      [f.agent.id, 3],
      [f.admin.id, 2],
    ])
  })

  it('spreads a month total over its shards by profile', () => {
    // fixed ids, so the spread never depends on chance
    const ids = Array.from(
      { length: 64 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    )
    const shards = ids.map(monthShard)
    expect(ids.map(monthShard)).toEqual(shards)
    for (const shard of shards)
      expect(Number.isInteger(shard) && shard >= 0 && shard < MONTH_TOTAL_SHARDS).toBe(true)
    expect(new Set(shards).size).toBe(MONTH_TOTAL_SHARDS)
  })

  it('never lets a new seat take the id of a removed account its usage still names', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const t = newT()
    const f = await withOrg(t)
    const seat = (org_id: string, id: string, admin: Doc<'profiles'>) =>
      as(t, admin).mutation(api.profiles.create, {
        org_id,
        id,
        name: 'Returning',
        email: `returning-${uuid().slice(0, 8)}@testbed.test`,
        org_role: 'user',
        kind: 'person',
        color: '#7a7ad0',
      })
    const id = uuid()
    await seat(f.org.id, id, f.admin)
    await call(t, { id }, 'mcp_tokens:old', 'Old token')
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    vi.useRealTimers()
    // the removal is over, so only the usage still names the id
    expect(await t.run((ctx) => ctx.db.query('profile_removals').collect())).toEqual([])
    await expect(seat(f.org.id, id, f.admin)).rejects.toThrow(/already exists/)
    expect(await all(t, 'billing_usage_accounts')).toMatchObject([{ profile_id: id, calls: 1 }])
    // another organization keeps its own accounts, so the id is free there
    await seat(f.otherOrg.id, id, f.otherAdmin)
    await call(t, { id }, 'mcp_tokens:new', 'New token')
    const accounts = await all(t, 'billing_usage_accounts')
    expect(accounts.map((row) => [row.org_id, row.profile_id, row.calls])).toEqual([
      [f.org.id, id, 1],
      [f.otherOrg.id, id, 1],
    ])
    // a fresh id in the first organization is fine
    await seat(f.org.id, uuid(), f.admin)
  })

  it('answers no total for an ISO bucket with usage rows and no totals row', async () => {
    const t = newT()
    const f = await withOrg(t)
    expect(await t.run((ctx) => periodCalls(ctx, f.org.id, FREE))).toBe(0)
    await plantLegacyUsage(t, {
      org_id: f.org.id,
      profile_id: f.user.id,
      credential_id: 'mcp_tokens:a',
      period_start: FREE,
      calls: 2,
    })
    expect(await t.run((ctx) => periodCalls(ctx, f.org.id, FREE))).toBeNull()
    await t.run((ctx) =>
      ctx.db.insert('billing_usage_totals', {
        org_id: f.org.id,
        period_start: FREE,
        calls: 2,
        reported_api_blocks: 0,
      }),
    )
    expect(await t.run((ctx) => periodCalls(ctx, f.org.id, FREE))).toBe(2)
  })
})

/* ------------------------------------------------------------- backfill */

describe('internal/usageRanksBackfill', () => {
  /** Usage stored before ranks in a month, the month before it, a paid
   * period with its totals row and an old ISO bucket with its own, in two
   * organizations and for a removed account, beside a month total that
   * releases v0.1.14 and v0.1.15 kept in billing_usage_totals. */
  async function legacy(t: T, f: OrgFixture) {
    const gone = uuid()
    const rows: [string, string, string, string, number][] = [
      [f.org.id, f.user.id, 'mcp_tokens:a', MONTH, 5],
      [f.org.id, f.user.id, 'mcp_tokens:b', MONTH, 2],
      [f.org.id, f.agent.id, 'agent_keys:c', MONTH, 4],
      [f.org.id, gone, 'agent_keys:departed', MONTH, 7],
      [f.org.id, f.user.id, 'mcp_tokens:a', AUGUST, 9],
      [f.org.id, f.admin.id, 'oauth_connections:d', PERIOD, 6],
      [f.org.id, f.user.id, 'mcp_tokens:a', PERIOD, 1],
      [f.org.id, f.user.id, 'mcp_tokens:z', FREE, 3],
      [f.otherOrg.id, f.otherAdmin.id, 'mcp_tokens:e', MONTH, 8],
    ]
    for (const [org_id, profile_id, credential_id, period_start, calls] of rows)
      await plantLegacyUsage(t, { org_id, profile_id, credential_id, period_start, calls })
    await t.run(async (ctx) => {
      for (const [period_start, calls] of [
        [PERIOD, 7],
        [FREE, 3],
        [AUGUST, 2],
      ] as const)
        await ctx.db.insert('billing_usage_totals', {
          org_id: f.org.id,
          period_start,
          calls,
          reported_api_blocks: 0,
        })
    })
    return { gone, rows: rows.length, calls: rows.reduce((sum, row) => sum + row[4], 0) }
  }

  const audits = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.query('platform_audit_log').collect()).filter(
        (row) => row.action === 'usage_ranks_backfill',
      ),
    )
  const check = (t: T) => t.action(internal.internal.usageRanksBackfill.check, {})

  it('checks and dry-runs without writing, then ranks every row exactly once across calls', async () => {
    const t = newT()
    const f = await withOrg(t)
    const planted = await legacy(t, f)
    // a call after the release, on a row the run must then leave alone
    await call(t, f.user, 'mcp_tokens:a')
    const usage = await all(t, 'billing_usage')

    expect(await t.query(internal.internal.usageRanksBackfill.remaining, {})).toEqual({
      rows: planted.rows - 1,
      calls: planted.calls - 5,
      cursor: expect.any(String),
      done: true,
    })
    const before = await check(t)
    expect(before).toMatchObject({
      orgs: 2,
      buckets: 5,
      unranked: 5,
      differing_accounts: 0,
      differing_totals: 0,
      unsettled: 0,
      month_total_rows: 1,
      month_total_buckets: [{ org_id: f.org.id, period: AUGUST }],
      done: true,
    })
    const dry = await t.action(internal.internal.usageRanksBackfill.run, { dry_run: true })
    expect(dry).toEqual({
      dry_run: true,
      rows: planted.rows - 1,
      calls: planted.calls - 5,
      done: true,
      cursor: null,
    })
    expect(await all(t, 'billing_usage')).toEqual(usage)
    expect((await all(t, 'billing_usage_accounts')).map((row) => row.calls)).toEqual([6])
    expect(await audits(t)).toEqual([])

    usageRanks.BACKFILL_PAGE.rows = 2
    usageRanks.RUN.ms = 0
    let ranked = 0
    let added = 0
    let calls = 0
    for (let cursor: string | undefined; ; ) {
      const got = await t.action(internal.internal.usageRanksBackfill.run, {
        dry_run: false,
        cursor,
      })
      calls++
      ranked += got.rows
      added += got.calls
      if (got.done) break
      cursor = got.cursor ?? undefined
      // a call between two calls of the run, on a row it has not reached
      if (calls === 1) await call(t, f.agent, 'agent_keys:c')
    }
    expect(calls).toBeGreaterThan(2)
    // the agent's call ranked its row first, with all four earlier calls
    expect([ranked, added]).toEqual([planted.rows - 2, planted.calls - 5 - 4])
    expect((await audits(t)).length).toBe(calls)

    expect(await expectExact(t, f.org.id, MONTH)).toBe(5 + 1 + 2 + 4 + 1 + 7)
    expect(await expectExact(t, f.org.id, AUGUST)).toBe(9)
    expect(await expectExact(t, f.org.id, PERIOD)).toBe(7)
    expect(await expectExact(t, f.org.id, FREE)).toBe(3)
    expect(await expectExact(t, f.otherOrg.id, MONTH)).toBe(8)
    expect(
      (await all(t, 'billing_usage_accounts')).find((row) => row.profile_id === planted.gone),
    ).toMatchObject({ period_start: MONTH, calls: 7 })

    usageRanks.RUN.ms = defaults.run.ms
    expect(await check(t)).toMatchObject({
      buckets: 5,
      unranked: 0,
      differing_accounts: 0,
      differing_totals: 0,
      unsettled: 0,
      month_total_rows: 1,
      done: true,
    })
    // idempotent
    expect(
      await t.action(internal.internal.usageRanksBackfill.run, { dry_run: false }),
    ).toMatchObject({ rows: 0, calls: 0, done: true })
  })

  it('reports and repairs a rank that drifted from its calls, and reports a total that differs', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 3; i++) await call(t, f.user, 'mcp_tokens:a')
    await call(t, f.agent, 'agent_keys:c')
    expect(await check(t)).toMatchObject({ buckets: 1, differing_accounts: 0, differing_totals: 0 })

    // calls counted on the row alone, as no writer here does
    const [row] = (await all(t, 'billing_usage')).filter((r) => r.profile_id === f.user.id)
    await t.run((ctx) => ctx.db.patch(row._id, { calls: 5 }))
    expect(await t.query(internal.internal.usageRanksBackfill.remaining, {})).toMatchObject({
      rows: 1,
      calls: 2,
    })
    expect(await check(t)).toMatchObject({
      differing_accounts: 1,
      differing_account_rows: [
        { org_id: f.org.id, period: MONTH, profile_id: f.user.id, stored: 3, rows: 5 },
      ],
      // the shards and the account rows still agree, but not the rows
      differing_totals: 1,
      differing_total_buckets: [
        { org_id: f.org.id, period: MONTH, total: 4, accounts: 4, rows: 6 },
      ],
    })
    await t.action(internal.internal.usageRanksBackfill.run, { dry_run: false })
    expect(await expectExact(t, f.org.id, MONTH)).toBe(6)
    expect(await check(t)).toMatchObject({ differing_accounts: 0, differing_totals: 0 })

    const [shard] = await all(t, 'billing_month_totals')
    await t.run((ctx) => ctx.db.patch(shard._id, { calls: shard.calls + 1 }))
    expect(await check(t)).toMatchObject({
      differing_totals: 1,
      differing_total_buckets: [
        { org_id: f.org.id, period: MONTH, total: 7, accounts: 6, rows: 6 },
      ],
    })
  })

  it('reports aggregate rows left in a period that no usage row names', async () => {
    const t = newT()
    const f = await withOrg(t)
    await call(t, f.user, 'mcp_tokens:a')
    await t.run(async (ctx) => {
      // an account row and a month total in August, and an account row in an
      // older ISO period, none of them backed by usage rows
      for (const [period_start, calls] of [
        [AUGUST, 3],
        [FREE, 2],
      ] as const)
        await ctx.db.insert('billing_usage_accounts', {
          org_id: f.org.id,
          period_start,
          profile_id: f.user.id,
          calls,
        })
      await ctx.db.insert('billing_month_totals', {
        org_id: f.org.id,
        period_start: AUGUST,
        shard: monthShard(f.user.id),
        calls: 3,
        writes: 1,
      })
    })
    const result = await check(t)
    expect(result).toMatchObject({
      buckets: 3,
      unranked: 0,
      differing_accounts: 2,
      differing_totals: 2,
    })
    expect(result.differing_account_rows).toEqual([
      { org_id: f.org.id, period: FREE, profile_id: f.user.id, stored: 2, rows: 0 },
      { org_id: f.org.id, period: AUGUST, profile_id: f.user.id, stored: 3, rows: 0 },
    ])
    expect(result.differing_total_buckets).toEqual([
      { org_id: f.org.id, period: FREE, total: 0, accounts: 2, rows: 0 },
      { org_id: f.org.id, period: AUGUST, total: 3, accounts: 3, rows: 0 },
    ])
  })

  it('lists each gone organization once, past the listed ones too', async () => {
    const t = newT()
    const f = await withOrg(t)
    await call(t, f.user, 'mcp_tokens:a')
    usageRanks.BACKFILL_PAGE.listed = 1
    usageRanks.RUN.orgs = 1
    const gone = [uuid(), uuid(), uuid()]
    await t.run(async (ctx) => {
      // the first in both tables, the second in accounts, the third in totals
      for (const org_id of gone.slice(0, 2))
        await ctx.db.insert('billing_usage_accounts', {
          org_id,
          period_start: MONTH,
          profile_id: uuid(),
          calls: 3,
        })
      for (const org_id of [gone[0], gone[2]])
        await ctx.db.insert('billing_month_totals', {
          org_id,
          period_start: MONTH,
          shard: 0,
          calls: 3,
          writes: 1,
        })
    })
    const result = await check(t)
    expect(result).toMatchObject({
      buckets: 1,
      differing_accounts: 0,
      differing_totals: 0,
      gone_orgs: 3,
      done: true,
    })
    expect(result.gone_org_ids).toHaveLength(1)
    expect(gone).toContain(result.gone_org_ids[0])
  })

  type CheckAnswer = FunctionReturnType<typeof internal.internal.usageRanksBackfill.check>

  /** `check` called again with each cursor it answers, unchanged, until
   * done. It answers the counts and lists of all calls together, and every cursor. */
  async function checkInCalls(t: T, between?: (cursor: CheckCursor) => Promise<void>) {
    const totals: Record<string, number> = {}
    const lists: Record<string, unknown[]> = {}
    const cursors: CheckCursor[] = []
    for (let cursor: CheckCursor | null = null; ; ) {
      const got: CheckAnswer = await t.action(internal.internal.usageRanksBackfill.check, {
        cursor,
      })
      for (const [key, value] of Object.entries(got))
        if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value
        else if (Array.isArray(value)) lists[key] = [...(lists[key] ?? []), ...value]
      if (got.done) return { totals, lists, cursors }
      cursor = got.cursor
      if (cursor === null) throw new Error('an unfinished check answered no cursor')
      cursors.push(cursor)
      await between?.(cursor)
    }
  }

  it('stops between any two queries, inside an organization and a bucket, and goes on from there', async () => {
    const t = newT()
    const f = await withOrg(t)
    await paidPeriod(t, f)
    for (const profile of [f.admin, f.user, f.viewer])
      await call(t, profile, `mcp_tokens:${profile.id}`)
    // once the provider subscription is gone, calls count in September's month
    await t.run(async (ctx) => {
      for (const sub of await ctx.db.query('billing_subscriptions').collect())
        await ctx.db.patch(sub._id, { polar_subscription_id: undefined })
    })
    for (const profile of [f.user, f.agent]) await call(t, profile, `mcp_tokens:${profile.id}`)
    await call(t, f.otherAdmin, 'mcp_tokens:e')
    await t.run((ctx) =>
      ctx.db.insert('billing_usage_accounts', {
        org_id: uuid(),
        period_start: MONTH,
        profile_id: uuid(),
        calls: 1,
      }),
    )
    const whole = await check(t)

    usageRanks.BACKFILL_PAGE.rows = 1
    usageRanks.BACKFILL_PAGE.accounts = 1
    usageRanks.RUN.orgs = 1
    usageRanks.RUN.ms = 0
    const split = await checkInCalls(t)
    // one query a call, so it stopped inside every step
    expect(split.cursors.some((c) => c.org !== null && c.bucket?.start != null)).toBe(true)
    expect(split.cursors.some((c) => c.bucket !== null && c.bucket.rows_cursor !== null)).toBe(true)
    expect(split.cursors.some((c) => c.bucket !== null && c.bucket.accounts_after !== null)).toBe(
      true,
    )
    expect(split.cursors.some((c) => c.gone !== null)).toBe(true)
    expect(whole).toMatchObject({ orgs: 2, buckets: 3, gone_orgs: 1, done: true })
    for (const key of [
      'orgs',
      'buckets',
      'unranked',
      'differing_accounts',
      'differing_totals',
      'unsettled',
      'gone_orgs',
    ])
      expect(split.totals[key], key).toBe(whole[key as keyof typeof whole])
  })

  it('lists a bucket written while it was read, even when its total comes back', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 3; i++) await call(t, f.user, 'mcp_tokens:a')
    await call(t, f.agent, 'agent_keys:c')
    usageRanks.BACKFILL_PAGE.rows = 1
    usageRanks.RUN.ms = 0
    let touched = false
    const split = await checkInCalls(t, async (cursor) => {
      if (touched || cursor.bucket?.start == null) return
      touched = true
      // one call fewer, then one more, for the same total after two writes
      const row = (await all(t, 'billing_usage')).find((r) => r.profile_id === f.user.id)
      if (row === undefined) throw new Error('the usage row vanished')
      await t.run((ctx) => writeUsageRow(ctx, row, row, row.calls - 1, row.credential_name))
      await call(t, f.user, 'mcp_tokens:a')
    })
    expect(touched).toBe(true)
    expect(split.totals).toMatchObject({ buckets: 1, unsettled: 1, differing_totals: 0 })
    expect(split.lists.unsettled_buckets).toEqual([{ org_id: f.org.id, period: MONTH }])
    // read again with nothing moving, it is settled and exact
    usageRanks.RUN.ms = defaults.run.ms
    expect(await check(t)).toMatchObject({ unsettled: 0, differing_totals: 0, done: true })
  })

  it('records what committed and answers the page to read again when a batch fails', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantLegacyUsage(t, {
      org_id: f.org.id,
      profile_id: f.user.id,
      credential_id: 'mcp_tokens:a',
      period_start: MONTH,
      calls: 5,
    })
    await plantLegacyUsage(t, {
      org_id: f.org.id,
      profile_id: f.agent.id,
      credential_id: 'agent_keys:c',
      period_start: MONTH,
      calls: 4,
    })
    // two account rows for one account, which no write to it accepts
    const twins = await t.run(async (ctx) => {
      const row = { org_id: f.org.id, period_start: MONTH, profile_id: f.agent.id, calls: 0 }
      return [
        await ctx.db.insert('billing_usage_accounts', row),
        await ctx.db.insert('billing_usage_accounts', row),
      ]
    })
    usageRanks.BACKFILL_PAGE.rows = 1
    const failed = await t.action(internal.internal.usageRanksBackfill.run, { dry_run: false })
    expect(failed).toMatchObject({
      rows: 1,
      calls: 5,
      done: false,
      cursor: expect.any(String),
      error: expect.any(String),
    })
    expect(await audits(t)).toMatchObject([{ detail: { rows: 1, calls: 5 } }])
    await t.run((ctx) => ctx.db.delete(twins[1]))
    expect(
      await t.action(internal.internal.usageRanksBackfill.run, {
        dry_run: false,
        cursor: failed.cursor,
      }),
    ).toMatchObject({ rows: 1, calls: 4, done: true })
    expect(await expectExact(t, f.org.id, MONTH)).toBe(9)
  })
})

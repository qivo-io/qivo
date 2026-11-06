/* Billing's bounded reads: the usage figures (billing.usageFigures,
 * model/billing.ts usageFiguresOf), API calls by account
 * (billing.apiAccounts, model/billingLists.ts apiAccountsBatch) and the
 * names of who counts toward the bill and who does not
 * (billing.accountList, accountNamesBatch).
 *
 *   1. The figures' calls come from the bucket's aggregates, equal to the
 *      usage rows' sum and to API access, or null while they are not
 *      complete, never 0; the allowance equals API access's; the reads do
 *      not grow with the usage rows, and the roster is walked only when the
 *      subscription has no billed seats.
 *   2. API calls by account pages 25 at a time, most calls first, equal
 *      calls each once, without rows at 0 calls, adding up to the figures.
 *   3. It names a removed account or another organization's profile
 *      "Removed user", and its search matches the shown name only.
 *   4. It reads only the asked bucket of the caller's organization, and
 *      refuses a foreign cursor and a long period before it reads a row.
 *   5. Calls that cross the cursor between batches, `counting`, and a
 *      lowered read share.
 *   6. The name lists page in name order with a search, answer
 *      `not_ready` without name keys, and stop under a lowered share.
 *   7. All four queries refuse anyone but an active admin of the
 *      organization and an organization being deleted (the demo's refusal
 *      is in demo.test.ts, and billing.test.ts holds the other callers).
 *   8. The reads at the design size, logged for the docstrings.
 *
 * Usage is written through the real path, recordApiCall or writeUsageRow
 * as the Northstar seed writes exact values, so the account rows and month
 * shards move with the usage rows. Only the counting case plants a usage
 * row of its own, unranked, as one stored before the ranks existed. */

import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { AccountNames, ApiAccountRow, ApiAccounts } from '../lib/billingTypes'
import type { Refusal } from '../lib/functions'
import { LIMITS, LIST_BATCH } from '../lib/limits'
import { namedCursor } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { billingDetailsOf, usageFiguresOf } from '../model/billing'
import {
  ACCOUNT_NAMES,
  ACCOUNT_NAMES_LIST,
  API_ACCOUNTS,
  API_ACCOUNTS_LIST,
  accountNamesBatch,
  apiAccountsBatch,
  NOT_A_PERIOD,
  NOT_ACCOUNTS_CURSOR,
  NOT_NAMES_CURSOR,
  PERIOD_KEY_MAX,
} from '../model/billingLists'
import { STORAGE_PROJECTS_LIST } from '../model/billingStorage'
import { recordApiCall, writeUsageRow } from '../model/billingUsage'
import { startOrgTotals } from '../model/storageTotals'
import { as, expectRefusal, newT, type OrgFixture, type T, uuid, withOrg } from './helpers.setup'

const NOW = Date.parse('2026-09-20T12:00:00.000Z')
const SEPTEMBER = 'month:2026-09'
const AUGUST = 'month:2026-08'
const PERIOD = '2026-09-15T12:00:00.000Z'
const END = '2026-10-15T12:00:00.000Z'
const STAMP = '2026-09-01T00:00:00.000Z'

const DEFAULT_ACCOUNTS = { ...API_ACCOUNTS.reads }
const DEFAULT_NAMES = { ...ACCOUNT_NAMES.reads }

beforeEach(() => {
  vi.stubEnv('BILLING_ENABLED', 'true')
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})
afterEach(() => {
  Object.assign(API_ACCOUNTS.reads, DEFAULT_ACCOUNTS)
  Object.assign(ACCOUNT_NAMES.reads, DEFAULT_NAMES)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

/* ---------------------------------------------------------------- helpers */

/** A person or agent of `orgId` with `name`, its name key, and `extra`. */
const person = (orgId: string, name: string, extra: Partial<Doc<'profiles'>> = {}) => ({
  id: uuid(),
  org_id: orgId,
  name,
  name_key: nameKey(name),
  initials: 'PL',
  color: '#7a7ad0',
  org_role: 'user' as const,
  active: true,
  kind: 'person' as const,
  plannable_hours: 40,
  created_at: STAMP,
  ...extra,
})

/** Inserts `people`, 250 a transaction, and answers their ids in order. */
async function plantPeople(t: T, people: ReturnType<typeof person>[]): Promise<string[]> {
  for (let i = 0; i < people.length; i += 250)
    await t.run(async (ctx) => {
      for (const p of people.slice(i, i + 250)) await ctx.db.insert('profiles', p)
    })
  return people.map((p) => p.id)
}

/** Gives every profile of `orgId` its name key and marks the organization
 * keyed, as the name keys backfill leaves it. */
const keyed = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const profiles = await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    for (const p of profiles) await ctx.db.patch(p._id, { name_key: nameKey(p.name) })
    await ctx.db.insert('org_ready', { org_id: orgId, name_keys_at: STAMP })
  })

/** One account's calls to write: its profile, the exact calls of its one
 * credential, and the bucket. */
type Usage = { profile: string; calls: number; period?: string; credential?: string }

/** Sets each credential's calls to the exact figure through writeUsageRow,
 * as the Northstar seed writes them, 250 a transaction, so the account rows
 * and the month's shards move with the usage rows. */
async function setCalls(t: T, orgId: string, usage: readonly Usage[]): Promise<void> {
  for (let i = 0; i < usage.length; i += 250)
    await t.run(async (ctx) => {
      for (const u of usage.slice(i, i + 250)) {
        const key = {
          org_id: orgId,
          profile_id: u.profile,
          credential_id: u.credential ?? `${u.profile}:key`,
          period_start: u.period ?? SEPTEMBER,
        }
        const row = await ctx.db
          .query('billing_usage')
          .withIndex('by_subject_credential_period', (q) =>
            q
              .eq('org_id', key.org_id)
              .eq('profile_id', key.profile_id)
              .eq('credential_id', key.credential_id)
              .eq('period_start', key.period_start),
          )
          .unique()
        await writeUsageRow(ctx, row, key, u.calls, 'Key')
      }
    })
}

/** A plan with one GB of storage per seat and no minimum beyond one seat,
 * so the included storage shows the seats it was sized by. */
const plantPlan = (t: T) =>
  t.run(async (ctx) => {
    const id = uuid()
    await ctx.db.insert('billing_plans', {
      id,
      name: 'Team',
      currency: 'usd',
      seat_price_cents: 100,
      minimum_seats: 1,
      storage_gb_per_seat: 1,
      minimum_storage_gb: 1,
      api_calls_per_seat: 10,
      api_block_size: 2,
      api_block_price_cents: 100,
      storage_block_price_cents: 100,
      archived: false,
      created_at: STAMP,
    })
    return id
  })

/** A subscription of `orgId` on `planId` with `fields`, a live paid period
 * from PERIOD to END unless they say otherwise. */
const plantSub = (
  t: T,
  orgId: string,
  planId: string,
  fields: Partial<Doc<'billing_subscriptions'>> = {},
) =>
  t.run(async (ctx) => {
    const id = await ctx.db.insert('billing_subscriptions', {
      id: uuid(),
      org_id: orgId,
      plan_id: planId,
      status: 'active',
      polar_subscription_id: 'provider-sub',
      current_period_start: PERIOD,
      current_period_end: END,
      billed_seats: 2,
      next_seats: 7,
      cancel_at_period_end: false,
      created_at: STAMP,
      updated_at: STAMP,
      ...fields,
    })
    return (await ctx.db.get(id)) as Doc<'billing_subscriptions'>
  })

/** One batch of API calls by account as `by` reads it. */
const accountsOf = (
  t: T,
  by: Doc<'profiles'>,
  a: { period?: string; search?: string; cursor?: string } = {},
) => as(t, by).query(api.billing.apiAccounts, { org_id: by.org_id, period: SEPTEMBER, ...a })

/** One batch of an account name list as `by` reads it. */
const namesOf = (
  t: T,
  by: Doc<'profiles'>,
  a: { kind: 'billable' | 'non_billable'; search?: string; cursor?: string },
) => as(t, by).query(api.billing.accountList, { org_id: by.org_id, ...a })

/** Billing's figures as `by` reads them. */
const figuresOf = (t: T, by: Doc<'profiles'>) =>
  as(t, by).query(api.billing.usageFigures, { org_id: by.org_id })

/** `answer` when it is ready, else a failure. */
function ready<A extends ApiAccounts | AccountNames>(answer: A): Extract<A, { state: 'ready' }> {
  if (answer.state !== 'ready') throw new Error(`the list answered ${answer.state}`)
  return answer as Extract<A, { state: 'ready' }>
}

/** A batch of one of these lists that answered rows. */
type Ready<Row> = { state: 'ready'; rows: Row[]; next: string | null; stopped: boolean }

/** Every batch of a list from its start, following each `next`. */
async function walk<Row>(
  read: (cursor: string | undefined) => Promise<Ready<Row> | { state: 'counting' | 'not_ready' }>,
) {
  const batches: Ready<Row>[] = []
  let cursor: string | undefined
  for (let i = 0; i < 200; i++) {
    const batch = await read(cursor)
    if (batch.state !== 'ready') throw new Error(`the list answered ${batch.state}`)
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

/** `count` people of `f.org` named `Account n`, with calls `calls(n)` each
 * in September on one credential, and their ids. */
async function accounts(t: T, f: OrgFixture, count: number, calls: (n: number) => number) {
  const ids = await plantPeople(
    t,
    Array.from({ length: count }, (_, n) => person(f.org.id, `Account ${n}`)),
  )
  await setCalls(
    t,
    f.org.id,
    ids.map((profile, n) => ({ profile, calls: calls(n) })),
  )
  return ids
}

/** The calls of the usage rows of organization `orgId` in bucket `period`,
 * summed, as the aggregates must answer them. */
const rowCalls = (t: T, orgId: string, period: string) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('billing_usage')
        .withIndex('by_org_period', (q) => q.eq('org_id', orgId).eq('period_start', period))
        .collect()
    ).reduce((sum, row) => sum + row.calls, 0),
  )

/* ------------------------------------------------------------ the figures */

describe('the usage figures', () => {
  it("answer a month's calls from its shards, equal to the usage rows and API access", async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => startOrgTotals(ctx, f.org.id))
    // through the call path, three accounts over five credentials
    for (const [profile, credential, n] of [
      [f.agent.id, 'agent-key', 4],
      [f.user.id, 'token', 2],
      [f.user.id, 'oauth', 1],
      [f.admin.id, 'token', 3],
      [f.admin.id, 'other', 1],
    ] as const)
      for (let i = 0; i < n; i++)
        await t.run((ctx) =>
          recordApiCall(ctx, {
            profile_id: profile,
            credential_id: credential,
            credential_name: credential,
          }),
        )
    const figures = await figuresOf(t, f.admin)
    const access = await as(t, f.admin).query(api.apiAccess.summary, { org_id: f.org.id })
    if (access.state !== 'ready') throw new Error('API access answered no period')
    expect(figures).toMatchObject({ period_kind: 'month', period_key: SEPTEMBER, calls: 11 })
    expect(figures.calls).toBe(await rowCalls(t, f.org.id, SEPTEMBER))
    expect(figures.calls).toBe(access.summary.calls)
    expect(figures.included_calls).toBe(access.summary.included_calls)
    // the figures hold no account list
    expect(figures).not.toHaveProperty('users')
  })

  it("answer a paid bucket's calls from its totals row, and null, never 0, for a month with an unranked row or a paid bucket without its totals row", async () => {
    const t = newT()
    const f = await withOrg(t)
    const plan = await plantPlan(t)
    await plantSub(t, f.org.id, plan)
    for (let i = 0; i < 3; i++)
      await t.run((ctx) =>
        recordApiCall(ctx, { profile_id: f.agent.id, credential_id: 'k', credential_name: 'k' }),
      )
    expect(await figuresOf(t, f.admin)).toMatchObject({
      period_kind: 'paid',
      period_key: PERIOD,
      calls: 3,
    })
    // the case that must fail: the bucket's totals row gone, its rows kept
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('billing_usage_totals').collect())
        await ctx.db.delete(row._id)
    })
    expect((await figuresOf(t, f.admin)).calls).toBeNull()
    // the rows are still there and sum to 3
    expect(await rowCalls(t, f.org.id, PERIOD)).toBe(3)

    // a month: ranked rows answer, one row stored before the ranks did not
    const g = await withOrg(t)
    await setCalls(t, g.org.id, [{ profile: g.agent.id, calls: 5 }])
    expect((await figuresOf(t, g.admin)).calls).toBe(5)
    await t.run((ctx) =>
      ctx.db.insert('billing_usage', {
        org_id: g.org.id,
        profile_id: g.user.id,
        credential_id: 'old',
        credential_name: 'Old key',
        period_start: SEPTEMBER,
        calls: 2,
      }),
    )
    const counting = await figuresOf(t, g.admin)
    expect(counting.calls).toBeNull()
    expect(counting.calls).not.toBe(0)
  })

  it('size the allowance from billed seats without the roster, and from the roster without them, equal to API access', async () => {
    const t = newT()
    const f = await withOrg(t)
    const plan = await plantPlan(t)
    await t.run((ctx) =>
      ctx.db.insert('billing_settings', { key: 'default', default_plan_id: plan }),
    )
    const extra = () =>
      plantPeople(
        t,
        Array.from({ length: 20 }, (_, n) => person(f.org.id, `Extra ${n}`)),
      )
    const compare = async () => {
      const figures = await figuresOf(t, f.admin)
      const access = await as(t, f.admin).query(api.apiAccess.summary, { org_id: f.org.id })
      if (access.state !== 'ready') throw new Error('API access answered no period')
      expect(access.summary.included_calls).toBe(figures.included_calls)
      return figures
    }
    const documents = async () =>
      (await measured(t, (ctx) => usageFiguresOf(ctx, f.org.id))).read.documents

    // no subscription: the default plan, sized by withOrg's five billable
    // users
    expect(await compare()).toMatchObject({
      included_calls: 50,
      included_storage_bytes: 5_000_000_000,
    })
    const before = await documents()
    await extra()
    // the roster decides, so the read grows with it
    expect(await documents()).toBe(before + 20)
    expect(await compare()).toMatchObject({
      included_calls: 250,
      included_storage_bytes: 25_000_000_000,
    })

    // a subscription that has billed no seat yet: seats from the roster,
    // calls from the seats it will bill
    const sub = await plantSub(t, f.org.id, plan, { billed_seats: 0, next_seats: 7 })
    expect(await compare()).toMatchObject({
      included_calls: 70,
      included_storage_bytes: 25_000_000_000,
    })

    // billed seats decide both figures, and the roster is not read
    await t.run((ctx) => ctx.db.patch(sub._id, { billed_seats: 2 }))
    expect(await compare()).toMatchObject({
      included_calls: 20,
      included_storage_bytes: 2_000_000_000,
    })
    const billed = await documents()
    await extra()
    expect(await documents()).toBe(billed)
  })

  it('read as many documents with 30 usage rows as with 3, the accounts kept and the credentials varied', async () => {
    const t = newT()
    const f = await withOrg(t)
    const three = [f.agent.id, f.user.id, f.admin.id]
    await setCalls(
      t,
      f.org.id,
      three.map((profile) => ({ profile, calls: 2 })),
    )
    const few = await measured(t, (ctx) => usageFiguresOf(ctx, f.org.id))
    // the same three accounts, nine more credentials each
    await setCalls(
      t,
      f.org.id,
      three.flatMap((profile) =>
        Array.from({ length: 9 }, (_, n) => ({ profile, calls: 1, credential: `${profile}:${n}` })),
      ),
    )
    const many = await measured(t, (ctx) => usageFiguresOf(ctx, f.org.id))
    expect(await t.run((ctx) => ctx.db.query('billing_usage').collect())).toHaveLength(30)
    expect(few.out.calls).toBe(6)
    expect(many.out.calls).toBe(33)
    expect(many.read.documents).toBe(few.read.documents)
    expect(many.read.ranges).toBe(few.read.ranges)
  })
})

/* ----------------------------------------------------- API calls by account */

describe('API calls by account, order and paging', () => {
  it('pages 60 accounts 25, 25 and 10, most calls first, adding up to the figures', async () => {
    const t = newT()
    const f = await withOrg(t)
    // calls 1 to 60 in an order that is not the order of creation
    const ids = await accounts(t, f, 60, (n) => ((n * 37) % 60) + 1)
    const { batches, rows } = await walk((cursor) => accountsOf(t, f.admin, { cursor }))
    expect(batches.map((b) => b.rows.length)).toEqual([25, 25, 10])
    expect(batches.map((b) => b.next === null)).toEqual([false, false, true])
    expect(batches.every((b) => !b.stopped)).toBe(true)
    expect(rows.map((r) => r.calls)).toEqual(Array.from({ length: 60 }, (_, i) => 60 - i))
    expect(new Set(rows.map((r) => r.profile_id))).toEqual(new Set(ids))
    expect(rows.every((r) => !r.removed && r.name.startsWith('Account '))).toBe(true)
    const sum = rows.reduce((n, r) => n + r.calls, 0)
    expect((await figuresOf(t, f.admin)).calls).toBe(sum)
  })

  it('answers each of 30 accounts of equal calls once, in descending profile id order, and leaves out an account at 0 calls', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ids = await accounts(t, f, 30, () => 4)
    // an account brought to 0 by an exact write, as a reseed can leave it
    await setCalls(t, f.org.id, [{ profile: f.agent.id, calls: 3 }])
    await setCalls(t, f.org.id, [{ profile: f.agent.id, calls: 0 }])
    const zero = await t.run((ctx) =>
      ctx.db
        .query('billing_usage_accounts')
        .withIndex('by_org_period_profile', (q) =>
          q.eq('org_id', f.org.id).eq('period_start', SEPTEMBER).eq('profile_id', f.agent.id),
        )
        .unique(),
    )
    expect(zero?.calls).toBe(0)
    const { batches, rows } = await walk((cursor) => accountsOf(t, f.admin, { cursor }))
    expect(batches.map((b) => b.rows.length)).toEqual([25, 5])
    expect(rows.map((r) => r.profile_id)).toEqual([...ids].sort().reverse())
    expect(rows.map((r) => r.profile_id)).not.toContain(f.agent.id)
  })
})

describe('API calls by account, names and search', () => {
  it('names a removed account and an id of another organization’s profile Removed user, and a search never matches that profile’s own name', async () => {
    const t = newT()
    const f = await withOrg(t)
    const gone = await plantPeople(t, [person(f.org.id, 'Departed Analyst')])
    await setCalls(t, f.org.id, [
      { profile: gone[0], calls: 9 },
      // usage of this organization that names the other organization's admin
      { profile: f.otherAdmin.id, calls: 7 },
      { profile: f.user.id, calls: 5 },
    ])
    await t.run(async (ctx) => {
      const p = await ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', gone[0]))
        .unique()
      await ctx.db.delete(p!._id)
    })
    const rows = ready(await accountsOf(t, f.admin)).rows
    expect(rows).toEqual([
      { profile_id: gone[0], name: 'Removed user', removed: true, calls: 9 },
      { profile_id: f.otherAdmin.id, name: 'Removed user', removed: true, calls: 7 },
      { profile_id: f.user.id, name: f.user.name, removed: false, calls: 5 },
    ])
    expect(JSON.stringify(rows)).not.toContain(f.otherAdmin.name)
    // the case that must fail: the other organization's name finds nothing
    expect(ready(await accountsOf(t, f.admin, { search: f.otherAdmin.name })).rows).toEqual([])
    expect(ready(await accountsOf(t, f.admin, { search: 'departed' })).rows).toEqual([])
    // the shown name matches, as API access's credential search matches a
    // removed owner
    expect(
      ready(await accountsOf(t, f.admin, { search: 'removed' })).rows.map((r) => r.profile_id),
    ).toEqual([gone[0], f.otherAdmin.id])
  })

  it('ignores accents, case and word order over the whole list, from this organization and bucket only', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ids = await plantPeople(t, [
      person(f.org.id, 'Zoë relay agent'),
      person(f.org.id, 'Relay Zephyr'),
      ...Array.from({ length: 30 }, (_, n) => person(f.org.id, `Bench match ${n}`)),
    ])
    const [zoe, zephyr, ...bench] = ids
    // the bench accounts call most, so Zoë comes after them
    await setCalls(t, f.org.id, [
      { profile: zoe, calls: 2 },
      { profile: zephyr, calls: 1 },
      ...bench.map((profile, n) => ({ profile, calls: 100 + n })),
      // August's usage of the same names is not this bucket's
      { profile: zephyr, calls: 50, period: AUGUST },
    ])
    // the other organization's accounts with the same words
    const theirs = await plantPeople(t, [person(f.otherOrg.id, 'Zoë relay elsewhere')])
    await setCalls(t, f.otherOrg.id, [{ profile: theirs[0], calls: 3 }])

    expect(ready(await accountsOf(t, f.admin, { search: 'zoe' })).rows).toEqual([
      { profile_id: zoe, name: 'Zoë relay agent', removed: false, calls: 2 },
    ])
    expect(
      ready(await accountsOf(t, f.admin, { search: 'RELAY zoë' })).rows.map((r) => r.profile_id),
    ).toEqual([zoe])
    expect(
      ready(await accountsOf(t, f.admin, { search: 'relay' })).rows.map((r) => r.profile_id),
    ).toEqual([zoe, zephyr])
    // 30 matches answered 25 and 5, most calls first
    const { batches, rows } = await walk((cursor) =>
      accountsOf(t, f.admin, { search: 'bench match', cursor }),
    )
    expect(batches.map((b) => b.rows.length)).toEqual([25, 5])
    expect(rows.map((r) => r.calls)).toEqual(Array.from({ length: 30 }, (_, i) => 129 - i))
    // August holds Zephyr alone
    expect(ready(await accountsOf(t, f.admin, { period: AUGUST })).rows).toEqual([
      { profile_id: zephyr, name: 'Relay Zephyr', removed: false, calls: 50 },
    ])
  })
})

describe('API calls by account, the bucket and the cursors', () => {
  it('reads only the asked bucket, answers an empty list for a key with no bucket, and refuses a long period', async () => {
    const t = newT()
    const f = await withOrg(t)
    await setCalls(t, f.org.id, [
      { profile: f.user.id, calls: 4, period: AUGUST },
      { profile: f.agent.id, calls: 2 },
    ])
    expect(ready(await accountsOf(t, f.admin)).rows.map((r) => r.profile_id)).toEqual([f.agent.id])
    expect(await accountsOf(t, f.admin, { period: 'month:2031-01' })).toEqual({
      state: 'ready',
      rows: [],
      next: null,
      stopped: false,
    })
    const long = `month:${'9'.repeat(PERIOD_KEY_MAX)}`
    expect(await refused(t, (ctx) => apiAccountsBatch(ctx, f.org.id, { period: long }))).toEqual({
      data: { code: 'bad_request', message: NOT_A_PERIOD },
      ranges: 0,
    })
    // the bound itself is read
    const atBound = 'x'.repeat(PERIOD_KEY_MAX)
    expect(ready(await accountsOf(t, f.admin, { period: atBound })).rows).toEqual([])
  })

  it('refuses a search past LIMITS.search and a cursor of another period, search, organization or list, before it reads anything', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ids = await accounts(t, f, 30, (n) => n + 1)
    await setCalls(
      t,
      f.org.id,
      ids.map((profile) => ({ profile, calls: 1, period: AUGUST })),
    )
    const theirs = await plantPeople(
      t,
      Array.from({ length: 30 }, (_, n) => person(f.otherOrg.id, `Account ${n}`)),
    )
    await setCalls(
      t,
      f.otherOrg.id,
      theirs.map((profile) => ({ profile, calls: 1 })),
    )
    const long = 'a'.repeat(LIMITS.search.max + 1)
    expect(
      await refused(t, (ctx) =>
        apiAccountsBatch(ctx, f.org.id, { period: SEPTEMBER, search: long }),
      ),
    ).toEqual({ data: { code: 'rule', message: LIMITS.search.refusal }, ranges: 0 })

    const plain = ready(await accountsOf(t, f.admin)).next!
    const searched = ready(await accountsOf(t, f.admin, { search: 'account' })).next!
    const august = ready(await accountsOf(t, f.admin, { period: AUGUST })).next!
    const others = ready(await accountsOf(t, f.otherAdmin)).next!
    const storage = await namedCursor(STORAGE_PROJECTS_LIST, [f.org.id, ''], {
      key: '',
      tie: [5, 1, 'x'],
    })
    // the cursors that must open
    expect(ready(await accountsOf(t, f.admin, { cursor: plain })).rows).toHaveLength(5)
    expect(
      ready(await accountsOf(t, f.admin, { search: 'account', cursor: searched })).rows,
    ).toHaveLength(5)
    expect(
      ready(await accountsOf(t, f.admin, { period: AUGUST, cursor: august })).rows,
    ).toHaveLength(5)
    // a sealed position of this list's scope with another tie
    const odd = await namedCursor(API_ACCOUNTS_LIST, [f.org.id, SEPTEMBER, ''], {
      key: '',
      tie: ['x', 'y'],
    })
    for (const [orgId, a] of [
      [f.org.id, { period: SEPTEMBER, cursor: 'nope' }],
      [f.org.id, { period: SEPTEMBER, cursor: searched }],
      [f.org.id, { period: SEPTEMBER, search: 'account', cursor: plain }],
      [f.org.id, { period: SEPTEMBER, cursor: august }],
      [f.org.id, { period: AUGUST, cursor: plain }],
      [f.org.id, { period: SEPTEMBER, cursor: others }],
      [f.otherOrg.id, { period: SEPTEMBER, cursor: plain }],
      [f.org.id, { period: SEPTEMBER, cursor: storage }],
      [f.org.id, { period: SEPTEMBER, cursor: odd }],
    ] as const)
      expect(await refused(t, (ctx) => apiAccountsBatch(ctx, orgId, a))).toEqual({
        data: { code: 'bad_request', message: NOT_ACCOUNTS_CURSOR },
        ranges: 0,
      })
    await expectRefusal(
      accountsOf(t, f.admin, { cursor: others }),
      'bad_request',
      /start the list again/,
    )
  })

  it('misses an account that grows past the cursor between calls and answers again one a re-rank lowers past it', async () => {
    const t = newT()
    const f = await withOrg(t)
    // calls 60 down to 1
    const ids = await accounts(t, f, 60, (n) => 60 - n)
    const first = ready(await accountsOf(t, f.admin))
    expect(first.rows.map((r) => r.calls)).toEqual(Array.from({ length: 25 }, (_, i) => 60 - i))
    // Account 40, 20 calls and not yet answered, grows past the cursor;
    // Account 10, 50 calls and answered, is lowered to 30 by an exact write
    await setCalls(t, f.org.id, [
      { profile: ids[40], calls: 100 },
      { profile: ids[10], calls: 30 },
    ])
    const second = ready(await accountsOf(t, f.admin, { cursor: first.next! }))
    expect(second.rows.map((r) => r.profile_id)).not.toContain(ids[40])
    expect(second.rows.map((r) => r.profile_id)).toContain(ids[10])
    // the next list from the start has it first
    expect(ready(await accountsOf(t, f.admin)).rows[0]).toMatchObject({
      profile_id: ids[40],
      calls: 100,
    })
  })
})

describe('API calls by account, counting and the read share', () => {
  it('answers counting without reading an account row, for a first and a later batch', async () => {
    const t = newT()
    const f = await withOrg(t)
    await accounts(t, f, 30, (n) => n + 1)
    const cursor = ready(await accountsOf(t, f.admin)).next!
    // one row stored before the ranks existed
    await t.run((ctx) =>
      ctx.db.insert('billing_usage', {
        org_id: f.org.id,
        profile_id: f.user.id,
        credential_id: 'old',
        credential_name: 'Old key',
        period_start: SEPTEMBER,
        calls: 2,
      }),
    )
    for (const a of [{}, { cursor }]) {
      const { out, read } = await measured(t, (ctx) =>
        apiAccountsBatch(ctx, f.org.id, { period: SEPTEMBER, ...a }),
      )
      expect(out).toEqual({ state: 'counting' })
      // the ranked check's one usage row alone
      expect(read).toMatchObject({ ranges: 1, documents: 1 })
    }
    expect(await accountsOf(t, f.admin)).toEqual({ state: 'counting' })
  })

  it('stops a search under a lowered share with no rows and a next, and reaches the match by following the cursors', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ids = await plantPeople(t, [
      ...Array.from({ length: 39 }, (_, n) => person(f.org.id, `Common account ${n}`)),
      person(f.org.id, 'Zephyrine relay'),
    ])
    await setCalls(
      t,
      f.org.id,
      ids.map((profile, n) => ({ profile, calls: 1000 - n })),
    )
    Object.assign(API_ACCOUNTS.reads, { documents: 6 })
    const calls: (Read & { rows: number; stopped: boolean; next: boolean })[] = []
    const found: ApiAccountRow[] = []
    let cursor: string | undefined
    for (let i = 0; i < 60; i++) {
      const { out, read } = await measured(t, (ctx) =>
        apiAccountsBatch(ctx, f.org.id, { period: SEPTEMBER, search: 'zephyrine', cursor }),
      )
      const batch = ready(out)
      calls.push({
        ...read,
        rows: batch.rows.length,
        stopped: batch.stopped,
        next: batch.next !== null,
      })
      // until the match, every batch stopped with no rows and goes on; none
      // claims an end it did not reach
      if (found.length === 0 && batch.rows.length === 0) {
        expect(batch).toMatchObject({ stopped: true })
        expect(batch.next).not.toBeNull()
      }
      found.push(...batch.rows)
      if (batch.next === null) break
      cursor = batch.next
    }
    console.log('API calls by account, lowered share, a search for the last', JSON.stringify(calls))
    expect(calls.at(-1)?.next).toBe(false)
    expect(found.map((r) => r.profile_id)).toEqual([ids[39]])
    expect(calls.length).toBeGreaterThan(3)
    expect(calls[0]).toMatchObject({ rows: 0, stopped: true, next: true })
    // the default share reads the whole search in one call
    Object.assign(API_ACCOUNTS.reads, DEFAULT_ACCOUNTS)
    const whole = ready(
      await t.run((ctx) =>
        apiAccountsBatch(ctx, f.org.id, { period: SEPTEMBER, search: 'zephyrine' }),
      ),
    )
    expect(whole).toMatchObject({ next: null, stopped: false })
    expect(whole.rows).toHaveLength(1)
  })
})

/* ------------------------------------------------------- the account names */

describe('the account name lists', () => {
  it('page 30 billable names 25 and 5 in name order, with a search, and the non-billable ones apart', async () => {
    const t = newT()
    const f = await withOrg(t)
    // names whose order differs from the order of creation
    const people = Array.from({ length: 25 }, (_, n) =>
      person(f.org.id, `Pilot ${String((n * 7) % 25).padStart(2, '0')}`),
    )
    const inactive = [person(f.org.id, 'Zoë Archive', { active: false })]
    await plantPeople(t, [...people, ...inactive])
    await keyed(t, f.org.id)
    const { batches, rows } = await walk((cursor) =>
      namesOf(t, f.admin, { kind: 'billable', cursor }),
    )
    // withOrg's five and the 25 pilots
    expect(batches.map((b) => b.rows.length)).toEqual([25, 5])
    const keys = rows.map((r) => nameKey(r.name))
    expect(keys).toEqual([...keys].sort())
    expect(new Set(rows.map((r) => r.profile_id))).toEqual(
      new Set(
        [f.admin, f.user, f.viewer, f.guest, f.agent]
          .map((p) => p.id)
          .concat(people.map((p) => p.id)),
      ),
    )
    // names and ids only
    expect(Object.keys(rows[0]).sort()).toEqual(['name', 'profile_id'])
    expect(ready(await namesOf(t, f.admin, { kind: 'non_billable' })).rows).toEqual([
      { profile_id: inactive[0].id, name: 'Zoë Archive' },
    ])
    expect(
      ready(await namesOf(t, f.admin, { kind: 'non_billable', search: 'zoe archive' })).rows,
    ).toHaveLength(1)
    expect(
      ready(await namesOf(t, f.admin, { kind: 'billable', search: 'pilot 07' })).rows.map(
        (r) => r.name,
      ),
    ).toEqual(['Pilot 07'])
    // the case that must fail: an inactive name is never billable
    expect(ready(await namesOf(t, f.admin, { kind: 'billable', search: 'zoe' })).rows).toEqual([])
  })

  it('answers not_ready until every profile holds its name key, and refuses a long search and a foreign cursor before it reads anything', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantPeople(
      t,
      Array.from({ length: 30 }, (_, n) => person(f.org.id, `Pilot ${n}`)),
    )
    expect(await namesOf(t, f.admin, { kind: 'billable' })).toEqual({ state: 'not_ready' })
    await keyed(t, f.org.id)
    await keyed(t, f.otherOrg.id)
    const plain = ready(await namesOf(t, f.admin, { kind: 'billable' })).next!
    const searched = ready(await namesOf(t, f.admin, { kind: 'billable', search: 'pilot' })).next!
    expect(ready(await namesOf(t, f.admin, { kind: 'billable', cursor: plain })).rows).toHaveLength(
      10,
    )
    const accountsCursor = await namedCursor(API_ACCOUNTS_LIST, [f.org.id, SEPTEMBER, ''], {
      key: '',
      tie: [3, 'x'],
    })
    const theirs = await namedCursor(ACCOUNT_NAMES_LIST, [f.otherOrg.id, 'billable', ''], {
      key: 'a',
      tie: ['x'],
    })
    const long = 'a'.repeat(LIMITS.search.max + 1)
    expect(
      await refused(t, (ctx) =>
        accountNamesBatch(ctx, f.org.id, { kind: 'billable', search: long }),
      ),
    ).toEqual({ data: { code: 'rule', message: LIMITS.search.refusal }, ranges: 0 })
    for (const a of [
      { kind: 'billable', cursor: 'nope' },
      { kind: 'non_billable', cursor: plain },
      { kind: 'billable', cursor: searched },
      { kind: 'billable', search: 'pilot', cursor: plain },
      { kind: 'billable', cursor: accountsCursor },
      { kind: 'billable', cursor: theirs },
    ] as const)
      expect(await refused(t, (ctx) => accountNamesBatch(ctx, f.org.id, a))).toEqual({
        data: { code: 'bad_request', message: NOT_NAMES_CURSOR },
        ranges: 0,
      })
    // a kind outside the two is refused by the validator
    await expect(
      as(t, f.admin).query(api.billing.accountList, {
        org_id: f.org.id,
        kind: 'everyone' as 'billable',
      }),
    ).rejects.toThrow()
  })

  it('stops a non-billable list under a lowered share with no rows and a next, and reaches its last name by following the cursors', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ids = await plantPeople(t, [
      ...Array.from({ length: 30 }, (_, n) => person(f.org.id, `Common ${n}`)),
      person(f.org.id, 'Zz last', { active: false }),
    ])
    await keyed(t, f.org.id)
    Object.assign(ACCOUNT_NAMES.reads, { documents: 6 })
    const calls: { rows: number; stopped: boolean; next: boolean }[] = []
    const found: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 60; i++) {
      const batch = ready(
        await t.run((ctx) => accountNamesBatch(ctx, f.org.id, { kind: 'non_billable', cursor })),
      )
      calls.push({ rows: batch.rows.length, stopped: batch.stopped, next: batch.next !== null })
      if (found.length === 0 && batch.rows.length === 0) {
        expect(batch).toMatchObject({ stopped: true })
        expect(batch.next).not.toBeNull()
      }
      found.push(...batch.rows.map((r) => r.profile_id))
      if (batch.next === null) break
      cursor = batch.next
    }
    expect(found).toEqual([ids[30]])
    expect(calls.length).toBeGreaterThan(3)
    expect(calls[0]).toMatchObject({ rows: 0, stopped: true, next: true })
    Object.assign(ACCOUNT_NAMES.reads, DEFAULT_NAMES)
    const whole = ready(
      await t.run((ctx) => accountNamesBatch(ctx, f.org.id, { kind: 'non_billable' })),
    )
    expect(whole).toMatchObject({ next: null, stopped: false })
    expect(whole.rows.map((r) => r.profile_id)).toEqual([ids[30]])
  })
})

/* ------------------------------------------------------------- the refusals */

describe("Billing's bounded reads, refusals", () => {
  it('refuse a member, a Viewer, a guest, an admin of another organization, a deactivated admin and an organization being deleted', async () => {
    const t = newT()
    const f = await withOrg(t)
    await keyed(t, f.org.id)
    await setCalls(t, f.org.id, [{ profile: f.user.id, calls: 2 }])
    const reads = (by: Doc<'profiles'>) => [
      () => as(t, by).query(api.billing.details, { org_id: f.org.id }),
      () => as(t, by).query(api.billing.usageFigures, { org_id: f.org.id }),
      () => as(t, by).query(api.billing.apiAccounts, { org_id: f.org.id, period: SEPTEMBER }),
      () => as(t, by).query(api.billing.accountList, { org_id: f.org.id, kind: 'billable' }),
    ]
    // each read starts once the one before it is refused, so no refusal
    // lands before its handler is attached
    const refusedAll = async (by: Doc<'profiles'>, message: RegExp) => {
      for (const read of reads(by)) await expectRefusal(read(), 'forbidden', message)
    }
    // the case that must pass, the admin reading all four
    for (const read of reads(f.admin)) await read()
    expect(ready(await accountsOf(t, f.admin)).rows).toHaveLength(1)
    for (const by of [f.user, f.viewer, f.guest]) await refusedAll(by, /admin only/)
    await refusedAll(f.otherAdmin, /no profile/)
    await t.run((ctx) => ctx.db.patch(f.admin._id, { active: false }))
    await refusedAll(f.admin, /no profile/)
    await t.run((ctx) => ctx.db.patch(f.admin._id, { active: true }))
    await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: STAMP,
        delete_after: STAMP,
        phase: 'profiles',
        created_at: STAMP,
      }),
    )
    await refusedAll(f.admin, /being deleted/)
  })
})

/* ------------------------------------------------- reads at the design size */

describe('reads at the design size', () => {
  it('reads the first batch of 1,000 accounts and a search for the one with the fewest calls in one call each', async () => {
    const t = newT()
    const f = await withOrg(t)
    // 1,000 people and agents with withOrg's five, each with one credential
    // and 1 to 7 calls, the one with the fewest calls named apart
    const people = Array.from({ length: 995 }, (_, n) =>
      person(
        f.org.id,
        n === 994 ? 'Zephyrine relay' : `Person ${n} of the lab`,
        n % 50 === 0 ? { kind: 'agent', plannable_hours: undefined } : {},
      ),
    )
    const ids = await plantPeople(t, people)
    const all = [f.admin.id, f.user.id, f.viewer.id, f.guest.id, f.agent.id, ...ids]
    // distinct exact calls so the order is known: the last has 1 call
    await setCalls(
      t,
      f.org.id,
      all.map((profile, n) => ({ profile, calls: all.length - n })),
    )
    const first = await measured(t, (ctx) => apiAccountsBatch(ctx, f.org.id, { period: SEPTEMBER }))
    const firstBatch = ready(first.out)
    expect(firstBatch.rows).toHaveLength(LIST_BATCH)
    expect(firstBatch.stopped).toBe(false)
    const search = await measured(t, (ctx) =>
      apiAccountsBatch(ctx, f.org.id, { period: SEPTEMBER, search: 'zephyrine' }),
    )
    const searchBatch = ready(search.out)
    expect(searchBatch).toMatchObject({ next: null, stopped: false })
    expect(searchBatch.rows).toEqual([
      { profile_id: ids[994], name: 'Zephyrine relay', removed: false, calls: 1 },
    ])
    console.log(
      'API calls by account at the design size',
      JSON.stringify({ firstBatch: first.read, searchFewest: search.read }),
    )
    for (const read of [first.read, search.read]) {
      expect(read.ranges).toBeLessThan(API_ACCOUNTS.reads.ranges)
      expect(read.documents).toBeLessThan(API_ACCOUNTS.reads.documents)
      expect(read.bytes).toBeLessThan(API_ACCOUNTS.reads.bytes)
    }
  })

  it('reads the figures, the details and the name lists at 1,000 people', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => startOrgTotals(ctx, f.org.id))
    // 1,000 people with withOrg's five: 30 inactive, named last, and 20
    // guests, half of them with an active home membership elsewhere
    const people = Array.from({ length: 995 }, (_, n) => {
      if (n < 30) return person(f.org.id, `Zz inactive ${n} of the lab`, { active: false })
      if (n < 50)
        return person(f.org.id, `Guest ${n} of the lab`, {
          org_role: 'guest',
          email: `guest${n}@partner.test`,
        })
      return person(f.org.id, `Person ${n} of the lab`, {
        email: `person${n}@testbed.test`,
        ...(n === 994 ? { name: 'Yolanda Last', name_key: nameKey('Yolanda Last') } : {}),
      })
    })
    await plantPeople(t, people)
    await plantPeople(
      t,
      Array.from({ length: 10 }, (_, n) =>
        person(f.otherOrg.id, `Home ${n}`, { email: `guest${30 + n}@partner.test` }),
      ),
    )
    await keyed(t, f.org.id)
    // the everyday usage of a bucket: 15 accounts over 30 rows
    await setCalls(
      t,
      f.org.id,
      people.slice(50, 65).flatMap((p) => [
        { profile: p.id, calls: 3 },
        { profile: p.id, calls: 3, credential: `${p.id}:token` },
      ]),
    )
    const figures = await measured(t, (ctx) => usageFiguresOf(ctx, f.org.id))
    expect(figures.out).toMatchObject({ calls: 90, storage_bytes: 0 })
    const details = await measured(t, (ctx) => billingDetailsOf(ctx, f.org.id))
    expect(details.out).toMatchObject({
      billable_users: 960,
      active_users: 970,
      inactive_users: 30,
      invited_users_with_own_billing: 10,
    })
    const billable = await measured(t, (ctx) =>
      accountNamesBatch(ctx, f.org.id, { kind: 'billable' }),
    )
    expect(ready(billable.out).rows).toHaveLength(LIST_BATCH)
    const last = await measured(t, (ctx) =>
      accountNamesBatch(ctx, f.org.id, { kind: 'billable', search: 'yolanda' }),
    )
    expect(ready(last.out)).toMatchObject({ next: null, stopped: false })
    expect(ready(last.out).rows.map((r) => r.name)).toEqual(['Yolanda Last'])
    const nonBillable = await measured(t, (ctx) =>
      accountNamesBatch(ctx, f.org.id, { kind: 'non_billable' }),
    )
    // the ten guests billed at home come first, then 15 of the inactive
    expect(ready(nonBillable.out).rows).toHaveLength(LIST_BATCH)
    expect(ready(nonBillable.out).stopped).toBe(false)
    console.log(
      'Billing at 1,000 people',
      JSON.stringify({
        usageFigures: figures.read,
        details: details.read,
        billableFirst: billable.read,
        billableSearchLast: last.read,
        nonBillableFirst: nonBillable.read,
      }),
    )
    for (const read of [billable.read, last.read, nonBillable.read]) {
      expect(read.ranges).toBeLessThan(ACCOUNT_NAMES.reads.ranges)
      expect(read.documents).toBeLessThan(ACCOUNT_NAMES.reads.documents)
      expect(read.bytes).toBeLessThan(ACCOUNT_NAMES.reads.bytes)
    }
    for (const read of [figures.read, details.read]) {
      expect(read.documents).toBeLessThan(8000)
      expect(read.ranges).toBeLessThan(4096)
    }
  })
})

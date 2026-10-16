import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { sha256hex } from '../machine/auth'
import { consumeMachineRequest, recordApiCall, usageKeyRange } from '../model/billingUsage'
import { as, newT, type OrgFixture, type T, uuid, withOrg } from './helpers.setup'

const PERIOD = '2026-09-15T12:00:00.000Z'
const END = '2026-10-15T12:00:00.000Z'
const NOW = Date.parse('2026-09-20T12:00:00.000Z')
const SEPTEMBER = 'month:2026-09'
const OCTOBER = 'month:2026-10'

beforeEach(() => {
  vi.stubEnv('BILLING_ENABLED', 'true')
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function fixture(t: T) {
  const f = await withOrg(t)
  const sub = await t.run(async (ctx) => {
    const planId = uuid()
    await ctx.db.insert('billing_plans', {
      id: planId,
      name: 'Legacy terms',
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
      plan_id: planId,
      status: 'active',
      polar_subscription_id: 'provider-sub',
      current_period_start: PERIOD,
      current_period_end: END,
      billed_seats: 2,
      next_seats: 7,
      cancel_at_period_end: false,
      created_at: PERIOD,
      updated_at: PERIOD,
    })
    return (await ctx.db.get(id))!
  })
  return { ...f, sub }
}

const call = (t: T, profileId: string, credential = 'key') =>
  t.run((ctx) =>
    recordApiCall(ctx, {
      profile_id: profileId,
      credential_id: credential,
      credential_name: credential,
    }),
  )
const totals = (t: T) => t.run((ctx) => ctx.db.query('billing_usage_totals').collect())
const events = (t: T) => t.run((ctx) => ctx.db.query('billing_events').collect())
/* [period_start, calls] for every pooled bucket, sorted. */
const buckets = async (t: T) =>
  (await totals(t)).map((row) => [row.period_start, row.calls] as const).sort()
/* The admin Billing page's usage report at the mocked clock. */
const report = (t: T, f: Pick<OrgFixture, 'admin' | 'org'>) =>
  as(t, f.admin).query(api.billing.usage, { org_id: f.org.id })
const at = (iso: string) => vi.mocked(Date.now).mockReturnValue(Date.parse(iso))
const patchSub = (
  t: T,
  sub: Doc<'billing_subscriptions'>,
  fields: Partial<Doc<'billing_subscriptions'>>,
) => t.run((ctx) => ctx.db.patch(sub._id, fields))
/* A subscription that never had a provider period, as enrollment leaves it. */
const withoutPeriod = {
  status: 'pending',
  polar_subscription_id: undefined,
  current_period_start: undefined,
  current_period_end: undefined,
  billed_seats: 0,
} as const

describe('pooled API usage', () => {
  it('keeps usage separate when a deleted credential id is reused by another organization', async () => {
    const t = newT()
    const f = await fixture(t)
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...sub } = f.sub
      await ctx.db.insert('billing_subscriptions', {
        ...sub,
        id: uuid(),
        org_id: f.otherOrg.id,
        polar_subscription_id: 'other-sub',
      })
    })
    await call(t, f.agent.id, 'reused-credential-id')
    await call(t, f.otherAdmin.id, 'reused-credential-id')
    const usage = await t.run((ctx) => ctx.db.query('billing_usage').collect())
    expect(usage).toHaveLength(2)
    expect(usage.map((row) => [row.org_id, row.profile_id, row.calls]).sort()).toEqual(
      [
        [f.org.id, f.agent.id, 1],
        [f.otherOrg.id, f.otherAdmin.id, 1],
      ].sort(),
    )
    expect((await totals(t)).map((row) => [row.org_id, row.calls]).sort()).toEqual(
      [
        [f.org.id, 1],
        [f.otherOrg.id, 1],
      ].sort(),
    )
  })

  it('refuses a replaced credential between authentication and metering without charging its new owner', async () => {
    const t = newT()
    const f = await fixture(t)
    const id = uuid()
    const record = {
      id,
      profile_id: f.agent.id,
      name: 'Old key',
      key_prefix: 'qva_test',
      key_hash: 'old-hash',
      created_at: PERIOD,
    }
    const oldRow = await t.run((ctx) => ctx.db.insert('agent_keys', record))
    const auth = await t.query(internal.machine.auth.lookupCredential, {
      hash: 'old-hash',
      isAgent: true,
      now: new Date().toISOString(),
    })
    expect(auth.ok).toBe(true)
    await t.run(async (ctx) => {
      await ctx.db.delete(oldRow)
      await ctx.db.insert('agent_keys', {
        ...record,
        profile_id: f.otherAdmin.id,
        key_hash: 'new-hash',
      })
    })
    expect(
      await t.mutation(internal.machine.auth.touchCredential, {
        table: 'agent_keys',
        tokenId: id,
        rowId: oldRow,
        profileId: f.agent.id,
        now: new Date(NOW).toISOString(),
      }),
    ).toBeNull()
    expect(await totals(t)).toHaveLength(0)
    expect(await t.run((ctx) => ctx.db.query('billing_usage').collect())).toHaveLength(0)
  })

  it('counts across users and keys, uses billed seats and emits each newly started block once', async () => {
    const t = newT()
    const f = await fixture(t)
    for (let n = 0; n < 4; n++) await call(t, f.agent.id, 'agent-key')
    expect(await events(t)).toHaveLength(0)
    await call(t, f.user.id, 'personal-token')
    await call(t, f.user.id, 'personal-token')
    await call(t, f.user.id, 'oauth-connection')
    const outbox = await events(t)
    expect(outbox.map((event) => ({ id: event.id, units: event.units, kind: event.kind }))).toEqual(
      [
        { id: `${f.sub.id}:${PERIOD}:api:1`, units: 1, kind: 'api' },
        { id: `${f.sub.id}:${PERIOD}:api:2`, units: 1, kind: 'api' },
      ],
    )
    expect(await totals(t)).toMatchObject([
      { org_id: f.org.id, period_start: PERIOD, calls: 7, reported_api_blocks: 2 },
    ])
    const usage = await t.run((ctx) => ctx.db.query('billing_usage').collect())
    expect(usage.map((row) => [row.credential_id, row.calls]).sort()).toEqual([
      ['agent-key', 4],
      ['oauth-connection', 1],
      ['personal-token', 2],
    ])
    expect(await report(t, f)).toMatchObject({
      period_kind: 'paid',
      period_start: PERIOD,
      period_end: END,
      calls: 7,
      api_overage_cents: 200,
      waived: false,
    })
  })

  it('a paid period consumes blocks waived by complimentary access and charges only later blocks', async () => {
    const t = newT()
    const f = await fixture(t)
    await patchSub(t, f.sub, { complimentary_start: PERIOD, complimentary_until: END })
    for (let n = 0; n < 6; n++) await call(t, f.agent.id)
    expect(await events(t)).toHaveLength(0)
    expect(await totals(t)).toMatchObject([{ calls: 6, reported_api_blocks: 1 }])
    await patchSub(t, f.sub, { complimentary_until: new Date(NOW - 1).toISOString() })
    await call(t, f.agent.id)
    expect(await events(t)).toMatchObject([{ id: `${f.sub.id}:${PERIOD}:api:2`, units: 1 }])
  })

  it('free months count per calendar month, never charge and keep counting after the grant ends', async () => {
    const t = newT()
    const f = await fixture(t)
    await patchSub(t, f.sub, {
      ...withoutPeriod,
      next_seats: 1,
      complimentary_start: '2026-09-02T08:00:00.000Z',
      complimentary_until: '2026-11-02T08:00:00.000Z',
    })
    // Six calls exceed the plan's allowance for one seat, yet no block is counted.
    for (let n = 0; n < 6; n++) await call(t, f.agent.id)
    expect(await report(t, f)).toMatchObject({
      period_kind: 'month',
      period_start: '2026-09-01T00:00:00.000Z',
      period_end: '2026-09-30T00:00:00.000Z',
      calls: 6,
      waived: true,
    })
    at('2026-10-10T12:00:00.000Z')
    await call(t, f.agent.id)
    at('2026-11-20T12:00:00.000Z')
    await call(t, f.agent.id)
    expect(await buckets(t)).toEqual([
      [SEPTEMBER, 6],
      [OCTOBER, 1],
      ['month:2026-11', 1],
    ])
    expect(await totals(t)).toMatchObject([
      { reported_api_blocks: 0 },
      { reported_api_blocks: 0 },
      { reported_api_blocks: 0 },
    ])
    expect(await events(t)).toHaveLength(0)
  })

  it('disabled billing counts usage without adding charges, also for an organization without a subscription', async () => {
    const t = newT()
    const f = await fixture(t)
    vi.stubEnv('BILLING_ENABLED', 'false')
    for (let n = 0; n < 5; n++) await call(t, f.agent.id)
    await call(t, f.otherAdmin.id)
    expect(await events(t)).toHaveLength(0)
    expect(
      (await totals(t)).map((row) => [row.org_id, row.period_start, row.calls]).sort(),
    ).toEqual(
      [
        [f.org.id, PERIOD, 5],
        [f.otherOrg.id, SEPTEMBER, 1],
      ].sort(),
    )
  })

  it('late renewal confirmation never meters calls into the closed invoice', async () => {
    const t = newT()
    const f = await fixture(t)
    await call(t, f.agent.id)
    at(END)
    for (let n = 0; n < 5; n++) await call(t, f.agent.id)
    expect(await buckets(t)).toEqual([
      [PERIOD, 1],
      [END, 5],
    ])
    expect(await events(t)).toHaveLength(0)
    // The page shows the pending interval the writer is filling, not the closed period.
    expect(await report(t, f)).toMatchObject({
      period_kind: 'pending',
      period_start: END,
      period_end: null,
      calls: 5,
      waived: false,
    })
    await patchSub(t, f.sub, {
      current_period_start: END,
      current_period_end: '2026-11-15T12:00:00.000Z',
    })
    await call(t, f.agent.id)
    expect(await events(t)).toHaveLength(0) // the started block was waived while unconfirmed
    await call(t, f.agent.id)
    expect(await events(t)).toMatchObject([{ period_start: END, units: 1 }])
    expect(await report(t, f)).toMatchObject({
      period_kind: 'paid',
      period_start: END,
      period_end: '2026-11-15T12:00:00.000Z',
      calls: 7,
    })
  })
})

describe('usage buckets without a live paid period', () => {
  it('counts calls without a subscription or plan per UTC calendar month', async () => {
    const t = newT()
    const f = await withOrg(t)
    at('2026-09-30T23:59:59.999Z')
    await call(t, f.agent.id)
    expect(await report(t, f)).toMatchObject({
      period_kind: 'month',
      period_start: '2026-09-01T00:00:00.000Z',
      period_end: '2026-09-30T00:00:00.000Z',
      calls: 1,
      included_calls: null,
      included_storage_bytes: null,
      waived: true,
    })
    at('2026-10-01T00:00:00.000Z')
    await call(t, f.agent.id)
    await call(t, f.user.id, 'personal-token')
    expect(await buckets(t)).toEqual([
      [SEPTEMBER, 1],
      [OCTOBER, 2],
    ])
    const october = await report(t, f)
    expect(october).toMatchObject({
      period_start: '2026-10-01T00:00:00.000Z',
      period_end: '2026-10-31T00:00:00.000Z',
      calls: 2,
    })
    expect(october.users.map((user) => user.profile_id).sort()).toEqual(
      [f.agent.id, f.user.id].sort(),
    )
    expect(await events(t)).toHaveLength(0)
  })

  it('a subscription without a provider period counts per month against its plan allowance', async () => {
    const t = newT()
    const f = await fixture(t)
    await patchSub(t, f.sub, withoutPeriod)
    for (let n = 0; n < 3; n++) await call(t, f.agent.id)
    expect(await buckets(t)).toEqual([[SEPTEMBER, 3]])
    const usage = await report(t, f)
    expect(usage).toMatchObject({ period_kind: 'month', calls: 3, waived: true })
    expect(usage.included_calls).toBeGreaterThan(0)
  })

  // [status, subscription fields, bucket before the period end, bucket at it, charged]
  it.each([
    ['active', {}, PERIOD, END, true],
    ['trialing', { status: 'trialing' }, PERIOD, END, false],
    ['past due', { status: 'past_due', past_due_at: PERIOD }, PERIOD, END, true],
    [
      'canceled at period end',
      { status: 'canceled', cancel_at_period_end: true },
      PERIOD,
      OCTOBER,
      false,
    ],
    ['canceled', { status: 'canceled' }, SEPTEMBER, OCTOBER, false],
    ['ended', { status: 'active', ended_at: PERIOD }, SEPTEMBER, OCTOBER, false],
    ['unpaid', { status: 'unpaid' }, SEPTEMBER, OCTOBER, false],
    ['paused', { status: 'paused' }, SEPTEMBER, OCTOBER, false],
    ['incomplete', { status: 'pending' }, SEPTEMBER, OCTOBER, false],
  ] as const)(
    'a provider subscription that is %s records calls in the bucket the page shows',
    async (_, fields, before, after, charged) => {
      const t = newT()
      const f = await fixture(t)
      await patchSub(t, f.sub, fields)
      // Six calls exceed the paid period's four included calls by one block.
      for (let n = 0; n < 6; n++) await call(t, f.agent.id)
      expect((await report(t, f)).calls).toBe(6)
      at(END)
      await call(t, f.agent.id)
      expect(await buckets(t)).toEqual([
        [before, 6],
        [after, 1],
      ])
      expect((await report(t, f)).calls).toBe(1)
      expect((await events(t)).map((event) => event.period_start)).toEqual(charged ? [PERIOD] : [])
    },
  )

  it('a missing plan row never drops calls', async () => {
    const t = newT()
    const f = await fixture(t)
    await t.run(async (ctx) => {
      const plan = await ctx.db
        .query('billing_plans')
        .withIndex('by_uuid', (q) => q.eq('id', f.sub.plan_id))
        .unique()
      await ctx.db.delete(plan!._id)
    })
    for (let n = 0; n < 6; n++) await call(t, f.agent.id)
    await patchSub(t, f.sub, withoutPeriod)
    await call(t, f.agent.id)
    expect(await buckets(t)).toEqual([
      [PERIOD, 6],
      [SEPTEMBER, 1],
    ])
    expect(await events(t)).toHaveLength(0)
    expect(await report(t, f)).toMatchObject({ calls: 1, included_calls: null })
  })
})

describe('usage key ranges', () => {
  it('maps month, recorded, current and open-ended keys to display dates', async () => {
    const t = newT()
    const f = await fixture(t)
    const replaced = '2026-06-15T12:00:00.000Z'
    const previous = '2026-08-15T12:00:00.000Z'
    const period = (subscription_id: string, period_start: string, period_end: string) =>
      t.run((ctx) =>
        ctx.db.insert('billing_periods', {
          org_id: f.org.id,
          subscription_id,
          plan_id: f.sub.plan_id,
          period_start,
          period_end,
          seats: 2,
          profile_ids: [],
          storage_bytes: 0,
          storage_blocks: 0,
          created_at: period_start,
        }),
      )
    await period('provider-sub', previous, PERIOD)
    // a period of the provider subscription this one replaced
    await period('replaced-sub', replaced, '2026-07-15T12:00:00.000Z')
    const range = (key: string, sub: Doc<'billing_subscriptions'> | null = f.sub) =>
      t.run((ctx) => usageKeyRange(ctx, f.org.id, sub, key))
    expect(await range('month:2028-02')).toEqual({
      kind: 'month',
      start: '2028-02-01T00:00:00.000Z',
      end: '2028-02-29T00:00:00.000Z',
    })
    expect(await range(previous)).toEqual({ kind: 'paid', start: previous, end: PERIOD })
    expect(await range(replaced)).toEqual({
      kind: 'paid',
      start: replaced,
      end: '2026-07-15T12:00:00.000Z',
    })
    expect(await range(PERIOD)).toEqual({ kind: 'paid', start: PERIOD, end: END })
    // A pending interval and an old free-access bucket have no known end.
    for (const key of [END, '2026-03-02T08:00:00.000Z', 'month:2026-13'])
      expect(await range(key)).toEqual({ kind: 'open', start: key, end: null })
    // Recorded periods resolve without a subscription; the current one needs it.
    expect(await range(previous, null)).toEqual({ kind: 'paid', start: previous, end: PERIOD })
    expect(await range(PERIOD, null)).toEqual({ kind: 'open', start: PERIOD, end: null })
    // Another organization's periods never match.
    expect(await t.run((ctx) => usageKeyRange(ctx, 'another-org', null, previous))).toEqual({
      kind: 'open',
      start: previous,
      end: null,
    })
  })
})

describe('machine request limits', () => {
  it('shares a 300/min limit across credentials and does not charge rejected requests', async () => {
    const t = newT()
    const f = await fixture(t)
    await t.run((ctx) =>
      ctx.db.insert('machine_rate_limits', {
        key: `profile:${f.agent.id}`,
        window_start: NOW,
        count: 299,
      }),
    )
    expect(await call(t, f.agent.id, 'first-key')).toBe(true)
    expect(await call(t, f.agent.id, 'second-key')).toBe(false)
    expect(await totals(t)).toMatchObject([{ calls: 1 }])
    vi.mocked(Date.now).mockReturnValue(NOW + 60_000)
    expect(await call(t, f.agent.id, 'second-key')).toBe(true)
    expect(await totals(t)).toMatchObject([{ calls: 2 }])
    expect(await t.run((ctx) => ctx.db.query('machine_rate_limits').collect())).toHaveLength(1)
  })

  it('commits the global limit and resets its stable row in the next minute', async () => {
    const t = newT()
    expect(await t.run((ctx) => consumeMachineRequest(ctx, 'ingress', 1, NOW))).toBe(true)
    expect(await t.run((ctx) => consumeMachineRequest(ctx, 'ingress', 1, NOW))).toBe(false)
    expect(await t.run((ctx) => consumeMachineRequest(ctx, 'ingress', 1, NOW + 60_000))).toBe(true)
    expect(await t.run((ctx) => ctx.db.query('machine_rate_limits').collect())).toMatchObject([
      { key: 'ingress', count: 1, window_start: NOW + 60_000 },
    ])
  })

  it('returns consistent REST/MCP 429 responses before lookup once ingress is full', async () => {
    const t = newT()
    await t.run((ctx) =>
      ctx.db.insert('machine_rate_limits', { key: 'ingress', window_start: NOW, count: 6_000 }),
    )
    const http = t as unknown as {
      fetch(path: string, init: { method: string; body?: string }): Promise<Response>
    }
    const rest = await http.fetch('/v1/tasks', { method: 'GET' })
    const mcp = await http.fetch('/mcp', { method: 'POST', body: '{}' })
    for (const response of [rest, mcp]) {
      expect(response.status).toBe(429)
      expect(response.headers.get('Retry-After')).toBe('60')
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    }
    expect(await totals(t)).toHaveLength(0)
  })

  it('meters invalid authenticated routes and malformed MCP bodies, then fences profile requests', async () => {
    const t = newT()
    const f = await fixture(t)
    const secret = `qva_${'rate-meter-key'.repeat(4)}`
    const hash = await sha256hex(secret)
    const keyId = uuid()
    await t.run((ctx) =>
      ctx.db.insert('agent_keys', {
        id: keyId,
        profile_id: f.agent.id,
        name: 'Worker',
        key_prefix: 'qva_test',
        key_hash: hash,
        created_at: PERIOD,
      }),
    )
    const http = t as unknown as {
      fetch(
        path: string,
        init: { method: string; headers: Record<string, string>; body?: string },
      ): Promise<Response>
    }
    const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }
    const rest = await http.fetch('/v1/unknown', { method: 'GET', headers })
    expect(rest.status).toBe(404)
    await http.fetch('/mcp', { method: 'POST', headers, body: '{broken' })
    expect(await totals(t)).toMatchObject([{ calls: 2 }])
    const rate = await t.run((ctx) =>
      ctx.db
        .query('machine_rate_limits')
        .withIndex('by_key', (q) => q.eq('key', `profile:${f.agent.id}`))
        .unique(),
    )
    await t.run((ctx) => ctx.db.patch(rate!._id, { count: 300 }))
    for (const [path, method] of [
      ['/v1/tasks', 'GET'],
      ['/mcp', 'POST'],
    ]) {
      const response = await http.fetch(path, {
        method,
        headers,
        body: method === 'POST' ? '{}' : undefined,
      })
      expect(response.status).toBe(429)
      expect(response.headers.get('Retry-After')).toBe('60')
    }
    expect(await totals(t)).toMatchObject([{ calls: 2 }])
  })

  it('OAuth connections and personal tokens share usage and cannot collide on raw credential ids', async () => {
    const t = newT()
    const f = await fixture(t)
    const id = uuid()
    await t.run(async (ctx) => {
      await ctx.db.insert('oauth_connections', {
        id,
        authorization_hash: 'auth-hash',
        auth_user_id: f.user.auth_user_id!,
        profile_id: f.user.id,
        org_id: f.org.id,
        client_id: 'client',
        client_name: 'Connected planner',
        resource: 'https://example.test/mcp',
        requested_scopes: ['qivo:read'],
        scopes: ['qivo:read'],
        created_at: PERIOD,
        authorization_expires_at: END,
      })
      await ctx.db.insert('mcp_tokens', {
        id,
        profile_id: f.user.id,
        name: 'Personal token',
        token_prefix: 'qvt_test',
        token_hash: 'token-hash',
        access: 'read',
        created_at: PERIOD,
      })
    })
    expect(await t.mutation(internal.billingMetering.oauthCall, { connection_id: id })).toBe(true)
    expect(
      await t.mutation(internal.machine.auth.touchCredential, {
        table: 'mcp_tokens',
        tokenId: id,
        profileId: f.user.id,
        rowId: (await t.run((ctx) =>
          ctx.db
            .query('mcp_tokens')
            .withIndex('by_uuid', (q) => q.eq('id', id))
            .unique(),
        ))!._id,
        now: new Date(NOW).toISOString(),
      }),
    ).toBe(true)
    const usage = await t.run((ctx) => ctx.db.query('billing_usage').collect())
    expect(usage.map((row) => row.credential_id).sort()).toEqual([
      `mcp_tokens:${id}`,
      `oauth_connections:${id}`,
    ])
    expect(await totals(t)).toMatchObject([{ org_id: f.org.id, calls: 2 }])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import { sha256hex } from '../machine/auth'
import { consumeMachineRequest, recordApiCall } from '../model/billingUsage'
import { newT, type T, uuid, withOrg } from './helpers.setup'

const PERIOD = '2026-09-15T12:00:00.000Z'
const END = '2026-10-15T12:00:00.000Z'
const NOW = Date.parse('2026-09-20T12:00:00.000Z')

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
  })

  it('free usage stays visible and waived after the complimentary interval ends', async () => {
    const t = newT()
    const f = await fixture(t)
    await t.run((ctx) =>
      ctx.db.patch(f.sub._id, { complimentary_start: PERIOD, complimentary_until: END }),
    )
    for (let n = 0; n < 6; n++) await call(t, f.agent.id)
    expect(await events(t)).toHaveLength(0)
    expect(await totals(t)).toMatchObject([{ calls: 6, reported_api_blocks: 1 }])
    await t.run((ctx) =>
      ctx.db.patch(f.sub._id, { complimentary_until: new Date(NOW - 1).toISOString() }),
    )
    await call(t, f.agent.id)
    expect(await events(t)).toMatchObject([{ id: `${f.sub.id}:${PERIOD}:api:2`, units: 1 }])
  })

  it('disabled billing counts usage without adding charges, and unknown orgs do not get usage rows', async () => {
    const t = newT()
    const f = await fixture(t)
    vi.stubEnv('BILLING_ENABLED', 'false')
    for (let n = 0; n < 5; n++) await call(t, f.agent.id)
    await call(t, f.otherAdmin.id)
    expect(await events(t)).toHaveLength(0)
    expect(await totals(t)).toMatchObject([{ org_id: f.org.id, calls: 5 }])
    expect(await totals(t)).toHaveLength(1)
  })

  it('late renewal confirmation never meters calls into the closed invoice', async () => {
    const t = newT()
    const f = await fixture(t)
    await call(t, f.agent.id)
    vi.mocked(Date.now).mockReturnValue(Date.parse(END))
    for (let n = 0; n < 5; n++) await call(t, f.agent.id)
    expect((await totals(t)).map((row) => [row.period_start, row.calls]).sort()).toEqual([
      [PERIOD, 1],
      [END, 5],
    ])
    expect(await events(t)).toHaveLength(0)
    await t.run((ctx) =>
      ctx.db.patch(f.sub._id, {
        current_period_start: END,
        current_period_end: '2026-11-15T12:00:00.000Z',
      }),
    )
    await call(t, f.agent.id)
    expect(await events(t)).toHaveLength(0) // the started block was waived while unconfirmed
    await call(t, f.agent.id)
    expect(await events(t)).toMatchObject([{ period_start: END, units: 1 }])
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

/* API access (apiAccess.ts): an organization admin lists every credential of
 * the organization with its calls in one usage period, and revokes any of
 * them. Usage rows and credentials are planted raw at a fixed clock inside a
 * live paid period, beside an earlier paid period, a calendar-month bucket
 * and an old free-access bucket. */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { byId } from '../lib/db'
import type { EventOwner } from '../lib/taskEvents'
import { sha256hex } from '../machine/auth'
import { notifyIssueUpdate } from '../model/messages'
import {
  activityFor,
  as,
  expectRefusal,
  flushWebhookEvents,
  newT,
  type OrgFixture,
  plantIssue,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }

const PERIOD = '2026-09-15T12:00:00.000Z'
const END = '2026-10-15T12:00:00.000Z'
const NOW = '2026-09-20T12:00:00.000Z'
const PAST = '2026-08-15T12:00:00.000Z'
const MONTH = 'month:2026-07'
const FREE = '2026-03-02T08:00:00.000Z'
const CREATED = '2026-06-01T00:00:00.000Z'

/* A REST read mints nothing, but the auth config reads this secret lazily. */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
g.process ??= { env: {} }
g.process.env.BETTER_AUTH_SECRET ??= 'test-files-secret'

beforeEach(() => {
  vi.stubEnv('BILLING_ENABLED', 'true')
  vi.stubEnv('APP_MODE', '')
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(NOW))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const secret = (prefix: string) => `${prefix}${uuid().replace(/-/g, '')}${'0'.repeat(16)}`

/* withOrg with an active paid subscription, one credential of every kind and
 * state, and usage in four periods. */
async function fixture(t: T) {
  const f = await withOrg(t)
  const elin = await plantSeat(t, {
    org_id: f.org.id,
    name: 'Elin Sand',
    auth_user_id: `auth_elin_${f.org.id}`,
    active: false,
  })
  const secrets = { cursor: secret('qvt_'), relay: secret('qva_') }
  const ids = {
    relay: uuid(),
    cursor: uuid(),
    old: uuid(),
    hook: uuid(),
    raycast: uuid(),
    claude: uuid(),
    pending: uuid(),
    unplugged: uuid(),
    forgotten: uuid(),
    gone: uuid(),
    departed: uuid(),
    foreign: uuid(),
  }
  const removedProfile = uuid()
  const sub = await t.run(async (ctx) => {
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
      created_at: CREATED,
    })
    const _id = await ctx.db.insert('billing_subscriptions', {
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
      created_at: CREATED,
      updated_at: CREATED,
    })
    await ctx.db.insert('billing_periods', {
      org_id: f.org.id,
      subscription_id: 'provider-sub',
      plan_id: plan,
      period_start: PAST,
      period_end: PERIOD,
      seats: 7,
      profile_ids: [],
      storage_bytes: 0,
      storage_blocks: 0,
      created_at: PAST,
    })
    await ctx.db.insert('agent_keys', {
      id: ids.relay,
      profile_id: f.agent.id,
      name: 'GitHub Actions',
      key_prefix: 'qva_2...22222',
      key_hash: await sha256hex(secrets.relay),
      created_at: CREATED,
      last_used_at: '2026-09-20T11:38:00.000Z',
    })
    const token = async (
      id: string,
      profile: Doc<'profiles'>,
      name: string,
      row: Partial<Doc<'mcp_tokens'>> = {},
    ) =>
      ctx.db.insert('mcp_tokens', {
        id,
        profile_id: profile.id,
        name,
        token_prefix: `qvt_${id.slice(0, 7)}`,
        token_hash: await sha256hex(id),
        access: 'write',
        created_at: CREATED,
        ...row,
      })
    await token(ids.cursor, f.user, 'Cursor', {
      token_hash: await sha256hex(secrets.cursor),
      last_used_at: '2026-09-20T11:48:00.000Z',
    })
    await token(ids.old, f.user, 'Cursor, old', { revoked_at: '2026-09-16T09:00:00.000Z' })
    // created on the last day of the July bucket, and after the last paid period
    await token(ids.hook, f.viewer, 'Old CI hook', {
      expires_at: '2026-09-09T00:00:00.000Z',
      created_at: '2026-07-31T10:00:00.000Z',
    })
    await token(ids.raycast, elin, 'Raycast', {
      access: 'read',
      created_at: '2026-09-17T00:00:00.000Z',
    })
    const connection = (
      id: string,
      profile: Doc<'profiles'>,
      client_name: string,
      row: Partial<Doc<'oauth_connections'>> = {},
    ) =>
      ctx.db.insert('oauth_connections', {
        id,
        authorization_hash: `hash-${id}`,
        auth_user_id: profile.auth_user_id ?? '',
        profile_id: profile.id,
        org_id: profile.org_id,
        client_id: `client-${client_name.toLowerCase()}`,
        client_name,
        resource: 'https://qivo.test/mcp',
        requested_scopes: ['qivo:read', 'qivo:write'],
        scopes: ['qivo:read', 'qivo:write'],
        created_at: CREATED,
        authorization_expires_at: CREATED,
        approved_at: CREATED,
        ...row,
      })
    await connection(ids.claude, f.admin, 'Claude', { last_used_at: '2026-09-20T11:56:00.000Z' })
    await connection(ids.pending, f.admin, 'Pending', { approved_at: undefined, scopes: [] })
    const deleted = { revoked_at: '2026-09-18T00:00:00.000Z', revocation_reason: 'deleted' }
    await connection(ids.unplugged, f.guest, 'ChatGPT', { ...deleted, scopes: ['qivo:read'] })
    await connection(ids.forgotten, f.guest, 'Forgotten', deleted)
    // another organization's token, invisible here
    await token(ids.foreign, f.otherAdmin, 'Elsewhere')

    const usage =
      (profile_id: string, credential_id: string, name: string, calls: number) =>
      (period_start: string, org_id = f.org.id) =>
        ctx.db.insert('billing_usage', {
          org_id,
          profile_id,
          credential_id,
          credential_name: name,
          period_start,
          calls,
        })
    for (const plant of [
      usage(f.user.id, `mcp_tokens:${ids.cursor}`, 'Cursor', 18),
      usage(f.admin.id, `oauth_connections:${ids.claude}`, 'Claude', 9),
      usage(f.agent.id, `agent_keys:${ids.relay}`, 'GitHub Actions', 5),
      usage(f.user.id, `mcp_tokens:${ids.old}`, 'Cursor, old', 2),
      usage(f.guest.id, `oauth_connections:${ids.unplugged}`, 'ChatGPT', 4),
      // a token its owner deleted, and a key of a member who left
      usage(f.user.id, `mcp_tokens:${ids.gone}`, 'Zapier', 3),
      usage(removedProfile, `agent_keys:${ids.departed}`, 'Night job', 7),
    ])
      await plant(PERIOD)
    await usage(
      f.otherAdmin.id,
      `mcp_tokens:${ids.foreign}`,
      'Elsewhere',
      50,
    )(PERIOD, f.otherOrg.id)
    await usage(f.user.id, `mcp_tokens:${ids.cursor}`, 'Cursor', 30)(PAST)
    await usage(f.agent.id, `agent_keys:${ids.relay}`, 'GitHub Actions', 11)(MONTH)
    await usage(f.user.id, `mcp_tokens:${ids.gone}`, 'Zapier', 2)(FREE)
    // a calendar month keeps no total (model/billingUsage.ts recordApiCall),
    // so the page finds MONTH from its usage rows
    for (const [period_start, calls] of [
      [PERIOD, 48],
      [PAST, 30],
      [FREE, 2],
    ] as const)
      await ctx.db.insert('billing_usage_totals', {
        org_id: f.org.id,
        period_start,
        calls,
        reported_api_blocks: 0,
      })
    await ctx.db.insert('billing_usage_totals', {
      org_id: f.otherOrg.id,
      period_start: '2025-01-01T00:00:00.000Z',
      calls: 50,
      reported_api_blocks: 0,
    })
    const sub = await ctx.db.get(_id)
    if (!sub) throw new Error('fixture subscription vanished')
    return sub
  })
  return { ...f, elin, ids, secrets, removedProfile, sub }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
type Table = 'agent_keys' | 'mcp_tokens' | 'oauth_connections'

const list = (t: T, f: Pick<OrgFixture, 'admin' | 'org'>, period?: string) =>
  as(t, f.admin).query(api.apiAccess.list, { org_id: f.org.id, period })
const revoke = (t: T, caller: Doc<'profiles'>, org_id: string, table: Table, id: string) =>
  as(t, caller).mutation(api.apiAccess.revoke, { org_id, table, id })

/* [name, state, calls] per listed row, in the page's order. */
const rows = (result: Awaited<ReturnType<typeof list>>) =>
  result.credentials.map((row) => [row.name, row.state, row.calls])

describe('apiAccess.list', () => {
  it('lists every credential kind with its owner, access, state and calls in the current period', async () => {
    const t = newT()
    const f = await fixture(t)
    const result = await list(t, f)
    expect(result.period).toBe(PERIOD)
    expect(rows(result)).toEqual([
      ['Cursor', 'active', 18],
      ['Claude', 'active', 9],
      ['Night job', 'deleted', 7],
      ['GitHub Actions', 'active', 5],
      ['ChatGPT', 'deleted', 4],
      ['Zapier', 'deleted', 3],
      ['Cursor, old', 'revoked', 2],
      ['Old CI hook', 'expired', 0],
      ['Raycast', 'inactive', 0],
    ])
    const row = (name: string) => result.credentials.find((r) => r.name === name)
    expect(row('Cursor')).toEqual({
      table: 'mcp_tokens',
      id: f.ids.cursor,
      name: 'Cursor',
      prefix: `qvt_${f.ids.cursor.slice(0, 7)}`,
      profile_id: f.user.id,
      person: 'user',
      agent: false,
      access: 'write',
      expires_at: null,
      last_used_at: '2026-09-20T11:48:00.000Z',
      revoked_at: null,
      revoked_by_admin: false,
      state: 'active',
      calls: 18,
    })
    expect(row('Claude')).toMatchObject({
      table: 'oauth_connections',
      prefix: 'client-claude',
      person: 'admin',
      access: 'write',
    })
    expect(row('GitHub Actions')).toMatchObject({
      table: 'agent_keys',
      prefix: 'qva_2...22222',
      person: 'Relay',
      agent: true,
      access: 'write',
    })
    // an expired token keeps the access it was created with
    expect(row('Old CI hook')).toMatchObject({
      access: 'write',
      expires_at: '2026-09-09T00:00:00.000Z',
    })
    expect(row('Raycast')).toMatchObject({ person: 'Elin Sand', access: 'read' })
    // the owner deleted it, but its calls in the period still count
    expect(row('ChatGPT')).toMatchObject({ prefix: 'client-chatgpt', access: 'read' })
    // a deleted token keeps its owner; a departed agent's key is "Removed
    // user", still an agent's
    expect(row('Zapier')).toMatchObject({
      table: 'mcp_tokens',
      id: f.ids.gone,
      prefix: null,
      person: 'user',
      agent: false,
      access: null,
    })
    expect(row('Night job')).toMatchObject({
      table: 'agent_keys',
      profile_id: f.removedProfile,
      person: 'Removed user',
      agent: true,
    })
    // unfinished authorizations, connections deleted without calls and other
    // organizations' credentials never show
    for (const name of ['Pending', 'Forgotten', 'Elsewhere']) expect(row(name)).toBeUndefined()
    expect(result.summary).toEqual({
      calls: 48,
      included_calls: 175_000,
      plan: {
        currency: 'usd',
        api_calls_per_seat: 25_000,
        api_block_size: 25_000,
        api_block_price_cents: 100,
      },
      waived: false,
    })
  })

  it('lists the current period first and every earlier one newest first, and switches between them', async () => {
    const t = newT()
    const f = await fixture(t)
    const current = await list(t, f)
    expect(current.periods).toEqual([
      { key: PERIOD, kind: 'paid', start: PERIOD, end: END, current: true },
      { key: PAST, kind: 'paid', start: PAST, end: PERIOD, current: false },
      {
        key: MONTH,
        kind: 'month',
        start: '2026-07-01T00:00:00.000Z',
        end: '2026-07-31T00:00:00.000Z',
        current: false,
      },
      { key: FREE, kind: 'open', start: FREE, end: null, current: false },
    ])

    const past = await list(t, f, PAST)
    expect(past.period).toBe(PAST)
    expect(past.summary).toMatchObject({ calls: 30, waived: false })
    expect(rows(past).slice(0, 2)).toEqual([
      ['Cursor', 'active', 30],
      ['Claude', 'active', 0],
    ])
    // the owner-deleted connection had no calls then, and a token created
    // after the period ended did not exist yet
    for (const name of ['ChatGPT', 'Raycast'])
      expect(past.credentials.find((r) => r.name === name)).toBeUndefined()

    const month = await list(t, f, MONTH)
    expect(month.summary).toMatchObject({ calls: 11, waived: true })
    expect(rows(month)[0]).toEqual(['GitHub Actions', 'active', 11])
    // a month runs to the end of its last day
    const names = month.credentials.map((r) => r.name)
    expect(names).toContain('Old CI hook')
    expect(names).not.toContain('Raycast')

    const free = await list(t, f, FREE)
    expect(free.summary).toMatchObject({ calls: 2, waived: true })
    expect(rows(free)[0]).toEqual(['Zapier', 'deleted', 2])

    // an unknown key shows the current period
    expect((await list(t, f, 'month:1999-01')).period).toBe(PERIOD)
  })

  it('shows a past paid period with the seats it was billed with, no allowance for other past periods, and a pending interval as not charged', async () => {
    const t = newT()
    const f = await fixture(t)
    // renewal raised the seats from 7 to 10 (25,000 calls each)
    await t.run((ctx) => ctx.db.patch(f.sub._id, { billed_seats: 10, next_seats: 10 }))
    expect((await list(t, f)).summary.included_calls).toBe(250_000)
    expect((await list(t, f, PAST)).summary).toMatchObject({
      included_calls: 175_000,
      waived: false,
    })
    expect((await list(t, f, MONTH)).summary).toMatchObject({ included_calls: null, plan: null })
    expect((await list(t, f, FREE)).summary).toMatchObject({ included_calls: null, plan: null })

    // Renewal confirmation is late, so calls go to a pending interval, which
    // is never charged. The period before it keeps its subscription's seats.
    vi.mocked(Date.now).mockReturnValue(Date.parse(END) + 60_000)
    const pending = await list(t, f)
    expect(pending.periods[0]).toMatchObject({ key: END, kind: 'pending', current: true })
    expect(pending.summary.waived).toBe(true)
    expect((await list(t, f, PERIOD)).summary).toMatchObject({
      included_calls: 250_000,
      waived: false,
    })
  })

  it('counts a month bucket without a paid period, and shows only the count without a plan', async () => {
    const t = newT()
    const f = await fixture(t)
    await t.run((ctx) => ctx.db.delete(f.sub._id))
    const result = await list(t, f)
    expect(result.periods[0]).toEqual({
      key: 'month:2026-09',
      kind: 'month',
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-09-30T00:00:00.000Z',
      current: true,
    })
    expect(result.summary).toEqual({ calls: 0, included_calls: null, plan: null, waived: true })
    // the paid period it no longer has is still listed as a past period
    expect(result.periods.map((p) => p.key)).toContain(PERIOD)
  })

  // The demo refusal is in demo.test.ts, which signs in a real demo login.
  it('refuses members who are not admins and other organizations', async () => {
    const t = newT()
    const f = await fixture(t)
    for (const member of [f.user, f.viewer, f.guest])
      await expectRefusal(
        as(t, member).query(api.apiAccess.list, { org_id: f.org.id }),
        'forbidden',
        /^admin only$/,
      )
    await expectRefusal(
      as(t, f.otherAdmin).query(api.apiAccess.list, { org_id: f.org.id }),
      'forbidden',
    )
  })
})

/* REST and MCP with one secret, the way an API client calls them. */
async function machine(t: T, path: '/v1/me' | '/mcp', bearer: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${bearer}`,
  }
  const init: FetchInit =
    path === '/mcp'
      ? {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'api-access-test', version: '1.0.0' },
            },
          }),
        }
      : { method: 'GET', headers }
  const res = await (
    t as unknown as {
      fetch(path: string, init?: FetchInit): Promise<{ status: number; text(): Promise<string> }>
    }
  ).fetch(path, init)
  return { status: res.status, body: await res.text() }
}

/* The stored credential rows the revoke tests change. */
const stored = (t: T, f: Fixture) =>
  t.run(async (ctx) => ({
    relay: await byId(ctx, 'agent_keys', f.ids.relay),
    cursor: await byId(ctx, 'mcp_tokens', f.ids.cursor),
    old: await byId(ctx, 'mcp_tokens', f.ids.old),
    claude: await byId(ctx, 'oauth_connections', f.ids.claude),
    unplugged: await byId(ctx, 'oauth_connections', f.ids.unplugged),
  }))

describe('apiAccess.revoke', () => {
  it('revokes each kind, narrates for the export only, and the owner sees that an admin revoked it', async () => {
    const t = newT()
    const f = await fixture(t)
    const org = f.org.id
    expect(await revoke(t, f.admin, org, 'mcp_tokens', f.ids.cursor)).toBe(true)
    expect(await revoke(t, f.admin, org, 'oauth_connections', f.ids.claude)).toBe(true)
    expect(await revoke(t, f.admin, org, 'agent_keys', f.ids.relay)).toBe(true)

    const after = await stored(t, f)
    expect(after.cursor).toMatchObject({ revoked_by_admin: true })
    expect(after.cursor?.revoked_at).toBeDefined()
    expect(after.claude).toMatchObject({ revocation_reason: 'admin' })
    expect(after.claude?.revoked_at).toBeDefined()
    expect(after.relay?.revoked_at).toBeDefined()

    const listed = await list(t, f)
    for (const name of ['Cursor', 'Claude', 'GitHub Actions'])
      expect(listed.credentials.find((r) => r.name === name)?.state).toBe('revoked')
    expect(listed.credentials.find((r) => r.name === 'Cursor')?.revoked_by_admin).toBe(true)

    // the owners' own lists say who ended them; the connection stays listed
    const mine = await as(t, f.user).query(api.tokens.listMcpTokens, {})
    expect(mine.find((row) => row.id === f.ids.cursor)).toMatchObject({ revokedByAdmin: true })
    expect(mine.find((row) => row.id === f.ids.old)).toMatchObject({ revokedByAdmin: false })
    const apps = await as(t, f.admin).query(api.oauthConnections.list, {})
    expect(apps.find((row) => row.id === f.ids.claude)).toMatchObject({ revokedByAdmin: true })
    expect(await t.mutation(internal.oauthConnections.touch, { id: f.ids.claude })).toBe(false)

    const events = await activityFor(t, org)
    expect(events.map((e) => [e.verb, e.target_id, e.label, e.detail, e.actor_id])).toEqual([
      ['revoked', f.user.id, 'user', 'a personal token “Cursor”', f.admin.id],
      ['revoked', f.admin.id, 'admin', 'the connection to “Claude”', f.admin.id],
      ['revoked', f.agent.id, 'Relay', 'the key “GitHub Actions”', f.admin.id],
    ])
  })

  it('stops a revoked token and key on REST and MCP', async () => {
    const t = newT()
    const f = await fixture(t)
    expect((await machine(t, '/v1/me', f.secrets.cursor)).status).toBe(200)
    expect((await machine(t, '/mcp', f.secrets.cursor)).status).toBe(200)
    expect((await machine(t, '/v1/me', f.secrets.relay)).status).toBe(200)
    await revoke(t, f.admin, f.org.id, 'mcp_tokens', f.ids.cursor)
    await revoke(t, f.admin, f.org.id, 'agent_keys', f.ids.relay)
    expect(await machine(t, '/v1/me', f.secrets.cursor)).toEqual({
      status: 401,
      body: '{"error":"this personal access token has been revoked or has expired"}',
    })
    expect(await machine(t, '/mcp', f.secrets.cursor)).toEqual({
      status: 401,
      body: '{"error":"unknown, expired or revoked MCP token"}',
    })
    expect(await machine(t, '/v1/me', f.secrets.relay)).toEqual({
      status: 401,
      body: '{"error":"this agent key has been revoked"}',
    })
  })

  it('stops a revoked connection getting new tokens and a revoked token’s webhook events', async () => {
    // Fake timers keep scheduled webhook delivery from sending a real request.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    onTestFinished(() => {
      vi.clearAllTimers()
      vi.useRealTimers()
    })
    const t = newT()
    const f = await fixture(t)

    // the connection's refresh, as the OAuth token endpoint claims it
    const refresh = (hash: string) =>
      t.mutation(internal.oauthConnections.claimIssuance, {
        id: f.ids.claude,
        authUserId: f.admin.auth_user_id ?? '',
        clientId: 'client-claude',
        resource: 'https://qivo.test/mcp',
        scopes: ['qivo:read'],
        credentialHash: hash,
        kind: 'refresh_token',
      })
    expect(await refresh('refresh-before')).toBe(true)

    // a task.updated subscription owned by Cursor, the user's token
    const cursor = (await stored(t, f)).cursor
    if (!cursor) throw new Error('fixture token vanished')
    const owner: EventOwner = {
      profile_id: f.user.id,
      credential_table: 'mcp_tokens',
      credential_id: cursor.id,
      credential_row_id: cursor._id,
    }
    const subscription = uuid()
    await t.mutation(internal.webhooks.save, {
      owner,
      id: subscription,
      name: 'task.updated',
      filters: {},
      url: 'https://receiver.example/events',
      encrypted_secret: 'encrypted-test-key',
    })
    // a task in the project the user leads, so the token can see its events
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.meta.id })
    const deliveries = () => t.run((ctx) => ctx.db.query('webhook_deliveries').collect())
    /** Renames the task and answers how many deliveries its event queued. */
    const rename = async (title: string) => {
      const before = (await deliveries()).length
      await t.run(async (ctx) => {
        const old = await ctx.db.get(issue._id)
        if (!old) throw new Error('fixture task vanished')
        await ctx.db.patch(issue._id, { title })
        const now = await ctx.db.get(issue._id)
        if (now) await notifyIssueUpdate(ctx, { before: old, after: now, actor: f.admin, now: NOW })
      })
      await flushWebhookEvents(t)
      return (await deliveries()).length - before
    }
    expect(await rename('Before the revoke')).toBe(1)
    const [queued] = await deliveries()

    await revoke(t, f.admin, f.org.id, 'oauth_connections', f.ids.claude)
    await revoke(t, f.admin, f.org.id, 'mcp_tokens', f.ids.cursor)
    expect(await refresh('refresh-after')).toBe(false)
    // the delivery queued before the revoke fails, and new events skip it
    expect(await t.mutation(internal.webhooks.claim, { id: queued.id })).toBeNull()
    expect((await deliveries()).find((row) => row.id === queued.id)?.status).toBe('failed')
    expect(await rename('After the revoke')).toBe(0)
  })

  it('answers another organization, an unknown id and an unfinished authorization alike, and refuses members', async () => {
    const t = newT()
    const f = await fixture(t)
    const org = f.org.id
    for (const [table, id] of [
      ['mcp_tokens', f.ids.foreign],
      ['mcp_tokens', uuid()],
      // a deleted token's id, from its usage row
      ['mcp_tokens', f.ids.gone],
      // the right id under another table
      ['agent_keys', f.ids.cursor],
      ['oauth_connections', f.ids.pending],
    ] as const)
      await expectRefusal(revoke(t, f.admin, org, table, id), 'not_found', /^credential not found$/)
    // the other organization's admin cannot reach this one's credentials
    await expectRefusal(
      revoke(t, f.otherAdmin, f.otherOrg.id, 'mcp_tokens', f.ids.cursor),
      'not_found',
      /^credential not found$/,
    )
    // a member cannot revoke here, not even their own token
    for (const member of [f.user, f.viewer, f.guest])
      await expectRefusal(
        revoke(t, member, org, 'mcp_tokens', f.ids.cursor),
        'forbidden',
        /^admin only$/,
      )
    expect((await stored(t, f)).cursor?.revoked_at).toBeUndefined()
    expect(await activityFor(t, org)).toEqual([])
  })

  it('changes nothing for a credential that is already revoked', async () => {
    const t = newT()
    const f = await fixture(t)
    const org = f.org.id
    const before = await stored(t, f)
    expect(await revoke(t, f.admin, org, 'mcp_tokens', f.ids.old)).toBe(false)
    // the owner deleted this connection; an admin revoke keeps it deleted
    expect(await revoke(t, f.admin, org, 'oauth_connections', f.ids.unplugged)).toBe(false)
    const after = await stored(t, f)
    expect(after.old).toEqual(before.old)
    expect(after.unplugged).toEqual(before.unplugged)
    expect(await activityFor(t, org)).toEqual([])
  })

  it('lets an admin revoke while billing has paused editing', async () => {
    const t = newT()
    const f = await fixture(t)
    await t.run((ctx) => ctx.db.patch(f.sub._id, { status: 'unpaid' }))
    // editing is paused, even for the admin
    await expectRefusal(
      as(t, f.admin).mutation(api.tokens.createAgentKey, {
        org_id: f.org.id,
        id: uuid(),
        agent_id: f.agent.id,
        name: 'New key',
        key_prefix: 'qva_0...00000',
        key_hash: 'cd'.repeat(32),
      }),
      'forbidden',
      /read-only/,
    )
    expect(await revoke(t, f.admin, f.org.id, 'mcp_tokens', f.ids.cursor)).toBe(true)
    expect((await stored(t, f)).cursor).toMatchObject({ revoked_by_admin: true })
  })
})

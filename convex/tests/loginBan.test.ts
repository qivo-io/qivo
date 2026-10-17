/* A platform ban on a login (Better Auth `banned`, set by adminAuth.banUser)
 * stops that person's personal tokens exactly like a deactivated account. REST
 * and MCP refuse them with the deactivated sentences, nothing is stamped or
 * metered, and the webhook subscriptions they own receive no events and fail
 * their queued deliveries. A ban stops counting once its banExpires has
 * passed, lifting it restores everything, and agent keys, which belong to no
 * login, carry on. A login Better Auth no longer has stops its tokens the
 * same way. OAuth's ban checks are in tests/oauth.test.ts. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { components, internal } from '../_generated/api'
import type { EventOwner } from '../lib/taskEvents'
import { sha256hex } from '../machine/auth'
import { notifyIssueUpdate } from '../model/messages'
import { flushWebhookEvents, newT, plantIssue, type T, uuid, withOrg } from './helpers.setup'

const AT = Date.parse('2026-10-04T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const iso = (ms: number) => new Date(ms).toISOString()

beforeEach(() => {
  // Fake timers keep scheduled webhook delivery from sending a real request.
  vi.useFakeTimers()
  vi.setSystemTime(AT)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }
type Reply = { status: number; body: unknown }

async function send(t: T, path: string, init: FetchInit): Promise<Reply> {
  const res = await (
    t as unknown as { fetch(path: string, init: FetchInit): Promise<Response> }
  ).fetch(path, init)
  const text = await res.text()
  // MCP answers a legacy tools/call as one server-sent event
  const data = text.startsWith('event: message\ndata: ')
    ? text.slice('event: message\ndata: '.length)
    : text
  return { status: res.status, body: JSON.parse(data) }
}

const rest = (t: T, secret: string, path = '/v1/projects') =>
  send(t, path, { method: 'GET', headers: { Authorization: `Bearer ${secret}` } })

const mcp = (t: T, secret: string) =>
  send(t, '/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_projects', arguments: {} },
    }),
  })

/* withOrg plus a recorded billing period, so every accepted call writes
 * usage, the admin's personal token, and an agent key the admin created. The
 * admin signs in with the fixture's real Better Auth login. The agent reads
 * the task projects so its webhook subscription has events to receive. */
async function fixture() {
  const t = newT()
  const f = await withOrg(t)
  await t.run(async (ctx) => {
    const planId = uuid()
    await ctx.db.insert('billing_plans', {
      id: planId,
      name: 'Team',
      currency: 'usd',
      seat_price_cents: 100,
      minimum_seats: 1,
      storage_gb_per_seat: 1,
      minimum_storage_gb: 5,
      api_calls_per_seat: 25_000,
      api_block_size: 25_000,
      api_block_price_cents: 100,
      storage_block_price_cents: 100,
      archived: false,
      created_at: iso(AT - DAY),
    })
    await ctx.db.insert('billing_subscriptions', {
      id: uuid(),
      org_id: f.org.id,
      plan_id: planId,
      status: 'active',
      polar_subscription_id: 'provider-sub',
      current_period_start: iso(AT - DAY),
      current_period_end: iso(AT + 29 * DAY),
      billed_seats: 5,
      next_seats: 5,
      cancel_at_period_end: false,
      created_at: iso(AT - DAY),
      updated_at: iso(AT - DAY),
    })
    await ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    })
  })
  const loginId = f.admin.auth_user_id!

  const token = `qvt_${'b4a7'.repeat(12)}`
  const key = `qva_${'c9d2'.repeat(12)}`
  const tokenId = uuid()
  const keyId = uuid()
  const tokenHash = await sha256hex(token)
  const keyHash = await sha256hex(key)
  const rows = await t.run(async (ctx) => ({
    token: await ctx.db.insert('mcp_tokens', {
      id: tokenId,
      profile_id: f.admin.id,
      name: 'Laptop',
      token_prefix: token.slice(0, 11),
      token_hash: tokenHash,
      access: 'read',
      created_at: iso(AT - DAY),
    }),
    key: await ctx.db.insert('agent_keys', {
      id: keyId,
      profile_id: f.agent.id,
      name: 'CI key',
      key_prefix: `${key.slice(0, 7)}...${key.slice(-5)}`,
      key_hash: keyHash,
      created_by: f.admin.id,
      created_at: iso(AT - DAY),
    }),
  }))
  const tokenOwner: EventOwner = {
    profile_id: f.admin.id,
    credential_table: 'mcp_tokens',
    credential_id: tokenId,
    credential_row_id: rows.token,
  }
  const keyOwner: EventOwner = {
    profile_id: f.agent.id,
    credential_table: 'agent_keys',
    credential_id: keyId,
    credential_row_id: rows.key,
  }

  /** Writes the ban columns as Better Auth's admin plugin keeps them. */
  const setBan = (banned: boolean, banExpires: number | null = null) =>
    t.mutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'user',
        where: [{ field: '_id', value: loginId }],
        update: { banned, banExpires },
      },
    })
  /** Removes the admin's login from Better Auth, leaving the seat as it is. */
  const deleteLogin = () =>
    t.mutation(components.betterAuth.adapter.deleteOne, {
      input: { model: 'user', where: [{ field: '_id', value: loginId }] },
    })
  /** Calls recorded per credential, as "table:uuid". */
  const usage = async () =>
    Object.fromEntries(
      (await t.run((ctx) => ctx.db.query('billing_usage').collect())).map((row) => [
        row.credential_id,
        row.calls,
      ]),
    )
  const lastUsed = async () => ({
    token: (await t.run((ctx) => ctx.db.get(rows.token)))?.last_used_at,
    key: (await t.run((ctx) => ctx.db.get(rows.key)))?.last_used_at,
  })
  return {
    t,
    f,
    token,
    key,
    tokenId,
    keyId,
    tokenOwner,
    keyOwner,
    setBan,
    deleteLogin,
    usage,
    lastUsed,
  }
}

type Fx = Awaited<ReturnType<typeof fixture>>

/** The replies a stopped personal token gets: the person's deactivated
 * sentence on REST, MCP's one sentence for a refused personal token, and the
 * webhook routes' sentence for any refused credential. */
async function expectStopped(x: Fx) {
  expect(await rest(x.t, x.token)).toEqual({
    status: 401,
    body: { error: 'this account has been deactivated' },
  })
  expect(await mcp(x.t, x.token)).toEqual({
    status: 401,
    body: { error: 'unknown, expired or revoked MCP token' },
  })
  expect(await rest(x.t, x.token, '/v1/webhooks')).toEqual({
    status: 401,
    body: { error: 'Webhook credential is invalid or inactive' },
  })
}

/** One task.updated subscription for the token and one for the agent key,
 * and a rename that answers the subscriptions its event reached. */
async function subscriptions(x: Fx) {
  const { t } = x
  const issue = await plantIssue(t, { org_id: x.f.org.id, project_id: x.f.sub.id })
  const subscribe = async (owner: EventOwner) => {
    const id = uuid()
    await t.mutation(internal.webhooks.save, {
      owner,
      id,
      name: 'task.updated',
      filters: {},
      url: 'https://receiver.example/events',
      encrypted_secret: 'encrypted-test-key',
    })
    return id
  }
  const viaToken = await subscribe(x.tokenOwner)
  const viaKey = await subscribe(x.keyOwner)
  const deliveries = () => t.run((ctx) => ctx.db.query('webhook_deliveries').collect())
  const rename = async (title: string) => {
    const before = new Set((await deliveries()).map((row) => row.id))
    await t.run(async (ctx) => {
      const old = (await ctx.db.get(issue._id))!
      await ctx.db.patch(issue._id, { title })
      const now = (await ctx.db.get(issue._id))!
      await notifyIssueUpdate(ctx, { before: old, after: now, actor: x.f.user, now: iso(AT) })
    })
    await flushWebhookEvents(t)
    return (await deliveries())
      .filter((row) => !before.has(row.id))
      .map((row) => row.subscription_id)
      .sort()
  }
  return { viaToken, viaKey, deliveries, rename }
}

async function expectWorking(x: Fx, secret: string) {
  expect((await rest(x.t, secret)).status).toBe(200)
  expect((await mcp(x.t, secret)).status).toBe(200)
}

describe('a banned login’s personal tokens', () => {
  it('are refused exactly like a deactivated account, unstamped and unmetered, until the ban lifts', async () => {
    const x = await fixture()
    await x.setBan(true)
    await expectStopped(x)
    expect(await x.usage()).toEqual({})
    expect(await x.lastUsed()).toEqual({ token: undefined, key: undefined })
    const rate = await x.t.run((ctx) =>
      ctx.db
        .query('machine_rate_limits')
        .withIndex('by_key', (q) => q.eq('key', `profile:${x.f.admin.id}`))
        .unique(),
    )
    expect(rate).toBeNull()

    // the same replies as switching the account off
    await x.setBan(false)
    await x.t.run((ctx) => ctx.db.patch(x.f.admin._id, { active: false }))
    await expectStopped(x)
    await x.t.run((ctx) => ctx.db.patch(x.f.admin._id, { active: true }))

    // lifting the ban needs no other change
    await expectWorking(x, x.token)
    expect(await x.usage()).toEqual({ [`mcp_tokens:${x.tokenId}`]: 2 })
    expect((await x.lastUsed()).token).toBe(iso(AT))
  })

  it('count a ban only until its banExpires has passed', async () => {
    const x = await fixture()
    await x.setBan(true, AT + DAY)
    await expectStopped(x)
    expect(await x.usage()).toEqual({})
    // Better Auth clears an expired ban only at the next sign-in, so the flag
    // is still set here
    await x.setBan(true, AT - 1)
    await expectWorking(x, x.token)
    expect(await x.usage()).toEqual({ [`mcp_tokens:${x.tokenId}`]: 2 })
  })
})

describe('a platform ban', () => {
  it('leaves agent keys working, including those the banned person created', async () => {
    const x = await fixture()
    await x.setBan(true)
    expect((await rest(x.t, x.token)).status).toBe(401)
    await expectWorking(x, x.key)
    expect(await x.usage()).toEqual({ [`agent_keys:${x.keyId}`]: 2 })
    expect(await x.lastUsed()).toEqual({ token: undefined, key: iso(AT) })
  })

  it('stops the events of webhook subscriptions a banned login’s token owns and keeps them for when it lifts', async () => {
    const x = await fixture()
    const { t } = x
    const { viaToken, viaKey, deliveries, rename } = await subscriptions(x)

    expect(await rename('Before the ban')).toEqual([viaToken, viaKey].sort())
    const queued = (await deliveries()).find((row) => row.subscription_id === viaToken)!
    await x.setBan(true)
    // a delivery queued before the ban fails like any dead owner's
    expect(await t.mutation(internal.webhooks.claim, { id: queued.id })).toBeNull()
    expect((await deliveries()).find((row) => row.id === queued.id)?.status).toBe('failed')
    // new events skip it while the agent key's subscription still receives them
    expect(await rename('During the ban')).toEqual([viaKey])
    expect(await t.run((ctx) => ctx.db.query('webhook_subscriptions').collect())).toHaveLength(2)

    await x.setBan(false)
    expect(await rename('After the ban')).toEqual([viaToken, viaKey].sort())
  })
})

describe('a personal token whose login Better Auth no longer has', () => {
  it('is refused like a deactivated account, and its webhook subscriptions get no events', async () => {
    const x = await fixture()
    const { viaToken, viaKey, rename } = await subscriptions(x)
    expect(await rename('Before the login is gone')).toEqual([viaToken, viaKey].sort())
    await x.deleteLogin()
    await expectStopped(x)
    expect(await x.usage()).toEqual({})
    expect(await x.lastUsed()).toEqual({ token: undefined, key: undefined })
    expect(await rename('After the login is gone')).toEqual([viaKey])
  })
})

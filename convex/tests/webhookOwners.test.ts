import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { byId } from '../lib/db'
import type { EventOwner } from '../lib/taskEvents'
import { removeProfile } from '../model/cascade'
import { as, expectRefusal, newT, uuid, withOrg } from './helpers.setup'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime('2026-10-04T12:00:00Z')
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

async function fixture() {
  const t = newT({ transactionLimits: true })
  const fx = await withOrg(t)
  const credential = async (
    table: EventOwner['credential_table'] = 'mcp_tokens',
    profile: Doc<'profiles'> = table === 'agent_keys' ? fx.agent : fx.user,
    id = uuid(),
  ): Promise<EventOwner> =>
    t.run(async (ctx) => {
      const common = { id, profile_id: profile.id, created_at: new Date().toISOString() }
      const row =
        table === 'agent_keys'
          ? await ctx.db.insert(table, {
              ...common,
              name: 'Webhook test key',
              key_prefix: 'qva_test',
              key_hash: id,
            })
          : table === 'mcp_tokens'
            ? await ctx.db.insert(table, {
                ...common,
                name: 'Webhook test token',
                token_prefix: 'qvt_test',
                token_hash: id,
              })
            : await ctx.db.insert(table, {
                ...common,
                org_id: profile.org_id,
                auth_user_id: profile.auth_user_id!,
                authorization_hash: id,
                client_id: 'webhook-test-client',
                client_name: 'Webhook test client',
                resource: 'https://qivo.example/mcp',
                requested_scopes: ['qivo:read'],
                scopes: ['qivo:read'],
                approved_at: new Date().toISOString(),
                authorization_expires_at: '2027-01-01T00:00:00Z',
              })
      return {
        profile_id: profile.id,
        credential_table: table,
        credential_id: id,
        credential_row_id: row,
      }
    })
  const seed = (owner: EventOwner, count: number, disabled = false) =>
    t.run(async (ctx) => {
      for (let n = 0; n < count; n++) {
        const subscription_row_id = await ctx.db.insert('webhook_subscriptions', {
          id: uuid(),
          org_id: fx.org.id,
          owner,
          name: 'task.updated',
          filters: {},
          url: `https://receiver.example/${n}`,
          encrypted_secret: 'encrypted-test-secret',
          created_at: Date.now(),
          ...(disabled
            ? { disabled_at: Date.now(), disabled_reason: 'delivery_failures' as const }
            : {}),
        })
        await ctx.db.insert('webhook_health', {
          subscription_row_id,
          org_id: fx.org.id,
          last_status: disabled ? 400 : 204,
        })
      }
    })
  const save = (owner: EventOwner) =>
    t.mutation(internal.webhooks.save, {
      owner,
      id: uuid(),
      name: 'task.updated',
      filters: {},
      url: 'https://receiver.example/new',
      encrypted_secret: 'encrypted-test-secret',
    })
  const rows = () => t.run((ctx) => ctx.db.query('webhook_subscriptions').collect())
  return { t, fx, credential, seed, save, rows }
}

describe('webhook owner quota cleanup', () => {
  it('reclaims a full organization after key rotation, OAuth disconnect and profile removal', async () => {
    const f = await fixture()
    const revoked = await f.credential('agent_keys')
    const deleted = await f.credential()
    const replaced = await f.credential()
    const disconnected = await f.credential('oauth_connections')
    const removed = await f.credential('mcp_tokens', f.fx.guest)
    for (const owner of [revoked, deleted, replaced, disconnected, removed]) await f.seed(owner, 20)
    await as(f.t, f.fx.admin).mutation(api.tokens.revokeAgentKey, {
      org_id: f.fx.org.id,
      id: revoked.credential_id,
    })
    for (const owner of [deleted, replaced])
      await as(f.t, f.fx.user).mutation(api.tokens.deleteMcpToken, { id: owner.credential_id })
    await f.credential('mcp_tokens', f.fx.user, replaced.credential_id)
    await as(f.t, f.fx.user).mutation(api.oauthConnections.revoke, {
      id: disconnected.credential_id,
    })
    await f.t.run((ctx) =>
      removeProfile(ctx, { profile: f.fx.guest, now: new Date().toISOString() }),
    )
    expect(await f.rows()).toHaveLength(100)
    expect(await f.t.run((ctx) => ctx.db.query('webhook_health').collect())).toHaveLength(100)

    const fresh = await f.credential()
    const saved = await f.save(fresh)
    const retained = await f.rows()
    expect(retained).toMatchObject([{ id: saved.id, owner: fresh }])
    for (const health of await f.t.run((ctx) => ctx.db.query('webhook_health').collect()))
      expect(health.subscription_row_id).toBe(retained[0]._id)
  })

  it('preserves disabled subscriptions and inactive owners when enforcing the organization limit', async () => {
    const f = await fixture()
    const inactive = await f.credential('mcp_tokens', f.fx.guest)
    await f.seed(inactive, 20)
    await f.t.run((ctx) => ctx.db.patch(f.fx.guest._id, { active: false }))
    for (let n = 0; n < 4; n++) await f.seed(await f.credential(), 20, n === 0)

    await expectRefusal(
      f.save(await f.credential()),
      'bad_request',
      /Webhook subscription limit reached/,
    )
    expect(await f.rows()).toHaveLength(100)
    expect((await f.rows()).filter((row) => row.disabled_at !== undefined)).toHaveLength(20)
  })

  it('counts disabled subscriptions against their credential limit', async () => {
    const f = await fixture()
    const owner = await f.credential()
    await f.seed(owner, 20, true)
    await expectRefusal(f.save(owner), 'bad_request', /Webhook subscription limit reached/)
    expect(await f.rows()).toHaveLength(20)
  })

  it('removes subscriptions whose credential profile or OAuth identity no longer matches', async () => {
    const f = await fixture()
    const reassigned = await f.credential()
    const rebound = await f.credential('oauth_connections')
    for (const owner of [reassigned, rebound]) await f.seed(owner, 1)
    await f.t.run(async (ctx) => {
      const token = await byId(ctx, 'mcp_tokens', reassigned.credential_id)
      const grant = await byId(ctx, 'oauth_connections', rebound.credential_id)
      await ctx.db.patch(token!._id, { profile_id: f.fx.viewer.id })
      await ctx.db.patch(grant!._id, { auth_user_id: f.fx.viewer.auth_user_id! })
    })

    const fresh = await f.credential()
    await f.save(fresh)
    expect(await f.rows()).toMatchObject([{ owner: fresh }])
  })

  it('prunes expired registrations while retaining disabled and current registrations', async () => {
    const f = await fixture()
    const owner = await f.credential()
    await f.seed(owner, 20)
    await f.t.run(async (ctx) => {
      const rows = await ctx.db.query('webhook_subscriptions').collect()
      for (const row of rows.slice(0, 19))
        await ctx.db.patch(row._id, { expires_at: Date.now() - 1 })
      await ctx.db.patch(rows[19]._id, {
        disabled_at: Date.now(),
        disabled_reason: 'delivery_failures',
      })
    })
    await f.save(owner)
    const rows = await f.rows()
    expect(rows).toHaveLength(2)
    expect(rows.filter((row) => row.disabled_at !== undefined)).toHaveLength(1)
    expect(rows.every((row) => row.expires_at === undefined)).toBe(true)
    const health = await f.t.run((ctx) => ctx.db.query('webhook_health').collect())
    expect(
      health.some(
        (entry) =>
          entry.subscription_row_id === rows.find((row) => row.disabled_at !== undefined)!._id,
      ),
    ).toBe(true)
    for (const entry of health)
      expect(rows.some((row) => row._id === entry.subscription_row_id)).toBe(true)
  })
})

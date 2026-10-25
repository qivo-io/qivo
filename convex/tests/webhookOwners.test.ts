import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { createAuth } from '../auth'
import { byId } from '../lib/db'
import { LIMITS } from '../lib/limits'
import { mcpResource } from '../lib/oauth'
import type { EventOwner } from '../lib/taskEvents'
import { removeProfile } from '../model/cascade'
import { as, expectRefusal, newT, runInAuth, uuid, withOrg } from './helpers.setup'

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
    expires_at?: string,
  ): Promise<EventOwner> => {
    // each grant's own client, which Better Auth has, linked to the resource
    const client_id = `client-${id}`
    if (table === 'oauth_connections') {
      await t.mutation(components.betterAuth.adapter.create, {
        input: {
          model: 'oauthClient',
          data: { clientId: client_id, redirectUris: ['https://receiver.example/callback'] },
        },
      })
      await t.mutation(components.betterAuth.adapter.create, {
        input: {
          model: 'oauthClientResource',
          data: { clientId: client_id, resourceId: mcpResource() },
        },
      })
    }
    return t.run(async (ctx) => {
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
                access: 'read',
                expires_at,
              })
            : await ctx.db.insert(table, {
                ...common,
                org_id: profile.org_id,
                auth_user_id: profile.auth_user_id!,
                authorization_hash: id,
                client_id,
                client_name: 'Webhook test client',
                resource: mcpResource(),
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
  }
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

  /* A grant whose client Better Auth no longer has can never authorize
     again, so it gives back its quota, and so does a person whose login is
     gone. A disabled client, a client without its resource link and a
     banned login can be undone, and keep theirs. */
  it('reclaims a full organization held by a deleted OAuth client and a deleted login, and keeps what can be undone', async () => {
    const f = await fixture()
    const clientGone = await f.credential('oauth_connections')
    const clientDisabled = await f.credential('oauth_connections')
    const unlinked = await f.credential('oauth_connections')
    const live = await f.credential('oauth_connections')
    const loginGone = await f.credential('mcp_tokens', f.fx.viewer)
    for (const owner of [clientGone, clientDisabled, unlinked, live, loginGone])
      await f.seed(owner, 20)
    const clientOf = (owner: EventOwner) => `client-${owner.credential_id}`
    // the component's own delete, which runs no trigger, so the grant stays
    await f.t.mutation(components.betterAuth.oauth.deleteClients, {
      field: 'clientId',
      value: clientOf(clientGone),
      numItems: 10,
    })
    await runInAuth(f.t, async (ctx) => {
      const client = await ctx.db
        .query('oauthClient')
        .withIndex('clientId', (q) => q.eq('clientId', clientOf(clientDisabled)))
        .unique()
      if (client) await ctx.db.patch(client._id, { disabled: true })
      for (const link of await ctx.db
        .query('oauthClientResource')
        .withIndex('clientId_resourceId', (q) => q.eq('clientId', clientOf(unlinked)))
        .collect())
        await ctx.db.delete(link._id)
    })
    await f.t.mutation(components.betterAuth.adapter.deleteOne, {
      input: { model: 'user', where: [{ field: '_id', value: f.fx.viewer.auth_user_id! }] },
    })
    // the organization's list says which ones no longer count
    const listed = await f.t.query(internal.webhooks.listOrganization, {
      owner: await f.credential('mcp_tokens', f.fx.admin),
    })
    const statusOf = (owner: EventOwner) =>
      new Set(
        listed
          .filter((row) => row.owner.credential_id === owner.credential_id)
          .map((row) => row.status),
      )
    expect(statusOf(clientGone)).toEqual(new Set(['unauthorized']))
    expect(statusOf(loginGone)).toEqual(new Set(['unauthorized']))
    for (const owner of [clientDisabled, unlinked, live])
      expect(statusOf(owner)).toEqual(new Set(['active']))

    await f.save(await f.credential())
    const rows = await f.rows()
    expect(rows).toHaveLength(61)
    const count = (owner: EventOwner) =>
      rows.filter((row) => row.owner.credential_id === owner.credential_id).length
    expect([clientGone, loginGone].map(count)).toEqual([0, 0])
    expect([clientDisabled, unlinked, live].map(count)).toEqual([20, 20, 20])
    expect(await f.t.run((ctx) => ctx.db.query('webhook_health').collect())).toHaveLength(60)
  })

  it('revokes the grants of a client Better Auth deletes, which then give back their quota', async () => {
    const f = await fixture()
    const grant = await f.credential('oauth_connections')
    const other = await f.credential('oauth_connections')
    await f.seed(grant, 1)
    // as Better Auth's own delete of a client runs, such as /oauth2/delete-client
    await f.t.run(async (ctx) =>
      (await createAuth(ctx).$context).adapter.delete({
        model: 'oauthClient',
        where: [{ field: 'clientId', value: `client-${grant.credential_id}` }],
      }),
    )
    const connections = await f.t.run((ctx) => ctx.db.query('oauth_connections').collect())
    const row = (owner: EventOwner) =>
      connections.find((connection) => connection._id === owner.credential_row_id)
    expect(row(grant)).toMatchObject({
      revoked_at: expect.any(String),
      revocation_reason: 'client_deleted',
    })
    expect(row(other)?.revoked_at).toBeUndefined()
    await f.save(await f.credential())
    expect(
      (await f.rows()).filter((sub) => sub.owner.credential_id === grant.credential_id),
    ).toEqual([])
  })

  it('preserves disabled subscriptions and inactive owners when enforcing the organization limit', async () => {
    const f = await fixture()
    const inactive = await f.credential('mcp_tokens', f.fx.guest)
    await f.seed(inactive, 20)
    await f.t.run((ctx) => ctx.db.patch(f.fx.guest._id, { active: false }))
    for (let n = 0; n < 4; n++) await f.seed(await f.credential(), 20, n === 0)

    const full = await expectRefusal(f.save(await f.credential()), 'rule')
    expect(full.data.message).toBe(LIMITS.webhooksPerOrg.refusal)
    expect(await f.rows()).toHaveLength(100)
    expect((await f.rows()).filter((row) => row.disabled_at !== undefined)).toHaveLength(20)
  })

  it('counts disabled subscriptions against their credential limit', async () => {
    const f = await fixture()
    const owner = await f.credential()
    await f.seed(owner, 20, true)
    const full = await expectRefusal(f.save(owner), 'rule')
    expect(full.data.message).toBe(LIMITS.webhooksPerKey.refusal)
    expect(await f.rows()).toHaveLength(20)
  })

  it('reclaims an expired personal token and keeps one whose expiry is still ahead', async () => {
    const f = await fixture()
    // the fixture clock is 2026-10-04T12:00:00Z; the instant itself has expired
    const expired = await f.credential('mcp_tokens', f.fx.user, uuid(), '2026-10-04T12:00:00.000Z')
    const current = await f.credential('mcp_tokens', f.fx.user, uuid(), '2026-10-04T12:00:00.001Z')
    for (const owner of [expired, current]) await f.seed(owner, 20)

    const fresh = await f.credential()
    await f.save(fresh)
    const rows = await f.rows()
    expect(rows).toHaveLength(21)
    expect(rows.filter((row) => row.owner.credential_id === expired.credential_id)).toEqual([])
    expect(rows.filter((row) => row.owner.credential_id === current.credential_id)).toHaveLength(20)
    expect(await f.t.run((ctx) => ctx.db.query('webhook_health').collect())).toHaveLength(20)
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

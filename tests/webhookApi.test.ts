import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { components, internal } from '../convex/_generated/api'
import authSchema from '../convex/betterAuth/schema'
import { mcpResource } from '../convex/lib/oauth'
import { CallbackError, decryptSecret } from '../convex/lib/webhookTransport'
import { sha256hex } from '../convex/machine/auth'
import { notifyIssueUpdate } from '../convex/model/messages'
import { flushWebhookEvents, newT, plantIssue, uuid, withOrg } from '../convex/tests/helpers.setup'

const receiver = vi.hoisted(() => ({
  valid: true,
  status: 200,
  payloads: [] as string[],
  keys: [] as { secret: string; previousSecret?: string }[],
  error: undefined as Error | undefined,
}))
vi.mock('../convex/lib/webhookTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../convex/lib/webhookTransport')>()
  return {
    ...actual,
    postWebhook: vi.fn(
      async (
        _url: string,
        secret: string,
        _id: string,
        _sub: string,
        body: string,
        previousSecret?: string,
      ) => {
        if (receiver.error) throw receiver.error
        const payload = JSON.parse(body) as { challenge?: string }
        receiver.payloads.push(body)
        receiver.keys.push({ secret, previousSecret })
        return {
          status: receiver.status,
          body: JSON.stringify({
            challenge: receiver.valid ? payload.challenge : 'wrong-challenge',
          }),
        }
      },
    ),
  }
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime('2026-10-04T12:00:00Z')
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-only-encryption-key')
  receiver.valid = true
  receiver.status = 200
  receiver.payloads = []
  receiver.keys = []
  receiver.error = undefined
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function fixture() {
  const t = newT()
  const fx = await withOrg(t)
  const qvt = `qvt_${'11'.repeat(24)}`
  const qva = `qva_${'22'.repeat(24)}`
  const tokenHash = await sha256hex(qvt)
  const keyHash = await sha256hex(qva)
  await t.run(async (ctx) => {
    await ctx.db.insert('mcp_tokens', {
      id: uuid(),
      profile_id: fx.user.id,
      name: 'Events',
      token_prefix: 'qvt_test',
      token_hash: tokenHash,
      created_at: new Date().toISOString(),
    })
    await ctx.db.insert('agent_keys', {
      id: uuid(),
      profile_id: fx.agent.id,
      name: 'Events',
      key_prefix: 'qva_test',
      key_hash: keyHash,
      created_at: new Date().toISOString(),
    })
    await ctx.db.insert('project_access', {
      project_id: fx.meta.id,
      profile_id: fx.agent.id,
      level: 'user',
    })
  })
  const issue = await plantIssue(t, { org_id: fx.org.id, project_id: fx.sub.id })
  const mcp = async (method: string, params: Record<string, unknown> = {}, credential = qvt) => {
    const response = await t.fetch('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
        'Mcp-Method': method,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    })
    return {
      status: response.status,
      body: JSON.parse(await response.text()) as {
        result?: { events?: { name: string }[]; id?: string; refreshBefore?: string | null }
        error?: { code: number; data?: Record<string, unknown> }
      },
    }
  }
  const rest = (path: string, method: string, body?: unknown, credential = qva) =>
    t.fetch(path, {
      method,
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const params = {
    name: 'task.updated',
    arguments: { task_id: issue.id, project_id: fx.sub.id },
    delivery: {
      mode: 'webhook',
      url: 'https://receiver.example/events',
      secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
    },
  }
  const update = async (title: string) => {
    await t.run(async (ctx) => {
      const before = (await ctx.db.get(issue._id))!
      await ctx.db.patch(issue._id, { title })
      const after = (await ctx.db.get(issue._id))!
      await notifyIssueUpdate(ctx, {
        before,
        after,
        actor: fx.user,
        now: new Date().toISOString(),
      })
    })
    await flushWebhookEvents(t)
  }
  const oauth = async (scopes = ['qivo:read']) => {
    t.registerComponent('betterAuth', authSchema, import.meta.glob('../convex/betterAuth/**/*.*s'))
    const user = await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: {
          name: fx.user.name,
          email: fx.user.email!,
          emailVerified: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })
    const clientId = uuid()
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'oauthClient',
        data: { clientId, redirectUris: ['https://receiver.example/callback'], scopes },
      },
    })
    const connectionId = uuid()
    const connectionRowId = await t.run(async (ctx) => {
      await ctx.db.patch(fx.user._id, { auth_user_id: user._id as string })
      return ctx.db.insert('oauth_connections', {
        id: connectionId,
        profile_id: fx.user.id,
        org_id: fx.org.id,
        auth_user_id: user._id as string,
        client_id: clientId,
        client_name: 'Webhook tests',
        resource: mcpResource(),
        authorization_hash: uuid(),
        requested_scopes: scopes,
        scopes,
        created_at: new Date().toISOString(),
        approved_at: new Date().toISOString(),
        authorization_expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
    })
    const token = `qvo_${uuid()}`
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'oauthAccessToken',
        data: {
          token: await sha256hex(token.slice(4)),
          clientId,
          userId: user._id as string,
          referenceId: connectionId,
          scopes,
          expiresAt: Date.now() + 60_000,
        },
      },
    })
    return { token, connectionRowId }
  }
  return { t, fx, issue, mcp, rest, params, update, qvt, qva, oauth }
}

describe('MCP Events and generic REST webhooks', () => {
  it('discovers events and completes subscribe, verified delivery, refresh and unsubscribe', async () => {
    const f = await fixture()
    const discovery = await f.mcp('events/list')
    expect(discovery.body.result?.events?.map((event) => event.name)).toEqual([
      'task.created',
      'task.updated',
      'task.deleted',
      'comment.created',
    ])
    const subscribed = await f.mcp('events/subscribe', f.params)
    expect(subscribed.status).toBe(200)
    expect(subscribed.body.result?.id).toBeDefined()
    expect(subscribed.body.result?.refreshBefore).toBe(
      new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
    )
    const refresh = await f.mcp('events/subscribe', {
      ...f.params,
      arguments: { project_id: f.fx.sub.id, task_id: f.issue.id },
    })
    expect(refresh.body.result?.id).toBe(subscribed.body.result?.id)
    expect(await f.t.run((ctx) => ctx.db.query('webhook_subscriptions').collect())).toHaveLength(1)
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.issue._id, { title: 'Trigger work' })
      const after = (await ctx.db.get(f.issue._id))!
      await notifyIssueUpdate(ctx, {
        before: f.issue,
        after,
        actor: f.fx.user,
        now: new Date().toISOString(),
      })
    })
    await flushWebhookEvents(f.t)
    const delivery = await f.t.run((ctx) => ctx.db.query('webhook_deliveries').first())
    await f.t.action(internal.webhookActions.deliver, { id: delivery!.id })
    expect(JSON.parse(receiver.payloads.at(-1)!)).toMatchObject({
      name: 'task.updated',
      data: { task_id: f.issue.id, changed_fields: ['title'] },
    })
    expect(await f.t.run((ctx) => ctx.db.query('webhook_deliveries').first())).toMatchObject({
      status: 'delivered',
      attempts: 1,
    })
    const unsubscribed = await f.mcp('events/unsubscribe', {
      name: f.params.name,
      arguments: f.params.arguments,
      delivery: { url: f.params.delivery.url },
    })
    expect(unsubscribed.body.error).toBeUndefined()
    expect(unsubscribed.body.result).toMatchObject({})
    expect(await f.t.run((ctx) => ctx.db.query('webhook_subscriptions').collect())).toEqual([])
    await f.update('After unsubscribe')
    expect(await f.t.run((ctx) => ctx.db.query('webhook_deliveries').collect())).toHaveLength(1)
  })

  it('refuses failed verification and unsupported delivery, filters, secrets and replay', async () => {
    const f = await fixture()
    receiver.valid = false
    expect((await f.mcp('events/subscribe', f.params)).body.error?.code).toBe(-32015)
    expect(await f.t.run((ctx) => ctx.db.query('webhook_subscriptions').collect())).toEqual([])
    receiver.valid = true
    for (const params of [
      { ...f.params, arguments: { task_id: 'invalid' } },
      { ...f.params, delivery: { ...f.params.delivery, secret: 'invalid' } },
      { ...f.params, ttlMs: -1 },
    ])
      expect((await f.mcp('events/subscribe', params)).body.error?.code).toBe(-32602)
    for (const params of [
      { ...f.params, delivery: { ...f.params.delivery, mode: 'push' } },
      { ...f.params, cursor: 'old' },
    ])
      expect((await f.mcp('events/subscribe', params)).body.error?.code).toBe(-32014)
  })

  it.each(['current', 'legacy'] as const)(
    'preserves signing-key rotation grace across same-key refreshes from a %s hash',
    async (hashFormat) => {
      const f = await fixture()
      const subscribed = await f.mcp('events/subscribe', f.params)
      const id = subscribed.body.result!.id!
      const originalSecret = f.params.delivery.secret
      const replacementSecret = `whsec_${Buffer.alloc(32, 9).toString('base64')}`
      if (hashFormat === 'legacy') {
        const legacyHash = await sha256hex(originalSecret)
        await f.t.run(async (ctx) => {
          const row = (await ctx.db.query('webhook_subscriptions').first())!
          await ctx.db.patch(row._id, { secret_hash: legacyHash })
        })
      }
      const refreshParams = {
        ...f.params,
        delivery: { ...f.params.delivery, secret: replacementSecret },
      }
      vi.setSystemTime(Date.now() + 30_000)
      expect((await f.mcp('events/subscribe', refreshParams)).body.result?.id).toBe(id)
      const rotated = (await f.t.run((ctx) => ctx.db.query('webhook_subscriptions').first()))!
      expect(rotated.secret_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(decryptSecret(rotated.previous_secret!, id)).toBe(originalSecret)
      expect(rotated.rotation_until).toBe(Date.now() + 5 * 60_000)
      if (hashFormat === 'legacy') {
        const legacyHash = await sha256hex(replacementSecret)
        expect(legacyHash).not.toBe(rotated.secret_hash)
        await f.t.run((ctx) => ctx.db.patch(rotated._id, { secret_hash: legacyHash }))
      }

      vi.setSystemTime(Date.now() + 60_000)
      expect((await f.mcp('events/subscribe', refreshParams)).body.result?.id).toBe(id)
      const refreshed = (await f.t.run((ctx) => ctx.db.query('webhook_subscriptions').first()))!
      expect(refreshed.encrypted_secret).not.toBe(rotated.encrypted_secret)
      expect(refreshed).not.toHaveProperty('legacy_secret_hash')
      expect(refreshed).toMatchObject({
        secret_hash: rotated.secret_hash,
        previous_secret: rotated.previous_secret,
        rotation_until: rotated.rotation_until,
      })
      await f.update('During rotation grace')
      const during = (await f.t.run((ctx) => ctx.db.query('webhook_deliveries').first()))!
      await f.t.action(internal.webhookActions.deliver, { id: during.id })
      expect(receiver.keys.at(-1)).toEqual({
        secret: replacementSecret,
        previousSecret: originalSecret,
      })

      vi.setSystemTime(rotated.rotation_until! + 1)
      expect((await f.mcp('events/subscribe', refreshParams)).body.result?.id).toBe(id)
      await f.update('After rotation grace')
      const deliveries = await f.t.run((ctx) => ctx.db.query('webhook_deliveries').collect())
      const after = deliveries.find((row) => row.id !== during.id)!
      await f.t.action(internal.webhookActions.deliver, { id: after.id })
      expect(receiver.keys.at(-1)).toEqual({ secret: replacementSecret, previousSecret: undefined })
      expect(await f.t.run((ctx) => ctx.db.query('webhook_subscriptions').first())).toMatchObject({
        rotation_until: rotated.rotation_until,
      })
    },
  )

  it('exposes REST creation, secret-free listing and idempotent deletion', async () => {
    const f = await fixture()
    const created = await f.rest('/v1/webhooks', 'POST', f.params)
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    const listed = await f.rest('/v1/webhooks', 'GET')
    const text = await listed.text()
    expect(JSON.parse(text)).toHaveLength(1)
    expect(text).not.toContain('whsec_')
    expect((await f.rest(`/v1/webhooks/${id}`, 'DELETE')).status).toBe(204)
    expect((await f.rest(`/v1/webhooks/${id}`, 'DELETE')).status).toBe(204)
  })

  it('retains the subscription after a receiver rejects one event with 410', async () => {
    const f = await fixture()
    expect((await f.rest('/v1/webhooks', 'POST', f.params)).status).toBe(201)
    await f.update('Stale event')
    const rejected = await f.t.run((ctx) => ctx.db.query('webhook_deliveries').first())
    receiver.status = 410
    await f.t.action(internal.webhookActions.deliver, { id: rejected!.id })
    await f.t.action(internal.webhookActions.deliver, { id: rejected!.id })
    expect(receiver.payloads).toHaveLength(2)
    expect(await f.t.run((ctx) => ctx.db.get(rejected!._id))).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_status: 410,
    })
    expect(await (await f.rest('/v1/webhooks', 'GET')).json()).toMatchObject([{ status: 'active' }])

    await f.update('A later event')
    const deliveries = await f.t.run((ctx) => ctx.db.query('webhook_deliveries').collect())
    expect(deliveries).toHaveLength(2)
    const later = deliveries.find((row) => row.id !== rejected!.id)!
    receiver.status = 200
    await f.t.action(internal.webhookActions.deliver, { id: later.id })
    expect(await f.t.run((ctx) => ctx.db.get(later._id))).toMatchObject({ status: 'delivered' })
  })

  it('retries 425 with the same event once the receiver is ready', async () => {
    const f = await fixture()
    expect((await f.mcp('events/subscribe', f.params)).body.result?.id).toBeDefined()
    await f.update('Event before receiver routing is ready')
    const delivery = await f.t.run((ctx) => ctx.db.query('webhook_deliveries').first())
    receiver.status = 425
    await f.t.action(internal.webhookActions.deliver, { id: delivery!.id })
    expect(await f.t.run((ctx) => ctx.db.get(delivery!._id))).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_status: 425,
    })
    const firstPayload = receiver.payloads.at(-1)

    vi.setSystemTime(Date.now() + 10_001)
    receiver.status = 200
    await f.t.action(internal.webhookActions.deliver, { id: delivery!.id })
    expect(await f.t.run((ctx) => ctx.db.get(delivery!._id))).toMatchObject({
      status: 'delivered',
      attempts: 2,
      last_status: 200,
    })
    expect(receiver.payloads).toHaveLength(3)
    expect(receiver.payloads.at(-1)).toBe(firstPayload)
  })

  it('expires an omitted MCP TTL and keeps explicit no-expiry subscriptions active', async () => {
    const f = await fixture()
    const subscribed = await f.mcp('events/subscribe', f.params)
    const expiry = Date.now() + 7 * 24 * 60 * 60_000
    expect(subscribed.body.result?.refreshBefore).toBe(new Date(expiry).toISOString())
    expect(await f.t.run((ctx) => ctx.db.query('webhook_subscriptions').first())).toMatchObject({
      expires_at: expiry,
    })
    vi.setSystemTime(expiry)
    await f.update('After the default expiry')
    expect(await f.t.run((ctx) => ctx.db.query('webhook_deliveries').collect())).toEqual([])

    const indefinite = await f.mcp('events/subscribe', { ...f.params, ttlMs: null })
    expect(indefinite.body.result?.refreshBefore).toBeNull()
    vi.setSystemTime(expiry + 8 * 24 * 60 * 60_000)
    await f.update('An explicitly indefinite subscription stays active')
    const delivery = (await f.t.run((ctx) => ctx.db.query('webhook_deliveries').first()))!
    await f.t.action(internal.webhookActions.deliver, { id: delivery.id })
    expect(await f.t.run((ctx) => ctx.db.get(delivery._id))).toMatchObject({ status: 'delivered' })
  })

  it('honors optional expiry, disables failing REST callbacks and re-enables after verification', async () => {
    const f = await fixture()
    const finite = await f.mcp('events/subscribe', { ...f.params, ttlMs: 60_000 })
    expect(finite.body.result?.refreshBefore).toBe(new Date(Date.now() + 60_000).toISOString())
    const indefinite = await f.mcp('events/subscribe', { ...f.params, ttlMs: null })
    expect(indefinite.body.result?.refreshBefore).toBeNull()
    const personRow = await f.t.run((ctx) => ctx.db.query('webhook_subscriptions').first())
    expect(personRow).not.toHaveProperty('expires_at')
    const created = await f.rest('/v1/webhooks', 'POST', f.params)
    const { id, refreshBefore } = (await created.json()) as {
      id: string
      refreshBefore: string | null
    }
    expect(refreshBefore).toBeNull()
    receiver.status = 503
    for (let n = 0; n < 2; n++) {
      if (n) vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000)
      await f.t.run(async (ctx) => {
        const before = (await ctx.db.get(f.issue._id))!
        await ctx.db.patch(f.issue._id, { title: `Failed callback ${n}` })
        const after = (await ctx.db.get(f.issue._id))!
        await notifyIssueUpdate(ctx, {
          before,
          after,
          actor: f.fx.user,
          now: new Date().toISOString(),
        })
      })
      await flushWebhookEvents(f.t)
      const deliveries = await f.t.run((ctx) => ctx.db.query('webhook_deliveries').collect())
      const delivery = deliveries.filter((row) => row.subscription_id === id).at(-1)!
      await f.t.action(internal.webhookActions.deliver, { id: delivery.id })
    }
    expect(await (await f.rest('/v1/webhooks', 'GET')).json()).toMatchObject([
      { id, status: 'disabled', disabled_reason: 'delivery_failures', last_status: 503 },
    ])
    receiver.status = 200
    receiver.valid = false
    expect((await f.rest('/v1/webhooks', 'POST', f.params)).status).toBe(400)
    expect(await (await f.rest('/v1/webhooks', 'GET')).json()).toMatchObject([
      { status: 'disabled' },
    ])
    receiver.valid = true
    expect((await f.rest('/v1/webhooks', 'POST', f.params)).status).toBe(201)
    expect(await (await f.rest('/v1/webhooks', 'GET')).json()).toMatchObject([
      { id, status: 'active', disabled_reason: null, failed_since: null },
    ])
  })

  it('clamps finite TTLs and reapplies the MCP default on renewal', async () => {
    const f = await fixture()
    const minute = await f.mcp('events/subscribe', { ...f.params, ttlMs: 1 })
    expect(minute.body.result?.refreshBefore).toBe(new Date(Date.now() + 60_000).toISOString())
    const week = await f.mcp('events/subscribe', { ...f.params, ttlMs: 30 * 24 * 60 * 60_000 })
    expect(week.body.result?.refreshBefore).toBe(
      new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
    )
    expect(
      (await f.mcp('events/subscribe', { ...f.params, ttlMs: null })).body.result?.refreshBefore,
    ).toBeNull()
    vi.setSystemTime(Date.now() + 30_000)
    const renewed = await f.mcp('events/subscribe', f.params)
    expect(renewed.body.result?.id).toBe(minute.body.result?.id)
    expect(renewed.body.result?.refreshBefore).toBe(
      new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
    )
  })

  it('returns draft event errors for unavailable names, filters and subscription quota', async () => {
    const f = await fixture()
    expect(
      (await f.mcp('events/subscribe', { ...f.params, name: 'task.unknown' })).body.error,
    ).toMatchObject({ code: -32011, data: { kind: 'event' } })
    expect(
      (
        await f.mcp('events/subscribe', {
          ...f.params,
          arguments: { project_id: f.fx.otherProject.id },
        })
      ).body.error?.code,
    ).toBe(-32011)
    for (let n = 0; n < 20; n++) {
      const response = await f.mcp('events/subscribe', {
        ...f.params,
        delivery: { ...f.params.delivery, url: `https://receiver.example/${n}` },
      })
      expect(response.body.error).toBeUndefined()
    }
    const full = await f.mcp('events/subscribe', f.params)
    expect(full.body.error).toMatchObject({ code: -32013, data: { limit: 'subscriptions' } })
  })

  it('categorizes callback failures without exposing receiver details', async () => {
    const f = await fixture()
    for (const [status, reason] of [
      [403, 'http_4xx'],
      [503, 'http_5xx'],
    ] as const) {
      receiver.status = status
      expect((await f.mcp('events/subscribe', f.params)).body.error).toMatchObject({
        code: -32015,
        data: { reason },
      })
    }
    receiver.status = 200
    receiver.valid = false
    expect((await f.mcp('events/subscribe', f.params)).body.error?.data?.reason).toBe(
      'challenge_failed',
    )
    receiver.error = new CallbackError('timeout', 'private receiver diagnostic')
    const timedOut = await f.mcp('events/subscribe', f.params)
    expect(timedOut.body.error).toMatchObject({ code: -32015, data: { reason: 'timeout' } })
    expect(JSON.stringify(timedOut.body)).not.toContain('private receiver diagnostic')
    expect(await f.t.run((ctx) => ctx.db.query('webhook_subscriptions').collect())).toEqual([])
  })

  it('lets personal credentials inspect and remove only their own subscriptions', async () => {
    const f = await fixture()
    const registered = await f.mcp('events/subscribe', f.params)
    const id = registered.body.result!.id!
    await f.t.run(async (ctx) => {
      const row = (await ctx.db.query('webhook_subscriptions').first())!
      await ctx.db.patch(row._id, {
        disabled_at: Date.now(),
        disabled_reason: 'delivery_failures',
      })
      await ctx.db.insert('webhook_health', {
        subscription_row_id: row._id,
        org_id: row.org_id,
        failed_since: Date.now(),
        last_status: 503,
      })
    })
    const listed = await f.rest('/v1/webhooks', 'GET', undefined, f.qvt)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject([{ id, status: 'disabled', last_status: 503 }])
    expect(await (await f.rest('/v1/webhooks', 'GET')).json()).toEqual([])
    expect((await f.rest(`/v1/webhooks/${id}`, 'DELETE')).status).toBe(404)
    expect((await f.rest('/v1/projects', 'GET', undefined, f.qvt)).status).toBe(401)
    expect((await f.rest(`/v1/webhooks/${id}`, 'DELETE', undefined, f.qvt)).status).toBe(204)
    expect(await (await f.rest('/v1/webhooks', 'GET', undefined, f.qvt)).json()).toEqual([])
    expect(await f.t.run((ctx) => ctx.db.query('webhook_health').collect())).toEqual([])
  })

  it('lists legacy health and keeps a recovered streak clear after migration', async () => {
    const f = await fixture()
    const registered = await f.mcp('events/subscribe', { ...f.params, ttlMs: null })
    const id = registered.body.result!.id!
    const failedSince = Date.now() - 7 * 24 * 60 * 60_000
    const lastFailure = Date.now() - 60_000
    const lastSuccess = failedSince - 60_000
    const subscription = await f.t.run(async (ctx) => {
      const row = (await ctx.db.query('webhook_subscriptions').first())!
      for (const health of await ctx.db.query('webhook_health').collect())
        await ctx.db.delete(health._id)
      await ctx.db.patch(row._id, {
        disabled_at: Date.now(),
        disabled_reason: 'delivery_failures',
        failed_since: failedSince,
        last_failure_at: lastFailure,
        last_success_at: lastSuccess,
        last_status: 503,
      })
      await ctx.db.patch(f.fx.user._id, { org_role: 'admin' })
      return row
    })
    const legacyHealth = {
      id,
      status: 'disabled',
      failed_since: new Date(failedSince).toISOString(),
      last_failure_at: new Date(lastFailure).toISOString(),
      last_success_at: new Date(lastSuccess).toISOString(),
      last_status: 503,
    }
    for (const path of ['/v1/webhooks', '/v1/webhooks/organization'])
      expect(await (await f.rest(path, 'GET', undefined, f.qvt)).json()).toMatchObject([
        legacyHealth,
      ])

    expect((await f.mcp('events/subscribe', { ...f.params, ttlMs: null })).body.result?.id).toBe(id)
    const health = await f.t.run((ctx) =>
      ctx.db
        .query('webhook_health')
        .withIndex('by_subscription', (q) => q.eq('subscription_row_id', subscription._id))
        .unique(),
    )
    expect(health).toMatchObject({
      last_failure_at: lastFailure,
      last_success_at: lastSuccess,
      last_status: 503,
    })
    expect(health).not.toHaveProperty('failed_since')
    for (const path of ['/v1/webhooks', '/v1/webhooks/organization'])
      expect(await (await f.rest(path, 'GET', undefined, f.qvt)).json()).toMatchObject([
        {
          ...legacyHealth,
          status: 'active',
          disabled_at: null,
          disabled_reason: null,
          failed_since: null,
        },
      ])
  })

  it('binds OAuth delivery to the approved grant while management needs a valid access token', async () => {
    const f = await fixture()
    const oauth = await f.oauth()
    const registered = await f.mcp('events/subscribe', { ...f.params, ttlMs: null }, oauth.token)
    expect(registered.body.error).toBeUndefined()
    const id = registered.body.result!.id!
    const listed = await f.rest('/v1/webhooks', 'GET', undefined, oauth.token)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject([{ id, status: 'active' }])
    expect((await f.rest('/v1/projects', 'GET', undefined, oauth.token)).status).toBe(401)
    vi.setSystemTime(Date.now() + 60_001)
    expect((await f.rest('/v1/webhooks', 'GET', undefined, oauth.token)).status).toBe(401)
    await f.update('Token expiry does not cancel the approved grant')
    const delivery = (await f.t.run((ctx) => ctx.db.query('webhook_deliveries').first()))!
    await f.t.action(internal.webhookActions.deliver, { id: delivery.id })
    expect(await f.t.run((ctx) => ctx.db.get(delivery._id))).toMatchObject({ status: 'delivered' })
    await f.t.run((ctx) =>
      ctx.db.patch(oauth.connectionRowId, { revoked_at: new Date().toISOString() }),
    )
    await f.update('Disconnected grants do not deliver')
    expect(await f.t.run((ctx) => ctx.db.query('webhook_deliveries').collect())).toHaveLength(1)
  })

  it('returns a JSON-RPC refusal when OAuth is revoked after the initial request authentication', async () => {
    const f = await fixture()
    const oauth = await f.oauth()
    const readText = Request.prototype.text
    vi.spyOn(Request.prototype, 'text').mockImplementationOnce(async function (this: Request) {
      await f.t.run((ctx) =>
        ctx.db.patch(oauth.connectionRowId, { revoked_at: new Date().toISOString() }),
      )
      return readText.call(this)
    })
    const response = await f.mcp('events/list', {}, oauth.token)
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32012 } })
  })

  it('permits organization inspection and reclaim only for person administrators', async () => {
    const f = await fixture()
    const created = await f.rest('/v1/webhooks', 'POST', f.params)
    const { id } = (await created.json()) as { id: string }
    expect((await f.rest('/v1/webhooks/organization', 'GET', undefined, f.qvt)).status).toBe(403)
    expect((await f.rest('/v1/webhooks/organization', 'GET')).status).toBe(403)
    await f.t.run((ctx) => ctx.db.patch(f.fx.user._id, { org_role: 'admin' }))
    const listed = await f.rest('/v1/webhooks/organization', 'GET', undefined, f.qvt)
    expect(listed.status).toBe(200)
    const text = await listed.text()
    expect(JSON.parse(text)).toMatchObject([{ id }])
    expect(text).not.toContain('whsec_')
    const oauth = await f.oauth()
    expect((await f.rest('/v1/webhooks/organization', 'GET', undefined, oauth.token)).status).toBe(
      200,
    )
    expect(
      (await f.rest(`/v1/webhooks/organization/${id}`, 'DELETE', undefined, oauth.token)).status,
    ).toBe(403)
    expect(
      (await f.rest(`/v1/webhooks/organization/${id}`, 'DELETE', undefined, f.qvt)).status,
    ).toBe(204)
    expect(await (await f.rest('/v1/webhooks', 'GET')).json()).toEqual([])
  })

  it.each([301, 400, 401, 403, 404, 413])(
    'stops permanent HTTP %i errors after one event attempt',
    async (status) => {
      const f = await fixture()
      expect((await f.rest('/v1/webhooks', 'POST', f.params)).status).toBe(201)
      await f.update('Permanent receiver failure')
      const delivery = (await f.t.run((ctx) => ctx.db.query('webhook_deliveries').first()))!
      receiver.status = status
      await f.t.action(internal.webhookActions.deliver, { id: delivery.id })
      vi.setSystemTime(Date.now() + 60_000)
      await f.t.action(internal.webhookActions.deliver, { id: delivery.id })
      expect(await f.t.run((ctx) => ctx.db.get(delivery._id))).toMatchObject({
        status: 'failed',
        attempts: 1,
        last_status: status,
      })
      expect(receiver.payloads).toHaveLength(2)
    },
  )
})

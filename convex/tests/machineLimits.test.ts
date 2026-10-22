/* The limits REST and MCP share (lib/limits.ts), answered alike on both
 * surfaces. A title padded with spaces within the cap is stored trimmed and
 * a longer one is refused with the registry's sentence. A page size, a
 * search or a webhook lifetime outside its range is refused, never changed.
 * A full webhook quota is a 409 on REST. Requests go through the real routes
 * with the fixture agent's key. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { byId } from '../lib/db'
import { DEFAULT_PAGE_SIZE, LIMITS } from '../lib/limits'
import type { EventOwner } from '../lib/taskEvents'
import { sha256hex } from '../machine/auth'
import { NOW, newT, type OrgFixture, plantIssue, type T, uuid, withOrg } from './helpers.setup'

/* The callback verification answers the challenge it was sent, so a
 * subscription reaches the quota check without a network. */
vi.mock('../lib/webhookTransport', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/webhookTransport')>()
  return {
    ...real,
    postWebhook: async (
      _url: string,
      _secret: string,
      _id: string,
      _sub: string,
      body: string,
    ) => ({
      status: 200,
      body: JSON.stringify({ challenge: (JSON.parse(body) as { challenge?: string }).challenge }),
    }),
  }
})

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_SECRET', 'machine-limits-test-secret-not-a-deployment-key')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const SECRET = `qva_${'limits00'.repeat(6)}`
/* A Standard Webhooks signing secret of 32 bytes. */
const SIGNING = `whsec_${btoa('k'.repeat(32))}`

type Fx = OrgFixture & { t: T; owner: EventOwner }

/* withOrg, with the agent Relay holding User on TBED and a key, which owns
 * the webhook subscriptions it makes. */
async function setup(): Promise<Fx> {
  const t = newT()
  const f = await withOrg(t)
  const key_hash = await sha256hex(SECRET)
  const keyId = uuid()
  const row = await t.run(async (ctx): Promise<Id<'agent_keys'>> => {
    await ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    })
    return await ctx.db.insert('agent_keys', {
      id: keyId,
      profile_id: f.agent.id,
      name: 'limits',
      key_prefix: SECRET.slice(0, 11),
      key_hash,
      created_at: NOW,
    })
  })
  const owner: EventOwner = {
    profile_id: f.agent.id,
    credential_table: 'agent_keys',
    credential_id: keyId,
    credential_row_id: row,
  }
  return { t, ...f, owner }
}

type Wire = { status: number; json: unknown }

/* One REST request with the agent's key, plus `headers`. */
async function rest(
  fx: Fx,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Wire> {
  const http = fx.t as unknown as {
    fetch(
      path: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ): Promise<{ status: number; text(): Promise<string> }>
  }
  const res = await http.fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text === '' ? null : JSON.parse(text) }
}

/* One MCP request on the modern leg, answered as its whole JSON-RPC body.
 * `name` is the tool a tools/call names. */
async function rpc(fx: Fx, method: string, params: Record<string, unknown>, name?: string) {
  const { status, json } = await rest(
    fx,
    'POST',
    '/mcp',
    {
      jsonrpc: '2.0',
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'limits', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
      id: 1,
    },
    {
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...(name === undefined ? {} : { 'Mcp-Name': name }),
    },
  )
  expect(status).toBe(200)
  return json as {
    result?: { content?: { text: string }[]; isError?: true; refreshBefore?: string | null }
    error?: { code: number; message: string }
  }
}

/* One tool call's result: its text and whether it was refused. */
async function tool(fx: Fx, name: string, args: Record<string, unknown>) {
  const { result } = await rpc(fx, 'tools/call', { name, arguments: args }, name)
  return { text: result?.content?.[0]?.text ?? '', refused: result?.isError === true }
}

const refusedWith = (sentence: string) => ({ text: sentence, refused: true })
const restRefusal = (sentence: string, status = 400) => ({ status, json: { error: sentence } })

describe('task titles', () => {
  it('stores a padded title within the cap trimmed and refuses a longer one alike', async () => {
    const fx = await setup()
    const atCap = 'x'.repeat(LIMITS.title.max)
    const viaRest = await rest(fx, 'POST', '/v1/tasks', { project: 'FW', title: `  ${atCap}  ` })
    expect(viaRest.status).toBe(201)
    expect((viaRest.json as { title: string }).title).toBe(atCap)
    const viaMcp = await tool(fx, 'create_task', { project: 'FW', title: `  ${atCap}  ` })
    expect(viaMcp.refused).toBe(false)
    const created = await fx.t.run((ctx) =>
      byId(ctx, 'issues', (JSON.parse(viaMcp.text) as { id: string }).id),
    )
    expect(created?.title).toBe(atCap)

    const over = `${atCap}y`
    expect(await rest(fx, 'POST', '/v1/tasks', { project: 'FW', title: over })).toEqual(
      restRefusal(LIMITS.title.refusal),
    )
    expect(await tool(fx, 'create_task', { project: 'FW', title: over })).toEqual(
      refusedWith(LIMITS.title.refusal),
    )
    const key = (viaRest.json as { key: string }).key
    expect(await rest(fx, 'PATCH', `/v1/tasks/${key}`, { title: over })).toEqual(
      restRefusal(LIMITS.title.refusal),
    )
    expect(await tool(fx, 'update_task', { ref: key, title: over })).toEqual(
      refusedWith(LIMITS.title.refusal),
    )
  })
})

describe('task lists', () => {
  it('answers DEFAULT_PAGE_SIZE tasks without a limit and refuses one out of range', async () => {
    const fx = await setup()
    for (let n = 0; n <= DEFAULT_PAGE_SIZE; n++) {
      await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    }
    const page = await rest(fx, 'GET', '/v1/tasks?project=FW')
    expect(page.status).toBe(200)
    expect(page.json).toHaveLength(DEFAULT_PAGE_SIZE)
    const listed = await tool(fx, 'list_tasks', { project: 'FW' })
    expect(JSON.parse(listed.text)).toHaveLength(DEFAULT_PAGE_SIZE)
    // the most a page holds
    const most = await rest(fx, 'GET', `/v1/tasks?project=FW&limit=${LIMITS.listTasks.max}`)
    expect(most.json).toHaveLength(DEFAULT_PAGE_SIZE + 1)

    for (const limit of ['500', '0', 'abc', '-5', '1.5', '']) {
      expect(await rest(fx, 'GET', `/v1/tasks?project=FW&limit=${limit}`), limit).toEqual(
        restRefusal(LIMITS.listTasks.refusal),
      )
    }
    for (const limit of [0, LIMITS.listTasks.max + 1]) {
      expect(await tool(fx, 'list_tasks', { project: 'FW', limit }), String(limit)).toEqual(
        refusedWith(LIMITS.listTasks.refusal),
      )
    }
    // a negative offset is refused, not read as 0
    expect((await rest(fx, 'GET', '/v1/tasks?project=FW&offset=-1')).status).toBe(400)
    expect((await tool(fx, 'list_tasks', { project: 'FW', offset: -1 })).refused).toBe(true)
  })

  it('refuses a search over its cap on active and archived lists alike', async () => {
    const fx = await setup()
    const over = 'x'.repeat(LIMITS.search.max + 1)
    const most = 'x'.repeat(LIMITS.search.max)
    for (const archived of [false, true]) {
      const flag = archived ? '&archived=true' : ''
      expect(await rest(fx, 'GET', `/v1/tasks?project=FW${flag}&search=${over}`)).toEqual(
        restRefusal(LIMITS.search.refusal),
      )
      expect(await tool(fx, 'list_tasks', { project: 'FW', archived, search: over })).toEqual(
        refusedWith(LIMITS.search.refusal),
      )
      expect((await rest(fx, 'GET', `/v1/tasks?project=FW${flag}&search=${most}`)).status).toBe(200)
      expect(
        (await tool(fx, 'list_tasks', { project: 'FW', archived, search: most })).refused,
      ).toBe(false)
    }
  })

  it('refuses a comment page size out of range on both surfaces', async () => {
    const fx = await setup()
    const task = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const ref = `QN-${task.num}`
    for (const limit of [0, LIMITS.listComments.max + 1]) {
      expect(await rest(fx, 'GET', `/v1/tasks/${ref}/comments?limit=${limit}`)).toEqual(
        restRefusal(LIMITS.listComments.refusal),
      )
      expect(await tool(fx, 'list_comments', { ref, limit })).toEqual(
        refusedWith(LIMITS.listComments.refusal),
      )
    }
  })
})

describe('webhook subscriptions', () => {
  const subscription = (url: string, ttlMs?: number | null) => ({
    name: 'task.updated',
    delivery: { mode: 'webhook', url, secret: SIGNING },
    ...(ttlMs === undefined ? {} : { ttlMs }),
  })

  it('refuses a lifetime outside 1 minute to 7 days instead of moving it into range', async () => {
    const fx = await setup()
    const { min, max } = LIMITS.webhookTtl
    for (const ttlMs of [min - 1, max + 1, 0, 90_000.5]) {
      const body = subscription('https://receiver.example/qivo', ttlMs)
      expect(await rest(fx, 'POST', '/v1/webhooks', body), String(ttlMs)).toEqual(
        restRefusal(LIMITS.webhookTtl.refusal),
      )
      expect((await rpc(fx, 'events/subscribe', body)).error).toEqual({
        code: -32602,
        message: LIMITS.webhookTtl.refusal,
      })
    }
    // the ends of the range are taken; REST without ttlMs never expires and
    // MCP without it gets seven days
    const atMin = await rest(fx, 'POST', '/v1/webhooks', subscription('https://a.example/q', min))
    expect(atMin.status).toBe(201)
    const atMax = await rpc(fx, 'events/subscribe', subscription('https://b.example/q', max))
    expect(atMax.result?.refreshBefore).toEqual(expect.any(String))
    const forever = await rest(fx, 'POST', '/v1/webhooks', subscription('https://c.example/q'))
    expect((forever.json as { refreshBefore: string | null }).refreshBefore).toBeNull()
    const week = await rpc(fx, 'events/subscribe', subscription('https://d.example/q'))
    expect(week.result?.refreshBefore).toEqual(expect.any(String))
  })

  it('counts a callback URL in the form it stores, so a stored URL never passes the limit', async () => {
    const fx = await setup()
    const max = LIMITS.webhookUrl.max
    const base = 'https://receiver.example/'
    // each é is one character typed and six once percent-encoded
    const encoded = `${base}${'é'.repeat(10)}${'q'.repeat(max - base.length - 10)}`
    expect(encoded).toHaveLength(max)
    expect(new URL(encoded).toString()).toHaveLength(max + 50)
    expect(await rest(fx, 'POST', '/v1/webhooks', subscription(encoded))).toEqual(
      restRefusal(LIMITS.webhookUrl.refusal),
    )
    const plain = await rest(
      fx,
      'POST',
      '/v1/webhooks',
      subscription(`${base}${'q'.repeat(max - base.length)}`),
    )
    expect(plain.status).toBe(201)
  })

  it('answers a full quota 409 on REST and -32013 on MCP, with the registry sentence', async () => {
    const fx = await setup()
    for (let n = 0; n < LIMITS.webhooksPerKey.max; n++) {
      await fx.t.mutation(internal.webhooks.save, {
        owner: fx.owner,
        id: uuid(),
        name: 'task.updated',
        filters: {},
        url: `https://receiver.example/held/${n}`,
        encrypted_secret: 'encrypted-test-key',
      })
    }
    const body = subscription('https://receiver.example/one-more')
    expect(await rest(fx, 'POST', '/v1/webhooks', body)).toEqual(
      restRefusal(LIMITS.webhooksPerKey.refusal, 409),
    )
    expect((await rpc(fx, 'events/subscribe', body)).error).toEqual({
      code: -32013,
      message: LIMITS.webhooksPerKey.refusal,
      data: { limit: 'subscriptions' },
    })
  })
})

/* The 1 MiB cap on REST and MCP request bodies (machine/shared.ts readBody).
 * A body over the cap answers 413 after authentication, before any routing or
 * work, so the call is still counted and an unauthenticated caller only ever
 * sees its 401. Every answer goes out only after the body has arrived
 * (machine/shared.ts answerAfterBody), so an early one is never lost to a
 * reset connection. */

import { describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import { LIMITS } from '../lib/limits'
import { sha256hex } from '../machine/auth'
import { BODY_MAX_BYTES, DISCARD_MAX_BYTES, discardBody } from '../machine/shared'
import { NOW, newT, type OrgFixture, type T, uuid, withOrg } from './helpers.setup'

const SECRET = `qva_${'3'.repeat(48)}`
const TOO_LARGE_REST = { error: LIMITS.requestBody.refusal }
const TOO_LARGE_MCP = {
  jsonrpc: '2.0',
  error: { code: -32600, message: `Bad Request: ${LIMITS.requestBody.refusal}` },
  id: null,
}

type HttpInit = {
  method: string
  headers: Record<string, string>
  body?: string | ReadableStream<Uint8Array>
  duplex?: 'half'
}
const http = (t: T, path: string, init: HttpInit): Promise<Response> =>
  (t as unknown as { fetch(path: string, init: HttpInit): Promise<Response> }).fetch(path, init)

/* withOrg, with the fixture agent holding User on the TBED meta and a key. */
async function wireOrg(t: T): Promise<OrgFixture> {
  const f = await withOrg(t)
  const key_hash = await sha256hex(SECRET)
  await t.run(async (ctx) => {
    await ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    })
    await ctx.db.insert('agent_keys', {
      id: uuid(),
      profile_id: f.agent.id,
      name: 'limits',
      key_prefix: 'qva_333...33333',
      key_hash,
      created_at: NOW,
    })
  })
  return f
}

/* `value` as JSON padded with spaces to exactly `bytes` UTF-8 bytes. */
function jsonOfSize(value: unknown, bytes: number): string {
  const text = JSON.stringify(value)
  const size = new TextEncoder().encode(text).byteLength
  if (size > bytes) throw new Error('value is larger than the requested size')
  return text + ' '.repeat(bytes - size)
}

const post = (t: T, path: string, body: string, secret: string | null = SECRET) =>
  http(t, path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(secret === null ? {} : { Authorization: `Bearer ${secret}` }),
    },
    body,
  })

const keyRow = (t: T): Promise<Doc<'agent_keys'>> =>
  t.run(async (ctx) => (await ctx.db.query('agent_keys').collect())[0])
const issueCount = (t: T) => t.run(async (ctx) => (await ctx.db.query('issues').collect()).length)

describe('REST', () => {
  it('reads a body of exactly 1 MiB and answers 413 for one byte more, after counting the call', async () => {
    const t = newT()
    const f = await wireOrg(t)
    // a multi-byte character, so the cap counts bytes, not characters
    const task = { project: f.sub.key, title: 'Größe' }
    const atCap = await post(t, '/v1/tasks', jsonOfSize(task, BODY_MAX_BYTES))
    expect(atCap.status).toBe(201)
    expect(await issueCount(t)).toBe(1)

    await t.run(async (ctx) => {
      const key = (await ctx.db.query('agent_keys').collect())[0]
      await ctx.db.patch(key._id, { last_used_at: undefined })
    })
    const over = await post(t, '/v1/tasks', jsonOfSize(task, BODY_MAX_BYTES + 1))
    expect(over.status).toBe(413)
    expect(JSON.parse(await over.text())).toEqual(TOO_LARGE_REST)
    expect(await issueCount(t)).toBe(1)
    expect((await keyRow(t)).last_used_at).toBeDefined()
  })

  it('answers 401, not 413, to an unauthenticated oversized body', async () => {
    const t = newT()
    const f = await wireOrg(t)
    const body = jsonOfSize({ project: f.sub.key, title: 'x' }, BODY_MAX_BYTES + 1)
    expect((await post(t, '/v1/tasks', body, null)).status).toBe(401)
    expect((await post(t, '/v1/tasks', body, `qva_${'4'.repeat(48)}`)).status).toBe(401)
  })

  it('trusts a declared Content-Length over the cap, so a small body still answers 413', async () => {
    const t = newT()
    const f = await wireOrg(t)
    // read in full, this body would create a task
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ project: f.sub.key, title: 'x' })),
        )
        controller.close()
      },
    })
    const response = await http(t, '/v1/tasks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SECRET}`,
        'Content-Type': 'application/json',
        'Content-Length': String(BODY_MAX_BYTES + 1),
      },
      body,
      duplex: 'half',
    })
    expect(response.status).toBe(413)
    expect(await issueCount(t)).toBe(0)
  })

  it('measures a chunked body sent without Content-Length', async () => {
    const t = newT()
    await wireOrg(t)
    const chunked = (bytes: number) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          const task = new TextEncoder().encode(jsonOfSize({ project: 'FW', title: 'x' }, bytes))
          controller.enqueue(task.slice(0, 1000))
          controller.enqueue(task.slice(1000))
          controller.close()
        },
      })
    const send = (bytes: number) =>
      http(t, '/v1/tasks', {
        method: 'POST',
        headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
        body: chunked(bytes),
        duplex: 'half',
      })
    expect((await send(BODY_MAX_BYTES + 1)).status).toBe(413)
    expect(await issueCount(t)).toBe(0)
    expect((await send(BODY_MAX_BYTES)).status).toBe(201)
  })

  it('stops keeping an endless chunked body once it passes the cap, and answers after a bounded read', async () => {
    const t = newT()
    await wireOrg(t)
    let pulls = 0
    // 64 KiB of spaces per read, forever, so a reader that waits for the end
    // never answers
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(64 * 1024).fill(32))
      },
    })
    const response = await http(t, '/v1/tasks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: endless,
      duplex: 'half',
    })
    expect(response.status).toBe(413)
    // 17 reads pass the cap, then discardBody reads past DISCARD_MAX_BYTES,
    // plus what the stream queued ahead
    expect(pulls).toBeGreaterThan(DISCARD_MAX_BYTES / (64 * 1024))
    expect(pulls).toBeLessThan((BODY_MAX_BYTES + DISCARD_MAX_BYTES) / (64 * 1024) + 5)
  })

  it('counts the bytes of a byte-order mark, which the decoded text drops', async () => {
    const t = newT()
    const f = await wireOrg(t)
    const task = { project: f.sub.key, title: 'x' }
    // U+FEFF is 3 bytes of UTF-8
    const over = await post(t, '/v1/tasks', `\uFEFF${jsonOfSize(task, BODY_MAX_BYTES)}`)
    expect(over.status).toBe(413)
    expect(await issueCount(t)).toBe(0)
    const atCap = await post(t, '/v1/tasks', `\uFEFF${jsonOfSize(task, BODY_MAX_BYTES - 3)}`)
    expect(atCap.status).toBe(201)
  })

  it('caps webhook subscription bodies too', async () => {
    const t = newT()
    await wireOrg(t)
    const over = await post(
      t,
      '/v1/webhooks',
      jsonOfSize({ name: 'task.updated' }, BODY_MAX_BYTES + 1),
    )
    expect(over.status).toBe(413)
    expect(JSON.parse(await over.text())).toEqual(TOO_LARGE_REST)
    expect(await t.run((ctx) => ctx.db.query('webhook_subscriptions').collect())).toEqual([])
  })
})

describe('MCP', () => {
  const call = (id: number) => ({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'create_task',
      arguments: { project: 'FW', title: 'Größe' },
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'limits', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
    id,
  })
  const mcp = (t: T, body: string) =>
    http(t, '/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SECRET}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'create_task',
      },
      body,
    })

  it('reads a body of exactly 1 MiB and answers 413 in JSON-RPC form for one byte more', async () => {
    const t = newT()
    await wireOrg(t)
    const atCap = await mcp(t, jsonOfSize(call(1), BODY_MAX_BYTES))
    expect(atCap.status).toBe(200)
    expect(await issueCount(t)).toBe(1)
    const over = await mcp(t, jsonOfSize(call(2), BODY_MAX_BYTES + 1))
    expect(over.status).toBe(413)
    expect(JSON.parse(await over.text())).toEqual(TOO_LARGE_MCP)
    expect(await issueCount(t)).toBe(1)
  })

  it('answers 401, not 413, to an unauthenticated oversized body', async () => {
    const t = newT()
    await wireOrg(t)
    const response = await post(t, '/mcp', jsonOfSize(call(1), BODY_MAX_BYTES + 1), null)
    expect(response.status).toBe(401)
  })
})

/* A body the test sends in two parts: the first at once, the rest when it
 * calls `finish`. `read` says whether the handler took the last part. */
function heldBody() {
  let finish = () => {}
  let read = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024).fill(32))
      finish = () => {
        controller.enqueue(new Uint8Array(BODY_MAX_BYTES).fill(32))
        controller.close()
      }
    },
    pull() {
      read = true
    },
  })
  return { body, finish: () => finish(), wasRead: () => read }
}

describe('early answers', () => {
  const rest = `Bearer ${SECRET}`
  // answers a REST, MCP, upload or curation request can get before its body
  // is read: a missing credential, a declared size over the cap, a verb MCP
  // does not take and an unknown upload URL
  it.each([
    ['REST 401', 'POST', '/v1/tasks', {}, 401],
    ['REST 413', 'POST', '/v1/tasks', { 'Content-Length': String(BODY_MAX_BYTES + 1) }, 413],
    ['webhook 401', 'POST', '/v1/webhooks', {}, 401],
    ['MCP 401', 'POST', '/mcp', {}, 401],
    ['MCP 413', 'POST', '/mcp', { 'Content-Length': String(BODY_MAX_BYTES + 1) }, 413],
    ['MCP 405', 'DELETE', '/mcp', {}, 405],
    ['upload 404', 'POST', '/attachment-uploads/missing?e=1&m=x&t=y', {}, 404],
    ['curation 401', 'POST', '/v1/curation/images', {}, 401],
  ] as const)('%s waits for the whole body', async (_name, method, path, headers, status) => {
    const t = newT()
    await wireOrg(t)
    const held = heldBody()
    let answered = false
    const response = http(t, path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(status === 401 ? {} : { Authorization: rest }),
        ...headers,
      },
      body: held.body,
      duplex: 'half',
    }).then((answer) => {
      answered = true
      return answer
    })
    // long enough for every handler to decide its answer
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(answered).toBe(false)
    held.finish()
    expect((await response).status).toBe(status)
    expect(held.wasRead()).toBe(true)
  })
})

describe('discardBody', () => {
  // discardBody reads only the request's body stream and Content-Length
  const requestOf = (body: ReadableStream<Uint8Array>, length: number | null = null) =>
    ({
      body,
      headers: { get: (name: string) => (name === 'Content-Length' ? length : null) },
    }) as unknown as Request

  it('gives up on a body that stops arriving and cancels it', async () => {
    let cancelled = false
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10))
      },
      cancel() {
        cancelled = true
      },
    })
    const started = Date.now()
    await discardBody(requestOf(stalled), 50)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(cancelled).toBe(true)
  })

  it('cancels at once a body declared longer than it would read', async () => {
    let pulls = 0
    let cancelled = false
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(64 * 1024))
      },
      cancel() {
        cancelled = true
      },
    })
    await discardBody(requestOf(endless, DISCARD_MAX_BYTES + 1), 60_000)
    expect(cancelled).toBe(true)
    // the stream fills its queue once before anyone reads
    expect(pulls).toBeLessThan(3)
  })

  it('leaves a body that a reader still holds alone', async () => {
    const held = new ReadableStream<Uint8Array>()
    held.getReader()
    // without the check, getReader would throw on the locked stream
    await expect(discardBody(requestOf(held), 50)).resolves.toBeUndefined()
  })
})

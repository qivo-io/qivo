/* LIVE contract pass — the /mcp surface over the real wire, replaying its
 * byte-stable subset against the Convex deployment. Expected bytes are shared
 * with convex/tests/mcp.test.ts. Data-dependent exchanges (16
 * list_teams rows, 24 list_projects rows, last_used_at read-backs) are
 * deliberately skipped; gateway/infra headers are never pinned — only
 * content-type, allow, www-authenticate and the CORS surface.
 *
 * STATE HYGIENE (read before running):
 *   - The target is the SHARED cloud dev deployment from .env.local
 *     (override with CONTRACT_BASE_URL). globalSetup RESETS the Northstar Labs
 *     development copy, so a run loses manual work there by design — never overlap
 *     with `npm run dev` work or a smoke run.
 *   - This suite creates only rows it deletes (the modern-leg write trip,
 *     with an afterAll backstop) — plus ONE deliberate server-state change:
 *     the FINALE deletes the minted qvt token to capture exchange 44's
 *     revoked-token 401 live. Every test needing the qvt runs before it, and
 *     the globalSetup teardown tolerates the already-deleted row.
 *   - It runs serially (fileParallelism: false) and only via
 *     `npm run test:contract` — plain `npm test` excludes it. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { SHA_TOOLS_LEGACY, SHA_TOOLS_MODERN } from './pins.mts'

type Stash = {
  siteUrl: string
  orgId: string
  qva: string
  qvt: string
  qvaId: string
  qvtId: string
}
const stash: Stash = JSON.parse(
  readFileSync(new URL('./.credentials.json', import.meta.url), 'utf8'),
)
const BASE = process.env.CONTRACT_BASE_URL ?? stash.siteUrl
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

const BOTH_ACCEPT = 'application/json, text/event-stream'

/* POST /mcp with the capture's default header set; pass extra headers to
 * override or (Accept: undefined is not expressible — use rawPost) extend. */
function post(
  secret: string | null,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: BOTH_ACCEPT,
    ...headers,
  }
  if (secret !== null && h.Authorization === undefined) h.Authorization = `Bearer ${secret}`
  return fetch(`${BASE}/mcp`, { method: 'POST', headers: h, body })
}

/* The legacy leg answers in SSE framing (headline finding 1) — one
 * `event: message\ndata: <one-line JSON>\n\n` frame. verify-mcp's unwrap,
 * ported: assert the framing bytes, hand back the data line. */
const SSE_PREFIX = 'event: message\ndata: '
function unwrapSse(body: string): string {
  expect(body.startsWith(SSE_PREFIX)).toBe(true)
  expect(body.endsWith('\n\n')).toBe(true)
  return body.slice(SSE_PREFIX.length, -2)
}

/* The modern _meta envelope, as the capture's client sent it. */
const env = (pv = '2026-07-28'): Record<string, unknown> => ({
  'io.modelcontextprotocol/protocolVersion': pv,
  'io.modelcontextprotocol/clientInfo': { name: 'phase8-capture', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
})

const modernHeaders = (method: string, name?: string): Record<string, string> => ({
  'MCP-Protocol-Version': '2026-07-28',
  'Mcp-Method': method,
  ...(name === undefined ? {} : { 'Mcp-Name': name }),
})

const legacyBody = (method: string, params: unknown, id?: number): string =>
  JSON.stringify(
    id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', method, params, id },
  )

/* ------------- expected bytes, as transcribed in convex/tests/mcp.test.ts */

const E401_MISSING = '{"error":"missing credential (Authorization: Bearer qvt_… or qva_…)"}'
const E401_PERSON = '{"error":"unknown or revoked MCP token"}'
const E401_AGENT = '{"error":"unknown, revoked or deactivated agent key"}'
const E405 = '{"error":"stateless MCP server — POST JSON-RPC only"}'
const E32700 =
  '{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error: Invalid JSON"},"id":null}'
const E32600_EMPTY =
  '{"jsonrpc":"2.0","error":{"code":-32600,"message":"Bad Request: empty JSON-RPC batch"},"id":null}'
const E406 =
  '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept both application/json and text/event-stream"},"id":null}'

const frame = (dataJson: string): string => `${SSE_PREFIX}${dataJson}\n\n`
const initFrame = (pv: string, id: number): string =>
  frame(
    `{"result":{"protocolVersion":"${pv}","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"qivo","version":"1.0.0"}},"jsonrpc":"2.0","id":${id}}`,
  )

/* Capture 40: the -32603 message is a pretty-printed zod issue array. */
const ZOD_NO_PARAMS =
  '[\n  {\n    "expected": "object",\n    "code": "invalid_type",\n    "path": [\n      "params"\n    ],\n    "message": "Invalid input: expected object, received undefined"\n  }\n]'

const SERVER_META = { 'io.modelcontextprotocol/serverInfo': { name: 'qivo', version: '1.0.0' } }

/* Backstop: an issue the write trip left behind dies over REST (same key). */
const leftovers = new Set<string>()
afterAll(async () => {
  for (const ref of leftovers) {
    await fetch(`${BASE}/v1/tasks/${ref}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${stash.qva}` },
    }).catch(() => undefined)
  }
})

/* --------------------------------------------------------- transport shells */

describe('transport shells', () => {
  test('01: OPTIONS answers ok with the exact CORS surface and no max-age', async () => {
    const res = await fetch(`${BASE}/mcp`, { method: 'OPTIONS' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(res.headers.get('content-type')).toBe('text/plain;charset=UTF-8')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-headers')).toBe(
      'authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id',
    )
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE, OPTIONS')
    expect(res.headers.get('access-control-max-age')).toBeNull()
  })

  test('02/03/37: every non-POST verb is 405 with the deployed body, before auth', async () => {
    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH']) {
      const bare = await fetch(`${BASE}/mcp`, { method })
      expect(bare.status).toBe(405)
      expect(await bare.text()).toBe(E405)
      expect(bare.headers.get('allow')).toBe('POST, OPTIONS')
      expect(bare.headers.get('content-type')).toBe('application/json')
      // with VALID auth — still 405 (405-before-auth)
      const authed = await fetch(`${BASE}/mcp`, {
        method,
        headers: { Authorization: `Bearer ${stash.qvt}` },
      })
      expect(authed.status).toBe(405)
      expect(await authed.text()).toBe(E405)
    }
  })

  test('04/05/06/07: the three 401 sentences + WWW-Authenticate; lowercase bearer falls to missing', async () => {
    const cases: [Record<string, string>, string][] = [
      [{}, E401_MISSING], // 04: no Authorization at all
      [
        { Authorization: 'Bearer qvt_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
        E401_PERSON,
      ], // 05
      [
        { Authorization: 'Bearer qva_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
        E401_AGENT,
      ], // 06
      [{ Authorization: `bearer ${stash.qvt}` }, E401_MISSING], // 07: case-sensitive 'Bearer ' prefix
    ]
    for (const [headers, expected] of cases) {
      const res = await post(null, '{}', headers)
      expect(res.status).toBe(401)
      expect(await res.text()).toBe(expected)
      expect(res.headers.get('www-authenticate')).toBe(
        `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="qivo:read qivo:write offline_access"`,
      )
      expect(res.headers.get('content-type')).toBe('application/json')
    }
  })

  test('08/09/10: body-shape 400s — exact bodies, id:null, plain JSON', async () => {
    const E32600_INVALID =
      '{"jsonrpc":"2.0","error":{"code":-32600,"message":"Bad Request: the request body is not a valid JSON-RPC message"},"id":null}'
    const cases: [string, string][] = [
      ['{"jsonrpc": "2.0",', E32700],
      ['[]', E32600_EMPTY],
      ['{"hello":"world"}', E32600_INVALID],
    ]
    for (const [body, expected] of cases) {
      const res = await post(stash.qvt, body)
      expect(res.status).toBe(400)
      expect(await res.text()).toBe(expected)
      expect(res.headers.get('content-type')).toBe('application/json')
    }
  })
})

/* ------------------------------------------------------ legacy leg framing */

describe('legacy leg', () => {
  const init = (pv: string): string =>
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: pv,
        capabilities: {},
        clientInfo: { name: 'phase8-capture', version: '1.0.0' },
      },
      id: 1,
    })

  test('11/12: initialize echoes a supported version in SSE framing — exact frames', async () => {
    for (const pv of ['2024-11-05', '2025-06-18']) {
      const res = await post(stash.qvt, init(pv))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/event-stream')
      expect(res.headers.get('cache-control')).toBe('no-cache, no-transform')
      expect(await res.text()).toBe(initFrame(pv, 1))
    }
  })

  test('13/35: an unsupported version — 2026-07-28 sent raw included — answers the 2025-11-25 fallback', async () => {
    // the unit suite (convex/tests/mcp.test.ts) and the capture pin the SAME
    // fallback value, 2025-11-25 — no divergence to note
    for (const pv of ['2026-07-28', '1999-01-01']) {
      const res = await post(stash.qvt, init(pv))
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(initFrame('2025-11-25', 1))
    }
  })

  test('40: params-less initialize → -32603 with the pretty zod issue array', async () => {
    const res = await post(stash.qvt, '{"jsonrpc":"2.0","method":"initialize","id":1}')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(
      frame(
        `{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":${JSON.stringify(ZOD_NO_PARAMS)}}}`,
      ),
    )
  })

  test('14/32: notifications answer 202 with no body and no content-type, both legs', async () => {
    const legacy = await post(stash.qvt, '{"jsonrpc":"2.0","method":"notifications/initialized"}')
    expect(legacy.status).toBe(202)
    expect(await legacy.text()).toBe('')
    expect(legacy.headers.get('content-type')).toBeNull()
    const modern = await post(
      stash.qvt,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: { _meta: env() },
      }),
      modernHeaders('notifications/initialized'),
    )
    expect(modern.status).toBe(202)
    expect(await modern.text()).toBe('')
    expect(modern.headers.get('content-type')).toBeNull()
  })

  test('18 vs 31: ping lives legacy, 404s modern (and 21: modern initialize too)', async () => {
    const ping = await post(stash.qvt, legacyBody('ping', {}, 5))
    expect(ping.status).toBe(200)
    expect(await ping.text()).toBe(frame('{"result":{},"jsonrpc":"2.0","id":5}'))
    const mPing = await post(
      stash.qvt,
      JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: { _meta: env() }, id: 25 }),
      modernHeaders('ping'),
    )
    expect(mPing.status).toBe(404)
    expect(await mPing.text()).toBe(
      '{"jsonrpc":"2.0","id":25,"error":{"code":-32601,"message":"Method not found"}}',
    )
    const mInit = await post(
      stash.qvt,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2026-07-28',
          capabilities: {},
          clientInfo: { name: 'phase8-capture', version: '1.0.0' },
          _meta: env(),
        },
        id: 1,
      }),
      modernHeaders('initialize'),
    )
    expect(mInit.status).toBe(404)
    expect(await mInit.text()).toBe(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}',
    )
  })

  test('33/34/42/43 vs 41: the Accept gate needs BOTH media types on legacy; modern is ungated', async () => {
    const listBody = legacyBody('tools/list', {}, 2)
    for (const accept of ['application/json', 'text/event-stream', '*/*']) {
      const res = await post(stash.qvt, listBody, { Accept: accept })
      expect(res.status).toBe(406)
      expect(await res.text()).toBe(E406)
      expect(res.headers.get('content-type')).toBe('application/json')
    }
    // absent Accept — same gate. fetch injects `Accept: */*` when the header
    // is missing, which the gate refuses identically (capture 34's curl did
    // the same), so the wire cannot carry a truly Accept-less request here.
    const noAccept = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${stash.qvt}`, 'Content-Type': 'application/json' },
      body: listBody,
    })
    expect(noAccept.status).toBe(406)
    // 41: MODERN with Accept: application/json only → served
    const modern = await post(
      stash.qvt,
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: { _meta: env() }, id: 3 }),
      { Accept: 'application/json', ...modernHeaders('tools/list') },
    )
    expect(modern.status).toBe(200)
  })

  test('15/23/36: tools/list reproduces the pinned bytes on both legs; batch-of-one is a single response', async () => {
    const legacy = await post(stash.qvt, legacyBody('tools/list', {}, 2))
    expect(legacy.status).toBe(200)
    expect(legacy.headers.get('content-type')).toBe('text/event-stream')
    const body = await legacy.text()
    const dataJson = unwrapSse(body)
    const catalogue = JSON.parse(dataJson) as { result: { tools: { name: string }[] } }
    expect(catalogue.result.tools.map((tool) => tool.name)).toContain('list_tasks')
    expect(JSON.stringify(catalogue.result.tools)).not.toMatch(/\bissues?\b|_issues?\b/)
    expect(sha256(dataJson)).toBe(SHA_TOOLS_LEGACY)
    // 36: a BATCH OF ONE is served as the identical single non-array response
    const batched = await post(stash.qvt, `[${legacyBody('tools/list', {}, 2)}]`)
    expect(await batched.text()).toBe(body)
    // 23: modern — plain JSON, whole body pinned
    const modern = await post(
      stash.qvt,
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: { _meta: env() }, id: 3 }),
      modernHeaders('tools/list'),
    )
    expect(modern.status).toBe(200)
    expect(modern.headers.get('content-type')).toBe('application/json')
    expect(sha256(await modern.text())).toBe(SHA_TOOLS_MODERN)
  })
})

/* ------------------------------------------------------- modern leg bodies */

describe('modern leg', () => {
  test('22: server/discover — exact captured body', async () => {
    const res = await post(
      stash.qvt,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'server/discover',
        params: { _meta: env() },
        id: 1,
      }),
      modernHeaders('server/discover'),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(
      JSON.stringify({
        result: {
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: { listChanged: true }, events: {} },
          resultType: 'complete',
          ttlMs: 3600000,
          cacheScope: 'private',
          _meta: SERVER_META,
        },
        jsonrpc: '2.0',
        id: 1,
      }),
    )
  })

  test('26/27/28/38: the -32020 header-mismatch bodies, byte-exact', async () => {
    const mismatch = (sentence: string, header: string, id: number): string =>
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32020,
          message: `Bad Request: the request headers and body disagree: ${sentence}`,
          data: { mismatch: { header, body: sentence } },
        },
        id,
      })
    // 26: Mcp-Name disagrees with body
    const r26 = await post(
      stash.qvt,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list_teams', arguments: {}, _meta: env() },
        id: 20,
      }),
      modernHeaders('tools/call', 'list_projects'),
    )
    expect(r26.status).toBe(400)
    expect(await r26.text()).toBe(
      mismatch(
        'the body carries params.name="list_teams" but the Mcp-Name header names "list_projects"',
        'list_projects',
        20,
      ),
    )
    // 27: Mcp-Method disagrees with body
    const r27 = await post(
      stash.qvt,
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: { _meta: env() }, id: 21 }),
      modernHeaders('tools/call'),
    )
    expect(await r27.text()).toBe(
      mismatch(
        'the body names method tools/list but the Mcp-Method header names tools/call',
        'tools/call',
        21,
      ),
    )
    // 28: Mcp-Method missing on an enveloped request
    const r28 = await post(
      stash.qvt,
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: { _meta: env() }, id: 22 }),
      { 'MCP-Protocol-Version': '2026-07-28' },
    )
    expect(await r28.text()).toBe(
      mismatch(
        'the body names method tools/list but the required Mcp-Method header is absent',
        '(missing)',
        22,
      ),
    )
    // 38: Mcp-Name missing on modern tools/call
    const r38 = await post(
      stash.qvt,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list_teams', arguments: {}, _meta: env() },
        id: 26,
      }),
      modernHeaders('tools/call'),
    )
    expect(await r38.text()).toBe(
      mismatch(
        'the body carries params.name="list_teams" but the required Mcp-Name header is absent',
        '(missing)',
        26,
      ),
    )
  })

  test('29: missing clientCapabilities in _meta → the -32602 envelope error', async () => {
    const meta29 = { ...env() }
    delete (meta29 as Record<string, unknown>)['io.modelcontextprotocol/clientCapabilities']
    const res = await post(
      stash.qvt,
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: { _meta: meta29 }, id: 23 }),
      modernHeaders('tools/list'),
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toBe(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32602,
          message:
            'Invalid _meta envelope for protocol revision 2026-07-28: io.modelcontextprotocol/clientCapabilities: missing',
          data: {
            envelope: { key: 'io.modelcontextprotocol/clientCapabilities', problem: 'missing' },
          },
        },
        id: 23,
      }),
    )
  })

  test('30: unsupported protocolVersion → -32022 with data.supported', async () => {
    const res = await post(
      stash.qvt,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: { _meta: env('2099-01-01') },
        id: 24,
      }),
      { 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Method': 'tools/list' },
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toBe(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32022,
          message: 'Unsupported protocol version: 2099-01-01',
          data: { supported: ['2026-07-28'], requested: '2099-01-01' },
        },
        id: 24,
      }),
    )
  })

  test('17/25: the QN-999999 refusal is the bare sentence, both legs (stable — kept)', async () => {
    // 17: legacy — isError frame with the bare app sentence
    const r17 = await post(
      stash.qvt,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get_task', arguments: { ref: 'QN-999999' } },
        id: 4,
      }),
    )
    expect(await r17.text()).toBe(
      frame(
        '{"result":{"content":[{"type":"text","text":"task \\"QN-999999\\" not found (or not visible to you)"}],"isError":true},"jsonrpc":"2.0","id":4}',
      ),
    )
    // 25: the modern isError still carries resultType + serverInfo _meta
    const r25 = await post(
      stash.qvt,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get_task', arguments: { ref: 'QN-999999' }, _meta: env() },
        id: 2,
      }),
      modernHeaders('tools/call', 'get_task'),
    )
    expect(r25.status).toBe(200)
    expect(await r25.text()).toBe(
      JSON.stringify({
        result: {
          content: [{ type: 'text', text: 'task "QN-999999" not found (or not visible to you)' }],
          isError: true,
          resultType: 'complete',
          _meta: SERVER_META,
        },
        jsonrpc: '2.0',
        id: 2,
      }),
    )
  })
})

/* -------------------------------------------------- the modern-leg write trip */

describe('write trip (modern leg, qva key — creates only what it deletes)', () => {
  test('project roster → reporter attribution → folded update → delete', async () => {
    type ToolResult = { content: { text: string }[]; isError?: boolean }
    const callToolRaw = async (
      name: string,
      args: Record<string, unknown>,
      id: number,
    ): Promise<ToolResult> => {
      const res = await post(
        stash.qva,
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name, arguments: args, _meta: env() },
          id,
        }),
        modernHeaders('tools/call', name),
      )
      expect(res.status).toBe(200)
      const rpc = (await res.json()) as { result: ToolResult }
      return rpc.result
    }
    const callTool = async (
      name: string,
      args: Record<string, unknown>,
      id: number,
    ): Promise<string> => {
      const result = await callToolRaw(name, args, id)
      expect(result.isError).toBeUndefined()
      return result.content[0].text
    }

    // Agents discover only valid destination-project users, with the
    // assignment-specific restriction stated separately.
    const projectUsers = JSON.parse(
      await callTool('list_project_users', { project: 'SENS' }, 8),
    ) as Array<{
      id: string
      name: string
      active: boolean
      org_role: string
      assignable: boolean
    }>
    expect(projectUsers.length).toBeGreaterThan(1)
    expect(Object.fromEntries(projectUsers.map((user) => [user.name, user.assignable]))).toEqual({
      'Nora Berg': true,
      'Leo Martins': true,
      'Aisha Rahman': true,
      'Emil Strand': true,
      'Daniel Park': false,
      'Sofia Andersson': true,
      'Ben Carter': false,
      Atlas: true,
    })
    const creator = projectUsers.find((user) => user.name === 'Atlas')
    const reporter = projectUsers.find((user) => user.name === 'Nora Berg')
    const viewOnly = projectUsers.find((user) => user.name === 'Daniel Park')
    expect(creator).toBeDefined()
    expect(reporter).toBeDefined()
    expect(viewOnly).toBeDefined()
    if (creator === undefined || reporter === undefined || viewOnly === undefined) {
      throw new Error('seeded Northstar project users are missing')
    }

    // create into the seeded Luma Sensor meta, sub named (Atlas is on its team)
    const createdText = await callTool(
      'create_task',
      { project: 'SENS', sub_project: 'ELEC', title: 'MCP contract trip' },
      9,
    )
    const created = JSON.parse(createdText) as { id: string; key: string }
    leftovers.add(created.id)
    expect(created.key).toMatch(/^QN-\d+$/)
    // the 2-space pretty body and its key order are the wire
    expect(createdText).toBe(`{\n  "id": "${created.id}",\n  "key": "${created.key}"\n}`)

    const refusedCreate = await callToolRaw(
      'create_task',
      {
        project: 'SENS',
        sub_project: 'ELEC',
        title: 'View-only assignee must be refused',
        assignee_id: viewOnly.id,
      },
      15,
    )
    expect(refusedCreate.isError).toBe(true)
    expect(refusedCreate.content[0].text).toBe(
      `user "${viewOnly.id}" needs Edit permission or higher on this project to be assigned work`,
    )

    const refusedUpdate = await callToolRaw(
      'update_task',
      { ref: created.key, assignee_id: viewOnly.id },
      16,
    )
    expect(refusedUpdate.isError).toBe(true)
    expect(refusedUpdate.content[0].text).toBe(
      `user "${viewOnly.id}" needs Edit permission or higher on this project to be assigned work`,
    )

    const refusedReviewer = await callToolRaw(
      'update_task',
      { ref: created.key, reviewer_id: viewOnly.id },
      17,
    )
    expect(refusedReviewer.isError).toBe(true)
    expect(refusedReviewer.content[0].text).toBe(
      `user "${viewOnly.id}" needs Edit permission or higher on this project to review work`,
    )

    const comment = JSON.parse(
      await callTool(
        'add_comment',
        {
          ref: created.key,
          body: 'MCP contract task comment',
        },
        91,
      ),
    ) as Record<string, unknown>
    expect(comment).toEqual({
      id: expect.any(String),
      task: created.key,
      created_at: expect.any(String),
    })
    const comments = JSON.parse(await callTool('list_comments', { ref: created.key }, 92))
    expect(comments).toEqual([
      expect.objectContaining({
        id: comment.id,
        body: 'MCP contract task comment',
      }),
    ])

    // Tool search carries reordered fragments and a task ID through the wire.
    for (const search of ['TRIP cont', `${created.key.toLowerCase()} tract`]) {
      const matches = JSON.parse(await callTool('list_tasks', { search }, 90)) as { id: string }[]
      expect(matches.map((issue) => issue.id)).toEqual([created.id])
    }

    // Omission fixes the reporter as the authenticated caller.
    const defaulted = JSON.parse(await callTool('get_task', { ref: created.key }, 10)) as Record<
      string,
      unknown
    >
    expect(defaulted).toMatchObject({
      reporter_id: creator.id,
      reporter_name: 'Atlas',
    })
    expect(defaulted).not.toHaveProperty('creator_id')
    expect(defaulted).not.toHaveProperty('creator_name')

    const attributed = JSON.parse(
      await callTool(
        'create_task',
        {
          project: 'SENS',
          sub_project: 'ELEC',
          title: 'Mapped reporter',
          reporter_id: reporter.id,
        },
        101,
      ),
    ) as { id: string; key: string }
    leftovers.add(attributed.id)
    expect(JSON.parse(await callTool('get_task', { ref: attributed.key }, 102))).toMatchObject({
      reporter_id: reporter.id,
      reporter_name: 'Nora Berg',
    })
    await callTool('delete_task', { ref: attributed.key }, 103)
    leftovers.delete(attributed.id)

    const nullReporter = await callToolRaw(
      'create_task',
      {
        project: 'ELEC',
        title: 'Must not be created',
        reporter_id: null,
      },
      104,
    )
    expect(nullReporter.isError).toBe(true)
    expect(nullReporter.content[0].text).toBe(
      'Input validation error: Invalid arguments for tool create_task: reporter_id: Invalid input: expected string, received null',
    )
    const unknownReporter = '00000000-0000-0000-0000-000000000000'
    const missingReporter = await callToolRaw(
      'create_task',
      {
        project: 'ELEC',
        title: 'Must not be created',
        reporter_id: unknownReporter,
      },
      105,
    )
    expect(missingReporter.isError).toBe(true)
    expect(missingReporter.content[0].text).toBe(
      `user "${unknownReporter}" not found in your organization`,
    )

    for (const reporter_id of [reporter.id, creator.id, null, unknownReporter]) {
      const refused = await callToolRaw(
        'update_task',
        {
          ref: created.key,
          reporter_id,
          title: 'Must not change',
          status: 'review',
          archived: true,
        },
        106,
      )
      expect(refused.isError).toBe(true)
      expect(refused.content[0].text).toBe(
        'Input validation error: Invalid arguments for tool update_task: reporter_id: reporter_id is set when a task is created and cannot be changed',
      )
      expect(JSON.parse(await callTool('get_task', { ref: created.key }, 107))).toEqual(defaulted)
    }

    const updated = JSON.parse(
      await callTool(
        'update_task',
        {
          ref: created.key,
          status: 'review',
          archived: true,
        },
        11,
      ),
    ) as { id: string; key: string; updated: string[] }
    expect(updated).toEqual({
      id: created.id,
      key: created.key,
      updated: ['status', 'archived_at'],
    })
    // `updated` echoes requested keys only; the review time still lands
    expect(JSON.parse(await callTool('get_task', { ref: created.key }, 12))).toMatchObject({
      reporter_id: creator.id,
      reporter_name: 'Atlas',
      status: 'review',
      remaining_hours: 2,
    })

    // delete cleans up
    const deleted = JSON.parse(await callTool('delete_task', { ref: created.key }, 14)) as Record<
      string,
      unknown
    >
    expect(deleted).toEqual({ deleted: true, key: created.key })
    leftovers.delete(created.id)
  })
})

describe('task events over stateless MCP', () => {
  test('lists events without a session and refuses private callback destinations', async () => {
    const send = (method: string, params: Record<string, unknown>) =>
      post(
        stash.qva,
        JSON.stringify({
          jsonrpc: '2.0',
          method,
          params: { ...params, _meta: env() },
          id: 201,
        }),
        modernHeaders(method),
      )
    const listing = await send('events/list', {})
    expect(listing.status).toBe(200)
    expect(listing.headers.get('mcp-session-id')).toBeNull()
    expect(
      (await listing.json()).result.events.map((event: { name: string }) => event.name),
    ).toEqual(['task.created', 'task.updated', 'task.deleted', 'comment.created'])
    const refused = await send('events/subscribe', {
      name: 'task.updated',
      arguments: {},
      delivery: { mode: 'webhook', url: 'https://127.0.0.1/events', secret: 'unused' },
    })
    expect((await refused.json()).error).toMatchObject({ code: -32602 })
  })
})

/* ----------------------------------------------------------------- FINALE
 * ORDER-DEPENDENT: this must stay the LAST test in the file — it deletes the
 * suite's own qvt token (via the internal teardown fn) and replays one call
 * to capture exchange 44 live: the very same bearer that worked all suite
 * long now answers the person-leg collapse sentence. The globalSetup
 * teardown re-deletes tolerantly afterwards. */

describe('finale — exchange 44', () => {
  test('the revoked/deleted qvt token answers the person-leg 401, live', async () => {
    execFileSync(
      'npx',
      [
        'convex',
        'run',
        'machine/testing:deleteCredential',
        JSON.stringify({ id: stash.qvtId, kind: 'mcp_token' }),
      ],
      { cwd: ROOT, stdio: 'ignore' },
    )
    const res = await post(stash.qvt, legacyBody('ping', {}, 5))
    expect(res.status).toBe(401)
    expect(await res.text()).toBe(E401_PERSON)
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="qivo:read qivo:write offline_access"`,
    )
  })
})

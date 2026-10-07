/* The /mcp surface (phase 8): byte-pinned transport conformance plus the
 * per-tool behavior suite over the internal fns. Transport tests drive the
 * REAL route via convex-test
 * t.fetch — auth, per-call stamp, both protocol legs, tools included.
 *
 * The two big tools/list payloads are pinned by sha256 of the expected bytes
 * rather than 8KB embeds; everything else is exact string equality. */
/// <reference types="vite/client" />

import type { WithoutSystemFields } from 'convex/server'
import { describe, expect, test } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { sha256hex } from '../machine/auth'
import {
  activityFor,
  drainActivity,
  expectRefusal,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  plantSubscription,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

/* ------------------------------------------------------------ wire helpers */

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }
const f = (t: T) => t as unknown as { fetch(path: string, init?: FetchInit): Promise<Response> }
const bodyOf = (r: Response): Promise<string> =>
  (r as unknown as { text(): Promise<string> }).text()

const QVT = `qvt_${'a1b2c3d4'.repeat(6)}`
const QVA = `qva_${'f9e8d7c6'.repeat(6)}`

async function mintToken(t: T, profile: Doc<'profiles'>, secret: string): Promise<void> {
  const token_hash = await sha256hex(secret)
  await t.run(async (ctx) => {
    await ctx.db.insert('mcp_tokens', {
      id: uuid(),
      profile_id: profile.id,
      name: 'capture token',
      token_prefix: secret.slice(0, 11),
      token_hash,
      created_at: NOW,
    })
  })
}

async function mintKey(t: T, agent: Doc<'profiles'>, secret: string): Promise<void> {
  const key_hash = await sha256hex(secret)
  await t.run(async (ctx) => {
    await ctx.db.insert('agent_keys', {
      id: uuid(),
      profile_id: agent.id,
      name: 'Default key',
      key_prefix: secret.slice(0, 11),
      key_hash,
      created_at: NOW,
    })
  })
}

const BOTH_ACCEPT = 'application/json, text/event-stream'

function post(
  t: T,
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
  return f(t).fetch('/mcp', { method: 'POST', headers: h, body })
}

/* The modern _meta envelope, as the capture's client sent it. */
const env = (pv = '2026-07-28'): Record<string, unknown> => ({
  'io.modelcontextprotocol/protocolVersion': pv,
  'io.modelcontextprotocol/clientInfo': { name: 'phase8-capture', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
})

const legacyBody = (method: string, params: unknown, id?: number): string =>
  JSON.stringify(
    id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', method, params, id },
  )

/* -------------------------------- expected bytes, transcribed from capture */

const E401_MISSING = '{"error":"missing credential (Authorization: Bearer qvt_… or qva_…)"}'
const E401_PERSON = '{"error":"unknown or revoked MCP token"}'
const E401_AGENT = '{"error":"unknown, revoked or deactivated agent key"}'
const E405 = '{"error":"stateless MCP server — POST JSON-RPC only"}'
const E32700 =
  '{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error: Invalid JSON"},"id":null}'
const E32600_EMPTY =
  '{"jsonrpc":"2.0","error":{"code":-32600,"message":"Bad Request: empty JSON-RPC batch"},"id":null}'
const E32600_INVALID =
  '{"jsonrpc":"2.0","error":{"code":-32600,"message":"Bad Request: the request body is not a valid JSON-RPC message"},"id":null}'
const E406 =
  '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept both application/json and text/event-stream"},"id":null}'

const frame = (dataJson: string): string => `event: message\ndata: ${dataJson}\n\n`
const initFrame = (pv: string, id: number): string =>
  frame(
    `{"result":{"protocolVersion":"${pv}","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"qivo","version":"1.0.0"}},"jsonrpc":"2.0","id":${id}}`,
  )

/* Capture 40: the -32603 message is a pretty-printed zod issue array. */
const ZOD_NO_PARAMS =
  '[\n  {\n    "expected": "object",\n    "code": "invalid_type",\n    "path": [\n      "params"\n    ],\n    "message": "Invalid input: expected object, received undefined"\n  }\n]'

const SERVER_META = { 'io.modelcontextprotocol/serverInfo': { name: 'qivo', version: '1.0.0' } }

/* sha256 of the current tools/list bytes (legacy data line, id 2; modern
 * whole body, id 3). */
const SHA_TOOLS_LEGACY = '4a07a0ca52f39a77dd2e4c9402c47155b853c96a8d60b7661adcf91bcb5d6f76'
const SHA_TOOLS_MODERN = '25652d8eb445bd65ea9042fcd3a21080b1a623d5c0afc915cb9eff987dcbdb97'

/* ----------------------------------------------------------------- fixture */

type Fx = OrgFixture & { t: T }

/* withOrg + the machine actor: the fixture agent holds a 'user' grant on the
 * meta (reads/writes sub + sub2, blind to hidden). */
async function machineOrg(): Promise<Fx> {
  const t = newT()
  const fx = await withOrg(t)
  await t.run(async (ctx) => {
    await ctx.db.insert('project_access', {
      project_id: fx.meta.id,
      profile_id: fx.agent.id,
      level: 'user',
    })
  })
  return { t, ...fx }
}

async function plantAgent(
  t: T,
  org_id: string,
  over: Partial<WithoutSystemFields<Doc<'profiles'>>> = {},
): Promise<Doc<'profiles'>> {
  return await t.run(async (ctx) => {
    const _id = await ctx.db.insert('profiles', {
      id: uuid(),
      org_id,
      name: 'Beta agent',
      initials: 'BA',
      color: '#204060',
      org_role: 'user',
      active: true,
      kind: 'agent',
      created_at: NOW,
      ...over,
    })
    return (await ctx.db.get(_id)) as Doc<'profiles'>
  })
}

const grant = (t: T, project_id: string, profile_id: string, level: 'user' | 'viewer') =>
  t.run(async (ctx) => {
    await ctx.db.insert('project_access', { project_id, profile_id, level })
  })

const parse = (s: string): Record<string, unknown> => JSON.parse(s) as Record<string, unknown>

/* ------------------------------------------------------ transport: shells */

describe('transport shells (405 / OPTIONS / 401)', () => {
  test('OPTIONS answers ok with the exact CORS surface', async () => {
    const t = newT()
    const res = await f(t).fetch('/mcp', { method: 'OPTIONS' })
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toBe('ok')
    expect(res.headers.get('Content-Type')).toBe('text/plain;charset=UTF-8')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id',
    )
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, DELETE, OPTIONS')
  })

  test('every non-POST verb is 405 with the deployed body, before auth', async () => {
    const fx = await machineOrg()
    await mintToken(fx.t, fx.admin, QVT)
    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH']) {
      // without auth
      const bare = await f(fx.t).fetch('/mcp', { method })
      expect(bare.status).toBe(405)
      expect(await bodyOf(bare)).toBe(E405)
      expect(bare.headers.get('Allow')).toBe('POST, OPTIONS')
      expect(bare.headers.get('Content-Type')).toBe('application/json')
      // with VALID auth — still 405 (405-before-auth, capture 02/03/37)
      const authed = await f(fx.t).fetch('/mcp', {
        method,
        headers: { Authorization: `Bearer ${QVT}` },
      })
      expect(authed.status).toBe(405)
      expect(await bodyOf(authed)).toBe(E405)
    }
  })

  test('the three 401 sentences + WWW-Authenticate, lowercase bearer falls to missing', async () => {
    const fx = await machineOrg()
    await mintToken(fx.t, fx.admin, QVT)
    const cases: [Record<string, string>, string][] = [
      [{}, E401_MISSING], // no Authorization at all
      [
        { Authorization: 'Bearer qvt_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
        E401_PERSON,
      ],
      [
        { Authorization: 'Bearer qva_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
        E401_AGENT,
      ],
      [{ Authorization: `bearer ${QVT}` }, E401_MISSING], // case-sensitive 'Bearer ' prefix
      [{ Authorization: `Bearer x_${QVT}` }, E401_MISSING], // bad prefix, no DB hit
    ]
    for (const [headers, expected] of cases) {
      const res = await post(fx.t, null, '{}', headers)
      expect(res.status).toBe(401)
      expect(await bodyOf(res)).toBe(expected)
      expect(res.headers.get('WWW-Authenticate')).toBe(
        `Bearer resource_metadata="${process.env.CONVEX_SITE_URL}/.well-known/oauth-protected-resource/mcp", scope="qivo:read qivo:write offline_access"`,
      )
      expect(res.headers.get('Content-Type')).toBe('application/json')
    }
  })

  test('revoked token / unclaimed seat / deactivated agent collapse per leg', async () => {
    const fx = await machineOrg()
    // revoked qvt_
    const revoked = `qvt_${'11223344'.repeat(6)}`
    await mintToken(fx.t, fx.admin, revoked)
    await fx.t.run(async (ctx) => {
      const row = await ctx.db
        .query('mcp_tokens')
        .withIndex('by_hash', (q) => q.eq('token_hash', ''))
        .first()
      void row // (hash lookup below instead — patch by profile)
      for (const tok of await ctx.db
        .query('mcp_tokens')
        .withIndex('by_profile', (q) => q.eq('profile_id', fx.admin.id))
        .collect()) {
        await ctx.db.patch(tok._id, { revoked_at: NOW })
      }
    })
    expect(await bodyOf(await post(fx.t, revoked, '{}'))).toBe(E401_PERSON)
    // a person token on an UNCLAIMED seat (no auth_user_id) — wrong_kind
    const seat = await plantSeat(fx.t, { org_id: fx.org.id, auth_user_id: undefined })
    const seatTok = `qvt_${'55667788'.repeat(6)}`
    await mintToken(fx.t, seat, seatTok)
    expect(await bodyOf(await post(fx.t, seatTok, '{}'))).toBe(E401_PERSON)
    // deactivated agent — the agent-leg collapse
    await mintKey(fx.t, fx.agent, QVA)
    await fx.t.run(async (ctx) => {
      const rows = await ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', fx.agent.id))
        .collect()
      await ctx.db.patch(rows[0]._id, { active: false })
    })
    expect(await bodyOf(await post(fx.t, QVA, '{}'))).toBe(E401_AGENT)
  })

  test('last_used_at stamps on every authenticated request, even a 400', async () => {
    const fx = await machineOrg()
    await mintToken(fx.t, fx.admin, QVT)
    const res = await post(fx.t, QVT, '{"jsonrpc": "2.0",') // malformed JSON
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toBe(E32700)
    const stamped = await fx.t.run(
      async (ctx) =>
        await ctx.db
          .query('mcp_tokens')
          .withIndex('by_profile', (q) => q.eq('profile_id', fx.admin.id))
          .first(),
    )
    expect(stamped?.last_used_at).toBeDefined()
  })
})

/* ----------------------------------------------- transport: body + legs */

describe('body shape and leg selection', () => {
  test('malformed JSON / empty batch / non-JSON-RPC object — exact bodies', async () => {
    const fx = await machineOrg()
    await mintToken(fx.t, fx.admin, QVT)
    const cases: [string, string][] = [
      ['{"jsonrpc": "2.0",', E32700],
      ['[]', E32600_EMPTY],
      ['{"hello":"world"}', E32600_INVALID],
      ['[{"jsonrpc":"2.0","id":1},{"jsonrpc":"2.0","id":2}]', E32600_INVALID], // multi-batch (uncaptured, chosen)
    ]
    for (const [body, expected] of cases) {
      const res = await post(fx.t, QVT, body)
      expect(res.status).toBe(400)
      expect(await bodyOf(res)).toBe(expected)
      expect(res.headers.get('Content-Type')).toBe('application/json')
    }
  })

  test('legacy Accept gate: both media types required, */* fails; modern leg has no gate', async () => {
    const fx = await machineOrg()
    await mintToken(fx.t, fx.admin, QVT)
    const listBody = legacyBody('tools/list', {}, 2)
    for (const accept of ['application/json', 'text/event-stream', '*/*']) {
      const res = await post(fx.t, QVT, listBody, { Accept: accept })
      expect(res.status).toBe(406)
      expect(await bodyOf(res)).toBe(E406)
      expect(res.headers.get('Content-Type')).toBe('application/json')
    }
    // absent Accept — same gate (capture 34, curl default was */*; both 406)
    const noAccept = await f(fx.t).fetch('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${QVT}`, 'Content-Type': 'application/json' },
      body: listBody,
    })
    expect(noAccept.status).toBe(406)
    // MODERN with Accept: application/json only → served (capture 41)
    const modern = await post(
      fx.t,
      QVT,
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: { _meta: env() }, id: 3 }),
      {
        Accept: 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
    )
    expect(modern.status).toBe(200)
  })

  test('legacy initialize: version echo, fallback, params-less -32603 — exact frames', async () => {
    const fx = await machineOrg()
    await mintToken(fx.t, fx.admin, QVT)
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
    const cases: [string, string][] = [
      ['2024-11-05', '2024-11-05'],
      ['2025-06-18', '2025-06-18'],
      ['2025-03-26', '2025-03-26'], // uncaptured member of the SDK list
      ['2026-07-28', '2025-11-25'], // the modern revision sent RAW is not a legacy version
      ['1999-01-01', '2025-11-25'],
    ]
    for (const [asked, negotiated] of cases) {
      const res = await post(fx.t, QVT, init(asked))
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('text/event-stream')
      expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform')
      expect(await bodyOf(res)).toBe(initFrame(negotiated, 1))
    }
    // params-less initialize → -32603 with the pretty zod issue array (capture 40)
    const bare = await post(fx.t, QVT, '{"jsonrpc":"2.0","method":"initialize","id":1}')
    expect(bare.status).toBe(200)
    expect(await bodyOf(bare)).toBe(
      frame(
        `{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":${JSON.stringify(ZOD_NO_PARAMS)}}}`,
      ),
    )
  })

  test('notifications answer 202 with no body and no content-type, both legs', async () => {
    const fx = await machineOrg()
    await mintToken(fx.t, fx.admin, QVT)
    const legacy = await post(fx.t, QVT, '{"jsonrpc":"2.0","method":"notifications/initialized"}')
    expect(legacy.status).toBe(202)
    expect(await bodyOf(legacy)).toBe('')
    expect(legacy.headers.get('Content-Type')).toBeNull()
    const modern = await post(
      fx.t,
      QVT,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: { _meta: env() },
      }),
      { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'notifications/initialized' },
    )
    expect(modern.status).toBe(202)
    expect(await bodyOf(modern)).toBe('')
    expect(modern.headers.get('Content-Type')).toBeNull()
  })

  test('ping lives on the legacy leg; modern 404s removed methods with -32601', async () => {
    const fx = await machineOrg()
    await mintToken(fx.t, fx.admin, QVT)
    const ping = await post(fx.t, QVT, legacyBody('ping', {}, 5))
    expect(ping.status).toBe(200)
    expect(await bodyOf(ping)).toBe(frame('{"result":{},"jsonrpc":"2.0","id":5}'))
    // modern initialize (capture 21) and ping (capture 31) → 404 -32601
    const mInit = await post(
      fx.t,
      QVT,
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
      { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'initialize' },
    )
    expect(mInit.status).toBe(404)
    expect(await bodyOf(mInit)).toBe(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}',
    )
    const mPing = await post(
      fx.t,
      QVT,
      JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: { _meta: env() }, id: 25 }),
      { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'ping' },
    )
    expect(mPing.status).toBe(404)
    expect(await bodyOf(mPing)).toBe(
      '{"jsonrpc":"2.0","id":25,"error":{"code":-32601,"message":"Method not found"}}',
    )
  })

  test('tools/list reproduces the pinned bytes on both legs', async () => {
    const fx = await machineOrg()
    await mintToken(fx.t, fx.admin, QVT)
    // legacy: SSE frame around the id:2 result
    const legacy = await post(fx.t, QVT, legacyBody('tools/list', {}, 2))
    expect(legacy.status).toBe(200)
    expect(legacy.headers.get('Content-Type')).toBe('text/event-stream')
    const body = await bodyOf(legacy)
    expect(body.startsWith('event: message\ndata: ')).toBe(true)
    expect(body.endsWith('\n\n')).toBe(true)
    const dataJson = body.slice('event: message\ndata: '.length, -2)
    const catalogue = JSON.parse(dataJson) as { result: { tools: { name: string }[] } }
    expect(catalogue.result.tools.map((tool) => tool.name)).toEqual([
      'list_teams',
      'list_projects',
      'list_users',
      'list_project_users',
      'update_user',
      'list_tasks',
      'get_task',
      'list_comments',
      'add_comment',
      'create_task',
      'update_task',
      'delete_task',
    ])
    expect(JSON.stringify(catalogue.result.tools)).not.toMatch(/\bissues?\b|_issues?\b/)
    expect(await sha256hex(dataJson)).toBe(SHA_TOOLS_LEGACY)
    // a BATCH OF ONE is served as the identical single non-array response
    const batched = await post(fx.t, QVT, `[${legacyBody('tools/list', {}, 2)}]`)
    expect(await bodyOf(batched)).toBe(body)
    // modern: plain JSON with resultType + cache hints + serverInfo _meta (id:3)
    const modern = await post(
      fx.t,
      QVT,
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: { _meta: env() }, id: 3 }),
      { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
    )
    expect(modern.status).toBe(200)
    expect(modern.headers.get('Content-Type')).toBe('application/json')
    expect(await sha256hex(await bodyOf(modern))).toBe(SHA_TOOLS_MODERN)
  })

  test('old task tool names are refused on both protocol legs', async () => {
    const fx = await machineOrg()
    await mintToken(fx.t, fx.admin, QVT)
    for (const name of [
      'list_issues',
      'get_issue',
      'create_issue',
      'update_issue',
      'delete_issue',
    ]) {
      for (const modern of [false, true]) {
        const res = await post(
          fx.t,
          QVT,
          legacyBody('tools/call', { name, arguments: {}, ...(modern ? { _meta: env() } : {}) }, 6),
          modern
            ? { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': name }
            : {},
        )
        const body = await bodyOf(res)
        const rpc = JSON.parse(modern ? body : body.slice('event: message\ndata: '.length, -2))
        expect(rpc.error).toEqual({ code: -32602, message: `Tool ${name} not found` })
      }
    }
  })

  test('modern server/discover — exact captured body', async () => {
    const fx = await machineOrg()
    await mintToken(fx.t, fx.admin, QVT)
    const res = await post(
      fx.t,
      QVT,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'server/discover',
        params: { _meta: env() },
        id: 1,
      }),
      { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' },
    )
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toBe(
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

  test('modern header/envelope violations — the captured -32020/-32602/-32022 bodies', async () => {
    const fx = await machineOrg()
    await mintToken(fx.t, fx.admin, QVT)
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
      fx.t,
      QVT,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list_teams', arguments: {}, _meta: env() },
        id: 20,
      }),
      {
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'list_projects',
      },
    )
    expect(r26.status).toBe(400)
    expect(await bodyOf(r26)).toBe(
      mismatch(
        'the body carries params.name="list_teams" but the Mcp-Name header names "list_projects"',
        'list_projects',
        20,
      ),
    )
    // 27: Mcp-Method disagrees with body
    const r27 = await post(
      fx.t,
      QVT,
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: { _meta: env() }, id: 21 }),
      { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call' },
    )
    expect(await bodyOf(r27)).toBe(
      mismatch(
        'the body names method tools/list but the Mcp-Method header names tools/call',
        'tools/call',
        21,
      ),
    )
    // 28: Mcp-Method missing on an enveloped request
    const r28 = await post(
      fx.t,
      QVT,
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: { _meta: env() }, id: 22 }),
      { 'MCP-Protocol-Version': '2026-07-28' },
    )
    expect(await bodyOf(r28)).toBe(
      mismatch(
        'the body names method tools/list but the required Mcp-Method header is absent',
        '(missing)',
        22,
      ),
    )
    // 38: Mcp-Name missing on modern tools/call
    const r38 = await post(
      fx.t,
      QVT,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list_teams', arguments: {}, _meta: env() },
        id: 26,
      }),
      { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call' },
    )
    expect(await bodyOf(r38)).toBe(
      mismatch(
        'the body carries params.name="list_teams" but the required Mcp-Name header is absent',
        '(missing)',
        26,
      ),
    )
    // 29: _meta missing clientCapabilities → -32602
    const meta29 = { ...env() }
    delete (meta29 as Record<string, unknown>)['io.modelcontextprotocol/clientCapabilities']
    const r29 = await post(
      fx.t,
      QVT,
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: { _meta: meta29 }, id: 23 }),
      { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
    )
    expect(r29.status).toBe(400)
    expect(await bodyOf(r29)).toBe(
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
    // 30: unsupported protocolVersion → -32022 with data.supported
    const r30 = await post(
      fx.t,
      QVT,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: { _meta: env('2099-01-01') },
        id: 24,
      }),
      { 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Method': 'tools/list' },
    )
    expect(r30.status).toBe(400)
    expect(await bodyOf(r30)).toBe(
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

  test('tools/call error grammar: unknown tool, out-of-schema arg, uniform app refusal', async () => {
    const fx = await machineOrg()
    await mintToken(fx.t, fx.admin, QVT)
    // 19: unknown tool → protocol error at HTTP 200 (legacy)
    const r19 = await post(
      fx.t,
      QVT,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'does_not_exist', arguments: {} },
        id: 6,
      }),
    )
    expect(r19.status).toBe(200)
    expect(await bodyOf(r19)).toBe(
      frame(
        '{"jsonrpc":"2.0","id":6,"error":{"code":-32602,"message":"Tool does_not_exist not found"}}',
      ),
    )
    // 20: out-of-schema argument → isError with the SDK validation prefix (legacy)
    const r20 = await post(
      fx.t,
      QVT,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list_tasks', arguments: { project: 'USB', limit: 'abc' } },
        id: 7,
      }),
    )
    expect(await bodyOf(r20)).toBe(
      frame(
        '{"result":{"content":[{"type":"text","text":"Input validation error: Invalid arguments for tool list_tasks: limit: Invalid input: expected number, received string"}],"isError":true},"jsonrpc":"2.0","id":7}',
      ),
    )
    // 17: app refusal is the BARE sentence (legacy)
    const r17 = await post(
      fx.t,
      QVT,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get_task', arguments: { ref: 'QN-999999' } },
        id: 4,
      }),
    )
    expect(await bodyOf(r17)).toBe(
      frame(
        '{"result":{"content":[{"type":"text","text":"task \\"QN-999999\\" not found (or not visible to you)"}],"isError":true},"jsonrpc":"2.0","id":4}',
      ),
    )
    // 25: the modern isError still carries resultType + serverInfo _meta
    const r25 = await post(
      fx.t,
      QVT,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get_task', arguments: { ref: 'QN-999999' }, _meta: env() },
        id: 2,
      }),
      { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'get_task' },
    )
    expect(r25.status).toBe(200)
    expect(await bodyOf(r25)).toBe(
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
    // 39: modern out-of-schema arg keeps the modern result fields
    const r39 = await post(
      fx.t,
      QVT,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list_tasks', arguments: { project: 'USB', limit: 'abc' }, _meta: env() },
        id: 27,
      }),
      {
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'list_tasks',
      },
    )
    expect(await bodyOf(r39)).toBe(
      JSON.stringify({
        result: {
          content: [
            {
              type: 'text',
              text: 'Input validation error: Invalid arguments for tool list_tasks: limit: Invalid input: expected number, received string',
            },
          ],
          isError: true,
          resultType: 'complete',
          _meta: SERVER_META,
        },
        jsonrpc: '2.0',
        id: 27,
      }),
    )
  })

  test('a qva_ agent key drives a full modern write round trip, provenance signed', async () => {
    const fx = await machineOrg()
    await mintKey(fx.t, fx.agent, QVA)
    await drainActivity(fx.t)
    const res = await post(
      fx.t,
      QVA,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'create_task',
          arguments: { project: fx.meta.key, sub_project: fx.sub.key, title: 'Wire round trip' },
          _meta: env(),
        },
        id: 9,
      }),
      {
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'create_task',
      },
    )
    expect(res.status).toBe(200)
    const rpc = parse(await bodyOf(res)) as {
      result: { content: { text: string }[]; isError?: boolean }
    }
    expect(rpc.result.isError).toBeUndefined()
    const out = parse(rpc.result.content[0].text) as { id: string; key: string }
    expect(out.key).toMatch(/^QN-\d+$/)
    // the 2-space pretty body and its key order are the wire
    expect(rpc.result.content[0].text).toBe(`{\n  "id": "${out.id}",\n  "key": "${out.key}"\n}`)
    const commentRes = await post(
      fx.t,
      QVA,
      legacyBody(
        'tools/call',
        {
          name: 'add_comment',
          arguments: { ref: out.key, body: 'Wire task comment' },
          _meta: env(),
        },
        10,
      ),
      {
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'add_comment',
      },
    )
    expect(commentRes.status).toBe(200)
    const commentRpc = JSON.parse(await bodyOf(commentRes))
    expect(commentRpc.result.isError).toBeUndefined()
    const comment = JSON.parse(commentRpc.result.content[0].text)
    expect(comment).toEqual({
      id: expect.any(String),
      task: out.key,
      created_at: expect.any(String),
    })
    const events = await activityFor(fx.t, fx.org.id)
    expect(events).toHaveLength(1)
    expect(events[0].verb).toBe('created')
    expect(events[0].detail).toBe('via MCP')
    expect(events[0].actor_id).toBe(fx.agent.id)
    // per-call stamp on the key
    const key = await fx.t.run(
      async (ctx) =>
        await ctx.db
          .query('agent_keys')
          .withIndex('by_profile', (q) => q.eq('profile_id', fx.agent.id))
          .first(),
    )
    expect(key?.last_used_at).toBeDefined()
  })
})

/* --------------------------------------------------------- tools: reads */

describe('read tools', () => {
  test('list_teams / list_projects / list_users shapes and key order', async () => {
    const fx = await machineOrg()
    const teams = JSON.parse(
      await fx.t.query(internal.machine.mcp.listTeams, { callerId: fx.admin.id }),
    )
    expect(teams).toEqual([{ id: fx.team.id, name: 'Hardware' }])

    // guest reads only the granted meta tree; admin reads all four
    const guestProjects = JSON.parse(
      await fx.t.query(internal.machine.mcp.listProjects, { callerId: fx.guest.id }),
    ) as Record<string, unknown>[]
    expect(guestProjects.map((p) => p.key)).toEqual(['FW', 'PCB', 'TBED'])
    expect(Object.keys(guestProjects[0])).toEqual([
      'id',
      'key',
      'num',
      'name',
      'type',
      'parent_id',
      'team_id',
      'description',
      'archived_at',
    ])
    expect(guestProjects[0].archived_at).toBeNull() // explicit null, never omitted
    const adminProjects = JSON.parse(
      await fx.t.query(internal.machine.mcp.listProjects, { callerId: fx.admin.id }),
    ) as Record<string, unknown>[]
    expect(adminProjects.map((p) => p.key)).toEqual(['FW', 'PCB', 'SKNK', 'TBED'])

    const users = JSON.parse(
      await fx.t.query(internal.machine.mcp.listUsers, { callerId: fx.agent.id }),
    ) as Record<string, unknown>[]
    const agentRow = users.find((u) => u.id === fx.agent.id)
    expect(agentRow).toBeDefined()
    expect(agentRow?.plannable_hours).toBeNull() // null for an agent, never 0
    expect(Object.keys(users[0])).toEqual([
      'id',
      'name',
      'org_role',
      'kind',
      'active',
      'plannable_hours',
    ])
    expect('email' in (users[0] as object)).toBe(false)
  })

  test('list_project_users returns only visible real profiles and marks assignability', async () => {
    const fx = await machineOrg()
    const inactive = await plantSeat(fx.t, {
      org_id: fx.org.id,
      name: 'Inactive reporter',
      active: false,
    })
    const noAccess = await plantSeat(fx.t, { org_id: fx.org.id, name: 'No access' })
    await grant(fx.t, fx.meta.id, inactive.id, 'viewer')

    const rows = JSON.parse(
      await fx.t.query(internal.machine.mcp.listProjectUsers, {
        callerId: fx.agent.id,
        project: 'FW',
      }),
    ) as Record<string, unknown>[]
    expect(rows.map((row) => row.name)).toEqual([
      'admin',
      'guest',
      'Inactive reporter',
      'Relay',
      'user',
      'viewer',
    ])
    expect(rows.some((row) => row.id === noAccess.id)).toBe(false)
    expect(Object.keys(rows[0])).toEqual([
      'id',
      'name',
      'org_role',
      'kind',
      'active',
      'plannable_hours',
      'assignable',
    ])
    expect(rows.find((row) => row.id === inactive.id)?.assignable).toBe(false)
    expect(rows.find((row) => row.id === fx.viewer.id)?.assignable).toBe(false)
    expect(rows.find((row) => row.id === fx.agent.id)?.assignable).toBe(true)

    await expectRefusal(
      fx.t.query(internal.machine.mcp.listProjectUsers, {
        callerId: fx.agent.id,
        project: 'SKNK',
      }),
      'not_found',
      /^project "SKNK" not found \(or not visible to you\)$/,
    )
  })

  test('list_tasks search matches every partial word in any order across ID, title and description', async () => {
    const fx = await machineOrg()
    const task = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      title: 'Add signed firmware updates and rollback',
      description: 'Release recovery checklist',
    })
    await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      title: 'Add mobile updates',
    })
    for (const search of [
      'signed firm',
      'upd firm',
      'add back',
      'add rollback',
      'and add sign',
      '  BACK\tSIGN ',
      `qn-${task.num} firm`,
      'recovery firm',
      'signed mobile',
      'roll*back',
    ]) {
      const rows = JSON.parse(
        await fx.t.query(internal.machine.mcp.listIssues, { callerId: fx.guest.id, search }),
      ) as { id: string }[]
      expect(
        rows.map((row) => row.id),
        search,
      ).toEqual(search === 'signed mobile' || search === 'roll*back' ? [] : [task.id])
    }
  })

  test('list_tasks: scope expansion, filters, uniform refusal, projection', async () => {
    const fx = await machineOrg()
    const i1 = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      title: 'Alpha widget',
      assignee_id: fx.user.id,
      reporter_id: fx.viewer.id,
      created_by: fx.agent.id,
    })
    const i2 = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub2.id,
      title: 'Beta gadget',
      status: 'done',
    })
    const i3 = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.hidden.id,
      title: 'Sneaky task',
    })
    const i4 = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      title: 'Old thing',
      archived_at: NOW,
    })
    const list = async (callerId: string, args: Record<string, unknown> = {}) =>
      JSON.parse(
        await fx.t.query(internal.machine.mcp.listIssues, { callerId, ...args }),
      ) as Record<string, unknown>[]
    // no scope: everything readable, active only — order by project key then num
    expect((await list(fx.admin.id)).map((i) => i.title)).toEqual([
      'Alpha widget',
      'Beta gadget',
      'Sneaky task',
    ])
    expect((await list(fx.guest.id)).map((i) => i.title)).toEqual(['Alpha widget', 'Beta gadget'])
    // meta scope expands to its subs — by key, num or uuid ref
    for (const ref of [fx.meta.key, String(fx.meta.num), fx.meta.id, fx.meta.id.toUpperCase()]) {
      expect((await list(fx.guest.id, { project: ref })).map((i) => i.id)).toEqual([i1.id, i2.id])
    }
    // sub scope stays put
    expect((await list(fx.guest.id, { project: 'FW' })).map((i) => i.id)).toEqual([i1.id])
    // archived axis
    expect((await list(fx.guest.id, { project: 'FW', archived: true })).map((i) => i.id)).toEqual([
      i4.id,
    ])
    // filters
    expect((await list(fx.guest.id, { status: 'done' })).map((i) => i.id)).toEqual([i2.id])
    expect((await list(fx.guest.id, { assignee_id: fx.user.id })).map((i) => i.id)).toEqual([i1.id])
    expect(
      (await list(fx.guest.id, { assignee_id: fx.user.id.toUpperCase() })).map((i) => i.id),
    ).toEqual([i1.id])
    expect((await list(fx.guest.id, { search: 'alpha' })).map((i) => i.id)).toEqual([i1.id])
    expect(await list(fx.guest.id, { search: '*' })).toEqual([]) // no wildcard on MCP
    expect((await list(fx.guest.id, { limit: 1 })).map((i) => i.id)).toEqual([i1.id])
    // the uniform refusal: nonexistent, invisible, foreign — one sentence shape
    for (const [caller, ref] of [
      [fx.admin.id, 'NOPE'],
      [fx.guest.id, 'SKNK'],
      [fx.guest.id, 'OTH'],
    ] as const) {
      await expectRefusal(
        fx.t.query(internal.machine.mcp.listIssues, { callerId: caller, project: ref }),
        'not_found',
        new RegExp(`^project "${ref}" not found \\(or not visible to you\\)$`),
      )
    }
    // projection: MCP subset with explicit nulls, project named
    const row = (await list(fx.guest.id, { project: 'FW' }))[0]
    expect(Object.keys(row)).toEqual([
      'id',
      'key',
      'num',
      'title',
      'description',
      'status',
      'is_group',
      'priority',
      'assignee_id',
      'assignee_name',
      'reviewer_id',
      'reviewer_name',
      'reporter_id',
      'reporter_name',
      'project_id',
      'project_key',
      'project_num',
      'project_name',
      'due_date',
      'remaining_hours',
      'remaining_set_at',
      'paused',
      'archived_at',
      'created_at',
      'updated_at',
    ])
    expect(row.key).toBe(`QN-${i1.num}`)
    expect(row.project_name).toBe('Firmware')
    expect(row.assignee_name).toBe('user')
    expect(row.reporter_id).toBe(fx.viewer.id)
    expect(row.reporter_name).toBe('viewer')
    expect(row).not.toHaveProperty('creator_id')
    expect(row).not.toHaveProperty('creator_name')
    expect(row.due_date).toBeNull()
    expect(row.remaining_hours).toBeNull()
    expect(row.archived_at).toBeNull()
    void i3
  })

  test('get_task: every ref grammar, archived resolution, uniform refusal', async () => {
    const fx = await machineOrg()
    const i1 = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      title: 'Reachable',
    })
    const hiddenIssue = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.hidden.id,
      title: 'Hidden',
    })
    const archived = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      title: 'Put away',
      archived_at: NOW,
    })
    const foreign = await plantIssue(fx.t, {
      org_id: fx.otherOrg.id,
      project_id: fx.otherProject.id,
      title: 'Foreign',
    })
    const get = async (callerId: string, ref: string) =>
      JSON.parse(await fx.t.query(internal.machine.mcp.getIssue, { callerId, ref })) as Record<
        string,
        unknown
      >
    for (const ref of [
      `QN-${i1.num}`,
      `qn-${i1.num}`,
      String(i1.num),
      i1.id,
      i1.id.toUpperCase(),
    ]) {
      expect((await get(fx.guest.id, ref)).id).toBe(i1.id)
    }
    expect((await get(fx.guest.id, String(archived.num))).archived_at).toBe(NOW)
    for (const ref of [`QN-999999`, String(hiddenIssue.num), foreign.id, 'QN-3000000000', 'xyz']) {
      await expectRefusal(
        fx.t.query(internal.machine.mcp.getIssue, { callerId: fx.guest.id, ref }),
        'not_found',
        new RegExp(
          `^task "${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" not found \\(or not visible to you\\)$`,
        ),
      )
    }
  })

  test('list_comments: oldest first, MCP projection, uniform refusal', async () => {
    const fx = await machineOrg()
    const i1 = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      title: 'Discussed',
    })
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: i1.id,
        author: fx.user.id,
        body: 'second',
        created_at: '2026-01-02T00:00:00.000Z',
      })
      await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: i1.id,
        author: fx.admin.id,
        body: 'first',
        created_at: '2026-01-01T00:00:00.000Z',
      })
    })
    const rows = JSON.parse(
      await fx.t.query(internal.machine.mcp.listComments, {
        callerId: fx.guest.id,
        ref: `QN-${i1.num}`,
      }),
    ) as Record<string, unknown>[]
    expect(rows.map((c) => c.body)).toEqual(['first', 'second'])
    expect(rows[0].author_name).toBe('admin')
    expect(Object.keys(rows[0])).toEqual([
      'id',
      'body',
      'author_id',
      'author_name',
      'created_at',
      'edited_at',
      'edited_by_id',
      'edited_by_name',
    ])
    expect('issue_id' in (rows[0] as object)).toBe(false)
    await expectRefusal(
      fx.t.query(internal.machine.mcp.listComments, { callerId: fx.guest.id, ref: 'QN-999999' }),
      'not_found',
      /^task "QN-999999" not found \(or not visible to you\)$/,
    )
  })
})

/* -------------------------------------------------------- tools: writes */

describe('write tools', () => {
  test('add_comment: server id, subscription parity, blank and write refusals', async () => {
    const fx = await machineOrg()
    const i1 = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'Thread' })
    await plantSubscription(fx.t, { issue_id: i1.id, profile_id: fx.user.id })
    const out = JSON.parse(
      await fx.t.mutation(internal.machine.mcp.addComment, {
        callerId: fx.agent.id,
        ref: `QN-${i1.num}`,
        body: '  hello from the machine  ',
      }),
    ) as { id: string; task: string; created_at: string }
    expect(out.task).toBe(`QN-${i1.num}`)
    expect(Object.keys(out)).toEqual(['id', 'task', 'created_at'])
    const stored = await fx.t.run(
      async (ctx) =>
        await ctx.db
          .query('comments')
          .withIndex('by_issue', (q) => q.eq('issue_id', i1.id))
          .collect(),
    )
    expect(stored).toHaveLength(1)
    expect(stored[0].id).toBe(out.id)
    expect(stored[0].author).toBe(fx.agent.id) // pinned to the caller
    expect(stored[0].body).toBe('hello from the machine') // trimmed
    // 0114 parity: the author subscribed; the prior subscriber read 'New comment'
    const subs = await fx.t.run(
      async (ctx) =>
        await ctx.db
          .query('issue_subscriptions')
          .withIndex('by_issue', (q) => q.eq('issue_id', i1.id))
          .collect(),
    )
    expect(subs.map((s) => s.profile_id).sort()).toEqual([fx.agent.id, fx.user.id].sort())
    const inbox = await messagesFor(fx.t, fx.user.id, i1.id)
    expect(inbox).toHaveLength(1)
    expect(inbox[0].detail).toBe('New comment')
    expect(inbox[0].actor_id).toBe(fx.agent.id)
    // comments write NO activity row
    expect(await activityFor(fx.t, fx.org.id)).toHaveLength(0)
    // blank body — machine wording
    await expectRefusal(
      fx.t.mutation(internal.machine.mcp.addComment, {
        callerId: fx.agent.id,
        ref: `QN-${i1.num}`,
        body: '   ',
      }),
      'bad_request',
      /^comment body must not be blank$/,
    )
    // a viewer-grant agent reads the thread but cannot write to it
    const viewerAgent = await plantAgent(fx.t, fx.org.id)
    await grant(fx.t, fx.meta.id, viewerAgent.id, 'viewer')
    await expectRefusal(
      fx.t.mutation(internal.machine.mcp.addComment, {
        callerId: viewerAgent.id,
        ref: `QN-${i1.num}`,
        body: 'hi',
      }),
      'forbidden',
      /^your account has no write access to that project$/,
    )
    // invisible issue — the uniform sentence, not the write refusal
    const hiddenIssue = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.hidden.id,
      title: 'H',
    })
    await expectRefusal(
      fx.t.mutation(internal.machine.mcp.addComment, {
        callerId: fx.agent.id,
        ref: hiddenIssue.id,
        body: 'hi',
      }),
      'not_found',
      /not found \(or not visible to you\)$/,
    )
  })

  test('create_task: happy path, MCP guard order, viewer-agent refusals', async () => {
    const fx = await machineOrg()
    await drainActivity(fx.t)
    type CreateWire = {
      project: string
      sub_project?: string
      title?: string
      assignee_id?: string | null
      archived?: boolean
    }
    const create = (callerId: string, args: CreateWire) =>
      fx.t.mutation(internal.machine.mcp.createIssue, { callerId, title: 'Machine task', ...args })
    // happy: meta + sub_project
    const out = JSON.parse(await create(fx.agent.id, { project: 'TBED', sub_project: 'FW' })) as {
      id: string
      key: string
    }
    expect(out.key).toMatch(/^QN-\d+$/)
    const row = await fx.t.run(
      async (ctx) =>
        await ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', out.id))
          .unique(),
    )
    expect(row?.project_id).toBe(fx.sub.id)
    expect(row?.created_by).toBe(fx.agent.id)
    const events = await activityFor(fx.t, fx.org.id)
    expect(events).toHaveLength(1)
    expect(events[0].verb).toBe('created')
    expect(events[0].detail).toBe('via MCP') // detail is exactly the provenance
    expect(events[0].label).toBe('Machine task')
    // direct sub ref works too
    const direct = JSON.parse(await create(fx.agent.id, { project: 'PCB' })) as { id: string }
    const directRow = await fx.t.run(
      async (ctx) =>
        await ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', direct.id))
          .unique(),
    )
    expect(directRow?.project_id).toBe(fx.sub2.id)
    // bare meta → metaNeedsSub over live writable kids
    await expectRefusal(
      create(fx.agent.id, { project: 'TBED' }),
      'bad_request',
      /^TBED is a project — tasks live in its sub-projects; pass sub_project \(one of: FW, PCB\)$/,
    )
    // archived arg is refused FIRST — before any other validation
    await expectRefusal(
      create(fx.agent.id, { project: 'NOPE', title: '', archived: false }),
      'bad_request',
      /^tasks are created active — archive with update_task after creating$/,
    )
    // blank title fires before the project lookup
    await expectRefusal(
      create(fx.agent.id, { project: 'NOPE', title: '  ' }),
      'bad_request',
      /^title must not be blank$/,
    )
    // unknown / invisible project — the uniform sentence
    await expectRefusal(
      create(fx.agent.id, { project: 'SKNK' }),
      'not_found',
      /^project "SKNK" not found \(or not visible to you\)$/,
    )
    // empty sub_project is a caller bug, not "no sub_project"
    await expectRefusal(
      create(fx.agent.id, { project: 'TBED', sub_project: '' }),
      'bad_request',
      /^sub_project must name a sub-project by key, number or uuid$/,
    )
    // a foreign/invisible sub reads exactly like an unknown one (no oracle)
    await expectRefusal(
      create(fx.agent.id, { project: 'TBED', sub_project: 'ZZZ' }),
      'bad_request',
      /^sub_project must name a sub-project by key, number or uuid$/,
    )
    // a readable sub of ANOTHER meta → the pair rule
    const sub3 = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.hidden.id,
      key: 'XSUB',
    })
    await expectRefusal(
      fx.t.mutation(internal.machine.mcp.createIssue, {
        callerId: fx.admin.id,
        title: 'Cross pair',
        project: 'TBED',
        sub_project: 'XSUB',
      }),
      'bad_request',
      /^sub-project XSUB does not belong to project TBED — tasks are never created under another project's sub-project$/,
    )
    void sub3
    // an archived meta answers "archived", never "no sub-projects yet"
    await plantProject(fx.t, {
      org_id: fx.org.id,
      key: 'ARCM',
      archived_at: NOW,
      team_id: fx.team.id,
    })
    await expectRefusal(
      fx.t.mutation(internal.machine.mcp.createIssue, {
        callerId: fx.admin.id,
        title: 'X',
        project: 'ARCM',
      }),
      'bad_request',
      /^ARCM is archived — restore it in the app before adding tasks to it$/,
    )
    // assignee guard order: readable machine sentences
    await expectRefusal(
      create(fx.agent.id, { project: 'FW', assignee_id: fx.viewer.id }),
      'bad_request',
      new RegExp(
        `^user "${fx.viewer.id}" is a viewer — a viewer reads the projects they are added to and is never assigned work$`,
      ),
    )
    await expectRefusal(
      create(fx.agent.id, { project: 'FW', assignee_id: fx.otherAdmin.id }),
      'bad_request',
      new RegExp(`^user "${fx.otherAdmin.id}" not found in your organization$`),
    )
    // the 0102 pair: a grant-viewer agent AND an org-role-viewer agent holding
    // a user grant both write nothing
    const grantViewer = await plantAgent(fx.t, fx.org.id)
    await grant(fx.t, fx.meta.id, grantViewer.id, 'viewer')
    const roleViewer = await plantAgent(fx.t, fx.org.id, { org_role: 'viewer' })
    await grant(fx.t, fx.meta.id, roleViewer.id, 'user')
    for (const caller of [grantViewer, roleViewer]) {
      await expectRefusal(
        create(caller.id, { project: 'FW' }),
        'forbidden',
        /^your account has no write access to that project$/,
      )
    }
  })

  test('reporter attribution is chosen only at creation and requires project access', async () => {
    const fx = await machineOrg()
    const noAccess = await plantSeat(fx.t, { org_id: fx.org.id, name: 'No project access' })
    const create = async (reporter_id?: string) =>
      JSON.parse(
        await fx.t.mutation(internal.machine.mcp.createIssue, {
          callerId: fx.agent.id,
          project: 'FW',
          title: 'Imported task',
          ...(reporter_id === undefined ? {} : { reporter_id }),
        }),
      ) as { id: string; key: string }
    const get = async (ref: string) =>
      JSON.parse(
        await fx.t.query(internal.machine.mcp.getIssue, { callerId: fx.agent.id, ref }),
      ) as Record<string, unknown>

    const defaulted = await create()
    expect(await get(defaulted.key)).toMatchObject({
      reporter_id: fx.agent.id,
      reporter_name: 'Relay',
    })
    // A viewer with destination access is a valid reporter, even when inactive.
    await fx.t.run(async (ctx) => {
      await ctx.db.patch(fx.viewer._id, { active: false })
    })
    const selected = await create(fx.viewer.id.toUpperCase())
    const selectedRow = await get(selected.key)
    expect(selectedRow).toMatchObject({ reporter_id: fx.viewer.id, reporter_name: 'viewer' })
    expect(selectedRow).not.toHaveProperty('creator_id')
    expect(selectedRow).not.toHaveProperty('creator_name')
    const activity = await activityFor(fx.t, fx.org.id)
    expect(activity.find((row) => row.target_id === selected.id)?.actor_id).toBe(fx.agent.id)

    for (const [reporter, message] of [
      [noAccess.id, `user "${noAccess.id}" has no access to this project`],
      [fx.otherAdmin.id, `user "${fx.otherAdmin.id}" not found in your organization`],
      [
        '00000000-0000-0000-0000-000000000000',
        'user "00000000-0000-0000-0000-000000000000" not found in your organization',
      ],
    ]) {
      await expectRefusal(
        fx.t.mutation(internal.machine.mcp.createIssue, {
          callerId: fx.agent.id,
          project: 'FW',
          title: 'Refused import',
          reporter_id: reporter,
        }),
        'bad_request',
        new RegExp(`^${message}$`),
      )
    }
    expect(await activityFor(fx.t, fx.org.id)).toEqual(activity)

    // Exercise the transport so an unsupported reporter argument cannot be
    // stripped before an otherwise-valid update reaches the mutation.
    await mintKey(fx.t, fx.agent, QVA)
    await plantSubscription(fx.t, { issue_id: selected.id, profile_id: fx.user.id })
    for (const modern of [false, true]) {
      const headers = (name: string): Record<string, string> =>
        modern
          ? { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': name }
          : {}
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await post(
          fx.t,
          QVA,
          legacyBody(
            'tools/call',
            {
              name,
              arguments: args,
              ...(modern ? { _meta: env() } : {}),
            },
            51,
          ),
          headers(name),
        )
        expect(response.status).toBe(200)
        const body = await bodyOf(response)
        return JSON.parse(modern ? body : body.slice('event: message\ndata: '.length, -2)).result
      }
      const nullReporter = await call('create_task', {
        project: 'FW',
        title: 'Refused null',
        reporter_id: null,
      })
      expect(nullReporter.isError).toBe(true)
      expect(nullReporter.content[0].text).toBe(
        'Input validation error: Invalid arguments for tool create_task: reporter_id: Invalid input: expected string, received null',
      )
      for (const reporter_id of [fx.user.id, fx.viewer.id, null, 'nope']) {
        const refused = await call('update_task', {
          ref: selected.key,
          reporter_id,
          title: 'Must not change',
          archived: true,
        })
        expect(refused.isError).toBe(true)
        expect(refused.content[0].text).toBe(
          'Input validation error: Invalid arguments for tool update_task: reporter_id: reporter_id is set when a task is created and cannot be changed',
        )
        expect(await get(selected.key)).toEqual(selectedRow)
      }
    }
    expect(await activityFor(fx.t, fx.org.id)).toEqual(activity)
    expect(await messagesFor(fx.t, fx.user.id, selected.id)).toEqual([])
    const rows = JSON.parse(
      await fx.t.query(internal.machine.mcp.listIssues, { callerId: fx.agent.id }),
    ) as unknown[]
    expect(rows).toHaveLength(2)
  })

  test('update_task: the folded PATCH+archive — one write, one fan-out, one row', async () => {
    const fx = await machineOrg()
    const p1 = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      title: 'Parent job',
      status: 'todo',
    })
    const c1 = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      title: 'Child job',
      parent_id: p1.id,
    })
    await plantSubscription(fx.t, { issue_id: p1.id, profile_id: fx.user.id })
    await plantSubscription(fx.t, { issue_id: c1.id, profile_id: fx.admin.id })
    await drainActivity(fx.t)
    const out = JSON.parse(
      await fx.t.mutation(internal.machine.mcp.updateIssue, {
        callerId: fx.agent.id,
        ref: `QN-${p1.num}`,
        priority: 'high',
        archived: true,
      }),
    ) as { id: string; key: string; updated: string[] }
    expect(out).toEqual({ id: p1.id, key: `QN-${p1.num}`, updated: ['priority', 'archived_at'] })
    // ONE activity row: the toggle verb wins, the diff + provenance narrate
    const events = await activityFor(fx.t, fx.org.id)
    expect(events).toHaveLength(1)
    expect(events[0].verb).toBe('archived')
    expect(events[0].detail).toBe('(priority Medium → High) — via MCP')
    expect(events[0].actor_id).toBe(fx.agent.id)
    // ONE message to the subscriber, carrying the field line AND the toggle line
    const inbox = await messagesFor(fx.t, fx.user.id, p1.id)
    expect(inbox).toHaveLength(1)
    expect(inbox[0].detail).toBe('Priority: Medium → High. Archived')
    // the descendant is stamped but never notified
    const c1After = await fx.t.run(
      async (ctx) =>
        await ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', c1.id))
          .unique(),
    )
    expect(c1After?.archived_at).toBeDefined()
    expect(await messagesFor(fx.t, fx.admin.id, c1.id)).toHaveLength(0)
    // restore from the child: the ancestor chain surfaces, pure-toggle detail
    await drainActivity(fx.t)
    const restored = JSON.parse(
      await fx.t.mutation(internal.machine.mcp.updateIssue, {
        callerId: fx.agent.id,
        ref: String(c1.num),
        archived: false,
      }),
    ) as { updated: string[] }
    expect(restored.updated).toEqual(['archived_at'])
    const restoreEvents = await activityFor(fx.t, fx.org.id)
    expect(restoreEvents).toHaveLength(1)
    expect(restoreEvents[0].verb).toBe('restored')
    expect(restoreEvents[0].detail).toBe('via MCP')
    const p1After = await fx.t.run(
      async (ctx) =>
        await ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', p1.id))
          .unique(),
    )
    expect(p1After?.archived_at).toBeUndefined()
  })

  test('reviewer_id: written and read back, echoed alone; the review time lands unechoed; View-only refused before the write gate', async () => {
    const fx = await machineOrg()
    const task = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      title: 'Needs eyes',
      status: 'progress',
      remaining_hours: 6,
      remaining_set_at: NOW,
    })
    const update = async (args: { reviewer_id?: string | null; status?: 'review' }) =>
      (
        JSON.parse(
          await fx.t.mutation(internal.machine.mcp.updateIssue, {
            callerId: fx.agent.id,
            ref: task.id,
            ...args,
          }),
        ) as { updated: string[] }
      ).updated
    const get = async () =>
      JSON.parse(
        await fx.t.query(internal.machine.mcp.getIssue, { callerId: fx.agent.id, ref: task.id }),
      ) as Record<string, unknown>
    expect(await update({ reviewer_id: fx.guest.id.toUpperCase() })).toEqual(['reviewer_id'])
    expect(await get()).toMatchObject({ reviewer_id: fx.guest.id, reviewer_name: 'guest' })
    expect(await update({ status: 'review' })).toEqual(['status'])
    const inReview = await get()
    expect(inReview).toMatchObject({ status: 'review', remaining_hours: 2 })
    expect(inReview.remaining_set_at).not.toBe(NOW)
    expect(await update({ reviewer_id: null })).toEqual(['reviewer_id'])
    expect(await get()).toMatchObject({ reviewer_id: null, reviewer_name: null })
    // guard order: the reviewer sentence answers before the write gate, so a
    // grant-viewer agent hears the same refusal as a writer
    const viewOnly = await plantSeat(fx.t, { org_id: fx.org.id, name: 'View only' })
    await grant(fx.t, fx.meta.id, viewOnly.id, 'viewer')
    const grantViewer = await plantAgent(fx.t, fx.org.id)
    await grant(fx.t, fx.meta.id, grantViewer.id, 'viewer')
    for (const caller of [fx.agent, grantViewer]) {
      await expectRefusal(
        fx.t.mutation(internal.machine.mcp.createIssue, {
          callerId: caller.id,
          project: 'FW',
          title: 'Refused review',
          reviewer_id: viewOnly.id,
        }),
        'bad_request',
        new RegExp(
          `^user "${viewOnly.id}" needs Edit permission or higher on this project to review work$`,
        ),
      )
    }
  })

  test('update_task: no-op archive, empty patch, guards, refusals', async () => {
    const fx = await machineOrg()
    const i1 = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'Steady' })
    const parent = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      title: 'Has kids',
    })
    await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      title: 'Kid',
      parent_id: parent.id,
    })
    await drainActivity(fx.t)
    // archived matching the current state: clean no-op, updated: [], NO narration
    const noop = JSON.parse(
      await fx.t.mutation(internal.machine.mcp.updateIssue, {
        callerId: fx.agent.id,
        ref: `QN-${i1.num}`,
        archived: false,
      }),
    ) as { updated: string[] }
    expect(noop.updated).toEqual([])
    expect(await activityFor(fx.t, fx.org.id)).toHaveLength(0)
    // nothing at all → the MCP sentence (differs from REST's wording)
    await expectRefusal(
      fx.t.mutation(internal.machine.mcp.updateIssue, {
        callerId: fx.agent.id,
        ref: `QN-${i1.num}`,
      }),
      'bad_request',
      /^no fields to update$/,
    )
    // remaining pre-check fires on any non-null — machine wording, before the write gate
    await expectRefusal(
      fx.t.mutation(internal.machine.mcp.updateIssue, {
        callerId: fx.agent.id,
        ref: `QN-${parent.num}`,
        remaining_hours: 4,
      }),
      'bad_request',
      /^remaining_hours cannot be set on a task with subtasks — it is the sum of their remaining time$/,
    )
    // assignee guard, machine sentences
    await expectRefusal(
      fx.t.mutation(internal.machine.mcp.updateIssue, {
        callerId: fx.agent.id,
        ref: `QN-${i1.num}`,
        assignee_id: fx.viewer.id,
      }),
      'bad_request',
      /is a viewer — a viewer reads the projects they are added to and is never assigned work$/,
    )
    // the viewer-agent write refusal
    const grantViewer = await plantAgent(fx.t, fx.org.id)
    await grant(fx.t, fx.meta.id, grantViewer.id, 'viewer')
    await expectRefusal(
      fx.t.mutation(internal.machine.mcp.updateIssue, {
        callerId: grantViewer.id,
        ref: `QN-${i1.num}`,
        title: 'New',
      }),
      'forbidden',
      /^your account has no write access to that project$/,
    )
    // the uniform not-found
    await expectRefusal(
      fx.t.mutation(internal.machine.mcp.updateIssue, {
        callerId: fx.agent.id,
        ref: 'QN-424242',
        title: 'X',
      }),
      'not_found',
      /^task "QN-424242" not found \(or not visible to you\)$/,
    )
  })

  test('delete_task: deep delete + provenance row; refusals', async () => {
    const fx = await machineOrg()
    const i1 = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'Doomed' })
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: i1.id,
        author: fx.user.id,
        body: 'gone too',
        created_at: NOW,
      })
    })
    await drainActivity(fx.t)
    const out = JSON.parse(
      await fx.t.mutation(internal.machine.mcp.deleteIssue, { callerId: fx.agent.id, ref: i1.id }),
    ) as { deleted: boolean; key: string }
    expect(out).toEqual({ deleted: true, key: `QN-${i1.num}` })
    const remains = await fx.t.run(async (ctx) => ({
      issue: await ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', i1.id))
        .unique(),
      comments: await ctx.db
        .query('comments')
        .withIndex('by_issue', (q) => q.eq('issue_id', i1.id))
        .collect(),
    }))
    expect(remains.issue).toBeNull()
    expect(remains.comments).toEqual([])
    const events = await activityFor(fx.t, fx.org.id)
    expect(events).toHaveLength(1)
    expect(events[0].verb).toBe('deleted')
    expect(events[0].detail).toBe('via MCP')
    expect(events[0].label).toBe('Doomed')
    // refusals
    const grantViewer = await plantAgent(fx.t, fx.org.id)
    await grant(fx.t, fx.meta.id, grantViewer.id, 'viewer')
    const i2 = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'Safe' })
    await expectRefusal(
      fx.t.mutation(internal.machine.mcp.deleteIssue, { callerId: grantViewer.id, ref: i2.id }),
      'forbidden',
      /^your account has no write access to that project$/,
    )
    await expectRefusal(
      fx.t.mutation(internal.machine.mcp.deleteIssue, { callerId: fx.agent.id, ref: 'QN-999999' }),
      'not_found',
      /^task "QN-999999" not found \(or not visible to you\)$/,
    )
  })

  test('update_user: rights, agent fence, range, roster answer', async () => {
    const fx = await machineOrg()
    const set = (callerId: string, user_id: string, plannable_hours: number) =>
      fx.t.mutation(internal.machine.mcp.updateUser, { callerId, user_id, plannable_hours })
    // an org admin may set anyone's hours; the fresh row comes back, a NUMBER
    const out = JSON.parse(await set(fx.admin.id, fx.user.id, 35)) as Record<string, unknown>
    expect(out).toEqual({
      id: fx.user.id,
      name: 'user',
      org_role: 'user',
      kind: 'person',
      active: true,
      plannable_hours: 35,
    })
    // a leader of the person's team may too (user leads Hardware; admin is a member)
    expect(
      (JSON.parse(await set(fx.user.id, fx.admin.id, 33)) as Record<string, unknown>)
        .plannable_hours,
    ).toBe(33)
    // nobody else — one sentence for unknown/foreign/unauthorized
    for (const caller of [fx.viewer.id, fx.guest.id]) {
      await expectRefusal(
        set(caller, fx.user.id, 30),
        'rule',
        /^only an organization admin or a leader of one of this person's teams can set their plannable hours$/,
      )
    }
    // a foreign uuid answers "not found", learning nothing
    await expectRefusal(
      set(fx.admin.id, fx.otherAdmin.id, 30),
      'bad_request',
      new RegExp(`^user "${fx.otherAdmin.id}" not found in your organization$`),
    )
    // an agent has no plannable week — the readable pre-check sentence
    await expectRefusal(
      set(fx.admin.id, fx.agent.id, 30),
      'bad_request',
      new RegExp(
        `^user "${fx.agent.id}" is an agent — an agent has no plannable week, its capacity is unbounded$`,
      ),
    )
    // the whole-hours range rule (wire zod catches 0..168 first; the model
    // sentence stands for anything that slips past)
    await expectRefusal(
      set(fx.admin.id, fx.user.id, 169),
      'rule',
      /^plannable hours must be a whole number of hours from 1 to 168$/,
    )
    // no activity row for capacity changes
    expect(await activityFor(fx.t, fx.org.id)).toHaveLength(0)
  })

  test('the auth-to-dispatch race: a caller deactivated after auth is refused', async () => {
    const fx = await machineOrg()
    await fx.t.run(async (ctx) => {
      const rows = await ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', fx.agent.id))
        .collect()
      await ctx.db.patch(rows[0]._id, { active: false })
    })
    const err = await expectRefusal(
      fx.t.query(internal.machine.mcp.listTeams, { callerId: fx.agent.id }),
      'forbidden',
      /^this agent has been deactivated$/,
    )
    expect(err.data.reason).toBe('caller_deactivated')
  })
})

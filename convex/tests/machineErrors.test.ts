/* A REST or MCP failure that is no refusal, such as a Convex read limit,
 * answers the caller with INTERNAL_ERROR and never the error's own text,
 * which can name source files and hold a stack trace
 * (machine/shared.ts internalError). The deployment's log keeps the error,
 * and refusals keep their sentences. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it, vi } from 'vitest'
import { badRequest } from '../lib/functions'
import { sha256hex } from '../machine/auth'
import { dispatchMcp } from '../machine/mcp'
import { ROUTES, route } from '../machine/rest'
import { INTERNAL_ERROR } from '../machine/shared'
import { NOW, newT, uuid, withOrg } from './helpers.setup'

const SECRET = `qva_${'internalerr'.repeat(4)}`

/* What Convex hands an HTTP action when a query it ran passed a limit. */
const LIMIT_FAILURE = new Error(
  'Uncaught Error: Too many bytes read in a single function execution (limit: 16777216 bytes).\n' +
    '    at async newestComments (../../convex/model/comments.ts:228:17)\n' +
    '    at async handler (../../convex/machine/rest.ts:797:13)',
)

afterEach(() => vi.restoreAllMocks())

describe('REST', () => {
  const added: typeof ROUTES = []
  afterEach(() => {
    for (const r of added.splice(0)) ROUTES.splice(ROUTES.indexOf(r), 1)
  })

  /* A route that fails with `error`, at /v1/failing/<name>. */
  const failing = (name: string, error: unknown) => {
    const r = route({
      method: 'GET',
      path: `failing/${name}`,
      access: 'read',
      status: 200,
      run: async () => {
        throw error
      },
    })
    ROUTES.push(r)
    added.push(r)
  }

  it('answers a failure that is no refusal with a generic 500 and logs it', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('agent_keys', {
        id: uuid(),
        profile_id: f.agent.id,
        name: 'Errors',
        key_prefix: SECRET.slice(0, 11),
        key_hash: await sha256hex(SECRET),
        created_at: NOW,
      })
    })
    failing('limit', LIMIT_FAILURE)
    failing('refusal', badRequest('a sentence for the caller'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const get = async (path: string) => {
      const res = await (
        t as unknown as {
          fetch(
            path: string,
            init: { headers: Record<string, string> },
          ): Promise<{ status: number; text(): Promise<string> }>
        }
      ).fetch(path, { headers: { Authorization: `Bearer ${SECRET}` } })
      return { status: res.status, json: JSON.parse(await res.text()) }
    }

    expect(await get('/v1/failing/limit')).toEqual({
      status: 500,
      json: { error: INTERNAL_ERROR },
    })
    expect(log).toHaveBeenCalledWith(LIMIT_FAILURE)
    expect(await get('/v1/failing/refusal')).toEqual({
      status: 400,
      json: { error: 'a sentence for the caller' },
    })
  })
})

describe('MCP', () => {
  /* One modern-leg tools/call of list_comments whose run throws `error`. */
  async function call(error: unknown) {
    const res = await dispatchMcp({
      headers: new Headers({
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'list_comments',
      }),
      bodyText: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'list_comments',
          arguments: { ref: 'QN-1' },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'errors', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
        id: 1,
      }),
      runTool: async () => {
        throw error
      },
    })
    expect(res.status).toBe(200)
    const { result } = JSON.parse(await res.text())
    return { text: result.content[0].text, isError: result.isError }
  }

  it('answers a tool failure that is no refusal with a generic error and logs it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await call(LIMIT_FAILURE)).toEqual({ text: INTERNAL_ERROR, isError: true })
    expect(log).toHaveBeenCalledWith(LIMIT_FAILURE)
    expect(await call(badRequest('a sentence for the caller'))).toEqual({
      text: 'a sentence for the caller',
      isError: true,
    })
  })
})

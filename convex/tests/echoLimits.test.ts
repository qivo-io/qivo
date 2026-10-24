/* REST and MCP refusals that repeat what the caller sent stay about as short
 * as the request (machine/shared.ts quotedNames and shownName, mcp.ts
 * echoed). A list of names shows at most NAMES_LISTED, each cut to
 * NAME_SHOWN_MAX characters, and says how many more there were. MCP echoes
 * an array or object by its kind, and refuses an id that is neither a
 * string, a number nor null. */

import { describe, expect, it } from 'vitest'
import { dispatchMcp } from '../machine/mcp'
import {
  NAME_SHOWN_MAX,
  NAMES_LISTED,
  refuseUnknownFields,
  refuseUnknownParams,
} from '../machine/shared'

const refusal = (refuse: () => void): string => {
  try {
    refuse()
  } catch (error) {
    return (error as { data: { message: string } }).data.message
  }
  throw new Error('no refusal')
}

const keys = (count: number) => Array.from({ length: count }, (_, i) => `k${i}`)
const listed = (count: number) =>
  keys(count)
    .map((key) => `"${key}"`)
    .join(', ')

describe('REST unknown names', () => {
  it('lists every unknown field of a few, as before', () => {
    expect(refusal(() => refuseUnknownFields({ k0: 1, k1: 2 }, ['title']))).toBe(
      `unknown fields ${listed(2)}; this request takes title`,
    )
  })

  it('lists the first unknown fields and parameters of many and counts the rest', () => {
    const body = Object.fromEntries(keys(500).map((key) => [key, 0]))
    expect(refusal(() => refuseUnknownFields(body, ['title']))).toBe(
      `unknown fields ${listed(NAMES_LISTED)} and ${500 - NAMES_LISTED} more; this request takes title`,
    )
    expect(refusal(() => refuseUnknownParams(keys(500), []))).toBe(
      `unknown query parameters ${listed(NAMES_LISTED)} and ${500 - NAMES_LISTED} more; this request takes no query parameters`,
    )
  })

  it('cuts a long unknown name', () => {
    const name = 'x'.repeat(100_000)
    expect(refusal(() => refuseUnknownFields({ [name]: 1 }, []))).toBe(
      `unknown field "${'x'.repeat(NAME_SHOWN_MAX)}…"; this request takes no body`,
    )
  })

  it('keeps an emoji at the cut whole or leaves it out', () => {
    const name = `${'x'.repeat(NAME_SHOWN_MAX - 1)}😀${'x'.repeat(10)}`
    expect(refusal(() => refuseUnknownFields({ [name]: 1 }, []))).toBe(
      `unknown field "${'x'.repeat(NAME_SHOWN_MAX - 1)}…"; this request takes no body`,
    )
  })
})

describe('MCP echoes', () => {
  const META = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'echo', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  }
  const LEGACY = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  const send = async (headers: Record<string, string>, body: unknown) => {
    const bodyText = JSON.stringify(body)
    const res = await dispatchMcp({
      headers: new Headers(headers),
      bodyText,
      runTool: async () => {
        throw new Error('no tool runs')
      },
    })
    const text = await res.text()
    expect(text.length, text.slice(0, 200)).toBeLessThan(1_000)
    expect(bodyText.length).toBeGreaterThan(50_000)
    return { status: res.status, text }
  }
  const sse = (text: string) => JSON.parse(text.slice('event: message\ndata: '.length, -2))
  const many = Array(20_000).fill({})

  it('names an array tool name by its kind on both legs', async () => {
    const legacy = await send(LEGACY, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: many },
      id: 1,
    })
    expect(sse(legacy.text).error).toEqual({
      code: -32602,
      message: 'Tool [object Array] not found',
    })
    const modern = await send(
      { 'Content-Type': 'application/json', 'Mcp-Method': 'tools/call' },
      { jsonrpc: '2.0', method: 'tools/call', params: { name: many, _meta: META }, id: 1 },
    )
    expect(modern.status).toBe(400)
    expect(JSON.parse(modern.text).error.data.mismatch.body).toBe(
      'the body carries params.name="[object Array]" but the required Mcp-Name header is absent',
    )
  })

  it('matches a name that is not a string with the header as text, as before', async () => {
    const res = await dispatchMcp({
      headers: new Headers({
        'Content-Type': 'application/json',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': '5',
      }),
      bodyText: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 5, _meta: META },
        id: 1,
      }),
      runTool: async () => {
        throw new Error('no tool runs')
      },
    })
    expect(JSON.parse(await res.text()).error).toEqual({
      code: -32602,
      message: 'Tool 5 not found',
    })
  })

  it('cuts a long method and names an array protocol version by its kind', async () => {
    const method = 'm'.repeat(60_000)
    const mismatch = await send(
      { 'Content-Type': 'application/json', 'Mcp-Method': 'tools/list' },
      { jsonrpc: '2.0', method, params: { _meta: META }, id: 1 },
    )
    expect(JSON.parse(mismatch.text).error.data.mismatch.body).toBe(
      `the body names method ${'m'.repeat(NAME_SHOWN_MAX)}… but the Mcp-Method header names tools/list`,
    )
    const version = await send(
      { 'Content-Type': 'application/json', 'Mcp-Method': 'tools/list' },
      {
        jsonrpc: '2.0',
        method: 'tools/list',
        params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': many } },
        id: 1,
      },
    )
    expect(JSON.parse(version.text).error).toEqual({
      code: -32022,
      message: 'Unsupported protocol version: [object Array]',
      data: { supported: ['2026-07-28'], requested: '[object Array]' },
    })
  })

  it('refuses an id that is an array or object', async () => {
    for (const id of [Array(20_000).fill(1e20), { many }]) {
      const res = await send(LEGACY, { jsonrpc: '2.0', method: 'ping', id })
      expect(res.status).toBe(400)
      expect(JSON.parse(res.text)).toEqual({
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Bad Request: the request body is not a valid JSON-RPC message',
        },
        id: null,
      })
    }
  })

  it('lists the first unknown arguments of many and counts the rest', async () => {
    const res = await send(
      { ...LEGACY },
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'list_comments',
          arguments: { ref: 'QN-1', ...Object.fromEntries(keys(10_000).map((key) => [key, 0])) },
        },
        id: 1,
      },
    )
    expect(sse(res.text).result.content[0].text).toBe(
      `Input validation error: Invalid arguments for tool list_comments: Unrecognized keys: ${listed(NAMES_LISTED)} and ${10_000 - NAMES_LISTED} more`,
    )
  })
})

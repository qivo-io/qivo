/* Probes how an API origin answers unauthenticated request bodies at and
 * over the 1 MiB REST and MCP cap, many at a time, and prints the status
 * counts per case. It sends no credentials, so every request should answer
 * 401 and none can change data.
 *
 *   node scripts/body-cap-probe.mjs <api origin> [--requests 80] [--concurrency 8] [--case name]...
 *
 * Exits 1 when any request answered something other than 401, or failed. */

import { parseArgs } from 'node:util'

const BODY_MAX = 1024 * 1024
const MIB_PLUS_ONE = BODY_MAX + 1

/** One kind of request the probe sends, by name. */
export const CASES = {
  'rest-over': { path: '/v1/tasks', size: MIB_PLUS_ONE, chunked: false },
  'rest-over-chunked': { path: '/v1/tasks', size: MIB_PLUS_ONE, chunked: true },
  'rest-small': { path: '/v1/tasks', size: 117, chunked: false },
  'mcp-over': { path: '/mcp', size: MIB_PLUS_ONE, chunked: false },
}

/** A JSON body for `path`, padded with JSON whitespace to `size` bytes. */
export function probeBody(path, size) {
  const value =
    path === '/mcp'
      ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_me', arguments: {} } }
      : { project: '00000000-0000-4000-8000-000000000000', title: 'body cap probe' }
  const text = JSON.stringify(value)
  if (text.length > size) throw new Error(`a ${path} body needs at least ${text.length} bytes`)
  return text + ' '.repeat(size - text.length)
}

/** The status of one answer, or the error code of a request that got none. */
async function sendOne(origin, { path, size, chunked }) {
  const bytes = Buffer.from(probeBody(path, size))
  const body = chunked
    ? new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 65536)
            controller.enqueue(bytes.subarray(i, i + 65536))
          controller.close()
        },
      })
    : bytes
  try {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body,
      ...(chunked ? { duplex: 'half' } : {}),
      signal: AbortSignal.timeout(60_000),
    })
    await response.arrayBuffer()
    return String(response.status)
  } catch (error) {
    return error?.cause?.code ?? error?.code ?? error?.name ?? 'error'
  }
}

/** Sends `requests` requests of one case, `concurrency` at a time, and
 * counts the answers. */
export async function probe(origin, kind, { requests, concurrency }) {
  const counts = {}
  let next = 0
  const worker = async () => {
    while (next < requests) {
      next += 1
      const answer = await sendOne(origin, kind)
      counts[answer] = (counts[answer] ?? 0) + 1
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, worker))
  return counts
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      requests: { type: 'string', default: '80' },
      concurrency: { type: 'string', default: '8' },
      case: { type: 'string', multiple: true },
    },
  })
  const origin = positionals[0]?.replace(/\/+$/, '')
  const requests = Number(values.requests)
  const concurrency = Number(values.concurrency)
  const names = values.case ?? Object.keys(CASES)
  const unknown = names.filter((name) => !(name in CASES))
  if (
    !origin ||
    !/^https?:\/\/[^/]+$/.test(origin) ||
    !(requests >= 1) ||
    !(concurrency >= 1) ||
    unknown.length > 0
  ) {
    console.error(
      `usage: node scripts/body-cap-probe.mjs <api origin> [--requests 80] [--concurrency 8] [--case ${Object.keys(CASES).join('|')}]...`,
    )
    process.exit(2)
  }
  let clean = true
  for (const name of names) {
    const counts = await probe(origin, CASES[name], { requests, concurrency })
    const line = Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([answer, count]) => `${answer} x${count}`)
      .join(', ')
    console.log(`${name} (${CASES[name].size} bytes): ${line}`)
    if (Object.keys(counts).some((answer) => answer !== '401')) clean = false
  }
  process.exit(clean ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()

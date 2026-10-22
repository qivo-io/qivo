/* Probes how an API origin answers unauthenticated request bodies at and
 * over the 1 MiB REST and MCP cap, and on the other routes that refuse a
 * body before reading it (an unknown upload link, the demo metrics and
 * Polar webhook endpoints, an unknown auth endpoint), many at a time, and
 * prints the status counts per case. It sends no credentials and no valid
 * link or signature, so every request is refused and none can change data.
 *
 *   node scripts/body-cap-probe.mjs <api origin> [--requests 80] [--concurrency 8] [--case name]...
 *
 * Exits 1 when any request answered a status its case does not expect, or
 * failed. */

import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const BODY_MAX = 1024 * 1024
const MIB_PLUS_ONE = BODY_MAX + 1

/* An upload link with a made-up ticket and token, which no deployment
 * accepts. */
const FAKE_LINK = '00000000-0000-4000-8000-000000000000?e=1&m=probe&t=probe'

/** One kind of request the probe sends, by name, with the statuses it may
 * answer. The demo metrics endpoint answers 404 where it is not set up, and
 * the Polar webhook where billing is off. */
export const CASES = {
  'rest-over': { path: '/v1/tasks', size: MIB_PLUS_ONE, chunked: false, expect: ['401'] },
  'rest-over-chunked': { path: '/v1/tasks', size: MIB_PLUS_ONE, chunked: true, expect: ['401'] },
  'rest-small': { path: '/v1/tasks', size: 117, chunked: false, expect: ['401'] },
  'mcp-over': { path: '/mcp', size: MIB_PLUS_ONE, chunked: false, expect: ['401'] },
  'attachment-upload-over': {
    path: `/attachment-uploads/${FAKE_LINK}`,
    size: MIB_PLUS_ONE,
    chunked: false,
    expect: ['404'],
  },
  'image-upload-over': {
    path: `/background-uploads/${FAKE_LINK}`,
    size: MIB_PLUS_ONE,
    chunked: false,
    expect: ['404'],
  },
  'demo-upload-over': {
    path: `/demo-uploads/${FAKE_LINK}`,
    size: MIB_PLUS_ONE,
    chunked: false,
    expect: ['404'],
  },
  'demo-metrics-over': {
    path: '/internal/demo-metrics',
    size: MIB_PLUS_ONE,
    chunked: false,
    expect: ['401', '404'],
  },
  'polar-webhook-over': {
    path: '/billing/polar/webhook',
    size: MIB_PLUS_ONE,
    chunked: false,
    expect: ['400', '404'],
  },
  'auth-unknown-over': {
    path: '/api/auth/body-cap-probe',
    size: MIB_PLUS_ONE,
    chunked: false,
    expect: ['404'],
  },
}

/** A JSON body for `path`, padded with JSON whitespace to `size` bytes. */
export function probeBody(path, size) {
  const value =
    path === '/mcp'
      ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_me', arguments: {} } }
      : path === '/v1/tasks'
        ? { project: '00000000-0000-4000-8000-000000000000', title: 'body cap probe' }
        : { probe: 'body cap probe' }
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
    if (Object.keys(counts).some((answer) => !CASES[name].expect.includes(answer))) clean = false
  }
  process.exit(clean ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()

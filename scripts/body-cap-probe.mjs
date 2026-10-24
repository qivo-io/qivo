/* Probes how an API origin answers unauthenticated request bodies just over
 * the 1 MiB REST and MCP cap and well under it, and bodies over 1 MiB on the
 * other routes that refuse a body before reading it (an unknown upload link,
 * the demo metrics and Polar webhook endpoints, an unknown auth endpoint),
 * bodies over the 64 KiB sign-in cap and sign-in bodies that stop arriving,
 * many at a time, and prints the status counts per case. It sends no
 * credentials and no valid link or signature, and no auth body that reaches
 * Better Auth, so every request is refused and none changes task or customer
 * data. Each REST and MCP request still
 * counts at the deployment-wide request limit, which every organization
 * shares, so a run against a hosted deployment needs explicit scope, and a
 * run sends at most MAX_TOTAL requests, a third of that limit's minute.
 *
 *   node scripts/body-cap-probe.mjs <api origin> [--requests 80] [--concurrency 8] [--case name]...
 *
 * Exits 1 when any request answered a status its case does not expect, or
 * failed, and 2 for arguments it cannot use. */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/** The most requests one run sends, over all its cases. */
export const MAX_TOTAL = 2_000

/** The most requests one run keeps open at once. */
export const MAX_CONCURRENCY = 16

const BODY_MAX = 1024 * 1024
const MIB_PLUS_ONE = BODY_MAX + 1

/* An upload link with a made-up ticket and token, which no deployment
 * accepts. */
const FAKE_LINK = '00000000-0000-4000-8000-000000000000?e=1&m=probe&t=probe'

/** The sign-in endpoint every auth case but one sends to. */
const SIGN_IN = '/api/auth/sign-in/email'

/** One kind of request the probe sends, by name, with the statuses it may
 * answer. The demo metrics endpoint answers 404 where it is not set up, the
 * Polar webhook where billing is off, and the demo refuses every auth
 * endpoint these cases use with 403. Elsewhere an auth body over 64 KiB
 * answers 413 before Better Auth routes it, and one still arriving after
 * 5 s answers 408.
 *
 * A case with `stall` sends its `size` bytes in pieces of `chunk` bytes,
 * `every` milliseconds apart, and then sends no more until the answer. A
 * hosted front end holds back the start of the HTTP action until about
 * 0.5 MiB or 5 s of a body arrived, and resets a body that stops before that
 * after about 15 s with no answer. So `auth-stall-past-buffer` stops after
 * 600 KiB, and `auth-stall-slow` sends 48 KiB over 6 s, which a front end
 * that waits for 0.5 MiB resets instead (UND_ERR_SOCKET or ECONNRESET). */
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
    expect: ['403', '404'],
  },
  'auth-over': { path: SIGN_IN, size: MIB_PLUS_ONE, chunked: false, expect: ['403', '413'] },
  'oauth-token-over': {
    path: '/api/auth/oauth2/token',
    size: MIB_PLUS_ONE,
    chunked: false,
    expect: ['403', '413'],
  },
  'auth-stall-past-buffer': {
    path: SIGN_IN,
    size: 600 * 1024,
    chunked: true,
    stall: { chunk: 65536, every: 0 },
    // a hosted front end resets the client after the action answers 413,
    // because the body never ended (staging, f21abda: 413 in about 1.1 s)
    expect: ['403', '413', 'UND_ERR_SOCKET', 'ECONNRESET'],
  },
  'auth-stall-slow': {
    path: SIGN_IN,
    size: 48 * 1024,
    chunked: true,
    stall: { chunk: 4096, every: 500 },
    expect: ['403', '408', 'UND_ERR_SOCKET', 'ECONNRESET'],
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

/** The status of one answer, or the error code or name of a request that
 * got none. */
async function sendOne(origin, { path, size, chunked, stall }) {
  const bytes = Buffer.from(probeBody(path, size))
  // ends a stalled body's upload once its answer is in
  const done = new AbortController()
  const body = chunked
    ? new ReadableStream({
        async start(controller) {
          const chunk = stall?.chunk ?? 65536
          for (let i = 0; i < bytes.length && !done.signal.aborted; i += chunk) {
            controller.enqueue(bytes.subarray(i, i + chunk))
            if (stall?.every) await new Promise((resolve) => setTimeout(resolve, stall.every))
          }
          if (!stall) controller.close()
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
      signal: AbortSignal.any([AbortSignal.timeout(60_000), done.signal]),
    })
    await response.arrayBuffer()
    return String(response.status)
  } catch (error) {
    // a timeout's DOMException has the numeric legacy code 23, so only a
    // text code counts
    const code = error?.cause?.code ?? error?.code
    return typeof code === 'string' ? code : (error?.name ?? 'error')
  } finally {
    done.abort()
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

const USAGE = `usage: node scripts/body-cap-probe.mjs <api origin> [--requests 80] [--concurrency 8] [--case ${Object.keys(CASES).join('|')}]...`

/** The run that `argv` asks for, or null when it cannot be used: an origin
 * that is not a bare http or https origin, an unknown case, a count that is
 * not a whole number from 1, more than MAX_CONCURRENCY at once or more than
 * MAX_TOTAL requests in all. */
export function parseProbeArgs(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        requests: { type: 'string', default: '80' },
        concurrency: { type: 'string', default: '8' },
        case: { type: 'string', multiple: true },
      },
    })
  } catch {
    return null
  }
  const { values, positionals } = parsed
  const url = URL.canParse(positionals[0] ?? '') ? new URL(positionals[0]) : null
  const bare =
    url !== null &&
    ['http:', 'https:'].includes(url.protocol) &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    positionals.length === 1
  const whole = (text) => (/^[1-9][0-9]*$/.test(text) ? Number(text) : Number.NaN)
  const requests = whole(values.requests)
  const concurrency = whole(values.concurrency)
  const names = values.case ?? Object.keys(CASES)
  if (
    !bare ||
    names.some((name) => !Object.hasOwn(CASES, name)) ||
    !(concurrency <= MAX_CONCURRENCY) ||
    !(requests * names.length <= MAX_TOTAL)
  )
    return null
  return { origin: url.origin, requests, concurrency, names }
}

async function main() {
  const run = parseProbeArgs(process.argv.slice(2))
  if (run === null) {
    console.error(USAGE)
    console.error(
      `--requests and --concurrency are whole numbers from 1, at most ${MAX_CONCURRENCY} at once and ${MAX_TOTAL} requests over all cases`,
    )
    process.exit(2)
  }
  const { origin, requests, concurrency, names } = run
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

// import.meta.main arrived in Node 24.2, and a local run may use an older 24.x
// than the engines field names
const isMain =
  import.meta.main ??
  (process.argv[1] !== undefined &&
    realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
if (isMain) await main()

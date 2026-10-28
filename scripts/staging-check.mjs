#!/usr/bin/env node
/* End-to-end check of the REST API, the MCP server and OAuth consent on the
 * staging deployment, or on a disposable local backend (--local).
 *
 * One run signs in as Nora Berg, the Northstar fixture admin, in a real
 * browser. In the app it creates a personal token that can make changes, a
 * read-only one, a Standard agent with two keys and a Viewer agent with one.
 * It approves two OAuth connections on the real consent screen, one with
 * Allow changes and one without. With every credential it checks that reads
 * succeed over REST and MCP, that writes succeed only where allowed, that
 * refusals carry the documented status and sentence, and that activity rows
 * name the credential. It uploads, downloads and deletes attachments, one of
 * them at the per-file limit, checks that an upload URL stores one file, checks
 * the text, name, list and request size limits, unknown arguments, comment
 * paging, the archived task lists, task progress, last comment times, delay and
 * project completion, and the live group rule. It fills one task with a
 * little more than a page of comments and of history, pages that history
 * over REST and MCP, and in the browser presses Show earlier comments and
 * Show earlier activity in its task window. It opens the Settings page
 * Archived tasks in the browser. Every task, comment, grant and file lives
 * in projects the run creates and names with its run tag. It revokes every
 * credential in the app, checks that the next call is refused, and removes
 * everything it made, also after a failure (try/finally, and --cleanup for
 * a later sweep).
 *
 * The billing pause checks need an organization whose billing pauses
 * editing. Staging runs without billing, so they report SKIP there. A local
 * run given its backend's admin key in QIVO_LOCAL_ADMIN_KEY pauses billing
 * for those checks and lifts the pause again. It marks the pause in the
 * backend, so a later keyed local run or --cleanup lifts a pause that a
 * killed run left. --require turns that SKIP into a FAIL. --invert flips the expectation of a refusal group, so its checks
 * must fail; that proves they can catch a wrong permission.
 *
 * Secrets (passwords, tokens, keys, OAuth codes, upload and download links,
 * the Vercel bypass value) stay in this process's memory. They are never
 * printed, written to disk or passed as process arguments, and every output
 * line goes through redact(). Screenshots are off unless --shots names a
 * directory, and never taken while a secret or a password field is on screen.
 *
 *   staging, from the application checkout (see docs/deployment.md):
 *     "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-staging" \
 *       node scripts/staging-check.mjs --staging
 *     ... node scripts/staging-check.mjs --staging --cleanup
 *   local, with QIVO_LOCAL_ADMIN_KEY in the environment for the billing
 *   pause checks:
 *     node scripts/staging-check.mjs --local --app-url http://localhost:5241 \
 *       --convex-url http://127.0.0.1:3236 --api-url http://127.0.0.1:3237 \
 *       --deployment local-name-3236
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { signInBrowser } from './browser-demo.mjs'
import { DEFAULT_PAGE_SIZE, LIMITS, MIB } from './limits.mjs'
import { fixtureDirectory, loadCredentials, resolveTarget } from './marketing-demo.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The body fields of the access and team member routes, in the order their
 * unknown-field refusals list them. The server keeps the same lists in
 * convex/machine/bodyFields.ts, and staging-check.test.mjs holds the two
 * equal, so this check follows the REST contract while plain Node reads no
 * TypeScript. */
export const REST_BODY_FIELDS = {
  accessPut: ['level', 'expected'],
  heldTasks: ['on_held_tasks'],
  memberPut: ['leader'],
}
const ORG_SLUG = 'northstar-labs'
/** Every name this script gives a record starts with the tag and a space. */
export const TAG_PREFIX = 'stgchk-'
export const TAG_ANY = /^stgchk-[0-9a-f]{6} /

/** Whether `name` carries the run tag `tag`, or any run's tag when `tag` is
 *  TAG_ANY. The tag and a space must start the name, so a sweep never
 *  touches a record that only contains a tag or carries a longer one. */
export const hasTag = (tag, name) =>
  typeof name === 'string' && (tag instanceof RegExp ? tag.test(name) : name.startsWith(`${tag} `))
/** Requests per profile and minute. The deployment allows 300. */
export const RATE_BUDGET = 200
/** The second click of an in-place confirm must come 0.5 to 3.5 s after the first. */
const CONFIRM_PAUSE_MS = 800
const MCP_VERSION = '2026-07-28'
/** The one app origin a staging run accepts. */
export const STAGING_APP_ORIGIN = 'https://preview.qivo.io'
const PRODUCTION_HOSTS = new Set(['qivo.io', 'www.qivo.io', 'demo.qivo.io', 'api.qivo.io'])
/** The longest REST or MCP request body (convex/machine/shared.ts BODY_MAX_BYTES). */
const BODY_MAX = LIMITS.requestBody.max * MIB
/** The rows one page of a task's thread holds: comments
 *  (convex/model/comments.ts COMMENT_PAGE_MAX), history over REST and MCP
 *  (convex/lib/activityVisibility.ts HISTORY_PAGE_MAX), which answer one
 *  page a call, and history in the task window (WINDOW_HISTORY_PAGE). The
 *  window opens with one page of comments, and loads one page of history
 *  once All is chosen. */
export const THREAD_PAGE = { comments: LIMITS.listComments.max, history: 500, windowHistory: 50 }

/** Checks that need a condition the run cannot create everywhere, which
 *  report SKIP without it, or FAIL when --require names them. */
export const PROBES = ['billing-pause-leave']
export const INVERT_GROUPS = [
  'read-token',
  'viewer-agent',
  'oauth-read',
  'other-project',
  'revoked',
]

/* ------------------------------------------------------------- arguments */

class UsageError extends Error {}

/** The usage error for an argument the script does not take. It names a
 *  plain option, but never repeats any other value, which could be a secret
 *  pasted by mistake. */
const unknownArgument = (arg) =>
  new UsageError(
    `${/^--[a-z][a-z-]{0,30}$/.test(arg) ? `Unknown argument ${arg}.` : 'Unknown argument (not shown, in case it is a secret).'} Secrets belong in the environment.`,
  )

/** Parses the command line. Secrets are never accepted as arguments, and a
 *  usage error never repeats a value. */
export function parseArgs(argv) {
  const o = {
    require: new Set(),
    invert: new Set(),
    cleanup: false,
  }
  const takes = new Set([
    '--site-url',
    '--app-url',
    '--convex-url',
    '--api-url',
    '--deployment',
    '--require',
    '--invert',
    '--run',
    '--shots',
  ])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--staging' || arg === '--local') {
      if (o.target) throw new UsageError('Choose either --staging or --local.')
      o.target = arg.slice(2)
    } else if (arg === '--cleanup') o.cleanup = true
    else if (takes.has(arg)) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new UsageError(`${arg} needs a value.`)
      if (arg === '--require' || arg === '--invert') {
        const known = arg === '--invert' ? INVERT_GROUPS : PROBES
        const names = value === 'all' ? known : value.split(',')
        for (const name of names) {
          if (!known.includes(name))
            throw new UsageError(`${arg} takes all or a list of ${known.join(', ')}.`)
          o[arg.slice(2)].add(name)
        }
      } else if (arg === '--run') {
        if (!/^[0-9a-f]{6}$/.test(value)) throw new UsageError('--run takes six hex digits.')
        o.run = value
      } else o[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
    } else throw unknownArgument(arg)
  }
  if (!o.target) throw new UsageError('Choose --staging or --local.')
  if (o.run && !o.cleanup) throw new UsageError('--run is for --cleanup.')
  return o
}

const isLoopback = (url) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)

/** The exact origin of a URL argument, or a usage error. */
function origin(value, what) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new UsageError(`${what} must be a URL.`)
  }
  if (url.origin !== value.replace(/\/$/, '')) throw new UsageError(`${what} must be an origin.`)
  return url
}

/** Whether `url` is a Convex site URL of `deployment`, with or without a
 *  region label. */
export const isSiteOf = (url, deployment) =>
  url.protocol === 'https:' &&
  url.hostname.endsWith('.convex.site') &&
  url.hostname.split('.')[0] === deployment

/** Resolves where the run goes, refusing production and anything that is
 *  not the explicitly selected staging or local target. It fails closed:
 *  staging needs QIVO_ENVIRONMENT=staging, a prod: key for a deployment the
 *  fixture CLI accepts and the app at preview.qivo.io. */
export function resolveConfig(o, env) {
  // Playwright's and Node's debug output would print secrets past redact()
  for (const name of ['DEBUG', 'PWDEBUG', 'DEBUG_FILE', 'NODE_DEBUG'])
    if (env[name]) throw new UsageError(`Unset ${name}: its debug output bypasses redaction.`)
  if (o.target === 'staging') {
    if (env.QIVO_ENVIRONMENT !== 'staging')
      throw new UsageError('--staging needs QIVO_ENVIRONMENT=staging from the staging helper.')
    let target
    try {
      target = resolveTarget({ target: 'staging', siteUrl: o.siteUrl }, env)
    } catch (error) {
      throw new UsageError(error.message)
    }
    if (!target.url || !target.deployment)
      throw new UsageError('The staging deployment URL is unknown.')
    const app = origin(target.siteUrl, 'The staging site URL')
    if (PRODUCTION_HOSTS.has(app.hostname) || app.origin !== STAGING_APP_ORIGIN)
      throw new UsageError(`The staging check runs against ${STAGING_APP_ORIGIN} only.`)
    const api = o.apiUrl
      ? origin(o.apiUrl, '--api-url')
      : new URL(target.url.replace(/\.convex\.cloud\/?$/, '.convex.site'))
    if (!isSiteOf(api, target.deployment) || PRODUCTION_HOSTS.has(api.hostname))
      throw new UsageError('The API origin must be the Convex site URL of the staging deployment.')
    return {
      target,
      appOrigin: app.origin,
      apiOrigin: api.origin,
      bypass: env.QIVO_STAGING_PROTECTION_BYPASS || undefined,
    }
  }
  if (['staging', 'production', 'demo'].includes(env.QIVO_ENVIRONMENT))
    throw new UsageError(`--local refuses QIVO_ENVIRONMENT=${env.QIVO_ENVIRONMENT}.`)
  for (const name of ['appUrl', 'convexUrl', 'apiUrl', 'deployment'])
    if (!o[name])
      throw new UsageError('--local needs --app-url, --convex-url, --api-url and --deployment.')
  const app = origin(o.appUrl, '--app-url')
  const convex = origin(o.convexUrl, '--convex-url')
  const api = origin(o.apiUrl, '--api-url')
  if (![app, convex, api].every(isLoopback) || app.protocol !== 'http:')
    throw new UsageError('--local takes loopback HTTP origins only.')
  return {
    target: { target: 'local', deployment: o.deployment, url: convex.origin, siteUrl: app.origin },
    appOrigin: app.origin,
    apiOrigin: api.origin,
    // A local run can stand behind a protection emulator to try the header.
    bypass: env.QIVO_STAGING_PROTECTION_BYPASS || undefined,
  }
}

/* --------------------------------------------------------------- output */

const secrets = new Set()

/** Remembers a secret so redact() removes it from every output line. */
function keep(secret) {
  if (typeof secret === 'string' && secret.length >= 6) secrets.add(secret)
  return secret
}

/** Removes known secrets and anything shaped like a credential, an OAuth
 *  code, a signed link or a bearer header from a line of output. */
export function redact(text, known = secrets) {
  let s = String(text)
  for (const value of known) s = s.split(value).join('[redacted]')
  return s
    .replace(/\bqv[a-z]_[A-Za-z0-9_\-.~]{6,}/g, (m) => `${m.slice(0, 4)}[redacted]`)
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(
      /([?&#](?:code|state|code_verifier|refresh_token|access_token|token|sig|ott|t)=)[^&\s"']+/gi,
      '$1[redacted]',
    )
}

const results = { pass: 0, fail: [], skip: [], retried: 0 }

function say(kind, id, message = '') {
  console.log(redact(`${kind.padEnd(5)}${id}${message ? `  ${message}` : ''}`))
}

/** A failed expectation. Its message is written by this script and is
 *  safe to print once redacted. */
class CheckError extends Error {}
/** Stops the main flow; cleanup still runs. */
class Abort extends Error {}

function fail(message) {
  throw new CheckError(message)
}
function expect(condition, message) {
  if (!condition) fail(message)
}
const short = (value) => {
  const text =
    typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? 'undefined')
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}
function eq(actual, expected, what) {
  if (actual !== expected) fail(`${what}: expected ${short(expected)}, got ${short(actual)}`)
}
/** JSON with sorted keys, so two values compare whatever their key order. */
const canonical = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  )
function same(actual, expected, what) {
  if (canonical(actual) !== canonical(expected))
    fail(`${what}: expected ${short(expected)}, got ${short(actual)}`)
}

/** A short, redacted description of an unexpected error. Raw Playwright and
 *  fetch errors can carry URLs, so only their first line is kept. */
function describe(error) {
  if (error instanceof CheckError || error instanceof Abort) return error.message
  const first = String(error?.message ?? error).split('\n')[0]
  return `${error?.name ?? 'Error'}: ${first.slice(0, 200)}`
}

/** Set by the first Ctrl-C, SIGTERM or SIGHUP: the run stops before its
 *  next check and goes on to cleanup. A second signal exits at once. */
let interrupted = false

/** Runs one check and records PASS or FAIL. The run continues either way. */
async function check(id, fn) {
  if (interrupted) throw new Abort('interrupted by a signal')
  try {
    const note = await fn()
    results.pass++
    say('PASS', id, typeof note === 'string' ? note : '')
    return true
  } catch (error) {
    results.fail.push(id)
    say('FAIL', id, describe(error))
    return false
  }
}

/** Like check(), but a failure stops the main flow, because later steps
 *  depend on this one. Returns the step's value, which is never printed:
 *  it can be a secret. `note` is an optional safe status text. */
async function must(id, fn, note) {
  let value
  const ok = await check(id, async () => {
    value = await fn()
    return typeof note === 'function' ? note(value) : ''
  })
  if (!ok) throw new Abort(`${id} failed, so the run cannot continue`)
  return value
}

function skip(id, reason) {
  results.skip.push(id)
  say('SKIP', id, reason)
}

/** skip() for a probe in PROBES, which --require turns into a failure. */
function skipProbe(id, reason) {
  if (!cfg.require.has(id)) return skip(id, reason)
  results.fail.push(id)
  say('FAIL', id, `required, but ${reason}`)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Polls `fn` until it answers true, for at most `ms`. */
async function until(fn, ms = 20_000) {
  const end = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() > end) return false
    await sleep(500)
  }
}

/** `target.evaluate(fn, arg)` on a page or a locator, which fails after `ms`.
 *  Playwright gives an evaluation no timeout, so a call that never settles,
 *  such as a fetch that hangs in the page, would otherwise hold up the run
 *  and its cleanup. */
export async function evaluate(target, fn, arg, ms = 30_000) {
  let timer
  try {
    return await Promise.race([
      target.evaluate(fn, arg),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`a call in the page gave no answer in ${ms / 1000} s`)),
          ms,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------ HTTP clients */

let cfg
const windows = new Map()

/** Keeps each profile under RATE_BUDGET requests in any 60 seconds, which
 *  also keeps it under the deployment's fixed minute window. */
export async function pace(profile) {
  for (;;) {
    const now = Date.now()
    const recent = (windows.get(profile) ?? []).filter((t) => now - t < 60_000)
    if (recent.length < RATE_BUDGET) {
      recent.push(now)
      windows.set(profile, recent)
      return
    }
    windows.set(profile, recent)
    await sleep(60_000 - (now - recent[0]) + 100)
  }
}

/** The MCP tools that only read (their registry access is read), whose
 *  calls are safe to send twice. */
const READ_TOOLS = new Set([
  'get_me',
  'get_project',
  'get_task',
  'get_workload',
  'list_comments',
  'list_inbox',
  'list_labels',
  'list_project_users',
  'list_projects',
  'list_task_activity',
  'list_tasks',
  'list_teams',
  'list_users',
])

/** A request that never follows a redirect. Request bodies carry OAuth codes,
 *  verifiers and refresh tokens, and Node's fetch drops the Authorization
 *  header on a cross-origin redirect but still sends the body, so every
 *  request refuses a redirect instead. It ends after `timeoutMs`, reading
 *  the body included, so a stalled request cannot hold up a stop or the
 *  cleanup. The error names no URL. */
export async function request(url, init = {}, timeoutMs = 120_000) {
  try {
    return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    if (/redirect/i.test(String(error?.cause?.message ?? error?.message)))
      fail('a request was answered with a redirect, which this check never follows')
    if (error?.name === 'TimeoutError')
      throw new Error(`network error: no answer in ${timeoutMs / 1000} s`, { cause: error })
    const code = error?.cause?.code
    throw new Error(`network error${code ? ` ${code}` : ''}`, { cause: error })
  }
}

/** How many milliseconds send() waits before it sends a request again after
 *  a 429 at most, after a read's server or network error, and after a write
 *  conflict or time out. Tests lower them. */
export const WAITS = { rateLimit: 61_000, readRetry: 2_000, conflictRetry: 1_000 }

/** The milliseconds to wait after a 429 whose Retry-After header is
 *  `header`: the seconds it names, which are those left in the server's
 *  minute, plus one, or WAITS.rateLimit when it names no whole number of
 *  seconds from 1 to 60. */
export function rateLimitWait(header) {
  const seconds = header === null || header.trim() === '' ? Number.NaN : Number(header)
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 60
    ? (seconds + 1) * 1000
    : WAITS.rateLimit
}

/** One authenticated request. A 429 waits once, for its Retry-After seconds
 *  and one more (rateLimitWait), at most WAITS.rateLimit (61 seconds). That
 *  happens only when something else uses the same profile at the same time,
 *  the deployment's own limit is reached, or a profile posts more than
 *  LIMITS.commentRate.max comments on one task in 60 seconds, the comment
 *  posting rate, whose Retry-After is the seconds until its oldest post
 *  there stops counting. threadPageChecks paces its posts to stay inside
 *  that rate. A read that answers a
 *  server error (5xx) or fails on the network is sent once more after
 *  WAITS.readRetry (two seconds), with a NOTE, because a read changes
 *  nothing. A write answered with the 503 of a write conflict or time out,
 *  which changed nothing, is sent once more after WAITS.conflictRetry (a
 *  second). Any other server error of a write is reported as it is. */
export async function send(profile, url, init, { read = false } = {}) {
  let retried = false
  let waited = false
  const again = async (why) => {
    retried = true
    results.retried++
    say('NOTE', 'server-error', `a read ${why}; sending it once more`)
    await sleep(WAITS.readRetry)
  }
  for (;;) {
    await pace(profile)
    let response
    try {
      response = await request(url, init)
    } catch (error) {
      if (!read || retried || error instanceof CheckError) throw error
      await again(`hit a ${error.message}`)
      continue
    }
    if (response.status === 429 && !waited) {
      waited = true
      const wait = Math.min(WAITS.rateLimit, rateLimitWait(response.headers.get('Retry-After')))
      say('NOTE', 'rate-limit', `${profile} hit a rate limit; waiting ${wait / 1000} seconds`)
      await response.arrayBuffer().catch(() => {})
      await sleep(wait)
      continue
    }
    if (response.status >= 500 && read && !retried) {
      await response.arrayBuffer().catch(() => {})
      await again(`answered HTTP ${response.status}`)
      continue
    }
    if (response.status === 503 && !read && !retried) {
      const error = await response
        .clone()
        .json()
        .then((body) => body?.error)
        .catch(() => null)
      if (changedNothing(error)) {
        await response.arrayBuffer().catch(() => {})
        retried = true
        results.retried++
        say(
          'NOTE',
          'write-conflict',
          error === WRITE_TIMEOUT
            ? 'a write ran out of time and changed nothing; sending it once more'
            : 'a write conflicted and changed nothing; sending it once more',
        )
        await sleep(WAITS.conflictRetry)
        continue
      }
    }
    return response
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** A REST request as `cred`. `raw` sends `body` as given. */
async function rest(cred, method, path, body, { raw = false } = {}) {
  const headers = { Authorization: `Bearer ${cred.secret}` }
  let payload
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = raw ? body : JSON.stringify(body)
  }
  const response = await send(
    cred.profile,
    `${cfg.apiOrigin}/v1${path}`,
    { method, headers, body: payload },
    { read: method === 'GET' },
  )
  const text = await response.text()
  return { status: response.status, json: parseJson(text), headers: response.headers }
}

let rpcId = 0

/** The JSON-RPC request body of one MCP call. The modern leg carries the
 *  2026-07-28 envelope; the legacy leg is a 2025-era request. */
function rpcBody(method, params, legacy = false) {
  const p = { ...params }
  if (!legacy)
    p._meta = {
      'io.modelcontextprotocol/protocolVersion': MCP_VERSION,
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'qivo-staging-check', version: '1' },
    }
  return { jsonrpc: '2.0', id: ++rpcId, method, params: p }
}

/** One MCP JSON-RPC request. The legacy leg answers with SSE framing. */
async function mcp(cred, method, params, { legacy = false, bodyText } = {}) {
  const headers = {
    Authorization: `Bearer ${cred.secret}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (!legacy) {
    headers['Mcp-Method'] = method
    if (method === 'tools/call') headers['Mcp-Name'] = params.name
  }
  const read =
    bodyText === undefined &&
    (method === 'tools/list' || (method === 'tools/call' && READ_TOOLS.has(params.name)))
  const response = await send(
    cred.profile,
    cfg.mcpUrl,
    {
      method: 'POST',
      headers,
      body: bodyText ?? JSON.stringify(rpcBody(method, params, legacy)),
    },
    { read },
  )
  const text = await response.text()
  const data = text.startsWith('event:')
    ? text
        .split('\n')
        .find((l) => l.startsWith('data: '))
        ?.slice(6)
    : text
  return { status: response.status, headers: response.headers, json: parseJson(data ?? '') }
}

/** Calls an MCP tool. `data` is the parsed result of a successful call. */
async function tool(cred, name, args = {}, opts = {}) {
  const r = await mcp(cred, 'tools/call', { name, arguments: args }, opts)
  const result = r.json?.result
  const text = result?.content?.[0]?.text
  const isError = result?.isError === true
  return {
    status: r.status,
    headers: r.headers,
    json: r.json,
    isError,
    text,
    data: result && !isError ? parseJson(text) : null,
  }
}

/** A successful tool call's data, or a check failure naming the tool. */
async function toolOk(cred, name, args) {
  const r = await tool(cred, name, args)
  expect(r.status === 200, `${name}: HTTP ${r.status}`)
  expect(r.json?.result && !r.isError, `${name} refused: ${short(r.text ?? r.json?.error)}`)
  return r.data
}

/** A refused tool call's sentence, or a check failure. */
async function toolRefusal(cred, name, args) {
  const r = await tool(cred, name, args)
  expect(r.status === 200 && r.isError, `${name} was not refused: HTTP ${r.status}, a result`)
  return r.text
}

/** A successful REST response's JSON. */
async function restOk(cred, method, path, body, status = method === 'POST' ? 201 : 200) {
  const r = await rest(cred, method, path, body)
  if (r.status !== status)
    fail(
      `${method} ${path.split('?')[0]}: expected ${status}, got ${r.status} ${short(r.json?.error)}`,
    )
  return r.json
}

/** A REST refusal with `status` and the exact `sentence`. */
async function restRefusal(cred, method, path, body, status, sentence) {
  const r = await rest(cred, method, path, body)
  expect(
    r.status === status && r.json?.error === sentence,
    `${method} ${path.split('?')[0]}: wanted ${status} ${short(sentence)}, got ${r.status} ${short(r.json?.error)}`,
  )
}

/** A GET that must answer 200. A server failure is tried twice more, so a
 *  cleanup read never takes a failed answer for an empty list. */
async function readOk(cred, path) {
  for (let attempt = 0; ; attempt++) {
    const r = await rest(cred, 'GET', path)
    if (r.status === 200) return r.json
    if (r.status < 500 || attempt >= 2)
      fail(`GET ${path.split('?')[0]}: HTTP ${r.status} ${short(r.json?.error)}`)
    await sleep(2000)
  }
}

/** readOk for a route that answers a list. */
async function readList(cred, path) {
  const rows = await readOk(cred, path)
  expect(Array.isArray(rows), `GET ${path.split('?')[0]} answered no list`)
  return rows
}

/** The MCP schema refusal text for `tool`. */
const schemaText = (name, issues) =>
  `Input validation error: Invalid arguments for tool ${name}: ${issues}`

/* --------------------------------------------------------- refusal checks */

const restOutcome = (r, status, sentence) => ({
  ok: r.status >= 200 && r.status < 300,
  matches: r.status === status && r.json?.error === sentence,
  seen: `${r.status} ${short(r.json?.error)}`,
  want: `${status} ${short(sentence)}`,
})
const toolOutcome = (r, sentence) => ({
  ok: r.status === 200 && !!r.json?.result && !r.isError,
  matches: r.status === 200 && r.isError && r.text === sentence,
  // a result can hold links and tickets, so only a refusal's text is shown
  seen: r.isError ? `${r.status} isError ${short(r.text)}` : `${r.status} a result`,
  want: `isError ${short(sentence)}`,
})
const scopeOutcome = (r) => ({
  ok: r.status === 200 && !!r.json?.result && !r.isError,
  matches:
    r.status === 403 &&
    r.json?.error === 'insufficient_scope' &&
    (r.headers.get('www-authenticate') ?? '').includes('error="insufficient_scope"') &&
    (r.headers.get('www-authenticate') ?? '').includes('scope="qivo:read qivo:write"'),
  seen: `${r.status} ${short(r.json?.error)}`,
  want: '403 insufficient_scope with a scope="qivo:read qivo:write" challenge',
})
const mcp401Outcome = (r, sentence) => ({
  ok: r.status === 200,
  matches:
    r.status === 401 &&
    r.json?.error === sentence &&
    (r.headers.get('www-authenticate') ?? '').startsWith('Bearer'),
  seen: `${r.status} ${short(r.json?.error)}`,
  want: `401 ${short(sentence)}`,
})

/** A refusal check. Normally the call must be refused with the documented
 *  status and sentence. When its group is inverted the call is expected to
 *  succeed instead, so a correct deployment makes the check fail. */
async function refused(id, group, call) {
  const inverted = cfg.invert.has(group)
  await check(`${id}${inverted ? ' (inverted)' : ''}`, async () => {
    const outcome = await call()
    if (inverted) expect(outcome.ok, `inverted expectation: wanted success, got ${outcome.seen}`)
    else expect(!outcome.ok && outcome.matches, `wanted ${outcome.want}, got ${outcome.seen}`)
  })
}

/* ------------------------------------------------------------------ OAuth */

let oauth

/** Whether `value` is on the API: its origin, or on staging the same
 *  deployment's Convex site under another spelling, such as with or without
 *  a region label. */
function onApi(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.origin === cfg.apiOrigin ||
    (cfg.target.target === 'staging' && isSiteOf(url, cfg.target.deployment))
  )
}

/** Discovers the authorization server from MCP's 401 challenge and keeps
 *  every endpoint on the deployment's own API origin. The backend's own
 *  resource URL becomes the API origin, because file links and token
 *  audiences use that spelling. */
async function discoverOAuth() {
  const challenge = await request(cfg.mcpUrl, { method: 'POST' })
  eq(challenge.status, 401, 'unauthenticated MCP status')
  const header = challenge.headers.get('www-authenticate') ?? ''
  const metadataUrl = header.match(/resource_metadata="([^"]+)"/)?.[1]
  expect(metadataUrl, 'the challenge names no protected-resource metadata')
  eq(
    header.match(/\bscope="([^"]+)"/)?.[1],
    'qivo:read qivo:write offline_access',
    'challenge scope',
  )
  expect(onApi(metadataUrl), 'metadata is on another origin')
  const resource = await (await request(metadataUrl)).json()
  expect(
    onApi(resource.resource) && new URL(resource.resource).pathname === '/mcp',
    `the protected resource ${short(resource.resource)} is not this deployment's MCP`,
  )
  if (resource.resource !== cfg.mcpUrl) {
    cfg.apiOrigin = new URL(resource.resource).origin
    cfg.mcpUrl = resource.resource
    say('NOTE', 'setup/oauth', `the backend names itself ${cfg.apiOrigin}; using that`)
  }
  const issuer = new URL(resource.authorization_servers[0])
  expect(onApi(issuer.href), 'the issuer is on another origin')
  const meta = await (
    await request(
      `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/, '')}`,
    )
  ).json()
  for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint'])
    expect(onApi(meta[key]), `${key} is on another origin`)
  return { meta, resource: resource.resource, scopes: 'qivo:read qivo:write offline_access' }
}

async function registerClient(name, redirectUri) {
  const response = await request(oauth.meta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: oauth.scopes,
    }),
  })
  expect(
    response.status === 200 || response.status === 201,
    `registration: HTTP ${response.status}`,
  )
  const body = await response.json()
  expect(typeof body.client_id === 'string', 'registration returned no client id')
  return body.client_id
}

async function tokenRequest(clientId, fields) {
  const response = await request(oauth.meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, resource: oauth.resource, ...fields }),
  })
  const body = parseJson(await response.text())
  if (body) for (const key of ['access_token', 'refresh_token']) keep(body[key])
  return { status: response.status, body }
}

/* ------------------------------------------------------------ the browser */

let browser
let context
let app
let consent
let callbacks
let callbackServer
let redirectUri
/** The WebSocket URLs the app page opened, which name its Convex backend. */
let appSockets = []

/** Starts the loopback OAuth callback. Codes stay in memory. */
async function startCallback() {
  callbacks = new Map()
  callbackServer = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      response.writeHead(404).end()
      return
    }
    callbacks.set(url.searchParams.get('state'), url.searchParams)
    keep(url.searchParams.get('code'))
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'",
    })
    response.end('<!doctype html><title>Staging check</title><p>Returned to the test client.</p>')
  })
  await new Promise((done) => callbackServer.listen(0, '127.0.0.1', done))
  redirectUri = `http://127.0.0.1:${callbackServer.address().port}/callback`
}

/** The environment variables Chromium gets. Without an explicit list,
 *  Playwright hands the browser this whole process environment, which the
 *  staging helper fills with the deploy key and the other staging values. */
const BROWSER_ENV = [
  'HOME',
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'FONTCONFIG_PATH',
  'FONTCONFIG_FILE',
]

async function openBrowser() {
  const { chromium } = await import('playwright')
  // Playwright's own signal handlers would close the browser and exit at
  // the first Ctrl-C, before the sweep. The browser runs in its own process
  // group, so a terminal's Ctrl-C reaches only this process, whose handler
  // lets the run clean up.
  browser = await chromium.launch({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    env: Object.fromEntries(
      BROWSER_ENV.filter((name) => process.env[name] !== undefined).map((name) => [
        name,
        process.env[name],
      ]),
    ),
  })
  context = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  if (cfg.bypass) {
    // Vercel Deployment Protection: the bypass header goes to app origin
    // requests only, never to Convex. Playwright keeps headers set here on
    // the redirects such a request follows, so this relies on the app origin
    // never redirecting elsewhere. A request a redirect from another origin
    // makes, such as the OAuth authorization endpoint's redirect to the
    // consent page, is not routed, so the header also asks Vercel for its
    // bypass cookie, which the browser keeps for the app origin alone.
    await context.route(
      (url) => url.origin === cfg.appOrigin,
      (route) =>
        route.continue({
          headers: {
            ...route.request().headers(),
            'x-vercel-protection-bypass': cfg.bypass,
            'x-vercel-set-bypass-cookie': 'true',
          },
        }),
    )
  }
  app = await context.newPage()
  app.setDefaultTimeout(30_000)
  app.setDefaultNavigationTimeout(90_000)
  // recorded from the first navigation on, because the app's Convex client
  // connects as soon as the page loads, before verifyTarget runs
  appSockets = []
  app.on('websocket', (ws) => appSockets.push(ws.url()))
}

/** Screenshot for a failure, only with --shots and never while a secret or
 *  password field is on screen. */
async function shot(page, name) {
  if (!cfg.shots || !page) return
  const revealing = await page
    .locator(
      '[data-fresh-token], [data-fresh-key], [data-fresh-agent], [data-new-mcp-token="created"], input[type="password"]',
    )
    .count()
    .catch(() => 1)
  if (revealing) {
    say('NOTE', 'screenshot', `${name} skipped because a secret or password field is on screen`)
    return
  }
  mkdirSync(cfg.shots, { recursive: true })
  await page.screenshot({ path: join(cfg.shots, `${name}.png`) }).catch(() => {})
}

async function signIn(account) {
  const response = await app.goto(`${cfg.appOrigin}/app/~/board/all`, {
    waitUntil: 'domcontentloaded',
  })
  if (response && response.status() === 401)
    fail('the app answered 401; set QIVO_STAGING_PROTECTION_BYPASS for Vercel protection')
  // the password goes only into the app's own sign-in form
  await app.waitForSelector('input[type="email"]', { timeout: 45_000 })
  eq(new URL(app.url()).origin, cfg.appOrigin, 'the sign-in page origin')
  await signInBrowser(app, account)
  await app.waitForSelector('[data-all-nav]', { timeout: 60_000 })
  eq(await evaluate(app, () => window.PLANNER.org?.slug), ORG_SLUG, 'signed-in organization')
}

/** Whether one of `sockets`, the WebSocket URLs a page opened, is a Convex
 *  client's sync connection to `backend`: the same host and port, ws: for
 *  http: or wss: for https:, on /api/<version>/sync. */
export function syncsWith(sockets, backend) {
  const want = new URL(backend)
  const protocol = want.protocol === 'https:' ? 'wss:' : 'ws:'
  return sockets.some((value) => {
    let url
    try {
      url = new URL(value)
    } catch {
      return false
    }
    return (
      url.protocol === protocol &&
      url.host === want.host &&
      /^\/api\/[^/]+\/sync$/.test(url.pathname)
    )
  })
}

/** Proves the API origin belongs to the app the run signed in to, before any
 *  credential is sent there. The MCP address the app shows is its own
 *  backend. A staging app must also name itself staging in version.json. A
 *  local app must sync with the --convex-url backend, which later gets the
 *  local admin key. */
async function verifyTarget() {
  let commit = 'unknown'
  if (cfg.target.target === 'staging') {
    const manifest = await evaluate(app, async () => {
      const r = await fetch('/version.json', { cache: 'no-store' })
      return r.ok ? r.json().catch(() => null) : null
    })
    eq(manifest?.environment, 'staging', 'the app manifest environment')
    commit = String(manifest.commit ?? 'unknown').slice(0, 12)
  }
  await openAccountMcp()
  if (cfg.target.target === 'local' && !syncsWith(appSockets, cfg.target.url)) {
    // only origins, because a URL's query can hold a token
    const opened = [
      ...new Set(
        appSockets.map((value) => {
          try {
            return new URL(value).origin
          } catch {
            return 'a URL that does not parse'
          }
        }),
      ),
    ]
    fail(
      `the app at ${cfg.appOrigin} does not sync with ${cfg.target.url}, the backend --convex-url names; ${opened.length ? `it opened WebSockets to ${opened.join(', ')}` : 'it opened no WebSocket'}`,
    )
  }
  const shown = (
    (await app.locator('[data-mcp-server-address] span[translate="no"]').first().textContent()) ??
    ''
  ).trim()
  let url
  try {
    url = new URL(shown)
  } catch {
    fail('the app shows no MCP server address')
  }
  if (cfg.target.target === 'staging' && url.origin !== cfg.apiOrigin) {
    // The same deployment under another host spelling, such as a region label.
    expect(
      isSiteOf(url, cfg.target.deployment),
      "the app's MCP address is not on the staging deployment",
    )
    cfg.apiOrigin = url.origin
    cfg.mcpUrl = `${url.origin}/mcp`
  }
  eq(shown, cfg.mcpUrl, "the app's MCP server address")
  return `commit ${commit}, API ${cfg.apiOrigin}`
}

/** Waits until the app has saved every change it painted ahead of the
 *  server (the store's in-flight writes), so a navigation cannot drop one. */
async function settled() {
  await app.waitForFunction(() => !window.PLANNER.roadmapUndo.busy, undefined, { timeout: 30_000 })
}

/** Clicks an in-place confirm control twice, with the pause it needs. */
async function confirmTwice(first, armed) {
  await first.click()
  await armed.waitFor()
  await sleep(CONFIRM_PAUSE_MS)
  await armed.click()
}

async function openAccountMcp() {
  await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/settings/account`, {
    waitUntil: 'domcontentloaded',
  })
  await app.getByRole('heading', { name: 'Your account', exact: true }).waitFor({ timeout: 45_000 })
  const section = app.locator('[data-settings-account-section="mcp"]')
  if (await section.count()) await section.first().click()
  await app.locator('[data-mcp-new-token]').waitFor()
}

/** Creates a personal token through the New token dialog and returns its
 *  secret, read from the one-time reveal and kept in memory only. */
async function createTokenInUi(name, allowChanges) {
  await openAccountMcp()
  await app.locator('[data-mcp-new-token]').click()
  const dialog = app.getByRole('dialog')
  const form = dialog.locator('[data-new-mcp-token="form"]')
  await form.waitFor()
  const nameBox = form.getByRole('textbox', { name: 'Name', exact: true })
  await nameBox.fill(name)
  const box = form.locator('[data-new-mcp-token-changes]')
  eq(await box.getAttribute('data-state'), 'checked', 'Allow changes starts on')
  if (!allowChanges) await box.click()
  eq(await box.getAttribute('data-state'), allowChanges ? 'checked' : 'unchecked', 'Allow changes')
  eq(
    await form.locator('[data-new-mcp-token-expires="never"]').isChecked(),
    true,
    'expiry starts at Never',
  )
  await dialog.getByRole('button', { name: 'Create token', exact: true }).click()
  const shown = app.locator('[data-new-mcp-token="created"]')
  await shown.waitFor()
  eq(
    (await app.locator('[data-new-mcp-token-summary]').textContent())?.trim(),
    `${allowChanges ? 'Can make changes' : 'Read only'}, never expires`,
    'the reveal summary',
  )
  const secret = keep(
    ((await shown.locator('[data-fresh-token] span[translate="no"]').textContent()) ?? '').trim(),
  )
  expect(/^qvt_[0-9a-f]{20,}$/.test(secret), 'the revealed token has the qvt_ shape')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await shown.waitFor({ state: 'detached' })
  const row = app.locator('[data-mcp-token]').filter({ hasText: name })
  await row.waitFor()
  eq(
    (await row.locator('[data-mcp-token-cell="access"]').textContent())
      ?.replace('Access ', '')
      .trim(),
    allowChanges ? 'Can make changes' : 'Read only',
    'the token list access cell',
  )
  return secret
}

/** Revokes a personal token on MCP access and waits for the revoked mark. */
async function revokeTokenInUi(name) {
  await openAccountMcp()
  const row = app.locator('[data-mcp-token]').filter({ hasText: name })
  await confirmTwice(
    row.getByRole('button', { name: 'Revoke this token', exact: true }),
    row.getByRole('button', { name: /^Confirm revocation/ }),
  )
  await row.getByText('revoked', { exact: true }).waitFor()
}

async function deleteTokenInUi(name) {
  await openAccountMcp()
  const row = app.locator('[data-mcp-token]').filter({ hasText: name })
  await confirmTwice(
    row.getByRole('button', { name: 'Delete revoked token', exact: true }),
    row.getByRole('button', { name: 'Confirm token deletion', exact: true }),
  )
  await row.waitFor({ state: 'detached' })
}

async function openUsers() {
  await app.goto(`${cfg.appOrigin}/app/~/settings/org-users`, { waitUntil: 'domcontentloaded' })
  await app.locator('[data-add-user]').waitFor({ timeout: 45_000 })
  // the roster has loaded once Atlas, the fixture's agent, is listed
  await app.locator('[data-agent-keyline]').first().waitFor()
}

/** Adds an agent with the given role on the Users page and returns its id
 *  and the secret of the key the page creates with it. */
async function createAgentInUi(name, role) {
  await openUsers()
  await app.getByRole('radio', { name: 'Agent', exact: true }).click()
  await app.getByRole('textbox', { name: 'New agent name', exact: true }).fill(name)
  await app.locator('[data-add-role]').selectOption(role)
  await app.locator('[data-add-user]').click()
  const fresh = app.locator('[data-fresh-agent]')
  await fresh.waitFor()
  expect(
    (await fresh.textContent())?.includes(`“${name}” created`),
    'the created notice names the agent',
  )
  const secret = keep(
    ((await fresh.locator('[data-fresh-key] span[translate="no"]').textContent()) ?? '').trim(),
  )
  expect(/^qva_[0-9a-f]{20,}$/.test(secret), 'the revealed key has the qva_ shape')
  await fresh.getByRole('button', { name: 'Done', exact: true }).click()
  await fresh.waitFor({ state: 'detached' })
  const row = app.locator('[data-user-row]').filter({ hasText: name })
  await row.waitFor()
  const id = await row.getAttribute('data-user-row')
  expect(id, 'the agent row has an id')
  return { id, secret }
}

/** Opens an agent's key panel on the Users page. */
async function openAgentKeys(agentId) {
  await openUsers()
  const panel = app.locator(`[data-agent-keys="${agentId}"]`)
  if (!(await panel.count())) {
    await app
      .locator(`[data-user-row="${agentId}"]`)
      .getByRole('button', { name: "Manage this agent's keys", exact: true })
      .click()
  }
  await panel.waitFor()
  return panel
}

async function createAgentKeyInUi(agentId, keyName) {
  const panel = await openAgentKeys(agentId)
  await panel.getByPlaceholder('Key name, e.g. CI runner').fill(keyName)
  await panel.locator(`[data-new-agent-key="${agentId}"]`).click()
  const fresh = panel.locator('[data-fresh-key]')
  await fresh.waitFor()
  const secret = keep(((await fresh.locator('span[translate="no"]').textContent()) ?? '').trim())
  expect(/^qva_[0-9a-f]{20,}$/.test(secret), 'the revealed key has the qva_ shape')
  await panel.getByRole('button', { name: 'Done', exact: true }).click()
  await fresh.waitFor({ state: 'detached' })
  await panel.getByText(keyName, { exact: true }).waitFor()
  return secret
}

/** The row of one key in an agent's open key panel: the innermost element
 *  that holds both the key's name and a button. */
const keyRow = (panel, keyName) =>
  panel
    .locator('div')
    .filter({ hasText: keyName })
    .filter({ has: app.locator('button') })
    .last()

async function revokeAgentKeyInUi(agentId, keyName) {
  const row = keyRow(await openAgentKeys(agentId), keyName)
  await confirmTwice(
    row.getByRole('button', { name: 'Revoke this key', exact: true }),
    row.getByRole('button', { name: /^Confirm revocation/ }),
  )
  await row.getByText('revoked', { exact: true }).waitFor()
}

async function deleteAgentKeyInUi(agentId, keyName) {
  const panel = await openAgentKeys(agentId)
  const row = keyRow(panel, keyName)
  await confirmTwice(
    row.getByRole('button', { name: 'Delete this revoked key', exact: true }),
    row.getByRole('button', { name: 'Confirm key deletion', exact: true }),
  )
  await panel.getByText(keyName).waitFor({ state: 'detached' })
}

async function removeAgentInUi(agentId) {
  await openUsers()
  const row = app.locator(`[data-user-row="${agentId}"]`)
  await confirmTwice(
    row.getByRole('button', { name: /^Remove from the organization/ }),
    row.getByRole('button', { name: 'Click again to confirm removal', exact: true }),
  )
  await row.waitFor({ state: 'detached' })
  // The removal paints at once and saves in the background; a reload before
  // it is saved would drop it, so wait, then prove it with a cold reload.
  await settled()
  await openUsers()
  eq(await row.count(), 0, 'agent rows after a reload')
}

/** Deletes one OAuth connection on Connected apps. */
async function deleteConnectionInUi(clientName) {
  await openAccountMcp()
  await app.getByRole('group', { name: 'Connected apps', exact: true }).scrollIntoViewIfNeeded()
  const rows = app.locator('[data-oauth-connection]').filter({ hasText: clientName })
  await rows.first().waitFor()
  while (await rows.count()) {
    const id = await rows.first().getAttribute('data-oauth-connection')
    const row = app.locator(`[data-oauth-connection="${id}"]`)
    await row.getByRole('button', { name: 'Delete', exact: true }).click()
    await app
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete connection', exact: true })
      .click()
    await row.waitFor({ state: 'detached' })
  }
}

/** Archives a project of the run over REST and deletes it with the app's
 *  own store, which takes its sub-projects, tasks, comments, files, grants
 *  and milestones, then waits until REST no longer finds it. */
async function deleteProjectInApp(cred, project) {
  const current = await rest(cred, 'GET', `/projects/${project.id}`)
  if (current.status === 404) return
  if (!current.json?.archived)
    await restOk(cred, 'PATCH', `/projects/${project.id}`, { archived: true })
  await app.waitForFunction(
    (id) => window.PLANNER.archivedProjects?.some((x) => x.id === id),
    project.id,
    { timeout: 30_000 },
  )
  await evaluate(app, (id) => window.PLANNER.removeProject(id), project.id)
  await settled()
  expect(
    await until(async () => (await rest(cred, 'GET', `/projects/${project.id}`)).status === 404),
    `project ${project.name} is still there`,
  )
}

/** Runs `call(arg)` in the app and collects the toasts and console errors
 *  it causes, which hold a refusal's sentence. It waits up to 15 seconds for
 *  the first one, because a refusal comes after the server round trip.
 *  Nothing collected is printed, and a secret `call` answers stays in memory. */
async function appMessages(call, arg) {
  await evaluate(app, () => {
    const hooks = { show: window.showToast, error: console.error, seen: [] }
    window.__stgchk = hooks
    window.showToast = (msg, tone) => {
      hooks.seen.push(String(msg))
      return hooks.show?.(msg, tone)
    }
    console.error = (...parts) => {
      hooks.seen.push(parts.map((p) => String(p?.data?.message ?? p?.message ?? p)).join(' '))
      return hooks.error(...parts)
    }
  })
  try {
    const value = (await evaluate(app, call, arg)) ?? null
    if (value?.secret) keep(value.secret)
    await until(async () => (await evaluate(app, () => window.__stgchk.seen.length)) > 0, 15_000)
    await sleep(500)
    return { value, seen: await evaluate(app, () => window.__stgchk.seen) }
  } finally {
    await evaluate(app, () => {
      window.showToast = window.__stgchk.show
      console.error = window.__stgchk.error
      delete window.__stgchk
    })
  }
}

/* --------------------------------------------------------------- cleanup */

/** Finds and removes everything whose name carries `tag` (a run's tag, or
 *  TAG_ANY for every run), in phases that each run whatever an earlier one
 *  did:
 *
 *  1. OAuth connections, personal tokens and agent keys, which need only
 *     the signed-in app, so no credential of a run outlives a REST outage;
 *  2. with a temporary token for REST reads, projects (with their tasks,
 *     comments, files, grants and milestones), tasks elsewhere and teams;
 *  3. the agents, each confirmed gone;
 *  4. the temporary token, then a fresh read of every list to prove that
 *     nothing with the tag is left.
 *
 *  OAuth client registrations cannot be deleted and stay. Answers how many
 *  records it removed and the problems it met, each one line that is safe
 *  to print. No phase stops another. */
async function sweep(tag, label) {
  const matches = (name) => hasTag(tag, name)
  let removed = 0
  const problems = []
  const note = (what) => {
    removed++
    say('NOTE', `${label}/removed`, what)
  }
  /** Runs one step; its failure is recorded and the sweep goes on. */
  const step = async (what, fn) => {
    try {
      await fn()
    } catch (error) {
      problems.push(`${what}: ${describe(error)}`)
      say('NOTE', `${label}/problem`, `${what}: ${describe(error)}`)
    }
  }
  /** A list the app reads on demand; null (a failed read) is a failure. */
  const appList = async (what, call) => {
    const rows = await evaluate(app, call)
    expect(Array.isArray(rows), `the app could not list ${what}`)
    return rows
  }
  const taggedAgents = async () =>
    (
      await evaluate(app, () =>
        window.PLANNER.users.filter((u) => u.isAgent).map((u) => ({ id: u.id, name: u.name })),
      )
    ).filter((a) => matches(a.name))

  // 1. credentials, through the app alone
  await step('OAuth connections', async () => {
    const rows = await appList('OAuth connections', () => window.PLANNER.listOAuthConnections())
    for (const c of rows.filter((c) => matches(c.clientName)))
      await step(`OAuth connection ${c.clientName}`, async () => {
        expect(
          await evaluate(app, (id) => window.PLANNER.revokeOAuthConnection(id), c.id),
          'the app could not delete it',
        )
        note(`OAuth connection ${c.clientName}`)
      })
  })
  await step('personal tokens', async () => {
    const rows = await appList('personal tokens', () => window.PLANNER.listMcpTokens())
    for (const t of rows.filter((t) => matches(t.name)))
      await step(`personal token ${t.name}`, async () => {
        expect(
          await removeTokenInApp(t.id, !!t.revokedAt),
          'the app could not revoke and delete it',
        )
        note(`personal token ${t.name}`)
      })
  })
  const agentIds = new Set()
  await step('agent keys', async () => {
    const agents = await taggedAgents()
    for (const a of agents) agentIds.add(a.id)
    if (!agents.length) return
    const keys = await appList('agent keys', () => window.PLANNER.listAgentKeys())
    for (const key of keys.filter((k) => agentIds.has(k.agentId))) {
      const agent = agents.find((a) => a.id === key.agentId)
      await step(`agent key ${key.name} of ${agent.name}`, async () => {
        expect(
          await evaluate(
            app,
            async ({ id, revoked }) =>
              (revoked || (await window.PLANNER.revokeAgentKey(id))) &&
              (await window.PLANNER.deleteAgentKey(id)),
            { id: key.id, revoked: !!key.revokedAt },
          ),
          'the app could not revoke and delete it',
        )
        note(`agent key ${key.name} of ${agent.name}`)
      })
    }
  })

  // 2. records found over REST, with a temporary token minted in the app
  // like the New token dialog does. It ends after a day, should a killed
  // sweep never remove it.
  const tokenName = `${typeof tag === 'string' ? tag : `${TAG_PREFIX}000000`} cleanup token`
  let minted = null
  let cleaner = null
  await step('creating the temporary cleanup token', async () => {
    minted = await evaluate(
      app,
      async ([name, expiresAt]) =>
        window.PLANNER.createMcpToken(name, { access: 'write', expiresAt }),
      [tokenName, new Date(Date.now() + 86_400_000).toISOString()],
    )
    expect(minted?.secret, 'the app could not create it')
    cleaner = {
      secret: keep(minted.secret),
      profile: 'nora',
      label: 'cleanup token',
    }
  })
  try {
    if (cleaner) {
      await step('projects', async () => {
        const projects = [
          ...(await readList(cleaner, '/projects')),
          ...(await readList(cleaner, '/projects?archived=true')),
        ].filter((p) => matches(p.name))
        // the app deletes a top-level project with its sub-projects
        for (const p of projects.filter((p) => !projects.some((q) => q.id === p.parent_id)))
          await step(`project ${p.name}`, async () => {
            await deleteProjectInApp(cleaner, p)
            note(`project ${p.name}`)
          })
      })
      await step('tasks', async () => {
        for (const task of await findTasks(cleaner, tag))
          await step(`task ${task.key}`, async () => {
            const r = await rest(cleaner, 'DELETE', `/tasks/${task.id}`)
            expect(r.status === 200 || r.status === 404, `DELETE answered HTTP ${r.status}`)
            note(`task ${task.key} ${task.title}`)
          })
      })
      await step('teams', async () => {
        for (const team of (await readList(cleaner, '/teams')).filter((t) => matches(t.name)))
          await step(`team ${team.name}`, async () => {
            await app.waitForFunction((id) => window.PLANNER.canDeleteTeam(id), team.id, {
              timeout: 30_000,
            })
            expect(
              await evaluate(
                app,
                (id) =>
                  window.PLANNER.removeAccess({ kind: 'deleteTeam', teamId: id }, { to: null }, []),
                team.id,
              ),
              'the app could not delete it',
            )
            note(`team ${team.name}`)
          })
      })
    }

    // 3. the agents, whose keys went in phase 1. The app removes an agent
    // in the background, so each removal is confirmed on the server.
    await step('agents', async () => {
      for (const agent of await taggedAgents()) {
        agentIds.add(agent.id)
        await step(`agent ${agent.name}`, async () => {
          await evaluate(app, (id) => window.PLANNER.removeUser(id), agent.id)
          await settled()
          expect(
            await until(async () =>
              cleaner
                ? !(await readList(cleaner, '/users')).some((u) => u.id === agent.id)
                : !(await agentListedAfterReload(agent.id)),
            ),
            'it is still in the organization',
          )
          note(`agent ${agent.name}`)
        })
      }
    })

    // what REST can see must be gone before the token goes
    if (cleaner)
      await step('the check for leftovers over REST', async () => {
        const projects = [
          ...(await readList(cleaner, '/projects')),
          ...(await readList(cleaner, '/projects?archived=true')),
        ].filter((p) => matches(p.name))
        const tasks = await findTasks(cleaner, tag)
        const teams = (await readList(cleaner, '/teams')).filter((t) => matches(t.name))
        const users = (await readList(cleaner, '/users')).filter(
          (u) => u.kind === 'agent' && matches(u.name),
        )
        const left = [
          [projects.length, 'project'],
          [tasks.length, 'task'],
          [teams.length, 'team'],
          [users.length, 'agent'],
        ].filter(([n]) => n > 0)
        expect(
          !left.length,
          `still there: ${left.map(([n, what]) => `${n} ${what}(s)`).join(', ')}`,
        )
      })
    if (cleaner) {
      // A deployment with Deleted items keeps deleted projects and tasks
      // there, where only an admin's Delete now in the app removes them early.
      const catalogue = await mcp(cleaner, 'tools/list', {}).catch(() => null)
      const deleteTask = catalogue?.json?.result?.tools?.find((t) => t.name === 'delete_task')
      if (deleteTask?.description?.includes('Deleted items'))
        say(
          'NOTE',
          `${label}/deleted-items`,
          `this deployment keeps the deleted projects and tasks in Deleted items for 30 days; an admin can delete the ones named ${tag instanceof RegExp ? `${TAG_PREFIX}…` : tag} for good there`,
        )
    }
  } finally {
    // 4. the temporary token, then a fresh look at every app list
    if (minted?.id)
      await step('removing the temporary cleanup token', async () => {
        expect(await removeTokenInApp(minted.id, false), 'the app could not revoke and delete it')
      })
  }
  await step('the check for leftovers in the app', async () => {
    // a cold reload, so no list comes from what this page painted
    await openUsers()
    const tokens = (await appList('personal tokens', () => window.PLANNER.listMcpTokens())).filter(
      (t) => matches(t.name),
    )
    const connections = (
      await appList('OAuth connections', () => window.PLANNER.listOAuthConnections())
    ).filter((c) => matches(c.clientName))
    const agents = await taggedAgents()
    const keys = (await appList('agent keys', () => window.PLANNER.listAgentKeys())).filter((k) =>
      agentIds.has(k.agentId),
    )
    const left = [
      [tokens.length, 'personal token'],
      [connections.length, 'OAuth connection'],
      [agents.length, 'agent'],
      [keys.length, 'agent key'],
    ].filter(([n]) => n > 0)
    expect(!left.length, `still there: ${left.map(([n, what]) => `${n} ${what}(s)`).join(', ')}`)
  })
  return { removed, problems }
}

/** Revokes (unless it already is) and deletes one of Nora's personal
 *  tokens through the app's store. Answers whether both were accepted. */
async function removeTokenInApp(id, revoked) {
  return await evaluate(
    app,
    async ({ id, revoked }) =>
      (revoked || (await window.PLANNER.revokeMcpToken(id))) &&
      (await window.PLANNER.deleteMcpToken(id)),
    { id, revoked },
  )
}

/** Whether the Users page lists an agent after a cold reload. */
async function agentListedAfterReload(id) {
  await openUsers()
  return await evaluate(app, (agent) => window.PLANNER.users.some((u) => u.id === agent), id)
}

/** Tasks whose title carries the tag, active and archived. The default
 *  list holds the active tasks of active projects only, so the active tasks
 *  of each archived project, a sub-project archived on its own included, are
 *  read by naming that project. Archived tasks are listed one top-level
 *  project at a time, active and archived ones. */
async function findTasks(cred, tag) {
  const fragment = typeof tag === 'string' ? tag : TAG_PREFIX
  const found = new Map()
  const take = (rows) => {
    for (const row of rows ?? []) if (hasTag(tag, row.title)) found.set(row.id, row)
  }
  const search = encodeURIComponent(fragment)
  /** Pages one active list with offset until a page is short. */
  const readActive = async (scope) => {
    for (let offset = 0; ; offset += 200) {
      const page = await readList(
        cred,
        `/tasks?${scope}search=${search}&limit=200&offset=${offset}`,
      )
      take(page)
      if (page.length < 200) break
    }
  }
  await readActive('')
  const archivedProjects = await readList(cred, '/projects?archived=true')
  for (const p of archivedProjects) await readActive(`project=${p.id}&`)
  const projects = [...(await readList(cred, '/projects')), ...archivedProjects].filter(
    (p) => p.parent_id === null,
  )
  for (const p of projects) {
    let cursor = null
    for (let i = 0; i < 200; i++) {
      const q = `/tasks?archived=true&project=${p.id}&search=${search}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page = await readOk(cred, q)
      expect(Array.isArray(page?.tasks), 'an archived page answered no tasks')
      take(page.tasks)
      cursor = page.next_cursor ?? null
      if (!cursor) break
    }
  }
  return [...found.values()]
}

/* ------------------------------------------------------------- the checks */

const PERSON_READ_ONLY = 'this credential can only read'
const VIEWER_READ_ONLY = 'this agent is a Viewer and can only read'
const AGENT_NO_WRITE = 'this agent has no write access to that project'
const MCP_NO_WRITE = 'your account has no write access to that project'
const REST_MISSING = 'missing agent key (Authorization: Bearer qva_…)'
const OAUTH_GONE = 'OAuth connection is invalid, expired or disconnected'
/** A write that kept conflicting, or kept running out of time, and changed
 *  nothing (convex/machine/shared.ts WRITE_CONFLICT_MESSAGE and
 *  WRITE_TIMEOUT_MESSAGE): REST's 503 error and MCP's tool error. */
export const WRITE_CONFLICT =
  'the request conflicted with other changes made at the same time and changed nothing; send it again'
const WRITE_TIMEOUT =
  'the request took too long and changed nothing; send it again, or change less at once if it keeps happening'
const changedNothing = (error) => error === WRITE_CONFLICT || error === WRITE_TIMEOUT
const NOT_SAME_FAMILY =
  'a subtask must be in the same project as its parent task, in any of its sub-projects'
const UPLOAD_MISSING = 'upload not found or expired; start a new upload'
const UPLOAD_URL_USED = 'this upload URL has already been used; start a new upload'
const UNKNOWN_PROJECT = 'project must name a project by uuid, number or key'
const GROUP_STATUS = 'status cannot be set on a task with subtasks, so update its subtasks instead'

/** The state the checks share. */
const run = {}

/** Whether `cred` may write `project` (one of run.projects). */
function writes(cred, project) {
  const inverted = cred.group && cfg.invert.has(cred.group)
  const credentialWrites = cred.canWrite !== !!inverted
  if (!credentialWrites) return false
  if (cred.who === 'std') {
    if (project === 'A') return true
    return project === 'Z' && cfg.invert.has('other-project')
  }
  return cred.who !== 'viewer'
}

/** `GET /v1/me` and `get_me` describe the credential and its user. */
async function checkIdentity(cred) {
  const expectedAccess = cred.canWrite !== (cred.group ? cfg.invert.has(cred.group) : false)
  const verify = (me, surface) => {
    eq(me.user.name, cred.actor, `${surface} user name`)
    eq(me.user.kind, cred.who === 'nora' ? 'person' : 'agent', `${surface} user kind`)
    eq(me.organization.slug, ORG_SLUG, `${surface} organization`)
    eq(me.credential.kind, cred.kind, `${surface} credential kind`)
    eq(me.credential.access, expectedAccess ? 'write' : 'read', `${surface} credential access`)
    eq(me.credential.name, cred.name, `${surface} credential name`)
    eq(me.credential.expires_at, null, `${surface} expiry`)
    eq(me.billing.read_only, false, `${surface} billing pause`)
  }
  if (cred.kind !== 'oauth') {
    await check(`${cred.id}/rest/me`, async () => verify(await restOk(cred, 'GET', '/me'), 'REST'))
  } else {
    await check(`${cred.id}/rest/refused`, async () => {
      const r = await rest(cred, 'GET', '/me')
      expect(
        r.status === 401 && r.json?.error === REST_MISSING,
        `wanted 401 ${short(REST_MISSING)}, got ${r.status} ${short(r.json?.error)}`,
      )
    })
  }
  await check(`${cred.id}/mcp/get_me`, async () => verify(await toolOk(cred, 'get_me'), 'MCP'))
}

/** Reads every credential should manage over REST and MCP. */
async function checkReads(cred) {
  const { M, A, Z } = run.projects
  const flagsOk = (rows, surface) => {
    for (const [key, p] of Object.entries({ M, A, Z })) {
      const row = rows.find((r) => r.id === p.id)
      expect(row, `${surface} project list lacks ${p.name}`)
      eq(row.access.read, true, `${surface} read flag on ${key}`)
      eq(row.access.write, writes(cred, key), `${surface} write flag on ${key}`)
    }
  }
  if (cred.kind !== 'oauth') {
    await check(`${cred.id}/rest/reads`, async () => {
      flagsOk(await restOk(cred, 'GET', '/projects'), 'REST')
      const detail = await restOk(cred, 'GET', `/projects/${A.id}`)
      eq(detail.lead_name, run.nora.name, 'project lead')
      const tasks = await restOk(cred, 'GET', `/tasks?project=${M.id}&limit=200`)
      expect(
        tasks.some((t) => t.id === run.t0.id),
        'the task list lacks the fixture task',
      )
      eq((await restOk(cred, 'GET', `/tasks/${run.t0.key}`)).title, run.t0.title, 'task title')
      expect(Array.isArray(await restOk(cred, 'GET', `/tasks/${run.t0.key}/comments`)), 'comments')
      expect(Array.isArray(await restOk(cred, 'GET', `/tasks/${run.t0.key}/activity`)), 'activity')
      expect(
        Array.isArray(await restOk(cred, 'GET', `/tasks/${run.t0.key}/attachments`)),
        'attachments',
      )
      const users = await restOk(cred, 'GET', '/users')
      expect(
        users.some((u) => u.id === run.agents.std.id),
        'the roster lacks the Standard agent',
      )
      await restOk(cred, 'GET', '/labels')
      await restOk(cred, 'GET', '/teams')
      await restOk(cred, 'GET', '/workload?weeks=1')
      return 'me, projects, project, tasks, task, comments, activity, attachments, users, labels, teams, workload'
    })
  }
  await check(`${cred.id}/mcp/reads`, async () => {
    flagsOk(await toolOk(cred, 'list_projects'), 'MCP')
    eq((await toolOk(cred, 'get_project', { project: A.id })).id, A.id, 'get_project')
    const tasks = await toolOk(cred, 'list_tasks', { project: M.id, limit: 200 })
    expect(
      tasks.some((t) => t.id === run.t0.id),
      'list_tasks lacks the fixture task',
    )
    eq((await toolOk(cred, 'get_task', { ref: run.t0.key })).title, run.t0.title, 'get_task')
    expect(Array.isArray(await toolOk(cred, 'list_comments', { ref: run.t0.key })), 'list_comments')
    expect(Array.isArray(await toolOk(cred, 'list_task_activity', { ref: run.t0.key })), 'activity')
    expect(
      (await toolOk(cred, 'list_users')).some((u) => u.id === run.agents.std.id),
      'list_users',
    )
    await toolOk(cred, 'list_teams')
    await toolOk(cred, 'get_workload', { weeks: 1 })
    return 'list_projects, get_project, list_tasks, get_task, list_comments, list_task_activity, list_users, list_teams, get_workload'
  })
}

/** Activity rows of a task: each is signed by the actor and ends with the
 *  credential's provenance, and the lifecycle wrote each verb. */
function verifyActivity(rows, cred, provenance) {
  const verbs = rows.map((r) => r.verb)
  for (const verb of ['created', 'changed', 'archived', 'restored'])
    expect(verbs.includes(verb), `no ${verb} activity row (rows: ${short(verbs)})`)
  for (const row of rows) {
    eq(row.actor_name, cred.actor, `actor of the ${row.verb} row`)
    expect(
      row.detail === provenance || row.detail?.endsWith(`, ${provenance}`),
      `the ${row.verb} row detail ${short(row.detail)} does not end with ${short(provenance)}`,
    )
  }
  eq(rows.find((r) => r.verb === 'created').detail, provenance, 'created row detail')
}

/** Create, update, comment, edit the comment, archive with a reason and
 *  restore a task over REST, then check the activity attribution. */
async function restLifecycle(cred, label) {
  const id = `${cred.id}/rest/lifecycle`
  const title = `${run.tag} ${label} REST task`
  let task
  await check(`${id}/create`, async () => {
    task = await restOk(cred, 'POST', '/tasks', {
      project: run.projects.A.id,
      title,
      description: `Created by the staging check with the ${label}.`,
      priority: 'medium',
      remaining_hours: 3,
    })
    eq(task.title, title, 'title')
    eq(task.project_id, run.projects.A.id, 'project')
    eq(task.reporter_id, cred.userId, 'reporter')
    eq(task.reporter_name, cred.actor, 'reporter name')
  })
  if (!task) return null
  run.created.push(task)
  await check(`${id}/update`, async () => {
    const t = await restOk(cred, 'PATCH', `/tasks/${task.key}`, {
      status: 'progress',
      priority: 'high',
      remaining_hours: 5,
    })
    eq(t.status, 'progress', 'status')
    eq(t.priority, 'high', 'priority')
    eq(t.remaining_hours, 5, 'remaining hours')
  })
  await check(`${id}/comment`, async () => {
    const comment = await restOk(cred, 'POST', `/tasks/${task.key}/comments`, {
      body: `${run.tag} comment by the ${label}`,
    })
    eq(comment.author_id, cred.userId, 'comment author')
    eq(comment.author_name, cred.actor, 'comment author name')
    const edited = await restOk(cred, 'PATCH', `/comments/${comment.id}`, {
      body: `${run.tag} comment by the ${label}, edited`,
    })
    eq(edited.edited_by_id, cred.userId, 'editor')
    expect(edited.edited_at, 'edited_at is set')
  })
  const reason = `${run.tag} archived by the ${label}`
  await check(`${id}/archive`, async () => {
    const t = await restOk(cred, 'PATCH', `/tasks/${task.key}`, {
      archived: true,
      archive_reason: reason,
    })
    eq(t.archived, true, 'archived')
    const active = await restOk(cred, 'GET', `/tasks?project=${run.projects.M.id}&limit=200`)
    expect(!active.some((r) => r.id === task.id), 'an archived task is in the active list')
    const comments = await restOk(cred, 'GET', `/tasks/${task.key}/comments`)
    const posted = comments.find((c) => c.body === reason)
    expect(posted, 'the archive reason was not posted as a comment')
    eq(posted.author_name, cred.actor, 'archive reason author')
  })
  await check(`${id}/restore`, async () => {
    const t = await restOk(cred, 'PATCH', `/tasks/${task.key}`, { archived: false })
    eq(t.archived, false, 'archived after restore')
    const active = await restOk(cred, 'GET', `/tasks?project=${run.projects.M.id}&limit=200`)
    expect(
      active.some((r) => r.id === task.id),
      'a restored task is missing from the active list',
    )
  })
  await check(`${id}/activity`, async () => {
    verifyActivity(
      await restOk(cred, 'GET', `/tasks/${task.key}/activity`),
      cred,
      cred.restProvenance,
    )
    return `actor ${cred.actor}, ${cred.restProvenance}`
  })
  return task
}

/** The same lifecycle over MCP, signed `via MCP`. */
async function mcpLifecycle(cred, label) {
  const id = `${cred.id}/mcp/lifecycle`
  const title = `${run.tag} ${label} MCP task`
  let task
  await check(`${id}/create`, async () => {
    const made = await toolOk(cred, 'create_task', {
      project: run.projects.A.id,
      title,
      priority: 'medium',
      remaining_hours: 3,
    })
    expect(made.id && made.key, 'create_task returned no id and key')
    task = await toolOk(cred, 'get_task', { ref: made.key })
    eq(task.title, title, 'title')
    eq(task.reporter_id, cred.userId, 'reporter')
  })
  if (!task) return null
  run.created.push(task)
  await check(`${id}/update`, async () => {
    await toolOk(cred, 'update_task', { ref: task.key, status: 'progress', priority: 'high' })
    const t = await toolOk(cred, 'get_task', { ref: task.key })
    eq(t.status, 'progress', 'status')
    eq(t.priority, 'high', 'priority')
  })
  await check(`${id}/comment`, async () => {
    const made = await toolOk(cred, 'add_comment', {
      ref: task.key,
      body: `${run.tag} comment by the ${label}`,
    })
    expect(made.id, 'add_comment returned no id')
    await toolOk(cred, 'update_comment', {
      comment: made.id,
      body: `${run.tag} comment by the ${label}, edited`,
    })
    const thread = await toolOk(cred, 'list_comments', { ref: task.key })
    const c = thread.find((x) => x.id === made.id)
    expect(c, 'the comment is missing from list_comments')
    eq(c.author_name, cred.actor, 'comment author')
    eq(c.edited_by_id, cred.userId, 'editor')
  })
  const reason = `${run.tag} archived by the ${label} over MCP`
  await check(`${id}/archive`, async () => {
    await toolOk(cred, 'update_task', { ref: task.key, archived: true, archive_reason: reason })
    expect((await toolOk(cred, 'get_task', { ref: task.key })).archived_at, 'archived_at is set')
    const active = await toolOk(cred, 'list_tasks', { project: run.projects.M.id, limit: 200 })
    expect(!active.some((r) => r.id === task.id), 'an archived task is in list_tasks')
    const thread = await toolOk(cred, 'list_comments', { ref: task.key })
    eq(thread.find((c) => c.body === reason)?.author_name, cred.actor, 'archive reason author')
  })
  await check(`${id}/restore`, async () => {
    await toolOk(cred, 'update_task', { ref: task.key, archived: false })
    eq((await toolOk(cred, 'get_task', { ref: task.key })).archived_at, null, 'archived_at')
  })
  await check(`${id}/activity`, async () => {
    verifyActivity(await toolOk(cred, 'list_task_activity', { ref: task.key }), cred, 'via MCP')
    return `actor ${cred.actor}, via MCP`
  })
  return task
}

/** Every write a read-only credential tries is refused with its sentence,
 *  before any reference is resolved, and leaves the task as it was. */
async function checkReadOnly(cred, sentence) {
  const g = cred.group
  const t0 = run.t0
  if (cred.kind !== 'oauth') {
    const restCases = [
      ['create', 'POST', '/tasks', { project: run.projects.A.id, title: `${run.tag} refused` }],
      ['update', 'PATCH', `/tasks/${t0.key}`, { title: `${run.tag} refused title` }],
      ['update-unknown-ref', 'PATCH', '/tasks/QN-99999999', { title: 'x' }],
      ['comment', 'POST', `/tasks/${t0.key}/comments`, { body: `${run.tag} refused comment` }],
      ['archive', 'PATCH', `/tasks/${t0.key}`, { archived: true }],
      ['delete', 'DELETE', `/tasks/${t0.key}`, undefined],
      ['follow', 'PUT', `/tasks/${t0.key}/following`, undefined],
      ['project-create', 'POST', '/projects', { name: `${run.tag} refused project` }],
    ]
    for (const [name, method, path, body] of restCases)
      await refused(`${cred.id}/rest/refuse/${name}`, g, async () =>
        restOutcome(await rest(cred, method, path, body), 403, sentence),
      )
  }
  const mcpCases = [
    ['create_task', { project: run.projects.A.id, title: `${run.tag} refused` }],
    ['update_task', { ref: t0.key, title: `${run.tag} refused title` }],
    ['update_task', { ref: 'QN-99999999', title: 'x' }, 'update_task-unknown-ref'],
    ['add_comment', { ref: t0.key, body: `${run.tag} refused comment` }],
    ['update_task', { ref: t0.key, archived: true }, 'archive'],
    ['delete_task', { ref: t0.key }],
    ['set_following', { ref: t0.key, following: true }],
  ]
  for (const [name, args, label = name] of mcpCases)
    await refused(`${cred.id}/mcp/refuse/${label}`, g, async () =>
      cred.kind === 'oauth'
        ? scopeOutcome(await tool(cred, name, args))
        : toolOutcome(await tool(cred, name, args), sentence),
    )
  if (cred.kind === 'oauth')
    await refused(`${cred.id}/mcp-legacy/refuse/create_task`, g, async () =>
      scopeOutcome(
        await tool(
          cred,
          'create_task',
          { project: run.projects.A.id, title: `${run.tag} refused` },
          { legacy: true },
        ),
      ),
    )
  await check(`${cred.id}/refusals-changed-nothing`, async () => {
    const t = await restOk(run.creds.writeToken, 'GET', `/tasks/${t0.key}`)
    eq(t.title, t0.title, 'title')
    eq(t.archived, false, 'archived')
    const comments = await restOk(run.creds.writeToken, 'GET', `/tasks/${t0.key}/comments`)
    expect(!comments.some((c) => c.body.includes('refused comment')), 'a refused comment landed')
    const tasks = await restOk(
      run.creds.writeToken,
      'GET',
      `/tasks?project=${run.projects.M.id}&limit=200`,
    )
    expect(!tasks.some((x) => x.title === `${run.tag} refused`), 'a refused task was created')
  })
}

/** A Standard agent with only a viewer role on Zulu may not write there. */
async function checkOtherProject(cred) {
  const g = 'other-project'
  const tz = run.tz
  await refused(`${cred.id}/rest/refuse/create-in-viewer-project`, g, async () =>
    restOutcome(
      await rest(cred, 'POST', '/tasks', {
        project: run.projects.Z.id,
        title: `${run.tag} refused in Zulu`,
      }),
      403,
      AGENT_NO_WRITE,
    ),
  )
  await refused(`${cred.id}/rest/refuse/update-in-viewer-project`, g, async () =>
    restOutcome(
      await rest(cred, 'PATCH', `/tasks/${tz.key}`, { title: `${run.tag} refused` }),
      403,
      AGENT_NO_WRITE,
    ),
  )
  await refused(`${cred.id}/mcp/refuse/create-in-viewer-project`, g, async () =>
    toolOutcome(
      await tool(cred, 'create_task', {
        project: run.projects.Z.id,
        title: `${run.tag} refused in Zulu`,
      }),
      MCP_NO_WRITE,
    ),
  )
  await refused(`${cred.id}/mcp/refuse/update-in-viewer-project`, g, async () =>
    toolOutcome(
      await tool(cred, 'update_task', { ref: tz.key, title: `${run.tag} refused` }),
      MCP_NO_WRITE,
    ),
  )
  await check(`${cred.id}/reads-viewer-project`, async () => {
    eq((await restOk(cred, 'GET', `/tasks/${tz.key}`)).title, tz.title, 'REST read in Zulu')
    eq((await toolOk(cred, 'get_task', { ref: tz.key })).title, tz.title, 'MCP read in Zulu')
  })
}

/** After revocation the next REST and MCP calls answer 401. */
async function checkRevoked(cred, restSentence, mcpSentence) {
  if (cred.kind !== 'oauth')
    await refused(`${cred.id}/revoked/rest`, 'revoked', async () =>
      restOutcome(await rest(cred, 'GET', '/me'), 401, restSentence),
    )
  await refused(`${cred.id}/revoked/mcp`, 'revoked', async () =>
    mcp401Outcome(await mcp(cred, 'tools/call', { name: 'get_me', arguments: {} }), mcpSentence),
  )
}

/* ---------------------------------------------------------- attachments */

/** Refuses an upload URL that is not this deployment's single-use Qivo
 *  upload URL, /attachment-uploads/{ticket} on the API origin (#166). */
function checkUploadUrl(value) {
  keep(value)
  let u
  try {
    u = new URL(value)
  } catch {
    fail('the upload URL is not a URL')
  }
  expect(
    onApi(value) && u.pathname.startsWith('/attachment-uploads/'),
    'the upload URL is not on this deployment',
  )
}

/** POSTs `bytes` to a ticket's upload URL and answers the status and the
 *  JSON body. A large body gets `timeoutMs` to arrive. */
async function postUpload(uploadUrl, bytes, type, timeoutMs) {
  checkUploadUrl(uploadUrl)
  const r = await request(
    uploadUrl,
    { method: 'POST', headers: { 'Content-Type': type }, body: bytes },
    timeoutMs,
  )
  return { status: r.status, json: await r.json().catch(() => null) }
}

/** Sends the bytes to a ticket's upload URL and answers the storage id. */
async function putBytes(uploadUrl, bytes, type, timeoutMs) {
  const r = await postUpload(uploadUrl, bytes, type, timeoutMs)
  expect(
    r.status === 200,
    `the upload answered HTTP ${r.status}${r.json?.error ? ` ${short(r.json.error)}` : ''}`,
  )
  const storageId = r.json?.storageId
  expect(typeof storageId === 'string', 'the upload answered no storageId')
  return storageId
}

/** Downloads an attachment link, which must be on the API origin. A server
 *  error or a network failure is tried once more, like any other read. A
 *  file at the per-file limit gets five minutes to arrive. */
async function download(url) {
  keep(url)
  const u = new URL(url)
  expect(onApi(url) && u.pathname.startsWith('/files/'), 'a file link is not on this API origin')
  for (let attempt = 0; ; attempt++) {
    let r
    try {
      r = await request(url, {}, 300_000)
    } catch (error) {
      if (attempt > 0 || error instanceof CheckError) throw error
    }
    if (r && (r.status < 500 || attempt > 0))
      return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) }
    await r?.arrayBuffer().catch(() => {})
    results.retried++
    say('NOTE', 'server-error', 'a download failed; sending it once more')
    await sleep(2000)
  }
}

/** The attachment's stored bytes equal `bytes`. */
async function sameBytes(att, bytes, type) {
  eq(att.size_bytes, bytes.length, 'size_bytes')
  eq(att.content_type, type, 'content_type')
  eq(att.inline, false, 'inline')
  const got = await download(att.url)
  eq(got.status, 200, 'download status')
  eq(
    createHash('sha256').update(got.bytes).digest('hex'),
    createHash('sha256').update(bytes).digest('hex'),
    'downloaded bytes',
  )
}

const sampleFile = () => ({ bytes: randomBytes(3000), type: 'application/octet-stream' })

/** Uploads over REST with the three requests, downloads and compares.
 *  `confirmed(att)` runs as soon as the file is attached, so a later failed
 *  comparison still leaves it to delete. */
async function restUpload(cred, task, name, confirmed) {
  const { bytes, type } = sampleFile()
  const start = await restOk(cred, 'POST', `/tasks/${task.key}/attachments`, {
    name,
    content_type: type,
    size: bytes.length,
  })
  expect(start.ticket && start.upload_url && start.expires_at, 'the start answered no ticket')
  const storage_id = await putBytes(start.upload_url, bytes, type)
  const att = await restOk(cred, 'POST', `/tasks/${task.key}/attachments/${start.ticket}`, {
    storage_id,
  })
  confirmed(att)
  eq(att.name, name, 'name')
  eq(att.uploaded_by_id, cred.userId, 'uploaded by')
  await sameBytes(att, bytes, type)
  const listed = await restOk(cred, 'GET', `/tasks/${task.key}/attachments`)
  expect(
    listed.some((a) => a.id === att.id),
    'the attachment list lacks the file',
  )
  return att
}

/** Uploads over MCP: start_attachment_upload, the bytes, then the confirm.
 *  `confirmed` as for restUpload. */
async function mcpUpload(cred, task, name, confirmed) {
  const { bytes, type } = sampleFile()
  const start = await toolOk(cred, 'start_attachment_upload', {
    ref: task.key,
    name,
    size: bytes.length,
    content_type: type,
  })
  expect(start.ticket && start.upload_url && start.expires_at, 'the start answered no ticket')
  const storage_id = await putBytes(start.upload_url, bytes, type)
  const att = await toolOk(cred, 'confirm_attachment_upload', {
    ref: task.key,
    ticket: start.ticket,
    storage_id,
  })
  confirmed(att)
  eq(att.name, name, 'name')
  eq(att.uploaded_by_id, cred.userId, 'uploaded by')
  await sameBytes(att, bytes, type)
  const listed = (await toolOk(cred, 'get_task', { ref: task.key })).attachments
  expect(
    listed.some((a) => a.id === att.id),
    'get_task lacks the file',
  )
  return att
}

/** Uploads with every credential that may, refuses the others and deletes
 *  every file again. */
async function uploadChecks() {
  const { writeToken: w, stdKey: s, oauthWrite: o, readToken, viewerKey, oauthRead } = run.creds
  const task = await must('uploads/task', () =>
    restOk(w, 'POST', '/tasks', { project: run.projects.A.id, title: `${run.tag} uploads` }),
  )
  run.created.push(task)
  const made = []
  const keepFile = (att, cred, surface) => {
    if (att) made.push({ att, cred, surface })
    return att
  }
  for (const [cred, surface] of [
    [w, 'rest'],
    [w, 'mcp'],
    [s, 'mcp'],
    [o, 'mcp'],
  ]) {
    await check(`${cred.id}/${surface}/upload`, async () => {
      const name = `${run.tag} ${cred.id} ${surface}.bin`
      const confirmed = (att) => keepFile(att, cred, surface)
      await (surface === 'rest' ? restUpload : mcpUpload)(cred, task, name, confirmed)
      return 'uploaded, downloaded and compared'
    })
  }
  // An upload URL stores one file (#166): a body of another size stores
  // nothing and leaves it usable, a second POST is refused, and once the
  // upload is confirmed the URL is gone.
  await check('write-token/rest/upload-url-once', async () => {
    const { bytes, type } = sampleFile()
    const start = await restOk(w, 'POST', `/tasks/${task.key}/attachments`, {
      name: `${run.tag} once.bin`,
      content_type: type,
      size: bytes.length,
    })
    const wrong = await postUpload(start.upload_url, bytes.subarray(1), type)
    eq(wrong.status, 400, 'a body one byte short')
    eq(wrong.json?.error, `the upload must be exactly the ${bytes.length} bytes declared`, 'error')
    const storage_id = await putBytes(start.upload_url, bytes, type)
    const again = await postUpload(start.upload_url, bytes, type)
    eq(again.status, 409, 'a second POST')
    eq(again.json?.error, UPLOAD_URL_USED, 'error')
    const att = await restOk(w, 'POST', `/tasks/${task.key}/attachments/${start.ticket}`, {
      storage_id,
    })
    keepFile(att, w, 'rest')
    await sameBytes(att, bytes, type)
    const after = await postUpload(start.upload_url, bytes, type)
    eq(after.status, 404, 'a POST after the confirm')
    eq(after.json?.error, UPLOAD_MISSING, 'error')
    return 'a short body 400, a second POST 409, after the confirm 404'
  })
  // One file at the organization's per-file limit through the REST ticket,
  // which shows whether the deployment takes a body that large in an HTTP
  // action. It is deleted again at once.
  await check('write-token/rest/upload-at-cap', async () => {
    const mb = (await restOk(w, 'GET', '/me')).organization.max_attachment_mb
    expect(Number.isInteger(mb) && mb > 0, 'max_attachment_mb is not a positive integer')
    const bytes = randomBytes(mb * 1024 * 1024)
    const type = 'application/octet-stream'
    const start = await restOk(w, 'POST', `/tasks/${task.key}/attachments`, {
      name: `${run.tag} at the cap.bin`,
      content_type: type,
      size: bytes.length,
    })
    const began = Date.now()
    const storage_id = await putBytes(start.upload_url, bytes, type, 600_000)
    const seconds = Math.round((Date.now() - began) / 1000)
    const att = await restOk(w, 'POST', `/tasks/${task.key}/attachments/${start.ticket}`, {
      storage_id,
    })
    // kept for uploads/delete until its own delete below succeeds
    const entry = { att, cred: w, surface: 'rest' }
    made.push(entry)
    try {
      await sameBytes(att, bytes, type)
    } finally {
      eq(
        (await restOk(w, 'DELETE', `/tasks/${task.key}/attachments/${att.id}`)).deleted,
        true,
        'deleted',
      )
      made.splice(made.indexOf(entry), 1)
    }
    return `${bytes.length} bytes (${mb} MiB) uploaded in ${seconds} s, confirmed, downloaded and deleted`
  })
  const text = `Staging check ${run.tag}\nGrüße aus Göteborg, 東京, 🙂\nline 3\n`
  for (const cred of [o, w]) {
    await check(`${cred.id}/mcp/attach_text_file`, async () => {
      const att = await toolOk(cred, 'attach_text_file', {
        ref: task.key,
        name: `${run.tag} ${cred.id} notes.txt`,
        text,
      })
      keepFile(att, cred, 'mcp')
      await sameBytes(att, Buffer.from(text, 'utf8'), 'text/plain; charset=utf-8')
    })
  }
  await check('write-token/mcp/attach_text_file-too-long', async () => {
    const before = (await toolOk(w, 'get_task', { ref: task.key })).attachments.length
    eq(
      await toolRefusal(w, 'attach_text_file', {
        ref: task.key,
        name: `${run.tag} too long.txt`,
        text: 'x'.repeat(LIMITS.textFile.max * 1024 + 1),
      }),
      LIMITS.textFile.refusal,
      'refusal',
    )
    eq((await toolOk(w, 'get_task', { ref: task.key })).attachments.length, before, 'files')
  })
  // a ticket belongs to the user: started over MCP, confirmed over REST
  await check('write-token/mcp-then-rest/upload', async () => {
    const { bytes, type } = sampleFile()
    const start = await toolOk(w, 'start_attachment_upload', {
      ref: task.key,
      name: `${run.tag} across surfaces.bin`,
      size: bytes.length,
      content_type: type,
    })
    const storage_id = await putBytes(start.upload_url, bytes, type)
    // another user's confirm finds no such upload
    eq(
      await toolRefusal(s, 'confirm_attachment_upload', {
        ref: task.key,
        ticket: start.ticket,
        storage_id,
      }),
      UPLOAD_MISSING,
      "the Standard agent confirming Nora's ticket",
    )
    const att = await restOk(w, 'POST', `/tasks/${task.key}/attachments/${start.ticket}`, {
      storage_id,
    })
    keepFile(att, w, 'rest')
    await sameBytes(att, bytes, type)
  })
  await check('write-token/mcp/upload-activity', async () => {
    const rows = await toolOk(w, 'list_task_activity', { ref: task.key })
    const attached = rows.filter((r) => r.verb === 'attached a file to')
    expect(
      attached.length >= made.length,
      `${attached.length} attach rows for ${made.length} files`,
    )
    expect(
      attached.some((r) => r.actor_name === s.actor && r.detail?.endsWith('via MCP')),
      'no attach row signed by the Standard agent via MCP',
    )
    expect(
      attached.some((r) => r.actor_name === w.actor && r.detail?.endsWith('via the REST API')),
      'no attach row signed via the REST API',
    )
  })
  // refusals: a ticket Nora started, which her read-only credentials try to confirm
  let pending = null
  let pendingStorage = null
  await check('uploads/pending-ticket', async () => {
    const { bytes, type } = sampleFile()
    pending = await toolOk(w, 'start_attachment_upload', {
      ref: task.key,
      name: `${run.tag} pending.bin`,
      size: bytes.length,
      content_type: type,
    })
    pendingStorage = await putBytes(pending.upload_url, bytes, type)
  })
  const start = { name: `${run.tag} refused.bin`, size: 10, content_type: 'text/plain' }
  for (const [cred, sentence] of [
    [readToken, PERSON_READ_ONLY],
    [viewerKey, VIEWER_READ_ONLY],
  ]) {
    await refused(`${cred.id}/rest/refuse/upload`, cred.group, async () =>
      restOutcome(await rest(cred, 'POST', `/tasks/${task.key}/attachments`, start), 403, sentence),
    )
    await refused(`${cred.id}/mcp/refuse/start_attachment_upload`, cred.group, async () =>
      toolOutcome(
        await tool(cred, 'start_attachment_upload', { ref: task.key, ...start }),
        sentence,
      ),
    )
    await refused(`${cred.id}/mcp/refuse/attach_text_file`, cred.group, async () =>
      toolOutcome(
        await tool(cred, 'attach_text_file', { ref: task.key, name: start.name, text: 'refused' }),
        sentence,
      ),
    )
  }
  await refused('read-token/mcp/refuse/confirm_attachment_upload', 'read-token', async () =>
    toolOutcome(
      await tool(readToken, 'confirm_attachment_upload', {
        ref: task.key,
        ticket: pending?.ticket ?? randomUUID(),
        storage_id: pendingStorage ?? 'none',
      }),
      PERSON_READ_ONLY,
    ),
  )
  for (const [name, args] of [
    ['start_attachment_upload', { ref: task.key, ...start }],
    ['attach_text_file', { ref: task.key, name: start.name, text: 'refused' }],
    [
      'confirm_attachment_upload',
      { ref: task.key, ticket: pending?.ticket ?? randomUUID(), storage_id: pendingStorage ?? 'x' },
    ],
  ])
    await refused(`oauth-read/mcp/refuse/${name}`, 'oauth-read', async () =>
      scopeOutcome(await tool(oauthRead, name, args)),
    )
  for (const [label, method, path, body] of [
    ['list', 'GET', `/tasks/${task.key}/attachments`, undefined],
    ['upload', 'POST', `/tasks/${task.key}/attachments`, start],
  ])
    await check(`oauth-write/rest/refuse/attachments-${label}`, async () => {
      const r = await rest(o, method, path, body)
      expect(
        r.status === 401 && r.json?.error === REST_MISSING,
        `wanted 401 ${short(REST_MISSING)}, got ${r.status} ${short(r.json?.error)}`,
      )
    })
  await check('uploads/refusals-attached-nothing', async () => {
    const files = (await restOk(w, 'GET', `/tasks/${task.key}/attachments`)).map((a) => a.id)
    same(files.toSorted(), made.map((m) => m.att.id).toSorted(), 'the task files')
  })
  // The refused confirms left the ticket usable. Confirming it attaches the
  // bytes, so the delete below removes them instead of the weekly sweep.
  if (pending && pendingStorage)
    await check('write-token/mcp/confirm-after-refusals', async () => {
      keepFile(
        await toolOk(w, 'confirm_attachment_upload', {
          ref: task.key,
          ticket: pending.ticket,
          storage_id: pendingStorage,
        }),
        w,
        'mcp',
      )
    })
  // delete every file, each with the credential and surface that made it
  // Every file is tried, so one failed delete does not keep the others on
  // the task, and deleteOutcome decides what each answer means.
  await check('uploads/delete', async () => {
    const failed = []
    for (const { att, cred, surface } of made) {
      let r
      try {
        r =
          surface === 'rest'
            ? await rest(cred, 'DELETE', `/tasks/${task.key}/attachments/${att.id}`)
            : await tool(cred, 'delete_attachment', { ref: task.key, attachment: att.id })
      } catch (error) {
        r = { status: 0, error: describe(error) }
      }
      const outcome = deleteOutcome(r, surface, att.id, task.key)
      if (outcome === 'deleted') continue
      if (outcome !== 'unsure') {
        failed.push(`${att.name}: ${outcome}`)
        continue
      }
      const said = r.error ?? `HTTP ${r.status} ${short(r.isError ? r.text : r.json?.error)}`
      try {
        const left = await readOk(w, `/tasks/${task.key}/attachments`)
        if (left.some((a) => a.id === att.id)) failed.push(`${att.name}: ${said}`)
      } catch (error) {
        failed.push(`${att.name}: ${said}, and the file list could not be read: ${describe(error)}`)
      }
    }
    expect(failed.length === 0, `not deleted: ${failed.join('; ')}`)
    eq((await restOk(w, 'GET', `/tasks/${task.key}/attachments`)).length, 0, 'files left')
    if (made[0]) eq((await download(made[0].att.url)).status, 404, 'a deleted file downloads')
    return `${made.length} files deleted`
  })
}

/* ------------------------------------------------------ merged features */

const schemaOf = (name) => run.tools.get(name)?.inputSchema?.properties ?? {}

/** A name of `n` UTF-16 code units, the run tag and a space followed by
 *  `fill` repeated. Most emoji are two code units. */
const nameOf = (n, fill = 'n') => {
  const name = `${run.tag} ${fill.repeat((n - run.tag.length - 1) / fill.length)}`
  eq(name.length, n, 'the built name length')
  return name
}

/** The limits of titles, descriptions, comments and archive reasons, counted
 *  in UTF-16 code units once trimmed (convex/lib/limits.ts). */
async function textCapChecks() {
  const w = run.creds.writeToken
  const A = run.projects.A
  const TEXT = LIMITS.description.max
  const over = 'a'.repeat(TEXT + 1)
  const title = `${run.tag} text caps`
  let key
  await check('text-caps/title', async () => {
    // padded with spaces past the limit, but within it once trimmed
    const atCap = nameOf(LIMITS.title.max)
    const made = await restOk(w, 'POST', '/tasks', { project: A.id, title: `  ${atCap}  ` })
    run.created.push(made)
    eq(made.title, atCap, 'the trimmed REST title')
    const viaMcp = await toolOk(w, 'create_task', { project: A.id, title: ` ${atCap} ` })
    run.created.push(viaMcp)
    eq((await restOk(w, 'GET', `/tasks/${viaMcp.key}`)).title, atCap, 'the trimmed MCP title')
    const long = `${atCap}x`
    await restRefusal(
      w,
      'POST',
      '/tasks',
      { project: A.id, title: long },
      400,
      LIMITS.title.refusal,
    )
    await restRefusal(w, 'PATCH', `/tasks/${made.key}`, { title: long }, 400, LIMITS.title.refusal)
    eq(
      await toolRefusal(w, 'create_task', { project: A.id, title: long }),
      LIMITS.title.refusal,
      'create_task',
    )
    eq(
      await toolRefusal(w, 'update_task', { ref: made.key, title: long }),
      LIMITS.title.refusal,
      'update_task',
    )
  })
  await check('text-caps/rest/description', async () => {
    await restRefusal(
      w,
      'POST',
      '/tasks',
      { project: A.id, title, description: over },
      400,
      LIMITS.description.refusal,
    )
    const made = await restOk(w, 'POST', '/tasks', {
      project: A.id,
      title,
      description: 'a'.repeat(TEXT),
    })
    run.created.push(made)
    key = made.key
    const titled = (await restOk(w, 'GET', `/tasks?project=${A.id}&limit=200`)).filter(
      (t) => t.title === title,
    )
    eq(titled.length, 1, 'tasks with the cap title (only the one at the limit)')
    await restRefusal(
      w,
      'PATCH',
      `/tasks/${key}`,
      { description: over },
      400,
      LIMITS.description.refusal,
    )
  })
  if (!key) return
  await check('text-caps/rest/comment', async () => {
    await restRefusal(
      w,
      'POST',
      `/tasks/${key}/comments`,
      { body: 'b'.repeat(TEXT + 1) },
      400,
      LIMITS.comment.refusal,
    )
    const c = await restOk(w, 'POST', `/tasks/${key}/comments`, { body: 'b'.repeat(TEXT) })
    await restRefusal(
      w,
      'PATCH',
      `/comments/${c.id}`,
      { body: 'c'.repeat(TEXT + 1) },
      400,
      LIMITS.comment.refusal,
    )
  })
  await check('text-caps/rest/archive-reason', async () => {
    await restRefusal(
      w,
      'PATCH',
      `/tasks/${key}`,
      { archived: true, archive_reason: 'c'.repeat(LIMITS.archiveReason.max + 1) },
      400,
      LIMITS.archiveReason.refusal,
    )
    eq((await restOk(w, 'GET', `/tasks/${key}`)).archived, false, 'archived after the refusal')
  })
  await check('text-caps/mcp/description', async () => {
    eq(
      await toolRefusal(w, 'create_task', {
        project: A.id,
        title: `${title} MCP`,
        description: over,
      }),
      LIMITS.description.refusal,
      'refusal',
    )
    const listed = await toolOk(w, 'list_tasks', { project: A.id, limit: 200 })
    expect(!listed.some((t) => t.title === `${title} MCP`), 'MCP created the over-long task')
  })
  await check('text-caps/mcp/comment', async () => {
    eq(
      await toolRefusal(w, 'add_comment', { ref: key, body: 'b'.repeat(TEXT + 1) }),
      LIMITS.comment.refusal,
      'refusal',
    )
  })
  await check('text-caps/mcp/archive-reason', async () => {
    eq(
      await toolRefusal(w, 'update_task', {
        ref: key,
        archived: true,
        archive_reason: 'c'.repeat(LIMITS.archiveReason.max + 1),
      }),
      LIMITS.archiveReason.refusal,
      'refusal',
    )
    eq((await restOk(w, 'GET', `/tasks/${key}`)).archived, false, 'archived after the refusal')
  })
}

/** Page sizes and searches past their limits are refused on REST and MCP
 *  alike, never moved into range, and a list without a limit holds
 *  DEFAULT_PAGE_SIZE tasks at most. */
async function listLimitChecks() {
  const w = run.creds.writeToken
  const { M } = run.projects
  await check('list-limits/rest', async () => {
    for (const limit of ['0', '-5', 'abc', String(LIMITS.listTasks.max + 1), '500'])
      await restRefusal(
        w,
        'GET',
        `/tasks?project=${M.id}&limit=${limit}`,
        undefined,
        400,
        LIMITS.listTasks.refusal,
      )
    const search = 's'.repeat(LIMITS.search.max + 1)
    for (const archived of ['', '&archived=true'])
      await restRefusal(
        w,
        'GET',
        `/tasks?project=${M.id}${archived}&search=${search}`,
        undefined,
        400,
        LIMITS.search.refusal,
      )
    const page = await restOk(w, 'GET', `/tasks?project=${M.id}`)
    expect(page.length <= DEFAULT_PAGE_SIZE, `a default page held ${page.length} tasks`)
  })
  await check('list-limits/mcp', async () => {
    for (const limit of [0, LIMITS.listTasks.max + 1])
      eq(
        await toolRefusal(w, 'list_tasks', { project: M.id, limit }),
        LIMITS.listTasks.refusal,
        `limit ${limit}`,
      )
    const search = 's'.repeat(LIMITS.search.max + 1)
    for (const archived of [false, true])
      eq(
        await toolRefusal(w, 'list_tasks', { project: M.id, archived, search }),
        LIMITS.search.refusal,
        `search, archived ${archived}`,
      )
    const page = await toolOk(w, 'list_tasks', { project: M.id })
    expect(page.length <= DEFAULT_PAGE_SIZE, `a default page held ${page.length} tasks`)
  })
}

/** Comment paging with limit and before on a small thread (#118). */
async function commentPageChecks() {
  const w = run.creds.writeToken
  let task
  const ids = []
  const made = await check('comment-pages/setup', async () => {
    task = await restOk(w, 'POST', '/tasks', {
      project: run.projects.A.id,
      title: `${run.tag} comment pages`,
    })
    run.created.push(task)
    for (const n of [1, 2, 3])
      ids.push(
        (await restOk(w, 'POST', `/tasks/${task.key}/comments`, { body: `${run.tag} page ${n}` }))
          .id,
      )
    return `${task.key} with 3 comments`
  })
  if (!made) {
    for (const id of ['rest', 'mcp'])
      skip(`comment-pages/${id}`, 'the task and its three comments could not be made')
    return
  }
  const fixtureComment = run.fixtureComment
  await check('comment-pages/rest', async () => {
    const newest = await restOk(w, 'GET', `/tasks/${task.key}/comments?limit=2`)
    same(
      newest.map((c) => c.id),
      ids.slice(1),
      'newest two, oldest first',
    )
    const before = await restOk(w, 'GET', `/tasks/${task.key}/comments?limit=2&before=${ids[1]}`)
    same(
      before.map((c) => c.id),
      ids.slice(0, 1),
      'the page before',
    )
    eq(
      (await restOk(w, 'GET', `/tasks/${task.key}/comments?limit=2&before=${ids[0]}`)).length,
      0,
      'the end',
    )
    eq((await restOk(w, 'GET', `/tasks/${task.key}/comments`)).length, 3, 'default page')
    for (const limit of ['0', String(LIMITS.listComments.max + 1), 'x'])
      await restRefusal(
        w,
        'GET',
        `/tasks/${task.key}/comments?limit=${limit}`,
        undefined,
        400,
        LIMITS.listComments.refusal,
      )
    await restOk(w, 'GET', `/tasks/${task.key}/comments?limit=${LIMITS.listComments.max}`)
    for (const other of [randomUUID(), fixtureComment?.id].filter(Boolean))
      await restRefusal(
        w,
        'GET',
        `/tasks/${task.key}/comments?before=${other}`,
        undefined,
        400,
        'before must be the id of a comment on this task',
      )
  })
  await check('comment-pages/mcp', async () => {
    const newest = await toolOk(w, 'list_comments', { ref: task.key, limit: 2 })
    same(
      newest.map((c) => c.id),
      ids.slice(1),
      'newest two',
    )
    const before = await toolOk(w, 'list_comments', { ref: task.key, limit: 2, before: ids[1] })
    same(
      before.map((c) => c.id),
      ids.slice(0, 1),
      'the page before',
    )
    eq(
      await toolRefusal(w, 'list_comments', { ref: task.key, before: randomUUID() }),
      'before must be the id of a comment on this task',
      'foreign before',
    )
    eq(
      await toolRefusal(w, 'list_comments', { ref: task.key, limit: LIMITS.listComments.max + 1 }),
      LIMITS.listComments.refusal,
      'a limit over the most',
    )
  })
}

/* ---------------------------------------------------------- thread pages */

/** Fills one task with a page and a little more of comments and of history,
 *  then reads its history back over REST and MCP with `before` down to the
 *  empty page, and in the task window uses Show earlier comments and Show
 *  earlier activity until the first comment and the created row appear. */
async function threadPageChecks() {
  const w = run.creds.writeToken
  let task
  const comments = []
  let changes = 0
  const made = await check('thread-pages/setup', async () => {
    task = await restOk(w, 'POST', '/tasks', {
      project: run.projects.A.id,
      title: `${run.tag} thread pages`,
    })
    run.created.push(task)
    const count = THREAD_PAGE.comments + 10
    // One profile posts at most LIMITS.commentRate.max comments on a task in
    // any 60 seconds, so each post past them waits until the post that many
    // before it is a minute old, timed from after its answer, with a margin.
    const posted = []
    for (let n = 1; n <= count; n++) {
      const earlier = posted[posted.length - LIMITS.commentRate.max]
      if (earlier !== undefined) await sleep(Math.max(0, earlier + 61_000 - Date.now()))
      comments.push(
        (await restOk(w, 'POST', `/tasks/${task.key}/comments`, { body: `${run.tag} thread ${n}` }))
          .id,
      )
      posted.push(Date.now())
    }
    // Each label a PATCH adds or removes writes its own history row, so
    // putting all of them on and taking them off again fills the history
    // with few requests.
    const labels = (await readList(w, '/labels')).slice(0, LIMITS.labels.max).map((l) => l.id)
    expect(labels.length > 0, 'the organization has no labels to put on the task')
    const rounds = Math.ceil((THREAD_PAGE.history + 10) / (2 * labels.length))
    for (let i = 0; i < rounds; i++) {
      await restOk(w, 'PATCH', `/tasks/${task.key}`, { add_labels: labels })
      await restOk(w, 'PATCH', `/tasks/${task.key}`, { remove_labels: labels })
    }
    changes = 1 + rounds * 2 * labels.length
    return `${task.key} with ${count} comments and ${changes} changes`
  })
  if (!made) {
    for (const id of ['rest', 'mcp', 'ui/earlier-comments', 'ui/earlier-activity'])
      skip(`thread-pages/${id}`, 'the task could not be filled')
    return
  }
  // every page, newest first, until the empty one
  const walk = async (read) => {
    const pages = []
    let before
    for (let i = 0; i < 5; i++) {
      const page = await read(before)
      if (page.length === 0) return pages
      pages.push(page)
      before = page[0].id
    }
    fail('paging did not end')
  }
  /** The created row's id and the row count of the history `read` pages. */
  const history = async (read) => {
    const rows = historyRows(await walk(read), changes)
    return { created: rows[0].id, count: rows.length }
  }
  let created
  await check('thread-pages/rest', async () => {
    const r = await history((before) =>
      restOk(w, 'GET', `/tasks/${task.key}/activity${before ? `?before=${before}` : ''}`),
    )
    created = r.created
    return `${r.count} rows in 2 pages`
  })
  await check('thread-pages/mcp', async () => {
    const r = await history((before) =>
      toolOk(w, 'list_task_activity', { ref: task.key, ...(before ? { before } : {}) }),
    )
    if (created) eq(r.created, created, 'the created row REST answered')
    return `${r.count} rows in 2 pages`
  })
  await earlierThreadChecks(task, comments, created, changes)
}

/** The rows of a task's history, oldest first, from `pages`, the pages
 *  REST or MCP answered newest first with `before` down to the empty one.
 *  A task with `total` rows, a page and a little more, must answer a full
 *  page and then the rest, every row once, starting with the created row. */
export function historyRows(pages, total) {
  eq(pages.length, 2, 'pages before the empty one')
  eq(pages[0].length, THREAD_PAGE.history, 'the newest page')
  const rows = pages.toReversed().flat()
  eq(new Set(rows.map((r) => r.id)).size, rows.length, 'distinct rows across pages')
  eq(rows.length, total, 'rows across pages')
  eq(rows[0].verb, 'created', 'the first row')
  for (let i = 1; i < rows.length; i++)
    expect(rows[i - 1].created_at <= rows[i].created_at, 'pages overlap or skip')
  return rows
}

/** The task window opens at the newest page of comments, and under All
 *  at the newest page of history too. Under Comments, Show earlier comments
 *  loads the rest of the comments, and under All, Show earlier activity
 *  loads the rest of the thread, each until the control goes. Each check
 *  opens the task afresh, so one can fail without the other. `comments`
 *  are the task's comment ids, oldest first, `created` the id of its
 *  created row and `changes` the number of rows in its history. */
async function earlierThreadChecks(task, comments, created, changes) {
  const more = app.locator('[data-earlier-comments="more"] button')
  /** The ids the thread shows in the attribute `name`, top to bottom. */
  const shown = (name) =>
    app.locator(`[${name}]`).evaluateAll((els, n) => els.map((el) => el.getAttribute(n)), name)
  const rowCount = async () =>
    (await shown('data-comment')).length + (await shown('data-event')).length
  /** Presses `more` until it goes, at most `most` times, and answers the
   *  number of presses. */
  const pressUntilGone = async (most, label) => {
    let clicks = 0
    while ((await more.count()) > 0) {
      expect(clicks < most, `${label} did not go after ${clicks} presses`)
      const before = await rowCount()
      await more.click()
      clicks++
      expect(
        await until(async () => (await rowCount()) > before, 20_000),
        `${label} loaded nothing after ${clicks} presses`,
      )
      // the control returns once the page is in, or goes for good
      await app.locator('[data-earlier-comments="loading"]').waitFor({ state: 'detached' })
    }
    return clicks
  }
  /** Opens the task window under Comments and waits for its first page. */
  const open = async () => {
    await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/tasks/${task.key.toLowerCase()}`, {
      waitUntil: 'domcontentloaded',
    })
    await app.locator('[data-comment]').first().waitFor({ timeout: 45_000 })
  }
  await check('thread-pages/ui/earlier-comments', async () => {
    await open()
    await more.waitFor({ timeout: 20_000 })
    eq((await more.textContent())?.trim(), 'Show earlier comments', 'the control under Comments')
    eq((await shown('data-comment')).length, THREAD_PAGE.comments, 'comments the task opens with')
    expect(
      !(await shown('data-comment')).includes(comments[0]),
      'the first comment is already shown',
    )
    const clicks = await pressUntilGone(2, 'Show earlier comments')
    same(
      (await shown('data-comment')).toSorted(),
      comments.toSorted(),
      'the comments after Show earlier comments',
    )
    eq((await shown('data-comment'))[0], comments[0], 'the first comment shown')
    return `${THREAD_PAGE.comments} at first, then ${clicks} press to the first comment`
  })
  if (created)
    await check('thread-pages/ui/earlier-activity', async () => {
      await open()
      await app.getByRole('radio', { name: 'All', exact: true }).click()
      await more.waitFor({ timeout: 20_000 })
      eq((await more.textContent())?.trim(), 'Show earlier activity', 'the control under All')
      expect(!(await shown('data-event')).includes(created), 'the created row is already shown')
      // pages of history, then the comments older than the oldest loaded
      // one: a press loads at least one page of either
      const most =
        Math.ceil(changes / THREAD_PAGE.windowHistory) +
        Math.ceil(comments.length / THREAD_PAGE.comments)
      const clicks = await pressUntilGone(most, 'Show earlier activity')
      const first = await app
        .locator('[data-spine-feed]')
        .locator('[data-comment], [data-event]')
        .first()
        .getAttribute('data-event')
      eq(first, created, 'the first row under All')
      expect((await shown('data-comment')).includes(comments[0]), 'the first comment under All')
      return `${clicks} presses to the created row`
    })
  else skip('thread-pages/ui/earlier-activity', 'REST did not answer the created row')
  // leave the task, so its thread is not open while the run changes it
  await check('thread-pages/ui/leave', async () => {
    await app.goto(`${cfg.appOrigin}/app/~/board/all`, { waitUntil: 'domcontentloaded' })
    await app.waitForSelector('[data-all-nav]', { timeout: 60_000 })
  })
}

/** Whether `seen`, the app's messages, holds `sentence` in any case, as the
 *  app shows a refusal with a capital letter. */
const showed = (seen, sentence) =>
  seen.some((m) => m.toLowerCase().includes(sentence.toLowerCase()))

/** 80 UTF-16 code units on project, sub-project, milestone, team,
 *  organization, agent key and personal token names, where most emoji count
 *  as two (convex/lib/limits.ts). Creates the run's team. */
async function nameCapChecks() {
  const w = run.creds.writeToken
  const M = run.projects.M
  const PROJECT = LIMITS.projectName.refusal
  const over = nameOf(81)
  // the tag, a space and 33 emoji are 80 code units
  const emoji = nameOf(80, '🙂')
  // 34 emoji are 82
  const emojiOver = `${emoji}🙂`
  let sub
  await check('name-caps/rest/project', async () => {
    await restRefusal(w, 'POST', '/projects', { name: over }, 400, PROJECT)
    await restRefusal(w, 'POST', '/projects', { name: over, parent: M.id }, 400, PROJECT)
    await restRefusal(w, 'POST', '/projects', { name: emojiOver, parent: M.id }, 400, PROJECT)
    sub = await restOk(w, 'POST', '/projects', { name: ` ${emoji} `, parent: M.id })
    eq(sub.name, emoji, 'the 80 code unit name, trimmed')
    await restRefusal(w, 'PATCH', `/projects/${sub.id}`, { name: over }, 400, PROJECT)
    eq((await restOk(w, 'PATCH', `/projects/${sub.id}`, { name: emoji })).name, emoji, 'resent')
  })
  await check('name-caps/mcp/project', async () => {
    eq(
      await toolRefusal(w, 'create_project', { name: over, parent: M.id }),
      PROJECT,
      'create_project',
    )
    if (sub) {
      eq(
        await toolRefusal(w, 'update_project', { project: sub.id, name: emojiOver }),
        PROJECT,
        'update_project',
      )
      const party = nameOf(80, '🎉')
      eq(
        (await toolOk(w, 'update_project', { project: sub.id, name: `${party}  ` })).name,
        party,
        'update_project with 80 code units, trimmed',
      )
    }
  })
  await check('name-caps/milestone', async () => {
    const MILESTONE = LIMITS.milestoneName.refusal
    await restRefusal(
      w,
      'POST',
      `/projects/${M.id}/milestones`,
      { name: over, date: '2026-11-02' },
      400,
      MILESTONE,
    )
    eq(
      await toolRefusal(w, 'set_milestone', { project: M.id, name: over, date: '2026-11-02' }),
      MILESTONE,
      'set_milestone',
    )
    const made = await restOk(w, 'POST', `/projects/${M.id}/milestones`, {
      name: nameOf(80),
      date: '2026-11-02',
    })
    eq(made.name, nameOf(80), 'the 80 character milestone')
    const listed = (await restOk(w, 'GET', `/projects/${M.id}`)).milestones
    same(
      listed.map((m) => m.name),
      [nameOf(80)],
      'milestones on the project',
    )
    eq(
      (await restOk(w, 'DELETE', `/projects/${M.id}/milestones/${made.id}`)).deleted,
      true,
      'deleted',
    )
  })
  await check('name-caps/team', async () => {
    const TEAM = LIMITS.teamName.refusal
    await restRefusal(w, 'POST', '/teams', { name: over }, 400, TEAM)
    eq(await toolRefusal(w, 'set_team', { name: over }), TEAM, 'set_team')
    run.team = await restOk(w, 'POST', '/teams', { name: `${run.tag} team` })
    await restRefusal(w, 'PATCH', `/teams/${run.team.id}`, { name: over }, 400, TEAM)
    const teams = await restOk(w, 'GET', '/teams')
    eq(teams.filter((t) => t.name.startsWith(`${run.tag} `)).length, 1, 'teams of this run')
  })
  await check('name-caps/app/organization', async () => {
    const out = await appMessages(
      (name) => window.PLANNER.setOrg({ name }),
      `${run.orgName} ${'n'.repeat(LIMITS.orgName.max)}`,
    )
    expect(showed(out.seen, LIMITS.orgName.refusal), 'the app showed no organization name refusal')
    eq((await restOk(w, 'GET', '/me')).organization.name, run.orgName, 'the organization name')
    expect(
      await until(
        async () => (await evaluate(app, () => window.PLANNER.org?.name)) === run.orgName,
      ),
      'the app did not revert the organization name',
    )
  }).then(async (ok) => {
    // a deployment that took the name gets Northstar's name back at once
    if (ok) return
    const name = async () => (await rest(w, 'GET', '/me')).json?.organization?.name
    // a failed read goes on to the check, so it cannot end the run
    if ((await name().catch(() => null)) === run.orgName) return
    await check('name-caps/app/organization-restored', async () => {
      await evaluate(app, (name) => window.PLANNER.setOrg({ name }), run.orgName)
      expect(
        await until(async () => (await name()) === run.orgName),
        "Northstar's name was not restored",
      )
    })
  })
  await check('name-caps/app/token', async () => {
    const out = await appMessages(
      (name) => window.PLANNER.createMcpToken(name, { access: 'read' }),
      over,
    )
    eq(out.value, null, 'the app answer')
    expect(showed(out.seen, LIMITS.tokenName.refusal), 'the app logged no token name refusal')
    const made = await evaluate(
      app,
      (name) => window.PLANNER.createMcpToken(name, { access: 'read' }),
      nameOf(80),
    )
    expect(made?.id, 'an 80 character token name was refused')
    keep(made.secret)
    expect(
      await evaluate(
        app,
        async (id) =>
          (await window.PLANNER.revokeMcpToken(id)) && window.PLANNER.deleteMcpToken(id),
        made.id,
      ),
      'could not remove the 80 character token',
    )
  })
  await check('name-caps/app/agent-key', async () => {
    const out = await appMessages(
      ([agent, name]) => window.PLANNER.createAgentKey(agent, name),
      [run.agents.viewer.id, over],
    )
    eq(out.value, null, 'the app answer')
    expect(showed(out.seen, LIMITS.keyName.refusal), 'the app logged no key name refusal')
    const keys = (await evaluate(app, () => window.PLANNER.listAgentKeys())) ?? []
    expect(!keys.some((k) => k.name === over), 'the over-long key exists')
  })
}

/** Writes `size` bytes exactly: `make(padding)` with ASCII padding. */
function sized(size, make) {
  const base = Buffer.byteLength(make(''))
  expect(size >= base, 'the base body is longer than the size')
  const text = make('p'.repeat(size - base))
  eq(Buffer.byteLength(text), size, 'the built body size')
  return text
}

/** Request bodies over 1 MiB answer 413 after authentication (#127). */
async function bodyCapChecks() {
  const w = run.creds.writeToken
  // a project that does not exist, so a body that reaches the route creates nothing
  const project = randomUUID()
  // padded with JSON whitespace, because POST /v1/tasks refuses a field it does not take
  const restBody = (pad) =>
    `${JSON.stringify({ project, title: `${run.tag} body cap` })}${' '.repeat(pad.length)}`
  const envelope = rpcBody('tools/call', { name: 'get_me' })
  const mcpBody = (pad) =>
    JSON.stringify({ ...envelope, params: { ...envelope.params, arguments: { padding: pad } } })
  await check('body-cap/rest', async () => {
    const over = await rest(w, 'POST', '/tasks', sized(BODY_MAX + 1, restBody), { raw: true })
    eq(over.status, 413, 'a body one byte over the cap')
    eq(over.json?.error, LIMITS.requestBody.refusal, 'the 413 sentence')
    // at the cap the route reads the body and refuses the unknown project
    const at = await rest(w, 'POST', '/tasks', sized(BODY_MAX, restBody), {
      raw: true,
    })
    expect(
      at.status === 400 && at.json?.error === UNKNOWN_PROJECT,
      `a body at the cap: wanted 400 ${short(UNKNOWN_PROJECT)}, got ${at.status} ${short(at.json?.error)}`,
    )
    // chunked, without a Content-Length
    const bytes = Buffer.from(sized(BODY_MAX + 1000, restBody))
    await pace(w.profile)
    const chunked = await request(`${cfg.apiOrigin}/v1/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${w.secret}`, 'Content-Type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 65536)
            controller.enqueue(bytes.subarray(i, i + 65536))
          controller.close()
        },
      }),
      duplex: 'half',
    })
    eq(chunked.status, 413, 'a chunked body over the cap')
    const anonymous = await request(`${cfg.apiOrigin}/v1/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: sized(BODY_MAX + 1, restBody),
    })
    eq(anonymous.status, 401, 'an unauthenticated body over the cap')
  })
  await check('body-cap/mcp', async () => {
    const over = await mcp(
      w,
      'tools/call',
      { name: 'get_me' },
      {
        bodyText: sized(BODY_MAX + 1, mcpBody),
      },
    )
    eq(over.status, 413, 'MCP status')
    same(
      over.json,
      {
        jsonrpc: '2.0',
        error: { code: -32600, message: `Bad Request: ${LIMITS.requestBody.refusal}` },
        id: null,
      },
      'the 413 body',
    )
    const at = await mcp(
      w,
      'tools/call',
      { name: 'get_me' },
      { bodyText: sized(BODY_MAX, mcpBody) },
    )
    eq(at.status, 200, 'a body at the cap')
    expect(at.json?.result && !at.json.result.isError, 'get_me at the cap was refused')
    const anonymous = await request(cfg.mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: sized(BODY_MAX + 1, mcpBody),
    })
    eq(anonymous.status, 401, 'an unauthenticated body over the cap')
  })
}

/** Every MCP tool that takes arguments refuses an unknown one, and the six
 *  REST access routes refuse unknown body fields (#134). */
async function unknownArgumentChecks() {
  const w = run.creds.writeToken
  const { M, A } = run.projects
  const std = run.agents.std
  await check('unknown-args/mcp/every-tool', async () => {
    let refusing = 0
    let ignoring = 0
    for (const [name, def] of run.tools) {
      const takes = Object.keys(def.inputSchema?.properties ?? {}).length > 0
      const r = await tool(w, name, { stgchk_probe: true })
      if (takes) {
        expect(
          r.isError &&
            r.text?.startsWith(schemaText(name, '')) &&
            r.text.endsWith('Unrecognized key: "stgchk_probe"'),
          `${name} did not refuse an unknown argument: ${r.isError ? short(r.text) : 'a result'}`,
        )
        refusing++
      } else {
        expect(!r.isError && r.json?.result, `${name} refused an argument it ignores`)
        ignoring++
      }
    }
    expect(refusing > 20 && ignoring === 4, `${refusing} refusing and ${ignoring} ignoring tools`)
    return `${refusing} tools refuse an unknown argument, ${ignoring} without arguments ignore it`
  })
  await check('unknown-args/mcp/shapes', async () => {
    eq(
      await toolRefusal(w, 'get_task', { ref: run.t0.key, aa: 1, bb: 2 }),
      schemaText('get_task', 'Unrecognized keys: "aa", "bb"'),
      'two unknown arguments',
    )
    const r = await mcp(w, 'tools/call', { name: 'list_tasks', arguments: 'all' })
    eq(
      r.json?.result?.content?.[0]?.text,
      schemaText('list_tasks', 'Invalid input: expected object, received string'),
      'arguments that are a string',
    )
  })
  await check('unknown-args/mcp/changes-nothing', async () => {
    eq(
      await toolRefusal(w, 'set_project_access', {
        project: A.id,
        user_id: std.id,
        level: null,
        on_held_task: 'keep_as_viewer',
      }),
      schemaText('set_project_access', 'Unrecognized key: "on_held_task"'),
      'misspelled on_held_tasks',
    )
    const grants = (await restOk(w, 'GET', `/projects/${A.id}`)).grants.users
    eq(grants.find((g) => g.id === std.id)?.level, 'user', 'the grant is still there')
    eq(
      await toolRefusal(w, 'update_task', {
        ref: run.t0.key,
        title: `${run.tag} renamed`,
        estimate_hours: 3,
      }),
      schemaText('update_task', 'Unrecognized key: "estimate_hours"'),
      'the old hours name',
    )
    eq((await restOk(w, 'GET', `/tasks/${run.t0.key}`)).title, run.t0.title, 'the title')
  })
  const granted = await restoreStandardGrant('fixture/standard-grant')
  const team = run.team
  const nora = run.nora.id
  const routes = [
    [
      'PUT',
      `/projects/${A.id}/access/users/${std.id}`,
      { level: 'user', levle: 'user' },
      'levle',
      REST_BODY_FIELDS.accessPut,
    ],
    [
      'DELETE',
      `/projects/${A.id}/access/users/${std.id}`,
      { on_held_task: 'keep_as_viewer' },
      'on_held_task',
      REST_BODY_FIELDS.heldTasks,
    ],
    ...(team
      ? [
          [
            'PUT',
            `/projects/${M.id}/access/teams/${team.id}`,
            { level: 'viewer', levle: 'viewer' },
            'levle',
            REST_BODY_FIELDS.accessPut,
          ],
          [
            'DELETE',
            `/projects/${M.id}/access/teams/${team.id}`,
            { on_held_task: 'leave' },
            'on_held_task',
            REST_BODY_FIELDS.heldTasks,
          ],
          [
            'PUT',
            `/teams/${team.id}/members/${nora}`,
            { leadr: true },
            'leadr',
            REST_BODY_FIELDS.memberPut,
          ],
          [
            'DELETE',
            `/teams/${team.id}/members/${nora}`,
            { on_held_task: 'leave' },
            'on_held_task',
            REST_BODY_FIELDS.heldTasks,
          ],
        ]
      : []),
  ]
  if (!granted)
    skip(
      'unknown-args/rest/access-routes',
      "the Standard agent's User grant on Alpha could not be restored",
    )
  else
    await check('unknown-args/rest/access-routes', async () => {
      for (const [method, path, body, field, takes] of routes)
        await restRefusal(
          w,
          method,
          path,
          body,
          400,
          `unknown field "${field}"; this request takes ${takes.join(', ')}`,
        )
      await restRefusal(
        w,
        'PUT',
        `/projects/${A.id}/access/users/${std.id}`,
        { level: 'user', aa: 1, bb: 2 },
        400,
        `unknown fields "aa", "bb"; this request takes ${REST_BODY_FIELDS.accessPut.join(', ')}`,
      )
      const project = await restOk(w, 'GET', `/projects/${A.id}`)
      eq(project.grants.users.find((g) => g.id === std.id)?.level, 'user', "the agent's grant")
      eq(
        (await restOk(w, 'GET', `/projects/${M.id}`)).grants.teams.length,
        0,
        'team grants on the project',
      )
      // without the run's team only the user routes could be checked
      expect(team, `the run has no team, so only ${routes.length} routes were checked`)
      eq((await restOk(w, 'GET', `/teams/${team.id}`)).members.length, 0, 'team members')
      return `${routes.length} routes`
    })
  run.standardGrant = await restoreStandardGrant('fixture/standard-grant-after-routes')
}

/** Gives the Standard agent its User grant on Alpha back, should a refusal
 *  check on a deployment without the rule have removed it, so later checks
 *  keep their fixture. Runs as check `id` and answers whether the agent has
 *  the grant, so a caller can skip the checks that need it. */
async function restoreStandardGrant(id) {
  const w = run.creds.writeToken
  const { A } = run.projects
  return await check(id, async () => {
    const grants = (await restOk(w, 'GET', `/projects/${A.id}`)).grants.users
    if (grants.find((g) => g.id === run.agents.std.id)?.level === 'user')
      return "the Standard agent's grant on Alpha is in place"
    const r = await restOk(w, 'PUT', `/projects/${A.id}/access/users/${run.agents.std.id}`, {
      level: 'user',
    })
    eq(r.level, 'user', 'the restored level')
    return "restored the Standard agent's grant on Alpha"
  })
}

/** Active lists come in creation order over MCP as over REST (#128). */
async function listOrderChecks() {
  const w = run.creds.writeToken
  const M = run.projects.M
  await check('task-lists/creation-order', async () => {
    const restRows = await restOk(w, 'GET', `/tasks?project=${M.id}&limit=200`)
    const mcpRows = await toolOk(w, 'list_tasks', { project: M.id, limit: 200 })
    same(
      mcpRows.map((t) => t.id),
      restRows.map((t) => t.id),
      'MCP order',
    )
    for (let i = 1; i < restRows.length; i++)
      expect(restRows[i - 1].created_at <= restRows[i].created_at, 'rows not oldest first')
    const ids = restRows.map((t) => t.id)
    const later = restRows.find(
      (t) => t.project_id === run.projects.A.id && t.created_at > run.tz.created_at,
    )
    expect(later, 'no Alpha task created after the Zulu one')
    expect(
      ids.indexOf(run.t0.id) < ids.indexOf(run.tz.id) &&
        ids.indexOf(run.tz.id) < ids.indexOf(later.id),
      'creation order does not cross the sub-projects',
    )
    const restPage = await restOk(w, 'GET', `/tasks?project=${M.id}&limit=2&offset=1`)
    same(
      restPage.map((t) => t.id),
      ids.slice(1, 3),
      'offset pages',
    )
    return `${ids.length} tasks`
  })
}

/** A subtask stays in its parent's top-level project (#129). Makes the
 *  run's second project, which the facts checks use. */
async function subtaskRuleChecks() {
  const w = run.creds.writeToken
  const { A, Z } = run.projects
  await check('subtask-rule/same-family', async () => {
    run.parent = await restOk(w, 'POST', '/tasks', {
      project: A.id,
      title: `${run.tag} parent`,
      remaining_hours: 6,
    })
    run.created.push(run.parent)
    run.child = await restOk(w, 'POST', '/tasks', {
      project: Z.id,
      title: `${run.tag} subtask in Zulu`,
      parent: run.parent.key,
      remaining_hours: 2,
    })
    run.created.push(run.child)
    eq(run.child.parent_id, run.parent.id, "the subtask's parent")
    eq((await restOk(w, 'GET', `/tasks/${run.parent.key}`)).is_group, true, 'the parent is a group')
  })
  if (!run.child) return
  await check('subtask-rule/other-project', async () => {
    const N = await restOk(w, 'POST', '/projects', { name: `${run.tag} second project` })
    run.projects.N = N
    const N1 = await restOk(w, 'POST', '/projects', { name: `${run.tag} second sub`, parent: N.id })
    run.projects.N1 = N1
    await restRefusal(
      w,
      'POST',
      '/tasks',
      { project: N1.id, title: `${run.tag} refused subtask`, parent: run.parent.key },
      400,
      NOT_SAME_FAMILY,
    )
    eq(
      await toolRefusal(w, 'create_task', {
        project: N1.id,
        title: `${run.tag} refused subtask`,
        parent: run.parent.key,
      }),
      NOT_SAME_FAMILY,
      'create_task',
    )
    await restRefusal(
      w,
      'PATCH',
      `/tasks/${run.child.key}`,
      { project: N1.id },
      400,
      "a subtask stays in its parent task's project; to move it to another project, detach it from its parent in the same change",
    )
    eq(
      (await restOk(w, 'GET', `/tasks/${run.child.key}`)).project_id,
      Z.id,
      "the subtask's project",
    )
  })
}

/** The Settings page Archived tasks opens with its search as the first
 *  control, focused, and the server search finds `target`, a task the run
 *  archived in its project (#143). Its key is the search, because a key
 *  matches no other task of the run's project. */
async function archivedTasksPageCheck(target) {
  await check('ui/archived-tasks-page', async () => {
    await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/settings/projects-archived-tasks`, {
      waitUntil: 'domcontentloaded',
    })
    const page = app.locator('[data-archived-tasks]')
    await page.waitFor({ timeout: 45_000 })
    const box = page.locator('[data-archive-search]')
    await box.waitFor()
    expect(
      await evaluate(page, (el) => {
        const first = el.querySelector('input, select, textarea, button, a[href]')
        return first?.hasAttribute('data-archive-search') === true
      }),
      'the search is not the first control',
    )
    expect(
      await evaluate(box, (el) => el === document.activeElement),
      'the search does not have focus when the page opens',
    )
    await page.locator('[data-archive-project]').selectOption(run.projects.M.id)
    // without a search the newest archived tasks are listed
    await page.locator(`[data-archive-row="${target.id}"]`).waitFor()
    expect(
      (await page.locator('[data-archive-row]').count()) > 1,
      'the project lists only one archived task without a search',
    )
    await box.fill(target.key)
    expect(
      await until(async () => {
        const rows = await page
          .locator('[data-archive-row]')
          .evaluateAll((els) => els.map((el) => el.getAttribute('data-archive-row')))
        return rows.length === 1 && rows[0] === target.id
      }),
      `the search for ${target.key} did not list exactly that task`,
    )
    eq(
      (await page.locator('[data-archive-count]').textContent())?.trim(),
      '1 found',
      'the count line',
    )
    const nothing = `${run.tag} no such task`
    await box.fill(nothing)
    await page.getByText(`No archived tasks match “${nothing}”.`).waitFor()
    return `found ${target.key} by search`
  })
}

/** Archived task lists need a project and page with a cursor; archived
 *  projects are listed first (#128). Archives the run's project at the end. */
async function archiveChecks() {
  const w = run.creds.writeToken
  const { M, A, Z } = run.projects
  // three archived tasks across both sub-projects
  const archived = []
  const archivedTasks = []
  const made = await check('archived-lists/setup', async () => {
    for (const [p, n] of [
      [A, 1],
      [Z, 2],
      [A, 3],
    ]) {
      const t = await restOk(w, 'POST', '/tasks', {
        project: p.id,
        title: `${run.tag} archived ${n}`,
      })
      run.created.push(t)
      await restOk(w, 'PATCH', `/tasks/${t.key}`, { archived: true })
      archived.push(t.id)
      archivedTasks.push(t)
    }
    return '3 archived tasks in Alpha and Zulu'
  })
  await check('archived-lists/rest/refusals', async () => {
    await restRefusal(
      w,
      'GET',
      '/tasks?archived=true',
      undefined,
      400,
      'archived=true needs project, because archived tasks are listed one project at a time',
    )
    await restRefusal(
      w,
      'GET',
      `/tasks?project=${M.id}&cursor=x`,
      undefined,
      400,
      'cursor works only with archived=true',
    )
    await restRefusal(
      w,
      'GET',
      `/tasks?archived=true&project=${M.id}&offset=1`,
      undefined,
      400,
      'offset does not apply to archived tasks; pass next_cursor as cursor',
    )
    await restRefusal(
      w,
      'GET',
      `/tasks?archived=true&project=${M.id}&cursor=garbage`,
      undefined,
      400,
      'cursor must be the next_cursor of an earlier page',
    )
  })
  if (made) {
    await check('archived-lists/rest/cursor-pages', async () => {
      const seen = []
      let cursor = null
      let pages = 0
      for (; pages < 60; pages++) {
        const page = await restOk(
          w,
          'GET',
          `/tasks?archived=true&project=${M.id}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        )
        expect(Array.isArray(page.tasks), 'an archived page is an object with tasks')
        expect(page.tasks.length <= 1, 'a page holds at most limit tasks')
        for (const t of page.tasks) eq(t.archived, true, 'an archived row')
        seen.push(...page.tasks.map((t) => t.id))
        cursor = page.next_cursor
        if (cursor === null) break
      }
      eq(cursor, null, 'paging ends')
      eq(new Set(seen).size, seen.length, 'no task twice')
      for (const id of archived)
        expect(seen.includes(id), 'an archived task is missing from the pages')
      expect(seen.indexOf(archived[2]) < seen.indexOf(archived[0]), 'most recently archived first')
      const one = await restOk(w, 'GET', `/tasks?archived=true&project=${Z.id}&limit=200`)
      same(
        one.tasks.map((t) => t.id),
        [archived[1]],
        "one sub-project's archive",
      )
      return `${seen.length} archived tasks in ${pages + 1} pages`
    })
    await check('archived-lists/mcp', async () => {
      eq(
        await toolRefusal(w, 'list_tasks', { archived: true }),
        'archived: true needs project, because archived tasks are listed one project at a time',
        'no project',
      )
      eq(
        await toolRefusal(w, 'list_tasks', { project: M.id, cursor: 'x' }),
        'cursor works only with archived: true',
        'cursor without archived',
      )
      eq(
        await toolRefusal(w, 'list_tasks', { archived: true, project: M.id, offset: 1 }),
        'offset does not apply to archived tasks; pass next_cursor as cursor',
        'offset',
      )
      eq(
        await toolRefusal(w, 'list_tasks', { archived: true, project: M.id, cursor: 'garbage' }),
        'cursor must be the next_cursor of an earlier page',
        'bad cursor',
      )
      const seen = []
      let cursor = null
      for (let i = 0; i < 60; i++) {
        const page = await toolOk(w, 'list_tasks', {
          archived: true,
          project: M.id,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        })
        expect(Array.isArray(page.tasks), 'an archived page is an object with tasks')
        seen.push(...page.tasks.map((t) => t.id))
        cursor = page.next_cursor
        if (cursor === null) break
      }
      eq(cursor, null, 'paging ends')
      for (const id of archived) expect(seen.includes(id), 'MCP archived pages miss a task')
    })
    await check('task-lists/active-only', async () => {
      const rows = await restOk(w, 'GET', `/tasks?project=${M.id}&limit=200`)
      for (const id of archived)
        expect(!rows.some((t) => t.id === id), 'REST lists an archived task')
      expect(
        rows.every((t) => t.archived === false),
        'an active list holds an archived row',
      )
      const mcpRows = await toolOk(w, 'list_tasks', { project: M.id, limit: 200 })
      for (const id of archived)
        expect(!mcpRows.some((t) => t.id === id), 'MCP lists an archived task')
    })
    await archivedTasksPageCheck(archivedTasks[2])
  } else
    for (const id of [
      'archived-lists/rest/cursor-pages',
      'archived-lists/mcp',
      'task-lists/active-only',
      'ui/archived-tasks-page',
    ])
      skip(id, 'the three archived tasks could not be made')

  // Archive the project, find it among archived projects, then read its tasks.
  await check('archived-projects/archive', async () => {
    const p = await restOk(w, 'PATCH', `/projects/${M.id}`, { archived: true })
    eq(p.archived, true, 'archived')
  })
  for (const cred of [w, run.creds.stdKey]) {
    await check(`archived-projects/${cred.id}/listed`, async () => {
      const active = await restOk(cred, 'GET', '/projects')
      expect(!active.some((p) => p.id === M.id), 'an archived project is in the active list')
      const list = await restOk(cred, 'GET', '/projects?archived=true')
      const viaMcp = await toolOk(cred, 'list_projects', { archived: true })
      for (const p of [M, A, Z]) {
        expect(
          list.some((r) => r.id === p.id && r.archived),
          `REST does not list ${p.name} as archived`,
        )
        expect(
          viaMcp.some((r) => r.id === p.id && r.archived),
          `MCP does not list ${p.name} as archived`,
        )
      }
      const tasks = await restOk(cred, 'GET', `/tasks?project=${M.id}&limit=200`)
      expect(
        tasks.some((t) => t.id === run.t0.id),
        'naming the archived project lists its tasks',
      )
      // the run's tag keeps the list to this run's tasks, so t0 cannot be
      // pushed off the page by the organization's other tasks
      const all = await restOk(cred, 'GET', `/tasks?limit=200&search=${run.tag}`)
      expect(
        !all.some((t) => t.id === run.t0.id),
        'tasks of an archived project are in the default list',
      )
      const page = await restOk(cred, 'GET', `/tasks?archived=true&project=${M.id}&limit=200`)
      for (const id of archived)
        expect(
          page.tasks.some((t) => t.id === id),
          "an archived project's archive misses a task",
        )
    })
  }
  await check('archived-projects/no-new-tasks', async () => {
    // the server's own sentence, which names the project to restore
    await restRefusal(
      w,
      'POST',
      '/tasks',
      { project: A.id, title: `${run.tag} into archived` },
      400,
      `${A.key} is archived, so restore it in the app before adding tasks to it`,
    )
    const tasks = await restOk(w, 'GET', `/tasks?project=${M.id}&limit=200`)
    expect(!tasks.some((t) => t.title === `${run.tag} into archived`), 'the task was created')
  })
}

/** What one attachment delete answered: 'deleted' for a success that says
 *  deleted: true, 'unsure' for an answer that leaves open whether the file
 *  is gone (a server or network error, MCP's internal error, or the
 *  attachment's not-found answer, as for a delete whose answer was lost),
 *  which a read of the task's files settles, or else the failure to report.
 *  `r` is what rest() or tool() answered, or `{status: 0}` for a network
 *  failure. */
export function deleteOutcome(r, surface, attachmentId, taskKey) {
  const answer = surface === 'rest' ? r.json : r.data
  if (r.status === 200 && !r.isError && answer)
    return answer.deleted === true ? 'deleted' : `deleted is ${answer.deleted}`
  const unsure =
    r.status === 0 ||
    r.status >= 500 ||
    (surface === 'rest'
      ? r.status === 404 && r.json?.error === 'attachment not found'
      : r.isError &&
        (r.text === 'internal error' ||
          r.text === `attachment "${attachmentId}" not found on ${taskKey}`))
  if (unsure) return 'unsure'
  return r.error ?? `HTTP ${r.status} ${short(r.isError ? r.text : r.json?.error)}`
}

/* ------------------------------------------------- task and project facts
 * Group progress, last comment times and project completion (#142), the
 * projected delay (#147) and the live group rule (#149), in the run's second
 * project, whose every task the run makes, so each number is known. */

/** `{done, total, percent}` with the rounding REST and MCP use. */
const completion = (done, total) => ({
  done,
  total,
  percent: total === 0 ? 0 : Math.round((done / total) * 100),
})
/** A group's `progress`, which adds whether some of it is hidden. */
const progress = (done, total, partial = false) => ({ ...completion(done, total), partial })

/** The first day (YYYY-MM-DD) of the planning week that holds `day`, in an
 *  organization whose weeks start on `weekStart` (0 Sunday to 6 Saturday). */
export function weekOf(day, weekStart) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - weekStart + 7) % 7))
  return d.toISOString().slice(0, 10)
}

/** `day` moved by `n` days. */
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** The server judges delay by today's UTC date. */
const todayUtc = () => new Date().toISOString().slice(0, 10)

/** Reads the REST and MCP task lists of `project` once and answers a
 *  finder for a task's row in each. */
async function rowsOf(cred, project) {
  const viaRest = await restOk(cred, 'GET', `/tasks?project=${project.id}&limit=200`)
  const viaMcp = await toolOk(cred, 'list_tasks', { project: project.id, limit: 200 })
  return (task) => {
    const r = viaRest.find((t) => t.id === task.id)
    const m = viaMcp.find((t) => t.id === task.id)
    expect(r && m, `the lists of ${project.name} lack ${task.key}`)
    return { rest: r, mcp: m }
  }
}

/** Checks that one field of `task` is `want` in the REST and MCP single
 *  reads and in both lists of its project. */
async function sameEverywhere(cred, task, project, field, want) {
  const row = (await rowsOf(cred, project))(task)
  same(row.rest[field], want, `${task.key} ${field} in the REST list`)
  same(row.mcp[field], want, `${task.key} ${field} in list_tasks`)
  same(
    (await restOk(cred, 'GET', `/tasks/${task.key}`))[field],
    want,
    `${task.key} ${field} over REST`,
  )
  same(
    (await toolOk(cred, 'get_task', { ref: task.key }))[field],
    want,
    `${task.key} ${field} in get_task`,
  )
}

/** The run's second project with two sub-projects and the tasks the facts
 *  checks read. Answers null when it could not be made. */
async function factsFixture() {
  const w = run.creds.writeToken
  let fixture = null
  await check('facts/setup', async () => {
    // the subtask rule checks may have made one or both already
    run.projects.N ??= await restOk(w, 'POST', '/projects', { name: `${run.tag} second project` })
    run.projects.N1 ??= await restOk(w, 'POST', '/projects', {
      name: `${run.tag} second sub`,
      parent: run.projects.N.id,
    })
    const { N, N1 } = run.projects
    const N2 = await toolOk(w, 'create_project', { name: `${run.tag} second Zulu`, parent: N.id })
    run.projects.N2 = N2
    const me = await restOk(w, 'GET', '/me')
    const week = weekOf(todayUtc(), me.organization.week_start)
    const past = addDays(week, -70)
    const make = async (project, title, fields = {}) => {
      const t = await restOk(w, 'POST', '/tasks', {
        project: project.id,
        title: `${run.tag} ${title}`,
        ...fields,
      })
      eq(t.assignee_id, null, `${title} has no assignee, so no projection`)
      run.created.push(t)
      return t
    }
    const f = { week, past, weekStart: me.organization.week_start }
    // a group with a Done and an open subtask here and an open one in N2
    f.g = await make(N1, 'facts group', { remaining_hours: 5 })
    f.c1 = await make(N1, 'facts done subtask', { parent: f.g.key, status: 'done', due_date: past })
    f.c2 = await make(N1, 'facts open subtask', { parent: f.g.key, remaining_hours: 3 })
    f.c3 = await make(N2, 'facts subtask in Zulu', {
      parent: f.g.key,
      remaining_hours: 4,
      due_date: past,
    })
    // a parent whose only subtask is in N2, and a plain task
    f.p = await make(N1, 'live parent', { remaining_hours: 6 })
    f.q = await make(N2, 'live subtask', { parent: f.p.key, remaining_hours: 2 })
    f.l = await make(N1, 'facts leaf')
    // delay: due long ago, planned long ago, planned ahead, and both
    f.late = await make(N1, 'delay past due', { due_date: past, remaining_hours: 4 })
    f.behind = await make(N1, 'delay planned in the past', {
      start_week: addDays(week, -56),
      end_week: addDays(week, -49),
    })
    f.ok = await make(N1, 'delay planned ahead', {
      start_week: addDays(week, 28),
      end_week: addDays(week, 35),
    })
    f.lateAhead = await make(N1, 'delay past due planned ahead', {
      due_date: past,
      start_week: addDays(week, 28),
      end_week: addDays(week, 35),
    })
    // the leaves of each sub-project while both are active; p and g are groups
    f.leaves1 = [f.c1, f.c2, f.l, f.late, f.behind, f.ok, f.lateAhead]
    f.leaves2 = [f.c3, f.q]
    fixture = f
    // a new project answers zeros on REST and MCP, because it holds no tasks
    same(N.completion, completion(0, 0), 'completion in the POST answer')
    same(N2.completion, completion(0, 0), 'completion in the create_project answer')
    return `${N.name} with ${N1.name} and ${N2.name}, 11 tasks`
  })
  return fixture
}

/** Done leaves among `tasks`. */
const doneIn = (tasks) => tasks.filter((t) => t.status === 'done').length

async function progressChecks(f) {
  const w = run.creds.writeToken
  const { N1 } = run.projects
  await check('task-progress/group', async () => {
    await sameEverywhere(w, f.g, N1, 'progress', progress(1, 3))
    return '1 of 3 done, 33 percent, over REST and MCP, single reads and lists'
  })
  await check('task-progress/leaf-is-null', async () => {
    await sameEverywhere(w, f.c1, N1, 'progress', null)
    await sameEverywhere(w, f.l, N1, 'progress', null)
  })
  // The Standard agent sees N1 alone, so the subtask in N2 is hidden from it.
  await check('task-progress/partial', async () => {
    const s = run.creds.stdKey
    await restOk(w, 'PUT', `/projects/${N1.id}/access/users/${run.agents.std.id}`, {
      level: 'viewer',
    })
    same(
      (await restOk(s, 'GET', `/tasks/${f.g.key}`)).progress,
      progress(1, 2, true),
      'REST progress with a hidden subtask',
    )
    same(
      (await toolOk(s, 'get_task', { ref: f.g.key })).progress,
      progress(1, 2, true),
      'MCP progress with a hidden subtask',
    )
    return '1 of the 2 it can read, partial'
  })
}

async function lastCommentChecks(f) {
  const w = run.creds.writeToken
  const { N1 } = run.projects
  await check('last-comment-at/rules', async () => {
    const t = f.c2
    await sameEverywhere(w, t, N1, 'last_comment_at', null)
    const first = await restOk(w, 'POST', `/tasks/${t.key}/comments`, {
      body: `${run.tag} first comment`,
    })
    await sameEverywhere(w, t, N1, 'last_comment_at', first.created_at)
    const made = await toolOk(w, 'add_comment', { ref: t.key, body: `${run.tag} second comment` })
    const second = (await restOk(w, 'GET', `/tasks/${t.key}/comments`)).find(
      (c) => c.id === made.id,
    )
    expect(second, 'the second comment is missing')
    expect(second.created_at > first.created_at, 'the second comment is not newer')
    await sameEverywhere(w, t, N1, 'last_comment_at', second.created_at)
    // editing does not move it; deleting the newest makes the one before newest
    await restOk(w, 'PATCH', `/comments/${second.id}`, {
      body: `${run.tag} second comment, edited`,
    })
    await sameEverywhere(w, t, N1, 'last_comment_at', second.created_at)
    await restOk(w, 'DELETE', `/comments/${second.id}`)
    await sameEverywhere(w, t, N1, 'last_comment_at', first.created_at)
    await toolOk(w, 'delete_comment', { comment: first.id })
    await sameEverywhere(w, t, N1, 'last_comment_at', null)
    return 'null, the newest, unchanged by an edit, the one before after a delete, null again'
  })
}

async function completionChecks(f) {
  const w = run.creds.writeToken
  const { N, N1, N2 } = run.projects
  const all = [...f.leaves1, ...f.leaves2]
  const wantN = completion(doneIn(all), all.length)
  const want1 = completion(doneIn(f.leaves1), f.leaves1.length)
  await check('project-completion/reads', async () => {
    for (const [p, want] of [
      [N, wantN],
      [N1, want1],
      [N2, completion(0, f.leaves2.length)],
    ]) {
      same((await restOk(w, 'GET', `/projects/${p.id}`)).completion, want, `${p.name} over REST`)
      same(
        (await toolOk(w, 'get_project', { project: p.id })).completion,
        want,
        `${p.name} in get_project`,
      )
    }
    const row = (await restOk(w, 'GET', '/projects')).find((p) => p.id === N.id)
    expect(row && !('completion' in row), 'a list row carries completion')
    return `${wantN.done} of ${wantN.total} in the project, ${want1.done} of ${want1.total} in ${N1.name}`
  })
  await check('project-completion/write-answers', async () => {
    same(
      (await restOk(w, 'PATCH', `/projects/${N1.id}`, { description: `${run.tag} facts` }))
        .completion,
      want1,
      'the PATCH answer',
    )
    same(
      (await toolOk(w, 'update_project', { project: N.id, description: `${run.tag} facts` }))
        .completion,
      wantN,
      'the update_project answer',
    )
  })
  // the agent reads N1 only, where p's subtask is hidden: p stays a group
  await check('project-completion/hidden-subtask', async () => {
    same(
      (await restOk(run.creds.stdKey, 'GET', `/projects/${N1.id}`)).completion,
      want1,
      'a parent whose only subtask is hidden still counts as a group',
    )
  })
}

async function delayChecks(f) {
  const w = run.creds.writeToken
  const { N1 } = run.projects
  const end = addDays(f.week, 35)
  // A task planned in the past is projected to finish in the week the server
  // judges in. That week is worked out again before each comparison, so a
  // run that crosses into a new planning week still expects the right one.
  const behind = () => ({
    status: 'behind',
    projected_end_week: weekOf(todayUtc(), f.weekStart),
  })
  const cases = () => [
    [f.late, { status: 'late', projected_end_week: null }],
    [f.behind, behind()],
    [f.ok, { status: 'ok', projected_end_week: end }],
    [f.lateAhead, { status: 'late', projected_end_week: end }],
    [f.c1, null],
    [f.l, null],
  ]
  await check('task-delay/verdicts', async () => {
    eq((await restOk(w, 'GET', `/projects/${N1.id}`)).track_delay, true, 'delay tracking')
    for (const [task, want] of cases()) await sameEverywhere(w, task, N1, 'delay', want)
    return 'late without a projection, behind, on track and late with one; null when Done or with nothing to judge'
  })
  await check('task-delay/track-delay-off', async () => {
    eq(
      (await restOk(w, 'PATCH', `/projects/${N1.id}`, { track_delay: false })).track_delay,
      false,
      'delay tracking off',
    )
    const rows = await rowsOf(w, N1)
    for (const [task] of cases()) {
      eq(rows(task).rest.delay, null, `${task.key} in the REST list`)
      eq(rows(task).mcp.delay, null, `${task.key} in list_tasks`)
    }
    eq((await restOk(w, 'GET', `/tasks/${f.late.key}`)).delay, null, 'the single read')
    eq(
      (await toolOk(w, 'update_project', { project: N1.id, track_delay: true })).track_delay,
      true,
      'delay tracking back on',
    )
    same(
      (await restOk(w, 'GET', `/tasks/${f.late.key}`)).delay,
      cases()[0][1],
      'the verdict once tracking is back',
    )
  })
  await check('task-delay/archived-task', async () => {
    await restOk(w, 'PATCH', `/tasks/${f.behind.key}`, { archived: true })
    eq((await restOk(w, 'GET', `/tasks/${f.behind.key}`)).delay, null, 'an archived task')
    await restOk(w, 'PATCH', `/tasks/${f.behind.key}`, { archived: false })
    same((await restOk(w, 'GET', `/tasks/${f.behind.key}`)).delay, behind(), 'restored')
  })
}

/** The live group rule (#149): a subtask in an archived project makes no
 *  task in an active project a group, and a restore or a move out of the
 *  archived project makes it one again and clears its own hours. */
async function liveTaskChecks(f) {
  const w = run.creds.writeToken
  const { N, N1, N2 } = run.projects
  const read = async (t) => restOk(w, 'GET', `/tasks/${t.key}`)
  const inProgress = async () =>
    (await restOk(w, 'GET', `/tasks?project=${N1.id}&status=progress&limit=200`)).map((t) => t.id)
  await check('live-tasks/active-sibling', async () => {
    const p = await read(f.p)
    eq(p.is_group, true, 'a parent with a subtask in an active sub-project')
    eq(p.remaining_hours, null, 'its own hours, cleared by the attach')
    eq(p.group_remaining_hours, 2, 'its group hours')
    await restRefusal(w, 'PATCH', `/tasks/${f.p.key}`, { status: 'progress' }, 400, GROUP_STATUS)
    eq((await read(f.g)).group_remaining_hours, 7, "the group's hours")
  })
  await check('live-tasks/archive-sibling', async () => {
    const answer = await restOk(w, 'PATCH', `/projects/${N2.id}`, { archived: true })
    eq(answer.completion, null, 'an archived project has no completion')
  })
  await check('live-tasks/archived-sibling', async () => {
    await sameEverywhere(w, f.p, N1, 'is_group', false)
    const p = await read(f.p)
    same(
      p.subtasks.map((s) => s.id),
      [f.q.id],
      'the single read still lists the subtask in the archived project',
    )
    eq(p.group_remaining_hours, null, 'a task without a live subtask has no group hours')
    const g = await read(f.g)
    same(g.progress, progress(1, 2), 'the group leaves out its subtask in the archived project')
    eq(g.group_remaining_hours, 3, "the group's hours leave it out too")
    eq((await read(f.c3)).delay, null, 'a task in an archived project has no delay')
    const leaves = [...f.leaves1, f.p]
    for (const p of [N, N1])
      same(
        (await restOk(w, 'GET', `/projects/${p.id}`)).completion,
        completion(doneIn(leaves), leaves.length),
        `${p.name} completion counts the parent as a task`,
      )
    return 'is_group false on REST and MCP, the subtask still listed, progress, hours and completion follow'
  })
  await check('live-tasks/leaf-edits', async () => {
    const t = await restOk(w, 'PATCH', `/tasks/${f.p.key}`, {
      status: 'progress',
      remaining_hours: 5,
    })
    eq(t.status, 'progress', 'status')
    eq(t.remaining_hours, 5, 'its own hours')
    const start = addDays(f.week, 7)
    await toolOk(w, 'update_task', { ref: f.p.key, start_week: start, end_week: start })
    eq((await toolOk(w, 'get_task', { ref: f.p.key })).start_week, start, 'dates over MCP')
    expect((await inProgress()).includes(f.p.id), 'the status filter leaves the parent out')
  })
  await check('live-tasks/restore-regroups', async () => {
    const answer = await toolOk(w, 'update_project', { project: N2.id, archived: false })
    same(answer.completion, completion(0, f.leaves2.length), 'the restore answer')
    const p = await read(f.p)
    eq(p.is_group, true, 'a group again')
    eq(p.start_week, null, 'group dates come from its unscheduled subtask')
    expect(!(await inProgress()).includes(f.p.id), 'the status filter lists a group')
    // background steps clear the own hours moments later
    expect(
      await until(async () => (await read(f.p)).remaining_hours === null, 30_000),
      "the restore did not clear the parent's own hours within 30 seconds",
    )
    same((await read(f.g)).progress, progress(1, 3), 'the group counts its subtask again')
    const all = [...f.leaves1, ...f.leaves2]
    same(
      (await restOk(w, 'GET', `/projects/${N.id}`)).completion,
      completion(doneIn(all), all.length),
      'completion',
    )
  })
  await check('live-tasks/move-out-of-archived', async () => {
    await restOk(w, 'PATCH', `/projects/${N2.id}`, { archived: true })
    eq(
      (await restOk(w, 'PATCH', `/tasks/${f.p.key}`, { remaining_hours: 4 })).remaining_hours,
      4,
      'a leaf again',
    )
    const q = await restOk(w, 'PATCH', `/tasks/${f.q.key}`, { project: N1.id })
    eq(q.project_id, N1.id, "the subtask's project")
    const p = await read(f.p)
    eq(p.is_group, true, 'a group once its subtask is in an active project')
    eq(p.remaining_hours, null, 'the move clears its own hours at once')
    await restOk(w, 'PATCH', `/projects/${N2.id}`, { archived: false })
  })
}

/* ------------------------------------------------------- billing pause */

/** The sentence every write gets while billing pauses editing
 *  (convex/lib/billingAccess.ts BILLING_READ_ONLY). */
const BILLING_READ_ONLY =
  'This organization is read-only. An organization admin can subscribe or update payment details in Billing.'

/** One request to the local backend's admin API, as the Convex CLI makes
 *  it. Local runs only; the key never leaves this process. */
async function localAdmin(path, body) {
  expect(
    cfg.target.target === 'local' && cfg.localAdminKey,
    'only a local run with its admin key may change backend settings',
  )
  const r = await request(new URL(path, cfg.target.url), {
    method: 'POST',
    headers: { Authorization: `Convex ${cfg.localAdminKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  expect(r.ok, `the local backend answered HTTP ${r.status} to ${path}`)
  return parseJson(text)
}

/** The local backend variable that marks a billing pause this script made.
 *  Its value holds the run tag and the BILLING_ENABLED value to restore, so
 *  a later local run, or --cleanup, can lift a pause that a killed run left.
 *  Without the mark, BILLING_ENABLED belongs to whoever runs the backend. */
const PAUSE_MARK = 'STGCHK_BILLING_PAUSE'

/** A local backend environment variable, or null when it is not set. */
async function localEnv(name) {
  const r = await localAdmin('/api/query', {
    path: '_system/cli/queryEnvironmentVariables:get',
    args: { name },
    format: 'json',
  })
  expect(r?.status === 'success', `the local backend did not say whether ${name} is set`)
  return r.value?.value ?? null
}

/** Sets local backend environment variables in one change, as
 *  `npx convex env set` does. A null value removes the variable. */
const setLocalEnv = (values) =>
  localAdmin('/api/update_environment_variables', {
    changes: Object.entries(values).map(([name, value]) => ({ name, value })),
  })

/** Whether `/me` says billing pauses editing. */
const paused = async () =>
  (await restOk(run.creds.writeToken, 'GET', '/me')).billing.read_only === true

/** Pauses editing in the local organization the way the backend tests do:
 *  billing on, and no subscription. Marks the pause as this run's. */
async function pauseBilling() {
  const before = await localEnv('BILLING_ENABLED')
  expect(
    before !== 'true',
    'billing is already on in the local backend, and not by this script; remove BILLING_ENABLED to run these checks',
  )
  run.billingBefore = before
  run.billingPaused = true
  await setLocalEnv({
    BILLING_ENABLED: 'true',
    [PAUSE_MARK]: JSON.stringify({ run: run.tag, before }),
  })
  say(
    'NOTE',
    'billing-pause',
    `billing is on in the local backend until this run lifts it. If the run is killed first, --cleanup with QIVO_LOCAL_ADMIN_KEY lifts it (docs/deployment.md)`,
  )
  expect(await until(paused, 30_000), 'the organization did not become read-only')
}

/** Lifts a pause this run made, and waits until writes are allowed. Like
 *  liftLeftPause, it leaves BILLING_ENABLED alone when someone changed it
 *  from the 'true' the run set. */
async function liftBillingPause() {
  if (!run.billingPaused) return
  const restore =
    (await localEnv('BILLING_ENABLED')) === 'true'
      ? { BILLING_ENABLED: run.billingBefore ?? null }
      : {}
  await setLocalEnv({ ...restore, [PAUSE_MARK]: null })
  expect(await until(async () => !(await paused()), 30_000), 'the organization stayed read-only')
  run.billingPaused = false
}

/** Names the way out when the sweep met the billing sentence on a local
 *  backend, where a billing pause left by a killed run is the likely cause. */
function billingPauseHint(problems) {
  if (cfg.target.target !== 'local' || !problems.some((p) => p.includes(BILLING_READ_ONLY))) return
  say(
    'NOTE',
    'billing-pause',
    `the local organization is read-only, likely from a billing pause a killed run left. Run --cleanup with QIVO_LOCAL_ADMIN_KEY, which lifts it (docs/deployment.md)`,
  )
}

/** Lifts a billing pause that an earlier local run made and never lifted,
 *  because it was killed, so this run's writes and sweep can work. Acts
 *  only on a pause with this script's mark, and restores BILLING_ENABLED only
 *  while it is still the 'true' that run set. Answers the earlier run's tag,
 *  or null when no pause was left. */
async function liftLeftPause() {
  const mark = await localEnv(PAUSE_MARK)
  if (mark === null) return null
  let left = {}
  try {
    left = JSON.parse(mark) ?? {}
  } catch {}
  // Billing that is no longer the 'true' the run set was changed by someone
  // else since, so only the mark goes.
  const restore =
    (await localEnv('BILLING_ENABLED')) === 'true'
      ? { BILLING_ENABLED: typeof left.before === 'string' ? left.before : null }
      : {}
  await setLocalEnv({ ...restore, [PAUSE_MARK]: null })
  return TAG_ANY.test(`${left.run} `) ? left.run : 'an earlier run'
}

/** While billing pauses editing, an organization admin can still remove
 *  project access and team members when the open tasks are left, over REST
 *  and MCP, and nothing else (#146). Needs a pause, which only a local run
 *  with its backend's admin key can make. */
async function billingPauseChecks() {
  const name = 'billing-pause-leave'
  if (!cfg.localAdminKey) {
    const reason =
      cfg.target.target === 'staging'
        ? 'billing is off on staging and this run cannot pause it; a local run with QIVO_LOCAL_ADMIN_KEY checks it'
        : 'set QIVO_LOCAL_ADMIN_KEY to the local backend admin key to pause billing for these checks'
    skipProbe(name, reason)
    return
  }
  const w = run.creds.writeToken
  const { N1 } = run.projects
  const viewer = run.agents.viewer
  const std = run.agents.std
  const team = run.team
  const grants = async () =>
    (await restOk(w, 'GET', `/projects/${N1.id}`)).grants.users.map((g) => g.id).sort()
  const members = async () =>
    team ? (await restOk(w, 'GET', `/teams/${team.id}`)).members.map((m) => m.id).sort() : []
  let before = null
  try {
    await check(`${name}/setup`, async () => {
      for (const id of [viewer.id, std.id])
        await restOk(w, 'PUT', `/projects/${N1.id}/access/users/${id}`, { level: 'viewer' })
      if (team)
        for (const id of [viewer.id, std.id])
          await restOk(w, 'PUT', `/teams/${team.id}/members/${id}`, {})
      const snapshot = { grants: await grants(), members: await members() }
      await pauseBilling()
      // Set only once the pause holds. Without it the checks below would
      // make the writes they expect to be refused.
      before = snapshot
      return team
        ? 'two grants and two team members, then billing paused'
        : 'two grants, then billing paused'
    })
    if (!before) return
    const refusedRest = (r, what) =>
      expect(
        r.status === 403 && r.json?.error === BILLING_READ_ONLY,
        `${what}: wanted 403 with the billing sentence, got ${r.status} ${short(r.json?.error)}`,
      )
    const refusedTool = async (cred, toolName, args, what) =>
      eq(await toolRefusal(cred, toolName, args), BILLING_READ_ONLY, what)
    await check(`${name}/me`, async () => {
      for (const me of [await restOk(w, 'GET', '/me'), await toolOk(w, 'get_me')]) {
        eq(me.billing.read_only, true, 'read_only')
        eq(me.billing.reason, BILLING_READ_ONLY, 'reason')
      }
    })
    await check(`${name}/other-writes-refused`, async () => {
      refusedRest(
        await rest(w, 'POST', '/tasks', { project: N1.id, title: `${run.tag} paused` }),
        'POST /tasks',
      )
      await refusedTool(
        w,
        'create_task',
        { project: N1.id, title: `${run.tag} paused` },
        'create_task',
      )
      refusedRest(
        await rest(w, 'PUT', `/projects/${N1.id}/access/users/${viewer.id}`, { level: 'user' }),
        'giving access',
      )
    })
    await check(`${name}/keep-and-reassign-refused`, async () => {
      const path = `/projects/${N1.id}/access/users/${viewer.id}`
      refusedRest(
        await rest(w, 'DELETE', path, { on_held_tasks: 'keep_as_viewer' }),
        'keep_as_viewer',
      )
      refusedRest(
        await rest(w, 'DELETE', path, { on_held_tasks: { reassign_to: null } }),
        'reassign',
      )
      await refusedTool(
        w,
        'set_project_access',
        { project: N1.id, user_id: viewer.id, level: null, on_held_tasks: 'keep_as_viewer' },
        'set_project_access keep_as_viewer',
      )
      if (team)
        refusedRest(
          await rest(w, 'DELETE', `/teams/${team.id}/members/${viewer.id}`, {
            on_held_tasks: 'keep_as_viewer',
          }),
          'team keep_as_viewer',
        )
      same(await grants(), before.grants, 'grants')
      same(await members(), before.members, 'team members')
    })
    await check(`${name}/not-an-admin`, async () => {
      const s = run.creds.stdKey
      refusedRest(
        await rest(s, 'DELETE', `/projects/${N1.id}/access/users/${viewer.id}`),
        'the Standard agent',
      )
      await refusedTool(
        s,
        'set_project_access',
        { project: N1.id, user_id: viewer.id, level: null },
        'the Standard agent over MCP',
      )
      // a read-only credential meets its own refusal first
      await restRefusal(
        run.creds.readToken,
        'DELETE',
        `/projects/${N1.id}/access/users/${viewer.id}`,
        undefined,
        403,
        PERSON_READ_ONLY,
      )
      same(await grants(), before.grants, 'grants')
    })
    await check(`${name}/leave-removes`, async () => {
      const r = await restOk(w, 'DELETE', `/projects/${N1.id}/access/users/${viewer.id}`)
      eq(r.removed, true, 'REST removed')
      same(r.stranded, [], 'stranded')
      const m = await toolOk(run.creds.oauthWrite, 'set_project_access', {
        project: N1.id,
        user_id: std.id,
        level: null,
        on_held_tasks: 'leave',
      })
      eq(m.level, null, 'MCP level')
      eq(m.changed, true, 'MCP changed')
      same(await grants(), [], 'grants left')
      if (team) {
        const t = await restOk(w, 'DELETE', `/teams/${team.id}/members/${viewer.id}`, {
          on_held_tasks: 'leave',
        })
        eq(t.removed, true, 'team member removed over REST')
        const tm = await toolOk(w, 'set_team_member', {
          team_id: team.id,
          user_id: std.id,
          member: false,
        })
        eq(tm.changed, true, 'team member removed over MCP')
        same(await members(), [], 'team members left')
      }
      return team ? 'two grants and two team members removed, REST and MCP' : 'two grants removed'
    })
    await check(`${name}/gone-still-refused`, async () => {
      // the pause refuses keep_as_viewer before it looks for a grant
      refusedRest(
        await rest(w, 'DELETE', `/projects/${N1.id}/access/users/${viewer.id}`, {
          on_held_tasks: 'keep_as_viewer',
        }),
        'keep_as_viewer on a grant that is gone',
      )
    })
  } finally {
    // also after a pause that never took hold
    if (run.billingPaused)
      await check(`${name}/lift`, async () => {
        await liftBillingPause()
        eq((await restOk(w, 'GET', '/me')).billing.read_only, false, 'read_only after the pause')
      })
  }
}

/** Every check of the merged task and project facts, the live group rule
 *  and the billing pause. */
async function factChecks() {
  const f = await factsFixture()
  if (!f) {
    skip('facts', 'the fixture for the facts checks could not be made')
  } else {
    await progressChecks(f)
    await lastCommentChecks(f)
    await completionChecks(f)
    await delayChecks(f)
    await liveTaskChecks(f)
  }
  if (run.projects.N1) await billingPauseChecks()
  else skipProbe('billing-pause-leave', 'the second project could not be made')
}

/* --------------------------------------------------------------- the run */

/** Creates the credentials, the project and the OAuth connections. */
async function setup() {
  const tag = run.tag
  // personal tokens in the app
  const writeSecret = await must('setup/ui/personal-token-write', () =>
    createTokenInUi(`${tag} write token`, true),
  )
  const readSecret = await must('setup/ui/personal-token-read-only', () =>
    createTokenInUi(`${tag} read token`, false),
  )
  const nora = run.nora
  run.creds.writeToken = {
    id: 'write-token',
    label: 'write token',
    who: 'nora',
    profile: 'nora',
    kind: 'personal_token',
    secret: writeSecret,
    name: `${tag} write token`,
    canWrite: true,
    actor: nora.name,
    restProvenance: 'via the REST API',
  }
  run.creds.readToken = {
    id: 'read-token',
    label: 'read-only token',
    who: 'nora',
    profile: 'nora',
    kind: 'personal_token',
    secret: readSecret,
    name: `${tag} read token`,
    canWrite: false,
    group: 'read-token',
    actor: nora.name,
  }
  // agents and keys in the app
  const std = await must('setup/ui/standard-agent', () =>
    createAgentInUi(`${tag} Standard agent`, 'user'),
  )
  const named = await must('setup/ui/standard-agent-named-key', () =>
    createAgentKeyInUi(std.id, `${tag} Standard key`),
  )
  const viewer = await must('setup/ui/viewer-agent', () =>
    createAgentInUi(`${tag} Viewer agent`, 'viewer'),
  )
  run.agents = {
    std: { id: std.id, name: `${tag} Standard agent` },
    viewer: { id: viewer.id, name: `${tag} Viewer agent` },
  }
  run.creds.stdDefaultKey = {
    id: 'standard-default-key',
    who: 'std',
    profile: 'std',
    kind: 'agent_key',
    secret: std.secret,
    name: 'Default key',
    canWrite: true,
    actor: `${tag} Standard agent`,
    userId: std.id,
  }
  run.creds.stdKey = {
    id: 'standard-key',
    who: 'std',
    profile: 'std',
    kind: 'agent_key',
    secret: named,
    name: `${tag} Standard key`,
    canWrite: true,
    actor: `${tag} Standard agent`,
    userId: std.id,
    restProvenance: `via the REST API (${tag} Standard key)`,
  }
  run.creds.viewerKey = {
    id: 'viewer-key',
    who: 'viewer',
    profile: 'viewer',
    kind: 'agent_key',
    secret: viewer.secret,
    name: 'Default key',
    canWrite: false,
    group: 'viewer-agent',
    actor: `${tag} Viewer agent`,
    userId: viewer.id,
  }
  const w = run.creds.writeToken
  // who Nora is, as the API says
  const me = await must('setup/rest/me', async () => restOk(w, 'GET', '/me'))
  if (me.billing.read_only) {
    // a run that stops here checked nothing, so it must not report success
    results.fail.push('setup/billing-read-only')
    say('FAIL', 'setup/billing-read-only', 'billing pauses editing in this organization')
    throw new Abort('billing pauses editing in this organization, so writes cannot be checked')
  }
  w.userId = me.user.id
  run.orgName = me.organization.name
  run.creds.readToken.userId = me.user.id
  run.nora.id = me.user.id
  await must('setup/rest/agent-roles', async () => {
    const users = await restOk(w, 'GET', '/users')
    const s = users.find((u) => u.id === std.id)
    const v = users.find((u) => u.id === viewer.id)
    eq(s?.kind, 'agent', 'Standard agent kind')
    eq(s?.org_role, 'user', 'Standard agent role')
    eq(v?.org_role, 'viewer', 'Viewer agent role')
    eq(s?.plannable_hours, null, 'an agent has no plannable week')
  })
  // the project and its sub-projects, through REST
  const M = await must('setup/rest/project', async () => {
    const p = await restOk(w, 'POST', '/projects', {
      name: `${tag} project`,
      description: 'Staging check fixture',
    })
    eq(p.lead_id, me.user.id, 'lead')
    return p
  })
  run.projects = { M }
  run.projects.A = await must('setup/rest/sub-project-alpha', () =>
    restOk(w, 'POST', '/projects', { name: `${tag} Alpha`, parent: M.id }),
  )
  run.projects.Z = await must('setup/rest/sub-project-zulu', () =>
    restOk(w, 'POST', '/projects', { name: `${tag} Zulu`, parent: M.id }),
  )
  // grants: the Standard agent views the project and edits Alpha; the
  // Viewer agent views the project
  await must('setup/rest/grants', async () => {
    for (const [p, agent, level] of [
      [M, std.id, 'viewer'],
      [run.projects.A, std.id, 'user'],
      [M, viewer.id, 'viewer'],
    ]) {
      const r = await restOk(w, 'PUT', `/projects/${p.id}/access/users/${agent}`, { level })
      eq(r.level, level, 'granted level')
    }
    const detail = await restOk(w, 'GET', `/projects/${M.id}`)
    eq(detail.grants.users.length, 2, 'grants on the project')
  })
  // fixture tasks: one in Alpha, one in Zulu
  run.t0 = await must('setup/rest/fixture-task-alpha', () =>
    restOk(w, 'POST', '/tasks', { project: run.projects.A.id, title: `${tag} fixture Alpha` }),
  )
  run.tz = await must('setup/rest/fixture-task-zulu', () =>
    restOk(w, 'POST', '/tasks', { project: run.projects.Z.id, title: `${tag} fixture Zulu` }),
  )
  await check('setup/rest/fixture-comment', async () => {
    run.fixtureComment = await restOk(w, 'POST', `/tasks/${run.t0.key}/comments`, {
      body: `${tag} fixture comment`,
    })
  })
  // OAuth: two registered clients, consent with and without Allow changes
  for (const [key, allow] of [
    ['oauthWrite', true],
    ['oauthRead', false],
  ]) {
    const name = `${tag} OAuth ${allow ? 'write' : 'read'} client`
    const clientId = await must(`setup/oauth/register-${allow ? 'write' : 'read'}`, () =>
      registerClient(name, redirectUri),
    )
    run.clients.push(name)
    const tokens = await must(`setup/oauth/consent-${allow ? 'allow-changes' : 'read-only'}`, () =>
      authorize(clientId, name, allow),
    )
    run.creds[key] = {
      id: allow ? 'oauth-write' : 'oauth-read',
      who: 'nora',
      profile: 'nora',
      kind: 'oauth',
      secret: tokens.access_token,
      refresh: tokens.refresh_token,
      clientId,
      name,
      canWrite: allow,
      group: allow ? undefined : 'oauth-read',
      actor: nora.name,
      userId: me.user.id,
    }
  }
  // the MCP tool catalogue
  await must(
    'setup/mcp/tools-list',
    async () => {
      const r = await mcp(w, 'tools/list', {})
      const list = r.json?.result?.tools
      expect(Array.isArray(list) && list.length > 0, 'tools/list returned no tools')
      run.tools = new Map(list.map((t) => [t.name, t]))
      for (const name of [
        'start_attachment_upload',
        'confirm_attachment_upload',
        'attach_text_file',
      ])
        expect(run.tools.has(name), `tools/list lacks ${name}`)
      eq(
        schemaOf('list_comments').limit?.maximum,
        LIMITS.listComments.max,
        'list_comments limit maximum',
      )
      return list.length
    },
    (count) => `${count} tools`,
  )
}

/** Runs the OAuth authorization in the browser, completing the real
 *  consent screen, and exchanges the code. Returns the issued tokens. */
async function authorize(clientId, clientName, allowChanges) {
  const verifier = randomBytes(32).toString('base64url')
  keep(verifier)
  const state = randomUUID()
  const url = new URL(oauth.meta.authorization_endpoint)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    scope: oauth.scopes,
    prompt: 'consent',
    resource: oauth.resource,
  }).toString()
  consent ??= await context.newPage()
  consent.setDefaultTimeout(30_000)
  consent.setDefaultNavigationTimeout(90_000)
  await consent.goto(url.toString(), { waitUntil: 'domcontentloaded' })
  const heading = consent.getByRole('heading', {
    name: `Connect ${clientName} to Qivo`,
    exact: true,
  })
  const email = consent.locator('input[type="email"]')
  await heading.or(email).first().waitFor({ timeout: 45_000 })
  // the consent screen is the app's own, never another origin
  eq(new URL(consent.url()).origin, cfg.appOrigin, 'the consent page origin')
  if (await email.isVisible()) await signInBrowser(consent, cfg.nora)
  await heading.waitFor({ timeout: 45_000 })
  expect(
    (await consent.locator('body').innerText()).includes(run.orgName),
    'consent names the organization',
  )
  const box = consent.getByRole('checkbox', { name: 'Allow changes', exact: true })
  expect(await box.isChecked(), 'Allow changes starts checked')
  if (!allowChanges) await box.uncheck()
  await consent.getByRole('button', { name: 'Connect', exact: true }).click()
  await consent.waitForURL((candidate) => candidate.origin === new URL(redirectUri).origin)
  const callback = callbacks.get(state)
  expect(callback, 'the callback kept the client state')
  callbacks.delete(state)
  eq(callback.get('error'), null, 'OAuth error')
  const code = callback.get('code')
  expect(code, 'consent returned an authorization code')
  const tokens = await tokenRequest(clientId, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  })
  eq(tokens.status, 200, 'token exchange status')
  expect(tokens.body.access_token?.startsWith('qvo_'), 'an OAuth access token was issued')
  expect(tokens.body.refresh_token?.startsWith('qvr_'), 'a refresh token was issued')
  eq(
    tokens.body.scope.split(' ').includes('qivo:write'),
    allowChanges,
    'write scope matches consent',
  )
  return tokens.body
}

async function main() {
  const c = run.creds
  // every credential: identity and reads
  for (const cred of [
    c.writeToken,
    c.readToken,
    c.stdKey,
    c.stdDefaultKey,
    c.viewerKey,
    c.oauthWrite,
    c.oauthRead,
  ])
    await checkIdentity(cred)
  // writes: the full lifecycle where allowed
  run.created.push(run.t0, run.tz)
  await restLifecycle(c.writeToken, 'write token')
  await mcpLifecycle(c.writeToken, 'write token')
  await restLifecycle(c.stdKey, 'Standard agent')
  await mcpLifecycle(c.stdKey, 'Standard agent')
  await mcpLifecycle(c.oauthWrite, 'OAuth write connection')
  for (const cred of [c.writeToken, c.readToken, c.stdKey, c.viewerKey, c.oauthWrite, c.oauthRead])
    await checkReads(cred)
  // refusals
  await checkReadOnly(c.readToken, PERSON_READ_ONLY)
  await checkReadOnly(c.viewerKey, VIEWER_READ_ONLY)
  await checkReadOnly(c.oauthRead, null)
  await checkOtherProject(c.stdKey)
  // files over REST and MCP
  await uploadChecks()
  // revoke one agent key mid-run: it stops, the agent's other key does not
  await check('standard-default-key/ui/revoke', () =>
    revokeAgentKeyInUi(run.agents.std.id, 'Default key'),
  )
  await checkRevoked(
    c.stdDefaultKey,
    'this agent key has been revoked',
    'unknown, revoked or deactivated agent key',
  )
  await check('standard-key/still-works', async () => {
    eq((await restOk(c.stdKey, 'GET', '/me')).credential.name, c.stdKey.name, 'the other key')
  })
  // limits and rules that merged
  await textCapChecks()
  await listLimitChecks()
  await commentPageChecks()
  await threadPageChecks()
  await nameCapChecks()
  await bodyCapChecks()
  await unknownArgumentChecks()
  await listOrderChecks()
  await subtaskRuleChecks()
  // task and project facts, the live group rule and the billing pause
  await factChecks()
  // archived tasks and projects, then delete the projects in the app
  await archiveChecks()
  await check('cleanup/app/delete-project', async () => {
    await deleteProjectInApp(c.writeToken, run.projects.M)
    if (run.projects.N) await deleteProjectInApp(c.writeToken, run.projects.N)
    for (const t of run.created)
      eq(
        (await rest(c.writeToken, 'GET', `/tasks/${t.id}`)).status,
        404,
        `task ${t.key} after its project went`,
      )
  })
  if (run.team)
    await check('cleanup/app/delete-team', async () => {
      await app.waitForFunction((id) => window.PLANNER.canDeleteTeam(id), run.team.id, {
        timeout: 30_000,
      })
      expect(
        await evaluate(
          app,
          (id) => window.PLANNER.removeAccess({ kind: 'deleteTeam', teamId: id }, { to: null }, []),
          run.team.id,
        ),
        'refused',
      )
      eq((await rest(c.writeToken, 'GET', `/teams/${run.team.id}`)).status, 404, 'the team')
    })
  await check('cleanup/rest/no-tagged-tasks', async () => {
    eq((await findTasks(c.writeToken, run.tag)).length, 0, 'tasks with this run tag')
  })
  // revoke everything in the app; the next call is refused
  await check('read-token/ui/revoke', () => revokeTokenInUi(c.readToken.name))
  await checkRevoked(
    c.readToken,
    'this personal access token has been revoked or has expired',
    'unknown, expired or revoked MCP token',
  )
  await check('write-token/still-works', async () =>
    eq(
      (await restOk(c.writeToken, 'GET', '/me')).credential.name,
      c.writeToken.name,
      'write token',
    ),
  )
  await check('write-token/ui/revoke', () => revokeTokenInUi(c.writeToken.name))
  await checkRevoked(
    c.writeToken,
    'this personal access token has been revoked or has expired',
    'unknown, expired or revoked MCP token',
  )
  await check('standard-key/ui/revoke', () => revokeAgentKeyInUi(run.agents.std.id, c.stdKey.name))
  await checkRevoked(
    c.stdKey,
    'this agent key has been revoked',
    'unknown, revoked or deactivated agent key',
  )
  await check('viewer-key/ui/revoke', () => revokeAgentKeyInUi(run.agents.viewer.id, 'Default key'))
  await checkRevoked(
    c.viewerKey,
    'this agent key has been revoked',
    'unknown, revoked or deactivated agent key',
  )
  await check('oauth-read/ui/delete', () => deleteConnectionInUi(c.oauthRead.name))
  await checkRevoked(c.oauthRead, null, OAUTH_GONE)
  await check('oauth-write/still-works', async () =>
    eq((await toolOk(c.oauthWrite, 'get_me')).credential.name, c.oauthWrite.name, 'OAuth write'),
  )
  await check('oauth-write/ui/delete', () => deleteConnectionInUi(c.oauthWrite.name))
  await checkRevoked(c.oauthWrite, null, OAUTH_GONE)
  for (const cred of [c.oauthWrite, c.oauthRead])
    await refused(`${cred.id}/revoked/refresh`, 'revoked', async () => {
      const r = await tokenRequest(cred.clientId, {
        grant_type: 'refresh_token',
        refresh_token: cred.refresh,
      })
      return {
        ok: r.status === 200,
        matches: r.status === 400 && r.body?.error === 'invalid_grant',
        seen: `${r.status} ${short(r.body?.error)}`,
        want: '400 invalid_grant',
      }
    })
  // delete revoked credentials and the agents in the app
  await check('read-token/ui/delete', () => deleteTokenInUi(c.readToken.name))
  await check('write-token/ui/delete', () => deleteTokenInUi(c.writeToken.name))
  await refused('write-token/deleted/rest', 'revoked', async () =>
    restOutcome(await rest(c.writeToken, 'GET', '/me'), 401, 'unknown personal access token'),
  )
  await check('standard-agent/ui/delete-keys', async () => {
    await deleteAgentKeyInUi(run.agents.std.id, 'Default key')
    await deleteAgentKeyInUi(run.agents.std.id, c.stdKey.name)
  })
  await refused('standard-key/deleted/rest', 'revoked', async () =>
    restOutcome(await rest(c.stdKey, 'GET', '/me'), 401, 'unknown agent key'),
  )
  await check('viewer-agent/ui/delete-key', () =>
    deleteAgentKeyInUi(run.agents.viewer.id, 'Default key'),
  )
  await check('standard-agent/ui/remove', () => removeAgentInUi(run.agents.std.id))
  await check('viewer-agent/ui/remove', () => removeAgentInUi(run.agents.viewer.id))
  run.completed = true
}

async function start() {
  try {
    // Local runs take every URL as an argument; staging takes its deployment
    // from the helper's environment. Nothing is read from .env.local.
    const options = parseArgs(process.argv.slice(2))
    if (options.target === 'staging' && !process.env.CONVEX_DEPLOY_KEY)
      throw new UsageError(
        'Run --staging through the staging helper, which selects the deployment.',
      )
    cfg = { ...options, ...resolveConfig(options, process.env) }
    cfg.mcpUrl = `${cfg.apiOrigin}/mcp`
    // a local run may keep them in the checkout's ignored dev-temp/, as its seed does
    const credentials = loadCredentials(
      fixtureDirectory(ROOT, process.env, { local: cfg.target.target === 'local' }),
      cfg.target,
    )
    if (!credentials)
      throw new UsageError('The Northstar fixture credentials for this deployment are missing.')
    for (const account of credentials.value.accounts) keep(account.password)
    cfg.nora = credentials.value.accounts.find((a) => a.key === 'nora')
    keep(cfg.bypass)
    keep(process.env.CONVEX_DEPLOY_KEY)
    // The deploy key only proved which deployment this is; the run never
    // calls Convex with it. Neither it nor the bypass value stays anywhere
    // a child process or a later step could pick it up.
    delete cfg.target.key
    delete process.env.CONVEX_DEPLOY_KEY
    delete process.env.QIVO_STAGING_PROTECTION_BYPASS
    // A local run may pause billing on its own backend for the billing pause
    // checks. A staging run never reads the key.
    if (cfg.target.target === 'local' && process.env.QIVO_LOCAL_ADMIN_KEY)
      cfg.localAdminKey = keep(process.env.QIVO_LOCAL_ADMIN_KEY)
    delete process.env.QIVO_LOCAL_ADMIN_KEY
  } catch (error) {
    // The fixture CLI's own refusals are written to be safe to print.
    const safe = error instanceof UsageError || error?.constructor?.name === 'DemoCliError'
    console.error(
      redact(
        `staging-check: ${safe ? error.message : 'could not start; raw errors are withheld to keep secrets out of logs.'}`,
      ),
    )
    process.exitCode = 2
    return
  }
  // A closed terminal or pipe must not stop the cleanup: its write errors
  // are dropped, and SIGHUP counts as a first interrupt like Ctrl-C.
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {})
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(signal, () => {
      if (interrupted) process.exit(130)
      interrupted = true
      say(
        'NOTE',
        'interrupt',
        'stopping after this step and cleaning up; a second signal exits without cleanup',
      )
    })
  const runId = randomBytes(3).toString('hex')
  run.tag = `${TAG_PREFIX}${runId}`
  run.creds = {}
  run.created = []
  run.clients = []
  run.nora = { name: cfg.nora.name }
  say('NOTE', 'start', `${cfg.cleanup ? 'cleanup' : `run ${run.tag}`} on ${cfg.appOrigin}`)
  if (cfg.invert.size)
    say(
      'NOTE',
      'invert',
      `expectations inverted for ${[...cfg.invert].join(', ')}; those checks must fail`,
    )
  const began = Date.now()
  let verified = false
  try {
    await openBrowser()
    await must('setup/ui/sign-in', () => signIn(cfg.nora))
    await must('setup/target', verifyTarget, (note) => note)
    // Only now may a credential go to the API origin, the sweep's included.
    // Nothing was created before this point.
    verified = true
    // A local run killed while billing was paused left the organization
    // read-only, which would refuse this run's writes and its sweep.
    if (cfg.localAdminKey)
      try {
        const left = await liftLeftPause()
        if (left)
          say('NOTE', 'billing-pause', `lifted the billing pause ${left} left on the local backend`)
      } catch (error) {
        results.fail.push('billing-pause/left')
        say('FAIL', 'billing-pause/left', describe(error))
      }
    if (cfg.cleanup) {
      const tag = cfg.run ? `${TAG_PREFIX}${cfg.run}` : TAG_ANY
      const { removed, problems } = await sweep(tag, 'cleanup')
      if (problems.length) {
        results.fail.push('cleanup/sweep')
        say(
          'FAIL',
          'cleanup/sweep',
          `removed ${removed} record(s), but ${problems.length} problem(s) remain: ${problems.join('; ')}`,
        )
        billingPauseHint(problems)
      } else {
        results.pass++
        say('PASS', 'cleanup/sweep', `removed ${removed} record(s); nothing with the tag is left`)
      }
      return
    }
    await startCallback()
    oauth = await must('setup/oauth/discovery', discoverOAuth)
    await setup()
    await main()
  } catch (error) {
    if (!(error instanceof Abort)) {
      results.fail.push('run')
      say('FAIL', 'run', describe(error))
    } else {
      // a stopped run never reports success
      if (interrupted) results.fail.push('interrupted')
      say('NOTE', 'run', error.message)
    }
    await shot(app, 'failure-app')
    await shot(consent, 'failure-consent')
  } finally {
    // the sweep needs writes, so a pause this run made goes first
    if (run.billingPaused)
      try {
        await liftBillingPause()
        say('NOTE', 'billing-pause', 'lifted the pause this run made')
      } catch (error) {
        results.fail.push('billing-pause/lift')
        say('FAIL', 'billing-pause/lift', describe(error))
      }
    // The sweep works through the app, so a browser that crashed is opened
    // and signed in again first.
    if (!cfg.cleanup && verified && (!browser?.isConnected() || app?.isClosed()))
      try {
        await browser?.close().catch(() => {})
        consent = undefined
        await openBrowser()
        await signIn(cfg.nora)
        say('NOTE', 'cleanup', 'the browser had closed, so the sweep signed in again')
      } catch (error) {
        say('NOTE', 'cleanup', `the browser could not be opened again: ${describe(error)}`)
      }
    if (!cfg.cleanup && verified) {
      let swept = { removed: 0, problems: [] }
      try {
        swept = await sweep(run.tag, 'cleanup')
      } catch (error) {
        swept.problems.push(describe(error))
      }
      const { removed, problems } = swept
      if (problems.length) {
        results.fail.push('cleanup/sweep')
        say(
          'FAIL',
          'cleanup/sweep',
          `removed ${removed} record(s), but ${problems.length} problem(s) remain: ${problems.join('; ')}. Run --cleanup --run ${run.tag.slice(TAG_PREFIX.length)}`,
        )
        billingPauseHint(problems)
      } else if (!run.completed)
        say('NOTE', 'cleanup/swept', `removed ${removed} record(s) the stopped run left`)
      else if (removed) {
        // the run's own steps should have removed everything
        results.fail.push('cleanup/leftovers')
        say(
          'FAIL',
          'cleanup/leftovers',
          `the sweep had to remove ${removed} record(s) the run left behind`,
        )
      } else {
        results.pass++
        say('PASS', 'cleanup/leftovers', 'nothing with this run tag is left')
      }
      for (const name of run.clients)
        say(
          'NOTE',
          'oauth-remains',
          `${name}: its client registration and its deleted connection's revoked row stay, so an old consent or token cannot revive it`,
        )
    }
    try {
      // signOut does not wait for its request, so wait for the answer here
      if (app && !app.isClosed()) {
        const signedOut = app
          .waitForResponse((r) => r.url().includes('/sign-out'), { timeout: 10_000 })
          .catch(() => {})
        await evaluate(app, () => window.PLANNER?.signOut?.()).catch(() => {})
        await signedOut
      }
      await browser?.close()
    } catch {}
    if (callbackServer) await new Promise((done) => callbackServer.close(done))
    const failed = results.fail.length
    say(
      'DONE',
      cfg.cleanup ? 'cleanup' : run.tag,
      `${results.pass} passed, ${failed} failed, ${results.skip.length} skipped in ${Math.round((Date.now() - began) / 1000)} s${results.retried ? `, ${results.retried} request(s) sent twice after a server error or a write conflict` : ''}`,
    )
    if (failed) say('NOTE', 'failed', results.fail.join(', '))
    if (results.skip.length) say('NOTE', 'skipped', results.skip.join(', '))
    process.exitCode = failed ? 1 : 0
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await start()

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
 * name the credential. It uploads, downloads and deletes attachments, checks
 * the text, name and request size limits, unknown arguments, comment paging
 * and the archived task lists. With --comment-cap it also fills one task to
 * its 400 comments. Every task, comment, grant and file lives in projects the
 * run creates and names with its run tag. It revokes every credential in the
 * app, checks that the next call is refused, and removes everything it made,
 * also after a failure (try/finally, and --cleanup for a later sweep).
 *
 * Checks for features that have not merged yet sit behind feature probes, so
 * a deployment without them reports SKIP. --require turns a SKIP into a FAIL,
 * and --force runs a feature's checks even when its probe does not find it.
 * --invert flips the expectation of a refusal group, so its checks must
 * fail; that proves they can catch a wrong permission.
 *
 * Secrets (passwords, tokens, keys, OAuth codes, upload and download links,
 * the Vercel bypass value) stay in this process's memory. They are never
 * printed, written to disk or passed as process arguments, and every output
 * line goes through redact(). Screenshots are off unless --shots names a
 * directory, and never taken while a secret or a password field is on screen.
 *
 *   staging, from the application checkout (see docs/deployment.md):
 *     "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-staging" \
 *       node scripts/staging-check.mjs --staging --comment-cap
 *     ... node scripts/staging-check.mjs --staging --cleanup
 *   local:
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
import { fixtureDirectory, loadCredentials, resolveTarget } from './marketing-demo.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ORG_SLUG = 'northstar-labs'
/** Every name this script gives a record starts with the tag and a space. */
export const TAG_PREFIX = 'stgchk-'
export const TAG_ANY = /^stgchk-[0-9a-f]{6} /
/** Requests per profile and minute. The deployment allows 300. */
const RATE_BUDGET = 200
/** The second click of an in-place confirm must come 0.5 to 3.5 s after the first. */
const CONFIRM_PAUSE_MS = 800
const MCP_VERSION = '2026-07-28'
/** The one app origin a staging run accepts. */
export const STAGING_APP_ORIGIN = 'https://preview.qivo.io'
const PRODUCTION_HOSTS = new Set(['qivo.io', 'www.qivo.io', 'demo.qivo.io', 'api.qivo.io'])
/** The most comments a task holds (convex/model/commentCounts.ts COMMENT_MAX). */
const COMMENT_MAX = 400
/** The longest REST or MCP request body (convex/machine/shared.ts BODY_MAX_BYTES). */
const BODY_MAX = 1024 * 1024

/** Features that have not merged on main yet, each behind a probe. */
export const FEATURES = [
  'task-progress',
  'last-comment-at',
  'project-completion',
  'task-delay',
  'live-tasks',
  'billing-pause-leave',
]
export const INVERT_GROUPS = [
  'read-token',
  'viewer-agent',
  'oauth-read',
  'other-project',
  'revoked',
]

/* ------------------------------------------------------------- arguments */

class UsageError extends Error {}

/** Parses the command line. Secrets are never accepted as arguments. */
export function parseArgs(argv) {
  const o = {
    require: new Set(),
    force: new Set(),
    invert: new Set(),
    cleanup: false,
    commentCap: false,
  }
  const takes = new Set([
    '--site-url',
    '--app-url',
    '--convex-url',
    '--api-url',
    '--deployment',
    '--require',
    '--force',
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
    else if (arg === '--comment-cap') o.commentCap = true
    else if (takes.has(arg)) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new UsageError(`${arg} needs a value.`)
      if (arg === '--require' || arg === '--force' || arg === '--invert') {
        const known = arg === '--invert' ? INVERT_GROUPS : FEATURES
        const names = value === 'all' ? known : value.split(',')
        for (const name of names) {
          if (!known.includes(name)) throw new UsageError(`${arg} does not know ${name}.`)
          o[arg.slice(2)].add(name)
        }
      } else if (arg === '--run') {
        if (!/^[0-9a-f]{6}$/.test(value)) throw new UsageError('--run takes six hex digits.')
        o.run = value
      } else o[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
    } else throw new UsageError(`Unknown argument ${arg}. Secrets belong in the environment.`)
  }
  if (!o.target) throw new UsageError('Choose --staging or --local.')
  if (o.run && !o.cleanup) throw new UsageError('--run is for --cleanup.')
  if (o.commentCap && o.cleanup) throw new UsageError('--comment-cap does not go with --cleanup.')
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
const isSiteOf = (url, deployment) =>
  url.protocol === 'https:' &&
  url.hostname.endsWith('.convex.site') &&
  url.hostname.split('.')[0] === deployment

/** Resolves where the run goes, refusing production and anything that is
 *  not the explicitly selected staging or local target. It fails closed:
 *  staging needs QIVO_ENVIRONMENT=staging, a prod: key for a deployment the
 *  fixture CLI accepts and the app at preview.qivo.io. */
export function resolveConfig(o, env) {
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

/** Set by the first Ctrl-C or SIGTERM: the run stops before its next check
 *  and goes on to cleanup. A second signal exits at once. */
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

/* ------------------------------------------------------------ HTTP clients */

let cfg
const windows = new Map()

/** Keeps each profile under RATE_BUDGET requests in any 60 seconds, which
 *  also keeps it under the deployment's fixed minute window. */
async function pace(profile) {
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

/** One authenticated request. A 429 waits for Retry-After once, which only
 *  happens when something else uses the same profile at the same time. A
 *  read that answers a server error (5xx) is sent once more after two
 *  seconds, with a NOTE, because a read changes nothing; a write's server
 *  error is reported as it is. */
async function send(profile, url, init, { read = false } = {}) {
  let retried = false
  for (let attempt = 0; ; attempt++) {
    await pace(profile)
    const response = await fetch(url, init)
    if (response.status === 429 && attempt === 0) {
      say('NOTE', 'rate-limit', `${profile} hit the request limit; waiting 60 seconds`)
      await response.arrayBuffer().catch(() => {})
      await sleep(61_000)
      continue
    }
    if (response.status >= 500 && read && !retried) {
      retried = true
      results.retried++
      say('NOTE', 'server-error', `a read answered HTTP ${response.status}; sending it once more`)
      await response.arrayBuffer().catch(() => {})
      await sleep(2000)
      continue
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
  const challenge = await fetch(cfg.mcpUrl, { method: 'POST' })
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
  const resource = await (await fetch(metadataUrl)).json()
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
    await fetch(
      `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/, '')}`,
    )
  ).json()
  for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint'])
    expect(onApi(meta[key]), `${key} is on another origin`)
  return { meta, resource: resource.resource, scopes: 'qivo:read qivo:write offline_access' }
}

async function registerClient(name, redirectUri) {
  const response = await fetch(oauth.meta.registration_endpoint, {
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
  const response = await fetch(oauth.meta.token_endpoint, {
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
  })
  context = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  if (cfg.bypass) {
    // Vercel Deployment Protection: the bypass header goes to the app origin
    // only, never to Convex or anywhere else. Playwright does not route the
    // requests a redirect makes, such as the OAuth authorization endpoint's
    // redirect to the consent page, so the header also asks Vercel for its
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
  await signInBrowser(app, account)
  await app.waitForSelector('[data-all-nav]', { timeout: 60_000 })
  eq(await app.evaluate(() => window.PLANNER.org?.slug), ORG_SLUG, 'signed-in organization')
}

/** Proves the API origin belongs to the app the run signed in to, before any
 *  credential is sent there. The MCP address the app shows is its own
 *  backend. A staging app must also name itself staging in version.json. */
async function verifyTarget() {
  let commit = 'unknown'
  if (cfg.target.target === 'staging') {
    const manifest = await app.evaluate(async () => {
      const r = await fetch('/version.json', { cache: 'no-store' })
      return r.ok ? r.json().catch(() => null) : null
    })
    eq(manifest?.environment, 'staging', 'the app manifest environment')
    commit = String(manifest.commit ?? 'unknown').slice(0, 12)
  }
  await openAccountMcp()
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
  await app.evaluate((id) => window.PLANNER.removeProject(id), project.id)
  await settled()
  expect(
    await until(async () => (await rest(cred, 'GET', `/projects/${project.id}`)).status === 404),
    `project ${project.name} is still there`,
  )
}

/** Runs `call(arg)` in the app and collects the toasts and console errors
 *  it causes, which hold a refusal's sentence. Nothing collected is printed,
 *  and a secret `call` answers stays in memory. */
async function appMessages(call, arg) {
  await app.evaluate(() => {
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
    const value = (await app.evaluate(call, arg)) ?? null
    if (value?.secret) keep(value.secret)
    await sleep(1500)
    return { value, seen: await app.evaluate(() => window.__stgchk.seen) }
  } finally {
    await app.evaluate(() => {
      window.showToast = window.__stgchk.show
      console.error = window.__stgchk.error
      delete window.__stgchk
    })
  }
}

/* --------------------------------------------------------------- cleanup */

/** Finds and removes everything whose name carries `tag` (a run's tag, or
 *  TAG_ANY for every run): projects (with their tasks, comments, files,
 *  grants and milestones), tasks elsewhere, teams, personal tokens, agents
 *  with their keys and OAuth connections. It uses the signed-in browser
 *  session and a temporary token for REST reads. OAuth client registrations
 *  cannot be deleted and stay. Returns the number of records it removed. */
async function sweep(tag, label) {
  const matches = (name) =>
    typeof name === 'string' &&
    (tag instanceof RegExp ? tag.test(name) : name.startsWith(`${tag} `))
  let removed = 0
  const note = (what) => {
    removed++
    say('NOTE', `${label}/removed`, what)
  }
  const tokenName = `${typeof tag === 'string' ? tag : `${TAG_PREFIX}000000`} cleanup token`
  // A temporary token for REST reads and deletes, minted in the browser like
  // the New token dialog does. It is removed last.
  const minted = await app.evaluate(
    async (name) => window.PLANNER.createMcpToken(name, { access: 'write' }),
    tokenName,
  )
  expect(minted?.secret, 'could not create the temporary cleanup token')
  const cleaner = { secret: keep(minted.secret), profile: 'nora', label: 'cleanup token' }
  try {
    // projects: archive, then delete in the app, which takes their tasks
    const projects = [
      ...(await readList(cleaner, '/projects')),
      ...(await readList(cleaner, '/projects?archived=true')),
    ].filter((p) => matches(p.name))
    const roots = projects.filter((p) => !projects.some((q) => q.id === p.parent_id))
    for (const p of roots) {
      await deleteProjectInApp(cleaner, p)
      note(`project ${p.name}`)
    }
    // tasks outside those projects, active and archived
    for (const task of await findTasks(cleaner, tag)) {
      const r = await rest(cleaner, 'DELETE', `/tasks/${task.id}`)
      expect(r.status === 200 || r.status === 404, `could not delete task ${task.key}`)
      note(`task ${task.key} ${task.title}`)
    }
    // teams, which only the app deletes
    const teams = (await readList(cleaner, '/teams')).filter((t) => matches(t.name))
    for (const team of teams) {
      await app.waitForFunction((id) => window.PLANNER.canDeleteTeam(id), team.id, {
        timeout: 30_000,
      })
      expect(
        await app.evaluate((id) => window.PLANNER.removeTeam(id), team.id),
        `could not delete team ${team.name}`,
      )
      note(`team ${team.name}`)
    }
    // OAuth connections
    const connections = (await app.evaluate(() => window.PLANNER.listOAuthConnections())) ?? []
    for (const c of connections.filter((c) => matches(c.clientName))) {
      expect(
        await app.evaluate((id) => window.PLANNER.revokeOAuthConnection(id), c.id),
        'could not delete an OAuth connection',
      )
      note(`OAuth connection ${c.clientName}`)
    }
    // agents and their keys
    const keys = (await app.evaluate(() => window.PLANNER.listAgentKeys())) ?? []
    const agents = await app.evaluate(() =>
      window.PLANNER.users.filter((u) => u.isAgent).map((u) => ({ id: u.id, name: u.name })),
    )
    for (const agent of agents.filter((a) => matches(a.name))) {
      for (const key of keys.filter((k) => k.agentId === agent.id)) {
        await app.evaluate(
          async ({ id, revoked }) =>
            (revoked || (await window.PLANNER.revokeAgentKey(id))) &&
            (await window.PLANNER.deleteAgentKey(id)),
          { id: key.id, revoked: !!key.revokedAt },
        )
      }
      await app.evaluate((id) => window.PLANNER.removeUser(id), agent.id)
      await settled()
      await until(async () => !(await readList(cleaner, '/users')).some((u) => u.id === agent.id))
      note(`agent ${agent.name}`)
    }
    // personal tokens, the temporary one last
    const tokens = (await app.evaluate(() => window.PLANNER.listMcpTokens())) ?? []
    for (const t of tokens.filter((t) => matches(t.name) && t.id !== minted.id)) {
      const ok = await app.evaluate(
        async ({ id, revoked }) =>
          (revoked || (await window.PLANNER.revokeMcpToken(id))) &&
          (await window.PLANNER.deleteMcpToken(id)),
        { id: t.id, revoked: !!t.revokedAt },
      )
      expect(ok, `could not delete token ${t.name}`)
      note(`personal token ${t.name}`)
    }
    // A deployment with Deleted items keeps deleted projects and tasks there,
    // where only an admin's Delete now in the app removes them early.
    const catalogue = await mcp(cleaner, 'tools/list', {})
    const deleteTask = catalogue.json?.result?.tools?.find((t) => t.name === 'delete_task')
    if (deleteTask?.description?.includes('Deleted items'))
      say(
        'NOTE',
        `${label}/deleted-items`,
        `this deployment keeps the deleted projects and tasks in Deleted items for 30 days; an admin can delete the ones named ${tag instanceof RegExp ? `${TAG_PREFIX}…` : tag} for good there`,
      )
  } finally {
    await app.evaluate(
      async (id) => (await window.PLANNER.revokeMcpToken(id)) && window.PLANNER.deleteMcpToken(id),
      minted.id,
    )
  }
  return removed
}

/** Tasks whose title carries the tag, active and archived. Archived tasks
 *  are listed one top-level project at a time, active and archived ones. */
async function findTasks(cred, tag) {
  const fragment = typeof tag === 'string' ? tag : TAG_PREFIX
  const found = new Map()
  const take = (rows) => {
    for (const row of rows ?? [])
      if (typeof tag === 'string' ? row.title.startsWith(`${tag} `) : tag.test(row.title))
        found.set(row.id, row)
  }
  const search = encodeURIComponent(fragment)
  for (let offset = 0; ; offset += 200) {
    const page = await readList(cred, `/tasks?search=${search}&limit=200&offset=${offset}`)
    take(page)
    if (page.length < 200) break
  }
  const projects = [
    ...(await readList(cred, '/projects')),
    ...(await readList(cred, '/projects?archived=true')),
  ].filter((p) => p.parent_id === null)
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
const TOO_MANY_COMMENTS = `this task has ${COMMENT_MAX} comments, the most a task can have; start a new task to continue`
const NOT_SAME_FAMILY =
  'a subtask must be in the same project as its parent task, in any of its sub-projects'
const UPLOAD_MISSING = 'upload not found or expired; start a new upload'

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
      row.detail === provenance || row.detail?.endsWith(` — ${provenance}`),
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

/** Refuses an upload URL that is not this deployment's storage. */
function checkUploadUrl(value) {
  keep(value)
  let u
  try {
    u = new URL(value)
  } catch {
    fail('the upload URL is not a URL')
  }
  const ok =
    cfg.target.target === 'local'
      ? u.origin === cfg.target.url
      : u.protocol === 'https:' &&
        u.hostname.endsWith('.convex.cloud') &&
        u.hostname.split('.')[0] === cfg.target.deployment
  expect(ok, 'the upload URL is not on this deployment')
}

/** Sends the bytes to a ticket's upload URL and answers the storage id. */
async function putBytes(uploadUrl, bytes, type) {
  checkUploadUrl(uploadUrl)
  const r = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body: bytes,
  })
  expect(r.ok, `the upload answered HTTP ${r.status}`)
  const storageId = (await r.json().catch(() => null))?.storageId
  expect(typeof storageId === 'string', 'the upload answered no storageId')
  return storageId
}

/** Downloads an attachment link, which must be on the API origin. */
async function download(url) {
  keep(url)
  const u = new URL(url)
  expect(onApi(url) && u.pathname.startsWith('/files/'), 'a file link is not on this API origin')
  const r = await fetch(url)
  return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) }
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

/** Uploads over REST with the three requests, downloads and compares. */
async function restUpload(cred, task, name) {
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

/** Uploads over MCP: start_attachment_upload, the bytes, then the confirm. */
async function mcpUpload(cred, task, name) {
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
      keepFile(
        await (surface === 'rest' ? restUpload(cred, task, name) : mcpUpload(cred, task, name)),
        cred,
        surface,
      )
      return 'uploaded, downloaded and compared'
    })
  }
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
        text: 'x'.repeat(256 * 1024 + 1),
      }),
      'text must be at most 256 KiB (262144 bytes) as UTF-8',
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
  if (pending)
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
  await check('uploads/delete', async () => {
    for (const { att, cred, surface } of made) {
      const r =
        surface === 'rest'
          ? await restOk(cred, 'DELETE', `/tasks/${task.key}/attachments/${att.id}`)
          : await toolOk(cred, 'delete_attachment', { ref: task.key, attachment: att.id })
      eq(r.deleted, true, `deleted ${att.name}`)
    }
    eq((await restOk(w, 'GET', `/tasks/${task.key}/attachments`)).length, 0, 'files left')
    if (made[0]) eq((await download(made[0].att.url)).status, 404, 'a deleted file downloads')
    return `${made.length} files deleted`
  })
}

/* ------------------------------------------------------ merged features */

const schemaOf = (name) => run.tools.get(name)?.inputSchema?.properties ?? {}

/** `n` code points starting with the run tag. */
const nameOf = (n, fill = 'n') => `${run.tag} ${fill.repeat(n - run.tag.length - 1)}`

/** 20,000 characters on descriptions, comments and archive reasons (#114). */
async function textCapChecks() {
  const w = run.creds.writeToken
  const A = run.projects.A
  const over = 'a'.repeat(20001)
  const title = `${run.tag} text caps`
  let key
  await check('text-caps/rest/description', async () => {
    await restRefusal(
      w,
      'POST',
      '/tasks',
      { project: A.id, title, description: over },
      400,
      'description must be at most 20,000 characters',
    )
    const made = await restOk(w, 'POST', '/tasks', {
      project: A.id,
      title,
      description: 'a'.repeat(20000),
    })
    run.created.push(made)
    key = made.key
    const titled = (await restOk(w, 'GET', `/tasks?project=${A.id}&limit=200`)).filter(
      (t) => t.title === title,
    )
    eq(titled.length, 1, 'tasks with the cap title (only the 20,000 one)')
    await restRefusal(
      w,
      'PATCH',
      `/tasks/${key}`,
      { description: over },
      400,
      'description must be at most 20,000 characters',
    )
  })
  if (!key) return
  await check('text-caps/rest/comment', async () => {
    await restRefusal(
      w,
      'POST',
      `/tasks/${key}/comments`,
      { body: 'b'.repeat(20001) },
      400,
      'a comment must be at most 20,000 characters',
    )
    const c = await restOk(w, 'POST', `/tasks/${key}/comments`, { body: 'b'.repeat(20000) })
    await restRefusal(
      w,
      'PATCH',
      `/comments/${c.id}`,
      { body: 'c'.repeat(20001) },
      400,
      'a comment must be at most 20,000 characters',
    )
  })
  await check('text-caps/rest/archive-reason', async () => {
    await restRefusal(
      w,
      'PATCH',
      `/tasks/${key}`,
      { archived: true, archive_reason: 'c'.repeat(20001) },
      400,
      'archive_reason must be at most 20,000 characters',
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
      schemaText('create_task', 'description: Too big: expected string to have <=20000 characters'),
      'refusal',
    )
    const listed = await toolOk(w, 'list_tasks', { project: A.id, limit: 200 })
    expect(!listed.some((t) => t.title === `${title} MCP`), 'MCP created the over-long task')
  })
  await check('text-caps/mcp/comment', async () => {
    eq(
      await toolRefusal(w, 'add_comment', { ref: key, body: 'b'.repeat(20001) }),
      schemaText('add_comment', 'body: Too big: expected string to have <=20000 characters'),
      'refusal',
    )
  })
  await check('text-caps/mcp/archive-reason', async () => {
    eq(
      await toolRefusal(w, 'update_task', {
        ref: key,
        archived: true,
        archive_reason: 'c'.repeat(20001),
      }),
      schemaText(
        'update_task',
        'archive_reason: Too big: expected string to have <=20000 characters',
      ),
      'refusal',
    )
    eq((await restOk(w, 'GET', `/tasks/${key}`)).archived, false, 'archived after the refusal')
  })
}

/** Comment paging with limit and before on a small thread (#118). */
async function commentPageChecks() {
  const w = run.creds.writeToken
  const task = await restOk(w, 'POST', '/tasks', {
    project: run.projects.A.id,
    title: `${run.tag} comment pages`,
  })
  run.created.push(task)
  const ids = []
  for (const n of [1, 2, 3])
    ids.push(
      (await restOk(w, 'POST', `/tasks/${task.key}/comments`, { body: `${run.tag} page ${n}` })).id,
    )
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
    for (const limit of ['0', '51', 'x'])
      await restRefusal(
        w,
        'GET',
        `/tasks/${task.key}/comments?limit=${limit}`,
        undefined,
        400,
        'limit must be a whole number from 1 to 50',
      )
    await restOk(w, 'GET', `/tasks/${task.key}/comments?limit=50`)
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
      await toolRefusal(w, 'list_comments', { ref: task.key, limit: 51 }),
      schemaText('list_comments', 'limit: Too big: expected int to be <=50'),
      'limit 51',
    )
  })
}

/** 80 code points on project, sub-project, milestone, team, organization,
 *  agent key and personal token names (#127). Creates the run's team. */
async function nameCapChecks() {
  const w = run.creds.writeToken
  const M = run.projects.M
  const PROJECT = 'a project name must be at most 80 characters'
  const over = nameOf(81)
  const emoji = nameOf(80, '🙂')
  let sub
  await check('name-caps/rest/project', async () => {
    await restRefusal(w, 'POST', '/projects', { name: over }, 400, PROJECT)
    await restRefusal(w, 'POST', '/projects', { name: over, parent: M.id }, 400, PROJECT)
    // 80 code points of emoji are 159 UTF-16 code units, and still fit
    sub = await restOk(w, 'POST', '/projects', { name: emoji, parent: M.id })
    eq(sub.name, emoji, 'the 80 code point name')
    await restRefusal(w, 'PATCH', `/projects/${sub.id}`, { name: over }, 400, PROJECT)
    eq((await restOk(w, 'PATCH', `/projects/${sub.id}`, { name: emoji })).name, emoji, 'resent')
  })
  await check('name-caps/mcp/project', async () => {
    eq(
      await toolRefusal(w, 'create_project', { name: over, parent: M.id }),
      schemaText('create_project', 'name: Too big: expected string to have <=80 characters'),
      'create_project',
    )
    if (sub) {
      eq(
        await toolRefusal(w, 'update_project', { project: sub.id, name: over }),
        schemaText('update_project', 'name: Too big: expected string to have <=80 characters'),
        'update_project',
      )
      const party = nameOf(80, '🎉')
      eq(
        (await toolOk(w, 'update_project', { project: sub.id, name: party })).name,
        party,
        'update_project with 80 code points',
      )
    }
  })
  await check('name-caps/milestone', async () => {
    await restRefusal(
      w,
      'POST',
      `/projects/${M.id}/milestones`,
      { name: over, date: '2026-11-02' },
      400,
      'a milestone name must be at most 80 characters',
    )
    eq(
      await toolRefusal(w, 'set_milestone', { project: M.id, name: over, date: '2026-11-02' }),
      schemaText('set_milestone', 'name: Too big: expected string to have <=80 characters'),
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
    const TEAM = 'a team name must be at most 80 characters'
    await restRefusal(w, 'POST', '/teams', { name: over }, 400, TEAM)
    eq(
      await toolRefusal(w, 'set_team', { name: over }),
      schemaText('set_team', 'name: Too big: expected string to have <=80 characters'),
      'set_team',
    )
    run.team = await restOk(w, 'POST', '/teams', { name: `${run.tag} team` })
    await restRefusal(w, 'PATCH', `/teams/${run.team.id}`, { name: over }, 400, TEAM)
    const teams = await restOk(w, 'GET', '/teams')
    eq(teams.filter((t) => t.name.startsWith(`${run.tag} `)).length, 1, 'teams of this run')
  })
  await check('name-caps/app/organization', async () => {
    const out = await appMessages(
      (name) => window.PLANNER.setOrg({ name }),
      `${run.orgName} ${'n'.repeat(80)}`,
    )
    expect(
      out.seen.some((m) => /organization name must be at most 80 characters/i.test(m)),
      'the app showed no organization name refusal',
    )
    eq((await restOk(w, 'GET', '/me')).organization.name, run.orgName, 'the organization name')
    expect(
      await until(async () => (await app.evaluate(() => window.PLANNER.org?.name)) === run.orgName),
      'the app did not revert the organization name',
    )
  }).then(async (ok) => {
    // a deployment that took the name gets Northstar's name back at once
    const now = (await rest(w, 'GET', '/me')).json?.organization?.name
    if (!ok && now !== run.orgName)
      await app.evaluate((name) => window.PLANNER.setOrg({ name }), run.orgName)
  })
  await check('name-caps/app/token', async () => {
    const out = await appMessages(
      (name) => window.PLANNER.createMcpToken(name, { access: 'read' }),
      over,
    )
    eq(out.value, null, 'the app answer')
    expect(
      out.seen.some((m) => m.includes('a token name must be at most 80 characters')),
      'the app logged no token name refusal',
    )
    const made = await app.evaluate(
      (name) => window.PLANNER.createMcpToken(name, { access: 'read' }),
      nameOf(80),
    )
    expect(made?.id, 'an 80 character token name was refused')
    keep(made.secret)
    expect(
      await app.evaluate(
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
    expect(
      out.seen.some((m) => m.includes('a key name must be at most 80 characters')),
      'the app logged no key name refusal',
    )
    const keys = (await app.evaluate(() => window.PLANNER.listAgentKeys())) ?? []
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
  const restBody = (pad) => JSON.stringify({ project, title: `${run.tag} body cap`, padding: pad })
  const envelope = rpcBody('tools/call', { name: 'get_me' })
  const mcpBody = (pad) =>
    JSON.stringify({ ...envelope, params: { ...envelope.params, arguments: { padding: pad } } })
  await check('body-cap/rest', async () => {
    const over = await rest(w, 'POST', '/tasks', sized(BODY_MAX + 1, restBody), { raw: true })
    eq(over.status, 413, 'a body one byte over the cap')
    eq(over.json?.error, 'request body is too large', 'the 413 sentence')
    const at = await rest(w, 'POST', '/tasks', sized(BODY_MAX, restBody), { raw: true })
    expect(
      at.status >= 400 && at.status < 500 && at.status !== 413,
      `a body at the cap reaches the route: got ${at.status}`,
    )
    // chunked, without a Content-Length
    const bytes = Buffer.from(sized(BODY_MAX + 1000, restBody))
    await pace(w.profile)
    const chunked = await fetch(`${cfg.apiOrigin}/v1/tasks`, {
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
    const anonymous = await fetch(`${cfg.apiOrigin}/v1/tasks`, {
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
        error: { code: -32600, message: 'Bad Request: the request body is too large' },
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
    const anonymous = await fetch(cfg.mcpUrl, {
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
  await restoreStandardGrant()
  const team = run.team
  const nora = run.nora.id
  const routes = [
    [
      'PUT',
      `/projects/${A.id}/access/users/${std.id}`,
      { level: 'user', levle: 'user' },
      'levle',
      'level',
    ],
    [
      'DELETE',
      `/projects/${A.id}/access/users/${std.id}`,
      { on_held_task: 'keep_as_viewer' },
      'on_held_task',
      'on_held_tasks',
    ],
    ...(team
      ? [
          [
            'PUT',
            `/projects/${M.id}/access/teams/${team.id}`,
            { level: 'viewer', levle: 'viewer' },
            'levle',
            'level',
          ],
          [
            'DELETE',
            `/projects/${M.id}/access/teams/${team.id}`,
            { on_held_task: 'leave' },
            'on_held_task',
            'on_held_tasks',
          ],
          ['PUT', `/teams/${team.id}/members/${nora}`, { leadr: true }, 'leadr', 'leader'],
          [
            'DELETE',
            `/teams/${team.id}/members/${nora}`,
            { on_held_task: 'leave' },
            'on_held_task',
            'on_held_tasks',
          ],
        ]
      : []),
  ]
  await check('unknown-args/rest/access-routes', async () => {
    expect(team, 'the run has no team, so only two routes were checked')
    for (const [method, path, body, field, takes] of routes)
      await restRefusal(
        w,
        method,
        path,
        body,
        400,
        `unknown field "${field}"; this request takes ${takes}`,
      )
    await restRefusal(
      w,
      'PUT',
      `/projects/${A.id}/access/users/${std.id}`,
      { level: 'user', aa: 1, bb: 2 },
      400,
      'unknown fields "aa", "bb"; this request takes level',
    )
    const project = await restOk(w, 'GET', `/projects/${A.id}`)
    eq(project.grants.users.find((g) => g.id === std.id)?.level, 'user', "the agent's grant")
    eq(
      (await restOk(w, 'GET', `/projects/${M.id}`)).grants.teams.length,
      0,
      'team grants on the project',
    )
    eq((await restOk(w, 'GET', `/teams/${team.id}`)).members.length, 0, 'team members')
    return `${routes.length} routes`
  })
  await restoreStandardGrant()
}

/** Gives the Standard agent its User grant on Alpha back, should a refusal
 *  check on a deployment without the rule have removed it, so later checks
 *  keep their fixture. */
async function restoreStandardGrant() {
  const w = run.creds.writeToken
  const { A } = run.projects
  const grants = (await restOk(w, 'GET', `/projects/${A.id}`)).grants.users
  if (grants.find((g) => g.id === run.agents.std.id)?.level === 'user') return
  await restOk(w, 'PUT', `/projects/${A.id}/access/users/${run.agents.std.id}`, { level: 'user' })
  say('NOTE', 'fixture', "restored the Standard agent's grant on Alpha")
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

/** A subtask stays in its parent's top-level project (#129). Leaves a
 *  parent in Alpha with its subtask in Zulu for the live-tasks probe. */
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

/** Archived task lists need a project and page with a cursor; archived
 *  projects are listed first (#128). Archives the run's project at the end. */
async function archiveChecks() {
  const w = run.creds.writeToken
  const { M, A, Z } = run.projects
  // three archived tasks across both sub-projects
  const archived = []
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
  }
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
    for (const id of archived) expect(!rows.some((t) => t.id === id), 'REST lists an archived task')
    expect(
      rows.every((t) => t.archived === false),
      'an active list holds an archived row',
    )
    const mcpRows = await toolOk(w, 'list_tasks', { project: M.id, limit: 200 })
    for (const id of archived)
      expect(!mcpRows.some((t) => t.id === id), 'MCP lists an archived task')
  })

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
      const all = await restOk(cred, 'GET', '/tasks?limit=200')
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
    const r = await rest(w, 'POST', '/tasks', { project: A.id, title: `${run.tag} into archived` })
    eq(r.status, 400, 'creating a task in an archived project')
  })
}

/* --------------------------------------------------------- comment cap */

/** Posts until a task holds 400 comments with two profiles at once, checks
 *  the refusal of the next one, every page of the thread and the room a
 *  delete makes, then deletes the task (#118, --comment-cap). */
async function commentCapChecks() {
  const w = run.creds.writeToken
  const s = run.creds.stdKey
  const task = await must('comment-cap/task', () =>
    restOk(w, 'POST', '/tasks', { project: run.projects.A.id, title: `${run.tag} comment cap` }),
  )
  run.created.push(task)
  const started = Date.now()
  const posted = []
  let next = 0
  let failure = null
  let retried = 0
  // One post, over REST for Nora and over MCP for the agent. A server
  // failure (500 internal error, which stores nothing) is tried once more.
  const post = async (cred, n) => {
    const body = `${run.tag} cap ${n}`
    for (let attempt = 0; ; attempt++) {
      const r =
        cred === w
          ? await rest(w, 'POST', `/tasks/${task.key}/comments`, { body })
          : await tool(s, 'add_comment', { ref: task.key, body })
      if (cred === w && r.status === 201) return r.json.id
      if (cred !== w && r.status === 200 && r.data?.id) return r.data.id
      const internal =
        r.status === 500 ||
        (r.isError && r.text === 'internal error') ||
        r.json?.error === 'internal error'
      if (!internal || attempt > 0)
        fail(`HTTP ${r.status} ${short(r.isError ? r.text : r.json?.error)}`)
      retried++
      say('NOTE', 'comment-cap', `comment ${n} answered internal error; trying it once more`)
      await sleep(2000)
    }
  }
  // each profile has its own request window, so two workers each post at
  // most RATE_BUDGET a minute
  const worker = async (cred) => {
    while (!failure && next < COMMENT_MAX) {
      const n = ++next
      try {
        posted.push(await post(cred, n))
      } catch (error) {
        failure = `comment ${n}: ${describe(error)}`
        return
      }
      if (posted.length % 50 === 0)
        say(
          'NOTE',
          'comment-cap',
          `${posted.length} of ${COMMENT_MAX} comments after ${Math.round((Date.now() - started) / 1000)} s`,
        )
    }
  }
  await must(
    'comment-cap/fill',
    async () => {
      await Promise.all([worker(w), worker(s)])
      if (failure) fail(failure)
      eq(posted.length, COMMENT_MAX, 'comments posted')
    },
    () =>
      `${COMMENT_MAX} comments in ${Math.round((Date.now() - started) / 1000)} s${retried ? `, ${retried} tried twice after an internal error` : ''}`,
  )
  await check('comment-cap/refused', async () => {
    await restRefusal(
      w,
      'POST',
      `/tasks/${task.key}/comments`,
      { body: `${run.tag} cap 401` },
      400,
      TOO_MANY_COMMENTS,
    )
    eq(
      await toolRefusal(s, 'add_comment', { ref: task.key, body: `${run.tag} cap 401` }),
      TOO_MANY_COMMENTS,
      'add_comment',
    )
  })
  // every page, newest first, until the empty one
  const walk = async (read, limit) => {
    const pages = []
    let before
    for (let i = 0; i < COMMENT_MAX + 2; i++) {
      const page = await read(limit, before)
      if (page.length === 0) return pages
      pages.push(page)
      before = page[0].id
    }
    fail('paging did not end')
  }
  const restRead = async (limit, before) =>
    restOk(
      w,
      'GET',
      `/tasks/${task.key}/comments?${limit ? `limit=${limit}` : ''}${before ? `&before=${before}` : ''}`,
    )
  const mcpRead = async (limit, before) =>
    toolOk(s, 'list_comments', {
      ref: task.key,
      ...(limit ? { limit } : {}),
      ...(before ? { before } : {}),
    })
  let thread = []
  await check('comment-cap/pages', async () => {
    const pages = await walk(restRead)
    eq(pages.length, COMMENT_MAX / 50, 'pages of the default size')
    for (const page of pages) {
      eq(page.length, 50, 'a default page')
      for (let i = 1; i < page.length; i++)
        expect(page[i - 1].created_at <= page[i].created_at, 'a page is not oldest first')
    }
    thread = pages.toReversed().flat()
    eq(new Set(thread.map((c) => c.id)).size, COMMENT_MAX, 'distinct comments across pages')
    same(thread.map((c) => c.id).toSorted(), posted.toSorted(), 'the comments posted')
    for (let i = 1; i < thread.length; i++)
      expect(thread[i - 1].created_at <= thread[i].created_at, 'pages overlap or skip')
    same(
      (await restRead()).map((c) => c.id),
      thread.slice(-50).map((c) => c.id),
      'the newest 50 by default',
    )
    const by37 = (await walk(restRead, 37)).toReversed().flat()
    same(
      by37.map((c) => c.id),
      thread.map((c) => c.id),
      'pages of 37',
    )
    const viaMcp = (await walk(mcpRead, 50)).toReversed().flat()
    same(
      viaMcp.map((c) => c.id),
      thread.map((c) => c.id),
      'MCP pages',
    )
    same(
      (await mcpRead()).map((c) => c.id),
      thread.slice(-50).map((c) => c.id),
      'MCP newest 50 by default',
    )
    return '8 pages of 50, the same thread by 37 and over MCP'
  })
  await check('comment-cap/delete-makes-room', async () => {
    const oldest = thread[0]?.id ?? posted[0]
    eq((await restOk(w, 'DELETE', `/comments/${oldest}`)).deleted, true, 'deleted')
    await restOk(w, 'POST', `/tasks/${task.key}/comments`, { body: `${run.tag} cap again` })
    await restRefusal(
      w,
      'POST',
      `/tasks/${task.key}/comments`,
      { body: `${run.tag} cap 401 again` },
      400,
      TOO_MANY_COMMENTS,
    )
  })
  await check('comment-cap/archive-reason-past-cap', async () => {
    const reason = `${run.tag} archived at the cap`
    eq(
      (await restOk(w, 'PATCH', `/tasks/${task.key}`, { archived: true, archive_reason: reason }))
        .archived,
      true,
      'archived',
    )
    eq((await restRead(1))[0]?.body, reason, 'the reason, posted past the cap')
  })
  await check('comment-cap/delete-task', async () => {
    eq((await restOk(w, 'DELETE', `/tasks/${task.key}`)).deleted, true, 'deleted')
    eq((await rest(w, 'GET', `/tasks/${task.key}`)).status, 404, 'the task after its delete')
    return `${Math.round((Date.now() - started) / 1000)} s in all`
  })
}

/* ------------------------------------------------------ unmerged features
 * Each probe answers whether the deployment has the feature; without it the
 * checks report SKIP, or FAIL under --require. The expected shapes come from
 * the plans the branches implement, so a check may need adjusting once its
 * branch exists. */

/** Runs a feature's checks when its probe finds it, or when --force names
 *  it, which shows what the checks report on a deployment without it. */
async function feature(name, probe, body, absent = 'not on this deployment yet') {
  let present = false
  try {
    present = await probe()
  } catch (error) {
    say('NOTE', `feature/${name}`, `probe failed: ${describe(error)}`)
  }
  if (!present && cfg.force.has(name)) {
    say('NOTE', `feature/${name}`, 'not found by its probe; checking anyway (--force)')
    await body()
    return
  }
  if (!present) {
    if (cfg.require.has(name)) {
      results.fail.push(`feature/${name}`)
      say('FAIL', `feature/${name}`, `required, but ${absent}`)
    } else skip(`feature/${name}`, absent)
    return
  }
  say('NOTE', `feature/${name}`, 'present')
  await body()
}

/** progress, last_comment_at and completion (branch t3code/task-facts),
 *  delay (t3code/task-delay), the live group rule (t3code/live-tasks) and
 *  leave during a billing pause (t3code/billing-pause-access). */
async function unmergedFeatureChecks() {
  const w = run.creds.writeToken
  const { A, Z, M } = run.projects
  const row0 = async () => (await restOk(w, 'GET', `/tasks?project=${A.id}&limit=1`))[0] ?? {}
  await feature(
    'task-progress',
    async () => 'progress' in (await row0()),
    async () => {
      const group = await restOk(w, 'POST', '/tasks', { project: A.id, title: `${run.tag} group` })
      run.created.push(group)
      for (const [title, status] of [
        ['done child', 'done'],
        ['open child', 'todo'],
      ])
        await restOk(w, 'POST', '/tasks', {
          project: A.id,
          title: `${run.tag} group ${title}`,
          parent: group.key,
          status,
        })
      const expected = { done: 1, total: 2, percent: 50, partial: false }
      await check('task-progress/rest', async () => {
        same((await restOk(w, 'GET', `/tasks/${group.key}`)).progress, expected, 'group progress')
        const rows = await restOk(w, 'GET', `/tasks?project=${A.id}&limit=200`)
        same(rows.find((t) => t.id === group.id)?.progress, expected, 'list row progress')
        eq(rows.find((t) => t.id === run.t0.id)?.progress, null, 'leaf progress')
      })
      await check('task-progress/mcp', async () => {
        same((await toolOk(w, 'get_task', { ref: group.key })).progress, expected, 'group progress')
        const rows = await toolOk(w, 'list_tasks', { project: A.id, limit: 200 })
        same(rows.find((t) => t.id === group.id)?.progress, expected, 'list row progress')
      })
    },
  )
  await feature(
    'last-comment-at',
    async () => 'last_comment_at' in (await row0()),
    async () => {
      await check('last-comment-at/rest-and-mcp', async () => {
        const newest = (await restOk(w, 'GET', `/tasks/${run.t0.key}/comments?limit=1`))[0]
        expect(newest, 'the fixture task has no comment')
        eq(
          (await restOk(w, 'GET', `/tasks/${run.t0.key}`)).last_comment_at,
          newest.created_at,
          'REST',
        )
        eq(
          (await toolOk(w, 'get_task', { ref: run.t0.key })).last_comment_at,
          newest.created_at,
          'MCP',
        )
        const rows = await restOk(w, 'GET', `/tasks?project=${M.id}&limit=200`)
        eq(rows.find((t) => t.id === run.t0.id)?.last_comment_at, newest.created_at, 'list row')
        eq(rows.find((t) => t.id === run.tz.id)?.last_comment_at, null, 'without comments')
      })
    },
  )
  await feature(
    'project-completion',
    async () => 'completion' in (await restOk(w, 'GET', `/projects/${A.id}`)),
    async () => {
      await check('project-completion/rest-and-mcp', async () => {
        const rows = await restOk(w, 'GET', `/tasks?project=${A.id}&limit=200`)
        const leaves = rows.filter((t) => !t.is_group)
        const done = leaves.filter((t) => t.status === 'done').length
        const want = {
          done,
          total: leaves.length,
          percent: leaves.length ? Math.round((done / leaves.length) * 100) : 0,
        }
        same((await restOk(w, 'GET', `/projects/${A.id}`)).completion, want, 'REST completion')
        same((await toolOk(w, 'get_project', { project: A.id })).completion, want, 'MCP completion')
      })
    },
  )
  await feature(
    'task-delay',
    async () => 'delay' in (await row0()),
    async () => {
      const late = await restOk(w, 'POST', '/tasks', {
        project: A.id,
        title: `${run.tag} past due`,
        due_date: '2026-01-05',
        remaining_hours: 4,
      })
      run.created.push(late)
      await check('task-delay/rest-and-mcp', async () => {
        same(
          (await restOk(w, 'GET', `/tasks/${late.key}`)).delay,
          { status: 'late', projected_end_week: null },
          'REST past due',
        )
        eq((await toolOk(w, 'get_task', { ref: late.key })).delay?.status, 'late', 'MCP past due')
        eq((await restOk(w, 'GET', `/tasks/${run.tz.key}`)).delay, null, 'no plan and no due date')
      })
      await check('task-delay/track-delay-off', async () => {
        await restOk(w, 'PATCH', `/projects/${A.id}`, { track_delay: false })
        try {
          eq((await restOk(w, 'GET', `/tasks/${late.key}`)).delay, null, 'a project without delay')
        } finally {
          await restOk(w, 'PATCH', `/projects/${A.id}`, { track_delay: true })
        }
      })
    },
  )
  // A parent whose only subtask sits in an archived sibling sub-project is
  // no group under the live rule. The probe runs that case and restores Zulu.
  if (run.parent && run.child) {
    let live = null
    await feature(
      'live-tasks',
      async () => {
        await restOk(w, 'PATCH', `/projects/${Z.id}`, { archived: true })
        live = await restOk(w, 'GET', `/tasks/${run.parent.key}`)
        if (live.is_group) await restOk(w, 'PATCH', `/projects/${Z.id}`, { archived: false })
        return live.is_group === false
      },
      async () => {
        await check('live-tasks/archived-sibling', async () => {
          eq(live?.is_group, false, 'REST is_group')
          eq((await toolOk(w, 'get_task', { ref: run.parent.key })).is_group, false, 'MCP is_group')
          const t = await restOk(w, 'PATCH', `/tasks/${run.parent.key}`, {
            status: 'progress',
            remaining_hours: 5,
          })
          eq(t.remaining_hours, 5, 'a leaf takes its own hours')
        })
        await check('live-tasks/restore-regroups', async () => {
          await restOk(w, 'PATCH', `/projects/${Z.id}`, { archived: false })
          const parent = await restOk(w, 'GET', `/tasks/${run.parent.key}`)
          eq(parent.is_group, true, 'is_group after the restore')
          expect(
            await until(
              async () =>
                (await restOk(w, 'GET', `/tasks/${run.parent.key}`)).remaining_hours === null,
            ),
            "the restore did not clear the parent's own hours",
          )
        })
      },
      'not on this deployment yet; a parent whose only subtask is in an archived sub-project is still a group',
    )
    const z = await restOk(w, 'GET', `/projects/${Z.id}`)
    if (z.archived) await restOk(w, 'PATCH', `/projects/${Z.id}`, { archived: false })
  }
  // Staging runs without billing, so the probe finds no pause and skips.
  await feature(
    'billing-pause-leave',
    async () => (await restOk(w, 'GET', '/me')).billing.read_only === true,
    async () => {
      const viewer = run.agents.viewer
      await check('billing-pause-leave/keep-as-viewer-waits', async () => {
        const r = await rest(w, 'DELETE', `/projects/${M.id}/access/users/${viewer.id}`, {
          on_held_tasks: 'keep_as_viewer',
        })
        eq(r.status, 403, 'keep_as_viewer during a pause')
      })
      await check('billing-pause-leave/leave-removes', async () => {
        const r = await rest(w, 'DELETE', `/projects/${M.id}/access/users/${viewer.id}`, {
          on_held_tasks: 'leave',
        })
        eq(r.status, 200, 'leave during a pause')
        eq(r.json?.removed, true, 'removed')
      })
    },
    'billing does not pause editing on this deployment',
  )
  say(
    'NOTE',
    'feature/subtask-audit',
    'internal audit and backfill only (branch t3code/subtask-audit); nothing to check over REST or MCP',
  )
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
  if (me.billing.read_only)
    throw new Abort('billing pauses editing in this organization, so writes cannot be checked')
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
      eq(schemaOf('list_comments').limit?.maximum, 50, 'list_comments limit maximum')
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
  await commentPageChecks()
  await nameCapChecks()
  await bodyCapChecks()
  await unknownArgumentChecks()
  await listOrderChecks()
  await subtaskRuleChecks()
  if (cfg.commentCap) await commentCapChecks()
  else skip('comment-cap', 'pass --comment-cap to fill a task to 400 comments')
  // features that have not merged yet
  await unmergedFeatureChecks()
  // archived tasks and projects, then delete the projects in the app
  await archiveChecks()
  await check('cleanup/app/delete-project', async () => {
    await deleteProjectInApp(c.writeToken, run.projects.M)
    for (const t of run.created)
      eq(
        (await rest(c.writeToken, 'GET', `/tasks/${t.id}`)).status,
        404,
        `task ${t.key} after the project went`,
      )
    if (run.projects.N) await deleteProjectInApp(c.writeToken, run.projects.N)
  })
  if (run.team)
    await check('cleanup/app/delete-team', async () => {
      await app.waitForFunction((id) => window.PLANNER.canDeleteTeam(id), run.team.id, {
        timeout: 30_000,
      })
      expect(await app.evaluate((id) => window.PLANNER.removeTeam(id), run.team.id), 'refused')
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
    const credentials = loadCredentials(fixtureDirectory(ROOT, process.env), cfg.target)
    if (!credentials)
      throw new UsageError('The Northstar fixture credentials for this deployment are missing.')
    for (const account of credentials.value.accounts) keep(account.password)
    cfg.nora = credentials.value.accounts.find((a) => a.key === 'nora')
    keep(cfg.bypass)
    keep(process.env.CONVEX_DEPLOY_KEY)
  } catch (error) {
    // The fixture CLI's own refusals are written to be safe to print.
    const safe = error instanceof UsageError || error?.constructor?.name === 'DemoCliError'
    console.error(
      `staging-check: ${safe ? error.message : 'could not start; raw errors are withheld to keep secrets out of logs.'}`,
    )
    process.exitCode = 2
    return
  }
  for (const signal of ['SIGINT', 'SIGTERM'])
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
  say(
    'NOTE',
    'start',
    `${cfg.cleanup ? 'cleanup' : `run ${run.tag}`} on ${cfg.appOrigin}${cfg.commentCap ? ' with the comment cap' : ''}`,
  )
  if (cfg.invert.size)
    say(
      'NOTE',
      'invert',
      `expectations inverted for ${[...cfg.invert].join(', ')}; those checks must fail`,
    )
  const began = Date.now()
  let leftovers = 0
  let verified = false
  try {
    await openBrowser()
    await must('setup/ui/sign-in', () => signIn(cfg.nora))
    await must('setup/target', verifyTarget, (note) => note)
    // Only now may a credential go to the API origin, the sweep's included.
    // Nothing was created before this point.
    verified = true
    if (cfg.cleanup) {
      const tag = cfg.run ? `${TAG_PREFIX}${cfg.run}` : TAG_ANY
      leftovers = await sweep(tag, 'cleanup')
      say('NOTE', 'cleanup', `removed ${leftovers} record(s)`)
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
    if (!cfg.cleanup && verified) {
      try {
        leftovers = await sweep(run.tag, 'cleanup')
        if (!run.completed)
          say('NOTE', 'cleanup/swept', `removed ${leftovers} record(s) the stopped run left`)
        else if (leftovers) {
          // the run's own steps should have removed everything
          results.fail.push('cleanup/leftovers')
          say(
            'FAIL',
            'cleanup/leftovers',
            `the sweep had to remove ${leftovers} record(s) the run left behind`,
          )
        } else say('PASS', 'cleanup/leftovers', 'nothing with this run tag is left')
      } catch (error) {
        results.fail.push('cleanup/sweep')
        say(
          'FAIL',
          'cleanup/sweep',
          `${describe(error)}; run --cleanup --run ${run.tag.slice(TAG_PREFIX.length)}`,
        )
      }
      for (const name of run.clients)
        say(
          'NOTE',
          'oauth-remains',
          `${name}: its client registration and its deleted connection's revoked row stay, so an old consent or token cannot revive it`,
        )
    }
    try {
      if (app) await app.evaluate(() => window.PLANNER?.signOut?.()).catch(() => {})
      await browser?.close()
    } catch {}
    if (callbackServer) await new Promise((done) => callbackServer.close(done))
    const failed = results.fail.length
    say(
      'DONE',
      cfg.cleanup ? 'cleanup' : run.tag,
      `${results.pass} passed, ${failed} failed, ${results.skip.length} skipped in ${Math.round((Date.now() - began) / 1000)} s${results.retried ? `, ${results.retried} read(s) sent twice after a server error` : ''}`,
    )
    if (failed) say('NOTE', 'failed', results.fail.join(', '))
    if (results.skip.length) say('NOTE', 'skipped', results.skip.join(', '))
    process.exitCode = failed ? 1 : 0
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await start()

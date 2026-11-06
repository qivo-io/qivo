#!/usr/bin/env node
/* Calls a deployment's sign-in routes after Convex pushed its functions, so
 * a build fails when the hosted runtime cannot run them.
 *
 * The HTTP router (convex/http.ts) imports convex/auth.ts, and with it
 * Better Auth, only inside the sign-in, OAuth machine and metadata handlers.
 * Convex's open-source runtime allows that import in an HTTP action, but
 * nothing public says every hosted runtime does, and a push analyzes the
 * modules without running a handler. So app-deploy.mjs and demo-deploy.mjs
 * run `convex deploy` and then this probe against the deployment's site
 * URL, which the build command (vercel-build.mjs, demo-build.mjs) records
 * for them, because `convex deploy` hands it only to the build command and
 * runs that before it pushes. A refused import answers each route with a
 * 5xx, so the Vercel build fails: a branch preview before main, staging
 * before a release can use the commit, production and the demo before
 * their domain moves. Convex has already pushed the functions by then; see
 * docs/deployment.md for what a failed check leaves and what to do.
 *
 * The probe sends no credential and nothing that creates a session, an
 * OAuth client or a token. It still reads the database: Better Auth runs
 * the OAuth provider's init on every request outside the demo, which reads
 * the deployment's OAuth resource row and inserts it when it is missing, so
 * on a new preview backend the first request can insert that row. It logs
 * one line a request, with the route, the status and the time, never a body
 * or a header value. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** How many times the probe sends a request that got no answer or a 5xx. */
export const PROBE_ATTEMPTS = 4
/** How long the probe waits for each answer, in milliseconds. */
export const PROBE_TIMEOUT_MS = 15_000

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** `site` when it is an https: origin without a path, or with `local` a
 * loopback http: origin, as the Boat checks' local backends serve. Throws
 * otherwise, naming what is wrong but not the value. */
export function probeSite(site, { local = false } = {}) {
  let url
  try {
    url = new URL(site)
  } catch {
    throw new Error('The Convex site URL is not a URL.')
  }
  const loopback = local && url.protocol === 'http:' && LOOPBACK.has(url.hostname)
  if ((url.protocol !== 'https:' && !loopback) || url.origin !== site)
    throw new Error(
      `The Convex site URL must be an ${local ? 'https: or loopback http:' : 'https:'} origin without a path.`,
    )
  return site
}

/* The cookies `header` sets, as [name, value] pairs. Set-Cookie arrives one
 * cookie at a time, and Set-Better-Auth-Cookie as one comma-separated list,
 * whose Expires dates also hold commas. */
const cookiesOf = (headers) =>
  [
    ...(headers.getSetCookie?.() ?? []),
    ...(headers.get('Set-Better-Auth-Cookie') ?? '').split(/,(?=\s*[^\s;,=]+=)/),
  ]
    .map((cookie) => /^\s*([^\s;,=]+)=([^;]*)/.exec(cookie))
    .filter(Boolean)
    .map(([, name, value]) => [name, value])

/* Whether `response` sets a cookie to a value. Clearing one, which
 * get-session does with the token cookie, sets none. */
const setsCookie = (response) => cookiesOf(response.headers).some(([, value]) => value !== '')

const json = async (response) => {
  try {
    return JSON.parse(await response.text())
  } catch {
    return undefined
  }
}

/** The routes the probe calls, in order, and what each must answer: the
 * reason it is wrong, or null. `demo` false names the routes the demo does
 * not serve. */
export const AUTH_PROBES = [
  {
    route: 'GET /api/auth/get-session',
    demo: true,
    init: { method: 'GET' },
    check: async (response) => {
      if (response.status !== 200) return `answered ${response.status}, not 200`
      if (setsCookie(response)) return 'set a cookie without a session'
      const text = (await response.text()).trim()
      return text === 'null' ? null : 'answered a session without a cookie'
    },
  },
  {
    route: 'POST /api/auth/oauth2/token',
    demo: false,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    check: async (response) => {
      if (response.status !== 400) return `answered ${response.status}, not 400`
      if (response.headers.get('Access-Control-Allow-Origin') !== '*')
        return 'answered without its public CORS'
      if (setsCookie(response) || response.headers.get('Set-Cookie') !== null)
        return 'answered with a cookie'
      const body = await json(response)
      return body?.error === 'invalid_request' ? null : 'answered without invalid_request'
    },
  },
  {
    route: 'GET /.well-known/oauth-authorization-server',
    demo: false,
    init: { method: 'GET' },
    check: async (response) => {
      if (response.status !== 200) return `answered ${response.status}, not 200`
      const body = await json(response)
      const methods = body?.token_endpoint_auth_methods_supported
      return Array.isArray(methods) && methods.length === 1 && methods[0] === 'none'
        ? null
        : 'answered metadata whose token endpoint takes another method than none'
    },
  },
]

/**
 * Calls the sign-in route (GET /api/auth/get-session) of the deployment at
 * `site` and, unless `demo`, the OAuth token route with a JSON body it
 * refuses and the authorization server metadata, one after another, and
 * throws naming every route that answered wrongly and how. A request with
 * no answer within PROBE_TIMEOUT_MS or a 5xx answer is sent again, up to
 * PROBE_ATTEMPTS times, 1, 2 and 4 seconds apart. `site` must be an https:
 * origin, or with `local` a loopback http: one. `fetch`, `sleep` and `log`
 * are the tests' to replace.
 */
export async function probeAuthRoutes(
  site,
  {
    demo = false,
    local = false,
    fetch = globalThis.fetch,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    log = console.log,
  } = {},
) {
  probeSite(site, { local })
  const failures = []
  for (const { route, demo: onDemo, init, check } of AUTH_PROBES) {
    if (demo && !onDemo) continue
    const path = route.slice(route.indexOf(' ') + 1)
    let problem = null
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(1000 * 2 ** (attempt - 2))
      const began = Date.now()
      let response
      try {
        response = await fetch(`${site}${path}`, {
          ...init,
          redirect: 'manual',
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
      } catch (error) {
        // a network error's message may quote the request, so only its kind is kept
        problem =
          error?.name === 'TimeoutError'
            ? `gave no answer in ${PROBE_TIMEOUT_MS / 1000} s`
            : 'gave no answer'
        log(`[auth-probe] ${route} no answer (attempt ${attempt})`)
        continue
      }
      log(
        `[auth-probe] ${route} ${response.status} in ${Date.now() - began} ms (attempt ${attempt})`,
      )
      problem = await check(response)
      if (response.status < 500) break
    }
    if (problem !== null) failures.push(`${route} ${problem}`)
  }
  if (failures.length > 0)
    throw new Error(
      `The deployment's auth routes did not answer as expected: ${failures.join('; ')}.`,
    )
  log(
    `[auth-probe] ${demo ? 'the sign-in route answers' : 'the sign-in, token and metadata routes answer'} as expected`,
  )
}

/** Writes the deployment's site URL, which `convex deploy` hands the build
 * command as VITE_CONVEX_SITE_URL, to the file QIVO_SITE_URL_FILE names,
 * for the deploy script's probe after the push. Writes nothing when that
 * variable is unset, and refuses a site URL that is not an https: origin.
 * `write` is writeFileSync; the tests pass their own. */
export function recordSiteUrl(env, write = writeFileSync) {
  if (!env.QIVO_SITE_URL_FILE) return
  write(env.QIVO_SITE_URL_FILE, `${probeSite(env.VITE_CONVEX_SITE_URL ?? '')}\n`, { mode: 0o600 })
}

/**
 * Runs `convex deploy` with `command` as its build command, then probes the
 * auth routes of the deployment it pushed to (probeAuthRoutes). The build
 * command records the site URL in a file of a private temporary folder
 * outside the checkout, so it never reaches dist/, and the folder is
 * removed afterwards, also after a failure. A missing or malformed file
 * fails as a failed probe does. `run` is execFileSync, and `probe` and the
 * rest of `options` reach probeAuthRoutes; the tests pass their own.
 */
export async function pushThenProbe(
  env,
  { run, command, demo = false, probe = probeAuthRoutes, ...options },
) {
  const folder = mkdtempSync(join(tmpdir(), 'qivo-auth-probe-'))
  const file = join(folder, 'site-url')
  try {
    run('npx', ['convex', 'deploy', '--cmd', command], {
      stdio: 'inherit',
      env: { ...env, QIVO_SITE_URL_FILE: file },
    })
    let site
    try {
      site = readFileSync(file, 'utf8').trim()
    } catch {
      throw new Error(
        'The build command recorded no Convex site URL, so the auth routes went unchecked.',
      )
    }
    await probe(probeSite(site), { demo, ...options })
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

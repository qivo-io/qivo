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
 * paging, cursor paging of the active and archived task lists, of the
 * workload's people (machine/workload-pages) and of the user, label, team
 * and member lists with their name search, with a label of its own that it
 * deletes in the app again (machine/people-lists), task progress, last
 * comment times, delay and project completion, which it waits to read whole
 * again after an archive or a restore regroups its counts, and the live
 * group rule. It fills one task with a
 * little more than a page of comments and of history, pages that history
 * over REST and MCP, and in the browser presses Show earlier comments and
 * Show earlier activity in its task window. It opens the Settings page
 * Archived tasks in the browser, and searches main Search there for an
 * active task it made, which must show with Include archived tasks off, and
 * for a task it archived, which must show only with it on, marked Archived,
 * and open read-only with its description and its history under All
 * (ui/search-archived), which checks that the deployment's search index
 * takes the absent archived_at filter and still returns active matches
 * (convex/lib/mainSearch.ts ARCHIVED_FILTER), and that the deployment
 * answers an archived task's text and history (taskWindow.task,
 * snapshot.threadHistory). In Archived tasks it also chooses through the
 * shared project picker on the deployment's navigation reads
 * (ui/project-picker): it finds its project by name, lists its two
 * sub-projects from projectNav.children and chooses both, which must list
 * exactly its three archived tasks, takes Zulu's chip off, finds Zulu by
 * name with its project from projectNav.search, and opens an archived task
 * over Settings, read-only with its description, which leaves the page as
 * it was. In Search it narrows to Zulu through the same picker, where
 * Include archived tasks must find exactly the task it archived there. It
 * opens task links in fresh loads: that
 * archived task's, which must show read-only with its note and title, a
 * number no task has, which must say it can't be opened, and an active
 * task's, which must show its title (ui/task-link), so the deployment
 * answers a number in the organization the address names and an archived
 * link opens. It opens the Board of the project it made and
 * waits for the deployment's answer for it (tasks.board), whose cards must
 * hold its two fixture tasks (ui/board). It opens the window of one fixture
 * task and, from the deployment's batches (taskWindow.relationCandidates),
 * finds the other one in Link task by its ID, a search with no match there
 * that ends the list, a task of its second project only after Search all
 * your projects, and the subtask it made as a current subtask in Add
 * subtask, with one task it makes over REST in its second project and
 * nothing written through the pickers (ui/relation-pickers). It makes a
 * sub-project of its own
 * with an overdue task and a paused one, opens its Overview and waits for
 * the deployment's answers (overview.summary, risk, attention and paused),
 * whose figures, sentence and lists must count exactly those two, then
 * opens its project's Overview, whose health table (overview.health) must
 * hold that sub-project's row with those two tasks' figures, and opens the
 * sub-project's Board from the row (ui/overview). It records the frames the
 * page sends on its sync socket and opens its project's Board, a fixture
 * task's address and its project's Roadmap in fresh loads, none of which may
 * subscribe the workspace's task windows (workspace.tasks), the Roadmap
 * subscribing its own read (tasks.roadmap) and showing the task's row with
 * no read of planning.assigneeLoad (ui/tasks-on-demand), so the
 * deployment's app loads every task only for a page that needs them. The
 * relation pickers step waits for each window's Link task and Add subtask
 * to turn on, which they do once the window's own read of its task has
 * answered, since a task address loads no task window. It makes a label with
 * its run tag over REST and puts it on a fixture task, opens Settings ›
 * Labels on the deployment's live batches (labels.settingsPage), finds the
 * label by search with its count of active tasks, renames it in place and
 * deletes it in its window (ui/settings-labels). It makes a team with its
 * run tag over REST, finds it by search on Settings › Teams' live batches
 * (teams.settingsPage) with 0 members, adds the Standard agent on its page
 * through Add member's search (teams.get, members and addable), checks the
 * count over REST and on both pages, renames the team in place, removes
 * the agent and deletes the team from the list (ui/settings-teams). It
 * makes a sub-project of
 * its own under its second project with a task of the Standard agent's,
 * removes the agent's grant there in the app, whose removal window lists
 * the task from the deployment's preview (accessRemovals.preview), and
 * hands the task to Nora through the window's picker
 * (accessRemovals.reassignChoices) (ui/removal-window). It makes another
 * sub-project there, led by the Standard agent and shared with its team,
 * and on that sub-project's Settings page, from the deployment's reads
 * (projectSettings.get, users, teams and candidates), sets the team's
 * level to Viewer, adds Nora, an admin who is not its lead, through the
 * Add team or user picker's search, and sets its Review time, each checked
 * over REST (ui/project-settings). In the New project dialog, from the
 * deployment's pickers (projectSettings.leadCandidates and candidates
 * without a project), it makes a project of its own led by the Standard
 * agent, shared with its team as Viewer and with Nora as User, and in New
 * sub-project opened from its first project's sidebar menu, after that
 * parent's check (projectSettings.get), a sub-project under the new
 * project, picked from the deployment's sub_project_parents list, led by
 * the Standard agent and without a starter task, each checked over REST
 * (ui/project-dialogs). It makes a sub-project of its own under its
 * project with one task, uploads a file there over REST and opens Billing,
 * whose current storage must show a figure rather than Being counted
 * (billing.usageFigures) and whose Storage by project, searched for its run
 * tag and the word storage, must list that sub-project alone with the
 * file's size (billing.storageProjects), then deletes the file
 * (ui/billing-storage). It calls GET /v1/me once with each of its two
 * agent keys still in use, the Standard agent's named key and the Viewer
 * agent's key, and opens Billing again, whose API calls must show a
 * figure rather than Being counted (billing.usageFigures) and whose API
 * calls by account, searched for its run tag, must list its two agents
 * alone with their calls (billing.apiAccounts); the Standard agent's View
 * credentials must open API access on that agent and Billing's period,
 * and Who counts toward your bill, searched for the run tag, must list
 * both agents (billing.accountList) (ui/billing-accounts). It makes a project of its own with two
 * sub-projects, finds it by its run tag in Settings › Projects from the
 * deployment's list (projectSettings.projects) and opens its sub-projects
 * (subProjects), archives one sub-project alone and then the project over
 * REST, finds the project in Archived projects (archived), shows its
 * sub-projects (archivedSubProjects), one carried and one archived on its
 * own, and restores it there, which must bring back the project and the
 * carried sub-project only, each checked over REST (ui/settings-projects).
 * It makes a milestone with its run tag over REST on its project, and
 * another in a week before the run's own, presses the first one's row on
 * the project's Overview, which opens the Milestones window on the
 * deployment's answer (milestones.get) with the milestone in its place in
 * Upcoming (milestones.section), expands Past, which must show the past
 * milestone only once expanded and not after it was deleted over REST, and
 * renames and deletes the first one there, each of which REST then shows
 * (ui/milestones). It makes a task of the Standard agent's in Alpha over
 * REST and opens Team sync on its project in a fresh load, which must
 * subscribe Team sync's agenda (teamSync.agenda) and no task window, and
 * show the task's card on the agent's line from the rail (ui/team-sync).
 * Every task, comment,
 * grant and file lives in projects the run creates and names with its run
 * tag. It revokes every credential in the app, checks that the next call is
 * refused, and removes everything it made, also after a failure
 * (try/finally, and --cleanup for a later sweep).
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
/** The status the run's fixture tasks start in: one Focus keeps
 *  (convex/lib/viewReads.ts FOCUS_STATUSES), so ui/board finds their cards
 *  whether or not Nora saved Focus on. */
export const FIXTURE_STATUS = 'todo'
/** The rows one page of a task's thread holds: comments
 *  (convex/model/comments.ts COMMENT_PAGE_MAX), history over REST and MCP
 *  (convex/lib/activityVisibility.ts HISTORY_PAGE_MAX), which answer one
 *  page a call, and history in the task window (WINDOW_HISTORY_PAGE). The
 *  window opens with one page of comments, and loads one page of history
 *  once All is chosen. */
export const THREAD_PAGE = { comments: LIMITS.listComments.max, history: 500, windowHistory: 50 }

/** The sentences REST GET /v1/tasks and MCP list_tasks refuse a page's
 *  `offset` and `cursor` with, on active and archived lists alike for the
 *  cursor (convex/lib/listCursor.ts), which the script's tests pin. */
export const LIST_REFUSALS = {
  activeOffset: 'offset does not apply to active tasks; pass next_cursor as cursor',
  cursor: 'cursor must be the next_cursor of an earlier page',
}

/** The sentences REST GET /v1/workload and MCP get_workload refuse a page's
 *  `offset`, `limit` and `cursor` with (convex/lib/listCursor.ts and the
 *  limits registry's listWorkload), which the script's tests pin. */
export const WORKLOAD_REFUSALS = {
  offset: 'offset does not apply to workload; pass next_cursor as cursor',
  limit: LIMITS.listWorkload.refusal,
  cursor: LIST_REFUSALS.cursor,
}

/** The people one page of the workload step asks for over each surface:
 *  enough over REST that an organization with more people than the run's
 *  agents takes few requests, and two over MCP, so its pages follow a
 *  cursor however small the organization is. */
export const WORKLOAD_PAGE = { rest: 5, mcp: 2 }

/** The sentences REST GET /v1/users and MCP list_users refuse a page's
 *  `offset`, `limit` and `cursor` with (convex/lib/listCursor.ts and the
 *  limits registry's listUsers), which the script's tests pin. The label,
 *  team and member lists name their own rows in the first two. */
export const PEOPLE_REFUSALS = {
  offset: 'offset does not apply to users; pass next_cursor as cursor',
  limit: LIMITS.listUsers.refusal,
  cursor: LIST_REFUSALS.cursor,
}

/** The rows one page of the people-lists step asks for: users as the
 *  workload step asks for people, and one member a page, so the run's two
 *  members take a cursor. */
export const PEOPLE_PAGE = { rest: 5, mcp: 2, members: 1 }

/** The MCP tools that took no arguments before November 2026 and still
 *  answer a call that sends none of their own arguments, such as a
 *  placeholder alone, as a call of the older catalogue (convex/machine/mcp.ts
 *  FORMERLY_BARE), which the script's tests pin. */
export const FORMERLY_BARE = ['list_users', 'list_labels', 'list_teams']

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
  'list_team_members',
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

/** readOk for a route that answers a whole list, as the project list does.
 *  The task, user, label, team and member lists answer pages instead
 *  (taskPages, restRows). */
async function readList(cred, path) {
  const rows = await readOk(cred, path)
  expect(Array.isArray(rows), `GET ${path.split('?')[0]} answered no list`)
  return rows
}

/** The most pages a check reads of one task list, so a next_cursor that
 *  never ends fails the check instead of holding up the run. */
export const TASK_PAGES_MAX = 200

/** The people of an organization at the design size, agents and
 *  invitations included, which the workload checks page through. */
export const WORKLOAD_PEOPLE = 1000

/** The most pages a workload check reads, at any page size. A page can
 *  end before `limit` people once busy people spend the call's room, or
 *  list none, but it always reads the first person after its cursor
 *  (convex/planning.ts workloadPage), so every page moves on by one person
 *  at least. A page for each person of an organization at the design size,
 *  and two more, so a correct deployment never fails it and a next_cursor
 *  that never ends still fails the check. */
export const WORKLOAD_PAGES_MAX = WORKLOAD_PEOPLE + 2

/**
 * Every row of one REST or MCP list that pages with a cursor, read page by
 * page. `read(cursor)` answers the page after `cursor`, or the first page
 * for null. Each page must be `{next_cursor, <field>}`, and paging goes on
 * until next_cursor is null, because a page can hold fewer than `limit`
 * rows, or none, while it is set. `what` names the list in a failure.
 * Fails on any other answer and past `most` pages.
 */
export async function listPages(read, what, field, most = TASK_PAGES_MAX) {
  const rows = []
  let cursor = null
  for (let n = 0; n < most; n++) {
    const page = await read(cursor)
    expect(
      Array.isArray(page?.[field]) &&
        (page.next_cursor === null || typeof page.next_cursor === 'string'),
      `${what} answered no {next_cursor, ${field}} page`,
    )
    rows.push(...page[field])
    if (page.next_cursor === null) return rows
    cursor = page.next_cursor
  }
  fail(`${what} still had a next_cursor after ${most} pages`)
}

/** Every task of one REST or MCP task list, active or archived
 *  (listPages over `tasks`). */
export const taskPages = (read, what) => listPages(read, what, 'tasks')

/** Every row of a REST or MCP list that pages with a cursor (listPages
 *  over `field`, at most `most` pages). A next_cursor equal to the cursor
 *  the page was read with fails at once. Every page moves on, and a cursor
 *  that names the same position seals to the same text
 *  (convex/lib/archiveCursorSeal.ts), so that answer means a stuck list. */
export const movingPages = (read, what, field, most) =>
  listPages(
    async (cursor) => {
      const page = await read(cursor)
      expect(
        cursor === null || page?.next_cursor !== cursor,
        `${what} answered the cursor it was read with as its next_cursor`,
      )
      return page
    },
    what,
    field,
    most,
  )

/** Every person of the REST or MCP workload (movingPages over `people`, at
 *  most WORKLOAD_PAGES_MAX pages). */
export const workloadPeople = (read, what) => movingPages(read, what, 'people', WORKLOAD_PAGES_MAX)

/** The most pages a check reads of a user, label, team or member list at
 *  `limit` rows a page, the pages of an organization's people at the design
 *  size (WORKLOAD_PEOPLE) and two more. Each page reads its first row
 *  whatever its read budget says (convex/lib/listCursor.ts namedListPage),
 *  and these lists' rows are few beside that budget, so a correct
 *  deployment never fails it and a next_cursor that never ends still fails
 *  the check. */
export const peoplePagesMax = (limit) => Math.ceil(WORKLOAD_PEOPLE / limit) + 2

/** `path` with the query parameters of `q` that are set, URL-encoded. */
export const withQuery = (path, q) => {
  const set = Object.entries(q).filter(([, value]) => value !== undefined && value !== null)
  if (!set.length) return path
  const query = set.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
  return `${path}${path.includes('?') ? '&' : '?'}${query}`
}

/** The search a sweep for `tag` sends the user, label and team lists: the
 *  run's tag, or for any run's tag (TAG_ANY) the prefix they share. The
 *  sweep still keeps only the rows hasTag names. */
export const searchOf = (tag) => (typeof tag === 'string' ? tag : TAG_PREFIX)

/** `path`, a REST task list query, with `cursor` added unless it is null. */
const withCursor = (path, cursor) =>
  cursor === null ? path : `${path}&cursor=${encodeURIComponent(cursor)}`

/** Every row under `field` of the REST list `path` (`/users`, `/labels`,
 *  `/teams` or `/teams/{id}/members`), with `search` when it is set, in
 *  pages of `limit`, each read with readOk, so a cleanup read never takes a
 *  failed answer for an empty list. */
const restRows = (cred, path, field, { search, limit = 200 } = {}) =>
  movingPages(
    (cursor) => readOk(cred, withQuery(path, { search, limit, cursor })),
    `GET /v1${path.split('?')[0]}`,
    field,
    peoplePagesMax(limit),
  )

/** Every row under `field` of the MCP list tool `name` for `args`. */
const mcpRows = (cred, name, field, args = {}) =>
  movingPages(
    (cursor) => toolOk(cred, name, cursor === null ? args : { ...args, cursor }),
    name,
    field,
    peoplePagesMax(args.limit ?? 50),
  )

/** Fails unless `page` is one page of a list, `{next_cursor, <field>}`. */
function expectPage(page, field, what) {
  expect(
    Array.isArray(page?.[field]) &&
      (page.next_cursor === null || typeof page.next_cursor === 'string'),
    `${what} answered no {next_cursor, ${field}} page`,
  )
}

/** Every task the REST task list `path` (`/tasks?…`) holds, each page read
 *  with restOk. */
const restTasks = (cred, path) =>
  taskPages((cursor) => restOk(cred, 'GET', withCursor(path, cursor)), 'GET /v1/tasks')

/** Every task MCP list_tasks holds for `args`. */
const mcpTasks = (cred, args) =>
  taskPages(
    (cursor) => toolOk(cred, 'list_tasks', cursor === null ? args : { ...args, cursor }),
    'list_tasks',
  )

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
 *     then, with or without that token, labels, which only the app
 *     deletes;
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
        const tagged = await restRows(cleaner, '/teams', 'teams', { search: searchOf(tag) })
        for (const team of tagged.filter((t) => matches(t.name)))
          await step(`team ${team.name}`, async () => {
            await app.waitForFunction((id) => window.PLANNER.canDeleteTeam(id), team.id, {
              timeout: 30_000,
            })
            expect(
              await evaluate(
                app,
                (id) =>
                  window.PLANNER.removeAccess({ kind: 'deleteTeam', teamId: id }, { to: null }),
                team.id,
              ),
              'the app could not delete it',
            )
            note(`team ${team.name}`)
          })
      })
    }
    // labels, which only the app deletes, so they go without the token too
    await step('labels', async () => {
      const labels = (
        await evaluate(app, () =>
          window.PLANNER.orgLabels().map((l) => ({ id: l.id, name: l.name })),
        )
      ).filter((l) => matches(l.name))
      for (const label of labels)
        await step(`label ${label.name}`, async () => {
          expect(
            await evaluate(app, (id) => window.PLANNER.removeLabel(id), label.id),
            'the app could not delete it',
          )
          note(`label ${label.name}`)
        })
    })

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
                ? (await rest(cleaner, 'GET', `/users/${agent.id}`)).status === 404
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
        const search = searchOf(tag)
        const teams = (await restRows(cleaner, '/teams', 'teams', { search })).filter((t) =>
          matches(t.name),
        )
        const labels = (await restRows(cleaner, '/labels', 'labels', { search })).filter((l) =>
          matches(l.name),
        )
        const users = (await restRows(cleaner, '/users', 'users', { search })).filter(
          (u) => u.kind === 'agent' && matches(u.name),
        )
        const left = [
          [projects.length, 'project'],
          [tasks.length, 'task'],
          [teams.length, 'team'],
          [labels.length, 'label'],
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
  /** Reads one task list to its end with readOk, so a server failure is
   *  tried again. */
  const readAll = async (path) =>
    take(await taskPages((cursor) => readOk(cred, withCursor(path, cursor)), 'GET /v1/tasks'))
  await readAll(`/tasks?search=${search}&limit=200`)
  const archivedProjects = await readList(cred, '/projects?archived=true')
  for (const p of archivedProjects)
    await readAll(`/tasks?project=${p.id}&search=${search}&limit=200`)
  const projects = [...(await readList(cred, '/projects')), ...archivedProjects].filter(
    (p) => p.parent_id === null,
  )
  for (const p of projects)
    await readAll(`/tasks?archived=true&project=${p.id}&search=${search}&limit=200`)
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
      const tasks = await restTasks(cred, `/tasks?project=${M.id}&limit=200`)
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
      const users = await restRows(cred, '/users', 'users', { search: run.tag })
      expect(
        users.some((u) => u.id === run.agents.std.id),
        'the roster lacks the Standard agent',
      )
      eq(
        (await restOk(cred, 'GET', `/users/${run.agents.std.id}`)).id,
        run.agents.std.id,
        'GET /v1/users/{id}',
      )
      expectPage(await restOk(cred, 'GET', '/labels?limit=1'), 'labels', 'GET /v1/labels')
      expectPage(await restOk(cred, 'GET', '/teams?limit=1'), 'teams', 'GET /v1/teams')
      await restOk(cred, 'GET', '/workload?weeks=1')
      return 'me, projects, project, tasks, task, comments, activity, attachments, users, labels, teams, workload'
    })
  }
  await check(`${cred.id}/mcp/reads`, async () => {
    flagsOk(await toolOk(cred, 'list_projects'), 'MCP')
    eq((await toolOk(cred, 'get_project', { project: A.id })).id, A.id, 'get_project')
    const tasks = await mcpTasks(cred, { project: M.id, limit: 200 })
    expect(
      tasks.some((t) => t.id === run.t0.id),
      'list_tasks lacks the fixture task',
    )
    eq((await toolOk(cred, 'get_task', { ref: run.t0.key })).title, run.t0.title, 'get_task')
    expect(Array.isArray(await toolOk(cred, 'list_comments', { ref: run.t0.key })), 'list_comments')
    expect(Array.isArray(await toolOk(cred, 'list_task_activity', { ref: run.t0.key })), 'activity')
    expect(
      (await mcpRows(cred, 'list_users', 'users', { search: run.tag })).some(
        (u) => u.id === run.agents.std.id,
      ),
      'list_users',
    )
    expectPage(await toolOk(cred, 'list_teams', { limit: 1 }), 'teams', 'list_teams')
    await toolOk(cred, 'get_workload', { weeks: 1 })
    return 'list_projects, get_project, list_tasks, get_task, list_comments, list_task_activity, list_users, list_teams, get_workload'
  })
}

/** The workload pages people with a cursor on both surfaces (#workload):
 *  pages of WORKLOAD_PAGE people hold every person once, the run's agents
 *  among them with one week of hours, the same over REST and MCP, and a
 *  cursor of another window, an offset and a limit out of range are
 *  refused. Every page names from_week, so a run that crosses into a new
 *  week keeps one window. */
async function workloadPageChecks() {
  const w = run.creds.writeToken
  await check('machine/workload-pages', async () => {
    const me = await restOk(w, 'GET', '/me')
    const week = weekOf(todayUtc(), me.organization.week_start)
    const q = `/workload?weeks=1&from_week=${week}`
    const rest = await workloadPeople(
      (cursor) => restOk(w, 'GET', withCursor(`${q}&limit=${WORKLOAD_PAGE.rest}`, cursor)),
      'GET /v1/workload',
    )
    const ids = rest.map((p) => p.id)
    expect(new Set(ids).size === ids.length, 'the REST pages list a person twice')
    for (const agent of [run.agents.std, run.agents.viewer]) {
      const rows = rest.filter((p) => p.id === agent.id)
      eq(rows.length, 1, `${agent.name} in the REST pages`)
      eq(rows[0].status, 'ok', `${agent.name}'s status`)
      eq(rows[0].hours?.length, 1, `${agent.name}'s weeks of hours`)
    }
    const mcp = await workloadPeople(
      (cursor) =>
        toolOk(w, 'get_workload', {
          weeks: 1,
          from_week: week,
          limit: WORKLOAD_PAGE.mcp,
          ...(cursor === null ? {} : { cursor }),
        }),
      'get_workload',
    )
    same(
      mcp.map((p) => p.id),
      ids,
      'the people of get_workload pages',
    )
    const first = await restOk(w, 'GET', `${q}&limit=1`)
    expect(typeof first?.next_cursor === 'string', 'a workload page of one ended the list')
    const cursor = encodeURIComponent(first.next_cursor)
    await restRefusal(
      w,
      'GET',
      `/workload?weeks=2&from_week=${week}&limit=1&cursor=${cursor}`,
      undefined,
      400,
      WORKLOAD_REFUSALS.cursor,
    )
    await restRefusal(w, 'GET', `${q}&offset=5`, undefined, 400, WORKLOAD_REFUSALS.offset)
    await restRefusal(w, 'GET', `${q}&limit=0`, undefined, 400, WORKLOAD_REFUSALS.limit)
    eq(
      await toolRefusal(w, 'get_workload', { weeks: 1, from_week: week, offset: 3 }),
      WORKLOAD_REFUSALS.offset,
      'get_workload offset 3',
    )
    return `${ids.length} people in REST pages of ${WORKLOAD_PAGE.rest} and MCP pages of ${WORKLOAD_PAGE.mcp}; another window's cursor, an offset and limit=0 refused`
  })
}

/** The user, label, team and member lists page with a cursor and search by
 *  name on both surfaces (#users, #teams, #labels). Pages of PEOPLE_PAGE
 *  users hold every user once, the run's agents among them, the same over
 *  REST and MCP, and a search with the run's tag finds exactly those
 *  agents. The run's team, with the two agents put in it for the step, has
 *  a member_count equal to the members its pages list one a page on both
 *  surfaces, and they leave it again, so later steps find it as before. A
 *  label the step makes is found by a search without its accent, and the
 *  step deletes it again in the app, the only place a label is deleted, so
 *  the run leaves nothing to its sweep. An offset, a limit out of range, a
 *  cursor of another search and a users cursor sent to the teams list are
 *  refused, and a users cursor of REST continues on MCP. */
async function peopleListChecks() {
  const w = run.creds.writeToken
  await check('machine/people-lists', async () => {
    const agents = [run.agents.std, run.agents.viewer]
    const agentIds = agents.map((a) => a.id).sort()
    const ids = (rows) => rows.map((r) => r.id)
    const users = await restRows(w, '/users', 'users', { limit: PEOPLE_PAGE.rest })
    expect(new Set(ids(users)).size === users.length, 'the REST pages list a user twice')
    for (const agent of agents)
      eq(users.filter((u) => u.id === agent.id).length, 1, `${agent.name} in the REST pages`)
    same(
      ids(await mcpRows(w, 'list_users', 'users', { limit: PEOPLE_PAGE.mcp })),
      ids(users),
      'the users of list_users pages',
    )
    same(
      ids(await restRows(w, '/users', 'users', { search: run.tag })).sort(),
      agentIds,
      'the users GET /v1/users finds by the run tag',
    )
    same(
      ids(await mcpRows(w, 'list_users', 'users', { search: run.tag.toUpperCase() })).sort(),
      agentIds,
      'the users list_users finds by the run tag',
    )
    // the run's team with the two agents in it, then without them again
    const team = run.team
    expect(team, 'the run has no team')
    for (const agent of agents) await restOk(w, 'PUT', `/teams/${team.id}/members/${agent.id}`, {})
    try {
      const summary = await restOk(w, 'GET', `/teams/${team.id}`)
      eq(summary.member_count, 2, 'the team member_count')
      expect(!('members' in summary), 'GET /v1/teams/{id} still answers members')
      const paged = { limit: PEOPLE_PAGE.members }
      const restMembers = await restRows(w, `/teams/${team.id}/members`, 'members', paged)
      same(ids(restMembers).sort(), agentIds, "the team's members over REST")
      const mcpMembers = await mcpRows(w, 'list_team_members', 'members', {
        team_id: team.id,
        ...paged,
      })
      same(ids(mcpMembers), ids(restMembers), "the team's members over MCP")
      const page = await toolOk(w, 'list_team_members', { team_id: team.id, limit: 1 })
      eq(page.team.member_count, restMembers.length, 'member_count beside the member pages')
      same(
        await restRows(w, '/teams', 'teams', { search: run.tag }),
        [{ id: team.id, name: summary.name, member_count: 2 }],
        'the teams GET /v1/teams finds by the run tag',
      )
    } finally {
      for (const agent of agents)
        await rest(w, 'DELETE', `/teams/${team.id}/members/${agent.id}`, {
          on_held_tasks: 'leave',
        })
    }
    eq((await restOk(w, 'GET', `/teams/${team.id}`)).member_count, 0, 'the team after the step')
    // a label of the step's own, found without its accent
    const label = await restOk(w, 'POST', '/labels', {
      name: `${run.tag} Étiquette`,
      color: '#2563EB',
    })
    same(
      ids(await restRows(w, '/labels', 'labels', { search: `etiquette ${run.tag}` })),
      [label.id],
      'the label GET /v1/labels finds without its accent',
    )
    same(
      ids(await mcpRows(w, 'list_labels', 'labels', { search: `${run.tag} ETIQUETTE` })),
      [label.id],
      'the label list_labels finds without its accent',
    )
    await app.waitForFunction(
      (id) => window.PLANNER?.orgLabels().some((l) => l.id === id),
      label.id,
      { timeout: 30_000 },
    )
    expect(
      await evaluate(app, (id) => window.PLANNER.removeLabel(id), label.id),
      'the app could not delete the label',
    )
    expect(
      await until(async () =>
        (await restRows(w, '/labels', 'labels', { search: run.tag })).every(
          (l) => l.id !== label.id,
        ),
      ),
      'GET /v1/labels still lists the deleted label',
    )
    // the refusals, and a REST cursor that MCP continues
    await restRefusal(w, 'GET', '/users?offset=1', undefined, 400, PEOPLE_REFUSALS.offset)
    await restRefusal(w, 'GET', '/users?limit=0', undefined, 400, PEOPLE_REFUSALS.limit)
    eq(
      await toolRefusal(w, 'list_users', { offset: 1 }),
      PEOPLE_REFUSALS.offset,
      'list_users offset 1',
    )
    const first = await restOk(w, 'GET', '/users?limit=1')
    expect(typeof first?.next_cursor === 'string', 'a users page of one ended the list')
    await restRefusal(
      w,
      'GET',
      withQuery('/users', { limit: 1, search: run.tag, cursor: first.next_cursor }),
      undefined,
      400,
      PEOPLE_REFUSALS.cursor,
    )
    await restRefusal(
      w,
      'GET',
      withQuery('/teams', { cursor: first.next_cursor }),
      undefined,
      400,
      PEOPLE_REFUSALS.cursor,
    )
    const second = await toolOk(w, 'list_users', { limit: 1, cursor: first.next_cursor })
    eq(second.users[0]?.id, ids(users)[1], 'list_users after a cursor of GET /v1/users')
    return `${users.length} users in REST pages of ${PEOPLE_PAGE.rest} and MCP pages of ${PEOPLE_PAGE.mcp}, the run's agents by its tag, its team's 2 members one a page and its label without the accent on both surfaces; offset, limit=0 and other lists' cursors refused`
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
    const active = await restTasks(cred, `/tasks?project=${run.projects.M.id}&limit=200`)
    expect(!active.some((r) => r.id === task.id), 'an archived task is in the active list')
    const comments = await restOk(cred, 'GET', `/tasks/${task.key}/comments`)
    const posted = comments.find((c) => c.body === reason)
    expect(posted, 'the archive reason was not posted as a comment')
    eq(posted.author_name, cred.actor, 'archive reason author')
  })
  await check(`${id}/restore`, async () => {
    const t = await restOk(cred, 'PATCH', `/tasks/${task.key}`, { archived: false })
    eq(t.archived, false, 'archived after restore')
    const active = await restTasks(cred, `/tasks?project=${run.projects.M.id}&limit=200`)
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
    const active = await mcpTasks(cred, { project: run.projects.M.id, limit: 200 })
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
    const tasks = await restTasks(
      run.creds.writeToken,
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
  // A confirm sent again after its answer was lost answers the attachment
  // the first one made, over REST and MCP alike, attaches the file once,
  // and another user still finds no such upload on either surface.
  await check('uploads/confirm-retry', async () => {
    const { bytes, type } = sampleFile()
    const start = await restOk(w, 'POST', `/tasks/${task.key}/attachments`, {
      name: `${run.tag} sent twice.bin`,
      content_type: type,
      size: bytes.length,
    })
    const storage_id = await putBytes(start.upload_url, bytes, type)
    const path = `/tasks/${task.key}/attachments/${start.ticket}`
    const att = await restOk(w, 'POST', path, { storage_id })
    keepFile(att, w, 'rest')
    eq((await restOk(w, 'POST', path, { storage_id })).id, att.id, 'the REST confirm sent again')
    const confirm = { ref: task.key, ticket: start.ticket, storage_id }
    eq((await toolOk(w, 'confirm_attachment_upload', confirm)).id, att.id, 'the MCP one')
    await restRefusal(s, 'POST', path, { storage_id }, 404, UPLOAD_MISSING)
    eq(
      await toolRefusal(s, 'confirm_attachment_upload', confirm),
      UPLOAD_MISSING,
      "the Standard agent sending Nora's confirm again",
    )
    const rows = (await restOk(w, 'GET', `/tasks/${task.key}/attachments`)).filter(
      (a) => a.id === att.id,
    )
    eq(rows.length, 1, 'rows of the file')
    await sameBytes(att, bytes, type)
    return 'the same attachment over REST and MCP, one row, and for another user a REST 404 and the MCP refusal'
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
    const titled = (await restTasks(w, `/tasks?project=${A.id}&limit=200`)).filter(
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
    const listed = await mcpTasks(w, { project: A.id, limit: 200 })
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
    expect(Array.isArray(page?.tasks), 'an active list answered no {next_cursor, tasks} page')
    expect(page.tasks.length <= DEFAULT_PAGE_SIZE, `a default page held ${page.tasks.length} tasks`)
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
    expect(Array.isArray(page?.tasks), 'list_tasks answered no {next_cursor, tasks} page')
    expect(page.tasks.length <= DEFAULT_PAGE_SIZE, `a default page held ${page.tasks.length} tasks`)
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
    const labels = (await readOk(w, `/labels?limit=${LIMITS.labels.max}`)).labels.map((l) => l.id)
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
    const teams = await restRows(w, '/teams', 'teams', { search: run.tag })
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
    let formerly = 0
    const refused = (r, name) =>
      expect(
        r.isError &&
          r.text?.startsWith(schemaText(name, '')) &&
          r.text.endsWith('Unrecognized key: "stgchk_probe"'),
        `${name} did not refuse an unknown argument: ${r.isError ? short(r.text) : 'a result'}`,
      )
    for (const [name, def] of run.tools) {
      const takes = Object.keys(def.inputSchema?.properties ?? {}).length > 0
      const r = await tool(w, name, { stgchk_probe: true })
      if (takes && FORMERLY_BARE.includes(name)) {
        // a probe alone is a call of the older catalogue, answered; beside
        // one of the tool's own arguments it is refused
        expect(!r.isError && r.json?.result, `${name} refused a placeholder sent alone`)
        refused(await tool(w, name, { stgchk_probe: true, limit: 1 }), name)
        formerly++
      } else if (takes) {
        refused(r, name)
        refusing++
      } else {
        expect(!r.isError && r.json?.result, `${name} refused an argument it ignores`)
        ignoring++
      }
    }
    expect(
      refusing > 20 && ignoring === 1 && formerly === FORMERLY_BARE.length,
      `${refusing} refusing, ${formerly} formerly without arguments and ${ignoring} ignoring tools`,
    )
    return `${refusing} tools refuse an unknown argument, ${formerly} that took none before answer one alone and refuse it beside a real one, ${ignoring} without arguments ignores it`
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
      eq((await restRows(w, `/teams/${team.id}/members`, 'members')).length, 0, 'team members')
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

/** Active lists come in creation order over MCP as over REST (#128), and
 *  page with next_cursor alone: small pages, and a limit that changes
 *  between pages, hold the whole list once in order, an offset other than 0
 *  is refused, and a cursor opens only for the list it came from. */
async function listOrderChecks() {
  const w = run.creds.writeToken
  const M = run.projects.M
  const list = `/tasks?project=${M.id}`
  let ids = []
  const ordered = await check('task-lists/creation-order', async () => {
    const restRows = await restTasks(w, `/tasks?project=${M.id}&limit=200`)
    const mcpRows = await mcpTasks(w, { project: M.id, limit: 200 })
    same(
      mcpRows.map((t) => t.id),
      restRows.map((t) => t.id),
      'MCP order',
    )
    for (let i = 1; i < restRows.length; i++)
      expect(restRows[i - 1].created_at <= restRows[i].created_at, 'rows not oldest first')
    ids = restRows.map((t) => t.id)
    const later = restRows.find(
      (t) => t.project_id === run.projects.A.id && t.created_at > run.tz.created_at,
    )
    expect(later, 'no Alpha task created after the Zulu one')
    expect(
      ids.indexOf(run.t0.id) < ids.indexOf(run.tz.id) &&
        ids.indexOf(run.tz.id) < ids.indexOf(later.id),
      'creation order does not cross the sub-projects',
    )
    return `${ids.length} tasks`
  })
  if (!ordered) {
    skip('task-lists/cursor-pages', 'the creation order check failed')
    skip('task-lists/paging-refusals', 'the creation order check failed')
    return
  }
  await check('task-lists/cursor-pages', async () => {
    expect(ids.length >= 3, `${M.name} holds ${ids.length} active tasks, too few to page`)
    // a page holds at most `limit` tasks, and pages of two hold the list once
    const sizes = []
    const twos = await taskPages(async (cursor) => {
      const page = await restOk(w, 'GET', withCursor(`${list}&limit=2`, cursor))
      sizes.push(page?.tasks?.length)
      return page
    }, 'GET /v1/tasks')
    expect(
      sizes.every((n) => n <= 2),
      `pages of two held ${sizes.join(', ')} tasks`,
    )
    same(
      twos.map((t) => t.id),
      ids,
      'REST pages of two',
    )
    same(
      (await mcpTasks(w, { project: M.id, limit: 2 })).map((t) => t.id),
      ids,
      'list_tasks pages of two',
    )
    // a first page of one, then the rest with limit=200 from its cursor
    const first = await restOk(w, 'GET', `${list}&limit=1`)
    expect(typeof first?.next_cursor === 'string', 'a page of one ended the list')
    const rest = await taskPages(
      (cursor) => restOk(w, 'GET', withCursor(`${list}&limit=200`, cursor ?? first.next_cursor)),
      'GET /v1/tasks',
    )
    same(
      [...first.tasks, ...rest].map((t) => t.id),
      ids,
      'a page of one, then the rest with a larger limit',
    )
    return `${ids.length} tasks in ${sizes.length} REST pages of two`
  })
  await check('task-lists/paging-refusals', async () => {
    for (const offset of ['1', '-1', 'abc'])
      await restRefusal(
        w,
        'GET',
        `${list}&offset=${offset}`,
        undefined,
        400,
        LIST_REFUSALS.activeOffset,
      )
    for (const offset of [1, -1])
      eq(
        await toolRefusal(w, 'list_tasks', { project: M.id, offset }),
        LIST_REFUSALS.activeOffset,
        `list_tasks offset ${offset}`,
      )
    const zero = await restOk(w, 'GET', `${list}&limit=1&offset=0`)
    same(
      zero.tasks.map((t) => t.id),
      ids.slice(0, 1),
      'offset=0, the first page',
    )
    same(
      (await toolOk(w, 'list_tasks', { project: M.id, limit: 1, offset: 0 })).tasks.map(
        (t) => t.id,
      ),
      ids.slice(0, 1),
      'list_tasks offset 0, the first page',
    )
    expect(typeof zero.next_cursor === 'string', 'a page of one ended the list')
    const cursor = encodeURIComponent(zero.next_cursor)
    // another filter, another project or the other surface starts a new list
    await restRefusal(
      w,
      'GET',
      `${list}&limit=1&priority=high&cursor=${cursor}`,
      undefined,
      400,
      LIST_REFUSALS.cursor,
    )
    await restRefusal(
      w,
      'GET',
      `/tasks?project=${run.projects.A.id}&limit=1&cursor=${cursor}`,
      undefined,
      400,
      LIST_REFUSALS.cursor,
    )
    eq(
      await toolRefusal(w, 'list_tasks', { project: M.id, limit: 1, cursor: zero.next_cursor }),
      LIST_REFUSALS.cursor,
      'a REST cursor on list_tasks',
    )
    // the same list named by key takes the cursor of the list named by uuid
    same(
      (await restOk(w, 'GET', `/tasks?project=${M.key}&limit=1&cursor=${cursor}`)).tasks.map(
        (t) => t.id,
      ),
      ids.slice(1, 2),
      'the project named by key',
    )
    return 'offset other than 0 refused, cursors kept to their list'
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

/** The Board of the run's project, M, opens on the deployment's answer for
 *  it (convex/tasks.ts board): the Board reaches its ok state and shows the
 *  cards of the two fixture tasks, in Alpha and Zulu, in whatever layout
 *  Nora chose, with Focus on or off (FIXTURE_STATUS). Only reads. It runs
 *  before the run archives M. */
async function boardCheck() {
  const { M } = run.projects
  await check('ui/board', async () => {
    expect(Number.isInteger(M.num), 'the run project has no number')
    await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/board/p/${M.num}`, {
      waitUntil: 'domcontentloaded',
    })
    const ok = app.locator('[data-workspace-view] [data-board-root][data-board-state="ok"]')
    await ok.waitFor({ timeout: 60_000 })
    for (const t of [run.t0, run.tz]) {
      const card = app
        .locator('[data-workspace-view] [data-card]')
        .filter({ hasText: t.title })
        .first()
      expect(
        await until(async () => (await card.count()) === 1),
        `the Board does not show ${t.key}`,
      )
    }
    return `opened the Board of ${M.key} on the deployment's answer, with ${run.t0.key} and ${run.tz.key}`
  })
}

/** The step that opens the task window's relation pickers
 *  (relationPickersCheck). */
export const RELATION_STEP = 'ui/relation-pickers'

/** What the Linked tasks picker says (src/panels/RelationPicker.tsx): at
 *  the end of the task's own project, before Search all your projects,
 *  and once the whole list ended without a match. */
export const RELATION_EXPECTED = {
  family: 'No matching tasks in this project.',
  more: 'Search all your projects',
  none: 'No matching tasks.',
}

/** The task window's relation pickers on the deployment's batches
 *  (convex/taskWindow.ts relationCandidates). The window of run.t0 offers
 *  run.tz in Link task by its typed ID, a search with no match says so at
 *  the end of the project and once Search all your projects ended too, a
 *  task of the second project (N1, made here over REST and pushed to
 *  run.created) shows only after Search all your projects, and the window
 *  of run.parent lists run.child in Add subtask as a current subtask,
 *  checked. Escape closes each picker, so nothing is written. Without N1
 *  the continuation is left out, and without run.child the Subtasks part,
 *  as subtaskRuleChecks makes both. It runs before the run archives M. */
async function relationPickersCheck() {
  const w = run.creds.writeToken
  await check(RELATION_STEP, async () => {
    // made inside the step, so a refused POST fails this step alone
    const far = run.projects.N1
      ? await restOk(w, 'POST', '/tasks', {
          project: run.projects.N1.id,
          title: `${run.tag} far link target`,
        })
      : null
    if (far) run.created.push(far)
    const at = (ref) => `${cfg.appOrigin}/app/${ORG_SLUG}/tasks/${ref.toLowerCase()}`
    const openWindow = async (t) => {
      await app.goto(at(t.key), { waitUntil: 'domcontentloaded' })
      const title = app.locator('[role="dialog"] [data-task-title]')
      await title.waitFor({ timeout: 60_000 })
      expect(
        await until(async () => ((await title.textContent()) ?? '').trim() === t.title),
        `the window of ${t.key} does not show its title`,
      )
    }
    const openPicker = async (label, kind) => {
      const press = app.locator(`[role="dialog"] button[aria-label="${label}"]`)
      expect(await until(async () => await press.isEnabled()), `${label} stays disabled`)
      await press.click()
      const picker = app.locator(`[data-relation-picker="${kind}"]`)
      await picker.waitFor({ timeout: 20_000 })
      return picker
    }
    const typeInto = async (picker, text) => {
      await picker.locator('input').fill(text)
    }
    const shows = async (picker, text) =>
      await until(async () => ((await picker.textContent()) ?? '').includes(text), 30_000)
    await openWindow(run.t0)
    const link = await openPicker('Link task', 'link')
    // the other fixture task by its ID, from the deployment's batch
    await typeInto(link, run.tz.key)
    await link.locator(`[data-picker-row="${run.tz.id}"]`).waitFor({ timeout: 30_000 })
    // a search with no match, at the project's end and at the list's end
    await typeInto(link, `${run.tag} nothing`)
    expect(await shows(link, RELATION_EXPECTED.family), 'no end of the project')
    await link.locator('[data-picker-all]').click()
    expect(await shows(link, RELATION_EXPECTED.none), 'no end of the list')
    expect(
      await until(async () => (await link.getAttribute('data-picker-end')) === ''),
      'the list does not end',
    )
    // a task of the second project only after Search all your projects
    if (far) {
      await typeInto(link, far.title)
      expect(await shows(link, RELATION_EXPECTED.more), 'no Search all your projects')
      eq(await link.locator(`[data-picker-row="${far.id}"]`).count(), 0, 'a far task too soon')
      await link.locator('[data-picker-all]').click()
      await link.locator(`[data-picker-row="${far.id}"]`).waitFor({ timeout: 30_000 })
    }
    await app.keyboard.press('Escape')
    await link.waitFor({ state: 'detached', timeout: 10_000 })
    // the subtask as a current subtask, checked
    if (run.child) {
      await openWindow(run.parent)
      const sub = await openPicker('Add subtask', 'subtask')
      await typeInto(sub, run.child.key)
      const kid = sub.locator(`[data-picker-row="${run.child.id}"][data-picker-current]`)
      await kid.waitFor({ timeout: 30_000 })
      eq(await kid.getAttribute('aria-pressed'), 'true', 'the current subtask is not checked')
      await app.keyboard.press('Escape')
      await sub.waitFor({ state: 'detached', timeout: 10_000 })
    }
    return `found ${run.tz.key} by its ID, the ends of an empty search${far ? `, ${far.key} after Search all your projects` : ''}${run.child ? ` and ${run.child.key} as a current subtask` : ''}`
  })
}

/** The step that checks over the socket that the app loads tasks on demand
 *  (tasksOnDemandCheck). */
export const ON_DEMAND_STEP = 'ui/tasks-on-demand'

/** The query of the workspace's task windows, which the app subscribes only
 *  once a page that needs every task asks for them (src/store/liveParts.ts). */
export const TASK_WINDOWS_QUERY = 'workspace:tasks'

/** The Roadmap's own read (convex/tasks.ts roadmap), which it subscribes
 *  for its tasks in place of the task windows. */
export const ROADMAP_QUERY = 'tasks:roadmap'

/** The planning panel's one-shot read before it read the owner loads,
 *  which no page of the app may ask for now (planning.ts assigneeLoad, kept
 *  for older apps). */
export const ASSIGNEE_LOAD_QUERY = 'planning:assigneeLoad'

/** Whether a frame `text` the page sent on its sync socket subscribes the
 *  query `udfPath`: a ModifyQuerySet with an Add of it. Any other frame,
 *  also one that is no JSON, does not. */
export function addsQuery(text, udfPath) {
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return false
  }
  return (
    message?.type === 'ModifyQuerySet' &&
    Array.isArray(message.modifications) &&
    message.modifications.some((m) => m?.type === 'Add' && m.udfPath === udfPath)
  )
}

/** The app loads tasks on demand, over the deployment's socket: a fresh
 *  load of the run project's Board by its address, as ui/board reads it,
 *  reaches its ok state without subscribing a task window
 *  (TASK_WINDOWS_QUERY), a fresh load of run.t0's address shows its title
 *  without one, and a fresh load of the run project's Roadmap by its
 *  address reaches its ok state and shows run.t0's row (an unscheduled To
 *  Do task has one) without one either, having subscribed its own read
 *  (ROADMAP_QUERY) and never the planning panel's old read
 *  (ASSIGNEE_LOAD_QUERY). It reads only, and leaves the saved view on the
 *  Board for the steps after it. It runs before the run archives M. */
async function tasksOnDemandCheck() {
  const { M } = run.projects
  await check(ON_DEMAND_STEP, async () => {
    expect(Number.isInteger(M.num), 'the run project has no number')
    // the frames each fresh load sends on its sync socket
    let sent = []
    const record = (ws) => ws.on('framesent', (frame) => sent.push(String(frame.payload)))
    app.on('websocket', record)
    try {
      const fresh = async (url) => {
        sent = []
        await app.goto(url, { waitUntil: 'domcontentloaded' })
      }
      const adds = (query) => sent.filter((f) => addsQuery(f, query)).length
      const taskWindows = () => adds(TASK_WINDOWS_QUERY)
      await fresh(`${cfg.appOrigin}/app/${ORG_SLUG}/board/p/${M.num}`)
      await app
        .locator('[data-workspace-view] [data-board-root][data-board-state="ok"]')
        .waitFor({ timeout: 60_000 })
      eq(taskWindows(), 0, 'the Board subscribed task windows')
      await fresh(`${cfg.appOrigin}/app/${ORG_SLUG}/tasks/${run.t0.key.toLowerCase()}`)
      const title = app.locator('[role="dialog"] [data-task-title]')
      await title.waitFor({ timeout: 60_000 })
      expect(
        await until(async () => ((await title.textContent()) ?? '').trim() === run.t0.title),
        `the window of ${run.t0.key} does not show its title`,
      )
      eq(taskWindows(), 0, 'a task address subscribed task windows')
      // the Roadmap reads its tasks from the server, asking for no task
      await fresh(`${cfg.appOrigin}/app/${ORG_SLUG}/roadmap/p/${M.num}`)
      await app
        .locator('[data-workspace-view] [data-roadmap-root][data-roadmap-state="ok"]')
        .waitFor({ timeout: 60_000 })
      await app
        .locator('[data-roadmap-task-open]')
        .filter({ hasText: run.t0.title })
        .first()
        .waitFor({ timeout: 60_000 })
      eq(taskWindows(), 0, 'the Roadmap subscribed task windows')
      expect(adds(ROADMAP_QUERY) > 0, 'the Roadmap did not subscribe its read')
      eq(adds(ASSIGNEE_LOAD_QUERY), 0, "the Roadmap asked for the planning panel's old read")
      const view = (name) =>
        app.locator('[data-view-switch]').getByRole('radio', { name, exact: true })
      await view('Board').click()
      return `opened the Board, ${run.t0.key} and the Roadmap without task windows, the Roadmap on its own read`
    } finally {
      app.off('websocket', record)
    }
  })
}

/** The step that uploads a file through a task window
 *  (attachmentUploadCheck). */
export const UPLOAD_STEP = 'ui/attachment-upload'

/** A file sent through the task window of run.t0, as a person attaches one
 *  (src/panels/IssueDetail.tsx). Its upload goes on a ticket, so the POST
 *  must go to /attachment-uploads/ on the API origin and answer 200, the
 *  window must list the file, and its download must match the bytes. It
 *  deletes the file again over REST. The app on the deployment must send
 *  the file's size (files.uploadUrl), and the hosted receiver must answer
 *  the app's origin, which every upload of the app depends on. It runs
 *  before the run archives M. */
async function attachmentUploadCheck() {
  const w = run.creds.writeToken
  await check(UPLOAD_STEP, async () => {
    const task = run.t0
    await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/tasks/${task.key.toLowerCase()}`, {
      waitUntil: 'domcontentloaded',
    })
    await app.locator('[role="dialog"] [data-task-title]').waitFor({ timeout: 60_000 })
    const bytes = randomBytes(2048)
    const type = 'application/octet-stream'
    const name = `${run.tag} window upload.bin`
    const posted = app.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname.startsWith('/attachment-uploads/'),
      { timeout: 60_000 },
    )
    await app
      .locator('[role="dialog"] input[type="file"][multiple]')
      .setInputFiles({ name, mimeType: type, buffer: bytes })
    const res = await posted
    expect(onApi(res.url()), 'the upload went to another origin than the API')
    eq(res.status(), 200, 'the upload POST')
    await app
      .locator(`[role="dialog"] [data-attachment-open="${name}"]`)
      .waitFor({ timeout: 60_000 })
    const att = (await restOk(w, 'GET', `/tasks/${task.key}/attachments`)).find(
      (a) => a.name === name,
    )
    expect(att, 'the task lacks the file')
    try {
      await sameBytes(att, bytes, type)
    } finally {
      eq(
        (await restOk(w, 'DELETE', `/tasks/${task.key}/attachments/${att.id}`)).deleted,
        true,
        'deleted',
      )
    }
    return `the POST went to /attachment-uploads/ and answered 200, and ${bytes.length} bytes downloaded the same`
  })
}

/** The step that opens Team sync on the deployment's agenda
 *  (teamSyncCheck). */
export const TEAM_SYNC_STEP = 'ui/team-sync'

/** The query Team sync subscribes for its meeting (convex/teamSync.ts
 *  agenda), which reads no task window. */
export const AGENDA_QUERY = 'teamSync:agenda'

/** Team sync reads its meeting from the deployment: a task of the Standard
 *  agent's, In Progress in Alpha, made over REST, shows on the agent's
 *  line of a fresh load of Team sync for the run project M by its address,
 *  on ui/task-link's fresh-load approach. The load's frames must add
 *  AGENDA_QUERY at least once, as a reconnect or a new day or week grid
 *  during the load adds it again on a correct app, and TASK_WINDOWS_QUERY
 *  never, and the page must reach its ok state (data-sync-state). It
 *  writes nothing in the app: the address saves no scope and opening a step
 *  stamps no one.
 *  The cleanup, which deletes M, removes the task. It runs before the run
 *  archives M. */
async function teamSyncCheck() {
  const w = run.creds.writeToken
  const { M, A } = run.projects
  const std = run.agents.std
  await check(TEAM_SYNC_STEP, async () => {
    expect(Number.isInteger(M.num), 'the run project has no number')
    const t = await restOk(w, 'POST', '/tasks', {
      project: A.id,
      title: `${run.tag} team sync`,
      status: 'progress',
      assignee_id: std.id,
    })
    run.created.push(t)
    eq(t.assignee_id, std.id, "the task's assignee")
    const sent = []
    const record = (ws) => ws.on('framesent', (frame) => sent.push(String(frame.payload)))
    app.on('websocket', record)
    try {
      await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/sync/p/${M.num}`, {
        waitUntil: 'domcontentloaded',
      })
      const page = app.locator('[data-workspace-view] [data-sync-page][data-sync-state="ok"]')
      await page.waitFor({ timeout: 60_000 })
      const adds = (query) => sent.filter((f) => addsQuery(f, query)).length
      expect(adds(AGENDA_QUERY) >= 1, 'the load did not subscribe the agenda')
      eq(adds(TASK_WINDOWS_QUERY), 0, 'Team sync subscribed task windows')
      await page.locator(`[data-sync-rail] [data-sync-jump="${std.id}"]`).click()
      await page.locator(`[data-sync-card="${t.key}"]`).waitFor({ timeout: 60_000 })
      return `opened ${M.key}'s meeting on the agenda without task windows, with ${t.key} on its agent's line`
    } finally {
      app.off('websocket', record)
    }
  })
}

/** What the Overview of the run's own sub-project shows once the
 *  deployment answered (overviewCheck): its two tasks, one To do and due
 *  OVERVIEW_OVERDUE_DAYS ago, one paused with no due date, neither assigned,
 *  so no projection reads anyone's work. */
export const OVERVIEW_OVERDUE_DAYS = 70
export const OVERVIEW_EXPECTED = {
  completion: '0 of 2 tasks done',
  paused: '1',
  sentence: '1 task is overdue.',
}

/** What the run's sub-project's row in its project's health table shows
 *  (overviewCheck), cell by cell (data-ovcell): no task done of two, the
 *  paused one, no planned end passed and no remaining hours. Its Delayed
 *  cell reads 1 for the overdue task where the sub-project tracks delay and
 *  is blank where it does not, which the REST answer's track_delay says. */
export const OVERVIEW_HEALTH_EXPECTED = {
  progress: '0%',
  done: '0/2',
  left: '—',
  behind: '—',
  paused: '1',
}

/** The Overview of a sub-project the run makes under its project M, with an
 *  overdue task and a paused one, opens on the deployment's answers
 *  (convex/overview.ts): the root reaches its ok state, Completion reads 0
 *  of 2 tasks done, Paused 1, the sentence names the one overdue task, the
 *  At-risk list holds the overdue task marked overdue and the Paused list
 *  the paused one, both at their end. Then M's own Overview answers its
 *  health table, whose row for the sub-project reads
 *  OVERVIEW_HEALTH_EXPECTED, among M's few sub-projects, which all fit its
 *  first 10 rows, and a press on the row's name opens the sub-project's
 *  Board on the deployment's answer, which leaves the run's saved view on a
 *  Board for the steps after it. It makes the sub-project and its tasks
 *  over REST and pushes the tasks to run.created, so the cleanup, which
 *  deletes M, removes them, and only reads in the app. It runs before the
 *  run archives M. */
async function overviewCheck() {
  const w = run.creds.writeToken
  const { M } = run.projects
  await check('ui/overview', async () => {
    const sub = await restOk(w, 'POST', '/projects', { name: `${run.tag} Overview`, parent: M.id })
    expect(Number.isInteger(sub.num), 'the sub-project has no number')
    const make = async (title, fields) => {
      const t = await restOk(w, 'POST', '/tasks', {
        project: sub.id,
        title: `${run.tag} ${title}`,
        status: 'todo',
        ...fields,
      })
      eq(t.assignee_id, null, `${title} has no assignee`)
      run.created.push(t)
      return t
    }
    const late = await make('overview overdue', {
      due_date: addDays(todayUtc(), -OVERVIEW_OVERDUE_DAYS),
    })
    const held = await make('overview paused', { paused: true })
    await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/overview/p/${sub.num}`, {
      waitUntil: 'domcontentloaded',
    })
    const root = app.locator('[data-workspace-view] [data-overview-root][data-overview-state="ok"]')
    await root.waitFor({ timeout: 60_000 })
    const text = async (css) => ((await root.locator(css).first().textContent()) ?? '').trim()
    const lists = async () =>
      (await root.locator('[data-ov-list][data-ov-list-end]').count()) === 2 &&
      (await root.locator('[data-ov-list][data-ov-list-state="ok"]').count()) === 2
    expect(await until(lists), 'the lists did not reach their end')
    expect(
      (await text('[data-ov-strip] [data-ov-figure="completion"]')).includes(
        OVERVIEW_EXPECTED.completion,
      ),
      `Completion does not read ${OVERVIEW_EXPECTED.completion}`,
    )
    const paused = root.locator('[data-ov-strip] [data-ov-figure="paused"] .font-mono')
    eq(((await paused.first().textContent()) ?? '').trim(), OVERVIEW_EXPECTED.paused, 'Paused')
    eq(await text('[data-ov-summary]'), OVERVIEW_EXPECTED.sentence, 'the sentence')
    const row = root.locator(`[data-ov-list="attention"] [data-atrisk]`)
    eq(await row.count(), 1, 'At-risk rows')
    eq(await row.first().getAttribute('data-risk'), 'overdue', "the At-risk row's marker")
    expect(
      ((await row.first().textContent()) ?? '').includes(late.title),
      `the At-risk row is not ${late.key}`,
    )
    const pausedRows = root.locator('[data-ov-list="paused"] [data-ovrow]')
    eq(await pausedRows.count(), 1, 'Paused rows')
    expect(
      ((await pausedRows.first().textContent()) ?? '').includes(held.title),
      `the Paused row is not ${held.key}`,
    )
    // M's health table: the sub-project's row among M's sub-projects
    await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/overview/p/${M.num}`, {
      waitUntil: 'domcontentloaded',
    })
    const project = app.locator(
      '[data-workspace-view] [data-overview-root][data-overview-state="ok"]',
    )
    await project.waitFor({ timeout: 60_000 })
    const health = project.locator('[data-ov-health][data-ov-health-state="ok"]')
    await health.waitFor({ timeout: 60_000 })
    const healthRow = health.locator(`[data-ovcard="${sub.id}"]`)
    expect(
      await until(async () => (await healthRow.count()) === 1),
      `the health table holds no row for ${sub.name}`,
    )
    const cell = async (name) =>
      ((await healthRow.locator(`[data-ovcell="${name}"]`).first().textContent()) ?? '').trim()
    for (const [name, want] of Object.entries({
      ...OVERVIEW_HEALTH_EXPECTED,
      late: sub.track_delay ? '1' : '—',
    }))
      eq(await cell(name), want, `the health row's ${name}`)
    // the row's name opens the sub-project's Board
    await healthRow.locator('button').first().click()
    await app
      .locator('[data-workspace-view] [data-board-root][data-board-state="ok"]')
      .waitFor({ timeout: 60_000 })
    expect(
      await until(async () => app.url().includes(`/board/p/${sub.num}`)),
      `the health row did not open the Board of ${sub.name}`,
    )
    return `opened the Overview of ${sub.name} on the deployment's answers, with ${late.key} overdue and ${held.key} paused, and its row in ${M.key}'s health table, which opened its Board`
  })
}

/** The step that checks the Milestones window opened on a milestone, with
 *  its Upcoming and Past sections (milestoneWindowCheck). */
export const MILESTONE_STEP = 'ui/milestones'

/** The first week, from three weeks after the run's own on, that
 *  `milestones` (YYYY-MM-DD days) leaves free, in an organization whose
 *  weeks start on `weekStart`, so a milestone made there shows among the
 *  Overview's upcoming milestones. */
export function freeMilestoneWeek(milestones, today, weekStart) {
  const taken = new Set(milestones.map((day) => weekOf(day, weekStart)))
  let week = addDays(weekOf(today, weekStart), 21)
  while (taken.has(week)) week = addDays(week, 7)
  return week
}

/** The first week before the run's own that `milestones` (YYYY-MM-DD days)
 *  leaves free, going back from the week before last, in an organization
 *  whose weeks start on `weekStart`, so a milestone made there shows in the
 *  Milestones window's Past. `today` is the run's UTC day, while the
 *  browser places weeks by the runner's local day, which can still be in
 *  the week before the UTC one, so the UTC week before could be the
 *  browser's current week. */
export function freePastMilestoneWeek(milestones, today, weekStart) {
  const taken = new Set(milestones.map((day) => weekOf(day, weekStart)))
  let week = addDays(weekOf(today, weekStart), -14)
  while (taken.has(week)) week = addDays(week, -7)
  return week
}

/** The Milestones window on the deployment's answers (milestones.get and
 *  section): the run makes `<tag> Milestone` over REST on its project M in
 *  a week M leaves free after the run's own, and `<tag> Past milestone` in
 *  the first week M leaves free from the week before last back
 *  (freePastMilestoneWeek), then in the app M's Overview
 *  reaches its ok state, a press on the first milestone's row opens the
 *  window, which reads the milestone and shows its editor with its name in
 *  its place in Upcoming once that section's read answered, so the
 *  deployment's milestones.section answered. Past, collapsed, does not show
 *  the past milestone until it is expanded, then shows it, and no longer
 *  shows it once the run deleted it over REST. A rename of the first one
 *  saved with Save reaches GET /projects/M, and its Delete, pressed twice,
 *  leaves GET /projects/M without it. The milestones live on M, so the
 *  cleanup that deletes M removes any a failure left. It runs while M is
 *  active, after ui/settings-projects. */
async function milestoneWindowCheck() {
  const w = run.creds.writeToken
  const { M } = run.projects
  await check(MILESTONE_STEP, async () => {
    const me = await restOk(w, 'GET', '/me')
    const held = (await restOk(w, 'GET', `/projects/${M.id}`)).milestones ?? []
    const date = freeMilestoneWeek(
      held.map((m) => m.date),
      todayUtc(),
      me.organization.week_start,
    )
    const made = await restOk(w, 'POST', `/projects/${M.id}/milestones`, {
      name: `${run.tag} Milestone`,
      date,
    })
    const past = await restOk(w, 'POST', `/projects/${M.id}/milestones`, {
      name: `${run.tag} Past milestone`,
      date: freePastMilestoneWeek(
        held.map((m) => m.date),
        todayUtc(),
        me.organization.week_start,
      ),
    })
    const listed = async () => (await restOk(w, 'GET', `/projects/${M.id}`)).milestones ?? []
    await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/overview/p/${M.num}`, {
      waitUntil: 'domcontentloaded',
    })
    await app
      .locator('[data-workspace-view] [data-overview-root][data-overview-state="ok"]')
      .waitFor({ timeout: 60_000 })
    const row = app.locator(`[data-workspace-view] [data-overview-milestone="${made.id}"]`)
    await row.waitFor({ timeout: 60_000 })
    await row.click()
    const window = app.locator('[data-modal-shell] [data-milestone-window]')
    await window.waitFor({ timeout: 10_000 })
    const upcoming = window.locator(
      '[data-milestone-section="upcoming"][data-milestone-section-state="ok"]',
    )
    await upcoming.waitFor({ timeout: 60_000 })
    const editor = upcoming.locator(`[data-milestone-editor="${made.id}"]`)
    await editor.waitFor({ timeout: 10_000 })
    const name = editor.locator('input[aria-label="Name"]')
    eq(await name.inputValue(), made.name, "the editor's name")
    // Past reads nothing until it is expanded, then shows the past one
    const pastRow = window.locator(
      `[data-milestone-section="past"] [data-milestone-row="${past.id}"]`,
    )
    const toggle = window.locator('[data-milestone-past-toggle]')
    await toggle.waitFor({ timeout: 10_000 })
    eq(await toggle.getAttribute('aria-expanded'), 'false', "Past's disclosure")
    eq(await pastRow.count(), 0, 'past milestones shown before Past was expanded')
    await toggle.click()
    await pastRow.waitFor({ timeout: 60_000 })
    // and drops it once it is deleted over REST
    await restOk(w, 'DELETE', `/projects/${M.id}/milestones/${past.id}`)
    await pastRow.waitFor({ state: 'detached', timeout: 60_000 })
    // rename it there
    const renamed = `${run.tag} Milestone renamed`
    await name.fill(renamed)
    await editor
      .locator('button')
      .filter({ hasText: /^Save$/ })
      .click()
    expect(
      await until(async () => (await listed()).some((m) => m.id === made.id && m.name === renamed)),
      `GET /projects/${M.key} does not name ${made.name} renamed`,
    )
    // and delete it there, a press to arm and, past the window that ignores
    // a second press, one on Confirm delete
    const opened = window.locator(`[data-milestone-row="${made.id}"]`)
    await opened.waitFor({ timeout: 10_000 })
    await opened.locator('button[aria-label^="Edit"]').click()
    await editor.waitFor({ timeout: 10_000 })
    await confirmTwice(
      editor.locator('button').filter({ hasText: /^Delete$/ }),
      editor.locator('button').filter({ hasText: /^Confirm delete$/ }),
    )
    expect(
      await until(async () => !(await listed()).some((m) => m.id === made.id)),
      `GET /projects/${M.key} still lists ${renamed}`,
    )
    await app
      .locator('[data-modal-shell] button')
      .filter({ hasText: /^Done$/ })
      .click()
    return `opened ${made.name} from ${M.key}'s Overview in its place in Upcoming on the deployment's answers, showed ${past.name} in Past once expanded and dropped it once deleted over REST, renamed ${made.name} and deleted it in its window`
  })
}

/** The step that checks Settings › Labels (settingsLabelsCheck). */
export const LABELS_STEP = 'ui/settings-labels'

/** What Settings › Labels shows for the run's label on its one fixture
 *  task (settingsLabelsCheck): its count of active tasks, and the sentence
 *  of its delete window. */
export const LABELS_EXPECTED = {
  count: '1 active task',
  confirm:
    'Used by 1 active task. Deleting this label removes it from all tasks, including archived tasks. This cannot be undone.',
}

/** Settings › Labels on the deployment's live batches (labels.settingsPage):
 *  the run makes `<tag> Label` over REST and puts it on its fixture task
 *  Alpha, then in the app the page reaches its ok state, a search for the
 *  label lists it alone, from the deployment's answer rather than kept in
 *  the page, with LABELS_EXPECTED.count, a rename in place with Enter
 *  reaches GET /labels, and its delete window says LABELS_EXPECTED.confirm
 *  and deletes it, which GET /labels then no longer lists. A count reads
 *  Counting… only while a label count backfill runs on the deployment, and
 *  the step then fails with that reason. The sweep finds a label a failure
 *  left by its tag. It runs while the run's tasks are active, after
 *  ui/overview. */
async function settingsLabelsCheck() {
  const w = run.creds.writeToken
  await check(LABELS_STEP, async () => {
    const label = await restOk(w, 'POST', '/labels', {
      name: `${run.tag} Label`,
      color: '#2563EB',
    })
    await restOk(w, 'PATCH', `/tasks/${run.t0.key}`, { add_labels: [label.id] })
    await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/settings/org-labels`, {
      waitUntil: 'domcontentloaded',
    })
    await app.locator('[data-org-labels][data-labels-state="ok"]').waitFor({ timeout: 60_000 })
    await app.locator('[data-labels-search]').fill(label.name)
    const rows = app.locator('[data-org-labels] [data-label-row]')
    const row = app.locator(`[data-org-labels] [data-label-row="${label.id}"]`)
    expect(
      await until(async () => (await rows.count()) === 1 && (await row.count()) === 1),
      `a search for ${label.name} does not list it alone`,
    )
    eq(await row.locator('[data-label-kept]').count(), 0, 'kept rows')
    const count = async () =>
      ((await row.locator('[data-label-count]').first().textContent()) ?? '').trim()
    expect(
      (await count()) !== 'Counting…',
      'the counts read Counting…, so a label count backfill runs on this deployment',
    )
    expect(
      await until(async () => (await count()) === LABELS_EXPECTED.count),
      `its count reads ${short(await count())}, not ${LABELS_EXPECTED.count}`,
    )
    const renamed = `${run.tag} Label renamed`
    const name = row.locator('[data-label-name]')
    await name.fill(renamed)
    await name.press('Enter')
    expect(
      await until(async () =>
        (await restRows(w, '/labels', 'labels', { search: run.tag })).some(
          (l) => l.id === label.id && l.name === renamed,
        ),
      ),
      'GET /labels does not name it renamed',
    )
    await row.locator('[data-delete-label]').click()
    const window = app.locator('[data-modal-shell]')
    await window.waitFor({ timeout: 10_000 })
    eq(
      ((await window.locator('[data-label-delete-sentence]').textContent()) ?? '').trim(),
      LABELS_EXPECTED.confirm,
      'the delete window',
    )
    await window
      .locator('button')
      .filter({ hasText: /^Delete$/ })
      .click()
    expect(await until(async () => (await row.count()) === 0), 'its row did not go')
    expect(
      await until(
        async () =>
          !(await restRows(w, '/labels', 'labels', { search: run.tag })).some(
            (l) => l.id === label.id,
          ),
      ),
      'GET /labels still lists it',
    )
    return `found ${label.name} by search with ${LABELS_EXPECTED.count}, renamed it in place and deleted it in its window`
  })
}

/** The step that checks Settings › Teams and a team's page
 *  (settingsTeamsCheck). */
export const TEAMS_STEP = 'ui/settings-teams'

/** What Settings › Teams and the run's team page say of its members
 *  (settingsTeamsCheck): none, and the Standard agent alone. */
export const TEAMS_EXPECTED = { none: '0 members', one: '1 member' }

/** Settings › Teams and a team's page on the deployment's reads
 *  (teams.settingsPage, get, members and addable): the run makes
 *  `<tag> Settings team` over REST, a team with no shares, so no removal
 *  window opens. In the app Settings › Teams reaches its ok state, and a
 *  search for the team's full name lists its row with TEAMS_EXPECTED.none,
 *  from the deployment's answer rather than kept in the page; `<tag> team`
 *  is listed too while it lives, so the step looks for its own row. On the
 *  team's page Add member's search finds the Standard agent and Add adds
 *  them, which GET /teams/{id} then counts and its members page holds, and
 *  the page's count line and the list's row read TEAMS_EXPECTED.one. It
 *  renames the team in place, which GET /teams/{id} names, removes the
 *  agent with two presses and no window, which leaves a count of 0, and
 *  deletes the team from the list with two presses, after which GET
 *  /teams/{id} answers 404. The sweep finds a team a failure left by its
 *  tag. It runs after ui/settings-labels, and needs a backend from the
 *  release whose app reads the team pages from the server or later.
 *  Against an older one Settings › Teams cannot load, and the step fails
 *  waiting for its ok state. */
async function settingsTeamsCheck() {
  const w = run.creds.writeToken
  const std = run.agents.std
  await check(TEAMS_STEP, async () => {
    const team = await restOk(w, 'POST', '/teams', { name: `${run.tag} Settings team` })
    const text = async (locator) => ((await locator.first().textContent()) ?? '').trim()
    const summary = () => restOk(w, 'GET', `/teams/${team.id}`)
    /** Settings › Teams searched for `name`, and the run's team's row. */
    const listed = async (name) => {
      await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/settings/org-teams`, {
        waitUntil: 'domcontentloaded',
      })
      await app.locator('[data-org-teams][data-teams-state="ok"]').waitFor({ timeout: 60_000 })
      await app.locator('[data-teams-search]').fill(name)
      const row = app.locator(`[data-org-teams] [data-team-row="${team.id}"]`)
      expect(
        await until(async () => (await row.count()) === 1),
        `a search for ${name} does not list it`,
      )
      eq(await row.locator('[data-team-kept]').count(), 0, 'kept rows')
      return row
    }
    /** The run's team's page, opened from its row in the list. */
    const opened = async (row) => {
      await row.locator('[data-team-open]').click()
      await app.locator('[data-team-settings-state="ok"]').waitFor({ timeout: 60_000 })
      await app
        .locator('[data-team-members][data-team-members-state="ok"]')
        .waitFor({ timeout: 60_000 })
    }
    let row = await listed(team.name)
    expect(
      await until(
        async () => (await text(row.locator('[data-team-count]'))) === TEAMS_EXPECTED.none,
      ),
      `its count reads ${short(await text(row.locator('[data-team-count]')))}, not ${TEAMS_EXPECTED.none}`,
    )
    await opened(row)
    await app.locator('[data-team-member-picker]').click()
    await app.locator('[data-team-member-picker-search]').fill(std.name)
    const choice = app.locator(`[data-team-member-choice="${std.id}"]`)
    await choice.waitFor({ timeout: 30_000 })
    await choice.click()
    await app.locator('[data-team-member-add]').click()
    expect(
      await until(async () => (await summary()).member_count === 1),
      'GET /v1/teams/{id} does not count the agent',
    )
    expect(
      (await restRows(w, `/teams/${team.id}/members`, 'members')).some((m) => m.id === std.id),
      'its members page does not hold the agent',
    )
    const line = app.locator('[data-team-member-count]')
    expect(
      await until(async () => (await text(line)) === TEAMS_EXPECTED.one),
      `its page's count reads ${short(await text(line))}, not ${TEAMS_EXPECTED.one}`,
    )
    row = await listed(team.name)
    expect(
      await until(
        async () => (await text(row.locator('[data-team-count]'))) === TEAMS_EXPECTED.one,
      ),
      `its row's count reads ${short(await text(row.locator('[data-team-count]')))}, not ${TEAMS_EXPECTED.one}`,
    )
    await opened(row)
    const renamed = `${run.tag} Settings team renamed`
    const name = app.locator('input[aria-label="Team name"]')
    await name.fill(renamed)
    await name.press('Enter')
    expect(
      await until(async () => (await summary()).name === renamed),
      'GET /v1/teams/{id} does not name it renamed',
    )
    const member = app.locator(`[data-settings-team-member="${std.id}"]`)
    await confirmTwice(
      member.locator('[data-team-member-remove]'),
      member.locator('[data-team-member-remove][aria-label="Click again to confirm"]'),
    )
    expect(
      await until(async () => (await summary()).member_count === 0),
      'GET /v1/teams/{id} still counts the agent',
    )
    eq(await app.locator('[data-access-removal]').count(), 0, 'removal windows')
    row = await listed(renamed)
    await confirmTwice(
      row.locator('[data-team-delete]'),
      row.locator('[data-team-delete][aria-label="Click again to delete this team"]'),
    )
    expect(
      await until(async () => (await rest(w, 'GET', `/teams/${team.id}`)).status === 404),
      'GET /v1/teams/{id} still answers the team',
    )
    return `found ${team.name} by search with ${TEAMS_EXPECTED.none}, added ${std.name} through Add member to ${TEAMS_EXPECTED.one}, renamed it, removed the agent and deleted it from the list`
  })
}

/** The step that checks the removal window (removalWindowCheck). */
export const REMOVAL_STEP = 'ui/removal-window'

/** What the removal window shows and presses (removalWindowCheck): the
 *  submit button once Reassign is chosen, and the picker button's name for
 *  the person the run chooses. */
export const REMOVAL_EXPECTED = {
  submit: 'Reassign and remove',
  chosen: (name) => `New assignee: ${name}`,
}

/** The removal window on the deployment's answers (accessRemovals.preview
 *  and reassignChoices): the run makes `<tag> Removal` under its second
 *  project N over REST, gives the Standard agent a User grant there and a
 *  To Do task, then in the app presses the agent's Remove in that
 *  sub-project's access editor. The window must list the task's key and
 *  title from the preview; the step chooses Reassign, searches the picker
 *  for Nora's name, chooses her and presses REMOVAL_EXPECTED.submit, which
 *  must close the window. Over REST the task must then be Nora's and the
 *  sub-project must hold no grant for the agent. Not under M, where the
 *  agent's Viewer grant keeps its sight of every sub-project, so the
 *  removal would take no task out of sight and open no window. Without an
 *  N it makes a tagged top-level project of its own (run.projects.R), which
 *  the cleanup deletes and the sweep finds by its tag. The task goes to
 *  run.created. It runs while the run's projects are active, after
 *  ui/settings-teams, and needs a backend from the release of the
 *  removal window or later. Against an older one the press cannot read
 *  the preview, so the window never opens and the step fails waiting for
 *  it. */
async function removalWindowCheck() {
  const w = run.creds.writeToken
  const std = run.agents.std
  await check(REMOVAL_STEP, async () => {
    let parent = run.projects.N
    if (!parent) {
      parent = await restOk(w, 'POST', '/projects', { name: `${run.tag} removal project` })
      run.projects.R = parent
    }
    const sub = await restOk(w, 'POST', '/projects', {
      name: `${run.tag} Removal`,
      parent: parent.id,
    })
    await restOk(w, 'PUT', `/projects/${sub.id}/access/users/${std.id}`, { level: 'user' })
    const t = await restOk(w, 'POST', '/tasks', {
      project: sub.id,
      title: `${run.tag} removal window`,
      status: 'todo',
      assignee_id: std.id,
    })
    run.created.push(t)
    eq(t.assignee_id, std.id, "the task's assignee")
    await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/settings/project/${sub.num}`, {
      waitUntil: 'domcontentloaded',
    })
    const remove = app.locator(
      `[data-project-access-user="${std.id}"] [data-project-access-remove]`,
    )
    await remove.waitFor({ timeout: 60_000 })
    await remove.click()
    const dialog = app.locator('[data-modal-shell] [data-access-removal]')
    await dialog.waitFor({ timeout: 60_000 })
    const row = dialog.locator(`[data-access-removal-task="${t.id}"]`)
    expect(await until(async () => (await row.count()) === 1), `the window does not list ${t.key}`)
    const listed = ((await row.textContent()) ?? '').trim()
    expect(listed.includes(t.key) && listed.includes(t.title), `the row reads ${short(listed)}`)
    await dialog.locator('[data-access-removal-reassign] input[type="radio"]').check()
    const picker = dialog.locator('[data-reassign-to]')
    await picker.click()
    await app.locator('[data-reassign-search]').fill(run.nora.name)
    const nora = app.locator(`[data-reassign-choice="${run.nora.id}"]`)
    await nora.waitFor({ timeout: 30_000 })
    await nora.click()
    expect(
      await until(
        async () =>
          (await picker.getAttribute('aria-label')) === REMOVAL_EXPECTED.chosen(run.nora.name),
      ),
      `the picker does not name ${run.nora.name}`,
    )
    await app
      .locator('[data-modal-shell] button')
      .filter({ hasText: new RegExp(`^${REMOVAL_EXPECTED.submit}$`) })
      .click()
    expect(
      await until(async () => (await dialog.count()) === 0, 30_000),
      'the window did not close',
    )
    expect(
      await until(
        async () => (await restOk(w, 'GET', `/tasks/${t.key}`)).assignee_id === run.nora.id,
      ),
      `${t.key} is not ${run.nora.name}'s`,
    )
    const grants = (await restOk(w, 'GET', `/projects/${sub.id}`)).grants.users.map((g) => g.id)
    expect(!grants.includes(std.id), `${sub.name} still holds a grant for the agent`)
    return `removed the agent's grant on ${sub.name} in the window from the preview, which listed ${t.key}, and handed it to ${run.nora.name} through the picker`
  })
}

/** Chooses project `id` in the shared project picker that `trigger`
 *  opens, found by searching `name` (src/components/ProjectPicker.tsx). A
 *  picker of one project (`many` false, Search in) closes on the pick; one
 *  of several stays open, so Escape, in its emptied field, closes it. A
 *  picker of several that holds the project already, as Archived tasks
 *  does when it opens on the project of the scope behind Settings, keeps
 *  it, since a press would take it off. */
async function pickProject(trigger, name, id, many = true) {
  await settledPicker(trigger)
  await trigger.click()
  const field = app.locator('[data-project-picker-search]')
  await field.waitFor({ timeout: 30_000 })
  await field.fill(name)
  const row = app.locator(`[data-project-pick="${id}"]`)
  await row.waitFor({ timeout: 30_000 })
  if (!many || (await row.getAttribute('aria-checked')) !== 'true') await row.click()
  if (many) {
    await field.fill('')
    await field.press('Escape')
  }
  await field.waitFor({ state: 'detached', timeout: 10_000 })
}

/** Waits until the project picker `trigger` names its pick rather than
 *  Loading…, which it reads while the page it is on resolves the project
 *  it opened on, so a row's checked state read after it is the page's
 *  own. */
async function settledPicker(trigger) {
  expect(
    await until(async () => (await trigger.getAttribute(PICKER_EXPECTED.busy)) === null, 30_000),
    'the project picker still reads Loading…',
  )
}

/** The step that checks a project's Settings page (projectSettingsCheck). */
export const PROJECT_SETTINGS_STEP = 'ui/project-settings'

/** What the project's Settings page saves (projectSettingsCheck): the
 *  team's level after its role select, Nora's grant through the picker and
 *  the Review time typed. */
export const PROJECT_SETTINGS_EXPECTED = { team: 'viewer', nora: 'user', reviewHours: 3 }

/** A project's Settings page on the deployment's reads
 *  (projectSettings.get, users, teams and candidates): the run makes
 *  `<tag> Settings` under its second project N over REST (or the removal
 *  step's R), led by the Standard agent, whose user role may lead, and
 *  shares it with the run's team at User. In the app it opens the
 *  sub-project's Settings page, waits for the team's row from the server's
 *  list and sets its role to Viewer, opens the Add team or user picker,
 *  searches it for Nora's name, picks her, an organization admin who is
 *  not the lead, chooses User and presses + Add, waits for her row, and
 *  types 3 into Review time and leaves it. Over REST the share must then be
 *  Viewer, Nora's grant User and the review time 3, so the writes went out
 *  with `expected` values the deployment accepted. The sub-project goes
 *  with its parent in the cleanup, and the sweep finds it by its tag. It
 *  needs the run's team, and a backend from v0.1.102 on, which answers the
 *  reads. */
async function projectSettingsCheck() {
  const w = run.creds.writeToken
  const std = run.agents.std
  await check(PROJECT_SETTINGS_STEP, async () => {
    const team = run.team
    expect(team, 'the run has no team to share the sub-project with')
    let parent = run.projects.N ?? run.projects.R
    if (!parent) {
      parent = await restOk(w, 'POST', '/projects', { name: `${run.tag} settings project` })
      run.projects.R = parent
    }
    const sub = await restOk(w, 'POST', '/projects', {
      name: `${run.tag} Settings`,
      parent: parent.id,
      lead_id: std.id,
    })
    eq(sub.lead_id, std.id, "the sub-project's lead")
    await restOk(w, 'PUT', `/projects/${sub.id}/access/teams/${team.id}`, { level: 'user' })
    await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/settings/project/${sub.num}`, {
      waitUntil: 'domcontentloaded',
    })
    // the team's level, from the server's list
    const teamRole = app.locator(`[data-project-team-role="${team.id}"]`)
    await teamRole.waitFor({ timeout: 60_000 })
    await teamRole.selectOption(PROJECT_SETTINGS_EXPECTED.team)
    expect(
      await until(
        async () =>
          !(await teamRole.isDisabled()) &&
          (await teamRole.inputValue()) === PROJECT_SETTINGS_EXPECTED.team,
        30_000,
      ),
      "the team's level did not settle on Viewer",
    )
    // Nora, offered by the server's picker although she is an admin
    await app.locator('[data-project-access-picker]').click()
    await app.locator('[data-project-access-picker-search]').fill(run.nora.name)
    const choice = app.locator(`[data-project-access-choice="${run.nora.id}"]`)
    await choice.waitFor({ timeout: 30_000 })
    await choice.click()
    await app.locator('[data-project-access-new-role]').selectOption(PROJECT_SETTINGS_EXPECTED.nora)
    await app.locator('[data-add-project-user]').click()
    await app
      .locator(
        `[data-project-access-user="${run.nora.id}"], [data-project-access-kept="${run.nora.id}"]`,
      )
      .first()
      .waitFor({ timeout: 30_000 })
    // Review time, saved on leaving the field
    const review = app.locator('[data-project-review-hours]')
    await review.fill(String(PROJECT_SETTINGS_EXPECTED.reviewHours))
    await review.press('Enter')
    const saved = async () => {
      const p = await restOk(w, 'GET', `/projects/${sub.id}`)
      return {
        team: p.grants.teams.find((g) => g.id === team.id)?.level,
        nora: p.grants.users.find((g) => g.id === run.nora.id)?.level,
        reviewHours: p.review_hours,
      }
    }
    let last = null
    expect(
      await until(async () => {
        last = await saved()
        return (
          last.team === PROJECT_SETTINGS_EXPECTED.team &&
          last.nora === PROJECT_SETTINGS_EXPECTED.nora &&
          last.reviewHours === PROJECT_SETTINGS_EXPECTED.reviewHours
        )
      }, 30_000),
      `${sub.name} holds ${JSON.stringify(last)}`,
    )
    return `on ${sub.name}'s Settings page set ${team.name} to Viewer, added ${run.nora.name} as User through the picker's search and set Review time to 3, each saved`
  })
}

/** The step that checks the New project and New sub-project dialogs
 *  (projectDialogsCheck). */
export const PROJECT_DIALOGS_STEP = 'ui/project-dialogs'

/** What the New project dialog's pickers save (projectDialogsCheck): the
 *  team's share and Nora's grant. The Standard agent leads both projects. */
export const PROJECT_DIALOGS_EXPECTED = { team: 'viewer', nora: 'user' }

/** The New project and New sub-project dialogs on the deployment's reads
 *  (projectSettings.leadCandidates, candidates without a project, get and
 *  projects with sub_project_parents) and its create, which the app sends
 *  without a sort_order. In the app as Nora it opens New project from the
 *  sidebar's header, names it `<tag> Dialogs`, picks the Standard agent as
 *  lead through the Lead popover's search, and in Project access checks the
 *  run's team, found by search, as Viewer and Nora, an organization admin
 *  the server offers since she is not the lead, as User, then presses
 *  Create project. Over REST the project's lead must be the agent, the
 *  team's share Viewer and Nora's grant User. Then it opens New
 *  sub-project from the sidebar menu of the run's project M, waits for
 *  M's parent check, names it `<tag> Dialogs sub`, picks the new project
 *  from the Project popover's search of the run's tag, waits until the
 *  Project button names it after its check, picks the agent as lead,
 *  clears Create a starter task and presses Create sub-project. Over REST
 *  the sub-project's parent must be the new project, not M, and its lead
 *  the agent.
 *  The project goes in the cleanup with its sub-project, and the sweep
 *  finds both by their tag. It needs the run's team, and a backend from the
 *  release after v0.1.140 on, which takes a create without a sort_order. */
async function projectDialogsCheck() {
  const w = run.creds.writeToken
  const std = run.agents.std
  const team = run.team
  await check(PROJECT_DIALOGS_STEP, async () => {
    expect(team, 'the run has no team to share the project with')
    const name = `${run.tag} Dialogs`
    const subName = `${run.tag} Dialogs sub`
    await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}`, { waitUntil: 'domcontentloaded' })
    await app.locator('aside button[aria-label="New project"]').click({ timeout: 60_000 })
    const dialog = app.getByRole('dialog', { name: 'New project', exact: true })
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name)
    // the lead, from the server's people
    await dialog.locator('[data-project-lead-picker]').click()
    await app.locator('[data-lead-picker-search]').fill(std.name)
    await app.locator(`[data-lead-choice="${std.id}"]`).click({ timeout: 30_000 })
    // Project access, from the server's teams and people
    await dialog.locator('[data-new-project-access]').click()
    const search = app.locator('[data-project-access-search]')
    await search.fill(team.name)
    await app.locator(`[data-project-access-team-option="${team.id}"]`).click({ timeout: 30_000 })
    await app
      .locator(`[data-project-team-role="${team.id}"]`)
      .selectOption(PROJECT_DIALOGS_EXPECTED.team)
    await search.fill(run.nora.name)
    await app
      .locator(`[data-project-access-user-option="${run.nora.id}"]`)
      .click({ timeout: 30_000 })
    await app
      .locator(`[data-project-role="${run.nora.id}"]`)
      .selectOption(PROJECT_DIALOGS_EXPECTED.nora)
    // Escape clears the search, then closes the popover alone
    await search.press('Escape')
    await search.press('Escape')
    await app.locator('[data-new-project-access-popup]').waitFor({ state: 'detached' })
    await dialog.getByRole('button', { name: 'Create project', exact: true }).click()
    await dialog.waitFor({ state: 'detached', timeout: 30_000 })
    let project = null
    expect(
      await until(async () => {
        project = (await readList(w, '/projects')).find((p) => p.name === name) ?? null
        return project !== null
      }, 30_000),
      `${name} was not created`,
    )
    run.projects.D = project
    const made = await restOk(w, 'GET', `/projects/${project.id}`)
    eq(made.lead_id, std.id, "the project's lead")
    eq(
      made.grants.teams.find((g) => g.id === team.id)?.level,
      PROJECT_DIALOGS_EXPECTED.team,
      "the team's share",
    )
    eq(
      made.grants.users.find((g) => g.id === run.nora.id)?.level,
      PROJECT_DIALOGS_EXPECTED.nora,
      "Nora's grant",
    )
    // New sub-project from the sidebar menu of the run's project M, so the
    // dialog starts on M and only a pick from the list can make it D
    const { M } = run.projects
    const row = app.locator(`aside [data-project-row="${M.id}"]`)
    await row.waitFor({ timeout: 30_000 })
    await row.hover()
    await row.getByRole('button', { name: 'Project actions', exact: true }).click()
    await app.getByRole('button', { name: 'New sub-project…', exact: true }).click()
    const sub = app.getByRole('dialog', { name: 'New sub-project', exact: true })
    const opened = sub.locator(`[data-new-subproject-parent="${M.id}"]`)
    // M's parent check
    await opened.waitFor({ timeout: 30_000 })
    await sub.getByRole('textbox', { name: 'Name', exact: true }).fill(subName)
    // D from the server's sub_project_parents list, then D's check
    await opened.click()
    await app.locator('[data-new-subproject-parent-search]').fill(run.tag)
    await app
      .locator(`[data-new-subproject-parent-choice="${project.id}"]`)
      .click({ timeout: 30_000 })
    await sub.locator(`[data-new-subproject-parent="${project.id}"]`).waitFor({ timeout: 30_000 })
    await sub.locator('[data-project-lead-picker]').click()
    await app.locator('[data-lead-picker-search]').fill(std.name)
    await app.locator(`[data-lead-choice="${std.id}"]`).click({ timeout: 30_000 })
    await sub.locator('#subproject-starter').uncheck()
    const create = sub.getByRole('button', { name: 'Create sub-project', exact: true })
    expect(
      await until(async () => await create.isEnabled(), 30_000),
      'Create sub-project stays off',
    )
    await create.click()
    await sub.waitFor({ state: 'detached', timeout: 30_000 })
    let child = null
    expect(
      await until(async () => {
        child = (await readList(w, '/projects')).find((p) => p.name === subName) ?? null
        return child !== null
      }, 30_000),
      `${subName} was not created`,
    )
    const madeSub = await restOk(w, 'GET', `/projects/${child.id}`)
    eq(madeSub.parent_id, project.id, "the sub-project's parent")
    eq(madeSub.lead_id, std.id, "the sub-project's lead")
    return `created ${name} led by ${std.name}, shared with ${team.name} as Viewer and ${run.nora.name} as User, and ${subName} under it led by ${std.name}, each from the server's pickers`
  })
}

/** The step that checks Billing's storage figures (billingStorageCheck). */
export const BILLING_STORAGE_STEP = 'ui/billing-storage'

/** What Billing shows for the run's sub-project and its one file
 *  (billingStorageCheck): the file's size, the row's bytes and file count
 *  in Storage by project, and the sentence current storage shows while the
 *  deployment's stored-byte totals are counted, which the step must not
 *  see. */
export const BILLING_STORAGE_EXPECTED = {
  bytes: 2048,
  row: '2.0 KB · 1 file',
  counting: 'Being counted. Check again later.',
}

/** Checks Billing's storage figures on the deployment's answers
 *  (billing.usageFigures and billing.storageProjects). The run makes
 *  `<tag> Billing storage` under its project M over REST, a sub-project no
 *  other step uploads to, with one task, and uploads one file of
 *  BILLING_STORAGE_EXPECTED.bytes to it over REST. In the app, as Nora, an
 *  admin, Billing's current storage must show a figure, never
 *  BILLING_STORAGE_EXPECTED.counting, and Storage by project, searched for
 *  the run tag and "storage", must list that sub-project alone, its size
 *  and file count reading exactly BILLING_STORAGE_EXPECTED.row. That shows
 *  the deployment's totals are counted and that the page reads them. The
 *  file is deleted over REST at the end, also after a failure, and the
 *  cleanup, which deletes M, takes the sub-project and its task. It runs
 *  while the run's projects are active, after ui/removal-window, and needs
 *  a backend from the release that ships billing.usageFigures and
 *  billing.details. Against an older one the page cannot read its details
 *  or its usage and the step fails waiting for them. */
async function billingStorageCheck() {
  const w = run.creds.writeToken
  const { M } = run.projects
  await check(BILLING_STORAGE_STEP, async () => {
    const sub = await restOk(w, 'POST', '/projects', {
      name: `${run.tag} Billing storage`,
      parent: M.id,
    })
    expect(Number.isInteger(sub.num), 'the sub-project has no number')
    const t = await restOk(w, 'POST', '/tasks', {
      project: sub.id,
      title: `${run.tag} billing storage`,
      status: 'todo',
    })
    run.created.push(t)
    const bytes = randomBytes(BILLING_STORAGE_EXPECTED.bytes)
    const type = 'application/octet-stream'
    const start = await restOk(w, 'POST', `/tasks/${t.key}/attachments`, {
      name: `${run.tag} storage.bin`,
      content_type: type,
      size: bytes.length,
    })
    const storage_id = await putBytes(start.upload_url, bytes, type)
    const att = await restOk(w, 'POST', `/tasks/${t.key}/attachments/${start.ticket}`, {
      storage_id,
    })
    let current = ''
    try {
      await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/settings/org-billing`, {
        waitUntil: 'domcontentloaded',
      })
      const figure = app.locator('[data-billing-usage] [data-billing-storage-bytes]')
      await figure.waitFor({ timeout: 60_000 })
      current = ((await figure.textContent()) ?? '').trim()
      expect(
        current !== BILLING_STORAGE_EXPECTED.counting,
        "current storage reads Being counted, so the deployment's stored-byte totals are not complete",
      )
      expect(/^[0-9]/.test(current), `current storage reads ${short(current)}`)
      await app.locator('[data-billing-storage-search]').fill(`${run.tag} storage`)
      const rows = app.locator('[data-billing-storage] [data-billing-storage-row]')
      const row = app.locator(`[data-billing-storage-row="${sub.id}:${sub.num}"]`)
      expect(
        await until(async () => (await rows.count()) === 1 && (await row.count()) === 1),
        `a search for the run tag does not list ${sub.name} alone`,
      )
      const text = ((await row.textContent()) ?? '').trim()
      expect(text.includes(sub.name), `its row reads ${short(text)}, without ${sub.name}`)
      const size = ((await row.locator('[data-billing-storage-size]').textContent()) ?? '').trim()
      eq(size, BILLING_STORAGE_EXPECTED.row, 'its size and file count')
    } finally {
      eq(
        (await restOk(w, 'DELETE', `/tasks/${t.key}/attachments/${att.id}`)).deleted,
        true,
        'the file deleted',
      )
    }
    return `found ${sub.name} by its run tag with ${BILLING_STORAGE_EXPECTED.row} in Storage by project, current storage ${current}, and deleted the file`
  })
}

/** The step that checks Billing's API calls by account and its names
 *  (billingAccountsCheck). */
export const BILLING_ACCOUNTS_STEP = 'ui/billing-accounts'

/** The marks the step reads on Billing (src/panels/BillingUsage.tsx,
 *  BillingApiAccounts.tsx and BillingAccountNames.tsx) and on API access
 *  (src/panels/settings/ApiAccessSettings.tsx). */
export const BILLING_ACCOUNTS_MARKS = {
  calls: 'data-billing-calls',
  period: 'data-billing-period',
  search: 'data-billing-accounts-search',
  row: 'data-billing-account',
  rowCalls: 'data-billing-account-calls',
  view: 'data-billing-view-credentials',
  namesToggle: 'data-billing-names-toggle',
  namesSearch: 'data-billing-names-search',
  billable: 'data-billable-account',
  person: 'data-api-access-person',
  accessPeriod: 'data-api-access-period',
}

/** Checks Billing's API calls by account and its names on the
 *  deployment's answers (billing.usageFigures, billing.apiAccounts and
 *  billing.accountList). It first makes one GET /v1/me with each of the
 *  run's agent keys still in use, the Standard agent's named key and the
 *  Viewer agent's, so both have calls in the bucket Billing shows now,
 *  whatever the clock did earlier in the run; those calls write only
 *  usage. In the app, as Nora, an admin, Billing's API calls must show a
 *  figure, never Being counted, which says the deployment's aggregates are
 *  complete, and API calls by account, searched for the run tag, must list
 *  the two agents alone, each with at least one call. The Standard agent's
 *  View credentials must open API access with that agent chosen and the
 *  period Billing showed. Back on Billing, Who counts toward your bill,
 *  searched for the run tag, must list both agents. It writes nothing
 *  else, and needs a backend from the release that ships
 *  billing.apiAccounts and billing.accountList; against an older one the
 *  page cannot read its details and the step fails waiting for them. */
async function billingAccountsCheck() {
  const c = run.creds
  const m = BILLING_ACCOUNTS_MARKS
  await check(BILLING_ACCOUNTS_STEP, async () => {
    for (const cred of [c.stdKey, c.viewerKey]) await restOk(cred, 'GET', '/me')
    const { std, viewer } = run.agents
    const billing = `${cfg.appOrigin}/app/${ORG_SLUG}/settings/org-billing`
    await app.goto(billing, { waitUntil: 'domcontentloaded' })
    const figure = app.locator(`[data-billing-usage] [${m.calls}]`)
    await figure.waitFor({ timeout: 60_000 })
    const calls = ((await figure.textContent()) ?? '').trim()
    expect(
      calls !== BILLING_STORAGE_EXPECTED.counting,
      "API calls read Being counted, so the deployment's usage aggregates are not complete",
    )
    expect(/^[0-9]/.test(calls), `API calls read ${short(calls)}`)
    const period = await app.locator(`[${m.period}]`).getAttribute(m.period)
    expect(period, 'Billing names no period')
    await app.locator(`[${m.search}]`).fill(run.tag)
    const rows = app.locator(`[data-billing-accounts] [${m.row}]`)
    const rowOf = (agent) => app.locator(`[${m.row}="${agent.id}"]`)
    expect(
      await until(
        async () =>
          (await rows.count()) === 2 &&
          (await rowOf(std).count()) === 1 &&
          (await rowOf(viewer).count()) === 1,
        30_000,
      ),
      'a search for the run tag does not list the two agents alone in API calls by account',
    )
    for (const agent of [std, viewer]) {
      const text = ((await rowOf(agent).textContent()) ?? '').trim()
      expect(text.includes(agent.name), `its row reads ${short(text)}, without ${agent.name}`)
      const shown = ((await rowOf(agent).locator(`[${m.rowCalls}]`).textContent()) ?? '').trim()
      const n = Number(shown.replace(/[^0-9]/g, ''))
      expect(/^[0-9][0-9,.]* calls?$/.test(shown) && n >= 1, `${agent.name} shows ${short(shown)}`)
    }
    await app.locator(`[${m.view}="${std.id}"]`).click()
    const person = app.locator(`[${m.person}]`)
    expect(
      await until(async () => ((await person.textContent()) ?? '').trim() === std.name, 30_000),
      `API access does not open on ${std.name}`,
    )
    eq(await app.locator(`[${m.accessPeriod}]`).inputValue(), period, "API access's period")

    await app.goto(billing, { waitUntil: 'domcontentloaded' })
    await app.locator(`[${m.namesToggle}="billable"] summary`).click()
    await app.locator(`[${m.namesSearch}="billable"]`).fill(run.tag)
    const names = app.locator(`[data-billing-names-list="billable"] [${m.billable}]`)
    expect(
      await until(
        async () =>
          (await names.count()) === 2 &&
          (await app.locator(`[${m.billable}="${std.id}"]`).count()) === 1 &&
          (await app.locator(`[${m.billable}="${viewer.id}"]`).count()) === 1,
        30_000,
      ),
      'Who counts toward your bill, searched for the run tag, does not list the two agents',
    )
    return `API calls ${calls}; found ${std.name} and ${viewer.name} by the run tag in API calls by account and Who counts toward your bill, and View credentials opened API access on ${std.name} for ${period}`
  })
}

/** The step that checks Settings › Projects and Archived projects
 *  (settingsProjectsCheck). */
export const SETTINGS_PROJECTS_STEP = 'ui/settings-projects'

/** The marks the step waits for on Settings' project pages
 *  (src/panels/settings/ProjectLists.tsx). */
export const SETTINGS_PROJECTS_MARKS = {
  search: 'data-settings-projects-search',
  row: 'data-project-row',
  subList: 'data-subproject-list',
  subRow: 'data-subproject-row',
  archivedSearch: 'data-archived-projects-search',
  entry: 'data-archived-project',
  under: 'data-archived-under',
  toggle: 'data-archived-subs-toggle',
  chip: 'data-archived-sub',
  withParent: 'data-with-parent',
  restore: 'data-restore-project',
}

/** Settings › Projects and Archived projects on the deployment's lists
 *  (projectSettings.projects, subProjects, archived and
 *  archivedSubProjects): the run makes `<tag> Lists` over REST with two
 *  sub-projects, `<tag> Lists A` and `<tag> Lists B`. In the app as Nora it
 *  searches Settings › Projects for the run's tag, waits for the project's
 *  row, opens it and waits for both sub-projects' rows. Over REST it
 *  archives B alone and then the project, which carries A. In Archived
 *  projects it searches the tag, waits for the project's entry with A and B
 *  beneath it as search hits, shows its sub-projects and checks A solid
 *  (archived with it) and B dashed (archived on its own), and presses
 *  Restore. Over REST the project and A must then be live and B archived,
 *  and in the app B an entry of its own under a live project. The project
 *  goes in the cleanup with its sub-projects, and the sweep finds it by its
 *  tag. It needs a backend that answers the four lists. */
async function settingsProjectsCheck() {
  const w = run.creds.writeToken
  const m = SETTINGS_PROJECTS_MARKS
  await check(SETTINGS_PROJECTS_STEP, async () => {
    const lists = await restOk(w, 'POST', '/projects', { name: `${run.tag} Lists` })
    run.projects.L = lists
    const a = await restOk(w, 'POST', '/projects', {
      name: `${run.tag} Lists A`,
      parent: lists.id,
    })
    const b = await restOk(w, 'POST', '/projects', {
      name: `${run.tag} Lists B`,
      parent: lists.id,
    })
    // Settings › Projects: the project by its tag, and its sub-projects
    await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/settings/projects`, {
      waitUntil: 'domcontentloaded',
    })
    await app.locator(`[${m.search}]`).fill(run.tag)
    const row = app.locator(`[${m.row}="${lists.id}"]`)
    await row.waitFor({ timeout: 60_000 })
    await row.locator('button').first().click()
    for (const sub of [a, b])
      await app
        .locator(`[${m.subList}="${lists.id}"] [${m.subRow}="${sub.id}"]`)
        .waitFor({ timeout: 30_000 })
    // B alone, then the project, which carries A
    await restOk(w, 'PATCH', `/projects/${b.id}`, { archived: true })
    await restOk(w, 'PATCH', `/projects/${lists.id}`, { archived: true })
    // Archived projects: the entry, its search hits and its sub-projects
    await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/settings/projects-archived`, {
      waitUntil: 'domcontentloaded',
    })
    await app.locator(`[${m.archivedSearch}]`).fill(run.tag)
    const entry = app.locator(`[${m.entry}="${lists.id}"]:not([${m.under}])`)
    await entry.waitFor({ timeout: 60_000 })
    for (const sub of [a, b])
      await app.locator(`[${m.entry}="${sub.id}"][${m.under}]`).waitFor({ timeout: 30_000 })
    await entry.locator(`[${m.toggle}="${lists.id}"]`).click()
    const chip = (sub) => entry.locator(`[${m.chip}="${sub.id}"]`)
    await chip(a).waitFor({ timeout: 30_000 })
    await chip(b).waitFor({ timeout: 30_000 })
    eq(
      canonical([
        await chip(a).getAttribute(m.withParent),
        await chip(b).getAttribute(m.withParent),
      ]),
      canonical(['', null]),
      'A archived with the project and B on its own',
    )
    await entry.locator(`[${m.restore}="${lists.id}"]`).click()
    const archivedOf = async (p) => (await restOk(w, 'GET', `/projects/${p.id}`)).archived
    let last = null
    expect(
      await until(async () => {
        last = [await archivedOf(lists), await archivedOf(a), await archivedOf(b)]
        return last[0] === false && last[1] === false && last[2] === true
      }, 30_000),
      `the project, A and B are archived ${JSON.stringify(last)} after the restore`,
    )
    // B stays archived, now an entry of its own under a live project
    await app.locator(`[${m.entry}="${b.id}"]:not([${m.under}])`).waitFor({ timeout: 30_000 })
    return `found ${lists.name} and its sub-projects in Settings › Projects, archived B and then the project, and restored it from Archived projects, which brought back A and left B archived on its own`
  })
}

/** The Settings page Archived tasks opens with its search as the first
 *  control, focused, and the server search finds `target`, a task the run
 *  archived in its project (#143). Its key is the search, because a key
 *  matches no other task of the run's project. The project is chosen
 *  through the shared project picker, found by its name. */
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
    await pickProject(
      page.locator('[data-archive-project]'),
      run.projects.M.name,
      run.projects.M.id,
    )
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

/** The step that chooses projects through the shared project picker
 *  (projectPickerCheck). */
export const PICKER_STEP = 'ui/project-picker'

/** What the picker and the pages around it say and mark, which the step
 *  waits for (src/components/ProjectPicker.tsx,
 *  src/panels/settings/ArchivedTasks.tsx). */
export const PICKER_EXPECTED = {
  /** the separator between a sub-project's project and its own name */
  place: ' › ',
  /** a row's open button, by the task's id */
  open: 'data-archive-open',
  /** a chosen project's chip, by the project's id */
  chip: 'data-archive-pick',
  /** a top-level row's arrow, by the project's id */
  expand: 'data-project-expand',
  /** the trigger's mark while it reads Loading… */
  busy: 'data-project-picker-busy',
}

/** Archived tasks chooses through the shared project picker on the
 *  deployment's navigation reads, and opens a task over Settings; Search
 *  narrows through the same picker. `tasks` are the run's three archived
 *  tasks, 1 and 3 in Alpha and 2 in Zulu. It only reads, and must run
 *  before the run archives its project. */
async function projectPickerCheck(tasks) {
  await check(PICKER_STEP, async () => {
    const { M, A, Z } = run.projects
    const [one, two, three] = tasks
    await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/settings/projects-archived-tasks`, {
      waitUntil: 'domcontentloaded',
    })
    const page = app.locator('[data-archived-tasks]')
    await page.waitFor({ timeout: 45_000 })
    const listed = () =>
      page
        .locator('[data-archive-row]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-archive-row')).sort())
    const exactly = async (ids) =>
      until(async () => JSON.stringify(await listed()) === JSON.stringify([...ids].sort()))
    // Alpha and Zulu from projectNav.children, both chosen, once the page
    // resolved the project it may open on
    const trigger = page.locator('[data-archive-project]')
    await settledPicker(trigger)
    await trigger.click()
    const field = app.locator('[data-project-picker-search]')
    await field.fill(M.name)
    // the page opens on the project of the scope behind Settings, which
    // can be M; chosen whole, it includes Alpha and Zulu, so it comes off
    const whole = app.locator(`[data-project-pick="${M.id}"]`)
    await whole.waitFor({ timeout: 30_000 })
    if ((await whole.getAttribute('aria-checked')) === 'true') await whole.click()
    await app.locator(`[${PICKER_EXPECTED.expand}="${M.id}"]`).click()
    for (const p of [A, Z]) {
      const row = app.locator(`[data-project-pick="${p.id}"]`)
      await row.waitFor({ timeout: 30_000 })
      await row.click()
    }
    await field.fill('')
    await field.press('Escape')
    expect(
      await exactly([one.id, two.id, three.id]),
      'Alpha and Zulu do not list exactly 1, 2 and 3',
    )
    await page.locator(`[${PICKER_EXPECTED.chip}="${Z.id}"]`).click()
    expect(await exactly([one.id, three.id]), 'Alpha alone does not list exactly 1 and 3')
    // Zulu by its own name, with its project, from projectNav.search
    await trigger.click()
    await field.fill(Z.name)
    const zulu = app.locator(`[data-project-pick="${Z.id}"]`)
    await zulu.waitFor({ timeout: 30_000 })
    eq(
      ((await zulu.textContent()) ?? '').trim(),
      `${M.name}${PICKER_EXPECTED.place}${Z.name}`,
      'the search row of Zulu',
    )
    await field.press('Escape')
    await field.press('Escape')
    await field.waitFor({ state: 'detached', timeout: 10_000 })
    // a row opens its task over Settings, read-only with its text
    await page.locator(`[${PICKER_EXPECTED.open}="${three.id}"]`).click()
    const opened = app.locator('[role="dialog"][data-task-archived]')
    await opened.waitFor({ timeout: 30_000 })
    expect(
      await until(async () =>
        ((await opened.locator('[data-task-description]').textContent()) ?? '').includes(
          archivedNotes(),
        ),
      ),
      `the window of ${three.key} does not show its description`,
    )
    expect(
      app.url().endsWith('/settings/projects-archived-tasks'),
      `the address left Archived tasks: ${app.url()}`,
    )
    await opened.locator('[data-task-close]').click()
    await opened.waitFor({ state: 'detached', timeout: 10_000 })
    expect(await exactly([one.id, three.id]), 'the page lost its rows when the window closed')
    eq(await page.locator(`[${PICKER_EXPECTED.chip}="${A.id}"]`).count(), 1, "Alpha's chip")
    // Search narrowed to Zulu finds only the task archived there
    await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/board/all`, {
      waitUntil: 'domcontentloaded',
    })
    const search = app.locator('button[data-sidebar-search]')
    await search.waitFor({ timeout: 60_000 })
    await search.click()
    const palette = app.getByRole('dialog', { name: 'Search tasks and projects', exact: true })
    await pickProject(palette.locator('[data-palette-scope]'), Z.name, Z.id, false)
    eq(
      ((await palette.locator('[data-palette-scope]').textContent()) ?? '').trim(),
      `${M.name}${PICKER_EXPECTED.place}${Z.name}`,
      'Search in',
    )
    await palette.locator('[data-palette-archived]').click()
    await palette
      .getByRole('combobox', { name: 'Search tasks and projects' })
      .fill(`${run.tag} archived`)
    const results = () =>
      palette
        .locator('[cmdk-item]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-value')))
    expect(
      await until(async () => {
        const busy = await palette.locator('[cmdk-list]').getAttribute('aria-busy')
        const rows = await results()
        return busy === null && rows.length === 1 && rows[0] === `issue-${two.key}`
      }),
      `Search in Zulu did not find exactly ${two.key}`,
    )
    await palette.press('Escape')
    return `chose Alpha and Zulu from projectNav.children, found Zulu with its project by search, opened ${three.key} over Settings, and found only ${two.key} in Search narrowed to Zulu`
  })
}

/** The description of the archived task Search opens (archiveChecks). */
const archivedNotes = () => `${run.tag} notes kept with the archived task`

/** Main Search in the browser finds `active`, an active task the run made,
 *  with Include archived tasks off, and `target`, a task the run archived,
 *  only with it on, marked Archived. Opening `target` shows its window
 *  read-only (data-task-archived) with its description and, under All, its
 *  history, from the deployment's taskWindow.task and threadHistory. It
 *  searches each task's title, whose run tag no other run's task holds, as
 *  Nora, whose admin seat is searched whole, and only reads. It must run
 *  before the run archives its project, as Search leaves out the tasks of
 *  archived projects. With the toggle off, the search filters archived
 *  tasks out in the search index (convex/lib/mainSearch.ts
 *  ARCHIVED_FILTER), so this checks on the deployment that the filter is
 *  accepted and still returns active matches. */
async function paletteSearchCheck(target, active) {
  await check('ui/search-archived', async () => {
    await app.goto(`${cfg.appOrigin}/app/${ORG_SLUG}/board/all`, {
      waitUntil: 'domcontentloaded',
    })
    const open = app.locator('button[data-sidebar-search]')
    await open.waitFor({ timeout: 60_000 })
    await open.click()
    const palette = app.getByRole('dialog', { name: 'Search tasks and projects', exact: true })
    const input = palette.getByRole('combobox', { name: 'Search tasks and projects' })
    await input.waitFor()
    expect(active, 'the run made no active task to search')
    const row = palette.locator(`[cmdk-item][data-value="issue-${target.key}"]`)
    // the search for the text has answered: the list is busy only while a
    // request runs or typing rests before one (src/panels/Palette.tsx), so
    // a failed or refused search answers too, and the Retry check sees it
    const answered = async () =>
      (await palette.locator('[cmdk-list]').getAttribute('aria-busy')) === null
    // the filter returns active matches
    await input.fill(active.title)
    expect(
      await until(
        async () =>
          (await answered()) &&
          (await palette.locator(`[cmdk-item][data-value="issue-${active.key}"]`).count()) === 1,
      ),
      `Search did not find the active ${active.key} with Include archived tasks off`,
    )
    // and leaves archived ones out
    await input.fill(target.title)
    expect(await until(answered), 'Search did not answer with the toggle off')
    eq(await row.count(), 0, 'the archived task with Include archived tasks off')
    const failed = await palette.locator('[data-palette-retry]').count()
    eq(failed, 0, 'a failed search with the toggle off')
    await palette.locator('[data-palette-archived]').click()
    expect(
      await until(async () => (await answered()) && (await row.count()) === 1),
      `Search did not find ${target.key} with Include archived tasks on`,
    )
    eq(
      (await row.locator('[data-result-archived]').textContent())?.trim(),
      'Archived',
      'the mark on the archived result',
    )
    // opened, it shows read-only with its text, and its history under All
    await row.click()
    await palette.waitFor({ state: 'detached', timeout: 10_000 })
    const opened = app.locator('[role="dialog"][data-task-archived]')
    await opened.waitFor({ timeout: 30_000 })
    expect(
      await until(async () =>
        ((await opened.locator('[data-task-description]').textContent()) ?? '').includes(
          archivedNotes(),
        ),
      ),
      `the window of ${target.key} does not show its description`,
    )
    eq(await opened.locator('[data-composer]').count(), 0, 'a composer on an archived task')
    await opened.locator('.task-activity-head button').filter({ hasText: /^All$/ }).click()
    expect(
      await until(async () => (await opened.locator('[data-event]').count()) > 0),
      `the window of ${target.key} shows no history under All`,
    )
    eq(await opened.locator('[data-thread-failure]').count(), 0, 'a failed history read')
    await opened.locator('[data-task-close]').click()
    await opened.waitFor({ state: 'detached', timeout: 10_000 })
    return `found the active ${active.key} with the toggle off, and the archived ${target.key} only with it on, which opens read-only with its text and history`
  })
}

/** The step that opens task links (taskLinkCheck). */
export const TASK_LINK_STEP = 'ui/task-link'

/** The link of a task number no organization reaches, and what the window
 *  says of it (src/panels/IssueDetail.tsx TaskGone). */
export const TASK_LINK_UNKNOWN = {
  ref: 'qn-99999999',
  note: "QN-99999999 can't be opened. It may not exist, or you may not have access to it.",
}

/** Task links in fresh loads, each opening its task through the
 *  deployment's taskWindow.task in the organization the address names,
 *  without waiting for every task: `target`, a task the run archived,
 *  shows read-only with the archived note and its title, a number no task
 *  has says it can't be opened, and `active`, a task the run made, shows
 *  its title with no note. It reads only. It must run before the run
 *  archives its project. */
async function taskLinkCheck(target, active) {
  await check(TASK_LINK_STEP, async () => {
    const at = (ref) => `${cfg.appOrigin}/app/${ORG_SLUG}/tasks/${ref.toLowerCase()}`
    // the archived task, read-only under its note
    await app.goto(at(target.key), { waitUntil: 'domcontentloaded' })
    const archived = app.locator('[role="dialog"][data-task-archived]')
    await archived.waitFor({ timeout: 60_000 })
    const note = archived.locator('[data-task-gone] [role="status"]')
    expect(
      await until(async () =>
        ((await note.textContent()) ?? '').startsWith(`${target.key} was archived.`),
      ),
      `the link of ${target.key} does not say it was archived`,
    )
    eq(
      (await archived.locator('[data-task-title]').textContent())?.trim(),
      target.title,
      'the title of the archived task',
    )
    eq(await archived.locator('[data-composer]').count(), 0, 'a composer on an archived task')
    // a number no task has, which only the deployment can say
    await app.goto(at(TASK_LINK_UNKNOWN.ref), { waitUntil: 'domcontentloaded' })
    const unknown = app.locator('[role="dialog"] [data-task-gone] [role="status"]')
    await unknown.waitFor({ timeout: 60_000 })
    expect(
      await until(async () => (await unknown.textContent()) === TASK_LINK_UNKNOWN.note),
      `the link of ${TASK_LINK_UNKNOWN.ref} does not say it can't be opened`,
    )
    // an active task, with its title and no note
    await app.goto(at(active.key), { waitUntil: 'domcontentloaded' })
    const title = app.locator('[role="dialog"] [data-task-title]')
    await title.waitFor({ timeout: 60_000 })
    expect(
      await until(async () => ((await title.textContent()) ?? '').trim() === active.title),
      `the link of ${active.key} does not show its title`,
    )
    eq(await app.locator('[data-task-gone]').count(), 0, 'a note on an active task')
    return `opened ${target.key} read-only as archived, ${TASK_LINK_UNKNOWN.ref} as one that can't be opened, and ${active.key} by their links`
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
      // the third, which Search opens, with a text its window shows
      const t = await restOk(w, 'POST', '/tasks', {
        project: p.id,
        title: `${run.tag} archived ${n}`,
        ...(n === 3 ? { description: archivedNotes() } : {}),
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
    // a cursor of no page, on an active list
    await restRefusal(
      w,
      'GET',
      `/tasks?project=${M.id}&cursor=x`,
      undefined,
      400,
      LIST_REFUSALS.cursor,
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
        LIST_REFUSALS.cursor,
        'an active list with a cursor of no page',
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
      const rows = await restTasks(w, `/tasks?project=${M.id}&limit=200`)
      for (const id of archived)
        expect(!rows.some((t) => t.id === id), 'REST lists an archived task')
      expect(
        rows.every((t) => t.archived === false),
        'an active list holds an archived row',
      )
      const mcpRows = await mcpTasks(w, { project: M.id, limit: 200 })
      for (const id of archived)
        expect(!mcpRows.some((t) => t.id === id), 'MCP lists an archived task')
    })
    await archivedTasksPageCheck(archivedTasks[2])
    await projectPickerCheck(archivedTasks)
    await paletteSearchCheck(archivedTasks[2], run.parent)
    await taskLinkCheck(archivedTasks[2], run.parent)
  } else
    for (const id of [
      'archived-lists/rest/cursor-pages',
      'archived-lists/mcp',
      'task-lists/active-only',
      'ui/archived-tasks-page',
      PICKER_STEP,
      'ui/search-archived',
      TASK_LINK_STEP,
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
      const tasks = await restTasks(cred, `/tasks?project=${M.id}&limit=200`)
      expect(
        tasks.some((t) => t.id === run.t0.id),
        'naming the archived project lists its tasks',
      )
      // the run's tag keeps the list to this run's tasks, so t0 cannot be
      // pushed off the page by the organization's other tasks
      const all = await restTasks(cred, `/tasks?limit=200&search=${run.tag}`)
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
    const tasks = await restTasks(w, `/tasks?project=${M.id}&limit=200`)
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
const counts = (done, total) => ({
  done,
  total,
  percent: total === 0 ? 0 : Math.round((done / total) * 100),
})
/** A project's `completion` whose tasks were counted, which says `ok`. */
const completion = (done, total) => ({ status: 'ok', ...counts(done, total) })

/** A project's `completion` while the organization's counts are not
 *  whole, as for a moment after any project is archived or restored. */
const COUNTING = { status: 'counting', done: null, total: null, percent: null }

/** The milliseconds a check waits for the counts to be whole again after
 *  an archive or a restore regroups them. */
export const REGROUP_WAIT = 30_000

/** Project `p`'s completion over REST once it no longer says `counting`,
 *  which an archive or a restore of any project in the organization starts
 *  (convex/model/overviewCounts.ts startRegroup and countsReady), or a
 *  check failure after REGROUP_WAIT. */
async function countedCompletion(cred, p) {
  let got = null
  const whole = await until(async () => {
    got = (await restOk(cred, 'GET', `/projects/${p.id}`)).completion
    return got?.status !== 'counting'
  }, REGROUP_WAIT)
  expect(whole, `${p.name} completion still said counting after ${REGROUP_WAIT / 1000} seconds`)
  return got
}
/** A group's `progress`, which adds whether some of it is hidden. */
const progress = (done, total, partial = false) => ({ ...counts(done, total), partial })

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
  const viaRest = await restTasks(cred, `/tasks?project=${project.id}&limit=200`)
  const viaMcp = await mcpTasks(cred, { project: project.id, limit: 200 })
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
    (await restTasks(w, `/tasks?project=${N1.id}&status=progress&limit=200`)).map((t) => t.id)
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
        await countedCompletion(w, p),
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
    // the restore starts its family's regroup in the same transaction
    same(answer.completion, COUNTING, 'the restore answer')
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
    same(await countedCompletion(w, N), completion(doneIn(all), all.length), 'completion')
    same(
      await countedCompletion(w, N2),
      completion(0, f.leaves2.length),
      'the restored sub-project',
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
    team ? (await restRows(w, `/teams/${team.id}/members`, 'members')).map((m) => m.id).sort() : []
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
    const s = await restOk(w, 'GET', `/users/${std.id}`)
    const v = await restOk(w, 'GET', `/users/${viewer.id}`)
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
    restOk(w, 'POST', '/tasks', {
      project: run.projects.A.id,
      title: `${tag} fixture Alpha`,
      status: FIXTURE_STATUS,
    }),
  )
  run.tz = await must('setup/rest/fixture-task-zulu', () =>
    restOk(w, 'POST', '/tasks', {
      project: run.projects.Z.id,
      title: `${tag} fixture Zulu`,
      status: FIXTURE_STATUS,
    }),
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
  await workloadPageChecks()
  await peopleListChecks()
  await subtaskRuleChecks()
  // task and project facts, the live group rule and the billing pause
  await factChecks()
  // the Board of the run's project, while it is active
  await boardCheck()
  // the task window's relation pickers, while it is active
  await relationPickersCheck()
  // the Overview of a sub-project of its own, while the project is active
  await overviewCheck()
  // the Board and a task address without task windows, then the Roadmap
  // with them, while the project is active
  await tasksOnDemandCheck()
  // Settings › Labels with a label of its own on a fixture task
  await settingsLabelsCheck()
  // Settings › Teams and a team's page on the server's reads, with a team
  // of its own
  await settingsTeamsCheck()
  // the removal window and its Reassign picker on a sub-project of its own
  await removalWindowCheck()
  // a project's Settings page on the server's reads, on a sub-project of its own
  await projectSettingsCheck()
  // the New project and New sub-project dialogs on the server's pickers, on
  // a project of its own
  await projectDialogsCheck()
  // Billing's current storage and Storage by project, with a file of its own
  await billingStorageCheck()
  // Billing's API calls by account and Who counts toward your bill, with
  // the run's agents
  await billingAccountsCheck()
  // a file attached through the task window, on an upload ticket
  await attachmentUploadCheck()
  // Settings › Projects and Archived projects on the server's lists, on a
  // project of its own
  await settingsProjectsCheck()
  // the Milestones window opened from the project's Overview, on a
  // milestone of its own, while the project is active
  await milestoneWindowCheck()
  // Team sync on the deployment's agenda, with a task of its own, while
  // the project is active
  await teamSyncCheck()
  // archived tasks and projects, then delete the projects in the app
  await archiveChecks()
  await check('cleanup/app/delete-project', async () => {
    await deleteProjectInApp(c.writeToken, run.projects.M)
    if (run.projects.N) await deleteProjectInApp(c.writeToken, run.projects.N)
    if (run.projects.R) await deleteProjectInApp(c.writeToken, run.projects.R)
    if (run.projects.L) await deleteProjectInApp(c.writeToken, run.projects.L)
    if (run.projects.D) await deleteProjectInApp(c.writeToken, run.projects.D)
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
          (id) => window.PLANNER.removeAccess({ kind: 'deleteTeam', teamId: id }, { to: null }),
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

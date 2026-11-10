// The combined load benchmark: many tabs, people and sessions on one
// disposable local Convex backend. It measures what each view subscribes,
// what a change re-sends to whom, and what a cold start, a reconnect, an
// idle stretch and busy CPUs cost the server and its clients, the combined
// load of many tabs, devices, people and organizations that the later-work
// entry on it of 9 November 2026 in qivo-internal asks for. Design
// specification §9.1's timing line judges the JavaScript time of each call
// at the everyday values, quiet and busy; figures past them are information.
//
//   QIVO_LOCAL_ADMIN_KEY=… node scripts/benchmark-load.mjs <part> [options]
//   node scripts/benchmark-load.mjs --help
//
// --help prints the parts and every option with the parts that read it and
// its default, from the one table the parser reads too (load/options.mjs
// OPTIONS); an unknown option, or one its part does not read, stops the run
// before anything starts. The pure parts live in scripts/load/, which
// scripts/benchmark-load.test.mjs checks: options.mjs the options,
// plan.mjs the organization setup grows and which client replays what,
// frames.mjs the Convex sync protocol and the recorded sets, changes.mjs the
// changes phase's plan, alerts.mjs the app's alert client wired for a
// replayed leader, and report.mjs the figures.
//
// Only a disposable local backend. --url and --site-url must be loopback
// origins, the run refuses a CONVEX_DEPLOY_KEY in its environment, and it
// reads the local backend's admin key from QIVO_LOCAL_ADMIN_KEY, as the
// local seeds do, and prints it nowhere. The browser parts sign in only
// once the app at --site-url syncs with --url, with every request that
// leaves loopback aborted while they do (signedIn). Never point it at a
// hosted deployment: it plants logins and sessions, adds people, teams and
// organizations, reassigns tasks and writes changes and comments. Run it in
// a Boat sandbox against the backend the sandbox started, after
// `marketing-demo.mjs seed --local` seeded Northstar there and
// `board-scale-seed.mjs --local --tasks 300` gave its 12 sub-projects about
// the everyday 30 tasks each. people.json holds the planted session ids,
// which act only with the admin key; setup writes it only to a working
// folder outside the checkout or one git ignores, so a sandbox adds
// dev-temp/ to .git/info/exclude first.
//
// The parts:
//
// - setup grows Northstar to the everyday organization, --people profiles
//   (agents included) and --teams teams, and writes <dir>/people.json. It
//   deploys no module: with the admin key it creates each Better Auth login
//   and session through the Better Auth component's own adapter functions
//   (convex/betterAuth/adapter.ts create and findOne), claims each seat
//   through identity.claimSeatsInternal as the sign-in does, and makes every
//   team, share, person and assignment through the app's public mutations
//   as Nora, the organization's admin. Each new person joins 3 teams, one of
//   Northstar's two, which are shared with every top-level project, and two
//   new ones, each shared with one sub-project, so no project holds more
//   than 3 team shares, inside the design size's 5. Each new person is then
//   made the assignee of --tasks-each open tasks that neither Nora nor
//   another added person holds, the seed's other people's or nobody's,
//   where it holds Edit, as an assignee must (under its Northstar
//   team's own projects and in its new teams' sub-projects), so it holds
//   tasks and, from each "Assigned to you" message, Inbox items as an
//   everyday person does, while the organization's task counts stay as
//   they were (plan.mjs holdPlaces and everydayAssignments). It plants a
//   session for Nora and for each of the seed's people with a login. With
//   --orgs N it adds N - 1 organizations at everyday size (setupOrg): a new
//   login creates each, mirrors Northstar's projects by name with 30 tasks
//   a sub-project owned by its people, and invites Nora, whose login claims
//   the seat as a guest, since a login holds one home seat
//   (convex/identity.ts claimSeatsForLogin). A second run keeps the
//   people, sessions and organizations people.json holds and adds
//   Northstar's missing teams, people and assignments; an added
//   organization whose setup stopped partway, which people.json does not
//   hold yet, is not resumed, since its projects and tasks are created
//   once, so start such a run on a fresh backend.
// - record opens one real tab per --views view in --browser as Nora,
//   signed in through the app's own sign-in with the seed's fixture
//   password (browser-demo.mjs signInDemo): the Board of Luma Sensor's
//   Firmware sub-project (or of the whole project with --board-top), the
//   Overview, the Roadmap and Team sync of Luma Sensor, the Inbox and My
//   view, in each organization. Chromium runs as the full browser in its
//   new headless mode, since the headless shell answers notifications as
//   denied, and its context is granted notifications, so the tab leads its
//   profile's desktop alerts and its set holds the Inbox feed and the
//   delivery mode; Firefox and WebKit run without where they refuse. It
//   waits until the tab is current and quiet for --quiet-ms, and writes
//   <dir>/sets/<view>.json: each query's function, arguments and last
//   answer's bytes, the address, and the mutations the tab called. It never
//   reads an Authenticate frame, so no token reaches a set, and times
//   nothing in the browser.
// - replay runs --clients Node clients over --processes processes, each a
//   ConvexClient from convex/browser over the WebSocket, as the app's own
//   client is. The clients are dealt to the --orgs organizations in turn,
//   and in each the first is Nora on its Board as she recorded it, and
//   person j of people.json takes the organization's recorded set of view j
//   modulo the views but My view, whose reads follow the recorder's own
//   tasks, with no id swapped, since a view's id lists name the rows it
//   shows to whoever opens it (plan.mjs clientSpecs, frames.mjs
//   personQueries). A client that would read an id of another organization,
//   or one id twice in a list, stops the run before any client starts
//   (plan.mjs checkSpecs), as do sets recorded on another local day, whose
//   dated arguments are that day's (frames.mjs checkSetsDay). A client
//   acts with the admin key as its person's planted login and session, so
//   the session wrappers run as in the app, but no JWT is validated or
//   refreshed, and it makes none of a boot's one-off writes, which the sets
//   list under `calls`. A client whose set holds the Inbox feed leads its
//   profile's alerts with the app's own alert client and leader
//   (src/lib/notificationFeed.ts and notificationLeader.ts, load/alerts.mjs),
//   so it beats, watches the feed, claims, summarizes first where the
//   server asks and runs the resume order after a reconnect as a leading
//   tab does. Such a leader watches the feed again at each beat, about once
//   a minute, once its floor is ten minutes old; for ten minutes after an
//   Inbox event, or after a summary, it watches nothing new. Its phases,
//   startup first, then the others in the order --phases names them:
//   - match: before any load, one client per recorded set as Nora herself,
//     compared with the tab in functions, arguments and answer bytes (the
//     feed's `after` is the leader's clock and compared by presence), then
//     a reconnect of one Board client alone, leading its alerts as the
//     replay's Board clients do, the reconnect trigger's base.
//   - startup: every client created and subscribed at once, from cold, each
//     one's time to current and its set against the recorded set it was
//     given.
//   - changes: --changes changes, one a second, as Nora on the recorded
//     Board's open tasks: a rename, a move to a sibling sub-project and
//     back, a status change between two open statuses and a comment, the
//     comments on four other tasks in turn so the rule of 10 comments a
//     minute from one person on one task refuses none (changes.mjs). The
//     title, the status and the move are put back and the posted comments
//     removed after, so a later run reads the same tasks, titles and
//     statuses, while each run's activity, Inbox items and removed comments
//     stay.
//   - reconnect: every client's socket closed at once, and with the hidden
//     tab one real tab on the recorded Board, hidden as the visibility
//     stage hid it, whose check passes when it reconnected, became current
//     again without a reload, stayed hidden, and what it subscribes again
//     holds none of the reads it dropped on hiding and nothing new.
//   - idle: --idle-s seconds with no change.
//   - busy: the changes again beside --busy-loops spinning processes,
//     pinned to --busy-cpus, the backend's, with taskset.
//   A phase that fails, such as on a saturated backend, records why and
//   the run goes on. The rung goes to --output, else
//   <dir>/out/rung-<clients>.json.
// - tabs opens --tabs real tabs of Nora at once in one browser profile,
//   tab i on view i modulo --views at its recorded address, and runs
//   startup, changes, reconnect and idle over them as the replay runs them
//   over its clients, so a tab's figures stand beside a replayed client's,
//   its time to current to the same moment, when its set became current
//   (frames.mjs FrameTracker currentSince).
//   It writes <dir>/out/tabs-<tabs>.json unless --output names a file.
//
// Where each figure comes from (report.mjs rungReport `sources`):
//
// - JavaScript and total time per call, executions, cache answers and
//   errors: the local backend's function log stream
//   (/api/stream_function_logs, userExecutionTime and executionTime), top
//   level calls only, a nested call's time inside its caller's. The stream
//   drops entries when its queue fills, so each phase compares the
//   mutations and actions its clients and the changes' writer sent with the
//   log and counts its failed reads (report.mjs logCoverage): `complete`,
//   `lower_bounds` where the counts are lower bounds, or `unknown` where
//   nothing was sent to compare. A change the log holds no entry of has
//   reruns unknown (null), not none.
// - The calls the backend ran at once: the overlap of those log entries.
// - Time to current, a mutation's round trip and a query's first answer
//   from its Add (client_first_answer_ms): each client's or tab's own
//   clocks, which a saturated log cannot drop. The calls in flight: the
//   clients' own counts, sampled every 100 ms.
// - Bytes: each client's or tab's received WebSocket frames. An answer's
//   bytes are its value's JSON length; a phase's bytes_total counts every
//   frame, pings included. A change's re-send is what each client received
//   between it and the next change.
// - Idle per session per minute: the bytes, answers and calls of the idle
//   phase over its sessions, the leaders' beats, claims and own reads apart
//   from the views' answers (idleShares), and the backend's own jobs per
//   minute apart, since no session asks for them.
// - Steal and busy CPU: /proc/stat over the phase; a phase at 10% steal or
//   more is marked noisy and is no timing, and one whose steal could not be
//   read is marked noisy null, unknown (report.mjs noisyOf). Event loop
//   lag: each process's monitorEventLoopDelay past its 10 ms resolution.
// - The pacing trigger, judged against the modelled hosted query limit, not
//   the local backend's overload: a phase whose clients asked more than
//   hosted Professional's 256 queries at one moment (report.mjs
//   hostedModel, a model and not a hosted measurement), a call whose
//   JavaScript passes the 0.5 s line, or a client whose time to current
//   after the reconnect passes ten times the lone client's, each with its
//   phase. An overload close (1013) is listed as the test bed's saturation
//   (test_bed_saturated) and fires nothing.
//
// The test bed. The local backend runs at most 16 queries and 16
// mutations at once, Convex's defaults, which nothing here raises. Once a
// rung fills those slots, calls queue past their limits, are refused
// (TooManyConcurrentRequests) and sockets close with 1013, and the rung
// measures the test bed, not Qivo's reads; a local overload close says
// nothing of hosted Convex's limit (test_bed_saturated). Pin the backend
// to its own CPUs and the clients to the others (taskset), and start the
// sandbox without snapshots, whose captures slow the backend.
import { fork, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { ConvexClient, ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { jsonToConvex } from 'convex/values'
import { leadAlerts, loadAppAlerts } from './load/alerts.mjs'
import { CHANGE_KINDS, commentTargets } from './load/changes.mjs'
import {
  checkSet,
  checkSetsDay,
  compareSets,
  FrameTracker,
  recordedSet,
  subscriptionsByOrganization,
  withoutLeaderReads,
} from './load/frames.mjs'
import { isLoopbackOrigin, loadOptions, OptionsError, usage, VIEWS } from './load/options.mjs'
import {
  checkSpecs,
  clientSpecs,
  everydayAssignments,
  findSeat,
  holdPlaces,
  idsOfOrg,
  orgsOf,
  stableId,
  teamsOfPerson,
  viewUrls,
} from './load/plan.mjs'
import {
  attachResends,
  cpuCounters,
  cpuShare,
  firstAnswerStats,
  functionStats,
  idleShares,
  logCoverage,
  logEntry,
  mergeCalls,
  mostAtOnce,
  noisyOf,
  overLine,
  pacingTrigger,
  perSessionMinute,
  phaseFigures,
  rungReport,
  spread,
  tabResends,
  tabsIdlePerMinute,
  watchedPerMinute,
} from './load/report.mjs'
import { ignoredByGit } from './marketing-demo.mjs'

const ref = makeFunctionReference
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const say = (text) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`)

/** The checkout's root, which Vite loads the app's modules from. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** How long a worker may take to close its clients at the end of a run
    before it is killed. */
const STOP_MS = 30_000
/** The slug of the organization the local seed makes. */
const ORG_SLUG = 'northstar-labs'
/** The everyday names of the teams setup adds, in turn. */
const TEAM_NAMES = [
  'Field Operations',
  'Quality Lab',
  'Supply Chain',
  'Customer Support',
  'Data Platform',
  'Industrial Design',
  'Sales Engineering',
  'Security',
  'Facilities',
  'Documentation',
]
const FIRST = ['Maja', 'Oskar', 'Lina', 'Viktor', 'Elsa', 'Hugo', 'Alma', 'Nils', 'Ida', 'Axel']
const LAST = [
  'Lund',
  'Holm',
  'Berglund',
  'Sjöberg',
  'Ek',
  'Nyström',
  'Dahl',
  'Falk',
  'Wik',
  'Moberg',
]
const COLORS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2']

/** The identity a planted login presents through the admin key: the login
    as subject and its Better Auth session as sessionId, which the session
    wrappers read (convex/lib/functions.ts loadSession). */
const identityOf = (person) => ({
  subject: person.auth_user_id,
  issuer: 'https://load.local',
  tokenIdentifier: `https://load.local|${person.auth_user_id}`,
  sessionId: person.session_id,
})

/** An HTTP client with the admin key, acting as `person` when given. */
function httpClient(options, person) {
  const client = new ConvexHttpClient(options.url, { logger: false })
  client.setAdminAuth(options.adminKey, person ? identityOf(person) : undefined)
  return client
}

/** `step` again while the local backend refuses for load or a lost race. */
async function retry(step) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await step()
    } catch (error) {
      const text = String(error?.message ?? error)
      if (
        attempt > 20 ||
        !/OptimisticConcurrency|TooManyWrites|TooManyConcurrentRequests|ExpiredInQueue|overloaded|fetch failed|ECONNRESET|timed out/i.test(
          text,
        )
      )
        throw error
      await sleep(300 + 200 * attempt)
    }
  }
}

/** Every row of paged list `name` with `args` as `client` reads it,
    following `next` until there is none and waiting out not_ready for up
    to 30 s, as scripts/browser-demo.mjs navRows does in a page. `ready` is
    the state of an answered batch: `ok` for the navigation lists
    (projectNav page and children), `ready` for the settings lists
    (people.settingsPage, projectSettings.teams). Throws where the list
    answers another state or stops. */
async function pagedRows(client, name, args, ready) {
  const rows = []
  const deadline = Date.now() + 30_000
  for (let after; ; ) {
    const batch = await client.query(ref(name), { ...args, ...(after ? { after } : {}) })
    if (batch.state === 'not_ready' && Date.now() < deadline) {
      await sleep(250)
      continue
    }
    if (batch.state !== ready) throw new Error(`${name} answered ${batch.state}`)
    if (batch.stopped) throw new Error(`${name} stopped`)
    rows.push(...batch.rows)
    if (!batch.next) return rows
    after = batch.next
  }
}

/* ------------------------------------------------------------------ setup */

/** Better Auth component function `name` with `args`, through the admin
    key. The adapter loads Better Auth's options in each call
    (convex/betterAuth/adapter.ts), which can pass the local backend's 1 s
    limit on a cold isolate, so a time-out is tried again. */
const component = (admin, name, args) => retry(() => admin.function(name, 'betterAuth', args))

/** The Better Auth login of `email`, or a new one named `name`. */
async function loginOf(admin, name, email) {
  const found = await component(admin, 'adapter:findOne', {
    model: 'user',
    where: [{ field: 'email', value: email }],
  })
  if (found) return found._id
  const now = Date.now()
  const user = await component(admin, 'adapter:create', {
    input: {
      model: 'user',
      data: { name, email, emailVerified: true, role: 'user', createdAt: now, updatedAt: now },
    },
  })
  return user._id
}

/** A new Better Auth session of login `userId`, live for 30 days. */
async function sessionOf(admin, userId) {
  const now = Date.now()
  const session = await component(admin, 'adapter:create', {
    input: {
      model: 'session',
      data: {
        token: crypto.randomUUID(),
        userId,
        expiresAt: now + 30 * 86_400_000,
        createdAt: now,
        updatedAt: now,
        userAgent: 'qivo-load',
      },
    },
  })
  return session._id
}

/** A mutation that may already have run in an earlier setup, which then
    refuses because its row exists. Answers whether this call made it. */
async function once(step) {
  try {
    await retry(step)
    return true
  } catch (error) {
    if (/already/i.test(String(error?.data?.message ?? error?.message ?? error))) return false
    throw error
  }
}

/** Refuses working folder `dir` where git could commit people.json, which
    holds the planted session ids: a folder inside the checkout that git
    does not ignore (marketing-demo.mjs ignoredByGit), as in a fresh clone
    or a sandbox whose dev-temp/ no exclude rule covers. A folder outside
    the checkout passes. */
function refuseTrackedDir(dir) {
  const full = resolve(dir)
  const within = relative(ROOT, full)
  const inside = within === '' || (!within.startsWith('..') && !isAbsolute(within))
  if (inside && !ignoredByGit(ROOT, full))
    throw new Error(
      `${dir} is inside the checkout and git does not ignore it, so people.json's session ids could be committed. Add it, or dev-temp/, to .git/info/exclude, or choose a --dir outside the checkout.`,
    )
}

/** The setup part: grows Northstar to the everyday organization and writes
    people.json. */
async function setup(options) {
  refuseTrackedDir(options.dir)
  const admin = httpClient(options)
  const noraEmail = 'nora@demo.qivo.io'
  const noraLogin = await component(admin, 'adapter:findOne', {
    model: 'user',
    where: [{ field: 'email', value: noraEmail }],
  })
  if (!noraLogin)
    throw new Error('Northstar has no login for Nora. Run marketing-demo.mjs seed --local first.')
  const peopleFile = join(options.dir, 'people.json')
  const earlier = existsSync(peopleFile) ? JSON.parse(readFileSync(peopleFile, 'utf8')) : null
  const nora = {
    key: 'nora',
    name: 'Nora Berg',
    auth_user_id: noraLogin._id,
    session_id: earlier?.people?.[0]?.session_id ?? (await sessionOf(admin, noraLogin._id)),
  }
  const asNora = httpClient(options, nora)
  const root = await asNora.query(ref('workspace:root'), {})
  const seat = findSeat(root, ORG_SLUG)
  if (!seat) throw new Error(`Nora holds no seat in ${ORG_SLUG}`)
  nora.profile_id = seat.profile_id
  nora.org_id = seat.org_id
  const org = seat.org_id
  const tops = await pagedRows(asNora, 'projectNav:page', { org_id: org }, 'ok')
  const projects = []
  for (const top of tops)
    projects.push({
      id: top.id,
      name: top.name,
      num: top.num,
      children: (await pagedRows(asNora, 'projectNav:children', { project_id: top.id }, 'ok')).map(
        (child) => ({ id: child.id, name: child.name, num: child.num }),
      ),
    })
  // Northstar's own teams are Nora's (the root part names them), shared with
  // every top-level project; each team setup adds has a stable id and one
  // share, on one sub-project, so no project holds more than the design
  // size's 5 team shares
  const teams = seat.team_ids.slice()
  const subprojects = projects.flatMap((project) => project.children)
  for (let i = 0; teams.length < options.teams; i++) {
    const id = stableId(`team:${i}`)
    await once(() =>
      asNora.mutation(ref('teams:create'), {
        org_id: org,
        id,
        name: TEAM_NAMES[i % TEAM_NAMES.length],
      }),
    )
    await once(() =>
      asNora.mutation(ref('projects:setAccess'), {
        org_id: org,
        id: subprojects[i % subprojects.length].id,
        team_id: id,
        level: 'user',
      }),
    )
    teams.push(id)
  }
  // the organization's profiles as Settings › Users lists them, agents
  // included, whose ids the replay's check of other organizations' sets reads
  const profileIds = (await pagedRows(asNora, 'people:settingsPage', { org_id: org }, 'ready')).map(
    (row) => row.id,
  )
  let held = profileIds.length
  // the people an earlier run planted keep their sessions; person i has id
  // stableId(person:i), and no run goes past --people profiles
  const made = earlier?.people?.slice(1) ?? []
  const added = teams.slice(seat.team_ids.length)
  const grown = await addPeople({
    admin,
    asAdmin: asNora,
    org,
    count: Math.max(0, options.people - held),
    from: made.filter((person) => ADDED.test(person.key)).length,
    baseTeams: seat.team_ids,
    addedTeams: added,
    idOf: (i) => stableId(`person:${i}`),
    emailOf: (i) => `load.person.${String(i + 1).padStart(3, '0')}@northstar.test`,
    keyOf: (i) => `p${i + 1}`,
  })
  held += grown.created
  // the seed's own people with a login (marketing-demo.mjs PEOPLE, name@demo.qivo.io)
  // get a planted session too, last, so an organization of --people
  // profiles has a session for every person in it, its agent aside
  const seeded = []
  const known = new Set(made.map((person) => person.key))
  for (const key of ['leo', 'aisha', 'emil', 'daniel', 'sofia', 'ben']) {
    if (known.has(key)) continue
    const login = await component(admin, 'adapter:findOne', {
      model: 'user',
      where: [{ field: 'email', value: `${key}@demo.qivo.io` }],
    })
    if (!login) continue
    const person = {
      key,
      name: login.name,
      auth_user_id: login._id,
      session_id: await sessionOf(admin, login._id),
    }
    const own = findSeat(
      await httpClient(options, person).query(ref('workspace:root'), {}),
      ORG_SLUG,
    )
    if (!own) continue
    seeded.push({ ...person, profile_id: own.profile_id, org_id: own.org_id })
  }
  const people = [{ ...nora }, ...made, ...grown.people, ...seeded]
  // where each added person may hold tasks: under the top-level projects
  // its Northstar team holds Edit on, and in the sub-projects its new teams
  // are shared with, at Edit
  const editors = new Map()
  for (const top of projects) {
    const shares = await pagedRows(
      asNora,
      'projectSettings:teams',
      { org_id: org, project_id: top.id },
      'ready',
    )
    editors.set(
      top.id,
      new Set(shares.filter((share) => share.level !== 'viewer').map((share) => share.id)),
    )
  }
  const places = holdPlaces(
    people.filter((person) => ADDED.test(person.key)),
    {
      projects,
      editors,
      sharedBy: new Map(added.map((team, j) => [team, subprojects[j % subprojects.length].id])),
      teamsOf: (person) => teamsOfPerson(Number(person.key.slice(1)) - 1, seat.team_ids, added),
    },
  )
  const assigned = await assignEveryday(options, asNora, org, projects, {
    places,
    keep: nora.profile_id,
  })
  mkdirSync(options.dir, { recursive: true })
  const profile_ids = [
    ...new Set([...profileIds, ...grown.people.map((person) => person.profile_id)]),
  ]
  const northstar = {
    org_id: org,
    org_slug: ORG_SLUG,
    profiles: held,
    profile_ids,
    teams,
    projects,
    people,
  }
  const plan = { ...northstar }
  const orgs = [{ k: 0, ...northstar }]
  for (let k = 1; k < options.orgs; k++) {
    const kept = earlier?.orgs?.[k]
    orgs.push(
      kept ?? (await setupOrg(options, { admin, noraLogin: noraLogin._id, northstar: plan, k })),
    )
    writeFileSync(peopleFile, `${JSON.stringify({ ...plan, orgs }, null, 2)}\n`, { mode: 0o600 })
  }
  plan.orgs = orgs
  writeFileSync(peopleFile, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 })
  say(
    `setup: ${held} profiles, ${teams.length} teams, ${people.length} planted sessions, ${assigned} tasks assigned in ${peopleFile}` +
      (orgs.length > 1
        ? `; ${orgs.length - 1} more organizations: ${orgs
            .slice(1)
            .map(
              (one) => `${one.org_slug} (${one.profiles} profiles, ${one.people.length} sessions)`,
            )
            .join(', ')}`
        : ''),
  )
  return plan
}

/** The keys of the people setup adds to Northstar (p1, p2 and on), as
    against the seed's own (leo, aisha and the rest). */
const ADDED = /^p[0-9]+$/

/** Gives each owner of `places` --tasks-each open tasks of Northstar's
    `projects` in the sub-projects `places` names for it, as their assignee,
    as Nora (everydayAssignments), so each holds tasks and an Inbox item for
    each. Answers how many tasks it assigned; says so when the sub-projects
    hold too few. */
async function assignEveryday(options, asNora, org, projects, { places, keep }) {
  if (options.tasksEach === 0 || places.size === 0) return 0
  const tasks = []
  for (const project of projects) {
    const answer = await retry(() =>
      asNora.query(ref('tasks:board'), {
        scope: { kind: 'project', org_id: org, project_id: project.id },
        filters: BOARD_FILTERS,
      }),
    )
    if (answer.state !== 'ok')
      throw new Error(`the Board of ${project.name} answered ${answer.state}`)
    tasks.push(...answer.rows)
  }
  const { pairs, short } = everydayAssignments(places, tasks, options.tasksEach, keep)
  await pool(pairs, 8, ([id, owner]) =>
    retry(() =>
      asNora.mutation(ref('issues:update'), { org_id: org, id, patch: { assignee_id: owner } }),
    ),
  )
  if (short.length > 0)
    say(
      `setup: ${short.length} people hold fewer than ${options.tasksEach} tasks; their sub-projects hold too few open tasks`,
    )
  return pairs.length
}

/** A Board read's filters that leave every task in. */
const BOARD_FILTERS = {
  focus: false,
  mine: false,
  owners: [],
  priority: null,
  search: '',
  stale_before: null,
}

/** Runs `step(item)` for every item of `items`, `width` at a time.
    Answers the results in the items' order. */
async function pool(items, width, step) {
  const out = Array.from({ length: items.length })
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const at = next++
        out[at] = await step(items[at], at)
      }
    }),
  )
  return out
}

/** Adds `count` people to organization `org` as its admin `asAdmin`,
    numbered from `from`, each with a Better Auth login, its seat claimed
    as the sign-in claims it, and a planted session. Person i joins three
    teams: one of `baseTeams`, which reach every project, and two of
    `addedTeams`. Eight at a time. Answers the people and how many seats
    this call made. */
async function addPeople({
  admin,
  asAdmin,
  org,
  count,
  from,
  baseTeams,
  addedTeams,
  idOf,
  emailOf,
  keyOf,
}) {
  let created = 0
  const numbers = Array.from({ length: count }, (_, n) => from + n)
  const people = await pool(numbers, 8, async (i) => {
    const name = `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`
    const email = emailOf(i)
    const id = idOf(i)
    const made = await once(() =>
      asAdmin.mutation(ref('profiles:create'), {
        org_id: org,
        id,
        name,
        email,
        org_role: 'user',
        kind: 'person',
        color: COLORS[i % COLORS.length],
        teams: teamsOfPerson(i, baseTeams, addedTeams),
      }),
    )
    if (made) created++
    const auth = await loginOf(admin, name, email)
    await retry(() =>
      admin.mutation(ref('identity:claimSeatsInternal'), {
        userId: auth,
        email,
        emailVerified: true,
      }),
    )
    if ((i + 1) % 100 === 0) say(`setup: ${i + 1} people in ${org}`)
    return {
      key: keyOf(i),
      name,
      profile_id: id,
      org_id: org,
      auth_user_id: auth,
      session_id: await sessionOf(admin, auth),
    }
  })
  return { people, created }
}

/** The names of the organizations setup adds beside Northstar, and of
    the owner who creates each one. */
const MORE_ORGS = [
  { name: 'Harbor Analytics', owner: 'Ines Kaya' },
  { name: 'Fjordline Robotics', owner: 'Tomas Wieland' },
  { name: 'Copperfield Studio', owner: 'Priya Nair' },
  { name: 'Birchway Health', owner: 'Jonas Ek' },
  { name: 'Alder Logistics', owner: 'Mira Holt' },
]

/** Organization number `k` beside Northstar at everyday size, mirroring
    Northstar's projects and sub-projects by name: a new login creates it
    (identity.createOrganization, which makes its starter team), adds a
    second team shared with every top-level project like Northstar's two,
    --teams teams in all with each added one shared with one sub-project,
    30 tasks a sub-project (board-scale-seed's seededTask, owned in turn by
    its people), and --people profiles: the owner, Nora, invited by her
    email so her login claims the seat as a guest (one home seat a login,
    identity.ts claimSeatsForLogin) and given `user` on every top-level
    project, and new people with logins and sessions. Nora gets a session
    of her own for each organization, as one tab in each would. Answers the
    organization's part of people.json. */
async function setupOrg(options, { admin, noraLogin, northstar, k }) {
  const { seededTask } = await import('./board-scale-seed.mjs')
  const spec = MORE_ORGS[(k - 1) % MORE_ORGS.length]
  const ownerEmail = `load.owner.${k}@org${k}.test`
  const ownerLogin = await loginOf(admin, spec.owner, ownerEmail)
  const owner = {
    key: `owner${k}`,
    name: spec.owner,
    auth_user_id: ownerLogin,
    session_id: await sessionOf(admin, ownerLogin),
  }
  const asOwner = httpClient(options, owner)
  let root = await asOwner.query(ref('workspace:root'), {})
  let seat = findSeat(root, (row) => row.name === spec.name)
  if (!seat) {
    await retry(() => asOwner.mutation(ref('identity:createOrganization'), { name: spec.name }))
    root = await asOwner.query(ref('workspace:root'), {})
    seat = findSeat(root, (row) => row.name === spec.name)
  }
  if (!seat) throw new Error(`${spec.owner} holds no seat in ${spec.name}`)
  const org = seat.org_id
  owner.profile_id = seat.profile_id
  owner.org_id = org
  const note = (text) => say(`setup ${seat.slug}: ${text}`)
  // the teams: the starter team and a second one reach every project
  const base = seat.team_ids.slice(0, 1)
  const second = stableId(`org${k}:team:base`)
  await once(() =>
    asOwner.mutation(ref('teams:create'), { org_id: org, id: second, name: 'Operations' }),
  )
  base.push(second)
  // the projects and sub-projects, Northstar's by name and order
  const projects = []
  for (const [t, top] of northstar.projects.entries()) {
    const id = stableId(`org${k}:project:${t}`)
    const made = await retry(() =>
      asOwner.mutation(ref('projects:create'), {
        org_id: org,
        id,
        type: 'meta',
        key: `T${t + 1}`,
        name: top.name,
      }),
    )
    const entry = { id, name: top.name, num: made.num, children: [] }
    for (const [c, child] of top.children.entries()) {
      const childId = stableId(`org${k}:project:${t}:${c}`)
      const sub = await retry(() =>
        asOwner.mutation(ref('projects:create'), {
          org_id: org,
          id: childId,
          type: 'project',
          parent_id: id,
          key: `S${t + 1}${String.fromCharCode(65 + c)}`,
          name: child.name,
        }),
      )
      entry.children.push({ id: childId, name: child.name, num: sub.num })
    }
    for (const team of base)
      await once(() =>
        asOwner.mutation(ref('projects:setAccess'), {
          org_id: org,
          id,
          team_id: team,
          level: 'user',
        }),
      )
    projects.push(entry)
  }
  const subprojects = projects.flatMap((project) => project.children)
  const teams = base.slice()
  for (let i = 0; teams.length < options.teams; i++) {
    const id = stableId(`org${k}:team:${i}`)
    await once(() =>
      asOwner.mutation(ref('teams:create'), {
        org_id: org,
        id,
        name: TEAM_NAMES[i % TEAM_NAMES.length],
      }),
    )
    await once(() =>
      asOwner.mutation(ref('projects:setAccess'), {
        org_id: org,
        id: subprojects[i % subprojects.length].id,
        team_id: id,
        level: 'user',
      }),
    )
    teams.push(id)
  }
  note(`${projects.length} projects, ${subprojects.length} sub-projects, ${teams.length} teams`)
  // Nora, invited by her address, claims the seat as a guest
  const noraId = stableId(`org${k}:nora`)
  await once(() =>
    asOwner.mutation(ref('profiles:create'), {
      org_id: org,
      id: noraId,
      name: 'Nora Berg',
      email: 'nora@demo.qivo.io',
      org_role: 'user',
      kind: 'person',
      color: COLORS[0],
    }),
  )
  await retry(() =>
    admin.mutation(ref('identity:claimSeatsInternal'), {
      userId: noraLogin,
      email: 'nora@demo.qivo.io',
      emailVerified: true,
    }),
  )
  for (const project of projects)
    await once(() =>
      asOwner.mutation(ref('projects:setAccess'), {
        org_id: org,
        id: project.id,
        user_id: noraId,
        level: 'user',
      }),
    )
  const nora = {
    key: `nora@${seat.slug}`,
    name: 'Nora Berg',
    profile_id: noraId,
    org_id: org,
    auth_user_id: noraLogin,
    session_id: await sessionOf(admin, noraLogin),
    guest: true,
  }
  // the people, the owner and Nora counted among --people
  const grown = await addPeople({
    admin,
    asAdmin: asOwner,
    org,
    count: Math.max(0, options.people - 2),
    from: 0,
    baseTeams: base,
    addedTeams: teams.slice(base.length),
    idOf: (i) => stableId(`org${k}:person:${i}`),
    emailOf: (i) => `load.person.${String(i + 1).padStart(3, '0')}@org${k}.test`,
    keyOf: (i) => `o${k}p${i + 1}`,
  })
  note(`${grown.people.length + 2} profiles`)
  // 30 tasks a sub-project, owned in turn by the people
  const owners = grown.people.map((person) => person.profile_id)
  const jobs = subprojects.flatMap((sub, s) =>
    Array.from({ length: 30 }, (_, n) => ({ sub, n: s * 30 + n })),
  )
  await pool(jobs, 8, async ({ sub, n }) => {
    const { id: _id, ...task } = seededTask(n, org, sub.id, owners[n % owners.length])
    await retry(() =>
      asOwner.mutation(ref('issues:create'), { ...task, id: stableId(`org${k}:task:${n}`) }),
    )
  })
  note(`${jobs.length} tasks`)
  return {
    k,
    org_id: org,
    org_slug: seat.slug,
    name: spec.name,
    profiles: grown.people.length + 2,
    profile_ids: [owner.profile_id, noraId, ...grown.people.map((person) => person.profile_id)],
    teams,
    projects,
    owner: { ...owner },
    people: [nora, ...grown.people],
  }
}

/** people.json, which setup writes. */
function readPlan(options) {
  const file = join(options.dir, 'people.json')
  if (!existsSync(file)) throw new Error(`${file} is missing. Run the setup part first.`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

/* ----------------------------------------------------------------- record */

/** The WebSocket URL prefix of the local backend's sync socket. */
const socketPrefix = (options) => options.url.replace(/^http/, 'ws')

/** How long the sign-in page may take to open its sync socket. */
const SYNC_WAIT_MS = 30_000

/** A Playwright browser of `options.browser` and a context signed in as
    Nora, with the page it signed in on. The app connects to the backend
    its dev server or build was started with, which --url does not set, so
    before Nora's fixture password is typed the sign-in page must sync with
    --url (staging-check.mjs syncsWith), and while the sign-in runs every
    request that leaves loopback is aborted, so neither the password nor a
    boot write can reach a hosted deployment. A sign-in that fails closes
    the browser it launched, whose process would otherwise keep the run
    alive. */
async function signedIn(options) {
  const playwright = await import('playwright')
  const { loadBrowserDemo, signInDemo } = await import('./browser-demo.mjs')
  const { syncsWith } = await import('./staging-check.mjs')
  const demo = loadBrowserDemo(`${options.siteUrl}/`, {
    env: {
      ...process.env,
      QIVO_FIXTURE_LOCAL: 'true',
      QIVO_LOCAL_DEPLOYMENT: options.deployment,
      VITE_CONVEX_URL: options.url,
    },
  })
  // Chromium's headless shell answers notifications as denied whatever the
  // context grants, so Chromium runs as the full browser's new headless mode
  const browser = await playwright[options.browser].launch(
    options.browser === 'chromium' ? { channel: 'chromium' } : {},
  )
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    let notifications = false
    try {
      await context.grantPermissions(['notifications'], { origin: options.siteUrl })
      notifications = true
    } catch {
      // Firefox and WebKit may refuse; the tab then does not lead its alerts
    }
    // every socket the page opens, for the hidden tab's reconnect
    await context.addInitScript(() => {
      const Native = window.WebSocket
      window.__loadSockets = []
      window.WebSocket = class extends Native {
        constructor(...args) {
          super(...args)
          window.__loadSockets.push(this)
        }
      }
    })
    // only for the sign-in: a route on every request would slow the timed tabs
    const offLoopback = (url) => !isLoopbackOrigin(url.origin)
    await context.route(offLoopback, (route) => route.abort())
    const page = await context.newPage()
    const sockets = []
    page.on('websocket', (socket) => sockets.push(socket.url()))
    await page.goto(`${options.siteUrl}/app/~/projects`, { waitUntil: 'domcontentloaded' })
    const deadline = Date.now() + SYNC_WAIT_MS
    while (!syncsWith(sockets, options.url) && Date.now() < deadline) await sleep(100)
    if (!syncsWith(sockets, options.url)) {
      // only origins, because a socket's URL can hold a token
      const opened = [...new Set(sockets.map((url) => new URL(url).origin))]
      throw new Error(
        `the app at ${options.siteUrl} does not sync with ${options.url}, the backend --url names; ${opened.length > 0 ? `it opened WebSockets to ${opened.join(', ')}` : 'it opened no WebSocket'}. Start its dev server or build with VITE_CONVEX_URL=${options.url}.`,
      )
    }
    await signInDemo(page, demo, 'nora')
    await context.unroute(offLoopback)
    return { browser, page, notifications }
  } catch (error) {
    await browser.close().catch(() => {})
    throw error
  }
}

/** A tracker fed by every backend socket `page` opens from now on, with
    `onAnswer` hearing each answer. The tracker's `openedAt` is when the
    page made its newest backend socket. */
function trackPage(page, options, onAnswer) {
  const tracker = new FrameTracker(onAnswer ? { onAnswer } : {})
  tracker.openedAt = null
  page.on('websocket', (socket) => {
    if (!socket.url().startsWith(socketPrefix(options))) return
    tracker.openedAt = Date.now()
    socket.on('framesent', (frame) => {
      if (typeof frame.payload === 'string') tracker.sent(frame.payload)
    })
    socket.on('framereceived', (frame) => {
      if (typeof frame.payload === 'string') tracker.received(frame.payload)
    })
    socket.on('close', () => tracker.closed(null, 'closed'))
  })
  return tracker
}

/** Waits until `tracker` is current and no frame came for `quietMs`, or
    `timeoutMs` passed. Answers whether it settled and how long it took. */
async function settle(tracker, quietMs, timeoutMs, from = Date.now()) {
  const deadline = from + timeoutMs
  for (;;) {
    const now = Date.now()
    if (tracker.current && now - (tracker.lastFrameAt ?? from) >= quietMs)
      return { settled: true, ms: (tracker.lastFrameAt ?? now) - from }
    if (now > deadline) return { settled: false, ms: now - from }
    await sleep(100)
  }
}

/** The record part: one real tab per view, each recorded set written to
    <dir>/sets/<view>.json. */
async function record(options) {
  const plan = readPlan(options)
  const { browser, page: signInPage, notifications } = await signedIn(options)
  const context = signInPage.context()
  await signInPage.close()
  const summaries = []
  try {
    // Northstar's sets in <dir>/sets, each other organization's, recorded
    // as Nora's seat there, in <dir>/sets/<slug>
    for (const planOrg of orgsOf(plan))
      summaries.push(...(await recordOrg(options, context, planOrg, notifications)))
  } finally {
    await browser.close()
  }
  return summaries
}

/** The folder of organization `planOrg`'s recorded sets. */
const setsDir = (options, planOrg) =>
  planOrg.k === 0 ? join(options.dir, 'sets') : join(options.dir, 'sets', planOrg.org_slug)

/** The views of one organization recorded in `context`, as Nora's seat
    there (people[0] of its part of people.json). */
async function recordOrg(options, context, planOrg, notifications) {
  const recorder = planOrg.people[0]
  const urls = viewUrls(planOrg, options.boardTop)
  const dir = setsDir(options, planOrg)
  mkdirSync(dir, { recursive: true })
  const summaries = []
  for (const view of options.views) {
    const page = await context.newPage()
    const tracker = trackPage(page, options)
    const started = Date.now()
    await page.goto(`${options.siteUrl}${urls[view]}`, { waitUntil: 'domcontentloaded' })
    const { settled, ms } = await settle(tracker, options.quietMs, options.timeoutMs, started)
    const set = recordedSet({
      view,
      url: urls[view],
      browser: options.browser,
      person: {
        profile_id: recorder.profile_id,
        auth_user_id: recorder.auth_user_id,
        org_id: recorder.org_id,
      },
      tracker,
      recordedAt: new Date().toISOString(),
    })
    set.settled = settled
    set.ms_to_quiet = ms
    set.notifications = notifications
    set.org_slug = planOrg.org_slug
    writeFileSync(join(dir, `${view}.json`), `${JSON.stringify(set, null, 2)}\n`)
    const bytes = set.queries.reduce((all, query) => all + (query.bytes ?? 0), 0)
    say(
      `record ${planOrg.org_slug} ${view}: ${set.queries.length} queries, ${bytes} answer bytes, ${settled ? 'current' : 'NOT current'} after ${ms} ms`,
    )
    summaries.push({
      org: planOrg.org_slug,
      view,
      queries: set.queries.length,
      answer_bytes: bytes,
      settled,
      ms,
    })
    await page.close()
  }
  return summaries
}

/** The recorded sets in <dir>/sets, checked, by view in VIEWS' order. */
function readSets(options, planOrg = { k: 0 }) {
  const dir = setsDir(options, planOrg)
  if (!existsSync(dir)) throw new Error(`${dir} is missing. Run the record part first.`)
  const sets = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => checkSet(JSON.parse(readFileSync(join(dir, name), 'utf8'))))
  return sets.sort((a, b) => VIEWS.indexOf(a.view) - VIEWS.indexOf(b.view))
}

/* ----------------------------------------------------------------- client */

/** One replayed client: a ConvexClient over a socket whose frames feed a
    tracker, acting as `person`, subscribed to `queries`, and leading its
    alerts with the app's own alert client when `alerts` (loadAppAlerts')
    is given. The alerts start once the root part has answered, as the
    store starts them at the boot that found a seat
    (src/store/planner.ts startAlerts). `onAnswer` hears each answer. */
function replayClient({ url, adminKey, person, queries, alerts, index, onAnswer }) {
  let stopAlerts = null
  const tracker = new FrameTracker({
    onAnswer: (udfPath, ...rest) => {
      if (alerts && stopAlerts === null && udfPath === 'workspace:root') startAlerts()
      onAnswer(udfPath, ...rest)
    },
  })
  const sockets = new Set()
  const Native = globalThis.WebSocket
  class Tracked extends Native {
    constructor(address) {
      super(address)
      sockets.add(this)
      this.addEventListener('open', () => {
        client.openedAt = Date.now()
      })
      this.addEventListener('message', (event) => {
        if (typeof event.data === 'string') tracker.received(event.data)
      })
      this.addEventListener('close', (event) => {
        sockets.delete(this)
        tracker.closed(event.code, event.reason, this.droppedByTest === true)
      })
    }
    send(data) {
      if (typeof data === 'string') tracker.sent(data)
      super.send(data)
    }
  }
  const convex = new ConvexClient(url, {
    webSocketConstructor: Tracked,
    skipConvexDeploymentUrlCheck: true,
    unsavedChangesWarning: false,
    logger: false,
  })
  convex.setAdminAuth(adminKey, identityOf(person))
  const client = { tracker, convex, sockets, person, openedAt: null }
  // a leader's own reads are the alert client's, which subscribes them itself
  for (const query of alerts ? withoutLeaderReads(queries) : queries)
    convex.client.subscribe(
      query.udfPath,
      jsonToConvex(query.args),
      query.componentPath ? { componentPath: query.componentPath } : undefined,
    )
  const startAlerts = () => {
    stopAlerts = leadAlerts({
      convex,
      connection: () => tracker.connects,
      app: alerts,
      name: `qivo-notifications:load:${index}`,
    })
  }
  /** Closes every open socket of the client, as a network drop does. */
  client.drop = () => {
    for (const socket of sockets) {
      socket.droppedByTest = true
      socket.close()
    }
  }
  client.close = async () => {
    stopAlerts?.()
    await convex.close()
  }
  return client
}

/** Whether replayed `client` is current: connected more than `connects`
    times and every query of its newest set answered, and for a leader its
    Inbox feed answered too, since a leader watches the feed only after its
    first beat answers, as a tab does, and after a reconnect only after its
    resume order. The replay's clients and the lone reconnect read it
    alike. */
const isCurrent = (client, connects) =>
  client.tracker.connects > connects &&
  client.tracker.current &&
  (!client.lead || client.tracker.holds('inbox:feed'))

/** The p50, p99 and maximum of event loop delay histogram `delay`
    (monitorEventLoopDelay's, at 10 ms resolution) as milliseconds past
    that resolution, to a hundredth: the lag beyond the sampler's own
    timer. */
function lagOf(delay) {
  const past = (nanoseconds) => Math.max(0, Math.round((nanoseconds / 1e6 - 10) * 100) / 100)
  return { p50: past(delay.percentile(50)), p99: past(delay.percentile(99)), max: past(delay.max) }
}

/* ----------------------------------------------------------------- worker */

/** A worker process: runs its share of the clients and answers the
    coordinator's commands over IPC (start, phase, change, reconnect,
    report, stop). */
async function runWorker() {
  let config = null
  // the app's alert client, which the clients that lead run
  let alerts = null
  const clients = []
  const delay = monitorEventLoopDelay({ resolution: 10 })
  delay.enable()
  let phase = null
  let change = null
  let inFlightMost = 0
  const fresh = () => ({
    bytesStart: new Map(),
    answers: new Map(),
    changes: new Map(),
    // the answers of the clients marked `watch` (one login's tab in each of
    // its organizations), by client and function
    watched: new Map(),
  })
  let figures = fresh()
  const sampler = setInterval(() => {
    let now = 0
    for (const client of clients) now += client.tracker.pending.size + client.tracker.waiting
    inFlightMost = Math.max(inFlightMost, now)
  }, 100)
  sampler.unref()
  const onAnswer = (index, watch) => (udfPath, bytes) => {
    const entry = figures.answers.get(udfPath) ?? { updates: 0, bytes: 0 }
    entry.updates++
    entry.bytes += bytes
    figures.answers.set(udfPath, entry)
    if (watch) {
      const key = `${watch}\u0000${udfPath}`
      const seen = figures.watched.get(key) ?? { updates: 0, bytes: 0 }
      seen.updates++
      seen.bytes += bytes
      figures.watched.set(key, seen)
    }
    if (change !== null) {
      const slot = figures.changes.get(change) ?? { perClient: new Map(), queries: new Map() }
      slot.perClient.set(index, (slot.perClient.get(index) ?? 0) + bytes)
      const query = slot.queries.get(udfPath) ?? { updates: 0, bytes: 0 }
      query.updates++
      query.bytes += bytes
      slot.queries.set(udfPath, query)
      figures.changes.set(change, slot)
    }
  }
  /** Waits until every client is current, counting a client only once it
      connected more than `connects(client)` times, then answers each one's
      time to current, to the moment its set became current (FrameTracker
      currentSince), from `from` and from its socket's open. */
  const allCurrent = async (from, connects = () => 0) => {
    const deadline = Date.now() + config.timeoutMs
    const results = new Map()
    while (results.size < clients.length && Date.now() < deadline) {
      for (const client of clients) {
        if (results.has(client.index) || !isCurrent(client, connects(client))) continue
        const since = client.tracker.currentSince
        results.set(client.index, {
          index: client.index,
          // the queries the client's newest set holds, sent again after a reconnect
          queries: client.tracker.queries.size,
          ms: since - from,
          from_open_ms: client.openedAt ? since - client.openedAt : null,
          current: true,
          first_answers: client.tracker.firstAnswers(),
        })
      }
      await sleep(20)
    }
    return clients.map(
      (client) =>
        results.get(client.index) ?? {
          index: client.index,
          ms: null,
          from_open_ms: null,
          current: false,
        },
    )
  }
  const report = () => {
    // the server's or the network's closes by code, and the benchmark's own drops
    const closes = {}
    let dropped = 0
    for (const client of clients)
      for (const close of client.tracker.closes.slice(client.closesSeen ?? 0)) {
        if (close.by_client) dropped++
        else closes[String(close.code)] = (closes[String(close.code)] ?? 0) + 1
      }
    const perClient = clients.map((client) => ({
      index: client.index,
      bytes: client.tracker.bytesReceived - (figures.bytesStart.get(client.index) ?? 0),
    }))
    const calls = mergeCalls(clients.map((client) => Object.fromEntries(client.tracker.calls)))
    return {
      phase,
      pid: process.pid,
      clients: clients.length,
      per_client_bytes: perClient,
      answers: Object.fromEntries(figures.answers),
      changes: [...figures.changes.entries()].map(([id, slot]) => ({
        id,
        per_client: Object.fromEntries(slot.perClient),
        queries: Object.fromEntries(slot.queries),
      })),
      calls,
      closes,
      dropped,
      watched: [...figures.watched.entries()].map(([key, seen]) => {
        const [client, udfPath] = key.split('\u0000')
        return { client, udfPath, ...seen }
      }),
      in_flight_most: inFlightMost,
      event_loop_lag_ms: lagOf(delay),
    }
  }
  const mark = (name) => {
    phase = name
    change = null
    figures = fresh()
    inFlightMost = 0
    delay.reset()
    for (const client of clients) {
      figures.bytesStart.set(client.index, client.tracker.bytesReceived)
      client.tracker.calls.clear()
      client.closesSeen = client.tracker.closes.length
    }
  }
  // a coordinator that stopped takes its workers with it
  process.on('disconnect', () => process.exit(0))
  process.on('message', async (message) => {
    try {
      if (message.type === 'init') {
        config = message.config
        alerts = await loadAppAlerts(ROOT)
        process.send({ type: 'ready' })
      } else if (message.type === 'start') {
        mark('startup')
        const from = Date.now()
        for (const spec of message.clients) {
          const client = replayClient({
            ...config,
            ...spec,
            alerts: spec.lead ? alerts : null,
            onAnswer: onAnswer(spec.index, spec.watch ?? null),
          })
          client.index = spec.index
          client.view = spec.view
          client.lead = spec.lead
          clients.push(client)
        }
        const results = await allCurrent(from)
        process.send({
          type: 'started',
          results: results.map((result) => {
            const client = clients.find((each) => each.index === result.index)
            return { ...result, view: client.view, set: client.tracker.set() }
          }),
        })
      } else if (message.type === 'phase') {
        mark(message.name)
        process.send({ type: 'marked' })
      } else if (message.type === 'change') {
        change = message.id
        process.send({ type: 'changed' })
      } else if (message.type === 'reconnect') {
        const at = Date.now()
        const before = new Map(clients.map((client) => [client, client.tracker.connects]))
        for (const client of clients) client.drop()
        const results = await allCurrent(at, (client) => before.get(client))
        process.send({ type: 'reconnected', results })
      } else if (message.type === 'report') {
        process.send({ type: 'report', report: report() })
      } else if (message.type === 'stop') {
        await Promise.all(clients.map((client) => client.close().catch(() => {})))
        process.exit(0)
      }
    } catch (error) {
      process.send({ type: 'error', message: String(error?.stack ?? error) })
    }
  })
}

/** The coordinator's handle on one worker process: `ask(message, answer)`
    sends a command and resolves with the reply of type `answer`, or
    rejects when the worker reports an error, exits or cannot be sent to,
    so a phase records `failed` rather than waiting forever, and `stop()`
    asks the worker to close its clients and kills it when it has not
    exited within `STOP_MS`. */
function startWorker() {
  const child = fork(fileURLToPath(import.meta.url), ['--worker'], { stdio: 'inherit' })
  const waiting = []
  // why the worker can answer no more, once it exited
  let gone = null
  const failAll = (error) => {
    for (const wait of waiting.splice(0)) wait.fail(error)
  }
  child.on('message', (message) => {
    if (message.type === 'error') {
      console.error(`worker ${child.pid}: ${message.message}`)
      failAll(new Error(`worker ${child.pid} failed: ${message.message.split('\n')[0]}`))
      return
    }
    const at = waiting.findIndex((wait) => wait.type === message.type)
    if (at >= 0) waiting.splice(at, 1)[0].done(message)
  })
  child.on('error', (error) => failAll(error))
  const exited = new Promise((done) =>
    child.once('exit', (code, signal) => {
      gone = new Error(`worker ${child.pid} exited (${signal ?? code})`)
      failAll(gone)
      done()
    }),
  )
  return {
    child,
    ask(message, type) {
      return new Promise((done, fail) => {
        if (gone) return fail(gone)
        waiting.push({ type, done, fail })
        child.send(message, (error) => {
          if (error) failAll(error)
        })
      })
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null && child.connected)
        child.send({ type: 'stop' })
      const gone = await Promise.race([exited.then(() => true), sleep(STOP_MS).then(() => false)])
      if (!gone) child.kill('SIGKILL')
    },
  }
}

/* --------------------------------------------------------------- function log */

/** Follows the local backend's function log stream and keeps every
    completion (report.mjs logEntry), until stopped. */
function followLog(options) {
  const entries = []
  // when each read of the stream failed, so a phase can say its log may miss entries
  const failures = []
  let stopped = false
  let pages = 0
  // ends a read still waiting at the stop
  const abort = new AbortController()
  const read = async (cursor) => {
    const response = await fetch(`${options.url}/api/stream_function_logs?cursor=${cursor}`, {
      headers: { Authorization: `Convex ${options.adminKey}` },
      signal: abort.signal,
    })
    if (!response.ok) throw new Error(`the function log answered ${response.status}`)
    return await response.json()
  }
  const done = (async () => {
    // the stream's end when it starts, so earlier entries stay out
    let cursor = null
    while (!stopped) {
      try {
        if (cursor === null) {
          cursor = (await read(0)).newCursor
          continue
        }
        const page = await read(cursor)
        pages++
        cursor = page.newCursor
        for (const raw of page.entries) {
          const entry = logEntry(raw)
          if (entry) entries.push(entry)
        }
      } catch {
        if (!stopped) failures.push(Date.now())
        await sleep(500)
      }
    }
  })()
  return {
    entries,
    /** The entries whose call started between `from` and `to`. */
    between: (from, to) => entries.filter((entry) => entry.start >= from && entry.start < to),
    /** How many reads of the stream failed between `from` and `to`. */
    failuresBetween: (from, to) => failures.filter((at) => at >= from && at < to).length,
    get pages() {
      return pages
    },
    async stop() {
      stopped = true
      await Promise.race([done.catch(() => {}), sleep(2000)])
      abort.abort()
    },
  }
}

/** /proc/stat's counters, or null where the machine has none. */
function cpuNow() {
  try {
    return cpuCounters(readFileSync('/proc/stat', 'utf8'))
  } catch {
    return null
  }
}

/* ----------------------------------------------------------------- replay */

/** The busy loops of the busy phase: `count` processes that spin, each
    pinned to `cpus` (taskset) when given. Answers a stop. */
function busyLoops(count, cpus) {
  const loops = Array.from({ length: count }, () =>
    cpus
      ? spawn('taskset', ['-c', cpus, process.execPath, '-e', 'for(;;){}'], { stdio: 'ignore' })
      : spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }),
  )
  const stop = () => {
    for (const loop of loops) loop.kill('SIGKILL')
  }
  // a run that ends early takes its loops with it
  process.once('exit', stop)
  return { pids: loops.map((loop) => loop.pid), stop }
}

/** The replay part: the phases of `options.phases` against the recorded
    sets, written as one rung. */
async function replay(options) {
  const plan = readPlan(options)
  const orgs = orgsOf(plan)
  if (orgs.length < options.orgs)
    throw new Error(
      `people.json holds ${orgs.length} organizations, fewer than --orgs ${options.orgs}`,
    )
  const orgSets = orgs.slice(0, options.orgs).map((planOrg) => readSets(options, planOrg))
  checkSetsDay(orgSets.flat())
  const sets = orgSets[0]
  const byView = new Map(sets.map((set) => [set.view, set]))
  const people = orgs.slice(0, options.orgs).reduce((all, one) => all + one.people.length, 0)
  if (people < options.clients)
    throw new Error(`people.json holds ${people} people, fewer than --clients ${options.clients}`)
  // what each client replays, refused before anything starts when a client
  // would read another organization's ids
  const specs = checkSpecs(clientSpecs(options, plan, orgSets), orgs.slice(0, options.orgs))
  const log = followLog(options)
  // the coordinator's own event loop, which follows the log and writes
  const delay = monitorEventLoopDelay({ resolution: 10 })
  delay.enable()
  await sleep(1000)
  const phases = {}
  const notRun = {}
  let match = null
  let lone = null
  const workers = []
  let hidden = null
  /** Runs `body` as phase `name`, with the log, steal and the workers'
      figures over it. A worker that failed or exited leaves its figures
      out, and the phase says so in `workers_lost` and `failed`. */
  const timed = async (name, body) => {
    say(`phase ${name}`)
    const cpu = cpuNow()
    const from = Date.now()
    delay.reset()
    const lost = new Set()
    const marked = await Promise.allSettled(
      workers.map((worker) => worker.ask({ type: 'phase', name }, 'marked')),
    )
    // a phase whose own work fails keeps the figures it reached and says why,
    // so a saturated backend's refusal does not lose the rung's other phases
    let extra
    try {
      const failedMark = marked.find((answer) => answer.status === 'rejected')
      if (failedMark) throw failedMark.reason
      extra = (await body()) ?? {}
    } catch (error) {
      extra = { failed: String(error?.message ?? error).slice(0, 300) }
      say(`phase ${name} failed: ${extra.failed}`)
    }
    // the log's entries trail their calls
    await sleep(1500)
    const to = Date.now()
    const answers = await Promise.allSettled(
      workers.map((worker) => worker.ask({ type: 'report' }, 'report')),
    )
    answers.forEach((answer, k) => {
      if (answer.status === 'rejected') lost.add(workers[k].child.pid)
    })
    for (const [k, answer] of marked.entries())
      if (answer.status === 'rejected') lost.add(workers[k].child.pid)
    if (lost.size > 0) {
      extra.workers_lost = [...lost]
      extra.failed ??= `${lost.size} of ${workers.length} worker processes failed or exited; their clients' figures are missing`
    }
    const reports = answers
      .filter((answer) => answer.status === 'fulfilled')
      .map((answer) => answer.value.report)
    const figures = phaseFigures(log.between(from, to), (to - from) / 1000, reports, {
      log_read_failures: log.failuresBetween(from, to),
      steal: cpuShare(cpu, cpuNow()),
      started_at: new Date(from).toISOString(),
      ended_at: new Date(to).toISOString(),
      coordinator_event_loop_lag_ms: lagOf(delay),
      ...extra,
    })
    if (Array.isArray(figures.changes)) attachResends(figures, options.clients)
    delete figures._changes
    phases[name] = figures
    say(
      `phase ${name} done: ${Math.round((to - from) / 1000)} s, steal ${figures.steal?.steal_pct ?? '?'}%, slowest JS ${Math.max(0, ...Object.values(figures.functions).map((one) => one.js_ms.max ?? 0))} ms`,
    )
  }
  try {
    if (options.phases.includes('match')) {
      say('phase match')
      match = await matchSets(options, plan, sets)
      lone = match.lone_reconnect_ms
    }
    for (let k = 0; k < options.processes; k++) {
      const worker = startWorker()
      await worker.ask(
        {
          type: 'init',
          config: { url: options.url, adminKey: options.adminKey, timeoutMs: options.timeoutMs },
        },
        'ready',
      )
      workers.push(worker)
    }
    // startup always runs, since every later phase needs the clients
    await sleep(3000)
    await timed('startup', async () => {
      const started = await Promise.all(
        workers.map((worker, k) =>
          worker.ask(
            {
              type: 'start',
              clients: specs.filter((spec) => spec.index % workers.length === k),
            },
            'started',
          ),
        ),
      )
      const results = started.flatMap((answer) => answer.results).sort((a, b) => a.index - b.index)
      return {
        clients: options.clients,
        // every client subscribed its whole set at once, from cold
        asked_at_once: results.reduce((all, result) => all + result.set.length, 0),
        current: results.filter((result) => result.current).length,
        time_to_current_ms: spread(results.map((result) => result.ms)),
        client_first_answer_ms: firstAnswerStats(
          results.flatMap((result) => result.first_answers ?? []),
        ),
        against_recorded: results.map((result) => {
          const spec = specs[result.index]
          const compared = compareSets(spec.queries, result.set)
          return {
            index: result.index,
            org: spec.org,
            person: spec.person.key,
            view: spec.view,
            lead: spec.lead,
            ms: result.ms,
            queries: result.set.length,
            same_queries: compared.missing.length === 0 && compared.extra.length === 0,
            missing: compared.missing,
            extra: compared.extra,
            failed: result.set.filter((query) => query.error).map((query) => query.udfPath),
            answer_bytes: result.set.reduce((all, query) => all + (query.bytes ?? 0), 0),
            recorded_answer_bytes: spec.recorded_answer_bytes,
          }
        }),
      }
    })
    const changes = () => runChanges(options, plan, byView.get('board'), workers, log)
    for (const name of options.phases) {
      if (name === 'match' || name === 'startup') continue
      if (name === 'changes') await timed('changes', changes)
      else if (name === 'busy')
        await timed('busy', async () => {
          const loops = busyLoops(options.busyLoops, options.busyCpus)
          try {
            // the loops take their CPUs before the first change
            await sleep(3000)
            return {
              busy_loops: { count: options.busyLoops, cpus: options.busyCpus, pids: loops.pids },
              ...(await changes()),
            }
          } finally {
            loops.stop()
          }
        })
      else if (name === 'idle')
        await timed('idle', async () => {
          await sleep(options.idleSeconds * 1000)
          // the asked seconds apart: the rates divide by the measured
          // window, over which the bytes, answers and log were counted
          return { seconds_asked: options.idleSeconds }
        })
      else if (name === 'reconnect') {
        if (!options.noHiddenTab) {
          try {
            hidden = await hiddenTab(options, byView.get('board')?.url ?? viewUrls(plan).board)
          } catch (error) {
            notRun.hidden_tab = `could not open the hidden tab: ${String(error?.message ?? error).slice(0, 200)}`
          }
        }
        await timed('reconnect', async () => {
          const at = Date.now()
          const [answers, tab] = await Promise.all([
            Promise.all(workers.map((worker) => worker.ask({ type: 'reconnect' }, 'reconnected'))),
            hidden ? hidden.reconnect() : null,
          ])
          const results = answers.flatMap((answer) => answer.results)
          const resubscribed = results.reduce((all, result) => all + (result.queries ?? 0), 0)
          const slowest = Math.max(
            0,
            ...results.map((result) => result.ms ?? Number.POSITIVE_INFINITY),
          )
          return {
            closed_at: at,
            resubscriptions: resubscribed,
            asked_at_once: resubscribed,
            current: results.filter((result) => result.current).length,
            time_to_current_ms: spread(results.map((result) => result.ms)),
            from_open_ms: spread(results.map((result) => result.from_open_ms)),
            client_first_answer_ms: firstAnswerStats(
              results.flatMap((result) => result.first_answers ?? []),
            ),
            by_view: Object.fromEntries(
              [...new Set(specs.map((spec) => spec.view))].map((view) => [
                view,
                spread(
                  results
                    .filter((result) => specs[result.index].view === view)
                    .map((result) => result.ms),
                ),
              ]),
            ),
            lone_client_ms: lone,
            slow_clients: lone
              ? results.filter((result) => result.ms === null || result.ms > 10 * lone).length
              : null,
            slowest_ms: Number.isFinite(slowest) ? slowest : null,
            hidden_tab: tab,
          }
        })
        await hidden?.close().catch(() => {})
        hidden = null
      }
    }
    for (const name of ['changes', 'reconnect', 'idle', 'busy'])
      if (!options.phases.includes(name)) notRun[name] = 'not asked (--phases)'
  } finally {
    await hidden?.close().catch(() => {})
    await Promise.all(workers.map((worker) => worker.stop()))
    await log.stop()
  }
  const idle = phases.idle
  if (idle) {
    // the functions a session subscribes or calls; the rest are the backend's own jobs
    const own = new Set(orgSets.flat().flatMap((set) => set.queries.map((query) => query.udfPath)))
    for (const name of Object.keys(idle.client_calls)) own.add(name)
    idle.per_session_minute = perSessionMinute(idle, options.clients, idle.seconds, own)
    idle.shares = idleShares(idle, {
      sessions: options.clients,
      leaders: specs.filter((spec) => spec.lead).length,
      seconds: idle.seconds,
    })
    idle.watched_per_minute = watchedPerMinute(idle.watched, idle.seconds)
  }
  const output = rungReport({
    rung: {
      clients: options.clients,
      processes: options.processes,
      orgs: options.orgs,
      views: sets.map((set) => set.view),
      browser: sets[0]?.browser,
      people: people,
      profiles: orgs
        .slice(0, options.orgs)
        .map((one) => ({ org: one.org_slug, profiles: one.profiles })),
      teams: plan.teams.length,
      backend: options.url,
      commit: process.env.QIVO_LOAD_COMMIT ?? null,
      host_cpus: cpus().length,
      at: new Date().toISOString(),
      log_pages: log.pages,
      clients_by_org: Object.fromEntries(
        orgs
          .slice(0, options.orgs)
          .map((one) => [one.org_slug, specs.filter((spec) => spec.org === one.org_slug).length]),
      ),
    },
    recorded: orgSets.flat().map((set) => ({
      org: set.org_slug ?? plan.org_slug,
      view: set.view,
      url: set.url,
      queries: set.queries.length,
      answer_bytes: set.queries.reduce((all, query) => all + (query.bytes ?? 0), 0),
      functions: [...new Set(set.queries.map((query) => query.udfPath))],
      calls: set.calls,
      settled: set.settled,
    })),
    match,
    phases,
    subscriptions: {
      login: plan.people[0].key,
      org_names: Object.fromEntries(orgs.map((one) => [one.org_id, one.org_slug])),
      // by the organization the tab showed, then by the organization each
      // query names, by its org_id or by the ids of people.json it holds
      by_organization: Object.fromEntries(
        orgSets.map((orgSet, k) => [
          orgs[k].org_slug,
          subscriptionsByOrganization(
            orgSet,
            new Map(orgs.flatMap((one) => [...idsOfOrg(one)].map((id) => [id, one.org_id]))),
          ),
        ]),
      ),
    },
    notRun,
  })
  output.pacing_trigger = pacingTrigger(phases)
  const file = options.output ?? join(options.dir, 'out', `rung-${options.clients}.json`)
  mkdirSync(resolve(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`)
  say(`wrote ${file}`)
  return output
}

/** The match phase: each recorded set replayed by one client as the
    recorder, compared with the tab, then a reconnect of the lone Board
    client timed (loneReconnect). Runs in this process, before any load. */
async function matchSets(options, plan, sets) {
  const recorder = plan.people[0]
  const views = []
  for (const set of sets) {
    const client = replayClient({
      url: options.url,
      adminKey: options.adminKey,
      person: recorder,
      queries: set.queries,
      alerts: null,
      index: 900 + views.length,
      onAnswer: () => {},
    })
    const started = Date.now()
    const { settled, ms } = await settle(
      client.tracker,
      options.quietMs,
      options.timeoutMs,
      started,
    )
    const compared = compareSets(set.queries, client.tracker.set())
    views.push({
      view: set.view,
      settled,
      ms_to_quiet: ms,
      queries: set.queries.length,
      ...compared,
    })
    await client.close()
  }
  const board = sets.find((set) => set.view === 'board')
  return {
    matched: views.every((view) => view.matched),
    views,
    lone_reconnect_ms: board ? await loneReconnect(options, recorder, board) : null,
  }
}

/** The reconnect trigger's base: one client alone as `recorder` on
    recorded Board `set`, leading its alerts with the app's alert client
    where the set holds the Inbox feed, as the replay's own clients of that
    set do, so its reconnect runs the same resume order (a beat, the
    summary, then the feed) before it counts as current (isCurrent). It
    reconnects once current and quiet for --quiet-ms. Answers the
    milliseconds from the close until it is current again, or null. */
async function loneReconnect(options, recorder, set) {
  const lead = set.queries.some((query) => query.udfPath === 'inbox:feed')
  const client = replayClient({
    url: options.url,
    adminKey: options.adminKey,
    person: recorder,
    queries: set.queries,
    alerts: lead ? await loadAppAlerts(ROOT) : null,
    index: 899,
    onAnswer: () => {},
  })
  client.lead = lead
  try {
    const started = Date.now()
    while (!isCurrent(client, 0) && Date.now() - started < options.timeoutMs) await sleep(20)
    if (!isCurrent(client, 0)) return null
    // the leader's first claims done, as a replayed client's are by the reconnect
    await settle(client.tracker, options.quietMs, options.timeoutMs)
    const connects = client.tracker.connects
    const at = Date.now()
    client.drop()
    while (!isCurrent(client, connects) && Date.now() - at < options.timeoutMs) await sleep(10)
    return isCurrent(client, connects) ? client.tracker.currentSince - at : null
  } finally {
    await client.close()
  }
}

/** The changes phase: `options.changes` changes as Nora, one a second, on
    the recorded Board's tasks, in turn a rename, a move to a sibling
    sub-project (and back the next time), a status change and a comment.
    Answers each change with the log's reruns and the clients' re-sends. */
async function runChanges(options, plan, boardSet, workers, log) {
  if (!boardSet) throw new Error('the changes phase needs the recorded Board set')
  const nora = plan.people[0]
  const writer = httpClient(options, nora)
  const boardQuery = boardSet.queries.find((query) => query.udfPath === 'tasks:board')
  if (!boardQuery) throw new Error('the recorded Board set holds no tasks:board query')
  const answer = await retry(() => writer.query(ref('tasks:board'), jsonToConvex(boardQuery.args)))
  if (answer.state !== 'ok') throw new Error(`the recorded Board answered ${answer.state}`)
  // tasks of their own, neither a group (status follows its subtasks) nor a subtask
  const open = answer.rows.filter(
    (task) => task.status !== 'done' && !task.has_subtasks && !task.parent_id,
  )
  if (open.length < 2) throw new Error('the recorded Board shows fewer than 2 open tasks to change')
  const org = plan.org_id
  const [renamed] = open
  const { task: moved, home, sibling } = await movableTask(writer, plan, open.slice(1))
  // the comments go to other tasks in turn, enough that the comment rule
  // refuses none (changes.mjs commentTargets)
  const commented = commentTargets(open.filter((task) => task !== renamed && task !== moved))
  const original = { title: renamed.title, status: renamed.status }
  let away = false
  let status = original.status
  let commentsMade = 0
  // the comments posted, which the cleanup removes
  const comments = []
  const done = []
  const begin = Date.now()
  for (let i = 0; i < options.changes; i++) {
    const kind = CHANGE_KINDS[i % CHANGE_KINDS.length]
    const slot = begin + i * 1000
    await sleep(Math.max(0, slot - Date.now()))
    // a worker that failed leaves its clients' re-sends out (the phase's
    // workers_lost), but never stops the changes or the cleanup after them
    await Promise.allSettled(
      workers.map((worker) => worker.ask({ type: 'change', id: i }, 'changed')),
    )
    const at = Date.now()
    let call
    if (kind === 'rename')
      call = [
        'issues:update',
        { org_id: org, id: renamed.id, patch: { title: `${original.title} (${i})`.slice(0, 200) } },
      ]
    else if (kind === 'move') {
      call = ['issues:move', { org_id: org, id: moved.id, project_id: away ? home : sibling.id }]
      away = !away
    } else if (kind === 'status') {
      // between two open statuses, so no project's open or Done count moves
      status = status === 'progress' ? 'todo' : 'progress'
      call = ['issues:update', { org_id: org, id: renamed.id, patch: { status } }]
    } else {
      const id = crypto.randomUUID()
      const target = commented[commentsMade++ % commented.length]
      call = [
        'comments:create',
        {
          org_id: org,
          id,
          issue_id: target.id,
          body: 'Checked the readings against the bench log; the drift stays inside the calibration window.',
        },
      ]
    }
    let error = null
    try {
      await retry(() => writer.mutation(ref(call[0]), call[1]))
      if (kind === 'comment') comments.push(call[1].id)
    } catch (failure) {
      error = String(failure?.message ?? failure).slice(0, 200)
    }
    done.push({ id: i, kind, fn: call[0], at, client_ms: Date.now() - at, error })
  }
  await sleep(1500)
  // what the clients receive from here on is no change's
  await Promise.allSettled(
    workers.map((worker) => worker.ask({ type: 'change', id: null }, 'changed')),
  )
  // the rename, the status and the move are put back
  const restored = []
  const restore = (name, args) =>
    retry(() => writer.mutation(ref(name), args)).then(
      () => restored.push(name),
      (error) => restored.push(`${name} failed: ${String(error?.message ?? error).slice(0, 120)}`),
    )
  await restore('issues:update', { org_id: org, id: renamed.id, patch: { title: original.title } })
  if (status !== original.status)
    await restore('issues:update', {
      org_id: org,
      id: renamed.id,
      patch: { status: original.status },
    })
  if (away) await restore('issues:move', { org_id: org, id: moved.id, project_id: home })
  for (const id of comments) await restore('comments:remove', { org_id: org, id })
  // the writer's calls that succeeded, each run once at least, which the
  // phase's log coverage counts beside the clients' own
  const writerCalls = {}
  for (const name of [
    ...done.filter((change) => change.error === null).map((change) => change.fn),
    ...restored.filter((name) => !name.includes(' failed')),
  ])
    writerCalls[name] = (writerCalls[name] ?? 0) + 1
  return {
    writer_calls: writerCalls,
    tasks: {
      renamed: renamed.id,
      moved: moved.id,
      sibling: sibling.id,
      commented: commented.map((task) => task.id),
    },
    comments: {
      made: commentsMade,
      posted: comments.length,
      failed: commentsMade - comments.length,
    },
    restored,
    changes: done.map((change, i) => {
      const until = done[i + 1]?.at ?? change.at + 1000
      const entries = log.between(change.at - 50, until)
      const own = entries.find((entry) => entry.fn === change.fn && !entry.nested)
      const reran = functionStats(
        entries.filter((entry) => entry.kind === 'Query'),
        (until - change.at) / 1000,
      )
      // a change the log holds no entry of is one whose reruns it may have
      // dropped too, so its reruns are unknown rather than none
      const missed = change.error === null && !own
      return {
        ...change,
        js_ms: own?.js_ms ?? null,
        log_missed: missed,
        reran: missed
          ? null
          : Object.fromEntries(
              Object.entries(reran.functions).map(([name, figures]) => [
                name,
                {
                  executions: figures.executions,
                  cached: figures.cached,
                  js_ms_max: figures.js_ms.max,
                },
              ]),
            ),
      }
    }),
  }
}

/** The first of Board rows `tasks` that the changes phase can move to a
    sibling sub-project and back, as `writer` (Nora) reads them: one whose
    assignee and reviewer, where it has them, the sibling's own picker
    offers (pickers:canOwn on one of the sibling's top-level tasks), since
    a move refuses a holder who cannot hold tasks in the destination
    (convex/model/issues.ts assertAssigneeRule), as a person whose only
    Edit is a team shared with the Board's own sub-project cannot. Answers
    the task, its sub-project and the sibling. Throws when none can. */
async function movableTask(writer, plan, tasks) {
  const org = plan.org_id
  const siblingOf = (home) =>
    plan.projects
      .flatMap((project) =>
        project.children.some((child) => child.id === home) ? project.children : [],
      )
      .find((child) => child.id !== home)
  // a top-level task of each sibling, whose picker judges a holder there
  const probes = new Map()
  const probeOf = async (sibling) => {
    if (!probes.has(sibling.id)) {
      const answer = await retry(() =>
        writer.query(ref('tasks:board'), {
          scope: { kind: 'project', org_id: org, project_id: sibling.id },
          filters: BOARD_FILTERS,
        }),
      )
      probes.set(
        sibling.id,
        answer.state === 'ok' ? (answer.rows.find((row) => !row.parent_id)?.id ?? null) : null,
      )
    }
    return probes.get(sibling.id)
  }
  for (const task of tasks) {
    const sibling = siblingOf(task.project_id)
    if (!sibling) continue
    const holders = [
      ['assignee', task.assignee_id],
      ['reviewer', task.reviewer_id],
    ].filter(([, id]) => typeof id === 'string')
    let fits = true
    for (const [field, id] of holders) {
      const probe = await probeOf(sibling)
      const answer = probe
        ? await retry(() =>
            writer.query(ref('pickers:canOwn'), { org_id: org, issue_id: probe, field, ids: [id] }),
          )
        : null
      if (answer?.state !== 'ready' || answer.rows[0]?.eligible !== true) {
        fits = false
        break
      }
    }
    if (fits) return { task, home: task.project_id, sibling }
  }
  throw new Error(
    "no open task of the recorded Board can move to a sibling sub-project and back: the siblings refuse each one's assignee or reviewer, or the Board's sub-project has no sibling",
  )
}

/** One real tab of the Board at `url` in the browser, hidden, whose
    socket the reconnect phase closes: `reconnect()` closes it and answers
    the check. */
async function hiddenTab(options, url) {
  const { browser, page: signInPage } = await signedIn(options)
  try {
    return await hide(options, url, browser, signInPage)
  } catch (error) {
    await browser.close().catch(() => {})
    throw error
  }
}

/** hiddenTab's Board tab at `url` in `browser`, opened after `signInPage`
    signed in, then hidden. */
async function hide(options, url, browser, signInPage) {
  const context = signInPage.context()
  await signInPage.close()
  const page = await context.newPage()
  const tracker = trackPage(page, options)
  await page.goto(`${options.siteUrl}${url}`, { waitUntil: 'domcontentloaded' })
  const visible = await settle(tracker, options.quietMs, options.timeoutMs)
  const shown = tracker.set().map((query) => query.udfPath)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await sleep(options.quietMs)
  await settle(tracker, options.quietMs, options.timeoutMs)
  const whileHidden = tracker.set().map((query) => query.udfPath)
  return {
    async reconnect() {
      const connects = tracker.connects
      const at = Date.now()
      await page.evaluate((prefix) => {
        // a mark that a reload of the page would lose
        window.__loadMark = true
        // the backend's socket only: the dev server's own socket reloads the page when it drops
        for (const socket of window.__loadSockets)
          if (socket.url.startsWith(prefix) && socket.readyState <= 1) socket.close()
      }, socketPrefix(options))
      while (tracker.connects === connects && Date.now() - at < options.timeoutMs) await sleep(20)
      const after = await settle(tracker, options.quietMs, options.timeoutMs, at)
      const again = tracker.set().map((query) => query.udfPath)
      const state = await page.evaluate(() => ({
        reloaded: window.__loadMark !== true,
        visibility: document.visibilityState,
      }))
      const dropped = shown.filter((name) => !whileHidden.includes(name))
      const resubscribedViewReads = again.filter((name) => dropped.includes(name))
      const newReads = again.filter((name) => !whileHidden.includes(name))
      return {
        view: 'board',
        browser: options.browser,
        visible_settled: visible.settled,
        visible: shown,
        hidden: whileHidden,
        after_reconnect: again,
        reconnected: tracker.connects > connects,
        reloaded: state.reloaded,
        visibility_after: state.visibility,
        settled: after.settled,
        ms_to_current: after.settled ? tracker.currentSince - at : null,
        dropped_on_hiding: dropped,
        resubscribed_view_reads: resubscribedViewReads,
        new_reads: newReads,
        // a tab that never became current again, reloaded or showed itself
        // has not shown what a hidden tab subscribes after a reconnect
        passed:
          tracker.connects > connects &&
          after.settled &&
          !state.reloaded &&
          state.visibility === 'hidden' &&
          resubscribedViewReads.length === 0 &&
          newReads.length === 0,
      }
    },
    close: () => browser.close(),
  }
}

/* ------------------------------------------------------------------- tabs */

/** The tabs part: one person, Nora, with --tabs real tabs open at once in
    one --browser context, tab i on view i modulo --views. Its phases, each
    with the function log's figures and steal over it: startup (every tab
    opened at once; each one's subscriptions, answer bytes and time to
    current), changes (the replay's changes on the recorded Board's tasks,
    with the bytes re-sent to each tab), reconnect (every tab's backend
    socket closed at once; each one's re-subscriptions and time to current,
    from the close and from its new socket) and idle (the bytes, frames and
    answers each tab received, per minute). Writes one rung to --output,
    else <dir>/out/tabs-<tabs>.json. */
async function tabsPart(options) {
  const plan = readPlan(options)
  const sets = readSets(options)
  const boardSet = sets.find((set) => set.view === 'board')
  // each view at the address it was recorded at, so the tabs and the replay
  // show the same Board
  const urls = Object.fromEntries(sets.map((set) => [set.view, set.url]))
  const missing = options.views.filter((view) => !urls[view])
  if (missing.length > 0)
    throw new Error(`no recorded set of ${missing.join(', ')}; record those views first`)
  const { browser, page: signInPage, notifications } = await signedIn(options)
  const context = signInPage.context()
  await signInPage.close()
  const log = followLog(options)
  await sleep(1000)
  let change = null
  const tabs = Array.from({ length: options.tabs }, (_, index) => ({
    index,
    view: options.views[index % options.views.length],
    answers: new Map(),
    perChange: new Map(),
  }))
  for (const tab of tabs) {
    tab.page = await context.newPage()
    tab.tracker = trackPage(tab.page, options, (udfPath, bytes) => {
      const entry = tab.answers.get(udfPath) ?? { updates: 0, bytes: 0 }
      entry.updates++
      entry.bytes += bytes
      tab.answers.set(udfPath, entry)
      if (change === null) return
      const slot = tab.perChange.get(change) ?? { bytes: 0, queries: {} }
      slot.bytes += bytes
      const query = slot.queries[udfPath] ?? { updates: 0, bytes: 0 }
      query.updates++
      query.bytes += bytes
      slot.queries[udfPath] = query
      tab.perChange.set(change, slot)
    })
  }
  const phases = {}
  /** The mutations and actions every tab has had answered so far, by
      function, as mergeCalls gives them. */
  const tabCalls = () => mergeCalls(tabs.map((tab) => Object.fromEntries(tab.tracker.calls)))
  /** Runs `body` as phase `name`, with the log, steal and each tab's bytes. */
  const timed = async (name, body) => {
    say(`phase ${name}`)
    for (const tab of tabs) {
      tab.bytesStart = tab.tracker.bytesReceived
      tab.framesStart = tab.tracker.framesReceived
      tab.answers = new Map()
      tab.perChange = new Map()
    }
    const callsBefore = tabCalls()
    const cpu = cpuNow()
    const from = Date.now()
    let extra
    try {
      extra = (await body()) ?? {}
    } catch (error) {
      extra = { failed: String(error?.message ?? error).slice(0, 300) }
      say(`phase ${name} failed: ${extra.failed}`)
    }
    await sleep(1500)
    const to = Date.now()
    const seconds = (to - from) / 1000
    const stats = functionStats(log.between(from, to), seconds)
    // the calls the tabs had answered in this phase alone
    const calls = Object.fromEntries(
      Object.entries(tabCalls()).map(([fn, done]) => [
        fn,
        { calls: done.calls - (callsBefore[fn]?.calls ?? 0) },
      ]),
    )
    const figures = {
      tabs: tabs.length,
      seconds: Math.round(seconds * 10) / 10,
      ...stats,
      over_line: overLine(stats),
      log_coverage: logCoverage(stats, calls, {
        writerCalls: extra.writer_calls,
        readFailures: log.failuresBetween(from, to),
      }),
      backend_at_once: mostAtOnce(log.between(from, to).filter((entry) => !entry.nested)),
      steal: cpuShare(cpu, cpuNow()),
      per_tab: tabs.map((tab) => ({
        index: tab.index,
        view: tab.view,
        bytes: tab.tracker.bytesReceived - tab.bytesStart,
        frames: tab.tracker.framesReceived - tab.framesStart,
        answers: Object.fromEntries(tab.answers),
      })),
      ...extra,
    }
    figures.noisy = noisyOf(figures.steal)
    phases[name] = figures
    return figures
  }
  /** Each tab's time to current from `from`, once it connected more than
      `connects[i]` times, its queries and its time from its newest socket.
      A real tab subscribes in waves, so a tab counts once it stayed
      current and quiet for 300 ms, and its time is to the moment its set
      became current (FrameTracker currentSince), as a replayed client's
      is. */
  const allTabsCurrent = async (from, connects) => {
    const results = new Map()
    const deadline = from + options.timeoutMs
    while (results.size < tabs.length && Date.now() < deadline) {
      for (const tab of tabs) {
        if (results.has(tab.index) || !tab.tracker.current) continue
        if (tab.tracker.connects <= connects[tab.index]) continue
        if (Date.now() - (tab.tracker.lastFrameAt ?? from) < 300) continue
        const since = tab.tracker.currentSince
        results.set(tab.index, {
          index: tab.index,
          view: tab.view,
          queries: tab.tracker.queries.size,
          ms: since - from,
          from_socket_ms: tab.tracker.openedAt ? since - tab.tracker.openedAt : null,
          current: true,
        })
      }
      await sleep(20)
    }
    return tabs.map(
      (tab) => results.get(tab.index) ?? { index: tab.index, view: tab.view, current: false },
    )
  }
  /** Phase `name` of the tabs part. */
  const run = {
    startup: async () => {
      const from = Date.now()
      await Promise.all(
        tabs.map((tab) =>
          tab.page.goto(`${options.siteUrl}${urls[tab.view]}`, { waitUntil: 'domcontentloaded' }),
        ),
      )
      const results = await allTabsCurrent(
        from,
        tabs.map(() => 0),
      )
      // the sets once every tab has been quiet, as the record part reads them
      await Promise.all(tabs.map((tab) => settle(tab.tracker, options.quietMs, options.timeoutMs)))
      return {
        notifications,
        time_to_current_ms: spread(results.map((result) => result.ms)),
        client_first_answer_ms: firstAnswerStats(tabs.flatMap((tab) => tab.tracker.firstAnswers())),
        subscriptions: tabs.map((tab, i) => {
          const set = tab.tracker.set()
          return {
            index: tab.index,
            view: tab.view,
            url: urls[tab.view],
            current: results[i].current,
            ms_to_current: results[i].ms ?? null,
            queries: set.length,
            answer_bytes: set.reduce((all, query) => all + (query.bytes ?? 0), 0),
            functions: set.map((query) => query.udfPath),
            leads_alerts: set.some((query) => query.udfPath === 'inbox:feed'),
            calls: Object.fromEntries(
              [...tab.tracker.calls.entries()].map(([name, done]) => [name, done.calls]),
            ),
          }
        }),
        queries_all_tabs: tabs.reduce((all, tab) => all + tab.tracker.queries.size, 0),
      }
    },
    idle: async () => {
      await sleep(options.idleSeconds * 1000)
      return { seconds_asked: options.idleSeconds }
    },
    // the replay's changes, with this process's tabs in place of the workers
    changes: () =>
      runChanges(options, plan, boardSet, [{ ask: async (message) => (change = message.id) }], log),
    reconnect: async () => {
      const connects = tabs.map((tab) => tab.tracker.connects)
      const at = Date.now()
      await Promise.all(
        tabs.map((tab) =>
          tab.page.evaluate((prefix) => {
            window.__loadMark = true
            for (const socket of window.__loadSockets)
              if (socket.url.startsWith(prefix) && socket.readyState <= 1) socket.close()
          }, socketPrefix(options)),
        ),
      )
      const results = await allTabsCurrent(at, connects)
      const reloaded = await Promise.all(
        tabs.map((tab) => tab.page.evaluate(() => window.__loadMark !== true)),
      )
      return {
        closed_at: at,
        resubscriptions: results.reduce((all, result) => all + (result.queries ?? 0), 0),
        current: results.filter((result) => result.current).length,
        time_to_current_ms: spread(results.map((result) => result.ms)),
        from_socket_ms: spread(results.map((result) => result.from_socket_ms)),
        client_first_answer_ms: firstAnswerStats(tabs.flatMap((tab) => tab.tracker.firstAnswers())),
        per_tab: results.map((result, i) => ({ ...result, reloaded: reloaded[i] })),
      }
    },
  }
  try {
    // startup opens the tabs, so it runs first whatever --phases says
    await timed('startup', run.startup)
    for (const name of options.phases) {
      if (name === 'startup') continue
      const figures = await timed(name, run[name])
      if (name === 'idle') Object.assign(figures, tabsIdlePerMinute(figures))
      if (name === 'changes') {
        Object.assign(figures, tabResends(figures.changes ?? [], tabs))
        change = null
      }
    }
  } finally {
    await browser.close().catch(() => {})
    await log.stop()
  }
  const output = {
    format: 'qivo-load-tabs/1',
    rung: {
      tabs: options.tabs,
      views: tabs.map((tab) => tab.view),
      browser: options.browser,
      person: plan.people[0].key,
      profiles: plan.profiles,
      teams: plan.teams.length,
      backend: options.url,
      commit: process.env.QIVO_LOAD_COMMIT ?? null,
      host_cpus: cpus().length,
      at: new Date().toISOString(),
      log_pages: log.pages,
    },
    sources: {
      functions:
        "The local backend's function log stream: per top-level call, JavaScript (userExecutionTime) and total time. log_coverage compares the mutations and actions the tabs and the changes' writer sent with the log: complete, lower_bounds or unknown.",
      bytes:
        "Each tab's received WebSocket frames from Playwright, pings included: an answer's bytes are its value's JSON length, a tab's bytes every frame's UTF-8 length.",
      time_to_current:
        "From the phase start (startup) or the close (reconnect) to the moment the tab's newest query set became current, counted once it stayed current and quiet for 300 ms, the moment a replayed client's time is to; from_socket_ms from the tab making its new backend socket.",
      steal: '/proc/stat over the phase.',
    },
    phases,
  }
  const file = options.output ?? join(options.dir, 'out', `tabs-${options.tabs}.json`)
  mkdirSync(resolve(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`)
  say(`wrote ${file}`)
  return output
}

/* ------------------------------------------------------------------- main */

async function main() {
  let options
  try {
    options = loadOptions(process.argv.slice(2), process.env)
  } catch (error) {
    if (error instanceof OptionsError) {
      console.error(`${error.message}\nnode scripts/benchmark-load.mjs --help lists the options.`)
      process.exit(2)
    }
    throw error
  }
  if (options.help) {
    console.log(usage())
    process.exit(0)
  }
  for (const part of options.parts) {
    if (part === 'setup') await setup(options)
    else if (part === 'record') await record(options)
    else if (part === 'tabs') await tabsPart(options)
    else await replay(options)
  }
  // the output is written; a socket or a browser a saturated backend left
  // half open would keep the event loop, and the run, alive
  process.exit(0)
}

if (process.argv[2] === '--worker') await runWorker()
else await main()

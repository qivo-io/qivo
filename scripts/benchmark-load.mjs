// The combined load of many tabs, people and sessions on one disposable
// local Convex backend: what each view subscribes, what a change re-sends,
// what a reconnect, a cold start and an idle minute cost the server.
//
//   QIVO_LOCAL_ADMIN_KEY=… node scripts/benchmark-load.mjs <part>
//     [--url http://127.0.0.1:3236] [--site-url http://localhost:5241]
//     [--deployment local-sc-3236] [--dir dev-temp/load] [--output file.json]
//     [--browser chromium|firefox|webkit] [--views board,overview,roadmap,sync,inbox,mine]
//     [--people 50] [--teams 10] [--orgs 1] [--clients 10] [--processes 2]
//     [--phases match,startup,changes,reconnect,idle,busy] [--changes 20] [--idle-s 120]
//     [--busy-loops 8] [--busy-cpus 0-7]
//     [--quiet-ms 3000] [--timeout-ms 90000] [--no-hidden-tab]
//     [--tabs 1] [--board-top]
//
// <part> is setup, record, replay or all (the three in turn), or tabs,
// which `all` leaves out: one person's --tabs real tabs open at once (see
// tabsPart). --board-top puts the Board view on the whole Luma Sensor
// project instead of its Firmware sub-project, for the rung that raises a
// project's open tasks. Startup and the reconnect also give each query's
// time from its Add to its first answer by the clients' own clocks
// (client_first_answer_ms), which a saturated function log cannot drop. The
// options
// are read in scripts/load/options.mjs, the protocol and the recorded sets
// in scripts/load/frames.mjs and the figures in scripts/load/report.mjs,
// which scripts/benchmark-load.test.mjs checks.
//
// Only a disposable local backend. --url and --site-url must be loopback
// origins, the run refuses a CONVEX_DEPLOY_KEY in its environment, and it
// reads the local backend's admin key from QIVO_LOCAL_ADMIN_KEY, as the
// local seeds do, and prints it nowhere. Never point it at a hosted
// deployment: it plants logins and sessions, adds people and teams and
// writes tasks and comments. Run it in a Boat sandbox against the backend
// the sandbox started, after `marketing-demo.mjs seed --local` seeded
// Northstar there and, for everyday tasks, `board-scale-seed.mjs --local
// --tasks 300` gave its 12 sub-projects about 30 tasks each.
//
// setup grows Northstar to the everyday organization, --people profiles
// (agents included, 50 by default) and --teams teams (10), and writes
// <dir>/people.json. It deploys no module and plants nothing in tracked
// code: with the admin key it creates each Better Auth login and session
// through the Better Auth component's own adapter functions
// (convex/betterAuth/adapter.ts create and findOne, called with the
// component path), claims each seat through identity.claimSeatsInternal
// as the sign-in does, and makes every team, share and person through the
// app's public mutations as Nora, the organization's admin (teams.create,
// projects.setAccess, profiles.create). Each new person joins 3 teams, one
// of Northstar's two, which are shared with every top-level project, and
// two new ones, and each new team is shared with one sub-project, so every
// person reads Northstar's projects and no project holds more than 3 team
// shares, inside the design size's 5. It also plants one
// session for Nora, which the replay's Nora and the writer act with. A
// second run adds only what is missing. With --orgs N it then adds N - 1
// organizations at everyday size beside Northstar (setupOrg): a new login
// creates each, mirrors Northstar's projects and sub-projects by name with
// 30 tasks a sub-project, adds --teams teams and --people profiles, and
// invites Nora, whose login claims the seat as a guest, since a login holds
// one home seat (convex/identity.ts claimSeatsForLogin), with `user` on
// every top-level project; Nora gets one session for each. record then
// records Nora's views in each organization too. people.json holds the planted
// session ids, which act only with the admin key; it stays in the
// untracked working folder.
//
// record opens one real tab per --views view in --browser as Nora, signed
// in through the app's own sign-in with the local seed's fixture password
// (scripts/browser-demo.mjs signInDemo): a sub-project's Board (Luma
// Sensor's Firmware), the Overview, the Roadmap and Team sync of Luma
// Sensor, the Inbox and My view. Chromium runs as the full browser in its
// new headless mode (channel chromium), since the headless shell answers
// notifications as denied, and its context is granted notifications, so
// the tab leads its profile's desktop alerts (src/lib/notificationLeader.ts)
// and its set holds the Inbox feed and the delivery mode; Firefox and
// WebKit are asked for it too and run without it where they refuse. The
// tabs open one after another in one context, so each leads in turn as
// the one before closes. It reads the tab's WebSocket frames from
// Playwright, waits until the tab is current (every query answered at the
// newest query set version) and its frames have been quiet for --quiet-ms,
// and writes <dir>/sets/<view>.json: each query's function, arguments and
// last answer's bytes, and the mutations the tab called by name and count.
// Authenticate frames are never read, so no token reaches a set. It
// records what the app at --site-url subscribes, the Vite dev server or a
// production build alike, and times nothing in the browser.
//
// replay runs --clients Node clients over --processes processes, each a
// ConvexClient from convex/browser over the WebSocket, as the app's own
// client is (src/lib/convex.ts). Client i acts as person i of people.json
// (Nora first) and subscribes the set of view i modulo the views, with
// that person's profile and login swapped in for Nora's (frames.mjs
// personQueries). A client signs in as its person's planted session with
// the admin key acting as that identity (setAdminAuth with the login as
// subject and the session as sessionId), so the session wrappers' reads
// run as in the app (lib/functions.ts), but no JWT is validated or
// refreshed. A client whose set holds the Inbox feed also leads: it beats
// at the server's pace (notifications.beat, every_ms), subscribes the feed
// from ten minutes before its beat, takes its first answer as the
// baseline, claims each new event (claimAlerts, claimSummary first where
// asked), and moves the feed's floor to each answer's `through`, as
// src/lib/notificationFeed.ts does. A client makes none of a boot's one-off
// writes (identity.claimMySeats, prefs.save), which the sets list under
// `calls`. The people setup adds own no task and hold no Inbox item, so
// their Inbox and My view answer less than Nora's. Its phases, each with
// the function log's figures and /proc/stat's steal over it:
//
// - match: one client per recorded set as Nora herself, compared with the
//   tab in functions, arguments and answer bytes (the Inbox feed's `after`
//   is the leader's clock and compared by presence), then a reconnect of
//   that lone Board client, whose time to current is the reconnect
//   trigger's base.
// - startup: every client created and subscribed at once, from cold; each
//   one's time to current and its set against its person's swapped set.
// - changes: --changes changes, one a second, as Nora: a rename, a move to
//   a sibling sub-project and back, a status change and a comment on the
//   recorded Board's tasks (two open tasks without subtasks, and the
//   comments on four others in turn, so the rule of 10 comments a minute
//   from one person on one task refuses none, changes.mjs), each with
//   the queries that reran and their JavaScript time from the log, and the
//   bytes re-sent to each client until the next change. The title, the
//   status and the move are put back and the posted comments removed
//   after, so a later run reads the same data.
// - reconnect: every client's socket closed at once; the re-subscriptions,
//   the JavaScript times, the calls in flight, the closes with their codes
//   (1013 is an overload) and each client's time to current, from the
//   close and from the socket's open. With the hidden tab (default), one
//   real Board tab in --browser, hidden as the visibility stage hid it
//   (document.visibilityState overridden and visibilitychange sent), has
//   its socket closed at the same moment, and the check passes when the
//   set it subscribes again holds none of the reads it dropped on hiding
//   and nothing it did not hold while hidden.
// - idle: --idle-s seconds with no change; server work, bytes and calls
//   per session per minute, the beats and claims included, and the
//   answers per minute of each watched client (Nora's tabs).
// - busy: the changes again beside --busy-loops processes that spin, each
//   pinned to --busy-cpus with taskset when given, so the backend's CPUs
//   are busy while the clients run on others.
//
// The phases after startup run in the order --phases names them. With
// --orgs the clients are dealt to the organizations in turn (clientSpecs):
// the first in each is Nora's tab there, on its Board as recorded there,
// and only her Northstar tab leads her alerts, as one browser profile
// does; the rest are that organization's people on Northstar's sets with
// its mirrored ids swapped in. A replayed person with one seat holds none
// of the reads a recorded set names for Nora's other organizations.
//
// The output (--output, else <dir>/out/rung-<clients>.json) is one rung:
// per phase and function the executions a second and the JavaScript p50,
// p99 and maximum, the backend's total time, the calls at once in the
// backend and in flight in the clients, closes, bytes per client per
// change, idle bytes and calls per session per minute, time to current
// after the reconnect, each process's event loop lag, /proc/stat's steal
// with `noisy` set on a phase where it reached 10%, and item 9's
// subscriptions of one login per organization by name (report.mjs
// rungReport says where each figure comes from). The local function log
// stream drops entries when its queue fills, so the clients also time
// their own calls, and a phase whose clients called more than the log
// shows says so (log_coverage). The pacing trigger the closing review's
// question 9 fixed is reported beside it: an overload close, a call whose
// JavaScript passes the owner's 0.5 s line, or a client whose time to
// current after the reconnect passes ten times the lone client's. The
// local backend's query concurrency is not hosted Convex's, so a close
// there is judged against the modelled hosted limit, not taken as one.
import { fork, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { ConvexClient, ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { jsonToConvex } from 'convex/values'
import { CHANGE_KINDS, commentTargets } from './load/changes.mjs'
import {
  checkSet,
  compareSets,
  FrameTracker,
  personQueries,
  recordedSet,
  subscriptionsByOrganization,
  withoutLeaderReads,
} from './load/frames.mjs'
import { loadOptions, OptionsError, VIEWS } from './load/options.mjs'
import {
  cpuCounters,
  cpuShare,
  firstAnswerStats,
  functionStats,
  JS_LINE_MS,
  logEntry,
  mostAtOnce,
  overLine,
  perSessionMinute,
  rungReport,
  spread,
} from './load/report.mjs'

const ref = makeFunctionReference
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const say = (text) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`)

/** The floor of the Inbox feed a leader watches, before its last beat's
    `now` (convex/lib/limits.ts ALERT_WINDOW_MS). */
const ALERT_WINDOW_MS = 600_000
/** The clamp the app puts on the server's beat pace (src/lib/notificationLeader.ts
    NOTIFY_CLIENT's range), wide enough for the server's one minute. */
const BEAT_MS = { least: 15_000, most: 6 * 3_600_000 }
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

/** A lowercase UUID made from `text`, so a rerun of setup names the same
    rows and adds only what is missing. */
function stableId(text) {
  const hex = createHash('sha256').update(`qivo-load:${text}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

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

/** Every row of a navigation list (projectNav page or children) as `client`
    reads it, waiting out not_ready, as scripts/browser-demo.mjs navRows
    does in a page. */
async function navRows(client, name, args) {
  const rows = []
  const deadline = Date.now() + 30_000
  for (let after; ; ) {
    const batch = await client.query(ref(name), { ...args, ...(after ? { after } : {}) })
    if (batch.state === 'not_ready' && Date.now() < deadline) {
      await sleep(250)
      continue
    }
    if (batch.state !== 'ok') throw new Error(`${name} answered ${batch.state}`)
    rows.push(...batch.rows)
    if (batch.stopped) throw new Error(`${name} stopped`)
    if (batch.next === null) return rows
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

/** The setup part: grows Northstar to the everyday organization and writes
    people.json. */
async function setup(options) {
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
  const tops = await navRows(asNora, 'projectNav:page', { org_id: org })
  const projects = []
  for (const top of tops)
    projects.push({
      id: top.id,
      name: top.name,
      num: top.num,
      children: (await navRows(asNora, 'projectNav:children', { project_id: top.id })).map(
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
  // the organization's profiles as Settings › Users lists them, agents included
  let held = 0
  const deadline = Date.now() + 30_000
  for (let after; ; ) {
    const page = await asNora.query(ref('people:settingsPage'), {
      org_id: org,
      ...(after ? { after } : {}),
    })
    if (page.state === 'not_ready' && Date.now() < deadline) {
      await sleep(250)
      continue
    }
    if (page.state !== 'ready' || page.stopped)
      throw new Error('Settings › Users did not list the people')
    held += page.rows.length
    if (!page.next) break
    after = page.next
  }
  // the people an earlier run planted keep their sessions; person i has id
  // stableId(person:i), and no run goes past --people profiles
  const made = earlier?.people?.slice(1) ?? []
  const added = teams.slice(seat.team_ids.length)
  const grown = await addPeople({
    admin,
    asAdmin: asNora,
    org,
    count: Math.max(0, options.people - held),
    from: made.length,
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
  mkdirSync(options.dir, { recursive: true })
  const plan = { org_id: org, org_slug: ORG_SLUG, profiles: held, teams, projects, people }
  const orgs = [{ k: 0, org_id: org, org_slug: ORG_SLUG, profiles: held, teams, projects, people }]
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
    `setup: ${held} profiles, ${teams.length} teams, ${people.length} planted sessions in ${peopleFile}` +
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

/** Runs `step(item)` for every item of `items`, `width` at a time.
    Answers the results in the items' order. */
async function pool(items, width, step) {
  const out = new Array(items.length)
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
    const pick = [
      baseTeams[i % baseTeams.length],
      addedTeams[i % addedTeams.length],
      addedTeams[(i + 3) % addedTeams.length],
    ]
    const made = await once(() =>
      asAdmin.mutation(ref('profiles:create'), {
        org_id: org,
        id,
        name,
        email,
        org_role: 'user',
        kind: 'person',
        color: COLORS[i % COLORS.length],
        teams: [...new Set(pick.filter(Boolean))],
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
  const ids = {}
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
    ids[top.id] = id
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
      ids[child.id] = childId
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
  // Northstar's teams by order, for the swap of a recorded set's ids
  northstar.teams.forEach((team, i) => {
    if (teams[i]) ids[team] = teams[i]
  })
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
    teams,
    projects,
    // Northstar's ids to this organization's, by name and order
    mirror: { [northstar.org_id]: org, ...ids },
    owner: { ...owner },
    people: [nora, ...grown.people],
  }
}

/** The signed-in login's seat in organization `which` (its slug, or a test
    of its row) from the root part's answer: the profile, its organization
    with its slug and the teams the profile is in, found by shape so a
    change to the answer's layout fails here and not later. */
function findSeat(root, which) {
  const matches = typeof which === 'function' ? which : (row) => row.slug === which
  const orgs = []
  const profiles = []
  const memberships = []
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (value === null || typeof value !== 'object') return
    if (typeof value.slug === 'string' && typeof value.id === 'string') orgs.push(value)
    if (typeof value.org_id === 'string' && typeof value.org_role === 'string') profiles.push(value)
    if (typeof value.team_id === 'string' && typeof value.profile_id === 'string')
      memberships.push(value)
    Object.values(value).forEach(walk)
  }
  walk(root)
  const org = orgs.find(matches)
  const profile = org && profiles.find((row) => row.org_id === org.id)
  if (!profile) return null
  return {
    org_id: org.id,
    slug: org.slug,
    profile_id: profile.id,
    team_ids: [
      ...new Set(
        memberships.filter((row) => row.profile_id === profile.id).map((row) => row.team_id),
      ),
    ],
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

/** A Playwright browser of `options.browser` and a context signed in as
    Nora, with the page it signed in on. */
async function signedIn(options) {
  const playwright = await import('playwright')
  const { loadBrowserDemo, signInDemo } = await import('./browser-demo.mjs')
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
  const page = await context.newPage()
  await signInDemo(page, demo, 'nora')
  return { browser, context, page, demo, notifications }
}

/** The addresses of the recorded views, from the projects setup listed.
    The Board is Luma Sensor's Firmware sub-project, or the whole Luma
    Sensor project with --board-top. */
function viewUrls(plan, options) {
  const sensor = plan.projects.find((project) => project.name === 'Luma Sensor') ?? plan.projects[0]
  const board = sensor.children.find((child) => child.name === 'Firmware') ?? sensor.children[0]
  const base = `/app/${plan.org_slug}`
  return {
    board: `${base}/board/p/${options?.boardTop ? sensor.num : board.num}`,
    overview: `${base}/overview/p/${sensor.num}`,
    roadmap: `${base}/roadmap/p/${sensor.num}`,
    sync: `${base}/sync/p/${sensor.num}`,
    inbox: `${base}/inbox`,
    mine: `${base}/board/mine`,
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

/** The organizations of people.json: Northstar first, then those setup
    added with --orgs. */
const orgsOf = (plan) => plan.orgs ?? [{ k: 0, ...plan }]

/** The folder of organization `planOrg`'s recorded sets. */
const setsDir = (options, planOrg) =>
  planOrg.k === 0 ? join(options.dir, 'sets') : join(options.dir, 'sets', planOrg.org_slug)

/** The views of one organization recorded in `context`, as Nora's seat
    there (people[0] of its part of people.json). */
async function recordOrg(options, context, planOrg, notifications) {
  const recorder = planOrg.people[0]
  const urls = viewUrls(planOrg, options)
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
    alerts when `lead`. `onAnswer` hears each answer. */
function replayClient({ url, adminKey, person, queries, lead, index, onAnswer }) {
  const tracker = new FrameTracker({ onAnswer })
  const sockets = new Set()
  const Native = globalThis.WebSocket
  class Tracked extends Native {
    constructor(address) {
      super(address)
      sockets.add(this)
      this.openedAt = null
      this.addEventListener('open', () => {
        this.openedAt = Date.now()
        client.openedAt = this.openedAt
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
  const client = { tracker, convex, sockets, person, openedAt: null, leader: null }
  for (const query of queries) {
    if (lead && query.udfPath === 'inbox:feed') continue
    convex.client.subscribe(query.udfPath, jsonToConvex(query.args))
  }
  if (lead) client.leader = startLeader(convex, index)
  /** Closes every open socket of the client, as a network drop does. */
  client.drop = () => {
    for (const socket of sockets) {
      socket.droppedByTest = true
      socket.close()
    }
  }
  client.close = async () => {
    client.leader?.stop()
    await convex.close()
  }
  return client
}

/** The delivery leader of one browser profile, as src/lib/notificationFeed.ts
    and notificationLeader.ts run it while the page can notify: a beat at
    the server's pace, the feed from ten minutes before the beat, its
    first answer taken as the baseline, each new event claimed and the
    feed's floor moved to each answer's `through`. */
function startLeader(convex, index) {
  const instance = `load-${index}`
  let after = null
  let unwatch = null
  let baseline = true
  let baselined = new Set()
  let lastKeys = new Set()
  let stopped = false
  let timer = null
  let running = Promise.resolve()
  const beat = async () => {
    const answer = await convex.mutation(ref('notifications:beat'), {
      instance,
      can_notify: true,
      active: false,
    })
    if (after === null || after < answer.now - ALERT_WINDOW_MS) {
      after = answer.now - ALERT_WINDOW_MS
      watch()
    }
    return answer
  }
  const tick = async () => {
    if (stopped) return
    let every = 60_000
    try {
      every = (await beat()).every_ms
    } catch {
      // the next tick beats again, as a failed beat retries
    }
    if (!stopped) timer = setTimeout(tick, Math.min(BEAT_MS.most, Math.max(BEAT_MS.least, every)))
  }
  const summarize = () => convex.mutation(ref('notifications:claimSummary'), {})
  const claim = async (events, through) => {
    let answer = await convex.mutation(ref('notifications:claimAlerts'), { events, through })
    if (answer.state === 'summarize_first') {
      await summarize()
      answer = await convex.mutation(ref('notifications:claimAlerts'), { events, through })
    } else if (answer.state === 'not_registered') {
      await beat()
      answer = await convex.mutation(ref('notifications:claimAlerts'), { events, through })
    }
    if (answer.limited) await summarize()
  }
  const handle = async (feed) => {
    if (baseline) {
      await claim([], feed.through)
      baseline = false
      baselined = new Set(feed.events.map((event) => event.key))
    } else {
      if (feed.more) await summarize()
      const offered = feed.events
        .filter((event) => !lastKeys.has(event.key) && !baselined.has(event.key))
        .reverse()
        .slice(0, 50)
        .map(({ key, at }) => ({ key, at }))
      if (offered.length > 0) await claim(offered, feed.through)
    }
    lastKeys = new Set(feed.events.map((event) => event.key))
    if (after !== null && feed.through > after) {
      after = feed.through
      watch()
    }
  }
  const watch = () => {
    unwatch?.()
    const floor = after
    unwatch = convex.onUpdate(
      ref('inbox:feed'),
      { after: floor },
      (feed) => {
        if (stopped || floor !== after || !feed || !Array.isArray(feed.events)) return
        running = running.then(() => handle(feed)).catch(() => {})
      },
      () => {},
    )
  }
  void tick()
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      unwatch?.()
    },
  }
}

/* ----------------------------------------------------------------- worker */

/** A worker process: runs its share of the clients and answers the
    coordinator's commands over IPC (start, phase, change, reconnect,
    report, stop). */
async function runWorker() {
  let config = null
  const clients = []
  const delay = monitorEventLoopDelay({ resolution: 10 })
  delay.enable()
  /** Nanoseconds `value` of the delay histogram as milliseconds past its
      10 ms resolution, to a hundredth. */
  const lag = (value) => Math.max(0, Math.round((value / 1e6 - 10) * 100) / 100)
  let phase = null
  let change = null
  let inFlightMost = 0
  const fresh = () => ({
    bytesStart: new Map(),
    answers: new Map(),
    changes: new Map(),
    // the answers of the clients marked `watch` (one login's tabs, item 9),
    // by client and function
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
      time to current from `from` and from its socket's open. */
  const allCurrent = async (from, connects = () => 0) => {
    const deadline = Date.now() + config.timeoutMs
    const results = new Map()
    while (results.size < clients.length && Date.now() < deadline) {
      for (const client of clients) {
        if (results.has(client.index) || !client.tracker.current) continue
        if (client.tracker.connects <= connects(client)) continue
        const start = from
        results.set(client.index, {
          index: client.index,
          // the queries the client's newest set holds, sent again after a reconnect
          queries: client.tracker.queries.size,
          ms: Date.now() - start,
          from_open_ms: client.openedAt ? Date.now() - client.openedAt : null,
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
      // the delay past the sampler's own 10 ms timer, in milliseconds
      event_loop_lag_ms: {
        p50: lag(delay.percentile(50)),
        p99: lag(delay.percentile(99)),
        max: lag(delay.max),
      },
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
        process.send({ type: 'ready' })
      } else if (message.type === 'start') {
        mark('startup')
        const from = Date.now()
        for (const spec of message.clients) {
          const client = replayClient({
            ...config,
            ...spec,
            onAnswer: onAnswer(spec.index, spec.watch ?? null),
          })
          client.index = spec.index
          client.view = spec.view
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
        process.send({ type: 'stopped' })
        process.exit(0)
      }
    } catch (error) {
      process.send({ type: 'error', message: String(error?.stack ?? error) })
    }
  })
}

/** The coordinator's handle on one worker process: `ask(message, answer)`
    sends a command and resolves with the reply of type `answer`. */
function startWorker() {
  const child = fork(fileURLToPath(import.meta.url), ['--worker'], { stdio: 'inherit' })
  const waiting = []
  child.on('message', (message) => {
    if (message.type === 'error') {
      console.error(`worker ${child.pid}: ${message.message}`)
      return
    }
    const at = waiting.findIndex((wait) => wait.type === message.type)
    if (at >= 0) waiting.splice(at, 1)[0].done(message)
  })
  return {
    child,
    ask(message, type) {
      return new Promise((done) => {
        waiting.push({ type, done })
        child.send(message)
      })
    },
  }
}

/* --------------------------------------------------------------- function log */

/** Follows the local backend's function log stream and keeps every
    completion (report.mjs logEntry), until stopped. */
function followLog(options) {
  const entries = []
  let stopped = false
  let pages = 0
  const read = async (cursor) => {
    const response = await fetch(`${options.url}/api/stream_function_logs?cursor=${cursor}`, {
      headers: { Authorization: `Convex ${options.adminKey}` },
    })
    if (!response.ok) throw new Error(`the function log answered ${response.status}`)
    return await response.json()
  }
  const done = (async () => {
    let cursor = (await read(0)).newCursor
    while (!stopped) {
      try {
        const page = await read(cursor)
        pages++
        cursor = page.newCursor
        for (const raw of page.entries) {
          const entry = logEntry(raw)
          if (entry) entries.push(entry)
        }
      } catch {
        await sleep(500)
      }
    }
  })()
  return {
    entries,
    /** The entries whose call started between `from` and `to`. */
    between: (from, to) => entries.filter((entry) => entry.start >= from && entry.start < to),
    get pages() {
      return pages
    },
    async stop() {
      stopped = true
      await Promise.race([done, sleep(2000)])
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

/** The client specs of a replay: client i acts as one person and
    subscribes one recorded set with that person's ids. With one
    organization, person i of people.json takes view i modulo the views.
    With --orgs, the clients are dealt to the organizations in turn; in
    each, the first is Nora's seat there, on its Board as recorded there
    (her one login holds a tab in each organization, item 9), and the
    others are its people, each on Northstar's set of its view with the
    organization's mirrored ids swapped in and Nora's other seats' reads
    left out. One login leads its desktop alerts once (one browser
    profile), so only Nora's Northstar tab leads among hers; a tab that
    does not lead holds no leader reads. */
function clientSpecs(options, plan, orgSets) {
  const orgs = orgsOf(plan).slice(0, options.orgs)
  const northstar = orgSets[0]
  const viewSet = (sets, view) => sets.find((set) => set.view === view)
  const bytesOf = (set) => set.queries.reduce((all, query) => all + (query.bytes ?? 0), 0)
  const hasFeed = (set) => set.queries.some((query) => query.udfPath === 'inbox:feed')
  return Array.from({ length: options.clients }, (_, index) => {
    const k = index % orgs.length
    const planOrg = orgs[k]
    const j = Math.floor(index / orgs.length)
    const person = planOrg.people[j]
    if (!person)
      throw new Error(
        `${planOrg.org_slug} holds ${planOrg.people.length} planted sessions, fewer than its share of --clients`,
      )
    let set
    let queries
    if (orgs.length === 1) {
      set = northstar[index % northstar.length]
      queries = personQueries(set, person, { ownOrg: index !== 0 })
    } else if (j === 0) {
      set = viewSet(orgSets[k], 'board') ?? orgSets[k][0]
      queries = set.queries
    } else {
      set = northstar[j % northstar.length]
      queries = personQueries(set, person, { more: planOrg.mirror ?? {}, ownOrg: true })
    }
    // Nora's tabs beside her Northstar tab, in one browser profile, do not lead
    const lead = hasFeed(set) && !(orgs.length > 1 && j === 0 && k > 0)
    return {
      index,
      org: planOrg.org_slug,
      view: set.view,
      person,
      queries: lead ? queries : withoutLeaderReads(queries),
      lead,
      watch: j === 0 ? `${person.key}` : null,
      recorded_answer_bytes: bytesOf(set),
    }
  })
}

/** The busy loops of the busy phase: `count` processes that spin, each
    pinned to `cpus` (taskset) when given. Answers a stop. */
function busyLoops(count, cpus) {
  const loops = Array.from({ length: count }, () =>
    cpus
      ? spawn('taskset', ['-c', cpus, process.execPath, '-e', 'for(;;){}'], { stdio: 'ignore' })
      : spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }),
  )
  return {
    pids: loops.map((loop) => loop.pid),
    stop: () => {
      for (const loop of loops) loop.kill('SIGKILL')
    },
  }
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
  const sets = orgSets[0]
  const byView = new Map(sets.map((set) => [set.view, set]))
  const people = orgs.slice(0, options.orgs).reduce((all, one) => all + one.people.length, 0)
  if (people < options.clients)
    throw new Error(`people.json holds ${people} people, fewer than --clients ${options.clients}`)
  const log = followLog(options)
  // the coordinator's own event loop, which follows the log and writes
  const delay = monitorEventLoopDelay({ resolution: 10 })
  delay.enable()
  const lagOf = (value) => Math.max(0, Math.round((value / 1e6 - 10) * 100) / 100)
  await sleep(1000)
  const phases = {}
  const notRun = {}
  let match = null
  let lone = null
  const workers = []
  let hidden = null
  /** Runs `body` as phase `name`, with the log, steal and the workers'
      figures over it. */
  const timed = async (name, body) => {
    say(`phase ${name}`)
    const cpu = cpuNow()
    const from = Date.now()
    delay.reset()
    await Promise.all(workers.map((worker) => worker.ask({ type: 'phase', name }, 'marked')))
    // a phase whose own work fails keeps the figures it reached and says why,
    // so a saturated backend's refusal does not lose the rung's other phases
    let extra
    try {
      extra = (await body()) ?? {}
    } catch (error) {
      extra = { failed: String(error?.message ?? error).slice(0, 300) }
      say(`phase ${name} failed: ${extra.failed}`)
    }
    // the log's entries trail their calls
    await sleep(1500)
    const to = Date.now()
    const reports = (
      await Promise.all(workers.map((worker) => worker.ask({ type: 'report' }, 'report')))
    ).map((answer) => answer.report)
    const figures = phaseFigures(log.between(from, to), (to - from) / 1000, reports, {
      steal: cpuShare(cpu, cpuNow()),
      started_at: new Date(from).toISOString(),
      ended_at: new Date(to).toISOString(),
      coordinator_event_loop_lag_ms: {
        p50: lagOf(delay.percentile(50)),
        p99: lagOf(delay.percentile(99)),
        max: lagOf(delay.max),
      },
      ...extra,
    })
    if (Array.isArray(figures.changes)) attachResends(figures, options.clients)
    delete figures._changes
    // a phase in which the hypervisor took a tenth of the CPU or more is no timing
    figures.noisy = (figures.steal?.steal_pct ?? 0) >= 10
    phases[name] = figures
    say(
      `phase ${name} done: ${Math.round((to - from) / 1000)} s, steal ${figures.steal?.steal_pct ?? '?'}%, slowest JS ${Math.max(0, ...Object.values(figures.functions).map((one) => one.js_ms.max ?? 0))} ms`,
    )
  }
  const specs = clientSpecs(options, plan, orgSets)
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
    if (!options.phases.includes('startup'))
      notRun.startup_note = 'startup runs to start the clients'
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
          return { seconds: options.idleSeconds }
        })
      else if (name === 'reconnect') {
        if (options.hiddenTab) {
          try {
            hidden = await hiddenTab(options, plan)
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
    await Promise.all(
      workers.map((worker) => worker.ask({ type: 'stop' }, 'stopped').catch(() => {})),
    )
    await log.stop()
  }
  const idle = phases.idle
  if (idle) {
    // the functions a session subscribes or calls; the rest are the backend's own jobs
    const own = new Set(orgSets.flat().flatMap((set) => set.queries.map((query) => query.udfPath)))
    for (const name of Object.keys(idle.client_calls)) own.add(name)
    idle.per_session_minute = perSessionMinute(idle, options.clients, idle.seconds, own)
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
      host_cpus: (await import('node:os')).cpus().length,
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
      // by the organization the tab showed, then by the organization each query names
      by_organization: Object.fromEntries(
        orgSets.map((orgSet, k) => [orgs[k].org_slug, subscriptionsByOrganization(orgSet)]),
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

/** The watched clients' answers over the idle phase (`watched`, the
    workers' { client, udfPath, updates, bytes }) per minute, by client
    and function. */
function watchedPerMinute(watched, seconds) {
  const minutes = Math.max(seconds, 1e-9) / 60
  const out = {}
  for (const { client, udfPath, updates, bytes } of watched ?? []) {
    out[client] ??= {}
    out[client][udfPath] = {
      answers: Math.round((updates / minutes) * 100) / 100,
      bytes: Math.round(bytes / minutes),
    }
  }
  return out
}

/** One phase's figures: the log's per function statistics, the backend's
    calls at once, the workers' bytes, calls, closes, calls in flight and
    event loop lag, and `extra`. */
function phaseFigures(entries, seconds, reports, extra) {
  const stats = functionStats(entries, seconds)
  const calls = mergeCalls(reports.map((report) => report.calls))
  const logged = (name) => stats.functions[name]?.executions ?? 0
  const perClient = reports.flatMap((report) => report.per_client_bytes)
  const closes = {}
  for (const report of reports)
    for (const [code, count] of Object.entries(report.closes))
      closes[code] = (closes[code] ?? 0) + count
  return {
    clients: perClient.length,
    seconds: Math.round(seconds * 10) / 10,
    ...stats,
    over_line: overLine(stats),
    backend_at_once: mostAtOnce(entries.filter((entry) => !entry.nested)),
    client_calls: Object.fromEntries(
      Object.entries(calls).map(([name, done]) => [
        name,
        {
          calls: done.calls,
          failed: done.failed,
          client_ms: spread(done.ms),
          logged: logged(name),
        },
      ]),
    ),
    log_coverage: Object.entries(calls)
      .filter(([name, done]) => logged(name) < done.calls)
      .map(([name, done]) => ({ fn: name, client_calls: done.calls, logged: logged(name) })),
    bytes_per_client: spread(perClient.map((client) => client.bytes)),
    bytes_total: perClient.reduce((all, client) => all + client.bytes, 0),
    answers: mergeCounts(reports.map((report) => report.answers)),
    closes,
    dropped_by_benchmark: reports.reduce((all, report) => all + report.dropped, 0),
    watched: reports.flatMap((report) => report.watched ?? []),
    in_flight_most: reports.reduce((all, report) => all + report.in_flight_most, 0),
    processes: reports.map((report) => ({
      pid: report.pid,
      clients: report.clients,
      event_loop_lag_ms: report.event_loop_lag_ms,
    })),
    _changes: reports.flatMap((report) => report.changes),
    ...extra,
  }
}

/** Adds to each change of the changes phase `figures` what the clients
    received after it, until the next change: the bytes re-sent to each of
    the `clients` (those that got none count as 0) and the queries each
    re-send updated, and to the phase the bytes per client per change by
    kind of change. */
function attachResends(figures, clients) {
  const byKind = {}
  for (const change of figures.changes) {
    const slots = figures._changes.filter((slot) => slot.id === change.id)
    const perClient = new Map()
    for (const slot of slots)
      for (const [index, bytes] of Object.entries(slot.per_client)) perClient.set(index, bytes)
    const bytes = Array.from({ length: clients }, (_, index) => perClient.get(String(index)) ?? 0)
    change.resent_bytes_per_client = spread(bytes)
    change.clients_resent = perClient.size
    change.updated = mergeCounts(slots.map((slot) => slot.queries))
    byKind[change.kind] = [...(byKind[change.kind] ?? []), ...bytes]
  }
  figures.bytes_per_client_per_change = Object.fromEntries(
    Object.entries(byKind).map(([kind, bytes]) => [kind, spread(bytes)]),
  )
}

/** The sums of `{ updates, bytes }` maps `maps` by key. */
function mergeCounts(maps) {
  const out = {}
  for (const map of maps)
    for (const [name, entry] of Object.entries(map)) {
      const sum = out[name] ?? { updates: 0, bytes: 0 }
      sum.updates += entry.updates
      sum.bytes += entry.bytes
      out[name] = sum
    }
  return out
}

/** The sums of `{ calls, failed, ms }` maps `maps` (the trackers' calls)
    by function. */
function mergeCalls(maps) {
  const out = {}
  for (const map of maps)
    for (const [name, done] of Object.entries(map)) {
      const entry = out[name] ?? { calls: 0, failed: 0, ms: [] }
      entry.calls += done.calls
      entry.failed += done.failed
      entry.ms.push(...done.ms)
      out[name] = entry
    }
  return out
}

/** The pacing trigger of the closing review's question 9 over `phases`:
    an overload close (1013), a call whose JavaScript passed the 0.5 s line
    and a client whose time to current after the reconnect passed ten
    times the lone client's, each with what showed it. */
function pacingTrigger(phases) {
  const overload = Object.entries(phases).filter(
    ([, figures]) => (figures.closes?.['1013'] ?? 0) > 0,
  )
  // each call over the line says whether its phase was noisy, which the reader judges
  const over = Object.entries(phases).flatMap(([name, figures]) =>
    (figures.over_line ?? []).map((entry) => ({ phase: name, noisy: figures.noisy, ...entry })),
  )
  const slow = phases.reconnect?.slow_clients ?? null
  return {
    line_ms: JS_LINE_MS,
    overload_closes: overload.map(([name, figures]) => ({
      phase: name,
      count: figures.closes['1013'],
    })),
    over_line: over,
    slow_reconnects: slow,
    fires: overload.length > 0 || over.length > 0 || (slow ?? 0) > 0,
    fires_outside_noisy_phases:
      overload.length > 0 || over.some((entry) => !entry.noisy) || (slow ?? 0) > 0,
  }
}

/** The match phase: each recorded set replayed by one client as the
    recorder, compared with the tab, then a reconnect of the lone Board
    client timed. Runs in this process, before any load. */
async function matchSets(options, plan, sets) {
  const recorder = plan.people[0]
  const views = []
  let lone = null
  for (const set of sets) {
    const client = replayClient({
      url: options.url,
      adminKey: options.adminKey,
      person: recorder,
      queries: set.queries,
      lead: false,
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
    if (set.view === 'board') {
      const connects = client.tracker.connects
      const at = Date.now()
      client.drop()
      const fresh = () => client.tracker.connects > connects && client.tracker.current
      while (!fresh() && Date.now() - at < options.timeoutMs) await sleep(10)
      lone = fresh() ? Date.now() - at : null
    }
    await client.close()
  }
  return {
    matched: views.every((view) => view.matched),
    views,
    lone_reconnect_ms: lone,
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
  const [renamed, moved] = open
  // the comments go to other tasks in turn, enough that the comment rule
  // refuses none (changes.mjs commentTargets)
  const commented = commentTargets(open.slice(2))
  const home = moved.project_id
  const sibling = plan.projects
    .flatMap((project) =>
      project.children.some((child) => child.id === home) ? project.children : [],
    )
    .find((child) => child.id !== home)
  if (!sibling) throw new Error('the Board sub-project has no sibling to move a task to')
  const org = plan.org_id
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
    await Promise.all(workers.map((worker) => worker.ask({ type: 'change', id: i }, 'changed')))
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
  await Promise.all(workers.map((worker) => worker.ask({ type: 'change', id: null }, 'changed')))
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
  return {
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
      return {
        ...change,
        js_ms: own?.js_ms ?? null,
        reran: Object.fromEntries(
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

/** One real Board tab in the browser, hidden, whose socket the reconnect
    phase closes: `reconnect()` closes it and answers the check. */
async function hiddenTab(options, plan) {
  const { browser, page: signInPage } = await signedIn(options)
  const context = signInPage.context()
  await signInPage.close()
  const page = await context.newPage()
  const tracker = trackPage(page, options)
  const url = viewUrls(plan, options).board
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
        ms_to_current: after.ms,
        dropped_on_hiding: dropped,
        resubscribed_view_reads: resubscribedViewReads,
        new_reads: newReads,
        passed:
          tracker.connects > connects &&
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
  const boardSet = readSets(options).find((set) => set.view === 'board')
  const urls = viewUrls(plan, options)
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
  /** Runs `body` as phase `name`, with the log, steal and each tab's bytes. */
  const timed = async (name, body) => {
    say(`phase ${name}`)
    for (const tab of tabs) {
      tab.bytesStart = tab.tracker.bytesReceived
      tab.framesStart = tab.tracker.framesReceived
      tab.answers = new Map()
      tab.perChange = new Map()
    }
    const cpu = cpuNow()
    const from = Date.now()
    const extra = (await body()) ?? {}
    await sleep(1500)
    const to = Date.now()
    const seconds = (to - from) / 1000
    const stats = functionStats(log.between(from, to), seconds)
    const figures = {
      tabs: tabs.length,
      seconds: Math.round(seconds * 10) / 10,
      ...stats,
      over_line: overLine(stats),
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
    figures.noisy = (figures.steal?.steal_pct ?? 0) >= 10
    phases[name] = figures
    return figures
  }
  /** Each tab's time to current from `from`, once it connected more than
      `connects[i]` times, its queries and its time from its newest socket. */
  const allTabsCurrent = async (from, connects) => {
    const results = new Map()
    const deadline = from + options.timeoutMs
    while (results.size < tabs.length && Date.now() < deadline) {
      for (const tab of tabs) {
        if (results.has(tab.index) || !tab.tracker.current) continue
        if (tab.tracker.connects <= connects[tab.index]) continue
        if (Date.now() - (tab.tracker.lastFrameAt ?? from) < 300) continue
        results.set(tab.index, {
          index: tab.index,
          view: tab.view,
          queries: tab.tracker.queries.size,
          ms: (tab.tracker.lastFrameAt ?? Date.now()) - from,
          from_socket_ms: tab.tracker.openedAt
            ? (tab.tracker.lastFrameAt ?? Date.now()) - tab.tracker.openedAt
            : null,
          current: true,
        })
      }
      await sleep(20)
    }
    return tabs.map(
      (tab) => results.get(tab.index) ?? { index: tab.index, view: tab.view, current: false },
    )
  }
  try {
    await timed('startup', async () => {
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
    })
    if (options.phases.includes('idle')) {
      const idle = await timed('idle', async () => {
        await sleep(options.idleSeconds * 1000)
        return { seconds_asked: options.idleSeconds }
      })
      const minutes = idle.seconds / 60
      const round = (value) => Math.round(value * 100) / 100
      idle.per_tab_minute = idle.per_tab.map((tab) => ({
        index: tab.index,
        view: tab.view,
        bytes: round(tab.bytes / minutes),
        frames: round(tab.frames / minutes),
        answers: round(
          Object.values(tab.answers).reduce((all, entry) => all + entry.updates, 0) / minutes,
        ),
        answers_by_function: Object.fromEntries(
          Object.entries(tab.answers).map(([name, entry]) => [
            name,
            { updates: round(entry.updates / minutes), bytes: round(entry.bytes / minutes) },
          ]),
        ),
      }))
      idle.backend_per_minute = {
        executions: round(
          Object.values(idle.functions).reduce((all, fn) => all + fn.executions, 0) / minutes,
        ),
        js_ms: round(
          Object.values(idle.functions).reduce((all, fn) => all + fn.js_ms_sum, 0) / minutes,
        ),
        functions: Object.fromEntries(
          Object.entries(idle.functions).map(([name, fn]) => [
            name,
            { executions: round(fn.executions / minutes), js_ms: round(fn.js_ms_sum / minutes) },
          ]),
        ),
      }
    }
    if (options.phases.includes('changes')) {
      // the replay's changes, with this process's tabs in place of the workers
      const local = [
        {
          ask: async (message) => {
            change = message.id
          },
        },
      ]
      const figures = await timed('changes', () => runChanges(options, plan, boardSet, local, log))
      const byKind = {}
      const byView = {}
      for (const done of figures.changes) {
        done.resent_per_tab = tabs.map((tab) => ({
          index: tab.index,
          view: tab.view,
          bytes: tab.perChange.get(done.id)?.bytes ?? 0,
          queries: tab.perChange.get(done.id)?.queries ?? {},
        }))
        byKind[done.kind] = byKind[done.kind] ?? {}
        byView[done.kind] = byView[done.kind] ?? {}
        for (const tab of done.resent_per_tab) {
          const kind = byKind[done.kind]
          kind[tab.index] = [...(kind[tab.index] ?? []), tab.bytes]
          const view = byView[done.kind]
          view[tab.view] = [...(view[tab.view] ?? []), tab.bytes]
        }
      }
      figures.bytes_per_tab_per_change = Object.fromEntries(
        Object.entries(byKind).map(([kind, perTab]) => [
          kind,
          Object.fromEntries(
            Object.entries(perTab).map(([index, bytes]) => [index, spread(bytes)]),
          ),
        ]),
      )
      figures.bytes_per_view_per_change = Object.fromEntries(
        Object.entries(byView).map(([kind, perView]) => [
          kind,
          Object.fromEntries(Object.entries(perView).map(([view, bytes]) => [view, spread(bytes)])),
        ]),
      )
      change = null
    }
    if (options.phases.includes('reconnect'))
      await timed('reconnect', async () => {
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
          client_first_answer_ms: firstAnswerStats(
            tabs.flatMap((tab) => tab.tracker.firstAnswers()),
          ),
          per_tab: results.map((result, i) => ({ ...result, reloaded: reloaded[i] })),
        }
      })
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
      host_cpus: (await import('node:os')).cpus().length,
      at: new Date().toISOString(),
      log_pages: log.pages,
    },
    sources: {
      functions:
        "The local backend's function log stream: per top-level call, JavaScript (userExecutionTime) and total time.",
      bytes:
        "Each tab's received WebSocket frames from Playwright, pings included: an answer's bytes are its value's JSON length, a tab's bytes every frame's UTF-8 length.",
      time_to_current:
        'From the phase start (startup) or the close (reconnect) to the last frame of the first moment the tab was current and quiet for 300 ms; from_socket_ms from the tab making its new backend socket.',
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
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
  for (const part of options.parts) {
    if (part === 'setup') await setup(options)
    else if (part === 'record') await record(options)
    else if (part === 'tabs') await tabsPart(options)
    else await replay(options)
  }
}

if (process.argv[2] === '--worker') await runWorker()
else await main()

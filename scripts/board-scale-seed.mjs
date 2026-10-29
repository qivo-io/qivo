/* Grows the Northstar fixture on a disposable local backend into a large,
 * varied workspace, for checking the Board at scale by hand.
 *
 *   QIVO_FIXTURE_LOCAL=true QIVO_LOCAL_ADMIN_KEY=… \
 *     node scripts/board-scale-seed.mjs --local --deployment local-<name>-<port> \
 *       --url http://127.0.0.1:<port> [--site-url http://localhost:5199] [--tasks 10000] \
 *       [--archived 160] [--inbox 600] [--credentials 45 --api-url http://127.0.0.1:<site port>] \
 *       [--relations]
 *
 * It takes the same loopback-only target as `marketing-demo.mjs --local`, and
 * the same refusals: no deploy key, no staging, production or demo
 * environment, and loopback origins only. Seed Northstar first with
 * `marketing-demo.mjs seed --local`. The tasks are created as Nora, the
 * organization's admin, through issues:create and issues:createParent, one
 * at a time, so every one passes the app's own checks. Their titles read
 * like real work, as long and as wide as Northstar's, so the Board's height
 * estimates meet real text; each task's description names its number. A
 * second run adds only what is still missing, up to --tasks, and finishes a
 * family a stopped run left partial or a smaller --tasks left as tasks of
 * their own. The mix follows the benchmark's varied
 * workspace: every status, a parent with three subtasks every 25th task, a
 * due date every 7th (every other one past), a pause every 31st, a title of
 * the most characters a title holds (LIMITS.title) every 13th and no owner
 * every 11th. `--tasks 0` adds none.
 *
 * A run makes the credentials first, each as the login that makes it in the
 * app, then the tasks as Nora, then archives as Nora, and posts the inbox
 * comments last, each as its poster, so the comments land on tasks that
 * stay active.
 *
 * `--archived <n>` archives the first n seeded tasks that are not parents,
 * which spread over the seeded sub-projects as the tasks do, as Nora through
 * issues:archive without a reason, so every archive writer runs. A run
 * archives only those still active. The workspace leaves archived tasks out,
 * so the seed finds them in the issues table, as the Convex CLI reads a
 * table, with their text from issue_descriptions, and never seeds them
 * again.
 *
 * `--inbox <n>` then gives Nora n inbox items, for checking the Inbox and
 * its bulk actions at scale: on each of the first n seeded tasks that are
 * not archived it posts, through comments:create, one comment that mentions
 * her. A mention about an archived task would arrive read, so those are
 * skipped. Each comment comes from one of the task's sub-project owners who
 * has a login and is not Nora, acting as that login the way the seed acts
 * as Nora, because Nora's mention of herself writes no message and an agent
 * has no login. Each comment's id comes from its task's id, so a rerun
 * posts only on the tasks that have none yet, and a larger --inbox adds
 * items for the next tasks.
 *
 * `--credentials N --api-url <site origin>` also adds up to N API
 * credentials, for paging Settings > API access: every fourth an agent key
 * of one of Northstar's agents, made by Nora, and the rest personal tokens
 * of its people, each made as its owner (tokens:createAgentKey,
 * tokens:createMcpToken). Each new one makes 1 to 4 GET /v1/me calls on the
 * local backend's site origin, so the call path itself writes its usage and
 * aggregates. A second run adds only the credentials still missing. A
 * number counts as made once one of its credentials has all its calls in
 * the usage rows. A stopped run can leave one short, and its secret is
 * gone, so the number gets a new credential under a name no run used before
 * ("(scale N, try 2)", then 3), with all its calls. The seed deletes and
 * changes no credential, so the short one, and any credential a person
 * named the same way, stay as they are.
 *
 * `--relations` adds one task at both per-task caps, for checking the task
 * window's Subtasks, Linked tasks and Attachments at scale (planRelations):
 * a new top-level task in Firmware, "Coordinate the pilot firmware
 * release", In Progress and owned by Aisha, with LIMITS.subtasks.max active
 * subtasks and LIMITS.links.max links, as Nora through issues:create with
 * parent_id and issues:addLink. Its subtasks take every status in turn, so
 * a fifth are Done, and owners Aisha, Leo, Emil, Sofia and Nora in turn,
 * five subtasks each. Every third subtask from the first has 1 to 7 hours
 * left, and a subtask created In Review without hours gets the project's
 * review time, 2 h by default; planRelations answers the Progress and Σ
 * the window should show. The subtasks have 20,000-character descriptions
 * in a three-byte script, and the task one 500 characters shorter, which
 * leaves room to paste images into it. Two tasks share at most one link,
 * so each link goes to a task the seed makes for it, in turn Blocks,
 * Blocked by and Relates to, every status in turn: 70 in Luma Sensor's
 * sub-projects, 15 in Luma Cloud's and Pilot & Launch's, and 15 in
 * Partner pilot, a top-level project the seed makes for Nora alone, so
 * someone who is not an organization admin sees their links left out.
 * Five of the linked tasks are groups with one subtask each. Every id comes
 * from what it is for, so a rerun adds only what is missing. It leaves
 * archived ones as they are, restoring and recreating none, and says how
 * many of the task's subtasks and linked tasks that leaves out. */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { LIMITS } from './limits.mjs'
import { DemoCliError, isLoopbackOrigin, resolveTarget } from './marketing-demo.mjs'
import { readWorkspace } from './workspaceJoin.mjs'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ACTOR = 'nora@demo.qivo.io'
const STATUSES = ['backlog', 'todo', 'progress', 'review', 'done']
const PRIORITIES = ['medium', 'high', 'low', 'medium', 'urgent', 'low', 'medium']
/* Title parts in Northstar's words: a verb, what it acts on and sometimes
   where or when, about 40 characters together as Northstar's titles are. */
const VERBS = [
  'Review',
  'Draft',
  'Validate',
  'Prepare',
  'Measure',
  'Define',
  'Test',
  'Approve',
  'Document',
  'Compare',
  'Build',
  'Tune',
  'Map',
  'Write',
  'Verify',
  'Install',
  'Shortlist',
  'Explore',
  'Agree',
]
const OBJECTS = [
  'the revision B schematic',
  'versioned telemetry payloads',
  'airflow through the enclosure',
  'the pilot assembly instructions',
  'standby power consumption',
  'the setup light patterns',
  'the room comparison dashboard',
  'alert duration thresholds',
  'the customer onboarding guide',
  'alternates for long-lead parts',
  'the antenna matching network',
  'signed firmware rollback',
  'serial labels and setup codes',
  'the pilot support playbook',
  'sensor readings',
  'the end-of-line functional check',
  'the recyclable packaging insert',
  'the beta checklist',
  'radio pre-compliance results',
  'the warm-white enclosure finish',
  'keyboard navigation',
  'notification preferences',
]
const TAILS = [
  '',
  ' for the pilot',
  ' with the reference instrument',
  ' before launch',
  '',
  ' at the three pilot offices',
  ' after reconnecting',
  ' for shared workspaces',
  '',
]
/* What a seeded task's description says, with its number. */
const MARK = 'Seeded by board-scale-seed as task'
/* What the --inbox comments ask Nora after the mention, in Northstar's
   words. */
const ASKS = [
  'can you confirm this before the pilot review?',
  'this needs your sign-off before we order parts.',
  'could you check the numbers here against the reference instrument?',
  'the beta checklist depends on this, can you take a look?',
  'is this still the plan for the three pilot offices?',
]
/* The refusal of a comment whose id is taken (convex/model/comments.ts),
   which a rerun meets on the tasks it already posted on. */
const COMMENT_TAKEN = 'a comment with this id already exists'
/* The most seeded tasks. The app's workspace parts read an organization of
   this size in windows (convex/workspace.ts), each far inside Convex's
   limits, and this keeps the seed's own run a few hours at most. */
const MOST_TASKS = 30_000
/* The most seeded credentials: enough for many API access pages of 25,
   with every call well inside the per-profile request rate. */
const MOST_CREDENTIALS = 500
/* Seeded credential names, by what each one is for, then its number. */
const TOOLS = ['Cursor', 'Raycast', 'Zed', 'Sheets sync', 'Claude Code', 'Notion export']
const JOBS = ['Nightly build', 'Release notes', 'Telemetry import', 'Backup check']
/* What ends a seeded credential's name: its number, and from the second
   credential the seed makes for that number on, which try it is. */
const CREDENTIAL_MARK = /\(scale (\d+)(?:, try (\d+))?\)$/

const ref = (name) => makeFunctionReference(name)

/** The options, or a DemoCliError naming what is wrong. */
export function parseSeedArgs(args) {
  const options = {
    target: null,
    tasks: 10_000,
    archived: 0,
    inbox: 0,
    credentials: 0,
    relations: false,
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = () => {
      const next = args[++i]
      if (next === undefined || next.startsWith('--'))
        throw new DemoCliError(`${arg} needs a value.`)
      return next
    }
    if (arg === '--local') options.target = 'local'
    else if (arg === '--deployment') options.deployment = value()
    else if (arg === '--url') options.url = value()
    else if (arg === '--site-url') options.siteUrl = value()
    else if (arg === '--tasks') options.tasks = Number(value())
    else if (arg === '--archived') options.archived = Number(value())
    else if (arg === '--inbox') options.inbox = Number(value())
    else if (arg === '--credentials') options.credentials = Number(value())
    else if (arg === '--api-url') options.apiUrl = value()
    else if (arg === '--relations') options.relations = true
    else throw new DemoCliError(`Unknown option ${arg}.`)
  }
  if (options.target !== 'local')
    throw new DemoCliError('board-scale-seed writes to a disposable --local backend only.')
  if (!Number.isInteger(options.tasks) || options.tasks < 0 || options.tasks > MOST_TASKS)
    throw new DemoCliError(`--tasks takes a whole number from 0 to ${MOST_TASKS}.`)
  for (const name of ['archived', 'inbox']) {
    const count = options[name]
    if (!Number.isInteger(count) || count < 0 || count > options.tasks)
      throw new DemoCliError(`--${name} takes a whole number from 0 up to the --tasks count.`)
  }
  const credentials = options.credentials
  if (!Number.isInteger(credentials) || credentials < 0 || credentials > MOST_CREDENTIALS)
    throw new DemoCliError(`--credentials takes a whole number from 0 to ${MOST_CREDENTIALS}.`)
  if (credentials > 0 && !isLoopbackOrigin(options.apiUrl ?? ''))
    throw new DemoCliError('--credentials needs --api-url, the local backend site origin.')
  return options
}

/** A lowercase UUID made from `text`, the same for every run, as the
    server requires of a new row's id. */
const uuidOf = (text) => {
  const hex = createHash('sha256').update(text).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The id of the --inbox comment on task `taskId`: the same for every run,
    so a second create of it is refused as taken. */
export const inboxCommentId = (taskId) => uuidOf(`board-scale-seed inbox ${taskId}`)

/** The id of --relations row `what`, such as "project" or "link 40". */
export const relationId = (what) => uuidOf(`board-scale-seed relations ${what}`)

/* The --relations owners, by Northstar person key: of the subtasks, and
   of the linked tasks in Luma Sensor's sub-projects, in Luma Cloud's and
   Pilot & Launch's, and in the seed's Partner pilot, which only Nora sees.
   Each sees and edits the projects their tasks are in. */
const RELATION_OWNERS = {
  subtasks: ['aisha', 'leo', 'emil', 'sofia', 'nora'],
  sensor: ['leo', 'aisha', 'emil', 'sofia'],
  cloud: ['daniel', 'ben', 'sofia'],
  partner: ['nora'],
}
/* Where the --relations linked tasks go, by sub-project key, in turn. */
const RELATION_PLACES = {
  sensor: ['ELEC', 'FW', 'MECH', 'TEST', 'MFG'],
  cloud: ['UX', 'WEB', 'API', 'REL', 'CUST', 'BRAND', 'CS'],
}
/* The project time a task created In Review without hours gets, as
   convex/model/projects.ts reviewHoursFor reads Northstar's projects. */
const REVIEW_HOURS = 2
/* How far under the description cap the --relations task's text stays. */
const FAMILY_ROOM = 500
/* A paragraph in a script whose letters take three UTF-8 bytes each. */
const THREE_BYTE = 'センサーの校正手順を確認し、測定値を記録して、試験結果を共有する。'

/** `length` characters of THREE_BYTE, repeated. */
export function threeByteText(length) {
  return THREE_BYTE.repeat(Math.ceil(length / THREE_BYTE.length)).slice(0, length)
}

/**
 * The --relations work still to do (see the file comment) in organization
 * `org`, given `projects` (sub-project id by key), `people` (profile id by
 * Northstar person key) and the ids the workspace holds already
 * (`present.projects`, `present.tasks`, `present.links`):
 *
 * - `projects`, the projects:create calls of Partner pilot and its
 *   sub-project Field partners;
 * - `tasks`, the issues:create calls, the family first, then its subtasks,
 *   then each linked task, a group's one subtask after it;
 * - `links`, the issues:addLink calls, each as the server stores it;
 * - `expected`, what the family's window shows once all of it is there:
 *   its subtask and link counts, Progress (`done` of `total`) and the Σ of
 *   the unfinished subtasks' hours (`remaining`), which counts the review
 *   time of a subtask created In Review without hours.
 */
export function planRelations({ org, projects, people, present }) {
  const family = relationId('family')
  const partnerRoot = relationId('project')
  const partner = relationId('sub-project')
  const placed = new Map(projects)
  placed.set('PFLD', partner)
  const person = (key) => people.get(key) ?? null
  const plan = { projects: [], tasks: [], links: [] }
  if (!present.projects.has(partnerRoot))
    plan.projects.push({
      id: partnerRoot,
      org_id: org,
      type: 'meta',
      key: 'PART',
      name: 'Partner pilot',
      lead_id: person('nora'),
      sort_order: 100,
    })
  if (!present.projects.has(partner))
    plan.projects.push({
      id: partner,
      org_id: org,
      type: 'project',
      parent_id: partnerRoot,
      key: 'PFLD',
      name: 'Field partners',
      lead_id: person('nora'),
      sort_order: 0,
    })
  const task = (fields) => {
    if (!present.tasks.has(fields.id))
      plan.tasks.push({ org_id: org, priority: 'medium', ...fields })
  }
  task({
    id: family,
    project_id: placed.get('FW'),
    title: 'Coordinate the pilot firmware release',
    // room under the cap for images pasted into it
    description: threeByteText(LIMITS.description.max - FAMILY_ROOM),
    status: 'progress',
    priority: 'high',
    assignee_id: person('aisha'),
  })
  let done = 0
  let remaining = 0
  for (let n = 0; n < LIMITS.subtasks.max; n++) {
    const status = STATUSES[n % STATUSES.length]
    const owners = RELATION_OWNERS.subtasks
    const owner = owners[Math.floor(n / STATUSES.length) % owners.length]
    const hours = n % 3 === 0 ? (n % 7) + 1 : null
    if (status === 'done') done++
    else remaining += hours ?? (status === 'review' ? REVIEW_HOURS : 0)
    task({
      id: relationId(`subtask ${n}`),
      project_id: placed.get('FW'),
      parent_id: family,
      title: seededTitle(n + 2000),
      description: threeByteText(LIMITS.description.max),
      status,
      priority: PRIORITIES[n % PRIORITIES.length],
      assignee_id: person(owner),
      // a reviewer owns a task In Review: the next owner in turn
      reviewer_id: status === 'review' ? person(owners[(owners.indexOf(owner) + 1) % 5]) : null,
      remaining_hours: hours,
    })
  }
  for (let e = 0; e < LIMITS.links.max; e++) {
    const area = e < 70 ? 'sensor' : e < 85 ? 'cloud' : 'partner'
    const key =
      area === 'partner' ? 'PFLD' : RELATION_PLACES[area][e % RELATION_PLACES[area].length]
    const owners = RELATION_OWNERS[area]
    const end = relationId(`linked ${e}`)
    task({
      id: end,
      project_id: placed.get(key),
      title:
        area === 'partner'
          ? `Confirm the Fjordline partner visit ${e - 84}`
          : seededTitle(e + 3000),
      description: `Linked to the pilot firmware release by board-scale-seed, link ${e + 1}.`,
      status: STATUSES[(e + 2) % STATUSES.length],
      assignee_id: person(owners[e % owners.length]),
    })
    // a few linked tasks are groups, each with one subtask
    if (e % 20 === 7)
      task({
        id: relationId(`linked ${e} subtask`),
        project_id: placed.get(key),
        parent_id: end,
        title:
          area === 'partner' ? `Book the Fjordline partner room ${e - 84}` : seededTitle(e + 4000),
        status: 'todo',
        assignee_id: person(owners[e % owners.length]),
      })
    const id = relationId(`link ${e}`)
    if (present.links.has(id)) continue
    // Blocks, Blocked by and Relates to in turn, stored as the server
    // stores them: blocks from its source, relates from the smaller id
    const kind = e % 3
    const [source_id, target_id] =
      kind === 0 ? [family, end] : kind === 1 ? [end, family] : [family, end].sort()
    plan.links.push({
      id,
      org_id: org,
      source_id,
      target_id,
      type: kind === 2 ? 'relates' : 'blocks',
    })
  }
  return {
    ...plan,
    expected: {
      family,
      subtasks: LIMITS.subtasks.max,
      links: LIMITS.links.max,
      done,
      total: LIMITS.subtasks.max,
      remaining: Math.round(remaining * 10) / 10,
    },
  }
}

/** The --inbox comments for `count` of the seeded tasks `present`
    (seededTasks), in seeded order, skipping archived tasks: each with its
    task, the person who posts it, chosen from `posters` (the people with a
    login and not Nora who own work in each project), and its body, which
    mentions `nora`. A task whose project has no such person is skipped. */
export function planInbox(count, present, posters, nora) {
  const out = []
  for (const n of [...present.keys()].sort((a, b) => a - b)) {
    if (out.length === count) break
    const { task } = present.get(n)
    if (task.archived_at) continue
    const people = posters.get(task.project_id) ?? []
    if (!people.length) continue
    out.push({
      task,
      poster: people[n % people.length],
      fields: {
        id: inboxCommentId(task.id),
        org_id: task.org_id,
        issue_id: task.id,
        body: `@[${nora.name}](user:${nora.id}) ${ASKS[n % ASKS.length]}`,
      },
    })
  }
  return out
}

/** A credential secret as the app mints one (src/store/planner.ts
    mintCredential), with its id and its SHA-256 hash. */
async function mintCredential(scheme) {
  const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  const secret = `${scheme}_${hex(crypto.getRandomValues(new Uint8Array(24)))}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return { id: crypto.randomUUID(), secret, hash: hex(new Uint8Array(digest)) }
}

/** Every row of `table` as the local admin reads it, page by page. */
async function tableRows(client, table) {
  const rows = []
  for (let cursor = null; ; ) {
    const page = await client.query(ref('_system/cli/tableData'), {
      table,
      order: 'asc',
      paginationOpts: { cursor, numItems: 1000 },
    })
    rows.push(...page.page)
    if (page.isDone !== false) return rows
    cursor = page.continueCursor
  }
}

/** `calls` GET /v1/me calls with `secret` on `apiUrl`, waiting out a
    refused minute (Retry-After) and refusing any other answer. */
async function callApi(apiUrl, secret, calls) {
  for (let made = 0; made < calls; ) {
    const res = await fetch(`${apiUrl}/v1/me`, { headers: { Authorization: `Bearer ${secret}` } })
    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After') ?? '60')
      await new Promise((done) => setTimeout(done, Math.max(1, wait) * 1000))
      continue
    }
    if (!res.ok) throw new DemoCliError(`GET /v1/me answered ${res.status}.`)
    made++
  }
}

/** The calls the seed makes with seeded credential number `n`. */
const plannedCalls = (n) => 1 + (n % 4)

/** Adds the seeded credentials still missing up to `count` in organization
    `org` (see the file comment), acting as `actor` or as each token's
    owner with the local admin key `key`, and answers how many it added. A
    number is made when one of its credentials has all its calls in the
    usage rows; one that is not gets a credential named with its next try. */
export async function seedCredentials(client, { key, org, actor, count, apiUrl, log }) {
  // the system tables answer the admin itself, not a person it acts as
  client.setAdminAuth(key)
  const profiles = (await tableRows(client, 'profiles')).filter(
    (profile) => profile.org_id === org && profile.active,
  )
  const people = profiles.filter((profile) => profile.kind === 'person' && profile.auth_user_id)
  const agents = profiles.filter((profile) => profile.kind === 'agent')
  const members = new Set(profiles.map((profile) => profile.id))
  // the calls each credential made, as its usage rows record them
  const used = new Map()
  for (const row of await tableRows(client, 'billing_usage'))
    if (row.org_id === org)
      used.set(row.credential_id, (used.get(row.credential_id) ?? 0) + row.calls)
  // each number's highest try so far, and whether one of them made all its calls
  const seeded = new Map()
  for (const table of ['mcp_tokens', 'agent_keys'])
    for (const row of await tableRows(client, table)) {
      const mark = CREDENTIAL_MARK.exec(row.name)
      const number = Number(mark?.[1])
      if (!mark || !number || !members.has(row.profile_id)) continue
      const known = seeded.get(number) ?? { tries: 0, done: false }
      seeded.set(number, {
        tries: Math.max(known.tries, Number(mark[2] ?? 1)),
        done: known.done || (used.get(`${table}:${row.id}`) ?? 0) >= plannedCalls(number),
      })
    }
  const as = (profile) => client.setAdminAuth(key, identityOf(profile.auth_user_id))
  let added = 0
  for (let n = 1; n <= count; n++) {
    const known = seeded.get(n) ?? { tries: 0, done: false }
    if (known.done) continue
    // a credential of this number without all its calls keeps its name and
    // its calls; the new one is named with the next try
    const attempt = known.tries + 1
    const mark = attempt === 1 ? `(scale ${n})` : `(scale ${n}, try ${attempt})`
    const agent = n % 4 === 0 && agents.length ? agents[(n / 4) % agents.length] : null
    const minted = await mintCredential(agent ? 'qva' : 'qvt')
    try {
      if (agent) {
        as(actor)
        await client.mutation(ref('tokens:createAgentKey'), {
          org_id: org,
          id: minted.id,
          agent_id: agent.id,
          name: `${JOBS[n % JOBS.length]} ${mark}`,
          key_prefix: `${minted.secret.slice(0, 7)}...${minted.secret.slice(-5)}`,
          key_hash: minted.hash,
        })
      } else {
        const owner = people[n % people.length]
        as(owner)
        await client.mutation(ref('tokens:createMcpToken'), {
          id: minted.id,
          profile_id: owner.id,
          name: `${TOOLS[n % TOOLS.length]} ${mark}`,
          token_prefix: minted.secret.slice(0, 11),
          token_hash: minted.hash,
          access: n % 3 ? 'read' : 'write',
        })
      }
    } catch (error) {
      throw new DemoCliError(
        `a seeded credential was refused: ${error.data?.message ?? error.message}`,
      )
    }
    await callApi(apiUrl, minted.secret, plannedCalls(n))
    added++
  }
  as(actor)
  log(`${added} seeded credentials added, with their calls.`)
  return added
}

/** A date `days` from today, as the app stores due dates. */
const day = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

/** The `n`th title the seed writes: a verb, an object and a tail, taken
    at different strides so neighbours differ. */
export function seededTitle(n) {
  const part = (k) =>
    `${VERBS[(n + k) % VERBS.length]} ${OBJECTS[((n + k) * 5 + Math.floor((n + k) / VERBS.length)) % OBJECTS.length]}${TAILS[(n + k) % TAILS.length]}`
  if (n % 13) return part(0)
  // the most characters a title holds, in clauses, cut at a word
  let title = part(0)
  for (let k = 1; title.length < LIMITS.title.max; k++)
    title += `, then ${part(k * 7).replace(/^\S+/, (verb) => verb.toLowerCase())}`
  const cut = title.slice(0, LIMITS.title.max + 1)
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[, ]+$/, '')
}

/** The task fields of the `n`th seeded task in `org`'s `project`, owned by `owner`. */
export function seededTask(n, org, project, owner) {
  const status = STATUSES[n % STATUSES.length]
  return {
    id: crypto.randomUUID(),
    org_id: org,
    project_id: project,
    title: seededTitle(n),
    description: `${MARK} ${n + 1}.`,
    status,
    priority: PRIORITIES[n % PRIORITIES.length],
    assignee_id: n % 11 === 0 ? null : owner,
    due_date: n % 7 === 0 ? day(Math.floor(n / 7) % 2 ? -((n % 40) + 1) : (n % 40) + 1) : null,
    paused: n % 31 === 0 && status !== 'backlog' && status !== 'done',
  }
}

/** The seeded tasks in `issues` by number, each with its parent's id or
    null: from the description's mark, or the title an earlier version of
    the seed wrote ("Board scale ship task 12"). */
export function seededTasks(issues) {
  const found = new Map()
  const marked = new RegExp(`^${MARK} (\\d+)\\.$`)
  for (const task of issues) {
    const match =
      marked.exec(task.description ?? '') ??
      /^Board scale (?!parent)\S+ task (\d+)/.exec(task.title)
    if (match) found.set(Number(match[1]) - 1, { task, parent: task.parent_id ?? null })
  }
  return found
}

/** The ids of the seeded tasks to archive so that the first `count` seeded
    tasks that are not parents are archived: `seeded` holds every seeded
    task by number (seededTasks), and `parents` the ids of tasks with
    subtasks. A task archived already needs nothing. */
export function planArchive(count, seeded, parents) {
  const ids = []
  let taken = 0
  for (const n of [...seeded.keys()].sort((a, b) => a - b)) {
    if (taken === count) break
    const { task } = seeded.get(n)
    if (parents.has(task.id)) continue
    taken++
    if (!task.archived_at) ids.push(task.id)
  }
  return ids
}

/** The archived tasks of organization `org`, which the workspace leaves
    out, read as the Convex CLI reads a table, each with its text: its
    description row's, as the app reads it, or issues.description for a
    task without one. Descriptions release 3 stops writing
    issues.description, so the rows hold the seed's marks then. */
export async function archivedTasksOf(client, org) {
  const archived = (await tableRows(client, 'issues')).filter(
    (row) => row.org_id === org && row.archived_at,
  )
  if (!archived.length) return archived
  const texts = new Map()
  for (const row of await tableRows(client, 'issue_descriptions'))
    if (row.org_id === org && !texts.has(row.issue_id)) texts.set(row.issue_id, row.description)
  return archived.map((row) =>
    texts.has(row.id) ? { ...row, description: texts.get(row.id) } : row,
  )
}

/** The work still to do for `tasks` seeded ones, given the `present` ones
    (seededTasks): one job per missing task, and one per family (every 25th
    task, its parent and the three tasks after it) that is not complete. A
    family job names the parts it lacks, so a run that stopped partway
    through a family is finished, under the parent it already made:
    `head` when its first task is missing (else `existing` is that task),
    `parent` the existing parent's id (null when it still needs one),
    `missing` the subtasks to add and `attach` the existing ones not yet
    under that parent, such as tasks a run with a smaller --tasks seeded
    on their own. */
export function planSeed(tasks, present) {
  const list = []
  let added = 0
  for (let n = 0; n < tasks; n++) {
    const family = n % 25 === 0 && n + 3 < tasks
    if (!family) {
      if (!present.has(n)) {
        list.push({ first: n, family: false })
        added++
      }
      continue
    }
    const head = !present.has(n)
    const parent = present.get(n)?.parent ?? null
    const missing = [1, 2, 3].filter((k) => !present.has(n + k))
    const attach = [1, 2, 3]
      .map((k) => present.get(n + k))
      .filter((sibling) => sibling && (!parent || sibling.parent !== parent))
      .map((sibling) => sibling.task)
    if (head || !parent || missing.length || attach.length) {
      list.push({
        first: n,
        family: true,
        head,
        existing: present.get(n)?.task ?? null,
        parent,
        missing,
        attach,
      })
      added += Number(head) + missing.length
    }
    n += 3
  }
  return { list, added }
}

/** Seeds the backend `args` name, writing progress through `log`. */
export async function runBoardScaleSeed(args, { env = process.env, log = console.log } = {}) {
  const options = parseSeedArgs(args)
  const target = resolveTarget(options, env)
  const client = new ConvexHttpClient(target.url, { logger: false })
  client.setAdminAuth(target.key)
  // The local admin reads the actor's login as the Convex CLI reads a table.
  const people = await client.query(ref('_system/cli/tableData'), {
    table: 'profiles',
    order: 'asc',
    paginationOpts: { cursor: null, numItems: 1000 },
  })
  const actor = people.page.find((profile) => profile.email === ACTOR && profile.auth_user_id)
  if (!actor) throw new DemoCliError('Seed Northstar first: marketing-demo.mjs seed --local.')
  // the workspace leaves archived tasks out, and the links to them, so the
  // admin reads them here
  const archived = await archivedTasksOf(client, actor.org_id)
  const storedLinks = options.relations ? await linkIdsOf(client, actor.org_id) : new Set()
  client.setAdminAuth(target.key, identityOf(actor.auth_user_id))
  const snapshot = await readWorkspace((name, args) => client.query(ref(name), args))
  const org = snapshot.orgs.find((o) => o.id === actor.org_id)?.id
  if (!org) throw new DemoCliError('Nora cannot see Northstar; seed it again.')
  // Northstar's own rows: the snapshot holds every organization Nora is in
  const joined = (name) =>
    [...snapshot[name], ...(snapshot.more?.[name] ?? []).flat()].filter((row) => row.org_id === org)
  const issues = joined('issues')
  // the sub-projects that hold tasks, each with the owners its tasks have
  const owners = new Map()
  for (const project of joined('projects'))
    if (project.type === 'project' && !project.archived_at) owners.set(project.id, new Set())
  for (const issue of issues)
    if (issue.assignee_id && owners.has(issue.project_id))
      owners.get(issue.project_id).add(issue.assignee_id)
  const projects = [...owners.keys()]
  if (!projects.length) throw new DemoCliError('Northstar has no sub-projects to fill.')
  if (options.credentials > 0)
    await seedCredentials(client, {
      key: target.key,
      org,
      actor,
      count: options.credentials,
      apiUrl: new URL(options.apiUrl).origin,
      log,
    })
  // a task an earlier run archived is seeded already
  const seeded = seededTasks([...issues, ...archived])
  const jobs = planSeed(options.tasks, seeded)
  log(`${jobs.added} seeded tasks to add in ${projects.length} sub-projects.`)
  let made = 0
  for (const job of jobs.list) {
    const project = projects[job.first % projects.length]
    const people = [...owners.get(project)]
    const owner = people.length ? people[job.first % people.length] : actor.id
    const head = seededTask(job.first, org, project, owner)
    // a family's existing head keeps its own id, project and owner
    const existing = job.family ? job.existing : null
    const parent = job.parent ?? crypto.randomUUID()
    const subtaskOwner = (existing ? existing.assignee_id : head.assignee_id) ?? actor.id
    const familyProject = existing?.project_id ?? project
    const calls = job.family
      ? [
          ...(job.head ? [['issues:create', head]] : []),
          ...(job.parent
            ? []
            : [
                [
                  'issues:createParent',
                  {
                    id: existing?.id ?? head.id,
                    org_id: org,
                    parent_id: parent,
                    title: `Coordinate ${OBJECTS[job.first % OBJECTS.length]}`,
                  },
                ],
              ]),
          ...job.missing.map((k) => [
            'issues:create',
            {
              ...seededTask(job.first + k, org, familyProject, subtaskOwner),
              number: job.first + k,
              parent_id: parent,
            },
          ]),
          // a subtask stays in its parent's top-level project, so one seeded
          // on its own elsewhere moves to the family's sub-project first
          ...job.attach.flatMap((task) => [
            ...(task.project_id === familyProject
              ? []
              : [
                  [
                    'issues:move',
                    { id: task.id, org_id: org, project_id: familyProject, detach_parent: true },
                  ],
                ]),
            ['issues:update', { id: task.id, org_id: org, patch: { parent_id: parent } }],
          ]),
        ]
      : [['issues:create', head]]
    for (const [name, call] of calls) {
      // a subtask's call names its number, which the server is not sent
      const { number = job.first, ...fields } = call
      try {
        await client.mutation(ref(name), fields)
      } catch (error) {
        throw new DemoCliError(
          `${name} refused task "${fields.title ?? fields.id}": ${error.data?.message ?? error.message}`,
        )
      }
      if (name !== 'issues:create') continue
      seeded.set(number, { task: { id: fields.id }, parent: fields.parent_id ?? null })
      if (++made % 500 === 0) log(`${made} seeded tasks added`)
    }
  }
  log(`Done: ${made} seeded tasks added in Northstar on ${target.url}.`)
  if (options.relations)
    await seedRelations({
      client,
      org,
      snapshot,
      joined,
      archived,
      storedLinks,
      people: people.page,
      actor,
      target,
      log,
    })
  if (options.archived > 0) {
    const parents = new Set([...issues, ...archived].map((task) => task.parent_id).filter(Boolean))
    await seedArchive(planArchive(options.archived, seeded, parents), { client, org, target, log })
  }
  if (options.inbox > 0)
    await seedInbox(options.inbox, { client, target, people: people.page, actor, org, log })
}

/** The ids of every link row of organization `org`, as the local admin
    reads the table: the workspace leaves out a link to an archived task,
    whose id stays taken. */
async function linkIdsOf(client, org) {
  return new Set(
    (await tableRows(client, 'issue_links')).filter((l) => l.org_id === org).map((l) => l.id),
  )
}

/* Adds the --relations rows still missing (planRelations) through
   `client`, which acts as Nora, reading what is there from the workspace
   `snapshot` Nora sees, the `archived` tasks and `storedLinks` link ids the
   admin read, and the Northstar people by their demo addresses. Archived
   work stays as it is: the seed restores and recreates none of it, and
   says what that leaves out of the task's lists. */
async function seedRelations({
  client,
  org,
  snapshot,
  joined,
  archived,
  storedLinks,
  people,
  actor,
  target,
  log,
}) {
  const archivedIds = new Set(archived.map((task) => task.id))
  if (archivedIds.has(relationId('family'))) {
    log('The --relations task is archived; the seed leaves it and its rows as they are.')
    return
  }
  const projects = joined('projects')
  const byKey = new Map(
    projects
      .filter((project) => project.type === 'project')
      .map((project) => [project.key, project.id]),
  )
  const keys = new Map(
    people
      .filter((profile) => profile.org_id === org && profile.email?.endsWith('@demo.qivo.io'))
      .map((profile) => [profile.email.split('@')[0], profile.id]),
  )
  keys.set('nora', actor.id)
  const plan = planRelations({
    org,
    projects: byKey,
    people: keys,
    present: {
      projects: new Set(projects.map((project) => project.id)),
      tasks: new Set([...joined('issues').map((task) => task.id), ...archivedIds]),
      // a link row in the workspace carries no organization; Nora sees only
      // her own links
      links: new Set([
        ...[...snapshot.links, ...(snapshot.more?.links ?? []).flat()].map((l) => l.id),
        ...storedLinks,
      ]),
    },
  })
  // what archiving took out of the task's lists, which stays out
  const whole = planRelations({
    org,
    projects: byKey,
    people: keys,
    present: { projects: new Set(), tasks: new Set(), links: new Set() },
  })
  const family = whole.expected.family
  const gone = {
    subtasks: whole.tasks.filter((t) => t.parent_id === family && archivedIds.has(t.id)).length,
    links: whole.links.filter((l) =>
      archivedIds.has(l.source_id === family ? l.target_id : l.source_id),
    ).length,
  }
  if (gone.subtasks || gone.links)
    log(
      `${gone.subtasks} of its subtasks and ${gone.links} of its linked tasks are archived, and the seed leaves them so.`,
    )
  log(
    `${plan.projects.length} projects, ${plan.tasks.length} tasks and ${plan.links.length} links to add for --relations.`,
  )
  const calls = [
    ...plan.projects.map((fields) => ['projects:create', fields]),
    ...plan.tasks.map((fields) => ['issues:create', fields]),
    ...plan.links.map((fields) => ['issues:addLink', fields]),
  ]
  for (const [name, fields] of calls) {
    try {
      await client.mutation(ref(name), fields)
    } catch (error) {
      throw new DemoCliError(
        `${name} refused "${fields.title ?? fields.name ?? fields.id}": ${error.data?.message ?? error.message}`,
      )
    }
  }
  const { expected } = plan
  const shown = {
    subtasks: expected.subtasks - gone.subtasks,
    links: expected.links - gone.links,
  }
  log(
    gone.subtasks || gone.links
      ? `Done: the task ${expected.family} has ${shown.subtasks} active subtasks and ${shown.links} links to active tasks on ${target.url}.`
      : `Done: the task ${expected.family} has ${expected.subtasks} subtasks and ${expected.links} links on ${target.url}; its window shows ${expected.done} of ${expected.total} tasks done and Σ ${expected.remaining}h.`,
  )
  // The app's task windows range over window keys, which the server sets
  // at random (convex/lib/db.ts newWindowKey), so the task's key, not its
  // id, says which stage of a staged load brings it.
  client.setAdminAuth(target.key)
  const row = (await tableRows(client, 'issues')).find((task) => task.id === expected.family)
  client.setAdminAuth(target.key, identityOf(actor.auth_user_id))
  if (row?.window_key) log(windowKeyNote(row.window_key))
}

/** What the seed says of the --relations task's window key `key`: how far
    into the key space it is. A workspace that loads in stages watches its
    task windows from the lowest keys up (src/store/liveParts.ts STAGES). */
export function windowKeyNote(key) {
  const share = Math.round((Number.parseInt(key, 16) / 2 ** 32) * 100)
  return `Its window key is ${key}, ${share}% into the key space. A workspace that loads in stages watches its task windows from the lowest keys up, so a lower key arrives in an earlier stage.`
}

/* Archives the tasks `ids` (planArchive) through `client`, which acts as
   Nora. */
async function seedArchive(ids, { client, org, target, log }) {
  log(`${ids.length} seeded tasks to archive.`)
  for (const [i, id] of ids.entries()) {
    try {
      await client.mutation(ref('issues:archive'), { id, org_id: org })
    } catch (error) {
      throw new DemoCliError(
        `issues:archive refused task ${id}: ${error.data?.message ?? error.message}`,
      )
    }
    if ((i + 1) % 100 === 0) log(`${i + 1} seeded tasks archived`)
  }
  log(`Done: ${ids.length} seeded tasks archived in Northstar on ${target.url}.`)
}

/* Posts the --inbox comments (planInbox) on the seeded tasks as they are
   now, which `client` reads as Nora, each comment as its poster's login. */
async function seedInbox(count, { client, target, people, actor, org, log }) {
  const snapshot = await readWorkspace((name, args) => client.query(ref(name), args))
  const joined = (name) =>
    [...snapshot[name], ...(snapshot.more?.[name] ?? []).flat()].filter((row) => row.org_id === org)
  const live = new Set(
    joined('projects')
      .filter((project) => project.type === 'project' && !project.archived_at)
      .map((project) => project.id),
  )
  const issues = joined('issues').filter((issue) => live.has(issue.project_id))
  // the people with a login, other than Nora, who own work in each project
  const logins = new Map(
    people
      .filter(
        (p) =>
          p.org_id === org &&
          p.auth_user_id &&
          p.id !== actor.id &&
          p.active !== false &&
          p.org_role !== 'viewer',
      )
      .map((p) => [p.id, p]),
  )
  const posters = new Map()
  for (const issue of issues) {
    const poster = logins.get(issue.assignee_id)
    if (!poster) continue
    const list = posters.get(issue.project_id) ?? []
    if (!list.includes(poster)) list.push(poster)
    posters.set(issue.project_id, list)
  }
  const nora = people.find((p) => p.id === actor.id)
  const plan = planInbox(count, seededTasks(issues), posters, nora)
  if (plan.length < count)
    log(`Only ${plan.length} seeded tasks can hold an inbox item for Nora; posting on those.`)
  const clients = new Map()
  const clientOf = (poster) => {
    let as = clients.get(poster.auth_user_id)
    if (!as) {
      as = new ConvexHttpClient(target.url, { logger: false })
      as.setAdminAuth(target.key, identityOf(poster.auth_user_id))
      clients.set(poster.auth_user_id, as)
    }
    return as
  }
  let posted = 0
  for (const { task, poster, fields } of plan) {
    try {
      await clientOf(poster).mutation(ref('comments:create'), fields)
    } catch (error) {
      // a rerun meets the comments it posted before
      if (error.data?.message === COMMENT_TAKEN) continue
      throw new DemoCliError(
        `comments:create refused a comment on "${task.title}": ${error.data?.message ?? error.message}`,
      )
    }
    if (++posted % 100 === 0) log(`${posted} inbox comments posted`)
  }
  log(`Done: ${posted} inbox comments posted for Nora, ${plan.length - posted} there before.`)
}

/** The identity the local admin key acts with as login `subject`. */
const identityOf = (subject) => ({
  subject,
  issuer: 'board-scale-seed',
  tokenIdentifier: `board-scale-seed|${subject}`,
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const envFile = join(PROJECT_ROOT, '.env.local')
    if (existsSync(envFile)) process.loadEnvFile(envFile)
    await runBoardScaleSeed(process.argv.slice(2))
  } catch (error) {
    console.error(
      `board-scale-seed: ${error instanceof DemoCliError ? error.message : 'The seed could not complete; raw errors are withheld to keep secrets out of logs.'}`,
    )
    process.exitCode = 1
  }
}

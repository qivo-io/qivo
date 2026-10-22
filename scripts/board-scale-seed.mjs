/* Grows the Northstar fixture on a disposable local backend into a large,
 * varied workspace, for checking the Board at scale by hand.
 *
 *   QIVO_FIXTURE_LOCAL=true QIVO_LOCAL_ADMIN_KEY=… \
 *     node scripts/board-scale-seed.mjs --local --deployment local-<name>-<port> \
 *       --url http://127.0.0.1:<port> [--site-url http://localhost:5199] [--tasks 10000]
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
 * family a stopped run left partial. The mix follows the benchmark's varied
 * workspace: every status, a parent with three subtasks every 25th task, a
 * due date every 7th (every other one past), a pause every 31st, a title of
 * the most characters a title holds (LIMITS.title) every 13th and no owner
 * every 11th. */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { LIMITS } from './limits.mjs'
import { DemoCliError, resolveTarget } from './marketing-demo.mjs'

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
/* The most seeded tasks. At 10,000 tasks and their 400 parents
   snapshot:forMe already runs close to Convex's 1s limit on a local
   backend, so a larger organization would no longer load. */
const MOST_TASKS = 10_000

const ref = (name) => makeFunctionReference(name)

/** The options, or a DemoCliError naming what is wrong. */
export function parseSeedArgs(args) {
  const options = { target: null, tasks: 10_000 }
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
    else throw new DemoCliError(`Unknown option ${arg}.`)
  }
  if (options.target !== 'local')
    throw new DemoCliError('board-scale-seed writes to a disposable --local backend only.')
  if (!Number.isInteger(options.tasks) || options.tasks < 1 || options.tasks > MOST_TASKS)
    throw new DemoCliError(`--tasks takes a whole number from 1 to ${MOST_TASKS}.`)
  return options
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

/** The work still to do for `tasks` seeded ones, given the `present` ones
    (seededTasks): one job per missing task, and one per family (every 25th
    task, its parent and the three tasks after it) that is not complete. A
    family job names the parts it lacks, so a run that stopped partway
    through a family is finished, under the parent it already made:
    `head` when its first task is missing (else `existing` is that task),
    `parent` the existing parent's id (null when it still needs one) and
    `missing` the subtasks to add. */
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
    if (head || !parent || missing.length) {
      list.push({
        first: n,
        family: true,
        head,
        existing: present.get(n)?.task ?? null,
        parent,
        missing,
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
  client.setAdminAuth(target.key, {
    subject: actor.auth_user_id,
    issuer: 'board-scale-seed',
    tokenIdentifier: `board-scale-seed|${actor.auth_user_id}`,
  })
  const snapshot = await client.query(ref('snapshot:forMe'), {})
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
  const jobs = planSeed(options.tasks, seededTasks(issues))
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
              ...seededTask(job.first + k, org, existing?.project_id ?? project, subtaskOwner),
              parent_id: parent,
            },
          ]),
        ]
      : [['issues:create', head]]
    for (const [name, fields] of calls) {
      try {
        await client.mutation(ref(name), fields)
      } catch (error) {
        throw new DemoCliError(
          `${name} refused task "${fields.title}": ${error.data?.message ?? error.message}`,
        )
      }
      if (name === 'issues:create' && ++made % 500 === 0) log(`${made} seeded tasks added`)
    }
  }
  log(`Done: ${made} seeded tasks added in Northstar on ${target.url}.`)
}

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

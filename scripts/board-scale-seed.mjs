/* Grows the Northstar fixture on a disposable local backend into a large,
 * varied workspace, for checking the Board at scale by hand.
 *
 *   QIVO_FIXTURE_LOCAL=true QIVO_LOCAL_ADMIN_KEY=… \
 *     node scripts/board-scale-seed.mjs --local --deployment local-<name>-<port> \
 *       --url http://127.0.0.1:<port> [--site-url http://localhost:5199] [--tasks 10000] \
 *       [--sub-project FW] [--archived 160] [--deleted 70] [--inbox 600] \
 *       [--credentials 45 --api-url http://127.0.0.1:<site port>] [--relations] \
 *       [--api-accounts 90 --api-url http://127.0.0.1:<site port>] \
 *       [--labels 60] [--files 60] [--images 100] [--pictures] [--projects 200] [--thread 300]
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
 * their own. The mix follows the benchmark's varied workspace: every
 * status, a parent over every 25th task and the three after it, a due date
 * every 7th (every other one past), a pause every 31st, a title of the most
 * characters a title holds (LIMITS.title) every 13th and no owner every
 * 11th. `--tasks 0` adds none.
 *
 * `--sub-project <key or name>` puts the tasks a run adds into that one
 * live sub-project instead of spreading them over all of them, for
 * checking a sub-project's Board at its 1,000-task ceiling: the ceiling
 * counts each task without subtasks, so a family adds four tasks it counts
 * and a parent it does not. The tasks an earlier run made stay where they
 * are, and a family an earlier run started finishes in its first task's
 * sub-project.
 *
 * A run makes the credentials first, each as the login that makes it in the
 * app, then the tasks as Nora, then archives as Nora, and posts the inbox
 * comments last, each as its poster, so the comments land on tasks that
 * stay active.
 *
 * `--archived <n>` archives the first n seeded tasks that are neither
 * parents nor in Deleted items, which spread over the seeded sub-projects
 * as the tasks do, as Nora through
 * issues:archive without a reason, so every archive writer runs. A run
 * archives only those still active. The workspace leaves archived tasks out,
 * so the seed finds them in the issues table, as the Convex CLI reads a
 * table, with their text from issue_descriptions, and never seeds them
 * again.
 *
 * `--deleted <n>` then moves the first n seeded tasks that are neither
 * parents, in a family nor archived to Deleted items, for checking Deleted
 * items past
 * its pages of 25: as Nora through issues:deleteDeep, every third as Leo
 * Martins, who has a login in Northstar and leads Luma Sensor, where he
 * leads the task's top-level project (Nora deletes the rest of those), and
 * every seventh through issues' REST delete with an agent key of Atlas,
 * which Nora makes for the run, when --api-url names the local backend's
 * site origin. It also makes the sub-project "Retired bench fixtures" with
 * three tasks under the live top-level project that holds the fewest
 * sub-projects and deletes it whole as Nora through projects:deleteDeep, so
 * the list holds a project item and its tasks. A run deletes only what is
 * still live, read as the run left them, so a task it archived stays
 * archived, and makes the sub-project only while no row or used id holds
 * its id. Every run, with or without --deleted, reads the tasks Deleted
 * items stores (deleted_tasks), so no later run seeds them again or
 * archives them. Northstar's own tasks stay as they are.
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
 * `--api-accounts N --api-url <site origin>` adds up to N agents with API
 * calls, for checking Billing's API calls by account and its two name
 * lists past their first batch of 25 (planApiAccounts). As Nora it makes
 * each agent through profiles:create (kind agent, role user, a palette
 * color), named as an agent is ("Backup checker 03", "Support triage bot 04"
 * and so on), the first with an accent ("Zoë relay 01") and the second with a
 * word no other name holds ("Quillon importer 02"), for the lists'
 * searches. It gives each one agent key through tokens:createAgentKey and
 * makes 1 to 7 GET /v1/me calls with it on the local backend's site
 * origin, so the call path itself writes the usage and the aggregates, and
 * then sets every third agent inactive through profiles:deactivate, so at
 * N of about 90 both Who counts toward your bill and Who does not count
 * toward your bill hold more than 25 names. Every agent's id comes from
 * its number, and so does its keys' name ("Billing load key 01"). A
 * second run adds only what is missing. It counts toward an agent's calls
 * only those its own keys made in the bucket Billing shows now
 * (billing.usageFigures' period_key, read as Nora), never those of an
 * earlier month or period or of another credential, such as one
 * --credentials gave it. An agent that is there keeps its profile, one
 * with all its calls gets no new key, one short of them gets a new key and
 * only the calls it lacks, so a run in a later month gives each active
 * agent a new key and its calls there, and one already inactive is left
 * as it is, with no calls in a later bucket. One removed through Users,
 * for checking how Billing names a Removed user, stays removed, since its
 * usage or its pending removal keeps its id taken, and the run logs its
 * name. N goes up to 100 (MOST_API_ACCOUNTS), and a larger N is refused
 * before anything is seeded. It runs after --credentials and before the
 * tasks.
 *
 * `--labels N` adds up to N labels to Northstar, for checking Settings >
 * Labels past its first batch of 25 (LIST_BATCH). Each is made by Nora through
 * labels:create, with a name a team would give one ("Field test 01",
 * "Supplier review 01" and so on, ten topics in turn, then each again
 * with the next number) and a color of the palette in turn, and put on a
 * few tasks through labels:toggle, label n on n % 4 of them, so the counts
 * differ and every fourth label is on none. The tasks are the seeded ones
 * still active, or Northstar's own active tasks where the run holds none
 * (--tasks 0), in their order, and a task never passes LIMITS.labels.max.
 * Each label's id comes from its number. A label whose id Northstar holds
 * counts as made under whatever name a person gave it since, and so does a
 * name Northstar holds in any case, so a second run adds only what is
 * missing and puts a label on a task only once. It runs after the tasks
 * and --relations and before --archived.
 *
 * `--files N` adds up to N sub-projects with one task and one small file
 * each, for checking Billing's Storage by project past its first batch of
 * 25 (planFiles). Nora makes each sub-project through projects:create,
 * under the live top-level project of Northstar that holds the fewest
 * live sub-projects, never more than 30 under one (the design size), then
 * its task through issues:create, then uploads its file through the app's
 * own path, files:uploadUrl, a POST of the bytes to that URL on the local
 * backend and files:attach, so the stored-byte totals count it as an
 * attach does. N goes up to 78, the places Northstar's three top-level
 * projects have left beside their 12 sub-projects. A run whose new
 * sub-projects do not fit in the places left refuses before it seeds
 * anything and says how many are left. Each file has its own size, from
 * about 1 KB to 98 KB, so the list's order shows. The first
 * sub-project's name has an accent ("Café pilot photos") and the second's
 * a word no other name has ("Zephyrine bench archive"), for checking the
 * list's search; the rest are named after what their files hold, with a
 * number. Every id comes from its number. A sub-project, task or file the
 * backend holds anywhere, archived or in Deleted items included, counts as
 * made, and so does a sub-project or task deleted for good, whose id
 * used_ids keeps, so a second run adds only what is missing and never
 * makes again a sub-project or task that a check archived or deleted. A
 * task goes only into a sub-project that has its row or that the run
 * makes, and a file only onto such a task, so a sub-project or task in
 * Deleted items or deleted for good gets no new task or file. A file
 * removed in the task window is made again on its task, since no table
 * keeps a removed attachment's id. Pass `--tasks 0` to add none of the
 * Board's tasks. It runs after --relations and before --labels.
 *
 * `--images N` gives one new task of Northstar, "Review the bench rig
 * photos" in the first live sub-project the tasks fill, N small images in
 * its description (N up to LIMITS.attachments.max, the per-task limit),
 * for checking how description images load as they come near view. Nora
 * makes the task through issues:create, uploads each image through the
 * app's own path, files:uploadUrl, a POST of a 640 by 480 PNG to that URL
 * on the local backend and files:attach with inline set, then saves a
 * description through issues:update that shows them one a paragraph, with
 * a paragraph of text between. Every id comes from its number, so a second
 * run uploads only the images missing and saves the description again,
 * and a task a check archived or deleted, or one in a project a check
 * archived, gets nothing. It runs after --files.
 *
 * `--pictures` gives every active person and agent of Northstar without a
 * picture one, for checking how profile pictures load: as Nora, an admin
 * who may set anyone's, through files:avatarUploadUrl, a POST of a
 * 256-pixel PNG of about 20 KB to that URL on the local backend and
 * files:setAvatar, as the app's picture editor does. A second run gives
 * pictures only to those still without one. It runs after --images.
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
 * many of the task's subtasks and linked tasks that leaves out.
 *
 * `--projects N` makes Northstar hold up to N live top-level projects in
 * all, for checking the All projects directory at the design size's 200
 * (planProjects): Northstar's three, --relations' Partner pilot and every
 * other live top-level project count toward N, and Nora makes the rest
 * through projects:create, each led by her, with no sub-project. Their
 * names read as rollouts a team would plan ("Office pilot 03"), the first
 * with an accent ("Café network pilot") and the second with a word no other
 * name holds ("Vantorre depot trial"), for the directory's search. Every
 * id comes from its number, and an id the backend holds anywhere, archived
 * or in Deleted items included, or keeps taken, counts as made, so a
 * second run adds only what is missing and makes no project again that a
 * check archived or deleted. Since there are 200 numbers, a rerun after
 * such a check can make fewer than are missing, and it then says how many
 * it fell short. It then stars three of them for Nora through
 * projectNav:setFavorite (PROJECT_STARS), which a repeated star leaves as
 * it is. N goes up to 200 (MOST_PROJECTS). --files and --deleted keep
 * their sub-projects under Northstar's own top-level projects, never under
 * these. It runs after --relations and before --files.
 *
 * `--thread N` gives one task N comments and about N changes in its
 * history, for checking how the task window keeps a long thread
 * (src/lib/threadBudget.ts THREAD_KEEP) and reads it back (planThread). The
 * task is the one --labels starts with: the first seeded task still active,
 * or Northstar's own first active task by number where the run holds none
 * (--tasks 0), and the run says which. The comments are ordinary text, a
 * few sentences each, some with a list or a link, posted through
 * comments:create as Nora and the people with a login who own work in the
 * task's sub-project, in turn, so every post passes the app's own checks.
 * The posting rate lets each of them post 10 a minute on one task, so the
 * run waits when the server says to, and takes about N ÷ (10 × posters)
 * minutes; a sandbox's auto-stop must cover that. Each comment's id comes
 * from its number, so a rerun posts only what is missing. N goes up to the
 * 1,000-comment cap (LIMITS.comments). The arguments' check refuses a
 * larger N before anything is seeded. The thread step runs last, after
 * every other option has seeded, and refuses an N that would take the task
 * past the cap with the comments it holds already before it posts any. The
 * changes come from putting one label the seed makes on the task and
 * taking it off again through labels:toggle, one change each, until the
 * task's history, counted as Nora reads it first, holds N rows, so a rerun
 * adds none. A task that already carries the most labels a task can have
 * (LIMITS.labels), as --labels can leave it, has one of its own labels
 * taken off and put back instead, so it ends without that label when the
 * step adds an odd number of changes. */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { LIMITS } from './limits.mjs'
import { DemoCliError, isLoopbackOrigin, resolveTarget } from './marketing-demo.mjs'
import { pngOf } from './perf/files.mjs'
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
/* The most seeded labels: twenty batches of Settings > Labels, far past the
   eight it gathers before it asks for a search. */
const MOST_LABELS = 500
/* The most agents --api-accounts makes: four batches of Billing's API calls
   by account, and well inside the design size's 1,000 people. */
const MOST_API_ACCOUNTS = 100
/* What one --thread comment says, a few of these in turn, as a team's
   thread on a hardware pilot reads. */
const THREAD_LINES = [
  'I reran the drop test on the pilot units this morning and two of the twelve housings cracked at the same corner.',
  'The supplier says the new gasket ships next Tuesday, so the second build can start the week after.',
  'Firmware 2.4 fixes the sensor drift we saw at low temperatures, but the battery estimate is still off by about ten percent.',
  'Can we keep the old calibration jig until the pilot ends? The field team knows how to use it.',
  'I measured the boot time on the slow boards and it is a little under three seconds now.',
  'The pilot customer asked for weekly reports instead of daily ones, which suits the support team too.',
  'Packaging signed off on the new insert, so the shipping test can go ahead with it.',
  'Let us not block the release on the dashboard redesign; the current one is fine for the pilot.',
]
/* Lists and links some --thread comments carry. */
const THREAD_LIST =
  '\n\n- recheck the torque on the corner screws\n- log the batch numbers\n- send photos to the supplier'
const THREAD_LINK = ' The notes are in [the pilot log](https://example.com/pilot/log).'
/* What the --api-accounts agents do, in turn, as a team names its agents.
   The first two names are the searches' (planApiAccounts). */
const AGENT_JOBS = [
  'Build relay',
  'Telemetry bot',
  'Release notes agent',
  'Backup checker',
  'Support triage bot',
  'Calendar sync agent',
  'Report writer',
]
/* The --api-accounts agents' colors in turn, from the app's palette. */
const AGENT_COLORS = ['#2563EB', '#0F766E', '#7C3AED', '#D97706', '#DB2777', '#0891B2']
/* What seeded labels are about, in turn, as a team names its labels. */
const LABEL_TOPICS = [
  'Field test',
  'Supplier review',
  'Bench rig',
  'Enclosure fit',
  'Calibration',
  'Certification',
  'Packaging',
  'Pilot site',
  'Power budget',
  'Release notes',
]
/* The most live sub-projects --files puts under one project, the design
   size's figure for one project (docs/limits-plan.md in the private
   companion). */
const SUBS_PER_PROJECT = 30
/* The most live top-level projects --projects makes Northstar hold, the
   design size's figure for one organization. */
const MOST_PROJECTS = 200
/* What the --projects projects are, in turn, as a team names its
   rollouts. The first two names are the search's (seededProjectName). */
const PROJECT_TOPICS = [
  'Office pilot',
  'Retail rollout',
  'Clinic air study',
  'School deployment',
  'Warehouse sensors',
  'Hotel trial',
  'Lab retrofit',
  'Campus survey',
]
/** The --projects numbers Nora stars: one on the first page of the
    directory's other projects, and two further on. */
export const PROJECT_STARS = [2, 77, 150]
/* The most sub-projects --files makes, what Northstar holds. Its three
   live top-level projects hold 12 sub-projects, which leaves 78 places at
   SUBS_PER_PROJECT under one, three batches of Storage by project and
   part of a fourth. */
const MOST_FILES = 78
/* The most images --images puts in one task's description, the per-task
   limit of attachments, description images included. */
const MOST_IMAGES = LIMITS.attachments.max
/* The --images task's title, and what the text between its images says,
   in turn. */
const IMAGES_TITLE = 'Review the bench rig photos'
const IMAGE_NOTES = [
  'The rig after the new fixture went in, before calibration.',
  'Probe placement on the second board, with the shield removed.',
  'Thermal camera view after ten minutes at full load.',
  'Cable routing behind the rack, which the next revision tidies.',
]
/* What the --files sub-projects' files hold, in turn. */
const FILE_TOPICS = [
  'Test logs',
  'Firmware images',
  'Field photos',
  'Bench captures',
  'Supplier drawings',
  'Pilot recordings',
  'Calibration sheets',
  'Release builds',
]
/* The seeded labels' colors in turn, from the app's palette. */
const LABEL_COLORS = ['#D97706', '#7C3AED', '#2563EB', '#DB2777', '#0F766E', '#0891B2', '#EA580C']
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
    deleted: 0,
    inbox: 0,
    credentials: 0,
    apiAccounts: 0,
    relations: false,
    subProject: null,
    labels: 0,
    files: 0,
    thread: 0,
    projects: 0,
    images: 0,
    pictures: false,
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
    else if (arg === '--deleted') options.deleted = Number(value())
    else if (arg === '--inbox') options.inbox = Number(value())
    else if (arg === '--credentials') options.credentials = Number(value())
    else if (arg === '--api-url') options.apiUrl = value()
    else if (arg === '--api-accounts') options.apiAccounts = Number(value())
    else if (arg === '--relations') options.relations = true
    else if (arg === '--sub-project') options.subProject = value()
    else if (arg === '--labels') options.labels = Number(value())
    else if (arg === '--files') options.files = Number(value())
    else if (arg === '--thread') options.thread = Number(value())
    else if (arg === '--projects') options.projects = Number(value())
    else if (arg === '--images') options.images = Number(value())
    else if (arg === '--pictures') options.pictures = true
    else throw new DemoCliError(`Unknown option ${arg}.`)
  }
  if (options.target !== 'local')
    throw new DemoCliError('board-scale-seed writes to a disposable --local backend only.')
  if (!Number.isInteger(options.tasks) || options.tasks < 0 || options.tasks > MOST_TASKS)
    throw new DemoCliError(`--tasks takes a whole number from 0 to ${MOST_TASKS}.`)
  for (const name of ['archived', 'deleted', 'inbox']) {
    const count = options[name]
    if (!Number.isInteger(count) || count < 0 || count > options.tasks)
      throw new DemoCliError(`--${name} takes a whole number from 0 up to the --tasks count.`)
  }
  const credentials = options.credentials
  if (!Number.isInteger(credentials) || credentials < 0 || credentials > MOST_CREDENTIALS)
    throw new DemoCliError(`--credentials takes a whole number from 0 to ${MOST_CREDENTIALS}.`)
  if (credentials > 0 && !isLoopbackOrigin(options.apiUrl ?? ''))
    throw new DemoCliError('--credentials needs --api-url, the local backend site origin.')
  const apiAccounts = options.apiAccounts
  if (!Number.isInteger(apiAccounts) || apiAccounts < 0 || apiAccounts > MOST_API_ACCOUNTS)
    throw new DemoCliError(`--api-accounts takes a whole number from 0 to ${MOST_API_ACCOUNTS}.`)
  if (apiAccounts > 0 && !isLoopbackOrigin(options.apiUrl ?? ''))
    throw new DemoCliError('--api-accounts needs --api-url, the local backend site origin.')
  if (!Number.isInteger(options.labels) || options.labels < 0 || options.labels > MOST_LABELS)
    throw new DemoCliError(`--labels takes a whole number from 0 to ${MOST_LABELS}.`)
  if (!Number.isInteger(options.files) || options.files < 0 || options.files > MOST_FILES)
    throw new DemoCliError(`--files takes a whole number from 0 to ${MOST_FILES}.`)
  const most = LIMITS.comments.max
  if (!Number.isInteger(options.thread) || options.thread < 0 || options.thread > most)
    throw new DemoCliError(`--thread takes a whole number from 0 to ${most}, the comment cap.`)
  if (
    !Number.isInteger(options.projects) ||
    options.projects < 0 ||
    options.projects > MOST_PROJECTS
  )
    throw new DemoCliError(`--projects takes a whole number from 0 to ${MOST_PROJECTS}.`)
  if (!Number.isInteger(options.images) || options.images < 0 || options.images > MOST_IMAGES)
    throw new DemoCliError(`--images takes a whole number from 0 to ${MOST_IMAGES}.`)
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

/** The id of --thread comment `n`, from 0, on task `taskId`: the same for
    every run, so a second create of it is refused as taken. */
export const threadCommentId = (taskId, n) => uuidOf(`board-scale-seed thread ${taskId} ${n}`)

/** The id of the label --thread puts on its task and takes off again. */
export const THREAD_LABEL = uuidOf('board-scale-seed thread label')

/** What --thread comment `n` says: two to four of THREAD_LINES in turn,
    every fifth with a short list and every seventh with a link. */
export function threadCommentBody(n) {
  const lines = Array.from(
    { length: 2 + (n % 3) },
    (_, k) => THREAD_LINES[(n * 3 + k) % THREAD_LINES.length],
  )
  let text = lines.join(' ')
  if (n % 7 === 2) text += THREAD_LINK
  if (n % 5 === 4) text += THREAD_LIST
  return text
}

/** The --thread plan for `task`: the comments still missing of `count`,
    each with its poster in turn among `posters`, given the ids of the
    comments the task holds (`present`), and the label toggles that bring
    its history, `history` rows now, to `count`, given the ids of the
    labels the task carries (`labels`). The toggles use THREAD_LABEL when
    the task carries it or has a free label slot, and otherwise the first
    of the task's own labels by id, starting from whether that label is on
    the task. Refuses a count that would take the task past the comment cap
    with the comments it holds that are not the seed's. */
export function planThread(count, { task, present, posters, history, labels }) {
  const own = new Set(Array.from({ length: count }, (_, n) => threadCommentId(task.id, n)))
  const others = [...present].filter((id) => !own.has(id)).length
  if (others + count > LIMITS.comments.max)
    throw new DemoCliError(
      `--thread ${count} would take "${task.title}" past ${LIMITS.comments.max} comments; it holds ${others} already.`,
    )
  if (!posters.length) throw new DemoCliError(`Nobody with a login can post on "${task.title}".`)
  const comments = []
  for (let n = 0; n < count; n++) {
    const id = threadCommentId(task.id, n)
    if (present.has(id)) continue
    comments.push({
      poster: posters[n % posters.length],
      fields: { id, org_id: task.org_id, issue_id: task.id, body: threadCommentBody(n) },
    })
  }
  const label =
    labels.includes(THREAD_LABEL) || labels.length < LIMITS.labels.max
      ? THREAD_LABEL
      : [...labels].sort()[0]
  const toggles = []
  let state = labels.includes(label)
  for (let n = history; n < count; n++) {
    state = !state
    toggles.push({ org_id: task.org_id, issue_id: task.id, label_id: label, on: state })
  }
  return { comments, toggles }
}

/** The id of --relations row `what`, such as "project" or "link 40". */
export const relationId = (what) => uuidOf(`board-scale-seed relations ${what}`)

/** The id of --projects project number `n`, from 0, the same for every
    run. */
export const projectSeedId = (n) => uuidOf(`board-scale-seed projects ${n}`)

/* Every --projects id, which --files and --deleted never put a
   sub-project under. */
const SCALE_PROJECTS = new Set(Array.from({ length: MOST_PROJECTS }, (_, n) => projectSeedId(n)))

/** The name of --projects project `n`, from 0: an accented one first, a
    word no other name has second, then a rollout and a number, such as
    "Office pilot 03". */
export function seededProjectName(n) {
  if (n === 0) return 'Café network pilot'
  if (n === 1) return 'Vantorre depot trial'
  const topic = PROJECT_TOPICS[n % PROJECT_TOPICS.length]
  return `${topic} ${String(Math.floor(n / PROJECT_TOPICS.length) + 1).padStart(2, '0')}`
}

/**
 * The --projects work in organization `org` to hold `count` live top-level
 * projects in all: `projects`, the projects:create calls of the projects
 * missing, numbered from 0 and skipping each number whose id `present`
 * holds (in any table or as a used id), led by the caller, Nora; `stars`,
 * the ids of PROJECT_STARS among the --projects projects that will be
 * live; and `short`, how many are still missing once every number up to
 * MOST_PROJECTS is taken, as after a check archived or deleted some.
 * `tops` holds the ids of the organization's live top-level projects now,
 * which count toward `count` whatever made them.
 */
export function planProjects({ org, count, tops, present }) {
  const plan = { projects: [], stars: [], short: 0 }
  let missing = Math.max(0, count - tops.length)
  const live = new Set(tops)
  for (let n = 0; n < MOST_PROJECTS && missing > 0; n++) {
    const id = projectSeedId(n)
    if (present.has(id) || live.has(id)) continue
    plan.projects.push({
      id,
      org_id: org,
      type: 'meta',
      key: `SC${String(n).padStart(3, '0')}`,
      name: seededProjectName(n),
      description: `Seeded by board-scale-seed --projects as project ${n + 1}.`,
      sort_order: 200 + n,
    })
    live.add(id)
    missing--
  }
  plan.short = missing
  for (const n of PROJECT_STARS) if (live.has(projectSeedId(n))) plan.stars.push(projectSeedId(n))
  return plan
}

/** The id of the --files sub-project, task or file (`what`) number `n`,
    from 0, the same for every run. */
export const fileSeedId = (what, n) => uuidOf(`board-scale-seed files ${what} ${n}`)

/** The id of the --images task, or of its image number `n` from 0, the
    same for every run. */
export const imageSeedId = (what, n = 0) => uuidOf(`board-scale-seed images ${what} ${n}`)

/** The --images task's description: its `count` images one a paragraph,
    with a paragraph of text between. */
export function imagesDescription(count) {
  return Array.from(
    { length: count },
    (_, n) =>
      `${IMAGE_NOTES[n % IMAGE_NOTES.length]}\n\n![Bench photo ${n + 1}](att:${imageSeedId('image', n)})`,
  ).join('\n\n')
}

/**
 * The --images work in organization `org` for `count` images: `task`, the
 * issues:create fields of the task when it is missing, else null; `uploads`,
 * the images still missing, each its id, name and bytes; and `description`,
 * the text the run saves. `stored` holds the ids that count as made, those
 * with a row and the archived ones (storedIdsOf). A task that counts as
 * made but has no row, in Deleted items or deleted for good, or that is
 * archived or lies in an archived project, gets nothing, so the plan is
 * null then.
 */
export function planImages({ org, count, project, stored }) {
  const id = imageSeedId('task')
  const made = stored.tasks.has(id)
  if (made && (!stored.rows.tasks.has(id) || stored.rows.archived?.has(id))) return null
  return {
    task: made
      ? null
      : {
          id,
          org_id: org,
          project_id: project,
          title: IMAGES_TITLE,
          description: '',
          status: 'progress',
          priority: 'medium',
        },
    uploads: Array.from({ length: count }, (_, n) => ({
      id: imageSeedId('image', n),
      issue_id: id,
      name: `bench-photo-${n + 1}.png`,
      n,
    })).filter((image) => !stored.files.has(image.id)),
    description: imagesDescription(count),
  }
}

/** The bytes of --images image `n`: a 640 by 480 PNG. */
export const seededImageBytes = (n) => pngOf(640, 480, 0.03, n + 1)

/** The bytes of the --pictures picture of person `n`: a 256-pixel PNG of
    about 20 KB, as the app's own pictures are 10 to 30 KB. */
export const seededPictureBytes = (n) => pngOf(256, 256, 0.035, 1000 + n)

/** The name of --files sub-project `n`, from 0: an accented one first, a
    word no other name has second, then what its files hold and a number,
    such as "Field photos 03". */
export function seededFileProject(n) {
  if (n === 0) return 'Café pilot photos'
  if (n === 1) return 'Zephyrine bench archive'
  const topic = FILE_TOPICS[n % FILE_TOPICS.length]
  return `${topic} ${String(Math.floor(n / FILE_TOPICS.length) + 1).padStart(2, '0')}`
}

/** The bytes of --files file `n`: a thousand times a step of 1 to 97 that
    the numbers visit in a scrambled order, plus `n`, so no two of the first
    MOST_FILES share a size and the list's order is not the order made. */
export const seededFileBytes = (n) => 1000 * (1 + ((n * 37) % 97)) + n

/**
 * The --files work still to do in organization `org` for the first `count`
 * file sub-projects: `projects`, the projects:create calls of the
 * sub-projects missing, each under the live top-level project of `tops`
 * (`{ id, subs }`, its live sub-project count, in Northstar's order) that
 * holds the fewest, never more than SUBS_PER_PROJECT; `tasks`, the
 * issues:create calls of the tasks missing; and `files`, the uploads to
 * attach, with the attachment's id, task, name, MIME type and size.
 * `present` holds the project, task and attachment ids that count as made,
 * which the backend holds anywhere or keeps taken, and `rows` the project
 * and task ids that have a row now. A task is planned only in a
 * sub-project with a row or one planned here, and a file only on such a
 * task, so one deleted for good or in Deleted items takes none. Refuses,
 * with the places left, when the sub-projects missing do not fit under the
 * top-level projects.
 */
export function planFiles({ org, count, tops, present, rows }) {
  const missing = Array.from({ length: count }, (_, n) => fileSeedId('project', n)).filter(
    (id) => !present.projects.has(id),
  ).length
  const left = tops.reduce((sum, top) => sum + Math.max(0, SUBS_PER_PROJECT - top.subs), 0)
  if (missing > left)
    throw new DemoCliError(
      `--files ${count} needs ${missing} new sub-projects, but Northstar's live top-level projects have room for ${left}, at most ${SUBS_PER_PROJECT} under one.`,
    )
  const room = new Map(tops.map((top) => [top.id, top.subs]))
  const plan = { projects: [], tasks: [], files: [] }
  for (let n = 0; n < count; n++) {
    const project = fileSeedId('project', n)
    const task = fileSeedId('task', n)
    const file = fileSeedId('file', n)
    const name = seededFileProject(n)
    const newProject = !present.projects.has(project)
    const newTask = !present.tasks.has(task) && (newProject || rows.projects.has(project))
    if (newProject) {
      // the first of the fewest, so ties go in Northstar's order; the check
      // above leaves one with room for every sub-project missing
      let parent = null
      for (const top of tops)
        if (
          room.get(top.id) < SUBS_PER_PROJECT &&
          (parent === null || room.get(top.id) < room.get(parent))
        )
          parent = top.id
      room.set(parent, room.get(parent) + 1)
      plan.projects.push({
        id: project,
        org_id: org,
        type: 'project',
        parent_id: parent,
        key: `F${String(n + 1).padStart(3, '0')}`,
        name,
        sort_order: 1000 + n,
      })
    }
    if (newTask)
      plan.tasks.push({
        id: task,
        org_id: org,
        project_id: project,
        title: `Collect the ${name.replace(/ \d+$/, '').toLowerCase()} for review`,
        description: `Seeded by board-scale-seed --files as file ${n + 1}.`,
        status: STATUSES[n % STATUSES.length],
        priority: 'medium',
      })
    if (!present.files.has(file) && (newTask || rows.tasks.has(task)))
      plan.files.push({
        id: file,
        issue_id: task,
        name: `${name
          .normalize('NFKD')
          .replace(/[̀-ͯ]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')}.csv`,
        mime: 'text/csv',
        bytes: seededFileBytes(n),
      })
  }
  return plan
}

/** `size` bytes of CSV text, readings of a bench run, for a seeded file. */
export function seededFileText(size) {
  const lines = ['time,channel,reading']
  let length = lines[0].length
  for (let i = 0; length < size; i++) {
    const line = `${String(i).padStart(6, '0')},ch${i % 8},${((i * 7919) % 10_000) / 100}`
    lines.push(line)
    length += line.length + 1
  }
  return lines.join('\n').slice(0, size)
}

/** The name of seeded label `n`, from 0: a topic and a number, such as
    "Field test 01", ten topics before the number moves on. */
export const seededLabelName = (n) =>
  `${LABEL_TOPICS[n % LABEL_TOPICS.length]} ${String(Math.floor(n / LABEL_TOPICS.length) + 1).padStart(2, '0')}`

/**
 * The --labels work still to do in organization `org` for the first
 * `count` seeded labels: `create`, the labels:create calls of those that
 * `present` (the organization's labels) holds neither by the label's own
 * id nor by its name in any case, and `toggle`, the labels:toggle calls
 * that put label n on n % 4 of `tasks` (task ids in a fixed order), the
 * tasks from n * 3 on, skipping a task that carries it already in `on`
 * (label ids by task id) and one that would pass LIMITS.labels.max.
 *
 * The id comes first, so a seeded label a person renamed counts as made
 * and keeps its new name. Planning it again by its name would send its
 * id to labels:create, which refuses an id that is taken.
 */
export function planLabels({ org, count, present, tasks, on }) {
  const ids = new Set(present.map((label) => label.id))
  const byName = new Map(present.map((label) => [label.name.toLowerCase(), label.id]))
  const carried = new Map([...on].map(([task, labels]) => [task, new Set(labels)]))
  const plan = { create: [], toggle: [] }
  for (let n = 0; n < count; n++) {
    const name = seededLabelName(n)
    const own = uuidOf(`board-scale-seed label ${n}`)
    let id = ids.has(own) ? own : byName.get(name.toLowerCase())
    if (id === undefined) {
      id = own
      plan.create.push({ org_id: org, id, name, color: LABEL_COLORS[n % LABEL_COLORS.length] })
    }
    for (let k = 0; k < n % 4 && tasks.length > 0; k++) {
      const task = tasks[(n * 3 + k) % tasks.length]
      const labels = carried.get(task) ?? new Set()
      if (labels.has(id) || labels.size >= LIMITS.labels.max) continue
      labels.add(id)
      carried.set(task, labels)
      plan.toggle.push({ org_id: org, issue_id: task, label_id: id, on: true })
    }
  }
  return plan
}

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

/** What the seed reads of the workspace `client` reads as Nora: its parts,
    which send no project since the app reads them by id, with the live
    projects of her organizations, neither archived nor under an archived
    parent, from the tables (tableRows) through a client of the local admin
    key itself, since a system table answers no person the admin acts as. */
async function seedSnapshot(client, target) {
  const snapshot = await readWorkspace((name, args) => client.query(ref(name), args))
  const orgs = new Set(snapshot.orgs.map((o) => o.id))
  const admin = new ConvexHttpClient(target.url, { logger: false })
  admin.setAdminAuth(target.key)
  const rows = (await tableRows(admin, 'projects')).filter((p) => orgs.has(p.org_id))
  const byId = new Map(rows.map((p) => [p.id, p]))
  const projects = rows.filter(
    (p) => !p.archived_at && !(p.parent_id && byId.get(p.parent_id)?.archived_at),
  )
  return { ...snapshot, projects }
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

/** The `n`th --api-accounts agent's name: the first with an accent and the
    second with a word no other name holds, for the lists' searches, the
    rest named for what they do, each with its number. */
export function seededAgentName(n) {
  const number = String(n).padStart(2, '0')
  if (n === 1) return `Zoë relay ${number}`
  if (n === 2) return `Quillon importer ${number}`
  return `${AGENT_JOBS[n % AGENT_JOBS.length]} ${number}`
}

/** The id of the `n`th --api-accounts agent of organization `org`, the same
    for every run. */
export const apiAccountId = (org, n) => uuidOf(`board-scale-seed api account ${org} ${n}`)

/** The name of the keys the seed gives the `n`th --api-accounts agent, by
    which it finds their calls in the usage rows. */
const apiAccountKeyName = (n) => `Billing load key ${String(n).padStart(2, '0')}`

/** What --api-accounts still has to do for agents 1 to `count` of
    organization `org` (see the file comment), from `profiles`, the
    organization's profiles by id, `used`, by profile id the calls each
    agent's own keys made in the bucket Billing shows now, and `removed`,
    the ids of seeded agents removed through Users: for each agent number,
    whether to make its profile, the calls it lacks, made with a new key
    when more than 0, and whether to set it inactive. Agent n makes
    1 + n % 7 calls, and every third is set inactive after them. An agent
    that is inactive already gets no calls, since its key would be refused,
    and nothing else, and a removed one gets nothing, since profiles:create
    refuses its id. */
export function planApiAccounts({ org, count, profiles, used, removed = new Set() }) {
  const plan = []
  for (let n = 1; n <= count; n++) {
    const id = apiAccountId(org, n)
    const profile = profiles.get(id)
    const calls = 1 + (n % 7)
    const inactive = n % 3 === 0
    if (profile ? !profile.active : removed.has(id)) continue
    const missing = Math.max(0, calls - (used.get(id) ?? 0))
    const step = {
      n,
      id,
      name: seededAgentName(n),
      color: AGENT_COLORS[n % AGENT_COLORS.length],
      create: !profile,
      calls: missing,
      deactivate: inactive,
    }
    if (step.create || step.calls > 0 || step.deactivate) plan.push(step)
  }
  return plan
}

/** Adds the --api-accounts agents still missing up to `count` in
    organization `org` (planApiAccounts), acting as `actor` with the local
    admin key `key`, and answers how many agents it changed. It logs the
    seeded agents it leaves removed. */
export async function seedApiAccounts(client, { key, org, actor, count, apiUrl, log }) {
  // the system tables answer the admin itself, not a person it acts as
  client.setAdminAuth(key)
  const profiles = new Map(
    (await tableRows(client, 'profiles'))
      .filter((profile) => profile.org_id === org)
      .map((profile) => [profile.id, profile]),
  )
  const usage = (await tableRows(client, 'billing_usage')).filter((row) => row.org_id === org)
  const numbers = new Map(
    Array.from({ length: count }, (_, i) => [apiAccountId(org, i + 1), i + 1]),
  )
  // A seeded agent removed through Users has no profile, and its id stays
  // taken while a pending removal or any of its usage rows names it
  // (convex/profiles.ts create), so the run leaves it removed.
  const named = new Set(usage.map((row) => row.profile_id))
  for (const row of await tableRows(client, 'profile_removals')) named.add(row.profile_id)
  const removed = new Set([...numbers.keys()].filter((id) => !profiles.has(id) && named.has(id)))
  const left = [...removed].map((id) => seededAgentName(numbers.get(id)))
  if (left.length)
    log(
      `${left.length} seeded agents were removed through Users and stay removed (${left.join(', ')}).`,
    )
  client.setAdminAuth(key, identityOf(actor.auth_user_id))
  const call = async (name, fields) => {
    try {
      await client.mutation(ref(name), fields)
    } catch (error) {
      throw new DemoCliError(`${name} was refused: ${error.data?.message ?? error.message}`)
    }
  }
  // the bucket Billing shows now, which the calls below are recorded in
  const { period_key: period } = await client.query(ref('billing:usageFigures'), { org_id: org })
  // the calls each agent's own keys made in that bucket
  const used = new Map()
  for (const row of usage) {
    const n = numbers.get(row.profile_id)
    if (n && row.period_start === period && row.credential_name === apiAccountKeyName(n))
      used.set(row.profile_id, (used.get(row.profile_id) ?? 0) + row.calls)
  }
  const plan = planApiAccounts({ org, count, profiles, used, removed })
  for (const step of plan) {
    if (step.create)
      await call('profiles:create', {
        org_id: org,
        id: step.id,
        name: step.name,
        org_role: 'user',
        kind: 'agent',
        color: step.color,
      })
    if (step.calls > 0) {
      const minted = await mintCredential('qva')
      await call('tokens:createAgentKey', {
        org_id: org,
        id: minted.id,
        agent_id: step.id,
        name: apiAccountKeyName(step.n),
        key_prefix: `${minted.secret.slice(0, 7)}...${minted.secret.slice(-5)}`,
        key_hash: minted.hash,
      })
      await callApi(apiUrl, minted.secret, step.calls)
    }
    if (step.deactivate) await call('profiles:deactivate', { org_id: org, id: step.id })
  }
  log(`${plan.length} seeded agents with API calls added or finished.`)
  return plan.length
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
    tasks that are neither parents nor in Deleted items are archived:
    `seeded` holds every seeded task by number (seededTasks), the ones
    Deleted items stores among them with `deleted`, and `parents` the ids
    of tasks with subtasks. A task archived already needs nothing. */
export function planArchive(count, seeded, parents) {
  const ids = []
  let taken = 0
  for (const n of [...seeded.keys()].sort((a, b) => a - b)) {
    if (taken === count) break
    const { task } = seeded.get(n)
    if (parents.has(task.id) || task.deleted) continue
    taken++
    if (!task.archived_at) ids.push(task.id)
  }
  return ids
}

/** The seeded tasks to move to Deleted items so that the first `count`
    seeded tasks that are neither parents, in a family (every 25th task and
    the three after it, planSeed) nor archived are there: `seeded` holds
    every seeded task by number (seededTasks) as it is now, with the tasks
    this run made and archived, each with its project, the ones Deleted
    items stores among them with `deleted`, and `parents` the ids of tasks
    with subtasks. A family stays whole, so a rerun's planSeed finds it as it
    left it. Each comes with who deletes it: every seventh the agent
    (`agent`) when the run has its key, every third Leo where `leads` says
    he leads the task's top-level project, and Nora the rest. A task in
    Deleted items already needs nothing. */
export function planDelete(count, seeded, parents, { agent, leads }) {
  const out = []
  let taken = 0
  for (const n of [...seeded.keys()].sort((a, b) => a - b)) {
    if (taken === count) break
    const { task } = seeded.get(n)
    if (parents.has(task.id) || task.archived_at || n % 25 < 4) continue
    taken++
    if (task.deleted) continue
    const by = taken % 7 === 0 && agent ? 'agent' : taken % 3 === 0 && leads(task) ? 'leo' : 'nora'
    out.push({ id: task.id, by })
  }
  return out
}

/** The sub-project --deleted makes and deletes whole, and its tasks. */
const DELETED_SUB = 'Retired bench fixtures'
const DELETED_SUB_TASKS = [
  'Calibrate the retired bench rig',
  'Archive the bench rig wiring notes',
  'Return the spare bench sensors',
]

/** The calls that make --deleted's sub-project under the live top-level
    project of `tops` (`{ id, subs }`) that holds the fewest, with its three
    tasks, or null when `present` holds its id already, in any table or as
    a used id, or no top-level project has room. */
export function planDeletedSub({ org, tops, present }) {
  const project = uuidOf('board-scale-deleted-sub')
  if (present.has(project)) return null
  const room = tops.filter((top) => top.subs < SUBS_PER_PROJECT)
  if (room.length === 0) return null
  const parent = room.reduce((a, b) => (b.subs < a.subs ? b : a))
  return {
    project: {
      id: project,
      org_id: org,
      type: 'project',
      parent_id: parent.id,
      key: 'RBF',
      name: DELETED_SUB,
      sort_order: 2000,
    },
    tasks: DELETED_SUB_TASKS.map((title, n) => ({
      id: uuidOf(`board-scale-deleted-sub-task-${n}`),
      org_id: org,
      project_id: project,
      title,
      description: `Seeded by board-scale-seed --deleted as bench task ${n + 1}.`,
      status: STATUSES[n % STATUSES.length],
      priority: 'medium',
    })),
  }
}

/** The seeded tasks Deleted items stores in organization `org`
    (deleted_tasks), as the Convex CLI reads a table, each as a task row
    with the seed's mark and `deleted`, so a run neither seeds them again
    nor deletes more. */
async function deletedTasksOf(client, org) {
  return (await tableRows(client, 'deleted_tasks'))
    .filter((row) => row.org_id === org)
    .map((row) => {
      const head = `${row.title}\n`
      const text = row.search_text ?? row.title
      return {
        id: row.task_id,
        org_id: org,
        title: row.title,
        description: text.startsWith(head) ? text.slice(head.length) : '',
        project_id: row.project_id,
        deleted: true,
      }
    })
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
  const stored =
    options.files > 0 || options.projects > 0 || options.images > 0
      ? await storedIdsOf(client, actor.org_id)
      : null
  // what Deleted items holds, which no run seeds again, archives or
  // deletes, whatever its flags
  const inTrash = await deletedTasksOf(client, actor.org_id)
  const takenIds = options.deleted > 0 ? await storedIdsOf(client, actor.org_id) : null
  client.setAdminAuth(target.key, identityOf(actor.auth_user_id))
  const snapshot = await seedSnapshot(client, target)
  const org = snapshot.orgs.find((o) => o.id === actor.org_id)?.id
  if (!org) throw new DemoCliError('Nora cannot see Northstar; seed it again.')
  // Northstar's own rows: the snapshot holds every organization Nora is in
  const joined = (name) =>
    [...snapshot[name], ...(snapshot.more?.[name] ?? []).flat()].filter((row) => row.org_id === org)
  const issues = joined('issues')
  // --files plans before anything is seeded, so a count that does not fit
  // refuses with nothing made
  const files =
    options.files > 0 && stored !== null
      ? planFileSeed(options.files, { org, joined, stored })
      : null
  // the sub-projects that hold tasks, each with the owners its tasks have
  const owners = new Map()
  for (const project of joined('projects'))
    if (project.type === 'project' && !project.archived_at) owners.set(project.id, new Set())
  for (const issue of issues)
    if (issue.assignee_id && owners.has(issue.project_id))
      owners.get(issue.project_id).add(issue.assignee_id)
  let projects = [...owners.keys()]
  if (!projects.length) throw new DemoCliError('Northstar has no sub-projects to fill.')
  if (options.subProject !== null) {
    const named = joined('projects').find(
      (p) => owners.has(p.id) && (p.key === options.subProject || p.name === options.subProject),
    )
    if (!named) {
      const keys = joined('projects')
        .filter((p) => owners.has(p.id))
        .map((p) => `${p.key} (${p.name})`)
      throw new DemoCliError(
        `--sub-project names no live sub-project of Northstar; it has ${keys.join(', ')}.`,
      )
    }
    projects = [named.id]
  }
  if (options.credentials > 0)
    await seedCredentials(client, {
      key: target.key,
      org,
      actor,
      count: options.credentials,
      apiUrl: new URL(options.apiUrl).origin,
      log,
    })
  if (options.apiAccounts > 0)
    await seedApiAccounts(client, {
      key: target.key,
      org,
      actor,
      count: options.apiAccounts,
      apiUrl: new URL(options.apiUrl).origin,
      log,
    })
  // a task an earlier run archived or deleted is seeded already
  const seeded = seededTasks([...issues, ...archived, ...inTrash])
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
      // --deleted reads its project, as Leo deletes where he leads
      seeded.set(number, {
        task: { id: fields.id, project_id: fields.project_id },
        parent: fields.parent_id ?? null,
      })
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
  if (options.projects > 0 && stored !== null) {
    const tops = new Set(
      joined('projects')
        .filter((p) => p.type === 'meta' && !p.parent_id && !p.archived_at)
        .map((p) => p.id),
    )
    // the workspace was read before --relations ran, so Partner pilot,
    // which that run made if no id of it was stored, counts too
    if (options.relations && !stored.projects.has(relationId('project')))
      tops.add(relationId('project'))
    await seedProjects(
      planProjects({ org, count: options.projects, tops: [...tops], present: stored.projects }),
      {
        client,
        org,
        target,
        log,
      },
    )
  }
  if (files !== null) await seedFiles(files, { client, org, target, log })
  if (options.images > 0) {
    const plan = planImages({ org, count: options.images, project: projects[0], stored })
    if (plan === null)
      log('The --images task is archived, in Deleted items or deleted for good; skipped.')
    else await seedImages(plan, { client, org, target, log })
  }
  if (options.pictures)
    await seedPictures(
      people.page.filter(
        (p) => p.org_id === org && p.active && (p.kind === 'person' || p.kind === 'agent'),
      ),
      { client, target, log },
    )
  if (options.labels > 0) await seedLabels(options.labels, { client, org, seeded, target, log })
  if (options.archived > 0) {
    const parents = new Set([...issues, ...archived].map((task) => task.parent_id).filter(Boolean))
    const ids = planArchive(options.archived, seeded, parents)
    await seedArchive(ids, { client, org, target, log })
    // --deleted plans from the tasks as they are now, so it leaves these
    markArchived(seeded, ids)
  }
  if (options.deleted > 0) {
    const parents = new Set([...issues, ...archived].map((task) => task.parent_id).filter(Boolean))
    await seedDeleted(options.deleted, {
      client,
      key: target.key,
      org,
      actor,
      people: people.page,
      joined,
      seeded,
      parents,
      taken: takenIds,
      apiUrl: options.apiUrl,
      target,
      log,
    })
  }
  if (options.inbox > 0)
    await seedInbox(options.inbox, { client, target, people: people.page, actor, org, log })
  if (options.thread > 0)
    await seedThread(options.thread, { client, target, people: people.page, actor, org, log })
}

/* The comment-rate refusal (convex/lib/limits.ts tooManyComments), with
   the seconds it asks the poster to wait. */
const RATE_REFUSAL = /^too many comments on this task.*Try again in (\d+) seconds?\.$/

/* Gives the --thread task its comments and changes (planThread): the task
   --labels starts with, its comments and history read as Nora first, the
   comments posted as their posters' logins, waiting out the posting rate
   when the server refuses one, then THREAD_LABEL made if the toggles use
   it and it is missing, and the label toggled. */
async function seedThread(count, { client, target, people, actor, org, log }) {
  const snapshot = await seedSnapshot(client, target)
  const joined = (name) =>
    [...snapshot[name], ...(snapshot.more?.[name] ?? []).flat()].filter((row) => row.org_id === org)
  const active = joined('issues')
  const live = new Set(active.map((task) => task.id))
  const fromSeed = [...seededTasks(active).entries()]
    .sort(([a], [b]) => a - b)
    .map(([, { task }]) => task)
    .filter((task) => live.has(task.id))
  const task = fromSeed[0] ?? [...active].sort((a, b) => a.num - b.num)[0]
  if (!task) throw new DemoCliError('Northstar has no active task for --thread.')
  const thread = { org_id: org, issue_id: task.id }
  // the task's comments and history, page by page, as the task window reads them
  const present = new Set()
  for (let page = await client.query(ref('snapshot:threadComments'), thread); ; ) {
    for (const comment of page.comments) present.add(comment.id)
    if (!page.earlier || !page.comments.length) break
    page = await client.query(ref('snapshot:commentsBefore'), {
      ...thread,
      before: page.comments[0].id,
    })
  }
  let history = 0
  for (let page = await client.query(ref('snapshot:threadHistory'), thread); ; ) {
    history += page.events.length
    if (!page.earlier || !page.next) break
    page = await client.query(ref('snapshot:historyBefore'), { ...thread, before: page.next })
  }
  // Nora and the people with a login who own work in the task's sub-project
  const owners = new Set(
    active.filter((issue) => issue.project_id === task.project_id).map((i) => i.assignee_id),
  )
  const posters = people
    .filter(
      (p) =>
        p.org_id === org &&
        p.auth_user_id &&
        p.active !== false &&
        p.org_role !== 'viewer' &&
        (p.id === actor.id || owners.has(p.id)),
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  const labels = [...snapshot.issueLabels, ...(snapshot.more?.issueLabels ?? []).flat()]
    .filter((row) => row.issue_id === task.id)
    .map((row) => row.label_id)
  const plan = planThread(count, { task, present, posters, history, labels })
  log(
    `--thread: QN-${task.num} "${task.title}" holds ${present.size} comments and ${history} changes; ${plan.comments.length} comments and ${plan.toggles.length} changes to add, posted by ${posters.length} people.`,
  )
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
  for (const { poster, fields } of plan.comments) {
    for (;;) {
      try {
        await clientOf(poster).mutation(ref('comments:create'), fields)
        posted++
        break
      } catch (error) {
        const message = error.data?.message ?? ''
        if (message === COMMENT_TAKEN) break
        const wait = RATE_REFUSAL.exec(message)
        if (!wait)
          throw new DemoCliError(
            `comments:create refused a --thread comment: ${message || error.message}`,
          )
        await new Promise((done) => setTimeout(done, Number(wait[1]) * 1000))
      }
    }
    if (posted % 100 === 0 && posted) log(`${posted} --thread comments posted`)
  }
  // the workspace holds no label (convex/lib/workspaceJoin.ts), so the
  // label is looked up by id, as the task window names a task's labels
  if (
    plan.toggles[0]?.label_id === THREAD_LABEL &&
    (await client.query(ref('labels:byIds'), { org_id: org, ids: [THREAD_LABEL] })).rows.length ===
      0
  )
    await client.mutation(ref('labels:create'), {
      org_id: org,
      id: THREAD_LABEL,
      name: 'Thread check',
      color: LABEL_COLORS[0],
    })
  for (const call of plan.toggles) await client.mutation(ref('labels:toggle'), call)
  log(
    `Done: ${posted} comments and ${plan.toggles.length} changes added on QN-${task.num} in Northstar on ${target.url}.`,
  )
}

/** Moves the --deleted tasks to Deleted items (planDelete) and makes and
    deletes the sub-project (planDeletedSub), each as its deleter, then
    acts as Nora again. */
async function seedDeleted(
  count,
  { client, key, org, actor, people, joined, seeded, parents, taken, apiUrl, target, log },
) {
  const projects = joined('projects')
  const byId = new Map(projects.map((p) => [p.id, p]))
  const leo = people.find((p) => p.email === 'leo@demo.qivo.io' && p.auth_user_id && p.active)
  const agent = people.find((p) => p.org_id === org && p.kind === 'agent' && p.active)
  /** Whether Leo leads the task's project or its top-level project. */
  const leads = (task) => {
    const project = byId.get(task.project_id)
    const top = project?.parent_id ? byId.get(project.parent_id) : project
    return !!leo && (project?.lead_id === leo.id || top?.lead_id === leo.id)
  }
  const call = async (name, fields, what) => {
    try {
      return await client.mutation(ref(name), fields)
    } catch (error) {
      throw new DemoCliError(`${name} refused ${what}: ${error.data?.message ?? error.message}`)
    }
  }
  let secret = null
  const plan = planDelete(count, seeded, parents, {
    agent: !!agent && !!apiUrl && isLoopbackOrigin(new URL(apiUrl).origin),
    leads,
  })
  if (plan.some((job) => job.by === 'agent')) {
    const minted = await mintCredential('qva')
    await call(
      'tokens:createAgentKey',
      {
        org_id: org,
        id: minted.id,
        agent_id: agent.id,
        name: `Board scale deletes ${new Date().toISOString().slice(0, 10)}`,
        key_prefix: `${minted.secret.slice(0, 7)}...${minted.secret.slice(-5)}`,
        key_hash: minted.hash,
      },
      'the agent key for --deleted',
    )
    secret = minted.secret
  }
  log(`${plan.length} seeded tasks to move to Deleted items.`)
  for (const job of plan) {
    if (job.by === 'agent') {
      for (;;) {
        const res = await fetch(`${new URL(apiUrl).origin}/v1/tasks/${job.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${secret}` },
        })
        if (res.status === 429) {
          const wait = Number(res.headers.get('Retry-After') ?? '60')
          await new Promise((done) => setTimeout(done, Math.max(1, wait) * 1000))
          continue
        }
        if (!res.ok) throw new DemoCliError(`DELETE /v1/tasks/${job.id} answered ${res.status}.`)
        break
      }
      continue
    }
    client.setAdminAuth(key, identityOf((job.by === 'leo' ? leo : actor).auth_user_id))
    await call('issues:deleteDeep', { org_id: org, id: job.id }, `task ${job.id}`)
  }
  client.setAdminAuth(key, identityOf(actor.auth_user_id))
  const tops = projects
    .filter((p) => p.type === 'meta' && !p.parent_id && !p.archived_at && !SCALE_PROJECTS.has(p.id))
    .map((top) => ({
      id: top.id,
      subs: projects.filter((p) => p.parent_id === top.id && !p.archived_at).length,
    }))
  const present = new Set([...(taken?.projects ?? []), ...projects.map((p) => p.id)])
  const sub = planDeletedSub({ org, tops, present })
  if (sub !== null) {
    await call('projects:create', sub.project, `"${sub.project.name}"`)
    for (const fields of sub.tasks) await call('issues:create', fields, `"${fields.title}"`)
    await call('projects:deleteDeep', { org_id: org, id: sub.project.id }, `"${sub.project.name}"`)
  }
  log(
    `Done: ${plan.length} seeded tasks${sub ? ` and the sub-project "${DELETED_SUB}"` : ''} moved to Deleted items in Northstar on ${target.url}.`,
  )
}

/** Makes the --labels labels as Nora and puts them on tasks (planLabels):
    the seeded tasks still active, by number, or Northstar's own active
    tasks, by number, where the run holds none. */
async function seedLabels(count, { client, org, seeded, target, log }) {
  const snapshot = await seedSnapshot(client, target)
  const joined = (name) =>
    [...snapshot[name], ...(snapshot.more?.[name] ?? []).flat()].filter((row) => row.org_id === org)
  const active = joined('issues')
  const live = new Set(active.map((task) => task.id))
  const fromSeed = [...seeded.keys()]
    .sort((a, b) => a - b)
    .map((n) => seeded.get(n).task.id)
    .filter((id) => live.has(id))
  const tasks = fromSeed.length
    ? fromSeed
    : [...active].sort((a, b) => a.num - b.num).map((task) => task.id)
  const on = new Map()
  for (const { issue_id, label_id } of [
    ...snapshot.issueLabels,
    ...(snapshot.more?.issueLabels ?? []).flat(),
  ]) {
    if (!live.has(issue_id)) continue
    on.set(issue_id, [...(on.get(issue_id) ?? []), label_id])
  }
  // the workspace holds no label, so the organization's labels come from
  // the table, as its profiles do (tableRows)
  const present = (await tableRows(client, 'labels')).filter((label) => label.org_id === org)
  const plan = planLabels({ org, count, present, tasks, on })
  for (const [name, calls] of [
    ['labels:create', plan.create],
    ['labels:toggle', plan.toggle],
  ])
    for (const call of calls) {
      try {
        await client.mutation(ref(name), call)
      } catch (error) {
        throw new DemoCliError(
          `${name} refused label ${call.name ?? call.label_id}: ${error.data?.message ?? error.message}`,
        )
      }
    }
  log(
    `Done: ${plan.create.length} labels added and ${plan.toggle.length} put on tasks in Northstar on ${target.url}.`,
  )
}

/** The project, task and attachment ids of organization `org` that
    --files counts as made, as the local admin reads the tables: live and
    archived projects, every task row, archived ones and those of an
    archived project included, which keep no archived_at of their own, the
    attachment rows, every copy Deleted items stores, and the project and
    task ids used_ids keeps after a delete for good, which projects:create
    and issues:create refuse. `rows` holds the project and task ids that
    have a row, which alone can take a new task or file, and `archived`
    the task ids of those rows that are archived or lie in an archived
    project or under an archived top-level project. */
async function storedIdsOf(client, org) {
  const rows = { projects: new Set(), tasks: new Set(), archived: new Set() }
  const projects = new Map()
  for (const project of await tableRows(client, 'projects'))
    if (project.org_id === org) {
      rows.projects.add(project.id)
      projects.set(project.id, project)
    }
  const archivedProject = (id) => {
    const project = projects.get(id)
    return !!project && (!!project.archived_at || !!projects.get(project.parent_id)?.archived_at)
  }
  for (const task of await tableRows(client, 'issues'))
    if (task.org_id === org) {
      rows.tasks.add(task.id)
      if (task.archived_at || archivedProject(task.project_id)) rows.archived.add(task.id)
    }
  const ids = { projects: new Set(rows.projects), tasks: new Set(rows.tasks), files: new Set() }
  for (const file of await tableRows(client, 'issue_attachments'))
    if (file.org_id === org) ids.files.add(file.id)
  const kinds = { projects: ids.projects, issues: ids.tasks, issue_attachments: ids.files }
  for (const row of await tableRows(client, 'deleted_rows'))
    if (row.org_id === org && row.row_id && kinds[row.table]) kinds[row.table].add(row.row_id)
  for (const row of await tableRows(client, 'used_ids'))
    if (row.org_id === org && kinds[row.table]) kinds[row.table].add(row.row_id)
  return { ...ids, rows }
}

/** The --files work for the first `count` file sub-projects (planFiles),
    under Northstar's live top-level projects as the workspace (`joined`)
    holds them, given `stored`, the ids that count as made and those with
    a row (storedIdsOf). The workspace's active tasks count as both too. */
function planFileSeed(count, { org, joined, stored }) {
  const projects = joined('projects')
  const tops = projects
    .filter((p) => p.type === 'meta' && !p.parent_id && !p.archived_at && !SCALE_PROJECTS.has(p.id))
    .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
    .map((top) => ({
      id: top.id,
      subs: projects.filter((p) => p.parent_id === top.id && !p.archived_at).length,
    }))
  for (const task of joined('issues')) {
    stored.tasks.add(task.id)
    stored.rows.tasks.add(task.id)
  }
  return planFiles({ org, count, tops, present: stored, rows: stored.rows })
}

/** Makes the --projects projects of `plan` (planProjects) as Nora, then
    stars its stars for her. */
async function seedProjects(plan, { client, org, target, log }) {
  log(`${plan.projects.length} top-level projects to add for --projects.`)
  const call = async (name, fields, what) => {
    try {
      return await client.mutation(ref(name), fields)
    } catch (error) {
      throw new DemoCliError(`${name} refused ${what}: ${error.data?.message ?? error.message}`)
    }
  }
  for (const fields of plan.projects) await call('projects:create', fields, `"${fields.name}"`)
  for (const id of plan.stars)
    await call('projectNav:setFavorite', { org_id: org, project_id: id, favorite: true }, id)
  log(
    `Done: ${plan.projects.length} top-level projects added and ${plan.stars.length} starred in Northstar on ${target.url}.`,
  )
  if (plan.short > 0)
    log(
      `--projects fell ${plan.short} short of its count, as all ${MOST_PROJECTS} of its numbers are taken, archived and deleted ones included.`,
    )
}

/** Makes the --files sub-projects, tasks and files of `plan` (planFiles)
    as Nora, uploading each file through files:uploadUrl, a POST to the
    local backend and files:attach, as the app does. */
async function seedFiles(plan, { client, org, target, log }) {
  log(
    `${plan.projects.length} sub-projects, ${plan.tasks.length} tasks and ${plan.files.length} files to add for --files.`,
  )
  const call = async (name, fields, what) => {
    try {
      return await client.mutation(ref(name), fields)
    } catch (error) {
      throw new DemoCliError(`${name} refused ${what}: ${error.data?.message ?? error.message}`)
    }
  }
  for (const fields of plan.projects) await call('projects:create', fields, `"${fields.name}"`)
  for (const fields of plan.tasks) await call('issues:create', fields, `"${fields.title}"`)
  for (const file of plan.files) {
    const url = await call('files:uploadUrl', { org_id: org, issue_id: file.issue_id }, file.name)
    if (!isLoopbackOrigin(new URL(url).origin))
      throw new DemoCliError(`files:uploadUrl answered a URL off this machine for ${file.name}.`)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': file.mime },
      body: seededFileText(file.bytes),
    })
    const sent = await res.json().catch(() => ({}))
    if (!res.ok || typeof sent.storageId !== 'string')
      throw new DemoCliError(`The upload of ${file.name} failed (${res.status}).`)
    const out = await call(
      'files:attach',
      {
        org_id: org,
        id: file.id,
        issue_id: file.issue_id,
        storage_id: sent.storageId,
        name: file.name,
        mime: file.mime,
        inline: false,
      },
      file.name,
    )
    if (!out?.attachment)
      throw new DemoCliError(`files:attach refused ${file.name}: ${out?.refused?.message}`)
  }
  log(
    `Done: ${plan.projects.length} sub-projects and ${plan.files.length} files added in Northstar on ${target.url}.`,
  )
}

/* POSTs `bytes` of type `mime` to upload URL `url`, which must be on this
   machine, and answers the stored file's id. */
async function postBytes(url, bytes, mime, what) {
  if (!isLoopbackOrigin(new URL(url).origin))
    throw new DemoCliError(`The upload URL for ${what} is off this machine.`)
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': mime }, body: bytes })
  const sent = await res.json().catch(() => ({}))
  if (!res.ok || typeof sent.storageId !== 'string')
    throw new DemoCliError(`The upload of ${what} failed (${res.status}).`)
  return sent.storageId
}

/** Makes the --images task of `plan` (planImages) when missing, uploads its
    missing images as Nora through files:uploadUrl, a POST and files:attach
    with inline set, as the editor's paste does, and saves its description
    through issues:update. */
async function seedImages(plan, { client, org, target, log }) {
  log(`${plan.uploads.length} description images to add for --images.`)
  const call = async (name, fields, what) => {
    try {
      return await client.mutation(ref(name), fields)
    } catch (error) {
      throw new DemoCliError(`${name} refused ${what}: ${error.data?.message ?? error.message}`)
    }
  }
  if (plan.task) await call('issues:create', plan.task, `"${plan.task.title}"`)
  for (const image of plan.uploads) {
    const bytes = seededImageBytes(image.n)
    const url = await call(
      'files:uploadUrl',
      { org_id: org, issue_id: image.issue_id, size: bytes.length, name: image.name },
      image.name,
    )
    const storageId = await postBytes(url, bytes, 'image/png', image.name)
    const out = await call(
      'files:attach',
      {
        org_id: org,
        id: image.id,
        issue_id: image.issue_id,
        storage_id: storageId,
        name: image.name,
        mime: 'image/png',
        inline: true,
      },
      image.name,
    )
    if (!out?.attachment)
      throw new DemoCliError(`files:attach refused ${image.name}: ${out?.refused?.message}`)
  }
  await call(
    'issues:update',
    { org_id: org, id: imageSeedId('task'), patch: { description: plan.description } },
    'the --images description',
  )
  log(`Done: "${IMAGES_TITLE}" shows its images in Northstar on ${target.url}.`)
}

/** Gives each of `profiles` without a picture one, as Nora through
    files:avatarUploadUrl, a POST and files:setAvatar, as the picture
    editor does. */
async function seedPictures(profiles, { client, target, log }) {
  const bare = profiles.filter((p) => !p.avatar_storage_id)
  log(`${bare.length} people and agents to give a picture for --pictures.`)
  for (const [n, profile] of bare.entries()) {
    const what = `the picture of ${profile.name}`
    const bytes = seededPictureBytes(n)
    try {
      const url = await client.mutation(ref('files:avatarUploadUrl'), {
        profile_id: profile.id,
        size: bytes.length,
      })
      const storageId = await postBytes(url, bytes, 'image/png', what)
      await client.mutation(ref('files:setAvatar'), {
        profile_id: profile.id,
        storage_id: storageId,
      })
    } catch (error) {
      if (error instanceof DemoCliError) throw error
      throw new DemoCliError(`${what} was refused: ${error.data?.message ?? error.message}`)
    }
  }
  log(`Done: ${bare.length} pictures added in Northstar on ${target.url}.`)
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
  // id, says which task window brings it once a page asks for every task.
  client.setAdminAuth(target.key)
  const row = (await tableRows(client, 'issues')).find((task) => task.id === expected.family)
  client.setAdminAuth(target.key, identityOf(actor.auth_user_id))
  if (row?.window_key) log(windowKeyNote(row.window_key))
}

/** What the seed says of the --relations task's window key `key`: how far
    into the key space it is, which names the task window that brings it
    once a page asks for every task (src/store/liveParts.ts). */
export function windowKeyNote(key) {
  const share = Math.round((Number.parseInt(key, 16) / 2 ** 32) * 100)
  return `Its window key is ${key}, ${share}% into the key space. The app loads its task windows only when a page needs every task, all of them at once, so the key names the window that brings it then.`
}

/** Marks the seeded tasks `ids` archived in `seeded` (seededTasks), as a
    run that just archived them finds them, so a later plan of the same run
    reads them as they are now. */
function markArchived(seeded, ids, at = new Date().toISOString()) {
  const archivedNow = new Set(ids)
  for (const [n, entry] of seeded)
    if (archivedNow.has(entry.task.id))
      seeded.set(n, { ...entry, task: { ...entry.task, archived_at: at } })
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
  const snapshot = await seedSnapshot(client, target)
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

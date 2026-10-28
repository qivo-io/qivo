// The stand-in server of the browser benchmark (scripts/benchmark-browser.mjs),
// in a Web Worker beside the benchmark page (scripts/perf/transport.mjs). It
// holds a realistic workspace, answers queries, mutations and subscriptions,
// and sends every result as the JSON text Convex's sync protocol carries,
// each after as long as its bytes take at `mbps`, one at a time. Its own work
// runs on the worker's thread, so the page's script time holds only what a
// real client does: decode the text and update the app.
//
// It serves the workspace in live parts (convex/workspace.ts), its tasks
// and projects in the id windows the app asks for, cut from the whole
// workspace it holds
// (convex/lib/workspaceJoin.ts splitWorkspace). After a write it sends every
// part whose JSON changed, and only those, in one transition, as Convex does.
// It also answers snapshot:forMe, the one query apps before the parts read,
// for a baseline build.
//
// Like Convex, a write's results reach the page before its answer does. A
// subscription result that waits for its turn takes the writes made
// meanwhile, as the server sends each result's latest value.
//
// The workspace is realistic by default. Page parameters change it:
//   tasks (100)          visible tasks
//   descriptions (300)   average description length in characters
//   labels (2)           labels per task
//   links (0.05)         share of tasks that link to another task
//   attachments (0.1)    share of tasks with an attachment
//   subtasks (0.2)       share of tasks that are subtasks
//   follows (0.1)        share of tasks the signed-in person follows
//   people (50)          people in the organization
//   hidden (4)           projects the signed-in person cannot see, as full
//                        of tasks as the visible ones; they reach the
//                        workspace only as anonymized load rows and the
//                        has_hidden_subtasks and has_hidden_parent flags
//   shownload=1          also send the load rows of the tasks the person is
//                        shown, as the server did before the app derived
//                        them from the task rows (an older baseline)
//   shape=varied         a Board-shaped mix instead (variedTask): every
//                        status, a parent for every 25 tasks, due dates,
//                        paused, long-titled and unowned tasks
//   latency (100)        ms before every answer
//   mbps (8)             bandwidth every result waits for
//   appearance (dark)    the signed-in person's appearance mode, dark or
//                        light, which the app reads from appearance:get
import { chunkLists } from '../../convex/lib/arrayLimit'
import { idWindows, startWindows } from '../../convex/lib/idWindows'
import { splitWorkspace } from '../../convex/lib/workspaceJoin'

// the page passes its parameters as the worker's name (scripts/perf/transport.mjs)
/* The most rows one bulk inbox batch changes, convex/model/messages.ts
   INBOX_BATCH, which this worker cannot import with the server code. */
const INBOX_BATCH = 200
const parameters = new URLSearchParams(self.name)
const option = (name, fallback) => {
  const value = parameters.get(name)
  return value === null ? fallback : Number(value)
}
const count = option('tasks', 100)
const latency = option('latency', 100)
const mbps = option('mbps', 8)
const descriptionLength = option('descriptions', 300)
const labelsPerTask = option('labels', 2)
const linkShare = option('links', 0.05)
const attachmentShare = option('attachments', 0.1)
const subtaskShare = option('subtasks', 0.2)
const followShare = option('follows', 0.1)
const peopleCount = Math.max(2, option('people', 50))
const hiddenCount = option('hidden', 4)
const varied = parameters.get('shape') === 'varied'
const shownLoad = parameters.get('shownload') === '1'
const appearance = parameters.get('appearance') === 'light' ? 'light' : 'dark'
const fixtureTime = new Date()
const now = fixtureTime.toISOString()
const day = (offset) => {
  const date = new Date(fixtureTime)
  date.setDate(date.getDate() + offset)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}
/* The same pseudo-random numbers on every page, from [0, 1). */
let seed = 7
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const org = '00000000-0000-4000-8000-000000000001'
/* A row id of kind `kind`, the `n`th: a UUID whose first part is a hash,
   spread like the random ids the app makes (convex/lib/idWindows.ts). */
export const id = (kind, n) => {
  let hash = 0x811c9dc5
  for (const ch of `${kind}:${n}`) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193) >>> 0
  return `${hash.toString(16).padStart(8, '0')}-000${kind}-4000-8000-${String(n).padStart(12, '0')}`
}
const storageId = (n) => `kg2${String(n).padStart(29, '0')}`
const WORDS =
  'the firmware build signs every image before the bootloader checks it against the key in fuse memory so a field update can never run code nobody approved and the test rig repeats this on each board revision during the prüfstand översikt naïve'.split(
    ' ',
  )
/** Markdown prose of about `length` characters. */
const prose = (length) => {
  let text = ''
  while (text.length < length) text += `${WORDS[Math.floor(random() * WORDS.length)]} `
  return text.slice(0, length).trim()
}
const profiles = Array.from({ length: peopleCount }, (_, n) => ({
  id: id('1', n),
  org_id: org,
  auth_user_id: n ? `account-${n}` : 'perf-account',
  email: `planner${n + 1}@testbed.example`,
  // some names in letters past ASCII, as real people's are
  name: `${['Planner', 'Åsa', 'Jörg', 'Zoë'][n % 4]} ${n + 1}`,
  initials: `P${n + 1}`,
  color: '#335577',
  // staff, so hidden projects show as anonymized load like a real member's
  org_role: n === 1 ? 'admin' : 'user',
  active: true,
  kind: 'person',
  plannable_hours: 40,
  message_retention_days: 7,
  accepted_at: now,
  created_at: now,
}))
const me = profiles[0]
const teams = Array.from({ length: Math.ceil(peopleCount / 10) }, (_, n) => ({
  id: id('7', n),
  org_id: org,
  name: `Testbed team ${n + 1}`,
  stale_days: 14,
  archive_days: 30,
  track_delay_default: false,
  created_at: now,
}))
const teamMembers = profiles.map((profile, n) => ({
  team_id: teams[Math.floor(n / 10)].id,
  profile_id: profile.id,
  is_leader: n % 10 === 0,
}))
/** A top-level program and its `size` sub-projects, numbered from `num`. */
const program = (n, key, name, size, num) => {
  const meta = {
    id: id('2', n),
    org_id: org,
    type: 'meta',
    key,
    num,
    name,
    description: prose(120),
    sort_order: n,
    track_delay: varied,
    created_at: now,
  }
  const children = Array.from({ length: size }, (_, c) => ({
    ...meta,
    id: id('3', n * 100 + c),
    type: 'project',
    parent_id: meta.id,
    key: `${key}${c}`,
    num: num + c + 1,
    name: `${name.replace('program', 'project')} ${c + 1}`,
    sort_order: c,
  }))
  return { meta, children }
}
const visible = program(0, 'TEST', 'Testbed program', 10, 1)
const hidden = program(1, 'HIDE', 'Hidden program', hiddenCount, 20)
const projects = visible.children
// a grant on the program reaches its sub-projects; the hidden one has none
const access = [{ project_id: visible.meta.id, profile_id: me.id, level: 'user' }]
const labels = Array.from({ length: 12 }, (_, n) => ({
  id: id('8', n),
  org_id: org,
  name: `Label ${String.fromCharCode(65 + n)}`,
  name_lower: `label ${String.fromCharCode(97 + n)}`,
  color: '#557733',
  created_at: now,
}))
const milestones = Array.from({ length: 4 }, (_, n) => ({
  id: id('9', n),
  project_id: visible.meta.id,
  name: `Milestone ${n + 1}`,
  week: day(n * 14),
  created_at: now,
}))
// no Backlog: the Roadmap leaves some of those out, and every phase wants them all
const STATUSES = ['todo', 'todo', 'progress', 'progress', 'review', 'done']
/* Ten tasks a block in one project. Inside a block the task at 5 is a
   parent of up to the next `subtaskShare × 10` ones, so the first task,
   which the drag phase moves, is always a plain one. */
const subtasksPerBlock = Math.min(4, Math.round(subtaskShare * 10))
const parentOf = (n) => {
  const at = n % 10
  return at > 5 && at <= 5 + subtasksPerBlock ? id('4', n - at + 5) : undefined
}
/** Task `n`, visible or not, in `project`, with every optional field a
    working task tends to have. */
const taskRow = (n, uid, project, parent) => {
  const status = STATUSES[n % STATUSES.length]
  const owner = profiles[n % peopleCount].id
  const reviewer = profiles[(n + 1) % peopleCount].id
  const length = Math.round(descriptionLength * (0.2 + 1.6 * random()))
  const row = {
    id: uid,
    org_id: org,
    project_id: project.id,
    num: n + 1,
    title: `Testbed ${n % 2 ? 'firmware signed' : 'signed firmware'} task ${n + 1}`,
    description: length ? prose(length) : '',
    status,
    priority: ['urgent', 'high', 'medium', 'low'][n % 4],
    assignee_id: owner,
    reviewer_id: n % 3 ? reviewer : undefined,
    parent_id: parent,
    start_week: day(n % 21),
    end_week: day((n % 21) + 7),
    due_date: n % 5 ? undefined : day((n % 21) + 10),
    remaining_hours: 4 + (n % 9),
    remaining_set_at: now,
    paused: n % 23 === 22 && status !== 'done' && status !== 'backlog',
    created_by: owner,
    reporter_id: profiles[(n + 2) % peopleCount].id,
    done_at: status === 'done' ? now : undefined,
    review_at: status === 'review' || status === 'done' ? now : undefined,
    status_at: now,
    created_at: now,
    updated_at: now,
  }
  for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key]
  return row
}
/* The server's tasks: `count` visible ones, then the hidden projects' as
   many a project. Every 20th hidden task is a subtask of a visible parent,
   and every 20th visible plain task one of a hidden parent. */
const perProject = Math.max(1, Math.ceil(count / projects.length))
/** Task `n` of the varied workspace. Every 25th task is a parent of the
    three after it, every 7th has a due date (every other one past), every
    31st is paused unless it is in Backlog or Done, every 13th has an
    80-character title (TITLE_MAX, the longest the server keeps) and every
    11th has no owner. As the server keeps them, parents have no remaining
    hours and no task in Backlog or Done is paused. */
const variedTask = (n) => {
  const parent = n - (n % 25)
  const child = n % 25 > 0 && n % 25 <= 3
  const project = projects[Math.floor((child ? parent : n) / 10) % projects.length]
  const row = taskRow(n, id('4', n), project, child ? id('4', parent) : undefined)
  row.status = ['backlog', 'todo', 'progress', 'review', 'done'][n % 5]
  row.paused = n % 31 === 0 && !['backlog', 'done'].includes(row.status)
  if (row.status === 'done') row.done_at = now
  else delete row.done_at
  if (row.status === 'review' || row.status === 'done') row.review_at = now
  else delete row.review_at
  if (n % 25 === 0) {
    delete row.remaining_hours
    delete row.remaining_set_at
  }
  delete row.due_date
  if (n % 7 === 0) row.due_date = day((n / 7) % 2 ? -((n % 40) + 1) : (n % 40) + 1)
  if (n % 13 === 0)
    row.title =
      `${row.title} ${'with a longer description of the work it covers '.repeat(2)}`.slice(0, 80)
  if (n % 11 === 0) delete row.assignee_id
  return row
}
const tasks = Array.from({ length: count }, (_, n) =>
  varied
    ? variedTask(n)
    : taskRow(n, id('4', n), projects[Math.floor(n / 10) % projects.length], parentOf(n)),
)
const hiddenTasks = Array.from({ length: perProject * hiddenCount }, (_, h) =>
  taskRow(
    count + h,
    id('5', h),
    hidden.children[Math.floor(h / 10) % hiddenCount],
    h % 20 === 1 && count > 5 ? id('4', 5 + 10 * (h % Math.floor(count / 10 || 1))) : undefined,
  ),
)
if (hiddenTasks.length)
  for (const row of tasks)
    if (!row.parent_id && row.num % 20 === 13) row.parent_id = hiddenTasks[0].id
const shown = new Set(tasks.map((row) => row.id))
const allTasks = [...tasks, ...hiddenTasks]
// visible tasks with a hidden subtask (workingSetOf's hidden subtask parents)
const hiddenSubtaskParents = new Set(hiddenTasks.map((row) => row.parent_id).filter(Boolean))
/** The tasks with a subtask, among every live task (lib/liveTasks.ts
    groupTest; every project here is active). */
const parentsOf = () => new Set(allTasks.filter((row) => row.parent_id).map((row) => row.parent_id))
let parents = parentsOf()
/** Task `row` as the workspace sends it (convex/lib/workspaceParts.ts
    readTasks), and as forMe sent it to baseline builds. */
const wireTask = (row) => {
  const { parent_id: parent, ...rest } = row
  const out = parent && shown.has(parent) ? { ...rest, parent_id: parent } : rest
  out.has_hidden_parent = !!parent && !shown.has(parent)
  out.has_hidden_subtasks = hiddenSubtaskParents.has(row.id)
  return out
}
/** The load row the snapshot sends for task `row`, or null:
    convex/planning.ts orgLoadRows' fence for a staff reader, every owner in
    the organization, kept for tasks the reader is not shown only, as the
    tasks part sends them (the app derives the shown tasks' load from their
    rows), or
    for every task with shownload=1. */
const loadRow = (row) => {
  if (parents.has(row.id) || (!shownLoad && shown.has(row.id))) return null
  const owner = row.status === 'review' && row.reviewer_id ? row.reviewer_id : row.assignee_id
  if (owner === undefined || row.start_week === undefined || row.end_week === undefined) return null
  if (row.status === 'done' || row.paused || !((row.remaining_hours ?? 0) > 0)) return null
  return {
    issue_id: shown.has(row.id) ? row.id : null,
    owner_id: owner,
    start_week: row.start_week,
    end_week: row.end_week,
    remaining: row.remaining_hours,
    remaining_set_at: row.remaining_set_at ?? null,
  }
}
const wireRows = new Map(tasks.map((row) => [row.id, wireTask(row)]))
const loadRows = new Map(allTasks.map((row) => [row.id, loadRow(row)]))
const issueLabels = tasks.flatMap((row, n) =>
  Array.from({ length: labelsPerTask }, (_, k) => ({
    issue_id: row.id,
    label_id: labels[(n + k * 5) % labels.length].id,
  })),
)
/** Whether task `n` is among a `share` of the tasks, spread evenly. Each
    relation takes another `offset`, so they fall on different tasks. */
const picked = (n, share, offset) =>
  share > 0 && Math.floor((n + offset + 1) * share) > Math.floor((n + offset) * share)
const links = tasks.flatMap((row, n) => {
  if (!picked(n, linkShare, 1) || n + 3 >= count) return []
  const target = tasks[n + 3].id
  return [
    {
      id: id('a', n),
      source_id: row.id,
      target_id: target,
      type: n % 2 ? 'blocks' : 'relates',
      pair_key: [row.id, target].sort().join(':'),
      created_at: now,
    },
  ]
})
const attachments = tasks.flatMap((row, n) => {
  if (!picked(n, attachmentShare, 2)) return []
  return [
    {
      id: id('b', n),
      issue_id: row.id,
      name: `measurement-${n}.pdf`,
      size_bytes: 20_000 + n,
      mime: 'application/pdf',
      storage_id: storageId(n),
      inline: n % 3 === 0,
      uploaded_by: row.assignee_id,
      created_at: now,
    },
  ]
})
const issueSubs = tasks.flatMap((row, n) => {
  return picked(n, followShare, 3) ? [{ issue_id: row.id, profile_id: me.id, created_at: now }] : []
})
const snapshot = {
  auth_user_id: 'perf-account',
  myProfileIds: [me.id],
  orgs: [
    {
      id: org,
      name: 'Testbed Labs',
      slug: 'testbed',
      created_at: now,
      next_issue_num: count + hiddenTasks.length + 1,
      next_project_num: 20 + hiddenCount + 1,
      // every task is active, and both programs and their projects are live
      active_tasks: count + hiddenTasks.length,
      live_projects: 12 + hiddenCount,
      date_format: 'iso',
      week_start: 1,
      week_one_rule: 'first4day',
      default_plannable_hours: 40,
      max_attachment_mb: 20,
    },
  ],
  profiles,
  projects: [visible.meta, ...projects],
  issues: [...wireRows.values()],
  teams,
  teamMembers,
  access,
  teamAccess: [],
  links,
  milestones,
  labels,
  issueLabels,
  issueSubs,
  attachments,
  orgLoad: [],
  messages: [],
  readMessageCount: 0,
  unreadTruncated: false,
  readTruncated: false,
  delivered_at: now,
}
/* How many cards the Board shows: every visible task but the parents,
   whose subtasks are their cards. settleTasks keeps it. */
let cards = 0
/* Rebuilds the derived lists after a write: the task rows in creation
   order and the load rows. A write replaces the row objects it changes, so
   the rows it did not touch keep their cached JSON. */
function settleTasks() {
  parents = parentsOf()
  snapshot.issues = [...wireRows.values()]
  snapshot.orgLoad = [...loadRows.values()].filter((row) => row !== null)
  cards = tasks.filter((row) => !parents.has(row.id)).length
}
settleTasks()

/** The snapshot as forMe sends it: its long lists past 8,192 values in
    parts (convex/lib/arrayLimit.ts). */
function wireSnapshot() {
  const { auth_user_id, myProfileIds, orgs, messages, ...rest } = snapshot
  const { readMessageCount, unreadTruncated, readTruncated, delivered_at, ...lists } = rest
  return {
    auth_user_id,
    myProfileIds,
    orgs,
    ...chunkLists(lists),
    messages,
    readMessageCount,
    unreadTruncated,
    readTruncated,
    delivered_at,
  }
}

/* --- the wire ------------------------------------------------------------- */
const rowText = new WeakMap()
/** UTF-8 length of `text`. */
export const utf8 = (text) => {
  let bytes = text.length
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // a surrogate pair is two units and four bytes, so the high one adds two
    if (code >= 0xd800 && code <= 0xdfff) bytes += code <= 0xdbff ? 2 : 0
    else if (code >= 0x800) bytes += 2
    else if (code >= 0x80) bytes += 1
  }
  return bytes
}
/** The JSON text of `value` and its bytes. Objects and lists hold rows
    serialized once each (rowText): a row a write changes is a new object. */
function encode(value) {
  if (Array.isArray(value)) {
    const parts = value.map(encode)
    return {
      text: `[${parts.map((part) => part.text).join(',')}]`,
      bytes: parts.reduce((sum, part) => sum + part.bytes, 1 + Math.max(0, parts.length - 1) + 1),
    }
  }
  if (value && typeof value === 'object') {
    let known = rowText.get(value)
    if (known) return known
    const flat = Object.values(value).every((inner) => inner === null || typeof inner !== 'object')
    if (flat) {
      const text = JSON.stringify(value)
      known = { text, bytes: utf8(text) }
      rowText.set(value, known)
      return known
    }
    const parts = Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .map(([key, inner]) => {
        const name = JSON.stringify(key)
        const part = encode(inner)
        return { text: `${name}:${part.text}`, bytes: utf8(name) + 1 + part.bytes }
      })
    return {
      text: `{${parts.map((part) => part.text).join(',')}}`,
      bytes: parts.reduce((sum, part) => sum + part.bytes, 2 + Math.max(0, parts.length - 1)),
    }
  }
  const text = JSON.stringify(value ?? null)
  return { text, bytes: utf8(text) }
}
/** Waits as long as `bytes` take at `mbps`. */
const transfer = (bytes) => new Promise((resolve) => setTimeout(resolve, bytes / (mbps * 125)))
/* Results leave one at a time, in order, as on one socket. */
let lastDelivery = Promise.resolve()
/** Sends the value `result` answers when its turn comes, to `to` (a
    subscription or a query call), and resolves once it is sent. */
function deliver(to, result) {
  const sent = lastDelivery.then(async () => {
    let encoded
    try {
      encoded = encode(result())
    } catch (error) {
      // a read the server cannot answer fails only its own caller
      post({ type: 'result', to, error: String(error?.message ?? error) })
      return
    }
    await transfer(encoded.bytes)
    post({ type: 'result', to, ...encoded })
  })
  lastDelivery = sent
  return sent
}
/** Posts `message` to the page with the counters it mirrors. */
const post = (message) =>
  self.postMessage({ ...message, writes, held: held.length, made: tasks.length, cards })
let writes = 0
const listeners = new Map()
const delay = () => new Promise((resolve) => setTimeout(resolve, latency))
const comments = []
let messageCount = 0
const roadmapCounts = new Map()
/* The windows of the workspace's parts, as the app chooses them from the
   counts (src/store/liveParts.ts), kept from the first read, so a window
   keeps its bounds while rows come and go. */
let windowsOf = null
/* The parts cut from the workspace as it is now, until the next change. */
let partsCache = null
/** The parts of the workspace as convex/workspace.ts answers them. */
function partsNow() {
  if (partsCache) return partsCache
  const [row] = snapshot.orgs
  const start = startWindows(row)
  windowsOf ??= {
    tasks: idWindows(start.tasks),
    people: idWindows(1),
    projects: idWindows(start.projects),
  }
  partsCache = splitWorkspace(snapshot, (_org, kind) => windowsOf[kind])[0]
  return partsCache
}
const PART_KINDS = {
  'workspace:tasks': 'tasks',
  'workspace:people': 'people',
  'workspace:projects': 'projects',
}
/** What workspace part `name` answers for `args`. */
function readPart(name, args) {
  const part = partsNow()
  if (name === 'workspace:root')
    return {
      auth_user_id: snapshot.auth_user_id,
      myProfileIds: snapshot.myProfileIds,
      orgs: snapshot.orgs,
      // when the login may create an organization, which the app reads as
      // 'now' when absent (convex/lib/workspaceParts.ts readRoot)
      ...(snapshot.create === undefined ? {} : { create: snapshot.create }),
    }
  if (name === 'workspace:catalog') return { state: 'ok', ...chunkLists(part.catalog) }
  if (name === 'workspace:inbox') return { state: 'ok', ...part.inbox }
  const kind = PART_KINDS[name]
  const at = windowsOf[kind].findIndex((w) => w.from === args.from)
  return { state: 'ok', ...chunkLists(part[kind][at]) }
}
const read = (name, args = {}) => {
  if (name.startsWith('workspace:')) return readPart(name, args)
  switch (name) {
    case 'snapshot:forMe':
      snapshot.delivered_at = new Date().toISOString()
      return wireSnapshot()
    case 'prefs:get':
      return null
    case 'appearance:get':
      return { mode: appearance, image_source: 'none', custom_image: null }
    case 'appearance:dailyImage':
      return null
    case 'billing:status':
      return {
        enabled: false,
        writable: true,
        status: 'active',
        complimentary_until: null,
        current_period_end: null,
      }
    case 'snapshot:threadComments':
      return {
        comments: comments.filter((comment) => comment.issue_id === args.issue_id),
        earlier: false,
      }
    case 'snapshot:threadHistory':
      return { events: [], earlier: false, next: null }
    case 'teamSync:lastComments':
      return { rows: [], complete: true }
    case 'admin:isOperator':
      return false
    case 'messages:bulkReach':
      // as convex/model/messages.ts readBulkReach does, per seat
      return {
        seats: snapshot.orgs.map((org) => {
          const mine = snapshot.messages.filter((m) => m.org_id === org.id)
          const unread = mine.filter((m) => !m.read_at)
          const walked = mine.filter(
            (m) => !m.snoozed_until && !!m.read_at === (args.action === 'remove'),
          )
          const reach = walked.length === 0 ? 'none' : walked.length > INBOX_BATCH ? 'many' : 'one'
          return args.action === 'remove'
            ? { org_id: org.id, reach }
            : {
                org_id: org.id,
                reach,
                before: Math.max(0, ...unread.map((m) => Date.parse(m.created_at))),
              }
        }),
      }
    default:
      throw new Error(`Unimplemented benchmark query: ${name}`)
  }
}
/** Delivers query `name`'s new result to its listeners, and resolves once
    it reached them. */
function emit(name) {
  return Promise.all([...(listeners.get(name) || [])].map((subscription) => subscription.send()))
}

/* The watched parts by id, each with its query, args and the JSON it last
   sent, and the parts watched since the last transition. */
const watchedParts = new Map()
/* Whether a timer will answer the parts watched since it was set. */
let watchPending = false
/* The transition waiting for its turn, which takes every part that changed
   by the time it is sent. */
let nextTransition = null
/** Sends one transition with every watched part whose JSON changed, those
    `fresh` first answered among them, when its turn comes. Resolves once
    it is sent. */
function transition() {
  nextTransition ??= lastDelivery.then(async () => {
    nextTransition = null
    const results = []
    let bytes = 0
    for (const [to, part] of watchedParts) {
      let encoded
      try {
        encoded = encode(read(part.name, part.args))
      } catch (error) {
        results.push({ to, error: String(error?.message ?? error) })
        continue
      }
      if (encoded.text === part.sent) continue
      part.sent = encoded.text
      results.push({ to, ...encoded })
      bytes += encoded.bytes
    }
    await transfer(bytes)
    post({ type: 'transition', at: Date.now(), results })
  })
  lastDelivery = nextTransition
  return nextTransition
}
/** Sends the workspace's changes: to an app before the parts its one
    query, else the parts that changed. */
function emitWorkspace() {
  partsCache = null
  return Promise.all([emit('snapshot:forMe'), watchedParts.size ? transition() : null])
}
/* The server's prune of one inbox item after a read (convex/model/messages.ts
   pruneStampedItem): it keeps the newest unread row or, with none, the
   newest read row, and deletes the other read rows. */
function pruneItem(issueId) {
  const rows = snapshot.messages.filter((m) => m.issue_id === issueId)
  const newer = (a, b) =>
    b.created_at > a.created_at || (b.created_at === a.created_at && b.id > a.id) ? b : a
  const unread = rows.filter((m) => !m.read_at)
  const keep = unread.length ? unread.reduce(newer) : rows.reduce(newer)
  snapshot.messages = snapshot.messages.filter(
    (m) => m.issue_id !== issueId || !m.read_at || m === keep,
  )
}
/* Marks the messages in `marked` read at `at`, as new rows. */
function markRead(marked, at) {
  const ids = new Set(marked.map((m) => m.id))
  snapshot.messages = snapshot.messages.map((m) => (ids.has(m.id) ? { ...m, read_at: at } : m))
}
/* Counts the read rows and delivers the inbox's new state. */
function settleInbox() {
  snapshot.readMessageCount = snapshot.messages.filter((m) => m.read_at).length
  return emitWorkspace()
}
/* Writes the scenarios hold until they release them, in order. */
const held = []
let holding = false
/** Changes task `taskId` by `patch`, as a new row, and answers whether
    anything changed. */
function patchTask(taskId, patch) {
  const at = tasks.findIndex((issue) => issue.id === taskId)
  if (at < 0) throw new Error('Unknown benchmark task')
  const old = tasks[at]
  const changed = Object.entries(patch).some(([field, value]) => (old[field] ?? null) !== value)
  if (!changed) return false
  const row = { ...old }
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete row[field]
    else row[field] = value
  }
  row.updated_at = new Date().toISOString()
  if ('remaining_hours' in patch) {
    if (row.remaining_hours === undefined) delete row.remaining_set_at
    else row.remaining_set_at = row.updated_at
  }
  tasks[at] = row
  allTasks[allTasks.indexOf(old)] = row
  wireRows.set(row.id, wireTask(row))
  loadRows.set(row.id, loadRow(row))
  settleTasks()
  return true
}
/* The subscriptions by id, each with its query and args. */
const subscriptions = new Map()

/** Runs mutation `name` with `args` and answers its result. */
async function mutate(name, args) {
  if (name === 'identity:claimMySeats' || name === 'prefs:save') return null
  if (name === 'messages:markRead') {
    const ids = new Set(args.ids)
    const at = new Date().toISOString()
    const marked = snapshot.messages.filter((m) => ids.has(m.id) && !m.read_at)
    markRead(marked, at)
    for (const issue of new Set(marked.map((m) => m.issue_id))) pruneItem(issue)
    await settleInbox()
    return null
  }
  if (name === 'messages:markAllRead') {
    // as convex/model/messages.ts markAllMessagesRead does: at most
    // INBOX_BATCH unsnoozed unread rows a batch, created no later than the
    // first batch's cutoff, the newest unread row's creation, then the prune
    const unread = snapshot.messages.filter(
      (m) => !m.read_at && !m.snoozed_until && m.org_id === args.org_id,
    )
    const before = args.before ?? Math.max(0, ...unread.map((m) => Date.parse(m.created_at)))
    const due = unread.filter((m) => Date.parse(m.created_at) <= before)
    const batch = due.slice(0, INBOX_BATCH)
    const at = new Date().toISOString()
    markRead(batch, at)
    for (const issue of new Set(batch.map((m) => m.issue_id))) pruneItem(issue)
    if (batch.length) await settleInbox()
    writes++
    const ids = batch.map((m) => m.id)
    return { marked: ids.length, ids, hasMore: due.length > batch.length, before }
  }
  if (name === 'issues:update') {
    if (patchTask(args.id, args.patch)) await emitWorkspace()
    writes++
    return null
  }
  if (name === 'roadmap:change') {
    // Only dates change here, so no task becomes or stops being a group.
    let changed = false
    for (const operation of args.operations) {
      if (operation.kind !== 'task')
        throw new Error(`Unimplemented benchmark roadmap operation: ${operation.kind}`)
      changed = patchTask(operation.id, operation.patch) || changed
    }
    const count = (roadmapCounts.get(args.session_id) || 0) + Number(changed)
    roadmapCounts.set(args.session_id, count)
    if (changed) await emitWorkspace()
    writes++
    return { count }
  }
  throw new Error(`Unimplemented benchmark mutation: ${name}`)
}

/* What the benchmark asks the server to do, each answering once its
   results are sent. */
const scenarios = {
  /* Delivers `n` new unread messages for the signed-in person, one per task,
     for the bulk-read scenario. */
  seedMessages(n) {
    const created = new Date().toISOString()
    for (let i = 0; i < n; i++) scenarios.addMessage(i % count, created)
    return emitWorkspace()
  },
  /* Adds one unread message about task `n`, created at `created`. */
  addMessage(n, created = new Date().toISOString()) {
    snapshot.messages = [
      ...snapshot.messages,
      {
        id: id('6', messageCount++),
        org_id: org,
        recipient_id: me.id,
        issue_id: id('4', n),
        issue_title: `Testbed task ${n + 1}`,
        kind: 'change',
        actor_id: profiles[1].id,
        detail: 'Status changed',
        created_at: created,
      },
    ]
  },
  /* Another person renames task `n`, which every listener receives. */
  /* Another person moves task `n` to `status`, for checks by hand. */
  moveRemote(n, status) {
    patchTask(tasks[n].id, { status })
    return emitWorkspace()
  },
  deliverRemote(n) {
    patchTask(tasks[n].id, { title: `Renamed elsewhere ${Date.now()}` })
    return emitWorkspace()
  },
  /* Another person creates a task in the first project. */
  deliverCreate() {
    const n = tasks.length + hiddenTasks.length
    const row = taskRow(n, id('4', 900000 + n), projects[0], undefined)
    tasks.push(row)
    allTasks.push(row)
    shown.add(row.id)
    wireRows.set(row.id, wireTask(row))
    loadRows.set(row.id, loadRow(row))
    const [org] = snapshot.orgs
    snapshot.orgs = [
      { ...org, next_issue_num: org.next_issue_num + 1, active_tasks: org.active_tasks + 1 },
    ]
    settleTasks()
    return emitWorkspace()
  },
  /* Another person renames the first project. */
  deliverProjectRename() {
    snapshot.projects = snapshot.projects.map((project) =>
      project.id === projects[0].id
        ? { ...project, name: `Renamed project ${Date.now()}` }
        : project,
    )
    return emitWorkspace()
  },
  /* One new message for the signed-in person arrives. */
  deliverMessage() {
    scenarios.addMessage(4)
    return emitWorkspace()
  },
  /* A Team sync sitting stamps another person (convex/teamSync.ts stamp). */
  deliverStamp() {
    const at = new Date().toISOString()
    snapshot.profiles = snapshot.profiles.map((profile, n) =>
      n === 2 ? { ...profile, sync_at: at, sync_since: profile.sync_at ?? day(-7) } : profile,
    )
    return emitWorkspace()
  },
  deliverComments() {
    const active = [
      ...(listeners.get('snapshot:threadComments') || []),
      ...[...watchedParts.values()].filter((part) => part.name === 'snapshot:threadComments'),
    ]
    if (active.length !== 1) throw new Error('Benchmark requires one open comment thread')
    const body = `Benchmark delivered comment ${comments.length + 1}`
    comments.push({
      id: id('5', 800000 + comments.length),
      issue_id: active[0].args.issue_id,
      author: profiles[1].id,
      body,
      created_at: new Date().toISOString(),
    })
    void emit('snapshot:threadComments')
    if (watchedParts.size) void transition()
    return body
  },
}

/* The answer of the write before, which the next one waits for. */
let lastAnswer = Promise.resolve()

/** Runs write `data` and answers it once `turn`, the answer of the write
    before it, is sent. */
async function write(data, turn) {
  if (holding && data.name !== 'identity:claimMySeats' && data.name !== 'prefs:save') {
    const refused = await new Promise((resolve) => {
      held.push(resolve)
      post({ type: 'state' })
    })
    if (refused) {
      await turn
      post({
        type: 'answer',
        id: data.id,
        error: { code: 'forbidden', message: 'no write access' },
      })
      return
    }
  }
  try {
    const result = mutate(data.name, data.args)
    // as Convex answers a write once the results that hold it are in: the
    // ones it queued and those before it, which a write that changed
    // nothing waits for too, but not those of later writes
    const barrier = lastDelivery
    const value = await result
    await turn
    await barrier
    post({ type: 'answer', id: data.id, value })
  } catch (error) {
    await turn
    post({ type: 'answer', id: data.id, failure: String(error?.message ?? error) })
  }
}

self.onmessage = async ({ data }) => {
  switch (data.type) {
    case 'subscribe': {
      const { id: sub, name, args } = data
      let next = null
      const subscription = {
        args,
        send() {
          next ??= deliver(sub, () => {
            next = null
            return read(name, args)
          })
          return next
        },
      }
      subscriptions.set(sub, { name, subscription })
      const group = listeners.get(name) || new Set()
      listeners.set(name, group)
      group.add(subscription)
      setTimeout(() => {
        if (subscriptions.has(sub)) void subscription.send()
      }, latency)
      return
    }
    case 'watch': {
      watchedParts.set(data.id, { name: data.name, args: data.args, sent: null })
      // the parts watched in one task are answered in one transition
      if (!watchPending) {
        watchPending = true
        setTimeout(() => {
          watchPending = false
          void transition()
        }, latency)
      }
      return
    }
    case 'unwatch':
      watchedParts.delete(data.id)
      return
    case 'unsubscribe': {
      const entry = subscriptions.get(data.id)
      subscriptions.delete(data.id)
      listeners.get(entry?.name)?.delete(entry?.subscription)
      return
    }
    case 'query':
      await delay()
      await deliver(data.id, () => read(data.name, data.args))
      return
    case 'mutation': {
      // writes are answered in the order they came, as Convex answers them
      const turn = lastAnswer
      let answered = () => {}
      lastAnswer = new Promise((resolve) => {
        answered = resolve
      })
      try {
        await delay()
        await write(data, turn)
      } finally {
        answered()
      }
      return
    }
    case 'scenario':
      try {
        post({ type: 'answer', id: data.id, value: await scenarios[data.name](...data.args) })
      } catch (error) {
        post({ type: 'answer', id: data.id, failure: String(error?.message ?? error) })
      }
      return
    case 'hold':
      holding = true
      return
    case 'releaseOne':
      held.shift()?.(data.refuse)
      post({ type: 'state' })
      return
    case 'releaseAll':
      holding = false
      while (held.length) held.shift()(false)
      post({ type: 'state' })
      return
  }
}

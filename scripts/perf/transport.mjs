// Deterministic authenticated transport for browser CPU/DOM measurements only.
// Like Convex, a write's snapshot reaches the listeners before it resolves.
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'

const parameters = new URLSearchParams(location.search)
const count = Number(parameters.get('tasks') || 100)
const latency = Number(parameters.get('latency') || 100)
// shape=varied mixes statuses, parents, due dates, pauses, long titles and
// unassigned tasks into the workspace; without it every task looks alike
const varied = parameters.get('shape') === 'varied'
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
const org = '00000000-0000-4000-8000-000000000001'
const id = (kind, n) => `${kind.padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`
const profiles = Array.from({ length: 10 }, (_, n) => ({
  id: id('1', n),
  org_id: org,
  auth_user_id: n ? `account-${n}` : 'perf-account',
  name: `Planner ${n + 1}`,
  initials: `P${n + 1}`,
  color: '#335577',
  org_role: n ? 'user' : 'admin',
  active: true,
  kind: 'person',
  created_at: now,
  plannable_hours: 40,
}))
const meta = {
  id: id('2', 0),
  org_id: org,
  type: 'meta',
  key: 'TEST',
  num: 1,
  name: 'Testbed program',
  description: '',
  sort_order: 0,
  track_delay: varied,
  created_at: now,
}
const projects = Array.from({ length: 10 }, (_, n) => ({
  ...meta,
  id: id('3', n),
  type: 'project',
  parent_id: meta.id,
  key: `TEST${n}`,
  num: n + 2,
  name: `Testbed project ${n + 1}`,
  sort_order: n,
}))
/** Task `n` of the default workspace: every task alike. */
const task = (n) => ({
  id: id('4', n),
  org_id: org,
  project_id: projects[n % projects.length].id,
  num: n + 1,
  title: `Testbed ${n % 2 ? 'firmware signed' : 'signed firmware'} task ${n + 1}`,
  description: '',
  status: 'todo',
  priority: 'medium',
  assignee_id: profiles[n % profiles.length].id,
  remaining_hours: 4,
  remaining_set_at: now,
  paused: false,
  created_at: now,
  updated_at: now,
  start_week: day(n % 21),
  end_week: day((n % 21) + 7),
  has_hidden_subtasks: false,
})
const STATUSES = ['backlog', 'todo', 'progress', 'review', 'done']
/** Task `n` of the varied workspace. Every 25th task is a parent of the
    three after it, every 7th has a due date (every other one past), every
    31st is paused, every 13th has a 90-character title and every 11th has
    no owner. */
const variedTask = (n) => {
  const row = task(n)
  row.status = STATUSES[n % STATUSES.length]
  const parent = n - (n % 25)
  if (n % 25 > 0 && n % 25 <= 3) {
    row.parent_id = id('4', parent)
    row.project_id = projects[parent % projects.length].id
  }
  if (n % 7 === 0) row.due_date = day((n / 7) % 2 ? -((n % 40) + 1) : (n % 40) + 1)
  if (n % 31 === 0) row.paused = true
  if (n % 13 === 0)
    row.title =
      `${row.title} ${'with a longer description of the work it covers '.repeat(2)}`.slice(0, 90)
  if (n % 11 === 0) delete row.assignee_id
  return row
}
const snapshot = {
  auth_user_id: 'perf-account',
  myProfileIds: [profiles[0].id],
  orgs: [
    {
      id: org,
      name: 'Testbed Labs',
      slug: 'testbed',
      created_at: now,
      next_issue_num: count,
      next_project_num: 11,
      date_format: 'iso',
      week_start: 1,
      week_one_rule: 'first4day',
      default_plannable_hours: 40,
    },
  ],
  profiles,
  projects: [meta, ...projects],
  issues: Array.from({ length: count }, (_, n) => (varied ? variedTask(n) : task(n))),
  teams: [],
  teamMembers: [],
  access: [],
  teamAccess: [],
  links: [],
  milestones: [],
  labels: [],
  issueLabels: [],
  issueSubs: [],
  attachments: [],
  orgLoad: [],
  messages: [],
  readMessageCount: 0,
  unreadTruncated: false,
  readTruncated: false,
  delivered_at: now,
}
const listeners = new Map()
const comments = []
const roadmapCounts = new Map()
const delay = () => new Promise((resolve) => setTimeout(resolve, latency))
const read = (name, args = {}) => {
  switch (name) {
    case 'snapshot:forMe':
      return snapshot
    case 'prefs:get':
      return null
    case 'appearance:get':
      return { mode: 'dark', image_source: 'none', custom_image: null }
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
    case 'snapshot:commentThread':
      return {
        comments: comments.filter((comment) => comment.issue_id === args.issue_id),
        earlier: false,
        events: [],
      }
    case 'teamSync:lastComments':
      return { rows: [], complete: true }
    case 'admin:isOperator':
      return false
    default:
      throw new Error(`Unimplemented benchmark query: ${name}`)
  }
}
function emit(name) {
  if (name === 'snapshot:forMe') snapshot.delivered_at = new Date().toISOString()
  for (const { args, receive } of listeners.get(name) || [])
    receive(structuredClone(read(name, args)))
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
/* Counts the read rows and delivers the inbox's new state. */
function settleInbox() {
  snapshot.readMessageCount = snapshot.messages.filter((m) => m.read_at).length
  emit('snapshot:forMe')
}
/* Writes the scenarios hold until they release them, in order. */
const held = []
let holding = false
function patchTask(taskId, patch) {
  const row = snapshot.issues.find((issue) => issue.id === taskId)
  if (!row) throw new Error('Unknown benchmark task')
  const changed = Object.entries(patch).some(([field, value]) => (row[field] ?? null) !== value)
  if (!changed) return false
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete row[field]
    else row[field] = value
  }
  row.updated_at = new Date().toISOString()
  if ('remaining_hours' in patch) {
    if (row.remaining_hours === undefined) delete row.remaining_set_at
    else row.remaining_set_at = row.updated_at
  }
  return true
}
export const convex = {
  async query(ref, args) {
    await delay()
    return structuredClone(read(getFunctionName(ref), args))
  },
  onUpdate(ref, args, receive) {
    const name = getFunctionName(ref)
    const group = listeners.get(name) || new Set()
    listeners.set(name, group)
    const subscription = { args, receive }
    group.add(subscription)
    const timer = setTimeout(() => receive(structuredClone(read(name, args))), latency)
    return () => {
      clearTimeout(timer)
      group.delete(subscription)
    }
  },
  async mutation(ref, args) {
    const name = getFunctionName(ref)
    await delay()
    if (holding && name !== 'identity:claimMySeats' && name !== 'prefs:save') {
      const refused = await new Promise((resolve) => held.push(resolve))
      if (refused) throw new ConvexError({ code: 'forbidden', message: 'no write access' })
    }
    if (name === 'identity:claimMySeats' || name === 'prefs:save') return null
    if (name === 'messages:markRead') {
      const ids = new Set(args.ids)
      const at = new Date().toISOString()
      const marked = snapshot.messages.filter((m) => ids.has(m.id) && !m.read_at)
      for (const message of marked) message.read_at = at
      for (const issue of new Set(marked.map((m) => m.issue_id))) pruneItem(issue)
      settleInbox()
      return null
    }
    if (name === 'messages:markAllRead') {
      // as convex/model/messages.ts markAllMessagesRead does: at most 256
      // unsnoozed unread rows a batch, created no later than the first
      // batch's cutoff, the newest unread row's creation, then the prune
      const unread = snapshot.messages.filter(
        (m) => !m.read_at && !m.snoozed_until && m.org_id === args.org_id,
      )
      const before = args.before ?? Math.max(0, ...unread.map((m) => Date.parse(m.created_at)))
      const due = unread.filter((m) => Date.parse(m.created_at) <= before)
      const batch = due.slice(0, 256)
      const at = new Date().toISOString()
      for (const message of batch) message.read_at = at
      for (const issue of new Set(batch.map((m) => m.issue_id))) pruneItem(issue)
      if (batch.length) settleInbox()
      window.__perf.writes++
      const ids = batch.map((m) => m.id)
      return { marked: ids.length, ids, hasMore: due.length > batch.length, before }
    }
    if (name === 'issues:update') {
      if (patchTask(args.id, args.patch)) emit('snapshot:forMe')
      window.__perf.writes++
      return null
    }
    if (name === 'roadmap:change') {
      // This fixture has independent tasks: no parent/dependency cascades.
      let changed = false
      for (const operation of args.operations) {
        if (operation.kind !== 'task')
          throw new Error(`Unimplemented benchmark roadmap operation: ${operation.kind}`)
        changed = patchTask(operation.id, operation.patch) || changed
      }
      const count = (roadmapCounts.get(args.session_id) || 0) + Number(changed)
      roadmapCounts.set(args.session_id, count)
      if (changed) emit('snapshot:forMe')
      window.__perf.writes++
      return { count }
    }
    throw new Error(`Unimplemented benchmark mutation: ${name}`)
  },
}
export const authClient = {
  getSession: async () => ({
    data: {
      session: { id: 'perf-session' },
      user: { id: 'perf-account' },
    },
  }),
}
export const armConvexAuth = async () => true
export const signOut = async () => {}
export const clearLocalSession = () => {}
export const handleOAuthReturn = async () => false
window.__perf = {
  appRenders: 0,
  writes: 0,
  count,
  fixtureTime: now,
  /* Holds every write from now until release(). */
  hold() {
    holding = true
  },
  /* How many writes are held. */
  held: () => held.length,
  /* Answers the oldest held write, refused when `refuse`. */
  releaseOne(refuse = false) {
    held.shift()?.(refuse)
  },
  /* Answers every held write and stops holding. */
  releaseAll() {
    holding = false
    while (held.length) held.shift()(false)
  },
  /* Delivers `n` new unread messages for the signed-in person, one per task,
     for the bulk-read scenario. */
  seedMessages(n) {
    const created = new Date().toISOString()
    for (let i = 0; i < n; i++)
      snapshot.messages.push({
        id: id('6', snapshot.messages.length),
        org_id: org,
        recipient_id: profiles[0].id,
        issue_id: id('4', i % count),
        issue_title: `Testbed task ${(i % count) + 1}`,
        kind: 'change',
        detail: 'Status changed',
        created_at: created,
      })
    emit('snapshot:forMe')
  },
  /* Another person renames task `n`, which every listener receives. */
  deliverRemote(n) {
    snapshot.issues[n].title = `Renamed elsewhere ${Date.now()}`
    emit('snapshot:forMe')
  },
  /* Another person moves task `n` to `status`, for checks by hand. */
  moveRemote(n, status) {
    snapshot.issues[n].status = status
    snapshot.issues[n].updated_at = new Date().toISOString()
    emit('snapshot:forMe')
  },
  deliverComments() {
    const active = [...(listeners.get('snapshot:commentThread') || [])]
    if (active.length !== 1) throw new Error('Benchmark requires one open comment thread')
    const body = `Benchmark delivered comment ${comments.length + 1}`
    comments.push({
      id: id('5', comments.length),
      issue_id: active[0].args.issue_id,
      author: profiles[1].id,
      body,
      created_at: new Date().toISOString(),
    })
    emit('snapshot:commentThread')
    return body
  },
}

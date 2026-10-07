// Deterministic authenticated transport for browser CPU/DOM measurements only.
import { getFunctionName } from 'convex/server'

const parameters = new URLSearchParams(location.search)
const count = Number(parameters.get('tasks') || 100)
const latency = Number(parameters.get('latency') || 100)
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
  track_delay: false,
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
      gravatar_avatars: false,
    },
  ],
  profiles,
  projects: [meta, ...projects],
  issues: Array.from({ length: count }, (_, n) => ({
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
  })),
  teams: [],
  teamMembers: [],
  access: [],
  teamAccess: [],
  links: [],
  milestones: [],
  activity: [],
  labels: [],
  issueLabels: [],
  issueSubs: [],
  attachments: [],
  orgLoad: [],
  messages: [],
  readMessageCount: 0,
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
      return { mode: 'blue', image_source: 'none', custom_image: null }
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
    case 'snapshot:commentsForIssue':
      return comments.filter((comment) => comment.issue_id === args.issue_id)
    case 'teamSync:lastComments':
      return []
    case 'admin:isOperator':
      return false
    default:
      throw new Error(`Unimplemented benchmark query: ${name}`)
  }
}
function emit(name) {
  for (const { args, receive } of listeners.get(name) || [])
    receive(structuredClone(read(name, args)))
}
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
    if (name === 'identity:claimMySeats' || name === 'prefs:save') return null
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
  deliverComments() {
    const active = [...(listeners.get('snapshot:commentsForIssue') || [])]
    if (active.length !== 1) throw new Error('Benchmark requires one open comment thread')
    const body = `Benchmark delivered comment ${comments.length + 1}`
    comments.push({
      id: id('5', comments.length),
      issue_id: active[0].args.issue_id,
      author: profiles[1].id,
      body,
      created_at: new Date().toISOString(),
    })
    emit('snapshot:commentsForIssue')
    return body
  },
}

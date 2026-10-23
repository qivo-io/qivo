/* Milestones live on the meta project, so the New milestone buttons follow
 * edit access there. A grant on a sub-project alone shows the meta read-only,
 * and the server refuses a milestone from that person. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../../convex/lib/workspaceJoin'

type Snapshot = Workspace
type Planner = typeof import('./planner')['P']

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const NOW = '2026-09-14T08:00:00.000Z'
const org = crypto.randomUUID()
const meta = crypto.randomUUID()
const sub = crypto.randomUUID()

function fixture(): Snapshot {
  const profiles: Snapshot['profiles'] = []
  const access: Snapshot['access'] = []
  const person = (
    id: string,
    role: Snapshot['profiles'][number]['org_role'],
    grant?: { project: string; level: 'user' | 'viewer' },
  ) => {
    profiles.push({
      id,
      org_id: org,
      name: id,
      initials: 'TE',
      color: '#335577',
      org_role: role,
      active: true,
      kind: 'person',
      created_at: NOW,
      ...(id === 'admin' ? { auth_user_id: 'test-account' } : {}),
    })
    if (grant) access.push({ project_id: grant.project, profile_id: id, level: grant.level })
  }
  person('admin', 'admin')
  person('metaUser', 'user', { project: meta, level: 'user' })
  person('metaViewer', 'user', { project: meta, level: 'viewer' })
  person('subUser', 'user', { project: sub, level: 'user' })
  const base = { org_id: org, description: '', sort_order: 0, track_delay: false, created_at: NOW }
  return {
    auth_user_id: 'test-account',
    myProfileIds: ['admin'],
    orgs: [
      {
        id: org,
        name: 'Testbed Labs',
        slug: 'testbed-labs',
        created_at: NOW,
        next_issue_num: 1,
        next_project_num: 3,
        date_format: 'iso',
        week_start: 1,
        week_one_rule: 'first4day',
        default_plannable_hours: 40,
      },
    ],
    profiles,
    projects: [
      { ...base, id: meta, type: 'meta', key: 'PLAN', num: 1, name: 'Planning' },
      { ...base, id: sub, type: 'project', key: 'WORK', num: 2, name: 'Work', parent_id: meta },
    ],
    issues: [],
    teams: [],
    teamMembers: [],
    access,
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
    delivered_at: '2026-09-15T08:00:00.000Z',
  }
}

describe('who may add a milestone', () => {
  let P: Planner

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    const snap = fixture()
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
    network.onUpdate.mockImplementation((_ref, _args, next) => {
      next(structuredClone(snap))
      return () => {}
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('needs edit access on the meta project, from either scope', () => {
    for (const uid of ['admin', 'metaUser']) {
      expect(P.canAddMilestone(meta, uid)).toBe(true)
      expect(P.canAddMilestone(sub, uid)).toBe(true)
    }
  })

  it('refuses a person who can edit only the sub-project, or only view the meta', () => {
    expect(P.canWrite(sub, 'subUser')).toBe(true)
    expect(P.canAddMilestone(sub, 'subUser')).toBe(false)
    expect(P.canAddMilestone(meta, 'subUser')).toBe(false)
    expect(P.canAddMilestone(sub, 'metaViewer')).toBe(false)
  })
})

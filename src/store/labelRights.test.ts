import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../../convex/lib/workspaceJoin'

/* The app's mirror of the label write rule (P.canWriteOrgLabels), which
 * agrees with the server's (convex/lib/access.ts canWriteOrgLabels) on
 * which projects give the right: top-level metas only. */

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

/** An organization with a top-level meta, a meta stored under it, which no
 * writer makes, and two staff users with a User grant on one of them each. */
function fixture() {
  const org = crypto.randomUUID()
  const top = crypto.randomUUID()
  const nested = crypto.randomUUID()
  const person = (name: string, org_role: 'admin' | 'user') => ({
    id: crypto.randomUUID(),
    org_id: org,
    name,
    initials: 'TE',
    color: '#335577',
    org_role,
    active: true,
    kind: 'person' as const,
    created_at: NOW,
  })
  const admin = { ...person('Admin', 'admin'), auth_user_id: 'test-account' }
  const onTop = person('User on the top-level meta', 'user')
  const onNested = person('User on the nested meta', 'user')
  const project = {
    org_id: org,
    description: '',
    sort_order: 0,
    track_delay: false,
    created_at: NOW,
  }
  const snap: Snapshot = {
    auth_user_id: 'test-account',
    myProfileIds: [admin.id],
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
    profiles: [admin, onTop, onNested],
    projects: [
      { ...project, id: top, type: 'meta', key: 'TOP', num: 1, name: 'Top' },
      { ...project, id: nested, type: 'meta', key: 'NEST', num: 2, name: 'Nested', parent_id: top },
    ],
    issues: [],
    teams: [],
    teamMembers: [],
    access: [
      { project_id: top, profile_id: onTop.id, level: 'user' },
      { project_id: nested, profile_id: onNested.id, level: 'user' },
    ],
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
  return { snap, org, onTop, onNested }
}

describe('label write rights in the app', () => {
  let P: Planner
  let f: ReturnType<typeof fixture>

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    f = fixture()
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
    network.onUpdate.mockImplementation((_ref, _args, next) => {
      next(structuredClone(f.snap))
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

  it('comes from a top-level meta, never from a meta stored under another', () => {
    expect(P.canWriteOrgLabels(f.org, f.onTop.id)).toBe(true)
    expect(P.canWriteOrgLabels(f.org, f.onNested.id)).toBe(false)
  })
})

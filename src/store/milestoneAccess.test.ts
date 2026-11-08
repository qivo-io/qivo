/* Milestones live on the meta project, so the New milestone buttons follow
 * edit access there. A grant on a sub-project alone shows the meta read-only,
 * and the server refuses a milestone from that person. The store judges the
 * signed-in person alone, so each case signs in as the person it asks
 * about. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Whole } from './guard/liveDouble.setup'

type Snapshot = Whole
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

function fixture(me: string): Snapshot {
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
      ...(id === me ? { auth_user_id: 'test-account' } : {}),
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
    myProfileIds: [me],
    orgs: [
      {
        id: org,
        name: 'Testbed Labs',
        slug: 'testbed-labs',
        created_at: NOW,
        next_issue_num: 1,
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
    labels: [],
    issueLabels: [],
    issueSubs: [],
    attachments: [],
    orgLoad: [],
    messages: [],
    delivered_at: '2026-09-15T08:00:00.000Z',
  }
}

describe('who may add a milestone', () => {
  /* A store signed in as person `me`. */
  async function as(me: string): Promise<Planner> {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    const snap = fixture(me)
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
    network.onUpdate.mockImplementation((_ref, _args, next) => {
      next(structuredClone(snap))
      return () => {}
    })
    const store = await import('./planner')
    await store.initStore()
    // the views name the projects they show; this suite names both, so a
    // refusal below is the level's and never a project the cache lacks
    await (await import('./oracleScope.setup')).nameProjects(store.P, snap)
    return store.P
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('needs edit access on the meta project, from either scope', async () => {
    const P = await as('metaUser')
    expect(P.canAddMilestone(meta)).toBe(true)
    expect(P.canAddMilestone(sub)).toBe(true)
  })

  it('refuses a person who can edit only the sub-project, or only view the meta', async () => {
    // and an organization admin without a grant, as admin status gives no Edit
    const admin = await as('admin')
    expect(admin.canAddMilestone(meta)).toBe(false)
    expect(admin.canAddMilestone(sub)).toBe(false)
    const subUser = await as('subUser')
    expect(subUser.canWrite(sub)).toBe(true)
    expect(subUser.canAddMilestone(sub)).toBe(false)
    expect(subUser.canAddMilestone(meta)).toBe(false)
    expect((await as('metaViewer')).canAddMilestone(sub)).toBe(false)
  })
})

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

/* The server's data with person `me` signed in. */
function fixture(me = 'Admin'): Snapshot {
  const org = crypto.randomUUID()
  const meta = crypto.randomUUID()
  const project = crypto.randomUUID()
  const profiles: Snapshot['profiles'] = []
  const access: Snapshot['access'] = []
  const teamMembers: Snapshot['teamMembers'] = []
  const teams: Snapshot['teams'] = []
  const teamAccess: Snapshot['teamAccess'] = []

  function person(
    name: string,
    role: Snapshot['profiles'][number]['org_role'] = 'user',
    level?: 'user' | 'viewer',
  ) {
    const profile: Snapshot['profiles'][number] = {
      id: crypto.randomUUID(),
      org_id: org,
      name,
      initials: 'TE',
      color: '#335577',
      org_role: role,
      active: true,
      kind: 'person',
      created_at: NOW,
    }
    profiles.push(profile)
    if (level) access.push({ project_id: meta, profile_id: profile.id, level })
    return profile
  }

  function team(name: string, level: 'user' | 'viewer') {
    const id = crypto.randomUUID()
    teams.push({
      id,
      org_id: org,
      name,
      track_delay_default: false,
      created_at: NOW,
    })
    teamAccess.push({ project_id: meta, team_id: id, level })
    return id
  }

  person('Admin', 'admin')
  const lead = person('Project lead')
  const directViewer = person('Direct View', 'user', 'viewer')
  person('Guest View', 'guest', 'viewer')
  person('Direct Edit', 'user', 'user')
  person('Guest Edit', 'guest', 'user')
  person('Inactive Edit', 'user', 'user').active = false
  person('No access')
  person('Foreign admin', 'admin').org_id = crypto.randomUUID()
  person('Agent Edit', 'user', 'user').kind = 'agent'
  const editTeam = team('Editors', 'user')
  const viewTeam = team('Viewers', 'viewer')
  for (const [profile, teamId, isLeader] of [
    [person('Team View'), viewTeam, false],
    [person('Direct View with team Edit', 'user', 'viewer'), editTeam, false],
    [person('Org viewer with team Edit', 'viewer', 'user'), editTeam, false],
    [person('Managing team lead'), editTeam, true],
  ] as const) {
    teamMembers.push({ profile_id: profile.id, team_id: teamId, is_leader: isLeader })
  }
  const signedIn = profiles.find((p) => p.name === me)!
  signedIn.auth_user_id = 'test-account'

  const baseProject = {
    org_id: org,
    description: '',
    sort_order: 0,
    track_delay: false,
    created_at: NOW,
  }
  return {
    auth_user_id: 'test-account',
    myProfileIds: [signedIn.id],
    orgs: [
      {
        id: org,
        name: 'Testbed Labs',
        slug: 'testbed-labs',
        created_at: NOW,
        next_issue_num: 1,
        next_project_num: 2,
        date_format: 'iso',
        week_start: 1,
        week_one_rule: 'first4day',
        default_plannable_hours: 40,
      },
    ],
    profiles,
    projects: [
      {
        ...baseProject,
        id: meta,
        type: 'meta',
        key: 'PLAN',
        num: 1,
        name: 'Planning',
        lead_id: lead.id,
        team_id: editTeam,
      },
      {
        ...baseProject,
        id: project,
        type: 'project',
        key: 'WORK',
        num: 2,
        name: 'Work',
        parent_id: meta,
      },
    ],
    issues: [
      {
        id: crypto.randomUUID(),
        org_id: org,
        project_id: project,
        num: 1,
        title: 'Existing assignment',
        description: '',
        status: 'todo',
        priority: 'low',
        assignee_id: directViewer.id,
        reporter_id: directViewer.id,
        paused: false,
        created_at: NOW,
        updated_at: NOW,
        has_hidden_subtasks: false,
        has_hidden_parent: false,
      },
    ],
    teams,
    teamMembers,
    access,
    teamAccess,
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

describe('task holders in the store', () => {
  let projectId: string

  /* A store signed in as the person named `me`. */
  async function as(me: string): Promise<Planner> {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    const snap = fixture(me)
    projectId = snap.projects.find((project) => project.type === 'project')!.id
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
    network.onUpdate.mockImplementation((_ref, _args, next) => {
      next(structuredClone(snap))
      return () => {}
    })
    const store = await import('./planner')
    await store.initStore()
    return store.P
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // The people a picker offers are the server's now (pickers.taskOwners,
  // whose rule convex/tests/pickerParity.test.ts holds to the write). The
  // store reads the signed-in person's own level for its own checks.
  it('reads direct, team and guest View access as Viewer, including the organization viewer ceiling', async () => {
    for (const name of ['Direct View', 'Team View', 'Guest View', 'Org viewer with team Edit']) {
      const P = await as(name)
      expect(P.levelOn(projectId), name).toBe('viewer')
    }
    // and team Edit as Edit for a person in the team
    expect((await as('Managing team lead')).levelOn(projectId)).toBe('user')
  })

  it('keeps existing holders by id, whom it does not hold', async () => {
    const P = await as('Admin')
    const task = P.issues.find((issue) => issue.title === 'Existing assignment')!
    const viewer = P.users.find((u) => u.name === 'Direct View')
    expect(viewer).toBeUndefined()
    expect(task.assignee).toBeTruthy()
    expect(task.reporter).toBe(task.assignee)
    expect(P.user(task.assignee)).toBeUndefined()
  })
})

import type { FunctionReturnType } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { api } from '../../convex/_generated/api'

type Snapshot = NonNullable<FunctionReturnType<typeof api.snapshot.forMe>>
type Planner = typeof import('./planner')['P']

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const NOW = '2026-09-14T08:00:00.000Z'

function fixture(): Snapshot {
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
      stale_days: 14,
      archive_days: 30,
      track_delay_default: false,
      created_at: NOW,
    })
    teamAccess.push({ project_id: meta, team_id: id, level })
    return id
  }

  const admin = person('Admin', 'admin')
  admin.auth_user_id = 'test-account'
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

  const baseProject = {
    org_id: org,
    description: '',
    sort_order: 0,
    track_delay: false,
    created_at: NOW,
  }
  return {
    auth_user_id: 'test-account',
    myProfileIds: [admin.id],
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
        gravatar_avatars: false,
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
      },
    ],
    teams,
    teamMembers,
    access,
    teamAccess,
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
}

describe('task assignee choices', () => {
  let P: Planner
  let projectId: string

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    const snap = fixture()
    projectId = snap.projects.find((project) => project.type === 'project')!.id
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

  it('excludes direct, team and guest View access, including the organization viewer ceiling', () => {
    const choices = P.issueAssigneesFor(projectId).map((user) => user.name)
    for (const name of ['Direct View', 'Team View', 'Guest View', 'Org viewer with team Edit']) {
      const user = P.users.find((candidate) => candidate.name === name)!
      expect(P.levelOn(projectId, user.id)).toBe('viewer')
      expect(choices).not.toContain(name)
    }
  })

  it('offers active same-organization people and agents with effective Edit or Lead access', () => {
    expect(
      P.issueAssigneesFor(projectId)
        .map((user) => user.name)
        .sort(),
    ).toEqual([
      'Admin',
      'Agent Edit',
      'Direct Edit',
      'Direct View with team Edit',
      'Guest Edit',
      'Managing team lead',
      'Project lead',
    ])
  })

  it('keeps View users available as reporters and preserves existing assignment names', () => {
    const reporters = P.issueUsersFor(projectId).map((user) => user.name)
    expect(reporters).toEqual(expect.arrayContaining(['Direct View', 'Team View', 'Guest View']))
    const task = P.issues.find((issue) => issue.title === 'Existing assignment')!
    expect(P.user(task.assignee)?.name).toBe('Direct View')
    expect(P.user(task.reporter)?.name).toBe('Direct View')
  })
})

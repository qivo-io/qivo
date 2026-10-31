import type { Workspace } from '../../convex/lib/workspaceJoin'
export type Snapshot = Workspace
const NOW = '2026-09-14T08:00:00.000Z'

export function plannerFixture(): Snapshot {
  const org = crypto.randomUUID()
  const profile = crypto.randomUUID()
  return {
    auth_user_id: 'test-account',
    myProfileIds: [profile],
    orgs: [
      {
        id: org,
        name: 'Testbed Labs',
        slug: 'testbed',
        created_at: NOW,
        next_issue_num: 0,
        next_project_num: 1,
        date_format: 'iso',
        week_start: 1,
        week_one_rule: 'first4day',
        default_plannable_hours: 40,
      },
    ],
    profiles: [
      {
        id: profile,
        org_id: org,
        auth_user_id: 'test-account',
        name: 'Planner',
        initials: 'PL',
        color: '#335577',
        org_role: 'admin',
        active: true,
        kind: 'person',
        created_at: NOW,
      },
    ],
    projects: [
      {
        id: crypto.randomUUID(),
        org_id: org,
        type: 'project',
        key: 'TEST',
        num: 1,
        name: 'Task creation fixture',
        description: '',
        sort_order: 0,
        track_delay: false,
        created_at: NOW,
      },
    ],
    issues: [],
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
    delivered_at: '2026-09-15T08:00:00.000Z',
  }
}

/** Puts the fixture's project under a top-level project of its own, as
    every writer stores a project that holds tasks. The Board's server read
    (convex/tasks.ts board) answers only a top-level project with its
    sub-projects or one sub-project, so a test that draws a Board from the
    server's answer places the project so. Answers `snapshot`. */
export function underProgram(snapshot: Snapshot): Snapshot {
  const project = snapshot.projects[0]
  const program = {
    ...project,
    id: crypto.randomUUID(),
    type: 'meta' as const,
    key: 'PROG',
    num: 99,
    name: 'Fixture program',
  }
  project.parent_id = program.id
  snapshot.projects.push(program)
  return snapshot
}

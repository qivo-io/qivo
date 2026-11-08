import type { Workspace } from '../../convex/lib/workspaceJoin'
import type { Whole } from './guard/liveDouble.setup'

/** The whole a store test publishes, the server's data: the workspace's
    sections with every person, team, membership and label of each
    organization, and the server's milestones beside them, which no part
    sends and the stand-ins answer from (store/guard/liveDouble.setup.ts
    Whole). The store holds only the caller's own profiles, memberships and
    teams of it. */
export type Snapshot = Whole & Required<Pick<Whole, 'milestones'>>
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
        // the profile leads it, so they work on it whatever their role
        lead_id: profile,
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

/** The sections of `whole` in the form the workspace's rows keep them
    (store/workspaceBase.ts Snapshot), for the tests of the rows and the
    task index that stage a workspace straight: no label, no Team sync
    stamp and a create state, as the root part answers it. It keeps every
    profile, which those tests read as rows; the store itself holds the
    caller's own alone (convex/lib/workspaceJoin.ts rootOf). */
export function asStored(whole: Whole): Workspace {
  const {
    labels: _labels,
    beyondCut: _beyond,
    unheld: _unheld,
    milestones: _milestones,
    create,
    profiles,
    messagesCut,
    ...rest
  } = whole
  return {
    ...rest,
    profiles: profiles.map(({ sync_at: _at, sync_since: _since, ...p }) => p),
    ...(messagesCut ? { messagesCut: true as const } : {}),
    create: create ?? 'now',
  }
}

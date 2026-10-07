import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../convex/_generated/api'
export type Snapshot = NonNullable<FunctionReturnType<typeof api.snapshot.forMe>>
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
        gravatar_avatars: false,
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

import { describe, expect, it } from 'vitest'
import { taskFollowersStandIn } from './followerStandIn.setup'
import { plannerFixture } from './plannerFixture.setup'

/* The follower stand-in's Add list keeps the people the server's rule
   lets follow a task (convex/model/pickers.ts taskFollowersOf, which keeps
   a profile only if convex/lib/access.ts keepsInbox gives it an inbox):
   active people and Standard user agents, never a Viewer agent. */

describe('the follower stand-in’s Add list', () => {
  it('offers active people and Standard user agents, and no Viewer agent', () => {
    const snap = plannerFixture()
    const me = snap.profiles[0]
    const org = snap.orgs[0].id
    for (const [id, name, kind, org_role] of [
      ['ada', 'Ada Lind', 'person', 'viewer'],
      ['relay', 'Relay Agent', 'agent', 'user'],
      ['watcher', 'Watcher Agent', 'agent', 'viewer'],
    ] as const)
      snap.profiles.push({ ...me, id, name, kind, org_role, auth_user_id: `account-${id}` })
    const batch = taskFollowersStandIn(
      snap,
      { org_id: org, issue_id: 'task-1' },
      { canManage: true },
    )
    if (batch.state !== 'ready') throw new Error(`the stand-in answered ${batch.state}`)
    expect(batch.rows.map((row) => row.id)).toEqual(['ada', 'relay'])
  })
})

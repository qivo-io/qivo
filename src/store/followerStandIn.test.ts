import { describe, expect, it } from 'vitest'
import { rootOf } from '../../convex/lib/workspaceJoin'
import { subscribersStandIn, taskFollowersStandIn } from './followerStandIn.setup'
import { plannerFixture } from './plannerFixture.setup'

/* The follower stand-in's Add list keeps the people the server's rule
   lets follow a task (convex/model/pickers.ts taskFollowersOf, which keeps
   a profile only if convex/lib/access.ts keepsInbox gives it an inbox):
   active people and Standard user agents, never a Viewer agent. The
   stand-ins of the server send a color stored before the #rrggbb rule as
   the gray the server sends (convex/lib/avatarColors.ts shownAvatarColor). */

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

describe('the stand-ins’ colors', () => {
  it('send a legacy color as gray, as the server does, and a #rrggbb one as stored', () => {
    const snap = plannerFixture()
    const me = snap.profiles[0]
    const org = snap.orgs[0].id
    me.color = 'teal'
    snap.profiles.push(
      { ...me, id: 'ada', name: 'Ada Lind', auth_user_id: 'account-ada', color: 'cornflower' },
      { ...me, id: 'bo', name: 'Bo Berg', auth_user_id: 'account-bo', color: '#0F766E' },
    )
    const task = { org_id: org, issue_id: 'task-1' }
    const offered = taskFollowersStandIn(snap, task, { canManage: true })
    if (offered.state !== 'ready') throw new Error(`the stand-in answered ${offered.state}`)
    expect(offered.rows.map((row) => [row.id, row.color])).toEqual([
      ['ada', '#8A8F98'],
      ['bo', '#0F766E'],
    ])
    const followed = subscribersStandIn(
      {
        ...snap,
        issueSubs: ['ada', 'bo'].map((id) => ({
          issue_id: 'task-1',
          profile_id: id,
          created_at: '2026-09-14T08:00:00.000Z',
        })),
      },
      task,
      { canManage: true },
    )
    expect(followed.subscribers.map((row) => [row.id, row.color])).toEqual([
      ['ada', '#8A8F98'],
      ['bo', '#0F766E'],
    ])
    // the root part's own profile
    expect(rootOf(snap).profiles.map((p) => [p.id, p.color])).toEqual([[me.id, '#8A8F98']])
  })
})

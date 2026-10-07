import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import {
  as,
  expectRefusal,
  newT,
  plantIssue,
  plantSeat,
  plantSubscription,
  uuid,
  withOrg,
} from './helpers.setup'

async function fixture() {
  const t = newT()
  const f = await withOrg(t)
  const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
  const ordinary = await plantSeat(t, {
    org_id: f.org.id,
    auth_user_id: uuid(),
    name: 'Ordinary teammate',
  })
  await t.run(async (ctx) => {
    await ctx.db.insert('team_members', {
      team_id: f.team.id,
      profile_id: ordinary.id,
      is_leader: false,
    })
    await ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: ordinary.id,
      level: 'user',
    })
  })
  const roster = (who: Doc<'profiles'>, issue_id = issue.id) =>
    as(t, who).query(api.issues.subscribers, { org_id: who.org_id, issue_id })
  const set = (
    who: Doc<'profiles'>,
    profile_id: string,
    subscribed: boolean,
    issue_id = issue.id,
  ) =>
    as(t, who).mutation(api.issues.setSubscriber, {
      org_id: who.org_id,
      issue_id,
      profile_id,
      subscribed,
    })
  return { t, f, issue, ordinary, roster, set }
}

describe('task subscriber popover', () => {
  it('lets every task viewer read subscribers and change only their own subscription', async () => {
    const { t, f, issue, ordinary, roster, set } = await fixture()
    await set(f.admin, f.admin.id, true)
    for (const who of [ordinary, f.viewer, f.guest]) {
      expect(await roster(who)).toEqual({
        canManage: false,
        subscribers: [f.admin.id],
        candidates: [],
      })
      // Existing self APIs remain available to read-only and guest seats.
      await as(t, who).mutation(api.issues.subscribe, {
        org_id: f.org.id,
        issue_id: issue.id,
      })
      expect((await roster(who)).subscribers).toContain(who.id)
      await set(who, who.id, false)
      await set(who, who.id, true)
      await as(t, who).mutation(api.issues.unsubscribe, {
        org_id: f.org.id,
        issue_id: issue.id,
      })
      for (const subscribed of [true, false]) {
        await expectRefusal(
          set(who, f.admin.id, subscribed),
          'forbidden',
          /manage other subscribers/,
        )
      }
    }
    expect((await roster(f.admin)).subscribers).toEqual([f.admin.id])
  })

  it('lets project leads and org admins add and remove viewers idempotently without notifications', async () => {
    const { t, f, issue, ordinary, roster, set } = await fixture()
    for (const manager of [f.admin, f.user]) {
      expect((await roster(manager)).canManage).toBe(true)
      for (const target of [f.viewer, f.guest, ordinary]) {
        expect((await roster(manager)).candidates).toContain(target.id)
        await set(manager, target.id, true)
        await set(manager, target.id, true)
        const subscribed = await roster(manager)
        expect(subscribed.subscribers.filter((id) => id === target.id)).toHaveLength(1)
        expect(subscribed.candidates).not.toContain(target.id)
        await set(manager, target.id, false)
        await set(manager, target.id, false)
        expect((await roster(manager)).subscribers).not.toContain(target.id)
      }
    }
    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query('issue_subscriptions')
          .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
          .collect(),
      ).toEqual([])
      expect(await ctx.db.query('messages').collect()).toEqual([])
      expect(await ctx.db.query('activity_events').collect()).toEqual([])
    })
  })

  it('does not grant management through ordinary sharing or relaxed policy', async () => {
    const { t, f, ordinary, roster, set } = await fixture()
    const ledIssue = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
    expect((await roster(f.user, ledIssue.id)).canManage).toBe(true)
    await set(f.user, f.admin.id, true, ledIssue.id)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.org._id, { only_team_leads_manage_project_users: false })
    })
    expect((await roster(ordinary)).canManage).toBe(false)
    await expectRefusal(set(ordinary, f.viewer.id, true), 'forbidden')
  })

  it('uses current inherited team access for candidates and rechecks it when adding', async () => {
    const { t, f, issue, roster, set } = await fixture()
    const teammate = await plantSeat(t, { org_id: f.org.id, auth_user_id: uuid() })
    const sharedTeamId = uuid()
    await as(t, f.admin).mutation(api.teams.create, {
      org_id: f.org.id,
      id: sharedTeamId,
      name: 'Shared team',
    })
    await as(t, f.admin).mutation(api.teams.addMember, {
      org_id: f.org.id,
      team_id: sharedTeamId,
      profile_id: teammate.id,
    })
    await as(t, f.admin).mutation(api.teams.setLeader, {
      org_id: f.org.id,
      team_id: sharedTeamId,
      profile_id: teammate.id,
      is_leader: true,
    })
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { team_access: { [sharedTeamId]: 'viewer' } },
    })
    expect((await roster(f.user)).candidates).toContain(teammate.id)
    // Leadership of a shared team grants visibility, not managing authority.
    expect((await roster(teammate)).canManage).toBe(false)
    await expectRefusal(set(teammate, f.viewer.id, true), 'forbidden')
    await set(f.user, teammate.id, true)
    await as(t, f.admin).mutation(api.teams.removeMember, {
      org_id: f.org.id,
      team_id: sharedTeamId,
      profile_id: teammate.id,
    })
    expect((await roster(f.user)).subscribers).toContain(teammate.id)
    await expectRefusal(set(f.user, teammate.id, true), 'rule', /can see this task/)
    await expectRefusal(roster(teammate), 'not_found', /task not found/)
    await expectRefusal(set(teammate, teammate.id, false), 'not_found', /task not found/)
    // A manager can remove the stale subscription after access is revoked.
    await set(f.user, teammate.id, false)
    expect((await roster(f.user)).candidates).not.toContain(teammate.id)
    expect((await roster(f.user)).subscribers).not.toContain(teammate.id)
    // The preexisting self-only unsubscribe remains usable after access loss.
    await as(t, teammate).mutation(api.issues.unsubscribe, {
      org_id: f.org.id,
      issue_id: issue.id,
    })
  })

  it('excludes inactive, inaccessible and foreign add targets while allowing stale subscriber removal', async () => {
    const { t, f, issue, roster, set } = await fixture()
    const inactive = await plantSeat(t, {
      org_id: f.org.id,
      active: false,
      org_role: 'admin',
    })
    const missing = uuid()
    const candidates = (await roster(f.user)).candidates
    for (const profileId of [inactive.id, f.agent.id, f.otherAdmin.id, missing]) {
      expect(candidates).not.toContain(profileId)
    }
    for (const profileId of [inactive.id, f.agent.id]) {
      await expectRefusal(set(f.user, profileId, true), 'rule', /active user who can see/)
    }
    for (const profileId of [f.otherAdmin.id, missing]) {
      for (const subscribed of [true, false]) {
        await expectRefusal(set(f.user, profileId, subscribed), 'not_found', /subscriber not found/)
      }
    }
    for (const profileId of [inactive.id, f.otherAdmin.id, missing]) {
      await plantSubscription(t, { issue_id: issue.id, profile_id: profileId })
    }
    expect((await roster(f.user)).subscribers).toEqual([inactive.id])
    await set(f.user, inactive.id, false)
    expect((await roster(f.user)).subscribers).toEqual([])
  })

  it('gives hidden, foreign and missing tasks the same refusal on roster and management', async () => {
    const { t, f, roster, set } = await fixture()
    const hidden = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
    const foreign = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
    })
    for (const issueId of [hidden.id, foreign.id, uuid()]) {
      await expectRefusal(roster(f.guest, issueId), 'not_found', /task not found/)
      for (const subscribed of [true, false]) {
        await expectRefusal(
          set(f.guest, f.admin.id, subscribed, issueId),
          'not_found',
          /task not found/,
        )
      }
    }
  })

  it('keeps project-lead authority after team leadership changes', async () => {
    const { t, f, roster, set } = await fixture()
    expect((await roster(f.user)).canManage).toBe(true)
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: f.user.id,
        level: 'user',
      })
      const membership = await ctx.db
        .query('team_members')
        .withIndex('by_team_profile', (q) => q.eq('team_id', f.team.id).eq('profile_id', f.user.id))
        .unique()
      if (membership === null) throw new Error('missing fixture team membership')
      await ctx.db.patch(membership._id, { is_leader: false })
    })
    expect((await roster(f.user)).canManage).toBe(true)
    for (const subscribed of [true, false]) await set(f.user, f.viewer.id, subscribed)
    await set(f.user, f.user.id, true)
    expect((await roster(f.user)).subscribers).toContain(f.user.id)
  })
})

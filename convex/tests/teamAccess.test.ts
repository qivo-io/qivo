import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import { canSeeProject, canWriteOrgLabels, hasProjectLevel } from '../lib/access'
import { byId } from '../lib/db'
import { orgProjectView } from '../lib/visibility'
import { as, expectRefusal, messagesFor, newT, plantSeat, uuid, withOrg } from './helpers.setup'
import { assertNoDanglingRefs } from './refs.setup'

async function fixture() {
  const t = newT()
  const f = await withOrg(t)
  const person = await plantSeat(t, { org_id: f.org.id, auth_user_id: uuid(), name: 'Teammate' })
  const sharedTeamId = uuid()
  await as(t, f.admin).mutation(api.teams.create, {
    org_id: f.org.id,
    id: sharedTeamId,
    name: 'Software',
  })
  const add = (teamId: string, profileId = person.id) =>
    as(t, f.admin).mutation(api.teams.addMember, {
      org_id: f.org.id,
      team_id: teamId,
      profile_id: profileId,
    })
  const remove = (teamId: string, profileId = person.id) =>
    as(t, f.admin).mutation(api.teams.removeMember, {
      org_id: f.org.id,
      team_id: teamId,
      profile_id: profileId,
    })
  const share = (team_access: Record<string, 'user' | 'viewer'>) =>
    as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { team_access },
    })
  const snapshot = async () => {
    const snap = await as(t, person).query(api.snapshot.forMe, {})
    if (snap === null) throw new Error('expected signed-in snapshot')
    return snap
  }
  return { t, f, person, sharedTeamId, add, remove, share, snapshot }
}

describe('project team sharing', () => {
  it('keeps new products teamless and respects explicit team shares', async () => {
    const { t, f, add, snapshot } = await fixture()
    await add(f.team.id)
    const create = (key: string, team_access?: Record<string, 'user' | 'viewer'>) =>
      as(t, f.admin).mutation(api.projects.create, {
        org_id: f.org.id,
        id: uuid(),
        type: 'meta',
        team_id: undefined,
        key,
        name: key,
        sort_order: 10,
        ...(team_access === undefined ? {} : { team_access }),
      })
    const shared = await create('SHARE', { [f.team.id]: 'user' })
    const privateProject = await create('PRIV', {})
    const snap = await snapshot()
    expect(snap.projects.map((p) => p.id)).toContain(shared.id)
    expect(snap.projects.map((p) => p.id)).not.toContain(privateProject.id)
    expect(snap.projects.map((p) => p.id)).not.toContain(f.meta.id)
    expect(snap.teamAccess).toEqual([{ project_id: shared.id, team_id: f.team.id, level: 'user' }])
  })

  it('combines several teams and direct grants; membership changes apply to the whole project tree', async () => {
    const { t, f, person, sharedTeamId, add, remove, share, snapshot } = await fixture()
    await share({ [f.team.id]: 'viewer', [sharedTeamId]: 'user' })
    await add(f.team.id)
    const level = () => t.run((ctx) => hasProjectLevel(ctx, person, f.sub.id, 'user'))
    expect(await level()).toBe(false)
    expect((await snapshot()).projects.map((p) => p.id)).toEqual(
      expect.arrayContaining([f.meta.id, f.sub.id, f.sub2.id]),
    )
    await add(sharedTeamId)
    expect(await level()).toBe(true)
    await remove(sharedTeamId)
    expect(await level()).toBe(false)
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { access: { [person.id]: 'user' } },
    })
    expect(await level()).toBe(true)
    await share({})
    expect(await level()).toBe(true)
    const snap = await snapshot()
    expect(snap.teamAccess).toEqual([])
    expect(snap.access).toContainEqual({
      project_id: f.meta.id,
      profile_id: person.id,
      level: 'user',
    })
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { access: {} },
    })
    expect((await snapshot()).projects).toEqual([])
    await expectRefusal(
      as(t, person).mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.sub.id,
        title: 'No longer visible',
      }),
      'forbidden',
    )
  })

  it('team access enables writing, assignment, labels and notifications, then stops on removal', async () => {
    const { t, f, person, sharedTeamId, add, remove, share } = await fixture()
    await share({ [sharedTeamId]: 'user' })
    await add(sharedTeamId)
    expect(await t.run((ctx) => canWriteOrgLabels(ctx, person))).toBe(true)
    const issue = await as(t, person).mutation(api.issues.create, {
      org_id: f.org.id,
      id: uuid(),
      project_id: f.sub.id,
      title: 'Team task',
      assignee_id: person.id,
    })
    await as(t, person).mutation(api.issues.subscribe, { org_id: f.org.id, issue_id: issue.id })
    await as(t, f.admin).mutation(api.comments.create, {
      org_id: f.org.id,
      id: uuid(),
      issue_id: issue.id,
      body: 'Shared team comment',
    })
    expect(await messagesFor(t, person.id, issue.id)).toHaveLength(1)
    await remove(sharedTeamId)
    expect(await t.run((ctx) => canWriteOrgLabels(ctx, person))).toBe(false)
    await as(t, f.admin).mutation(api.comments.create, {
      org_id: f.org.id,
      id: uuid(),
      issue_id: issue.id,
      body: 'After membership ended',
    })
    expect(await messagesFor(t, person.id, issue.id)).toHaveLength(1)
    await expectRefusal(
      as(t, f.admin).mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.sub.id,
        title: 'Cannot assign to former team member',
        assignee_id: person.id,
      }),
      'rule',
      /active user with Edit permission or higher on its project/,
    )
    await expectRefusal(
      as(t, person).query(api.snapshot.commentsForIssue, { org_id: f.org.id, issue_id: issue.id }),
      'not_found',
    )
  })

  it('caps viewer team members and does not promote leaders of shared teams to project leads', async () => {
    const { t, f, person, sharedTeamId, add, share } = await fixture()
    await share({ [sharedTeamId]: 'user' })
    await add(sharedTeamId, f.viewer.id)
    await add(sharedTeamId)
    await as(t, f.admin).mutation(api.teams.setLeader, {
      org_id: f.org.id,
      team_id: sharedTeamId,
      profile_id: person.id,
      is_leader: true,
    })
    await t.run(async (ctx) => {
      expect(await canSeeProject(ctx, f.viewer, f.sub)).toBe(true)
      expect(await hasProjectLevel(ctx, f.viewer, f.sub.id, 'user')).toBe(false)
      expect(await canWriteOrgLabels(ctx, f.viewer)).toBe(false)
      expect(await hasProjectLevel(ctx, person, f.sub.id, 'user')).toBe(true)
      expect(await hasProjectLevel(ctx, person, f.sub.id, 'lead')).toBe(false)
    })
    await expectRefusal(
      as(t, person).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { team_access: {} },
      }),
      'forbidden',
    )
    await expectRefusal(
      as(t, f.viewer).mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.sub.id,
        title: 'Viewer cannot write',
      }),
      'forbidden',
    )
  })

  it('rejects foreign or missing teams and permits independent sub-project sharing', async () => {
    const { t, f, sharedTeamId, share } = await fixture()
    const foreignTeamId = uuid()
    await as(t, f.otherAdmin).mutation(api.teams.create, {
      org_id: f.otherOrg.id,
      id: foreignTeamId,
      name: 'Foreign',
    })
    for (const teamId of [foreignTeamId, uuid()]) {
      await expectRefusal(
        share({ [sharedTeamId]: 'user', [teamId]: 'user' }),
        'forbidden',
        /team must belong/,
      )
      await expectRefusal(
        as(t, f.admin).mutation(api.projects.create, {
          org_id: f.org.id,
          id: uuid(),
          type: 'meta',
          team_id: undefined,
          key: 'BAD',
          name: 'Invalid sharing',
          sort_order: 10,
          team_access: { [teamId]: 'user' },
        }),
        'forbidden',
        /team must belong/,
      )
    }
    expect(await t.run((ctx) => ctx.db.query('project_team_access').collect())).toEqual([])
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.sub.id,
      patch: { team_access: { [sharedTeamId]: 'user' } },
    })
  })

  it('fails closed for guest membership and corrupt cross-org shares on both access paths', async () => {
    const { t, f, person, sharedTeamId, add, share } = await fixture()
    await share({ [sharedTeamId]: 'user' })
    await add(sharedTeamId)
    const foreignTeamId = uuid()
    await as(t, f.otherAdmin).mutation(api.teams.create, {
      org_id: f.otherOrg.id,
      id: foreignTeamId,
      name: 'Foreign team',
    })
    await t.run(async (ctx) => {
      for (const profile of [f.guest, f.otherAdmin]) {
        await ctx.db.insert('team_members', {
          team_id: sharedTeamId,
          profile_id: profile.id,
          is_leader: true,
        })
      }
      for (const grant of await ctx.db.query('project_access').collect())
        await ctx.db.delete(grant._id)
      await ctx.db.insert('project_team_access', {
        project_id: f.otherProject.id,
        team_id: sharedTeamId,
        level: 'user',
      })
      await ctx.db.insert('team_members', {
        team_id: foreignTeamId,
        profile_id: person.id,
        is_leader: true,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.hidden.id,
        team_id: foreignTeamId,
        level: 'user',
      })
      for (const profile of [f.guest, f.otherAdmin]) {
        expect(await canSeeProject(ctx, profile, f.meta)).toBe(false)
        expect(await hasProjectLevel(ctx, profile, f.meta.id, 'user')).toBe(false)
        expect((await orgProjectView(ctx, profile)).visible(f.meta.id)).toBe(false)
      }
      expect(await canSeeProject(ctx, person, f.otherProject)).toBe(false)
      expect((await orgProjectView(ctx, person)).visible(f.otherProject.id)).toBe(false)
      expect(await canSeeProject(ctx, person, f.hidden)).toBe(false)
      expect(await hasProjectLevel(ctx, person, f.hidden.id, 'user')).toBe(false)
      expect((await orgProjectView(ctx, person)).visible(f.hidden.id)).toBe(false)
    })
    await expectRefusal(add(sharedTeamId, f.guest.id), 'forbidden', /guest/)
  })

  it('deleting a shared team drops its grants but preserves the independently owned project and individual grants', async () => {
    const { t, f, sharedTeamId, share } = await fixture()
    await share({ [sharedTeamId]: 'user' })
    await as(t, f.admin).mutation(api.teams.deleteDeep, { org_id: f.org.id, id: sharedTeamId })
    await t.run(async (ctx) => {
      expect(await byId(ctx, 'projects', f.meta.id)).not.toBeNull()
      expect(await canSeeProject(ctx, f.guest, f.sub)).toBe(true)
      expect(await ctx.db.query('project_team_access').collect()).toEqual([])
    })
    await assertNoDanglingRefs(t, 'shared team removed')
    await share({ [f.team.id]: 'user' })
    await as(t, f.admin).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.meta.id })
    expect(await t.run((ctx) => ctx.db.query('project_team_access').collect())).toEqual([])
    await assertNoDanglingRefs(t, 'shared project removed')
  })
})

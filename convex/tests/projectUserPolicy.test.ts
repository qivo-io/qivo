import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import { canManageProjectUsers, canSeeProject, hasProjectLevel } from '../lib/access'
import { orgProjectView } from '../lib/visibility'
import { as, expectRefusal, newT, plantSeat, uuid, withOrg } from './helpers.setup'

async function fixture() {
  const t = newT()
  const f = await withOrg(t)
  const person = await plantSeat(t, {
    org_id: f.org.id,
    auth_user_id: `person_${uuid()}`,
    email: 'person@example.test',
  })
  await t.run((ctx) =>
    ctx.db.insert('team_members', { team_id: f.team.id, profile_id: person.id, is_leader: true }),
  )
  return { t, f, person }
}

describe('named lead permission management', () => {
  it('a direct User grant and team leadership cannot administer access or settings', async () => {
    const { t, f, person } = await fixture()
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: person.id,
        level: 'user',
      }),
    )
    // an empty patch and a setting need Lead, and the lead needs an
    // organization admin or the project's lead
    for (const patch of [{}, { name: 'x' }, { lead_id: person.id }]) {
      await expectRefusal(
        as(t, person).mutation(api.projects.update, { org_id: f.org.id, id: f.meta.id, patch }),
        'forbidden',
      )
    }
    await expectRefusal(
      as(t, person).mutation(api.projects.inviteGuest, {
        org_id: f.org.id,
        project_id: f.meta.id,
        email: 'guest@example.test',
        level: 'viewer',
      }),
      'rule',
    )
  })

  it('the named lead manages explicit team and individual permissions on either hierarchy level', async () => {
    const { t, f, person } = await fixture()
    for (const id of [f.meta.id, f.sub.id]) {
      for (const subject of [
        { user_id: person.id, level: 'viewer' as const },
        { team_id: f.team.id, level: 'user' as const },
      ])
        await as(t, f.user).mutation(api.projects.setAccess, { org_id: f.org.id, id, ...subject })
      await t.run(async (ctx) => {
        const project = await ctx.db
          .query('projects')
          .withIndex('by_uuid', (q) => q.eq('id', id))
          .unique()
        expect(await canManageProjectUsers(ctx, f.user, project!)).toBe(true)
        expect(await hasProjectLevel(ctx, person, id, 'user')).toBe(true)
        expect(await hasProjectLevel(ctx, person, id, 'lead')).toBe(false)
      })
    }
  })

  it('child-only permissions expose parent context without spilling into siblings, tasks or parent writes', async () => {
    const { t, f, person } = await fixture()
    await as(t, f.user).mutation(api.projects.setAccess, {
      org_id: f.org.id,
      id: f.sub.id,
      user_id: person.id,
      level: 'user',
    })
    await t.run(async (ctx) => {
      expect(await canSeeProject(ctx, person, f.meta)).toBe(true)
      expect(await hasProjectLevel(ctx, person, f.meta.id, 'user')).toBe(false)
      expect(await hasProjectLevel(ctx, person, f.sub.id, 'user')).toBe(true)
      expect(await canSeeProject(ctx, person, f.sub2)).toBe(false)
      const view = await orgProjectView(ctx, person)
      expect(view.visible(f.meta.id)).toBe(true)
      expect(view.visible(f.sub.id)).toBe(true)
      expect(view.visible(f.sub2.id)).toBe(false)
      // the parent is visible for navigation only
      expect(view.accessible(f.meta.id)).toBe(false)
      expect(view.accessible(f.sub.id)).toBe(true)
      expect(view.accessible(f.sub2.id)).toBe(false)
    })
    await expectRefusal(
      as(t, person).mutation(api.projects.setAccess, {
        org_id: f.org.id,
        id: f.sub.id,
        team_id: f.team.id,
        level: 'user',
      }),
      'forbidden',
    )
  })

  it('child team shares track membership without upgrading team leaders to project leads', async () => {
    const { t, f, person } = await fixture()
    await as(t, f.user).mutation(api.projects.setAccess, {
      org_id: f.org.id,
      id: f.sub.id,
      team_id: f.team.id,
      level: 'user',
    })
    await t.run(async (ctx) => {
      expect(await hasProjectLevel(ctx, person, f.sub.id, 'user')).toBe(true)
      expect(await hasProjectLevel(ctx, person, f.sub.id, 'lead')).toBe(false)
      expect(await canSeeProject(ctx, person, f.sub2)).toBe(false)
    })
    await as(t, f.admin).mutation(api.teams.removeMember, {
      org_id: f.org.id,
      team_id: f.team.id,
      profile_id: person.id,
    })
    await t.run(async (ctx) => {
      expect(await canSeeProject(ctx, person, f.sub)).toBe(false)
      expect(await canSeeProject(ctx, person, f.meta)).toBe(false)
    })
  })

  it('invites to a sub-project stay on that sub-project', async () => {
    const { t, f } = await fixture()
    const { id } = await as(t, f.user).mutation(api.projects.inviteGuest, {
      org_id: f.org.id,
      project_id: f.sub.id,
      email: 'invited@example.test',
      level: 'viewer',
    })
    await t.run(async (ctx) => {
      const person = await ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique()
      expect(await canSeeProject(ctx, person!, f.sub)).toBe(true)
      expect(await canSeeProject(ctx, person!, f.sub2)).toBe(false)
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) => q.eq('project_id', f.sub.id).eq('profile_id', id))
        .unique()
      expect(grant?.level).toBe('viewer')
    })
  })

  it('fences foreign users and teams on create and rolls back the project and its earlier grants', async () => {
    const { t, f, person } = await fixture()
    const state = () =>
      t.run(async (ctx) => ({
        projects: await ctx.db.query('projects').collect(),
        grants: await ctx.db.query('project_access').collect(),
        shares: await ctx.db.query('project_team_access').collect(),
        counters: await ctx.db.query('org_counters').collect(),
      }))
    const before = await state()
    // a top-level project by an admin, a sub-project by its parent's lead
    for (const [who, place] of [
      [f.admin, { type: 'meta' }],
      [f.user, { type: 'project', parent_id: f.meta.id }],
    ] as const) {
      const create = (maps: {
        access?: Record<string, 'user'>
        team_access?: Record<string, 'user'>
      }) =>
        as(t, who).mutation(api.projects.create, {
          org_id: f.org.id,
          id: uuid(),
          key: 'NEW',
          name: 'New project',
          sort_order: 9,
          ...place,
          ...maps,
        })
      await expectRefusal(
        create({ access: { [person.id]: 'user', [f.otherAdmin.id]: 'user' } }),
        'forbidden',
        /grantee must hold/,
      )
      await expectRefusal(
        create({ access: { [person.id]: 'user' }, team_access: { [uuid()]: 'user' } }),
        'forbidden',
        /team must belong/,
      )
    }
    expect(await state()).toEqual(before)
  })
})

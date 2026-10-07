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
  it('a direct User grant and team leadership cannot administer access under either legacy policy value', async () => {
    const { t, f, person } = await fixture()
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: person.id,
        level: 'user',
      }),
    )
    for (const enabled of [true, false]) {
      await as(t, f.admin).mutation(api.orgs.update, {
        org_id: f.org.id,
        patch: { only_team_leads_manage_project_users: enabled },
      })
      for (const patch of [
        { access: {} },
        { team_access: { [f.team.id]: 'user' as const } },
        { lead_id: person.id },
      ]) {
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
    }
  })

  it('the named lead manages explicit team and individual permissions on either hierarchy level', async () => {
    const { t, f, person } = await fixture()
    for (const id of [f.meta.id, f.sub.id]) {
      await as(t, f.user).mutation(api.projects.update, {
        org_id: f.org.id,
        id,
        patch: { access: { [person.id]: 'viewer' }, team_access: { [f.team.id]: 'user' } },
      })
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
    await as(t, f.user).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.sub.id,
      patch: { access: { [person.id]: 'user' } },
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
    })
    await expectRefusal(
      as(t, person).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.sub.id,
        patch: { team_access: { [f.team.id]: 'user' } },
      }),
      'forbidden',
    )
  })

  it('child team shares track membership without upgrading team leaders to project leads', async () => {
    const { t, f, person } = await fixture()
    await as(t, f.user).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.sub.id,
      patch: { team_access: { [f.team.id]: 'user' } },
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
    const id = await as(t, f.user).mutation(api.projects.inviteGuest, {
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

  it('fences foreign users and teams and rolls back earlier grant writes atomically', async () => {
    const { t, f, person } = await fixture()
    for (const id of [f.meta.id, f.sub.id]) {
      const before = await t.run((ctx) => ctx.db.query('project_access').collect())
      await expectRefusal(
        as(t, f.user).mutation(api.projects.update, {
          org_id: f.org.id,
          id,
          patch: { access: { [person.id]: 'user', [f.otherAdmin.id]: 'user' } },
        }),
        'forbidden',
        /grantee must hold/,
      )
      await expectRefusal(
        as(t, f.user).mutation(api.projects.update, {
          org_id: f.org.id,
          id,
          patch: { access: { [person.id]: 'user' }, team_access: { [uuid()]: 'user' } },
        }),
        'forbidden',
        /team must belong/,
      )
      expect(await t.run((ctx) => ctx.db.query('project_access').collect())).toEqual(before)
    }
  })
})

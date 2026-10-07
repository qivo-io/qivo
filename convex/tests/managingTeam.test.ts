import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import { canSeeProject, hasProjectLevel } from '../lib/access'
import { byId } from '../lib/db'
import { as, expectRefusal, newT, plantSeat, uuid, withOrg } from './helpers.setup'

describe('teamless projects and accountable leads', () => {
  it('defaults each new project and sub-project to its creator without adding team permissions', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const type of ['meta', 'project'] as const) {
      const id = uuid()
      await as(t, f.user).mutation(api.projects.create, {
        org_id: f.org.id,
        id,
        type,
        key: type === 'meta' ? 'PROD' : 'WORK',
        name: 'Product work',
        sort_order: 9,
        ...(type === 'project' ? { parent_id: f.meta.id } : {}),
      })
      await t.run(async (ctx) => {
        const row = await byId(ctx, 'projects', id)
        expect(row?.lead_id).toBe(f.user.id)
        expect(row?.team_id).toBeUndefined()
        expect(
          await ctx.db
            .query('project_team_access')
            .withIndex('by_project', (q) => q.eq('project_id', id))
            .collect(),
        ).toEqual([])
      })
    }
  })

  it('team leadership grants no project access, including for legacy ownership values', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.meta._id, { lead_id: f.admin.id, team_id: f.team.id })
      const root = await ctx.db.get(f.meta._id)
      expect(await canSeeProject(ctx, f.user, root!)).toBe(false)
      expect(await hasProjectLevel(ctx, f.user, f.meta.id, 'lead')).toBe(false)
    })
    await expectRefusal(
      as(t, f.user).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { name: 'Non-lead team member cannot rename this' },
      }),
      'forbidden',
    )
  })

  it('a sub-project lead controls their workstream without taking over its parent or sibling', async () => {
    const t = newT()
    const f = await withOrg(t)
    const lead = await plantSeat(t, { org_id: f.org.id, auth_user_id: `lead_${uuid()}` })
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.sub.id,
      patch: { lead_id: lead.id },
    })
    await as(t, lead).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.sub.id,
      patch: { name: 'Owned workstream' },
    })
    for (const id of [f.meta.id, f.sub2.id]) {
      await expectRefusal(
        as(t, lead).mutation(api.projects.update, {
          org_id: f.org.id,
          id,
          patch: { name: 'Cannot rename other work' },
        }),
        'forbidden',
      )
    }
    await t.run(async (ctx) => {
      expect(await hasProjectLevel(ctx, lead, f.sub.id, 'lead')).toBe(true)
      expect(await hasProjectLevel(ctx, f.user, f.sub.id, 'user')).toBe(true)
      expect(await hasProjectLevel(ctx, f.user, f.sub.id, 'lead')).toBe(false)
      expect(await canSeeProject(ctx, lead, f.meta)).toBe(true)
      expect(await canSeeProject(ctx, lead, f.sub2)).toBe(false)
    })
  })

  it('a guest lead controls the product and inherited sub-project, but cannot be cleared', async () => {
    const t = newT()
    const f = await withOrg(t)
    const guestLead = await plantSeat(t, {
      org_id: f.org.id,
      org_role: 'guest',
      auth_user_id: `guest-lead_${uuid()}`,
    })
    const inactive = await plantSeat(t, {
      org_id: f.org.id,
      active: false,
      auth_user_id: `inactive_${uuid()}`,
    })
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { lead_id: guestLead.id },
    })
    await as(t, guestLead).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { name: 'Guest-led product' },
    })
    await as(t, guestLead).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.sub.id,
      patch: { name: 'Guest-led workstream' },
    })
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { lead_id: inactive.id },
      }),
      'rule',
      /active organization user/,
    )
    await expectRefusal(
      as(t, guestLead).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { lead_id: null },
      }),
      'bad_request',
      /must have a lead/,
    )
    await t.run(async (ctx) => {
      expect(await hasProjectLevel(ctx, guestLead, f.meta.id, 'lead')).toBe(true)
      expect(await hasProjectLevel(ctx, guestLead, f.sub.id, 'lead')).toBe(true)
    })
  })

  it('requires an eligible named lead when handing work over and rejects removing it', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const id of [f.meta.id, f.sub.id]) {
      for (const lead_id of [null, f.viewer.id, f.otherAdmin.id, uuid()]) {
        await expectRefusal(
          as(t, f.admin).mutation(api.projects.update, {
            org_id: f.org.id,
            id,
            patch: { lead_id },
          }),
          lead_id === null ? 'bad_request' : 'rule',
        )
      }
    }
  })
})

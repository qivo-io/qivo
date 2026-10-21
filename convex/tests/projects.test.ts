/* projects.ts — create/update/archive/unarchive/deleteDeep/inviteGuest +
 * milestones. Sentences asserted VERBATIM: they are
 * the SQL trigger/RPC prose the client toasts byte-for-byte. */

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { PROJECT_DESCRIPTION_MAX } from '../lib/projectLimits'
import { weekLabel } from '../model/orgs'
import {
  activityFor,
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  tick,
  uuid,
  withOrg,
} from './helpers.setup'

const createArgs = (f: OrgFixture, extra: Record<string, unknown> = {}) => ({
  org_id: f.org.id,
  id: uuid(),
  type: 'meta' as const,
  key: 'NEW',
  name: 'New project',
  sort_order: 9,
  ...extra,
})

const projectRow = (t: T, id: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query('projects')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

const milestoneRow = (t: T, id: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query('milestones')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

const lastEvent = async (t: T, orgId: string) => {
  const events = await activityFor(t, orgId)
  return events[events.length - 1]
}

describe('projects.create', () => {
  it('admin creates a teamless meta: counter num returned, created narration', async () => {
    const t = newT()
    const f = await withOrg(t)
    const res = await as(t, f.admin).mutation(api.projects.create, createArgs(f))
    expect(res.num).toBe(6) // fixture next_project_num 5 → bump
    expect(res.key).toBe('NEW') // a free suggested key is kept
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', res.id))
        .unique(),
    )
    expect(row?.track_delay).toBe(true) // teamless projects use the neutral default
    expect(row?.description).toBe('')
    expect(row?.archived_at).toBeUndefined()
    expect(row?.icon).toBeUndefined()
    expect(row?.icon_color).toBeUndefined()
    const e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({
      verb: 'created',
      target_type: 'project',
      target_id: res.id,
      label: 'New project',
      project_id: res.id,
    })
    expect(e.detail).toBeUndefined()
  })

  /* The icon fields were a leftover no screen used, so the functions no
     longer take them. Rows that hold one still validate. */
  it('refuses icon fields without inserting the project or consuming a number', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const extra of [{ icon: 'rocket' }, { icon_color: '#0366D6' }, { icon: null }]) {
      const args = { ...createArgs(f), ...extra }
      await expect(as(t, f.admin).mutation(api.projects.create, args)).rejects.toThrow(
        /Unexpected field `icon/,
      )
      expect(
        await t.run((ctx) =>
          ctx.db
            .query('projects')
            .withIndex('by_uuid', (q) => q.eq('id', args.id))
            .unique(),
        ),
      ).toBeNull()
    }
    const created = await as(t, f.admin).mutation(api.projects.create, createArgs(f))
    expect(created.num).toBe(6)
  })

  /* Who may create a product follows organizations.project_creators
   * (lib/projectCreators.ts); missing means 'users'. `selected` is a standard
   * user with can_create_projects on, `user` one without it. The viewer and
   * guest carry the right too, raw-patched, and still never qualify. The
   * schema refuses an unknown stored value even raw, so projectCreators.test.ts
   * covers that case on the shared rule. */
  const creatorsFixture = async (setting?: Doc<'organizations'>['project_creators']) => {
    const t = newT()
    const f = await withOrg(t)
    if (setting !== undefined) {
      await as(t, f.admin).mutation(api.orgs.update, {
        org_id: f.org.id,
        patch: { project_creators: setting },
      })
    }
    const selected = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Selected',
      email: 'selected@testbed.test',
      auth_user_id: `auth_selected_${f.org.id}`,
      accepted_at: NOW,
      can_create_projects: true,
    })
    await t.run(async (ctx) => {
      await ctx.db.patch(f.viewer._id, { can_create_projects: true })
      await ctx.db.patch(f.guest._id, { can_create_projects: true })
    })
    const callers = { admin: f.admin, user: f.user, selected, viewer: f.viewer, guest: f.guest }
    return { t, f, selected, callers }
  }

  for (const { setting, allowed, refusal } of [
    {
      setting: undefined,
      allowed: ['admin', 'user', 'selected'],
      refusal: /^only org admins and standard users can create projects$/,
    },
    {
      setting: 'users' as const,
      allowed: ['admin', 'user', 'selected'],
      refusal: /^only org admins and standard users can create projects$/,
    },
    {
      setting: 'selected' as const,
      allowed: ['admin', 'selected'],
      refusal: /^only org admins and selected standard users can create projects$/,
    },
    {
      setting: 'admins' as const,
      allowed: ['admin'],
      refusal: /^only org admins can create projects$/,
    },
  ]) {
    it(`under project_creators ${setting ?? 'missing'}, only ${allowed.join(', ')} create a product`, async () => {
      const { t, f, callers } = await creatorsFixture(setting)
      for (const [who, caller] of Object.entries(callers)) {
        const call = as(t, caller).mutation(
          api.projects.create,
          createArgs(f, { key: who.slice(0, 5).toUpperCase(), name: `By ${who}` }),
        )
        if (allowed.includes(who)) {
          const { id } = await call
          expect((await projectRow(t, id))?.name).toBe(`By ${who}`)
        } else {
          await expectRefusal(call, 'forbidden', refusal)
        }
      }
    })
  }

  it('the parent lead still creates sub-projects when the setting limits products', async () => {
    for (const setting of ['admins', 'selected'] as const) {
      const { t, f, selected } = await creatorsFixture(setting)
      // f.user leads f.meta and does not have can_create_projects
      const subArgs = (key: string) =>
        createArgs(f, { type: 'project' as const, parent_id: f.meta.id, key })
      const { id } = await as(t, f.user).mutation(api.projects.create, subArgs('SUB1'))
      expect((await projectRow(t, id))?.parent_id).toBe(f.meta.id)
      // a parent the creator cannot see reads like a missing one
      await expectRefusal(
        as(t, selected).mutation(api.projects.create, subArgs('SUB2')),
        'rule',
        /^parent project not found$/,
      )
      // the right to create products gives no lead standing on a parent
      await t.run((ctx) =>
        ctx.db.insert('project_access', {
          project_id: f.meta.id,
          profile_id: selected.id,
          level: 'user',
        }),
      )
      await expectRefusal(
        as(t, selected).mutation(api.projects.create, subArgs('SUB3')),
        'forbidden',
        /^requires lead access to this project$/,
      )
    }
  })

  it('sub creation: lead standing required; parent fenced with the hierarchy sentences', async () => {
    const t = newT()
    const f = await withOrg(t)
    const subArgs = (parent: string, key: string) =>
      createArgs(f, { type: 'project' as const, parent_id: parent, key })
    const res = await as(t, f.user).mutation(api.projects.create, subArgs(f.meta.id, 'SUB1'))
    expect(res.num).toBe(6)
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, subArgs(f.otherProject.id, 'SUB2')),
      'rule',
      /^parent project not found$/,
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, subArgs(f.sub.id, 'SUB3')),
      'rule',
      /^sub-projects live directly under a project, never under another sub-project$/,
    )
    const archived = await plantProject(t, {
      org_id: f.org.id,
      archived_at: '2026-01-02T00:00:00.000Z',
    })
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, subArgs(archived.id, 'SUB4')),
      'rule',
      /^the project is archived, so restore it first$/,
    )
    // lead standing on the parent, not mere visibility: guest holds 'user'
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.create, subArgs(f.meta.id, 'SUB5')),
      'forbidden',
    )
  })

  it('key shape is checked; replayed uuid refused', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, createArgs(f, { key: 'toolong' })),
      'bad_request',
    )
    const args = createArgs(f, { key: 'ONCE' })
    await as(t, f.admin).mutation(api.projects.create, args)
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, { ...args, key: 'TWICE' }),
      'bad_request',
      /id already exists/,
    )
  })

  it('a taken key is replaced by the first free candidate from the name', async () => {
    const t = newT()
    const f = await withOrg(t)
    // TBED belongs to the fixture meta; the name derives TES instead
    const res = await as(t, f.admin).mutation(
      api.projects.create,
      createArgs(f, { key: 'TBED', name: 'Test' }),
    )
    expect(res.key).toBe('TES')
    expect((await projectRow(t, res.id))?.key).toBe('TES')
    expect((await projectRow(t, f.meta.id))?.key).toBe('TBED')
  })

  it('keys of archived projects and projects the caller cannot see are skipped', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the admin's "Test" has no grants, so the user cannot see it
    const hidden = await as(t, f.admin).mutation(
      api.projects.create,
      createArgs(f, { key: 'TES', name: 'Test', lead_id: f.admin.id, access: {} }),
    )
    expect(hidden.key).toBe('TES')
    // what the user's client previews from its own view
    const mine = await as(t, f.user).mutation(
      api.projects.create,
      createArgs(f, { key: 'TES', name: 'Test' }),
    )
    expect(mine.key).toBe('TES2')
    await as(t, f.user).mutation(api.projects.archive, { org_id: f.org.id, id: mine.id })
    const again = await as(t, f.user).mutation(
      api.projects.create,
      createArgs(f, { key: 'TES', name: 'Test' }),
    )
    expect(again.key).toBe('TES3')
    // sub-projects share the organization's keys
    const sub = { type: 'project' as const, parent_id: again.id, name: 'Alpha', key: 'ALP' }
    const alpha = await as(t, f.user).mutation(api.projects.create, createArgs(f, sub))
    expect(alpha.key).toBe('ALP')
    await as(t, f.user).mutation(api.projects.archive, { org_id: f.org.id, id: alpha.id })
    const alpha2 = await as(t, f.user).mutation(api.projects.create, createArgs(f, sub))
    expect(alpha2.key).toBe('ALP2')
    const keys = await t.run(async (ctx) =>
      (await ctx.db.query('projects').collect()).map((p) => `${p.org_id}:${p.key}`),
    )
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('lead rules: a viewer or a foreign profile cannot lead', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, createArgs(f, { lead_id: f.viewer.id })),
      'rule',
      /^a viewer cannot lead a project, so make them a standard user first$/,
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, createArgs(f, { lead_id: f.otherAdmin.id })),
      'rule',
      /^the lead must be a member of the project's organization$/,
    )
  })

  it("the access map lands as grant rows; 'lead' entries are dropped", async () => {
    const t = newT()
    const f = await withOrg(t)
    const res = await as(t, f.admin).mutation(
      api.projects.create,
      createArgs(f, { access: { [f.guest.id]: 'viewer', [f.user.id]: 'lead' } }),
    )
    const grants = await t.run(async (ctx) =>
      ctx.db
        .query('project_access')
        .withIndex('by_project', (q) => q.eq('project_id', res.id))
        .collect(),
    )
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ profile_id: f.guest.id, level: 'viewer' })
  })
})

describe('projects.update', () => {
  it('rename narrates with the old name; a same-value rename is a silent no-op', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { name: 'Platform 2' },
    })
    const e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({
      verb: 'renamed',
      label: 'Platform 2',
      detail: 'from “Testbed platform”',
    })
    const before = (await activityFor(t, f.org.id)).length
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { name: 'Platform 2' },
    })
    expect((await activityFor(t, f.org.id)).length).toBe(before)
  })

  it('update refuses icon fields and leaves a stored icon alone', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => ctx.db.patch(f.meta._id, { icon: 'rocket', icon_color: '#0366D6' }))
    for (const patch of [{ icon: null }, { icon_color: 'red' }]) {
      await expect(
        // @ts-expect-error the patch no longer takes icon fields
        as(t, f.admin).mutation(api.projects.update, { org_id: f.org.id, id: f.meta.id, patch }),
      ).rejects.toThrow(/Unexpected field `icon/)
    }
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { name: 'Platform 2' },
    })
    const row = await t.run((ctx) => ctx.db.get(f.meta._id))
    expect(row).toMatchObject({ name: 'Platform 2', icon: 'rocket', icon_color: '#0366D6' })
  })

  it('lead handovers narrate both sides and a project lead cannot be cleared', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { lead_id: f.admin.id },
    })
    let e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'changed the lead of', detail: 'to admin (was user)' })
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { lead_id: f.user.id },
    })
    e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'changed the lead of', detail: 'to user (was admin)' })
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { lead_id: null },
      }),
      'bad_request',
      /^a project must have a lead$/,
    )
  })

  it('access diff upserts in one mutation and outranks the rename event, but never removes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const grantsOnMeta = () =>
      t.run(async (ctx) =>
        (
          await ctx.db
            .query('project_access')
            .withIndex('by_project', (q) => q.eq('project_id', f.meta.id))
            .collect()
        ).map((g) => [g.profile_id, g.level]),
      )
    const before = await grantsOnMeta()
    // a map from before someone else gave the viewer access would drop it
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { name: 'Dropped', access: { [f.guest.id]: 'viewer' } },
      }),
      'rule',
      /^an access map cannot remove access; remove it one person or team at a time$/,
    )
    expect(await grantsOnMeta()).toEqual(before)
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: {
        name: 'Renamed too',
        access: { [f.guest.id]: 'viewer', [f.viewer.id]: 'user', [f.agent.id]: 'user' },
      },
    })
    // guest's updated, the agent's added, the viewer's kept
    expect((await grantsOnMeta()).sort()).toEqual(
      [
        [f.guest.id, 'viewer'],
        [f.viewer.id, 'user'],
        [f.agent.id, 'user'],
      ].sort(),
    )
    const e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'changed access on', label: 'Renamed too' })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.meta.id))
        .unique(),
    )
    expect(row?.name).toBe('Renamed too')
  })

  it('a team_access map changes shares but never leaves one out', async () => {
    const t = newT()
    const f = await withOrg(t)
    const crew = uuid()
    await t.run(async (ctx) => {
      await ctx.db.insert('teams', {
        id: crew,
        org_id: f.org.id,
        name: 'Crew',
        track_delay_default: false,
        created_at: f.org.created_at,
      })
      for (const team_id of [f.team.id, crew])
        await ctx.db.insert('project_team_access', {
          project_id: f.meta.id,
          team_id,
          level: 'user',
        })
    })
    const sharesOnMeta = () =>
      t.run(async (ctx) =>
        (
          await ctx.db
            .query('project_team_access')
            .withIndex('by_project', (q) => q.eq('project_id', f.meta.id))
            .collect()
        )
          .map((s) => [s.team_id, s.level])
          .sort(),
      )
    const before = await sharesOnMeta()
    // a map from before someone else shared the project with Crew
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { team_access: { [f.team.id]: 'viewer' } },
      }),
      'rule',
      /^an access map cannot remove access; remove it one person or team at a time$/,
    )
    expect(await sharesOnMeta()).toEqual(before)
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { team_access: { [f.team.id]: 'viewer', [crew]: 'user' } },
    })
    expect(await sharesOnMeta()).toEqual(
      [
        [f.team.id, 'viewer'],
        [crew, 'user'],
      ].sort(),
    )
  })

  it('grants on a sub-project are scoped there; viewer grantees stay capped', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.sub.id,
      patch: { access: { [f.guest.id]: 'user' } },
    })
    const grant = await t.run((ctx) =>
      ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.sub.id).eq('profile_id', f.guest.id),
        )
        .unique(),
    )
    expect(grant?.level).toBe('user')
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.sub.id,
        patch: { access: { [f.viewer.id]: 'user' } },
      }),
      'forbidden',
      /^a viewer can only receive a viewer grant$/,
    )
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.hidden.id,
        patch: { access: { [f.viewer.id]: 'user' } },
      }),
      'forbidden',
    )
  })

  it('who may grant: organization admins and project leads; the grantee must hold a seat in the org', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a 'user' grant on the meta is visibility, not lead standing
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { access: { [f.guest.id]: 'viewer' } },
      }),
      'forbidden',
    )
    // the project lead qualifies — and an access patch ALWAYS narrates, even
    // when the diff is empty (lead handovers ride this branch, as before)
    await as(t, f.user).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { access: { [f.guest.id]: 'user', [f.viewer.id]: 'user' } },
    })
    const e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({
      verb: 'changed access on',
      actor_id: f.user.id,
      target_id: f.meta.id,
    })
    // someone from a third org does not qualify as a grantee
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { access: { [f.otherAdmin.id]: 'user' } },
      }),
      'forbidden',
    )
  })

  it("the access map speaks vGrantLevel (plus the dropped 'lead') only — anything else dies in the validator", async () => {
    const t = newT()
    const f = await withOrg(t)
    // forged wire values a typed client could never send
    const admin = 'admin' as unknown as 'user'
    const member = 'member' as unknown as 'user' // the pre-0098 word is DEAD
    await expect(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { access: { [f.guest.id]: admin } },
      }),
    ).rejects.toThrowError(/Validator error/)
    await expect(
      as(t, f.admin).mutation(
        api.projects.create,
        createArgs(f, { key: 'BADLV', access: { [f.guest.id]: member } }),
      ),
    ).rejects.toThrowError(/Validator error/)
  })

  it('key change is allowed with shape + uniqueness revalidated; non-lead callers are refused', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { key: 'TBED2' },
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.meta.id))
        .unique(),
    )
    expect(row?.key).toBe('TBED2')
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { key: 'SKNK' },
      }),
      'bad_request',
      /already exists/,
    )
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { name: 'X' },
      }),
      'forbidden',
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.otherProject.id,
        patch: { name: 'X' },
      }),
      'not_found',
      /^project not found$/,
    )
  })
})

describe('projects.setAccess', () => {
  /* The project's grants, as [subject, level] pairs in a fixed order. */
  const grants = (t: T, projectId: string) =>
    t.run(async (ctx) => {
      const people = await ctx.db
        .query('project_access')
        .withIndex('by_project', (q) => q.eq('project_id', projectId))
        .collect()
      const teams = await ctx.db
        .query('project_team_access')
        .withIndex('by_project', (q) => q.eq('project_id', projectId))
        .collect()
      return [
        ...people.map((g) => [g.profile_id, g.level]),
        ...teams.map((g) => [g.team_id, g.level]),
      ].sort()
    })

  it('gives or changes one grant and leaves every other grant as it is', async () => {
    const t = newT()
    const f = await withOrg(t)
    const set = (subject: { user_id?: string; team_id?: string }, level: 'user' | 'viewer') =>
      as(t, f.admin).mutation(api.projects.setAccess, {
        org_id: f.org.id,
        id: f.meta.id,
        ...subject,
        level,
      })
    const before = await grants(t, f.meta.id)
    expect(await set({ user_id: f.agent.id }, 'user')).toEqual({ changed: true })
    expect(await set({ user_id: f.guest.id }, 'viewer')).toEqual({ changed: true })
    expect(await set({ team_id: f.team.id }, 'viewer')).toEqual({ changed: true })
    expect(await set({ team_id: f.team.id }, 'viewer')).toEqual({ changed: false })
    expect(await grants(t, f.meta.id)).toEqual(
      [
        ...before.filter(([id]) => id !== f.guest.id),
        [f.agent.id, 'user'],
        [f.guest.id, 'viewer'],
        [f.team.id, 'viewer'],
      ].sort(),
    )
    expect(await lastEvent(t, f.org.id)).toMatchObject({ verb: 'changed access on' })
  })

  it('refuses whoever does not control the project, the lead, and a subject outside the organization', async () => {
    const t = newT()
    const f = await withOrg(t)
    const before = await grants(t, f.meta.id)
    const set = (who: Doc<'profiles'>, subject: { user_id?: string; team_id?: string }) =>
      as(t, who).mutation(api.projects.setAccess, {
        org_id: f.org.id,
        id: f.meta.id,
        ...subject,
        level: 'user',
      })
    // the guest edits TBED but does not lead it
    await expectRefusal(set(f.guest, { user_id: f.agent.id }), 'forbidden')
    // the lead's access is the lead role
    await expectRefusal(set(f.admin, { user_id: f.user.id }), 'rule', /leads this project/)
    await expectRefusal(set(f.admin, { user_id: f.otherAdmin.id }), 'not_found')
    await expectRefusal(set(f.admin, { team_id: uuid() }), 'not_found')
    await expectRefusal(set(f.admin, {}), 'bad_request')
    await expectRefusal(set(f.admin, { user_id: f.agent.id, team_id: f.team.id }), 'bad_request')
    expect(await grants(t, f.meta.id)).toEqual(before)
  })

  it("keeps a grant given after a page loaded, which that page's access map would drop", async () => {
    const t = newT()
    const f = await withOrg(t)
    // the page loaded with the guest's and the viewer's grants; then the
    // agent was given access
    const stale = { [f.guest.id]: 'user' as const, [f.viewer.id]: 'user' as const }
    await as(t, f.admin).mutation(api.projects.setAccess, {
      org_id: f.org.id,
      id: f.meta.id,
      user_id: f.agent.id,
      level: 'user',
    })
    const before = await grants(t, f.meta.id)
    await expectRefusal(
      as(t, f.user).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { access: { ...stale, [f.guest.id]: 'viewer' } },
      }),
      'rule',
      /^an access map cannot remove access/,
    )
    expect(await grants(t, f.meta.id)).toEqual(before)
    // a lead handed over in the same map still gives up their own grant
    await as(t, f.user).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { lead_id: f.agent.id, access: { ...stale, [f.user.id]: 'user' } },
    })
    expect(await grants(t, f.meta.id)).toEqual(
      [
        [f.guest.id, 'user'],
        [f.viewer.id, 'user'],
        [f.user.id, 'user'],
      ].sort(),
    )
  })
})

describe('project review time', () => {
  const REVIEW_HOURS_SENTENCE = /^review_hours must be a number of hours from 0 to 999, or null$/
  const setReviewHours = (
    t: T,
    f: OrgFixture,
    id: string,
    review_hours: number | null,
    caller = f.user,
  ) =>
    as(t, caller).mutation(api.projects.update, { org_id: f.org.id, id, patch: { review_hours } })
  const stored = async (t: T, id: string) =>
    await t.run((ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique(),
    )

  it('the lead sets it on a project or sub-project at the 0.1 h grain; null clears it; no narration', async () => {
    const t = newT()
    const f = await withOrg(t)
    await setReviewHours(t, f, f.meta.id, 2.25)
    expect((await stored(t, f.meta.id))?.review_hours).toBe(2.3)
    await setReviewHours(t, f, f.sub.id, 0)
    expect((await stored(t, f.sub.id))?.review_hours).toBe(0)
    await setReviewHours(t, f, f.meta.id, 999)
    expect((await stored(t, f.meta.id))?.review_hours).toBe(999)
    await setReviewHours(t, f, f.meta.id, null)
    expect('review_hours' in ((await stored(t, f.meta.id)) ?? {})).toBe(false)
    expect(await activityFor(t, f.org.id)).toEqual([])
  })

  it('refuses out-of-range values and non-leads; a new project inherits (absent)', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const bad of [-1, 1000]) {
      await expectRefusal(setReviewHours(t, f, f.sub.id, bad), 'bad_request', REVIEW_HOURS_SENTENCE)
    }
    await expectRefusal(setReviewHours(t, f, f.meta.id, 3, f.guest), 'forbidden')
    expect((await stored(t, f.sub.id))?.review_hours).toBeUndefined()
    expect((await stored(t, f.meta.id))?.review_hours).toBeUndefined()
    const created = await as(t, f.admin).mutation(api.projects.create, createArgs(f))
    expect('review_hours' in ((await stored(t, created.id)) ?? {})).toBe(false)
  })
})

describe('project description limits', () => {
  const snapshot = (t: T) =>
    t.run(async (ctx) => ({
      projects: await ctx.db.query('projects').collect(),
      organizations: await ctx.db.query('organizations').collect(),
      access: await ctx.db.query('project_access').collect(),
      teamAccess: await ctx.db.query('project_team_access').collect(),
      activity: await ctx.db.query('activity_events').collect(),
    }))

  it.each(['meta', 'project'] as const)(
    'creates %s descriptions through the 500-unit boundary without trimming, including null and omission',
    async (type) => {
      const t = newT()
      const f = await withOrg(t)
      expect(PROJECT_DESCRIPTION_MAX).toBe(500)
      const boundary = ` \n${'x'.repeat(496)}\n `
      const unicodeBoundary = '😀'.repeat(250)
      for (const [index, description] of [
        undefined,
        null,
        '',
        boundary,
        unicodeBoundary,
      ].entries()) {
        const created = await as(t, f.admin).mutation(
          api.projects.create,
          createArgs(f, {
            type,
            key: `DESC${index}`,
            ...(type === 'project' ? { parent_id: f.meta.id } : {}),
            ...(description === undefined ? {} : { description }),
          }),
        )
        const row = await t.run((ctx) =>
          ctx.db
            .query('projects')
            .withIndex('by_uuid', (q) => q.eq('id', created.id))
            .unique(),
        )
        expect(row?.description).toBe(description ?? '')
      }
    },
  )

  it.each(['meta', 'project'] as const)(
    'refuses oversized %s creation without consuming a number or creating rows',
    async (type) => {
      const t = newT()
      const f = await withOrg(t)
      const before = await snapshot(t)
      for (const description of ['x'.repeat(501), `${'😀'.repeat(250)}x`]) {
        await expectRefusal(
          as(t, f.admin).mutation(
            api.projects.create,
            createArgs(f, {
              type,
              ...(type === 'project' ? { parent_id: f.meta.id } : {}),
              description,
              access: { [f.guest.id]: 'viewer' },
              team_access: { [f.team.id]: 'user' },
            }),
          ),
          'bad_request',
          /^a project description must be 500 characters or fewer$/,
        )
        expect(await snapshot(t)).toEqual(before)
      }
    },
  )

  it.each(['meta', 'project'] as const)(
    'updates %s descriptions at the boundary and preserves empty-string semantics',
    async (type) => {
      const t = newT()
      const f = await withOrg(t)
      const project = type === 'meta' ? f.meta : f.sub
      for (const description of [` \n${'x'.repeat(496)}\n `, '😀'.repeat(250), '', null]) {
        await as(t, f.admin).mutation(api.projects.update, {
          org_id: f.org.id,
          id: project.id,
          patch: { description },
        })
        expect((await t.run((ctx) => ctx.db.get(project._id)))?.description).toBe(description ?? '')
      }
    },
  )

  it.each(['meta', 'project'] as const)(
    'refuses an oversized %s description atomically with other settings and grants',
    async (type) => {
      const t = newT()
      const f = await withOrg(t)
      const project = type === 'meta' ? f.meta : f.sub
      const before = await snapshot(t)
      for (const description of ['x'.repeat(501), `${'😀'.repeat(250)}x`]) {
        await expectRefusal(
          as(t, f.admin).mutation(api.projects.update, {
            org_id: f.org.id,
            id: project.id,
            patch: {
              name: 'Renamed',
              key: 'EDIT',
              lead_id: f.user.id,
              track_delay: true,
              review_hours: 4,
              ...(type === 'meta'
                ? {
                    access: { [f.guest.id]: 'viewer' as const },
                    team_access: { [f.team.id]: 'viewer' as const },
                  }
                : {}),
              description,
            },
          }),
          'bad_request',
          /^a project description must be 500 characters or fewer$/,
        )
        expect(await snapshot(t)).toEqual(before)
        expect((await t.run((ctx) => ctx.db.get(project._id)))?.review_hours).toBeUndefined()
      }
    },
  )

  it.each(['meta', 'project'] as const)(
    'leaves an existing oversized %s description untouched when omitted and accepts null to clear it',
    async (type) => {
      const t = newT()
      const f = await withOrg(t)
      const project = type === 'meta' ? f.meta : f.sub
      const existing = 'legacy text '.repeat(50)
      await t.run((ctx) => ctx.db.patch(project._id, { description: existing }))
      await as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: project.id,
        patch: { name: 'Renamed' },
      })
      expect((await t.run((ctx) => ctx.db.get(project._id)))?.description).toBe(existing)
      await as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: project.id,
        patch: { description: null },
      })
      expect((await t.run((ctx) => ctx.db.get(project._id)))?.description).toBe('')
    },
  )

  it('keeps permission and organization fences ahead of description validation', async () => {
    const t = newT()
    const f = await withOrg(t)
    const patch = { description: 'x'.repeat(501) }
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.update, { org_id: f.org.id, id: f.meta.id, patch }),
      'forbidden',
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.otherProject.id,
        patch,
      }),
      'not_found',
      /^project not found$/,
    )
  })
})

describe('projects.archive / unarchive', () => {
  it('archiving a meta stamps active subs with the SAME instant and counts them', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.projects.archive, { org_id: f.org.id, id: f.meta.id })
    const rows = await t.run(async (ctx) => ({
      meta: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.meta.id))
        .unique(),
      sub: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.sub.id))
        .unique(),
      sub2: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.sub2.id))
        .unique(),
    }))
    expect(rows.meta?.archived_at).toBeDefined()
    expect(rows.sub?.archived_at).toBe(rows.meta?.archived_at)
    expect(rows.sub2?.archived_at).toBe(rows.meta?.archived_at)
    const e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'archived', detail: 'with 2 sub-projects' })
    // already archived ⇒ silent no-op
    const before = (await activityFor(t, f.org.id)).length
    await as(t, f.admin).mutation(api.projects.archive, { org_id: f.org.id, id: f.meta.id })
    expect((await activityFor(t, f.org.id)).length).toBe(before)
  })

  it('restoring a meta brings back exactly the subs its own archiving carried down', async () => {
    const t = newT()
    const f = await withOrg(t)
    // sub2 archived on its own instant first — it must NOT ride the restore.
    // tick() forces the meta's archive onto a strictly later millisecond: the
    // restore matches subs by archived_at EQUALITY (0106), so a same-ms
    // coincidence would wrongly carry sub2 back (it flaked under suite load)
    await as(t, f.admin).mutation(api.projects.archive, { org_id: f.org.id, id: f.sub2.id })
    await tick()
    await as(t, f.admin).mutation(api.projects.archive, { org_id: f.org.id, id: f.meta.id })
    const e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'archived', detail: 'with 1 sub-project' })
    await as(t, f.admin).mutation(api.projects.unarchive, { org_id: f.org.id, id: f.meta.id })
    const rows = await t.run(async (ctx) => ({
      meta: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.meta.id))
        .unique(),
      sub: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.sub.id))
        .unique(),
      sub2: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.sub2.id))
        .unique(),
    }))
    expect(rows.meta?.archived_at).toBeUndefined()
    expect(rows.sub?.archived_at).toBeUndefined()
    expect(rows.sub2?.archived_at).toBeDefined()
    expect(await lastEvent(t, f.org.id)).toMatchObject({
      verb: 'restored',
      detail: 'from the archive',
    })
  })

  it('restoring a sub surfaces its parent and nothing else', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.projects.archive, { org_id: f.org.id, id: f.meta.id })
    await as(t, f.admin).mutation(api.projects.unarchive, { org_id: f.org.id, id: f.sub.id })
    const rows = await t.run(async (ctx) => ({
      meta: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.meta.id))
        .unique(),
      sub: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.sub.id))
        .unique(),
      sub2: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.sub2.id))
        .unique(),
    }))
    expect(rows.sub?.archived_at).toBeUndefined()
    expect(rows.meta?.archived_at).toBeUndefined()
    expect(rows.sub2?.archived_at).toBeDefined() // the sibling stays put
  })
})

describe('projects.unarchive of a sub-project under an archived parent', () => {
  // t.run hands undefined back as null
  const archivedAt = (t: T, _id: Doc<'projects'>['_id']) =>
    t.run(async (ctx) => (await ctx.db.get(_id))?.archived_at ?? null)

  it('needs lead on the parent, because it restores the parent too', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the guest leads FW and holds a User grant on the parent f.user leads
    await t.run(async (ctx) => ctx.db.patch(f.sub._id, { lead_id: f.guest.id }))
    await as(t, f.user).mutation(api.projects.archive, { org_id: f.org.id, id: f.meta.id })
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.unarchive, { org_id: f.org.id, id: f.sub.id }),
      'forbidden',
      /^requires lead access to the archived parent project$/,
    )
    expect(await archivedAt(t, f.meta._id)).not.toBeNull()
    expect(await archivedAt(t, f.sub._id)).not.toBeNull()
    // an admin leads both, so restoring the sub surfaces the parent
    await as(t, f.admin).mutation(api.projects.unarchive, { org_id: f.org.id, id: f.sub.id })
    expect(await archivedAt(t, f.meta._id)).toBeNull()
    expect(await archivedAt(t, f.sub._id)).toBeNull()
  })

  it('still lets the sub-project lead restore it while the parent is active', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => ctx.db.patch(f.sub._id, { lead_id: f.guest.id }))
    await as(t, f.guest).mutation(api.projects.archive, { org_id: f.org.id, id: f.sub.id })
    expect(await archivedAt(t, f.sub._id)).not.toBeNull()
    await as(t, f.guest).mutation(api.projects.unarchive, { org_id: f.org.id, id: f.sub.id })
    expect(await archivedAt(t, f.sub._id)).toBeNull()
  })
})

describe('projects.deleteDeep', () => {
  it('guards: uniform not-found for foreign rows, the RPC sentence for missing rights', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.otherProject.id }),
      'not_found',
      /^project not found$/,
    )
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.meta.id }),
      'rule',
      /^requires the project lead$/,
    )
  })

  it("a project's delete event has no owning-team branch", async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await as(t, f.admin).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.sub.id })
    let e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'deleted', label: 'Firmware', project_id: f.meta.id })
    expect(e.team_id).toBeUndefined()
    await as(t, f.admin).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.meta.id })
    e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'deleted', label: 'Testbed platform' })
    expect(e.team_id).toBeUndefined()
    expect(e.project_id).toBeUndefined()
    const left = await t.run(async (ctx) => ({
      projects: await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect(),
      issues: await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect(),
    }))
    // sub2 died with the meta's subtree — only the unrelated meta survives
    expect(left.projects.map((p) => p.id)).toEqual([f.hidden.id])
    expect(left.issues).toHaveLength(0)
  })
})

describe('projects.inviteGuest', () => {
  const invite = (t: T, f: OrgFixture, extra: Record<string, unknown> = {}) =>
    as(t, f.admin).mutation(api.projects.inviteGuest, {
      org_id: f.org.id,
      project_id: f.meta.id,
      email: 'Anna.K@Example.se',
      level: 'user',
      ...extra,
    })

  it('an unknown address gets a guest seat and a grant on the selected sub-project', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { id: pid, emailed } = await invite(t, f, { project_id: f.sub.id })
    expect(emailed).toBe(true)
    const p = await t.run(async (ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', pid))
        .unique(),
    )
    expect(p).toMatchObject({
      org_id: f.org.id,
      email: 'anna.k@example.se',
      name: 'anna.k',
      initials: 'AN', // upper(left(local part, 2)) — NOT nameInitials
      color: '#8A8F98',
      org_role: 'guest',
      active: true,
      kind: 'person',
      plannable_hours: 40, // the HOST org default
      message_retention_days: 7, // no sibling seat ⇒ the old column default
    })
    expect(p?.accepted_at).toBeUndefined()
    expect(p?.auth_user_id).toBeUndefined()
    const grant = await t.run(async (ctx) =>
      ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) => q.eq('project_id', f.sub.id).eq('profile_id', pid))
        .unique(),
    )
    expect(grant?.level).toBe('user')
    // inviting twice UPDATES the level, mints no second seat
    const again = await invite(t, f, { project_id: f.sub.id, level: 'viewer' })
    expect(again).toEqual({ id: pid, emailed: false })
    const after = await t.run(async (ctx) => ({
      seats: await ctx.db
        .query('profiles')
        .withIndex('by_email', (q) => q.eq('email', 'anna.k@example.se'))
        .collect(),
      grant: await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) => q.eq('project_id', f.sub.id).eq('profile_id', pid))
        .unique(),
    }))
    expect(after.seats).toHaveLength(1)
    expect(after.grant?.level).toBe('viewer')
  })

  it('a known address in the org gets the grant only; retention follows a sibling seat', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { id: pid, emailed } = await invite(t, f, { email: f.guest.email })
    expect(pid).toBe(f.guest.id)
    expect(emailed).toBe(false)
    // a sibling seat elsewhere carries retention 30 — the new guest copies it
    await t.run(async (ctx) => {
      await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: f.otherOrg.id,
        email: 'bo@example.se',
        name: 'bo',
        initials: 'BO',
        color: '#8A8F98',
        org_role: 'user',
        active: true,
        kind: 'person',
        message_retention_days: 30,
        created_at: '2025-01-01T00:00:00.000Z',
      })
    })
    const { id: bo } = await invite(t, f, { email: 'bo@example.se' })
    const seat = await t.run(async (ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', bo))
        .unique(),
    )
    expect(seat?.message_retention_days).toBe(30)
  })

  it('refusal sentences, verbatim — including the 0098-missed level sentence', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(
      invite(t, f, { level: 'lead' }),
      'rule',
      /^a project role is lead, member or viewer$/,
    )
    await expectRefusal(
      invite(t, f, { email: 'not-an-address' }),
      'rule',
      /^that does not look like an email address$/,
    )
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.inviteGuest, {
        org_id: f.org.id,
        project_id: f.meta.id,
        email: 'x@y.se',
        level: 'user',
      }),
      'rule',
      /^no permission to manage users on this project$/,
    )
    await expectRefusal(
      invite(t, f, { project_id: f.otherProject.id }),
      'not_found',
      /^project not found$/,
    )
  })
})

describe('milestones', () => {
  it('add narrates at the org-grid week label; the arrival guard keeps its own sentence', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.user).mutation(api.projects.addMilestone, {
      org_id: f.org.id,
      id,
      project_id: f.meta.id,
      name: 'Beta',
      week: '2026-05-11',
    })
    const e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({
      verb: 'added milestone',
      target_type: 'milestone',
      target_id: id,
      label: 'Beta',
      detail: `at ${weekLabel('2026-05-11', f.org)}`,
      project_id: f.meta.id,
    })
    const archived = await plantProject(t, {
      org_id: f.org.id,
      archived_at: '2026-01-02T00:00:00.000Z',
    })
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.addMilestone, {
        org_id: f.org.id,
        id: uuid(),
        project_id: archived.id,
        name: 'Nope',
        week: '2026-05-11',
      }),
      'rule',
      /^that project is archived, so restore it first$/,
    )
    // a viewer's capped grant never reaches 'user'
    await expectRefusal(
      as(t, f.viewer).mutation(api.projects.addMilestone, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.meta.id,
        name: 'Nor this',
        week: '2026-05-11',
      }),
      'forbidden',
    )
  })

  it('update verbs name what actually changed — a pure rename must not read as a move', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.user).mutation(api.projects.addMilestone, {
      org_id: f.org.id,
      id,
      project_id: f.meta.id,
      name: 'Beta',
      week: '2026-05-11',
    })
    // the dialog always submits both fields
    await as(t, f.user).mutation(api.projects.updateMilestone, {
      org_id: f.org.id,
      id,
      patch: { name: 'Beta 2', week: '2026-05-18' },
    })
    let e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({
      verb: 'moved milestone',
      label: 'Beta 2',
      detail: `from ${weekLabel('2026-05-11', f.org)} to ${weekLabel('2026-05-18', f.org)} (renamed from “Beta”)`,
    })
    await as(t, f.user).mutation(api.projects.updateMilestone, {
      org_id: f.org.id,
      id,
      patch: { name: 'Beta 3', week: '2026-05-18' },
    })
    e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'renamed milestone', label: 'Beta 3', detail: 'from “Beta 2”' })
    // a submit that changes nothing writes no row, in the app, REST and MCP
    const rows = async () => (await activityFor(t, f.org.id)).length
    const before = await rows()
    await as(t, f.user).mutation(api.projects.updateMilestone, {
      org_id: f.org.id,
      id,
      patch: { name: 'Beta 3', week: '2026-05-18' },
    })
    await t.mutation(internal.machine.projects.restUpdateMilestone, {
      callerId: f.user.id,
      access: 'write',
      keyName: null,
      ref: f.meta.key,
      milestone: id,
      body: JSON.stringify({ name: 'Beta 3', date: '2026-05-18' }),
    })
    await t.mutation(internal.machine.projects.mcpSetMilestone, {
      callerId: f.user.id,
      access: 'write',
      project: f.meta.key,
      milestone: id,
      name: ' Beta 3 ',
    })
    expect(await rows()).toBe(before)
    // it is still validated first
    await expectRefusal(
      as(t, f.user).mutation(api.projects.updateMilestone, {
        org_id: f.org.id,
        id,
        patch: { name: ' ', week: '2026-05-18' },
      }),
      'bad_request',
      /^a milestone name cannot be blank$/,
    )
    expect(await rows()).toBe(before)
  })

  it('remove deletes the row and narrates; foreign milestones read not-found', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.user).mutation(api.projects.addMilestone, {
      org_id: f.org.id,
      id,
      project_id: f.meta.id,
      name: 'Beta',
      week: '2026-05-11',
    })
    await as(t, f.user).mutation(api.projects.removeMilestone, { org_id: f.org.id, id })
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query('milestones')
          .withIndex('by_uuid', (q) => q.eq('id', id))
          .unique(),
      ),
    ).toBeNull()
    const e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'deleted milestone', label: 'Beta', project_id: f.meta.id })
    expect(e.detail).toBeUndefined()
    await expectRefusal(
      as(t, f.user).mutation(api.projects.removeMilestone, { org_id: f.org.id, id: uuid() }),
      'not_found',
      /^milestone not found$/,
    )
  })

  it('stores a milestone named against a sub-project on its top-level project', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.user).mutation(api.projects.addMilestone, {
      org_id: f.org.id,
      id,
      project_id: f.sub.id,
      name: 'Beta',
      week: '2026-05-11',
    })
    expect(await milestoneRow(t, id)).toMatchObject({ project_id: f.meta.id, week: '2026-05-11' })
    expect(await lastEvent(t, f.org.id)).toMatchObject({
      verb: 'added milestone',
      target_id: id,
      project_id: f.meta.id,
    })
  })

  it('needs User access on the top-level project, not only on a sub-project', async () => {
    const t = newT()
    const f = await withOrg(t)
    const subOnly = await plantSeat(t, {
      org_id: f.org.id,
      name: 'sub only',
      auth_user_id: 'auth_sub_only',
      accepted_at: NOW,
    })
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: subOnly.id,
        level: 'user',
      }),
    )
    const id = uuid()
    await expectRefusal(
      as(t, subOnly).mutation(api.projects.addMilestone, {
        org_id: f.org.id,
        id,
        project_id: f.sub.id,
        name: 'Beta',
        week: '2026-05-11',
      }),
      'forbidden',
      /^no write access to this project$/,
    )
    expect(await milestoneRow(t, id)).toBeNull()
  })

  it('reads projects and milestones the caller cannot see as not found', async () => {
    const t = newT()
    const f = await withOrg(t)
    const subOnly = await plantSeat(t, {
      org_id: f.org.id,
      name: 'sub only',
      auth_user_id: 'auth_sub_only',
      accepted_at: NOW,
    })
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: subOnly.id,
        level: 'user',
      }),
    )
    // an unseen sibling sub-project, a hidden project and another organization's
    for (const project_id of [f.sub2.id, f.hidden.id, f.otherProject.id, uuid()]) {
      const id = uuid()
      await expectRefusal(
        as(t, subOnly).mutation(api.projects.addMilestone, {
          org_id: f.org.id,
          id,
          project_id,
          name: 'Beta',
          week: '2026-05-11',
        }),
        'not_found',
        /^project not found$/,
      )
      expect(await milestoneRow(t, id)).toBeNull()
    }
    // the hidden project's lead adds one there; the viewer can see the
    // top-level project but cannot write to it
    const hidden = uuid()
    const shown = uuid()
    for (const [id, project_id] of [
      [hidden, f.hidden.id],
      [shown, f.meta.id],
    ])
      await as(t, f.user).mutation(api.projects.addMilestone, {
        org_id: f.org.id,
        id,
        project_id,
        name: 'Beta',
        week: '2026-05-11',
      })
    const viewer = as(t, f.viewer)
    const update = (id: string) =>
      viewer.mutation(api.projects.updateMilestone, {
        org_id: f.org.id,
        id,
        patch: { name: 'Renamed' },
      })
    const remove = (id: string) =>
      viewer.mutation(api.projects.removeMilestone, { org_id: f.org.id, id })
    await expectRefusal(update(hidden), 'not_found', /^milestone not found$/)
    await expectRefusal(remove(hidden), 'not_found', /^milestone not found$/)
    await expectRefusal(update(shown), 'forbidden', /^no write access to this project$/)
    await expectRefusal(remove(shown), 'forbidden', /^no write access to this project$/)
    for (const id of [hidden, shown])
      expect(await milestoneRow(t, id)).toMatchObject({ name: 'Beta' })
  })

  it('refuses a milestone named against an archived sub-project of an active project', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => ctx.db.patch(f.sub._id, { archived_at: '2026-01-02T00:00:00.000Z' }))
    await expectRefusal(
      as(t, f.user).mutation(api.projects.addMilestone, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.sub.id,
        name: 'Beta',
        week: '2026-05-11',
      }),
      'rule',
      /^that project is archived, so restore it first$/,
    )
  })

  it('accepts real calendar days, including a leap day', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.user).mutation(api.projects.addMilestone, {
      org_id: f.org.id,
      id,
      project_id: f.meta.id,
      name: 'Leap',
      week: '2028-02-29',
    })
    expect((await milestoneRow(t, id))?.week).toBe('2028-02-29')
    // the app keeps the picked weekday, so a mid-week day is valid too
    await as(t, f.user).mutation(api.projects.updateMilestone, {
      org_id: f.org.id,
      id,
      patch: { week: '2026-12-31' },
    })
    expect((await milestoneRow(t, id))?.week).toBe('2026-12-31')
  })

  it('refuses impossible dates and other text on add and update, writing nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.user).mutation(api.projects.addMilestone, {
      org_id: f.org.id,
      id,
      project_id: f.meta.id,
      name: 'Beta',
      week: '2026-05-11',
    })
    const cases: [string, RegExp][] = [
      ['2026-02-31', /^a milestone week must be a valid calendar date$/],
      ['2026-13-01', /^a milestone week must be a valid calendar date$/],
      ['2025-02-29', /^a milestone week must be a valid calendar date$/],
      ['2026-00-10', /^a milestone week must be a valid calendar date$/],
      ['garbage', /^a milestone week is an ISO date \(YYYY-MM-DD\)$/],
      ['2026-5-11', /^a milestone week is an ISO date \(YYYY-MM-DD\)$/],
      ['2026-05-11T00:00:00Z', /^a milestone week is an ISO date \(YYYY-MM-DD\)$/],
      ['', /^a milestone week is an ISO date \(YYYY-MM-DD\)$/],
    ]
    for (const [week, sentence] of cases) {
      const fresh = uuid()
      await expectRefusal(
        as(t, f.user).mutation(api.projects.addMilestone, {
          org_id: f.org.id,
          id: fresh,
          project_id: f.meta.id,
          name: 'Nope',
          week,
        }),
        'bad_request',
        sentence,
      )
      expect(await milestoneRow(t, fresh)).toBeNull()
      await expectRefusal(
        as(t, f.user).mutation(api.projects.updateMilestone, {
          org_id: f.org.id,
          id,
          patch: { name: 'Renamed', week },
        }),
        'bad_request',
        sentence,
      )
    }
    expect(await milestoneRow(t, id)).toMatchObject({ name: 'Beta', week: '2026-05-11' })
  })
})

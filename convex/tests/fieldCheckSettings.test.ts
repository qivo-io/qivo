/* The field check on settings and deletes (model/expected.ts): projects,
 * project access, teams, labels, people, the organization and its address,
 * and the deletes Deleted items cannot undo (comments, milestones, labels,
 * teams). Each kind gets one edit that passes and one that is refused
 * because someone changed a field it names since its sender read it. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import { byId } from '../lib/db'
import { printOf, trimmedForm } from '../lib/fieldPrints'
import type { Refusal } from '../lib/functions'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not
 * declare it. */
declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

type Fx = OrgFixture & { t: T }

async function setup(): Promise<Fx> {
  const t = newT()
  return { t, ...(await withOrg(t)) }
}

/** Expects a field_changed refusal and answers its data. */
async function fieldChanged(p: Promise<unknown>): Promise<Refusal> {
  const data = (await expectRefusal(p, 'conflict')).data as Refusal
  expect(data.reason).toBe('field_changed')
  return data
}

/* A REST call as `who`, signed with the key name drive. */
const rest = (who: Doc<'profiles'>) => ({
  callerId: who.id,
  access: 'write' as const,
  keyName: 'drive',
})

describe('projects', () => {
  it('compares a project field, and the lead as each surface reads it', async () => {
    const fx = await setup()
    const update = (who: Doc<'profiles'>, patch: object, expected: object) =>
      as(fx.t, who).mutation(api.projects.update, {
        org_id: fx.org.id,
        id: fx.sub.id,
        patch,
        expected,
      })
    await update(fx.user, { name: 'Firmware 2' }, { name: 'Firmware' })
    const data = await fieldChanged(update(fx.admin, { name: 'Other' }, { name: 'Firmware' }))
    expect(data.changes).toEqual([
      { record: 'project', id: fx.sub.id, field: 'name', by: null, at: null },
    ])
    expect(data.message).toBe(
      'name of project FW changed since you read it, so nothing was saved; read project FW again and resend your change',
    )

    // FW has no lead of its own. The app reads none, REST reads TBED's
    await fieldChanged(update(fx.user, { lead_id: fx.admin.id }, { lead_id: fx.user.id }))
    const project = () => fx.t.run((ctx) => byId(ctx, 'projects', fx.sub.id))
    expect((await project())?.lead_id).toBeUndefined()
    await fx.t.mutation(internal.machine.projects.restUpdateProject, {
      ...rest(fx.user),
      ref: 'FW',
      body: JSON.stringify({ lead_id: fx.admin.id, expected: { lead_id: fx.user.id } }),
    })
    expect((await project())?.lead_id).toBe(fx.admin.id)
  })
})

describe('project access', () => {
  it('compares the level seen, null for none, on setAccess and REST', async () => {
    const fx = await setup()
    const pia = await plantSeat(fx.t, {
      org_id: fx.org.id,
      name: 'Pia',
      email: 'pia@testbed.test',
      accepted_at: NOW,
    })
    const set = (level: 'user' | 'viewer', seen: 'user' | 'viewer' | null) =>
      as(fx.t, fx.user).mutation(api.projects.setAccess, {
        org_id: fx.org.id,
        id: fx.sub.id,
        user_id: pia.id,
        level,
        expected: { level: seen },
      })
    const level = () =>
      fx.t.run(
        async (ctx) =>
          (
            await ctx.db
              .query('project_access')
              .withIndex('by_project_profile', (q) =>
                q.eq('project_id', fx.sub.id).eq('profile_id', pia.id),
              )
              .unique()
          )?.level,
      )
    await set('viewer', null)
    const data = await fieldChanged(set('user', null))
    expect(data.changes).toEqual([
      { record: 'grant', id: fx.sub.id, of: pia.id, field: 'level', by: null, at: null },
    ])
    expect(await level()).toBe('viewer')
    // REST reads the same level
    await fieldChanged(
      fx.t.mutation(internal.machine.projects.restSetUserAccess, {
        ...rest(fx.user),
        ref: 'FW',
        subject: pia.id,
        body: JSON.stringify({ level: 'user', expected: { level: null } }),
      }),
    )
    await set('user', 'viewer')
    expect(await level()).toBe('user')
  })

  it('compares the level of a person an invitation already names', async () => {
    const fx = await setup()
    const invite = (level: string, seen: 'user' | 'viewer' | null) =>
      as(fx.t, fx.user).mutation(api.projects.inviteGuest, {
        org_id: fx.org.id,
        project_id: fx.sub.id,
        email: fx.guest.email!,
        level,
        expected: { level: seen },
      })
    expect(await invite('viewer', null)).toBe(fx.guest.id)
    await fieldChanged(invite('user', null))
    const grants = await fx.t.run((ctx) =>
      ctx.db
        .query('project_access')
        .withIndex('by_project', (q) => q.eq('project_id', fx.sub.id))
        .collect(),
    )
    expect(grants.map((g) => [g.profile_id, g.level])).toEqual([[fx.guest.id, 'viewer']])
  })
})

describe('an invitation to an address whose seat is gone', () => {
  it('refuses a stale level instead of inviting a removed member back', async () => {
    const fx = await setup()
    const invite = (seen: 'user' | 'viewer' | null) =>
      as(fx.t, fx.user).mutation(api.projects.inviteGuest, {
        org_id: fx.org.id,
        project_id: fx.sub.id,
        email: 'gone@testbed.test',
        level: 'user',
        expected: { level: seen },
      })
    // the inviter saw a Viewer seat for the address, which is gone now
    await fieldChanged(invite('viewer'))
    expect(
      await fx.t.run((ctx) =>
        ctx.db
          .query('profiles')
          .withIndex('by_org_email', (q) =>
            q.eq('org_id', fx.org.id).eq('email', 'gone@testbed.test'),
          )
          .first(),
      ),
    ).toBeNull()
    // one who saw no seat invites a new guest
    expect(typeof (await invite(null))).toBe('string')
  })
})

describe('rights before the check', () => {
  it('refuses a caller without the right as before, whatever expected says', async () => {
    const fx = await setup()
    const stale = { name: 'Not the name' }
    await expectRefusal(
      as(fx.t, fx.viewer).mutation(api.teams.update, {
        org_id: fx.org.id,
        id: fx.team.id,
        patch: { name: 'Renamed' },
        expected: stale,
      }),
      'forbidden',
    )
    await expectRefusal(
      as(fx.t, fx.viewer).mutation(api.projects.update, {
        org_id: fx.org.id,
        id: fx.sub.id,
        patch: { name: 'Renamed' },
        expected: stale,
      }),
      'forbidden',
    )
    await expectRefusal(
      as(fx.t, fx.viewer).mutation(api.profiles.setPlannableHours, {
        org_id: fx.org.id,
        profile_id: fx.user.id,
        hours: 20,
        expected: { plannable_hours: 1 },
      }),
      'rule',
    )
  })
})

describe('teams', () => {
  it('compares a team edit and a team delete', async () => {
    const fx = await setup()
    const team = () => fx.t.run((ctx) => byId(ctx, 'teams', fx.team.id))
    const update = (who: Doc<'profiles'>, patch: object, expected: object) =>
      as(fx.t, who).mutation(api.teams.update, {
        org_id: fx.org.id,
        id: fx.team.id,
        patch,
        expected,
      })
    await update(fx.admin, { name: 'Hardware 2', stale_days: 21 }, { name: 'Hardware' })
    // the leader read the old name and day count; a day count that rounds
    // to the one stored passes all the same
    await fieldChanged(update(fx.user, { name: 'HW' }, { name: 'Hardware' }))
    await update(fx.user, { stale_days: 21.4 }, { stale_days: 14 })
    expect(await team()).toMatchObject({ name: 'Hardware 2', stale_days: 21 })

    // a second team, so the first may go
    await as(fx.t, fx.admin).mutation(api.teams.create, {
      org_id: fx.org.id,
      id: uuid(),
      name: 'Software',
    })
    const remove = (expected: object) =>
      as(fx.t, fx.admin).mutation(api.teams.deleteDeep, {
        org_id: fx.org.id,
        id: fx.team.id,
        expected,
      })
    await fieldChanged(remove({ name: 'Hardware' }))
    expect(await team()).not.toBeNull()
    await remove({ name: 'Hardware 2', stale_days: 21 })
    expect(await team()).toBeNull()
  })
})

describe('labels', () => {
  it('compares a legacy color in the form every read shows it, and a label delete', async () => {
    const fx = await setup()
    const id = uuid()
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('labels', {
        id,
        org_id: fx.org.id,
        name: 'Old',
        name_lower: 'old',
        color: 'red',
        created_at: NOW,
      })
    })
    const update = (patch: object, expected: object) =>
      as(fx.t, fx.admin).mutation(api.labels.update, { org_id: fx.org.id, id, patch, expected })
    const label = () => fx.t.run((ctx) => byId(ctx, 'labels', id))
    await update({ color: '#336699' }, { color: '#8A8F98' })
    await fieldChanged(update({ color: '#000000' }, { color: '#8A8F98' }))
    expect((await label())?.color).toBe('#336699')

    const remove = (expected: object) =>
      as(fx.t, fx.admin).mutation(api.labels.remove, { org_id: fx.org.id, id, expected })
    await fieldChanged(remove({ name: 'Old', color: '#8A8F98' }))
    expect(await label()).not.toBeNull()
    await remove({ name: 'Old', color: '#336699' })
    expect(await label()).toBeNull()
  })
})

describe('people', () => {
  it('compares a seat edit by an admin', async () => {
    const fx = await setup()
    const update = (patch: object, expected: object) =>
      as(fx.t, fx.admin).mutation(api.profiles.update, {
        org_id: fx.org.id,
        id: fx.viewer.id,
        patch,
        expected,
      })
    await update({ name: 'Vera' }, { name: 'viewer' })
    const data = await fieldChanged(update({ name: 'Vic' }, { name: 'viewer' }))
    expect(data.changes).toEqual([
      { record: 'profile', id: fx.viewer.id, field: 'name', by: null, at: null },
    ])
    expect((await fx.t.run((ctx) => byId(ctx, 'profiles', fx.viewer.id)))?.name).toBe('Vera')
  })

  it('reads a creation right turned off as absent, so two admins turning it off both pass', async () => {
    const fx = await setup()
    const right = (on: boolean, seen: boolean) =>
      as(fx.t, fx.admin).mutation(api.profiles.update, {
        org_id: fx.org.id,
        id: fx.user.id,
        patch: { can_create_projects: on },
        expected: { can_create_projects: seen },
      })
    await right(true, false)
    await right(false, true)
    // the second admin read it on too, and also turns it off
    await right(false, true)
    expect(
      (await fx.t.run((ctx) => byId(ctx, 'profiles', fx.user.id)))?.can_create_projects,
    ).not.toBe(true)
    await right(true, false)
    // one who read it off while it is on now is stale
    await fieldChanged(
      as(fx.t, fx.admin).mutation(api.profiles.update, {
        org_id: fx.org.id,
        id: fx.user.id,
        patch: { can_create_projects: false, name: 'Ulla' },
        expected: { can_create_projects: false },
      }),
    )
  })

  it('takes a plannable week read as none, and tells an agent it has none before any check', async () => {
    const fx = await setup()
    const founder = await plantSeat(fx.t, {
      org_id: fx.org.id,
      name: 'Founder',
      org_role: 'admin',
      plannable_hours: undefined,
    })
    const overRest = (ref: string, seen: number | null) =>
      fx.t.mutation(internal.machine.rest.updateUser, {
        callerId: fx.admin.id,
        access: 'write',
        ref,
        body: JSON.stringify({ plannable_hours: 30, expected: { plannable_hours: seen } }),
      })
    await overRest(founder.id, null)
    expect((await fx.t.run((ctx) => byId(ctx, 'profiles', founder.id)))?.plannable_hours).toBe(30)
    // the agent rule answers first, so the refusal says what to do
    await expectRefusal(overRest(fx.agent.id, 30), 'rule')
  })

  it('compares the plannable week in the app and over REST', async () => {
    const fx = await setup()
    const hours = async () =>
      (await fx.t.run((ctx) => byId(ctx, 'profiles', fx.user.id)))?.plannable_hours
    const app = (h: number, seen: number) =>
      as(fx.t, fx.admin).mutation(api.profiles.setPlannableHours, {
        org_id: fx.org.id,
        profile_id: fx.user.id,
        hours: h,
        expected: { plannable_hours: seen },
      })
    const overRest = (h: number, seen: number) =>
      fx.t.mutation(internal.machine.rest.updateUser, {
        callerId: fx.admin.id,
        access: 'write',
        ref: fx.user.id,
        body: JSON.stringify({ plannable_hours: h, expected: { plannable_hours: seen } }),
      })
    await app(30, 40)
    await fieldChanged(app(20, 40))
    await fieldChanged(overRest(20, 40))
    expect(await hours()).toBe(30)
    await overRest(20, 30)
    expect(await hours()).toBe(20)
  })

  it('compares a display name on the seat the app showed only', async () => {
    const fx = await setup()
    // the same login holds a seat elsewhere under another name
    const other = await plantSeat(fx.t, {
      org_id: fx.otherOrg.id,
      name: 'Someone else',
      email: fx.user.email,
      auth_user_id: fx.user.auth_user_id,
      accepted_at: NOW,
    })
    const rename = (name: string, seen: string) =>
      as(fx.t, fx.user).mutation(api.profiles.setDisplayName, {
        name,
        expected: { profile_id: fx.user.id, name: seen },
      })
    expect(await rename('Ursula', 'user')).toBeNull()
    await fieldChanged(rename('Una', 'user'))
    const names = await fx.t.run(async (ctx) => [
      (await byId(ctx, 'profiles', fx.user.id))?.name,
      (await byId(ctx, 'profiles', other.id))?.name,
    ])
    expect(names).toEqual(['Ursula', 'Ursula'])
  })

  it('compares the profile picture the app showed', async () => {
    const fx = await setup()
    const store = () =>
      fx.t.run(async (ctx) => {
        const sid = await ctx.storage.store(new Blob([new Uint8Array(64)]) as never)
        await ctx.db.patch(sid as never, { contentType: 'image/png' } as never)
        return sid
      })
    const picture = async () =>
      (await fx.t.run((ctx) => byId(ctx, 'profiles', fx.user.id)))?.avatar_storage_id
    const set = (storage_id: Id<'_storage'>, seen: string | null) =>
      as(fx.t, fx.user).mutation(api.files.setAvatar, {
        profile_id: fx.user.id,
        storage_id,
        expected: { avatar_storage_id: seen },
      })
    const first = await store()
    await set(first, null)
    await fieldChanged(set(await store(), null))
    expect(await picture()).toBe(first)
    const clear = (seen: string | null) =>
      as(fx.t, fx.user).mutation(api.files.clearAvatar, {
        profile_id: fx.user.id,
        expected: { avatar_storage_id: seen },
      })
    await fieldChanged(clear(null))
    await clear(first)
    expect(await picture()).toBeUndefined()
  })
})

describe('the organization', () => {
  it('compares a setting and the address', async () => {
    const fx = await setup()
    const update = (patch: object, expected: object) =>
      as(fx.t, fx.admin).mutation(api.orgs.update, { org_id: fx.org.id, patch, expected })
    await update({ name: 'Testbed 2' }, { name: 'Testbed Labs' })
    const data = await fieldChanged(update({ name: 'Testbed 3' }, { name: 'Testbed Labs' }))
    expect(data.changes).toEqual([
      { record: 'organization', id: fx.org.id, field: 'name', by: null, at: null },
    ])
    const setSlug = (slug: string, seen: string) =>
      as(fx.t, fx.admin).mutation(api.orgs.setSlug, {
        org_id: fx.org.id,
        slug,
        expected: { slug: seen },
      })
    await setSlug('testbed-two', 'testbed')
    await fieldChanged(setSlug('testbed-three', 'testbed'))
    const org = await fx.t.run((ctx) => byId(ctx, 'organizations', fx.org.id))
    expect(org).toMatchObject({ name: 'Testbed 2', slug: 'testbed-two' })
  })
})

describe('deletes', () => {
  it('keeps a comment whose body changed since it was read, in the app and over REST', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const id = uuid()
    await as(fx.t, fx.user).mutation(api.comments.create, {
      org_id: fx.org.id,
      id,
      issue_id: row.id,
      body: 'First',
    })
    await as(fx.t, fx.user).mutation(api.comments.update, {
      org_id: fx.org.id,
      id,
      body: 'Second',
    })
    const comment = () => fx.t.run((ctx) => byId(ctx, 'comments', id))
    const app = (seen: string) =>
      as(fx.t, fx.admin).mutation(api.comments.remove, {
        org_id: fx.org.id,
        id,
        expected: { body: printOf(trimmedForm(seen)) },
      })
    await fieldChanged(app('First'))
    await fieldChanged(
      fx.t.mutation(internal.machine.discussion.restDeleteComment, {
        callerId: fx.admin.id,
        access: 'write',
        ref: id,
        body: JSON.stringify({ expected: { body: 'First' } }),
      }),
    )
    expect(await comment()).not.toBeNull()
    await app('Second')
    expect(await comment()).toBeNull()
  })

  it('keeps a milestone renamed since it was read, in the app and over REST', async () => {
    const fx = await setup()
    const id = uuid()
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('milestones', {
        id,
        project_id: fx.meta.id,
        name: 'Ship',
        week: '2026-06-01',
        created_at: NOW,
      })
    })
    const milestone = () => fx.t.run((ctx) => byId(ctx, 'milestones', id))
    const app = (expected: object) =>
      as(fx.t, fx.user).mutation(api.projects.removeMilestone, { org_id: fx.org.id, id, expected })
    await fieldChanged(app({ name: 'Launch' }))
    await fieldChanged(
      fx.t.mutation(internal.machine.projects.restDeleteMilestone, {
        ...rest(fx.user),
        ref: 'TBED',
        milestone: id,
        body: JSON.stringify({ expected: { date: '2026-05-25' } }),
      }),
    )
    expect(await milestone()).not.toBeNull()
    await app({ name: 'Ship', week: '2026-06-01' })
    expect(await milestone()).toBeNull()
  })
})

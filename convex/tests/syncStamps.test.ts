/* Team sync stamps live in sync_stamps, off the profile documents
 * (model/syncStamps.ts): a stamp never writes the profile, the people part
 * ships them on its profile rows, and removing a person or an organization
 * leaves no stamp row. */

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { deleteOrgDeep, removeProfile } from '../model/cascade'
import { deleteOrgStep } from '../model/orgDeletion'
import { as, NOW, newT, type OrgFixture, type T, withOrg, workspaceOf } from './helpers.setup'

const stampRows = (t: T) => t.run(async (ctx) => await ctx.db.query('sync_stamps').collect())

const profileRow = (t: T, profile: Doc<'profiles'>) =>
  t.run(async (ctx) => await ctx.db.get(profile._id))

const stamp = (t: T, f: OrgFixture, profile_id: string) =>
  as(t, f.admin).mutation(api.teamSync.stamp, { org_id: f.org.id, profile_id })

const shipped = async (t: T, f: OrgFixture, id: string) =>
  (await workspaceOf(as(t, f.viewer)))?.profiles.find((p) => p.id === id)

describe('teamSync.stamp', () => {
  it('writes a stamp row and leaves the profile document as it was', async () => {
    const t = newT()
    const f = await withOrg(t)
    const before = await profileRow(t, f.user)
    await stamp(t, f, f.user.id)
    expect(await profileRow(t, f.user)).toEqual(before)
    const rows = await stampRows(t)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ org_id: f.org.id, profile_id: f.user.id })
    expect(rows[0]).not.toHaveProperty('since')
  })
})

describe('workspace.people', () => {
  it('ships the stamp row on the profile row, its since only when it holds one', async () => {
    const t = newT()
    const f = await withOrg(t)
    await stamp(t, f, f.user.id)
    const [row] = await stampRows(t)
    expect(await shipped(t, f, f.user.id)).toMatchObject({ sync_at: row.at })
    expect(await shipped(t, f, f.user.id)).not.toHaveProperty('sync_since')
    await t.run(async (ctx) => {
      await ctx.db.patch(row._id, { since: NOW })
    })
    expect(await shipped(t, f, f.user.id)).toMatchObject({ sync_at: row.at, sync_since: NOW })
    expect(await shipped(t, f, f.admin.id)).not.toHaveProperty('sync_at')
  })
})

describe('removal', () => {
  it('a removed person leaves no stamp row', async () => {
    const t = newT()
    const f = await withOrg(t)
    await stamp(t, f, f.user.id)
    await stamp(t, f, f.agent.id)
    await t.run(async (ctx) => removeProfile(ctx, { profile: f.user, now: NOW }))
    expect((await stampRows(t)).map((row) => row.profile_id)).toEqual([f.agent.id])
  })

  it('an organization deleted in steps or at once leaves no stamp row, a stray one included', async () => {
    const t = newT()
    const f = await withOrg(t)
    await stamp(t, f, f.user.id)
    // rows whose profile is already gone, as a rollback or a manual edit
    // leaves them
    await t.run(async (ctx) => {
      for (const org_id of [f.org.id, f.otherOrg.id])
        await ctx.db.insert('sync_stamps', { org_id, profile_id: 'gone-profile', at: NOW })
    })
    await as(t, f.otherAdmin).mutation(api.teamSync.stamp, {
      org_id: f.otherOrg.id,
      profile_id: f.otherAdmin.id,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        created_at: NOW,
        phase: 'profiles',
      })
    })
    for (let step = 0; step < 50; step++) {
      const finished = await t.run(async (ctx) => {
        const removal = await ctx.db
          .query('org_removals')
          .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
          .unique()
        return removal === null || (await deleteOrgStep(ctx, removal))
      })
      if (finished) break
    }
    // the deletion finished, its own row gone with the organization
    expect(await t.run((ctx) => ctx.db.query('org_removals').collect())).toEqual([])
    expect((await stampRows(t)).map((row) => row.org_id)).toEqual([f.otherOrg.id, f.otherOrg.id])
    await t.run(async (ctx) => deleteOrgDeep(ctx, (await ctx.db.get(f.otherOrg._id))!))
    expect(await stampRows(t)).toEqual([])
  })
})

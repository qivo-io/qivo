/* Team sync stamps live in sync_stamps, off the profile documents
 * (model/syncStamps.ts): a stamp never writes the profile, the snapshot
 * still ships them on its profile rows, the one-time backfill
 * (internal/syncStampsBackfill.ts) moves the retired profile fields, and
 * removing a person or an organization leaves no stamp row. */

import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { BACKFILL_PAGE } from '../internal/syncStampsBackfill'
import { deleteOrgDeep, removeProfile } from '../model/cascade'
import { deleteOrgStep } from '../model/orgDeletion'
import { as, NOW, newT, type OrgFixture, type T, withOrg } from './helpers.setup'

const DEFAULT_PAGE = { ...BACKFILL_PAGE }
const EARLIER = '2026-01-05T09:00:00.000Z'

afterEach(() => {
  Object.assign(BACKFILL_PAGE, DEFAULT_PAGE)
})

const stampRows = (t: T) => t.run(async (ctx) => await ctx.db.query('sync_stamps').collect())

const profileRow = (t: T, profile: Doc<'profiles'>) =>
  t.run(async (ctx) => await ctx.db.get(profile._id))

/* Writes a stamp into the retired profile fields, as releases before
 * sync_stamps did. */
const legacy = (t: T, profile: Doc<'profiles'>, sync_at: string, sync_since?: string) =>
  t.run(async (ctx) => {
    await ctx.db.patch(profile._id, { sync_at, sync_since })
  })

const stamp = (t: T, f: OrgFixture, profile_id: string) =>
  as(t, f.admin).mutation(api.teamSync.stamp, { org_id: f.org.id, profile_id })

const shipped = async (t: T, f: OrgFixture, id: string) =>
  (await as(t, f.viewer).query(api.snapshot.forMe, {}))?.profiles.find((p) => p.id === id)

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

  it("rolls a stamp still in the profile fields into the next sitting's since", async () => {
    const t = newT()
    const f = await withOrg(t)
    await legacy(t, f.user, EARLIER)
    await stamp(t, f, f.user.id)
    const [row] = await stampRows(t)
    expect(row.since).toBe(EARLIER)
    expect(row.at > EARLIER).toBe(true)
  })
})

describe('snapshot.forMe', () => {
  it('ships the stamp row, or the retired profile fields without one, on the profile rows', async () => {
    const t = newT()
    const f = await withOrg(t)
    await stamp(t, f, f.user.id)
    const [row] = await stampRows(t)
    // the row wins over profile fields a backfill has not cleared yet
    await legacy(t, f.user, EARLIER, EARLIER)
    expect(await shipped(t, f, f.user.id)).toMatchObject({ sync_at: row.at })
    expect(await shipped(t, f, f.user.id)).not.toHaveProperty('sync_since')
    await legacy(t, f.agent, EARLIER, NOW)
    expect(await shipped(t, f, f.agent.id)).toMatchObject({ sync_at: EARLIER, sync_since: NOW })
    expect(await shipped(t, f, f.admin.id)).not.toHaveProperty('sync_at')
  })
})

describe('internal/syncStampsBackfill', () => {
  const remaining = async (t: T) => {
    const total = { rows: 0, moved: 0, pages: 0 }
    let cursor: string | null = null
    for (;;) {
      const page: { rows: number; moved: number; cursor: string; done: boolean } = await t.query(
        internal.internal.syncStampsBackfill.remaining,
        { cursor },
      )
      total.rows += page.rows
      total.moved += page.moved
      total.pages++
      if (page.done) return total
      cursor = page.cursor
    }
  }
  const audits = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.query('platform_audit_log').collect()).filter(
        (row) => row.action === 'sync_stamps_backfill',
      ),
    )

  it('moves the stamps into rows page by page, keeps a newer row, and is idempotent', async () => {
    const t = newT()
    const f = await withOrg(t)
    BACKFILL_PAGE.rows = 2
    await legacy(t, f.user, EARLIER, NOW)
    await legacy(t, f.agent, EARLIER)
    // stamped since this release: the row is newer than the fields
    await legacy(t, f.viewer, EARLIER)
    await stamp(t, f, f.viewer.id)
    const newer = (await stampRows(t))[0]
    // a since without an at holds no stamp
    await t.run(async (ctx) => {
      await ctx.db.patch(f.guest._id, { sync_since: EARLIER })
    })

    expect(await remaining(t)).toMatchObject({ rows: 4, moved: 2 })
    const dry = await t.action(internal.internal.syncStampsBackfill.run, { dry_run: true })
    expect(dry).toEqual({ dry_run: true, rows: 4, moved: 2 })
    expect(await stampRows(t)).toHaveLength(1)
    expect(await audits(t)).toEqual([])

    const done = await t.action(internal.internal.syncStampsBackfill.run, { dry_run: false })
    expect(done).toEqual({ dry_run: false, rows: 4, moved: 2 })
    const rows = new Map((await stampRows(t)).map((row) => [row.profile_id, row]))
    expect(rows.size).toBe(3)
    expect(rows.get(f.user.id)).toMatchObject({ org_id: f.org.id, at: EARLIER, since: NOW })
    expect(rows.get(f.agent.id)).toMatchObject({ at: EARLIER })
    expect(rows.get(f.agent.id)).not.toHaveProperty('since')
    expect(rows.get(f.viewer.id)).toEqual(newer)
    for (const person of [f.user, f.agent, f.viewer, f.guest]) {
      const row = await profileRow(t, person)
      expect(row).not.toHaveProperty('sync_at')
      expect(row).not.toHaveProperty('sync_since')
    }
    // the snapshot ships the same stamps from the rows
    expect(await shipped(t, f, f.user.id)).toMatchObject({ sync_at: EARLIER, sync_since: NOW })

    const left = await remaining(t)
    expect(left).toMatchObject({ rows: 0, moved: 0 })
    expect(left.pages).toBeGreaterThan(1)
    const [audit] = await audits(t)
    expect(audit).toMatchObject({ actor_email: 'system', detail: { rows: 4, moved: 2 } })

    // a second run finds nothing and changes nothing but its own audit row
    expect(await t.action(internal.internal.syncStampsBackfill.run, { dry_run: false })).toEqual({
      dry_run: false,
      rows: 0,
      moved: 0,
    })
    expect(await stampRows(t)).toHaveLength(3)
    expect(await audits(t)).toHaveLength(2)
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

  it('an organization deleted in steps or at once leaves no stamp row', async () => {
    const t = newT()
    const f = await withOrg(t)
    await stamp(t, f, f.user.id)
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
    expect((await stampRows(t)).map((row) => row.org_id)).toEqual([f.otherOrg.id])
    await t.run(async (ctx) => deleteOrgDeep(ctx, (await ctx.db.get(f.otherOrg._id))!))
    expect(await stampRows(t)).toEqual([])
  })
})

/* The one-time migration that clears the retired team columns
 * (internal/teamLegacyFields.ts): its check and dry run write nothing, and
 * the clear removes the columns and nothing else. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import { NOW, newT, uuid, withOrg } from './helpers.setup'

describe('internal/teamLegacyFields', () => {
  it('counts the teams holding a retired column, clears them, and reports zero after', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.team._id, { stale_days: 14, archive_days: 30 })
      await ctx.db.insert('teams', {
        id: uuid(),
        org_id: f.org.id,
        name: 'Uploads',
        max_attachment_mb: 10,
        track_delay_default: false,
        created_at: NOW,
      })
      await ctx.db.insert('teams', {
        id: uuid(),
        org_id: f.org.id,
        name: 'Clean',
        track_delay_default: true,
        created_at: NOW,
      })
    })
    const teams = () => t.run((ctx) => ctx.db.query('teams').collect())
    const before = await teams()
    expect(await t.query(internal.internal.teamLegacyFields.check, {})).toMatchObject({
      teams: 2,
      done: true,
    })
    expect(await t.action(internal.internal.teamLegacyFields.clear, { dry_run: true })).toEqual({
      dry_run: true,
      teams: 2,
    })
    expect(await teams()).toEqual(before)

    expect(await t.action(internal.internal.teamLegacyFields.clear, { dry_run: false })).toEqual({
      dry_run: false,
      teams: 2,
    })
    const after = await teams()
    for (const team of after) {
      expect([team.stale_days, team.archive_days, team.max_attachment_mb]).toEqual([
        undefined,
        undefined,
        undefined,
      ])
    }
    // everything else stays as it was
    expect(after.map(({ name, track_delay_default }) => ({ name, track_delay_default }))).toEqual(
      before.map(({ name, track_delay_default }) => ({ name, track_delay_default })),
    )
    expect(await t.query(internal.internal.teamLegacyFields.check, {})).toMatchObject({
      teams: 0,
      done: true,
    })
  })
})

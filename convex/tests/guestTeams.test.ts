/* internal/guestTeams:repair removes the team rows that guests kept from
 * before every role change followed "a guest is never a team member", and
 * internal/guestTeams:check counts them without writing. The fixture spreads
 * the stale rows over more than one page, so the last one is only found when
 * the walk follows the cursor. */
/// <reference types="vite/client" />

import type { FunctionReturnType } from 'convex/server'
import { describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import { NOW, newT, plantSeat, type T, uuid, withOrg } from './helpers.setup'

const membershipsOf = (t: T, profileId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('team_members')
      .withIndex('by_profile', (q) => q.eq('profile_id', profileId))
      .collect(),
  )

const allMemberships = (t: T) => t.run((ctx) => ctx.db.query('team_members').collect())

async function withStaleGuests(t: T) {
  const f = await withOrg(t)
  const secondGuest = await plantSeat(t, { org_id: f.org.id, org_role: 'guest' })
  const otherGuest = await plantSeat(t, { org_id: f.otherOrg.id, org_role: 'guest' })
  const team = (org_id: string, name: string) => ({
    id: uuid(),
    org_id,
    name,
    stale_days: 14,
    archive_days: 30,
    track_delay_default: false,
    created_at: NOW,
  })
  const firmware = team(f.org.id, 'Firmware')
  const elsewhere = team(f.otherOrg.id, 'Elsewhere')
  await t.run(async (ctx) => {
    await ctx.db.insert('teams', firmware)
    await ctx.db.insert('teams', elsewhere)
    const join = (team_id: string, profile_id: string, is_leader = false) =>
      ctx.db.insert('team_members', { team_id, profile_id, is_leader })
    await join(f.team.id, f.guest.id)
    await join(firmware.id, f.guest.id, true)
    await join(firmware.id, f.viewer.id)
    await join(elsewhere.id, otherGuest.id)
    await join(elsewhere.id, f.otherAdmin.id, true)
    // Members enough to push the last stale row onto a later page.
    for (let i = 0; i < 300; i++) {
      const id = uuid()
      await ctx.db.insert('profiles', {
        id,
        org_id: f.org.id,
        name: `Member ${i}`,
        initials: 'MB',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        plannable_hours: 40,
        created_at: NOW,
      })
      await join(f.team.id, id)
    }
    await join(f.team.id, secondGuest.id)
  })
  return { f, secondGuest, otherGuest }
}

describe('internal/guestTeams:repair', () => {
  it('a dry run counts the stale rows and changes nothing', async () => {
    const t = newT()
    await withStaleGuests(t)
    const before = await allMemberships(t)

    const report = await t.action(internal.internal.guestTeams.repair, { dry_run: true })

    expect(report).toEqual({ dry_run: true, memberships: 4, leaderships: 1, guests: 3 })
    expect(await allMemberships(t)).toEqual(before)
  })

  it('removes every guest row on every page, keeps the rest, and finds nothing the second time', async () => {
    const t = newT()
    const { f, secondGuest, otherGuest } = await withStaleGuests(t)
    const before = await allMemberships(t)

    const report = await t.action(internal.internal.guestTeams.repair, { dry_run: false })

    expect(report).toEqual({ dry_run: false, memberships: 4, leaderships: 1, guests: 3 })
    for (const guest of [f.guest, secondGuest, otherGuest]) {
      expect(await membershipsOf(t, guest.id)).toEqual([])
    }
    expect(await allMemberships(t)).toHaveLength(before.length - 4)
    expect(await membershipsOf(t, f.viewer.id)).toHaveLength(1)
    expect(await membershipsOf(t, f.user.id)).toMatchObject([{ is_leader: true }])
    expect(await membershipsOf(t, f.otherAdmin.id)).toMatchObject([{ is_leader: true }])

    expect(await t.action(internal.internal.guestTeams.repair, { dry_run: false })).toEqual({
      dry_run: false,
      memberships: 0,
      leaderships: 0,
      guests: 0,
    })
  })
})

type CheckResult = FunctionReturnType<typeof internal.internal.guestTeams.check>

/** Follows `check` from the first page to the last and adds up its counts.
 * Throws instead of looping when a walk never reports `done`. */
async function checkEveryPage(t: T, limit?: number) {
  let cursor: string | null = null
  let memberships = 0
  let leaderships = 0
  for (let pages = 1; pages <= 1_000; pages++) {
    const result: CheckResult = await t.query(internal.internal.guestTeams.check, { cursor, limit })
    memberships += result.memberships
    leaderships += result.leaderships
    if (result.done) return { memberships, leaderships, pages }
    cursor = result.cursor
  }
  throw new Error('check never reported done')
}

describe('internal/guestTeams:check', () => {
  it('counts, page by page, what the dry run counts and changes nothing', async () => {
    const t = newT()
    await withStaleGuests(t)
    const before = await allMemberships(t)
    const dryRun = await t.action(internal.internal.guestTeams.repair, { dry_run: true })

    const walk = await checkEveryPage(t, 2)

    expect(walk.pages).toBeGreaterThan(100)
    expect(walk).toMatchObject({ memberships: dryRun.memberships, leaderships: dryRun.leaderships })
    expect(await t.query(internal.internal.guestTeams.check, { cursor: null })).toMatchObject({
      memberships: 4,
      leaderships: 1,
      guests: 3,
      done: true,
    })
    expect(await allMemberships(t)).toEqual(before)
  })

  it('reports zeros where no guest holds a team row, and reads at most 1,000 rows a call', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      for (let i = 0; i < 1_000; i++) {
        await ctx.db.insert('team_members', {
          team_id: uuid(),
          profile_id: f.viewer.id,
          is_leader: false,
        })
      }
    })

    const zeros = { memberships: 0, leaderships: 0, guests: 0 }
    const first = await t.query(internal.internal.guestTeams.check, { cursor: null, limit: 5_000 })
    expect(first).toMatchObject({ ...zeros, done: false })
    expect(
      await t.query(internal.internal.guestTeams.check, { cursor: first.cursor, limit: 5_000 }),
    ).toMatchObject({ ...zeros, done: true })
  })
})

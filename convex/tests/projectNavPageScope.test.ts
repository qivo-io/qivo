/* projectNav.page with `org_id`, one seat's list for Team sync's scope
 * menu, and with `team_id`, a team's own shares for its notes
 * (model/projectNavReads.ts navPageOf, navTeamOf): what each lists, the
 * empty answers alike for what the caller cannot ask about, the cursors
 * that never cross, and the reads at the design size, which the suite
 * logs. */

import { describe, expect, it } from 'vitest'
import { NAMED_READ } from '../lib/namedPages'
import { navPageOf, TEAM_WITHOUT_ORG } from '../model/projectNavReads'
import { NOW, newT, plantSeat, type T, withOrg } from './helpers.setup'
import {
  badRequest,
  mapOf,
  measured,
  names,
  ok,
  person,
  plantGrants,
  plantMetas,
  plantShares,
  plantSubs,
  plantTeam,
  ready,
  type Seats,
} from './projectNavFixtures.setup'

const g = globalThis as unknown as { process: { env: Record<string, string | undefined> } }
g.process.env.BETTER_AUTH_SECRET ??= 'project-nav-test-secret-not-a-deployment-key'

const page = (
  t: T,
  seats: Seats,
  a: { org_id?: string; team_id?: string; after?: string; through?: string } = {},
) => t.run((ctx) => navPageOf(ctx, mapOf(seats), a))

const EMPTY = { state: 'ok', rows: [], next: null, stopped: false }

/** Every row of a list from its start, following `next`. */
async function walk(t: T, seats: Seats, a: { org_id?: string; team_id?: string }) {
  const rows: { id: string; name: string; parent_id?: string | null }[] = []
  let after: string | undefined
  for (let round = 0; round < 60; round++) {
    const batch = ok(await page(t, seats, { ...a, after }))
    rows.push(...batch.rows)
    if (batch.next === null) return rows
    after = batch.next
  }
  throw new Error('the list did not end')
}

describe('projectNav.page with org_id', () => {
  it("lists one seat's projects, an organization without a seat nothing, and its cursors open for no other list", async () => {
    const t = newT()
    const f = await withOrg(t)
    const ann = await person(t, f.org.id, 'Ann')
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'Ann',
      auth_user_id: ann.auth_user_id,
    })
    const tops = await plantMetas(t, f.org.id, names('Home ', 26))
    await plantGrants(t, ann, tops)
    await plantGrants(t, elsewhere, [f.otherProject])
    await ready(t, f)
    const home = await walk(t, [ann, elsewhere], { org_id: f.org.id })
    expect(home).toHaveLength(26)
    expect(home.every((row) => tops.some((p) => p.id === row.id))).toBe(true)
    expect(await walk(t, [ann, elsewhere], { org_id: f.otherOrg.id })).toEqual([
      expect.objectContaining({ id: f.otherProject.id }),
    ])
    expect(await page(t, [ann], { org_id: f.otherOrg.id })).toEqual(EMPTY)
    // a cursor of one list opens for no other
    const all = ok(await page(t, [ann, elsewhere]))
    const one = ok(await page(t, [ann, elsewhere], { org_id: f.org.id }))
    expect(
      await badRequest(page(t, [ann, elsewhere], { org_id: f.org.id, after: all.next ?? '' })),
    ).toContain('projectNav.page')
    expect(await badRequest(page(t, [ann, elsewhere], { after: one.next ?? '' }))).toContain(
      'projectNav.page',
    )
  })
})

describe('projectNav.page with team_id', () => {
  it("lists the team's own shares the caller sees, for a caller in the team and one outside it, and never a parent a share only reaches", async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const bo = await person(t, f.org.id, 'Bo')
    const [whole, partial, hidden] = await plantMetas(t, f.org.id, ['Whole', 'Partial', 'Hidden'])
    await plantSubs(t, whole, ['Whole sub'])
    const [s1, s2] = await plantSubs(t, partial, ['Partial one', 'Partial two'])
    const red = await plantTeam(t, f.org.id, 'Red', [pia])
    await plantShares(t, red, [whole, s1, hidden])
    // Bo, outside the team, sees Whole, Partial two (so Partial for
    // navigation) and not Partial one or Hidden
    await plantGrants(t, bo, [whole, s2])
    await ready(t, f)
    const inTeam = await walk(t, [pia], { org_id: f.org.id, team_id: red })
    expect(inTeam.map((row) => [row.name, row.parent_id])).toEqual([
      ['Hidden', null],
      ['Partial one', partial.id],
      ['Whole', null],
    ])
    // Partial is never listed, as the team shares only one of its sub-projects
    const outside = await walk(t, [bo], { org_id: f.org.id, team_id: red })
    expect(outside.map((row) => row.name)).toEqual(['Whole'])
  })

  it('answers a team of another organization, an unknown team and an organization without a seat with nothing, and refuses team_id without org_id', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const abroad = await plantTeam(t, f.otherOrg.id, 'Abroad')
    const red = await plantTeam(t, f.org.id, 'Red', [pia])
    await plantShares(t, red, [f.meta])
    await ready(t, f)
    expect(await page(t, [pia], { org_id: f.org.id, team_id: abroad })).toEqual(EMPTY)
    expect(await page(t, [pia], { org_id: f.org.id, team_id: 'no-such-team' })).toEqual(EMPTY)
    expect(await page(t, [pia], { org_id: f.otherOrg.id, team_id: red })).toEqual(EMPTY)
    expect(await badRequest(page(t, [pia], { team_id: red }))).toBe(TEAM_WITHOUT_ORG)
    // its cursor opens for no other list
    const shares = await plantMetas(t, f.org.id, names('Share ', 26))
    await plantShares(t, red, shares)
    await ready(t, f)
    const first = ok(await page(t, [pia], { org_id: f.org.id, team_id: red }))
    expect(first.next).not.toBeNull()
    const cursor = first.next ?? ''
    expect(await badRequest(page(t, [pia], { org_id: f.org.id, after: cursor }))).toContain(
      'projectNav.page',
    )
    // nor for another team of the organization, nor for the same team id
    // under another organization where the caller has a seat
    const blue = await plantTeam(t, f.org.id, 'Blue', [pia])
    await plantShares(t, blue, shares)
    await ready(t, f)
    expect(
      await badRequest(page(t, [pia], { org_id: f.org.id, team_id: blue, after: cursor })),
    ).toContain('projectNav.page')
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'Pia',
      auth_user_id: pia.auth_user_id,
    })
    expect(
      await badRequest(
        page(t, [pia, elsewhere], { org_id: f.otherOrg.id, team_id: red, after: cursor }),
      ),
    ).toContain('projectNav.page')
    // the cursor still opens its own list, the last two of Red's 27 shares
    expect(
      ok(await page(t, [pia], { org_id: f.org.id, team_id: red, after: cursor })).rows,
    ).toHaveLength(2)
  })
})

describe('reads at the design size', () => {
  it('lists the 50 live projects one team shares beside its 150 archived shares, the first batch and the second', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const live = await plantMetas(t, f.org.id, names('Shared ', 50))
    const old = await plantMetas(t, f.org.id, names('Old shared ', 150), { archived_at: NOW })
    // the caller is in another team, at everyday values, and sees the shares
    // through grants of their own
    const red = await plantTeam(t, f.org.id, 'Red')
    await plantShares(t, red, [...live, ...old])
    await plantTeam(t, f.org.id, 'Blue', [pia])
    await plantGrants(t, pia, live)
    await ready(t, f)
    const seats = mapOf([pia])
    const first = await measured(t, (ctx) =>
      navPageOf(ctx, seats, { org_id: f.org.id, team_id: red }),
    )
    console.log('page with team_id, 50 live and 150 archived shares, first batch', first.read)
    const batch = ok(first.out)
    expect(batch.rows).toHaveLength(25)
    const second = await measured(t, (ctx) =>
      navPageOf(ctx, seats, { org_id: f.org.id, team_id: red, after: batch.next ?? '' }),
    )
    console.log('page with team_id, the same, second batch', second.read)
    expect(ok(second.out).rows).toHaveLength(25)
    for (const read of [first.read, second.read]) {
      expect(read.ranges).toBeLessThan(NAMED_READ.ranges)
      expect(read.documents).toBeLessThan(NAMED_READ.documents)
    }
  })

  it('lists 200 live top-level projects of the home organization beside a guest seat, the first batch and the eighth', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const ann = await person(t, f.org.id, 'Ann')
    const guest = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'Ann',
      org_role: 'guest',
      auth_user_id: ann.auth_user_id,
    })
    const tops = await plantMetas(t, f.org.id, names('Top ', 198))
    await plantMetas(t, f.org.id, names('Old top ', 300), { archived_at: NOW })
    await plantGrants(t, ann, [f.meta, f.hidden, ...tops])
    await plantGrants(t, guest, [f.otherProject])
    await ready(t, f)
    const seats = mapOf([ann, guest])
    let after: string | undefined
    let eighth: Awaited<ReturnType<typeof measured>> | null = null
    for (let n = 1; n <= 8; n++) {
      const call = await measured(t, (ctx) => navPageOf(ctx, seats, { org_id: f.org.id, after }))
      if (n === 1) console.log('page with org_id, 200 top-level projects, first batch', call.read)
      const batch = ok(call.out)
      expect(batch.rows.length, `batch ${n}`).toBe(25)
      after = batch.next ?? undefined
      if (n === 8) eighth = call
      expect(call.read.ranges).toBeLessThan(NAMED_READ.ranges)
    }
    console.log('page with org_id, the eighth batch', eighth?.read)
    expect(after).toBeUndefined()
  })
})

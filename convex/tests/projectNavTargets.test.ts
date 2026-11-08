/* projectNav.targets (model/projectNavReads.ts navTargetsOf), the live
 * sub-projects a person may add tasks to, and projectNav.holds
 * (navHoldsOf), whether they see any project and any sub-project: their
 * rules for every way a person reaches a sub-project, the order and
 * cursors, the search, readiness, the bounds that refuse or stop, and the
 * reads at the design size, one figure a case, under Convex's transaction
 * limits, which the suites log. */

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { ACCESS_UNCHECKED, OWN_READS } from '../lib/access'
import { NAMED_READ } from '../lib/namedPages'
import {
  type NavTargetRow,
  type NavTargets,
  navHoldsOf,
  navTargetsOf,
  PROJECT_NAV,
} from '../model/projectNavReads'
import { as, NOW, newT, plantSeat, type T, withOrg } from './helpers.setup'
import {
  badRequest,
  mapOf,
  measured,
  names,
  ok,
  page,
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

const DEFAULT_READ = { ...NAMED_READ }
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
const DEFAULT_NAV = structuredClone(PROJECT_NAV)
afterEach(() => {
  Object.assign(NAMED_READ, DEFAULT_READ)
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
  Object.assign(PROJECT_NAV, structuredClone(DEFAULT_NAV))
})

const LOGIN = 'auth_targets'

const targets = (
  t: T,
  seats: Seats,
  a: { org_id?: string; search?: string; after?: string; through?: string } = {},
) => t.run((ctx) => navTargetsOf(ctx, seats[0]?.auth_user_id ?? LOGIN, mapOf(seats), a))

const holds = (t: T, seats: Seats, a: { org_id?: string } = {}) =>
  t.run((ctx) => navHoldsOf(ctx, mapOf(seats), a))

/** Every batch of targets from the start, following `next`. */
async function walkTargets(
  t: T,
  seats: Seats,
  a: { org_id?: string; search?: string } = {},
): Promise<{ rows: NavTargetRow[]; batches: NavTargets[] }> {
  const rows: NavTargetRow[] = []
  const batches: NavTargets[] = []
  let after: string | undefined
  for (let round = 0; round < 60; round++) {
    const batch = ok(await targets(t, seats, { ...a, after }))
    batches.push(batch)
    rows.push(...batch.rows)
    if (batch.next === null) return { rows, batches }
    after = batch.next
  }
  throw new Error('the list did not end')
}

const names_ = (rows: readonly { name: string }[]) => rows.map((r) => r.name)

/* ------------------------------------------------------------ the targets */

describe('projectNav.targets', () => {
  it('lists the sub-projects a person may write in, through a grant, a team share or the parent, with their parents', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const vera = await person(t, f.org.id, 'Vera')
    const [alpha, beta, gamma] = await plantMetas(t, f.org.id, ['Alpha', 'Beta', 'Gamma'])
    const [a1, a2] = await plantSubs(t, alpha, ['A one', 'A two'])
    const [b1] = await plantSubs(t, beta, ['B one'])
    const [g1, g2] = await plantSubs(t, gamma, ['G one', 'G two'])
    await plantGrants(t, pia, [a1])
    await plantGrants(t, pia, [a2], 'viewer')
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia]), [b1])
    // she leads Gamma, and G two has a lead of its own
    await t.run(async (ctx) => {
      await ctx.db.patch(gamma._id, { lead_id: pia.id })
      await ctx.db.patch(g2._id, { lead_id: vera.id })
    })
    await ready(t, f)
    const { rows } = await walkTargets(t, [pia])
    expect(rows).toEqual([
      {
        id: a1.id,
        org_id: f.org.id,
        name: 'A one',
        num: a1.num,
        parent_id: alpha.id,
        parent_name: 'Alpha',
        parent_num: alpha.num,
      },
      expect.objectContaining({ id: b1.id, parent_id: beta.id }),
      expect.objectContaining({ id: g1.id, parent_id: gamma.id }),
      expect.objectContaining({ id: g2.id, parent_id: gamma.id }),
    ])
  })

  it('lists none for an organization Viewer, nor an archived sub-project or one under an archived parent', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [live, old] = await plantMetas(t, f.org.id, ['Live', 'Old'])
    const [kept, gone] = await plantSubs(t, live, ['Kept', 'Gone'])
    const [under] = await plantSubs(t, old, ['Under'])
    await plantGrants(t, pia, [kept, gone, under])
    await t.run(async (ctx) => {
      await ctx.db.patch(gone._id, { archived_at: NOW })
      await ctx.db.patch(old._id, { archived_at: NOW })
    })
    await ready(t, f)
    expect(names_((await walkTargets(t, [pia])).rows)).toEqual(['Kept'])
    // the fixture's Viewer holds User on TBED, which the role caps
    expect((await walkTargets(t, [f.viewer])).rows).toEqual([])
    expect(names_((await walkTargets(t, [f.guest])).rows)).toEqual(['Board rev', 'Firmware'])
  })

  it('lists one seat with org_id and every seat in one order without, and an org_id without a seat answers an empty end', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ann = await person(t, f.org.id, 'Ann')
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'Ann',
      auth_user_id: ann.auth_user_id,
    })
    const [other] = await plantSubs(t, f.otherProject, ['Abroad'])
    await plantGrants(t, ann, [f.sub])
    await plantGrants(t, elsewhere, [other])
    await ready(t, f)
    const both = await walkTargets(t, [ann, elsewhere])
    // Elsewhere sorts before Testbed platform
    expect(names_(both.rows)).toEqual(['Abroad', 'Firmware'])
    expect(names_((await walkTargets(t, [ann, elsewhere], { org_id: f.org.id })).rows)).toEqual([
      'Firmware',
    ])
    expect(await targets(t, [ann], { org_id: f.otherOrg.id })).toEqual({
      state: 'ok',
      rows: [],
      next: null,
      stopped: false,
    })
  })

  it('orders by the parent name, the parent id, the sub-project name and its id, and hands out every row once across batches', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    // two parents of one name, and 30 sub-projects in all
    const [p1, p2] = await plantMetas(t, f.org.id, ['Twin', 'Twin'])
    const subs = [
      ...(await plantSubs(t, p1, names('Sub ', 16))),
      ...(await plantSubs(t, p2, names('Sub ', 14))),
    ]
    await plantGrants(t, pia, [p1, p2])
    await ready(t, f)
    const walked = await walkTargets(t, [pia])
    expect(walked.batches).toHaveLength(2)
    expect(walked.rows).toHaveLength(30)
    const first = p1.id < p2.id ? p1 : p2
    expect(
      walked.rows.slice(0, first === p1 ? 16 : 14).every((r) => r.parent_id === first.id),
    ).toBe(true)
    expect(new Set(walked.rows.map((r) => r.id)).size).toBe(subs.length)
  })

  it("matches the sub-project's or the parent's name, and seals cursors with the organization, the search and the login", async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [alpha, beta] = await plantMetas(t, f.org.id, ['Alpha launch', 'Beta'])
    const alphaSubs = await plantSubs(t, alpha, names('Work ', 26))
    const [b1, b2] = await plantSubs(t, beta, ['Launch prep', 'Other'])
    await plantGrants(t, pia, [...alphaSubs, b1, b2])
    await ready(t, f)
    const found = await walkTargets(t, [pia], { search: 'launch' })
    expect(found.rows).toHaveLength(27)
    expect(found.rows.at(-1)?.id).toBe(b1.id)
    const first = ok(await targets(t, [pia]))
    expect(first.next).not.toBeNull()
    const cursor = first.next ?? ''
    expect(await badRequest(targets(t, [pia], { after: cursor, search: 'launch' }))).toContain(
      'projectNav.targets',
    )
    expect(await badRequest(targets(t, [pia], { after: cursor, org_id: f.org.id }))).toContain(
      'projectNav.targets',
    )
    const other = await person(t, f.org.id, 'Other')
    expect(await badRequest(targets(t, [other], { after: cursor }))).toContain('projectNav.targets')
  })

  it('answers not_ready without the reach rows, the refusal past the own reads, and stopped past the read share, never the end', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const parents = await plantMetas(t, f.org.id, names('Parent ', 6))
    const subs: Doc<'projects'>[] = []
    for (const p of parents) subs.push(...(await plantSubs(t, p, [`${p.name} sub`])))
    for (let i = 0; i < 3; i++)
      await plantShares(
        t,
        await plantTeam(t, f.org.id, `Team ${i}`, [pia]),
        subs.slice(i * 2, i * 2 + 2),
      )
    await ready(t, f)
    expect((await walkTargets(t, [pia])).rows).toHaveLength(6)
    Object.assign(OWN_READS, { teamReads: 0 })
    expect(await targets(t, [pia])).toMatchObject({
      state: 'unavailable',
      reason: ACCESS_UNCHECKED,
    })
    Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
    Object.assign(NAMED_READ, { ranges: 1 })
    const stopped = ok(await targets(t, [pia]))
    expect(stopped.stopped).toBe(true)
    expect(stopped.next).not.toBeNull()
    Object.assign(NAMED_READ, DEFAULT_READ)
    await t.run(async (ctx) => {
      const r = await ctx.db
        .query('org_ready')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique()
      if (r !== null) await ctx.db.patch(r._id, { nav_at: undefined })
    })
    expect(await targets(t, [pia])).toEqual({ state: 'not_ready' })
  })

  it('answers the signed-in login through the public query', async () => {
    const t = newT()
    const f = await withOrg(t)
    await ready(t, f)
    const answer = ok(await as(t, f.user).query(api.projectNav.targets, {}))
    expect(names_(answer.rows)).toEqual(['Board rev', 'Firmware'])
  })
})

/* --------------------------------------------------------------- the holds */

describe('projectNav.holds', () => {
  it('says whether a person sees a project and a sub-project, through every source, and never from a row alone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const nobody = await person(t, f.org.id, 'Nobody')
    const lead = await person(t, f.org.id, 'Lead')
    const granted = await person(t, f.org.id, 'Granted')
    const member = await person(t, f.org.id, 'Member')
    const archived = await person(t, f.org.id, 'Archived')
    const stale = await person(t, f.org.id, 'Stale')
    const [alone, shared, old] = await plantMetas(t, f.org.id, ['Alone', 'Shared', 'Old'])
    const [s1] = await plantSubs(t, shared, ['Shared sub'])
    const [o1] = await plantSubs(t, old, ['Old sub'], { archived_at: NOW })
    await t.run((ctx) => ctx.db.patch(alone._id, { lead_id: lead.id }))
    await plantGrants(t, granted, [f.meta])
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [member]), [s1])
    await plantGrants(t, archived, [o1])
    await plantGrants(t, stale, [shared])
    await ready(t, f)
    // the grant goes and the reach rows stay, as a stale row
    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', shared.id).eq('profile_id', stale.id),
        )
        .unique()
      if (grant !== null) await ctx.db.delete(grant._id)
    })
    const answer = (top: boolean, sub: boolean) => ({ state: 'ok', top, sub })
    expect(await holds(t, [nobody])).toEqual(answer(false, false))
    expect(await holds(t, [lead])).toEqual(answer(true, false))
    // a grant on a top-level project writes no child row for its sub-projects
    expect(await holds(t, [granted])).toEqual(answer(true, true))
    expect(await holds(t, [member])).toEqual(answer(true, true))
    expect(await holds(t, [archived])).toEqual(answer(false, false))
    expect(await holds(t, [stale])).toEqual(answer(false, false))
    // an org_id without a seat answers both false
    expect(await holds(t, [granted], { org_id: f.otherOrg.id })).toEqual(answer(false, false))
    expect(await holds(t, [granted], { org_id: f.org.id })).toEqual(answer(true, true))
  })

  it("judges each root row at its own place, so a stale row of the seat never hides its team's fresh row", async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [shared] = await plantMetas(t, f.org.id, ['Shared'])
    await plantGrants(t, pia, [shared])
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia]), [shared])
    await ready(t, f)
    // the seat's own root row keeps a name key from before a rename, which
    // a recompute has not caught up with yet
    await t.run(async (ctx) => {
      const own = await ctx.db
        .query('project_reach')
        .withIndex('by_project_grantee', (q) =>
          q.eq('project_id', shared.id).eq('grantee_kind', 'profile').eq('grantee_id', pia.id),
        )
        .unique()
      if (own === null) throw new Error("no root row of Pia's seat")
      await ctx.db.patch(own._id, { name_key: 'an older name' })
    })
    // the page lists the project from the team's row, and holds agrees
    expect(names_(ok(await page(t, [pia])).rows)).toEqual(['Shared'])
    expect(await holds(t, [pia])).toEqual({ state: 'ok', top: true, sub: false })
  })

  it('answers not_ready, the refusal and stopped apart from no project', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [shared] = await plantMetas(t, f.org.id, ['Shared'])
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia]), [shared])
    await ready(t, f)
    expect(await holds(t, [pia])).toEqual({ state: 'ok', top: true, sub: false })
    Object.assign(PROJECT_NAV, { teams: 0 })
    expect(await holds(t, [pia])).toMatchObject({ state: 'unavailable', reason: ACCESS_UNCHECKED })
    Object.assign(PROJECT_NAV, structuredClone(DEFAULT_NAV))
    Object.assign(NAMED_READ, { documents: 1 })
    expect(await holds(t, [pia])).toEqual({ state: 'stopped' })
    Object.assign(NAMED_READ, DEFAULT_READ)
    await t.run(async (ctx) => {
      const r = await ctx.db
        .query('org_ready')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique()
      if (r !== null) await ctx.db.patch(r._id, { nav_at: undefined })
    })
    expect(await holds(t, [pia])).toEqual({ state: 'not_ready' })
  })
})

/* ------------------------------------------------- reads at the design size */

describe('reads at the design size', () => {
  /** One call, measured, inside NAMED_READ. */
  async function call<R>(t: T, label: string, run: Parameters<typeof measured<R>>[1]) {
    const { out, read } = await measured(t, run)
    console.log(label, read)
    expect(read.ranges).toBeLessThan(NAMED_READ.ranges)
    expect(read.documents).toBeLessThan(NAMED_READ.documents)
    return out
  }

  it('lists 20 writable sub-projects among 200 the person reads, the first batch and the last', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const parents = await plantMetas(t, f.org.id, names('Parent ', 67))
    const subs: Doc<'projects'>[] = []
    for (const p of parents) subs.push(...(await plantSubs(t, p, names(`${p.name} sub `, 3))))
    const read = subs.slice(0, 200)
    // every tenth writable, spread over the walk
    await plantGrants(
      t,
      pia,
      read.filter((_, i) => i % 10 === 0),
    )
    await plantGrants(
      t,
      pia,
      read.filter((_, i) => i % 10 !== 0),
      'viewer',
    )
    await ready(t, f)
    const seats = mapOf([pia])
    const first = ok(
      await call(t, 'targets, 20 writable of 200 readable, first batch', (ctx) =>
        navTargetsOf(ctx, LOGIN, seats, {}),
      ),
    )
    expect(first.rows).toHaveLength(20)
    expect(first.next).toBeNull()
    expect(first.stopped).toBe(false)
  })

  it('lists 30 live sub-projects beside 40 archived ones under one project the person edits, in two batches', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [project] = await plantMetas(t, f.org.id, ['Project'])
    await plantSubs(t, project, names('Live ', 30))
    await plantSubs(t, project, names('Old ', 40), { archived_at: NOW })
    await plantGrants(t, pia, [project])
    await ready(t, f)
    const seats = mapOf([pia])
    const first = ok(
      await call(t, 'targets, 30 live and 40 archived under one project, first batch', (ctx) =>
        navTargetsOf(ctx, LOGIN, seats, {}),
      ),
    )
    expect(first.rows).toHaveLength(25)
    const second = ok(
      await call(t, 'targets, the same, second batch', (ctx) =>
        navTargetsOf(ctx, LOGIN, seats, { after: first.next ?? '' }),
      ),
    )
    expect(second.rows).toHaveLength(5)
    expect(second.next).toBeNull()
  })

  it('lists the 100 sub-projects 5 teams of a member share with Edit, the first batch', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const parents = await plantMetas(t, f.org.id, names('Parent ', 34))
    const subs: Doc<'projects'>[] = []
    for (const p of parents) subs.push(...(await plantSubs(t, p, names(`${p.name} sub `, 3))))
    for (let i = 0; i < 5; i++)
      await plantShares(
        t,
        await plantTeam(t, f.org.id, `Team ${i}`, [pia]),
        subs.slice(i * 20, i * 20 + 20),
      )
    await ready(t, f)
    const seats = mapOf([pia])
    const first = ok(
      await call(t, 'targets, 5 teams sharing 20 sub-projects each, first batch', (ctx) =>
        navTargetsOf(ctx, LOGIN, seats, {}),
      ),
    )
    expect(first.rows).toHaveLength(25)
    expect(first.stopped).toBe(false)
  })

  it("lists the sub-projects of 50 live projects one of the person's teams shares beside its 150 archived ones", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const live = await plantMetas(t, f.org.id, names('Shared ', 50))
    for (const p of live) await plantSubs(t, p, names(`${p.name} sub `, 3))
    const old = await plantMetas(t, f.org.id, names('Old shared ', 150), { archived_at: NOW })
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia]), [...live, ...old])
    await ready(t, f)
    const seats = mapOf([pia])
    const first = ok(
      await call(
        t,
        'targets, a team sharing 50 live and 150 archived projects, first batch',
        (ctx) => navTargetsOf(ctx, LOGIN, seats, {}),
      ),
    )
    expect(first.rows).toHaveLength(25)
  })

  it('lists sub-projects each shared with 5 teams, the person in 3 teams reaching each through one', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const parents = await plantMetas(t, f.org.id, names('Parent ', 10))
    const subs: Doc<'projects'>[] = []
    for (const p of parents) subs.push(...(await plantSubs(t, p, names(`${p.name} sub `, 3))))
    const mine = [0, 1, 2].map((i) => plantTeam(t, f.org.id, `Mine ${i}`, [pia]))
    const teams = await Promise.all(mine)
    for (let i = 0; i < 3; i++)
      await plantShares(
        t,
        teams[i],
        subs.filter((_, n) => n % 3 === i),
      )
    for (let i = 0; i < 4; i++)
      await plantShares(t, await plantTeam(t, f.org.id, `Other ${i}`), subs)
    await ready(t, f)
    const seats = mapOf([pia])
    const first = ok(
      await call(t, 'targets, sub-projects shared with 5 teams each, first batch', (ctx) =>
        navTargetsOf(ctx, LOGIN, seats, {}),
      ),
    )
    expect(first.rows).toHaveLength(25)
    const answer = await call(t, 'holds, sub-projects shared with 5 teams each', (ctx) =>
      navHoldsOf(ctx, seats, {}),
    )
    expect(answer).toEqual({ state: 'ok', top: true, sub: true })
  })

  it('lists the first batch beside 200 top-level projects with grants, 66 of them with 3 sub-projects', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const tops = await plantMetas(t, f.org.id, names('Top ', 198))
    // 198 sub-projects beside the fixture's two under its own project, so
    // the person reads 200, the design size
    for (const p of tops.slice(0, 66)) await plantSubs(t, p, names(`${p.name} sub `, 3))
    await plantGrants(t, pia, [f.meta, f.hidden, ...tops])
    await ready(t, f)
    const seats = mapOf([pia])
    const first = ok(
      await call(t, 'targets, 200 top-level projects with grants, first batch', (ctx) =>
        navTargetsOf(ctx, LOGIN, seats, {}),
      ),
    )
    expect(first.rows).toHaveLength(25)
  })

  it('walks 200 live top-level projects with no sub-project for holds, whose sub is false', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const tops = await plantMetas(t, f.org.id, names('Top ', 198))
    await plantGrants(t, pia, [f.hidden, ...tops])
    await ready(t, f)
    const answer = await call(t, 'holds, 200 top-level projects without sub-projects', (ctx) =>
      navHoldsOf(ctx, mapOf([pia]), {}),
    )
    expect(answer).toEqual({ state: 'ok', top: true, sub: false })
  })

  it('answers no project for 167 live parents seen only through 500 archived sub-projects', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const parents = await plantMetas(t, f.org.id, names('Parent ', 167))
    const subs: Doc<'projects'>[] = []
    for (const p of parents)
      subs.push(...(await plantSubs(t, p, names(`${p.name} sub `, 3), { archived_at: NOW })))
    await plantGrants(t, pia, subs.slice(0, 500))
    await ready(t, f)
    const answer = await call(t, 'holds, 500 archived sub-projects under 167 live parents', (ctx) =>
      navHoldsOf(ctx, mapOf([pia]), {}),
    )
    expect(answer).toEqual({ state: 'ok', top: false, sub: false })
  })

  it('answers no project for a member of 5 teams whose shares are all archived sub-projects', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const parents = await plantMetas(t, f.org.id, names('Parent ', 34))
    const subs: Doc<'projects'>[] = []
    for (const p of parents)
      subs.push(...(await plantSubs(t, p, names(`${p.name} sub `, 3), { archived_at: NOW })))
    for (let i = 0; i < 5; i++)
      await plantShares(
        t,
        await plantTeam(t, f.org.id, `Team ${i}`, [pia]),
        subs.slice(i * 20, i * 20 + 20),
      )
    await ready(t, f)
    const answer = await call(t, 'holds, 5 teams sharing only archived sub-projects', (ctx) =>
      navHoldsOf(ctx, mapOf([pia]), {}),
    )
    expect(answer).toEqual({ state: 'ok', top: false, sub: false })
  })
})

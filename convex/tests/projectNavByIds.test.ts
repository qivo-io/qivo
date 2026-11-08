/* projectNav.byIds (model/projectNavReads.ts navByIdsOf): its arguments
 * and the refusal before any project is read; every access shape it
 * answers, with the caller's level, each sub-project's parent and the
 * projects it leaves out alike; the ids a stopped check lists apart; what a
 * change of access, a rename and a task write do to its answer; and the
 * reads of one call of 100 ids at the design size, one figure a case, under
 * Convex's transaction limits, which the last suite logs. */

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { ACCESS_UNCHECKED, accessOf, accessUnchecked, OWN_READS } from '../lib/access'
import { newWindowKey } from '../lib/db'
import { BY_IDS_MAX } from '../lib/limits'
import { NAMED_READ } from '../lib/namedPages'
import { insertTask } from '../model/descriptions'
import { BY_IDS_LIMIT, type NavByIds, navByIdsOf, PROJECT_NAV } from '../model/projectNavReads'
import { as, NOW, newT, plantSeat, type T, uuid, withOrg } from './helpers.setup'
import {
  badRequest,
  mapOf,
  measured,
  names,
  person,
  plantGrants,
  plantMetas,
  plantShares,
  plantSubs,
  plantTeam,
  ready,
  row,
  type Seats,
} from './projectNavFixtures.setup'

const DEFAULT_READ = { ...NAMED_READ }
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
const DEFAULT_NAV = structuredClone(PROJECT_NAV)
afterEach(() => {
  Object.assign(NAMED_READ, DEFAULT_READ)
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
  Object.assign(PROJECT_NAV, structuredClone(DEFAULT_NAV))
})

const byIds = (t: T, seats: Seats, ids: readonly string[]) =>
  t.run((ctx) => navByIdsOf(ctx, mapOf(seats), ids))

/** `p` as a byIds row with level `level`. */
const byIdRow = (p: Doc<'projects'>, level: string, reviewHours = 2) => ({
  ...row(p),
  parent_id: p.parent_id ?? null,
  level,
  track_delay: p.track_delay,
  lead_id: p.lead_id ?? null,
  review_hours: reviewHours,
})

/** The rows of `answer` by id, for answers whose order does not matter. */
const rowsById = (answer: NavByIds) => Object.fromEntries(answer.rows.map((r) => [r.id, r.level]))

const NOTHING: NavByIds = { rows: [], unchecked: [], message: null }

/* ----------------------------------------------------------- the arguments */

describe('arguments', () => {
  it('refuses 101 ids, repeats included, before it reads any project, and answers 100', async () => {
    const t = newT()
    const f = await withOrg(t)
    await ready(t, f)
    const seats = mapOf([f.user])
    const repeats = Array.from({ length: BY_IDS_MAX + 1 }, () => f.meta.id)
    const refused = await t.run(async (ctx) => {
      const message = await badRequest(navByIdsOf(ctx, seats, repeats))
      const m = await ctx.meta.getTransactionMetrics()
      return { message, ranges: m.databaseQueries.used, documents: m.documentsRead.used }
    })
    expect(refused).toEqual({ message: BY_IDS_LIMIT, ranges: 0, documents: 0 })
    // the same ids one fewer answer, the repeats once
    const answer = await byIds(t, [f.user], repeats.slice(1))
    expect(answer).toEqual({ rows: [byIdRow(f.meta, 'lead')], unchecked: [], message: null })
  })

  it('answers an empty list with nothing, and a login without a seat with nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    await ready(t, f)
    expect(await byIds(t, [f.user], [])).toEqual(NOTHING)
    expect(await byIds(t, [], [f.meta.id, f.sub.id])).toEqual(NOTHING)
  })
})

/* -------------------------------------------------------------- the access */

describe('access', () => {
  it("answers a sub-project read through a grant with its parent as a row of its own, the parent's level its own", async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    await plantGrants(t, pia, [f.sub])
    await ready(t, f)
    expect(await byIds(t, [pia], [f.sub.id])).toEqual({
      rows: [byIdRow(f.sub, 'user'), byIdRow(f.meta, 'viewer')],
      unchecked: [],
      message: null,
    })
    // the sub-project she cannot see is left out, and asking for the parent
    // first answers alike
    const both = await byIds(t, [pia], [f.meta.id, f.sub2.id, f.sub.id])
    expect(rowsById(both)).toEqual({ [f.meta.id]: 'viewer', [f.sub.id]: 'user' })
    expect(both.unchecked).toEqual([])
  })

  it('answers the same ids in either order alike', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    await plantGrants(t, pia, [f.sub])
    await ready(t, f)
    const ids = [f.meta.id, f.sub.id, f.hidden.id, f.sub2.id]
    const sorted = (a: NavByIds) => [...a.rows].sort((x, y) => x.id.localeCompare(y.id))
    const forward = await byIds(t, [pia], ids)
    const backward = await byIds(t, [pia], [...ids].reverse())
    expect(sorted(backward)).toEqual(sorted(forward))
    expect(forward.rows).toHaveLength(2)
  })

  it('answers the lead of a top-level project lead, a parent lead User on a sub-project with a lead of its own, and Lead on one without', async () => {
    const t = newT()
    const f = await withOrg(t)
    const vera = await person(t, f.org.id, 'Vera')
    const [led] = await plantSubs(t, f.meta, ['Led apart'], { lead_id: vera.id })
    await ready(t, f)
    const answer = await byIds(t, [f.user], [f.meta.id, f.sub.id, led.id])
    expect(rowsById(answer)).toEqual({ [f.meta.id]: 'lead', [f.sub.id]: 'lead', [led.id]: 'user' })
  })

  it("caps an organization Viewer's grant at viewer, answers a team share's level, and gives an admin with no rows nothing", async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [shared] = await plantMetas(t, f.org.id, ['Shared'])
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia]), [shared])
    await ready(t, f)
    expect(rowsById(await byIds(t, [f.viewer], [f.meta.id]))).toEqual({ [f.meta.id]: 'viewer' })
    expect(rowsById(await byIds(t, [pia], [shared.id]))).toEqual({ [shared.id]: 'user' })
    // since the admin access split admin status alone gives no level
    expect(
      await byIds(t, [f.admin], [f.meta.id, f.sub.id, f.hidden.id, shared.id, f.otherProject.id]),
    ).toEqual(NOTHING)
  })

  it('leaves out alike an archived project, one under an archived parent, one in Deleted items, an unknown id and one of an organization without the seat', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [archived] = await plantMetas(t, f.org.id, ['Archived'], { archived_at: NOW })
    const [oldParent] = await plantMetas(t, f.org.id, ['Old parent'], {
      archived_at: NOW,
      lead_id: f.user.id,
    })
    const [under] = await plantSubs(t, oldParent, ['Under it'])
    const [gone] = await plantMetas(t, f.org.id, ['Gone'], { lead_id: f.user.id })
    await plantGrants(t, f.user, [archived, under])
    await ready(t, f)
    // a project in Deleted items leaves the projects table
    await t.run((ctx) => ctx.db.delete(gone._id))
    const left = [archived.id, under.id, gone.id, uuid(), f.otherProject.id]
    expect(await byIds(t, [f.user], left)).toEqual(NOTHING)
    expect(await byIds(t, [f.user], [...left, f.meta.id])).toEqual({
      rows: [byIdRow(f.meta, 'lead')],
      unchecked: [],
      message: null,
    })
  })

  it('leaves out a top-level project seen only through an archived sub-project, which lib/access.ts shows', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    await plantGrants(t, pia, [f.sub])
    await t.run((ctx) => ctx.db.patch(f.sub._id, { archived_at: NOW }))
    await ready(t, f)
    expect(await t.run((ctx) => accessOf(ctx, pia).visible(f.meta.id))).toBe(true)
    expect(await byIds(t, [pia], [f.meta.id, f.sub.id])).toEqual(NOTHING)
  })

  it("judges each project with the login's seat in its own organization", async () => {
    const t = newT()
    const f = await withOrg(t)
    const ann = await person(t, f.org.id, 'Ann')
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'Ann',
      auth_user_id: ann.auth_user_id,
    })
    await plantGrants(t, ann, [f.meta])
    await plantGrants(t, elsewhere, [f.otherProject], 'viewer')
    await ready(t, f)
    const answer = await byIds(t, [ann, elsewhere], [f.otherProject.id, f.sub.id])
    expect(rowsById(answer)).toEqual({
      [f.otherProject.id]: 'viewer',
      [f.sub.id]: 'user',
      [f.meta.id]: 'user',
    })
    // a grant of one seat says nothing of the other organization's projects
    expect(await byIds(t, [ann], [f.otherProject.id])).toEqual(NOTHING)
    expect(await byIds(t, [elsewhere], [f.meta.id, f.sub.id])).toEqual(NOTHING)
  })

  it('answers the signed-in login through the public query, leaving out an inactive seat', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ann = await person(t, f.org.id, 'Ann')
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'Ann',
      auth_user_id: ann.auth_user_id,
    })
    await plantGrants(t, ann, [f.meta])
    await plantGrants(t, elsewhere, [f.otherProject])
    await ready(t, f)
    const caller = as(t, ann)
    const ids = [f.meta.id, f.otherProject.id]
    expect(rowsById(await caller.query(api.projectNav.byIds, { ids }))).toEqual({
      [f.meta.id]: 'user',
      [f.otherProject.id]: 'user',
    })
    await t.run((ctx) => ctx.db.patch(elsewhere._id, { active: false }))
    expect(rowsById(await caller.query(api.projectNav.byIds, { ids }))).toEqual({
      [f.meta.id]: 'user',
    })
  })
})

/* ---------------------------------------------------------------- apart */

describe('checks a bound stopped', () => {
  it('lists the ids past the room for single-row reads apart, with the sentence, and answers the first', async () => {
    /* Parents shown only through sub-projects 5 of Pia's teams share, whose
     * checks spend the room for single-row reads (OWN_READS.teamReads)
     * across the call, as the page's first batch does. */
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const parents = await plantMetas(t, f.org.id, names('Parent ', 10))
    const subs: Doc<'projects'>[] = []
    for (const p of parents) subs.push(...(await plantSubs(t, p, [`${p.name} sub`])))
    for (let i = 0; i < 5; i++)
      await plantShares(
        t,
        await plantTeam(t, f.org.id, `Team ${i}`, [pia]),
        subs.slice(i * 2, i * 2 + 2),
      )
    await ready(t, f)
    const ids = parents.map((p) => p.id)
    expect((await byIds(t, [pia], ids)).rows).toHaveLength(10)
    // the room lowered until the call runs out partway: the ids before
    // answer and the rest are apart, never left out
    let answer: NavByIds = NOTHING
    for (let room = 0; room < 64; room++) {
      Object.assign(OWN_READS, { teamReads: room })
      answer = await byIds(t, [pia], ids)
      expect(answer.rows.length + answer.unchecked.length).toBe(10)
      if (answer.rows.length > 0) break
    }
    expect(answer.rows.length).toBeGreaterThan(0)
    expect(answer.unchecked.length).toBeGreaterThan(0)
    expect(answer.rows.map((r) => r.id)).toEqual(ids.slice(0, answer.rows.length))
    expect(answer.unchecked).toEqual(ids.slice(answer.rows.length))
    expect(answer.message).toBe(accessUnchecked().data.message)
  })

  it('lists a parent shown only through more child rows than PROJECT_NAV.children apart', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a Viewer leading two sub-projects, which show nothing, before the one
    // they hold a grant on
    const vic = await person(t, f.org.id, 'Vic', { org_role: 'viewer' })
    const [parent] = await plantMetas(t, f.org.id, ['Parent'])
    const subs = await plantSubs(t, parent, ['A led', 'B led', 'C granted'])
    await t.run(async (ctx) => {
      await ctx.db.patch(subs[0]._id, { lead_id: vic.id })
      await ctx.db.patch(subs[1]._id, { lead_id: vic.id })
    })
    await plantGrants(t, vic, [subs[2]], 'viewer')
    await ready(t, f)
    expect(rowsById(await byIds(t, [vic], [parent.id]))).toEqual({ [parent.id]: 'viewer' })
    Object.assign(PROJECT_NAV, { children: 2 })
    expect(await byIds(t, [vic], [parent.id])).toEqual({
      rows: [],
      unchecked: [parent.id],
      message: accessUnchecked().data.message,
    })
    // asked with the sub-project it shows, the parent is a row, which wins
    const both = await byIds(t, [vic], [parent.id, subs[2].id])
    expect(rowsById(both)).toEqual({ [parent.id]: 'viewer', [subs[2].id]: 'viewer' })
    expect(both.unchecked).toEqual([])
  })

  it('lists a navigation-only parent apart while the reach rows are not complete, and still answers a project the person leads', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    await plantGrants(t, pia, [f.sub])
    await ready(t, f)
    await t.run(async (ctx) => {
      const r = await ctx.db
        .query('org_ready')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique()
      if (r !== null) await ctx.db.patch(r._id, { nav_at: undefined })
    })
    expect(await byIds(t, [pia], [f.meta.id])).toEqual({
      rows: [],
      unchecked: [f.meta.id],
      message: accessUnchecked().data.message,
    })
    expect(rowsById(await byIds(t, [pia], [f.meta.id, f.sub.id]))).toEqual({
      [f.meta.id]: 'viewer',
      [f.sub.id]: 'user',
    })
    expect(await byIds(t, [f.user], [f.meta.id])).toEqual({
      rows: [byIdRow(f.meta, 'lead')],
      unchecked: [],
      message: null,
    })
  })

  it('lists every id past the read share apart, never answering it as left out', async () => {
    const t = newT()
    const f = await withOrg(t)
    await ready(t, f)
    Object.assign(NAMED_READ, { ranges: 1 })
    const answer = await byIds(t, [f.user], [f.meta.id, f.hidden.id])
    expect(answer.rows).toEqual([])
    expect(answer.unchecked).toEqual([f.meta.id, f.hidden.id])
    expect(answer.message).toBe(accessUnchecked().data.message)
  })

  it('names only asked ids apart where the check of a parent a sub-project brings stopped', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    await plantGrants(t, pia, [f.sub])
    await ready(t, f)
    // room for the sub-project's own check and no more
    const first = await t.run(async (ctx) => {
      await navByIdsOf(ctx, mapOf([pia]), [f.sub.id])
      return (await ctx.meta.getTransactionMetrics()).databaseQueries.used
    })
    let seen = false
    for (let ranges = 1; ranges < first && !seen; ranges++) {
      Object.assign(NAMED_READ, { ranges })
      const answer = await byIds(t, [pia], [f.sub.id])
      expect(answer.unchecked.every((id) => id === f.sub.id)).toBe(true)
      if (answer.unchecked.length > 0) {
        expect(answer.rows).toEqual([])
        seen = true
      } else expect(answer.rows).toHaveLength(2)
    }
    expect(seen).toBe(true)
    expect(ACCESS_UNCHECKED).toBe('access_unchecked')
  })
})

/* ------------------------------------------------------------------ live */

describe('the answer as a live read', () => {
  it('follows a grant removed and a rename, and stays the same through a task write', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    await plantGrants(t, pia, [f.sub])
    await ready(t, f)
    const before = await byIds(t, [pia], [f.sub.id])
    await t.run((ctx) =>
      insertTask(
        ctx.db,
        {
          id: uuid(),
          org_id: f.org.id,
          project_id: f.sub.id,
          num: 900,
          title: 'A task',
          description: '',
          status: 'todo',
          priority: 'medium',
          paused: false,
          created_at: NOW,
          updated_at: NOW,
          window_key: newWindowKey(),
        },
        'restore',
      ),
    )
    expect(await byIds(t, [pia], [f.sub.id])).toEqual(before)
    await as(t, f.user).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.sub.id,
      patch: { name: 'Firmware two' },
    })
    expect((await byIds(t, [pia], [f.sub.id])).rows[0]).toMatchObject({ name: 'Firmware two' })
    // the grant goes (the removal window's write is held to its own tests)
    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.sub.id).eq('profile_id', pia.id),
        )
        .unique()
      if (grant !== null) await ctx.db.delete(grant._id)
    })
    expect(await byIds(t, [pia], [f.sub.id])).toEqual(NOTHING)
  })

  it('reads the same for a project with no tasks and with 800 open tasks', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const subs = [f.sub, f.sub2, ...(await plantSubs(t, f.meta, ['Layout']))]
    await plantGrants(t, pia, [f.meta])
    await ready(t, f)
    const seats = mapOf([pia])
    const ids = subs.map((s) => s.id)
    const reads = async () => await measured(t, (ctx) => navByIdsOf(ctx, seats, ids))
    const before = await reads()
    for (let from = 0; from < 800; from += 200)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 200; i++)
          await insertTask(
            ctx.db,
            {
              id: uuid(),
              org_id: f.org.id,
              project_id: subs[i % 3].id,
              num: 10_000 + i,
              title: `Task ${i}`,
              description: '',
              status: 'todo',
              priority: 'medium',
              paused: false,
              created_at: NOW,
              updated_at: NOW,
              window_key: newWindowKey(),
            },
            'restore',
          )
      })
    expect(await reads()).toEqual(before)
  })
})

/* ------------------------------------------------- reads at the design size */

describe('reads at the design size', () => {
  /** One call of `ids` for `seat`, measured, answered whole. */
  async function call(t: T, seat: Doc<'profiles'>, ids: readonly string[], label: string) {
    const { out, read } = await measured(t, (ctx) => navByIdsOf(ctx, mapOf([seat]), ids))
    console.log(`byIds, ${label}`, read)
    expect(out.unchecked).toEqual([])
    expect(read.ranges).toBeLessThan(NAMED_READ.ranges)
    expect(read.documents).toBeLessThan(NAMED_READ.documents)
    return { out, read }
  }

  /** Pia reading 200 live sub-projects through grants under 67 parents. */
  async function subProjects() {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const parents = await plantMetas(t, f.org.id, names('Parent ', 67))
    const subs: Doc<'projects'>[] = []
    for (const p of parents) subs.push(...(await plantSubs(t, p, names(`${p.name} sub `, 3))))
    const read = subs.slice(0, 200)
    await plantGrants(t, pia, read)
    await ready(t, f)
    return { t, f, pia, parents, read }
  }

  it('answers 100 of 200 sub-projects read through grants under 67 parents, with those parents', async () => {
    const { t, pia, read } = await subProjects()
    const { out } = await call(
      t,
      pia,
      read.slice(0, 100).map((p) => p.id),
      '100 of 200 sub-projects',
    )
    // 100 sub-projects under the first 34 parents
    expect(out.rows).toHaveLength(134)
  })

  it('answers the 67 navigation-only parents of the same 200 sub-projects with 33 of them', async () => {
    const { t, pia, parents, read } = await subProjects()
    const ids = [...parents.map((p) => p.id), ...read.slice(0, 33).map((p) => p.id)]
    const { out } = await call(t, pia, ids, '67 navigation-only parents and 33 sub-projects')
    expect(out.rows).toHaveLength(100)
    expect(out.rows.filter((r) => r.level === 'viewer')).toHaveLength(67)
  })

  it('answers 100 of 200 top-level projects with grants', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const tops = await plantMetas(t, f.org.id, names('Live project ', 198))
    await plantGrants(t, pia, [f.meta, f.hidden, ...tops])
    await ready(t, f)
    const { out } = await call(
      t,
      pia,
      tops.slice(0, 100).map((p) => p.id),
      '100 of 200 top-level projects',
    )
    expect(out.rows).toHaveLength(100)
  })

  it('answers the 100 sub-projects 5 teams of a member share, with their parents', async () => {
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
    const { out } = await call(
      t,
      pia,
      subs.slice(0, 100).map((p) => p.id),
      '5 teams sharing 20 sub-projects each',
    )
    expect(out.rows).toHaveLength(134)
  })

  it('answers 100 projects each shared with 5 teams, the person in 3 teams reaching each through one', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const shared = await plantMetas(t, f.org.id, names('Shared ', 100))
    const mine = [
      await plantTeam(t, f.org.id, 'Mine 0', [pia]),
      await plantTeam(t, f.org.id, 'Mine 1', [pia]),
      await plantTeam(t, f.org.id, 'Mine 2', [pia]),
    ]
    const others = [
      await plantTeam(t, f.org.id, 'Other 0'),
      await plantTeam(t, f.org.id, 'Other 1'),
      await plantTeam(t, f.org.id, 'Other 2'),
      await plantTeam(t, f.org.id, 'Other 3'),
    ]
    for (let i = 0; i < 3; i++)
      await plantShares(
        t,
        mine[i],
        shared.filter((_, n) => n % 3 === i),
      )
    for (const team of others) await plantShares(t, team, shared)
    await ready(t, f)
    const { out } = await call(
      t,
      pia,
      shared.map((p) => p.id),
      '100 projects shared with 5 teams each',
    )
    expect(out.rows).toHaveLength(100)
  })

  it("answers 50 live projects one of the person's teams shares beside 50 of its 150 archived shares, which it leaves out", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const live = await plantMetas(t, f.org.id, names('Shared ', 50))
    const old = await plantMetas(t, f.org.id, names('Old shared ', 150), { archived_at: NOW })
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia]), [...live, ...old])
    await ready(t, f)
    const ids = [...live, ...old.slice(0, 50)].map((p) => p.id)
    const { out } = await call(t, pia, ids, '50 live and 50 archived team shares')
    expect(out.rows).toHaveLength(50)
  })

  it('leaves out 100 projects the person does not see, each with child reach rows of other people', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const bo = await person(t, f.org.id, 'Bo')
    const hidden = await plantMetas(t, f.org.id, names('Hidden ', 100))
    const subs: Doc<'projects'>[] = []
    for (const p of hidden) subs.push(...(await plantSubs(t, p, [`${p.name} sub`])))
    await plantGrants(t, bo, subs)
    await ready(t, f)
    const { out } = await call(
      t,
      pia,
      hidden.map((p) => p.id),
      '100 projects the person does not see',
    )
    expect(out.rows).toEqual([])
  })

  it('leaves out 100 of 167 live parents shown only through 500 archived sub-projects with grants', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const parents = await plantMetas(t, f.org.id, names('Parent ', 167))
    const subs: Doc<'projects'>[] = []
    for (const p of parents)
      subs.push(...(await plantSubs(t, p, names(`${p.name} sub `, 3), { archived_at: NOW })))
    await plantGrants(t, pia, subs.slice(0, 500))
    await ready(t, f)
    const parentsRead = await call(
      t,
      pia,
      parents.slice(0, 100).map((p) => p.id),
      '100 live parents shown only through archived sub-projects',
    )
    expect(parentsRead.out.rows).toEqual([])
    const subsRead = await call(
      t,
      pia,
      subs.slice(0, 100).map((p) => p.id),
      '100 archived sub-projects',
    )
    expect(subsRead.out.rows).toEqual([])
  })
})

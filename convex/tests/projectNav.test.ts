/* The project navigation reads (projectNav.ts page, children and resolve,
 * read by model/projectNavReads.ts): their arguments and cursors; every
 * access shape for a user, a guest and a Viewer, and an admin, held against
 * the rule worked out without reach rows (projectNav.setup.ts); the answers
 * alike for every project a person cannot open; reads that do not depend on
 * what the person cannot see; the favorites reader rule; the order across
 * groups and seats; continuation, `through` and the four-batch cap; the read
 * budgets and the bounds that refuse; readiness; and the reads at the design
 * size, one figure a case, under Convex's transaction limits, which the last
 * suite logs. */

import { compareValues } from 'convex/values'
import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { ACCESS_UNCHECKED, accessOf, OWN_READS, ordinaryOf, projectLevel } from '../lib/access'
import { newWindowKey } from '../lib/db'
import { LIST_BATCH } from '../lib/limits'
import {
  indexAfter,
  NAMED_READ,
  type NamedAt,
  namedCeiling,
  namedCursor,
  openNamedCursor,
  readBatch,
} from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { insertTask } from '../model/descriptions'
import {
  CHILDREN_LIST,
  FAVORITES,
  navChildrenOf,
  navPageOf,
  navResolveOf,
  PAGE_LIST,
  PROJECT_NAV,
  RESOLVE_FORM,
  REST,
  subProjectIndex,
} from '../model/projectNavReads'
import { SHAPES } from './accessShapes.setup'
import { as, NOW, newT, plantLogin, plantSeat, type T, uuid, withOrg } from './helpers.setup'
import { expectedChildren, expectedPage, navSees } from './projectNav.setup'
import {
  badRequest,
  kids,
  mapOf,
  measured,
  measuredWalk,
  names,
  now,
  ok,
  page,
  pageAt,
  person,
  plantGrants,
  plantMetas,
  plantShares,
  plantStar,
  plantSubs,
  plantTeam,
  type Read,
  ready,
  resolved,
  row,
  walk,
} from './projectNavFixtures.setup'

/* Cursors are sealed with a key derived from BETTER_AUTH_SECRET
 * (lib/archiveCursorSeal.ts). */
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

/* ----------------------------------------------------------- the arguments */

describe('arguments', () => {
  it('refuses a cursor that is malformed, of another list or another project, and a through not after after', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const tops = await plantMetas(t, f.org.id, names('Top ', 60))
    await plantGrants(t, pia, tops)
    const [parent, other] = await plantMetas(t, f.org.id, ['Parent', 'Other parent'])
    await plantSubs(t, parent, names('Sub ', 30))
    await plantSubs(t, other, names('Sub ', 30))
    await plantGrants(t, pia, [parent, other])
    await ready(t, f)
    const seats = [pia]
    const first = ok(await page(t, seats))
    const second = ok(await page(t, seats, { after: first.next ?? '' }))
    const child = ok(await kids(t, seats, parent.id))
    expect(first.next).not.toBeNull()
    expect(child.next).not.toBeNull()
    for (const bad of ['nope', '', 'ff'.repeat(40)]) {
      await badRequest(page(t, seats, { after: bad }))
      await badRequest(page(t, seats, { through: bad }))
      await badRequest(kids(t, seats, parent.id, { after: bad }))
    }
    // a children cursor to the page and the reverse
    await badRequest(page(t, seats, { after: child.next ?? '' }))
    await badRequest(kids(t, seats, parent.id, { after: first.next ?? '' }))
    // a children cursor of another project
    expect(await badRequest(kids(t, seats, other.id, { after: child.next ?? '' }))).toMatch(
      /same project/,
    )
    // a through at or before after
    for (const through of [first.next, second.next])
      await badRequest(page(t, seats, { after: second.next ?? '', through: through ?? '' }))
    // the cursors themselves open
    expect(second.next).not.toBeNull()
    expect(
      ok(await page(t, seats, { after: first.next ?? '', through: second.next ?? '' })).rows,
    ).toHaveLength(LIST_BATCH)
  })

  it('takes resolve by id alone or by organization and a whole number of at least 1, and refuses every other form before it reads', async () => {
    const t = newT()
    const f = await withOrg(t)
    await ready(t, f)
    const seats = [f.user]
    const org_id = f.org.id
    for (const a of [
      {},
      { project_id: f.meta.id, org_id, num: f.meta.num },
      { project_id: f.meta.id, org_id },
      { project_id: f.meta.id, num: f.meta.num },
      { org_id },
      { num: f.meta.num },
      { org_id, num: 0 },
      { org_id, num: 1.5 },
      { org_id, num: -1 },
      { org_id, num: Number.NaN },
    ])
      expect(await badRequest(resolved(t, seats, a))).toBe(RESOLVE_FORM)
    expect(await resolved(t, seats, { project_id: f.meta.id })).toMatchObject({ state: 'ok' })
    expect(await resolved(t, seats, { org_id, num: f.meta.num })).toMatchObject({ state: 'ok' })
  })
})

/* -------------------------------------------------------------- the access */

/** One access case: `shape` planted for a fresh seat of `role`, or the
 * fixture's admin without a shape, with a star on TBED and Skunkworks, and
 * every read held against the rule worked out without reach rows. Answers
 * how many projects the subject sees. */
async function compareShape(
  shape: (typeof SHAPES)[number] | null,
  role: 'user' | 'guest' | 'viewer' | 'admin',
): Promise<number> {
  const t = newT()
  const f = await withOrg(t)
  const subject =
    role === 'admin' ? f.admin : await person(t, f.org.id, 'Subject', { org_role: role })
  if (shape !== null) await t.run((ctx) => shape[1](ctx, f, subject))
  await ready(t, f)
  await plantStar(t, subject, await now(t, f.meta.id))
  await plantStar(t, subject, f.hidden)
  const label = `${role}, ${shape?.[0] ?? 'admin'}`
  const seats = [subject]
  const listed = (await walk((after) => page(t, seats, { after }))).rows
  const want = await expectedPage(t, seats)
  expect(listed, `${label}: page`).toEqual(want)
  for (const p of [f.meta, f.hidden, f.otherProject]) {
    const children = await expectedChildren(t, subject, p)
    if (children === null)
      expect(await kids(t, seats, p.id), `${label}: children of ${p.key}`).toEqual({
        state: 'unavailable',
      })
    else
      expect((await walk((after) => kids(t, seats, p.id, { after }))).rows, label).toEqual(children)
  }
  let seen = 0
  for (const id of [f.meta.id, f.sub.id, f.sub2.id, f.hidden.id, f.otherProject.id]) {
    const p = await now(t, id)
    const sees = await t.run((ctx) => navSees(ctx, subject, p))
    const answer = await resolved(t, seats, { project_id: id })
    const byNum = await resolved(t, seats, { org_id: p.org_id, num: p.num })
    expect(byNum, `${label}: ${p.key} by number`).toEqual(answer)
    if (!sees) {
      expect(answer, `${label}: resolve ${p.key}`).toEqual({ state: 'unavailable' })
      continue
    }
    seen++
    const parent = p.parent_id === undefined ? null : await now(t, p.parent_id)
    expect(answer, `${label}: resolve ${p.key}`).toEqual({
      state: 'ok',
      project: {
        ...row(p),
        parent: parent === null ? null : row(parent),
        favorite: parent === null ? (want.find((r) => r.id === p.id)?.favorite ?? null) : null,
      },
    })
  }
  return seen
}

describe('access', () => {
  for (const role of ['user', 'guest', 'viewer'] as const)
    it(`answers by the rule for a ${role} in every access shape`, async () => {
      let showing = 0
      for (const shape of SHAPES) if ((await compareShape(shape, role)) > 0) showing++
      // a guest takes no team shares, so fewer shapes show them anything
      expect(showing).toBeGreaterThan(SHAPES.length / 3)
    })

  it('lists and resolves nothing for an admin without grants, whom the admin rule gives every project', async () => {
    expect(await compareShape(null, 'admin')).toBe(0)
    const t = newT()
    const f = await withOrg(t)
    await ready(t, f)
    expect(await t.run((ctx) => projectLevel(ctx, f.admin, f.meta))).toBe('lead')
    expect(ok(await page(t, [f.admin])).rows).toEqual([])
    expect(await kids(t, [f.admin], f.meta.id)).toEqual({ state: 'unavailable' })
    expect(await resolved(t, [f.admin], { project_id: f.sub.id })).toEqual({ state: 'unavailable' })
    // a grant of their own lists it like anyone's
    await as(t, f.user).mutation(api.projects.setAccess, {
      org_id: f.org.id,
      id: f.hidden.id,
      user_id: f.admin.id,
      level: 'user',
    })
    expect(ok(await page(t, [f.admin])).rows).toEqual([{ ...row(f.hidden), favorite: false }])
  })

  it('lists only the sub-project a parent is shown for, never its others', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    await plantGrants(t, pia, [f.sub])
    await ready(t, f)
    expect(ok(await page(t, [pia])).rows).toEqual([{ ...row(f.meta), favorite: false }])
    expect(ok(await kids(t, [pia], f.meta.id)).rows).toEqual([
      { ...row(f.sub), parent_id: f.meta.id },
    ])
    expect(await resolved(t, [pia], { project_id: f.sub2.id })).toEqual({ state: 'unavailable' })
  })

  it('leaves out a project shown only through an archived sub-project, which lib/access.ts shows', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    await plantGrants(t, pia, [f.sub])
    await t.run((ctx) => ctx.db.patch(f.sub._id, { archived_at: NOW }))
    await ready(t, f)
    await plantStar(t, pia, f.meta)
    expect(await t.run((ctx) => accessOf(ctx, ordinaryOf(pia)).visible(f.meta.id))).toBe(true)
    expect(ok(await page(t, [pia])).rows).toEqual([])
    expect(await kids(t, [pia], f.meta.id)).toEqual({ state: 'unavailable' })
    expect(await resolved(t, [pia], { project_id: f.meta.id })).toEqual({ state: 'unavailable' })
    // a live sub-project of their own shows the parent again
    await as(t, f.user).mutation(api.projects.setAccess, {
      org_id: f.org.id,
      id: f.sub2.id,
      user_id: pia.id,
      level: 'viewer',
    })
    expect(ok(await page(t, [pia])).rows).toEqual([{ ...row(f.meta), favorite: true }])
  })

  it('shows nothing through the reach rows of a Viewer whose lead_id still names them', async () => {
    const t = newT()
    const f = await withOrg(t)
    const vic = await person(t, f.org.id, 'Vic', { org_role: 'viewer' })
    // a lead kept from before the rule that Viewers lead nothing
    await t.run((ctx) => ctx.db.patch(f.sub._id, { lead_id: vic.id }))
    await ready(t, f)
    const reach = await t.run((ctx) =>
      ctx.db
        .query('project_reach')
        .withIndex('by_grantee_list', (q) =>
          q.eq('grantee_kind', 'profile').eq('grantee_id', vic.id),
        )
        .collect(),
    )
    expect(reach.map((r) => r.kind).sort()).toEqual(['child', 'root'])
    expect(ok(await page(t, [vic])).rows).toEqual([])
    expect(await resolved(t, [vic], { project_id: f.meta.id })).toEqual({ state: 'unavailable' })
    expect(await resolved(t, [vic], { project_id: f.sub.id })).toEqual({ state: 'unavailable' })
  })
})

/* ------------------------------------------------------------------ alike */

describe('projects a person cannot open', () => {
  it('answer children and resolve alike, also by organization and number', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [archived] = await plantMetas(t, f.org.id, ['Shelved'], { archived_at: NOW })
    const [notMeta] = await plantMetas(t, f.org.id, ['Not a meta'], { type: 'project' })
    const [gone] = await plantMetas(t, f.org.id, ['Gone'])
    const [archivedParent] = await plantMetas(t, f.org.id, ['Old parent'], { archived_at: NOW })
    const [liveUnder] = await plantSubs(t, archivedParent, ['Live under an archived parent'])
    const [deep] = await plantSubs(t, f.sub, ['Under a sub-project'])
    // the person holds a grant on each, so only the project's own state hides it
    await plantGrants(t, pia, [archived, notMeta, gone, liveUnder, deep, f.meta])
    await ready(t, f)
    // a move to Deleted items takes the project out of the live table
    await t.run((ctx) => ctx.db.delete(gone._id))
    const seats = [pia]
    const hidden = [uuid(), f.otherProject.id, gone.id, archived.id, notMeta.id, f.hidden.id]
    for (const id of [...hidden, liveUnder.id, deep.id]) {
      expect(await kids(t, seats, id), id).toEqual({ state: 'unavailable' })
      expect(await resolved(t, seats, { project_id: id }), id).toEqual({ state: 'unavailable' })
    }
    for (const p of [archived, notMeta, f.hidden, liveUnder, deep])
      expect(await resolved(t, seats, { org_id: f.org.id, num: p.num })).toEqual({
        state: 'unavailable',
      })
    // a free number, and another organization's project by its number
    expect(await resolved(t, seats, { org_id: f.org.id, num: 999_999 })).toEqual({
      state: 'unavailable',
    })
    expect(await resolved(t, seats, { org_id: f.otherOrg.id, num: f.otherProject.num })).toEqual({
      state: 'unavailable',
    })
    // the control: the project they see
    expect(await resolved(t, seats, { org_id: f.org.id, num: f.meta.num })).toMatchObject({
      state: 'ok',
    })
  })

  it("read the same for a parent shown for navigation whatever its sub-projects the person cannot see, where reading the parent's sub-projects would not", async () => {
    /* One run: a parent shown only through the person's grants on three of
     * its sub-projects, beside `hidden` sub-projects named `prefix` they
     * cannot see. It reads children whole, then under a budget a few ranges
     * short of the whole read, and a stand-in that reads the parent's live
     * sub-projects under the same budget. The larger run holds 30 live
     * sub-projects under the parent, the design size. */
    const run = async (hidden: number, prefix: string, short?: number) => {
      const t = newT()
      const f = await withOrg(t)
      const pia = await person(t, f.org.id, 'Pia')
      const [parent] = await plantMetas(t, f.org.id, ['Parent'])
      const mine = await plantSubs(t, parent, ['Mine b', 'Mine d', 'Mine f'])
      await plantSubs(t, parent, names(prefix, hidden))
      await plantGrants(t, pia, mine)
      await ready(t, f)
      const read = () =>
        measured(t, (ctx) => navChildrenOf(ctx, mapOf([pia]), { project_id: parent.id }))
      const whole = await read()
      Object.assign(NAMED_READ, { ranges: short ?? whole.read.ranges - 4 })
      const low = await read()
      Object.assign(NAMED_READ, DEFAULT_READ)
      const standIn = await measured(t, async (ctx) => {
        const access = accessOf(ctx, ordinaryOf(pia))
        return await readBatch(ctx, {
          stream: indexAfter(subProjectIndex(ctx, parent), null),
          keep: async (p: Doc<'projects'>) => ((await access.visible(p.id)) ? p.name : null),
          limit: LIST_BATCH,
          through: null,
          ceiling: await namedCeiling(ctx),
        })
      })
      const seen = (answer: typeof whole) => {
        const batch = ok(answer.out)
        return {
          rows: batch.rows.map((r) => r.name),
          stopped: batch.stopped,
          end: batch.next === null,
          ranges: answer.read.ranges,
          documents: answer.read.documents,
        }
      }
      return {
        whole: seen(whole),
        low: seen(low),
        short: whole.read.ranges - 4,
        standIn: { rows: standIn.out.rows, ...standIn.read },
      }
    }
    const few = await run(2, 'Aaa ')
    const many = await run(27, 'Mine c ', few.short)
    expect(few.whole).toEqual(many.whole)
    expect(few.whole).toMatchObject({ rows: ['Mine b', 'Mine d', 'Mine f'], end: true })
    expect(few.low).toEqual(many.low)
    expect(few.low.stopped).toBe(true)
    // a reader of the parent's sub-projects reads what the person cannot see
    expect(few.standIn).not.toEqual(many.standIn)
  })

  it('read the same for a favorite whose project the seat lost, whatever shares it holds, where an access check of it would not', async () => {
    const run = async (shares: number, short?: number) => {
      const t = newT()
      const f = await withOrg(t)
      const pia = await person(t, f.org.id, 'Pia')
      const [lost] = await plantMetas(t, f.org.id, ['Aaa lost'])
      const seen = await plantMetas(t, f.org.id, names('Seen ', 30))
      await plantGrants(t, pia, seen)
      for (let i = 0; i < shares; i++)
        await plantShares(t, await plantTeam(t, f.org.id, `Team ${i}`), [lost])
      await ready(t, f)
      await plantStar(t, pia, lost)
      const read = () => measured(t, (ctx) => navPageOf(ctx, mapOf([pia]), {}))
      const whole = await read()
      Object.assign(NAMED_READ, { ranges: short ?? whole.read.ranges - 6 })
      const low = await read()
      Object.assign(NAMED_READ, DEFAULT_READ)
      const check = await measured(t, (ctx) => accessOf(ctx, ordinaryOf(pia)).visible(lost.id))
      const shape = (answer: typeof whole) => {
        const batch = ok(answer.out)
        return {
          rows: batch.rows.map((r) => [r.name, r.favorite]),
          stopped: batch.stopped,
          end: batch.next === null,
          ranges: answer.read.ranges,
          documents: answer.read.documents,
        }
      }
      return { whole: shape(whole), low: shape(low), short: whole.read.ranges - 6, check }
    }
    const none = await run(0)
    // 5 teams share the lost project, the design size of a project's shares
    const many = await run(5, none.short)
    expect(none.whole).toEqual(many.whole)
    expect(none.whole.rows).toHaveLength(LIST_BATCH)
    expect(none.whole.rows.every(([, favorite]) => favorite === false)).toBe(true)
    expect(none.low).toEqual(many.low)
    expect(none.low.stopped).toBe(true)
    // the access check the reach lookup spares reads the project's shares
    expect(none.check.out).toBe(false)
    expect(many.check.read.documents).toBeGreaterThan(none.check.read.documents + 4)
  })
})

/* -------------------------------------------------------------- favorites */

describe('favorites', () => {
  it('lists the favorites first in name order, then the rest, each project once, with favorite on every row', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const tops = await plantMetas(t, f.org.id, [
      'Delta',
      'alpha',
      'Charlie',
      'bravo',
      'Echo',
      'foxtrot',
    ])
    await plantGrants(t, pia, tops)
    await ready(t, f)
    await plantStar(t, pia, tops[4])
    await plantStar(t, pia, tops[3])
    const rows = ok(await page(t, [pia])).rows
    expect(rows.map((r) => [r.name, r.favorite])).toEqual([
      ['bravo', true],
      ['Echo', true],
      ['alpha', false],
      ['Charlie', false],
      ['Delta', false],
      ['foxtrot', false],
    ])
    expect(rows).toEqual(await expectedPage(t, [pia]))
  })

  it('moves a project between the groups in the next answer after a star and an unstar', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await plantLogin(t, await person(t, f.org.id, 'Pia'))
    const tops = await plantMetas(t, f.org.id, ['Ash', 'Birch', 'Cedar'])
    await plantGrants(t, pia, tops)
    await ready(t, f)
    const listed = async () => ok(await page(t, [pia])).rows.map((r) => [r.name, r.favorite])
    const star = (p: Doc<'projects'>, favorite: boolean) =>
      as(t, pia).mutation(api.projectNav.setFavorite, {
        org_id: f.org.id,
        project_id: p.id,
        favorite,
      })
    await star(tops[2], true)
    expect(await listed()).toEqual([
      ['Cedar', true],
      ['Ash', false],
      ['Birch', false],
    ])
    await star(tops[2], false)
    expect(await listed()).toEqual([
      ['Ash', false],
      ['Birch', false],
      ['Cedar', false],
    ])
  })

  it('shows no row that fails the reader rule, and keeps its project, where seen, in the rest', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [keptA, keptB, shelved, parent, gone] = await plantMetas(t, f.org.id, [
      'Kept A',
      'Kept B',
      'Shelved',
      'Parent P',
      'Gone G',
    ])
    const [sub] = await plantSubs(t, parent, ['Sub S'])
    await plantGrants(t, pia, [keptA, keptB, shelved, parent, gone])
    await t.run((ctx) => ctx.db.patch(shelved._id, { archived_at: NOW }))
    await ready(t, f)
    await t.run((ctx) => ctx.db.delete(gone._id))
    // copies that differ, another organization, an archived project (live
    // copy and archived copy), a sub-project, a project in Deleted items,
    // lost access and an id another organization's project now holds
    await plantStar(t, pia, keptA, { name_key: 'stale' })
    await plantStar(t, pia, keptB, { org_id: f.otherOrg.id })
    await plantStar(t, pia, shelved, { live: true })
    await plantStar(t, pia, shelved, { live: false })
    await plantStar(t, pia, sub)
    await plantStar(t, pia, gone)
    await plantStar(t, pia, f.hidden)
    await plantStar(t, pia, f.otherProject, { org_id: f.org.id })
    const rows = ok(await page(t, [pia])).rows
    expect(rows).toEqual([
      { ...row(keptA), favorite: false },
      { ...row(keptB), favorite: false },
      { ...row(parent), favorite: false },
    ])
    expect(rows).toEqual(await expectedPage(t, [pia]))
    expect(await resolved(t, [pia], { project_id: keptA.id })).toMatchObject({
      project: { favorite: false },
    })
  })

  it('keeps two seats of one login apart where a row another organization left meets a star on a reused id', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ann = await person(t, f.org.id, 'Ann')
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'Ann',
      auth_user_id: ann.auth_user_id,
    })
    await plantGrants(t, elsewhere, [f.otherProject])
    await ready(t, f)
    // Ann's seat in Testbed kept a row on an id the other organization's
    // project holds now, with its name key, beside her real star there
    await plantStar(t, elsewhere, f.otherProject)
    await plantStar(t, ann, f.otherProject, { org_id: f.org.id })
    const rows = ok(await page(t, [ann, elsewhere])).rows
    expect(rows).toEqual([{ ...row(f.otherProject), favorite: true }])
  })

  it('passes a run of rows that fail, a batch at a time, when the budget stops a batch at one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const lost = await plantMetas(t, f.org.id, names('Aaa lost ', 30))
    const starred = await plantMetas(t, f.org.id, names('Zzz star ', 5))
    const rest = await plantMetas(t, f.org.id, names('Rest ', 5))
    await plantGrants(t, pia, [...starred, ...rest])
    await ready(t, f)
    for (const p of [...lost, ...starred]) await plantStar(t, pia, p)
    Object.assign(NAMED_READ, { ranges: 14 })
    const { rows, batches } = await walk((after) => page(t, [pia], { after }))
    expect(rows.map((r) => [r.name, r.favorite])).toEqual([
      ...starred.map((p) => [p.name, true]),
      ...rest.map((p) => [p.name, false]),
    ])
    // a batch stopped inside the run with nothing to show, and the next
    // went on past it
    expect(batches.some((b) => b.stopped && b.rows.length === 0)).toBe(true)
    for (const b of batches) if (b.stopped) expect(b.next).not.toBeNull()
  })
})

/* --------------------------------------------------------------- the order */

describe('order', () => {
  it("follows the name key's UTF-8 bytes, where JavaScript's order of UTF-16 units differs, and the id for equal names", async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const face = 'a\u{1F600}'
    const privateUse = 'a\u{E000}'
    const tops = await plantMetas(t, f.org.id, [face, privateUse, 'Same', 'Same', 'Same'])
    await plantGrants(t, pia, tops)
    await ready(t, f)
    // JavaScript compares UTF-16 units and puts the face first
    expect([privateUse, face].sort()).toEqual([face, privateUse])
    const rows = ok(await page(t, [pia])).rows
    const same = tops.slice(2).map((p) => p.id)
    same.sort((a, b) => compareValues(a, b))
    expect(rows.map((r) => (r.name === 'Same' ? r.id : r.name))).toEqual([
      privateUse,
      face,
      ...same,
    ])
  })

  it('skips a reach row whose copies differ from its project, so a project shows once at its own name, and not at all once every row is stale', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [first, mid, last] = await plantMetas(t, f.org.id, ['Aaa first', 'Mid', 'Zzz last'])
    await plantGrants(t, pia, [first, mid, last])
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia]), [mid])
    await ready(t, f)
    /* Gives the root rows on Mid of `who` a copy of a name key that sorts
     * before every other. */
    const stale = (who: 'profile' | 'team') =>
      t.run(async (ctx) => {
        const rows = await ctx.db
          .query('project_reach')
          .withIndex('by_project_grantee', (q) =>
            q.eq('project_id', mid.id).eq('grantee_kind', who),
          )
          .collect()
        for (const r of rows) await ctx.db.patch(r._id, { name_key: '0 stale' })
      })
    const listed = async () => ok(await page(t, [pia])).rows.map((r) => r.name)
    expect(await listed()).toEqual(['Aaa first', 'Mid', 'Zzz last'])
    await stale('profile')
    expect(await listed()).toEqual(['Aaa first', 'Mid', 'Zzz last'])
    // a missing or stale row narrows the list and never widens it
    await stale('team')
    expect(await listed()).toEqual(['Aaa first', 'Zzz last'])
  })

  it('blends the seats of one login in one order, told apart by organization, favorites of both first', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ann = await person(t, f.org.id, 'Ann')
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'Ann',
      auth_user_id: ann.auth_user_id,
    })
    const [alpha, charlie] = await plantMetas(t, f.org.id, ['Alpha', 'Charlie'])
    const [bravo, delta] = await plantMetas(t, f.otherOrg.id, ['Bravo', 'Delta'])
    await plantGrants(t, ann, [alpha, charlie])
    await plantGrants(t, elsewhere, [bravo, delta])
    await ready(t, f)
    const seats = [ann, elsewhere]
    const rows = ok(await page(t, seats)).rows
    expect(rows.map((r) => [r.name, r.org_id])).toEqual([
      ['Alpha', f.org.id],
      ['Bravo', f.otherOrg.id],
      ['Charlie', f.org.id],
      ['Delta', f.otherOrg.id],
    ])
    await plantStar(t, ann, charlie)
    await plantStar(t, elsewhere, delta)
    expect(ok(await page(t, seats)).rows.map((r) => [r.name, r.favorite])).toEqual([
      ['Charlie', true],
      ['Delta', true],
      ['Alpha', false],
      ['Bravo', false],
    ])
    expect(ok(await page(t, seats)).rows).toEqual(await expectedPage(t, seats))
  })
})

/* ---------------------------------------------------------- continuation */

describe('continuation', () => {
  it('hands out every row once over three batches, with a rename, a new grant, a star and an archive between them, each where its name puts it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await plantLogin(t, await person(t, f.org.id, 'Pia'))
    const tops = await plantMetas(t, f.org.id, names('P', 60), { lead_id: f.user.id })
    const [late] = await plantMetas(t, f.org.id, ['P030a'], { lead_id: f.user.id })
    await plantGrants(t, pia, tops)
    await ready(t, f)
    const org_id = f.org.id
    const lead = as(t, f.user)
    const first = ok(await page(t, [pia]))
    expect(first.rows.map((r) => r.name)).toEqual(names('P', 25))
    // after the first batch: one project renamed past the cursor and one
    // before it, a new grant past it, a star and an archive past it
    await lead.mutation(api.projects.update, { org_id, id: tops[5].id, patch: { name: 'P050a' } })
    await lead.mutation(api.projects.update, { org_id, id: tops[40].id, patch: { name: 'P010a' } })
    await lead.mutation(api.projects.setAccess, {
      org_id,
      id: late.id,
      user_id: pia.id,
      level: 'user',
    })
    await as(t, pia).mutation(api.projectNav.setFavorite, {
      org_id,
      project_id: tops[45].id,
      favorite: true,
    })
    await lead.mutation(api.projects.archive, { org_id, id: tops[35].id })
    const want = [...names('P', 60).slice(25), 'P030a', 'P050a']
      .filter((name) => !['P035', 'P040', 'P045'].includes(name))
      .sort((a, b) => compareValues(nameKey(a), nameKey(b)))
    // the walk goes on from the first batch's next, two batches more
    const onward = await walk((after) => page(t, [pia], { after: after ?? first.next ?? '' }), 10)
    expect(onward.batches).toHaveLength(2)
    expect(onward.rows.map((r) => r.name)).toEqual(want)
    expect(new Set(onward.rows.map((r) => r.id)).size).toBe(onward.rows.length)
    // and a walk from the start answers the rule
    expect((await walk((after) => page(t, [pia], { after }))).rows).toEqual(
      await expectedPage(t, [pia]),
    )
  })

  it("keeps a loaded batch's end with through, also when a project lands inside it, and stops short past four times the batch", async () => {
    const t = newT()
    const f = await withOrg(t)
    const tops = await plantMetas(t, f.org.id, names('P', 130), { lead_id: f.user.id })
    const [inside] = await plantMetas(t, f.org.id, ['P012a'], { lead_id: f.user.id })
    const pia = await person(t, f.org.id, 'Pia')
    await plantGrants(t, pia, tops)
    await ready(t, f)
    const { batches } = await walk((after) => page(t, [pia], { after }))
    const end = batches[0].next
    const live = ok(await page(t, [pia], { through: end ?? '' }))
    expect(live.rows.map((r) => r.name)).toEqual(names('P', 25))
    expect(await pageAt(live.next)).toEqual(await pageAt(end))
    await as(t, f.user).mutation(api.projects.setAccess, {
      org_id: f.org.id,
      id: inside.id,
      user_id: pia.id,
      level: 'user',
    })
    const grown = ok(await page(t, [pia], { through: end ?? '' }))
    expect(grown.rows).toHaveLength(LIST_BATCH + 1)
    expect(grown.rows[13]).toMatchObject({ name: 'P012a' })
    expect(await pageAt(grown.next)).toEqual(await pageAt(end))
    expect(grown.stopped).toBe(false)
    // the batch after it reads on from its end
    expect(ok(await page(t, [pia], { after: grown.next ?? '' })).rows[0]).toMatchObject({
      name: 'P025',
    })
    // a through past four batches stops at the hundredth row
    const far = batches[4].next
    const capped = ok(await page(t, [pia], { through: far ?? '' }))
    expect(capped.rows).toHaveLength(4 * LIST_BATCH)
    expect(capped.stopped).toBe(true)
    expect((await pageAt(capped.next))?.key).toBe(`1${nameKey('P098')}`)
  })

  it('follows a children cursor across a change of access, from a grant on the parent to grants on some of its sub-projects and back', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [parent] = await plantMetas(t, f.org.id, ['Parent'], { lead_id: f.user.id })
    const subs = await plantSubs(t, parent, names('Sub ', 30))
    // one before the first batch's end and three past it
    const held = [subs[3], subs[25], subs[27], subs[29]]
    await plantGrants(t, pia, [parent, ...held])
    await ready(t, f)
    const first = ok(await kids(t, [pia], parent.id))
    expect(first.rows.map((r) => r.name)).toEqual(names('Sub ', 25))
    const from = (after?: string) => kids(t, [pia], parent.id, { after: after ?? first.next ?? '' })
    // the grant on the parent goes, and the sub-projects' grants stay, so
    // the batches after the cursor read Pia's reach rows under it instead
    const grant = { org_id: f.org.id, id: parent.id, user_id: pia.id }
    await as(t, f.user).mutation(api.projects.removeAccess, { ...grant, on_held_tasks: 'leave' })
    expect((await expectedChildren(t, pia, parent))?.map((r) => r.id)).toEqual(
      held.map((p) => p.id),
    )
    const onward = await walk(from)
    expect(onward.rows.map((r) => r.id)).toEqual([subs[25].id, subs[27].id, subs[29].id])
    // and with the grant back, every sub-project after the cursor
    await as(t, f.user).mutation(api.projects.setAccess, { ...grant, level: 'user' })
    const back = await walk(from)
    expect(back.rows.map((r) => r.name)).toEqual(names('Sub ', 30).slice(25))
  })
})

describe('continuation across two seats', () => {
  it('walks two seats past one batch in the order of the rule, each row once, also when the read budget stops batches', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ann = await person(t, f.org.id, 'Ann')
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'Ann',
      auth_user_id: ann.auth_user_id,
    })
    // the two organizations' names interleave, and one name is in both
    const all = names('P', 40)
    const here = await plantMetas(t, f.org.id, [...all.filter((_, i) => i % 2 === 0), 'Same'])
    const there = await plantMetas(t, f.otherOrg.id, [...all.filter((_, i) => i % 2 === 1), 'Same'])
    await plantGrants(t, ann, here)
    await plantGrants(t, elsewhere, there)
    await ready(t, f)
    for (const p of [here[3], here[17]]) await plantStar(t, ann, p)
    for (const p of [there[5], there[11]]) await plantStar(t, elsewhere, p)
    const seats = [ann, elsewhere]
    const want = await expectedPage(t, seats)
    expect(want).toHaveLength(42)
    const whole = await walk((after) => page(t, seats, { after }))
    expect(whole.batches).toHaveLength(2)
    expect(whole.rows).toEqual(want)
    Object.assign(NAMED_READ, { ranges: 40 })
    const tight = await walk((after) => page(t, seats, { after }))
    expect(tight.batches.some((b) => b.stopped && b.rows.length < LIST_BATCH)).toBe(true)
    expect(tight.rows).toEqual(want)
  })

  for (const group of ['favorites', 'rest'] as const)
    it(`shows another seat's ${group} row after a cursor at a rejected row on a reused id of the organization that sorts first`, async () => {
      const t = newT()
      const f = await withOrg(t)
      // `first` is the seat in the organization whose id sorts first
      const [one, two] = [f.org, f.otherOrg].sort((a, b) => compareValues(a.id, b.id))
      const first = await person(t, one.id, 'Ann')
      const second = await plantSeat(t, {
        org_id: two.id,
        name: 'Ann',
        auth_user_id: first.auth_user_id,
      })
      const [shared, later] = await plantMetas(t, two.id, ['Shared', 'Zed'])
      await plantGrants(t, second, [shared, later])
      await ready(t, f)
      // the first seat kept a row on the id the second organization's
      // project holds now, with its name key, which the reader rejects
      if (group === 'favorites') {
        await plantStar(t, second, shared)
        await plantStar(t, first, shared)
      } else
        await t.run((ctx) =>
          ctx.db.insert('project_reach', {
            org_id: one.id,
            grantee_kind: 'profile',
            grantee_id: first.id,
            kind: 'root',
            project_id: shared.id,
            root_id: shared.id,
            name_key: nameKey(shared.name),
            key: shared.key,
            live: true,
            on_root: true,
          }),
        )
      const seats = [first, second]
      const want = await expectedPage(t, seats)
      expect(want.map((r) => [r.name, r.favorite])).toEqual([
        ['Shared', group === 'favorites'],
        ['Zed', false],
      ])
      expect((await walk((after) => page(t, seats, { after }))).rows).toEqual(want)
      // a batch the read budget stopped at the first seat's rejected row
      // seals its position, before the second seat's row at the same key
      // and id
      const at = {
        key: (group === 'favorites' ? FAVORITES : REST) + nameKey(shared.name),
        tie: [shared.id, one.id],
      }
      const after = await namedCursor(PAGE_LIST, [], at)
      expect(ok(await page(t, seats, { after })).rows).toEqual(want)
    })
})

/* -------------------------------------------------------------- the budgets */

describe('budgets', () => {
  it('stops a batch at the read budget, never answering the end, and the walk still hands out every row once', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const tops = await plantMetas(t, f.org.id, names('P', 60))
    await plantGrants(t, pia, tops)
    await ready(t, f)
    Object.assign(NAMED_READ, { ranges: 40 })
    const { rows, batches } = await walk((after) => page(t, [pia], { after }))
    expect(rows.map((r) => r.name)).toEqual(names('P', 60))
    expect(batches.some((b) => b.stopped && b.rows.length < LIST_BATCH)).toBe(true)
    for (const b of batches) if (b.stopped) expect(b.next).not.toBeNull()
  })

  /** Pia in two teams that both share one project, starred or not, under
   * OWN_READS lowered so the second membership question cannot finish. */
  async function twoTeams(starred: boolean) {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [shared, own] = await plantMetas(t, f.org.id, ['Shared', 'Own'])
    await plantGrants(t, pia, [own])
    for (const name of ['Red', 'Blue'])
      await plantShares(t, await plantTeam(t, f.org.id, name, [pia]), [shared])
    await ready(t, f)
    if (starred) await plantStar(t, pia, shared)
    return { t, f, pia, shared, own }
  }

  it('refuses whole with access_unchecked where a check stopped, in the favorites verdict and in the check of the rest', async () => {
    for (const starred of [true, false]) {
      const { t, pia, shared } = await twoTeams(starred)
      expect(ok(await page(t, [pia])).rows.map((r) => [r.name, r.favorite])).toEqual(
        starred
          ? [
              ['Shared', true],
              ['Own', false],
            ]
          : [
              ['Own', false],
              ['Shared', false],
            ],
      )
      Object.assign(OWN_READS, { lookups: 0, members: 0 })
      const refused = await page(t, [pia])
      expect(refused).toMatchObject({ state: 'unavailable', reason: ACCESS_UNCHECKED })
      expect(refused).toHaveProperty('message', expect.stringMatching(/could not finish/))
      expect(await kids(t, [pia], shared.id)).toMatchObject({ reason: ACCESS_UNCHECKED })
      expect(await resolved(t, [pia], { project_id: shared.id })).toMatchObject({
        reason: ACCESS_UNCHECKED,
      })
      Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
    }
  })

  it('refuses whole where the room for single-row reads ran out (roomSpent)', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [shared] = await plantMetas(t, f.org.id, ['Shared'])
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia]), [shared])
    await ready(t, f)
    expect(ok(await page(t, [pia])).rows).toEqual([{ ...row(shared), favorite: false }])
    Object.assign(OWN_READS, { teamReads: 0 })
    expect(await page(t, [pia])).toMatchObject({ state: 'unavailable', reason: ACCESS_UNCHECKED })
  })

  it("refuses past PROJECT_NAV.teams of a seat's teams, and past PROJECT_NAV.children rows that show nothing", async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const gus = await person(t, f.org.id, 'Gus', { org_role: 'guest' })
    const [shared] = await plantMetas(t, f.org.id, ['Shared'])
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia, gus]), [shared])
    await plantTeam(t, f.org.id, 'Blue', [pia, gus])
    await plantGrants(t, gus, [shared])
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
    expect(ok(await page(t, [pia])).rows).toHaveLength(1)
    expect(ok(await page(t, [vic])).rows).toEqual([{ ...row(parent), favorite: false }])
    Object.assign(PROJECT_NAV, { teams: 1 })
    expect(await page(t, [pia])).toMatchObject({ reason: ACCESS_UNCHECKED })
    // a guest takes no team shares, so none of their teams is read
    expect(ok(await page(t, [gus])).rows).toHaveLength(1)
    Object.assign(PROJECT_NAV, { teams: DEFAULT_NAV.teams, children: 2 })
    expect(await page(t, [vic])).toMatchObject({ reason: ACCESS_UNCHECKED })
    expect(await resolved(t, [vic], { project_id: parent.id })).toMatchObject({
      reason: ACCESS_UNCHECKED,
    })
  })
})

/* -------------------------------------------------------------- readiness */

describe('readiness', () => {
  /** Organization `orgId` without its `stamp` in org_ready, as before the
   * backfill that writes it. */
  const unstamp = (t: T, orgId: string, stamp: 'nav_at' | 'name_keys_at') =>
    t.run(async (ctx) => {
      const r = await ctx.db
        .query('org_ready')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .unique()
      if (r !== null)
        await ctx.db.patch(
          r._id,
          stamp === 'nav_at' ? { nav_at: undefined } : { name_keys_at: undefined },
        )
    })

  for (const stamp of ['nav_at', 'name_keys_at'] as const)
    it(`answers not_ready without ${stamp} for the page of any seat and for children, while resolve answers`, async () => {
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
      expect(ok(await page(t, [ann, elsewhere])).rows).toHaveLength(2)
      await unstamp(t, f.org.id, stamp)
      expect(await page(t, [ann])).toEqual({ state: 'not_ready' })
      expect(await page(t, [ann, elsewhere])).toEqual({ state: 'not_ready' })
      expect(ok(await page(t, [elsewhere])).rows).toHaveLength(1)
      expect(await kids(t, [ann], f.meta.id)).toEqual({ state: 'not_ready' })
      expect(await resolved(t, [ann], { project_id: f.meta.id })).toMatchObject({ state: 'ok' })
      expect(await resolved(t, [ann], { project_id: f.sub.id })).toMatchObject({
        state: 'ok',
        project: { parent: row(f.meta), favorite: null },
      })
      // a sub-project has no list to wait for
      expect(ok(await kids(t, [ann], f.sub.id))).toEqual({
        state: 'ok',
        rows: [],
        next: null,
        stopped: false,
      })
    })

  for (const stamp of ['nav_at', 'name_keys_at'] as const)
    it(`answers not_ready without ${stamp} for children of a parent the seat sees only through a sub-project, and unavailable where it sees none`, async () => {
      const t = newT()
      const f = await withOrg(t)
      const pia = await person(t, f.org.id, 'Pia')
      const bo = await person(t, f.org.id, 'Bo')
      await plantGrants(t, pia, [f.sub])
      await ready(t, f)
      expect(ok(await kids(t, [pia], f.meta.id)).rows).toEqual([
        { ...row(f.sub), parent_id: f.meta.id },
      ])
      await unstamp(t, f.org.id, stamp)
      expect(await kids(t, [pia], f.meta.id)).toEqual({ state: 'not_ready' })
      // a project the seat does not see answers as it did with the stamps
      expect(await kids(t, [bo], f.meta.id)).toEqual({ state: 'unavailable' })
      expect(await kids(t, [pia], f.hidden.id)).toEqual({ state: 'unavailable' })
      // resolve answers the sub-project, and its parent apart from a loss
      // until the reach rows are complete
      expect(await resolved(t, [pia], { project_id: f.sub.id })).toMatchObject({
        state: 'ok',
        project: { parent: row(f.meta) },
      })
      expect(await resolved(t, [pia], { project_id: f.meta.id })).toMatchObject(
        stamp === 'nav_at' ? { reason: ACCESS_UNCHECKED } : { state: 'ok' },
      )
    })

  it('answers a login without a seat an empty last batch', async () => {
    const t = newT()
    expect(await page(t, [])).toEqual({ state: 'ok', rows: [], next: null, stopped: false })
  })
})

/* ---------------------------------------------------------------- no task */

describe('tasks', () => {
  it('reads the same for a listed project with no tasks and with 800 open tasks', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    // a third sub-project, so 800 open tasks keep each under 300
    const subs = [f.sub, f.sub2, ...(await plantSubs(t, f.meta, ['Layout']))]
    await plantGrants(t, pia, [f.meta])
    await ready(t, f)
    const seats = mapOf([pia])
    const reads = async () => ({
      page: (await measured(t, (ctx) => navPageOf(ctx, seats, {}))).read,
      children: (await measured(t, (ctx) => navChildrenOf(ctx, seats, { project_id: f.meta.id })))
        .read,
      resolve: (await measured(t, (ctx) => navResolveOf(ctx, seats, { project_id: f.sub.id })))
        .read,
    })
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
  /** Every call answered whole, inside NAMED_READ. */
  const whole = (calls: (Read & { stopped: boolean })[]) => {
    for (const call of calls) {
      expect(call.stopped).toBe(false)
      expect(call.ranges).toBeLessThan(NAMED_READ.ranges)
      expect(call.documents).toBeLessThan(NAMED_READ.documents)
    }
  }

  /** Pia with grants on `live` live top-level projects, the organization's
   * every one: withOrg's two and `live` - 2 planted, three sub-projects
   * under each of the first ten planted and none under the rest, and on
   * `archived` archived top-level projects too. */
  async function topLevel(live: number, archived = 0) {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const planted = await plantMetas(t, f.org.id, names('Live project ', live - 2))
    const old = await plantMetas(t, f.org.id, names('Archived project ', archived), {
      archived_at: NOW,
    })
    for (const p of planted.slice(0, 10)) await plantSubs(t, p, names(`${p.name} sub `, 3))
    const tops = [f.meta, f.hidden, ...planted]
    await plantGrants(t, pia, [...tops, ...old])
    return { t, f, pia, tops }
  }

  /** How many live top-level projects organization `orgId` holds. */
  const liveTops = (t: T, orgId: string) =>
    t.run(
      async (ctx) =>
        (
          await ctx.db
            .query('projects')
            .withIndex('by_org_parent', (q) => q.eq('org_id', orgId).eq('parent_id', undefined))
            .collect()
        ).filter((p) => p.archived_at === undefined).length,
    )

  it('pages 200 top-level projects the person holds grants on, every batch and one kept live to 100 rows', async () => {
    const { t, f, pia } = await topLevel(200)
    await ready(t, f)
    expect(await liveTops(t, f.org.id)).toBe(200)
    const seats = mapOf([pia])
    const walked = await measuredWalk(t, (ctx, after) => navPageOf(ctx, seats, { after }))
    console.log('page, 200 projects by grant, per batch', walked.calls)
    expect(walked.rows).toHaveLength(200)
    whole(walked.calls)
    const end = (await walk((after) => page(t, [pia], { after }))).batches[3].next
    const kept = await measured(t, (ctx) => navPageOf(ctx, seats, { through: end ?? '' }))
    console.log('page, 200 projects by grant, a batch kept live to 100 rows', kept.read)
    expect(ok(kept.out).rows).toHaveLength(100)
    whole([{ ...kept.read, stopped: ok(kept.out).stopped }])
  })

  it('pages the same 200 as favorites', async () => {
    const { t, f, pia, tops } = await topLevel(200)
    await ready(t, f)
    expect(await liveTops(t, f.org.id)).toBe(200)
    for (const p of tops) await plantStar(t, pia, p)
    const seats = mapOf([pia])
    const walked = await measuredWalk(t, (ctx, after) => navPageOf(ctx, seats, { after }))
    console.log('page, 200 favorites, per batch', walked.calls)
    expect(walked.rows.every((r) => r.favorite)).toBe(true)
    expect(walked.rows).toHaveLength(200)
    whole(walked.calls)
  })

  it('reads none of 300 archived top-level projects the person reached, beside 200 live ones with one shown for navigation in the first batch', async () => {
    /* The person reaches the organization's 200 live top-level projects,
     * withOrg's two and one shown for navigation among them, so her root
     * rows, live and archived, are the 500 the access check's navigation
     * would read at once (the sum rule); these reads ask no question that
     * reads them. */
    const first = async (archived: number) => {
      const { t, f, pia } = await topLevel(199, archived)
      const [nav] = await plantMetas(t, f.org.id, ['Aaa shown for navigation'])
      await plantGrants(t, pia, await plantSubs(t, nav, ['Aaa nav sub']))
      await ready(t, f)
      expect(await liveTops(t, f.org.id)).toBe(200)
      return await measured(t, (ctx) => navPageOf(ctx, mapOf([pia]), {}))
    }
    const without = await first(0)
    const beside = await first(300)
    console.log('page, first batch, 200 live and 300 archived top-level projects', beside.read)
    expect(ok(beside.out).rows[0]).toMatchObject({ name: 'Aaa shown for navigation' })
    expect(beside.read.ranges).toBe(without.read.ranges)
    expect(beside.read.documents).toBe(without.read.documents)
  })

  it('pages for a member of 5 teams each sharing 20 sub-projects, every parent shown for navigation only', async () => {
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
    const walked = await measuredWalk(t, (ctx, after) => navPageOf(ctx, seats, { after }))
    console.log('page, 5 teams sharing 20 sub-projects each, per batch', walked.calls)
    expect(walked.rows).toHaveLength(34)
    whole(walked.calls)
    // the first batch spends 4 of OWN_READS.teamReads (roomSpent), so it
    // answers with 4 left and refuses whole with 3
    try {
      Object.assign(OWN_READS, { teamReads: 4 })
      expect(ok(await page(t, [pia])).rows).toHaveLength(LIST_BATCH)
      Object.assign(OWN_READS, { teamReads: 3 })
      expect(await page(t, [pia])).toMatchObject({
        state: 'unavailable',
        reason: ACCESS_UNCHECKED,
      })
    } finally {
      Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
    }
    const children = await measured(t, (ctx) =>
      navChildrenOf(ctx, seats, { project_id: parents[0].id }),
    )
    console.log('children of one of those parents', children.read)
    expect(ok(children.out).rows).toHaveLength(3)
  })

  it("pages for one of the person's teams sharing 50 projects, beside its 150 archived shares", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const live = await plantMetas(t, f.org.id, names('Shared ', 50))
    const old = await plantMetas(t, f.org.id, names('Old shared ', 150), { archived_at: NOW })
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia]), [...live, ...old])
    await ready(t, f)
    const seats = mapOf([pia])
    const walked = await measuredWalk(t, (ctx, after) => navPageOf(ctx, seats, { after }))
    console.log('page, a team sharing 50 live and 150 archived projects, per batch', walked.calls)
    expect(walked.rows).toHaveLength(50)
    whole(walked.calls)
  })

  it("pages 200 sub-projects the person reads through grants, under 67 parents shown for navigation only, and each parent's children", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const parents = await plantMetas(t, f.org.id, names('Parent ', 67))
    const subs: Doc<'projects'>[] = []
    for (const p of parents) subs.push(...(await plantSubs(t, p, names(`${p.name} sub `, 3))))
    await plantGrants(t, pia, subs.slice(0, 200))
    await ready(t, f)
    const seats = mapOf([pia])
    const walked = await measuredWalk(t, (ctx, after) => navPageOf(ctx, seats, { after }))
    console.log('page, 200 sub-projects under 67 parents, per batch', walked.calls)
    expect(walked.rows).toHaveLength(67)
    whole(walked.calls)
    let most: Read = { ranges: 0, documents: 0, bytes: 0 }
    let shown = 0
    for (const p of parents) {
      const c = await measured(t, (ctx) => navChildrenOf(ctx, seats, { project_id: p.id }))
      shown += ok(c.out).rows.length
      if (c.read.ranges > most.ranges) most = c.read
    }
    console.log('children of each of the 67 parents, the largest', most)
    expect(shown).toBe(200)
  })

  it('reads none of 500 archived sub-projects the person holds grants on, under 167 archived parents, beside live ones', async () => {
    const run = async (archived: boolean) => {
      const t = newT({ transactionLimits: true })
      const f = await withOrg(t)
      const pia = await person(t, f.org.id, 'Pia')
      const [parent] = await plantMetas(t, f.org.id, ['Live parent'])
      const live = await plantSubs(t, parent, names('Live sub ', 3))
      const tops = await plantMetas(t, f.org.id, names('Live top ', 20))
      await plantGrants(t, pia, [...live, ...tops])
      if (archived) {
        const old = await plantMetas(t, f.org.id, names('Old parent ', 167), { archived_at: NOW })
        const subs: Doc<'projects'>[] = []
        for (const p of old)
          subs.push(...(await plantSubs(t, p, names(`${p.name} sub `, 3), { archived_at: NOW })))
        await plantGrants(t, pia, subs.slice(0, 500))
      }
      await ready(t, f)
      const seats = mapOf([pia])
      return {
        page: await measured(t, (ctx) => navPageOf(ctx, seats, {})),
        children: await measured(t, (ctx) => navChildrenOf(ctx, seats, { project_id: parent.id })),
      }
    }
    const without = await run(false)
    const beside = await run(true)
    console.log('page and children beside 500 archived sub-projects', {
      page: beside.page.read,
      children: beside.children.read,
    })
    expect(ok(beside.page.out).rows).toHaveLength(21)
    expect(ok(beside.children.out).rows).toHaveLength(3)
    for (const read of ['page', 'children'] as const) {
      expect(beside[read].read.ranges).toBe(without[read].read.ranges)
      expect(beside[read].read.documents).toBe(without[read].read.documents)
    }
  })

  it('pages beside 500 archived sub-projects the person holds grants on under 167 live parents, which it leaves out, in one whole batch', async () => {
    /* Every parent shows Pia only through archived sub-projects, which
     * lib/access.ts counts for navigation and these reads do not, so the
     * one batch reads each parent's live root row and leaves it out. */
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const tops = await plantMetas(t, f.org.id, names('Live top ', 20))
    const parents = await plantMetas(t, f.org.id, names('Parent ', 167))
    const subs: Doc<'projects'>[] = []
    for (const p of parents)
      subs.push(...(await plantSubs(t, p, names(`${p.name} sub `, 3), { archived_at: NOW })))
    await plantGrants(t, pia, [...tops, ...subs.slice(0, 500)])
    await ready(t, f)
    const seats = mapOf([pia])
    const first = await measured(t, (ctx) => navPageOf(ctx, seats, {}))
    console.log('page, 500 archived sub-projects under 167 live parents, its one batch', first.read)
    const batch = ok(first.out)
    expect(batch.rows).toEqual(tops.map((p) => ({ ...row(p), favorite: false })))
    expect(batch.next).toBeNull()
    whole([{ ...first.read, stopped: batch.stopped }])
    expect(await kids(t, [pia], parents[0].id)).toEqual({ state: 'unavailable' })
  })

  it('lists 30 live sub-projects under one project in two batches for a person with access on it, and the one a person holds', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const bo = await person(t, f.org.id, 'Bo')
    const [parent] = await plantMetas(t, f.org.id, ['Parent'])
    const subs = await plantSubs(t, parent, names('Sub ', 30))
    await plantGrants(t, pia, [parent])
    await plantGrants(t, bo, [subs[17]])
    await ready(t, f)
    const walked = await measuredWalk(t, (ctx, after) =>
      navChildrenOf(ctx, mapOf([pia]), { project_id: parent.id, after }),
    )
    console.log('children, 30 sub-projects for a person with access on the project', walked.calls)
    expect(walked.calls).toHaveLength(2)
    expect(walked.rows).toHaveLength(30)
    whole(walked.calls)
    const one = await measured(t, (ctx) =>
      navChildrenOf(ctx, mapOf([bo]), { project_id: parent.id }),
    )
    console.log('children, the one of 30 a person holds', one.read)
    expect(ok(one.out).rows.map((r) => r.id)).toEqual([subs[17].id])
  })

  it("reads none of 40 archived sub-projects beside a project's 3 live ones", async () => {
    const run = async (archived: number) => {
      const t = newT({ transactionLimits: true })
      const f = await withOrg(t)
      const pia = await person(t, f.org.id, 'Pia')
      const [parent] = await plantMetas(t, f.org.id, ['Parent'])
      await plantSubs(t, parent, names('Live ', 3))
      await plantSubs(t, parent, names('Aaa archived ', archived), { archived_at: NOW })
      await plantGrants(t, pia, [parent])
      await ready(t, f)
      return await measured(t, (ctx) => navChildrenOf(ctx, mapOf([pia]), { project_id: parent.id }))
    }
    const without = await run(0)
    const beside = await run(40)
    console.log('children, 3 live beside 40 archived sub-projects', beside.read)
    expect(ok(beside.out).rows).toHaveLength(3)
    expect(beside.read.ranges).toBe(without.read.ranges)
    expect(beside.read.documents).toBe(without.read.documents)
  })

  /* The organization's other sub-projects are 495 live ones, 3 a parent,
   * which withOrg's two and the project's own 3 bring to 500, or 1,000
   * archived ones, 30 a parent, under the 40 archived sub-projects of one
   * project. Pia holds a grant on her project alone. */
  for (const [label, count, each, archived] of [
    ['500 live', 495, 3, false],
    ['1,000 archived', 1000, 30, true],
  ] as const)
    it(`reads an everyday project's own sub-projects among ${label} sub-projects of the organization`, async () => {
      const run = async (others: number) => {
        const t = newT({ transactionLimits: true })
        const f = await withOrg(t)
        const pia = await person(t, f.org.id, 'Pia')
        const [parent] = await plantMetas(t, f.org.id, ['Mine'])
        await plantSubs(t, parent, names('Mine ', 3))
        const elsewhere = await plantMetas(t, f.org.id, names('Other ', Math.ceil(others / each)))
        for (const [i, p] of elsewhere.entries())
          await plantSubs(
            t,
            p,
            names(`${p.name} sub `, Math.min(each, others - i * each)),
            archived ? { archived_at: NOW } : {},
          )
        await plantGrants(t, pia, [parent])
        await ready(t, f)
        return await measured(t, (ctx) =>
          navChildrenOf(ctx, mapOf([pia]), { project_id: parent.id }),
        )
      }
      const without = await run(0)
      const beside = await run(count)
      console.log(`children of an everyday project among ${label} sub-projects`, beside.read)
      expect(ok(beside.out).rows).toHaveLength(3)
      expect(beside.read.ranges).toBe(without.read.ranges)
      expect(beside.read.documents).toBe(without.read.documents)
    })

  it('resolves a sub-project of a project shared with 5 teams', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [parent] = await plantMetas(t, f.org.id, ['Widely shared'])
    const [sub] = await plantSubs(t, parent, ['Its sub-project'])
    for (let i = 0; i < 5; i++)
      await plantShares(t, await plantTeam(t, f.org.id, `Team ${i}`, i < 3 ? [pia] : []), [parent])
    await ready(t, f)
    const one = await measured(t, (ctx) => navResolveOf(ctx, mapOf([pia]), { project_id: sub.id }))
    console.log('resolve, a sub-project of a project shared with 5 teams', one.read)
    expect(one.out).toEqual({
      state: 'ok',
      project: { ...row(sub), parent: row(parent), favorite: null },
    })
  })

  it('reads none of 300 favorites on archived projects beside live ones', async () => {
    const run = async (archived: number) => {
      const { t, f, pia, tops } = await topLevel(20)
      const old = await plantMetas(t, f.org.id, names('Aaa archived ', archived), {
        archived_at: NOW,
      })
      await plantGrants(t, pia, old)
      await ready(t, f)
      for (const p of [...tops.slice(0, 5), ...old]) await plantStar(t, pia, p)
      const seats = mapOf([pia])
      return {
        page: await measured(t, (ctx) => navPageOf(ctx, seats, {})),
        resolve: await measured(t, (ctx) => navResolveOf(ctx, seats, { project_id: tops[0].id })),
      }
    }
    const without = await run(0)
    const beside = await run(300)
    console.log('page and resolve beside 300 favorites on archived projects', {
      page: beside.page.read,
      resolve: beside.resolve.read,
    })
    expect(ok(beside.page.out).rows.filter((r) => r.favorite)).toHaveLength(5)
    expect(beside.resolve.out).toMatchObject({ project: { favorite: true } })
    for (const read of ['page', 'resolve'] as const) {
      expect(beside[read].read.ranges).toBe(without[read].read.ranges)
      expect(beside[read].read.documents).toBe(without[read].read.documents)
    }
  })
})

/* ------------------------------------------------------ the public queries */

describe('the public queries', () => {
  it('answer for the signed-in login across its active seats, leaving out an inactive seat and an organization being deleted', async () => {
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
    const listed = async () =>
      ok(await caller.query(api.projectNav.page, {})).rows.map((r) => r.org_id)
    // Elsewhere sorts before Testbed platform
    expect(await listed()).toEqual([f.otherOrg.id, f.org.id])
    const children = await caller.query(api.projectNav.children, { project_id: f.meta.id })
    expect(ok(children).rows).toHaveLength(2)
    expect(
      await caller.query(api.projectNav.resolve, {
        org_id: f.otherOrg.id,
        num: f.otherProject.num,
      }),
    ).toMatchObject({ state: 'ok', project: { id: f.otherProject.id } })
    await t.run((ctx) => ctx.db.patch(elsewhere._id, { active: false }))
    expect(await listed()).toEqual([f.org.id])
    expect(await caller.query(api.projectNav.resolve, { project_id: f.otherProject.id })).toEqual({
      state: 'unavailable',
    })
    await t.run(async (ctx) => {
      await ctx.db.patch(elsewhere._id, { active: true })
      await ctx.db.insert('org_removals', {
        org_id: f.otherOrg.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        phase: 'profiles',
        created_at: NOW,
      })
    })
    expect(await listed()).toEqual([f.org.id])
  })
})

/* The page's cursor positions carry the group and the seat's organization. */
it('seals a page position with its group, name key, project id and organization', async () => {
  const t = newT()
  const f = await withOrg(t)
  const pia = await person(t, f.org.id, 'Pia')
  const tops = await plantMetas(t, f.org.id, names('P', 26))
  await plantGrants(t, pia, tops)
  await ready(t, f)
  const at: NamedAt | null = await pageAt(ok(await page(t, [pia])).next)
  expect(at).toEqual({ key: `1${nameKey('P024')}`, tie: [tops[24].id, f.org.id] })
  // a children cursor opens only for its own list
  const child = ok(await kids(t, [pia], tops[0].id))
  expect(child.next).toBeNull()
  expect(await openNamedCursor(ok(await page(t, [pia])).next ?? '', CHILDREN_LIST, [])).toBeNull()
})

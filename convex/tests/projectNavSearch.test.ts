/* The directory's name search (projectNav.ts search, read by
 * model/projectNavReads.ts navSearchOf): its arguments and cursors; the
 * matching rule; every access shape for a user, a guest and a Viewer, and
 * an admin, held against the rule worked out without reach rows
 * (projectNav.setup.ts expectedSearch); the sub-projects a source on their
 * parent reaches; a parent shown only for navigation; reads that do not
 * depend on what the person cannot see; favorites; the order; rows that
 * meet at one position; continuation, `through` and the four-batch cap;
 * the read budgets and the bounds that refuse; readiness; that no task is
 * read; the public query; and the reads at the design size, one figure a
 * case, under Convex's transaction limits, which the last suite logs. */

import { ConvexError, compareValues } from 'convex/values'
import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { ACCESS_UNCHECKED, accessOf, OWN_READS, ordinaryOf } from '../lib/access'
import { newWindowKey } from '../lib/db'
import type { Refusal } from '../lib/functions'
import { LIMITS, LIST_BATCH } from '../lib/limits'
import {
  mergeNamed,
  NAMED_READ,
  namedCeiling,
  namedCursor,
  openNamedCursor,
  readBatch,
} from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { allWordsMatcher } from '../lib/search'
import { insertTask } from '../model/descriptions'
import { grantee } from '../model/projectNav'
import {
  BLANK_SEARCH,
  EMPTY_ORG,
  FAVORITES,
  type NavSearchArgs,
  type NavSearchRow,
  navSearchOf,
  PAGE_LIST,
  PROJECT_NAV,
  REST,
  restCandidates,
  SEARCH_LIST,
} from '../model/projectNavReads'
import { SHAPES } from './accessShapes.setup'
import { as, NOW, newT, plantLogin, plantSeat, type T, uuid, withOrg } from './helpers.setup'
import { expectedSearch } from './projectNav.setup'
import {
  badRequest,
  mapOf,
  measured,
  names,
  now,
  ok,
  page,
  person,
  plantGrants,
  plantMetas,
  plantShares,
  plantStar,
  plantSubs,
  plantTeam,
  type Read,
  ready,
  row,
  type Seats,
  walk,
} from './projectNavFixtures.setup'

/* Cursors are sealed with a key derived from BETTER_AUTH_SECRET
 * (lib/archiveCursorSeal.ts). */
const g = globalThis as unknown as { process: { env: Record<string, string | undefined> } }
g.process.env.BETTER_AUTH_SECRET ??= 'project-nav-search-test-secret-not-a-deployment-key'

const DEFAULT_READ = { ...NAMED_READ }
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
const DEFAULT_NAV = structuredClone(PROJECT_NAV)
afterEach(() => {
  Object.assign(NAMED_READ, DEFAULT_READ)
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
  Object.assign(PROJECT_NAV, structuredClone(DEFAULT_NAV))
})

/* --------------------------------------------------------------- fixtures */

/** The login of `seats`, which every seat of one login shares. */
const loginOf = (seats: Seats) => seats[0]?.auth_user_id ?? 'auth_nobody'

/** What the search of `search` with `a` answers the login whose seats are
 * `seats`. */
const find = (t: T, seats: Seats, search: string, a: Omit<NavSearchArgs, 'search'> = {}) =>
  t.run((ctx) => navSearchOf(ctx, loginOf(seats), mapOf(seats), { search, ...a }))

/** Every row of the search of `term` from its first batch to its last. */
const found = async (t: T, seats: Seats, term: string, a: { org_id?: string } = {}) =>
  (await walk((after) => find(t, seats, term, { ...a, after }))).rows

/** The names of `rows`, in order. */
const namesOf = (rows: readonly NavSearchRow[]) => rows.map((r) => r.name)

/** `p` as a top-level row of the search. */
const top = (p: Doc<'projects'>, favorite = false): NavSearchRow => ({
  ...row(p),
  parent: null,
  favorite,
})

/** `p`, a sub-project of `parent`, as a row of the search. */
const under = (p: Doc<'projects'>, parent: Doc<'projects'>): NavSearchRow => ({
  ...row(p),
  parent: row(parent),
  favorite: null,
})

/** The refusal a search call rejects with, and how many index ranges the
 * call read before it refused. */
const refusal = (t: T, seats: Seats, search: string, a: Omit<NavSearchArgs, 'search'> = {}) =>
  t.run(async (ctx) => {
    const e = await navSearchOf(ctx, loginOf(seats), mapOf(seats), { search, ...a }).then(
      () => null,
      (error: unknown) => error,
    )
    const m = await ctx.meta.getTransactionMetrics()
    if (!(e instanceof ConvexError)) throw new Error(`expected a refusal, got ${String(e)}`)
    return { data: e.data as Refusal, ranges: m.databaseQueries.used }
  })

/** The position search cursor `cursor` of the login of `seats` seals, for
 * search `term` across every seat, opened. */
const searchAt = (seats: Seats, term: string, cursor: string | null) =>
  cursor === null
    ? Promise.resolve(null)
    : openNamedCursor(cursor, SEARCH_LIST, [loginOf(seats), '', nameKey(term)])

/* ----------------------------------------------------------- the arguments */

describe('arguments', () => {
  it('refuses a search with nothing to match, one past LIMITS.search and an empty org_id before it reads anything', async () => {
    const t = newT()
    const f = await withOrg(t)
    await ready(t, f)
    const seats = [f.user]
    for (const blank of ['', '   ', '\t\n', '́'])
      expect(await refusal(t, seats, blank), JSON.stringify(blank)).toEqual({
        data: { code: 'bad_request', message: BLANK_SEARCH },
        ranges: 0,
      })
    expect(await refusal(t, seats, 'a'.repeat(LIMITS.search.max + 1))).toEqual({
      data: { code: 'rule', message: LIMITS.search.refusal },
      ranges: 0,
    })
    expect(await refusal(t, seats, 'testbed', { org_id: '' })).toEqual({
      data: { code: 'bad_request', message: EMPTY_ORG },
      ranges: 0,
    })
    expect(await refusal(t, seats, 'testbed', { after: 'nope' })).toMatchObject({
      data: { code: 'bad_request' },
      ranges: 0,
    })
    // punctuation alone is something to match
    expect(ok(await find(t, seats, ' - ')).rows).toEqual([])
    // the longest search the limit allows answers, trimmed, as a short one does
    expect(ok(await find(t, seats, ` ${'a'.repeat(LIMITS.search.max)} `)).rows).toEqual([])
    expect(ok(await find(t, seats, ' Testbed ')).rows).toEqual([top(f.meta)])
  })

  it('refuses a cursor that is malformed, of the page, of another search, organization or login, and a through not after after', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ann = await person(t, f.org.id, 'Ann')
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'Ann',
      auth_user_id: ann.auth_user_id,
    })
    const bo = await person(t, f.org.id, 'Bo')
    const tops = await plantMetas(t, f.org.id, names('Top ', 60))
    await plantGrants(t, ann, tops)
    await plantGrants(t, bo, tops)
    await plantGrants(t, elsewhere, await plantMetas(t, f.otherOrg.id, names('Top there ', 3)))
    await ready(t, f)
    const seats = [ann, elsewhere]
    const first = ok(await find(t, seats, 'top'))
    const second = ok(await find(t, seats, 'top', { after: first.next ?? '' }))
    const here = ok(await find(t, seats, 'top', { org_id: f.org.id }))
    expect(first.next).not.toBeNull()
    expect(here.next).not.toBeNull()
    for (const bad of ['nope', '', 'ff'.repeat(40)]) {
      await badRequest(find(t, seats, 'top', { after: bad }))
      await badRequest(find(t, seats, 'top', { through: bad }))
    }
    // a page cursor to the search and the reverse
    const paged = ok(await page(t, seats))
    expect(paged.next).not.toBeNull()
    await badRequest(find(t, seats, 'top', { after: paged.next ?? '' }))
    await badRequest(page(t, seats, { after: first.next ?? '' }))
    // a cursor of another search, while two searches of one name key share one
    expect(await badRequest(find(t, seats, 'top 0', { after: first.next ?? '' }))).toMatch(
      /same login, search and organization/,
    )
    expect(ok(await find(t, seats, ' TÔP ', { after: first.next ?? '' }))).toEqual(second)
    // a cursor of one organization's search and of every seat's, given to another
    await badRequest(find(t, seats, 'top', { after: here.next ?? '' }))
    await badRequest(find(t, seats, 'top', { org_id: f.org.id, after: first.next ?? '' }))
    await badRequest(find(t, seats, 'top', { org_id: f.otherOrg.id, after: here.next ?? '' }))
    // a cursor of another login at the same position
    const bos = ok(await find(t, [bo], 'top', { org_id: f.org.id }))
    await badRequest(find(t, seats, 'top', { org_id: f.org.id, after: bos.next ?? '' }))
    const bosNext = ok(await find(t, [bo], 'top', { org_id: f.org.id, after: bos.next ?? '' }))
    const hereNext = ok(await find(t, seats, 'top', { org_id: f.org.id, after: here.next ?? '' }))
    expect(bosNext.rows).toEqual(hereNext.rows)
    // a through at or before after
    for (const through of [first.next, second.next])
      await badRequest(find(t, seats, 'top', { after: second.next ?? '', through: through ?? '' }))
    expect(
      ok(await find(t, seats, 'top', { after: first.next ?? '', through: second.next ?? '' })).rows,
    ).toHaveLength(LIST_BATCH)
  })

  it('seals a search position with its group, name key, project id and organization', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const tops = await plantMetas(t, f.org.id, names('P', 26))
    await plantGrants(t, pia, tops)
    await ready(t, f)
    const next = ok(await find(t, [pia], 'p')).next
    expect(await searchAt([pia], 'p', next)).toEqual({
      key: `${REST}${nameKey('P024')}`,
      tie: [tops[24].id, f.org.id],
    })
    expect(await openNamedCursor(next ?? '', PAGE_LIST, [])).toBeNull()
  })
})

/* -------------------------------------------------------------- matching */

describe('matching', () => {
  it("matches every word of the search in any order, ignoring case and accents, against each project's own name", async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [web, cafe, design] = await plantMetas(t, f.org.id, [
      'Website Redesign',
      'Café Menu',
      'Design system',
    ])
    const [layout] = await plantSubs(t, web, ['Page layout', 'Logo'])
    await plantGrants(t, pia, [web, cafe, design])
    await ready(t, f)
    const seats = [pia]
    const listed = async (term: string) => namesOf(await found(t, seats, term))
    expect(await listed('design web')).toEqual(['Website Redesign'])
    expect(await listed('DESIGN')).toEqual(['Design system', 'Website Redesign'])
    expect(await listed('cafe')).toEqual(['Café Menu'])
    expect(await listed('MENÜ  café')).toEqual(['Café Menu'])
    expect(await listed('menus')).toEqual([])
    // a parent's name brings none of its sub-projects, and words split
    // between a parent's name and its sub-project's match neither
    expect(await listed('website')).toEqual(['Website Redesign'])
    expect(await listed('website layout')).toEqual([])
    // a sub-project under a parent no one expanded, with its parent
    expect(await found(t, seats, 'layout')).toEqual([under(layout, web)])
    // the organization's name matches nothing
    expect(f.org.name).toBe('Testbed Labs')
    expect(await listed('labs')).toEqual([])
    for (const term of ['design', 'e', 'o', 'labs'])
      expect(await found(t, seats, term)).toEqual(await expectedSearch(t, seats, term))
  })

  it('never matches a sub-project by a stored name key that drifted from its name', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    await plantGrants(t, pia, [f.meta])
    await ready(t, f)
    expect(await found(t, [pia], 'firmware')).toEqual([under(f.sub, f.meta)])
    // a key that does not follow the name, which no writer leaves
    await t.run((ctx) => ctx.db.patch(f.sub._id, { name_key: 'drifted' }))
    expect(await found(t, [pia], 'drifted')).toEqual([])
    expect(await found(t, [pia], 'firmware')).toEqual([])
    expect(await found(t, [pia], 'r')).toEqual([under(f.sub2, f.meta), top(f.meta)])
  })
})

/* -------------------------------------------------------------- the access */

/** One access case: `shape` planted for a fresh seat of `role`, or the
 * fixture's admin without a shape, with a star on TBED and Skunkworks, and
 * the search of a term that matches every fixture name and of two that
 * match a few held against the rule worked out without reach rows.
 * Answers how many rows the subject found. */
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
  let seen = 0
  // 'r' is in every name withOrg plants, 'w' in Firmware, Skunkworks and
  // Elsewhere, 'board' in one sub-project's
  for (const term of ['r', 'w', 'board']) {
    const rows = await found(t, seats, term)
    expect(rows, `${label}: ${term}`).toEqual(await expectedSearch(t, seats, term))
    seen += rows.length
  }
  return seen
}

describe('access', () => {
  for (const role of ['user', 'guest', 'viewer'] as const)
    it(`finds by the rule for a ${role} in every access shape`, async () => {
      let showing = 0
      for (const shape of SHAPES) if ((await compareShape(shape, role)) > 0) showing++
      // a guest takes no team shares, so fewer shapes show them anything
      expect(showing).toBeGreaterThan(SHAPES.length / 3)
    })

  it('finds nothing for an admin without grants, whom the admin rule gives every project', async () => {
    expect(await compareShape(null, 'admin')).toBe(0)
    const t = newT()
    const f = await withOrg(t)
    await ready(t, f)
    expect(ok(await find(t, [f.admin], 'r')).rows).toEqual([])
    // a grant of their own finds it like anyone's
    await as(t, f.user).mutation(api.projects.setAccess, {
      org_id: f.org.id,
      id: f.hidden.id,
      user_id: f.admin.id,
      level: 'user',
    })
    expect(await found(t, [f.admin], 'r')).toEqual([top(f.hidden)])
  })

  it('finds every live sub-project of a project the person holds a grant, a lead or a team share on, and none through a Viewer lead or a guest share', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const vic = await person(t, f.org.id, 'Vic', { org_role: 'viewer' })
    const gus = await person(t, f.org.id, 'Gus', { org_role: 'guest' })
    const [granted, led, shared, viewerLed] = await plantMetas(t, f.org.id, [
      'Granted',
      'Led',
      'Shared',
      'Viewer led',
    ])
    const subs: Doc<'projects'>[] = []
    for (const p of [granted, led, shared, viewerLed])
      subs.push(...(await plantSubs(t, p, [`${p.name} alpha`, `${p.name} beta`])))
    await plantSubs(t, granted, ['Granted alpha old'], { archived_at: NOW })
    await plantGrants(t, pia, [granted])
    await t.run(async (ctx) => {
      await ctx.db.patch(led._id, { lead_id: pia.id })
      // a lead kept from before the rule that Viewers lead nothing
      await ctx.db.patch(viewerLed._id, { lead_id: vic.id })
    })
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia, gus]), [shared])
    await ready(t, f)
    expect(await found(t, [pia], 'alpha')).toEqual([
      under(subs[0], granted),
      under(subs[2], led),
      under(subs[4], shared),
    ])
    expect(namesOf(await found(t, [pia], 'a'))).toEqual([
      'Granted',
      'Granted alpha',
      'Granted beta',
      'Led alpha',
      'Led beta',
      'Shared',
      'Shared alpha',
      'Shared beta',
    ])
    // the Viewer's lead writes a root row with on_root that gives nothing
    const vics = await t.run((ctx) =>
      ctx.db
        .query('project_reach')
        .withIndex('by_project_grantee', (q) =>
          q.eq('project_id', viewerLed.id).eq('grantee_kind', 'profile').eq('grantee_id', vic.id),
        )
        .collect(),
    )
    expect(vics.map((r) => r.on_root)).toEqual([true])
    expect(await found(t, [vic], 'a')).toEqual([])
    expect(await found(t, [gus], 'a')).toEqual([])
    for (const who of [pia, vic, gus])
      expect(await found(t, [who], 'a')).toEqual(await expectedSearch(t, [who], 'a'))
  })

  it('shows a parent seen only for navigation when its own name matches, and none of its other sub-projects', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    await plantGrants(t, pia, [f.sub])
    await ready(t, f)
    expect(await found(t, [pia], 'testbed')).toEqual([top(f.meta)])
    expect(await found(t, [pia], 'board')).toEqual([])
    expect(await found(t, [pia], 'r')).toEqual([under(f.sub, f.meta), top(f.meta)])
  })

  it('never shows a parent seen only through an archived sub-project, which lib/access.ts shows', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    await plantGrants(t, pia, [f.sub])
    await t.run((ctx) => ctx.db.patch(f.sub._id, { archived_at: NOW }))
    await ready(t, f)
    await plantStar(t, pia, f.meta)
    expect(await t.run((ctx) => accessOf(ctx, ordinaryOf(pia)).visible(f.meta.id))).toBe(true)
    expect(await found(t, [pia], 'r')).toEqual([])
    // a live sub-project of their own shows the parent again
    await as(t, f.user).mutation(api.projects.setAccess, {
      org_id: f.org.id,
      id: f.sub2.id,
      user_id: pia.id,
      level: 'viewer',
    })
    const meta = await now(t, f.meta.id)
    expect(await found(t, [pia], 'r')).toEqual([top(meta, true), under(f.sub2, f.meta)])
  })

  it('reads the same whatever sub-projects the person cannot see under a parent shown for navigation and under a project they lead as a Viewer, where reading those sub-projects would not', async () => {
    /* One run: Vic, a Viewer, sees Parent only through viewer grants on
     * three of its sub-projects and leads Led from before the rule that
     * Viewers lead nothing, beside `hidden` sub-projects named `prefix`
     * under each that he cannot see. It searches whole, then under a budget
     * a few ranges short of the whole read, and a stand-in that reads the
     * sub-projects of both without asking accessible first. */
    const run = async (hidden: number, prefix: string, short?: number) => {
      const t = newT()
      const f = await withOrg(t)
      const vic = await person(t, f.org.id, 'Vic', { org_role: 'viewer' })
      const [parent, led] = await plantMetas(t, f.org.id, ['Parent', 'Led'])
      await t.run((ctx) => ctx.db.patch(led._id, { lead_id: vic.id }))
      const mine = await plantSubs(t, parent, ['Mine b', 'Mine d', 'Mine f'])
      await plantSubs(t, parent, names(prefix, hidden))
      await plantSubs(t, led, names(prefix, hidden))
      await plantGrants(t, vic, mine, 'viewer')
      await ready(t, f)
      const read = () =>
        measured(t, (ctx) => navSearchOf(ctx, loginOf([vic]), mapOf([vic]), { search: 'mine' }))
      const whole = await read()
      Object.assign(NAMED_READ, { ranges: short ?? whole.read.ranges - 4 })
      const low = await read()
      Object.assign(NAMED_READ, DEFAULT_READ)
      const matches = allWordsMatcher('mine')
      const standIn = await measured(t, async (ctx) => {
        const access = accessOf(ctx, ordinaryOf(vic))
        // the first two streams are the sub-projects of the two parents
        const [ofParent, ofLed] = restCandidates(
          ctx,
          vic,
          [grantee.profile(vic.id)],
          [parent, led],
          null,
        )
        return await readBatch(ctx, {
          stream: (reads) => mergeNamed([ofParent(reads), ofLed(reads)]),
          keep: async (p) =>
            'type' in p && matches(p.name_key ?? '') && (await access.visible(p.id))
              ? p.name
              : null,
          limit: LIST_BATCH,
          through: null,
          ceiling: await namedCeiling(ctx),
        })
      })
      const seen = (answer: typeof whole) => {
        const batch = ok(answer.out)
        return {
          rows: namesOf(batch.rows),
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
    // a reader of those sub-projects reads what the person cannot see
    expect(few.standIn).not.toEqual(many.standIn)
  })
})

/* -------------------------------------------------------------- favorites */

describe('favorites', () => {
  it('lists the matching favorites first, then every other match, a favorite’s sub-project among them without a favorite state', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const tops = await plantMetas(t, f.org.id, [
      'Delta d',
      'alpha d',
      'Charlie d',
      'bravo d',
      'Echo',
      'foxtrot d',
    ])
    const [echoSub] = await plantSubs(t, tops[4], ['Echo d sub'])
    await plantGrants(t, pia, tops)
    await ready(t, f)
    await plantStar(t, pia, tops[4])
    await plantStar(t, pia, tops[3])
    const rows = await found(t, [pia], 'd')
    expect(rows).toEqual([
      top(tops[3], true),
      top(tops[1]),
      top(tops[2]),
      top(tops[0]),
      under(echoSub, tops[4]),
      top(tops[5]),
    ])
    expect(rows).toEqual(await expectedSearch(t, [pia], 'd'))
    expect(await found(t, [pia], 'echo')).toEqual([top(tops[4], true), under(echoSub, tops[4])])
  })

  it('moves a project between the groups in the next answer after a star and an unstar', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await plantLogin(t, await person(t, f.org.id, 'Pia'))
    const tops = await plantMetas(t, f.org.id, ['Ash', 'Birch', 'Cedar'])
    await plantGrants(t, pia, tops)
    await ready(t, f)
    const listed = async () => ok(await find(t, [pia], 'a')).rows.map((r) => [r.name, r.favorite])
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
    ])
    await star(tops[2], false)
    expect(await listed()).toEqual([
      ['Ash', false],
      ['Cedar', false],
    ])
  })

  it('shows no row that fails the reader rule, and keeps its project, where seen and matching, among the rest', async () => {
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
    const [sub] = await plantSubs(t, parent, ['Sub E'])
    await plantGrants(t, pia, [keptA, keptB, shelved, parent, gone])
    await t.run((ctx) => ctx.db.patch(shelved._id, { archived_at: NOW }))
    await ready(t, f)
    await t.run((ctx) => ctx.db.delete(gone._id))
    // copies that differ, another organization, an archived project (live
    // copy and archived copy), a sub-project, a project in Deleted items,
    // lost access and an id another organization's project now holds
    await plantStar(t, pia, keptA, { name_key: 'e stale' })
    await plantStar(t, pia, keptB, { org_id: f.otherOrg.id })
    await plantStar(t, pia, shelved, { live: true })
    await plantStar(t, pia, shelved, { live: false })
    await plantStar(t, pia, sub)
    await plantStar(t, pia, gone)
    await plantStar(t, pia, f.meta)
    await plantStar(t, pia, f.otherProject, { org_id: f.org.id })
    const rows = await found(t, [pia], 'e')
    expect(rows).toEqual([top(keptA), top(keptB), top(parent), under(sub, parent)])
    expect(rows).toEqual(await expectedSearch(t, [pia], 'e'))
  })

  it('reads the same for a favorite whose project the seat lost, whatever shares it holds, where an access check of it would not', async () => {
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
      const read = () =>
        measured(t, (ctx) => navSearchOf(ctx, loginOf([pia]), mapOf([pia]), { search: 's' }))
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

/* --------------------------------------------------------------- the order */

describe('order', () => {
  it("follows the name key's UTF-8 bytes, where JavaScript's order of UTF-16 units differs, and the id for equal names, top-level projects and sub-projects together", async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const face = 'a\u{1F600}'
    const privateUse = 'a\u{E000}'
    const tops = await plantMetas(t, f.org.id, [face, privateUse, 'Same', 'Same'])
    const [holder] = await plantMetas(t, f.org.id, ['Holder'])
    const [same] = await plantSubs(t, holder, ['Same'])
    await plantGrants(t, pia, [...tops, holder])
    await ready(t, f)
    // JavaScript compares UTF-16 units and puts the face first
    expect([privateUse, face].sort()).toEqual([face, privateUse])
    const rows = await found(t, [pia], 'a')
    const sames = [tops[2].id, tops[3].id, same.id].sort((a, b) => compareValues(a, b))
    expect(rows.map((r) => (r.name === 'Same' ? r.id : r.name))).toEqual([
      privateUse,
      face,
      ...sames,
    ])
    expect(rows.find((r) => r.id === same.id)).toEqual(under(same, holder))
    expect(rows).toEqual(await expectedSearch(t, [pia], 'a'))
  })

  it('blends the seats of one login in one order, told apart by organization, favorites of both first, and keeps one seat with org_id', async () => {
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
    const [bravoSub] = await plantSubs(t, bravo, ['Bravo a sub'])
    await plantGrants(t, ann, [alpha, charlie])
    await plantGrants(t, elsewhere, [bravo, delta])
    await ready(t, f)
    const seats = [ann, elsewhere]
    expect((await found(t, seats, 'a')).map((r) => [r.name, r.org_id])).toEqual([
      ['Alpha', f.org.id],
      ['Bravo', f.otherOrg.id],
      ['Bravo a sub', f.otherOrg.id],
      ['Charlie', f.org.id],
      ['Delta', f.otherOrg.id],
    ])
    await plantStar(t, ann, charlie)
    await plantStar(t, elsewhere, delta)
    const rows = await found(t, seats, 'a')
    expect(rows.map((r) => [r.name, r.favorite])).toEqual([
      ['Charlie', true],
      ['Delta', true],
      ['Alpha', false],
      ['Bravo', false],
      ['Bravo a sub', null],
    ])
    expect(rows).toEqual(await expectedSearch(t, seats, 'a'))
    expect(await found(t, seats, 'a', { org_id: f.otherOrg.id })).toEqual([
      top(delta, true),
      top(bravo),
      under(bravoSub, bravo),
    ])
    expect(await found(t, seats, 'a', { org_id: f.otherOrg.id })).toEqual(
      await expectedSearch(t, seats, 'a', f.otherOrg.id),
    )
  })
})

/* ------------------------------------------------------------------ ties */

describe('rows at one position', () => {
  it('shows a sub-project once that its parent’s grant, its own grant, and the seat’s and a team’s child rows all reach', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const bo = await person(t, f.org.id, 'Bo')
    await plantGrants(t, pia, [f.meta, f.sub])
    await plantGrants(t, bo, [f.sub])
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia, bo]), [f.sub])
    await ready(t, f)
    expect(await found(t, [pia], 'firmware')).toEqual([under(f.sub, f.meta)])
    expect(await found(t, [bo], 'firmware')).toEqual([under(f.sub, f.meta)])
  })

  it('skips a child reach row whose copies differ from its sub-project, so a sub-project shows once at its own name, and not at all once every row is stale', async () => {
    const t = newT()
    const f = await withOrg(t)
    const bo = await person(t, f.org.id, 'Bo')
    await plantGrants(t, bo, [f.sub])
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [bo]), [f.sub])
    await ready(t, f)
    /* Gives the child rows on Firmware of `who` a copy of a name key the
     * search for 'stale' matches, which sorts before every other. */
    const stale = (who: 'profile' | 'team') =>
      t.run(async (ctx) => {
        const rows = await ctx.db
          .query('project_reach')
          .withIndex('by_project_grantee', (q) =>
            q.eq('project_id', f.sub.id).eq('grantee_kind', who),
          )
          .collect()
        for (const r of rows) await ctx.db.patch(r._id, { name_key: '0 stale' })
      })
    const listed = async (term: string) => namesOf(await found(t, [bo], term))
    expect(await listed('r')).toEqual(['Firmware', 'Testbed platform'])
    await stale('profile')
    expect(await listed('r')).toEqual(['Firmware', 'Testbed platform'])
    expect(await listed('stale')).toEqual([])
    // a missing or stale row narrows the search and never widens it
    await stale('team')
    expect(await listed('firmware')).toEqual([])
    expect(await listed('stale')).toEqual([])
  })

  it('stops a batch of tied rows under a lowered budget, the merge counting what it drops, and the walk still hands out each once', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [parent] = await plantMetas(t, f.org.id, ['Holder'])
    const subs = await plantSubs(t, parent, names('Sub ', 30))
    await plantGrants(t, pia, [parent, ...subs])
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia]), subs)
    await ready(t, f)
    const want = await found(t, [pia], 'sub')
    expect(namesOf(want)).toEqual(names('Sub ', 30))
    Object.assign(NAMED_READ, { documents: 60 })
    const tight = await walk((after) => find(t, [pia], 'sub', { after }))
    expect(tight.batches.some((b) => b.stopped && b.rows.length < LIST_BATCH)).toBe(true)
    for (const b of tight.batches) if (b.stopped) expect(b.next).not.toBeNull()
    expect(tight.rows).toEqual(want)
    /* A search that matches none of them judges no row, so no check
     * settles the guard and only the merge's count of the two rows it drops
     * beside each sub-project's document stops the batch. 30 documents
     * short of the whole read leaves room for every position counted once
     * and not for the dropped rows. The batch then reads at most its budget
     * and the next row of each of its six streams (favorites, Holder's
     * sub-projects, the child and root rows of Pia and of Red). */
    Object.assign(NAMED_READ, DEFAULT_READ)
    const none = () =>
      measured(t, (ctx) => navSearchOf(ctx, loginOf([pia]), mapOf([pia]), { search: 'zzz' }))
    const whole = await none()
    expect(ok(whole.out)).toMatchObject({ rows: [], next: null, stopped: false })
    const budget = whole.read.documents - 30
    Object.assign(NAMED_READ, { documents: budget })
    const cut = await none()
    expect(ok(cut.out)).toMatchObject({ rows: [], stopped: true })
    expect(cut.read.documents).toBeLessThanOrEqual(budget + 6)
    const quiet = await walk((after) => find(t, [pia], 'zzz', { after }))
    expect(quiet.rows).toEqual([])
    for (const b of quiet.batches) if (b.stopped) expect(b.next).not.toBeNull()
  })
})

/* ---------------------------------------------------------- continuation */

describe('continuation', () => {
  it('hands out every match once over three batches, with renames into and out of the search, a new grant, a new sub-project, a star and an archive between them', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await plantLogin(t, await person(t, f.org.id, 'Pia'))
    const tops = await plantMetas(t, f.org.id, names('P', 40), { lead_id: f.user.id })
    const [holder, zed, late] = await plantMetas(t, f.org.id, ['Holder', 'Zed', 'P030a'], {
      lead_id: f.user.id,
    })
    await plantSubs(
      t,
      holder,
      names('P', 20).map((n) => `${n} sub`),
    )
    await plantGrants(t, pia, [...tops, holder, zed])
    await ready(t, f)
    const org_id = f.org.id
    const lead = as(t, f.user)
    const first = ok(await find(t, [pia], 'p'))
    const opening = names('P', 13)
      .flatMap((n) => [n, `${n} sub`])
      .slice(0, LIST_BATCH)
    expect(namesOf(first.rows)).toEqual(opening)
    // after the first batch come a rename past the cursor from before it,
    // one out of the search and one into it, a new grant, a new
    // sub-project, a star and an archive past it
    const rename = (p: Doc<'projects'>, name: string) =>
      lead.mutation(api.projects.update, { org_id, id: p.id, patch: { name } })
    await rename(tops[30], 'Renamed')
    await rename(tops[5], 'P050a')
    await rename(zed, 'P045z')
    await lead.mutation(api.projects.setAccess, {
      org_id,
      id: late.id,
      user_id: pia.id,
      level: 'user',
    })
    await lead.mutation(api.projects.create, {
      org_id,
      id: uuid(),
      type: 'project',
      parent_id: holder.id,
      key: 'PNEW',
      name: 'P035 new',
      sort_order: 1,
    })
    await as(t, pia).mutation(api.projectNav.setFavorite, {
      org_id,
      project_id: tops[35].id,
      favorite: true,
    })
    await lead.mutation(api.projects.archive, { org_id, id: tops[38].id })
    const subsAfter = names('P', 20)
      .slice(12)
      .map((n) => `${n} sub`)
    const topsAfter = names('P', 40).slice(13)
    const gone = ['P030', 'P035', 'P038']
    const want = [...subsAfter, ...topsAfter, 'P030a', 'P035 new', 'P045z', 'P050a']
      .filter((name) => !gone.includes(name))
      .sort((a, b) => compareValues(nameKey(a), nameKey(b)))
    const onward = await walk((after) => find(t, [pia], 'p', { after: after ?? first.next ?? '' }))
    expect(onward.batches).toHaveLength(2)
    expect(namesOf(onward.rows)).toEqual(want)
    expect(new Set(onward.rows.map((r) => r.id)).size).toBe(onward.rows.length)
    // and a walk from the start answers the rule
    expect(await found(t, [pia], 'p')).toEqual(await expectedSearch(t, [pia], 'p'))
  })

  it("keeps a loaded batch's end with through, also when a match lands inside it, and stops short past four times the batch", async () => {
    const t = newT()
    const f = await withOrg(t)
    const tops = await plantMetas(t, f.org.id, names('P', 130), { lead_id: f.user.id })
    const [inside] = await plantMetas(t, f.org.id, ['P012a'], { lead_id: f.user.id })
    const pia = await person(t, f.org.id, 'Pia')
    await plantGrants(t, pia, tops)
    await ready(t, f)
    const { batches } = await walk((after) => find(t, [pia], 'p', { after }))
    const end = batches[0].next
    const live = ok(await find(t, [pia], 'p', { through: end ?? '' }))
    expect(namesOf(live.rows)).toEqual(names('P', 25))
    expect(await searchAt([pia], 'p', live.next)).toEqual(await searchAt([pia], 'p', end))
    await as(t, f.user).mutation(api.projects.setAccess, {
      org_id: f.org.id,
      id: inside.id,
      user_id: pia.id,
      level: 'user',
    })
    const grown = ok(await find(t, [pia], 'p', { through: end ?? '' }))
    expect(grown.rows).toHaveLength(LIST_BATCH + 1)
    expect(grown.rows[13]).toMatchObject({ name: 'P012a' })
    expect(await searchAt([pia], 'p', grown.next)).toEqual(await searchAt([pia], 'p', end))
    expect(grown.stopped).toBe(false)
    expect(ok(await find(t, [pia], 'p', { after: grown.next ?? '' })).rows[0]).toMatchObject({
      name: 'P025',
    })
    // a through past four batches stops at the hundredth row
    const far = batches[4].next
    const capped = ok(await find(t, [pia], 'p', { through: far ?? '' }))
    expect(capped.rows).toHaveLength(4 * LIST_BATCH)
    expect(capped.stopped).toBe(true)
    expect((await searchAt([pia], 'p', capped.next))?.key).toBe(`${REST}${nameKey('P098')}`)
  })

  it('walks two seats past one batch in the order of the rule, each row once, also when the read budget stops batches', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ann = await person(t, f.org.id, 'Ann')
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'Ann',
      auth_user_id: ann.auth_user_id,
    })
    const all = names('P', 40)
    const here = await plantMetas(t, f.org.id, [...all.filter((_, i) => i % 2 === 0), 'Same p'])
    const there = await plantMetas(t, f.otherOrg.id, [
      ...all.filter((_, i) => i % 2 === 1),
      'Same p',
    ])
    await plantSubs(t, here[0], ['P000 sub'])
    await plantGrants(t, ann, here)
    await plantGrants(t, elsewhere, there)
    await ready(t, f)
    for (const p of [here[3], here[17]]) await plantStar(t, ann, p)
    for (const p of [there[5], there[11]]) await plantStar(t, elsewhere, p)
    const seats = [ann, elsewhere]
    const want = await expectedSearch(t, seats, 'p')
    expect(want).toHaveLength(43)
    const whole = await walk((after) => find(t, seats, 'p', { after }))
    expect(whole.batches).toHaveLength(2)
    expect(whole.rows).toEqual(want)
    const opening = await measured(t, (ctx) =>
      navSearchOf(ctx, loginOf(seats), mapOf(seats), { search: 'p' }),
    )
    Object.assign(NAMED_READ, { ranges: opening.read.ranges - 15 })
    const tight = await walk((after) => find(t, seats, 'p', { after }))
    expect(tight.batches.some((b) => b.stopped && b.rows.length < LIST_BATCH)).toBe(true)
    expect(tight.rows).toEqual(want)
  })

  for (const group of ['favorites', 'rest'] as const)
    it(`shows another seat's ${group} row after a cursor at a rejected row on a reused id of the organization that sorts first`, async () => {
      const t = newT()
      const f = await withOrg(t)
      const [one, two] = [f.org, f.otherOrg].sort((a, b) => compareValues(a.id, b.id))
      const first = await person(t, one.id, 'Ann')
      const second = await plantSeat(t, {
        org_id: two.id,
        name: 'Ann',
        auth_user_id: first.auth_user_id,
      })
      const [shared, later] = await plantMetas(t, two.id, ['Shared', 'Zed shared'])
      await plantGrants(t, second, [shared, later])
      await ready(t, f)
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
      const want = await expectedSearch(t, seats, 'shared')
      expect(want.map((r) => [r.name, r.favorite])).toEqual([
        ['Shared', group === 'favorites'],
        ['Zed shared', false],
      ])
      expect(await found(t, seats, 'shared')).toEqual(want)
      const at = {
        key: (group === 'favorites' ? FAVORITES : REST) + nameKey(shared.name),
        tie: [shared.id, one.id],
      }
      const after = await namedCursor(SEARCH_LIST, [loginOf(seats), '', 'shared'], at)
      expect(ok(await find(t, seats, 'shared', { after })).rows).toEqual(want)
    })

  /* The second seat finds Shared sub through its own child row (a grant on
   * it), or through the sub-projects of Shared (a grant on Shared), and the
   * first seat holds a stale child row on the same id, which the reader
   * rejects. A cursor at that row's position must still let the second
   * seat's sub-project through, so each stream reads from the cursor's id
   * itself. */
  for (const source of ['child', 'inherited'] as const)
    it(`shows another seat's sub-project from its ${source === 'child' ? 'child rows' : "parent's sub-projects"} after a cursor at a rejected child row on a reused id of the organization that sorts first`, async () => {
      const t = newT()
      const f = await withOrg(t)
      const [one, two] = [f.org, f.otherOrg].sort((a, b) => compareValues(a.id, b.id))
      const first = await person(t, one.id, 'Ann')
      const second = await plantSeat(t, {
        org_id: two.id,
        name: 'Ann',
        auth_user_id: first.auth_user_id,
      })
      const [shared, later] = await plantMetas(t, two.id, ['Shared', 'Zed shared'])
      const [sub] = await plantSubs(t, shared, ['Shared sub'])
      await plantGrants(t, second, [source === 'child' ? sub : shared, later])
      await ready(t, f)
      await t.run((ctx) =>
        ctx.db.insert('project_reach', {
          org_id: one.id,
          grantee_kind: 'profile',
          grantee_id: first.id,
          kind: 'child',
          project_id: sub.id,
          root_id: shared.id,
          name_key: nameKey(sub.name),
          key: sub.key,
          live: true,
          on_root: false,
        }),
      )
      const seats = [first, second]
      const want = await expectedSearch(t, seats, 'shared')
      expect(want).toEqual([top(shared), under(sub, shared), top(later)])
      expect(await found(t, seats, 'shared')).toEqual(want)
      const at = { key: REST + nameKey(sub.name), tie: [sub.id, one.id] }
      const after = await namedCursor(SEARCH_LIST, [loginOf(seats), '', 'shared'], at)
      expect(ok(await find(t, seats, 'shared', { after })).rows).toEqual(want.slice(1))
    })
})

/* -------------------------------------------------------------- the budgets */

describe('budgets', () => {
  it('stops a batch at the read budget for a search that matches little, never answering the end, and the walk still hands out every match once', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    // 123 sub-projects over five parents, at most 25 under one
    const parents = await plantMetas(t, f.org.id, names('Holder ', 5))
    const all = [...names('Row ', 120), 'Row 010 match', 'Row 060 match', 'Row 110 match']
    const subs: Doc<'projects'>[] = []
    for (const [i, parent] of parents.entries())
      subs.push(
        ...(await plantSubs(
          t,
          parent,
          all.filter((_, j) => j % parents.length === i),
        )),
      )
    await plantGrants(t, pia, subs)
    await ready(t, f)
    const want = await expectedSearch(t, [pia], 'match')
    expect(namesOf(want)).toEqual(['Row 010 match', 'Row 060 match', 'Row 110 match'])
    expect(await found(t, [pia], 'match')).toEqual(want)
    Object.assign(NAMED_READ, { documents: 40 })
    const { rows, batches } = await walk((after) => find(t, [pia], 'match', { after }))
    expect(rows).toEqual(want)
    expect(batches.some((b) => b.stopped && b.rows.length === 0)).toBe(true)
    for (const b of batches) if (b.stopped) expect(b.next).not.toBeNull()
  })

  /** Pia in two teams that both share sub-project Kid of Parent, with
   * Parent starred or not, and in two others that both share Shared when
   * `top` is set. */
  async function twoTeams(o: { starred?: boolean; top?: boolean } = {}) {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [parent, own] = await plantMetas(t, f.org.id, ['Parent', 'Own'])
    const [kid] = await plantSubs(t, parent, ['Kid'])
    const [shared] = await plantMetas(t, f.org.id, ['Shared'])
    await plantGrants(t, pia, [own])
    for (const name of ['Red', 'Blue'])
      await plantShares(t, await plantTeam(t, f.org.id, name, [pia]), [kid])
    if (o.top === true)
      for (const name of ['Green', 'Gold'])
        await plantShares(t, await plantTeam(t, f.org.id, name, [pia]), [shared])
    await ready(t, f)
    if (o.starred === true) await plantStar(t, pia, parent)
    return { t, pia, parent, kid, own }
  }

  it('refuses whole with access_unchecked where a check stopped: the favorites verdict, the check of the rest, a child row’s and the accessible check before the walk', async () => {
    const lowered = { lookups: 0, members: 0 }
    for (const starred of [true, false]) {
      const { t, pia, parent, kid } = await twoTeams({ starred })
      expect(await found(t, [pia], 'parent')).toEqual([top(parent, starred)])
      expect(await found(t, [pia], 'kid')).toEqual([under(kid, parent)])
      Object.assign(OWN_READS, lowered)
      for (const term of ['parent', 'kid']) {
        const refused = await find(t, [pia], term)
        expect(refused, `${starred} ${term}`).toMatchObject({
          state: 'unavailable',
          reason: ACCESS_UNCHECKED,
        })
        expect(refused).toHaveProperty('message', expect.stringMatching(/could not finish/))
      }
      // a search that matches neither reads neither check
      expect(ok(await find(t, [pia], 'own')).rows.map((r) => r.name)).toEqual(['Own'])
      Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
    }
    // with two teams sharing a top-level project, the check before the
    // walk refuses for every search, also one that matches nothing
    const { t, pia } = await twoTeams({ top: true })
    expect(namesOf(await found(t, [pia], 'shared'))).toEqual(['Shared'])
    Object.assign(OWN_READS, lowered)
    expect(await find(t, [pia], 'zzz')).toMatchObject({ reason: ACCESS_UNCHECKED })
  })

  it('refuses whole where the room for single-row reads ran out (roomSpent)', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [shared] = await plantMetas(t, f.org.id, ['Shared'])
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia]), [shared])
    await ready(t, f)
    expect(await found(t, [pia], 'shared')).toEqual([top(shared)])
    Object.assign(OWN_READS, { teamReads: 0 })
    expect(await find(t, [pia], 'shared')).toMatchObject({
      state: 'unavailable',
      reason: ACCESS_UNCHECKED,
    })
  })

  it("refuses past PROJECT_NAV.teams of a seat's teams, and reads no team of a guest", async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const gus = await person(t, f.org.id, 'Gus', { org_role: 'guest' })
    const [shared] = await plantMetas(t, f.org.id, ['Shared'])
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia, gus]), [shared])
    await plantTeam(t, f.org.id, 'Blue', [pia, gus])
    await plantGrants(t, gus, [shared])
    await ready(t, f)
    expect(await found(t, [pia], 'shared')).toEqual([top(shared)])
    Object.assign(PROJECT_NAV, { teams: 1 })
    expect(await find(t, [pia], 'zzz')).toMatchObject({ reason: ACCESS_UNCHECKED })
    expect(await found(t, [gus], 'shared')).toEqual([top(shared)])
  })

  it('refuses past PROJECT_NAV.rootRows root rows and past PROJECT_NAV.roots projects across the seats, before it reads a project', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ann = await person(t, f.org.id, 'Ann')
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'Ann',
      auth_user_id: ann.auth_user_id,
    })
    const here = await plantMetas(t, f.org.id, ['Here a', 'Here b'])
    const there = await plantMetas(t, f.otherOrg.id, ['There a', 'There b'])
    // a parent shown for navigation holds a root row without on_root
    const [nav] = await plantMetas(t, f.org.id, ['Nav'])
    await plantGrants(t, ann, [...here, ...(await plantSubs(t, nav, ['Nav sub']))])
    await plantGrants(t, elsewhere, there)
    await ready(t, f)
    const seats = [ann, elsewhere]
    /* What the search answers and how many projects it read. */
    const answer = (a: { org_id?: string } = {}) =>
      measured(t, (ctx) => navSearchOf(ctx, loginOf(seats), mapOf(seats), { search: 'zzz', ...a }))
    const open = await answer()
    expect(ok(open.out).rows).toEqual([])
    // five root rows, four of them on_root
    Object.assign(PROJECT_NAV, { rootRows: 5, roots: 4 })
    expect(ok((await answer()).out).next).toBeNull()
    Object.assign(PROJECT_NAV, { rootRows: 4, roots: 4 })
    const rows = await answer()
    expect(rows.out).toMatchObject({ state: 'unavailable', reason: ACCESS_UNCHECKED })
    Object.assign(PROJECT_NAV, { rootRows: 5, roots: 3 })
    const projects = await answer()
    expect(projects.out).toMatchObject({ state: 'unavailable', reason: ACCESS_UNCHECKED })
    // each refused before it read a project, having read the readiness
    // rows, the memberships and the root rows only
    expect(rows.read.ranges).toBeLessThan(8)
    expect(projects.read.ranges).toBeLessThan(8)
    // one seat's search stays inside both bounds
    expect(ok((await answer({ org_id: f.org.id })).out).next).toBeNull()
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
    it(`answers not_ready without ${stamp} for a search of every seat and of that organization, while another organization's answers`, async () => {
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
      const seats = [ann, elsewhere]
      // Testbed platform with its two sub-projects, and Elsewhere
      expect(await found(t, seats, 'e')).toHaveLength(4)
      await unstamp(t, f.org.id, stamp)
      expect(await find(t, seats, 'e')).toEqual({ state: 'not_ready' })
      expect(await find(t, seats, 'e', { org_id: f.org.id })).toEqual({ state: 'not_ready' })
      expect(await found(t, seats, 'e', { org_id: f.otherOrg.id })).toEqual([top(f.otherProject)])
    })

  it('answers an empty last batch for an org_id without the caller’s seat and for a login without a seat', async () => {
    const t = newT()
    const f = await withOrg(t)
    await ready(t, f)
    const empty = { state: 'ok', rows: [], next: null, stopped: false }
    expect(await find(t, [f.user], 'e', { org_id: f.otherOrg.id })).toEqual(empty)
    expect(await find(t, [f.user], 'e', { org_id: uuid() })).toEqual(empty)
    expect(await find(t, [], 'e')).toEqual(empty)
  })
})

/* ---------------------------------------------------------------- no task */

describe('tasks', () => {
  it('reads the same for a matching sub-project with no tasks and with 300 open tasks', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    await plantGrants(t, pia, [f.meta])
    await ready(t, f)
    const reads = async () =>
      (
        await measured(t, (ctx) =>
          navSearchOf(ctx, loginOf([pia]), mapOf([pia]), { search: 'firmware' }),
        )
      ).read
    const before = await reads()
    for (let from = 0; from < 300; from += 150)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 150; i++)
          await insertTask(
            ctx.db,
            {
              id: uuid(),
              org_id: f.org.id,
              project_id: f.sub.id,
              num: 10_000 + i,
              title: `Firmware task ${i}`,
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
    expect(await found(t, [pia], 'firmware')).toEqual([under(f.sub, f.meta)])
  })
})

/* ------------------------------------------------------ the public query */

describe('the public query', () => {
  it('answers for the signed-in login across its active seats, leaving out an inactive seat and an organization being deleted, with cursors of its own login only', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ann = await person(t, f.org.id, 'Ann')
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'Ann',
      auth_user_id: ann.auth_user_id,
    })
    const bo = await person(t, f.org.id, 'Bo')
    const tops = await plantMetas(t, f.org.id, names('Top ', 30))
    const [somewhere] = await plantMetas(t, f.org.id, ['Somewhere'])
    await plantGrants(t, ann, [somewhere, ...tops])
    await plantGrants(t, bo, tops)
    await plantGrants(t, elsewhere, [f.otherProject])
    await ready(t, f)
    const listed = async () =>
      ok(await as(t, ann).query(api.projectNav.search, { search: 'where' })).rows.map(
        (r) => r.org_id,
      )
    // Elsewhere sorts before Somewhere
    expect(await listed()).toEqual([f.otherOrg.id, f.org.id])
    const first = ok(await as(t, ann).query(api.projectNav.search, { search: 'top' }))
    expect(first.next).not.toBeNull()
    expect(
      ok(await as(t, ann).query(api.projectNav.search, { search: 'top', after: first.next ?? '' }))
        .rows,
    ).toHaveLength(5)
    await badRequest(
      as(t, bo).query(api.projectNav.search, { search: 'top', after: first.next ?? '' }),
    )
    await t.run((ctx) => ctx.db.patch(elsewhere._id, { active: false }))
    expect(await listed()).toEqual([f.org.id])
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

  /** What one measured call of a walk read, with its batch's size. */
  type Call = Read & { rows: number; stopped: boolean }

  /** Every batch of the search of `term` for `seats` from its start, each
   * measured, with the cursor each answered. */
  async function searchWalk(t: T, seats: Seats, term: string) {
    const calls: Call[] = []
    const rows: NavSearchRow[] = []
    const cursors: string[] = []
    let after: string | undefined
    for (let round = 0; round < 60; round++) {
      const { out, read } = await measured(t, (ctx: QueryCtx) =>
        navSearchOf(ctx, loginOf(seats), mapOf(seats), { search: term, after }),
      )
      const batch = ok(out)
      calls.push({ ...read, rows: batch.rows.length, stopped: batch.stopped })
      rows.push(...batch.rows)
      if (batch.next === null) return { calls, rows, cursors }
      cursors.push(batch.next)
      after = batch.next
    }
    throw new Error('the search did not end')
  }

  /** The first call of `calls`, the one that read the most ranges, the
   * most of any later call, and how many batches and rows there were. */
  const summary = (calls: readonly Call[]) => {
    const most = (some: readonly Call[]) =>
      some.length === 0 ? null : some.reduce((a, b) => (b.ranges > a.ranges ? b : a))
    return {
      batches: calls.length,
      rows: calls.reduce((n, c) => n + c.rows, 0),
      first: calls[0],
      most: most(calls),
      laterMost: most(calls.slice(1)),
    }
  }

  /** The search of `term` for `seats` from `after` up to `through`,
   * measured. */
  const kept = (t: T, seats: Seats, term: string, a: { after?: string; through: string }) =>
    measured(t, (ctx: QueryCtx) =>
      navSearchOf(ctx, loginOf(seats), mapOf(seats), { search: term, ...a }),
    )

  /** Walks a search that matches nothing and `every`, one that matches
   * every name, and for `every` a batch kept live to 100 rows from the
   * start and one from the first batch's end, each answered whole, and
   * logs the reads. Answers the two walks. */
  async function readsOf(t: T, seats: Seats, every: string, label: string) {
    const nothing = await searchWalk(t, seats, 'zzz')
    expect(nothing.rows).toEqual([])
    whole(nothing.calls)
    const all = await searchWalk(t, seats, every)
    whole(all.calls)
    expect(new Set(all.rows.map((r) => r.id)).size).toBe(all.rows.length)
    const out: Record<string, unknown> = {
      nothing: nothing.calls[0],
      every: summary(all.calls),
    }
    const [firstEnd, , , fourthEnd, fifthEnd] = all.cursors
    if (fourthEnd !== undefined) {
      const live = await kept(t, seats, every, { through: fourthEnd })
      expect(ok(live.out).rows).toHaveLength(4 * LIST_BATCH)
      whole([{ ...live.read, stopped: ok(live.out).stopped }])
      out.through100 = live.read
    }
    if (fifthEnd !== undefined) {
      const later = await kept(t, seats, every, { after: firstEnd, through: fifthEnd })
      expect(ok(later.out).rows).toHaveLength(4 * LIST_BATCH)
      whole([{ ...later.read, stopped: ok(later.out).stopped }])
      out.laterThrough100 = later.read
    }
    console.log(`search, ${label}`, JSON.stringify(out))
    return { nothing, all }
  }

  /** Pia with grants on `live` live top-level projects, the organization's
   * every one: withOrg's two and `live` - 2 planted, `subs` sub-projects
   * under each of the first `under` planted and none under the rest, and
   * on `archived` archived top-level projects too. */
  async function topLevel(live: number, o: { archived?: number; under?: number; subs?: number }) {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const planted = await plantMetas(t, f.org.id, names('Live project ', live - 2))
    const old = await plantMetas(t, f.org.id, names('Archived project ', o.archived ?? 0), {
      archived_at: NOW,
    })
    const subs: Doc<'projects'>[] = []
    for (const p of planted.slice(0, o.under ?? 10))
      subs.push(...(await plantSubs(t, p, names(`${p.name} sub `, o.subs ?? 3))))
    const tops = [f.meta, f.hidden, ...planted]
    await plantGrants(t, pia, [...tops, ...old])
    return { t, f, pia, tops, subs }
  }

  it('searches 200 top-level projects the person holds grants on, every batch, one kept live to 100 rows and a later one', async () => {
    const { t, f, pia } = await topLevel(200, {})
    await ready(t, f)
    const { all } = await readsOf(t, [pia], 'r', '200 projects by grant')
    expect(all.rows).toHaveLength(232)
  })

  it('searches the same 200 as favorites', async () => {
    const { t, f, pia, tops } = await topLevel(200, {})
    await ready(t, f)
    for (const p of tops) await plantStar(t, pia, p)
    const { all } = await readsOf(t, [pia], 'r', '200 favorites')
    expect(all.rows.filter((r) => r.favorite === true)).toHaveLength(200)
  })

  it('reads none of 300 archived top-level projects the person holds grants on, beside 200 live ones', async () => {
    const first = async (archived: number) => {
      const { t, f, pia } = await topLevel(200, { archived })
      await ready(t, f)
      return {
        nothing: await measured(t, (ctx) =>
          navSearchOf(ctx, loginOf([pia]), mapOf([pia]), { search: 'zzz' }),
        ),
        every: await measured(t, (ctx) =>
          navSearchOf(ctx, loginOf([pia]), mapOf([pia]), { search: 'r' }),
        ),
      }
    }
    const without = await first(0)
    const beside = await first(300)
    console.log(
      'search, first batch, 200 live and 300 archived top-level projects',
      JSON.stringify({ nothing: beside.nothing.read, every: beside.every.read }),
    )
    for (const term of ['nothing', 'every'] as const) {
      expect(beside[term].read.ranges).toBe(without[term].read.ranges)
      expect(beside[term].read.documents).toBe(without[term].read.documents)
    }
    expect(ok(beside.every.out).rows).toHaveLength(LIST_BATCH)
  })

  it('searches 200 top-level projects and the 200 sub-projects under them the person reads, the sum of both figures', async () => {
    const { t, f, pia, subs } = await topLevel(200, { under: 67, subs: 3 })
    // 201 planted under 67 parents and withOrg's two under TBED, three too
    // many
    await t.run(async (ctx) => {
      for (const extra of subs.slice(-3)) await ctx.db.delete(extra._id)
    })
    await ready(t, f)
    const { all } = await readsOf(t, [pia], 'r', '200 projects and 200 sub-projects by grant')
    expect(all.rows).toHaveLength(400)
  })

  /** Pia reads 200 live sub-projects under 67 live parents, by grants on
   * the sub-projects or, with `inherited`, on the parents, beside 500
   * archived sub-projects under 167 archived parents she holds grants on
   * the same way, when `archived`. */
  async function subProjects(inherited: boolean, archived: boolean) {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const parents = await plantMetas(t, f.org.id, names('Parent ', 67))
    const subs: Doc<'projects'>[] = []
    for (const p of parents) subs.push(...(await plantSubs(t, p, names(`${p.name} sub `, 3))))
    await t.run((ctx) => ctx.db.delete(subs[200]._id))
    await plantGrants(t, pia, inherited ? parents : subs.slice(0, 200))
    if (archived) {
      const old = await plantMetas(t, f.org.id, names('Old parent ', 167), { archived_at: NOW })
      const oldSubs: Doc<'projects'>[] = []
      for (const p of old)
        oldSubs.push(...(await plantSubs(t, p, names(`${p.name} sub `, 3), { archived_at: NOW })))
      await t.run((ctx) => ctx.db.delete(oldSubs[500]._id))
      await plantGrants(t, pia, inherited ? old : oldSubs.slice(0, 500))
    }
    await ready(t, f)
    return { t, pia }
  }

  for (const inherited of [false, true])
    it(`searches 200 live sub-projects read through grants on ${inherited ? 'their 67 parents' : 'them'}, beside 500 archived ones under 167 archived parents`, async () => {
      const without = await subProjects(inherited, false)
      const beside = await subProjects(inherited, true)
      const how = inherited ? 'inherited from 67 parents' : 'by grants under 67 parents'
      const label = `200 sub-projects ${how}, beside 500 archived`
      const { all } = await readsOf(beside.t, [beside.pia], 'r', label)
      expect(all.rows).toHaveLength(267)
      for (const term of ['zzz', 'r']) {
        const one = (s: { t: T; pia: Doc<'profiles'> }) =>
          measured(s.t, (ctx) =>
            navSearchOf(ctx, loginOf([s.pia]), mapOf([s.pia]), { search: term }),
          )
        const [a, b] = [await one(without), await one(beside)]
        expect(b.read.ranges, term).toBe(a.read.ranges)
        expect(b.read.documents, term).toBe(a.read.documents)
      }
    })

  it('searches beside 500 archived sub-projects the person holds grants on under 167 live parents, which it leaves out, for a search that matches every parent', async () => {
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
    const walked = await searchWalk(t, [pia], 'parent')
    console.log(
      'search, 500 archived sub-projects under 167 live parents, a search matching every parent',
      JSON.stringify(walked.calls),
    )
    expect(walked.rows).toEqual([])
    whole(walked.calls)
    const every = await searchWalk(t, [pia], 'e')
    expect(every.rows).toEqual(tops.map((p) => top(p)))
    whole(every.calls)
  })

  it('searches for a member of 5 teams each sharing 20 sub-projects, every parent shown for navigation only', async () => {
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
    const { all } = await readsOf(t, [pia], 'r', '5 teams sharing 20 sub-projects each')
    expect(all.rows).toHaveLength(134)
  })

  it("searches for one of the person's teams sharing 50 projects of 3 sub-projects each, beside its 150 archived shares", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const live = await plantMetas(t, f.org.id, names('Shared ', 50))
    for (const p of live) await plantSubs(t, p, names(`${p.name} sub `, 3))
    const old = await plantMetas(t, f.org.id, names('Old shared ', 150), { archived_at: NOW })
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia]), [...live, ...old])
    await ready(t, f)
    const label = 'a team sharing 50 live projects of 3 sub-projects and 150 archived'
    const { all } = await readsOf(t, [pia], 'r', label)
    expect(all.rows).toHaveLength(200)
  })

  it('searches 30 live sub-projects under one project the person holds a grant on, beside its 40 archived ones, which it reads none of', async () => {
    const run = async (archived: number) => {
      const t = newT({ transactionLimits: true })
      const f = await withOrg(t)
      const pia = await person(t, f.org.id, 'Pia')
      const [parent] = await plantMetas(t, f.org.id, ['Parent'])
      await plantSubs(t, parent, names('Sub r ', 30))
      await plantSubs(t, parent, names('Aaa archived r ', archived), { archived_at: NOW })
      await plantGrants(t, pia, [parent])
      await ready(t, f)
      return { t, pia }
    }
    const without = await run(0)
    const beside = await run(40)
    const a = await searchWalk(without.t, [without.pia], 'r')
    const b = await searchWalk(beside.t, [beside.pia], 'r')
    console.log('search, 30 live sub-projects beside 40 archived', JSON.stringify(b.calls))
    expect(b.rows).toHaveLength(31)
    whole(b.calls)
    expect(b.calls.map((c) => [c.ranges, c.documents])).toEqual(
      a.calls.map((c) => [c.ranges, c.documents]),
    )
  })

  /* The organization's other sub-projects are 495 live ones, 3 a parent,
   * which withOrg's two and the project's own 3 bring to 500, or 1,000
   * archived ones, 30 a parent. Pia holds a grant on her project alone. */
  for (const [label, count, each, archived] of [
    ['500 live', 495, 3, false],
    ['1,000 archived', 1000, 30, true],
  ] as const)
    it(`reads an everyday person's own projects among ${label} sub-projects of the organization`, async () => {
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
            names(`${p.name} mine `, Math.min(each, others - i * each)),
            archived ? { archived_at: NOW } : {},
          )
        await plantGrants(t, pia, [parent])
        await ready(t, f)
        return await measured(t, (ctx) =>
          navSearchOf(ctx, loginOf([pia]), mapOf([pia]), { search: 'mine' }),
        )
      }
      const without = await run(0)
      const beside = await run(count)
      const read = JSON.stringify(beside.read)
      console.log(`search of an everyday person among ${label} sub-projects`, read)
      expect(ok(beside.out).rows).toHaveLength(4)
      expect(beside.read.ranges).toBe(without.read.ranges)
      expect(beside.read.documents).toBe(without.read.documents)
    })

  it('finds a sub-project of a project shared with 5 teams, with its parent', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [parent] = await plantMetas(t, f.org.id, ['Widely shared'])
    const [sub] = await plantSubs(t, parent, ['Its sub-project'])
    for (let i = 0; i < 5; i++)
      await plantShares(t, await plantTeam(t, f.org.id, `Team ${i}`, i < 3 ? [pia] : []), [parent])
    await ready(t, f)
    const one = await measured(t, (ctx) =>
      navSearchOf(ctx, loginOf([pia]), mapOf([pia]), { search: 'its sub' }),
    )
    console.log('search, a sub-project of a project shared with 5 teams', JSON.stringify(one.read))
    expect(ok(one.out).rows).toEqual([under(sub, parent)])
  })
})

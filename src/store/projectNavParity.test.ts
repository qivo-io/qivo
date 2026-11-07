/* The project navigation reads (convex/projectNav.ts page, children,
 * resolve and search) against the app's own rules. Each case boots the real
 * store from the caller's real workspace, as boardParity.test.ts does, and
 * compares the projects the page lists over every batch, as a set, with
 * P.visibleProjects(), each top-level project's sub-projects with the live
 * children P.canSee keeps, resolve with P.canSee, and the search's rows
 * over every batch for a few searches, as a set, with those projects and
 * children whose name key holds every word of the search, each sub-project
 * with its parent, for Northstar's Leo and Ben with a few stars, and for
 * every access shape of a user, a guest and a Viewer. The store side
 * matches through the server's nameKey, which folds accents and leaves the
 * organization's name out, where the directory today matches the project's
 * and its organization's names as one lowercased text. Every answer is also
 * held to the rule worked out without reach rows
 * (convex/tests/projectNav.setup.ts), favorites included. The store still
 * applies the admin rule, which gives an organization admin every project,
 * while the reads judge everyone by ordinary access (coordinator, 4
 * November 2026), so Nora and the fixture's admin are held to that rule,
 * and the projects the store shows them beyond it are asserted.
 *
 * The stand-in the jsdom tests and the browser benchmark answer the four
 * reads with (store/projectNavStandIn.setup.ts) is held to the real reads
 * here too, batch by batch, rows and order, for the same people and
 * shapes, the admins included, since it judges everyone by ordinary access
 * as the reads do: the page, a batch kept live from the start, each
 * top-level project's sub-projects, each project resolved by id and a few
 * by number, the searches, and the server's refusals. Its star
 * (setFavoriteStandIn) is held to projectNav.setFavorite: a star and an
 * unstar of each live project of the person's organization and of an
 * unknown id, through both, answer alike and leave the same favorites.
 * Northstar's people start with the dataset's stars
 * (internal/marketingDemoData.ts). */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import { TOP_LEVEL_ONLY } from '../../convex/model/projectFavorites'
import {
  BLANK_SEARCH,
  EMPTY_ORG,
  type NavBatch,
  type NavRefusal,
  navChildrenOf,
  navPageOf,
  navResolveOf,
  navSearchOf,
  RESOLVE_FORM,
} from '../../convex/model/projectNavReads'
import { SHAPES } from '../../convex/tests/accessShapes.setup'
import {
  as,
  NOW,
  newT,
  type OrgFixture,
  plantSeat,
  type T,
  uuid,
  withOrg,
  workspaceOf,
} from '../../convex/tests/helpers.setup'
import { keyOrg } from '../../convex/tests/nameKeys.setup'
import { northstarId, plantNorthstar } from '../../convex/tests/northstar.setup'
import {
  expectedChildren,
  expectedPage,
  expectedSearch,
  navSees,
} from '../../convex/tests/projectNav.setup'
import { withReach } from '../../convex/tests/projectReach.setup'
import type { Snapshot } from './plannerFixture.setup'
import {
  NAV_BLANK_SEARCH,
  NAV_EMPTY_ORG,
  NAV_NOT_FOUND,
  NAV_RESOLVE_FORM,
  NAV_TOP_LEVEL_ONLY,
  type ProjectNavArgs,
  type ProjectNavRead,
  projectNavStandIn,
  setFavoriteStandIn,
} from './projectNavStandIn.setup'

vi.hoisted(() => {
  // cursors are sealed with a key derived from it (lib/archiveCursorSeal.ts)
  process.env.BETTER_AUTH_SECRET ??= 'project-nav-parity-secret-not-a-deployment-key'
})

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A fresh store whose first delivery is `snap`. */
async function start(snap: Snapshot) {
  vi.resetModules()
  vi.stubGlobal('window', { showToast: vi.fn() })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  network.onUpdate.mockImplementation((_ref, _args, next) => {
    next(structuredClone(snap))
    return () => {}
  })
  const store = await import('./planner')
  await store.initStore()
  return store.P
}

/** The store booted for `profile` from their workspace. */
async function storeOf(t: T, profile: Doc<'profiles'>) {
  const snap = await workspaceOf(as(t, profile))
  if (snap === null) throw new Error(`no workspace for ${profile.name}`)
  return await start(snap)
}

const sorted = (ids: Iterable<string>) => [...ids].sort()

/** The batch `answer` holds, failing unless it holds one. */
function ok<R>(answer: NavBatch<R> | NavRefusal): NavBatch<R> {
  if (answer.state !== 'ok') throw new Error(`not a batch: ${JSON.stringify(answer)}`)
  return answer
}

/** Every row of a list from its start, following `next`. */
async function rowsOf<R>(read: (after?: string) => Promise<NavBatch<R> | NavRefusal>) {
  const rows: R[] = []
  let after: string | undefined
  for (let round = 0; round < 60; round++) {
    const batch = ok(await read(after))
    rows.push(...batch.rows)
    if (batch.next === null) return rows
    after = batch.next
  }
  throw new Error('the list did not end')
}

/** Every batch's rows of a list from its start, following `next`, without
 * an empty last batch, which the real reads answer where a batch ends
 * just before candidates that do not show and the stand-in does not hold. */
async function batchesOf<R>(read: (after?: string) => Promise<NavBatch<R> | NavRefusal>) {
  const batches: R[][] = []
  let after: string | undefined
  for (let round = 0; round < 60; round++) {
    const batch = ok(await read(after))
    batches.push([...batch.rows])
    if (batch.next === null) return batches.filter((b, i) => b.length > 0 || i === 0)
    after = batch.next
  }
  throw new Error('the list did not end')
}

/** The first batch's rows kept live from the start to its own end. */
async function pinnedFirst<R>(read: (a: ProjectNavArgs) => Promise<NavBatch<R> | NavRefusal>) {
  const first = ok(await read({}))
  return first.next === null ? first.rows : ok(await read({ through: first.next })).rows
}

/** The message a refusal carries, or null when `run` does not refuse. */
async function refusalOf(run: () => unknown): Promise<string | null> {
  try {
    await run()
    return null
  } catch (e) {
    return String((e as { data?: { message?: string } }).data?.message ?? e)
  }
}

/**
 * Holds the stand-in to the four real reads for `profile`, whose workspace
 * it answers from, with `favorites` the projects their seat stars, over
 * every project of their organization and the search for each of `terms`.
 */
async function compareStandIn(
  t: T,
  profile: Doc<'profiles'>,
  label: string,
  terms: readonly string[],
  favorites: readonly string[] = [],
) {
  const snap = await workspaceOf(as(t, profile))
  if (snap === null) throw new Error(`no workspace for ${profile.name}`)
  const seats = new Map([[profile.org_id, profile]])
  const login = profile.auth_user_id ?? 'auth_nobody'
  const mine = async (name: ProjectNavRead, args: ProjectNavArgs) =>
    projectNavStandIn({ ...snap, auth_user_id: login }, name, args, { force: { favorites } })
  const page = (a: ProjectNavArgs) =>
    mine('projectNav:page', a) as Promise<NavBatch<unknown> | NavRefusal>
  expect(await batchesOf((after) => page({ after })), `${label}: stand-in page`).toEqual(
    await batchesOf((after) => t.run((ctx) => navPageOf(ctx, seats, { after }))),
  )
  expect(await pinnedFirst(page), `${label}: stand-in page kept live`).toEqual(
    await pinnedFirst((a) => t.run((ctx) => navPageOf(ctx, seats, a))),
  )
  const projects = await t.run((ctx) =>
    ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', profile.org_id))
      .collect(),
  )
  for (const p of projects) {
    expect(
      await mine('projectNav:resolve', { project_id: p.id }),
      `${label}: resolve ${p.key}`,
    ).toEqual(await t.run((ctx) => navResolveOf(ctx, seats, { project_id: p.id })))
    if (p.parent_id !== undefined) continue
    const real = await t.run((ctx) => navChildrenOf(ctx, seats, { project_id: p.id }))
    if (real.state !== 'ok') {
      expect(await mine('projectNav:children', { project_id: p.id }), label).toEqual(real)
      continue
    }
    const children = (after?: string) =>
      mine('projectNav:children', { project_id: p.id, after }) as Promise<
        NavBatch<unknown> | NavRefusal
      >
    expect(await batchesOf(children), `${label}: stand-in children of ${p.key}`).toEqual(
      await batchesOf((after) =>
        t.run((ctx) => navChildrenOf(ctx, seats, { project_id: p.id, after })),
      ),
    )
  }
  for (const p of projects.slice(0, 3))
    expect(
      await mine('projectNav:resolve', { org_id: p.org_id, num: p.num }),
      `${label}: resolve ${p.key} by number`,
    ).toEqual(await t.run((ctx) => navResolveOf(ctx, seats, { org_id: p.org_id, num: p.num })))
  for (const term of terms) {
    const search = (after?: string) =>
      mine('projectNav:search', { search: term, after }) as Promise<NavBatch<unknown> | NavRefusal>
    expect(await batchesOf(search), `${label}: stand-in search ${term}`).toEqual(
      await batchesOf((after) =>
        t.run((ctx) => navSearchOf(ctx, login, seats, { search: term, after })),
      ),
    )
    const inOrg = (after?: string) =>
      mine('projectNav:search', { search: term, org_id: profile.org_id, after }) as Promise<
        NavBatch<unknown> | NavRefusal
      >
    expect(await batchesOf(inOrg), `${label}: stand-in search ${term} in the organization`).toEqual(
      await batchesOf((after) =>
        t.run((ctx) =>
          navSearchOf(ctx, login, seats, { search: term, org_id: profile.org_id, after }),
        ),
      ),
    )
  }
  // the server's refusals, with the server's sentences
  expect(await refusalOf(() => mine('projectNav:search', { search: ' \u0301 ' }))).toBe(
    BLANK_SEARCH,
  )
  expect(await refusalOf(() => mine('projectNav:search', { search: 'a', org_id: '' }))).toBe(
    EMPTY_ORG,
  )
  expect(await refusalOf(() => mine('projectNav:resolve', { num: 2 }))).toBe(RESOLVE_FORM)
  expect(
    await refusalOf(() => t.run((ctx) => navSearchOf(ctx, login, seats, { search: ' \u0301 ' }))),
  ).toBe(BLANK_SEARCH)
  // a cursor of the page never opens the search
  const first = ok(await page({}))
  if (first.next !== null)
    expect(
      await refusalOf(() => mine('projectNav:search', { search: 'e', after: first.next ?? '' })),
    ).not.toBeNull()
}

describe('the stand-in', () => {
  it('words its refusals as the server does', () => {
    expect([
      NAV_BLANK_SEARCH,
      NAV_EMPTY_ORG,
      NAV_RESOLVE_FORM,
      NAV_NOT_FOUND,
      NAV_TOP_LEVEL_ONLY,
    ]).toEqual([BLANK_SEARCH, EMPTY_ORG, RESOLVE_FORM, 'project not found', TOP_LEVEL_ONLY])
  })
})

/** What a star answered: 'ok', or the refusal's code and sentence. */
async function outcomeOf(run: () => unknown): Promise<string> {
  try {
    await run()
    return 'ok'
  } catch (e) {
    const data = (e as { data?: { code?: string; message?: string } }).data
    return data ? `${data.code}: ${data.message}` : String(e)
  }
}

/** The project ids of `profile`'s favorites rows. */
const favoriteIds = (t: T, profile: Doc<'profiles'>) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('project_favorites')
        .withIndex('by_profile_list', (q) => q.eq('profile_id', profile.id))
        .collect()
    ).map((row) => row.project_id),
  )

/**
 * Stars and then unstars each live project of `profile`'s organization,
 * and an unknown id, through projectNav.setFavorite and through the
 * stand-in's star over a set that starts with the profile's favorites, and
 * holds each answer alike and the favorites each leaves alike. Ends with
 * the favorites the profile had.
 */
async function compareStars(t: T, profile: Doc<'profiles'>, label: string) {
  const snap = await workspaceOf(as(t, profile))
  if (snap === null) throw new Error(`no workspace for ${profile.name}`)
  const had = await favoriteIds(t, profile)
  const favorites = new Set(had)
  const projects = await t.run(async (ctx) =>
    (
      await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', profile.org_id))
        .collect()
    ).filter((p) => p.archived_at === undefined),
  )
  const both = async (project_id: string, favorite: boolean) => {
    const args = { org_id: profile.org_id, project_id, favorite }
    const real = await outcomeOf(() => as(t, profile).mutation(api.projectNav.setFavorite, args))
    const stand = await outcomeOf(() => setFavoriteStandIn(snap, favorites, args))
    expect(stand, `${label}: ${favorite ? 'star' : 'unstar'} ${project_id}`).toBe(real)
    expect(sorted(favorites), `${label}: favorites after ${project_id}`).toEqual(
      sorted(await favoriteIds(t, profile)),
    )
    return real
  }
  const answers = new Set<string>()
  for (const p of [...projects.map((x) => x.id), uuid()]) answers.add(await both(p, true))
  // an unstar always goes through, and leaves only what the profile had
  for (const p of projects) if (!had.includes(p.id)) expect(await both(p.id, false)).toBe('ok')
  expect(sorted(favorites), label).toEqual(sorted(had))
  return answers
}

/**
 * Compares the four reads for `profile` with the store booted from their
 * workspace and with the rule worked out without reach rows, over every
 * project of their organization, the search for each of `terms`. For an
 * admin the store's sets may hold more than the reads; answers how many
 * projects the store shows the profile that the page leaves out
 * (`beyond`), and how many rows the store would match that the searches
 * leave out (`searchBeyond`), both none for anyone else.
 */
async function compare(
  t: T,
  profile: Doc<'profiles'>,
  label: string,
  terms: readonly string[],
  admin = false,
) {
  const P = await storeOf(t, profile)
  const seats = new Map([[profile.org_id, profile]])
  const listed = await rowsOf((after) => t.run((ctx) => navPageOf(ctx, seats, { after })))
  expect(listed, `${label}: page by the rule`).toEqual(await expectedPage(t, [profile]))
  const store = sorted(P.visibleProjects().map((p) => p.id))
  const page = sorted(listed.map((r) => r.id))
  const beyond = store.filter((id) => !page.includes(id))
  // the reads never list a project the store does not show
  const extra = page.filter((id) => !store.includes(id))
  if (admin) expect(extra, label).toEqual([])
  else expect(page, `${label}: page`).toEqual(store)
  const projects = await t.run((ctx) =>
    ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', profile.org_id))
      .collect(),
  )
  for (const p of projects) {
    const sees = await t.run((ctx) => navSees(ctx, profile, p))
    // the store shows what the rule shows, but for an admin's extra sight
    if (!admin)
      expect(P.canSee(p.id) && p.archived_at === undefined, `${label}: ${p.key}`).toBe(sees)
    const resolved = await t.run((ctx) => navResolveOf(ctx, seats, { project_id: p.id }))
    expect(resolved.state, `${label}: resolve ${p.key}`).toBe(sees ? 'ok' : 'unavailable')
    if (p.parent_id !== undefined) continue
    const children = await t.run((ctx) => navChildrenOf(ctx, seats, { project_id: p.id }))
    if (!sees) {
      expect(children, `${label}: children of ${p.key}`).toEqual({ state: 'unavailable' })
      continue
    }
    const got = await rowsOf((after) =>
      t.run((ctx) => navChildrenOf(ctx, seats, { project_id: p.id, after })),
    )
    // the store's admin rule keeps every child, so an admin's are the rule's
    const kept = admin
      ? ((await expectedChildren(t, profile, p)) ?? []).map((c) => c.id)
      : P.projects.filter((c) => c.parent === p.id && P.canSee(c.id)).map((c) => c.id)
    expect(sorted(got.map((c) => c.id)), `${label}: children of ${p.key}`).toEqual(sorted(kept))
  }
  const login = profile.auth_user_id ?? 'auth_nobody'
  let searchBeyond = 0
  for (const term of terms) {
    const rows = await rowsOf((after) =>
      t.run((ctx) => navSearchOf(ctx, login, seats, { search: term, after })),
    )
    expect(rows, `${label}: search ${term} by the rule`).toEqual(
      await expectedSearch(t, [profile], term),
    )
    // the store's projects and their children whose own name matches,
    // each named with its parent
    const matches = allWordsMatcher(nameKey(term))
    const named = (p: { name: string }) => matches(nameKey(p.name))
    const shown = P.visibleProjects()
    const store = sorted([
      ...shown.filter(named).map((p) => `${p.id} in none`),
      ...shown.flatMap((p) =>
        P.projects
          .filter((c) => c.parent === p.id && P.canSee(c.id) && named(c))
          .map((c) => `${c.id} in ${p.id}`),
      ),
    ])
    const found = sorted(rows.map((r) => `${r.id} in ${r.parent?.id ?? 'none'}`))
    // the search never finds a project the store does not show
    expect(
      found.filter((r) => !store.includes(r)),
      `${label}: search ${term}`,
    ).toEqual([])
    if (!admin) expect(found, `${label}: search ${term}`).toEqual(store)
    searchBeyond += store.filter((r) => !found.includes(r)).length
  }
  return { beyond: beyond.length, searchBeyond }
}

/** A favorites row of `seat` on `p` with its copies, as a star writes it. */
const star = (t: T, seat: Doc<'profiles'>, p: Pick<Doc<'projects'>, 'id' | 'name'>) =>
  t.run((ctx) =>
    ctx.db.insert('project_favorites', {
      org_id: seat.org_id,
      profile_id: seat.id,
      project_id: p.id,
      name_key: nameKey(p.name),
      live: true,
      created_at: NOW,
    }),
  )

/* Searches over Northstar's project names: most of them, a top-level
 * project with a sub-project of a name alike, and two words of one
 * sub-project's name. */
const NORTHSTAR_TERMS = ['e', 'launch', 'customer pilot']

/* Searches over withOrg's project names: every one, three, and one
 * sub-project's. */
const SHAPE_TERMS = ['r', 'w', 'board']

describe('Northstar', () => {
  it('lists, expands and resolves what the store shows Leo and Ben, and Nora by ordinary access', async () => {
    const t = newT()
    const { org, profiles } = await plantNorthstar(t)
    await keyOrg(t, org.id)
    await withReach(t)
    const person = async (key: string) => {
      const id = await northstarId(`person:${key}`)
      const p = profiles.find((profile) => profile.id === id)
      if (p === undefined) throw new Error(`no ${key}`)
      return p
    }
    const [nora, leo, ben] = await Promise.all(['nora', 'leo', 'ben'].map(person))
    // the dataset stars Luma Sensor for Leo and Pilot & Launch for Ben and
    // Nora; Leo stars one more of his projects
    const [sensor, launch] = await Promise.all(
      ['project:sensor', 'project:launch'].map(northstarId),
    )
    expect(await favoriteIds(t, leo)).toEqual([sensor])
    expect(await favoriteIds(t, ben)).toEqual([launch])
    expect(await favoriteIds(t, nora)).toEqual([launch])
    const leos = (await storeOf(t, leo)).visibleProjects()
    expect(leos.length).toBeGreaterThan(2)
    const more = leos.find((p) => p.id !== sensor)
    if (more === undefined) throw new Error('Leo sees one project')
    await star(t, leo, more)
    expect(await compare(t, leo, 'Leo', NORTHSTAR_TERMS)).toEqual({ beyond: 0, searchBeyond: 0 })
    expect(await compare(t, ben, 'Ben', NORTHSTAR_TERMS)).toEqual({ beyond: 0, searchBeyond: 0 })
    const leoPage = await expectedPage(t, [leo])
    expect(sorted(leoPage.filter((r) => r.favorite).map((r) => r.id))).toEqual(
      sorted([sensor, more.id]),
    )
    // Nora's star puts Pilot & Launch, last by name, first
    expect((await expectedPage(t, [nora])).map((r) => [r.name, r.favorite])).toEqual([
      ['Pilot & Launch', true],
      ['Luma Cloud', false],
      ['Luma Sensor', false],
    ])
    // the store gives Nora every project and the reads only her ordinary
    // ones, which in Northstar reach every top-level project the store shows
    // and so do her ordinary sub-projects, so the search finds every match
    // the store would
    expect(await compare(t, nora, 'Nora', NORTHSTAR_TERMS, true)).toEqual({
      beyond: 0,
      searchBeyond: 0,
    })
    await compareStandIn(t, leo, 'Leo', NORTHSTAR_TERMS, [sensor, more.id])
    await compareStandIn(t, ben, 'Ben', NORTHSTAR_TERMS, [launch])
    await compareStandIn(t, nora, 'Nora', NORTHSTAR_TERMS, [launch])
    // Leo stars every live project, Firmware a sub-project, and an
    // unknown id, through both
    expect(await compareStars(t, leo, 'Leo')).toEqual(
      new Set(['ok', `bad_request: ${TOP_LEVEL_ONLY}`, 'not_found: project not found']),
    )
  })
})

/** One access case: `shape` planted for a fresh seat of `role`, or the
 * fixture's admin without a shape, with a star on TBED. Answers how many
 * projects the store shows beyond the reads. */
async function compareShape(
  shape: (typeof SHAPES)[number] | null,
  role: 'user' | 'guest' | 'viewer' | 'admin',
): Promise<{ beyond: number; searchBeyond: number; shown: number }> {
  const t = newT()
  const f: OrgFixture = await withOrg(t)
  const subject =
    role === 'admin'
      ? f.admin
      : await plantSeat(t, { org_id: f.org.id, org_role: role, auth_user_id: `auth_${uuid()}` })
  if (shape !== null) await t.run((ctx) => shape[1](ctx, f, subject))
  await keyOrg(t, f.org.id)
  await keyOrg(t, f.otherOrg.id)
  await withReach(t)
  await star(t, subject, f.meta)
  const label = `${role}, ${shape?.[0] ?? 'admin'}`
  const { beyond, searchBeyond } = await compare(t, subject, label, SHAPE_TERMS, role === 'admin')
  await compareStandIn(t, subject, label, SHAPE_TERMS, [f.meta.id])
  await compareStars(t, subject, label)
  const shown = (await expectedPage(t, [subject])).length
  return { beyond, searchBeyond, shown }
}

describe('access shapes', () => {
  for (const role of ['user', 'guest', 'viewer'] as const)
    it(`lists, expands and resolves what the store shows a ${role} in every shape`, async () => {
      let showing = 0
      for (const shape of SHAPES) if ((await compareShape(shape, role)).shown > 0) showing++
      // a guest takes no team shares, so fewer shapes show them anything
      expect(showing).toBeGreaterThan(SHAPES.length / 3)
    })

  it('shows an admin without grants none of the projects the store shows them', async () => {
    // the store's admin rule shows TBED and Skunkworks, and TBED's two
    // sub-projects, which the searches match 7 times; ordinary access, none
    expect(await compareShape(null, 'admin')).toEqual({ beyond: 2, searchBeyond: 7, shown: 0 })
  })
})

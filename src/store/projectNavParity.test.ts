/* The project navigation reads (convex/projectNav.ts page, children and
 * resolve) against the app's own rules. Each case boots the real store from
 * the caller's real workspace, as boardParity.test.ts does, and compares
 * the projects the page lists over every batch, as a set, with
 * P.visibleProjects(), each top-level project's sub-projects with the live
 * children P.canSee keeps, and resolve with P.canSee, for Northstar's Leo
 * and Ben with a few stars, and for every access shape of a user, a guest
 * and a Viewer. Every answer is also held to the rule worked out without
 * reach rows (convex/tests/projectNav.setup.ts), favorites included. The
 * store still applies the admin rule, which gives an organization admin
 * every project, while the reads judge everyone by ordinary access
 * (coordinator, 4 November 2026), so Nora and the fixture's admin are held
 * to that rule, and the projects the store shows them beyond it are
 * asserted. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Doc } from '../../convex/_generated/dataModel'
import { nameKey } from '../../convex/lib/nameKey'
import {
  type NavBatch,
  type NavRefusal,
  navChildrenOf,
  navPageOf,
  navResolveOf,
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
import { expectedChildren, expectedPage, navSees } from '../../convex/tests/projectNav.setup'
import { withReach } from '../../convex/tests/projectReach.setup'
import type { Snapshot } from './plannerFixture.setup'

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

/**
 * Compares the three reads for `profile` with the store booted from their
 * workspace and with the rule worked out without reach rows, over every
 * project of their organization. For an admin the store's sets may hold
 * more than the reads; answers how many projects the store shows the
 * profile that the reads leave out, which is none for anyone else.
 */
async function compare(t: T, profile: Doc<'profiles'>, label: string, admin = false) {
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
  return beyond.length
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
    // Northstar has no stars yet, so Leo stars two of his projects, and Ben
    // one of Leo's he may not see
    const leos = (await storeOf(t, leo)).visibleProjects()
    for (const p of leos.slice(0, 2)) await star(t, leo, p)
    for (const p of leos.slice(-1)) await star(t, ben, p)
    expect(await compare(t, leo, 'Leo')).toBe(0)
    expect(await compare(t, ben, 'Ben')).toBe(0)
    expect(leos.length).toBeGreaterThan(2)
    const leoPage = await expectedPage(t, [leo])
    expect(sorted(leoPage.filter((r) => r.favorite).map((r) => r.id))).toEqual(
      sorted(leos.slice(0, 2).map((p) => p.id)),
    )
    // the store gives Nora every project and the reads only her ordinary
    // ones, which in Northstar reach every top-level project the store shows
    expect(await compare(t, nora, 'Nora', true)).toBe(0)
  })
})

/** One access case: `shape` planted for a fresh seat of `role`, or the
 * fixture's admin without a shape, with a star on TBED. Answers how many
 * projects the store shows beyond the reads. */
async function compareShape(
  shape: (typeof SHAPES)[number] | null,
  role: 'user' | 'guest' | 'viewer' | 'admin',
): Promise<{ beyond: number; shown: number }> {
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
  const beyond = await compare(t, subject, label, role === 'admin')
  const shown = (await expectedPage(t, [subject])).length
  return { beyond, shown }
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
    // the store's admin rule shows TBED and Skunkworks; ordinary access, none
    expect(await compareShape(null, 'admin')).toEqual({ beyond: 2, shown: 0 })
  })
})

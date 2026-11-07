/* The Settings project lists (convex/projectSettings.ts projects,
 * subProjects, archived and archivedSubProjects) against the store's sets
 * that Settings › Projects and Archived projects showed before they read
 * these lists. Each case boots the real store from the caller's real
 * workspace, as projectNavParity.test.ts does, and compares, as sets over
 * every batch: the projects list with P.visibleProjects() and each row's
 * right to a sub-project with the store's New sub-project rule (P.levelOn
 * is 'lead'); each top-level project's sub-projects with the live
 * children P.canSee keeps; Archived projects with P.archivedProjects less
 * the rows beneath an archived parent, each row's parent and its Restore
 * and Delete with the store's `manage`, in the store's order wherever
 * archive times differ; each entry's chips with the store's archived
 * children and `withParent`; and a search for a word with the store's rows
 * whose name key holds it, through the server's nameKey. The cases are
 * Northstar's Nora (an admin), Leo and Ben, with Northstar projects
 * archived as Nora before the store boots, every access shape of a user, a
 * guest and a Viewer with Firmware archived alone and then Testbed
 * platform archived carrying Board rev, and the fixture's admin without a
 * grant. Every answer is also held to the rule worked out without reach
 * rows (convex/tests/projectSettingsLists.setup.ts), and to the stand-in
 * the jsdom tests and the browser benchmark read
 * (store/projectSettingsListsStandIn.setup.ts) over the caller's own
 * workspace: the same rows in the same order, Archived projects by archive
 * time where the server ties equal times by fields the workspace does not
 * carry. Two cases hold the stand-in to the real queries at the design
 * size, 200 live top-level projects for Settings › Projects and the New
 * sub-project dialog's parents and 300 archived ones for Archived
 * projects, and one at everyday values the parents of a user who leads 3
 * projects.
 *
 * Today the store's admin rule (planner.ts levelOnProject) gives an
 * organization admin every project and Lead on each, which is what
 * management sight answers, so the admins' sets equal the store's too. The
 * admin access split removes that rule from the store and replaces these
 * admin expectations with the server rule's alone. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import {
  type SettingsListAnswer,
  settingsArchivedChildrenOf,
  settingsArchivedOf,
  settingsProjectsOf,
  settingsSubProjectsOf,
} from '../../convex/model/projectSettingsLists'
import { SHAPES } from '../../convex/tests/accessShapes.setup'
import {
  as,
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
import { names, plantGrants, plantMetas, ready } from '../../convex/tests/projectNavFixtures.setup'
import { withReach } from '../../convex/tests/projectReach.setup'
import {
  expectedArchived,
  expectedChips,
  expectedProjects,
  expectedSubProjects,
} from '../../convex/tests/projectSettingsLists.setup'
import { projectListsStandIn } from './projectSettingsListsStandIn.setup'
import type { Snapshot } from './workspaceBase'

vi.hoisted(() => {
  // cursors are sealed with a key derived from it (lib/archiveCursorSeal.ts)
  process.env.BETTER_AUTH_SECRET ??= 'project-settings-lists-parity-secret-not-a-deployment-key'
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

const sorted = <V>(values: Iterable<V>) => [...values].map((v) => JSON.stringify(v)).sort()

/** Every row of a list from its start, following `next`. */
async function rowsOf<R>(read: (after?: string) => Promise<SettingsListAnswer<R>>) {
  const rows: R[] = []
  let after: string | undefined
  for (let round = 0; round < 60; round++) {
    const batch = await read(after)
    if (batch.state !== 'ready') throw new Error(`not a batch: ${JSON.stringify(batch)}`)
    rows.push(...batch.rows)
    if (batch.next === null) return rows
    after = batch.next
  }
  throw new Error('the list did not end')
}

/* Searches over withOrg's project names: every one, three, and one
 * sub-project's. */
const SHAPE_TERMS = ['r', 'w', 'board']

/* Searches over Northstar's project names. */
const NORTHSTAR_TERMS = ['e', 'launch', 'customer pilot']

/**
 * Compares the four lists for `profile` with the store booted from their
 * workspace and with the rule worked out without reach rows, over every
 * project of their organization, the searches for each of `terms`
 * included. Answers how many rows the lists held.
 */
async function compare(t: T, profile: Doc<'profiles'>, label: string, terms: readonly string[]) {
  const P = await storeOf(t, profile)
  const me = profile
  const org = me.org_id
  const projects = await rowsOf((after) => t.run((ctx) => settingsProjectsOf(ctx, me, { after })))
  expect(projects, `${label}: projects by the rule`).toEqual(await expectedProjects(t, me))
  const shown = P.visibleProjects().filter((p) => p.org === org)
  expect(
    sorted(projects.map((r) => [r.id, r.can_create_sub_project])),
    `${label}: projects`,
  ).toEqual(sorted(shown.map((p) => [p.id, P.levelOn(p.id) === 'lead'])))
  // Settings shows each project's live children P.canSee keeps
  for (const p of shown) {
    const kids = await rowsOf((after) =>
      t.run((ctx) => settingsSubProjectsOf(ctx, me, { project_id: p.id, after })),
    )
    const want = (p.children ?? [])
      .map((c) => P.project(c))
      .filter((c) => c !== undefined && c !== null && P.canSee(c.id))
      .map((c) => c?.id)
    expect(sorted(kids.map((k) => k.id)), `${label}: sub-projects of ${p.key}`).toEqual(
      sorted(want),
    )
    expect(kids, `${label}: sub-projects of ${p.key} by the rule`).toEqual(
      await expectedSubProjects(t, me, await projectOf(t, p.id)),
    )
  }
  // Archived projects lists the store's rows less those beneath an
  // archived parent, newest first
  const archived = await rowsOf((after) => t.run((ctx) => settingsArchivedOf(ctx, me, { after })))
  expect(archived, `${label}: archived by the rule`).toEqual(await expectedArchived(t, me))
  const all = P.archivedProjects.filter((r) => r.org === org)
  const entries = all.filter((r) => !r.parentArchived)
  expect(
    sorted(archived.map((r) => [r.id, r.parent?.id ?? null, r.can_restore, r.can_delete])),
    `${label}: archived`,
  ).toEqual(sorted(entries.map((r) => [r.id, r.parent ?? null, r.manage, r.manage])))
  expect(
    archived.map((r) => Date.parse(r.archived_at)),
    `${label}: archived order`,
  ).toEqual(entries.map((r) => r.archivedAt))
  for (const entry of entries.filter((r) => r.type === 'meta')) {
    const chips = await rowsOf((after) =>
      t.run((ctx) => settingsArchivedChildrenOf(ctx, me, { project_id: entry.id, after })),
    )
    expect(
      sorted(chips.map((c) => [c.id, c.with_parent])),
      `${label}: chips of ${entry.key}`,
    ).toEqual(sorted(all.filter((c) => c.parent === entry.id).map((c) => [c.id, c.withParent])))
    expect(chips, `${label}: chips of ${entry.key} by the rule`).toEqual(
      await expectedChips(t, me, await projectOf(t, entry.id)),
    )
  }
  let seen = projects.length + archived.length
  for (const term of terms) {
    const matches = allWordsMatcher(nameKey(term))
    const named = (p: { name: string }) => matches(nameKey(p.name))
    const found = await rowsOf((after) =>
      t.run((ctx) => settingsProjectsOf(ctx, me, { search: term, after })),
    )
    expect(found, `${label}: search ${term} by the rule`).toEqual(
      await expectedProjects(t, me, term),
    )
    const store = [
      ...shown.filter(named).map((p) => [p.id, null]),
      ...shown.flatMap((p) =>
        P.projects
          .filter((c) => c.parent === p.id && P.canSee(c.id) && named(c))
          .map((c) => [c.id, p.id]),
      ),
    ]
    expect(
      sorted(found.map((r) => [r.id, r.parent?.id ?? null])),
      `${label}: search ${term}`,
    ).toEqual(sorted(store))
    const foundOld = await rowsOf((after) =>
      t.run((ctx) => settingsArchivedOf(ctx, me, { search: term, after })),
    )
    expect(foundOld, `${label}: archived search ${term} by the rule`).toEqual(
      await expectedArchived(t, me, term),
    )
    expect(
      sorted(foundOld.map((r) => [r.id, r.under])),
      `${label}: archived search ${term}`,
    ).toEqual(sorted(all.filter(named).map((r) => [r.id, r.parentArchived])))
    seen += found.length + foundOld.length
  }
  await compareStandIn(t, profile, label, terms)
  return seen
}

/* ------------------------------------------------------------ the stand-in */

/** Every row of the stand-in's list `name` for `args` over `ws`, from its
 * start, following `next`. */
const standInRows = <R>(ws: Snapshot, name: string, args: Record<string, unknown>) =>
  rowsOf(
    async (after) =>
      projectListsStandIn(ws, name, after === undefined ? args : { ...args, after }) as Awaited<
        SettingsListAnswer<R>
      >,
  )

/** Archived rows' archive times in order: the server ties equal times by
 * _creationTime and _id, which the workspace does not carry, so the rows
 * themselves compare as sets (byId). */
const archiveOrder = (rows: readonly { archived_at: string }[]) => rows.map((r) => r.archived_at)

/** `rows` in id order. */
const byId = <R extends { id: string }>(rows: readonly R[]) =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/**
 * Holds the stand-in over `profile`'s own workspace to the real queries:
 * every list from its start, each search of `terms`, the New sub-project
 * dialog's parents, each listed project's sub-projects and each archived
 * entry's chips, row for row.
 */
async function compareStandIn(
  t: T,
  profile: Doc<'profiles'>,
  label: string,
  terms: readonly string[],
) {
  const ws = await workspaceOf(as(t, profile))
  if (ws === null) throw new Error(`no workspace for ${profile.name}`)
  const me = profile
  const org = { org_id: me.org_id }
  for (const term of ['', ...terms]) {
    const search = term === '' ? {} : { search: term }
    const real = await rowsOf((after) =>
      t.run((ctx) => settingsProjectsOf(ctx, me, { ...search, after })),
    )
    expect(
      await standInRows(ws, 'projectSettings:projects', { ...org, ...search }),
      `${label}: the stand-in's projects ${term}`,
    ).toEqual(real)
    const parents = await rowsOf((after) =>
      t.run((ctx) => settingsProjectsOf(ctx, me, { ...search, sub_project_parents: true, after })),
    )
    expect(
      await standInRows(ws, 'projectSettings:projects', {
        ...org,
        ...search,
        sub_project_parents: true,
      }),
      `${label}: the stand-in's sub-project parents ${term}`,
    ).toEqual(parents)
    const old = await rowsOf((after) =>
      t.run((ctx) => settingsArchivedOf(ctx, me, { ...search, after })),
    )
    const standOld = await standInRows<(typeof old)[number]>(ws, 'projectSettings:archived', {
      ...org,
      ...search,
    })
    expect(byId(standOld), `${label}: the stand-in's archived ${term}`).toEqual(byId(old))
    expect(archiveOrder(standOld), `${label}: the stand-in's archived order ${term}`).toEqual(
      archiveOrder(old),
    )
    if (term !== '') continue
    for (const p of real) {
      const kids = await rowsOf((after) =>
        t.run((ctx) => settingsSubProjectsOf(ctx, me, { project_id: p.id, after })),
      )
      expect(
        await standInRows(ws, 'projectSettings:subProjects', { ...org, project_id: p.id }),
        `${label}: the stand-in's sub-projects of ${p.name}`,
      ).toEqual(kids)
    }
    for (const entry of old.filter((r) => r.parent === null)) {
      const chips = await rowsOf((after) =>
        t.run((ctx) => settingsArchivedChildrenOf(ctx, me, { project_id: entry.id, after })),
      )
      expect(
        await standInRows(ws, 'projectSettings:archivedSubProjects', {
          ...org,
          project_id: entry.id,
        }),
        `${label}: the stand-in's chips of ${entry.name}`,
      ).toEqual(chips)
    }
  }
  // a cursor of another search or filter is refused, as the server refuses it
  const first = projectListsStandIn(ws, 'projectSettings:projects', org, { batch: 1 })
  const next = (first as { next?: string | null }).next
  if (next) {
    for (const other of [{ search: 'x' }, { sub_project_parents: true }])
      expect(() =>
        projectListsStandIn(ws, 'projectSettings:projects', { ...org, ...other, after: next }),
      ).toThrow(/cursors from an earlier answer/)
  }
}

describe('the stand-in at the design size', () => {
  it('lists an admin’s 200 live top-level projects as the real query does, eight batches, and offers each as a parent', async () => {
    const t = newT()
    const f = await withOrg(t)
    // withOrg's two top-level projects, and 198 more, none with sub-projects
    // past withOrg's own, so the 500 live sub-projects stay everyday
    await plantMetas(t, f.org.id, names('Live project ', 198))
    await ready(t, f)
    const ws = await workspaceOf(as(t, f.admin))
    if (ws === null) throw new Error('no workspace')
    const real = await rowsOf((after) =>
      t.run((ctx) => settingsProjectsOf(ctx, f.admin, { after })),
    )
    expect(real).toHaveLength(200)
    expect(await standInRows(ws, 'projectSettings:projects', { org_id: f.org.id })).toEqual(real)
    // the New sub-project dialog's parents: every one, by management
    const parents = await rowsOf((after) =>
      t.run((ctx) => settingsProjectsOf(ctx, f.admin, { sub_project_parents: true, after })),
    )
    expect(parents).toHaveLength(200)
    expect(
      await standInRows(ws, 'projectSettings:projects', {
        org_id: f.org.id,
        sub_project_parents: true,
      }),
    ).toEqual(parents)
  })

  it('offers a user who leads 3 of the organization’s projects those 3 as parents, as the real query does', async () => {
    const t = newT()
    const f = await withOrg(t)
    const lead = await plantSeat(t, {
      org_id: f.org.id,
      org_role: 'user',
      auth_user_id: `auth_${uuid()}`,
    })
    const led = await plantMetas(t, f.org.id, names('Led project ', 3), { lead_id: lead.id })
    // projects the seat sees by a grant but does not lead
    const seen = await plantMetas(t, f.org.id, names('Seen project ', 3))
    await plantGrants(t, lead, seen)
    await ready(t, f)
    const ws = await workspaceOf(as(t, lead))
    if (ws === null) throw new Error('no workspace')
    const parents = await rowsOf((after) =>
      t.run((ctx) => settingsProjectsOf(ctx, lead, { sub_project_parents: true, after })),
    )
    expect(parents.map((r) => r.id).sort()).toEqual(led.map((p) => p.id).sort())
    expect(
      await standInRows(ws, 'projectSettings:projects', {
        org_id: f.org.id,
        sub_project_parents: true,
      }),
    ).toEqual(parents)
  })

  it('lists an admin’s 300 archived top-level projects as the real query does, twelve batches', async () => {
    const t = newT()
    const f = await withOrg(t)
    // archived a second apart, so the order is by archive time alone
    const at = Date.parse('2026-10-01T08:00:00.000Z')
    const old = names('Archived ', 300)
    for (const [i, name] of old.entries())
      await plantMetas(t, f.org.id, [name], { archived_at: new Date(at + i * 1000).toISOString() })
    await ready(t, f)
    const ws = await workspaceOf(as(t, f.admin))
    if (ws === null) throw new Error('no workspace')
    const real = await rowsOf((after) =>
      t.run((ctx) => settingsArchivedOf(ctx, f.admin, { after })),
    )
    expect(real).toHaveLength(300)
    expect(await standInRows(ws, 'projectSettings:archived', { org_id: f.org.id })).toEqual(real)
  })
})

/** The project with id `id` as it is stored now. */
const projectOf = (t: T, id: string) =>
  t.run(async (ctx) => {
    const p = await ctx.db
      .query('projects')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique()
    if (p === null) throw new Error(`no project ${id}`)
    return p
  })

/* A pause of a few milliseconds, so two archives in a row never share an
 * archive time. */
const tick = () => new Promise((done) => setTimeout(done, 3))

/** Archives project `id` as `seat` through projects.archive. */
async function archive(t: T, seat: Doc<'profiles'>, id: string) {
  await as(t, seat).mutation(api.projects.archive, { org_id: seat.org_id, id })
  await tick()
}

describe('Northstar', () => {
  it('lists what Settings shows Nora, Leo and Ben, with a project archived carrying a sub-project, one archived alone before it and a sub-project of a live project', async () => {
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
    // two top-level projects with live sub-projects, Leo's first: the
    // first loses one sub-project to an archive of its own and then is
    // archived with the rest; the second loses one sub-project only
    const tree = await t.run(async (ctx) => {
      const all = await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', org.id))
        .collect()
      const live = all.filter((p) => p.archived_at === undefined)
      return live
        .filter((p) => p.parent_id === undefined && p.type === 'meta')
        .map((p) => ({ p, subs: live.filter((s) => s.parent_id === p.id) }))
        .filter(({ subs }) => subs.length >= 2)
    })
    const leos = new Set((await storeOf(t, leo)).visibleProjects().map((p) => p.id))
    const [first, second] = [
      ...tree.filter(({ p }) => leos.has(p.id)),
      ...tree.filter(({ p }) => !leos.has(p.id)),
    ]
    expect(second).toBeDefined()
    await archive(t, nora, first.subs[0].id)
    await archive(t, nora, first.p.id)
    await archive(t, nora, second.subs[0].id)
    expect(await compare(t, nora, 'Nora', NORTHSTAR_TERMS)).toBeGreaterThan(5)
    expect(await compare(t, leo, 'Leo', NORTHSTAR_TERMS)).toBeGreaterThan(5)
    await compare(t, ben, 'Ben', NORTHSTAR_TERMS)
  })
})

/** One access case: `shape` planted for a fresh seat of `role`, or the
 * fixture's admin without a shape, compared with Firmware archived alone
 * and again with Testbed platform archived carrying Board rev. Answers how
 * many rows the lists held. */
async function compareShape(
  shape: (typeof SHAPES)[number] | null,
  role: 'user' | 'guest' | 'viewer' | 'admin',
) {
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
  const label = `${role}, ${shape?.[0] ?? 'admin'}`
  await archive(t, f.admin, f.sub.id)
  let seen = await compare(t, subject, `${label}, Firmware archived`, SHAPE_TERMS)
  await archive(t, f.admin, f.meta.id)
  seen += await compare(t, subject, `${label}, Testbed platform archived`, SHAPE_TERMS)
  return seen
}

describe('access shapes', () => {
  for (const role of ['user', 'guest', 'viewer'] as const)
    it(`lists what Settings shows a ${role} in every shape`, async () => {
      let showing = 0
      for (const shape of SHAPES) if ((await compareShape(shape, role)) > 0) showing++
      // a guest takes no team shares, so fewer shapes show them anything
      expect(showing).toBeGreaterThan(SHAPES.length / 3)
    })

  it('lists every project for an admin without a grant, as the store’s admin rule shows them', async () => {
    expect(await compareShape(null, 'admin')).toBeGreaterThan(5)
  })
})

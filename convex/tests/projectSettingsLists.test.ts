/* The Settings project lists (projectSettings.ts projects, subProjects,
 * archived and archivedSubProjects, read by model/projectSettingsLists.ts):
 * their arguments and cursors; management sight for an organization
 * admin; ordinary sight in every access shape for a user, a guest and a
 * Viewer, held against the rule worked out without reach rows or the
 * organization's indexes (projectSettingsLists.setup.ts); reads that do not
 * depend on what the person cannot see; each right against the write it
 * names; the archive's hierarchy; search; the parents of a new
 * sub-project; the orders; continuation; the bounds that stop or refuse;
 * readiness; that no task is read; the public queries; and the reads at
 * the design size, one figure a case, under Convex's transaction limits,
 * which the last suite logs. */

import { ConvexError, compareValues } from 'convex/values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { ACCESS_UNCHECKED, hasProjectLevel, OWN_READS } from '../lib/access'
import { newWindowKey } from '../lib/db'
import type { Refusal } from '../lib/functions'
import { LIMITS, LIST_BATCH } from '../lib/limits'
import { NAMED_READ, namedCursor } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { insertTask } from '../model/descriptions'
import { navChildrenOf, PROJECT_NAV } from '../model/projectNavReads'
import type { ListArgs } from '../model/projectSettings'
import {
  NOT_SETTINGS_LIST_CURSOR,
  PROJECT_ADMIN,
  PROJECTS_LIST,
  type SettingsListAnswer,
  type SettingsProjectsArgs,
  settingsArchivedChildrenOf,
  settingsArchivedOf,
  settingsProjectsOf,
  settingsSubProjectsOf,
} from '../model/projectSettingsLists'
import { createProjectCore, unarchiveProjectCore } from '../model/projects'
import { SHAPES } from './accessShapes.setup'
import { as, NOW, newT, type OrgFixture, type T, uuid, withOrg } from './helpers.setup'
import { keyOrg } from './nameKeys.setup'
import {
  badRequest,
  measured,
  names,
  now,
  person,
  plantGrants,
  plantMetas,
  plantShares,
  plantSubs,
  plantTeam,
  type Read,
  ready,
} from './projectNavFixtures.setup'
import { withReach } from './projectReach.setup'
import {
  expectedArchived,
  expectedChips,
  expectedProjects,
  expectedSubProjects,
} from './projectSettingsLists.setup'

/* Cursors are sealed with a key derived from BETTER_AUTH_SECRET
 * (lib/archiveCursorSeal.ts). */
const g = globalThis as unknown as { process: { env: Record<string, string | undefined> } }
g.process.env.BETTER_AUTH_SECRET ??= 'project-settings-lists-test-secret-not-a-deployment-key'

const DEFAULT_READ = { ...NAMED_READ }
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
const DEFAULT_NAV = structuredClone(PROJECT_NAV)
const DEFAULT_ADMIN = structuredClone(PROJECT_ADMIN)
afterEach(() => {
  Object.assign(NAMED_READ, DEFAULT_READ)
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
  Object.assign(PROJECT_NAV, structuredClone(DEFAULT_NAV))
  Object.assign(PROJECT_ADMIN, structuredClone(DEFAULT_ADMIN))
  vi.useRealTimers()
})

/* --------------------------------------------------------------- fixtures */

/** What the four lists answer `seat`, each in its own transaction. */
const lists = {
  projects: (t: T, seat: Doc<'profiles'>, a: SettingsProjectsArgs = {}) =>
    t.run((ctx) => settingsProjectsOf(ctx, seat, a)),
  subs: (t: T, seat: Doc<'profiles'>, project_id: string, a: ListArgs = {}) =>
    t.run((ctx) => settingsSubProjectsOf(ctx, seat, { project_id, ...a })),
  archived: (t: T, seat: Doc<'profiles'>, a: ListArgs = {}) =>
    t.run((ctx) => settingsArchivedOf(ctx, seat, a)),
  chips: (t: T, seat: Doc<'profiles'>, project_id: string, a: ListArgs = {}) =>
    t.run((ctx) => settingsArchivedChildrenOf(ctx, seat, { project_id, ...a })),
}

/** One batch of a Settings list. */
type Batch<R> = Extract<SettingsListAnswer<R>, { state: 'ready' }>

/** The batch `answer` holds, failing unless it holds one. */
function batchOf<R>(answer: SettingsListAnswer<R>): Batch<R> {
  if (answer.state !== 'ready') throw new Error(`not a batch: ${JSON.stringify(answer)}`)
  return answer
}

/** Every batch of a list from its start, following `next`. */
async function walked<R>(read: (after?: string) => Promise<SettingsListAnswer<R>>, most = 80) {
  const rows: R[] = []
  const batches: Batch<R>[] = []
  let after: string | undefined
  for (let round = 0; round < most; round++) {
    const batch = batchOf(await read(after))
    batches.push(batch)
    rows.push(...batch.rows)
    if (batch.next === null) return { rows, batches }
    after = batch.next
  }
  throw new Error('the list did not end')
}

/** Every row of a list, or its answer when that is not a batch. */
async function rowsOr<R>(read: (after?: string) => Promise<SettingsListAnswer<R>>) {
  const first = await read()
  if (first.state !== 'ready') return first
  return (await walked(read)).rows
}

/** The profile `seat` as it is stored now, as the wrapper reads it. */
const seatNow = (t: T, seat: Doc<'profiles'>) =>
  t.run(async (ctx) => {
    const p = await ctx.db.get(seat._id)
    if (p === null) throw new Error(`no profile ${seat.id}`)
    return p
  })

/** Whether `write` passes, run in a transaction thrown away whatever it
 * does, so a right is held to the write itself without changing the
 * fixture. Only a refusal (ConvexError) counts as not passing. */
async function passes(t: T, write: (ctx: MutationCtx) => Promise<unknown>): Promise<boolean> {
  const e = await t
    .run(async (ctx) => {
      let ok = true
      try {
        await write(ctx)
      } catch (error) {
        if (!(error instanceof ConvexError)) throw error
        ok = false
      }
      throw new Error(ok ? 'thrown away: passed' : 'thrown away: refused')
    })
    .then(
      () => null,
      (error: unknown) => error,
    )
  const message = e instanceof Error ? e.message : String(e)
  if (message.includes('thrown away: passed')) return true
  if (message.includes('thrown away: refused')) return false
  throw new Error(`the write failed: ${message}`)
}

/* A pause of a few milliseconds, so two archives in a row never share an
 * archive time, which would carry a sub-project archived alone with its
 * parent. */
const tick = () => new Promise((done) => setTimeout(done, 3))

/** Archives project `id` as `seat` through projects.archive. */
async function archive(t: T, seat: Doc<'profiles'>, id: string) {
  await as(t, seat).mutation(api.projects.archive, { org_id: seat.org_id, id })
  await tick()
}

/** Restores project `id` as `seat` through projects.unarchive. */
async function restore(t: T, seat: Doc<'profiles'>, id: string) {
  await as(t, seat).mutation(api.projects.unarchive, { org_id: seat.org_id, id })
  await tick()
}

/** The names of `rows`, in order. */
const namesOf = (rows: readonly { name: string }[]) => rows.map((r) => r.name)

/** Searches over withOrg's project names: every one, one sub-project's,
 * and none. */
const SHAPE_TERMS = ['r', 'board', 'zzz']

/** Every list for `seat` over withOrg's projects held to the rule, the
 * sub-projects and chips of each of its top-level projects and of another
 * organization's included. Answers how many rows the lists held. */
async function compareAll(t: T, f: OrgFixture, seat: Doc<'profiles'>, label: string) {
  let seen = 0
  for (const term of ['', ...SHAPE_TERMS]) {
    const rows = await rowsOr((after) => lists.projects(t, seat, { search: term, after }))
    expect(rows, `${label}: projects ${term}`).toEqual(await expectedProjects(t, seat, term))
    seen += Array.isArray(rows) ? rows.length : 0
    const archived = await rowsOr((after) => lists.archived(t, seat, { search: term, after }))
    expect(archived, `${label}: archived ${term}`).toEqual(await expectedArchived(t, seat, term))
    seen += Array.isArray(archived) ? archived.length : 0
  }
  const parents = await rowsOr((after) =>
    lists.projects(t, seat, { sub_project_parents: true, after }),
  )
  expect(parents, `${label}: parents`).toEqual(await expectedProjects(t, seat, '', true))
  for (const p of [f.meta, f.hidden, f.otherProject]) {
    const kids = await rowsOr((after) => lists.subs(t, seat, p.id, { after }))
    const want = await expectedSubProjects(t, seat, p)
    expect(kids, `${label}: sub-projects of ${p.key}`).toEqual(want ?? { state: 'unavailable' })
    const chips = await rowsOr((after) => lists.chips(t, seat, p.id, { after }))
    const wanted = await expectedChips(t, seat, p)
    expect(chips, `${label}: chips of ${p.key}`).toEqual(wanted ?? { state: 'unavailable' })
  }
  return seen
}

/* ----------------------------------------------------------- the arguments */

describe('arguments', () => {
  /** An organization where every list holds two batches or more for Pia
   * and for the admin: 30 top-level projects with grants, one with 30
   * sub-projects, 60 archived top-level projects with grants, one with 30
   * archived sub-projects beneath it. */
  async function twoBatches() {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const tops = await plantMetas(t, f.org.id, names('Top ', 30))
    await plantSubs(t, tops[0], names('Sub ', 30))
    const old = await plantMetas(t, f.org.id, names('Old ', 60), { archived_at: NOW })
    await plantSubs(t, old[0], names('Chip ', 30), { archived_at: NOW })
    await plantGrants(t, pia, [...tops, ...old])
    await ready(t, f)
    return { t, f, pia, tops, old }
  }

  it('refuses a search past LIMITS.search with its sentence and a cursor that is not one before it reads anything, and browses for a blank search', async () => {
    const { t, f, pia } = await twoBatches()
    const refused = (read: (ctx: QueryCtx) => Promise<unknown>) =>
      t.run(async (ctx) => {
        const e = await read(ctx).then(
          () => null,
          (error: unknown) => error,
        )
        const m = await ctx.meta.getTransactionMetrics()
        if (!(e instanceof ConvexError)) throw new Error(`expected a refusal, got ${String(e)}`)
        return { data: e.data as Refusal, ranges: m.databaseQueries.used }
      })
    const long = 'a'.repeat(LIMITS.search.max + 1)
    for (const read of [
      (ctx: QueryCtx) => settingsProjectsOf(ctx, pia, { search: long }),
      (ctx: QueryCtx) => settingsArchivedOf(ctx, pia, { search: long }),
    ])
      expect(await refused(read)).toEqual({
        data: { code: 'rule', message: LIMITS.search.refusal },
        ranges: 0,
      })
    for (const read of [
      (ctx: QueryCtx) => settingsProjectsOf(ctx, pia, { after: 'nope' }),
      (ctx: QueryCtx) => settingsSubProjectsOf(ctx, pia, { project_id: f.meta.id, after: 'nope' }),
      (ctx: QueryCtx) => settingsArchivedOf(ctx, pia, { through: 'nope' }),
      (ctx: QueryCtx) =>
        settingsArchivedChildrenOf(ctx, pia, { project_id: f.meta.id, after: 'nope' }),
    ])
      expect(await refused(read)).toEqual({
        data: { code: 'bad_request', message: NOT_SETTINGS_LIST_CURSOR },
        ranges: 0,
      })
    // a search of spaces or accents alone browses
    for (const seat of [pia, f.admin])
      for (const blank of ['   ', '́']) {
        expect(await lists.projects(t, seat, { search: blank })).toEqual(
          await lists.projects(t, seat),
        )
        expect(await lists.archived(t, seat, { search: blank })).toEqual(
          await lists.archived(t, seat),
        )
      }
  })

  it('opens a cursor only for its own list, organization, project, search and filter, and a through only after after in its direction', async () => {
    const { t, f, pia, tops, old } = await twoBatches()
    for (const seat of [pia, f.admin]) {
      const label = seat.org_role
      const projects = batchOf(await lists.projects(t, seat)).next ?? ''
      const searched = batchOf(await lists.projects(t, seat, { search: 'top' })).next ?? ''
      const parents =
        batchOf(await lists.projects(t, f.admin, { sub_project_parents: true })).next ?? ''
      const subs = batchOf(await lists.subs(t, seat, tops[0].id)).next ?? ''
      const archivedFirst = batchOf(await lists.archived(t, seat))
      const archived = archivedFirst.next ?? ''
      const chips = batchOf(await lists.chips(t, seat, old[0].id)).next ?? ''
      for (const cursor of [projects, searched, parents, subs, archived, chips])
        expect(cursor, label).not.toBe('')
      const refusals = [
        lists.projects(t, seat, { after: archived }),
        lists.projects(t, seat, { after: subs }),
        lists.projects(t, seat, { after: searched }),
        lists.projects(t, seat, { search: 'top', after: projects }),
        lists.projects(t, seat, { sub_project_parents: true, after: projects }),
        lists.projects(t, seat, { after: parents }),
        lists.subs(t, seat, tops[1].id, { after: subs }),
        lists.subs(t, seat, tops[0].id, { after: projects }),
        lists.archived(t, seat, { after: projects }),
        lists.archived(t, seat, { search: 'old', after: archived }),
        lists.chips(t, seat, old[1].id, { after: chips }),
        lists.chips(t, seat, old[0].id, { after: subs }),
      ]
      for (const [i, refusal] of refusals.entries())
        expect(await badRequest(refusal), `${label}: ${i}`).toBe(NOT_SETTINGS_LIST_CURSOR)
      // a cursor of the same position for another organization
      const elsewhere = await namedCursor(PROJECTS_LIST, [f.otherOrg.id, '', ''], {
        key: nameKey('Top 010'),
        tie: [tops[10].id, f.otherOrg.id],
      })
      expect(await badRequest(lists.projects(t, seat, { after: elsewhere }))).toBe(
        NOT_SETTINGS_LIST_CURSOR,
      )
      // the same position sealed for this organization opens
      const own = await namedCursor(PROJECTS_LIST, [f.org.id, '', ''], {
        key: nameKey('Top 010'),
        tie: [tops[10].id, f.org.id],
      })
      expect(namesOf(batchOf(await lists.projects(t, seat, { after: own })).rows)[0]).toBe(
        'Top 011',
      )
      // projectNav.children's cursors never open here
      const nav = await t.run((ctx) =>
        navChildrenOf(ctx, new Map([[pia.org_id, pia]]), { project_id: tops[0].id }),
      )
      const navNext = nav.state === 'ok' ? nav.next : null
      expect(navNext).not.toBeNull()
      expect(await badRequest(lists.subs(t, seat, tops[0].id, { after: navNext ?? '' }))).toBe(
        NOT_SETTINGS_LIST_CURSOR,
      )
      // a through not after after, in each list's direction
      expect(
        await badRequest(lists.projects(t, seat, { after: projects, through: projects })),
      ).toBe('through must be a cursor after the one in after')
      expect(
        await badRequest(lists.archived(t, seat, { after: archived, through: archived })),
      ).toBe('through must be a cursor after the one in after')
      const later = batchOf(await lists.archived(t, seat, { after: archived })).next
      expect(later).not.toBeNull()
      // newest first: the first batch's end comes before a later one's
      expect(
        await badRequest(lists.archived(t, seat, { after: later ?? '', through: archived })),
      ).toBe('through must be a cursor after the one in after')
      const kept = batchOf(await lists.archived(t, seat, { after: archived, through: later ?? '' }))
      expect(kept.rows).toEqual(batchOf(await lists.archived(t, seat, { after: archived })).rows)
      expect(kept.next).toBe(later)
      const live = batchOf(await lists.archived(t, seat, { through: archived }))
      expect(live.rows).toEqual(archivedFirst.rows)
      expect(live.next).toBe(archived)
    }
  })

  it('refuses a caller without a seat in org_id at the wrapper, and answers the signed-in seat', async () => {
    const t = newT()
    const f = await withOrg(t)
    await ready(t, f)
    await expect(
      as(t, f.otherAdmin).query(api.projectSettings.projects, { org_id: f.org.id }),
    ).rejects.toThrow()
    await expect(
      as(t, f.otherAdmin).query(api.projectSettings.archived, { org_id: f.org.id }),
    ).rejects.toThrow()
    await expect(
      as(t, f.otherAdmin).query(api.projectSettings.subProjects, {
        org_id: f.org.id,
        project_id: f.meta.id,
      }),
    ).rejects.toThrow()
    await expect(
      as(t, f.otherAdmin).query(api.projectSettings.archivedSubProjects, {
        org_id: f.org.id,
        project_id: f.meta.id,
      }),
    ).rejects.toThrow()
    const rows = batchOf(
      await as(t, f.user).query(api.projectSettings.projects, { org_id: f.org.id }),
    ).rows
    expect(namesOf(rows)).toEqual(['Skunkworks', 'Testbed platform'])
    expect(
      await as(t, f.user).query(api.projectSettings.subProjects, {
        org_id: f.org.id,
        project_id: f.meta.id,
      }),
    ).toEqual(await lists.subs(t, f.user, f.meta.id))
    expect(await as(t, f.user).query(api.projectSettings.archived, { org_id: f.org.id })).toEqual({
      state: 'ready',
      rows: [],
      next: null,
      stopped: false,
    })
    expect(
      await as(t, f.user).query(api.projectSettings.archivedSubProjects, {
        org_id: f.org.id,
        project_id: f.meta.id,
      }),
    ).toEqual({ state: 'unavailable' })
  })
})

/* ------------------------------------------------------- management sight */

describe('management sight', () => {
  it("lists every project of an admin's organization with every right, without a grant, a lead or a share, and none outside a meta's tree or of another organization", async () => {
    const t = newT()
    const f = await withOrg(t)
    const [alpha, old] = await plantMetas(t, f.org.id, ['Alpha', 'Old works'])
    const [loose] = await plantMetas(t, f.org.id, ['Loose work'], { type: 'project' })
    const [deep] = await plantSubs(t, f.sub, ['Deep work'])
    const [orphan] = await plantMetas(t, f.org.id, ['Orphan work'], {
      type: 'project',
      parent_id: uuid(),
    })
    const [retired] = await plantSubs(t, alpha, ['Retired work'], { archived_at: NOW })
    const [part] = await plantSubs(t, old, ['Old part'])
    // the same three shapes archived, which every Archived projects list
    // leaves out too
    await plantMetas(t, f.org.id, ['Loose old'], { type: 'project', archived_at: NOW })
    await plantSubs(t, f.sub, ['Deep old'], { archived_at: NOW })
    await plantMetas(t, f.org.id, ['Orphan old'], {
      type: 'project',
      parent_id: uuid(),
      archived_at: NOW,
    })
    await ready(t, f)
    await archive(t, f.admin, old.id)
    const admin = await seatNow(t, f.admin)
    // the admin holds no level of their own on any project
    expect(await expectedProjects(t, { ...admin, org_role: 'user' })).toEqual([])
    const tops = await walked((after) => lists.projects(t, admin, { after }))
    expect(namesOf(tops.rows)).toEqual(['Alpha', 'Skunkworks', 'Testbed platform'])
    expect(tops.rows.every((r) => r.can_create_sub_project && r.parent === null)).toBe(true)
    const work = await walked((after) => lists.projects(t, admin, { search: 'work', after }))
    expect(namesOf(work.rows)).toEqual(['Skunkworks'])
    const r = await walked((after) => lists.projects(t, admin, { search: 'r', after }))
    expect(namesOf(r.rows)).toEqual(['Board rev', 'Firmware', 'Skunkworks', 'Testbed platform'])
    expect(r.rows.find((row) => row.id === f.sub.id)?.parent).toEqual({
      id: f.meta.id,
      name: f.meta.name,
      num: f.meta.num,
    })
    expect(namesOf(batchOf(await lists.subs(t, admin, f.meta.id)).rows)).toEqual([
      'Board rev',
      'Firmware',
    ])
    for (const p of [loose, f.sub, deep, orphan, old, f.otherProject])
      expect(await lists.subs(t, admin, p.id), p.name).toEqual({ state: 'unavailable' })
    const archived = batchOf(await lists.archived(t, admin)).rows
    expect(
      archived.map((row) => [row.name, row.parent?.name ?? null, row.has_sub_projects]),
    ).toEqual([
      ['Old works', null, true],
      ['Retired work', 'Alpha', null],
    ])
    expect(archived.every((row) => row.can_restore && row.can_delete)).toBe(true)
    const oldOnes = await walked((after) => lists.archived(t, admin, { search: 'old', after }))
    expect(namesOf(oldOnes.rows).sort()).toEqual(['Old part', 'Old works'])
    expect(batchOf(await lists.archived(t, admin, { search: 'part' })).rows).toEqual([
      expect.objectContaining({
        id: part.id,
        under: true,
        with_parent: true,
        parent: { id: old.id, name: old.name, num: old.num },
        can_restore: true,
        can_delete: false,
      }),
    ])
    expect(batchOf(await lists.chips(t, admin, old.id)).rows).toEqual([
      { id: part.id, name: 'Old part', num: part.num, with_parent: true },
    ])
    expect(await lists.chips(t, admin, retired.id)).toEqual({ state: 'unavailable' })
    expect(await compareAll(t, f, admin, 'admin')).toBeGreaterThan(10)
    // the other organization's admin sees only theirs
    expect(namesOf(batchOf(await lists.projects(t, f.otherAdmin)).rows)).toEqual(['Elsewhere'])
    expect(await lists.subs(t, f.otherAdmin, f.meta.id)).toEqual({ state: 'unavailable' })
  })

  it('reads none of the seat’s own rows, so a lowered bound of them never refuses an admin', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [old] = await plantMetas(t, f.org.id, ['Old'], { archived_at: NOW })
    await plantSubs(t, old, ['Old part'], { archived_at: NOW })
    await ready(t, f)
    Object.assign(OWN_READS, { lookups: 0, members: 0, teamReads: 0, rows: 0 })
    Object.assign(PROJECT_NAV, { teams: 0, children: 0, rootRows: 0, roots: 0 })
    Object.assign(PROJECT_ADMIN, { collect: { ranges: 1, documents: 1, bytes: 1 } })
    expect(await compareAll(t, f, f.admin, 'admin with lowered bounds')).toBeGreaterThan(5)
  })
})

/* -------------------------------------------------------- ordinary sight */

/** One access case: `shape` planted for a fresh seat of `role`, every list
 * compared live, after Firmware is archived alone, and after Testbed
 * platform is archived carrying Board rev. Answers how many rows the lists
 * held. */
async function compareShape(shape: (typeof SHAPES)[number], role: 'user' | 'guest' | 'viewer') {
  const t = newT()
  const f = await withOrg(t)
  const subject = await person(t, f.org.id, 'Subject', { org_role: role })
  await t.run((ctx) => shape[1](ctx, f, subject))
  await ready(t, f)
  const label = `${role}, ${shape[0]}`
  let seen = await compareAll(t, f, subject, `${label}, live`)
  await archive(t, f.admin, f.sub.id)
  seen += await compareAll(t, f, subject, `${label}, Firmware archived`)
  await archive(t, f.admin, f.meta.id)
  seen += await compareAll(t, f, subject, `${label}, Testbed platform archived`)
  return seen
}

describe('ordinary sight', () => {
  for (const role of ['user', 'guest', 'viewer'] as const)
    it(`lists by the rule for a ${role} in every access shape, live and archived`, async () => {
      let showing = 0
      for (const shape of SHAPES) if ((await compareShape(shape, role)) > 0) showing++
      // a guest takes no team shares, so fewer shapes show them anything
      expect(showing).toBeGreaterThan(SHAPES.length / 3)
    })

  it('shows a parent seen only through an archived sub-project as an entry without rights, its chips only those the person sees, and names a live parent seen only for navigation', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    await plantGrants(t, pia, [f.sub])
    await ready(t, f)
    await archive(t, f.user, f.sub.id)
    // Firmware archived alone is an entry under the live parent it names,
    // which the projects list leaves out
    expect(batchOf(await lists.archived(t, pia)).rows).toEqual([
      expect.objectContaining({
        id: f.sub.id,
        parent: { id: f.meta.id, name: f.meta.name, num: f.meta.num },
        under: false,
        can_restore: false,
        can_delete: false,
      }),
    ])
    expect(batchOf(await lists.projects(t, pia)).rows).toEqual([])
    await archive(t, f.user, f.meta.id)
    expect(batchOf(await lists.archived(t, pia)).rows).toEqual([
      expect.objectContaining({
        id: f.meta.id,
        parent: null,
        has_sub_projects: true,
        can_restore: false,
        can_delete: false,
      }),
    ])
    expect(batchOf(await lists.chips(t, pia, f.meta.id)).rows).toEqual([
      { id: f.sub.id, name: f.sub.name, num: f.sub.num, with_parent: false },
    ])
    expect(batchOf(await lists.archived(t, pia, { search: 'board' })).rows).toEqual([])
    expect(batchOf(await lists.archived(t, pia, { search: 'firm' })).rows).toEqual([
      expect.objectContaining({
        id: f.sub.id,
        under: true,
        with_parent: false,
        can_restore: false,
      }),
    ])
    // the lead of the parent restores it, and so the search hit through it
    expect(batchOf(await lists.archived(t, f.user, { search: 'firm' })).rows).toEqual([
      expect.objectContaining({ id: f.sub.id, can_restore: true, can_delete: false }),
    ])
    expect(batchOf(await lists.chips(t, f.user, f.meta.id)).rows).toHaveLength(2)
    expect(await lists.chips(t, f.guest, f.hidden.id)).toEqual({ state: 'unavailable' })
  })

  it('shows nothing through a Viewer’s old lead or a stale reach row', async () => {
    const t = newT()
    const f = await withOrg(t)
    const vic = await person(t, f.org.id, 'Vic', { org_role: 'viewer' })
    const pia = await person(t, f.org.id, 'Pia')
    const [led, oldLed] = await plantMetas(t, f.org.id, ['Viewer led', 'Old viewer led'], {
      lead_id: vic.id,
    })
    await plantSubs(t, led, ['Viewer led part'])
    await plantSubs(t, oldLed, ['Old viewer led part'])
    await ready(t, f)
    await archive(t, f.admin, oldLed.id)
    const archived = await now(t, oldLed.id)
    // root rows of Pia's, live and archived, that no source keeps
    await t.run(async (ctx) => {
      for (const p of [f.hidden, archived])
        await ctx.db.insert('project_reach', {
          org_id: f.org.id,
          grantee_kind: 'profile',
          grantee_id: pia.id,
          kind: 'root',
          project_id: p.id,
          root_id: p.id,
          name_key: nameKey(p.name),
          key: p.key,
          live: p.archived_at === undefined,
          on_root: true,
        })
    })
    for (const who of [vic, pia]) {
      expect(await compareAll(t, f, who, who.name)).toBe(0)
      expect(await lists.chips(t, who, oldLed.id)).toEqual({ state: 'unavailable' })
    }
  })
})

/* ------------------------------------------------------------- fail closed */

describe('fail closed', () => {
  /** One backend: Pia in organization twin-org, with what she sees planted
   * first, every id fixed and the clock held still, so a second backend
   * holds those rows at the same _id and _creationTime. With `hidden`,
   * projects she cannot see are planted after them: live and archived
   * top-level projects, live and archived sub-projects under a parent she
   * sees only for navigation, and archived ones beneath an archived parent
   * she sees only through one of them. */
  async function twin(hidden: boolean) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'))
    const t = newT({ transactionLimits: true })
    const org = 'twin-org'
    let num = 1
    const project = (
      id: string,
      name: string,
      extra: Partial<Doc<'projects'>> = {},
    ): Omit<Doc<'projects'>, '_id' | '_creationTime'> => ({
      id: `twin-${id}`,
      org_id: org,
      type: 'meta',
      key: `T${num}`,
      name,
      description: '',
      sort_order: num,
      num: num++,
      track_delay: false,
      created_at: NOW,
      window_key: 'twinwkey',
      ...extra,
    })
    const pia = await t.run(async (ctx) => {
      await ctx.db.insert('organizations', {
        id: org,
        name: 'Twin',
        slug: 'twin',
        created_at: NOW,
        date_format: 'iso',
        week_start: 1,
        week_one_rule: 'first4day',
        default_plannable_hours: 40,
      })
      await ctx.db.insert('org_counters', { org_id: org, next_issue_num: 1, next_project_num: 900 })
      const _id = await ctx.db.insert('profiles', {
        id: 'twin-pia',
        auth_user_id: 'auth_twin_pia',
        org_id: org,
        name: 'Pia',
        initials: 'PI',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        created_at: NOW,
      })
      await ctx.db.insert('teams', {
        id: 'twin-team',
        org_id: org,
        name: 'Red',
        track_delay_default: false,
        created_at: NOW,
      })
      await ctx.db.insert('team_members', {
        team_id: 'twin-team',
        profile_id: 'twin-pia',
        is_leader: false,
      })
      const insert = (doc: Omit<Doc<'projects'>, '_id' | '_creationTime'>) =>
        ctx.db.insert('projects', doc)
      const grant = (id: string) =>
        ctx.db.insert('project_access', {
          project_id: `twin-${id}`,
          profile_id: 'twin-pia',
          level: 'user',
        })
      for (let i = 0; i < 30; i++) {
        const n = String(i).padStart(3, '0')
        await insert(project(`top${i}`, `Top ${n}`))
        await grant(`top${i}`)
        await insert(
          project(`old${i}`, `Old ${n}`, {
            archived_at: `2026-0${1 + (i % 5)}-0${1 + (i % 7)}T00:00:00.000Z`,
          }),
        )
        await grant(`old${i}`)
      }
      await insert(project('shared', 'Shared'))
      await ctx.db.insert('project_team_access', {
        project_id: 'twin-shared',
        team_id: 'twin-team',
        level: 'user',
      })
      await insert(project('nav', 'Nav parent'))
      await insert(project('mine', 'Mine', { type: 'project', parent_id: 'twin-nav' }))
      await grant('mine')
      await insert(
        project('gone', 'Mine gone', {
          type: 'project',
          parent_id: 'twin-nav',
          archived_at: '2026-03-03T00:00:00.000Z',
        }),
      )
      await grant('gone')
      await insert(project('oldnav', 'Old nav', { archived_at: '2026-02-02T00:00:00.000Z' }))
      await insert(
        project('oldmine', 'Old mine', {
          type: 'project',
          parent_id: 'twin-oldnav',
          archived_at: '2026-02-02T00:00:00.000Z',
        }),
      )
      await grant('oldmine')
      if (hidden)
        for (let i = 0; i < 12; i++) {
          const n = String(i).padStart(3, '0')
          await insert(project(`h${i}`, `Top ${n} hidden`))
          await insert(
            project(`ha${i}`, `Old ${n} hidden`, { archived_at: '2026-04-04T00:00:00.000Z' }),
          )
          await insert(
            project(`hs${i}`, `Mine ${n} hidden`, { type: 'project', parent_id: 'twin-nav' }),
          )
          await insert(
            project(`hl${i}`, `Mine ${n} hidden gone`, {
              type: 'project',
              parent_id: 'twin-nav',
              archived_at: '2026-03-03T00:00:00.000Z',
            }),
          )
          await insert(
            project(`hu${i}`, `Old mine ${n} hidden`, {
              type: 'project',
              parent_id: 'twin-oldnav',
              archived_at: '2026-02-02T00:00:00.000Z',
            }),
          )
        }
      // beneath the parent she sees only through Old mine, first in name
      // order, so a read of the organization's range beneath that parent
      // (has_sub_projects) reads another document here
      if (hidden)
        await insert(
          project('hu-first', 'Aa hidden', {
            type: 'project',
            parent_id: 'twin-oldnav',
            archived_at: '2026-02-02T00:00:00.000Z',
          }),
        )
      return (await ctx.db.get(_id)) as Doc<'profiles'>
    })
    await keyOrg(t, org)
    await withReach(t)
    return { t, pia }
  }

  it('answers the same rows, cursors and reads whatever projects the person cannot see, where a read of the organization’s ranges would not', async () => {
    /* Every batch of every list for Pia, each with what it read. */
    const run = async (hidden: boolean) => {
      const { t, pia } = await twin(hidden)
      const calls: ({ out: SettingsListAnswer<unknown> } & Read)[] = []
      const each = async <R>(
        read: (ctx: QueryCtx, after?: string) => Promise<SettingsListAnswer<R>>,
      ) => {
        let after: string | undefined
        for (let round = 0; round < 20; round++) {
          const { out, read: r } = await measured(t, (ctx) => read(ctx, after))
          calls.push({ out, ...r })
          if (out.state !== 'ready' || out.next === null) return
          after = out.next
        }
      }
      for (const search of ['', 'mine', 'old', 'top 01', 'zzz']) {
        await each((ctx, after) => settingsProjectsOf(ctx, pia, { search, after }))
        await each((ctx, after) => settingsArchivedOf(ctx, pia, { search, after }))
      }
      await each((ctx, after) => settingsProjectsOf(ctx, pia, { sub_project_parents: true, after }))
      for (const id of ['twin-nav', 'twin-top0', 'twin-shared'])
        await each((ctx, after) => settingsSubProjectsOf(ctx, pia, { project_id: id, after }))
      for (const id of ['twin-oldnav', 'twin-old0'])
        await each((ctx, after) => settingsArchivedChildrenOf(ctx, pia, { project_id: id, after }))
      // a stand-in that reads the organization's archived entries, which
      // an ordinary seat's lists never do
      const standIn = await measured(t, async (ctx) =>
        (
          await ctx.db
            .query('projects')
            .withIndex('by_org_state_archived', (q) =>
              q.eq('org_id', 'twin-org').eq('archive_state', 'listed'),
            )
            .order('desc')
            .take(LIST_BATCH)
        ).map((p) => p.id),
      )
      vi.useRealTimers()
      return { calls, standIn }
    }
    const without = await run(false)
    const beside = await run(true)
    expect(without.calls).toHaveLength(19)
    // every call answered a batch, and most of them rows
    expect(without.calls.every((c) => c.out.state === 'ready')).toBe(true)
    const rows = without.calls.map((c) => (c.out.state === 'ready' ? c.out.rows.length : 0))
    expect(rows.filter((n) => n > 0)).toHaveLength(11)
    expect(beside.calls).toEqual(without.calls)
    expect(beside.standIn.out).not.toEqual(without.standIn.out)
  })
})

/* ------------------------------------------------------------------ rights */

describe('rights', () => {
  it('answers each right as the write it names would, for an admin, a lead, a sub-project’s lead, a member, a guest and a Viewer', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [spare] = await plantMetas(t, f.org.id, ['Spare'], { lead_id: pia.id })
    const [kept] = await plantSubs(t, spare, ['Kept'])
    await t.run((ctx) => ctx.db.patch(f.sub._id, { lead_id: pia.id }))
    await plantGrants(t, pia, [f.hidden])
    await ready(t, f)
    await archive(t, f.user, f.sub2.id)
    await archive(t, pia, kept.id)
    const checked = { create: 0, restore: 0, delete: 0 }
    const check = async (seat: Doc<'profiles'>) => {
      const me = await seatNow(t, seat)
      const live = await walked((after) => lists.projects(t, me, { search: 'r', after }))
      for (const row of live.rows) {
        if (row.parent !== null) continue
        checked.create++
        const can = await passes(t, (ctx) =>
          createProjectCore(ctx, {
            me,
            now: NOW,
            project: { id: uuid(), type: 'project', parent_id: row.id, name: 'Probe' },
          }),
        )
        expect(row.can_create_sub_project, `${me.name} creates under ${row.name}`).toBe(can)
      }
      const archived = await walked((after) => lists.archived(t, me, { search: 'e', after }))
      for (const row of archived.rows) {
        const project = await now(t, row.under && row.parent !== null ? row.parent.id : row.id)
        checked.restore++
        const restores = await passes(t, (ctx) =>
          unarchiveProjectCore(ctx, { me, project, now: NOW }),
        )
        expect(row.can_restore, `${me.name} restores ${row.name}`).toBe(restores)
        if (row.under) {
          expect(row.can_delete).toBe(false)
          continue
        }
        checked.delete++
        // projects.deleteDeep's own check
        const deletes = await t.run((ctx) => hasProjectLevel(ctx, me, row.id, 'lead'))
        expect(row.can_delete, `${me.name} deletes ${row.name}`).toBe(deletes)
      }
    }
    const seats = [f.admin, f.user, pia, f.guest, f.viewer]
    for (const seat of seats) await check(seat)
    await archive(t, f.user, f.meta.id)
    for (const seat of seats) await check(seat)
    expect(checked.create).toBeGreaterThan(8)
    expect(checked.restore).toBeGreaterThan(8)
    expect(checked.delete).toBeGreaterThan(8)
    // Firmware, led by Pia beneath Testbed platform led by someone else,
    // comes back only with its parent, which Pia may not restore, and
    // carries no right of its own
    expect(batchOf(await lists.archived(t, pia, { search: 'firmware' })).rows).toEqual([
      expect.objectContaining({ id: f.sub.id, under: true, can_restore: false, can_delete: false }),
    ])
  })
})

/* --------------------------------------------------------------- hierarchy */

describe('hierarchy', () => {
  for (const who of ['admin', 'user'] as const)
    it(`keeps a sub-project archived alone as its own entry, places it beneath its parent once that is archived beside the sibling carried with it, and restores exactly the carried one, for ${who === 'admin' ? 'an admin' : 'the lead'}`, async () => {
      const t = newT()
      const f = await withOrg(t)
      await ready(t, f)
      const me = f[who]
      await archive(t, f.user, f.sub.id)
      expect(batchOf(await lists.archived(t, me)).rows).toEqual([
        expect.objectContaining({ id: f.sub.id, under: false, parent: expect.anything() }),
      ])
      await archive(t, f.user, f.meta.id)
      await archive(t, f.user, f.hidden.id)
      const entries = batchOf(await lists.archived(t, me)).rows
      expect(entries.map((r) => [r.name, r.has_sub_projects])).toEqual([
        ['Skunkworks', false],
        ['Testbed platform', true],
      ])
      expect(batchOf(await lists.chips(t, me, f.meta.id)).rows).toEqual([
        { id: f.sub2.id, name: 'Board rev', num: f.sub2.num, with_parent: true },
        { id: f.sub.id, name: 'Firmware', num: f.sub.num, with_parent: false },
      ])
      // newest first; Board rev, archived with Testbed platform, was
      // created after it
      expect(namesOf(batchOf(await lists.archived(t, me, { search: 'r' })).rows)).toEqual([
        'Skunkworks',
        'Board rev',
        'Testbed platform',
        'Firmware',
      ])
      await restore(t, f.user, f.meta.id)
      expect(namesOf(batchOf(await lists.subs(t, me, f.meta.id)).rows)).toEqual(['Board rev'])
      expect(batchOf(await lists.archived(t, me)).rows.map((r) => [r.name, r.under])).toEqual([
        ['Skunkworks', false],
        ['Firmware', false],
      ])
      expect(namesOf(batchOf(await lists.projects(t, me)).rows)).toEqual(['Testbed platform'])
      expect(await compareAll(t, f, me, me.name)).toBeGreaterThan(3)
    })
})

/* ------------------------------------------------------------------ search */

describe('search', () => {
  it('matches every word anywhere in the name, ignoring case and accents, finds a sub-project with its parent and beneath its archived parent, makes no child match by its parent’s name, and finds a match past the first batch', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [cafe, noir] = await plantMetas(t, f.org.id, ['Café Noir', 'Noir'])
    const [creme] = await plantSubs(t, cafe, ['Crème brûlée'])
    const many = await plantMetas(t, f.org.id, names('Bulk ', 40))
    const [late] = await plantMetas(t, f.org.id, ['Zulu noir late'])
    const [vault] = await plantMetas(t, f.org.id, ['Vault'])
    const [vaulted] = await plantSubs(t, vault, ['Creme vault'])
    await plantGrants(t, pia, [cafe, noir, late, vault, ...many])
    await ready(t, f)
    await archive(t, f.admin, vault.id)
    for (const seat of [f.admin, pia]) {
      const found = async (term: string) =>
        (await walked((after) => lists.projects(t, seat, { search: term, after }))).rows
      expect(namesOf(await found('NOIR cafe')), seat.name).toEqual(['Café Noir'])
      expect(namesOf(await found('noir'))).toEqual(['Café Noir', 'Noir', 'Zulu noir late'])
      expect(await found('brulee CREME')).toEqual([
        {
          id: creme.id,
          name: creme.name,
          num: creme.num,
          parent: { id: cafe.id, name: cafe.name, num: cafe.num },
          can_create_sub_project: false,
        },
      ])
      // the parent's name makes no child match
      expect(namesOf(await found('cafe'))).toEqual(['Café Noir'])
      // past 40 rows that do not match
      expect(namesOf(await found('late'))).toEqual(['Zulu noir late'])
      for (const term of ['noir', 'creme', 'bulk 03', 'e'])
        expect(await found(term), `${seat.name} ${term}`).toEqual(
          await expectedProjects(t, seat, term),
        )
      expect(batchOf(await lists.archived(t, seat, { search: 'creme' })).rows).toEqual([
        expect.objectContaining({
          id: vaulted.id,
          under: true,
          parent: { id: vault.id, name: vault.name, num: vault.num },
        }),
      ])
      for (const term of ['vault', 'creme', 'zzz', ''])
        expect(
          (await walked((after) => lists.archived(t, seat, { search: term, after }))).rows,
          `${seat.name} archived ${term}`,
        ).toEqual(await expectedArchived(t, seat, term))
    }
  })
})

/* ------------------------------------------------------- sub_project_parents */

describe('the parents of a new sub-project', () => {
  it('lists every live top-level meta for an admin, the projects a lead leads, and nothing for a member through every batch', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const vic = await person(t, f.org.id, 'Vic')
    const many = await plantMetas(t, f.org.id, names('Granted ', 60))
    await plantMetas(t, f.org.id, ['Mine'], { lead_id: pia.id })
    await plantMetas(t, f.org.id, ['Mine gone'], { lead_id: pia.id, archived_at: NOW })
    await plantGrants(t, pia, many)
    await plantGrants(t, vic, many)
    await ready(t, f)
    const parents = (seat: Doc<'profiles'>, search?: string) =>
      walked((after) => lists.projects(t, seat, { sub_project_parents: true, search, after }))
    expect((await parents(f.admin)).rows).toHaveLength(63)
    expect(namesOf((await parents(f.user)).rows)).toEqual(['Skunkworks', 'Testbed platform'])
    expect(namesOf((await parents(pia)).rows)).toEqual(['Mine'])
    expect(namesOf((await parents(pia, 'gone')).rows)).toEqual([])
    expect(namesOf((await parents(f.guest)).rows)).toEqual([])
    expect(namesOf((await parents(f.viewer)).rows)).toEqual([])
    for (const seat of [f.admin, f.user, pia, vic])
      expect((await parents(seat)).rows).toEqual(await expectedProjects(t, seat, '', true))
    // a member's batches under a lowered budget stop, never answering an
    // end they did not reach
    Object.assign(NAMED_READ, { ranges: 20 })
    const { rows, batches } = await parents(vic)
    expect(rows).toEqual([])
    expect(batches.length).toBeGreaterThan(1)
    for (const b of batches.slice(0, -1)) expect(b.stopped).toBe(true)
  })
})

/* ------------------------------------------------------------------- order */

describe('order', () => {
  it("lists projects in the name key's UTF-8 byte order with the id breaking ties, on both sights", async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const face = 'a\u{1F600}'
    const privateUse = 'a\u{E000}'
    const tops = await plantMetas(t, f.org.id, [face, privateUse, 'Same', 'Same'])
    await plantGrants(t, pia, tops)
    await ready(t, f)
    // JavaScript compares UTF-16 units and puts the face first
    expect([privateUse, face].sort()).toEqual([face, privateUse])
    const sames = [tops[2].id, tops[3].id].sort((a, b) => compareValues(a, b))
    for (const seat of [f.admin, pia]) {
      const rows = (await walked((after) => lists.projects(t, seat, { search: 'a', after }))).rows
      expect(namesOf(rows.slice(0, 2)), seat.name).toEqual([privateUse, face])
      expect(rows.filter((r) => r.name === 'Same').map((r) => r.id)).toEqual(sames)
      expect(rows).toEqual(await expectedProjects(t, seat, 'a'))
    }
  })

  it('lists Archived projects newest first with equal archive times in the index’s order, on both sights alike', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const at = (day: number) => `2026-02-${String(day).padStart(2, '0')}T00:00:00.000Z`
    // names against archive times, so neither name order nor ascending time
    // gives this order
    const olds = [
      ...(await plantMetas(t, f.org.id, ['Alpha'], { archived_at: at(1) })),
      ...(await plantMetas(t, f.org.id, ['Bravo', 'Charlie', 'Delta'], { archived_at: at(9) })),
      ...(await plantMetas(t, f.org.id, ['Echo'], { archived_at: at(5) })),
    ]
    const [live] = await plantMetas(t, f.org.id, ['Live'])
    const [foxtrot] = await plantSubs(t, live, ['Foxtrot'], { archived_at: at(5) })
    await plantGrants(t, pia, [...olds, live])
    await ready(t, f)
    const stored = await t.run((ctx) =>
      Promise.all(
        [...olds, foxtrot].map(async (p) => (await ctx.db.get(p._id)) as Doc<'projects'>),
      ),
    )
    const want = stored
      .sort((a, b) =>
        compareValues(
          [b.archived_at ?? '', b._creationTime, b._id],
          [a.archived_at ?? '', a._creationTime, a._id],
        ),
      )
      .map((p) => p.name)
    expect(want).toEqual(['Delta', 'Charlie', 'Bravo', 'Foxtrot', 'Echo', 'Alpha'])
    for (const seat of [f.admin, pia]) {
      Object.assign(NAMED_READ, DEFAULT_READ)
      expect(namesOf(batchOf(await lists.archived(t, seat)).rows), seat.name).toEqual(want)
      expect(batchOf(await lists.archived(t, seat)).rows).toEqual(await expectedArchived(t, seat))
      // across batches too, a row or two a batch under a small budget
      Object.assign(NAMED_READ, { documents: 1 })
      const { rows, batches } = await walked((after) => lists.archived(t, seat, { after }))
      expect(namesOf(rows)).toEqual(want)
      expect(batches.length).toBeGreaterThan(2)
    }
  })
})

/* ------------------------------------------------------------ continuation */

describe('continuation', () => {
  for (const admin of [true, false])
    it(`hands out every row once over batches with renames, a new project, an archive and a restore between them, for ${admin ? 'an admin' : 'a lead'}`, async () => {
      const t = newT()
      const f = await withOrg(t)
      const pia = await person(t, f.org.id, 'Pia')
      const tops = await plantMetas(t, f.org.id, names('Top ', 60), { lead_id: pia.id })
      const olds = await plantMetas(t, f.org.id, names('Old ', 40), {
        lead_id: pia.id,
        archived_at: NOW,
      })
      await ready(t, f)
      const seat = admin ? f.admin : pia
      const first = batchOf(await lists.projects(t, seat))
      expect(first.rows).toHaveLength(LIST_BATCH)
      const rename = (id: string, name: string) =>
        as(t, pia).mutation(api.projects.update, { org_id: f.org.id, id, patch: { name } })
      // into the part read already, and further on
      await rename(tops[30].id, 'Top 010b')
      await rename(tops[31].id, 'Top 059b')
      await archive(t, pia, tops[45].id)
      await as(t, f.admin).mutation(api.projects.create, {
        org_id: f.org.id,
        id: uuid(),
        type: 'meta',
        key: 'NEWT',
        name: 'Top 050b',
        lead_id: pia.id,
        sort_order: 999,
      })
      const rest = await walked((after) =>
        lists.projects(t, seat, { after: after ?? first.next ?? '' }),
      )
      const ids = [...first.rows, ...rest.rows].map((r) => r.id)
      expect(new Set(ids).size).toBe(ids.length)
      const later = namesOf(rest.rows)
      expect(later).toContain('Top 059b')
      expect(later).toContain('Top 050b')
      for (const gone of ['Top 010b', 'Top 030', 'Top 031', 'Top 045'])
        expect(later).not.toContain(gone)
      // the archive's batches, newest first, with a restore inside the
      // first batch and a new archive between them
      const one = batchOf(await lists.archived(t, seat))
      expect(one.rows).toHaveLength(LIST_BATCH)
      expect(batchOf(await lists.archived(t, seat, { through: one.next ?? '' })).rows).toEqual(
        one.rows,
      )
      const restored = one.rows[3]
      await restore(t, pia, restored.id)
      await archive(t, pia, tops[50].id)
      const again = batchOf(await lists.archived(t, seat, { through: one.next ?? '' }))
      // the new archive is newest, so the batch kept live holds it, and
      // no longer the restored one
      expect(again.rows.map((r) => r.id)).toEqual([
        tops[50].id,
        ...one.rows.filter((r) => r.id !== restored.id).map((r) => r.id),
      ])
      const tail = await walked((after) =>
        lists.archived(t, seat, { after: after ?? one.next ?? '' }),
      )
      const archived = [...one.rows, ...tail.rows].map((r) => r.id)
      expect(new Set(archived).size).toBe(archived.length)
      expect(archived).toHaveLength(olds.length + 1)
      expect(
        namesOf(batchOf(await lists.projects(t, seat, { search: restored.name })).rows),
      ).toEqual([restored.name])
    })

  it('keeps reading a cursor of projects, its search, Archived projects and sub-projects across a change of the seat’s role between admin and user', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const tops = await plantMetas(t, f.org.id, names('Top ', 40), { lead_id: pia.id })
    await plantSubs(t, tops[0], names('Sub ', 40))
    await plantMetas(t, f.org.id, names('Old ', 40), { lead_id: pia.id, archived_at: NOW })
    // the same projects for either role
    await plantGrants(t, pia, [f.meta, f.hidden])
    await ready(t, f)
    /* A first batch as `before` reads it, then the rest as `after` reads
     * it from that batch's cursor, against every batch as `after` reads
     * it. */
    const across = async <R extends { id: string }>(
      label: string,
      read: (seat: Doc<'profiles'>, a?: string) => Promise<SettingsListAnswer<R>>,
      from: 'admin' | 'user',
      to: 'admin' | 'user',
    ) => {
      await t.run((ctx) => ctx.db.patch(pia._id, { org_role: from }))
      const first = batchOf(await read(await seatNow(t, pia)))
      await t.run((ctx) => ctx.db.patch(pia._id, { org_role: to }))
      const after = await seatNow(t, pia)
      const rest = await walked((cursor) => read(after, cursor ?? first.next ?? ''))
      const whole = (await walked((cursor) => read(after, cursor))).rows
      expect(
        [...first.rows, ...rest.rows].map((r) => r.id),
        `${from} to ${to}: ${label}`,
      ).toEqual(whole.map((r) => r.id))
    }
    for (const [from, to] of [
      ['admin', 'user'],
      ['user', 'admin'],
    ] as const) {
      await across('projects', (seat, after) => lists.projects(t, seat, { after }), from, to)
      await across(
        'search',
        (seat, after) => lists.projects(t, seat, { search: 'top', after }),
        from,
        to,
      )
      await across('archived', (seat, after) => lists.archived(t, seat, { after }), from, to)
      await across('subs', (seat, after) => lists.subs(t, seat, tops[0].id, { after }), from, to)
    }
  })
})

/* ----------------------------------------------------------------- budgets */

describe('budgets', () => {
  it('stops a batch at the read budget, never answering the end, and the walk still hands out every row once, on both sights', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const tops = await plantMetas(t, f.org.id, [
      ...names('Row ', 60),
      'Row 010 match',
      'Row 050 match',
    ])
    const old = await plantMetas(t, f.org.id, names('Old ', 40), { archived_at: NOW })
    await plantGrants(t, pia, [...tops, ...old])
    await ready(t, f)
    for (const seat of [f.admin, pia]) {
      const want = await expectedProjects(t, seat, 'match')
      const wantOld = await expectedArchived(t, seat)
      expect(namesOf(want)).toEqual(['Row 010 match', 'Row 050 match'])
      Object.assign(NAMED_READ, { documents: 12 })
      const { rows, batches } = await walked((after) =>
        lists.projects(t, seat, { search: 'match', after }),
      )
      expect(rows, seat.name).toEqual(want)
      expect(batches.some((b) => b.stopped && b.rows.length === 0)).toBe(true)
      for (const b of batches) if (b.stopped) expect(b.next).not.toBeNull()
      const archived = await walked((after) => lists.archived(t, seat, { after }))
      expect(archived.rows).toEqual(wantOld)
      expect(archived.batches.some((b) => b.stopped && b.rows.length < LIST_BATCH)).toBe(true)
      for (const b of archived.batches) if (b.stopped) expect(b.next).not.toBeNull()
      Object.assign(NAMED_READ, DEFAULT_READ)
    }
  })

  it('refuses the archive of a seat that is not an admin whole past PROJECT_ADMIN.collect, and never an admin’s', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const old = await plantMetas(t, f.org.id, names('Old ', 30), { archived_at: NOW })
    await plantGrants(t, pia, old)
    await ready(t, f)
    expect(batchOf(await lists.archived(t, pia)).rows).toHaveLength(LIST_BATCH)
    Object.assign(PROJECT_ADMIN, { collect: { ...DEFAULT_ADMIN.collect, ranges: 20 } })
    expect(await lists.archived(t, pia)).toMatchObject({
      state: 'unavailable',
      reason: ACCESS_UNCHECKED,
      message: expect.stringMatching(/could not finish/),
    })
    expect(await lists.archived(t, pia, { search: 'zzz' })).toMatchObject({
      reason: ACCESS_UNCHECKED,
    })
    Object.assign(PROJECT_ADMIN, { collect: { ...DEFAULT_ADMIN.collect, documents: 10 } })
    expect(await lists.archived(t, pia)).toMatchObject({ reason: ACCESS_UNCHECKED })
    expect(batchOf(await lists.archived(t, f.admin)).rows).toHaveLength(LIST_BATCH)
    // the other lists collect nothing
    expect(batchOf(await lists.projects(t, pia)).rows).toEqual([])
    expect(batchOf(await lists.chips(t, pia, old[0].id)).rows).toEqual([])
  })

  it('refuses whole where a check of the seat’s own rows stopped: its teams, an access check and the room for single-row reads', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [shared, oldShared] = await plantMetas(t, f.org.id, ['Shared', 'Old shared'])
    const [kid] = await plantSubs(t, shared, ['Kid'])
    for (const name of ['Red', 'Blue'])
      await plantShares(t, await plantTeam(t, f.org.id, name, [pia]), [shared, oldShared, kid])
    await ready(t, f)
    await archive(t, f.admin, oldShared.id)
    expect(namesOf(batchOf(await lists.projects(t, pia)).rows)).toEqual(['Shared'])
    expect(namesOf(batchOf(await lists.archived(t, pia)).rows)).toEqual(['Old shared'])
    const reads = {
      projects: () => lists.projects(t, pia),
      search: () => lists.projects(t, pia, { search: 'kid' }),
      archived: () => lists.archived(t, pia),
      archiveSearch: () => lists.archived(t, pia, { search: 'zzz' }),
      subs: () => lists.subs(t, pia, shared.id),
      chips: () => lists.chips(t, pia, oldShared.id),
    }
    const lowerings: [string, () => void, readonly (keyof typeof reads)[]][] = [
      // a project the seat sees for a reason of its own lists its
      // sub-projects without its teams, as projectNav.children does
      [
        'PROJECT_NAV.teams',
        () => Object.assign(PROJECT_NAV, { teams: 1 }),
        ['projects', 'search', 'archived', 'archiveSearch', 'chips'],
      ],
      [
        'OWN_READS lookups and members',
        () => Object.assign(OWN_READS, { lookups: 0, members: 0 }),
        ['projects', 'search', 'archived', 'archiveSearch', 'subs', 'chips'],
      ],
      [
        'OWN_READS.teamReads',
        () => Object.assign(OWN_READS, { teamReads: 0 }),
        ['projects', 'search', 'archived', 'archiveSearch', 'subs', 'chips'],
      ],
    ]
    for (const [label, lower, refused] of lowerings) {
      lower()
      for (const [name, read] of Object.entries(reads))
        if (refused.includes(name as keyof typeof reads))
          expect(await read(), `${label}: ${name}`).toMatchObject({
            state: 'unavailable',
            reason: ACCESS_UNCHECKED,
          })
        else expect(await read(), `${label}: ${name}`).toMatchObject({ state: 'ready' })
      Object.assign(PROJECT_NAV, structuredClone(DEFAULT_NAV))
      Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
    }
    // a Viewer's old leads beneath an archived parent past
    // PROJECT_NAV.children rows with none shown
    const vic = await person(t, f.org.id, 'Vic', { org_role: 'viewer' })
    const [parent] = await plantMetas(t, f.org.id, ['Parent'])
    await plantSubs(t, parent, names('Led ', 3), { lead_id: vic.id })
    const [seen] = await plantSubs(t, parent, ['Seen'])
    await plantGrants(t, vic, [seen])
    await ready(t, f)
    await archive(t, f.admin, parent.id)
    expect(namesOf(batchOf(await lists.archived(t, vic)).rows)).toEqual(['Parent'])
    expect(namesOf(batchOf(await lists.chips(t, vic, parent.id)).rows)).toEqual(['Seen'])
    Object.assign(PROJECT_NAV, { children: 2 })
    expect(await lists.archived(t, vic)).toMatchObject({ reason: ACCESS_UNCHECKED })
    expect(await lists.chips(t, vic, parent.id)).toMatchObject({ reason: ACCESS_UNCHECKED })
  })
})

/* --------------------------------------------------------------- readiness */

describe('readiness', () => {
  /** Organization `orgId` without its `stamp` in org_ready. */
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
    it(`answers not_ready without ${stamp} on both sights, while another organization's lists answer`, async () => {
      const t = newT()
      const f = await withOrg(t)
      await ready(t, f)
      await archive(t, f.user, f.hidden.id)
      await unstamp(t, f.org.id, stamp)
      for (const seat of [f.admin, f.user]) {
        expect(await lists.projects(t, seat)).toEqual({ state: 'not_ready' })
        expect(await lists.projects(t, seat, { search: 'r' })).toEqual({ state: 'not_ready' })
        expect(await lists.subs(t, seat, f.meta.id)).toEqual({ state: 'not_ready' })
        expect(await lists.archived(t, seat)).toEqual({ state: 'not_ready' })
        expect(await lists.chips(t, seat, f.hidden.id)).toEqual({ state: 'not_ready' })
      }
      expect(namesOf(batchOf(await lists.projects(t, f.otherAdmin)).rows)).toEqual(['Elsewhere'])
    })
})

/* ----------------------------------------------------------------- no task */

describe('tasks', () => {
  it('reads the same with no tasks and with 300 open tasks in the projects it lists', async () => {
    const t = newT()
    const f = await withOrg(t)
    await ready(t, f)
    await archive(t, f.user, f.hidden.id)
    const reads = async () => {
      const out: Read[] = []
      for (const seat of [f.admin, f.user]) {
        const each: ((ctx: QueryCtx) => Promise<unknown>)[] = [
          (ctx) => settingsProjectsOf(ctx, seat, {}),
          (ctx) => settingsProjectsOf(ctx, seat, { search: 'r' }),
          (ctx) => settingsSubProjectsOf(ctx, seat, { project_id: f.meta.id }),
          (ctx) => settingsArchivedOf(ctx, seat, {}),
          (ctx) => settingsArchivedOf(ctx, seat, { search: 'r' }),
          (ctx) => settingsArchivedChildrenOf(ctx, seat, { project_id: f.hidden.id }),
        ]
        for (const read of each) out.push((await measured(t, read)).read)
      }
      return out
    }
    const before = await reads()
    for (const project of [f.meta, f.sub, f.hidden])
      await t.run(async (ctx) => {
        for (let i = 0; i < 100; i++)
          await insertTask(
            ctx.db,
            {
              id: uuid(),
              org_id: f.org.id,
              project_id: project.id,
              num: 10_000 + 1000 * project.num + i,
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
  /** What one measured call read, with its batch's size. */
  type Call = Read & { rows: number; stopped: boolean }

  /** Every batch of `read` from its start, each measured and answered
   * whole, with the cursor each answered. */
  async function measuredWalk<R>(
    t: T,
    read: (ctx: QueryCtx, after?: string) => Promise<SettingsListAnswer<R>>,
  ) {
    const calls: Call[] = []
    const rows: R[] = []
    const cursors: string[] = []
    let after: string | undefined
    for (let round = 0; round < 80; round++) {
      const { out, read: r } = await measured(t, (ctx) => read(ctx, after))
      const batch = batchOf(out)
      calls.push({ ...r, rows: batch.rows.length, stopped: batch.stopped })
      rows.push(...batch.rows)
      expect(batch.stopped).toBe(false)
      if (batch.next === null) return { calls, rows, cursors }
      cursors.push(batch.next)
      after = batch.next
    }
    throw new Error('the list did not end')
  }

  /** How many batches and rows there were, the first call, the one that
   * read the most ranges, and the most of any later call. */
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

  /** A batch of `read` kept live to 100 rows from the start and one from
   * the first batch's end, each measured and answered whole. */
  async function keptLive<R>(
    t: T,
    read: (ctx: QueryCtx, a: { after?: string; through: string }) => Promise<SettingsListAnswer<R>>,
    cursors: readonly string[],
  ) {
    const out: Record<string, Read> = {}
    const [firstEnd, , , fourthEnd, fifthEnd] = cursors
    if (fourthEnd !== undefined) {
      const live = await measured(t, (ctx) => read(ctx, { through: fourthEnd }))
      expect(batchOf(live.out).rows).toHaveLength(4 * LIST_BATCH)
      expect(batchOf(live.out).stopped).toBe(false)
      out.through100 = live.read
    }
    if (fifthEnd !== undefined) {
      const later = await measured(t, (ctx) => read(ctx, { after: firstEnd, through: fifthEnd }))
      expect(batchOf(later.out).rows).toHaveLength(4 * LIST_BATCH)
      expect(batchOf(later.out).stopped).toBe(false)
      out.laterThrough100 = later.read
    }
    return out
  }

  /** Every call inside Convex's limits and inside NAMED_READ with the
   * archive collection's share. */
  const inside = (calls: readonly Read[]) => {
    for (const call of calls) {
      expect(call.ranges).toBeLessThan(NAMED_READ.ranges + PROJECT_ADMIN.collect.ranges)
      expect(call.ranges).toBeLessThan(4096)
      expect(call.documents).toBeLessThan(32_000)
    }
  }

  /** The lists for `seat`, logged under `label`: every batch of the
   * projects list, kept live, a search for none and for `every`, every
   * batch of it, kept live; and every batch of the archive, kept live, and
   * its search for none. */
  async function logReads(
    t: T,
    seat: Doc<'profiles'>,
    label: string,
    o: { every?: string; archived?: boolean; projects?: boolean } = {},
  ) {
    const out: Record<string, unknown> = {}
    if (o.projects !== false) {
      const browse = await measuredWalk(t, (ctx, after) => settingsProjectsOf(ctx, seat, { after }))
      inside(browse.calls)
      out.projects = summary(browse.calls)
      out.projectsKept = await keptLive(
        t,
        (ctx, a) => settingsProjectsOf(ctx, seat, a),
        browse.cursors,
      )
      const none = await measuredWalk(t, (ctx, after) =>
        settingsProjectsOf(ctx, seat, { search: 'zzz', after }),
      )
      inside(none.calls)
      out.searchNone = none.calls[0]
      if (o.every !== undefined) {
        const every = o.every
        const all = await measuredWalk(t, (ctx, after) =>
          settingsProjectsOf(ctx, seat, { search: every, after }),
        )
        inside(all.calls)
        out.searchEvery = summary(all.calls)
        out.searchKept = await keptLive(
          t,
          (ctx, a) => settingsProjectsOf(ctx, seat, { search: every, ...a }),
          all.cursors,
        )
      }
    }
    if (o.archived !== false) {
      const browse = await measuredWalk(t, (ctx, after) => settingsArchivedOf(ctx, seat, { after }))
      inside(browse.calls)
      out.archived = summary(browse.calls)
      out.archivedKept = await keptLive(
        t,
        (ctx, a) => settingsArchivedOf(ctx, seat, a),
        browse.cursors,
      )
      const none = await measuredWalk(t, (ctx, after) =>
        settingsArchivedOf(ctx, seat, { search: 'zzz', after }),
      )
      inside(none.calls)
      out.archivedSearchNone = none.calls[0]
    }
    console.log(`settings lists, ${label}`, JSON.stringify(out))
    return out
  }

  /** `total` sub-projects planted under `parents`, `per` under each in
   * turn, named after the parent with `word`. */
  async function spread(
    t: T,
    parents: readonly Doc<'projects'>[],
    total: number,
    word: string,
    extra: Partial<Doc<'projects'>> = {},
    per = 3,
  ) {
    const out: Doc<'projects'>[] = []
    for (const p of parents) {
      const left = total - out.length
      if (left <= 0) break
      out.push(...(await plantSubs(t, p, names(`${p.name} ${word} `, Math.min(per, left)), extra)))
    }
    return out
  }

  it('reads an admin’s 200 live top-level projects and 500 live sub-projects, every batch and searches for a word in every name and in none', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // withOrg's two top-level and two sub-projects, and 198 and 498 more
    const tops = await plantMetas(t, f.org.id, names('Live project ', 198))
    await spread(t, tops, 498, 'sub')
    await ready(t, f)
    const out = await logReads(t, f.admin, 'admin, 200 projects and 500 sub-projects', {
      every: 'r',
      archived: false,
    })
    expect(out.projects).toMatchObject({ rows: 200 })
    expect(out.searchEvery).toMatchObject({ rows: 700 })
  })

  it('reads both batches of an admin’s 30 live sub-projects of one project', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const [parent] = await plantMetas(t, f.org.id, ['Parent'])
    await plantSubs(t, parent, names('Sub ', 30))
    await ready(t, f)
    const walk = await measuredWalk(t, (ctx, after) =>
      settingsSubProjectsOf(ctx, f.admin, { project_id: parent.id, after }),
    )
    inside(walk.calls)
    expect(walk.rows).toHaveLength(30)
    console.log('settings lists, admin, 30 sub-projects', JSON.stringify(walk.calls))
  })

  it('reads an admin’s 300 archived top-level projects, and the projects list reads none of them', async () => {
    const run = async (archived: number) => {
      const t = newT({ transactionLimits: true })
      const f = await withOrg(t)
      await plantMetas(t, f.org.id, names('Live ', 18))
      await plantMetas(t, f.org.id, names('Archived ', archived), { archived_at: NOW })
      await ready(t, f)
      return { t, f }
    }
    const without = await run(0)
    const beside = await run(300)
    const first = async (r: { t: T; f: OrgFixture }) =>
      [
        (await measured(r.t, (ctx) => settingsProjectsOf(ctx, r.f.admin, {}))).read,
        (await measured(r.t, (ctx) => settingsProjectsOf(ctx, r.f.admin, { search: 'r' }))).read,
      ].map((read) => [read.ranges, read.documents])
    expect(await first(beside)).toEqual(await first(without))
    const out = await logReads(beside.t, beside.f.admin, 'admin, 300 archived top-level projects', {
      projects: false,
    })
    expect(out.archived).toMatchObject({ rows: 300 })
  })

  it('reads an admin’s archive at its sum, 300 archived top-level projects and 1,000 archived sub-projects, half entries under live parents and half beneath archived ones', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const live = await plantMetas(t, f.org.id, names('Live ', 198))
    const old = await plantMetas(t, f.org.id, names('Old ', 300), { archived_at: NOW })
    await spread(t, live, 500, 'gone', { archived_at: NOW })
    await spread(t, old, 500, 'part', { archived_at: NOW })
    await ready(t, f)
    const out = await logReads(t, f.admin, 'admin, 300 archived and 1,000 archived sub-projects', {
      projects: false,
    })
    expect(out.archived).toMatchObject({ rows: 800 })
    const search = await measuredWalk(t, (ctx, after) =>
      settingsArchivedOf(ctx, f.admin, { search: 'part', after }),
    )
    inside(search.calls)
    expect(search.rows).toHaveLength(500)
    console.log(
      'settings lists, admin archive search of every part',
      JSON.stringify(summary(search.calls)),
    )
  })

  it('reads both batches of an admin’s 40 archived sub-projects beneath one archived project', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const [old] = await plantMetas(t, f.org.id, ['Old'], { archived_at: NOW })
    await plantSubs(t, old, names('Chip ', 40), { archived_at: NOW })
    await ready(t, f)
    const walk = await measuredWalk(t, (ctx, after) =>
      settingsArchivedChildrenOf(ctx, f.admin, { project_id: old.id, after }),
    )
    inside(walk.calls)
    expect(walk.rows).toHaveLength(40)
    console.log('settings lists, admin, 40 chips', JSON.stringify(walk.calls))
  })

  it('reads a person’s 200 top-level projects with grants, every batch, and their archive beside everyday ones', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const planted = await plantMetas(t, f.org.id, names('Live project ', 198))
    const old = await plantMetas(t, f.org.id, names('Archived project ', 3), { archived_at: NOW })
    await spread(t, planted, 30, 'sub')
    await plantGrants(t, pia, [f.meta, f.hidden, ...planted, ...old])
    await ready(t, f)
    const out = await logReads(t, pia, 'person, 200 projects by grant', { every: 'r' })
    expect(out.projects).toMatchObject({ rows: 200 })
    expect(out.archived).toMatchObject({ rows: 3 })
  })

  it('reads a person’s 200 sub-projects through grants on them under 67 parents shown for navigation', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const parents = await plantMetas(t, f.org.id, names('Parent ', 67))
    const subs = await spread(t, parents, 200, 'sub')
    await plantGrants(t, pia, subs)
    await ready(t, f)
    const out = await logReads(t, pia, 'person, 200 sub-projects by grant under 67 parents', {
      every: 'sub',
      archived: false,
    })
    expect(out.projects).toMatchObject({ rows: 67 })
    expect(out.searchEvery).toMatchObject({ rows: 200 })
    const kids = await measuredWalk(t, (ctx, after) =>
      settingsSubProjectsOf(ctx, pia, { project_id: parents[0].id, after }),
    )
    expect(kids.rows).toHaveLength(3)
    console.log('settings lists, person, sub-projects of one parent', JSON.stringify(kids.calls))
  })

  it('reads a person’s search at the sum of its two figures, grants on 200 top-level projects and the 200 sub-projects under them they read', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const planted = await plantMetas(t, f.org.id, names('Live project ', 198))
    // withOrg's two under Testbed platform and 198 more
    await spread(t, planted, 198, 'sub')
    await plantGrants(t, pia, [f.meta, f.hidden, ...planted])
    await ready(t, f)
    const out = await logReads(t, pia, 'person, 200 projects and 200 sub-projects by grant', {
      every: 'r',
      archived: false,
    })
    expect(out.searchEvery).toMatchObject({ rows: 400 })
  })

  /** The ordinary archive at its sum: Pia reaching 200 live top-level
   * projects, 300 archived top-level projects and 500 archived
   * sub-projects, 250 entries under live parents and 250 beneath archived
   * ones. With `inherited` she holds grants on all 500 top-level projects,
   * and reads the sub-projects through them; else grants on the
   * sub-projects themselves, whose 84 live and 84 archived parents she sees
   * only through them, and on the other top-level projects. */
  async function archiveSum(inherited: boolean) {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const live = await plantMetas(t, f.org.id, names('Live ', 198))
    const old = await plantMetas(t, f.org.id, names('Old ', 300), { archived_at: NOW })
    const gone = await spread(t, live, 250, 'gone', { archived_at: NOW })
    const parts = await spread(t, old, 250, 'part', { archived_at: NOW })
    if (inherited) await plantGrants(t, pia, [f.meta, f.hidden, ...live, ...old])
    else
      await plantGrants(t, pia, [
        f.meta,
        f.hidden,
        ...live.slice(84),
        ...old.slice(84),
        ...gone,
        ...parts,
      ])
    await ready(t, f)
    return { t, f, pia, old }
  }

  for (const inherited of [true, false])
    it(`reads a person’s archive at its sum, 200 live and 300 archived top-level projects and 500 archived sub-projects ${inherited ? 'inherited' : 'by grants on them'}`, async () => {
      const { t, pia, old } = await archiveSum(inherited)
      const label = `person, archive sum, ${inherited ? 'inherited' : 'by grants'}`
      const out = await logReads(t, pia, label, { projects: false })
      expect(out.archived).toMatchObject({ rows: 550 })
      const search = await measuredWalk(t, (ctx, after) =>
        settingsArchivedOf(ctx, pia, { search: 'part', after }),
      )
      inside(search.calls)
      expect(search.rows).toHaveLength(250)
      const chips = await measuredWalk(t, (ctx, after) =>
        settingsArchivedChildrenOf(ctx, pia, { project_id: old[0].id, after }),
      )
      expect(chips.rows).toHaveLength(3)
      console.log(
        `settings lists, ${label}, search of every part and chips`,
        JSON.stringify({ search: summary(search.calls), chips: chips.calls }),
      )
    })

  it('reads for one of the person’s teams sharing 50 live and 150 archived projects of 3 sub-projects each', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const live = await plantMetas(t, f.org.id, names('Shared ', 50))
    const old = await plantMetas(t, f.org.id, names('Old shared ', 150), { archived_at: NOW })
    await spread(t, live, 150, 'sub')
    await spread(t, old, 450, 'sub', { archived_at: NOW })
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia]), [...live, ...old])
    await ready(t, f)
    const out = await logReads(t, pia, 'person, one team sharing 50 and 150 archived', {
      every: 'shared',
    })
    expect(out.projects).toMatchObject({ rows: 50 })
    expect(out.searchEvery).toMatchObject({ rows: 200 })
    expect(out.archived).toMatchObject({ rows: 150 })
  })

  it('reads for a member of 5 teams each sharing 20 sub-projects', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const parents = await plantMetas(t, f.org.id, names('Parent ', 34))
    const subs = await spread(t, parents, 100, 'sub')
    for (let i = 0; i < 5; i++)
      await plantShares(
        t,
        await plantTeam(t, f.org.id, `Team ${i}`, [pia]),
        subs.slice(20 * i, 20 * i + 20),
      )
    await ready(t, f)
    const out = await logReads(t, pia, 'person, 5 teams sharing 20 sub-projects each', {
      every: 'sub',
    })
    expect(out.projects).toMatchObject({ rows: 34 })
    expect(out.searchEvery).toMatchObject({ rows: 100 })
  })
})

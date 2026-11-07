/* The check and repair of what a rollback past the favorites release leaves
 * in project_favorites (internal/favoritesRepair.ts). Each case plants the
 * rows a rollback can leave directly, as the earlier code would, and runs
 * the check, which must write nothing, and the repair, which must change
 * only the classes it changes. A row that passes the reader rule
 * (projectNav.setup.ts shows) stays exactly as it was. Fake timers keep the
 * Deleted items steps from running until a case releases them. */
/// <reference types="vite/client" />

import type { WithoutSystemFields } from 'convex/server'
import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { CLASSES, EXAMPLES, type FavoriteClass, RUN } from '../internal/favoritesRepair'
import { ORG_REMOVAL_PHASES, REMOVAL_PHASES } from '../lib/enums'
import { MIB } from '../lib/limits'
import { copiesOf } from '../model/projectFavorites'
import {
  as,
  NOW,
  newT,
  type OrgFixture,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { shows } from './projectNav.setup'
import { withReach } from './projectReach.setup'
import { installTrashTimers, runSteps } from './trash.setup'

installTrashTimers()

const EXAMPLES_DEFAULT = { ...EXAMPLES }
const RUN_DEFAULT = { ...RUN }
afterEach(() => {
  Object.assign(EXAMPLES, EXAMPLES_DEFAULT)
  Object.assign(RUN, RUN_DEFAULT)
})

type Favorite = Doc<'project_favorites'>
type Counts = Record<FavoriteClass, number>

const OLD = '2020-01-01T00:00:00.000Z'

/** Every favorites row, in creation order. */
const all = (t: T): Promise<Favorite[]> =>
  t.run((ctx) => ctx.db.query('project_favorites').collect())

/** Inserts a favorites row of `seat` on `project` with its copies, as a
    star writes it, changed by `over`. */
const plant = (
  t: T,
  seat: Pick<Doc<'profiles'>, 'id' | 'org_id'>,
  project: Pick<Doc<'projects'>, 'id' | 'name' | 'archived_at'>,
  over: Partial<WithoutSystemFields<Favorite>> = {},
) =>
  t.run(async (ctx) => {
    const _id = await ctx.db.insert('project_favorites', {
      org_id: seat.org_id,
      profile_id: seat.id,
      project_id: project.id,
      ...copiesOf(project),
      created_at: NOW,
      ...over,
    })
    return (await ctx.db.get(_id)) as Favorite
  })

/** The whole check or repair through `run`. */
const runRepair = (t: T, dry_run: boolean, more: { page_size?: number; cursor?: string } = {}) =>
  t.action(internal.internal.favoritesRepair.run, { dry_run, ...more })

/** Counts with every class at none but `some`. */
const counts = (some: Partial<Counts>): Counts =>
  Object.fromEntries(CLASSES.map((c) => [c, some[c] ?? 0])) as Counts

/** A fixture of one row of every class, and the rows each class names. */
async function everyClass(t: T) {
  const f: OrgFixture = await withOrg(t)
  await withReach(t)
  // a project of the organization the person stars, which a rollback
  // renamed without the copy, and one it stars and then deletes
  const renamed = await plantProject(t, { org_id: f.org.id, type: 'meta', name: 'Renamed' })
  await as(t, f.user).mutation(api.projectNav.setFavorite, {
    org_id: f.org.id,
    project_id: f.hidden.id,
    favorite: true,
  })
  // another organization's project in its Deleted items
  const gone = await plantProject(t, { org_id: f.otherOrg.id, type: 'meta', name: 'Gone' })
  await as(t, f.otherAdmin).mutation(api.projects.deleteDeep, {
    org_id: f.otherOrg.id,
    id: gone.id,
  })
  await as(t, f.user).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.hidden.id })
  await runSteps(t)
  // an organization whose deletion began, and a seat whose removal runs
  const deleting = await t.run(async (ctx) => {
    const id = uuid()
    const { _id, _creationTime, ...org } = f.otherOrg
    await ctx.db.insert('organizations', { ...org, id, slug: `deleting-${id.slice(0, 8)}` })
    await ctx.db.insert('org_removals', {
      org_id: id,
      reason: 'requested',
      ended_at: NOW,
      delete_after: NOW,
      phase: ORG_REMOVAL_PHASES[0],
      progress_at: NOW,
      created_at: NOW,
    })
    return id
  })
  const removed = uuid()
  await t.run((ctx) =>
    ctx.db.insert('profile_removals', {
      profile_id: removed,
      removed_at: NOW,
      phase: REMOVAL_PHASES[0],
      progress_at: NOW,
    }),
  )
  const [starred] = await all(t)
  const rows: Record<Exclude<FavoriteClass, 'ok'>, Favorite[]> & { ok: Favorite[] } = {
    // the person's star on a project they see, the Viewer's on one they see
    // stored as the public demo stores a seed's, at its seat's own time, and
    // the guest's on a project they lost
    ok: [
      await plant(t, f.user, f.meta),
      await plant(t, f.viewer, f.meta, { created_at: f.viewer.created_at }),
      await plant(t, f.guest, f.meta),
    ],
    org_gone: [await plant(t, { id: f.user.id, org_id: uuid() }, f.meta)],
    org_deleting: [await plant(t, { id: f.user.id, org_id: deleting }, f.meta)],
    profile_removing: [await plant(t, { id: removed, org_id: f.org.id }, f.meta)],
    profile_gone: [
      await plant(t, { id: uuid(), org_id: f.org.id }, f.meta),
      await plant(t, { id: f.otherAdmin.id, org_id: f.org.id }, f.meta),
    ],
    profile_newer: [await plant(t, f.admin, f.meta, { created_at: OLD })],
    project_gone: [await plant(t, f.user, { id: uuid(), name: 'Purged', archived_at: undefined })],
    project_elsewhere: [await plant(t, f.user, f.otherProject), await plant(t, f.user, gone)],
    in_deleted_items: [starred as Favorite],
    not_top_level: [await plant(t, f.user, f.sub)],
    duplicate: [await plant(t, f.user, f.meta)],
    stale_copies: [await plant(t, f.user, renamed, { name_key: 'an older name' })],
  }
  return { f, rows, renamed }
}

describe('the favorites check and repair', () => {
  it('sorts one row of each class, writes nothing in a dry run, and repairs only what it changes', async () => {
    const t = newT()
    const { rows, renamed } = await everyClass(t)
    expect(rows.in_deleted_items[0]?.project_id).toBeDefined()
    const want = counts(
      Object.fromEntries(Object.entries(rows).map(([c, list]) => [c, list.length])) as Counts,
    )
    const before = await all(t)
    const dry = await runRepair(t, true)
    expect(dry.counts).toEqual(want)
    expect(dry.cursor).toBeNull()
    expect(dry.failed).toBeNull()
    // the examples name the rows of the classes it changes or reports
    for (const cls of CLASSES) {
      const shown = new Set(dry.examples[cls] ?? [])
      const expected = ['ok', 'org_deleting', 'profile_removing', 'in_deleted_items'].includes(cls)
        ? []
        : rows[cls].map((r) => r._id)
      expect([...shown].sort(), cls).toEqual([...expected].sort())
    }
    expect(await all(t)).toEqual(before)

    const done = await runRepair(t, false)
    expect(done.counts).toEqual(want)
    const after = await all(t)
    const byId = new Map(after.map((r) => [r._id, r]))
    for (const cls of [
      'org_gone',
      'profile_gone',
      'profile_newer',
      'project_gone',
      'project_elsewhere',
      'duplicate',
    ] as const)
      for (const row of rows[cls]) expect(byId.has(row._id), cls).toBe(false)
    // every row it leaves stays exactly as it was, created_at included
    for (const cls of [
      'ok',
      'org_deleting',
      'profile_removing',
      'in_deleted_items',
      'not_top_level',
    ] as const)
      for (const row of rows[cls]) expect(byId.get(row._id), cls).toEqual(row)
    const patched = byId.get(rows.stale_copies[0]._id)
    expect(patched).toEqual({ ...rows.stale_copies[0], ...copiesOf(renamed) })
    // the person's star shows to every reader, before and after
    expect(await shows(t, rows.ok[0])).toBe(true)
    // a second run finds nothing more to change
    const again = await runRepair(t, true)
    expect(again.counts).toEqual(
      counts({
        ok: rows.ok.length + 1,
        org_deleting: 1,
        profile_removing: 1,
        in_deleted_items: 1,
        not_top_level: 1,
      }),
    )
  })

  it('keeps the earliest row of a seat on a project and the row of a project in Deleted items', async () => {
    const t = newT()
    const f = await withOrg(t)
    await withReach(t)
    // an earlier row that a newer profile cannot hold gives way, so the
    // next one is the seat's and stays
    const older = await plant(t, f.user, f.meta, { created_at: OLD })
    const kept = await plant(t, f.user, f.meta)
    const extra = await plant(t, f.user, f.meta)
    const dry = await runRepair(t, true)
    expect(dry.counts).toEqual(counts({ profile_newer: 1, ok: 1, duplicate: 1 }))
    expect(dry.examples.duplicate).toEqual([extra._id])
    await runRepair(t, false)
    expect(await all(t)).toEqual([kept])
    expect(older._id).not.toBe(kept._id)
  })

  it('keeps a stale row older than its seat once the seat stars the project again', async () => {
    const t = newT()
    const f = await withOrg(t)
    await withReach(t)
    // a row an earlier seat with this id left before the seat was made,
    // whose copies a rename under the earlier code left stale
    const left = await plant(t, f.user, f.meta, { created_at: OLD, name_key: 'an older name' })
    expect((await runRepair(t, true)).counts).toEqual(counts({ profile_newer: 1 }))
    // the readers skip it, so the person stars the project again, which
    // resets the row as a new star
    await as(t, f.user).mutation(api.projectNav.setFavorite, {
      org_id: f.org.id,
      project_id: f.meta.id,
      favorite: true,
    })
    const [row] = await all(t)
    expect(row?._id).toBe(left._id)
    expect((row?.created_at ?? '') > f.user.created_at).toBe(true)
    expect((await runRepair(t, true)).counts).toEqual(counts({ ok: 1 }))
    await runRepair(t, false)
    expect(await all(t)).toEqual([row])
    expect(await shows(t, row as Favorite)).toBe(true)
  })

  it('walks pages of a lowered size, goes on from a cursor and caps its examples', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let n = 0; n < 5; n++) await plant(t, { id: uuid(), org_id: f.org.id }, f.meta)
    EXAMPLES.most = 2
    const paged = await runRepair(t, true, { page_size: 2 })
    expect(paged.pages).toBe(3)
    expect(paged.counts).toEqual(counts({ profile_gone: 5 }))
    expect(paged.examples.profile_gone).toHaveLength(2)
    // past its time a call stops after one page and answers where to go on
    RUN.ms = 0
    const first = await runRepair(t, false, { page_size: 2 })
    expect(first.pages).toBe(1)
    expect(first.counts.profile_gone).toBe(2)
    expect(first.cursor).not.toBeNull()
    let total = first.counts.profile_gone
    let cursor = first.cursor
    for (let n = 0; n < 5 && cursor !== null; n++) {
      const step = await runRepair(t, false, { page_size: 2, cursor })
      total += step.counts.profile_gone
      cursor = step.cursor
    }
    expect(cursor).toBeNull()
    expect(total).toBe(5)
    expect(await all(t)).toEqual([])
  })

  it('reads a page of 200 rows inside one transaction’s limits', async () => {
    const t = newT()
    const f = await withOrg(t)
    // 20 seats each starring 10 top-level projects
    const projects: Doc<'projects'>[] = []
    for (let n = 0; n < 10; n++)
      projects.push(await plantProject(t, { org_id: f.org.id, type: 'meta', name: `Bench ${n}` }))
    for (let s = 0; s < 20; s++) {
      const seat = await plantSeat(t, { org_id: f.org.id, name: `Seat ${s}` })
      await t.run(async (ctx) => {
        for (const p of projects)
          await ctx.db.insert('project_favorites', {
            org_id: f.org.id,
            profile_id: seat.id,
            project_id: p.id,
            ...copiesOf(p),
            created_at: '2030-01-01T00:00:00.000Z',
          })
      })
    }
    const page = await t.query(internal.internal.favoritesRepair.check, { page_size: 200 })
    expect(page.counts.ok).toBe(200)
    expect(page.done).toBe(true)
    console.log('favoritesRepair: one page of 200 rows read', page.reads)
    // Convex's limits for one transaction: 4,096 index ranges, 32,000
    // documents and 16 MiB; about seven ranges a row at most
    expect(page.reads.ranges).toBeLessThan(7 * 200)
    expect(page.reads.documents).toBeLessThan(32_000)
    expect(page.reads.bytes).toBeLessThan(16 * MIB)
    const repaired = await t.mutation(internal.internal.favoritesRepair.repair, { page_size: 200 })
    expect(repaired.counts).toEqual(page.counts)
  })
})

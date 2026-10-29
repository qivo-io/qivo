/* Tests of internal/legacyIconsBackfill.ts: its dry run reports the legacy
 * icon and icon_color of projects, teams and the project copies Deleted
 * items keeps and writes nothing, a run clears them and changes nothing
 * else, a call goes on from the cursor the one before answered, also after
 * a page that threw, and its pages stay inside Convex's limits with icons
 * near 1 MiB.
 *
 * withOrg plants its rows without the fields, and the tests plant them, as
 * rows stored before v0.1.15 hold them. Deleted items moves run on fake
 * timers (trash.setup.ts installTrashTimers). */
/// <reference types="vite/client" />

import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { ConvexError, getDocumentSize } from 'convex/values'
import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import { PAGE, RUN, walk } from '../internal/legacyIconsBackfill'
import { byId } from '../lib/db'
import {
  as,
  NOW,
  newT,
  type OrgFixture,
  plantProject,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { deleteProject, installTrashTimers, itemFor, runSteps, storedRows } from './trash.setup'

installTrashTimers()

const DEFAULT_PAGE = { ...PAGE }
const DEFAULT_RUN = { ...RUN }
afterEach(() => {
  Object.assign(PAGE, DEFAULT_PAGE)
  Object.assign(RUN, DEFAULT_RUN)
})

type RunArgs = FunctionArgs<typeof internal.internal.legacyIconsBackfill.run>
type RunResult = FunctionReturnType<typeof internal.internal.legacyIconsBackfill.run>
type Cursor = NonNullable<RunResult['cursor']>
type Phase = Cursor['phase']
type Found = RunResult['tables'][Phase]
const PHASES: Phase[] = ['projects', 'teams', 'deleted_projects']

const run = (t: T, dry_run: boolean, cursor?: Cursor) =>
  t.action(internal.internal.legacyIconsBackfill.run, {
    dry_run,
    ...(cursor === undefined ? {} : { cursor }),
  } satisfies RunArgs)

/** What a phase finds once nothing holds either field. */
const zero = { rows: 0, icon: 0, icon_color: 0, largest_icon: 0, largest_icon_color: 0 }

/** Calls run, each call from the cursor the one before answered, until it
 * answers `done`, and answers every call's result. `first` is a call made
 * already, to go on from. */
async function drain(t: T, dry_run: boolean, first?: RunResult): Promise<RunResult[]> {
  const calls: RunResult[] = first === undefined ? [] : [first]
  let cursor = first?.cursor ?? undefined
  for (let n = 0; n < 200; n++) {
    if (calls.at(-1)?.done === true) return calls
    const got = await run(t, dry_run, cursor)
    expect(got.error).toBeUndefined()
    calls.push(got)
    cursor = got.cursor ?? undefined
  }
  throw new Error('the backfill did not finish in 200 calls')
}

/** A full dry run at the default page size and time, which must find
 * nothing left in any phase. Answers it. */
async function expectNoneLeft(t: T): Promise<RunResult> {
  Object.assign(PAGE, DEFAULT_PAGE)
  Object.assign(RUN, DEFAULT_RUN)
  const again = await run(t, true)
  expect(again).toMatchObject({ done: true, cursor: null, orgs: [] })
  for (const phase of PHASES) expect(again.tables[phase]).toMatchObject(zero)
  return again
}

/** The tables of `calls` together: the counts summed, the largest sizes
 * kept. */
const summed = (calls: RunResult[]): Record<Phase, Found> =>
  Object.fromEntries(
    PHASES.map((phase) => [
      phase,
      calls.reduce(
        (total, call) => {
          const found = call.tables[phase]
          return {
            rows: total.rows + found.rows,
            icon: total.icon + found.icon,
            icon_color: total.icon_color + found.icon_color,
            largest_icon: Math.max(total.largest_icon, found.largest_icon),
            largest_icon_color: Math.max(total.largest_icon_color, found.largest_icon_color),
            largest_row: Math.max(total.largest_row, found.largest_row),
          }
        },
        { ...zero, largest_row: 0 },
      ),
    ]),
  ) as Record<Phase, Found>

/** `row` without the legacy icon and its color. */
function iconless<R extends { icon?: string; icon_color?: string }>(row: R) {
  const { icon: _icon, icon_color: _iconColor, ...rest } = row
  return rest
}

/** The size of the largest of `rows`, measured without the two fields. */
const largest = (rows: { icon?: string; icon_color?: string }[]) =>
  Math.max(...rows.map((row) => getDocumentSize(iconless(row))))

/** Every live project and team and every stored row, in their tables'
 * order. */
const everything = (t: T) =>
  t.run(async (ctx) => ({
    projects: await ctx.db.query('projects').collect(),
    teams: await ctx.db.query('teams').collect(),
    deleted_rows: await ctx.db.query('deleted_rows').collect(),
  }))
type Everything = Awaited<ReturnType<typeof everything>>

/** `all` as a run leaves it: both fields gone from every live project and
 * team and every stored project, everything else as it was. */
const cleared = (all: Everything) => ({
  projects: all.projects.map(iconless),
  teams: all.teams.map(iconless),
  deleted_rows: all.deleted_rows.map((stored) =>
    stored.row.table === 'projects'
      ? { ...stored, row: { table: 'projects' as const, doc: iconless(stored.row.doc) } }
      : stored,
  ),
})

/** The project copies Deleted items keeps in item `itemId`. */
const storedProjects = async (t: T, itemId: string) =>
  (await storedRows(t, itemId)).flatMap((row) =>
    row.row.table === 'projects' ? [row.row.doc] : [],
  )

/** That no document of `docs` holds either field. */
function expectIconless(docs: object[]): void {
  for (const doc of docs) {
    expect(doc).not.toHaveProperty('icon')
    expect(doc).not.toHaveProperty('icon_color')
  }
}

/** The details of the backfill's audit rows, oldest first. */
const audits = (t: T) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('platform_audit_log')
        .filter((q) => q.eq(q.field('action'), 'legacy_icons_backfill'))
        .collect()
    ).map((row) => row.detail),
  )

/** Patches `fields` onto live project or team `id`. */
const set = (t: T, table: 'projects' | 'teams', id: string, fields: object) =>
  t.run(async (ctx) => {
    const row = await byId(ctx, table, id)
    if (row === null) throw new Error(`no ${table} row ${id}`)
    await ctx.db.patch(row._id, fields)
  })

/** Moves project `id` to Deleted items through the app, with its steps. */
async function trash(t: T, f: OrgFixture, id: string): Promise<void> {
  await deleteProject(t, f, id)
  await runSteps(t)
}

/** withOrg with legacy fields on some of its rows. Testbed platform holds
 * an icon of ten three-byte characters (30 bytes) and a color, Elsewhere in
 * the other organization both, Firmware a color only, Hardware an icon
 * only, and the stored copy of a deleted project both. Board rev,
 * Skunkworks, a team of the other organization and a project with a long
 * description, the largest row, hold neither. */
async function plantIcons(t: T) {
  const f = await withOrg(t)
  await set(t, 'projects', f.meta.id, { icon: '★'.repeat(10), icon_color: '#ff0000' })
  await set(t, 'projects', f.otherProject.id, { icon: 'rocket', icon_color: 'teal' })
  await set(t, 'projects', f.sub.id, { icon_color: 'blue' })
  await set(t, 'teams', f.team.id, { icon: 'cpu' })
  await t.run((ctx) =>
    ctx.db.insert('teams', {
      id: uuid(),
      org_id: f.otherOrg.id,
      name: 'Plain',
      track_delay_default: false,
      created_at: NOW,
    }),
  )
  const long = await plantProject(t, { org_id: f.org.id, description: 'd'.repeat(2_000) })
  const gone = await plantProject(t, {
    org_id: f.org.id,
    lead_id: f.user.id,
    icon: 'archive-box',
    icon_color: '#123456',
  })
  await trash(t, f, gone.id)
  return { f, long, gone }
}

describe('the legacy icons backfill', () => {
  it('reports every row holding either field and writes nothing in a dry run', async () => {
    const t = newT()
    const { f, long } = await plantIcons(t)
    const before = await everything(t)
    const stored = before.deleted_rows.flatMap((row) =>
      row.row.table === 'projects' ? [row.row.doc] : [],
    )
    expect(stored.map((doc) => doc.icon)).toEqual(['archive-box'])

    const got = await run(t, true)
    expect(got).toMatchObject({ dry_run: true, done: true, cursor: null })
    expect(got.error).toBeUndefined()
    expect(got.tables).toEqual({
      projects: {
        rows: 3,
        icon: 2,
        icon_color: 3,
        largest_icon: 30,
        largest_icon_color: 7,
        largest_row: largest(before.projects),
      },
      teams: {
        rows: 1,
        icon: 1,
        icon_color: 0,
        largest_icon: 3,
        largest_icon_color: 0,
        largest_row: largest(before.teams),
      },
      deleted_projects: {
        rows: 1,
        icon: 1,
        icon_color: 1,
        largest_icon: 11,
        largest_icon_color: 7,
        largest_row: largest(stored),
      },
    })
    // the largest project is one without either field
    expect(got.tables.projects.largest_row).toBe(getDocumentSize(long))
    expect(got.orgs.toSorted()).toEqual([f.org.id, f.otherOrg.id].toSorted())

    expect(await everything(t)).toStrictEqual(before)
    expect(await audits(t)).toEqual([])
  })

  it('clears both fields everywhere and changes nothing else', async () => {
    const t = newT()
    await plantIcons(t)
    const before = await everything(t)
    const dry = await run(t, true)

    const got = await run(t, false)
    expect(got).toMatchObject({ dry_run: false, done: true, cursor: null })
    expect(got.error).toBeUndefined()
    expect(got.tables).toEqual(dry.tables)
    // whole documents, _creationTime included, with the two keys removed
    expect(await everything(t)).toStrictEqual(cleared(before))
    expect(await audits(t)).toEqual([
      { projects: 3, teams: 1, deleted_projects: 1, done: true, cursor: null },
    ])

    const again = await expectNoneLeft(t)
    // a second run is safe and finds nothing to clear
    expect((await run(t, false)).tables).toEqual(again.tables)
  })

  it('restores a project item whose copies a run cleared without the fields', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const p of [f.meta, f.sub, f.sub2])
      await set(t, 'projects', p.id, { icon: 'flag', icon_color: '#7a7ad0' })
    await trash(t, f, f.meta.id)
    expect((await run(t, false)).tables.deleted_projects.rows).toBe(3)
    const item = await itemFor(t, f.meta.id)
    // the run cleared the copies, so the restore has nothing to leave out
    const copies = await storedProjects(t, item.id)
    expect(copies).toHaveLength(3)
    expectIconless(copies)
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id: f.org.id, ids: [item.id] })
    await runSteps(t)
    for (const p of [f.meta, f.sub, f.sub2]) {
      const back = await t.run((ctx) => byId(ctx, 'projects', p.id))
      expect(back).toMatchObject({ id: p.id, name: p.name })
      expectIconless([back ?? {}])
    }
  })

  it('goes on from each cursor to the totals of one call, and refuses the other mode', async () => {
    const t = newT()
    await plantIcons(t)
    const whole = await run(t, true)
    expect(whole.done).toBe(true)

    PAGE.rows = 1
    RUN.ms = 0
    const calls = await drain(t, true)
    // each call took one page of one row
    for (const call of calls)
      expect(PHASES.reduce((rows, phase) => rows + call.tables[phase].rows, 0)).toBeLessThan(2)
    const { projects, teams, deleted_rows } = await everything(t)
    const stored = deleted_rows.filter((row) => row.table === 'projects')
    expect(calls.length).toBeGreaterThanOrEqual(projects.length + teams.length + stored.length)
    expect(summed(calls)).toEqual(whole.tables)
    expect(new Set(calls.flatMap((call) => call.orgs))).toEqual(new Set(whole.orgs))

    // a dry run's cursor does not resume a run, nor a run's a dry run
    const dryCursor = calls[0].cursor ?? undefined
    expect(dryCursor).toMatchObject({ dry_run: true, phase: 'projects' })
    await expect(run(t, false, dryCursor)).rejects.toThrow('other dry_run')
    const first = await run(t, false)
    expect(first.cursor).toMatchObject({ dry_run: false, phase: 'projects' })
    await expect(run(t, true, first.cursor ?? undefined)).rejects.toThrow('other dry_run')

    // a run in as many calls clears what one call would, an audit row each
    const clearing = await drain(t, false, first)
    expect(summed(clearing)).toEqual(whole.tables)
    const rows = await audits(t)
    expect(rows).toHaveLength(clearing.length)
    expect(rows.at(-1)).toMatchObject({ done: true, cursor: null })
    await expectNoneLeft(t)
  })

  it('records what committed when a page throws, and goes on from that page', async () => {
    // withOrg writes 20 documents in one transaction
    const t = newT({ transactionLimits: { documentsWritten: 20 } })
    const f = await withOrg(t)
    // after withOrg's 5 projects, the first page of 21 clears 16 icons and
    // the second 21, past the 20 writes a transaction may make
    for (let i = 0; i < 37; i++) await plantProject(t, { org_id: f.org.id, icon: 'i' })
    PAGE.rows = 21
    const failed = await run(t, false)
    expect(failed).toMatchObject({
      done: false,
      error: expect.any(String),
      cursor: { dry_run: false, phase: 'projects', cursor: expect.any(String) },
    })
    expect(failed.tables.projects.rows).toBe(16)
    expect(await audits(t)).toEqual([
      {
        projects: 16,
        teams: 0,
        deleted_projects: 0,
        done: false,
        cursor: failed.cursor,
        error: failed.error,
      },
    ])
    // the page that threw cleared nothing
    const held = await t.run(async (ctx) =>
      (await ctx.db.query('projects').collect()).filter((p) => p.icon !== undefined),
    )
    expect(held).toHaveLength(21)

    // a page of fewer rows fits
    PAGE.rows = 10
    const calls = await drain(t, false, await run(t, false, failed.cursor ?? undefined))
    expect(summed(calls).projects.rows).toBe(21)
    await expectNoneLeft(t)
  })

  it('clears the copy of a project moved to Deleted items while it runs', async () => {
    const t = newT()
    const f = await withOrg(t)
    const moved = await plantProject(t, {
      org_id: f.org.id,
      lead_id: f.user.id,
      icon: 'i',
      icon_color: 'red',
    })
    PAGE.rows = 1
    RUN.ms = 0
    // the walk stops after Testbed platform, before the project planted last
    const first = await run(t, false)
    expect(first.cursor).toMatchObject({ phase: 'projects' })
    await trash(t, f, moved.id)
    const calls = await drain(t, false, first)
    expect(summed(calls)).toMatchObject({
      projects: { rows: 0 },
      teams: { rows: 0 },
      deleted_projects: { rows: 1, icon: 1, icon_color: 1 },
    })
    const copies = await storedProjects(t, (await itemFor(t, moved.id)).id)
    expect(copies.map((doc) => doc.id)).toEqual([moved.id])
    expectIconless(copies)
    await expectNoneLeft(t)
  })

  /** One page of `phase` from `cursor` as `page` clears it, and what it read
   * and wrote. It throws its result to roll the page back, so the data stays
   * as it was for the run after it. */
  async function measure(t: T, phase: Phase, cursor: string | null) {
    try {
      await t.run(async (ctx) => {
        const got = await walk(ctx, phase, cursor, ctx)
        const m = await ctx.meta.getTransactionMetrics()
        throw new ConvexError({
          cursor: got.cursor,
          done: got.done,
          rows: got.rows,
          bytesRead: m.bytesRead.used,
          bytesWritten: m.bytesWritten.used,
          documentsRead: m.documentsRead.used,
          documentsWritten: m.documentsWritten.used,
          databaseQueries: m.databaseQueries.used,
        })
      })
    } catch (thrown) {
      if (!(thrown instanceof ConvexError)) throw thrown
      return thrown.data as {
        cursor: string
        done: boolean
        rows: number
        bytesRead: number
        bytesWritten: number
        documentsRead: number
        documentsWritten: number
        databaseQueries: number
      }
    }
    throw new Error('the measured page committed')
  }

  it('clears icons near 1 MiB inside the limits of a transaction', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const org_id = f.org.id
    // live rows near Convex's 1 MiB, planted one a call
    for (let i = 0; i < 12; i++)
      await plantProject(t, { org_id, icon: 'i'.repeat(1_020_000), icon_color: '#7a7ad0' })
    for (let i = 0; i < 12; i++)
      await t.run((ctx) =>
        ctx.db.insert('teams', {
          id: uuid(),
          org_id,
          name: `Team ${i}`,
          track_delay_default: false,
          created_at: NOW,
          icon: 'i'.repeat(1_020_000),
        }),
      )
    // stored copies under the size a stored row may hold
    // (STORED_ROW_MAX_BYTES)
    for (let i = 0; i < 6; i++) {
      const p = await plantProject(t, { org_id, lead_id: f.user.id, icon: 'i'.repeat(990_000) })
      await trash(t, f, p.id)
    }

    // every page as a run clears it, rolled back
    let most: Awaited<ReturnType<typeof measure>> | null = null
    let pages = 0
    for (const phase of PHASES) {
      let cursor: string | null = null
      for (;;) {
        const page: Awaited<ReturnType<typeof measure>> = await measure(t, phase, cursor)
        pages += 1
        if (most === null || page.bytesRead > most.bytesRead) most = page
        if (page.done) break
        cursor = page.cursor
      }
    }
    console.info('the largest page of the legacy icons backfill', { pages, most })
    expect(most?.bytesRead).toBeLessThan(16 << 20)

    const dry = await run(t, true)
    expect(dry).toMatchObject({ done: true, cursor: null })
    expect(dry.error).toBeUndefined()
    expect(dry.tables).toMatchObject({
      projects: { rows: 12, icon: 12, icon_color: 12, largest_icon: 1_020_000 },
      teams: { rows: 12, icon: 12, largest_icon: 1_020_000 },
      deleted_projects: { rows: 6, icon: 6, largest_icon: 990_000 },
    })
    const got = await run(t, false)
    expect(got).toMatchObject({ done: true, cursor: null })
    expect(got.error).toBeUndefined()
    expect(got.tables).toEqual(dry.tables)
    await expectNoneLeft(t)
  }, 300_000)
})

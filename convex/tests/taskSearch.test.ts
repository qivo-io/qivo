/* Machine task search (lib/core.ts listActiveIssuesCore and
 * listArchivedIssuesCore, behind REST GET /v1/tasks?search= and MCP
 * list_tasks `search`) reads a label's assignments only when a search piece
 * occurs in the label's name, reads no assignment of an archived task in an
 * active list, and still matches exactly as the matcher did when it read
 * every label. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import {
  issueKey,
  LABEL_READS_RESERVE,
  LABEL_TASK_READS,
  listActiveIssuesCore,
  listArchivedIssuesCore,
  loadCatalogue,
  SEARCH_TOO_LARGE,
  TEXT_TASK_READS,
} from '../lib/core'
import type { Refusal } from '../lib/functions'
import { allWordsMatcher, searchPieces, taskSearchText } from '../lib/search'
import { descriptionOf } from '../model/descriptions'
import {
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  restTasks,
  type T,
  TODAY,
  uuid,
  withOrg,
} from './helpers.setup'

type Fx = OrgFixture & { t: T }

/* A label of the fixture organization, inserted raw. */
async function plantLabel(t: T, orgId: string, name: string): Promise<string> {
  const id = uuid()
  await t.run(async (ctx) => {
    await ctx.db.insert('labels', {
      id,
      org_id: orgId,
      name,
      name_lower: name.toLowerCase(),
      color: '#4C9AFF',
      created_at: NOW,
    })
  })
  return id
}

/* Assigns `labelId` to each task. */
const label = (fx: Fx, labelId: string, tasks: Doc<'issues'>[]) =>
  fx.t.run(async (ctx) => {
    for (const task of tasks) {
      await ctx.db.insert('issue_labels', {
        org_id: fx.org.id,
        issue_id: task.id,
        label_id: labelId,
      })
    }
  })

/** One search, over active or archived tasks. */
type SearchCase = { search: string; stars: boolean; archived: boolean }

/* An admin's active list of the whole organization, through the shared core. */
const activeList = async (ctx: MutationCtx, fx: Fx, search: string) =>
  await listActiveIssuesCore(
    ctx,
    fx.admin,
    { today: TODAY, scope: null, search, stars: true, limit: 1000, offset: 0 },
    { surface: 'rest', cat: await loadCatalogue(ctx, fx.admin), readable: () => true },
  )

/* The task ids an admin's search finds, through the shared cores. Archived
 * tasks are listed one project at a time, so that half reads FW, which holds
 * every task of the fixture. */
const found = (fx: Fx, c: SearchCase) =>
  fx.t.run(async (ctx) => {
    const view = {
      surface: 'rest',
      cat: await loadCatalogue(ctx, fx.admin),
      readable: () => true,
    } as const
    const filters = { search: c.search, stars: c.stars, limit: 1000 }
    const rows = c.archived
      ? (
          await listArchivedIssuesCore(
            ctx,
            fx.admin,
            { ...filters, scope: [fx.sub.id], cursor: null },
            view,
          )
        ).rows
      : await listActiveIssuesCore(
          ctx,
          fx.admin,
          { today: TODAY, ...filters, scope: null, offset: 0 },
          view,
        )
    return rows.map((i) => i.id).sort()
  })

/* The matcher as it was before label reads were narrowed. It read every
 * label's assignments through each label in organization order and joined
 * them into each task's search text. The fixture has no subtasks, so no
 * status line is dormant. */
async function oldMatch(ctx: MutationCtx, fx: Fx, c: SearchCase): Promise<string[]> {
  return (await oldMatches(ctx, fx, c)).map((i) => i.id).sort()
}

/* The tasks oldMatch finds, in the order an active list answers them,
 * oldest first by creation with ties by number. */
async function oldMatches(ctx: MutationCtx, fx: Fx, c: SearchCase): Promise<Doc<'issues'>[]> {
  const labels = new Map<string, string[]>()
  const rows = ctx.db.query('labels').withIndex('by_org', (q) => q.eq('org_id', fx.org.id))
  for await (const l of rows) {
    const uses = ctx.db.query('issue_labels').withIndex('by_label', (q) => q.eq('label_id', l.id))
    for await (const use of uses)
      labels.set(use.issue_id, [...(labels.get(use.issue_id) ?? []), l.name])
  }
  const profiles = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', fx.org.id))
    .collect()
  const names = new Map(profiles.map((p) => [p.id, p.name]))
  const matches = allWordsMatcher(c.search, c.stars)
  const tasks = await ctx.db
    .query('issues')
    .withIndex('by_org', (q) => q.eq('org_id', fx.org.id))
    .collect()
  const filtered: Doc<'issues'>[] = []
  for (const i of tasks)
    if (
      (i.archived_at !== undefined) === c.archived &&
      matches(
        taskSearchText({
          key: issueKey(i.num),
          title: i.title,
          description: await descriptionOf(ctx.db, i),
          status: i.status,
          group: false,
          priority: i.priority,
          assigneeName: i.assignee_id === undefined ? null : names.get(i.assignee_id),
          labelNames: labels.get(i.id) ?? [],
        }),
      )
    )
      filtered.push(i)
  return filtered.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.num - b.num)
}

/* Tasks in FW with labels created in the order Thermal, Power supply,
 * Legacy (stored without an organization), ΟΔΟΣ and R&D*2. */
async function mixed() {
  const t = newT()
  const fx: Fx = { t, ...(await withOrg(t)) }
  const task = (title: string, extra: Partial<Doc<'issues'>> = {}) =>
    plantIssue(t, { org_id: fx.org.id, project_id: fx.sub.id, title, ...extra })
  const bracket = await task('Bracket', { assignee_id: fx.user.id, priority: 'high' })
  const lid = await task('Lid', { status: 'progress' })
  const gasket = await task('Gasket', { description: 'seal ring' })
  const sign = await task('Road sign')
  const paste = await task('Thermal paste')
  const stale = await task('Old bracket', { archived_at: NOW })
  const thermal = await plantLabel(t, fx.org.id, 'Thermal')
  const power = await plantLabel(t, fx.org.id, 'Power supply')
  const legacy = await plantLabel(t, fx.org.id, 'Legacy')
  const greek = await plantLabel(t, fx.org.id, 'ΟΔΟΣ')
  const starred = await plantLabel(t, fx.org.id, 'R&D*2')
  await label(fx, thermal, [bracket, stale])
  await label(fx, power, [bracket, lid])
  await label(fx, legacy, [gasket])
  await label(fx, greek, [sign])
  await label(fx, starred, [sign, paste])
  return { fx, bracket, lid, gasket, sign, paste, stale, thermal }
}

const DEFAULT_LABEL_READS = { ...LABEL_TASK_READS }
const DEFAULT_LABEL_RESERVE = { ...LABEL_READS_RESERVE }
const DEFAULT_TEXT_READS = { ...TEXT_TASK_READS }
afterEach(() => {
  Object.assign(LABEL_TASK_READS, DEFAULT_LABEL_READS)
  Object.assign(LABEL_READS_RESERVE, DEFAULT_LABEL_RESERVE)
  Object.assign(TEXT_TASK_READS, DEFAULT_TEXT_READS)
})

/* 27 tasks that match a search through each mix of their title, labels and
 * description, in turn and alternating between FW's two sub-projects, with
 * the labels Zephyr and Wire harness. */
async function labelPages(): Promise<Fx> {
  const t = newT()
  const fx: Fx = { t, ...(await withOrg(t)) }
  const zephyr = await plantLabel(t, fx.org.id, 'Zephyr')
  const wire = await plantLabel(t, fx.org.id, 'Wire harness')
  const kinds: { title: string; description?: string; labels?: string[] }[] = [
    { title: 'Zephyr wire' },
    { title: 'Bracket', description: 'Wire the board', labels: [zephyr] },
    { title: 'Bracket', description: 'zephyr and wire' },
    { title: 'Wire', labels: [zephyr] },
    { title: 'Nothing here' },
    { title: 'Bracket', labels: [zephyr, wire] },
    { title: 'Bracket', description: 'board', labels: [zephyr] },
    { title: 'Bracket', description: 'zephyr' },
    { title: 'Zephyr', description: 'wire' },
  ]
  for (let n = 0; n < 27; n++) {
    const kind = kinds[n % kinds.length]
    const task = await plantIssue(t, {
      org_id: fx.org.id,
      project_id: n % 2 === 0 ? fx.sub.id : fx.sub2.id,
      title: kind.title,
      description: kind.description ?? '',
    })
    for (const id of kind.labels ?? []) await label(fx, id, [task])
  }
  return fx
}

describe('task search reads only the labels it can match', () => {
  it('splits a search into its distinct non-empty pieces', () => {
    expect(searchPieces('Therm  brack*ET therm', true)).toEqual(['therm', 'brack', 'et'])
    expect(searchPieces('brack*et', false)).toEqual(['brack*et'])
    expect(searchPieces('* ** ', true)).toEqual([])
    expect(searchPieces('  ', false)).toEqual([])
  })

  it('finds a task whose label supplies one fragment and title another, on both surfaces', async () => {
    const { fx, bracket, lid } = await mixed()
    const rest = async (search: string) =>
      (
        await restTasks(fx.t, {
          callerId: fx.admin.id,
          access: 'read',
          search,
        })
      ).map((row) => row.id)
    const mcp = async (search: string) =>
      (
        JSON.parse(
          await fx.t.query(internal.machine.mcp.listIssues, {
            today: TODAY,
            callerId: fx.admin.id,
            access: 'read',
            search,
          }),
        ) as { id: string }[]
      ).map((row) => row.id)
    for (const ids of [rest, mcp]) {
      expect(await ids('therm brack')).toEqual([bracket.id])
      expect(await ids('lid supply')).toEqual([lid.id])
      expect(await ids('therm lid')).toEqual([])
    }
    // a REST `*` fragment may run from the title into a label line
    expect(await rest('brack*supp')).toEqual([bracket.id])
    expect(await mcp('brack*supp')).toEqual([])
  })

  it('reads no assignment of a label that no search piece names', async () => {
    const { fx, thermal } = await mixed()
    // each matching label's assignments, as a search of many tasks reads them
    LABEL_TASK_READS.reads = 0
    const tasks: Doc<'issues'>[] = []
    for (let n = 0; n < 20; n++) {
      tasks.push(
        await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: `Spare ${n}` }),
      )
    }
    // each listed row also reads its newest comment, one range and, as no
    // task here has comments, no document, which the ranges leave out
    const reads = (search: string) =>
      fx.t.run(async (ctx) => {
        const before = await ctx.meta.getTransactionMetrics()
        const rows = await activeList(ctx, fx, search)
        const after = await ctx.meta.getTransactionMetrics()
        return {
          documents: after.documentsRead.used - before.documentsRead.used,
          ranges: after.databaseQueries.used - before.databaseQueries.used - rows.length,
        }
      })
    const missBefore = await reads('zzz')
    const hitBefore = await reads('therm')
    await label(fx, thermal, tasks)
    // after twenty more Thermal assignments, a search that names no label
    // reads exactly what it read before, and one that names Thermal reads
    // all twenty
    expect(await reads('zzz')).toEqual(missBefore)
    expect(await reads('therm')).toEqual({ ...hitBefore, documents: hitBefore.documents + 20 })
    // Thermal's assignments are one index range and its 22 rows
    expect(hitBefore.ranges - missBefore.ranges).toBe(1)
    expect((await reads('therm')).documents - missBefore.documents).toBe(22)
  })

  it('reads the labels of only the tasks that miss without them, one task at a time', async () => {
    const { fx, thermal } = await mixed()
    const spares: Doc<'issues'>[] = []
    for (let n = 0; n < 20; n++) {
      spares.push(
        await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: `Spare ${n}` }),
      )
    }
    await label(fx, thermal, spares)
    const ranges = (search: string) =>
      fx.t.run(async (ctx) => {
        const before = (await ctx.meta.getTransactionMetrics()).databaseQueries.used
        const rows = await activeList(ctx, fx, search)
        const used = (await ctx.meta.getTransactionMetrics()).databaseQueries.used - before
        return { rows: rows.length, ranges: used - rows.length }
      })
    // 'spare' matches the twenty by title, so no task needs its labels, and
    // 'spare therm' needs those of every active task its text misses, the
    // twenty Spares and the fixture's five, one range each
    const titles = await ranges('spare')
    expect(titles.rows).toBe(20)
    expect(await ranges('spare therm')).toEqual({ rows: 20, ranges: titles.ranges + 25 })
    // a search that names no label reads no assignment
    expect(await ranges('lid')).toEqual({ rows: 1, ranges: titles.ranges })
  })

  it('reads one assignment per task and matching label, however many labels a task carries', async () => {
    const { fx, thermal } = await mixed()
    const spares: Doc<'issues'>[] = []
    for (let n = 0; n < 20; n++) {
      spares.push(
        await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: `Spare ${n}` }),
      )
    }
    await label(fx, thermal, spares)
    // thirty more labels on every Spare, none of which the search names
    for (let n = 0; n < 30; n++)
      await label(fx, await plantLabel(fx.t, fx.org.id, `Other ${n}`), spares)
    const documents = (search: string) =>
      fx.t.run(async (ctx) => {
        const before = (await ctx.meta.getTransactionMetrics()).documentsRead.used
        await activeList(ctx, fx, search)
        return (await ctx.meta.getTransactionMetrics()).documentsRead.used - before
      })
    // the twenty Spares' Thermal rows and Bracket's, not the 600 others
    expect((await documents('spare therm')) - (await documents('spare'))).toBe(21)
  })

  it('refuses a search whose label assignments do not fit, and names a way out', async () => {
    const { fx, thermal } = await mixed()
    const spares: Doc<'issues'>[] = []
    for (let n = 0; n < 600; n++) {
      spares.push(
        await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: `Spare ${n}` }),
      )
    }
    await label(fx, thermal, spares)
    LABEL_TASK_READS.reads = 0
    // the reserve stands in for everything else the request read
    LABEL_READS_RESERVE.documents = 32_000 - 400
    const e = await expectRefusal(
      restTasks(fx.t, { callerId: fx.admin.id, access: 'read', search: 'therm' }),
      'bad_request',
    )
    expect((e.data as Refusal).message).toBe(SEARCH_TOO_LARGE)
    // a search that the titles answer reads no assignment. It reads the
    // descriptions of the tasks before the first spare, which need the room
    // the reserve stood in for.
    Object.assign(LABEL_READS_RESERVE, DEFAULT_LABEL_RESERVE)
    expect(
      await restTasks(fx.t, { callerId: fx.admin.id, access: 'read', search: 'spare', limit: '1' }),
    ).toHaveLength(1)
  })

  it('checks the request before each matching label, even one without assignments', async () => {
    const { fx } = await mixed()
    for (let n = 0; n < 100; n++) await plantLabel(fx.t, fx.org.id, `Therm ${n}`)
    LABEL_TASK_READS.reads = 0
    // the reserve leaves the label reads about 40 ranges, fewer than the
    // labels the search names, none of which holds a row to check after
    LABEL_READS_RESERVE.ranges = 4096 - 40
    const e = await expectRefusal(
      restTasks(fx.t, { callerId: fx.admin.id, access: 'read', search: 'therm' }),
      'bad_request',
    )
    expect((e.data as Refusal).message).toBe(SEARCH_TOO_LARGE)
  })

  it('answers every page that main answered, the matches its labels complete counted toward it', async () => {
    const fx = await labelPages()
    const page = (search: string, offset: number, limit: number) =>
      fx.t.run(async (ctx) =>
        (
          await listActiveIssuesCore(
            ctx,
            fx.admin,
            { today: TODAY, scope: null, search, stars: true, limit, offset },
            { surface: 'rest', cat: await loadCatalogue(ctx, fx.admin), readable: () => true },
          )
        ).map((row) => row.id),
      )
    const searches = ['zephyr', 'zephyr wire', 'wire zephyr', 'board zephyr', 'harness', 'zzz']
    // texts and labels read one task at a time, through ranges, or both
    for (const [texts, labels] of [
      [DEFAULT_TEXT_READS.reads, DEFAULT_LABEL_READS.reads],
      [0, DEFAULT_LABEL_READS.reads],
      [DEFAULT_TEXT_READS.reads, 0],
      [0, 0],
    ]) {
      TEXT_TASK_READS.reads = texts
      LABEL_TASK_READS.reads = labels
      for (const search of searches) {
        const all = (
          await fx.t.run((ctx) => oldMatches(ctx, fx, { search, stars: true, archived: false }))
        ).map((i) => i.id)
        if (search !== 'zzz') expect(all.length).toBeGreaterThan(2)
        for (const limit of [1, 3])
          for (let offset = 0; offset <= all.length; offset++)
            expect(
              await page(search, offset, limit),
              `${search} at ${offset}, ${limit} a page, ${texts} texts and ${labels} labels one by one`,
            ).toEqual(all.slice(offset, offset + limit))
      }
    }
  }, 300_000)

  it('finds exactly what the matcher found when it read every label', async () => {
    const { fx } = await mixed()
    for (const reads of [DEFAULT_LABEL_READS.reads, 0]) {
      LABEL_TASK_READS.reads = reads
      await sameAsOldMatch(fx)
    }
  })
})

/* Every search case finds what oldMatch finds. */
async function sameAsOldMatch(fx: Fx) {
  const searches = [
    'therm',
    'Thermal',
    'therm brack',
    'brack therm',
    'therm lid',
    'power',
    'power supply',
    'supply lid',
    'legacy',
    'gask leg',
    'ring legacy',
    'οδος',
    'ΟΔΟΣ sign',
    'r&d',
    'd*2',
    'r&d*2 paste',
    'brack*therm',
    'brack*supp',
    'therm*power',
    'power*therm',
    'user*therm',
    'high*supply',
    'progress*supply',
    'qn-*leg',
    'thermal*paste',
    'paste*r&d',
    'sign*d*2',
    '*',
    '** therm*',
    '*supply',
    'zzz',
    'therm zzz',
  ]
  for (const search of searches) {
    for (const stars of [true, false]) {
      for (const archived of [false, true]) {
        const c = { search, stars, archived }
        const expected = await fx.t.run((ctx) => oldMatch(ctx, fx, c))
        expect(await found(fx, c), `${search} stars=${stars} archived=${archived}`).toEqual(
          expected,
        )
      }
    }
  }
}

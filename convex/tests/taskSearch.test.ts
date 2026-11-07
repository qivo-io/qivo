/* Machine task search (lib/activeTaskPage.ts listActiveIssuesCore and
 * lib/core.ts listArchivedIssuesCore, behind REST GET /v1/tasks?search= and
 * MCP list_tasks `search`) reads a task's label assignments only when a
 * search piece occurs in one of the organization's label names and the
 * task's own fields miss, reads them through the task itself, never through
 * a label across the organization, and still matches exactly as the matcher
 * did when it read every label. A search page that runs out of budget ends
 * with a cursor, and the next page goes on. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { ACTIVE_PAGE, listActiveIssuesCore } from '../lib/activeTaskPage'
import { ARCHIVE_LABELS } from '../lib/archivedTasks'
import { issueKey, listArchivedIssuesCore, loadCatalogue } from '../lib/core'
import { allWordsMatcher, searchPieces, taskSearchText } from '../lib/search'
import { descriptionOf } from '../model/descriptions'
import {
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  restTasks,
  type T,
  TODAY,
  uuid,
  withReadingAdmin,
} from './helpers.setup'
import { lowered, mcpPage, restPage, restPages } from './taskPages.setup'

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

/* The rows of an admin's first page of the whole organization's active
 * tasks, through the shared core. */
const activeList = async (ctx: MutationCtx, fx: Fx, search: string) =>
  (
    await listActiveIssuesCore(
      ctx,
      fx.admin,
      { today: TODAY, scope: null, project: null, search, stars: true, limit: 1000, cursor: null },
      { surface: 'rest', cat: await loadCatalogue(ctx, fx.admin), readable: () => true },
    )
  ).rows

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
      : (
          await listActiveIssuesCore(
            ctx,
            fx.admin,
            { today: TODAY, ...filters, scope: null, project: null, cursor: null },
            view,
          )
        ).rows
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
  const fx: Fx = { t, ...(await withReadingAdmin(t)) }
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

/* The organization's labels a search scans before it reads a task's labels
 * by id (lib/archivedTasks.ts scannedLabels). Tests set it to 0 to read
 * every label by id. */
const DEFAULT_LABEL_SCAN = ARCHIVE_LABELS.scan
afterEach(() => {
  ARCHIVE_LABELS.scan = DEFAULT_LABEL_SCAN
})

/* 27 tasks that match a search through each mix of their title, labels and
 * description, in turn and alternating between FW's two sub-projects, with
 * the labels Zephyr and Wire harness. */
async function labelPages(): Promise<Fx> {
  const t = newT()
  const fx: Fx = { t, ...(await withReadingAdmin(t)) }
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
        await mcpPage(fx.t, {
          callerId: fx.admin.id,
          access: 'read',
          search,
        })
      ).tasks.map((row) => row.id)
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
    const tasks: Doc<'issues'>[] = []
    for (let n = 0; n < 20; n++) {
      tasks.push(
        await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: `Spare ${n}` }),
      )
    }
    // searches that no task matches, so no row adds reads of its own
    const reads = (search: string) =>
      fx.t.run(async (ctx) => {
        const before = await ctx.meta.getTransactionMetrics()
        const rows = await activeList(ctx, fx, search)
        const after = await ctx.meta.getTransactionMetrics()
        expect(rows).toEqual([])
        return {
          documents: after.documentsRead.used - before.documentsRead.used,
          ranges: after.databaseQueries.used - before.databaseQueries.used,
        }
      })
    const missBefore = await reads('zzz qqq')
    const hitBefore = await reads('therm qqq')
    await label(fx, thermal, tasks)
    // after twenty more Thermal assignments, a search that names no label
    // reads exactly what it read before, and one that names Thermal reads
    // the twenty through their tasks, in the ranges it read before
    expect(await reads('zzz qqq')).toEqual(missBefore)
    expect(await reads('therm qqq')).toEqual({
      ...hitBefore,
      documents: hitBefore.documents + 20,
    })
    // one range of its own assignments for each of the 25 active tasks
    expect(hitBefore.ranges - missBefore.ranges).toBe(25)
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
        return { rows: rows.length, ranges: used }
      })
    // 'spare' matches the twenty by title, so no task needs its labels, and
    // 'spare therm' needs those of every active task its text misses, the
    // twenty Spares and the fixture's five, one range each, for the same
    // twenty rows
    const titles = await ranges('spare')
    expect(titles.rows).toBe(20)
    expect(await ranges('spare therm')).toEqual({ rows: 20, ranges: titles.ranges + 25 })
  })

  it('reads a task’s own assignments, never a label’s across the organization', async () => {
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
    // the assignments of the 25 active tasks, all 31 of each Spare's and
    // the fixture's seven
    const own = 20 * 31 + 7
    expect((await documents('spare therm')) - (await documents('spare'))).toBe(own)
    // Thermal on 300 archived tasks and 300 more Others on a task of
    // another project adds nothing a search of FW's tasks reads
    const archived: Doc<'issues'>[] = []
    for (let n = 0; n < 300; n++)
      archived.push(
        await plantIssue(fx.t, {
          org_id: fx.org.id,
          project_id: fx.sub.id,
          title: `Old ${n}`,
          archived_at: NOW,
        }),
      )
    await label(fx, thermal, archived)
    expect((await documents('spare therm')) - (await documents('spare'))).toBe(own)
  })

  it('ends a search page whose label reads pass its budget early, and the next goes on', async () => {
    const { fx, thermal } = await mixed()
    // FW's 300 open tasks with the fixture's five, 297 of them Thermal
    const spares: Doc<'issues'>[] = []
    for (let n = 0; n < 295; n++) {
      spares.push(
        await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: `Spare ${n}` }),
      )
    }
    await label(fx, thermal, spares)
    const expected = (
      await fx.t.run((ctx) =>
        oldMatches(ctx, fx, { search: 'therm', stars: true, archived: false }),
      )
    ).map((i) => i.id)
    expect(expected).toHaveLength(297)
    // a page budget of 300 documents, fewer than 200 matches read
    const budget = { page: { documents: 300, delays: { ...ACTIVE_PAGE.delays, documents: 50 } } }
    await lowered(budget, async () => {
      const args = { callerId: fx.admin.id, access: 'read' as const, search: 'therm', limit: '200' }
      const first = await restPage(fx.t, args)
      expect(first.tasks.length).toBeGreaterThan(0)
      expect(first.tasks.length).toBeLessThan(200)
      expect(first.next_cursor).toEqual(expect.any(String))
      const all = await restPages(fx.t, args)
      expect(all.rows.map((row) => row.id)).toEqual(expected)
    })
    // a search that the titles answer reads no assignment
    expect(
      await restTasks(fx.t, { callerId: fx.admin.id, access: 'read', search: 'spare', limit: '1' }),
    ).toHaveLength(1)
  })

  it('reads a task’s assignments once, however many labels the search names', async () => {
    const { fx } = await mixed()
    const ranges = async (search: string) =>
      await fx.t.run(async (ctx) => {
        const before = (await ctx.meta.getTransactionMetrics()).databaseQueries.used
        expect(await activeList(ctx, fx, search)).toEqual([])
        return (await ctx.meta.getTransactionMetrics()).databaseQueries.used - before
      })
    const one = (await ranges('therm qqq')) - (await ranges('zzz qqq'))
    // the five active tasks' own assignments, one range each
    expect(one).toBe(5)
    // a hundred more labels the search names, none of them on a task
    for (let n = 0; n < 100; n++) await plantLabel(fx.t, fx.org.id, `Therm ${n}`)
    expect((await ranges('therm qqq')) - (await ranges('zzz qqq'))).toBe(one)
  })

  it('answers every page that main answered, the matches its labels complete counted toward it', async () => {
    const fx = await labelPages()
    const searches = ['zephyr', 'zephyr wire', 'wire zephyr', 'board zephyr', 'harness', 'zzz']
    // labels from the organization's scan, or read by id past it
    for (const scan of [DEFAULT_LABEL_SCAN, 0]) {
      ARCHIVE_LABELS.scan = scan
      for (const search of searches) {
        const all = (
          await fx.t.run((ctx) => oldMatches(ctx, fx, { search, stars: true, archived: false }))
        ).map((i) => i.id)
        if (search !== 'zzz') expect(all.length).toBeGreaterThan(2)
        for (const limit of [1, 3]) {
          const label = `${search}, ${limit} a page, ${scan} labels scanned`
          const pages = await restPages(fx.t, {
            callerId: fx.admin.id,
            access: 'read',
            search,
            limit: String(limit),
          })
          expect(
            pages.rows.map((row) => row.id),
            label,
          ).toEqual(all)
          // every page but the last is full
          expect(pages.sizes.slice(0, -1), label).toEqual(pages.sizes.slice(0, -1).map(() => limit))
        }
      }
    }
  })

  it('finds exactly what the matcher found when it read every label', async () => {
    const { fx } = await mixed()
    // labels from the organization's scan, or read by id past it
    for (const scan of [DEFAULT_LABEL_SCAN, 0]) {
      ARCHIVE_LABELS.scan = scan
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

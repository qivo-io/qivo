/* Machine task search (lib/core.ts listActiveIssuesCore and
 * listArchivedIssuesCore, behind REST GET /v1/tasks?search= and MCP
 * list_tasks `search`) reads a label's assignments only when a search piece
 * occurs in the label's name, reads no assignment of an archived task in an
 * active list, and still matches exactly as the matcher did when it read
 * every label. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { issueKey, listActiveIssuesCore, listArchivedIssuesCore, loadCatalogue } from '../lib/core'
import { allWordsMatcher, searchPieces, taskSearchText } from '../lib/search'
import {
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

/* Assigns `labelId` to each task; `legacy` stores rows without an organization. */
const label = (fx: Fx, labelId: string, tasks: Doc<'issues'>[], legacy = false) =>
  fx.t.run(async (ctx) => {
    for (const task of tasks) {
      await ctx.db.insert('issue_labels', {
        ...(legacy ? {} : { org_id: fx.org.id }),
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
  return tasks
    .filter((i) => (i.archived_at !== undefined) === c.archived)
    .filter((i) =>
      matches(
        taskSearchText({
          key: issueKey(i.num),
          title: i.title,
          description: i.description,
          status: i.status,
          group: false,
          priority: i.priority,
          assigneeName: i.assignee_id === undefined ? null : names.get(i.assignee_id),
          labelNames: labels.get(i.id) ?? [],
        }),
      ),
    )
    .map((i) => i.id)
    .sort()
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
  await label(fx, legacy, [gasket], true)
  await label(fx, greek, [sign])
  await label(fx, starred, [sign, paste])
  return { fx, bracket, lid, gasket, sign, paste, stale, thermal }
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

  it('finds exactly what the matcher found when it read every label', async () => {
    const { fx } = await mixed()
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
  })
})

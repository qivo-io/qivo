/* REST GET /v1/tasks?archived=true and MCP list_tasks with `archived: true`
 * under Convex's real transaction limits at the design size
 * (lib/archivedTasks.ts ARCHIVE_PAGE), with ordinary text. Each case raises
 * one figure, the rest at everyday values: the catalogue every list reads
 * first, 2,000 projects and sub-projects live and archived, as in
 * activeTaskPagesScale.test.ts, the 1,000 people of the roster an archived
 * list reads before its page, or the 200 sub-projects one person reads.
 * Only the two families the pages list hold archived tasks, 210 each, so a
 * page of 200 ends at `limit` with a cursor.
 *
 * A one-sentence description on every project of the catalogue grows what
 * each caller reads before the page, and the cases pin that it moves no
 * page stop: each page answers the same rows and cursor, and reads the same
 * ranges and documents, with and without it. A search page reaches its stop
 * at ARCHIVE_PAGE.tasks under a lowered budget, since seeding past the
 * budget would raise a second figure. Each case prints the figures
 * ARCHIVE_PAGE's docstring quotes. The app's All projects page
 * (issues.archivedPage) for an organization admin who reads 200 live
 * sub-projects through grants merges them side by side into one page, and
 * is too wide with ARCHIVED_SCOPE.subProjects lowered below them. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { ARCHIVE_PAGE, ARCHIVED_PAGE_ROWS, ARCHIVED_SCOPE } from '../lib/archivedTasks'
import { as, readableLiveSubProjects, uuid } from './helpers.setup'
import {
  type PageOrg,
  type PageOrgSizes,
  pageOrg,
  readArchivedBefore,
  readMcpPage,
  readPage,
  record,
  TEXT,
  TITLES,
} from './pageOrg.setup'
import { withReach } from './projectReach.setup'

/* Archive cursors are sealed with a key derived from BETTER_AUTH_SECRET
 * (lib/archiveCursorSeal.ts), so the app's page with a next cursor needs
 * one. */
const g = globalThis as unknown as { process: { env: Record<string, string | undefined> } }
g.process.env.BETTER_AUTH_SECRET ??= 'archived-scale-test-secret-not-a-deployment-key'

/* The catalogue of activeTaskPagesScale.test.ts at its design size, 200 and
 * 500 live, 300 and 1,000 archived, with withOrg's four, and a member who
 * reads 60 sub-projects, the everyday 3 teams of 20. pageOrg would spread
 * its archived tasks over every sub-project, so plantArchive plants them in
 * the listed families alone. */
const CATALOGUE = {
  tops: 198,
  subs: 498,
  archivedTops: 300,
  archivedSubs: 1000,
  memberSubs: 60,
  tasks: 2500,
  archived: 0,
}

/* The archived tasks of each listed family, more than a page of 200. */
const FAMILY_TASKS = 210

/* An ordinary one-sentence project description, 106 characters. */
const DESCRIPTION =
  'The work covers the bench rig, the sensor board and the field tablets, with a review after each new build.'

/* Task numbers clear of the fixtures' and pageOrg's. */
let num = 2_000_000

/* Archives FAMILY_TASKS tasks spread evenly over `projects`, each with
 * ordinary text and a short comment, their archive times interleaved so a
 * page merges every project. */
async function plantArchive(e: PageOrg, projects: readonly Doc<'projects'>[]): Promise<void> {
  await e.t.run(async (ctx) => {
    for (let k = 0; k < FAMILY_TASKS; k++) {
      const project = projects[k % projects.length] as Doc<'projects'>
      const owner = e.owners[k % e.owners.length] as Doc<'profiles'>
      const minute = (from: string) => new Date(Date.parse(from) + k * 60_000).toISOString()
      const archived_at = minute('2026-03-01T00:00:00.000Z')
      const done_at = minute('2026-02-01T00:00:00.000Z')
      const id = uuid()
      await ctx.db.insert('issues', {
        id,
        org_id: e.org.id,
        project_id: project.id,
        num: num++,
        title: TITLES[k % TITLES.length] as string,
        status: 'done',
        priority: 'medium',
        paused: false,
        assignee_id: owner.id,
        reporter_id: e.user.id,
        created_by: e.user.id,
        done_at,
        archived_at,
        created_at: minute('2025-06-01T00:00:00.000Z'),
        updated_at: archived_at,
      })
      await ctx.db.insert('issue_descriptions', {
        issue_id: id,
        description: TEXT,
        org_id: e.org.id,
        project_id: project.id,
        archived_at,
      })
      await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: id,
        author: owner.id,
        body: 'Done, and the results are in the sheet.',
        created_at: done_at,
      })
    }
  })
}

/* A caller and the project its pages list. */
type Lister = { who: string; caller: Doc<'profiles'>; project: string }

/* An organization of `sizes`, the catalogue by default, with archived tasks
 * in the two families the pages list: the three sub-projects of the first
 * top-level project, which the member and the admin list, the admin through
 * a User grant on it, as admin status gives no access to project work, and
 * FW and PCB under TBED, which the guest reads alone. */
async function archivedOrg(
  sizes: PageOrgSizes = CATALOGUE,
): Promise<{ e: PageOrg; listers: Lister[] }> {
  const e = await pageOrg(sizes)
  const first = e.tops[0] as Doc<'projects'>
  const family = e.subs.filter((sub) => sub.parent_id === first.id)
  expect(family).toHaveLength(3)
  expect(e.readable).toEqual(expect.arrayContaining(family))
  await plantArchive(e, family)
  await plantArchive(e, [e.sub, e.sub2])
  await e.t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: first.id,
      profile_id: e.admin.id,
      level: 'user',
    }),
  )
  const listers = [
    { who: 'a member', caller: e.member, project: first.id },
    { who: 'a guest', caller: e.guest, project: e.meta.id },
    { who: 'an admin', caller: e.admin, project: first.id },
  ]
  return { e, listers }
}

/* Gives every project of the organization DESCRIPTION, all 2,000 of them. */
async function describeProjects(e: PageOrg): Promise<void> {
  const count = await e.t.run(async (ctx) => {
    const projects = await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', e.org.id))
      .collect()
    for (const project of projects) await ctx.db.patch(project._id, { description: DESCRIPTION })
    return projects.length
  })
  expect(count).toBe(2000)
}

type Before = Awaited<ReturnType<typeof readArchivedBefore>>
type Read = Awaited<ReturnType<typeof readPage>>

/* Prints a page's figures and what the page read past `before`. */
function report(name: string, page: Read, before: Before): void {
  record(name, page.figures, 'archived')
  const own = {
    ranges: page.figures.ranges - before.ranges,
    documents: page.figures.documents - before.documents,
    mib: Math.round((page.figures.mib - before.mib) * 100) / 100,
  }
  console.log(`archived page figures, ${name}, the page's own reads:`, JSON.stringify(own))
}

/* What `lister` reads before an archived page and its first REST and MCP
 * pages of 200 rows, each printed with `label`. */
async function firstPages(e: PageOrg, lister: Lister, label: string) {
  const { who, caller, project } = lister
  const before = await readArchivedBefore(e.t, caller)
  console.log(`archived page figures, ${who} before the page${label}:`, JSON.stringify(before))
  const rest = await readPage(e.t, { callerId: caller.id, project, archived: 'true', limit: '200' })
  report(`${who}, REST, 200 rows${label}`, rest, before)
  const mcp = await readMcpPage(e.t, { callerId: caller.id, project, archived: true, limit: 200 })
  report(`${who}, MCP, 200 rows${label}`, mcp, before)
  return { before, rest, mcp }
}

/* A page as the comparisons read it: its task ids in order, its cursor, and
 * what it read in ranges and documents. */
const shape = (page: Read) => ({
  ids: page.page.tasks.map((task) => task.id),
  next_cursor: page.page.next_cursor,
  ranges: page.figures.ranges,
  documents: page.figures.documents,
})

describe('archived pages at the design size', () => {
  const page = { ...ARCHIVE_PAGE }
  const scope = { ...ARCHIVED_SCOPE }
  afterEach(() => {
    Object.assign(ARCHIVE_PAGE, page)
    Object.assign(ARCHIVED_SCOPE, scope)
  })

  it('pages a member, a guest and an admin 200 rows on REST and MCP, alike with a description on every project', async () => {
    const { e, listers } = await archivedOrg()
    const plain: Awaited<ReturnType<typeof firstPages>>[] = []
    for (const lister of listers) plain.push(await firstPages(e, lister, ''))
    for (const { rest, mcp } of plain) {
      for (const got of [rest, mcp]) {
        expect(got.figures.rows).toBe(200)
        expect(got.figures.next).toBe(true)
      }
      // both surfaces answer the same tasks and cursor
      expect(shape(mcp).ids).toEqual(shape(rest).ids)
      expect(mcp.page.next_cursor).toBe(rest.page.next_cursor)
    }
    await describeProjects(e)
    for (const [i, lister] of listers.entries()) {
      const got = await firstPages(e, lister, ', with descriptions')
      const was = plain[i] as Awaited<ReturnType<typeof firstPages>>
      // the descriptions grow what the caller reads before the page in
      // bytes alone
      expect(got.before.ranges).toBe(was.before.ranges)
      expect(got.before.documents).toBe(was.before.documents)
      expect(got.before.mib).toBeGreaterThan(was.before.mib)
      // and move no page stop
      expect(shape(got.rest)).toEqual(shape(was.rest))
      expect(shape(got.mcp)).toEqual(shape(was.mcp))
    }
  })

  it("stops a member's search page at ARCHIVE_PAGE.tasks with the same rows and cursor with a description on every project", async () => {
    const { e, listers } = await archivedOrg()
    const { caller, project } = listers[0] as Lister
    // fewer than the family's 210 tasks, so a search page stops there
    // before its limit and before the family's end
    ARCHIVE_PAGE.tasks = 150
    const search = (term: string) =>
      readPage(e.t, { callerId: caller.id, project, archived: 'true', limit: '200', search: term })
    const pages = async (label: string) => {
      const before = await readArchivedBefore(e.t, caller)
      console.log(
        `archived page figures, a member before a search${label}:`,
        JSON.stringify(before),
      )
      // every eighth title says thermal, and no task says quokka
      const found = await search('thermal')
      report(`a member, a search that stops at 150 tasks${label}`, found, before)
      const none = await search('quokka')
      report(`a member, a search that matches none of 150 tasks${label}`, none, before)
      return { found, none }
    }
    const plain = await pages('')
    expect(plain.found.figures.rows).toBeGreaterThan(0)
    expect(plain.found.figures.rows).toBeLessThan(200)
    expect(plain.none.figures.rows).toBe(0)
    for (const got of [plain.found, plain.none]) expect(got.figures.next).toBe(true)
    await describeProjects(e)
    const described = await pages(', with descriptions')
    // the same rows and cursor, and the same reads in ranges and documents
    for (const key of ['found', 'none'] as const)
      expect(shape(described[key])).toEqual(shape(plain[key]))
  })

  it('pages a member 200 rows on REST and MCP in an organization of 1,000 people', async () => {
    // 993 people beside withOrg's and the member, about 1,000
    const { e, listers } = await archivedOrg({
      tops: 7,
      subs: 20,
      people: 993,
      tasks: 600,
      archived: 0,
    })
    const got = await firstPages(e, listers[0] as Lister, ', 1,000 people')
    for (const page of [got.rest, got.mcp]) {
      expect(page.figures.rows).toBe(200)
      expect(page.figures.next).toBe(true)
    }
  })

  it('pages a member who reads 200 sub-projects 200 rows on REST and MCP', async () => {
    const { e, listers } = await archivedOrg({
      tops: 70,
      subs: 206,
      memberSubs: 200,
      tasks: 1000,
      archived: 0,
    })
    expect(e.readable).toHaveLength(200)
    const got = await firstPages(e, listers[0] as Lister, ', 200 readable sub-projects')
    for (const page of [got.rest, got.mcp]) {
      expect(page.figures.rows).toBe(200)
      expect(page.figures.next).toBe(true)
    }
  })

  it('gives an admin who reads 200 live sub-projects through grants one All projects page in the app, too wide below that bound', async () => {
    // 200 live sub-projects one person can read, the one raised figure, here
    // the admin's through User grants of their own, with the archived tasks
    // in the first family alone
    const e = await pageOrg({ tops: 70, subs: 206, memberSubs: 200, tasks: 1000, archived: 0 })
    expect(e.readable).toHaveLength(200)
    const first = e.tops[0] as Doc<'projects'>
    const family = e.subs.filter((sub) => sub.parent_id === first.id)
    expect(e.readable).toEqual(expect.arrayContaining(family))
    await plantArchive(e, family)
    await e.t.run(async (ctx) => {
      for (const sub of e.readable)
        await ctx.db.insert('project_access', {
          project_id: sub.id,
          profile_id: e.admin.id,
          level: 'user',
        })
    })
    await withReach(e.t)
    expect(await readableLiveSubProjects(e.t, e.admin)).toBe(200)
    const all = () =>
      as(e.t, e.admin).query(api.issues.archivedPage, {
        scope: { org_id: e.org.id, all: true },
      })
    // the 200 projects merge side by side into one page of the family's
    // tasks
    const got = await all()
    expect(got.too_wide).toBeUndefined()
    expect(got.rows).toHaveLength(ARCHIVED_PAGE_ROWS)
    expect(new Set(got.rows.map((row) => row.project_id))).toEqual(
      new Set(family.map((sub) => sub.id)),
    )
    expect(got.next_cursor).not.toBeNull()
    // one project fewer than the admin reads makes it too wide, a partial
    // page never
    ARCHIVED_SCOPE.subProjects = 199
    expect(await all()).toEqual({ rows: [], next_cursor: null, scanned: 0, too_wide: true })
  })
})

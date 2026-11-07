/* REST GET /v1/tasks and MCP list_tasks active pages under Convex's real
 * transaction limits at the design size (lib/activeTaskPage.ts
 * ACTIVE_PAGE), with ordinary text. Each case raises one figure: the
 * catalogue every list reads first, 2,000 projects and sub-projects live
 * and archived, the 30 sub-projects under one project, the 200 sub-projects
 * one person reads, the 1,000 people of the roster, the 5 teams a person
 * belongs to, the 5 teams a project is shared with, or a team's shares on
 * 50 live and 150 archived projects. Each case prints what its page read,
 * the figures ACTIVE_PAGE's docstring quotes.
 *
 * A page's reads follow the projects it merges and the rows it answers,
 * not how many tasks the organization holds, as the case of 1,000 and
 * 10,000 tasks shows, a search that matches nothing included, so these
 * organizations hold a few thousand tasks. One more case pages a search
 * for one task to its end at everyday sizes, under a lowered
 * ACTIVE_PAGE.tasks, raising no figure. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import { plantIssue, plantProject } from './helpers.setup'
import {
  type Figures,
  joinMemberTeams,
  type PageOrg,
  pageOrg,
  readBefore,
  readPage,
  record,
} from './pageOrg.setup'
import { lowered, mcpPages, restPages } from './taskPages.setup'

/* The figures of a page inside Convex's limits on every count. */
const inside = (f: Figures) => {
  expect(f.ranges).toBeLessThan(4096)
  expect(f.documents).toBeLessThan(32_000)
  expect(f.mib).toBeLessThan(16)
}

/* The catalogue every list reads first at its design size, 200 and 500
 * live, 300 and 1,000 archived, with withOrg's four, and a member who reads
 * 60 sub-projects, the everyday 3 teams of 20. */
const CATALOGUE = {
  tops: 198,
  subs: 498,
  archivedTops: 300,
  archivedSubs: 1000,
  memberSubs: 60,
  tasks: 2500,
  archived: 0,
}

describe('active pages at the design size', () => {
  it("pages an admin in the member's teams over a catalogue of 2,000 projects as the member, a search that finds nothing included, and a guest", async () => {
    const e = await pageOrg(CATALOGUE)
    // the admin takes the member's everyday access, 3 teams of 20
    // sub-projects, and admin status adds no project
    await joinMemberTeams(e, e.admin)
    const before = await readBefore(e.t, e.admin.id)
    console.log(
      "active page figures, an admin in the member's teams before the page:",
      JSON.stringify(before),
    )
    const admin = await readPage(e.t, { callerId: e.admin.id, limit: '200' })
    record("an admin in the member's teams, 200 rows", admin.figures)
    expect(admin.figures.rows).toBe(200)
    expect(admin.figures.next).toBe(true)
    // a search that matches nothing reads every text of the 60 sub-projects
    const rare = await readPage(e.t, { callerId: e.admin.id, limit: '200', search: 'quokka' })
    record("an admin in the member's teams, a search that finds nothing", rare.figures)
    expect(rare.figures.rows).toBe(0)
    // the member's pages, task for task
    for (const [page, search] of [
      [admin, undefined],
      [rare, 'quokka'],
    ] as const) {
      const member = await readPage(e.t, { callerId: e.member.id, limit: '200', search })
      expect(page.page.tasks.map((task) => task.id)).toEqual(
        member.page.tasks.map((task) => task.id),
      )
      expect(page.figures.next).toBe(member.figures.next)
    }
    // the guest of withOrg reads TBED alone
    const guest = await readPage(e.t, { callerId: e.guest.id, limit: '200' })
    record('a guest', guest.figures)
    for (const page of [admin, rare, guest]) inside(page.figures)
  })

  it('pages a member of 60 sub-projects over a catalogue of 2,000 projects, with a search and a second page', async () => {
    const e = await pageOrg(CATALOGUE)
    const before = await readBefore(e.t, e.member.id)
    console.log('active page figures, the member before the page:', JSON.stringify(before))
    const member = await readPage(e.t, { callerId: e.member.id, limit: '200' })
    record('a member of 60 sub-projects, 200 rows', member.figures)
    expect(member.figures.rows).toBe(200)
    expect(member.figures.next).toBe(true)
    const searched = await readPage(e.t, { callerId: e.member.id, limit: '200', search: 'thermal' })
    record('a member, a search that finds every eighth task', searched.figures)
    expect(searched.figures.rows).toBeGreaterThan(0)
    for (const page of [member, searched]) inside(page.figures)
    // the member's next page goes on where this one stopped
    const next = await readPage(e.t, {
      callerId: e.member.id,
      limit: '200',
      cursor: member.page.next_cursor ?? undefined,
    })
    record('a member, the second page', next.figures)
    inside(next.figures)
    const first = new Set(member.page.tasks.map((task) => task.id))
    expect(next.page.tasks.some((task) => first.has(task.id))).toBe(false)
  })

  it('pages the family of 30 sub-projects under one project', async () => {
    const e = await pageOrg({ tops: 7, subs: 47, family: 30, tasks: 600, archived: 0 })
    const family = await readPage(e.t, {
      callerId: e.member.id,
      limit: '200',
      project: e.tops[0].key,
    })
    record('a member, a family of 30 sub-projects', family.figures)
    expect(family.figures.rows).toBe(200)
    expect(family.figures.next).toBe(true)
    inside(family.figures)
  })

  it('pages a member who reads 200 sub-projects through three teams, with and without a search', async () => {
    // the first project's 3 sub-projects, 65 projects of 3 and one of 2
    // shared, and 6 sub-projects beside them unread
    const e = await pageOrg({ tops: 70, subs: 206, memberSubs: 200, tasks: 1000, archived: 0 })
    expect(e.readable).toHaveLength(200)
    const before = await readBefore(e.t, e.member.id)
    console.log('active page figures, 200 sub-projects before the page:', JSON.stringify(before))
    const member = await readPage(e.t, { callerId: e.member.id, limit: '200' })
    record('a member of 200 sub-projects, 200 rows', member.figures)
    expect(member.figures.rows).toBe(200)
    expect(member.figures.next).toBe(true)
    const rare = await readPage(e.t, { callerId: e.member.id, limit: '200', search: 'quokka' })
    record('a member of 200 sub-projects, a search that finds nothing', rare.figures)
    expect(rare.figures.rows).toBe(0)
    const searched = await readPage(e.t, { callerId: e.member.id, limit: '200', search: 'thermal' })
    record('a member of 200 sub-projects, a search', searched.figures)
    expect(searched.figures.rows).toBeGreaterThan(0)
    for (const page of [member, rare, searched]) inside(page.figures)
  })

  it('pages the lead of every programme and a member in an organization of 1,000 people', async () => {
    // 993 people beside withOrg's and the member, about 1,000
    const e = await pageOrg({ tops: 7, subs: 20, people: 993, tasks: 600, archived: 0 })
    const before = await readBefore(e.t, e.member.id)
    console.log('active page figures, 1,000 people before the page:', JSON.stringify(before))
    const lead = await readPage(e.t, { callerId: e.user.id, limit: '200' })
    record('the lead, of 1,000 people, 200 rows', lead.figures)
    expect(lead.figures.rows).toBe(200)
    const member = await readPage(e.t, { callerId: e.member.id, limit: '200' })
    record('a member of 1,000 people, 200 rows', member.figures)
    expect(member.figures.rows).toBe(200)
    for (const page of [lead, member]) inside(page.figures)
  })

  it('pages a member in 5 teams', async () => {
    const e = await pageOrg({ tops: 21, subs: 60, teams: 5, tasks: 600, archived: 0 })
    expect(e.readable).toHaveLength(60)
    const before = await readBefore(e.t, e.member.id)
    console.log('active page figures, a member in 5 teams before the page:', JSON.stringify(before))
    const member = await readPage(e.t, { callerId: e.member.id, limit: '200' })
    record('a member in 5 teams, 200 rows', member.figures)
    expect(member.figures.rows).toBe(200)
    inside(member.figures)
  })

  it('pages a member whose projects are each shared with 5 teams', async () => {
    const e = await pageOrg({ tops: 21, subs: 60, projectTeams: 4, tasks: 600, archived: 0 })
    expect(e.readable).toHaveLength(60)
    const before = await readBefore(e.t, e.member.id)
    console.log(
      'active page figures, projects shared with 5 teams before the page:',
      JSON.stringify(before),
    )
    const member = await readPage(e.t, { callerId: e.member.id, limit: '200' })
    record('a member, projects shared with 5 teams, 200 rows', member.figures)
    expect(member.figures.rows).toBe(200)
    inside(member.figures)
  })

  it('pages a member whose team shares 50 live and 150 archived projects', async () => {
    const e = await pageOrg({
      tops: 50,
      subs: 60,
      archivedTops: 150,
      oneTeam: true,
      tasks: 600,
      archived: 0,
    })
    const before = await readBefore(e.t, e.member.id)
    console.log(
      'active page figures, a team of 200 shares before the page:',
      JSON.stringify(before),
    )
    const member = await readPage(e.t, { callerId: e.member.id, limit: '200' })
    record('a member, a team sharing 50 live and 150 archived projects, 200 rows', member.figures)
    expect(member.figures.rows).toBe(200)
    inside(member.figures)
  })

  it('reads the same page in an organization of 1,000 active tasks as in one of 10,000', async () => {
    /* Both hold tasks in every sub-project, so the page opens as many
     * heads. The delays' share is left out of the comparison, since what it
     * reads follows how much open work the page's owners hold, which the two
     * organizations spread over 50 owners differently. */
    const noDelays = { page: { delays: { ranges: 1, documents: 1, bytes: 1 } } }
    // 101 sub-projects, a count coprime with the 5 and 50 that pick Done
    // tasks and groups, so both spread over every sub-project
    const sizes = { tops: 33, subs: 101, people: 100 }
    const small = await pageOrg({ ...sizes, tasks: 1000, archived: 0 })
    const s = await lowered(noDelays, () =>
      readPage(small.t, { callerId: small.member.id, limit: '50' }),
    )
    const sBefore = await readBefore(small.t, small.member.id)
    const large = await pageOrg({ ...sizes, tasks: 10_000, archived: 5000 })
    const l = await lowered(noDelays, () =>
      readPage(large.t, { callerId: large.member.id, limit: '50' }),
    )
    const lBefore = await readBefore(large.t, large.member.id)
    record('50 rows of 1,000 tasks, no delays', s.figures)
    record('50 rows of 10,000 tasks and 5,000 archived, no delays', l.figures)
    // both organizations plant their oldest tasks alike, the head of each
    // sub-project the page opens and its 50 rows, the first task's group of
    // five among them, so the page's own reads match exactly
    expect(l.figures.ranges - lBefore.ranges).toBe(s.figures.ranges - sBefore.ranges)
    expect(l.figures.documents - lBefore.documents).toBe(s.figures.documents - sBefore.documents)
    // a search that matches nothing reads the text of every task it looks
    // at, here 300 a page, and reads the same in both
    const look = { page: { ...noDelays.page, tasks: 300 } }
    const rare = (o: PageOrg) =>
      lowered(look, () => readPage(o.t, { callerId: o.member.id, limit: '50', search: 'quokka' }))
    const sRare = await rare(small)
    const lRare = await rare(large)
    record('a search no task matches, 300 tasks looked at, of 1,000 tasks', sRare.figures)
    record(
      'a search no task matches, 300 tasks looked at, of 10,000 tasks and 5,000 archived',
      lRare.figures,
    )
    for (const p of [sRare, lRare]) {
      expect(p.figures.rows).toBe(0)
      expect(p.figures.next).toBe(true)
    }
    // it answers no rows, and both organizations plant the 300 oldest tasks
    // it looks at alike, so the page's own reads match exactly
    expect(lRare.figures.ranges - lBefore.ranges).toBe(sRare.figures.ranges - sBefore.ranges)
    expect(lRare.figures.documents - lBefore.documents).toBe(
      sRare.figures.documents - sBefore.documents,
    )
  })

  it('pages the lead of every programme past the oldest active tasks of an archived sub-project to the end, reading none of them', async () => {
    const e = await pageOrg({ tops: 7, subs: 20, people: 20, tasks: 600, archived: 0 })
    const page = () => readPage(e.t, { callerId: e.user.id, limit: '200' })
    const without = await page()
    // 300 open tasks, older than every other, that a sub-project archived
    // since keeps active
    const shelf = await plantProject(e.t, {
      org_id: e.org.id,
      type: 'project',
      parent_id: e.tops[0].id,
      archived_at: '2026-01-01T00:00:00.000Z',
    })
    for (let i = 0; i < 300; i++)
      await plantIssue(e.t, {
        org_id: e.org.id,
        project_id: shelf.id,
        title: `Old ${i}`,
        status: 'progress',
        created_at: new Date(Date.parse('2024-01-01T00:00:00.000Z') + i * 60_000).toISOString(),
      })
    const withShelf = await page()
    record('the lead, an archived sub-project holding the oldest 300', withShelf.figures)
    // the page reads the shelf's project row and none of its tasks
    expect(withShelf.figures.documents - without.figures.documents).toBeLessThan(5)
    expect(withShelf.page.tasks.map((task) => task.id)).toEqual(
      without.page.tasks.map((task) => task.id),
    )
    let cursor: string | undefined
    let pages = 0
    const seen: string[] = []
    do {
      const got = await readPage(e.t, { callerId: e.user.id, limit: '200', cursor })
      seen.push(...got.page.tasks.map((task) => task.id))
      cursor = got.page.next_cursor ?? undefined
      pages++
      expect(pages).toBeLessThan(50)
    } while (cursor !== undefined)
    // every active task of a live project, groups' subtasks included
    expect(seen.length).toBe(600 + 12 * 5)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('reads the delays of several owners of ordinary loads within the share on a staff page', async () => {
    // 25 owners of about 100 open tasks each, in four sub-projects each
    const e = await pageOrg({
      tops: 33,
      subs: 100,
      people: 100,
      tasks: 2500,
      archived: 0,
      owners: 25,
    })
    const lead = await readPage(e.t, { callerId: e.user.id, limit: '200' })
    record('the lead, 200 rows, owners of about 100 tasks', lead.figures)
    inside(lead.figures)
    const delays = lead.page.tasks.map((task) => (task.delay as { status: string } | null)?.status)
    const judged = delays.filter((status) => status !== undefined && status !== 'unavailable')
    const unavailable = delays.filter((status) => status === 'unavailable')
    console.log(
      'active page figures, delays on that page:',
      JSON.stringify({ judged: judged.length, unavailable: unavailable.length }),
    )
    // several owners fit the share, and the rest say unavailable
    expect(judged.length).toBeGreaterThan(20)
    expect(unavailable.length).toBeGreaterThan(0)
  })
})

/* The member's last active task in list order, created_at then number, and
 * how many active tasks they read. */
async function lastInOrder(e: PageOrg) {
  const readable = new Set(e.readable.map((p) => p.id))
  const tasks = await e.t.run((ctx) =>
    ctx.db
      .query('issues')
      .withIndex('by_org_archived', (q) => q.eq('org_id', e.org.id).eq('archived_at', undefined))
      .collect(),
  )
  const mine = tasks
    .filter((task) => readable.has(task.project_id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.num - b.num)
  return { last: mine[mine.length - 1] as Doc<'issues'>, count: mine.length }
}

describe('a rare search past one page', () => {
  it("pages a search for the last task's key across every project to its end, each page before it empty with a cursor, on REST and MCP", async () => {
    // everyday sizes, 660 active tasks over 20 sub-projects, groups whose
    // subtasks share their parent's created_at; a page that looks at 150
    // tasks stops there, as a real one stops at its budget
    const e = await pageOrg({ tops: 7, subs: 20, people: 20, tasks: 600, archived: 0 })
    const { last, count } = await lastInOrder(e)
    expect(count).toBe(600 + 12 * 5)
    const look = 150
    const pages = Math.ceil(count / look)
    const who = { callerId: e.member.id, access: 'read' as const, search: `QN-${last.num}` }
    await lowered({ page: { tasks: look } }, async () => {
      const rest = await restPages(e.t, { ...who, limit: '50' })
      const mcp = await mcpPages(e.t, { ...who, limit: 50 })
      for (const got of [rest, mcp]) {
        expect(got.sizes).toEqual([...Array<number>(pages - 1).fill(0), 1])
        expect(got.cursors).toHaveLength(pages - 1)
        expect(got.rows.map((row) => row.id)).toEqual([last.id])
      }
    })
  })
})

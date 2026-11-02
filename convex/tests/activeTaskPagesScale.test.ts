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
 * 10,000 tasks shows, so these organizations hold a few thousand tasks. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { plantIssue, plantProject } from './helpers.setup'
import { type Figures, pageOrg, readBefore, readPage, record } from './pageOrg.setup'
import { lowered } from './taskPages.setup'

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
  it('pages an admin over a catalogue of 2,000 projects to the budget, a search that finds nothing included, and a guest', async () => {
    const e = await pageOrg(CATALOGUE)
    const before = await readBefore(e.t, e.admin.id)
    console.log('active page figures, an admin before the page:', JSON.stringify(before))
    const admin = await readPage(e.t, { callerId: e.admin.id, limit: '200' })
    record('an admin over 700 live projects, 200 rows', admin.figures)
    expect(admin.figures.rows).toBe(200)
    expect(admin.figures.next).toBe(true)
    // a search that matches nothing reads every text it passes, so it ends
    // at the page's budget with a cursor
    const rare = await readPage(e.t, { callerId: e.admin.id, limit: '200', search: 'quokka' })
    record('an admin, a search that finds nothing', rare.figures)
    expect(rare.figures.rows).toBe(0)
    expect(rare.figures.next).toBe(true)
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

  it('pages an admin and a member in an organization of 1,000 people', async () => {
    // 993 people beside withOrg's and the member, about 1,000
    const e = await pageOrg({ tops: 7, subs: 20, people: 993, tasks: 600, archived: 0 })
    const before = await readBefore(e.t, e.member.id)
    console.log('active page figures, 1,000 people before the page:', JSON.stringify(before))
    const admin = await readPage(e.t, { callerId: e.admin.id, limit: '200' })
    record('an admin of 1,000 people, 200 rows', admin.figures)
    expect(admin.figures.rows).toBe(200)
    const member = await readPage(e.t, { callerId: e.member.id, limit: '200' })
    record('a member of 1,000 people, 200 rows', member.figures)
    expect(member.figures.rows).toBe(200)
    for (const page of [admin, member]) inside(page.figures)
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
    // the page itself reads the same ranges and documents, give or take the
    // groups among its rows
    expect(
      Math.abs(l.figures.ranges - lBefore.ranges - (s.figures.ranges - sBefore.ranges)),
    ).toBeLessThan(30)
    expect(
      Math.abs(l.figures.documents - lBefore.documents - (s.figures.documents - sBefore.documents)),
    ).toBeLessThan(150)
  })

  it('pages an admin past the oldest active tasks of an archived sub-project to the end, reading none of them', async () => {
    const e = await pageOrg({ tops: 7, subs: 20, people: 20, tasks: 600, archived: 0 })
    const page = () => readPage(e.t, { callerId: e.admin.id, limit: '200' })
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
    record('an admin, an archived sub-project holding the oldest 300', withShelf.figures)
    // the page reads the shelf's project row and none of its tasks
    expect(withShelf.figures.documents - without.figures.documents).toBeLessThan(5)
    expect(withShelf.page.tasks.map((task) => task.id)).toEqual(
      without.page.tasks.map((task) => task.id),
    )
    let cursor: string | undefined
    let pages = 0
    const seen: string[] = []
    do {
      const got = await readPage(e.t, { callerId: e.admin.id, limit: '200', cursor })
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
    const admin = await readPage(e.t, { callerId: e.admin.id, limit: '200' })
    record('an admin, 200 rows, owners of about 100 tasks', admin.figures)
    inside(admin.figures)
    const delays = admin.page.tasks.map((task) => (task.delay as { status: string } | null)?.status)
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

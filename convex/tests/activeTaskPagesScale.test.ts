/* REST GET /v1/tasks and MCP list_tasks active pages under Convex's real
 * transaction limits at the breadth of the testing envelope
 * (lib/activeTaskPage.ts ACTIVE_PAGE): 2,000 projects, 1,000 people and a
 * member in 25 teams who reads every sub-project, with names, project
 * descriptions, titles and texts in a three-byte script at the caps, the
 * largest bytes a page reads before and inside it. Each case prints what
 * its page read.
 *
 * A page's reads follow the projects it merges and the rows it answers,
 * not how many tasks the organization holds, as the second case shows, so
 * these organizations hold a few thousand tasks. In convex-test every
 * indexed query scans its whole table, which makes a page over the
 * envelope's 50,000 tasks take minutes; convex/tests/activeTaskPages.envelope.ts
 * measures that size on demand, the figures ACTIVE_PAGE's docstring
 * quotes. Neither builds what a page never reads quickly enough to matter
 * here: the project_reach rows (taskEnvelope.setup.ts `reach`). */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { envelope, readBefore, readPage, record } from './taskEnvelope.setup'
import { lowered } from './taskPages.setup'

/* The figures of a page inside Convex's limits on every count. */
const inside = (f: { ranges: number; documents: number; mib: number }) => {
  expect(f.ranges).toBeLessThan(4096)
  expect(f.documents).toBeLessThan(32_000)
  expect(f.mib).toBeLessThan(16)
}

describe('active pages at the breadth of the testing envelope', () => {
  it('pages for an admin, a member of 2,000 projects with and without a search, a family and a guest at the caps', async () => {
    const e = await envelope({ tasks: 2500, archived: 1000, three: true, reach: false })
    const before = await readBefore(e.t, e.member.id)
    console.log('active page figures, the member before the page:', JSON.stringify(before))
    // the room check before the page holds at the caps
    expect(before.mib).toBeGreaterThan(6)
    const member = await readPage(e.t, { callerId: e.member.id, limit: '200' })
    record('a member of 2,000 projects, 200 rows', member.figures)
    expect(member.figures.rows).toBe(200)
    expect(member.figures.next).toBe(true)
    const admin = await readPage(e.t, { callerId: e.admin.id, limit: '200' })
    record('an admin, 200 rows', admin.figures)
    expect(admin.figures.rows).toBe(200)
    // a search that matches nothing ends at the page's budget with a cursor
    const rare = await readPage(e.t, { callerId: e.member.id, limit: '200', search: 'クオッカ' })
    record('a member, a search that finds nothing', rare.figures)
    expect(rare.figures.rows).toBe(0)
    expect(rare.figures.next).toBe(true)
    const searched = await readPage(e.t, { callerId: e.member.id, limit: '200', search: '計' })
    record('a member, a search that finds every task', searched.figures)
    expect(searched.figures.rows).toBeGreaterThan(0)
    const family = await readPage(e.t, {
      callerId: e.member.id,
      limit: '200',
      project: e.tops[0].key,
    })
    record('a member, a family of 199 sub-projects', family.figures)
    expect(family.figures.rows).toBeGreaterThan(0)
    // the guest of withOrg reads TBED alone
    const guest = await readPage(e.t, { callerId: e.guest.id, limit: '200' })
    record('a guest', guest.figures)
    for (const page of [member, admin, rare, searched, family, guest]) inside(page.figures)
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
  }, 600_000)

  it('reads the same page in an organization of 1,000 active tasks as in one of 10,000', async () => {
    /* Both hold tasks in every sub-project, so the page opens as many
     * heads. The delays' share is left out of the comparison, since what it
     * reads follows how much open work the page's owners hold, which the two
     * organizations spread over 50 owners differently. */
    const noDelays = { page: { delays: { ranges: 1, documents: 1, bytes: 1 } } }
    const sizes = { subs: 100, people: 100, reach: false }
    const small = await envelope({ ...sizes, tasks: 1000, archived: 0 })
    const s = await lowered(noDelays, () =>
      readPage(small.t, { callerId: small.member.id, limit: '50' }),
    )
    const sBefore = await readBefore(small.t, small.member.id)
    const large = await envelope({ ...sizes, tasks: 10_000, archived: 5000 })
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
  }, 600_000)

  it('pages an admin past the oldest active tasks of archived projects to the end, reading none of them', async () => {
    // 600 live tasks behind 5,000 older ones that an archived project keeps
    const e = await envelope({
      subs: 20,
      people: 20,
      tasks: 600,
      archived: 0,
      oldInArchived: 5000,
      reach: false,
    })
    let cursor: string | undefined
    let pages = 0
    const seen: string[] = []
    do {
      const got = await readPage(e.t, { callerId: e.admin.id, limit: '200', cursor })
      if (pages === 0) record('an admin, an archived project holding the oldest 5,000', got.figures)
      // no page reads the archived project's tasks
      expect(got.figures.documents).toBeLessThan(5000)
      seen.push(...got.page.tasks.map((task) => task.id))
      cursor = got.page.next_cursor ?? undefined
      pages++
      expect(pages).toBeLessThan(50)
    } while (cursor !== undefined)
    // every active task of a live project, groups' subtasks included
    expect(seen.length).toBe(600 + 12 * 5)
    expect(new Set(seen).size).toBe(seen.length)
  }, 600_000)

  it('reads the delays of several owners of ordinary loads within the share on a staff page', async () => {
    // 25 owners of about 100 open tasks each, in four sub-projects each
    const e = await envelope({
      subs: 100,
      people: 100,
      tasks: 2500,
      archived: 0,
      owners: 25,
      reach: false,
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
  }, 600_000)
})

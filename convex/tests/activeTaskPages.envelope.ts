/* REST GET /v1/tasks and MCP list_tasks active pages at the full testing
 * envelope (lib/activeTaskPage.ts ACTIVE_PAGE), measured on demand: an
 * organization of 2,000 projects, 1,000 people, 25 teams and 50,000 active
 * tasks with archived ones beside them and the reach rows every deployment
 * holds, read under Convex's real transaction limits. Each case prints what
 * its page read, the figures ACTIVE_PAGE's docstring quotes.
 *
 * It is not part of `npm test`: in convex-test every indexed query scans its
 * whole table, so a page over 50,000 tasks takes about two minutes and each
 * organization about five more to build, an hour for the file on a large
 * Boat sandbox. convex/tests/activeTaskPagesScale.test.ts runs the same
 * stops in every run at the envelope's projects, teams and people with
 * fewer tasks, and shows that a page reads the same however many tasks the
 * organization holds. Run this file after a change to ACTIVE_PAGE, its
 * reads or the owner reader, on a Boat sandbox (qivo-internal
 * scripts/boat-run), and copy its figures into ACTIVE_PAGE's docstring:
 *
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/boat-run" test CHECKOUT -- \
 *     npx vitest run --config vitest.envelope.config.mts
 *
 * Named *.envelope.ts, two dots, so the Convex CLI skips it, and outside the
 * `*.test.ts` files vitest.config.mts runs. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { envelope, readBefore, readPage, record } from './taskEnvelope.setup'
import { lowered } from './taskPages.setup'

describe('active pages at the testing envelope', () => {
  it('pages for an admin, a member of 2,000 projects with and without a search, a family and a guest, inside Convex limits', async () => {
    const e = await envelope({ tasks: 50_000, archived: 5000 })
    const before = await readBefore(e.t, e.member.id)
    console.log('active page figures, the member before the page:', JSON.stringify(before))
    const admin = await readPage(e.t, { callerId: e.admin.id, limit: '200' })
    record('an admin, 200 rows', admin.figures)
    expect(admin.figures.rows).toBeGreaterThan(0)
    expect(admin.figures.next).toBe(true)
    const member = await readPage(e.t, { callerId: e.member.id, limit: '200' })
    record('a member of 2,000 projects, 200 rows', member.figures)
    expect(member.figures.rows).toBeGreaterThan(0)
    const searched = await readPage(e.t, { callerId: e.member.id, limit: '200', search: 'thermal' })
    record('a member of 2,000 projects, a search', searched.figures)
    expect(searched.figures.rows + (searched.figures.next ? 1 : 0)).toBeGreaterThan(0)
    const rare = await readPage(e.t, { callerId: e.member.id, limit: '200', search: 'quokka' })
    record('a member of 2,000 projects, a search that finds nothing', rare.figures)
    expect(rare.figures.rows).toBe(0)
    const family = await readPage(e.t, {
      callerId: e.member.id,
      limit: '200',
      project: e.tops[0].key,
    })
    record('a member, a family of 199 sub-projects', family.figures)
    // the guest of withOrg reads TBED alone
    const guest = await readPage(e.t, { callerId: e.guest.id, limit: '200' })
    record('a guest', guest.figures)
    for (const f of [admin, member, searched, rare, family, guest].map((p) => p.figures)) {
      expect(f.ranges).toBeLessThan(4096)
      expect(f.documents).toBeLessThan(32_000)
      expect(f.mib).toBeLessThan(16)
    }
    // the member's next page goes on where this one stopped
    const next = await readPage(e.t, {
      callerId: e.member.id,
      limit: '200',
      cursor: member.page.next_cursor ?? undefined,
    })
    record('a member of 2,000 projects, the second page', next.figures)
    const first = new Set(member.page.tasks.map((task) => task.id))
    expect(next.page.tasks.some((task) => first.has(task.id))).toBe(false)
  }, 1_800_000)

  it('reads the same page in an organization of 2,000 active tasks as in one of 50,000', async () => {
    /* Both hold tasks in every sub-project, so the page opens as many
     * heads. The delays' share is left out of the comparison, since what it
     * reads follows how much open work the page's owners hold, which the two
     * organizations spread over 50 owners differently. */
    const noDelays = { page: { delays: { ranges: 1, documents: 1, bytes: 1 } } }
    const small = await envelope({ tasks: 2000, archived: 0 })
    const s = await lowered(noDelays, () =>
      readPage(small.t, { callerId: small.member.id, limit: '50' }),
    )
    const sBefore = await readBefore(small.t, small.member.id)
    const large = await envelope({ tasks: 50_000, archived: 5000 })
    const l = await lowered(noDelays, () =>
      readPage(large.t, { callerId: large.member.id, limit: '50' }),
    )
    const lBefore = await readBefore(large.t, large.member.id)
    record('50 rows of 2,000 tasks, no delays', s.figures)
    record('50 rows of 50,000 tasks and 5,000 archived, no delays', l.figures)
    // the page itself reads the same ranges and documents, give or take the
    // groups among its rows
    expect(
      Math.abs(l.figures.ranges - lBefore.ranges - (s.figures.ranges - sBefore.ranges)),
    ).toBeLessThan(30)
    expect(
      Math.abs(l.figures.documents - lBefore.documents - (s.figures.documents - sBefore.documents)),
    ).toBeLessThan(150)
  }, 1_800_000)

  it('pages an admin past the oldest active tasks of archived projects to the end, never ending falsely', async () => {
    // 1,000 live tasks behind 20,000 older ones that archived projects keep
    const e = await envelope({ tasks: 1000, archived: 0, oldInArchived: 20_000 })
    let cursor: string | undefined
    let pages = 0
    const seen: string[] = []
    do {
      const got = await readPage(e.t, { callerId: e.admin.id, limit: '200', cursor })
      if (pages === 0) record('an admin, archived projects holding the oldest 20,000', got.figures)
      seen.push(...got.page.tasks.map((task) => task.id))
      cursor = got.page.next_cursor ?? undefined
      pages++
      expect(pages).toBeLessThan(200)
    } while (cursor !== undefined)
    // every active task of a live project, groups' subtasks included
    expect(seen.length).toBe(1000 + 20 * 5)
    expect(new Set(seen).size).toBe(seen.length)
  }, 3_600_000)

  it('reads the delays of several owners of ordinary loads within the share on a staff page', async () => {
    // 500 owners of about 100 open tasks each, in four sub-projects each
    const e = await envelope({ tasks: 50_000, archived: 0, owners: 500 })
    const admin = await readPage(e.t, { callerId: e.admin.id, limit: '200' })
    record('an admin, 200 rows, owners of about 100 tasks', admin.figures)
    const delays = admin.page.tasks.map((task) => (task.delay as { status: string } | null)?.status)
    const judged = delays.filter((status) => status !== undefined && status !== 'unavailable')
    console.log(
      'active page figures, delays on that page:',
      JSON.stringify({ judged: judged.length, unavailable: delays.length - judged.length }),
    )
    expect(judged.length).toBeGreaterThan(1)
    expect(admin.figures.ranges).toBeLessThan(4096)
    expect(admin.figures.mib).toBeLessThan(16)
  }, 1_800_000)

  it('reads cap-length titles and names in a three-byte script inside Convex limits', async () => {
    const e = await envelope({ tasks: 50_000, archived: 0, three: true })
    const before = await readBefore(e.t, e.member.id)
    console.log(
      'active page figures, the member before the page, three-byte names:',
      JSON.stringify(before),
    )
    const member = await readPage(e.t, { callerId: e.member.id, limit: '200' })
    record('a member of 2,000 projects, three-byte names and titles', member.figures)
    expect(member.figures.rows).toBeGreaterThan(0)
    expect(member.figures.mib).toBeLessThan(16)
    const searched = await readPage(e.t, {
      callerId: e.member.id,
      limit: '200',
      search: 'クオッカ',
    })
    record('a member, three-byte names, a search that finds nothing', searched.figures)
    expect(searched.figures.mib).toBeLessThan(16)
  }, 1_800_000)
})

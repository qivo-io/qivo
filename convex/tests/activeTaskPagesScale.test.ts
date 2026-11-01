/* REST GET /v1/tasks and MCP list_tasks active pages at the testing
 * envelope (lib/activeTaskPage.ts ACTIVE_PAGE): an organization of 2,000
 * projects, 1,000 people and 50,000 active tasks with archived ones beside
 * them, read under Convex's real transaction limits. Each case prints what
 * its page read, for the report and ACTIVE_PAGE's docstring. Long: run it
 * on a Boat sandbox (scripts/boat-run in qivo-internal). */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { newWindowKey } from '../lib/db'
import { LIMITS, MIB, NAME_MAX } from '../lib/limits'
import { named, nameKey } from '../lib/nameKey'
import { listIssues, listProjects } from '../machine/rest'
import {
  NOW,
  newT,
  type OrgFixture,
  plantProject,
  plantSeat,
  type T,
  TODAY,
  uuid,
  withOrg,
} from './helpers.setup'
import { withReach } from './projectReach.setup'
import { lowered } from './taskPages.setup'

/* What one page read, as Convex counts it, and what it answered. */
type Figures = {
  ranges: number
  documents: number
  mib: number
  rows: number
  answer_kb: number
  next: boolean
}

const FIGURES: Record<string, Figures> = {}
const record = (name: string, figures: Figures) => {
  FIGURES[name] = figures
  console.log(`active page figures, ${name}:`, JSON.stringify(figures))
}

/* A query's handler, run inside a test's own transaction so its metrics
 * can be read after it. */
const handlerOf = <Args, Out>(fn: unknown) =>
  (fn as { _handler: (ctx: QueryCtx, args: Args) => Promise<Out> })._handler

type RestArgs = {
  callerId: string
  access: 'read'
  today: string
  project?: string
  search?: string
  limit?: string
  cursor?: string
  status?: string
}
type RestPage = { next_cursor: string | null; tasks: { id: string; delay: unknown }[] }

/* One REST page read in a query of its own, with what it read before its rows (the
 * caller, the catalogue and the access rows) and in all. */
async function readPage(t: T, args: Omit<RestArgs, 'today' | 'access'>) {
  return await t.query(async (ctx) => {
    const page = await handlerOf<RestArgs, RestPage>(listIssues)(ctx, {
      today: TODAY,
      access: 'read',
      ...args,
    })
    const m = await ctx.meta.getTransactionMetrics()
    const figures: Figures = {
      ranges: m.databaseQueries.used,
      documents: m.documentsRead.used,
      mib: Math.round((m.bytesRead.used / MIB) * 100) / 100,
      rows: page.tasks.length,
      answer_kb: Math.round(JSON.stringify(page).length / 1024),
      next: page.next_cursor !== null,
    }
    return { page, figures }
  })
}

/* The reads before a page: the caller, the catalogue and their access, as
 * REST GET /v1/projects reads them, which reads nothing else of size. */
async function readBefore(t: T, callerId: string) {
  return await t.query(async (ctx) => {
    await handlerOf<{ callerId: string; access: 'read' }, unknown[]>(listProjects)(ctx, {
      callerId,
      access: 'read',
    })
    const m = await ctx.meta.getTransactionMetrics()
    return {
      ranges: m.databaseQueries.used,
      documents: m.documentsRead.used,
      mib: Math.round((m.bytesRead.used / MIB) * 100) / 100,
    }
  })
}

/* Real titles and texts. */
const TITLES = [
  'Replace the fan controller on the bench rig',
  'Write up the thermal test results for review',
  'Fix the login timeout on the field tablets',
  'Order spare connectors for the next build',
  'Update the assembly guide with the new jig',
  'Check the power budget of the sensor board',
  'Plan the firmware release for the pilot sites',
  'Answer the customer question on the export format',
]
const TEXT =
  'The readings drift slowly through the morning, so we log them every ten minutes and compare them with the previous build. ' +
  'Once the cause is clear, write the change into the assembly guide and ask the test team to repeat the run on two boards. ' +
  'Keep the old values in the sheet so the difference stays easy to see.'
const JP_TITLE = '計'.repeat(LIMITS.title.max)
const JP_NAME = (i: number) => String.fromCodePoint(0x4e00 + i) + '班'.repeat(NAME_MAX - 1)

/* Task numbers clear of the fixtures'. */
let num = 1_000_000

type Envelope = OrgFixture & {
  t: T
  member: Doc<'profiles'>
  owners: Doc<'profiles'>[]
  tops: Doc<'projects'>[]
  subs: Doc<'projects'>[]
}

/**
 * The envelope's organization: 10 top-level projects and their
 * sub-projects, 2,000 projects in all with withOrg's, 25 teams that each
 * share 200 sub-projects, so `member`, in all 25, reads every sub-project,
 * 1,000 people, and `tasks` active tasks spread over the sub-projects, a
 * tenth of them groups of five subtasks stored before the rule of one
 * level, planned and owned by 50 people in projects that track delay, and
 * `archived` archived tasks beside them. `three` writes the names, the
 * titles and the texts in a three-byte script at the caps.
 */
async function envelope(
  o: {
    tasks: number
    archived: number
    three?: boolean
    oldInArchived?: number
    owners?: number
  } = {
    tasks: 50_000,
    archived: 5000,
  },
): Promise<Envelope> {
  const t = newT({ transactionLimits: true })
  const f = await withOrg(t)
  const tops: Doc<'projects'>[] = []
  for (let i = 0; i < 10; i++)
    tops.push(
      await plantProject(t, {
        org_id: f.org.id,
        lead_id: f.user.id,
        ...named(o.three ? JP_NAME(i) : `Programme ${i}`),
        description: o.three ? '計'.repeat(LIMITS.projectDescription.max) : 'A programme of work.',
        track_delay: true,
        archive_state: 'live',
      }),
    )
  const subs: Doc<'projects'>[] = []
  await t.run(async (ctx) => {
    for (let i = 0; i < 1986; i++) {
      const top = tops[Math.floor(i / 199)] as Doc<'projects'>
      const id = uuid()
      const name = o.three ? JP_NAME(100 + i) : `Workstream ${i}`
      const _id = await ctx.db.insert('projects', {
        id,
        org_id: f.org.id,
        type: 'project',
        parent_id: top.id,
        key: `W${i}`,
        num: 10_000 + i,
        sort_order: 10_000 + i,
        ...named(name),
        description: o.three ? '計'.repeat(LIMITS.projectDescription.max) : '',
        lead_id: f.user.id,
        track_delay: true,
        archive_state: 'live',
        created_at: NOW,
        window_key: newWindowKey(),
      })
      subs.push((await ctx.db.get(_id)) as Doc<'projects'>)
    }
  })
  const member = await plantSeat(t, {
    org_id: f.org.id,
    name: o.three ? JP_NAME(9000) : 'Member',
    auth_user_id: `auth_${uuid()}`,
    accepted_at: NOW,
  })
  await t.run(async (ctx) => {
    for (let i = 0; i < 25; i++) {
      const team = uuid()
      const name = o.three ? JP_NAME(5000 + i) : `Team ${i}`
      await ctx.db.insert('teams', {
        id: team,
        org_id: f.org.id,
        ...named(name),
        track_delay_default: true,
        created_at: NOW,
      })
      await ctx.db.insert('team_members', {
        team_id: team,
        profile_id: member.id,
        is_leader: false,
        name_key: nameKey(member.name),
      })
      for (let k = 0; k < 200; k++) {
        const sub = subs[(80 * i + k) % subs.length] as Doc<'projects'>
        await ctx.db.insert('project_team_access', {
          project_id: sub.id,
          team_id: team,
          level: 'user',
          name_key: nameKey(name),
        })
      }
    }
  })
  // 1,000 people in all, 50 of them owning the tasks
  const owners: Doc<'profiles'>[] = []
  await t.run(async (ctx) => {
    for (let i = 0; i < 993; i++) {
      const _id = await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: f.org.id,
        name: o.three ? JP_NAME(2000 + i) : `Person ${i}`,
        initials: 'PP',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        plannable_hours: 40,
        created_at: NOW,
      })
      if (i < (o.owners ?? 50)) owners.push((await ctx.db.get(_id)) as Doc<'profiles'>)
    }
  })
  // the tasks, oldest first, in batches; the oldest `oldInArchived` in
  // projects archived since
  const shelf = o.oldInArchived
    ? await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: tops[0].id,
        archived_at: NOW,
      })
    : null
  const planted = o.tasks + (o.oldInArchived ?? 0)
  for (let from = 0; from < planted; from += 1000) {
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(planted, from + 1000); i++) {
        const old = shelf !== null && i < (o.oldInArchived ?? 0)
        const sub = old ? shelf : (subs[i % subs.length] as Doc<'projects'>)
        const id = uuid()
        // with `owners` given, each owns the tasks of a few sub-projects
        const owner = owners[
          o.owners === undefined ? i % owners.length : (i % subs.length) % owners.length
        ] as Doc<'profiles'>
        const week = `2026-0${1 + (i % 9)}-05`
        const doc = {
          id,
          org_id: f.org.id,
          project_id: sub.id,
          num: num++,
          title: o.three ? JP_TITLE : (TITLES[i % TITLES.length] as string),
          status: i % 5 === 0 ? ('done' as const) : ('progress' as const),
          priority: 'medium' as const,
          paused: false,
          assignee_id: owner.id,
          reporter_id: f.user.id,
          created_by: f.user.id,
          start_week: week,
          end_week: week,
          remaining_hours: 6,
          remaining_set_at: NOW,
          due_date: '2026-06-30',
          created_at: new Date(Date.parse('2025-01-01T00:00:00.000Z') + i * 60_000).toISOString(),
          updated_at: NOW,
          status_at: NOW,
          window_key: newWindowKey(),
        }
        await ctx.db.insert('issues', doc)
        await ctx.db.insert('issue_descriptions', {
          issue_id: id,
          description: o.three ? '計'.repeat(390) : TEXT,
          org_id: f.org.id,
          project_id: sub.id,
        })
        // a tenth of the tasks are groups of five subtasks in their project
        if (i % 50 === 0) {
          for (let k = 0; k < 5; k++) {
            const kid = uuid()
            await ctx.db.insert('issues', {
              ...doc,
              id: kid,
              num: num++,
              parent_id: id,
              window_key: newWindowKey(),
            })
            await ctx.db.insert('issue_descriptions', {
              issue_id: kid,
              description: '',
              org_id: f.org.id,
              project_id: sub.id,
            })
          }
        }
      }
    })
  }
  for (let from = 0; from < o.archived; from += 1000) {
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(o.archived, from + 1000); i++) {
        const sub = subs[i % subs.length] as Doc<'projects'>
        await ctx.db.insert('issues', {
          id: uuid(),
          org_id: f.org.id,
          project_id: sub.id,
          num: num++,
          title: TITLES[i % TITLES.length] as string,
          status: 'done',
          priority: 'medium',
          paused: false,
          archived_at: NOW,
          created_at: '2024-06-01T00:00:00.000Z',
          updated_at: NOW,
        })
      }
    })
  }
  await withReach(t)
  return { t, ...f, member, owners, tops, subs }
}

describe('active pages at the testing envelope', () => {
  it('pages for an admin, a member of 2,000 projects with and without a search, a family and a guest, inside Convex limits', async () => {
    const e = await envelope()
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

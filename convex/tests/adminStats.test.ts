/* The operator console's organization table and platform totals
 * (adminStats.ts): both actions refuse every caller but an operator, and a
 * demo deployment; the numbers on a small fixture, written out; the same
 * numbers at the smallest page sizes; an organization or a team too large
 * for the old single query; weekly buckets across page boundaries; page
 * arguments that stay the same within an hour; and an organization deleted
 * while a load runs. */
/// <reference types="vite/client" />

import { type FunctionReference, getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { ActionCtx } from '../_generated/server'
import * as statsModule from '../adminStats'
import { orgRows, platformTotals, STATS_PAGE } from '../adminStats'
import { byId } from '../lib/db'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { comment, deleteTask } from './trash.setup'

const DEFAULT_PAGE = { ...STATS_PAGE }
/* A Wednesday, so the weekly buckets below start on known Mondays. */
const FIXED = Date.parse('2026-05-06T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED)
})
afterEach(() => {
  Object.assign(STATS_PAGE, DEFAULT_PAGE)
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

/** A platform operator: a Better Auth user with a platform_admins row. */
async function operator(t: T) {
  const now = Date.now()
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: {
        name: 'operator',
        email: 'operator@platform.test',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  })
  const userId = user._id as string
  await t.run(async (ctx) => {
    await ctx.db.insert('platform_admins', { auth_user_id: userId, note: 'test', created_at: NOW })
  })
  return t.withIdentity({ subject: userId })
}

const activity = (org_id: string, ts: string) => ({
  id: uuid(),
  org_id,
  ts,
  verb: 'updated',
  target_type: 'issue' as const,
  target_id: uuid(),
  label: 'Planted',
})

/* withOrg, with Other created a month after Testbed, three live tasks with
 * a link, a milestone, a team grant, the counters row, two activity rows,
 * and a fourth task with a comment moved to Deleted items. */
async function consoleFixture(t: T): Promise<OrgFixture> {
  const f = await withOrg(t)
  const org_id = f.org.id
  const tasks: Doc<'issues'>[] = []
  for (let i = 0; i < 3; i++) {
    tasks.push(
      await plantIssue(t, { org_id, project_id: f.sub.id, description: 'x'.repeat(100 * i) }),
    )
  }
  const gone = await plantIssue(t, { org_id, project_id: f.sub.id, title: 'Duplicate' })
  await comment(t, gone)
  await t.run(async (ctx) => {
    await ctx.db.patch(f.otherOrg._id, { created_at: '2026-02-01T00:00:00.000Z' })
    await ctx.db.insert('issue_links', {
      org_id,
      id: uuid(),
      source_id: tasks[0].id,
      target_id: tasks[1].id,
      type: 'blocks',
      pair_key: [tasks[0].id, tasks[1].id].sort().join(':'),
      created_at: NOW,
    })
    await ctx.db.insert('milestones', {
      id: uuid(),
      project_id: f.meta.id,
      name: 'Beta',
      week: '2026-05-04',
      created_at: NOW,
    })
    await ctx.db.insert('project_team_access', {
      project_id: f.meta.id,
      team_id: f.team.id,
      level: 'user',
    })
    await ctx.db.insert('org_counters', { org_id, next_issue_num: 10, next_project_num: 5 })
    await ctx.db.insert('activity_events', activity(org_id, '2026-04-20T09:00:00.000Z'))
    await ctx.db.insert('activity_events', activity(f.otherOrg.id, '2026-03-02T09:00:00.000Z'))
  })
  // writes the 'deleted' activity row at FIXED
  await deleteTask(t, f, gone.id)
  return f
}

/* The footprint adminStats.ts documents, summed straight from the tables:
 * the organization and counters rows, its profiles, teams with members,
 * projects with grants, team grants and milestones, tasks with the links
 * they are the source of, activity, and the Deleted items copies of those
 * tables. Stored comments are left out, as live comments are. */
const measuredBytes = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const size = (doc: unknown) => JSON.stringify(doc).length
    const sum = (rows: unknown[]) => rows.reduce<number>((n, row) => n + size(row), 0)
    let bytes = size(await byId(ctx, 'organizations', orgId))
    bytes += sum(
      await ctx.db
        .query('org_counters')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect(),
    )
    bytes += sum(
      await ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect(),
    )
    const teams = await ctx.db
      .query('teams')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    for (const team of teams) {
      bytes += size(team)
      bytes += sum(
        await ctx.db
          .query('team_members')
          .withIndex('by_team', (q) => q.eq('team_id', team.id))
          .collect(),
      )
    }
    const projects = await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    for (const project of projects) {
      bytes += size(project)
      for (const table of ['project_access', 'project_team_access', 'milestones'] as const) {
        bytes += sum(
          await ctx.db
            .query(table)
            .withIndex('by_project', (q) => q.eq('project_id', project.id))
            .collect(),
        )
      }
    }
    const issues = await ctx.db
      .query('issues')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    for (const issue of issues) {
      bytes += size(issue)
      bytes += sum(
        await ctx.db
          .query('issue_links')
          .withIndex('by_source', (q) => q.eq('source_id', issue.id))
          .collect(),
      )
    }
    bytes += sum(
      await ctx.db
        .query('activity_events')
        .withIndex('by_org_ts', (q) => q.eq('org_id', orgId))
        .collect(),
    )
    const stored = await ctx.db
      .query('deleted_rows')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    bytes += sum(stored.filter((row) => row.table !== 'comments'))
    return { bytes, storedTables: stored.map((row) => row.table).sort() }
  })

type PublicAction = FunctionReference<'action', 'public', Record<string, never>, unknown>
const PUBLIC = ['listOrgs', 'platformStats'] as const
const publicRef = (name: (typeof PUBLIC)[number]): PublicAction => api.adminStats[name]

/* ---------------------------------------------------------- the fail-closed gate */

describe('fail-closed: both actions refuse everyone but an operator', () => {
  it('names every public function of adminStats.ts', () => {
    const exported = Object.entries(statsModule).filter(
      ([, value]) => (value as { isPublic?: true }).isPublic === true,
    )
    expect(exported.map(([name]) => name).sort()).toEqual([...PUBLIC])
    for (const [, value] of exported) expect((value as { isAction?: true }).isAction).toBe(true)
  })

  for (const name of PUBLIC) {
    it(`${name}: a signed-in org admin and an anonymous caller are refused`, async () => {
      const t = newT()
      const f = await withOrg(t)
      await expectRefusal(
        as(t, f.admin).action(publicRef(name), {}),
        'forbidden',
        /platform admins only/,
      )
      await expectRefusal(t.action(publicRef(name), {}), 'forbidden', /platform admins only/)
    })

    it(`${name}: an operator on a demo deployment is refused`, async () => {
      const t = newT()
      const asOp = await operator(t)
      vi.stubEnv('APP_MODE', 'demo')
      await expectRefusal(
        asOp.action(publicRef(name), {}),
        'forbidden',
        /requires a regular workspace/,
      )
    })
  }
})

/* --------------------------------------------------------------------- listOrgs */

describe('listOrgs', () => {
  it('lists every organization with its counts and footprint, oldest first', async () => {
    const t = newT()
    const f = await consoleFixture(t)
    const asOp = await operator(t)

    const rows = await asOp.action(api.adminStats.listOrgs, {})

    const testbed = await measuredBytes(t, f.org.id)
    const other = await measuredBytes(t, f.otherOrg.id)
    // the deleted task and its comment are in Deleted items; only the task counts
    expect(testbed.storedTables).toEqual(['comments', 'issues'])
    expect(rows).toEqual([
      {
        id: f.org.id,
        name: 'Testbed Labs',
        created_at: NOW,
        plan: 'team',
        seats: 5,
        renewal_date: null,
        member_count: 4, // admin, user, viewer and the agent
        guest_count: 1,
        login_count: 4, // the agent has no login
        team_count: 1,
        project_count: 4,
        issue_count: 3, // the deleted task is not counted
        last_activity: iso(FIXED),
        approx_bytes: testbed.bytes,
      },
      {
        id: f.otherOrg.id,
        name: 'Other',
        created_at: '2026-02-01T00:00:00.000Z',
        plan: null,
        seats: null,
        renewal_date: null,
        member_count: 1,
        guest_count: 0,
        login_count: 1,
        team_count: 0,
        project_count: 1,
        issue_count: 0,
        last_activity: '2026-03-02T09:00:00.000Z',
        approx_bytes: other.bytes,
      },
    ])
  })

  it('gives the same rows when every page holds one row or one byte', async () => {
    const t = newT()
    await consoleFixture(t)
    const asOp = await operator(t)
    const expected = await asOp.action(api.adminStats.listOrgs, {})

    const one = { orgs: 1, rows: 1, issues: 1, teams: 1, projects: 1, children: 1 }
    Object.assign(STATS_PAGE, one)
    expect(await asOp.action(api.adminStats.listOrgs, {})).toEqual(expected)
    // every member, grant, milestone and link list is paged on its own
    Object.assign(STATS_PAGE, { ...one, children: 0 })
    expect(await asOp.action(api.adminStats.listOrgs, {})).toEqual(expected)
    Object.assign(STATS_PAGE, { ...DEFAULT_PAGE, bytes: 1 })
    expect(await asOp.action(api.adminStats.listOrgs, {})).toEqual(expected)
  })

  it('pages the members of a team of 3,000 on their own, within 2,500 documents a read', async () => {
    const t = newT({ transactionLimits: { documentsRead: 2500 } })
    const f = await withOrg(t)
    const asOp = await operator(t)
    const footprint = async () =>
      (await asOp.action(api.adminStats.listOrgs, {})).find((row) => row.id === f.org.id)
        ?.approx_bytes ?? 0
    const before = await footprint()
    let added = 0
    for (let batch = 0; batch < 3; batch++) {
      added += await t.run(async (ctx) => {
        let bytes = 0
        for (let i = 0; i < 1000; i++) {
          const _id = await ctx.db.insert('team_members', {
            team_id: f.team.id,
            profile_id: uuid(),
            is_leader: false,
          })
          bytes += JSON.stringify(await ctx.db.get(_id)).length
        }
        return bytes
      })
    }

    expect(await footprint()).toBe(before + added)

    // Read with its team, the list passes the limit, as in the old query.
    Object.assign(STATS_PAGE, { children: 5000 })
    await expect(asOp.action(api.adminStats.listOrgs, {})).rejects.toThrow(
      /Scanned too many documents/,
    )
  })

  it('lists an organization of 6,000 tasks within 700 index ranges a transaction', async () => {
    const t = newT({ transactionLimits: { databaseQueries: 700 } })
    const f = await withOrg(t)
    const asOp = await operator(t)
    for (let batch = 0; batch < 6; batch++) {
      await t.run(async (ctx) => {
        for (let i = 0; i < 1000; i++) {
          await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id: f.sub.id,
            num: batch * 1000 + i + 1,
            title: 'Bulk task',
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
          })
        }
      })
    }

    const rows = await asOp.action(api.adminStats.listOrgs, {})
    expect(rows.find((row) => row.id === f.org.id)?.issue_count).toBe(6000)
    const stats = await asOp.action(api.adminStats.platformStats, {})
    expect(stats.totals.issues).toBe(6000)

    // One page for the whole organization reads one range per task, as the
    // old single query did, and fails under the same limit.
    Object.assign(STATS_PAGE, { issues: 6000 })
    await expect(asOp.action(api.adminStats.listOrgs, {})).rejects.toThrow(
      /Too many index ranges read/,
    )
  })

  it('leaves out an organization deleted after the ids were read', async () => {
    const t = newT()
    const f = await consoleFixture(t)
    // the action's own reads, with Other's row deleted once the ids are in
    const runner = {
      runQuery: (async (ref: FunctionReference<'query', 'internal'>, args: object) => {
        const result: unknown = await t.query(ref, args)
        if (getFunctionName(ref) === getFunctionName(internal.adminStats.orgIds)) {
          await t.run(async (ctx) => {
            await ctx.db.delete(f.otherOrg._id)
          })
        }
        return result
      }) as ActionCtx['runQuery'],
    }

    const rows = await orgRows(runner)

    expect(rows.map((row) => row.id)).toEqual([f.org.id])
  })
})

/* ---------------------------------------------------------------- platformStats */

describe('platformStats', () => {
  it('totals every table, and its bytes are the organizations’ footprints together', async () => {
    const t = newT()
    await consoleFixture(t)
    const asOp = await operator(t)

    const stats = await asOp.action(api.adminStats.platformStats, {})
    const rows = await asOp.action(api.adminStats.listOrgs, {})

    expect(stats.totals).toEqual({
      orgs: 2,
      members: 6, // every profile, guests and agents included
      logins: 5,
      teams: 1,
      projects: 5,
      issues: 3,
      activity_30d: 2, // 2026-04-20 and the deletion; 2026-03-02 is older
      db_total_bytes: rows.reduce((sum, row) => sum + row.approx_bytes, 0),
    })
  })

  it('buckets new people and activity by week across page boundaries', async () => {
    const t = newT()
    const f = await withOrg(t)
    const asOp = await operator(t)
    await t.run(async (ctx) => {
      for (const [org_id, ts] of [
        [f.org.id, '2026-05-05T08:00:00.000Z'], // week of 2026-05-04
        [f.otherOrg.id, '2026-05-04T00:00:00.000Z'], // its Monday
        [f.org.id, '2026-05-03T23:59:59.000Z'], // the Sunday before
        [f.org.id, '2026-04-01T09:00:00.000Z'], // within 84 days, not 30
        [f.org.id, '2026-02-10T09:00:00.000Z'], // older than 84 days
      ]) {
        await ctx.db.insert('activity_events', activity(org_id, ts))
      }
      for (const created_at of ['2026-05-04T08:00:00.000Z', '2026-04-28T08:00:00.000Z']) {
        await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: f.org.id,
          name: 'New person',
          initials: 'NP',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          created_at,
        })
      }
    })
    const weekly = [
      { week: '2026-03-30', new_members: 0, activity: 1 },
      { week: '2026-04-27', new_members: 1, activity: 1 },
      { week: '2026-05-04', new_members: 1, activity: 2 },
    ]

    const stats = await asOp.action(api.adminStats.platformStats, {})
    expect(stats.weekly).toEqual(weekly)
    expect(stats.totals.activity_30d).toBe(3)

    Object.assign(STATS_PAGE, { table: 1 })
    expect(await asOp.action(api.adminStats.platformStats, {})).toEqual(stats)
    Object.assign(STATS_PAGE, { table: DEFAULT_PAGE.table, bytes: 1 })
    expect(await asOp.action(api.adminStats.platformStats, {})).toEqual(stats)
  })
})

describe('platformStats page arguments', () => {
  /* platformTotals' reads as `${function} ${args}`, in a stable order. */
  async function pageCalls(t: T, at: string): Promise<string[]> {
    vi.setSystemTime(Date.parse(at))
    const calls: string[] = []
    const runner = {
      runQuery: (async (ref: FunctionReference<'query', 'internal'>, args: object) => {
        calls.push(`${getFunctionName(ref)} ${JSON.stringify(args)}`)
        return await t.query(ref, args)
      }) as ActionCtx['runQuery'],
    }
    await platformTotals(runner)
    return calls.sort()
  }

  it('stay the same within an hour, with the window only on profiles and activity', async () => {
    const t = newT()
    await withOrg(t)

    const first = await pageCalls(t, '2026-05-06T12:05:00.000Z')
    expect(await pageCalls(t, '2026-05-06T12:55:00.000Z')).toEqual(first)

    const window = JSON.stringify({
      cutoff30: '2026-04-06T12:00:00.000Z',
      cutoff84: '2026-02-11T12:00:00.000Z',
    })
    for (const call of first) {
      const windowed = /"table":"(profiles|activity_events)"/.test(call)
      expect(call.includes(`"window":${window}`), call).toBe(windowed)
      expect(call.includes('"window"'), call).toBe(windowed)
    }
    // the next hour moves only the two windowed tables' pages
    const next = await pageCalls(t, '2026-05-06T13:00:00.000Z')
    const moved = next.filter((call) => !first.includes(call))
    expect(moved.map((call) => /"table":"(\w+)"/.exec(call)?.[1]).sort()).toEqual([
      'activity_events',
      'profiles',
    ])
  })

  it('refuses a profiles or activity page without the window', async () => {
    const t = newT()
    for (const table of ['profiles', 'activity_events'] as const) {
      await expectRefusal(
        t.query(internal.adminStats.tablePage, { table, cursor: null }),
        'bad_request',
        /needs the time window/,
      )
    }
  })
})

/* --------------------------------------------------------------------- orgNames */

describe('admin.orgNames', () => {
  it('names every organization for the audit page', async () => {
    const t = newT()
    const f = await withOrg(t)
    const asOp = await operator(t)

    const names = await asOp.query(api.admin.orgNames, {})

    expect(names).toHaveLength(2)
    expect(names).toEqual(
      expect.arrayContaining([
        { id: f.org.id, name: 'Testbed Labs' },
        { id: f.otherOrg.id, name: 'Other' },
      ]),
    )
  })
})

/* Monthly usage (usage.ts, model/usage.ts). The suite stores a month for a
 * small fixture at the smallest page sizes and checks every figure against
 * what it planted, reruns it, and covers the mail and webhook counters, the
 * retention sweep, an organization's deletion and the operator gate. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { overlapShare, spread } from '../lib/usage'
import { USAGE_PAGE } from '../model/usage'
import { USAGE_EXPIRY } from '../usage'
import {
  as,
  expectRefusal,
  newT,
  type OrgFixture,
  plantIssue,
  runInAuth,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { attach, deleteTask } from './trash.setup'

const DEFAULT_PAGE = { ...USAGE_PAGE }
const DEFAULT_EXPIRY = { ...USAGE_EXPIRY }
/* Just after March 2026 ended, when the monthly job runs. */
const RUN = Date.parse('2026-04-01T05:15:00.000Z')
const MARCH = '2026-03'
const iso = (s: string) => new Date(s).toISOString()
const runSteps = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimers())

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(RUN)
})
afterEach(() => {
  Object.assign(USAGE_PAGE, DEFAULT_PAGE)
  Object.assign(USAGE_EXPIRY, DEFAULT_EXPIRY)
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

/** Every page size at its smallest, so each figure is summed over pages. */
const smallestPages = () =>
  Object.assign(USAGE_PAGE, { orgs: 1, rows: 1, profiles: 1, issues: 1, comments: 1 })

/** A platform operator. */
async function operator(t: T) {
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: {
        name: 'operator',
        email: 'operator@platform.test',
        emailVerified: true,
        createdAt: RUN,
        updatedAt: RUN,
      },
    },
  })
  const userId = user._id as string
  await t.run(async (ctx) => {
    await ctx.db.insert('platform_admins', {
      auth_user_id: userId,
      note: 'test',
      created_at: iso('2026-01-01'),
    })
  })
  return t.withIdentity({ subject: userId })
}

const activityRow = (org_id: string, ts: string, actor_id?: string) => ({
  id: uuid(),
  org_id,
  ts: iso(ts),
  ...(actor_id === undefined ? {} : { actor_id }),
  verb: 'updated',
  target_type: 'issue' as const,
  target_id: uuid(),
  label: 'Planted',
})

const usageRow = (
  org_id: string,
  profile_id: string,
  period_start: string,
  calls: number,
  credential_id = `mcp_tokens:${profile_id}`,
) => ({
  org_id,
  profile_id,
  credential_id,
  credential_name: 'Laptop',
  period_start,
  calls,
})

/** A Better Auth session of `profile`'s login. */
const session = (t: T, profile: Doc<'profiles'>, createdAt: string, updatedAt: string) =>
  runInAuth(t, async (ctx) => {
    await ctx.db.insert('session', {
      token: uuid(),
      userId: profile.auth_user_id as string,
      createdAt: Date.parse(createdAt),
      updatedAt: Date.parse(updatedAt),
      expiresAt: Date.parse(updatedAt) + 7 * 86_400_000,
    })
  })

/**
 * March for the fixture's organization: the planted rows in March and the
 * ones just outside it that must not count. Returns the task with files.
 */
async function plantMarch(t: T, f: OrgFixture) {
  const org = f.org.id
  const task = await plantIssue(t, { org_id: org, project_id: f.meta.id })
  const gone = await plantIssue(t, { org_id: org, project_id: f.meta.id })
  await attach(t, task, 100)
  await attach(t, gone, 40)
  await deleteTask(t, f, gone.id)
  await runSteps(t)
  await t.run(async (ctx) => {
    for (const ts of ['2026-03-01T00:00:00Z', '2026-03-10', '2026-03-31T23:59:59Z'])
      await ctx.db.insert('activity_events', activityRow(org, ts, f.user.id))
    await ctx.db.insert('activity_events', activityRow(org, '2026-03-05', f.admin.id))
    await ctx.db.insert('activity_events', activityRow(org, '2026-02-28T23:59:59Z', f.viewer.id))
    await ctx.db.insert('activity_events', activityRow(org, '2026-04-01T00:00:00Z', f.viewer.id))
    for (const created_at of ['2026-03-02', '2026-03-20', '2026-02-27'])
      await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: task.id,
        author: f.user.id,
        body: 'Seen',
        created_at: iso(created_at),
      })
    const storage_id = await ctx.storage.store(new Blob(['x'.repeat(30)]) as never)
    await ctx.db.insert('issue_attachments', {
      org_id: org,
      id: uuid(),
      issue_id: task.id,
      name: 'diagram.png',
      size_bytes: 30,
      storage_id,
      inline: true,
      created_at: iso('2026-03-03'),
    })
    const avatar = await ctx.storage.store(new Blob(['y'.repeat(7)]) as never)
    await ctx.db.patch(f.admin._id, { avatar_storage_id: avatar })
    await ctx.db.insert('billing_usage', usageRow(org, f.user.id, `month:${MARCH}`, 10))
    await ctx.db.insert('billing_usage', usageRow(org, f.agent.id, `month:${MARCH}`, 5))
    await ctx.db.insert('billing_usage', usageRow(org, f.viewer.id, 'month:2026-02', 7))
    // A paid period from 16 February to 16 March: 15 of its 28 days are in March.
    const paid = iso('2026-02-16')
    await ctx.db.insert('billing_periods', {
      org_id: org,
      subscription_id: uuid(),
      plan_id: uuid(),
      period_start: paid,
      period_end: iso('2026-03-16'),
      seats: 5,
      profile_ids: [],
      created_at: paid,
    })
    await ctx.db.insert('billing_usage_totals', {
      org_id: org,
      period_start: paid,
      calls: 28,
      reported_api_blocks: 0,
    })
    await ctx.db.insert('billing_usage', usageRow(org, f.user.id, paid, 28, 'agent_keys:a'))
    const delivery = {
      org_id: org,
      subscription_id: uuid(),
      project_id: f.meta.id,
      task_id: task.id,
      name: 'task.updated' as const,
      payload: '{}',
      status: 'delivered' as const,
      created_at: Date.parse('2026-03-09'),
    }
    await ctx.db.insert('webhook_deliveries', {
      ...delivery,
      id: uuid(),
      attempts: 2,
      completed_at: Date.parse('2026-03-09'),
    })
    await ctx.db.insert('webhook_deliveries', {
      ...delivery,
      id: uuid(),
      attempts: 1,
      completed_at: Date.parse('2026-02-20'),
    })
    // What the retention sweep and the mail paths counted in March.
    for (const [metric, count] of [
      ['webhook_deliveries', 4],
      ['webhook_attempts', 6],
      ['mail_invitations', 2],
    ] as const)
      await ctx.db.insert('usage_counts', { org_id: org, month: MARCH, metric, count })
  })
  // The user's session began in February and was refreshed in March; the
  // admin's ended in February.
  await session(t, f.user, '2026-02-20', '2026-03-04')
  await session(t, f.admin, '2026-02-01', '2026-02-10')
  return task
}

const storedRows = (t: T, month = MARCH) =>
  t.run((ctx) =>
    ctx.db
      .query('usage_months')
      .withIndex('by_month', (q) => q.eq('month', month))
      .collect(),
  )

describe('the spread of a column', () => {
  it('gives the nearest-rank percentiles and leaves out nulls', () => {
    const values = [...Array.from({ length: 100 }, (_, i) => i + 1), null]
    expect(spread(values)).toEqual({ median: 50, p90: 90, p99: 99, max: 100 })
    expect(spread([7])).toEqual({ median: 7, p90: 7, p99: 7, max: 7 })
    expect(spread([null])).toEqual({ median: null, p90: null, p99: null, max: null })
  })

  it('splits a span by the part inside the month', () => {
    const start = Date.parse('2026-03-01')
    const end = Date.parse('2026-04-01')
    expect(overlapShare(Date.parse('2026-02-16'), Date.parse('2026-03-16'), start, end)).toBe(
      15 / 28,
    )
    expect(overlapShare(Date.parse('2026-03-02'), Date.parse('2026-03-09'), start, end)).toBe(1)
    expect(overlapShare(Date.parse('2026-04-02'), Date.parse('2026-04-09'), start, end)).toBe(0)
  })
})

describe('the monthly job', () => {
  it('stores each organization’s March, every figure summed over pages', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantMarch(t, f)
    smallestPages()
    await t.action(internal.usage.closeMonth, {})
    await runSteps(t)
    const rows = await storedRows(t)
    expect(rows).toHaveLength(2)
    const mine = rows.find((row) => row.org_id === f.org.id)
    expect(mine?.counts).toEqual({
      // admin, user, viewer and the agent hold home roles, and the guest has
      // no home membership elsewhere
      billable: 5,
      guests: 1,
      agents: 1,
      // the user (changes, comments, calls, session), the admin (a change)
      // and the agent (calls); the viewer acted only outside March
      active_people: 3,
      active_tasks: null,
      live_projects: null,
      changes: 4,
      comments: 2,
      // 15 in March's own bucket and 15 of the paid period's 28
      api_calls: 30,
      file_bytes: 100,
      image_bytes: 30,
      deleted_file_bytes: 40,
      avatar_bytes: 7,
      webhook_deliveries: 5,
      webhook_attempts: 8,
      mail_invitations: 2,
      mail_billing_reminders: 0,
      mail_deletion_notices: 0,
    })
    expect(mine?.api_estimated).toBe(true)
    const other = rows.find((row) => row.org_id === f.otherOrg.id)
    expect(other?.counts).toMatchObject({ billable: 1, changes: 0, api_calls: 0 })
    const runs = await t.run((ctx) =>
      ctx.db
        .query('platform_audit_log')
        .filter((q) => q.eq(q.field('action'), 'usage_month'))
        .collect(),
    )
    expect(runs.map((row) => row.detail)).toEqual([{ month: MARCH, saved: 2, failed: 0 }])
  })

  it('replaces the month’s row on a rerun', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.action(internal.usage.closeMonth, { month: MARCH })
    await runSteps(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('activity_events', activityRow(f.org.id, '2026-03-12', f.user.id))
    })
    await t.action(internal.usage.closeMonth, { month: MARCH })
    await runSteps(t)
    const mine = (await storedRows(t)).filter((row) => row.org_id === f.org.id)
    expect(mine).toHaveLength(1)
    expect(mine[0].counts.changes).toBe(1)
  })

  it('refuses a month that has not ended and does nothing on the demo', async () => {
    const t = newT()
    await withOrg(t)
    await expect(t.action(internal.usage.closeMonth, { month: '2026-04' })).rejects.toThrow(
      /only a month that has ended/,
    )
    vi.stubEnv('APP_MODE', 'demo')
    await t.action(internal.usage.closeMonth, { month: MARCH })
    expect(await storedRows(t)).toEqual([])
  })

  it('writes no row for an organization whose deletion has begun', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: iso('2026-03-01'),
        delete_after: iso('2026-03-31'),
        phase: 'profiles',
        created_at: iso('2026-03-01'),
      })
    })
    await t.action(internal.usage.closeMonth, { month: MARCH })
    await runSteps(t)
    expect((await storedRows(t)).map((row) => row.org_id)).toEqual([f.otherOrg.id])
  })
})

describe('the counters', () => {
  const countsOf = (t: T) =>
    t.run((ctx) =>
      ctx.db
        .query('usage_counts')
        .collect()
        .then((rows) =>
          rows.map(({ org_id, month, metric, count }) => ({ org_id, month, metric, count })),
        ),
    )

  it('counts a delivered billing reminder and deletion notice once each', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      for (const kind of ['billing', 'deletion'])
        await ctx.db.insert('billing_notices', {
          key: kind,
          org_id: f.org.id,
          profile_id: f.admin.id,
          kind,
          created_at: iso('2026-03-30'),
        })
    })
    for (let i = 0; i < 2; i++) {
      await t.mutation(internal.billingMail.sent, { key: 'billing' })
      await t.mutation(internal.orgRemovals.noticeSent, { key: 'deletion' })
    }
    expect(await countsOf(t)).toEqual([
      { org_id: f.org.id, month: '2026-04', metric: 'mail_billing_reminders', count: 1 },
      { org_id: f.org.id, month: '2026-04', metric: 'mail_deletion_notices', count: 1 },
    ])
  })

  it('counts a sent invitation once and an unsent one not at all', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [sent, unsent] = await t.run(async (ctx) =>
      Promise.all(
        [0, 1].map(() =>
          ctx.db.insert('platform_audit_log', {
            ts: iso('2026-04-01'),
            actor_email: 'system',
            action: 'invite_email',
            target_org_id: f.org.id,
            channel: 'app',
            detail: {},
          }),
        ),
      ),
    )
    await t.mutation(internal.invites.settle, { row: sent, sent: true, uncertain: false })
    await t.mutation(internal.invites.settle, { row: sent, sent: true, uncertain: false })
    await t.mutation(internal.invites.settle, { row: unsent, sent: false, uncertain: true })
    expect(await countsOf(t)).toEqual([
      { org_id: f.org.id, month: '2026-04', metric: 'mail_invitations', count: 1 },
    ])
  })

  it('counts person mail without an organization, and nothing on the demo', async () => {
    const t = newT()
    await t.mutation(internal.usage.countPersonMail, { metric: 'mail_password_reset' })
    await t.mutation(internal.usage.countPersonMail, { metric: 'mail_password_reset' })
    vi.stubEnv('APP_MODE', 'demo')
    await t.mutation(internal.usage.countPersonMail, { metric: 'mail_verification' })
    expect(await countsOf(t)).toEqual([
      { org_id: undefined, month: '2026-04', metric: 'mail_password_reset', count: 2 },
    ])
    expect(await t.query(internal.usage.mailWithoutOrg, { month: '2026-04' })).toEqual({
      mail_verification: 0,
      mail_password_reset: 2,
      mail_account_notes: 0,
    })
  })

  it('adds the deliveries the retention sweep deletes to the month each finished', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      for (const [completed, attempts] of [
        ['2026-02-27', 3],
        ['2026-03-02', 1],
        ['2026-03-20', 2],
        ['2026-03-31', 1], // finished less than a week ago, so kept
      ] as const)
        await ctx.db.insert('webhook_deliveries', {
          id: uuid(),
          org_id: f.org.id,
          subscription_id: uuid(),
          project_id: f.meta.id,
          task_id: uuid(),
          name: 'task.updated',
          payload: '{}',
          status: 'delivered',
          attempts,
          completed_at: Date.parse(completed),
          created_at: Date.parse(completed),
        })
    })
    await t.mutation(internal.webhooks.sweep, {})
    const counted = await countsOf(t)
    expect(counted).toEqual(
      expect.arrayContaining([
        { org_id: f.org.id, month: '2026-02', metric: 'webhook_deliveries', count: 1 },
        { org_id: f.org.id, month: '2026-02', metric: 'webhook_attempts', count: 3 },
        { org_id: f.org.id, month: MARCH, metric: 'webhook_deliveries', count: 2 },
        { org_id: f.org.id, month: MARCH, metric: 'webhook_attempts', count: 3 },
      ]),
    )
    expect(counted).toHaveLength(4)
    const left = await t.run((ctx) => ctx.db.query('webhook_deliveries').collect())
    expect(left).toHaveLength(1)
  })
})

describe('retention and deletion', () => {
  it('deletes rows of months older than 800 days, page by page', async () => {
    const t = newT()
    const f = await withOrg(t)
    // 800 days before RUN is in January 2024, so December 2023 goes.
    await t.run(async (ctx) => {
      for (const month of ['2023-11', '2023-12', '2024-01', MARCH]) {
        await ctx.db.insert('usage_counts', {
          org_id: f.org.id,
          month,
          metric: 'mail_invitations',
          count: 1,
        })
        await ctx.db.insert('usage_months', {
          org_id: f.org.id,
          month,
          counts: (await ctx.db.query('usage_months').first())?.counts ?? emptyCounts,
          api_estimated: false,
          computed_at: iso('2026-01-01'),
        })
      }
    })
    USAGE_EXPIRY.page = 1
    await t.mutation(internal.usage.expire, {})
    await runSteps(t)
    const left = await t.run(async (ctx) => ({
      months: (await ctx.db.query('usage_months').collect()).map((row) => row.month).sort(),
      counts: (await ctx.db.query('usage_counts').collect()).map((row) => row.month).sort(),
    }))
    expect(left).toEqual({ months: ['2024-01', MARCH], counts: ['2024-01', MARCH] })
  })

  it('goes with its organization', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.action(internal.usage.closeMonth, { month: MARCH })
    await runSteps(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('usage_counts', {
        org_id: f.org.id,
        month: MARCH,
        metric: 'mail_invitations',
        count: 1,
      })
      await ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: iso('2026-03-01'),
        delete_after: iso('2026-03-31'),
        phase: 'profiles',
        created_at: iso('2026-03-01'),
      })
    })
    // A reminder delivered once the deletion has begun is not counted.
    await t.run(async (ctx) => {
      await ctx.db.insert('billing_notices', {
        key: 'late',
        org_id: f.org.id,
        profile_id: f.admin.id,
        kind: 'billing',
        created_at: iso('2026-03-30'),
      })
    })
    await t.mutation(internal.billingMail.sent, { key: 'late' })
    const before = await t.run((ctx) => ctx.db.query('usage_counts').collect())
    expect(before.map((row) => [row.metric, row.count])).toEqual([['mail_invitations', 1]])
    await t.mutation(internal.orgRemovals.step, { org_id: f.org.id })
    await runSteps(t)
    const left = await t.run(async (ctx) => ({
      org: await ctx.db.query('organizations').collect(),
      months: await ctx.db.query('usage_months').collect(),
      counts: await ctx.db.query('usage_counts').collect(),
    }))
    expect(left.org.map((org) => org.id)).toEqual([f.otherOrg.id])
    expect(left.months.map((row) => row.org_id)).toEqual([f.otherOrg.id])
    expect(left.counts).toEqual([])
  })
})

const emptyCounts = {
  billable: 0,
  guests: 0,
  agents: 0,
  active_people: 0,
  active_tasks: null,
  live_projects: null,
  changes: 0,
  comments: 0,
  api_calls: 0,
  file_bytes: 0,
  image_bytes: 0,
  deleted_file_bytes: 0,
  avatar_bytes: 0,
  webhook_deliveries: 0,
  webhook_attempts: 0,
  mail_invitations: 0,
  mail_billing_reminders: 0,
  mail_deletion_notices: 0,
}

describe('Qivo Admin', () => {
  it('refuses everyone but an operator', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const call of [
      () => as(t, f.admin).action(api.usage.monthTable, { month: MARCH }),
      () => as(t, f.admin).action(api.usage.orgMonths, { org_id: f.org.id }),
      () => as(t, f.admin).action(api.usage.orgPeople, { org_id: f.org.id, month: MARCH }),
      () => t.action(api.usage.monthTable, { month: MARCH }),
    ])
      await expectRefusal(call(), 'forbidden', /platform admins only/)
  })

  it('shows a closed month’s stored rows, the current month computed now, and who did what', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantMarch(t, f)
    const op = await operator(t)
    expect((await op.action(api.usage.monthTable, { month: MARCH })).rows).toEqual([])
    await t.action(internal.usage.closeMonth, {})
    await runSteps(t)
    const march = await op.action(api.usage.monthTable, { month: MARCH })
    expect(march.current).toBe(false)
    expect(march.rows.find((row) => row.org_id === f.org.id)).toMatchObject({
      name: 'Testbed Labs',
      api_estimated: true,
      counts: { changes: 4, api_calls: 30 },
    })
    await t.run(async (ctx) => {
      await ctx.db.insert(
        'activity_events',
        activityRow(f.org.id, '2026-04-01T02:00:00Z', f.user.id),
      )
    })
    const april = await op.action(api.usage.monthTable, { month: '2026-04' })
    expect(april.current).toBe(true)
    expect(april.rows.find((row) => row.org_id === f.org.id)).toMatchObject({
      computed_at: null,
      // the viewer's row on the 1st, the task deletion's and the one above
      counts: { changes: 3 },
    })
    await expectRefusal(
      op.action(api.usage.monthTable, { month: '2026-05' }),
      'bad_request',
      /not begun/,
    )
    const months = await op.action(api.usage.orgMonths, { org_id: f.org.id })
    expect(months.map((m) => m.month)).toEqual([MARCH, '2026-04'])
    const { people } = await op.action(api.usage.orgPeople, { org_id: f.org.id, month: MARCH })
    const byName = Object.fromEntries(people.map((p) => [p.name, p]))
    expect(byName.user).toMatchObject({ changes: 3, comments: 2, api_calls: 25, signed_in: true })
    expect(byName.user.credentials).toEqual(
      expect.arrayContaining([
        { id: `mcp_tokens:${f.user.id}`, name: 'Laptop', calls: 10 },
        { id: 'agent_keys:a', name: 'Laptop', calls: 15 },
      ]),
    )
    expect(byName.admin).toMatchObject({ changes: 1, comments: 0, api_calls: 0, signed_in: false })
    expect(byName.Relay).toMatchObject({ api_calls: 5 })
    expect(people).toHaveLength(3)
  })
})

/* Monthly usage (usage.ts, model/usage.ts). The suite stores a month for a
 * small fixture at the smallest page sizes and checks every figure against
 * what it planted, reruns it, and covers the mail and webhook counters, the
 * sign-ins a sign-out would erase, the retention sweep, an organization's
 * deletion and the operator gate. */
/// <reference types="vite/client" />

import { hashPassword } from 'better-auth/crypto'
import { type DefaultFunctionArgs, type FunctionReference, getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { createAuth } from '../auth'
import { overlapShare, spread } from '../lib/usage'
import { deleteOrgDeep } from '../model/cascade'
import { pageReadBound, USAGE_PAGE } from '../model/usage'
import { orgUsage, RUN_STALLED_MS, USAGE_EXPIRY } from '../usage'
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
const APP = 'http://localhost:5199'
const PASSWORD = 'Hermetic usage password 271828!'
type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }
const http = (t: T, path: string, init?: FetchInit): Promise<Response> =>
  (t as unknown as { fetch(path: string, init?: FetchInit): Promise<Response> }).fetch(path, init)
const runSteps = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimers())
/** The test backend as the runner orgUsage reads through. */
const runner = (t: T) =>
  ({
    runQuery: (ref: FunctionReference<'query', 'internal'>, args: DefaultFunctionArgs) =>
      t.query(ref, args),
  }) as Parameters<typeof orgUsage>[0]

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

/** A Better Auth login with no organization. */
async function login(t: T, email: string): Promise<string> {
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: { name: email, email, emailVerified: true, createdAt: RUN, updatedAt: RUN },
    },
  })
  return user._id as string
}

/** A platform operator. */
async function operator(t: T) {
  const userId = await login(t, 'operator@platform.test')
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
    // An account background of 50 bytes with a preview of 9, which belongs
    // to the login, not the organization.
    await ctx.db.insert('custom_backgrounds', {
      id: uuid(),
      auth_user_id: f.user.auth_user_id as string,
      storage_id: await ctx.storage.store(new Blob(['b'.repeat(50)]) as never),
      preview_storage_id: await ctx.storage.store(new Blob(['p'.repeat(9)]) as never),
      name: 'Fjord',
      mime: 'image/jpeg',
      width: 10,
      height: 10,
      byte_size: 50,
      sha256: 'f'.repeat(64),
      uploaded_at: iso('2026-03-03'),
    })
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
    expect(await t.query(internal.usage.unattributed, { month: MARCH })).toEqual({
      mail_verification: 0,
      mail_password_reset: 0,
      mail_account_notes: 0,
      background_bytes: 59,
    })
  })

  it('reads less in a comments page than a transaction may, even for 1 MiB comments', () => {
    expect(pageReadBound()).toBeLessThan(16 * 1024 * 1024)
  })

  it('reads a page’s other tasks on their own once its comments pass the byte budget', async () => {
    const t = newT()
    const f = await withOrg(t)
    const tasks = [
      await plantIssue(t, { org_id: f.org.id, project_id: f.meta.id }),
      await plantIssue(t, { org_id: f.org.id, project_id: f.meta.id }),
      await plantIssue(t, { org_id: f.org.id, project_id: f.meta.id }),
    ]
    await t.run(async (ctx) => {
      for (const task of tasks)
        await ctx.db.insert('comments', {
          id: uuid(),
          issue_id: task.id,
          author: f.user.id,
          body: 'x'.repeat(1000),
          created_at: iso('2026-03-05'),
        })
    })
    // The first task's one comment fills the budget.
    Object.assign(USAGE_PAGE, { commentBytes: 1000 })
    const page = await t.query(internal.usage.comments, {
      org_id: f.org.id,
      month: MARCH,
      cursor: null,
    })
    expect(page.comments).toBe(1)
    expect(page.deferred).toHaveLength(2)
    await t.action(internal.usage.closeOrgMonth, { org_id: f.org.id, month: MARCH })
    expect((await storedRows(t))[0].counts.comments).toBe(3)
  })

  it('counts a delivery the retention sweep moves while the month is read', async () => {
    const t = newT()
    const f = await withOrg(t)
    // Finished in March and more than a week ago, so the sweep deletes it.
    vi.setSystemTime(Date.parse('2026-03-20'))
    await t.run(async (ctx) => {
      await ctx.db.insert('webhook_deliveries', {
        id: uuid(),
        org_id: f.org.id,
        subscription_id: uuid(),
        project_id: f.meta.id,
        task_id: uuid(),
        name: 'task.updated',
        payload: '{}',
        status: 'delivered',
        attempts: 2,
        completed_at: Date.parse('2026-03-02'),
        created_at: Date.parse('2026-03-02'),
      })
    })
    // The sweep runs after the counts were read and before the stored rows.
    let swept = false
    const runner = {
      runQuery: async (ref: FunctionReference<'query', 'internal'>, args: DefaultFunctionArgs) => {
        if (getFunctionName(ref) === 'usage:webhooks' && !swept) {
          swept = true
          await t.mutation(internal.webhooks.sweep, {})
        }
        return await t.query(ref, args)
      },
    } as Parameters<typeof orgUsage>[0]
    const usage = await orgUsage(runner, f.org.id, MARCH, Date.now())
    expect(swept).toBe(true)
    expect(usage?.counts).toMatchObject({ webhook_deliveries: 1, webhook_attempts: 2 })
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
    // 800 days before RUN is in January 2024.
    await expect(t.action(internal.usage.closeMonth, { month: '2023-12' })).rejects.toThrow(
      /older than usage is kept/,
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

  it('stores no row for an organization created after the month ended', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.otherOrg._id, { created_at: iso('2026-04-01T03:00:00Z') })
    })
    await t.action(internal.usage.closeMonth, { month: MARCH })
    await runSteps(t)
    expect((await storedRows(t)).map((row) => row.org_id)).toEqual([f.org.id])
  })

  it('resumes a run whose step stopped the next day, and runs a finished month once', async () => {
    const t = newT()
    const f = await withOrg(t)
    Object.assign(USAGE_PAGE, { orgs: 1 })
    await t.action(internal.usage.closeMonth, {})
    // The first step stored one organization; its successor is lost, as at a
    // restart.
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query('_scheduled_functions').collect())
        if (job.state.kind === 'pending') await ctx.scheduler.cancel(job._id)
    })
    expect(await storedRows(t)).toHaveLength(1)
    // A call while the step may still run leaves it.
    await t.action(internal.usage.closeMonth, {})
    await runSteps(t)
    expect(await storedRows(t)).toHaveLength(1)
    vi.setSystemTime(RUN + RUN_STALLED_MS + 1)
    await t.action(internal.usage.closeMonth, {})
    await runSteps(t)
    expect((await storedRows(t)).map((row) => row.org_id).sort()).toEqual(
      [f.org.id, f.otherOrg.id].sort(),
    )
    // The next day's call finds the month finished.
    vi.setSystemTime(RUN + 86_400_000)
    await t.action(internal.usage.closeMonth, {})
    await runSteps(t)
    const audits = await t.run((ctx) =>
      ctx.db
        .query('platform_audit_log')
        .filter((q) => q.eq(q.field('action'), 'usage_month'))
        .collect(),
    )
    expect(audits.map((row) => row.detail)).toEqual([{ month: MARCH, saved: 2, failed: 0 }])
  })
})

describe('a rerun', () => {
  it('keeps a step of the run it replaced from writing', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('usage_runs', { month: MARCH, seen_at: RUN, run: 'rerun' })
    })
    const save = (run: string) =>
      t.mutation(internal.usage.saveMonth, {
        org_id: f.org.id,
        month: MARCH,
        counts: emptyCounts,
        api_estimated: false,
        run,
      })
    expect(await save('replaced')).toBe(false)
    expect(await storedRows(t)).toEqual([])
    expect(await save('rerun')).toBe(true)
    expect(await storedRows(t)).toHaveLength(1)
  })
})

describe('REST and MCP calls', () => {
  /** Plants a bucket of 9,000 calls keyed by `key` with no recorded end, as
   * a pending interval that was never adopted leaves. */
  const openBucket = (t: T, f: OrgFixture, key: string) =>
    t.run(async (ctx) => {
      await ctx.db.insert('billing_usage_totals', {
        org_id: f.org.id,
        period_start: key,
        calls: 9000,
        reported_api_blocks: 0,
      })
      await ctx.db.insert('billing_usage', usageRow(f.org.id, f.user.id, key, 9000))
    })
  const callsIn = async (t: T, f: OrgFixture, month: string) =>
    (await orgUsage(runner(t), f.org.id, month, Date.now()))?.counts.api_calls
  const marchCalls = (t: T, f: OrgFixture) => callsIn(t, f, MARCH)

  it('counts an open bucket no longer written to in its first month only', async () => {
    const t = newT()
    const f = await withOrg(t)
    await openBucket(t, f, iso('2026-01-10'))
    expect(await marchCalls(t, f)).toBe(0)
    expect(await callsIn(t, f, '2026-01')).toBe(9000)
  })

  it('sums a person’s calls before rounding them', async () => {
    const t = newT()
    const f = await withOrg(t)
    // A paid period from 16 February to 16 March: 15 of its 28 days are in
    // March, so each of the user's two keys has about 0.54 of a call there.
    const paid = iso('2026-02-16')
    await t.run(async (ctx) => {
      await ctx.db.insert('billing_periods', {
        org_id: f.org.id,
        subscription_id: uuid(),
        plan_id: uuid(),
        period_start: paid,
        period_end: iso('2026-03-16'),
        seats: 5,
        profile_ids: [],
        created_at: paid,
      })
      await ctx.db.insert('billing_usage_totals', {
        org_id: f.org.id,
        period_start: paid,
        calls: 2,
        reported_api_blocks: 0,
      })
      for (const key of ['agent_keys:a', 'agent_keys:b'])
        await ctx.db.insert('billing_usage', usageRow(f.org.id, f.user.id, paid, 1, key))
    })
    const usage = await orgUsage(runner(t), f.org.id, MARCH, Date.now())
    expect(usage?.counts.api_calls).toBe(1)
    expect(usage?.people.find((p) => p.profile_id === f.user.id)?.api_calls).toBe(1)
  })

  it('ends an open bucket where the next known period begins', async () => {
    const t = newT()
    const f = await withOrg(t)
    await openBucket(t, f, iso('2026-02-20'))
    // A recorded period of another subscription from 10 March.
    await t.run(async (ctx) => {
      await ctx.db.insert('billing_periods', {
        org_id: f.org.id,
        subscription_id: uuid(),
        plan_id: uuid(),
        period_start: iso('2026-03-10'),
        period_end: iso('2026-04-10'),
        seats: 5,
        profile_ids: [],
        created_at: iso('2026-03-10'),
      })
    })
    // 20 February to 10 March is 18 days, 9 of them in March.
    expect(await marchCalls(t, f)).toBe(4500)
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
    // A send that settles after its organization's deletion finished.
    const late = await t.run((ctx) =>
      ctx.db.insert('platform_audit_log', {
        ts: iso('2026-04-01'),
        actor_email: 'system',
        action: 'invite_email',
        target_org_id: uuid(),
        channel: 'app',
        detail: {},
      }),
    )
    await t.mutation(internal.invites.settle, { row: late, sent: true, uncertain: false })
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
    expect(await t.query(internal.usage.unattributed, { month: '2026-04' })).toEqual({
      mail_verification: 0,
      mail_password_reset: 2,
      mail_account_notes: 0,
      background_bytes: null,
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

describe('sign-ins', () => {
  const kept = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.query('usage_sign_ins').collect()).map(({ auth_user_id, month }) => ({
        auth_user_id,
        month,
      })),
    )

  it('counts a person who signed in and out within the month and did nothing else', async () => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-03-10T09:00:00Z'))
    vi.stubEnv('SITE_URL', APP)
    vi.stubEnv('CONVEX_SITE_URL', 'https://some.convex.site')
    vi.stubEnv('BETTER_AUTH_SECRET', 'usage-hermetic-secret-not-a-real-deployment-271828')
    const t = newT()
    const f = await withOrg(t)
    const userId = f.viewer.auth_user_id as string
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'account',
        data: {
          accountId: userId,
          userId,
          providerId: 'credential',
          password: await hashPassword(PASSWORD),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })
    const signIn = await http(t, '/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP, 'better-auth-cookie': '' },
      body: JSON.stringify({ email: f.viewer.email, password: PASSWORD }),
    })
    expect(signIn.status).toBe(200)
    const cookie = signIn.headers
      .get('set-better-auth-cookie')
      ?.match(/(?:^|,\s*)([^=;,]*session_token=[^;]+)/)?.[1]
    vi.setSystemTime(Date.parse('2026-03-12T09:00:00Z'))
    const signOut = await http(t, '/api/auth/sign-out', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: APP,
        'better-auth-cookie': cookie as string,
      },
      body: '{}',
    })
    expect(signOut.status).toBe(200)
    expect(await runInAuth(t, (ctx) => ctx.db.query('session').collect())).toEqual([])
    expect(await kept(t)).toEqual([{ auth_user_id: userId, month: MARCH }])
    vi.setSystemTime(RUN)
    await t.action(internal.usage.closeOrgMonth, { org_id: f.org.id, month: MARCH })
    expect((await storedRows(t))[0].counts.active_people).toBe(1)
  })

  it('keeps each month a session was used in once, back to what retention keeps', async () => {
    const t = newT()
    const userId = await login(t, 'ghost@test.local')
    for (let i = 0; i < 2; i++)
      await t.mutation(internal.usage.keepSignIn, {
        auth_user_id: userId,
        // 800 days before RUN is in January 2024, so December 2023 is left out.
        created_at: Date.parse('2023-12-20'),
        updated_at: Date.parse('2024-02-03'),
      })
    expect(await kept(t)).toEqual([
      { auth_user_id: userId, month: '2024-01' },
      { auth_user_id: userId, month: '2024-02' },
    ])
    // Deleting the login deletes them, and a session of it that ends later
    // keeps nothing.
    await t.mutation(internal.adminAuth.deleteOrphanLogin, { email: 'ghost@test.local' })
    expect(await kept(t)).toEqual([])
    await t.mutation(internal.usage.keepSignIn, {
      auth_user_id: userId,
      created_at: Date.parse('2026-03-02'),
      updated_at: Date.parse('2026-03-03'),
    })
    expect(await kept(t)).toEqual([])
  })

  /** The environment Better Auth's options need (auth.ts createAuth). */
  const authEnv = () => {
    vi.stubEnv('SITE_URL', APP)
    vi.stubEnv('CONVEX_SITE_URL', 'https://some.convex.site')
    vi.stubEnv('BETTER_AUTH_SECRET', 'usage-hermetic-secret-not-a-real-deployment-271828')
  }
  /** Runs Better Auth's own session and login removal, as a ban or a
   * deleted login does. */
  const internalAdapter = (t: T) => ({
    deleteUserSessions: (userId: string) =>
      t.run(async (ctx) =>
        (await createAuth(ctx).$context).internalAdapter.deleteUserSessions(userId),
      ),
    deleteSession: (token: string) =>
      t.run(async (ctx) => (await createAuth(ctx).$context).internalAdapter.deleteSession(token)),
    deleteUser: (userId: string) =>
      t.run(async (ctx) => (await createAuth(ctx).$context).internalAdapter.deleteUser(userId)),
  })
  const sessions = (t: T) => runInAuth(t, (ctx) => ctx.db.query('session').collect())

  it('keeps the months of every session Better Auth ends in one call', async () => {
    authEnv()
    const t = newT()
    const f = await withOrg(t)
    // Better Auth's own delete hooks reach only the first 100 sessions it
    // reads; the session's delete trigger runs for each one deleted.
    for (let i = 0; i < 100; i++) await session(t, f.user, '2026-02-02', '2026-02-03')
    await session(t, f.user, '2026-01-05', '2026-01-06')
    await internalAdapter(t).deleteUserSessions(f.user.auth_user_id as string)
    expect(await sessions(t)).toEqual([])
    expect((await kept(t)).map((row) => row.month).sort()).toEqual(['2026-01', '2026-02'])
  })

  it('ends a session whose months cannot be kept', async () => {
    authEnv()
    const t = newT()
    const f = await withOrg(t)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const token = uuid()
    // A creation time that is not a time makes keeping its months throw.
    await runInAuth(t, async (ctx) => {
      await ctx.db.insert('session', {
        token,
        userId: f.user.auth_user_id as string,
        createdAt: Number.NaN,
        updatedAt: Date.parse('2026-03-03'),
        expiresAt: RUN + 86_400_000,
      })
    })
    await internalAdapter(t).deleteSession(token)
    expect(await sessions(t)).toEqual([])
    expect(await kept(t)).toEqual([])
    expect(error).toHaveBeenCalledWith('[usage] sign-in not kept', expect.anything())
  })

  it('forgets the months of a login Better Auth deletes', async () => {
    authEnv()
    const t = newT()
    const userId = await login(t, 'leaving@test.local')
    await t.run(async (ctx) => {
      await ctx.db.insert('usage_sign_ins', { auth_user_id: userId, month: '2026-02' })
    })
    await runInAuth(t, async (ctx) => {
      await ctx.db.insert('session', {
        token: uuid(),
        userId,
        createdAt: Date.parse('2026-03-02'),
        updatedAt: Date.parse('2026-03-03'),
        expiresAt: RUN + 86_400_000,
      })
    })
    // Its session ends first and keeps March, then the login goes with both.
    await internalAdapter(t).deleteUser(userId)
    expect(await sessions(t)).toEqual([])
    expect(await kept(t)).toEqual([])
  })

  const signedInIds = async (t: T, f: OrgFixture) =>
    (await t.query(internal.usage.profiles, { org_id: f.org.id, month: MARCH, cursor: null }))
      .active

  it('counts a sign-in only on an active seat the login held in the month', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const p of [f.user, f.viewer, f.admin]) await session(t, p, '2026-03-02', '2026-03-03')
    await t.run(async (ctx) => {
      await ctx.db.patch(f.viewer._id, { active: false })
      // claimed after March ended
      await ctx.db.patch(f.admin._id, { accepted_at: iso('2026-04-01T01:00:00Z') })
    })
    expect(await signedInIds(t, f)).toEqual([f.user.id])
  })

  it('reads every session of a login to find one of the month', async () => {
    const t = newT()
    const f = await withOrg(t)
    await session(t, f.user, '2026-03-02', '2026-03-03')
    // More sessions created after March than a profiles page and one more
    // page read, so the check goes on page by page.
    for (let i = 0; i < 260; i++)
      await session(t, f.user, '2026-04-01T01:00:00Z', '2026-04-01T02:00:00Z')
    expect(await signedInIds(t, f)).toEqual([])
    const usage = await orgUsage(runner(t), f.org.id, MARCH, Date.now())
    expect(usage?.people.find((p) => p.profile_id === f.user.id)?.signed_in).toBe(true)
    expect(usage?.counts.active_people).toBe(1)
  })
})

describe('retention and deletion', () => {
  it('deletes rows of months older than 800 days, page by page', async () => {
    const t = newT()
    const f = await withOrg(t)
    // 800 days before RUN is in January 2024, so December 2023 goes.
    await t.run(async (ctx) => {
      for (const month of ['2023-11', '2023-12', '2024-01', MARCH]) {
        await ctx.db.insert('usage_sign_ins', { auth_user_id: 'login', month })
        await ctx.db.insert('usage_runs', { month, seen_at: Date.parse(`${month}-01`) })
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
      sign_ins: (await ctx.db.query('usage_sign_ins').collect()).map((row) => row.month).sort(),
      runs: (await ctx.db.query('usage_runs').collect()).map((row) => row.month).sort(),
    }))
    expect(left).toEqual({
      months: ['2024-01', MARCH],
      counts: ['2024-01', MARCH],
      sign_ins: ['2024-01', MARCH],
      runs: ['2024-01', MARCH],
    })
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
    // The organization's counts, beside the month's account background total.
    const orgCounts = (t: T) =>
      t.run(async (ctx) =>
        (await ctx.db.query('usage_counts').collect()).filter((row) => row.org_id !== undefined),
      )
    const before = await orgCounts(t)
    expect(before.map((row) => [row.metric, row.count])).toEqual([['mail_invitations', 1]])
    await t.mutation(internal.orgRemovals.step, { org_id: f.org.id })
    await runSteps(t)
    const left = await t.run(async (ctx) => ({
      org: await ctx.db.query('organizations').collect(),
      months: await ctx.db.query('usage_months').collect(),
    }))
    expect(left.org.map((org) => org.id)).toEqual([f.otherOrg.id])
    expect(left.months.map((row) => row.org_id)).toEqual([f.otherOrg.id])
    expect(await orgCounts(t)).toEqual([])
  })

  it('goes with an organization a fixture deletes at once', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.action(internal.usage.closeMonth, { month: MARCH })
    await runSteps(t)
    await t.run(async (ctx) => {
      for (const org_id of [f.org.id, f.otherOrg.id])
        await ctx.db.insert('usage_counts', {
          org_id,
          month: MARCH,
          metric: 'mail_invitations',
          count: 1,
        })
      await deleteOrgDeep(ctx, f.org)
    })
    const left = await t.run(async (ctx) => ({
      months: (await ctx.db.query('usage_months').collect()).map((row) => row.org_id),
      counts: (await ctx.db.query('usage_counts').collect())
        .filter((row) => row.org_id !== undefined)
        .map((row) => row.org_id),
    }))
    expect(left).toEqual({ months: [f.otherOrg.id], counts: [f.otherOrg.id] })
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
    expect(march.unattributed.background_bytes).toBe(59)
    const april = await op.action(api.usage.monthTable, { month: '2026-04' })
    expect(april.current).toBe(true)
    expect(april.unattributed.background_bytes).toBe(59)
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
    const { months, current_failed } = await op.action(api.usage.orgMonths, { org_id: f.org.id })
    expect(months.map((m) => m.month)).toEqual([MARCH, '2026-04'])
    expect(current_failed).toBe(false)
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

  it('names an organization whose current month fails and shows the rest', async () => {
    const t = newT()
    const f = await withOrg(t)
    const op = await operator(t)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.action(internal.usage.closeMonth, { month: MARCH })
    await runSteps(t)
    // Two rows for one count make that organization's reads fail.
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i++)
        await ctx.db.insert('usage_counts', {
          org_id: f.org.id,
          month: '2026-04',
          metric: 'mail_invitations',
          count: 1,
        })
    })
    const april = await op.action(api.usage.monthTable, { month: '2026-04' })
    expect(april.rows.map((row) => row.org_id)).toEqual([f.otherOrg.id])
    expect(april.failed).toEqual([{ org_id: f.org.id, name: 'Testbed Labs' }])
    const { months, current_failed } = await op.action(api.usage.orgMonths, { org_id: f.org.id })
    expect(months.map((m) => m.month)).toEqual([MARCH])
    expect(current_failed).toBe(true)
  })

  it('says how a month was stored, and marks one whose counting began during it', async () => {
    const t = newT()
    await withOrg(t)
    const op = await operator(t)
    // The job first ran on 1 February: January is partial, February whole.
    vi.setSystemTime(Date.parse('2026-02-01T05:15:00Z'))
    await t.action(internal.usage.closeMonth, {})
    await runSteps(t)
    vi.setSystemTime(Date.parse('2026-03-01T05:15:00Z'))
    await t.action(internal.usage.closeMonth, {})
    await runSteps(t)
    const status = async (month: string) =>
      (await op.action(api.usage.monthTable, { month })).status
    expect(await status('2026-01')).toEqual({
      partial: true,
      run: { saved: 2, failed: 0, finished_at: '2026-02-01T05:15:00.000Z' },
    })
    expect(await status('2026-02')).toMatchObject({ partial: false, run: { saved: 2 } })
    expect(await status('2026-03')).toEqual({ partial: false, run: null })
    const { months } = await op.action(api.usage.orgMonths, {
      org_id: (await t.run((ctx) => ctx.db.query('organizations').first()))?.id as string,
    })
    expect(months.map((m) => [m.month, m.partial])).toEqual([
      ['2026-01', true],
      ['2026-02', false],
      ['2026-03', false],
    ])
  })
})

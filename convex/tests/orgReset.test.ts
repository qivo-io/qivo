/* The operator's one-time organization reset (internal/orgReset.ts): the
 * paged listing and the deletion of one organization through the existing
 * deletion steps. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { ORG_RESET, RESET_ACTOR } from '../internal/orgReset'
import {
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  type T,
  uuid,
  withReadingAdmin,
} from './helpers.setup'
import { assertNoDanglingRefs } from './refs.setup'

const DEFAULTS = { ...ORG_RESET }
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubEnv('BILLING_ENABLED', 'false')
})
afterEach(() => {
  Object.assign(ORG_RESET, DEFAULTS)
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

const runSteps = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimers())

const list = (t: T, cursor: string | null = null) =>
  t.query(internal.internal.orgReset.orgs, { cursor })

const remove = (t: T, a: { org_id: string; confirm: string; allow_fixture?: boolean }) =>
  t.mutation(internal.internal.orgReset.deleteOrg, a)

/* Counts of the rows an organization owns, by table. */
const orgRows = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const counts: Record<string, number> = {}
    for (const table of [
      'organizations',
      'profiles',
      'issues',
      'projects',
      'teams',
      'activity_events',
      'org_counters',
      'org_removals',
      'billing_notices',
    ] as const)
      counts[table] = (await ctx.db.query(table).collect()).filter((row) =>
        table === 'organizations'
          ? (row as Doc<'organizations'>).id === orgId
          : (row as { org_id?: string }).org_id === orgId,
      ).length
    return counts
  })

/* Both fixture organizations with a few tasks each. */
async function scene(t: T) {
  const f = await withReadingAdmin(t)
  const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
  await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: parent.id })
  await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
  return f
}

/* The Northstar fixture's receipt naming `f`'s organization. */
const receipt = (t: T, f: OrgFixture) =>
  t.run((ctx) =>
    ctx.db.insert('marketing_demo', {
      key: 'northstar',
      org_id: f.org.id,
      auth_ids: {},
      credential_set_id: uuid(),
      state: 'ready',
      version: 1,
      created_at: NOW,
      updated_at: NOW,
    }),
  )

/* A stored subscription of `f`'s organization. */
const subscribe = (t: T, f: OrgFixture, extra: Partial<Doc<'billing_subscriptions'>>) =>
  t.run((ctx) =>
    ctx.db.insert('billing_subscriptions', {
      id: uuid(),
      org_id: f.org.id,
      plan_id: uuid(),
      status: 'pending',
      billed_seats: 5,
      next_seats: 5,
      cancel_at_period_end: false,
      created_at: NOW,
      updated_at: NOW,
      ...extra,
    }),
  )

const audits = (t: T) => t.run((ctx) => ctx.db.query('platform_audit_log').collect())

describe('the operator listing of organizations', () => {
  it('lists every organization a page at a time with its counts and no personal data', async () => {
    const t = newT()
    const f = await scene(t)
    await receipt(t, f)
    ORG_RESET.page = 1
    const first = await list(t)
    expect(first.cursor).not.toBeNull()
    const second = await list(t, first.cursor)
    expect(second.cursor).toBeNull()
    const rows = [...first.orgs, ...second.orgs]
    expect(rows.map((row) => row.slug).sort()).toEqual(['other', 'testbed'])
    // no stored count in the fixture, so the projects and tasks are read
    expect(rows.find((row) => row.id === f.org.id)).toEqual({
      id: f.org.id,
      name: 'Testbed Labs',
      slug: 'testbed',
      created_at: NOW,
      people: { count: 5, capped: false },
      projects: { count: 4, capped: false },
      active_tasks: { count: 2, capped: false },
      fixture: true,
      deletion: null,
      billing: { enabled: false, live_subscription: false, open_checkout: false },
    })
    expect(rows.find((row) => row.id === f.otherOrg.id)).toMatchObject({
      people: { count: 1, capped: false },
      active_tasks: { count: 1, capped: false },
      fixture: false,
    })
    expect(JSON.stringify(rows)).not.toMatch(/@/)

    // a stored count answers instead, and a read past its budget says so
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('org_counters')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique()
      if (row) await ctx.db.patch(row._id, { active_tasks: 812, live_projects: 40 })
    })
    Object.assign(ORG_RESET, { page: 5, people: 2 })
    const capped = (await list(t)).orgs.find((row) => row.id === f.org.id)
    expect(capped).toMatchObject({
      people: { count: 2, capped: true },
      projects: { count: 40, capped: false },
      active_tasks: { count: 812, capped: false },
    })
  })
})

describe("the operator's deletion of one organization", () => {
  it('deletes the organization whole through the steps while the other keeps every row', async () => {
    const t = newT()
    const f = await scene(t)
    const others = await orgRows(t, f.otherOrg.id)
    expect((await orgRows(t, f.org.id)).issues).toBe(2)

    const started = await remove(t, { org_id: f.org.id, confirm: 'Testbed ' })
    expect(started).toEqual({ state: 'started', delete_after: NOW })
    expect(await audits(t)).toMatchObject([
      {
        actor_email: RESET_ACTOR,
        action: 'org.deletion_requested',
        target_org_id: f.org.id,
        detail: { delete_after: NOW },
      },
    ])
    expect((await list(t)).orgs.find((row) => row.id === f.org.id)?.deletion).toEqual({
      reason: 'requested',
      phase: 'profiles',
      delete_after: NOW,
    })
    // a second call while it runs answers that, and writes nothing more
    expect(await remove(t, { org_id: f.org.id, confirm: 'testbed' })).toEqual({
      state: 'running',
      phase: 'profiles',
    })
    expect(await audits(t)).toHaveLength(1)

    await runSteps(t)
    expect(Object.values(await orgRows(t, f.org.id)).every((n) => n === 0)).toBe(true)
    expect(await orgRows(t, f.otherOrg.id)).toEqual(others)
    expect((await list(t)).orgs.map((row) => row.id)).toEqual([f.otherOrg.id])
    await assertNoDanglingRefs(t, 'operator organization deletion')
    // once it is gone the organization is unknown
    await expectRefusal(remove(t, { org_id: f.org.id, confirm: 'testbed' }), 'not_found')
  })

  it('refuses a wrong address, an unknown organization and the fixture without the flag', async () => {
    const t = newT()
    const f = await scene(t)
    await receipt(t, f)
    const before = await orgRows(t, f.org.id)
    await expectRefusal(remove(t, { org_id: f.org.id, confirm: 'other' }), 'rule', /address/)
    await expectRefusal(remove(t, { org_id: uuid(), confirm: 'testbed' }), 'not_found')
    await expectRefusal(
      remove(t, { org_id: f.org.id, confirm: 'testbed' }),
      'rule',
      /allow_fixture/,
    )
    await runSteps(t)
    expect(await orgRows(t, f.org.id)).toEqual(before)
    expect(await audits(t)).toEqual([])
    // the flag lets the fixture's organization go
    expect(
      await remove(t, { org_id: f.org.id, confirm: 'testbed', allow_fixture: true }),
    ).toMatchObject({ state: 'started' })
    // and its receipt goes with it, so a later seed provisions a new one
    await runSteps(t)
    expect(await t.run((ctx) => ctx.db.query('marketing_demo').collect())).toEqual([])
  })

  it('refuses a live paid subscription or an open checkout while billing runs, and cancels nothing', async () => {
    const t = newT()
    const f = await scene(t)
    const sub = await subscribe(t, f, {
      status: 'active',
      polar_subscription_id: uuid(),
      current_period_end: '2026-12-18T00:00:00.000Z',
    })
    // without billing the stored record does not hold it back
    expect((await list(t)).orgs.find((row) => row.id === f.org.id)?.billing).toEqual({
      enabled: false,
      live_subscription: true,
      open_checkout: false,
    })
    vi.stubEnv('BILLING_ENABLED', 'true')
    vi.stubEnv('APP_MODE', '')
    await expectRefusal(
      remove(t, { org_id: f.org.id, confirm: 'testbed' }),
      'rule',
      /Polar subscription that bills or can still bill/,
    )
    await t.run((ctx) =>
      ctx.db.patch(sub, {
        status: 'canceled',
        ended_at: NOW,
        checkout_id: uuid(),
      }),
    )
    await expectRefusal(
      remove(t, { org_id: f.org.id, confirm: 'testbed' }),
      'rule',
      /open checkout/,
    )
    expect(await t.run((ctx) => ctx.db.get(sub))).toMatchObject({ status: 'canceled' })
    expect((await orgRows(t, f.org.id)).org_removals).toBe(0)
    // an ended subscription without a checkout lets it go
    await t.run((ctx) => ctx.db.patch(sub, { checkout_id: undefined }))
    expect(await remove(t, { org_id: f.org.id, confirm: 'testbed' })).toMatchObject({
      state: 'started',
    })
  })

  it('refuses a pending Polar subscription, which can still complete and bill', async () => {
    const t = newT()
    const f = await scene(t)
    // billingSync.ts stores Polar's `incomplete` as `pending` and clears the
    // checkout, so only the provider id tells it from a checkout's start
    await subscribe(t, f, { status: 'pending', polar_subscription_id: uuid() })
    vi.stubEnv('BILLING_ENABLED', 'true')
    vi.stubEnv('APP_MODE', '')
    expect((await list(t)).orgs.find((row) => row.id === f.org.id)?.billing).toEqual({
      enabled: true,
      live_subscription: true,
      open_checkout: false,
    })
    const before = await orgRows(t, f.org.id)
    await expectRefusal(
      remove(t, { org_id: f.org.id, confirm: 'testbed' }),
      'rule',
      /Polar subscription that bills or can still bill/,
    )
    await runSteps(t)
    expect(await orgRows(t, f.org.id)).toEqual(before)
    expect(await audits(t)).toEqual([])
  })

  it('brings a pending removal forward instead of adding a second', async () => {
    const t = newT()
    const f = await scene(t)
    await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'service_ended',
        ended_at: NOW,
        delete_after: '2026-12-18T12:00:00.000Z',
        created_at: NOW,
      }),
    )
    expect(await remove(t, { org_id: f.org.id, confirm: 'testbed' })).toEqual({
      state: 'started',
      delete_after: NOW,
    })
    const removals = await t.run((ctx) => ctx.db.query('org_removals').collect())
    expect(removals).toMatchObject([{ reason: 'requested', delete_after: NOW, phase: 'profiles' }])
    await runSteps(t)
    expect((await orgRows(t, f.org.id)).organizations).toBe(0)
  })
})

/* internal/orgCountersBackfill, the one-time pass that moves organizations
 * created before org_counters off their legacy fields. The fixtures insert that older state directly. The steps run when
 * the test fires the fake timers. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { countersFor, NOW, newT, type T, withOrg } from './helpers.setup'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const backfill = internal.internal.orgCountersBackfill

/* Runs every scheduled function, and anything they schedule, to completion. */
const runSteps = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimers())

const orgRow = (t: T, org: Doc<'organizations'>) =>
  t.run(async (ctx) => (await ctx.db.get(org._id)) as Doc<'organizations'>)

/* The organization's activity_retention rows without system fields. */
const retention = (t: T, orgId: string) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('activity_retention')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect()
    ).map(({ _id, _creationTime, ...row }) => row),
  )

/* Every remaining page, summed. */
async function remaining(t: T): Promise<number> {
  let total = 0
  let cursor: string | undefined
  for (let guard = 0; guard < 100; guard++) {
    const page = await t.query(backfill.remaining, cursor === undefined ? {} : { cursor })
    total += page.remaining
    if (page.isDone) return total
    cursor = page.cursor
  }
  throw new Error('remaining did not finish')
}

describe('orgCountersBackfill', () => {
  it('moves legacy counters, keeps migrated ones, and a second run changes nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    // Testbed: legacy counters (1, 5) and a legacy activity_count.
    // Other: legacy counters (1, 2) and an org_counters row already holding
    // newer values, as a migration followed by a stale legacy field would.
    // Third: legacy counters only, no activity yet.
    const third = await t.run(async (ctx) => {
      await ctx.db.patch(f.org._id, { activity_count: 500 })
      await ctx.db.insert('org_counters', {
        org_id: f.otherOrg.id,
        next_issue_num: 40,
        next_project_num: 7,
      })
      const _id = await ctx.db.insert('organizations', {
        id: 'third-org',
        name: 'Third',
        slug: 'third',
        created_at: NOW,
        next_issue_num: 12,
        next_project_num: 3,
        date_format: 'iso',
        week_start: 1,
        week_one_rule: 'first4day',
        default_plannable_hours: 40,
      })
      return (await ctx.db.get(_id)) as Doc<'organizations'>
    })
    expect(await remaining(t)).toBe(3)
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})

    // A page of one organization makes the run take three scheduled steps.
    await t.mutation(backfill.start, { page: 1 })
    await runSteps(t)

    expect(await countersFor(t, f.org.id)).toEqual({ next_issue_num: 1, next_project_num: 5 })
    expect(await countersFor(t, f.otherOrg.id)).toEqual({ next_issue_num: 40, next_project_num: 7 })
    expect(await countersFor(t, third.id)).toEqual({ next_issue_num: 12, next_project_num: 3 })
    for (const org of [f.org, f.otherOrg, third]) {
      const row = await orgRow(t, org)
      expect(row.next_issue_num, org.slug).toBeUndefined()
      expect(row.next_project_num, org.slug).toBeUndefined()
      expect(row.activity_count, org.slug).toBeUndefined()
      // and creates no activity retention row any more
      expect(await retention(t, org.id)).toEqual([])
    }
    expect(await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ name: 'activityRetention:trim' })]),
    )
    expect(log).toHaveBeenCalledWith('Org counters backfill done', { orgs: 3, changed: 3 })
    expect(await remaining(t)).toBe(0)

    const before = await t.run(async (ctx) => ({
      orgs: await ctx.db.query('organizations').collect(),
      counters: await ctx.db.query('org_counters').collect(),
      retention: await ctx.db.query('activity_retention').collect(),
    }))
    log.mockClear()
    await t.mutation(backfill.start, {})
    await runSteps(t)
    expect(log).toHaveBeenCalledWith('Org counters backfill done', { orgs: 3, changed: 0 })
    expect(
      await t.run(async (ctx) => ({
        orgs: await ctx.db.query('organizations').collect(),
        counters: await ctx.db.query('org_counters').collect(),
        retention: await ctx.db.query('activity_retention').collect(),
      })),
    ).toEqual(before)
  })
})

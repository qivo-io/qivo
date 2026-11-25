/* The Overview's Needs attention list (overview.ts needs,
 * lib/overviewNeeds.ts): its kinds and ranking, its counts beside the
 * Overview's other reads, what a reader who may not read every owner's
 * work sees, what hidden projects may move, its fail-safe answers past a
 * lowered budget, and its reads at the design size under Convex's
 * transaction limits. */

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { OVERVIEW, readHealth } from '../lib/overview'
import { NEEDS, type NeedsAnswer, type NeedsFilter, readNeeds } from '../lib/overviewNeeds'
import { OWNER_LOADS } from '../lib/ownerLoads'
import { plantTasks } from './board.setup'
import {
  as,
  newT,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withReadingAdmin,
} from './helpers.setup'
import {
  DAY,
  measured,
  mixOf,
  PLANTED_AT,
  plantMix,
  plantPeople,
  plantShared,
  shift,
  weeksOf,
} from './overview.setup'
import { countOrg } from './overviewCounts.setup'
import { withReach } from './projectReach.setup'
import { plantBlocks } from './teamSyncAgenda.setup'

process.env.BETTER_AUTH_SECRET ??= 'overview-needs-test-secret-not-a-deployment-key'

const DEFAULT_OVERVIEW = structuredClone(OVERVIEW)
const DEFAULT_NEEDS = structuredClone(NEEDS)
const DEFAULT_OWNER_LOADS = structuredClone(OWNER_LOADS)
afterEach(() => {
  Object.assign(OVERVIEW, structuredClone(DEFAULT_OVERVIEW))
  Object.assign(NEEDS, structuredClone(DEFAULT_NEEDS))
  Object.assign(OWNER_LOADS, structuredClone(DEFAULT_OWNER_LOADS))
})

const WEEKS = weeksOf(DAY)

/** The list of `project` for `me`: `kind`, the first `limit` rows. */
const needsOf = (
  t: T,
  me: Doc<'profiles'>,
  project: Doc<'projects'>,
  kind: NeedsFilter = 'all',
  limit = NEEDS.first,
) =>
  as(t, me).query(api.overview.needs, {
    scope: { org_id: me.org_id, project_id: project.id },
    ...WEEKS,
    kind,
    limit,
  })

function okOf(answer: NeedsAnswer): Extract<NeedsAnswer, { state: 'ok' }> {
  if (answer.state !== 'ok') throw new Error(JSON.stringify(answer))
  return answer
}

const titles = (answer: NeedsAnswer) => okOf(answer).rows.map((r) => r.title)

/** withReadingAdmin with FW tracking delay and, in FW, a task of every
 * kind, each with an owner of its own so no projection moves another:
 *
 * - Review spec, In Review with no reviewer, 5 days overdue
 * - Order parts, 2 days overdue, blocking Wire harness and Fit enclosure
 * - Port driver, 200 hours from this week at 40 a week, due next week
 * - Tune loop, 80 hours from this week, due this week
 * - Write tests, planned to end this week with 80 hours left, no due date
 * - Wire harness, To do, blocked by Order parts, no due date
 * - Fit enclosure, To do, paused, blocked by Order parts, due in 5 days
 * - Calibrate, To do, paused, due in 20 days
 *
 * and three that need nothing: an In Review task with a reviewer, a Done
 * task 3 days past its due date, and a task blocked only by a Done one. */
async function kindsCase() {
  const t = newT()
  const f = await withReadingAdmin(t)
  await t.run((ctx) => ctx.db.patch(f.sub._id, { track_delay: true }))
  const owner = (name: string) =>
    plantSeat(t, {
      org_id: f.org.id,
      name,
      auth_user_id: `auth_${uuid()}`,
      accepted_at: PLANTED_AT,
    })
  const [p1, p2, p3, p4, p5] = [
    await owner('Ana'),
    await owner('Ben'),
    await owner('Cai'),
    await owner('Dee'),
    await owner('Eli'),
  ]
  const task = (title: string, fields: Partial<Doc<'issues'>> = {}) =>
    plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title, assignee_id: p5.id, ...fields })
  const planned = (hours: number) => ({
    start_week: DAY,
    end_week: DAY,
    remaining_hours: hours,
    remaining_set_at: `${DAY}T12:00:00.000Z`,
  })
  await task('Review spec', { status: 'review', due_date: shift(DAY, -5), assignee_id: p1.id })
  const order = await task('Order parts', { due_date: shift(DAY, -2), assignee_id: p2.id })
  await task('Port driver', {
    ...planned(200),
    end_week: shift(DAY, 7),
    due_date: shift(DAY, 8),
    assignee_id: f.user.id,
  })
  await task('Tune loop', { ...planned(80), due_date: shift(DAY, 3), assignee_id: f.admin.id })
  await task('Write tests', { ...planned(80), assignee_id: p3.id })
  const wire = await task('Wire harness', { assignee_id: p4.id })
  const fit = await task('Fit enclosure', { paused: true, due_date: shift(DAY, 5) })
  await task('Calibrate', { paused: true, due_date: shift(DAY, 20) })
  await task('Reviewed', { status: 'review', reviewer_id: p4.id })
  const done = await task('Shipped', {
    status: 'done',
    due_date: shift(DAY, -3),
    done_at: PLANTED_AT,
  })
  const after = await task('Unblocked')
  await plantBlocks(t, [
    [order, wire],
    [order, fit],
    [done, after],
  ])
  await withReach(t)
  await countOrg(t, f.org.id)
  return { t, f, wire, fit, people: { p1, p2, p3, p4, p5 } }
}

describe('kinds and ranking', () => {
  it('ranks every kind by its rule, lists a task once under its most urgent kind and names the others', async () => {
    const { t, f, fit, people } = await kindsCase()
    const got = okOf(await needsOf(t, f.user, f.meta))
    expect(got.rows.map((r) => [r.title, r.needs.kind, r.needs.also])).toEqual([
      ['Review spec', 'overdue', ['no_reviewer']],
      ['Order parts', 'overdue', []],
      ['Port driver', 'projected', []],
      ['Tune loop', 'projected', []],
      ['Write tests', 'behind', []],
      ['Fit enclosure', 'blocked', ['paused']],
      ['Wire harness', 'blocked', []],
      ['Calibrate', 'paused', []],
    ])
    expect(got.counts).toEqual({
      overdue: 2,
      blocked: 2,
      no_reviewer: 1,
      paused: 2,
      projected: { state: 'ok', count: 2 },
      behind: { state: 'ok', count: 1 },
      all: { state: 'ok', count: 8 },
    })
    const row = (title: string) => got.rows.find((r) => r.title === title)?.needs
    expect(row('Order parts')?.blocks).toEqual({
      count: 2,
      first: { id: fit.id, title: 'Fit enclosure' },
    })
    expect(row('Fit enclosure')?.blocked_by).toBe(1)
    // 200 hours at 40 a week from this week end in week 4, three weeks past the due week
    expect(row('Port driver')?.finish_week).toBe(shift(DAY, 28))
    expect(row('Write tests')?.finish_week).toBe(shift(DAY, 7))
    expect(got.tracks_delay).toBe(true)
    // the owners of open work, with how many listed tasks are theirs
    const listed = new Map(got.people.map((p) => [p.id, p.listed]))
    expect(listed.get(people.p5.id)).toBe(2)
    expect(listed.get(people.p4.id)).toBe(1)
    expect(listed.get(people.p2.id)).toBe(1)
  })

  it('answers one kind, the first rows asked, with every count and the kind its total', async () => {
    const { t, f } = await kindsCase()
    expect(titles(await needsOf(t, f.user, f.meta, 'paused'))).toEqual([
      'Fit enclosure',
      'Calibrate',
    ])
    expect(titles(await needsOf(t, f.user, f.meta, 'no_reviewer'))).toEqual(['Review spec'])
    const cut = okOf(await needsOf(t, f.user, f.meta, 'all', 3))
    expect(cut.rows.map((r) => r.title)).toEqual(['Review spec', 'Order parts', 'Port driver'])
    expect(cut.total).toBe(8)
    expect(cut.counts.paused).toBe(2)
  })

  it('lists the Late tasks by due date for the milestones, and a project without delay tracking has none', async () => {
    const { t, f } = await kindsCase()
    expect(okOf(await needsOf(t, f.user, f.meta)).late_due).toEqual({
      state: 'ok',
      days: [
        { due: shift(DAY, -5), count: 1 },
        { due: shift(DAY, -2), count: 1 },
        { due: shift(DAY, 3), count: 1 },
        { due: shift(DAY, 8), count: 1 },
      ],
    })
    await t.run((ctx) => ctx.db.patch(f.sub._id, { track_delay: false }))
    const off = okOf(await needsOf(t, f.user, f.meta))
    expect(off.late_due).toEqual({ state: 'ok', days: [] })
    expect(off.counts.projected).toEqual({ state: 'ok', count: 0 })
    expect(off.counts.overdue).toBe(2)
    expect(off.tracks_delay).toBe(false)
  })
})

describe('beside the other reads', () => {
  it('counts Overdue as the summary, Projected to miss as the delays and Behind plan as the health table, groups included', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.sub._id, { track_delay: true })
      await ctx.db.patch(f.sub2._id, { track_delay: true })
    })
    const owners = [f.user, f.admin, ...(await plantPeople(t, f.org.id, 3))]
    await plantMix(t, f.sub, 60, owners, PLANTED_AT)
    await plantMix(t, f.sub2, 40, owners, PLANTED_AT, true)
    await withReach(t)
    await countOrg(t, f.org.id)
    const scope = { kind: 'project' as const, org_id: f.org.id, project_id: f.meta.id }
    const caller = as(t, f.user)
    const summary = await caller.query(api.overview.summary, { scope, day: DAY })
    const risk = await caller.query(api.overview.risk, { scope, ...WEEKS })
    const health = await caller.query(api.overview.health, {
      scope,
      ...WEEKS,
      sort: 'name',
      dir: 'asc',
      limit: 10,
    })
    const got = okOf(await needsOf(t, f.user, f.meta))
    if (summary.state !== 'ok' || risk.state !== 'ok' || health.state !== 'ok')
      throw new Error('a read refused')
    if (summary.overdue.state !== 'ok' || risk.projected.state !== 'ok')
      throw new Error('a figure is missing')
    let behind = 0
    for (const row of health.rows) if (row.delays.state === 'ok') behind += row.delays.behind
    expect(got.counts.overdue).toBe(summary.overdue.count)
    expect(got.counts.projected).toEqual({ state: 'ok', count: risk.projected.count })
    expect(got.counts.behind).toEqual({ state: 'ok', count: behind })
    // the mix holds every kind the stored facts give
    expect(got.counts.overdue).toBeGreaterThan(0)
    expect(got.counts.paused).toBeGreaterThan(0)
  })
})

describe('access', () => {
  it("reads unknown, never zero, where a verdict needs an owner's load the reader may not read", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    await t.run((ctx) => ctx.db.patch(f.sub._id, { track_delay: true }))
    const guest = await plantSeat(t, {
      org_id: f.org.id,
      org_role: 'guest',
      auth_user_id: `auth_${uuid()}`,
    })
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: guest.id,
        level: 'user',
      }),
    )
    const late = (title: string, owner: Doc<'profiles'>) =>
      plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        title,
        assignee_id: owner.id,
        start_week: DAY,
        end_week: shift(DAY, 7),
        due_date: shift(DAY, 10),
        remaining_hours: 200,
        remaining_set_at: `${DAY}T12:00:00.000Z`,
      })
    await late('Too big for one week', f.user)
    await late('Too big for its owner too', f.admin)
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Past due',
      due_date: shift(DAY, -1),
    })
    await withReach(t)
    await countOrg(t, f.org.id)
    const theirs = okOf(await needsOf(t, guest, f.sub))
    expect(theirs.counts.projected).toEqual({ state: 'unavailable', reason: 'loads' })
    expect(theirs.counts.behind).toEqual({ state: 'unavailable', reason: 'loads' })
    expect(theirs.counts.all).toEqual({ state: 'unavailable', reason: 'loads' })
    expect(theirs.late_due).toEqual({ state: 'unavailable', reason: 'loads' })
    expect(theirs.counts.overdue).toBe(1)
    expect(titles(theirs)).toContain('Past due')
    // staff read both owners
    const staff = okOf(await needsOf(t, f.user, f.sub))
    expect(staff.counts.projected).toEqual({ state: 'ok', count: 2 })
  })

  it('counts no blocker in a project the reader cannot see, and refuses a scope the reader does not hold', async () => {
    const { t, f, wire } = await kindsCase()
    const secret = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
      name: 'Secret',
    })
    const blocker = await plantIssue(t, {
      org_id: f.org.id,
      project_id: secret.id,
      title: 'Secret blocker',
    })
    const lone = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Held up' })
    await plantBlocks(t, [[blocker, lone]])
    await withReach(t)
    const blocked = (answer: NeedsAnswer) =>
      okOf(answer)
        .rows.filter((r) => r.needs.kind === 'blocked')
        .map((r) => r.title)
    // the admin reads the hidden project, the guest does not
    expect(blocked(await needsOf(t, f.admin, f.meta))).toContain('Held up')
    expect(blocked(await needsOf(t, f.guest, f.meta))).not.toContain('Held up')
    expect(blocked(await needsOf(t, f.guest, f.meta))).toContain(wire.title)
    expect(await needsOf(t, f.guest, f.hidden)).toEqual({ state: 'unavailable' })
  })
})

describe('past a lowered budget', () => {
  it('answers the verdict counts unavailable where the loads do not fit, and over_budget where the tasks do not', async () => {
    const { t, f } = await kindsCase()
    Object.assign(OWNER_LOADS, { open: 0 })
    const thin = okOf(await needsOf(t, f.user, f.meta))
    expect(thin.counts.projected.state).toBe('unavailable')
    expect(thin.counts.all.state).toBe('unavailable')
    expect(thin.counts.overdue).toBe(2)
    expect(thin.counts.blocked).toBe(2)
    Object.assign(OVERVIEW, { reads: { ...OVERVIEW.reads, ranges: 20 } })
    expect(await needsOf(t, f.user, f.meta)).toEqual({ state: 'over_budget' })
  })
})

// --------------------------------------------------------------- real limits

/* What one read took, logged. */
function record(
  label: string,
  took: { ranges: number; documents: number; mib: number },
  ms: number,
  answer: NeedsAnswer,
) {
  const ok = okOf(answer)
  console.log(
    `needs reads, ${label}: ${JSON.stringify(took)} in ${ms} ms ${JSON.stringify({
      total: ok.total,
      counts: ok.counts,
      people: ok.people.length,
    })}`,
  )
}

/** mixOf with every leaf open, as the health table's real-limit cases plant it. */
function openMix(...args: Parameters<typeof mixOf>): ReturnType<typeof mixOf> {
  const fields = mixOf(...args)
  if (fields.status !== 'done') return fields
  const { done_at: _done, ...rest } = fields
  const [i, , kind] = args
  return {
    ...rest,
    status: kind === 'parent' ? 'progress' : 'todo',
    ...(rest.start_week !== undefined ? { remaining_hours: ((i % 16) + 1) / 2 } : {}),
  }
}

/** `n` open tasks of the mix in `project`, owned in turn by `owners`, every
 * fifth plain task blocked by the one before it. */
async function plantOpen(
  t: T,
  project: Doc<'projects'>,
  n: number,
  owners: readonly Doc<'profiles'>[],
) {
  const parents = await plantTasks(t, project, Math.round(n / 10), (i) =>
    openMix(i, owners, 'parent', PLANTED_AT),
  )
  const plain = await plantTasks(t, project, n - 3 * parents.length, (i) =>
    openMix(i, owners, 'plain', PLANTED_AT),
  )
  await plantTasks(t, project, 2 * parents.length, (i) => ({
    ...openMix(i + 3, owners, 'subtask', PLANTED_AT),
    parent_id: (parents[Math.floor(i / 2)] as Doc<'issues'>).id,
  }))
  const pairs: [Doc<'issues'>, Doc<'issues'>][] = []
  for (let i = 5; i < plain.length; i += 5)
    pairs.push([plain[i - 1] as Doc<'issues'>, plain[i] as Doc<'issues'>])
  await plantBlocks(t, pairs)
}

/** A staff reader in three teams sharing one top-level project of `subs`
 * sub-projects that track delay, and 10 owners. */
async function sharedCase(subs: number) {
  const t = newT({ transactionLimits: true })
  const f = await withReadingAdmin(t)
  const me = await plantSeat(t, {
    org_id: f.org.id,
    org_role: 'user',
    auth_user_id: `auth_${uuid()}`,
    accepted_at: PLANTED_AT,
  })
  const owners = [me, ...(await plantPeople(t, f.org.id, 9))]
  const planted = await plantShared(t, f.org.id, f.user, me, { tops: 1, subs })
  return { t, f, me, owners, top: planted.tops[0] as Doc<'projects'>, subs: planted.subs }
}

/** The list of `top` for `me` inside one transaction, what it took and how long. */
async function readMeasured(t: T, me: Doc<'profiles'>, top: Doc<'projects'>, label: string) {
  const started = Date.now()
  const got = await measured(t, (ctx) =>
    readNeeds(ctx, new Map([[me.org_id, me]]), {
      scope: { org_id: me.org_id, project_id: top.id },
      ...WEEKS,
      kind: 'all',
      limit: NEEDS.first,
    }),
  )
  record(label, got.took, Date.now() - started, got.answer)
  return got
}

describe('real limits', () => {
  it('reads a project of 3 sub-projects with 800 open tasks whole', async () => {
    const c = await sharedCase(3)
    for (const [i, sub] of c.subs.entries())
      await plantOpen(c.t, sub, i === 2 ? 266 : 267, c.owners)
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    const { answer } = await readMeasured(c.t, c.me, c.top, '3 sub-projects, 800 open tasks')
    const ok = okOf(answer)
    expect(ok.counts.all.state).toBe('ok')
    expect(ok.counts.blocked).toBeGreaterThan(100)
    expect(ok.late_due.state).toBe('ok')
  })

  it('reads a project of 30 sub-projects with 20 open tasks each whole', async () => {
    const c = await sharedCase(30)
    for (const sub of c.subs) await plantOpen(c.t, sub, 20, c.owners)
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    const { answer } = await readMeasured(c.t, c.me, c.top, '30 sub-projects, 600 open tasks')
    expect(okOf(answer).counts.all.state).toBe('ok')
  })

  it('reads a project with 200 Done tasks not yet archived beside everyday open ones', async () => {
    const c = await sharedCase(3)
    for (const [i, sub] of c.subs.entries()) {
      await plantOpen(c.t, sub, 30, c.owners)
      await plantTasks(c.t, sub, i === 2 ? 66 : 67, (k) => ({
        ...mixOf(k, c.owners, 'plain', PLANTED_AT),
        status: 'done',
        done_at: PLANTED_AT,
        remaining_hours: 0,
      }))
    }
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    const { answer } = await readMeasured(c.t, c.me, c.top, '200 Done tasks beside 90 open')
    expect(okOf(answer).counts.all.state).toBe('ok')
  })

  it('reads the health table beside it at 800 open tasks, as the page asks both', async () => {
    const c = await sharedCase(3)
    for (const [i, sub] of c.subs.entries())
      await plantOpen(c.t, sub, i === 2 ? 266 : 267, c.owners)
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    const started = Date.now()
    const got = await measured(c.t, (ctx) =>
      readHealth(ctx, new Map([[c.me.org_id, c.me]]), {
        scope: { kind: 'project', org_id: c.me.org_id, project_id: c.top.id },
        ...WEEKS,
        sort: 'late',
        dir: 'desc',
        limit: 10,
      }),
    )
    console.log(
      `health reads beside the list, 800 open tasks: ${JSON.stringify(got.took)} in ${Date.now() - started} ms`,
    )
    expect(got.answer.state).toBe('ok')
  })
})

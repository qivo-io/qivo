/* My view's Your work (overview.ts work, lib/overviewWork.ts): which of
 * the person's tasks each group holds and in what order, what each row
 * needs, a delay that cannot be worked out, what another person's or a
 * hidden project's task adds, the limits, its fail-safe answers past a
 * lowered budget, and its reads at the design size under Convex's
 * transaction limits. */

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { OVERVIEW, readHealth } from '../lib/overview'
import { readWork, WORK, type WorkAnswer, type WorkGroup } from '../lib/overviewWork'
import { OWNER_LOADS } from '../lib/ownerLoads'
import { plantTasks } from './board.setup'
import {
  as,
  expectRefusal,
  newT,
  plantHiddenSibling,
  plantIssue,
  plantSeat,
  type T,
  uuid,
  withReadingAdmin,
} from './helpers.setup'
import { DAY, measured, PLANTED_AT, plantShared, shift, weeksOf } from './overview.setup'
import { countOrg } from './overviewCounts.setup'
import { withReach } from './projectReach.setup'
import { plantBlocks } from './teamSyncAgenda.setup'

process.env.BETTER_AUTH_SECRET ??= 'overview-work-test-secret-not-a-deployment-key'

const DEFAULT_OVERVIEW = structuredClone(OVERVIEW)
const DEFAULT_WORK = structuredClone(WORK)
const DEFAULT_OWNER_LOADS = structuredClone(OWNER_LOADS)
afterEach(() => {
  Object.assign(OVERVIEW, structuredClone(DEFAULT_OVERVIEW))
  Object.assign(WORK, structuredClone(DEFAULT_WORK))
  Object.assign(OWNER_LOADS, structuredClone(DEFAULT_OWNER_LOADS))
})

const WEEKS = weeksOf(DAY)

const workOf = (t: T, me: Doc<'profiles'>, limits: Partial<Record<WorkGroup, number>> = {}) =>
  as(t, me).query(api.overview.work, {
    ...WEEKS,
    progress: WORK.first,
    review: WORK.first,
    next: WORK.first,
    ...limits,
  })

function okOf(answer: WorkAnswer): Extract<WorkAnswer, { state: 'ok' }> {
  if (answer.state !== 'ok') throw new Error(JSON.stringify(answer))
  return answer
}

const titles = (answer: WorkAnswer, group: WorkGroup) =>
  okOf(answer).groups[group].rows.map((r) => r.title)

async function groupsCase() {
  const t = newT()
  const f = await withReadingAdmin(t)
  const task = (title: string, fields: Partial<Doc<'issues'>> = {}) =>
    plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title,
      assignee_id: f.user.id,
      ...fields,
    })
  await task('Wire harness', { status: 'progress' })
  await task('Order parts', { status: 'progress', due_date: shift(DAY, -2) })
  await task('Port driver', { status: 'progress', due_date: shift(DAY, 4) })
  await task('Hold rig', { status: 'progress', paused: true })
  await task('Spec draft', { status: 'review' })
  await task('Handed on', { status: 'review', reviewer_id: f.admin.id })
  await task('Late review', {
    status: 'review',
    assignee_id: f.admin.id,
    reviewer_id: f.user.id,
    due_date: shift(DAY, -1),
    review_at: `${shift(DAY, -1)}T09:00:00.000Z`,
  })
  await task('Old review', {
    status: 'review',
    assignee_id: f.admin.id,
    reviewer_id: f.user.id,
    review_at: `${shift(DAY, -6)}T09:00:00.000Z`,
  })
  await task('New review', {
    status: 'review',
    assignee_id: f.admin.id,
    reviewer_id: f.user.id,
    review_at: `${shift(DAY, -2)}T09:00:00.000Z`,
  })
  await task('Unplanned, due', { status: 'todo', due_date: shift(DAY, 3) })
  await task('Unplanned', { status: 'todo' })
  await task('Starts later', {
    status: 'todo',
    start_week: shift(DAY, 14),
    end_week: shift(DAY, 14),
  })
  await task('Starts now, due late', {
    status: 'todo',
    start_week: DAY,
    end_week: DAY,
    due_date: shift(DAY, 30),
  })
  await task('Starts now, due soon', {
    status: 'todo',
    start_week: DAY,
    end_week: DAY,
    due_date: shift(DAY, 5),
  })
  const parent = await task('Bring-up', { status: 'todo' })
  await task('Solder headers', { status: 'todo', parent_id: parent.id, due_date: shift(DAY, 6) })
  await task('Someday', { status: 'backlog' })
  await task('Shipped', { status: 'done', done_at: PLANTED_AT })
  await task("Admin's", { status: 'progress', assignee_id: f.admin.id })
  await withReach(t)
  await countOrg(t, f.org.id)
  return { t, f }
}

describe('groups and order', () => {
  it("holds the person's own open tasks by the Reviewer rule, each group in its order", async () => {
    const { t, f } = await groupsCase()
    const answer = okOf(await workOf(t, f.user))
    // the most urgent first: Overdue, then Paused, then the rest by due date
    expect(titles(answer, 'progress')).toEqual([
      'Order parts',
      'Spec draft',
      'Hold rig',
      'Port driver',
      'Wire harness',
    ])
    expect(answer.groups.progress.rows[1]?.needs).toMatchObject({ kind: 'no_reviewer' })
    // Overdue first, then the longest waiting
    expect(titles(answer, 'review')).toEqual(['Late review', 'Old review', 'New review'])
    // planned start, then due date, undated last; a parent is no row, its
    // subtask names it
    expect(titles(answer, 'next')).toEqual([
      'Starts now, due soon',
      'Starts now, due late',
      'Starts later',
      'Unplanned, due',
      'Solder headers',
      'Unplanned',
    ])
    expect(answer.groups.next.rows[4]?.parent_title).toBe('Bring-up')
    expect(answer.counts).toMatchObject({ overdue: 2, paused: 1, no_reviewer: 1 })
  })

  it('answers each group its first rows, its total, and refuses a limit past its bounds', async () => {
    const { t, f } = await groupsCase()
    const answer = okOf(await workOf(t, f.user, { progress: 2, review: 1, next: 3 }))
    expect(titles(answer, 'progress')).toEqual(['Order parts', 'Spec draft'])
    expect(titles(answer, 'review')).toEqual(['Late review'])
    expect(answer.groups).toMatchObject({
      progress: { total: 5 },
      review: { total: 3 },
      next: { total: 6 },
    })
    await expectRefusal(workOf(t, f.user, { next: 0 }), 'bad_request')
    await expectRefusal(workOf(t, f.user, { review: WORK.most + 1 }), 'bad_request')
  })
})

async function kindsCase() {
  const t = newT()
  const f = await withReadingAdmin(t)
  await t.run((ctx) => ctx.db.patch(f.sub._id, { track_delay: true }))
  const task = (title: string, fields: Partial<Doc<'issues'>> = {}) =>
    plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title,
      assignee_id: f.user.id,
      status: 'progress',
      ...fields,
    })
  const planned = (hours: number) => ({
    start_week: DAY,
    end_week: DAY,
    remaining_hours: hours,
    remaining_set_at: `${DAY}T12:00:00.000Z`,
  })
  await task('Order parts', { due_date: shift(DAY, -2) })
  await task('Tune loop', { ...planned(60), due_date: shift(DAY, 3) })
  await task('Write tests', { ...planned(60) })
  const blocker = await task('Cut stencil', { assignee_id: f.admin.id, status: 'todo' })
  const blocked = await task('Place parts', { status: 'todo' })
  await task('On time', { status: 'todo', due_date: shift(DAY, 60) })
  await plantBlocks(t, [[blocker, blocked]])
  await withReach(t)
  await countOrg(t, f.org.id)
  return { t, f }
}

describe('what a row needs', () => {
  it('flags each kind as the project Overview does, and lists the Late tasks by due date under their project', async () => {
    const { t, f } = await kindsCase()
    const answer = okOf(await workOf(t, f.user))
    const kindOf = (title: string) =>
      [...answer.groups.progress.rows, ...answer.groups.next.rows].find((r) => r.title === title)
        ?.needs.kind
    expect(kindOf('Order parts')).toBe('overdue')
    expect(kindOf('Tune loop')).toBe('projected')
    expect(kindOf('Write tests')).toBe('behind')
    expect(kindOf('Place parts')).toBe('blocked')
    expect(kindOf('On time')).toBeNull()
    expect(answer.counts.projected).toEqual({ state: 'ok', count: 1 })
    expect(answer.late_due).toEqual({
      state: 'ok',
      projects: [
        {
          project_id: f.meta.id,
          days: [
            { due: shift(DAY, -2), count: 1 },
            { due: shift(DAY, 3), count: 1 },
          ],
        },
      ],
    })
  })

  it('says a delay it could not work out is unknown, never on track, and keeps the rows', async () => {
    const { t, f } = await kindsCase()
    Object.assign(OWNER_LOADS, { open: 0 })
    const answer = okOf(await workOf(t, f.user))
    const row = (title: string) =>
      [...answer.groups.progress.rows, ...answer.groups.next.rows].find((r) => r.title === title)
    expect(row('Tune loop')?.needs).toMatchObject({ kind: null, delay_unknown: true })
    expect(row('Write tests')?.needs).toMatchObject({ kind: null, delay_unknown: true })
    // an overdue task needs no verdict
    expect(row('Order parts')?.needs.kind).toBe('overdue')
    expect(row('Order parts')?.needs.delay_unknown).toBeUndefined()
    expect(answer.counts.projected).toEqual({ state: 'unavailable', reason: 'loads' })
    expect(answer.late_due.state).toBe('unavailable')
  })
})

describe('access', () => {
  it("lists no task in a sub-project the person cannot see, nor anyone else's", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const guest = f.guest
    const sibling = await plantHiddenSibling(t, f, guest)
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Seen',
      assignee_id: guest.id,
      status: 'progress',
    })
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: sibling.id,
      title: 'Hidden',
      assignee_id: guest.id,
      status: 'progress',
    })
    await withReach(t)
    await countOrg(t, f.org.id)
    const answer = okOf(await workOf(t, guest))
    expect(titles(answer, 'progress')).toEqual(['Seen'])
    expect(answer.groups.progress.total).toBe(1)
  })
})

describe('past a lowered budget', () => {
  it('answers over_budget where the tasks do not fit, never a shorter list', async () => {
    const { t, f } = await groupsCase()
    await plantTasks(t, f.sub, 60, () => ({ assignee_id: f.user.id }))
    expect(okOf(await workOf(t, f.user)).groups.next.total).toBe(66)
    Object.assign(OVERVIEW, { reads: { ...OVERVIEW.reads, documents: 60 } })
    expect(await workOf(t, f.user)).toEqual({ state: 'over_budget' })
  })
})

// --------------------------------------------------------------- real limits

function record(label: string, took: unknown, ms: number, answer: WorkAnswer) {
  const ok = okOf(answer)
  console.log(
    `work reads, ${label}: ${JSON.stringify(took)} in ${ms} ms ${JSON.stringify({
      totals: Object.fromEntries(Object.entries(ok.groups).map(([k, g]) => [k, g.total])),
      counts: ok.counts,
    })}`,
  )
}

async function sharedCase(tops: number, subs: number) {
  const t = newT({ transactionLimits: true })
  const f = await withReadingAdmin(t)
  const me = await plantSeat(t, {
    org_id: f.org.id,
    org_role: 'user',
    auth_user_id: `auth_${uuid()}`,
    accepted_at: PLANTED_AT,
  })
  const planted = await plantShared(t, f.org.id, f.user, me, { tops, subs })
  return { t, f, me, subs: planted.subs }
}

function ownTask(i: number, me: Doc<'profiles'>, other: Doc<'profiles'>) {
  const status = (['todo', 'todo', 'progress', 'review', 'todo'] as const)[i % 5]
  const people =
    status !== 'review'
      ? { assignee_id: me.id }
      : i % 2 === 0
        ? { assignee_id: other.id, reviewer_id: me.id }
        : { assignee_id: me.id }
  return {
    status,
    title: `Replace the fan controller on the bench rig and log the readings, part ${i}`,
    ...people,
    paused: status !== 'review' && i % 12 === 0,
    ...(i % 5 < 3 ? { due_date: shift(DAY, (i % 40) - 10) } : {}),
    ...(i % 2 === 0
      ? {
          start_week: shift(DAY, 7 * ((i % 9) - 4)),
          end_week: shift(DAY, 7 * ((i % 9) - 2)),
          remaining_hours: ((i % 16) + 1) / 2,
          remaining_set_at: PLANTED_AT,
        }
      : {}),
  }
}

async function readMeasured(t: T, me: Doc<'profiles'>, label: string) {
  const started = Date.now()
  const got = await measured(t, (ctx) =>
    readWork(ctx, new Map([[me.org_id, me]]), {
      ...WEEKS,
      progress: WORK.first,
      review: WORK.first,
      next: WORK.first,
    }),
  )
  record(label, got.took, Date.now() - started, got.answer)
  return got
}

describe('real limits', () => {
  it("reads the person's tasks over the 200 sub-projects their teams share whole", async () => {
    const c = await sharedCase(100, 2)
    expect(c.subs).toHaveLength(200)
    for (const [k, sub] of c.subs.entries())
      await plantTasks(c.t, sub, 2, (i) => ownTask(2 * k + i, c.me, c.f.user))
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    const { answer } = await readMeasured(c.t, c.me, '200 sub-projects, 2 tasks each')
    const ok = okOf(answer)
    expect(ok.groups.next.total + ok.groups.progress.total + ok.groups.review.total).toBe(400)
    expect(ok.counts.projected.state).toBe('ok')
    expect(ok.late_due.state).toBe('ok')
    // the projects list the page asks beside it
    const started = Date.now()
    const projects = await measured(c.t, (ctx) =>
      readHealth(ctx, new Map([[c.me.org_id, c.me]]), {
        scope: { kind: 'mine' },
        ...WEEKS,
        sort: 'late',
        dir: 'desc',
        limit: 10,
        open_only: true,
      }),
    )
    console.log(
      `health reads beside it, My view over 200 sub-projects, open only: ${JSON.stringify(projects.took)} in ${Date.now() - started} ms`,
    )
    expect(projects.answer).toMatchObject({ state: 'ok', total: 100 })
  })

  it("reads a project of 3 sub-projects with 800 open tasks, all the person's, whole", async () => {
    const c = await sharedCase(1, 3)
    for (const [k, sub] of c.subs.entries()) {
      const planted = await plantTasks(c.t, sub, k === 2 ? 266 : 267, (i) =>
        ownTask(267 * k + i, c.me, c.f.user),
      )
      const pairs: [Doc<'issues'>, Doc<'issues'>][] = []
      for (let i = 5; i < planted.length; i += 5)
        pairs.push([planted[i - 1] as Doc<'issues'>, planted[i] as Doc<'issues'>])
      await plantBlocks(c.t, pairs)
    }
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    const { answer } = await readMeasured(c.t, c.me, '3 sub-projects, 800 open tasks')
    const ok = okOf(answer)
    expect(ok.groups.next.total + ok.groups.progress.total + ok.groups.review.total).toBe(800)
  })
})

/* One milestone a week for each top-level project (LIMITS.milestonesPerWeek,
 * model/milestones.ts): every writer refuses a second milestone in a week of
 * the organization's calendar, a change of the first day of the week is
 * refused when it would put two milestones of one project in one week, and
 * the read-only activation audit (internal/milestoneWeeks.ts) reports the
 * rows stored before the rule that break it.
 *
 * convex-test runs one transaction at a time, so these tests cannot show
 * two concurrent claims of one week conflicting. That rests on each write
 * reading the week's range and the organization in its own transaction. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { MARKETING_DEMO, marketingWeek } from '../internal/marketingDemoData'
import { PROJECT_MOST } from '../internal/milestoneWeeks'
import { byId } from '../lib/db'
import type { Refusal } from '../lib/functions'
import { milestoneWeekTaken, WEEK_START_REFUSALS } from '../lib/limits'
import { sha256hex } from '../machine/auth'
import { TRASH_BUDGET } from '../model/deletedItems'
import { MILESTONE_WEEK_TAKEN } from '../model/milestones'
import { WEEKDAY_NAMES, weekDays, weekPhrase } from '../model/orgs'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantProject,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { NORTHSTAR_ANCHOR, plantNorthstar } from './northstar.setup'
import { deleteProject, installTrashTimers, itemFor, runSteps } from './trash.setup'

const DAY = 86_400_000

/* `day` moved by `days`. */
const plus = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10)

/* The first day on or after `day` that falls on weekday `start`. */
const firstOn = (day: string, start: number): string => {
  let d = day
  while (new Date(`${d}T00:00:00.000Z`).getUTCDay() !== start) d = plus(d, 1)
  return d
}

const orgOf = async (t: T, f: OrgFixture) =>
  (await t.run((ctx) => byId(ctx, 'organizations', f.org.id))) as Doc<'organizations'>

const milestonesOf = (t: T, projectId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('milestones')
      .withIndex('by_project_week', (q) => q.eq('project_id', projectId))
      .collect(),
  )

/* Adds a milestone as `who` through the app and answers its id. */
async function add(
  t: T,
  f: OrgFixture,
  who: Doc<'profiles'>,
  projectId: string,
  name: string,
  week: string,
): Promise<string> {
  const id = uuid()
  await as(t, who).mutation(api.projects.addMilestone, {
    org_id: f.org.id,
    id,
    project_id: projectId,
    name,
    week,
  })
  return id
}

/* Stores a milestone directly, as rows stored before the rule were. */
const plant = (t: T, projectId: string, week: string, name = 'Planted') =>
  t.run(async (ctx) => {
    const id = uuid()
    await ctx.db.insert('milestones', { id, project_id: projectId, name, week, created_at: NOW })
    return id
  })

/* The refusal of a week `holder` holds, in `org`'s calendar. */
const taken = (
  org: Doc<'organizations'>,
  holder: { name: string; week: string },
  next?: string,
): string => milestoneWeekTaken(weekPhrase(holder.week, org), holder.name, next)

/* Expects the weekly rule's refusal for `holder`. */
async function expectTaken(
  call: Promise<unknown>,
  org: Doc<'organizations'>,
  holder: { name: string; week: string },
  next?: string,
): Promise<void> {
  const e = await expectRefusal(call, 'rule')
  expect(e.data).toEqual({
    code: 'rule',
    reason: MILESTONE_WEEK_TAKEN,
    message: taken(org, holder, next),
  })
}

describe('one milestone a week in the app', () => {
  it.each([0, 1, 2, 3, 4, 5, 6])(
    'refuses a second milestone in a week that starts on weekday %i, and allows the weeks around it',
    async (start) => {
      const t = newT()
      const f = await withOrg(t)
      await t.run((ctx) => ctx.db.patch(f.org._id, { week_start: start }))
      const org = await orgOf(t, f)
      const first = firstOn('2026-06-01', start)
      await add(t, f, f.user, f.meta.id, 'Alpha', plus(first, 3))
      for (const day of [first, plus(first, 6)])
        await expectTaken(add(t, f, f.user, f.meta.id, 'Beta', day), org, {
          name: 'Alpha',
          week: plus(first, 3),
        })
      await add(t, f, f.user, f.meta.id, 'Before', plus(first, -1))
      await add(t, f, f.user, f.meta.id, 'After', plus(first, 7))
      expect((await milestonesOf(t, f.meta.id)).map((m) => m.name)).toEqual([
        'Before',
        'Alpha',
        'After',
      ])
    },
  )

  it('lets different top-level projects each have a milestone in one week', async () => {
    const t = newT()
    const f = await withOrg(t)
    await add(t, f, f.user, f.meta.id, 'Platform beta', '2026-06-01')
    await add(t, f, f.user, f.hidden.id, 'Skunkworks demo', '2026-06-03')
    expect(await milestonesOf(t, f.meta.id)).toHaveLength(1)
    expect(await milestonesOf(t, f.hidden.id)).toHaveLength(1)
  })

  it('counts a milestone named on a sub-project against its top-level project', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org = await orgOf(t, f)
    await add(t, f, f.user, f.sub.id, 'Firmware frozen', '2026-06-02')
    expect((await milestonesOf(t, f.meta.id)).map((m) => m.name)).toEqual(['Firmware frozen'])
    const holder = { name: 'Firmware frozen', week: '2026-06-02' }
    await expectTaken(add(t, f, f.user, f.sub2.id, 'Board ready', '2026-06-04'), org, holder)
    await expectTaken(add(t, f, f.user, f.meta.id, 'Platform beta', '2026-06-07'), org, holder)
    expect(await milestonesOf(t, f.sub.id)).toEqual([])
    expect(await milestonesOf(t, f.sub2.id)).toEqual([])
  })

  it('refuses a move into an occupied week and keeps both milestones as they were', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org = await orgOf(t, f)
    await add(t, f, f.user, f.meta.id, 'Alpha', '2026-06-01')
    const beta = await add(t, f, f.user, f.meta.id, 'Beta', '2026-06-08')
    const events = async () =>
      (await t.run((ctx) => ctx.db.query('activity_events').collect())).length
    const before = await events()
    await expectTaken(
      as(t, f.user).mutation(api.projects.updateMilestone, {
        org_id: f.org.id,
        id: beta,
        patch: { name: 'Beta moved', week: '2026-06-03' },
      }),
      org,
      { name: 'Alpha', week: '2026-06-01' },
    )
    expect(await events()).toBe(before)
    expect((await milestonesOf(t, f.meta.id)).map((m) => [m.name, m.week])).toEqual([
      ['Alpha', '2026-06-01'],
      ['Beta', '2026-06-08'],
    ])
  })

  it('allows a move within its own week, a rename and a delete', async () => {
    const t = newT()
    const f = await withOrg(t)
    await add(t, f, f.user, f.meta.id, 'Alpha', '2026-06-01')
    const beta = await add(t, f, f.user, f.meta.id, 'Beta', '2026-06-08')
    const update = (patch: { name?: string; week?: string }) =>
      as(t, f.user).mutation(api.projects.updateMilestone, { org_id: f.org.id, id: beta, patch })
    await update({ week: '2026-06-12' })
    await update({ name: 'Beta 2', week: '2026-06-12' })
    expect((await milestonesOf(t, f.meta.id)).map((m) => [m.name, m.week])).toEqual([
      ['Alpha', '2026-06-01'],
      ['Beta 2', '2026-06-12'],
    ])
    await as(t, f.user).mutation(api.projects.removeMilestone, { org_id: f.org.id, id: beta })
    await add(t, f, f.user, f.meta.id, 'Gamma', '2026-06-08')
  })

  it('makes no exception for two milestones stored in one week before the rule', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org = await orgOf(t, f)
    const first = await plant(t, f.meta.id, '2026-06-01', 'Old one')
    const second = await plant(t, f.meta.id, '2026-06-03', 'Old two')
    // a rename stays possible
    await as(t, f.user).mutation(api.projects.updateMilestone, {
      org_id: f.org.id,
      id: second,
      patch: { name: 'Old two renamed' },
    })
    // a move within the week still meets the other one
    await expectTaken(
      as(t, f.user).mutation(api.projects.updateMilestone, {
        org_id: f.org.id,
        id: second,
        patch: { week: '2026-06-04' },
      }),
      org,
      { name: 'Old one', week: '2026-06-01' },
    )
    // once one has left, the week holds one, and the other may move in it
    await as(t, f.user).mutation(api.projects.updateMilestone, {
      org_id: f.org.id,
      id: first,
      patch: { week: '2026-06-15' },
    })
    await as(t, f.user).mutation(api.projects.updateMilestone, {
      org_id: f.org.id,
      id: second,
      patch: { week: '2026-06-04' },
    })
  })

  it('counts a stored day that does not exist in the week the app shows it in', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org = await orgOf(t, f)
    // 2026-02-31 is shown on Tuesday 3 March; text order puts it in February
    await plant(t, f.meta.id, '2026-02-31', 'Impossible')
    await add(t, f, f.user, f.meta.id, 'Late February', '2026-02-26')
    // the write's range of the week of 2 March cannot see it, which the
    // activation audit reports instead
    await add(t, f, f.user, f.meta.id, 'Early March', '2026-03-02')
    expect(weekDays('2026-02-31', org)).toEqual({ first: '2026-03-02', last: '2026-03-08' })
  })
})

describe('Roadmap saves and undo', () => {
  const create = (id: string, projectId: string, name: string, week: string) => ({
    kind: 'milestone_create' as const,
    id,
    project_id: projectId,
    name,
    week,
  })
  const move = (id: string, week: string) => ({
    kind: 'milestone_update' as const,
    id,
    patch: { week },
  })

  it('accepts a save that swaps the weeks of two milestones', async () => {
    const t = newT()
    const f = await withOrg(t)
    const alpha = await add(t, f, f.user, f.meta.id, 'Alpha', '2026-06-01')
    const beta = await add(t, f, f.user, f.meta.id, 'Beta', '2026-06-08')
    await as(t, f.user).mutation(api.roadmap.change, {
      session_id: uuid(),
      operations: [move(alpha, '2026-06-08'), move(beta, '2026-06-01')],
    })
    expect((await milestonesOf(t, f.meta.id)).map((m) => [m.name, m.week])).toEqual([
      ['Beta', '2026-06-01'],
      ['Alpha', '2026-06-08'],
    ])
  })

  it('refuses a whole save that leaves two milestones in one week', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org = await orgOf(t, f)
    const session_id = uuid()
    const [a, b] = [uuid(), uuid()]
    await expectTaken(
      as(t, f.user).mutation(api.roadmap.change, {
        session_id,
        operations: [
          create(a, f.meta.id, 'Alpha', '2026-06-01'),
          create(b, f.sub.id, 'Beta', '2026-06-05'),
        ],
      }),
      org,
      { name: 'Beta', week: '2026-06-05' },
    )
    expect(await milestonesOf(t, f.meta.id)).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('roadmap_history').collect())).toEqual([])
    // a drag onto an occupied week
    await add(t, f, f.user, f.meta.id, 'Alpha', '2026-06-01')
    const beta = await add(t, f, f.user, f.meta.id, 'Beta', '2026-06-15')
    await expectTaken(
      as(t, f.user).mutation(api.roadmap.change, {
        session_id,
        operations: [move(beta, '2026-06-02')],
      }),
      org,
      { name: 'Alpha', week: '2026-06-01' },
    )
  })

  it('refuses an undo into an occupied week, keeps its history, and undoes once the week is free', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org = await orgOf(t, f)
    const user = as(t, f.user)
    const session_id = uuid()
    const alpha = uuid()
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [create(alpha, f.meta.id, 'Alpha', '2026-06-01')],
    })
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [move(alpha, '2026-06-15')],
    })
    const gamma = await add(t, f, f.user, f.meta.id, 'Gamma', '2026-06-03')
    const undo = () => user.mutation(api.roadmap.undo, { session_id, all: false })
    await expectTaken(
      undo(),
      org,
      { name: 'Gamma', week: '2026-06-03' },
      'Move that milestone to another week first, then undo again.',
    )
    // the refusal is a rule, which the app answers by keeping the history
    expect(await t.run((ctx) => ctx.db.query('roadmap_history').collect())).toHaveLength(2)
    expect((await t.run((ctx) => byId(ctx, 'milestones', alpha)))?.week).toBe('2026-06-15')
    await user.mutation(api.projects.updateMilestone, {
      org_id: f.org.id,
      id: gamma,
      patch: { week: '2026-06-22' },
    })
    expect(await undo()).toEqual({ count: 1 })
    expect((await t.run((ctx) => byId(ctx, 'milestones', alpha)))?.week).toBe('2026-06-01')
  })

  it('checks an undo of the whole visit where it ends', async () => {
    const t = newT()
    const f = await withOrg(t)
    const user = as(t, f.user)
    const session_id = uuid()
    const alpha = uuid()
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [create(alpha, f.meta.id, 'Alpha', '2026-06-01')],
    })
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [move(alpha, '2026-06-15')],
    })
    await add(t, f, f.user, f.meta.id, 'Gamma', '2026-06-03')
    // moving Alpha back passes through Gamma's week, but the undo of its
    // creation then takes it away
    expect(await user.mutation(api.roadmap.undo, { session_id, all: true })).toEqual({ count: 0 })
    expect((await milestonesOf(t, f.meta.id)).map((m) => m.name)).toEqual(['Gamma'])
  })

  it('refuses an undo of a delete into a week another milestone took since', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org = await orgOf(t, f)
    const user = as(t, f.user)
    const session_id = uuid()
    const alpha = await add(t, f, f.user, f.meta.id, 'Alpha', '2026-06-01')
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [{ kind: 'milestone_remove', id: alpha }],
    })
    await add(t, f, f.user, f.meta.id, 'Delta', '2026-06-05')
    await expectTaken(
      user.mutation(api.roadmap.undo, { session_id, all: false }),
      org,
      { name: 'Delta', week: '2026-06-05' },
      'Move that milestone to another week first, then undo again.',
    )
    expect(await t.run((ctx) => byId(ctx, 'milestones', alpha))).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('roadmap_history').collect())).toHaveLength(1)
  })
})

/* A write token of the fixture's admin, for REST over HTTP. */
async function restToken(t: T, f: OrgFixture): Promise<string> {
  const token = `qvt_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
  const token_hash = await sha256hex(token)
  await t.run((ctx) =>
    ctx.db.insert('mcp_tokens', {
      id: uuid(),
      profile_id: f.admin.id,
      name: 'Admin token',
      token_prefix: token.slice(0, 11),
      token_hash,
      access: 'write',
      created_at: NOW,
    }),
  )
  return token
}

type Fetching = {
  fetch(
    path: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; text(): Promise<string> }>
}

/* One REST request: its status and JSON body. */
async function rest(t: T, token: string, method: string, path: string, body: unknown) {
  const res = await (t as unknown as Fetching).fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> }
}

describe('one milestone a week over REST and MCP', () => {
  it('answers a REST create or move into an occupied week with a 400 and the sentence', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org = await orgOf(t, f)
    const token = await restToken(t, f)
    const first = await rest(t, token, 'POST', '/v1/projects/FW/milestones', {
      name: 'Launch',
      date: '2026-11-02',
    })
    expect(first.status).toBe(201)
    const sentence = taken(org, { name: 'Launch', week: '2026-11-02' })
    expect(
      await rest(t, token, 'POST', '/v1/projects/TBED/milestones', {
        name: 'Second',
        date: '2026-11-06',
      }),
    ).toEqual({ status: 400, body: { error: sentence } })
    const later = await rest(t, token, 'POST', '/v1/projects/TBED/milestones', {
      name: 'Later',
      date: '2026-11-09',
    })
    expect(later.status).toBe(201)
    expect(
      await rest(t, token, 'PATCH', `/v1/projects/TBED/milestones/${later.body.id}`, {
        date: '2026-11-04',
      }),
    ).toEqual({ status: 400, body: { error: sentence } })
    expect((await milestonesOf(t, f.meta.id)).map((m) => m.week)).toEqual([
      '2026-11-02',
      '2026-11-09',
    ])
  })

  it('refuses an MCP set_milestone into an occupied week', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org = await orgOf(t, f)
    const set = (a: { milestone?: string; name?: string; date?: string }) =>
      t.mutation(internal.machine.projects.mcpSetMilestone, {
        callerId: f.user.id,
        access: 'write',
        project: f.meta.key,
        ...a,
      })
    const launch = JSON.parse(await set({ name: 'Launch', date: '2026-11-02' })) as { id: string }
    const sentence = { name: 'Launch', week: '2026-11-02' }
    await expectTaken(set({ name: 'Second', date: '2026-11-08' }), org, sentence)
    const later = JSON.parse(await set({ name: 'Later', date: '2026-11-16' })) as { id: string }
    await expectTaken(set({ milestone: later.id, date: '2026-11-03' }), org, sentence)
    // a move of the occupying milestone itself within its week is no clash
    await set({ milestone: launch.id, date: '2026-11-05' })
  })
})

/* Changes the fixture organization's first day of the week as its admin. */
const setWeekStart = (t: T, f: OrgFixture, week_start: number) =>
  as(t, f.admin).mutation(api.orgs.update, { org_id: f.org.id, patch: { week_start } })

/* `week_start` applied to `org`, for the sentences of a proposed start. */
const under = (org: Doc<'organizations'>, week_start: number) => ({ ...org, week_start })

describe('changing the first day of the week', () => {
  it('refuses a start that puts two milestones of one project in one week, naming them', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org = await orgOf(t, f)
    // a Sunday and the Monday after it are two weeks while weeks start on Monday
    await add(t, f, f.user, f.meta.id, 'Alpha', '2026-05-10')
    await add(t, f, f.user, f.meta.id, 'Beta', '2026-05-11')
    const e = await expectRefusal(setWeekStart(t, f, 0), 'rule')
    expect((e.data as Refusal).reason).toBe(WEEK_START_REFUSALS.conflicts)
    expect((e.data as Refusal).message).toBe(
      'workdays cannot start on Sunday, because a project can have at most 1 milestone a week, ' +
        'and then Testbed platform (TBED) would have “Alpha” on 2026-05-10 and “Beta” on ' +
        `2026-05-11 in ${weekPhrase('2026-05-10', under(org, 0))}. ` +
        'Move or delete milestones so that no project has two in one week, then change the first day again.',
    )
    // every start but Monday puts them together
    for (const start of [2, 3, 4, 5, 6])
      await expectRefusal(setWeekStart(t, f, start), 'rule', /^workdays cannot start on /)
    expect((await orgOf(t, f)).week_start).toBe(1)
    // a move resolves it
    const [, beta] = await milestonesOf(t, f.meta.id)
    await as(t, f.user).mutation(api.projects.updateMilestone, {
      org_id: f.org.id,
      id: beta.id,
      patch: { week: '2026-05-18' },
    })
    await setWeekStart(t, f, 0)
    expect((await orgOf(t, f)).week_start).toBe(0)
  })

  it('accepts every start when no two milestones of a project are within a week', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const week of ['2026-05-11', '2026-05-18', '2026-05-25'])
      await add(t, f, f.user, f.meta.id, `Gate ${week}`, week)
    // different projects may share any week
    await add(t, f, f.user, f.hidden.id, 'Skunkworks', '2026-05-12')
    for (const start of [0, 2, 3, 4, 5, 6, 1]) {
      await setWeekStart(t, f, start)
      expect((await orgOf(t, f)).week_start).toBe(start)
    }
  })

  it('checks archived projects and leaves the week numbering rule unchecked', async () => {
    const t = newT()
    const f = await withOrg(t)
    const archived = await plantProject(t, {
      org_id: f.org.id,
      key: 'OLD',
      name: 'Old line',
      lead_id: f.user.id,
      archived_at: '2026-02-01T00:00:00.000Z',
    })
    await plant(t, archived.id, '2026-03-01', 'Old Sunday')
    await plant(t, archived.id, '2026-03-02', 'Old Monday')
    await expectRefusal(
      setWeekStart(t, f, 0),
      'rule',
      /would have “Old Sunday” on 2026-03-01 and “Old Monday” on 2026-03-02 in the week of 2026-03-01/,
    )
    await as(t, f.admin).mutation(api.orgs.update, {
      org_id: f.org.id,
      patch: { week_one_rule: 'jan1' },
    })
    expect((await orgOf(t, f)).week_one_rule).toBe('jan1')
  })

  it('names five weeks and counts the rest', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 7; i++) {
      const p = await plantProject(t, { org_id: f.org.id, key: `CL${i}`, name: `Clash ${i}` })
      const sunday = plus('2026-05-10', 7 * i)
      await plant(t, p.id, sunday, `Sunday ${i}`)
      await plant(t, p.id, plus(sunday, 1), `Monday ${i}`)
    }
    const e = await expectRefusal(setWeekStart(t, f, 0), 'rule')
    const message = (e.data as Refusal).message
    expect(message.match(/would have/g)).toHaveLength(5)
    expect(message).toContain('; and 2 more weeks would hold two milestones of one project.')
  })

  it('refuses as unchecked when it runs out of room, and names what it found before', async () => {
    // half of 200 documents is the check's room
    const t = newT({ transactionLimits: { documentsRead: 200 } })
    const f = await withOrg(t)
    const org = await orgOf(t, f)
    for (let i = 0; i < 120; i++)
      await plantProject(t, { org_id: f.org.id, key: `P${i}`, name: `Project ${i}` })
    let e = await expectRefusal(setWeekStart(t, f, 0), 'rule')
    expect(e.data).toEqual({
      code: 'rule',
      reason: WEEK_START_REFUSALS.unchecked,
      message:
        'Qivo could not check every milestone of this organization at once, so workdays still start on Monday. Contact support@qivo.io to change the first day of the week.',
    })
    // a clash in the first project is real, so it is named
    await plant(t, f.meta.id, '2026-05-10', 'Alpha')
    await plant(t, f.meta.id, '2026-05-11', 'Beta')
    e = await expectRefusal(setWeekStart(t, f, 0), 'rule')
    expect((e.data as Refusal).reason).toBe(WEEK_START_REFUSALS.conflicts)
    expect((e.data as Refusal).message).toContain(
      `Testbed platform (TBED) would have “Alpha” on 2026-05-10 and “Beta” on 2026-05-11 in ${weekPhrase('2026-05-10', under(org, 0))}`,
    )
    expect((e.data as Refusal).message).toMatch(
      / Qivo could not check every project, so there may be more\.$/,
    )
    expect((await orgOf(t, f)).week_start).toBe(1)
  })
})

describe('changing the first day of the week with projects in Deleted items', () => {
  installTrashTimers()

  it('checks a deleted project while it moves and once it is stored, but not a stuck one', async () => {
    const t = newT()
    const f = await withOrg(t)
    await add(t, f, f.user, f.meta.id, 'Alpha', '2026-05-10')
    await add(t, f, f.user, f.meta.id, 'Beta', '2026-05-11')
    // the delete itself moves at most one row, so one milestone stays live
    // until the steps run
    Object.assign(TRASH_BUDGET, { rows: 1 })
    await deleteProject(t, f, f.meta.id)
    const item = await itemFor(t, f.meta.id)
    expect(item.state).toBe('moving')
    const clash =
      /Testbed platform \(TBED, in Deleted items\) would have “Alpha” on 2026-05-10 and “Beta” on 2026-05-11/
    await expectRefusal(setWeekStart(t, f, 0), 'rule', clash)
    await runSteps(t)
    expect((await itemFor(t, f.meta.id)).state).toBe('ready')
    expect(await milestonesOf(t, f.meta.id)).toEqual([])
    await expectRefusal(setWeekStart(t, f, 0), 'rule', clash)
    expect((await orgOf(t, f)).week_start).toBe(1)
    // an item that can only be deleted for good brings nothing back
    await t.run((ctx) => ctx.db.patch(item._id, { state: 'stuck' }))
    await setWeekStart(t, f, 0)
    expect((await orgOf(t, f)).week_start).toBe(0)
  })
})

/* The audit's whole report. */
const audit = (t: T, page_size?: number) =>
  t.action(internal.internal.milestoneWeeks.run, { page_size })

describe('the activation audit', () => {
  installTrashTimers()

  it('reports duplicate weeks, impossible days, sub-project rows and orphans, and writes nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    // 2026-02-31 is shown on Tuesday 3 March, in the week of Monday 2 March
    const monday = await plant(t, f.meta.id, '2026-03-02')
    const impossible = await plant(t, f.meta.id, '2026-02-31')
    const fine = await plant(t, f.meta.id, '2026-03-09')
    const sunday = await plant(t, f.hidden.id, '2026-04-12')
    const monday2 = await plant(t, f.hidden.id, '2026-04-06')
    const onSub = await plant(t, f.sub.id, '2026-05-04')
    const lost = uuid()
    const orphan = await plant(t, lost, '2026-05-04')
    // another organization, one milestone a week
    await plant(t, f.otherProject.id, '2026-05-04')
    await plant(t, f.otherProject.id, '2026-05-11')
    const before = await t.run((ctx) => ctx.db.query('milestones').collect())
    const report = await audit(t)
    expect(report.counts).toEqual({
      duplicate_week: 2,
      impossible_day: 1,
      sub_project: 1,
      orphan: 1,
      unchecked: 0,
    })
    expect(report.checked).toBe(9)
    expect(report.listed_all).toBe(true)
    const byKind = (kind: string) => report.findings.filter((x) => x.kind === kind)
    expect(byKind('impossible_day')).toEqual([
      {
        kind: 'impossible_day',
        org_id: f.org.id,
        project_id: f.meta.id,
        milestones: [{ id: impossible, day: '2026-02-31', shown: '2026-03-03' }],
      },
    ])
    expect(byKind('duplicate_week')).toEqual(
      expect.arrayContaining([
        {
          kind: 'duplicate_week',
          org_id: f.org.id,
          project_id: f.meta.id,
          week: '2026-03-02',
          milestones: expect.arrayContaining([
            { id: monday, day: '2026-03-02' },
            { id: impossible, day: '2026-02-31' },
          ]),
        },
        {
          kind: 'duplicate_week',
          org_id: f.org.id,
          project_id: f.hidden.id,
          week: '2026-04-06',
          milestones: expect.arrayContaining([
            { id: sunday, day: '2026-04-12' },
            { id: monday2, day: '2026-04-06' },
          ]),
        },
      ]),
    )
    expect(byKind('sub_project')).toEqual([
      {
        kind: 'sub_project',
        org_id: f.org.id,
        project_id: f.sub.id,
        milestones: [{ id: onSub, day: '2026-05-04' }],
      },
    ])
    expect(byKind('orphan')).toEqual([
      {
        kind: 'orphan',
        org_id: null,
        project_id: lost,
        milestones: [{ id: orphan, day: '2026-05-04' }],
      },
    ])
    expect(JSON.stringify(report)).not.toContain(fine)
    // one project a page finds the same
    const paged = await audit(t, 1)
    expect(paged.counts).toEqual(report.counts)
    expect(paged.findings).toEqual(expect.arrayContaining(report.findings))
    expect(await t.run((ctx) => ctx.db.query('milestones').collect())).toEqual(before)
  })

  it('reports the copies of a deleted project, and leaves a stuck one out', async () => {
    const t = newT()
    const f = await withOrg(t)
    const a = await plant(t, f.meta.id, '2026-05-10')
    const b = await plant(t, f.meta.id, '2026-05-04')
    const onSub = await plant(t, f.sub2.id, '2026-05-04')
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    expect(await milestonesOf(t, f.meta.id)).toEqual([])
    const report = await audit(t)
    expect(report.findings).toEqual(
      expect.arrayContaining([
        {
          kind: 'duplicate_week',
          org_id: f.org.id,
          project_id: f.meta.id,
          item_id: item.id,
          week: '2026-05-04',
          milestones: expect.arrayContaining([
            { id: a, day: '2026-05-10' },
            { id: b, day: '2026-05-04' },
          ]),
        },
        {
          kind: 'sub_project',
          org_id: f.org.id,
          project_id: f.sub2.id,
          item_id: item.id,
          milestones: [{ id: onSub, day: '2026-05-04' }],
        },
      ]),
    )
    expect(report.counts.duplicate_week + report.counts.sub_project).toBe(2)
    await t.run((ctx) => ctx.db.patch(item._id, { state: 'stuck' }))
    expect((await audit(t)).findings).toEqual([])
  })

  it('reports nothing for milestones the rule allows', async () => {
    const t = newT()
    const f = await withOrg(t)
    await add(t, f, f.user, f.meta.id, 'Alpha', '2026-05-04')
    await add(t, f, f.user, f.meta.id, 'Beta', '2026-05-11')
    await add(t, f, f.user, f.hidden.id, 'Gamma', '2026-05-05')
    const report = await audit(t)
    expect(report).toMatchObject({ checked: 3, findings: [], listed_all: true })
  })

  it('reports a project with more milestones than a page reads, and goes on after it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const crowded = await plantProject(t, {
      org_id: f.org.id,
      id: '00000000-0000-4000-8000-000000000000',
    })
    const last = await plantProject(t, {
      org_id: f.org.id,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    })
    await t.run(async (ctx) => {
      for (let i = 0; i <= PROJECT_MOST; i++)
        await ctx.db.insert('milestones', {
          id: uuid(),
          project_id: crowded.id,
          name: `Week ${i}`,
          week: plus('2000-01-03', 7 * i),
          created_at: NOW,
        })
    })
    await plant(t, last.id, '2026-05-04')
    await plant(t, last.id, '2026-05-05')
    const report = await audit(t)
    expect(report.counts).toMatchObject({ unchecked: 1, duplicate_week: 1 })
    expect(report.findings.find((x) => x.kind === 'unchecked')?.project_id).toBe(crowded.id)
  }, 60_000)
})

describe('the Northstar data under every first day of the week', () => {
  it.each([0, 1, 2, 3, 4, 5, 6])(
    'puts no two milestones of a project in one week from weekday %i',
    (start) => {
      const weeks = new Map<string, Set<string>>()
      for (const m of MARKETING_DEMO.milestones) {
        const first = weekDays(marketingWeek(NORTHSTAR_ANCHOR, m.week), {
          week_start: start,
        })?.first
        const held = weeks.get(m.project) ?? new Set<string>()
        expect(first).toBeDefined()
        expect(held.has(first as string), `${m.project} ${m.key}`).toBe(false)
        held.add(first as string)
        weeks.set(m.project, held)
      }
    },
  )

  it('takes every first day of the week once seeded, and its seed holds to the rule', async () => {
    const t = newT()
    const { org } = await plantNorthstar(t)
    const nora = t.withIdentity({ subject: 'auth_nora' })
    for (const start of [0, 2, 3, 4, 5, 6, 1]) {
      await nora.mutation(api.orgs.update, { org_id: org.id, patch: { week_start: start } })
      expect((await t.run((ctx) => byId(ctx, 'organizations', org.id)))?.week_start).toBe(start)
    }
    expect(WEEKDAY_NAMES[org.week_start]).toBe('Monday')
  })
})

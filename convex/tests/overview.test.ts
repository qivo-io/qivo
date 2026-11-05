/* The Overview's queries (overview.ts, lib/overview.ts): their arguments,
 * the scopes they refuse, the client's day, the lists' batches, fixed ends
 * and positions, the verdicts' owner loads, what hidden data may move, and
 * the reads at the design size under Convex's transaction limits.
 * src/store/overviewParity.test.ts compares their figures with the app's. */

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { OWN_READS } from '../lib/access'
import {
  type ListAnswer,
  OVERVIEW,
  type OverviewRow,
  type OverviewScope,
  readAttention,
  readPaused,
  readRisk,
  readSummary,
} from '../lib/overview'
import { OWNER_LOADS } from '../lib/ownerLoads'
import { plantTasks } from './board.setup'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import {
  BEFORE_RULE,
  DAY,
  measured,
  plantMix,
  plantPeople,
  plantShared,
  shift,
  weeksOf,
} from './overview.setup'
import { countOrg } from './overviewCounts.setup'
import { withReach } from './projectReach.setup'

process.env.BETTER_AUTH_SECRET ??= 'overview-test-secret-not-a-deployment-key'

const DEFAULT_OVERVIEW = structuredClone(OVERVIEW)
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
const DEFAULT_OWNER_LOADS = structuredClone(OWNER_LOADS)
afterEach(() => {
  Object.assign(OVERVIEW, structuredClone(DEFAULT_OVERVIEW))
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
  Object.assign(OWNER_LOADS, structuredClone(DEFAULT_OWNER_LOADS))
})

const WEEKS = weeksOf(DAY)

/* A login id for the readers called outside a query. */
const LOGIN = 'auth_overview_reader'

const scopeOf = (me: Doc<'profiles'>, p: Doc<'projects'>): OverviewScope => ({
  kind: 'project',
  org_id: me.org_id,
  project_id: p.id,
})

/** The four answers for `me` over `scope`. */
async function answers(t: T, me: Doc<'profiles'>, scope: OverviewScope, day = DAY) {
  const caller = as(t, me)
  const weeks = { ...weeksOf(DAY), day }
  return {
    summary: await caller.query(api.overview.summary, { scope, day }),
    risk: await caller.query(api.overview.risk, { scope, ...weeks }),
    attention: await caller.query(api.overview.attention, { scope, ...weeks }),
    paused: await caller.query(api.overview.paused, { scope }),
  }
}

/** Every batch of the Paused list for `me` over `scope`, from its start. */
async function pausedBatches(t: T, me: Doc<'profiles'>, scope: OverviewScope) {
  const out: (ListAnswer & { state: 'ok' })[] = []
  let cursor: string | undefined
  for (let n = 0; n < 50; n++) {
    const got = await as(t, me).query(api.overview.paused, { scope, ...(cursor ? { cursor } : {}) })
    if (got.state !== 'ok') throw new Error(JSON.stringify(got))
    out.push(got)
    if (got.next === null) return out
    cursor = got.next
  }
  throw new Error('the list did not end')
}

/** The Paused list for `me` over `scope` a batch at a time, from its start:
 * the batches, and the answer that refused one, if one did. Every batch
 * goes on past its cursor. */
async function walkPaused(t: T, me: Doc<'profiles'>, scope: OverviewScope) {
  const batches: (ListAnswer & { state: 'ok' })[] = []
  let cursor: string | undefined
  for (let n = 0; n < 60; n++) {
    const got = await as(t, me).query(api.overview.paused, { scope, ...(cursor ? { cursor } : {}) })
    if (got.state !== 'ok') return { batches, refused: got }
    if (cursor !== undefined) expect(got.next).not.toBe(cursor)
    batches.push(got)
    if (got.next === null) return { batches, refused: null }
    cursor = got.next
  }
  throw new Error('the list did not end')
}

const titles = (rows: readonly OverviewRow[]) => rows.map((r) => r.title)

// ----------------------------------------------------------------- arguments

describe('arguments', () => {
  it('refuses a malformed day, week, week_starts or week_end, and takes well-formed ones', async () => {
    const t = newT()
    const f = await withOrg(t)
    const scope = scopeOf(f.user, f.meta)
    const caller = as(t, f.user)
    for (const day of ['2026-11-31', '2026/11/02', '', '2026-1-02'])
      await expectRefusal(caller.query(api.overview.summary, { scope, day }), 'bad_request', /day/)
    const risk = (over: Partial<typeof WEEKS>) =>
      caller.query(api.overview.risk, { scope, ...WEEKS, ...over })
    // the week must hold the day
    await expectRefusal(risk({ week: shift(DAY, -7) }), 'bad_request', /week/)
    await expectRefusal(risk({ week: shift(DAY, 1) }), 'bad_request', /week/)
    // exactly 53 instants, ascending, a week apart within three hours
    await expectRefusal(
      risk({ week_starts: WEEKS.week_starts.slice(1) }),
      'bad_request',
      /week_starts/,
    )
    await expectRefusal(
      risk({ week_starts: [...WEEKS.week_starts].reverse() }),
      'bad_request',
      /week_starts/,
    )
    const skewed = [...WEEKS.week_starts]
    skewed[10] += 4 * 3_600_000
    await expectRefusal(risk({ week_starts: skewed }), 'bad_request', /week_starts/)
    // the next week's start, a week after the last
    for (const week_end of [WEEKS.week_end + 4 * 3_600_000, WEEKS.week_starts[52], 1.5])
      await expectRefusal(risk({ week_end }), 'bad_request', /week_end/)
    // a daylight-saving week is an hour shorter or longer, or two in a few
    // zones
    const shifted = WEEKS.week_starts.map((s, i) => (i >= 20 ? s - 3_600_000 : s))
    expect((await risk({ week_starts: shifted })).state).toBe('ok')
    const troll = WEEKS.week_starts.map((s, i) => (i >= 20 ? s + 2 * 3_600_000 : s))
    const later = WEEKS.week_end + 2 * 3_600_000
    expect((await risk({ week_starts: troll, week_end: later })).state).toBe('ok')
    expect((await risk({ day: shift(DAY, 6) })).state).toBe('ok')
  })
})

// --------------------------------------------------------------------- access

describe('access', () => {
  it('answers unavailable alike for every scope the caller does not hold', async () => {
    const t = newT()
    const f = await withOrg(t)
    const other = await withOrg(t)
    // a member with no grant, who sees no project of TBED
    const me = await plantSeat(t, {
      org_id: f.org.id,
      org_role: 'user',
      auth_user_id: `auth_${uuid()}`,
    })
    const archived = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const loose = await plantProject(t, { org_id: f.org.id, type: 'project' })
    const scopes: [string, OverviewScope][] = [
      ['no such project', { kind: 'project', org_id: f.org.id, project_id: uuid() }],
      ["another organization's", { kind: 'project', org_id: f.org.id, project_id: other.sub.id }],
      ['a hidden project', scopeOf(me, f.sub)],
      ['a hidden top-level project', scopeOf(me, f.meta)],
    ]
    for (const [label, scope] of scopes) {
      const got = await answers(t, me, scope)
      for (const [query, answer] of Object.entries(got))
        expect(answer, `${label}, ${query}`).toEqual({ state: 'unavailable' })
    }
    // an archived sub-project, a top-level project that is not a meta and
    // an organization without a seat, for its admin too
    for (const [label, scope] of [
      ['an archived sub-project', scopeOf(f.admin, archived)],
      ['a top-level project that is not a meta', scopeOf(f.admin, loose)],
      ['no seat', { kind: 'project', org_id: other.org.id, project_id: other.sub.id }],
    ] as [string, OverviewScope][]) {
      const got = await answers(t, f.admin, scope)
      for (const [query, answer] of Object.entries(got))
        expect(answer, `${label}, ${query}`).toEqual({ state: 'unavailable' })
    }
  })

  it("answers unavailable with access_unchecked where a bound of the caller's own reads stopped a check, never a figure", async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await plantSeat(t, {
      org_id: f.org.id,
      accepted_at: NOW,
      auth_user_id: `auth_${uuid()}`,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: me.id,
        level: 'user',
      })
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub2.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      assignee_id: me.id,
      paused: true,
      due_date: shift(DAY, 2),
    })
    await countOrg(t, f.org.id)
    expect((await answers(t, me, scopeOf(me, f.meta))).summary.state).toBe('ok')
    Object.assign(OWN_READS, { projectShares: 0, rows: 0, lookups: 0, teamReads: 0, navRows: 0 })
    for (const scope of [scopeOf(me, f.meta), scopeOf(me, f.sub2), { kind: 'mine' } as const])
      for (const [query, answer] of Object.entries(await answers(t, me, scope)))
        expect(answer, query).toEqual({
          state: 'unavailable',
          reason: 'access_unchecked',
          message: expect.stringContaining('could not finish checking which projects you can see'),
        })
  })
})

// ------------------------------------------------------------------- the day

describe('the day', () => {
  it("counts as overdue what is due before the client's day, and not a task due that day", async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = (fields: Partial<Doc<'issues'>>) =>
      plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, ...fields })
    await task({ title: 'Yesterday', due_date: shift(DAY, -1) })
    await task({ title: 'Today', due_date: DAY })
    await task({ title: 'Done last week', due_date: shift(DAY, -5), status: 'done', done_at: NOW })
    await countOrg(t, f.org.id)
    const scope = scopeOf(f.user, f.meta)
    const on = await answers(t, f.user, scope, DAY)
    const next = await answers(t, f.user, scope, shift(DAY, 1))
    expect(on.summary).toMatchObject({ overdue: { state: 'ok', count: 1 } })
    expect(next.summary).toMatchObject({ overdue: { state: 'ok', count: 2 } })
    if (on.attention.state !== 'ok' || next.attention.state !== 'ok') throw new Error('unavailable')
    expect(titles(on.attention.rows)).toEqual(['Yesterday'])
    expect(titles(next.attention.rows)).toEqual(['Yesterday', 'Today'])
    expect(next.attention.rows.map((r) => r.at_risk)).toEqual([
      { kind: 'overdue' },
      { kind: 'overdue' },
    ])
  })
})

// ------------------------------------------------------------------ counting

describe('counting', () => {
  it('answers counting while an organization is not counted, a run counts it or a regroup runs in it, in both scopes', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Mine',
      assignee_id: f.user.id,
    })
    const scopes: [string, OverviewScope][] = [
      ['FW', scopeOf(f.user, f.sub)],
      ['TBED', scopeOf(f.user, f.meta)],
      ['My view', { kind: 'mine' }],
    ]
    /* each scope's counts figure, or its refusal */
    const counts = async () => {
      const out: Record<string, unknown> = {}
      for (const [label, scope] of scopes) {
        const got = await as(t, f.user).query(api.overview.summary, { scope, day: DAY })
        out[label] = got.state === 'ok' ? got.counts.state : got
      }
      return out
    }
    const counting = { FW: 'unavailable', TBED: 'unavailable', 'My view': 'unavailable' }
    const counted = { FW: 'ok', TBED: 'ok', 'My view': 'ok' }
    // not counted yet: the person holds no count row anywhere
    expect(await counts()).toEqual(counting)
    const summary = await as(t, f.user).query(api.overview.summary, {
      scope: { kind: 'mine' },
      day: DAY,
    })
    expect(summary).toMatchObject({ counts: { state: 'unavailable', reason: 'counting' } })
    await countOrg(t, f.org.id)
    expect(await counts()).toEqual(counted)
    // a run counting the organization again
    const run = await t.run((ctx) =>
      ctx.db.insert('overview_count_runs', {
        org_id: f.org.id,
        counting: true,
        generation: uuid(),
      }),
    )
    expect(await counts()).toEqual(counting)
    await t.run((ctx) => ctx.db.delete(run))
    expect(await counts()).toEqual(counted)
    // a regroup of a family where the person holds no row: every scope
    // waits for it, a project of another family too, because a regroup
    // reconciles a parent there whose subtask older code stored in its own
    const regroup = (family: Doc<'projects'>) =>
      t.run((ctx) =>
        ctx.db.insert('overview_regroups', {
          org_id: f.org.id,
          family_id: family.id,
          projects: [],
          at: 0,
          progress_at: NOW,
        }),
      )
    const elsewhere = await regroup(f.hidden)
    expect(await counts()).toEqual(counting)
    await t.run((ctx) => ctx.db.delete(elsewhere))
    expect(await counts()).toEqual(counted)
    await regroup(f.meta)
    expect(await counts()).toEqual(counting)
  })

  it("answers My view counting while one of the login's organizations is not counted", async () => {
    const t = newT()
    const f = await withOrg(t)
    const other = await withOrg(t)
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Mine',
      assignee_id: f.user.id,
    })
    // an admin there, who sees every project
    const there = await plantSeat(t, {
      org_id: other.org.id,
      org_role: 'admin',
      auth_user_id: f.user.auth_user_id,
    })
    await plantIssue(t, {
      org_id: other.org.id,
      project_id: other.sub.id,
      title: 'Mine there',
      assignee_id: there.id,
    })
    await countOrg(t, f.org.id)
    const mine = () =>
      as(t, f.user).query(api.overview.summary, { scope: { kind: 'mine' }, day: DAY })
    expect(await mine()).toMatchObject({ counts: { state: 'unavailable', reason: 'counting' } })
    await countOrg(t, other.org.id)
    expect(await mine()).toMatchObject({ counts: { state: 'ok', leaves: { todo: 2 } } })
  })
})

// --------------------------------------------------------------------- lists

/** withOrg, counted, with 20 paused tasks in FW due over four days, five on
 * each, and five undated, created in that order. */
async function pausedCase() {
  const t = newT()
  const f = await withOrg(t)
  const planted: Doc<'issues'>[] = []
  for (let i = 0; i < 25; i++)
    planted.push(
      await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        title: `Paused ${String(i).padStart(2, '0')}`,
        paused: true,
        ...(i < 20 ? { due_date: shift(DAY, 3 - (i % 4)) } : {}),
      }),
    )
  await countOrg(t, f.org.id)
  // earliest due date first, undated last, then creation time and id
  const expected = [...planted]
    .sort(
      (a, b) =>
        Number(a.due_date === undefined) - Number(b.due_date === undefined) ||
        (a.due_date ?? '').localeCompare(b.due_date ?? '') ||
        a._creationTime - b._creationTime ||
        (a._id < b._id ? -1 : 1),
    )
    .map((task) => task.title)
  return { t, f, planted, expected, scope: scopeOf(f.user, f.meta) }
}

describe('lists', () => {
  it('answers batches of 10 in due-date order, undated last, ties stable, to the true end', async () => {
    const { t, f, expected, scope } = await pausedCase()
    const batches = await pausedBatches(t, f.user, scope)
    expect(batches.map((b) => b.rows.length)).toEqual([10, 10, 5])
    expect(batches.every((b) => b.complete)).toBe(true)
    expect(batches.flatMap((b) => titles(b.rows))).toEqual(expected)
    expect(batches.at(-1)?.next).toBeNull()
    // asked again, each batch with its fixed end holds the same rows
    let cursor: string | undefined
    for (const batch of batches) {
      const again = await as(t, f.user).query(api.overview.paused, {
        scope,
        ...(cursor ? { cursor } : {}),
        ...(batch.end ? { end: batch.end } : {}),
      })
      expect(again).toMatchObject({ state: 'ok', complete: true })
      if (again.state === 'ok') expect(titles(again.rows)).toEqual(titles(batch.rows))
      cursor = batch.next ?? undefined
    }
  })

  it('keeps fixed batches free of duplicates and gaps as a row moves, and splits one grown past 20', async () => {
    const { t, f, planted, scope } = await pausedCase()
    const [first, second, third] = await pausedBatches(t, f.user, scope)
    const fixed = async () => {
      const ends = [
        { end: first.end as string },
        { cursor: first.next as string, end: second.end as string },
        { cursor: second.next as string },
      ]
      return await Promise.all(
        ends.map((at) => as(t, f.user).query(api.overview.paused, { scope, ...at })),
      )
    }
    // the first row of the first batch moves past the second batch
    const moved = planted.find((task) => task.title === first.rows[0].title) as Doc<'issues'>
    await t.run((ctx) => ctx.db.patch(moved._id, { due_date: shift(DAY, 30) }))
    let got = await fixed()
    const all = got.flatMap((b) => (b.state === 'ok' ? titles(b.rows) : []))
    expect(all).toHaveLength(25)
    expect(new Set(all).size).toBe(25)
    expect(got[0].state === 'ok' && titles(got[0].rows)).not.toContain(moved.title)
    expect(got[2].state === 'ok' && titles(got[2].rows)).toContain(moved.title)
    expect(third.rows).toHaveLength(5)

    // 15 more inside the first batch's span make it 24 rows: it answers a
    // middle position, and its two halves hold every one of them once
    for (let i = 0; i < 15; i++)
      await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        title: `Late paused ${i}`,
        paused: true,
        due_date: shift(DAY, 0),
      })
    await countOrg(t, f.org.id)
    got = await fixed()
    const grown = got[0]
    if (grown.state !== 'ok' || grown.split === undefined) throw new Error(JSON.stringify(grown))
    expect(grown.rows).toHaveLength(OVERVIEW.batch)
    const halves = await Promise.all([
      as(t, f.user).query(api.overview.paused, { scope, end: grown.split }),
      as(t, f.user).query(api.overview.paused, {
        scope,
        cursor: grown.split,
        end: first.end as string,
      }),
    ])
    const halfRows = halves.flatMap((b) => (b.state === 'ok' ? titles(b.rows) : []))
    expect(halfRows.slice(0, OVERVIEW.batch)).toEqual(titles(grown.rows))
    expect(new Set(halfRows).size).toBe(halfRows.length)
    expect(halfRows.length).toBeGreaterThan(OVERVIEW.split)
  })

  it('refuses a position from another list, scope or reader, a changed one and junk', async () => {
    const { t, f, scope } = await pausedCase()
    const [first] = await pausedBatches(t, f.user, scope)
    const next = first.next as string
    const paused = (args: { scope?: OverviewScope; cursor?: string; end?: string }, me = f.user) =>
      as(t, me).query(api.overview.paused, { scope, ...args })
    // a position is sealed hex, which names no task, date or time
    expect(next).toMatch(/^op1~[0-9a-f]+$/)
    for (const row of first.rows) expect(next).not.toContain(row.id)
    await expectRefusal(
      paused({ scope: scopeOf(f.user, f.sub), cursor: next }),
      'bad_request',
      /cursor/,
    )
    await expectRefusal(paused({ cursor: next }, f.admin), 'bad_request', /cursor/)
    await expectRefusal(
      paused({ end: next.replace(/.$/, (c) => (c === '0' ? '1' : '0')) }),
      'bad_request',
      /end/,
    )
    await expectRefusal(paused({ cursor: 'op1~zz' }), 'bad_request', /cursor/)
    await expectRefusal(
      as(t, f.user).query(api.overview.attention, { scope, ...WEEKS, cursor: next }),
      'bad_request',
      /cursor/,
    )
    // an At-risk position is bound to the client's day and weeks too. More
    // than a batch is overdue on a Thursday, and each clock below moves its
    // day, its week, its week starts or its week end and stays well formed
    // (lib/viewLoads.ts clockOf), so the cursor's binding is what refuses it
    for (let i = 0; i < 11; i++)
      await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        title: `Overdue ${i}`,
        due_date: shift(DAY, -1 - i),
      })
    const thursday = { ...WEEKS, day: shift(DAY, 3) }
    const attention = (over: Partial<typeof WEEKS> & { cursor?: string }) =>
      as(t, f.user).query(api.overview.attention, { scope, ...thursday, ...over })
    const risky = await attention({})
    if (risky.state !== 'ok' || risky.next === null) throw new Error(JSON.stringify(risky))
    const cursor = risky.next
    expect(await attention({ cursor })).toMatchObject({ state: 'ok' })
    const shifted = WEEKS.week_starts.map((s, i) => (i >= 20 ? s - 3_600_000 : s))
    // a later week keeps its clock well formed, its starts and end a day
    // later too, so the cursor's binding is what refuses it
    const laterWeek = {
      week: shift(DAY, 1),
      week_starts: WEEKS.week_starts.map((s) => s + 86_400_000),
      week_end: WEEKS.week_end + 86_400_000,
    }
    for (const over of [
      { day: shift(DAY, 4) },
      laterWeek,
      { week_starts: shifted },
      { week_end: WEEKS.week_end + 3_600_000 },
    ])
      await expectRefusal(attention({ ...over, cursor }), 'bad_request', /cursor/)
  })

  it("binds positions to the login: 50 seats page whole, a seat gained keeps them, and the scope's seat lost answers unavailable", async () => {
    const { t, f, expected, scope } = await pausedCase()
    const login = f.user.auth_user_id as string
    for (let i = 0; i < 49; i++) await plantSeat(t, { org_id: uuid(), auth_user_id: login })
    const batches = await pausedBatches(t, f.user, scope)
    expect(batches.flatMap((b) => titles(b.rows))).toEqual(expected)
    // each batch again with its cursor and fixed end
    let cursor: string | undefined
    for (const batch of batches) {
      const again = await as(t, f.user).query(api.overview.paused, {
        scope,
        ...(cursor ? { cursor } : {}),
        ...(batch.end ? { end: batch.end } : {}),
      })
      expect(again).toMatchObject({ state: 'ok', complete: true })
      if (again.state === 'ok') expect(titles(again.rows)).toEqual(titles(batch.rows))
      cursor = batch.next ?? undefined
    }
    const [first, second] = batches
    const rest = { cursor: first.next as string, end: second.end as string }
    // a seat gained in another organization keeps the positions
    const other = await withOrg(t)
    await plantSeat(t, { org_id: other.org.id, auth_user_id: login })
    const kept = await as(t, f.user).query(api.overview.paused, { scope, ...rest })
    expect(kept.state === 'ok' && titles(kept.rows)).toEqual(titles(second.rows))
    // the scope's own seat lost: unavailable, as without a position
    await t.run((ctx) => ctx.db.patch(f.user._id, { active: false }))
    expect(await as(t, f.user).query(api.overview.paused, { scope, ...rest })).toEqual({
      state: 'unavailable',
    })
  })

  it('stops a batch its reads do not fit as incomplete, with the rows it kept and their parents in another project, the next going on with no gap or duplicate', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = (fields: Partial<Doc<'issues'>>) =>
      plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, paused: true, ...fields })
    const parent = await task({ project_id: f.sub2.id, title: 'Parent in PCB', paused: false })
    // 5 paused leaves, 40 paused groups the list leaves out, then 15
    // leaves, so a batch reads and judges candidates in several rounds
    const expected: string[] = []
    for (let i = 0; i < 60; i++) {
      const due_date = shift(DAY, i)
      if (i < 5 || i >= 45) {
        const title = `Leaf ${String(i).padStart(2, '0')}`
        expected.push(title)
        await task({ title, due_date, parent_id: parent.id })
        continue
      }
      const group = await task({ title: `Group ${i}`, due_date })
      await task({ title: `Its subtask ${i}`, parent_id: group.id, paused: false })
    }
    const scope = scopeOf(f.admin, f.sub)
    const profiles = new Map([[f.admin.org_id, f.admin]])
    const { took } = await measured(t, (ctx) => readPaused(ctx, profiles, LOGIN, { scope }))
    let stops = 0
    for (let documents = took.documents + 300; documents > 0; documents--) {
      Object.assign(OVERVIEW.reads, { documents })
      const got = await walkPaused(t, f.admin, scope)
      for (const row of got.batches.flatMap((b) => b.rows)) expect(row.parent_id).toBe(parent.id)
      // a batch its reads stopped still answers the rows it kept, with room
      // held back for their parents
      stops += got.batches.filter((b) => !b.complete && b.rows.length > 0).length
      if (got.refused !== null) {
        // a batch that cannot judge one candidate refuses, never answering
        // its own cursor as where to go on
        expect(got.refused).toEqual({ state: 'over_budget' })
        if (got.batches.length === 0) break
        continue
      }
      expect(
        got.batches.flatMap((b) => titles(b.rows)),
        `${documents} documents`,
      ).toEqual(expected)
    }
    expect(stops).toBeGreaterThan(0)
  })

  it("answers over_budget where My view's reviewer range does not fit, never throwing", async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 60; i++)
      await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        title: `For review ${i}`,
        status: 'review',
        assignee_id: f.admin.id,
        reviewer_id: f.user.id,
      })
    const scope = { kind: 'mine' } as const
    const profiles = new Map([[f.user.org_id, f.user]])
    const { took, answer } = await measured(t, (ctx) => readPaused(ctx, profiles, LOGIN, { scope }))
    expect(answer).toMatchObject({ state: 'ok', complete: true })
    Object.assign(OVERVIEW.reads, { documents: took.documents - 30 })
    expect(await as(t, f.user).query(api.overview.paused, { scope })).toEqual({
      state: 'over_budget',
    })
    expect(await as(t, f.user).query(api.overview.attention, { scope, ...WEEKS })).toEqual({
      state: 'over_budget',
    })
  })

  it('links a row to a parent the reader is shown, and flags a hidden parent and hidden subtasks', async () => {
    const { t, f, me } = await hiddenCase('x')
    const task = (fields: Partial<Doc<'issues'>>) =>
      plantIssue(t, { org_id: f.org.id, assignee_id: me.id, project_id: f.sub.id, ...fields })
    const hidden = await task({ project_id: f.sub2.id, title: 'Hidden parent' })
    await task({ title: 'Under a hidden parent', parent_id: hidden.id, due_date: shift(DAY, -2) })
    const shown = await task({ title: 'Shown parent' })
    await task({ title: 'Under a shown parent', parent_id: shown.id, due_date: shift(DAY, -1) })
    for (const scope of [scopeOf(me, f.sub), { kind: 'mine' } as const]) {
      const got = await as(t, me).query(api.overview.attention, { scope, ...WEEKS })
      if (got.state !== 'ok') throw new Error(JSON.stringify(got))
      const row = (title: string) => got.rows.find((r) => r.title === title)
      expect(row('Overdue group'), scope.kind).toMatchObject({
        has_subtasks: true,
        has_hidden_subtasks: true,
      })
      expect(row('Under a hidden parent'), scope.kind).toMatchObject({ has_hidden_parent: true })
      expect(row('Under a hidden parent'), scope.kind).not.toHaveProperty('parent_id')
      expect(row('Under a shown parent'), scope.kind).toMatchObject({
        parent_id: shown.id,
        has_hidden_parent: false,
        has_subtasks: false,
        has_hidden_subtasks: false,
      })
    }
  })

  it('totals do not depend on the batches loaded', async () => {
    const { t, f, scope } = await pausedCase()
    const before = await as(t, f.user).query(api.overview.summary, { scope, day: DAY })
    await pausedBatches(t, f.user, scope)
    expect(await as(t, f.user).query(api.overview.summary, { scope, day: DAY })).toEqual(before)
    expect(before).toMatchObject({ counts: { state: 'ok', paused: 25 } })
  })
})

// ------------------------------------------------------------------ verdicts

/** withOrg with FW tracking delay, a guest with a grant on FW, and in FW a
 * task of `user` projected late: 200 hours at 40 a week, due in ten days. */
async function verdictCase() {
  const t = newT()
  const f = await withOrg(t)
  await t.run((ctx) => ctx.db.patch(f.sub._id, { track_delay: true }))
  const guest = await plantSeat(t, {
    org_id: f.org.id,
    org_role: 'guest',
    auth_user_id: `auth_${uuid()}`,
  })
  await t.run((ctx) =>
    ctx.db.insert('project_access', { project_id: f.sub.id, profile_id: guest.id, level: 'user' }),
  )
  const late = (title: string, owner: Doc<'profiles'>, due = shift(DAY, 10)) =>
    plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title,
      assignee_id: owner.id,
      start_week: DAY,
      end_week: shift(DAY, 7),
      due_date: due,
      remaining_hours: 200,
      remaining_set_at: `${DAY}T12:00:00.000Z`,
    })
  await late('Too big for one week', f.user)
  await countOrg(t, f.org.id)
  return { t, f, guest, late }
}

describe('verdicts', () => {
  it("gives a guest one owner's load a query, and a projection that needs another unavailable", async () => {
    const { t, f, guest, late } = await verdictCase()
    const risk = (me: Doc<'profiles'>) =>
      as(t, me).query(api.overview.risk, { scope: scopeOf(me, f.sub), ...WEEKS })
    expect(await risk(guest)).toEqual({ state: 'ok', projected: { state: 'ok', count: 1 } })
    await late('Too big for its owner too', f.admin)
    await countOrg(t, f.org.id)
    expect(await risk(guest)).toEqual({
      state: 'ok',
      projected: { state: 'unavailable', reason: 'loads' },
    })
    expect(await risk(f.user)).toEqual({ state: 'ok', projected: { state: 'ok', count: 2 } })
    // the guest's At-risk list stops at the second owner, and goes on
    const first = await as(t, guest).query(api.overview.attention, {
      scope: scopeOf(guest, f.sub),
      ...WEEKS,
    })
    if (first.state !== 'ok') throw new Error(JSON.stringify(first))
    expect(first.rows).toHaveLength(1)
    expect(first.complete).toBe(false)
    const rest = await as(t, guest).query(api.overview.attention, {
      scope: scopeOf(guest, f.sub),
      ...WEEKS,
      cursor: first.next as string,
    })
    expect(rest).toMatchObject({ state: 'ok', complete: true, next: null })
    if (rest.state === 'ok') expect(rest.rows).toHaveLength(1)
  })

  it("answers a guest's batch that kept 10 rows complete when the next candidate needs another owner", async () => {
    const { t, f, guest, late } = await verdictCase()
    for (let i = 0; i < 9; i++) await late(`Also too big ${i}`, f.user)
    await late('Too big for its owner too', f.admin, shift(DAY, 11))
    await countOrg(t, f.org.id)
    const scope = scopeOf(guest, f.sub)
    const first = await as(t, guest).query(api.overview.attention, { scope, ...WEEKS })
    if (first.state !== 'ok') throw new Error(JSON.stringify(first))
    expect(first).toMatchObject({ complete: true })
    expect(first.rows).toHaveLength(OVERVIEW.batch)
    expect(first.next).toBe(first.end)
    const rest = await as(t, guest).query(api.overview.attention, {
      scope,
      ...WEEKS,
      cursor: first.next as string,
    })
    expect(rest).toMatchObject({ state: 'ok', complete: true, next: null })
    if (rest.state === 'ok') expect(titles(rest.rows)).toEqual(['Too big for its owner too'])
  })

  it("keeps a task whose owner's load no batch can read as unknown, and goes on past it", async () => {
    const { t, f, late } = await verdictCase()
    const third = await plantSeat(t, { org_id: f.org.id, name: 'Third', accepted_at: BEFORE_RULE })
    // the user's load passes the bound below in every batch, with two open
    // tasks; the admin and the third owner hold one each
    await late('Theirs too', f.user, shift(DAY, 10))
    await late("The admin's, before", f.admin, shift(DAY, 9))
    await late("The third owner's, after", third, shift(DAY, 12))
    await countOrg(t, f.org.id)
    Object.assign(OWNER_LOADS, { open: 1 })
    const scope = scopeOf(f.admin, f.sub)
    const rows: OverviewRow[] = []
    const batches: boolean[] = []
    let cursor: string | undefined
    for (let n = 0; n < 10; n++) {
      const got = await as(t, f.admin).query(api.overview.attention, {
        scope,
        ...WEEKS,
        ...(cursor ? { cursor } : {}),
      })
      if (got.state !== 'ok') throw new Error(JSON.stringify(got))
      if (cursor !== undefined) expect(got.next).not.toBe(cursor)
      rows.push(...got.rows)
      batches.push(got.complete)
      if (got.next === null) break
      cursor = got.next
    }
    // the first batch stops at the user's task after judging the admin's;
    // the next keeps both of theirs as unknown and goes on
    expect(batches).toEqual([false, true])
    expect(rows.map((r) => [r.title, r.at_risk?.kind])).toEqual([
      ["The admin's, before", 'projected'],
      ['Too big for one week', 'unknown'],
      ['Theirs too', 'unknown'],
      ["The third owner's, after", 'projected'],
    ])
  })

  it("answers unavailable, never fewer, when an owner's load passes the reader's bounds", async () => {
    const { t, f } = await verdictCase()
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      title: 'More of their work',
      assignee_id: f.user.id,
      start_week: DAY,
      end_week: shift(DAY, 7),
      remaining_hours: 10,
    })
    await countOrg(t, f.org.id)
    Object.assign(OWNER_LOADS, { open: 1 })
    expect(
      await as(t, f.admin).query(api.overview.risk, { scope: scopeOf(f.admin, f.meta), ...WEEKS }),
    ).toEqual({ state: 'ok', projected: { state: 'unavailable', reason: 'loads' } })
  })
})

// --------------------------------------------------------------- hidden data

/** withOrg as a member who sees FW only, with an overdue group in FW whose
 * subtask is in PCB, which they cannot see, holding `title`, and a task of
 * theirs in PCB of that title. */
async function hiddenCase(title: string) {
  const t = newT()
  const f = await withOrg(t)
  const me = await plantSeat(t, {
    org_id: f.org.id,
    org_role: 'user',
    auth_user_id: `auth_${uuid()}`,
  })
  await t.run((ctx) =>
    ctx.db.insert('project_access', { project_id: f.sub.id, profile_id: me.id, level: 'user' }),
  )
  const group = await plantIssue(t, {
    org_id: f.org.id,
    project_id: f.sub.id,
    title: 'Overdue group',
    due_date: shift(DAY, -3),
    assignee_id: me.id,
  })
  await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, title, parent_id: group.id })
  await plantIssue(t, {
    org_id: f.org.id,
    project_id: f.sub2.id,
    title,
    assignee_id: me.id,
    paused: true,
  })
  await plantIssue(t, {
    org_id: f.org.id,
    project_id: f.sub.id,
    title: 'Paused here',
    assignee_id: me.id,
    paused: true,
    due_date: shift(DAY, 4),
  })
  await countOrg(t, f.org.id)
  return { t, f, me }
}

/* An answer without its ids and positions, which differ between two
 * deployments. */
const shapeOf = (answer: unknown): unknown =>
  JSON.parse(
    JSON.stringify(answer, (key, value) =>
      [
        'id',
        'parent_id',
        'project_id',
        'assignee_id',
        'reviewer_id',
        'org_id',
        'next',
        'end',
        'num',
        'key',
        'created_at',
        'updated_at',
        'status_at',
        'reporter_id',
        'created_by',
        'sub_projects',
      ].includes(key)
        ? undefined
        : value,
    ),
  )

describe('hidden data', () => {
  it("answers alike whatever a hidden subtask's or own task's title, also at a budget the visible reads just fit", async () => {
    const short = await hiddenCase('x')
    const long = await hiddenCase('漢'.repeat(255))
    for (const scopeKind of ['meta', 'mine'] as const) {
      const scopeFor = (c: typeof short) =>
        scopeKind === 'meta' ? scopeOf(c.me, c.f.meta) : ({ kind: 'mine' } as const)
      const a = await answers(short.t, short.me, scopeFor(short))
      const b = await answers(long.t, long.me, scopeFor(long))
      expect(shapeOf(b), scopeKind).toEqual(shapeOf(a))
      expect(a.summary).toMatchObject({ overdue: { state: 'ok', count: 1 } })
    }
    // the budget lowered to what the short case's summary read: both answer
    // the same, whatever they fit
    const read = (c: typeof short) =>
      measured(c.t, (ctx) =>
        readSummary(ctx, new Map([[c.me.org_id, c.me]]), { scope: { kind: 'mine' }, day: DAY }),
      )
    const { took } = await read(short)
    for (const ranges of [took.ranges, took.ranges - 5]) {
      Object.assign(OVERVIEW.reads, { ranges })
      expect(shapeOf((await read(long)).answer), `${ranges} ranges`).toEqual(
        shapeOf((await read(short)).answer),
      )
    }
  })
})

// --------------------------------------------------------------- real limits

/* What one Overview read took, logged for the stage's report. */
const record = (label: string, took: unknown, answer: unknown) =>
  console.log(
    `overview reads, ${label}: ${JSON.stringify(took)} ${JSON.stringify(answer).slice(0, 200)}`,
  )

/* The state of each figure of a summary. */
const states = (s: Awaited<ReturnType<typeof readSummary>>) =>
  s.state !== 'ok'
    ? s.state
    : { counts: s.counts.state, any_task: s.any_task.state, overdue: s.overdue.state }

describe('real limits', () => {
  it('counts 300 tasks of one sub-project whole, and answers Overdue unavailable past a lowered budget', async () => {
    const t = newT({ transactionLimits: true })
    const f: OrgFixture = await withOrg(t)
    const owners = await plantPeople(t, f.org.id, 20)
    // every dated task due before the day, Done ones and groups included
    await plantMix(t, f.sub, 300, owners, BEFORE_RULE, true)
    await countOrg(t, f.org.id)
    const profiles = new Map([[f.user.org_id, f.user]])
    const scope = scopeOf(f.user, f.sub)
    // Overdue reads about a range for each task due before the day, so at
    // 200 ranges it stops past them, as thousands of tasks pass the real
    // budget
    for (const [ranges, overdue] of [
      [OVERVIEW.reads.ranges, 'ok'],
      [200, 'unavailable'],
    ] as const) {
      Object.assign(OVERVIEW.reads, { ranges })
      const summary = await measured(t, (ctx) => readSummary(ctx, profiles, { scope, day: DAY }))
      record(
        `one sub-project, 300 tasks due before the day, ${ranges} ranges`,
        summary.took,
        states(summary.answer),
      )
      expect(states(summary.answer)).toEqual({ counts: 'ok', any_task: 'ok', overdue })
      const batch = await measured(t, (ctx) =>
        readAttention(ctx, profiles, LOGIN, { scope, ...WEEKS }),
      )
      record('one sub-project, 300 tasks, first At-risk batch', batch.took, batch.answer.state)
      expect(batch.answer).toMatchObject({ state: 'ok', complete: true })
      const paused = await measured(t, (ctx) => readPaused(ctx, profiles, LOGIN, { scope }))
      record('one sub-project, 300 tasks, first Paused batch', paused.took, paused.answer.state)
      expect(paused.answer).toMatchObject({ state: 'ok', complete: true })
    }
  })

  it('reads 600 tasks over a project of 30 sub-projects that a team of the reader shares', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const me = await plantSeat(t, {
      org_id: f.org.id,
      org_role: 'user',
      auth_user_id: `auth_${uuid()}`,
      accepted_at: BEFORE_RULE,
    })
    const owners = [me, ...(await plantPeople(t, f.org.id, 9))]
    const { tops, subs } = await plantShared(t, f.org.id, f.user, me, { tops: 1, subs: 30 })
    for (const sub of subs) await plantMix(t, sub, 20, owners, BEFORE_RULE)
    // the reach rows that let the member navigate to the shared sub-projects
    await withReach(t)
    await countOrg(t, f.org.id)
    const profiles = new Map([[me.org_id, me]])
    await expectAllOk(
      t,
      profiles,
      '30 shared sub-projects',
      scopeOf(me, tops[0] as Doc<'projects'>),
    )
  })

  it("reads My view of 400 of the reader's tasks over the 200 sub-projects their teams share", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const me = await plantSeat(t, {
      org_id: f.org.id,
      org_role: 'user',
      auth_user_id: `auth_${uuid()}`,
      accepted_at: BEFORE_RULE,
    })
    // 100 projects of two sub-projects each, 33 or 34 shared with each of
    // the reader's three teams
    const { subs } = await plantShared(t, f.org.id, f.user, me, { tops: 100, subs: 2 })
    expect(subs).toHaveLength(200)
    for (const [i, sub] of subs.entries())
      await plantTasks(t, sub, 2, (k) => ({
        assignee_id: me.id,
        title: `Mine ${i}-${k}`,
        paused: k === 0 && i % 2 === 0,
        due_date: shift(DAY, ((i * 7 + k) % 30) - 10),
      }))
    await withReach(t)
    await countOrg(t, f.org.id)
    const profiles = new Map([[me.org_id, me]])
    await expectAllOk(t, profiles, 'My view over 200 sub-projects', { kind: 'mine' })
  })
})

/* Checks that the four Overview reads for `scope` answer, and logs what
 * each read took. */
async function expectAllOk(
  t: T,
  profiles: Map<string, Doc<'profiles'>>,
  label: string,
  scope: OverviewScope,
) {
  const summary = await measured(t, (ctx) => readSummary(ctx, profiles, { scope, day: DAY }))
  record(`${label}, summary`, summary.took, states(summary.answer))
  expect(states(summary.answer)).toEqual({ counts: 'ok', any_task: 'ok', overdue: 'ok' })
  const risk = await measured(t, (ctx) => readRisk(ctx, profiles, { scope, ...WEEKS }))
  record(`${label}, risk`, risk.took, risk.answer)
  expect(risk.answer.state).toBe('ok')
  const batch = await measured(t, (ctx) => readAttention(ctx, profiles, LOGIN, { scope, ...WEEKS }))
  record(`${label}, first At-risk batch`, batch.took, batch.answer.state)
  expect(batch.answer.state).toBe('ok')
  const paused = await measured(t, (ctx) => readPaused(ctx, profiles, LOGIN, { scope }))
  record(`${label}, first Paused batch`, paused.took, paused.answer.state)
  expect(paused.answer).toMatchObject({ state: 'ok', complete: true })
}

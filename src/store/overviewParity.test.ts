/* The Overview's server reads (convex/overview.ts) against the app's own
 * figures. Each case boots the real store from the caller's real workspace,
 * as boardParity.test.ts does, with the clock frozen before the store loads
 * so its TODAY_ISO and TODAY_WEEK are the day and week the queries are
 * sent, and compares what the queries answer for the same caller with what
 * the page derives (src/views/overviewFigures.ts): the summary against
 * overviewFigures and statusCounts, the Overdue & at risk rows against its
 * list, as a set and in due-date order, the Paused rows against its paused
 * tasks by due date, undated last, and every health row against healthRows
 * through the per-sub-project reader (lib/overview.ts subProjectHealth).
 *
 * The process runs in New York's time zone, so the client's local weeks
 * differ from UTC weeks near midnight; vitest runs each file in a process
 * of its own. Northstar runs as Nora (admin), Leo and Ben over every scope;
 * the small fixture runs every access shape for a user, a guest and a
 * viewer, and the admin, over plants the brief names. Cases that must fail
 * if a rule drifts compare a drifted rule with the server's answer. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import { byId } from '../../convex/lib/db'
import type { ListAnswer, OverviewRow, OverviewScope } from '../../convex/lib/overview'
import { clockOf, OVERVIEW, subProjectHealth, verdicts } from '../../convex/lib/overview'
import { viewAccess, viewBudget } from '../../convex/lib/viewReads'
import { addCounts, noCounts } from '../../convex/model/overviewCounts'
import { SHAPES } from '../../convex/tests/accessShapes.setup'
import { projectScope } from '../../convex/tests/board.setup'
import {
  as,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
  workspaceOf,
} from '../../convex/tests/helpers.setup'
import { northstarId, plantNorthstar } from '../../convex/tests/northstar.setup'
import { countOrg } from '../../convex/tests/overviewCounts.setup'
import { withReach } from '../../convex/tests/projectReach.setup'
import type { Snapshot } from './plannerFixture.setup'

vi.hoisted(() => {
  // the client's zone, set before any module reads the clock
  process.env.TZ = 'America/New_York'
  process.env.BETTER_AUTH_SECRET ??= 'overview-parity-secret-not-a-deployment-key'
})

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** A fresh store whose first delivery is `snap`, with the page's figures
 * read from the same store. */
async function start(snap: Snapshot) {
  vi.resetModules()
  vi.stubGlobal('window', { showToast: vi.fn() })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  network.onUpdate.mockImplementation((_ref, _args, next) => {
    next(structuredClone(snap))
    return () => {}
  })
  const store = await import('./planner')
  await store.initStore()
  const figures = await import('../views/overviewFigures')
  return Object.assign(store.P, { figures })
}

type Store = Awaited<ReturnType<typeof start>>
type Issue = Store['issues'][number]

/** The store booted for `profile` from their workspace, with the clock at
 * `now` before the store's modules load. */
async function storeOf(t: T, profile: Doc<'profiles'>, now: number): Promise<Store> {
  const snap = await workspaceOf(as(t, profile))
  if (snap === null) throw new Error(`no workspace for ${profile.name}`)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  return await start(snap)
}

/** The client's day and weeks as the store's own timeline gives them: its
 * day, the first day of its week, the instants its last 53 local weeks
 * began at and the instant the next one begins at. */
function clientDays(P: Store) {
  return {
    day: P.TODAY_ISO,
    week: P.isoFromDate(P.weekToDate(P.TODAY_WEEK)),
    week_starts: Array.from({ length: 53 }, (_, i) =>
      P.weekToDate(P.TODAY_WEEK - 52 + i).getTime(),
    ),
    week_end: P.weekToDate(P.TODAY_WEEK + 1).getTime(),
  }
}

/** The same weeks as UTC days would place them, as a server that judged
 * instants in UTC would. */
function utcDays(P: Store) {
  const days = clientDays(P)
  return {
    ...days,
    week_starts: Array.from({ length: 53 }, (_, i) =>
      Date.parse(`${P.isoFromDate(P.weekToDate(P.TODAY_WEEK - 52 + i))}T00:00:00.000Z`),
    ),
    week_end: Date.parse(`${P.isoFromDate(P.weekToDate(P.TODAY_WEEK + 1))}T00:00:00.000Z`),
  }
}

const sorted = (ids: Iterable<string>) => [...ids].sort()

/** Every batch of a list from its start, each complete unless `partial`:
 * a guest's or Viewer's At-risk batch stops at the second owner whose load
 * it needs, and the next goes on from there. */
async function wholeList(
  read: (cursor?: string) => Promise<ListAnswer>,
  label: string,
  partial = false,
): Promise<OverviewRow[]> {
  const rows: OverviewRow[] = []
  let cursor: string | undefined
  for (let n = 0; n < 100; n++) {
    const got = await read(cursor)
    if (got.state !== 'ok') throw new Error(`${label}: ${JSON.stringify(got)}`)
    if (!partial) expect(got.complete, `${label}: complete`).toBe(true)
    expect(got.rows.length, `${label}: batch`).toBeLessThanOrEqual(OVERVIEW.batch)
    rows.push(...got.rows)
    if (got.next === null) return rows
    cursor = got.next
  }
  throw new Error(`${label}: the list did not end`)
}

/** The due dates of `items` in order, undated last as '~'. */
const dues = (items: { due?: string | null; due_date?: string }[]) =>
  items.map((it) => ('due_date' in it ? it.due_date : it.due) || '~')

/** Compares the four queries and the health reader for `profile` over
 * `scope`, the store scope `scopeId`, with what store `P` derives. Answers
 * how many tasks the scope held, for a caller that checks its cases
 * compared something. */
async function expectParity(
  t: T,
  P: Store,
  profile: Doc<'profiles'>,
  scope: OverviewScope,
  scopeId: string,
  label: string,
): Promise<number> {
  const info = P.scopeInfo(scopeId)
  const days = clientDays(P)
  const caller = as(t, profile)
  const summary = await caller.query(api.overview.summary, { scope, day: days.day })
  const risk = await caller.query(api.overview.risk, { scope, ...days })
  // a scope the store does not hold is one the server does not either
  if (info === null) {
    expect(summary, `${label}: unavailable`).toEqual({ state: 'unavailable' })
    expect(risk, `${label}: risk unavailable`).toEqual({ state: 'unavailable' })
    return 0
  }
  if (summary.state !== 'ok' || risk.state !== 'ok')
    throw new Error(`${label}: ${JSON.stringify([summary, risk])}`)
  const scoped = P.scopedIssues(info)
  const f = P.figures.overviewFigures(info, scoped)

  // the summary
  if (summary.counts.state !== 'ok') throw new Error(`${label}: ${JSON.stringify(summary.counts)}`)
  const leaves = summary.counts.leaves
  const total = Object.values(leaves).reduce((n, c) => n + c, 0)
  expect({ done: leaves.done, total }, `${label}: completion`).toEqual({
    done: f.prog.done,
    total: f.prog.total,
  })
  expect(leaves.progress, `${label}: in progress`).toBe(f.inProgress)
  expect(leaves.review, `${label}: in review`).toBe(f.inReview)
  expect(leaves, `${label}: status distribution`).toEqual(P.figures.statusCounts(scoped))
  expect(summary.counts.paused, `${label}: paused`).toBe(f.pausedIssues.length)
  expect(summary.overdue, `${label}: overdue`).toEqual({ state: 'ok', count: f.overdueCount })
  expect(summary.any_task, `${label}: any task`).toEqual({ state: 'ok', value: scoped.length > 0 })
  if (scope.kind === 'project')
    expect(sorted(summary.sub_projects ?? []), `${label}: sub-projects`).toEqual(
      sorted(info.subIds),
    )
  // a guest or an organization Viewer gets at most one owner's load a
  // query, so a projection that needs more is unavailable for that reason
  const staff = profile.org_role === 'admin' || profile.org_role === 'user'
  if (staff || risk.projected.state === 'ok')
    expect(risk.projected, `${label}: projected`).toEqual({
      state: 'ok',
      count: f.atRiskIssues.length - f.overdueCount,
    })
  else
    expect(risk.projected, `${label}: projected`).toEqual({ state: 'unavailable', reason: 'loads' })

  // the Overdue & at risk list, as a set and in due-date order, ties as sets
  const byUuid = new Map(Object.values(P.issueById).map((it: Issue) => [it.uuid, it]))
  const attention = await wholeList(
    (cursor) =>
      caller.query(api.overview.attention, { scope, ...days, ...(cursor ? { cursor } : {}) }),
    `${label}: at risk`,
    !staff,
  )
  expect(sorted(attention.map((r) => r.id)), `${label}: at-risk rows`).toEqual(
    sorted(f.atRiskIssues.map((it) => it.uuid)),
  )
  expect(dues(attention), `${label}: at-risk order`).toEqual(dues(f.atRiskIssues))
  for (const row of attention) {
    const it = byUuid.get(row.id) as Issue
    if (it.due < P.TODAY_ISO)
      expect(row.at_risk, `${label}: ${it.key}`).toEqual({ kind: 'overdue' })
    else {
      const fin = P.delayOf(it)?.fin
      expect(row.at_risk, `${label}: ${it.key}`).toEqual({
        kind: 'projected',
        finish_week: fin == null ? null : P.isoFromDate(P.weekToDate(fin)),
      })
    }
  }

  // the Paused list by due date, undated last, ties as sets
  const paused = await wholeList(
    (cursor) => caller.query(api.overview.paused, { scope, ...(cursor ? { cursor } : {}) }),
    `${label}: paused`,
  )
  expect(sorted(paused.map((r) => r.id)), `${label}: paused rows`).toEqual(
    sorted(f.pausedIssues.map((it) => it.uuid)),
  )
  const pausedOrder = [...f.pausedIssues].sort((a, b) => order(a.due || '~', b.due || '~'))
  expect(dues(paused), `${label}: paused order`).toEqual(dues(pausedOrder))

  // the health rows, through the per-sub-project reader
  const mine = P.isMineScope(scopeId)
  if (info.isMeta || mine) {
    const rows = P.figures.healthRows(info, scoped, mine)
    const pieces = await t.run(async (ctx) => {
      const guard = viewBudget(ctx, OVERVIEW.reads)
      const seats = new Map([[profile.org_id, viewAccess(ctx, guard, profile)]])
      const v = verdicts(ctx, guard, seats, clockOf(days))
      const out: Record<
        string,
        { counts: ReturnType<typeof noCounts>; late: number; behind: number; delays: boolean }
      > = {}
      for (const g of info.groups) {
        let counts = noCounts()
        let late = 0
        let behind = 0
        let delays = true
        for (const id of g.subIds) {
          const project = (await byId(ctx, 'projects', id)) as Doc<'projects'>
          const piece = await subProjectHealth(
            ctx,
            guard,
            seats,
            project,
            v,
            mine ? profile : undefined,
          )
          if (piece.counts.state !== 'ok')
            throw new Error(`${label}: health of ${project.name}: ${JSON.stringify(piece)}`)
          counts = addCounts(counts, piece.counts)
          if (piece.delays.state === 'ok') {
            late += piece.delays.late
            behind += piece.delays.behind
          } else if (staff || piece.delays.reason !== 'loads')
            throw new Error(`${label}: delays of ${project.name}: ${JSON.stringify(piece)}`)
          else delays = false
        }
        out[g.proj.id] = { counts, late, behind, delays }
      }
      return out
    })
    for (const row of rows) {
      const piece = pieces[row.proj.id]
      if (piece === undefined) throw new Error(`${label}: no health row for ${row.proj.name}`)
      const done = piece.counts.leaves.done
      const all = Object.values(piece.counts.leaves).reduce((n, c) => n + c, 0)
      // a guest's or Viewer's delays that need more than one owner's load
      // are unavailable, and only those
      const delays = (r: { late: number; behind: number }) =>
        piece.delays ? { late: r.late, behind: r.behind } : {}
      expect(
        {
          done,
          total: all,
          pct: all ? Math.round((done / all) * 100) : 0,
          remaining: piece.counts.left_tenths / 10,
          paused: piece.counts.paused,
          ...delays(piece),
        },
        `${label}: health of ${row.proj.name}`,
      ).toEqual({
        done: row.done,
        total: row.total,
        pct: row.pct,
        remaining: row.remaining,
        paused: row.paused,
        ...delays(row),
      })
    }
  }
  return scoped.length
}

/* -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order. */
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** The scopes a caller's store offers: each top-level project it shows,
 * each of their sub-projects and My view. */
function scopesOf(P: Store, profile: Doc<'profiles'>) {
  const out: [string, OverviewScope, string][] = []
  for (const meta of P.visibleProjects()) {
    out.push([meta.name, projectScope(profile, meta.id), meta.id])
    for (const id of meta.children ?? [])
      if (P.canSee(id)) out.push([P.project(id)?.name ?? id, projectScope(profile, id), id])
  }
  out.push(['My view', { kind: 'mine' }, P.MINE_SCOPE])
  return out
}

it('runs in a zone other than UTC', () => {
  expect(new Date('2026-11-04T12:00:00.000Z').getTimezoneOffset()).not.toBe(0)
})

// ---------------------------------------------------------------- Northstar

describe('Northstar', () => {
  it('answers what the store derives, for Nora, Leo and Ben, every scope', async () => {
    const t = newT()
    const { profiles } = await plantNorthstar(t)
    await withReach(t)
    const person = async (key: string) => {
      const id = await northstarId(`person:${key}`)
      const p = profiles.find((profile) => profile.id === id)
      if (p === undefined) throw new Error(`no ${key}`)
      return p
    }
    // two days into the dataset's anchor week, in the afternoon
    const now = Date.parse('2026-09-09T18:00:00.000Z')
    let held = 0
    for (const profile of await Promise.all(['nora', 'leo', 'ben'].map(person))) {
      const P = await storeOf(t, profile, now)
      for (const [scopeLabel, scope, storeScope] of scopesOf(P, profile))
        held += await expectParity(
          t,
          P,
          profile,
          scope,
          storeScope,
          `${profile.name}, ${scopeLabel}`,
        )
    }
    expect(held).toBeGreaterThan(0)
  })
})

// ----------------------------------------------------------- access shapes

/** The day the small fixture's dates are set around, a Wednesday, in the
 * afternoon in New York. */
const NOW_CASE = Date.parse('2026-11-04T19:00:00.000Z')

/** The tasks every access case plants over the withOrg fixture for
 * `subject`, FW tracking delay: an overdue task, a Done task past its due
 * date, a group past its due date whose leaves are all Done, one of them in
 * a sibling sub-project the subject may not see, a paused group, paused
 * tasks dated, undated and Done, a subtask in an archived sub-project, a
 * task stored on the TBED meta, an In Review hand-off and a task the
 * subject reviews, tasks projected late, on track and behind, a group
 * projected late by its span, and a task whose remaining hours were
 * measured near midnight before a week began in New York, so its local and
 * UTC weeks differ. Then the organization is counted. */
async function plantCase(t: T, f: OrgFixture, subject: Doc<'profiles'>) {
  const org_id = f.org.id
  await t.run((ctx) => ctx.db.patch(f.sub._id, { track_delay: true }))
  const sibling = await plantProject(t, { org_id, type: 'project', parent_id: f.meta.id })
  const skunk = await plantProject(t, { org_id, type: 'project', parent_id: f.hidden.id })
  const archived = await plantProject(t, {
    org_id,
    type: 'project',
    parent_id: f.meta.id,
    archived_at: NOW,
  })
  const tess = await plantSeat(t, { org_id, org_role: 'user', auth_user_id: `auth_${uuid()}` })
  const task = (project: Doc<'projects'>, fields: Partial<Doc<'issues'>>) =>
    plantIssue(t, { org_id, project_id: project.id, ...fields })
  const mine = { assignee_id: subject.id }
  await task(f.sub, { title: 'Overdue', due_date: '2026-10-28', ...mine })
  await task(f.sub2, { title: 'Overdue in PCB', due_date: '2026-11-03', status: 'progress' })
  await task(f.sub, {
    title: 'Done past due',
    due_date: '2026-10-20',
    status: 'done',
    done_at: NOW,
  })
  const late = await task(f.sub, { title: 'Late group', due_date: '2026-10-30', ...mine })
  await task(f.sub, { title: 'Its Done leaf', parent_id: late.id, status: 'done', done_at: NOW })
  await task(sibling, {
    title: 'Its hidden Done leaf',
    parent_id: late.id,
    status: 'done',
    done_at: NOW,
  })
  const pausedGroup = await task(f.sub, { title: 'Paused group', paused: true, ...mine })
  await task(f.sub, { title: 'Its subtask', parent_id: pausedGroup.id, ...mine })
  await task(f.sub, { title: 'Paused, dated', paused: true, due_date: '2026-11-20', ...mine })
  await task(f.sub, { title: 'Paused, undated', paused: true, ...mine })
  await task(f.sub2, { title: 'Paused and Done', paused: true, status: 'done', done_at: NOW })
  const lone = await task(f.sub, { title: 'Parent of an archived subtask', ...mine })
  await task(archived, { title: 'In an archived project', parent_id: lone.id })
  await task(f.meta, { title: 'Stored on the meta', due_date: '2026-10-01', ...mine })
  await task(f.sub, {
    title: 'Handed to review',
    status: 'review',
    assignee_id: subject.id,
    reviewer_id: f.user.id,
    due_date: '2026-10-29',
  })
  await task(f.sub2, {
    title: 'Awaiting my review',
    status: 'review',
    assignee_id: f.user.id,
    reviewer_id: subject.id,
    paused: true,
  })
  await task(skunk, { title: 'In Skunkworks', due_date: '2026-10-15', ...mine })
  // projections in FW, which tracks delay, this week being 2 November
  const planned = { start_week: '2026-11-02', remaining_set_at: '2026-11-03T15:00:00.000Z' }
  await task(f.sub, {
    title: 'Too big for its due date',
    ...planned,
    end_week: '2026-11-09',
    due_date: '2026-11-12',
    remaining_hours: 200,
    assignee_id: f.user.id,
  })
  await task(f.sub, {
    title: 'Fits',
    ...planned,
    end_week: '2026-11-30',
    due_date: '2026-12-30',
    remaining_hours: 4,
    ...mine,
  })
  await task(f.sub, {
    title: 'Behind its plan',
    start_week: '2026-10-19',
    end_week: '2026-10-26',
    remaining_set_at: '2026-10-20T15:00:00.000Z',
    remaining_hours: 30,
    ...mine,
  })
  const span = await task(f.sub, { title: 'Group late by its span', due_date: '2026-11-13' })
  await task(f.sub, {
    title: 'Its late leaf',
    parent_id: span.id,
    start_week: '2026-11-23',
    end_week: '2026-11-30',
  })
  // measured at 22:00 on Sunday 18 October in New York, Monday 19 October in
  // UTC: 400 hours at 40 a week from that week end in the week of 14
  // December by local weeks, its due week, and a week later by UTC weeks
  await t.run((ctx) => ctx.db.patch(tess._id, { plannable_hours: 40 }))
  await task(f.sub, {
    title: 'Measured near midnight',
    start_week: '2026-10-12',
    end_week: '2026-12-14',
    due_date: '2026-12-16',
    remaining_hours: 400,
    remaining_set_at: '2026-10-19T02:00:00.000Z',
    assignee_id: tess.id,
  })
  await countOrg(t, org_id)
  return { sibling, skunk }
}

/** One access case: `shape` planted for a fresh seat of `role`, or the
 * fixture's admin without a shape, compared over every scope. */
async function compareShape(
  shape: (typeof SHAPES)[number] | null,
  role: 'user' | 'guest' | 'viewer' | 'admin',
): Promise<number> {
  const t = newT()
  const f = await withOrg(t)
  const subject =
    role === 'admin'
      ? f.admin
      : await plantSeat(t, { org_id: f.org.id, org_role: role, auth_user_id: `auth_${uuid()}` })
  if (shape !== null) await t.run((ctx) => shape[1](ctx, f, subject))
  const { sibling, skunk } = await plantCase(t, f, subject)
  const P = await storeOf(t, subject, NOW_CASE)
  const scopes: [string, OverviewScope, string][] = [
    ...[f.meta, f.sub, f.sub2, sibling, f.hidden, skunk].map(
      (p): [string, OverviewScope, string] => [p.key, projectScope(subject, p.id), p.id],
    ),
    ['My view', { kind: 'mine' }, P.MINE_SCOPE],
  ]
  let held = 0
  for (const [label, scope, storeScope] of scopes)
    held += await expectParity(
      t,
      P,
      subject,
      scope,
      storeScope,
      `${role}, ${shape?.[0] ?? 'admin'}, ${label}`,
    )
  return held
}

describe('access shapes', () => {
  it('answers what the store derives for the admin', async () => {
    expect(await compareShape(null, 'admin')).toBeGreaterThan(0)
  })

  for (const role of ['user', 'guest', 'viewer'] as const)
    it(`answers what the store derives for a ${role} in every shape`, async () => {
      let showing = 0
      for (const shape of SHAPES) if ((await compareShape(shape, role)) > 0) showing++
      // a guest takes no team shares, so fewer shapes show them anything
      expect(showing).toBeGreaterThan(SHAPES.length / 3)
    })
})

// ------------------------------------------------- the rules that must hold

describe('rules a drift would break', () => {
  /** The admin's store and answers over TBED, which they see whole. */
  async function adminCase() {
    const t = newT()
    const f = await withOrg(t)
    await plantCase(t, f, f.admin)
    const P = await storeOf(t, f.admin, NOW_CASE)
    const info = P.scopeInfo(f.meta.id)
    if (info === null) throw new Error('the admin sees no TBED')
    const scope = projectScope(f.admin, f.meta.id)
    const summary = await as(t, f.admin).query(api.overview.summary, { scope, day: P.TODAY_ISO })
    if (summary.state !== 'ok' || summary.counts.state !== 'ok' || summary.overdue.state !== 'ok')
      throw new Error(JSON.stringify(summary))
    return { t, f, P, scoped: P.scopedIssues(info), scope, summary, counts: summary.counts }
  }

  it("differs from a rule that counts a group's own pause", async () => {
    const { scoped, counts } = await adminCase()
    expect(scoped.filter((it) => it.paused).length).not.toBe(counts.paused)
  })

  it("differs from a rule that takes a group's done state from its stored status", async () => {
    const { P, scoped, summary } = await adminCase()
    const drifted = scoped.filter((it) => it.status !== 'done' && it.due && it.due < P.TODAY_ISO)
    expect(summary.overdue).not.toEqual({ state: 'ok', count: drifted.length })
  })

  it('places an instant in the last hour of a fall-back week in that week', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => ctx.db.patch(f.sub._id, { track_delay: true }))
    const owner = await plantSeat(t, {
      org_id: f.org.id,
      org_role: 'user',
      auth_user_id: `auth_${uuid()}`,
      plannable_hours: 40,
    })
    // New York's week of 26 October is 169 hours long, as its clocks fall
    // back on 1 November; 04:30 UTC on 2 November is 23:30 on Sunday there,
    // so 40 hours at 40 a week finish in that week, the task's due week
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Measured in the last hour',
      assignee_id: owner.id,
      start_week: '2026-10-26',
      end_week: '2026-10-26',
      due_date: '2026-11-01',
      remaining_hours: 40,
      remaining_set_at: '2026-11-02T04:30:00.000Z',
    })
    await countOrg(t, f.org.id)
    const P = await storeOf(t, f.admin, Date.parse('2026-11-02T04:45:00.000Z'))
    const days = clientDays(P)
    expect(days.day).toBe('2026-11-01')
    expect(days.week_end - days.week_starts[52]).toBe(169 * 3_600_000)
    const scope = projectScope(f.admin, f.sub.id)
    expect(await expectParity(t, P, f.admin, scope, f.sub.id, 'fall-back week')).toBe(1)
    // a week measured as 168 hours places the instant in the next one
    const fixed = { ...days, week_end: days.week_starts[52] + 168 * 3_600_000 }
    const local = await as(t, f.admin).query(api.overview.risk, { scope, ...days })
    const drifted = await as(t, f.admin).query(api.overview.risk, { scope, ...fixed })
    if (local.state !== 'ok' || drifted.state !== 'ok')
      throw new Error(JSON.stringify([local, drifted]))
    expect(drifted.projected).not.toEqual(local.projected)
  })

  it('differs from a server that places remaining_set_at in its UTC week', async () => {
    const { t, f, P, scope } = await adminCase()
    const local = await as(t, f.admin).query(api.overview.risk, { scope, ...clientDays(P) })
    const utc = await as(t, f.admin).query(api.overview.risk, { scope, ...utcDays(P) })
    if (local.state !== 'ok' || utc.state !== 'ok') throw new Error(JSON.stringify([local, utc]))
    expect(utc.projected).not.toEqual(local.projected)
  })
})

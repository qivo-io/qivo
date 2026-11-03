/* The Overview's server reads (convex/overview.ts) against the app's own
 * figures and the Overview's stand-in. Each case boots the real store from
 * the caller's real workspace, as boardParity.test.ts does, with the clock
 * frozen before the store loads so its TODAY_ISO and TODAY_WEEK are the day
 * and week the queries are sent, sends the clock the page sends
 * (src/views/overview/overviewArgs.ts overviewClock), and compares what the
 * queries answer for the same caller with what the store derives: the
 * summary against the oracle's overviewFigures (store/overviewOracle.setup.ts,
 * the page's figures before it read the server's) and statusCounts, the
 * Overdue & at risk rows against its list, as a set and in due-date order,
 * the Paused rows against its paused tasks by due date, undated last, and
 * the health table (overview.health) against the oracle's healthRows, its
 * rows both ways, each row's name, lead, sparkbar, Completion, Left,
 * Paused and Delayed and Slipping, with `loads` exactly where a guest's or
 * Viewer's row needs an owner past the lowest one the table needs, and for
 * Nora every column's order both ways against healthOrder, a cut and a
 * search. The stand-in the jsdom tests and the benchmark read
 * (store/overviewStandIn.setup.ts) answers the same summary and delays,
 * the same batches, rows, verdicts and fixed ends and the same health
 * table.
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
import { nameKey } from '../../convex/lib/nameKey'
import type {
  HealthAnswer,
  HealthSort,
  ListAnswer,
  OverviewScope,
  SummaryAnswer,
} from '../../convex/lib/overview'
import { OVERVIEW, WEEK_STARTS } from '../../convex/lib/overview'
import { taskOwnerId } from '../../convex/lib/review'
import { allWordsMatcher } from '../../convex/lib/search'
import { DEFAULT_PLANNABLE_HOURS, plannableHoursOf } from '../../convex/lib/workload'
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
import { OVERVIEW_BATCH, OVERVIEW_SPLIT, OVERVIEW_WEEKS } from './overviewLists'
import {
  type ForcedOverview,
  HEALTH_ROWS,
  type OverviewArgs,
  overviewStandIn,
} from './overviewStandIn.setup'
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
  // the oracle and the page's clock read this store
  const figures = await import('./overviewOracle.setup')
  const args = await import('../views/overview/overviewArgs')
  return Object.assign(store.P, { figures, args, snapshot: snap })
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

/** The client's day and weeks as the page sends them (overviewClock): its
 * day, the first day of its week, the instants its last 53 local weeks
 * began at and the instant the next one begins at. */
const clientDays = (P: Store) => P.args.overviewClock()

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
async function wholeBatches(
  read: (cursor?: string) => ListAnswer | Promise<ListAnswer>,
  label: string,
  partial = false,
): Promise<(ListAnswer & { state: 'ok' })[]> {
  const batches: (ListAnswer & { state: 'ok' })[] = []
  let cursor: string | undefined
  for (let n = 0; n < 100; n++) {
    const got = await read(cursor)
    if (got.state !== 'ok') throw new Error(`${label}: ${JSON.stringify(got)}`)
    if (!partial) expect(got.complete, `${label}: complete`).toBe(true)
    expect(got.rows.length, `${label}: batch`).toBeLessThanOrEqual(OVERVIEW.batch)
    batches.push(got)
    if (got.next === null) return batches
    cursor = got.next
  }
  throw new Error(`${label}: the list did not end`)
}

/** What the stand-in and the server must agree on of a list's batches:
 * each batch's rows by id with the facts the page reads and the verdict,
 * whether it is complete and whether it ends the list. */
const batchFacts = (batches: (ListAnswer & { state: 'ok' })[]) =>
  batches.map((b) => ({
    rows: b.rows.map((row) => [
      row.id,
      row.has_subtasks,
      row.has_hidden_subtasks,
      row.parent_id ?? null,
      row.group_done ?? null,
      row.span?.partial ?? null,
      row.at_risk ?? null,
    ]),
    complete: b.complete,
    ends: b.next === null,
  }))

/** The due dates of `items` in order, undated last as '~'. */
const dues = (items: { due?: string | null; due_date?: string }[]) =>
  items.map((it) => ('due_date' in it ? it.due_date : it.due) || '~')

/** The health table's columns. */
const HEALTH_SORTS: HealthSort[] = [
  'name',
  'lead',
  'progress',
  'done',
  'left',
  'late',
  'behind',
  'paused',
]

/** The rows of `rows`, the oracle's health rows, whose Delayed a guest or
 * an organization Viewer cannot be given: those with a task in a project
 * that tracks delay whose verdict needs an owner other than the lowest
 * owner id any row needs in that organization, as the server reads one
 * owner's load a query for them, in owner id order. An owner is needed by
 * a task without subtasks, not Done, with a planned end or a due date and
 * remaining hours, whose owner by the Reviewer rule is a profile with a
 * finite capacity (convex/lib/overview.ts verdicts needs). */
function needSecondOwner(P: Store, rows: ReturnType<Store['figures']['healthRows']>): Set<string> {
  const raw = new Map(P.snapshot.issues.map((t) => [t.id, t]))
  const people = new Map(P.snapshot.profiles.map((p) => [p.id, p]))
  const needs = (it: Issue): string | null => {
    const t = raw.get(it.uuid)
    if (t === undefined || P.isGroup(it) || t.status === 'done') return null
    if (t.end_week === undefined && t.due_date === undefined) return null
    if (!((t.remaining_hours ?? 0) > 0)) return null
    const id = taskOwnerId(t, false)
    const owner = id === undefined ? undefined : people.get(id)
    if (id === undefined || owner === undefined) return null
    const capacity =
      owner.org_id === t.org_id
        ? plannableHoursOf({ plannableHours: owner.plannable_hours, kind: owner.kind })
        : DEFAULT_PLANNABLE_HOURS
    return Number.isFinite(capacity) && capacity > 0 ? id : null
  }
  const owners = new Map(
    rows.map((r) => [
      r.proj.id,
      r.issues.filter((it) => P.tracksDelay(it)).flatMap((it) => needs(it) ?? []),
    ]),
  )
  const lowest = new Map<string, string>()
  for (const id of [...owners.values()].flat().sort()) {
    const org = people.get(id)?.org_id ?? ''
    if (!lowest.has(org)) lowest.set(org, id)
  }
  return new Set(
    [...owners]
      .filter(([, ids]) => ids.some((id) => lowest.get(people.get(id)?.org_id ?? '') !== id))
      .map(([project]) => project),
  )
}

/** Compares the five queries for `profile` over `scope`, the store scope
 * `scopeId`, with what store `P` derives; with `orders`, every column of
 * the health table both ways, a cut and a search too. Answers how many
 * tasks the scope held, for a caller that checks its cases compared
 * something. */
async function expectParity(
  t: T,
  P: Store,
  profile: Doc<'profiles'>,
  scope: OverviewScope,
  scopeId: string,
  label: string,
  orders = false,
): Promise<number> {
  const info = P.scopeInfo(scopeId)
  const days = clientDays(P)
  const caller = as(t, profile)
  const summary = await caller.query(api.overview.summary, { scope, day: days.day })
  const risk = await caller.query(api.overview.risk, { scope, ...days })
  const stand = (query: 'summary' | 'risk' | 'attention' | 'paused', args: OverviewArgs) =>
    overviewStandIn(P.snapshot, query, args, { sees: (id) => P.canSee(id) }) as ListAnswer
  // a scope the store does not hold is one the server does not either, nor
  // the stand-in
  if (info === null) {
    expect(summary, `${label}: unavailable`).toEqual({ state: 'unavailable' })
    expect(risk, `${label}: risk unavailable`).toEqual({ state: 'unavailable' })
    expect(stand('summary', { scope, day: days.day }), `${label}: stand-in`).toEqual(summary)
    expect(stand('paused', { scope }), `${label}: stand-in list`).toEqual(summary)
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

  // the stand-in answers the summary and the delays alike
  // sub-projects in creation order, which the stand-in reads from the
  // rows' created_at and the server from the documents', as sets
  const subsAsSet = (a: SummaryAnswer) =>
    a.state === 'ok' && a.sub_projects ? { ...a, sub_projects: sorted(a.sub_projects) } : a
  expect(
    subsAsSet(stand('summary', { scope, day: days.day }) as SummaryAnswer),
    `${label}: stand-in summary`,
  ).toEqual(subsAsSet(summary))
  expect(stand('risk', { scope, ...days }), `${label}: stand-in risk`).toEqual(risk)

  // the Overdue & at risk list, as a set and in due-date order, ties as sets
  const byUuid = new Map(Object.values(P.issueById).map((it: Issue) => [it.uuid, it]))
  const attentionBatches = await wholeBatches(
    (cursor) =>
      caller.query(api.overview.attention, { scope, ...days, ...(cursor ? { cursor } : {}) }),
    `${label}: at risk`,
    !staff,
  )
  const attention = attentionBatches.flatMap((b) => b.rows)
  // the stand-in's batches end and stop where the server's do, with the
  // same rows and verdicts in the same order
  const standAttention = await wholeBatches(
    (cursor) => stand('attention', { scope, ...days, ...(cursor ? { cursor } : {}) }),
    `${label}: stand-in at risk`,
    !staff,
  )
  expect(batchFacts(standAttention), `${label}: stand-in at-risk batches`).toEqual(
    batchFacts(attentionBatches),
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
  const pausedBatches = await wholeBatches(
    (cursor) => caller.query(api.overview.paused, { scope, ...(cursor ? { cursor } : {}) }),
    `${label}: paused`,
  )
  const paused = pausedBatches.flatMap((b) => b.rows)
  const standPaused = await wholeBatches(
    (cursor) => stand('paused', { scope, ...(cursor ? { cursor } : {}) }),
    `${label}: stand-in paused`,
  )
  expect(batchFacts(standPaused), `${label}: stand-in paused batches`).toEqual(
    batchFacts(pausedBatches),
  )
  expect(sorted(paused.map((r) => r.id)), `${label}: paused rows`).toEqual(
    sorted(f.pausedIssues.map((it) => it.uuid)),
  )
  const pausedOrder = [...f.pausedIssues].sort((a, b) => order(a.due || '~', b.due || '~'))
  expect(dues(paused), `${label}: paused order`).toEqual(dues(pausedOrder))

  // the health table, through overview.health, each answer the stand-in's
  const mine = P.isMineScope(scopeId)
  if (info.isMeta || mine) {
    const rows = P.figures.healthRows(info, scoped, mine)
    const byProject = new Map(rows.map((r) => [r.proj.id, r]))
    const health = async (over: Partial<OverviewArgs> = {}) => {
      const args = {
        scope,
        ...days,
        sort: 'late' as HealthSort,
        dir: 'desc' as 'asc' | 'desc',
        limit: OVERVIEW.healthRows,
        ...over,
      }
      const got = await caller.query(api.overview.health, args)
      expect(
        overviewStandIn(P.snapshot, 'health', args, { sees: (id) => P.canSee(id) }),
        `${label}: stand-in health ${JSON.stringify(over)}`,
      ).toEqual(got)
      if (got.state !== 'ok') throw new Error(`${label}: health ${JSON.stringify(got)}`)
      return got
    }
    const table = await health()
    // every row of the oracle and no other: My view leaves out a project
    // with none of the person's tasks
    expect(sorted(table.rows.map((r) => r.project_id)), `${label}: health rows`).toEqual(
      sorted(byProject.keys()),
    )
    expect(table.total, `${label}: health total`).toBe(rows.length)
    // a guest's or Viewer's rows that need a second owner answer loads
    const loads = staff ? new Set<string>() : needSecondOwner(P, rows)
    for (const row of table.rows) {
      const o = byProject.get(row.project_id)
      if (o === undefined || row.counts.state !== 'ok')
        throw new Error(`${label}: health row ${JSON.stringify(row)}`)
      const leaves = row.counts.leaves
      const all = Object.values(leaves).reduce((n, c) => n + c, 0)
      expect(
        {
          name: row.name,
          lead: row.lead_id,
          leaves,
          done: leaves.done,
          total: all,
          pct: all ? Math.round((leaves.done / all) * 100) : 0,
          remaining: row.counts.left_tenths / 10,
          paused: row.counts.paused,
          delays: row.delays,
        },
        `${label}: health of ${o.proj.name}`,
      ).toEqual({
        name: o.proj.name,
        lead: P.leadOf(o.proj.id) ?? null,
        leaves: P.figures.statusCounts(o.issues),
        done: o.done,
        total: o.total,
        pct: o.pct,
        remaining: o.remaining,
        paused: o.paused,
        delays: loads.has(o.proj.id)
          ? { state: 'unavailable', reason: 'loads' }
          : { state: 'ok', late: o.late, behind: o.behind },
      })
    }
    expect(table.sort, `${label}: health order`).toEqual(
      loads.size > 0
        ? { key: 'name', dir: 'asc', by_name: 'delays' }
        : { key: 'late', dir: 'desc' },
    )
    if (orders) {
      const ids = (a: HealthAnswer) => (a.state === 'ok' ? a.rows.map((r) => r.project_id) : [])
      for (const sort of HEALTH_SORTS)
        for (const dir of ['asc', 'desc'] as const) {
          const want = P.figures.healthOrder(rows, sort, dir).map((r) => r.proj.id)
          const whole = await health({ sort, dir })
          expect(whole.sort, `${label}: ${sort} ${dir}`).toEqual({ key: sort, dir })
          expect(ids(whole), `${label}: ${sort} ${dir}`).toEqual(want)
          // a cut is the first rows of the same order
          expect(
            ids(await health({ sort, dir, limit: 2 })),
            `${label}: ${sort} ${dir} cut`,
          ).toEqual(want.slice(0, 2))
        }
      // a search of one word of a row's name
      const word = rows[0]?.proj.name.split(/\s+/)[0]
      if (word !== undefined) {
        const matches = allWordsMatcher(nameKey(word))
        expect(sorted(ids(await health({ search: word }))), `${label}: search ${word}`).toEqual(
          sorted(rows.filter((r) => matches(nameKey(r.proj.name))).map((r) => r.proj.id)),
        )
      }
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

it("keeps the app's batch, split and week figures and the stand-in's health cap the server's", () => {
  expect([OVERVIEW_BATCH, OVERVIEW_SPLIT, OVERVIEW_WEEKS, HEALTH_ROWS]).toEqual([
    OVERVIEW.batch,
    OVERVIEW.split,
    WEEK_STARTS,
    OVERVIEW.healthRows,
  ])
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
    const nora = await person('nora')
    for (const profile of [nora, ...(await Promise.all(['leo', 'ben'].map(person)))]) {
      const P = await storeOf(t, profile, now)
      for (const [scopeLabel, scope, storeScope] of scopesOf(P, profile))
        held += await expectParity(
          t,
          P,
          profile,
          scope,
          storeScope,
          `${profile.name}, ${scopeLabel}`,
          profile === nora,
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

  it('differs from a rule that counts Delayed in a sub-project that does not track delay', async () => {
    const { t, f, P, scope } = await adminCase()
    const info = P.scopeInfo(f.meta.id)
    if (info === null) throw new Error('no TBED')
    const days = clientDays(P)
    const got = await as(t, f.admin).query(api.overview.health, {
      scope,
      ...days,
      sort: 'name',
      dir: 'asc',
      limit: 10,
    })
    if (got.state !== 'ok') throw new Error(JSON.stringify(got))
    const pcb = got.rows.find((r) => r.project_id === f.sub2.id)
    expect(pcb?.delays).toEqual({ state: 'ok', late: 0, behind: 0 })
    // PCB holds an overdue task, which a rule without the tracking gate counts
    const drifted = P.scopedIssues(info).filter(
      (it) => it.project === f.sub2.id && P.delayOf(it)?.status === 'late',
    ).length
    expect(drifted).toBeGreaterThan(0)
  })

  it("differs from a My view Left added up in hours a sub-project, and from names in localeCompare's order", async () => {
    const t = newT()
    const f = await withOrg(t)
    const mine = { assignee_id: f.admin.id }
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, remaining_hours: 0.1, ...mine })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, remaining_hours: 0.2, ...mine })
    for (const name of ['Pilot', 'Ørsted'])
      await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: f.meta.id,
        name,
        name_key: nameKey(name),
      })
    await countOrg(t, f.org.id)
    const P = await storeOf(t, f.admin, NOW_CASE)
    const ask = (scope: OverviewScope) =>
      as(t, f.admin).query(api.overview.health, {
        scope,
        ...clientDays(P),
        sort: 'name',
        dir: 'asc',
        limit: 10,
      })
    const view = await ask({ kind: 'mine' })
    if (view.state !== 'ok' || view.rows[0]?.counts.state !== 'ok')
      throw new Error(JSON.stringify(view))
    const left = view.rows[0].counts.left_tenths / 10
    expect(left).toBe(0.3)
    const info = P.scopeInfo(P.MINE_SCOPE)
    const group = info?.groups.find((g) => g.proj.id === f.meta.id)
    if (!info || !group) throw new Error('no TBED in My view')
    // the oracle rounds once, as the server does; hours added up a
    // sub-project at a time do not
    expect(P.figures.healthRows(info, P.scopedIssues(info), true)[0]?.remaining).toBe(left)
    const drifted = group.subIds.reduce((sum, id) => sum + P.remainingIn([id], info.only), 0)
    expect(drifted).not.toBe(left)
    // names by their key's bytes put Ørsted after Pilot; the browser's
    // localeCompare puts it before
    const table = await ask(projectScope(f.admin, f.meta.id))
    if (table.state !== 'ok') throw new Error(JSON.stringify(table))
    const names = table.rows.map((r) => r.name)
    expect(names).toEqual(['Board rev', 'Firmware', 'Pilot', 'Ørsted'])
    expect([...names].sort((a, b) => a.localeCompare(b))).not.toEqual(names)
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

// ------------------------------------------------------- the stand-in's ends

describe('fixed ends', () => {
  /** A read of the Paused list a batch at a time. */
  type Read = (at: { cursor?: string; end?: string }) => Promise<ListAnswer>

  /** 25 paused tasks of one sub-project, 20 dated over four days and 5
   * undated, read by the fixture's user through the server and through the
   * stand-in over their workspace (`force` as it takes it), each paging
   * with its own positions. */
  async function fixedCase({ groups = false } = {}) {
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
          ...(i < 20 ? { due_date: `2026-11-0${3 + (i % 4)}` } : {}),
        }),
      )
    // with `groups`, 40 paused groups the list leaves out among them, so a
    // batch judges its candidates in several rounds and a lowered budget
    // can stop it between two
    for (let i = 0; groups && i < 40; i++) {
      const group = await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        title: `Group ${i}`,
        paused: true,
        due_date: `2026-11-0${3 + (i % 4)}`,
      })
      await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        title: `Its subtask ${i}`,
        parent_id: group.id,
      })
    }
    await countOrg(t, f.org.id)
    const scope = projectScope(f.user, f.sub.id)
    const caller = as(t, f.user)
    const server: Read = (at) => caller.query(api.overview.paused, { scope, ...at })
    const standIn =
      (force: ForcedOverview = {}): Read =>
      async (at) => {
        const snap = await workspaceOf(caller)
        if (snap === null) throw new Error('no workspace')
        return overviewStandIn(snap, 'paused', { scope, ...at }, { force }) as ListAnswer
      }
    return { t, f, planted, server, standIn }
  }

  const titlesOf = (a: ListAnswer | undefined) =>
    a?.state === 'ok' ? a.rows.map((r) => r.title) : []

  /** The open batches of `ask` from the list's start, and a way to ask its
   * first three batches again with the ends they answered. */
  async function pages(ask: Read, label: string) {
    const batches = await wholeBatches((cursor) => ask(cursor ? { cursor } : {}), label)
    const [first, second] = batches
    const fixed = async () =>
      (
        await Promise.all([
          ask({ end: first?.end as string }),
          ask({ cursor: first?.next as string, end: second?.end as string }),
          ask({ cursor: second?.next as string }),
        ])
      ).map(titlesOf)
    return { batches, first, second, fixed, ask }
  }

  it('answers fixed batches as the server does: asked again, a row moved out, one grown past the split', async () => {
    const { t, f, planted, server: serverRead, standIn } = await fixedCase()
    const server = await pages(serverRead, 'server')
    const stand = await pages(standIn(), 'stand-in')
    expect(server.batches.map(titlesOf)).toEqual(stand.batches.map(titlesOf))
    expect(server.batches.map((b) => b.rows.length)).toEqual([10, 10, 5])
    expect(await server.fixed()).toEqual(await stand.fixed())

    // the first row of the first batch moves past the second batch: it
    // leaves the first fixed batch and joins the open one, once
    const moved = planted.find((p) => p.title === server.first?.rows[0]?.title) as Doc<'issues'>
    await t.run((ctx) => ctx.db.patch(moved._id, { due_date: '2026-12-02' }))
    const after = await server.fixed()
    expect(after).toEqual(await stand.fixed())
    expect(after.flat()).toHaveLength(25)
    expect(new Set(after.flat()).size).toBe(25)
    expect(after[0]).not.toContain(moved.title)
    expect(after[2]).toContain(moved.title)

    // 15 more inside the first batch's span: it answers a split, and its
    // halves hold every row once, on both
    for (let i = 0; i < 15; i++)
      await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        title: `Late paused ${i}`,
        paused: true,
        due_date: '2026-11-03',
      })
    await countOrg(t, f.org.id)
    const halves = async (side: Awaited<ReturnType<typeof pages>>) => {
      const end = side.first?.end as string
      const grown = await side.ask({ end })
      if (grown.state !== 'ok' || grown.split === undefined) throw new Error(JSON.stringify(grown))
      expect(grown.rows).toHaveLength(OVERVIEW.batch)
      expect(grown.complete).toBe(true)
      const parts = await Promise.all([
        side.ask({ end: grown.split }),
        side.ask({ cursor: grown.split, end }),
      ])
      return { grown: titlesOf(grown), parts: parts.map(titlesOf) }
    }
    const split = await halves(server)
    expect(split).toEqual(await halves(stand))
    expect(split.parts[0]).toEqual(split.grown)
    expect(new Set(split.parts.flat()).size).toBe(split.parts.flat().length)
    expect(split.parts.flat().length).toBeGreaterThan(OVERVIEW.split)
  })

  it('answers a fixed batch that stopped as the server does: its first rows, the position it reached, its end kept', async () => {
    const { server: serverRead, standIn } = await fixedCase({ groups: true })
    /* Checks `got`, the fixed batch of the first 20 rows to `end` whose
       reads stopped, against the contract: incomplete, its first rows, a
       `next` before the end it keeps, and the two batches `whole` reads
       that meet at `next` hold every one of `all` once. */
    const check = async (whole: Read, got: ListAnswer, end: string, all: string[]) => {
      if (got.state !== 'ok') throw new Error(JSON.stringify(got))
      expect(got.complete).toBe(false)
      expect(got.rows.length).toBeGreaterThan(0)
      expect(got.end).toBe(end)
      expect(got.next).not.toBe(end)
      expect(titlesOf(got)).toEqual(all.slice(0, got.rows.length))
      const parts = await Promise.all([
        whole({ end: got.next as string }),
        whole({ cursor: got.next as string, end }),
      ])
      expect(parts.flatMap(titlesOf)).toEqual(all)
    }
    /* The first 20 rows `ask` pages to, and the end of their second batch. */
    const firstTwenty = async (ask: Read) => {
      const { first, second } = await pages(ask, 'first twenty')
      return { all: [...titlesOf(first), ...titlesOf(second)], end: second?.end as string }
    }
    // the stand-in stops a batch where it is told to
    const stand = await firstTwenty(standIn())
    await check(
      standIn(),
      await standIn({ list: 'incomplete' })({ end: stand.end }),
      stand.end,
      stand.all,
    )
    // the server stops it under a lowered budget, set on the module the
    // queries read now: an earlier case's store reset the module registry
    const server = await firstTwenty(serverRead)
    expect(server.all).toEqual(stand.all)
    const { OVERVIEW: live } = await import('../../convex/lib/overview')
    const was = structuredClone(live.reads)
    let got: ListAnswer | null = null
    try {
      for (let ranges = 200; ranges > 0 && got === null; ranges--) {
        Object.assign(live.reads, { ranges })
        const answer = await serverRead({ end: server.end })
        if (answer.state === 'ok' && !answer.complete && answer.rows.length > 0) got = answer
      }
    } finally {
      Object.assign(live.reads, was)
    }
    if (got === null) throw new Error('no lowered budget stopped the batch')
    await check(serverRead, got, server.end, server.all)
  })
})

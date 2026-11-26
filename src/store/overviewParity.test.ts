/* The Overview's server reads (convex/overview.ts) against the Overview's
 * stand-in (store/overviewStandIn.setup.ts), which the jsdom tests and the
 * benchmark read. Each case boots the real store, as the app does, holding
 * no task, from the caller's real workspace, with the clock frozen before
 * the store loads so its TODAY_ISO and TODAY_WEEK are the day and week the
 * queries are sent, sends the clock the page sends
 * (src/views/overview/overviewArgs.ts overviewClock), and checks that the
 * stand-in answers the same summary and the same health table, for Nora in
 * every column's order both ways, a cut and a search, as the queries
 * answer for the same caller, and that a top-level project's Needs
 * attention answer holds the health table the server answers sorted by
 * Late. Over every row of My view's Your work, as
 * the server answers it, it also checks what the page does on screen
 * (views/overview/MyOverview.tsx modelOf and its rows): the store shapes a
 * model of each row (store/viewRows.ts), so no row waits on a model it
 * cannot show, and the model shows the row's own task, its title, its due
 * date and its owner by the Reviewer rule (lib/review.ts taskOwnerId).
 *
 * The process runs in New York's time zone, so the client's local weeks
 * differ from UTC weeks near midnight; vitest runs each file in a process
 * of its own. Northstar runs as Nora (admin), Leo and Ben over every scope;
 * the small fixture runs every access shape for a user, a guest and a
 * viewer, and the admin, over plants the brief names. Cases that must fail
 * if a rule drifts compare a drifted rule over the stored tasks with the
 * server's answer. */

import { getFunctionName } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import { nameKey } from '../../convex/lib/nameKey'
import type {
  HealthAnswer,
  HealthSort,
  OverviewScope,
  SummaryAnswer,
} from '../../convex/lib/overview'
import { OVERVIEW, WEEK_STARTS } from '../../convex/lib/overview'
import { taskOwnerId } from '../../convex/lib/review'
import type { ViewRow } from '../../convex/lib/viewReads'
import { WORK_GROUPS } from '../../convex/lib/workGroups'
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
  wholeOf,
  withReadingAdmin,
} from '../../convex/tests/helpers.setup'
import { northstarId, plantNorthstar } from '../../convex/tests/northstar.setup'
import { countOrg } from '../../convex/tests/overviewCounts.setup'
import { withReach } from '../../convex/tests/projectReach.setup'
import type { Whole as Snapshot } from './guard/liveDouble.setup'
import { oracleLevels, oracleScope, oracleStore } from './oracleScope.setup'
import { OVERVIEW_WEEKS, type OverviewQuery } from './overviewLists'
import { HEALTH_ROWS, type OverviewArgs, overviewStandIn } from './overviewStandIn.setup'
import { peopleSettingsStandIn } from './peopleSettingsStandIn.setup'
import { nameEveryone } from './personShown.setup'

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

/** A fresh store whose first delivery is `snap`, with the page's clock
 * read from the same store. */
async function start(snap: Snapshot) {
  vi.resetModules()
  vi.stubGlobal('window', { showToast: vi.fn() })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  // the faces the views name come from the server's data, as the store
  // holds nobody but the caller
  network.onUpdate.mockImplementation((ref, args, next) => {
    if (getFunctionName(ref) === 'people:byIds')
      next(peopleSettingsStandIn(snap, 'people:byIds', args))
    else next(structuredClone(snap))
    return () => {}
  })
  const store = await import('./planner')
  await store.initStore()
  await nameEveryone(store.P, snap)
  // the page's clock reads this store
  const args = await import('../views/overview/overviewArgs')
  // the view rows of the store's own module instance, whose week grid is
  // the store's (src/lib/dates.ts)
  const views = await import('./viewRows')
  const { isoToWeek } = await import('../lib/dates')
  return Object.assign(store.P, { args, views, weekOf: isoToWeek, snapshot: snap })
}

type Store = Awaited<ReturnType<typeof start>>

/** The store booted for `profile` from their workspace, with the clock at
 * `now` before the store's modules load. */
async function storeOf(t: T, profile: Doc<'profiles'>, now: number): Promise<Store> {
  const snap = await wholeOf(t, profile)
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

/* How many rows expectRowsShown compared, and how many of them were
   owned by their reviewer, so a case can tell the comparison ran. */
const shown = { rows: 0, reviewed: 0 }

/* How many top-level projects' Sub-projects expectParity compared. */
let subProjectTables = 0

/** Checks that the store shapes a model of every row of `rows`, the rows
 * of Your work's groups, as the page's modelOf takes one (store/viewRows.ts),
 * and that the model shows the row's task: its uuid, title, due date and
 * the owner the row's avatar shows by the Reviewer rule. */
function expectRowsShown(P: Store, rows: readonly ViewRow[], label: string) {
  const views = P.views.createViewRows(P.weekOf)
  views.take('parity', rows)
  views.beginPaint()
  views.reshape({ handleNow: P.handleNow })
  for (const row of rows) {
    const it = views.model('parity', row.id)
    expect(it, `${label}: a model of ${row.id}`).toBeDefined()
    if (!it) continue
    const owner = taskOwnerId(row, row.has_subtasks) ?? ''
    expect(
      { uuid: it.uuid, title: it.title, due: it.due ?? null, owner: it.owner || '' },
      `${label}: the row of ${row.id}`,
    ).toEqual({ uuid: row.id, title: row.title, due: row.due_date ?? null, owner })
    shown.rows++
    if (row.reviewer_id !== undefined && owner === row.reviewer_id) shown.reviewed++
  }
}

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

/** Checks that the Overview's stand-in answers the summary and the health
 * table of `scope` as the server does for `profile`, with `orders` every
 * column's order both ways, a cut and a search too, and in My view that
 * every row of Your work shows. Answers how many leaf tasks the summary
 * counts. */
async function expectParity(
  t: T,
  P: Store,
  profile: Doc<'profiles'>,
  scope: OverviewScope,
  label: string,
  orders = false,
): Promise<number> {
  const days = clientDays(P)
  const caller = as(t, profile)
  const levels = oracleLevels(P.snapshot)
  const stand = (query: OverviewQuery, args: OverviewArgs) =>
    overviewStandIn(P.snapshot, query, args, { sees: (id) => levels.has(id) })
  const summary = await caller.query(api.overview.summary, { scope, day: days.day })
  // sub-projects in creation order, which the stand-in reads from the
  // rows' created_at and the server from the documents', as sets
  const subsAsSet = (a: SummaryAnswer) =>
    a.state === 'ok' && a.sub_projects ? { ...a, sub_projects: sorted(a.sub_projects) } : a
  expect(
    subsAsSet(stand('summary', { scope, day: days.day }) as SummaryAnswer),
    `${label}: stand-in summary`,
  ).toEqual(subsAsSet(summary))
  if (summary.state !== 'ok') return 0
  // every row of Your work shows as the page shows it
  if (scope.kind === 'mine') {
    const work = await caller.query(api.overview.work, {
      ...days,
      progress: 1000,
      review: 1000,
      next: 1000,
    })
    if (work.state !== 'ok') throw new Error(`${label}: ${JSON.stringify(work)}`)
    expectRowsShown(
      P,
      WORK_GROUPS.flatMap((g) => work.groups[g].rows),
      label,
    )
  }
  // the health table, each answer the stand-in's too
  const health = async (over: Partial<Record<string, unknown>> = {}) => {
    const args = {
      scope,
      ...days,
      sort: 'late' as HealthSort,
      dir: 'desc' as 'asc' | 'desc',
      limit: OVERVIEW.healthRows,
      ...over,
    }
    const got = await caller.query(api.overview.health, args)
    expect(stand('health', args), `${label}: stand-in health ${JSON.stringify(over)}`).toEqual(got)
    return got
  }
  const table = await health()
  // a top-level project's Needs attention answer holds that same table, one
  // sub-project's none
  if (scope.kind === 'project') {
    const needs = await caller.query(api.overview.needs, {
      scope: { org_id: scope.org_id, project_id: scope.project_id },
      ...days,
      kind: 'all',
      limit: 20,
    })
    if (needs.state !== 'ok') throw new Error(`${label}: ${JSON.stringify(needs)}`)
    const top = P.snapshot.projects.find((p) => p.id === scope.project_id)?.parent_id === undefined
    expect(needs.health, `${label}: Sub-projects`).toEqual(top ? table : undefined)
    if (top) subProjectTables++
  }
  if (orders && table.state === 'ok') {
    for (const sort of HEALTH_SORTS)
      for (const dir of ['asc', 'desc'] as const) {
        await health({ sort, dir })
        await health({ sort, dir, limit: 2 })
      }
    // a search of one word of a row's name
    const word = table.rows[0]?.name.split(/\s+/)[0]
    if (word !== undefined) await health({ search: word })
  }
  return summary.counts.state === 'ok'
    ? Object.values(summary.counts.leaves).reduce((n, c) => n + c, 0)
    : 0
}

/** The scopes a caller's store offers: each top-level project it shows,
 * each of their sub-projects and My view. */
function scopesOf(P: Store, profile: Doc<'profiles'>) {
  const out: [string, OverviewScope, string][] = []
  // the store holds no project, so its old view comes from the server's
  // whole (oracleStore)
  const S = oracleStore(P.snapshot)
  for (const meta of S.visibleProjects()) {
    out.push([meta.name, projectScope(profile, meta.id), meta.id])
    for (const id of meta.children ?? [])
      if (S.canSee(id)) out.push([S.project(id)?.name ?? id, projectScope(profile, id), id])
  }
  out.push(['My view', { kind: 'mine' }, P.MINE_SCOPE])
  return out
}

it('runs in a zone other than UTC', () => {
  expect(new Date('2026-11-04T12:00:00.000Z').getTimezoneOffset()).not.toBe(0)
})

it("keeps the app's weeks and the stand-in's health cap the server's", () => {
  expect([OVERVIEW_WEEKS, HEALTH_ROWS]).toEqual([WEEK_STARTS, OVERVIEW.healthRows])
})

// ---------------------------------------------------------------- Northstar

describe('Northstar', () => {
  it('answers as the stand-in does, for Nora, Leo and Ben, every scope', async () => {
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
    const tables = subProjectTables
    const nora = await person('nora')
    for (const profile of [nora, ...(await Promise.all(['leo', 'ben'].map(person)))]) {
      const P = await storeOf(t, profile, now)
      for (const [scopeLabel, scope] of scopesOf(P, profile))
        held += await expectParity(
          t,
          P,
          profile,
          scope,
          `${profile.name}, ${scopeLabel}`,
          profile === nora,
        )
    }
    expect(held).toBeGreaterThan(0)
    expect(shown.rows).toBeGreaterThan(0)
    expect(subProjectTables).toBeGreaterThan(tables)
  })
})

// ----------------------------------------------------------- access shapes

/** The day the small fixture's dates are set around, a Wednesday, in the
 * afternoon in New York. */
const NOW_CASE = Date.parse('2026-11-04T19:00:00.000Z')

/** The tasks every access case plants over the withOrg fixture for
 * `subject`, FW tracking delay: an overdue task, a Done task past its due
 * date, a group past its due date whose leaves are all Done, a task in a
 * sibling sub-project the subject may not see, a paused group, paused
 * tasks dated, undated and Done, a group with its subtask in an archived
 * sub-project, a task stored on the TBED meta, an In Review hand-off and a task the
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
  await task(sibling, { title: 'Overdue in the sibling', due_date: '2026-10-27', ...mine })
  const pausedGroup = await task(f.sub, { title: 'Paused group', paused: true, ...mine })
  await task(f.sub, { title: 'Its subtask', parent_id: pausedGroup.id, ...mine })
  await task(f.sub, { title: 'Paused, dated', paused: true, due_date: '2026-11-20', ...mine })
  await task(f.sub, { title: 'Paused, undated', paused: true, ...mine })
  await task(f.sub2, { title: 'Paused and Done', paused: true, status: 'done', done_at: NOW })
  const archivedGroup = await task(archived, { title: 'Group in an archived project', ...mine })
  await task(archived, { title: 'Its subtask in an archived project', parent_id: archivedGroup.id })
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
 * fixture's admin, who reads by grants, without a shape, compared over every scope. */
async function compareShape(
  shape: (typeof SHAPES)[number] | null,
  role: 'user' | 'guest' | 'viewer' | 'admin',
): Promise<number> {
  const t = newT()
  const f = await withReadingAdmin(t)
  const subject =
    role === 'admin' && shape === null
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
  for (const [label, scope] of scopes)
    held += await expectParity(t, P, subject, scope, `${role}, ${shape?.[0] ?? 'admin'}, ${label}`)
  return held
}

describe('access shapes', () => {
  it('answers as the stand-in does for the fixture’s admin, who reads by grants', async () => {
    shown.rows = 0
    shown.reviewed = 0
    expect(await compareShape(null, 'admin')).toBeGreaterThan(0)
    // Your work showed rows, an In Review one among them owned by its
    // reviewer
    expect(shown.rows).toBeGreaterThan(0)
    expect(shown.reviewed).toBeGreaterThan(0)
  })

  // an admin's seat is judged by its own rows, as any member's
  for (const role of ['admin', 'user', 'guest', 'viewer'] as const)
    it(`answers as the stand-in does for ${role === 'admin' ? 'an' : 'a'} ${role} in every shape`, async () => {
      let showing = 0
      const tables = subProjectTables
      for (const shape of SHAPES) if ((await compareShape(shape, role)) > 0) showing++
      // a guest takes no team shares, so fewer shapes show them anything
      expect(showing).toBeGreaterThan(SHAPES.length / 3)
      expect(subProjectTables).toBeGreaterThan(tables)
    })
})

// ------------------------------------------------- the rules that must hold

/** Late and Behind plan of the health table's one row of sub-project
 * scope `scope`, as `profile` reads it on `days`. */
async function lateOf(
  t: T,
  profile: Doc<'profiles'>,
  scope: OverviewScope,
  days: ReturnType<typeof clientDays>,
): Promise<Extract<HealthAnswer, { state: 'ok' }>['rows'][number]['delays']> {
  const got = await as(t, profile).query(api.overview.health, {
    scope,
    ...days,
    sort: 'name',
    dir: 'asc',
    limit: 10,
  })
  if (got.state !== 'ok' || got.rows.length !== 1) throw new Error(JSON.stringify(got))
  return (got.rows[0] as (typeof got.rows)[number]).delays
}

describe('rules a drift would break', () => {
  /** The admin's store and answers over TBED, which they see whole. */
  async function adminCase() {
    const t = newT()
    const f = await withReadingAdmin(t)
    await plantCase(t, f, f.admin)
    const P = await storeOf(t, f.admin, NOW_CASE)
    const info = oracleScope(P.snapshot, f.meta.id)
    if (info === null) throw new Error('the admin sees no TBED')
    const scope = projectScope(f.admin, f.meta.id)
    const summary = await as(t, f.admin).query(api.overview.summary, { scope, day: P.TODAY_ISO })
    if (summary.state !== 'ok' || summary.counts.state !== 'ok' || summary.overdue.state !== 'ok')
      throw new Error(JSON.stringify(summary))
    // the stored tasks of the scope, which a drifted rule reads
    const scoped = P.snapshot.issues.filter((row) => info.subIdSet.has(row.project_id))
    return { t, f, P, scoped, scope, summary, counts: summary.counts }
  }

  it("differs from a rule that counts a group's own pause", async () => {
    const { scoped, counts } = await adminCase()
    expect(scoped.filter((it) => it.paused).length).not.toBe(counts.paused)
  })

  it("differs from a rule that takes a group's done state from its stored status", async () => {
    const { P, scoped, summary } = await adminCase()
    const drifted = scoped.filter(
      (row) => row.status !== 'done' && row.due_date && row.due_date < P.TODAY_ISO,
    )
    expect(summary.overdue).not.toEqual({ state: 'ok', count: drifted.length })
  })

  it('differs from a rule that counts Late in a sub-project that does not track delay', async () => {
    const { t, f, P, scope } = await adminCase()
    const info = oracleScope(P.snapshot, f.meta.id)
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
    // PCB holds an overdue task, which a rule without the tracking gate
    // counts as Late, since a passed due date is late whatever the load
    const drifted = P.snapshot.issues.filter(
      (row) =>
        row.project_id === f.sub2.id &&
        row.status !== 'done' &&
        !!row.due_date &&
        row.due_date < P.TODAY_ISO,
    ).length
    expect(drifted).toBeGreaterThan(0)
  })

  it("differs from a My view Left added up in hours a sub-project, and from names in localeCompare's order", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
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
    const info = oracleScope(P.snapshot, P.MINE_SCOPE)
    const group = info?.groups.find((g) => g.proj.id === f.meta.id)
    if (!info || !group) throw new Error('no TBED in My view')
    // the server rounds once; hours added up a sub-project at a time do not
    const drifted = group.subIds.reduce(
      (sum, id) =>
        sum +
        P.snapshot.issues
          .filter((row) => row.project_id === id && row.assignee_id === f.admin.id)
          .reduce((hours, row) => hours + (row.remaining_hours ?? 0), 0),
      0,
    )
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
    const f = await withReadingAdmin(t)
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
    expect(await expectParity(t, P, f.admin, scope, 'fall-back week')).toBe(1)
    // a week measured as 168 hours places the instant in the next one
    const fixed = { ...days, week_end: days.week_starts[52] + 168 * 3_600_000 }
    const local = await lateOf(t, f.admin, scope, days)
    expect(local).toEqual({ state: 'ok', late: 0, behind: 0 })
    expect(await lateOf(t, f.admin, scope, fixed)).not.toEqual(local)
  })

  it('differs from a server that places remaining_set_at in its UTC week', async () => {
    const { t, f, P } = await adminCase()
    const scope = projectScope(f.admin, f.sub.id)
    const local = await lateOf(t, f.admin, scope, clientDays(P))
    expect(await lateOf(t, f.admin, scope, utcDays(P))).not.toEqual(local)
  })
})

/* The Roadmap's server reads (convex/tasks.ts roadmap and
 * roadmapDependencies) against the app's own rules. Each case boots the
 * real store from the caller's real workspace, as boardParity.test.ts does,
 * and compares what the queries answer for the same caller, selection,
 * window and filter row with what the app's Roadmap derives in the browser
 * (store/roadmapOracle.setup.ts), the rows, the phone agenda's set
 * (scopedIssues, isRoadmapTaskVisible, passesFilters), each group row's
 * Done and span, the shown parents and a group row's other shown
 * descendants, each sub-project's heading Remaining in tenths, My view's
 * tracks (Roadmap.tsx held), and for the dependency inputs the arrows'
 * pairs, the parts of the dependency graph over every task the workspace
 * holds, the write levels, and Auto-move's moves over the answer against
 * its moves over the workspace within those parts. Northstar runs as Nora
 * (admin), Leo and Ben over every selection; the small fixture runs every
 * access shape for a user, a guest and a viewer, and the admin. Cases that
 * must fail if a rule drifts compare a drifted rule with the server's
 * answer. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Doc } from '../../convex/_generated/dataModel'
import type {
  AutoMoveInputs,
  DependencyAnswer,
  RoadmapAnswer,
  RoadmapFilters,
  RoadmapScope,
} from '../../convex/lib/roadmap'
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
import { dependenciesFor, NO_ROADMAP_FILTERS, roadmapFor } from '../../convex/tests/roadmap.setup'
import type { Snapshot } from './plannerFixture.setup'

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

/** A fresh store whose first delivery is `snap`, with the week grid, the
 * oracle and the solver of the same module instances. */
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
  return Object.assign(store.P, {
    dates: await import('../lib/dates'),
    oracle: await import('./roadmapOracle.setup'),
    schedule: await import('../lib/schedule'),
    snapshot: snap,
  })
}

type Store = Awaited<ReturnType<typeof start>>
type Issue = Store['issues'][number]

/** The store booted for `profile` from their workspace, with the clock at
 * `now`. */
async function storeOf(t: T, profile: Doc<'profiles'>, now: number): Promise<Store> {
  const snap = await workspaceOf(as(t, profile))
  if (snap === null) throw new Error(`no workspace for ${profile.name}`)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  return await start(snap)
}

const sorted = (ids: Iterable<string>) => [...ids].sort()

/** A window in the store's weeks, w0 to w1, both counted. */
type Weeks = [w0: number, w1: number]

/** The window arguments of `weeks`, the first days of its first and last
 * weeks on the store's grid. */
const windowOf = (P: Store, [w0, w1]: Weeks) => ({
  from: P.dates.weekToISO(w0),
  to: P.dates.weekToISO(w1),
})

/** The filter row as App hands it to the Roadmap for `scopeId`. My view
 * forces My tasks and drops the people filter (src/App.tsx roadmapFilters),
 * and the Roadmap applies neither Stale nor Focus. */
function deskFilters(P: Store, scopeId: string, f: RoadmapFilters) {
  const mine = P.isMineScope(scopeId)
  return {
    server: mine ? { ...f, mine: true, owners: [] } : f,
    desk: {
      mine: mine || f.mine,
      assignees: mine ? [] : f.owners,
      priority: f.priority,
      stale: false,
      focus: false,
      search: f.search.trim(),
    },
  }
}

/** Compares `answer`, tasks.roadmap's for the store scope `scopeId` in
 * `weeks` with `f`, with what store `P` derives; answers the rows' ids. */
function expectRows(
  P: Store,
  answer: RoadmapAnswer,
  scopeId: string,
  weeks: Weeks,
  f: RoadmapFilters,
  label: string,
): Set<string> {
  const info = P.scopeInfo(scopeId)
  if (info === null) {
    expect(answer, `${label}: unavailable`).toEqual({ state: 'unavailable' })
    return new Set()
  }
  if (answer.state !== 'ok') throw new Error(`${label}: ${JSON.stringify(answer)}`)
  const { desk } = deskFilters(P, scopeId, f)
  const rows = P.oracle.roadmapRows(info, weeks[0], weeks[1], desk)
  const rowIds = new Set(answer.rows.map((row) => row.id))
  expect(sorted(rowIds), `${label}: rows`).toEqual(sorted(rows.map((it) => it.uuid)))
  const byUuid = new Map(Object.values(P.issueById).map((it) => [it.uuid, it]))
  const parentOf = (it: Issue) => (it.parent ? P.issueById[it.parent] : undefined)
  // the shown ancestors that are not rows, and the shown descendants of
  // group rows that are neither
  const ancestors = new Set<string>()
  for (const it of rows) {
    const seen = new Set([it.uuid])
    for (let p = parentOf(it); p !== undefined && !seen.has(p.uuid); p = parentOf(p)) {
      seen.add(p.uuid)
      if (!rowIds.has(p.uuid)) ancestors.add(p.uuid)
    }
  }
  expect(sorted(answer.parents.map((r) => r.id)), `${label}: parents`).toEqual(sorted(ancestors))
  const below = new Set<string>()
  const seen = new Set<string>()
  const stack = rows.filter((it) => P.isGroup(it)).flatMap((it) => it.children ?? [])
  for (let key = stack.pop(); key !== undefined; key = stack.pop()) {
    const kid = P.issueById[key]
    if (!kid || seen.has(kid.uuid)) continue
    seen.add(kid.uuid)
    if (!rowIds.has(kid.uuid) && !ancestors.has(kid.uuid)) below.add(kid.uuid)
    stack.push(...(kid.children ?? []))
  }
  expect(sorted(answer.subtasks.map((r) => r.id)), `${label}: subtasks`).toEqual(sorted(below))
  // each row's group facts against the store's
  for (const row of [...answer.rows, ...answer.parents, ...answer.subtasks]) {
    const it = byUuid.get(row.id)
    if (it === undefined) throw new Error(`${label}: the store does not show ${row.id}`)
    const what = `${label}: ${it.key}`
    expect(row.has_subtasks, `${what} group`).toBe(P.isGroup(it))
    expect(row.parent_id ?? null, `${what} parent`).toBe(parentOf(it)?.uuid ?? null)
    if (!row.has_subtasks) continue
    expect(row.group_done, `${what} done`).toBe(P.isDone(it))
    const week = (iso: string | undefined) => (iso === undefined ? null : P.dates.isoToWeek(iso))
    expect(week(row.span?.start_week), `${what} start`).toBe(it.start)
    expect(week(row.span?.end_week), `${what} end`).toBe(it.end)
  }
  // the headings, before the filters, absent keys 0
  const remaining = P.oracle.remainingTenths(info)
  if (answer.remaining.state !== 'ok')
    throw new Error(`${label}: Remaining ${answer.remaining.reason}`)
  const tenths = answer.remaining.tenths
  for (const id of info.subIds)
    expect(tenths[id] ?? 0, `${label}: Remaining of ${P.project(id)?.name}`).toBe(remaining[id])
  // My view's tracks
  const held = P.oracle.heldSubProjects(info)
  if (held === null) expect(answer, `${label}: no tracks`).not.toHaveProperty('held_sub_projects')
  else expect(sorted(answer.held_sub_projects ?? []), `${label}: tracks`).toEqual(held)
  return rowIds
}

/** Compares `answer`, tasks.roadmapDependencies's for the store scope
 * `scopeId`, with the parts the oracle finds over every task the store
 * holds, and Auto-move over the answer with Auto-move over the workspace
 * within those parts. Answers whether any move was compared. */
function expectDependencies(
  P: Store,
  answer: DependencyAnswer,
  scopeId: string,
  label: string,
): number {
  const info = P.scopeInfo(scopeId)
  if (info === null) {
    expect(answer, `${label}: unavailable`).toEqual({ state: 'unavailable' })
    return 0
  }
  if (answer.state !== 'ok' || answer.auto_move.state !== 'ok')
    throw new Error(`${label}: ${JSON.stringify(answer)}`)
  const uuidOf = (key: string) => P.issueById[key]?.uuid ?? key
  const selected = P.scopedIssues(info)
  const parts = P.oracle.dependencyParts(selected)
  const pairKey = (p: { blocker: string; blocked: string }) => `${p.blocker}>${p.blocked}`
  expect(sorted(answer.auto_move.tasks.map((r) => r.id)), `${label}: part tasks`).toEqual(
    sorted(parts.tasks.map((it) => it.uuid)),
  )
  expect(sorted(answer.auto_move.pairs.map(pairKey)), `${label}: part pairs`).toEqual(
    sorted(
      parts.pairs.map((p) => pairKey({ blocker: uuidOf(p.blocker), blocked: uuidOf(p.blocked) })),
    ),
  )
  // the arrows: every pair between two selected tasks with a span
  const dated = new Set(selected.filter((it) => it.start != null).map((it) => it.id))
  const arrows = P.schedule
    .dependencyPairs(P.issues)
    .filter((p) => dated.has(p.blocker) && dated.has(p.blocked))
  expect(sorted(answer.pairs.map(pairKey)), `${label}: arrows`).toEqual(
    sorted(arrows.map((p) => pairKey({ blocker: uuidOf(p.blocker), blocked: uuidOf(p.blocked) }))),
  )
  // the write levels
  const editable = new Set(answer.auto_move.editable_projects)
  for (const row of answer.auto_move.tasks)
    expect(editable.has(row.project_id), `${label}: Edit on ${row.project_id}`).toBe(
      P.canWrite(row.project_id),
    )
  // Auto-move over the answer, each task's links built from the pairs in
  // their order, against Auto-move over the workspace within the parts
  const moves = movesOf(P, answer.auto_move)
  const inParts = new Set(parts.tasks.map((it) => it.uuid))
  const expected = P.oracle
    .workspaceMoves()
    .map((m) => ({ ...m, id: uuidOf(m.id) }))
    .filter((m) => inParts.has(m.id))
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1)
  expect([...moves].sort(byId), `${label}: moves`).toEqual([...expected].sort(byId))
  return moves.length
}

/** Auto-move over `inputs` as a view would build the solver's tasks from
 * them, with weeks on the store's grid, children from parent ids and each
 * task's links from the pairs in their order. */
function movesOf(P: Store, inputs: AutoMoveInputs) {
  const week = (iso: string | undefined) => (iso === undefined ? null : P.dates.isoToWeek(iso))
  const issues = inputs.tasks.map((row) => {
    const start = row.has_subtasks ? week(row.span?.start_week) : week(row.start_week)
    const endWeek = row.has_subtasks ? week(row.span?.end_week) : week(row.end_week)
    const end = row.has_subtasks || endWeek === null ? endWeek : Math.max(start ?? endWeek, endWeek)
    const links: { type: string; id: string }[] = []
    for (const p of inputs.pairs) {
      if (p.blocker === row.id) links.push({ type: 'blocks', id: p.blocked })
      else if (p.blocked === row.id) links.push({ type: 'blocked_by', id: p.blocker })
    }
    return {
      id: row.id,
      status: row.status,
      project: row.project_id,
      isGroup: row.has_subtasks,
      children: inputs.tasks.filter((kid) => kid.parent_id === row.id).map((kid) => kid.id),
      start,
      end,
      links,
    }
  })
  const editable = new Set(inputs.editable_projects)
  return P.schedule.autoMoves({
    issues,
    byId: Object.fromEntries(issues.map((it) => [it.id, it])),
    canWrite: (it) => editable.has(it.project),
  })
}

/** A filter row named for a case's label. */
type Filters = [label: string, filters: Partial<RoadmapFilters>]

/** The selections a caller's store offers, each top-level project it
 * shows, each of their sub-projects and My view. */
function selectionsOf(P: Store, profile: Doc<'profiles'>) {
  const out: [string, RoadmapScope, string][] = []
  for (const meta of P.visibleProjects()) {
    out.push([meta.name, projectScope(profile, meta.id), meta.id])
    for (const id of meta.children ?? [])
      if (P.canSee(id)) out.push([P.project(id)?.name ?? id, projectScope(profile, id), id])
  }
  out.push(['My view', { kind: 'mine' }, P.MINE_SCOPE])
  return out
}

/** Every filter row of `rows` in the first two windows of `windows`, and
 * the first row in the others, over every selection of `scopes` for
 * `profile`, and each selection's dependency inputs, compared with store
 * `P`. Answers how many rows each filter row found and how many moves were
 * compared. */
async function compareAll(
  t: T,
  P: Store,
  profile: Doc<'profiles'>,
  scopes: readonly [label: string, scope: RoadmapScope, storeScope: string][],
  windows: readonly [label: string, weeks: Weeks][],
  rows: readonly Filters[],
) {
  const found = new Map<string, number>()
  let moves = 0
  for (const [scopeLabel, scope, storeScope] of scopes) {
    for (const [i, [windowLabel, weeks]] of windows.entries())
      for (const [filterLabel, partial] of i < 2 ? rows : rows.slice(0, 1)) {
        const f = { ...NO_ROADMAP_FILTERS, ...partial }
        const { server } = deskFilters(P, storeScope, f)
        const answer = await roadmapFor(t, profile, scope, server, windowOf(P, weeks))
        const label = `${profile.name}, ${scopeLabel}, ${windowLabel}, ${filterLabel}`
        const ids = expectRows(P, answer, storeScope, weeks, f, label)
        found.set(filterLabel, (found.get(filterLabel) ?? 0) + ids.size)
      }
    moves += expectDependencies(
      P,
      await dependenciesFor(t, profile, scope),
      storeScope,
      `${profile.name}, ${scopeLabel}, dependencies`,
    )
  }
  return { found, moves }
}

/** The windows every case compares, in store `P`'s weeks, the app's
 * default, two weeks around `narrow`, and 260 weeks. */
function windowsOf(P: Store, narrow: number): [string, Weeks][] {
  const { w0, w1 } = P.dates.resolveWin(P.dates.DEFAULT_WIN)
  return [
    ['the default window', [w0, w1]],
    ['a narrow window', [narrow, narrow + 1]],
    ['260 weeks', [w0 - 100, w0 + 159]],
  ]
}

// ---------------------------------------------------------------- Northstar

describe('Northstar', () => {
  it('answers what the store derives, for Nora, Leo and Ben, every selection, window and filter', async () => {
    const t = newT()
    const { profiles } = await plantNorthstar(t)
    await withReach(t)
    const person = async (key: string) => {
      const id = await northstarId(`person:${key}`)
      const p = profiles.find((profile) => profile.id === id)
      if (p === undefined) throw new Error(`no ${key}`)
      return p
    }
    const [nora, leo, ben, aisha, daniel] = await Promise.all(
      ['nora', 'leo', 'ben', 'aisha', 'daniel'].map(person),
    )
    const rows: Filters[] = [
      ['no filter', {}],
      ['My tasks', { mine: true }],
      ['two owners', { owners: [aisha.id, daniel.id] }],
      ['high', { priority: 'high' }],
      ['a title word', { search: 'pcb' }],
      ['review', { search: 'review' }],
    ]
    // two days into the dataset's anchor week
    const now = Date.parse('2026-09-09T18:00:00.000Z')
    let moves = 0
    for (const profile of [nora, leo, ben]) {
      const P = await storeOf(t, profile, now)
      // a narrow window over the weeks of Northstar's Done tasks
      const doneWeeks = P.issues.filter((it) => it.status === 'done' && it.start != null)
      const narrow = doneWeeks.length > 0 ? (doneWeeks[0].start as number) : P.dates.TODAY_WEEK
      const result = await compareAll(
        t,
        P,
        profile,
        selectionsOf(P, profile),
        windowsOf(P, narrow),
        rows,
      )
      moves += result.moves
      if (profile === nora)
        for (const [label] of rows) expect(result.found.get(label), label).toBeGreaterThan(0)
    }
    console.log('Auto-move moves compared over Northstar:', moves)
  })
})

// ----------------------------------------------------------- access shapes

/** Week `w` after NOW's week as a stored day, NOW's week being
 * 2025-12-29. */
const weekDay = (w: number) =>
  new Date(Date.parse('2025-12-29T00:00:00.000Z') + w * 7 * 86_400_000).toISOString().slice(0, 10)

/** The tasks every access case plants over the withOrg fixture for
 * `subject`, dated around the fixture's NOW. In FW, PCB and a sub-project
 * of SKNK, the review hand-off cases; in FW a group with a subtask in a
 * sibling sub-project, a group stored in Backlog with a To do subtask, a
 * group stored To do whose leaves are Done, Done leaves at and past the
 * narrow window's edges, leaves with hours and priorities, a chain of
 * blocks links from FW through PCB into the sibling with dates that
 * conflict, so Auto-move has work across projects, and a blocker in PCB
 * whose two links to a group in FW and its first leaf give other moves in
 * the other order. */
async function plantCase(t: T, f: OrgFixture, subject: Doc<'profiles'>) {
  const org_id = f.org.id
  const skunk = await plantProject(t, { org_id, type: 'project', parent_id: f.hidden.id })
  const sibling = await plantProject(t, { org_id, type: 'project', parent_id: f.meta.id })
  const task = (project: Doc<'projects'>, fields: Partial<Doc<'issues'>>) =>
    plantIssue(t, { org_id, project_id: project.id, ...fields })
  const dated = (from: number, weeks = 1) => ({
    start_week: weekDay(from),
    end_week: weekDay(from + weeks - 1),
  })
  // the first task by number blocks a group and one of its leaves, the link
  // to the leaf written first: Auto-move moves the leaf and keeps its
  // sibling only when it takes the pairs in the app's order
  const blocker = await task(f.sub2, { title: 'Blocker of a family', ...dated(3) })
  const family = await task(f.sub, { title: 'Family', assignee_id: subject.id })
  const early = await task(f.sub, { title: 'Early leaf', parent_id: family.id, ...dated(0) })
  await task(f.sub, { title: 'Late leaf', parent_id: family.id, ...dated(5) })
  for (const project of [f.sub, f.sub2, skunk]) {
    await task(project, {
      title: 'Handed to review',
      status: 'review',
      assignee_id: subject.id,
      reviewer_id: f.user.id,
      remaining_hours: 2.5,
    })
    await task(project, {
      title: 'Awaiting my review',
      status: 'review',
      assignee_id: f.user.id,
      reviewer_id: subject.id,
      priority: 'high',
      ...dated(1),
    })
  }
  const group = await task(f.sub, {
    title: 'Group with a sibling subtask',
    assignee_id: subject.id,
  })
  await task(sibling, { title: 'Sibling subtask', parent_id: group.id, ...dated(0, 2) })
  await task(f.sub, { title: 'Done subtask', parent_id: group.id, status: 'done', ...dated(-1) })
  const backlog = await task(f.sub, { title: 'Group stored in Backlog', status: 'backlog' })
  await task(f.sub, { title: 'Its To do subtask', parent_id: backlog.id, assignee_id: subject.id })
  const allDone = await task(f.sub, {
    title: 'Group whose leaves are Done',
    assignee_id: subject.id,
  })
  await task(f.sub, { title: 'Done leaf', parent_id: allDone.id, status: 'done', ...dated(0) })
  await task(f.sub, {
    title: 'Done at the edge',
    status: 'done',
    assignee_id: subject.id,
    ...dated(1),
  })
  await task(f.sub, { title: 'Done past the edge', status: 'done', ...dated(2) })
  await task(f.sub, {
    title: 'Backlog leaf',
    status: 'backlog',
    remaining_hours: 4,
    assignee_id: subject.id,
  })
  await task(f.sub, { title: 'High', priority: 'high', remaining_hours: 1.5, ...dated(3, 2) })
  await task(f.sub2, {
    title: 'Low',
    priority: 'low',
    remaining_hours: 0.3,
    assignee_id: subject.id,
  })
  // the chain: k1 in FW starts before c1 in PCB ends, and c1 before c2 in
  // the sibling ends
  const k1 = await task(f.sub, { title: 'Blocked in FW', assignee_id: subject.id, ...dated(0, 2) })
  const c1 = await task(f.sub2, { title: 'Blocker in PCB', ...dated(1, 2) })
  const c2 = await task(sibling, { title: 'Blocker in the sibling', ...dated(2, 2) })
  const linkOf = (source: Doc<'issues'>, target: Doc<'issues'>, created_at: string) =>
    t.run(async (ctx) => {
      const [a, b] = [source.id, target.id].sort()
      await ctx.db.insert('issue_links', {
        org_id,
        id: uuid(),
        source_id: source.id,
        target_id: target.id,
        type: 'blocks',
        pair_key: `${a}:${b}`,
        created_at,
        task_key: source.window_key,
      })
    })
  await linkOf(c1, k1, '2026-01-03T00:00:00.000Z')
  await linkOf(c2, c1, '2026-01-02T00:00:00.000Z')
  await linkOf(blocker, family, '2026-01-05T00:00:00.000Z')
  await linkOf(blocker, early, '2026-01-04T00:00:00.000Z')
  await countOrg(t, org_id)
  return { skunk, sibling }
}

/** The filter rows every access case compares. */
const SHAPE_ROWS = (f: OrgFixture): Filters[] => [
  ['no filter', {}],
  ['My tasks', { mine: true }],
  ['the reviewer as owner', { owners: [f.user.id] }],
  ['high', { priority: 'high' }],
  ['review', { search: 'review' }],
]

/** One access case: `shape` planted for a fresh seat of `role`, or the
 * fixture's admin without a shape, compared over every selection. */
async function compareShape(
  shape: (typeof SHAPES)[number] | null,
  role: 'user' | 'guest' | 'viewer' | 'admin',
) {
  const t = newT()
  const f = await withOrg(t)
  const subject =
    role === 'admin'
      ? f.admin
      : await plantSeat(t, { org_id: f.org.id, org_role: role, auth_user_id: `auth_${uuid()}` })
  if (shape !== null) await t.run((ctx) => shape[1](ctx, f, subject))
  const { skunk, sibling } = await plantCase(t, f, subject)
  // a day into NOW's week, as the fixture's dates are set around it
  const P = await storeOf(t, subject, Date.parse(NOW) + 86_400_000)
  const scopes: [string, RoadmapScope, string][] = [
    ...[f.meta, f.sub, f.sub2, sibling, f.hidden, skunk].map(
      (p): [string, RoadmapScope, string] => [p.key, projectScope(subject, p.id), p.id],
    ),
    ['My view', { kind: 'mine' }, P.MINE_SCOPE],
  ]
  const narrow = P.dates.isoToWeek(weekDay(0))
  return {
    ...(await compareAll(t, P, subject, scopes, windowsOf(P, narrow), SHAPE_ROWS(f))),
    t,
    f,
    P,
    subject,
  }
}

describe('access shapes', () => {
  it('answers what the store derives for the admin', async () => {
    const { found, moves } = await compareShape(null, 'admin')
    expect(found.get('no filter')).toBeGreaterThan(0)
    expect(moves).toBeGreaterThan(0)
  })

  for (const role of ['user', 'guest', 'viewer'] as const)
    it(`answers what the store derives for a ${role} in every shape`, async () => {
      let showing = 0
      for (const shape of SHAPES)
        if (((await compareShape(shape, role)).found.get('no filter') ?? 0) > 0) showing++
      expect(showing).toBeGreaterThan(SHAPES.length / 3)
    })
})

// ------------------------------------------------- the rules that must hold

describe('the rules that must hold', () => {
  it('differs from a rule that hides a group stored in Backlog, from a window one week off, and from Remaining read after the filters', async () => {
    const { t, f, P, subject } = await compareShape(null, 'admin')
    const scope = projectScope(subject, f.sub.id)
    const narrow = P.dates.isoToWeek(weekDay(0))
    const weeks: Weeks = [narrow, narrow + 1]
    const answer = await roadmapFor(t, subject, scope, {}, windowOf(P, weeks))
    if (answer.state !== 'ok') throw new Error(answer.state)
    const ids = sorted(answer.rows.map((r) => r.id))
    const info = P.scopeInfo(f.sub.id)
    if (info === null) throw new Error('FW')
    const desk = deskFilters(P, f.sub.id, NO_ROADMAP_FILTERS).desk
    const rows = (w: Weeks) => P.oracle.roadmapRows(info, w[0], w[1], desk)
    expect(sorted(rows(weeks).map((it) => it.uuid))).toEqual(ids)
    // a Backlog group hidden
    const noBacklogGroup = rows(weeks).filter((it) => !(P.isGroup(it) && it.status === 'backlog'))
    expect(sorted(noBacklogGroup.map((it) => it.uuid))).not.toEqual(ids)
    // a window one week off
    expect(sorted(rows([weeks[0] + 1, weeks[1] + 1]).map((it) => it.uuid))).not.toEqual(ids)
    // Remaining after the filters
    const high = await roadmapFor(t, subject, scope, { priority: 'high' }, windowOf(P, weeks))
    if (high.state !== 'ok' || high.remaining.state !== 'ok') throw new Error('Remaining')
    const filtered = Math.round(
      P.issues
        .filter(
          (it) =>
            it.project === f.sub.id &&
            !P.isGroup(it) &&
            it.status !== 'done' &&
            P.passesFilters(it, { ...desk, priority: 'high' }),
        )
        .reduce((s, it) => s + (it.remaining || 0), 0) * 10,
    )
    expect(high.remaining.tenths[f.sub.id]).not.toBe(filtered)
  })

  it('differs from a ceiling that counts no group, and from parts kept inside the selection', async () => {
    const { t, f, P, subject } = await compareShape(null, 'admin')
    const scope = projectScope(subject, f.sub.id)
    const answer = await roadmapFor(t, subject, scope)
    if (answer.state !== 'ok') throw new Error(answer.state)
    const leaves = answer.rows.filter((r) => !r.has_subtasks).length
    expect(leaves).toBeLessThan(answer.rows.length)
    // a ceiling of one row fewer refuses, where a count of leaves alone
    // would fit
    const { ROADMAP } = await import('../../convex/lib/roadmap')
    const was = ROADMAP.ceiling
    try {
      ROADMAP.ceiling = answer.rows.length - 1
      expect(leaves).toBeLessThanOrEqual(ROADMAP.ceiling)
      expect((await roadmapFor(t, subject, scope)).state).toBe('over_ceiling')
    } finally {
      ROADMAP.ceiling = was
    }
    // Auto-move over FW's tasks alone moves less than over its parts
    const deps = await dependenciesFor(t, subject, scope)
    if (deps.state !== 'ok' || deps.auto_move.state !== 'ok') throw new Error('parts')
    const inside = {
      ...deps.auto_move,
      tasks: deps.auto_move.tasks.filter((r) => r.project_id === f.sub.id),
    }
    inside.pairs = deps.auto_move.pairs.filter(
      (p) =>
        inside.tasks.some((r) => r.id === p.blocker) &&
        inside.tasks.some((r) => r.id === p.blocked),
    )
    const whole = movesOf(P, deps.auto_move)
    expect(whole.length).toBeGreaterThan(0)
    expect(movesOf(P, inside)).not.toEqual(
      whole.filter((m) => inside.tasks.some((r) => r.id === m.id)),
    )
  })
})

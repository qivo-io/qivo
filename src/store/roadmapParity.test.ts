/* The Roadmap's server reads (convex/tasks.ts roadmap and
 * roadmapDependencies) against the app's own rules, and the stand-in the
 * jsdom tests and the benchmark answer with (store/roadmapStandIn.setup.ts)
 * against the server's reads. Each case boots the real store from the
 * caller's real workspace, as boardParity.test.ts does, and compares what
 * the queries answer for the same caller, selection, window and filter row
 * with the stand-in's answer, and with what the store's own rules derive
 * from every task it holds (store/roadmapOracle.setup.ts), which the
 * Roadmap still applies on screen when it narrows: the rows, the phone
 * agenda's set
 * (scopedIssues, isRoadmapTaskVisible, passesFilters), each group row's
 * Done and span, the shown parents and a group row's other shown
 * descendants, each sub-project's heading Remaining in tenths, My view's
 * tracks (Roadmap.tsx held), and for the dependency inputs the arrows'
 * pairs, the parts of the dependency graph over every task the workspace
 * holds, the write levels, and Auto-move's moves over the answer, through
 * the app's own builder (views/roadmap/autoMoveInputs.ts), against its
 * moves over the workspace within those parts, and the planning session's
 * task, which skips the filter row alone. Northstar runs as Nora
 * (admin), Leo and Ben over every selection; the small fixture runs every
 * access shape for a user, a guest and a viewer, and the admin. Cases that
 * must fail if a rule drifts compare a drifted rule with the server's
 * answer.
 *
 * Team utilization's inputs come the same way. planning.ownerLoads for
 * every person of the organization, asked as the owner-load cache asks
 * and compared with the stand-in, read through the app's own reconciler
 * (store/viewDelay.ts ownerItemsOf), with no task held and with the
 * store's rows of every task, give each person's hours a week and paused
 * weeks that the store's rules derive from the workspace, under All
 * projects and This project, in the default window and over 52 weeks. */

import { getFunctionName } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import type {
  AutoMoveInputs,
  DependencyAnswer,
  RoadmapAnswer,
  RoadmapFilters,
  RoadmapScope,
} from '../../convex/lib/roadmap'
import type { ViewRow } from '../../convex/lib/viewReads'
import type { OwnerLoadsJson } from '../../convex/planning'
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
import { dependenciesFor, NO_ROADMAP_FILTERS, roadmapFor } from '../../convex/tests/roadmap.setup'
import type { LoadIssue, LoadItem } from '../lib/workload'
import type { Whole as Snapshot } from './guard/liveDouble.setup'
import { oracleScope, oracleStore } from './oracleScope.setup'
import { CALL_OWNERS } from './ownerLoadCache'
import { ownerLoadsStandIn } from './ownerLoadsStandIn.setup'
import { peopleSettingsStandIn } from './peopleSettingsStandIn.setup'
import { nameEveryone } from './personShown.setup'
import type { TeamMode } from './roadmapOracle.setup'

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
  return Object.assign(store.P, {
    dates: await import('../lib/dates'),
    oracle: await import('./roadmapOracle.setup'),
    schedule: await import('../lib/schedule'),
    // the app's own builders and the stand-in, of the store's module
    // instances, whose week grid is the store's
    autoMove: await import('../views/roadmap/autoMoveInputs'),
    views: { ...(await import('./viewDelay')), ...(await import('./ownerLoadCache')) },
    standIn: await import('./roadmapStandIn.setup'),
    workload: await import('../lib/workload'),
    probe: store.__layerProbe,
    snapshot: snap,
  })
}

type Store = Awaited<ReturnType<typeof start>>
type Issue = Store['issues'][number]

/** The store booted for `profile` from their workspace, with the clock at
 * `now`. */
async function storeOf(t: T, profile: Doc<'profiles'>, now: number): Promise<Store> {
  const snap = await wholeOf(t, profile)
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
 * `weeks` with `f`, with what store `P` derives, the task with store id
 * `session` being the planning session's; answers the rows' ids. */
function expectRows(
  P: Store,
  answer: RoadmapAnswer,
  scopeId: string,
  weeks: Weeks,
  f: RoadmapFilters,
  label: string,
  session?: string,
): Set<string> {
  const info = oracleScope(P.snapshot, scopeId)
  if (info === null) {
    expect(answer, `${label}: unavailable`).toEqual({ state: 'unavailable' })
    return new Set()
  }
  if (answer.state !== 'ok') throw new Error(`${label}: ${JSON.stringify(answer)}`)
  const { desk } = deskFilters(P, scopeId, f)
  const names = P.oracle.textNames(P.snapshot)
  const rows = P.oracle.roadmapRows(info, weeks[0], weeks[1], desk, names, session)
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
  const info = oracleScope(P.snapshot, scopeId)
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
  // the arrows are every pair between two selected tasks with a span
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
  // each part task's links in the order the app lists them (its window's
  // and the workspace's model, lib/taskSections.ts linkViews), which the
  // Roadmap builds from the pairs' order
  const links = partLinks(P, answer.auto_move)
  for (const [uuid, built] of Object.entries(links)) {
    const it = Object.values(P.issueById).find((t) => t.uuid === uuid)
    if (!it) continue
    const own = (it.links ?? [])
      .filter((l) => l.type === 'blocks' || l.type === 'blocked_by')
      .map((l) => ({ type: l.type, id: uuidOf(l.id) }))
      .filter((l) => inParts.has(l.id))
    expect(built, `${label}: ${it.key}'s links`).toEqual(own)
  }
  // the pairs in another order build another order of links, which this
  // comparison catches
  const reversed = partLinks(P, {
    ...answer.auto_move,
    pairs: [...answer.auto_move.pairs].reverse(),
  })
  orderChecks.push(JSON.stringify(reversed) !== JSON.stringify(links))
  return moves.length
}

/* For each comparison of a selection's parts with a task of more than one
   link, whether the pairs in reverse order built other links. */
const orderChecks: boolean[] = []

/** Auto-move over `inputs` as the Roadmap builds the solver's tasks from
 * them (views/roadmap/autoMoveInputs.ts), with weeks on the store's grid,
 * children from parent ids and each task's links from the pairs in their
 * order. */
function movesOf(P: Store, inputs: AutoMoveInputs) {
  return P.autoMove.autoMoveMoves(inputs, P.autoMove.autoMoveTasks(inputs, P.dates.isoToWeek))
}

/** Each part task's links as the Roadmap builds them from `inputs`, by
 * uuid, in their order, for the tasks with more than one link. */
function partLinks(P: Store, inputs: AutoMoveInputs) {
  return Object.fromEntries(
    P.autoMove
      .autoMoveTasks(inputs, P.dates.isoToWeek)
      .filter((t) => (t.links?.length ?? 0) > 1)
      .map((t) => [t.id, t.links]),
  )
}

/** The facts of view rows `rows` a Roadmap reads, by id in order. */
const rowFacts = (rows: readonly ViewRow[]) =>
  rows.map((row) => [
    row.id,
    row.has_subtasks,
    row.has_hidden_subtasks,
    row.parent_id ?? null,
    row.group_done ?? null,
    row.span ?? null,
    row.start_week ?? null,
    row.end_week ?? null,
    row.status,
  ])

/** Compares the stand-in's answer `stood` with the server's `answer`, as
 * boardParity.test.ts compares the Board's: the state, every row,
 * parent and subtask in order with its facts, My view's sub-projects, a
 * project selection's sub-projects in any order, and each sub-project's
 * Remaining in tenths, an absent key 0. */
function expectStandIn(stood: RoadmapAnswer, answer: RoadmapAnswer, label: string) {
  expect(stood.state, `${label}: stand-in state`).toBe(answer.state)
  if (answer.state !== 'ok' || stood.state !== 'ok') {
    expect(stood, `${label}: stand-in`).toEqual(answer)
    return
  }
  expect(rowFacts(stood.rows), `${label}: stand-in rows`).toEqual(rowFacts(answer.rows))
  expect(rowFacts(stood.parents), `${label}: stand-in parents`).toEqual(rowFacts(answer.parents))
  expect(rowFacts(stood.subtasks), `${label}: stand-in subtasks`).toEqual(rowFacts(answer.subtasks))
  expect(stood.held_sub_projects, `${label}: stand-in tracks`).toEqual(answer.held_sub_projects)
  expect(sorted(stood.projects ?? []), `${label}: stand-in projects`).toEqual(
    sorted(answer.projects ?? []),
  )
  if (answer.remaining.state !== 'ok' || stood.remaining.state !== 'ok') {
    expect(stood.remaining, `${label}: stand-in Remaining`).toEqual(answer.remaining)
    return
  }
  const want = answer.remaining.tenths
  const got = stood.remaining.tenths
  for (const id of new Set([...Object.keys(want), ...Object.keys(got)]))
    expect(got[id] ?? 0, `${label}: stand-in Remaining of ${id}`).toBe(want[id] ?? 0)
}

/** Compares the dependency stand-in's answer `stood` with the server's
 * `answer`: the arrows' pairs and the parts' pairs in order, the parts'
 * tasks in order with their facts, and the write levels. */
function expectDependencyStandIn(stood: DependencyAnswer, answer: DependencyAnswer, label: string) {
  if (answer.state !== 'ok' || stood.state !== 'ok') {
    expect(stood, `${label}: dependency stand-in`).toEqual(answer)
    return
  }
  expect(stood.pairs, `${label}: stand-in arrows`).toEqual(answer.pairs)
  if (answer.auto_move.state !== 'ok' || stood.auto_move.state !== 'ok') {
    expect(stood.auto_move, `${label}: stand-in Auto-move`).toEqual(answer.auto_move)
    return
  }
  expect(stood.auto_move.tasks, `${label}: stand-in part tasks`).toEqual(answer.auto_move.tasks)
  expect(stood.auto_move.pairs, `${label}: stand-in part pairs`).toEqual(answer.auto_move.pairs)
  expect(stood.auto_move.editable_projects, `${label}: stand-in write levels`).toEqual(
    answer.auto_move.editable_projects,
  )
}

/** What the stand-in reads besides the workspace for store `P`: whether
 * its person sees a project and may edit it, as the store says. */
const standInOptions = (P: Store) => ({
  sees: (id: string) => P.canSee(id),
  canEdit: (id: string) => P.canWrite(id),
})

/** A filter row named for a case's label. */
type Filters = [label: string, filters: Partial<RoadmapFilters>]

/** The selections a caller's store offers, each top-level project it
 * shows, each of their sub-projects and My view. */
function selectionsOf(P: Store, profile: Doc<'profiles'>) {
  const out: [string, RoadmapScope, string][] = []
  for (const meta of oracleStore(P.snapshot).visibleProjects()) {
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
        const window = windowOf(P, weeks)
        const answer = await roadmapFor(t, profile, scope, server, window)
        const label = `${profile.name}, ${scopeLabel}, ${windowLabel}, ${filterLabel}`
        expectStandIn(
          P.standIn.roadmapStandIn(
            P.snapshot,
            { scope, filters: server, window },
            standInOptions(P),
          ),
          answer,
          label,
        )
        const ids = expectRows(P, answer, storeScope, weeks, f, label)
        found.set(filterLabel, (found.get(filterLabel) ?? 0) + ids.size)
      }
    const dependencies = await dependenciesFor(t, profile, scope)
    expectDependencyStandIn(
      P.standIn.dependenciesStandIn(P.snapshot, { scope }, standInOptions(P)),
      dependencies,
      `${profile.name}, ${scopeLabel}`,
    )
    moves += expectDependencies(
      P,
      dependencies,
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
    // a reading that drops the pairs' order fails somewhere
    expect(orderChecks.some(Boolean)).toBe(true)
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
  // to the leaf written first. Auto-move moves the leaf and keeps its
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
  // in the chain, k1 in FW starts before c1 in PCB ends, and c1 before c2
  // in the sibling ends
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

/** One access case, `shape` planted for a fresh seat of `role`, or the
 * fixture's admin, who reads by grants, without a shape, compared over every selection. */
async function compareShape(
  shape: (typeof SHAPES)[number] | null,
  role: 'user' | 'guest' | 'viewer' | 'admin',
) {
  const t = newT()
  const f = await withReadingAdmin(t)
  const subject =
    role === 'admin' && shape === null
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
  it('answers what the store derives for the fixture’s admin, who reads by grants', async () => {
    const { found, moves } = await compareShape(null, 'admin')
    expect(found.get('no filter')).toBeGreaterThan(0)
    expect(moves).toBeGreaterThan(0)
  })

  // an admin's seat is judged by its own rows, as any member's
  for (const role of ['admin', 'user', 'guest', 'viewer'] as const)
    it(`answers what the store derives for ${role === 'admin' ? 'an' : 'a'} ${role} in every shape`, async () => {
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
    const info = oracleScope(P.snapshot, f.sub.id)
    if (info === null) throw new Error('FW')
    const desk = deskFilters(P, f.sub.id, NO_ROADMAP_FILTERS).desk
    const names = P.oracle.textNames(P.snapshot)
    const rows = (w: Weeks) => P.oracle.roadmapRows(info, w[0], w[1], desk, names)
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

// ------------------------------------------------------ the planning session

describe('the planning session', () => {
  it("keeps the session's task past the filter row as Roadmap.tsx passes does, and never past the visibility rule or the selection", async () => {
    const { t, f, P, subject } = await compareShape(null, 'admin')
    /** The store's task titled `title`, in `project` where given. */
    const named = (title: string, project?: string) => {
      const it = P.issues.find((x) => x.title === title && (!project || x.project === project))
      if (it === undefined) throw new Error(title)
      return it
    }
    const { w0, w1 } = P.dates.resolveWin(P.dates.DEFAULT_WIN)
    const narrow = P.dates.isoToWeek(weekDay(0))
    const meta = projectScope(subject, f.meta.id)
    const fw = projectScope(subject, f.sub.id)
    const mine: RoadmapScope = { kind: 'mine' }
    const cases: [
      label: string,
      scope: RoadmapScope,
      storeScope: string,
      filters: Partial<RoadmapFilters>,
      weeks: Weeks,
      task: Issue,
      kept: boolean,
    ][] = [
      [
        'a task Priority hides',
        meta,
        f.meta.id,
        { priority: 'high' },
        [w0, w1],
        named('Low'),
        true,
      ],
      [
        "a task My tasks hides, which the read finds among its sub-project's tasks",
        meta,
        f.meta.id,
        { mine: true },
        [w0, w1],
        named('Blocker in PCB'),
        true,
      ],
      [
        'a task the people filter hides',
        meta,
        f.meta.id,
        { owners: [f.user.id] },
        [w0, w1],
        named('Low'),
        true,
      ],
      [
        'a task the search hides',
        fw,
        f.sub.id,
        { search: 'review' },
        [w0, w1],
        named('High'),
        true,
      ],
      [
        "the person's task Priority hides in My view",
        mine,
        P.MINE_SCOPE,
        { priority: 'high' },
        [w0, w1],
        named('Low'),
        true,
      ],
      [
        'a Done task past the window',
        meta,
        f.meta.id,
        { priority: 'high' },
        [narrow, narrow + 1],
        named('Done past the edge'),
        false,
      ],
      ['a Backlog leaf', fw, f.sub.id, {}, [w0, w1], named('Backlog leaf'), false],
      [
        "the person's task in another sub-project",
        fw,
        f.sub.id,
        { mine: true },
        [w0, w1],
        named('Low'),
        false,
      ],
      [
        'a task in another sub-project, named with its own',
        fw,
        f.sub.id,
        { mine: true },
        [w0, w1],
        named('Blocker in PCB'),
        false,
      ],
      [
        'a task the person handed to review, in My view',
        mine,
        P.MINE_SCOPE,
        {},
        [w0, w1],
        named('Handed to review', f.sub.id),
        false,
      ],
      [
        "another person's task in My view",
        mine,
        P.MINE_SCOPE,
        {},
        [w0, w1],
        named('Blocker in PCB'),
        false,
      ],
    ]
    for (const [label, scope, storeScope, partial, weeks, it, kept] of cases) {
      const row = { ...NO_ROADMAP_FILTERS, ...partial }
      const { server } = deskFilters(P, storeScope, row)
      // without the session the filter row, the window or the selection
      // hides the task
      const without = await roadmapFor(t, subject, scope, server, windowOf(P, weeks))
      expect(expectRows(P, without, storeScope, weeks, row, label).has(it.uuid), label).toBe(false)
      const answer = await roadmapFor(t, subject, scope, server, windowOf(P, weeks), {
        id: it.uuid,
        project_id: it.project,
      })
      const ids = expectRows(P, answer, storeScope, weeks, row, `${label}, planned`, it.id)
      expect(ids.has(it.uuid), `${label}, planned`).toBe(kept)
    }
  })
})

// ---------------------------------------------------------- Team utilization

/** One owner of planning.ownerLoads' answers that is not `not_read`. */
type OwnerAnswer = Exclude<OwnerLoadsJson['owners'][number], { state: 'not_read' }>

/** Every owner's answer, with what the calls said of hidden work. */
type OwnerAnswers = readonly OwnerAnswer[] & { hidden: OwnerLoadsJson['hidden'] }

/** planning.ownerLoads' answers for every person of `ids`, asked as the
 * owner-load cache asks for `profile`, at most CALL_OWNERS a call for a
 * staff seat, the not_read ones again, and one a call for a guest or
 * Viewer. Each answer is compared with the stand-in's from the store's
 * workspace (ownerLoadsStandIn.setup.ts), which the jsdom Board and the
 * benchmark answer with. */
async function ownerLoadsFor(t: T, P: Store, profile: Doc<'profiles'>, ids: readonly string[]) {
  const staff = profile.org_role === 'admin' || profile.org_role === 'user'
  const out: OwnerAnswer[] = []
  for (let ask = [...ids]; ask.length > 0; ) {
    const batch = staff ? ask.slice(0, CALL_OWNERS) : ask.slice(0, 1)
    const args = { org_id: profile.org_id, owner_ids: batch }
    const answer = await as(t, profile).query(api.planning.ownerLoads, args)
    expect(ownerLoadsStandIn(P.snapshot, args), `${profile.name}: owner-load stand-in`).toEqual(
      answer,
    )
    const notRead: string[] = []
    for (const one of answer.owners)
      if (one.state === 'not_read') notRead.push(one.owner_id)
      else out.push(one)
    // the first owner of a call is always read
    if (notRead.length === batch.length) throw new Error(`${profile.name}: no owner read`)
    ask = [...notRead, ...ask.slice(batch.length)]
  }
  return Object.assign(out, { hidden: staff ? ('counted' as const) : ('own_only' as const) })
}

/** What a reading of the answers leaves out or ignores, for the cases
 * that must fail: spans without a task kept as a project's, the paused
 * list dropped, or the spans' projects dropped, as a backend before
 * v0.1.125 sends them. */
type Drift = { keepHidden?: boolean; dropPaused?: boolean; dropProjects?: boolean }

/** How the reconciler reads a person's rows: none held, so every span and
 * paused task comes from the answer, or the store's rows of every task,
 * which then come from the rows instead (store/viewDelay.ts ownerItemsOf). */
type Held = 'none' | 'store'

/** The tasks Team utilization spreads from `owners`' answers on store
 * `P`'s grid, through the app's own cache reading (ownerLoadOf) and
 * reconciler (ownerItemsOf), with the rows `held` names. Work without a
 * project, busy time the reader is not shown, stays out, as the strip
 * leaves it out (views/Resources.tsx). */
function teamTasksOf(
  P: Store,
  owners: OwnerAnswers,
  drift: Drift = {},
  held: Held = 'none',
): LoadIssue[] {
  const { hidden } = owners
  const out: LoadIssue[] = []
  for (const one of owners) {
    if (one.state !== 'ok') throw new Error(`${one.owner_id} is ${one.state}`)
    const sent = {
      ...one,
      paused: drift.dropPaused ? [] : one.paused,
      spans: one.spans.map((span) => (drift.dropProjects ? { ...span, project_id: null } : span)),
    }
    const load = P.views.ownerLoadOf(sent, hidden)
    if (load?.state !== 'ok') throw new Error(`${one.owner_id} read as ${load?.state}`)
    const org = P.snapshot.profiles.find((p) => p.id === one.owner_id)?.org_id ?? ''
    const items =
      held === 'store' && P.probe
        ? P.probe.ownerItems(org, one.owner_id, load)
        : P.views.ownerItemsOf(org, one.owner_id, load, {
            held: () => false,
            inView: () => false,
            viewRows: () => [],
            projectLive: () => true,
            orgOf: () => org,
            heldItems: () => [],
          })
    for (const item of items) {
      if (item.project === null && !drift.keepHidden) continue
      out.push({
        owner: one.owner_id,
        project: item.project ?? 'hidden',
        start: item.start,
        end: item.end,
        remaining: item.remaining,
        remainingSet: item.remainingSet,
        paused: item.paused,
      })
    }
  }
  return out
}

/** Each of `people`'s hours in each week of `weeks` and their paused weeks
 * in Team utilization's figures `load`, hours to a millionth (the two
 * sides add the same floats in different orders); a person `load` does
 * not name has no hours and no paused weeks. */
function teamFigures(
  load: ReturnType<Store['oracle']['teamLoad']>,
  people: readonly string[],
  [w0, w1]: Weeks,
) {
  return Object.fromEntries(
    people.map((id) => {
      const hours: number[] = []
      for (let w = w0; w <= w1; w++) {
        let total = 0
        load.loads
          .get(id)
          ?.get(w)
          ?.forEach((h) => {
            total += h
          })
        hours.push(Math.round(total * 1e6) / 1e6)
      }
      return [id, { hours, paused: [...(load.paused.get(id) ?? [])].sort((a, b) => a - b) }]
    }),
  )
}

/** The profile ids of organization `orgId`, every one of them. */
const orgPeople = (t: T, orgId: string) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect()
    ).map((p) => p.id),
  )

/** The windows Team compares, in store `P`'s weeks, the app's default and
 * 52 weeks around it. */
function teamWindows(P: Store): [string, Weeks][] {
  const { w0, w1 } = P.dates.resolveWin(P.dates.DEFAULT_WIN)
  return [
    ['the default window', [w0, w1]],
    ['52 weeks', [w0 - 20, w0 + 31]],
  ]
}

/** Compares Team utilization from `owners`' answers with what store `P`
 * derives, for every selection of `scopes`, both modes where the strip
 * offers them and every window. Answers how many hours, paused weeks and
 * paused people the comparison saw. */
function expectTeam(P: Store, owners: OwnerAnswers, scopes: readonly string[], label: string) {
  const people = owners.map((o) => o.owner_id)
  const tasks = teamTasksOf(P, owners)
  // the same figures where the rows of every task the store holds stand in
  // for the answer's spans, each task counted once
  const fromRows = teamTasksOf(P, owners, {}, 'store')
  const seen = { hours: 0, paused: 0, pausedPeople: new Set<string>() }
  for (const scopeId of scopes) {
    const info = oracleScope(P.snapshot, scopeId)
    if (info === null) continue
    const modes: TeamMode[] = info.wide ? ['all'] : ['all', 'scope']
    for (const [windowLabel, weeks] of teamWindows(P))
      for (const mode of modes) {
        const what = `${label}, ${info.name}, ${mode}, ${windowLabel}`
        const derived = P.oracle.teamLoad(info, mode, ...weeks)
        // every person the strip shows was asked
        for (const id of [...derived.loads.keys(), ...derived.paused.keys()])
          expect(people, `${what}: ${id} asked`).toContain(id)
        const want = teamFigures(derived, people, weeks)
        expect(
          teamFigures(P.oracle.teamLoad(info, mode, ...weeks, tasks), people, weeks),
          what,
        ).toEqual(want)
        expect(
          teamFigures(P.oracle.teamLoad(info, mode, ...weeks, fromRows), people, weeks),
          `${what}, from the store's rows`,
        ).toEqual(want)
        for (const [id, f] of Object.entries(want)) {
          seen.hours += f.hours.filter((h) => h > 0).length
          seen.paused += f.paused.length
          if (f.paused.length > 0) seen.pausedPeople.add(id)
        }
      }
  }
  return seen
}

/** Whether Team utilization from `owners`' answers read with `drift`, or
 * under `serverMode` where the strip shows `mode`, differs from what store
 * `P` derives anywhere in `scopes`. */
function teamDiffers(
  P: Store,
  owners: OwnerAnswers,
  scopes: readonly string[],
  drift: Drift,
  mode: TeamMode,
  serverMode: TeamMode = mode,
) {
  const people = owners.map((o) => o.owner_id)
  const tasks = teamTasksOf(P, owners, drift)
  return scopes.some((scopeId) => {
    const info = oracleScope(P.snapshot, scopeId)
    if (info === null || (mode === 'scope' && info.wide)) return false
    return teamWindows(P).some(([, weeks]) => {
      const want = teamFigures(P.oracle.teamLoad(info, mode, ...weeks), people, weeks)
      const got = teamFigures(P.oracle.teamLoad(info, serverMode, ...weeks, tasks), people, weeks)
      return JSON.stringify(got) !== JSON.stringify(want)
    })
  })
}

/** Every selection a Team case compares for store `P`, My view, each
 * top-level project the store shows and each of their sub-projects it
 * shows. No view has a selection over all projects; the strip's All
 * projects mode covers them for each of these. */
function teamScopes(P: Store): string[] {
  const out = [P.MINE_SCOPE]
  for (const meta of oracleStore(P.snapshot).visibleProjects()) {
    out.push(meta.id)
    for (const id of meta.children ?? []) if (P.canSee(id)) out.push(id)
  }
  return out
}

/** The work every Team access case plants over the withOrg fixture for
 * `subject`, dated around NOW's week. The subject and the user get
 * scheduled hours in FW, PCB, a sibling sub-project of TBED and a
 * sub-project of SKNK, and a review hand-off. The subject gets a paused
 * leaf in each of those projects, a paused group, a paused review hand-off
 * and an unscheduled paused task, and the user a legacy paused Backlog
 * leaf. */
async function plantTeam(t: T, f: OrgFixture, subject: Doc<'profiles'>) {
  const org_id = f.org.id
  const skunk = await plantProject(t, { org_id, type: 'project', parent_id: f.hidden.id })
  const sibling = await plantProject(t, { org_id, type: 'project', parent_id: f.meta.id })
  const task = (project: Doc<'projects'>, fields: Partial<Doc<'issues'>>) =>
    plantIssue(t, { org_id, project_id: project.id, ...fields })
  const planned = (from: number, weeks: number, hours: number) => ({
    start_week: weekDay(from),
    end_week: weekDay(from + weeks - 1),
    remaining_hours: hours,
    remaining_set_at: NOW,
  })
  const projects = [f.sub, f.sub2, sibling, skunk]
  for (const [i, project] of projects.entries()) {
    await task(project, { title: 'Subject work', assignee_id: subject.id, ...planned(i - 1, 3, 6) })
    await task(project, { title: 'User work', assignee_id: f.user.id, ...planned(i, 2, 5) })
    await task(project, {
      title: 'Subject paused',
      assignee_id: subject.id,
      paused: true,
      ...planned(i + 1, 2, 4),
    })
  }
  await task(f.sub2, {
    title: 'Handed to the user',
    status: 'review',
    assignee_id: subject.id,
    reviewer_id: f.user.id,
    ...planned(0, 1, 2.5),
  })
  await task(f.sub, {
    title: 'Paused hand-off',
    status: 'review',
    assignee_id: subject.id,
    reviewer_id: f.user.id,
    paused: true,
    ...planned(2, 2, 1),
  })
  const group = await task(f.sub, {
    title: 'Paused group',
    assignee_id: subject.id,
    paused: true,
    ...planned(-2, 6, 9),
  })
  await task(f.sub, { title: 'Its subtask', parent_id: group.id, ...planned(0, 1, 1) })
  // a status write clears a pause, so this is legacy data
  await task(sibling, {
    title: 'Paused in Backlog',
    status: 'backlog',
    assignee_id: f.user.id,
    paused: true,
    ...planned(3, 1, 2),
  })
  await task(f.sub, { title: 'Paused, unplanned', assignee_id: subject.id, paused: true })
  await countOrg(t, org_id)
  return { skunk, sibling }
}

/** A Team access case: `shape` planted for a fresh seat of `role`, its
 * store booted and every person's answers read. */
async function teamShape(shape: (typeof SHAPES)[number] | null, role: 'user' | 'guest' | 'viewer') {
  const t = newT()
  const f = await withReadingAdmin(t)
  const subject = await plantSeat(t, {
    org_id: f.org.id,
    org_role: role,
    auth_user_id: `auth_${uuid()}`,
  })
  if (shape !== null) await t.run((ctx) => shape[1](ctx, f, subject))
  const planted = await plantTeam(t, f, subject)
  const P = await storeOf(t, subject, Date.parse(NOW) + 86_400_000)
  const owners = await ownerLoadsFor(t, P, subject, await orgPeople(t, f.org.id))
  return { t, f, P, subject, owners, ...planted }
}

describe('Team utilization', () => {
  it('derives each person’s hours and paused weeks from the owner loads as the strip does, for Nora, Leo and Ben on Northstar', async () => {
    const t = newT()
    const { org, profiles } = await plantNorthstar(t)
    await withReach(t)
    const person = async (key: string) => {
      const id = await northstarId(`person:${key}`)
      const p = profiles.find((profile) => profile.id === id)
      if (p === undefined) throw new Error(`no ${key}`)
      return p
    }
    const [nora, leo, ben, emil, daniel] = await Promise.all(
      ['nora', 'leo', 'ben', 'emil', 'daniel'].map(person),
    )
    const people = await orgPeople(t, org.id)
    const now = Date.parse('2026-09-09T18:00:00.000Z')
    for (const profile of [nora, leo, ben]) {
      const P = await storeOf(t, profile, now)
      const owners = await ownerLoadsFor(t, P, profile, people)
      const scopes = teamScopes(P)
      const seen = expectTeam(P, owners, scopes, profile.name)
      expect(seen.hours, `${profile.name}: hours compared`).toBeGreaterThan(0)
      if (profile !== nora) continue
      // the stand-in was compared for both paused tasks' owners, and the
      // strip marks their weeks
      for (const owner of [emil, daniel]) {
        const one = owners.find((o) => o.owner_id === owner.id)
        expect(one?.state === 'ok' && one.paused.length, owner.name).toBe(1)
        expect(seen.pausedPeople.has(owner.id), owner.name).toBe(true)
      }
      // these must fail, dropping the paused list, and reading every span
      // as in the selection under This project
      expect(teamDiffers(P, owners, scopes, { dropPaused: true }, 'all')).toBe(true)
      expect(teamDiffers(P, owners, scopes, {}, 'scope', 'all')).toBe(true)
      // spans read without their projects, as from a backend before
      // v0.1.125, lose This project's work
      expect(teamDiffers(P, owners, scopes, { dropProjects: true }, 'scope')).toBe(true)
      // and the answers read as built match everywhere
      expect(teamDiffers(P, owners, scopes, {}, 'all')).toBe(false)
      expect(teamDiffers(P, owners, scopes, {}, 'scope')).toBe(false)
    }
  })

  it("gives the planning panel the figures planning.assigneeLoad gave, from the owner loads through the app's reconciler", async () => {
    const t = newT()
    const { org, profiles } = await plantNorthstar(t)
    await withReach(t)
    const people = await orgPeople(t, org.id)
    const now = Date.parse('2026-09-09T18:00:00.000Z')
    for (const key of ['nora', 'leo']) {
      const id = await northstarId(`person:${key}`)
      const profile = profiles.find((p) => p.id === id)
      if (!profile) throw new Error(`no ${key}`)
      const P = await storeOf(t, profile, now)
      const owners = await ownerLoadsFor(t, P, profile, people)
      const { w0, w1 } = P.dates.resolveWin(P.dates.DEFAULT_WIN)
      const name = (projectId: string) => P.project(projectId)?.name ?? null
      let compared = 0
      for (const one of owners) {
        if (one.state !== 'ok') continue
        // the rows the panel read before, unestimated ones kept
        const rows = await as(t, profile).query(api.planning.assigneeLoad, {
          assignee_id: one.owner_id,
        })
        const before: LoadItem[] = rows.map((r) => ({
          issueUuid: r.issue_id || null,
          projectId: r.project_id || null,
          projectName: r.project_name || null,
          start: P.dates.isoToWeek(r.start_week),
          end: P.dates.isoToWeek(r.end_week),
          remaining: r.remaining != null ? Number(r.remaining) : 0,
          remainingSet: r.remaining_set_at != null ? P.dates.tsToWeek(r.remaining_set_at) : null,
          visible: !!r.visible,
        }))
        const load = P.views.ownerLoadOf(one, owners.hidden)
        if (load?.state !== 'ok') throw new Error(`${one.owner_id} read as ${load?.state}`)
        const items = P.views.ownerItemsOf(profile.org_id, one.owner_id, load, {
          held: () => false,
          inView: () => false,
          viewRows: () => [],
          projectLive: () => true,
          orgOf: () => profile.org_id,
          heldItems: () => [],
        })
        const after = P.views.planItemsOf(items, name)
        const buckets = (list: typeof before) =>
          P.workload
            .loadByProject(list, w0, w1)
            .map((b) => [b.projectId, b.name, Math.round(b.hours * 1e6) / 1e6])
        expect(buckets(after), `${profile.name}: ${one.owner_id}'s panel`).toEqual(buckets(before))
        // auto-fit places the same end against either
        for (const hours of [8, 40, 120])
          expect(
            P.workload.fitEndWeekAgainst(after, null, P.dates.TODAY_WEEK, hours, 40),
            `${profile.name}: ${one.owner_id}'s fit of ${hours} h`,
          ).toBe(P.workload.fitEndWeekAgainst(before, null, P.dates.TODAY_WEEK, hours, 40))
        if (before.length > 0) compared++
      }
      expect(compared, profile.name).toBeGreaterThan(0)
    }
  })

  for (const role of ['user', 'guest', 'viewer'] as const)
    it(`derives what the strip does for a ${role} in every shape`, async () => {
      let paused = 0
      for (const shape of SHAPES) {
        const { P, owners, subject } = await teamShape(shape, role)
        const seen = expectTeam(P, owners, teamScopes(P), `${subject.name}, ${shape[0]}`)
        paused += seen.paused
      }
      expect(paused).toBeGreaterThan(0)
    })

  it('differs from a reading that keeps spans without a task, ignores their projects or drops the paused list', async () => {
    // a user who sees TBED and not SKNK
    const onTbed: (typeof SHAPES)[number] = [
      'user grant on TBED',
      (ctx, f, me) =>
        ctx.db.insert('project_access', {
          project_id: f.meta.id,
          profile_id: me.id,
          level: 'user',
        }),
    ]
    const { P, owners, f, subject, sibling } = await teamShape(onTbed, 'user')
    const scopes = teamScopes(P)
    // the user's work in SKNK, which the subject cannot see, comes as busy
    // time without a task id to a staff seat
    const user = owners.find((o) => o.owner_id === f.user.id)
    expect(user?.state === 'ok' && user.spans.some((s) => s.issue_id === null)).toBe(true)
    expect(teamDiffers(P, owners, scopes, { keepHidden: true }, 'all')).toBe(true)
    // the subject's work in PCB and the sibling, outside FW
    expect(oracleScope(P.snapshot, f.sub.id)?.wide).toBe(false)
    expect(teamDiffers(P, owners, [f.sub.id], {}, 'scope', 'all')).toBe(true)
    expect(teamDiffers(P, owners, [f.sub.id, sibling.id], {}, 'scope')).toBe(false)
    // the subject's paused leaves
    expect(teamDiffers(P, owners, scopes, { dropPaused: true }, 'all')).toBe(true)
    // the subject's paused leaves of FW, PCB and the sibling; the paused
    // group, the leaf in SKNK and the unplanned one stay out, and the paused
    // hand-off is its reviewer's
    const me = owners.find((o) => o.owner_id === subject.id)
    expect(me?.state === 'ok' && me.paused.map((p) => p.project_id).sort()).toEqual(
      [f.sub.id, f.sub2.id, sibling.id].sort(),
    )
    expect(teamDiffers(P, owners, scopes, {}, 'all')).toBe(false)
  })
})

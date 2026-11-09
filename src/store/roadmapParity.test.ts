/* The Roadmap's server reads (convex/tasks.ts roadmap and
 * roadmapDependencies) against the stand-in the jsdom tests and the
 * benchmark answer with (store/roadmapStandIn.setup.ts), and against the
 * narrowing the Roadmap still runs on screen over its models. Each case
 * boots the real store from the caller's real workspace, as
 * boardParity.test.ts does, and compares what the queries answer for the
 * same caller, selection, window and filter row with the stand-in's
 * answer: the rows, parents and subtasks in order with their facts, My
 * view's tracks, each sub-project's heading Remaining in tenths, and for
 * the dependency inputs the arrows' pairs, the parts' tasks and pairs and
 * the write levels. Every row of an answer then passes the Roadmap's own
 * narrowing (src/views/roadmap/useRoadmapView.ts passes), and each part
 * task's links, as the Roadmap builds them from the pairs' order, are the
 * order its window lists the stored relations in. Northstar runs as Nora
 * (admin), Leo and Ben over every selection; the small fixture runs every
 * access shape for a user, a guest and a viewer, and the admin. Cases that
 * must fail if a rule drifts compare a drifted rule with the server's
 * answer.
 *
 * Team utilization's inputs come the same way. planning.ownerLoads for
 * every person of the organization, asked as the owner-load cache asks
 * and compared with the stand-in, read through the app's own reconciler
 * (store/viewDelay.ts ownerItemsOf) with no view's rows, give each person
 * the answer's spans with their projects and its paused tasks, and the
 * planning panel the figures planning.assigneeLoad gave. */

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
import { linkViews } from '../lib/taskSections'
import type { LoadItem } from '../lib/workload'
import type { Whole as Snapshot } from './guard/liveDouble.setup'
import { oracleLevels, oracleScope, oracleStore } from './oracleScope.setup'
import { CALL_OWNERS } from './ownerLoadCache'
import { ownerLoadsStandIn } from './ownerLoadsStandIn.setup'
import { peopleSettingsStandIn } from './peopleSettingsStandIn.setup'
import { nameEveryone } from './personShown.setup'

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
    visibility: await import('../lib/roadmapVisibility'),
    rows: await import('./viewRows'),
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

/** Checks that every row of `answer`, tasks.roadmap's for the store scope
 * `scopeId` in `weeks` with `f`, passes the narrowing the Roadmap runs on
 * screen over its models (src/views/roadmap/useRoadmapView.ts passes): the
 * answer's selection, My view's P.isMine, isRoadmapTaskVisible in the
 * window and P.passesFilters with the text left to the answer, the task
 * with store id `session` past the filter row. A selection the caller
 * cannot see answers unavailable. Answers the rows' ids. */
function expectNarrowing(
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
  const views = P.rows.createViewRows(P.dates.isoToWeek)
  views.take('parity', [...answer.rows, ...answer.parents, ...answer.subtasks])
  views.beginPaint()
  views.reshape({ handleNow: P.handleNow })
  const selection = answer.held_sub_projects ? null : new Set(answer.projects ?? [])
  for (const row of answer.rows) {
    const it = views.model('parity', row.id)
    if (!it) throw new Error(`${label}: no model of ${row.id}`)
    const done = views.factsOf(it)?.done ?? false
    expect(
      (selection === null || selection.size === 0 || selection.has(it.project)) &&
        (!info.mine || P.isMine(it)) &&
        P.visibility.isRoadmapTaskVisible(it, done, weeks[0], weeks[1]) &&
        (session === it.uuid || P.passesFilters(it, { ...desk, search: '' })),
      `${label}: ${it.key} passes`,
    ).toBe(true)
  }
  return new Set(answer.rows.map((row) => row.id))
}

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

/** Checks Auto-move's inputs `inputs`, a selection's parts, as the
 * Roadmap builds the solver's tasks from them: each part task's links,
 * built from the pairs in their order, are its blocks links within the
 * parts in the order its window lists them (lib/taskSections.ts linkViews),
 * over the relations stored for store `P`'s caller. Notes whether the pairs
 * in reverse order built other links, and answers how many moves Auto-move
 * gives over the inputs. */
function expectPartLinks(P: Store, inputs: AutoMoveInputs, label: string) {
  const inParts = new Set(inputs.tasks.map((row) => row.id))
  const links = partLinks(P, inputs)
  for (const [uuid, built] of Object.entries(links)) {
    const stored = P.snapshot.links.filter((l) => l.source_id === uuid || l.target_id === uuid)
    const own = linkViews(uuid, stored, (other) => inParts.has(other))
      .filter((l) => l.type === 'blocks' || l.type === 'blocked_by')
      .map((l) => ({ type: l.type, id: l.other }))
    expect(built, `${label}: ${uuid}'s links`).toEqual(own)
  }
  const reversed = partLinks(P, { ...inputs, pairs: [...inputs.pairs].reverse() })
  orderChecks.push(JSON.stringify(reversed) !== JSON.stringify(links))
  return movesOf(P, inputs).length
}

/* For each comparison of a selection's parts, whether the pairs in reverse
   order built other links. */
const orderChecks: boolean[] = []

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
 * its person sees a project and may edit it, as the server judges it over
 * the caller's whole (oracleScope.setup.ts oracleLevels). */
function standInOptions(P: Store) {
  const levels = oracleLevels(P.snapshot)
  return {
    sees: (id: string) => levels.has(id),
    canEdit: (id: string) => levels.get(id) === 'lead' || levels.get(id) === 'user',
  }
}

/** A filter row named for a case's label. */
type Filters = [label: string, filters: Partial<RoadmapFilters>]

/** The selections a caller's store offers, each top-level project it
 * shows, each of their sub-projects and My view. */
function selectionsOf(P: Store, profile: Doc<'profiles'>) {
  const out: [string, RoadmapScope, string][] = []
  const seen = oracleStore(P.snapshot)
  for (const meta of seen.visibleProjects()) {
    out.push([meta.name, projectScope(profile, meta.id), meta.id])
    for (const id of meta.children ?? [])
      if (seen.canSee(id)) out.push([seen.project(id)?.name ?? id, projectScope(profile, id), id])
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
        const ids = expectNarrowing(P, answer, storeScope, weeks, f, label)
        found.set(filterLabel, (found.get(filterLabel) ?? 0) + ids.size)
      }
    const dependencies = await dependenciesFor(t, profile, scope)
    expectDependencyStandIn(
      P.standIn.dependenciesStandIn(P.snapshot, { scope }, standInOptions(P)),
      dependencies,
      `${profile.name}, ${scopeLabel}`,
    )
    if (dependencies.state === 'ok' && dependencies.auto_move.state === 'ok')
      moves += expectPartLinks(P, dependencies.auto_move, `${profile.name}, ${scopeLabel}`)
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
    for (const profile of [nora, leo, ben]) {
      const P = await storeOf(t, profile, now)
      // a narrow window over the weeks of Northstar's Done tasks
      const doneStart = P.snapshot.issues.find(
        (row) => row.status === 'done' && row.start_week !== undefined,
      )?.start_week
      const narrow = doneStart ? P.dates.isoToWeek(doneStart) : P.dates.TODAY_WEEK
      const result = await compareAll(
        t,
        P,
        profile,
        selectionsOf(P, profile),
        windowsOf(P, narrow),
        rows,
      )
      if (profile === nora)
        for (const [label] of rows) expect(result.found.get(label), label).toBeGreaterThan(0)
    }
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
  it("keeps the session's task past the filter row, as Roadmap.tsx passes does, and never past the visibility rule or the selection", async () => {
    const { t, f, P, subject } = await compareShape(null, 'admin')
    /** The server's task titled `title`, in `project` where given. */
    const named = (title: string, project?: string) => {
      const row = P.snapshot.issues.find(
        (x) => x.title === title && (!project || x.project_id === project),
      )
      if (row === undefined) throw new Error(title)
      return { uuid: row.id, project: row.project_id }
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
      task: { uuid: string; project: string },
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
      expect(expectNarrowing(P, without, storeScope, weeks, row, label).has(it.uuid), label).toBe(
        false,
      )
      const answer = await roadmapFor(t, subject, scope, server, windowOf(P, weeks), {
        id: it.uuid,
        project_id: it.project,
      })
      const ids = expectNarrowing(P, answer, storeScope, weeks, row, `${label}, planned`, it.uuid)
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

/** Checks that the app's reconciler over `owners`' answers, through its
 * cache reading (store/ownerLoadCache.ts ownerLoadOf) and with no view's
 * rows (store/viewDelay.ts ownerItemsOf), gives each owner the answer's
 * own spans, each with its project, and its paused list, so Team
 * utilization and the planning panel count each span once and a paused
 * task as no hours. With `dropPaused`, as a reading that dropped the
 * paused list, answers whether any owner's paused work went missing.
 * Answers how many spans and paused tasks it compared. */
function expectReconciled(P: Store, owners: OwnerAnswers, label: string, dropPaused = false) {
  const seen = { spans: 0, paused: 0, missing: false }
  for (const one of owners) {
    if (one.state !== 'ok') throw new Error(`${one.owner_id} is ${one.state}`)
    const sent = dropPaused ? { ...one, paused: [] } : one
    const load = P.views.ownerLoadOf(sent, owners.hidden)
    if (load?.state !== 'ok') throw new Error(`${one.owner_id} read as ${load?.state}`)
    const org = P.snapshot.profiles.find((p) => p.id === one.owner_id)?.org_id ?? ''
    const items = P.views.ownerItemsOf(org, one.owner_id, load, {
      inView: () => false,
      viewRows: () => [],
      projectLive: () => true,
      orgOf: () => org,
    })
    const paused = items.filter((item) => item.paused).map((item) => [item.uuid, item.project])
    const answered = one.paused.map((item) => [item.issue_id, item.project_id])
    if (dropPaused) {
      if (paused.length < answered.length) seen.missing = true
      continue
    }
    const spans = items
      .filter((item) => !item.paused)
      .map((item) => [item.uuid, item.project, item.remaining])
    expect(spans, `${label}: spans of ${one.owner_id}`).toEqual(
      one.spans.map((span) => [
        span.issue_id ?? null,
        span.issue_id ? (span.project_id ?? null) : null,
        span.remaining != null ? Number(span.remaining) : 0,
      ]),
    )
    expect(paused, `${label}: paused of ${one.owner_id}`).toEqual(answered)
    seen.spans += spans.length
    seen.paused += paused.length
  }
  return seen
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
  it('reconciles each person’s spans and paused tasks from the owner loads, for Nora, Leo and Ben on Northstar', async () => {
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
      const seen = expectReconciled(P, owners, profile.name)
      expect(seen.spans, `${profile.name}: spans compared`).toBeGreaterThan(0)
      if (profile !== nora) continue
      // both paused tasks' owners answer one paused task each
      for (const owner of [emil, daniel]) {
        const one = owners.find((o) => o.owner_id === owner.id)
        expect(one?.state === 'ok' && one.paused.length, owner.name).toBe(1)
      }
      // a reading that drops the paused list must fail
      expect(expectReconciled(P, owners, profile.name, true).missing).toBe(true)
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
      const name = (projectId: string) =>
        P.snapshot.projects.find((p) => p.id === projectId)?.name ?? null
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
          inView: () => false,
          viewRows: () => [],
          projectLive: () => true,
          orgOf: () => profile.org_id,
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
    it(`reconciles the owner loads for a ${role} in every shape`, async () => {
      let paused = 0
      for (const shape of SHAPES) {
        const { P, owners, subject } = await teamShape(shape, role)
        paused += expectReconciled(P, owners, `${subject.name}, ${shape[0]}`).paused
      }
      expect(paused).toBeGreaterThan(0)
    })
})

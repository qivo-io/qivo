/* The Board's server read (convex/tasks.ts board) against the rules the
 * Board still runs on screen over its answer (src/views/board/useBoardView.ts
 * passes). Each case boots the real store, as the app does, holding no task,
 * from the caller's real workspace, and checks that every row tasks.board
 * answers for the same caller passes the app's own narrowing for the same
 * arguments (P.passesFilters on the model the store shapes from the row,
 * the selection and My view's P.isMine), so the narrowing never drops a row
 * the server keeps. Every case also compares the stand-in the jsdom tests
 * and the browser benchmark answer with (store/boardStandIn.setup.ts),
 * given the caller's working set and the server's sight rule, and the
 * owner loads' stand-in with planning.ownerLoads, and checks that the task
 * window over a card judges its delay through the same judge as the card
 * (store/viewDelay.ts, store/planner.ts P.windowDelay). The clock is frozen
 * so a Stale cutoff equals stale_before. Northstar runs as Nora (admin),
 * Leo and Ben over every selection; the small fixture runs every access
 * shape for a user, a guest and a viewer, and the admin, over plants that
 * hide parents, subtasks and projects. One case makes an owner's tasks
 * compete for a week's hours. Two cases must fail if the Reviewer rule
 * drifts. */

import { getFunctionName } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import type { BoardAnswer, BoardFilters, BoardScope } from '../../convex/lib/board'
import { taskOwnerId } from '../../convex/lib/review'
import type { ViewRow } from '../../convex/lib/viewReads'
import type { OwnerLoadsJson } from '../../convex/planning'
import { SHAPES } from '../../convex/tests/accessShapes.setup'
import { boardFor, NO_FILTERS, projectScope } from '../../convex/tests/board.setup'
import {
  as,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantLogin,
  plantProject,
  plantSeat,
  type T,
  uuid,
  wholeOf,
  withReadingAdmin,
} from '../../convex/tests/helpers.setup'
import { northstarId, plantNorthstar } from '../../convex/tests/northstar.setup'
import { withReach } from '../../convex/tests/projectReach.setup'
import { DELAY_UNKNOWN } from '../lib/delay'
import { DEFAULT_PLANNABLE_HOURS, plannableHoursOf } from '../lib/workload'
import { boardStandIn } from './boardStandIn.setup'
import type { Whole as Snapshot } from './guard/liveDouble.setup'
import { oracleLevels, oracleScope, oracleStore } from './oracleScope.setup'
import type { OwnerLoad } from './ownerLoadCache'
import { ownerLoadsStandIn } from './ownerLoadsStandIn.setup'
import { peopleSettingsStandIn } from './peopleSettingsStandIn.setup'
import { nameEveryone } from './personShown.setup'
import type { ViewDelayCtx } from './viewDelay'

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

const DAY = 86_400_000

/* The app's Stale threshold (src/store/planner.ts isStale). */
const STALE_DAYS = 120

/** A fresh store whose first delivery is `snap`. */
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
  // the week indexes of the store's own timeline (src/lib/dates.ts)
  const { isoToWeek } = await import('../lib/dates')
  // the view rows, delays and owner loads of the store's own module
  // instances, whose week grid is the store's (src/lib/dates.ts)
  const views = {
    ...(await import('./viewRows')),
    ...(await import('./viewDelay')),
    ...(await import('./ownerLoadCache')),
  }
  return Object.assign(store.P, {
    weekOf: isoToWeek,
    snapshot: snap,
    __probe: store.__layerProbe,
    __views: views,
  })
}

type Store = Awaited<ReturnType<typeof start>>

/** The store booted for `profile` from their workspace, with the clock at
 * `now`, so isStale's cutoff is STALE_DAYS before it. */
async function storeOf(t: T, profile: Doc<'profiles'>, now?: number): Promise<Store> {
  const snap = await wholeOf(t, profile)
  if (snap === null) throw new Error(`no workspace for ${profile.name}`)
  if (now !== undefined) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
  }
  return await start(snap)
}

const sorted = (ids: Iterable<string>) => [...ids].sort()

/** Checks that every row of `answer`, tasks.board's for `scope` and
 * `filters`, passes the narrowing the Board runs on screen over its models
 * for the store scope `scopeId` (src/views/board/useBoardView.ts passes):
 * the answer's selection, My view's P.isMine and P.passesFilters with the
 * text and a group's Stale left to the answer. A selection the server's
 * rule does not show answers unavailable. */
function expectNarrowing(
  P: Store,
  answer: BoardAnswer,
  scopeId: string,
  filters: BoardFilters,
  label: string,
) {
  const info = oracleScope(P.snapshot, scopeId)
  // a selection the caller cannot see is one the server does not answer
  if (info === null) {
    expect(answer, `${label}: unavailable`).toEqual({ state: 'unavailable' })
    return
  }
  if (answer.state !== 'ok') throw new Error(`${label}: ${JSON.stringify(answer)}`)
  const mine = P.isMineScope(scopeId)
  // the filter row as App's effFilters hands it to the Board
  const desk = {
    mine: mine || filters.mine,
    assignees: mine ? [] : filters.owners,
    priority: filters.priority,
    stale: filters.stale_before !== null,
    focus: filters.focus,
    search: '',
  }
  const selection = answer.projects ? new Set(answer.projects) : null
  const models = shapedModels(P, answer.rows)
  for (const row of answer.rows) {
    const it = models.get(row.id)
    if (!it) throw new Error(`${label}: no model of ${row.id}`)
    const local = { ...desk, stale: desk.stale && !it.isGroup }
    expect(
      (selection === null || selection.has(it.project)) &&
        (!mine || P.isMine(it)) &&
        P.passesFilters(it, local),
      `${label}: ${it.key} passes`,
    ).toBe(true)
  }
}

/** Compares the stand-in's answer for `scope` and `filters`, from the
 * workspace store `P` booted on, with `answer`, the server's: its state,
 * rows, parents, group facts, lanes and sub-projects. */
function expectStandIn(
  P: Store,
  answer: BoardAnswer,
  scope: BoardScope,
  filters: BoardFilters,
  label: string,
) {
  const levels = oracleLevels(P.snapshot)
  const stood = boardStandIn(P.snapshot, { scope, filters }, { sees: (id) => levels.has(id) })
  expect(stood.state, `${label}: stand-in state`).toBe(answer.state)
  if (answer.state !== 'ok' || stood.state !== 'ok') return
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id)
  expect(ids(stood.rows), `${label}: stand-in rows`).toEqual(ids(answer.rows))
  expect(ids(stood.parents), `${label}: stand-in parents`).toEqual(ids(answer.parents))
  const facts = (rows: BoardAnswer & { state: 'ok' }) =>
    [...rows.rows, ...rows.parents].map((row) => [
      row.id,
      row.has_subtasks,
      row.has_hidden_subtasks,
      row.parent_id ?? null,
      row.group_done ?? null,
      row.span?.partial ?? null,
    ])
  expect(facts(stood), `${label}: stand-in facts`).toEqual(facts(answer))
  expect(sorted(stood.held_projects), `${label}: stand-in lanes`).toEqual(
    sorted(answer.held_projects),
  )
  expect(sorted(stood.projects ?? []), `${label}: stand-in projects`).toEqual(
    sorted(answer.projects ?? []),
  )
}

/** The models the store shapes from `rows` (store/viewRows.ts), by uuid,
    with the store's own week grid and handles. */
function shapedModels(P: Store, rows: readonly ViewRow[]) {
  const views = P.__views.createViewRows(P.weekOf)
  views.take('parity', rows)
  views.beginPaint()
  views.reshape({ handleNow: P.handleNow })
  return new Map(
    rows.map((row) => {
      const it = views.model('parity', row.id)
      if (!it) throw new Error(`no model of ${row.id}`)
      return [row.id, Object.assign(it, { facts: views.factsOf(it) })]
    }),
  )
}

/* How many verdicts expectDelays compared, and how many of them were
   groups' or not on track, so a case can tell the comparison ran. */
const compared = { rows: 0, groups: 0, flagged: 0 }

/** Judges the delay of each row of `answer` as the owner-load cache judges
    a view's task (store/viewDelay.ts), from planning.ownerLoads for
    `profile`, whose owner-load stand-in must answer the same, and checks
    that the task window over the card, which shows the task from its own
    read, judges it through the same judge to the same verdict, except
    where the owner's load is unavailable. The answer's own rows stand in
    for their spans. */
async function expectDelays(
  t: T,
  P: Store,
  profile: Doc<'profiles'>,
  answer: BoardAnswer,
  label: string,
) {
  // each row's verdict as a card shows it, by uuid
  const verdicts = new Map<string, string | null>()
  if (answer.state !== 'ok') return verdicts
  const { delayIssueOfTask, judgeDelay, needsLoad, ownerLoadOf, viewDelay } = P.__views
  // each owner's face, which the test named (nameEveryone), else the
  // signed-in person's own profile
  const capacity = (id: string) => {
    const person = P.person(id)
    return (person?.state === 'ok' && plannableHoursOf(person)) || DEFAULT_PLANNABLE_HOURS
  }
  const answerRows = [...answer.rows, ...answer.parents]
  const owners = [
    ...new Set(
      answerRows
        .filter((row) => needsLoad(row, capacity))
        .map((row) => taskOwnerId(row, row.has_subtasks) as string),
    ),
  ]
  // as the cache asks: 50 a call for staff, one for a guest or Viewer
  const staff = profile.org_role === 'admin' || profile.org_role === 'user'
  const loads = new Map<string, OwnerLoad>()
  for (let ask = owners; ask.length > 0; ) {
    const batch = staff ? ask.slice(0, 50) : ask.slice(0, 1)
    const args = { org_id: profile.org_id, owner_ids: batch }
    const out = (await as(t, profile).query(api.planning.ownerLoads, args)) as OwnerLoadsJson
    // the stand-in the jsdom tests and the benchmark answer with, from the
    // caller's workspace, answers the same
    expect(ownerLoadsStandIn(P.snapshot, args), `${label}: owner-load stand-in`).toEqual(out)
    const notRead: string[] = []
    for (const one of out.owners) {
      const load = ownerLoadOf(one, out.hidden)
      if (load === null) notRead.push(one.owner_id)
      else loads.set(one.owner_id, load)
    }
    ask = [...notRead, ...ask.slice(batch.length)]
  }
  // the answer's rows stand in for the spans of their tasks
  const answerIds = new Set(answerRows.map((row) => row.id))
  // the projects as the caller's navigation reads answer them, which the
  // store names only for the views on screen
  const seen = oracleStore(P.snapshot)
  const judge: ViewDelayCtx = {
    load: (_org, owner) => loads.get(owner.toLowerCase()) ?? { state: 'waiting' },
    inView: (uuid) => answerIds.has(uuid),
    viewRows: () => answerRows,
    capacity,
    capacityWaits: () => false,
    projectLive: (id) => !!seen.project(id),
    orgOf: (id) => {
      const person = P.person(id)
      return person?.state === 'ok' ? person.org : undefined
    },
    memo: new Map(),
  }
  const models = shapedModels(P, answerRows)
  for (const row of answerRows) {
    const it = models.get(row.id)
    const project = it && seen.project(it.project)
    if (!it || !project || project.trackDelay === false) continue
    const owner = taskOwnerId(row, row.has_subtasks)
    if (owner && loads.get(owner.toLowerCase())?.state === 'unavailable') continue
    // the status a card shows
    const judged = viewDelay(row, judge)
    verdicts.set(row.id, judged === DELAY_UNKNOWN ? 'unknown' : (judged?.status ?? null))
    // the task window over the card, which shows the task from its own
    // read, judges it from its view model through the same judge
    const shown = delayIssueOfTask(
      it,
      { isGroup: it.isGroup, isDone: !!it.facts?.done, partial: !!it.facts?.partial },
      capacity,
    )
    expect(judgeDelay(shown, it.org, judge), `${label}: ${it.key} the window's delay`).toEqual(
      judged,
    )
    compared.rows++
    if (row.has_subtasks) compared.groups++
    if (judged !== null && judged !== DELAY_UNKNOWN && judged.status !== 'ok') compared.flagged++
  }
  return verdicts
}

/** A filter row named for a case's label. */
type Filters = [label: string, filters: Partial<BoardFilters>]

/** Runs every filter row of `rows` over every selection of `scopes` for
 * `profile` and compares each with store `P`. */
async function compareAll(
  t: T,
  P: Store,
  profile: Doc<'profiles'>,
  scopes: readonly [label: string, scope: BoardScope, storeScope: string][],
  rows: readonly Filters[],
): Promise<Map<string, number>> {
  // how many rows each filter row found over every selection
  const found = new Map<string, number>()
  for (const [scopeLabel, scope, storeScope] of scopes)
    for (const [filterLabel, partial] of rows) {
      // what the app sends: My view forces My tasks and drops the people
      // filter, whose control it hides (src/App.tsx effFilters)
      const filters: BoardFilters = {
        ...NO_FILTERS,
        ...partial,
        ...(scope.kind === 'mine' ? { mine: true, owners: [] } : {}),
      }
      const answer = await boardFor(t, profile, scope, filters)
      const label = `${profile.name}, ${scopeLabel}, ${filterLabel}`
      expectNarrowing(P, answer, storeScope, filters, label)
      expectStandIn(P, answer, scope, filters, label)
      // the cards' delays as the owner-load cache judges them
      if (filterLabel === 'no filter') await expectDelays(t, P, profile, answer, label)
      if (answer.state === 'ok')
        found.set(filterLabel, (found.get(filterLabel) ?? 0) + answer.rows.length)
    }
  return found
}

/** The selections a caller's store offers: each top-level project it
 * shows, each of their sub-projects and My view. */
function selectionsOf(P: Store, profile: Doc<'profiles'>) {
  const out: [string, BoardScope, string][] = []
  const seen = oracleStore(P.snapshot)
  for (const meta of seen.visibleProjects()) {
    out.push([meta.name, projectScope(profile, meta.id), meta.id])
    for (const id of meta.children ?? [])
      if (seen.canSee(id)) out.push([seen.project(id)?.name ?? id, projectScope(profile, id), id])
  }
  out.push(['My view', { kind: 'mine' }, P.MINE_SCOPE])
  return out
}

// ---------------------------------------------------------------- Northstar

describe('Northstar', () => {
  it('answers what the store derives, for Nora, Leo and Ben, every selection and filter', async () => {
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
    const tasks = await t.run((ctx) =>
      ctx.db
        .query('issues')
        .withIndex('by_org_archived', (q) =>
          q.eq('org_id', nora.org_id).eq('archived_at', undefined),
        )
        .collect(),
    )
    // a cutoff with Northstar's activity on both sides of it
    const times = [...new Set(tasks.map((task) => Date.parse(task.updated_at)))].sort(
      (a, b) => a - b,
    )
    const cutoff = times[Math.floor(times.length / 2)]
    const staleBefore = new Date(cutoff).toISOString()
    // words from the data: a title word, a task number, a word only some
    // description holds, a label name and words that land on different fields
    const texts = await t.run(async (ctx) =>
      Promise.all(
        tasks.map(async (task) => ({
          task,
          text:
            (
              await ctx.db
                .query('issue_descriptions')
                .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
                .first()
            )?.description ?? '',
        })),
      ),
    )
    const titleWords = new Set(tasks.flatMap((task) => task.title.toLowerCase().split(/\s+/)))
    const textOnly = texts
      .flatMap(({ text }) => text.toLowerCase().split(/[^a-z]+/))
      .find((word) => word.length > 6 && ![...titleWords].some((w) => w.includes(word)))
    if (textOnly === undefined) throw new Error('no word only a description holds')
    // a label and a word of the title of a task that carries it
    const labelled = await t.run(async (ctx) => {
      const row = await ctx.db.query('issue_labels').first()
      const label =
        row === null
          ? null
          : await ctx.db
              .query('labels')
              .withIndex('by_uuid', (q) => q.eq('id', row.label_id))
              .unique()
      const task = tasks.find((one) => one.id === row?.issue_id)
      return label === null || task === undefined ? null : { label: label.name, task }
    })
    if (labelled === null) throw new Error('Northstar has no labels')
    const label = labelled.label
    const titleWord = labelled.task.title.split(/\s+/).sort((a, b) => b.length - a.length)[0]
    const reviewed = tasks.find((task) => task.reviewer_id !== undefined)
    const num = tasks.find((task) => task.parent_id !== undefined)?.num ?? tasks[0].num
    const rows: Filters[] = [
      ['no filter', {}],
      ['Focus', { focus: true }],
      ['My tasks', { mine: true }],
      ['two owners', { owners: [aisha.id, daniel.id] }],
      ...(['urgent', 'high', 'medium', 'low'] as const).map((p): Filters => [p, { priority: p }]),
      ['Stale', { stale_before: staleBefore }],
      ['Stale under Focus', { stale_before: staleBefore, focus: true }],
      ['a title word', { search: 'pcb' }],
      ['whitespace only', { search: '   ' }],
      [`QN-${num}`, { search: `QN-${num}` }],
      ['a word only a description holds', { search: textOnly }],
      ['a label name', { search: label }],
      ['an assignee name', { search: aisha.name.split(' ')[0] }],
      ['review', { search: 'review' }],
      ['progress', { search: 'progress' }],
      ['done', { search: 'done' }],
      ['words on different fields', { search: `${label} ${titleWord.toLowerCase()}` }],
      ['a status and a title word', { search: 'progress the' }],
      ['a search under Focus and an owner', { search: 'the', focus: true, owners: [leo.id] }],
      ...(reviewed?.reviewer_id === undefined
        ? []
        : [['the reviewer as owner', { owners: [reviewed.reviewer_id] }] as Filters]),
    ]
    for (const profile of [nora, leo, ben]) {
      const P = await storeOf(t, profile, cutoff + STALE_DAYS * DAY)
      const found = await compareAll(t, P, profile, selectionsOf(P, profile), rows)
      // every filter row matches some task of Nora's, so none compares
      // empty answers only; Stale splits the selection
      if (profile === nora) {
        console.log('rows each filter found for Nora:', Object.fromEntries(found))
        // the verdicts compared groups and tasks that are not on track too
        console.log('verdicts compared:', compared)
        expect(compared.groups).toBeGreaterThan(0)
        expect(compared.flagged).toBeGreaterThan(0)
        for (const [label] of rows)
          if (label !== 'urgent') expect(found.get(label), label).toBeGreaterThan(0)
        expect(found.get('Stale')).toBeLessThan(found.get('no filter') ?? 0)
      }
    }
  })
})

// ----------------------------------------------------------- access shapes

/** The tasks every access case plants over the withOrg fixture for
 * `subject`: in TBED's FW and PCB and in a sub-project of SKNK, a task
 * handed to review (the subject assigns, `user` reviews), one the subject
 * reviews and a legacy group In Review that the subject reviews, which
 * stays with its assignee; in FW a group with a subtask in a sibling
 * sub-project, a subtask whose parent is in that sibling, a task whose
 * only subtask is in an archived sub-project, an archived task, and a
 * task a legacy writer stored on the TBED meta itself, assigned to the
 * subject. Beside those: a group stored In Backlog with a To do subtask and
 * one stored Done with a Done subtask; a legacy nested group (a subtask with
 * a shown leaf and a leaf in the sibling); a card whose parent is in FW and
 * whose grandparent is in PCB; two tasks each the other's parent; and a
 * group created under the rule of one level (lib/viewReads.ts
 * ONE_LEVEL_SINCE) whose subtasks are the subject's, `user`'s and one in the
 * sibling. The sibling is hidden from a subject who sees FW and PCB only. */
async function plantCase(t: T, f: OrgFixture, subject: Doc<'profiles'>) {
  const org_id = f.org.id
  const skunk = await plantProject(t, { org_id, type: 'project', parent_id: f.hidden.id })
  const sibling = await plantProject(t, { org_id, type: 'project', parent_id: f.meta.id })
  const archived = await plantProject(t, {
    org_id,
    type: 'project',
    parent_id: f.meta.id,
    archived_at: NOW,
  })
  const task = (project: Doc<'projects'>, fields: Partial<Doc<'issues'>>) =>
    plantIssue(t, { org_id, project_id: project.id, ...fields })
  const tasks = {
    handedOn: [] as Doc<'issues'>[],
    reviewed: [] as Doc<'issues'>[],
    legacy: [] as Doc<'issues'>[],
  }
  for (const project of [f.sub, f.sub2, skunk]) {
    tasks.handedOn.push(
      await task(project, {
        title: 'Handed to review',
        status: 'review',
        assignee_id: subject.id,
        reviewer_id: f.user.id,
      }),
    )
    tasks.reviewed.push(
      await task(project, {
        title: 'Awaiting my review',
        status: 'review',
        assignee_id: f.user.id,
        reviewer_id: subject.id,
      }),
    )
    const legacy = await task(project, {
      title: 'Legacy group in review',
      status: 'review',
      assignee_id: f.user.id,
      reviewer_id: subject.id,
    })
    tasks.legacy.push(legacy)
    await task(project, { title: 'Its subtask', parent_id: legacy.id, assignee_id: subject.id })
  }
  const group = await task(f.sub, {
    title: 'Group with a sibling subtask',
    status: 'progress',
    assignee_id: subject.id,
  })
  await task(sibling, { title: 'Sibling subtask', parent_id: group.id, assignee_id: subject.id })
  await task(f.sub, { title: 'Done subtask', parent_id: group.id, status: 'done' })
  const hiddenParent = await task(sibling, {
    title: 'Parent in the sibling',
    assignee_id: subject.id,
  })
  await task(f.sub, {
    title: 'Subtask of a sibling parent',
    parent_id: hiddenParent.id,
    assignee_id: subject.id,
  })
  const lone = await task(f.sub, { title: 'Parent of an archived project subtask' })
  await task(archived, {
    title: 'In an archived project',
    parent_id: lone.id,
    assignee_id: subject.id,
  })
  await task(f.sub, { title: 'Archived task', assignee_id: subject.id, archived_at: NOW })
  await task(f.meta, { title: 'Stored on the meta', assignee_id: subject.id })
  // groups whose stored status Focus hides, with and without a subtask it shows
  const backlog = await task(f.sub, {
    title: 'Group stored in Backlog',
    status: 'backlog',
    assignee_id: subject.id,
  })
  await task(f.sub, { title: 'Its To do subtask', parent_id: backlog.id, assignee_id: subject.id })
  const done = await task(f.sub, {
    title: 'Group stored Done',
    status: 'done',
    assignee_id: subject.id,
  })
  await task(f.sub, { title: 'Its Done subtask', parent_id: done.id, status: 'done' })
  // a legacy nested group: a subtask with subtasks of its own
  const outer = await task(f.sub, { title: 'Outer group', assignee_id: f.user.id })
  const nested = await task(f.sub, {
    title: 'Nested group',
    parent_id: outer.id,
    assignee_id: f.user.id,
  })
  await task(f.sub, { title: 'Nested leaf', parent_id: nested.id, assignee_id: subject.id })
  await task(sibling, { title: 'Nested hidden leaf', parent_id: nested.id, status: 'done' })
  // a card under a parent in FW under a grandparent in PCB
  const grandparent = await task(f.sub2, { title: 'Grandparent in PCB', assignee_id: f.user.id })
  const middle = await task(f.sub, {
    title: 'Parent in FW',
    parent_id: grandparent.id,
    assignee_id: f.user.id,
  })
  await task(f.sub, { title: 'Card under two', parent_id: middle.id, assignee_id: subject.id })
  // two tasks each the other's parent, as only a raw write leaves them
  const one = await task(f.sub, { title: 'Cycle one', assignee_id: subject.id })
  const two = await task(f.sub, { title: 'Cycle two', parent_id: one.id })
  await t.run((ctx) => ctx.db.patch(one._id, { parent_id: two.id }))
  // a group created under the rule of one level, whose subtasks need no check
  const created_at = '2026-10-31T09:00:00.000Z'
  const recent = await task(f.sub, { title: 'Recent group', assignee_id: f.user.id, created_at })
  await task(f.sub, {
    title: 'Recent mine',
    parent_id: recent.id,
    assignee_id: subject.id,
    created_at,
  })
  await task(f.sub, {
    title: 'Recent theirs',
    parent_id: recent.id,
    assignee_id: f.user.id,
    created_at,
    status: 'done',
  })
  await task(sibling, { title: 'Recent hidden', parent_id: recent.id, created_at })
  return { skunk, sibling, tasks }
}

/** The filter rows every access case compares. */
const SHAPE_ROWS = (f: OrgFixture): Filters[] => [
  ['no filter', {}],
  ['Focus', { focus: true }],
  ['My tasks', { mine: true }],
  ['the reviewer as owner', { owners: [f.user.id] }],
  ['review', { search: 'review' }],
]

/** One access case: `shape` planted for a fresh seat of `role`, or the
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
  const P = await storeOf(t, subject)
  const scopes: [string, BoardScope, string][] = [
    ...[f.meta, f.sub, f.sub2, sibling, f.hidden, skunk].map((p): [string, BoardScope, string] => [
      p.key,
      projectScope(subject, p.id),
      p.id,
    ]),
    ['My view', { kind: 'mine' }, P.MINE_SCOPE],
  ]
  return await compareAll(t, P, subject, scopes, SHAPE_ROWS(f))
}

describe('access shapes', () => {
  it('answers what the store derives for the fixture’s admin, who reads by grants', async () => {
    const found = await compareShape(null, 'admin')
    expect(found.get('no filter')).toBeGreaterThan(0)
  })

  // an admin's seat is judged by its own rows, as any member's
  for (const role of ['admin', 'user', 'guest', 'viewer'] as const)
    it(`answers what the store derives for ${role === 'admin' ? 'an' : 'a'} ${role} in every shape`, async () => {
      // the shapes that show the subject any task, so the cases compare rows
      let showing = 0
      for (const shape of SHAPES)
        if (((await compareShape(shape, role)).get('no filter') ?? 0) > 0) showing++
      // a guest takes no team shares, so fewer shapes show them anything
      expect(showing).toBeGreaterThan(SHAPES.length / 3)
    })
})

describe("delays where tasks compete for their owner's hours", () => {
  it("judges each card against its owner's other cards, counted once", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    await t.run(async (ctx) => {
      const sub = await ctx.db.get(f.sub._id)
      if (sub) await ctx.db.patch(sub._id, { track_delay: true })
    })
    // a week two weeks on, Monday to Friday, local time as the store reads it
    const day = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const monday = new Date()
    monday.setHours(12, 0, 0, 0)
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) + 14)
    const friday = new Date(monday)
    friday.setDate(friday.getDate() + 4)
    const planned = (owner: Doc<'profiles'>, hours: number) =>
      plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        status: 'progress',
        assignee_id: owner.id,
        remaining_hours: hours,
        start_week: day(monday),
        end_week: day(monday),
        due_date: day(friday),
      })
    // the admin's two tasks fit the week together, and would not if one's
    // hours counted twice; the user's two do not, and would if one's hours
    // were missing
    for (const hours of [20, 20]) await planned(f.admin, hours)
    for (const hours of [30, 20]) await planned(f.user, hours)
    const P = await storeOf(t, f.admin)
    const answer = await boardFor(t, f.admin, projectScope(f.admin, f.sub.id))
    if (answer.state !== 'ok') throw new Error(answer.state)
    const before = { ...compared }
    const verdicts = await expectDelays(t, P, f.admin, answer, 'contention')
    expect(compared.rows - before.rows).toBe(4)
    const statuses = answer.rows.map((row) => verdicts.get(row.id) ?? null).sort()
    expect(statuses).toEqual(['late', 'late', 'ok', 'ok'])
  })

  it('judges each card as the REST and MCP task read does, for staff and for a guest, on a pinned clock', async () => {
    // the server judges by UTC day (convex/lib/machineDelay.ts), so the
    // store reads the time in UTC too, at a Wednesday noon away from a
    // midnight and a week's end
    const zone = process.env.TZ
    process.env.TZ = 'UTC'
    try {
      const now = Date.parse('2026-09-09T12:00:00.000Z')
      const today = '2026-09-09'
      const t = newT()
      const f = await withReadingAdmin(t)
      await t.run(async (ctx) => {
        const sub = await ctx.db.get(f.sub._id)
        if (sub) await ctx.db.patch(sub._id, { track_delay: true })
      })
      // the week of 21 September, due that Friday; the admin's and the
      // guest's fit their weeks, the user's 50 hours do not
      const planned = (owner: Doc<'profiles'>, hours: number) =>
        plantIssue(t, {
          org_id: f.org.id,
          project_id: f.sub.id,
          status: 'progress',
          assignee_id: owner.id,
          remaining_hours: hours,
          start_week: '2026-09-21',
          end_week: '2026-09-21',
          due_date: '2026-09-25',
        })
      for (const [owner, hours] of [
        [f.admin, 20],
        [f.admin, 20],
        [f.user, 30],
        [f.user, 20],
        [f.guest, 10],
      ] as const)
        await planned(owner, hours)
      const seen = new Set<string>()
      for (const reader of [f.admin, f.guest]) {
        const P = await storeOf(t, reader, now)
        const answer = await boardFor(t, reader, projectScope(reader, f.sub.id))
        if (answer.state !== 'ok') throw new Error(answer.state)
        const verdicts = await expectDelays(t, P, reader, answer, `${reader.name}, machine`)
        for (const row of answer.rows) {
          const machine = await t.query(internal.machine.rest.getIssue, {
            callerId: reader.id,
            access: 'read',
            today,
            ref: row.id,
          })
          const card = verdicts.get(row.id)
          expect(card, `${reader.name}: ${row.id} judged`).toBeDefined()
          expect(machine.delay?.status ?? null, `${reader.name}: ${row.id}`).toBe(
            card === 'unknown' ? 'unavailable' : (card ?? null),
          )
          seen.add(`${reader.name} ${card}`)
        }
        vi.useRealTimers()
      }
      // both readers met a card on track and one that is not
      for (const reader of [f.admin, f.guest])
        for (const status of ['ok', 'late'])
          expect(seen.has(`${reader.name} ${status}`), `${reader.name} ${status}`).toBe(true)
    } finally {
      process.env.TZ = zone
    }
  })
})

// ------------------------------------------------- the rules that must hold

describe('the Reviewer rule', () => {
  /** My view's rows for `subject`, by title, and what a drifted rule
   * would hold. */
  async function myView(owner: (task: Doc<'issues'>, isGroup: boolean) => string | undefined) {
    const t = newT()
    const f = await withReadingAdmin(t)
    const subject = await plantLogin(t, f.guest)
    const { tasks } = await plantCase(t, f, subject)
    const answer = await boardFor(t, subject, { kind: 'mine' }, { mine: true })
    if (answer.state !== 'ok') throw new Error(answer.state)
    const ids = new Set(answer.rows.map((row) => row.id))
    // what `owner` holds of the review cases the guest can see
    const seen = (list: Doc<'issues'>[]) =>
      list.filter((task) => task.project_id !== tasks.legacy[2].project_id)
    const drifted = new Set(
      [...seen(tasks.handedOn), ...seen(tasks.reviewed), ...seen(tasks.legacy)]
        .filter((task) => owner(task, tasks.legacy.includes(task)) === subject.id)
        .map((task) => task.id),
    )
    const review = new Set(
      [...seen(tasks.handedOn), ...seen(tasks.reviewed), ...seen(tasks.legacy)].map(
        (task) => task.id,
      ),
    )
    return { held: new Set([...ids].filter((id) => review.has(id))), drifted }
  }

  it("follows the hand-off: a task in review is its reviewer's, a group its assignee's", async () => {
    const { held, drifted } = await myView(taskOwnerId)
    expect(sorted(held)).toEqual(sorted(drifted))
  })

  it('differs from a rule without the hand-off', async () => {
    const { held, drifted } = await myView((task) => task.assignee_id)
    expect(sorted(held)).not.toEqual(sorted(drifted))
  })

  it('differs from a rule that gives a group to its reviewer', async () => {
    const { held, drifted } = await myView((task) => taskOwnerId(task, false))
    expect(sorted(held)).not.toEqual(sorted(drifted))
  })
})

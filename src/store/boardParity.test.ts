/* The Board's server read (convex/tasks.ts board) against the app's own
 * rules. Each case boots the real store from the caller's real workspace,
 * as projectTags.test.ts does, and compares what tasks.board answers for
 * the same caller with what the Board and the phone list derive in the
 * browser today: the phone set (scopedIssues with passesFilters), the
 * desktop cards (its leaves), each card's shown parent chain
 * (groupBoardCell), the group facts (isGroup, isDone, the calculated span
 * and its partial flag, the hidden flags) and, without a filter Clear
 * clears, the lanes holdsScoped keeps. The clock is frozen so isStale's
 * cutoff equals stale_before. Northstar runs as Nora (admin), Leo and Ben
 * over every selection; the small fixture runs every access shape for a
 * user, a guest and a viewer, and the admin, over plants that hide parents,
 * subtasks and projects. Two cases must fail if the Reviewer rule drifts. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Doc } from '../../convex/_generated/dataModel'
import type { BoardAnswer, BoardFilters, BoardScope } from '../../convex/lib/board'
import { taskOwnerId } from '../../convex/lib/review'
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
  withOrg,
  workspaceOf,
} from '../../convex/tests/helpers.setup'
import { northstarId, plantNorthstar } from '../../convex/tests/northstar.setup'
import { withReach } from '../../convex/tests/projectReach.setup'
import { groupBoardCell } from '../lib/boardGroups'
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

const DAY = 86_400_000

/* The app's Stale threshold (src/store/planner.ts isStale). */
const STALE_DAYS = 120

/** A fresh store whose first delivery is `snap`. */
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
  // the week indexes of the store's own timeline (src/lib/dates.ts)
  const { isoToWeek } = await import('../lib/dates')
  return Object.assign(store.P, { weekOf: isoToWeek })
}

type Store = Awaited<ReturnType<typeof start>>
type Issue = Store['issues'][number]

/** The store booted for `profile` from their workspace, with the clock at
 * `now`, so isStale's cutoff is STALE_DAYS before it. */
async function storeOf(t: T, profile: Doc<'profiles'>, now?: number): Promise<Store> {
  const snap = await workspaceOf(as(t, profile))
  if (snap === null) throw new Error(`no workspace for ${profile.name}`)
  if (now !== undefined) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
  }
  return await start(snap)
}

const sorted = (ids: Iterable<string>) => [...ids].sort()

/** Compares `answer`, tasks.board's for `scope` and `filters`, with what
 * store `P` derives for the store scope `scopeId`. */
function expectParity(
  P: Store,
  answer: BoardAnswer,
  scopeId: string,
  filters: BoardFilters,
  label: string,
) {
  const info = P.scopeInfo(scopeId)
  // a selection the store does not hold is one the server does not either
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
    search: filters.search,
  }
  const scoped = P.scopedIssues(info)
  const passing = scoped.filter((it) => P.passesFilters(it, desk))
  const byUuid = new Map(Object.values(P.issueById).map((it) => [it.uuid, it]))
  const rowIds = new Set(answer.rows.map((row) => row.id))
  const parentIds = new Set(answer.parents.map((row) => row.id))

  // the phone list's set, which keeps groups, and the desktop's cards
  expect(sorted(rowIds), `${label}: rows`).toEqual(sorted(passing.map((it) => it.uuid)))
  expect(
    sorted(answer.rows.filter((row) => !row.has_subtasks).map((row) => row.id)),
    `${label}: cards`,
  ).toEqual(sorted(passing.filter((it) => !P.isGroup(it)).map((it) => it.uuid)))
  if (filters.search === '') {
    const phone = { ...desk, search: '' }
    expect(sorted(rowIds), `${label}: phone`).toEqual(
      sorted(scoped.filter((it) => P.passesFilters(it, phone)).map((it) => it.uuid)),
    )
  }

  // every shown ancestor of a row that is not a row, and each card's
  // headings among rows and parents
  const ancestors = new Set<string>()
  const parentOf = (it: Issue) => (it.parent ? P.issueById[it.parent] : undefined)
  for (const it of passing) {
    const seen = new Set([it.uuid])
    for (let p = parentOf(it); p !== undefined && !seen.has(p.uuid); p = parentOf(p)) {
      seen.add(p.uuid)
      if (!rowIds.has(p.uuid)) ancestors.add(p.uuid)
    }
  }
  expect(sorted(parentIds), `${label}: parents`).toEqual(sorted(ancestors))
  for (const card of passing.filter((it) => !P.isGroup(it)))
    for (const cell of groupBoardCell([card], P.issueById))
      for (const heading of [cell.parent, ...cell.ancestors])
        if (heading !== null)
          expect(
            rowIds.has(heading.uuid) || parentIds.has(heading.uuid),
            `${label}: heading ${heading.key}`,
          ).toBe(true)

  // each row's facts
  for (const row of [...answer.rows, ...answer.parents]) {
    const it = byUuid.get(row.id)
    if (it === undefined) throw new Error(`${label}: the store does not show ${row.id}`)
    const what = `${label}: ${it.key}`
    expect(row.has_subtasks, `${what} group`).toBe(P.isGroup(it))
    expect(row.has_hidden_subtasks, `${what} hidden subtasks`).toBe(it.hasHiddenSubtasks)
    expect(row.has_hidden_parent, `${what} hidden parent`).toBe(it.hasHiddenParent)
    expect(row.parent_id ?? null, `${what} parent`).toBe(parentOf(it)?.uuid ?? null)
    expect(row, `${what} text`).not.toHaveProperty('description')
    if (!row.has_subtasks) continue
    expect(row.group_done, `${what} done`).toBe(P.isDone(it))
    const span = row.span
    expect(span?.start_week === undefined ? null : P.weekOf(span.start_week), `${what} start`).toBe(
      it.start,
    )
    expect(span?.end_week === undefined ? null : P.weekOf(span.end_week), `${what} end`).toBe(
      it.end,
    )
    expect(span?.partial, `${what} partial`).toBe(P.progressOf(it).unknown)
  }

  // the lanes a group keeps: those holding a scoped task, and with a filter
  // Clear clears, only those holding a card
  const clearable =
    (!mine && filters.mine) ||
    filters.owners.length > 0 ||
    filters.priority !== null ||
    filters.stale_before !== null ||
    filters.search !== ''
  const scopedProjects = new Set(scoped.map((it) => it.project))
  const cards = passing.filter((it) => !P.isGroup(it))
  const held = info.groups
    .filter(
      (g) =>
        g.subIds.some((id) => scopedProjects.has(id)) &&
        !(clearable && !cards.some((it) => g.subIds.includes(it.project))),
    )
    .map((g) => g.proj.id)
  expect(sorted(answer.held_projects), `${label}: lanes`).toEqual(sorted(held))
  if (!mine)
    expect(sorted(answer.projects ?? []), `${label}: projects`).toEqual(sorted(info.subIds))
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
      expectParity(P, answer, storeScope, filters, `${profile.name}, ${scopeLabel}, ${filterLabel}`)
      if (answer.state === 'ok')
        found.set(filterLabel, (found.get(filterLabel) ?? 0) + answer.rows.length)
    }
  return found
}

/** The selections a caller's store offers: each top-level project it
 * shows, each of their sub-projects and My view. */
function selectionsOf(P: Store, profile: Doc<'profiles'>) {
  const out: [string, BoardScope, string][] = []
  for (const meta of P.visibleProjects()) {
    out.push([meta.name, projectScope(profile, meta.id), meta.id])
    for (const id of meta.children ?? [])
      if (P.canSee(id)) out.push([P.project(id)?.name ?? id, projectScope(profile, id), id])
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
        for (const [label] of rows)
          if (label !== 'urgent') expect(found.get(label), label).toBeGreaterThan(0)
        expect(found.get('Stale')).toBeLessThan(found.get('no filter') ?? 0)
      }
    }
  }, 600_000)
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
 * subject. The sibling is hidden from a subject who sees FW and PCB only. */
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
  it('answers what the store derives for the admin', async () => {
    const found = await compareShape(null, 'admin')
    expect(found.get('no filter')).toBeGreaterThan(0)
  })

  for (const role of ['user', 'guest', 'viewer'] as const)
    it(`answers what the store derives for a ${role} in every shape`, async () => {
      // the shapes that show the subject any task, so the cases compare rows
      let showing = 0
      for (const shape of SHAPES)
        if (((await compareShape(shape, role)).get('no filter') ?? 0) > 0) showing++
      // a guest takes no team shares, so fewer shapes show them anything
      expect(showing).toBeGreaterThan(SHAPES.length / 3)
    }, 600_000)
})

// ------------------------------------------------- the rules that must hold

describe('the Reviewer rule', () => {
  /** My view's rows for `subject`, by title, and what a drifted rule
   * would hold. */
  async function myView(owner: (task: Doc<'issues'>, isGroup: boolean) => string | undefined) {
    const t = newT()
    const f = await withOrg(t)
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

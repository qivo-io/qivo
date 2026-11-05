/* tasks.roadmapDependencies, the Roadmap's dependency inputs (lib/roadmap.ts
 * readDependencies), the arrows' pairs between a selection's own tasks and
 * Auto-move's parts, inside the selection and outside it, the links and
 * tasks the reader is not shown, the order of the pairs, the write levels,
 * My view across seats, the budgets that answer over_budget, that hidden
 * data moves nothing, and real limits at the everyday link share with the
 * measured size of the parts. src/store/roadmapParity.test.ts compares the
 * parts with what Auto-move derives over every task the workspace holds. */

import { afterEach, describe, expect, it } from 'vitest'
import { autoMoves } from '../../src/lib/schedule'
import type { Doc } from '../_generated/dataModel'
import { MIB } from '../lib/limits'
import { DEPENDENCIES, type DependencyAnswer, type DependencyPair } from '../lib/roadmap'
import { plantTasks, projectScope, type ReadFigures } from './board.setup'
import {
  NOW,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { withReach } from './projectReach.setup'
import { dayPlus, dependenciesFor, dependenciesRead, NOW_WEEK, ordinary } from './roadmap.setup'

const DEFAULT_DEPENDENCIES = structuredClone(DEPENDENCIES)
afterEach(() => {
  Object.assign(DEPENDENCIES, structuredClone(DEFAULT_DEPENDENCIES))
})

/** A task's weeks, `from` weeks after NOW's week for `weeks` weeks. */
const dated = (from: number, weeks = 1): Partial<Doc<'issues'>> => ({
  start_week: dayPlus(NOW_WEEK, 7 * from),
  end_week: dayPlus(NOW_WEEK, 7 * (from + weeks - 1)),
})

/** Plants a task in `project`. */
const task = (t: T, project: Doc<'projects'>, fields: Partial<Doc<'issues'>> = {}) =>
  plantIssue(t, { org_id: project.org_id, project_id: project.id, ...fields })

/** Plants a link from `source` to `target`, as model/links.ts writes one,
 * where a blocks link names its blocker as source. */
async function link(
  t: T,
  source: Doc<'issues'>,
  target: Doc<'issues'>,
  o: { type?: 'blocks' | 'relates'; created_at?: string } = {},
): Promise<Doc<'issue_links'>> {
  return await t.run(async (ctx) => {
    const [a, b] = [source.id, target.id].sort()
    const _id = await ctx.db.insert('issue_links', {
      org_id: source.org_id,
      id: uuid(),
      source_id: o.type === 'relates' ? a : source.id,
      target_id: o.type === 'relates' ? b : target.id,
      type: o.type ?? 'blocks',
      pair_key: `${a}:${b}`,
      created_at: o.created_at ?? NOW,
      task_key: source.window_key,
    })
    return (await ctx.db.get(_id)) as Doc<'issue_links'>
  })
}

/** A top-level project of the fixture's organization with `n`
 * sub-projects, which `who` holds `level` on. */
async function sharedProject(
  t: T,
  f: OrgFixture,
  who: Doc<'profiles'>,
  level: 'user' | 'viewer',
  n = 2,
) {
  const top = await plantProject(t, { org_id: f.org.id, lead_id: f.user.id })
  const subs: Doc<'projects'>[] = []
  for (let i = 0; i < n; i++)
    subs.push(await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: top.id }))
  await t.run((ctx) =>
    ctx.db.insert('project_access', { project_id: top.id, profile_id: who.id, level }),
  )
  return { top, subs }
}

/** The ok answer, or a failure naming its state. */
function ok(answer: DependencyAnswer) {
  if (answer.state !== 'ok') throw new Error(answer.state)
  return answer
}

/** Auto-move's inputs of `answer`, task ids sorted and pairs by id. */
function parts(answer: DependencyAnswer) {
  const a = ok(answer)
  if (a.auto_move.state !== 'ok') return a.auto_move.state
  return {
    tasks: a.auto_move.tasks.map((row) => row.id).sort(),
    pairs: a.auto_move.pairs.map((p) => `${p.blocker}>${p.blocked}`).sort(),
  }
}

/** `tasks`' ids, sorted. */
const ids = (...tasks: Doc<'issues'>[]) => tasks.map((x) => x.id).sort()

/** The pair of a blocks link from `a` to `b`. */
const pair = (a: Doc<'issues'>, b: Doc<'issues'>) => `${a.id}>${b.id}`

/* ------------------------------------------------------------------ the parts */

describe('the parts', () => {
  it('answers the pairs inside the selection, a blocker elsewhere with its family, a chain through two other projects, and leaves out a part with no selected task', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ops = await sharedProject(t, f, f.guest, 'user')
    const mkt = await sharedProject(t, f, f.guest, 'user')
    await withReach(t)
    // inside FW
    const a = await task(t, f.sub, { title: 'A', ...dated(0) })
    const b = await task(t, f.sub, { title: 'B', ...dated(2) })
    await link(t, a, b)
    // B's blocker X is a subtask in OPS, beside a scheduled sibling Y and
    // an unscheduled one
    const g = await task(t, ops.subs[0], { title: 'G' })
    const x = await task(t, ops.subs[0], { title: 'X', parent_id: g.id, ...dated(-3) })
    const y = await task(t, ops.subs[1], { title: 'Y', parent_id: g.id, ...dated(-6) })
    await task(t, ops.subs[0], { title: 'Unscheduled', parent_id: g.id })
    await link(t, x, b)
    // C blocks A from OPS, and D in MKT blocks C
    const c = await task(t, ops.subs[1], { title: 'C', ...dated(-2) })
    const d = await task(t, mkt.subs[0], { title: 'D', ...dated(-4) })
    await link(t, c, a)
    await link(t, d, c)
    // a part of its own in MKT, with no selected task
    const e1 = await task(t, mkt.subs[1], { title: 'E1', ...dated(0) })
    const e2 = await task(t, mkt.subs[1], { title: 'E2', ...dated(1) })
    await link(t, e1, e2)
    const answer = ok(await dependenciesFor(t, f.guest, projectScope(f.guest, f.sub.id)))
    expect(answer.pairs).toEqual([{ blocker: a.id, blocked: b.id }])
    expect(parts(answer)).toEqual({
      tasks: ids(a, b, g, x, y, c, d),
      pairs: [pair(a, b), pair(x, b), pair(c, a), pair(d, c)].sort(),
    })
    // this must fail for a reader that keeps parts inside the selection only
    expect(parts(answer)).not.toEqual({ tasks: ids(a, b), pairs: [pair(a, b)] })
    // the dependency read takes no filter and no window
    if (answer.auto_move.state !== 'ok') throw new Error('parts')
    const gRow = answer.auto_move.tasks.find((row) => row.id === g.id)
    expect(gRow).toMatchObject({
      has_subtasks: true,
      span: {
        start_week: dayPlus(NOW_WEEK, -42),
        end_week: dayPlus(NOW_WEEK, -21),
        partial: false,
      },
    })
    expect(answer.auto_move.tasks.find((row) => row.id === x.id)?.parent_id).toBe(g.id)
    expect(answer.auto_move.editable_projects).toEqual(
      [f.sub.id, ops.subs[0].id, ops.subs[1].id, mkt.subs[0].id].sort(),
    )
  })

  it('takes in a selected task without links whose parent outside the selection has one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const parent = await task(t, f.sub2, { title: 'Parent' })
    const leaf = await task(t, f.sub, { title: 'Leaf', parent_id: parent.id, ...dated(0) })
    const sibling = await task(t, f.sub2, { title: 'Sibling', parent_id: parent.id, ...dated(3) })
    const w = await task(t, f.sub2, { title: 'W', ...dated(6) })
    await link(t, parent, w)
    // a selected leaf with a family and no link anywhere stays out
    const lone = await task(t, f.sub, { title: 'Lone group' })
    await task(t, f.sub, { title: 'Lone kid', parent_id: lone.id, ...dated(1) })
    const answer = ok(await dependenciesFor(t, f.guest, projectScope(f.guest, f.sub.id)))
    expect(answer.pairs).toEqual([])
    expect(parts(answer)).toEqual({
      tasks: ids(leaf, parent, sibling, w),
      pairs: [pair(parent, w)],
    })
  })

  it('adds no pair and no id for a link to a hidden, an archived or an unscheduled task, or a relates link, and answers a cycle whole', async () => {
    const t = newT()
    const f = await withOrg(t)
    const sibling = await plantHiddenSibling(t, f, f.guest)
    const archivedProject = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const a = await task(t, f.sub, { title: 'A', ...dated(0) })
    const hidden = await task(t, sibling, { title: 'Hidden', ...dated(1) })
    const archived = await task(t, f.sub2, { title: 'Archived', ...dated(1), archived_at: NOW })
    const inArchived = await task(t, archivedProject, { title: 'In archived', ...dated(1) })
    const unscheduled = await task(t, f.sub2, { title: 'Unscheduled' })
    const related = await task(t, f.sub2, { title: 'Related', ...dated(1) })
    for (const other of [hidden, archived, inArchived, unscheduled]) await link(t, a, other)
    await link(t, a, related, { type: 'relates' })
    const answer = await dependenciesFor(t, f.guest, projectScope(f.guest, f.meta.id))
    expect(answer).toEqual({
      state: 'ok',
      pairs: [],
      auto_move: { state: 'ok', tasks: [], pairs: [], editable_projects: [] },
    })
    for (const other of [hidden, archived, inArchived])
      expect(JSON.stringify(answer)).not.toContain(other.id)
    // a cycle comes whole, for the solver to skip
    const c1 = await task(t, f.sub, { title: 'C1', ...dated(0) })
    const c2 = await task(t, f.sub2, { title: 'C2', ...dated(1) })
    await link(t, c1, c2)
    await link(t, c2, c1, { created_at: '2026-01-02T00:00:00.000Z' })
    const cycle = ok(await dependenciesFor(t, f.guest, projectScope(f.guest, f.sub.id)))
    expect(parts(cycle)).toEqual({ tasks: ids(c1, c2), pairs: [pair(c1, c2), pair(c2, c1)].sort() })
  })

  it("orders the pairs by the link's creation time, then its id, and names only the projects the reader may edit", async () => {
    const t = newT()
    const f = await withOrg(t)
    const viewed = await sharedProject(t, f, f.guest, 'viewer')
    await withReach(t)
    // Z, the first task by number, ends in week 3 and blocks group G, whose
    // leaves are a (week 0) and b (week 5), and blocks a itself; the link to
    // a was written first. The app takes a task's links by creation time
    // (src/lib/taskSections.ts linkViews), so Z's pairs come in that order
    // (src/lib/schedule.ts dependencyPairs)
    const z = await task(t, viewed.subs[0], { title: 'Z', ...dated(3) })
    const g = await task(t, f.sub, { title: 'G' })
    const a = await task(t, f.sub, { title: 'a', parent_id: g.id, ...dated(0) })
    const b = await task(t, f.sub, { title: 'b', parent_id: g.id, ...dated(5) })
    const y = await task(t, f.sub, { title: 'Y', ...dated(-2) })
    await link(t, z, g, { created_at: '2026-01-03T00:00:00.000Z' })
    await link(t, z, a, { created_at: '2026-01-02T00:00:00.000Z' })
    await link(t, y, b, { created_at: '2026-01-04T00:00:00.000Z' })
    const answer = ok(await dependenciesFor(t, f.guest, projectScope(f.guest, f.sub.id)))
    if (answer.auto_move.state !== 'ok') throw new Error('parts')
    expect(answer.auto_move.pairs).toEqual([
      { blocker: z.id, blocked: a.id },
      { blocker: z.id, blocked: g.id },
      { blocker: y.id, blocked: b.id },
    ])
    expect(answer.pairs).toEqual([{ blocker: y.id, blocked: b.id }])
    // the project the reader can only view is not editable
    expect(answer.auto_move.editable_projects).toEqual([f.sub.id])
    expect(answer.auto_move.tasks.map((row) => row.project_id)).toContain(viewed.subs[0].id)
    // Auto-move over the answer in its order moves a to week 4 and leaves b,
    // as the app's order does; in the other order it would move b to week 9
    // too, so the order matters
    const moves = (pairs: DependencyPair[]) => {
      const rows = answer.auto_move.state === 'ok' ? answer.auto_move.tasks : []
      const week = (day: string | undefined) =>
        day === undefined ? null : (Date.parse(day) - Date.parse(NOW_WEEK)) / (7 * 86_400_000)
      const issues = rows.map((row) => ({
        id: row.id,
        status: row.status,
        project: row.project_id,
        isGroup: row.has_subtasks,
        children: rows.filter((kid) => kid.parent_id === row.id).map((kid) => kid.id),
        start: week(row.has_subtasks ? row.span?.start_week : row.start_week),
        end: week(row.has_subtasks ? row.span?.end_week : row.end_week),
        links: pairs.flatMap((p) =>
          p.blocker === row.id
            ? [{ type: 'blocks', id: p.blocked }]
            : p.blocked === row.id
              ? [{ type: 'blocked_by', id: p.blocker }]
              : [],
        ),
      }))
      return autoMoves({
        issues,
        byId: Object.fromEntries(issues.map((it) => [it.id, it])),
        canWrite: (it) => it.project === f.sub.id,
      }).sort((p, q) => (p.id < q.id ? -1 : 1))
    }
    const inOrder = moves(answer.auto_move.pairs)
    expect(inOrder).toEqual([{ id: a.id, start: 4, end: 4 }])
    expect(moves([...answer.auto_move.pairs].reverse())).toEqual(
      [
        { id: a.id, start: 4, end: 4 },
        { id: b.id, start: 9, end: 9 },
      ].sort((p, q) => (p.id < q.id ? -1 : 1)),
    )
  })

  it('answers a chain as long as its part whole, which Auto-move settles within the passes the part gives it', async () => {
    const t = newT()
    const f = await withOrg(t)
    // twelve tasks of one week each in week 0, each blocking the one
    // planted before it, so the solver, taking pairs by task number, needs
    // a pass for each
    const chain: Doc<'issues'>[] = []
    for (let i = 0; i < 12; i++) chain.push(await task(t, f.sub, { title: `C${i}`, ...dated(0) }))
    for (let i = 11; i > 0; i--) await link(t, chain[i], chain[i - 1])
    const answer = ok(await dependenciesFor(t, f.guest, projectScope(f.guest, f.sub.id)))
    if (answer.auto_move.state !== 'ok') throw new Error('parts')
    expect(answer.auto_move.tasks).toHaveLength(12)
    const week = (day: string | undefined) =>
      day === undefined ? null : (Date.parse(day) - Date.parse(NOW_WEEK)) / (7 * 86_400_000)
    const issues = answer.auto_move.tasks.map((row) => ({
      id: row.id,
      status: row.status,
      start: week(row.start_week),
      end: week(row.end_week),
      links:
        answer.auto_move.state === 'ok'
          ? answer.auto_move.pairs.flatMap((p) =>
              p.blocker === row.id
                ? [{ type: 'blocks', id: p.blocked }]
                : p.blocked === row.id
                  ? [{ type: 'blocked_by', id: p.blocker }]
                  : [],
            )
          : [],
    }))
    const moved = autoMoves({
      issues,
      byId: Object.fromEntries(issues.map((it) => [it.id, it])),
      canWrite: () => true,
    })
    // C11 stays in week 0, and C10 down to C0 move to weeks 1 to 11
    expect(Object.fromEntries(moved.map((m) => [m.id, m.start]))).toEqual(
      Object.fromEntries(chain.slice(0, 11).map((c, i) => [c.id, 11 - i])),
    )
  })

  it("reads My view's own tasks across two seats", async () => {
    const t = newT()
    const f = await withOrg(t)
    const away = await plantSeat(t, {
      org_id: f.otherOrg.id,
      org_role: 'guest',
      auth_user_id: f.guest.auth_user_id,
    })
    const awaySub = await plantProject(t, {
      org_id: f.otherOrg.id,
      type: 'project',
      parent_id: f.otherProject.id,
    })
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.otherProject.id,
        profile_id: away.id,
        level: 'user',
      }),
    )
    const home = await task(t, f.sub, { title: 'Home', assignee_id: f.guest.id, ...dated(1) })
    const homeBlocker = await task(t, f.sub2, { title: 'Home blocker', ...dated(0) })
    const there = await task(t, awaySub, { title: 'There', assignee_id: away.id, ...dated(2) })
    const thereBlocked = await task(t, awaySub, { title: 'There blocked', ...dated(3) })
    await link(t, homeBlocker, home)
    await link(t, there, thereBlocked)
    // someone else's linked task in the guest's project is not selected
    const others = await task(t, f.sub, { title: 'Others', assignee_id: f.user.id, ...dated(0) })
    const othersBlocked = await task(t, f.sub2, { title: 'Others blocked', ...dated(1) })
    await link(t, others, othersBlocked)
    const answer = ok((await dependenciesRead(t, [f.guest, away], { kind: 'mine' })).answer)
    expect(parts(answer)).toEqual({
      tasks: ids(home, homeBlocker, there, thereBlocked),
      pairs: [pair(homeBlocker, home), pair(there, thereBlocked)].sort(),
    })
  })
})

/* ------------------------------------------------------------------ budgets */

describe('budgets', () => {
  it('answers Auto-move over_budget past DEPENDENCIES.tasks and where its reads stop, keeping the arrows, and over_budget whole where the selection does not fit', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const a = await task(t, f.sub, { title: 'A', ...dated(0) })
    const b = await task(t, f.sub, { title: 'B', ...dated(2) })
    await link(t, a, b)
    // a chain of ten outside the selection
    let next = a
    for (let i = 0; i < 10; i++) {
      const blocker = await task(t, f.sub2, { title: `Chain ${i}`, ...dated(-1 - i) })
      await link(t, blocker, next)
      next = blocker
    }
    const scope = projectScope(f.guest, f.sub.id)
    const whole = await dependenciesRead(t, [f.guest], scope)
    expect(parts(whole.answer)).toMatchObject({ tasks: expect.any(Array) })
    const arrows = [{ blocker: a.id, blocked: b.id }]
    DEPENDENCIES.tasks = 11
    expect((await dependenciesRead(t, [f.guest], scope)).answer).toEqual({
      state: 'ok',
      pairs: arrows,
      auto_move: { state: 'over_budget' },
    })
    DEPENDENCIES.tasks = 12
    expect(parts((await dependenciesRead(t, [f.guest], scope)).answer)).not.toBe('over_budget')
    // ranges that hold the selection and its links but not the chain
    let stopped = false
    for (let ranges = whole.read.ranges - 1; ranges > 0 && !stopped; ranges--) {
      DEPENDENCIES.reads.ranges = ranges
      const answer = (await dependenciesRead(t, [f.guest], scope)).answer
      expect(answer.state === 'ok' && answer.auto_move.state === 'ok').toBe(false)
      if (answer.state === 'over_budget') stopped = true
      else
        expect(answer).toEqual({ state: 'ok', pairs: arrows, auto_move: { state: 'over_budget' } })
    }
    expect(stopped).toBe(true)
  })
})

/* ------------------------------------------------------------------ hidden data */

/** A fixture whose hidden tasks, which the guest's shown tasks link to,
 * carry ordinary titles and links among themselves when `wide`. */
async function hiddenOrg(wide: boolean) {
  const t = newT()
  const f = await withOrg(t)
  const sibling = await plantHiddenSibling(t, f, f.guest)
  const shown = await plantTasks(t, f.sub, 6, (i) => ({ title: `Shown ${i}`, ...dated(i) }))
  const hidden = await plantTasks(t, sibling, 6, (i) => ({
    ...(wide ? ordinary(i) : { title: 'h', text: '' }),
    ...dated(i),
  }))
  for (let i = 0; i < 6; i++) await link(t, hidden[i], shown[i])
  await link(t, shown[0], shown[1])
  if (wide) for (let i = 1; i < 6; i++) await link(t, hidden[i - 1], hidden[i])
  return { t, f }
}

describe('hidden data', () => {
  it("answers the same, and stops at the same budget, whatever the hidden tasks' titles and their links among themselves", async () => {
    const narrow = await hiddenOrg(false)
    const wide = await hiddenOrg(true)
    const read = (o: typeof narrow) => () =>
      dependenciesFor(o.t, o.f.guest, projectScope(o.f.guest, o.f.meta.id))
    const shapeOf = (answer: DependencyAnswer) =>
      answer.state === 'ok' && answer.auto_move.state === 'ok'
        ? { pairs: answer.pairs.length, tasks: answer.auto_move.tasks.length }
        : answer
    expect(shapeOf(await read(wide)())).toEqual(shapeOf(await read(narrow)()))
    const least = async (r: () => Promise<DependencyAnswer>) => {
      let low = 0
      let high = DEFAULT_DEPENDENCIES.reads.bytes
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2)
        DEPENDENCIES.reads.bytes = mid
        const answer = await r()
        if (answer.state === 'ok' && answer.auto_move.state === 'ok') high = mid
        else low = mid
      }
      DEPENDENCIES.reads.bytes = DEFAULT_DEPENDENCIES.reads.bytes
      return high
    }
    expect(await least(read(wide))).toBe(await least(read(narrow)))
  })
})

/* ------------------------------------------------------------------ real limits */

const record = (name: string, answer: DependencyAnswer, read: ReadFigures) => {
  const state =
    answer.state === 'ok'
      ? {
          state: 'ok',
          pairs: answer.pairs.length,
          auto_move:
            answer.auto_move.state === 'ok'
              ? { tasks: answer.auto_move.tasks.length, pairs: answer.auto_move.pairs.length }
              : answer.auto_move.state,
        }
      : { state: answer.state }
  console.log(`dependency figures, ${name}:`, JSON.stringify({ ...state, ...read }))
}

/** An open task `i` of an everyday mix, three in five dated around NOW's
 * week, one in ten Backlog. */
const openTask = (i: number): Partial<Doc<'issues'>> & { text?: string } => ({
  ...ordinary(i),
  status: (
    [
      'todo',
      'progress',
      'todo',
      'review',
      'todo',
      'progress',
      'todo',
      'backlog',
      'todo',
      'progress',
    ] as const
  )[i % 10],
  ...(i % 5 < 3 ? dated((i % 40) - 20, 1 + (i % 4)) : {}),
})

/** `n` open tasks in `project`, per ten one parent, two subtasks and seven
 * plain tasks, as the Roadmap suite's. */
async function plantOpen(t: T, project: Doc<'projects'>, n: number, from = 0) {
  const parents = await plantTasks(t, project, Math.round(n / 10), (i) => openTask(from + i))
  const plain = await plantTasks(t, project, n - 3 * parents.length, (i) =>
    openTask(from + 1000 + i),
  )
  const kids = await plantTasks(t, project, 2 * parents.length, (i) => ({
    ...openTask(from + 2000 + i),
    parent_id: parents[Math.floor(i / 2)].id,
  }))
  return [...parents, ...plain, ...kids]
}

/** Dated tasks of `tasks`, the ones a link can tie into a part. */
const scheduled = (tasks: Doc<'issues'>[]) => tasks.filter((x) => x.start_week !== undefined)

/** `n` sub-projects of `parent`. */
async function plantSubs(t: T, parent: Doc<'projects'>, n: number) {
  const subs: Doc<'projects'>[] = []
  for (let i = 0; i < n; i++)
    subs.push(
      await plantProject(t, { org_id: parent.org_id, type: 'project', parent_id: parent.id }),
    )
  return subs
}

/** Everyday projects of the organization the guest reads, each 3
 * sub-projects of 30 open tasks, of which 4 dated ones, about 5 percent,
 * hold a link to another of the project, unless `links` is false. Answers
 * the projects' tasks. */
async function everyday(t: T, f: OrgFixture, n: number, links = true) {
  const tasks: Doc<'issues'>[] = []
  for (let k = 0; k < n; k++) {
    const { subs } = await sharedProject(t, f, f.guest, 'user', 3)
    const theirs: Doc<'issues'>[] = []
    for (const [j, sub] of subs.entries())
      theirs.push(...(await plantOpen(t, sub, 30, 100 * (3 * k + j))))
    const ends = scheduled(theirs)
    if (links)
      for (let i = 0; i < 2; i++)
        await link(t, ends[ends.length - 1 - 2 * i], ends[ends.length - 2 - 2 * i])
    tasks.push(...theirs)
  }
  return tasks
}

/** A project of 800 open and 200 Done tasks not yet archived over 3
 * sub-projects, its two figures at their sum as the read takes both, the
 * Board's design-size shape, at the everyday link share: 5 percent of each
 * hold a link, half of them to tasks of 2 everyday projects elsewhere,
 * which hold their own share. Of the open tasks 40 hold one, 20 to each
 * other and 20 blocked by tasks elsewhere; of the Done tasks, each dated in
 * one of the 26 weeks before NOW's, 10 hold one, 5 blocking open tasks of
 * the project and 5 blocked by tasks elsewhere. Answers the fixture and the
 * project's dated open tasks. */
async function eightHundred() {
  const t = newT({ transactionLimits: true })
  const f = await withOrg(t)
  const subs = [f.sub, f.sub2, ...(await plantSubs(t, f.meta, 1))]
  const own: Doc<'issues'>[] = []
  const done: Doc<'issues'>[] = []
  for (const [k, sub] of subs.entries()) {
    own.push(...(await plantOpen(t, sub, k === 2 ? 266 : 267, 3000 * k)))
    done.push(
      ...(await plantTasks(t, sub, k === 2 ? 66 : 67, (i) => ({
        ...ordinary(3000 * k + 500 + i),
        status: 'done',
        done_at: NOW,
        ...dated(-1 - (i % 26)),
      }))),
    )
  }
  const elsewhere = scheduled(await everyday(t, f, 2))
  const ends = scheduled(own)
  for (let i = 0; i < 10; i++) await link(t, ends[2 * i], ends[2 * i + 1])
  for (let i = 0; i < 20; i++) await link(t, elsewhere[3 * i], ends[20 + i])
  for (let i = 0; i < 5; i++) await link(t, done[i], ends[100 + i])
  for (let i = 0; i < 5; i++) await link(t, elsewhere[61 + i], done[5 + i])
  return { t, f, ends, subs }
}

/** A chain of tasks outside the selection that the parts hold whole beside
 * the project of 800 open and 200 Done tasks at the everyday link share,
 * below the measured size in DEPENDENCIES' docstring, a chain of 230, so a
 * small change in what the read takes leaves it inside. */
const MEASURED_OUTSIDE = 200

describe('real limits', () => {
  it('reads a project of 800 open and 200 Done tasks at the everyday link share, half its links to everyday projects elsewhere', async () => {
    const { t, f } = await eightHundred()
    await withReach(t)
    const { answer, read } = await dependenciesRead(t, [f.guest], projectScope(f.guest, f.meta.id))
    record('a project of 800 open and 200 Done tasks', answer, read)
    expect(ok(answer).auto_move.state).toBe('ok')
  })

  it(`answers Auto-move whole with a chain of ${MEASURED_OUTSIDE} tasks outside the project of 800 open and 200 Done tasks`, async () => {
    const { t, f, ends, subs } = await eightHundred()
    // a chain through dated tasks of 6 everyday projects, below the
    // measured size, into a dated task of the project
    const chain = scheduled(await everyday(t, f, 6, false)).slice(0, MEASURED_OUTSIDE)
    expect(chain).toHaveLength(MEASURED_OUTSIDE)
    await withReach(t)
    let next = ends[60]
    for (const blocker of chain) {
      await link(t, blocker, next)
      next = blocker
    }
    const { answer, read } = await dependenciesRead(t, [f.guest], projectScope(f.guest, f.meta.id))
    record(
      `the project of 800 open and 200 Done tasks and a chain of ${MEASURED_OUTSIDE}`,
      answer,
      read,
    )
    const a = ok(answer)
    if (a.auto_move.state !== 'ok') throw new Error('Auto-move over_budget')
    // the chain's own families come along, so the parts hold more
    const inside = new Set(subs.map((s) => s.id))
    const outside = a.auto_move.tasks.filter((row) => !inside.has(row.project_id)).length
    console.log('dependency figures, tasks of the parts outside the project:', outside)
    expect(outside).toBeGreaterThanOrEqual(MEASURED_OUTSIDE)
  })

  it("reads My view of 400 of the reader's tasks over 200 sub-projects at the everyday link share", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const { plantShared } = await import('./overview.setup')
    const me = await plantSeat(t, {
      org_id: f.org.id,
      org_role: 'user',
      auth_user_id: `auth_${uuid()}`,
      accepted_at: NOW,
    })
    const { subs } = await plantShared(t, f.org.id, f.user, me, { tops: 100, subs: 2 })
    const own: Doc<'issues'>[] = []
    for (const [i, sub] of subs.entries())
      own.push(
        ...(await plantTasks(t, sub, 2, (k) => ({ ...openTask(2 * i + k), assignee_id: me.id }))),
      )
    // other people's tasks in ten of the sub-projects, the other ends
    const others: Doc<'issues'>[] = []
    for (const sub of subs.slice(0, 10))
      others.push(...(await plantTasks(t, sub, 2, (k) => ({ ...openTask(k), ...dated(k) }))))
    await withReach(t)
    const ends = scheduled(own)
    for (let i = 0; i < 5; i++) await link(t, ends[2 * i], ends[2 * i + 1])
    for (let i = 0; i < 10; i++) await link(t, others[i], ends[10 + i])
    const { answer, read } = await dependenciesRead(t, [me], { kind: 'mine' })
    record('My view of 400 tasks over 200 sub-projects', answer, read)
    expect(ok(answer).auto_move.state).toBe('ok')
  })

  it('measures what each task of a part outside the selection costs, over chains of everyday projects', async () => {
    const figures: { outside: number; read: ReadFigures }[] = []
    for (const projects of [1, 2]) {
      const t = newT({ transactionLimits: true })
      const f = await withOrg(t)
      // the selection, an everyday project of 3 sub-projects of 30
      const subs = [f.sub, f.sub2, ...(await plantSubs(t, f.meta, 1))]
      const own: Doc<'issues'>[] = []
      for (const [k, sub] of subs.entries()) own.push(...(await plantOpen(t, sub, 30, 100 * k)))
      // one selected task blocked by a chain through every dated task of
      // `projects` everyday projects
      const chain = scheduled(await everyday(t, f, projects, false))
      await withReach(t)
      let next = scheduled(own)[0]
      for (const blocker of chain) {
        await link(t, blocker, next)
        next = blocker
      }
      const { answer, read } = await dependenciesRead(
        t,
        [f.guest],
        projectScope(f.guest, f.meta.id),
      )
      record(`a chain of ${chain.length} tasks through ${projects} everyday projects`, answer, read)
      const a = ok(answer)
      if (a.auto_move.state !== 'ok') throw new Error('parts')
      figures.push({
        outside: a.auto_move.tasks.filter((row) => !subs.some((s) => s.id === row.project_id))
          .length,
        read,
      })
    }
    const [one, two] = figures
    const per = {
      ranges: (two.read.ranges - one.read.ranges) / (two.outside - one.outside),
      documents: (two.read.documents - one.read.documents) / (two.outside - one.outside),
      mib: (two.read.mib - one.read.mib) / (two.outside - one.outside),
    }
    console.log(
      'dependency figures, each task of a part outside the selection:',
      JSON.stringify(per),
    )
    expect(per.ranges).toBeGreaterThan(0)
    expect(per.ranges).toBeLessThan(10)
    // the measured size beside the 800-task project's reads is computed in
    // DEPENDENCIES' docstring from these figures
    expect(DEFAULT_DEPENDENCIES.reads.bytes).toBe(12 * MIB)
  })
})

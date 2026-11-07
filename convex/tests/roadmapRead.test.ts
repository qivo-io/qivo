/* tasks.roadmap, the Roadmap's server read (lib/roadmap.ts readRoadmap on
 * lib/viewFilters.ts and lib/viewReads.ts), its arguments, the selections
 * it answers unavailable alike, a check of the caller's access that a bound
 * stops, the visibility rule in the window, the filter row, the planning
 * session's task past the filter row, the ceiling with groups counted and
 * the counts bound, the headings' Remaining, the sub-projects My view
 * holds, the parents and subtasks it sends, that data the caller cannot see
 * moves nothing, and real limits under Convex's transaction limits with
 * the figures they read, one figure at its design size a case, or the
 * figures one read takes together at their sum.
 * src/store/roadmapParity.test.ts compares its answers with the app's own
 * rules. */

import { afterEach, describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { OWN_READS } from '../lib/access'
import { LIMITS, ROADMAP_TASKS } from '../lib/limits'
import { named, nameKey } from '../lib/nameKey'
import {
  type PlannedTask,
  ROADMAP,
  type RoadmapAnswer,
  type RoadmapFilters,
  type RoadmapScope,
  type RoadmapWindow,
  readRoadmap,
} from '../lib/roadmap'
import { ownedBy } from '../lib/viewReads'
import { unstampOverview } from '../model/overviewCounts'
import { SHAPES } from './accessShapes.setup'
import { boardFor, plantTasks, projectScope, type ReadFigures } from './board.setup'
import {
  expectRefusal,
  NOW,
  newT,
  plantHiddenSibling,
  plantIssue,
  plantLogin,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withReadingAdmin,
} from './helpers.setup'
import { plantShared } from './overview.setup'
import { countOrg } from './overviewCounts.setup'
import { withReach } from './projectReach.setup'
import {
  DEFAULT_WINDOW,
  dayPlus,
  dependenciesFor,
  NO_ROADMAP_FILTERS,
  NOW_WEEK,
  ordinary,
  plannedOf,
  roadmapFor,
  roadmapIds,
  roadmapRead,
  TEXT_CHARS,
  weeksFrom,
  words,
} from './roadmap.setup'

const DEFAULT_ROADMAP = structuredClone(ROADMAP)
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
afterEach(() => {
  Object.assign(ROADMAP, structuredClone(DEFAULT_ROADMAP))
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
})

/** The answer's state, and its rows' count when ok. */
const stateOf = (answer: RoadmapAnswer) =>
  answer.state === 'ok' ? { state: 'ok', rows: answer.rows.length } : { state: answer.state }

/** The answer's rows, parents and subtasks by title, with the facts a
 * Roadmap shows, so answers of two organizations compare. */
const shape = (answer: RoadmapAnswer) => {
  if (answer.state !== 'ok') return answer
  const one = (row: { title: string; has_subtasks: boolean; group_done?: boolean }) => ({
    title: row.title,
    group: row.has_subtasks,
    done: row.group_done,
  })
  const by = (rows: { title: string; has_subtasks: boolean; group_done?: boolean }[]) =>
    rows.map(one).sort((a, b) => a.title.localeCompare(b.title))
  return {
    rows: by(answer.rows),
    parents: by(answer.parents),
    subtasks: by(answer.subtasks),
    held: answer.held_sub_projects?.length,
    remaining: answer.remaining.state,
  }
}

/** The titles of the answer's rows, sorted, or its state. */
const titles = (answer: RoadmapAnswer): string[] | string =>
  answer.state === 'ok' ? answer.rows.map((row) => row.title).sort() : answer.state

/** Plants a task in `project` of the fixture's organization. */
const task = (t: T, project: Doc<'projects'>, fields: Partial<Doc<'issues'>>) =>
  plantIssue(t, { org_id: project.org_id, project_id: project.id, ...fields })

/** A task Done in the week of `day`, both its weeks there. */
const doneIn = (day: string): Partial<Doc<'issues'>> => ({
  status: 'done',
  done_at: NOW,
  start_week: day,
  end_week: day,
})

/* ---------------------------------------------------------------- arguments */

describe('arguments', () => {
  it('refuses more than ROADMAP.owners owners, a search past LIMITS.search and a window that is not one, and answers at the bounds', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const scope = projectScope(f.guest, f.sub.id)
    const owners = (n: number) => Array.from({ length: n }, () => uuid())
    await expectRefusal(
      roadmapFor(t, f.guest, scope, { owners: owners(ROADMAP.owners + 1) }),
      'bad_request',
      /at most 1000 people/,
    )
    await expectRefusal(
      roadmapFor(t, f.guest, scope, { search: 'a'.repeat(LIMITS.search.max + 1) }),
      'rule',
      new RegExp(LIMITS.search.refusal.slice(0, 20)),
    )
    const refused: [string, RoadmapWindow][] = [
      ['not a day', { from: 'last week', to: NOW_WEEK }],
      ['a day that does not exist', { from: '2026-02-23', to: '2026-02-30' }],
      ['to before from', { from: NOW_WEEK, to: dayPlus(NOW_WEEK, -7) }],
      ['not whole weeks apart', { from: NOW_WEEK, to: dayPlus(NOW_WEEK, 9) }],
      ['261 weeks', weeksFrom(NOW_WEEK, 261)],
    ]
    for (const [label, window] of refused)
      await expectRefusal(roadmapFor(t, f.guest, scope, {}, window), 'bad_request').catch((e) => {
        throw new Error(`${label}: ${String(e)}`)
      })
    for (const window of [weeksFrom(NOW_WEEK, 260), weeksFrom(NOW_WEEK, 1)])
      expect((await roadmapFor(t, f.guest, scope, {}, window)).state).toBe('ok')
    const bounds = await roadmapFor(t, f.guest, scope, {
      owners: owners(ROADMAP.owners),
      search: 'a'.repeat(LIMITS.search.max),
    })
    expect(bounds.state).toBe('ok')
  })
})

/* -------------------------------------------------------------------- access */

describe('access', () => {
  it('answers unavailable alike for every selection it does not hold', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const archived = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const notMeta = await plantProject(t, { org_id: f.org.id, type: 'project' })
    const cases: [Doc<'profiles'>, RoadmapScope][] = [
      [f.guest, projectScope(f.guest, uuid())],
      [f.guest, projectScope(f.guest, f.otherProject.id)],
      [f.guest, projectScope(f.guest, archived.id)],
      [f.guest, projectScope(f.guest, f.hidden.id)],
      [f.admin, projectScope(f.admin, notMeta.id)],
      [f.guest, { kind: 'project', org_id: f.otherOrg.id, project_id: f.otherProject.id }],
    ]
    for (const [who, scope] of cases)
      expect(await roadmapFor(t, who, scope)).toEqual({ state: 'unavailable' })
    expect((await roadmapFor(t, f.guest, projectScope(f.guest, f.meta.id))).state).toBe('ok')
  })

  it("answers unavailable with access_unchecked from both reads where a bound of the caller's own reads stopped a check, never ok", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const me = await plantLogin(t, await plantSeat(t, { org_id: f.org.id, accepted_at: NOW }))
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
    await task(t, f.sub2, { assignee_id: me.id })
    expect(stateOf(await roadmapFor(t, me, projectScope(me, f.meta.id)))).toEqual({
      state: 'ok',
      rows: 1,
    })
    const scopes: RoadmapScope[] = [
      projectScope(me, f.meta.id),
      projectScope(me, f.sub2.id),
      { kind: 'mine' },
    ]
    for (const scope of scopes) expect((await dependenciesFor(t, me, scope)).state).toBe('ok')
    Object.assign(OWN_READS, { projectShares: 0, rows: 0, lookups: 0, teamReads: 0, navRows: 0 })
    const unchecked = {
      state: 'unavailable',
      reason: 'access_unchecked',
      message: expect.stringContaining('could not finish checking which projects you can see'),
    }
    for (const scope of scopes) {
      expect(await roadmapFor(t, me, scope)).toEqual(unchecked)
      expect(await dependenciesFor(t, me, scope)).toEqual(unchecked)
    }
  })

  it('adds no row, parent, subtask or Remaining of a hidden or an archived sub-project', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const sibling = await plantHiddenSibling(t, f, f.guest)
    const archived = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const shown = await task(t, f.sub, { title: 'Shown', assignee_id: f.guest.id })
    const group = await task(t, f.sub, { title: 'Group', assignee_id: f.guest.id })
    for (const p of [sibling, archived]) {
      await task(t, p, { title: `Open in ${p.id}`, remaining_hours: 4, assignee_id: f.guest.id })
      await task(t, p, { title: `Kid in ${p.id}`, parent_id: group.id, assignee_id: f.guest.id })
      await task(t, p, { title: `Under shown ${p.id}`, parent_id: shown.id })
    }
    await countOrg(t, f.org.id)
    for (const scope of [projectScope(f.guest, f.meta.id), { kind: 'mine' } as const]) {
      const answer = await roadmapFor(t, f.guest, scope)
      if (answer.state !== 'ok') throw new Error(answer.state)
      expect(answer.rows.map((r) => r.title).sort()).toEqual(['Group', 'Shown'])
      expect(answer.parents).toEqual([])
      expect(answer.subtasks).toEqual([])
      if (answer.remaining.state !== 'ok') throw new Error('counts')
      for (const id of [sibling.id, archived.id]) {
        expect(answer.remaining.tenths).not.toHaveProperty(id)
        expect(JSON.stringify(answer)).not.toContain(id)
      }
      // a hidden subtask keeps a group not done
      const row = answer.rows.find((r) => r.title === 'Group')
      expect(row?.has_hidden_subtasks).toBe(true)
      expect(row?.group_done).toBe(false)
    }
  })

  it("reads no one else's task into an admin's My view", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    await task(t, f.sub, { title: 'The admin’s', assignee_id: f.admin.id })
    await task(t, f.sub, { title: 'The user’s', assignee_id: f.user.id })
    await task(t, f.sub2, { title: 'Nobody’s' })
    expect(titles(await roadmapFor(t, f.admin, { kind: 'mine' }))).toEqual(['The admin’s'])
    // the admin's project selection holds every task
    expect(titles(await roadmapFor(t, f.admin, projectScope(f.admin, f.meta.id)))).toHaveLength(3)
  })

  for (const role of ['guest', 'viewer'] as const)
    it(`answers the rows the Board answers, for a ${role} in every access shape, over every selection`, async () => {
      for (const shapeOf of SHAPES) {
        const t = newT()
        const f = await withReadingAdmin(t)
        const me = await plantLogin(
          t,
          await plantSeat(t, { org_id: f.org.id, org_role: role, accepted_at: NOW }),
        )
        await t.run((ctx) => shapeOf[1](ctx, f, me))
        const skunk = await plantProject(t, {
          org_id: f.org.id,
          type: 'project',
          parent_id: f.hidden.id,
        })
        for (const p of [f.sub, f.sub2, skunk]) {
          const group = await task(t, p, { title: `Group ${p.key}`, assignee_id: me.id })
          await task(t, p, { title: `Kid ${p.key}`, parent_id: group.id, assignee_id: me.id })
          await task(t, p, { title: `Plain ${p.key}`, assignee_id: f.user.id })
        }
        await withReach(t)
        for (const scope of [
          ...[f.meta, f.sub, f.sub2, f.hidden, skunk].map((p) => projectScope(me, p.id)),
          { kind: 'mine' } as const,
        ]) {
          const board = await boardFor(t, me, scope, scope.kind === 'mine' ? { mine: true } : {})
          const roadmap = await roadmapFor(t, me, scope)
          const label = `${role}, ${shapeOf[0]}, ${JSON.stringify(scope)}`
          if (board.state !== 'ok') {
            expect(roadmap, label).toEqual(board)
            continue
          }
          expect(roadmapIds(roadmap), label).toEqual(board.rows.map((r) => r.id).sort())
        }
      }
    })
})

/* ---------------------------------------------------------------- visibility */

describe('visibility', () => {
  /** FW's tasks for each visibility case, with DEFAULT_WINDOW's weeks
   * 2025-12-15 to 2026-02-09, Mondays. */
  async function visibilityCase() {
    const t = newT()
    const f = await withReadingAdmin(t)
    const sibling = await plantHiddenSibling(t, f, f.guest)
    const first = DEFAULT_WINDOW.from
    const last = DEFAULT_WINDOW.to
    const shown: string[] = []
    const hidden: string[] = []
    const plant = async (title: string, fields: Partial<Doc<'issues'>>, visible: boolean) => {
      const planted = await task(t, f.sub, { title, ...fields })
      ;(visible ? shown : hidden).push(title)
      return planted
    }
    await plant('Backlog leaf', { status: 'backlog' }, false)
    const backlogGroup = await plant('Backlog group', { status: 'backlog' }, true)
    await task(t, f.sub, { title: 'Its to do', parent_id: backlogGroup.id })
    await plant('Done in the first week', doneIn(first), true)
    await plant('Done a week before', doneIn(dayPlus(first, -7)), false)
    await plant('Done in the last week', doneIn(last), true)
    await plant('Done a week after', doneIn(dayPlus(last, 7)), false)
    await plant('Done on the last week’s Sunday', doneIn(dayPlus(last, 6)), true)
    await plant('Done on the Sunday before', doneIn(dayPlus(first, -1)), false)
    await plant('Done undated', { status: 'done', done_at: NOW }, false)
    await plant(
      'Done with a start week only',
      { status: 'done', done_at: NOW, start_week: first },
      false,
    )
    await plant(
      'Done across the window',
      { ...doneIn(dayPlus(first, -70)), end_week: dayPlus(last, 70) },
      true,
    )
    const doneInside = await plant('To do group, done inside', { status: 'todo' }, true)
    await task(t, f.sub, { title: 'Done kid inside', parent_id: doneInside.id, ...doneIn(first) })
    const doneOutside = await plant('To do group, done outside', { status: 'todo' }, false)
    await task(t, f.sub, {
      title: 'Done kid outside',
      parent_id: doneOutside.id,
      ...doneIn(dayPlus(last, 7)),
    })
    const backlogDone = await plant('Backlog group, done outside', { status: 'backlog' }, false)
    await task(t, f.sub, {
      title: 'Its done kid',
      parent_id: backlogDone.id,
      ...doneIn(dayPlus(first, -7)),
    })
    const backlogInside = await plant('Backlog group, done inside', { status: 'backlog' }, true)
    await task(t, f.sub, {
      title: 'Kid of the Backlog group inside',
      parent_id: backlogInside.id,
      ...doneIn(first),
    })
    const doneGroupInside = await plant('Done group, done inside', { status: 'done' }, true)
    await task(t, f.sub, {
      title: 'Kid of the Done group inside',
      parent_id: doneGroupInside.id,
      ...doneIn(first),
    })
    const doneGroupOutside = await plant('Done group, done outside', { status: 'done' }, false)
    await task(t, f.sub, {
      title: 'Kid of the Done group outside',
      parent_id: doneGroupOutside.id,
      ...doneIn(dayPlus(last, 7)),
    })
    const doneOpen = await plant('Done group with an open kid', { status: 'done' }, true)
    await task(t, f.sub, { title: 'Its open kid', parent_id: doneOpen.id })
    const hiddenKid = await plant('Group with a hidden kid', { status: 'todo' }, true)
    await task(t, f.sub, {
      title: 'Shown done kid',
      parent_id: hiddenKid.id,
      ...doneIn(dayPlus(last, 7)),
    })
    await task(t, sibling, { title: 'Hidden done kid', parent_id: hiddenKid.id, status: 'done' })
    await plant(
      'Open outside the window',
      { start_week: dayPlus(last, 700), end_week: dayPlus(last, 707) },
      true,
    )
    await plant('Open undated', {}, true)
    return { t, f, shown, hidden }
  }

  it('shows what isRoadmapTaskVisible keeps in the window, Done tasks by their weeks and groups by their facts', async () => {
    const { t, f, shown } = await visibilityCase()
    const answer = await roadmapFor(t, f.guest, projectScope(f.guest, f.sub.id))
    if (answer.state !== 'ok') throw new Error(answer.state)
    // the open subtasks are rows too, and a Done one in the window
    expect(titles(answer)).toEqual(
      [
        ...shown,
        'Done kid inside',
        'Its open kid',
        'Its to do',
        'Kid of the Backlog group inside',
        'Kid of the Done group inside',
      ].sort(),
    )
  })

  it('floors a stored day into the reader’s weeks, whatever day the week starts on', async () => {
    const { t, f } = await visibilityCase()
    const scope = projectScope(f.guest, f.sub.id)
    // the same weeks counted from their Sundays, so the Sunday before the
    // window is now in its first week, and the last week's Sunday in the
    // week after
    const sundays = { from: dayPlus(DEFAULT_WINDOW.from, -1), to: dayPlus(DEFAULT_WINDOW.to, -1) }
    const answer = titles(await roadmapFor(t, f.guest, scope, {}, sundays))
    expect(answer).toContain('Done on the Sunday before')
    expect(answer).not.toContain('Done on the last week’s Sunday')
    // this must fail, as a window one week off holds other Done tasks
    const later = { from: dayPlus(DEFAULT_WINDOW.from, 7), to: dayPlus(DEFAULT_WINDOW.to, 7) }
    expect(titles(await roadmapFor(t, f.guest, scope, {}, later))).not.toEqual(
      titles(await roadmapFor(t, f.guest, scope)),
    )
  })
})

/* ------------------------------------------------------------------- filters */

describe('filters', () => {
  it('applies My tasks and the people filter by the Reviewer rule, Priority and the text filter', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    await task(t, f.sub, { title: 'Mine', assignee_id: f.guest.id, priority: 'high' })
    await task(t, f.sub, {
      title: 'Handed to review',
      status: 'review',
      assignee_id: f.guest.id,
      reviewer_id: f.user.id,
    })
    await task(t, f.sub, {
      title: 'Awaiting my review',
      status: 'review',
      assignee_id: f.user.id,
      reviewer_id: f.guest.id,
    })
    const group = await task(t, f.sub, {
      title: 'Group in review',
      status: 'review',
      assignee_id: f.user.id,
      reviewer_id: f.guest.id,
    })
    await task(t, f.sub, { title: 'Quartz kid', parent_id: group.id, assignee_id: f.user.id })
    await task(t, f.sub, { title: 'Theirs', assignee_id: f.user.id, priority: 'high' })
    const scope = projectScope(f.guest, f.sub.id)
    expect(titles(await roadmapFor(t, f.guest, scope, { mine: true }))).toEqual([
      'Awaiting my review',
      'Mine',
    ])
    expect(titles(await roadmapFor(t, f.guest, scope, { owners: [f.user.id] }))).toEqual([
      'Group in review',
      'Handed to review',
      'Quartz kid',
      'Theirs',
    ])
    expect(titles(await roadmapFor(t, f.guest, scope, { priority: 'high' }))).toEqual([
      'Mine',
      'Theirs',
    ])
    expect(titles(await roadmapFor(t, f.guest, scope, { search: 'quartz' }))).toEqual([
      'Quartz kid',
    ])
    // a group's stored status is not searched, a task's is
    expect(titles(await roadmapFor(t, f.guest, scope, { search: 'in review' }))).toEqual([
      'Awaiting my review',
      'Group in review',
      'Handed to review',
    ])
    // My view is the person's own tasks
    expect(titles(await roadmapFor(t, f.guest, { kind: 'mine' }))).toEqual([
      'Awaiting my review',
      'Mine',
    ])
  })
})

/* ------------------------------------------------------------ the planned task */

describe('the planned task', () => {
  it('keeps the planning session’s task past the filter row only, never a task the caller does not hold, one the window hides, one named with another sub-project or an id of nothing', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const sibling = await plantHiddenSibling(t, f, f.guest)
    await task(t, f.sub, { title: 'Mine', assignee_id: f.guest.id })
    const theirs = await task(t, f.sub, { title: 'Theirs', assignee_id: f.user.id })
    const archived = await task(t, f.sub, {
      title: 'Archived',
      assignee_id: f.user.id,
      archived_at: NOW,
    })
    const hidden = await task(t, sibling, { title: 'Hidden', assignee_id: f.user.id })
    const elsewhere = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      title: 'Elsewhere',
    })
    const backlog = await task(t, f.sub, {
      title: 'Backlog',
      status: 'backlog',
      assignee_id: f.user.id,
    })
    const scope = projectScope(f.guest, f.meta.id)
    const plain = await roadmapFor(t, f.guest, scope, { mine: true })
    expect(titles(plain)).toEqual(['Mine'])
    // My tasks hides Theirs, which the read finds among its sub-project's
    // active tasks as the session's
    expect(
      titles(
        await roadmapFor(t, f.guest, scope, { mine: true }, DEFAULT_WINDOW, plannedOf(theirs)),
      ),
    ).toEqual(['Mine', 'Theirs'])
    // this must fail for a read that keeps a planned task outside the
    // caller's working set, which shows the archived task, or one the
    // caller names with a sub-project it is not in
    const named: [string, PlannedTask][] = [
      ['archived', plannedOf(archived)],
      ['hidden', plannedOf(hidden)],
      ['hidden, named with FW', { id: hidden.id, project_id: f.sub.id }],
      ['elsewhere', plannedOf(elsewhere)],
      ['elsewhere, named with FW', { id: elsewhere.id, project_id: f.sub.id }],
      ['backlog', plannedOf(backlog)],
      ['theirs, named with PCB', { id: theirs.id, project_id: f.sub2.id }],
      ['nothing', { id: uuid(), project_id: f.sub.id }],
    ]
    for (const [label, planned] of named)
      expect(
        await roadmapFor(t, f.guest, scope, { mine: true }, DEFAULT_WINDOW, planned),
        label,
      ).toEqual(plain)
  })

  it('reads nothing by the planned task’s id, so a task of another organization, one in a hidden project and an id of nothing answer and read the same, at a lowered document budget too', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const sibling = await plantHiddenSibling(t, f, f.guest)
    await task(t, f.sub, { title: 'Mine', assignee_id: f.guest.id })
    // other people's tasks, which the read of FW's active tasks takes
    await plantTasks(t, f.sub, 20, ordinary)
    const hidden = await task(t, sibling, { title: 'Hidden', assignee_id: f.user.id })
    const elsewhere = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      title: 'Elsewhere',
    })
    const scope = projectScope(f.guest, f.meta.id)
    const read = (planned?: PlannedTask) =>
      roadmapRead(t, [f.guest], scope, { mine: true }, DEFAULT_WINDOW, planned)
    /** The smallest ROADMAP.reads.documents at which `planned` answers ok. */
    const leastDocuments = async (planned?: PlannedTask) => {
      let low = 0
      let high = DEFAULT_ROADMAP.reads.documents
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2)
        ROADMAP.reads.documents = mid
        if ((await read(planned)).answer.state === 'ok') high = mid
        else low = mid
      }
      ROADMAP.reads.documents = DEFAULT_ROADMAP.reads.documents
      return high
    }
    /** Expects each of `ids`, named with sub-project `project`, to answer
     * and read as `planned` does, at the default budget, at the smallest
     * document budget `planned` fits and one below it. */
    const alike = async (ids: string[], project: string, planned?: PlannedTask) => {
      const least = await leastDocuments(planned)
      for (const [documents, state] of [
        [DEFAULT_ROADMAP.reads.documents, 'ok'],
        [least, 'ok'],
        [least - 1, 'over_budget'],
      ] as const) {
        ROADMAP.reads.documents = documents
        const expected = await read(planned)
        expect(expected.answer.state, `${documents} documents`).toBe(state)
        for (const id of ids)
          expect(
            await read({ id, project_id: project }),
            `${id === hidden.id ? 'hidden' : id === elsewhere.id ? 'elsewhere' : 'nothing'}, ${documents} documents`,
          ).toEqual(expected)
      }
      ROADMAP.reads.documents = DEFAULT_ROADMAP.reads.documents
    }
    const ids = [hidden.id, elsewhere.id, uuid()]
    // named with a sub-project outside the selection, as the hidden task's
    // and the other organization's are, it reads nothing at all
    await alike(ids, sibling.id)
    await alike(ids, f.otherProject.id)
    // named with a selected sub-project, it reads FW's active tasks, and
    // only those. This must fail for a read of the task by its id, which
    // reads one more document for a task that exists anywhere
    await alike(ids, f.sub.id, { id: uuid(), project_id: f.sub.id })
  })

  it('counts the planned task toward the ceiling', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    ROADMAP.ceiling = 3
    await plantTasks(t, f.sub, 3, (i) => ({ ...ordinary(i), priority: 'high' }))
    const low = await task(t, f.sub, { title: 'Low', priority: 'low' })
    const scope = projectScope(f.guest, f.sub.id)
    const high = { priority: 'high' as const }
    expect(stateOf(await roadmapFor(t, f.guest, scope, high))).toEqual({ state: 'ok', rows: 3 })
    // this must fail for a planned task that does not count, which answers
    // ok with 4 rows
    expect(await roadmapFor(t, f.guest, scope, high, DEFAULT_WINDOW, plannedOf(low))).toEqual({
      state: 'over_ceiling',
      ceiling: 3,
      projects: [f.sub.id],
    })
    ROADMAP.ceiling = 4
    expect(
      stateOf(await roadmapFor(t, f.guest, scope, high, DEFAULT_WINDOW, plannedOf(low))),
    ).toEqual({
      state: 'ok',
      rows: 4,
    })
  })
})

/* ------------------------------------------------------------------- ceiling */

describe('the ceiling', () => {
  it('counts groups: five subtasks under five groups fit a ceiling of 10, one more task does not, and Done tasks outside the window do not count', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withReadingAdmin(t)
    ROADMAP.ceiling = 10
    const groups = await plantTasks(t, f.sub, 5, ordinary)
    await plantTasks(t, f.sub, 5, (i) => ({ ...ordinary(i), parent_id: groups[i].id }))
    await plantTasks(t, f.sub, 3, (i) => ({
      ...ordinary(i),
      ...doneIn(dayPlus(DEFAULT_WINDOW.to, 7 * (i + 1))),
    }))
    const scope = projectScope(f.guest, f.sub.id)
    expect(stateOf((await roadmapRead(t, [f.guest], scope)).answer)).toEqual({
      state: 'ok',
      rows: 10,
    })
    // this must fail for a rule that counts no group, which answers 11 rows
    await plantTasks(t, f.sub, 1, ordinary)
    expect((await roadmapRead(t, [f.guest], scope)).answer).toEqual({
      state: 'over_ceiling',
      ceiling: 10,
      projects: [f.sub.id],
    })
    // a window that holds the Done tasks counts them
    ROADMAP.ceiling = 13
    expect(stateOf((await roadmapRead(t, [f.guest], scope)).answer)).toEqual({
      state: 'ok',
      rows: 11,
    })
    const wide = weeksFrom(DEFAULT_WINDOW.from, 20)
    expect((await roadmapRead(t, [f.guest], scope, {}, wide)).answer.state).toBe('over_ceiling')
  })

  /** Counts the ranges readRoadmap opens on the issues table, beside its
   * answer and what it read. */
  const issueRanges = (
    t: T,
    me: Doc<'profiles'>,
    scope: RoadmapScope,
    filters: Partial<RoadmapFilters> = {},
  ) =>
    t.run(async (ctx) => {
      let ranges = 0
      const db = new Proxy(ctx.db, {
        get(target, key) {
          if (key === 'query')
            return (table: Parameters<typeof target.query>[0]) => {
              if (table === 'issues') ranges++
              return target.query(table)
            }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const answer = await readRoadmap(
        { ...ctx, db } as unknown as QueryCtx,
        new Map([[me.org_id, me]]),
        {
          scope,
          filters: { ...NO_ROADMAP_FILTERS, ...filters },
          window: DEFAULT_WINDOW,
        },
      )
      const m = await ctx.meta.getTransactionMetrics()
      return { answer, issueRanges: ranges, ranges: m.databaseQueries.used }
    })

  it('answers over_ceiling from the counts with no task read, and falls back to the read while counting, under Priority and under a text filter', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withReadingAdmin(t)
    ROADMAP.ceiling = 10
    await plantTasks(t, f.sub, 6, (i) => ({ ...ordinary(i), assignee_id: f.guest.id }))
    await plantTasks(t, f.sub2, 4, (i) => ({
      ...ordinary(i),
      status: i % 2 === 0 ? 'progress' : 'review',
      assignee_id: f.guest.id,
    }))
    await countOrg(t, f.org.id)
    const scopes = [projectScope(f.guest, f.meta.id), { kind: 'mine' } as const]
    // with ten open leaves the bound does not claim more than ten
    for (const scope of scopes)
      expect(stateOf((await issueRanges(t, f.guest, scope)).answer)).toEqual({
        state: 'ok',
        rows: 10,
      })
    // an eleventh, which its write counts
    await task(t, f.sub2, { title: ordinary(11).title, status: 'review', assignee_id: f.guest.id })
    for (const scope of scopes) {
      const bound = await issueRanges(t, f.guest, scope)
      console.log('roadmap figures, the counts bound:', JSON.stringify(scope), bound.ranges)
      expect(bound.answer.state).toBe('over_ceiling')
      expect(bound.issueRanges).toBe(0)
      for (const filters of [{ priority: 'medium' as const }, { search: 'the' }]) {
        const read = await issueRanges(t, f.guest, scope, filters)
        expect(read.answer.state, JSON.stringify(filters)).toBe('over_ceiling')
        expect(read.issueRanges).toBeGreaterThan(0)
      }
    }
    // the bound stays off under My tasks and the people filter, whose rows
    // it would have to read
    for (const filters of [{ mine: true }, { owners: [f.guest.id] }]) {
      const read = await issueRanges(t, f.guest, projectScope(f.guest, f.meta.id), filters)
      expect(read.answer.state).toBe('over_ceiling')
      expect(read.issueRanges).toBeGreaterThan(0)
    }
    // and while the counts are not whole the read decides
    await t.run((ctx) => unstampOverview(ctx.db, f.org.id))
    for (const scope of scopes) {
      const counting = await issueRanges(t, f.guest, scope)
      expect(counting.answer.state).toBe('over_ceiling')
      expect(counting.issueRanges).toBeGreaterThan(0)
    }
  })

  it('answers over_budget where a budget stops the read first, never ok with fewer rows', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withReadingAdmin(t)
    await plantTasks(t, f.sub, 40, ordinary)
    const scope = projectScope(f.guest, f.sub.id)
    const whole = await roadmapRead(t, [f.guest], scope)
    expect(stateOf(whole.answer)).toEqual({ state: 'ok', rows: 40 })
    for (let ranges = whole.read.ranges - 1; ranges > whole.read.ranges - 30; ranges -= 7) {
      ROADMAP.reads.ranges = ranges
      expect((await roadmapRead(t, [f.guest], scope)).answer).toEqual({
        state: 'over_budget',
        projects: [f.sub.id],
      })
    }
  })
})

/* ------------------------------------------------------------------ headings */

describe('the headings', () => {
  it("answers each sub-project's unfinished leaves' Remaining in tenths, Backlog included and Done left out, before the filters, and counting while the counts are not whole", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const hours: [Doc<'projects'>, Partial<Doc<'issues'>>][] = [
      [f.sub, { status: 'todo', remaining_hours: 1.5, assignee_id: f.guest.id }],
      [f.sub, { status: 'backlog', remaining_hours: 2 }],
      [f.sub, { status: 'done', remaining_hours: 3, done_at: NOW, assignee_id: f.guest.id }],
      [f.sub, { status: 'progress', remaining_hours: 0.1, assignee_id: f.guest.id }],
      [f.sub, { status: 'review', remaining_hours: 0.2, priority: 'low' }],
      [f.sub2, { status: 'todo', remaining_hours: 0.7 }],
    ]
    for (const [p, fields] of hours) await task(t, p, fields)
    // a group's own hours are dormant
    const group = await task(t, f.sub2, { remaining_hours: 5 })
    await task(t, f.sub2, { parent_id: group.id, remaining_hours: 0.4, assignee_id: f.guest.id })
    const scope = projectScope(f.guest, f.meta.id)
    expect(await roadmapFor(t, f.guest, scope)).toMatchObject({
      state: 'ok',
      remaining: { state: 'unavailable', reason: 'counting' },
    })
    await countOrg(t, f.org.id)
    for (const filters of [{}, { priority: 'high' as const }, { mine: true }, { search: 'x' }])
      expect(await roadmapFor(t, f.guest, scope, filters)).toMatchObject({
        remaining: { state: 'ok', tenths: { [f.sub.id]: 38, [f.sub2.id]: 11 } },
      })
    // in My view, the person's own leaves
    expect(await roadmapFor(t, f.guest, { kind: 'mine' })).toMatchObject({
      remaining: { state: 'ok', tenths: { [f.sub.id]: 16, [f.sub2.id]: 4 } },
    })
  })
})

/* ------------------------------------------------------------- held sub-projects */

describe("My view's sub-projects", () => {
  it('names a sub-project the person holds a task of by the Reviewer rule, whatever its status, dates or the filters', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const subs: Record<string, Doc<'projects'>> = {}
    for (const key of ['backlog', 'doneOutside', 'others', 'handedOn', 'group', 'reviewing'])
      subs[key] = await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: f.meta.id,
      })
    await task(t, subs.backlog, { status: 'backlog', assignee_id: f.guest.id })
    await task(t, subs.doneOutside, {
      assignee_id: f.guest.id,
      ...doneIn(dayPlus(DEFAULT_WINDOW.to, 70)),
    })
    await task(t, subs.others, { assignee_id: f.user.id })
    await task(t, subs.handedOn, {
      status: 'review',
      assignee_id: f.guest.id,
      reviewer_id: f.user.id,
      priority: 'low',
    })
    const group = await task(t, subs.group, {
      status: 'review',
      assignee_id: f.user.id,
      reviewer_id: f.guest.id,
    })
    await task(t, subs.group, { parent_id: group.id, assignee_id: f.user.id })
    await task(t, subs.reviewing, {
      status: 'review',
      assignee_id: f.user.id,
      reviewer_id: f.guest.id,
      priority: 'low',
    })
    const expected = [subs.backlog.id, subs.doneOutside.id, subs.reviewing.id].sort()
    for (const filters of [{}, { priority: 'urgent' as const }, { search: 'nothing like it' }]) {
      const answer = await roadmapFor(t, f.guest, { kind: 'mine' }, filters)
      if (answer.state !== 'ok') throw new Error(answer.state)
      expect(answer.held_sub_projects, JSON.stringify(filters)).toEqual(expected)
    }
    // this must fail for a rule that takes the assignee as the owner, which
    // names the handed-on task's sub-project and not the reviewed one's
    const tasks = await t.run((ctx) =>
      ctx.db
        .query('issues')
        .withIndex('by_org_archived', (q) => q.eq('org_id', f.org.id).eq('archived_at', undefined))
        .collect(),
    )
    const byAssignee = [
      ...new Set(tasks.filter((x) => x.assignee_id === f.guest.id).map((x) => x.project_id)),
    ].sort()
    expect(byAssignee).not.toEqual(expected)
    const byRule = [
      ...new Set(
        tasks.filter((x) => ownedBy(x, x.id === group.id, f.guest.id)).map((x) => x.project_id),
      ),
    ].sort()
    expect(byRule).toEqual(expected)
    // a project selection names none
    const project = await roadmapFor(t, f.guest, projectScope(f.guest, f.meta.id))
    expect(project).not.toHaveProperty('held_sub_projects')
  })
})

/* --------------------------------------------------------- parents and subtasks */

describe('parents and subtasks', () => {
  it("sends a row's parent in a sibling sub-project only where the caller is shown it, and a group row's subtasks that are not rows", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const sibling = await plantHiddenSibling(t, f, f.guest)
    const shownParent = await task(t, f.sub2, { title: 'Parent in PCB', priority: 'low' })
    const hiddenParent = await task(t, sibling, { title: 'Parent in the sibling' })
    await task(t, f.sub, { title: 'Under PCB', parent_id: shownParent.id, priority: 'high' })
    await task(t, f.sub, {
      title: 'Under the sibling',
      parent_id: hiddenParent.id,
      priority: 'high',
    })
    const group = await task(t, f.sub, { title: 'Group', priority: 'high' })
    await task(t, f.sub, {
      title: 'Backlog kid',
      parent_id: group.id,
      status: 'backlog',
      priority: 'high',
    })
    await task(t, f.sub, { title: 'Low kid', parent_id: group.id, priority: 'low' })
    await task(t, f.sub2, { title: 'Kid in PCB', parent_id: group.id, priority: 'high' })
    await task(t, f.sub, {
      title: 'Done kid outside',
      parent_id: group.id,
      priority: 'high',
      ...doneIn(dayPlus(DEFAULT_WINDOW.to, 7)),
    })
    await task(t, f.sub, { title: 'Open kid', parent_id: group.id, priority: 'high' })
    const answer = await roadmapFor(t, f.guest, projectScope(f.guest, f.sub.id), {
      priority: 'high',
    })
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.rows.map((r) => r.title).sort()).toEqual([
      'Group',
      'Open kid',
      'Under PCB',
      'Under the sibling',
    ])
    expect(answer.parents.map((r) => r.title)).toEqual(['Parent in PCB'])
    expect(answer.subtasks.map((r) => r.title).sort()).toEqual([
      'Backlog kid',
      'Done kid outside',
      'Kid in PCB',
      'Low kid',
    ])
    const under = answer.rows.find((r) => r.title === 'Under the sibling')
    expect(under?.parent_id).toBeUndefined()
    expect(under?.has_hidden_parent).toBe(true)
    expect(answer.rows.find((r) => r.title === 'Under PCB')?.parent_id).toBe(shownParent.id)
    expect(JSON.stringify(answer)).not.toContain(hiddenParent.id)
    for (const kid of answer.subtasks) expect(kid.parent_id).toBe(group.id)
    // past ROADMAP.context the answer is over_budget
    ROADMAP.context = 4
    expect(
      (await roadmapFor(t, f.guest, projectScope(f.guest, f.sub.id), { priority: 'high' })).state,
    ).toBe('over_budget')
  })
})

/* --------------------------------------------------------------- hidden data */

/** A fixture whose hidden rows carry ordinary text when `wide`, the
 * sibling's tasks, a hidden subtask of a shown group, a hidden parent of a
 * shown task, all the guest's own, so My view reads them too. Every task
 * has the same number in both, so their count rows fall in the same shards
 * (model/overviewCounts.ts OVERVIEW_SHARDS), and the sibling's id sorts
 * after FW's in both. How many count rows a person holds in projects they
 * cannot see, and where those projects' ids sort among the others, may
 * move an answer at the budget's margin (lib/viewReads.ts mineCounts, one
 * count row's bytes measured), which this case leaves alone. */
async function hiddenOrg(wide: boolean) {
  const t = newT()
  const f = await withReadingAdmin(t)
  const planted = await plantHiddenSibling(t, f, f.guest)
  const sibling = await t.run(async (ctx) => {
    await ctx.db.patch(planted._id, { id: `ffffffff${planted.id.slice(8)}` })
    return (await ctx.db.get(planted._id)) as Doc<'projects'>
  })
  const text = (i: number) => (wide ? ordinary(i) : { title: 'h', text: '' })
  const mine = { assignee_id: f.guest.id }
  const group = await task(t, f.sub, { title: 'Quartz group', num: 1, ...mine })
  await plantTasks(t, sibling, 1, () => ({ ...text(1), num: 2, parent_id: group.id, ...mine }))
  const [parent] = await plantTasks(t, sibling, 1, () => ({ ...text(2), num: 3, ...mine }))
  await task(t, f.sub, { title: 'Under a hidden parent', num: 4, parent_id: parent.id, ...mine })
  await plantTasks(t, sibling, 5, (i) => ({ ...text(i + 3), num: 5 + i, ...mine }))
  await plantTasks(t, f.sub, 20, (i) => ({
    num: 10 + i,
    text: i % 3 === 0 ? 'a quartz vein' : 'clay',
  }))
  await withReach(t)
  await countOrg(t, f.org.id)
  return { t, f }
}

/** The smallest ROADMAP.reads.bytes at which `read` answers ok. */
async function leastBytes(read: () => Promise<RoadmapAnswer>): Promise<number> {
  let low = 0
  let high = DEFAULT_ROADMAP.reads.bytes
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2)
    ROADMAP.reads.bytes = mid
    if ((await read()).state === 'ok') high = mid
    else low = mid
  }
  ROADMAP.reads.bytes = DEFAULT_ROADMAP.reads.bytes
  return high
}

describe('hidden data', () => {
  it("answers the same, and stops at the same budget, whatever the hidden rows' sizes and titles", async () => {
    const narrow = await hiddenOrg(false)
    const wide = await hiddenOrg(true)
    for (const [scope, filters] of [
      ['TBED', {}],
      ['FW', {}],
      ['FW', { search: 'quartz' }],
      ['My view', {}],
    ] as [string, Partial<RoadmapFilters>][]) {
      const read = (o: typeof narrow) => () =>
        roadmapFor(
          o.t,
          o.f.guest,
          scope === 'My view'
            ? { kind: 'mine' }
            : projectScope(o.f.guest, scope === 'TBED' ? o.f.meta.id : o.f.sub.id),
          filters,
        )
      const label = `${scope} ${JSON.stringify(filters)}`
      expect(shape(await read(wide)()), label).toEqual(shape(await read(narrow)()))
      const least = await leastBytes(read(narrow))
      expect(least, label).toBe(await leastBytes(read(wide)))
      ROADMAP.reads.bytes = least - 1
      expect((await read(wide)()).state, label).toBe('over_budget')
      ROADMAP.reads.bytes = DEFAULT_ROADMAP.reads.bytes
    }
  })
})

/* --------------------------------------------------------------- real limits */

const FIGURES: Record<string, ReadFigures & { state: string }> = {}
const record = (name: string, answer: RoadmapAnswer, read: ReadFigures) => {
  FIGURES[name] = { state: stateOf(answer).state, ...read }
  console.log(`roadmap figures, ${name}:`, JSON.stringify({ ...FIGURES[name], ...stateOf(answer) }))
}

/** `n` sub-projects of `parent` as model/projects.ts writes them. */
async function plantSubs(t: T, parent: Doc<'projects'>, n: number): Promise<Doc<'projects'>[]> {
  const subs: Doc<'projects'>[] = []
  for (let i = 0; i < n; i++)
    subs.push(
      await plantProject(t, {
        org_id: parent.org_id,
        type: 'project',
        parent_id: parent.id,
        ...named(`Workstream ${i + 1}`),
        lead_id: parent.lead_id,
        archive_state: 'live',
      }),
    )
  return subs
}

/** The open statuses a fixture's tasks cycle through, To do, In progress,
 * In review and Backlog, one in ten Backlog. */
const OPEN = [
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

/** An open fixture task `i`, with ordinary text, three in five dated around
 * NOW's week, half with remaining hours. */
const openTask = (i: number): Partial<Doc<'issues'>> & { text?: string } => {
  const start = dayPlus(NOW_WEEK, 7 * ((i % 40) - 20))
  return {
    ...ordinary(i),
    status: OPEN[i % OPEN.length],
    ...(i % 5 < 3 ? { start_week: start, end_week: dayPlus(start, 7 * (i % 4)) } : {}),
    ...(i % 2 === 0 ? { remaining_hours: (i % 16) + 1 } : {}),
  }
}

/** `n` open tasks in `project`, per ten one parent, two subtasks of the
 * set's parents and seven plain tasks. */
async function plantOpen(t: T, project: Doc<'projects'>, n: number, from = 0) {
  const parents = await plantTasks(t, project, Math.round(n / 10), (i) => openTask(from + i))
  await plantTasks(t, project, n - 3 * parents.length, (i) => openTask(from + 1000 + i))
  await plantTasks(t, project, 2 * parents.length, (i) => ({
    ...openTask(from + 2000 + i),
    parent_id: parents[Math.floor(i / 2)].id,
  }))
}

describe('real limits', () => {
  it('answers a project of 800 open and 200 Done tasks over 3 sub-projects, and a search of it', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withReadingAdmin(t)
    const subs = [f.sub, f.sub2, ...(await plantSubs(t, f.meta, 1))]
    // the project's open and Done tasks at their sum, as the read takes
    // both, the Board's design-size shape over the everyday 3 sub-projects,
    // so each holds 267 or 266 open tasks and 67 or 66 Done ones, within a
    // sub-project's 300 and 150. The Done tasks are dated over the 26 weeks
    // before NOW's week
    for (const [k, sub] of subs.entries()) {
      await plantOpen(t, sub, k === 2 ? 266 : 267, 3000 * k)
      await plantTasks(t, sub, k === 2 ? 66 : 67, (i) => ({
        ...ordinary(3000 * k + 500 + i),
        ...doneIn(dayPlus(NOW_WEEK, -7 * (i % 26))),
      }))
    }
    // every 100th text holds a word no sentence has
    await t.run(async (ctx) => {
      let i = 0
      for await (const row of ctx.db.query('issue_descriptions'))
        if (i++ % 100 === 7)
          await ctx.db.patch(row._id, { description: `${words(i, TEXT_CHARS - 7)} quokka` })
    })
    await countOrg(t, f.org.id)
    const scope = projectScope(f.guest, f.meta.id)
    const whole = await roadmapRead(t, [f.guest], scope)
    record('a project of 800 open and 200 Done tasks', whole.answer, whole.read)
    expect(whole.answer.state).toBe('ok')
    const all = await roadmapRead(
      t,
      [f.guest],
      scope,
      {},
      weeksFrom(dayPlus(NOW_WEEK, -7 * 30), 52),
    )
    record('the 800 open and 200 Done tasks, every Done one in the window', all.answer, all.read)
    expect(all.answer.state).toBe('ok')
    if (whole.answer.state === 'ok' && all.answer.state === 'ok')
      expect(all.answer.rows.length - whole.answer.rows.length).toBeGreaterThan(150)
    const search = await roadmapRead(t, [f.guest], scope, { search: 'quokka' })
    record('a search of the 800 open and 200 Done tasks', search.answer, search.read)
    expect(search.answer.state).toBe('ok')
  })

  it('answers a project of 30 sub-projects with 20 open tasks each', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withReadingAdmin(t)
    const subs = [f.sub, f.sub2, ...(await plantSubs(t, f.meta, 28))]
    for (const [k, sub] of subs.entries()) await plantOpen(t, sub, 20, 100 * k)
    await countOrg(t, f.org.id)
    const { answer, read } = await roadmapRead(t, [f.guest], projectScope(f.guest, f.meta.id))
    record('a project of 30 sub-projects with 20 open tasks each', answer, read)
    expect(answer.state).toBe('ok')
  })

  it('answers a sub-project of 300 open tasks beside two of 30', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withReadingAdmin(t)
    const third = (await plantSubs(t, f.meta, 1))[0]
    await plantOpen(t, f.sub, 300)
    await plantOpen(t, f.sub2, 30, 1000)
    await plantOpen(t, third, 30, 2000)
    await countOrg(t, f.org.id)
    for (const [label, scope] of [
      ['the sub-project of 300 open tasks', projectScope(f.guest, f.sub.id)],
      ['its project', projectScope(f.guest, f.meta.id)],
    ] as const) {
      const { answer, read } = await roadmapRead(t, [f.guest], scope)
      record(label, answer, read)
      expect(answer.state).toBe('ok')
    }
  })

  it('answers 200 Done tasks not yet archived beside 90 open ones, in a window that holds them all and one that holds none', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withReadingAdmin(t)
    const third = (await plantSubs(t, f.meta, 1))[0]
    // 67, 67 and 66 Done tasks, within a sub-project's 150
    for (const [k, sub] of [f.sub, f.sub2, third].entries()) {
      await plantOpen(t, sub, 30, 1000 * k)
      await plantTasks(t, sub, k === 2 ? 66 : 67, (i) => ({
        ...ordinary(i),
        ...doneIn(dayPlus(NOW_WEEK, -7 * (i % 26))),
      }))
    }
    await countOrg(t, f.org.id)
    const scope = projectScope(f.guest, f.meta.id)
    const all = await roadmapRead(
      t,
      [f.guest],
      scope,
      {},
      weeksFrom(dayPlus(NOW_WEEK, -7 * 30), 52),
    )
    record('200 Done tasks, a window that holds them all', all.answer, all.read)
    expect(all.answer.state).toBe('ok')
    const none = await roadmapRead(
      t,
      [f.guest],
      scope,
      {},
      weeksFrom(dayPlus(NOW_WEEK, 7 * 200), 52),
    )
    record('200 Done tasks, a window that holds none', none.answer, none.read)
    expect(none.answer.state).toBe('ok')
    if (all.answer.state === 'ok' && none.answer.state === 'ok')
      expect(all.answer.rows.length - none.answer.rows.length).toBe(200)
  })

  it("answers My view of 400 of the reader's tasks over the 200 sub-projects their teams share", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withReadingAdmin(t)
    const me = await plantSeat(t, {
      org_id: f.org.id,
      org_role: 'user',
      auth_user_id: `auth_${uuid()}`,
      accepted_at: NOW,
    })
    const { subs } = await plantShared(t, f.org.id, f.user, me, { tops: 100, subs: 2 })
    for (const [i, sub] of subs.entries())
      await plantTasks(t, sub, 2, (k) => ({ ...openTask(2 * i + k), assignee_id: me.id }))
    await withReach(t)
    await countOrg(t, f.org.id)
    const { answer, read } = await roadmapRead(t, [me], { kind: 'mine' })
    record('My view of 400 tasks over 200 sub-projects', answer, read)
    expect(answer.state).toBe('ok')
  })

  it('answers My view of a person in 5 teams, each sharing 20 sub-projects', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withReadingAdmin(t)
    const me = await plantSeat(t, {
      org_id: f.org.id,
      org_role: 'user',
      auth_user_id: `auth_${uuid()}`,
      accepted_at: NOW,
    })
    const tops: Doc<'projects'>[] = []
    const subs: Doc<'projects'>[] = []
    for (let k = 0; k < 5; k++) {
      const top = await plantProject(t, {
        org_id: f.org.id,
        lead_id: f.user.id,
        ...named(`Programme ${k}`),
      })
      tops.push(top)
      subs.push(...(await plantSubs(t, top, 20)))
    }
    await t.run(async (ctx) => {
      for (const [k, top] of tops.entries()) {
        const team = uuid()
        await ctx.db.insert('teams', {
          id: team,
          org_id: f.org.id,
          ...named(`Team ${k}`),
          track_delay_default: true,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', {
          team_id: team,
          profile_id: me.id,
          is_leader: false,
          name_key: nameKey(me.name),
        })
        await ctx.db.insert('project_team_access', {
          project_id: top.id,
          team_id: team,
          level: 'user',
          name_key: nameKey(`Team ${k}`),
        })
      }
    })
    for (const [i, sub] of subs.entries())
      await plantTasks(t, sub, 1, () => ({ ...openTask(i), assignee_id: me.id }))
    await withReach(t)
    await countOrg(t, f.org.id)
    const { answer, read } = await roadmapRead(t, [me], { kind: 'mine' })
    record('My view of a person in 5 teams over 100 sub-projects', answer, read)
    expect(answer.state).toBe('ok')
  })

  it("answers the largest My view the ceiling allows, 1,000 of the person's subtasks under 800 parents, every other figure everyday", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withReadingAdmin(t)
    const me = await plantSeat(t, {
      org_id: f.org.id,
      org_role: 'user',
      auth_user_id: `auth_${uuid()}`,
      accepted_at: NOW,
    })
    // It raises one figure, the person's own tasks, which have no design
    // size, to the ceiling that bounds them. They are subtasks under
    // parents of others, so the read takes each parent by id. Every other
    // figure keeps its everyday value: the person is in 3 teams, which
    // share 20 projects of 3 sub-projects in turn, about 20 sub-projects a
    // team, and each sub-project holds 30 open tasks, 17 or 16 of the
    // person's subtasks under 13 or 14 parents
    const { subs } = await plantShared(t, f.org.id, f.user, me, { tops: 20, subs: 3 })
    const firstParents: Doc<'issues'>[] = []
    for (const [i, sub] of subs.entries()) {
      const n = i < 40 ? 17 : 16
      const parents = await plantTasks(t, sub, 30 - n, ordinary)
      if (i === 0) firstParents.push(...parents)
      await plantTasks(t, sub, n, (j) => ({
        ...ordinary(j),
        parent_id: parents[j % parents.length].id,
        assignee_id: me.id,
      }))
    }
    await withReach(t)
    await countOrg(t, f.org.id)
    const mine = await roadmapRead(t, [me], { kind: 'mine' })
    record("My view, 1,000 of the person's subtasks under 800 parents", mine.answer, mine.read)
    expect(stateOf(mine.answer)).toEqual({ state: 'ok', rows: 1000 })
    if (mine.answer.state === 'ok') expect(mine.answer.parents).toHaveLength(800)
    // one more, which its write counts, so the counts bound answers
    await task(t, subs[0], {
      title: ordinary(1).title,
      parent_id: firstParents[0].id,
      assignee_id: me.id,
    })
    const over = await roadmapRead(t, [me], { kind: 'mine' })
    record("My view, 1,001 of the person's subtasks", over.answer, over.read)
    expect(over.answer).toEqual({ state: 'over_ceiling', ceiling: ROADMAP_TASKS })
  })
})

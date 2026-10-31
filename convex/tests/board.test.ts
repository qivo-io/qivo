/* tasks.board, the Board's server read (lib/board.ts on lib/viewReads.ts):
 * its arguments, the selections it answers unavailable alike, a check of
 * the caller's access that a bound stops, the rows it sends, the filters it
 * applies on the server, the lanes it keeps, the search's reads, that its
 * reads follow the selection and not the organization or data the caller
 * cannot see, a reached budget, and real limits under Convex's transaction
 * limits with the figures they read. src/store/boardParity.test.ts compares
 * its answers with the app's own rules. */

import { getDocumentSize } from 'convex/values'
import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { OWN_READS } from '../lib/access'
import { BOARD, type BoardAnswer, type BoardFilters, type BoardScope } from '../lib/board'
import { TEXT_TASK_READS } from '../lib/core'
import { ISSUE_STATUSES } from '../lib/enums'
import { BOARD_TASKS, LIMITS, MIB, NAME_MAX, PROJECT_ROW_MAX_BYTES } from '../lib/limits'
import { named, nameKey } from '../lib/nameKey'
import { ownTasks, type ViewRow, viewAccess, viewBudget } from '../lib/viewReads'
import {
  boardFor,
  boardRead,
  NO_FILTERS,
  plantTasks,
  projectScope,
  type ReadFigures,
  rowIds,
} from './board.setup'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  plantCopiedIssue,
  plantHiddenSibling,
  plantIssue,
  plantLogin,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { withReach } from './projectReach.setup'

const DEFAULT_BOARD = structuredClone(BOARD)
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
const DEFAULT_TEXT_READS = TEXT_TASK_READS.reads
afterEach(() => {
  Object.assign(BOARD, structuredClone(DEFAULT_BOARD))
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
  TEXT_TASK_READS.reads = DEFAULT_TEXT_READS
})

/* The longest title and description the server accepts, in a three-byte
 * script: about 765 bytes and 60 KB stored. */
const TITLE = '€'.repeat(LIMITS.title.max)
const TEXT = '€'.repeat(LIMITS.description.max)

const DAY = 86_400_000
const at = (ms: number) => new Date(ms).toISOString()

/** The answer's rows and parents by title, with the facts a Board shows,
 * so answers of two organizations compare. */
const shape = (answer: BoardAnswer) => {
  if (answer.state !== 'ok') return answer
  const one = (row: ViewRow) => ({
    title: row.title,
    group: row.has_subtasks,
    hiddenSubtasks: row.has_hidden_subtasks,
    hiddenParent: row.has_hidden_parent,
    parent: row.parent_id !== undefined,
    done: row.group_done,
    span: row.span,
  })
  return {
    rows: answer.rows.map(one).sort((a, b) => a.title.localeCompare(b.title)),
    parents: answer.parents.map(one).sort((a, b) => a.title.localeCompare(b.title)),
    held: answer.held_projects.length,
  }
}

/** The answer's state, and its rows' count when ok. */
const stateOf = (answer: BoardAnswer) =>
  answer.state === 'ok' ? { state: 'ok', rows: answer.rows.length } : { state: answer.state }

/* --------------------------------------------------------------- arguments */

describe('arguments', () => {
  it('refuses more than BOARD.owners owners, a search past LIMITS.search and a stale_before that is not an instant, and answers at the bounds', async () => {
    const t = newT()
    const f = await withOrg(t)
    const scope = projectScope(f.guest, f.sub.id)
    const owners = (n: number) => Array.from({ length: n }, () => uuid())
    await expectRefusal(
      boardFor(t, f.guest, scope, { owners: owners(BOARD.owners + 1) }),
      'bad_request',
    )
    await expectRefusal(
      boardFor(t, f.guest, scope, { search: 'a'.repeat(LIMITS.search.max + 1) }),
      'rule',
    )
    await expectRefusal(boardFor(t, f.guest, scope, { stale_before: 'last week' }), 'bad_request')
    const bounds = await boardFor(t, f.guest, scope, {
      owners: owners(BOARD.owners),
      search: 'a'.repeat(LIMITS.search.max),
      stale_before: NOW,
    })
    expect(bounds.state).toBe('ok')
  })
})

/* ------------------------------------------------------------------ access */

describe('access', () => {
  it('answers unavailable alike for every selection it does not hold', async () => {
    const t = newT()
    const f = await withOrg(t)
    const archived = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const notMeta = await plantProject(t, { org_id: f.org.id, type: 'project' })
    const cases: [Doc<'profiles'>, BoardScope][] = [
      [f.guest, projectScope(f.guest, uuid())],
      [f.guest, projectScope(f.guest, f.otherProject.id)],
      [f.guest, projectScope(f.guest, archived.id)],
      [f.guest, projectScope(f.guest, f.hidden.id)],
      // the admin sees every project, and still no Board of one that is not a meta
      [f.admin, projectScope(f.admin, notMeta.id)],
      [f.guest, { kind: 'project', org_id: f.otherOrg.id, project_id: f.otherProject.id }],
    ]
    for (const [who, scope] of cases)
      expect(await boardFor(t, who, scope)).toEqual({ state: 'unavailable' })
    // the guest's own selections answer
    expect((await boardFor(t, f.guest, projectScope(f.guest, f.meta.id))).state).toBe('ok')
  })

  it("answers unavailable with access_unchecked where a bound of the caller's own reads stopped a check, never ok", async () => {
    const t = newT()
    const f = await withOrg(t)
    // FW through a grant, PCB through a team share
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
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, assignee_id: me.id })
    const usual = await boardFor(t, me, projectScope(me, f.meta.id))
    expect(stateOf(usual)).toEqual({ state: 'ok', rows: 1 })
    // the shares on PCB, the caller's own rows and a team asked by itself
    // stop, and navigation to TBED cannot read the caller's shares instead
    Object.assign(OWN_READS, { projectShares: 0, rows: 0, lookups: 0, teamReads: 0, navRows: 0 })
    for (const scope of [
      projectScope(me, f.meta.id),
      projectScope(me, f.sub2.id),
      { kind: 'mine' } as const,
    ])
      expect(await boardFor(t, me, scope)).toEqual({
        state: 'unavailable',
        reason: 'access_unchecked',
        message: expect.stringContaining('could not finish checking which projects you can see'),
      })
  })
})

/* -------------------------------------------------------------------- rows */

describe('rows', () => {
  it("sends no text, even from a task row that holds a rollback's copy, whose real bytes count", async () => {
    const t = newT()
    const f = await withOrg(t)
    const copied = await plantCopiedIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: TEXT,
    })
    const scope = projectScope(f.guest, f.sub.id)
    const withCopy = await boardRead(t, [f.guest], scope)
    if (withCopy.answer.state !== 'ok') throw new Error(withCopy.answer.state)
    expect(withCopy.answer.rows.map((row) => row.id)).toEqual([copied.id])
    expect(withCopy.answer.rows[0]).not.toHaveProperty('description')
    await t.run((ctx) => ctx.db.patch(copied._id, { description: undefined }))
    const cleared = await boardRead(t, [f.guest], scope)
    expect(withCopy.read.mib - cleared.read.mib).toBeGreaterThan(0.05)
  })

  it('sends a parent id only for a parent the caller is shown', async () => {
    const t = newT()
    const f = await withOrg(t)
    const sibling = await plantHiddenSibling(t, f, f.guest)
    const shown = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Shown parent',
    })
    const hidden = await plantIssue(t, {
      org_id: f.org.id,
      project_id: sibling.id,
      title: 'Hidden',
    })
    const under = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: shown.id,
      title: 'Under shown',
      priority: 'high',
    })
    const orphan = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: hidden.id,
      title: 'Under hidden',
      priority: 'high',
    })
    // the parent is a row, and a parent of a row only (priority leaves it out)
    for (const filters of [{}, { priority: 'high' as const }]) {
      const answer = await boardFor(t, f.guest, projectScope(f.guest, f.sub.id), filters)
      if (answer.state !== 'ok') throw new Error(answer.state)
      const byId = new Map([...answer.rows, ...answer.parents].map((row) => [row.id, row]))
      expect(byId.get(under.id)).toMatchObject({ parent_id: shown.id, has_hidden_parent: false })
      expect(byId.get(orphan.id)?.parent_id).toBeUndefined()
      expect(byId.get(orphan.id)?.has_hidden_parent).toBe(true)
      expect(byId.has(hidden.id)).toBe(false)
      expect(byId.get(shown.id)?.has_subtasks).toBe(true)
      expect(answer.parents.map((row) => row.id)).toEqual(filters.priority ? [shown.id] : [])
    }
  })

  it('makes no group of a subtask in an archived project or an archived subtask, and a group of a live hidden one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const sibling = await plantHiddenSibling(t, f, f.guest)
    const archived = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const task = (title: string) => plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title })
    const [inArchived, archivedKid, hiddenKid] = await Promise.all([
      task('Kid in an archived project'),
      task('Archived kid'),
      task('Kid in a hidden project'),
    ])
    await plantIssue(t, { org_id: f.org.id, project_id: archived.id, parent_id: inArchived.id })
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: archivedKid.id,
      archived_at: NOW,
    })
    await plantIssue(t, { org_id: f.org.id, project_id: sibling.id, parent_id: hiddenKid.id })
    const answer = await boardFor(t, f.guest, projectScope(f.guest, f.sub.id))
    if (answer.state !== 'ok') throw new Error(answer.state)
    const byTitle = new Map(answer.rows.map((row) => [row.title, row]))
    expect(byTitle.get('Kid in an archived project')).toMatchObject({ has_subtasks: false })
    expect(byTitle.get('Archived kid')).toMatchObject({ has_subtasks: false })
    expect(byTitle.get('Kid in a hidden project')).toMatchObject({
      has_subtasks: true,
      has_hidden_subtasks: true,
      group_done: false,
      span: { partial: true },
    })
  })
})

/* ----------------------------------------------------------------- filters */

describe('filters', () => {
  it('Stale: a task updated at stale_before is not stale, a Done task never is, nor a group with a recent shown subtask or one whose shown leaves are all Done', async () => {
    const t = newT()
    const f = await withOrg(t)
    const cutoff = Date.parse(NOW)
    const old = at(cutoff - 10 * DAY)
    const recent = at(cutoff + DAY)
    const task = (title: string, fields: Partial<Doc<'issues'>> = {}) =>
      plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title, updated_at: old, ...fields })
    await task('At the cutoff', { updated_at: NOW })
    await task('Old')
    await task('Old and done', { status: 'done' })
    const fresh = await task('Group with a recent subtask')
    await task('Recent subtask', { parent_id: fresh.id, updated_at: recent })
    const finished = await task('Group of done leaves')
    await task('Done leaf', { parent_id: finished.id, status: 'done' })
    const stale = await task('Stale group')
    await task('Old leaf', { parent_id: stale.id })
    const answer = await boardFor(t, f.guest, projectScope(f.guest, f.sub.id), {
      stale_before: NOW,
    })
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.rows.map((row) => row.title).sort()).toEqual(['Old', 'Old leaf', 'Stale group'])
  })

  it('reads no Backlog or Done range under Focus with a filter Clear clears', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantTasks(t, f.sub, 400, (i) => ({ status: i % 2 === 0 ? 'backlog' : 'done' }), 200)
    await plantTasks(t, f.sub, 3, () => ({ priority: 'high' }))
    const scope = projectScope(f.guest, f.sub.id)
    const focus = await boardRead(t, [f.guest], scope, { focus: true, priority: 'high' })
    expect(stateOf(focus.answer)).toEqual({ state: 'ok', rows: 3 })
    expect(focus.read.documents).toBeLessThan(100)
    const whole = await boardRead(t, [f.guest], scope, { priority: 'high' })
    expect(stateOf(whole.answer)).toEqual({ state: 'ok', rows: 3 })
    expect(whole.read.documents).toBeGreaterThan(400)
  })

  it('finds under Focus a task that carries done_at against the rule, past a step of its status range too', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantTasks(t, f.sub, 150, () => ({}))
    const stamped = await plantTasks(t, f.sub, 2, (i) => ({
      status: i === 0 ? 'todo' : 'progress',
      done_at: NOW,
    }))
    const answer = await boardFor(t, f.guest, projectScope(f.guest, f.sub.id), { focus: true })
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.rows).toHaveLength(152)
    for (const task of stamped) expect(answer.rows.some((row) => row.id === task.id)).toBe(true)
  })

  it('leaves out under Focus a group stored in Backlog or Done, which a To do subtask shows as its parent, in a project and in My view', async () => {
    const t = newT()
    const f = await withOrg(t)
    const assignee_id = f.guest.id
    const task = (title: string, fields: Partial<Doc<'issues'>> = {}) =>
      plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title, assignee_id, ...fields })
    const backlog = await task('Backlog group', { status: 'backlog' })
    const shown = await task('To do subtask', { parent_id: backlog.id })
    const done = await task('Done group', { status: 'done' })
    const finished = await task('Done subtask', { parent_id: done.id, status: 'done' })
    for (const [scope, filters] of [
      [projectScope(f.guest, f.sub.id), {}],
      [{ kind: 'mine' }, { mine: true }],
    ] as [BoardScope, Partial<BoardFilters>][]) {
      const focus = await boardFor(t, f.guest, scope, { ...filters, focus: true })
      if (focus.state !== 'ok') throw new Error(focus.state)
      expect(focus.rows.map((row) => row.id)).toEqual([shown.id])
      expect(focus.parents.map((row) => row.id)).toEqual([backlog.id])
      expect(focus.parents[0]).toMatchObject({ has_subtasks: true, group_done: false })
      const all = await boardFor(t, f.guest, scope, filters)
      expect(rowIds(all)).toEqual([backlog.id, shown.id, done.id, finished.id])
    }
  })

  it('steps under Focus through each status and its rows that carry done_at against the rule, and answers each planted task once', async () => {
    const t = newT()
    const f = await withOrg(t)
    // done_at in the reverse of creation order, as only a step that goes on
    // by done_at reads them all
    const stamp = (i: number) => at(Date.parse(NOW) - i * DAY)
    const planted = [
      ...(await plantTasks(t, f.sub, 20, () => ({ status: 'progress' }))),
      ...(await plantTasks(t, f.sub, 50, (i) => ({
        status: 'review',
        ...(i < 40 ? { done_at: stamp(i) } : {}),
      }))),
      ...(await plantTasks(t, f.sub, 20, (i) => ({
        status: 'todo',
        ...(i % 3 === 0 ? { done_at: stamp(i) } : {}),
      }))),
    ]
    await plantTasks(t, f.sub, 10, (i) => ({ status: i % 2 === 0 ? 'backlog' : 'done' }))
    // a room of a few rows a step, so steps end inside each status and each
    // kind of row
    BOARD.reads.bytes = 800 * 1024
    const { answer } = await boardRead(t, [f.guest], projectScope(f.guest, f.sub.id), {
      focus: true,
    })
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.rows.map((row) => row.id).sort()).toEqual(planted.map((task) => task.id).sort())
  })

  it("applies My tasks through the person's own ranges and keeps only the selection's tasks", async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantTasks(t, f.sub, 300, () => ({ assignee_id: f.user.id }))
    const mine = await plantTasks(t, f.sub, 3, () => ({ assignee_id: f.guest.id }))
    await plantTasks(t, f.sub2, 2, () => ({ assignee_id: f.guest.id }))
    const own = await boardRead(t, [f.guest], projectScope(f.guest, f.sub.id), { mine: true })
    expect(rowIds(own.answer)).toEqual(mine.map((task) => task.id))
    expect(own.read.documents).toBeLessThan(100)
  })
  it('narrows My view by the people filter too, the person being the selection', async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await plantLogin(t, f.user)
    const handed = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'review',
      assignee_id: me.id,
      reviewer_id: f.guest.id,
    })
    const own = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, assignee_id: me.id })
    const mine = { kind: 'mine' } as const
    expect(rowIds(await boardFor(t, me, mine, { mine: true }))).toEqual([own.id])
    expect(rowIds(await boardFor(t, me, mine, { mine: true, owners: [me.id] }))).toEqual([own.id])
    // the task handed to review is the reviewer's, so no filter brings it back
    expect(rowIds(await boardFor(t, me, mine, { mine: true, owners: [f.guest.id] }))).toEqual([])
    expect(handed.id).not.toBe(own.id)
  })
})

/* ------------------------------------------------------------------- lanes */

describe('lanes', () => {
  it('keeps under Focus alone a sub-project with only Backlog tasks, and with a filter Clear clears does not', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, status: 'backlog' })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, priority: 'high' })
    const scope = projectScope(f.guest, f.meta.id)
    const focus = await boardFor(t, f.guest, scope, { focus: true })
    expect(focus).toMatchObject({ state: 'ok', held_projects: [f.sub.id, f.sub2.id] })
    if (focus.state === 'ok') expect(focus.rows).toHaveLength(1)
    for (const filters of [{ priority: 'high' as const }, { search: 'planted' }, { mine: true }])
      expect(await boardFor(t, f.guest, scope, { focus: true, ...filters })).toMatchObject({
        state: 'ok',
        held_projects: filters.mine ? [] : [f.sub2.id],
      })
  })

  it('keeps in My view under Focus alone a top-level project where the person holds only Done tasks', async () => {
    const t = newT()
    const f = await withOrg(t)
    const skunk = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const me = await plantLogin(t, f.user)
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      assignee_id: me.id,
    })
    await plantIssue(t, { org_id: f.org.id, project_id: skunk.id, assignee_id: me.id })
    const focus = await boardFor(t, me, { kind: 'mine' }, { mine: true, focus: true })
    expect(focus).toMatchObject({ state: 'ok', held_projects: [f.meta.id, f.hidden.id].sort() })
    if (focus.state === 'ok') expect(focus.rows).toHaveLength(1)
    expect(
      await boardFor(t, me, { kind: 'mine' }, { mine: true, focus: true, priority: 'medium' }),
    ).toMatchObject({ state: 'ok', held_projects: [f.hidden.id] })
  })
})

/* ------------------------------------------------------------------ search */

describe('search', () => {
  it('reads the texts of a few candidates of a large project one by one, not its other texts', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // urgent tasks first and last, the project's large texts between them
    await plantTasks(t, f.sub, 2, () => ({ priority: 'urgent', text: 'the quokka ledger' }))
    await plantTasks(t, f.sub, 600, () => ({ text: TEXT }), 100)
    await plantTasks(t, f.sub, 2, () => ({ priority: 'urgent', text: 'nothing here' }))
    const { answer, read } = await boardRead(t, [f.guest], projectScope(f.guest, f.sub.id), {
      priority: 'urgent',
      search: 'quokka',
    })
    expect(stateOf(answer)).toEqual({ state: 'ok', rows: 2 })
    expect(read.mib).toBeLessThan(4)
  }, 120_000)

  it("reads a whole selection's texts many to a range", async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantTasks(t, f.sub, 300, (i) => ({
      text: i === 150 ? 'the quokka ledger' : 'plain words',
    }))
    const { answer, read } = await boardRead(t, [f.guest], projectScope(f.guest, f.sub.id), {
      search: 'quokka',
    })
    expect(stateOf(answer)).toEqual({ state: 'ok', rows: 1 })
    // a range a task would read about 600 ranges
    expect(read.ranges).toBeLessThan(400)
  })

  it('reads labels through the candidates own rows, by one label or by the task', async () => {
    const t = newT()
    const f = await withOrg(t)
    const label = (name: string) =>
      t.run(async (ctx) => {
        const id = uuid()
        await ctx.db.insert('labels', {
          id,
          org_id: f.org.id,
          name,
          name_lower: name.toLowerCase(),
          color: '#336699',
          created_at: NOW,
        })
        return id
      })
    const [one, two, other] = await Promise.all([
      label('Quartz'),
      label('Quartzite'),
      label('Basalt'),
    ])
    const tasks = await plantTasks(t, f.sub, 3)
    await t.run(async (ctx) => {
      for (const [task, labelId] of [
        [tasks[0], one],
        [tasks[1], two],
        [tasks[2], other],
      ] as const)
        await ctx.db.insert('issue_labels', {
          org_id: f.org.id,
          issue_id: task.id,
          label_id: labelId,
        })
    })
    const scope = projectScope(f.guest, f.sub.id)
    expect(rowIds(await boardFor(t, f.guest, scope, { search: 'quartz' })).length).toBe(2)
    expect(rowIds(await boardFor(t, f.guest, scope, { search: 'quartzite' }))).toEqual([
      tasks[1].id,
    ])
    expect(rowIds(await boardFor(t, f.guest, scope, { search: 'basalt' }))).toEqual([tasks[2].id])
  })
})

describe('search, labels and a status a group does not search', () => {
  /** A label of `f`'s organization named `name`. */
  const labelIn = async (t: T, orgId: string, name: string) => {
    const id = uuid()
    await t.run((ctx) =>
      ctx.db.insert('labels', {
        id,
        org_id: orgId,
        name,
        name_lower: name.toLowerCase(),
        color: '#336699',
        created_at: NOW,
      }),
    )
    return id
  }

  for (const [status, words, statusLabel, otherLabel] of [
    ['todo', 'to quartz', 'To', 'Quartz'],
    ['done', 'done bug', 'Done', 'Bug'],
  ] as const)
    it(`finds a group stored ${status} with labels ${statusLabel} and ${otherLabel} by "${words}", whose dormant status holds no word`, async () => {
      const t = newT()
      const f = await withOrg(t)
      const [byStatus, other] = [
        await labelIn(t, f.org.id, statusLabel),
        await labelIn(t, f.org.id, otherLabel),
      ]
      const task = (title: string, fields: Partial<Doc<'issues'>> = {}) =>
        plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title, ...fields })
      // titles that hold neither word
      const group = await task('Mount kit', { status })
      await task('Bracket', { parent_id: group.id })
      const bare = await task('Hinge set', { status })
      await task('Pin', { parent_id: bare.id })
      const leaf = await task('Mount plate', { status })
      await t.run(async (ctx) => {
        for (const [issue, label] of [
          [group, byStatus],
          [group, other],
          [bare, other],
          [leaf, other],
        ] as const)
          await ctx.db.insert('issue_labels', {
            org_id: f.org.id,
            issue_id: issue.id,
            label_id: label,
          })
      })
      const answer = await boardFor(t, f.guest, projectScope(f.guest, f.sub.id), { search: words })
      // the group through its two labels, the leaf through its status and
      // one label; the group with one label holds no word for its status
      expect(rowIds(answer)).toEqual([group.id, leaf.id])
    })
})

/* ------------------------------------------- reads follow the selection */

describe('reads', () => {
  it('read the same for a 50-task Board in an organization with 100 or 10,000 tasks elsewhere', async () => {
    const figures: ReadFigures[] = []
    for (const elsewhere of [100, 10_000]) {
      const t = newT()
      const f = await withOrg(t)
      await plantTasks(t, f.sub, 50, (i) => ({ title: `Board task ${i}` }))
      await plantTasks(t, f.sub2, elsewhere, () => ({}), 1000)
      const { answer, read } = await boardRead(t, [f.guest], projectScope(f.guest, f.sub.id), {
        search: 'board',
      })
      expect(stateOf(answer)).toEqual({ state: 'ok', rows: 50 })
      figures.push(read)
    }
    expect(figures[1].documents).toBe(figures[0].documents)
    expect(figures[1].ranges).toBe(figures[0].ranges)
  }, 120_000)
})

/* ------------------------------------------------------------- hidden data */

/** The withOrg fixture with a sibling sub-project of FW and PCB that the
 * guest cannot see, and in FW a group whose subtask is in the sibling, a
 * subtask whose parent is in the sibling, and 30 tasks one search word finds
 * by their texts and a label. `wide` makes the hidden rows large: the
 * subtask's title, the parent's title and the copy a rollback writes on it,
 * and the sibling's description, and gives the hidden tasks the label. */
async function hiddenOrg(wide: boolean) {
  const t = newT()
  const f = await withOrg(t)
  const sibling = await plantHiddenSibling(t, f, f.guest)
  const labelId = uuid()
  await t.run(async (ctx) => {
    if (wide)
      await ctx.db.patch(sibling._id, { description: '一'.repeat(LIMITS.projectDescription.max) })
    await ctx.db.insert('labels', {
      id: labelId,
      org_id: f.org.id,
      name: 'Quartz',
      name_lower: 'quartz',
      color: '#336699',
      created_at: NOW,
    })
  })
  // the guest's own, so My view reads the hidden ones too
  const assignee_id = f.guest.id
  const group = await plantIssue(t, {
    org_id: f.org.id,
    project_id: f.sub.id,
    title: 'Quartz group',
    assignee_id,
  })
  const kid = await plantIssue(t, {
    org_id: f.org.id,
    project_id: sibling.id,
    parent_id: group.id,
    title: wide ? TITLE : 'k',
    assignee_id,
  })
  const parent = await (wide ? plantCopiedIssue : plantIssue)(t, {
    org_id: f.org.id,
    project_id: sibling.id,
    title: wide ? TITLE : 'p',
    description: wide ? TEXT : '',
    assignee_id,
  })
  await plantIssue(t, {
    org_id: f.org.id,
    project_id: f.sub.id,
    parent_id: parent.id,
    title: 'Under a hidden parent',
    assignee_id,
  })
  const found = await plantTasks(t, f.sub, 30, (i) => ({
    text: i % 3 === 0 ? 'a quartz vein' : 'clay',
  }))
  await t.run(async (ctx) => {
    for (const task of [found[1], ...(wide ? [kid, parent] : [])])
      await ctx.db.insert('issue_labels', {
        org_id: f.org.id,
        issue_id: task.id,
        label_id: labelId,
      })
  })
  // navigation reads reach rows, as on every deployment since v0.1.97,
  // not a parent's sub-projects
  await withReach(t)
  return { t, f }
}

/** The smallest BOARD.reads.bytes at which `read` answers ok. */
async function leastBytes(read: () => Promise<BoardAnswer>): Promise<number> {
  let low = 0
  let high = DEFAULT_BOARD.reads.bytes
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2)
    BOARD.reads.bytes = mid
    if ((await read()).state === 'ok') high = mid
    else low = mid
  }
  BOARD.reads.bytes = DEFAULT_BOARD.reads.bytes
  return high
}

describe('hidden data', () => {
  it("answers the same, and stops at the same budget, whatever the hidden rows' sizes and labels", async () => {
    const narrow = await hiddenOrg(false)
    const wide = await hiddenOrg(true)
    for (const [scope, filters] of [
      ['TBED', {}],
      ['TBED', { search: 'quartz' }],
      ['FW', { search: 'quartz' }],
      ['My view', { search: 'under' }],
    ] as [string, Partial<BoardFilters>][]) {
      const read = (o: typeof narrow) => () =>
        boardFor(
          o.t,
          o.f.guest,
          scope === 'My view'
            ? { kind: 'mine' }
            : projectScope(o.f.guest, scope === 'TBED' ? o.f.meta.id : o.f.sub.id),
          scope === 'My view' ? { ...filters, mine: true } : filters,
        )
      expect(shape(await read(wide)()), `${scope} ${JSON.stringify(filters)}`).toEqual(
        shape(await read(narrow)()),
      )
      const least = await leastBytes(read(narrow))
      expect(least, `${scope} ${JSON.stringify(filters)}`).toBe(await leastBytes(read(wide)))
      BOARD.reads.bytes = least - 1
      expect((await read(wide)()).state).toBe('over_budget')
      BOARD.reads.bytes = DEFAULT_BOARD.reads.bytes
    }
  }, 300_000)
})

/** A meta of `n` sub-projects whose reader sees it only to navigate to the
 * even ones, their grants, with a task in each of those; `wide` gives the
 * odd ones, which the reader cannot see, descriptions at the cap. The
 * sub-projects pass a step of their range, so a step goes on from a row the
 * reader cannot see. */
async function navigatedOrg(n: number, wide: boolean) {
  const t = newT()
  const f = await withOrg(t)
  const me = await plantLogin(t, await plantSeat(t, { org_id: f.org.id, accepted_at: NOW }))
  const meta = await plantProject(t, { org_id: f.org.id })
  const subs: Doc<'projects'>[] = []
  for (let i = 0; i < n; i++)
    subs.push(
      await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: meta.id,
        ...(wide && i % 2 === 1 ? { description: '一'.repeat(LIMITS.projectDescription.max) } : {}),
      }),
    )
  await t.run(async (ctx) => {
    for (const [i, sub] of subs.entries())
      if (i % 2 === 0)
        await ctx.db.insert('project_access', {
          project_id: sub.id,
          profile_id: me.id,
          level: 'user',
        })
  })
  for (const [i, sub] of subs.entries())
    if (i % 2 === 0) await plantTasks(t, sub, 1, () => ({ title: `Task in ${i}` }))
  await withReach(t)
  return { t, me, meta }
}

describe('hidden data, past a step of sub-projects and own tasks', () => {
  it("answers the same, and stops at the same budget, whatever the sizes of a navigated meta's hidden sub-projects", async () => {
    const narrow = await navigatedOrg(70, false)
    const wide = await navigatedOrg(70, true)
    const read = (o: typeof narrow) => () => boardFor(o.t, o.me, projectScope(o.me, o.meta.id))
    expect(shape(await read(wide)())).toEqual(shape(await read(narrow)()))
    expect(stateOf(await read(narrow)())).toEqual({ state: 'ok', rows: 35 })
    const least = await leastBytes(read(narrow))
    expect(least).toBe(await leastBytes(read(wide)))
    BOARD.reads.bytes = least - 1
    expect((await read(wide)()).state).toBe('over_budget')
  }, 300_000)

  it("counts a person's own task they are shown at its real size each time a read returns it, in a later step too", async () => {
    const t = newT()
    const f = await withOrg(t)
    // assigned to and reviewed by the guest, read in the assignee's review
    // range and again in the reviewer range, a step later
    const task = await plantCopiedIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'review',
      assignee_id: f.guest.id,
      reviewer_id: f.guest.id,
      description: TEXT,
    })
    const reads = { bytes: 300 * 1024, documents: 24_000, ranges: 3600 }
    const { got, projects, bytes } = await t.run(async (ctx) => {
      const guard = viewBudget(ctx, reads)
      const seat = viewAccess(ctx, guard, f.guest)
      const got: string[] = []
      for await (const step of ownTasks(ctx, guard, seat, ISSUE_STATUSES))
        got.push(...step.map((one) => one.id))
      // the project rows the access read, each charged at its fixed size
      const projects = await Promise.all(
        [f.sub, f.meta].map(async (p) =>
          getDocumentSize((await ctx.db.get(p._id)) as Doc<'projects'>),
        ),
      )
      return { got, projects, bytes: guard.ceiling.bytes }
    })
    expect(got).toEqual([task.id])
    // only the projects' fixed charges move the decisions' bytes
    expect(bytes).toBe(
      reads.bytes - projects.reduce((n, size) => n + PROJECT_ROW_MAX_BYTES - size, 0),
    )
  })
})

/* -------------------------------------------------------- a reached budget */

describe('a reached budget', () => {
  it('answers over_ceiling where it found the ceiling passed within the budget, else over_budget, and never ok with fewer rows', async () => {
    const t = newT()
    const f = await withOrg(t)
    const tasks = await plantTasks(t, f.sub, BOARD_TASKS + 1, () => ({}), 500)
    const scope = projectScope(f.guest, f.sub.id)
    const usual = await boardRead(t, [f.guest], scope)
    expect(usual.answer.state).toBe('over_ceiling')
    /* the states over budgets from none to the reads the default took, on
     * one count of BOARD.reads */
    const sweep = async (key: 'documents' | 'ranges' | 'bytes', most: number) => {
      const states = new Set<string>()
      for (let step = 0; step <= 20; step++) {
        BOARD.reads[key] = Math.floor((most * step) / 20)
        const { answer } = await boardRead(t, [f.guest], scope)
        states.add(answer.state === 'ok' ? `ok ${answer.rows.length}` : answer.state)
      }
      BOARD.reads[key] = DEFAULT_BOARD.reads[key]
      return states
    }
    for (const [key, most] of [
      ['documents', usual.read.documents],
      ['ranges', usual.read.ranges],
      ['bytes', usual.read.mib * MIB],
    ] as const)
      expect(await sweep(key, most * 2), key).toEqual(new Set(['over_budget', 'over_ceiling']))
    // one task fewer fits, and no budget answers it with fewer rows
    await t.run(async (ctx) => {
      await ctx.db.patch(tasks[0]._id, { archived_at: NOW })
    })
    const fits = await boardRead(t, [f.guest], scope)
    expect(stateOf(fits.answer)).toEqual({ state: 'ok', rows: BOARD_TASKS })
    for (const [key, most] of [
      ['documents', fits.read.documents],
      ['ranges', fits.read.ranges],
      ['bytes', fits.read.mib * MIB],
    ] as const)
      expect(await sweep(key, most * 2), key).toEqual(new Set(['over_budget', `ok ${BOARD_TASKS}`]))
  }, 300_000)

  it('answers over_budget for a search whose candidates hold texts at the cap, never a partial ok', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    await plantTasks(
      t,
      f.sub,
      400,
      (i) => ({ text: i === 399 ? `${TEXT.slice(6)} quokka` : TEXT }),
      100,
    )
    const answer = await boardFor(t, f.guest, projectScope(f.guest, f.sub.id), { search: 'quokka' })
    expect(answer).toEqual({ state: 'over_budget', projects: [f.sub.id] })
  }, 120_000)

  it('answers over_budget past BOARD.context groups and parents', async () => {
    const t = newT()
    const f = await withOrg(t)
    const groups = await plantTasks(t, f.sub, 5)
    await plantTasks(t, f.sub, 5, (i) => ({ parent_id: groups[i].id, title: `Leaf ${i}` }))
    const scope = projectScope(f.guest, f.sub.id)
    for (const filters of [{}, { search: 'leaf' }]) {
      // as groups among the rows, and as the parents of the leaves a search keeps
      BOARD.context = 5
      expect(stateOf(await boardFor(t, f.guest, scope, filters))).toEqual({
        state: 'ok',
        rows: filters.search === undefined ? 10 : 5,
      })
      BOARD.context = 4
      expect(await boardFor(t, f.guest, scope, filters)).toEqual({
        state: 'over_budget',
        projects: [f.sub.id],
      })
    }
  })
})

/* ------------------------------------------------------------- real limits */

/** The reads of each real-limit case, printed for the report and the
 * figures in BOARD's docstring. */
const FIGURES: Record<string, ReadFigures & { state: string }> = {}
const record = (name: string, answer: BoardAnswer, read: ReadFigures) => {
  FIGURES[name] = { state: stateOf(answer).state, ...read }
  console.log(`board figures, ${name}:`, JSON.stringify(FIGURES[name]))
}

/** Archives `task` as a raw write, its description row with it. */
const archive = (t: T, task: Doc<'issues'>) =>
  t.run(async (ctx) => {
    await ctx.db.patch(task._id, { archived_at: NOW })
    const row = await ctx.db
      .query('issue_descriptions')
      .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
      .first()
    if (row !== null) await ctx.db.patch(row._id, { archived_at: NOW })
  })

/** A task at the caps: its title, and its description row's text. */
const atCaps = { title: TITLE, text: TEXT }

/* Real sentences in a three-byte script, for the texts a search reads and
 * for realistic titles. None holds a word the cases search for. */
const SENTENCES = [
  'センサーの値が朝から少しずつ上がっているので原因を調べる。',
  '試作基板の電源回路を見直し、発熱の少ない部品に替える。',
  '組み立て手順書を更新して、新しい治具の使い方を書き加える。',
  '来週の出荷に向けて検査項目を整理し、担当者と日程を決める。',
  '画面の文字が小さすぎるという声があったので表示を大きくする。',
  '通信が途切れる不具合は再起動の順番に関係しているようだ。',
  '部品の納期が遅れているため、代わりの仕入れ先を探している。',
  '試験結果を表にまとめて、前回との違いを分かりやすく示す。',
  '設定画面の項目が多いので、よく使うものだけを最初に並べる。',
  '静かな部屋で騒音を測り、ファンの回転数との関係を確かめる。',
  '古い資料と新しい図面の食い違いを洗い出して直しておく。',
  '顧客からの問い合わせに答えるため、仕様書の該当箇所を探す。',
]

/** `length` characters of SENTENCES from sentence `from` on. */
const words = (from: number, length: number): string => {
  let s = ''
  for (let k = from; s.length < length; k++) s += SENTENCES[k % SENTENCES.length]
  return s.slice(0, length)
}

/** The real-limits searches' texts: 390 characters, the measured average. */
const TEXT_CHARS = 390

/** The word the real-limits searches look for, in no sentence. */
const RARE = 'クオッカ'

/** A name at the cap in a three-byte script, distinct for each `i`: an
 * ideograph for `i`, then 班. No ideograph has an NFKD form, so the name key
 * keeps every byte. */
const nameAtCap = (i: number) => String.fromCodePoint(0x4e00 + i) + '班'.repeat(NAME_MAX - 1)

/** `n` sub-projects of `parent` as model/projects.ts writes them: a name at
 * the cap with its key, `parent`'s lead and a live archive state. */
async function plantSubs(t: T, parent: Doc<'projects'>, n: number): Promise<Doc<'projects'>[]> {
  const subs: Doc<'projects'>[] = []
  for (let i = 0; i < n; i++)
    subs.push(
      await plantProject(t, {
        org_id: parent.org_id,
        type: 'project',
        parent_id: parent.id,
        ...named(nameAtCap(i)),
        lead_id: parent.lead_id,
        archive_state: 'live',
      }),
    )
  return subs
}

/** Gives `tasks` the label `labelId`, as model/labels.ts setTaskLabel
 * writes an assignment, with the task's window key. */
const labelAll = async (t: T, labelId: string, tasks: readonly Doc<'issues'>[]) => {
  for (let from = 0; from < tasks.length; from += 2000)
    await t.run(async (ctx) => {
      for (const task of tasks.slice(from, from + 2000))
        await ctx.db.insert('issue_labels', {
          org_id: task.org_id,
          issue_id: task.id,
          label_id: labelId,
          task_key: task.window_key,
        })
    })
}

describe('real limits', () => {
  it('answers 999 and 1,000 matching tasks of one sub-project and over_ceiling at 1,001, inside Convex limits', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const tasks = await plantTasks(t, f.sub, BOARD_TASKS + 1, () => atCaps, 200)
    const scope = projectScope(f.guest, f.sub.id)
    const over = await boardRead(t, [f.guest], scope)
    record('1,001 tasks of one sub-project', over.answer, over.read)
    expect(over.answer).toEqual({
      state: 'over_ceiling',
      ceiling: BOARD_TASKS,
      projects: [f.sub.id],
    })
    await archive(t, tasks[0])
    const full = await boardRead(t, [f.guest], scope)
    record('1,000 tasks of one sub-project', full.answer, full.read)
    expect(stateOf(full.answer)).toEqual({ state: 'ok', rows: 1000 })
    await archive(t, tasks[1])
    const under = await boardRead(t, [f.guest], scope)
    record('999 tasks of one sub-project', under.answer, under.read)
    expect(stateOf(under.answer)).toEqual({ state: 'ok', rows: 999 })
    const focus = await boardRead(t, [f.guest], scope, { focus: true })
    record('999 tasks of one sub-project, Focus', focus.answer, focus.read)
    expect(stateOf(focus.answer)).toEqual({ state: 'ok', rows: 999 })
  }, 600_000)

  it('answers 1,000 matching tasks over 200 sub-projects of one project and over_ceiling at one more', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const subs = await plantSubs(t, f.meta, 200)
    for (const sub of subs) await plantTasks(t, sub, 5, () => atCaps)
    const scope = projectScope(f.guest, f.meta.id)
    const full = await boardRead(t, [f.guest], scope)
    record('1,000 tasks over 200 sub-projects', full.answer, full.read)
    expect(stateOf(full.answer)).toEqual({ state: 'ok', rows: 1000 })
    const focus = await boardRead(t, [f.guest], scope, { focus: true })
    record('1,000 tasks over 200 sub-projects, Focus', focus.answer, focus.read)
    expect(stateOf(focus.answer)).toEqual({ state: 'ok', rows: 1000 })
    await plantTasks(t, subs[199], 1, () => atCaps)
    const over = await boardRead(t, [f.guest], scope)
    record('1,001 tasks over 200 sub-projects', over.answer, over.read)
    expect(over.answer.state).toBe('over_ceiling')
  }, 600_000)

  it('answers the 1,000 of 1,001 candidates that match a priority filter', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    await plantTasks(
      t,
      f.sub,
      BOARD_TASKS + 1,
      (i) => ({ ...atCaps, priority: i === 500 ? 'low' : 'high' }),
      200,
    )
    const { answer, read } = await boardRead(t, [f.guest], projectScope(f.guest, f.sub.id), {
      priority: 'high',
    })
    record('1,000 of 1,001 by priority', answer, read)
    expect(stateOf(answer)).toEqual({ state: 'ok', rows: 1000 })
  }, 600_000)

  it("counts My view's ceiling across the home and a guest seat", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // the guest's login holds a guest seat in the other organization too
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
    await plantTasks(t, f.sub, 600, () => ({ ...atCaps, assignee_id: f.guest.id }), 200)
    const awayTasks = await plantTasks(
      t,
      awaySub,
      401,
      () => ({ ...atCaps, assignee_id: away.id }),
      200,
    )
    const over = await boardRead(t, [f.guest, away], { kind: 'mine' })
    record('My view, 600 and 401 tasks in two seats', over.answer, over.read)
    expect(over.answer).toEqual({ state: 'over_ceiling', ceiling: BOARD_TASKS })
    await archive(t, awayTasks[0])
    const full = await boardRead(t, [f.guest, away], { kind: 'mine' })
    record('My view, 600 and 400 tasks in two seats', full.answer, full.read)
    expect(stateOf(full.answer)).toEqual({ state: 'ok', rows: 1000 })
    // the query takes the login's seats itself
    expect(
      stateOf(
        await as(t, f.guest).query(api.tasks.board, {
          scope: { kind: 'mine' },
          filters: NO_FILTERS,
        }),
      ),
    ).toEqual({ state: 'ok', rows: 1000 })
  }, 600_000)

  it('counts no group in the ceiling: 1,000 tasks under 50 groups fit, and past BOARD.context groups it answers over_budget', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const groups = await plantTasks(t, f.sub, 50, () => atCaps)
    await plantTasks(t, f.sub, 1000, (i) => ({ ...atCaps, parent_id: groups[i % 50].id }), 200)
    const scope = projectScope(f.guest, f.sub.id)
    const { answer, read } = await boardRead(t, [f.guest], scope)
    record('1,000 tasks under 50 groups', answer, read)
    expect(stateOf(answer)).toEqual({ state: 'ok', rows: 1050 })
    BOARD.context = 49
    expect((await boardRead(t, [f.guest], scope)).answer.state).toBe('over_budget')
  }, 600_000)

  it("answers My tasks on a selection too large to read whole, through the person's own ranges", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    await plantTasks(t, f.sub, 12_000, () => ({ title: TITLE }), 1000)
    await plantTasks(t, f.sub, 5, () => ({ ...atCaps, assignee_id: f.guest.id }))
    const scope = projectScope(f.guest, f.sub.id)
    const mine = await boardRead(t, [f.guest], scope, { mine: true })
    record('My tasks of 12,005 tasks', mine.answer, mine.read)
    expect(stateOf(mine.answer)).toEqual({ state: 'ok', rows: 5 })
    // the people filter reads the selection's ranges, whose rows pass the budget
    const owners = await boardRead(t, [f.guest], scope, { owners: [f.guest.id] })
    record('the people filter on 12,005 tasks', owners.answer, owners.read)
    expect(owners.answer.state).toBe('over_budget')
  }, 600_000)

  /* A search for RARE over 5,000 tasks of FW titled `title(i)`, with texts
   * of TEXT_CHARS, every 100th from the 7th ending in RARE */
  const searchOf5000 = async (title: (i: number) => string) => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    await plantTasks(
      t,
      f.sub,
      5000,
      (i) => ({
        title: title(i),
        text: i % 100 === 7 ? `${words(i, TEXT_CHARS - RARE.length)}${RARE}` : words(i, TEXT_CHARS),
      }),
      1000,
    )
    const scope = projectScope(f.guest, f.sub.id)
    return { ...(await boardRead(t, [f.guest], scope, { search: RARE })), f }
  }

  it('answers over_budget for a search of 5,000 tasks with titles at the cap and 390-character texts', async () => {
    const { answer, read, f } = await searchOf5000(() => TITLE)
    record('a search of 5,000 tasks, titles at the cap', answer, read)
    expect(answer).toEqual({ state: 'over_budget', projects: [f.sub.id] })
  }, 600_000)

  it('searches 5,000 tasks with realistic titles and 390-character texts', async () => {
    const { answer, read } = await searchOf5000((i) => words(i + 5, 40 + (i % 21)))
    record('a search of 5,000 tasks, realistic titles', answer, read)
    expect(stateOf(answer)).toEqual({ state: 'ok', rows: 50 })
  }, 600_000)

  it('answers a filter that keeps one subtask under each of 400 parents of ten, in a project and in My view, without a check of each sibling', async () => {
    /* 400 parents in FW with ten subtasks each, one of them the guest's
     * and urgent, created at `created_at` */
    const plant = async (created_at: string) => {
      const t = newT({ transactionLimits: true })
      const f = await withOrg(t)
      const parents = await plantTasks(t, f.sub, 400, () => ({ title: TITLE, created_at }), 400)
      await plantTasks(
        t,
        f.sub,
        4000,
        (i) => ({
          title: TITLE,
          created_at,
          parent_id: parents[Math.floor(i / 10)].id,
          ...(i % 10 === 0 ? { priority: 'urgent', assignee_id: f.guest.id } : {}),
        }),
        1000,
      )
      return { t, f }
    }
    const recent = await plant('2026-10-31T09:00:00.000Z')
    const scope = projectScope(recent.f.guest, recent.f.sub.id)
    const urgent = await boardRead(recent.t, [recent.f.guest], scope, { priority: 'urgent' })
    record('one urgent subtask under each of 400 parents of ten', urgent.answer, urgent.read)
    const mine = await boardRead(recent.t, [recent.f.guest], { kind: 'mine' }, { mine: true })
    record('My view of one subtask under each of 400 parents of ten', mine.answer, mine.read)
    for (const { answer } of [urgent, mine]) {
      expect(stateOf(answer)).toEqual({ state: 'ok', rows: 400 })
      if (answer.state === 'ok') expect(answer.parents).toHaveLength(400)
    }
    // data stored before the rule of one level checks every sibling, which
    // a legacy nested group may be, and passes the budget
    const legacy = await plant(NOW)
    const old = await boardRead(
      legacy.t,
      [legacy.f.guest],
      projectScope(legacy.f.guest, legacy.f.sub.id),
      {
        priority: 'urgent',
      },
    )
    record('the same, stored before the rule of one level', old.answer, old.read)
    expect(old.answer.state).toBe('over_budget')
  }, 600_000)

  it('searches a word a label holds over 4,000 tasks through the label, and reads labels only where one can finish the match', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const labelOf = async (name: string) => {
      const id = uuid()
      await t.run((ctx) =>
        ctx.db.insert('labels', {
          id,
          org_id: f.org.id,
          name,
          name_lower: name.toLowerCase(),
          color: '#336699',
          created_at: NOW,
        }),
      )
      return id
    }
    const bug = await labelOf('Bug')
    await labelOf('Design')
    /* titles at the cap and 390-character texts keep this search within
     * about 6 percent of the bytes at which a search stops fitting, on
     * purpose: rows that grow make it answer over_budget, and BOARD's
     * measured sizes then need measuring again */
    // a tenth of every sixth task's titles say login
    const tasks = await plantTasks(
      t,
      f.sub,
      4000,
      (i) => ({
        title: i % 60 === 0 ? `Login ${TITLE.slice(6)}` : TITLE,
        text: words(i, TEXT_CHARS),
      }),
      1000,
    )
    await labelAll(
      t,
      bug,
      tasks.filter((_, i) => i % 6 === 0),
    )
    const scope = projectScope(f.guest, f.sub.id)
    const labelled = await boardRead(t, [f.guest], scope, { search: 'bug' })
    record('a label word over 4,000 tasks', labelled.answer, labelled.read)
    expect(stateOf(labelled.answer)).toEqual({ state: 'ok', rows: 667 })
    const both = await boardRead(t, [f.guest], scope, { search: 'login bug' })
    record('a title word and a label word over 4,000 tasks', both.answer, both.read)
    expect(stateOf(both.answer)).toEqual({ state: 'ok', rows: 67 })
    // a label read for each of 4,000 candidates passes the budget, while a
    // search reads labels only for the 67 tasks whose titles say login
    BOARD.labelTasks = Number.POSITIVE_INFINITY
    expect((await boardRead(t, [f.guest], scope, { search: 'bug' })).answer.state).toBe(
      'over_budget',
    )
    const own = await boardRead(t, [f.guest], scope, { search: 'login bug' })
    expect(stateOf(own.answer)).toEqual({ state: 'ok', rows: 67 })
    expect(own.read.ranges).toBeLessThan(both.read.ranges + 100)
  }, 600_000)

  it("searches a word a label holds over a small selection through each task's own rows when the label is on many other tasks", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const bug = uuid()
    await t.run((ctx) =>
      ctx.db.insert('labels', {
        id: bug,
        org_id: f.org.id,
        name: 'Bug',
        name_lower: 'bug',
        color: '#336699',
        created_at: NOW,
      }),
    )
    // the label on 600 tasks of FW and 29,400 of a sub-project the guest cannot see
    const elsewhere = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const mine = await plantTasks(
      t,
      f.sub,
      600,
      (i) => ({ title: TITLE, text: words(i, TEXT_CHARS) }),
      600,
    )
    const theirs = await plantTasks(t, elsewhere, 29_400, () => ({}), 2000)
    await labelAll(t, bug, [...mine, ...theirs])
    const { answer, read } = await boardRead(t, [f.guest], projectScope(f.guest, f.sub.id), {
      search: 'bug',
    })
    record('a label word over 600 tasks, the label on 29,400 others', answer, read)
    expect(stateOf(answer)).toEqual({ state: 'ok', rows: 600 })
  }, 600_000)

  it("answers the envelope's largest Board: 200 sub-projects shared with each of a person's 25 teams, Focus alone, tasks under distinct parents", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const me = await plantLogin(t, await plantSeat(t, { org_id: f.org.id, accepted_at: NOW }))
    const top = await plantProject(t, { org_id: f.org.id, lead_id: f.user.id })
    const subs = await plantSubs(t, top, 200)
    // the teams, memberships and shares with the name keys their writers
    // copy (model/teams.ts, model/projectAccess.ts)
    await t.run(async (ctx) => {
      for (let i = 0; i < 25; i++) {
        const team = uuid()
        const name = nameAtCap(i)
        await ctx.db.insert('teams', {
          id: team,
          org_id: f.org.id,
          ...named(name),
          track_delay_default: true,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', {
          team_id: team,
          profile_id: me.id,
          is_leader: false,
          name_key: nameKey(me.name),
        })
        for (const sub of subs)
          await ctx.db.insert('project_team_access', {
            project_id: sub.id,
            team_id: team,
            level: 'user',
            name_key: nameKey(name),
          })
      }
    })
    // 1,001 subtasks, each under a parent of its own, 5 a sub-project
    const parents: Doc<'issues'>[] = []
    for (const [i, sub] of subs.entries())
      parents.push(...(await plantTasks(t, sub, i === 0 ? 6 : 5, () => atCaps)))
    const kids: Doc<'issues'>[] = []
    for (const [i, sub] of subs.entries())
      kids.push(
        ...(await plantTasks(t, sub, i === 0 ? 6 : 5, (j) => ({
          ...atCaps,
          parent_id: parents[i === 0 ? j : 1 + 5 * i + j].id,
          assignee_id: me.id,
        }))),
      )
    await withReach(t)
    const scope = projectScope(me, top.id)
    const over = await boardRead(t, [me], scope, { focus: true })
    record(
      'the largest Board, 1,001 subtasks under distinct parents, Focus',
      over.answer,
      over.read,
    )
    expect(over.answer.state).toBe('over_ceiling')
    // one parent and its subtask fewer
    await archive(t, kids[0])
    await archive(t, parents[0])
    const full = await boardRead(t, [me], scope, { focus: true })
    record(
      'the largest Board, 1,000 subtasks under distinct parents, Focus',
      full.answer,
      full.read,
    )
    const whole = await boardRead(t, [me], scope)
    record('the largest Board, 1,000 subtasks under distinct parents', whole.answer, whole.read)
    expect(stateOf(full.answer)).toEqual({ state: 'ok', rows: 2000 })
    expect(stateOf(whole.answer)).toEqual({ state: 'ok', rows: 2000 })
    // the subtasks are the person's own
    const mine = await boardRead(t, [me], { kind: 'mine' }, { mine: true })
    record('My view of 1,000 tasks for a person in 25 teams', mine.answer, mine.read)
    expect(stateOf(mine.answer)).toEqual({ state: 'ok', rows: 1000 })
    if (mine.answer.state === 'ok') expect(mine.answer.parents).toHaveLength(1000)
  }, 900_000)
})

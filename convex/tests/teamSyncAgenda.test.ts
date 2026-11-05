/* teamSync.agenda, Team sync's server read (lib/teamSyncAgenda.ts
 * readAgenda on lib/viewReads.ts and lib/viewLoads.ts): its arguments, the
 * scopes it answers unavailable alike, a check of the caller's access that
 * a bound stops, each scope's sub-projects, the rows, the walk's people,
 * the asks, Done since from each walker's reading floor, the blockers, the
 * delays and the week's hours, the ceiling with the counts bound, that data
 * the caller cannot see moves nothing, and real limits under convex-test's
 * transaction limits with the figures they read, one figure at its design
 * size a case, or the figures one read takes together at their sum.
 * src/store/teamSyncParity.test.ts compares its answers with the page's
 * own rules. */

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { accessOf, OWN_READS } from '../lib/access'
import { NAME_MAX, TEAM_SYNC_TASKS } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { callRoom, OWNER_LOADS, ownerLoadReader, weeklyHours } from '../lib/ownerLoads'
import { AGENDA, type AgendaAnswer, type AgendaScope, readAgenda } from '../lib/teamSyncAgenda'
import { clockOf } from '../lib/viewLoads'
import { unstampOverview } from '../model/overviewCounts'
import { plantTasks, type ReadFigures } from './board.setup'
import {
  as,
  expectRefusal,
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
import { plantPeople } from './overview.setup'
import { countOrg } from './overviewCounts.setup'
import { withReach } from './projectReach.setup'
import { dayPlus, ordinary } from './roadmap.setup'
import {
  type AgendaClock,
  agendaFor,
  agendaRead,
  clockOn,
  figures,
  NOW_CLOCK,
  NOW_WEEK,
  okOf,
  plantBlocks,
  plantDone,
  plantOpen,
  plantStamp,
  plantTeam,
} from './teamSyncAgenda.setup'

const DEFAULT_AGENDA = structuredClone(AGENDA)
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
const DEFAULT_OWNER_LOADS = structuredClone(OWNER_LOADS)
afterEach(() => {
  Object.assign(AGENDA, structuredClone(DEFAULT_AGENDA))
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
  Object.assign(OWNER_LOADS, structuredClone(DEFAULT_OWNER_LOADS))
})

const sorted = (ids: Iterable<string>) => [...ids].sort()
const HOUR_MS = 3_600_000

/** The titles of `rows`, sorted. */
const titles = (rows: readonly { title: string }[]) => rows.map((r) => r.title).sort()

/** Plants a task in `project`. */
const task = (t: T, project: Doc<'projects'>, fields: Partial<Doc<'issues'>> = {}) =>
  plantIssue(t, { org_id: project.org_id, project_id: project.id, ...fields })

/** A seat of `role` in the fixture's organization with a login. */
const seatOf = (t: T, f: OrgFixture, role: 'user' | 'viewer' | 'guest' | 'admin' = 'user') =>
  plantSeat(t, {
    org_id: f.org.id,
    org_role: role,
    auth_user_id: `auth_${uuid()}`,
    accepted_at: NOW,
    name: `Seat ${role}`,
  })

/** A grant of `level` on `project` for `me`. */
const grant = (t: T, project: Doc<'projects'>, me: Doc<'profiles'>, level = 'user' as const) =>
  t.run((ctx) =>
    ctx.db.insert('project_access', { project_id: project.id, profile_id: me.id, level }),
  )

const projectScope = (project: Doc<'projects'>): AgendaScope => ({
  kind: 'project',
  project_id: project.id,
})
const ALL: AgendaScope = { kind: 'all' }

/* ---------------------------------------------------------------- arguments */

describe('arguments', () => {
  it('refuses a malformed clock and a scope the validator does not know, and answers a whole one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const scope = projectScope(f.meta)
    const ask = (clock: AgendaClock, s: AgendaScope = scope) =>
      as(t, f.user).query(api.teamSync.agenda, { org_id: f.org.id, scope: s, ...clock })
    await expectRefusal(ask({ ...NOW_CLOCK, week: '2026-01-05' }), 'bad_request', /week/)
    await expectRefusal(ask({ ...NOW_CLOCK, day: '2026-02-30' }), 'bad_request', /day/)
    await expectRefusal(ask({ ...NOW_CLOCK, week_starts: [] }), 'bad_request', /week_starts/)
    await expectRefusal(
      ask({ ...NOW_CLOCK, week_end: NOW_CLOCK.week_end + 86_400_000 }),
      'bad_request',
      /week_end/,
    )
    // weeks that begin on other days than `week` names, which would leave a
    // walker's running sitting with no local day to read from
    await task(t, f.sub, { assignee_id: f.user.id, status: 'todo' })
    await plantStamp(t, f.user, { at: '2026-01-01T10:00:00.000Z' })
    const moved = (ms: number): AgendaClock => ({
      ...NOW_CLOCK,
      week_starts: NOW_CLOCK.week_starts.map((s) => s + ms),
      week_end: NOW_CLOCK.week_end + ms,
    })
    for (const ms of [-3 * 86_400_000, -14 * HOUR_MS - 1, 12 * HOUR_MS + 1, 86_400_000])
      await expectRefusal(ask(moved(ms)), 'bad_request', /week_starts/)
    // a local midnight of `week` in any zone, from UTC+14 to UTC-12
    for (const ms of [-14 * HOUR_MS, 12 * HOUR_MS])
      expect(okOf(await ask(moved(ms))).people.map((p) => p.id)).toEqual([f.user.id])
    await expect(
      as(t, f.user).query(api.teamSync.agenda, {
        org_id: f.org.id,
        scope: { kind: 'mine' } as unknown as AgendaScope,
        ...NOW_CLOCK,
      }),
    ).rejects.toThrow(/Validator error/)
    expect((await ask(NOW_CLOCK)).state).toBe('ok')
  })
})

/* -------------------------------------------------------------------- access */

describe('access', () => {
  it('answers unavailable alike for every scope it cannot honour, and never falls back to All projects', async () => {
    const t = newT()
    const f = await withOrg(t)
    const archived = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const notMeta = await plantProject(t, { org_id: f.org.id, type: 'project' })
    const foreignTeam = await plantTeam(t, f.otherOrg.id, 'Elsewhere', [], [f.otherProject])
    await task(t, f.sub, { title: 'A row', assignee_id: f.user.id })
    await withReach(t)
    const cases: [Doc<'profiles'>, AgendaScope, string?][] = [
      [f.viewer, { kind: 'project', project_id: uuid() }],
      [f.viewer, projectScope(f.otherProject)],
      [f.viewer, projectScope(archived)],
      [f.viewer, projectScope(f.hidden)],
      [f.admin, projectScope(notMeta)],
      [f.viewer, { kind: 'team', team_id: uuid() }],
      [f.viewer, { kind: 'team', team_id: foreignTeam }],
      [f.guest, projectScope(f.meta)],
      [f.guest, ALL],
      [f.guest, { kind: 'team', team_id: f.team.id }],
      // a login without a seat in the organization it names
      [f.user, projectScope(f.otherProject), f.otherOrg.id],
      [f.user, ALL, f.otherOrg.id],
    ]
    for (const [who, scope, org] of cases)
      expect(await agendaFor(t, who, scope, NOW_CLOCK, org), JSON.stringify(scope)).toEqual({
        state: 'unavailable',
      })
    // this must fail for a fallback to All projects, which is ok and holds
    // the viewer's sub-projects
    const all = okOf(await agendaFor(t, f.viewer, ALL))
    expect(all.sub_projects).toEqual(sorted([f.sub.id, f.sub2.id]))
    expect(titles(all.rows)).toEqual(['A row'])
  })

  it("answers unavailable with access_unchecked where a bound of the caller's own reads stopped a check, never ok", async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await seatOf(t, f)
    await grant(t, f.sub, me)
    const team = await plantTeam(t, f.org.id, 'Builders', [me], [f.sub2])
    await task(t, f.sub2, { assignee_id: me.id })
    await withReach(t)
    const scopes: AgendaScope[] = [projectScope(f.meta), { kind: 'team', team_id: team }, ALL]
    for (const scope of scopes) expect((await agendaFor(t, me, scope)).state).toBe('ok')
    Object.assign(OWN_READS, { projectShares: 0, rows: 0, lookups: 0, teamReads: 0, navRows: 0 })
    for (const scope of scopes)
      expect(await agendaFor(t, me, scope)).toEqual({
        state: 'unavailable',
        reason: 'access_unchecked',
        message: expect.stringContaining('could not finish checking which projects you can see'),
      })
  })

  it('adds no row, ask, Done task, sub-project or top-level project of a hidden or an archived sub-project, in any scope', async () => {
    const t = newT()
    const f = await withOrg(t)
    const sibling = await plantHiddenSibling(t, f, f.viewer)
    const archived = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const team = await plantTeam(t, f.org.id, 'Everything', [], [f.meta, f.hidden])
    await task(t, f.sub, { title: 'Shown', assignee_id: f.user.id })
    const planted: string[] = []
    for (const p of [sibling, archived, hiddenSub]) {
      planted.push(
        (await task(t, p, { title: 'Open', assignee_id: f.user.id })).id,
        (await task(t, p, { title: 'Ask', status: 'backlog', due_date: '2026-01-02' })).id,
        (
          await task(t, p, {
            title: 'Done',
            status: 'done',
            assignee_id: f.user.id,
            done_at: '2025-12-31T12:00:00.000Z',
          })
        ).id,
      )
    }
    await withReach(t)
    await countOrg(t, f.org.id)
    for (const scope of [projectScope(f.meta), { kind: 'team', team_id: team } as const, ALL]) {
      const ok = okOf(await agendaFor(t, f.viewer, scope))
      expect(ok.sub_projects, JSON.stringify(scope)).toEqual(sorted([f.sub.id, f.sub2.id]))
      expect(ok.top_projects).toEqual([f.meta.id])
      expect(titles(ok.rows)).toEqual(['Shown'])
      expect(ok.asks).toEqual([])
      expect(ok.done).toEqual([])
      const text = JSON.stringify(ok)
      for (const id of [sibling.id, archived.id, hiddenSub.id, f.hidden.id, ...planted])
        expect(text).not.toContain(id)
    }
    // the project's lead sees the sibling and SKNK's sub-project, and the
    // archived one still adds nothing
    const lead = okOf(await agendaFor(t, f.user, ALL))
    expect(lead.sub_projects).toEqual(sorted([f.sub.id, f.sub2.id, sibling.id, hiddenSub.id]))
    expect(lead.top_projects).toEqual(sorted([f.meta.id, f.hidden.id]))
    expect(JSON.stringify(lead)).not.toContain(archived.id)
  })

  it('gives an admin what lib/access.ts accessOf gives them, and no more', async () => {
    const t = newT()
    const f = await withOrg(t)
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    await withReach(t)
    const ok = okOf(await agendaFor(t, f.admin, ALL))
    const seen = await t.run(async (ctx) => {
      const access = accessOf(ctx, f.admin)
      const subs = [f.sub, f.sub2, hiddenSub, f.otherProject]
      const out: string[] = []
      for (const p of subs)
        if ((await access.live(p.id)) && (await access.visible(p.id)) && p.parent_id) out.push(p.id)
      return out
    })
    expect(ok.sub_projects).toEqual(sorted(seen))
    expect(ok.sub_projects).not.toContain(f.otherProject.id)
  })
})

/* --------------------------------------------------------------------- scope */

describe('scope', () => {
  it("reads a project's visible sub-projects, a sub-project itself and a navigation-only project's visible ones", async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await seatOf(t, f)
    await grant(t, f.sub, me)
    await withReach(t)
    const meta = okOf(await agendaFor(t, f.user, projectScope(f.meta)))
    expect(meta.sub_projects).toEqual(sorted([f.sub.id, f.sub2.id]))
    expect(meta.top_projects).toEqual([f.meta.id])
    const sub = okOf(await agendaFor(t, f.user, projectScope(f.sub2)))
    expect(sub.sub_projects).toEqual([f.sub2.id])
    expect(sub.top_projects).toEqual([f.meta.id])
    // me sees TBED only to navigate to FW
    for (const scope of [projectScope(f.meta), ALL]) {
      const nav = okOf(await agendaFor(t, me, scope))
      expect(nav.sub_projects, JSON.stringify(scope)).toEqual([f.sub.id])
      expect(nav.top_projects).toEqual([f.meta.id])
    }
    expect(await agendaFor(t, me, projectScope(f.sub2))).toEqual({ state: 'unavailable' })
  })

  it("reads a team's shares each once, a top-level share reaching its sub-projects, and skips a share the reader cannot see", async () => {
    const t = newT()
    const f = await withOrg(t)
    // the viewer is not in the team and cannot see SKNK
    const skunkSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const team = await plantTeam(t, f.org.id, 'Platform', [f.user], [f.meta, f.sub, f.hidden])
    await task(t, f.sub, { title: 'In FW', assignee_id: f.user.id })
    await task(t, skunkSub, { title: 'In SKNK', assignee_id: f.user.id })
    const ok = okOf(await agendaFor(t, f.viewer, { kind: 'team', team_id: team }))
    expect(ok.sub_projects).toEqual(sorted([f.sub.id, f.sub2.id]))
    expect(ok.top_projects).toEqual([f.meta.id])
    expect(titles(ok.rows)).toEqual(['In FW'])
    // a member sees SKNK through the team's share
    const member = okOf(await agendaFor(t, f.user, { kind: 'team', team_id: team }))
    expect(member.sub_projects).toEqual(sorted([f.sub.id, f.sub2.id, skunkSub.id]))
    expect(member.top_projects).toEqual(sorted([f.meta.id, f.hidden.id]))
    // a team without shares holds nothing, and is no other scope
    const empty = okOf(await agendaFor(t, f.viewer, { kind: 'team', team_id: f.team.id }))
    expect(empty.sub_projects).toEqual([])
    expect(empty.rows).toEqual([])
  })

  it('names no top-level project the reader sees only to navigate to an archived sub-project, as the page does not show it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await seatOf(t, f)
    const archived = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    await grant(t, archived, me)
    await withReach(t)
    for (const scope of [ALL, projectScope(f.meta)]) {
      const ok = okOf(await agendaFor(t, me, scope))
      expect(ok.top_projects, JSON.stringify(scope)).toEqual([])
      expect(ok.sub_projects).toEqual([])
    }
    // this must fail for a rule that names every top-level project the
    // reader can see, as they see TBED, to navigate
    expect(await t.run((ctx) => accessOf(ctx, me).visible(f.meta.id))).toBe(true)
  })

  it("reads All projects only once the organization's reach rows are complete", async () => {
    const t = newT()
    const f = await withOrg(t)
    await task(t, f.sub, { assignee_id: f.user.id })
    expect(await agendaFor(t, f.user, ALL)).toEqual({ state: 'unavailable' })
    expect((await agendaFor(t, f.user, projectScope(f.meta))).state).toBe('ok')
    await withReach(t)
    expect(okOf(await agendaFor(t, f.user, ALL)).rows).toHaveLength(1)
  })
})

/* ---------------------------------------------------------------------- rows */

describe('rows', () => {
  it("holds every open task without subtasks of the scope, whoever owns it, a subtask under another sub-project's group included", async () => {
    const t = newT()
    const f = await withOrg(t)
    const team = await plantTeam(t, f.org.id, 'Platform', [f.user], [f.meta])
    for (const status of ['todo', 'progress', 'review'] as const)
      await task(t, f.sub, { title: `Leaf ${status}`, status, assignee_id: f.admin.id })
    await task(t, f.sub, { title: 'Backlog', status: 'backlog', assignee_id: f.user.id })
    await task(t, f.sub, { title: 'Done', status: 'done', done_at: NOW, assignee_id: f.user.id })
    await task(t, f.sub, { title: 'Archived', assignee_id: f.user.id, archived_at: NOW })
    const group = await task(t, f.sub, { title: 'Group', assignee_id: f.user.id })
    await task(t, f.sub, { title: 'Its subtask', parent_id: group.id, assignee_id: f.user.id })
    await task(t, f.sub2, { title: 'Subtask in PCB', parent_id: group.id, assignee_id: f.user.id })
    const leaves = ['Leaf progress', 'Leaf review', 'Leaf todo']
    const meta = okOf(await agendaFor(t, f.viewer, projectScope(f.meta)))
    // this must fail for a rule that takes a group or a Backlog task as a row
    expect(titles(meta.rows)).toEqual(sorted([...leaves, 'Its subtask', 'Subtask in PCB']))
    expect(meta.rows.every((r) => !r.has_subtasks)).toBe(true)
    // the group in FW is the PCB subtask's shown parent
    const pcb = okOf(await agendaFor(t, f.viewer, projectScope(f.sub2)))
    expect(titles(pcb.rows)).toEqual(['Subtask in PCB'])
    expect(titles(pcb.parents)).toEqual(['Group'])
    expect(pcb.rows[0].parent_id).toBe(group.id)
    expect(pcb.parents[0].has_subtasks).toBe(true)
    // a team scope narrows the people, not the rows, and the admin is not in it
    const scoped = okOf(await agendaFor(t, f.viewer, { kind: 'team', team_id: team }))
    expect(titles(scoped.rows)).toEqual(titles(meta.rows))
    expect(scoped.people.map((p) => p.id)).toEqual([f.user.id])
  })
})

/* -------------------------------------------------------------------- people */

describe('people', () => {
  it("walks the rows' owners, an inactive one and an agent kept, in a team only its members, and no profile of another organization", async () => {
    const t = newT()
    const f = await withOrg(t)
    const gone = await plantSeat(t, { org_id: f.org.id, active: false, name: 'Gone' })
    await task(t, f.sub, { assignee_id: f.user.id })
    await task(t, f.sub, { status: 'review', assignee_id: f.viewer.id, reviewer_id: f.admin.id })
    await task(t, f.sub, { assignee_id: f.agent.id })
    await task(t, f.sub, { assignee_id: gone.id })
    await task(t, f.sub, { assignee_id: f.otherAdmin.id })
    await task(t, f.sub, { status: 'backlog', assignee_id: f.guest.id })
    await task(t, f.sub, { status: 'done', done_at: NOW, assignee_id: f.viewer.id })
    await plantStamp(t, f.user, { at: '2025-12-30T10:00:00.000Z' })
    const ok = okOf(await agendaFor(t, f.viewer, projectScope(f.meta)))
    expect(ok.people.map((p) => p.id)).toEqual(sorted([f.user.id, f.admin.id, f.agent.id, gone.id]))
    const byId = new Map(ok.people.map((p) => [p.id, p]))
    expect(byId.get(gone.id)?.active).toBe(false)
    expect(byId.get(f.agent.id)?.kind).toBe('agent')
    expect(byId.get(f.agent.id)?.plannable_hours).toBeNull()
    expect(byId.get(f.user.id)).toMatchObject({
      name: 'user',
      plannable_hours: 40,
      stamp: { at: '2025-12-30T10:00:00.000Z' },
    })
    expect(byId.get(f.admin.id)?.stamp).toBeNull()
    // the Hardware team holds the user and the admin
    const team = await plantTeam(t, f.org.id, 'Platform', [f.user, f.admin], [f.meta])
    const scoped = okOf(await agendaFor(t, f.viewer, { kind: 'team', team_id: team }))
    expect(scoped.people.map((p) => p.id)).toEqual(sorted([f.user.id, f.admin.id]))
    expect(scoped.rows).toHaveLength(ok.rows.length)
  })
})

/* ---------------------------------------------------------------------- asks */

describe('asks', () => {
  it('holds the unassigned Backlog tasks due within 14 days or overdue, never a group or an assigned one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const backlog = { status: 'backlog' as const }
    await task(t, f.sub, { ...backlog, title: 'Due in 14 days', due_date: '2026-01-15' })
    await task(t, f.sub, { ...backlog, title: 'Due in 15 days', due_date: '2026-01-16' })
    await task(t, f.sub, { ...backlog, title: 'Due today', due_date: '2026-01-01' })
    await task(t, f.sub, { ...backlog, title: 'Overdue', due_date: '2025-11-20' })
    await task(t, f.sub, { ...backlog, title: 'Undated' })
    await task(t, f.sub, {
      ...backlog,
      title: 'Assigned',
      due_date: '2026-01-02',
      assignee_id: f.user.id,
    })
    const group = await task(t, f.sub, { ...backlog, title: 'A group', due_date: '2026-01-02' })
    await task(t, f.sub, { title: 'Its subtask', parent_id: group.id, assignee_id: f.user.id })
    // an open one Needs an owner lists is a row
    await task(t, f.sub, { title: 'Open urgent', priority: 'urgent' })
    const ok = okOf(await agendaFor(t, f.viewer, projectScope(f.meta)))
    expect(titles(ok.asks)).toEqual(sorted(['Due in 14 days', 'Due today', 'Overdue']))
    expect(titles(ok.rows)).toEqual(sorted(['Its subtask', 'Open urgent']))
    // a day later, 15 days are 14
    const next = okOf(
      await agendaFor(t, f.viewer, projectScope(f.meta), clockOn('2026-01-02', NOW_WEEK)),
    )
    expect(titles(next.asks)).toEqual(
      sorted(['Due in 14 days', 'Due in 15 days', 'Due today', 'Overdue']),
    )
  })
})

/* ---------------------------------------------------------------- Done since */

describe('Done since', () => {
  it("holds each walker's Done tasks from their reading floor by the page's rule, a reviewer's only with a hand-off", async () => {
    const t = newT()
    const f = await withOrg(t)
    // the walkers, by a row each
    for (const p of [f.user, f.admin, f.agent]) await task(t, f.sub, { assignee_id: p.id })
    // the user has no stamp, so reads from Wednesday's midnight; the admin's
    // sitting was over before the day; the agent's runs into it, from its
    // `since`
    await plantStamp(t, f.admin, { at: '2025-12-31T10:00:00.000Z' })
    await plantStamp(t, f.agent, {
      at: '2026-01-01T00:30:00.000Z',
      since: '2025-12-20T00:00:00.000Z',
    })
    const done = (title: string, fields: Partial<Doc<'issues'>>) =>
      task(t, f.sub, { title, status: 'done', ...fields })
    await done('User, at the floor', {
      assignee_id: f.user.id,
      done_at: '2025-12-31T00:00:00.000Z',
    })
    await done('User, before it', { assignee_id: f.user.id, done_at: '2025-12-30T23:59:59.999Z' })
    await done('Reviewed by the admin', {
      assignee_id: f.viewer.id,
      reviewer_id: f.admin.id,
      review_at: '2025-12-31T11:00:00.000Z',
      done_at: '2025-12-31T12:00:00.000Z',
    })
    await done('Reviewed without a hand-off', {
      assignee_id: f.viewer.id,
      reviewer_id: f.admin.id,
      done_at: '2025-12-31T12:00:00.000Z',
    })
    await done('Reviewed before the admin’s floor', {
      assignee_id: f.viewer.id,
      reviewer_id: f.admin.id,
      review_at: '2025-12-31T08:00:00.000Z',
      done_at: '2025-12-31T09:00:00.000Z',
    })
    await done('Agent, in the sitting', {
      assignee_id: f.agent.id,
      done_at: '2025-12-25T00:00:00.000Z',
    })
    await done('Agent, before it', { assignee_id: f.agent.id, done_at: '2025-12-19T00:00:00.000Z' })
    await done('Not a walker’s', { assignee_id: f.viewer.id, done_at: '2025-12-31T12:00:00.000Z' })
    const group = await done('A Done group', {
      assignee_id: f.user.id,
      done_at: '2025-12-31T12:00:00.000Z',
    })
    await done('Its Done subtask', {
      parent_id: group.id,
      assignee_id: f.user.id,
      done_at: '2025-12-31T12:00:00.000Z',
    })
    await task(t, f.sub, {
      title: 'Archived Done',
      status: 'done',
      assignee_id: f.user.id,
      done_at: '2025-12-31T12:00:00.000Z',
      archived_at: NOW,
    })
    const ok = okOf(await agendaFor(t, f.viewer, projectScope(f.meta)))
    // this must fail for a reviewed task without review_at or a group
    expect(titles(ok.done)).toEqual(
      sorted([
        'User, at the floor',
        'Reviewed by the admin',
        'Agent, in the sitting',
        'Its Done subtask',
      ]),
    )
    expect(titles(ok.parents)).toEqual(['A Done group'])
  })

  it("reads the organization's week start: Monday reads from Thursday where the week starts on Sunday", async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => ctx.db.patch(f.org._id, { week_start: 0 }))
    await task(t, f.sub, { assignee_id: f.user.id })
    const done = (title: string, done_at: string) =>
      task(t, f.sub, { title, status: 'done', assignee_id: f.user.id, done_at })
    await done('Friday', '2025-12-26T08:00:00.000Z')
    await done('Thursday', '2025-12-25T08:00:00.000Z')
    await done('Wednesday', '2025-12-24T08:00:00.000Z')
    // Sunday to Thursday are the working days of Sunday weeks: Monday 29
    // December reads from Sunday, and Sunday from Thursday. This must fail
    // for a reader that ignores the week start, as Monday would read from
    // Friday
    const monday = okOf(
      await agendaFor(t, f.viewer, projectScope(f.meta), clockOn('2025-12-29', '2025-12-28')),
    )
    expect(titles(monday.done)).toEqual([])
    const sunday = okOf(
      await agendaFor(t, f.viewer, projectScope(f.meta), clockOn('2025-12-28', '2025-12-28')),
    )
    expect(titles(sunday.done)).toEqual(['Friday', 'Thursday'])
    // on Monday weeks, a Monday reads from Friday
    await t.run((ctx) => ctx.db.patch(f.org._id, { week_start: 1 }))
    const weekday = okOf(
      await agendaFor(t, f.viewer, projectScope(f.meta), clockOn('2025-12-29', '2025-12-29')),
    )
    expect(titles(weekday.done)).toEqual(['Friday'])
  })
})

/* ------------------------------------------------------------------- blockers */

describe('blockers', () => {
  it("names a row's open blockers the reader is shown, by link order, never a done, hidden, archived or foreign one or a relates link", async () => {
    const t = newT()
    const f = await withOrg(t)
    const sibling = await plantHiddenSibling(t, f, f.viewer)
    const row = await task(t, f.sub, { title: 'Blocked', assignee_id: f.user.id })
    const open = await task(t, f.sub2, { title: 'Open blocker', status: 'backlog' })
    const done = await task(t, f.sub2, { title: 'Done blocker', status: 'done', done_at: NOW })
    const doneGroup = await task(t, f.sub2, { title: 'Done group' })
    await task(t, f.sub2, { parent_id: doneGroup.id, status: 'done', done_at: NOW })
    const openGroup = await task(t, f.sub2, { title: 'Open group' })
    await task(t, f.sub2, { parent_id: openGroup.id })
    const hidden = await task(t, sibling, { title: 'Hidden blocker' })
    const archived = await task(t, f.sub2, { title: 'Archived blocker', archived_at: NOW })
    const foreign = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      title: 'Foreign',
    })
    const related = await task(t, f.sub2, { title: 'Related' })
    const another = await task(t, f.sub, { title: 'Blocking row', assignee_id: f.user.id })
    // the links in creation order: the open group's first, then another row
    await plantBlocks(t, [
      [openGroup, row],
      [another, row],
      [done, row],
      [doneGroup, row],
      [hidden, row],
      [archived, row],
      [foreign, row],
      [open, row],
    ])
    await plantBlocks(t, [[related, row]], 'relates')
    const ok = okOf(await agendaFor(t, f.viewer, projectScope(f.meta)))
    const blocked = ok.rows.find((r) => r.id === row.id)
    const key = (t: Doc<'issues'>) => `QN-${t.num}`
    // this must fail for a blocker read past the reader's sight
    expect(blocked?.blocked_by).toEqual([key(openGroup), key(another), key(open)])
    const text = JSON.stringify(ok)
    for (const id of [hidden.id, foreign.id, archived.id]) expect(text).not.toContain(id)
    // the lead sees the hidden one
    const lead = okOf(await agendaFor(t, f.user, projectScope(f.meta)))
    expect(lead.rows.find((r) => r.id === row.id)?.blocked_by).toEqual([
      key(openGroup),
      key(another),
      key(hidden),
      key(open),
    ])
  })
})

/* ------------------------------------------------------- delays and the week */

/* `me`'s week hours of `owner` and their load's tasks as the owner reader
 * answers them alone, by lib/ownerLoads.ts weeklyHours. */
const weekOf = (t: T, me: Doc<'profiles'>, owner: Doc<'profiles'>, clock = NOW_CLOCK) =>
  t.run(async (ctx) => {
    const reader = ownerLoadReader(ctx, { me, access: accessOf(ctx, me), room: callRoom })
    const got = await reader.read(owner.id)
    if (got.state !== 'ok') throw new Error(got.state)
    return weeklyHours(me, got.tasks, clockOf(clock), { first: 0, weeks: 1 }).hours[0]
  })

describe('delays and the week', () => {
  /* FW tracks delay and PCB does not. The user holds a late row, a
   * slipping one and one on track in FW and a late one in PCB; the agent a
   * row in FW. */
  async function delayed() {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => ctx.db.patch(f.sub._id, { track_delay: true }))
    const sub = { ...f.sub, track_delay: true }
    const late = await task(t, sub, {
      title: 'Late',
      assignee_id: f.user.id,
      start_week: NOW_WEEK,
      end_week: NOW_WEEK,
      due_date: '2026-01-02',
      remaining_hours: 120,
    })
    const behind = await task(t, sub, {
      title: 'Slipping',
      assignee_id: f.user.id,
      start_week: NOW_WEEK,
      end_week: NOW_WEEK,
      remaining_hours: 60,
    })
    const fine = await task(t, sub, {
      title: 'On track',
      assignee_id: f.user.id,
      start_week: NOW_WEEK,
      end_week: dayPlus(NOW_WEEK, 70),
      due_date: dayPlus(NOW_WEEK, 74),
      remaining_hours: 2,
    })
    const untracked = await task(t, f.sub2, {
      title: 'Late in PCB',
      assignee_id: f.user.id,
      start_week: NOW_WEEK,
      end_week: NOW_WEEK,
      due_date: '2026-01-02',
      remaining_hours: 120,
    })
    const unestimated = await task(t, sub, {
      title: 'Past due, no hours',
      assignee_id: f.user.id,
      due_date: '2025-12-20',
    })
    const agents = await task(t, sub, {
      title: 'The agent’s',
      assignee_id: f.agent.id,
      start_week: NOW_WEEK,
      end_week: NOW_WEEK,
      remaining_hours: 30,
      due_date: '2026-01-02',
    })
    return { t, f, late, behind, fine, untracked, unestimated, agents }
  }

  it("judges each row in a project that tracks delay against its owner's load, and gives each walker's week hours", async () => {
    const c = await delayed()
    const ok = okOf(await agendaFor(c.t, c.f.user, projectScope(c.f.meta)))
    const delay = new Map(ok.rows.map((r) => [r.title, r.delay]))
    expect(Object.fromEntries(delay)).toEqual({
      Late: 'late',
      Slipping: 'behind',
      'On track': null,
      'Late in PCB': null,
      'Past due, no hours': 'late',
      'The agent’s': null,
    })
    const week = new Map(ok.people.map((p) => [p.id, p.week]))
    expect(week.get(c.f.user.id)).toEqual({
      state: 'ok',
      hours: await weekOf(c.t, c.f.user, c.f.user),
    })
    expect(week.get(c.f.agent.id)).toEqual({
      state: 'ok',
      hours: await weekOf(c.t, c.f.user, c.f.agent),
    })
    expect(week.get(c.f.user.id)).not.toEqual({ state: 'ok', hours: 0 })
    expect(ok.hidden).toBe('counted')
  })

  it('reads no load for an organization Viewer: a verdict that needs one is unknown, and every week is unavailable for loads', async () => {
    const c = await delayed()
    const ok = okOf(await agendaFor(c.t, c.f.viewer, projectScope(c.f.meta)))
    const delay = new Map(ok.rows.map((r) => [r.title, r.delay]))
    expect(Object.fromEntries(delay)).toEqual({
      Late: 'unknown',
      Slipping: 'unknown',
      'On track': 'unknown',
      'Late in PCB': null,
      // past due needs no load
      'Past due, no hours': 'late',
      'The agent’s': null,
    })
    expect(
      ok.people.every((p) => p.week.state === 'unavailable' && p.week.reason === 'loads'),
    ).toBe(true)
    expect(ok.hidden).toBe('own_only')
  })

  it("answers unknown and loads, never a guess or a zero, where the owner reader's bounds or the agenda's guard stop the loads", async () => {
    const c = await delayed()
    const scope = projectScope(c.f.meta)
    OWNER_LOADS.open = 0
    const bounded = okOf(await agendaFor(c.t, c.f.user, scope))
    expect(bounded.rows.find((r) => r.title === 'Late')?.delay).toBe('unknown')
    expect(bounded.rows.find((r) => r.title === 'Late in PCB')?.delay).toBeNull()
    expect(bounded.people.find((p) => p.id === c.f.user.id)?.week).toEqual({
      state: 'unavailable',
      reason: 'loads',
    })
    Object.assign(OWNER_LOADS, structuredClone(DEFAULT_OWNER_LOADS))
    // the stored facts' reads without the loads, then a budget a few ranges
    // past them, so the loads stop on the agenda's guard
    OWNER_LOADS.call.ranges = 0
    const facts = await agendaRead(c.t, c.f.user, scope)
    Object.assign(OWNER_LOADS, structuredClone(DEFAULT_OWNER_LOADS))
    AGENDA.reads.ranges = facts.read.ranges + 3
    const guarded = okOf((await agendaRead(c.t, c.f.user, scope)).answer)
    expect(guarded.rows.find((r) => r.title === 'Late')?.delay).toBe('unknown')
    expect(guarded.rows.find((r) => r.title === 'Past due, no hours')?.delay).toBe('late')
    expect(guarded.people.some((p) => p.week.state === 'unavailable')).toBe(true)
  })
})

/* -------------------------------------------------------------------- ceiling */

describe('the ceiling', () => {
  /** Counts the ranges readAgenda opens on `table`, beside its answer. */
  const tableRanges = (t: T, me: Doc<'profiles'>, scope: AgendaScope, table: string) =>
    t.run(async (ctx) => {
      let ranges = 0
      const db = new Proxy(ctx.db, {
        get(target, key) {
          if (key === 'query')
            return (name: Parameters<typeof target.query>[0]) => {
              if (name === table) ranges++
              return target.query(name)
            }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const answer = await readAgenda(
        { ...ctx, db } as unknown as QueryCtx,
        new Map([[me.org_id, me]]),
        { org_id: me.org_id, scope, ...NOW_CLOCK },
      )
      return { answer, ranges, read: await figures(ctx) }
    })

  it('counts rows, asks and Done tasks once each: ten fit a ceiling of 10, one more does not', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    AGENDA.ceiling = 10
    await plantTasks(t, f.sub, 6, (i) => ({ ...ordinary(i), assignee_id: f.user.id }))
    await plantTasks(t, f.sub2, 2, (i) => ({
      ...ordinary(i),
      status: 'backlog',
      due_date: '2026-01-05',
    }))
    await plantTasks(t, f.sub2, 2, (i) => ({
      ...ordinary(i),
      status: 'done',
      assignee_id: f.user.id,
      reviewer_id: f.user.id,
      review_at: NOW,
      done_at: '2025-12-31T12:00:00.000Z',
    }))
    const scope = projectScope(f.meta)
    const fit = okOf((await agendaRead(t, f.user, scope)).answer)
    expect([fit.rows.length, fit.asks.length, fit.done.length]).toEqual([6, 2, 2])
    await task(t, f.sub2, { title: 'One more ask', status: 'backlog', due_date: '2026-01-05' })
    expect((await agendaRead(t, f.user, scope)).answer).toEqual({
      state: 'over_ceiling',
      ceiling: 10,
    })
  })

  it('claims over_ceiling for Done tasks only from their walker’s latest reading point, and answers over_budget for those the floor alone loads', async () => {
    const t = newT()
    const f = await withOrg(t)
    AGENDA.ceiling = 10
    await plantTasks(t, f.sub, 8, (i) => ({ ...ordinary(i), assignee_id: f.agent.id }))
    // the agent's sitting runs into the day from the 20th, and ends at 06:30
    await plantStamp(t, f.agent, {
      at: '2026-01-01T00:30:00.000Z',
      since: '2025-12-20T00:00:00.000Z',
    })
    const loaded = await plantTasks(t, f.sub2, 3, (i) => ({
      ...ordinary(i),
      status: 'done',
      assignee_id: f.agent.id,
      done_at: `2025-12-2${i + 2}T00:00:00.000Z`,
    }))
    const scope = projectScope(f.meta)
    // eleven loaded and eight certain, as the page may show eight after 06:30
    expect(await agendaFor(t, f.viewer, scope)).toEqual({ state: 'over_budget' })
    // this must fail for a claim from the floor: Done after the sitting's
    // end is certain
    await t.run(async (ctx) => {
      for (const d of loaded) await ctx.db.patch(d._id, { done_at: '2026-01-01T00:40:00.000Z' })
    })
    expect(await agendaFor(t, f.viewer, scope)).toEqual({ state: 'over_ceiling', ceiling: 10 })
  })

  it('answers over_ceiling from a team’s counts with no task read, falls back to the read while counting, and reads no count row for a project', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    AGENDA.ceiling = 10
    const team = await plantTeam(t, f.org.id, 'Platform', [f.user], [f.meta])
    await plantTasks(t, f.sub, 6, (i) => ({ ...ordinary(i), assignee_id: f.user.id }))
    await plantTasks(t, f.sub2, 4, (i) => ({
      ...ordinary(i),
      status: 'review',
      assignee_id: f.user.id,
    }))
    await countOrg(t, f.org.id)
    const scope: AgendaScope = { kind: 'team', team_id: team }
    // ten open leaves claim nothing
    expect(okOf((await tableRanges(t, f.user, scope, 'issues')).answer).rows).toHaveLength(10)
    await task(t, f.sub2, { title: ordinary(11).title, assignee_id: f.user.id })
    const bound = await tableRanges(t, f.user, scope, 'issues')
    console.log('agenda figures, the counts bound:', JSON.stringify(bound.read))
    expect(bound.answer).toEqual({ state: 'over_ceiling', ceiling: 10 })
    expect(bound.ranges).toBe(0)
    // a project scope reads no count row, and the read decides
    const project = await tableRanges(t, f.user, projectScope(f.meta), 'overview_counts')
    expect(project.answer.state).toBe('over_ceiling')
    expect(project.ranges).toBe(0)
    // and while the counts are not whole, the read decides
    await t.run((ctx) => unstampOverview(ctx.db, f.org.id))
    const counting = await tableRanges(t, f.user, scope, 'issues')
    expect(counting.answer.state).toBe('over_ceiling')
    expect(counting.ranges).toBeGreaterThan(0)
  })

  it('answers over_budget where a budget stops the read first, never ok with fewer tasks, and past AGENDA.context', async () => {
    // the walker's load is read last and may stop on the guard, which
    // leaves the answer ok with every task and the week unavailable
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const parents = await plantTasks(t, f.sub2, 5, ordinary)
    await plantTasks(t, f.sub, 40, (i) => ({
      ...ordinary(i),
      assignee_id: f.user.id,
      ...(i < 5 ? { parent_id: parents[i].id } : {}),
    }))
    const scope = projectScope(f.sub)
    const whole = await agendaRead(t, f.user, scope)
    expect(okOf(whole.answer).rows).toHaveLength(40)
    expect(okOf(whole.answer).parents).toHaveLength(5)
    for (let ranges = whole.read.ranges - 1; ranges > whole.read.ranges - 60; ranges -= 7) {
      AGENDA.reads.ranges = ranges
      const got = (await agendaRead(t, f.user, scope)).answer
      if (got.state === 'ok') {
        expect(got.rows).toHaveLength(40)
        expect(got.parents).toHaveLength(5)
      } else expect(got).toEqual({ state: 'over_budget' })
    }
    AGENDA.reads.ranges = Math.floor(whole.read.ranges / 2)
    expect((await agendaRead(t, f.user, scope)).answer).toEqual({ state: 'over_budget' })
    Object.assign(AGENDA, structuredClone(DEFAULT_AGENDA))
    AGENDA.context = 4
    expect((await agendaRead(t, f.user, scope)).answer).toEqual({ state: 'over_budget' })
    AGENDA.context = 5
    expect((await agendaRead(t, f.user, scope)).answer.state).toBe('ok')
  })
})

/* --------------------------------------------------------------- hidden data */

/** A fixture whose hidden rows carry ordinary text when `wide`: the
 * sibling's tasks, a hidden parent of a row, a hidden blocker of a row and
 * a hidden subtask of a parent. Every task has the same number in both. */
async function hiddenOrg(wide: boolean) {
  const t = newT()
  const f = await withOrg(t)
  const sibling = await plantHiddenSibling(t, f, f.viewer)
  const text = (i: number) => (wide ? ordinary(i) : { title: 'h', text: '' })
  const [parent] = await plantTasks(t, sibling, 1, () => ({
    ...text(1),
    num: 1,
    assignee_id: f.user.id,
  }))
  const row = await task(t, f.sub, {
    title: 'Under a hidden parent',
    num: 2,
    parent_id: parent.id,
    assignee_id: f.user.id,
  })
  const [blocker] = await plantTasks(t, sibling, 1, () => ({ ...text(3), num: 3 }))
  await plantBlocks(t, [[blocker, row]])
  const shownGroup = await task(t, f.sub, { title: 'A group', num: 4, assignee_id: f.user.id })
  await task(t, f.sub, {
    title: 'Its row',
    num: 5,
    parent_id: shownGroup.id,
    assignee_id: f.user.id,
  })
  await plantTasks(t, sibling, 1, () => ({ ...text(6), num: 6, parent_id: shownGroup.id }))
  await plantTasks(t, sibling, 5, (i) => ({ ...text(i + 7), num: 7 + i, assignee_id: f.user.id }))
  await plantTasks(t, f.sub, 20, (i) => ({ ...ordinary(i), num: 20 + i, assignee_id: f.admin.id }))
  await withReach(t)
  await countOrg(t, f.org.id)
  return { t, f }
}

/** The answer's tasks by title with what the page reads of them, so answers
 * of two organizations compare. */
const shape = (answer: AgendaAnswer) => {
  if (answer.state !== 'ok') return answer
  const one = (r: { title: string; has_subtasks: boolean; has_hidden_parent: boolean }) =>
    [r.title, r.has_subtasks, r.has_hidden_parent] as const
  return {
    rows: answer.rows.map((r) => [...one(r), r.blocked_by.length, r.delay] as const).sort(),
    parents: answer.parents.map(one).sort(),
    asks: answer.asks.length,
    done: answer.done.length,
    people: answer.people.length,
  }
}

describe('hidden data', () => {
  it("answers the same, and stops at the same budget, whatever the hidden rows' sizes and titles", async () => {
    const narrow = await hiddenOrg(false)
    const wide = await hiddenOrg(true)
    for (const label of ['TBED', 'FW', 'All projects']) {
      const scopeOf = (o: typeof narrow): AgendaScope =>
        label === 'All projects' ? ALL : projectScope(label === 'TBED' ? o.f.meta : o.f.sub)
      const read = (o: typeof narrow) => () => agendaFor(o.t, o.f.viewer, scopeOf(o))
      expect(shape(await read(wide)()), label).toEqual(shape(await read(narrow)()))
      const least = await leastBytes(read(narrow))
      expect(least, label).toBe(await leastBytes(read(wide)))
      AGENDA.reads.bytes = least - 1
      expect((await read(wide)()).state, label).toBe('over_budget')
      AGENDA.reads.bytes = DEFAULT_AGENDA.reads.bytes
    }
  })

  it("answers the same, and stops at the same budget, whatever a team's archived and foreign shared projects hold", async () => {
    const answers: unknown[] = []
    const least: number[] = []
    for (const wide of [false, true]) {
      const t = newT()
      const f = await withOrg(t)
      const text = (i: number) =>
        wide
          ? { name: ordinary(i).title.slice(0, NAME_MAX), description: ordinary(i).text }
          : { name: `S${i}`, description: '' }
      const unseen: Doc<'projects'>[] = []
      for (let i = 0; i < 5; i++)
        unseen.push(
          await plantProject(t, {
            org_id: f.org.id,
            key: `S${i}`,
            num: 500 + i,
            archived_at: NOW,
            ...text(i),
          }),
        )
      unseen.push(await plantProject(t, { org_id: f.otherOrg.id, key: 'S9', num: 509, ...text(9) }))
      // the viewer, no member of the team, reads the rows of its live share
      const team = await plantTeam(t, f.org.id, 'Shares', [f.user], [...unseen, f.meta])
      for (let n = 0; n < 3; n++)
        await task(t, f.sub, {
          title: ordinary(n).title,
          num: 10 + n,
          assignee_id: f.user.id,
          status: 'todo',
        })
      await withReach(t)
      await countOrg(t, f.org.id)
      const read = () => agendaFor(t, f.viewer, { kind: 'team', team_id: team })
      const answer = await read()
      expect(okOf(answer).rows).toHaveLength(3)
      answers.push(shape(answer))
      least.push(await leastBytes(read))
    }
    expect(answers[1]).toEqual(answers[0])
    expect(least[1]).toBe(least[0])
  })
})

/** The smallest AGENDA.reads.bytes at which `read` answers ok. */
async function leastBytes(read: () => Promise<AgendaAnswer>): Promise<number> {
  let low = 0
  let high = DEFAULT_AGENDA.reads.bytes
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2)
    AGENDA.reads.bytes = mid
    if ((await read()).state === 'ok') high = mid
    else low = mid
  }
  AGENDA.reads.bytes = DEFAULT_AGENDA.reads.bytes
  return high
}

/* --------------------------------------------------------------- real limits */

/** The answer's state and its tasks' counts, for the logs. */
const countsOf = (answer: AgendaAnswer) =>
  answer.state === 'ok'
    ? {
        state: 'ok',
        rows: answer.rows.length,
        asks: answer.asks.length,
        done: answer.done.length,
        parents: answer.parents.length,
        people: answer.people.length,
        weeks: answer.people.filter((p) => p.week.state === 'ok').length,
        unknown: answer.rows.filter((r) => r.delay === 'unknown').length,
        blocked: answer.rows.filter((r) => r.blocked_by.length > 0).length,
      }
    : { state: answer.state }

const record = (name: string, answer: AgendaAnswer, read: ReadFigures) =>
  console.log(`agenda figures, ${name}:`, JSON.stringify({ ...read, ...countsOf(answer) }))

/** A staff reader `me` and 9 more owners of a fixture's tasks, the
 * Overview's everyday stand-in of 10 owners, and `tops` top-level projects
 * of `subs` sub-projects each that three teams of `me` and the owners share
 * in turn, tracking delay. */
async function sharedCase(o: { tops: number; subs: number | ((top: number) => number) }) {
  const t = newT({ transactionLimits: true })
  const f = await withOrg(t)
  const me = await seatOf(t, f)
  const owners = [me, ...(await plantPeople(t, f.org.id, 9))]
  const planted = await plantSharedTops(t, f, me, { ...o, members: owners })
  return { t, f, me, owners, ...planted }
}

/** `tops` top-level projects named in order from `from`, each with `subs`
 * sub-projects that track delay and `archived` archived ones, and unless
 * `teams` is false three teams of `me`, or of `members`, that share them in
 * turn (those `shared` keeps), as overview.setup.ts plantShared shares
 * them. */
async function plantSharedTops(
  t: T,
  f: OrgFixture,
  me: Doc<'profiles'>,
  o: {
    tops: number
    subs: number | ((top: number) => number)
    archived?: number
    shared?: (top: number) => boolean
    teams?: boolean
    from?: number
    members?: readonly Doc<'profiles'>[]
  },
) {
  const tops: Doc<'projects'>[] = []
  const subs: Doc<'projects'>[] = []
  const subsOf = new Map<string, Doc<'projects'>[]>()
  await t.run(async (ctx) => {
    for (let i = 0; i < o.tops; i++) {
      const at = (o.from ?? 0) + i
      const name = `Programme ${String(at).padStart(3, '0')}`
      const top = await ctx.db.insert('projects', {
        id: uuid(),
        org_id: f.org.id,
        type: 'meta',
        key: `T${at}`,
        name,
        name_key: nameKey(name),
        description: '',
        sort_order: i,
        num: 1000 + at,
        track_delay: true,
        lead_id: f.user.id,
        created_at: NOW,
      })
      const topDoc = (await ctx.db.get(top)) as Doc<'projects'>
      tops.push(topDoc)
      const n = typeof o.subs === 'number' ? o.subs : o.subs(i)
      const own: Doc<'projects'>[] = []
      for (let k = 0; k < n + (o.archived ?? 0); k++) {
        const sub = `${name}-${k}`
        const _id = await ctx.db.insert('projects', {
          id: uuid(),
          org_id: f.org.id,
          type: 'project',
          parent_id: topDoc.id,
          key: `S${at}x${k}`,
          name: sub,
          name_key: nameKey(sub),
          description: '',
          sort_order: k,
          num: 100_000 + 100 * at + k,
          track_delay: true,
          lead_id: f.user.id,
          created_at: NOW,
          ...(k >= n ? { archived_at: NOW } : {}),
        })
        const doc = (await ctx.db.get(_id)) as Doc<'projects'>
        if (k < n) {
          own.push(doc)
          subs.push(doc)
        }
      }
      subsOf.set(topDoc.id, own)
    }
  })
  const teams: string[] = []
  if (o.teams !== false)
    for (let k = 0; k < 3; k++)
      teams.push(
        await plantTeam(
          t,
          f.org.id,
          `Team ${k}`,
          o.members ?? [me],
          tops.filter((_, i) => i % 3 === k && (o.shared?.(i) ?? true)),
        ),
      )
  return { tops, subs, subsOf, teams }
}

/** `n` profiles of the organization, persons with 40 plannable hours, in
 * steps of 200 a transaction. */
async function plantRoster(t: T, orgId: string, n: number): Promise<Doc<'profiles'>[]> {
  const out: Doc<'profiles'>[] = []
  for (let from = 0; from < n; from += 200)
    out.push(
      ...(await t.run(async (ctx) => {
        const got: Doc<'profiles'>[] = []
        for (let i = from; i < Math.min(n, from + 200); i++) {
          const name = `Person ${String(i).padStart(4, '0')}`
          const _id = await ctx.db.insert('profiles', {
            id: uuid(),
            org_id: orgId,
            name,
            name_key: nameKey(name),
            initials: 'PP',
            color: '#7a7ad0',
            org_role: 'user',
            active: true,
            kind: 'person',
            plannable_hours: 40,
            accepted_at: NOW,
            created_at: NOW,
          })
          got.push((await ctx.db.get(_id)) as Doc<'profiles'>)
        }
        return got
      })),
    )
  return out
}

describe('real limits', () => {
  it('answers a project of 800 open and 200 Done tasks over 3 sub-projects at the everyday link share', async () => {
    const c = await sharedCase({ tops: 3, subs: 3 })
    const [scopeTop] = c.tops
    const subs = c.subsOf.get(scopeTop.id) ?? []
    const elsewhere = c.subs.filter((p) => p.parent_id !== scopeTop.id)
    // the project's open and Done tasks at their sum, as the read takes
    // both, 267, 267 and 266 open and 67, 67 and 66 Done, each Done since
    // its walker's floor
    const open: Doc<'issues'>[] = []
    for (const [k, sub] of subs.entries()) {
      open.push(...(await plantOpen(c.t, sub, k === 2 ? 266 : 267, c.owners, 3000 * k)))
      await plantDone(c.t, sub, k === 2 ? 66 : 67, c.owners)
    }
    // two everyday projects elsewhere, 90 open tasks each
    const other: Doc<'issues'>[] = []
    for (const sub of elsewhere) other.push(...(await plantOpen(c.t, sub, 30, c.owners, 9000)))
    // 5 percent of the open tasks with a blocks link, half to each other and
    // half from tasks elsewhere
    const linked = open.filter((_, i) => i % 20 === 7)
    await plantBlocks(c.t, [
      ...linked
        .slice(0, 20)
        .map((t, i): [Doc<'issues'>, Doc<'issues'>] => [linked[(i + 1) % 20], t]),
      ...linked.slice(20).map((t, i): [Doc<'issues'>, Doc<'issues'>] => [other[i * 7], t]),
    ])
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    const { answer, read } = await agendaRead(c.t, c.me, projectScope(scopeTop))
    record('a project of 800 open and 200 Done tasks', answer, read)
    const ok = okOf(answer)
    expect(ok.rows.length + ok.asks.length + ok.done.length).toBeLessThanOrEqual(TEAM_SYNC_TASKS)
    expect(ok.done).toHaveLength(200)
  })

  it('answers a project of 30 sub-projects with 20 open tasks each, beside its 40 archived ones', async () => {
    const c = await sharedCase({ tops: 1, subs: 30 })
    await plantArchivedSubs(c.t, c.f, c.tops[0])
    for (const [k, sub] of c.subs.entries()) await plantOpen(c.t, sub, 20, c.owners, 100 * k)
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    const { answer, read } = await agendaRead(c.t, c.me, projectScope(c.tops[0]))
    record('a project of 30 live and 40 archived sub-projects, 600 open tasks', answer, read)
    expect(okOf(answer).sub_projects).toHaveLength(30)
  })

  it('answers a sub-project of 300 open and 150 Done tasks beside two of 30', async () => {
    const c = await sharedCase({ tops: 1, subs: 3 })
    const [big, ...small] = c.subs
    await plantOpen(c.t, big, 300, c.owners)
    await plantDone(c.t, big, 150, c.owners)
    for (const [k, sub] of small.entries()) await plantOpen(c.t, sub, 30, c.owners, 1000 * (k + 1))
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    for (const [label, scope] of [
      ['the sub-project of 300 open and 150 Done tasks', projectScope(big)],
      ['its project', projectScope(c.tops[0])],
    ] as const) {
      const { answer, read } = await agendaRead(c.t, c.me, scope)
      record(label, answer, read)
      expect(okOf(answer).done).toHaveLength(150)
    }
  })

  it('answers an everyday team of 20 sub-projects of 30 open tasks, for a member in 3 teams', async () => {
    // each team shares 7 projects of 3 sub-projects but one of 2, 20 in all
    const c = await sharedCase({ tops: 21, subs: (i) => (i < 3 ? 2 : 3) })
    const team = c.teams[0]
    const shared = c.tops.filter((_, i) => i % 3 === 0).flatMap((p) => c.subsOf.get(p.id) ?? [])
    expect(shared).toHaveLength(20)
    for (const [k, sub] of shared.entries()) await plantOpen(c.t, sub, 30, c.owners, 100 * k)
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    const { answer, read } = await agendaRead(c.t, c.me, { kind: 'team', team_id: team })
    record('an everyday team, 20 sub-projects of 30 open tasks', answer, read)
    expect(okOf(answer).sub_projects).toHaveLength(20)
  })

  it('answers a team scope for a person in 5 teams', async () => {
    const c = await sharedCase({ tops: 21, subs: (i) => (i < 3 ? 2 : 3) })
    // two more teams of the reader, each sharing 20 sub-projects
    const extra = await plantSharedTops(c.t, c.f, c.me, {
      tops: 14,
      subs: (i) => (i === 0 || i === 7 ? 2 : 3),
      teams: false,
      from: 21,
    })
    await plantTeam(c.t, c.f.org.id, 'Team 3', [c.me], extra.tops.slice(0, 7))
    await plantTeam(c.t, c.f.org.id, 'Team 4', [c.me], extra.tops.slice(7))
    const team = c.teams[0]
    const shared = c.tops.filter((_, i) => i % 3 === 0).flatMap((p) => c.subsOf.get(p.id) ?? [])
    expect(shared).toHaveLength(20)
    for (const [k, sub] of shared.entries()) await plantOpen(c.t, sub, 30, c.owners, 100 * k)
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    const { answer, read } = await agendaRead(c.t, c.me, { kind: 'team', team_id: team })
    record('a team scope for a person in 5 teams', answer, read)
    expect(okOf(answer).sub_projects).toHaveLength(20)
  })

  it('answers over_ceiling from the counts for a team that shares 50 live and 150 archived projects, and from the read while counting', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const me = await seatOf(t, f)
    const owners = [me, ...(await plantPeople(t, f.org.id, 9))]
    // the archived shares first, as the read takes the team's shares in
    // creation order, so it reads all of them before a live one
    const archived = await plantSharedTops(t, f, me, { tops: 150, subs: 0, teams: false })
    await t.run(async (ctx) => {
      for (const p of archived.tops) await ctx.db.patch(p._id, { archived_at: NOW })
    })
    const live = await plantSharedTops(t, f, me, { tops: 50, subs: 3, teams: false, from: 150 })
    const team = await plantTeam(t, f.org.id, 'Fifty', [me], [...archived.tops, ...live.tops])
    // the reader's two other teams, as a person is in 3
    await plantTeam(t, f.org.id, 'Second', [me], [])
    await plantTeam(t, f.org.id, 'Third', [me], [])
    // only the projects the read reaches before the ceiling hold their
    // tasks: 30 open tasks in each sub-project of the first 20
    for (const [k, p] of live.tops.slice(0, 20).entries())
      for (const sub of live.subsOf.get(p.id) ?? []) await plantOpen(t, sub, 30, owners, 100 * k)
    await withReach(t)
    await countOrg(t, f.org.id)
    const scope: AgendaScope = { kind: 'team', team_id: team }
    const bound = await agendaRead(t, me, scope)
    record(
      'a team of 50 live and 150 archived shared projects, the counts bound',
      bound.answer,
      bound.read,
    )
    expect(bound.answer).toEqual({ state: 'over_ceiling', ceiling: TEAM_SYNC_TASKS })
    await t.run((ctx) => unstampOverview(ctx.db, f.org.id))
    const counting = await agendaRead(t, me, scope)
    record('the same team while counting', counting.answer, counting.read)
    expect(counting.answer).toEqual({ state: 'over_ceiling', ceiling: TEAM_SYNC_TASKS })
  })

  it('answers over_ceiling for All projects over 200 top-level projects, for an admin and a member in 3 teams, from the counts and while counting', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const me = await seatOf(t, f)
    const owners = [me, ...(await plantPeople(t, f.org.id, 9))]
    // 200 live top-level projects with 500 live sub-projects, three under
    // the first 100 and two under the rest, and 1,000 archived ones, five
    // under each; the member's three teams share 21 projects spread over
    // the names, three of every 29, 54 sub-projects, 18 a team
    const theirs = (i: number) => i % 29 < 3
    const all = await plantSharedTops(t, f, me, {
      tops: 200,
      subs: (i) => (i < 100 ? 3 : 2),
      archived: 5,
      shared: theirs,
    })
    const mine = new Set(
      all.tops
        .filter((_, i) => theirs(i))
        .flatMap((p) => all.subsOf.get(p.id) ?? [])
        .map((p) => p.id),
    )
    expect(mine.size).toBe(54)
    // only the sub-projects either read reaches before the ceiling hold
    // their tasks: the member's, 30 open tasks each, and those of the first
    // 25 projects by name, 18 each, within the organization's 10,000
    for (const [i, p] of all.tops.entries())
      for (const sub of all.subsOf.get(p.id) ?? [])
        if (mine.has(sub.id)) await plantOpen(t, sub, 30, owners, 100 * i)
        else if (i < 25) await plantOpen(t, sub, 18, owners, 100 * i)
    await withReach(t)
    await countOrg(t, f.org.id)
    for (const [label, who] of [
      ['an admin', f.admin],
      ['a member in 3 teams', me],
    ] as const) {
      const bound = await agendaRead(t, who, ALL)
      record(
        `All projects over 200 projects for ${label}, the counts bound`,
        bound.answer,
        bound.read,
      )
      expect(bound.answer).toEqual({ state: 'over_ceiling', ceiling: TEAM_SYNC_TASKS })
    }
    await t.run((ctx) => unstampOverview(ctx.db, f.org.id))
    for (const [label, who] of [
      ['an admin', f.admin],
      ['a member in 3 teams', me],
    ] as const) {
      const counting = await agendaRead(t, who, ALL)
      record(
        `All projects over 200 projects for ${label}, while counting`,
        counting.answer,
        counting.read,
      )
      expect(counting.answer).toEqual({ state: 'over_ceiling', ceiling: TEAM_SYNC_TASKS })
    }
  })

  it('answers an everyday project whose 90 tasks 90 people of a roster of 1,000 own', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const me = await seatOf(t, f)
    const roster = await plantRoster(t, f.org.id, 994)
    const shared = await plantSharedTops(t, f, me, { tops: 1, subs: 3 })
    for (const [k, sub] of shared.subs.entries())
      await plantTasks(t, sub, 30, (i) => ({
        ...openOf(i),
        assignee_id: roster[30 * k + i].id,
      }))
    await withReach(t)
    await countOrg(t, f.org.id)
    const { answer, read } = await agendaRead(t, me, projectScope(shared.tops[0]))
    record('an everyday project whose 90 tasks 90 people own', answer, read)
    expect(okOf(answer).people).toHaveLength(90)
  })
})

/* An everyday open task `i`, scheduled in NOW's week with remaining hours,
 * due in two weeks. */
const openOf = (i: number): Partial<Doc<'issues'>> & { text?: string } => ({
  ...ordinary(i),
  status: (['todo', 'progress', 'review'] as const)[i % 3],
  start_week: NOW_WEEK,
  end_week: dayPlus(NOW_WEEK, 7),
  remaining_hours: (i % 8) + 1,
  due_date: dayPlus(NOW_WEEK, 18),
})

/* 40 archived sub-projects of `top`, beside its live ones. */
async function plantArchivedSubs(t: T, f: OrgFixture, top: Doc<'projects'>): Promise<void> {
  await t.run(async (ctx) => {
    for (let k = 0; k < 40; k++) {
      const name = `${top.name} archived ${k}`
      await ctx.db.insert('projects', {
        id: uuid(),
        org_id: f.org.id,
        type: 'project',
        parent_id: top.id,
        key: `A${k}`,
        name,
        name_key: nameKey(name),
        description: '',
        sort_order: 100 + k,
        num: 900_000 + k,
        track_delay: true,
        created_at: NOW,
        archived_at: NOW,
      })
    }
  })
}

/* The loads' measured size (lib/teamSyncAgenda.ts AGENDA), on demand with
 * QIVO_AGENDA_ORG_OPEN=1, one size with `-t`, as the Overview's health
 * table measured its own (tests/overviewHealth.test.ts QIVO_HEALTH_ORG_OPEN).
 * Each case keeps an everyday project (3 sub-projects of 30 open tasks, 10
 * owners, read through a team's share) and raises one figure, the
 * organization's open tasks, all held by those 10 owners, in projects the
 * reader is not shared, in sub-projects of 30 open tasks, three to a
 * project, so each owner's scheduled work spans every one of them. It logs
 * what the agenda read and how many walkers' weeks and rows' delays it
 * gave. */
describe.runIf(process.env.QIVO_AGENDA_ORG_OPEN === '1')(
  "the organization's open tasks, on demand",
  () => {
    for (const each of [300, 350, 400, 450, 500, 650])
      it(`reads an everyday project whose 10 owners hold ${each * 10} open tasks`, async () => {
        const c = await sharedCase({ tops: 1, subs: 3 })
        for (const sub of c.subs)
          await plantTasks(c.t, sub, 30, (i) => ({
            ...openOf(i),
            assignee_id: c.owners[i % 10].id,
          }))
        await withReach(c.t)
        await countOrg(c.t, c.f.org.id)
        let left = each * 10 - 90
        for (let i = 0; left > 0; i++) {
          const top = await plantProject(c.t, { org_id: c.f.org.id, name: `Elsewhere ${i}` })
          for (let k = 0; k < 3 && left > 0; k++) {
            const n = Math.min(30, left)
            left -= n
            const sub = await plantProject(c.t, {
              org_id: c.f.org.id,
              type: 'project',
              parent_id: top.id,
              name: `Elsewhere ${i}-${k}`,
            })
            await plantTasks(c.t, sub, n, (j) => ({
              ...ordinary(j),
              assignee_id: c.owners[Math.floor(j / 2) % 10].id,
              ...(j % 2 === 0
                ? { start_week: NOW_WEEK, end_week: dayPlus(NOW_WEEK, 21), remaining_hours: 2 }
                : {}),
            }))
          }
        }
        const { answer, read } = await agendaRead(c.t, c.me, projectScope(c.tops[0]))
        record(`the scope's 10 owners holding ${each * 10} open tasks`, answer, read)
        const ok = okOf(answer)
        expect(ok.people.every((p) => p.week.state === 'ok' || p.week.reason === 'loads')).toBe(
          true,
        )
      })
  },
)

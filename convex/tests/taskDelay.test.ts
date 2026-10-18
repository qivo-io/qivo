/* `delay` on REST and MCP task rows, the app's projected delay
 * (lib/machineDelay.ts):
 *
 *   1. Each reader's verdicts are the ones the app computes from the
 *      snapshot it serves the same person, on list rows and single reads
 *      of both surfaces, null where the project does not track delay.
 *   2. The single read's load, read through the owner's own tasks, is the
 *      list's, read from the organization's, for random organizations.
 *   3. Today is the request's UTC day, and a verdict reads the owner's other
 *      work only when it can change the answer.
 *
 * delayRules.test.ts shows the shared rules agree on the two week grids. */
/// <reference types="vite/client" />

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isoToWeek, setWeekConfig, TODAY_ISO, tsToWeek, weekToISO } from '../../src/lib/dates'
import { computeDelayMap, type DelayIssue } from '../../src/lib/delay'
import {
  type DatedGroupIssue,
  groupSpan,
  isIssueDone,
  isIssueGroup,
} from '../../src/lib/issueGroups'
import { DEFAULT_PLANNABLE_HOURS, type LoadSpan, plannableHoursOf } from '../../src/lib/workload'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { byId } from '../lib/db'
import { type DelayJson, delayClock, ownerLoadSpans } from '../lib/machineDelay'
import { taskOwnerId } from '../lib/review'
import { orgProjectView } from '../lib/visibility'
import { weekGrid } from '../lib/workload'
import { orgLoadRows } from '../planning'
import {
  as,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  plantProject,
  restArchivedPage,
  restTasks,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

/* A Wednesday at noon UTC, the same day in every likely time zone. */
const NOW = '2026-10-14T12:00:00.000Z'

/* The first days of the weeks around NOW, Monday weeks: W[0] holds NOW. */
const W = (offset: number) =>
  new Date(Date.parse('2026-10-12T00:00:00.000Z') + offset * 7 * 86_400_000)
    .toISOString()
    .slice(0, 10)

/* --------------------------------------------------------------- fixture */

type Fx = OrgFixture & {
  t: T
  /** a sub-project of TBED the guest cannot see */
  sib: Doc<'projects'>
  /** a person whose profile has no plannable hours (legacy) */
  lee: Doc<'profiles'>
}

/* withOrg, with FW, PCB and a sub-project the guest cannot see tracking
 * delay, the agent holding Edit on FW and PCB (so it is staff that cannot
 * see the sub-project) and a person without plannable hours. */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  const sib = await plantHiddenSibling(t, f, f.guest)
  const lee = await t.run(async (ctx) => {
    for (const project_id of [f.sub.id, f.sub2.id]) {
      await ctx.db.insert('project_access', { project_id, profile_id: f.agent.id, level: 'user' })
    }
    for (const p of [f.sub, f.sub2, sib]) {
      const row = await byId(ctx, 'projects', p.id)
      if (row !== null) await ctx.db.patch(row._id, { track_delay: true })
    }
    const _id = await ctx.db.insert('profiles', {
      id: uuid(),
      org_id: f.org.id,
      name: 'Lee',
      initials: 'LE',
      color: '#7a7ad0',
      org_role: 'user',
      active: true,
      kind: 'person',
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'profiles'>
  })
  return { t, ...f, sib, lee }
}

const task = (fx: Fx, over: Partial<Doc<'issues'>> = {}) =>
  plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, ...over })

/* The tasks of the verdict cases, by what each shows. */
async function cases(fx: Fx) {
  const scheduled = (start: number, end: number, hours?: number) => ({
    start_week: W(start),
    end_week: W(end),
    ...(hours === undefined ? {} : { remaining_hours: hours, remaining_set_at: NOW }),
  })
  // 70 hours of the user's this week and next, in a project the guest
  // cannot see, which leaves the user 5 free hours a week
  await task(fx, { project_id: fx.sib.id, assignee_id: fx.user.id, ...scheduled(0, 1, 70) })
  return {
    // staff count the hidden load and project the finish two weeks out;
    // the guest does not see that load and projects it for this week
    squeezed: await task(fx, {
      title: 'Squeezed',
      assignee_id: fx.user.id,
      ...scheduled(0, 1, 20),
    }),
    // an agent's capacity is unbounded
    agentic: await task(fx, {
      title: 'Agentic',
      assignee_id: fx.agent.id,
      due_date: W(1),
      ...scheduled(0, 1, 500),
    }),
    // no plannable hours means 32, not the organization's 40
    legacy: await task(fx, { title: 'Legacy', assignee_id: fx.lee.id, ...scheduled(0, 0, 34) }),
    // the reviewer owns a task in review
    reviewed: await task(fx, {
      title: 'Reviewed',
      status: 'review',
      assignee_id: fx.user.id,
      reviewer_id: fx.lee.id,
      ...scheduled(0, 0, 2),
    }),
    // late on a passed due date alone, with no week to project
    overdue: await task(fx, { title: 'Overdue', due_date: '2026-10-01' }),
    // a passed plan without an owner is projected for this week
    stale: await task(fx, { title: 'Stale', ...scheduled(-2, -1) }),
    // measured two weeks ago, so the work since then counts as done
    measured: await task(fx, {
      title: 'Measured',
      assignee_id: fx.guest.id,
      start_week: W(-3),
      end_week: W(1),
      remaining_hours: 100,
      remaining_set_at: '2026-09-30T10:00:00.000Z',
    }),
    done: await task(fx, { title: 'Done', status: 'done', due_date: '2026-10-01' }),
    nothing: await task(fx, { title: 'Nothing to judge' }),
    // PCB stops tracking below
    pcb: await task(fx, { title: 'Board', project_id: fx.sub2.id, due_date: '2026-10-01' }),
    // a group late for staff, whose subtask in sib ends after the due week;
    // the guest sees only the subtask that ends in time, so no verdict
    group: await (async () => {
      const g = await task(fx, { title: 'Group', due_date: W(2) })
      await task(fx, { parent_id: g.id, ...scheduled(0, 1) })
      await task(fx, { parent_id: g.id, project_id: fx.sib.id, ...scheduled(0, 4) })
      return g
    })(),
    archived: await task(fx, { title: 'Archived', due_date: '2026-10-01', archived_at: NOW }),
  }
}

/* What the app shows `person` as delay, by task id: the snapshot it serves
 * them, shaped and projected the way the store's rebuild does
 * (src/store/viewModels.ts shapeIssue, src/store/planner.ts rebuild), with
 * the app's grid anchored at NOW. A project that does not track delay
 * paints nothing (planner.ts tracksDelay). */
async function appDelays(fx: Fx, person: Doc<'profiles'>): Promise<Map<string, DelayJson | null>> {
  setWeekConfig(fx.org.week_start, fx.org.week_one_rule, new Date(NOW))
  const snap = await as(fx.t, person).query(api.snapshot.forMe, {})
  if (snap === null) throw new Error(`${person.name} has no snapshot`)
  const rows = snap.issues.filter((i) => i.org_id === fx.org.id)
  const byId: Record<string, DatedGroupIssue> = {}
  for (const r of rows) {
    const start = r.start_week != null ? isoToWeek(r.start_week) : null
    byId[r.id] = {
      id: r.id,
      status: r.status,
      children: rows.filter((c) => c.parent_id === r.id).map((c) => c.id),
      hasHiddenSubtasks: r.has_hidden_subtasks,
      start,
      end:
        r.end_week != null ? Math.max(start ?? isoToWeek(r.end_week), isoToWeek(r.end_week)) : null,
    }
  }
  const capacity = new Map(
    snap.profiles.map((p) => [
      p.id,
      plannableHoursOf({ plannableHours: p.plannable_hours ?? null, kind: p.kind }),
    ]),
  )
  const load = new Map<string, LoadSpan[]>()
  for (const r of snap.orgLoad) {
    const spans = load.get(r.owner_id) ?? []
    spans.push({
      issueUuid: r.issue_id || null,
      start: isoToWeek(r.start_week),
      end: isoToWeek(r.end_week),
      remaining: r.remaining != null ? Number(r.remaining) : 0,
      remainingSet: r.remaining_set_at != null ? tsToWeek(r.remaining_set_at) : null,
    })
    load.set(r.owner_id, spans)
  }
  const issues = rows.map((r): DelayIssue => {
    const vm = byId[r.id]
    const isGroup = isIssueGroup(vm)
    const span = groupSpan(vm, byId)
    const owner = taskOwnerId(r, isGroup) ?? null
    return {
      uuid: r.id,
      status: r.status,
      isGroup,
      isDone: isIssueDone(vm, byId),
      partial: span?.partial ?? false,
      owner,
      start: span ? span.start : (vm.start ?? null),
      end: span ? span.end : (vm.end ?? null),
      dueWeek: r.due_date ? isoToWeek(r.due_date) : null,
      duePast: !!r.due_date && r.due_date < TODAY_ISO,
      remaining: r.remaining_hours != null ? Number(r.remaining_hours) : undefined,
      remainingSet: r.remaining_set_at != null ? tsToWeek(r.remaining_set_at) : null,
      capacity: (owner && capacity.get(owner)) || DEFAULT_PLANNABLE_HOURS,
    }
  })
  const delays = computeDelayMap(issues, load)
  const tracks = new Map(snap.projects.map((p) => [p.id, p.track_delay !== false]))
  return new Map(
    rows.map((r) => {
      const d = delays.get(r.id)
      const shown =
        tracks.get(r.project_id) && d
          ? { status: d.status, projected_end_week: d.fin === null ? null : weekToISO(d.fin) }
          : null
      return [r.id, shown]
    }),
  )
}

type Row = { id: string; title: string; delay: DelayJson | null }

/* Every read of `ids` as `callerId`, which must agree: REST and MCP list
 * rows and single reads. */
async function everyRead(fx: Fx, callerId: string, ids: readonly string[], now = NOW) {
  const read = { callerId, access: 'read', now } as const
  const rest = await restTasks(fx.t, { ...read, limit: '200' })
  const mcp = JSON.parse(await fx.t.query(internal.machine.mcp.listIssues, { ...read, limit: 200 }))
  const out = new Map<string, DelayJson | null>()
  for (const id of ids) {
    const restOne = await fx.t.query(internal.machine.rest.getIssue, { ...read, ref: id })
    const mcpOne = JSON.parse(await fx.t.query(internal.machine.mcp.getIssue, { ...read, ref: id }))
    const listed = [rest.find((r) => r.id === id), (mcp as Row[]).find((r) => r.id === id)]
    const values = [restOne.delay, mcpOne.delay, ...listed.filter((r) => r).map((r) => r?.delay)]
    for (const v of values) expect(v, `${restOne.title} for ${callerId}`).toEqual(values[0])
    out.set(id, restOne.delay)
  }
  return out
}

/* ------------------------------------------------- 1. the app's verdicts */

describe('delay is the app’s projected delay for each reader', () => {
  it('matches what the app shows the same person, on every read', async () => {
    const fx = await setup()
    const c = await cases(fx)
    await fx.t.run(async (ctx) => {
      const pcb = await byId(ctx, 'projects', fx.sub2.id)
      if (pcb !== null) await ctx.db.patch(pcb._id, { track_delay: false })
    })
    for (const person of [fx.admin, fx.guest]) {
      const app = await appDelays(fx, person)
      const listed = await restTasks(fx.t, { callerId: person.id, access: 'read', now: NOW })
      expect(listed.map((r) => r.id).sort()).toEqual([...app.keys()].sort())
      const ours = await everyRead(fx, person.id, [...app.keys()])
      for (const [id, expected] of app) {
        const title = listed.find((r) => r.id === id)?.title
        expect(ours.get(id), `${person.name} ${title}`).toEqual(expected)
      }
    }
    const verdict = (status: DelayJson['status'], week: number | null) => ({
      status,
      projected_end_week: week === null ? null : W(week),
    })
    const admin = await everyRead(
      fx,
      fx.admin.id,
      Object.values(c).map((i) => i.id),
    )
    const guest = await everyRead(fx, fx.guest.id, [c.squeezed.id, c.group.id])
    expect(admin.get(c.squeezed.id)).toEqual(verdict('behind', 2))
    expect(guest.get(c.squeezed.id)).toEqual(verdict('ok', 0))
    expect(admin.get(c.agentic.id)).toEqual(verdict('ok', 0))
    expect(admin.get(c.legacy.id)).toEqual(verdict('behind', 1))
    // Legacy's 34 hours fill Lee's 32-hour week
    expect(admin.get(c.reviewed.id)).toEqual(verdict('behind', 1))
    expect(admin.get(c.overdue.id)).toEqual(verdict('late', null))
    expect(admin.get(c.stale.id)).toEqual(verdict('behind', 0))
    expect(admin.get(c.measured.id)).toEqual(verdict('ok', 0))
    expect(admin.get(c.group.id)).toEqual(verdict('late', 4))
    expect(guest.get(c.group.id)).toBeNull()
    for (const quiet of [c.done, c.nothing, c.pcb, c.archived]) {
      expect(admin.get(quiet.id), quiet.title).toBeNull()
    }
    // an archived page's rows carry none either
    const page = await restArchivedPage(fx.t, {
      callerId: fx.admin.id,
      access: 'read',
      now: NOW,
      project: 'FW',
    })
    expect(page.tasks.find((r) => r.id === c.archived.id)?.delay).toBeNull()
  })
})

/* ------------------------------------------- 2. the two ways to the load */

describe('a single read’s load is the list’s load', () => {
  it('agrees for random organizations, readers and owners', async () => {
    const owners = ['user', 'guest', 'agent', 'lee'] as const
    const projects = ['sub', 'sub2', 'sib', 'arc'] as const
    const spec = fc.array(
      fc.record({
        owner: fc.constantFrom(...owners, null),
        reviewer: fc.constantFrom(...owners, null),
        project: fc.constantFrom(...projects),
        status: fc.constantFrom('backlog', 'todo', 'progress', 'review', 'done'),
        paused: fc.integer({ min: 0, max: 5 }).map((n) => n === 0),
        start: fc.option(fc.integer({ min: -4, max: 4 }), { nil: null }),
        length: fc.integer({ min: 0, max: 4 }),
        hours: fc.option(fc.integer({ min: 0, max: 120 }), { nil: null, freq: 8 }),
        measured: fc.boolean(),
        due: fc.option(fc.integer({ min: -3, max: 6 }), { nil: null }),
        parent: fc.option(fc.nat(), { nil: null, freq: 2 }),
        archived: fc.integer({ min: 0, max: 5 }).map((n) => n === 0),
      }),
      { minLength: 2, maxLength: 14 },
    )
    await fc.assert(
      fc.asyncProperty(spec, async (tasks) => {
        const fx = await setup()
        const arc = await plantProject(fx.t, {
          org_id: fx.org.id,
          type: 'project',
          parent_id: fx.meta.id,
          archived_at: NOW,
          track_delay: true,
        })
        const people = { user: fx.user, guest: fx.guest, agent: fx.agent, lee: fx.lee }
        const where = { sub: fx.sub, sub2: fx.sub2, sib: fx.sib, arc }
        const planted: Doc<'issues'>[] = []
        for (const s of tasks) {
          const parent =
            s.parent === null || planted.length === 0
              ? undefined
              : planted[s.parent % planted.length]
          const over: Partial<Doc<'issues'>> = {
            project_id: where[s.project].id,
            status: s.status,
            paused: s.paused && s.status !== 'done' && s.status !== 'backlog',
          }
          if (s.owner !== null) over.assignee_id = people[s.owner].id
          if (s.reviewer !== null) over.reviewer_id = people[s.reviewer].id
          if (s.start !== null) {
            over.start_week = W(s.start)
            over.end_week = W(s.start + s.length)
          }
          if (s.hours !== null) {
            over.remaining_hours = s.hours
            over.remaining_set_at = s.measured ? '2026-10-01T09:00:00.000Z' : NOW
          }
          if (s.due !== null) over.due_date = W(s.due)
          if (parent !== undefined) over.parent_id = parent.id
          // an archived task's subtasks are archived with it
          if (s.archived || parent?.archived_at !== undefined) over.archived_at = NOW
          planted.push(await task(fx, over))
        }
        for (const reader of [fx.admin, fx.guest, fx.agent]) {
          // the verdicts agree on every read (everyRead), and the load
          // behind them is the same rows
          const listed = await restTasks(fx.t, { callerId: reader.id, access: 'read', now: NOW })
          await everyRead(
            fx,
            reader.id,
            listed.map((r) => r.id),
          )
          await fx.t.run(async (ctx) => {
            const me = (await byId(ctx, 'profiles', reader.id)) as Doc<'profiles'>
            const grid = weekGrid(fx.org.week_start)
            const view = await orgProjectView(ctx, me)
            const roster = await ctx.db
              .query('profiles')
              .withIndex('by_org', (q) => q.eq('org_id', fx.org.id))
              .collect()
            const active = await ctx.db
              .query('issues')
              .withIndex('by_org_archived', (q) =>
                q.eq('org_id', fx.org.id).eq('archived_at', undefined),
              )
              .collect()
            const rows = orgLoadRows(me, view, new Set(roster.map((p) => p.id)), active)
            for (const owner of Object.values(people)) {
              const fromList = rows
                .filter((r) => r.owner_id === owner.id)
                .map((r) => ({
                  issueUuid: r.issue_id,
                  start: grid.ofDay(r.start_week),
                  end: grid.ofDay(r.end_week),
                  remaining: r.remaining,
                  remainingSet:
                    r.remaining_set_at === null ? null : grid.ofInstant(r.remaining_set_at),
                }))
              const fromOwner = await ownerLoadSpans(ctx, me, owner, grid, view)
              const key = (s: LoadSpan) => JSON.stringify(s)
              expect(fromOwner.map(key).sort(), `${owner.name} for ${me.name}`).toEqual(
                fromList.map(key).sort(),
              )
            }
          })
        }
      }),
      { numRuns: 25 },
    )
  }, 60_000)
})

/* -------------------------------------------- 3. the clock and the reads */

describe('today is the request’s UTC day', () => {
  it('turns a task due on Sunday late at the first UTC moment of Monday', async () => {
    const fx = await setup()
    // due on a Sunday, planned for that week
    const due = await task(fx, { due_date: '2026-10-18', start_week: W(0), end_week: W(0) })
    const at = async (now: string) => (await everyRead(fx, fx.admin.id, [due.id], now)).get(due.id)
    // 01:30 on Monday in Stockholm, still Sunday in UTC
    expect(await at('2026-10-18T23:30:00.000Z')).toEqual({
      status: 'ok',
      projected_end_week: W(0),
    })
    expect(await at('2026-10-19T00:30:00.000Z')).toEqual({
      status: 'late',
      projected_end_week: W(1),
    })
    expect(delayClock(fx.org, '2026-10-18T23:30:00.000Z').today).toBe('2026-10-18')
  })
})

describe('a verdict reads the owner’s other work only when it can change it', () => {
  /* 300 scheduled open tasks of `owner` in PCB, more than a read may take. */
  const busy = async (fx: Fx, owner: Doc<'profiles'>) => {
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 300; i++) {
        await ctx.db.insert('issues', {
          id: uuid(),
          org_id: fx.org.id,
          project_id: fx.sub2.id,
          num: 70_000 + i,
          title: `Load ${i}`,
          description: '',
          status: 'todo',
          priority: 'low',
          assignee_id: owner.id,
          start_week: W(0),
          end_week: W(2),
          remaining_hours: 1,
          remaining_set_at: NOW,
          paused: false,
          created_at: NOW,
          updated_at: NOW,
        })
      }
    })
  }
  const single = (fx: Fx, ref: string) =>
    fx.t.query(internal.machine.rest.getIssue, {
      callerId: fx.admin.id,
      access: 'read',
      now: NOW,
      ref,
    })

  it('reads none for an agent, whose capacity is unbounded', async () => {
    const fx = await setup(newT({ transactionLimits: { documentsRead: 250 } }))
    await busy(fx, fx.agent)
    const mine = await task(fx, {
      assignee_id: fx.agent.id,
      start_week: W(0),
      end_week: W(0),
      remaining_hours: 400,
      remaining_set_at: NOW,
    })
    expect((await single(fx, mine.id)).delay).toEqual({ status: 'ok', projected_end_week: W(0) })
  })

  it('reads none without remaining hours, and the owner’s tasks with them', async () => {
    const fx = await setup(newT({ transactionLimits: { documentsRead: 250 } }))
    await busy(fx, fx.user)
    const unestimated = await task(fx, {
      assignee_id: fx.user.id,
      start_week: W(0),
      end_week: W(0),
    })
    expect((await single(fx, unestimated.id)).delay).toEqual({
      status: 'ok',
      projected_end_week: W(0),
    })
    const estimated = await task(fx, {
      assignee_id: fx.user.id,
      start_week: W(0),
      end_week: W(0),
      remaining_hours: 10,
      remaining_set_at: NOW,
    })
    await expect(single(fx, estimated.id)).rejects.toThrow()
  })
})

describe('a projected finish past the year 9999', () => {
  it('keeps the verdict and leaves the week unknown, which no YYYY-MM-DD can say', async () => {
    const fx = await setup()
    const far = await task(fx, {
      assignee_id: fx.user.id,
      start_week: '9999-12-27',
      end_week: '9999-12-27',
      remaining_hours: 200,
      remaining_set_at: NOW,
    })
    expect((await everyRead(fx, fx.admin.id, [far.id])).get(far.id)).toEqual({
      status: 'behind',
      projected_end_week: null,
    })
  })
})

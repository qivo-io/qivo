/* The owner reader (lib/ownerLoads.ts) and the reads on it,
 * planning.ownerLoads and planning.assigneeLoad:
 *
 *   1. Each owner's spans are the organization-wide load rows of that owner
 *      (planning.ts orgLoadRows over the live tasks) and the app's rows
 *      from the workspace, for random organizations, readers and owners,
 *      and on Northstar.
 *   2. Guests and Viewers get another person's visible work and none of
 *      their hidden work (lib/loadRows.ts loadShown, the owner's option A);
 *      hidden rows below the bounds change nothing in their answer, and
 *      past the bounds the answer is unavailable and nothing more.
 *   3. Past a bound an owner is unavailable, or not_read after the first
 *      owner of a call, never fewer spans and never a Convex error, and the
 *      reads follow the owner's open work, not the organization. */

import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { isOrgStaff, OWN_READS } from '../lib/access'
import { byId } from '../lib/db'
import { groupTest, liveIn, liveTasksOf } from '../lib/liveTasks'
import type { OrgLoadRow } from '../lib/loadRows'
import { UNAVAILABLE_DELAY } from '../lib/machineDelay'
import { byLoadRow, OWNER_LOADS } from '../lib/ownerLoads'
import { taskOwnerId } from '../lib/review'
import { orgProjectView } from '../lib/visibility'
import { getIssue } from '../machine/rest'
import {
  type AssigneeLoadRow,
  assigneeLoad,
  LOAD_UNAVAILABLE,
  type OwnerLoadSpan,
  type OwnerLoadsJson,
  orgLoadRows,
  ownerLoads,
} from '../planning'
import {
  appLoadRows,
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantCopiedIssue,
  plantHiddenSibling,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  TODAY,
  uuid,
  withOrg,
  workspaceOf,
} from './helpers.setup'
import { plantNorthstar } from './northstar.setup'
import { withReach } from './projectReach.setup'

const DEFAULT_LOADS = structuredClone(OWNER_LOADS)
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
afterEach(() => {
  Object.assign(OWNER_LOADS, structuredClone(DEFAULT_LOADS))
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
})

/* --------------------------------------------------------------- fixture */

type Fx = OrgFixture & {
  t: T
  /** a sub-project of TBED that neither the guest nor the viewer can see */
  sib: Doc<'projects'>
  /** an archived sub-project of TBED */
  shelf: Doc<'projects'>
  /** a sub-project of SKNK, which only the admin and the user see */
  away: Doc<'projects'>
  /** a staff user who sees TBED and not SKNK */
  user2: Doc<'profiles'>
}

/* withOrg, with a sub-project of TBED hidden from the guest and the viewer,
 * an archived sub-project of TBED, a sub-project of SKNK and a second staff
 * user who sees only TBED. */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  const sib = await plantHiddenSibling(t, f, f.guest)
  await plantHiddenSibling(t, f, f.viewer)
  const shelf = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: f.meta.id,
    key: 'SHELF',
    archived_at: NOW,
  })
  const away = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: f.hidden.id,
    key: 'AWAY',
  })
  const user2 = await plantSeat(t, {
    org_id: f.org.id,
    name: 'User Two',
    auth_user_id: `auth_${uuid()}`,
    email: 'user2@testbed.test',
    accepted_at: NOW,
  })
  await t.run((ctx) =>
    ctx.db.insert('project_access', { project_id: f.meta.id, profile_id: user2.id, level: 'user' }),
  )
  return { t, ...f, sib, shelf, away, user2 }
}

const task = (fx: Fx, over: Partial<Doc<'issues'>> = {}) =>
  plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, ...over })

/* Scheduled with remaining hours, in September 2026. */
const plan = (hours = 3, start = '2026-09-07', end = '2026-09-14') => ({
  start_week: start,
  end_week: end,
  remaining_hours: hours,
  remaining_set_at: NOW,
})

/* Task numbers for plantMany, clear of the fixtures' own. */
let bulkNum = 50_000

/* `count` active tasks in `project_id` without a text copy, titled at the
 * title cap, in one transaction. */
const plantMany = (
  t: T,
  orgId: string,
  count: number,
  over: Partial<Doc<'issues'>> & { project_id: string },
) =>
  t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert('issues', {
        id: uuid(),
        org_id: orgId,
        num: bulkNum++,
        title: `Bulk ${i}`,
        status: 'todo',
        priority: 'medium',
        paused: false,
        created_at: NOW,
        updated_at: NOW,
        ...over,
      })
    }
  })

/* Turns Delay tracking on in FW. */
const tracksDelay = (fx: Fx) =>
  fx.t.run(async (ctx) => {
    const fw = await byId(ctx, 'projects', fx.sub.id)
    if (fw !== null) await ctx.db.patch(fw._id, { track_delay: true })
  })

/** planning.ownerLoads for `caller`. */
const loads = (t: T, fx: Pick<Fx, 'org'>, caller: Doc<'profiles'>, ownerIds: string[]) =>
  as(t, caller).query(api.planning.ownerLoads, { org_id: fx.org.id, owner_ids: ownerIds })

/** One owner's spans in planning.ownerLoads for `caller`, which must be
 * `ok`. */
async function spansOf(fx: Fx, caller: Doc<'profiles'>, ownerId: string) {
  const answer = await loads(fx.t, fx, caller, [ownerId])
  const one = answer.owners[0]
  if (one?.state !== 'ok') throw new Error(`${ownerId} is ${one?.state} for ${caller.name}`)
  return one.spans
}

/* A public query's handler run inside `ctx`, so a test can read the
 * transaction's metrics after it. */
const handlerOf = <Args, Out>(fn: unknown) =>
  (fn as { _handler: (ctx: QueryCtx, args: Args) => Promise<Out> })._handler

/* A load row without its owner, as a span. */
const spanOf = ({ owner_id: _, ...span }: OrgLoadRow): OwnerLoadSpan => span

/** The organization-wide rows of `ownerId` for `reader`, as the REST and
 * MCP lists build them, as spans in the wire's order. */
const orgSpans = (fx: Fx, reader: Doc<'profiles'>, ownerId: string) =>
  fx.t.run(async (ctx) => {
    const me = (await byId(ctx, 'profiles', reader.id)) as Doc<'profiles'>
    const view = await orgProjectView(ctx, me)
    const roster = await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
      .collect()
    const live = await liveTasksOf(ctx, view.projects)
    return orgLoadRows(me, view, new Set(roster.map((p) => p.id)), live)
      .filter((row) => row.owner_id === ownerId)
      .map(spanOf)
      .sort(byLoadRow)
  })

/** The app's rows of `ownerId` for `reader`, from their workspace
 * (helpers.setup.ts appLoadRows), as spans in the wire's order. */
async function appSpans(t: T, reader: Doc<'profiles'>, ownerId: string) {
  const snap = await workspaceOf(as(t, reader))
  if (snap === null) throw new Error(`${reader.name} has no workspace`)
  return appLoadRows(snap)
    .filter((row) => row.owner_id === ownerId)
    .map(spanOf)
    .sort(byLoadRow)
}

/* A row of assigneeLoad as the comparisons sort it, its fields in name
 * order. */
const keyOf = (row: AssigneeLoadRow) =>
  JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1))))

/** assigneeLoad's rows by today's organization-wide rule, the fallback the
 * reader replaced: the person's scheduled tasks that are not Done or
 * paused among the organization's live tasks, groups by groupTest, with
 * title and project when the reader sees the project, sorted by keyOf. */
const assigneeOracle = (fx: Fx, reader: Doc<'profiles'>, ownerId: string) =>
  fx.t.run(async (ctx) => {
    const me = (await byId(ctx, 'profiles', reader.id)) as Doc<'profiles'>
    const owner = await byId(ctx, 'profiles', ownerId)
    if (owner === null || owner.org_id !== me.org_id) return []
    const view = await orgProjectView(ctx, me)
    const live = await liveTasksOf(ctx, view.projects)
    const isGroup = groupTest(live, liveIn(view.byUuid))
    const rows: AssigneeLoadRow[] = []
    for (const i of live) {
      if (taskOwnerId(i) !== ownerId || i.start_week === undefined || i.end_week === undefined)
        continue
      if (i.status === 'done' || i.paused || isGroup(i)) continue
      const vis = view.visible(i.project_id)
      if (!(isOrgStaff(me) || vis || ownerId === me.id)) continue
      rows.push({
        issue_id: vis ? i.id : null,
        title: vis ? i.title : null,
        project_id: vis ? i.project_id : null,
        project_name: vis ? (view.byUuid.get(i.project_id)?.name ?? null) : null,
        start_week: i.start_week,
        end_week: i.end_week,
        remaining: i.remaining_hours ?? null,
        remaining_set_at: i.remaining_set_at ?? null,
        visible: vis,
      })
    }
    return rows.map(keyOf).sort()
  })

const assigneeRows = async (t: T, reader: Doc<'profiles'>, ownerId: string) =>
  (await as(t, reader).query(api.planning.assigneeLoad, { assignee_id: ownerId })).map(keyOf).sort()

/* ------------------------------------------------------------ 1. parity */

describe('an owner’s spans are the organization’s rows of that owner', () => {
  it('agrees for random organizations, readers and owners', async () => {
    const people = ['user', 'user2', 'guest', 'viewer', 'agent', 'admin'] as const
    const projects = ['sub', 'sub2', 'sib', 'away', 'shelf'] as const
    const spec = fc.array(
      fc.record({
        owner: fc.constantFrom(...people, null),
        reviewer: fc.constantFrom(...people, null),
        project: fc.constantFrom(...projects),
        status: fc.constantFrom('backlog', 'todo', 'progress', 'review', 'done'),
        paused: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
        start: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null, freq: 4 }),
        length: fc.integer({ min: 0, max: 3 }),
        hours: fc.option(fc.constantFrom(0, 2, 5, 13), { nil: null, freq: 6 }),
        measured: fc.boolean(),
        parent: fc.option(fc.nat(), { nil: null, freq: 2 }),
        archived: fc.integer({ min: 0, max: 6 }).map((n) => n === 0),
      }),
      { minLength: 2, maxLength: 14 },
    )
    await fc.assert(
      fc.asyncProperty(spec, async (tasks) => {
        const fx = await setup()
        const who = {
          user: fx.user,
          user2: fx.user2,
          guest: fx.guest,
          viewer: fx.viewer,
          agent: fx.agent,
          admin: fx.admin,
        }
        const where = { sub: fx.sub, sub2: fx.sub2, sib: fx.sib, away: fx.away, shelf: fx.shelf }
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
          if (s.owner !== null) over.assignee_id = who[s.owner].id
          if (s.reviewer !== null) over.reviewer_id = who[s.reviewer].id
          if (s.start !== null) {
            const week = (n: number) =>
              new Date(Date.parse('2026-09-07T00:00:00.000Z') + n * 7 * 86_400_000)
                .toISOString()
                .slice(0, 10)
            over.start_week = week(s.start)
            over.end_week = week(s.start + s.length)
          }
          if (s.hours !== null) {
            over.remaining_hours = s.hours
            over.remaining_set_at = s.measured ? '2026-09-01T09:00:00.000Z' : NOW
          }
          if (parent !== undefined) over.parent_id = parent.id
          // an archived task's subtasks are archived with it
          if (s.archived || parent?.archived_at !== undefined) over.archived_at = NOW
          planted.push(await task(fx, over))
        }
        const owners = Object.values(who)
        for (const reader of [fx.admin, fx.user2, fx.viewer, fx.guest]) {
          const answer = await loads(
            fx.t,
            fx,
            reader,
            owners.map((p) => p.id),
          )
          expect(answer.hidden).toBe(isOrgStaff(reader) ? 'counted' : 'own_only')
          for (const [i, owner] of owners.entries()) {
            const one = answer.owners[i]
            const label = `${owner.name} for ${reader.name}`
            expect(one?.owner_id, label).toBe(owner.id)
            if (one?.state !== 'ok') throw new Error(`${label} is ${one?.state}`)
            expect(one.spans, label).toEqual(await orgSpans(fx, reader, owner.id))
            expect(one.spans, `${label}, as the app derives it`).toEqual(
              await appSpans(fx.t, reader, owner.id),
            )
            expect(await assigneeRows(fx.t, reader, owner.id), `${label}, assigneeLoad`).toEqual(
              await assigneeOracle(fx, reader, owner.id),
            )
          }
        }
      }),
      { numRuns: 25 },
    )
  }, 240_000)

  it('agrees with the app on Northstar for Nora and Leo, for every person', async () => {
    const t = newT()
    const { org, profiles } = await plantNorthstar(t)
    await withReach(t)
    for (const key of ['nora', 'leo']) {
      const reader = profiles.find((p) => p.auth_user_id === `auth_${key}`)
      if (reader === undefined) throw new Error(`no ${key}`)
      const answer = await loads(
        t,
        { org },
        reader,
        profiles.map((p) => p.id),
      )
      const snap = await workspaceOf(as(t, reader))
      if (snap === null) throw new Error(`${key} has no workspace`)
      let spans = 0
      for (const [i, owner] of profiles.entries()) {
        const one = answer.owners[i]
        if (one?.state !== 'ok') throw new Error(`${owner.name} is ${one?.state} for ${key}`)
        const app = appLoadRows(snap)
          .filter((row) => row.owner_id === owner.id)
          .map(spanOf)
          .sort(byLoadRow)
        expect(one.spans, `${owner.name} for ${key}`).toEqual(app)
        spans += one.spans.length
      }
      // the dataset plans real work
      expect(spans).toBeGreaterThan(10)
    }
  }, 60_000)
})

/* -------------------------------------------------------- 2. disclosure */

describe('who receives which spans', () => {
  it('gives staff hidden spans without a task id, and guests and Viewers none of another person’s', async () => {
    const fx = await setup()
    const shown = await task(fx, { assignee_id: fx.user.id, ...plan(3) })
    // in SKNK, which user2 cannot see
    await task(fx, { project_id: fx.away.id, assignee_id: fx.user.id, ...plan(5) })
    // in the sibling the guest and the viewer cannot see, and user2 can
    const sibling = await task(fx, { project_id: fx.sib.id, assignee_id: fx.user.id, ...plan(7) })
    const span = (issue_id: string | null, remaining: number): OwnerLoadSpan => ({
      issue_id,
      start_week: '2026-09-07',
      end_week: '2026-09-14',
      remaining,
      remaining_set_at: NOW,
    })
    const counted = await loads(fx.t, fx, fx.user2, [fx.user.id])
    expect(counted).toEqual({
      hidden: 'counted',
      owners: [
        {
          owner_id: fx.user.id,
          state: 'ok',
          spans: [span(shown.id, 3), span(null, 5), span(sibling.id, 7)].sort(byLoadRow),
        },
      ],
    })
    for (const reader of [fx.guest, fx.viewer]) {
      // the visible span with its id, and nothing of the hidden ones
      expect(await loads(fx.t, fx, reader, [fx.user.id]), reader.name).toEqual({
        hidden: 'own_only',
        owners: [{ owner_id: fx.user.id, state: 'ok', spans: [span(shown.id, 3)] }],
      })
    }
  })

  it('gives a guest or Viewer their own hidden spans without a task id', async () => {
    const fx = await setup()
    for (const reader of [fx.guest, fx.viewer]) {
      await task(fx, { project_id: fx.sib.id, assignee_id: reader.id, ...plan(4) })
      const own = await task(fx, { assignee_id: reader.id, ...plan(2) })
      const spans = await spansOf(fx, reader, reader.id)
      expect(spans.map((s) => s.issue_id).sort()).toEqual([null, own.id].sort())
      // the admin sees both by id
      expect((await spansOf(fx, fx.admin, reader.id)).every((s) => s.issue_id !== null)).toBe(true)
    }
  })

  it('answers hidden spans alike in either creation order or project', async () => {
    const answer = async (order: 'ab' | 'ba' | 'apart') => {
      const fx = await setup()
      const away2 = await plantProject(fx.t, {
        org_id: fx.org.id,
        type: 'project',
        parent_id: fx.hidden.id,
      })
      const a = { project_id: fx.away.id, assignee_id: fx.user.id, ...plan(3) }
      const b = {
        project_id: order === 'apart' ? away2.id : fx.away.id,
        assignee_id: fx.user.id,
        ...plan(3, '2026-09-07', '2026-09-07'),
      }
      for (const one of order === 'ba' ? [b, a] : [a, b]) await task(fx, one)
      return {
        user2: await loads(fx.t, fx, fx.user2, [fx.user.id]),
        assignee: await as(fx.t, fx.user2).query(api.planning.assigneeLoad, {
          assignee_id: fx.user.id,
        }),
        ownerId: fx.user.id,
      }
    }
    const strip = (x: Awaited<ReturnType<typeof answer>>) => ({
      spans: x.user2.owners.map((o) => (o.state === 'ok' ? o.spans : o.state)),
      assignee: x.assignee,
    })
    const ab = strip(await answer('ab'))
    expect(strip(await answer('ba'))).toEqual(ab)
    expect(strip(await answer('apart'))).toEqual(ab)
    expect(ab.spans[0]).toHaveLength(2)
  })

  it('gives a guest the same answer about another person whatever their hidden work below the bounds', async () => {
    // the same visible work in two organizations, by the same ids, and
    // different hidden work of the same person
    const ids = { a: uuid(), b: uuid(), c: uuid() }
    const answer = async (hidden: 'few' | 'many') => {
      const t = newT()
      const fx = await setup(t)
      await tracksDelay(fx)
      await task(fx, { id: ids.a, num: 900, assignee_id: fx.user.id, ...plan(3) })
      await task(fx, { id: ids.b, num: 901, assignee_id: fx.user.id, ...plan(0, '2026-09-14') })
      await task(fx, { id: ids.c, num: 902, assignee_id: fx.user.id, ...plan(6) })
      if (hidden === 'few') {
        await task(fx, { project_id: fx.sib.id, assignee_id: fx.user.id, ...plan(9) })
      } else {
        // more hidden work: scheduled, Backlog, and In Review with the user
        // as reviewer
        await plantMany(t, fx.org.id, 40, {
          project_id: fx.sib.id,
          assignee_id: fx.user.id,
          ...plan(2),
        })
        await plantMany(t, fx.org.id, 20, {
          project_id: fx.sib.id,
          assignee_id: fx.user.id,
          status: 'backlog',
        })
        await plantMany(t, fx.org.id, 5, {
          project_id: fx.sib.id,
          assignee_id: fx.admin.id,
          reviewer_id: fx.user.id,
          status: 'review',
          ...plan(1),
        })
      }
      const [owner, task0] = [fx.user.id, ids.a]
      return {
        loads: (await loads(t, fx, fx.guest, [owner])).owners,
        assignee: await as(t, fx.guest).query(api.planning.assigneeLoad, { assignee_id: owner }),
        delay: (
          await t.query(internal.machine.rest.getIssue, {
            callerId: fx.guest.id,
            access: 'read',
            today: TODAY,
            ref: task0,
          })
        ).delay,
      }
    }
    const few = await answer('few')
    const many = await answer('many')
    // the owner's and the project's ids differ between the two
    // organizations
    const strip = (x: typeof few) => ({
      ...x,
      loads: x.loads.map(({ owner_id: _, ...o }) => o),
      assignee: x.assignee.map(({ project_id: _, ...row }) => row),
    })
    expect(strip(many)).toEqual(strip(few))
    expect(few.loads[0]?.state).toBe('ok')
  })

  it('answers a guest or Viewer unavailable, and nothing more, when hidden open work passes the bound', async () => {
    const fx = await setup()
    await tracksDelay(fx)
    const shown = await task(fx, { assignee_id: fx.user.id, ...plan(3) })
    await task(fx, { assignee_id: fx.user.id, ...plan(2, '2026-09-14') })
    await plantMany(fx.t, fx.org.id, 18, { project_id: fx.sib.id, assignee_id: fx.user.id })
    Object.assign(OWNER_LOADS, { open: 20 })
    for (const reader of [fx.guest, fx.viewer]) {
      const answer = await loads(fx.t, fx, reader, [fx.user.id])
      expect(answer.owners[0]?.state, reader.name).toBe('ok')
    }
    // one more hidden open task, which they cannot see
    await plantMany(fx.t, fx.org.id, 1, { project_id: fx.sib.id, assignee_id: fx.user.id })
    for (const reader of [fx.guest, fx.viewer]) {
      const answer = await loads(fx.t, fx, reader, [fx.user.id, fx.guest.id])
      expect(answer, reader.name).toEqual({
        hidden: 'own_only',
        owners: [
          { owner_id: fx.user.id, state: 'unavailable' },
          { owner_id: fx.guest.id, state: 'ok', spans: [] },
        ],
      })
      const refused = await expectRefusal(
        as(fx.t, reader).query(api.planning.assigneeLoad, { assignee_id: fx.user.id }),
        'rule',
      )
      expect(refused.data).toEqual({
        code: 'rule',
        reason: LOAD_UNAVAILABLE,
        message: "Qivo could not read all of this person's planned work in one request.",
      })
      const single = await fx.t.query(internal.machine.rest.getIssue, {
        callerId: reader.id,
        access: 'read',
        today: TODAY,
        ref: shown.id,
      })
      expect(single.delay).toEqual(UNAVAILABLE_DELAY)
    }
  })
})

describe('which tasks count', () => {
  it('leaves out groups, archived tasks and projects, and follows the review hand-off', async () => {
    const fx = await setup()
    const mine = { assignee_id: fx.user.id, ...plan(3) }
    const leaf = await task(fx, mine)
    // an active subtask in a live sub-project makes a group, whose stale
    // own hours never count
    const group = await task(fx, { ...mine, remaining_hours: 8 })
    await task(fx, { project_id: fx.sub2.id, parent_id: group.id })
    // a subtask only in the archived sub-project does not
    const shelved = await task(fx, { ...mine, remaining_hours: 4 })
    await task(fx, { project_id: fx.shelf.id, parent_id: shelved.id })
    // an archived task, a task of the archived sub-project and a task
    // whose project row is gone carry no load
    await task(fx, { ...mine, archived_at: NOW })
    await task(fx, { ...mine, project_id: fx.shelf.id })
    await task(fx, { ...mine, project_id: uuid() })
    // In Review: the reviewer's with one, the assignee's without, once
    // where the same person holds both roles
    const reviewed = await task(fx, { ...mine, status: 'review', reviewer_id: fx.admin.id })
    const unreviewed = await task(fx, { ...mine, status: 'review' })
    const both = await task(fx, { ...mine, status: 'review', reviewer_id: fx.user.id })
    const ids = async (ownerId: string) =>
      (await spansOf(fx, fx.admin, ownerId)).map((s) => s.issue_id).sort()
    expect(await ids(fx.user.id)).toEqual([leaf.id, shelved.id, unreviewed.id, both.id].sort())
    expect(await ids(fx.admin.id)).toEqual([reviewed.id])
    // back to the assignee once it leaves Review
    await fx.t.run((ctx) => ctx.db.patch(reviewed._id, { status: 'progress' }))
    expect(await ids(fx.admin.id)).toEqual([])
    expect(await ids(fx.user.id)).toContain(reviewed.id)
    // the stale group hours and the shelved leaf's in the order the wire
    // keeps: the same weeks, the unmeasured first, then fewer hours
    await fx.t.run((ctx) => ctx.db.patch(shelved._id, { remaining_set_at: undefined }))
    const spans = await spansOf(fx, fx.admin, fx.user.id)
    expect(spans[0]?.issue_id).toBe(shelved.id)
  })
})

describe('the owners of a call', () => {
  it('answers an unknown owner and one of another organization with no spans', async () => {
    const fx = await setup()
    await task(fx, { assignee_id: fx.user.id, ...plan(3) })
    const answer = await loads(fx.t, fx, fx.admin, [uuid(), fx.otherAdmin.id])
    expect(answer.owners.map((o) => o.state === 'ok' && o.spans)).toEqual([[], []])
  })

  it('counts an inactive person’s and an agent’s work', async () => {
    const fx = await setup()
    const away = await task(fx, { assignee_id: fx.user.id, ...plan(3) })
    const agentic = await task(fx, { assignee_id: fx.agent.id, ...plan(30) })
    await fx.t.run((ctx) => ctx.db.patch(fx.user._id, { active: false }))
    const answer = await loads(fx.t, fx, fx.admin, [fx.user.id, fx.agent.id])
    expect(answer.owners.map((o) => o.state === 'ok' && o.spans.map((s) => s.issue_id))).toEqual([
      [away.id],
      [agentic.id],
    ])
  })

  it('answers each owner once, in the order asked, whatever the case of the id', async () => {
    const fx = await setup()
    const answer = await loads(fx.t, fx, fx.admin, [
      fx.user.id.toUpperCase(),
      fx.guest.id,
      fx.user.id,
      fx.guest.id.toUpperCase(),
    ])
    expect(answer.owners.map((o) => o.owner_id)).toEqual([fx.user.id, fx.guest.id])
  })

  it('refuses more than OWNER_LOADS.owners people and a caller without a seat', async () => {
    const fx = await setup()
    const many = Array.from({ length: OWNER_LOADS.owners + 1 }, () => uuid())
    await expectRefusal(
      loads(fx.t, fx, fx.admin, many),
      'bad_request',
      new RegExp(`at most ${OWNER_LOADS.owners} people at a time`),
    )
    expect((await loads(fx.t, fx, fx.admin, many.slice(1))).owners).toHaveLength(OWNER_LOADS.owners)
    expect((await loads(fx.t, fx, fx.admin, [])).owners).toEqual([])
    await expectRefusal(loads(fx.t, fx, fx.otherAdmin, [fx.user.id]), 'forbidden')
  })
})

/* ------------------------------------------------------------ 3. bounds */

describe('past a bound an owner is unavailable, never fewer spans', () => {
  it('reads at most OWNER_LOADS.open open rows, Backlog, unscheduled and archived projects’ included', async () => {
    const fx = await setup(newT())
    const shown = await task(fx, { assignee_id: fx.user.id, ...plan(3) })
    await plantMany(fx.t, fx.org.id, 4, {
      project_id: fx.sub.id,
      assignee_id: fx.user.id,
      status: 'backlog',
    })
    await plantMany(fx.t, fx.org.id, 4, { project_id: fx.sub2.id, assignee_id: fx.user.id })
    // open tasks of an archived project are read, and carry no load
    await plantMany(fx.t, fx.org.id, 3, {
      project_id: fx.shelf.id,
      assignee_id: fx.user.id,
      ...plan(2),
    })
    // the same person assigned and reviewing counts twice
    await task(fx, { assignee_id: fx.user.id, reviewer_id: fx.user.id, status: 'review' })
    Object.assign(OWNER_LOADS, { open: 14 })
    expect((await spansOf(fx, fx.admin, fx.user.id)).map((s) => s.issue_id)).toEqual([shown.id])
    Object.assign(OWNER_LOADS, { open: 13 })
    expect((await loads(fx.t, fx, fx.admin, [fx.user.id])).owners).toEqual([
      { owner_id: fx.user.id, state: 'unavailable' },
    ])
  })

  it('reads none of the owner’s Done tasks', async () => {
    const fx = await setup()
    await task(fx, { assignee_id: fx.user.id, ...plan(3) })
    const measure = () =>
      as(fx.t, fx.admin).query(async (ctx) => {
        const out = await handlerOf<{ org_id: string; owner_ids: string[] }, OwnerLoadsJson>(
          ownerLoads,
        )(ctx, { org_id: fx.org.id, owner_ids: [fx.user.id] })
        const m = await ctx.meta.getTransactionMetrics()
        return { out, documents: m.documentsRead.used, ranges: m.databaseQueries.used }
      })
    const before = await measure()
    await plantMany(fx.t, fx.org.id, 3000, {
      project_id: fx.sub.id,
      assignee_id: fx.user.id,
      status: 'done',
      done_at: NOW,
      ...plan(1),
    })
    expect(await measure()).toEqual(before)
  })

  it('checks at most OWNER_LOADS.checks tasks for subtasks', async () => {
    const fx = await setup()
    await plantMany(fx.t, fx.org.id, 6, {
      project_id: fx.sub.id,
      assignee_id: fx.user.id,
      ...plan(1),
    })
    // not scheduled, no hours or paused: never checked
    await plantMany(fx.t, fx.org.id, 3, { project_id: fx.sub.id, assignee_id: fx.user.id })
    await plantMany(fx.t, fx.org.id, 2, {
      project_id: fx.sub.id,
      assignee_id: fx.user.id,
      ...plan(0),
    })
    await plantMany(fx.t, fx.org.id, 2, {
      project_id: fx.sub.id,
      assignee_id: fx.user.id,
      paused: true,
      ...plan(1),
    })
    Object.assign(OWNER_LOADS, { checks: 6 })
    expect(await spansOf(fx, fx.admin, fx.user.id)).toHaveLength(6)
    Object.assign(OWNER_LOADS, { checks: 5 })
    expect((await loads(fx.t, fx, fx.admin, [fx.user.id])).owners[0]?.state).toBe('unavailable')
    // assigneeLoad keeps the unestimated ones, so it checks those too
    Object.assign(OWNER_LOADS, { checks: 8 })
    expect(
      await as(fx.t, fx.admin).query(api.planning.assigneeLoad, { assignee_id: fx.user.id }),
    ).toHaveLength(8)
    Object.assign(OWNER_LOADS, { checks: 7 })
    const refused = await expectRefusal(
      as(fx.t, fx.admin).query(api.planning.assigneeLoad, { assignee_id: fx.user.id }),
      'rule',
    )
    expect((refused.data as { reason?: string }).reason).toBe(LOAD_UNAVAILABLE)
  })

  it('asks about at most OWNER_LOADS.projects live projects', async () => {
    const fx = await setup()
    const subs = [fx.sub, fx.sub2]
    for (let i = 0; i < 2; i++)
      subs.push(
        await plantProject(fx.t, { org_id: fx.org.id, type: 'project', parent_id: fx.meta.id }),
      )
    for (const p of subs) await task(fx, { project_id: p.id, assignee_id: fx.user.id, ...plan(1) })
    // the archived sub-project's task needs no question
    await task(fx, { project_id: fx.shelf.id, assignee_id: fx.user.id, ...plan(1) })
    Object.assign(OWNER_LOADS, { projects: 4 })
    expect(await spansOf(fx, fx.admin, fx.user.id)).toHaveLength(4)
    Object.assign(OWNER_LOADS, { projects: 3 })
    expect((await loads(fx.t, fx, fx.admin, [fx.user.id])).owners[0]?.state).toBe('unavailable')
  })

  it('answers the owners after the room ran out not_read, which fit when asked alone', async () => {
    const fx = await setup()
    await plantMany(fx.t, fx.org.id, 30, {
      project_id: fx.sub.id,
      assignee_id: fx.user.id,
      ...plan(1),
    })
    await plantMany(fx.t, fx.org.id, 30, {
      project_id: fx.sub2.id,
      assignee_id: fx.guest.id,
      ...plan(1),
    })
    await task(fx, { project_id: fx.sib.id, assignee_id: fx.viewer.id, ...plan(1) })
    const states = async (ids: string[]) =>
      (await loads(fx.t, fx, fx.admin, ids)).owners.map((o) => o.state)
    // the least room the user's load fits in alone
    let documents = 0
    do {
      documents += 4
      Object.assign(OWNER_LOADS, { call: { ...DEFAULT_LOADS.call, documents } })
    } while ((await states([fx.user.id]))[0] !== 'ok')
    expect(await states([fx.user.id, fx.guest.id, fx.viewer.id])).toEqual([
      'ok',
      'not_read',
      'not_read',
    ])
    // asked again, the first of them is read, and the next after it
    expect(await states([fx.guest.id, fx.viewer.id])).toEqual(['ok', 'not_read'])
    expect(await states([fx.viewer.id])).toEqual(['ok'])
  })

  it('answers a lone owner past the room unavailable, never not_read', async () => {
    const fx = await setup()
    await plantMany(fx.t, fx.org.id, 30, {
      project_id: fx.sub.id,
      assignee_id: fx.user.id,
      ...plan(1),
    })
    Object.assign(OWNER_LOADS, { call: { ...OWNER_LOADS.call, documents: 20 } })
    expect((await loads(fx.t, fx, fx.admin, [fx.user.id, fx.guest.id])).owners).toEqual([
      { owner_id: fx.user.id, state: 'unavailable' },
      { owner_id: fx.guest.id, state: 'not_read' },
    ])
  })

  it('answers owners whose spans pass OWNER_LOADS.spans not_read, the first one excepted', async () => {
    const fx = await setup()
    await plantMany(fx.t, fx.org.id, 4, {
      project_id: fx.sub.id,
      assignee_id: fx.user.id,
      ...plan(1),
    })
    await plantMany(fx.t, fx.org.id, 2, {
      project_id: fx.sub.id,
      assignee_id: fx.guest.id,
      ...plan(1),
    })
    Object.assign(OWNER_LOADS, { spans: 3 })
    const answer = await loads(fx.t, fx, fx.admin, [fx.user.id, fx.guest.id, fx.viewer.id])
    expect(answer.owners.map((o) => (o.state === 'ok' ? o.spans.length : o.state))).toEqual([
      4,
      'not_read',
      'not_read',
    ])
    const again = await loads(fx.t, fx, fx.admin, [fx.guest.id, fx.viewer.id])
    expect(again.owners.map((o) => (o.state === 'ok' ? o.spans.length : o.state))).toEqual([2, 0])
  })

  it('stops at the read’s room on task rows that still hold their text, never failing on a Convex limit', async () => {
    const fx = await setup()
    // the description cap in a three-byte script, about 60 KB a row
    const text = '漢'.repeat(20_000)
    for (let i = 0; i < 160; i++)
      await plantCopiedIssue(fx.t, {
        org_id: fx.org.id,
        project_id: fx.sub.id,
        assignee_id: fx.user.id,
        description: text,
        ...plan(1),
      })
    expect((await loads(fx.t, fx, fx.admin, [fx.user.id])).owners[0]?.state).toBe('unavailable')
    await expectRefusal(
      as(fx.t, fx.admin).query(api.planning.assigneeLoad, { assignee_id: fx.user.id }),
      'rule',
    )
  }, 60_000)
})

describe('an access check a bound stops', () => {
  it('makes the owner unavailable, not their work hidden or shown', async () => {
    const fx = await setup()
    // a task stored under SKNK itself, which the guest asks about for
    // navigation, past the parent's sub-projects it may read
    await task(fx, { project_id: fx.hidden.id, assignee_id: fx.guest.id, ...plan(2) })
    await task(fx, { assignee_id: fx.guest.id, ...plan(3) })
    expect(await spansOf(fx, fx.guest, fx.guest.id)).toHaveLength(2)
    Object.assign(OWN_READS, { subProjects: 0 })
    expect((await loads(fx.t, fx, fx.guest, [fx.guest.id])).owners).toEqual([
      { owner_id: fx.guest.id, state: 'unavailable' },
    ])
    await expectRefusal(
      as(fx.t, fx.guest).query(api.planning.assigneeLoad, { assignee_id: fx.guest.id }),
      'rule',
      /could not finish checking which projects you can see/,
    )
  })

  it('answers an owner whose check spent the instance’s room not_read after the first owner', async () => {
    const fx = await setup()
    // a project user2 sees only through their team's share on it; past
    // these bounds its check asks that team by itself, which teamReads 0
    // refuses (lib/access.ts roomSpent)
    const top = await plantProject(fx.t, { org_id: fx.org.id })
    const shared = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: top.id,
    })
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: fx.team.id,
        profile_id: fx.user2.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: shared.id,
        team_id: fx.team.id,
        level: 'user',
      })
    })
    await task(fx, { assignee_id: fx.user.id, ...plan(1) })
    await task(fx, { project_id: shared.id, assignee_id: fx.guest.id, ...plan(1) })
    expect((await loads(fx.t, fx, fx.user2, [fx.guest.id])).owners[0]?.state).toBe('ok')
    Object.assign(OWN_READS, { projectShares: 0, rows: 0, teamReads: 0 })
    const answer = await loads(fx.t, fx, fx.user2, [fx.user.id, fx.guest.id])
    expect(answer.owners.map((o) => o.state)).toEqual(['ok', 'not_read'])
    expect((await loads(fx.t, fx, fx.user2, [fx.guest.id])).owners).toEqual([
      { owner_id: fx.guest.id, state: 'unavailable' },
    ])
  })
})

/* What a read of `run` took, by Convex's counts. */
async function readsOf<R>(ctx: QueryCtx, run: () => Promise<R>) {
  const before = await ctx.meta.getTransactionMetrics()
  const out = await run()
  const after = await ctx.meta.getTransactionMetrics()
  return {
    out,
    ranges: after.databaseQueries.used - before.databaseQueries.used,
    documents: after.documentsRead.used - before.documentsRead.used,
    bytes: after.bytesRead.used - before.bytesRead.used,
  }
}

describe('the reads follow the owner’s open work, not the organization', () => {
  it('reads the same for an admin, a user and a guest however the organization grows', async () => {
    const fx = await setup()
    await tracksDelay(fx)
    const mine = { assignee_id: fx.user.id }
    const single = await task(fx, { ...mine, ...plan(6) })
    await task(fx, { ...mine, project_id: fx.sib.id, ...plan(4) })
    await task(fx, { ...mine, project_id: fx.away.id, ...plan(5) })
    const group = await task(fx, { ...mine, ...plan(2) })
    await task(fx, { parent_id: group.id, project_id: fx.sub2.id })
    await task(fx, { ...mine, status: 'backlog' })
    const measure = async (caller: Doc<'profiles'>) => {
      const loadsRead = await as(fx.t, caller).query((ctx) =>
        readsOf(ctx, () =>
          handlerOf<{ org_id: string; owner_ids: string[] }, OwnerLoadsJson>(ownerLoads)(ctx, {
            org_id: fx.org.id,
            owner_ids: [fx.user.id],
          }),
        ),
      )
      const assigneeRead = await as(fx.t, caller).query((ctx) =>
        readsOf(ctx, () =>
          handlerOf<{ assignee_id: string }, AssigneeLoadRow[]>(assigneeLoad)(ctx, {
            assignee_id: fx.user.id,
          }),
        ),
      )
      const singleRead = await as(fx.t, fx.admin).query((ctx) =>
        readsOf(ctx, () =>
          handlerOf<
            { callerId: string; access: 'read'; today: string; ref: string },
            { delay: unknown }
          >(getIssue)(ctx, { callerId: caller.id, access: 'read', today: TODAY, ref: single.id }),
        ),
      )
      return { loads: loadsRead, assignee: assigneeRead, single: singleRead }
    }
    const callers = [fx.admin, fx.user2, fx.guest]
    const before = []
    for (const caller of callers) before.push(await measure(caller))
    // 300 sub-projects in two more top-level projects, 3,000 tasks of other
    // people in them, 500 archived and 1,000 Done tasks of the owner, and
    // 50 teams none of the callers is in, sharing the new sub-projects
    const tops = [
      await plantProject(fx.t, { org_id: fx.org.id }),
      await plantProject(fx.t, { org_id: fx.org.id }),
    ]
    const subs: Doc<'projects'>[] = []
    for (let i = 0; i < 300; i++)
      subs.push(
        await plantProject(fx.t, {
          org_id: fx.org.id,
          type: 'project',
          parent_id: tops[i % 2]?.id,
        }),
      )
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 50; i++) {
        const team = uuid()
        await ctx.db.insert('teams', {
          id: team,
          org_id: fx.org.id,
          name: `Team ${i}`,
          track_delay_default: false,
          created_at: NOW,
        })
        for (let j = 0; j < 6; j++) {
          const sub = subs[(i * 6 + j) % subs.length]
          if (sub !== undefined)
            await ctx.db.insert('project_team_access', {
              project_id: sub.id,
              team_id: team,
              level: 'user',
            })
        }
      }
    })
    for (const [i, sub] of subs.entries())
      await plantMany(fx.t, fx.org.id, 10, {
        project_id: sub.id,
        assignee_id: [fx.admin.id, fx.viewer.id, fx.agent.id][i % 3],
        ...plan(2),
      })
    await plantMany(fx.t, fx.org.id, 500, {
      project_id: fx.sub.id,
      ...mine,
      ...plan(1),
      archived_at: NOW,
    })
    await plantMany(fx.t, fx.org.id, 1000, {
      project_id: fx.sub.id,
      ...mine,
      ...plan(1),
      status: 'done',
      done_at: NOW,
    })
    for (const [i, caller] of callers.entries()) {
      const after = await measure(caller)
      expect(after, caller.name).toEqual(before[i])
      expect(after.loads.out.owners[0]?.state).toBe('ok')
      expect(after.single.out.delay).not.toEqual(UNAVAILABLE_DELAY)
    }
  }, 120_000)
})

/* A title at the title cap in a three-byte script. */
const LONG_TITLE = '計'.repeat(255)

describe('at the testing envelope', () => {
  it('reads an owner of 2,000 open tasks over 200 sub-projects each shared with 25 teams, and 49 more', async () => {
    const t = newT()
    const fx = await setup(t)
    const top = await plantProject(t, { org_id: fx.org.id, name: '計'.repeat(80) })
    const subs: Doc<'projects'>[] = []
    for (let i = 0; i < 200; i++)
      subs.push(
        await plantProject(t, {
          org_id: fx.org.id,
          type: 'project',
          parent_id: top.id,
          name: '計'.repeat(80),
          track_delay: true,
        }),
      )
    // a staff caller in 25 teams, each sharing all 200 sub-projects
    const caller = await plantSeat(t, {
      org_id: fx.org.id,
      name: 'Caller',
      auth_user_id: `auth_${uuid()}`,
      email: 'caller@testbed.test',
      accepted_at: NOW,
    })
    await t.run(async (ctx) => {
      for (let i = 0; i < 25; i++) {
        const team = uuid()
        await ctx.db.insert('teams', {
          id: team,
          org_id: fx.org.id,
          name: '計'.repeat(80),
          track_delay_default: false,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', {
          team_id: team,
          profile_id: caller.id,
          is_leader: false,
        })
        for (const sub of subs)
          await ctx.db.insert('project_team_access', {
            project_id: sub.id,
            team_id: team,
            level: 'user',
          })
      }
    })
    const busy = await plantSeat(t, { org_id: fx.org.id, name: 'Busy' })
    const others: Doc<'profiles'>[] = []
    for (let i = 0; i < 49; i++)
      others.push(await plantSeat(t, { org_id: fx.org.id, name: `Other ${i}` }))
    // 2,000 open tasks over the 200 sub-projects, 500 of them planned with
    // hours, 50 of those with a subtask, the rest in Backlog or unplanned
    const leafId = await t.run(async (ctx) => {
      let leaf = ''
      for (let i = 0; i < 2000; i++) {
        const sub = subs[i % 200] as Doc<'projects'>
        const planned = i < 500
        const id = uuid()
        await ctx.db.insert('issues', {
          id,
          org_id: fx.org.id,
          project_id: sub.id,
          num: bulkNum++,
          title: LONG_TITLE,
          status: planned ? 'progress' : i % 2 === 0 ? 'backlog' : 'todo',
          priority: 'medium',
          assignee_id: busy.id,
          paused: false,
          created_at: NOW,
          updated_at: NOW,
          ...(planned ? plan(4) : {}),
        })
        if (i === 1) leaf = id
        if (planned && i % 10 === 0)
          await ctx.db.insert('issues', {
            id: uuid(),
            org_id: fx.org.id,
            project_id: sub.id,
            parent_id: id,
            num: bulkNum++,
            title: LONG_TITLE,
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
          })
      }
      for (const [k, other] of others.entries())
        for (let i = 0; i < 40; i++)
          await ctx.db.insert('issues', {
            id: uuid(),
            org_id: fx.org.id,
            project_id: (subs[(k * 40 + i) % 200] as Doc<'projects'>).id,
            num: bulkNum++,
            title: LONG_TITLE,
            status: 'todo',
            priority: 'medium',
            assignee_id: other.id,
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            ...plan(2),
          })
      return leaf
    })
    const call = (ids: string[]) =>
      as(t, caller).query((ctx) =>
        readsOf(ctx, () =>
          handlerOf<{ org_id: string; owner_ids: string[] }, OwnerLoadsJson>(ownerLoads)(ctx, {
            org_id: fx.org.id,
            owner_ids: ids,
          }),
        ),
      )
    const alone = await call([busy.id])
    const one = alone.out.owners[0]
    if (one?.state !== 'ok') throw new Error(`the busy owner is ${one?.state}`)
    // the 500 planned, less the 50 groups
    expect(one.spans).toHaveLength(450)
    // with 49 more owners every owner is ok or not_read, and asking the
    // not_read ones again reads them all
    let ids = [busy.id, ...others.map((p) => p.id)]
    const calls: { ranges: number; documents: number; bytes: number }[] = []
    while (ids.length > 0) {
      const read = await call(ids)
      calls.push(read)
      const states = read.out.owners.map((o) => o.state)
      expect(states).not.toContain('unavailable')
      expect(states[0]).toBe('ok')
      ids = read.out.owners.filter((o) => o.state === 'not_read').map((o) => o.owner_id)
    }
    const assignee = await as(t, caller).query((ctx) =>
      readsOf(ctx, () =>
        handlerOf<{ assignee_id: string }, AssigneeLoadRow[]>(assigneeLoad)(ctx, {
          assignee_id: busy.id,
        }).then(
          (rows) => rows.length,
          (e: unknown) => String(e),
        ),
      ),
    )
    const single = await as(t, caller).query((ctx) =>
      readsOf(ctx, () =>
        handlerOf<
          { callerId: string; access: 'read'; today: string; ref: string },
          { delay: unknown }
        >(getIssue)(ctx, {
          callerId: caller.id,
          access: 'read',
          today: TODAY,
          ref: leafId,
        }).then((out) => out.delay),
      ),
    )
    // one more open task
    await plantMany(t, fx.org.id, 1, { project_id: subs[0]?.id ?? '', assignee_id: busy.id })
    expect((await call([busy.id])).out.owners[0]?.state).toBe('unavailable')
    // each read inside Convex's limits, the call's ceiling and one step
    // past it; measured at deecadb1: alone 999 ranges, 8,329 documents, 3.6 MB;
    // the 50 owners in two calls, 23 of them and then 27, 2,032 and 1,735
    // ranges, 9,272 and 7,385 documents, 4.7 and 2.5 MB; the single read
    // 1,125 ranges, 8,489 documents, 3.6 MB
    for (const read of [alone, assignee, single, ...calls]) {
      expect(read.ranges).toBeLessThan(4096)
      expect(read.documents).toBeLessThan(32_000)
      expect(read.bytes).toBeLessThan(16 * 1024 * 1024)
    }
    expect(calls.length).toBeGreaterThan(1)
    expect(assignee.out).toBe(450)
    expect(single.out).toEqual({ status: 'behind', projected_end_week: '2026-09-21' })
  }, 300_000)
})

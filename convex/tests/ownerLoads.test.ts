/* The owner reader (lib/ownerLoads.ts) and the reads on it,
 * planning.ownerLoads and planning.assigneeLoad:
 *
 *   1. Each owner's spans are the organization-wide load rows of that owner
 *      (orgLoad.setup.ts orgLoadRows over the live tasks) and the app's rows
 *      from the workspace, each with its task's project where it names the
 *      task, and each owner's paused list is their paused leaves in live
 *      projects the reader can see by the same two sources, for random
 *      organizations, readers and owners, and on Northstar.
 *   2. Guests and Viewers get another person's visible work and none of
 *      their hidden work (lib/loadRows.ts loadShown, the owner's option A),
 *      and no one gets a paused task of a project they cannot see; hidden
 *      rows below the bounds change nothing in their answer, and past the
 *      bounds the answer is unavailable and nothing more.
 *   3. Past a bound an owner is unavailable, or not_read after the first
 *      owner of a call, never fewer spans and never a Convex error, with
 *      paused work counted in the same bounds; the reads follow the owner's
 *      open work, not the organization, and the readers that do not ask for
 *      paused work read and answer as they did before it. */

import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { isOrgStaff, OWN_READS } from '../lib/access'
import { byId } from '../lib/db'
import { liveIn } from '../lib/liveTasks'
import type { OrgLoadRow } from '../lib/loadRows'
import { UNAVAILABLE_DELAY } from '../lib/machineDelay'
import { byLoadRow, OWNER_LOADS } from '../lib/ownerLoads'
import { taskOwnerId } from '../lib/review'
import { restWorkload } from '../machine/records'
import { getIssue } from '../machine/rest'
import {
  type AssigneeLoadRow,
  assigneeLoad,
  LOAD_UNAVAILABLE,
  type OwnerLoadSpan,
  type OwnerLoadsJson,
  type OwnerPausedSpan,
  ownerLoads,
  type WorkloadJson,
} from '../planning'
import {
  appLoadRows,
  appPausedRows,
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
  wholeOf,
  withReadingAdmin,
} from './helpers.setup'
import { plantNorthstar } from './northstar.setup'
import { groupTest, liveTasksOf, orgLoadRows } from './orgLoad.setup'
import { orgProjectView } from './orgProjectView.setup'
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
  const f = await withReadingAdmin(t)
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

/** One owner of planning.ownerLoads for `caller`, which must be `ok`. */
async function okOf(fx: Fx, caller: Doc<'profiles'>, ownerId: string) {
  const answer = await loads(fx.t, fx, caller, [ownerId])
  const one = answer.owners[0]
  if (one?.state !== 'ok') throw new Error(`${ownerId} is ${one?.state} for ${caller.name}`)
  return one
}

/** One owner's spans in planning.ownerLoads for `caller`, which must be
 * `ok`. */
const spansOf = async (fx: Fx, caller: Doc<'profiles'>, ownerId: string) =>
  (await okOf(fx, caller, ownerId)).spans

/** The task ids of one owner's paused list for `caller`, sorted. */
const pausedIds = async (fx: Fx, caller: Doc<'profiles'>, ownerId: string) =>
  (await okOf(fx, caller, ownerId)).paused.map((p) => p.issue_id).sort()

/* A public query's handler run inside `ctx`, so a test can read the
 * transaction's metrics after it. */
const handlerOf = <Args, Out>(fn: unknown) =>
  (fn as { _handler: (ctx: QueryCtx, args: Args) => Promise<Out> })._handler

/* A load row without its owner, as a span, with the project of its task
 * by `projectOf` where it names one. */
const spanOf =
  (projectOf: ReadonlyMap<string, string>) =>
  ({ owner_id: _, ...row }: OrgLoadRow): OwnerLoadSpan => ({
    ...row,
    project_id: row.issue_id === null ? null : (projectOf.get(row.issue_id) ?? 'missing'),
  })

/* Paused spans in the wire's order, by weeks, then the task id. */
function byPaused(a: OwnerPausedSpan, b: OwnerPausedSpan): number {
  for (const key of ['start_week', 'end_week', 'issue_id'] as const)
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  return 0
}

/** The organization-wide rows of `ownerId` for `reader`, as the REST and
 * MCP lists build them, as spans in the wire's order, and their paused
 * tasks among the same live tasks, those scheduled, not Done, paused, not
 * a group (groupTest), owned by them (taskOwnerId) in the reader's
 * organization and in a live project the reader can see, in the wire's
 * order. */
const orgOwner = (fx: Pick<Fx, 't'>, reader: Doc<'profiles'>, ownerId: string) =>
  fx.t.run(async (ctx) => {
    const me = (await byId(ctx, 'profiles', reader.id)) as Doc<'profiles'>
    const view = await orgProjectView(ctx, me)
    const roster = await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
      .collect()
    const live = await liveTasksOf(ctx, view.projects)
    const projectOf = new Map(live.map((i) => [i.id, i.project_id]))
    const spans = orgLoadRows(me, view, new Set(roster.map((p) => p.id)), live)
      .filter((row) => row.owner_id === ownerId)
      .map(spanOf(projectOf))
      .sort(byLoadRow)
    const projectLive = liveIn(view.byUuid)
    const isGroup = groupTest(live, projectLive)
    const inOrg = roster.some((p) => p.id === ownerId)
    const paused = live
      .filter(
        (i) =>
          inOrg &&
          i.paused &&
          i.status !== 'done' &&
          i.start_week !== undefined &&
          i.end_week !== undefined &&
          taskOwnerId(i) === ownerId &&
          projectLive(i.project_id) &&
          view.visible(i.project_id) &&
          !isGroup(i),
      )
      .map(
        (i): OwnerPausedSpan => ({
          issue_id: i.id,
          project_id: i.project_id,
          start_week: i.start_week ?? '',
          end_week: i.end_week ?? '',
        }),
      )
      .sort(byPaused)
    return { spans, paused }
  })

/** The rows of `ownerId` derived from a reader's published whole
 * (helpers.setup.ts wholeOf and appLoadRows), as spans in the wire's
 * order, each with its task's project from the whole, and the paused
 * tasks marked for them (appPausedRows), in the wire's order. */
function appOwnerOf(snap: NonNullable<Awaited<ReturnType<typeof wholeOf>>>, ownerId: string) {
  const projectOf = new Map(snap.issues.map((task) => [task.id, task.project_id]))
  const spans = appLoadRows(snap)
    .filter((row) => row.owner_id === ownerId)
    .map(spanOf(projectOf))
    .sort(byLoadRow)
  const paused = appPausedRows(snap)
    .filter((row) => row.owner_id === ownerId)
    .map(({ owner_id: _, ...row }): OwnerPausedSpan => row)
    .sort(byPaused)
  return { spans, paused }
}

/** The spans and paused tasks of `ownerId` for `reader`, derived from
 * their published whole (appOwnerOf). */
async function appOwner(t: T, reader: Doc<'profiles'>, ownerId: string) {
  const snap = await wholeOf(t, reader)
  if (snap === null) throw new Error(`${reader.name} has no workspace`)
  return appOwnerOf(snap, ownerId)
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
          // a status write clears a pause, so a paused Backlog or Done task
          // is legacy data, planted here directly
          const over: Partial<Doc<'issues'>> = {
            project_id: where[s.project].id,
            status: s.status,
            paused: s.paused,
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
          const staff = isOrgStaff(reader)
          const answer = await loads(
            fx.t,
            fx,
            reader,
            owners.map((p) => p.id),
          )
          expect(answer.hidden).toBe(staff ? 'counted' : 'own_only')
          // a guest or Viewer gets one owner a call, so asks for each alone
          const answered = staff
            ? answer.owners
            : await Promise.all(
                owners.map(async (p) => (await loads(fx.t, fx, reader, [p.id])).owners[0]),
              )
          if (!staff) {
            expect(answer.owners.slice(1).map((o) => o.state)).toEqual(
              owners.slice(1).map(() => 'not_read'),
            )
          }
          for (const [i, owner] of owners.entries()) {
            const one = answered[i]
            const label = `${owner.name} for ${reader.name}`
            expect(one?.owner_id, label).toBe(owner.id)
            if (one?.state !== 'ok') throw new Error(`${label} is ${one?.state}`)
            const org = await orgOwner(fx, reader, owner.id)
            const app = await appOwner(fx.t, reader, owner.id)
            expect(one.spans, label).toEqual(org.spans)
            expect(one.spans, `${label}, as the app derives it`).toEqual(app.spans)
            expect(one.paused, `${label}, paused`).toEqual(org.paused)
            expect(one.paused, `${label}, paused as the app derives it`).toEqual(app.paused)
            expect(await assigneeRows(fx.t, reader, owner.id), `${label}, assigneeLoad`).toEqual(
              await assigneeOracle(fx, reader, owner.id),
            )
          }
        }
      }),
      { numRuns: 25 },
    )
  })

  it('agrees with the app on Northstar for Nora and Leo, for every person, paused tasks included', async () => {
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
      const snap = await wholeOf(t, reader)
      if (snap === null) throw new Error(`${key} has no workspace`)
      let spans = 0
      let paused = 0
      for (const [i, owner] of profiles.entries()) {
        const one = answer.owners[i]
        if (one?.state !== 'ok') throw new Error(`${owner.name} is ${one?.state} for ${key}`)
        const app = appOwnerOf(snap, owner.id)
        expect(one.spans, `${owner.name} for ${key}`).toEqual(app.spans)
        expect(one.paused, `${owner.name}'s paused tasks for ${key}`).toEqual(app.paused)
        spans += one.spans.length
        paused += one.paused.length
      }
      // the dataset plans real work, and pauses two tasks
      expect(spans).toBeGreaterThan(10)
      expect(paused).toBe(2)
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
    const span = (
      issue_id: string | null,
      remaining: number,
      project_id: string | null,
    ): OwnerLoadSpan => ({
      issue_id,
      project_id,
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
          spans: [
            span(shown.id, 3, fx.sub.id),
            span(null, 5, null),
            span(sibling.id, 7, fx.sib.id),
          ].sort(byLoadRow),
          paused: [],
        },
      ],
    })
    for (const reader of [fx.guest, fx.viewer]) {
      // the visible span with its id, and nothing of the hidden ones
      expect(await loads(fx.t, fx, reader, [fx.user.id]), reader.name).toEqual({
        hidden: 'own_only',
        owners: [
          { owner_id: fx.user.id, state: 'ok', spans: [span(shown.id, 3, fx.sub.id)], paused: [] },
        ],
      })
    }
  })

  it('gives every role the paused tasks of projects it can see and none of the others, its own included', async () => {
    const fx = await setup()
    const paused = (project: Doc<'projects'>, owner: Doc<'profiles'>) =>
      task(fx, { project_id: project.id, assignee_id: owner.id, paused: true, ...plan(3) })
    const inSub = await paused(fx.sub, fx.user)
    const inSib = await paused(fx.sib, fx.user)
    const inAway = await paused(fx.away, fx.user)
    // each with its task, project and weeks
    expect((await okOf(fx, fx.admin, fx.user.id)).paused).toEqual(
      [inSub, inSib, inAway]
        .map((p) => ({
          issue_id: p.id,
          project_id: p.project_id,
          start_week: '2026-09-07',
          end_week: '2026-09-14',
        }))
        .sort(byPaused),
    )
    // user2 cannot see SKNK, the guest and the viewer neither it nor the
    // sibling, so no paused task of theirs, with or without its id
    expect(await pausedIds(fx, fx.user2, fx.user.id)).toEqual([inSub.id, inSib.id].sort())
    for (const reader of [fx.guest, fx.viewer]) {
      expect(await pausedIds(fx, reader, fx.user.id), reader.name).toEqual([inSub.id])
      const ownHidden = await paused(fx.sib, reader)
      const ownShown = await paused(fx.sub, reader)
      expect(await pausedIds(fx, reader, reader.id), reader.name).toEqual([ownShown.id])
      expect(await pausedIds(fx, fx.admin, reader.id)).toEqual([ownHidden.id, ownShown.id].sort())
    }
    // a paused task adds no span for anyone
    for (const reader of [fx.admin, fx.user2, fx.guest, fx.viewer])
      expect(await spansOf(fx, reader, fx.user.id), reader.name).toEqual([])
  })

  it('names a span’s project exactly where it names its task', async () => {
    const fx = await setup()
    const people = [fx.user, fx.guest, fx.viewer]
    for (const [i, owner] of people.entries()) {
      for (const project of [fx.sub, fx.sub2, fx.sib, fx.away])
        await task(fx, { project_id: project.id, assignee_id: owner.id, ...plan(i + 1) })
      // a legacy row stored under a top-level project
      await task(fx, { project_id: fx.hidden.id, assignee_id: owner.id, ...plan(i + 2) })
    }
    const tasks = await fx.t.run((ctx) => ctx.db.query('issues').collect())
    const projectOf = new Map(tasks.map((i) => [i.id, i.project_id]))
    let named = 0
    let hidden = 0
    for (const reader of [fx.admin, fx.user2, fx.guest, fx.viewer])
      for (const owner of people) {
        for (const span of await spansOf(fx, reader, owner.id)) {
          if (span.issue_id === null) {
            hidden++
            expect(span.project_id, `${reader.name} on ${owner.name}`).toBeNull()
          } else {
            named++
            expect(span.project_id, `${reader.name} on ${owner.name}`).toBe(
              projectOf.get(span.issue_id),
            )
          }
        }
      }
    expect(named).toBeGreaterThan(0)
    expect(hidden).toBeGreaterThan(0)
  })

  it('gives a guest or Viewer their own hidden spans without a task id', async () => {
    const fx = await setup()
    for (const reader of [fx.guest, fx.viewer]) {
      await task(fx, { project_id: fx.sib.id, assignee_id: reader.id, ...plan(4) })
      const own = await task(fx, { assignee_id: reader.id, ...plan(2) })
      const spans = await spansOf(fx, reader, reader.id)
      expect(spans.map((s) => s.issue_id).sort()).toEqual([null, own.id].sort())
      // the hidden one names no project either
      expect(spans.map((s) => s.project_id).sort()).toEqual([null, fx.sub.id].sort())
      // the admin sees both by id
      expect((await spansOf(fx, fx.admin, reader.id)).every((s) => s.issue_id !== null)).toBe(true)
    }
  })

  it('gives a guest the hidden work they review without a task id, and none of the hidden work they only assign', async () => {
    const fx = await setup()
    // two review hand-offs in a project the guest cannot see: the review's
    // owner is its reviewer (convex/lib/review.ts taskOwnerId)
    const review = { project_id: fx.sib.id, status: 'review' as const }
    await task(fx, { ...review, assignee_id: fx.user.id, reviewer_id: fx.guest.id, ...plan(7) })
    await task(fx, { ...review, assignee_id: fx.guest.id, reviewer_id: fx.user.id, ...plan(4) })
    // the one they review is their load, anonymized
    const own = await spansOf(fx, fx.guest, fx.guest.id)
    expect(own.map((s) => [s.issue_id, s.project_id, Number(s.remaining)])).toEqual([
      [null, null, 7],
    ])
    // the one they only assign is the reviewer's, of which a guest reads
    // no hidden span
    expect(await spansOf(fx, fx.guest, fx.user.id)).toEqual([])
    // staff read both hand-offs by id, each in its reviewer's load
    expect((await spansOf(fx, fx.admin, fx.guest.id)).map((s) => Number(s.remaining))).toEqual([7])
    expect((await spansOf(fx, fx.admin, fx.user.id)).map((s) => Number(s.remaining))).toContain(4)
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
      loads: x.loads.map(({ owner_id: _, ...o }) =>
        o.state === 'ok' ? { ...o, spans: o.spans.map(({ project_id: _p, ...span }) => span) } : o,
      ),
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
          { owner_id: fx.guest.id, state: 'not_read' },
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

  it('answers every role the same about a person in a call of one whatever their hidden paused work below the bounds', async () => {
    const fx = await setup()
    await tracksDelay(fx)
    const shown = await task(fx, { assignee_id: fx.user.id, ...plan(3) })
    await task(fx, { assignee_id: fx.user.id, paused: true, ...plan(2, '2026-09-14') })
    const answers = async (readers: Doc<'profiles'>[]) => {
      const out = []
      for (const reader of readers)
        out.push({
          loads: await loads(fx.t, fx, reader, [fx.user.id]),
          delay: (
            await fx.t.query(internal.machine.rest.getIssue, {
              callerId: reader.id,
              access: 'read',
              today: TODAY,
              ref: shown.id,
            })
          ).delay,
        })
      return out
    }
    // SKNK is hidden from user2, the guest and the viewer, the sibling from
    // the guest and the viewer
    const all = [fx.user2, fx.guest, fx.viewer]
    const before = await answers(all)
    expect(before.map((a) => a.loads.owners[0]?.state)).toEqual(['ok', 'ok', 'ok'])
    // paused work in SKNK's sub-project and in two more that only paused
    // tasks name, one of them In Review with the user as reviewer
    const away2 = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.hidden.id,
    })
    const away3 = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.hidden.id,
    })
    for (const project of [fx.away, away2])
      await plantMany(fx.t, fx.org.id, 5, {
        project_id: project.id,
        assignee_id: fx.user.id,
        paused: true,
        ...plan(4),
      })
    await task(fx, {
      project_id: away3.id,
      assignee_id: fx.admin.id,
      reviewer_id: fx.user.id,
      status: 'review',
      paused: true,
      ...plan(1),
    })
    expect(await answers(all)).toEqual(before)
    // and in the sibling, which user2 can see
    await plantMany(fx.t, fx.org.id, 5, {
      project_id: fx.sib.id,
      assignee_id: fx.user.id,
      paused: true,
      ...plan(4),
    })
    expect(await answers([fx.guest, fx.viewer])).toEqual(before.slice(1))
    const user2 = await okOf(fx, fx.user2, fx.user.id)
    expect(user2.paused).toHaveLength(6)
  })

  it('answers a guest or Viewer unavailable, and nothing more, when hidden paused work passes a bound', async () => {
    const fx = await setup()
    await task(fx, { assignee_id: fx.user.id, ...plan(3) })
    await task(fx, { assignee_id: fx.user.id, paused: true, ...plan(2) })
    // paused work only in projects they cannot see: the sibling and SKNK's
    // sub-project
    for (const project of [fx.sib, fx.away])
      await task(fx, { project_id: project.id, assignee_id: fx.user.id, paused: true, ...plan(1) })
    // FW, the sibling and the sub-project of SKNK: three live projects
    Object.assign(OWNER_LOADS, { projects: 3 })
    for (const reader of [fx.guest, fx.viewer]) {
      const one = await okOf(fx, reader, fx.user.id)
      expect(one.spans.map((s) => s.project_id)).toEqual([fx.sub.id])
      expect(one.paused.map((s) => s.project_id)).toEqual([fx.sub.id])
    }
    Object.assign(OWNER_LOADS, { projects: 2 })
    for (const reader of [fx.guest, fx.viewer]) {
      expect(await loads(fx.t, fx, reader, [fx.user.id, fx.guest.id]), reader.name).toEqual({
        hidden: 'own_only',
        owners: [
          { owner_id: fx.user.id, state: 'unavailable' },
          { owner_id: fx.guest.id, state: 'not_read' },
        ],
      })
    }
    // the same state a hidden task that can carry load reaches
    await fx.t.run(async (ctx) => {
      for (const row of await ctx.db.query('issues').collect())
        if (row.project_id !== fx.sub.id) await ctx.db.patch(row._id, { paused: false })
    })
    for (const reader of [fx.guest, fx.viewer])
      expect((await loads(fx.t, fx, reader, [fx.user.id])).owners).toEqual([
        { owner_id: fx.user.id, state: 'unavailable' },
      ])
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

  it('answers paused leaves of live projects, whatever their hours or status but Done, and follows the review hand-off', async () => {
    const fx = await setup()
    const mine = { assignee_id: fx.user.id, paused: true, ...plan(3) }
    const leaf = await task(fx, mine)
    // a group's stored pause is dormant. A subtask in a live sub-project
    // makes one, and one only in the archived sub-project does not
    const group = await task(fx, mine)
    await task(fx, { project_id: fx.sub2.id, parent_id: group.id })
    const shelved = await task(fx, mine)
    await task(fx, { project_id: fx.shelf.id, parent_id: shelved.id })
    // no hours, zero hours and Backlog, a legacy pause a status write would
    // have cleared, stay in
    const weeks = { start_week: '2026-09-07', end_week: '2026-09-14' }
    const unestimated = await task(fx, { assignee_id: fx.user.id, paused: true, ...weeks })
    const zero = await task(fx, { ...mine, remaining_hours: 0 })
    const backlog = await task(fx, { ...mine, status: 'backlog' })
    // left out are an unscheduled one, a Done one, an archived one, one in
    // the archived sub-project, one whose project row is gone and one of
    // another organization
    await task(fx, { assignee_id: fx.user.id, paused: true, remaining_hours: 3 })
    await task(fx, { ...mine, status: 'done', done_at: NOW })
    await task(fx, { ...mine, archived_at: NOW })
    await task(fx, { ...mine, project_id: fx.shelf.id })
    await task(fx, { ...mine, project_id: uuid() })
    await plantIssue(fx.t, { ...mine, org_id: fx.otherOrg.id, project_id: fx.otherProject.id })
    // In Review: the reviewer's with one, the assignee's without
    const reviewed = await task(fx, { ...mine, status: 'review', reviewer_id: fx.admin.id })
    const unreviewed = await task(fx, { ...mine, status: 'review' })
    expect(await pausedIds(fx, fx.admin, fx.user.id)).toEqual(
      [leaf.id, shelved.id, unestimated.id, zero.id, backlog.id, unreviewed.id].sort(),
    )
    expect(await pausedIds(fx, fx.admin, fx.admin.id)).toEqual([reviewed.id])
    // none of them is load
    expect(await spansOf(fx, fx.admin, fx.user.id)).toEqual([])
    // the group check drops a paused task once it gains a live subtask, and
    // keeps it once that subtask is archived
    const kid = await task(fx, { parent_id: leaf.id })
    expect(await pausedIds(fx, fx.admin, fx.user.id)).not.toContain(leaf.id)
    await fx.t.run((ctx) => ctx.db.patch(kid._id, { archived_at: NOW }))
    expect(await pausedIds(fx, fx.admin, fx.user.id)).toContain(leaf.id)
    // back to the assignee once it leaves Review, and no paused task once
    // it is unpaused
    await fx.t.run((ctx) => ctx.db.patch(reviewed._id, { status: 'progress' }))
    expect(await pausedIds(fx, fx.admin, fx.admin.id)).toEqual([])
    expect(await pausedIds(fx, fx.admin, fx.user.id)).toContain(reviewed.id)
    await fx.t.run((ctx) => ctx.db.patch(reviewed._id, { paused: false }))
    expect(await pausedIds(fx, fx.admin, fx.user.id)).not.toContain(reviewed.id)
    expect((await spansOf(fx, fx.admin, fx.user.id)).map((s) => s.issue_id)).toEqual([reviewed.id])
  })

  it('orders spans by byLoadRow whatever their projects, and paused spans by weeks, then task id', async () => {
    const [low, high, pausedLow, pausedHigh] = [uuid(), uuid(), uuid(), uuid()].sort()
    // two load tasks equal on every key but their ids and projects, and two
    // paused ones with equal weeks, each created high first, so creation
    // order and id order differ
    const answer = async (swap: boolean) => {
      const f = await setup()
      const [lowIn, highIn] = swap ? [f.sub2, f.sub] : [f.sub, f.sub2]
      for (const [id, pausedId, p] of [
        [high, pausedHigh, highIn],
        [low, pausedLow, lowIn],
      ] as const) {
        await task(f, { id, project_id: p.id, assignee_id: f.user.id, ...plan(3) })
        await task(f, {
          id: pausedId,
          project_id: p.id,
          assignee_id: f.user.id,
          paused: true,
          ...plan(1, '2026-09-14', '2026-09-21'),
        })
      }
      const one = await okOf(f, f.admin, f.user.id)
      return {
        ids: one.spans.map((s) => s.issue_id),
        projects: one.spans.map((s) => s.project_id),
        paused: one.paused.map((p) => p.issue_id),
        f,
      }
    }
    for (const swap of [false, true]) {
      const { ids, projects, paused, f } = await answer(swap)
      expect(ids).toEqual([low, high])
      expect(projects).toEqual(swap ? [f.sub2.id, f.sub.id] : [f.sub.id, f.sub2.id])
      expect(paused).toEqual([pausedLow, pausedHigh])
    }
    // by weeks before the task id: longer takes the lowest id, so an order
    // that dropped the end week would put it ahead of first
    const f = await setup()
    const later = await task(f, {
      id: pausedHigh,
      assignee_id: f.user.id,
      paused: true,
      ...plan(1, '2026-09-21', '2026-09-21'),
    })
    const longer = await task(f, {
      id: low,
      assignee_id: f.user.id,
      paused: true,
      ...plan(1, '2026-09-07', '2026-09-28'),
    })
    const first = await task(f, {
      id: high,
      assignee_id: f.user.id,
      paused: true,
      ...plan(1, '2026-09-07', '2026-09-14'),
    })
    expect((await okOf(f, f.admin, f.user.id)).paused.map((p) => p.issue_id)).toEqual([
      first.id,
      longer.id,
      later.id,
    ])
  })
})

describe('the owners of a call', () => {
  it('answers an unknown owner and one of another organization with no spans', async () => {
    const fx = await setup()
    await task(fx, { assignee_id: fx.user.id, ...plan(3) })
    await task(fx, { assignee_id: fx.user.id, paused: true, ...plan(3) })
    const answer = await loads(fx.t, fx, fx.admin, [uuid(), fx.otherAdmin.id])
    expect(answer.owners.map((o) => o.state === 'ok' && [o.spans, o.paused])).toEqual([
      [[], []],
      [[], []],
    ])
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

  it('reads a guest or Viewer one owner a call, so where not_read starts tells nothing of hidden work', async () => {
    const fx = await setup()
    await task(fx, { assignee_id: fx.user.id, ...plan(3) })
    await task(fx, { assignee_id: fx.admin.id, ...plan(2) })
    const states = async (reader: Doc<'profiles'>, ids: string[]) =>
      (await loads(fx.t, fx, reader, ids)).owners.map((o) => o.state)
    const asked = [fx.user.id, fx.admin.id, fx.user2.id]
    const before = {
      guest: await states(fx.guest, asked),
      viewer: await states(fx.viewer, asked),
    }
    expect(before).toEqual({
      guest: ['ok', 'not_read', 'not_read'],
      viewer: ['ok', 'not_read', 'not_read'],
    })
    // the user's hidden open work grows by 40 planned tasks, which only
    // staff receive, as busy time without a task id, and 20 Backlog ones,
    // which no one receives
    await plantMany(fx.t, fx.org.id, 40, {
      project_id: fx.sib.id,
      assignee_id: fx.user.id,
      ...plan(1),
    })
    await plantMany(fx.t, fx.org.id, 20, {
      project_id: fx.sib.id,
      assignee_id: fx.user.id,
      status: 'backlog',
    })
    expect({
      guest: await states(fx.guest, asked),
      viewer: await states(fx.viewer, asked),
    }).toEqual(before)
    // and so does their paused work
    for (const owner of [fx.user, fx.admin, fx.user2])
      await plantMany(fx.t, fx.org.id, 3, {
        project_id: fx.sub.id,
        assignee_id: owner.id,
        paused: true,
        ...plan(1),
      })
    expect({
      guest: await states(fx.guest, asked),
      viewer: await states(fx.viewer, asked),
    }).toEqual(before)
    expect((await loads(fx.t, fx, fx.guest, asked)).owners[0]).toMatchObject({
      state: 'ok',
      paused: expect.arrayContaining([expect.objectContaining({ project_id: fx.sub.id })]),
    })
    // asking again for the not_read owners reads the next one
    expect(await states(fx.guest, asked.slice(1))).toEqual(['ok', 'not_read'])
    expect(await states(fx.viewer, asked.slice(2))).toEqual(['ok'])
    // staff keep every owner the room holds
    expect(await states(fx.admin, asked)).toEqual(['ok', 'ok', 'ok'])
    expect(await states(fx.user2, asked)).toEqual(['ok', 'ok', 'ok'])
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
    await plantMany(fx.t, fx.org.id, 150, {
      project_id: fx.sub.id,
      assignee_id: fx.user.id,
      status: 'done',
      done_at: NOW,
      ...plan(1),
    })
    expect(await measure()).toEqual(before)
  })

  it('checks at most OWNER_LOADS.checks tasks for subtasks, the load and the visible paused ones together', async () => {
    const fx = await setup()
    await plantMany(fx.t, fx.org.id, 6, {
      project_id: fx.sub.id,
      assignee_id: fx.user.id,
      ...plan(1),
    })
    // not scheduled or no hours: never checked by ownerLoads
    await plantMany(fx.t, fx.org.id, 3, { project_id: fx.sub.id, assignee_id: fx.user.id })
    await plantMany(fx.t, fx.org.id, 2, {
      project_id: fx.sub.id,
      assignee_id: fx.user.id,
      ...plan(0),
    })
    // paused: checked by ownerLoads alone, and only where the caller can
    // see the project, which user2 cannot for SKNK's sub-project
    await plantMany(fx.t, fx.org.id, 2, {
      project_id: fx.sub.id,
      assignee_id: fx.user.id,
      paused: true,
      ...plan(1),
    })
    await plantMany(fx.t, fx.org.id, 3, {
      project_id: fx.away.id,
      assignee_id: fx.user.id,
      paused: true,
      ...plan(1),
    })
    const state = async (caller: Doc<'profiles'>) =>
      (await loads(fx.t, fx, caller, [fx.user.id])).owners[0]?.state
    // the load fits alone, and not with the visible paused ones
    Object.assign(OWNER_LOADS, { checks: 7 })
    expect(await state(fx.user2)).toBe('unavailable')
    Object.assign(OWNER_LOADS, { checks: 8 })
    const one = await okOf(fx, fx.user2, fx.user.id)
    expect([one.spans.length, one.paused.length]).toEqual([6, 2])
    // the admin sees SKNK, so checks its paused tasks too
    expect(await state(fx.admin)).toBe('unavailable')
    Object.assign(OWNER_LOADS, { checks: 11 })
    expect((await okOf(fx, fx.admin, fx.user.id)).paused).toHaveLength(5)
    // assigneeLoad keeps the unestimated ones, so it checks those too, and
    // never the paused ones
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
    // a live project only a paused task names counts too, in ownerLoads
    // alone, and a paused task of the archived sub-project needs no question
    const fifth = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.meta.id,
    })
    for (const p of [fifth, fx.shelf])
      await task(fx, { project_id: p.id, assignee_id: fx.user.id, paused: true, ...plan(1) })
    Object.assign(OWNER_LOADS, { projects: 4 })
    expect((await loads(fx.t, fx, fx.admin, [fx.user.id])).owners[0]?.state).toBe('unavailable')
    expect(
      await as(fx.t, fx.admin).query(api.planning.assigneeLoad, { assignee_id: fx.user.id }),
    ).toHaveLength(4)
    Object.assign(OWNER_LOADS, { projects: 5 })
    const one = await okOf(fx, fx.admin, fx.user.id)
    expect(one.spans).toHaveLength(4)
    expect(one.paused.map((p) => p.project_id)).toEqual([fifth.id])
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
    // paused spans count beside the load's
    for (const owner of [fx.viewer, fx.user])
      await plantMany(fx.t, fx.org.id, 2, {
        project_id: fx.sub.id,
        assignee_id: owner.id,
        paused: true,
        ...plan(1),
      })
    const size = (o: OwnerLoadsJson['owners'][number]) =>
      o.state === 'ok' ? o.spans.length + o.paused.length : o.state
    const counted = async (ids: string[]) => (await loads(fx.t, fx, fx.admin, ids)).owners.map(size)
    expect(await counted([fx.guest.id, fx.viewer.id])).toEqual([2, 'not_read'])
    expect(await counted([fx.viewer.id, fx.guest.id])).toEqual([2, 'not_read'])
    // the first owner excepted, whose paused spans pass it too
    expect(await counted([fx.user.id, fx.guest.id])).toEqual([6, 'not_read'])
  })

  it('spends the room on the questions about the projects only paused tasks name', async () => {
    const fx = await setup()
    await plantMany(fx.t, fx.org.id, 3, {
      project_id: fx.sub.id,
      assignee_id: fx.user.id,
      ...plan(1),
    })
    await task(fx, { project_id: fx.sub2.id, assignee_id: fx.guest.id, ...plan(1) })
    const states = async (ids: string[]) =>
      (await loads(fx.t, fx, fx.user2, ids)).owners.map((o) => o.state)
    // the least rooms the user fits in alone and after the guest
    const least = async (ids: string[]) => {
      let documents = 0
      do {
        documents += 4
        Object.assign(OWNER_LOADS, { call: { ...DEFAULT_LOADS.call, documents } })
      } while ((await states(ids)).some((s) => s !== 'ok'))
      return documents
    }
    const alone = await least([fx.user.id])
    const after = await least([fx.guest.id, fx.user.id])
    // the user's paused work in three sub-projects of SKNK, which user2
    // cannot see, so three more questions and no check
    for (let i = 0; i < 3; i++) {
      const p = await plantProject(fx.t, {
        org_id: fx.org.id,
        type: 'project',
        parent_id: fx.hidden.id,
      })
      await task(fx, { project_id: p.id, assignee_id: fx.user.id, paused: true, ...plan(1) })
    }
    Object.assign(OWNER_LOADS, { call: { ...DEFAULT_LOADS.call, documents: after } })
    expect(await states([fx.guest.id, fx.user.id])).toEqual(['ok', 'not_read'])
    // assigneeLoad asks nothing about them, and reads only their rows, so
    // the user fits there alone
    expect(
      await as(fx.t, fx.user2).query(api.planning.assigneeLoad, { assignee_id: fx.user.id }),
    ).toHaveLength(3)
    Object.assign(OWNER_LOADS, { call: { ...DEFAULT_LOADS.call, documents: alone } })
    expect((await loads(fx.t, fx, fx.user2, [fx.user.id])).owners).toEqual([
      { owner_id: fx.user.id, state: 'unavailable' },
    ])
    // and with room for them the paused list holds none of SKNK's
    Object.assign(OWNER_LOADS, { call: DEFAULT_LOADS.call })
    expect(await states([fx.guest.id, fx.user.id])).toEqual(['ok', 'ok'])
    expect(await pausedIds(fx, fx.user2, fx.user.id)).toEqual([])
  })

  it('stops at the read’s room on task rows that still hold their text, never failing on a Convex limit', async () => {
    // a call's room of 32 KB under a request limit of 96 KB, past which
    // Convex fails the read, and 40 rows that hold an ordinary
    // description of about 4 KB, about 160 KB in all
    const fx = await setup(newT({ transactionLimits: { bytesRead: 96 * 1024 } }))
    const line = 'Check the supplier quotes against the budget and note any change for the team. '
    const text = line.repeat(50)
    for (let i = 0; i < 40; i++)
      await plantCopiedIssue(fx.t, {
        org_id: fx.org.id,
        project_id: fx.sub.id,
        assignee_id: fx.user.id,
        description: text,
        ...plan(1),
      })
    // with the call's own room of 8 MiB the rows pass the request's limit
    await expect(loads(fx.t, fx, fx.admin, [fx.user.id])).rejects.toThrow(/Read too much data/)
    Object.assign(OWNER_LOADS, { call: { ...DEFAULT_LOADS.call, bytes: 32 * 1024 } })
    expect((await loads(fx.t, fx, fx.admin, [fx.user.id])).owners[0]?.state).toBe('unavailable')
    const refused = await expectRefusal(
      as(fx.t, fx.admin).query(api.planning.assigneeLoad, { assignee_id: fx.user.id }),
      'rule',
    )
    expect((refused.data as { reason?: string }).reason).toBe(LOAD_UNAVAILABLE)
  })
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

  it('makes the owner unavailable when the check of a project only a paused task names stops', async () => {
    const fx = await setup()
    await task(fx, { assignee_id: fx.guest.id, ...plan(3) })
    // a paused task stored under SKNK itself, which the guest asks about
    // for navigation, past the parent's sub-projects it may read
    await task(fx, { project_id: fx.hidden.id, assignee_id: fx.guest.id, paused: true, ...plan(2) })
    expect(await pausedIds(fx, fx.guest, fx.guest.id)).toEqual([])
    Object.assign(OWN_READS, { subProjects: 0 })
    expect((await loads(fx.t, fx, fx.guest, [fx.guest.id])).owners).toEqual([
      { owner_id: fx.guest.id, state: 'unavailable' },
    ])
    // assigneeLoad never asks about it
    expect(
      await as(fx.t, fx.guest).query(api.planning.assigneeLoad, { assignee_id: fx.guest.id }),
    ).toHaveLength(1)
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
    // 30 sub-projects, 3 under each of 10 more top-level projects, 300
    // tasks of other people in them, 300 archived and 100 Done tasks of
    // the owner, and 49 teams none of the callers is in, which with
    // withOrg's Hardware make the organization's 50, each sharing 2 of the
    // new sub-projects
    const tops: Doc<'projects'>[] = []
    for (let i = 0; i < 10; i++) tops.push(await plantProject(fx.t, { org_id: fx.org.id }))
    const subs: Doc<'projects'>[] = []
    for (let i = 0; i < 30; i++)
      subs.push(
        await plantProject(fx.t, {
          org_id: fx.org.id,
          type: 'project',
          parent_id: tops[Math.floor(i / 3)]?.id,
        }),
      )
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 49; i++) {
        const team = uuid()
        await ctx.db.insert('teams', {
          id: team,
          org_id: fx.org.id,
          name: `Team ${i}`,
          track_delay_default: false,
          created_at: NOW,
        })
        for (let j = 0; j < 2; j++) {
          const sub = subs[(i * 2 + j) % subs.length]
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
    await plantMany(fx.t, fx.org.id, 300, {
      project_id: fx.sub.id,
      ...mine,
      ...plan(1),
      archived_at: NOW,
    })
    await plantMany(fx.t, fx.org.id, 100, {
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
  })
})

describe('the readers that do not ask for paused work', () => {
  it('read and answer as before whatever paused work the owner holds in projects no other task of theirs names', async () => {
    const fx = await setup()
    await tracksDelay(fx)
    const single = await task(fx, { assignee_id: fx.user.id, ...plan(6) })
    await task(fx, { assignee_id: fx.user.id, ...plan(3, '2026-09-14', '2026-09-21') })
    const measure = async (caller: Doc<'profiles'>) => {
      const run = <Out>(read: (ctx: QueryCtx) => Promise<Out>) =>
        as(fx.t, caller).query((ctx) => readsOf(ctx, () => read(ctx)))
      return {
        loads: await run((ctx) =>
          handlerOf<{ org_id: string; owner_ids: string[] }, OwnerLoadsJson>(ownerLoads)(ctx, {
            org_id: fx.org.id,
            owner_ids: [fx.user.id],
          }),
        ),
        assignee: await run((ctx) =>
          handlerOf<{ assignee_id: string }, AssigneeLoadRow[]>(assigneeLoad)(ctx, {
            assignee_id: fx.user.id,
          }),
        ),
        page: await run((ctx) =>
          handlerOf<Record<string, string>, WorkloadJson>(restWorkload)(ctx, {
            callerId: caller.id,
            access: 'read',
            today: TODAY,
            from_week: '2026-09-07',
            weeks: '4',
            person: fx.user.id,
          }),
        ),
        single: await run((ctx) =>
          handlerOf<
            { callerId: string; access: 'read'; today: string; ref: string },
            { delay: unknown }
          >(getIssue)(ctx, { callerId: caller.id, access: 'read', today: TODAY, ref: single.id }),
        ),
      }
    }
    const callers = [fx.admin, fx.user2, fx.guest]
    const before = []
    for (const caller of callers) before.push(await measure(caller))
    // paused work in three sub-projects of TBED that no other task of the
    // user names, hidden from the guest
    for (let i = 0; i < 3; i++) {
      const p = await plantProject(fx.t, {
        org_id: fx.org.id,
        type: 'project',
        parent_id: fx.meta.id,
      })
      await task(fx, { project_id: p.id, assignee_id: fx.user.id, paused: true, ...plan(2) })
    }
    for (const [i, caller] of callers.entries()) {
      const was = before[i]
      if (was === undefined) throw new Error('no reads before')
      const now = await measure(caller)
      for (const key of ['assignee', 'page', 'single'] as const) {
        const label = `${caller.name}, ${key}`
        expect(now[key].out, label).toEqual(was[key].out)
        // the paused rows add documents only
        expect(now[key].ranges, label).toBe(was[key].ranges)
        expect(now[key].documents, label).toBe(was[key].documents + 3)
      }
      // the reader with the paused option reads more ranges, and answers
      // the spans as before
      expect(now.loads.ranges, caller.name).toBeGreaterThan(was.loads.ranges)
      const [one, old] = [now.loads.out.owners[0], was.loads.out.owners[0]]
      if (one?.state !== 'ok' || old?.state !== 'ok') throw new Error('not ok')
      expect(one.spans).toEqual(old.spans)
      expect(one.paused).toHaveLength(caller === fx.guest ? 0 : 3)
      const page = now.page.out.people[0]
      expect(page?.status === 'ok' && page.hours.some((h) => h > 0)).toBe(true)
      expect(now.single.out.delay).not.toEqual(UNAVAILABLE_DELAY)
    }
  })
})

/* An ordinary title of about 80 characters. */
const titleOf = (n: number) =>
  `Check the supplier quotes against the budget and update the plan, step ${n}`

/* The design size's 200 sub-projects, 3 under each of 67 top-level
 * projects (2 under the last), and a staff caller in 3 teams, each sharing
 * a third of the top-level projects, so the caller reads every sub-project
 * through its project's share; and planning.ownerLoads for that caller
 * with its reads. */
async function designOrg(t: T) {
  const fx = await setup(t)
  const tops: Doc<'projects'>[] = []
  for (let i = 0; i < 67; i++)
    tops.push(await plantProject(t, { org_id: fx.org.id, name: `Programme ${i}` }))
  const subs: Doc<'projects'>[] = []
  for (let i = 0; i < 200; i++)
    subs.push(
      await plantProject(t, {
        org_id: fx.org.id,
        type: 'project',
        parent_id: (tops[Math.floor(i / 3)] as Doc<'projects'>).id,
        name: `Workstream ${i}`,
        track_delay: true,
      }),
    )
  const caller = await plantSeat(t, {
    org_id: fx.org.id,
    name: 'Caller',
    auth_user_id: `auth_${uuid()}`,
    email: 'caller@testbed.test',
    accepted_at: NOW,
  })
  await t.run(async (ctx) => {
    for (let i = 0; i < 3; i++) {
      const team = uuid()
      await ctx.db.insert('teams', {
        id: team,
        org_id: fx.org.id,
        name: `Delivery team ${i}`,
        track_delay_default: false,
        created_at: NOW,
      })
      await ctx.db.insert('team_members', {
        team_id: team,
        profile_id: caller.id,
        is_leader: false,
      })
      for (const [k, top] of tops.entries())
        if (k % 3 === i)
          await ctx.db.insert('project_team_access', {
            project_id: top.id,
            team_id: team,
            level: 'user',
          })
    }
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
  return { fx, subs, caller, call }
}

/* One task row in `project_id`, assigned to `owner` where given, with an
 * ordinary title. */
const designTask = (
  orgId: string,
  project_id: string,
  owner: string | null,
  over: Partial<Doc<'issues'>> = {},
) => ({
  id: uuid(),
  org_id: orgId,
  project_id,
  num: bulkNum++,
  title: titleOf(bulkNum),
  status: 'todo' as const,
  priority: 'medium' as const,
  ...(owner === null ? {} : { assignee_id: owner }),
  paused: false,
  created_at: NOW,
  updated_at: NOW,
  ...over,
})

/* The busy owner's 2,000 open tasks over the 200 sub-projects, 500 of them
 * planned with hours, 50 of those with a subtask, the rest in Backlog or
 * unplanned, and with `pausedEvery` one in that many of the 450 planned
 * leaves paused. Answers a planned leaf's id. */
const plantBusy = (
  t: T,
  orgId: string,
  subs: readonly Doc<'projects'>[],
  busy: string,
  pausedEvery?: number,
) =>
  t.run(async (ctx) => {
    let leaf = ''
    let leaves = 0
    for (let i = 0; i < 2000; i++) {
      const sub = subs[i % 200] as Doc<'projects'>
      const planned = i < 500
      const group = planned && i % 10 === 0
      const paused = planned && !group && pausedEvery !== undefined && leaves++ % pausedEvery === 0
      const id = uuid()
      await ctx.db.insert(
        'issues',
        designTask(orgId, sub.id, busy, {
          id,
          status: planned ? 'progress' : i % 2 === 0 ? 'backlog' : 'todo',
          paused,
          ...(planned ? plan(4) : {}),
        }),
      )
      if (i === 1) leaf = id
      // an unassigned subtask
      if (group) await ctx.db.insert('issues', designTask(orgId, sub.id, null, { parent_id: id }))
    }
    return leaf
  })

/* The JSON bytes of `rows`, one by one, and their mean. */
const meanBytes = (rows: readonly unknown[]) =>
  rows.length === 0
    ? 0
    : Math.round(rows.reduce((n: number, row) => n + JSON.stringify(row).length, 0) / rows.length)

/* A read's counts for the log. */
const countsOf = (read: { ranges: number; documents: number; bytes: number }) =>
  `${read.ranges} ranges, ${read.documents} documents, ${(read.bytes / 1e6).toFixed(2)} MB`

describe('at the design size', () => {
  it('reads an owner of 2,000 open tasks over the 200 sub-projects a person can read, and 49 more', async () => {
    const t = newT()
    const { fx, subs, caller, call } = await designOrg(t)
    const busy = await plantSeat(t, { org_id: fx.org.id, name: 'Busy' })
    const others: Doc<'profiles'>[] = []
    for (let i = 0; i < 49; i++)
      others.push(await plantSeat(t, { org_id: fx.org.id, name: `Other ${i}` }))
    const leafId = await plantBusy(t, fx.org.id, subs, busy.id)
    await t.run(async (ctx) => {
      for (const [k, other] of others.entries())
        for (let i = 0; i < 40; i++)
          await ctx.db.insert(
            'issues',
            designTask(fx.org.id, (subs[(k * 40 + i) % 200] as Doc<'projects'>).id, other.id, {
              ...plan(2),
            }),
          )
    })
    const alone = await call([busy.id])
    const one = alone.out.owners[0]
    if (one?.state !== 'ok') throw new Error(`the busy owner is ${one?.state}`)
    // the 500 planned, less the 50 groups, and no paused work
    expect(one.spans).toHaveLength(450)
    expect(one.paused).toEqual([])
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
    console.log(
      'owner loads at the design size, without paused work:',
      `alone ${countsOf(alone)};`,
      `the 50 owners in ${calls.length} calls, ${calls.map(countsOf).join('; ')};`,
      `assigneeLoad ${countsOf(assignee)}; the single read ${countsOf(single)};`,
      `a load span ${meanBytes(one.spans)} bytes of JSON`,
    )
    // one more open task
    await plantMany(t, fx.org.id, 1, { project_id: subs[0]?.id ?? '', assignee_id: busy.id })
    expect((await call([busy.id])).out.owners[0]?.state).toBe('unavailable')
    // each read inside Convex's limits, the call's ceiling and one step
    // past it; measured at the design size: alone 848 ranges, 2,403
    // documents, 1.1 MB; the 50 owners in two calls, 26 of them and then
    // 24, 2,007 and 1,446 ranges, 3,469 and 1,336 documents, 1.7 and
    // 0.7 MB; the single read 878 ranges, 2,419 documents, 1.1 MB
    for (const read of [alone, assignee, single, ...calls]) {
      expect(read.ranges).toBeLessThan(4096)
      expect(read.documents).toBeLessThan(32_000)
      expect(read.bytes).toBeLessThan(16 * 1024 * 1024)
    }
    expect(calls.length).toBeGreaterThan(1)
    expect(assignee.out).toBe(450)
    expect(single.out).toEqual({ status: 'behind', projected_end_week: '2026-09-21' })
  })

  it('reads an owner with everyday load and a paused task in each of the 200 sub-projects a person can read', async () => {
    const t = newT()
    const { fx, subs, caller, call } = await designOrg(t)
    const owner = await plantSeat(t, { org_id: fx.org.id, name: 'Owner' })
    // the everyday load, 30 scheduled tasks in 3 sub-projects, and the one
    // figure raised, paused work that alone names every sub-project the
    // caller can read
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++)
        await ctx.db.insert(
          'issues',
          designTask(fx.org.id, (subs[i % 3] as Doc<'projects'>).id, owner.id, {
            status: 'progress',
            ...plan(4),
          }),
        )
      for (const sub of subs)
        await ctx.db.insert(
          'issues',
          designTask(fx.org.id, sub.id, owner.id, { paused: true, ...plan(2) }),
        )
    })
    const read = await call([owner.id])
    const one = read.out.owners[0]
    if (one?.state !== 'ok') throw new Error(`the owner is ${one?.state}`)
    expect(one.spans).toHaveLength(30)
    expect(one.paused).toHaveLength(200)
    expect(new Set(one.paused.map((p) => p.project_id)).size).toBe(200)
    const assignee = await as(t, caller).query((ctx) =>
      readsOf(ctx, () =>
        handlerOf<{ assignee_id: string }, AssigneeLoadRow[]>(assigneeLoad)(ctx, {
          assignee_id: owner.id,
        }).then((rows) => rows.length),
      ),
    )
    console.log(
      'owner loads at the design size, a paused task in each of 200 sub-projects:',
      `${countsOf(read)}; assigneeLoad ${countsOf(assignee)};`,
      `a load span ${meanBytes(one.spans)} and a paused span ${meanBytes(one.paused)} bytes of JSON,`,
      `the answer ${JSON.stringify(read.out).length} bytes`,
    )
    for (const r of [read, assignee]) {
      expect(r.ranges).toBeLessThan(4096)
      expect(r.documents).toBeLessThan(32_000)
      expect(r.bytes).toBeLessThan(16 * 1024 * 1024)
    }
    expect(assignee.out).toBe(30)
    // one live project fewer than paused work names
    Object.assign(OWNER_LOADS, { projects: 199 })
    expect((await call([owner.id])).out.owners).toEqual([
      { owner_id: owner.id, state: 'unavailable' },
    ])
    // the readers that do not ask for paused work never meet it
    expect(
      await as(t, caller).query(api.planning.assigneeLoad, { assignee_id: owner.id }),
    ).toHaveLength(30)
  })

  it('reads the busy owner at the reader’s limit with one in twelve of its planned leaves paused', async () => {
    const t = newT()
    const { fx, subs, call } = await designOrg(t)
    const busy = await plantSeat(t, { org_id: fx.org.id, name: 'Busy' })
    await plantBusy(t, fx.org.id, subs, busy.id, 12)
    const read = await call([busy.id])
    const one = read.out.owners[0]
    if (one?.state !== 'ok') throw new Error(`the busy owner is ${one?.state}`)
    // the 450 planned leaves, 38 of them paused, and the 50 groups make
    // the 500 checks
    expect([one.spans.length, one.paused.length]).toEqual([412, 38])
    console.log(
      'owner loads at the design size, the busy owner with one in twelve leaves paused:',
      `${countsOf(read)};`,
      `a load span ${meanBytes(one.spans)} and a paused span ${meanBytes(one.paused)} bytes of JSON,`,
      `the answer ${JSON.stringify(read.out).length} bytes`,
    )
    expect(read.ranges).toBeLessThan(4096)
    expect(read.documents).toBeLessThan(32_000)
    expect(read.bytes).toBeLessThan(16 * 1024 * 1024)
    Object.assign(OWNER_LOADS, { checks: 499 })
    expect((await call([busy.id])).out.owners).toEqual([
      { owner_id: busy.id, state: 'unavailable' },
    ])
  })
})

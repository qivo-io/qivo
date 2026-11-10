/* One owner's load as a caller may see it, read through that owner's own
 * open tasks and never the organization's. planning.ownerLoads and
 * planning.assigneeLoad (convex/planning.ts), the REST and MCP workload
 * pages (planning.ts workloadPage, through weeklyHours), the single-task
 * delay (lib/machineDelay.ts taskForecaster), and the Overview's and Team
 * sync's agenda's verdicts (lib/viewLoads.ts verdicts, the agenda's week
 * hours through weeklyHours) read it.
 *
 * For one owner it reads the owner's profile, their open tasks (five index
 * ranges: the tasks assigned to them in each status but Done, and the ones
 * In Review they review), the project row of each project those tasks name,
 * the caller's access to the live ones (lib/access.ts accessOf), and one
 * subtask range for each task left, so a group carries no load. The tasks it
 * answers pass the load fence (lib/loadRows.ts loadRowFor): ordinary tasks
 * owned (lib/review.ts taskOwnerId) by a profile of the caller's
 * organization, scheduled, neither Done nor paused, with remaining hours
 * above zero unless the caller keeps unestimated ones, not archived and in
 * a live project, which the caller may receive (loadShown). For
 * planning.ownerLoads alone (the `paused` option) it also answers the
 * owner's paused tasks in live projects the caller can see, which are not
 * groups, read and bounded with the others.
 *
 * Every read is bounded before it is made (OWNER_LOADS). An owner whose
 * reads pass a bound answers unavailable, never fewer tasks presented as all
 * of them and never no tasks. Owners are read one after another, and one
 * that the call has no room left for answers not_read, unless it is the
 * first, so the first owner of any call gets the answer it gets alone and a
 * caller that asks the not_read owners again always gets further. */

import type { TransactionMetrics } from 'convex/server'
import { getDocumentSize } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { DOCUMENT_MAX_BYTES } from '../model/comments'
import { type Access, isAccessUnchecked, isOrgStaff, isRoomSpent, OWN_READS } from './access'
import type { ReadCeiling } from './archivedTasks'
import { byId } from './db'
import { ISSUE_STATUSES } from './enums'
import { MIB, PROJECT_ROW_MAX_BYTES, TEAM_ROW_MAX_BYTES } from './limits'
import { countsAsSubtask } from './liveTasks'
import { loadRowFor, loadShown, type OrgLoadRow } from './loadRows'
import { roundTenths } from './numbers'
import { taskOwnerId } from './review'
import { canonicalLoad, committedByWeek, type LoadSpan, type WeekGrid } from './workload'

/** The bounds of an owner-load read, which tests lower and set back with
 * structuredClone.
 *
 * - `owners`: the most owners one planning.ownerLoads call asks about, as
 *   lib/teamSync.ts SYNC_OWNERS_MAX for teamSync.lastComments.
 * - `open`: the most rows an owner's five open-task ranges may read,
 *   duplicates, Backlog, unscheduled and paused tasks and the open tasks of
 *   archived projects included. Each range is read one row at a time and
 *   stops at the row past it. A task row without its text copy takes up to
 *   about 1.8 KB at the title cap, so the rows take up to about 3.6 MB.
 * - `checks`: the most tasks of one owner checked for subtasks, one index
 *   range each, once the fence and the caller's sight have left them. With
 *   the `paused` option the paused tasks in projects the caller can see
 *   count with the load's.
 * - `projects`: the most live projects of one owner's scheduled tasks
 *   whose access the read asks about, each one question, those of the
 *   paused tasks included with the `paused` option. That is the design
 *   size's 200 live sub-projects one person can read.
 * - `spans`: the most spans one planning.ownerLoads answer carries, its
 *   load spans and its paused spans counted together. A span's JSON holds
 *   its task's and project's handles and a few numbers, so an answer of
 *   `spans` stays far inside Convex's limits however many owners it holds
 *   (convex/tests/ownerLoads.test.ts logs a span's size and the answer's at
 *   the design size), and one owner holds at most `checks` of both.
 * - `call`: what one call may read past the caller's own grants,
 *   memberships and team shares (lib/access.ts accessOf `shared`), alike in
 *   every call, as lib/taskWindow.ts TASK_WINDOW counts them.
 *
 * The call looks at its reads before each owner, each round of access
 * questions and each round of subtask checks, and counts each row it reads
 * itself between those looks (getDocumentSize), so it passes `call` by one
 * row for each read in flight at most, or by what its last round of
 * questions read past the price it gave each question (QUESTION). Past
 * `call` come the shared reads (OWN_READS states them): at most 266 ranges
 * and 7,098 documents, or 521 ranges for a person in 129 to 256 teams, past
 * the design size; up to about 1.2 MiB of the organization's teams,
 * which counts JSON; and the person's own rows (grants, memberships,
 * shares), a few hundred bytes each at ordinary name lengths and up to
 * about 3 KB at the name caps. Beside its questions the access instance
 * reads single rows too, at most 193 ranges and 705 documents. At most
 * 2,714 ranges and 23,803 documents in all, so a call stays inside
 * Convex's 4,096 ranges and 32,000 documents; and inside its 16 MiB for a
 * person in the design size's 5 teams, whose own rows at ordinary name
 * lengths add at most a few MB to `call`'s 8 MiB. A person with thousands
 * of those rows near the name caps can still make a call pass 16 MiB.
 *
 * A lone owner reads 1 range for the profile, 5 for the open tasks, 1 for
 * each project its scheduled tasks that can carry load name (and, with the
 * `paused` option, its paused ones), at most 6 for each live one asked
 * about (`projects` of them) and at most 2 for each check (`checks`), and in
 * documents up to `open` rows, the project rows, at most 134 for each
 * question and 2 for each check. Once a caller's own rows are read at a
 * step of OWN_READS.steps a question reads one or two ranges, so at
 * `projects` and `checks` an owner reads about 1,600 ranges, inside
 * `call`; the prices' worst case, 2,406, is past it, and `call` then makes
 * the owner unavailable rather than failing.
 * convex/tests/ownerLoads.test.ts ("at the design size") logs what a call
 * reads for an owner of 2,000 open tasks with ordinary titles, 500 of them
 * planned over 200 sub-projects, read by a staff member who reads them all
 * through the shares of 3 teams on their top-level projects, and for 50
 * owners, the other 49 with 40 planned tasks each, whom `call` splits over
 * more than one call. With the `paused` option, as planning.ownerLoads
 * reads, it logs the same owner with one in twelve of its 450 planned
 * leaves paused, which fill `checks` beside the rest, and an owner with 30
 * planned tasks in 3 sub-projects and a paused task in each of the 200.
 * Past `projects` live projects named by tasks that can carry load and
 * paused ones together, past `checks` checked tasks (the load tasks the
 * caller receives by loadShown, hidden ones included for staff and a
 * guest's or Viewer's own, and the paused ones in projects the caller can
 * see), or past `open` rows, an owner is unavailable in
 * planning.ownerLoads, their paused weeks with their hours, as for any
 * figure that depends on people's workloads (the owner's choice of
 * 1 November 2026). Tests lower these. */
export const OWNER_LOADS = {
  owners: 50,
  open: 2000,
  checks: 500,
  projects: 200,
  spans: 5000,
  call: { ranges: 2000, documents: 16_000, bytes: 8 * MIB } satisfies ReadCeiling,
}

/** One task an owner's load holds, with its project, and whether the caller
 * can see that project. */
export type OwnedTask = { task: Doc<'issues'>; project: Doc<'projects'>; visible: boolean }

/** An owner's load as one read answers it: `ok` with every task that passes
 * the fence (`tasks`), groups left out, and with the `paused` option the
 * owner's paused tasks in live projects the caller can see that are not
 * groups (`paused`, else empty), both in creation order; `unavailable` when
 * the owner's reads do not fit the bounds (`why` 'reads') or a check of the
 * caller's access a bound stopped (`why` 'access', lib/access.ts
 * accessUnchecked); `not_read` when the call ran out of room before this
 * owner, so a call with fewer owners can read it. */
export type OwnedLoad =
  | { state: 'ok'; tasks: OwnedTask[]; paused: OwnedTask[] }
  | { state: 'unavailable'; why: 'reads' | 'access' }
  | { state: 'not_read' }

/** What a read may still read on each count, given the transaction's
 * metrics, what the caller's access counted as shared so far
 * (lib/access.ts accessOf `shared`), and whether the caller's access may
 * read the caller's own rows at once in the round about to start (`wide`):
 * their grants, memberships and teams' shares at a step of OWN_READS.steps,
 * or all their memberships and the organization's teams once it has asked
 * about more teams than OWN_READS.lookups one by one. The reader sets it
 * once it asks about a second project besides a top-level one, as the team
 * shares of two sub-projects can name that many teams past the design size,
 * which allows 5 a project, or about a top-level project, whose question may read the
 * caller's reach rows for navigation. Those reads count as shared, which
 * `call` leaves out and the request's limits do not. */
export type ReadRoom = (m: TransactionMetrics, shared: ReadCeiling, wide: boolean) => ReadCeiling

/** The room of a call that reads nothing else of size first, as
 * planning.ownerLoads and planning.assigneeLoad: OWNER_LOADS.call past the
 * caller's shared reads. */
export const callRoom: ReadRoom = (m, shared) => ({
  ranges: OWNER_LOADS.call.ranges - (m.databaseQueries.used - shared.ranges),
  documents: OWNER_LOADS.call.documents - (m.documentsRead.used - shared.documents),
  bytes: OWNER_LOADS.call.bytes - (m.bytesRead.used - shared.bytes),
})

/* What one access question about a project not asked before reads at
 * most, besides the caller's own rows and the instance's single-row reads
 * (lib/access.ts OWN_READS): the project and its parent, the caller's grant
 * on each and the team shares on each, 6 ranges and 134 documents, at two
 * project rows and the rest at TEAM_ROW_MAX_BYTES. */
const QUESTION: ReadCeiling = {
  ranges: 6,
  documents: 4 + 2 * (OWN_READS.projectShares + 1),
  bytes: 2 * PROJECT_ROW_MAX_BYTES + (2 + 2 * (OWN_READS.projectShares + 1)) * TEAM_ROW_MAX_BYTES,
}

/* One project row read by id, for its liveness. */
const PROJECT_READ: ReadCeiling = { ranges: 1, documents: 1, bytes: PROJECT_ROW_MAX_BYTES }

/* One subtask check: its index range, its first subtask, which can come
 * close to Convex's document size limit, and that subtask's project. A
 * check reads further only while the subtasks it reads are in projects
 * that are not live, and counts each of those rows as it reads it. */
const CHECK: ReadCeiling = {
  ranges: 2,
  documents: 2,
  bytes: DOCUMENT_MAX_BYTES + PROJECT_ROW_MAX_BYTES,
}

/* The owner's profile, read by id. */
const PROFILE: ReadCeiling = { ranges: 1, documents: 1, bytes: DOCUMENT_MAX_BYTES }

/* The statuses of tasks that can carry load, every one but Done. */
const OPEN_STATUSES = ISSUE_STATUSES.filter((status) => status !== 'done')

/* A read the call has no room left for. */
class NoRoom extends Error {}

/* Which of a round's refusals a read answers by: another error first, then
 * an access check a bound of the caller's own rows stopped, then a lack of
 * room, which a call with fewer owners may not meet. */
const rank = (e: unknown) =>
  e instanceof NoRoom || isRoomSpent(e) ? 2 : isAccessUnchecked(e) ? 1 : 0

const UNAVAILABLE = { state: 'unavailable', why: 'reads' } as const
const UNCHECKED = { state: 'unavailable', why: 'access' } as const
const NOT_READ = { state: 'not_read' } as const

/* The open-task ranges of `ownerId`: one per open status of the tasks they
 * are assigned, and the In Review tasks they review. A task with the same
 * person in both roles turns up twice. */
const openRanges = (ctx: QueryCtx, ownerId: string) => [
  ...OPEN_STATUSES.map((status) =>
    ctx.db
      .query('issues')
      .withIndex('by_assignee_archived_status', (q) =>
        q.eq('assignee_id', ownerId).eq('archived_at', undefined).eq('status', status),
      ),
  ),
  // a reviewer owns a task only while it is in review (lib/review.ts)
  ctx.db
    .query('issues')
    .withIndex('by_reviewer_archived_status', (q) =>
      q.eq('reviewer_id', ownerId).eq('archived_at', undefined).eq('status', 'review'),
    ),
]

/**
 * A reader of the owners' loads for caller `me`, through `access`, an
 * accessOf instance for `me` that the reads share, within `room` (callRoom
 * for a call of its own). `unestimated` keeps tasks without remaining hours
 * or with zero, as planning.assigneeLoad does. `paused` also answers the
 * owner's paused tasks in live projects `me` can see, whatever their
 * remaining hours, as planning.ownerLoads alone asks. Their projects' rows,
 * access questions and subtask checks count in the same bounds and room as
 * the load's, so an owner whose paused work passes one is unavailable or
 * not_read as a whole. Without it the reader reads no paused task's
 * project, access or subtasks. read() answers one owner by profile id; call
 * it for one owner after another, in the order asked.
 */
export function ownerLoadReader(
  ctx: QueryCtx,
  o: {
    me: Doc<'profiles'>
    access: Access
    room: ReadRoom
    unestimated?: boolean
    paused?: boolean
  },
) {
  const { me, access } = o
  const staff = isOrgStaff(me)
  /* what the call may still read, from its last look less what it counted
   * since */
  let left: ReadCeiling = { ranges: 0, documents: 0, bytes: 0 }
  /* the projects asked about and their top-level projects, and whether
   * the caller's access may now read the caller's own rows at once
   * (ReadRoom): once it asks about more than one sub-project and its
   * top-level project, or about a top-level project */
  const asked = new Set<string>()
  let wide = false
  const look = async () => {
    left = o.room(await ctx.meta.getTransactionMetrics(), access.shared, wide)
  }
  /* how many reads of `cost` fit in what is left */
  const fits = (cost: ReadCeiling) =>
    Math.max(
      0,
      Math.min(
        Math.floor(left.ranges / cost.ranges),
        Math.floor(left.documents / cost.documents),
        Math.floor(left.bytes / cost.bytes),
      ),
    )
  /* counts reads the call made, and throws NoRoom once a count passes */
  const spend = (ranges: number, documents: number, bytes: number) => {
    left = {
      ranges: left.ranges - ranges,
      documents: left.documents - documents,
      bytes: left.bytes - bytes,
    }
    if (left.ranges < 0 || left.documents < 0 || left.bytes < 0) throw new NoRoom()
  }
  const spendRow = (row: Doc<'issues' | 'profiles' | 'projects'>) =>
    spend(0, 1, getDocumentSize(row))

  /* whether each project is live (lib/access.ts accessOf live), its row
   * read once and counted by the first to ask */
  const lives = new Map<string, Promise<boolean>>()
  const liveOf = async (id: string): Promise<boolean> => {
    const known = lives.get(id)
    if (known !== undefined) return await known
    spend(1, 0, 0)
    const live = access.live(id)
    lives.set(id, live)
    const yes = await live
    const p = await access.project(id)
    if (p !== null) spendRow(p)
    return yes
  }
  /* whether the caller can see each live project asked about */
  const sight = new Map<string, boolean>()

  /* `each` of `items`, in rounds of as many as `cost` fits in what is left,
   * after a look at the reads when `fresh`. An item's reads that the call
   * does not count itself must fit `cost`. NoRoom when none fits. A round
   * waits for all its items and throws the first of their refusals by
   * rank. */
  const inRounds = async <T, R>(
    items: readonly T[],
    cost: ReadCeiling,
    fresh: boolean,
    each: (item: T) => Promise<R>,
  ): Promise<R[]> => {
    const out: R[] = []
    while (out.length < items.length) {
      if (fresh) await look()
      const n = Math.min(items.length - out.length, fits(cost))
      if (n === 0) throw new NoRoom()
      const got = await Promise.allSettled(items.slice(out.length, out.length + n).map(each))
      const failed = got.flatMap((one) => (one.status === 'rejected' ? [one.reason] : []))
      if (failed.length > 0) throw failed.sort((a, b) => rank(a) - rank(b))[0]
      for (const one of got) if (one.status === 'fulfilled') out.push(one.value)
    }
    return out
  }

  /* whether `task`, active in a live project, has an active subtask in a
   * live project, which makes it a group (lib/liveTasks.ts
   * countsAsSubtask), as model/issues.ts hasSubtasks answers with
   * access.live, its subtasks counted as they are read */
  const isGroup = async (task: Doc<'issues'>): Promise<boolean> => {
    spend(1, 0, 0)
    const kids = ctx.db
      .query('issues')
      .withIndex('by_parent_archived', (q) =>
        q.eq('parent_id', task.id).eq('archived_at', undefined),
      )
    for await (const kid of kids) {
      spendRow(kid)
      const child = { archived: false, projectLive: await liveOf(kid.project_id) }
      if (countsAsSubtask({ archived: false, projectLive: true }, child)) return true
    }
    return false
  }

  const readOwner = async (ownerId: string): Promise<OwnedLoad> => {
    await look()
    if (fits(PROFILE) === 0) throw new NoRoom()
    spend(1, 0, 0)
    const owner = await byId(ctx, 'profiles', ownerId)
    if (owner !== null) spendRow(owner)
    // the fence gives an owner outside the organization no rows
    if (owner === null || owner.org_id !== me.org_id) return { state: 'ok', tasks: [], paused: [] }

    // the open tasks, one row at a time, to the row past `open`
    const tasks = new Map<string, Doc<'issues'>>()
    let rows = 0
    for (const range of openRanges(ctx, owner.id)) {
      if (left.documents < 1 || left.bytes < 1) throw new NoRoom()
      spend(1, 0, 0)
      for await (const task of range) {
        rows += 1
        if (rows > OWNER_LOADS.open) return UNAVAILABLE
        spendRow(task)
        tasks.set(task.id, task)
      }
    }
    // what the fence drops on the task's own fields needs no other read
    const planned = [...tasks.values()].filter(
      (task) =>
        task.org_id === me.org_id &&
        taskOwnerId(task) === owner.id &&
        task.start_week !== undefined &&
        task.end_week !== undefined &&
        task.status !== 'done',
    )
    const candidates = planned.filter(
      (task) => !task.paused && (o.unestimated === true || (task.remaining_hours ?? 0) > 0),
    )
    // with the option, the paused ones whatever their hours, Backlog
    // included, as the app keeps a stored pause on a Backlog leaf
    const pausedCandidates = o.paused === true ? planned.filter((task) => task.paused) : []

    // the projects' rows, then the caller's sight of the live ones, for
    // both lists in the same rounds and bounds
    const named = [...new Set([...candidates, ...pausedCandidates].map((task) => task.project_id))]
    const fresh = named.filter((id) => !lives.has(id))
    await inRounds(fresh, PROJECT_READ, false, liveOf)
    const live = new Set<string>()
    for (const id of named) if (await liveOf(id)) live.add(id)
    if (live.size > OWNER_LOADS.projects) return UNAVAILABLE
    const unseen = [...live].filter((id) => !sight.has(id))
    for (const id of unseen) {
      asked.add(id)
      const parent = (await access.project(id))?.parent_id
      if (parent === undefined) wide = true
      else asked.add(parent)
    }
    if (asked.size > 2) wide = true
    await inRounds(unseen, QUESTION, true, async (id) => {
      sight.set(id, await access.visible(id))
    })

    // the caller's sight of what is left (loadShown), then the groups
    const shown = candidates.filter(
      (task) =>
        live.has(task.project_id) &&
        loadShown({
          staff,
          visible: sight.get(task.project_id) === true,
          owner: owner.id,
          meId: me.id,
        }),
    )
    // a paused task only of a live project the caller can see, for every
    // role, so no one learns of paused work they cannot see
    const pausedShown = pausedCandidates.filter(
      (task) => live.has(task.project_id) && sight.get(task.project_id) === true,
    )
    if (shown.length + pausedShown.length > OWNER_LOADS.checks) return UNAVAILABLE
    await look()
    const checked = [...shown, ...pausedShown]
    const groups = await inRounds(checked, CHECK, false, isGroup)
    const out: OwnedTask[] = []
    const paused: OwnedTask[] = []
    for (const [i, task] of checked.entries()) {
      // a group's stored pause is dormant, and a group carries no load
      if (groups[i]) continue
      const project = await access.project(task.project_id)
      if (project === null) continue // unreachable: a live project was read
      const one = { task, project, visible: sight.get(task.project_id) === true }
      if (i < shown.length) out.push(one)
      else paused.push(one)
    }
    const byCreation = (a: OwnedTask, b: OwnedTask) => a.task._creationTime - b.task._creationTime
    return { state: 'ok', tasks: out.sort(byCreation), paused: paused.sort(byCreation) }
  }

  /* whether an owner was read yet, and whether one was not read */
  let started = false
  let ended = false
  return {
    /** The load of the owner with profile id `ownerId`, as `me` may see
     * it. An owner the call has no room left for answers not_read, unless
     * it is the first, and so does every owner after it. */
    read: async (ownerId: string): Promise<OwnedLoad> => {
      if (ended) return NOT_READ
      const first = !started
      started = true
      try {
        return await readOwner(ownerId)
      } catch (e) {
        if (!(e instanceof NoRoom) && !isRoomSpent(e)) {
          // a check a bound of the caller's own rows stopped
          if (isAccessUnchecked(e)) return UNCHECKED
          throw e
        }
        if (first) return isRoomSpent(e) ? UNCHECKED : UNAVAILABLE
        ended = true
        return NOT_READ
      }
    },
  }
}

/* Load rows in one total order, so an answer never depends on the order
 * the reads gave them and never tells a hidden task's project or creation
 * order: by weeks, the measurement, the hours, then the task id, a hidden
 * row's null first. */
export function byLoadRow(
  a: Omit<OrgLoadRow, 'owner_id'>,
  b: Omit<OrgLoadRow, 'owner_id'>,
): number {
  const keys = (r: Omit<OrgLoadRow, 'owner_id'>) => [
    r.start_week,
    r.end_week,
    r.remaining_set_at ?? '',
  ]
  const [x, y] = [keys(a), keys(b)]
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  if (a.remaining !== b.remaining) return a.remaining - b.remaining
  if (a.issue_id === b.issue_id) return 0
  if (a.issue_id === null) return -1
  if (b.issue_id === null) return 1
  return a.issue_id < b.issue_id ? -1 : 1
}

/** The load rows of `tasks`, an owned load that read() answered `ok` for
 * `me`, through the fence (lib/loadRows.ts loadRowFor) as the
 * organization's rows give them (convex/tests/orgLoad.setup.ts orgLoadRows,
 * the tests' oracle), in one total order (byLoadRow). Without remaining
 * hours a task has no row. */
export function loadRowsOf(me: Doc<'profiles'>, tasks: readonly OwnedTask[]): OrgLoadRow[] {
  const staff = isOrgStaff(me)
  const rows: OrgLoadRow[] = []
  for (const { task, visible } of tasks) {
    const row = loadRowFor(task, {
      // read() leaves groups out and answers live projects of `me`'s
      // organization and owners of it
      isGroup: false,
      projectLive: true,
      ownerInOrg: () => true,
      visible,
      staff,
      meId: me.id,
    })
    if (row !== null) rows.push(row)
  }
  return rows.sort(byLoadRow)
}

/** An owner's planned hours in each week of a window, and the part of them
 * from projects the caller cannot see. */
export type WeeklyHours = { hours: number[]; hidden_hours: number[] }

/**
 * The planned hours of `tasks`, an owned load that read() answered `ok` for
 * `me`, in each of `window.weeks` weeks of `grid` from week index
 * `window.first`, rounded to tenths, with `hidden_hours` the part of them
 * from projects `me` cannot see, unnamed. Only the tasks `keep` keeps
 * count, such as those of one project. Each task's load row (loadRowsOf)
 * spreads its remaining hours over its weeks by the app's rule
 * (lib/workload.ts committedByWeek, in canonicalLoad's order, so the sums
 * are the app's), and only the asked weeks are added up, however far a
 * plan runs. A row of a project `me` cannot see counts in both arrays. The
 * REST and MCP workload pages (planning.ts workloadPage) call it, and so
 * does Team sync's agenda (lib/teamSyncAgenda.ts) for each walker's hours
 * in the client's current week, over the tasks its verdicts' reader
 * answered within the agenda's own budget.
 */
export function weeklyHours(
  me: Doc<'profiles'>,
  tasks: readonly OwnedTask[],
  grid: WeekGrid,
  window: { first: number; weeks: number },
  keep: (task: OwnedTask) => boolean = () => true,
): WeeklyHours {
  const all: LoadSpan[] = []
  const hidden: LoadSpan[] = []
  for (const row of loadRowsOf(me, tasks.filter(keep))) {
    const span: LoadSpan = {
      issueUuid: row.issue_id,
      start: grid.ofDay(row.start_week),
      end: grid.ofDay(row.end_week),
      remaining: row.remaining,
      remainingSet: row.remaining_set_at === null ? null : grid.ofInstant(row.remaining_set_at),
    }
    all.push(span)
    if (row.issue_id === null) hidden.push(span)
  }
  const asked = { from: window.first, to: window.first + window.weeks - 1 }
  const perWeek = (spans: LoadSpan[]): number[] => {
    const byWeek = committedByWeek(canonicalLoad(spans), null, asked)
    return Array.from({ length: window.weeks }, (_, i) =>
      roundTenths(byWeek.get(window.first + i) ?? 0),
    )
  }
  return { hours: perWeek(all), hidden_hours: perWeek(hidden) }
}

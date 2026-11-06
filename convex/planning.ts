/* The plan_* load family. Busy TIME from projects the caller cannot see
 * reaches staff while the projection strips the identity. The fence is in
 * the filter, the anonymization in the projection, kept distinct here.
 * Every read here walks one owner's open tasks through the owner reader
 * (lib/ownerLoads.ts), within bounds past which an owner's load is
 * unavailable: assigneeLoad, ownerLoads, the REST and MCP workload pages
 * (workloadPage), the single-task delay and the REST and MCP list delays.
 * No read walks the organization's live tasks any more; the tests keep that
 * walk as their oracle (convex/tests/orgLoad.setup.ts orgLoadRows).
 *
 * The fence:
 *   scheduled (start_week set — the 0037 envelope CHECK means end_week too),
 *   ordinary task (no subtask that makes it a group, lib/liveTasks.ts
 *   countsAsSubtask), status <> done (0073), not paused
 *   (#310: its owner is free for other work; a paused Review task drops out
 *   too), issue not archived (0070), project not archived (0106), owner
 *   (lib/review.ts: the reviewer while In Review with one set, else the
 *   assignee) is a profile of THIS org (0065 — deliberately NO active and NO
 *   kind test: an inactive person's or an agent's scheduled work still counts
 *   as load), and the disclosure trio (0085 guests / 0102 viewers,
 *   lib/loadRows.ts loadShown):
 *   isOrgStaff(caller) OR can_see_project(issue) OR the caller owns the row.
 *   So staff get every qualifying row (invisible ones anonymized), while
 *   guests/viewers get only visible-or-own rows — other people's hidden work
 *   does not arrive at all, not even anonymously.
 *
 * ownerLoads and the workload pages ONLY add `remaining_hours > 0` to their
 * load rows; assigneeLoad has NO remaining filter, so unestimated/zero-
 * remaining scheduled rows are included.
 *
 * Beside the fence, ownerLoads alone also answers each owner's paused
 * tasks in live projects the caller can see, whatever their remaining
 * hours, groups left out, as a list of their own for the paused weeks of
 * Team utilization. A paused task in a project the caller cannot see
 * reaches no one, staff included. */

import { ConvexError, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { accessOf, accessUnchecked, isOrgStaff } from './lib/access'
import { byId } from './lib/db'
import type { OrgRole, ProfileKind } from './lib/enums'
import { authedQuery, badRequest, orgQuery, type Refusal, rule } from './lib/functions'
import {
  CURSOR_REFUSAL,
  filtersKey,
  listCursorText,
  NAMES_NOT_READY,
  openListCursor,
} from './lib/listCursor'
import type { OrgLoadRow } from './lib/loadRows'
import { indexAfter, type NamedAt, STOPPED } from './lib/namedPages'
import {
  callRoom,
  loadRowsOf,
  OWNER_LOADS,
  type OwnedLoad,
  type OwnedTask,
  ownerLoadReader,
  weeklyHours,
} from './lib/ownerLoads'
import { weekGrid } from './lib/workload'
import { type IdTie, nameKeysReady, profileIndex } from './model/nameKeys'

/* plan_assignee_load's wire shape — the SQL column names exactly. The client
 * never reads `title` today, but it is in the SQL contract; kept. */
export type AssigneeLoadRow = {
  issue_id: string | null
  title: string | null
  project_id: string | null
  project_name: string | null
  start_week: string
  end_week: string
  remaining: number | null
  remaining_set_at: string | null
  visible: boolean
}

/** The reason of the refusal of a load that does not fit the owner
 * reader's bounds (loadUnavailable). */
export const LOAD_UNAVAILABLE = 'load_unavailable'

/** The refusal of a person's load that the owner reader (lib/ownerLoads.ts)
 * could not read within its bounds, so the planning panel says the
 * workload is unavailable rather than counting the missing work as free
 * time. */
export const loadUnavailable = (): ConvexError<Refusal> =>
  new ConvexError<Refusal>({
    code: 'rule',
    reason: LOAD_UNAVAILABLE,
    message: "Qivo could not read all of this person's planned work in one request.",
  })

/* AssigneeLoadRows in one total order, so the answer never tells the
 * creation order or project of a row the caller cannot see: by weeks, the
 * measurement and the hours, an unestimated row first, then the task id, a
 * hidden row's null first (lib/ownerLoads.ts byLoadRow). */
function byAssigneeRow(a: AssigneeLoadRow, b: AssigneeLoadRow): number {
  const keys = (r: AssigneeLoadRow) => [r.start_week, r.end_week, r.remaining_set_at ?? '']
  const [x, y] = [keys(a), keys(b)]
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  if (a.remaining !== b.remaining) return (a.remaining ?? -1) - (b.remaining ?? -1)
  if (a.issue_id === b.issue_id) return 0
  if (a.issue_id === null) return -1
  if (b.issue_id === null) return 1
  return a.issue_id < b.issue_id ? -1 : 1
}

/* The person whose owned load: the assignee, or the reviewer while the task
 * is In Review (lib/review.ts). The arg keeps its `assignee_id` name. The
 * org is resolved server-side as that person's own org (the client's
 * `rows.profiles.get(uuid).org_id || HOME_ORG` fallback wart, removed).
 * Parity with the SQL fences: an unknown person, or a caller holding no
 * active seat in that person's org, yields an EMPTY ARRAY, not an error.
 *
 * The rows are the person's own open tasks, read by the owner reader
 * (lib/ownerLoads.ts) with unestimated ones kept, in one total order
 * (byAssigneeRow). Where the reader's bounds stop the read it refuses with
 * loadUnavailable, and where a bound stopped a check of the caller's access
 * with accessUnchecked, so the planning panel says the workload is
 * unavailable, never that the person is free. */
export const assigneeLoad = authedQuery({
  args: { assignee_id: v.string() },
  handler: async (ctx, { assignee_id }): Promise<AssigneeLoadRow[]> => {
    const assignee = await byId(ctx, 'profiles', assignee_id)
    if (assignee === null) return []
    const me = ctx.myProfiles.get(assignee.org_id)
    if (me === undefined) return []
    const access = accessOf(ctx, me)
    const reader = ownerLoadReader(ctx, { me, access, room: callRoom, unestimated: true })
    const load = await reader.read(assignee.id)
    if (load.state === 'unavailable' && load.why === 'access') throw accessUnchecked()
    // the first owner of a read is never not_read
    if (load.state !== 'ok') throw loadUnavailable()
    return load.tasks
      .map(
        ({ task, project, visible }): AssigneeLoadRow => ({
          issue_id: visible ? task.id : null,
          title: visible ? task.title : null,
          project_id: visible ? task.project_id : null,
          project_name: visible ? project.name : null,
          // the reader answers scheduled tasks only
          start_week: task.start_week ?? '',
          end_week: task.end_week ?? '',
          remaining: task.remaining_hours ?? null,
          remaining_set_at: task.remaining_set_at ?? null,
          visible,
        }),
      )
      .sort(byAssigneeRow)
  },
})

/** One span of an owner's load on the wire, a load row (lib/loadRows.ts
 * OrgLoadRow) without its owner, with its task's project. `issue_id` and
 * `project_id` are the task's and its own project's where the caller can
 * see that project, else both null. */
export type OwnerLoadSpan = Omit<OrgLoadRow, 'owner_id'> & { project_id: string | null }

/** One paused task of an owner on the wire, a scheduled task the owner owns
 * (lib/review.ts taskOwnerId) that is not Done, not a group and not
 * archived, in a live project the caller can see, whatever its remaining
 * hours. It carries no hours, as a paused task adds none. */
export type OwnerPausedSpan = {
  issue_id: string
  project_id: string
  start_week: string
  end_week: string
}

/** One owner of planning.ownerLoads' answer: `ok` with every span of their
 * load and their paused tasks the caller can see, `unavailable` when it did
 * not fit the reader's bounds or a check of the caller's access stopped,
 * `not_read` when the call had no room left for it, or did not read it
 * because the caller is a guest or Viewer and it is not the first, so
 * asking again with fewer owners reads it. */
export type OwnerLoadJson =
  | { owner_id: string; state: 'ok'; spans: OwnerLoadSpan[]; paused: OwnerPausedSpan[] }
  | { owner_id: string; state: 'unavailable' }
  | { owner_id: string; state: 'not_read' }

/* Paused spans in one total order, by weeks, then the task id. */
function byPausedSpan(a: OwnerPausedSpan, b: OwnerPausedSpan): number {
  const keys = (r: OwnerPausedSpan) => [r.start_week, r.end_week, r.issue_id]
  const [x, y] = [keys(a), keys(b)]
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

/** planning.ownerLoads' answer. */
export type OwnerLoadsJson = {
  /** 'counted': spans of projects the caller cannot see are in every
   * owner's load, without a task id (organization admins and users).
   * 'own_only': only in the caller's own load (guests and organization
   * Viewers), so another person's load leaves them out and is a
   * permission-limited figure. It follows the caller's role alone. */
  hidden: 'counted' | 'own_only'
  /** the owners in the order asked, each once */
  owners: OwnerLoadJson[]
}

/**
 * The load of each of `owner_ids` (at most OWNER_LOADS.owners, compared in
 * lowercase, each once, in the order given) as the caller may see it, for
 * delays and availability without the workspace's load rows. Each owner's
 * spans are their load rows (the fence above, remaining hours above zero)
 * in one total order (lib/ownerLoads.ts byLoadRow, which never reads the
 * project), each with its task's own project where it names the task.
 * Each owner's `paused` list holds their paused tasks in live projects the
 * caller can see (OwnerPausedSpan), by weeks and then task id. That list
 * follows the caller's sight alone, for every role. Staff get no paused
 * task of a project they cannot see, with or without its id, and a guest
 * or Viewer not even their own. Both are read by the owner reader within
 * its bounds, which count the paused tasks' projects, access questions and
 * subtask checks with the load's, so an owner whose paused work passes a
 * bound is unavailable as a whole. An owner of another organization or an
 * unknown id answers `ok` with no spans and no paused tasks. An owner whose
 * spans and paused spans would take the answer past OWNER_LOADS.spans
 * answers `not_read`, unless it is the first, and so does every owner after
 * a `not_read` one.
 *
 * A guest or organization Viewer gets one owner a call, the first, and
 * every later owner answers `not_read`. One room serves every owner of a
 * call, and the reader spends it on an owner's open tasks before it knows
 * which of them the caller can see, so where `not_read` started would
 * tell such a caller how much hidden work the owners before it hold.
 * Asking again for the `not_read` owners reads the next one. Staff keep
 * every owner the room holds. They receive each person's hidden busy time
 * without a task id or project (lib/loadRows.ts loadShown), but the room
 * also spends on what they never receive, every open row's document
 * (hidden unscheduled, zero-hour and paused ones included) and the access
 * questions about each live project named by the owners' hidden scheduled
 * tasks with remaining hours or hidden paused tasks. So where `not_read`
 * starts in a staff call, and whether an owner passes `projects`, can
 * follow how much hidden open work the owners hold and how many live
 * projects hold their hidden load and paused work, and nothing else of it.
 *
 * It reads each owner's profile and five open-task ranges, the project row
 * of each project their scheduled tasks that can carry load or are paused
 * name, the caller's access to the live ones (their own grants,
 * memberships and team shares among it) and a subtask range for each task
 * left, paused ones in projects the caller can see included. So a change
 * to those reruns it, such as a subtask added to a paused task, and no
 * other change in the organization does. The app's owner-load cache
 * (src/store/ownerLoadCache.ts) reads its spans for the delays of the
 * Board's and the Roadmap's bars the workspace does not hold yet and of
 * the task window's task, and keeps both lists for the Roadmap's Team
 * utilization and planning panel, which read each span's project and the
 * paused list (src/store/viewDelay.ts ownerItemsOf); the other views read
 * it once they stop reading the workspace's load rows.
 */
export const ownerLoads = orgQuery({
  args: { owner_ids: v.array(v.string()) },
  handler: async (ctx, { owner_ids }): Promise<OwnerLoadsJson> => {
    const ids = [...new Set(owner_ids.map((id) => id.toLowerCase()))]
    if (ids.length > OWNER_LOADS.owners) {
      throw badRequest(`at most ${OWNER_LOADS.owners} people at a time`)
    }
    const staff = isOrgStaff(ctx.me)
    const access = accessOf(ctx, ctx.me)
    const reader = ownerLoadReader(ctx, { me: ctx.me, access, room: callRoom, paused: true })
    const owners: OwnerLoadJson[] = []
    let spans = 0
    let ended = false
    for (const owner_id of ids) {
      // a guest's or Viewer's cut follows the order asked alone (above)
      if (!staff && owners.length > 0) ended = true
      const load = ended ? null : await reader.read(owner_id)
      if (load === null || load.state === 'not_read') {
        ended = true
        owners.push({ owner_id, state: 'not_read' })
      } else if (load.state === 'unavailable') {
        owners.push({ owner_id, state: 'unavailable' })
      } else {
        // a row names its task only where the caller can see its project
        const projectOf = new Map(load.tasks.map(({ task }) => [task.id, task.project_id]))
        const rows = loadRowsOf(ctx.me, load.tasks).map(
          ({ owner_id: _, ...row }): OwnerLoadSpan => ({
            ...row,
            project_id: row.issue_id === null ? null : (projectOf.get(row.issue_id) ?? null),
          }),
        )
        const paused = load.paused
          .map(
            ({ task }): OwnerPausedSpan => ({
              issue_id: task.id,
              project_id: task.project_id,
              // the reader answers scheduled tasks only
              start_week: task.start_week ?? '',
              end_week: task.end_week ?? '',
            }),
          )
          .sort(byPausedSpan)
        const size = rows.length + paused.length
        if (owners.length > 0 && spans + size > OWNER_LOADS.spans) {
          ended = true
          owners.push({ owner_id, state: 'not_read' })
        } else {
          spans += size
          owners.push({ owner_id, state: 'ok', spans: rows, paused })
        }
      }
    }
    return { hidden: staff ? 'counted' : 'own_only', owners }
  },
})

/** One person of a workload page, as REST and MCP read them. */
export type PersonWorkloadJson = {
  id: string
  name: string
  org_role: OrgRole
  kind: ProfileKind
  active: boolean
  /** null for an agent, whose capacity is unbounded */
  plannable_hours: number | null
} & (
  | {
      status: 'ok'
      /** planned hours in each week of week_starts, tasks the caller cannot see included */
      hours: number[]
      /** the part of hours from tasks the caller cannot see, which stay unnamed */
      hidden_hours: number[]
    }
  | {
      /** the person's open work did not fit the owner reader's bounds
       * (lib/ownerLoads.ts OWNER_LOADS), or a bound stopped a check of the
       * caller's access, so their hours are not known, and never zero */
      status: 'unavailable'
      hours: null
      hidden_hours: null
    }
)

/** One page of the REST and MCP workload. */
export type WorkloadJson = {
  /** the cursor of the next page, null only once every person is read */
  next_cursor: string | null
  /** the first day of each week, in order */
  week_starts: string[]
  /** the project the hours are limited to, or null for all of them */
  project: { id: string; key: string; name: string } | null
  /** 'counted' when work in projects the caller cannot see is in every
   * person's hours and hidden_hours (organization admins and users), and
   * 'own_only' when only the caller's own is (guests and organization
   * Viewers), so another person's hours are a permission-limited figure, as
   * planning.ownerLoads answers it. It follows the caller's role alone. */
  hidden: 'counted' | 'own_only'
  people: PersonWorkloadJson[]
}

/** The refusal of a workload window with a week outside the years 0000 to
 * 9999. */
export const WORKLOAD_YEARS = 'the workload window must fall within the years 0000 to 9999'

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/

/* The list name a workload cursor seals (lib/listCursor.ts). REST and MCP
 * answer the same rows, so they share it, and a cursor of one continues on
 * the other. */
const WORKLOAD_LIST = 'workload'

/* The position a workload cursor names in the people's name order, or a
 * refusal when its tie is not a profile id. */
async function workloadPosition(text: string, scope: readonly string[]): Promise<NamedAt<IdTie>> {
  const at = await openListCursor(text, WORKLOAD_LIST, scope, 1)
  const [id] = at.tie
  // a cursor this list wrote always holds a profile id
  if (typeof id !== 'string') throw badRequest(CURSOR_REFUSAL)
  return { key: at.key, tie: [id] }
}

/**
 * One page of the people of `me`'s organization, each with their planned
 * hours for `weeks` weeks from the week holding `fromDay` (YYYY-MM-DD), as
 * `me` may see them, for REST GET /v1/workload and MCP get_workload.
 *
 * The people come in name order (profiles.by_org_name, by the name key,
 * which ignores case and accents, in Convex's byte order, then the id),
 * after `cursor`, the next_cursor of an earlier page. Each person's hours
 * come from their own open tasks through the owner reader
 * (lib/ownerLoads.ts), the load planning.ownerLoads answers the app, spread
 * over the weeks by weeklyHours. This page asks for no paused list, so a
 * person whose paused work takes planning.ownerLoads past its bounds, and
 * so unavailable there, can still have hours here. They count work owned
 * by the reviewer while In Review, else the assignee, scheduled, not Done,
 * not paused, with remaining hours, outside archived tasks and projects.
 * Staff also receive the work of projects they cannot see, in hours and
 * again, unnamed, in hidden_hours; guests and Viewers receive only work
 * they can see or own.
 * `project`, a project `me` can see, keeps the work of it and its
 * sub-projects `me` can see, which leaves no hidden hours. No call reads
 * the organization's tasks or projects.
 *
 * A person whose load does not fit the reader's bounds, or whose check of
 * `me`'s access a bound stopped, is listed `unavailable` with null hours,
 * never zeros, an inactive one too, since their hours cannot be judged.
 * Every other active person is listed, and an inactive one only with hours
 * in the window. One reader serves the page, within one call's room
 * (callRoom, which counts the page's own reads). The page stops before a
 * person the call has no room left for, who starts the next page, and once
 * it lists `limit` people it reads the next profile only to know whether
 * one follows. A guest's or organization Viewer's page reads one person's
 * load at most, as planning.ownerLoads reads one owner a call for them, so
 * neither who is on their page nor where it ends follows another person's
 * hidden work. So a page can hold fewer than `limit` people, or none,
 * while next_cursor is set, and next_cursor is null only once the people
 * have all been read. The reader's first owner is never cut, so every page
 * moves on.
 *
 * The cursor is sealed with the organization, `me`, the project or `all`,
 * and the window's first day and weeks (lib/listCursor.ts), so it opens
 * only for that list, on either surface; any other cursor, or a changed
 * one, is refused with CURSOR_REFUSAL. Every page checks `me`'s access
 * afresh. Pages are not a snapshot, so a person renamed between pages
 * lands where the new name puts them. A page refuses with NAMES_NOT_READY
 * until the organization's name keys are all written (model/nameKeys.ts
 * nameKeysReady).
 *
 * `person` answers that person's row alone, inactive or idle, with
 * next_cursor null, reading no name index, so it needs no name keys.
 *
 * A person reads their profile from the index and again by id, five
 * open-task ranges, a project row and an access question for each live
 * project no one before them on the page named, and a subtask range for
 * each scheduled task left, so about 6 ranges a person without planned
 * work. Measured in convex/tests/workloadPages.test.ts ("at the design
 * size", 52 weeks each): 1,000 people with everyday work take 5 pages of
 * 200 at limit 200, the heaviest 1,272 ranges, 471 documents and 0.2 MB;
 * 50 people who hold the organization's 10,000 open tasks, 200 each over
 * seven sub-projects, take 6 pages at limit 50 (on demand,
 * QIVO_WORKLOAD_ORG_OPEN=1), each ended by the call's 2,000 ranges after
 * 9 or 10 people, the heaviest 1,999 ranges, 2,119 documents and 1.2 MB,
 * which the normal suite's 15 such people read too; for a caller who reads
 * the 200 sub-projects the people work in, through the shares of 3 teams,
 * 57 people take 2 pages, the heaviest 1,124 ranges, 934 documents and
 * 0.4 MB; and for a caller in 5 teams 107 people take one page of 1,106
 * ranges, 640 documents and 0.3 MB. Past `call` come the caller's own rows, as lib/ownerLoads.ts
 * OWNER_LOADS states them, so a page stays inside Convex's limits.
 */
export async function workloadPage(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  o: {
    fromDay: string
    weeks: number
    project: Doc<'projects'> | null
    limit: number
    cursor: string | null
    person?: Doc<'profiles'>
  },
): Promise<WorkloadJson> {
  const org = await byId(ctx, 'organizations', me.org_id)
  const grid = weekGrid(org?.week_start ?? 1)
  const first = grid.ofDay(o.fromDay)
  // the week holding 0000-01-01 can start in year -1, and a late 9999
  // window can run past year 9999, where week_starts would not be YYYY-MM-DD
  if (
    !DAY_SHAPE.test(grid.firstDay(first)) ||
    !DAY_SHAPE.test(grid.firstDay(first + o.weeks - 1))
  ) {
    throw badRequest(WORKLOAD_YEARS)
  }
  const window = { first, weeks: o.weeks }
  const project = o.project
  // the reader marks a task visible only in a project `me` can see
  const keep =
    project === null
      ? undefined
      : ({ task, project: p, visible }: OwnedTask) =>
          visible && (task.project_id === project.id || p.parent_id === project.id)
  const staff = isOrgStaff(me)
  const reader = ownerLoadReader(ctx, { me, access: accessOf(ctx, me), room: callRoom })
  /* `profile`'s row from their load, or null for an inactive person
   * without hours whom the page leaves out unless `always` */
  const rowOf = (
    profile: Doc<'profiles'>,
    load: Exclude<OwnedLoad, { state: 'not_read' }>,
    always: boolean,
  ): PersonWorkloadJson | null => {
    const fields = {
      id: profile.id,
      name: profile.name,
      org_role: profile.org_role,
      kind: profile.kind,
      active: profile.active,
      plannable_hours: profile.plannable_hours ?? null,
    }
    if (load.state === 'unavailable')
      return { ...fields, status: 'unavailable', hours: null, hidden_hours: null }
    const { hours, hidden_hours } = weeklyHours(me, load.tasks, grid, window, keep)
    if (!always && !profile.active && hours.every((h) => h === 0)) return null
    return { ...fields, status: 'ok', hours, hidden_hours }
  }
  const answer = (next_cursor: string | null, people: PersonWorkloadJson[]): WorkloadJson => ({
    next_cursor,
    week_starts: Array.from({ length: o.weeks }, (_, i) => grid.firstDay(first + i)),
    project: project === null ? null : { id: project.id, key: project.key, name: project.name },
    hidden: staff ? 'counted' : 'own_only',
    people,
  })

  if (o.person !== undefined) {
    const load = await reader.read(o.person.id)
    // the first owner a reader reads is never not_read
    if (load.state === 'not_read') throw new Error('the first owner of a read was not read')
    const row = rowOf(o.person, load, true)
    return answer(null, row === null ? [] : [row])
  }

  if (!(await nameKeysReady(ctx, me.org_id))) throw rule(NAMES_NOT_READY)
  const scope = [
    me.org_id,
    me.id,
    project?.id ?? 'all',
    await filtersKey([grid.firstDay(first), o.weeks]),
  ]
  const after = o.cursor === null ? null : await workloadPosition(o.cursor, scope)
  const people: PersonWorkloadJson[] = []
  // the last person the page read, whose answer is final, and whether
  // another follows where the page stopped
  let last: NamedAt | null = null
  let more = false
  let loads = 0
  // the profile rows are in the transaction's metrics, which the reader
  // looks at before each person, so the stream opens every range and
  // counts nothing itself
  const profiles = indexAfter(
    profileIndex(ctx, me.org_id),
    after,
  )({ open: async () => true, skip: async () => true })
  for await (const step of profiles) {
    if (step === STOPPED) throw new Error('a workload page opens every range')
    if (people.length >= o.limit || (!staff && loads > 0)) {
      more = true
      break
    }
    const load = await reader.read(step.row.id)
    if (load.state === 'not_read') {
      more = true
      break
    }
    loads += 1
    const row = rowOf(step.row, load, false)
    if (row !== null) people.push(row)
    last = step.at
  }
  if (!more) return answer(null, people)
  // a page stops only after the reader's first owner, which it always reads
  if (last === null) throw new Error('a workload page stopped before its first person')
  return answer(await listCursorText(WORKLOAD_LIST, scope, last), people)
}

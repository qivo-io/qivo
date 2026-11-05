/* Team sync's agenda behind teamSync.ts agenda, one meeting of the home
 * organization for one scope, every task the page shows with the people
 * it walks and their loads, within one budget (AGENDA) and Team sync's
 * ceiling of AGENDA.ceiling tasks, lib/limits.ts TEAM_SYNC_TASKS. It reads
 * through the shared view reader (lib/viewReads.ts) and the shared verdicts
 * (lib/viewLoads.ts), and holds Team sync's own rules beside the page's
 * (src/lib/teamSync.ts): the scopes, which tasks are rows, asks and Done
 * tasks, the walk's people, the reading floor (lib/teamSync.ts
 * readingBounds), the blockers, the ceiling and the counts bound, and the
 * states. The app imports this module's types only.
 *
 * A scope is a project (a top-level project with its visible live
 * sub-projects, or one sub-project), a team of the home organization (every
 * project shared with the team that the reader sees, a top-level project's
 * share reaching its visible live sub-projects), or All projects, every
 * visible top-level project's visible live sub-projects, read only when the
 * caller names it. A scope it cannot honour answers unavailable alike for
 * every reason, never another scope. The scope and the reader's access are
 * decided for each project before any of its tasks is read, and every task
 * the answer holds is in the reader's working set (lib/workingSet.ts).
 * Admin status adds nothing beyond what lib/access.ts accessOf answers.
 *
 * Beside lib/viewReads.ts's list, these still follow hidden data at a
 * budget's margin, each document a fixed size, so its contents move no
 * answer: how many of a team's shares name projects the reader cannot see;
 * how many live top-level projects the reader cannot see in All projects,
 * and the sub-projects the access reads by id for one the reader sees only
 * to navigate to some of its sub-projects, which their own reach rows name;
 * how many links a row has to tasks the reader is not shown, archived ones
 * and those of another organization included; each owner's work in
 * projects the reader cannot see, which staff's loads count (the owner
 * reader, design spec row 389); and a regroup anywhere in the organization,
 * which turns the counts bound off for a while (model/overviewCounts.ts
 * countsReady), as for the Roadmap's headings. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { countsOfRows, countsReady, subProjectRows } from '../model/overviewCounts'
import { reachReady } from '../model/projectNav'
import { stampOf } from '../model/syncStamps'
import { ACCESS_UNCHECKED, isAccessUnchecked, isOrgStaff } from './access'
import { byId } from './db'
import type { IssueStatus } from './enums'
import {
  MIB,
  PROJECT_ROW_MAX_BYTES,
  TASK_ROW_MAX_BYTES,
  TEAM_ROW_MAX_BYTES,
  TEAM_SYNC_TASKS,
} from './limits'
import { weeklyHours } from './ownerLoads'
import { taskOwnerId } from './review'
import { LINK_ROW_BYTES } from './roadmap'
import { issueKey } from './taskRefs'
import {
  askHorizon,
  type DoneFacts,
  doneSinceKind,
  needsAnOwner,
  readingBounds,
  type SyncStamp,
} from './teamSync'
import { byNumber, OverCeiling, order } from './viewFilters'
import { type Clock, clockOf, type Figure, UNKNOWN, verdicts } from './viewLoads'
import {
  BY_ID,
  byIdSteps,
  doneSinceRange,
  FOCUS_STATUSES,
  firstSubtaskCheck,
  groupFacts,
  inSteps,
  isGroupKnown,
  isOverBudget,
  noSubtasks,
  OverBudget,
  projectSelection,
  RANGE,
  type Reads,
  type Selection,
  type StepRange,
  SUB_COUNTS,
  selectionOf,
  selectionTasks,
  settled,
  shownParents,
  type ViewAccess,
  type ViewBudget,
  type ViewRow,
  type ViewSeats,
  viewAccess,
  viewBudget,
  viewRow,
} from './viewReads'

// --- budgets and shapes -----------------------------------------------------------

/** The agenda's budgets, which tests lower and set back with structuredClone.
 *
 * `reads` caps the request's reads as Convex counts them, the reader's own
 * access rows included (lib/viewReads.ts viewBudget), the Board's and the
 * Roadmap's (lib/board.ts BOARD.reads). `context` caps the shown parents of
 * rows, asks and Done tasks and the blockers outside the agenda, together,
 * the records an agenda reads beside its tasks; past it the answer is
 * over_budget. `ceiling` is the most agenda tasks one answer holds, rows,
 * asks and Done tasks together, each once, lib/limits.ts TEAM_SYNC_TASKS;
 * tests lower it here alone.
 *
 * Measured under convex-test's transaction limits with rows as the app
 * writes them, in ordinary text, data from before the rule of one level, a
 * staff reader in 3 teams and 10 owners holding the scope's tasks unless a
 * case says otherwise (tests/teamSyncAgenda.test.ts, real limits), in
 * ranges, documents and MiB, on 5 November 2026, each case one figure at
 * its design size, or the figures one read takes together at their sum:
 *
 * - A project of 800 open and 200 Done tasks not yet archived, its two
 *   figures at their sum as the read takes both, over 3 sub-projects that
 *   track delay, one in ten open tasks a group and two in ten subtasks, one
 *   in ten in Backlog, every Done task since its walker's floor, at the
 *   everyday link share (5 percent of the open tasks blocked, half by tasks
 *   of 2 everyday projects elsewhere): 2,154, 2,421 and 1.53, 650 rows, 200
 *   Done tasks, 81 parents and every walker's week.
 * - A project of 30 live sub-projects with 20 open tasks each beside its 40
 *   archived ones, which its selection reads together: 1,645, 1,538 and
 *   0.98.
 * - A sub-project of 300 open and 150 Done tasks beside two of 30: 900, 957
 *   and 0.60 for the sub-project, 1,016, 1,031 and 0.65 for its project.
 * - An everyday team, 20 sub-projects of 30 open tasks, read by a member in
 *   3 teams: 1,609, 1,612 and 0.99. The same for a member in 5 teams.
 * - A team that shares 50 live and 150 archived projects, the archived
 *   shares read first, over_ceiling from the counts in 1,325, 1,980 and
 *   0.98, and while the counts are not whole from the read in 1,732, 2,616
 *   and 1.41.
 * - All projects over 200 live top-level projects with 500 live and 1,000
 *   archived sub-projects, over_ceiling from the counts in 1,117, 1,676 and
 *   0.95 for an admin, 1,146, 1,685 and 0.95 for a member in 3 teams who
 *   sees 54 sub-projects across the names; while counting from the read in
 *   1,681, 3,039 and 1.78 and in 1,256, 2,053 and 1.21.
 * - An everyday project whose 90 tasks 90 people of a roster of 1,000 own:
 *   1,026, 375 and 0.19, every walker's week.
 * - An everyday team whose 600 rows 200 of its members own, of a roster of
 *   1,000: 3,341, 1,743 and 0.91, the walkers' profiles, memberships and
 *   stamps read in steps (lib/viewReads.ts byIdSteps); 142 of the 200
 *   weeks, as the loads of the last owners in owner id order pass the
 *   verdicts' room, which the agenda's own ranges bound there.
 *
 * Each task costs about one range for its group check beside its read, a
 * group's parent one more for its facts, each row one for its links and a
 * walker about one for their stamp, in a team one more for their
 * membership; a team's or All projects' sub-project one for its count
 * rows. The loads come last, the verdicts' room (lib/viewLoads.ts
 * loadRoom, lib/ownerLoads.ts OWNER_LOADS.call inside this guard), owners
 * in owner id order.
 *
 * The loads' measured size is 3,000 open tasks held by the scope's 10
 * owners across the organization, at which every walker's week is given
 * (2,030 ranges, 3,259 documents and 1.98 MiB). By the owner's rule of 1
 * November 2026 for figures that follow workloads, a walker's week and a
 * row's verdict that needs a load may answer unavailable past it, inside
 * the design size. It is measured for an everyday project of 3 sub-projects
 * of 30 open tasks whose 10 owners hold the organization's open tasks, half
 * of them scheduled, in sub-projects of 30, three to a project (the
 * on-demand cases, QIVO_AGENDA_ORG_OPEN=1). From 3,500 the owners last in
 * owner id order pass the verdicts' room of OWNER_LOADS.call, 2,000 ranges,
 * so their weeks and the verdicts that need them answer unavailable
 * (`loads`, `unknown`): one owner at 3,500, about half at 5,000, in 2,227
 * ranges. By 6,500 each owner's scheduled work is in more than the 200 live
 * projects the owner reader reads for one owner (OWNER_LOADS.projects), and
 * every week and every such verdict answers unavailable, in 445 ranges.
 * Inside the measured size the everyday team reads every walker's load.
 *
 * The Done tasks the reading floor loads beyond the page's exact reading
 * point count toward the ceiling, so a meeting whose certain tasks fit and
 * whose loaded ones do not answers over_budget. A Viewer's agenda reads no
 * load. Past AGENDA.context parents and outside blockers it answers
 * over_budget. */
export const AGENDA = {
  reads: { bytes: 12 * MIB, documents: 24_000, ranges: 3_600 },
  context: 2000,
  ceiling: TEAM_SYNC_TASKS,
}

/** A Team sync scope as teamSync.ts agenda takes it. */
export type AgendaScope =
  | { kind: 'project'; project_id: string }
  | { kind: 'team'; team_id: string }
  | { kind: 'all' }

/** A walk row, an open task without subtasks in the scope, as a view sends
 * it. */
export type AgendaRow = ViewRow & {
  /** the keys of the tasks that block it (blocks links whose target it is)
   * that the reader is shown and that are not done, by the link's creation
   * time, then its id, the order in which the app lists a task's links, as
   * src/lib/teamSync.ts blockersOf lists them */
  blocked_by: string[]
  /** the board banner's verdict (src/lib/teamSync.ts bannerVerdict), `late`
   * (Delayed) or `behind` (Slipping); null on track, without a verdict or
   * in a project that does not track delay; `unknown` in a project that
   * tracks delay where the verdict needs its owner's load and the load was
   * not read, or the reader is not staff */
  delay: 'late' | 'behind' | 'unknown' | null
}

/** One person the walk visits, an owner of a row (lib/review.ts
 * taskOwnerId), in a team scope only a member of the team. */
export type AgendaPerson = {
  id: string
  name: string
  kind: Doc<'profiles'>['kind']
  active: boolean
  /** their plannable hours a week as stored, null where absent
   * (lib/workload.ts plannableHoursOf reads them with `kind`) */
  plannable_hours: number | null
  /** their sync stamp (model/syncStamps.ts), null before their first */
  stamp: SyncStamp | null
  /** their planned hours in the client's current week, organization-wide
   * as `hidden` says, from their load spread by the app's rule
   * (lib/ownerLoads.ts weeklyHours), rounded to tenths of an hour; or why
   * they are not given, `loads` where their load was not read or the reader
   * is not staff, `budget` where the agenda's reads did not fit. Never a
   * zero for an unread load. */
  week: Figure<{ hours: number }>
}

/** What teamSync.agenda answers. */
export type AgendaAnswer =
  | {
      state: 'ok'
      /** the scope's sub-projects, by id (src/lib/teamSync.ts
       * scopeProjectIds) */
      sub_projects: string[]
      /** their top-level projects, for the opening's milestones
       * (scopeMetaIds), by id */
      top_projects: string[]
      /** the sub-projects of the scope the reader may edit (Edit, lead or
       * user level), by id */
      editable: string[]
      /** every open task without subtasks in the scope, whoever owns it */
      rows: AgendaRow[]
      /** the Backlog tasks Needs an owner lists (lib/teamSync.ts
       * needsAnOwner); the open ones it lists are rows */
      asks: ViewRow[]
      /** the Done tasks each walker's Done since can show, read from their
       * reading floor (lib/teamSync.ts readingBounds); the page keeps those
       * at or after its exact reading point (doneSinceKind) */
      done: ViewRow[]
      /** the shown ancestors of rows, asks and Done tasks that are none of
       * them */
      parents: ViewRow[]
      /** the walk's people, humans and agents, by id; the page orders them */
      people: AgendaPerson[]
      /** `counted` for staff, whose week hours include work in projects they
       * cannot see; `own_only` for an organization Viewer, whose figures the
       * page reads for itself (planning.ownerLoads), as the agenda reads no
       * load for them */
      hidden: 'counted' | 'own_only'
    }
  | { state: 'over_ceiling'; ceiling: number }
  | { state: 'over_budget' }
  | { state: 'unavailable'; reason?: typeof ACCESS_UNCHECKED; message?: string }

/** What the agenda answers for a scope it does not answer, alike for every
 * reason. */
const UNAVAILABLE = { state: 'unavailable' as const }

/** One share row as a step reads it, at its fixed size, as it may name a
 * project the reader cannot see. */
const SHARE_ROW: Reads = { bytes: TEAM_ROW_MAX_BYTES, documents: 1, ranges: 0 }

/** One project row as a range of them returns it. */
const PROJECT_ROW: Reads = { bytes: PROJECT_ROW_MAX_BYTES, documents: 1, ranges: 0 }

/** One link row read in a task's range. */
const LINK_ROW: Reads = { bytes: LINK_ROW_BYTES, documents: 1, ranges: 0 }

/** How many tasks one step of the agenda's group checks takes. */
const CHECK_STEP = 64

/** The statuses the scope's read takes: the rows' three and Backlog, for
 * the asks, two spans a sub-project. */
const READ_STATUSES: readonly IssueStatus[] = ['backlog', ...FOCUS_STATUSES]

// --- the read -------------------------------------------------------------------------

/**
 * The agenda of `args.scope` in the organization `args.org_id` for the
 * login whose seats are `profiles`, on the client's day and weeks
 * (lib/viewLoads.ts clockOf):
 *
 * - `ok` with every task the page shows, the people it walks and their
 *   loads;
 * - `over_ceiling` once more than AGENDA.ceiling agenda tasks were
 *   established, by the counts bound or by the AGENDA.ceiling + 1th row, ask
 *   or Done task certainly in the agenda, a Done task certain only from its
 *   walker's latest reading point (lib/teamSync.ts readingBounds top);
 * - `over_budget` when the reads reach AGENDA.reads first, when the tasks
 *   read from the reading floors pass the ceiling while those certainly in
 *   the agenda do not, or when the parents and outside blockers pass
 *   AGENDA.context;
 * - `unavailable`, alike for every reason, for a seat the login does not
 *   hold, a guest seat and a scope the reader cannot honour, and with
 *   `reason` and its sentence where a bound of the reader's own access reads
 *   stopped a check (lib/access.ts accessUnchecked). Never part of an
 *   agenda.
 *
 * Refuses a malformed clock (clockOf).
 */
export async function readAgenda(
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  args: {
    org_id: string
    scope: AgendaScope
    day: string
    week: string
    week_starts: readonly number[]
    week_end: number
  },
): Promise<AgendaAnswer> {
  const clock = clockOf(args)
  try {
    return await agendaOf(ctx, profiles, args, clock)
  } catch (e) {
    if (e instanceof OverCeiling) return { state: 'over_ceiling', ceiling: AGENDA.ceiling }
    if (isOverBudget(e)) return { state: 'over_budget' }
    if (isAccessUnchecked(e))
      return { state: 'unavailable', reason: ACCESS_UNCHECKED, message: e.data.message }
    throw e
  }
}

/* readAgenda's answer while it is ok. Stored facts come first and the loads
 * last, so a load that does not fit takes nothing the stored facts need,
 * and nothing after the loads goes through the guard. */
async function agendaOf(
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  args: Parameters<typeof readAgenda>[2],
  clock: Clock,
): Promise<AgendaAnswer> {
  const me = profiles.get(args.org_id)
  if (me === undefined || me.org_role === 'guest') return UNAVAILABLE
  const guard = viewBudget(ctx, AGENDA.reads)
  const seat = viewAccess(ctx, guard, me)
  const seats: ViewSeats = new Map([[me.org_id, seat]])
  const scope = args.scope
  const read = scopeRead(ctx, guard, seats, clock, scope.kind !== 'project')
  const named = await scopeOf(ctx, guard, seat, scope, read)
  if (named === null) return UNAVAILABLE
  await read.finish()
  const { known, tasks, rows, asks } = read

  // the walk's people, with every row owner's profile read once, as the
  // verdicts read the same profiles for each owner's capacity, and the
  // profiles, memberships and stamps in steps, as a meeting can walk
  // hundreds of people
  const v = verdicts(ctx, guard, seats, clock)
  const owners = [...new Set(rows.flatMap((t) => taskOwnerId(t, false) ?? []))].sort(order)
  const owned = await v.profiles(owners)
  let walkers = owned.flatMap((p) => (p !== null && p.org_id === me.org_id ? [p] : []))
  if (scope.kind === 'team') walkers = await membersOf(ctx, guard, scope.team_id, walkers)
  const stamps = await byIdSteps(guard, walkers, (p) => stampOf(ctx, p.id))

  // the Done tasks each walker's Done since can show
  const done = await doneOf(ctx, guard, seats, read, walkers, stamps, args, me.org_id)
  const agenda = [...rows, ...asks, ...done]
  const inAgenda = new Set(agenda.map((t) => t.id))

  // the parents, then the blockers, within AGENDA.context together
  const parents = await shownParents(ctx, guard, seats, agenda, tasks, AGENDA.context)
  const facts = await groupFacts(ctx, guard, seats, parents, known)
  const blockers = await blockersOf(ctx, guard, seats, read)
  const related = new Set(parents.map((t) => t.id))
  for (const id of blockers.ids) if (!inAgenda.has(id)) related.add(id)
  if (related.size > AGENDA.context) throw new OverBudget()

  // what the reader may edit, before the loads
  const subIds = read.subProjects.map((p) => p.id).sort(order)
  const levels = await seat.levels(subIds)
  const editable = subIds.filter((_, i) => levels[i] === 'lead' || levels[i] === 'user')

  const { delays, weeks } = await loadsOf(v, me, clock, read, walkers)
  // the tasks the answer holds, which a row's parent_id may name
  const shownIds = new Set([...inAgenda, ...parents.map((t) => t.id)])
  const shown = (id: string) => shownIds.has(id)
  const out = (t: Doc<'issues'>) => viewRow(t, shown, null)
  return {
    state: 'ok',
    sub_projects: subIds,
    top_projects: [...named.tops].sort(order),
    editable,
    rows: rows.sort(byNumber).map((t) => ({
      ...out(t),
      blocked_by: blockers.of(t),
      delay: delays.get(t.id) ?? null,
    })),
    asks: asks.sort(byNumber).map(out),
    done: done.sort(byNumber).map(out),
    parents: parents.sort(byNumber).map((t) => viewRow(t, shown, facts.get(t.id) ?? null)),
    people: walkers.map((p, i) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      active: p.active,
      plannable_hours: p.plannable_hours ?? null,
      stamp: stamps[i],
      week: weeks.get(p.id) ?? { state: 'unavailable', reason: 'loads' },
    })),
    hidden: isOrgStaff(me) ? 'counted' : 'own_only',
  }
}

// --- the scope's tasks ------------------------------------------------------------------

/** What scopeRead answers. */
type ScopeRead = ReturnType<typeof scopeRead>

/**
 * The rows and asks of a scope, read a batch of sub-projects at a time as
 * the scope's enumeration finds them (scopeOf), each sub-project once, so
 * the counts bound and the AGENDA.ceiling + 1th task stop the enumeration
 * where they establish the ceiling. A batch's active tasks in the rows'
 * three statuses and Backlog are read (selectionTasks), every one in the
 * reader's working set; the parent of each is a group. Open tasks, and
 * Backlog tasks Needs an owner lists, wait for their group checks
 * (firstSubtaskCheck) until more than a ceiling's worth wait, so parents in
 * the scope are known as groups without a range, as lib/viewFilters.ts
 * filterRead waits. Each without subtasks is a row or an ask and counts
 * toward AGENDA.ceiling.
 *
 * With `bound`, for a team and All projects, each batch's count rows are
 * read first (model/overviewCounts.ts, the organization's readiness once):
 * every counted To do, In progress and In review leaf of a sub-project is a
 * row, so their sum past the ceiling establishes it with none of the
 * batch's tasks read. Counts that are not whole turn the bound off, and the
 * read decides. A project scope reads no count row, as inside the design
 * size a project's open tasks never pass the ceiling.
 */
function scopeRead(
  ctx: QueryCtx,
  guard: ViewBudget,
  seats: ViewSeats,
  clock: Clock,
  bound: boolean,
) {
  const known = noSubtasks()
  // the tasks read, all in the reader's working set
  const tasks = new Map<string, Doc<'issues'>>()
  const subProjects: Doc<'projects'>[] = []
  const subIds = new Set<string>()
  const rows: Doc<'issues'>[] = []
  const asks: Doc<'issues'>[] = []
  let pending: Doc<'issues'>[] = []
  let counting = bound
  let ready: boolean | null = null
  let open = 0
  const horizon = askHorizon(clock.day)
  const orgId = [...seats.keys()][0] ?? ''

  /* whether Backlog task `t` is one Needs an owner lists, as far as its row
   * tells */
  const asked = (t: Doc<'issues'>) =>
    needsAnOwner(
      {
        status: t.status,
        pressing: t.priority === 'urgent' || t.priority === 'high',
        assigned: t.assignee_id !== undefined,
        group: false,
        startsByThisWeek: t.start_week !== undefined && clock.ofDay(t.start_week) <= 0,
        due: t.due_date ?? null,
      },
      horizon,
    )

  /* the group checks of the waiting tasks, and those without subtasks as
   * rows and asks */
  const decide = async () => {
    const waiting = pending
    pending = []
    for (let at = 0; at < waiting.length; at += CHECK_STEP) {
      const step = waiting.slice(at, at + CHECK_STEP)
      await firstSubtaskCheck(ctx, guard, seats, step, known)
      for (const t of step) {
        if (isGroupKnown(known, t.id) === true) continue
        ;(t.status === 'backlog' ? asks : rows).push(t)
        if (rows.length + asks.length > AGENDA.ceiling) throw new OverCeiling()
      }
    }
  }

  /* the counts bound over `batch`, new sub-projects of the scope */
  const countBound = async (batch: readonly Doc<'projects'>[]) => {
    if (!counting) return
    if (ready === null) {
      await guard.take(RANGE, 3)
      ready = await countsReady(ctx.db, orgId)
    }
    if (!ready) {
      counting = false
      return
    }
    await guard.take(SUB_COUNTS, batch.length)
    const got = await settled(batch.map((p) => subProjectRows(ctx.db, p.id)))
    for (const [i, p] of batch.entries()) {
      const c = countsOfRows(got[i], p)
      if (c === null) {
        counting = false
        return
      }
      open += c.leaves.todo + c.leaves.progress + c.leaves.review
    }
    if (open > AGENDA.ceiling) throw new OverCeiling()
  }

  return {
    known,
    tasks,
    subProjects,
    rows,
    asks,
    /** Adds the sub-projects of `batch` not added before and reads their
     * tasks. */
    async add(batch: readonly Doc<'projects'>[]): Promise<void> {
      const fresh = batch.filter((p) => !subIds.has(p.id))
      if (fresh.length === 0) return
      for (const p of fresh) {
        subIds.add(p.id)
        subProjects.push(p)
      }
      await countBound(fresh)
      for await (const step of selectionTasks(ctx, guard, fresh, READ_STATUSES)) {
        for (const t of step) {
          tasks.set(t.id, t)
          // an active task in a live project makes its parent a group, and
          // the reader is shown it
          known.shown.set(t.id, true)
          if (t.parent_id !== undefined) known.parents.add(t.parent_id)
          if (t.status !== 'backlog' || asked(t)) pending.push(t)
        }
        if (pending.length > AGENDA.ceiling) await decide()
      }
    },
    /** The group checks of the tasks still waiting. */
    finish: decide,
  }
}

/* What a scope named, its top-level projects, or null where the reader
 * cannot honour it. */
type Named = { tops: Set<string> } | null

/* Reads the sub-projects scope `scope` names for `seat`'s reader into
 * `read`, a project at a time, deciding the reader's access to each before
 * its tasks: a project selection (lib/viewReads.ts projectSelection); a
 * team of the reader's organization, its shares read in steps, each share
 * row and the team row at their fixed size, and each shared project's
 * selection, skipping those the reader cannot see; or All projects, once
 * the organization's reach rows are complete (model/projectNav.ts
 * reachReady, which every deployment has held since v0.1.97; the view
 * reads `unavailable` as a scope to choose again), the organization's live
 * top-level projects by name in steps, each at its fixed size, and the
 * selection of each the reader sees. */
async function scopeOf(
  ctx: QueryCtx,
  guard: ViewBudget,
  seat: ViewAccess,
  scope: AgendaScope,
  read: ScopeRead,
): Promise<Named> {
  const tops = new Set<string>()
  const add = async (selection: Selection | null) => {
    if (selection === null) return
    // a top-level project the reader sees only to navigate to sub-projects
    // none of which is live, such as an archived one they hold a grant on,
    // holds nothing, and the page does not show it (src/store/planner.ts
    // levelOn reads the live sub-projects)
    const { project, subProjects } = selection
    if (subProjects.length === 0 && !(await seat.accessible([project.id]))[0]) return
    tops.add(project.parent_id ?? project.id)
    await read.add(subProjects)
  }
  const orgId = seat.me.org_id
  if (scope.kind === 'project') {
    const selection = await projectSelection(ctx, guard, seat, scope.project_id)
    if (selection === null) return null
    await add(selection)
    return { tops }
  }
  if (scope.kind === 'team') {
    await guard.take(BY_ID)
    const team = await byId(ctx, 'teams', scope.team_id)
    if (team !== null) guard.charge(team, TEAM_ROW_MAX_BYTES)
    if (team === null || team.org_id !== orgId) return null
    const shares: StepRange<Doc<'project_team_access'>> = {
      open: (from) =>
        ctx.db
          .query('project_team_access')
          .withIndex('by_team', (q) =>
            from === undefined
              ? q.eq('team_id', team.id)
              : q.eq('team_id', team.id).gte('_creationTime', from),
          ),
    }
    const asked = new Set<string>()
    const charge = (row: Doc<'project_team_access'>) => guard.charge(row, TEAM_ROW_MAX_BYTES)
    for await (const step of inSteps(guard, [shares], SHARE_ROW, charge))
      for (const share of step) {
        if (asked.has(share.project_id)) continue
        asked.add(share.project_id)
        await add(await projectSelection(ctx, guard, seat, share.project_id))
      }
    return { tops }
  }
  await guard.take(BY_ID)
  if (!(await reachReady(ctx, orgId))) return null
  const charge = (p: Doc<'projects'>) => guard.charge(p, PROJECT_ROW_MAX_BYTES)
  for await (const step of inSteps(guard, [liveTops(ctx, orgId)], PROJECT_ROW, charge)) {
    for (const p of step) seat.seen(p, true)
    const seen = await seat.visible(step.map((p) => p.id))
    for (const [i, p] of step.entries())
      if (seen[i]) await add(await selectionOf(ctx, guard, seat, p))
  }
  return { tops }
}

/* The live top-level projects of organization `orgId` in name order
 * (projects by_org_parent_state_name), name key then id, after a step's
 * last row, the rest of its name key and the later ones. */
function liveTops(
  ctx: QueryCtx,
  orgId: string,
  from?: { after: Doc<'projects'>; part: 'same' | 'later' },
): StepRange<Doc<'projects'>> {
  return {
    open: () =>
      ctx.db.query('projects').withIndex('by_org_parent_state_name', (q) => {
        const live = q.eq('org_id', orgId).eq('parent_id', undefined).eq('archive_state', 'live')
        if (from === undefined) return live
        const key = from.after.name_key
        if (from.part === 'same') return live.eq('name_key', key).gt('id', from.after.id)
        return key === undefined ? live.gte('name_key', '') : live.gt('name_key', key)
      }),
    after: (last) =>
      from?.part === 'same'
        ? [liveTops(ctx, orgId, { after: last, part: 'same' })]
        : [
            liveTops(ctx, orgId, { after: last, part: 'same' }),
            liveTops(ctx, orgId, { after: last, part: 'later' }),
          ],
  }
}

// --- the people ---------------------------------------------------------------------------

/* Those of `people` who are members of team `teamId`, each asked by their
 * own membership row (team_members by_team_profile), in steps
 * (lib/viewReads.ts byIdSteps), so the reads follow the rows' owners and
 * never the team's whole roster. */
async function membersOf(
  ctx: QueryCtx,
  guard: ViewBudget,
  teamId: string,
  people: readonly Doc<'profiles'>[],
): Promise<Doc<'profiles'>[]> {
  const rows = await byIdSteps(guard, people, (p) =>
    ctx.db
      .query('team_members')
      .withIndex('by_team_profile', (q) => q.eq('team_id', teamId).eq('profile_id', p.id))
      .first(),
  )
  return people.filter((_, i) => rows[i] !== null)
}

// --- Done since -----------------------------------------------------------------------------

/* `t`, a Done task read before its group check, as doneSinceKind reads it,
 * a task without subtasks. */
const doneFacts = (t: Doc<'issues'>): DoneFacts => ({
  status: t.status,
  group: false,
  doneAt: t.done_at === undefined ? null : Date.parse(t.done_at),
  assignee: t.assignee_id ?? null,
  reviewer: t.reviewer_id ?? null,
  handedOff: t.review_at !== undefined,
})

/**
 * The Done tasks of the scope's sub-projects that some walker's Done since
 * can show on the client's day, read from each walker's reading floor
 * (lib/teamSync.ts readingBounds, with the organization's week start), one
 * range a sub-project from the earliest floor, a task kept where its
 * assignee is a walker and it reached Done at or after that walker's floor,
 * or its reviewer is another walker, with a review hand-off, and it reached
 * Done at or after the reviewer's floor (doneSinceKind), before its group
 * check, and kept where it has no subtasks. A task on two pages is one.
 *
 * The answer holds every task some floor reaches, so the page can apply
 * its exact reading point. A task is certain only from its walker's latest
 * reading point (`top`). Rows, asks and certain Done tasks past
 * AGENDA.ceiling throw OverCeiling; otherwise those with the other Done
 * tasks past it throw OverBudget, as the selection may fit by the page's
 * own rule.
 */
async function doneOf(
  ctx: QueryCtx,
  guard: ViewBudget,
  seats: ViewSeats,
  read: ScopeRead,
  walkers: readonly Doc<'profiles'>[],
  stamps: readonly (SyncStamp | null)[],
  clock: Parameters<typeof readingBounds>[1],
  orgId: string,
): Promise<Doc<'issues'>[]> {
  if (walkers.length === 0) return []
  await guard.take(BY_ID)
  const org = await byId(ctx, 'organizations', orgId)
  const weekStart = org?.week_start ?? 1
  const bounds = new Map(
    walkers.map((p, i) => [p.id, readingBounds(stamps[i], clock, weekStart)] as const),
  )
  /* whether a walker's Done since shows `t` from their `point` */
  const shows = (t: Doc<'issues'>, point: 'floor' | 'top') => {
    for (const id of [t.assignee_id, t.reviewer_id]) {
      const b = id === undefined ? undefined : bounds.get(id)
      if (id !== undefined && b !== undefined && doneSinceKind(doneFacts(t), id, b[point]))
        return true
    }
    return false
  }
  const from = new Date(Math.min(...[...bounds.values()].map((b) => b.floor))).toISOString()
  const candidates: Doc<'issues'>[] = []
  const ranges = read.subProjects.map((p) => doneSinceRange(ctx, p.id, from))
  for await (const step of inSteps(guard, ranges))
    for (const t of step) {
      read.tasks.set(t.id, t)
      read.known.shown.set(t.id, true)
      if (t.parent_id !== undefined) read.known.parents.add(t.parent_id)
      if (shows(t, 'floor')) candidates.push(t)
    }
  for (let at = 0; at < candidates.length; at += CHECK_STEP)
    await firstSubtaskCheck(ctx, guard, seats, candidates.slice(at, at + CHECK_STEP), read.known)
  const done = candidates.filter((t) => isGroupKnown(read.known, t.id) !== true)
  const certain = done.filter((t) => shows(t, 'top')).length
  const fixed = read.rows.length + read.asks.length
  if (fixed + certain > AGENDA.ceiling) throw new OverCeiling()
  if (fixed + done.length > AGENDA.ceiling) throw new OverBudget()
  return done
}

// --- blockers -------------------------------------------------------------------------------

/**
 * The blockers of the scope's rows, from each row's blocks links as their target
 * (issue_links by_target, each row at LINK_ROW_BYTES, relates links
 * dropped), and each blocker the read does not hold read by id at
 * TASK_ROW_MAX_BYTES, dropped unless it is of the row's organization, before
 * any check of it, and kept only where it is in the reader's working set
 * (lib/viewReads.ts ViewAccess holds). A kept blocker's group check, and a
 * group's facts, say whether it is done (src/lib/issueGroups.ts
 * isIssueDone). `of` answers a row's blocked_by; `ids` names every kept
 * blocker, and those outside the agenda count toward AGENDA.context.
 */
async function blockersOf(
  ctx: QueryCtx,
  guard: ViewBudget,
  seats: ViewSeats,
  read: ScopeRead,
): Promise<{ of: (row: Doc<'issues'>) => string[]; ids: string[] }> {
  const links = new Map<string, Doc<'issue_links'>[]>()
  const ranges: StepRange<Doc<'issue_links'>>[] = read.rows.map((row) => ({
    open: (from) =>
      ctx.db
        .query('issue_links')
        .withIndex('by_target', (q) =>
          from === undefined
            ? q.eq('target_id', row.id)
            : q.eq('target_id', row.id).gte('_creationTime', from),
        ),
  }))
  const charge = (link: Doc<'issue_links'>) => guard.charge(link, LINK_ROW_BYTES)
  for await (const step of inSteps(guard, ranges, LINK_ROW, charge))
    for (const link of step)
      if (link.type === 'blocks')
        links.set(link.target_id, [...(links.get(link.target_id) ?? []), link])
  const orgId = [...seats.keys()][0] ?? ''
  const seat = seats.get(orgId)
  const kept = new Map<string, Doc<'issues'>>()
  const wanted: string[] = []
  for (const id of new Set([...links.values()].flat().map((l) => l.source_id))) {
    const t = read.tasks.get(id)
    if (t !== undefined) kept.set(id, t)
    else wanted.push(id)
  }
  for (let at = 0; at < wanted.length; ) {
    const step = wanted.slice(
      at,
      at + (await guard.upTo(BY_ID, Math.min(CHECK_STEP, wanted.length - at))),
    )
    at += step.length
    const found = await settled(step.map((id) => byId(ctx, 'issues', id)))
    const ours: Doc<'issues'>[] = []
    for (const t of found) {
      if (t === null) continue
      guard.charge(t, TASK_ROW_MAX_BYTES)
      if (t.org_id === orgId) ours.push(t)
    }
    if (seat === undefined || ours.length === 0) continue
    const held = await seat.holds(ours)
    for (const [i, t] of ours.entries()) {
      if (!held[i]) continue
      kept.set(t.id, t)
      read.known.shown.set(t.id, true)
      if (t.parent_id !== undefined) read.known.parents.add(t.parent_id)
    }
  }
  const blockers = [...kept.values()]
  for (let at = 0; at < blockers.length; at += CHECK_STEP)
    await firstSubtaskCheck(ctx, guard, seats, blockers.slice(at, at + CHECK_STEP), read.known)
  const groups = blockers.filter((t) => isGroupKnown(read.known, t.id) === true)
  const facts = await groupFacts(ctx, guard, seats, groups, read.known)
  const isDone = (t: Doc<'issues'>) =>
    isGroupKnown(read.known, t.id) === true ? facts.get(t.id)?.done === true : t.status === 'done'
  const byCreation = (a: Doc<'issue_links'>, b: Doc<'issue_links'>) =>
    order(a.created_at, b.created_at) || order(a.id, b.id)
  return {
    of: (row) =>
      [...(links.get(row.id) ?? [])].sort(byCreation).flatMap((link) => {
        const b = kept.get(link.source_id)
        return b === undefined || isDone(b) ? [] : [issueKey(b.num)]
      }),
    ids: [...kept.keys()],
  }
}

// --- loads ----------------------------------------------------------------------------------

/**
 * The rows' delays and the walkers' week hours, through the shared verdicts
 * (lib/viewLoads.ts verdicts), with every profile they read already read.
 * For staff the owners are the walkers and the owners whose load a row's
 * verdict needs in a project that tracks delay, read in owner id order
 * (readAll) within the verdicts' room, lib/ownerLoads.ts OWNER_LOADS.call
 * inside the agenda's guard. A row whose verdict needs a load not read is
 * `unknown`, and so is a walker's week, `loads`. An organization Viewer, the
 * only other seat that reaches here, reads no load (the coordinator's
 * answer of 5 November 2026). Their rows whose verdict needs one are
 * `unknown`, the others judged, and every week `loads`. A row in a project
 * that does not track delay has no verdict. Should a read here pass the
 * guard, every row of a project that tracks delay is `unknown` and every
 * week `budget`.
 */
async function loadsOf(
  v: ReturnType<typeof verdicts>,
  me: Doc<'profiles'>,
  clock: Clock,
  read: ScopeRead,
  walkers: readonly Doc<'profiles'>[],
): Promise<{
  delays: Map<string, AgendaRow['delay']>
  weeks: Map<string, Figure<{ hours: number }>>
}> {
  const staff = isOrgStaff(me)
  const tracking = new Set(read.subProjects.filter((p) => p.track_delay).map((p) => p.id))
  const tracked = read.rows.filter((t) => tracking.has(t.project_id))
  const delays = new Map<string, AgendaRow['delay']>()
  const weeks = new Map<string, Figure<{ hours: number }>>()
  try {
    if (staff) {
      const owners = walkers.map((p) => p.id)
      for (const t of tracked) {
        const owner = await v.needs(t, null)
        if (owner !== null) owners.push(owner)
      }
      await v.readAll(me.org_id, owners)
    }
    for (const t of tracked) {
      if (!staff && (await v.needs(t, null)) !== null) {
        delays.set(t.id, 'unknown')
        continue
      }
      const verdict = await v.of(t, null)
      delays.set(
        t.id,
        verdict === UNKNOWN
          ? 'unknown'
          : verdict === null || verdict.status === 'ok'
            ? null
            : verdict.status,
      )
    }
    for (const p of walkers) {
      const owned = staff ? v.tasksOf(p.id) : null
      weeks.set(
        p.id,
        owned === null
          ? { state: 'unavailable', reason: 'loads' }
          : { state: 'ok', hours: weeklyHours(me, owned, clock, { first: 0, weeks: 1 }).hours[0] },
      )
    }
  } catch (e) {
    if (!isOverBudget(e)) throw e
    for (const t of tracked) delays.set(t.id, 'unknown')
    for (const p of walkers) weeks.set(p.id, { state: 'unavailable', reason: 'budget' })
  }
  return { delays, weeks }
}

/* The reads the app's view queries share: the Board's (lib/board.ts), and
 * the Roadmap's, Team sync's and Overview's to come. They hold no rule of
 * one view, only what a view reads and how it stays within its budget:
 *
 * - viewBudget, the guard every read goes through, over the request's
 *   totals as Convex counts them, the caller's access rows included;
 * - viewAccess, the caller's access in one organization (lib/access.ts
 *   accessOf), asked within that guard;
 * - projectSelection, a top-level project with its visible live
 *   sub-projects, or one sub-project;
 * - selectionTasks and ownTasks, the active tasks of the selected
 *   sub-projects, or those one person owns by the Reviewer rule, read in
 *   steps;
 * - groupCheck and groupFacts, which tasks are groups and what a group
 *   shows of its subtasks;
 * - shownParents, the ancestors of a view's rows that the reader is shown;
 * - viewRow, a task as a view sends it.
 *
 * Every read follows the working-set rules (lib/workingSet.ts): a view
 * holds only active tasks in live projects the reader can see, and says of
 * any other task only that it exists (has_hidden_subtasks,
 * has_hidden_parent). The reads that can touch a task or project the reader
 * is not shown are a task's subtasks, a parent read by id, the projects of
 * those and of a person's own tasks, a top-level project's sub-projects,
 * and a person's own tasks in projects they cannot see. Their documents are
 * charged at a fixed size in every budget decision (viewBudget charge), so a
 * hidden title's or description's length moves no answer. What still
 * follows hidden data is how many such documents and ranges a read takes:
 * how many subtasks a shown group has, hidden ones included, as the tasks
 * part's kidsOf (lib/workspaceParts.ts) reads them, and the grant and team
 * share rows the reader's access reads on a hidden project. Both can move a
 * view's answer at its budget's margin only. So can, in an organization
 * whose reach rows are not complete yet (org_ready nav_at), the sub-projects
 * the access reads of a top-level project the reader sees only to navigate
 * to them (lib/access.ts projectLevelsOf, the legacy path), which every
 * deployment left behind with internal/navBackfill. */

import { getDocumentSize } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { accessOf, inMetaTree, OWN_READS } from './access'
import type { ReadCeiling } from './archivedTasks'
import { byId } from './db'
import { ISSUE_STATUSES, type IssueStatus } from './enums'
import { MIB, PROJECT_ROW_MAX_BYTES, TASK_ROW_MAX_BYTES, TEAM_ROW_MAX_BYTES } from './limits'
import { taskOwnerId } from './review'
import { parentLink, type Shown } from './workingSet'
import { type TaskRow, taskFields } from './workspaceParts'

// --- the budget -----------------------------------------------------------

/** Reads as Convex counts a request's: bytes, documents and index ranges. */
export type Reads = { bytes: number; documents: number; ranges: number }

/** What a read keeps back for each document it may take before it looks at
 * the request's reads again: a task row with the copy of its text that a
 * rollback to v0.1.98 writes again, at the description cap in a three-byte
 * script (about 62 KB). Other documents a view reads by the row are
 * smaller; only a row stored over the caps is larger. */
export const ROW_BYTES = 64 * 1024

/** One task row, as a read keeps room for it. */
export const ROW: Reads = { bytes: ROW_BYTES, documents: 1, ranges: 0 }

/** One index range. */
export const RANGE: Reads = { bytes: 0, documents: 0, ranges: 1 }

/** One document read by id or as the first of a range: a range and a row. */
export const BY_ID: Reads = { bytes: ROW_BYTES, documents: 1, ranges: 1 }

/** No reads. */
const NONE: Reads = { bytes: 0, documents: 0, ranges: 0 }

/* `n` index ranges. */
const rangesOf = (n: number): Reads => ({ bytes: 0, documents: 0, ranges: n })

/** The real bytes a view's reads stop at, whatever the fixed charges say:
 * Convex's 16 MiB less 2 MiB for what one step can read past its last look,
 * an access question past PROJECT_ASK or a row stored over the caps. Only a
 * row past the caps and a hidden task's copy of its text (which only a
 * rollback writes) can make the real bytes pass a view's budget first, so
 * only those reach this stop. */
const REAL_BYTES = 14 * MIB

/** What a guard throws once a read would pass its budget. A view answers it
 * with a state of its own (lib/board.ts over_budget), never with the rows
 * it read so far. */
export class OverBudget extends Error {
  constructor() {
    super('a view read its whole budget')
  }
}

/** Whether `e` is a guard's OverBudget. */
export const isOverBudget = (e: unknown): e is OverBudget => e instanceof OverBudget

/** What viewBudget answers. */
export type ViewBudget = ReturnType<typeof viewBudget>

/**
 * The guard of a view's reads, which keep under `reads` as Convex counts a
 * request's totals (ctx.meta.getTransactionMetrics), the reader's access
 * rows included, because Convex's limits count those too. A read takes
 * room before it starts, each row it may read at ROW_BYTES, and the guard
 * looks at the request's totals again only once that room is spent, as
 * lib/archivedTasks.ts ceilingGuard does, because each look costs about as
 * much as an index range. A read that does not fit throws OverBudget.
 *
 * A document that may be one the reader is not shown counts at a fixed size
 * in place of its own (charge): the decisions see the request's bytes with
 * each such document's real size replaced, so its text moves no answer.
 * The real bytes still stop at REAL_BYTES.
 */
export function viewBudget(ctx: QueryCtx, reads: Reads) {
  // the fixed charges less the real sizes of the documents they stand for
  let extra = 0
  // what reads may still take before the next look, and whether nothing
  // was taken since it, so another look would show no more
  let room: Reads = { bytes: 0, documents: 0, ranges: 0 }
  let looked = false
  const look = async () => {
    const m = await ctx.meta.getTransactionMetrics()
    looked = true
    room = {
      bytes: Math.min(reads.bytes - (m.bytesRead.used + extra), REAL_BYTES - m.bytesRead.used),
      documents: reads.documents - m.documentsRead.used,
      ranges: reads.ranges - m.databaseQueries.used,
    }
  }
  /* how many reads of `cost` the room holds beside `base`, -1 when it
   * does not hold `base` */
  const roomFor = (cost: Reads, base: Reads = NONE): number => {
    const left = {
      bytes: room.bytes - base.bytes,
      documents: room.documents - base.documents,
      ranges: room.ranges - base.ranges,
    }
    if (left.bytes < 0 || left.documents < 0 || left.ranges < 0) return -1
    return Math.min(
      cost.bytes > 0 ? Math.floor(left.bytes / cost.bytes) : Number.POSITIVE_INFINITY,
      cost.documents > 0 ? Math.floor(left.documents / cost.documents) : Number.POSITIVE_INFINITY,
      cost.ranges > 0 ? Math.floor(left.ranges / cost.ranges) : Number.POSITIVE_INFINITY,
    )
  }
  const spend = (cost: Reads, n: number) => {
    if (n > 0) looked = false
    room = {
      bytes: room.bytes - n * cost.bytes,
      documents: room.documents - n * cost.documents,
      ranges: room.ranges - n * cost.ranges,
    }
  }
  /** How many reads of `cost` the room holds beside `base`, up to `most`,
   * looking first when it holds fewer; -1 when it does not hold `base`. It
   * takes nothing. */
  const count = async (cost: Reads, most: number, base: Reads = NONE): Promise<number> => {
    if (roomFor(cost, base) < most && !looked) await look()
    return Math.min(most, roomFor(cost, base))
  }
  /** Takes room for `base` and as many reads of `cost` as fit beside it, up
   * to `most`, in one step, so no look between them can drop either, and
   * answers how many reads of `cost` it took: a step near the budget's end
   * reads fewer rows rather than none. Throws OverBudget when fewer than
   * `least` fit. */
  const upTo = async (
    cost: Reads,
    most: number,
    least = 1,
    base: Reads = NONE,
  ): Promise<number> => {
    const n = await count(cost, most, base)
    if (n < least || n < 0) throw new OverBudget()
    spend(base, 1)
    spend(cost, n)
    return n
  }
  const bytes = () => Math.min(reads.bytes - extra, REAL_BYTES)
  return {
    count,
    upTo,
    /** Takes room for `n` reads of `cost`, or throws OverBudget. */
    take: async (cost: Reads, n = 1): Promise<void> => {
      await upTo(cost, n, n)
    },
    /** Gives back the room of `n` reads of `cost` that a read took and did
     * not make. */
    giveBack: (cost: Reads, n: number): void => spend(cost, -n),
    /** Drops the room taken from the last look, so the next read looks
     * again first, after reads made outside the guard, as the description
     * readers make them by the request's totals (ceiling). */
    forget: (): void => {
      room = { bytes: 0, documents: 0, ranges: 0 }
      looked = false
    },
    /** Counts `doc`, which the reader may not be shown, at `size` bytes in
     * place of its own in every later decision. Call it once for each time
     * a read returned the document, as Convex counts each. */
    charge: (doc: Record<string, unknown>, size: number): void => {
      extra += size - getDocumentSize(doc as Parameters<typeof getDocumentSize>[0])
    },
    /** Undoes one charge of `doc` at `size`, for a document the reader
     * turned out to be shown, whose real size counts. */
    refund: (doc: Record<string, unknown>, size: number): void => {
      extra -= size - getDocumentSize(doc as Parameters<typeof getDocumentSize>[0])
    },
    /** The request's totals the reads keep under, with the fixed charges
     * folded in as they stand when a check reads them, for the description
     * readers that step by them (model/descriptions.ts descriptionsOf and
     * projectTextReader). */
    ceiling: {
      ranges: reads.ranges,
      documents: reads.documents,
      get bytes() {
        return bytes()
      },
    } satisfies ReadCeiling,
  }
}

/* Each of `promises` once every one has settled, or the first rejection
 * once they have, so no read is left running when a view stops. */
export async function settled<R>(promises: readonly Promise<R>[]): Promise<R[]> {
  const all = await Promise.allSettled(promises)
  const out: R[] = []
  for (const one of all) {
    if (one.status === 'rejected') throw one.reason
    out.push(one.value)
  }
  return out
}

// --- access -----------------------------------------------------------------

/** How many projects not read before one round of a view's access
 * questions takes on (viewAccess). */
const FRESH_PROJECTS = 8

/** The team shares PROJECT_ASK's bytes hold at the name caps, as
 * lib/taskWindow.ts PROJECT does: ten, about 300 bytes a row at ordinary
 * name lengths, or 65 there. */
const SHARE_BYTES = 10

/** What the reader's access reads for one question about a project it has
 * not asked about before, at its worst (lib/access.ts OWN_READS): the
 * project and its top-level project, the reader's grant on each and the
 * range of team shares on each, at most OWN_READS.projectShares and one
 * more, 6 ranges and 134 documents. Its bytes hold the two project rows and
 * SHARE_BYTES grants and shares at lib/limits.ts TEAM_ROW_MAX_BYTES, with a
 * membership and a team row each. The reader's own rows, which the access
 * reads once at a step of OWN_READS (its shared reads), and a project
 * shared with more teams at the name caps can pass it; the next look counts
 * them, within what the view's budget keeps under Convex's limits. */
export const PROJECT_ASK: Reads = {
  ranges: 6,
  documents: 2 * (2 + OWN_READS.projectShares + 1),
  bytes: 2 * (PROJECT_ROW_MAX_BYTES + (1 + 3 * SHARE_BYTES) * TEAM_ROW_MAX_BYTES),
}

/** One project row read by id, for whether it is live. */
const PROJECT_READ: Reads = { bytes: PROJECT_ROW_MAX_BYTES, documents: 1, ranges: 1 }

/** One project row as a range of them returns it. */
const PROJECT_ROW: Reads = { bytes: PROJECT_ROW_MAX_BYTES, documents: 1, ranges: 0 }

/** What viewAccess answers. */
export type ViewAccess = ReturnType<typeof viewAccess>

/**
 * The reader `me`'s access in their organization as a view asks it
 * (lib/access.ts accessOf), each project read and asked about once, within
 * `guard`. A question about a project not asked before first takes
 * PROJECT_ASK from the budget, a round of FRESH_PROJECTS such projects at a
 * time, and one about whether a project is live a project row. Each project
 * row the access reads counts at lib/limits.ts PROJECT_ROW_MAX_BYTES, as it
 * may be one the reader cannot see. A check a bound of the reader's own
 * reads stopped rejects with lib/access.ts accessUnchecked, never answering
 * no access; a view answers that with a state of its own.
 */
export function viewAccess(ctx: QueryCtx, guard: ViewBudget, me: Doc<'profiles'>) {
  const access = accessOf(ctx, me)
  // the projects whose rows the access holds, and those it was asked about
  const rows = new Set<string>()
  const asked = new Set<string>()
  // the project rows charged at their fixed size
  const charged = new Set<string>()
  const chargeOnce = async (id: string | undefined) => {
    if (id === undefined || charged.has(id)) return
    charged.add(id)
    const p = await access.project(id)
    if (p !== null) guard.charge(p, PROJECT_ROW_MAX_BYTES)
  }
  /* `check` of each of `ids`, a round at a time, each round taking `cost`
   * for each of at most FRESH_PROJECTS ids not in `known` first */
  const inRounds = async <R>(
    ids: readonly string[],
    known: Set<string>,
    cost: Reads,
    check: (id: string) => Promise<R>,
  ): Promise<R[]> => {
    const out: R[] = []
    for (let at = 0; at < ids.length; ) {
      // the ids up to the first fresh one past those the room holds
      const most = new Set<string>()
      for (let i = at; i < ids.length && most.size < FRESH_PROJECTS; i++)
        if (!known.has(ids[i])) most.add(ids[i])
      const n = await guard.upTo(cost, most.size, most.size === 0 ? 0 : 1)
      const fresh = new Set<string>()
      let end = at
      for (; end < ids.length; end++) {
        const id = ids[end]
        if (known.has(id) || fresh.has(id)) continue
        if (fresh.size === n) break
        fresh.add(id)
      }
      for (const id of fresh) known.add(id)
      out.push(...(await settled(ids.slice(at, end).map(check))))
      at = end
    }
    return out
  }
  const live = (ids: readonly string[]): Promise<boolean[]> =>
    inRounds(ids, rows, PROJECT_READ, async (id) => {
      const answer = await access.live(id)
      await chargeOnce(id)
      return answer
    })
  const visible = (ids: readonly string[]): Promise<boolean[]> =>
    inRounds(ids, asked, PROJECT_ASK, async (id) => {
      const answer = await access.visible(id)
      rows.add(id)
      await chargeOnce(id)
      await chargeOnce((await access.project(id))?.parent_id)
      return answer
    })
  return {
    me,
    /** Keeps project `p`, which the view read, so the access does not read
     * it again, and charges it at its fixed size. */
    seen(p: Doc<'projects'>): void {
      access.seen(p)
      rows.add(p.id)
      if (charged.has(p.id)) return
      charged.add(p.id)
      guard.charge(p, PROJECT_ROW_MAX_BYTES)
    },
    /** The project with this id as the access read it, or null. */
    project: (id: string): Promise<Doc<'projects'> | null> => access.project(id),
    /** Whether each project is one of the organization's and live
     * (lib/access.ts Access.live). */
    live,
    /** Whether the reader can see each project (Access.visible). */
    visible,
    /** Whether each task is in the reader's working set (Access.holds). */
    async holds(tasks: readonly Doc<'issues'>[]): Promise<boolean[]> {
      const isLive = await live(tasks.map((t) => t.project_id))
      const liveIds = [...new Set(tasks.filter((_, i) => isLive[i]).map((t) => t.project_id))]
      const seen = await visible(liveIds)
      const shown = new Map(liveIds.map((id, i) => [id, seen[i]]))
      return tasks.map(
        (t, i) => isLive[i] && t.archived_at === undefined && shown.get(t.project_id) === true,
      )
    },
  }
}

/** The seats a view reads with, the reader's access in each organization,
 * by organization id. */
export type ViewSeats = ReadonlyMap<string, ViewAccess>

/* The seat of the organization `task` belongs to. */
function seatOf(seats: ViewSeats, task: Pick<Doc<'issues'>, 'org_id'>): ViewAccess {
  const seat = seats.get(task.org_id)
  if (seat === undefined) throw new Error('a view read a task of an organization it has no seat in')
  return seat
}

// --- ranges in steps ----------------------------------------------------------

/* A query over one index range that takes rows. */
type Taker<D> = { take(n: number): Promise<D[]> }

/** One index range read in steps (inSteps). */
export type StepRange<D> = {
  /** the range from its start, or from creation time `from` on, that time
   * included */
  open(from?: number): Taker<D>
  /** where the range starts, when it starts after a row read before: from
   * that row's creation time, with the rows at it read already */
  start?: { from: number; seen: readonly D[] }
  /** For a range whose index orders rows by fields before their creation
   * time, as a span of statuses of by_project_archived_status_done does:
   * the ranges that hold its rows after `last`, the last row of a step that
   * read as many as it asked for, of the step's `rows`. Without it a range
   * goes on from `last`'s creation time, with the rows at that time read
   * already skipped. */
  after?(last: D, rows: readonly D[]): StepRange<D>[]
}

/** How many ranges one step of inSteps reads at most, the most new rows
 * it asks each for, and the fewest a range gets before the step reads
 * fewer ranges instead. A step takes the room of every row it may read, so
 * near the budget's end it reads fewer ranges with enough rows each that a
 * range of a sub-project's few tasks still ends in one step: index ranges
 * are what a large Board runs short of first, and a look at the request's
 * reads costs no range. */
const STEP = { ranges: 16, rows: 64, share: 24 }

/* The rows of `rows` at `last`'s creation time, the ones a range that goes
 * on from that time reads again. */
const tiedTo = <D extends { _creationTime: number }>(last: D, rows: readonly D[]) =>
  rows.filter((row) => row._creationTime === last._creationTime)

/**
 * The rows of `ranges`, a step at a time, each step's new rows yielded
 * together. A step reads up to STEP.ranges ranges at once, each from where
 * its last step ended: by default from the last row's creation time with
 * the rows at that time skipped, as Convex does not make creation times
 * unique, so no row is missed or yielded twice, as lib/workspaceParts.ts
 * kidsOf steps; a range ordered by more fields says where it goes on
 * (StepRange after). It takes room for every row it may read at `cost`, the
 * rows read again included, and gives back what the ranges did not hold.
 * `read` hears every row each read returned, those read again included, for
 * a caller that charges them.
 */
export async function* inSteps<D extends { _id: unknown; _creationTime: number }>(
  guard: ViewBudget,
  ranges: readonly StepRange<D>[],
  cost: Reads = ROW,
  read: (row: D) => void = () => {},
  perRange: number = STEP.rows,
): AsyncGenerator<D[]> {
  type Open = { range: StepRange<D>; from?: number; seen: Set<unknown> }
  const opened = (range: StepRange<D>): Open => ({
    range,
    from: range.start?.from,
    seen: new Set(range.start?.seen.map((row) => row._id)),
  })
  let open: Open[] = ranges.map(opened)
  const againIn = (k: number) => open.slice(0, k).reduce((n, s) => n + s.seen.size, 0)
  while (open.length > 0) {
    // the rows the room holds beside the step's ranges, then as many ranges
    // as get STEP.share of them each, and at least one row each, with the
    // rows each reads again
    let k = await guard.count(RANGE, Math.min(STEP.ranges, open.length))
    if (k <= 0) throw new OverBudget()
    let rows = await guard.count(cost, k * perRange + againIn(k), rangesOf(k))
    k = Math.min(k, Math.max(1, Math.floor(Math.max(0, rows) / STEP.share)))
    rows = await guard.count(cost, k * perRange + againIn(k), rangesOf(k))
    while (k > 0 && rows < k + againIn(k)) {
      k--
      rows = await guard.count(cost, k * perRange + againIn(k), rangesOf(k))
    }
    if (k === 0) throw new OverBudget()
    const again = againIn(k)
    const step = open.slice(0, k)
    open = open.slice(k)
    // the ranges and the rows in one reservation
    const n = await guard.upTo(cost, k * perRange + again, k + again, rangesOf(k))
    const each = Math.floor((n - again) / k)
    const got = await settled(step.map((s) => s.range.open(s.from).take(each + s.seen.size)))
    guard.giveBack(cost, n - got.reduce((total, rows) => total + rows.length, 0))
    const fresh: D[] = []
    for (const [i, rows] of got.entries()) {
      const s = step[i]
      for (const row of rows) read(row)
      fresh.push(...rows.filter((row) => !s.seen.has(row._id)))
      const last = rows.at(-1)
      // a range that held fewer rows than the step asked for has ended
      if (rows.length < each + s.seen.size || last === undefined) continue
      if (s.range.after !== undefined) {
        open.push(...s.range.after(last, rows).map(opened))
        continue
      }
      const at = new Set(tiedTo(last, rows).map((row) => row._id))
      if (last._creationTime === s.from) for (const id of s.seen) at.add(id)
      open.push({ range: s.range, from: last._creationTime, seen: at })
    }
    yield fresh
  }
}

// --- the selection --------------------------------------------------------------

/** A project view's selection in one organization. */
export type Selection = {
  /** the project the view names */
  project: Doc<'projects'>
  /** the sub-projects whose tasks it holds, live and visible to the reader,
   * in creation order */
  subProjects: Doc<'projects'>[]
}

/**
 * The selection the project with id `projectId` names for `seat`'s reader,
 * or null when it names none, alike for every reason: no such project, one
 * of another organization, an archived one, one the reader cannot see, or
 * a top-level project that is not a meta. A sub-project selects itself. A
 * top-level meta selects its sub-projects that are of its organization,
 * live and visible (projects by_parent), as the app's scopeInfo
 * (src/store/planner.ts) builds a meta's groups; one the reader sees only to
 * navigate to its sub-projects selects the sub-projects they see. Live
 * follows archived_at, as P.projects and Access.live do. It reads the
 * project by id and, for a meta, its sub-projects in steps, each charged at
 * PROJECT_ROW_MAX_BYTES, as the reader may not see them, and the reader's
 * access to each.
 */
export async function projectSelection(
  ctx: QueryCtx,
  guard: ViewBudget,
  seat: ViewAccess,
  projectId: string,
): Promise<Selection | null> {
  await guard.take(BY_ID)
  const project = await byId(ctx, 'projects', projectId)
  if (project === null || project.org_id !== seat.me.org_id || project.archived_at !== undefined)
    return null
  seat.seen(project)
  if (project.parent_id !== undefined)
    return (await seat.visible([project.id]))[0] ? { project, subProjects: [project] } : null
  if (!inMetaTree(project, project) || !(await seat.visible([project.id]))[0]) return null
  const children: Doc<'projects'>[] = []
  const range: StepRange<Doc<'projects'>> = {
    open: (from) =>
      ctx.db
        .query('projects')
        .withIndex('by_parent', (q) =>
          from === undefined
            ? q.eq('parent_id', project.id)
            : q.eq('parent_id', project.id).gte('_creationTime', from),
        ),
  }
  for await (const step of inSteps(guard, [range], PROJECT_ROW)) {
    for (const child of step) {
      seat.seen(child)
      children.push(child)
    }
  }
  const live = children.filter((c) => c.org_id === project.org_id && c.archived_at === undefined)
  const shown = await seat.visible(live.map((c) => c.id))
  return { project, subProjects: live.filter((_, i) => shown[i]) }
}

// --- task rows ------------------------------------------------------------------

/* The active tasks of project `id` from creation time `from` on, or all. */
const projectRange = (ctx: QueryCtx, id: string): StepRange<Doc<'issues'>> => ({
  open: (from) =>
    ctx.db.query('issues').withIndex('by_project_archived', (q) => {
      const active = q.eq('project_id', id).eq('archived_at', undefined)
      return from === undefined ? active : active.gte('_creationTime', from)
    }),
})

/* The active tasks of project `id` whose status is after `above` (or from
 * `lowest` on) up to `highest`, by by_project_archived_status_done, which
 * orders them by status, then done_at, then creation time. A step that ends
 * on a row goes on with the rest of that row's status and done_at from its
 * creation time, then that status's later done_at, then the later
 * statuses. Only a Done task carries done_at (model/issues.ts
 * doneStampInsert and doneStampUpdate), so a span without Done usually
 * ends in one range; a row that broke the rule is read in its place, never
 * dropped. */
function statusSpan(
  ctx: QueryCtx,
  id: string,
  span: { lowest?: IssueStatus; above?: IssueStatus; highest: IssueStatus },
): StepRange<Doc<'issues'>> {
  const index = () =>
    ctx.db.query('issues').withIndex('by_project_archived_status_done', (q) => {
      const active = q.eq('project_id', id).eq('archived_at', undefined)
      const from =
        span.above !== undefined
          ? active.gt('status', span.above)
          : active.gte('status', span.lowest ?? span.highest)
      return from.lte('status', span.highest)
    })
  return {
    open: () => index(),
    after: (last, rows) => afterInStatus(ctx, id, last, rows, span.highest),
  }
}

/* The ranges after `last` of a status span up to `highest`: the rest of
 * `last`'s status and done_at, that status's later done_at, the later
 * statuses. */
function afterInStatus(
  ctx: QueryCtx,
  id: string,
  last: Doc<'issues'>,
  rows: readonly Doc<'issues'>[],
  highest: IssueStatus,
): StepRange<Doc<'issues'>>[] {
  const { status, done_at } = last
  const same: StepRange<Doc<'issues'>> = {
    open: (from) =>
      ctx.db.query('issues').withIndex('by_project_archived_status_done', (q) => {
        const key = q
          .eq('project_id', id)
          .eq('archived_at', undefined)
          .eq('status', status)
          .eq('done_at', done_at)
        return from === undefined ? key : key.gte('_creationTime', from)
      }),
    start: {
      from: last._creationTime,
      seen: tiedTo(
        last,
        rows.filter((row) => row.status === status && row.done_at === done_at),
      ),
    },
  }
  const later: StepRange<Doc<'issues'>> = {
    open: () =>
      ctx.db.query('issues').withIndex('by_project_archived_status_done', (q) => {
        const inIt = q.eq('project_id', id).eq('archived_at', undefined).eq('status', status)
        return inIt.gt('done_at', done_at ?? '')
      }),
    after: (next, got) => afterInStatus(ctx, id, next, got, status),
  }
  return [
    same,
    later,
    ...(status < highest ? [statusSpan(ctx, id, { above: status, highest })] : []),
  ]
}

/** The statuses a Focus view shows, none of them Done. */
export const FOCUS_STATUSES = ['todo', 'progress', 'review'] as const

/* `statuses` as the runs of statuses next to each other in the index's
 * order of status names, one span each: Focus's three are one. */
function statusRuns(statuses: readonly IssueStatus[]) {
  const runs: { lowest: IssueStatus; highest: IssueStatus }[] = []
  let run: { lowest: IssueStatus; highest: IssueStatus } | null = null
  for (const status of [...ISSUE_STATUSES].sort()) {
    if (!statuses.includes(status)) run = null
    else if (run !== null) run.highest = status
    else {
      run = { lowest: status, highest: status }
      runs.push(run)
    }
  }
  return runs
}

/**
 * The active tasks of `subProjects`, live sub-projects the reader can see,
 * so every one is in the reader's working set, a step at a time: one
 * by_project_archived range each, or with `statuses`, those of the Focus
 * filter, one by_project_archived_status_done span of them each
 * (statusSpan). Each step reads what the room left holds at ROW_BYTES a row
 * (inSteps). Their real bytes count, a rollback's copy of a text included,
 * as the reader is shown them.
 */
export function selectionTasks(
  ctx: QueryCtx,
  guard: ViewBudget,
  subProjects: readonly Doc<'projects'>[],
  statuses?: readonly IssueStatus[],
): AsyncGenerator<Doc<'issues'>[]> {
  const ranges = subProjects.flatMap((p) =>
    statuses === undefined
      ? [projectRange(ctx, p.id)]
      : statusRuns(statuses).map((run) => statusSpan(ctx, p.id, run)),
  )
  return inSteps(guard, ranges)
}

/** Whether `task` belongs to the profile with id `profileId` by the
 * Reviewer rule (lib/review.ts taskOwnerId): its reviewer while a task
 * without subtasks waits In Review, else its assignee, so a group always
 * stays with its assignee. */
export const ownedBy = (task: Doc<'issues'>, isGroup: boolean, profileId: string): boolean =>
  taskOwnerId(task, isGroup) === profileId

/** Whether `task`'s owner is the same whether or not it is a group, so the
 * Reviewer rule needs no group check for it. */
export const ownerSettled = (task: Doc<'issues'>): boolean =>
  task.status !== 'review' ||
  task.reviewer_id === undefined ||
  task.reviewer_id === task.assignee_id

/**
 * The tasks `seat`'s reader may own by the Reviewer rule in `statuses`, in
 * the reader's working set and in a sub-project, a step at a time: one
 * by_assignee_archived_status range for each status, and with `review` and
 * `reviewed` one by_reviewer_archived_status range of the tasks they review,
 * each task once. Never the projects' tasks, so the reads follow the
 * person's own work. A task In Review whose reviewer is another person
 * belongs to the reader only as a group, and one they review whose assignee
 * is another only as a task without subtasks; ownedBy settles both once
 * the group check is known (ownerSettled tells which need it).
 *
 * The reader's own tasks in projects they cannot see are read too, and
 * charged at lib/limits.ts TASK_ROW_MAX_BYTES, those they are shown at their
 * real size. A task a legacy writer stored on a top-level project is in no
 * selection, as in the app's scopes (src/store/planner.ts scopedIssues).
 * lib/liveTasks.ts ownedOpenTasks reads the same two indexes but collects
 * them whole, leaves Done out and reads the rule as for a task without
 * subtasks, so this does not build on it.
 */
export async function* ownTasks(
  ctx: QueryCtx,
  guard: ViewBudget,
  seat: ViewAccess,
  statuses: readonly IssueStatus[],
  reviewed = true,
): AsyncGenerator<Doc<'issues'>[]> {
  const me = seat.me.id
  const ranges: StepRange<Doc<'issues'>>[] = statuses.map((status) => ({
    open: (from) =>
      ctx.db.query('issues').withIndex('by_assignee_archived_status', (q) => {
        const own = q.eq('assignee_id', me).eq('archived_at', undefined).eq('status', status)
        return from === undefined ? own : own.gte('_creationTime', from)
      }),
  }))
  if (reviewed && statuses.includes('review'))
    ranges.push({
      open: (from) =>
        ctx.db.query('issues').withIndex('by_reviewer_archived_status', (q) => {
          const own = q.eq('reviewer_id', me).eq('archived_at', undefined).eq('status', 'review')
          return from === undefined ? own : own.gte('_creationTime', from)
        }),
    })
  // each task once, and how often each read returned it
  const yielded = new Set<string>()
  const times = new Map<string, number>()
  const charge = (task: Doc<'issues'>) => {
    guard.charge(task, TASK_ROW_MAX_BYTES)
    times.set(task.id, (times.get(task.id) ?? 0) + 1)
  }
  for await (const step of inSteps(guard, ranges, ROW, charge)) {
    const fresh = [
      ...new Map(step.filter((t) => !yielded.has(t.id)).map((t) => [t.id, t])).values(),
    ]
    for (const task of fresh) yielded.add(task.id)
    const held = await seat.holds(fresh)
    const out: Doc<'issues'>[] = []
    for (const [i, task] of fresh.entries()) {
      if (!held[i]) continue
      // a task the reader is shown counts at its real size
      for (let n = times.get(task.id) ?? 0; n > 0; n--) guard.refund(task, TASK_ROW_MAX_BYTES)
      times.delete(task.id)
      if ((await seat.project(task.project_id))?.parent_id !== undefined) out.push(task)
    }
    yield out
  }
}

// --- groups -----------------------------------------------------------------------

/** How many tasks one step of a group check asks about at once. */
const CHECKS = 64

/* The active subtasks of the task with id `id`, oldest first, from
 * creation time `from` on, or all. */
const activeKids = (ctx: QueryCtx, id: string, from?: number) =>
  ctx.db.query('issues').withIndex('by_parent_archived', (q) => {
    const active = q.eq('parent_id', id).eq('archived_at', undefined)
    return from === undefined ? active : active.gte('_creationTime', from)
  })

/** What a view knows of its tasks' subtasks: by task id, the active
 * subtasks in live projects, which make it a group (lib/liveTasks.ts
 * countsAsSubtask), once read (groupCheck); by task id whether the reader
 * is shown it (groupFacts, and the view for the tasks it read in the
 * reader's working set, whose reads as subtasks then count at their real
 * size); and the tasks known to be groups before
 * that read, the parents of tasks the view read in its working set
 * (`parents`), which an active subtask in a live project makes groups. */
export type Subtasks = {
  kids: Map<string, Doc<'issues'>[]>
  shown: Map<string, boolean>
  parents: Set<string>
}

/** An empty Subtasks. */
export const noSubtasks = (): Subtasks => ({
  kids: new Map(),
  shown: new Map(),
  parents: new Set(),
})

/** The release from which every backend that can run keeps one level of
 * subtasks: v0.1.98, the backend's rollback floor, released everywhere on
 * this instant. The rule itself shipped in v0.1.17: the parent fence
 * (model/issues.ts parentChainCheck) refuses a parent that has a parent of
 * its own and a parent for a task that has subtasks, on the app, REST and
 * MCP, and a Deleted items restore drops such a parent (model/deletedItems.ts
 * keptParent). Data stored before it keeps its shape, so a subtask with
 * subtasks of its own, a nested group, needs both of its links stored
 * before this instant: a task created at or after it never holds a parent
 * and a subtask at once, and a task's subtasks it gained at or after it were
 * then without subtasks and stay so. Every create stamps created_at with the
 * server's clock, and no write changes it. */
export const ONE_LEVEL_SINCE = '2026-10-29T00:24:00.000Z'

/** Whether `task`, which has a parent, was created under the rule of one
 * level (ONE_LEVEL_SINCE), so it has no subtasks and needs no group check. */
export const withoutSubtasks = (task: Pick<Doc<'issues'>, 'parent_id' | 'created_at'>): boolean =>
  task.parent_id !== undefined && task.created_at >= ONE_LEVEL_SINCE

/** Whether the task with this id is a group, once groupCheck read it. */
export const isGroupIn = (known: Subtasks, id: string): boolean | undefined => {
  const kids = known.kids.get(id)
  return kids === undefined ? undefined : kids.length > 0
}

/**
 * Reads into `known` whether each of `tasks`, active tasks in live projects,
 * is a group: its active subtasks (issues by_parent_archived) in live
 * projects (lib/liveTasks.ts countsAsSubtask), each task read once. As
 * lib/workspaceParts.ts kidsOf reads, it takes each task's first subtask, a
 * step of CHECKS tasks at a time, one range and no document for a task
 * without one, and then the rest of those that have one in steps
 * (inSteps), so it sees every row it reads. A task known to be a group
 * (Subtasks parents) skips the first look and reads its subtasks in steps
 * from the start, a range less, and a subtask created under the rule of one
 * level (withoutSubtasks) reads nothing. Each subtask counts at lib/limits.ts
 * TASK_ROW_MAX_BYTES, as the reader may not be shown it, unless `known`
 * says they are, and so does each subtask's project (viewAccess). A group's subtasks are read whole, so its
 * group facts need no other range.
 */
export async function groupCheck(
  ctx: QueryCtx,
  guard: ViewBudget,
  seats: ViewSeats,
  tasks: readonly Doc<'issues'>[],
  known: Subtasks,
): Promise<void> {
  for (const t of tasks)
    if (!known.kids.has(t.id) && withoutSubtasks(t) && !known.parents.has(t.id))
      known.kids.set(t.id, [])
  const todo = [
    ...new Map(tasks.filter((t) => !known.kids.has(t.id)).map((t) => [t.id, t])).values(),
  ]
  // a subtask the view knows the reader is shown counts at its real size
  const charge = (kid: Doc<'issues'>) => {
    if (known.shown.get(kid.id) !== true) guard.charge(kid, TASK_ROW_MAX_BYTES)
  }
  for (let at = 0; at < todo.length; ) {
    // a step ends before the first task whose first look the room does not hold
    const window = todo.slice(at, at + CHECKS)
    const lookers = window.filter((t) => !known.parents.has(t.id))
    const n = await guard.upTo(BY_ID, lookers.length, lookers.length === 0 ? 0 : 1)
    const step = window.slice(0, n === lookers.length ? window.length : window.indexOf(lookers[n]))
    at += step.length
    const found = new Map<string, Doc<'issues'>[]>(step.map((t) => [t.id, []]))
    const rest: StepRange<Doc<'issues'>>[] = step
      .filter((t) => known.parents.has(t.id))
      .map((t) => ({ open: (from) => activeKids(ctx, t.id, from) }))
    const looking = step.filter((t) => !known.parents.has(t.id))
    const firsts = await settled(looking.map((t) => activeKids(ctx, t.id).first()))
    for (const [i, first] of firsts.entries()) {
      if (first === null) continue
      charge(first)
      const id = looking[i].id
      found.get(id)?.push(first)
      rest.push({
        open: (from) => activeKids(ctx, id, from),
        start: { from: first._creationTime, seen: [first] },
      })
    }
    for await (const kids of inSteps(guard, rest, ROW, charge))
      for (const kid of kids) if (kid.parent_id !== undefined) found.get(kid.parent_id)?.push(kid)
    // whether each subtask's project is live, asked once a seat
    const live = new Map<string, boolean>()
    for (const [org, theirs] of groupBy(step, (t) => t.org_id)) {
      const kids = theirs.flatMap((t) => found.get(t.id) ?? [])
      const seat = seatOf(seats, { org_id: org })
      const answers = await seat.live(kids.map((kid) => kid.project_id))
      for (const [i, kid] of kids.entries()) live.set(kid.id, answers[i])
    }
    for (const t of step)
      known.kids.set(
        t.id,
        (found.get(t.id) ?? []).filter((kid) => live.get(kid.id) === true),
      )
  }
}

/** What a view shows of a group's subtasks. */
export type GroupFacts = {
  /** an active subtask in a live project the reader cannot see */
  has_hidden_subtasks: boolean
  /** every leaf under the group the reader is shown is Done, none is
   * hidden and it has at least one (src/lib/issueGroups.ts isIssueDone) */
  done: boolean
  /** the newest updated_at, in ms, of the group and the descendants the
   * reader is shown, which the Stale filter reads (src/store/planner.ts
   * isStale) */
  newest: number
  /** the group's calculated dates (src/lib/issueGroups.ts groupSpan): the
   * earliest start and latest end week of the scheduled leaves under it the
   * reader is shown, absent when none is scheduled, and whether the walk
   * could not see the whole subtree, the `unknown` of groupProgress */
  span: { start_week?: string; end_week?: string; partial: boolean }
}

/**
 * The facts of each of `groups`, groups the reader is shown, by group id,
 * walking their subtasks as src/lib/issueGroups.ts walkLeaves does: through
 * the subtasks the reader is shown, into nested groups stored before the
 * rule of one level, cycle-safe. It reads each group's and each shown
 * descendant's subtasks once (groupCheck) and whether the reader can see
 * each subtask's project (viewAccess), all into `known`.
 */
export async function groupFacts(
  ctx: QueryCtx,
  guard: ViewBudget,
  seats: ViewSeats,
  groups: readonly Doc<'issues'>[],
  known: Subtasks,
): Promise<Map<string, GroupFacts>> {
  // read the subtrees a level at a time, each task once; a task read
  // before reads nothing again
  const visited = new Set<string>()
  let level: readonly Doc<'issues'>[] = [...new Map(groups.map((g) => [g.id, g])).values()]
  while (level.length > 0) {
    for (const t of level) visited.add(t.id)
    await groupCheck(ctx, guard, seats, level, known)
    // a subtask a group gained under the rule of one level has none of its
    // own (ONE_LEVEL_SINCE), so only those of older groups get a check
    for (const t of level)
      if (t.created_at >= ONE_LEVEL_SINCE)
        for (const kid of known.kids.get(t.id) ?? [])
          if (!known.kids.has(kid.id) && !known.parents.has(kid.id)) known.kids.set(kid.id, [])
    const kids = level.flatMap((t) => known.kids.get(t.id) ?? [])
    const asking = kids.filter((k) => !known.shown.has(k.id))
    for (const [org, theirs] of groupBy(asking, (k) => k.org_id)) {
      // an active subtask in a live project is shown when its project is
      const shown = await seatOf(seats, { org_id: org }).visible(theirs.map((k) => k.project_id))
      for (const [i, kid] of theirs.entries()) known.shown.set(kid.id, shown[i])
    }
    level = [
      ...new Map(
        kids.filter((k) => known.shown.get(k.id) && !visited.has(k.id)).map((k) => [k.id, k]),
      ).values(),
    ]
  }
  const shownKids = (id: string) => (known.kids.get(id) ?? []).filter((k) => known.shown.get(k.id))
  const hiddenIn = (id: string) => (known.kids.get(id) ?? []).some((k) => !known.shown.get(k.id))
  const out = new Map<string, GroupFacts>()
  for (const group of groups) {
    const seen = new Set([group.id])
    const stack = shownKids(group.id)
    let unknown = hiddenIn(group.id) || stack.length === 0
    let total = 0
    let done = 0
    let newest = Date.parse(group.updated_at)
    let start: string | undefined
    let end: string | undefined
    for (let task = stack.pop(); task !== undefined; task = stack.pop()) {
      if (seen.has(task.id)) {
        unknown = true
        continue
      }
      seen.add(task.id)
      newest = Math.max(newest, Date.parse(task.updated_at))
      if (isGroupIn(known, task.id)) {
        const below = shownKids(task.id)
        unknown ||= hiddenIn(task.id) || below.length === 0
        stack.push(...below)
        continue
      }
      total++
      if (task.status === 'done') done++
      if (task.start_week === undefined) continue
      const last =
        task.end_week !== undefined && task.end_week > task.start_week
          ? task.end_week
          : task.start_week
      if (start === undefined || task.start_week < start) start = task.start_week
      if (end === undefined || last > end) end = last
    }
    out.set(group.id, {
      has_hidden_subtasks: hiddenIn(group.id),
      done: !unknown && total > 0 && total === done,
      newest,
      span:
        start === undefined || end === undefined
          ? { partial: unknown }
          : { start_week: start, end_week: end, partial: unknown },
    })
  }
  return out
}

// --- parents ----------------------------------------------------------------------

/**
 * The tasks the reader is shown above `rows`, a view's rows, that are not
 * rows themselves, each once, cycle-safe, as src/lib/boardGroups.ts
 * groupBoardCell walks a card's parents. A parent is shown when it is a row
 * or one of `read`, tasks the view read that are in the reader's working
 * set; else it is read by id, charged at lib/limits.ts TASK_ROW_MAX_BYTES,
 * and shown when it is of the row's organization and in the reader's
 * working set (viewAccess holds). The walk goes on above each shown parent.
 * More than `most` of them throws OverBudget. A check of the reader's
 * access that a bound stopped rejects with lib/access.ts accessUnchecked,
 * as for the task window's parent.
 */
export async function shownParents(
  ctx: QueryCtx,
  guard: ViewBudget,
  seats: ViewSeats,
  rows: readonly Doc<'issues'>[],
  read: ReadonlyMap<string, Doc<'issues'>>,
  most: number,
): Promise<Doc<'issues'>[]> {
  const inRows = new Set(rows.map((t) => t.id))
  // every task decided, shown or not
  const decided = new Map<string, Doc<'issues'> | null>(rows.map((t) => [t.id, t]))
  const out: Doc<'issues'>[] = []
  let level: readonly Doc<'issues'>[] = rows
  while (level.length > 0) {
    const next: Doc<'issues'>[] = []
    const wanted = new Map<string, Doc<'issues'>>()
    for (const t of level) {
      const id = t.parent_id
      if (id === undefined || decided.has(id) || wanted.has(id)) continue
      const known = read.get(id)
      if (known !== undefined) {
        decided.set(id, known)
        next.push(known)
      } else wanted.set(id, t)
    }
    const ids = [...wanted.keys()]
    for (let at = 0; at < ids.length; ) {
      const step = ids.slice(at, at + (await guard.upTo(BY_ID, Math.min(CHECKS, ids.length - at))))
      at += step.length
      const found = await settled(step.map((id) => byId(ctx, 'issues', id)))
      const ours: Doc<'issues'>[] = []
      for (const [i, parent] of found.entries()) {
        const child = wanted.get(step[i])
        decided.set(step[i], null)
        if (parent === null) continue
        guard.charge(parent, TASK_ROW_MAX_BYTES)
        if (child !== undefined && parent.org_id === child.org_id) ours.push(parent)
      }
      for (const [org, theirs] of groupBy(ours, (t) => t.org_id)) {
        const seat = seats.get(org)
        if (seat === undefined) continue
        const held = await seat.holds(theirs)
        for (const [i, parent] of theirs.entries())
          if (held[i]) {
            decided.set(parent.id, parent)
            next.push(parent)
          }
      }
    }
    for (const parent of next) if (!inRows.has(parent.id)) out.push(parent)
    if (out.length > most) throw new OverBudget()
    level = next
  }
  return out
}

/* `rows` by `key`, in order. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const row of rows) out.set(key(row), [...(out.get(key(row)) ?? []), row])
  return out
}

// --- rows -------------------------------------------------------------------------

/** A task as a view sends it: the row the tasks part sends (TaskRow)
 * without its text and relation rows (labels, attachments, links,
 * follows), its parent's id only when the reader is shown the parent
 * (lib/workingSet.ts parentLink), and on a group its facts (GroupFacts). */
export type ViewRow = ReturnType<typeof taskFields> &
  Pick<TaskRow, 'parent_id' | 'has_hidden_subtasks' | 'has_hidden_parent'> & {
    has_subtasks: boolean
    /** on groups only: GroupFacts done */
    group_done?: boolean
    /** on groups only: GroupFacts span */
    span?: GroupFacts['span']
  }

/** `task` as a view sends it (ViewRow), with `facts` for a group and null
 * for a task without subtasks. `shown` tells the tasks the reader is
 * shown. */
export function viewRow(task: Doc<'issues'>, shown: Shown, facts: GroupFacts | null): ViewRow {
  const row = { ...taskFields(task), ...parentLink(task, shown) }
  return facts === null
    ? { ...row, has_subtasks: false, has_hidden_subtasks: false }
    : {
        ...row,
        has_subtasks: true,
        has_hidden_subtasks: facts.has_hidden_subtasks,
        group_done: facts.done,
        span: facts.span,
      }
}

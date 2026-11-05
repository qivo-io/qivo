/* The client's clock and the owner-load verdicts the views share. The
 * Overview's figures (lib/overview.ts) and Team sync's agenda
 * (lib/teamSyncAgenda.ts) read their delays and owners' loads through
 * verdicts here, and the Roadmap (lib/roadmap.ts) its days and figures.
 * They moved here from lib/overview.ts. Since then clockOf also refuses a
 * clock whose last week does not begin at a local midnight of its `week`,
 * which no app sends, and verdicts answers the profiles and tasks the
 * agenda reads beside them; the Overview answers every clock it accepted
 * that is well formed as before.
 *
 * - Figure and Missing, a figure or why it is not given, and bounded, a
 *   figure whose reads did not fit its guard;
 * - dayNumber and dayArg, a YYYY-MM-DD day as a number; vClock, clockOf and
 *   Clock, the client's day and local weeks as a query takes them;
 * - verdicts, each task's delay with its owner's load read once through
 *   lib/ownerLoads.ts ownerLoadReader within the query's own budget
 *   (loadRoom), at most one owner's load a query for a guest or an
 *   organization Viewer, owners read in owner id order (readAll). */

import type { TransactionMetrics } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { type Access, accessOf, isOrgStaff, OWN_READS } from './access'
import { LEVEL_STEP_READS, type ReadCeiling } from './archivedTasks'
import { byId } from './db'
import { type DelayInfo, type DelayIssue, delayOf } from './delay'
import { badRequest } from './functions'
import {
  loadRowsOf,
  OWNER_LOADS,
  type OwnedTask,
  ownerLoadReader,
  type ReadRoom,
} from './ownerLoads'
import { taskOwnerId } from './review'
import {
  BY_ID,
  byIdSteps,
  type GroupFacts,
  isOverBudget,
  settled,
  type ViewBudget,
  type ViewSeats,
} from './viewReads'
import { canonicalLoad, DEFAULT_PLANNABLE_HOURS, type LoadSpan, plannableHoursOf } from './workload'

// --- figures --------------------------------------------------------------------------

/** Why a figure is not given: the counts are not whole yet (`counting`),
 * its reads did not fit its view's read budget (`budget`, lib/overview.ts
 * OVERVIEW.reads or lib/teamSyncAgenda.ts AGENDA.reads), or an owner's load it
 * needs did not fit the owner reader's bounds or the one-owner rule of a
 * guest or Viewer (`loads`). */
export type Missing = 'counting' | 'budget' | 'loads'

/** A figure, or why it is not given. Never a partial value. */
export type Figure<T extends object> =
  | ({ state: 'ok' } & T)
  | { state: 'unavailable'; reason: Missing }

/** `figure`'s value, or unavailable for `budget` where its reads did not fit
 * the guard. A figure read after it then finds the guard spent too. */
export async function bounded<T extends object>(
  figure: () => Promise<Figure<T>>,
): Promise<Figure<T>> {
  try {
    return await figure()
  } catch (e) {
    if (isOverBudget(e)) return { state: 'unavailable', reason: 'budget' }
    throw e
  }
}

// --- days and weeks -------------------------------------------------------------------

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** The days since 1970-01-01 of YYYY-MM-DD `iso`, or NaN. */
export const dayNumber = (iso: string): number => Date.parse(`${iso}T00:00:00.000Z`) / DAY_MS

/** The day number of `value`, a real YYYY-MM-DD day, or a badRequest naming
 * argument `name`. The Overview's days and the Roadmap's window
 * (lib/roadmap.ts) take their days through it. */
export function dayArg(value: string, name: string): number {
  const n = dayNumber(value)
  if (
    !ISO_DAY.test(value) ||
    !Number.isInteger(n) ||
    new Date(n * DAY_MS).toISOString().slice(0, 10) !== value
  )
    throw badRequest(`${name} must be a day, YYYY-MM-DD`)
  return n
}

/** How many local weeks `week_starts` holds: this one and the 52 before. */
export const WEEK_STARTS = 53

/* How far a local week may be from 7 days long: a daylight-saving change
 * moves a week's start by an hour in most zones and by two in a few, such
 * as Antarctica/Troll's. */
const WEEK_SLACK_MS = 3 * 3_600_000

/* How far before and after a day's UTC midnight its local midnight can
 * fall: UTC offsets run from minus 12 to plus 14 hours. */
const ZONE_EAST_MS = 14 * 3_600_000
const ZONE_WEST_MS = 12 * 3_600_000

/** The day and the weeks a verdict is judged by, on the client's grid:
 * week 0 is the client's current week. */
export type Clock = {
  /** the client's day, YYYY-MM-DD */
  day: string
  /** the week holding YYYY-MM-DD `iso` */
  ofDay(iso: string): number
  /** the week holding ISO instant `instant` on the client's local weeks */
  ofInstant(instant: string): number
  /** the first day of `week`, YYYY-MM-DD */
  firstDay(week: number): string
}

/** The client's day and weeks as a query takes them (clockOf): its day,
 * the first day of its week, the instants its last WEEK_STARTS local weeks
 * began at and the instant its next week begins at. overview.ts and
 * teamSync.ts agenda take it. */
export const vClock = {
  day: v.string(),
  week: v.string(),
  week_starts: v.array(v.number()),
  week_end: v.number(),
}

/**
 * The clock of `day`, `week`, `week_starts` and `week_end`, or a badRequest
 * where one is malformed: `day` and `week` not real days, `week` not the
 * first day of a week holding `day`, `week_starts` not exactly WEEK_STARTS
 * instants in milliseconds, ascending, each within three hours of 7 days
 * after the one before (a daylight-saving change), the last of them not an
 * instant the local midnight of `week` can fall on in some zone (from 14
 * hours before its UTC midnight to 12 after), or `week_end`, the instant
 * the next local week begins at, not as far after the last of them. So the
 * weeks begin on the days `week` names, as lib/teamSync.ts readingBounds
 * places local midnights. An instant falls in the local week whose start it
 * is at or after and whose end it is before, so a week a daylight-saving
 * change makes 167 or 169 hours long ends where the client's does. One
 * before the first start falls in whole weeks of 7 days before it, and one
 * after `week_end` in whole weeks after it, exact unless a daylight-saving
 * change lies past the window, and then only within an hour of a week's
 * start.
 */
export function clockOf(a: {
  day: string
  week: string
  week_starts: readonly number[]
  week_end: number
}): Clock {
  const today = dayArg(a.day, 'day')
  const first = dayArg(a.week, 'week')
  if (today - first < 0 || today - first > 6)
    throw badRequest('week must be the first day of the week that holds day')
  const starts = a.week_starts
  if (starts.length !== WEEK_STARTS || !starts.every((s) => Number.isSafeInteger(s)))
    throw badRequest(
      `week_starts must hold the ${WEEK_STARTS} instants the last weeks began at, in milliseconds`,
    )
  for (let i = 1; i < starts.length; i++)
    if (Math.abs(starts[i] - starts[i - 1] - WEEK_MS) > WEEK_SLACK_MS)
      throw badRequest('week_starts must be ascending, a week apart')
  const last = starts.length - 1
  const midnight = first * DAY_MS
  if (starts[last] < midnight - ZONE_EAST_MS || starts[last] > midnight + ZONE_WEST_MS)
    throw badRequest('week_starts must end at the local midnight that begins week')
  const end = a.week_end
  if (!Number.isSafeInteger(end) || Math.abs(end - starts[last] - WEEK_MS) > WEEK_SLACK_MS)
    throw badRequest('week_end must be the instant the week after the last of week_starts began at')
  return {
    day: a.day,
    ofDay: (iso) => Math.floor((dayNumber(iso) - first) / 7),
    ofInstant: (instant) => {
      const ms = Date.parse(instant)
      if (ms >= end) return 1 + Math.floor((ms - end) / WEEK_MS)
      if (ms >= starts[last]) return 0
      if (ms < starts[0]) return -last - Math.ceil((starts[0] - ms) / WEEK_MS)
      let lo = 0
      let hi = last
      // the last start at or before `ms`
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (starts[mid] <= ms) lo = mid
        else hi = mid
      }
      return lo - last
    },
    firstDay: (week) => new Date((first + 7 * week) * DAY_MS).toISOString().slice(0, 10),
  }
}

// --- verdicts --------------------------------------------------------------------------

/* What the caller's access may read of the caller's own rows at once in one
 * round of questions (lib/machineDelay.ts STEP_READS). */
const STEP_HOLD: ReadCeiling = {
  ranges: LEVEL_STEP_READS.ranges + 1,
  documents: LEVEL_STEP_READS.documents + OWN_READS.orgTeamsMost + 1,
  bytes: LEVEL_STEP_READS.bytes + 3 * OWN_READS.bytes,
}

/** The room of the owner reader of a view's query whose owner reads
 * start at `start`: lib/ownerLoads.ts OWNER_LOADS.call from there past the
 * access instance's shared reads, and within the query's `guard` (its
 * ceiling, without the room it holds) less STEP_HOLD where a round may read
 * the caller's own rows at once, as lib/machineDelay.ts delayRoom builds
 * it, so the loads share the query's own budget and never pass Convex's
 * limits. */
const loadRoom =
  (start: TransactionMetrics, guard: ViewBudget): ReadRoom =>
  (m, shared, wide) => {
    const budget = guard.ceiling
    const hold = wide ? STEP_HOLD : { ranges: 0, documents: 0, bytes: 0 }
    const since = (now: number, then: number, own: number) => now - then - own
    return {
      ranges: Math.min(
        OWNER_LOADS.call.ranges -
          since(m.databaseQueries.used, start.databaseQueries.used, shared.ranges),
        budget.ranges - hold.ranges - m.databaseQueries.used,
      ),
      documents: Math.min(
        OWNER_LOADS.call.documents -
          since(m.documentsRead.used, start.documentsRead.used, shared.documents),
        budget.documents - hold.documents - m.documentsRead.used,
      ),
      bytes: Math.min(
        OWNER_LOADS.call.bytes - since(m.bytesRead.used, start.bytesRead.used, shared.bytes),
        budget.bytes - hold.bytes - m.bytesRead.used,
      ),
    }
  }

/** The verdict of a task that needs an owner's load nobody could read. */
export const UNKNOWN = 'unknown' as const

/* One owner's load as the projection walks it, or unknown where it could
 * not be read. */
type Load = LoadSpan[] | typeof UNKNOWN

/**
 * The verdicts of one query, on `clock`: each task's as lib/delay.ts gives
 * it, with the owner's load read once (lib/ownerLoads.ts ownerLoadReader)
 * where it can move the verdict (needsLoad), through one access instance a
 * seat, in a room built from the query's own budget (loadRoom). A guest or
 * an organization Viewer gets at most one owner's load a query; a verdict
 * that needs another is unknown, and so is one whose owner did not fit.
 * Once readAll stopped at an owner of an organization, every owner it did
 * not reach there is unknown too, without a read, so which verdicts are
 * known follows the owner id order and never the order tasks ask in.
 */
export function verdicts(ctx: QueryCtx, guard: ViewBudget, seats: ViewSeats, clock: Clock) {
  const profiles = new Map<string, Promise<Doc<'profiles'> | null>>()
  const loads = new Map<string, Load>()
  // the tasks the reader answered for each owner whose load it read
  const owned = new Map<string, readonly OwnedTask[]>()
  const readers = new Map<string, ReturnType<typeof ownerLoadReader>>()
  // the owners a guest's or Viewer's seat read, by organization
  const read = new Map<string, number>()
  // the organizations whose readAll stopped at an owner it could not read
  const stopped = new Set<string>()

  const profileOf = async (id: string): Promise<Doc<'profiles'> | null> => {
    let p = profiles.get(id)
    if (p === undefined) {
      await guard.take(BY_ID)
      p = byId(ctx, 'profiles', id)
      profiles.set(id, p)
    }
    return await p
  }

  /* The owner's capacity as the app reads it from its roster. */
  const capacityOf = (owner: Doc<'profiles'> | null, orgId: string) =>
    owner !== null && owner.org_id === orgId
      ? plannableHoursOf({ plannableHours: owner.plannable_hours, kind: owner.kind })
      : DEFAULT_PLANNABLE_HOURS

  /* `task` as lib/delay.ts reads it, as the app's store builds it. */
  const delayIssue = (
    task: Doc<'issues'>,
    facts: GroupFacts | null,
    capacity: number,
  ): DelayIssue => {
    const week = (day: string | undefined) => (day ? clock.ofDay(day) : null)
    let start: number | null
    let end: number | null
    if (facts !== null) {
      start = week(facts.span.start_week)
      end = week(facts.span.end_week)
    } else {
      start = week(task.start_week)
      const planned = week(task.end_week)
      end = planned === null ? null : Math.max(start ?? planned, planned)
    }
    return {
      uuid: task.id,
      status: task.status,
      isGroup: facts !== null,
      isDone: facts === null ? task.status === 'done' : facts.done,
      partial: facts?.span.partial ?? false,
      owner: taskOwnerId(task, facts !== null) ?? null,
      start,
      end,
      dueWeek: week(task.due_date),
      duePast: task.due_date !== undefined && task.due_date < clock.day,
      remaining: task.remaining_hours,
      remainingSet: task.remaining_set_at ? clock.ofInstant(task.remaining_set_at) : null,
      capacity,
    }
  }

  /* The load of `owner`, an owner of a seat of organization `orgId`. */
  const loadOf = async (orgId: string, owner: string): Promise<Load> => {
    const known = loads.get(owner)
    if (known !== undefined) return known
    // an owner past the one readAll stopped at is never read after it
    if (stopped.has(orgId)) return UNKNOWN
    const seat = seats.get(orgId)
    if (seat === undefined) return UNKNOWN
    if (!isOrgStaff(seat.me)) {
      // a guest or Viewer reads one owner's load a query
      if ((read.get(orgId) ?? 0) >= 1) return UNKNOWN
      read.set(orgId, 1)
    }
    let reader = readers.get(orgId)
    if (reader === undefined) {
      const access: Access = accessOf(ctx, seat.me)
      reader = ownerLoadReader(ctx, {
        me: seat.me,
        access,
        room: loadRoom(await ctx.meta.getTransactionMetrics(), guard),
      })
      readers.set(orgId, reader)
    }
    const got = await reader.read(owner)
    // the guard looks at the request's reads again before its next read
    guard.forget()
    const load: Load =
      got.state !== 'ok'
        ? UNKNOWN
        : canonicalLoad(
            loadRowsOf(seat.me, got.tasks).map((row) => ({
              issueUuid: row.issue_id,
              start: clock.ofDay(row.start_week),
              end: clock.ofDay(row.end_week),
              remaining: row.remaining,
              remainingSet:
                row.remaining_set_at === null ? null : clock.ofInstant(row.remaining_set_at),
            })),
          )
    if (got.state === 'ok') owned.set(owner, got.tasks)
    loads.set(owner, load)
    return load
  }

  return {
    /** The profiles with these ids, each read once a query through the
     * guard, as the verdicts read an owner's capacity, so a reader that
     * needs the same profiles reads them once. Those not read before are
     * read in steps (lib/viewReads.ts byIdSteps), so many profiles never
     * need the room of all of them at once. */
    async profiles(ids: readonly string[]): Promise<(Doc<'profiles'> | null)[]> {
      const fresh = [...new Set(ids)].filter((id) => !profiles.has(id))
      await byIdSteps(guard, fresh, (id) => {
        const p = byId(ctx, 'profiles', id)
        profiles.set(id, p)
        return p
      })
      return await settled(ids.map(profileOf))
    },
    /** The tasks the owner reader answered for the owner with this id
     * (lib/ownerLoads.ts OwnedLoad tasks), once their load was read, or
     * null where it was not read or could not be, for lib/ownerLoads.ts
     * weeklyHours. Without the reader's `paused` option, so they hold no
     * paused task. */
    tasksOf: (ownerId: string): readonly OwnedTask[] | null => owned.get(ownerId) ?? null,
    /** The owner whose load `task`'s verdict needs, with its capacity, or
     * null where the load cannot move it: a group, a Done task, one with
     * neither a planned end nor a due date, no remaining hours, an owner
     * without a finite week (an agent) or no owner. */
    async needs(task: Doc<'issues'>, facts: GroupFacts | null) {
      if (facts !== null || task.status === 'done') return null
      if (task.end_week === undefined && task.due_date === undefined) return null
      if (!((task.remaining_hours ?? 0) > 0)) return null
      const id = taskOwnerId(task, false)
      if (id === undefined) return null
      const owner = await profileOf(id)
      const capacity = capacityOf(owner, task.org_id)
      if (owner === null || !Number.isFinite(capacity) || capacity <= 0) return null
      return id
    },
    /** `task`'s verdict, with `facts` for a group, or UNKNOWN where the load
     * it needs could not be read. */
    async of(
      task: Doc<'issues'>,
      facts: GroupFacts | null,
    ): Promise<DelayInfo | null | typeof UNKNOWN> {
      const ownerId = taskOwnerId(task, facts !== null)
      const owner = ownerId === undefined ? null : await profileOf(ownerId)
      const it = delayIssue(task, facts, capacityOf(owner, task.org_id))
      const needed = await this.needs(task, facts)
      if (needed === null) return delayOf(it, [], 0)
      const load = await loadOf(task.org_id, needed)
      if (load === UNKNOWN) return UNKNOWN
      return delayOf(it, load, 0)
    },
    /** Reads the loads of `owners`, owner ids of organization `orgId`, in
     * owner id order, and answers whether every one was read. It stops at
     * the first it could not read, and the owners after it stay unknown. */
    async readAll(orgId: string, owners: readonly string[]): Promise<boolean> {
      for (const owner of [...new Set(owners)].sort())
        if ((await loadOf(orgId, owner)) === UNKNOWN) {
          stopped.add(orgId)
          return false
        }
      return true
    },
  }
}

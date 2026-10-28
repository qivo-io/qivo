/* Milestone rules shared by every milestone write (projects.ts, roadmap.ts,
 * the REST and MCP milestone actions in machine/projects.ts, and the
 * Northstar seed in model/demoSeed.ts). A milestone lives on the top-level
 * project whose roadmap shows it, its name is not blank, and its week is one
 * real calendar day.
 *
 * One milestone a week (LIMITS.milestonesPerWeek). A top-level project holds
 * at most one milestone in each calendar week of its organization: seven
 * days from its week_start, whatever week_one_rule numbers them. Every write
 * that creates a milestone or changes its day calls assertWeekFree in its
 * own transaction, after its last change to the milestones it checks.
 * assertWeekFree reads the organization and one by_project_week range, the
 * days of that week, so two writes that claim one project's week conflict
 * and the retry is refused, and a change of the first day of the week
 * (assertWeekStartFits, which reads every range and writes the
 * organization) conflicts with every milestone write. Deleted items keeps a
 * deleted project's milestones and a restore writes them back unchanged
 * (model/deletedItems.ts), so assertWeekStartFits checks those too.
 *
 * Refusals read the same on every surface. A project or milestone the caller
 * cannot see, in their organization or another, reads as not found. One they
 * can see without User access on the project that stores the milestone is
 * forbidden. Callers resolve the caller's seat and check the billing pause
 * (orgMutation, the roadmap writer, asMachineCaller). A machine caller passes
 * its `provenance`, which signs the activity row.
 *
 * The app's milestone reads (milestones.ts) live at the end of this file.
 * readMilestones merges the milestones of up to MILESTONE_READ.projects
 * top-level projects in one order, a batch at a time and inside a read
 * budget, and visibleMilestone answers one milestone by id. */

import type { TransactionMetric, TransactionMetrics } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import {
  canSeeProject,
  hasProjectLevel,
  levelRank,
  projectLevel,
  projectLevelsOf,
  rootMetaOf,
} from '../lib/access'
import {
  type CeilingGuard,
  ceilingGuard,
  type ReadCeiling,
  readsUnder,
  roomOf,
} from '../lib/archivedTasks'
import { assertNewRowId, byId, insertUnique, usedMoreThan } from '../lib/db'
import type { DeletedItemState } from '../lib/enums'
import { trimmedForm } from '../lib/fieldPrints'
import { badRequest, forbidden, notFound, type Refusal, require, rule } from '../lib/functions'
import { limitedText } from '../lib/limitRules'
import {
  LIMITS,
  MILESTONE_READ_PROJECTS,
  milestoneWeekTaken,
  WEEK_START_REFUSALS,
} from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { allWordsMatcher } from '../lib/search'
import { logActivity, signedDetail } from './activity'
import { DOCUMENT_MAX_BYTES } from './comments'
import { newMemo, viewOf } from './deletedItems'
import {
  assertExpected,
  DAY_SHAPED,
  DELETES,
  exact,
  type Fields,
  filledText,
  type Next,
  TEXT,
  type View,
} from './expected'
import {
  dayLabel,
  shiftDay,
  shownDay,
  WEEKDAY_NAMES,
  weekDays,
  weekLabel,
  weekPhrase,
} from './orgs'
import { calendarDay } from './taskValues'

/* Milestone policies are User level (0078:497, member→user). */
async function assertMilestoneWriter(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  project: Doc<'projects'>,
): Promise<void> {
  if (!(await hasProjectLevel(ctx, me, project.id, 'user'))) {
    throw forbidden('no write access to this project')
  }
}

/** The top-level project that stores a new milestone `me` names against
 * `projectId`. A sub-project folds up to it, as in the app, and `me` needs
 * User access there, so a grant on a sub-project alone is not enough. An
 * archived named or top-level project is refused with the arrival sentence
 * (milestones_project_archived_guard, 0106:148). */
export async function milestoneTarget(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  projectId: string,
): Promise<Doc<'projects'>> {
  const named = await byId(ctx, 'projects', projectId)
  if (named === null || !(await canSeeProject(ctx, me, named))) {
    throw notFound('project not found')
  }
  const home = await rootMetaOf(ctx, named)
  await assertMilestoneWriter(ctx, me, home)
  if (named.archived_at !== undefined || home.archived_at !== undefined) {
    throw rule('that project is archived, so restore it first')
  }
  return home
}

/** An existing milestone `me` may rename, move or delete, with the project
 * that stores it. `me` needs User access on that project. */
export async function changeableMilestone(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  id: string,
): Promise<{ milestone: Doc<'milestones'>; project: Doc<'projects'> }> {
  const milestone = await byId(ctx, 'milestones', id)
  const project = milestone && (await byId(ctx, 'projects', milestone.project_id))
  if (!milestone || !project || !(await canSeeProject(ctx, me, project))) {
    throw notFound('milestone not found')
  }
  await assertMilestoneWriter(ctx, me, project)
  return { milestone, project }
}

/** Validates a milestone week, one real calendar day as YYYY-MM-DD. The app
 * sends the picked day, usually the first day of a week. */
export function cleanMilestoneWeek(raw: string): string {
  return calendarDay(raw, {
    shape: 'a milestone week is an ISO date (YYYY-MM-DD)',
    date: 'a milestone week must be a valid calendar date',
  })
}

/** cleanMilestoneWeek with the machine surfaces' field name, `date`. */
export function cleanMilestoneDate(raw: unknown): string {
  return calendarDay(raw, {
    shape: 'date must be YYYY-MM-DD',
    date: 'date must be a valid calendar date',
  })
}

/** A milestone name as stored: trimmed, and refused when nothing is left, as
 * the app's Milestones window does before it saves, or past
 * LIMITS.milestoneName. */
export function cleanMilestoneName(raw: string): string {
  const name = limitedText(LIMITS.milestoneName, raw)
  if (name === '') throw rule('a milestone name cannot be blank')
  return name
}

/* The organization whose calendar labels a milestone's week. */
async function orgOf(ctx: QueryCtx, me: Doc<'profiles'>): Promise<Doc<'organizations'>> {
  const org = await byId(ctx, 'organizations', me.org_id)
  require(org !== null, notFound('organization not found'))
  return org
}

/** The reason of the refusal of a milestone in a week its project already
 * holds another milestone in (assertWeekFree). */
export const MILESTONE_WEEK_TAKEN = 'milestone_week_taken'

/** How many days before a week's first day its read starts. A day that does
 * not exist, stored before 2026-10-16, is shown on the day it overflows to,
 * 2026-02-31 on 3 March. Its text sorts at the end of its own month, at most
 * 3 days before the day it is shown on (day 31 of a 28-day February), so the
 * read reaches back that far. A day past 31 or a month past 12 can sort
 * farther away; internal/milestoneWeeks reports those. readMilestones starts
 * a read with a first day this far back too. */
export const OVERFLOW_DAYS = 3

/**
 * The milestone of project `projectId`, other than `except`, in the week of
 * `day` under `org`'s week start, or null. One range holds the days of that
 * week and the OVERFLOW_DAYS before it, and each row's own week, as the app
 * shows it (weekDays), decides. LIMITS.milestonesPerWeek allows one
 * milestone a week, so any other one there holds the week.
 */
export async function weekHolder(
  ctx: QueryCtx,
  a: {
    org: Doc<'organizations'>
    projectId: string
    day: string
    except?: Id<'milestones'>
  },
): Promise<Doc<'milestones'> | null> {
  const week = weekDays(a.day, a.org)
  if (week === null) return null
  const from = shiftDay(week.first, -OVERFLOW_DAYS)
  const rows = ctx.db
    .query('milestones')
    .withIndex('by_project_week', (q) =>
      q.eq('project_id', a.projectId).gte('week', from).lte('week', week.last),
    )
  for await (const row of rows)
    if (row._id !== a.except && weekDays(row.week, a.org)?.first === week.first) return row
  return null
}

/** The refusal of a milestone in the week `holder` holds, which names the
 * week in `org`'s calendar and `holder`, and `next`, the step past it,
 * picking another week unless the caller says otherwise. */
export function weekTaken(
  holder: Pick<Doc<'milestones'>, 'name' | 'week'>,
  org: Doc<'organizations'>,
  next?: string,
): ConvexError<Refusal> {
  return new ConvexError<Refusal>({
    code: 'rule',
    reason: MILESTONE_WEEK_TAKEN,
    message: milestoneWeekTaken(weekPhrase(holder.week, org), holder.name, next),
  })
}

/**
 * Refuses a milestone on `day` in project `projectId` when another milestone
 * of the project, not `except`, is in that week of `org`'s calendar
 * (LIMITS.milestonesPerWeek, weekHolder). `org` is the project's
 * organization, read in this transaction. Call it after the write it
 * checks, or before an insert, in the same transaction.
 */
export async function assertWeekFree(
  ctx: QueryCtx,
  a: {
    org: Doc<'organizations'>
    projectId: string
    day: string
    except?: Id<'milestones'>
    next?: string
  },
): Promise<void> {
  const holder = await weekHolder(ctx, a)
  if (holder !== null) throw weekTaken(holder, a.org, a.next)
}

/** The share of Convex's limits for one transaction a check of a new first
 * day of the week may use before it stops and answers that it could not
 * check every milestone. It reads one document a project and a milestone
 * and one range a top-level project, so half of the limits cover about
 * 16,000 projects and milestones together, about 2,000 of the projects
 * top-level ones. Tests lower the transaction limits. */
export const WEEK_START_ROOM = 0.5

/* How many milestones the check reads between two looks at its room. 256
 * of the largest hold about 128 KiB. */
const WEEK_START_STEP = 256

/* The Deleted items states whose project items can still come back and
 * bring their milestones with them. A stuck item can only be deleted for
 * good, and a purging one is being deleted. */
const RESTORABLE: readonly DeletedItemState[] = ['moving', 'ready', 'restoring']

/* How many clashes a refusal names. It counts the rest. */
const NAMED_CLASHES = 5

/* A week in which one project would hold two or more milestones. */
type Clash = {
  project: { name: string; key: string }
  /** the live project, or null for a project in Deleted items */
  live: Doc<'projects'> | null
  item: Doc<'deleted_items'> | null
  first: string
  milestones: Pick<Doc<'milestones'>, 'name' | 'week'>[]
}

/* The weeks in which `rows`, one project's milestones, would hold more than
 * one milestone under week start `next`, in date order. A day that names no
 * day at all belongs to no week. */
function clashesIn(
  rows: Iterable<Pick<Doc<'milestones'>, 'name' | 'week'>>,
  next: Pick<Doc<'organizations'>, 'week_start'>,
): { first: string; milestones: Pick<Doc<'milestones'>, 'name' | 'week'>[] }[] {
  const weeks = new Map<string, Pick<Doc<'milestones'>, 'name' | 'week'>[]>()
  for (const row of rows) {
    const first = weekDays(row.week, next)?.first
    if (first !== undefined) weeks.set(first, [...(weeks.get(first) ?? []), row])
  }
  return [...weeks]
    .filter(([, held]) => held.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([first, milestones]) => ({
      first,
      milestones: milestones.sort((a, b) => a.week.localeCompare(b.week)),
    }))
}

/* `items` as one phrase: "a", "a and b", "a, b and c". */
const listed = (items: string[]): string =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/**
 * Refuses to change `org`'s first day of the week to `weekStart` when the new
 * weeks would put two milestones of one top-level project in one week
 * (LIMITS.milestonesPerWeek). It reads the milestones of every top-level
 * project of the organization, archived ones included, and of each top-level
 * project in Deleted items that can still be restored, in this transaction,
 * so a concurrent milestone write conflicts with the change. A project in
 * Deleted items that a restore has already revealed is read once, as a live
 * one. The refusal names the projects, the days and the weeks, and the
 * milestones of a project only to a caller who can see it, and gives the
 * step that works for an archived project or one in Deleted items, whose
 * milestones the app shows only once it is back. Past WEEK_START_ROOM it
 * stops. It then names the clashes it found, and says that there may be more, or with none
 * found refuses with the sentence that it could not check every milestone,
 * never with a clash it did not find. A milestone stored on a sub-project
 * before 2026-10-14 is left out; internal/milestoneWeeks reports those.
 */
export async function assertWeekStartFits(
  ctx: QueryCtx,
  a: { me: Doc<'profiles'>; org: Doc<'organizations'>; weekStart: number },
): Promise<void> {
  const { me, org } = a
  const next = { ...org, week_start: a.weekStart }
  const clashes: Clash[] = []
  let read = 0
  let stopped = false
  // Whether the check has room for more reads. It looks before each range
  // it reads and every WEEK_START_STEP documents.
  const room = async (look: boolean): Promise<boolean> => {
    if (!stopped && look) stopped = await usedMoreThan(ctx, WEEK_START_ROOM)
    return !stopped
  }
  const counted = () => room(++read % WEEK_START_STEP === 0)
  // one project's milestones from `rows`, until the room runs out
  const gather = async (
    rows: AsyncIterable<Pick<Doc<'milestones'>, 'id' | 'name' | 'week'>>,
    into: Map<string, Pick<Doc<'milestones'>, 'name' | 'week'>>,
  ): Promise<void> => {
    if (!(await room(true))) return
    for await (const row of rows) {
      into.set(row.id, row)
      if (!(await counted())) return
    }
  }
  const projects = ctx.db.query('projects').withIndex('by_org', (q) => q.eq('org_id', org.id))
  for await (const project of projects) {
    if (!(await counted())) break
    if (project.parent_id !== undefined) continue
    const rows = new Map<string, Pick<Doc<'milestones'>, 'name' | 'week'>>()
    await gather(
      ctx.db
        .query('milestones')
        .withIndex('by_project_week', (q) => q.eq('project_id', project.id)),
      rows,
    )
    for (const clash of clashesIn(rows.values(), next))
      clashes.push({ ...clash, project, live: project, item: null })
  }
  for (const state of RESTORABLE) {
    const items = ctx.db
      .query('deleted_items')
      .withIndex('by_org_parent_kind_state', (q) =>
        q
          .eq('org_id', org.id)
          .eq('parent_project_id', undefined)
          .eq('kind', 'project')
          .eq('state', state),
      )
    if (!(await room(true))) break
    for await (const item of items) {
      if (!(await counted())) break
      // a restore that has revealed the project goes on as restoring a
      // while, and the live projects above read its milestones already
      if ((await byId(ctx, 'projects', item.target_id)) !== null) continue
      // the rows a move has not taken yet or a restore has written back,
      // then the stored ones
      const rows = new Map<string, Pick<Doc<'milestones'>, 'name' | 'week'>>()
      await gather(
        ctx.db
          .query('milestones')
          .withIndex('by_project_week', (q) => q.eq('project_id', item.target_id)),
        rows,
      )
      const stored = async function* () {
        const copies = ctx.db
          .query('deleted_rows')
          .withIndex('by_item_table_owner', (q) =>
            q.eq('item_id', item.id).eq('table', 'milestones').eq('owner_id', item.target_id),
          )
        for await (const copy of copies) if (copy.row.table === 'milestones') yield copy.row.doc
      }
      await gather(stored(), rows)
      for (const clash of clashesIn(rows.values(), next))
        clashes.push({
          ...clash,
          project: { name: item.name, key: item.key ?? '' },
          live: null,
          item,
        })
    }
  }
  if (clashes.length === 0) {
    if (!stopped) return
    throw new ConvexError<Refusal>({
      code: 'rule',
      reason: WEEK_START_REFUSALS.unchecked,
      message: `Qivo could not check every milestone of this organization at once, so workdays still start on ${WEEKDAY_NAMES[org.week_start] ?? 'the same day'}. Contact support@qivo.io to change the first day of the week.`,
    })
  }
  const named: string[] = []
  const memo = newMemo()
  for (const clash of clashes.slice(0, NAMED_CLASHES)) {
    const sees =
      clash.live !== null
        ? await canSeeProject(ctx, me, clash.live)
        : clash.item !== null && (await viewOf(ctx, memo, me, clash.item)) !== null
    const where =
      clash.live === null ? ', in Deleted items' : clash.live.archived_at ? ', archived' : ''
    const days = clash.milestones.map((m) =>
      sees ? `“${m.name}” on ${dayLabel(m.week, next)}` : dayLabel(m.week, next),
    )
    named.push(
      `${clash.project.name} (${clash.project.key}${where}) would have ${sees ? '' : 'milestones on '}${listed(days)} in ${weekPhrase(clash.first, next)}`,
    )
  }
  const more = clashes.length - named.length
  const rest =
    more === 0
      ? ''
      : `; and ${more} more ${more === 1 ? 'week' : 'weeks'} would hold two milestones of one project`
  // the app shows the milestones of an archived project or one in Deleted
  // items only once it is back
  const shown = clashes.slice(0, NAMED_CLASHES)
  const steps = [
    'Move or delete milestones so that no project has two in one week, then change the first day again.',
    ...(shown.some((c) => c.live?.archived_at !== undefined)
      ? ['Restore an archived project first to change its milestones.']
      : []),
    ...(shown.some((c) => c.live === null)
      ? ['Restore a project in Deleted items to change its milestones, or delete it for good.']
      : []),
    ...(stopped ? ['Qivo could not check every project, so there may be more.'] : []),
  ]
  throw new ConvexError<Refusal>({
    code: 'rule',
    reason: WEEK_START_REFUSALS.conflicts,
    message: `workdays cannot start on ${WEEKDAY_NAMES[a.weekStart]}, because a project can have at most 1 milestone a week, and then ${named.join('; ')}${rest}. ${steps.join(' ')}`,
  })
}

/**
 * Adds a milestone named against `projectId` to the top-level project that
 * stores it (milestoneTarget) and narrates it. A week the project already
 * holds a milestone in is refused (assertWeekFree). Narration details embed
 * weekLabel computed against the organization's settings, frozen at write
 * time (trap T1).
 */
export async function addMilestoneCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    id: string
    projectId: string
    name: string
    week: string
    now: string
    provenance?: string
  },
): Promise<Doc<'milestones'>> {
  const { me, id, now } = a
  assertNewRowId(id)
  const home = await milestoneTarget(ctx, me, a.projectId)
  const week = cleanMilestoneWeek(a.week)
  const name = cleanMilestoneName(a.name)
  const org = await orgOf(ctx, me)
  await assertWeekFree(ctx, { org, projectId: home.id, day: week })
  await insertUnique(
    ctx,
    'milestones',
    'by_uuid',
    { id },
    { id, project_id: home.id, name, week, created_at: now },
    badRequest('a milestone with this id already exists'),
  )
  await logActivity(ctx, {
    org_id: me.org_id,
    actor_id: me.id,
    verb: 'added milestone',
    target_type: 'milestone',
    target_id: id,
    label: name,
    detail: signedDetail(`at ${weekLabel(week, org)}`, a.provenance),
    project_id: home.id,
    ts: now,
  })
  const row = await byId(ctx, 'milestones', id)
  require(row !== null, notFound('milestone not found'))
  return row
}

/** The keys of a milestone's `expected` in the app, which reads its day as
 * `week`. */
export const MILESTONE_FIELDS: Fields<Doc<'milestones'>> = {
  // cleanMilestoneName's rule
  name: { sends: 'name', type: filledText(LIMITS.milestoneName), form: trimmedForm },
  week: { sends: 'week', type: TEXT, form: exact },
}

/** The keys of a milestone's `expected` over REST and MCP, which read its
 * day as `date`. */
export const MILESTONE_MACHINE_FIELDS: Fields<Doc<'milestones'>> = {
  name: MILESTONE_FIELDS.name,
  // the shape only: until 2026-10-16 a milestone took a day that does not
  // exist, such as 2026-02-31, and a read answers it as stored
  date: { sends: 'date', type: DAY_SHAPED, form: exact, stored: (m) => m.week },
}

/** The app's `expected` for a milestone edit or delete. */
export const vMilestoneExpected = v.object({
  name: v.optional(v.string()),
  week: v.optional(v.string()),
})

/** Refuses a milestone edit or delete over a field someone else changed
 * since `expected` was read (model/expected.ts). `next` holds the name and
 * day the edit stores, under the surface's keys, or DELETES. */
export async function assertMilestoneExpected(
  ctx: QueryCtx,
  a: {
    me: Doc<'profiles'>
    milestone: Doc<'milestones'>
    view: View
    expected: Readonly<Record<string, unknown>> | undefined
    next: Next
  },
): Promise<void> {
  await assertExpected({
    read: { ctx, me: a.me, view: a.view },
    fields: a.view === 'app' ? MILESTONE_FIELDS : MILESTONE_MACHINE_FIELDS,
    record: 'milestone',
    id: a.milestone.id,
    label: `milestone "${a.milestone.name}"`,
    row: a.milestone,
    expected: a.expected,
    next: a.next,
  })
}

/**
 * Renames or moves a milestone the caller may change (changeableMilestone)
 * and narrates it. A move into a week another milestone of the project holds
 * is refused (assertWeekFree). A rename is not checked, and a move within
 * the milestone's own week passes unless another milestone, stored there
 * before the rule, shares that week. The verb names what actually CHANGED,
 * so a pure rename does not read as a move (bc022c2:3536-3562, trap T15).
 * A submit that changes neither the name nor the week is validated, then
 * changes and narrates nothing, although the app's dialog always sends both
 * fields. Older rows may say 'updated milestone' for such a submit.
 */
export async function updateMilestoneCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    milestone: Doc<'milestones'>
    patch: { name?: string; week?: string }
    now: string
    provenance?: string
    /** What the caller read (assertMilestoneExpected), in its view. */
    expected?: Readonly<Record<string, unknown>>
    view?: View
  },
): Promise<Doc<'milestones'>> {
  const { me, milestone, now } = a
  const view = a.view ?? 'app'
  const day = view === 'app' ? 'week' : 'date'
  await assertMilestoneExpected(ctx, {
    me,
    milestone,
    view,
    expected: a.expected,
    next: {
      ...(a.patch.name !== undefined ? { name: a.patch.name } : {}),
      ...(a.patch.week !== undefined ? { [day]: a.patch.week } : {}),
    },
  })
  const db: Partial<Doc<'milestones'>> = {}
  if (a.patch.name !== undefined) db.name = cleanMilestoneName(a.patch.name)
  if (a.patch.week !== undefined) db.week = cleanMilestoneWeek(a.patch.week)
  const weekChanged = db.week !== undefined && db.week !== milestone.week
  const renamed = db.name !== undefined && db.name !== milestone.name
  if (!weekChanged && !renamed) return milestone
  const org = await orgOf(ctx, me)
  // a new day needs a week no other milestone of the project holds; a
  // rename keeps its week as it is
  if (weekChanged && db.week !== undefined)
    await assertWeekFree(ctx, {
      org,
      projectId: milestone.project_id,
      day: db.week,
      except: milestone._id,
    })
  await ctx.db.patch(milestone._id, db)
  const name = db.name ?? milestone.name
  await logActivity(ctx, {
    org_id: me.org_id,
    actor_id: me.id,
    verb: weekChanged ? 'moved milestone' : 'renamed milestone',
    target_type: 'milestone',
    target_id: milestone.id,
    label: name,
    detail: signedDetail(
      weekChanged
        ? `from ${weekLabel(milestone.week, org)} to ${weekLabel(db.week as string, org)}` +
            (renamed ? ` (renamed from “${milestone.name}”)` : '')
        : `from “${milestone.name}”`,
      a.provenance,
    ),
    project_id: milestone.project_id,
    ts: now,
  })
  const row = await ctx.db.get(milestone._id)
  require(row !== null, notFound('milestone not found'))
  return row
}

/** Deletes a milestone the caller may change and narrates it. Deleted
 * items cannot bring a milestone back, so a delete may carry `expected`,
 * the name and day the caller read, and is refused when someone changed
 * one of them since. */
export async function removeMilestoneCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    milestone: Doc<'milestones'>
    now: string
    provenance?: string
    expected?: Readonly<Record<string, unknown>>
    view?: View
  },
): Promise<void> {
  const { me, milestone, now } = a
  await assertMilestoneExpected(ctx, {
    me,
    milestone,
    view: a.view ?? 'app',
    expected: a.expected,
    next: DELETES,
  })
  await ctx.db.delete(milestone._id)
  await logActivity(ctx, {
    org_id: me.org_id,
    actor_id: me.id,
    verb: 'deleted milestone',
    target_type: 'milestone',
    target_id: milestone.id,
    label: milestone.name,
    detail: signedDetail(undefined, a.provenance),
    project_id: milestone.project_id,
    ts: now,
  })
}

/* ------------------------------------------------------------------ reads */

/** The budget of one of the app's milestone reads (milestones.ts). A call
 * names at most `projects` projects and asks for at most `rows` rows. The
 * milestone reads (readMilestones) stop once they have read `ranges` index
 * ranges, `documents` documents or `bytes` bytes, counted from their own
 * start, and never past what the request has left. That is the share a workspace part reads before it asks to be cut
 * (lib/workspaceParts.ts PAGE.soft). These reads are subscriptions that
 * rerun whenever a row they read changes, so none costs more than the
 * projects part that carried every milestone before them. Tests lower
 * these. */
export const MILESTONE_READ = {
  projects: MILESTONE_READ_PROJECTS,
  rows: 25,
  ranges: 2000,
  documents: 8000,
  bytes: 4 * 1024 * 1024,
}

/* What a read keeps back from the request's limits, as a ceilingGuard can
 * let one more document of any size through after its last look. */
const MILESTONE_RESERVE: ReadCeiling = { ranges: 0, documents: 1, bytes: DOCUMENT_MAX_BYTES }

/** The share of the request the check of a read's projects
 * (milestoneProjects) may read, counted from the check's start, as
 * MILESTONE_READ is for the read after it. Tests lower these. */
export const MILESTONE_SCOPE: ReadCeiling = {
  ranges: 2000,
  documents: 8000,
  bytes: 4 * 1024 * 1024,
}

/* The ceiling of a check of projects that starts at `m`: MILESTONE_SCOPE
 * past what the transaction has read, and at most half of what the request
 * has left, so the read after it and one navigation check past the ceiling
 * still fit. */
const scopeCeiling = (m: TransactionMetrics): ReadCeiling => {
  const share = (metric: TransactionMetric, more: number) =>
    metric.used + Math.min(more, Math.floor(metric.remaining / 2))
  return {
    ranges: share(m.databaseQueries, MILESTONE_SCOPE.ranges),
    documents: share(m.documentsRead, MILESTONE_SCOPE.documents),
    bytes: share(m.bytesRead, MILESTONE_SCOPE.bytes),
  }
}

/** The reason of the refusal of a milestone read whose projects need more
 * reads than one request allows (milestoneProjects). */
export const MILESTONE_READ_TOO_LARGE = 'milestone_read_too_large'

/* That refusal. The caller can ask again for fewer projects. */
const readTooLarge = (): ConvexError<Refusal> =>
  new ConvexError<Refusal>({
    code: 'rule',
    reason: MILESTONE_READ_TOO_LARGE,
    message:
      'these projects need more reads than one request allows, so Qivo cannot show their milestones at once. Choose fewer projects.',
  })

/** A place in a milestone order, just after the milestone with this stored
 * day (`week`), name key (lib/nameKey.ts) and id. */
export type MilestonePosition = { week: string; key: string; id: string }

/** The milestones a read lists are those the app shows (shownDay) on a day
 * in [from, to), where a missing bound is open, in day order ('asc') or
 * newest first ('desc'). With either bound set, a row whose text names no
 * day at all is shown nowhere and left out. */
export type MilestoneSpan = { from?: string; to?: string; order: 'asc' | 'desc' }

/** One batch of a read (readMilestones): its rows in order, the position to
 * go on after, null once no row follows, and the stored day the read reached
 * when its budget ran out first, else null. `past`, when asked, says whether
 * one of the projects holds a milestone shown before the day asked about. */
export type MilestoneBatch = {
  rows: Doc<'milestones'>[]
  next: MilestonePosition | null
  stopped: string | null
  past?: boolean
}

/* Negative when `a` comes before `b` in day order, positive after. */
function compared(a: MilestonePosition, b: MilestonePosition): number {
  for (const field of ['week', 'key', 'id'] as const)
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1
  return 0
}

/* The position of `row`. */
const positionOf = (row: Doc<'milestones'>): MilestonePosition => ({
  week: row.week,
  key: nameKey(row.name),
  id: row.id,
})

/* Whether the app shows stored day `week` inside `span`. */
function inSpan(week: string, span: MilestoneSpan): boolean {
  if (span.from === undefined && span.to === undefined) return true
  const shown = shownDay(week)
  return (
    shown !== null &&
    (span.from === undefined || shown >= span.from) &&
    (span.to === undefined || shown < span.to)
  )
}

/* The stored days a read of `span` after `after` takes from by_project_week:
 * from OVERFLOW_DAYS before its first day, before its end, and from or up to
 * `after`'s day. */
function dayBounds(
  span: MilestoneSpan,
  after: MilestonePosition | null,
): { lower?: string; upper?: { day: string; inclusive: boolean } } {
  let lower = span.from === undefined ? undefined : shiftDay(span.from, -OVERFLOW_DAYS)
  let upper = span.to === undefined ? undefined : { day: span.to, inclusive: false }
  if (after !== null && span.order === 'asc' && (lower === undefined || after.week > lower))
    lower = after.week
  if (after !== null && span.order === 'desc' && (upper === undefined || after.week < upper.day))
    upper = { day: after.week, inclusive: true }
  return { lower, upper }
}

/**
 * The top-level projects whose milestones a read of `ids` lists for the
 * caller, whose active seats are `myProfiles` keyed by organization, each
 * once. A sub-project stands for its top-level project, which stores its
 * milestones (milestoneTarget). Each project is judged with the caller's
 * seat in its own organization, through one lib/access.ts projectLevelsOf a
 * seat, so the caller's grants and team shares in an organization are read
 * once, not once a project. An unknown project, one of an organization the
 * caller holds no seat in, one they cannot see, and an archived one or one
 * under an archived top-level project add nothing and raise nothing, so the
 * answer tells nothing about projects the caller cannot list. A top-level
 * project the caller sees only to reach one of its sub-projects counts, as
 * the app shows its milestones read-only.
 *
 * The check reads within MILESTONE_SCOPE (scopeCeiling). It first asks every
 * project's level without navigation, a few reads a project, and then, one
 * project at a time, whether a top-level project the caller holds no level
 * on shows for navigation, which reads all its sub-projects. Before each of
 * those it looks at the reads so far, and past the ceiling it refuses the
 * whole read (MILESTONE_READ_TOO_LARGE) instead of answering for part of the
 * projects, so the caller can ask for fewer. One navigation check can pass
 * the ceiling by the sub-projects of its project, as any access check of
 * that project reads them.
 */
export async function milestoneProjects(
  ctx: QueryCtx,
  myProfiles: ReadonlyMap<string, Doc<'profiles'>>,
  ids: readonly string[],
): Promise<string[]> {
  const ceiling = scopeCeiling(await ctx.meta.getTransactionMetrics())
  const unique = [...new Set(ids)]
  const named = await Promise.all(unique.map((id) => byId(ctx, 'projects', id)))
  const bySeat = new Map<string, Doc<'projects'>[]>()
  for (const project of named)
    if (project !== null && myProfiles.has(project.org_id))
      bySeat.set(project.org_id, [...(bySeat.get(project.org_id) ?? []), project])
  const roots = new Set<string>()
  // the top-level projects the caller holds no level on, in the order named
  const navigation: { at: number; project: Doc<'projects'>; levels: ProjectLevels }[] = []
  for (const [orgId, projects] of bySeat) {
    const me = myProfiles.get(orgId)
    if (me === undefined) continue
    const levels = projectLevelsOf(ctx, me, projects)
    const found = await Promise.all(
      projects.map(async (project) => {
        if (project.archived_at !== undefined) return null
        if ((await levels.level(project.id, false)) === null) {
          if (project.parent_id === undefined)
            navigation.push({ at: unique.indexOf(project.id), project, levels })
          return null
        }
        // a project the caller can see is top-level or directly under one
        const root =
          project.parent_id === undefined ? project : await levels.project(project.parent_id)
        return root === null || root.archived_at !== undefined ? null : root.id
      }),
    )
    for (const id of found) if (id !== null) roots.add(id)
  }
  for (const { project, levels } of navigation.sort((a, b) => a.at - b.at)) {
    if (!(await readsUnder(ctx, ceiling))) throw readTooLarge()
    if ((await levels.level(project.id)) !== null) roots.add(project.id)
  }
  return [...roots]
}

/* The levels of one seat (lib/access.ts projectLevelsOf). */
type ProjectLevels = ReturnType<typeof projectLevelsOf>

/* Whether one of the projects `projectIds` holds a milestone the app shows
 * before `day`, read newest first until the first, under `guard`. True as
 * well when the guard stops before every project was asked, so a project
 * whose history went unread never reads as one without history. */
async function holdsPast(
  ctx: QueryCtx,
  projectIds: readonly string[],
  day: string,
  guard: CeilingGuard,
): Promise<boolean> {
  for (const projectId of projectIds) {
    if (!(await guard.range())) return true
    const rows = ctx.db
      .query('milestones')
      .withIndex('by_project_week', (q) => q.eq('project_id', projectId).lt('week', day))
      .order('desc')
    for await (const row of rows) {
      if (!(await guard.document())) return true
      const shown = shownDay(row.week)
      if (shown !== null && shown < day) return true
    }
  }
  return false
}

/* One project's range in a read, read a day at a time. */
type Lane = {
  project: string
  /** the open range, once the read began */
  rows: AsyncIterator<Doc<'milestones'>> | null
  /** the first row of the day after the last day read whole */
  peek: Doc<'milestones'> | null
  /** the listed rows of the days read whole, not handed out yet, in order */
  pending: { row: Doc<'milestones'>; at: MilestonePosition }[]
  /** the last position of the last day read whole, null before the first */
  through: MilestonePosition | null
  /** whether the range is read to its end */
  done: boolean
}

/**
 * One batch of the milestones of the top-level projects `projectIds` in
 * `span`, after `after`, that match `search`, at most `limit` of them. The
 * order is stored day, then name key (lib/nameKey.ts), then id, ascending,
 * or descending for span.order 'desc'. Within one project that keeps the
 * app's order by week and then name, and across projects milestones of one
 * week sort by day before name, as REST's project detail sorts them
 * (machine/projects.ts), so the order does not depend on the viewer's
 * weeks. A search matches every whitespace-separated fragment of its name
 * key in the milestone's name key, in any order (lib/search.ts
 * allWordsMatcher), so it ignores case and accents. A blank one lists every
 * milestone.
 *
 * by_project_week orders one project's rows by day and then by creation
 * time, so the read takes one project a day at a time and sorts the rows of
 * each day before it hands any out. Under LIMITS.milestonesPerWeek that is
 * one row, but rows stored before the rule can share a day. It opens one
 * range a project lazily, holds each project's next rows and hands out the
 * first across projects, so a batch without search reads about two rows a
 * project and `limit` more. Each row is placed by the day the app shows it
 * on (shownDay). A read with a first day starts OVERFLOW_DAYS before it and
 * drops rows shown outside the span, so a day that does not exist, such as
 * 2026-02-31, comes in the span the app draws it in, at most OVERFLOW_DAYS
 * out of order, as it sorts by its text.
 *
 * The reads stop once they used MILESTONE_READ's share, counted from the
 * read's own start, so the caller's access checks before it do not spend
 * it, and never past what the request has left. The rows known to be
 * complete are then those up to the frontier, the least
 * advanced position among the projects not read to their end, so the batch
 * answers the matches up to it, `next` at it and `stopped` at its stored
 * day. A continuation then answers nothing again and skips nothing. Each
 * project is first read through a day past `after`, whatever the ceiling,
 * within the request's own limits, so every call moves the frontier on; a
 * read whose projects' first days do not fit there is refused
 * (MILESTONE_READ_TOO_LARGE), and the caller can ask for fewer projects. A
 * full batch answers `next` null only when no row of the span follows, so a
 * search can answer a `next` that leads to an empty last batch. With
 * `pastBefore`, the batch also says whether one of the projects holds a
 * milestone shown before that day, once the projects are open and within
 * the request's own limits, and says true when those ran out first.
 *
 * `after` is a plain position, not a sealed one. Every position a batch
 * answers is a milestone of a project the caller may list, or the frontier
 * between two, and the caller checks access to every project again on each
 * call, so a chosen position only says where to start among the milestones
 * the caller may list.
 */
export async function readMilestones(
  ctx: QueryCtx,
  projectIds: readonly string[],
  o: {
    span: MilestoneSpan
    after: MilestonePosition | null
    search: string
    limit: number
    pastBefore?: string
  },
): Promise<MilestoneBatch> {
  const { span, after } = o
  // whether `a` comes before `b` in the read's order
  const before = (a: MilestonePosition, b: MilestonePosition) =>
    span.order === 'asc' ? compared(a, b) < 0 : compared(a, b) > 0
  const matches = o.search === '' ? null : allWordsMatcher(nameKey(o.search))
  const listed = (row: Doc<'milestones'>, at: MilestonePosition) =>
    (after === null || before(after, at)) &&
    inSpan(row.week, span) &&
    (matches === null || matches(at.key))
  const { lower, upper } = dayBounds(span, after)
  const range = (projectId: string) =>
    ctx.db
      .query('milestones')
      .withIndex('by_project_week', (q) => {
        const own = q.eq('project_id', projectId)
        const low = lower === undefined ? own : own.gte('week', lower)
        if (upper === undefined) return low
        return upper.inclusive ? low.lte('week', upper.day) : low.lt('week', upper.day)
      })
      .order(span.order)
  // the request's own limits less the reserve, and the read's ceiling,
  // MILESTONE_READ past what the transaction read before the read began
  const start = await ctx.meta.getTransactionMetrics()
  const room = roomOf(start, MILESTONE_RESERVE)
  const opening = ceilingGuard(ctx, room)
  const budget = ceilingGuard(ctx, {
    ranges: Math.min(room.ranges, start.databaseQueries.used + MILESTONE_READ.ranges),
    documents: Math.min(room.documents, start.documentsRead.used + MILESTONE_READ.documents),
    bytes: Math.min(room.bytes, start.bytesRead.used + MILESTONE_READ.bytes),
  })

  /* Reads the next day of `lane` whole under `guard` and adds its listed
   * rows to the lane's. False when the guard stops it first, which ends the
   * read, so the rows of a day read in part are dropped. */
  const readDay = async (lane: Lane, guard: CeilingGuard): Promise<boolean> => {
    if (lane.rows === null) {
      if (!(await guard.range())) return false
      lane.rows = range(lane.project)[Symbol.asyncIterator]()
    }
    const rows = lane.rows
    // the next row, null at the range's end, undefined once the guard stops
    const pull = async (): Promise<Doc<'milestones'> | null | undefined> => {
      const step = await rows.next()
      if (step.done === true) return null
      return (await guard.document()) ? step.value : undefined
    }
    let first = lane.peek
    lane.peek = null
    if (first === null) {
      const row = await pull()
      if (row === undefined) return false
      if (row === null) {
        lane.done = true
        return true
      }
      first = row
    }
    const day = [first]
    for (;;) {
      const row = await pull()
      if (row === undefined) return false
      if (row === null) {
        lane.done = true
        break
      }
      if (row.week !== first.week) {
        lane.peek = row
        break
      }
      day.push(row)
    }
    const read = day
      .map((row) => ({ row, at: positionOf(row) }))
      .sort((a, b) => (before(a.at, b.at) ? -1 : 1))
    for (const entry of read) if (listed(entry.row, entry.at)) lane.pending.push(entry)
    lane.through = read[read.length - 1].at
    return true
  }

  // a project named twice is read once
  const projects = [...new Set(projectIds)]
  const lanes: Lane[] = projects.map((project) => ({
    project,
    rows: null,
    peek: null,
    pending: [],
    through: null,
    done: false,
  }))
  const rows: Doc<'milestones'>[] = []
  try {
    // every project through a day past `after`, as a continuation reads the
    // day of `after` again for the milestones after it on that day
    for (const lane of lanes)
      while (
        !lane.done &&
        (lane.through === null || (after !== null && !before(after, lane.through)))
      )
        if (!(await readDay(lane, opening))) throw readTooLarge()
    const past =
      o.pastBefore === undefined ? undefined : await holdsPast(ctx, projects, o.pastBefore, opening)
    const answer = (next: MilestonePosition | null, stopped: string | null): MilestoneBatch => ({
      rows,
      next,
      stopped,
      ...(past === undefined ? {} : { past }),
    })
    for (;;) {
      const last = rows.at(-1)
      if (last !== undefined && rows.length >= o.limit) {
        const more = lanes.some((lane) => lane.pending.length > 0 || !lane.done)
        return answer(more ? positionOf(last) : null, null)
      }
      // the project with the first row to hand out, and of those without
      // one, the one read least far that is not read to its end
      let first: Lane | null = null
      let lag: Lane | null = null
      for (const lane of lanes) {
        const head = lane.pending[0]
        if (head !== undefined) {
          if (first === null || before(head.at, first.pending[0].at)) first = lane
        } else if (
          !lane.done &&
          (lag === null ||
            lane.through === null ||
            (lag.through !== null && before(lane.through, lag.through)))
        )
          lag = lane
      }
      // a row comes before everything the lagging project has not read yet
      const head = first?.pending[0]
      if (first !== null && head !== undefined) {
        if (lag === null || (lag.through !== null && before(head.at, lag.through))) {
          first.pending.shift()
          rows.push(head.row)
          continue
        }
      }
      if (lag === null) return answer(null, null)
      if (!(await readDay(lag, budget))) {
        // every project was read through a day past `after`
        const frontier = lag.through
        if (frontier === null) throw new Error('a stopped read had not opened every project')
        return answer(frontier, frontier.week)
      }
    }
  } finally {
    await Promise.all(lanes.map((lane) => lane.rows?.return?.()))
  }
}

/**
 * The milestone `id` as the Milestones window opens it for the caller,
 * whose active seats are `myProfiles` keyed by organization: the milestone,
 * the project that stores it, and whether the caller may change it, else
 * null. It follows changeableMilestone. The caller's seat in the project's
 * organization sees that project (canSeeProject), and changes the milestone
 * with User access there (assertMilestoneWriter). A milestone of a
 * sub-project, stored there before 2026-10-14, or of an archived project
 * answers null, as the app and REST (machine/projects.ts milestoneOn) leave
 * those out. An unknown milestone and one of a project the caller cannot see
 * answer null alike.
 */
export async function visibleMilestone(
  ctx: QueryCtx,
  myProfiles: ReadonlyMap<string, Doc<'profiles'>>,
  id: string,
): Promise<{
  milestone: Doc<'milestones'>
  project: Doc<'projects'>
  canWrite: boolean
} | null> {
  const milestone = await byId(ctx, 'milestones', id)
  const project = milestone && (await byId(ctx, 'projects', milestone.project_id))
  if (!milestone || !project) return null
  if (project.parent_id !== undefined || project.archived_at !== undefined) return null
  const me = myProfiles.get(project.org_id)
  const level = me === undefined ? null : await projectLevel(ctx, me, project)
  if (level === null) return null
  return { milestone, project, canWrite: levelRank(level) >= levelRank('user') }
}

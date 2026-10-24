/* Nightly maintenance jobs (phase 9) — the pg_cron bodies ported as
 * internalMutations, scheduled from crons.ts (the weekly reap-orphan-files
 * target lives in files.ts and audits itself).
 *
 * Both nightly jobs stay inside the Convex transaction caps (~32k documents
 * scanned, 16 MiB read, 16k documents written and 4,096 index ranges per
 * transaction) however large the deployment grows, and a run reads by index
 * what is due rather than every organization or profile:
 * - The cron calls a dispatcher with no arguments. Each dispatcher step
 *   reads one page and schedules the chains it finds work for, then the
 *   next step.
 * - The archive's dispatcher pages the live projects and asks each one for
 *   a due Done task, one index range that reads at most one task. It
 *   schedules one archive chain for each project that has one. It then
 *   finds the organizations with an active task still flagged
 *   relations_marked, one index range each, and schedules one repair chain
 *   for each. Archived projects and the organizations' other rows cost
 *   nothing, and a live project without a due task costs its own document
 *   and one empty range.
 * - An archive leg reads one page of its project's due Done tasks by index,
 *   at most ARCHIVE_LIMITS.tasks tasks and ARCHIVE_LIMITS.bytes bytes. The
 *   leaf guard reads at most one child per candidate, by index. A leg stops
 *   early once its archiving used ARCHIVE_LIMITS.room of a transaction
 *   limit. A repair leg reads one page of its organization's flagged active
 *   tasks by index.
 * - The read-message sweep keeps a message_sweeps row for each profile whose
 *   retention period may delete one of its read messages, with the time the
 *   oldest of them falls due (model/messages.ts noteSweepable). Its
 *   dispatcher pages the rows that are due and schedules one chain per page
 *   of them, then one chain for the overdue snoozes, which one index range
 *   finds across every profile. A sweep leg deletes, or writes while waking
 *   items, at most SWEEP_LIMITS.rows messages.
 *
 * Convex retries a scheduled mutation after a transient error and drops the
 * calls a failed mutation scheduled. A leg that fails every time therefore
 * stops only its own chain, one project, organization or page of profiles.
 * Its earlier legs stay committed, every other chain runs on, and the next
 * night retries it, because what it left is still due. Failures show in the
 * Convex logs as failed scheduled functions with their arguments.
 *
 * The dispatcher's last step inserts the run's platform_audit_log row
 * (actor 'system') with the number of chains it scheduled. The row records
 * that the run started every chain, not that every chain finished. Each
 * chain logs its own counts with console.info on its last leg when it
 * changed something. Duration is deliberately NOT recorded, because Convex
 * freezes Date.now() at mutation start. */

import { makeFunctionReference, type TransactionMetrics } from 'convex/server'
import { getDocumentSize, type ObjectType, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server'
import { deletionBegun } from './lib/billingAccess'
import { byId } from './lib/db'
import { scheduleMarkClears } from './model/archiveMarks'
import {
  ITEM_UNREAD_CAP,
  lowerSweepDue,
  scheduleArchivedReads,
  wakeSnoozedItem,
} from './model/messages'
import { DEFAULT_ARCHIVE_DAYS, tallyRows } from './model/orgs'
import { messageRetentionDays } from './model/people'
import { emitTaskEvent } from './model/taskEvents'

const DAY = 86_400_000

/** Sizes of one archive step. Tests lower them. */
export const ARCHIVE_LIMITS = {
  /** Live projects per dispatcher step. Each costs one index range for its
   * due check and at most one scheduled chain, inside the 1,000 calls one
   * mutation may schedule. */
  projects: 500,
  /** Organizations with flagged active tasks per dispatcher step, one
   * repair chain each. */
  orgs: 64,
  /** Done candidates per leg, so at most this many task patches. */
  tasks: 500,
  /** Bytes of candidates one leg reads, and again of the children its leaf
   * guard reads. Patching reads each archived task once more, so a leg reads
   * about three times this at most, inside the 16 MiB a transaction may
   * read. The dispatcher reads at most this many bytes of projects a step. */
  bytes: 4 * 1024 * 1024,
  /** Flagged active tasks per repair leg. */
  marked: 1000,
  /** The share of what is left of each of Convex's limits for one
   * transaction, once the leg's reads are done, that its archiving may use
   * before it archives another task. Each task.updated event's subscriber
   * checks (model/taskEvents.ts) show here as reads. */
  room: 0.5,
}

const archiveRunArgs = {
  // 'projects' pages the live projects, 'flagged' the organizations with
  // flagged active tasks. Absent on the cron's call, which starts a run, and
  // on a step queued by the release before, whose cursor paged the
  // organizations. Such a step starts the run again with its `now`.
  phase: v.optional(v.union(v.literal('projects'), v.literal('flagged'))),
  cursor: v.optional(v.string()),
  // the flagged phase's last organization, which the next step starts after
  after: v.optional(v.string()),
  now: v.optional(v.string()),
  projects: v.optional(v.number()),
  repairs: v.optional(v.number()),
  // the running count of a step queued by the release before, unused
  organizations: v.optional(v.number()),
}

const archiveProjectArgs = {
  project_id: v.string(),
  org_id: v.string(),
  now: v.string(),
  cursor: v.optional(v.string()),
  // the page size after a leg split its page, else ARCHIVE_LIMITS.tasks
  size: v.optional(v.number()),
  archived: v.number(),
}

const repairOrgArgs = {
  org_id: v.string(),
  now: v.string(),
  cursor: v.optional(v.string()),
  flagged: v.number(),
}

/* The legs of the release before, one chain per organization. A leg it
 * queued may still arrive after a deploy. */
const archiveOrgArgs = {
  org_id: v.string(),
  now: v.string(),
  phase: v.union(v.literal('archive'), v.literal('repair')),
  cutoff: v.optional(v.string()),
  cursor: v.optional(v.string()),
  size: v.optional(v.number()),
  archived: v.number(),
  flagged: v.number(),
}

type ArchiveLeg = ObjectType<typeof archiveProjectArgs>
type RepairLeg = ObjectType<typeof repairOrgArgs>

const archiveRunRef = makeFunctionReference<'mutation', ObjectType<typeof archiveRunArgs>, null>(
  'jobs:archiveDoneIssues',
)
const archiveProjectRef = makeFunctionReference<'mutation', ArchiveLeg, null>('jobs:archiveProject')
const repairOrgRef = makeFunctionReference<'mutation', RepairLeg, null>('jobs:repairOrg')

/* private.archive_done_issues() (LAST def 0106:218-246), ported field for
 * field. Per issue, all four conditions plus the leaf guard:
 *   - not already archived
 *   - its OWN sub-project is live — "the nightly sweep leaves an archived
 *     project alone: its done tasks are already out of every client's sight,
 *     and archiving them would silently change what a restore brings back"
 *   - status 'done' with done_at at least DEFAULT_ARCHIVE_DAYS old. A
 *     dangling parent drops the row rather than aborting the sweep.
 *   - "leaf-up: never drag an active child along — a done parent waits until
 *     its children have been archived themselves"
 *
 * Semantics pin — SINGLE SNAPSHOT, not fixpoint: the SQL is one UPDATE whose
 * child sub-select reads the pre-statement state, so a child archived in THIS
 * run still counts as unarchived and its done parent goes the NEXT night. A
 * child counts as unarchived when it has no archived_at or carries this
 * run's stamp, in any project of the organization, archived ones included.
 * That holds inside one leg and across legs and chains. No activity rows,
 * because the SQL wrote none.
 *
 * No inbox message either. The sweep never calls notifyIssueUpdate, so
 * followers are not told. Keep it that way, because an Archived notice for
 * every follower of every Done task would only add rows that arrive read.
 * Each leg schedules the background steps that mark the messages already
 * stored about its tasks read, and the tasks' relation rows for the app
 * snapshot (model/messages.ts scheduleArchivedReads), as every archive path
 * does.
 *
 * The repair chains schedule the steps that clear archive marks again for
 * every active task still flagged relations_marked (model/archiveMarks.ts).
 * A restore schedules them itself, so this only repairs a step that failed.
 * Each flagged task is scheduled once per run, and a step skips a task it
 * finds cleared or archived again, so the order of an organization's
 * archive and repair chains does not matter. */

/* The run's threshold. A Done task with done_at at or before it is due. */
const archiveCutoff = (now: string): string =>
  new Date(Date.parse(now) - DEFAULT_ARCHIVE_DAYS * DAY).toISOString()

/* The project's due Done tasks, oldest done first: not archived, status
 * 'done' and done_at at or before `cutoff`. A Done task without done_at is
 * never taken. */
const dueTasks = (ctx: QueryCtx, projectId: string, cutoff: string) =>
  ctx.db
    .query('issues')
    .withIndex('by_project_archived_status_done', (q) =>
      q
        .eq('project_id', projectId)
        .eq('archived_at', undefined)
        .eq('status', 'done')
        .gt('done_at', undefined)
        .lte('done_at', cutoff),
    )

/* An organization's active tasks still flagged relations_marked. */
const flaggedTasks = (ctx: QueryCtx, orgId: string) =>
  ctx.db
    .query('issues')
    .withIndex('by_archived_marked_org', (q) =>
      q.eq('archived_at', undefined).eq('relations_marked', true).eq('org_id', orgId),
    )

/* A child of the task that counts as unarchived for this run, one without
 * archived_at or one this run archived (`now`), or null. Two index reads of
 * at most one document each, however many children the task has. */
async function unarchivedChild(
  ctx: MutationCtx,
  parentId: string,
  now: string,
): Promise<Doc<'issues'> | null> {
  for (const archivedAt of [undefined, now]) {
    const child = await ctx.db
      .query('issues')
      .withIndex('by_parent_archived', (q) =>
        q.eq('parent_id', parentId).eq('archived_at', archivedAt),
      )
      .first()
    if (child !== null) return child
  }
  return null
}

/* Ends a chain and logs its counts when it changed something. Chains with
 * nothing to do log nothing, so idle ones stay out of the logs. */
function finishChain(a: { org_id: string; now: string; archived: number; flagged: number }): null {
  if (a.archived + a.flagged > 0) {
    console.info('Auto-archive finished', {
      org_id: a.org_id,
      archived: a.archived,
      flagged: a.flagged,
      now: a.now,
    })
  }
  return null
}

/* Whether the project still takes the run's archive: it exists in the
 * chain's organization, is live, and its root resolves. A dangling parent
 * drops the project, as the SQL inner join dropped its rows. */
async function archivesInto(ctx: MutationCtx, a: ArchiveLeg): Promise<boolean> {
  const project = await byId(ctx, 'projects', a.project_id)
  if (project === null || project.org_id !== a.org_id || project.archived_at !== undefined) {
    return false
  }
  return (
    project.parent_id === undefined || (await byId(ctx, 'projects', project.parent_id)) !== null
  )
}

/* One archive leg. It reads one page of the project's due Done tasks, keeps
 * those that pass the leaf guard, and archives them. Every read happens
 * before the first patch. Once a leg completes, the candidates the guard
 * kept lie behind the cursor and are not read again this run, which is
 * right because only this run's own stamps could change their answer. A
 * child can be as large as its parent, so when the children the guard read
 * pass ARCHIVE_LIMITS.bytes, the leg writes nothing and the next leg reads
 * the same page at half the size. Each archived task sends a task.updated
 * event, whose subscriber checks cost reads. So before each task after its
 * first, a leg stops once its archiving has used ARCHIVE_LIMITS.room of
 * what was left of any transaction limit, and the next leg reads the same
 * page again, without the tasks archived here, which have left its range.
 * Returns the next leg, or null when the chain is done. */
async function archiveLeg(ctx: MutationCtx, a: ArchiveLeg): Promise<ArchiveLeg | null> {
  if (!(await archivesInto(ctx, a))) return finishChain({ ...a, flagged: 0 })
  const page = await dueTasks(ctx, a.project_id, archiveCutoff(a.now)).paginate({
    cursor: a.cursor ?? null,
    numItems: a.size ?? ARCHIVE_LIMITS.tasks,
    maximumBytesRead: ARCHIVE_LIMITS.bytes,
  })
  const batch: Doc<'issues'>[] = []
  let childBytes = 0
  for (const task of page.page) {
    const child = await unarchivedChild(ctx, task.id, a.now)
    if (child === null) {
      batch.push(task)
      continue
    }
    childBytes += getDocumentSize(child)
    // One candidate and one child always fit, so a page of one never splits.
    if (childBytes > ARCHIVE_LIMITS.bytes && page.page.length > 1) {
      return { ...a, size: Math.ceil(page.page.length / 2) }
    }
  }

  // A leg always archives one task, so the chain moves on.
  const before = await ctx.meta.getTransactionMetrics()
  const patched: Doc<'issues'>[] = []
  let full = false
  for (const task of batch) {
    if (patched.length > 0 && (await legIsFull(ctx, before))) {
      full = true
      break
    }
    await ctx.db.patch(task._id, { archived_at: a.now })
    await emitTaskEvent(ctx, {
      name: 'task.updated',
      issue: { ...task, archived_at: a.now },
      before: task,
      now: a.now,
    })
    patched.push(task)
  }
  if (patched.length > 0) {
    await tallyRows(
      ctx,
      'issues',
      patched.map((task) => [task, { ...task, archived_at: a.now }] as const),
    )
    await scheduleArchivedReads(ctx, { issues: patched.map((task) => task.id) })
  }
  const archived = a.archived + patched.length
  // The same page again. The tasks archived here have left its range.
  if (full) return { ...a, archived }
  if (page.isDone) return finishChain({ ...a, archived, flagged: 0 })
  return { ...a, cursor: page.continueCursor, size: undefined, archived }
}

/* Whether the leg's archiving has used more than ARCHIVE_LIMITS.room of what
 * was left of any of Convex's limits when it began (`before`). The leg's
 * reads before that do not count, so a heavy page still archives more than
 * one task. */
async function legIsFull(ctx: MutationCtx, before: TransactionMetrics): Promise<boolean> {
  const now = await ctx.meta.getTransactionMetrics()
  return (Object.keys(now) as Array<keyof TransactionMetrics>).some(
    (key) => now[key].used - before[key].used > before[key].remaining * ARCHIVE_LIMITS.room,
  )
}

/* One repair leg. It schedules the clear steps for one page of the
 * organization's active tasks still flagged relations_marked. Returns the
 * next leg, or null when the chain is done. */
async function repairLeg(ctx: MutationCtx, a: RepairLeg): Promise<RepairLeg | null> {
  const page = await flaggedTasks(ctx, a.org_id).paginate({
    cursor: a.cursor ?? null,
    numItems: ARCHIVE_LIMITS.marked,
    maximumBytesRead: ARCHIVE_LIMITS.bytes,
  })
  await scheduleMarkClears(ctx, page.page)
  const flagged = a.flagged + page.page.length
  if (page.isDone) return finishChain({ ...a, archived: 0, flagged })
  return { ...a, cursor: page.continueCursor, flagged }
}

/* Whether a chain of the organization ends before its first read: the
 * organization was deleted since the dispatcher read its rows, or its
 * deletion has begun (lib/billingAccess.ts deletionBegun), because its
 * deletion steps are removing the tasks a leg would change. The read-only
 * period before deletion begins still archives and repairs. A deleted
 * organization ends its chain without a log. */
async function chainEnds(ctx: MutationCtx, orgId: string): Promise<'gone' | 'deleting' | null> {
  if ((await byId(ctx, 'organizations', orgId)) === null) return 'gone'
  return (await deletionBegun(ctx, orgId)) ? 'deleting' : null
}

/** The nightly archive, one dispatcher step per call. The cron starts a run
 * with no arguments. The projects phase pages the live projects,
 * ARCHIVE_LIMITS.projects a step, and schedules one archiveProject chain
 * for each with a due Done task. The flagged phase then walks the
 * organizations with an active task still flagged relations_marked, in
 * org_id order and ARCHIVE_LIMITS.orgs a step, and schedules one repair
 * chain for each. Each step schedules the next with the running counts.
 * The last step writes the run's audit row with the number of projects and
 * repairs. `now` is the run's stamp and clock, shared by every chain. */
export const archiveDoneIssues = internalMutation({
  args: archiveRunArgs,
  handler: async (ctx, a): Promise<null> => {
    const now = a.now ?? new Date().toISOString()
    let projects = a.projects ?? 0
    let repairs = a.repairs ?? 0
    if (a.phase !== 'flagged') {
      const cutoff = archiveCutoff(now)
      const page = await ctx.db
        .query('projects')
        .withIndex('by_archived_org', (q) => q.eq('archived_at', undefined))
        .paginate({
          cursor: a.phase === 'projects' ? (a.cursor ?? null) : null,
          numItems: ARCHIVE_LIMITS.projects,
          maximumBytesRead: ARCHIVE_LIMITS.bytes,
        })
      for (const project of page.page) {
        if ((await dueTasks(ctx, project.id, cutoff).first()) === null) continue
        await ctx.scheduler.runAfter(0, archiveProjectRef, {
          project_id: project.id,
          org_id: project.org_id,
          now,
          archived: 0,
        })
        projects += 1
      }
      if (!page.isDone) {
        await ctx.scheduler.runAfter(0, archiveRunRef, {
          phase: 'projects',
          cursor: page.continueCursor,
          now,
          projects,
        })
        return null
      }
    }

    // One range per organization: the first flagged task after the last one.
    let after = a.phase === 'flagged' ? a.after : undefined
    for (let n = 0; n < ARCHIVE_LIMITS.orgs; n++) {
      const from = after
      const task = await ctx.db
        .query('issues')
        .withIndex('by_archived_marked_org', (q) => {
          const flagged = q.eq('archived_at', undefined).eq('relations_marked', true)
          return from === undefined ? flagged : flagged.gt('org_id', from)
        })
        .first()
      if (task === null) {
        await ctx.db.insert('platform_audit_log', {
          ts: now,
          actor_email: 'system',
          action: 'archive_done_issues',
          detail: { projects, repairs },
        })
        return null
      }
      after = task.org_id
      await ctx.scheduler.runAfter(0, repairOrgRef, { org_id: after, now, flagged: 0 })
      repairs += 1
    }
    await ctx.scheduler.runAfter(0, archiveRunRef, {
      phase: 'flagged',
      after,
      now,
      projects,
      repairs,
    })
    return null
  },
})

/** One leg of a project's nightly archive chain. It pages through the
 * project's due Done tasks, each leg scheduling the next with the running
 * count, and the last leg logs it. A project archived, deleted or left
 * without its root since the dispatcher read it ends the chain, and so does
 * its organization's deletion (chainEnds). */
export const archiveProject = internalMutation({
  args: archiveProjectArgs,
  handler: async (ctx, a): Promise<null> => {
    const ends = await chainEnds(ctx, a.org_id)
    if (ends === 'gone') return null
    if (ends === 'deleting') return finishChain({ ...a, flagged: 0 })
    const next = await archiveLeg(ctx, a)
    if (next !== null) await ctx.scheduler.runAfter(0, archiveProjectRef, next)
    return null
  },
})

/** One leg of an organization's nightly repair chain. It pages through the
 * organization's active tasks still flagged relations_marked, each leg
 * scheduling the next with the running count, and the last leg logs it.
 * The organization's deletion ends the chain (chainEnds). */
export const repairOrg = internalMutation({
  args: repairOrgArgs,
  handler: async (ctx, a): Promise<null> => {
    const ends = await chainEnds(ctx, a.org_id)
    if (ends === 'gone') return null
    if (ends === 'deleting') return finishChain({ ...a, archived: 0 })
    const next = await repairLeg(ctx, a)
    if (next !== null) await ctx.scheduler.runAfter(0, repairOrgRef, next)
    return null
  },
})

/** A leg the release before queued, one chain per organization, whose
 * cursor paged indexes this release no longer has. It does nothing. A
 * dispatcher step of that release starts the run again, which schedules
 * the chains this one would have run, and the next night's run covers it
 * otherwise, because what it left is still due. */
export const archiveOrg = internalMutation({
  args: archiveOrgArgs,
  handler: async (): Promise<null> => null,
})

/** Sizes of one read-message sweep step. Tests lower them. */
export const SWEEP_LIMITS = {
  /** Profiles per dispatcher page, and the most one leg visits. */
  profiles: 100,
  /** Messages one leg deletes, or writes while waking items, at most. A
   * larger backlog continues in the next leg of the same chain. It must be
   * at least WAKE_ROWS, or a leg could never wake an item. */
  rows: 500,
}

/* The most rows one wake writes (model/messages.ts wakeSnoozedItem), a full
 * item. A leg wakes another item only while this much budget is left. An
 * item that grew past the cap before it existed can write more, a legacy
 * case decided separately, and the leg then ends over its budget. */
const WAKE_ROWS = ITEM_UNREAD_CAP + 1

const sweepRunArgs = {
  // 'seed' gives every profile with a retention period a due
  // message_sweeps row, 'due' pages the rows that are due. Absent on the
  // cron's call, which starts a run, and on a step queued by the release
  // before, whose cursor paged the profiles. Such a step starts the run
  // again with its `now`.
  phase: v.optional(v.union(v.literal('seed'), v.literal('due'))),
  cursor: v.optional(v.string()),
  now: v.optional(v.string()),
  pages: v.optional(v.number()),
}

const sweepDueArgs = {
  profiles: v.array(v.string()),
  now: v.string(),
  deleted: v.number(),
}

const wakeSnoozesArgs = {
  now: v.string(),
  woken: v.number(),
}

/* The legs of the release before, one chain per id range of profiles. A
 * leg it queued may still arrive after a deploy. */
const sweepProfilesArgs = {
  from: v.string(),
  to: v.string(),
  now: v.string(),
  deleted: v.number(),
  woken: v.number(),
}

const sweepRunRef = makeFunctionReference<'mutation', ObjectType<typeof sweepRunArgs>, null>(
  'jobs:sweepReadMessages',
)
const sweepDueRef = makeFunctionReference<'mutation', ObjectType<typeof sweepDueArgs>, null>(
  'jobs:sweepDueProfiles',
)
const wakeSnoozesRef = makeFunctionReference<'mutation', ObjectType<typeof wakeSnoozesArgs>, null>(
  'jobs:wakeSnoozes',
)

/* The snoozed rows whose instant has passed by `now`, across every
 * profile. Each one lost its scheduled wake somewhere. */
const overdueSnoozes = (ctx: QueryCtx, now: string) =>
  ctx.db
    .query('messages')
    .withIndex('by_snoozed', (q) => q.gt('snoozed_until', undefined).lte('snoozed_until', now))

/* Whether a run of the sweep has finished the seed phase
 * (message_sweep_seeds). Until one has, messages read before message_sweeps
 * existed may have no sweep row, so a run seeds first. */
const sweepSeeded = async (ctx: QueryCtx): Promise<boolean> =>
  (await ctx.db.query('message_sweep_seeds').first()) !== null

/* One profile's share of a sweep leg, at most `budget` deletions. It deletes
 * READ rows read before the profile's retention period (model/people.ts
 * messageRetentionDays), measured from read_at and never created_at, so an
 * UNREAD message is never swept however old it is. Nothing here decides
 * that news stopped mattering because it went unanswered. A snoozed row is
 * a pending reminder and is never swept, however long ago it was read. The
 * read is an index range, so a long unread backlog costs nothing here.
 * Then it moves the profile's message_sweeps row to when its oldest read
 * row left falls due, or deletes the row when none is left, the profile is
 * gone or it keeps read messages. A message whose recipient row is gone is
 * not swept (the SQL's join); teardown removes those with the profile.
 * `more` says rows remain for the next leg, which visits the profile again. */
async function sweepProfile(
  ctx: MutationCtx,
  profileId: string,
  now: string,
  budget: number,
): Promise<{ deleted: number; more: boolean }> {
  const row = await ctx.db
    .query('message_sweeps')
    .withIndex('by_profile', (q) => q.eq('profile_id', profileId))
    .first()
  const p = await byId(ctx, 'profiles', profileId)
  const days = p === null ? null : messageRetentionDays(p)
  const read = () =>
    ctx.db
      .query('messages')
      .withIndex('by_recipient_read', (q) =>
        q.eq('recipient_id', profileId).gt('read_at', undefined),
      )
      .filter((q) => q.eq(q.field('snoozed_until'), undefined))
  let deleted = 0
  let due: string | null = null
  if (days !== null) {
    const cutoff = new Date(Date.parse(now) - days * DAY).toISOString()
    const expired = await ctx.db
      .query('messages')
      .withIndex('by_recipient_read', (q) =>
        q.eq('recipient_id', profileId).gt('read_at', undefined).lte('read_at', cutoff),
      )
      .filter((q) => q.eq(q.field('snoozed_until'), undefined))
      .take(budget + 1)
    for (const m of expired.slice(0, budget)) {
      await ctx.db.delete(m._id)
      deleted += 1
    }
    if (expired.length > budget) return { deleted, more: true }
    const oldest = await read().first()
    if (oldest?.read_at !== undefined) {
      due = new Date(Date.parse(oldest.read_at) + days * DAY).toISOString()
    }
  }
  if (due === null) {
    if (row !== null) await ctx.db.delete(row._id)
  } else if (row === null) {
    await ctx.db.insert('message_sweeps', { profile_id: profileId, due_at: due })
  } else if (row.due_at !== due) {
    await ctx.db.patch(row._id, { due_at: due })
  }
  return { deleted, more: false }
}

/** private.sweep_read_messages(null) (0110:88-102), one dispatcher step per
 * call. The cron starts a run with no arguments. Until a run has seeded
 * (sweepSeeded), the seed phase pages every profile, SWEEP_LIMITS.profiles
 * a step, and gives each with a retention period a message_sweeps row due
 * now, so the messages read before the table existed are swept that night.
 * Its last step records the seed (message_sweep_seeds). The due phase pages
 * the message_sweeps rows due by `now` and schedules one sweepDueProfiles
 * chain per page. The last step schedules one wakeSnoozes chain when a
 * snooze is overdue and writes the run's audit row with the number of
 * pages and whether it woke. `now` is the run's clock, shared by every
 * chain. The boot-time
 * sweep_my_read_messages twin is CUT; this nightly job is the one
 * implementation. A profile without a retention period keeps its read
 * messages when it is a person (Never) and keeps them for
 * DEFAULT_MESSAGE_RETENTION_DAYS when it is an agent, which has no settings
 * page. */
export const sweepReadMessages = internalMutation({
  args: sweepRunArgs,
  handler: async (ctx, a): Promise<null> => {
    const now = a.now ?? new Date().toISOString()
    const phase = a.phase ?? ((await sweepSeeded(ctx)) ? 'due' : 'seed')
    const cursor = a.phase === undefined ? null : (a.cursor ?? null)
    if (phase === 'seed') {
      const profiles = await ctx.db
        .query('profiles')
        .withIndex('by_uuid')
        .paginate({ cursor, numItems: SWEEP_LIMITS.profiles })
      for (const p of profiles.page) {
        if (messageRetentionDays(p) !== null) await lowerSweepDue(ctx, p.id, now)
      }
      if (profiles.isDone && !(await sweepSeeded(ctx))) {
        await ctx.db.insert('message_sweep_seeds', { seeded_at: now })
      }
      await ctx.scheduler.runAfter(0, sweepRunRef, {
        phase: profiles.isDone ? 'due' : 'seed',
        cursor: profiles.isDone ? undefined : profiles.continueCursor,
        now,
      })
      return null
    }

    const due = await ctx.db
      .query('message_sweeps')
      .withIndex('by_due', (q) => q.lte('due_at', now))
      .paginate({ cursor, numItems: SWEEP_LIMITS.profiles })
    let pages = a.phase === undefined ? 0 : (a.pages ?? 0)
    if (due.page.length > 0) {
      await ctx.scheduler.runAfter(0, sweepDueRef, {
        profiles: due.page.map((row) => row.profile_id),
        now,
        deleted: 0,
      })
      pages += 1
    }
    if (!due.isDone) {
      await ctx.scheduler.runAfter(0, sweepRunRef, {
        phase: 'due',
        cursor: due.continueCursor,
        now,
        pages,
      })
      return null
    }

    const wake = (await overdueSnoozes(ctx, now).first()) !== null
    if (wake) await ctx.scheduler.runAfter(0, wakeSnoozesRef, { now, woken: 0 })
    await ctx.db.insert('platform_audit_log', {
      ts: now,
      actor_email: 'system',
      action: 'sweep_read_messages',
      detail: { pages, wake },
    })
    return null
  },
})

/** One leg of a page's read-message sweep. It visits the profiles
 * `profiles`, in order, at most SWEEP_LIMITS.rows deletions, and schedules
 * the next leg with the profiles left and the running count, staying on a
 * profile while it has rows left. The last leg logs the count when it
 * deleted something, with `to`, the page's last profile, naming the page. */
export const sweepDueProfiles = internalMutation({
  args: sweepDueArgs,
  handler: async (ctx, a): Promise<null> => {
    let { deleted } = a
    let budget = SWEEP_LIMITS.rows
    let rest: string[] = []
    for (const [i, id] of a.profiles.entries()) {
      if (budget <= 0) {
        rest = a.profiles.slice(i)
        break
      }
      const leg = await sweepProfile(ctx, id, a.now, budget)
      deleted += leg.deleted
      budget -= leg.deleted
      if (leg.more) {
        rest = a.profiles.slice(i)
        break
      }
    }
    if (rest.length > 0) {
      await ctx.scheduler.runAfter(0, sweepDueRef, { ...a, profiles: rest, deleted })
      return null
    }
    if (deleted > 0) {
      console.info('Read-message sweep finished', { to: a.profiles.at(-1), deleted, woken: 0 })
    }
    return null
  },
})

/** One leg of the run's snooze fallback. It reads the overdue snoozed rows
 * by index, at most SWEEP_LIMITS.rows and a row more, and wakes their items
 * (model/messages.ts wakeSnoozedItem). A wake writes every row of its item,
 * so it starts only while WAKE_ROWS of the leg's SWEEP_LIMITS.rows are
 * left. A woken item leaves the range, so the next leg, scheduled while
 * rows remain, reads the rest. The last leg logs how many items woke. */
export const wakeSnoozes = internalMutation({
  args: wakeSnoozesArgs,
  handler: async (ctx, a): Promise<null> => {
    const budget = SWEEP_LIMITS.rows
    const overdue = await overdueSnoozes(ctx, a.now).take(budget + 1)
    const items = new Map(
      overdue.map((m) => [
        JSON.stringify([m.recipient_id, m.issue_id]),
        { recipient_id: m.recipient_id, issue_id: m.issue_id },
      ]),
    )
    let { woken } = a
    let used = 0
    let more = overdue.length > budget
    for (const item of items.values()) {
      if (budget - used < WAKE_ROWS) {
        more = true
        break
      }
      const written = await wakeSnoozedItem(ctx, item, a.now)
      if (written > 0) woken += 1
      used += written
    }
    if (more) {
      await ctx.scheduler.runAfter(0, wakeSnoozesRef, { now: a.now, woken })
      return null
    }
    if (woken > 0) console.info('Read-message sweep finished', { deleted: 0, woken })
    return null
  },
})

/** A leg the release before queued, one chain per id range of profiles. It
 * does nothing. A dispatcher step of that release starts the run again, and
 * the next night's run covers these profiles otherwise: until a run has
 * seeded, each run gives every profile with a retention period a due
 * message_sweeps row. */
export const sweepProfiles = internalMutation({
  args: sweepProfilesArgs,
  handler: async (): Promise<null> => null,
})

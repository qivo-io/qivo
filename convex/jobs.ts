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
 * - The archive's dispatcher first finds the organizations with an active
 *   task still flagged relations_marked, one index range each, and
 *   schedules one repair chain for each. It then pages the live projects
 *   and asks each one for a due Done task, one index range that reads at
 *   most one task, and stops a step once those tasks pass
 *   ARCHIVE_LIMITS.bytes. It schedules one archive chain for each
 *   organization with due projects, which archives them one after another,
 *   so its legs never write the organization's counters at the same time.
 *   Archived projects and the organizations' other rows cost nothing, and a
 *   live project without a due task costs its own document and one empty
 *   range.
 * - An archive leg reads one page of one project's due Done tasks by index,
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
 *   items, at most SWEEP_LIMITS.rows messages. Every 28th night the run
 *   starts with a full pass over every profile (SWEEP_FULL_AFTER_MS), which
 *   adds or lowers a row that a backup restore, a rollback or a write
 *   without noteSweepable left missing or late. It costs one step per
 *   SWEEP_LIMITS.profiles profiles. A step reads those profiles and, by
 *   index, the oldest read, unsnoozed message of each with a retention
 *   period and its sweep row when there is one. It writes only the rows it
 *   repairs.
 *
 * Convex retries a scheduled mutation after a transient error and drops the
 * calls a failed mutation scheduled. A leg that fails every time therefore
 * stops only its own chain, one organization or page of profiles.
 * Its earlier legs stay committed, every other chain runs on, and the next
 * night retries it, because what it left is still due. Failures show in the
 * Convex logs as failed scheduled functions with their arguments.
 *
 * The dispatcher's last step inserts the run's platform_audit_log row
 * (actor 'system') with the number of chains it scheduled, or for the
 * archive the number of due projects and repair chains. The row records
 * that the run started every chain, not that every chain finished. Each
 * chain logs its own counts with console.info on its last leg when it
 * changed something, and an archive chain logs each project's count when it
 * is done with the project. Duration is deliberately NOT recorded, because
 * Convex freezes Date.now() at mutation start. */

import { makeFunctionReference, type TransactionMetrics } from 'convex/server'
import { getDocumentSize, type ObjectType, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server'
import { deletionBegun } from './lib/billingAccess'
import { byId } from './lib/db'
import { audit } from './model/admin'
import { scheduleMarkClears } from './model/archiveMarks'
import { itemEdits } from './model/inboxItems'
import {
  ITEM_UNREAD_CAP,
  lowerSweepDue,
  scheduleArchivedReads,
  wakeSnoozedItem,
} from './model/messages'
import { DEFAULT_ARCHIVE_DAYS, tallyRow } from './model/orgs'
import { messageRetentionDays } from './model/people'
import { emitTaskEvent } from './model/taskEvents'

const DAY = 86_400_000

/** Sizes of one archive step. Tests lower them. */
export const ARCHIVE_LIMITS = {
  /** Live projects per dispatcher step. Each costs one index range for its
   * due check and at most one scheduled chain, inside the 1,000 calls one
   * mutation may schedule. Also the most due projects one archive chain
   * takes, so an organization with more due projects in one night gets
   * more than one chain. */
  projects: 500,
  /** Organizations with flagged active tasks per dispatcher step, one
   * repair chain each. */
  orgs: 64,
  /** Done candidates per leg, so at most this many task patches. */
  tasks: 500,
  /** Bytes of candidates one leg reads, and again of the children its leaf
   * guard reads. Patching reads each archived task once more, so a leg reads
   * about three times this at most, inside the 16 MiB a transaction may
   * read. A dispatcher step reads at most this many bytes of projects, and
   * this many and one task more of the tasks its checks read. */
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
  // 'flagged' walks the organizations with flagged active tasks, then
  // 'projects' pages the live projects. Absent on the cron's call, which
  // starts a run with the flagged phase, and on a step queued by the release
  // before, whose cursor paged the organizations. Such a step starts the run
  // again with its `now`.
  phase: v.optional(v.union(v.literal('projects'), v.literal('flagged'))),
  cursor: v.optional(v.string()),
  // the projects of the page before that its step left unchecked, in index
  // order, which this step checks instead of reading a page
  left: v.optional(v.array(v.string())),
  // the due projects found so far of the organization the step before ended
  // in, not yet handed to a chain
  due: v.optional(v.object({ org_id: v.string(), projects: v.array(v.string()) })),
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
  // the tasks the chain archived in this project
  archived: v.number(),
  // the organization's other due projects, which the chain archives after
  // this one, in turn
  next: v.optional(v.array(v.string())),
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

type ArchiveRun = ObjectType<typeof archiveRunArgs>
type ArchiveLeg = ObjectType<typeof archiveProjectArgs>
type RepairLeg = ObjectType<typeof repairOrgArgs>

const archiveRunRef = makeFunctionReference<'mutation', ArchiveRun, null>('jobs:archiveDoneIssues')
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

/* Logs a chain's counts when it changed something, an archive chain's for
 * the project (`project_id`) it is done with. Chains with nothing to do log
 * nothing, so idle ones stay out of the logs. */
function finishChain(a: {
  org_id: string
  project_id?: string
  now: string
  archived: number
  flagged: number
}): null {
  if (a.archived + a.flagged > 0) {
    console.info('Auto-archive finished', {
      org_id: a.org_id,
      ...(a.project_id !== undefined ? { project_id: a.project_id } : {}),
      archived: a.archived,
      flagged: a.flagged,
      now: a.now,
    })
  }
  return null
}

/* Logs what the chain archived in its project, and returns the first leg of
 * the organization's next due project, or null when the chain is done. */
function nextProject(a: ArchiveLeg): ArchiveLeg | null {
  finishChain({ ...a, flagged: 0 })
  const [project_id, ...next] = a.next ?? []
  if (project_id === undefined) return null
  return { project_id, org_id: a.org_id, now: a.now, archived: 0, next }
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
 * Once the project is done, or no longer takes the run's archive, the next
 * leg starts the organization's next due project. Returns the next leg, or
 * null when the chain is done. */
async function archiveLeg(ctx: MutationCtx, a: ArchiveLeg): Promise<ArchiveLeg | null> {
  if (!(await archivesInto(ctx, a))) return nextProject(a)
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
    // within the leg's measure, as each task's labels move their counts
    await tallyRow(ctx, 'issues', task, { ...task, archived_at: a.now })
    patched.push(task)
  }
  if (patched.length > 0)
    await scheduleArchivedReads(ctx, { issues: patched.map((task) => task.id) })
  const archived = a.archived + patched.length
  // The same page again. The tasks archived here have left its range.
  if (full) return { ...a, archived }
  if (page.isDone) return nextProject({ ...a, archived })
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

/* A dispatcher step's arguments with the run's `now` fixed. */
type RunStep = ArchiveRun & { now: string }

/** The nightly archive, one dispatcher step per call. The cron starts a run
 * with no arguments. The flagged phase walks the organizations with an
 * active task still flagged relations_marked (flaggedStep), then the
 * projects phase pages the live projects (projectsStep). Each step
 * schedules the next with the running counts. The last step writes the
 * run's audit row with the number of due projects and repair chains. `now`
 * is the run's stamp and clock, shared by every chain. */
export const archiveDoneIssues = internalMutation({
  args: archiveRunArgs,
  handler: async (ctx, a): Promise<null> => {
    const run = { ...a, now: a.now ?? new Date().toISOString() }
    if (run.phase === 'projects') await projectsStep(ctx, run)
    else await flaggedStep(ctx, run)
    return null
  },
})

/* One step of the flagged phase. It schedules one repair chain for each
 * organization with an active task still flagged relations_marked, in
 * org_id order, one index range each, at most ARCHIVE_LIMITS.orgs and until
 * the tasks it read pass ARCHIVE_LIMITS.bytes. The phase's last step
 * schedules the projects phase as a step of its own, so a projects step
 * that fails cannot drop these chains. */
async function flaggedStep(ctx: MutationCtx, a: RunStep): Promise<void> {
  let repairs = a.repairs ?? 0
  let after = a.phase === 'flagged' ? a.after : undefined
  let bytes = 0
  for (let n = 0; n < ARCHIVE_LIMITS.orgs && bytes < ARCHIVE_LIMITS.bytes; n++) {
    const from = after
    // the first flagged task after the last organization
    const task = await ctx.db
      .query('issues')
      .withIndex('by_archived_marked_org', (q) => {
        const flagged = q.eq('archived_at', undefined).eq('relations_marked', true)
        return from === undefined ? flagged : flagged.gt('org_id', from)
      })
      .first()
    if (task === null) {
      await ctx.scheduler.runAfter(0, archiveRunRef, { phase: 'projects', now: a.now, repairs })
      return
    }
    bytes += getDocumentSize(task)
    after = task.org_id
    await ctx.scheduler.runAfter(0, repairOrgRef, { org_id: after, now: a.now, flagged: 0 })
    repairs += 1
  }
  await ctx.scheduler.runAfter(0, archiveRunRef, { phase: 'flagged', after, now: a.now, repairs })
}

/* One step of the projects phase. It checks the projects the step before
 * left unchecked, or else reads a page of live projects, at most
 * ARCHIVE_LIMITS.projects and ARCHIVE_LIMITS.bytes. It asks each project for
 * a due Done task and stops once the tasks it read pass
 * ARCHIVE_LIMITS.bytes, which one project always fits. The next step then
 * checks the rest of the page. An organization's projects lie together in
 * the index, so the step gathers the organization's due projects, also
 * across steps, and hands them to one chain once it passes them, or once
 * they reach ARCHIVE_LIMITS.projects. The phase's last step writes the
 * run's audit row. */
async function projectsStep(ctx: MutationCtx, a: RunStep): Promise<void> {
  const cutoff = archiveCutoff(a.now)
  let projects = a.projects ?? 0
  let due = a.due && { org_id: a.due.org_id, projects: [...a.due.projects] }
  // starts one chain for the due projects gathered, never an empty list
  const hand = async () => {
    if (due !== undefined) {
      const [project_id, ...next] = due.projects
      await ctx.scheduler.runAfter(0, archiveProjectRef, {
        project_id,
        org_id: due.org_id,
        now: a.now,
        archived: 0,
        next,
      })
    }
    due = undefined
  }

  let ids: string[]
  let cursor: string
  let isDone = false
  if (a.left !== undefined && a.cursor !== undefined) {
    ids = a.left
    cursor = a.cursor
  } else {
    const page = await ctx.db
      .query('projects')
      .withIndex('by_archived_org', (q) => q.eq('archived_at', undefined))
      .paginate({
        cursor: a.cursor ?? null,
        numItems: ARCHIVE_LIMITS.projects,
        maximumBytesRead: ARCHIVE_LIMITS.bytes,
      })
    ids = page.page.map((project) => project.id)
    cursor = page.continueCursor
    isDone = page.isDone
  }
  const step = { phase: 'projects' as const, cursor, now: a.now, repairs: a.repairs }
  let bytes = 0
  for (const [i, id] of ids.entries()) {
    if (bytes >= ARCHIVE_LIMITS.bytes) {
      await ctx.scheduler.runAfter(0, archiveRunRef, { ...step, left: ids.slice(i), due, projects })
      return
    }
    const task = await dueTasks(ctx, id, cutoff).first()
    if (task === null) continue
    bytes += getDocumentSize(task)
    projects += 1
    if (due?.org_id !== task.org_id || due.projects.length >= ARCHIVE_LIMITS.projects) {
      await hand()
      due = { org_id: task.org_id, projects: [] }
    }
    due.projects.push(id)
  }
  if (!isDone) {
    await ctx.scheduler.runAfter(0, archiveRunRef, { ...step, due, projects })
    return
  }
  await hand()
  await audit(ctx, {
    ts: a.now,
    actor_email: 'system',
    action: 'archive_done_issues',
    detail: { projects, repairs: a.repairs ?? 0 },
  })
}

/** One leg of an organization's nightly archive chain. The chain pages
 * through the due Done tasks of each of the organization's due projects in
 * turn (`project_id`, then `next`), each leg scheduling the next with the
 * project's running count, and logs each project's count when it is done
 * with the project. A project archived, deleted or left without its root
 * since the dispatcher read it is skipped. The organization's deletion ends
 * the chain (chainEnds). */
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
  // 'seed' is the full pass, which pages every profile, 'due' pages the
  // message_sweeps rows that are due. Absent on the cron's call, which
  // starts a run, and on a step queued by the release before, whose cursor
  // paged the profiles. Such a step starts the run again with its `now`.
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

/** How long after the run of the last full pass a run starts with the full
 * pass again. Half a day short of four weeks, so a nightly cron that starts
 * a little early still makes every 28th run full. */
export const SWEEP_FULL_AFTER_MS = 27.5 * DAY

/* Whether a run at `now` starts with the full pass: no run has finished one
 * (message_sweep_seeds), so the messages read before message_sweeps existed
 * may have no sweep row, or the last one ran SWEEP_FULL_AFTER_MS or more
 * before. */
async function fullPassDue(ctx: QueryCtx, now: string): Promise<boolean> {
  const seed = await ctx.db.query('message_sweep_seeds').first()
  return seed === null || Date.parse(now) - Date.parse(seed.seeded_at) >= SWEEP_FULL_AFTER_MS
}

/* When the oldest of `profileId`'s read, unsnoozed messages falls due under
 * a retention period of `days`, or null when it has none. It reads that one
 * message by index, however many snoozed ones were read before it. */
async function oldestDue(ctx: QueryCtx, profileId: string, days: number): Promise<string | null> {
  const oldest = await ctx.db
    .query('messages')
    .withIndex('by_recipient_snoozed_read', (q) =>
      q.eq('recipient_id', profileId).eq('snoozed_until', undefined).gt('read_at', undefined),
    )
    .first()
  if (oldest?.read_at === undefined) return null
  return new Date(Date.parse(oldest.read_at) + days * DAY).toISOString()
}

/* One profile's share of a sweep leg, at most `budget` deletions. It deletes
 * READ rows read before the profile's retention period (model/people.ts
 * messageRetentionDays), measured from read_at and never created_at, so an
 * UNREAD message is never swept however old it is. Nothing here decides
 * that news stopped mattering because it went unanswered. A snoozed row is
 * a pending reminder and is never swept, however long ago it was read. The
 * read is an index range of the read, unsnoozed rows, so a long unread or
 * snoozed backlog costs nothing here.
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
  let deleted = 0
  let due: string | null = null
  if (days !== null) {
    const cutoff = new Date(Date.parse(now) - days * DAY).toISOString()
    const expired = await ctx.db
      .query('messages')
      .withIndex('by_recipient_snoozed_read', (q) =>
        q
          .eq('recipient_id', profileId)
          .eq('snoozed_until', undefined)
          .gt('read_at', undefined)
          .lte('read_at', cutoff),
      )
      .take(budget + 1)
    const edits = itemEdits(ctx)
    for (const m of expired.slice(0, budget)) {
      await edits.delete(m)
      deleted += 1
    }
    await edits.flush()
    if (expired.length > budget) return { deleted, more: true }
    due = await oldestDue(ctx, profileId, days)
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
 * call. The cron starts a run with no arguments. When the full pass is due
 * (fullPassDue), the seed phase pages every profile, SWEEP_LIMITS.profiles
 * a step, and lowers the message_sweeps row of each with a retention period
 * to when its oldest read, unsnoozed message falls due, adding the row when
 * it has none. That restores model/messages.ts's sweep rule for a read
 * message without a covering row: one read before the table existed,
 * restored from an older backup or read while an older release ran, or one
 * that a write without noteSweepable left. Such a message goes at most 28
 * nights after it fell due. The pass's last step records it
 * (message_sweep_seeds). The due phase pages the message_sweeps rows due by
 * `now` and schedules one sweepDueProfiles chain per page. The last step
 * schedules one wakeSnoozes chain when a snooze is overdue and writes the
 * run's audit row with the number of pages and whether it woke. `now` is
 * the run's clock, shared by every chain. The boot-time
 * sweep_my_read_messages twin is CUT; this nightly job is the one
 * implementation. A profile without a retention period keeps its read
 * messages when it is a person (Never) and keeps them for
 * DEFAULT_MESSAGE_RETENTION_DAYS when it is an agent, which has no settings
 * page. */
export const sweepReadMessages = internalMutation({
  args: sweepRunArgs,
  handler: async (ctx, a): Promise<null> => {
    const now = a.now ?? new Date().toISOString()
    const phase = a.phase ?? ((await fullPassDue(ctx, now)) ? 'seed' : 'due')
    const cursor = a.phase === undefined ? null : (a.cursor ?? null)
    if (phase === 'seed') {
      const profiles = await ctx.db
        .query('profiles')
        .withIndex('by_uuid')
        .paginate({ cursor, numItems: SWEEP_LIMITS.profiles })
      for (const p of profiles.page) {
        const days = messageRetentionDays(p)
        const due = days === null ? null : await oldestDue(ctx, p.id, days)
        if (due !== null) await lowerSweepDue(ctx, p.id, due)
      }
      if (profiles.isDone) {
        const seed = await ctx.db.query('message_sweep_seeds').first()
        if (seed === null) await ctx.db.insert('message_sweep_seeds', { seeded_at: now })
        else if (seed.seeded_at < now) await ctx.db.patch(seed._id, { seeded_at: now })
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
    await audit(ctx, {
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
 * finished the full pass, each run starts with it. */
export const sweepProfiles = internalMutation({
  args: sweepProfilesArgs,
  handler: async (): Promise<null> => null,
})

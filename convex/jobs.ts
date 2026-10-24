/* Nightly maintenance jobs (phase 9) — the pg_cron bodies ported as
 * internalMutations, scheduled from crons.ts (the weekly reap-orphan-files
 * target lives in files.ts and audits itself).
 *
 * Both nightly jobs stay inside the Convex transaction caps (~32k documents
 * scanned, 16 MiB read, 16k documents written and 4,096 index ranges per
 * transaction) however large the deployment grows:
 * - The cron calls a dispatcher with no arguments. Each dispatcher step
 *   reads one page and schedules one chain for every organization in it
 *   (the archive) or one chain for the page of profiles (the read-message
 *   sweep), then schedules the next step.
 * - An archive leg reads the organization's Done candidates past the
 *   shortest archive threshold it uses, by index, at most
 *   ARCHIVE_LIMITS.tasks tasks and ARCHIVE_LIMITS.bytes bytes. The leaf guard
 *   reads at most one child per candidate, by index. A leg stops early when
 *   the task.updated events of its archived tasks reach their budget
 *   (ARCHIVE_LIMITS.checks and ARCHIVE_LIMITS.room). The chain's repair
 *   phase reads the organization's flagged active tasks by index.
 * - A sweep leg visits the profiles of its page and deletes or writes at most
 *   SWEEP_LIMITS.rows messages.
 *
 * Convex retries a scheduled mutation after a transient error and drops the
 * calls a failed mutation scheduled. A leg that fails every time therefore
 * stops only its own chain, one organization or one page of profiles. Its
 * earlier legs stay committed, every other chain runs on, and the next night
 * retries it. Failures show in the Convex logs as failed scheduled functions
 * with their arguments.
 *
 * The dispatcher's last step inserts the run's platform_audit_log row
 * (actor 'system') with the number of organizations or profile pages it
 * scheduled. The row records that the run started every chain, not that
 * every chain finished. Each chain logs its own counts with console.info on
 * its last leg when it changed something. Duration is deliberately NOT
 * recorded, because Convex freezes Date.now() at mutation start. */

import { makeFunctionReference, type TransactionMetrics } from 'convex/server'
import { getDocumentSize, type ObjectType, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, type MutationCtx } from './_generated/server'
import { deletionBegun } from './lib/billingAccess'
import { byId } from './lib/db'
import { scheduleMarkClears } from './model/archiveMarks'
import { ITEM_UNREAD_CAP, scheduleArchivedReads, wakeSnoozedItem } from './model/messages'
import { DEFAULT_ARCHIVE_DAYS, tallyRows } from './model/orgs'
import { messageRetentionDays } from './model/people'
import { emitTaskEvent, eventSubscriptions } from './model/taskEvents'

const DAY = 86_400_000

/** Sizes of one archive step. Tests lower them. */
export const ARCHIVE_LIMITS = {
  /** Organizations per dispatcher step, one scheduled chain each. */
  orgs: 64,
  /** Done candidates per leg, so at most this many task patches. */
  tasks: 500,
  /** Bytes of candidates one leg reads, and again of the children its leaf
   * guard reads. Patching reads each archived task once more, so a leg reads
   * about three times this at most, inside the 16 MiB a transaction may
   * read. */
  bytes: 4 * 1024 * 1024,
  /** Flagged active tasks per repair leg. */
  marked: 1000,
  /** Subscriber checks the task.updated events of one leg may make. Each
   * task in a project the leg has not met yet costs one check per
   * subscription of the organization (model/taskEvents.ts), and the checks
   * set a leg's execution time. */
  checks: 400,
  /** The share of what is left of each of Convex's limits for one
   * transaction, once the leg's reads are done, that its archiving may use
   * before it archives another task. */
  room: 0.5,
}

const archiveRunArgs = {
  cursor: v.optional(v.string()),
  now: v.optional(v.string()),
  organizations: v.optional(v.number()),
}

const archiveOrgArgs = {
  org_id: v.string(),
  now: v.string(),
  phase: v.union(v.literal('archive'), v.literal('repair')),
  // the candidate range's end, fixed by the first leg, because a cursor is
  // valid only for the range it came from
  cutoff: v.optional(v.string()),
  cursor: v.optional(v.string()),
  // the page size after a leg split its page, else ARCHIVE_LIMITS.tasks
  size: v.optional(v.number()),
  archived: v.number(),
  flagged: v.number(),
}

type ArchiveLeg = ObjectType<typeof archiveOrgArgs>

const archiveRunRef = makeFunctionReference<'mutation', ObjectType<typeof archiveRunArgs>, null>(
  'jobs:archiveDoneIssues',
)
const archiveOrgRef = makeFunctionReference<'mutation', ArchiveLeg, null>('jobs:archiveOrg')

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
 * That holds inside one leg and across legs. No activity rows, because the
 * SQL wrote none.
 *
 * No inbox message either. The sweep never calls notifyIssueUpdate, so
 * followers are not told. Keep it that way, because an Archived notice for
 * every follower of every Done task would only add rows that arrive read.
 * Each leg schedules the background steps that mark the messages already
 * stored about its tasks read, and the tasks' relation rows for the app
 * snapshot (model/messages.ts scheduleArchivedReads), as every archive path
 * does.
 *
 * After the archive legs, the chain's repair legs schedule the steps that
 * clear archive marks again for every active task still flagged
 * relations_marked (model/archiveMarks.ts). A restore schedules them itself,
 * so this only repairs a step that failed, and a chain whose organization
 * has no flagged active task skips the phase. Each flagged task is scheduled
 * once per run, and a step skips a task it finds cleared. */

/* Each live project's cutoff for this run. Its Done tasks with done_at at or
 * before the cutoff are due. A project that is archived, or whose root no
 * longer resolves, takes none and is left out. */
function projectCutoffs(projects: readonly Doc<'projects'>[], now: string): Map<string, string> {
  const projectById = new Map(projects.map((p) => [p.id, p]))
  const cutoff = new Date(Date.parse(now) - DEFAULT_ARCHIVE_DAYS * DAY).toISOString()
  const cutoffs = new Map<string, string>()
  for (const project of projects) {
    if (project.archived_at !== undefined) continue
    const root = project.parent_id !== undefined ? projectById.get(project.parent_id) : project
    if (root === undefined) continue // dangling parent — the SQL inner join drops the row
    cutoffs.set(project.id, cutoff)
  }
  return cutoffs
}

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

/* Ends an organization's chain and logs its counts when it changed
 * something. Organizations with nothing to do log nothing, so thousands of
 * idle ones stay out of the logs. */
function finishChain(a: ArchiveLeg): null {
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

/* Returns the chain's step after its last archive leg. That is the first
 * repair leg when the organization has an active task still flagged
 * relations_marked, else null, which ends the chain. */
async function afterArchive(ctx: MutationCtx, a: ArchiveLeg): Promise<ArchiveLeg | null> {
  const flagged = await ctx.db
    .query('issues')
    .withIndex('by_org_archived_marked', (q) =>
      q.eq('org_id', a.org_id).eq('archived_at', undefined).eq('relations_marked', true),
    )
    .first()
  if (flagged === null) return finishChain(a)
  return { ...a, phase: 'repair', cutoff: undefined, cursor: undefined, size: undefined }
}

/* One archive leg. It reads one page of the organization's active Done tasks
 * with done_at at or before the latest project cutoff (the shortest
 * threshold), keeps those due by their own project's cutoff that pass the
 * leaf guard, and archives them. Every read happens before the first patch.
 * Once a leg completes, the candidates the guard kept lie behind the cursor
 * and are not read again this run, which is right because only this run's
 * own stamps could change their answer. A child can be as large as its
 * parent, so when the children the guard read pass ARCHIVE_LIMITS.bytes, the
 * leg writes nothing and the next leg reads the same page at half the size.
 * Each archived task sends a task.updated event, whose subscriber checks
 * cost time the transaction metrics do not show. So before each task after
 * its first, a leg skips a task that would take its checks past
 * ARCHIVE_LIMITS.checks, and stops once its archiving has used
 * ARCHIVE_LIMITS.room of what was left of any transaction limit. When it
 * skipped or stopped, the next leg reads the same page again, without the
 * tasks archived here, which have left its range.
 * Returns the next leg, or null when the chain is done. */
async function archiveLeg(ctx: MutationCtx, a: ArchiveLeg): Promise<ArchiveLeg | null> {
  const projects = await ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('org_id', a.org_id))
    .collect()
  const cutoffs = projectCutoffs(projects, a.now)
  // lexicographic order on ISO strings is time order
  const cutoff = a.cutoff ?? [...cutoffs.values()].sort().at(-1)
  // no live project, so nothing is due
  if (cutoff === undefined) return await afterArchive(ctx, a)

  const page = await ctx.db
    .query('issues')
    .withIndex('by_org_archived_status_done', (q) =>
      q
        .eq('org_id', a.org_id)
        .eq('archived_at', undefined)
        .eq('status', 'done')
        // a Done task without done_at is never taken
        .gt('done_at', undefined)
        .lte('done_at', cutoff),
    )
    .paginate({
      cursor: a.cursor ?? null,
      numItems: a.size ?? ARCHIVE_LIMITS.tasks,
      maximumBytesRead: ARCHIVE_LIMITS.bytes,
    })
  const batch: Doc<'issues'>[] = []
  let childBytes = 0
  for (const task of page.page) {
    const due = cutoffs.get(task.project_id)
    if (due === undefined || task.done_at === undefined || task.done_at > due) continue
    const child = await unarchivedChild(ctx, task.id, a.now)
    if (child === null) {
      batch.push(task)
      continue
    }
    childBytes += getDocumentSize(child)
    // One candidate and one child always fit, so a page of one never splits.
    if (childBytes > ARCHIVE_LIMITS.bytes && page.page.length > 1) {
      return { ...a, cutoff, size: Math.ceil(page.page.length / 2) }
    }
  }

  // A leg always archives one task, so the chain moves on.
  const fanOut = (await eventSubscriptions(ctx, a.org_id, 'task.updated')).length
  const before = await ctx.meta.getTransactionMetrics()
  const projectsMet = new Set<string>()
  const patched: Doc<'issues'>[] = []
  let checks = 0
  let full = false
  for (const task of batch) {
    const cost = projectsMet.has(task.project_id) ? 0 : fanOut
    if (patched.length > 0) {
      if (await legIsFull(ctx, before)) {
        full = true
        break
      }
      // A task of a project the leg has not met waits for the next leg.
      // Tasks of the projects it met cost no new checks and go on.
      if (checks + cost > ARCHIVE_LIMITS.checks) {
        full = true
        continue
      }
    }
    await ctx.db.patch(task._id, { archived_at: a.now })
    await emitTaskEvent(ctx, {
      name: 'task.updated',
      issue: { ...task, archived_at: a.now },
      before: task,
      now: a.now,
    })
    projectsMet.add(task.project_id)
    checks += cost
    patched.push(task)
  }
  await tallyRows(
    ctx,
    'issues',
    patched.map((task) => [task, { ...task, archived_at: a.now }] as const),
  )
  await scheduleArchivedReads(ctx, { issues: patched.map((task) => task.id) })
  const archived = a.archived + patched.length
  // The same page again. The tasks archived here have left its range.
  if (full) return { ...a, cutoff, archived }
  if (page.isDone) return await afterArchive(ctx, { ...a, archived })
  return { ...a, cutoff, cursor: page.continueCursor, size: undefined, archived }
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
async function repairLeg(ctx: MutationCtx, a: ArchiveLeg): Promise<ArchiveLeg | null> {
  const page = await ctx.db
    .query('issues')
    .withIndex('by_org_archived_marked', (q) =>
      q.eq('org_id', a.org_id).eq('archived_at', undefined).eq('relations_marked', true),
    )
    .paginate({
      cursor: a.cursor ?? null,
      numItems: ARCHIVE_LIMITS.marked,
      maximumBytesRead: ARCHIVE_LIMITS.bytes,
    })
  await scheduleMarkClears(ctx, page.page)
  const flagged = a.flagged + page.page.length
  if (page.isDone) return finishChain({ ...a, flagged })
  return { ...a, cursor: page.continueCursor, flagged }
}

/** The nightly archive, one dispatcher step per call. The cron starts a run
 * with no arguments. Each step schedules one archiveOrg chain for every
 * organization in one page, then the next step with the running count. The
 * last step writes the run's audit row with the number of organizations.
 * `now` is the run's stamp and clock, shared by every chain. */
export const archiveDoneIssues = internalMutation({
  args: archiveRunArgs,
  handler: async (ctx, a): Promise<null> => {
    const now = a.now ?? new Date().toISOString()
    const orgs = await ctx.db
      .query('organizations')
      .paginate({ cursor: a.cursor ?? null, numItems: ARCHIVE_LIMITS.orgs })
    for (const org of orgs.page) {
      await ctx.scheduler.runAfter(0, archiveOrgRef, {
        org_id: org.id,
        now,
        phase: 'archive',
        archived: 0,
        flagged: 0,
      })
    }
    const organizations = (a.organizations ?? 0) + orgs.page.length
    if (!orgs.isDone) {
      await ctx.scheduler.runAfter(0, archiveRunRef, {
        cursor: orgs.continueCursor,
        now,
        organizations,
      })
      return null
    }

    await ctx.db.insert('platform_audit_log', {
      ts: now,
      actor_email: 'system',
      action: 'archive_done_issues',
      detail: { organizations },
    })
    return null
  },
})

/** One leg of an organization's nightly archive chain. The archive phase
 * pages through the due candidates, then the repair phase, when needed,
 * through the flagged active tasks, each leg scheduling the next with the
 * running counts. The last leg logs them. An organization deleted since the
 * dispatcher read it ends its chain, and so does one whose deletion has
 * begun (lib/billingAccess.ts deletionBegun), because its deletion steps
 * are removing the tasks a leg would archive. The read-only period before
 * deletion begins still archives. */
export const archiveOrg = internalMutation({
  args: archiveOrgArgs,
  handler: async (ctx, a): Promise<null> => {
    if ((await byId(ctx, 'organizations', a.org_id)) === null) return null
    if (await deletionBegun(ctx, a.org_id)) return finishChain(a)
    const next = a.phase === 'archive' ? await archiveLeg(ctx, a) : await repairLeg(ctx, a)
    if (next !== null) await ctx.scheduler.runAfter(0, archiveOrgRef, next)
    return null
  },
})

/** Sizes of one read-message sweep step. Tests lower them. */
export const SWEEP_LIMITS = {
  /** Profiles per dispatcher page, one chain each, and the most one leg
   * visits. */
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
  cursor: v.optional(v.string()),
  now: v.optional(v.string()),
  pages: v.optional(v.number()),
}

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
const sweepProfilesRef = makeFunctionReference<
  'mutation',
  ObjectType<typeof sweepProfilesArgs>,
  null
>('jobs:sweepProfiles')

/* One profile's share of a sweep leg, at most `budget` rows. It deletes
 * READ rows read before the profile's retention period (model/people.ts
 * messageRetentionDays), measured from read_at and never created_at, so an
 * UNREAD message is never swept however old it is. Nothing here decides
 * that news stopped mattering because it went unanswered. A snoozed row is
 * a pending reminder and is never swept, however long ago it was read. One
 * whose instant has passed lost its scheduled wake somewhere, and this is
 * the fallback that still brings it back. A wake writes every row of its
 * item, so it starts only while WAKE_ROWS of the budget are left. Both reads
 * are index ranges, so a long unread backlog costs nothing here. `used`
 * counts the rows it deleted or wrote while waking, and `more` says rows
 * remain for the next leg. */
async function sweepProfileMessages(
  ctx: MutationCtx,
  p: Doc<'profiles'>,
  now: string,
  budget: number,
): Promise<{ deleted: number; woken: number; used: number; more: boolean }> {
  let deleted = 0
  const days = messageRetentionDays(p)
  if (days !== null) {
    const cutoff = new Date(Date.parse(now) - days * DAY).toISOString()
    const expired = await ctx.db
      .query('messages')
      .withIndex('by_recipient_read', (q) =>
        q.eq('recipient_id', p.id).gt('read_at', undefined).lte('read_at', cutoff),
      )
      .filter((q) => q.eq(q.field('snoozed_until'), undefined))
      .take(budget + 1)
    for (const m of expired.slice(0, budget)) {
      await ctx.db.delete(m._id)
      deleted += 1
    }
    if (expired.length > budget) return { deleted, woken: 0, used: budget, more: true }
  }
  const room = budget - deleted
  const overdue = await ctx.db
    .query('messages')
    .withIndex('by_recipient_snoozed', (q) =>
      q.eq('recipient_id', p.id).gt('snoozed_until', undefined).lte('snoozed_until', now),
    )
    .take(room + 1)
  let used = deleted
  let woken = 0
  for (const issue_id of new Set(overdue.map((m) => m.issue_id))) {
    if (budget - used < WAKE_ROWS) return { deleted, woken, used, more: true }
    const written = await wakeSnoozedItem(ctx, { recipient_id: p.id, issue_id }, now)
    if (written > 0) woken += 1
    used += written
  }
  return { deleted, woken, used, more: overdue.length > room }
}

/** private.sweep_read_messages(null) (0110:88-102), one dispatcher step per
 * call. The cron starts a run with no arguments. Each step reads one page of
 * SWEEP_LIMITS.profiles profiles in uuid order, schedules one sweepProfiles
 * chain for the page's id range, then the next step with the running page
 * count. The last step writes the run's audit row with the number of pages.
 * `now` is the run's clock, shared by every chain. Iterating from profiles
 * is the SQL's join (a message whose recipient row is gone is not swept
 * here; teardown removes those with the profile). The boot-time
 * sweep_my_read_messages twin is CUT; this nightly job is the one
 * implementation. A profile without a retention period keeps its read
 * messages when it is a person (Never) and keeps them for
 * DEFAULT_MESSAGE_RETENTION_DAYS when it is an agent, which has no settings
 * page. */
export const sweepReadMessages = internalMutation({
  args: sweepRunArgs,
  handler: async (ctx, a): Promise<null> => {
    const now = a.now ?? new Date().toISOString()
    const profiles = await ctx.db
      .query('profiles')
      .withIndex('by_uuid')
      .paginate({ cursor: a.cursor ?? null, numItems: SWEEP_LIMITS.profiles })
    const first = profiles.page.at(0)
    const last = profiles.page.at(-1)
    let pages = a.pages ?? 0
    if (first !== undefined && last !== undefined) {
      await ctx.scheduler.runAfter(0, sweepProfilesRef, {
        from: first.id,
        to: last.id,
        now,
        deleted: 0,
        woken: 0,
      })
      pages += 1
    }
    if (!profiles.isDone) {
      await ctx.scheduler.runAfter(0, sweepRunRef, {
        cursor: profiles.continueCursor,
        now,
        pages,
      })
      return null
    }

    await ctx.db.insert('platform_audit_log', {
      ts: now,
      actor_email: 'system',
      action: 'sweep_read_messages',
      detail: { pages },
    })
    return null
  },
})

/** One leg of a page's read-message sweep. It visits the profiles with ids
 * from `from` through `to`, at most SWEEP_LIMITS.profiles of them and
 * SWEEP_LIMITS.rows rows, and schedules the next leg with the running counts,
 * staying on a profile while it has rows left. The last leg logs the counts
 * when it changed something, with `to`, the page's last profile, naming the
 * page. */
export const sweepProfiles = internalMutation({
  args: sweepProfilesArgs,
  handler: async (ctx, a): Promise<null> => {
    let { deleted, woken } = a
    let budget = SWEEP_LIMITS.rows
    let next: string | undefined
    const profiles = await ctx.db
      .query('profiles')
      .withIndex('by_uuid', (q) => q.gte('id', a.from).lte('id', a.to))
      .take(SWEEP_LIMITS.profiles + 1)
    for (const [i, p] of profiles.entries()) {
      // below 0 only after an item that outgrew the cap before it existed
      if (i === SWEEP_LIMITS.profiles || budget <= 0) {
        next = p.id
        break
      }
      const leg = await sweepProfileMessages(ctx, p, a.now, budget)
      deleted += leg.deleted
      woken += leg.woken
      budget -= leg.used
      if (leg.more) {
        next = p.id
        break
      }
    }
    if (next !== undefined) {
      await ctx.scheduler.runAfter(0, sweepProfilesRef, {
        ...a,
        from: next,
        deleted,
        woken,
      })
      return null
    }
    if (deleted + woken > 0) {
      console.info('Read-message sweep finished', { to: a.to, deleted, woken })
    }
    return null
  },
})

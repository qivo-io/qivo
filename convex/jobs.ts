/* Nightly maintenance jobs (phase 9) — the pg_cron bodies ported as
 * internalMutations, scheduled from crons.ts (the weekly reap-orphan-files
 * target lives in files.ts and audits itself).
 *
 * Each run's final act is inserting ONE platform_audit_log row in the SAME
 * transaction as its last writes (actor 'system', counts only). A run that
 * fails writes no record, so the pg_net fire-and-forget failure class dies
 * structurally, and failures surface in the Convex dashboard logs. Duration
 * is deliberately NOT recorded — Convex freezes Date.now() at mutation start,
 * so any in-transaction delta would always read 0. Only counts are recorded.
 *
 * The archive sweep stays inside the Convex transaction caps (~32k documents
 * scanned, 16 MiB read, 16k documents written per txn) by running in legs
 * that schedule the next one. Each leg reads one organization's unarchived
 * tasks, the same working set the app's snapshot loads, and archives at most
 * ARCHIVE_BATCH of them. Convex drops the calls a failed mutation scheduled,
 * so a failed leg ends the run without an audit row, and earlier legs stay
 * committed. Every run starts again from the first organization, so the next
 * night recovers only from a transient failure. A leg that fails every time
 * stops every organization sorted after it, every night. The likely cause is
 * an organization whose unarchived tasks outgrow one transaction, which also
 * breaks that organization's app snapshot. Isolating organizations needs
 * separately scheduled legs whose counts no longer meet in one audit row, so
 * build it when an organization nears the caps. The read-message sweep runs
 * in legs the same way, by profile and bounded by rows. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, type MutationCtx } from './_generated/server'
import { scheduleMarkClears } from './model/archiveMarks'
import { ITEM_UNREAD_CAP, scheduleArchivedReads, wakeSnoozedItem } from './model/messages'
import { DEFAULT_ARCHIVE_DAYS } from './model/orgs'
import { messageRetentionDays } from './model/people'
import { emitTaskEvent } from './model/taskEvents'

const DAY = 86_400_000

/* The most tasks one archive leg patches. A larger backlog in one
 * organization continues in the next leg of the same run. */
export const ARCHIVE_BATCH = 500

const archiveLegRef = makeFunctionReference<
  'mutation',
  { from?: string; archived?: number; now?: string },
  null
>('jobs:archiveDoneIssues')

/* private.archive_done_issues() (LAST def 0106:218-246), ported field for
 * field. Per issue, all four conditions plus the leaf guard:
 *   - not already archived
 *   - its OWN sub-project is live — "the nightly sweep leaves an archived
 *     project alone: its done tasks are already out of every client's sight,
 *     and archiving them would silently change what a restore brings back"
 *   - status 'done' with done_at at least archive_days old. A project that
 *     keeps a legacy team (its own, else its root's) uses that team's
 *     archive_days. Every other project, which includes every project created
 *     since projects stopped belonging to teams, uses DEFAULT_ARCHIVE_DAYS. A
 *     team id that no longer resolves counts as no team. A dangling parent
 *     drops the row rather than aborting the sweep.
 *   - "leaf-up: never drag an active child along — a done parent waits until
 *     its children have been archived themselves"
 *
 * Semantics pin — SINGLE SNAPSHOT, not fixpoint: the SQL is one UPDATE whose
 * child sub-select reads the pre-statement state, so a child archived in THIS
 * run still counts as unarchived and its done parent goes the NEXT night. The
 * candidate set is therefore collected against pre-run state first, then
 * patched. Tasks and projects never cross organizations, so the snapshot is
 * taken per organization. When a backlog spans several legs, the tasks earlier
 * legs archived carry this run's stamp and still count as unarchived children.
 * No activity rows — the SQL wrote none.
 *
 * No inbox message either. The sweep never calls notifyIssueUpdate, so
 * followers are not told. Keep it that way, because an Archived notice for
 * every follower of every Done task would only add rows that arrive read.
 * The leg schedules the background steps that mark the messages already
 * stored about its tasks read, and the tasks' relation rows for the app
 * snapshot (model/messages.ts scheduleArchivedReads), as every archive path
 * does.
 *
 * The leg also schedules the steps that clear archive marks again for every
 * active task still flagged relations_marked (model/archiveMarks.ts). A
 * restore schedules them itself, so this only repairs a step that failed. It
 * reads nothing more, as the leg holds the organization's active tasks
 * already. A later leg in the same organization schedules them again, which
 * is harmless because a step skips a task it finds cleared.
 *
 * `now` is the run's stamp and clock, shared by every leg. Returns how many
 * tasks this leg archived and whether due tasks remain in the organization. */
async function archiveOrgDoneIssues(
  ctx: MutationCtx,
  orgId: string,
  now: string,
): Promise<{ archived: number; more: boolean }> {
  const nowMs = Date.parse(now)
  // Every read happens before the first patch, so the candidates come from
  // the snapshot.
  const live = await ctx.db
    .query('issues')
    .withIndex('by_org_archived', (q) => q.eq('org_id', orgId).eq('archived_at', undefined))
    .collect()
  const archivedThisRun = await ctx.db
    .query('issues')
    .withIndex('by_org_archived', (q) => q.eq('org_id', orgId).eq('archived_at', now))
    .collect()
  const projects = await ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  const teams = await ctx.db
    .query('teams')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  const projectById = new Map(projects.map((p) => [p.id, p]))
  const teamById = new Map(teams.map((t) => [t.id, t]))

  /* The leaf guard's read set: parents holding >= 1 unarchived child AS OF
   * the snapshot (a sibling patched later this run does not count). */
  const hasUnarchivedChild = new Set<string>()
  for (const i of [...live, ...archivedThisRun]) {
    if (i.parent_id !== undefined) hasUnarchivedChild.add(i.parent_id)
  }

  const candidates: typeof live = []
  for (const i of live) {
    if (i.status !== 'done' || i.done_at === undefined) continue
    const project = projectById.get(i.project_id)
    if (project === undefined || project.archived_at !== undefined) continue
    const root = project.parent_id !== undefined ? projectById.get(project.parent_id) : project
    if (root === undefined) continue // dangling parent — the SQL inner join drops the row
    // New rows have no team. Old development rows may still keep one on the
    // sub-project or its root, and its saved threshold still applies.
    const legacyTeam = teamById.get(project.team_id ?? root.team_id ?? '')
    const days = legacyTeam?.archive_days ?? DEFAULT_ARCHIVE_DAYS
    const cutoff = new Date(nowMs - days * DAY).toISOString()
    if (i.done_at > cutoff) continue // lexicographic <= on ISO strings = time order
    if (hasUnarchivedChild.has(i.id)) continue
    candidates.push(i)
  }

  const batch = candidates.slice(0, ARCHIVE_BATCH)
  for (const i of batch) {
    await ctx.db.patch(i._id, { archived_at: now })
    await emitTaskEvent(ctx, {
      name: 'task.updated',
      issue: { ...i, archived_at: now },
      before: i,
      now,
    })
  }
  await scheduleArchivedReads(ctx, { issues: batch.map((i) => i.id) })
  const archivedNow = new Set(batch.map((i) => i.id))
  await scheduleMarkClears(
    ctx,
    live.filter((i) => !archivedNow.has(i.id)),
  )
  return { archived: batch.length, more: candidates.length > batch.length }
}

/* The nightly archive sweep, one leg per call. The cron starts a run with no
 * arguments. Each leg takes the first organization whose id is not before
 * `from` and schedules the next leg with the running count, staying on the
 * same organization while it has due tasks left. The leg with nothing left to
 * schedule writes the counts-only audit row. */
export const archiveDoneIssues = internalMutation({
  args: {
    from: v.optional(v.string()),
    archived: v.optional(v.number()),
    now: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<null> => {
    const now = a.now ?? new Date().toISOString()
    let archived = a.archived ?? 0

    const org = await ctx.db
      .query('organizations')
      .withIndex('by_uuid', (q) => q.gte('id', a.from ?? ''))
      .first()
    if (org !== null) {
      const leg = await archiveOrgDoneIssues(ctx, org.id, now)
      archived += leg.archived
      const next = leg.more
        ? org
        : await ctx.db
            .query('organizations')
            .withIndex('by_uuid', (q) => q.gt('id', org.id))
            .first()
      if (next !== null) {
        await ctx.scheduler.runAfter(0, archiveLegRef, { from: next.id, archived, now })
        return null
      }
    }

    await ctx.db.insert('platform_audit_log', {
      ts: now,
      actor_email: 'system',
      action: 'archive_done_issues',
      detail: { archived },
    })
    return null
  },
})

/* How many messages one sweep leg deletes or writes while waking items at
 * most, and how many profiles it visits at most. A larger backlog continues
 * in the next leg of the same run. SWEEP_BATCH must be at least WAKE_ROWS,
 * or a leg could never wake an item. */
export const SWEEP_BATCH = 500
export const SWEEP_PROFILES = 100

/* The most rows one wake writes (model/messages.ts wakeSnoozedItem), a full
 * item. A leg wakes another item only while this much budget is left. An
 * item that grew past the cap before it existed can write more, a legacy
 * case decided separately, and the leg then ends over its budget. */
const WAKE_ROWS = ITEM_UNREAD_CAP + 1

const sweepLegRef = makeFunctionReference<
  'mutation',
  { from?: string; deleted?: number; woken?: number; now?: string },
  null
>('jobs:sweepReadMessages')

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

/* private.sweep_read_messages(null) (0110:88-102), one leg per call, so a
 * run stays inside the transaction caps however many profiles and messages
 * there are. The cron starts a run with no arguments. Each leg visits
 * profiles in uuid order from `from`, at most SWEEP_PROFILES of them and
 * SWEEP_BATCH rows, and schedules the next leg with the running counts and
 * the run's `now`, staying on a profile while it has rows left. The leg with
 * nothing left to schedule writes the counts-only audit row. Iterating from
 * profiles is the SQL's join (a message whose recipient row is gone is not
 * swept here; teardown removes those with the profile). The boot-time
 * sweep_my_read_messages twin is CUT; this nightly job is the one
 * implementation. A profile without a retention period keeps its read
 * messages when it is a person (Never) and keeps them for
 * DEFAULT_MESSAGE_RETENTION_DAYS when it is an agent, which has no settings
 * page. */
export const sweepReadMessages = internalMutation({
  args: {
    from: v.optional(v.string()),
    deleted: v.optional(v.number()),
    woken: v.optional(v.number()),
    now: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<null> => {
    const now = a.now ?? new Date().toISOString()
    let deleted = a.deleted ?? 0
    let woken = a.woken ?? 0
    let budget = SWEEP_BATCH
    let next: string | undefined
    const profiles = await ctx.db
      .query('profiles')
      .withIndex('by_uuid', (q) => q.gte('id', a.from ?? ''))
      .take(SWEEP_PROFILES + 1)
    for (const [i, p] of profiles.entries()) {
      // below 0 only after an item that outgrew the cap before it existed
      if (i === SWEEP_PROFILES || budget <= 0) {
        next = p.id
        break
      }
      const leg = await sweepProfileMessages(ctx, p, now, budget)
      deleted += leg.deleted
      woken += leg.woken
      budget -= leg.used
      if (leg.more) {
        next = p.id
        break
      }
    }
    if (next !== undefined) {
      await ctx.scheduler.runAfter(0, sweepLegRef, { from: next, deleted, woken, now })
      return null
    }

    await ctx.db.insert('platform_audit_log', {
      ts: now,
      actor_email: 'system',
      action: 'sweep_read_messages',
      detail: { deleted, woken },
    })
    return null
  },
})

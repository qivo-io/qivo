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
 * ARCHIVE_BATCH of them. A failed leg ends the run without an audit row;
 * earlier legs stay committed, and the next night picks up what is left. The
 * read-message sweep is still one transaction; its escape hatch is the same
 * self-continuation. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalMutation, type MutationCtx } from './_generated/server'
import { wakeSnoozedItem } from './model/messages'
import { DEFAULT_ARCHIVE_DAYS } from './model/orgs'
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

/* private.sweep_read_messages(null) (0110:88-102) — READ messages only, per
 * the recipient's own message_retention_days, measured from read_at, never
 * created_at: "An UNREAD message is never swept however old it is: nothing
 * here decides that news stopped mattering because it went unanswered."
 * Convex mapping: an absent message_retention_days means Never (schema.ts) —
 * those profiles are skipped entirely. Iterating from profiles is the SQL's
 * join (a message whose recipient row is gone is not swept here; teardown
 * removes those with the profile). The boot-time sweep_my_read_messages twin
 * is CUT — this nightly job is the one implementation. */
export const sweepReadMessages = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number; woken: number }> => {
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
    let deleted = 0
    let woken = 0

    const profiles = await ctx.db.query('profiles').withIndex('by_uuid').collect()
    for (const p of profiles) {
      const cutoff =
        p.message_retention_days === undefined // absent = keep forever
          ? null
          : new Date(nowMs - p.message_retention_days * DAY).toISOString()
      const messages = await ctx.db
        .query('messages')
        .withIndex('by_recipient', (q) => q.eq('recipient_id', p.id))
        .collect()
      // A snoozed row is a pending reminder: never swept, however long ago it
      // was read. One whose instant has passed lost its scheduled wake
      // somewhere — this is the fallback that still brings it back.
      const overdue = new Set<string>()
      for (const m of messages) {
        if (m.snoozed_until !== undefined) {
          if (m.snoozed_until <= now) overdue.add(m.issue_id)
          continue
        }
        if (cutoff === null || m.read_at === undefined) continue
        if (m.read_at > cutoff) continue
        await ctx.db.delete(m._id)
        deleted += 1
      }
      for (const issue_id of overdue) {
        if (await wakeSnoozedItem(ctx, { recipient_id: p.id, issue_id }, now)) woken += 1
      }
    }

    await ctx.db.insert('platform_audit_log', {
      ts: now,
      actor_email: 'system',
      action: 'sweep_read_messages',
      detail: { deleted, woken },
    })
    return { deleted, woken }
  },
})

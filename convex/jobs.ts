/* Nightly maintenance jobs (phase 9) — the pg_cron bodies ported as
 * internalMutations, scheduled from crons.ts (the weekly reap-orphan-files
 * target lives in files.ts and audits itself).
 *
 * Each run's final act is inserting ONE platform_audit_log row in the SAME
 * transaction (actor 'system', counts only): the sweep and its record land or
 * fail together, so the pg_net fire-and-forget failure class dies
 * structurally, and failures surface in the Convex dashboard logs. Duration
 * is deliberately NOT recorded — Convex freezes Date.now() at mutation start,
 * so any in-transaction delta would always read 0. Only counts are recorded.
 *
 * Both jobs are bounded by the Convex transaction caps (~32k documents
 * scanned / 16 MiB read per txn); demo scale is nowhere near them. If a
 * deployment ever grows past the caps, the escape hatch is self-continuation:
 * batch N per leg via ctx.scheduler.runAfter(0, …, { cursor }), audit row on
 * the final leg — code it when it is real. */

import { internalMutation } from './_generated/server'
import { wakeSnoozedItem } from './model/messages'
import { emitTaskEvent } from './model/taskEvents'

const DAY = 86_400_000

/* private.archive_done_issues() (LAST def 0106:218-246), ported field for
 * field. Per issue, all four conditions plus the leaf guard:
 *   - not already archived
 *   - its OWN sub-project is live — "the nightly sweep leaves an archived
 *     project alone: its done tasks are already out of every client's sight,
 *     and archiving them would silently change what a restore brings back"
 *   - status 'done' with done_at at least archive_days old, archive_days
 *     taken from the task's sub-project team (legacy meta rows fall back to
 *     the ROOT team's value). A dangling team or parent drops the row rather
 *     than aborting the sweep.
 *   - "leaf-up: never drag an active child along — a done parent waits until
 *     its children have been archived themselves"
 *
 * Semantics pin — SINGLE SNAPSHOT, not fixpoint: the SQL is one UPDATE whose
 * child sub-select reads the pre-statement state, so a child archived in THIS
 * run still counts as unarchived and its done parent goes the NEXT night. The
 * candidate set is therefore collected against pre-run state first, then
 * patched. No activity rows — the SQL wrote none. */
export const archiveDoneIssues = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ archived: number }> => {
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
    let archived = 0

    const orgs = await ctx.db.query('organizations').withIndex('by_uuid').collect()
    for (const org of orgs) {
      /* The pre-run snapshot: every read happens before the first patch. */
      const issues = await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', org.id))
        .collect()
      const projects = await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', org.id))
        .collect()
      const teams = await ctx.db
        .query('teams')
        .withIndex('by_org', (q) => q.eq('org_id', org.id))
        .collect()
      const projectById = new Map(projects.map((p) => [p.id, p]))
      const teamById = new Map(teams.map((t) => [t.id, t]))

      /* The leaf guard's read set: parents holding >= 1 unarchived child AS
       * OF the snapshot (a sibling patched later this run does not count). */
      const hasUnarchivedChild = new Set<string>()
      for (const i of issues) {
        if (i.parent_id !== undefined && i.archived_at === undefined)
          hasUnarchivedChild.add(i.parent_id)
      }

      const candidates: typeof issues = []
      for (const i of issues) {
        if (i.archived_at !== undefined) continue
        const project = projectById.get(i.project_id)
        if (project === undefined || project.archived_at !== undefined) continue
        const root = project.parent_id !== undefined ? projectById.get(project.parent_id) : project
        if (root === undefined) continue // dangling parent — the SQL inner join drops the row
        // New rows put the team on the sub-project itself. Keep the old root
        // fallback so existing development rows remain maintainable.
        const team = teamById.get(project.team_id ?? root.team_id ?? '')
        if (team === undefined) continue
        if (i.status !== 'done' || i.done_at === undefined) continue
        const cutoff = new Date(nowMs - team.archive_days * DAY).toISOString()
        if (i.done_at > cutoff) continue // lexicographic <= on ISO strings = time order
        if (hasUnarchivedChild.has(i.id)) continue
        candidates.push(i)
      }

      for (const i of candidates) {
        await ctx.db.patch(i._id, { archived_at: now })
        await emitTaskEvent(ctx, {
          name: 'task.updated',
          issue: { ...i, archived_at: now },
          before: i,
          now,
        })
        archived += 1
      }
    }

    await ctx.db.insert('platform_audit_log', {
      ts: now,
      actor_email: 'system',
      action: 'archive_done_issues',
      detail: { archived },
    })
    return { archived }
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

/* Deep deletes: every FK edge the Postgres schema resolved with ON DELETE,
 * spelled out. This file is phase 5's home for deleteProjectDeep /
 * deleteTeamDeep / removeProfile; deleteIssueDeep is pulled forward because
 * phase 4's issues.deleteDeep must not ship without the message/subscription/
 * link edges.
 *
 * deleteIssueDeep deletes ONE issue. It does NOT delete the subtree:
 * issues.parent_id is `on delete set null` (0001:95) — deleting a parent
 * DETACHES its direct children, grandchildren keep their parents. In SQL the
 * SET NULL was an ordinary UPDATE OF parent_id, so it fired issues_touch
 * (planner mirror at old planner.ts:2103) AND notify_issue_update — each
 * detached child's subscribers read 'Detached from its parent'. Both are
 * reproduced here: side-effect writes notify and touch.
 *
 * Activity rows STAY — "History survives its subjects" (0001:144);
 * activity_events carries no issue FK, target_id is plain text (0026). */

import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { require, rule } from '../lib/functions'
import { hasPendingCheckout } from './billing'
import { notifyIssueUpdate } from './messages'
import { emitTaskEvent } from './taskEvents'

async function deleteProfileRateLimit(ctx: MutationCtx, profileId: string): Promise<void> {
  const rows = ctx.db
    .query('machine_rate_limits')
    .withIndex('by_key', (q) => q.eq('key', `profile:${profileId}`))
  for await (const row of rows) await ctx.db.delete(row._id)
}

export async function deleteIssueDeep(
  ctx: MutationCtx,
  a: {
    issue: Doc<'issues'>
    actor: Doc<'profiles'>
    now: string
    deletingProjectIds?: ReadonlySet<string>
  },
): Promise<void> {
  const { issue, actor, now, deletingProjectIds } = a
  // children: FK SET NULL + touch + notify (the detach is real news)
  const kids = await ctx.db
    .query('issues')
    .withIndex('by_parent', (q) => q.eq('parent_id', issue.id))
    .collect()
  for (const c of kids) {
    const before = { ...c }
    await ctx.db.patch(c._id, { parent_id: undefined, updated_at: now })
    const after = (await ctx.db.get(c._id)) as Doc<'issues'>
    await notifyIssueUpdate(ctx, {
      before,
      after,
      actor,
      now,
      skipTaskEvent: deletingProjectIds?.has(c.project_id),
    })
  }
  // links, both directions (pair rows are these same rows — pair_key is a
  // field, reached through by_source/by_target here)
  const outgoing = ctx.db
    .query('issue_links')
    .withIndex('by_source', (q) => q.eq('source_id', issue.id))
  for await (const l of outgoing) await ctx.db.delete(l._id)
  const incoming = ctx.db
    .query('issue_links')
    .withIndex('by_target', (q) => q.eq('target_id', issue.id))
  for await (const l of incoming) await ctx.db.delete(l._id)
  const labels = ctx.db
    .query('issue_labels')
    .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
  for await (const il of labels) await ctx.db.delete(il._id)
  const subs = ctx.db
    .query('issue_subscriptions')
    .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
  for await (const s of subs) await ctx.db.delete(s._id)
  const comments = ctx.db.query('comments').withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
  for await (const c of comments) await ctx.db.delete(c._id)
  const messages = ctx.db.query('messages').withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
  for await (const m of messages) await ctx.db.delete(m._id)
  // attachment rows AND their bytes — ctx.storage.delete is transactional,
  // so a rolled-back mutation reaps nothing (the SQL client's bytes-first
  // reap inversion dies here)
  const atts = await ctx.db
    .query('issue_attachments')
    .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
    .collect()
  for (const att of atts) {
    await ctx.storage.delete(att.storage_id)
    await ctx.db.delete(att._id)
  }
  if (!deletingProjectIds?.has(issue.project_id))
    await emitTaskEvent(ctx, { name: 'task.deleted', issue, actor, now })
  await ctx.db.delete(issue._id)
}

/* delete_project's cascade (0081:473-488 authorizes; the FK graph destroys):
 * a meta takes its subs (projects.parent_id CASCADE, 0001:61 — subs never
 * have children, 0048, so one level down is the whole tree); per doomed
 * project: milestones (0078:152 CASCADE), project_access (0001:80 CASCADE —
 * grants are swept per project defensively), and issues (0001:88
 * CASCADE) each through deleteIssueDeep, which detaches cross-project
 * children WITH the issues_touch stamp + notify and reaps attachment bytes.
 * Activity rows are KEPT with project_id nulled (0001:155 SET NULL) —
 * "History survives its subjects" (0001:144). The caller (projects.deleteDeep)
 * writes the 'deleted' narration AFTER this returns, hung on the parent/team
 * branch — the project the event names is gone. */
export async function deleteProjectDeep(
  ctx: MutationCtx,
  a: { project: Doc<'projects'>; actor: Doc<'profiles'>; now: string },
): Promise<void> {
  const { project, actor, now } = a
  const subs = await ctx.db
    .query('projects')
    .withIndex('by_parent', (q) => q.eq('parent_id', project.id))
    .collect()
  const doomed = [...subs, project] // children first, the row itself last
  const doomedIds = new Set(doomed.map((p) => p.id))
  for (const p of doomed) {
    const milestones = ctx.db
      .query('milestones')
      .withIndex('by_project', (q) => q.eq('project_id', p.id))
    for await (const m of milestones) await ctx.db.delete(m._id)
    const grants = ctx.db
      .query('project_access')
      .withIndex('by_project', (q) => q.eq('project_id', p.id))
    for await (const g of grants) await ctx.db.delete(g._id)
    const teamGrants = ctx.db
      .query('project_team_access')
      .withIndex('by_project', (q) => q.eq('project_id', p.id))
    for await (const g of teamGrants) await ctx.db.delete(g._id)
    const issues = await ctx.db
      .query('issues')
      .withIndex('by_project', (q) => q.eq('project_id', p.id))
      .collect()
    // Only detached children in surviving projects can produce deliverable events.
    for (const i of issues)
      await deleteIssueDeep(ctx, { issue: i, actor, now, deletingProjectIds: doomedIds })
  }
  const events = ctx.db
    .query('activity_events')
    .withIndex('by_org_ts', (q) => q.eq('org_id', project.org_id))
  for await (const e of events) {
    if (e.project_id !== undefined && doomedIds.has(e.project_id)) {
      await ctx.db.patch(e._id, { project_id: undefined })
    }
  }
  for (const p of doomed) await ctx.db.delete(p._id)
}

/* delete_team's cascade (0081:458-471 authorizes). Projects are independent
 * of teams, so deleting a team removes its permission grants and clears the
 * legacy ownership column while preserving projects, tasks and milestones.
 * Memberships die (team_members.team_id CASCADE, 0001:51), labels are
 * org-level and SURVIVE (0010/0078), activity rows survive with team_id
 * nulled (0001:156 SET NULL). Guards — 'team not found', 'only organization
 * admins can delete teams', the last-team guard — live in the caller
 * (teams.deleteDeep), which narrates nothing (the old client wrote no event). */
export async function deleteTeamDeep(
  ctx: MutationCtx,
  a: { team: Doc<'teams'>; actor: Doc<'profiles'>; now: string },
): Promise<void> {
  const { team } = a
  const legacyOwnedProjects = await ctx.db
    .query('projects')
    .withIndex('by_team', (q) => q.eq('team_id', team.id))
    .collect()
  for (const project of legacyOwnedProjects) await ctx.db.patch(project._id, { team_id: undefined })
  const shared = ctx.db
    .query('project_team_access')
    .withIndex('by_team', (q) => q.eq('team_id', team.id))
  for await (const grant of shared) await ctx.db.delete(grant._id)
  const members = ctx.db.query('team_members').withIndex('by_team', (q) => q.eq('team_id', team.id))
  for await (const tm of members) await ctx.db.delete(tm._id)
  const events = ctx.db
    .query('activity_events')
    .withIndex('by_org_ts', (q) => q.eq('org_id', team.org_id))
  for await (const e of events) {
    if (e.team_id === team.id) await ctx.db.patch(e._id, { team_id: undefined })
  }
  await ctx.db.delete(team._id)
}

/* remove_member's cascade (0100:206-222 authorizes; the FK graph resolves).
 * Guards live in the caller (profiles.remove): 'user not found' /
 * 'you cannot remove yourself' / 'cannot remove the last admin' — and the
 * caller writes the 'removed' narration. The cascade itself logs nothing,
 * exactly like the SQL FK resolution.
 *
 * Three FK behaviors, spelled out:
 * - SET NULL + touch: issues.assignee_id (0001:94), issues.reviewer_id,
 *   issues.created_by (0041:5), and issues.reporter_id — the FK UPDATE fired
 *   issues_touch, so each patched issue is stamped updated_at = now (the
 *   stale-dimming filter reads it; old client mirror bc022c2:3471-3478). No
 *   notify — removeProfile lists touch only. A cleared reviewer leaves
 *   issues.review_at as it is: the task still waits from its hand-off.
 * - SET NULL, no touch: projects.lead_id (0001:65), activity_events.actor_id
 *   (0001:149 — rows KEPT, history survives its actor), comments.author /
 *   comments.edited_by (0054:15/19), messages.actor_id (0074:24),
 *   agent_keys.created_by (0100:51, reached via the org's agents' keys),
 *   issue_attachments.uploaded_by (0018:23, reached via the org's issues).
 * - DELETE: team_members (0001:52), project_access (0001:81),
 *   issue_subscriptions (0114:86), messages by recipient — the whole inbox
 *   (0074:23), user_prefs (0036:11), agent_keys by profile (0100:47),
 *   mcp_tokens (0030:11).
 *
 * Storage: the avatar bytes die HERE (phase 5 on); phase 7 owns only avatar
 * upload/serving (setAvatar/clearAvatar and their replace-time deletes) and
 * the attachment upload path — attachment bytes die with their issue in
 * deleteIssueDeep, never with a profile. */
export async function removeProfile(
  ctx: MutationCtx,
  a: { profile: Doc<'profiles'>; now: string },
): Promise<void> {
  const { profile, now } = a
  // SET NULL + touch (collect first: the patch moves rows out of the index)
  const assigned = await ctx.db
    .query('issues')
    .withIndex('by_assignee', (q) => q.eq('assignee_id', profile.id))
    .collect()
  for (const i of assigned) {
    await ctx.db.patch(i._id, { assignee_id: undefined, updated_at: now })
    const after = (await ctx.db.get(i._id)) as Doc<'issues'>
    await emitTaskEvent(ctx, { name: 'task.updated', issue: after, before: i, now })
  }
  const reviewing = await ctx.db
    .query('issues')
    .withIndex('by_reviewer', (q) => q.eq('reviewer_id', profile.id))
    .collect()
  for (const i of reviewing) {
    await ctx.db.patch(i._id, { reviewer_id: undefined, updated_at: now })
    const after = (await ctx.db.get(i._id)) as Doc<'issues'>
    await emitTaskEvent(ctx, { name: 'task.updated', issue: after, before: i, now })
  }
  const created = await ctx.db
    .query('issues')
    .withIndex('by_created_by', (q) => q.eq('created_by', profile.id))
    .collect()
  for (const i of created) {
    await ctx.db.patch(i._id, { created_by: undefined, updated_at: now })
    const after = (await ctx.db.get(i._id)) as Doc<'issues'>
    await emitTaskEvent(ctx, { name: 'task.updated', issue: after, before: i, now })
  }
  const reported = await ctx.db
    .query('issues')
    .withIndex('by_reporter', (q) => q.eq('reporter_id', profile.id))
    .collect()
  for (const i of reported) {
    await ctx.db.patch(i._id, { reporter_id: undefined, updated_at: now })
    const after = (await ctx.db.get(i._id)) as Doc<'issues'>
    await emitTaskEvent(ctx, { name: 'task.updated', issue: after, before: i, now })
  }
  // SET NULL, no touch
  const led = await ctx.db
    .query('projects')
    .withIndex('by_lead', (q) => q.eq('lead_id', profile.id))
    .collect()
  for (const p of led) await ctx.db.patch(p._id, { lead_id: undefined })
  const acted = await ctx.db
    .query('activity_events')
    .withIndex('by_actor', (q) => q.eq('actor_id', profile.id))
    .collect()
  for (const e of acted) await ctx.db.patch(e._id, { actor_id: undefined })
  const authored = await ctx.db
    .query('comments')
    .withIndex('by_author', (q) => q.eq('author', profile.id))
    .collect()
  for (const c of authored) await ctx.db.patch(c._id, { author: undefined })
  const edited = await ctx.db
    .query('comments')
    .withIndex('by_edited_by', (q) => q.eq('edited_by', profile.id))
    .collect()
  for (const c of edited) await ctx.db.patch(c._id, { edited_by: undefined })
  const sent = await ctx.db
    .query('messages')
    .withIndex('by_actor', (q) => q.eq('actor_id', profile.id))
    .collect()
  for (const m of sent) await ctx.db.patch(m._id, { actor_id: undefined })
  const orgProfiles = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', profile.org_id))
    .collect()
  for (const p of orgProfiles) {
    if (p.kind !== 'agent') continue
    const keys = await ctx.db
      .query('agent_keys')
      .withIndex('by_profile', (q) => q.eq('profile_id', p.id))
      .collect()
    for (const k of keys) {
      if (k.created_by === profile.id) await ctx.db.patch(k._id, { created_by: undefined })
    }
  }
  const orgIssues = await ctx.db
    .query('issues')
    .withIndex('by_org', (q) => q.eq('org_id', profile.org_id))
    .collect()
  for (const i of orgIssues) {
    const atts = await ctx.db
      .query('issue_attachments')
      .withIndex('by_issue', (q) => q.eq('issue_id', i.id))
      .collect()
    for (const att of atts) {
      if (att.uploaded_by === profile.id) await ctx.db.patch(att._id, { uploaded_by: undefined })
    }
  }
  // DELETE
  const memberships = ctx.db
    .query('team_members')
    .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
  for await (const tm of memberships) await ctx.db.delete(tm._id)
  const grants = ctx.db
    .query('project_access')
    .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
  for await (const g of grants) await ctx.db.delete(g._id)
  const subs = ctx.db
    .query('issue_subscriptions')
    .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
  for await (const s of subs) await ctx.db.delete(s._id)
  const inbox = ctx.db
    .query('messages')
    .withIndex('by_recipient', (q) => q.eq('recipient_id', profile.id))
  for await (const m of inbox) await ctx.db.delete(m._id)
  const prefs = ctx.db
    .query('user_prefs')
    .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
  for await (const up of prefs) await ctx.db.delete(up._id)
  const ownKeys = ctx.db
    .query('agent_keys')
    .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
  for await (const k of ownKeys) await ctx.db.delete(k._id)
  const tokens = ctx.db
    .query('mcp_tokens')
    .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
  for await (const t of tokens) await ctx.db.delete(t._id)
  const connections = ctx.db
    .query('oauth_connections')
    .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
  for await (const connection of connections) {
    const uses = ctx.db
      .query('oauth_credential_uses')
      .withIndex('by_connection', (q) => q.eq('connection_id', connection.id))
    for await (const use of uses) await ctx.db.delete(use._id)
    await ctx.db.delete(connection._id)
  }
  // Usage remains owed by the organization after its profile departs.
  await deleteProfileRateLimit(ctx, profile.id)
  // storage, then the row — ctx.storage.delete is transactional
  if (profile.avatar_storage_id !== undefined) await ctx.storage.delete(profile.avatar_storage_id)
  await ctx.db.delete(profile._id)
}

/* The whole organization, every org-scoped row and byte, then the org row —
 * the fixture teardown (internal/guestOrg) and the operator's one-off org
 * removals. Postgres's reset_demo ran 13 ordered deletes with ON DELETE
 * CASCADE under issues (comments, issue_labels, issue_subscriptions,
 * issue_attachments) and profiles (user_prefs, agent_keys, mcp_tokens,
 * messages via recipient); each is explicit here, right after its parent.
 * Deliberately NOT swept, because none of it is org-scoped: Better Auth
 * users (a login may hold seats elsewhere — adminAuth.deleteOrphanLogin is
 * the operator's tool once no profile references it), the appearance tables
 * and roadmap_history (per login, cleared with the login), demo_sessions
 * (internal/demoCleanup owns the public demo's lifecycle) and the platform
 * audit log (history survives its subjects). No narration: nothing is left to
 * read it. */
export async function deleteOrgDeep(ctx: MutationCtx, org: Doc<'organizations'>): Promise<void> {
  const subscriptions = await ctx.db
    .query('billing_subscriptions')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()
  // Provider accounting and exposed checkouts need an explicit lifecycle;
  // deleting local ownership must never leave a payable hosted subscription.
  for (const sub of subscriptions)
    require(!sub.polar_subscription_id && !hasPendingCheckout(sub), rule(
      'Resolve provider billing and pending checkout before deleting this organization.',
    ))
  for (const sub of subscriptions) await ctx.db.delete(sub._id)
  for (const row of await ctx.db
    .query('billing_periods')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect())
    await ctx.db.delete(row._id)
  for (const table of ['billing_usage', 'billing_usage_totals', 'billing_events'] as const)
    for (const row of await ctx.db
      .query(table)
      .withIndex('by_org_period', (q) => q.eq('org_id', org.id))
      .collect())
      await ctx.db.delete(row._id)
  for (const row of await ctx.db
    .query('billing_notices')
    .filter((q) => q.eq(q.field('org_id'), org.id))
    .collect())
    await ctx.db.delete(row._id)

  for (const a of await ctx.db
    .query('activity_events')
    .withIndex('by_org_ts', (q) => q.eq('org_id', org.id))
    .collect()) {
    await ctx.db.delete(a._id)
  }

  for (const table of [
    'webhook_events',
    'webhook_health',
    'webhook_subscriptions',
    'webhook_deliveries',
  ] as const) {
    for (const row of await ctx.db
      .query(table)
      .withIndex('by_org', (q) => q.eq('org_id', org.id))
      .collect())
      await ctx.db.delete(row._id)
  }

  const issues = await ctx.db
    .query('issues')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()
  const linkIds = new Set<Id<'issue_links'>>()
  for (const i of issues) {
    for (const l of await ctx.db
      .query('issue_links')
      .withIndex('by_source', (q) => q.eq('source_id', i.id))
      .collect())
      linkIds.add(l._id)
    for (const l of await ctx.db
      .query('issue_links')
      .withIndex('by_target', (q) => q.eq('target_id', i.id))
      .collect())
      linkIds.add(l._id)
  }
  for (const id of linkIds) await ctx.db.delete(id)
  for (const i of issues) {
    for (const c of await ctx.db
      .query('comments')
      .withIndex('by_issue', (q) => q.eq('issue_id', i.id))
      .collect())
      await ctx.db.delete(c._id)
    for (const il of await ctx.db
      .query('issue_labels')
      .withIndex('by_issue', (q) => q.eq('issue_id', i.id))
      .collect())
      await ctx.db.delete(il._id)
    for (const s of await ctx.db
      .query('issue_subscriptions')
      .withIndex('by_issue', (q) => q.eq('issue_id', i.id))
      .collect())
      await ctx.db.delete(s._id)
    for (const a of await ctx.db
      .query('issue_attachments')
      .withIndex('by_issue', (q) => q.eq('issue_id', i.id))
      .collect()) {
      await ctx.storage.delete(a.storage_id)
      await ctx.db.delete(a._id)
    }
    await ctx.db.delete(i._id)
  }

  for (const p of await ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()) {
    for (const g of await ctx.db
      .query('project_access')
      .withIndex('by_project', (q) => q.eq('project_id', p.id))
      .collect())
      await ctx.db.delete(g._id)
    for (const g of await ctx.db
      .query('project_team_access')
      .withIndex('by_project', (q) => q.eq('project_id', p.id))
      .collect())
      await ctx.db.delete(g._id)
    for (const m of await ctx.db
      .query('milestones')
      .withIndex('by_project', (q) => q.eq('project_id', p.id))
      .collect())
      await ctx.db.delete(m._id)
    await ctx.db.delete(p._id)
  }

  for (const l of await ctx.db
    .query('labels')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()) {
    await ctx.db.delete(l._id)
  }

  for (const t of await ctx.db
    .query('teams')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()) {
    for (const m of await ctx.db
      .query('team_members')
      .withIndex('by_team', (q) => q.eq('team_id', t.id))
      .collect())
      await ctx.db.delete(m._id)
    await ctx.db.delete(t._id)
  }

  for (const pr of await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()) {
    for (const u of await ctx.db
      .query('user_prefs')
      .withIndex('by_profile', (q) => q.eq('profile_id', pr.id))
      .collect())
      await ctx.db.delete(u._id)
    for (const k of await ctx.db
      .query('agent_keys')
      .withIndex('by_profile', (q) => q.eq('profile_id', pr.id))
      .collect())
      await ctx.db.delete(k._id)
    for (const t of await ctx.db
      .query('mcp_tokens')
      .withIndex('by_profile', (q) => q.eq('profile_id', pr.id))
      .collect())
      await ctx.db.delete(t._id)
    for (const connection of await ctx.db
      .query('oauth_connections')
      .withIndex('by_profile', (q) => q.eq('profile_id', pr.id))
      .collect()) {
      for (const use of await ctx.db
        .query('oauth_credential_uses')
        .withIndex('by_connection', (q) => q.eq('connection_id', connection.id))
        .collect())
        await ctx.db.delete(use._id)
      await ctx.db.delete(connection._id)
    }
    for (const m of await ctx.db
      .query('messages')
      .withIndex('by_recipient', (q) => q.eq('recipient_id', pr.id))
      .collect())
      await ctx.db.delete(m._id)
    await deleteProfileRateLimit(ctx, pr.id)
    if (pr.avatar_storage_id !== undefined) await ctx.storage.delete(pr.avatar_storage_id)
    await ctx.db.delete(pr._id)
  }

  // the Northstar importer's ownership receipt names the org (one-row table)
  for (const r of await ctx.db.query('marketing_demo').collect()) {
    if (r.org_id === org.id) await ctx.db.delete(r._id)
  }
  await ctx.db.delete(org._id)
}

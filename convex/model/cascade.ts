/* Deep deletes: every FK edge the Postgres schema resolved with ON DELETE,
 * spelled out, for teams (deleteTeamDeep), profiles (removeProfile) and
 * whole organizations (deleteOrgDeep). Every task and project delete, in the
 * app and over REST and MCP, moves the work to Deleted items instead
 * (model/deletedItems.ts), and the Northstar wipe deletes in bounded batches
 * (model/orgDeletion.ts wipeWorkStep).
 *
 * Activity rows STAY here, "History survives its subjects" (0001:144);
 * activity_events carries no issue FK, target_id is plain text (0026).
 * Deleting a task for good from Deleted items deletes its history instead
 * (model/deletedItems.ts purgeHistory). */

import { makeFunctionReference } from 'convex/server'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { REMOVAL_PHASES } from '../lib/enums'
import { require, rule } from '../lib/functions'
import { LIMITS } from '../lib/limits'
import { hasPendingCheckout } from './billing'
import { clearOrgTrash } from './deletedItems'
import { estimateDocumentBytes } from './demoMetrics'
import type { TaskPatch } from './descriptions'
import { releaseFile } from './fileHolds'
import { recipientItems, stateRows } from './inboxItems'
import { deleteSweepRow } from './messages'
import { deleteOrgBookkeeping } from './orgs'
import { deleteStamp } from './syncStamps'
import { emitTaskEvent } from './taskEvents'
import { countingOrg, countMemberRemoved, deleteTeamCount } from './teamCounts'
import { releaseUsedIds } from './usedIds'

async function deleteProfileRateLimit(ctx: MutationCtx, profileId: string): Promise<void> {
  const rows = ctx.db
    .query('machine_rate_limits')
    .withIndex('by_key', (q) => q.eq('key', `profile:${profileId}`))
  for await (const row of rows) await ctx.db.delete(row._id)
}

/* delete_team's cascade (0081:458-471 authorizes). Projects are independent
 * of teams, so deleting a team removes its permission grants and clears the
 * legacy ownership column while preserving projects, tasks and milestones.
 * Memberships die (team_members.team_id CASCADE, 0001:51), labels are
 * org-level and SURVIVE (0010/0078). Activity rows survive and keep their
 * team_id, unlike 0001:156's SET NULL. Membership rows reach no client;
 * organization admins read them in the export. Guards — 'team not found', 'only organization
 * admins can delete teams', the last-team guard — live in the callers
 * (teams.deleteDeep, model/teams.ts deleteTeamCore), which also settle the
 * members' open tasks and narrate no deletion (the old client wrote no
 * event). A deployment counts each row it changes as one of Convex's 4,096
 * reads, so the callers bound the rows first (model/teams.ts assertTeamFits,
 * LIMITS.teamDeleteRows). `guard`, when given, runs before every
 * TEAM_DELETE_GUARD_ROWS rows, so a deletion that shares its transaction with
 * other reads can stop before it fills it. `owned`, when given, is the
 * team's legacy owned projects as the caller already read them, so a large
 * old description is not read twice. */
export async function deleteTeamDeep(
  ctx: MutationCtx,
  a: {
    team: Doc<'teams'>
    actor: Doc<'profiles'>
    now: string
    guard?: () => Promise<void>
    owned?: readonly Doc<'projects'>[]
  },
): Promise<void> {
  const { team } = a
  let rows = 0
  const next = async () => {
    if (a.guard !== undefined && rows++ % TEAM_DELETE_GUARD_ROWS === 0) await a.guard()
  }
  const legacyOwnedProjects =
    a.owned ??
    (await ctx.db
      .query('projects')
      .withIndex('by_team', (q) => q.eq('team_id', team.id))
      .collect())
  for (const project of legacyOwnedProjects) {
    await next()
    await ctx.db.patch(project._id, { team_id: undefined })
  }
  const shared = ctx.db
    .query('project_team_access')
    .withIndex('by_team', (q) => q.eq('team_id', team.id))
  for await (const grant of shared) {
    await next()
    await ctx.db.delete(grant._id)
  }
  const members = ctx.db.query('team_members').withIndex('by_team', (q) => q.eq('team_id', team.id))
  for await (const tm of members) {
    await next()
    await ctx.db.delete(tm._id)
  }
  await deleteTeamCount(ctx, team.id)
  await ctx.db.delete(team._id)
}

/* How many rows deleteTeamDeep changes between two runs of its guard: well
 * under the 5% of Convex's 4,096 reads a removal keeps
 * (model/projectAccess.ts REASSIGN_ROOM). */
const TEAM_DELETE_GUARD_ROWS = 100

/* The four task fields that name a profile, each with its own index. A
 * removal clears them in this order, so the fields that route work go
 * first when its budget runs out. */
export const TASK_HOLDERS = ['assignee_id', 'reviewer_id', 'created_by', 'reporter_id'] as const
export type TaskHolder = (typeof TASK_HOLDERS)[number]

/** The tasks whose `holder` field names `profileId`, read through that
 * field's index. `open` keeps only unarchived tasks. Returns a new query on
 * every call, because a query runs once. */
export function heldTasks(ctx: QueryCtx, holder: TaskHolder, profileId: string, open: boolean) {
  const issues = ctx.db.query('issues')
  switch (holder) {
    case 'assignee_id':
      return issues.withIndex('by_assignee_archived', (q) =>
        open
          ? q.eq('assignee_id', profileId).eq('archived_at', undefined)
          : q.eq('assignee_id', profileId),
      )
    case 'reviewer_id':
      return issues.withIndex('by_reviewer_archived', (q) =>
        open
          ? q.eq('reviewer_id', profileId).eq('archived_at', undefined)
          : q.eq('reviewer_id', profileId),
      )
    case 'created_by':
      return issues.withIndex('by_created_by_archived', (q) =>
        open
          ? q.eq('created_by', profileId).eq('archived_at', undefined)
          : q.eq('created_by', profileId),
      )
    case 'reporter_id':
      return issues.withIndex('by_reporter_archived', (q) =>
        open
          ? q.eq('reporter_id', profileId).eq('archived_at', undefined)
          : q.eq('reporter_id', profileId),
      )
  }
}

/** Clears `holder` on `task` with the SQL SET NULL's touch (updated_at =
 * `now`) and emits task.updated. It posts no inbox message. The task is not
 * read again, because its new state is `task` with the patch applied. */
export async function clearHolder(
  ctx: MutationCtx,
  task: Doc<'issues'>,
  holder: TaskHolder,
  now: string,
): Promise<void> {
  const patch: TaskPatch = { updated_at: now }
  patch[holder] = undefined
  await ctx.db.patch(task._id, patch)
  await emitTaskEvent(ctx, {
    name: 'task.updated',
    issue: { ...task, ...patch },
    before: task,
    now,
  })
}

/** What one part of a removal may clear. removeProfile spends one budget on
 * open tasks and the bytes of another on access rows, and each background
 * step (profileRemovals.ts) spends one. A mutable object, so tests can lower
 * it. */
export const REMOVAL_BUDGET = { rows: 256, bytes: 4 * 1024 * 1024 }

/** The most OAuth connections removeProfile revokes itself. The background
 * step deletes the rest, which can no longer be used anyway. */
export const REVOKE_AT_ONCE = 256

export type RemovalBudget = { rows: number; bytes: number }

/** Whether `budget` has run out of rows or of bytes. */
export const budgetSpent = (budget: RemovalBudget): boolean => budget.rows <= 0 || budget.bytes <= 0

/** Clears the rows of `rows`, an index range read in one pass, until the
 * range ends (true) or the budget is spent (false). A budget not yet spent
 * clears at least one row, however large. Bytes are estimated from each
 * cleared document. `clear` must move each row out of the range, because
 * the next step reads the range from its start again.
 *
 * One pass, rather than a page at a time from the start of the range, keeps
 * a step to one read of the range: each read from the start passes again
 * every row the transaction already cleared there, and the local backend
 * reads a whole index range for each query whatever its limit. Clearing 256
 * of 20,000 rows took 10.3 s read four at a time and 0.5 s in one pass.
 * Convex charges a pass only for the documents it reaches. */
export async function sweep<Row>(
  budget: RemovalBudget,
  rows: AsyncIterable<Row>,
  clear: (row: Row) => Promise<void>,
): Promise<boolean> {
  if (budgetSpent(budget)) return false
  for await (const row of rows) {
    await clear(row)
    budget.rows -= 1
    budget.bytes -= estimateDocumentBytes(row)
    if (budgetSpent(budget)) return false
  }
  return true
}

/** The unfinished background removal of `profileId`, or null. While it
 * exists, the id stays reserved (profiles.create). Once it is gone, the id
 * stays taken in its organization if that organization's API usage names it
 * (model/billingUsage.ts usageNamesProfile). */
export function pendingRemoval(ctx: QueryCtx, profileId: string) {
  return ctx.db
    .query('profile_removals')
    .withIndex('by_profile', (q) => q.eq('profile_id', profileId))
    .unique()
}

const removalStepRef = makeFunctionReference<'mutation', { profile_id: string }, null>(
  'profileRemovals:step',
)

/** The most access rows (deleteAccessRows) removeProfile deletes itself; the
 * profile removal access phase deletes the rest. A mutable object, so tests
 * can lower it. */
export const ACCESS_FIRST_PASS = { rows: 512 }

type AccessTable = 'agent_keys' | 'mcp_tokens' | 'team_members' | 'project_access' | 'user_prefs'

/* The rows that give a profile access or hold its own settings, each read
 * through its by_profile index, in the order a removal deletes them. Rows
 * left after the profile row is gone grant nothing, because every reader
 * asks with a live profile or drops ids without one:
 * - agent_keys, mcp_tokens: machine/auth.ts lookupCredential refuses a
 *   credential whose profile is gone, and the lists read through live
 *   seats (tokens.ts, apiAccess.ts).
 * - team_members, project_access: lib/access.ts asks by a resolved
 *   profile, and the snapshot sends only rows whose profile it sends. A
 *   membership left still counts in its team's member count until a
 *   background step deletes it (model/teamCounts.ts).
 * - user_prefs: only the person's own seats read them (prefs.ts). */
const ACCESS_RANGES: ((
  ctx: QueryCtx,
  profileId: string,
) => {
  [Symbol.asyncIterator](): AsyncIterator<Doc<AccessTable>>
  first(): Promise<Doc<AccessTable> | null>
})[] = [
  (ctx, profileId) =>
    ctx.db.query('agent_keys').withIndex('by_profile', (q) => q.eq('profile_id', profileId)),
  (ctx, profileId) =>
    ctx.db.query('mcp_tokens').withIndex('by_profile', (q) => q.eq('profile_id', profileId)),
  (ctx, profileId) =>
    ctx.db.query('team_members').withIndex('by_profile', (q) => q.eq('profile_id', profileId)),
  (ctx, profileId) =>
    ctx.db.query('project_access').withIndex('by_profile', (q) => q.eq('profile_id', profileId)),
  (ctx, profileId) =>
    ctx.db.query('user_prefs').withIndex('by_profile', (q) => q.eq('profile_id', profileId)),
]

/** Deletes the access rows of `profileId` (ACCESS_RANGES) until none is
 * left (true) or `budget` is spent (false), each range in one pass (sweep).
 * `countedIn` is the organization whose team counts count the profile's
 * memberships (model/teamCounts.ts), which each deleted membership leaves. */
export async function deleteAccessRows(
  ctx: MutationCtx,
  profileId: string,
  budget: RemovalBudget,
  countedIn: string | null,
): Promise<boolean> {
  for (const range of ACCESS_RANGES)
    if (
      !(await sweep(budget, range(ctx, profileId), async (row) => {
        await ctx.db.delete(row._id)
        if ('team_id' in row) await countMemberRemoved(ctx, row, countedIn)
      }))
    )
      return false
  return true
}

/** Whether any access row of `profileId` is left (ACCESS_RANGES). */
export async function accessRowsRemain(ctx: QueryCtx, profileId: string): Promise<boolean> {
  for (const range of ACCESS_RANGES) if ((await range(ctx, profileId).first()) !== null) return true
  return false
}

/** The activity rows this transaction clears; the profile removal activity
 * phase clears the rest. */
const ACTED_ROWS_FIRST_PASS = 500

/* remove_member's cascade (0100:206-222 authorizes; the FK graph resolves).
 * Guards live in the callers (profiles.remove, adminOrgs.cancelInvite):
 * 'user not found' / 'you cannot remove yourself' / 'cannot remove the last
 * admin', and the caller writes the 'removed' narration. The cascade itself
 * logs nothing, exactly like the SQL FK resolution.
 *
 * The work is split so that removal stays within one transaction's limits
 * however much work and history the profile holds. This transaction ends
 * access. It deletes the profile row, lets go of its picture and deletes the rate-limit
 * row, clears the profile from every project it leads (refusing past
 * LIMITS.removalLeads.max), and revokes the OAuth connections as 'deleted', so
 * the person's own list hides them at once. Every session, credential and
 * OAuth path requires the profile row, so access fails closed here. It
 * deletes the first ACCESS_FIRST_PASS.rows of its own agent keys, MCP
 * tokens, memberships, grants and preferences (ACCESS_RANGES, which says why
 * the rest grant nothing), and clears its newest ACTED_ROWS_FIRST_PASS
 * activity rows and as many open tasks as REMOVAL_BUDGET allows, assignee
 * and reviewer fields first. That is every row unless the profile holds
 * hundreds. Then it inserts the profile_removals row and schedules the first
 * background step (profileRemovals.ts), which deletes the access rows left
 * over and clears the open tasks left over, archived tasks, its older
 * activity rows, comments, messages, subscriptions, attachments, agent keys
 * it created and the revoked connections in bounded steps. Readers already
 * show an id that no longer resolves as "Someone" or "Unknown user" until
 * then.
 *
 * Three FK behaviors, spelled out:
 * - SET NULL + touch: issues.assignee_id (0001:94), issues.reviewer_id,
 *   issues.created_by (0041:5), and issues.reporter_id. The FK UPDATE fired
 *   issues_touch, so each patched issue is stamped updated_at (the
 *   stale-dimming filter reads it; old client mirror bc022c2:3471-3478). No
 *   notify; removeProfile lists touch only. A cleared reviewer leaves
 *   issues.review_at as it is: the task still waits from its hand-off.
 * - SET NULL, no touch: projects.lead_id (0001:65), activity_events.actor_id
 *   (0001:149, rows KEPT, history survives its actor), comments.author /
 *   comments.edited_by (0054:15/19), messages.actor_id (0074:24),
 *   agent_keys.created_by (0100:51), issue_attachments.uploaded_by (0018:23).
 * - DELETE: team_members (0001:52), project_access (0001:81),
 *   issue_subscriptions (0114:86), messages by recipient, the whole inbox
 *   (0074:23), user_prefs (0036:11), the Team sync stamp (sync_stamps),
 *   the read-message sweep row (message_sweeps), agent_keys by profile
 *   (0100:47), mcp_tokens (0030:11).
 *
 * Storage: the avatar is let go HERE (phase 5 on), and held for a restore
 * before it is erased (model/fileHolds.ts); phase 7 owns only avatar
 * upload/serving (setAvatar/clearAvatar and their replace-time releases) and
 * the attachment upload path. Attachment files go with their task, in
 * Deleted items or deleteOrgDeep, never with a profile. */
export async function removeProfile(
  ctx: MutationCtx,
  a: { profile: Doc<'profiles'>; now: string },
): Promise<void> {
  const { profile, now } = a
  // SET NULL, no touch. A project's lead controls it, and several paths
  // compare the stored lead with the one a client last saw, so every lead
  // goes in this transaction, up to LIMITS.removalLeads.max.
  const led = await ctx.db
    .query('projects')
    .withIndex('by_lead', (q) => q.eq('lead_id', profile.id))
    .take(LIMITS.removalLeads.max + 1)
  if (led.length > LIMITS.removalLeads.max) throw rule(LIMITS.removalLeads.refusal)
  for (const p of led) await ctx.db.patch(p._id, { lead_id: undefined })
  // DELETE, credentials first, within ACCESS_FIRST_PASS.rows rows. Every
  // reader of the rest ends with the profile row deleted below
  // (ACCESS_RANGES), and the profile removal access phase deletes them.
  // Memberships left keep counting in their teams through the removal row
  // (counted_org_id) until that phase deletes them.
  const countedIn = countingOrg(profile)
  await deleteAccessRows(
    ctx,
    profile.id,
    { rows: ACCESS_FIRST_PASS.rows, bytes: REMOVAL_BUDGET.bytes },
    countedIn,
  )
  const membershipsLeft =
    countedIn !== null &&
    (await ctx.db
      .query('team_members')
      .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
      .first()) !== null
  // SET NULL + touch on open tasks within one budget, in TASK_HOLDERS order.
  // Each clear reads and writes the whole task, and a task the profile
  // created and reports is cleared once per field, so an unbounded pass
  // fails for a busy agent. The first step's tasks phase clears the rest.
  const budget: RemovalBudget = { ...REMOVAL_BUDGET }
  for (const holder of TASK_HOLDERS) {
    const cleared = await sweep(budget, heldTasks(ctx, holder, profile.id, true), (task) =>
      clearHolder(ctx, task, holder, now),
    )
    if (!cleared) break
  }
  // The newest rows first. A busy agent can have thousands more; the
  // profile removal activity phase clears them.
  const acted = await ctx.db
    .query('activity_events')
    .withIndex('by_actor', (q) => q.eq('actor_id', profile.id))
    .order('desc')
    .take(ACTED_ROWS_FIRST_PASS)
  for (const e of acted) await ctx.db.patch(e._id, { actor_id: undefined })
  // the person's Team sync stamp and read-message sweep row, one row each
  // (model/syncStamps.ts, model/messages.ts lowerSweepDue)
  await deleteStamp(ctx, profile.id)
  await deleteSweepRow(ctx, profile.id)
  // The background step deletes the connections with their replay hashes.
  // Every OAuth path already refuses once the profile row is gone, so this
  // only hides the newest connections from the person's own list at once;
  // every authorization adds a row and revoked ones stay, so the rest wait
  // for the step instead of making this transaction unbounded.
  const connections = await ctx.db
    .query('oauth_connections')
    .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
    .order('desc')
    .take(REVOKE_AT_ONCE)
  for (const connection of connections) {
    if (connection.revoked_at !== undefined && connection.revocation_reason === 'deleted') continue
    await ctx.db.patch(connection._id, {
      revoked_at: connection.revoked_at ?? now,
      revocation_reason: 'deleted',
    })
  }
  // Usage remains owed by the organization after its profile departs.
  await deleteProfileRateLimit(ctx, profile.id)
  const scheduled_id = await ctx.scheduler.runAfter(0, removalStepRef, { profile_id: profile.id })
  // A row left by an earlier removal of the same id starts over, still
  // counting the memberships it counted.
  const earlier = await pendingRemoval(ctx, profile.id)
  const counted_org_id = membershipsLeft ? (countedIn ?? undefined) : earlier?.counted_org_id
  const job = {
    profile_id: profile.id,
    removed_at: now,
    phase: REMOVAL_PHASES[0],
    progress_at: new Date().toISOString(),
    scheduled_id,
    ...(counted_org_id !== undefined ? { counted_org_id } : {}),
  }
  if (earlier) await ctx.db.replace(earlier._id, job)
  else await ctx.db.insert('profile_removals', job)
  // the row, then its picture, which is held for a restore (model/fileHolds.ts)
  await ctx.db.delete(profile._id)
  await releaseFile(ctx, profile.avatar_storage_id)
}

/** The whole organization, every org-scoped row and byte, then the org row,
 * in one transaction. The fixture teardown (internal/guestOrg) and the
 * operator's one-off org removals use it; a customer's deletion runs in
 * bounded steps instead (model/orgDeletion.ts). Postgres's reset_demo ran 13
 * ordered deletes with ON DELETE CASCADE under issues (comments,
 * issue_labels, issue_subscriptions, issue_attachments) and profiles
 * (user_prefs, agent_keys, mcp_tokens, messages via recipient); each is
 * explicit here, right after its parent, as are a profile's inbox items and
 * their build state after its messages (model/inboxItems.ts). The used_ids
 * rows of the ids its tasks and projects held go after the org row
 * (model/usedIds.ts).
 * Deliberately NOT swept, because none of it is org-scoped: Better Auth
 * users (a login may hold seats elsewhere — adminAuth.deleteOrphanLogin is
 * the operator's tool once no profile references it), the appearance tables
 * and roadmap_history (per login, cleared with the login), demo_sessions
 * (internal/demoCleanup owns the public demo's lifecycle) and the platform
 * audit log (history survives its subjects until auditRetention.ts deletes
 * it after 90 days). Neither are activity_retention or comment_counts rows an
 * earlier release left, tables the schema no longer lists. Pending profile_removals rows
 * are also left alone. Their background steps still delete the removed
 * profiles' keys, tokens, preferences, inboxes and OAuth connections, which
 * this sweep only reaches through live profiles. So are pending name_copies
 * rows. A step deletes its row once the profile or team it names is gone
 * (nameCopies.ts). Deleted items go first, whatever state they are in,
 * with the rows they still kept in the live tables and their bytes
 * (model/deletedItems.ts clearOrgTrash); tasks a moving project left behind
 * are then gone too. No narration: nothing is left to read it. */
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
    .query('billing_usage_accounts')
    .withIndex('by_org_period_profile', (q) => q.eq('org_id', org.id))
    .collect())
    await ctx.db.delete(row._id)
  for (const row of await ctx.db
    .query('billing_month_totals')
    .withIndex('by_org_period_shard', (q) => q.eq('org_id', org.id))
    .collect())
    await ctx.db.delete(row._id)
  for (const row of await ctx.db
    .query('billing_notices')
    .filter((q) => q.eq(q.field('org_id'), org.id))
    .collect())
    await ctx.db.delete(row._id)
  for (const row of await ctx.db
    .query('usage_months')
    .withIndex('by_org_month', (q) => q.eq('org_id', org.id))
    .collect())
    await ctx.db.delete(row._id)
  for (const row of await ctx.db
    .query('usage_counts')
    .withIndex('by_org_month_metric', (q) => q.eq('org_id', org.id))
    .collect())
    await ctx.db.delete(row._id)

  for (const a of await ctx.db
    .query('activity_events')
    .withIndex('by_org_ts', (q) => q.eq('org_id', org.id))
    .collect()) {
    await ctx.db.delete(a._id)
  }

  await clearOrgTrash(ctx, org.id, { left: Number.POSITIVE_INFINITY })

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
      .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', i.id))
      .collect())
      await ctx.db.delete(s._id)
    for (const a of await ctx.db
      .query('issue_attachments')
      .withIndex('by_issue', (q) => q.eq('issue_id', i.id))
      .collect()) {
      await ctx.db.delete(a._id)
      await releaseFile(ctx, a.storage_id)
    }
    await ctx.db.delete(i._id)
  }
  // the tasks' description rows (model/descriptions.ts), any left by a
  // task gone without its row included
  for (const d of await ctx.db
    .query('issue_descriptions')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect())
    await ctx.db.delete(d._id)
  // the comment counts and post logs of its tasks, those in Deleted items too
  for (const table of ['task_comment_counts', 'comment_rates'] as const)
    for (const row of await ctx.db
      .query(table)
      .withIndex('by_org', (q) => q.eq('org_id', org.id))
      .collect())
      await ctx.db.delete(row._id)

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

  // the label and team counts, and any left without their label or team
  for (const table of ['label_counts', 'team_counts'] as const)
    for (const row of await ctx.db
      .query(table)
      .withIndex('by_org', (q) => q.eq('org_id', org.id))
      .collect())
      await ctx.db.delete(row._id)

  for (const pr of await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()) {
    for (const u of await ctx.db
      .query('user_prefs')
      .withIndex('by_profile', (q) => q.eq('profile_id', pr.id))
      .collect())
      await ctx.db.delete(u._id)
    await deleteStamp(ctx, pr.id)
    await deleteSweepRow(ctx, pr.id)
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
    for (const item of await recipientItems(ctx, pr.id).collect()) await ctx.db.delete(item._id)
    for (const state of await stateRows(ctx, pr.id).collect()) await ctx.db.delete(state._id)
    await deleteProfileRateLimit(ctx, pr.id)
    await ctx.db.delete(pr._id)
    await releaseFile(ctx, pr.avatar_storage_id)
  }
  // a Team sync stamp row left without its profile, by a rollback or a
  // manual edit
  for (const stamp of await ctx.db
    .query('sync_stamps')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect())
    await ctx.db.delete(stamp._id)

  // The task and project storage totals. Only clearOrgTrash above takes
  // files out of them, so the rest go here, in the same transaction as the
  // files; the organization's row goes with deleteOrgBookkeeping.
  for (const row of await ctx.db
    .query('storage_task_totals')
    .withIndex('by_org_issue', (q) => q.eq('org_id', org.id))
    .collect())
    await ctx.db.delete(row._id)
  for (const row of await ctx.db
    .query('storage_project_totals')
    .withIndex('by_org_bytes', (q) => q.eq('org_id', org.id))
    .collect())
    await ctx.db.delete(row._id)

  // the Northstar importer's ownership receipt names the org (one-row table)
  for (const r of await ctx.db.query('marketing_demo').collect()) {
    if (r.org_id === org.id) await ctx.db.delete(r._id)
  }
  // a scheduled or running deletion (orgRemovals.ts) has nothing left to
  // do, nor what it recorded of the access it deleted
  for (const removal of await ctx.db
    .query('org_removals')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect())
    await ctx.db.delete(removal._id)
  for (const removed of await ctx.db
    .query('removed_access')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect())
    await ctx.db.delete(removed._id)
  await deleteOrgBookkeeping(ctx, org.id)
  await ctx.db.delete(org._id)
  // last, the ids its tasks and projects held, so a later task or project
  // may take them, as internal/guestOrg.ts rebuilds its fixture with its own
  await releaseUsedIds(ctx, org.id, { left: Number.POSITIVE_INFINITY })
}

/* Deletes one organization in bounded steps (orgRemovals.ts schedules them).
 *
 * Every org-scoped row and stored file goes, children before their parents,
 * as model/cascade.ts deleteOrgDeep lists them, but spread over as many
 * transactions as the data needs. Each step spends one REMOVAL_BUDGET and
 * reads every range again from its start, so no cursor is kept and a
 * repeated step cannot skip a row. The removal row records the phase that
 * was running when the budget ran out.
 *
 * Profiles go first. Once the removal has a phase, lib/billingAccess.ts
 * assertOrgAvailable refuses every app and machine call into the
 * organization, and deleting the profiles also ends their sessions,
 * credentials and OAuth connections.
 *
 * Left alone, as deleteOrgDeep leaves them: Better Auth logins (a login may
 * hold seats elsewhere), per-login appearance and roadmap history, pending
 * profile_removals and label_removals rows (their own steps finish), the
 * platform audit log and webhook receipts that only name provider ids. */

import type { Doc, Id, TableNames } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { ORG_REMOVAL_PHASES, type OrgRemovalPhase } from '../lib/enums'
import { require, rule } from '../lib/functions'
import {
  budgetSpent,
  LARGE_ROWS_PER_READ,
  REMOVAL_BUDGET,
  type RemovalBudget,
  sweep,
} from './cascade'
import { estimateDocumentBytes } from './demoMetrics'

/* Rows read per index read for small documents. */
const ROWS_PER_READ = 64

type Row = { _id: Id<TableNames> }

/** Deletes the rows `read` returns until the range is empty (true) or the
 * budget is spent (false), running `before` on each row first. */
const drain = <R extends Row>(
  ctx: MutationCtx,
  budget: RemovalBudget,
  read: (n: number) => Promise<R[]>,
  options: { perRead?: number; before?: (row: R) => Promise<void> } = {},
) =>
  sweep(
    budget,
    read,
    async (row) => {
      if (options.before) await options.before(row)
      await ctx.db.delete(row._id)
    },
    options.perRead ?? ROWS_PER_READ,
  )

/** Deletes a stored file if it still exists. */
async function removeFile(ctx: MutationCtx, id: Id<'_storage'> | undefined) {
  if (id !== undefined && (await ctx.db.system.get(id))) await ctx.storage.delete(id)
}

/** Deletes the parent rows `first` finds, each after `children` reports its
 * own ranges empty. */
async function parents<R extends Row>(
  ctx: MutationCtx,
  budget: RemovalBudget,
  first: () => Promise<R | null>,
  children: (row: R) => Promise<boolean>,
  before?: (row: R) => Promise<void>,
): Promise<boolean> {
  while (!budgetSpent(budget)) {
    const row = await first()
    if (!row) return true
    if (!(await children(row))) return false
    if (before) await before(row)
    await ctx.db.delete(row._id)
    budget.rows -= 1
    budget.bytes -= estimateDocumentBytes(row)
  }
  return false
}

/** Runs each range in order and stops at the first one left unfinished. */
async function inOrder(steps: (() => Promise<boolean>)[]): Promise<boolean> {
  for (const step of steps) if (!(await step())) return false
  return true
}

/** Profiles with everything that hangs off them, then their pictures. */
const profileRows = (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  parents(
    ctx,
    budget,
    () =>
      ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .first(),
    (profile) =>
      inOrder([
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('user_prefs')
              .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
              .take(n),
          ),
        () =>
          drain(
            ctx,
            budget,
            (n) =>
              ctx.db
                .query('messages')
                .withIndex('by_recipient', (q) => q.eq('recipient_id', profile.id))
                .take(n),
            { perRead: LARGE_ROWS_PER_READ },
          ),
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('issue_subscriptions')
              .withIndex('by_profile_task_archived', (q) => q.eq('profile_id', profile.id))
              .take(n),
          ),
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('team_members')
              .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
              .take(n),
          ),
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('project_access')
              .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
              .take(n),
          ),
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('agent_keys')
              .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
              .take(n),
          ),
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('mcp_tokens')
              .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
              .take(n),
          ),
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('attachment_uploads')
              .withIndex('by_profile_expiry', (q) => q.eq('profile_id', profile.id))
              .take(n),
          ),
        () =>
          parents(
            ctx,
            budget,
            () =>
              ctx.db
                .query('oauth_connections')
                .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
                .first(),
            (connection) =>
              drain(ctx, budget, (n) =>
                ctx.db
                  .query('oauth_credential_uses')
                  .withIndex('by_connection', (q) => q.eq('connection_id', connection.id))
                  .take(n),
              ),
          ),
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('machine_rate_limits')
              .withIndex('by_key', (q) => q.eq('key', `profile:${profile.id}`))
              .take(n),
          ),
      ]),
    (profile) => removeFile(ctx, profile.avatar_storage_id),
  )

/** Tasks with their links, labels, subscriptions, comments, messages and files. */
const taskRows = (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  parents(
    ctx,
    budget,
    () =>
      ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .first(),
    (issue) =>
      inOrder([
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('issue_links')
              .withIndex('by_source', (q) => q.eq('source_id', issue.id))
              .take(n),
          ),
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('issue_links')
              .withIndex('by_target', (q) => q.eq('target_id', issue.id))
              .take(n),
          ),
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('issue_labels')
              .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
              .take(n),
          ),
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('issue_subscriptions')
              .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', issue.id))
              .take(n),
          ),
        // The count goes before the comments it counts, so a count step
        // scheduled earlier finds no row and ends (model/commentCounts.ts).
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('comment_counts')
              .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
              .take(n),
          ),
        () =>
          drain(
            ctx,
            budget,
            (n) =>
              ctx.db
                .query('comments')
                .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
                .take(n),
            { perRead: LARGE_ROWS_PER_READ },
          ),
        () =>
          drain(
            ctx,
            budget,
            (n) =>
              ctx.db
                .query('messages')
                .withIndex('by_issue_read', (q) => q.eq('issue_id', issue.id))
                .take(n),
            { perRead: LARGE_ROWS_PER_READ },
          ),
        () =>
          drain(
            ctx,
            budget,
            (n) =>
              ctx.db
                .query('issue_attachments')
                .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
                .take(n),
            { before: (row) => removeFile(ctx, row.storage_id) },
          ),
      ]),
  )

/** Projects with their milestones and access grants. */
const projectRows = (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  parents(
    ctx,
    budget,
    () =>
      ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .first(),
    (project) =>
      inOrder([
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('milestones')
              .withIndex('by_project', (q) => q.eq('project_id', project.id))
              .take(n),
          ),
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('project_access')
              .withIndex('by_project', (q) => q.eq('project_id', project.id))
              .take(n),
          ),
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('project_team_access')
              .withIndex('by_project', (q) => q.eq('project_id', project.id))
              .take(n),
          ),
      ]),
  )

/** Teams with their members and project grants. */
const teamRows = (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  parents(
    ctx,
    budget,
    () =>
      ctx.db
        .query('teams')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .first(),
    (team) =>
      inOrder([
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('team_members')
              .withIndex('by_team', (q) => q.eq('team_id', team.id))
              .take(n),
          ),
        () =>
          drain(ctx, budget, (n) =>
            ctx.db
              .query('project_team_access')
              .withIndex('by_team', (q) => q.eq('team_id', team.id))
              .take(n),
          ),
      ]),
  )

/** Labels with any task labels left on them. */
const labelRows = (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  parents(
    ctx,
    budget,
    () =>
      ctx.db
        .query('labels')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .first(),
    (label) =>
      drain(ctx, budget, (n) =>
        ctx.db
          .query('issue_labels')
          .withIndex('by_label', (q) => q.eq('label_id', label.id))
          .take(n),
      ),
  )

/** The organization's activity history. */
const activityRows = (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  drain(
    ctx,
    budget,
    (n) =>
      ctx.db
        .query('activity_events')
        .withIndex('by_org_ts', (q) => q.eq('org_id', orgId))
        .take(n),
    { perRead: LARGE_ROWS_PER_READ },
  )

/** Webhook events, health, deliveries and subscriptions. */
const webhookRows = (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  inOrder(
    (
      ['webhook_events', 'webhook_health', 'webhook_deliveries', 'webhook_subscriptions'] as const
    ).map(
      (table) => () =>
        drain(ctx, budget, (n) =>
          ctx.db
            .query(table)
            .withIndex('by_org', (q) => q.eq('org_id', orgId))
            .take(n),
        ),
    ),
  )

/** Usage, billing events, periods, notices and the subscription row. */
const billingRows = (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  inOrder([
    ...(['billing_usage', 'billing_usage_totals', 'billing_events'] as const).map(
      (table) => () =>
        drain(ctx, budget, (n) =>
          ctx.db
            .query(table)
            .withIndex('by_org_period', (q) => q.eq('org_id', orgId))
            .take(n),
        ),
    ),
    ...(['billing_periods', 'billing_notices', 'billing_subscriptions'] as const).map(
      (table) => () =>
        drain(ctx, budget, (n) =>
          ctx.db
            .query(table)
            .withIndex('by_org', (q) => q.eq('org_id', orgId))
            .take(n),
        ),
    ),
  ])

/** The last step checks that every parent range is empty, then deletes the
 * organization and its removal row. */
async function finish(ctx: MutationCtx, removal: Doc<'org_removals'>): Promise<void> {
  const orgId = removal.org_id
  for (const table of ['issues', 'projects', 'teams', 'profiles', 'labels'] as const)
    require((await ctx.db
      .query(table)
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .first()) === null, rule('Organization deletion left organization data'))
  // the Northstar importer's ownership receipt names the org (one-row table)
  for (const receipt of await ctx.db.query('marketing_demo').collect())
    if (receipt.org_id === orgId) await ctx.db.delete(receipt._id)
  const org = await byId(ctx, 'organizations', orgId)
  if (org) await ctx.db.delete(org._id)
  await ctx.db.delete(removal._id)
}

const PHASE_ROWS: Record<
  Exclude<OrgRemovalPhase, 'finish'>,
  (ctx: MutationCtx, orgId: string, budget: RemovalBudget) => Promise<boolean>
> = {
  profiles: profileRows,
  tasks: taskRows,
  projects: projectRows,
  teams: teamRows,
  labels: labelRows,
  activity: activityRows,
  webhooks: webhookRows,
  billing: billingRows,
}

/** Runs one bounded step of a deletion that has begun. Returns true once the
 * organization and its removal row are gone, or false after saving the phase
 * the next step continues from. */
export async function deleteOrgStep(
  ctx: MutationCtx,
  removal: Doc<'org_removals'>,
): Promise<boolean> {
  require(removal.phase !== undefined, rule('Organization deletion has not begun'))
  const budget: RemovalBudget = { ...REMOVAL_BUDGET }
  let phase: OrgRemovalPhase = removal.phase
  while (!budgetSpent(budget)) {
    if (phase === 'finish') {
      await finish(ctx, removal)
      return true
    }
    if (!(await PHASE_ROWS[phase](ctx, removal.org_id, budget))) break
    phase = ORG_REMOVAL_PHASES[ORG_REMOVAL_PHASES.indexOf(phase) + 1]
  }
  await ctx.db.patch(removal._id, { phase })
  return false
}

/* Deletes one organization in bounded steps (orgRemovals.ts schedules them).
 *
 * Every org-scoped row and stored file goes, children before their parents,
 * as model/cascade.ts deleteOrgDeep lists them, but spread over as many
 * transactions as the data needs. Each step spends one REMOVAL_BUDGET and
 * reads every range again from its start, each in one pass
 * (model/cascade.ts sweep), so no cursor is kept and a repeated step cannot
 * skip a row. The removal row records the phase that
 * was running when the budget ran out, and where a deleted profile's
 * guest-organization marking stopped (guestMarking), the one place a step
 * goes on from a stored position.
 *
 * Profiles go first. Once the removal has a phase, lib/billingAccess.ts
 * assertOrgAvailable refuses every app and machine call into the
 * organization, and deleting the profiles also ends their sessions,
 * credentials and OAuth connections. The phase records each seat and
 * working credential it deletes (removed_access), so their calls are refused
 * with the same reason rather than as a stranger's until the organization
 * is gone. The last steps delete those rows after the organization.
 *
 * Deleted items go next, whatever state their items are in
 * (model/deletedItems.ts clearOrgTrash). The Deleted items steps, their
 * recovery and the nightly expiry already stand still for an organization
 * whose deletion has begun, so nothing moves rows between the live tables
 * and Deleted items while this runs. The items and their jobs go first, so
 * a step still scheduled finds nothing to do; then the rows a move or
 * restore left in the live tables under stored tasks, which the tasks phase
 * cannot reach because those tasks are not in issues; then the stored rows,
 * with the tasks a moving project left under its stored project. Running
 * before the tasks phase, as the public demo's cleanup runs it, leaves the
 * later phases only live rows that nothing in Deleted items still names.
 * A file is let go with its row unless another row still names it, and is
 * held for a restore before it is erased (model/fileHolds.ts).
 *
 * Left alone, as deleteOrgDeep leaves them: Better Auth logins (a login may
 * hold seats elsewhere), per-login appearance and roadmap history, pending
 * profile_removals and label_removals rows (their own steps finish), pending
 * name_copies rows (a step deletes its row once the profile or team it names
 * is gone, nameCopies.ts), the platform audit log, webhook receipts that only name provider ids, and any
 * activity_retention or comment_counts row an earlier release left, tables
 * the schema no longer lists. */

import type { Doc, Id, TableNames } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { findAuthUser, loginBanned, tokenExpired } from '../lib/access'
import { markHomeProfileRemoved } from '../lib/billableUsers'
import { orgRemovalFor } from '../lib/billingAccess'
import { byId } from '../lib/db'
import { ORG_REMOVAL_PHASES, type OrgRemovalPhase, type RemovedAccessKind } from '../lib/enums'
import { require, rule } from '../lib/functions'
import { budgetSpent, REMOVAL_BUDGET, type RemovalBudget, sweep } from './cascade'
import { clearOrgTrash } from './deletedItems'
import { estimateDocumentBytes } from './demoMetrics'
import { releaseFile } from './fileHolds'
import { deleteOrgBookkeeping, tallyRow } from './orgs'

type Row = { _id: Id<TableNames> }

/** What runs on each row of a range: `before` ahead of its delete, `after`
 * once it is deleted, such as letting go of the file it named. */
type Hooks<R> = { before?: (row: R) => Promise<void>; after?: (row: R) => Promise<void> }

/** Deletes the rows of `rows`, one index range read in one pass, until it
 * ends (true) or the budget is spent (false), running `hooks` on each row. */
const drain = <R extends Row>(
  ctx: MutationCtx,
  budget: RemovalBudget,
  rows: AsyncIterable<R>,
  hooks: Hooks<R> = {},
) =>
  sweep(budget, rows, async (row) => {
    if (hooks.before) await hooks.before(row)
    await ctx.db.delete(row._id)
    if (hooks.after) await hooks.after(row)
  })

/** Deletes the parent rows of `rows`, one index range read in one pass,
 * each after `children` reports its own ranges empty, running `hooks` on
 * each. */
async function parents<R extends Row>(
  ctx: MutationCtx,
  budget: RemovalBudget,
  rows: AsyncIterable<R>,
  children: (row: R) => Promise<boolean>,
  hooks: Hooks<R> = {},
): Promise<boolean> {
  if (budgetSpent(budget)) return false
  for await (const row of rows) {
    if (!(await children(row))) return false
    if (hooks.before) await hooks.before(row)
    await ctx.db.delete(row._id)
    if (hooks.after) await hooks.after(row)
    budget.rows -= 1
    budget.bytes -= estimateDocumentBytes(row)
    if (budgetSpent(budget)) return false
  }
  return true
}

/** Runs each range in order and stops at the first one left unfinished. */
async function inOrder(steps: (() => Promise<boolean>)[]): Promise<boolean> {
  for (const step of steps) if (!(await step())) return false
  return true
}

/** Profiles with everything that hangs off them, then their pictures,
 * then any Team sync stamp row left without its profile (a rollback or a
 * manual edit can leave one), which finish() refuses to leave behind. A
 * read-message sweep row names no organization, so one left without its
 * profile stays until it falls due and the sweep deletes it (jobs.ts). */
const profileRows = async (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  (await profilesWithRows(ctx, orgId, budget)) &&
  (await drain(
    ctx,
    budget,
    ctx.db.query('sync_stamps').withIndex('by_org', (q) => q.eq('org_id', orgId)),
  ))

/** Records access the step deletes next (removed_access), as one row of
 * `budget`, so a call through it hears that the organization is being
 * deleted (lib/billingAccess.ts removedWithOrg). The finish phase deletes
 * them after the organization. */
async function recordRemoved(
  ctx: MutationCtx,
  orgId: string,
  budget: RemovalBudget,
  kind: RemovedAccessKind,
  key: string,
) {
  budget.rows -= 1
  await ctx.db.insert('removed_access', { org_id: orgId, kind, key })
}

const profilesWithRows = async (ctx: MutationCtx, orgId: string, budget: RemovalBudget) => {
  const markGuests = await guestMarking(ctx, orgId)
  const removed = (kind: RemovedAccessKind, key: string) =>
    recordRemoved(ctx, orgId, budget, kind, key)
  const now = Date.now()
  return await parents(
    ctx,
    budget,
    ctx.db.query('profiles').withIndex('by_org', (q) => q.eq('org_id', orgId)),
    (profile) =>
      inOrder([
        () =>
          drain(
            ctx,
            budget,
            ctx.db
              .query('user_prefs')
              .withIndex('by_profile', (q) => q.eq('profile_id', profile.id)),
          ),
        () =>
          drain(
            ctx,
            budget,

            ctx.db
              .query('messages')
              .withIndex('by_recipient', (q) => q.eq('recipient_id', profile.id)),
          ),
        () =>
          drain(
            ctx,
            budget,
            ctx.db
              .query('issue_subscriptions')
              .withIndex('by_profile_task_archived', (q) => q.eq('profile_id', profile.id)),
          ),
        () =>
          drain(
            ctx,
            budget,
            ctx.db
              .query('sync_stamps')
              .withIndex('by_profile', (q) => q.eq('profile_id', profile.id)),
          ),
        () =>
          drain(
            ctx,
            budget,
            ctx.db
              .query('message_sweeps')
              .withIndex('by_profile', (q) => q.eq('profile_id', profile.id)),
          ),
        () =>
          drain(
            ctx,
            budget,
            ctx.db
              .query('team_members')
              .withIndex('by_profile', (q) => q.eq('profile_id', profile.id)),
          ),
        () =>
          drain(
            ctx,
            budget,
            ctx.db
              .query('project_access')
              .withIndex('by_profile', (q) => q.eq('profile_id', profile.id)),
          ),
        () =>
          drain(
            ctx,
            budget,
            ctx.db
              .query('agent_keys')
              .withIndex('by_profile', (q) => q.eq('profile_id', profile.id)),
            {
              before: async (key) => {
                if (key.revoked_at === undefined) await removed('agent_keys', key.key_hash)
              },
            },
          ),
        () =>
          drain(
            ctx,
            budget,
            ctx.db
              .query('mcp_tokens')
              .withIndex('by_profile', (q) => q.eq('profile_id', profile.id)),
            {
              // a personal token works only while its person's login does
              // (machine/auth.ts lookupCredential)
              before: async (token) => {
                if (token.revoked_at !== undefined || tokenExpired(token, now)) return
                const user =
                  profile.auth_user_id === undefined
                    ? null
                    : await findAuthUser(ctx, profile.auth_user_id)
                if (user !== null && !loginBanned(user, now))
                  await removed('mcp_tokens', token.token_hash)
              },
            },
          ),
        () =>
          drain(
            ctx,
            budget,
            ctx.db
              .query('attachment_uploads')
              .withIndex('by_profile_expiry', (q) => q.eq('profile_id', profile.id)),
          ),
        () =>
          parents(
            ctx,
            budget,
            ctx.db
              .query('oauth_connections')
              .withIndex('by_profile', (q) => q.eq('profile_id', profile.id)),
            (connection) =>
              drain(
                ctx,
                budget,
                ctx.db
                  .query('oauth_credential_uses')
                  .withIndex('by_connection', (q) => q.eq('connection_id', connection.id)),
              ),
            {
              before: async (connection) => {
                if (connection.approved_at && !connection.revoked_at)
                  await removed('oauth_connections', connection.id)
              },
            },
          ),
        () =>
          drain(
            ctx,
            budget,
            ctx.db
              .query('machine_rate_limits')
              .withIndex('by_key', (q) => q.eq('key', `profile:${profile.id}`)),
          ),
        () => markGuests(profile, budget),
      ]),
    {
      // the seat a member's app calls and an agent's or person's machine
      // calls between lookup and dispatch came through
      before: async (profile) => {
        await removed('profile', profile.id)
        if (profile.auth_user_id !== undefined) await removed('login', profile.auth_user_id)
      },
      after: async (profile) => {
        if (profile.avatar_storage_id === undefined) return
        // Letting go of a picture reads about as many index ranges as the
        // profile's own rows and can write a hold, so it costs a row too.
        // Without that, a step of 256 profiles with pictures reads more
        // than Convex's 4,096 ranges.
        budget.rows -= 1
        await releaseFile(ctx, profile.avatar_storage_id)
      },
    },
  )
}

/** The step's marker of deleted profiles' guest organizations, which marks
 * them due before the profile goes (lib/billableUsers.ts
 * markHomeProfileRemoved) within the step's budget. When the budget runs
 * out first, it records on the removal row where it stopped and answers
 * false, so the profile stays, no longer active, and the next step goes on
 * from there: a person who is a guest in many organizations takes several
 * steps instead of passing one step's budget. */
async function guestMarking(ctx: MutationCtx, orgId: string) {
  const removal = await orgRemovalFor(ctx, orgId)
  require(removal, rule('Organization deletion has not begun'))
  // guest organizations already marked due in this step
  const asked = new Set<string>()
  let progress = removal.guest_marking
  return async (profile: Doc<'profiles'>, budget: RemovalBudget): Promise<boolean> => {
    const after = progress?.profile_id === profile.id ? progress : undefined
    const stopped = await markHomeProfileRemoved(ctx, profile, asked, budget, after)
    const next = stopped === null ? undefined : { profile_id: profile.id, ...stopped }
    if (next !== undefined || progress !== undefined) {
      progress = next
      await ctx.db.patch(removal._id, { guest_marking: next })
    }
    return next === undefined
  }
}

/** Everything in Deleted items, from one budget: clearOrgTrash counts its
 * rows and their bytes as this file's steps do. */
async function trashRows(ctx: MutationCtx, orgId: string, budget: RemovalBudget) {
  const teardown = { left: budget.rows, bytes: budget.bytes }
  const done = await clearOrgTrash(ctx, orgId, teardown)
  budget.rows = teardown.left
  budget.bytes = teardown.bytes
  return done
}

/** Tasks with their links, labels, subscriptions, comments, messages and
 * files, then the description rows they leave (model/descriptions.ts). */
const taskRows = (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  inOrder([
    () => liveTasks(ctx, orgId, budget),
    () =>
      drain(
        ctx,
        budget,
        ctx.db.query('issue_descriptions').withIndex('by_org', (q) => q.eq('org_id', orgId)),
      ),
  ])

/* The tasks of taskRows. */
const liveTasks = (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  parents(
    ctx,
    budget,
    ctx.db.query('issues').withIndex('by_org', (q) => q.eq('org_id', orgId)),
    (issue) =>
      inOrder([
        () =>
          drain(
            ctx,
            budget,
            ctx.db.query('issue_links').withIndex('by_source', (q) => q.eq('source_id', issue.id)),
          ),
        () =>
          drain(
            ctx,
            budget,
            ctx.db.query('issue_links').withIndex('by_target', (q) => q.eq('target_id', issue.id)),
          ),
        () =>
          drain(
            ctx,
            budget,
            ctx.db.query('issue_labels').withIndex('by_issue', (q) => q.eq('issue_id', issue.id)),
          ),
        () =>
          drain(
            ctx,
            budget,
            ctx.db
              .query('issue_subscriptions')
              .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', issue.id)),
          ),
        () =>
          drain(
            ctx,
            budget,

            ctx.db.query('comments').withIndex('by_issue', (q) => q.eq('issue_id', issue.id)),
          ),
        () =>
          drain(
            ctx,
            budget,

            ctx.db.query('messages').withIndex('by_issue_read', (q) => q.eq('issue_id', issue.id)),
          ),
        () =>
          drain(
            ctx,
            budget,

            ctx.db
              .query('issue_attachments')
              .withIndex('by_issue', (q) => q.eq('issue_id', issue.id)),
            { after: (row) => releaseFile(ctx, row.storage_id) },
          ),
      ]),
    { before: (issue) => tallyRow(ctx, 'issues', issue, null) },
  )

/** Projects with their milestones and access grants. */
const projectRows = (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  parents(
    ctx,
    budget,
    ctx.db.query('projects').withIndex('by_org', (q) => q.eq('org_id', orgId)),
    (project) =>
      inOrder([
        () =>
          drain(
            ctx,
            budget,
            ctx.db
              .query('milestones')
              .withIndex('by_project', (q) => q.eq('project_id', project.id)),
          ),
        () =>
          drain(
            ctx,
            budget,
            ctx.db
              .query('project_access')
              .withIndex('by_project', (q) => q.eq('project_id', project.id)),
          ),
        () =>
          drain(
            ctx,
            budget,
            ctx.db
              .query('project_team_access')
              .withIndex('by_project', (q) => q.eq('project_id', project.id)),
          ),
      ]),
    { before: (project) => tallyRow(ctx, 'projects', project, null) },
  )

/** Teams with their members and project grants. */
const teamRows = (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  parents(
    ctx,
    budget,
    ctx.db.query('teams').withIndex('by_org', (q) => q.eq('org_id', orgId)),
    (team) =>
      inOrder([
        () =>
          drain(
            ctx,
            budget,
            ctx.db.query('team_members').withIndex('by_team', (q) => q.eq('team_id', team.id)),
          ),
        () =>
          drain(
            ctx,
            budget,
            ctx.db
              .query('project_team_access')
              .withIndex('by_team', (q) => q.eq('team_id', team.id)),
          ),
      ]),
  )

/** Labels with any task labels left on them. */
const labelRows = (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  parents(
    ctx,
    budget,
    ctx.db.query('labels').withIndex('by_org', (q) => q.eq('org_id', orgId)),
    (label) =>
      drain(
        ctx,
        budget,
        ctx.db.query('issue_labels').withIndex('by_label', (q) => q.eq('label_id', label.id)),
      ),
  )

/** The organization's activity history. */
const activityRows = (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  drain(
    ctx,
    budget,

    ctx.db.query('activity_events').withIndex('by_org_ts', (q) => q.eq('org_id', orgId)),
  )

/** Webhook events, health, deliveries and subscriptions. */
const webhookRows = (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  inOrder(
    (
      ['webhook_events', 'webhook_health', 'webhook_deliveries', 'webhook_subscriptions'] as const
    ).map(
      (table) => () =>
        drain(
          ctx,
          budget,
          ctx.db.query(table).withIndex('by_org', (q) => q.eq('org_id', orgId)),
        ),
    ),
  )

/** Usage, billing events, periods, notices and the subscription row, then
 * the monthly usage rows and counts of Qivo Admin's Usage page. */
const billingRows = (ctx: MutationCtx, orgId: string, budget: RemovalBudget) =>
  inOrder([
    ...(['billing_usage', 'billing_usage_totals', 'billing_events'] as const).map(
      (table) => () =>
        drain(
          ctx,
          budget,
          ctx.db.query(table).withIndex('by_org_period', (q) => q.eq('org_id', orgId)),
        ),
    ),
    ...(['billing_periods', 'billing_notices', 'billing_subscriptions'] as const).map(
      (table) => () =>
        drain(
          ctx,
          budget,
          ctx.db.query(table).withIndex('by_org', (q) => q.eq('org_id', orgId)),
        ),
    ),
    () =>
      drain(
        ctx,
        budget,
        ctx.db.query('usage_months').withIndex('by_org_month', (q) => q.eq('org_id', orgId)),
      ),
    () =>
      drain(
        ctx,
        budget,
        ctx.db.query('usage_counts').withIndex('by_org_month_metric', (q) => q.eq('org_id', orgId)),
      ),
  ])

/** The last phase checks that every parent range is empty, Deleted items
 * included, then deletes the organization with its counters row. It runs
 * again, finding nothing to delete, in each later step that drains the
 * removal's removed_access rows. */
async function finish(ctx: MutationCtx, removal: Doc<'org_removals'>): Promise<void> {
  const orgId = removal.org_id
  for (const table of [
    'issues',
    'issue_descriptions',
    'projects',
    'teams',
    'profiles',
    'labels',
    'sync_stamps',
  ] as const)
    require((await ctx.db
      .query(table)
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .first()) === null, rule('Organization deletion left organization data'))
  const trash = [
    await ctx.db
      .query('deleted_items')
      .withIndex('by_org_deleted', (q) => q.eq('org_id', orgId))
      .first(),
    await ctx.db
      .query('deleted_tasks')
      .withIndex('by_org_num', (q) => q.eq('org_id', orgId))
      .first(),
    await ctx.db
      .query('deleted_rows')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .first(),
  ]
  require(trash.every((row) => row === null), rule('Organization deletion left Deleted items'))
  // the Northstar importer's ownership receipt names the org (one-row table)
  for (const receipt of await ctx.db.query('marketing_demo').collect())
    if (receipt.org_id === orgId) await ctx.db.delete(receipt._id)
  await deleteOrgBookkeeping(ctx, orgId)
  const org = await byId(ctx, 'organizations', orgId)
  if (org) await ctx.db.delete(org._id)
}

const PHASE_ROWS: Record<
  Exclude<OrgRemovalPhase, 'finish'>,
  (ctx: MutationCtx, orgId: string, budget: RemovalBudget) => Promise<boolean>
> = {
  profiles: profileRows,
  trash: trashRows,
  tasks: taskRows,
  projects: projectRows,
  teams: teamRows,
  labels: labelRows,
  activity: activityRows,
  webhooks: webhookRows,
  billing: billingRows,
}

/** The phases that hold an organization's work, which the Northstar
 * fixture's wipe deletes (internal/marketingDemo.ts) while it keeps the
 * organization, its profiles and their logins. */
const WORK_PHASES = ['tasks', 'projects', 'teams', 'labels', 'activity'] as const

/** Deletes one `limit` (REMOVAL_BUDGET unless given) of an organization's
 * work: its tasks with everything under them and their files, its projects,
 * teams, labels and activity, then the view preferences and messages of
 * `profileIds`. Returns true once all of it is gone. Like a deletion step,
 * it reads every range again from its start, so a repeated step cannot skip
 * a row. It leaves Deleted items alone, so a caller must see them empty
 * first. */
export async function wipeWorkStep(
  ctx: MutationCtx,
  orgId: string,
  profileIds: readonly string[],
  limit: RemovalBudget = REMOVAL_BUDGET,
): Promise<boolean> {
  const budget: RemovalBudget = { ...limit }
  return await inOrder([
    ...WORK_PHASES.map((phase) => () => PHASE_ROWS[phase](ctx, orgId, budget)),
    ...profileIds.flatMap((profileId) => [
      () =>
        drain(
          ctx,
          budget,
          ctx.db.query('user_prefs').withIndex('by_profile', (q) => q.eq('profile_id', profileId)),
        ),
      () =>
        drain(
          ctx,
          budget,

          ctx.db
            .query('messages')
            .withIndex('by_recipient', (q) => q.eq('recipient_id', profileId)),
        ),
    ]),
  ])
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
      // The organization goes first, so every call through access the
      // profiles phase deleted hears that it is being deleted until it is
      // gone. What that phase recorded (removed_access) goes after, over as
      // many steps as it takes, then the removal row.
      await finish(ctx, removal)
      const recorded = ctx.db
        .query('removed_access')
        .withIndex('by_org', (q) => q.eq('org_id', removal.org_id))
      if (!(await drain(ctx, budget, recorded))) break
      await ctx.db.delete(removal._id)
      return true
    }
    if (!(await PHASE_ROWS[phase](ctx, removal.org_id, budget))) break
    phase = ORG_REMOVAL_PHASES[ORG_REMOVAL_PHASES.indexOf(phase) + 1]
  }
  await ctx.db.patch(removal._id, { phase })
  return false
}

/* Durable public-demo deletion. Child rows are drained before their parent,
 * and every transaction has a fixed deletion budget. Re-running a batch after
 * an interrupted scheduler delivery cannot recreate content or extend access.
 *
 * Deleted items go first (model/deletedItems.ts clearOrgTrash): their items
 * and jobs, so a step still scheduled does nothing (steps also stand still
 * while the receipt is deleting), then the rows a move or restore left in
 * the live tables, the stored rows and their bytes, before the uploads
 * phase, whose byte fence would otherwise keep trashed files. The trash
 * phase also stops on TRASH_BYTES, because stored rows can be large. The tasks
 * phase then sweeps every task of the organization, those a moving project
 * left under its absent projects included. The finish phase deletes the
 * organization and then the used_ids rows of the ids its tasks and projects
 * held, last (model/usedIds.ts). */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { components } from '../_generated/api'
import type { Doc, Id, TableNames } from '../_generated/dataModel'
import { internalMutation, type MutationCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { requireDemoDeployment } from '../lib/demo'
import { require, rule } from '../lib/functions'
import { rechecksOfOrg } from '../model/archiveRechecks'
import { clearOrgTrash } from '../model/deletedItems'
import { recordDemoCreated } from '../model/demoMetrics'
import { drainDemoUploads } from '../model/demoUploads'
import { eraseFile } from '../model/fileHolds'
import { recipientItems, stateRows, taskItems } from '../model/inboxItems'
import { deleteLabelCount } from '../model/labelCounts'
import { jobsOf, partsOf, requestsOf } from '../model/orgExports'
import { deleteOrgBookkeeping, tallyRow } from '../model/orgs'
import { reachOfOrg } from '../model/projectNav'
import { uncountFile } from '../model/storageTotals'
import { deleteTeamCount } from '../model/teamCounts'
import { releaseUsedIds } from '../model/usedIds'
import { marketingId } from './marketingDemoData'

const BATCH = 64
const STALLED_MS = 60_000
const purgeRef = makeFunctionReference<'mutation', { demo_id: string }, null>(
  'internal/demoCleanup:purge',
)
const expireRef = makeFunctionReference<'mutation', { id: string }, null>('demo:expire')

type Budget = { left: number }

/* What the trash phase may delete in one batch besides its rows: about
 * 4 MiB of documents, the margin an organization's deletion in steps leaves
 * under Convex's 16 MiB read limit (model/cascade.ts REMOVAL_BUDGET). A
 * stored row can hold a document of almost 1 MiB, so BATCH of them could
 * read past that limit. The release of the organization's used ids in the
 * finish phase reads within it too, since it can find such a row. */
const TRASH_BYTES = 4 * 1024 * 1024

/** A full batch is repeated from the same indexed prefix next time. No
 * cursor can skip a row that was deleted while the earlier batch ran. */
async function drain<Row extends { _id: Id<TableNames> }>(
  ctx: MutationCtx,
  budget: Budget,
  read: (limit: number) => Promise<Row[]>,
  before?: (row: Row) => Promise<void>,
): Promise<boolean> {
  if (budget.left <= 0) return false
  const limit = budget.left
  const rows = await read(limit)
  for (const row of rows) {
    if (before) await before(row)
    await ctx.db.delete(row._id)
    budget.left--
  }
  return rows.length < limit
}

/* The demo keeps no backups, so its files are erased at once, never held
 * (model/fileHolds.ts). */
async function removeFile(ctx: MutationCtx, id: Id<'_storage'> | undefined) {
  if (id !== undefined) await eraseFile(ctx, id)
}

/** Deleted items, within the batch's rows and TRASH_BYTES. Only this phase
 * and the release in the finish phase count bytes; the others count rows
 * alone. */
async function trashRows(ctx: MutationCtx, orgId: string, budget: Budget): Promise<boolean> {
  const teardown = { left: budget.left, bytes: TRASH_BYTES }
  const done = await clearOrgTrash(ctx, orgId, teardown)
  budget.left = teardown.left
  return done
}

/** The organization's export jobs, each after its parts, whose files are
 * erased at once, and its request rows (model/orgExports.ts). A step still
 * running finds its job gone at its commit and deletes its own file. */
async function exportRows(ctx: MutationCtx, orgId: string, budget: Budget): Promise<boolean> {
  while (budget.left > 0) {
    const job = await jobsOf(ctx, orgId).first()
    if (job === null) return true
    const parts = await drain(
      ctx,
      budget,
      (n) => partsOf(ctx, job.id).take(n),
      (part) => removeFile(ctx, part.storage_id),
    )
    if (!parts || !(await drain(ctx, budget, (n) => requestsOf(ctx, job.id).take(n)))) return false
    if (budget.left <= 0) return false
    await ctx.db.delete(job._id)
    budget.left--
  }
  return false
}

/** Any task or project storage totals left once the tasks are gone. The
 * trash and tasks phases take them out with the files
 * (model/storageTotals.ts), and the organization's own row goes with its
 * other bookkeeping in the finish phase. */
async function storageRows(ctx: MutationCtx, orgId: string, budget: Budget): Promise<boolean> {
  return (
    (await drain(ctx, budget, (n) =>
      ctx.db
        .query('storage_task_totals')
        .withIndex('by_org_issue', (q) => q.eq('org_id', orgId))
        .take(n),
    )) &&
    (await drain(ctx, budget, (n) =>
      ctx.db
        .query('storage_project_totals')
        .withIndex('by_org_bytes', (q) => q.eq('org_id', orgId))
        .take(n),
    ))
  )
}

/** The label usage counts, so none reads wrong while the tasks they count
 * go over many batches (model/labelCounts.ts), then every task with its
 * rows, its comment count and post logs among them, then the description
 * rows the tasks leave (model/descriptions.ts), which a visitor's payload
 * limit keeps small, then any storage totals left (storageRows) and any
 * comment count or post log left naming no task (model/commentLimits.ts). */
async function taskRows(ctx: MutationCtx, orgId: string, budget: Budget): Promise<boolean> {
  const counts = await drain(ctx, budget, (n) =>
    ctx.db
      .query('label_counts')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .take(n),
  )
  if (!counts) return false
  while (budget.left > 0) {
    const issue = await ctx.db
      .query('issues')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .first()
    // then the description rows, the storage totals left, and any comment
    // count or post log left naming no task
    if (!issue)
      return (
        (await drain(ctx, budget, (n) =>
          ctx.db
            .query('issue_descriptions')
            .withIndex('by_org', (q) => q.eq('org_id', orgId))
            .take(n),
        )) &&
        (await storageRows(ctx, orgId, budget)) &&
        (await commentLimitRows(ctx, orgId, budget))
      )
    const id = issue.id
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('issue_links')
          .withIndex('by_source', (q) => q.eq('source_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('issue_links')
          .withIndex('by_target', (q) => q.eq('target_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('issue_labels')
          .withIndex('by_issue', (q) => q.eq('issue_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('issue_subscriptions')
          .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('comments')
          .withIndex('by_issue', (q) => q.eq('issue_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('messages')
          .withIndex('by_issue_read', (q) => q.eq('issue_id', id))
          .take(n),
      ))
    )
      return false
    // the inbox items after their messages (model/inboxItems.ts)
    if (!(await drain(ctx, budget, (n) => taskItems(ctx, id).take(n)))) return false
    if (
      !(await drain(
        ctx,
        budget,
        (n) =>
          ctx.db
            .query('issue_attachments')
            .withIndex('by_issue', (q) => q.eq('issue_id', id))
            .take(n),
        async (row) => {
          await uncountFile(ctx, row, issue.num)
          await removeFile(ctx, row.storage_id)
        },
      ))
    )
      return false
    // its comment count and post logs, before the task row frees its id
    for (const table of ['task_comment_counts', 'comment_rates'] as const)
      if (
        !(await drain(ctx, budget, (n) =>
          ctx.db
            .query(table)
            .withIndex('by_issue', (q) => q.eq('issue_id', id))
            .take(n),
        ))
      )
        return false
    await ctx.db.delete(issue._id)
    await tallyRow(ctx, 'issues', issue, null)
    budget.left--
  }
  return false
}

/** The organization's comment counts, then its comment post logs. */
async function commentLimitRows(ctx: MutationCtx, orgId: string, budget: Budget): Promise<boolean> {
  for (const table of ['task_comment_counts', 'comment_rates'] as const)
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query(table)
          .withIndex('by_org', (q) => q.eq('org_id', orgId))
          .take(n),
      ))
    )
      return false
  return true
}

async function projectRows(ctx: MutationCtx, orgId: string, budget: Budget): Promise<boolean> {
  // the reach rows of every project, and of any a move left absent
  // (model/projectNav.ts)
  if (!(await drain(ctx, budget, (n) => reachOfOrg(ctx, orgId).take(n)))) return false
  // the nightly archive's rechecks of its projects, which the tasks phase
  // before leaves nothing to write (model/archiveRechecks.ts)
  if (!(await drain(ctx, budget, (n) => rechecksOfOrg(ctx, orgId).take(n)))) return false
  while (budget.left > 0) {
    const project = await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .first()
    if (!project) return true
    const id = project.id
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('milestones')
          .withIndex('by_project', (q) => q.eq('project_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('project_access')
          .withIndex('by_project', (q) => q.eq('project_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('project_team_access')
          .withIndex('by_project', (q) => q.eq('project_id', id))
          .take(n),
      ))
    )
      return false
    await ctx.db.delete(project._id)
    await tallyRow(ctx, 'projects', project, null)
    budget.left--
  }
  return false
}

/* Each team goes with its member count first (model/teamCounts.ts), which
 * leaves the profiles phase no count to move, then any count left without
 * its team. */
async function teamRows(ctx: MutationCtx, orgId: string, budget: Budget): Promise<boolean> {
  while (budget.left > 0) {
    const team = await ctx.db
      .query('teams')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .first()
    if (!team)
      return await drain(ctx, budget, (n) =>
        ctx.db
          .query('team_counts')
          .withIndex('by_org', (q) => q.eq('org_id', orgId))
          .take(n),
      )
    if (await deleteTeamCount(ctx, team.id)) budget.left--
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('team_members')
          .withIndex('by_team', (q) => q.eq('team_id', team.id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('project_team_access')
          .withIndex('by_team', (q) => q.eq('team_id', team.id))
          .take(n),
      ))
    )
      return false
    await ctx.db.delete(team._id)
    budget.left--
  }
  return false
}

async function connections(
  ctx: MutationCtx,
  budget: Budget,
  read: () => Promise<Doc<'oauth_connections'> | null>,
): Promise<boolean> {
  while (budget.left > 0) {
    const connection = await read()
    if (!connection) return true
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('oauth_credential_uses')
          .withIndex('by_connection', (q) => q.eq('connection_id', connection.id))
          .take(n),
      ))
    )
      return false
    await ctx.db.delete(connection._id)
    budget.left--
  }
  return false
}

async function profileRows(ctx: MutationCtx, orgId: string, budget: Budget): Promise<boolean> {
  while (budget.left > 0) {
    const profile = await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .first()
    // then a Team sync stamp row left without its profile, by a rollback or
    // a manual edit
    if (!profile)
      return await drain(ctx, budget, (n) =>
        ctx.db
          .query('sync_stamps')
          .withIndex('by_org', (q) => q.eq('org_id', orgId))
          .take(n),
      )
    const id = profile.id
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('user_prefs')
          .withIndex('by_profile', (q) => q.eq('profile_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('sync_stamps')
          .withIndex('by_profile', (q) => q.eq('profile_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('message_sweeps')
          .withIndex('by_profile', (q) => q.eq('profile_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('messages')
          .withIndex('by_recipient', (q) => q.eq('recipient_id', id))
          .take(n),
      ))
    )
      return false
    // the inbox items and their build state after the messages
    // (model/inboxItems.ts)
    if (!(await drain(ctx, budget, (n) => recipientItems(ctx, id).take(n)))) return false
    if (!(await drain(ctx, budget, (n) => stateRows(ctx, id).take(n)))) return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('issue_subscriptions')
          .withIndex('by_profile_task_archived', (q) => q.eq('profile_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('team_members')
          .withIndex('by_profile', (q) => q.eq('profile_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('project_access')
          .withIndex('by_profile', (q) => q.eq('profile_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('agent_keys')
          .withIndex('by_profile', (q) => q.eq('profile_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('mcp_tokens')
          .withIndex('by_profile', (q) => q.eq('profile_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await connections(ctx, budget, () =>
        ctx.db
          .query('oauth_connections')
          .withIndex('by_profile', (q) => q.eq('profile_id', id))
          .first(),
      ))
    )
      return false
    await removeFile(ctx, profile.avatar_storage_id)
    await ctx.db.delete(profile._id)
    budget.left--
  }
  return false
}

/* Each label goes with its usage count first (model/labelCounts.ts), then
 * any count left without its label. */
async function labelRows(ctx: MutationCtx, orgId: string, budget: Budget): Promise<boolean> {
  while (budget.left > 0) {
    const label = await ctx.db
      .query('labels')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .first()
    if (!label)
      return await drain(ctx, budget, (n) =>
        ctx.db
          .query('label_counts')
          .withIndex('by_org', (q) => q.eq('org_id', orgId))
          .take(n),
      )
    if (await deleteLabelCount(ctx, label.id)) budget.left--
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('issue_labels')
          .withIndex('by_label', (q) => q.eq('label_id', label.id))
          .take(n),
      ))
    )
      return false
    await ctx.db.delete(label._id)
    budget.left--
  }
  return false
}

/* The label and team counts of the organization, which its labels and
 * teams phases leave none of; only an earlier release, run in between,
 * leaves some. */
async function strayCounts(ctx: MutationCtx, orgId: string, budget: Budget): Promise<boolean> {
  for (const table of ['label_counts', 'team_counts'] as const)
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query(table)
          .withIndex('by_org', (q) => q.eq('org_id', orgId))
          .take(n),
      ))
    )
      return false
  return true
}

async function accountRows(ctx: MutationCtx, authId: string, budget: Budget): Promise<boolean> {
  if (
    !(await drain(
      ctx,
      budget,
      (n) =>
        ctx.db
          .query('custom_backgrounds')
          .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authId))
          .take(n),
      async (row) => {
        await removeFile(ctx, row.storage_id)
        await removeFile(ctx, row.preview_storage_id)
      },
    ))
  )
    return false
  if (
    !(await drain(ctx, budget, (n) =>
      ctx.db
        .query('background_uploads')
        .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authId))
        .take(n),
    ))
  )
    return false
  if (
    !(await drain(ctx, budget, (n) =>
      ctx.db
        .query('account_appearance')
        .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authId))
        .take(n),
    ))
  )
    return false
  if (
    !(await drain(ctx, budget, (n) =>
      ctx.db
        .query('roadmap_history')
        .withIndex('by_owner_session', (q) => q.eq('auth_user_id', authId))
        .take(n),
    ))
  )
    return false
  return await connections(ctx, budget, () =>
    ctx.db
      .query('oauth_connections')
      .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authId))
      .first(),
  )
}

const AUTH_MODELS = [
  'session',
  'account',
  'oauthAccessToken',
  'oauthRefreshToken',
  'oauthConsent',
] as const
async function authRows(ctx: MutationCtx, authId: string, budget: Budget): Promise<boolean> {
  for (const model of AUTH_MODELS) {
    if (budget.left <= 0) return false
    const result = (await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: { model, where: [{ field: 'userId', value: authId }] },
      paginationOpts: { numItems: budget.left, cursor: null },
    })) as { count: number; isDone: boolean }
    // The component's adapter returns a count; never let a future adapter
    // change silently turn bounded cleanup into an unbounded loop.
    require(Number.isSafeInteger(result.count) && result.count >= 0, rule(
      'Invalid auth cleanup result',
    ))
    budget.left -= result.count
    if (!result.isDone) return false
  }
  // The clients last, each with its resource links. A link counts with its client.
  if (budget.left <= 0) return false
  const clients = await ctx.runMutation(components.betterAuth.oauth.deleteClients, {
    field: 'userId',
    value: authId,
    numItems: budget.left,
  })
  budget.left -= clients.count
  return clients.isDone
}

const PHASES = [
  'sessions',
  'trash',
  'tasks',
  'projects',
  'teams',
  'profiles',
  'labels',
  'activity',
  'webhooks',
  'account',
  'uploads',
  'auth',
  'finish',
] as const

export const purge = internalMutation({
  args: { demo_id: v.string() },
  handler: async (ctx, { demo_id }): Promise<null> => {
    if (process.env.APP_MODE !== 'demo') return null
    const receipt = await ctx.db
      .query('demo_sessions')
      .withIndex('by_uuid', (q) => q.eq('id', demo_id))
      .unique()
    if (!receipt) return null
    // Only the expiry owner changes ready -> deleting. Repeated calls on a
    // live receipt cannot accidentally turn a cron recovery into a reset.
    if (receipt.status !== 'deleting') return null
    const orgId = receipt.org_id
    if (orgId)
      require(orgId === (await marketingId(`public-demo:${receipt.id}`, 'org')), rule(
        'Demo cleanup ownership mismatch',
      ))
    let phase = receipt.cleanup_phase ?? 'sessions'
    require((PHASES as readonly string[]).includes(phase), rule('Unknown demo cleanup phase'))
    await recordDemoCreated(ctx, receipt._id)
    const budget: Budget = { left: BATCH }
    let waitingUploads = false
    while (budget.left > 0) {
      let done = false
      if (phase === 'sessions') {
        const result = (await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
          input: { model: 'session', where: [{ field: 'userId', value: receipt.auth_user_id }] },
          paginationOpts: { numItems: budget.left, cursor: null },
        })) as { count: number; isDone: boolean }
        budget.left -= result.count
        done = result.isDone
      } else if (phase === 'trash') done = !orgId || (await trashRows(ctx, orgId, budget))
      else if (phase === 'tasks') done = !orgId || (await taskRows(ctx, orgId, budget))
      else if (phase === 'projects') done = !orgId || (await projectRows(ctx, orgId, budget))
      else if (phase === 'teams') done = !orgId || (await teamRows(ctx, orgId, budget))
      else if (phase === 'profiles') done = !orgId || (await profileRows(ctx, orgId, budget))
      else if (phase === 'labels') done = !orgId || (await labelRows(ctx, orgId, budget))
      else if (phase === 'activity')
        done =
          !orgId ||
          ((await drain(ctx, budget, (n) =>
            ctx.db
              .query('activity_events')
              .withIndex('by_org_ts', (q) => q.eq('org_id', orgId))
              .take(n),
          )) &&
            (await exportRows(ctx, orgId, budget)))
      else if (phase === 'webhooks') {
        done = true
        if (orgId)
          for (const table of [
            'webhook_events',
            'webhook_health',
            'webhook_deliveries',
            'webhook_subscriptions',
          ] as const) {
            if (
              !(await drain(ctx, budget, (n) =>
                ctx.db
                  .query(table)
                  .withIndex('by_org', (q) => q.eq('org_id', orgId))
                  .take(n),
              ))
            ) {
              done = false
              break
            }
          }
      } else if (phase === 'account') done = await accountRows(ctx, receipt.auth_user_id, budget)
      else if (phase === 'uploads') {
        done = await drainDemoUploads(ctx, receipt.id)
        const uploadProgress = await ctx.db.get(receipt._id)
        // Grace periods and outstanding receivers wait; actual scan pages
        // continue immediately instead of taking five seconds per 64 files.
        waitingUploads =
          !done &&
          (uploadProgress?.cleanup_file_after === undefined ||
            uploadProgress.cleanup_file_after > Date.now() ||
            (uploadProgress.cleanup_file_wait_until ?? 0) > Date.now())
      } else if (phase === 'auth') done = await authRows(ctx, receipt.auth_user_id, budget)
      // Counts an earlier release left when it deleted their labels and
      // teams past their phases, which the checks below refuse to leave.
      else if (phase === 'finish' && orgId && !(await strayCounts(ctx, orgId, budget))) done = false
      // Export rows an earlier release left past the activity phase, which
      // knew no export tables, as a cleanup that spans a rollback does.
      else if (phase === 'finish' && orgId && !(await exportRows(ctx, orgId, budget))) done = false
      // Likewise rechecks an earlier release left past the projects phase.
      else if (
        phase === 'finish' &&
        orgId &&
        !(await drain(ctx, budget, (n) => rechecksOfOrg(ctx, orgId).take(n)))
      )
        done = false
      else if (phase === 'finish') {
        // No owner/work should reappear after the drained phases: all public
        // and background finalization paths fence against deleting receipts.
        require((await ctx.db
          .query('profiles')
          .withIndex('by_auth', (q) => q.eq('auth_user_id', receipt.auth_user_id))
          .first()) === null, rule('Demo login still owns a profile'))
        if (orgId) {
          for (const table of [
            'issues',
            'issue_descriptions',
            'projects',
            'project_reach',
            'teams',
            'profiles',
            'labels',
            'task_comment_counts',
            'comment_rates',
            'label_counts',
            'team_counts',
          ] as const)
            require((await ctx.db
              .query(table)
              .withIndex('by_org', (q) => q.eq('org_id', orgId))
              .first()) === null, rule('Demo cleanup left organization data'))
          require((await rechecksOfOrg(ctx, orgId).first()) === null, rule(
            'Demo cleanup left organization data',
          ))
          const trash = [
            await ctx.db
              .query('deleted_items')
              .withIndex('by_org_deleted', (q) => q.eq('org_id', orgId))
              .first(),
            await ctx.db
              .query('deleted_rows')
              .withIndex('by_org', (q) => q.eq('org_id', orgId))
              .first(),
            await ctx.db
              .query('deleted_tasks')
              .withIndex('by_org_num', (q) => q.eq('org_id', orgId))
              .first(),
          ]
          require(trash.every((row) => row === null), rule('Demo cleanup left Deleted items'))
          // each export job goes after its parts and request rows
          require((await jobsOf(ctx, orgId).first()) === null, rule(
            'Demo cleanup left organization data',
          ))
          await deleteOrgBookkeeping(ctx, orgId)
          const org = await byId(ctx, 'organizations', orgId)
          if (org) await ctx.db.delete(org._id)
          // The ids its tasks and projects held go last, once nothing else
          // of it is left, over as many batches as they take; a batch that
          // stops comes back to this phase (model/usedIds.ts).
          const ids = { left: budget.left, bytes: TRASH_BYTES }
          const released = await releaseUsedIds(ctx, orgId, ids)
          budget.left = ids.left
          if (!released) break
        }
        await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
          input: { model: 'user', where: [{ field: '_id', value: receipt.auth_user_id }] },
        })
        for (const counts of await ctx.db
          .query('demo_write_counts')
          .withIndex('by_demo', (q) => q.eq('demo_id', receipt.id))
          .collect())
          await ctx.db.delete(counts._id)
        await ctx.db.delete(receipt._id)
        console.info('Demo cleanup completed', {
          lag_ms: Math.max(0, Date.now() - receipt.expires_at),
        })
        return null
      }
      if (!done) break
      phase = PHASES[PHASES.indexOf(phase as (typeof PHASES)[number]) + 1]
    }
    const scheduled = await ctx.scheduler.runAfter(waitingUploads ? 5000 : 0, purgeRef, { demo_id })
    await ctx.db.patch(receipt._id, {
      cleanup_phase: phase,
      cleanup_progress_at: Date.now(),
      cleanup_scheduled_id: scheduled,
    })
    return null
  },
})

/** Recovery is deliberately bounded and remains active when new demo
 * admission is stopped. A failed batch leaves its last durable phase. */
export const recover = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    if (process.env.APP_MODE !== 'demo') return null
    requireDemoDeployment()
    const now = Date.now()
    const overdue = await ctx.db
      .query('demo_sessions')
      .withIndex('by_expiry', (q) => q.lte('expires_at', now - 5 * 60_000))
      .take(100)
    if (overdue.length)
      console.warn('Demo cleanup overdue', {
        count_at_least: overdue.length,
        oldest_lag_ms: now - overdue[0].expires_at,
      })
    for (const status of ['unprovisioned', 'ready'] as const) {
      const expired = await ctx.db
        .query('demo_sessions')
        .withIndex('by_status_expiry', (q) => q.eq('status', status).lte('expires_at', now))
        .take(32)
      for (const receipt of expired) await ctx.scheduler.runAfter(0, expireRef, { id: receipt.id })
    }
    const stalled = await ctx.db
      .query('demo_sessions')
      .withIndex('by_status_progress', (q) =>
        q.eq('status', 'deleting').lt('cleanup_progress_at', now - STALLED_MS),
      )
      .take(32)
    for (const receipt of stalled) {
      const scheduled = await ctx.scheduler.runAfter(0, purgeRef, { demo_id: receipt.id })
      await ctx.db.patch(receipt._id, { cleanup_progress_at: now, cleanup_scheduled_id: scheduled })
    }
    return null
  },
})

/* Durable public-demo deletion. Child rows are drained before their parent,
 * and every transaction has a fixed deletion budget. Re-running a batch after
 * an interrupted scheduler delivery cannot recreate content or extend access. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { components } from '../_generated/api'
import type { Doc, Id, TableNames } from '../_generated/dataModel'
import { internalMutation, type MutationCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { requireDemoDeployment } from '../lib/demo'
import { require, rule } from '../lib/functions'
import { recordDemoCreated } from '../model/demoMetrics'
import { drainDemoUploads } from '../model/demoUploads'
import { marketingId } from './marketingDemoData'

const BATCH = 64
const STALLED_MS = 60_000
// The explicitly requested Northstar refresh retires only the original seed.
// Keep this cutoff fixed: future dataset releases must not reset live visitors.
const NORTHSTAR_RESET_VERSION = 3
const purgeRef = makeFunctionReference<'mutation', { demo_id: string }, null>(
  'internal/demoCleanup:purge',
)
const expireRef = makeFunctionReference<'mutation', { id: string }, null>('demo:expire')

type Budget = { left: number }

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

async function removeFile(ctx: MutationCtx, id: Id<'_storage'> | undefined) {
  if (id !== undefined && (await ctx.db.system.get(id))) await ctx.storage.delete(id)
}

async function taskRows(ctx: MutationCtx, orgId: string, budget: Budget): Promise<boolean> {
  while (budget.left > 0) {
    const issue = await ctx.db
      .query('issues')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .first()
    if (!issue) return true
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
          .withIndex('by_issue', (q) => q.eq('issue_id', id))
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
          .withIndex('by_issue', (q) => q.eq('issue_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(
        ctx,
        budget,
        (n) =>
          ctx.db
            .query('issue_attachments')
            .withIndex('by_issue', (q) => q.eq('issue_id', id))
            .take(n),
        (row) => removeFile(ctx, row.storage_id),
      ))
    )
      return false
    await ctx.db.delete(issue._id)
    budget.left--
  }
  return false
}

async function projectRows(ctx: MutationCtx, orgId: string, budget: Budget): Promise<boolean> {
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
    budget.left--
  }
  return false
}

async function teamRows(ctx: MutationCtx, orgId: string, budget: Budget): Promise<boolean> {
  while (budget.left > 0) {
    const team = await ctx.db
      .query('teams')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .first()
    if (!team) return true
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
    if (!profile) return true
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
          .query('messages')
          .withIndex('by_recipient', (q) => q.eq('recipient_id', id))
          .take(n),
      ))
    )
      return false
    if (
      !(await drain(ctx, budget, (n) =>
        ctx.db
          .query('issue_subscriptions')
          .withIndex('by_profile', (q) => q.eq('profile_id', id))
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

async function labelRows(ctx: MutationCtx, orgId: string, budget: Budget): Promise<boolean> {
  while (budget.left > 0) {
    const label = await ctx.db
      .query('labels')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .first()
    if (!label) return true
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
  'oauthClient',
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
  return true
}

const PHASES = [
  'sessions',
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
      } else if (phase === 'tasks') done = !orgId || (await taskRows(ctx, orgId, budget))
      else if (phase === 'projects') done = !orgId || (await projectRows(ctx, orgId, budget))
      else if (phase === 'teams') done = !orgId || (await teamRows(ctx, orgId, budget))
      else if (phase === 'profiles') done = !orgId || (await profileRows(ctx, orgId, budget))
      else if (phase === 'labels') done = !orgId || (await labelRows(ctx, orgId, budget))
      else if (phase === 'activity')
        done =
          !orgId ||
          (await drain(ctx, budget, (n) =>
            ctx.db
              .query('activity_events')
              .withIndex('by_org_ts', (q) => q.eq('org_id', orgId))
              .take(n),
          ))
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
      else if (phase === 'finish') {
        // No owner/work should reappear after the drained phases: all public
        // and background finalization paths fence against deleting receipts.
        require((await ctx.db
          .query('profiles')
          .withIndex('by_auth', (q) => q.eq('auth_user_id', receipt.auth_user_id))
          .first()) === null, rule('Demo login still owns a profile'))
        if (orgId) {
          for (const table of ['issues', 'projects', 'teams', 'profiles', 'labels'] as const)
            require((await ctx.db
              .query(table)
              .withIndex('by_org', (q) => q.eq('org_id', orgId))
              .first()) === null, rule('Demo cleanup left organization data'))
          const org = await byId(ctx, 'organizations', orgId)
          if (org) await ctx.db.delete(org._id)
        }
        await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
          input: { model: 'user', where: [{ field: '_id', value: receipt.auth_user_id }] },
        })
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
    // Admission caps the entire receipt table at 500. Filter the indexed ready
    // prefix before taking a batch so current visitors cannot hide old copies.
    // Unprovisioned receipts and unknown versions retain their normal deadline.
    const previousNorthstar = await ctx.db
      .query('demo_sessions')
      .withIndex('by_status_expiry', (q) => q.eq('status', 'ready').gt('expires_at', now))
      .filter((q) =>
        q.and(
          q.gte(q.field('seed_version'), 1),
          q.lt(q.field('seed_version'), NORTHSTAR_RESET_VERSION),
        ),
      )
      .take(32)
    for (const receipt of previousNorthstar) {
      const expiry_scheduled_id = await ctx.scheduler.runAfter(0, expireRef, { id: receipt.id })
      await ctx.db.patch(receipt._id, { expires_at: now, expiry_scheduled_id })
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

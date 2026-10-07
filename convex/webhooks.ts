import { makeFunctionReference } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, internalQuery } from './_generated/server'
import { profileCanSeeProject } from './lib/access'
import { byId } from './lib/db'
import { badRequest, forbidden, notFound } from './lib/functions'
import {
  type EventFilters,
  type EventOwner,
  permanentWebhookStatus,
  subscriptionActive,
  vEventFilters,
  vEventName,
  vEventOwner,
  WEBHOOK_LEASE_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MAX_TTL_MS,
  WEBHOOK_ORG_CONCURRENCY,
  WEBHOOK_RETRY_BASE_MS,
} from './lib/taskEvents'
import { eventOwnerProfile } from './model/taskEvents'
import {
  readWebhookHealth,
  removeWebhookSubscription,
  writeWebhookHealth,
} from './model/webhookHealth'
import { pruneRemovedWebhookOwners } from './model/webhookOwners'
import { dispatchWebhooksRef, requestWebhookDispatch } from './model/webhookQueue'

const internalSweepRef = makeFunctionReference<'mutation', Record<string, never>, null>(
  'webhooks:sweep',
)

const MAX_ORG_SUBSCRIPTIONS = 100
const MAX_OWNER_SUBSCRIPTIONS = 20
const FAILURE_WINDOW = WEBHOOK_MAX_TTL_MS

async function requireOwner(ctx: QueryCtx, owner: EventOwner): Promise<Doc<'profiles'>> {
  const profile = await eventOwnerProfile(ctx, owner)
  if (!profile) throw forbidden('Credential is no longer valid')
  return profile
}

async function authorizeFilters(
  ctx: QueryCtx,
  profile: Doc<'profiles'>,
  filters: EventFilters,
): Promise<void> {
  if (filters.project_id) {
    const project = await byId(ctx, 'projects', filters.project_id)
    if (
      !project ||
      project.org_id !== profile.org_id ||
      !(await profileCanSeeProject(ctx, profile, project))
    )
      throw notFound('project not found (or not visible to you)')
    if (project.type === 'meta') throw badRequest('Choose a task project, not a parent project')
  }
  if (filters.task_id) {
    const issue = await byId(ctx, 'issues', filters.task_id)
    const project = issue ? await byId(ctx, 'projects', issue.project_id) : null
    if (
      !issue ||
      issue.org_id !== profile.org_id ||
      !project ||
      !(await profileCanSeeProject(ctx, profile, project))
    )
      throw notFound('task not found (or not visible to you)')
    if (filters.project_id && issue.project_id !== filters.project_id)
      throw badRequest('Task does not belong to the selected project')
  }
}

export const authorize = internalQuery({
  args: { owner: vEventOwner, filters: vEventFilters },
  handler: async (ctx, { owner, filters }): Promise<null> => {
    await authorizeFilters(ctx, await requireOwner(ctx, owner), filters)
    return null
  },
})

export const save = internalMutation({
  args: {
    owner: vEventOwner,
    id: v.string(),
    name: vEventName,
    filters: vEventFilters,
    url: v.string(),
    encrypted_secret: v.string(),
    secret_hash: v.optional(v.string()),
    legacy_secret_hash: v.optional(v.string()),
    expires_at: v.optional(v.number()),
  },
  handler: async (
    ctx,
    a,
  ): Promise<{ id: string; refreshBefore: string | null; cursor: null; truncated: false }> => {
    const { legacy_secret_hash, ...registration } = a
    const profile = await requireOwner(ctx, a.owner)
    await authorizeFilters(ctx, profile, a.filters)
    const existing = await byId(ctx, 'webhook_subscriptions', a.id)
    const expired = existing?.expires_at !== undefined && existing.expires_at <= Date.now()
    // Expired registrations never enter active scans. Reclaim a bounded batch eagerly;
    // retention continues in the background for backlogs from earlier deployments.
    const expiredRows = await ctx.db
      .query('webhook_subscriptions')
      .withIndex('by_org_expiry', (q) =>
        q.eq('org_id', profile.org_id).gt('expires_at', 0).lte('expires_at', Date.now()),
      )
      .take(200)
    for (const row of expiredRows)
      if (row._id !== existing?._id) await removeWebhookSubscription(ctx, row)
    if (expiredRows.length === 200) await ctx.scheduler.runAfter(0, internalSweepRef, {})
    const live = await pruneRemovedWebhookOwners(ctx, await liveSubscriptions(ctx, profile.org_id))
    if (
      (!existing || expired) &&
      (live.length >= MAX_ORG_SUBSCRIPTIONS ||
        live.filter((row) => row.owner.credential_row_id === a.owner.credential_row_id).length >=
          MAX_OWNER_SUBSCRIPTIONS)
    )
      throw new ConvexError({
        code: 'bad_request',
        reason: 'webhook_subscription_limit',
        message: 'Webhook subscription limit reached',
      })
    if (
      existing &&
      (existing.owner.credential_row_id !== a.owner.credential_row_id ||
        existing.owner.profile_id !== a.owner.profile_id)
    )
      throw forbidden('Subscription belongs to another credential')
    if (existing && !expired) {
      // Upgrading the hash must not replace the old signing key during its grace period.
      // The legacy verifier is transient. Only the current keyed hash is persisted.
      const secretChanged =
        a.secret_hash === undefined ||
        (a.secret_hash !== existing.secret_hash &&
          (legacy_secret_hash === undefined || legacy_secret_hash !== existing.secret_hash))
      if (existing.disabled_at !== undefined)
        await writeWebhookHealth(ctx, existing, { failed_since: undefined })
      await ctx.db.patch(existing._id, {
        ...registration,
        secret_hash: a.secret_hash,
        expires_at: a.expires_at,
        revision: (existing.revision ?? 0) + (existing.disabled_at === undefined ? 0 : 1),
        disabled_at: undefined,
        disabled_reason: undefined,
        failed_since: existing.disabled_at === undefined ? existing.failed_since : undefined,
        ...(secretChanged
          ? {
              previous_secret: existing.encrypted_secret,
              rotation_until: Date.now() + 5 * 60_000,
            }
          : {}),
      })
    } else {
      if (existing) await removeWebhookSubscription(ctx, existing)
      await ctx.db.insert('webhook_subscriptions', {
        ...registration,
        org_id: profile.org_id,
        created_at: Date.now(),
      })
    }
    return {
      id: a.id,
      refreshBefore: a.expires_at === undefined ? null : new Date(a.expires_at).toISOString(),
      cursor: null,
      truncated: false,
    }
  },
})

async function liveSubscriptions(ctx: QueryCtx, org: string) {
  return (
    await Promise.all([
      ctx.db
        .query('webhook_subscriptions')
        .withIndex('by_org_expiry', (q) => q.eq('org_id', org).eq('expires_at', undefined))
        .take(101),
      ctx.db
        .query('webhook_subscriptions')
        .withIndex('by_org_expiry', (q) => q.eq('org_id', org).gt('expires_at', Date.now()))
        .take(101),
    ])
  ).flat()
}

async function subscriptionStatus(ctx: QueryCtx, row: Doc<'webhook_subscriptions'>) {
  const health = await readWebhookHealth(ctx, row)
  return {
    id: row.id,
    name: row.name,
    arguments: row.filters,
    delivery: { mode: 'webhook', url: row.url },
    refreshBefore: row.expires_at === undefined ? null : new Date(row.expires_at).toISOString(),
    status: row.disabled_at === undefined ? 'active' : 'disabled',
    disabled_at: row.disabled_at === undefined ? null : new Date(row.disabled_at).toISOString(),
    disabled_reason: row.disabled_reason ?? null,
    failed_since:
      health.failed_since === undefined ? null : new Date(health.failed_since).toISOString(),
    last_failure_at:
      health.last_failure_at === undefined ? null : new Date(health.last_failure_at).toISOString(),
    last_success_at:
      health.last_success_at === undefined ? null : new Date(health.last_success_at).toISOString(),
    last_status: health.last_status ?? null,
  }
}

export const list = internalQuery({
  args: { owner: vEventOwner },
  handler: async (ctx, { owner }) => {
    const profile = await requireOwner(ctx, owner)
    return Promise.all(
      (await liveSubscriptions(ctx, profile.org_id))
        .filter((row) => row.owner.credential_row_id === owner.credential_row_id)
        .map((row) => subscriptionStatus(ctx, row)),
    )
  },
})

async function requireAdministrator(ctx: QueryCtx, owner: EventOwner) {
  const profile = await requireOwner(ctx, owner)
  if (profile.kind !== 'person' || profile.org_role !== 'admin')
    throw forbidden('Organization administrator access is required')
  return profile
}

export const listOrganization = internalQuery({
  args: { owner: vEventOwner },
  handler: async (ctx, { owner }) => {
    const profile = await requireAdministrator(ctx, owner)
    return Promise.all(
      (await liveSubscriptions(ctx, profile.org_id)).map(async (row) => ({
        ...(await subscriptionStatus(ctx, row)),
        owner: {
          profile_id: row.owner.profile_id,
          credential_type: row.owner.credential_table,
          credential_id: row.owner.credential_id,
        },
      })),
    )
  },
})

export const removeOrganization = internalMutation({
  args: { owner: vEventOwner, id: v.string() },
  handler: async (ctx, { owner, id }): Promise<null> => {
    const profile = await requireAdministrator(ctx, owner)
    const row = await byId(ctx, 'webhook_subscriptions', id)
    if (!row) return null
    if (row.org_id !== profile.org_id) throw notFound('webhook subscription not found')
    await removeWebhookSubscription(ctx, row)
    return null
  },
})

export const remove = internalMutation({
  args: { owner: vEventOwner, id: v.string() },
  handler: async (ctx, { owner, id }): Promise<null> => {
    await requireOwner(ctx, owner)
    const row = await byId(ctx, 'webhook_subscriptions', id)
    if (!row) return null
    if (
      row.owner.credential_row_id !== owner.credential_row_id ||
      row.owner.profile_id !== owner.profile_id
    )
      throw notFound('webhook subscription not found')
    await removeWebhookSubscription(ctx, row)
    return null
  },
})

/** Older move deliveries did not retain the source project needed for authorization. */
function missingMoveSource(delivery: Doc<'webhook_deliveries'>): boolean {
  if (delivery.name !== 'task.updated' || delivery.source_project_id !== undefined) return false
  try {
    const payload = JSON.parse(delivery.payload) as {
      data?: { changed_fields?: unknown }
    } | null
    return (
      Array.isArray(payload?.data?.changed_fields) &&
      payload.data.changed_fields.includes('project_id')
    )
  } catch {
    return true
  }
}

/** Claim one registration's work and persist when its lease needs recovery. */
export const claim = internalMutation({
  args: { id: v.string() },
  handler: async (
    ctx,
    { id },
  ): Promise<{
    delivery: Doc<'webhook_deliveries'>
    subscription: Doc<'webhook_subscriptions'>
    attempt: number
  } | null> => {
    const delivery = await byId(ctx, 'webhook_deliveries', id)
    if (
      !delivery ||
      ['delivered', 'failed'].includes(delivery.status) ||
      (delivery.lease_until ?? 0) > Date.now()
    )
      return null
    const subscription = await byId(ctx, 'webhook_subscriptions', delivery.subscription_id)
    const profile = subscription ? await eventOwnerProfile(ctx, subscription.owner) : null
    const project = await byId(ctx, 'projects', delivery.project_id)
    const task = await byId(ctx, 'issues', delivery.task_id)
    const taskProject = task ? await byId(ctx, 'projects', task.project_id) : null
    const sourceProject = delivery.source_project_id
      ? await byId(ctx, 'projects', delivery.source_project_id)
      : null
    if (
      !subscription ||
      subscription._id !== delivery.subscription_row_id ||
      !subscriptionActive(subscription) ||
      !profile ||
      !project ||
      subscription.org_id !== profile.org_id ||
      delivery.org_id !== profile.org_id ||
      project.org_id !== profile.org_id ||
      !(await profileCanSeeProject(ctx, profile, project)) ||
      (!task && delivery.name !== 'task.deleted') ||
      (task && (!taskProject || !(await profileCanSeeProject(ctx, profile, taskProject)))) ||
      (delivery.source_project_id !== undefined &&
        (!sourceProject || !(await profileCanSeeProject(ctx, profile, sourceProject)))) ||
      missingMoveSource(delivery) ||
      delivery.attempts >= WEBHOOK_MAX_ATTEMPTS
    ) {
      await ctx.db.patch(delivery._id, {
        status: 'failed',
        completed_at: Date.now(),
        lease_until: undefined,
        scheduled_for: undefined,
        scheduled_job: undefined,
      })
      await wakePendingWebhookWork(ctx, delivery.org_id)
      return null
    }
    const occupied = await occupiedDeliveries(ctx, delivery.org_id)
    if (
      occupied.hasMore ||
      occupied.rows.some(
        (row) =>
          row._id !== delivery._id && row.subscription_row_id === delivery.subscription_row_id,
      ) ||
      occupied.rows.filter((row) => row._id !== delivery._id).length >= WEBHOOK_ORG_CONCURRENCY
    )
      return null
    const attempt = delivery.attempts + 1
    const leaseUntil = Date.now() + WEBHOOK_LEASE_MS
    await ctx.db.patch(delivery._id, {
      status: 'sending',
      subscription_revision: subscription.revision ?? 0,
      attempts: attempt,
      lease_until: leaseUntil,
      scheduled_for: leaseUntil,
    })
    return { delivery, subscription, attempt }
  },
})

export const finish = internalMutation({
  args: { id: v.string(), attempt: v.number(), status: v.number() },
  handler: async (ctx, { id, attempt, status }): Promise<null> => {
    const row = await byId(ctx, 'webhook_deliveries', id)
    if (!row || row.attempts !== attempt || row.status !== 'sending') return null
    const sub = await byId(ctx, 'webhook_subscriptions', row.subscription_id)
    // Disabled recovery fences old health replies; active renewal preserves them.
    const sameRegistration = sub !== null && row.subscription_row_id === sub._id
    const current = sameRegistration && (row.subscription_revision ?? 0) === (sub.revision ?? 0)
    const delivered = status >= 200 && status < 300
    let stopped = !sameRegistration || !subscriptionActive(sub)
    // A 410 abandons this event without changing the subscription or its health.
    if (current && !stopped && status !== 410) {
      if (delivered) {
        await writeWebhookHealth(ctx, sub, {
          failed_since: undefined,
          last_success_at: Date.now(),
          last_status: status,
        })
      } else {
        const health = await readWebhookHealth(ctx, sub)
        const failedSince = health.failed_since ?? Date.now()
        stopped = Date.now() - failedSince >= FAILURE_WINDOW
        await writeWebhookHealth(ctx, sub, {
          failed_since: failedSince,
          last_failure_at: Date.now(),
          last_status: status,
        })
        if (stopped)
          await ctx.db.patch(sub._id, {
            disabled_at: Date.now(),
            disabled_reason: 'delivery_failures',
          })
      }
    }
    const done =
      delivered ||
      status === 410 ||
      permanentWebhookStatus(status) ||
      attempt >= WEBHOOK_MAX_ATTEMPTS ||
      stopped
    const delay = WEBHOOK_RETRY_BASE_MS * 2 ** (attempt - 1)
    const retryAt = done ? undefined : Date.now() + delay
    await ctx.db.patch(row._id, {
      status: delivered ? 'delivered' : done ? 'failed' : 'pending',
      last_status: status,
      completed_at: done ? Date.now() : undefined,
      lease_until: retryAt,
      scheduled_for: retryAt,
      scheduled_job: undefined,
    })
    await wakePendingWebhookWork(ctx, row.org_id)
    if (!done) await ctx.scheduler.runAfter(delay, dispatchWebhooksRef, {})
    return null
  },
})

/** Release organization capacity without waking retries before their backoff ends. */
async function wakePendingWebhookWork(ctx: MutationCtx, org: string): Promise<void> {
  const now = Date.now()
  const next = await ctx.db
    .query('webhook_deliveries')
    .withIndex('by_org_status_scheduled', (q) => q.eq('org_id', org).eq('status', 'pending'))
    .take(WEBHOOK_ORG_CONCURRENCY)
  let ready = false
  for (const waiting of next) {
    const scheduledFor = Math.max(now, waiting.lease_until ?? 0)
    if (waiting.scheduled_for !== scheduledFor)
      await ctx.db.patch(waiting._id, { scheduled_for: scheduledFor })
    if (scheduledFor === now) ready = true
  }
  if (ready) await requestWebhookDispatch(ctx)
}

/** Release abandoned reservations in bounded batches, retaining every live scheduled action.
 * Uninspected rows conservatively fill the organization until recovery can inspect them. */
export async function occupiedDeliveries(
  ctx: MutationCtx,
  org: string,
): Promise<{
  rows: Doc<'webhook_deliveries'>[]
  hasMore: boolean
  recovering: boolean
}> {
  const batchSize = WEBHOOK_ORG_CONCURRENCY * 2
  const pages = await Promise.all(
    (['queued', 'sending'] as const).map((status) =>
      ctx.db
        .query('webhook_deliveries')
        .withIndex('by_org_status_scheduled', (q) => q.eq('org_id', org).eq('status', status))
        .take(batchSize + 1),
    ),
  )
  const rows: Doc<'webhook_deliveries'>[] = []
  let released = false
  for (const page of pages) {
    for (const row of page.slice(0, batchSize)) {
      const deadline = row.status === 'sending' ? row.lease_until : row.scheduled_for
      // Peer scheduler state changes frequently. Keep each reservation until its
      // deadline, then inspect the job before releasing or extending its slot.
      if ((deadline ?? 0) > Date.now()) {
        rows.push(row)
        continue
      }
      const job = row.scheduled_job ? await ctx.db.system.get(row.scheduled_job) : null
      const live = job?.state.kind === 'pending' || job?.state.kind === 'inProgress'
      if (live || (!row.scheduled_job && (row.lease_until ?? 0) > Date.now())) {
        rows.push(row)
        continue
      }
      await ctx.db.patch(row._id, {
        status: 'pending',
        scheduled_for: Date.now(),
        lease_until: undefined,
        scheduled_job: undefined,
      })
      released = true
    }
  }
  const hasMore = pages.some((page) => page.length > batchSize)
  const recovering = released && hasMore
  if (recovering) await requestWebhookDispatch(ctx)
  return { rows, hasMore, recovering }
}

/** Drain retention in bounded transactions until the backlog is caught up. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const expired = await ctx.db
      .query('webhook_subscriptions')
      .withIndex('by_expiry', (q) => q.gt('expires_at', 0).lte('expires_at', Date.now()))
      .take(200)
    for (const row of expired) await removeWebhookSubscription(ctx, row)
    const completed = await ctx.db
      .query('webhook_deliveries')
      .withIndex('by_completed', (q) =>
        q.gt('completed_at', 0).lt('completed_at', Date.now() - WEBHOOK_MAX_TTL_MS),
      )
      .take(500)
    for (const row of completed) await ctx.db.delete(row._id)
    if (expired.length === 200 || completed.length === 500)
      await ctx.scheduler.runAfter(0, internalSweepRef, {})
    return null
  },
})

import { components } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { profileCanSeeProject } from '../lib/access'
import { byId } from '../lib/db'
import { isDemoDeployment } from '../lib/demo'
import { mcpResource } from '../lib/oauth'
import { type EventName, type EventOwner, subscriptionActive } from '../lib/taskEvents'
import { issueKey } from '../lib/taskRefs'
import { newUuid } from './orgs'
import { expandWebhookEventsRef } from './webhookQueue'

/** Bind subscriptions to the exact credential record and its live authorization. */
export async function eventOwnerProfile(
  ctx: QueryCtx,
  owner: EventOwner,
): Promise<Doc<'profiles'> | null> {
  if (isDemoDeployment()) return null
  const profile = await byId(ctx, 'profiles', owner.profile_id)
  if (!profile?.active) return null
  const credential = await byId(ctx, owner.credential_table, owner.credential_id)
  if (
    !credential ||
    credential._id !== owner.credential_row_id ||
    credential.profile_id !== profile.id ||
    credential.revoked_at !== undefined
  )
    return null
  if (owner.credential_table === 'agent_keys' && profile.kind !== 'agent') return null
  if (
    owner.credential_table !== 'agent_keys' &&
    (profile.kind !== 'person' || !profile.auth_user_id)
  )
    return null
  if ('scopes' in credential) {
    if (
      !credential.approved_at ||
      !credential.scopes.includes('qivo:read') ||
      credential.org_id !== profile.org_id ||
      credential.auth_user_id !== profile.auth_user_id ||
      credential.resource !== mcpResource()
    )
      return null
    const client = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'oauthClient',
      where: [{ field: 'clientId', value: credential.client_id }],
    })) as { disabled?: boolean } | null
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: '_id', value: credential.auth_user_id }],
    })) as { banned?: boolean } | null
    if (!client || client.disabled || !user || user.banned) return null
  }
  return profile
}

/** These caches belong to one mutation context, never to a user or a later request.
 * Batch task writes share authorization reads while retaining the original recipients.
 * Delivery expansion and claiming independently recheck current authorization. */
const contexts = new WeakMap<
  MutationCtx,
  {
    subscriptions: Map<string, Promise<Doc<'webhook_subscriptions'>[]>>
    profiles: Map<string, Promise<Doc<'profiles'> | null>>
    projects: Map<string, Promise<Doc<'projects'> | null>>
    access: Map<string, Promise<boolean>>
    wakeRequested: boolean
  }
>()

function eventContext(ctx: MutationCtx) {
  let cached = contexts.get(ctx)
  if (!cached) {
    cached = {
      subscriptions: new Map(),
      profiles: new Map(),
      projects: new Map(),
      access: new Map(),
      wakeRequested: false,
    }
    contexts.set(ctx, cached)
  }
  return cached
}

export async function readableEventProject(
  ctx: MutationCtx,
  owner: EventOwner,
  projectId: string,
): Promise<boolean> {
  const cached = eventContext(ctx)
  let profile = cached.profiles.get(owner.credential_row_id)
  if (!profile) {
    profile = eventOwnerProfile(ctx, owner)
    cached.profiles.set(owner.credential_row_id, profile)
  }
  // Credentials stay independent even when they share the same profile permissions.
  const who = await profile
  if (!who) return false
  const key = JSON.stringify([who.id, projectId])
  let access = cached.access.get(key)
  if (!access) {
    access = (async () => {
      let project = cached.projects.get(projectId)
      if (!project) {
        project = byId(ctx, 'projects', projectId)
        cached.projects.set(projectId, project)
      }
      const where = await project
      return !!where && who.org_id === where.org_id && (await profileCanSeeProject(ctx, who, where))
    })()
    cached.access.set(key, access)
  }
  return access
}

/** Record one event atomically, without multiplying task writes by subscription count. */
export async function emitTaskEvent(
  ctx: MutationCtx,
  a: {
    name: EventName
    issue: Doc<'issues'>
    actor?: Doc<'profiles'>
    now: string
    before?: Doc<'issues'>
  },
): Promise<void> {
  if (isDemoDeployment()) return
  const changed = a.before
    ? Array.from(new Set([...Object.keys(a.issue), ...Object.keys(a.before)])).filter(
        (key) =>
          !['_id', '_creationTime', 'updated_at'].includes(key) &&
          JSON.stringify(a.issue[key as keyof Doc<'issues'>]) !==
            JSON.stringify(a.before?.[key as keyof Doc<'issues'>]),
      )
    : []
  if (a.name === 'task.updated' && changed.length === 0) return
  const cached = eventContext(ctx)
  const key = JSON.stringify([a.issue.org_id, a.name])
  let subscriptions = cached.subscriptions.get(key)
  if (!subscriptions) {
    subscriptions = Promise.all([
      ctx.db
        .query('webhook_subscriptions')
        .withIndex('by_org_name_expiry', (q) =>
          q.eq('org_id', a.issue.org_id).eq('name', a.name).eq('expires_at', undefined),
        )
        .take(100),
      ctx.db
        .query('webhook_subscriptions')
        .withIndex('by_org_name_expiry', (q) =>
          q.eq('org_id', a.issue.org_id).eq('name', a.name).gt('expires_at', Date.now()),
        )
        .take(100),
    ]).then((rows) => rows.flat())
    cached.subscriptions.set(key, subscriptions)
  }
  const source =
    a.before && a.before.project_id !== a.issue.project_id ? a.before.project_id : undefined
  const recipients: Doc<'webhook_subscriptions'>['_id'][] = []
  for (const subscription of await subscriptions) {
    if (
      !subscriptionActive(subscription) ||
      (subscription.filters.task_id && subscription.filters.task_id !== a.issue.id) ||
      (subscription.filters.project_id && subscription.filters.project_id !== a.issue.project_id)
    )
      continue
    if (
      !(await readableEventProject(ctx, subscription.owner, a.issue.project_id)) ||
      (source && !(await readableEventProject(ctx, subscription.owner, source)))
    )
      continue
    recipients.push(subscription._id)
  }
  if (!recipients.length) return
  const eventId = newUuid()
  await ctx.db.insert('webhook_events', {
    id: eventId,
    org_id: a.issue.org_id,
    project_id: a.issue.project_id,
    source_project_id: source,
    task_id: a.issue.id,
    name: a.name,
    subscription_rows: recipients,
    next_recipient: 0,
    created_at: Date.now(),
    payload: JSON.stringify({
      eventId,
      name: a.name,
      timestamp: a.now,
      data: {
        task_id: a.issue.id,
        task_ref: issueKey(a.issue.num),
        project_id: a.issue.project_id,
        actor_id: a.actor?.id ?? null,
        changed_fields: changed.sort(),
      },
      cursor: null,
    }),
  })
  if (!cached.wakeRequested) {
    cached.wakeRequested = true
    await ctx.scheduler.runAfter(0, expandWebhookEventsRef, {})
  }
}

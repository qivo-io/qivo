import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import {
  credentialAccess,
  findAuthUser,
  liveCredentialRow,
  loginBanned,
  oauthClientLive,
  profileCanSeeProject,
} from '../lib/access'
import { deletionBegun } from '../lib/billingAccess'
import { byId } from '../lib/db'
import { isDemoDeployment } from '../lib/demo'
import type { CredentialAccess } from '../lib/enums'
import { mcpResource } from '../lib/oauth'
import { type EventName, type EventOwner, subscriptionActive } from '../lib/taskEvents'
import { issueKey } from '../lib/taskRefs'
import { newUuid } from './orgs'
import { expandWebhookEventsRef } from './webhookQueue'

/**
 * Bind subscriptions to the exact credential record and its live
 * authorization. Answers the owner's profile and what the credential may do
 * (lib/access.ts credentialAccess), or null once the credential stops
 * authorizing anything because it was revoked, expired or replaced, its
 * account is gone or deactivated, its organization's deletion has begun,
 * its person's login is banned or no longer exists in Better Auth, or, for
 * an OAuth grant, its client was
 * disabled or lost its link to the MCP resource (lib/access.ts
 * oauthClientLive). Subscribing, delivery and every event's fan-out ask this.
 */
export async function eventOwner(
  ctx: QueryCtx,
  owner: EventOwner,
): Promise<{ profile: Doc<'profiles'>; access: CredentialAccess } | null> {
  if (isDemoDeployment()) return null
  const profile = await byId(ctx, 'profiles', owner.profile_id)
  if (!profile?.active) return null
  // a deletion that has begun refuses every call into the organization
  // (lib/billingAccess.ts assertOrgAvailable), its webhooks too
  if (await deletionBegun(ctx, profile.org_id)) return null
  const now = Date.now()
  const credential = await liveCredentialRow(ctx, owner, now)
  if (!credential) return null
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
    // the same client check every MCP and REST call makes (lookupAccess)
    if (!(await oauthClientLive(ctx, credential.client_id, credential.resource))) return null
    const user = await findAuthUser(ctx, credential.auth_user_id)
    if (!user || loginBanned(user, now)) return null
    return {
      profile,
      access: credentialAccess({ table: 'oauth_connections', scopes: credential.scopes }, profile),
    }
  }
  if ('token_hash' in credential) {
    // A personal token acts as its person's login, so a platform ban, or a
    // login Better Auth no longer has, stops its subscriptions like a
    // deactivation, as for OAuth owners. They get no events, their queued
    // deliveries fail, and the rows stay for when the ban lifts. Each check
    // of a token owner costs one Better Auth user read, as OAuth owners
    // already do. Fan-out pays it once per credential and mutation
    // (readableEventProject caches the owner). The checks above guarantee
    // auth_user_id; this only narrows its type.
    const user = profile.auth_user_id ? await findAuthUser(ctx, profile.auth_user_id) : null
    if (user === null || loginBanned(user, now)) return null
    return {
      profile,
      access: credentialAccess({ table: 'mcp_tokens', token: credential, now }, profile),
    }
  }
  // Agent keys belong to no login, so a platform ban cannot reach them and
  // they skip the read. The agent's active flag stops them.
  return { profile, access: credentialAccess({ table: 'agent_keys' }, profile) }
}

/** The owner's profile alone, for callers that only check visibility. */
export async function eventOwnerProfile(
  ctx: QueryCtx,
  owner: EventOwner,
): Promise<Doc<'profiles'> | null> {
  return (await eventOwner(ctx, owner))?.profile ?? null
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

/** The unexpired subscriptions to `name` events in `orgId`, at most 200,
 * read once per mutation and shared with emitTaskEvent. An event checks
 * each one, so their number bounds what one event costs. */
export function eventSubscriptions(
  ctx: MutationCtx,
  orgId: string,
  name: EventName,
): Promise<Doc<'webhook_subscriptions'>[]> {
  const cached = eventContext(ctx)
  const key = JSON.stringify([orgId, name])
  let subscriptions = cached.subscriptions.get(key)
  if (!subscriptions) {
    subscriptions = Promise.all([
      ctx.db
        .query('webhook_subscriptions')
        .withIndex('by_org_name_expiry', (q) =>
          q.eq('org_id', orgId).eq('name', name).eq('expires_at', undefined),
        )
        .take(100),
      ctx.db
        .query('webhook_subscriptions')
        .withIndex('by_org_name_expiry', (q) =>
          q.eq('org_id', orgId).eq('name', name).gt('expires_at', Date.now()),
        )
        .take(100),
    ]).then((rows) => rows.flat())
    cached.subscriptions.set(key, subscriptions)
  }
  return subscriptions
}

/* Whether two stored field values are equal as JSON. Two strings, such as
 * long descriptions, compare without being encoded. */
const sameValue = (x: unknown, y: unknown): boolean =>
  typeof x === 'string' && typeof y === 'string' ? x === y : JSON.stringify(x) === JSON.stringify(y)

/** Record one event atomically, without multiplying task writes by
 * subscription count. `guard` runs before each subscription's sight check,
 * so a bulk writer can stop before the transaction passes Convex's limits
 * (model/messages.ts NotifyPreload). */
export async function emitTaskEvent(
  ctx: MutationCtx,
  a: {
    name: EventName
    issue: Doc<'issues'>
    actor?: Doc<'profiles'>
    now: string
    before?: Doc<'issues'>
    guard?: () => Promise<void>
  },
): Promise<void> {
  if (isDemoDeployment()) return
  const changed = a.before
    ? Array.from(new Set([...Object.keys(a.issue), ...Object.keys(a.before)])).filter(
        (key) =>
          // relations_marked is the archive steps' bookkeeping and window_key
          // places the task in the app's windows, never news; status_at
          // moves only with status or project_id, which are listed
          ![
            '_id',
            '_creationTime',
            'updated_at',
            'status_at',
            'relations_marked',
            'window_key',
          ].includes(key) &&
          !sameValue(a.issue[key as keyof Doc<'issues'>], a.before?.[key as keyof Doc<'issues'>]),
      )
    : []
  if (a.name === 'task.updated' && changed.length === 0) return
  const cached = eventContext(ctx)
  const subscriptions = eventSubscriptions(ctx, a.issue.org_id, a.name)
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
    await a.guard?.()
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

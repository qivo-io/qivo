/* The login's connected apps on Settings › Your preferences › MCP access
 * (connectedApps.list), a batch of LIST_BATCH at a time, newest approval
 * first, with a search over the whole list. A connection belongs to the
 * login that approved it, not to a seat, so the list reads one range of
 * oauth_connections by_auth_user_approved, also for a login without a
 * seat, and names a connection's seat and organization, or "Removed
 * member" and "Removed organization" once they are gone.
 *
 * The list reads through the shared name-ordered reader
 * (lib/namedPages.ts) in descending order, keyed by approved_at with the
 * tie [_creationTime, _id], Convex's implicit last fields, so equal
 * approval times come newest row first. Every range starts above an
 * approved_at of '', so the unfinished authorizations every consent
 * attempt leaves are never read. ensure (oauthConnections.ts) sets
 * approved_at once, so a connection never moves in the list. A cursor is
 * sealed to the list, the login and the search's name key, and a batch
 * reads under a read share of its own (CONNECTED_APPS) and answers
 * `stopped` where the share ended it.
 *
 * This module and connectedApps.ts load no Better Auth package and not
 * auth.ts, so the list's first call on a fresh isolate pays no load of
 * them (convex/tests/authTriggers.test.ts). Whether an app's OAuth client
 * still exists is one indexed read of the Better Auth component
 * (lib/access.ts findOAuthClient), which loads no Better Auth either. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { findOAuthClient } from '../lib/access'
import type { ReadCeiling } from '../lib/archivedTasks'
import { byId } from '../lib/db'
import { refuseDemoFeature } from '../lib/demo'
import { badRequest } from '../lib/functions'
import { limitedText } from '../lib/limitRules'
import { LIMITS, LIST_BATCH } from '../lib/limits'
import {
  indexAfter,
  type ListBatch,
  listBatch,
  NAMED_READ,
  type NamedAt,
  type NamedIndex,
  namedCeiling,
  openNamedCursor,
  type ReadGuard,
} from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { allWordsMatcher } from '../lib/search'

/** What one batch of connected apps may read past what the call read
 * before it, NAMED_READ's share of 2,000 index ranges, 8,000 documents and
 * 4 MiB. A connection row holds a few uuids, a client name of at most 80
 * characters, its scopes and a few ISO times, under 2 KB, and each kept
 * row reads its seat and its organization once a call, each well under 1
 * KB, so a search that matches only the oldest of a few hundred
 * connections reads each of them once in one index range. Measured in
 * convex/tests/personalCredentialLists.test.ts ("reads everyday
 * batches"), the reader alone, a first batch over 26 approved connections
 * interleaved with 26 deleted ones read 53 documents, 4 index ranges and
 * about 31 KB, as the call's metrics count them. Past the share the batch answers
 * `stopped` and Load more goes on. Tests lower it. */
export const CONNECTED_APPS: { reads: ReadCeiling } = { reads: { ...NAMED_READ } }

/** The list's name, which seals its cursors (lib/namedPages.ts namedCursor). */
export const CONNECTED_APPS_LIST = 'connectedApps.list'

/** The refusal of a cursor that is not one of this list for the same login
 * and search. */
export const NOT_APPS_CURSOR =
  'cursor must come from an earlier answer of your connected apps, with the same search; start the list again'

/** The seat's name a connected app shows once its seat is gone or no
 * longer the login's. */
export const REMOVED_MEMBER = 'Removed member'

/** The organization's name a connected app shows once its organization is
 * gone. */
export const REMOVED_ORGANIZATION = 'Removed organization'

/** One connected app as MCP access lists it, the row oauthConnections.list
 * answered, field for field, and no stored hash, requested scope or name
 * key. `appGone` marks an unrevoked connection whose OAuth client Qivo no
 * longer has, which has ended although nothing revoked it, as when an
 * operator deletes the client's rows by hand (lib/access.ts
 * oauthClientLive). */
export type ConnectedAppRow = {
  id: string
  clientId: string
  clientName: string
  profileId: string
  profileName: string
  orgId: string
  orgName: string
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  /** an organization admin revoked it on API access (apiAccess.ts) */
  revokedByAdmin: boolean
  appGone: boolean
}

/** One batch of the login's connected apps (connectedApps.list). */
export type ConnectedAppBatch = ListBatch<ConnectedAppRow>

/** The tie of a connected app position, the row's _creationTime and _id,
 * Convex's implicit last fields of by_auth_user_approved. */
type AppTie = readonly [created: number, id: string]

/* A connected app position's tie, or null for any other shape. */
function appTieOf(at: NamedAt): AppTie | null {
  const [created, id] = at.tie
  return at.tie.length === 2 && typeof created === 'number' && typeof id === 'string'
    ? [created, id]
    : null
}

/* The position of connection `row`. No range of appIndex hands out a row
 * without approved_at, so one here means the ranges are wrong. */
function approvedAt(row: Doc<'oauth_connections'>): NamedAt<AppTie> {
  if (row.approved_at === undefined)
    throw new Error('an unfinished authorization among the connected apps')
  return { key: row.approved_at, tie: [row._creationTime, row._id] }
}

/** The approved connections of login `authUserId`, newest approval first
 * (oauth_connections by_auth_user_approved read descending, above an
 * approved_at of ''), equal times newest row first. After a position it
 * reads the rest of its instant, leaving out the rows not past it
 * (lib/namedPages.ts indexAfter), the rest of its approval time, then
 * every earlier one. */
function appIndex(ctx: QueryCtx, authUserId: string): NamedIndex<Doc<'oauth_connections'>, AppTie> {
  const rows = () => ctx.db.query('oauth_connections')
  return {
    all: () =>
      rows()
        .withIndex('by_auth_user_approved', (q) =>
          q.eq('auth_user_id', authUserId).gt('approved_at', ''),
        )
        .order('desc'),
    after: ({ key, tie: [created] }) => [
      () =>
        rows()
          .withIndex('by_auth_user_approved', (q) =>
            q.eq('auth_user_id', authUserId).eq('approved_at', key).eq('_creationTime', created),
          )
          .order('desc'),
      () =>
        rows()
          .withIndex('by_auth_user_approved', (q) =>
            q.eq('auth_user_id', authUserId).eq('approved_at', key).lt('_creationTime', created),
          )
          .order('desc'),
      () =>
        rows()
          .withIndex('by_auth_user_approved', (q) =>
            q.eq('auth_user_id', authUserId).gt('approved_at', '').lt('approved_at', key),
          )
          .order('desc'),
    ],
    at: approvedAt,
  }
}

/** What `read` answers for `key`, read once a call, so a later ask for the
 * same key answers the first answer without reading again. */
async function once<V>(seen: Map<string, V>, key: string, read: () => Promise<V>): Promise<V> {
  if (seen.has(key)) return seen.get(key) as V
  const value = await read()
  seen.set(key, value)
  return value
}

/**
 * One batch of login `authUserId`'s connected apps, after `a.cursor` or
 * from the start, matching `a.search` when given (connectedApps.list).
 * Refused in the demo, and a search past LIMITS.search and a cursor of
 * another list, login or search are refused, each before any connection
 * is read.
 *
 * It reads the login's approved connections only, newest approval first,
 * and leaves out each one its owner or a profile removal deleted
 * (revocation_reason 'deleted'), which it reads and counts. A kept row
 * names its seat when the seat still exists and belongs to the login, else
 * REMOVED_MEMBER, and its organization, else REMOVED_ORGANIZATION, each id
 * looked up once a call. A search keeps the rows whose app name,
 * organization name or seat name, as the row shows them, holds every
 * whitespace-separated fragment of it, ignoring case and accents. Only
 * then does it ask the Better Auth component whether an unrevoked row's
 * client still exists, once a client a call, so at most LIST_BATCH asks a
 * batch, and it looks at the read guard again after each ask, since a
 * component's reads may not show in the call's own metrics. A revoked row
 * is never `appGone`.
 */
export async function connectedAppsOf(
  ctx: QueryCtx,
  authUserId: string,
  a: { search?: string; cursor?: string },
): Promise<ConnectedAppBatch> {
  refuseDemoFeature()
  const search = limitedText(LIMITS.search, a.search ?? '')
  const scope = [authUserId, nameKey(search)]
  let after: NamedAt<AppTie> | null = null
  if (a.cursor !== undefined) {
    const at = await openNamedCursor(a.cursor, CONNECTED_APPS_LIST, scope)
    const tie = at === null ? null : appTieOf(at)
    if (at === null || tie === null) throw badRequest(NOT_APPS_CURSOR)
    after = { key: at.key, tie }
  }
  const matches = allWordsMatcher(nameKey(search))
  const seats = new Map<string, Doc<'profiles'> | null>()
  const orgs = new Map<string, Doc<'organizations'> | null>()
  // whether Better Auth still has each client this call asked about
  const clients = new Map<string, boolean>()
  return await listBatch(
    ctx,
    { list: CONNECTED_APPS_LIST, scope, after, through: null },
    {
      stream: indexAfter(appIndex(ctx, authUserId), after, 'desc'),
      keep: async (
        row: Doc<'oauth_connections'>,
        guard: ReadGuard,
      ): Promise<ConnectedAppRow | null> => {
        // deleted from the person's list; its grant and hashes stay
        if (row.revocation_reason === 'deleted') return null
        const seat = await once(seats, row.profile_id, () =>
          guard.lookup(() => byId(ctx, 'profiles', row.profile_id)),
        )
        const org = await once(orgs, row.org_id, () =>
          guard.lookup(() => byId(ctx, 'organizations', row.org_id)),
        )
        // a seat never changes login (oauthConnections.ts ensure), so another
        // login's seat here names nothing of this login
        const profileName = (seat?.auth_user_id === authUserId && seat.name) || REMOVED_MEMBER
        const orgName = org?.name || REMOVED_ORGANIZATION
        if (
          search !== '' &&
          !matches(`${nameKey(row.client_name)}\n${nameKey(orgName)}\n${nameKey(profileName)}`)
        )
          return null
        const live =
          row.revoked_at !== undefined ||
          (await once(clients, row.client_id, async () => {
            const client = await findOAuthClient(ctx, row.client_id)
            await guard.settle()
            return client !== null
          }))
        return {
          id: row.id,
          clientId: row.client_id,
          clientName: row.client_name,
          profileId: row.profile_id,
          profileName,
          orgId: row.org_id,
          orgName,
          scopes: row.scopes,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at ?? null,
          revokedAt: row.revoked_at ?? null,
          revokedByAdmin: row.revocation_reason === 'admin',
          appGone: !live,
        }
      },
      limit: LIST_BATCH,
      ceiling: await namedCeiling(ctx, CONNECTED_APPS.reads),
      order: 'desc',
    },
  )
}

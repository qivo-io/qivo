/* API access (Settings › Organization › API access). An organization admin
 * browses every API credential in the organization with its calls in one
 * usage period, a page at a time, and can revoke any of them: members'
 * personal tokens and connected apps as well as agent keys. Every door
 * refuses in the demo.
 *
 * `summary` answers the period list and the organization's figures for one
 * period, `page` one page of credentials with the kind, state, person and
 * search filters applied on the server, and `people` the choices of the
 * person filter. They are fetched on demand, never subscribed to: every API
 * call stamps its credential's last_used_at and adds to the usage rows read
 * here, so a live subscription would re-run on each call (billing.ts reads
 * usage the same way).
 *
 * A page lists the credentials with calls in the period first, read from the
 * usage rows in rank order (billing_usage by_org_period_rank, or
 * by_org_period_profile_rank for one person), then the credentials without
 * calls, read from the three credential tables in name order (by_org_name,
 * or by_profile_name for one person) and merged (lib/namedPages.ts
 * mergeNamed). Both streams read only what follows the page's cursor, so the
 * page costs the same however long the list. The page fails closed while
 * internal/credentialKeysBackfill or internal/usageRanksBackfill has rows
 * left to key or rank in its scope (pageReady).
 *
 * Revoking takes access away only, so it runs on accessRemovalMutation and
 * an admin can still revoke while billing has paused editing. A revoked
 * credential is refused at its next request and its webhook subscriptions
 * stop at once (model/taskEvents.ts eventOwner). Each revocation narrates
 * against the credential's owner. Such rows reach no client; admins read
 * them in the organization export (lib/activityVisibility.ts). The owner sees the end in their own lists:
 * mcp_tokens.revoked_by_admin and oauth_connections.revocation_reason 'admin'. */

import { compareValues, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { credentialAccess, findOAuthClient, tokenExpired } from './lib/access'
import { openCursorText, sealCursorText } from './lib/archiveCursorSeal'
import type { ReadCeiling } from './lib/archivedTasks'
import { billingEnabled, subscriptionFor } from './lib/billingAccess'
import { clientLabel } from './lib/clientLabel'
import { byId } from './lib/db'
import { refuseDemoFeature } from './lib/demo'
import type { CredentialAccess } from './lib/enums'
import {
  accessRemovalMutation,
  badRequest,
  forbidden,
  notFound,
  orgQuery,
  require,
} from './lib/functions'
import { limitedText } from './lib/limitRules'
import { LIMITS, MIB } from './lib/limits'
import {
  indexAfter,
  mergeNamed,
  type NamedAt,
  type NamedIndex,
  type NamedReads,
  type NamedStream,
  namedCursor,
  openNamedCursor,
  type ReadGuard,
  readBatch,
  readGuard,
  STOPPED,
} from './lib/namedPages'
import { nameKey } from './lib/nameKey'
import { allWordsMatcher } from './lib/search'
import { logActivity } from './model/activity'
import { usageAllowance } from './model/billing'
import {
  billedPeriod,
  firstUsageOf,
  includedApiCalls,
  periodCalls,
  type UsageKeyRange,
  type UsagePeriod,
  usageKeyRange,
  usageKeyRanges,
  usagePeriod,
  usageRanked,
} from './model/billingUsage'
import { nameKeysReady } from './model/nameKeys'

const CREDENTIAL_TABLES = ['agent_keys', 'mcp_tokens', 'oauth_connections'] as const
export type CredentialTable = (typeof CREDENTIAL_TABLES)[number]
const vCredentialTable = v.union(...CREDENTIAL_TABLES.map((table) => v.literal(table)))

/** The most credentials one page answers, and the most people one batch of
 * the person filter answers. A page size, not a limit on what the
 * organization holds. */
export const API_ACCESS_PAGE = 25

/**
 * What one page or people batch may read, as transaction totals: at most
 * `candidates` rows that it joins, and at most half of each of Convex's
 * limits for one query (16 MiB read, 32,000 documents, 4,096 index ranges),
 * checked with the transaction's metrics before each row (lib/
 * namedPages.ts readGuard). A candidate costs up to five index ranges: its
 * usage or credential row, its owner's profile, its credential by id or the
 * usage check of a credential without calls, and the OAuth client of a
 * connected app, the last two memoized per page. 400 candidates thus read
 * at most 2,000 ranges, under half the 4,096 a query may read, and about
 * 1,600 documents of well under 2 KB each. A credential the stream of
 * credentials without calls leaves out on its own row and at most one usage
 * read, such as one already listed with its calls, is no candidate: the
 * read share alone bounds those, so an organization whose credentials all
 * have calls does not end in pages that checked 400 of them and listed
 * nothing. The byte share stops a scan over unusually large rows first.
 * Past either, the page answers what it found and a cursor, marked as
 * stopped early. Tests lower these.
 */
export const API_ACCESS_SCAN: { candidates: number; read: ReadCeiling } = {
  candidates: 400,
  read: { ranges: 2048, documents: 16_000, bytes: 8 * MIB },
}

/** One period the page can show. `current` marks the bucket calls are
 * recorded in now (usagePeriod); the others are past buckets with calls. */
export type ApiUsagePeriod = {
  key: string
  kind: UsagePeriod['kind'] | UsageKeyRange['kind']
  start: string
  end: string | null
  current: boolean
}

/** How a credential stands. `inactive` means its owner's seat is inactive,
 * so it is refused until the seat is active again; `deleted` is a credential
 * whose row is gone (or an owner-deleted connected app) that still had calls
 * in the period, or a connected app whose OAuth client Qivo no longer has,
 * which can never act again (lib/access.ts oauthClientLive). */
export type ApiCredentialState = 'active' | 'revoked' | 'expired' | 'inactive' | 'deleted'

/** One row of the page. `prefix` is the token prefix, the agent key's
 * fingerprint or the connected app's OAuth client id; a deleted credential
 * keeps only its stored name, owner and calls. `person` is the owner's name,
 * or 'Removed user' when the profile left the organization, which `removed`
 * says too. */
export type ApiCredential = {
  table: CredentialTable
  id: string
  name: string
  prefix: string | null
  profile_id: string
  person: string
  agent: boolean
  removed: boolean
  access: CredentialAccess | null
  expires_at: string | null
  last_used_at: string | null
  revoked_at: string | null
  revoked_by_admin: boolean
  state: ApiCredentialState
  calls: number
}

/** The selected period's totals. `calls` is null while the period's total
 * is not complete (model/billingUsage.ts periodCalls), never 0 in its place.
 * The current period's allowance comes from the subscription's plan, else
 * the default plan, else none (`plan: null`); a past paid period's from the
 * plan and seats it was billed with, and other past periods have none.
 * `waived` says the period's calls are not charged. */
export type ApiUsageSummary = {
  calls: number | null
  included_calls: number | null
  plan: {
    currency: string
    api_calls_per_seat: number
    api_block_size: number
    api_block_price_cents: number
  } | null
  waived: boolean
}

/** What summary answers: the periods and the figures of the one asked for,
 * or `period_unavailable` with the periods when no period has that key. */
export type ApiAccessSummary =
  | { state: 'ready'; periods: ApiUsagePeriod[]; period: string; summary: ApiUsageSummary }
  | { state: 'period_unavailable'; periods: ApiUsagePeriod[] }

/** A person the page filters by or the person filter lists. `removed` is a
 * profile that left the organization whose usage still names it, shown as
 * 'Removed user'. */
export type ApiAccessPerson = { id: string; name: string; agent: boolean; removed: boolean }

/** What page answers. `period_unavailable` for a period key the summary
 * does not list, `unknown_person` for a person who is neither in the
 * organization nor named by its usage, `not_ready` while the backfills have
 * rows left in the page's scope. Otherwise the rows; `next`, the cursor of
 * the next page, or null at the end; and `stopped`, whether the read budget
 * (API_ACCESS_SCAN) ended the page before it held API_ACCESS_PAGE rows, so
 * the rows are every match up to `next`, possibly none. */
export type ApiAccessPage =
  | { state: 'period_unavailable' }
  | { state: 'unknown_person' }
  | { state: 'not_ready' }
  | {
      state: 'ready'
      period: string
      person: ApiAccessPerson | null
      rows: ApiCredential[]
      next: string | null
      stopped: boolean
    }

/** What people answers: `not_ready` while the organization's profiles are
 * not all name keyed (model/nameKeys.ts nameKeysReady), else one batch with
 * `next` and `stopped` as on a page. */
export type ApiAccessPeople =
  | { state: 'not_ready' }
  | { state: 'ready'; rows: ApiAccessPerson[]; next: string | null; stopped: boolean }

/* The person a credential of a gone or foreign profile is listed under. */
const REMOVED_USER = 'Removed user'

/* Usage rows name their credential as `<table>:<uuid>` (machine/auth.ts
 * touchCredential, billingMetering.ts oauthCall). */
const CREDENTIAL_ID = /^(agent_keys|mcp_tokens|oauth_connections):(.+)$/
const parseCredentialId = (value: string): { table: CredentialTable; id: string } | null => {
  const match = CREDENTIAL_ID.exec(value)
  return match ? { table: match[1] as CredentialTable, id: match[2] } : null
}

/* Refuses in the demo, and anyone but an organization admin. */
function assertAdmin(me: Doc<'profiles'>): void {
  refuseDemoFeature()
  require(me.org_role === 'admin', forbidden('admin only'))
}

/* ----------------------------------------------------------- the periods */

/** Every period with usage, the current one first and the rest newest first. */
async function usagePeriods(
  ctx: QueryCtx,
  orgId: string,
  sub: Doc<'billing_subscriptions'> | null,
  now: number,
): Promise<ApiUsagePeriod[]> {
  const current = usagePeriod(sub, now)
  // A paid or pending bucket has a totals row. A calendar month keeps none
  // (model/billingUsage.ts recordApiCall), so its key comes from the usage
  // rows, one indexed read per bucket: a few a year.
  const totals = await ctx.db
    .query('billing_usage_totals')
    .withIndex('by_org_period', (q) => q.eq('org_id', orgId))
    .collect()
  const found = new Set(totals.map((row) => row.period_start))
  for (let after: string | null = null; ; ) {
    const from: string | null = after
    const next = await ctx.db
      .query('billing_usage')
      .withIndex('by_org_period', (q) =>
        from === null ? q.eq('org_id', orgId) : q.eq('org_id', orgId).gt('period_start', from),
      )
      .first()
    if (next === null) break
    found.add(next.period_start)
    after = next.period_start
  }
  const keys = [...found].filter((key) => key !== current.key)
  const past = (await usageKeyRanges(ctx, orgId, sub, keys))
    .map((range, i) => ({ key: keys[i], ...range, current: false }))
    .sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0))
  return [
    { key: current.key, kind: current.kind, start: current.start, end: current.end, current: true },
    ...past,
  ]
}

/** The period `key` of organization `orgId` as usagePeriods lists it, or
 * the current bucket when `key` is absent. Null for a key usagePeriods
 * would not list: not the current bucket, and without a totals row or a
 * usage row. Two reads and the organization's recorded periods. */
async function periodOf(
  ctx: QueryCtx,
  orgId: string,
  sub: Doc<'billing_subscriptions'> | null,
  now: number,
  key: string | undefined,
): Promise<ApiUsagePeriod | null> {
  const current = usagePeriod(sub, now)
  if (key === undefined || key === current.key)
    return {
      key: current.key,
      kind: current.kind,
      start: current.start,
      end: current.end,
      current: true,
    }
  const totals = await ctx.db
    .query('billing_usage_totals')
    .withIndex('by_org_period', (q) => q.eq('org_id', orgId).eq('period_start', key))
    .first()
  const used =
    totals ??
    (await ctx.db
      .query('billing_usage')
      .withIndex('by_org_period', (q) => q.eq('org_id', orgId).eq('period_start', key))
      .first())
  if (used === null) return null
  return { key, ...(await usageKeyRange(ctx, orgId, sub, key)), current: false }
}

/** Whether the period's calls are charged. Only a paid period's are:
 * recordApiCall never charges a month bucket, a pending interval or an open
 * one (an old free-access bucket or an interval that was never confirmed).
 * The current period follows the Billing page (model/billing.ts
 * billingUsage); a past paid period was charged when billing was on. */
function waivedPeriod(
  period: ApiUsagePeriod,
  sub: Doc<'billing_subscriptions'> | null,
  now: number,
): boolean {
  if (period.kind !== 'paid') return true
  if (!billingEnabled() || !sub?.polar_subscription_id) return true
  return period.current && !!sub.complimentary_until && Date.parse(sub.complimentary_until) > now
}

/** The allowance of a past paid period billed with `billed`, or none. */
async function pastAllowance(
  ctx: QueryCtx,
  billed: { plan_id: string; seats: number } | null,
): Promise<{ plan: Doc<'billing_plans'> | null; includedCalls: number | null }> {
  const plan = billed ? await byId(ctx, 'billing_plans', billed.plan_id) : null
  return { plan, includedCalls: plan && billed ? includedApiCalls(plan, billed.seats) : null }
}

/* P.apiAccessSummary. Admin only. An absent `period` is the current bucket,
 * and a key the period list does not hold answers `period_unavailable`,
 * never another period. The total comes from the bucket's aggregates
 * (model/billingUsage.ts periodCalls), never from summing usage rows. The
 * current period's allowance counts billable users (model/billing.ts
 * usageAllowance), which reads every profile; the Billing area bounds that
 * read. */
export const summary = orgQuery({
  args: { period: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ApiAccessSummary> => {
    assertAdmin(ctx.me)
    const orgId = ctx.me.org_id
    const now = Date.now()
    const sub = await subscriptionFor(ctx, orgId)
    const periods = await usagePeriods(ctx, orgId, sub, now)
    const period =
      args.period === undefined ? periods[0] : periods.find((p) => p.key === args.period)
    if (period === undefined) return { state: 'period_unavailable', periods }
    // The current period shows the Billing page's allowance. A past paid
    // period shows the plan and seats it was billed with, and any other past
    // period had no allowance.
    const { plan, includedCalls } = period.current
      ? await usageAllowance(ctx, orgId, sub)
      : await pastAllowance(ctx, await billedPeriod(ctx, orgId, sub, period.key))
    return {
      state: 'ready',
      periods,
      period: period.key,
      summary: {
        calls: await periodCalls(ctx, orgId, period.key),
        included_calls: includedCalls,
        plan: plan
          ? {
              currency: plan.currency,
              api_calls_per_seat: plan.api_calls_per_seat,
              api_block_size: plan.api_block_size,
              api_block_price_cents: plan.api_block_price_cents,
            }
          : null,
        waived: waivedPeriod(period, sub, now),
      },
    }
  },
})

/* ------------------------------------------------------------ readiness */

/** How many agent keys or personal tokens without an organization the
 * readiness check of an organization's page looks at in each table. Only a
 * row stored before credential keys existed lacks one, so after
 * internal/credentialKeysBackfill the rows left are those of profiles a
 * removal deleted and whose keys and tokens its background steps have not
 * deleted yet (the backfill's orphans), a handful at most. More than this
 * many means the backfill has not run, and every page answers not ready. */
const UNKEYED_LOOK = 16

/** Whether no agent key or personal token of a live profile of
 * organization `orgId` lacks its organization, so by_org_name holds every
 * row its page would list. A row without one names no organization, so the
 * check reads up to UNKEYED_LOOK of them deployment-wide and looks up each
 * owner. A row whose owner is gone, or in another organization, is one
 * this page never lists, whatever its keys: it skips a credential whose
 * owner is gone, and lists its calls from its usage rows. So another
 * organization's leftover key or token leaves this page ready, and it
 * fails closed past UNKEYED_LOOK rows or on a row of its own. */
async function credentialsKeyed(
  ctx: QueryCtx,
  table: 'agent_keys' | 'mcp_tokens',
  orgId: string,
): Promise<boolean> {
  const unkeyed = await ctx.db
    .query(table)
    .withIndex('by_org_name', (q) => q.eq('org_id', undefined))
    .take(UNKEYED_LOOK + 1)
  if (unkeyed.length > UNKEYED_LOOK) return false
  for (const row of unkeyed)
    if ((await byId(ctx, 'profiles', row.profile_id))?.org_id === orgId) return false
  return true
}

/** Whether every row a page of organization `orgId` in bucket `period`
 * reads holds the keys it is ordered by, for the whole organization or for
 * profile `person`. A row stored before the keys existed has none until
 * internal/credentialKeysBackfill or internal/usageRanksBackfill gives it
 * them, and such a row sorts first in each range, so one read of each range
 * answers, except for agent keys and personal tokens without an
 * organization, which credentialsKeyed finds deployment-wide. */
async function pageReady(
  ctx: QueryCtx,
  orgId: string,
  period: string,
  person: string | undefined,
): Promise<boolean> {
  if (person === undefined) {
    for (const table of ['agent_keys', 'mcp_tokens'] as const)
      if (!(await credentialsKeyed(ctx, table, orgId))) return false
    const app = await ctx.db
      .query('oauth_connections')
      .withIndex('by_org_name', (q) => q.eq('org_id', orgId).eq('name_key', undefined))
      .first()
    if (app !== null) return false
  } else {
    const unkeyed = [
      ctx.db
        .query('agent_keys')
        .withIndex('by_profile_name', (q) => q.eq('profile_id', person).eq('name_key', undefined))
        .first(),
      ctx.db
        .query('mcp_tokens')
        .withIndex('by_profile_name', (q) => q.eq('profile_id', person).eq('name_key', undefined))
        .first(),
      ctx.db
        .query('oauth_connections')
        .withIndex('by_profile_name', (q) => q.eq('profile_id', person).eq('name_key', undefined))
        .first(),
    ]
    for (const row of await Promise.all(unkeyed)) if (row !== null) return false
  }
  return await usageRanked(ctx, orgId, period, person)
}

/* ----------------------------------------------------------- the person */

/** Profile `id` as the page's person filter: a profile of organization
 * `orgId`, or a removed one whose usage the organization still names
 * (model/billingUsage.ts firstUsageOf), whose agent keys say whether it was
 * an agent. Null when neither. */
async function personOf(ctx: QueryCtx, orgId: string, id: string): Promise<ApiAccessPerson | null> {
  const profile = await byId(ctx, 'profiles', id)
  if (profile?.org_id === orgId)
    return { id, name: profile.name, agent: profile.kind === 'agent', removed: false }
  const used = await firstUsageOf(ctx, orgId, id)
  if (used === null) return null
  // an agent's usage names only agent keys, a person's never does
  return {
    id,
    name: REMOVED_USER,
    agent: parseCredentialId(used.credential_id)?.table === 'agent_keys',
    removed: true,
  }
}

/* ------------------------------------------------------------ the rows */

type CredentialDoc = Doc<'agent_keys'> | Doc<'mcp_tokens'> | Doc<'oauth_connections'>

/* The table a credential row belongs to, told by the field only it has. */
const tableOf = (doc: CredentialDoc): CredentialTable =>
  'key_hash' in doc ? 'agent_keys' : 'token_hash' in doc ? 'mcp_tokens' : 'oauth_connections'

/* The profiles and OAuth clients one page reads, each once, counted by the
 * guard of the read that reads it first. */
function pageJoins(ctx: QueryCtx, orgId: string) {
  const profiles = new Map<string, Promise<Doc<'profiles'> | null>>()
  const clients = new Map<string, Promise<boolean>>()
  return {
    /** The profile `id` when it belongs to the organization, else null:
     * gone, or another organization's. */
    member(id: string, guard: ReadGuard): Promise<Doc<'profiles'> | null> {
      let known = profiles.get(id)
      if (known === undefined) {
        known = guard
          .lookup(() => byId(ctx, 'profiles', id))
          .then((profile) => (profile?.org_id === orgId ? profile : null))
        profiles.set(id, known)
      }
      return known
    },
    /** Whether Better Auth still has OAuth client `clientId`. */
    clientExists(clientId: string, guard: ReadGuard): Promise<boolean> {
      let known = clients.get(clientId)
      if (known === undefined) {
        known = guard.lookup(() => findOAuthClient(ctx, clientId)).then((client) => client !== null)
        clients.set(clientId, known)
      }
      return known
    },
  }
}

type PageJoins = ReturnType<typeof pageJoins>

const stateOf = (
  row: { revoked_at?: string },
  profile: Doc<'profiles'>,
  expired = false,
): ApiCredentialState =>
  row.revoked_at !== undefined
    ? 'revoked'
    : expired
      ? 'expired'
      : profile.active
        ? 'active'
        : 'inactive'

/** The row of credential `doc` of `owner`, its owner in the organization,
 * with `calls`, as if its OAuth client exists (liveState checks that). */
function credentialRow(
  doc: CredentialDoc,
  owner: Doc<'profiles'>,
  calls: number,
  now: number,
): ApiCredential {
  const by = { profile_id: owner.id, person: owner.name, agent: owner.kind === 'agent' }
  const shared = { id: doc.id, ...by, removed: false, calls }
  if ('key_hash' in doc)
    return {
      table: 'agent_keys',
      ...shared,
      name: doc.name,
      prefix: doc.key_prefix,
      access: credentialAccess({ table: 'agent_keys' }, owner),
      expires_at: null,
      last_used_at: doc.last_used_at ?? null,
      revoked_at: doc.revoked_at ?? null,
      revoked_by_admin: false,
      state: stateOf(doc, owner),
    }
  if ('token_hash' in doc)
    return {
      table: 'mcp_tokens',
      ...shared,
      name: doc.name,
      prefix: doc.token_prefix,
      // The access it was created with; the state says if it expired.
      access: credentialAccess({ table: 'mcp_tokens', token: { access: doc.access }, now }, owner),
      expires_at: doc.expires_at ?? null,
      last_used_at: doc.last_used_at ?? null,
      revoked_at: doc.revoked_at ?? null,
      revoked_by_admin: doc.revoked_by_admin === true,
      state: stateOf(doc, owner, tokenExpired(doc, now)),
    }
  return {
    table: 'oauth_connections',
    ...shared,
    name: doc.client_name,
    prefix: doc.client_id,
    access: credentialAccess({ table: 'oauth_connections', scopes: doc.scopes }, owner),
    expires_at: null,
    last_used_at: doc.last_used_at ?? null,
    revoked_at: doc.revoked_at ?? null,
    revoked_by_admin: doc.revocation_reason === 'admin',
    // A connection its owner deleted shows only through its calls.
    state: doc.revocation_reason === 'deleted' ? 'deleted' : stateOf(doc, owner),
  }
}

/** `row` of credential `doc` with the state its OAuth client gives it: a
 * connected app that is not revoked and whose client is gone has ended too,
 * although nothing revoked it, as when an operator deletes the client's rows
 * by hand. Reads the client only for such a connection. */
async function liveState(
  row: ApiCredential,
  doc: CredentialDoc,
  joins: PageJoins,
  guard: ReadGuard,
): Promise<ApiCredential> {
  if (!('client_id' in doc) || row.state === 'deleted' || doc.revoked_at !== undefined) return row
  return (await joins.clientExists(doc.client_id, guard)) ? row : { ...row, state: 'deleted' }
}

/** The row of usage row `usage` whose credential is gone, belongs to
 * another profile than the usage row (a reused uuid), or whose owner left:
 * the name and calls the usage row stores, under its owner, or 'Removed
 * user' when `owner` is null. */
function goneRow(
  usage: Doc<'billing_usage'>,
  ref: { table: CredentialTable; id: string },
  owner: Doc<'profiles'> | null,
): ApiCredential {
  return {
    table: ref.table,
    id: ref.id,
    name: usage.credential_name,
    prefix: null,
    profile_id: usage.profile_id,
    person: owner?.name ?? REMOVED_USER,
    // agent keys belong to agents only, so a gone profile's key still says so
    agent: owner ? owner.kind === 'agent' : ref.table === 'agent_keys',
    removed: owner === null,
    access: null,
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    revoked_by_admin: false,
    state: 'deleted',
    calls: usage.calls,
  }
}

/** What a page asks for, checked: the organization, the period, the
 * filters and the search as matched (lib/search.ts allWordsMatcher over
 * lib/nameKey.ts nameKey). */
type PageAsk = {
  orgId: string
  period: ApiUsagePeriod
  kind: 'all' | CredentialTable
  state: 'all' | 'active'
  person: string | undefined
  matches: (hay: string) => boolean
  now: number
}

/* Whether `row` passes the search: its name, prefix (token prefix, agent
 * key fingerprint or OAuth client id, also as the row shows it,
 * lib/clientLabel.ts) and person, each as a name key. */
const searched = (ask: PageAsk, row: ApiCredential): boolean =>
  ask.matches(
    [
      row.name,
      row.prefix ?? '',
      row.table === 'oauth_connections' && row.prefix !== null ? clientLabel(row.prefix) : '',
      row.person,
    ]
      .map(nameKey)
      .join('\n'),
  )

const passesState = (ask: PageAsk, row: ApiCredential): boolean =>
  ask.state === 'all' || row.state === 'active'

/* ----------------------------------------------------- the usage stream */

/** A place in the usage stream, just after the usage row with these fields
 * of by_org_period_rank or by_org_period_profile_rank and these implicit
 * last fields. Calls descending, then name key and credential id, and then
 * creation time and _id, because two profiles' rows of one reused
 * credential id can share calls and name. */
type UsageAt = readonly [
  neg_calls: number,
  name_key: string,
  credential: string,
  created: number,
  id: string,
]

/* A ranked row's place. The page checked that every row of its scope is
 * ranked (pageReady), in the same transaction. */
function usageAt(row: Doc<'billing_usage'>): UsageAt {
  if (row.neg_calls === undefined || row.name_key === undefined)
    throw new Error('an unranked usage row passed the readiness check')
  return [row.neg_calls, row.name_key, row.credential_id, row._creationTime, row._id]
}

/** The index ranges, in order, that hold every usage row of the page's
 * scope past `after`, or all of them from the start. The first holds the
 * rows of `after`'s instant, which may also hold rows at or before it. */
function usageRanges(
  ctx: QueryCtx,
  ask: PageAsk,
  after: UsageAt | null,
): (() => AsyncIterable<Doc<'billing_usage'>>)[] {
  const usage = () => ctx.db.query('billing_usage')
  const { orgId } = ask
  const period = ask.period.key
  const person = ask.person
  if (person === undefined) {
    const rank = 'by_org_period_rank'
    if (after === null)
      return [
        () => usage().withIndex(rank, (q) => q.eq('org_id', orgId).eq('period_start', period)),
      ]
    const [n, key, credential, created] = after
    return [
      () =>
        usage().withIndex(rank, (q) =>
          q
            .eq('org_id', orgId)
            .eq('period_start', period)
            .eq('neg_calls', n)
            .eq('name_key', key)
            .eq('credential_id', credential)
            .eq('_creationTime', created),
        ),
      () =>
        usage().withIndex(rank, (q) =>
          q
            .eq('org_id', orgId)
            .eq('period_start', period)
            .eq('neg_calls', n)
            .eq('name_key', key)
            .eq('credential_id', credential)
            .gt('_creationTime', created),
        ),
      () =>
        usage().withIndex(rank, (q) =>
          q
            .eq('org_id', orgId)
            .eq('period_start', period)
            .eq('neg_calls', n)
            .eq('name_key', key)
            .gt('credential_id', credential),
        ),
      () =>
        usage().withIndex(rank, (q) =>
          q.eq('org_id', orgId).eq('period_start', period).eq('neg_calls', n).gt('name_key', key),
        ),
      () =>
        usage().withIndex(rank, (q) =>
          q.eq('org_id', orgId).eq('period_start', period).gt('neg_calls', n),
        ),
    ]
  }
  const rank = 'by_org_period_profile_rank'
  const of = { org: orgId, period, person }
  if (after === null)
    return [
      () =>
        usage().withIndex(rank, (q) =>
          q.eq('org_id', of.org).eq('period_start', of.period).eq('profile_id', of.person),
        ),
    ]
  // one profile holds one row per credential and bucket, so its rows' calls,
  // name and credential are unique and three ranges hold the rest
  const [n, key, credential] = after
  return [
    () =>
      usage().withIndex(rank, (q) =>
        q
          .eq('org_id', of.org)
          .eq('period_start', of.period)
          .eq('profile_id', of.person)
          .eq('neg_calls', n)
          .eq('name_key', key)
          .gt('credential_id', credential),
      ),
    () =>
      usage().withIndex(rank, (q) =>
        q
          .eq('org_id', of.org)
          .eq('period_start', of.period)
          .eq('profile_id', of.person)
          .eq('neg_calls', n)
          .gt('name_key', key),
      ),
    () =>
      usage().withIndex(rank, (q) =>
        q
          .eq('org_id', of.org)
          .eq('period_start', of.period)
          .eq('profile_id', of.person)
          .gt('neg_calls', n),
      ),
  ]
}

/** How a stream's part of a page ended: it read the stream to its end, the
 * page filled up with a row left to read, or the read budget stopped it. */
type PartEnd = 'ended' | 'full' | 'stopped'

/** What one page has read so far, shared by its two streams: the rows it
 * answers, its guard over API_ACCESS_SCAN.read, and the candidates it read. */
type PageWalk = {
  rows: ApiCredential[]
  guard: ReadGuard
  joins: PageJoins
  candidates: number
}

/**
 * The page's walk of the credentials with calls from `after`, or from the
 * start, in rank order. Each usage row joins its credential row and its
 * owner's profile by id. It is listed as deleted, with the name and calls it
 * stores, when the credential row is gone, belongs to another profile (a
 * reused uuid) or is an unfinished authorization, and under 'Removed user'
 * when its owner is gone or in another organization; an owner-deleted or
 * client-less connected app keeps its details and shows as deleted too. It
 * reads like lib/namedPages.ts readBatch: the page's first candidate whatever
 * the guard says, then rows only while the guard and API_ACCESS_SCAN allow,
 * and one row past a full page, so a page that ends with the stream says so.
 * Answers how the part ended and the position it reached.
 */
async function usagePart(
  ctx: QueryCtx,
  ask: PageAsk,
  walk: PageWalk,
  after: UsageAt | null,
): Promise<{ end: PartEnd; at: UsageAt | null }> {
  const { guard, joins } = walk
  const keep = async (usage: Doc<'billing_usage'>): Promise<ApiCredential | null> => {
    const ref = parseCredentialId(usage.credential_id)
    // not a credential id Qivo writes, or another kind than the page shows
    if (ref === null || (ask.kind !== 'all' && ref.table !== ask.kind)) return null
    const owner = await joins.member(usage.profile_id, guard)
    const doc = owner === null ? null : await guard.lookup(() => byId(ctx, ref.table, ref.id))
    // the calls belong to this row only when it is the same profile's, and
    // an approved connection rather than an unfinished authorization
    const own =
      owner !== null &&
      doc !== null &&
      doc.profile_id === usage.profile_id &&
      !('client_id' in doc && doc.approved_at === undefined)
    if (!own) {
      const gone = goneRow(usage, ref, owner)
      return passesState(ask, gone) && searched(ask, gone) ? gone : null
    }
    const row = credentialRow(doc, owner, usage.calls, ask.now)
    if (!passesState(ask, row) || !searched(ask, row)) return null
    const live = await liveState(row, doc, joins, guard)
    return passesState(ask, live) ? live : null
  }
  let at = after
  for (const range of usageRanges(ctx, ask, after)) {
    // before the page's first candidate every range opens
    if (!(await guard.range()) && walk.candidates > 0) return { end: 'stopped', at }
    for await (const usage of range()) {
      const place = usageAt(usage)
      const room = await guard.document(usage)
      // the first range holds the rest of the cursor's instant, read again
      if (after !== null && compareValues([...place], [...after]) <= 0) {
        if (!room && walk.candidates > 0) return { end: 'stopped', at }
        continue
      }
      if (walk.rows.length >= API_ACCESS_PAGE) return { end: 'full', at }
      if (walk.candidates >= API_ACCESS_SCAN.candidates) return { end: 'stopped', at }
      walk.candidates += 1
      at = place
      const row = await keep(usage)
      if (row !== null) walk.rows.push(row)
      if (guard.full) return { end: walk.rows.length < API_ACCESS_PAGE ? 'stopped' : 'full', at }
    }
  }
  return { end: 'ended', at }
}

/* ------------------------------------------------ the zero-call stream */

/** A place in the stream of credentials without calls: just after the row
 * with this name key and credential id `<table>:<uuid>`, the id usage rows
 * name it by. The three tables' rows thus have one order, name key first,
 * and equal names keep a fixed order across pages. */
type ZeroTie = readonly [credential: string]

/** The credential table `table` in name order, the organization's rows
 * (by_org_name) or one person's (by_profile_name). After a position it reads
 * the rest of its name key past its credential id, then every greater key.
 * A connected app's client_name is shared by everyone who connected that
 * app, so the first range starts after the id rather than reading the whole
 * name again. */
function credentialIndex(
  ctx: QueryCtx,
  table: CredentialTable,
  ask: PageAsk,
): NamedIndex<CredentialDoc, ZeroTie> {
  const person = ask.person
  const scoped = () =>
    person === undefined
      ? ctx.db.query(table).withIndex('by_org_name', (q) => q.eq('org_id', ask.orgId))
      : ctx.db.query(table).withIndex('by_profile_name', (q) => q.eq('profile_id', person))
  const named = (key: string, id: string | null) =>
    person === undefined
      ? ctx.db
          .query(table)
          .withIndex('by_org_name', (q) =>
            id === null
              ? q.eq('org_id', ask.orgId).eq('name_key', key)
              : q.eq('org_id', ask.orgId).eq('name_key', key).gt('id', id),
          )
      : ctx.db
          .query(table)
          .withIndex('by_profile_name', (q) =>
            id === null
              ? q.eq('profile_id', person).eq('name_key', key)
              : q.eq('profile_id', person).eq('name_key', key).gt('id', id),
          )
  const later = (key: string) =>
    person === undefined
      ? ctx.db
          .query(table)
          .withIndex('by_org_name', (q) => q.eq('org_id', ask.orgId).gt('name_key', key))
      : ctx.db
          .query(table)
          .withIndex('by_profile_name', (q) => q.eq('profile_id', person).gt('name_key', key))
  const prefix = `${table}:`
  return {
    all: scoped,
    after: ({ key, tie: [credential] }) => {
      // Rows of this table with the cursor's key are past it when their
      // `<table>:<uuid>` is: those after its uuid in its own table, all or
      // none of them in another, as the tables' names order.
      const same = credential.startsWith(prefix)
      const first = same
        ? [() => named(key, credential.slice(prefix.length))]
        : compareValues(prefix, credential) > 0
          ? [() => named(key, null)]
          : []
      return [...first, () => later(key)]
    },
    at: (doc) => {
      // the page checked that every row of its scope is keyed (pageReady)
      if (doc.name_key === undefined)
        throw new Error('an unkeyed credential passed the readiness check')
      return { key: doc.name_key, tie: [`${tableOf(doc)}:${doc.id}`] }
    },
  }
}

/** The stream `stream` ending with STOPPED in place of a row once `more`
 * answers false, as when API_ACCESS_SCAN.candidates run out; its first row
 * always passes, so a batch moves on. A batch reads one row past a full
 * one; a cut there only leaves the end unknown. */
function capped<Row>(
  stream: (reads: NamedReads) => NamedStream<Row>,
  more: () => boolean,
): (reads: NamedReads) => NamedStream<Row> {
  return (reads) =>
    (async function* () {
      let handed = 0
      for await (const item of stream(reads)) {
        if (item !== STOPPED && handed > 0 && !more()) {
          yield STOPPED
          return
        }
        if (item !== STOPPED) handed += 1
        yield item
      }
    })()
}

/** The usage row of credential `credential` of profile `profileId` in
 * bucket `period` of organization `orgId`, or null: one exact read of
 * by_subject_credential_period, whose range holds only that one row
 * (model/billingUsage.ts recordApiCall). */
const usageOf = (
  ctx: QueryCtx,
  orgId: string,
  profileId: string,
  credential: string,
  period: string,
) =>
  ctx.db
    .query('billing_usage')
    .withIndex('by_subject_credential_period', (q) =>
      q
        .eq('org_id', orgId)
        .eq('profile_id', profileId)
        .eq('credential_id', credential)
        .eq('period_start', period),
    )
    .first()

/**
 * The page's walk of the credentials without calls from `after`, or from
 * the start, in name order, over the tables `ask.kind` names, merged
 * (lib/namedPages.ts mergeNamed) and read by readBatch under the page's read
 * budget. It skips a credential whose usage row in the period names the same
 * profile (the usage stream lists it), an unfinished authorization, an
 * owner-deleted connected app, one whose owner is gone or in another
 * organization (a profile removal deletes the profile at once and its keys,
 * tokens and connections in background steps, profileRemovals.ts), and, in a
 * past period, one created after the period closed. `limit` is at least 1.
 * Answers how the part ended and where the next page starts, null at the
 * end of the stream.
 *
 * Every credential with calls is in the credential tables too, so a row
 * there does not mean a row of this stream follows. A page that filled up
 * as the usage stream ended therefore probes (`probe`): it looks for one
 * credential this stream lists, answers none, and starts the next page just
 * before the one it found, past the rows it skipped, or ends the list when
 * it found none.
 */
async function zeroPart(
  ctx: QueryCtx,
  ask: PageAsk,
  walk: PageWalk,
  after: NamedAt<ZeroTie> | null,
  limit: number,
  probe = false,
): Promise<{ end: PartEnd; next: PagePlace | null }> {
  const { joins } = walk
  const tables = ask.kind === 'all' ? CREDENTIAL_TABLES : [ask.kind]
  const indexes = tables.map((table) => credentialIndex(ctx, table, ask))
  // A past period stopped collecting calls at its end, the day after a
  // calendar month's last day. A credential created after that, with no
  // calls in it, did not exist then and is left out.
  const period = ask.period
  const closed =
    period.end === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(period.end) + (period.kind === 'month' ? 24 * 60 * 60_000 : 0)
  const place = (at: NamedAt): PagePlace => ({
    part: 'zero',
    at: { key: at.key, tie: [String(at.tie[0])] },
  })
  // the last row the walk left out, the place just before the next it keeps
  let skipped: NamedAt | null = after
  const keep = async (doc: CredentialDoc, guard: ReadGuard): Promise<ApiCredential | null> => {
    const row = await listed(doc, guard)
    if (row === null) skipped = { key: doc.name_key ?? '', tie: [`${tableOf(doc)}:${doc.id}`] }
    return row
  }
  const listed = async (doc: CredentialDoc, guard: ReadGuard): Promise<ApiCredential | null> => {
    // left out on the row and one usage read, which the read guard bounds
    if (
      'client_id' in doc &&
      (doc.approved_at === undefined || doc.revocation_reason === 'deleted')
    )
      return null
    const created = 'client_id' in doc ? (doc.approved_at ?? doc.created_at) : doc.created_at
    if (Date.parse(created) >= closed) return null
    const id = `${tableOf(doc)}:${doc.id}`
    if (
      (await guard.lookup(() => usageOf(ctx, ask.orgId, doc.profile_id, id, period.key))) !== null
    )
      return null
    // a candidate: what follows joins the credential's owner and client
    walk.candidates += 1
    const owner = await joins.member(doc.profile_id, guard)
    if (owner === null) return null
    const row = credentialRow(doc, owner, 0, ask.now)
    if (!passesState(ask, row) || !searched(ask, row)) return null
    const live = await liveState(row, doc, joins, guard)
    return passesState(ask, live) ? live : null
  }
  const batch = await readBatch(ctx, {
    stream: capped(
      (reads) => mergeNamed(indexes.map((index) => indexAfter(index, after)(reads))),
      () => walk.candidates < API_ACCESS_SCAN.candidates,
    ),
    keep,
    limit: probe ? 1 : limit,
    through: null,
    ceiling: API_ACCESS_SCAN.read,
    after,
  })
  if (probe) {
    if (batch.rows.length > 0)
      return { end: 'full', next: skipped === null ? START_ZERO : place(skipped) }
    return { end: 'full', next: batch.ended ? null : place(batch.at) }
  }
  walk.rows.push(...batch.rows)
  if (batch.ended) return { end: 'ended', next: null }
  return { end: batch.stopped ? 'stopped' : 'full', next: place(batch.at) }
}

/* ------------------------------------------------------------ the cursor */

/* The list a page cursor names and the version of the text it seals. */
const PAGE_LIST = 'apiAccess.page'
const PAGE_CURSOR_VERSION = 1

/* The most a position takes as JSON: a name key of a few KB (a name of
 * NAME_MAX units can take 2,640 bytes as a key), a credential id, a time and
 * an _id, as lib/namedPages.ts counts its own. */
const POSITION_BYTES = 8 * 1024

/* The tag GCM-SIV adds to a sealed text (lib/archiveCursorSeal.ts). */
const TAG_BYTES = 16

/** Where a page starts: in the usage stream after a position or from its
 * start, or in the stream of credentials without calls after a position or
 * from its start. */
type PagePlace =
  | { part: 'usage'; at: UsageAt | null }
  | { part: 'zero'; at: NamedAt<ZeroTie> | null }

/** The refusal of a cursor that is not one this page gave for the same
 * organization, period, filters and search. */
const NOT_PAGE_CURSOR =
  'cursor must come from an earlier page of API access with the same period, filters and search; start again from the first page'

/** `place` as a page cursor for scope `scope`: a versioned JSON array of
 * the list, the scope, the stream and the position, sealed
 * (lib/archiveCursorSeal.ts), so it shows nothing and opens only for that
 * scope (openPageCursor). */
async function pageCursor(scope: readonly string[], place: PagePlace): Promise<string> {
  const at =
    place.at === null ? null : place.part === 'usage' ? place.at : [place.at.key, ...place.at.tie]
  return await sealCursorText(
    JSON.stringify([PAGE_CURSOR_VERSION, PAGE_LIST, scope, place.part, at]),
  )
}

/** The place `text` names, or null when it is not a cursor pageCursor
 * wrote for `scope`: it does not open, names another list or scope, holds
 * another shape, or is longer than any such cursor can be, a bound that
 * grows with the scope. */
async function openPageCursor(text: string, scope: readonly string[]): Promise<PagePlace | null> {
  // UTF-8 takes at most three bytes a UTF-16 unit, and hex two characters a byte
  const most =
    2 *
    (3 * JSON.stringify([PAGE_CURSOR_VERSION, PAGE_LIST, scope, 'usage']).length +
      POSITION_BYTES +
      TAG_BYTES)
  if (text.length > most) return null
  const opened = await openCursorText(text)
  if (opened === null) return null
  let sealed: unknown
  try {
    sealed = JSON.parse(opened)
  } catch {
    return null
  }
  if (!Array.isArray(sealed) || sealed.length !== 5) return null
  const [version, list, from, part, at] = sealed as unknown[]
  if (version !== PAGE_CURSOR_VERSION || list !== PAGE_LIST) return null
  if (JSON.stringify(from) !== JSON.stringify(scope)) return null
  if (part === 'usage') {
    if (at === null) return { part, at: null }
    if (!Array.isArray(at) || at.length !== 5) return null
    const [n, key, credential, created, id] = at as unknown[]
    if (
      typeof n !== 'number' ||
      typeof key !== 'string' ||
      typeof credential !== 'string' ||
      typeof created !== 'number' ||
      typeof id !== 'string'
    )
      return null
    return { part, at: [n, key, credential, created, id] }
  }
  if (part !== 'zero') return null
  if (at === null) return { part, at: null }
  if (!Array.isArray(at) || at.length !== 2) return null
  const [key, credential] = at as unknown[]
  if (typeof key !== 'string' || typeof credential !== 'string') return null
  return { part, at: { key, tie: [credential] } }
}

/* -------------------------------------------------------------- the page */

const vKind = v.union(v.literal('all'), ...CREDENTIAL_TABLES.map((table) => v.literal(table)))
const vState = v.union(v.literal('all'), v.literal('active'))

/**
 * P.apiAccessPage. Admin only. One page of at most API_ACCESS_PAGE
 * credentials of the organization in period `period` (the current bucket
 * when absent): the credentials with calls in the period by calls
 * descending, then by name key and credential id (`<table>:<uuid>`), then
 * the credentials without calls by name key and credential id. `kind` keeps
 * one table, `state` 'active' only working credentials, `person` one
 * profile's credentials, and `search` those whose name, prefix (token
 * prefix, agent key fingerprint, or OAuth client id in full and as the row
 * shows it) or person holds every whitespace-separated fragment of it,
 * ignoring case and accents
 * (lib/search.ts allWordsMatcher over lib/nameKey.ts nameKey). `cursor` is
 * an earlier page's `next`, for the same period, filters and search.
 *
 * `person` resolves directly and comes back with the page: a profile of the
 * organization, or 'Removed user' when the organization's usage still names
 * it. A page with no rows still names that person. A period the summary
 * does not list answers `period_unavailable`, and a person who is neither
 * `unknown_person`, never another period or everyone. While a backfill has
 * rows left to key or rank in the page's scope it answers `not_ready`
 * (pageReady), never a partial or misordered page.
 *
 * Calls change while an admin browses, so a credential whose calls change
 * between two pages can move across the cursor and be missed or shown twice
 * until the list starts again from the first page. Nothing freezes a
 * snapshot. A page reads at most API_ACCESS_SCAN; past it, the page answers
 * the rows it found with `stopped` and a `next` that goes on from there.
 * Refuses a search longer than LIMITS.search and a cursor of another scope.
 */
export const page = orgQuery({
  args: {
    period: v.optional(v.string()),
    kind: vKind,
    state: vState,
    person: v.optional(v.string()),
    search: v.optional(v.string()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<ApiAccessPage> => {
    assertAdmin(ctx.me)
    const orgId = ctx.me.org_id
    const search = limitedText(LIMITS.search, a.search ?? '')
    const now = Date.now()
    const sub = await subscriptionFor(ctx, orgId)
    const period = await periodOf(ctx, orgId, sub, now, a.period)
    if (period === null) return { state: 'period_unavailable' }
    const person = a.person === undefined ? null : await personOf(ctx, orgId, a.person)
    if (a.person !== undefined && person === null) return { state: 'unknown_person' }
    const scope = [orgId, period.key, a.kind, a.state, a.person ?? '', nameKey(search)]
    const from: PagePlace | null =
      a.cursor === undefined ? START_USAGE : await openPageCursor(a.cursor, scope)
    if (from === null) throw badRequest(NOT_PAGE_CURSOR)
    if (!(await pageReady(ctx, orgId, period.key, a.person))) return { state: 'not_ready' }
    const ask: PageAsk = {
      orgId,
      period,
      kind: a.kind,
      state: a.state,
      person: a.person,
      matches: allWordsMatcher(nameKey(search)),
      now,
    }
    const walk: PageWalk = {
      rows: [],
      guard: readGuard(ctx, API_ACCESS_SCAN.read),
      joins: pageJoins(ctx, orgId),
      candidates: 0,
    }
    const answer = async (end: PartEnd, place: PagePlace | null): Promise<ApiAccessPage> => ({
      state: 'ready',
      period: period.key,
      person,
      rows: walk.rows,
      next: place === null ? null : await pageCursor(scope, place),
      stopped: end === 'stopped',
    })
    if (from.part === 'usage') {
      const usage = await usagePart(ctx, ask, walk, from.at)
      if (usage.end !== 'ended') return await answer(usage.end, { part: 'usage', at: usage.at })
      if (walk.rows.length >= API_ACCESS_PAGE) {
        const probed = await zeroPart(ctx, ask, walk, null, 1, true)
        return await answer('full', probed.next)
      }
      if (walk.guard.full || walk.candidates >= API_ACCESS_SCAN.candidates)
        return await answer('stopped', START_ZERO)
    }
    const zero = await zeroPart(
      ctx,
      ask,
      walk,
      from.part === 'zero' ? from.at : null,
      API_ACCESS_PAGE - walk.rows.length,
    )
    return await answer(zero.end, zero.next)
  },
})

/* Where a page's two streams start. */
const START_USAGE: PagePlace = { part: 'usage', at: null }
const START_ZERO: PagePlace = { part: 'zero', at: null }

/* ------------------------------------------------------------ the people */

/* The list a people cursor names (lib/namedPages.ts namedCursor). */
const PEOPLE_LIST = 'apiAccess.people'

/** The people and agents of organization `orgId` in name order
 * (profiles.by_org_name): name key, then id. */
function profileIndex(
  ctx: QueryCtx,
  orgId: string,
): NamedIndex<Doc<'profiles'>, readonly [string]> {
  const profiles = () => ctx.db.query('profiles')
  return {
    all: () => profiles().withIndex('by_org_name', (q) => q.eq('org_id', orgId)),
    after: ({ key, tie: [id] }) => [
      () =>
        profiles().withIndex('by_org_name', (q) =>
          q.eq('org_id', orgId).eq('name_key', key).gt('id', id),
        ),
      () => profiles().withIndex('by_org_name', (q) => q.eq('org_id', orgId).gt('name_key', key)),
    ],
    at: (profile) => {
      // people refuses until every profile is keyed (nameKeysReady)
      if (profile.name_key === undefined)
        throw new Error('an unkeyed profile passed the readiness check')
      return { key: profile.name_key, tie: [profile.id] }
    },
  }
}

/* P.apiAccessPeople. Admin only. One batch of at most API_ACCESS_PAGE of
 * the organization's people and agents for the person filter, in name order,
 * inactive seats included, since their credentials still exist. `search`
 * keeps those whose name holds every whitespace-separated fragment of it,
 * ignoring case and accents, and `cursor` is an earlier batch's `next` for
 * the same search. Removed accounts are not listed; Billing's View
 * credentials reaches them by id (page `person`). Answers `not_ready` until
 * every profile holds its name key (model/nameKeys.ts nameKeysReady). Reads
 * at most API_ACCESS_SCAN, as a page does. Refuses a search longer than
 * LIMITS.search and a cursor of another search. */
export const people = orgQuery({
  args: { search: v.optional(v.string()), cursor: v.optional(v.string()) },
  handler: async (ctx, a): Promise<ApiAccessPeople> => {
    assertAdmin(ctx.me)
    const orgId = ctx.me.org_id
    const search = limitedText(LIMITS.search, a.search ?? '')
    const scope = [orgId, nameKey(search)]
    let after: NamedAt<readonly [string]> | null = null
    if (a.cursor !== undefined) {
      const at = await openNamedCursor(a.cursor, PEOPLE_LIST, scope)
      const id = at?.tie[0]
      if (at === null || at.tie.length !== 1 || typeof id !== 'string')
        throw badRequest(
          'cursor must come from an earlier answer of the person filter, with the same search',
        )
      after = { key: at.key, tie: [id] }
    }
    if (!(await nameKeysReady(ctx, orgId))) return { state: 'not_ready' }
    const matches = allWordsMatcher(nameKey(search))
    // the profiles the batch has looked at, each a candidate
    let seen = 0
    const batch = await readBatch(ctx, {
      stream: capped(
        indexAfter(profileIndex(ctx, orgId), after),
        () => seen < API_ACCESS_SCAN.candidates,
      ),
      keep: async (profile: Doc<'profiles'>) => {
        seen += 1
        return matches(nameKey(profile.name))
          ? { id: profile.id, name: profile.name, agent: profile.kind === 'agent', removed: false }
          : null
      },
      limit: API_ACCESS_PAGE,
      through: null,
      ceiling: API_ACCESS_SCAN.read,
      after,
    })
    return {
      state: 'ready',
      rows: batch.rows,
      next: batch.ended ? null : await namedCursor(PEOPLE_LIST, scope, batch.at),
      stopped: batch.stopped,
    }
  },
})

/* ------------------------------------------------------------ the revoke */

/* P.revokeApiCredential. Admin only. A credential whose owner is in another
 * organization answers exactly like one that does not exist, and so does an
 * unfinished OAuth authorization. Revoking an already revoked credential
 * changes nothing and returns false. */
export const revoke = accessRemovalMutation({
  args: { table: vCredentialTable, id: v.string() },
  handler: async (ctx, { table, id }) => {
    refuseDemoFeature()
    require(ctx.me.org_role === 'admin', forbidden('admin only'))
    const row = await byId(ctx, table, id)
    const profile = row ? await byId(ctx, 'profiles', row.profile_id) : null
    if (!row || !profile || profile.org_id !== ctx.me.org_id) throw notFound('credential not found')
    // an OAuth row without approval is an unfinished authorization, not a credential
    if ('client_id' in row && !row.approved_at) throw notFound('credential not found')
    if (row.revoked_at !== undefined) return false
    const now = new Date().toISOString()
    let detail: string
    if ('key_hash' in row) {
      // as tokens.revokeAgentKey
      await ctx.db.patch(row._id, { revoked_at: now })
      detail = `the key “${row.name}”`
    } else if ('token_hash' in row) {
      await ctx.db.patch(row._id, { revoked_at: now, revoked_by_admin: true })
      detail = `a personal token “${row.name}”`
    } else {
      await ctx.db.patch(row._id, { revoked_at: now, revocation_reason: 'admin' })
      detail = `the connection to “${row.client_name}”`
    }
    // Narrated against the owner; only admins read it, in the export
    // (lib/activityVisibility.ts).
    await logActivity(ctx, {
      org_id: profile.org_id,
      actor_id: ctx.me.id,
      verb: 'revoked',
      target_type: 'user',
      target_id: profile.id,
      label: profile.name,
      detail,
      ts: now,
    })
    return true
  },
})

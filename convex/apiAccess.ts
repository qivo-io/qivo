/* API access (Settings › Organization › API access). An organization admin
 * lists every API credential in the organization with its calls in one usage
 * period, and can revoke any of them: members' personal tokens and connected
 * apps as well as agent keys. Both doors refuse in the demo.
 *
 * The list is fetched on demand, never subscribed to: every API call stamps
 * its credential's last_used_at and adds to the usage rows read here, so a
 * live subscription would re-run on each call (billing.ts reads usage the
 * same way).
 *
 * Revoking takes access away only, so it runs on accessRemovalMutation and
 * an admin can still revoke while billing has paused editing. A revoked
 * credential is refused at its next request and its webhook subscriptions
 * stop at once (model/taskEvents.ts eventOwner). Each revocation narrates
 * against the credential's owner, and lib/activityVisibility.ts keeps those
 * rows for admins. The owner sees the end in their own lists:
 * mcp_tokens.revoked_by_admin and oauth_connections.revocation_reason 'admin'. */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { credentialAccess, tokenExpired } from './lib/access'
import { billingEnabled, subscriptionFor } from './lib/billingAccess'
import { byId } from './lib/db'
import { refuseDemoFeature } from './lib/demo'
import type { CredentialAccess } from './lib/enums'
import { accessRemovalMutation, forbidden, notFound, orgQuery, require } from './lib/functions'
import { logActivity } from './model/activity'
import { usageAllowance } from './model/billing'
import {
  billedPeriod,
  includedApiCalls,
  type UsageKeyRange,
  type UsagePeriod,
  usageKeyRanges,
  usagePeriod,
} from './model/billingUsage'

const CREDENTIAL_TABLES = ['agent_keys', 'mcp_tokens', 'oauth_connections'] as const
export type CredentialTable = (typeof CREDENTIAL_TABLES)[number]
const vCredentialTable = v.union(...CREDENTIAL_TABLES.map((table) => v.literal(table)))

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
 * in the period. */
export type ApiCredentialState = 'active' | 'revoked' | 'expired' | 'inactive' | 'deleted'

/** One row of the page. `prefix` is the token prefix, the agent key's
 * fingerprint or the connected app's OAuth client id; a deleted credential
 * keeps only its stored name, owner and calls. `person` is the owner's name,
 * or 'Removed user' when the profile left the organization. */
export type ApiCredential = {
  table: CredentialTable
  id: string
  name: string
  prefix: string | null
  profile_id: string
  person: string
  agent: boolean
  access: CredentialAccess | null
  expires_at: string | null
  last_used_at: string | null
  revoked_at: string | null
  revoked_by_admin: boolean
  state: ApiCredentialState
  calls: number
}

/** The selected period's totals. The current period's allowance comes from
 * the subscription's plan, else the default plan, else none (`plan: null`); a
 * past paid period's from the plan and seats it was billed with, and other
 * past periods have none. `waived` says the period's calls are not charged. */
export type ApiUsageSummary = {
  calls: number
  included_calls: number | null
  plan: {
    currency: string
    api_calls_per_seat: number
    api_block_size: number
    api_block_price_cents: number
  } | null
  waived: boolean
}

/* Usage rows name their credential as `<table>:<uuid>` (machine/auth.ts
 * touchCredential, billingMetering.ts oauthCall). */
const CREDENTIAL_ID = /^(agent_keys|mcp_tokens|oauth_connections):(.+)$/
const parseCredentialId = (value: string): { table: CredentialTable; id: string } | null => {
  const match = CREDENTIAL_ID.exec(value)
  return match ? { table: match[1] as CredentialTable, id: match[2] } : null
}

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

/* P.listApiAccess. Admin only. `period` is a key from `periods`; an unknown
 * or missing key shows the current period, and `period` in the result names
 * the one shown. */
export const list = orgQuery({
  args: { period: v.optional(v.string()) },
  handler: async (ctx, args) => {
    refuseDemoFeature()
    require(ctx.me.org_role === 'admin', forbidden('admin only'))
    const orgId = ctx.me.org_id
    const now = Date.now()
    const sub = await subscriptionFor(ctx, orgId)
    const periods = await usagePeriods(ctx, orgId, sub, now)
    const period = periods.find((p) => p.key === args.period) ?? periods[0]

    // One row per credential with calls in the period.
    const usageRows = await ctx.db
      .query('billing_usage')
      .withIndex('by_org_period', (q) => q.eq('org_id', orgId).eq('period_start', period.key))
      .collect()
    const usage = new Map<string, { calls: number; name: string; profile_id: string }>()
    for (const row of usageRows) {
      const seen = usage.get(row.credential_id)
      if (seen) seen.calls += row.calls
      else
        usage.set(row.credential_id, {
          calls: row.calls,
          name: row.credential_name,
          profile_id: row.profile_id,
        })
    }
    const callsOf = (table: CredentialTable, id: string) => usage.get(`${table}:${id}`)?.calls ?? 0

    // Every seat, inactive ones included: their credentials still exist and
    // work again if the seat is reactivated.
    const profiles = await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    // A past period stopped collecting calls at its end, the day after a
    // calendar month's last day. A credential created after that, with no
    // calls in it, did not exist then and is left out.
    const closed =
      period.end === null
        ? Number.POSITIVE_INFINITY
        : Date.parse(period.end) + (period.kind === 'month' ? 24 * 60 * 60_000 : 0)
    const credentials: ApiCredential[] = []
    const listed = new Set<string>()
    const add = (row: ApiCredential, createdAt: string) => {
      if (row.calls === 0 && Date.parse(createdAt) >= closed) return
      credentials.push(row)
      listed.add(`${row.table}:${row.id}`)
    }
    const owner = (profile: Doc<'profiles'>) => ({
      profile_id: profile.id,
      person: profile.name,
      agent: profile.kind === 'agent',
    })
    for (const profile of profiles) {
      if (profile.kind === 'agent') {
        const keys = await ctx.db
          .query('agent_keys')
          .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
          .collect()
        for (const key of keys)
          add(
            {
              table: 'agent_keys',
              id: key.id,
              name: key.name,
              prefix: key.key_prefix,
              ...owner(profile),
              access: credentialAccess({ table: 'agent_keys' }, profile),
              expires_at: null,
              last_used_at: key.last_used_at ?? null,
              revoked_at: key.revoked_at ?? null,
              revoked_by_admin: false,
              state: stateOf(key, profile),
              calls: callsOf('agent_keys', key.id),
            },
            key.created_at,
          )
        continue
      }
      const tokens = await ctx.db
        .query('mcp_tokens')
        .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
        .collect()
      for (const token of tokens)
        add(
          {
            table: 'mcp_tokens',
            id: token.id,
            name: token.name,
            prefix: token.token_prefix,
            ...owner(profile),
            // The access it was created with; the state says if it expired.
            access: credentialAccess(
              { table: 'mcp_tokens', token: { access: token.access }, now },
              profile,
            ),
            expires_at: token.expires_at ?? null,
            last_used_at: token.last_used_at ?? null,
            revoked_at: token.revoked_at ?? null,
            revoked_by_admin: token.revoked_by_admin === true,
            state: stateOf(token, profile, tokenExpired(token, now)),
            calls: callsOf('mcp_tokens', token.id),
          },
          token.created_at,
        )
      // There is no index on approval, so this also reads the person's
      // unfinished authorizations (each consent attempt leaves a row) and
      // skips them.
      const connections = await ctx.db
        .query('oauth_connections')
        .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
        .collect()
      for (const connection of connections) {
        if (!connection.approved_at) continue
        // A connection its owner deleted shows only through its calls.
        const deleted = connection.revocation_reason === 'deleted'
        const calls = callsOf('oauth_connections', connection.id)
        if (deleted && calls === 0) continue
        add(
          {
            table: 'oauth_connections',
            id: connection.id,
            name: connection.client_name,
            prefix: connection.client_id,
            ...owner(profile),
            access: credentialAccess(
              { table: 'oauth_connections', scopes: connection.scopes },
              profile,
            ),
            expires_at: null,
            last_used_at: connection.last_used_at ?? null,
            revoked_at: connection.revoked_at ?? null,
            revoked_by_admin: connection.revocation_reason === 'admin',
            state: deleted ? 'deleted' : stateOf(connection, profile),
            calls,
          },
          connection.approved_at,
        )
      }
    }

    // Calls of credentials whose rows are gone: deleted tokens and keys, and
    // everything of a profile that left the organization.
    const byProfile = new Map(profiles.map((profile) => [profile.id, profile]))
    for (const [credentialId, use] of usage) {
      const ref = parseCredentialId(credentialId)
      if (!ref || listed.has(credentialId)) continue
      const profile = byProfile.get(use.profile_id)
      credentials.push({
        table: ref.table,
        id: ref.id,
        name: use.name,
        prefix: null,
        profile_id: use.profile_id,
        person: profile?.name ?? 'Removed user',
        // agent keys belong to agents only, so a gone profile's key still says so
        agent: profile ? profile.kind === 'agent' : ref.table === 'agent_keys',
        access: null,
        expires_at: null,
        last_used_at: null,
        revoked_at: null,
        revoked_by_admin: false,
        state: 'deleted',
        calls: use.calls,
      })
    }
    credentials.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))

    // The current period shows the Billing page's allowance. A past paid
    // period shows the plan and seats it was billed with, and any other past
    // period had no allowance.
    const { plan, includedCalls } = period.current
      ? await usageAllowance(ctx, orgId, sub)
      : await pastAllowance(ctx, await billedPeriod(ctx, orgId, sub, period.key))
    const summary: ApiUsageSummary = {
      calls: usageRows.reduce((total, row) => total + row.calls, 0),
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
    }
    return { periods, period: period.key, summary, credentials }
  },
})

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
    // Narrated against the owner; only admins receive it
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

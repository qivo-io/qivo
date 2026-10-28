/* API access (apiAccess.ts): an organization admin browses every credential
 * of the organization with its calls in one usage period, a page at a time,
 * and revokes any of them. Usage rows and credentials are planted at a fixed
 * clock inside a live paid period, beside an earlier paid period, a
 * calendar-month bucket and an old free-access bucket, keyed and ranked as
 * their writers store them (tokens.ts, model/billingUsage.ts
 * writeUsageRow). */

import type { FunctionArgs } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { API_ACCESS_SCAN, type ApiAccessPage, type ApiCredential } from '../apiAccess'
import { byId } from '../lib/db'
import { LIMITS, MIB } from '../lib/limits'
import { named, nameKey } from '../lib/nameKey'
import type { EventOwner } from '../lib/taskEvents'
import { sha256hex } from '../machine/auth'
import { writeUsageRow } from '../model/billingUsage'
import { notifyIssueUpdate } from '../model/messages'
import {
  activityFor,
  as,
  expectRefusal,
  flushWebhookEvents,
  newT,
  type OrgFixture,
  plantIssue,
  plantSeat,
  runInAuth,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }

const PERIOD = '2026-09-15T12:00:00.000Z'
const END = '2026-10-15T12:00:00.000Z'
const NOW = '2026-09-20T12:00:00.000Z'
const PAST = '2026-08-15T12:00:00.000Z'
const MONTH = 'month:2026-07'
const FREE = '2026-03-02T08:00:00.000Z'
const CREATED = '2026-06-01T00:00:00.000Z'
/* The calendar month NOW falls in, the current bucket without a paid period. */
const SEPTEMBER = 'month:2026-09'

/* A REST read mints nothing, but the auth config reads this secret lazily,
 * and page cursors are sealed with it. */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
g.process ??= { env: {} }
g.process.env.BETTER_AUTH_SECRET ??= 'test-files-secret'

const DEFAULT_SCAN = { candidates: API_ACCESS_SCAN.candidates, read: { ...API_ACCESS_SCAN.read } }

beforeEach(() => {
  vi.stubEnv('BILLING_ENABLED', 'true')
  vi.stubEnv('APP_MODE', '')
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(NOW))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  API_ACCESS_SCAN.candidates = DEFAULT_SCAN.candidates
  Object.assign(API_ACCESS_SCAN.read, DEFAULT_SCAN.read)
})

const secret = (prefix: string) => `${prefix}${uuid().replace(/-/g, '')}${'0'.repeat(16)}`

/* A personal token of `profile`, keyed as tokens.ts createMcpToken stores it. */
const plantToken = async (
  ctx: MutationCtx,
  id: string,
  profile: Doc<'profiles'>,
  name: string,
  row: Partial<Doc<'mcp_tokens'>> = {},
) =>
  ctx.db.insert('mcp_tokens', {
    id,
    profile_id: profile.id,
    org_id: profile.org_id,
    ...named(name),
    token_prefix: `qvt_${id.slice(0, 7)}`,
    token_hash: await sha256hex(id),
    access: 'write',
    created_at: CREATED,
    ...row,
  })

/* An approved connected app of `profile`, keyed as oauthConnections.ts stores it. */
const plantConnection = (
  ctx: MutationCtx,
  id: string,
  profile: Doc<'profiles'>,
  client_name: string,
  row: Partial<Doc<'oauth_connections'>> = {},
) =>
  ctx.db.insert('oauth_connections', {
    id,
    authorization_hash: `hash-${id}`,
    auth_user_id: profile.auth_user_id ?? '',
    profile_id: profile.id,
    org_id: profile.org_id,
    client_id: `client-${client_name.toLowerCase()}`,
    client_name,
    name_key: nameKey(client_name),
    resource: 'https://qivo.test/mcp',
    requested_scopes: ['qivo:read', 'qivo:write'],
    scopes: ['qivo:read', 'qivo:write'],
    created_at: CREATED,
    authorization_expires_at: CREATED,
    approved_at: CREATED,
    ...row,
  })

/* `calls` calls of credential `credential_id` (`<table>:<uuid>`) of profile
 * `profile_id` in bucket `period_start`, ranked as a call ranks its row. */
const plantUsage = (
  ctx: MutationCtx,
  o: {
    org_id: string
    profile_id: string
    credential_id: string
    name: string
    calls: number
    period_start: string
  },
) =>
  writeUsageRow(
    ctx,
    null,
    {
      org_id: o.org_id,
      profile_id: o.profile_id,
      credential_id: o.credential_id,
      period_start: o.period_start,
    },
    o.calls,
    o.name,
  )

/* withOrg with an active paid subscription, one credential of every kind and
 * state, and usage in four periods. */
async function fixture(t: T) {
  const f = await withOrg(t)
  const elin = await plantSeat(t, {
    org_id: f.org.id,
    name: 'Elin Sand',
    auth_user_id: `auth_elin_${f.org.id}`,
    active: false,
  })
  const secrets = { cursor: secret('qvt_'), relay: secret('qva_') }
  const ids = {
    relay: uuid(),
    cursor: uuid(),
    old: uuid(),
    hook: uuid(),
    raycast: uuid(),
    claude: uuid(),
    pending: uuid(),
    unplugged: uuid(),
    forgotten: uuid(),
    gone: uuid(),
    departed: uuid(),
    foreign: uuid(),
  }
  const removedProfile = uuid()
  const sub = await t.run(async (ctx) => {
    const plan = uuid()
    await ctx.db.insert('billing_plans', {
      id: plan,
      name: 'Team',
      currency: 'usd',
      seat_price_cents: 100,
      minimum_seats: 5,
      storage_gb_per_seat: 1,
      minimum_storage_gb: 5,
      api_calls_per_seat: 25_000,
      api_block_size: 25_000,
      api_block_price_cents: 100,
      storage_block_price_cents: 100,
      archived: false,
      created_at: CREATED,
    })
    const _id = await ctx.db.insert('billing_subscriptions', {
      id: uuid(),
      org_id: f.org.id,
      plan_id: plan,
      status: 'active',
      polar_subscription_id: 'provider-sub',
      current_period_start: PERIOD,
      current_period_end: END,
      billed_seats: 7,
      next_seats: 7,
      cancel_at_period_end: false,
      created_at: CREATED,
      updated_at: CREATED,
    })
    await ctx.db.insert('billing_periods', {
      org_id: f.org.id,
      subscription_id: 'provider-sub',
      plan_id: plan,
      period_start: PAST,
      period_end: PERIOD,
      seats: 7,
      profile_ids: [],
      storage_bytes: 0,
      storage_blocks: 0,
      created_at: PAST,
    })
    await ctx.db.insert('agent_keys', {
      id: ids.relay,
      profile_id: f.agent.id,
      org_id: f.org.id,
      ...named('GitHub Actions'),
      key_prefix: 'qva_2...22222',
      key_hash: await sha256hex(secrets.relay),
      created_at: CREATED,
      last_used_at: '2026-09-20T11:38:00.000Z',
    })
    await plantToken(ctx, ids.cursor, f.user, 'Cursor', {
      token_hash: await sha256hex(secrets.cursor),
      last_used_at: '2026-09-20T11:48:00.000Z',
    })
    await plantToken(ctx, ids.old, f.user, 'Cursor, old', {
      revoked_at: '2026-09-16T09:00:00.000Z',
    })
    // created on the last day of the July bucket, and after the last paid period
    await plantToken(ctx, ids.hook, f.viewer, 'Old CI hook', {
      expires_at: '2026-09-09T00:00:00.000Z',
      created_at: '2026-07-31T10:00:00.000Z',
    })
    await plantToken(ctx, ids.raycast, elin, 'Raycast', {
      access: 'read',
      created_at: '2026-09-17T00:00:00.000Z',
    })
    await plantConnection(ctx, ids.claude, f.admin, 'Claude', {
      last_used_at: '2026-09-20T11:56:00.000Z',
    })
    await plantConnection(ctx, ids.pending, f.admin, 'Pending', {
      approved_at: undefined,
      scopes: [],
    })
    const deleted = { revoked_at: '2026-09-18T00:00:00.000Z', revocation_reason: 'deleted' }
    await plantConnection(ctx, ids.unplugged, f.guest, 'ChatGPT', {
      ...deleted,
      scopes: ['qivo:read'],
    })
    await plantConnection(ctx, ids.forgotten, f.guest, 'Forgotten', deleted)
    // another organization's token, invisible here
    await plantToken(ctx, ids.foreign, f.otherAdmin, 'Elsewhere')

    const usage =
      (profile_id: string, credential_id: string, name: string, calls: number) =>
      (period_start: string, org_id = f.org.id) =>
        plantUsage(ctx, { org_id, profile_id, credential_id, name, calls, period_start })
    for (const plant of [
      usage(f.user.id, `mcp_tokens:${ids.cursor}`, 'Cursor', 18),
      usage(f.admin.id, `oauth_connections:${ids.claude}`, 'Claude', 9),
      usage(f.agent.id, `agent_keys:${ids.relay}`, 'GitHub Actions', 5),
      usage(f.user.id, `mcp_tokens:${ids.old}`, 'Cursor, old', 2),
      usage(f.guest.id, `oauth_connections:${ids.unplugged}`, 'ChatGPT', 4),
      // a token its owner deleted, and a key of a member who left
      usage(f.user.id, `mcp_tokens:${ids.gone}`, 'Zapier', 3),
      usage(removedProfile, `agent_keys:${ids.departed}`, 'Night job', 7),
    ])
      await plant(PERIOD)
    await usage(
      f.otherAdmin.id,
      `mcp_tokens:${ids.foreign}`,
      'Elsewhere',
      50,
    )(PERIOD, f.otherOrg.id)
    await usage(f.user.id, `mcp_tokens:${ids.cursor}`, 'Cursor', 30)(PAST)
    await usage(f.agent.id, `agent_keys:${ids.relay}`, 'GitHub Actions', 11)(MONTH)
    await usage(f.user.id, `mcp_tokens:${ids.gone}`, 'Zapier', 2)(FREE)
    // a calendar month keeps its total in its shards, which the usage above
    // counted; the other buckets in one totals row each
    for (const [period_start, calls] of [
      [PERIOD, 48],
      [PAST, 30],
      [FREE, 2],
    ] as const)
      await ctx.db.insert('billing_usage_totals', {
        org_id: f.org.id,
        period_start,
        calls,
        reported_api_blocks: 0,
      })
    await ctx.db.insert('billing_usage_totals', {
      org_id: f.otherOrg.id,
      period_start: '2025-01-01T00:00:00.000Z',
      calls: 50,
      reported_api_blocks: 0,
    })
    const sub = await ctx.db.get(_id)
    if (!sub) throw new Error('fixture subscription vanished')
    return sub
  })
  // Better Auth has every connected app's client
  await runInAuth(t, async (ctx) => {
    for (const name of ['claude', 'pending', 'chatgpt', 'forgotten'])
      await ctx.db.insert('oauthClient', { clientId: `client-${name}`, redirectUris: [] })
  })
  return { ...f, elin, ids, secrets, removedProfile, sub }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
type Table = 'agent_keys' | 'mcp_tokens' | 'oauth_connections'
type Admin = Pick<OrgFixture, 'admin' | 'org'>
type PageArgs = Partial<Omit<FunctionArgs<typeof api.apiAccess.page>, 'org_id'>>

const summary = (t: T, f: Admin, period?: string) =>
  as(t, f.admin).query(api.apiAccess.summary, { org_id: f.org.id, period })
const page = (t: T, f: Admin, args: PageArgs = {}) =>
  as(t, f.admin).query(api.apiAccess.page, {
    org_id: f.org.id,
    kind: 'all',
    state: 'all',
    ...args,
  })
const people = (t: T, f: Admin, args: { search?: string; cursor?: string } = {}) =>
  as(t, f.admin).query(api.apiAccess.people, { org_id: f.org.id, ...args })
const revoke = (t: T, caller: Doc<'profiles'>, org_id: string, table: Table, id: string) =>
  as(t, caller).mutation(api.apiAccess.revoke, { org_id, table, id })

type ReadyPage = Extract<ApiAccessPage, { state: 'ready' }>

/* The page `answer` resolves to, which must be ready. */
async function ready(answer: Promise<ApiAccessPage>): Promise<ReadyPage> {
  const shown = await answer
  if (shown.state !== 'ready') throw new Error(`the page answered ${shown.state}`)
  return shown
}

/* Every page from the first, following `next` to the end. */
async function walk(t: T, f: Admin, args: PageArgs = {}): Promise<ReadyPage[]> {
  const pages: ReadyPage[] = []
  let cursor: string | undefined
  for (let i = 0; i < 1000; i++) {
    const shown = await ready(page(t, f, { ...args, cursor }))
    pages.push(shown)
    if (shown.next === null) return pages
    cursor = shown.next
  }
  throw new Error('the pages never ended')
}

/* Every row of every page, in order. */
const everyRow = async (t: T, f: Admin, args: PageArgs = {}) =>
  (await walk(t, f, args)).flatMap((shown) => shown.rows)

/* [name, state, calls] per listed row, in the page's order. */
const rows = (listed: readonly ApiCredential[]) =>
  listed.map((row) => [row.name, row.state, row.calls])

/* The names of every row the pages list with `args`. */
const names = async (t: T, f: Admin, args: PageArgs = {}) =>
  (await everyRow(t, f, args)).map((row) => row.name)

/* The fixture's current period as the old whole-list query answered it, in
 * its order: calls descending, then name. */
const WHOLE_LIST = [
  ['Cursor', 'active', 18],
  ['Claude', 'active', 9],
  ['Night job', 'deleted', 7],
  ['GitHub Actions', 'active', 5],
  ['ChatGPT', 'deleted', 4],
  ['Zapier', 'deleted', 3],
  ['Cursor, old', 'revoked', 2],
  ['Old CI hook', 'expired', 0],
  ['Raycast', 'inactive', 0],
]

describe('apiAccess.summary', () => {
  it('lists the current period first and every earlier one newest first, with each total from its aggregates', async () => {
    const t = newT()
    const f = await fixture(t)
    const current = await summary(t, f)
    if (current.state !== 'ready') throw new Error('the summary answered no period')
    expect(current.periods).toEqual([
      { key: PERIOD, kind: 'paid', start: PERIOD, end: END, current: true },
      { key: PAST, kind: 'paid', start: PAST, end: PERIOD, current: false },
      {
        key: MONTH,
        kind: 'month',
        start: '2026-07-01T00:00:00.000Z',
        end: '2026-07-31T00:00:00.000Z',
        current: false,
      },
      { key: FREE, kind: 'open', start: FREE, end: null, current: false },
    ])
    expect(current.period).toBe(PERIOD)
    expect(current.summary).toEqual({
      calls: 48,
      included_calls: 175_000,
      plan: {
        currency: 'usd',
        api_calls_per_seat: 25_000,
        api_block_size: 25_000,
        api_block_price_cents: 100,
      },
      waived: false,
    })
    // each total equals the sum of its period's usage rows
    const sums = await t.run(async (ctx) => {
      const sum: Record<string, number> = {}
      for (const row of await ctx.db.query('billing_usage').collect())
        if (row.org_id === f.org.id)
          sum[row.period_start] = (sum[row.period_start] ?? 0) + row.calls
      return sum
    })
    for (const key of [PERIOD, PAST, MONTH, FREE]) {
      const shown = await summary(t, f, key)
      expect(shown).toMatchObject({
        state: 'ready',
        period: key,
        summary: { calls: sums[key] },
      })
    }
    expect(await summary(t, f, MONTH)).toMatchObject({ summary: { calls: 11, waived: true } })
    expect(await summary(t, f, FREE)).toMatchObject({ summary: { calls: 2, waived: true } })
  })

  it('answers an unknown period as unavailable with the periods, never another period', async () => {
    const t = newT()
    const f = await fixture(t)
    const shown = await summary(t, f, 'month:1999-01')
    expect(shown.state).toBe('period_unavailable')
    expect(shown.periods.map((p) => p.key)).toEqual([PERIOD, PAST, MONTH, FREE])
    expect(await page(t, f, { period: 'month:1999-01' })).toEqual({ state: 'period_unavailable' })
  })

  it('shows a past paid period with the seats it was billed with, no allowance for other past periods, and a pending interval as not charged', async () => {
    const t = newT()
    const f = await fixture(t)
    // renewal raised the seats from 7 to 10 (25,000 calls each)
    await t.run((ctx) => ctx.db.patch(f.sub._id, { billed_seats: 10, next_seats: 10 }))
    expect(await summary(t, f)).toMatchObject({ summary: { included_calls: 250_000 } })
    expect(await summary(t, f, PAST)).toMatchObject({
      summary: { included_calls: 175_000, waived: false },
    })
    expect(await summary(t, f, MONTH)).toMatchObject({
      summary: { included_calls: null, plan: null },
    })
    expect(await summary(t, f, FREE)).toMatchObject({
      summary: { included_calls: null, plan: null },
    })

    // Renewal confirmation is late, so calls go to a pending interval, which
    // is never charged. The period before it keeps its subscription's seats.
    vi.mocked(Date.now).mockReturnValue(Date.parse(END) + 60_000)
    const pending = await summary(t, f)
    expect(pending.periods[0]).toMatchObject({ key: END, kind: 'pending', current: true })
    expect(pending).toMatchObject({ summary: { calls: 0, waived: true } })
    expect(await summary(t, f, PERIOD)).toMatchObject({
      summary: { included_calls: 250_000, waived: false },
    })
  })

  it('counts a month bucket without a paid period, and shows only the count without a plan', async () => {
    const t = newT()
    const f = await fixture(t)
    await t.run((ctx) => ctx.db.delete(f.sub._id))
    const shown = await summary(t, f)
    expect(shown.periods[0]).toEqual({
      key: SEPTEMBER,
      kind: 'month',
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-09-30T00:00:00.000Z',
      current: true,
    })
    expect(shown).toMatchObject({
      summary: { calls: 0, included_calls: null, plan: null, waived: true },
    })
    // the paid period it no longer has is still listed as a past period
    expect(shown.periods.map((p) => p.key)).toContain(PERIOD)
  })

  it('answers a month total as unavailable, never 0, while one of its rows is unranked', async () => {
    const t = newT()
    const f = await fixture(t)
    // a row stored before ranks existed, which internal/usageRanksBackfill ranks
    await t.run((ctx) =>
      ctx.db.insert('billing_usage', {
        org_id: f.org.id,
        profile_id: f.user.id,
        credential_id: `mcp_tokens:${f.ids.cursor}`,
        credential_name: 'Cursor',
        period_start: MONTH,
        calls: 4,
      }),
    )
    expect(await summary(t, f, MONTH)).toMatchObject({ state: 'ready', summary: { calls: null } })
    expect(await page(t, f, { period: MONTH })).toEqual({ state: 'not_ready' })
    // a paid period counts in its totals row, which needs no ranks
    expect(await summary(t, f)).toMatchObject({ summary: { calls: 48 } })
  })
})

describe('apiAccess.page', () => {
  it('lists every credential kind with its owner, access, state and calls in the current period', async () => {
    const t = newT()
    const f = await fixture(t)
    const shown = await ready(page(t, f))
    expect(shown.period).toBe(PERIOD)
    expect(shown.person).toBeNull()
    expect(shown.next).toBeNull()
    expect(shown.stopped).toBe(false)
    // the same rows, in the same order, as the old whole-list query
    expect(rows(shown.rows)).toEqual(WHOLE_LIST)
    const row = (name: string) => shown.rows.find((r) => r.name === name)
    expect(row('Cursor')).toEqual({
      table: 'mcp_tokens',
      id: f.ids.cursor,
      name: 'Cursor',
      prefix: `qvt_${f.ids.cursor.slice(0, 7)}`,
      profile_id: f.user.id,
      person: 'user',
      agent: false,
      removed: false,
      access: 'write',
      expires_at: null,
      last_used_at: '2026-09-20T11:48:00.000Z',
      revoked_at: null,
      revoked_by_admin: false,
      state: 'active',
      calls: 18,
    })
    expect(row('Claude')).toMatchObject({
      table: 'oauth_connections',
      prefix: 'client-claude',
      person: 'admin',
      access: 'write',
    })
    expect(row('GitHub Actions')).toMatchObject({
      table: 'agent_keys',
      prefix: 'qva_2...22222',
      person: 'Relay',
      agent: true,
      access: 'write',
    })
    // an expired token keeps the access it was created with
    expect(row('Old CI hook')).toMatchObject({
      access: 'write',
      expires_at: '2026-09-09T00:00:00.000Z',
    })
    expect(row('Raycast')).toMatchObject({ person: 'Elin Sand', access: 'read', removed: false })
    // the owner deleted it, but its calls in the period still count
    expect(row('ChatGPT')).toMatchObject({ prefix: 'client-chatgpt', access: 'read' })
    // a deleted token keeps its owner; a departed agent's key is "Removed
    // user", still an agent's
    expect(row('Zapier')).toMatchObject({
      table: 'mcp_tokens',
      id: f.ids.gone,
      prefix: null,
      person: 'user',
      agent: false,
      removed: false,
      access: null,
    })
    expect(row('Night job')).toMatchObject({
      table: 'agent_keys',
      profile_id: f.removedProfile,
      person: 'Removed user',
      agent: true,
      removed: true,
    })
    // unfinished authorizations, connections deleted without calls and other
    // organizations' credentials never show
    for (const name of ['Pending', 'Forgotten', 'Elsewhere']) expect(row(name)).toBeUndefined()
  })

  it('switches periods, leaving out what had no calls then and what did not exist yet', async () => {
    const t = newT()
    const f = await fixture(t)
    const past = await ready(page(t, f, { period: PAST }))
    expect(past.period).toBe(PAST)
    expect(rows(past.rows).slice(0, 2)).toEqual([
      ['Cursor', 'active', 30],
      ['Claude', 'active', 0],
    ])
    // the owner-deleted connection had no calls then, and a token created
    // after the period ended did not exist yet
    for (const name of ['ChatGPT', 'Raycast', 'Zapier', 'Night job'])
      expect(past.rows.map((r) => r.name)).not.toContain(name)

    const month = await ready(page(t, f, { period: MONTH }))
    expect(rows(month.rows)[0]).toEqual(['GitHub Actions', 'active', 11])
    // a month runs to the end of its last day
    expect(month.rows.map((r) => r.name)).toContain('Old CI hook')
    expect(month.rows.map((r) => r.name)).not.toContain('Raycast')

    const free = await ready(page(t, f, { period: FREE }))
    expect(rows(free.rows)[0]).toEqual(['Zapier', 'deleted', 2])
  })

  /* An operator who deletes a client's rows by hand runs no trigger, so its
     grants keep no revocation, but they can never act again. */
  it('shows a connected app whose OAuth client is gone as ended, to the admin and its owner', async () => {
    const t = newT()
    const f = await fixture(t)
    const claude = async () => ({
      state: (await ready(page(t, f))).rows.find((r) => r.name === 'Claude')?.state,
      owner: (await as(t, f.admin).query(api.oauthConnections.list, {})).find(
        (row) => row.id === f.ids.claude,
      ),
    })
    expect(await claude()).toMatchObject({
      state: 'active',
      owner: { revokedAt: null, appGone: false },
    })
    await runInAuth(t, async (ctx) => {
      const client = await ctx.db
        .query('oauthClient')
        .withIndex('clientId', (q) => q.eq('clientId', 'client-claude'))
        .unique()
      if (client) await ctx.db.delete(client._id)
    })
    expect(await claude()).toMatchObject({
      state: 'deleted',
      owner: { revokedAt: null, revokedByAdmin: false, appGone: true },
    })
    // a revocation still says who ended it
    await revoke(t, f.admin, f.org.id, 'oauth_connections', f.ids.claude)
    expect(await claude()).toMatchObject({
      state: 'revoked',
      owner: { revokedByAdmin: true, appGone: false },
    })
  })

  it('ends a connected app without calls whose client is gone, and keeps a revoked one revoked', async () => {
    const t = newT()
    const f = await fixture(t)
    const notion = uuid()
    const linear = uuid()
    await t.run(async (ctx) => {
      // no oauthClient rows for either
      await plantConnection(ctx, notion, f.user, 'Notion')
      await plantConnection(ctx, linear, f.user, 'Linear', {
        revoked_at: '2026-09-19T00:00:00.000Z',
        revocation_reason: 'admin',
      })
      await plantUsage(ctx, {
        org_id: f.org.id,
        profile_id: f.user.id,
        credential_id: `oauth_connections:${linear}`,
        name: 'Linear',
        calls: 6,
        period_start: PERIOD,
      })
    })
    const listed = await everyRow(t, f)
    expect(listed.find((r) => r.id === notion)).toMatchObject({ state: 'deleted', calls: 0 })
    expect(listed.find((r) => r.id === linear)).toMatchObject({
      state: 'revoked',
      revoked_by_admin: true,
      calls: 6,
    })
    // and without calls, in a period it has none
    expect((await everyRow(t, f, { period: PAST })).find((r) => r.id === linear)).toMatchObject({
      state: 'revoked',
      calls: 0,
    })
  })

  it('orders by calls descending, then name key, then credential id, with credentials without calls after', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ids = Array.from({ length: 6 }, () => uuid()).sort()
    await t.run(async (ctx) => {
      // equal names in two tables and three people, equal calls with
      // different names, and an accented name that sorts by its key
      await plantToken(ctx, ids[3], f.user, 'Sync')
      await plantToken(ctx, ids[1], f.viewer, 'Sync')
      await plantConnection(ctx, ids[0], f.admin, 'Sync')
      await plantToken(ctx, ids[2], f.user, 'Älpha')
      await plantToken(ctx, ids[4], f.user, 'Beta')
      await plantToken(ctx, ids[5], f.viewer, 'alpha')
      for (const [id, name, table, profile] of [
        [ids[4], 'Beta', 'mcp_tokens', f.user.id],
        [ids[2], 'Älpha', 'mcp_tokens', f.user.id],
      ] as const)
        await plantUsage(ctx, {
          org_id: f.org.id,
          profile_id: profile,
          credential_id: `${table}:${id}`,
          name,
          calls: 3,
          period_start: SEPTEMBER,
        })
    })
    await runInAuth(t, (ctx) =>
      ctx.db.insert('oauthClient', { clientId: 'client-sync', redirectUris: [] }),
    )
    const listed = await everyRow(t, f)
    expect(listed.map((r) => [r.name, r.table, r.id, r.calls])).toEqual([
      ['Älpha', 'mcp_tokens', ids[2], 3],
      ['Beta', 'mcp_tokens', ids[4], 3],
      ['alpha', 'mcp_tokens', ids[5], 0],
      ['Sync', 'mcp_tokens', ids[1], 0],
      ['Sync', 'mcp_tokens', ids[3], 0],
      ['Sync', 'oauth_connections', ids[0], 0],
    ])
  })

  it('pages 60 credentials as 25, 25 and 10, each exactly once, across both streams', async () => {
    const t = newT()
    const f = await withOrg(t)
    const made: string[] = []
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) {
        const id = uuid()
        made.push(id)
        const owner = [f.user, f.viewer, f.admin][i % 3]
        const name = `Token ${String(i % 7).padStart(2, '0')}`
        await plantToken(ctx, id, owner, name)
        // half of them have calls, some of them equal
        if (i % 2 === 0)
          await plantUsage(ctx, {
            org_id: f.org.id,
            profile_id: owner.id,
            credential_id: `mcp_tokens:${id}`,
            name,
            calls: 1 + (i % 5),
            period_start: SEPTEMBER,
          })
      }
    })
    const pages = await walk(t, f)
    expect(pages.map((shown) => shown.rows.length)).toEqual([25, 25, 10])
    expect(pages.map((shown) => shown.stopped)).toEqual([false, false, false])
    expect(pages[2].next).toBeNull()
    const listed = pages.flatMap((shown) => shown.rows)
    expect(listed.map((r) => r.id).sort()).toEqual([...made].sort())
    // calls descending, then name key, then id; those without calls last
    const order = (r: ApiCredential) => [-r.calls, nameKey(r.name), `${r.table}:${r.id}`]
    const sorted = [...listed].sort((a, b) => {
      const [x, y] = [order(a), order(b)]
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
      return 0
    })
    expect(listed.map((r) => r.id)).toEqual(sorted.map((r) => r.id))
  })

  it('ends a page that fills up as the credentials with calls end, unless one without calls follows', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      for (let i = 0; i < 25; i++) {
        const id = uuid()
        await plantToken(ctx, id, f.user, `Called ${i}`)
        await plantUsage(ctx, {
          org_id: f.org.id,
          profile_id: f.user.id,
          credential_id: `mcp_tokens:${id}`,
          name: `Called ${i}`,
          calls: 1,
          period_start: SEPTEMBER,
        })
      }
    })
    const full = await ready(page(t, f))
    expect([full.rows.length, full.next]).toEqual([25, null])
    await t.run((ctx) => plantToken(ctx, uuid(), f.viewer, 'Quiet'))
    const first = await ready(page(t, f))
    expect(first.rows.length).toBe(25)
    if (first.next === null) throw new Error('a credential without calls follows')
    expect(rows((await ready(page(t, f, { cursor: first.next }))).rows)).toEqual([
      ['Quiet', 'active', 0],
    ])
  })

  it('filters by kind, state, person and search on the server across every page', async () => {
    const t = newT()
    const f = await fixture(t)
    const cafe = uuid()
    await t.run((ctx) => plantToken(ctx, cafe, f.viewer, 'Café sync'))
    expect(await names(t, f, { kind: 'agent_keys' })).toEqual(['Night job', 'GitHub Actions'])
    expect(await names(t, f, { kind: 'oauth_connections' })).toEqual(['Claude', 'ChatGPT'])
    expect(await names(t, f, { state: 'active' })).toEqual([
      'Cursor',
      'Claude',
      'GitHub Actions',
      'Café sync',
    ])
    expect(await names(t, f, { person: f.user.id })).toEqual(['Cursor', 'Zapier', 'Cursor, old'])
    // the name, the token prefix, the client id, the person's name, and an
    // accented name found without its accent and in another case
    expect(await names(t, f, { search: 'cursor' })).toEqual(['Cursor', 'Cursor, old'])
    expect(await names(t, f, { search: `qvt_${f.ids.cursor.slice(0, 7)}` })).toEqual(['Cursor'])
    expect(await names(t, f, { search: 'qva_2...' })).toEqual(['GitHub Actions'])
    expect(await names(t, f, { search: 'client-claude' })).toEqual(['Claude'])
    expect(await names(t, f, { search: 'sand' })).toEqual(['Raycast'])
    expect(await names(t, f, { search: 'removed' })).toEqual(['Night job'])
    expect(await names(t, f, { search: 'CAFE' })).toEqual(['Café sync'])
    expect(await names(t, f, { search: '  café   SYNC ' })).toEqual(['Café sync'])
    // every fragment must match, in any order
    expect(await names(t, f, { search: 'old cursor' })).toEqual(['Cursor, old'])
    expect(await names(t, f, { search: 'nothing like it' })).toEqual([])
    // filters combine
    expect(
      await names(t, f, {
        kind: 'mcp_tokens',
        state: 'active',
        person: f.viewer.id,
        search: 'caf',
      }),
    ).toEqual(['Café sync'])
  })

  it('finds a connected app by the client id its row shows, as well as by the full id', async () => {
    const t = newT()
    const f = await fixture(t)
    await t.run((ctx) =>
      plantConnection(ctx, uuid(), f.viewer, 'Linear', { client_id: '4f1c2b7d9e0a1c3fa90e' }),
    )
    await runInAuth(t, (ctx) =>
      ctx.db.insert('oauthClient', { clientId: '4f1c2b7d9e0a1c3fa90e', redirectUris: [] }),
    )
    // the row shows "client 4f1c…a90e" (lib/clientLabel.ts)
    for (const search of ['4f1c…a90e', 'client 4f1c', '4f1c2b7d9e0a', 'a90e'])
      expect(await names(t, f, { search })).toEqual(['Linear'])
    // "client" names every connected app the page lists
    expect(await names(t, f, { search: 'client' })).toEqual(['Claude', 'ChatGPT', 'Linear'])
  })

  it('resolves the person directly: a member, a removed account named by usage, or unknown', async () => {
    const t = newT()
    const f = await fixture(t)
    const user = await ready(page(t, f, { person: f.user.id }))
    expect(user.person).toEqual({ id: f.user.id, name: 'user', agent: false, removed: false })
    const removed = await ready(page(t, f, { person: f.removedProfile }))
    expect(removed.person).toEqual({
      id: f.removedProfile,
      name: 'Removed user',
      agent: true,
      removed: true,
    })
    expect(rows(removed.rows)).toEqual([['Night job', 'deleted', 7]])
    // a person with no credentials in the period keeps the filter, with no
    // rows: the guest's apps are owner-deleted and had calls only later
    const quiet = await ready(page(t, f, { person: f.guest.id, period: PAST }))
    expect(quiet).toMatchObject({
      person: { id: f.guest.id, name: 'guest', agent: false, removed: false },
      rows: [],
      next: null,
      stopped: false,
    })
    // never everyone instead
    expect(await page(t, f, { person: uuid() })).toEqual({ state: 'unknown_person' })
    expect(await page(t, f, { person: f.otherAdmin.id })).toEqual({ state: 'unknown_person' })
  })

  it('lists a deleted credential’s calls and the new credential that took its uuid apart', async () => {
    const t = newT()
    const f = await fixture(t)
    // the viewer's new token reuses the uuid of the user's deleted Zapier token
    await t.run((ctx) => plantToken(ctx, f.ids.gone, f.viewer, 'Zapier again'))
    const listed = await everyRow(t, f)
    const reused = listed.filter((r) => r.id === f.ids.gone)
    expect(reused.map((r) => [r.name, r.person, r.state, r.calls])).toEqual([
      ['Zapier', 'user', 'deleted', 3],
      ['Zapier again', 'viewer', 'active', 0],
    ])
    expect(await names(t, f, { person: f.viewer.id })).toEqual(['Old CI hook', 'Zapier again'])
  })

  it('skips the keys and tokens a removal left behind, and lists those with calls as deleted under Removed user', async () => {
    const t = newT()
    const f = await fixture(t)
    const dana = await plantSeat(t, { org_id: f.org.id, name: 'Dana' })
    const [busy, idle] = [uuid(), uuid()]
    await t.run(async (ctx) => {
      await plantToken(ctx, busy, dana, 'Dana busy')
      await plantToken(ctx, idle, dana, 'Dana idle')
      await plantUsage(ctx, {
        org_id: f.org.id,
        profile_id: dana.id,
        credential_id: `mcp_tokens:${busy}`,
        name: 'Dana busy',
        calls: 4,
        period_start: PERIOD,
      })
      // removeProfile deletes the profile at once and its tokens later
      await ctx.db.delete(dana._id)
    })
    const listed = await everyRow(t, f)
    expect(listed.find((r) => r.id === busy)).toMatchObject({
      name: 'Dana busy',
      person: 'Removed user',
      removed: true,
      state: 'deleted',
      prefix: null,
      calls: 4,
    })
    expect(listed.find((r) => r.id === idle)).toBeUndefined()
    expect(await names(t, f, { person: dana.id })).toEqual(['Dana busy'])
  })

  it('refuses a cursor from another organization, period, filter or search, and a long search', async () => {
    const t = newT()
    const f = await fixture(t)
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++) await plantToken(ctx, uuid(), f.user, `Token ${i}`)
      for (let i = 0; i < 30; i++) await plantToken(ctx, uuid(), f.otherAdmin, `Token ${i}`)
    })
    const first = await ready(page(t, f))
    const cursor = first.next
    if (cursor === null) throw new Error('the first page is not the last')
    const refused = /^cursor must come from an earlier page of API access/
    for (const args of [
      { period: PAST },
      { kind: 'mcp_tokens' },
      { state: 'active' },
      { person: f.user.id },
      { search: 'token' },
    ] as const)
      await expectRefusal(page(t, f, { ...args, cursor }), 'bad_request', refused)
    await expectRefusal(page(t, f, { cursor: 'abcd'.repeat(40) }), 'bad_request', refused)
    // the other organization's admin cannot use it either
    const other = { admin: f.otherAdmin, org: f.otherOrg }
    await expectRefusal(page(t, other, { cursor }), 'bad_request', refused)
    // an absent period is the current one, so its cursor still opens
    expect((await ready(page(t, f, { period: PERIOD, cursor }))).rows.length).toBeGreaterThan(0)
    // two searches with one name key share their cursors
    const cafe = await ready(page(t, f, { search: 'TOKEN' }))
    if (cafe.next === null) throw new Error('the search has a second page')
    expect((await ready(page(t, f, { search: 'token', cursor: cafe.next }))).rows.length).toBe(5)
    await expectRefusal(
      page(t, f, { search: 'x'.repeat(LIMITS.search.max + 1) }),
      'rule',
      /Search for fewer words\.$/,
    )
  })

  it('answers not ready while a credential or usage row of its scope is missing its keys', async () => {
    const t = newT()
    const f = await fixture(t)
    expect((await page(t, f)).state).toBe('ready')
    // an agent key stored before credential keys
    const unkeyed = await t.run((ctx) =>
      ctx.db.insert('agent_keys', {
        id: uuid(),
        profile_id: f.agent.id,
        name: 'Old key',
        key_prefix: 'qva_3...33333',
        key_hash: 'ab'.repeat(32),
        created_at: CREATED,
      }),
    )
    expect(await page(t, f)).toEqual({ state: 'not_ready' })
    // another organization's page never lists it
    const other = { admin: f.otherAdmin, org: f.otherOrg }
    expect((await page(t, other)).state).toBe('ready')
    // one person's page checks only that person's rows
    expect((await page(t, f, { person: f.user.id })).state).toBe('ready')
    expect(await page(t, f, { person: f.agent.id })).toEqual({ state: 'not_ready' })
    await t.run((ctx) => ctx.db.patch(unkeyed, { org_id: f.org.id, ...named('Old key') }))
    expect((await page(t, f)).state).toBe('ready')

    // a connected app stored before its name key
    const app = await t.run((ctx) =>
      plantConnection(ctx, uuid(), f.user, 'Raw', { name_key: undefined }),
    )
    expect(await page(t, f)).toEqual({ state: 'not_ready' })
    expect(await page(t, f, { person: f.user.id })).toEqual({ state: 'not_ready' })
    expect((await page(t, other)).state).toBe('ready')
    await t.run((ctx) => ctx.db.patch(app, { name_key: 'raw' }))

    // a usage row stored before ranks, in the bucket the page reads
    await t.run((ctx) =>
      ctx.db.insert('billing_usage', {
        org_id: f.org.id,
        profile_id: f.user.id,
        credential_id: `mcp_tokens:${f.ids.cursor}`,
        credential_name: 'Cursor',
        period_start: FREE,
        calls: 1,
      }),
    )
    expect(await page(t, f, { period: FREE })).toEqual({ state: 'not_ready' })
    expect(await page(t, f, { period: FREE, person: f.user.id })).toEqual({ state: 'not_ready' })
    expect((await page(t, f, { period: FREE, person: f.agent.id })).state).toBe('ready')
    expect((await page(t, f)).state).toBe('ready')
  })

  it('stays ready beside another organization’s or a removed profile’s unkeyed key, and fails closed past UNKEYED_LOOK', async () => {
    const t = newT()
    const f = await fixture(t)
    const other = { admin: f.otherAdmin, org: f.otherOrg }
    const unkeyed = (profile_id: string, n: number) =>
      t.run((ctx) =>
        ctx.db.insert('mcp_tokens', {
          id: uuid(),
          profile_id,
          name: `Old token ${n}`,
          token_prefix: 'qvt_0000000',
          token_hash: `${String(n).padStart(2, '0')}`.repeat(32),
          access: 'read',
          created_at: CREATED,
        }),
      )
    // a token of the other organization's admin, stored before credential keys
    await unkeyed(f.otherAdmin.id, 0)
    expect((await page(t, f)).state).toBe('ready')
    expect(await page(t, other)).toEqual({ state: 'not_ready' })
    // a removal's leftover, whose profile is gone: no page lists it
    const gone = uuid()
    await unkeyed(gone, 1)
    expect((await page(t, f)).state).toBe('ready')
    // more leftovers than the check looks at: it cannot tell, so not ready
    for (let n = 2; n <= 16; n++) await unkeyed(gone, n)
    expect(await page(t, f)).toEqual({ state: 'not_ready' })
    // one person's page reads that person's rows alone, keyed or not
    expect((await page(t, f, { person: f.user.id })).state).toBe('ready')
  })

  // The demo refusal is in demo.test.ts, which signs in a real demo login.
  it('refuses members who are not admins and other organizations', async () => {
    const t = newT()
    const f = await fixture(t)
    for (const member of [f.user, f.viewer, f.guest]) {
      for (const call of [
        as(t, member).query(api.apiAccess.summary, { org_id: f.org.id }),
        as(t, member).query(api.apiAccess.page, { org_id: f.org.id, kind: 'all', state: 'all' }),
        as(t, member).query(api.apiAccess.people, { org_id: f.org.id }),
      ])
        await expectRefusal(call, 'forbidden', /^admin only$/)
    }
    await expectRefusal(
      as(t, f.otherAdmin).query(api.apiAccess.page, {
        org_id: f.org.id,
        kind: 'all',
        state: 'all',
      }),
      'forbidden',
    )
  })
})

describe('API access across organizations', () => {
  /* The other organization's usage: a token's 50 calls in PERIOD, which
     this organization also has, and a paid bucket of its own. */
  const ELSEWHERE = '2025-01-01T00:00:00.000Z'

  it('refuses another organization’s admin on summary and people, as on page', async () => {
    const t = newT()
    const f = await fixture(t)
    for (const call of [
      as(t, f.otherAdmin).query(api.apiAccess.summary, { org_id: f.org.id }),
      as(t, f.otherAdmin).query(api.apiAccess.people, { org_id: f.org.id }),
      as(t, f.otherAdmin).query(api.apiAccess.page, {
        org_id: f.org.id,
        kind: 'all',
        state: 'all',
      }),
    ])
      await expectRefusal(call, 'forbidden')
  })

  it('answers another organization’s period key as unavailable, on summary and page', async () => {
    const t = newT()
    const f = await fixture(t)
    const shown = await summary(t, f, ELSEWHERE)
    expect(shown.state).toBe('period_unavailable')
    expect(shown.periods.map((p) => p.key)).not.toContain(ELSEWHERE)
    expect(await page(t, f, { period: ELSEWHERE })).toEqual({ state: 'period_unavailable' })
    // and the other way round: neither of this organization's own past
    // periods is one of the other's
    const other = { admin: f.otherAdmin, org: f.otherOrg }
    for (const key of [PAST, MONTH, FREE]) {
      expect((await summary(t, other, key)).state).toBe('period_unavailable')
      expect(await page(t, other, { period: key })).toEqual({ state: 'period_unavailable' })
    }
    // a key both have counts each organization's own calls
    expect(await summary(t, other, PERIOD)).toMatchObject({ state: 'ready' })
    expect(rows((await ready(page(t, other, { period: PERIOD }))).rows)).toEqual([
      ['Elsewhere', 'active', 50],
    ])
    expect(await summary(t, f, PERIOD)).toMatchObject({ summary: { calls: 48 } })
  })

  it('lists only the caller’s organization in the person filter', async () => {
    const t = newT()
    const f = await fixture(t)
    await t.run(async (ctx) => {
      for (const profile of await ctx.db.query('profiles').collect())
        await ctx.db.patch(profile._id, named(profile.name))
      for (const org of [f.org.id, f.otherOrg.id])
        await ctx.db.insert('org_ready', { org_id: org, name_keys_at: NOW })
    })
    const mine = await people(t, f)
    const theirs = await people(t, { admin: f.otherAdmin, org: f.otherOrg })
    if (mine.state !== 'ready' || theirs.state !== 'ready') throw new Error('both are ready')
    expect(mine.rows.map((p) => p.id)).not.toContain(f.otherAdmin.id)
    expect(theirs.rows.map((p) => p.id)).toEqual([f.otherAdmin.id])
  })
})

describe('apiAccess.list, deprecated', () => {
  /* Tabs and desktop windows loaded before the pages call it until they
     reload, and render its whole list. */
  const list = (t: T, f: Admin, period?: string) =>
    as(t, f.admin).query(api.apiAccess.list, { org_id: f.org.id, period })

  it('answers the whole list in its old shape and order for apps loaded before the pages', async () => {
    const t = newT()
    const f = await fixture(t)
    const old = await list(t, f)
    expect(old.period).toBe(PERIOD)
    expect(old.periods.map((p) => p.key)).toEqual([PERIOD, PAST, MONTH, FREE])
    expect(rows(old.credentials)).toEqual(WHOLE_LIST)
    expect(old.summary).toEqual({
      calls: 48,
      included_calls: 175_000,
      plan: {
        currency: 'usd',
        api_calls_per_seat: 25_000,
        api_block_size: 25_000,
        api_block_price_cents: 100,
      },
      waived: false,
    })
    // the rows the pages list, field for field
    expect(old.credentials).toEqual(await everyRow(t, f))
    // as before, an unknown key shows the current period
    expect((await list(t, f, 'month:1999-01')).period).toBe(PERIOD)
    expect(rows((await list(t, f, PAST)).credentials)[0]).toEqual(['Cursor', 'active', 30])
  })

  it('refuses members who are not admins and other organizations', async () => {
    const t = newT()
    const f = await fixture(t)
    for (const member of [f.user, f.viewer, f.guest])
      await expectRefusal(
        as(t, member).query(api.apiAccess.list, { org_id: f.org.id }),
        'forbidden',
        /^admin only$/,
      )
    await expectRefusal(
      as(t, f.otherAdmin).query(api.apiAccess.list, { org_id: f.org.id }),
      'forbidden',
    )
  })
})

describe('apiAccess.page at scale', () => {
  /* 2,100 people with one personal token each: the old whole-list query
     read two index ranges a person, about 4,200, past Convex's 4,096. */
  async function crowd(t: T, f: Admin, count: number, token = (i: number) => `Token ${i}`) {
    for (let from = 0; from < count; from += 500)
      await t.run(async (ctx) => {
        for (let i = from; i < Math.min(count, from + 500); i++) {
          const id = uuid()
          await ctx.db.insert('profiles', {
            id,
            org_id: f.org.id,
            ...named(`Person ${String(i).padStart(4, '0')}`),
            initials: 'PE',
            color: '#7a7ad0',
            org_role: 'user',
            active: true,
            kind: 'person',
            created_at: NOW,
          })
          const profile = await byId(ctx, 'profiles', id)
          if (profile) await plantToken(ctx, uuid(), profile, token(i))
        }
      })
  }

  /* Convex's limits less half: a page that passed API_ACCESS_SCAN.read by
     more than a row's own reads would throw. */
  const HALF = {
    databaseQueries: API_ACCESS_SCAN.read.ranges + 32,
    documentsRead: API_ACCESS_SCAN.read.documents + 64,
    bytesRead: API_ACCESS_SCAN.read.bytes + 4 * MIB,
  }

  it('pages an organization of 2,100 people within half of each limit', async () => {
    const t = newT({ transactionLimits: HALF })
    const f = await withOrg(t)
    await crowd(t, f, 2100)
    const first = await ready(page(t, f))
    expect(first.rows.length).toBe(25)
    expect(first.stopped).toBe(false)
    const listed = await everyRow(t, f)
    expect(listed.length).toBe(2100)
    expect(new Set(listed.map((r) => r.id)).size).toBe(2100)
  }, 120_000)

  it('stops a search that matches nothing after its candidates, and the cursors reach the true end', async () => {
    const t = newT({ transactionLimits: HALF })
    const f = await withOrg(t)
    // the one match sorts last, so every page before it reads only misses
    await crowd(t, f, 2100, (i) => (i === 2050 ? 'Zebra needle' : `Token ${i}`))
    const first = await ready(page(t, f, { search: 'needle' }))
    expect(first).toMatchObject({ rows: [], stopped: true })
    expect(first.next).not.toBeNull()
    const pages = await walk(t, f, { search: 'needle' })
    expect(pages.length).toBe(Math.ceil(2100 / API_ACCESS_SCAN.candidates))
    expect(pages.slice(0, -1).every((shown) => shown.stopped)).toBe(true)
    expect(pages.flatMap((shown) => shown.rows).map((r) => r.name)).toEqual(['Zebra needle'])
    expect(pages.at(-1)).toMatchObject({ next: null, stopped: false })
  }, 120_000)

  it('ends a list whose credentials all have calls without pages that stopped empty', async () => {
    const t = newT({ transactionLimits: HALF })
    const f = await withOrg(t)
    // 2,000 personal tokens of 40 people, every one with calls this month
    const people = await t.run(async (ctx) => {
      const made: Doc<'profiles'>[] = []
      for (let i = 0; i < 40; i++) {
        const _id = await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: f.org.id,
          ...named(`Caller ${String(i).padStart(2, '0')}`),
          initials: 'CA',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
        const profile = await ctx.db.get(_id)
        if (profile) made.push(profile)
      }
      return made
    })
    for (let from = 0; from < 2000; from += 250)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 250; i++) {
          const id = uuid()
          const owner = people[i % people.length]
          await plantToken(ctx, id, owner, `Called ${i}`)
          await plantUsage(ctx, {
            org_id: f.org.id,
            profile_id: owner.id,
            credential_id: `mcp_tokens:${id}`,
            name: `Called ${i}`,
            calls: 1 + (i % 9),
            period_start: SEPTEMBER,
          })
        }
      })
    const pages = await walk(t, f)
    const listed = pages.flatMap((shown) => shown.rows)
    expect(listed.length).toBe(2000)
    expect(new Set(listed.map((r) => r.id)).size).toBe(2000)
    // the credentials without calls follow on no page of their own: every
    // page before the end lists rows, and none stopped
    expect(pages.filter((shown) => shown.stopped)).toEqual([])
    expect(pages.slice(0, -1).every((shown) => shown.rows.length > 0)).toBe(true)
  }, 180_000)

  it('stops a scan over large rows on bytes before Convex’s limits', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // connected apps with about 700 KB of requested scopes each
    const scopes = Array.from({ length: 700 }, (_, i) => `scope:${i}:${'s'.repeat(1000)}`)
    for (let i = 0; i < 30; i++)
      await t.run((ctx) =>
        plantConnection(ctx, uuid(), f.user, `Wide ${i}`, { requested_scopes: scopes }),
      )
    const first = await ready(page(t, f, { search: 'nowhere' }))
    expect(first).toMatchObject({ rows: [], stopped: true })
    expect(first.next).not.toBeNull()
    const pages = await walk(t, f, { search: 'nowhere' })
    expect(pages.length).toBeGreaterThan(2)
    expect(pages.at(-1)).toMatchObject({ next: null })
  }, 120_000)
})

describe('apiAccess.people', () => {
  /* withOrg's people keyed, as the name keys backfill leaves them. */
  async function keyed(t: T, f: Fixture) {
    await t.run(async (ctx) => {
      for (const profile of await ctx.db.query('profiles').collect())
        if (profile.org_id === f.org.id) await ctx.db.patch(profile._id, named(profile.name))
      await ctx.db.insert('org_ready', { org_id: f.org.id, name_keys_at: NOW })
    })
  }

  it('lists the organization’s people and agents in name order with search and cursors', async () => {
    const t = newT()
    const f = await fixture(t)
    await keyed(t, f)
    const first = await people(t, f)
    expect(first).toMatchObject({ state: 'ready', next: null, stopped: false })
    if (first.state !== 'ready') return
    // inactive seats too; removed accounts are not listed
    expect(first.rows.map((p) => [p.name, p.agent])).toEqual([
      ['admin', false],
      ['Elin Sand', false],
      ['guest', false],
      ['Relay', true],
      ['user', false],
      ['viewer', false],
    ])
    expect(await people(t, f, { search: 'SAND' })).toMatchObject({
      rows: [{ id: f.elin.id, name: 'Elin Sand', agent: false, removed: false }],
    })
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++)
        await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: f.org.id,
          ...named(`Émile ${String(i).padStart(2, '0')}`),
          initials: 'EM',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
    })
    const emile = await people(t, f, { search: 'emile' })
    if (emile.state !== 'ready' || emile.next === null) throw new Error('two batches expected')
    expect(emile.rows.length).toBe(25)
    const rest = await people(t, f, { search: 'émile', cursor: emile.next })
    expect(rest).toMatchObject({ next: null })
    if (rest.state === 'ready') expect(rest.rows.map((p) => p.name).at(-1)).toBe('Émile 29')
    await expectRefusal(
      people(t, f, { search: 'other', cursor: emile.next }),
      'bad_request',
      /^cursor must come from an earlier answer of the person filter/,
    )
  })

  it('answers not ready until every profile holds its name key', async () => {
    const t = newT()
    const f = await fixture(t)
    expect(await people(t, f)).toEqual({ state: 'not_ready' })
  })
})

/* REST and MCP with one secret, the way an API client calls them. */
async function machine(t: T, path: '/v1/me' | '/mcp', bearer: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${bearer}`,
  }
  const init: FetchInit =
    path === '/mcp'
      ? {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'api-access-test', version: '1.0.0' },
            },
          }),
        }
      : { method: 'GET', headers }
  const res = await (
    t as unknown as {
      fetch(path: string, init?: FetchInit): Promise<{ status: number; text(): Promise<string> }>
    }
  ).fetch(path, init)
  return { status: res.status, body: await res.text() }
}

/* The stored credential rows the revoke tests change. */
const stored = (t: T, f: Fixture) =>
  t.run(async (ctx) => ({
    relay: await byId(ctx, 'agent_keys', f.ids.relay),
    cursor: await byId(ctx, 'mcp_tokens', f.ids.cursor),
    old: await byId(ctx, 'mcp_tokens', f.ids.old),
    claude: await byId(ctx, 'oauth_connections', f.ids.claude),
    unplugged: await byId(ctx, 'oauth_connections', f.ids.unplugged),
  }))

describe('apiAccess.revoke', () => {
  it('revokes each kind, narrates for the export only, and the owner sees that an admin revoked it', async () => {
    const t = newT()
    const f = await fixture(t)
    const org = f.org.id
    expect(await revoke(t, f.admin, org, 'mcp_tokens', f.ids.cursor)).toBe(true)
    expect(await revoke(t, f.admin, org, 'oauth_connections', f.ids.claude)).toBe(true)
    expect(await revoke(t, f.admin, org, 'agent_keys', f.ids.relay)).toBe(true)

    const after = await stored(t, f)
    expect(after.cursor).toMatchObject({ revoked_by_admin: true })
    expect(after.cursor?.revoked_at).toBeDefined()
    expect(after.claude).toMatchObject({ revocation_reason: 'admin' })
    expect(after.claude?.revoked_at).toBeDefined()
    expect(after.relay?.revoked_at).toBeDefined()

    const listed = (await ready(page(t, f))).rows
    for (const name of ['Cursor', 'Claude', 'GitHub Actions'])
      expect(listed.find((r) => r.name === name)?.state).toBe('revoked')
    expect(listed.find((r) => r.name === 'Cursor')?.revoked_by_admin).toBe(true)

    // the owners' own lists say who ended them; the connection stays listed
    const mine = await as(t, f.user).query(api.tokens.listMcpTokens, {})
    expect(mine.find((row) => row.id === f.ids.cursor)).toMatchObject({ revokedByAdmin: true })
    expect(mine.find((row) => row.id === f.ids.old)).toMatchObject({ revokedByAdmin: false })
    const apps = await as(t, f.admin).query(api.oauthConnections.list, {})
    expect(apps.find((row) => row.id === f.ids.claude)).toMatchObject({ revokedByAdmin: true })
    expect(await t.mutation(internal.oauthAccess.touch, { id: f.ids.claude })).toBe(false)

    const events = await activityFor(t, org)
    expect(events.map((e) => [e.verb, e.target_id, e.label, e.detail, e.actor_id])).toEqual([
      ['revoked', f.user.id, 'user', 'a personal token “Cursor”', f.admin.id],
      ['revoked', f.admin.id, 'admin', 'the connection to “Claude”', f.admin.id],
      ['revoked', f.agent.id, 'Relay', 'the key “GitHub Actions”', f.admin.id],
    ])
  })

  it('stops a revoked token and key on REST and MCP', async () => {
    const t = newT()
    const f = await fixture(t)
    expect((await machine(t, '/v1/me', f.secrets.cursor)).status).toBe(200)
    expect((await machine(t, '/mcp', f.secrets.cursor)).status).toBe(200)
    expect((await machine(t, '/v1/me', f.secrets.relay)).status).toBe(200)
    await revoke(t, f.admin, f.org.id, 'mcp_tokens', f.ids.cursor)
    await revoke(t, f.admin, f.org.id, 'agent_keys', f.ids.relay)
    expect(await machine(t, '/v1/me', f.secrets.cursor)).toEqual({
      status: 401,
      body: '{"error":"this personal access token has been revoked or has expired"}',
    })
    expect(await machine(t, '/mcp', f.secrets.cursor)).toEqual({
      status: 401,
      body: '{"error":"unknown, expired or revoked MCP token"}',
    })
    expect(await machine(t, '/v1/me', f.secrets.relay)).toEqual({
      status: 401,
      body: '{"error":"this agent key has been revoked"}',
    })
  })

  it('stops a revoked connection getting new tokens and a revoked token’s webhook events', async () => {
    // Fake timers keep scheduled webhook delivery from sending a real request.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    onTestFinished(() => {
      vi.clearAllTimers()
      vi.useRealTimers()
    })
    const t = newT()
    const f = await fixture(t)

    // the connection's refresh, as the OAuth token endpoint claims it
    const refresh = (hash: string) =>
      t.mutation(internal.oauthConnections.claimIssuance, {
        id: f.ids.claude,
        authUserId: f.admin.auth_user_id ?? '',
        clientId: 'client-claude',
        resource: 'https://qivo.test/mcp',
        scopes: ['qivo:read'],
        credentialHash: hash,
        kind: 'refresh_token',
      })
    expect(await refresh('refresh-before')).toBe(true)

    // a task.updated subscription owned by Cursor, the user's token
    const cursor = (await stored(t, f)).cursor
    if (!cursor) throw new Error('fixture token vanished')
    const owner: EventOwner = {
      profile_id: f.user.id,
      credential_table: 'mcp_tokens',
      credential_id: cursor.id,
      credential_row_id: cursor._id,
    }
    const subscription = uuid()
    await t.mutation(internal.webhooks.save, {
      owner,
      id: subscription,
      name: 'task.updated',
      filters: {},
      url: 'https://receiver.example/events',
      encrypted_secret: 'encrypted-test-key',
    })
    // a task in the project the user leads, so the token can see its events
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.meta.id })
    const deliveries = () => t.run((ctx) => ctx.db.query('webhook_deliveries').collect())
    /** Renames the task and answers how many deliveries its event queued. */
    const rename = async (title: string) => {
      const before = (await deliveries()).length
      await t.run(async (ctx) => {
        const old = await ctx.db.get(issue._id)
        if (!old) throw new Error('fixture task vanished')
        await ctx.db.patch(issue._id, { title })
        const now = await ctx.db.get(issue._id)
        if (now) await notifyIssueUpdate(ctx, { before: old, after: now, actor: f.admin, now: NOW })
      })
      await flushWebhookEvents(t)
      return (await deliveries()).length - before
    }
    expect(await rename('Before the revoke')).toBe(1)
    const [queued] = await deliveries()

    await revoke(t, f.admin, f.org.id, 'oauth_connections', f.ids.claude)
    await revoke(t, f.admin, f.org.id, 'mcp_tokens', f.ids.cursor)
    expect(await refresh('refresh-after')).toBe(false)
    // the delivery queued before the revoke fails, and new events skip it
    expect(await t.mutation(internal.webhooks.claim, { id: queued.id })).toBeNull()
    expect((await deliveries()).find((row) => row.id === queued.id)?.status).toBe('failed')
    expect(await rename('After the revoke')).toBe(0)
  })

  it('answers another organization, an unknown id and an unfinished authorization alike, and refuses members', async () => {
    const t = newT()
    const f = await fixture(t)
    const org = f.org.id
    for (const [table, id] of [
      ['mcp_tokens', f.ids.foreign],
      ['mcp_tokens', uuid()],
      // a deleted token's id, from its usage row
      ['mcp_tokens', f.ids.gone],
      // the right id under another table
      ['agent_keys', f.ids.cursor],
      ['oauth_connections', f.ids.pending],
    ] as const)
      await expectRefusal(revoke(t, f.admin, org, table, id), 'not_found', /^credential not found$/)
    // the other organization's admin cannot reach this one's credentials
    await expectRefusal(
      revoke(t, f.otherAdmin, f.otherOrg.id, 'mcp_tokens', f.ids.cursor),
      'not_found',
      /^credential not found$/,
    )
    // a member cannot revoke here, not even their own token
    for (const member of [f.user, f.viewer, f.guest])
      await expectRefusal(
        revoke(t, member, org, 'mcp_tokens', f.ids.cursor),
        'forbidden',
        /^admin only$/,
      )
    expect((await stored(t, f)).cursor?.revoked_at).toBeUndefined()
    expect(await activityFor(t, org)).toEqual([])
  })

  it('changes nothing for a credential that is already revoked', async () => {
    const t = newT()
    const f = await fixture(t)
    const org = f.org.id
    const before = await stored(t, f)
    expect(await revoke(t, f.admin, org, 'mcp_tokens', f.ids.old)).toBe(false)
    // the owner deleted this connection; an admin revoke keeps it deleted
    expect(await revoke(t, f.admin, org, 'oauth_connections', f.ids.unplugged)).toBe(false)
    const after = await stored(t, f)
    expect(after.old).toEqual(before.old)
    expect(after.unplugged).toEqual(before.unplugged)
    expect(await activityFor(t, org)).toEqual([])
  })

  it('lets an admin revoke while billing has paused editing', async () => {
    const t = newT()
    const f = await fixture(t)
    await t.run((ctx) => ctx.db.patch(f.sub._id, { status: 'unpaid' }))
    // editing is paused, even for the admin
    await expectRefusal(
      as(t, f.admin).mutation(api.tokens.createAgentKey, {
        org_id: f.org.id,
        id: uuid(),
        agent_id: f.agent.id,
        name: 'New key',
        key_prefix: 'qva_0...00000',
        key_hash: 'cd'.repeat(32),
      }),
      'forbidden',
      /read-only/,
    )
    expect(await revoke(t, f.admin, f.org.id, 'mcp_tokens', f.ids.cursor)).toBe(true)
    expect((await stored(t, f)).cursor).toMatchObject({ revoked_by_admin: true })
  })
})

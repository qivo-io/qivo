/* The organization and name keys of API credentials (schema.ts agent_keys,
 * mcp_tokens and oauth_connections `org_id`, `name_key`), which the paged
 * API access and personal credential lists read by.
 *
 *   1. Every writer of an agent key, a personal token or an OAuth
 *      connection stores them: the app's creates, the contract suites' test
 *      credentials and consent, unfinished authorizations included. A
 *      revoke keeps them, and a delete or a profile removal leaves nothing
 *      of the credential in its organization's name indexes.
 *   2. internal/credentialKeysBackfill: the check, the dry run, a run across
 *      calls and pages, orphans, repair of a stale key and idempotence.
 *
 * Organization deletion, the one-transaction teardown and demo cleanup are
 * pinned where the rest of their rows are (orgRemovals.test.ts,
 * cascade.test.ts, demoCleanup.test.ts). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import * as credentialKeys from '../internal/credentialKeysBackfill'
import { as, newT, type OrgFixture, plantSeat, type T, uuid, withOrg } from './helpers.setup'

const NOW = '2026-09-20T12:00:00.000Z'

const defaults = { page: { ...credentialKeys.BACKFILL_PAGE }, run: { ...credentialKeys.RUN } }

beforeEach(() => {
  vi.stubEnv('APP_MODE', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  Object.assign(credentialKeys.BACKFILL_PAGE, defaults.page)
  Object.assign(credentialKeys.RUN, defaults.run)
})

const hex = (): string => uuid().replace(/-/g, '').padEnd(64, '0')

/** An agent key of the fixture's agent, created by its admin. */
const createKey = (t: T, f: OrgFixture, name: string, id = uuid()) =>
  as(t, f.admin).mutation(api.tokens.createAgentKey, {
    org_id: f.org.id,
    id,
    agent_id: f.agent.id,
    name,
    key_prefix: 'qva_012...abcde',
    key_hash: hex(),
  })

/** A personal token of `owner` on their seat `profile_id`, created by them. */
const createToken = (
  t: T,
  owner: Doc<'profiles'>,
  name: string,
  profile_id = owner.id,
  token_hash = hex(),
) =>
  as(t, owner).mutation(api.tokens.createMcpToken, {
    id: uuid(),
    profile_id,
    name,
    token_prefix: 'qvt_0123456',
    token_hash,
    access: 'write',
  })

/** The names in organization `orgId`'s name index of `table`, in its order. */
const byOrgName = (t: T, table: 'agent_keys' | 'mcp_tokens' | 'oauth_connections', orgId: string) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query(table)
        .withIndex('by_org_name', (q) => q.eq('org_id', orgId))
        .collect()
    ).map((row) => ('client_name' in row ? row.client_name : row.name)),
  )

describe('credential keys', () => {
  it('stores the organization and name key of every key and token a writer creates', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { id: keyId } = await createKey(t, f, '  Déploy   Bot ')
    await createKey(t, f, 'alpha')
    await createToken(t, f.user, 'Zed')
    // a token on the person's guest seat belongs to that seat's organization
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      auth_user_id: f.user.auth_user_id,
      email: f.user.email,
      org_role: 'guest',
    })
    await createToken(t, f.user, 'Guest seat token', elsewhere.id)
    // the contract suites' test credentials
    for (const kind of ['agent_key', 'mcp_token'] as const)
      await t.mutation(internal.machine.testing.mintCredential, {
        profile_id: kind === 'agent_key' ? f.agent.id : f.viewer.id,
        kind,
        key_prefix: kind === 'agent_key' ? 'qva_012...abcde' : 'qvt_0123456',
        key_hash: hex(),
        name: `Contract ${kind === 'agent_key' ? 'Key' : 'Token'}`,
        ...(kind === 'mcp_token' ? { access: 'read' as const } : {}),
        pending: true,
      })

    const keys = await t.run((ctx) => ctx.db.query('agent_keys').collect())
    const tokens = await t.run((ctx) => ctx.db.query('mcp_tokens').collect())
    expect(keys.map((k) => [k.name, k.org_id, k.name_key])).toEqual([
      ['Déploy   Bot', f.org.id, 'deploy bot'],
      ['alpha', f.org.id, 'alpha'],
      ['Contract Key', f.org.id, 'contract key'],
    ])
    expect(tokens.map((k) => [k.name, k.org_id, k.name_key])).toEqual([
      ['Zed', f.org.id, 'zed'],
      ['Guest seat token', f.otherOrg.id, 'guest seat token'],
      ['Contract Token', f.org.id, 'contract token'],
    ])
    // name order by key, not by the raw name's bytes, which put 'Zed' first
    expect(await byOrgName(t, 'agent_keys', f.org.id)).toEqual([
      'alpha',
      'Contract Key',
      'Déploy   Bot',
    ])
    expect(await byOrgName(t, 'mcp_tokens', f.org.id)).toEqual(['Contract Token', 'Zed'])
    expect(await byOrgName(t, 'mcp_tokens', f.otherOrg.id)).toEqual(['Guest seat token'])
    const agentKeys = await t.run((ctx) =>
      ctx.db
        .query('agent_keys')
        .withIndex('by_profile_name', (q) => q.eq('profile_id', f.agent.id))
        .collect(),
    )
    expect(agentKeys.map((k) => k.name_key)).toEqual(['alpha', 'contract key', 'deploy bot'])
    // a refused create writes nothing
    await expect(createKey(t, f, '   ', keyId)).rejects.toThrow()
    expect((await t.run((ctx) => ctx.db.query('agent_keys').collect())).length).toBe(3)
  })

  it('keeps the keys through every revoke, and a delete leaves the name index', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { id: keyId } = await createKey(t, f, 'Release bot')
    const { id: ownId } = await createToken(t, f.user, 'Own revoke')
    const { id: adminId } = await createToken(t, f.user, 'Admin revoke')
    const before = await t.run(async (ctx) => [
      ...(await ctx.db.query('agent_keys').collect()),
      ...(await ctx.db.query('mcp_tokens').collect()),
    ])
    await as(t, f.admin).mutation(api.tokens.revokeAgentKey, { org_id: f.org.id, id: keyId })
    await as(t, f.user).mutation(api.tokens.revokeMcpToken, { id: ownId })
    await as(t, f.admin).mutation(api.apiAccess.revoke, {
      org_id: f.org.id,
      table: 'mcp_tokens',
      id: adminId,
    })
    const after = await t.run(async (ctx) => [
      ...(await ctx.db.query('agent_keys').collect()),
      ...(await ctx.db.query('mcp_tokens').collect()),
    ])
    expect(after.map((row) => [row.org_id, row.name_key, row.revoked_at !== undefined])).toEqual(
      before.map((row) => [row.org_id, row.name_key, true]),
    )

    await as(t, f.admin).mutation(api.tokens.deleteAgentKey, { org_id: f.org.id, id: keyId })
    await as(t, f.user).mutation(api.tokens.deleteMcpToken, { id: ownId })
    expect(await byOrgName(t, 'agent_keys', f.org.id)).toEqual([])
    expect(await byOrgName(t, 'mcp_tokens', f.org.id)).toEqual(['Admin revoke'])
  })

  it("leaves none of a removed profile's keys and tokens in its organization's name indexes", async () => {
    const t = newT()
    const f = await withOrg(t)
    await createKey(t, f, 'Night job')
    await createToken(t, f.user, 'Cursor')
    await createToken(t, f.admin, 'Kept')
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: f.user.id })
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: f.agent.id })
    expect(await byOrgName(t, 'agent_keys', f.org.id)).toEqual([])
    expect(await byOrgName(t, 'mcp_tokens', f.org.id)).toEqual(['Kept'])
  })

  it('stores the client name key of every connection, unfinished ones included, and approval keeps it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const consent = (hash: string, clientName: string, approve: boolean) =>
      t.mutation(internal.oauthConnections.ensure, {
        authorizationHash: hash,
        authUserId: f.admin.auth_user_id ?? '',
        clientId: `client-${hash}`,
        clientName,
        resource: 'https://qivo.test/mcp',
        requestedScopes: ['qivo:read'],
        scopes: ['qivo:read'],
        approve,
        expiresAt: '2099-01-01T00:00:00.000Z',
      })
    await consent('one', '  Claude   Désktop ', false)
    await consent('two', 'abandoned', false)
    const unfinished = await t.run((ctx) => ctx.db.query('oauth_connections').collect())
    expect(unfinished.map((row) => [row.client_name, row.name_key, row.approved_at])).toEqual([
      ['Claude Désktop', 'claude desktop', undefined],
      ['abandoned', 'abandoned', undefined],
    ])
    await consent('one', 'ignored, the row exists', true)
    const rows = await t.run((ctx) => ctx.db.query('oauth_connections').collect())
    expect(rows[0]).toMatchObject({ client_name: 'Claude Désktop', name_key: 'claude desktop' })
    expect(rows[0].approved_at).toBeDefined()
    // the login's connected apps read approved connections only
    const listed = await t.run((ctx) =>
      ctx.db
        .query('oauth_connections')
        .withIndex('by_auth_user_approved', (q) =>
          q.eq('auth_user_id', f.admin.auth_user_id ?? '').gt('approved_at', ''),
        )
        .order('desc')
        .collect(),
    )
    expect(listed.map((row) => row.client_name)).toEqual(['Claude Désktop'])
    expect(await byOrgName(t, 'oauth_connections', f.org.id)).toEqual([
      'abandoned',
      'Claude Désktop',
    ])
  })
})

/* ------------------------------------------------------------- backfill */

describe('internal/credentialKeysBackfill', () => {
  /** Rows of every credential table as releases before keys stored them, an
   * orphan token whose profile is gone, a key whose name key is stale and a
   * current token. */
  async function legacy(t: T, f: OrgFixture) {
    await createToken(t, f.admin, 'Current')
    await t.run(async (ctx) => {
      const base = { created_at: NOW }
      await ctx.db.insert('agent_keys', {
        ...base,
        id: uuid(),
        profile_id: f.agent.id,
        name: 'Legacy key',
        key_prefix: 'qva_012...abcde',
        key_hash: hex(),
      })
      await ctx.db.insert('agent_keys', {
        ...base,
        id: uuid(),
        profile_id: f.agent.id,
        org_id: f.org.id,
        name: 'Renamed key',
        name_key: 'stale',
        key_prefix: 'qva_012...abcde',
        key_hash: hex(),
      })
      for (const [profile_id, name] of [
        [f.user.id, 'Legacy token'],
        [f.otherAdmin.id, 'Elsewhere'],
        [uuid(), 'Orphan'],
      ])
        await ctx.db.insert('mcp_tokens', {
          ...base,
          id: uuid(),
          profile_id,
          name,
          token_prefix: 'qvt_0123456',
          token_hash: hex(),
        })
      for (const [hash, approved_at] of [
        ['approved', NOW],
        ['unfinished', undefined],
      ])
        await ctx.db.insert('oauth_connections', {
          ...base,
          id: uuid(),
          authorization_hash: hash ?? '',
          auth_user_id: f.admin.auth_user_id ?? '',
          profile_id: f.admin.id,
          org_id: f.org.id,
          client_id: 'client',
          client_name: 'Claude',
          resource: 'https://qivo.test/mcp',
          requested_scopes: ['qivo:read'],
          scopes: ['qivo:read'],
          authorization_expires_at: NOW,
          approved_at,
        })
    })
  }

  const audits = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.query('platform_audit_log').collect()).filter(
        (row) => row.action === 'credential_keys_backfill',
      ),
    )

  it('checks and dry-runs without writing, then gives every row its keys across calls', async () => {
    const t = newT()
    const f = await withOrg(t)
    await legacy(t, f)
    const snapshot = () =>
      t.run(async (ctx) => [
        ...(await ctx.db.query('agent_keys').collect()),
        ...(await ctx.db.query('mcp_tokens').collect()),
        ...(await ctx.db.query('oauth_connections').collect()),
      ])
    const stored = await snapshot()

    const check = async (table: 'agent_keys' | 'mcp_tokens' | 'oauth_connections') =>
      await t.query(internal.internal.credentialKeysBackfill.remaining, { table })
    expect(await check('agent_keys')).toMatchObject({ rows: 2, orphans: 0, done: true })
    expect(await check('mcp_tokens')).toMatchObject({ rows: 2, orphans: 1, done: true })
    expect(await check('oauth_connections')).toMatchObject({ rows: 2, orphans: 0, done: true })
    const dry = await t.action(internal.internal.credentialKeysBackfill.run, { dry_run: true })
    expect(dry).toEqual({
      dry_run: true,
      agent_keys: 2,
      mcp_tokens: 2,
      oauth_connections: 2,
      orphans: 1,
      done: true,
      table: null,
      cursor: null,
    })
    expect(await snapshot()).toEqual(stored)
    expect(await audits(t)).toEqual([])

    // one page per call, so each call stops after its first page
    credentialKeys.BACKFILL_PAGE.rows = 1
    credentialKeys.RUN.ms = 0
    const totals = { agent_keys: 0, mcp_tokens: 0, oauth_connections: 0, orphans: 0 }
    let calls = 0
    // each answer goes back unchanged, a null cursor where a table starts too
    const answers: { table: string | null; cursor: string | null }[] = []
    for (let from = {}; ; ) {
      const got = await t.action(internal.internal.credentialKeysBackfill.run, {
        dry_run: false,
        ...from,
      })
      calls++
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += got[key]
      if (got.done) break
      answers.push({ table: got.table, cursor: got.cursor })
      from = { table: got.table, cursor: got.cursor }
    }
    expect(calls).toBeGreaterThan(3)
    expect(answers.some((answer) => answer.cursor === null && answer.table !== null)).toBe(true)
    expect(totals).toEqual({ agent_keys: 2, mcp_tokens: 2, oauth_connections: 2, orphans: 1 })
    expect((await audits(t)).length).toBe(calls)

    const keys = await t.run((ctx) => ctx.db.query('agent_keys').collect())
    expect(keys.map((row) => [row.org_id, row.name_key])).toEqual([
      [f.org.id, 'legacy key'],
      [f.org.id, 'renamed key'],
    ])
    const tokens = await t.run((ctx) => ctx.db.query('mcp_tokens').collect())
    expect(tokens.map((row) => [row.name, row.org_id, row.name_key])).toEqual([
      ['Current', f.org.id, 'current'],
      ['Legacy token', f.org.id, 'legacy token'],
      ['Elsewhere', f.otherOrg.id, 'elsewhere'],
      ['Orphan', undefined, undefined],
    ])
    const connections = await t.run((ctx) => ctx.db.query('oauth_connections').collect())
    expect(connections.map((row) => row.name_key)).toEqual(['claude', 'claude'])

    // the readiness reads the paged lists will make: only the orphan is left
    // without an organization, and the organization's connections all have keys
    const unkeyed = await t.run(async (ctx) => ({
      keys: await ctx.db
        .query('agent_keys')
        .withIndex('by_org_name', (q) => q.eq('org_id', undefined))
        .collect(),
      tokens: await ctx.db
        .query('mcp_tokens')
        .withIndex('by_org_name', (q) => q.eq('org_id', undefined))
        .collect(),
      connections: await ctx.db
        .query('oauth_connections')
        .withIndex('by_org_name', (q) => q.eq('org_id', f.org.id).eq('name_key', undefined))
        .first(),
    }))
    expect(unkeyed.keys).toEqual([])
    expect(unkeyed.tokens.map((row) => row.name)).toEqual(['Orphan'])
    expect(unkeyed.connections).toBeNull()

    // idempotent
    credentialKeys.RUN.ms = defaults.run.ms
    expect(
      await t.action(internal.internal.credentialKeysBackfill.run, { dry_run: false }),
    ).toMatchObject({ agent_keys: 0, mcp_tokens: 0, oauth_connections: 0, orphans: 1, done: true })
  })

  it('refuses a cursor without the table it was answered with', async () => {
    const t = newT()
    const f = await withOrg(t)
    await legacy(t, f)
    credentialKeys.BACKFILL_PAGE.rows = 1
    credentialKeys.RUN.ms = 0
    const first = await t.action(internal.internal.credentialKeysBackfill.run, { dry_run: true })
    expect(first).toMatchObject({ done: false, table: 'agent_keys', cursor: expect.any(String) })
    for (const table of [undefined, null])
      await expect(
        t.action(internal.internal.credentialKeysBackfill.run, {
          dry_run: true,
          table,
          cursor: first.cursor,
        }),
      ).rejects.toThrow(/goes back with the table/)
    // no cursor, or a null one, starts from the first table
    expect(
      await t.action(internal.internal.credentialKeysBackfill.run, {
        dry_run: true,
        table: null,
        cursor: null,
      }),
    ).toMatchObject({ agent_keys: 1, table: 'agent_keys' })
  })

  it('records what committed and answers the page to read again when a step fails', async () => {
    const t = newT()
    const f = await withOrg(t)
    await legacy(t, f)
    // a second profile with the agent's id, which no read of it accepts
    const twin = await t.run(async (ctx) => {
      const { _id, _creationTime, ...agent } = f.agent
      return await ctx.db.insert('profiles', agent)
    })
    const failed = await t.action(internal.internal.credentialKeysBackfill.run, {
      dry_run: false,
    })
    expect(failed).toMatchObject({
      agent_keys: 0,
      done: false,
      table: 'agent_keys',
      cursor: null,
      error: expect.any(String),
    })
    expect(await audits(t)).toMatchObject([{ detail: { agent_keys: 0, mcp_tokens: 0 } }])
    await t.run((ctx) => ctx.db.delete(twin))
    expect(
      await t.action(internal.internal.credentialKeysBackfill.run, {
        dry_run: false,
        table: failed.table,
        cursor: failed.cursor,
      }),
    ).toMatchObject({ agent_keys: 2, mcp_tokens: 2, oauth_connections: 2, done: true })
    expect(await audits(t)).toHaveLength(2)
  })
})

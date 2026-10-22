/* Credential access, the shared read/write rule of the machine surfaces
 * (lib/access.ts credentialAccess), and the gates that enforce it.
 *
 *   1. The mapping per credential kind, with its fail-closed cases.
 *   2. Personal tokens: creation and the test seam store an explicit access
 *      and a checked expiry, lookup and the per-request stamp refuse an
 *      expired token like a revoked one, and those two are the only paths
 *      that insert mcp_tokens rows.
 *   3. A static walk: every exported internal mutation and action of the
 *      machine surfaces and webhooks, every one the machine HTTP actions
 *      call, and every one reached from those through the code an action
 *      runs, takes the required `access` argument or is a named exemption
 *      with its reason. A call the walk cannot resolve fails it.
 *   4. Over HTTP: every write entry of the registry refuses a read-only
 *      personal token, a read-only OAuth grant (MCP; REST takes OAuth on its
 *      webhook routes only) and a Viewer agent key. The refs do not exist,
 *      so answering "not found" instead would be an existence oracle. Read-only credentials still read, write credentials
 *      still write, and an OAuth tool runs with the grant's live access.
 *
 * Webhook management with read-only and expired tokens is driven over HTTP
 * in tests/webhookApi.test.ts, where the callback receiver is mocked. */
/// <reference types="vite/client" />

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import authSchema from '../betterAuth/schema'
import {
  type AccessCredential,
  cleanTokenExpiry,
  credentialAccess,
  keepsInbox,
  tokenExpired,
} from '../lib/access'
import type { CredentialAccess } from '../lib/enums'
import { mcpResource } from '../lib/oauth'
import { MCP_AUTH_401, sha256hex } from '../machine/auth'
import { TOOLS } from '../machine/mcp'
import { ROUTES } from '../machine/rest'
import {
  as,
  beforeBodyRead,
  expectRefusal,
  NOW,
  newT,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

/* edge-runtime provides TextEncoder; convex/tsconfig's ESNext-only lib lacks
 * it. */
declare class TextEncoder {
  encode(input: string): Uint8Array
}

/* The two read-only refusal sentences, pinned byte for byte here rather than
 * imported, so an edit to the source constants fails the HTTP sweep. */
const CREDENTIAL_READS_ONLY = 'this credential can only read'
const VIEWER_AGENT_READS_ONLY = 'this agent is a Viewer and can only read'

/* ------------------------------------------------------------ 1. mapping */

type Seat = Pick<Doc<'profiles'>, 'kind' | 'org_role'>
const PERSON: Seat = { kind: 'person', org_role: 'user' }
const agentSeat = (org_role: string): Seat => ({ kind: 'agent', org_role }) as Seat
const AT = Date.parse('2026-10-14T12:00:00.000Z')

const personal = (access: CredentialAccess | undefined, expires_at?: string): AccessCredential => ({
  table: 'mcp_tokens',
  token: { access, expires_at },
  now: AT,
})

describe('credentialAccess', () => {
  it('a personal token writes only with write access and an expiry still ahead', () => {
    expect(credentialAccess(personal('write'), PERSON)).toBe('write')
    expect(credentialAccess(personal('write', '2026-10-14T12:00:00.001Z'), PERSON)).toBe('write')
    expect(credentialAccess(personal('read'), PERSON)).toBe('read')
    // minted before the field existed
    expect(credentialAccess(personal(undefined), PERSON)).toBe('read')
    expect(credentialAccess(personal('write', '2026-10-14T12:00:00.000Z'), PERSON)).toBe('read')
    expect(credentialAccess(personal('write', '2026-01-01T00:00:00.000Z'), PERSON)).toBe('read')
    expect(credentialAccess(personal('write', 'tomorrow'), PERSON)).toBe('read')
    expect(credentialAccess(personal('Write' as CredentialAccess), PERSON)).toBe('read')
    // a personal token on anything but a person's seat
    expect(credentialAccess(personal('write'), agentSeat('user'))).toBe('read')
  })

  it('an OAuth grant writes only with both qivo:read and qivo:write', () => {
    const oauth = (scopes: string[], seat: Seat = PERSON) =>
      credentialAccess({ table: 'oauth_connections', scopes }, seat)
    expect(oauth(['qivo:read', 'qivo:write', 'offline_access'])).toBe('write')
    expect(oauth(['qivo:read', 'offline_access'])).toBe('read')
    expect(oauth(['qivo:write'])).toBe('read')
    expect(oauth([])).toBe('read')
    expect(oauth(['qivo:read', 'qivo:write'], agentSeat('user'))).toBe('read')
  })

  it('an agent key writes only for a Standard user agent', () => {
    const key = (seat: Seat) => credentialAccess({ table: 'agent_keys' }, seat)
    expect(key(agentSeat('user'))).toBe('write')
    for (const role of ['viewer', 'admin', 'guest', 'owner', '']) {
      expect(key(agentSeat(role)), role).toBe('read')
    }
    expect(key(PERSON)).toBe('read')
  })

  it('keepsInbox: every person, and an agent only while it is active and its key can write', () => {
    const seat = (kind: string, org_role: string, active: boolean) =>
      ({ kind, org_role, active }) as Pick<Doc<'profiles'>, 'kind' | 'org_role' | 'active'>
    expect(keepsInbox(seat('person', 'viewer', true))).toBe(true)
    expect(keepsInbox(seat('person', 'user', false))).toBe(true)
    expect(keepsInbox(seat('agent', 'user', true))).toBe(true)
    expect(keepsInbox(seat('agent', 'user', false))).toBe(false)
    for (const role of ['viewer', 'admin', 'guest', 'owner', '']) {
      expect(keepsInbox(seat('agent', role, true)), role).toBe(false)
    }
    expect(keepsInbox(seat('bot', 'user', true))).toBe(false)
  })

  it('an unknown credential kind reads', () => {
    const unknown = { table: 'api_keys' } as unknown as AccessCredential
    expect(credentialAccess(unknown, agentSeat('user'))).toBe('read')
    expect(credentialAccess(unknown, PERSON)).toBe('read')
  })

  it('tokenExpired: no expiry never expires; the instant itself and garbage count as expired', () => {
    expect(tokenExpired({ expires_at: undefined }, AT)).toBe(false)
    expect(tokenExpired({ expires_at: '2026-10-14T12:00:00.001Z' }, AT)).toBe(false)
    expect(tokenExpired({ expires_at: '2026-10-14T12:00:00.000Z' }, AT)).toBe(true)
    expect(tokenExpired({ expires_at: 'never' }, AT)).toBe(true)
    expect(tokenExpired({ expires_at: '2099-01-01T00:00:00.000Z' }, Number.NaN)).toBe(true)
  })

  it('cleanTokenExpiry keeps real UTC date-times, normalized, and refuses the rest', () => {
    expect(cleanTokenExpiry('2027-01-31T00:00:00Z')).toBe('2027-01-31T00:00:00.000Z')
    expect(cleanTokenExpiry('2027-01-31T08:30:15.5Z')).toBe('2027-01-31T08:30:15.500Z')
    for (const bad of [
      '2027-01-31',
      '2027-02-30T00:00:00Z',
      '2027-01-31T24:00:00Z',
      '2027-01-31T00:00:00+02:00',
      '2027-01-31 00:00:00Z',
      '2027-01-31T00:00Z',
      'soon',
      '',
    ]) {
      expect(() => cleanTokenExpiry(bad), bad).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'bad_request',
            message: 'expires_at must be a UTC date-time such as 2027-01-31T00:00:00Z',
          }),
        }),
      )
    }
  })
})

/* ------------------------------------------------------ 2. personal tokens */

const hex = (): string => uuid().replace(/-/g, '').padEnd(64, '0')

describe('personal tokens', () => {
  it('creation stores the chosen access and a future expiry, and the list shows both', async () => {
    const t = newT()
    const f = await withOrg(t)
    const create = (over: { access?: CredentialAccess; expires_at?: string; name?: string }) =>
      as(t, f.user).mutation(api.tokens.createMcpToken, {
        id: uuid(),
        profile_id: f.user.id,
        name: 'Claude',
        token_prefix: 'qvt_0123456',
        token_hash: hex(),
        access: 'write',
        ...over,
      })
    await create({ name: 'Writer' })
    await create({ name: 'Reader', access: 'read', expires_at: '2099-01-31T00:00:00Z' })
    for (const bad of ['2099-01-31', '2099-02-30T00:00:00Z', 'next week']) {
      await expectRefusal(create({ expires_at: bad }), 'bad_request', /^expires_at must be a UTC/)
    }
    await expectRefusal(
      create({ expires_at: '2020-01-01T00:00:00Z' }),
      'bad_request',
      /^expires_at must be in the future$/,
    )
    // no default: leaving access out is refused, never read as write
    const withoutAccess = {
      id: uuid(),
      profile_id: f.user.id,
      name: 'Unsaid',
      token_prefix: 'qvt_0123456',
      token_hash: hex(),
    }
    await expect(
      as(t, f.user).mutation(api.tokens.createMcpToken, withoutAccess as never),
    ).rejects.toThrow(/access/)
    // a row minted before access existed lists, and works, as read-only
    await t.run(async (ctx) => {
      await ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: f.user.id,
        name: 'Legacy',
        token_prefix: 'qvt_legacy0',
        token_hash: hex(),
        created_at: NOW,
      })
    })
    const listed = await as(t, f.user).query(api.tokens.listMcpTokens, {})
    expect(
      listed
        .map((row) => [row.name, row.access, row.expiresAt])
        .sort((a, b) => a[0]!.localeCompare(b[0]!)),
    ).toEqual([
      ['Legacy', 'read', null],
      ['Reader', 'read', '2099-01-31T00:00:00.000Z'],
      ['Writer', 'write', null],
    ])
  })

  it('the test seam requires access on a personal token and accepts a past expiry', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = {
      profile_id: f.user.id,
      kind: 'mcp_token',
      key_prefix: 'qvt_seam000',
      name: 'Seam',
      pending: true,
    } as const
    await expectRefusal(
      t.mutation(internal.machine.testing.mintCredential, { ...base, key_hash: hex() }),
      'bad_request',
      /^a personal token needs access/,
    )
    const minted = await t.mutation(internal.machine.testing.mintCredential, {
      ...base,
      key_hash: hex(),
      access: 'read',
      expires_at: '2020-01-01T00:00:00Z',
    })
    const row = await t.run((ctx) =>
      ctx.db
        .query('mcp_tokens')
        .withIndex('by_uuid', (q) => q.eq('id', minted.id))
        .unique(),
    )
    expect(row).toMatchObject({ access: 'read', expires_at: '2020-01-01T00:00:00.000Z' })
    await expectRefusal(
      t.mutation(internal.machine.testing.mintCredential, {
        profile_id: f.agent.id,
        kind: 'agent_key',
        key_prefix: 'qva_seam000',
        key_hash: hex(),
        name: 'Seam key',
        access: 'write',
        pending: true,
      }),
      'bad_request',
      /^an agent key takes no access or expiry/,
    )
    // names are capped as in the app, so a removal reads them a page at a time
    for (const [kind, name] of [
      ['agent_key', 'k'.repeat(81)],
      ['mcp_token', 't'.repeat(81)],
    ] as const)
      await expectRefusal(
        t.mutation(internal.machine.testing.mintCredential, {
          profile_id: kind === 'agent_key' ? f.agent.id : f.user.id,
          kind,
          key_prefix: 'qva_seam000',
          key_hash: hex(),
          name,
          ...(kind === 'mcp_token' ? { access: 'read' as const } : {}),
          pending: true,
        }),
        'rule',
        /must be at most 80 characters/,
      )
  })

  it('the test seam deletes the credentials of one profile with exactly one name', async () => {
    const t = newT()
    const f = await withOrg(t)
    const mint = (profile_id: string, kind: 'agent_key' | 'mcp_token', name: string) =>
      t.mutation(internal.machine.testing.mintCredential, {
        profile_id,
        kind,
        key_prefix: 'qvt_named00',
        key_hash: hex(),
        name,
        pending: true,
        ...(kind === 'mcp_token' ? { access: 'write' as const } : {}),
      })
    const name = 'contract pass token 0123456789abcdef'
    await mint(f.user.id, 'mcp_token', name)
    await mint(f.user.id, 'mcp_token', name)
    await mint(f.agent.id, 'agent_key', name)
    const kept = [
      await mint(f.user.id, 'mcp_token', `${name}0`),
      await mint(f.user.id, 'mcp_token', 'Laptop'),
    ]
    const sweep = internal.machine.testing.deleteNamedCredentials
    expect(await t.mutation(sweep, { profile_id: f.user.id, name })).toEqual({ deleted: 2 })
    expect(await t.mutation(sweep, { profile_id: f.user.id, name })).toEqual({ deleted: 0 })
    expect(await t.mutation(sweep, { profile_id: f.agent.id, name })).toEqual({ deleted: 1 })
    await expectRefusal(
      t.mutation(sweep, { profile_id: f.user.id, name: ' ' }),
      'bad_request',
      /^a credential name is required/,
    )
    const left = await t.run(async (ctx) => [
      ...(await ctx.db.query('mcp_tokens').collect()),
      ...(await ctx.db.query('agent_keys').collect()),
    ])
    expect(left.map((row) => row.id).sort()).toEqual(kept.map((row) => row.id).sort())
  })

  it('the test seam mints pending credentials that a late mint or activation cannot make usable', async () => {
    const t = newT()
    const f = await withOrg(t)
    const testing = internal.machine.testing
    const passes = [
      { profile_id: f.user.id, kind: 'mcp_token', name: 'contract pass token 0123456789abcdef' },
      { profile_id: f.agent.id, kind: 'agent_key', name: 'contract pass key 0123456789abcdef' },
    ] as const
    const mint = (pass: (typeof passes)[number], key_hash = hex()) =>
      t.mutation(testing.mintCredential, {
        ...pass,
        key_prefix: 'qvt_pend000',
        key_hash,
        pending: true,
        ...(pass.kind === 'mcp_token' ? { access: 'write' as const } : {}),
      })
    const lookup = (pass: (typeof passes)[number], hash: string) =>
      t.query(internal.machine.auth.lookupCredential, {
        hash,
        isAgent: pass.kind === 'agent_key',
        now: new Date().toISOString(),
      })
    const named = ({ profile_id, name }: (typeof passes)[number]) => ({ profile_id, name })
    const activate = (pass: (typeof passes)[number]) =>
      t.mutation(testing.activateNamedCredentials, named(pass))
    for (const pass of passes) {
      const hash = hex()
      await mint(pass, hash)
      expect(await lookup(pass, hash)).toMatchObject({ ok: false, why: 'unknown' })
      expect(await activate(pass)).toEqual({ activated: 1 })
      expect(await lookup(pass, hash)).toMatchObject({ ok: true })
      // a killed pass whose mint lands after the next pass deleted its
      // credentials by name: the late row stays pending
      await t.mutation(testing.deleteNamedCredentials, named(pass))
      const late = hex()
      await mint(pass, late)
      expect(await lookup(pass, late)).toMatchObject({ ok: false, why: 'unknown' })
      expect(await lookup(pass, hash)).toMatchObject({ ok: false, why: 'unknown' })
      // a killed pass whose activation lands after the next pass deleted the
      // credentials it had minted: nothing is left to activate
      await t.mutation(testing.deleteNamedCredentials, named(pass))
      const minted = hex()
      await mint(pass, minted)
      await t.mutation(testing.deleteNamedCredentials, named(pass))
      expect(await activate(pass)).toEqual({ activated: 0 })
      expect(await lookup(pass, minted)).toMatchObject({ ok: false, why: 'unknown' })
    }
    await expectRefusal(
      t.mutation(testing.activateNamedCredentials, { profile_id: f.user.id, name: ' ' }),
      'bad_request',
      /^a credential name is required/,
    )
  })

  it('the test seam never activates a pending credential that any revoke path stamped', async () => {
    const t = newT()
    const f = await withOrg(t)
    const testing = internal.machine.testing
    const token = {
      profile_id: f.user.id,
      kind: 'mcp_token',
      name: 'contract pass token 0',
    } as const
    const key = { profile_id: f.agent.id, kind: 'agent_key', name: 'contract pass key 0' } as const
    const mint = async (pass: typeof token | typeof key) => {
      const hash = hex()
      const { id } = await t.mutation(testing.mintCredential, {
        ...pass,
        key_prefix: 'qvt_pend000',
        key_hash: hash,
        pending: true,
        ...(pass.kind === 'mcp_token' ? { access: 'write' as const } : {}),
      })
      return { id, hash }
    }
    const named = ({ profile_id, name }: typeof token | typeof key) => ({ profile_id, name })
    const revokes = [
      [token, (id: string) => as(t, f.user).mutation(api.tokens.revokeMcpToken, { id })],
      [
        key,
        (id: string) =>
          as(t, f.admin).mutation(api.tokens.revokeAgentKey, { org_id: f.org.id, id }),
      ],
      [
        token,
        (id: string) =>
          as(t, f.admin).mutation(api.apiAccess.revoke, {
            org_id: f.org.id,
            table: 'mcp_tokens',
            id,
          }),
      ],
      [
        key,
        (id: string) =>
          as(t, f.admin).mutation(api.apiAccess.revoke, {
            org_id: f.org.id,
            table: 'agent_keys',
            id,
          }),
      ],
    ] as const
    for (const [pass, revoke] of revokes) {
      const { id, hash } = await mint(pass)
      expect(await revoke(id)).toBe(true)
      expect(await t.mutation(testing.activateNamedCredentials, named(pass))).toEqual({
        activated: 0,
      })
      const lookup = await t.query(internal.machine.auth.lookupCredential, {
        hash,
        isAgent: pass.kind === 'agent_key',
        now: new Date().toISOString(),
      })
      expect(lookup).toMatchObject({ ok: false })
      await t.mutation(testing.deleteNamedCredentials, named(pass))
    }
    // a revoke that leaves the other pending row of the same name alone
    const kept = await mint(token)
    const revoked = await mint(token)
    await as(t, f.admin).mutation(api.apiAccess.revoke, {
      org_id: f.org.id,
      table: 'mcp_tokens',
      id: revoked.id,
    })
    expect(await t.mutation(testing.activateNamedCredentials, named(token))).toEqual({
      activated: 1,
    })
    const now = new Date().toISOString()
    expect(
      await t.query(internal.machine.auth.lookupCredential, {
        hash: kept.hash,
        isAgent: false,
        now,
      }),
    ).toMatchObject({ ok: true })
    expect(
      await t.query(internal.machine.auth.lookupCredential, {
        hash: revoked.hash,
        isAgent: false,
        now,
      }),
    ).toMatchObject({ ok: false, why: 'unknown' })
  })

  it('the test seam keeps one credential per hash across its pending and usable forms', async () => {
    const t = newT()
    const f = await withOrg(t)
    const testing = internal.machine.testing
    const kinds = [
      { kind: 'mcp_token', profile_id: f.user.id, refusal: /^that token already exists/ },
      { kind: 'agent_key', profile_id: f.agent.id, refusal: /^that key already exists/ },
    ] as const
    for (const { kind, profile_id, refusal } of kinds) {
      const named = { profile_id, name: `contract pass ${kind} 0` }
      const mint = (key_hash: string) =>
        t.mutation(testing.mintCredential, {
          ...named,
          kind,
          key_prefix: 'qvt_pend000',
          key_hash,
          pending: true,
          ...(kind === 'mcp_token' ? { access: 'read' as const } : {}),
        })
      const hash = hex()
      await mint(hash)
      // the same hash again while it is pending, and once it is usable
      await expectRefusal(mint(hash), 'bad_request', refusal)
      expect(await t.mutation(testing.activateNamedCredentials, named)).toEqual({ activated: 1 })
      await expectRefusal(mint(hash), 'bad_request', refusal)
      // a usable row that took the plain hash after the mint refuses activation
      const other = hex()
      await mint(other)
      await t.run(async (ctx) => {
        const row = { id: uuid(), name: 'Laptop', created_at: NOW }
        if (kind === 'mcp_token')
          await ctx.db.insert('mcp_tokens', {
            ...row,
            profile_id: f.admin.id,
            token_prefix: 'qvt_laptop0',
            token_hash: other,
            access: 'read',
          })
        else
          await ctx.db.insert('agent_keys', {
            ...row,
            profile_id: f.agent.id,
            key_prefix: 'qva_laptop0',
            key_hash: other,
          })
      })
      await expectRefusal(
        t.mutation(testing.activateNamedCredentials, named),
        'bad_request',
        /^another credential already holds that hash/,
      )
    }
  })

  it('the test seam mints only for a caller that asks for a pending credential', async () => {
    const t = newT()
    const f = await withOrg(t)
    const args = {
      profile_id: f.agent.id,
      kind: 'agent_key',
      key_prefix: 'qva_old0000',
      key_hash: hex(),
      name: 'contract pass key',
    } as const
    // an older contract pass, which expects a usable credential
    await expect(
      // @ts-expect-error an older contract pass sends no pending argument
      t.mutation(internal.machine.testing.mintCredential, args),
    ).rejects.toThrow(/pending/)
    const keys = await t.run(async (ctx) => await ctx.db.query('agent_keys').collect())
    expect(keys.filter((row) => row.name === args.name)).toEqual([])
  })

  it('the test seam deletes the credentials of one profile by name prefix and age', async () => {
    const t = newT()
    const f = await withOrg(t)
    const plant = (profile_id: string, name: string, created_at: string) =>
      t.run(async (ctx) => {
        const id = uuid()
        await ctx.db.insert('mcp_tokens', {
          id,
          profile_id,
          name,
          token_prefix: 'qvt_old0000',
          token_hash: hex(),
          access: 'write',
          created_at,
        })
        return id
      })
    const old = '2026-10-19T11:59:59.999Z'
    const cutoff = '2026-10-19T12:00:00.000Z'
    await plant(f.user.id, 'contract pass token', old)
    await plant(f.user.id, 'contract pass token 0123456789abcdef', old)
    const kept = [
      await plant(f.user.id, 'contract pass token fedcba9876543210', cutoff),
      await plant(f.user.id, 'Laptop', old),
      await plant(f.admin.id, 'contract pass token 0123456789abcdef', old),
    ]
    const sweep = internal.machine.testing.deleteOldCredentials
    const args = { profile_id: f.user.id, name_prefix: 'contract pass token' }
    expect(await t.mutation(sweep, { ...args, created_before: cutoff })).toEqual({ deleted: 2 })
    expect(await t.mutation(sweep, { ...args, created_before: cutoff })).toEqual({ deleted: 0 })
    await expectRefusal(
      t.mutation(sweep, { ...args, name_prefix: ' ', created_before: cutoff }),
      'bad_request',
      /^a name prefix is required/,
    )
    await expectRefusal(
      t.mutation(sweep, { ...args, created_before: 'yesterday' }),
      'bad_request',
      /^created_before is a date-time/,
    )
    const left = await t.run(async (ctx) => await ctx.db.query('mcp_tokens').collect())
    expect(left.map((row) => row.id).sort()).toEqual([...kept].sort())
  })

  it('lookup refuses an expired token like a revoked one and resolves each access', async () => {
    const t = newT()
    const f = await withOrg(t)
    const viewerAgent = await plantAgent(t, f.org.id, 'viewer')
    const plant = async (row: { access?: CredentialAccess; expires_at?: string }) => {
      const hash = hex()
      await t.run(async (ctx) => {
        await ctx.db.insert('mcp_tokens', {
          id: uuid(),
          profile_id: f.user.id,
          name: 'Lookup',
          token_prefix: 'qvt_lookup0',
          token_hash: hash,
          created_at: NOW,
          ...row,
        })
      })
      return hash
    }
    const lookup = async (hash: string, isAgent = false, now = '2026-10-14T12:00:00.000Z') =>
      await t.query(internal.machine.auth.lookupCredential, { hash, isAgent, now })
    const accessOf = async (hash: string, isAgent = false) => {
      const res = await lookup(hash, isAgent)
      return res.ok ? res.cred.access : res.why
    }
    expect(await accessOf(await plant({ access: 'write' }))).toBe('write')
    expect(await accessOf(await plant({ access: 'read' }))).toBe('read')
    expect(await accessOf(await plant({}))).toBe('read')
    const expiring = await plant({ access: 'write', expires_at: '2026-10-14T12:00:00.000Z' })
    expect(await lookup(expiring, false, '2026-10-14T11:59:59.999Z')).toMatchObject({
      ok: true,
      cred: { access: 'write' },
    })
    expect(await lookup(expiring)).toEqual({ ok: false, why: 'revoked', isAgent: false })
    // garbage stored in the field fails closed too
    expect(await accessOf(await plant({ access: 'write', expires_at: 'never' }))).toBe('revoked')
    for (const [agent, expected] of [
      [f.agent, 'write'],
      [viewerAgent, 'read'],
    ] as const) {
      const hash = hex()
      await t.run(async (ctx) => {
        await ctx.db.insert('agent_keys', {
          id: uuid(),
          profile_id: agent.id,
          name: 'Lookup key',
          key_prefix: 'qva_lookup0',
          key_hash: hash,
          created_at: NOW,
        })
      })
      expect(await accessOf(hash, true), agent.name).toBe(expected)
    }
  })

  it('the per-request stamp refuses a token that expired after lookup', async () => {
    const t = newT()
    const f = await withOrg(t)
    const expiresAt = '2026-10-14T12:00:00.000Z'
    const token = await t.run(async (ctx) => {
      const _id = await ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: f.user.id,
        name: 'Stamp',
        token_prefix: 'qvt_stamp00',
        token_hash: hex(),
        access: 'write',
        expires_at: expiresAt,
        created_at: NOW,
      })
      return (await ctx.db.get(_id)) as Doc<'mcp_tokens'>
    })
    const touch = (now: string) =>
      t.mutation(internal.machine.auth.touchCredential, {
        table: 'mcp_tokens',
        tokenId: token.id,
        rowId: token._id,
        profileId: f.user.id,
        now,
      })
    expect(await touch('2026-10-14T11:59:59.999Z')).toBe(true)
    expect(await touch(expiresAt)).toBeNull()
    expect(await touch('2026-10-15T00:00:00.000Z')).toBeNull()
    // only the request before expiry was stamped
    expect((await t.run((ctx) => ctx.db.get(token._id)))?.last_used_at).toBe(
      '2026-10-14T11:59:59.999Z',
    )
  })

  it('only convex/tokens.ts and the test seam insert mcp_tokens rows', () => {
    // Both paths are driven above and store an explicit access, so this scan
    // is enough: a new insert path fails here until it is covered too.
    const sources = import.meta.glob(
      ['../**/*.ts', '!../_generated/**', '!../betterAuth/**', '!../tests/**'],
      { eager: true, query: '?raw', import: 'default' },
    ) as Record<string, string>
    const inserting = Object.entries(sources)
      .filter(([, src]) =>
        /\binsert\(\s*'mcp_tokens'|insertUnique\(\s*\w+,\s*'mcp_tokens'/.test(src),
      )
      .map(([path]) => path.replace(/^\.\.\//, ''))
      .sort()
    expect(inserting).toEqual(['machine/testing.ts', 'tokens.ts'])
  })
})

/* --------------------------------------------------------- 3. static walk */

type Registered = {
  isQuery?: true
  isMutation?: true
  isAction?: true
  isInternal?: true
  exportArgs?: () => string
}

type Modules = Record<string, Record<string, unknown>>
type Sources = Record<string, string>

/* Every module that can register a function, so an `internal.…` reference
 * resolves wherever its target lives, and the source of each, so the walk
 * can follow the code an action runs. */
const modules = import.meta.glob(
  [
    '../**/*.ts',
    '!../_generated/**',
    '!../betterAuth/**',
    '!../tests/**',
    '!../convex.config.ts',
    '!../auth.config.ts',
    '!../env.d.ts',
  ],
  { eager: true },
) as Modules

const sources = import.meta.glob(
  [
    '../**/*.ts',
    '!../_generated/**',
    '!../betterAuth/**',
    '!../tests/**',
    '!../convex.config.ts',
    '!../auth.config.ts',
    '!../env.d.ts',
  ],
  { eager: true, query: '?raw', import: 'default' },
) as Sources

/** Every `internal.…` reference in some code, as "module:export". */
function refsIn(code: string): string[] {
  return [...code.matchAll(/\binternal\.((?:\w+\.)+\w+)/g)].map(([, ref]) => {
    const parts = ref.split('.')
    return `${parts.slice(0, -1).join('/')}:${parts.at(-1)}`
  })
}

/** Runner and scheduler calls in some code given anything but an
 * `internal.…` reference (a variable, makeFunctionReference, a public api
 * reference), which hide their target from the walk. The lookahead also
 * refuses whitespace, so a reference on the next line is not read as the
 * line break before it. */
function indirectIn(code: string): string[] {
  return [
    ...code.matchAll(/\brun(?:Query|Mutation|Action)\(\s*(?!\s|internal\.)([^,)]*)/g),
    ...code.matchAll(/\bscheduler\.run(?:After|At)\([^,]*,\s*(?!\s|internal\.)([^,)]*)/g),
  ].map(([, arg]) => arg.trim())
}

/* A top-level declaration. Biome starts every one at column 0, so each runs
 * to the next. */
const DECLARATION =
  /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm

/* A comment that fills its lines, a `//` line or a block that starts a line
 * and whose first close ends one. Its words run nothing, and the walk drops
 * it. A comment after code on the same line stays, which only widens the
 * walk. */
const COMMENT_LINES = /^[ \t]*(?:\/\/.*|\/\*(?:(?!\*\/)[\s\S])*\*\/[ \t]*)$/gm

/** Where a name a module uses comes from, a declaration in another module,
 * or null when the walk cannot read it (a default or namespace import, or a
 * module outside the glob). */
type Binding = { path: string; name: string } | null

/** A module's code by top-level declaration, and where its imported and
 * re-exported names come from. */
type ModuleCode = {
  declared: Map<string, string>
  imported: Map<string, Binding>
  reexported: Map<string, Binding>
}

/**
 * The walk over a set of modules and their sources, which finds the internal
 * mutations and actions the machine surfaces can reach. It starts from every
 * exported internal mutation and action of the machine and webhook modules
 * and every `internal.…` reference in the machine sources. Then it follows
 * each action it reaches through the code that action runs, which is its own
 * declaration and every declaration that code names, in its module or
 * imported from another, and so on by name. Words in a comment name
 * nothing the code runs, so the walk skips whole-line comments
 * (COMMENT_LINES). A query cannot write, and a mutation it reaches is
 * checked itself, so only actions are followed. For the same reason the
 * walk never follows a registered query or mutation by name, because an
 * action can only run one through its `internal.…` reference, which the
 * walk reaches. A reference or an import the walk cannot resolve throws, so
 * a call it cannot follow fails every test that uses the walk instead of
 * dropping out of it.
 */
function walker(modules: Modules, sources: Sources) {
  const registered = (name: string): Registered | undefined => {
    const [module, fn] = name.split(':')
    const value = modules[`../${module}.ts`]?.[fn] as Registered | undefined
    return value?.exportArgs === undefined ? undefined : value
  }
  const writes = (fn: Registered | undefined): boolean =>
    fn?.isInternal === true && (fn.isMutation === true || fn.isAction === true)
  /* Whether the declaration `name` of the module at `path` is a registered
   * query or mutation, whose code the walk does not follow by name. */
  const runsOnItsOwn = (path: string, name: string): boolean => {
    const fn = modules[path]?.[name] as Registered | undefined
    return fn?.exportArgs !== undefined && fn.isAction !== true
  }
  const machineSources = Object.fromEntries(
    Object.entries(sources).filter(([path]) => /^\.\.\/machine\/[^/]+\.ts$/.test(path)),
  )
  const machineRefs = (): string[] =>
    [...new Set(Object.values(machineSources).flatMap(refsIn))].sort()

  /** The module a relative import names, or undefined for generated code. */
  const resolve = (from: string, spec: string): string | undefined => {
    const parts = from.split('/').slice(0, -1)
    for (const part of spec.split('/')) {
      if (part === '..') parts.pop()
      else if (part !== '.') parts.push(part)
    }
    const path = `${parts.join('/')}.ts`
    return path.includes('/_generated/') ? undefined : path
  }

  const parsed = new Map<string, ModuleCode>()
  const codeOf = (path: string): ModuleCode => {
    const known = parsed.get(path)
    if (known !== undefined) return known
    const src = sources[path]
    if (src === undefined) throw new Error(`the walk cannot read ${path}`)
    const declared = new Map<string, string>()
    const starts = [...src.matchAll(DECLARATION)]
    starts.forEach((m, i) => {
      const text = src.slice(m.index, starts[i + 1]?.index ?? src.length)
      const code = text.replace(COMMENT_LINES, '')
      declared.set(m[1], (declared.get(m[1]) ?? '') + code) // overloads add up
    })
    const imported = new Map<string, Binding>()
    const reexported = new Map<string, Binding>()
    const bindings =
      /^(import|export)\s+(type\s+)?((?:[A-Za-z_$][\w$]*\s*,\s*)?\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/gm
    for (const [, kind, typeOnly, clause, spec] of src.matchAll(bindings)) {
      if (typeOnly !== undefined || !spec.startsWith('.')) continue
      const target = resolve(path, spec)
      if (target === undefined) continue
      const into = kind === 'import' ? imported : reexported
      const named = /\{([^}]*)\}/.exec(clause)
      for (const part of named?.[1].split(',') ?? []) {
        const [name, local = name] = part.trim().split(/\s+as\s+/)
        if (name === '' || name.startsWith('type ')) continue
        into.set(local, target in sources ? { path: target, name } : null)
      }
      // a default or namespace import binds a whole module
      for (const local of clause.replace(/\{[^}]*\}/, '').match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (local !== 'as') into.set(local, null)
      }
    }
    // `export { name }` passes on what the module imported
    for (const [, list] of src.matchAll(/^export\s+\{([^}]*)\}\s*$/gm)) {
      for (const part of list.split(',')) {
        const [name, local = name] = part.trim().split(/\s+as\s+/)
        if (imported.has(name)) reexported.set(local, imported.get(name) ?? null)
      }
    }
    const code = { declared, imported, reexported }
    parsed.set(path, code)
    return code
  }

  /** The declaration behind `name` as `path` exports it. */
  const declarationOf = (path: string, name: string): { path: string; name: string } => {
    const code = codeOf(path)
    if (code.declared.has(name)) return { path, name }
    const via = code.reexported.get(name)
    if (via === undefined || via === null) {
      throw new Error(`the walk cannot follow ${name} from ${path}`)
    }
    return declarationOf(via.path, via.name)
  }

  /** The code the registered function `name` runs. */
  const codeRunBy = (name: string): string[] => {
    const [module, fn] = name.split(':')
    const seen = new Set<string>()
    const out: string[] = []
    const queue = [{ path: `../${module}.ts`, name: fn }]
    for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
      const key = `${at.path}#${at.name}`
      if (seen.has(key)) continue
      seen.add(key)
      const code = codeOf(at.path)
      const text = code.declared.get(at.name)
      if (text === undefined) throw new Error(`the walk cannot find ${key}`)
      out.push(text)
      for (const [word] of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
        if (code.declared.has(word) && !runsOnItsOwn(at.path, word)) {
          queue.push({ path: at.path, name: word })
        }
        const via = code.imported.get(word)
        if (via === null) throw new Error(`${key} uses ${word}, which the walk cannot follow`)
        if (via === undefined) continue
        const declaration = declarationOf(via.path, via.name)
        if (!runsOnItsOwn(declaration.path, declaration.name)) queue.push(declaration)
      }
    }
    return out
  }

  /** Every internal mutation and action the walk reaches, as "module:export". */
  const guarded = (): string[] => {
    const names = new Set<string>()
    const reach = (name: string, from: string): void => {
      if (names.has(name)) return
      const fn = registered(name)
      if (fn === undefined)
        throw new Error(`${from} calls internal ${name}, which is not registered`)
      if (!writes(fn)) return
      names.add(name)
      if (fn.isAction !== true) return
      for (const code of codeRunBy(name)) {
        const indirect = indirectIn(code)
        if (indirect.length > 0) {
          throw new Error(`${name} runs ${indirect.join(', ')}, which the walk cannot follow`)
        }
        for (const ref of refsIn(code)) reach(ref, name)
      }
    }
    for (const [path, mod] of Object.entries(modules)) {
      const module = path.replace(/^\.\.\//, '').replace(/\.ts$/, '')
      if (!module.startsWith('machine/') && module !== 'webhooks' && module !== 'webhookActions')
        continue
      for (const fn of Object.keys(mod)) {
        if (writes(registered(`${module}:${fn}`))) reach(`${module}:${fn}`, module)
      }
    }
    for (const name of machineRefs()) reach(name, 'a machine source')
    return [...names].sort()
  }

  /** The guarded functions without the required `access` argument that
   * `exempt` does not name. */
  const missingAccess = (exempt: Record<string, string>): string[] =>
    guarded().filter((name) => {
      if (exempt[name] !== undefined) return false
      const args = JSON.parse(registered(name)?.exportArgs?.() ?? '{}') as {
        value?: Record<string, unknown>
      }
      return JSON.stringify(args.value?.access) !== ACCESS_ARG
    })

  return { registered, machineSources, machineRefs, codeRunBy, guarded, missingAccess }
}

const walk = walker(modules, sources)

/* Each exemption names why the function needs no `access` argument. */
const EXEMPT: Record<string, string> = {
  'machine/auth:touchCredential':
    'stamps last_used_at and counts usage for every authenticated request, before dispatch',
  'machine/testing:mintCredential':
    'deploy-key test seam that mints credentials, refused on production',
  'machine/testing:deleteCredential':
    'deploy-key test seam that deletes minted credentials, refused on production',
  'machine/testing:deleteNamedCredentials':
    'deploy-key test seam that deletes minted credentials by name, refused on production',
  'machine/testing:activateNamedCredentials':
    'deploy-key test seam that activates pending minted credentials, refused on production',
  'machine/testing:deleteOldCredentials':
    'deploy-key test seam that deletes old minted credentials, refused on production',
  'machine/uploads:begin':
    'the upload URL takes no credential; its signed token names the ticket a write credential started',
  'machine/uploads:finish': 'the upload URL records the file of a ticket begin claimed',
  'machine/uploads:abandon': 'the upload URL frees a ticket begin claimed after a failed POST',
  'billingMetering:ingress':
    'counts every machine request before authentication (machine HTTP actions)',
  'billingMetering:oauthCall':
    "counts an OAuth request against the person's allowance (machine HTTP actions)",
  'oauthConnections:touch': 'stamps last_used_at on an OAuth connection (machine HTTP actions)',
  'webhooks:save': 'takes an owner; any valid credential may create its own subscription',
  'webhooks:remove': 'takes an owner; any valid credential may remove its own subscription',
  'webhooks:removeOrganization':
    "takes an owner and computes the owner's access itself; it requires write",
  'webhooks:claim': 'delivery bookkeeping run by the scheduler; it rechecks the owner',
  'webhooks:finish': 'delivery bookkeeping run by the scheduler; no credential',
  'webhooks:sweep': 'retention run by the scheduler; no credential',
  'webhookActions:manage': "takes an owner and manages only that owner's own subscriptions",
  'webhookActions:deliver': 'delivery run by the scheduler; claim rechecks the owner',
  'panoramaCuration:authorize':
    'platform curation key surface (machine/curation.ts), not an organization credential',
  'panoramaCuration:machineReview':
    'platform curation key surface; an agent precheck never approves or publishes',
  'panoramaCuration:machineReviewSubmission':
    'platform curation key surface; an agent precheck never approves or publishes',
  'panoramaCuration:machineSubmit':
    'platform curation key surface; a submission waits for human approval',
}

const ACCESS_ARG = JSON.stringify({
  fieldType: {
    type: 'union',
    value: [
      { type: 'literal', value: 'read' },
      { type: 'literal', value: 'write' },
    ],
  },
  optional: false,
})

describe('every machine write takes the credential access', () => {
  it('positive control: the walk sees the machine writes and the HTTP bookkeeping', () => {
    const names = walk.guarded()
    expect(names).toContain('machine/mcp:createIssue')
    expect(names).toContain('machine/rest:addComment')
    expect(names).toContain('billingMetering:ingress')
    expect(names).toContain('oauthConnections:touch')
    // an action is followed into its own code and the helpers it imports
    const delivery = walk.codeRunBy('webhookActions:deliver').join('\n')
    expect(delivery).toContain('export async function postWebhook(')
    expect(refsIn(delivery)).toEqual(expect.arrayContaining(['webhooks:claim', 'webhooks:finish']))
  })

  it('every function call in the machine sources is an internal reference the walk resolves', () => {
    const indirect = Object.entries(walk.machineSources).flatMap(([path, src]) =>
      indirectIn(src).map((arg) => `${path}: ${arg}`),
    )
    expect(indirect).toEqual([])
    expect(walk.machineRefs().filter((name) => walk.registered(name) === undefined)).toEqual([])
    // the resolver reaches a module outside the two directories the walk owns
    expect(walk.registered('internal/operator:provisionOperator')?.isInternal).toBe(true)
  })

  it('each one takes the required access argument or is a named exemption', () => {
    expect(walk.missingAccess(EXEMPT)).toEqual([])
  })

  it('every exemption still names a guarded function and gives a reason', () => {
    const names = new Set(walk.guarded())
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(names.has(name), `${name} is exempt but not guarded`).toBe(true)
      expect(reason.length, name).toBeGreaterThan(10)
    }
  })

  it("reaches a mutation of the action's own module by its reference, not by following its code", () => {
    const exportArgs = () => `{"type":"object","value":{"access":${ACCESS_ARG}}}`
    const fakeModules: Modules = {
      '../machine/fake.ts': {
        relay: { isAction: true, isInternal: true, exportArgs },
        stamp: { isMutation: true, isInternal: true, exportArgs },
      },
    }
    const fakeSources: Sources = {
      '../machine/fake.ts': [
        "import { components, internal } from '../_generated/api'",
        'export const relay = internalAction({',
        '  handler: async (ctx) => {',
        '    await ctx.runMutation(internal.machine.fake.stamp, {})',
        '  },',
        '})',
        // a mutation may run a component's query, which the walk cannot read
        'export const stamp = internalMutation({',
        '  handler: async (ctx) => {',
        '    await ctx.runQuery(components.auth.find, {})',
        '  },',
        '})',
      ].join('\n'),
    }
    expect(walker(fakeModules, fakeSources).guarded()).toEqual([
      'machine/fake:relay',
      'machine/fake:stamp',
    ])
  })

  it('does not follow a name that only a comment mentions', () => {
    const exportArgs = () => `{"type":"object","value":{"access":${ACCESS_ARG}}}`
    const fakeModules: Modules = {
      '../machine/fake.ts': { relay: { isAction: true, isInternal: true, exportArgs } },
      '../lib/log.ts': {},
    }
    // log schedules through a reference the walk cannot follow
    const fakeSources = (relay: string): Sources => ({
      '../machine/fake.ts': [
        "import { log } from '../lib/log'",
        'export const relay = internalAction({',
        relay,
        '})',
        '/* The next route records its change with log. */',
        '// log runs in a mutation, never here',
        'export const after = 1',
      ].join('\n'),
      '../lib/log.ts':
        'export async function log(ctx) {\n  await ctx.scheduler.runAt(0, trimRef, {})\n}',
    })
    const comments =
      '  /* the mutation calls log */\n  // log cleans up too\n  handler: async () => {},'
    expect(walker(fakeModules, fakeSources(comments)).guarded()).toEqual(['machine/fake:relay'])
    // the same name in code is followed, and a comment that ends where code
    // starts stays, so its line is followed too
    for (const code of ['  handler: async (ctx) => log(ctx),', '  /* x */ handler: log,']) {
      expect(() => walker(fakeModules, fakeSources(code)).guarded()).toThrow(
        'machine/fake:relay runs trimRef, which the walk cannot follow',
      )
    }
  })

  it('follows an action to the writes it reaches through helpers in any module', () => {
    const args = (access: boolean) => () =>
      `{"type":"object","value":{${access ? `"access":${ACCESS_ARG}` : ''}}}`
    const action = { isAction: true, isInternal: true, exportArgs: args(false) }
    const mutation = { isMutation: true, isInternal: true, exportArgs: args(false) }
    const gated = { isMutation: true, isInternal: true, exportArgs: args(true) }
    const fakeModules: Modules = {
      '../machine/fake.ts': { handler: {} },
      '../relay.ts': { pass: action, unrelated: mutation },
      '../lib/records.ts': {},
      '../store.ts': { gated, open: mutation, elsewhere: mutation },
    }
    const fakeSources: Sources = {
      '../machine/fake.ts': [
        "import { internal } from '../_generated/api'",
        'export const handler = httpAction(async (ctx) => {',
        '  await ctx.runAction(internal.relay.pass, {})',
        '})',
      ].join('\n'),
      '../relay.ts': [
        "import { internal } from './_generated/api'",
        "import { record as note } from './lib/records'",
        'export const pass = internalAction({',
        '  handler: async (ctx) => {',
        '    await stamp(ctx)',
        '    await note(ctx)',
        '  },',
        '})',
        'async function stamp(ctx) {',
        '  await ctx.runMutation(internal.store.gated, {})',
        '}',
        'export const unrelated = internalMutation({',
        '  handler: async (ctx) => {',
        '    await ctx.scheduler.runAfter(0, internal.store.elsewhere, {})',
        '  },',
        '})',
      ].join('\n'),
      // a reference on its own line is still a reference
      '../lib/records.ts': [
        "import { internal } from '../_generated/api'",
        'export async function record(ctx) {',
        '  await ctx.runMutation(',
        '    internal.store.open,',
        '    {},',
        '  )',
        '}',
      ].join('\n'),
      '../store.ts': '',
    }
    const fake = walker(fakeModules, fakeSources)
    // the imported helper's write is reached; the other function of the
    // action's module and what it schedules are not
    expect(fake.guarded()).toEqual(['relay:pass', 'store:gated', 'store:open'])
    expect(fake.missingAccess({ 'relay:pass': 'a relay the test exempts' })).toEqual(['store:open'])
    // a target the walk cannot see fails it
    const hidden = (code: string) =>
      walker(fakeModules, { ...fakeSources, '../lib/records.ts': code }).guarded()
    expect(() =>
      hidden('export async function record(ctx) {\n  await ctx.runMutation(ref, {})\n}'),
    ).toThrow('relay:pass runs ref, which the walk cannot follow')
    expect(() =>
      hidden('export async function record(ctx) {\n  await ctx.runMutation(internal.nope.gone)\n}'),
    ).toThrow('relay:pass calls internal nope:gone, which is not registered')
    expect(() =>
      hidden("import helpers from '../store'\nexport const record = helpers.write"),
    ).toThrow('uses helpers, which the walk cannot follow')
  })
})

/* ---------------------------------------------------------- 4. over HTTP */

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string | Uint8Array }
type Res = { status: number; text: string; header: (name: string) => string | null }

async function fetchAs(t: T, path: string, init: FetchInit): Promise<Res> {
  const res = await (
    t as unknown as {
      fetch(
        path: string,
        init?: FetchInit,
      ): Promise<{
        status: number
        text(): Promise<string>
        headers: { get(name: string): string | null }
      }>
    }
  ).fetch(path, init)
  return { status: res.status, text: await res.text(), header: (name) => res.headers.get(name) }
}

const MISSING_TASK = 'QN-999999'
const MISSING_UUID = '00000000-0000-4000-8000-000000000000'

type ToolDef = (typeof TOOLS)[number]['def']

/* Optional arguments that keep a tool from finding anything, for a tool
 * whose required arguments alone would name nothing and still write. */
const MISSING_OPTIONAL: Record<string, Record<string, unknown>> = {
  create_project: { parent: 'NOPE' },
  set_team: { team_id: MISSING_UUID },
}

/* Arguments that pass a tool's schema and name nothing that exists. An
 * enum takes its first member, and every other string a ref to nothing. */
function missingRefArgs(def: ToolDef): Record<string, unknown> {
  const out: Record<string, unknown> = { ...MISSING_OPTIONAL[def.name] }
  for (const key of def.inputSchema.required ?? []) {
    const prop = def.inputSchema.properties[key]
    const p = prop.anyOf?.[0] ?? prop
    out[key] =
      p.format === 'uuid'
        ? MISSING_UUID
        : p.enum !== undefined
          ? p.enum[0]
          : p.type === 'integer' || p.type === 'number'
            ? (p.minimum ?? 1)
            : p.type === 'boolean'
              ? true
              : key === 'ref' || key === 'other'
                ? MISSING_TASK
                : 'NOPE'
  }
  return out
}

/** One MCP tools/call on the modern leg: the HTTP status and the JSON body. */
async function callTool(
  t: T,
  secret: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; header: Res['header'] }> {
  const res = await fetchAs(t, '/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  })
  return {
    status: res.status,
    body: JSON.parse(res.text) as Record<string, unknown>,
    header: res.header,
  }
}

/* The one text of a tool result, and whether it is an error. */
function toolText(body: Record<string, unknown>): { text: string; isError: boolean } {
  const result = body.result as { content: { text: string }[]; isError?: boolean }
  return { text: result.content[0].text, isError: result.isError === true }
}

const restCall = (t: T, secret: string, method: string, path: string, body?: unknown) =>
  fetchAs(t, path, {
    method,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function plantAgent(t: T, orgId: string, org_role: 'user' | 'viewer') {
  return await t.run(async (ctx) => {
    const _id = await ctx.db.insert('profiles', {
      id: uuid(),
      org_id: orgId,
      name: org_role === 'viewer' ? 'Ledger' : 'Atlas',
      initials: 'AG',
      color: '#444444',
      org_role,
      active: true,
      kind: 'agent',
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'profiles'>
  })
}

/* withOrg plus one credential of every shape. Both agents hold User on the
 * meta, so only the Viewer's role keeps it from writing. */
async function credentials() {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
  const f = await withOrg(t)
  const viewerAgent = await plantAgent(t, f.org.id, 'viewer')
  const secret = (prefix: string) => `${prefix}${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
  const readToken = secret('qvt_')
  const writeToken = secret('qvt_')
  const expiredToken = secret('qvt_')
  const agentKey = secret('qva_')
  const viewerKey = secret('qva_')
  for (const [token, access, expires_at] of [
    [readToken, 'read', undefined],
    [writeToken, 'write', undefined],
    [expiredToken, 'write', '2020-01-01T00:00:00.000Z'],
  ] as const) {
    const token_hash = await sha256hex(token)
    await t.run(async (ctx) => {
      await ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: f.user.id,
        name: `${access} token`,
        token_prefix: token.slice(0, 11),
        token_hash,
        access,
        expires_at,
        created_at: NOW,
      })
    })
  }
  for (const [key, agent] of [
    [agentKey, f.agent],
    [viewerKey, viewerAgent],
  ] as const) {
    const key_hash = await sha256hex(key)
    await t.run(async (ctx) => {
      await ctx.db.insert('agent_keys', {
        id: uuid(),
        profile_id: agent.id,
        name: `${agent.name} key`,
        key_prefix: key.slice(0, 11),
        key_hash,
        created_at: NOW,
      })
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: agent.id,
        level: 'user',
      })
    })
  }
  // the fixture's real Better Auth login for the user
  const authUserId = f.user.auth_user_id!
  /* An approved OAuth connection with these scopes and one live access token. */
  const oauth = async (scopes: string[]) => {
    const clientId = uuid()
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'oauthClient',
        data: { clientId, redirectUris: ['https://client.example/callback'], scopes },
      },
    })
    const connectionId = uuid()
    await t.run((ctx) =>
      ctx.db.insert('oauth_connections', {
        id: connectionId,
        profile_id: f.user.id,
        org_id: f.org.id,
        auth_user_id: authUserId,
        client_id: clientId,
        client_name: 'Access tests',
        resource: mcpResource(),
        authorization_hash: uuid(),
        requested_scopes: scopes,
        scopes,
        created_at: new Date().toISOString(),
        approved_at: new Date().toISOString(),
        authorization_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    )
    const token = `qvo_${uuid()}`
    const tokenHash = await sha256hex(token.slice(4))
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'oauthAccessToken',
        data: {
          token: tokenHash,
          clientId,
          userId: authUserId,
          referenceId: connectionId,
          scopes,
          expiresAt: Date.now() + 60_000,
        },
      },
    })
    return { token, tokenHash, clientId }
  }
  const counts = () =>
    t.run(async (ctx) => ({
      issues: (await ctx.db.query('issues').collect()).length,
      comments: (await ctx.db.query('comments').collect()).length,
      projects: (await ctx.db.query('projects').collect()).length,
      grants: (await ctx.db.query('project_access').collect()).length,
      milestones: (await ctx.db.query('milestones').collect()).length,
      teams: (await ctx.db.query('teams').collect()).length,
      members: (await ctx.db.query('team_members').collect()).length,
    }))
  return {
    t,
    f,
    viewerAgent,
    readToken,
    writeToken,
    expiredToken,
    agentKey,
    viewerKey,
    oauth,
    counts,
  }
}

/* Narrow every access token of an OAuth client to these scopes. */
async function narrowGrant(t: T, clientId: string, scopes: string[]): Promise<void> {
  await t.mutation(components.betterAuth.adapter.updateMany, {
    input: {
      model: 'oauthAccessToken',
      where: [{ field: 'clientId', value: clientId }],
      update: { scopes },
    },
    paginationOpts: { numItems: 100, cursor: null },
  })
}

const WRITE_TOOLS = TOOLS.filter((tool) => tool.access !== 'read')
const READ_TOOLS = TOOLS.filter((tool) => tool.access === 'read')
const WRITE_ROUTES = ROUTES.filter((route) => route.access !== 'read')

/* A write route's path with every :param naming a task that does not exist. */
const missingPath = (path: string): string => `/v1/${path.replace(/:\w+/g, MISSING_TASK)}`

describe('read-only credentials over HTTP', () => {
  it('both surfaces have write entries to check', () => {
    expect(WRITE_TOOLS.length).toBeGreaterThan(0)
    expect(WRITE_ROUTES.length).toBeGreaterThan(0)
  })

  it('every MCP write tool refuses a read-only personal token and a Viewer agent first', async () => {
    const c = await credentials()
    const before = await c.counts()
    for (const tool of WRITE_TOOLS) {
      const args = missingRefArgs(tool.def)
      for (const [secret, sentence] of [
        [c.readToken, CREDENTIAL_READS_ONLY],
        [c.viewerKey, VIEWER_AGENT_READS_ONLY],
      ] as const) {
        const res = await callTool(c.t, secret, tool.def.name, args)
        expect(res.status, tool.def.name).toBe(200)
        expect(toolText(res.body), tool.def.name).toEqual({ text: sentence, isError: true })
      }
      // the same refs answer a writer with something else, so they reach nothing
      const writer = toolText((await callTool(c.t, c.writeToken, tool.def.name, args)).body)
      expect(writer.isError, tool.def.name).toBe(true)
      expect(writer.text, tool.def.name).not.toBe(CREDENTIAL_READS_ONLY)
    }
    expect(await c.counts()).toEqual(before)
  })

  it('every MCP write tool challenges a read-only OAuth grant for qivo:write', async () => {
    const c = await credentials()
    const { token } = await c.oauth(['qivo:read'])
    for (const tool of WRITE_TOOLS) {
      const res = await callTool(c.t, token, tool.def.name, missingRefArgs(tool.def))
      expect(res.status, tool.def.name).toBe(403)
      expect(res.body.error, tool.def.name).toBe('insufficient_scope')
      expect(res.header('WWW-Authenticate'), tool.def.name).toContain(
        'scope="qivo:read qivo:write"',
      )
    }
  })

  it('every REST write route refuses a read-only personal token and a Viewer agent first', async () => {
    const c = await credentials()
    const { token: readGrant } = await c.oauth(['qivo:read'])
    const before = await c.counts()
    const body = { project: 'NOPE', title: 'x' }
    for (const route of WRITE_ROUTES) {
      const label = `${route.method} ${route.path}`
      const path = missingPath(route.path)
      for (const [secret, sentence] of [
        [c.readToken, CREDENTIAL_READS_ONLY],
        [c.viewerKey, VIEWER_AGENT_READS_ONLY],
      ] as const) {
        const res = await restCall(c.t, secret, route.method, path, body)
        expect(res.status, label).toBe(403)
        expect(JSON.parse(res.text), label).toEqual({ error: sentence })
      }
      // OAuth reaches only the webhook routes, read-only or not
      expect((await restCall(c.t, readGrant, route.method, path, body)).status, label).toBe(401)
      // write credentials get past the gate and find nothing, or meet a rule
      // of the action itself (only organization admins edit labels)
      for (const secret of [c.writeToken, c.agentKey]) {
        const writer = await restCall(c.t, secret, route.method, path, body)
        expect([400, 403, 404], label).toContain(writer.status)
        const { error } = JSON.parse(writer.text) as { error: string }
        expect([CREDENTIAL_READS_ONLY, VIEWER_AGENT_READS_ONLY], label).not.toContain(error)
      }
    }
    expect(await c.counts()).toEqual(before)
  })

  it('read-only credentials still read on both surfaces', async () => {
    const c = await credentials()
    const { token: readGrant } = await c.oauth(['qivo:read'])
    const args: Record<string, Record<string, unknown>> = {
      list_project_users: { project: c.f.sub.key },
      get_project: { project: c.f.sub.key },
      get_task: { ref: MISSING_TASK },
      list_comments: { ref: MISSING_TASK },
    }
    for (const secret of [c.readToken, c.viewerKey, readGrant]) {
      for (const tool of READ_TOOLS) {
        const res = await callTool(c.t, secret, tool.def.name, args[tool.def.name] ?? {})
        expect(res.status, tool.def.name).toBe(200)
        const { text } = toolText(res.body)
        expect(text, tool.def.name).not.toBe(CREDENTIAL_READS_ONLY)
        expect(text, tool.def.name).not.toBe(VIEWER_AGENT_READS_ONLY)
        // a project row never offers a write this credential cannot make
        if (tool.def.name === 'list_projects' || tool.def.name === 'get_project') {
          const rows = [JSON.parse(text)].flat() as { access: { write: boolean } }[]
          expect(rows.length, tool.def.name).toBeGreaterThan(0)
          expect(
            rows.map((row) => row.access.write),
            tool.def.name,
          ).not.toContain(true)
        }
      }
    }
    for (const path of ['/v1/me', '/v1/projects', '/v1/tasks', '/v1/users']) {
      for (const secret of [c.readToken, c.viewerKey]) {
        expect((await restCall(c.t, secret, 'GET', path)).status, path).toBe(200)
      }
    }
  })

  it('write credentials still write: personal token, OAuth grant and Standard user agent', async () => {
    const c = await credentials()
    const { token: writeGrant } = await c.oauth(['qivo:read', 'qivo:write'])
    const before = await c.counts()
    for (const secret of [c.writeToken, writeGrant, c.agentKey]) {
      const listed = await callTool(c.t, secret, 'list_projects', {})
      const rows = JSON.parse(toolText(listed.body).text) as {
        key: string
        access: { write: boolean }
      }[]
      expect(rows.find((row) => row.key === c.f.sub.key)?.access.write).toBe(true)
      const res = await callTool(c.t, secret, 'create_task', {
        project: c.f.sub.key,
        title: 'Written',
      })
      expect(toolText(res.body).isError).toBe(false)
    }
    for (const secret of [c.writeToken, c.agentKey]) {
      const rest = await restCall(c.t, secret, 'POST', '/v1/tasks', {
        project: c.f.sub.key,
        title: 'Written over REST',
      })
      expect(rest.status).toBe(201)
    }
    expect((await c.counts()).issues).toBe(before.issues + 5)
  })

  it('an OAuth grant attaches files over MCP, and REST still refuses its token', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'credential-access-files-secret')
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const c = await credentials()
    const { token } = await c.oauth(['qivo:read', 'qivo:write'])
    const created = await callTool(c.t, token, 'create_task', {
      project: c.f.sub.key,
      title: 'Wiring',
    })
    const { key } = JSON.parse(toolText(created.body).text) as { key: string }
    const started = await callTool(c.t, token, 'start_attachment_upload', {
      ref: key,
      name: 'wiring.pdf',
      size: 5,
    })
    const { ticket, upload_url } = JSON.parse(toolText(started.body).text) as {
      ticket: string
      upload_url: string
    }
    const url = new URL(upload_url)
    const sent = await fetchAs(c.t, `${url.pathname}${url.search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: new Uint8Array([1, 2, 3, 4, 5]),
    })
    const { storageId: storage_id } = JSON.parse(sent.text) as { storageId: string }
    const confirmed = await callTool(c.t, token, 'confirm_attachment_upload', {
      ref: key,
      ticket,
      storage_id,
    })
    const text = await callTool(c.t, token, 'attach_text_file', {
      ref: key,
      name: 'notes.md',
      text: '# Wiring notes',
    })
    for (const res of [confirmed, text]) {
      expect(res.status).toBe(200)
      const out = toolText(res.body)
      expect(out.isError, out.text).toBe(false)
      expect(JSON.parse(out.text)).toMatchObject({ uploaded_by_id: c.f.user.id })
    }
    // a body that is not UTF-8 is no JSON-RPC message, so no tool runs
    const encoder = new TextEncoder()
    const latin1 = Uint8Array.from([
      ...encoder.encode(
        `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"attach_text_file","arguments":{"ref":"${key}","name":"t.txt","text":"3,5 `,
      ),
      0xb0,
      ...encoder.encode('C"}}}'),
    ])
    const notUtf8 = await fetchAs(c.t, '/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: latin1,
    })
    expect(notUtf8.status).toBe(400)
    expect(JSON.parse(notUtf8.text)).toMatchObject({ error: { code: -32700 } })
    const rows = await c.t.run((ctx) => ctx.db.query('issue_attachments').collect())
    expect(rows.map((row) => [row.name, row.size_bytes])).toEqual([
      ['wiring.pdf', 5],
      ['notes.md', 14],
    ])
    // the token stays bound to /mcp
    const rest = await restCall(c.t, token, 'POST', `/v1/tasks/${key}/attachments`, {
      name: 'wiring.pdf',
      size: 5,
    })
    expect(rest.status).toBe(401)
  })

  it('an OAuth grant narrowed to read looks up as read and is challenged before dispatch', async () => {
    const c = await credentials()
    const grant = await c.oauth(['qivo:read', 'qivo:write'])
    const lookup = () =>
      c.t.query(internal.oauthConnections.lookupAccess, {
        tokenHash: grant.tokenHash,
        resource: mcpResource(),
      })
    expect((await lookup())?.access).toBe('write')
    await narrowGrant(c.t, grant.clientId, ['qivo:read'])
    expect((await lookup())?.access).toBe('read')
    const res = await callTool(c.t, grant.token, 'create_task', {
      project: c.f.sub.key,
      title: 'x',
    })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('insufficient_scope')
  })

  it('a write tool runs with the live grant access, so narrowing mid-request writes nothing', async () => {
    const c = await credentials()
    const grant = await c.oauth(['qivo:read', 'qivo:write'])
    const before = await c.counts()
    // The request authenticates and passes the step-up with both scopes, then
    // the grant narrows to qivo:write alone before the tool runs. That still
    // passes the per-call qivo:write check, so only the live access handed to
    // the tool, read without qivo:read, keeps it from writing.
    const spy = beforeBodyRead(() => narrowGrant(c.t, grant.clientId, ['qivo:write']))
    try {
      const res = await callTool(c.t, grant.token, 'create_task', {
        project: c.f.sub.key,
        title: 'Narrowed',
      })
      expect(spy.ran()).toBe(true)
      expect(res.status).toBe(200)
      expect(toolText(res.body)).toEqual({ text: CREDENTIAL_READS_ONLY, isError: true })
    } finally {
      spy.mockRestore()
    }
    expect(await c.counts()).toEqual(before)
  })

  it('an expired personal token gets the MCP 401 for unknown, expired or revoked tokens', async () => {
    const c = await credentials()
    const res = await callTool(c.t, c.expiredToken, 'list_projects', {})
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: MCP_AUTH_401.person })
    expect(MCP_AUTH_401.person).toBe('unknown, expired or revoked MCP token')
  })
})

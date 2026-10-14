/* get_me (MCP) and GET /v1/me (REST) say who a machine credential acts as.
 *
 * Driven over HTTP with every credential kind (personal tokens that can
 * write, only read or expire soon, OAuth grants with and without
 * qivo:write, Standard and Viewer agent keys), plus the billing pause and
 * the project creation right under each organization setting. The answer
 * must say exactly what the write gate enforces, and it never carries a
 * secret, hash or display prefix. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it, vi } from 'vitest'
import { components, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import authSchema from '../betterAuth/schema'
import { BILLING_READ_ONLY } from '../lib/billingAccess'
import type { CredentialAccess, ProjectCreators } from '../lib/enums'
import { mcpResource } from '../lib/oauth'
import { sha256hex } from '../machine/auth'
import { expectRefusal, NOW, newT, type OrgFixture, type T, uuid, withOrg } from './helpers.setup'

afterEach(() => {
  vi.unstubAllEnvs()
})

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }

async function fetchAs(
  t: T,
  path: string,
  init: FetchInit,
): Promise<{ status: number; text: string }> {
  const res = await (
    t as unknown as {
      fetch(path: string, init?: FetchInit): Promise<{ status: number; text(): Promise<string> }>
    }
  ).fetch(path, init)
  return { status: res.status, text: await res.text() }
}

/* get_me over the modern MCP leg. Answers the tool's result text, or the
 * HTTP body when the request did not reach the tool. */
async function getMe(t: T, secret: string): Promise<{ status: number; text: string }> {
  const res = await fetchAs(t, '/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'get_me',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_me',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  })
  if (res.status !== 200) return res
  const result = (JSON.parse(res.text) as { result: { content: { text: string }[] } }).result
  return { status: 200, text: result.content[0].text }
}

const restMe = (t: T, secret: string) =>
  fetchAs(t, '/v1/me', { method: 'GET', headers: { Authorization: `Bearer ${secret}` } })

const secret = (prefix: string) => `${prefix}${uuid().replace(/-/g, '')}${'0'.repeat(16)}`

async function plantToken(
  t: T,
  profile: Doc<'profiles'>,
  row: { name: string; access?: CredentialAccess; expires_at?: string },
): Promise<string> {
  const token = secret('qvt_')
  const token_hash = await sha256hex(token)
  await t.run((ctx) =>
    ctx.db.insert('mcp_tokens', {
      id: uuid(),
      profile_id: profile.id,
      token_prefix: token.slice(0, 11),
      token_hash,
      created_at: NOW,
      ...row,
    }),
  )
  return token
}

async function plantKey(t: T, agent: Doc<'profiles'>, name: string): Promise<string> {
  const key = secret('qva_')
  const key_hash = await sha256hex(key)
  await t.run((ctx) =>
    ctx.db.insert('agent_keys', {
      id: uuid(),
      profile_id: agent.id,
      name,
      key_prefix: key.slice(0, 11),
      key_hash,
      created_at: NOW,
    }),
  )
  return key
}

async function plantViewerAgent(t: T, orgId: string): Promise<Doc<'profiles'>> {
  return await t.run(async (ctx) => {
    const _id = await ctx.db.insert('profiles', {
      id: uuid(),
      org_id: orgId,
      name: 'Ledger',
      initials: 'LE',
      color: '#444444',
      org_role: 'viewer',
      active: true,
      kind: 'agent',
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'profiles'>
  })
}

/* An approved OAuth connection for `profile` named "Claude" with these
 * scopes, and one live access token for it. */
async function plantOauth(t: T, f: OrgFixture, profile: Doc<'profiles'>, scopes: string[]) {
  const authUser = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: {
        name: profile.name,
        email: profile.email!,
        emailVerified: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  })
  await t.run((ctx) => ctx.db.patch(profile._id, { auth_user_id: authUser._id as string }))
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
      profile_id: profile.id,
      org_id: f.org.id,
      auth_user_id: authUser._id as string,
      client_id: clientId,
      client_name: 'Claude',
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
  await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'oauthAccessToken',
      data: {
        token: await sha256hex(token.slice(4)),
        clientId,
        userId: authUser._id as string,
        referenceId: connectionId,
        scopes,
        expiresAt: Date.now() + 60_000,
      },
    },
  })
  return token
}

async function fixture() {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
  const f = await withOrg(t)
  return { t, f }
}

/* The organization block every caller of the withOrg fixture shares, apart
 * from the creation right. */
const orgBlock = (f: OrgFixture, can_create_projects: boolean) => ({
  id: f.org.id,
  name: 'Testbed Labs',
  slug: 'testbed',
  date_format: 'iso',
  week_start: 1,
  week_one_rule: 'first4day',
  default_plannable_hours: 40,
  max_attachment_mb: 10,
  project_creators: 'users',
  can_create_projects,
})

const NOT_PAUSED = { read_only: false, reason: null }

describe('get_me and GET /v1/me', () => {
  it('a personal token that can write answers its person, organization and token', async () => {
    const { t, f } = await fixture()
    const token = await plantToken(t, f.user, { name: 'Laptop', access: 'write' })
    const res = await getMe(t, token)
    expect(res.status).toBe(200)
    const me = JSON.parse(res.text)
    expect(me).toEqual({
      user: {
        id: f.user.id,
        name: 'user',
        org_role: 'user',
        kind: 'person',
        active: true,
        plannable_hours: 40,
        email: 'user@testbed.test',
      },
      organization: orgBlock(f, true),
      billing: NOT_PAUSED,
      credential: { kind: 'personal_token', access: 'write', expires_at: null, name: 'Laptop' },
    })
    // MCP keeps the projection's key order, pretty-printed like every tool
    expect(Object.keys(me)).toEqual(['user', 'organization', 'billing', 'credential'])
    expect(res.text).toBe(JSON.stringify(me, null, 2))
    // nothing about the secret leaves: no hash, no display prefix
    const row = await t.run((ctx) => ctx.db.query('mcp_tokens').first())
    expect(res.text).not.toContain(row!.token_hash)
    expect(res.text).not.toContain(row!.token_prefix)
  })

  it('a read-only token and a token expiring soon report their access and expiry', async () => {
    const { t, f } = await fixture()
    const reader = await plantToken(t, f.admin, { name: 'Reader', access: 'read' })
    const legacy = await plantToken(t, f.admin, { name: 'Legacy' })
    const soon = new Date(Date.now() + 60 * 60_000).toISOString()
    const expiring = await plantToken(t, f.admin, {
      name: 'Expiring',
      access: 'write',
      expires_at: soon,
    })
    const credentialOf = async (token: string) =>
      JSON.parse((await getMe(t, token)).text).credential
    expect(await credentialOf(reader)).toEqual({
      kind: 'personal_token',
      access: 'read',
      expires_at: null,
      name: 'Reader',
    })
    // a token minted before tokens carried access reads as read-only
    expect((await credentialOf(legacy)).access).toBe('read')
    expect(await credentialOf(expiring)).toEqual({
      kind: 'personal_token',
      access: 'write',
      expires_at: soon,
      name: 'Expiring',
    })
    // a read-only credential still sees its seat may create projects; the
    // write gate is the credential's access
    expect(JSON.parse((await getMe(t, reader)).text).organization.can_create_projects).toBe(true)
  })

  it('an OAuth grant names its client and has write access only with qivo:write', async () => {
    const { t, f } = await fixture()
    const writer = await plantOauth(t, f, f.user, ['qivo:read', 'qivo:write', 'offline_access'])
    const res = await getMe(t, writer)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text).credential).toEqual({
      kind: 'oauth',
      access: 'write',
      expires_at: null,
      name: 'Claude',
    })
    const { t: t2, f: f2 } = await fixture()
    const reader = await plantOauth(t2, f2, f2.user, ['qivo:read'])
    const read = await getMe(t2, reader)
    // get_me is a read, so a read-only grant gets no scope challenge
    expect(read.status).toBe(200)
    expect(JSON.parse(read.text).credential.access).toBe('read')
  })

  it('agent keys answer on both surfaces; a Viewer agent reads only', async () => {
    const { t, f } = await fixture()
    const viewerAgent = await plantViewerAgent(t, f.org.id)
    const key = await plantKey(t, f.agent, 'CI key')
    const viewerKey = await plantKey(t, viewerAgent, 'Audit key')
    const mcp = JSON.parse((await getMe(t, key)).text)
    expect(mcp).toEqual({
      user: {
        id: f.agent.id,
        name: 'Relay',
        org_role: 'user',
        kind: 'agent',
        active: true,
        plannable_hours: null,
        email: null,
      },
      // agents never create projects under any setting today
      organization: orgBlock(f, false),
      billing: NOT_PAUSED,
      credential: { kind: 'agent_key', access: 'write', expires_at: null, name: 'CI key' },
    })
    const rest = await restMe(t, key)
    expect(rest.status).toBe(200)
    expect(JSON.parse(rest.text)).toEqual(mcp)
    for (const answer of [await getMe(t, viewerKey), await restMe(t, viewerKey)]) {
      const me = JSON.parse(answer.text)
      expect(me.user).toMatchObject({ id: viewerAgent.id, org_role: 'viewer', kind: 'agent' })
      expect(me.credential).toEqual({
        kind: 'agent_key',
        access: 'read',
        expires_at: null,
        name: 'Audit key',
      })
    }
    // an agent made a Viewer after its key was looked up reads only, which
    // is what the write gate enforces on that same request
    const row = (await t.run((ctx) =>
      ctx.db
        .query('agent_keys')
        .withIndex('by_profile', (q) => q.eq('profile_id', viewerAgent.id))
        .unique(),
    ))!
    const demoted = await t.query(internal.machine.rest.getMe, {
      callerId: viewerAgent.id,
      access: 'write',
      credential: { table: 'agent_keys', id: row.id, rowId: row._id },
    })
    expect(demoted.credential.access).toBe('read')
  })

  it('reports the billing pause with the sentence writes are refused with', async () => {
    const { t, f } = await fixture()
    const key = await plantKey(t, f.agent, 'CI key')
    vi.stubEnv('BILLING_ENABLED', 'true')
    // no subscription row: billing is on and nothing pays, so editing pauses
    const me = JSON.parse((await restMe(t, key)).text)
    expect(me.billing).toEqual({ read_only: true, reason: BILLING_READ_ONLY })
    // the credential keeps its own access; the pause is reported beside it
    expect(me.credential.access).toBe('write')
    const create = await fetchAs(t, '/v1/tasks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: f.sub.key, title: 'Paused' }),
    })
    expect(create.status).toBe(403)
    expect(JSON.parse(create.text)).toEqual({ error: BILLING_READ_ONLY })
    vi.stubEnv('BILLING_ENABLED', 'false')
    expect(JSON.parse((await restMe(t, key)).text).billing).toEqual(NOT_PAUSED)
  })

  it('can_create_projects follows the organization setting for each seat', async () => {
    const { t, f } = await fixture()
    // a Standard user person with the per-person creation right
    const selected = await t.run(async (ctx) => {
      const _id = await ctx.db.insert('profiles', {
        id: uuid(),
        auth_user_id: 'auth_selected',
        org_id: f.org.id,
        email: 'selected@testbed.test',
        name: 'selected',
        initials: 'SE',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        can_create_projects: true,
        created_at: NOW,
      })
      return (await ctx.db.get(_id)) as Doc<'profiles'>
    })
    const seats = {
      admin: await plantToken(t, f.admin, { name: 'a', access: 'write' }),
      user: await plantToken(t, f.user, { name: 'u', access: 'write' }),
      selected: await plantToken(t, selected, { name: 's', access: 'write' }),
      viewer: await plantToken(t, f.viewer, { name: 'v', access: 'write' }),
      agent: await plantKey(t, f.agent, 'k'),
    }
    const expected: Record<ProjectCreators | 'unset', Record<keyof typeof seats, boolean>> = {
      unset: { admin: true, user: true, selected: true, viewer: false, agent: false },
      users: { admin: true, user: true, selected: true, viewer: false, agent: false },
      selected: { admin: true, user: false, selected: true, viewer: false, agent: false },
      admins: { admin: true, user: false, selected: false, viewer: false, agent: false },
    }
    for (const [setting, bySeat] of Object.entries(expected)) {
      await t.run((ctx) =>
        ctx.db.patch(f.org._id, {
          project_creators: setting === 'unset' ? undefined : (setting as ProjectCreators),
        }),
      )
      for (const [seat, can] of Object.entries(bySeat)) {
        const { organization } = JSON.parse(
          (await getMe(t, seats[seat as keyof typeof seats])).text,
        )
        expect(organization.project_creators, `${setting} ${seat}`).toBe(
          setting === 'unset' ? 'users' : setting,
        )
        expect(organization.can_create_projects, `${setting} ${seat}`).toBe(can)
      }
    }
  })

  it('an organization without its own upload cap reports the 20 MiB default', async () => {
    const { t, f } = await fixture()
    const key = await plantKey(t, f.agent, 'k')
    await t.run((ctx) => ctx.db.patch(f.org._id, { max_attachment_mb: undefined }))
    expect(JSON.parse((await restMe(t, key)).text).organization.max_attachment_mb).toBe(20)
  })

  it('a credential row that is gone, revoked or not the caller answers like a gone caller', async () => {
    const { t, f } = await fixture()
    await plantKey(t, f.agent, 'k')
    const key = (await t.run((ctx) => ctx.db.query('agent_keys').first()))!
    const ref = { table: 'agent_keys', id: key.id, rowId: key._id } as const
    const call = (
      credential: { table: 'agent_keys'; id: string; rowId: string },
      callerId = f.agent.id,
    ) => t.query(internal.machine.rest.getMe, { callerId, access: 'write', credential })
    expect((await call(ref)).credential.name).toBe('k')
    for (const [label, credential, callerId] of [
      ['unknown id', { ...ref, id: uuid() }, f.agent.id],
      ['another row with the id', { ...ref, rowId: 'other' }, f.agent.id],
      ['another caller', ref, f.user.id],
    ] as const) {
      const e = await expectRefusal(call(credential, callerId), 'forbidden')
      expect((e.data as { reason?: string }).reason, label).toBe('caller_gone')
    }
    await t.run((ctx) => ctx.db.patch(key._id, { revoked_at: NOW }))
    const revoked = await expectRefusal(call(ref), 'forbidden')
    expect((revoked.data as { reason?: string }).reason).toBe('caller_gone')
  })
})

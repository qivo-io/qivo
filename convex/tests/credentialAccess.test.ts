/* Credential access, the shared read/write rule of the machine surfaces
 * (lib/access.ts credentialAccess), and the gates that enforce it.
 *
 *   1. The mapping per credential kind, with its fail-closed cases.
 *   2. Personal tokens: creation and the test seam store an explicit access
 *      and a checked expiry, lookup and the per-request stamp refuse an
 *      expired token like a revoked one, and those two are the only paths
 *      that insert mcp_tokens rows.
 *   3. A static walk: every exported internal mutation and action of the
 *      machine surfaces and webhooks, plus every one the machine HTTP actions
 *      call, takes the required `access` argument or is a named exemption
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

import { describe, expect, it, vi } from 'vitest'
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
import { as, expectRefusal, NOW, newT, type T, uuid, withOrg } from './helpers.setup'

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
      }),
      'bad_request',
      /^an agent key takes no access or expiry/,
    )
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

/* Every module that can register a function, so an `internal.…` reference
 * resolves wherever its target lives. */
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
) as Record<string, Record<string, unknown>>

const machineSources = import.meta.glob('../machine/*.ts', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

/** The registered function behind a "module:export" name, if any. */
function registered(name: string): Registered | undefined {
  const [module, fn] = name.split(':')
  const value = modules[`../${module}.ts`]?.[fn] as Registered | undefined
  return value?.exportArgs === undefined ? undefined : value
}

const writes = (fn: Registered | undefined): boolean =>
  fn?.isInternal === true && (fn.isMutation === true || fn.isAction === true)

/* Every `internal.…` reference in the machine sources, as "module:export". */
function machineRefs(): string[] {
  const names = new Set<string>()
  for (const src of Object.values(machineSources)) {
    for (const [, ref] of src.matchAll(/\binternal\.((?:\w+\.)+\w+)/g)) {
      const parts = ref.split('.')
      names.add(`${parts.slice(0, -1).join('/')}:${parts.at(-1)}`)
    }
  }
  return [...names].sort()
}

/* What the walk covers: every exported internal mutation and action of the
 * machine modules and the webhook modules, plus every one the machine HTTP
 * actions call by `internal.…` reference, wherever it lives. A reference the
 * walk cannot resolve throws, so a call it cannot follow fails every test
 * that uses the walk instead of dropping out of it. */
function guarded(): string[] {
  const names = new Set<string>()
  for (const [path, mod] of Object.entries(modules)) {
    const module = path.replace(/^\.\.\//, '').replace(/\.ts$/, '')
    if (!module.startsWith('machine/') && module !== 'webhooks' && module !== 'webhookActions')
      continue
    for (const fn of Object.keys(mod)) {
      if (writes(registered(`${module}:${fn}`))) names.add(`${module}:${fn}`)
    }
  }
  for (const name of machineRefs()) {
    const fn = registered(name)
    if (fn === undefined)
      throw new Error(`machine source calls internal ${name}, which is not registered`)
    if (writes(fn)) names.add(name)
  }
  return [...names].sort()
}

/* Each exemption names why the function needs no `access` argument. */
const EXEMPT: Record<string, string> = {
  'machine/auth:touchCredential':
    'stamps last_used_at and counts usage for every authenticated request, before dispatch',
  'machine/testing:mintCredential':
    'deploy-key test seam that mints credentials, refused on production',
  'machine/testing:deleteCredential':
    'deploy-key test seam that deletes minted credentials, refused on production',
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
    const names = guarded()
    expect(names).toContain('machine/mcp:createIssue')
    expect(names).toContain('machine/rest:addComment')
    expect(names).toContain('billingMetering:ingress')
    expect(names).toContain('oauthConnections:touch')
  })

  it('every function call in the machine sources is an internal reference the walk resolves', () => {
    // A runner given anything else (a variable, makeFunctionReference, a
    // public api reference) hides its target from the walk.
    const indirect = Object.entries(machineSources).flatMap(([path, src]) =>
      [...src.matchAll(/\brun(?:Query|Mutation|Action)\(\s*(?!internal\.)([^,)]*)/g)].map(
        ([, arg]) => `${path}: ${arg.trim()}`,
      ),
    )
    expect(indirect).toEqual([])
    expect(machineRefs().filter((name) => registered(name) === undefined)).toEqual([])
    // the resolver reaches a module outside the two directories the walk owns
    expect(registered('internal/operator:provisionOperator')?.isInternal).toBe(true)
  })

  it('each one takes the required access argument or is a named exemption', () => {
    const missing: string[] = []
    for (const name of guarded()) {
      if (EXEMPT[name] !== undefined) continue
      const args = JSON.parse(registered(name)?.exportArgs?.() ?? '{}') as {
        value?: Record<string, unknown>
      }
      if (JSON.stringify(args.value?.access) !== ACCESS_ARG) missing.push(name)
    }
    expect(missing).toEqual([])
  })

  it('every exemption still names a guarded function and gives a reason', () => {
    const names = new Set(guarded())
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(names.has(name), `${name} is exempt but not guarded`).toBe(true)
      expect(reason.length, name).toBeGreaterThan(10)
    }
  })
})

/* ---------------------------------------------------------- 4. over HTTP */

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }
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
  const authUser = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: {
        name: f.user.name,
        email: f.user.email!,
        emailVerified: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  })
  await t.run((ctx) => ctx.db.patch(f.user._id, { auth_user_id: authUser._id as string }))
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
        auth_user_id: authUser._id as string,
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
          userId: authUser._id as string,
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
    const readText = Request.prototype.text
    const spy = vi.spyOn(Request.prototype, 'text').mockImplementationOnce(async function (
      this: Request,
    ) {
      await narrowGrant(c.t, grant.clientId, ['qivo:write'])
      return readText.call(this)
    })
    try {
      const res = await callTool(c.t, grant.token, 'create_task', {
        project: c.f.sub.key,
        title: 'Narrowed',
      })
      expect(spy).toHaveBeenCalled()
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

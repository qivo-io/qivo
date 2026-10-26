/* Exercise the real Better Auth HTTP handler, local component adapter, OAuth
 * provider and MCP dispatcher together. Secrets are test-only and no cloud
 * deployment is contacted. This catches integration failures that a planted
 * access-token row or mocked introspection result would conceal. */
/// <reference types="vite/client" />
import { hashPassword } from 'better-auth/crypto'
import { generateCodeChallenge } from 'better-auth/oauth2'
import { describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { MutationCtx } from '../_generated/server'
import { createAuth } from '../auth'
import * as authTriggers from '../authTriggers'
import * as adapter from '../betterAuth/adapter'
import authSchema from '../betterAuth/schema'
import { LIMITS, NAME_MAX } from '../lib/limits'
import { NO_ORGANIZATION, ORGANIZATION_GONE } from '../lib/oauth'
import { sha256hex } from '../machine/auth'
import { TOOLS } from '../machine/mcp'
import { BODY_MAX_BYTES } from '../machine/shared'
import { REMOVAL_BUDGET } from '../model/cascade'
import { notifyIssueUpdate } from '../model/messages'
import { deleteOrgStep } from '../model/orgDeletion'
import { touch as touchConnection } from '../oauthAccess'
import {
  expectRefusal,
  flushWebhookEvents,
  newT,
  plantIssue,
  plantSeat,
  runInAuth,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

declare class URLSearchParams {
  constructor(input?: string | Record<string, string>)
  get(name: string): string | null
  set(name: string, value: string): void
  append(name: string, value: string): void
  delete(name: string): void
  toString(): string
}
declare class URL {
  constructor(url: string)
  readonly origin: string
  readonly pathname: string
  readonly search: string
  readonly searchParams: URLSearchParams
}

const SITE = 'https://some.convex.site' // convex-test's actual HTTP request origin
const APP = 'http://localhost:5199'
const RESOURCE = `${SITE}/mcp`
const REDIRECT = 'https://client.example.test/callback'
const READ = 'qivo:read offline_access'
const WRITE = 'qivo:read qivo:write offline_access'
const PASSWORD = 'Hermetic OAuth password 314159!'
process.env.SITE_URL = APP
process.env.CONVEX_SITE_URL = SITE
process.env.BETTER_AUTH_SECRET = 'oauth-hermetic-secret-not-a-real-deployment-314159'

type Json = Record<string, unknown>
type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }
declare function btoa(value: string): string
const http = (t: T, path: string, init?: FetchInit): Promise<Response> =>
  (t as unknown as { fetch(path: string, init?: FetchInit): Promise<Response> }).fetch(path, init)
const json = async (response: Response): Promise<Json> => JSON.parse(await response.text())
const form = (values: Record<string, string>) => new URLSearchParams(values).toString()
const body = (values: Json) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(values),
})

async function fixture(role: 'user' | 'viewer' = 'user') {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
  const f = await withOrg(t)
  const profile = f[role]
  const now = Date.now()
  // the fixture's real Better Auth login, given a password to sign in with
  const user = { _id: profile.auth_user_id! }
  await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'account',
      data: {
        accountId: user._id,
        userId: user._id,
        providerId: 'credential',
        password: await hashPassword(PASSWORD),
        createdAt: now,
        updatedAt: now,
      },
    },
  })
  const response = await http(t, '/api/auth/sign-in/email', {
    ...body({ email: profile.email, password: PASSWORD }),
    headers: {
      'Content-Type': 'application/json',
      Origin: APP,
      'better-auth-cookie': '',
    },
  })
  const login = await json(response)
  expect(response.status, JSON.stringify(login)).toBe(200)
  const setCookie = response.headers.get('set-better-auth-cookie')
  const cookie = setCookie?.match(/(?:^|,\s*)([^=;,]*session_token=[^;]+)/)?.[1]
  expect(cookie).toBeTruthy()
  const sessionResponse = await http(t, '/api/auth/get-session', {
    headers: { Origin: APP, 'better-auth-cookie': cookie! },
  })
  const session = await json(sessionResponse)
  const sessionId = (session.session as Json).id as string
  expect((session.user as Json).id).toBe(user._id)
  return {
    t,
    ...f,
    profile,
    userId: user._id as string,
    cookie: cookie!,
    as: t.withIdentity({ subject: user._id as string, sessionId }),
  }
}
type Fx = Awaited<ReturnType<typeof fixture>>

async function register(f: Fx, scope = WRITE, clientName = 'Hermetic MCP client') {
  const response = await http(
    f.t,
    '/api/auth/oauth2/register',
    body({
      client_name: clientName,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope,
    }),
  )
  const client = await json(response)
  expect(response.status, JSON.stringify(client)).toBe(201)
  expect(client.client_id).toBeTypeOf('string')
  expect(client.client_secret).toBeUndefined()
  expect(client.token_endpoint_auth_method).toBe('none')
  return client.client_id as string
}

async function authorization(f: Fx, clientId: string, scope = WRITE) {
  const verifier = `${uuid()}${uuid()}`
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope,
    state: uuid(),
    code_challenge: await generateCodeChallenge(verifier),
    code_challenge_method: 'S256',
    resource: RESOURCE,
    prompt: 'consent',
  })
  return { f, clientId, scope, verifier, query }
}
type Authorization = Awaited<ReturnType<typeof authorization>>

function authorize(request: Authorization, authenticated = true) {
  return http(request.f.t, `/api/auth/oauth2/authorize?${request.query}`, {
    headers: {
      Accept: 'application/json',
      ...(authenticated ? { Origin: APP, 'better-auth-cookie': request.f.cookie } : {}),
    },
  })
}

async function consentPage(request: Authorization) {
  const response = await authorize(request)
  const result = await json(response)
  expect(response.status, JSON.stringify(result)).toBe(200)
  expect(result.redirect).toBe(true)
  const url = new URL(result.url as string)
  expect(url.origin).toBe(APP)
  expect(url.searchParams.get('sig')).toBeTruthy()
  return url.search.slice(1)
}

async function consent(request: Authorization, oauthQuery: string, accept = true, scope?: string) {
  return http(request.f.t, '/api/auth/oauth2/consent', {
    ...body({ accept, oauth_query: oauthQuery, ...(scope === undefined ? {} : { scope }) }),
    headers: {
      'Content-Type': 'application/json',
      Origin: APP,
      'better-auth-cookie': request.f.cookie,
    },
  })
}

async function codeFor(request: Authorization) {
  const response = await consent(request, await consentPage(request))
  const result = await json(response)
  expect(response.status, JSON.stringify(result)).toBe(200)
  const url = new URL(result.url as string)
  expect(`${url.origin}${url.pathname}`).toBe(REDIRECT)
  expect(url.searchParams.get('state')).toBe(request.query.get('state'))
  expect(url.searchParams.get('error')).toBeNull()
  const code = url.searchParams.get('code')
  expect(code).toBeTruthy()
  return code!
}

function tokenRequest(t: T, values: Record<string, string> | string) {
  return http(t, '/api/auth/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: typeof values === 'string' ? values : form(values),
  })
}

function exchange(request: Authorization, code: string, overrides: Record<string, string> = {}) {
  return tokenRequest(request.f.t, {
    grant_type: 'authorization_code',
    client_id: request.clientId,
    code,
    code_verifier: request.verifier,
    redirect_uri: REDIRECT,
    resource: RESOURCE,
    ...overrides,
  })
}

type Tokens = { access_token: string; refresh_token: string; scope: string; expires_in: number }
async function tokens(response: Response): Promise<Tokens> {
  const result = await json(response)
  expect(response.status, JSON.stringify(result)).toBe(200)
  expect(result.access_token).toMatch(/^qvo_/)
  expect(result.refresh_token).toBeTypeOf('string')
  expect(result.token_type).toBe('Bearer')
  expect(result.expires_in).toBeGreaterThan(0)
  return result as Tokens
}

async function connect(f: Fx, scope = WRITE, clientId?: string) {
  const request = await authorization(f, clientId ?? (await register(f)), scope)
  const issued = await tokens(await exchange(request, await codeFor(request)))
  return { request, ...issued }
}

function refresh(f: Fx, clientId: string, token: string, overrides: Record<string, string> = {}) {
  return tokenRequest(f.t, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: token,
    resource: RESOURCE,
    ...overrides,
  })
}

async function oauthRefusal(response: Response, errors: string[]) {
  const result = await json(response)
  expect(response.status, JSON.stringify(result)).toBeGreaterThanOrEqual(400)
  expect(response.status, JSON.stringify(result)).toBeLessThan(500)
  expect(errors, JSON.stringify(result)).toContain(result.error)
  expect(result.access_token).toBeUndefined()
  expect(result.refresh_token).toBeUndefined()
}

async function authorizationRefusal(response: Response, errors: string[]) {
  const result = await json(response)
  if (response.status === 200) {
    expect(result.redirect).toBe(true)
    const redirect = new URL(result.url as string)
    expect(errors, JSON.stringify(result)).toContain(redirect.searchParams.get('error'))
    expect(redirect.searchParams.get('code')).toBeNull()
  } else {
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(errors, JSON.stringify(result)).toContain(result.error)
  }
}

function mcp(f: Fx, token: string, name: string, args: Json = {}, modern = false) {
  return http(f.t, '/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(modern
        ? {
            'MCP-Protocol-Version': '2026-07-28',
            'Mcp-Method': 'tools/call',
            'Mcp-Name': name,
          }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        ...(modern
          ? {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'oauth-test', version: '1' },
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            }
          : {}),
      },
    }),
  })
}

async function toolResult(response: Response): Promise<Json> {
  const text = await response.text()
  expect(response.status, text).toBe(200)
  const parsed = JSON.parse(
    text.startsWith('event: message\ndata: ')
      ? text.slice('event: message\ndata: '.length).trim()
      : text,
  ) as Json
  expect(parsed.error).toBeUndefined()
  return parsed.result as Json
}

async function toolData(response: Response): Promise<unknown> {
  const result = await toolResult(response)
  expect(result.isError).not.toBe(true)
  return JSON.parse((result.content as { text: string }[])[0].text)
}

async function deniedAccess(f: Fx, accessToken: string) {
  const response = await mcp(f, accessToken, 'list_projects')
  const result = await json(response)
  expect(response.status, JSON.stringify(result)).toBe(401)
  expect(result.error).toBeTypeOf('string')
  expect(response.headers.get('www-authenticate')).toContain('resource_metadata=')
}

function signOut(f: Fx, body: Json = {}) {
  return http(f.t, '/api/auth/sign-out', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP, 'better-auth-cookie': f.cookie },
    body: JSON.stringify(body),
  })
}

/** Removes every resource link of a client, as a client registered before
 * links existed would have none. */
function unlink(f: Fx, clientId: string) {
  return runInAuth(f.t, async (ctx) => {
    for (const link of await ctx.db
      .query('oauthClientResource')
      .withIndex('clientId_resourceId', (q) => q.eq('clientId', clientId))
      .collect())
      await ctx.db.delete(link._id)
  })
}

/** Disables a client, as an operator can in Better Auth. */
function disable(f: Fx, clientId: string) {
  return runInAuth(f.t, async (ctx) => {
    const client = await ctx.db
      .query('oauthClient')
      .withIndex('clientId', (q) => q.eq('clientId', clientId))
      .unique()
    if (client) await ctx.db.patch(client._id, { disabled: true })
  })
}

/** Begins the organization's deletion, which no scheduled step runs. */
function beginDeletion(f: Fx) {
  const now = new Date().toISOString()
  return f.t.run((ctx) =>
    ctx.db.insert('org_removals', {
      org_id: f.org.id,
      reason: 'requested',
      ended_at: now,
      delete_after: now,
      phase: 'profiles',
      created_at: now,
    }),
  )
}

/** Steps the deletion in small steps until it deleted the person's grants,
 * so it stops before it is over. */
async function deleteGrants(f: Fx) {
  const connections = () =>
    f.t.run((ctx) =>
      ctx.db
        .query('oauth_connections')
        .withIndex('by_profile', (q) => q.eq('profile_id', f.profile.id))
        .collect(),
    )
  REMOVAL_BUDGET.rows = 4
  try {
    for (let i = 0; i < 50 && (await connections()).length > 0; i++)
      await f.t.run(async (ctx) => {
        const removal = await ctx.db
          .query('org_removals')
          .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
          .unique()
        if (removal) await deleteOrgStep(ctx, removal)
      })
  } finally {
    REMOVAL_BUDGET.rows = 256
  }
  expect(await connections()).toEqual([])
}

/** A DPoP proof (RFC 9449) for a token request, signed with a new P-256 key. */
async function dpopProof() {
  const base64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  const part = (value: Json) => base64url(new TextEncoder().encode(JSON.stringify(value)))
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', keys.publicKey)
  const input = `${part({ typ: 'dpop+jwt', alg: 'ES256', jwk: { kty, crv, x, y } })}.${part({
    jti: uuid(),
    htm: 'POST',
    htu: `${SITE}/api/auth/oauth2/token`,
    iat: Math.floor(Date.now() / 1000),
  })}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keys.privateKey,
    new TextEncoder().encode(input),
  )
  return `${input}.${base64url(new Uint8Array(signature))}`
}

async function initialScopes(t: T) {
  const response = await http(
    t,
    '/mcp',
    body({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  )
  const result = await json(response)
  expect(response.status, JSON.stringify(result)).toBe(401)
  const challenge = response.headers.get('www-authenticate')
  expect(challenge).toBe(
    `Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp", scope="qivo:read qivo:write offline_access"`,
  )
  return challenge!.match(/\bscope="([^"]+)"/)![1]
}

async function insufficientScope(response: Response, required: 'qivo:read' | 'qivo:write') {
  const result = await json(response)
  expect(response.status, JSON.stringify(result)).toBe(403)
  expect(result.error).toBe('insufficient_scope')
  const challenge = response.headers.get('www-authenticate')
  expect(challenge).toContain('error="insufficient_scope"')
  const scopes = challenge?.match(/\bscope="([^"]+)"/)?.[1].split(' ')
  expect(scopes).toEqual(required === 'qivo:write' ? ['qivo:read', 'qivo:write'] : ['qivo:read'])
  expect(challenge).toContain(
    `resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp"`,
  )
}

describe('OAuth provider and MCP integration', () => {
  it('marks issued credentials as uncacheable', async () => {
    const f = await fixture()
    const request = await authorization(f, await register(f))
    const response = await exchange(request, await codeFor(request))
    await tokens(response)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('pragma')).toBe('no-cache')
  })

  it('discovers the canonical resource and authorization server without a credential', async () => {
    const t = newT()
    await initialScopes(t)
    const response = await http(t, '/.well-known/oauth-protected-resource/mcp')
    const metadata = await json(response)
    expect(response.status).toBe(200)
    expect(metadata.resource).toBe(RESOURCE)
    expect(metadata.scopes_supported).toEqual(expect.arrayContaining(['qivo:read', 'qivo:write']))
    const issuer = (metadata.authorization_servers as string[])[0]
    const issuerUrl = new URL(issuer)
    expect(issuerUrl.origin).toBe(SITE)
    const discovery = await http(
      t,
      `/.well-known/oauth-authorization-server${issuerUrl.pathname === '/' ? '' : issuerUrl.pathname}`,
    )
    const server = await json(discovery)
    expect(discovery.status).toBe(200)
    expect(server.issuer).toBe(issuer)
    expect(server.code_challenge_methods_supported).toEqual(['S256'])
    expect(server.registration_endpoint).toBe(`${SITE}/api/auth/oauth2/register`)
    expect(server.token_endpoint).toBe(`${SITE}/api/auth/oauth2/token`)
  })

  it('advertises no DPoP, issues Bearer tokens to a client that sends a proof, and refuses bound tokens', async () => {
    const f = await fixture()
    for (const path of [
      '/.well-known/oauth-authorization-server/api/auth',
      '/api/auth/.well-known/oauth-authorization-server',
    ]) {
      const response = await http(f.t, path)
      const server = await json(response)
      expect(response.status, path).toBe(200)
      expect(server.token_endpoint).toBe(`${SITE}/api/auth/oauth2/token`)
      expect(server, path).not.toHaveProperty('dpop_signing_alg_values_supported')
    }
    const registered = await http(
      f.t,
      '/api/auth/oauth2/register',
      body({
        client_name: 'DPoP client',
        redirect_uris: [REDIRECT],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: WRITE,
        dpop_bound_access_tokens: true,
      }),
    )
    const client = await json(registered)
    expect(registered.status, JSON.stringify(client)).toBe(201)
    expect(client.dpop_bound_access_tokens).not.toBe(true)
    const clientId = client.client_id as string
    const keyBound = await authorization(f, clientId)
    keyBound.query.set('dpop_jkt', '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I')
    await authorizationRefusal(await authorize(keyBound), ['invalid_request'])
    const request = await authorization(f, clientId)
    const code = await codeFor(request)
    const issued = await tokens(
      await http(f.t, '/api/auth/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          DPoP: await dpopProof(),
        },
        body: form({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: request.verifier,
          redirect_uri: REDIRECT,
          resource: RESOURCE,
        }),
      }),
    )
    expect(await toolData(await mcp(f, issued.access_token, 'list_projects'))).toBeInstanceOf(Array)
    // A token bound to a key, which Qivo never issues, is refused.
    await runInAuth(f.t, async (ctx) => {
      for (const token of await ctx.db
        .query('oauthAccessToken')
        .withIndex('clientId', (q) => q.eq('clientId', clientId))
        .collect())
        await ctx.db.patch(token._id, { confirmation: JSON.stringify({ jkt: 'bound-key' }) })
    })
    await deniedAccess(f, issued.access_token)
  })

  it('advertises only public clients and no introspection on every metadata path, as the endpoints answer', async () => {
    const f = await fixture()
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/api/auth',
      '/api/auth/.well-known/oauth-authorization-server',
    ]) {
      const response = await http(f.t, path)
      const server = await json(response)
      expect(response.status, path).toBe(200)
      expect(server.token_endpoint_auth_methods_supported, path).toEqual(['none'])
      expect(server.revocation_endpoint, path).toBe(`${SITE}/api/auth/oauth2/revoke`)
      expect(server.revocation_endpoint_auth_methods_supported, path).toEqual(['none'])
      for (const field of [
        'introspection_endpoint',
        'introspection_endpoint_auth_methods_supported',
        'introspection_endpoint_auth_signing_alg_values_supported',
        'token_endpoint_auth_signing_alg_values_supported',
        'revocation_endpoint_auth_signing_alg_values_supported',
      ])
        expect(server, path).not.toHaveProperty(field)
    }
    // A registration that asks for a secret gets a public client.
    const registered = await http(
      f.t,
      '/api/auth/oauth2/register',
      body({
        client_name: 'Secret seeker',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'client_secret_basic',
        scope: WRITE,
      }),
    )
    const asked = await json(registered)
    expect(registered.status, JSON.stringify(asked)).toBe(201)
    expect(asked.token_endpoint_auth_method).toBe('none')
    expect(asked.client_secret).toBeUndefined()
    // Even a confidential client, which only the server API can create, is
    // refused when it authenticates with its secret, by either method.
    const confidential: Json = {
      ...(await f.t.run((ctx) =>
        createAuth(ctx).api.createOAuthClient({
          body: {
            client_name: 'Confidential client',
            redirect_uris: [REDIRECT],
            token_endpoint_auth_method: 'client_secret_basic',
            scope: WRITE,
            grant_types: ['authorization_code', 'refresh_token'],
          },
          headers: new Headers({ cookie: f.cookie }),
        }),
      )),
    }
    expect(confidential.client_secret).toBeTypeOf('string')
    const basic = `Basic ${btoa(`${confidential.client_id}:${confidential.client_secret}`)}`
    const c = await connect(f)
    const authenticated = (path: string, values: Record<string, string>, authorization?: string) =>
      http(f.t, path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: form(values),
      })
    for (const [path, values] of [
      [
        '/api/auth/oauth2/token',
        { grant_type: 'refresh_token', refresh_token: 'qvr_unknown', resource: RESOURCE },
      ],
      ['/api/auth/oauth2/revoke', { token: c.access_token, token_type_hint: 'access_token' }],
    ] as const) {
      for (const [extra, authorization] of [
        [{}, basic],
        [
          {
            client_id: confidential.client_id as string,
            client_secret: confidential.client_secret as string,
          },
          undefined,
        ],
      ] as const) {
        const response = await authenticated(path, { ...values, ...extra }, authorization)
        const result = await json(response)
        // A client that tried Basic gets its challenge (RFC 6749 section 5.2).
        expect(response.status, `${path} ${JSON.stringify(result)}`).toBe(authorization ? 401 : 400)
        expect(response.headers.get('www-authenticate'), path).toBe(authorization ? 'Basic' : null)
        expect(result.error, path).toBe('invalid_client')
      }
    }
    expect(await toolData(await mcp(f, c.access_token, 'list_projects'))).toBeInstanceOf(Array)
    // The public client revokes its own token with its client_id alone.
    const revoked = await authenticated('/api/auth/oauth2/revoke', {
      client_id: c.request.clientId,
      token: c.access_token,
      token_type_hint: 'access_token',
    })
    expect(revoked.status, await revoked.clone().text()).toBe(200)
    await deniedAccess(f, c.access_token)
    // Qivo serves no introspection endpoint.
    const introspected = await authenticated('/api/auth/oauth2/introspect', {
      client_id: c.request.clientId,
      token: c.refresh_token,
    })
    expect(introspected.status).toBe(404)
  })

  it('refuses every other client authentication at token and revoke, and reads empty values as none', async () => {
    const f = await fixture()
    const c = await connect(f)
    const post = (path: string, values: Record<string, string>, authorization?: string) =>
      http(f.t, path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(authorization === undefined ? {} : { Authorization: authorization }),
        },
        body: form(values),
      })
    const revoke = { client_id: c.request.clientId, token: c.access_token }
    for (const path of ['/api/auth/oauth2/token', '/api/auth/oauth2/revoke']) {
      const values =
        path === '/api/auth/oauth2/token'
          ? {
              grant_type: 'refresh_token',
              refresh_token: 'qvr_unknown',
              client_id: c.request.clientId,
            }
          : revoke
      const bearer = await post(path, values, 'Bearer some-token')
      expect(bearer.status, path).toBe(401)
      expect(bearer.headers.get('www-authenticate'), path).toBe('Bearer')
      expect((await json(bearer)).error, path).toBe('invalid_client')
      const malformed = await post(path, values, '=abc def')
      expect(malformed.status, path).toBe(400)
      expect(malformed.headers.get('www-authenticate'), path).toBeNull()
      expect((await json(malformed)).error, path).toBe('invalid_request')
      const assertion = await post(path, {
        ...values,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: 'a.b.c',
      })
      expect(assertion.status, path).toBe(400)
      expect((await json(assertion)).error, path).toBe('invalid_client')
    }
    // An empty header and an empty secret send no authentication.
    const revoked = await post('/api/auth/oauth2/revoke', { ...revoke, client_secret: '' }, '')
    expect(revoked.status, await revoked.clone().text()).toBe(200)
    await deniedAccess(f, c.access_token)
  })

  it('uses discovered scopes for DCR, S256 consent, task planning and rotating refresh', async () => {
    const f = await fixture()
    // A client follows the initial challenge; hard-coding WRITE here would
    // conceal a discovery default that silently creates read-only connections.
    const scopes = await initialScopes(f.t)
    const c = await connect(f, scopes, await register(f, scopes))
    expect(c.scope.split(' ').sort()).toEqual(scopes.split(' ').sort())
    const connections = await f.as.query(api.oauthConnections.list, {})
    expect(connections).toHaveLength(1)
    for (const model of ['oauthAccessToken', 'oauthRefreshToken'] as const) {
      const stored = await f.t.query(components.betterAuth.adapter.findOne, {
        model,
        where: [{ field: 'clientId', value: c.request.clientId }],
      })
      expect(stored?.referenceId).toBe(connections[0].id)
      expect(stored?.token).toBeTypeOf('string')
      expect(stored?.token?.length).toBeGreaterThan(0)
      expect(c.access_token).not.toContain(stored!.token)
      expect(c.refresh_token).not.toContain(stored!.token)
    }
    let plannedTaskId = ''
    for (const modern of [false, true]) {
      const created = (await toolData(
        await mcp(
          f,
          c.access_token,
          'create_task',
          {
            project: f.sub.id,
            title: `OAuth ${modern ? 'modern' : 'legacy'} task`,
          },
          modern,
        ),
      )) as { id: string; key: string }
      expect(created.id).toBeTruthy()
      const found = (await toolData(
        await mcp(f, c.access_token, 'get_task', { ref: created.id }, modern),
      )) as Json
      expect(found.title).toBe(`OAuth ${modern ? 'modern' : 'legacy'} task`)
      const plan = {
        status: 'progress',
        priority: 'high',
        assignee_id: f.profile.id,
        due_date: '2026-09-30',
        remaining_hours: 5.5,
      }
      await toolData(
        await mcp(f, c.access_token, 'update_task', { ref: created.id, ...plan }, modern),
      )
      const planned = await toolData(
        await mcp(f, c.access_token, 'get_task', { ref: created.id }, modern),
      )
      expect(planned).toMatchObject(plan)
      plannedTaskId = created.id
    }
    const renewed = await tokens(await refresh(f, c.request.clientId, c.refresh_token))
    expect(renewed.access_token).not.toBe(c.access_token)
    expect(renewed.refresh_token).not.toBe(c.refresh_token)
    expect(await toolData(await mcp(f, renewed.access_token, 'list_projects'))).toBeInstanceOf(
      Array,
    )
    await toolData(
      await mcp(f, renewed.access_token, 'update_task', { ref: plannedTaskId, remaining_hours: 3 }),
    )
    expect(
      await toolData(await mcp(f, renewed.access_token, 'get_task', { ref: plannedTaskId })),
    ).toMatchObject({ remaining_hours: 3 })
  })

  it('rejects read-only writes on both MCP protocols and OAuth credentials on REST', async () => {
    const f = await fixture()
    const task = await plantIssue(f.t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Unchanged',
    })
    const c = await connect(f, READ)
    // Every tool whose flag is not exactly 'read', so this list and the read
    // tools of the next test together cover every tool. Valid arguments make
    // a missed challenge visible in the unchanged task below. The challenge
    // comes before argument checks, so a tool missing here is called with none.
    const valid: Record<string, Json> = {
      create_task: { project: f.sub.id, title: 'Forbidden' },
      update_task: { ref: task.id, title: 'Forbidden' },
      delete_task: { ref: task.id },
      add_comment: { ref: task.id, body: 'Forbidden' },
      update_user: { user_id: f.profile.id, plannable_hours: 1 },
    }
    const writes: [string, Json][] = TOOLS.filter((tool) => tool.access !== 'read').map((tool) => [
      tool.def.name,
      valid[tool.def.name] ?? {},
    ])
    expect(writes.length).toBeGreaterThan(0)
    for (const modern of [false, true]) {
      expect(
        (
          (await toolData(
            await mcp(f, c.access_token, 'get_task', { ref: task.id }, modern),
          )) as Json
        ).title,
      ).toBe('Unchanged')
      for (const [name, args] of writes) {
        await insufficientScope(await mcp(f, c.access_token, name, args, modern), 'qivo:write')
      }
    }
    const after = await f.t.run(async (ctx) => ({
      task: await ctx.db.get(task._id),
      comments: await ctx.db.query('comments').collect(),
    }))
    expect(after.task?.title).toBe('Unchanged')
    expect(after.comments).toEqual([])
    const rest = await http(f.t, '/v1/tasks', {
      headers: { Authorization: `Bearer ${c.access_token}` },
    })
    expect(rest.status).toBe(401)
    expect((await json(rest)).error).toMatch(/missing agent key/)
  })

  it('lets a read-only grant call every read tool on both MCP protocols', async () => {
    const f = await fixture()
    const task = await plantIssue(f.t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Readable',
    })
    const c = await connect(f, READ)
    const args: Record<string, Json> = {
      list_project_users: { project: f.sub.id },
      get_project: { project: f.sub.id },
      get_task: { ref: task.id },
      list_comments: { ref: task.id },
      list_task_activity: { ref: task.id },
    }
    const reads = TOOLS.filter((tool) => tool.access === 'read')
    expect(reads.length).toBeGreaterThan(0)
    for (const modern of [false, true]) {
      for (const tool of reads) {
        // toolData fails on the 403 challenge and on an isError scope refusal
        await toolData(
          await mcp(f, c.access_token, tool.def.name, args[tool.def.name] ?? {}, modern),
        )
      }
    }
  })

  it('requests read scope for MCP discovery and catches write calls inside batches', async () => {
    const f = await fixture()
    const c = await connect(f, READ)
    const request = (messages: unknown, extra: Record<string, string> = {}) =>
      http(f.t, '/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${c.access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...extra,
        },
        body: JSON.stringify(messages),
      })
    await insufficientScope(
      await request([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_projects', arguments: {} },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'create_task',
            arguments: { project: f.sub.id, title: 'Forbidden batch write' },
          },
        },
      ]),
      'qivo:write',
    )
    // A persisted token can have less scope than its original consent. Auth
    // must challenge discovery too, rather than assuming every known qvo_ has read.
    await f.t.mutation(components.betterAuth.adapter.updateMany, {
      input: {
        model: 'oauthAccessToken',
        where: [{ field: 'clientId', value: c.request.clientId }],
        update: { scopes: ['offline_access'] },
      },
      paginationOpts: { numItems: 100, cursor: null },
    })
    for (const modern of [false, true]) {
      await insufficientScope(
        await request(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: modern
              ? {
                  _meta: {
                    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                    'io.modelcontextprotocol/clientInfo': { name: 'oauth-test', version: '1' },
                    'io.modelcontextprotocol/clientCapabilities': {},
                  },
                }
              : {},
          },
          modern ? { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' } : {},
        ),
        'qivo:read',
      )
    }
  })

  it('rejects scope expansion and preserves current project permissions', async () => {
    const f = await fixture('viewer')
    const c = await connect(f, READ)
    await oauthRefusal(await refresh(f, c.request.clientId, c.refresh_token, { scope: WRITE }), [
      'invalid_scope',
      'invalid_grant',
    ])
    const writeGrant = await connect(f, WRITE)
    const result = await toolResult(
      await mcp(f, writeGrant.access_token, 'create_task', {
        project: f.sub.id,
        title: 'Viewer write',
      }),
    )
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/write|viewer/i)
    const hidden = await toolResult(
      await mcp(f, writeGrant.access_token, 'list_tasks', { project: f.hidden.id }),
    )
    expect(hidden.isError).toBe(true)
    expect(JSON.stringify(hidden.content)).toMatch(/not found|not visible/i)
  })
})

describe('OAuth consent and resource binding', () => {
  it('runs the public-client prelogin for the consent page in-process only', async () => {
    const f = await fixture()
    const request = await authorization(f, await register(f))
    const oauthQuery = await consentPage(request)
    // The provider refuses this call unless allowPublicClientPrelogin is on.
    const context = await f.as.mutation(api.oauthConnections.getContext, {
      oauth_query: oauthQuery,
    })
    expect(context.resource).toBe(RESOURCE)
    const response = await http(f.t, '/api/auth/oauth2/public-client-prelogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP },
      body: JSON.stringify({ client_id: request.clientId, oauth_query: oauthQuery }),
    })
    expect(response.status).toBe(404)
  })

  it('defaults an omitted resource to the same canonical MCP grant throughout authorization and refresh', async () => {
    const f = await fixture()
    const request = await authorization(f, await register(f))
    request.query.delete('resource')
    const oauthQuery = await consentPage(request)
    const context = await f.as.mutation(api.oauthConnections.getContext, {
      oauth_query: oauthQuery,
    })
    expect(context.resource).toBe(RESOURCE)
    const consentResult = await json(await consent(request, oauthQuery))
    const issued = await tokens(
      await tokenRequest(f.t, {
        grant_type: 'authorization_code',
        client_id: request.clientId,
        code: new URL(consentResult.url as string).searchParams.get('code')!,
        code_verifier: request.verifier,
        redirect_uri: REDIRECT,
      }),
    )
    const renewed = await tokens(
      await tokenRequest(f.t, {
        grant_type: 'refresh_token',
        client_id: request.clientId,
        refresh_token: issued.refresh_token,
      }),
    )
    const grants = await f.t.run((ctx) => ctx.db.query('oauth_connections').collect())
    expect(grants).toHaveLength(1)
    expect(grants[0].resource).toBe(RESOURCE)
    expect(await toolData(await mcp(f, renewed.access_token, 'list_projects'))).toBeInstanceOf(
      Array,
    )
    await oauthRefusal(
      await refresh(f, request.clientId, renewed.refresh_token, {
        resource: 'https://foreign.example.test/mcp',
      }),
      ['invalid_target', 'invalid_request', 'invalid_grant'],
    )
  })

  it('continues password login to signed consent using the real cross-domain cookie transport', async () => {
    const f = await fixture()
    const request = await authorization(f, await register(f))
    const loginResult = await json(await authorize(request, false))
    const loginUrl = new URL(loginResult.url as string)
    expect(loginUrl.origin).toBe(APP)
    expect(loginUrl.searchParams.get('sig')).toBeTruthy()
    const response = await http(f.t, '/api/auth/sign-in/email', {
      ...body({
        email: f.profile.email,
        password: PASSWORD,
        oauth_query: loginUrl.search.slice(1),
      }),
      headers: { 'Content-Type': 'application/json', Origin: APP, 'better-auth-cookie': '' },
    })
    const result = await json(response)
    expect(response.status, JSON.stringify(result)).toBe(200)
    expect(result.redirect).toBe(true)
    const consentUrl = new URL(result.url as string)
    expect(consentUrl.origin).toBe(APP)
    expect(consentUrl.searchParams.get('sig')).toBeTruthy()
    const cookie = response.headers
      .get('set-better-auth-cookie')
      ?.match(/(?:^|,\s*)([^=;,]*session_token=[^;]+)/)?.[1]
    expect(cookie).toBeTruthy()
    f.cookie = cookie!
    const approved = await json(await consent(request, consentUrl.search.slice(1)))
    const issued = await tokens(
      await exchange(request, new URL(approved.url as string).searchParams.get('code')!),
    )
    expect(await toolData(await mcp(f, issued.access_token, 'list_projects'))).toBeInstanceOf(Array)
  })

  it('rejects foreign or repeated resources before authorization parameters can be stripped by the provider', async () => {
    const f = await fixture()
    const clientId = await register(f)
    for (const resources of [
      ['https://foreign.example.test/mcp'],
      [RESOURCE, 'https://foreign.example.test/mcp'],
      [RESOURCE, RESOURCE],
    ]) {
      const request = await authorization(f, clientId)
      request.query.delete('resource')
      for (const resource of resources) request.query.append('resource', resource)
      await authorizationRefusal(await authorize(request), ['invalid_target', 'invalid_request'])
    }
    expect(await f.as.query(api.oauthConnections.list, {})).toEqual([])
  })

  it('rejects substituted and duplicated resources during code exchange', async () => {
    const f = await fixture()
    const clientId = await register(f)
    for (const resources of [
      ['https://foreign.example.test/mcp'],
      [RESOURCE, 'https://foreign.example.test/mcp'],
      [RESOURCE, RESOURCE],
    ]) {
      const request = await authorization(f, clientId)
      const code = await codeFor(request)
      const values = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: request.verifier,
        redirect_uri: REDIRECT,
      })
      for (const resource of resources) values.append('resource', resource)
      await oauthRefusal(await tokenRequest(f.t, values.toString()), [
        'invalid_target',
        'invalid_request',
        'invalid_grant',
      ])
    }
  })

  it('rejects substituted and duplicated resources during refresh', async () => {
    const f = await fixture()
    for (const resources of [
      ['https://foreign.example.test/mcp'],
      [RESOURCE, 'https://foreign.example.test/mcp'],
      [RESOURCE, RESOURCE],
    ]) {
      const c = await connect(f)
      const values = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: c.request.clientId,
        refresh_token: c.refresh_token,
      })
      for (const resource of resources) values.append('resource', resource)
      await oauthRefusal(await tokenRequest(f.t, values.toString()), [
        'invalid_target',
        'invalid_request',
        'invalid_grant',
      ])
    }
  })

  it('refuses a client without its resource link, and every other resource for a linked one', async () => {
    const f = await fixture()
    // A second resource Better Auth knows, which no client is linked to.
    const OTHER = 'https://other.example.test/api'
    await runInAuth(f.t, (ctx) =>
      ctx.db.insert('oauthResource', { identifier: OTHER, name: 'Other service' }),
    )
    const linked = await connect(f)
    const clientId = linked.request.clientId
    const foreign = await authorization(f, clientId)
    foreign.query.set('resource', OTHER)
    await authorizationRefusal(await authorize(foreign), ['invalid_target', 'invalid_request'])
    const request = await authorization(f, clientId)
    const code = await codeFor(request)
    await oauthRefusal(await exchange(request, code, { resource: OTHER }), [
      'invalid_target',
      'invalid_request',
      'invalid_grant',
    ])
    await oauthRefusal(await refresh(f, clientId, linked.refresh_token, { resource: OTHER }), [
      'invalid_target',
      'invalid_request',
      'invalid_grant',
    ])
    // The refusals consumed nothing: the grant still renews for the MCP resource.
    const renewed = await tokens(await refresh(f, clientId, linked.refresh_token))
    expect(await toolData(await mcp(f, renewed.access_token, 'list_projects'))).toBeInstanceOf(
      Array,
    )
    // Without its link, the same client may not authorize, exchange a code
    // or refresh for the MCP resource.
    const pending = await authorization(f, clientId)
    const pendingCode = await codeFor(pending)
    await unlink(f, clientId)
    await authorizationRefusal(await authorize(await authorization(f, clientId)), [
      'invalid_target',
    ])
    // Leaving out the resource means the MCP resource, so it is refused too.
    const omitted = await authorization(f, clientId)
    omitted.query.delete('resource')
    await authorizationRefusal(await authorize(omitted), ['invalid_target'])
    await oauthRefusal(await exchange(pending, pendingCode), ['invalid_target'])
    await oauthRefusal(await refresh(f, clientId, renewed.refresh_token), ['invalid_target'])
  })

  it('refuses an access token at once when its client loses the resource link', async () => {
    const f = await fixture()
    const linked = await connect(f)
    const clientId = linked.request.clientId
    expect(await toolData(await mcp(f, linked.access_token, 'list_projects'))).toBeInstanceOf(Array)
    await unlink(f, clientId)
    await deniedAccess(f, linked.access_token)
    // a link to another resource does not stand in for the MCP one
    await runInAuth(f.t, (ctx) =>
      ctx.db.insert('oauthClientResource', {
        clientId,
        resourceId: 'https://other.example.test/api',
      }),
    )
    await deniedAccess(f, linked.access_token)
  })

  it.each([
    ['its client loses the resource link', 'link', 'Credential is no longer valid'],
    ['its client is disabled', 'disable', 'Credential is no longer valid'],
    ['its organization deletion begins', 'deletion', 'this organization is being deleted'],
  ] as const)(
    "stops a grant's webhook ownership, deliveries and events when %s",
    async (_, how, refusal) => {
      const f = await fixture()
      const c = await connect(f, READ)
      const grant = await f.t.query(internal.oauthAccess.lookupAccess, {
        tokenHash: await sha256hex(c.access_token.slice(4)),
        resource: RESOURCE,
      })
      const owner = {
        profile_id: grant!.profileId,
        credential_table: 'oauth_connections' as const,
        credential_id: grant!.connectionId,
        credential_row_id: grant!.connectionRowId,
      }
      await f.t.mutation(internal.webhooks.save, {
        owner,
        id: uuid(),
        name: 'task.updated',
        filters: {},
        url: 'https://receiver.example/events',
        encrypted_secret: 'encrypted-test-key',
      })
      const issue = await plantIssue(f.t, { org_id: f.org.id, project_id: f.sub.id })
      const retitle = async (title: string) => {
        await f.t.run(async (ctx) => {
          const before = (await ctx.db.get(issue._id))!
          await ctx.db.patch(issue._id, { title })
          const after = (await ctx.db.get(issue._id))!
          await notifyIssueUpdate(ctx, {
            before,
            after,
            actor: f.admin,
            now: new Date().toISOString(),
          })
        })
        await flushWebhookEvents(f.t)
      }
      const deliveries = () => f.t.run((ctx) => ctx.db.query('webhook_deliveries').collect())
      await retitle('Queued while linked')
      const [queued] = await deliveries()
      expect(queued?.status).toBe('pending')

      if (how === 'link') await unlink(f, c.request.clientId)
      else if (how === 'disable') await disable(f, c.request.clientId)
      else await beginDeletion(f)
      // subscribing and listing (eventOwner), delivery and each event's
      // fan-out (eventOwnerProfile) all refuse the grant, as /mcp does
      if (how !== 'deletion') await deniedAccess(f, c.access_token)
      const listed = await f.t.query(internal.webhooks.list, { owner }).then(
        () => 'listed',
        (error: unknown) => (error as { data?: { message?: string } }).data?.message,
      )
      const claimed = await f.t.mutation(internal.webhooks.claim, { id: queued.id })
      await retitle('Changed after that')
      expect({ listed, claimed, deliveries: (await deliveries()).map((d) => d.status) }).toEqual({
        listed: refusal,
        claimed: null,
        deliveries: ['failed'],
      })
    },
  )

  it('refuses a grant its organization deletion deleted with the deletion, on MCP and REST', async () => {
    const f = await fixture()
    const c = await connect(f, READ)
    await beginDeletion(f)
    await deleteGrants(f)
    const deleting = [403, { error: 'this organization is being deleted' }]
    const viaMcp = await mcp(f, c.access_token, 'list_projects')
    expect([viaMcp.status, await json(viaMcp)]).toEqual(deleting)
    const viaRest = await http(f.t, '/v1/webhooks', {
      headers: { Authorization: `Bearer ${c.access_token}` },
    })
    expect([viaRest.status, await json(viaRest)]).toEqual(deleting)
    // a token that never worked stays an invalid one
    await deniedAccess(f, `qvo_${'0'.repeat(40)}`)
  })

  it('says the deletion only to a grant nothing else stopped, before and after the deletion deletes it', async () => {
    const f = await fixture()
    const kept = await connect(f, READ)
    const second = await register(f, READ, 'Second MCP client')
    const disabled = await connect(f, READ, second)
    const deleting = [403, { error: 'this organization is being deleted' }]
    const answer = async (token: string) => {
      const response = await mcp(f, token, 'list_projects')
      return [response.status, await json(response)]
    }
    await beginDeletion(f)
    await disable(f, second)
    // the member was deactivated, which the deletion stops first; the
    // disabled client's grant stays an invalid one
    await f.t.run((ctx) => ctx.db.patch(f.profile._id, { active: false }))
    expect(await answer(kept.access_token)).toEqual(deleting)
    await deniedAccess(f, disabled.access_token)
    await deleteGrants(f)
    expect(await answer(kept.access_token)).toEqual(deleting)
    await deniedAccess(f, disabled.access_token)
    // the browser session that approved it ended, so the deleted grant's
    // token is invalid, as without the deletion
    expect((await signOut(f)).status).toBe(200)
    await deniedAccess(f, kept.access_token)
  })

  it('says the deletion to a grant it deleted between the lookup and the stamp', async () => {
    const f = await fixture()
    const c = await connect(f, READ)
    await beginDeletion(f)
    const handler = touchConnection as unknown as {
      _handler: (ctx: MutationCtx, args: { id: string }) => Promise<unknown>
    }
    const original = handler._handler
    // the deletion's step runs between the two, deleting the grant and
    // recording it, or the grant went unrecorded, as at a disconnect
    let record = true
    const stamp = vi.spyOn(handler, '_handler').mockImplementation(async (ctx, args) => {
      const row = await ctx.db
        .query('oauth_connections')
        .withIndex('by_uuid', (q) => q.eq('id', args.id))
        .unique()
      if (row) {
        await ctx.db.delete(row._id)
        if (record)
          await ctx.db.insert('removed_access', {
            org_id: row.org_id,
            kind: 'oauth_connections',
            key: row.id,
          })
      }
      return original(ctx, args)
    })
    try {
      const viaMcp = await mcp(f, c.access_token, 'list_projects')
      expect([viaMcp.status, await json(viaMcp)]).toEqual([
        403,
        { error: 'this organization is being deleted' },
      ])
      const again = await connect(f, READ)
      record = false
      const viaRest = await http(f.t, '/v1/webhooks', {
        headers: { Authorization: `Bearer ${again.access_token}` },
      })
      expect([viaRest.status, await json(viaRest)]).toEqual([
        401,
        { error: 'OAuth connection is invalid, expired or disconnected' },
      ])
    } finally {
      stamp.mockRestore()
    }
  })

  it('requires S256 PKCE and refuses signed consent query tampering and scope expansion', async () => {
    const f = await fixture()
    const clientId = await register(f)
    const missing = await authorization(f, clientId)
    missing.query.delete('code_challenge')
    missing.query.delete('code_challenge_method')
    await authorizationRefusal(await authorize(missing), ['invalid_request'])
    const plain = await authorization(f, clientId)
    plain.query.set('code_challenge_method', 'plain')
    const plainResponse = await authorize(plain)
    expect(plainResponse.status).toBe(400)
    expect(await plainResponse.text()).toMatch(/S256|invalid_request|validation/i)

    const request = await authorization(f, clientId, READ)
    const oauthQuery = await consentPage(request)
    const tampered = new URLSearchParams(oauthQuery)
    tampered.set('scope', WRITE)
    await oauthRefusal(await consent(request, tampered.toString()), [
      'invalid_signature',
      'invalid_request',
    ])
    await oauthRefusal(await consent(request, oauthQuery, true, WRITE), [
      'invalid_request',
      'invalid_scope',
    ])
    const denied = await consent(request, oauthQuery, false)
    await authorizationRefusal(denied, ['access_denied'])
    expect(await f.as.query(api.oauthConnections.list, {})).toEqual([])
  })

  it('refuses bad code verifiers, client substitutions, redirect substitutions and consumed codes', async () => {
    const f = await fixture()
    const clientId = await register(f)
    const otherClient = await register(f)
    const changes: Record<string, string>[] = [
      { code_verifier: 'incorrect-verifier-with-enough-characters-1234567890' },
      { client_id: otherClient },
      { redirect_uri: 'https://foreign.example.test/callback' },
    ]
    for (const change of changes) {
      const request = await authorization(f, clientId)
      await oauthRefusal(await exchange(request, await codeFor(request), change), [
        'invalid_grant',
        'invalid_request',
        'invalid_client',
      ])
    }
    const request = await authorization(f, clientId)
    const code = await codeFor(request)
    await tokens(await exchange(request, code))
    await oauthRefusal(await exchange(request, code), ['invalid_grant'])
  })

  it('keeps same-client tabs and home-organization grants independent', async () => {
    const f = await fixture()
    await plantSeat(f.t, {
      org_id: f.otherOrg.id,
      auth_user_id: f.userId,
      org_role: 'guest',
      email: f.profile.email,
    })
    const clientId = await register(f)
    const first = await authorization(f, clientId)
    const second = await authorization(f, clientId)
    const firstQuery = await consentPage(first)
    const secondQuery = await consentPage(second)
    const context = await f.as.mutation(api.oauthConnections.getContext, {
      oauth_query: firstQuery,
    })
    expect(context.profileId).toBe(f.profile.id)
    expect(context.orgId).toBe(f.org.id)
    expect(context.resource).toBe(RESOURCE)
    // Approve in reverse order, the ordering that exposes "latest pending
    // connection for this user/client" lookups instead of transaction binding.
    const secondResult = await json(await consent(second, secondQuery))
    const firstResult = await json(await consent(first, firstQuery))
    const secondTokens = await tokens(
      await exchange(second, new URL(secondResult.url as string).searchParams.get('code')!),
    )
    const firstTokens = await tokens(
      await exchange(first, new URL(firstResult.url as string).searchParams.get('code')!),
    )
    const connections = await f.as.query(api.oauthConnections.list, {})
    expect(connections).toHaveLength(2)
    expect(new Set(connections.map((connection) => connection.id)).size).toBe(2)
    expect(
      connections.every(
        (connection) => connection.profileId === f.profile.id && connection.orgId === f.org.id,
      ),
    ).toBe(true)
    for (const token of [firstTokens.access_token, secondTokens.access_token]) {
      const projects = (await toolData(await mcp(f, token, 'list_projects'))) as Json[]
      expect(projects.some((project) => project.id === f.otherProject.id)).toBe(false)
    }
  })
})

describe('OAuth client names and request bodies', () => {
  it('cuts a long registered name to 80 characters on the consent screen and in stored connections', async () => {
    const f = await fixture()
    const clientId = await register(f, WRITE, `  Spoof\n\n${'x'.repeat(5_000)}  `)
    const cut = `Spoof ${'x'.repeat(NAME_MAX - 6)}…`
    expect(cut).toHaveLength(NAME_MAX + 1)
    // the consent page reads the context first, which stores the connection
    const request = await authorization(f, clientId)
    const oauthQuery = await consentPage(request)
    const context = await f.as.mutation(api.oauthConnections.getContext, {
      oauth_query: oauthQuery,
    })
    expect(context.clientName).toBe(cut)
    expect((await consent(request, oauthQuery)).status).toBe(200)
    // approving without that read stores the connection at consent instead
    await connect(f, WRITE, clientId)
    const connections = await f.as.query(api.oauthConnections.list, {})
    expect(connections.map((connection) => connection.clientName)).toEqual([cut, cut])
  })

  it('answers 413 to an OAuth MCP body over 1 MiB, after authentication', async () => {
    const f = await fixture()
    const c = await connect(f)
    const call = (token: string) =>
      http(f.t, '/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: `{"jsonrpc":"2.0","id":1,"method":"tools/list"}${' '.repeat(BODY_MAX_BYTES)}`,
      })
    const over = await call(c.access_token)
    expect(over.status).toBe(413)
    expect(await json(over)).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: `Bad Request: ${LIMITS.requestBody.refusal}` },
      id: null,
    })
    expect((await call('qvo_unknown')).status).toBe(401)
  })
})

describe('OAuth organization selection', () => {
  it('refuses consent for a person in no organization, naming why and what to do, and stores nothing', async () => {
    const f = await fixture()
    const request = await authorization(f, await register(f))
    const oauthQuery = await consentPage(request)
    // the person's only seat goes away before they approve
    await f.t.run((ctx) => ctx.db.patch(f.profile._id, { active: false }))
    const response = await consent(request, oauthQuery)
    const result = await json(response)
    expect(response.status, JSON.stringify(result)).toBe(403)
    expect(result.error).toBe('access_denied')
    expect(result.error_description).toBe(NO_ORGANIZATION)
    expect(result.url).toBeUndefined()
    expect(await f.t.run((ctx) => ctx.db.query('oauth_connections').collect())).toEqual([])
    // the connect page says the same before the person can approve
    await expectRefusal(
      f.as.mutation(api.oauthConnections.getContext, { oauth_query: oauthQuery }),
      'forbidden',
      /belongs to no organization yet\. Create an organization or accept an invitation/,
    )
  })

  it('sends a login in no organization to the connect page, which says why, and stores nothing', async () => {
    const f = await fixture()
    // most apps ask without prompt=consent, so the provider asks for the
    // connection's reference before it looks for an earlier consent
    const request = await authorization(f, await register(f))
    request.query.delete('prompt')
    await f.t.run((ctx) => ctx.db.patch(f.profile._id, { active: false }))
    const loginUrl = new URL((await json(await authorize(request, false))).url as string)
    // a password sign-in on the connect page resumes the authorization
    const response = await http(f.t, '/api/auth/sign-in/email', {
      ...body({
        email: f.profile.email,
        password: PASSWORD,
        oauth_query: loginUrl.search.slice(1),
      }),
      headers: { 'Content-Type': 'application/json', Origin: APP, 'better-auth-cookie': '' },
    })
    const result = await json(response)
    expect(response.status, JSON.stringify(result)).toBe(200)
    expect(result.redirect).toBe(true)
    // so does an app that asks while the login is signed in
    const oauthQuery = await consentPage(request)
    for (const url of [result.url as string, `${APP}/?${oauthQuery}`]) {
      expect(new URL(url).origin).toBe(APP)
      await expectRefusal(
        f.as.mutation(api.oauthConnections.getContext, {
          oauth_query: new URL(url).search.slice(1),
        }),
        'forbidden',
        /belongs to no organization yet\. Create an organization or accept an invitation/,
      )
    }
    const refused = await consent(request, oauthQuery)
    expect(refused.status).toBe(403)
    expect(await json(refused)).toMatchObject({
      error: 'access_denied',
      error_description: NO_ORGANIZATION,
    })
    expect(await f.t.run((ctx) => ctx.db.query('oauth_connections').collect())).toEqual([])
  })

  it('refuses consent once the seat the connect page showed has left, and issues no code', async () => {
    const f = await fixture()
    const request = await authorization(f, await register(f))
    const oauthQuery = await consentPage(request)
    // the connect page stores the connection for the seat it shows
    await f.as.mutation(api.oauthConnections.getContext, { oauth_query: oauthQuery })
    await f.t.run((ctx) => ctx.db.patch(f.profile._id, { active: false }))
    const response = await consent(request, oauthQuery)
    const result = await json(response)
    expect(response.status, JSON.stringify(result)).toBe(403)
    expect(result).toMatchObject({ error: 'access_denied', error_description: ORGANIZATION_GONE })
    expect(result.url).toBeUndefined()
    const [row] = await f.t.run((ctx) => ctx.db.query('oauth_connections').collect())
    expect(row.approved_at).toBeUndefined()
    expect(await f.t.run((ctx) => ctx.db.query('oauth_credential_uses').collect())).toEqual([])
  })

  it('keeps the displayed organization fixed if the home profile changes before approval', async () => {
    const f = await fixture()
    const guest = await plantSeat(f.t, {
      org_id: f.otherOrg.id,
      auth_user_id: f.userId,
      org_role: 'guest',
      email: f.profile.email,
    })
    const request = await authorization(f, await register(f))
    const oauthQuery = await consentPage(request)
    const original = await f.as.mutation(api.oauthConnections.getContext, {
      oauth_query: oauthQuery,
    })
    expect(original.orgId).toBe(f.org.id)
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.profile._id, { org_role: 'guest' })
      await ctx.db.patch(guest._id, { org_role: 'user' })
    })
    const displayed = await f.as.mutation(api.oauthConnections.getContext, {
      oauth_query: oauthQuery,
    })
    expect(displayed.orgId).toBe(original.orgId)
    const approved = await json(await consent(request, oauthQuery))
    await tokens(await exchange(request, new URL(approved.url as string).searchParams.get('code')!))
    const connections = await f.as.query(api.oauthConnections.list, {})
    expect(connections).toHaveLength(1)
    expect(connections[0].orgId).toBe(f.org.id)
    expect(connections[0].profileId).toBe(f.profile.id)
  })
})

describe('OAuth revocation, replay and live account checks', () => {
  it('ends the access token of a connection with the browser session it was granted in, and renews it', async () => {
    const f = await fixture()
    const c = await connect(f)
    expect(await toolData(await mcp(f, c.access_token, 'list_projects'))).toBeInstanceOf(Array)
    expect((await signOut(f)).status).toBe(200)
    await deniedAccess(f, c.access_token)
    // The session's record goes once its access tokens have expired.
    const [ended] = await f.t.run((ctx) => ctx.db.query('oauth_ended_sessions').collect())
    const cleanup = await f.t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    expect(
      cleanup.filter((job) => job.name === 'oauthConnections:forgetEndedSession'),
    ).toMatchObject([
      { args: [{ id: ended._id }], scheduledTime: ended.ended_at + (3_600 + 60) * 1_000 },
    ])
    // An offline_access refresh token outlives the session, so the client
    // renews without a new approval.
    const renewed = await tokens(await refresh(f, c.request.clientId, c.refresh_token))
    expect(await toolData(await mcp(f, renewed.access_token, 'list_projects'))).toBeInstanceOf(
      Array,
    )
  })

  it('ends the newest access token at sign-out after more than 100 refreshes in the session', async () => {
    const f = await fixture()
    // What 120 earlier refreshes left in the session: expired, never revoked.
    await runInAuth(f.t, async (ctx) => {
      const session = await ctx.db.query('session').unique()
      if (!session) throw new Error('the session is gone')
      for (let index = 0; index < 120; index += 1)
        await ctx.db.insert('oauthAccessToken', {
          token: `expired-${index}`,
          clientId: 'earlier-client',
          sessionId: session._id,
          userId: f.userId,
          scopes: ['qivo:read'],
          expiresAt: Date.now() - 60_000,
        })
    })
    const c = await connect(f)
    expect((await signOut(f)).status).toBe(200)
    await deniedAccess(f, c.access_token)
  })

  it('answers a sign-out whose session cannot be ended as a failure that keeps the cookie, and ends both on a retry', async () => {
    const f = await fixture()
    const c = await connect(f)
    const sessions = () => runInAuth(f.t, async (ctx) => await ctx.db.query('session').collect())
    const [session] = await sessions()
    // The session's delete trigger (lib/sessionEnd.ts endSession).
    const trigger = () =>
      vi.spyOn(authTriggers.onDelete as unknown as { _handler: () => Promise<void> }, '_handler')
    // Every delete of the session fails, Better Auth's and Qivo's second try.
    const end = trigger().mockRejectedValue(new Error('injected session end failure'))
    const failed = await signOut(f)
    const answer = await json(failed)
    expect(failed.status, JSON.stringify(answer)).toBe(503)
    expect(answer.code).toBe('SIGN_OUT_FAILED')
    // The session cookie stays. The convex plugin still drops its cached
    // JWT, which the session mints again.
    expect(failed.headers.get('set-better-auth-cookie') ?? '').not.toContain('session_token')
    expect(failed.headers.get('set-cookie')).toBeNull()
    expect((await sessions()).map((row) => row._id)).toEqual([session._id])
    expect(await toolData(await mcp(f, c.access_token, 'list_projects'))).toBeInstanceOf(Array)
    end.mockRestore()
    // One failed delete is retried within the same sign-out.
    trigger().mockRejectedValueOnce(new Error('injected session end failure'))
    const retried = await signOut(f)
    expect(retried.status).toBe(200)
    expect(retried.headers.get('set-better-auth-cookie')).toContain('session_token=;')
    expect(await sessions()).toEqual([])
    await deniedAccess(f, c.access_token)
  })

  it('ends the access tokens of every session when one call ends more than 100', async () => {
    const f = await fixture()
    const c = await connect(f)
    // 120 more sessions of the login, each with a live access token of the
    // connection. The last one's token is known, as a client would hold it.
    const lastToken = 'planted-access-of-the-last-session'
    await runInAuth(f.t, async (ctx) => {
      const issued = await ctx.db.query('oauthAccessToken').unique()
      if (!issued) throw new Error('the connection has no access token')
      const { _id, _creationTime, ...fields } = issued
      for (let index = 0; index < 120; index += 1) {
        const now = Date.now()
        const sessionId = await ctx.db.insert('session', {
          token: `planted-session-${index}`,
          userId: f.userId,
          expiresAt: now + 86_400_000,
          createdAt: now,
          updatedAt: now,
        })
        await ctx.db.insert('oauthAccessToken', {
          ...fields,
          token: index === 119 ? await sha256hex(lastToken) : `planted-access-${index}`,
          sessionId,
        })
      }
    })
    expect(await toolData(await mcp(f, `qvo_${lastToken}`, 'list_projects'))).toBeInstanceOf(Array)
    // Ending every session of a login, as a ban does.
    await f.t.run((ctx) =>
      createAuth(ctx).api.revokeSessions({ headers: new Headers({ cookie: f.cookie }) }),
    )
    const left = await runInAuth(f.t, async (ctx) => await ctx.db.query('session').collect())
    expect(left).toEqual([])
    const ended = await f.t.run((ctx) => ctx.db.query('oauth_ended_sessions').collect())
    expect(ended).toHaveLength(121)
    await deniedAccess(f, c.access_token)
    await deniedAccess(f, `qvo_${lastToken}`)
  })

  it('ends an expired session at its expiry when the nightly cleanup deletes it', async () => {
    const f = await fixture()
    const c = await connect(f)
    // The session expires just after its access token was issued. Only a
    // refresh can issue one after then, such as the planted one.
    const renewed = 'planted-access-after-the-expiry'
    const expiresAt = await runInAuth(f.t, async (ctx) => {
      const issued = await ctx.db.query('oauthAccessToken').unique()
      const session = await ctx.db.query('session').unique()
      if (!issued || !session) throw new Error('the connection has no session or token')
      await ctx.db.patch(session._id, { expiresAt: issued._creationTime + 1 })
      return issued._creationTime + 1
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const plantedAt = await runInAuth(f.t, async (ctx) => {
      const issued = await ctx.db.query('oauthAccessToken').unique()
      if (!issued) throw new Error('the connection has no access token')
      const { _id, _creationTime, ...fields } = issued
      const id = await ctx.db.insert('oauthAccessToken', {
        ...fields,
        token: await sha256hex(renewed),
      })
      return (await ctx.db.get(id))?._creationTime ?? 0
    })
    expect(plantedAt).toBeGreaterThan(expiresAt)
    await f.t.mutation(internal.authRetention.expireSessions, {})
    expect(await runInAuth(f.t, (ctx) => ctx.db.query('session').collect())).toEqual([])
    await deniedAccess(f, c.access_token)
    expect(await toolData(await mcp(f, `qvo_${renewed}`, 'list_projects'))).toBeInstanceOf(Array)
  })

  it('ends every access token of an expired session that a ban ends, also one a refresh issued after the expiry', async () => {
    const f = await fixture()
    const c = await connect(f)
    const renewed = 'planted-access-after-the-expiry'
    await runInAuth(f.t, async (ctx) => {
      const issued = await ctx.db.query('oauthAccessToken').unique()
      const session = await ctx.db.query('session').unique()
      if (!issued || !session) throw new Error('the connection has no session or token')
      await ctx.db.patch(session._id, { expiresAt: issued._creationTime + 1 })
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await runInAuth(f.t, async (ctx) => {
      const issued = await ctx.db.query('oauthAccessToken').unique()
      if (!issued) throw new Error('the connection has no access token')
      const { _id, _creationTime, ...fields } = issued
      await ctx.db.insert('oauthAccessToken', { ...fields, token: await sha256hex(renewed) })
    })
    expect(await toolData(await mcp(f, `qvo_${renewed}`, 'list_projects'))).toBeInstanceOf(Array)
    // Better Auth ends every session of the login, as a ban does, through
    // the delete trigger that every one of its deletes runs.
    await f.t.run(async (ctx) =>
      (await createAuth(ctx).$context).internalAdapter.deleteUserSessions(f.userId),
    )
    expect(await runInAuth(f.t, (ctx) => ctx.db.query('session').collect())).toEqual([])
    await deniedAccess(f, c.access_token)
    await deniedAccess(f, `qvo_${renewed}`)
  })

  it('keeps a connection and its replay check when the nightly cleanup deletes its spent tokens', async () => {
    const f = await fixture()
    const c = await connect(f)
    const rotated = await tokens(await refresh(f, c.request.clientId, c.refresh_token))
    const rows = () =>
      runInAuth(f.t, async (ctx) => ({
        access: (await ctx.db.query('oauthAccessToken').collect()).length,
        refresh: (await ctx.db.query('oauthRefreshToken').collect()).length,
      }))
    expect(await rows()).toEqual({ access: 2, refresh: 2 })
    // The cleanup as it runs once the first access token has expired and an
    // hour after the refresh revoked the first refresh token.
    await runInAuth(f.t, async (ctx) => {
      const first = (await ctx.db.query('oauthAccessToken').collect())[0]
      await ctx.db.patch(first._id, { expiresAt: Date.now() - 1 })
    })
    const deleted = await f.t.mutation(components.betterAuth.oauth.deleteSpentTokens, {
      expiredBefore: Date.now(),
      revokedBefore: Date.now() + 1,
      numItems: 100,
    })
    expect(deleted).toBe(2)
    expect(await rows()).toEqual({ access: 1, refresh: 1 })
    expect(await toolData(await mcp(f, rotated.access_token, 'list_projects'))).toBeInstanceOf(
      Array,
    )
    // A replay of the deleted refresh token still ends the whole grant,
    // through the hash Qivo keeps of every used one.
    await oauthRefusal(await refresh(f, c.request.clientId, c.refresh_token), ['invalid_grant'])
    await deniedAccess(f, rotated.access_token)
    await oauthRefusal(await refresh(f, c.request.clientId, rotated.refresh_token), [
      'invalid_grant',
    ])
  })

  it("keeps a used refresh token's hash while the token could be accepted, and the nightly cleanup deletes it then", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const f = await fixture()
      const start = Date.now()
      const day = 86_400_000
      const c = await connect(f)
      // the first refresh token is used at once, the second two minutes
      // later, and the third after 29 days
      const second = await tokens(await refresh(f, c.request.clientId, c.refresh_token))
      vi.setSystemTime(start + 2 * 60_000)
      const third = await tokens(await refresh(f, c.request.clientId, second.refresh_token))
      vi.setSystemTime(start + 29 * day)
      const fourth = await tokens(await refresh(f, c.request.clientId, third.refresh_token))
      // the night 31 days and a minute after the first use
      vi.setSystemTime(start + 31 * day + 60_000)
      await f.t.mutation(internal.authRetention.expireTokens, {})
      const hashes = await f.t.run((ctx) => ctx.db.query('oauth_credential_uses').collect())
      expect(hashes.map((row) => [row.kind, row.used_at])).toEqual([
        ['authorization_code', new Date(start).toISOString()],
        ['refresh_token', new Date(start + 2 * 60_000).toISOString()],
        ['refresh_token', new Date(start + 29 * day).toISOString()],
      ])
      // The first token's hash is gone: its replay is refused, and the grant
      // goes on.
      await oauthRefusal(await refresh(f, c.request.clientId, c.refresh_token), ['invalid_grant'])
      const fifth = await tokens(await refresh(f, c.request.clientId, fourth.refresh_token))
      expect(await toolData(await mcp(f, fifth.access_token, 'list_projects'))).toBeInstanceOf(
        Array,
      )
      // The second expired a day ago, and its hash is kept for that day: its
      // replay still ends the whole grant.
      await oauthRefusal(await refresh(f, c.request.clientId, second.refresh_token), [
        'invalid_grant',
      ])
      await deniedAccess(f, fifth.access_token)
      await oauthRefusal(await refresh(f, c.request.clientId, fifth.refresh_token), [
        'invalid_grant',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  // The owner decided on 2026-10-25 that a reset ends no session,
  // connection or token, since most resets are a forgotten password, not a
  // stolen one.
  it('keeps every session, the OAuth connection and a personal token working at a password reset', async () => {
    const f = await fixture()
    const c = await connect(f)
    // a second browser of the same login
    const other = await http(f.t, '/api/auth/sign-in/email', {
      ...body({ email: f.profile.email, password: PASSWORD }),
      headers: { 'Content-Type': 'application/json', Origin: APP, 'better-auth-cookie': '' },
    })
    expect(other.status).toBe(200)
    const otherCookie = other.headers
      .get('set-better-auth-cookie')
      ?.match(/(?:^|,\s*)([^=;,]*session_token=[^;]+)/)?.[1]
    expect(otherCookie).toBeTruthy()
    // a personal token of the same person
    const personal = `qvt_${'keep'.repeat(10)}`
    await f.t.run(async (ctx) => {
      await ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: f.profile.id,
        name: 'Laptop',
        token_prefix: personal.slice(0, 11),
        token_hash: await sha256hex(personal),
        access: 'write',
        created_at: new Date().toISOString(),
      })
    })
    const sessions = () => runInAuth(f.t, async (ctx) => await ctx.db.query('session').collect())
    expect(await sessions()).toHaveLength(2)
    // the operator's recovery link, which a reset request mails too
    const operator = await f.t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: {
          name: 'Operator',
          email: 'operator@test.local',
          emailVerified: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })
    await f.t.run(async (ctx) => {
      await ctx.db.insert('platform_admins', {
        auth_user_id: operator._id as string,
        note: 'test operator',
        created_at: new Date().toISOString(),
      })
    })
    const { link } = await f.t
      .withIdentity({ subject: operator._id as string })
      .action(api.adminAuth.recoveryLink, { email: f.profile.email as string })
    const url = new URL(link)
    const landing = await http(f.t, `${url.pathname}${url.search}`)
    expect(landing.status).toBe(302)
    const token = new URL(landing.headers.get('location') as string).searchParams.get('token')
    const reset = await http(f.t, '/api/auth/reset-password', {
      ...body({ token, newPassword: 'Hermetic OAuth replacement 271828!' }),
      headers: { 'Content-Type': 'application/json', Origin: APP },
    })
    expect(reset.status, await reset.clone().text()).toBe(200)
    // both browser sessions stay, and the other one still signs its browser in
    expect(await sessions()).toHaveLength(2)
    const still = await http(f.t, '/api/auth/get-session', {
      headers: { Origin: APP, 'better-auth-cookie': otherCookie! },
    })
    const session = (await json(still)) as { user?: Json } | null
    expect(session?.user?.id).toBe(f.userId)
    // the access token issued in the approving session, its refresh token
    // and the personal token keep working
    expect(await toolData(await mcp(f, c.access_token, 'list_projects'))).toBeInstanceOf(Array)
    const renewed = await tokens(await refresh(f, c.request.clientId, c.refresh_token))
    expect(await toolData(await mcp(f, renewed.access_token, 'list_projects'))).toBeInstanceOf(
      Array,
    )
    expect(await toolData(await mcp(f, personal, 'list_projects'))).toBeInstanceOf(Array)
  })

  it('signs out from a connect page whose signed request has expired', async () => {
    const f = await fixture()
    const c = await connect(f)
    // What the app's OAuth client plugin adds to a POST from the connect page.
    const expired = `client_id=${c.request.clientId}&exp=1&sig=expired`
    const answer = await signOut(f, { oauth_query: expired })
    expect(answer.status, await answer.clone().text()).toBe(200)
    await deniedAccess(f, c.access_token)
  })

  it('answers a sign-out whose session delete Better Auth skipped as a failure', async () => {
    const f = await fixture()
    const c = await connect(f)
    // Better Auth's delete looks the row up first and skips it, without an
    // error, when that lookup fails.
    const handler = adapter.findMany as unknown as {
      _handler: (ctx: unknown, args: { model: string }) => Promise<unknown>
    }
    const original = handler._handler
    const lookup = vi.spyOn(handler, '_handler').mockImplementation((ctx, args) => {
      if (args.model === 'session') throw new Error('injected session lookup failure')
      return original(ctx, args)
    })
    const failed = await signOut(f)
    lookup.mockRestore()
    expect(failed.status, await failed.clone().text()).toBe(503)
    expect(failed.headers.get('set-better-auth-cookie') ?? '').not.toContain('session_token')
    expect(await toolData(await mcp(f, c.access_token, 'list_projects'))).toBeInstanceOf(Array)
  })

  it('leaves the session of a sign-out Better Auth refused', async () => {
    const f = await fixture()
    const c = await connect(f)
    const refused = await signOut(f, { disableRedirect: 'not a boolean' })
    expect(refused.status, await refused.clone().text()).toBe(400)
    const sessions = await runInAuth(f.t, async (ctx) => await ctx.db.query('session').collect())
    expect(sessions).toHaveLength(1)
    expect(await toolData(await mcp(f, c.access_token, 'list_projects'))).toBeInstanceOf(Array)
  })

  it('refuses a token issued before its session ended and passes one issued after', async () => {
    const f = await fixture()
    const c = await connect(f)
    const issued = await runInAuth(
      f.t,
      async (ctx) => await ctx.db.query('oauthAccessToken').unique(),
    )
    if (!issued?.sessionId) throw new Error('the token has no session')
    const end = (endedAt: number) =>
      f.t.run(async (ctx) => {
        for (const row of await ctx.db.query('oauth_ended_sessions').collect())
          await ctx.db.delete(row._id)
        await ctx.db.insert('oauth_ended_sessions', {
          session_id: issued.sessionId as string,
          ended_at: endedAt,
        })
      })
    await end(issued._creationTime - 1)
    expect(await toolData(await mcp(f, c.access_token, 'list_projects'))).toBeInstanceOf(Array)
    await end(issued._creationTime)
    await deniedAccess(f, c.access_token)
    // The cleanup removes the record once the tokens it refuses have expired.
    const [record] = await f.t.run((ctx) => ctx.db.query('oauth_ended_sessions').collect())
    await f.t.mutation(internal.oauthConnections.forgetEndedSession, { id: record._id })
    expect(await f.t.run((ctx) => ctx.db.query('oauth_ended_sessions').collect())).toEqual([])
  })

  it('refuses refresh under another client without consuming the legitimate refresh token', async () => {
    const f = await fixture()
    const c = await connect(f)
    await oauthRefusal(await refresh(f, await register(f), c.refresh_token), [
      'invalid_grant',
      'invalid_client',
    ])
    const renewed = await tokens(await refresh(f, c.request.clientId, c.refresh_token))
    expect(await toolData(await mcp(f, renewed.access_token, 'list_projects'))).toBeInstanceOf(
      Array,
    )
  })

  it('expires access and refresh tokens independently', async () => {
    const f = await fixture()
    const c = await connect(f)
    await f.t.mutation(components.betterAuth.adapter.updateMany, {
      input: {
        model: 'oauthAccessToken',
        where: [{ field: 'clientId', value: c.request.clientId }],
        update: { expiresAt: Date.now() - 1 },
      },
      paginationOpts: { numItems: 100, cursor: null },
    })
    await deniedAccess(f, c.access_token)
    const renewed = await tokens(await refresh(f, c.request.clientId, c.refresh_token))
    expect(await toolData(await mcp(f, renewed.access_token, 'list_projects'))).toBeInstanceOf(
      Array,
    )
    await f.t.mutation(components.betterAuth.adapter.updateMany, {
      input: {
        model: 'oauthRefreshToken',
        where: [{ field: 'clientId', value: c.request.clientId }],
        update: { expiresAt: Date.now() - 1 },
      },
      paginationOpts: { numItems: 100, cursor: null },
    })
    await oauthRefusal(await refresh(f, c.request.clientId, renewed.refresh_token), [
      'invalid_grant',
    ])
  })

  it('limits deletion to the owner, removes the connection from the list and requires a new grant to reconnect', async () => {
    const f = await fixture()
    const first = await connect(f)
    const second = await connect(f)
    const rows = await f.as.query(api.oauthConnections.list, {})
    expect(rows).toHaveLength(2)
    expect(JSON.stringify(rows)).not.toContain(first.access_token)
    expect(JSON.stringify(rows)).not.toContain(first.refresh_token)
    const row = rows.find((connection) => connection.clientId === first.request.clientId)!
    const stranger = f.t.withIdentity({ subject: f.otherAdmin.auth_user_id! })
    expect(await stranger.query(api.oauthConnections.list, {})).toEqual([])
    await expectRefusal(stranger.mutation(api.oauthConnections.revoke, { id: row.id }), 'not_found')
    expect(await f.as.mutation(api.oauthConnections.revoke, { id: row.id })).toBe(true)
    expect(await f.as.query(api.oauthConnections.list, {})).toEqual(
      rows.filter((connection) => connection.id !== row.id),
    )
    // Retrying deletion is safe; it must not restore a hidden connection.
    expect(await f.as.mutation(api.oauthConnections.revoke, { id: row.id })).toBe(true)
    await deniedAccess(f, first.access_token)
    await oauthRefusal(await refresh(f, first.request.clientId, first.refresh_token), [
      'invalid_grant',
    ])
    expect(await toolData(await mcp(f, second.access_token, 'list_projects'))).toBeInstanceOf(Array)
    const replacement = await connect(f, WRITE, first.request.clientId)
    const after = await f.as.query(api.oauthConnections.list, {})
    expect(after).toHaveLength(2)
    expect(after.some((connection) => connection.id === row.id)).toBe(false)
    const reconnected = after.find(
      (connection) =>
        connection.clientId === first.request.clientId && connection.revokedAt === null,
    )!
    expect(reconnected.id).not.toBe(row.id)
    await deniedAccess(f, first.access_token)
    await oauthRefusal(await refresh(f, first.request.clientId, first.refresh_token), [
      'invalid_grant',
    ])
    expect(await toolData(await mcp(f, replacement.access_token, 'list_projects'))).toBeInstanceOf(
      Array,
    )
  })

  it('can delete previously disconnected connections without restoring credentials', async () => {
    const f = await fixture()
    const c = await connect(f)
    const row = (await f.as.query(api.oauthConnections.list, {}))[0]
    await f.t.run(async (ctx) => {
      const grant = await ctx.db
        .query('oauth_connections')
        .withIndex('by_uuid', (q) => q.eq('id', row.id))
        .unique()
      await ctx.db.patch(grant!._id, {
        revoked_at: new Date().toISOString(),
        revocation_reason: 'disconnected',
      })
    })
    expect(await f.as.query(api.oauthConnections.list, {})).toHaveLength(1)
    expect(await f.as.mutation(api.oauthConnections.revoke, { id: row.id })).toBe(true)
    expect(await f.as.query(api.oauthConnections.list, {})).toEqual([])
    await deniedAccess(f, c.access_token)
    await oauthRefusal(await refresh(f, c.request.clientId, c.refresh_token), ['invalid_grant'])
  })

  it('refuses the unused code and signed consent of a deleted connection', async () => {
    const f = await fixture()
    const request = await authorization(f, await register(f))
    const oauthQuery = await consentPage(request)
    const approval = await json(await consent(request, oauthQuery))
    const code = new URL(approval.url as string).searchParams.get('code')!
    const row = (await f.as.query(api.oauthConnections.list, {}))[0]
    await f.as.mutation(api.oauthConnections.revoke, { id: row.id })
    await expectRefusal(
      f.as.mutation(api.oauthConnections.getContext, { oauth_query: oauthQuery }),
      'bad_request',
      /disconnected/,
    )
    await oauthRefusal(await consent(request, oauthQuery), ['invalid_grant'])
    await oauthRefusal(await exchange(request, code), ['invalid_grant'])
    expect(await f.as.query(api.oauthConnections.list, {})).toEqual([])
  })

  it('invalidates the complete grant after refresh-token replay, including rotated access tokens', async () => {
    const f = await fixture()
    const c = await connect(f)
    const rotated = await tokens(await refresh(f, c.request.clientId, c.refresh_token))
    await oauthRefusal(await refresh(f, c.request.clientId, c.refresh_token), ['invalid_grant'])
    await deniedAccess(f, c.access_token)
    await deniedAccess(f, rotated.access_token)
    await oauthRefusal(await refresh(f, c.request.clientId, rotated.refresh_token), [
      'invalid_grant',
    ])
  })

  it('allows only one concurrent authorization-code exchange', async () => {
    const f = await fixture()
    const request = await authorization(f, await register(f))
    const code = await codeFor(request)
    const responses = await Promise.all([exchange(request, code), exchange(request, code)])
    expect(responses.filter((response) => response.status === 200).length).toBeLessThanOrEqual(1)
    for (const response of responses) {
      if (response.status === 200) await tokens(response)
      else await oauthRefusal(response, ['invalid_grant'])
    }
  })

  it('does not leave a usable token after concurrent refresh replay', async () => {
    const f = await fixture()
    const c = await connect(f)
    const responses = await Promise.all([
      refresh(f, c.request.clientId, c.refresh_token),
      refresh(f, c.request.clientId, c.refresh_token),
    ])
    expect(responses.filter((response) => response.status === 200).length).toBeLessThanOrEqual(1)
    for (const response of responses) {
      if (response.status === 200) {
        const issued = await tokens(response)
        await deniedAccess(f, issued.access_token)
        await oauthRefusal(await refresh(f, c.request.clientId, issued.refresh_token), [
          'invalid_grant',
        ])
      } else await oauthRefusal(response, ['invalid_grant'])
    }
    await deniedAccess(f, c.access_token)
  })

  it('checks current profile activation and login ownership on access and refresh', async () => {
    for (const change of [{ active: false }, { auth_user_id: 'different-login' }]) {
      const f = await fixture()
      const c = await connect(f)
      await f.t.run((ctx) => ctx.db.patch(f.profile._id, change))
      await deniedAccess(f, c.access_token)
      await oauthRefusal(await refresh(f, c.request.clientId, c.refresh_token), ['invalid_grant'])
    }
  })

  it('refuses access and webhook ownership while a platform ban is in force, until its banExpires', async () => {
    const f = await fixture()
    const c = await connect(f)
    const grant = await f.t.query(internal.oauthAccess.lookupAccess, {
      tokenHash: await sha256hex(c.access_token.slice(4)),
      resource: RESOURCE,
    })
    const owner = {
      profile_id: grant!.profileId,
      credential_table: 'oauth_connections' as const,
      credential_id: grant!.connectionId,
      credential_row_id: grant!.connectionRowId,
    }
    for (const [banned, banExpires, allowed] of [
      [true, null, false],
      [true, Date.now() + 60_000, false],
      // Better Auth clears an expired ban only at the next sign-in
      [true, Date.now() - 1, true],
      [false, null, true],
    ] as const) {
      await f.t.mutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: 'user',
          where: [{ field: '_id', value: f.userId }],
          update: { banned, banExpires },
        },
      })
      if (allowed) {
        expect(await toolData(await mcp(f, c.access_token, 'list_projects'))).toBeInstanceOf(Array)
        expect(await f.t.query(internal.webhooks.list, { owner })).toEqual([])
      } else {
        await deniedAccess(f, c.access_token)
        await expectRefusal(
          f.t.query(internal.webhooks.list, { owner }),
          'forbidden',
          /Credential is no longer valid/,
        )
      }
    }
  })

  it('refuses to refresh tokens for a banned login', async () => {
    const f = await fixture()
    const c = await connect(f)
    await f.t.mutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'user',
        where: [{ field: '_id', value: f.userId }],
        update: { banned: true, banExpires: null },
      },
    })
    await oauthRefusal(await refresh(f, c.request.clientId, c.refresh_token), ['invalid_grant'])
    await deniedAccess(f, c.access_token)
  })
})

describe('the access check of every machine call, without the adapter', () => {
  /** How many times a function of the component's adapter ran while `run`
   * ran. Each loads Better Auth, so the checks of every MCP and REST call
   * read their rows through betterAuth/lookups.ts instead. */
  async function adapterCalls(run: () => Promise<unknown>) {
    const spies = Object.values(adapter).map((fn) =>
      vi.spyOn(fn as unknown as { _handler: (...args: never[]) => unknown }, '_handler'),
    )
    try {
      await run()
      return spies.reduce((calls, spy) => calls + spy.mock.calls.length, 0)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  }

  it('counts a call of any adapter function', async () => {
    const f = await fixture()
    const where = [{ field: '_id', value: f.userId }]
    const calls = () =>
      Promise.all([
        f.t.query(components.betterAuth.adapter.findOne, { model: 'user', where }),
        f.t.query(components.betterAuth.adapter.findMany, {
          model: 'user',
          where,
          paginationOpts: { cursor: null, numItems: 1 },
        }),
      ])
    expect(await adapterCalls(calls)).toBe(2)
  })

  const deleteRow = (f: Fx, table: 'oauthClient' | 'user', id: string) =>
    runInAuth(f.t, async (ctx) => {
      const row =
        table === 'user'
          ? await ctx.db.get(ctx.db.normalizeId('user', id)!)
          : await ctx.db
              .query('oauthClient')
              .withIndex('clientId', (q) => q.eq('clientId', id))
              .unique()
      await ctx.db.delete(row!._id)
    })
  const LIVE = { grant: true, deleting: false, mcp: 200 }
  const INVALID = { grant: false, deleting: false, mcp: 401 }
  it.each([
    ['passes a live grant', async () => {}, LIVE],
    [
      'refuses a grant its person disconnected',
      async (f: Fx, connectionId: string) =>
        f.as.mutation(api.oauthConnections.revoke, { id: connectionId }),
      INVALID,
    ],
    [
      // only the token's own column, which a ban sets on a token whose
      // session had already ended (adminAuth.ts revokeLoginAccess), so that
      // it stays refused after an unban
      'refuses a token Better Auth marked revoked',
      (f: Fx, _: string, __: string, tokenHash: string) =>
        runInAuth(f.t, async (ctx) => {
          const token = await ctx.db
            .query('oauthAccessToken')
            .withIndex('token', (q) => q.eq('token', tokenHash))
            .unique()
          await ctx.db.patch(token!._id, { revoked: Date.now() })
        }),
      INVALID,
    ],
    [
      'refuses a grant whose client Better Auth deleted',
      (f: Fx, _: string, clientId: string) => deleteRow(f, 'oauthClient', clientId),
      INVALID,
    ],
    [
      'refuses a grant whose client was disabled',
      (f: Fx, _: string, clientId: string) => disable(f, clientId),
      INVALID,
    ],
    [
      'refuses a grant whose client lost its resource link',
      (f: Fx, _: string, clientId: string) => unlink(f, clientId),
      INVALID,
    ],
    [
      "says the deletion to a grant its organization's deletion deleted",
      async (f: Fx) => {
        await beginDeletion(f)
        await deleteGrants(f)
      },
      { grant: false, deleting: true, mcp: 403 },
    ],
    [
      'refuses a grant whose seat was removed',
      (f: Fx) => f.t.run((ctx) => ctx.db.delete(f.profile._id)),
      INVALID,
    ],
    [
      'refuses a grant whose seat was deactivated',
      (f: Fx) => f.t.run((ctx) => ctx.db.patch(f.profile._id, { active: false })),
      INVALID,
    ],
    ['refuses a grant whose browser session ended', (f: Fx) => signOut(f), INVALID],
    ['refuses a grant whose login was deleted', (f: Fx) => deleteRow(f, 'user', f.userId), INVALID],
    [
      'refuses a grant whose login is banned',
      (f: Fx) =>
        runInAuth(f.t, (ctx) =>
          ctx.db.patch(ctx.db.normalizeId('user', f.userId)!, { banned: true }),
        ),
      INVALID,
    ],
  ] as const)('%s', async (_, change, expected) => {
    const f = await fixture()
    const c = await connect(f, READ)
    const args = { tokenHash: await sha256hex(c.access_token.slice(4)), resource: RESOURCE }
    const live = await f.t.query(internal.oauthAccess.lookupAccess, args)
    await change(f, live!.connectionId, c.request.clientId, args.tokenHash)
    let answer = {}
    const calls = await adapterCalls(async () => {
      const grant = await f.t.query(internal.oauthAccess.lookupAccess, args)
      const deleting = await f.t.query(internal.oauthAccess.refusedForDeletion, args)
      const response = await mcp(f, c.access_token, 'list_projects')
      answer = { grant: grant !== null, deleting, mcp: response.status }
    })
    expect({ ...answer, calls }).toEqual({ ...expected, calls: 0 })
  })

  it("reads a personal token's login, and its ban, without the adapter", async () => {
    const f = await fixture()
    const secret = `qvt_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
    await f.t.run(async (ctx) =>
      ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: f.profile.id,
        name: 'Personal key',
        token_prefix: 'qvt_1...11111',
        token_hash: await sha256hex(secret),
        access: 'read',
        created_at: new Date().toISOString(),
      }),
    )
    const me = () => http(f.t, '/v1/me', { headers: { Authorization: `Bearer ${secret}` } })
    let status = 0
    expect(await adapterCalls(async () => (status = (await me()).status))).toBe(0)
    expect(status).toBe(200)
    await runInAuth(f.t, (ctx) =>
      ctx.db.patch(ctx.db.normalizeId('user', f.userId)!, { banned: true }),
    )
    expect(await adapterCalls(async () => (status = (await me()).status))).toBe(0)
    expect(status).toBe(401)
  })

  it('finds no login for an id of another table, or for a string that is no id', async () => {
    const f = await fixture()
    const ban = (userId: string) => f.t.query(components.betterAuth.lookups.userBan, { userId })
    const session = await runInAuth(f.t, async (ctx) => await ctx.db.query('session').first())
    expect(await ban(f.userId)).not.toBeNull()
    expect(await ban(session!._id)).toBeNull()
    expect(await ban('not an id')).toBeNull()
  })
})

describe('Convex refresh-token compare-and-set adapter', () => {
  it('retains additional token/client predicates and allows only one concurrent claim of an absent revoked field', async () => {
    const f = await fixture()
    const row = await f.t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'oauthRefreshToken',
        data: {
          token: 'stored-hash',
          clientId: 'client-a',
          userId: f.userId,
          referenceId: 'grant-a',
          scopes: ['qivo:read'],
          expiresAt: Date.now() + 60_000,
        },
      },
    })
    expect(row.revoked).toBeUndefined()
    // The where clause and the writes of Better Auth 1.7's rotation
    // (oauth-provider createRefreshToken), with Qivo's own predicates.
    const guards = [
      { field: '_id' as const, value: row._id as string },
      { field: 'revoked' as const, operator: 'eq' as const, value: null },
      { field: 'userId' as const, value: f.userId },
      { field: 'referenceId' as const, value: 'grant-a' },
    ]
    const claim = (extra: { field: 'token' | 'clientId'; value: string }[]) => {
      const now = Date.now()
      return f.t.mutation(components.betterAuth.adapter.incrementOne, {
        input: {
          model: 'oauthRefreshToken',
          where: [...guards, ...extra],
          increment: {},
          set: { revoked: now, rotatedAt: now },
        },
      })
    }
    for (const wrong of [
      { field: 'token' as const, value: 'wrong-hash' },
      { field: 'clientId' as const, value: 'client-b' },
    ]) {
      // A null result is the provider's cue to answer invalid_grant.
      expect(await claim([wrong])).toBeNull()
      const unchanged = await f.t.query(components.betterAuth.adapter.findOne, {
        model: 'oauthRefreshToken',
        where: [{ field: '_id', value: row._id as string }],
      })
      expect(unchanged?.revoked).toBeUndefined()
    }
    const right = [
      { field: 'token' as const, value: 'stored-hash' },
      { field: 'clientId' as const, value: 'client-a' },
    ]
    const outcomes = await Promise.all([claim(right), claim(right)])
    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1)
    const claimed = await f.t.query(components.betterAuth.adapter.findOne, {
      model: 'oauthRefreshToken',
      where: [{ field: '_id', value: row._id as string }],
    })
    expect(claimed?.revoked).toBeTypeOf('number')
    expect(claimed?.rotatedAt).toBe(claimed?.revoked)
    // A claimed token is not claimed again.
    expect(await claim(right)).toBeNull()
  })
})

describe('OAuth smoke cleanup', () => {
  it('refuses production, mismatched deployments, names and client ownership without deleting connections', async () => {
    const f = await fixture()
    const name = `Qivo OAuth smoke ${uuid()}`
    const own = await connect(f, WRITE, await register(f, WRITE, name))
    const other = await connect(f)
    const args = { expected_site_url: APP, client_id: own.request.clientId, client_name: name }
    await expectRefusal(
      f.t.mutation(internal.internal.oauthSmoke.cleanup, {
        ...args,
        expected_site_url: 'http://localhost:5198',
      }),
      'rule',
      /exact localhost/,
    )
    await expectRefusal(
      f.t.mutation(internal.internal.oauthSmoke.cleanup, {
        ...args,
        client_name: 'Ordinary client',
      }),
      'rule',
      /uniquely named/,
    )
    await expectRefusal(
      f.t.mutation(internal.internal.oauthSmoke.cleanup, {
        ...args,
        client_id: other.request.clientId,
      }),
      'rule',
      /does not match/,
    )
    process.env.SITE_URL = 'https://qivo.io'
    try {
      await expectRefusal(
        f.t.mutation(internal.internal.oauthSmoke.cleanup, {
          ...args,
          expected_site_url: 'https://qivo.io',
        }),
        'rule',
        /exact localhost/,
      )
    } finally {
      process.env.SITE_URL = APP
    }
    expect(await f.as.query(api.oauthConnections.list, {})).toHaveLength(2)
    expect(await toolData(await mcp(f, own.access_token, 'list_projects'))).toBeInstanceOf(Array)
  })

  it('deletes only the named smoke client and its credentials and preserves another connected app', async () => {
    const f = await fixture()
    const name = `Qivo OAuth smoke ${uuid()}`
    const own = await connect(f, WRITE, await register(f, WRITE, name))
    const other = await connect(f)
    expect(
      await f.t.mutation(internal.internal.oauthSmoke.cleanup, {
        expected_site_url: APP,
        client_id: own.request.clientId,
        client_name: name,
      }),
    ).toBe(true)
    const connections = await f.as.query(api.oauthConnections.list, {})
    expect(connections).toHaveLength(1)
    expect(connections[0].clientId).toBe(other.request.clientId)
    for (const model of [
      'oauthClient',
      'oauthAccessToken',
      'oauthRefreshToken',
      'oauthConsent',
    ] as const) {
      const removed = await f.t.query(components.betterAuth.adapter.findOne, {
        model,
        where: [{ field: 'clientId', value: own.request.clientId }],
      })
      expect(removed).toBeNull()
    }
    const uses = await f.t.run((ctx) => ctx.db.query('oauth_credential_uses').collect())
    expect(uses.every((use) => use.connection_id === connections[0].id)).toBe(true)
    await deniedAccess(f, own.access_token)
    expect(await toolData(await mcp(f, other.access_token, 'list_projects'))).toBeInstanceOf(Array)
  })
})

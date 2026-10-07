/* Exercise the real Better Auth HTTP handler, local component adapter, OAuth
 * provider and MCP dispatcher together. Secrets are test-only and no cloud
 * deployment is contacted. This catches integration failures that a planted
 * access-token row or mocked introspection result would conceal. */
/// <reference types="vite/client" />
import { hashPassword } from 'better-auth/crypto'
import { generateCodeChallenge } from 'better-auth/oauth2'
import { describe, expect, it } from 'vitest'
import { api, components, internal } from '../_generated/api'
import authSchema from '../betterAuth/schema'
import { expectRefusal, newT, plantIssue, plantSeat, type T, uuid, withOrg } from './helpers.setup'

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
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: {
        name: profile.name,
        email: profile.email!,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  })
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
  await t.run((ctx) => ctx.db.patch(profile._id, { auth_user_id: user._id as string }))
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
  expect(response.status, JSON.stringify(client)).toBe(200)
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
    const writes: [string, Json][] = [
      ['create_task', { project: f.sub.id, title: 'Forbidden' }],
      ['update_task', { ref: task.id, title: 'Forbidden' }],
      ['delete_task', { ref: task.id }],
      ['add_comment', { ref: task.id, body: 'Forbidden' }],
      ['update_user', { user_id: f.profile.id, plannable_hours: 1 }],
    ]
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

describe('OAuth organization selection', () => {
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
  it('uses Basic client identity consistently when replay also carries a different body client_id', async () => {
    const f = await fixture()
    const registered = await http(f.t, '/api/auth/oauth2/create-client', {
      ...body({
        client_name: 'Confidential client',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'client_secret_basic',
        scope: WRITE,
        grant_types: ['authorization_code', 'refresh_token'],
      }),
      headers: { 'Content-Type': 'application/json', Origin: APP, 'better-auth-cookie': f.cookie },
    })
    const client = await json(registered)
    expect(registered.status, JSON.stringify(client)).toBe(200)
    expect(client.client_secret).toBeTypeOf('string')
    const authorizationRequest = await authorization(f, client.client_id as string)
    const c = {
      request: authorizationRequest,
      ...(await tokens(
        await exchange(authorizationRequest, await codeFor(authorizationRequest), {
          client_secret: client.client_secret as string,
        }),
      )),
    }
    const other = await connect(f)
    const request = () =>
      http(f.t, '/api/auth/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${btoa(`${c.request.clientId}:${client.client_secret}`)}`,
        },
        body: form({
          grant_type: 'refresh_token',
          client_id: other.request.clientId,
          refresh_token: c.refresh_token,
          resource: RESOURCE,
        }),
      })
    // The provider gives Basic precedence on confidential-client requests.
    const rotated = await tokens(await request())
    await oauthRefusal(await request(), ['invalid_grant'])
    await deniedAccess(f, c.access_token)
    await deniedAccess(f, rotated.access_token)
    expect(await toolData(await mcp(f, other.access_token, 'list_projects'))).toBeInstanceOf(Array)
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
    const guards = [
      { field: 'id' as const, value: row._id as string },
      { field: 'revoked' as const, value: null },
      { field: 'userId' as const, value: f.userId },
      { field: 'referenceId' as const, value: 'grant-a' },
    ]
    for (const wrong of [
      { field: 'token' as const, value: 'wrong-hash' },
      { field: 'clientId' as const, value: 'client-b' },
    ]) {
      const unmatched = await f.t.mutation(components.betterAuth.oauth.claimRefreshToken, {
        where: [...guards, wrong],
        revokedAt: Date.now(),
      })
      // Internal compare-and-set uses a null result for a non-matching row;
      // the provider translates it into an explicit invalid_grant response.
      expect(unmatched).toBeNull()
      const unchanged = await f.t.query(components.betterAuth.adapter.findOne, {
        model: 'oauthRefreshToken',
        where: [{ field: '_id', value: row._id as string }],
      })
      expect(unchanged?.revoked).toBeUndefined()
    }
    const claim = () =>
      f.t.mutation(components.betterAuth.oauth.claimRefreshToken, {
        where: [
          ...guards,
          { field: 'token', value: 'stored-hash' },
          { field: 'clientId', value: 'client-a' },
        ],
        revokedAt: Date.now(),
      })
    const outcomes = await Promise.all([claim(), claim()])
    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1)
    const claimed = await f.t.query(components.betterAuth.adapter.findOne, {
      model: 'oauthRefreshToken',
      where: [{ field: '_id', value: row._id as string }],
    })
    expect(claimed?.revoked).toBeTypeOf('number')
    expect(Object.values(claimed!)).not.toContain(null)
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

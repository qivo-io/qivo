import { getCurrentAuthContext } from '@better-auth/core/context'
import { getOAuthProviderState, oauthProvider } from '@better-auth/oauth-provider'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { type FunctionArgs, makeFunctionReference } from 'convex/server'
import { ConvexError } from 'convex/values'
import type { GenericCtx } from '../../vendor/convex-better-auth/src/client'
import { requireRunMutationCtx } from '../../vendor/convex-better-auth/src/utils'
import type { DataModel } from '../_generated/dataModel'
import { sha256hex } from '../machine/auth'
import { clientDisplayName, mcpResource, OAUTH_SCOPES, validateOAuthQuery } from './oauth'
import { clientMetadataTooLarge, OAUTH_CLIENT_METADATA_MAX_BYTES } from './oauthRegistration'

export const authorizationHash = (authUserId: string, query: URLSearchParams) =>
  sha256hex(
    JSON.stringify([
      authUserId,
      query.get('client_id'),
      query.get('redirect_uri'),
      query.get('code_challenge'),
      query.get('state') || '',
    ]),
  )

const ensureRef = makeFunctionReference<
  'mutation',
  {
    authorizationHash: string
    authUserId: string
    clientId: string
    clientName: string
    resource: string
    requestedScopes: string[]
    scopes: string[]
    approve: boolean
    expiresAt: string
  },
  string | null
>('oauthConnections:ensure')
const hasHomeRef = makeFunctionReference<'query', { authUserId: string }, boolean>(
  'oauthConnections:hasHome',
)
const claimRef = makeFunctionReference<
  'mutation',
  {
    id: string
    authUserId: string
    clientId: string
    resource: string
    scopes: string[]
    credentialHash: string
    kind: 'authorization_code' | 'refresh_token'
  },
  boolean
>('oauthConnections:claimIssuance')
const replayRef = makeFunctionReference<
  'mutation',
  {
    kind: 'authorization_code' | 'refresh_token'
    credentialHash: string
    clientId: string
  },
  null
>('oauthConnections:revokeReplay')
const admitRegistrationRef = makeFunctionReference<
  'mutation',
  { address: string | null },
  { admitted: boolean; retryAfter: number }
>('oauthRegistrations:admit')
const registerCodeRef = makeFunctionReference<
  'mutation',
  { id: string; credentialHash: string },
  boolean
>('oauthConnections:registerCode')

export async function registerOAuthCode(
  ctx: GenericCtx<DataModel>,
  verification: { identifier: string; value: string },
) {
  let value: { referenceId?: string; query?: { client_id?: string } }
  try {
    value = JSON.parse(verification.value)
  } catch {
    return
  }
  if (!value.referenceId || !value.query?.client_id) return
  const ok = await requireRunMutationCtx(ctx).runMutation(registerCodeRef, {
    id: value.referenceId,
    credentialHash: verification.identifier,
  })
  if (!ok) throw invalid()
}

const invalid = (description = 'This connection is invalid or has been disconnected.') =>
  new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: description })

/* Runs oauthConnections:ensure. A refusal it throws, such as a login in no
 * organization (lib/oauth.ts NO_ORGANIZATION), rolls its writes back and
 * answers as Better Auth's access_denied with the refusal's sentence;
 * anything else, a bare 500 otherwise, keeps failing as it is. */
async function ensureConnection(ctx: GenericCtx<DataModel>, args: FunctionArgs<typeof ensureRef>) {
  try {
    return await requireRunMutationCtx(ctx).runMutation(ensureRef, args)
  } catch (error) {
    const data = error instanceof ConvexError ? error.data : null
    if (data?.code === 'forbidden' && typeof data.message === 'string')
      throw new APIError('FORBIDDEN', { error: 'access_denied', error_description: data.message })
    throw error
  }
}

export function qivoOAuthProvider(ctx: GenericCtx<DataModel>, siteUrl: string, schemaOnly = false) {
  const resource = schemaOnly ? 'http://schema-only.invalid/mcp' : mcpResource()
  /* The provider stores each configured resource as an oauthResource row
   * when an auth instance starts, even one that serves no OAuth request. An
   * instance that cannot write, such as the one http.ts builds without a
   * context to register the routes, or one in a query, configures none, so it
   * does not try. Every OAuth request runs in an HTTP action or a mutation. */
  const seeded = schemaOnly || !('runMutation' in ctx) ? [] : [resource]
  const provider = oauthProvider({
    disableJwtPlugin: true,
    loginPage: `${siteUrl}/app/~/connect`,
    consentPage: `${siteUrl}/app/~/connect`,
    scopes: OAUTH_SCOPES,
    grantTypes: ['authorization_code', 'refresh_token'],
    /* Qivo serves one protected resource, the MCP endpoint. Every new client
     * is linked to it, and Better Auth 1.7 binds each grant to it. Per-client
     * links are not enforced: with one resource they add no check that
     * onRequest and the grant's stored resource do not already make
     * (oauthConnections.ts claimIssuance and lookupAccess), and clients
     * registered on Better Auth 1.6 have no link until
     * internal/oauthClientBackfill.ts runs, so enforcing them would refuse
     * those clients' refreshes as invalid_target until then. */
    resources: seeded,
    clientRegistrationDefaultResources: seeded,
    enforcePerClientResources: false,
    // MCP clients often redirect to a loopback or private-use URI, which a
    // "web" client may not register.
    clientRegistrationDefaultApplicationType: 'infer',
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    /* oauthConnections.getContext calls getOAuthClientPublicPrelogin through
     * auth.api, which runs in-process, and Better Auth refuses that call when
     * this is off. Its HTTP route stays unserved (lib/authRoutes.ts), so this
     * opens nothing to the network. */
    allowPublicClientPrelogin: true,
    clientRegistrationDefaultScopes: OAUTH_SCOPES,
    storeTokens: { hash: sha256hex },
    prefix: { opaqueAccessToken: 'qvo_', refreshToken: 'qvr_' },
    postLogin: {
      page: `${siteUrl}/app/~/connect`,
      // A login in no organization goes to the connect page, which names the
      // reason and the next step. Answering the authorization or the sign-in
      // that resumes it with consentReferenceId's refusal would show a bare
      // error page or "Sign-in failed". Consent refuses the login anyway.
      shouldRedirect: async ({ user }) =>
        !(await ctx.runQuery(hasHomeRef, { authUserId: user.id })),
      consentReferenceId: async ({ user, scopes }) => {
        const endpoint = await getCurrentAuthContext()
        const state = await getOAuthProviderState()
        // On consent the provider validates and loads the signed query before
        // invoking us, but does not copy it into endpoint.query until later.
        const query = state?.query
          ? new URLSearchParams(state.query)
          : new URLSearchParams(
              Object.entries(endpoint.query || {})
                .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
                .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
                .join('&'),
            )
        try {
          validateOAuthQuery(query)
        } catch {
          throw invalid('PKCE S256 and the Qivo MCP resource are required.')
        }
        const clientId = query.get('client_id') || ''
        const client = await endpoint.context.adapter.findOne<{ name?: string }>({
          model: 'oauthClient',
          where: [{ field: 'clientId', value: clientId }],
        })
        const id = await ensureConnection(ctx, {
          authorizationHash: await authorizationHash(user.id, query),
          authUserId: user.id,
          clientId,
          clientName: clientDisplayName(client?.name),
          resource,
          requestedScopes: (query.get('scope') || '').split(' ').filter(Boolean),
          scopes,
          approve: endpoint.path === '/oauth2/consent' && endpoint.body?.accept === true,
          expiresAt: new Date(
            Number(query.get('exp') || Math.floor(Date.now() / 1000) + 600) * 1000,
          ).toISOString(),
        })
        if (!id) throw invalid()
        return id
      },
    },
    customTokenResponseFields: async ({ grantType: granted, user, scopes, verificationValue }) => {
      const endpoint = await getCurrentAuthContext()
      const grantType = (['authorization_code', 'refresh_token'] as const).find(
        (kind) => kind === granted,
      )
      if (!user || !grantType) throw invalid()
      const raw =
        grantType === 'authorization_code' ? endpoint.body?.code : endpoint.body?.refresh_token
      if (
        typeof raw !== 'string' ||
        !raw ||
        (grantType === 'refresh_token' && !raw.startsWith('qvr_'))
      )
        throw invalid()
      const hash = await sha256hex(grantType === 'refresh_token' ? raw.slice(4) : raw)
      const refresh =
        grantType === 'refresh_token'
          ? await endpoint.context.adapter.findOne<{ referenceId?: string; clientId: string }>({
              model: 'oauthRefreshToken',
              where: [{ field: 'token', value: hash }],
            })
          : null
      const id = verificationValue?.referenceId || refresh?.referenceId
      const clientId = verificationValue?.query.client_id || refresh?.clientId
      if (!id || !clientId || endpoint.body?.resource !== resource) throw invalid()
      const ok = await requireRunMutationCtx(ctx).runMutation(claimRef, {
        id,
        authUserId: user.id,
        clientId,
        resource,
        scopes,
        credentialHash: hash,
        kind: grantType,
      })
      if (!ok) throw invalid()
      return {}
    },
  })
  return {
    ...provider,
    onRequest: async (request: Request, context: Parameters<typeof provider.onRequest>[1]) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/oauth2/token') && request.method === 'POST') {
        // OAuth token requests are form encoded. Inspect the raw form before
        // Better Call can collapse repeated values while parsing its schema.
        const contentType = request.headers.get('content-type') || ''
        if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
          return {
            response: new Response(
              JSON.stringify({
                error: 'invalid_request',
                error_description: 'Use an application/x-www-form-urlencoded token request.',
              }),
              { status: 400, headers: { 'Content-Type': 'application/json' } },
            ),
          }
        }
        const form = new URLSearchParams(await request.clone().text())
        if (
          ['resource', 'client_id', 'grant_type', 'code', 'refresh_token'].some(
            (key) => form.getAll(key).length > 1,
          ) ||
          form.getAll('resource').some((value) => value !== resource)
        ) {
          return {
            response: new Response(
              JSON.stringify({
                error: 'invalid_target',
                error_description: 'Use the single canonical Qivo MCP resource.',
              }),
              { status: 400, headers: { 'Content-Type': 'application/json' } },
            ),
          }
        }
      }
      return provider.onRequest(request, context)
    },
  }
}

/** The client address the backend reports for the current HTTP request, or
 * null when it reports none. The test runtime (convex-test 0.0.58) cannot
 * report it; every such request then shares one source counter, which only
 * makes the per-source limit stricter. */
async function requestAddress(ctx: GenericCtx<DataModel>): Promise<string | null> {
  if (!('getRequestMetadata' in ctx.meta)) return null
  try {
    // The type says string or null; a backend that omits the field must not
    // turn every registration into a validation failure.
    return (await ctx.meta.getRequestMetadata()).ip || null
  } catch {
    return null
  }
}

/** Refuses a client registration whose metadata is too large or that is over
 * the hourly limits (oauthRegistrations.ts admit), before the provider stores
 * a client. When the limits cannot be read, it refuses the registration, so
 * it fails closed. */
async function admitClientRegistration(ctx: GenericCtx<DataModel>, body: unknown) {
  if (clientMetadataTooLarge(body))
    throw new APIError('BAD_REQUEST', {
      error: 'invalid_client_metadata',
      error_description: `Client metadata must be at most ${OAUTH_CLIENT_METADATA_MAX_BYTES} bytes of JSON.`,
    })
  let result: { admitted: boolean; retryAfter: number }
  try {
    result = await requireRunMutationCtx(ctx).runMutation(admitRegistrationRef, {
      address: await requestAddress(ctx),
    })
  } catch {
    throw new APIError(
      'SERVICE_UNAVAILABLE',
      {
        error: 'temporarily_unavailable',
        error_description: 'Client registration is unavailable. Try again later.',
      },
      { 'Retry-After': '60' },
    )
  }
  if (!result.admitted)
    throw new APIError(
      'TOO_MANY_REQUESTS',
      {
        error: 'too_many_requests',
        error_description: `Too many client registrations. Try again in ${result.retryAfter} seconds.`,
      },
      { 'Retry-After': String(result.retryAfter) },
    )
}

/** Better Auth hooks for the OAuth provider. They limit client registration,
 * check authorize and token requests before the provider handles them, and
 * revoke a grant whose code or refresh token is replayed. */
export function oauthHooks(ctx: GenericCtx<DataModel>) {
  const requestBody = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  return {
    before: createAuthMiddleware(async (endpoint) => {
      // The only client creation endpoint Qivo serves (lib/authRoutes.ts).
      if (endpoint.path === '/oauth2/register') {
        await admitClientRegistration(ctx, endpoint.body)
        // Every registration is a public client that uses PKCE and gets no
        // secret, as Better Auth 1.6 made every unauthenticated one. 1.7
        // would make a registration without this field a confidential
        // client_secret_basic client.
        const body = requestBody(endpoint.body)
        if (body) body.token_endpoint_auth_method = 'none'
      }
      if (endpoint.path === '/oauth2/authorize') {
        // Provider 1.6 drops `resource` from its parsed authorize schema. Read
        // the actual URL before that loss, including repeated parameters.
        const query =
          endpoint.request && new URL(endpoint.request.url).pathname.endsWith('/oauth2/authorize')
            ? new URL(endpoint.request.url).searchParams
            : new URLSearchParams(
                Object.entries(endpoint.query || {})
                  .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
                  .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
                  .join('&'),
              )
        try {
          validateOAuthQuery(query)
        } catch {
          throw new APIError('BAD_REQUEST', {
            error: 'invalid_request',
            error_description: 'Use PKCE S256, qivo:read and the canonical Qivo MCP resource.',
          })
        }
      }
      if (endpoint.path === '/oauth2/token') {
        const body = requestBody(endpoint.body)
        if (!body) throw new APIError('BAD_REQUEST', { error: 'invalid_request' })
        const resource = body.resource
        if (resource !== undefined && resource !== mcpResource()) {
          throw new APIError('BAD_REQUEST', {
            error: 'invalid_target',
            error_description: 'This token is only valid for the Qivo MCP resource.',
          })
        }
        // Single-resource server: omission always means this same resource,
        // including refresh. The immutable grant is checked before issuance.
        body.resource = mcpResource()
      }
    }),
    after: createAuthMiddleware(async (endpoint) => {
      if (endpoint.path !== '/oauth2/token') return
      endpoint.setHeader('Cache-Control', 'no-store')
      endpoint.setHeader('Pragma', 'no-cache')
      const returned = endpoint.context.returned
      if (!(returned instanceof APIError) || returned.body?.error !== 'invalid_grant') return
      const body = requestBody(endpoint.body)
      const kind = body?.grant_type
      const raw = kind === 'authorization_code' ? body?.code : body?.refresh_token
      if (
        (kind !== 'authorization_code' && kind !== 'refresh_token') ||
        typeof raw !== 'string' ||
        !raw ||
        (kind === 'refresh_token' && !raw.startsWith('qvr_'))
      )
        return
      // Replays may be rejected by the provider before the issuance callback.
      // Hash tombstones survive its family cleanup and close its mint/delete race.
      let clientId = body?.client_id
      const authorization = endpoint.headers?.get('authorization')
      // Match the provider's precedence even when a conflicting client_id is
      // also present in the form; replay must revoke the authenticated grant.
      if (authorization?.startsWith('Basic ')) {
        try {
          clientId = atob(authorization.slice(6)).split(':')[0]
        } catch {
          return
        }
      }
      if (typeof clientId !== 'string') return
      await requireRunMutationCtx(ctx).runMutation(replayRef, {
        kind,
        credentialHash: await sha256hex(kind === 'refresh_token' ? raw.slice(4) : raw),
        clientId,
      })
    }),
  }
}

import { getCurrentAuthContext } from '@better-auth/core/context'
import { getOAuthProviderState, oauthProvider } from '@better-auth/oauth-provider'
import type { GenericCtx } from '@convex-dev/better-auth'
import { requireRunMutationCtx } from '@convex-dev/better-auth/utils'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { makeFunctionReference } from 'convex/server'
import type { DataModel } from '../_generated/dataModel'
import { sha256hex } from '../machine/auth'
import { mcpResource, OAUTH_SCOPES, validateOAuthQuery } from './oauth'

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

export function qivoOAuthProvider(ctx: GenericCtx<DataModel>, siteUrl: string, schemaOnly = false) {
  const resource = schemaOnly ? 'http://schema-only.invalid/mcp' : mcpResource()
  const provider = oauthProvider({
    disableJwtPlugin: true,
    loginPage: `${siteUrl}/app/~/connect`,
    consentPage: `${siteUrl}/app/~/connect`,
    scopes: OAUTH_SCOPES,
    grantTypes: ['authorization_code', 'refresh_token'],
    validAudiences: [resource],
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    allowPublicClientPrelogin: true,
    clientRegistrationDefaultScopes: OAUTH_SCOPES,
    storeTokens: { hash: sha256hex },
    prefix: { opaqueAccessToken: 'qvo_', refreshToken: 'qvr_' },
    postLogin: {
      page: `${siteUrl}/app/~/connect`,
      shouldRedirect: async () => false,
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
        const id = await requireRunMutationCtx(ctx).runMutation(ensureRef, {
          authorizationHash: await authorizationHash(user.id, query),
          authUserId: user.id,
          clientId,
          clientName: client?.name || 'Unnamed app',
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
    customTokenResponseFields: async ({ grantType, user, scopes, verificationValue }) => {
      const endpoint = await getCurrentAuthContext()
      if (!user || (grantType !== 'authorization_code' && grantType !== 'refresh_token'))
        throw invalid()
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

export function oauthHooks(ctx: GenericCtx<DataModel>) {
  const requestBody = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  return {
    before: createAuthMiddleware(async (endpoint) => {
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

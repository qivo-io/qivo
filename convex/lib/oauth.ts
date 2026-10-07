import type { Doc } from '../_generated/dataModel'
import { badRequest, forbidden } from './functions'

export const OAUTH_SCOPES = ['qivo:read', 'qivo:write', 'offline_access']
export const oauthIssuer = () => {
  const origin = process.env.CONVEX_SITE_URL
  if (!origin) throw new Error('CONVEX_SITE_URL is not set')
  return `${origin.replace(/\/$/, '')}/api/auth`
}
export const mcpResource = () => {
  const value = process.env.MCP_RESOURCE_URL || `${oauthIssuer().slice(0, -9)}/mcp`
  const url = new URL(value)
  if (!/^https?:\/\//.test(value) || value !== `${url.origin}/mcp`) {
    throw new Error('MCP_RESOURCE_URL must be an exact http(s) origin followed by /mcp')
  }
  return value
}
export const mcpResourceMetadata = () =>
  `${new URL(mcpResource()).origin}/.well-known/oauth-protected-resource/mcp`

export function homeProfile(profiles: Doc<'profiles'>[]): Doc<'profiles'> {
  const active = profiles.filter((p) => p.active && p.kind === 'person' && p.auth_user_id)
  const home = active.find((p) => ['admin', 'user', 'viewer'].includes(p.org_role)) || active[0]
  if (!home) throw forbidden('Join an organization before connecting an app.')
  return home
}

// Social sign-in adds an unsigned one-time cookie token to the callback URL.
// Retain exactly the parameter names covered by the provider's signature.
export function canonicalOAuthQuery(raw: string): string {
  const params = new URLSearchParams(raw)
  const names = new Set(params.getAll('ba_param'))
  if (params.getAll('sig').length !== 1 || names.size === 0) {
    throw badRequest('This connection request is invalid or expired. Reconnect from your app.')
  }
  const signed = new URLSearchParams()
  for (const [key, value] of params) {
    if (key === 'sig' || key === 'ba_param' || names.has(key)) signed.append(key, value)
  }
  return signed.toString()
}

export function validateOAuthQuery(params: URLSearchParams): void {
  for (const key of ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method']) {
    if (params.getAll(key).length !== 1 || !params.get(key))
      throw badRequest(`Missing or repeated ${key}.`)
  }
  if (
    params.get('code_challenge_method') !== 'S256' ||
    !/^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') || '')
  ) {
    throw badRequest('This app must use PKCE with S256.')
  }
  const resources = params.getAll('resource')
  if (resources.length > 1 || resources.some((resource) => resource !== mcpResource())) {
    throw badRequest('This authorization is only valid for the Qivo MCP resource.')
  }
  if (params.getAll('state').length > 1 || params.getAll('scope').length > 1)
    throw badRequest('Repeated OAuth parameter.')
  const scopes = (params.get('scope') || '').split(' ').filter(Boolean)
  if (!scopes.includes('qivo:read') || scopes.some((scope) => !OAUTH_SCOPES.includes(scope))) {
    throw badRequest('Request qivo:read and only supported Qivo scopes.')
  }
}

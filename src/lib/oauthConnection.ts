export const OAUTH_CONNECT_PATH = '/app/~/connect'

/** Preserve the provider-signed request through login without carrying the
 * cross-domain one-time token or unrelated callback parameters. The backend
 * verifies the signature and expiry before any client details are displayed. */
export function oauthConnectRequest(url: URL): { oauthQuery: string; returnURL: string } | null {
  if (url.pathname !== OAUTH_CONNECT_PATH) return null
  const names = new Set(url.searchParams.getAll('ba_param'))
  const query = new URLSearchParams()
  if (url.searchParams.has('sig') && names.size) {
    for (const [key, value] of url.searchParams) {
      if (key === 'sig' || key === 'ba_param' || names.has(key)) query.append(key, value)
    }
  }
  const oauthQuery = query.toString()
  return {
    oauthQuery,
    returnURL: `${url.origin}${OAUTH_CONNECT_PATH}${oauthQuery ? `?${oauthQuery}` : ''}`,
  }
}

export function connectionScopes(requested: readonly string[], allowChanges: boolean): string[] {
  return requested.filter((scope) => scope !== 'qivo:write' || allowChanges)
}

/** The provider repeats its login prompt until a session created after the
 * signed authorization request exists. This is presentation only; the server
 * enforces the signed prompt again when consent is submitted. */
export function oauthNeedsLogin(
  oauthQuery: string,
  sessionCreatedAt: string | number | Date,
): boolean {
  const params = new URLSearchParams(oauthQuery)
  if (!params.get('prompt')?.split(' ').includes('login')) return false
  const issuedAt = Number(params.get('ba_iat'))
  const createdAt = new Date(sessionCreatedAt).getTime()
  return (
    !Number.isFinite(issuedAt) ||
    issuedAt <= 0 ||
    !Number.isFinite(createdAt) ||
    createdAt < issuedAt
  )
}

export function connectionScopeLabel(scope: string): string {
  if (scope === 'qivo:read') return 'Read tasks, projects and planning you can access.'
  if (scope === 'qivo:write') return 'Make changes allowed by your Qivo permissions.'
  if (scope === 'offline_access') return 'Renew access automatically.'
  return scope
}

import { describe, expect, it } from 'vitest'
import { connectionScopes, oauthConnectRequest, oauthNeedsLogin } from './oauthConnection'

describe('OAuth connection request routing', () => {
  it('reserves only the app connection route', () => {
    for (const path of ['/app', '/app/~/board/all', '/admin', '/app/elsewhere/connect']) {
      expect(oauthConnectRequest(new URL(path, 'https://qivo.test'))).toBeNull()
    }
  })

  it('preserves signed values and duplicates while removing unsigned callback credentials', () => {
    const query = new URLSearchParams([
      ['client_id', 'my-client'],
      ['scope', 'qivo:read offline_access'],
      ['resource', 'https://api.qivo.test/mcp'],
      ['resource', 'https://second.qivo.test/mcp'],
      ['state', 'x+y / z'],
      ['ba_iat', '1000'],
      ...['client_id', 'scope', 'resource', 'state', 'ba_iat', 'ba_param'].map((name) => [
        'ba_param',
        name,
      ]),
      ['sig', 'opaque-signature'],
      ['ott', 'private-return-token'],
      ['error', 'ACCOUNT_NOT_LINKED'],
      ['redirect_uri', 'https://unsigned.example/callback'],
    ])
    const result = oauthConnectRequest(new URL(`https://qivo.test/app/~/connect?${query}`))
    const preserved = new URLSearchParams(result.oauthQuery)
    expect(preserved.getAll('resource')).toEqual([
      'https://api.qivo.test/mcp',
      'https://second.qivo.test/mcp',
    ])
    expect(preserved.get('state')).toBe('x+y / z')
    expect(preserved.get('sig')).toBe('opaque-signature')
    expect(preserved.has('ott')).toBe(false)
    expect(preserved.has('error')).toBe(false)
    expect(preserved.has('redirect_uri')).toBe(false)
    expect(new URL(result.returnURL).pathname).toBe('/app/~/connect')
    expect(new URL(result.returnURL).searchParams.toString()).toBe(preserved.toString())
  })

  it('keeps a malformed connection on its own route without inventing a signed request', () => {
    expect(
      oauthConnectRequest(new URL('https://qivo.test/app/~/connect?client_id=forged')),
    ).toEqual({
      oauthQuery: '',
      returnURL: 'https://qivo.test/app/~/connect',
    })
  })

  it('allows declining write access without adding scopes or dropping automatic renewal', () => {
    expect(connectionScopes(['qivo:read', 'qivo:write', 'offline_access'], false)).toEqual([
      'qivo:read',
      'offline_access',
    ])
    expect(connectionScopes(['qivo:read'], true)).toEqual(['qivo:read'])
  })

  it('requests fresh login only when the signed login prompt has not been satisfied', () => {
    const issuedAt = Date.parse('2026-09-13T10:00:00Z')
    const query = `prompt=login+consent&ba_iat=${issuedAt}`
    expect(oauthNeedsLogin(query, '2026-09-13T09:59:59Z')).toBe(true)
    expect(oauthNeedsLogin(query, '2026-09-13T10:00:00Z')).toBe(false)
    expect(oauthNeedsLogin(query, '2026-09-13T10:00:01Z')).toBe(false)
    expect(oauthNeedsLogin(`prompt=consent&ba_iat=${issuedAt}`, 0)).toBe(false)
    expect(oauthNeedsLogin('prompt=login&ba_iat=invalid', 0)).toBe(true)
  })
})

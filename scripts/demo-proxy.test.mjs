import { describe, expect, it } from 'vitest'
import { demoProxy, loopbackOrigin } from './demo-proxy.mjs'

const local = {
  VITE_APP_MODE: 'demo',
  SITE_URL: 'http://localhost:5200',
  VITE_CONVEX_URL: 'http://127.0.0.1:3210',
  VITE_CONVEX_SITE_URL: 'http://127.0.0.1:3211',
}

describe('local demo preview proxy', () => {
  it('does not enable forwarding for builds, normal apps or cloud backends', () => {
    expect(demoProxy(local, 'build')).toBeUndefined()
    expect(demoProxy({ ...local, VITE_APP_MODE: 'normal' }, 'serve')).toBeUndefined()
    for (const name of ['VITE_CONVEX_URL', 'VITE_CONVEX_SITE_URL'])
      expect(
        demoProxy({ ...local, [name]: 'https://example.convex.cloud' }, 'serve'),
      ).toBeUndefined()
  })

  it('requires the exact local app origin configured on the backend', () => {
    for (const SITE_URL of [undefined, 'https://demo.qivo.io', 'http://localhost:5200/app'])
      expect(() => demoProxy({ ...local, SITE_URL }, 'serve')).toThrow(/SITE_URL/)
  })

  it('forwards socket and file paths while preserving signed queries', () => {
    const routes = demoProxy(local, 'serve')
    const cloud = routes['^/__qivo_convex(?:/|$)']
    const http = routes['^/__qivo_http(?:/|$)']
    expect(cloud.ws).toBe(true)
    expect(cloud.target).toBe(local.VITE_CONVEX_URL)
    expect(cloud.rewrite('/__qivo_convex/api/1.45.0/sync')).toBe('/api/1.45.0/sync')
    expect(http.target).toBe(local.VITE_CONVEX_SITE_URL)
    expect(http.rewrite('/__qivo_http/files/example?e=123&t=signature')).toBe(
      '/files/example?e=123&t=signature',
    )
  })

  it('translates forwarded loopback origins without trusting foreign origins', () => {
    const route = demoProxy(local, 'serve')['^/__qivo_http(?:/|$)']
    let handler
    route.configure({
      on: (_event, fn) => {
        handler = fn
      },
    })
    for (const origin of ['http://localhost:58955', 'http://127.0.0.1:58955']) {
      const headers = new Headers({ Origin: origin })
      handler({ setHeader: (key, value) => headers.set(key, value) }, { headers: { origin } })
      expect(headers.get('Origin')).toBe(local.SITE_URL)
    }
    for (const origin of ['https://foreign.example', 'http://localhost.evil.test', 'null']) {
      const headers = new Headers({ Origin: origin })
      handler({ setHeader: (key, value) => headers.set(key, value) }, { headers: { origin } })
      expect(headers.get('Origin')).toBe(origin)
    }
  })

  it('rejects credentials, paths and lookalike loopback addresses', () => {
    for (const value of [
      'http://user@localhost',
      'http://localhost/path',
      'http://localhost?x',
      'http://localhost#x',
      'http://localhost.evil.test',
      'https://localhost',
    ])
      expect(loopbackOrigin(value)).toBe(false)
  })
})

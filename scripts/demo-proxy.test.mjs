import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadConfigFromFile } from 'vite'
import { describe, expect, it, vi } from 'vitest'
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

  /* Vite 8.3.4 bundles follow-redirects 1.16.0 in
   * node_modules/vite/dist/node/chunks/node.js, unpatched for
   * GHSA-8r9p-f939-6h3c (CVE-2026-111755, credential headers kept across a
   * redirect) and GHSA-q3jh-wrc6-jgq8 (CVE-2026-111756, cross-origin
   * credential stripping bypassed). Its proxy loads that copy only for a
   * route with followRedirects set, so no route may set it until a Vite
   * release bundles follow-redirects 1.16.1 or later. */
  it('never lets a proxy route follow redirects', async () => {
    const checkout = resolve(import.meta.dirname, '..')
    for (const file of ['vite.config.ts', 'scripts/demo-proxy.mjs'])
      expect([file, /followRedirects/.test(readFileSync(join(checkout, file), 'utf8'))]).toEqual([
        file,
        false,
      ])
    for (const env of [local, { VITE_APP_MODE: 'normal' }]) {
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
      const { config } = await loadConfigFromFile(
        { command: 'serve', mode: 'development' },
        join(checkout, 'vite.config.ts'),
        checkout,
        'silent',
      )
      vi.unstubAllEnvs()
      const routes = Object.values(config.server.proxy ?? {})
      if (env === local) expect(routes).toHaveLength(2)
      for (const route of routes) expect(route.followRedirects).toBeUndefined()
    }
  })
})

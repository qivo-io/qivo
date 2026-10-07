import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  browserBackendUrl,
  configuredConvexDeploymentUrl,
  convexDeploymentUrl,
  convexSiteUrl,
} from './backendUrl'

const preview = 'http://localhost:58955'
const deployment = 'http://127.0.0.1:3210'
const site = 'http://127.0.0.1:3211'

describe('local demo browser transport', () => {
  beforeEach(() => {
    vi.stubEnv('DEV', true)
    vi.stubEnv('VITE_APP_MODE', 'demo')
    vi.stubEnv('VITE_CONVEX_URL', deployment)
    vi.stubEnv('VITE_CONVEX_SITE_URL', site)
    vi.stubGlobal('window', { location: new URL(preview) })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('uses the forwarded browser origin for both backend transports', () => {
    expect(convexDeploymentUrl()).toBe(`${preview}/__qivo_convex`)
    expect(configuredConvexDeploymentUrl()).toBe(deployment)
    expect(convexSiteUrl()).toBe(`${preview}/__qivo_http`)
    expect(browserBackendUrl(`${deployment}/api/storage/upload?token=a%2Fb#result`)).toBe(
      `${preview}/__qivo_convex/api/storage/upload?token=a%2Fb#result`,
    )
    expect(browserBackendUrl(`${site}/avatars/person?v=storage&t=a%2B%2F%3D`)).toBe(
      `${preview}/__qivo_http/avatars/person?v=storage&t=a%2B%2F%3D`,
    )
  })

  it.each(['http://localhost:3210', 'http://[::1]:3210'])(
    'recognizes configured loopback deployment %s',
    (url) => {
      vi.stubEnv('VITE_CONVEX_URL', url)
      expect(convexDeploymentUrl()).toBe(`${preview}/__qivo_convex`)
      expect(browserBackendUrl(`${url}/api/query`)).toBe(`${preview}/__qivo_convex/api/query`)
    },
  )

  it.each([
    'https://images.example.test/photo?a=%2F#credit',
    'http://127.0.0.1:9999/files/other-service',
    'http://localhost:3211/files/different-origin',
    'http://127.0.0.1:3211.evil.example/files/image',
    'http://user:password@127.0.0.1:3211/files/image',
    'blob:http://127.0.0.1:3211/abc',
    'data:image/png;base64,AAAA',
    '/static/demo-avatar.svg',
    '//127.0.0.1:3211/files/image',
    `${preview}/__qivo_http/files/already-proxied`,
    'not a URL',
    '',
  ])('preserves URLs and strings outside the configured origins: %s', (value) => {
    expect(browserBackendUrl(value)).toBe(value)
  })

  it.each([
    ['DEV', false],
    ['VITE_APP_MODE', 'normal'],
    ['VITE_CONVEX_URL', 'https://demo.convex.cloud'],
    ['VITE_CONVEX_SITE_URL', 'https://demo.convex.site'],
    ['VITE_CONVEX_URL', 'invalid'],
    ['VITE_CONVEX_SITE_URL', ''],
    ['VITE_CONVEX_URL', 'http://127.0.0.2:3210'],
    ['VITE_CONVEX_URL', 'https://127.0.0.1:3210'],
    ['VITE_CONVEX_URL', 'http://127.0.0.1:3210/prefix'],
    ['VITE_CONVEX_SITE_URL', 'http://127.0.0.1:3211?param=value'],
    ['VITE_CONVEX_SITE_URL', 'http://127.0.0.1:3211#hash'],
    ['VITE_CONVEX_SITE_URL', 'http://user:secret@127.0.0.1:3211'],
  ] as const)('keeps direct URLs when %s is %s', (key, value) => {
    vi.stubEnv(key, value)
    expect(convexDeploymentUrl()).toBe(import.meta.env.VITE_CONVEX_URL)
    expect(convexSiteUrl()).toBe(import.meta.env.VITE_CONVEX_SITE_URL)
    expect(browserBackendUrl(`${site}/files/item?t=token`)).toBe(`${site}/files/item?t=token`)
  })

  it('preserves cloud production configuration and has no browser dependency outside preview', () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_CONVEX_URL', 'https://demo.convex.cloud')
    vi.stubEnv('VITE_CONVEX_SITE_URL', 'https://demo.convex.site')
    vi.stubGlobal('window', undefined)
    expect(convexDeploymentUrl()).toBe('https://demo.convex.cloud')
    expect(convexSiteUrl()).toBe('https://demo.convex.site')
    const url = 'https://demo.convex.site/files/item?token=secret'
    expect(browserBackendUrl(url)).toBe(url)
  })
})

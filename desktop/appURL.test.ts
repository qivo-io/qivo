import { describe, expect, it } from 'vitest'
import { productionAppURL, resolveAppURL } from './appURL.js'

describe('desktop app URL', () => {
  it('loads production in a packaged build, whatever the environment says', () => {
    for (const env of [
      {},
      { QIVO_DESKTOP_DEV: '1' },
      { QIVO_DESKTOP_URL: 'http://localhost:5199/app' },
      { QIVO_DESKTOP_DEV: '1', QIVO_DESKTOP_URL: 'http://localhost:8080/app' },
      { QIVO_DESKTOP_URL: 'https://preview.qivo.io/app' },
      { QIVO_DESKTOP_URL: 'https://evil.example/app' },
    ])
      expect(resolveAppURL(true, env).href, JSON.stringify(env)).toBe(productionAppURL)
  })

  it('loads the local server or QIVO_DESKTOP_URL when run from source', () => {
    expect(resolveAppURL(false, {}).href).toBe('http://localhost:5199/app')
    expect(resolveAppURL(false, { QIVO_DESKTOP_URL: ' http://localhost:5347/app ' }).href).toBe(
      'http://localhost:5347/app',
    )
    expect(resolveAppURL(false, { QIVO_DESKTOP_URL: 'https://preview.qivo.io/app' }).href).toBe(
      'https://preview.qivo.io/app',
    )
  })

  it('refuses a source run against an origin it cannot trust', () => {
    for (const url of [
      'https://evil.example/app',
      'https://qivo.io.evil.example/app',
      'http://qivo.io/app',
      'http://127.0.0.1:5199/app',
      'https://user:pass@qivo.io/app',
      'https://qivo.io/app?x=1',
      'https://qivo.io/app#x',
      'file:///app.html',
      'not a url',
    ])
      expect(() => resolveAppURL(false, { QIVO_DESKTOP_URL: url }), url).toThrow()
  })
})

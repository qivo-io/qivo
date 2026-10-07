import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import demoVisitor from '../api/demo-visitor.mjs'

// Keep the direct Node check on the project's Vitest/TypeScript toolchain,
// including Node versions without default TypeScript stripping.
if (!process.env.VITEST) {
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      fileURLToPath(import.meta.url),
    ],
    { cwd: new URL('..', import.meta.url), stdio: 'inherit' },
  )
  process.exit(0)
}

const { afterEach, beforeEach, describe, expect, it, vi } = await import('vitest')
const { verifiedDemoCountry } = await import('../convex/lib/demoVisitor.ts')

const secret = 'demo-metrics-visitor-hermetic-test-314159'
function invoke(headers = {}, method = 'GET') {
  const response = {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value
    },
    status(code) {
      this.statusCode = code
      return this
    },
    end() {
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
  return demoVisitor({ headers, method }, response)
}

beforeEach(() => {
  vi.stubEnv('VITE_APP_MODE', 'demo')
  vi.stubEnv('VERCEL', '1')
  vi.stubEnv('DEMO_METRICS_SECRET', secret)
})
afterEach(() => vi.unstubAllEnvs())

describe('trusted demo country context', () => {
  it('signs only the edge country and verifies with the Convex implementation', async () => {
    const response = invoke({
      'x-vercel-ip-country': 'NO',
      'x-forwarded-for': '192.0.2.123',
      'user-agent': 'A very specific browser build',
    })
    expect(response.statusCode).toBe(200)
    expect(await verifiedDemoCountry(response.body.context)).toBe('NO')
    expect(response.body).toEqual({ context: expect.any(String) })
    expect(JSON.stringify(response.body)).not.toMatch(/192\.0\.2|specific browser/)
    expect(response.headers['Cache-Control']).toBe('no-store')
    expect(response.headers['Access-Control-Allow-Origin']).toBeUndefined()
  })

  it('ignores untrusted headers, absent country and malformed country values', async () => {
    for (const headers of [
      {},
      { 'x-country': 'NO' },
      { 'x-vercel-ip-country': ['NO', 'US'] },
      { 'x-vercel-ip-country': 'NO, US' },
    ])
      expect(await verifiedDemoCountry(invoke(headers).body.context)).toBe('ZZ')
    vi.stubEnv('VERCEL', '')
    expect(await verifiedDemoCountry(invoke({ 'x-vercel-ip-country': 'NO' }).body.context)).toBe(
      'ZZ',
    )
  })

  it('returns an optional empty result for unconfigured signing and disables the regular app endpoint', () => {
    for (const value of ['', 'too-short', 'a'.repeat(129), `${'a'.repeat(32)}!`]) {
      vi.stubEnv('DEMO_METRICS_SECRET', value)
      expect(invoke().body).toEqual({ context: null })
    }
    expect(invoke({}, 'POST').statusCode).toBe(405)
    vi.stubEnv('VITE_APP_MODE', 'normal')
    expect(invoke().statusCode).toBe(404)
    expect(invoke().body).toBeUndefined()
  })
})

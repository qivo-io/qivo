/* LIVE mount/auth checks for the dedicated curation API. This file does not
 * create keys, submissions or files. The contract config's shared globalSetup
 * still resets the Northstar Labs development copy; run only through the coordinated contract pass. */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

type Stash = { siteUrl: string; qva: string; qvt: string }
const stash: Stash = JSON.parse(
  readFileSync(new URL('./.credentials.json', import.meta.url), 'utf8'),
)
const BASE = process.env.CONTRACT_BASE_URL ?? stash.siteUrl
const UNKNOWN = `qvc_${randomBytes(32).toString('hex')}`
const AUTH_ERROR = '{"error":"invalid or inactive curation key"}'

const request = (
  method: string,
  path: string,
  secret?: string,
  headers: Record<string, string> = {},
) =>
  fetch(`${BASE}/v1/curation${path}`, {
    method,
    headers: { ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...headers },
  })

async function expectAuthRefusal(response: Response) {
  expect(response.status).toBe(401)
  expect(response.headers.get('Content-Type')).toBe('application/json')
  expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  const text = await response.text()
  // Boolean assertions pin the exact bytes without printing a response that
  // might contain a reflected fixture credential when a regression fails.
  expect(text === AUTH_ERROR).toBe(true)
  expect([stash.qva, stash.qvt, UNKNOWN].some((secret) => text.includes(secret))).toBe(false)
}

describe('curation HTTP credential boundary', () => {
  for (const [label, secret] of [
    ['missing', undefined],
    ['organization agent', stash.qva],
    ['personal MCP', stash.qvt],
    ['unknown curation', UNKNOWN],
  ] as const) {
    test(`${label} credential is refused by the curation image list`, async () => {
      await expectAuthRefusal(await request('GET', '/images', secret))
    })
  }

  test('rejects the organization-key header fallback', async () => {
    await expectAuthRefusal(await request('GET', '/images', undefined, { 'X-Api-Key': stash.qva }))
  })

  test('protects submissions and unsupported methods before routing or body processing', async () => {
    await expectAuthRefusal(await request('POST', '/submissions', stash.qva))
    await expectAuthRefusal(await request('DELETE', '/images/unknown', UNKNOWN))
    await expectAuthRefusal(await request('GET', '', UNKNOWN))
  })

  test('preflights the dedicated route with the curation headers and no credentialed CORS', async () => {
    const response = await request('OPTIONS', '/submissions', undefined, {
      Origin: 'https://client.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS')
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
      'Authorization, Content-Type, Idempotency-Key',
    )
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull()
    expect(await response.text()).toBe('{}')
  })
})

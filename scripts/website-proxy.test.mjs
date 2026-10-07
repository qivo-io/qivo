import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { describe, expect, it } from 'vitest'
import { websiteProxy } from '../api/website.mjs'

async function requestProxy({
  path = '/api/website?__qivo_path=docs%2F&language=en',
  method = 'GET',
  host = 'preview.qivo.io',
  environment = 'staging',
  token = 'test-only-bypass',
  upstream,
} = {}) {
  const calls = []
  const server = createServer((request, response) => {
    void websiteProxy(request, response, {
      env: { QIVO_ENVIRONMENT: environment, QIVO_SITE_PROTECTION_BYPASS: token },
      fetchImpl: async (...args) => {
        calls.push(args)
        return (
          upstream ||
          new Response('<html>Docs</html>', {
            headers: {
              'Content-Type': 'text/html',
              'Set-Cookie': 'provider=secret',
              'x-vercel-protection-bypass': token,
            },
          })
        )
      },
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    return await new Promise((resolve, reject) => {
      const request = httpRequest(
        `http://127.0.0.1:${server.address().port}${path}`,
        {
          method,
          headers: { Host: host, Cookie: 'session=private', Authorization: 'Bearer browser-token' },
        },
        (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () =>
            resolve({
              status: response.statusCode,
              headers: new Headers(response.headers),
              body: Buffer.concat(chunks).toString('utf8'),
              calls,
            }),
          )
          response.on('error', reject)
        },
      )
      request.on('error', reject)
      request.end()
    })
  } finally {
    server.closeAllConnections()
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

describe('protected website proxy', () => {
  it('serves the website through a fixed upstream with a server-only bypass header', async () => {
    const result = await requestProxy()
    expect(result.status).toBe(200)
    expect(result.body).toBe('<html>Docs</html>')
    expect(String(result.calls[0][0])).toBe('https://site-preview.qivo.io/docs/?language=en')
    expect(result.calls[0][1].headers).toEqual({ 'x-vercel-protection-bypass': 'test-only-bypass' })
    expect(result.headers.get('set-cookie')).toBeNull()
    expect(result.headers.get('x-vercel-protection-bypass')).toBeNull()
    expect(result.headers.get('cache-control')).toBe('no-store')
  })
  it('fails closed outside staging, on wrong hosts, on writes and without credentials', async () => {
    for (const [options, status] of [
      [{ environment: 'production' }, 404],
      [{ host: 'qivo.io' }, 404],
      [{ method: 'POST' }, 405],
      [{ token: '' }, 503],
      [{ path: '/api/website?__qivo_path=%2F%2Fevil.test' }, 400],
      [{ path: '/api/website?__qivo_path=a&__qivo_path=b' }, 400],
    ]) {
      const result = await requestProxy(options)
      expect(result.status).toBe(status)
      expect(result.calls).toHaveLength(0)
    }
  })
  it('keeps legitimate redirects on staging and rejects offsite redirects', async () => {
    const result = await requestProxy({
      upstream: new Response(null, {
        status: 307,
        headers: { Location: 'https://site-preview.qivo.io/docs/' },
      }),
    })
    expect(result.headers.get('location')).toBe('https://preview.qivo.io/docs/')
    expect(
      (
        await requestProxy({
          upstream: new Response(null, {
            status: 307,
            headers: { Location: 'https://evil.test/' },
          }),
        })
      ).status,
    ).toBe(502)
  })
})

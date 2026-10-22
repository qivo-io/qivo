import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { CASES, probe, probeBody } from './body-cap-probe.mjs'

let server

afterEach(() => server?.close())

/* A server on a free loopback port that answers 401 after reading each
 * body, except that it drops every connection `drop` says to. */
async function listen(drop) {
  let seen = 0
  server = createServer((request, response) => {
    seen += 1
    if (drop(seen)) return request.socket.destroy()
    request.resume()
    request.on('end', () => response.writeHead(401).end('{}'))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

describe('body cap probe', () => {
  it('builds JSON bodies of exactly the size asked for', () => {
    for (const { path, size } of Object.values(CASES)) {
      const body = probeBody(path, size)
      expect(Buffer.byteLength(body)).toBe(size)
      expect(() => JSON.parse(body)).not.toThrow()
    }
    expect(() => probeBody('/mcp', 10)).toThrow(/at least/)
  })

  it('sends no credential and no real link, so no case can change data', () => {
    for (const { path, expect: statuses } of Object.values(CASES)) {
      expect(
        statuses.every((status) => /^4\d\d$/.test(status)),
        path,
      ).toBe(true)
      if (path.includes('uploads/')) expect(path).toContain('t=probe')
    }
  })

  it('counts every answer and every request that got none', async () => {
    const origin = await listen((n) => n % 4 === 0)
    for (const kind of [CASES['rest-over'], CASES['rest-over-chunked']]) {
      const counts = await probe(origin, kind, { requests: 12, concurrency: 3 })
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(12)
      expect(counts['401']).toBeGreaterThanOrEqual(8)
      expect(counts['401']).toBeLessThan(12)
    }
  })
})

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CASES, MAX_TOTAL, parseProbeArgs, probe, probeBody } from './body-cap-probe.mjs'

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

  it('counts every answer and every request that got none', async () => {
    const origin = await listen((n) => n % 4 === 0)
    for (const kind of [CASES['rest-over'], CASES['rest-over-chunked']]) {
      const counts = await probe(origin, kind, { requests: 12, concurrency: 3 })
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(12)
      expect(counts['401']).toBeGreaterThanOrEqual(8)
      expect(counts['401']).toBeLessThan(12)
    }
  })

  it('takes a bare origin and whole counts within the bounds', () => {
    expect(parseProbeArgs(['https://api.example.test/', '--case', 'rest-small'])).toEqual({
      origin: 'https://api.example.test',
      requests: 80,
      concurrency: 8,
      names: ['rest-small'],
    })
    expect(
      parseProbeArgs(['http://127.0.0.1:3211', '--requests', String(MAX_TOTAL / 10)]),
    ).toMatchObject({
      requests: MAX_TOTAL / 10,
    })
  })

  it('refuses arguments it cannot use', () => {
    for (const argv of [
      [],
      ['https://x.test', '--bogus'],
      ['https://x.test', '--requests'],
      ['https://x.test', '--requests', 'Infinity'],
      ['https://x.test', '--requests', '1.5'],
      ['https://x.test', '--requests', '0'],
      ['https://x.test', '--concurrency', '17'],
      // ten cases of 201 pass MAX_TOTAL
      ['https://x.test', '--requests', String(MAX_TOTAL / 10 + 1)],
      ['https://x.test', '--case', 'nope'],
      ['https://x.test', '--case', 'toString'],
      ['https://user:pass@x.test'],
      ['https://x.test/v1'],
      ['https://x.test?a=1'],
      ['https://x.test#top'],
      ['ftp://x.test'],
      ['https://x.test', 'https://y.test'],
    ]) {
      expect(parseProbeArgs(argv), argv.join(' ')).toBeNull()
    }
  })

  it('exits 2 for bad arguments, also when run through a symlink', () => {
    const script = fileURLToPath(new URL('./body-cap-probe.mjs', import.meta.url))
    const dir = mkdtempSync(join(tmpdir(), 'probe-'))
    try {
      const link = join(dir, 'probe.mjs')
      symlinkSync(script, link)
      for (const argv of [[script, 'https://x.test', '--bogus'], [link]]) {
        const run = spawnSync(process.execPath, argv, { encoding: 'utf8' })
        expect(run.status).toBe(2)
        expect(run.stderr).toMatch(/^usage:/)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

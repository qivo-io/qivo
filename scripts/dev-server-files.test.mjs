import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devServerFiles } from './dev-server-files.mjs'

// Characters that glob syntax gives a meaning, in the checkout's own path.
const parent = mkdtempSync(join(tmpdir(), 'qivo (copy) [x] +y @z {a,b} !'))
const root = join(parent, 'checkout')
const write = (path, text = 'fixture') => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

const denied = [
  'dev-temp/notes.txt',
  'dev-temp/credentials/dev/credentials.json',
  'tests/contract/.credentials.json',
  'tests/contract/contract.credentials.json',
  '.local/demo-verification/owners.json',
  '.vercel/project.json',
  '.claude/worktrees/other/dev-temp/token.txt',
]

let server
let origin
const events = []

beforeAll(async () => {
  write('src/main.js', 'export const value = 1\n')
  for (const path of denied) write(path)
  server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, ...devServerFiles(root) },
  })
  server.watcher.on('all', (_event, path) => events.push(path))
  await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`
})

afterAll(async () => {
  await server?.close()
  rmSync(parent, { recursive: true, force: true })
})

describe('dev server files', () => {
  it('refuses credentials and ignored local directories however they are requested', async () => {
    expect((await fetch(`${origin}/src/main.js`)).status).toBe(200)
    for (const path of denied) {
      for (const url of [`/${path}`, `/${path}?raw`, `/@fs${root}/${path}`])
        expect([url, (await fetch(`${origin}${url}`)).status]).toEqual([url, 403])
    }
  })

  it('ignores writes into dev-temp/ but still watches the source', async () => {
    write('dev-temp/screenshot.txt')
    write('src/later.js')
    await expect.poll(() => events.includes(join(root, 'src/later.js'))).toBe(true)
    await new Promise((done) => setTimeout(done, 300))
    expect(events.filter((path) => path.includes('dev-temp'))).toEqual([])
  })

  it("matches only this checkout's dev-temp/, not one around it", () => {
    const [ignored] = devServerFiles('/work/dev-temp/wt/(a)').watch.ignored
    expect(ignored('/work/dev-temp/wt/(a)/dev-temp')).toBe(true)
    expect(ignored('/work/dev-temp/wt/(a)/dev-temp/x/y.png')).toBe(true)
    expect(ignored('/work/dev-temp/wt/(a)/src/main.ts')).toBe(false)
    expect(ignored('/work/dev-temp/wt/(a)/dev-temp2/x')).toBe(false)
    expect(ignored('/work/dev-temp/x')).toBe(false)
  })
})

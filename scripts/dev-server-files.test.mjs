import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer, loadConfigFromFile, resolveConfig } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devServerFiles } from './dev-server-files.mjs'

const denied = [
  'dev-temp/notes.txt',
  'credentials.json',
  'tests/contract/.credentials.json',
  'tests/contract/credentials.json',
  'tests/contract/contract.credentials.json',
  '.local/demo-verification/owners.json',
  '.vercel/project.json',
  '.claude/worktrees/other/dev-temp/token.txt',
  'scripts/shots/admin-04-users.png',
  '.git',
]

let parent
let root
let server
let origin
const events = []

const write = (path, text = 'fixture') => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

beforeAll(async () => {
  // Characters that glob syntax gives a meaning, in the checkout's own path.
  parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'qivo (copy) [x] +y @z {a,b} !')))
  root = join(parent, 'checkout')
  write('src/main.js', 'export const value = 1\n')
  for (const path of denied) write(path)
  // Vite resolves symlinks in its root, so the rules come from a link to the
  // checkout while the server runs on the checkout itself.
  symlinkSync(root, join(parent, 'link'))
  server = await createServer({
    configFile: false,
    root,
    cacheDir: join(parent, '.vite'),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, ...devServerFiles(join(parent, 'link')) },
  })
  server.watcher.on('all', (_event, path) => events.push(path))
  await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`
})

afterAll(async () => {
  await server?.close()
  if (parent) rmSync(parent, { recursive: true, force: true })
})

describe('dev server files', () => {
  it('refuses credentials and ignored local directories however they are requested', async () => {
    expect((await fetch(`${origin}/src/main.js`)).status).toBe(200)
    for (const path of denied) {
      for (const url of [`/${path}`, `/${path}?raw`, `/@fs${root}/${path}`])
        expect([url, (await fetch(`${origin}${url}`)).status]).toEqual([url, 403])
    }
  })

  it('ignores writes into local directories but still watches the source', async () => {
    write('dev-temp/screenshot.html')
    write('.claude/worktrees/other/dev-temp/report.html')
    write('src/later.js')
    await expect.poll(() => events.includes(join(root, 'src/later.js'))).toBe(true)
    await new Promise((done) => setTimeout(done, 300))
    const local = ['dev-temp', '.claude'].map((name) => join(root, name))
    expect(events.filter((path) => local.some((name) => path.startsWith(name)))).toEqual([])
  })

  it("matches only this checkout's directories, not one around it", () => {
    const [ignored] = devServerFiles(parent).watch.ignored
    expect(ignored(`${parent}/dev-temp`)).toBe(true)
    expect(ignored(`${parent}/dev-temp/x/y.png`)).toBe(true)
    expect(ignored(`${parent}/src/main.ts`)).toBe(false)
    expect(ignored(`${parent}/dev-temp2/x`)).toBe(false)
    mkdirSync(join(root, 'dev-temp', 'wt'), { recursive: true })
    const [nested] = devServerFiles(join(root, 'dev-temp', 'wt')).watch.ignored
    expect(nested(join(root, 'dev-temp', 'wt', 'src', 'main.ts'))).toBe(false)
    expect(nested(join(root, 'dev-temp', 'wt', 'dev-temp', 'x'))).toBe(true)
  })

  it("keeps every one of Vite's own default deny rules", async () => {
    const defaults = await resolveConfig({ configFile: false, root, logLevel: 'silent' }, 'serve')
    expect(devServerFiles(root).fs.deny).toEqual(expect.arrayContaining(defaults.server.fs.deny))
  })

  it("applies to the repository's own dev server", async () => {
    const checkout = resolve(import.meta.dirname, '..')
    const { config } = await loadConfigFromFile(
      { command: 'serve', mode: 'development' },
      join(checkout, 'vite.config.ts'),
      checkout,
      'silent',
    )
    const [ignored] = config.server.watch.ignored
    expect(ignored(join(checkout, 'dev-temp', 'shot.png'))).toBe(true)
    expect(ignored(join(checkout, 'src', 'main.tsx'))).toBe(false)
    expect(config.server.fs.deny).toEqual(devServerFiles(checkout).fs.deny)
  })
})

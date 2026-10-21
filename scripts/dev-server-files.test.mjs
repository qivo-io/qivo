import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build, createServer, loadConfigFromFile, resolveConfig } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devServerFiles, refuseLinkedFiles } from './dev-server-files.mjs'

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

/** Symlinks in served directories, each to a refused file: in a local
 * directory, a credential file and a fixture directory outside the checkout. */
const links = {
  'src/notes.txt': 'dev-temp/notes.txt',
  'src/module.js': 'dev-temp/module.js',
  'src/local': 'dev-temp',
  'src/project.json': '.vercel/project.json',
  'src/env.txt': '.env',
  'src/page.html': 'dev-temp/page.html',
  'src/style.css': 'dev-temp/style.css',
  'src/folder/index': 'dev-temp/notes.txt',
  'public/notes.txt': 'dev-temp/notes.txt',
  'src/stash.json': '../fixtures/contract.credentials.json',
}

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
  write('public/logo.txt')
  for (const path of denied) write(path)
  write('.env', 'SECRET')
  for (const path of ['dev-temp/notes.txt', '.vercel/project.json', 'dev-temp/page.html'])
    write(path, 'SECRET')
  write('dev-temp/module.js', 'export const secret = "SECRET"\n')
  write('dev-temp/style.css', '.secret { content: "SECRET" }\n')
  mkdirSync(join(root, 'src/folder'))
  write('../fixtures/contract.credentials.json', 'SECRET')
  for (const [link, target] of Object.entries(links))
    symlinkSync(join(root, target), join(root, link))
  // A link to an allowed file is served as before.
  symlinkSync(join(root, 'src/main.js'), join(root, 'src/alias.js'))
  // Vite resolves symlinks in its root, so the rules come from a link to the
  // checkout while the server runs on the checkout itself.
  symlinkSync(root, join(parent, 'link'))
  server = await createServer({
    configFile: false,
    root,
    cacheDir: join(parent, '.vite'),
    logLevel: 'silent',
    appType: 'mpa',
    plugins: [refuseLinkedFiles()],
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

  it('refuses a symlink to a refused file however it is requested', async () => {
    const requests = [
      // the file under its link, with the queries that read it raw
      ...['?raw', '?import', '?url', '?inline', ''].map((query) => `/src/notes.txt${query}`),
      '/src/project.json',
      '/src/env.txt',
      '/src/stash.json',
      `/@fs${root}/src/notes.txt`,
      '/src/%6Eotes.txt',
      '/src//notes.txt',
      // through a linked directory
      '/src/local/notes.txt',
      '/src/local%2Fnotes.txt',
      // the public directory, served at the root
      '/notes.txt',
      // the index file the static server tries for a directory
      '/src/folder',
      '/src/folder/',
      // modules found by Vite's resolver, checked when they load
      `/@id//@fs${root}/src/notes.txt?raw&import`,
      `/@id//@fs${root}/src/style.css`,
      `/@id//@fs${root}/src/style.css?inline`,
      '/src/module',
      '/src/local/module',
    ]
    for (const url of requests) {
      const response = await fetch(`${origin}${url}`)
      expect([url, response.status, (await response.text()).includes('SECRET')]).toEqual([
        url,
        403,
        false,
      ])
    }
    // a page the HTML fallback or the static server finds by its name
    for (const url of ['/src/page', '/src/page.html', '/src/folder']) {
      const response = await fetch(`${origin}${url}`, { headers: { accept: 'text/html' } })
      expect([url, response.status]).toEqual([url, 403])
    }
  })

  it('serves sources, public files and links to allowed files', async () => {
    for (const url of ['/src/main.js', '/src/main', '/src/alias.js', '/src/alias', '/logo.txt'])
      expect([url, (await fetch(`${origin}${url}`)).status]).toEqual([url, 200])
  })

  it('refuses a build whose public directory links to a refused file', async () => {
    const site = join(parent, 'site')
    const output = join(parent, 'out')
    mkdirSync(join(site, 'public', 'nested'), { recursive: true })
    mkdirSync(join(site, 'dev-temp'))
    writeFileSync(join(site, 'index.html'), '<p>site</p>')
    writeFileSync(join(site, 'logo.txt'), 'logo')
    writeFileSync(join(site, 'dev-temp', 'notes.txt'), 'SECRET')
    symlinkSync(join(site, 'logo.txt'), join(site, 'public', 'logo.txt'))
    const run = () =>
      build({
        configFile: false,
        root: site,
        logLevel: 'silent',
        plugins: [refuseLinkedFiles()],
        server: devServerFiles(site),
        build: { outDir: output, emptyOutDir: true },
      })
    // a link to an allowed file is copied as before
    await run()
    expect(readFileSync(join(output, 'logo.txt'), 'utf8')).toBe('logo')
    for (const link of ['public/nested/notes.txt', 'public/local']) {
      const target = link.endsWith('local') ? 'dev-temp' : 'dev-temp/notes.txt'
      symlinkSync(join(site, target), join(site, link))
      await expect(run()).rejects.toThrow(`links to files the dev server refuses: ${link}`)
      rmSync(join(site, link))
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
    expect(config.plugins.flat().map((plugin) => plugin?.name)).toContain(refuseLinkedFiles().name)
  })
})

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { get } from 'node:http'
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
  'src/local': 'dev-temp/linked',
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

/** Sends `path` exactly as written, which fetch would normalize first. */
const raw = (path) =>
  new Promise((done, fail) => {
    const { hostname, port } = new URL(origin)
    get({ hostname, port, path }, (response) => {
      let body = ''
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => done({ status: response.statusCode, body }))
    }).on('error', fail)
  })

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
  write('dev-temp/linked/notes.txt', 'SECRET')
  write('dev-temp/linked/module.js', 'export const secret = "SECRET"\n')
  write('dev-temp/style.css', '.secret { content: "SECRET" }\n')
  mkdirSync(join(root, 'src/folder'))
  write('../fixtures/contract.credentials.json', 'SECRET')
  for (const [link, target] of Object.entries(links))
    symlinkSync(join(root, target), join(root, link))
  // A link to an allowed file is served as before, and so is a dependency
  // cache that links outside the checkout, as a shared node_modules does.
  symlinkSync(join(root, 'src/main.js'), join(root, 'src/alias.js'))
  mkdirSync(join(parent, 'shared-cache', 'files'), { recursive: true })
  writeFileSync(join(parent, 'shared-cache', 'files', 'dep.txt'), 'cached')
  mkdirSync(join(root, 'node_modules'))
  symlinkSync(join(parent, 'shared-cache'), join(root, 'node_modules', '.vite'))
  // Vite resolves symlinks in its root, so the rules come from a link to the
  // checkout while the server runs on the checkout itself.
  symlinkSync(root, join(parent, 'link'))
  server = await createServer({
    configFile: false,
    root,
    cacheDir: join(root, 'node_modules', '.vite'),
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
    const fs = `/@fs${root}`
    const requests = [
      // the file under its link, with the queries that read it raw
      ...['?raw', '?import', '?url', '?inline', ''].map((query) => `/src/notes.txt${query}`),
      '/src/project.json',
      '/src/env.txt',
      '/src/stash.json',
      `${fs}/src/notes.txt`,
      '/src/%6Eotes.txt',
      '/src//notes.txt',
      // a trailing slash, which the static server drops
      '/src/notes.txt/',
      '/notes.txt/',
      `${fs}/src/notes.txt/`,
      `${fs}/public/notes.txt/?raw`,
      // through a linked directory
      '/src/local/notes.txt',
      '/src/local%2Fnotes.txt',
      // the public directory, served at the root
      '/notes.txt',
      // the index file the static server tries for a directory
      '/src/folder',
      '/src/folder/',
      `${fs}/src/folder`,
    ]
    for (const url of requests) {
      const response = await fetch(`${origin}${url}`)
      expect([url, response.status, (await response.text()).includes('SECRET')]).toEqual([
        url,
        403,
        false,
      ])
    }
    // dot segments and backslashes that only a raw client sends
    const encoded = `/@fs${encodeURI(root)}`
    for (const path of [
      `${encoded}/src/nope/../notes.txt`,
      `${encoded}/src/notes.txt/../notes.txt`,
      `${encoded}/src/nope/%2e%2e/notes.txt`,
      `${encoded}/src/local/../notes.txt`,
      `${encoded}/src\\notes.txt`,
      '/src/nope/../notes.txt',
    ]) {
      const { status, body } = await raw(path)
      expect([path, status, body.includes('SECRET')]).toEqual([path, 403, false])
    }
    // a page the HTML fallback or the static server finds by its name
    for (const url of ['/src/page', '/src/page.html', '/src/folder']) {
      const response = await fetch(`${origin}${url}`, { headers: { accept: 'text/html' } })
      expect([url, response.status]).toEqual([url, 403])
    }
    // modules Vite's resolver finds are refused when they load, with a 404
    // that names neither the link nor its target
    for (const url of [
      `/@id//@fs${root}/src/notes.txt?raw&import`,
      `/@id//@fs${root}/src/stash.json?import`,
      `/@id//@fs${root}/src/style.css`,
      `/@id//@fs${root}/src/style.css?inline`,
      '/src/module',
      '/src/local/module',
    ]) {
      const response = await fetch(`${origin}${url}`)
      const body = await response.text()
      expect([url, response.status, body.includes('SECRET'), body.includes(parent)]).toEqual([
        url,
        404,
        false,
        false,
      ])
    }
  })

  it('refuses a symlink under a base path', async () => {
    const based = await createServer({
      configFile: false,
      root,
      base: '/x/',
      cacheDir: join(root, 'node_modules', '.vite'),
      logLevel: 'silent',
      appType: 'mpa',
      plugins: [refuseLinkedFiles()],
      server: { host: '127.0.0.1', port: 0, ...devServerFiles(root) },
    })
    await based.listen()
    try {
      const at = `http://127.0.0.1:${based.httpServer.address().port}`
      expect((await fetch(`${at}/x/src/main.js`)).status).toBe(200)
      for (const url of ['/x/src/notes.txt', '/x/notes.txt', '/x/src/folder'])
        expect([url, (await fetch(`${at}${url}`)).status]).toEqual([url, 403])
    } finally {
      await based.close()
    }
  })

  it('serves sources, public files and links to allowed files', async () => {
    for (const url of [
      '/src/main.js',
      '/src/main',
      '/src/alias.js',
      '/src/alias',
      '/logo.txt',
      '/node_modules/.vite/files/dep.txt',
    ])
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
      expect(readdirSync(output, { recursive: true }).join()).not.toMatch(/notes/)
      rmSync(join(site, link))
    }
  })

  it('ignores writes into local directories but still watches the source', async () => {
    write('dev-temp/screenshot.html')
    write('.claude/worktrees/other/dev-temp/report.html')
    // through links into dev-temp/: the file src/page.html, the directory
    // src/local, and a directory linked while the server runs
    mkdirSync(join(root, 'dev-temp', 'later'))
    symlinkSync(join(root, 'dev-temp', 'later'), join(root, 'src', 'later-report'))
    await new Promise((done) => setTimeout(done, 300))
    write('dev-temp/page.html', '<p>report</p>')
    write('dev-temp/linked/linked-report.html')
    write('dev-temp/later/later-report.html')
    write('src/later.js')
    await expect.poll(() => events.includes(join(root, 'src/later.js'))).toBe(true)
    await new Promise((done) => setTimeout(done, 300))
    expect(events.filter((path) => /screenshot|report|page/.test(path))).toEqual([])
  })

  it('ignores a path whose real path is in a local directory', () => {
    const [ignored] = devServerFiles(join(parent, 'link')).watch.ignored
    symlinkSync(join(root, '.git'), join(root, 'src', 'git'))
    for (const path of [
      'src/local',
      'src/local/notes.txt',
      'src/notes.txt',
      'src/project.json',
      'src/git',
    ])
      expect([path, ignored(join(root, path))]).toEqual([path, true])
    // the checkout itself through a link, a link to a source, and a path
    // that does not exist
    for (const path of [
      join(parent, 'link', 'src', 'main.js'),
      join(root, 'src', 'alias.js'),
      join(root, 'src', 'gone.js'),
    ])
      expect([path, ignored(path)]).toEqual([path, false])
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

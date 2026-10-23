import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

let repository = ''
afterEach(() => fs.rmSync(repository, { recursive: true, force: true }))

/**
 * Writes a repository with the real convex/ config, its Node types, the
 * repository's scripts and these files in convex/ (or, with a leading
 * `../`, beside it), and runs its
 * `npm run typecheck:convex` there, which is the one package.json holds.
 * `env` adds to the run's environment.
 */
function typecheck(files, env = {}) {
  repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'Qivo-Convex-Runtime-')))
  const contents = {
    'package.json': JSON.stringify({
      scripts: { 'typecheck:convex': scripts['typecheck:convex'] },
    }),
    'convex/tsconfig.json': fs.readFileSync(path.join(root, 'convex/tsconfig.json'), 'utf8'),
    'convex/env.d.ts': fs.readFileSync(path.join(root, 'convex/env.d.ts'), 'utf8'),
    ...Object.fromEntries(
      Object.entries(files).map(([file, source]) => [
        file.startsWith('../') ? file.slice(3) : `convex/${file}`,
        source,
      ]),
    ),
  }
  for (const [file, source] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(path.join(repository, file)), { recursive: true })
    fs.writeFileSync(path.join(repository, file), source)
  }
  fs.mkdirSync(path.join(repository, 'node_modules/@types'), { recursive: true })
  for (const link of [
    'scripts',
    'node_modules/.bin',
    'node_modules/typescript',
    'node_modules/@types/node',
  ])
    fs.symlinkSync(path.join(root, link), path.join(repository, link))
  const result = spawnSync('npm', ['run', '--silent', 'typecheck:convex'], {
    cwd: repository,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (result.error) throw result.error
  return { status: result.status, output: result.stdout + result.stderr }
}

/* A loader hook that makes TypeScript's API report every canonical path in
 * lowercase, as it does on a host whose file names ignore case, such as
 * macOS or Windows. File names keep their case, and so do the node IDs the
 * API sends back to the server, which runs on this host. It fails when
 * TypeScript's code changes, so the simulation cannot stop quietly. */
const lowercasePaths = `
const rewrites = [
  ['/typescript/dist/api/sync/api.js', 'this.path = parsed.path;', 'this.path = parsed.path.toLowerCase();'],
  ['/typescript/dist/api/node/node.js', 'get path() {', 'get path() { return this.casedPath.toLowerCase() }\\n    get casedPath() {'],
  ['/typescript/dist/api/node/node.generated.js', 'this.sourceFile.path}', 'this.sourceFile.casedPath}'],
]
export async function load(url, context, next) {
  const result = await next(url, context)
  const rewrite = rewrites.find(([file]) => url.endsWith(file))
  if (!rewrite) return result
  const source = String(result.source)
  if (!source.includes(rewrite[1])) throw new Error(url + ' no longer holds ' + rewrite[1])
  return { ...result, source: source.replace(rewrite[1], rewrite[2]) }
}
`
// Registers the hook, after it checks that the check's API is the file the hook rewrites.
const registerLowercasePaths = `
import { register } from 'node:module'
if (!import.meta.resolve('typescript/unstable/sync').endsWith('/typescript/dist/api/sync/api.js'))
  throw new Error('typescript/unstable/sync moved, so the hook would change nothing')
register('./lowercase-paths.mjs', import.meta.url)
`

const usesBuffer = "export const encoded = Buffer.from('qivo').toString('base64')\n"

// Each case runs tsc and the check, which take a few seconds on a loaded machine.
describe('the convex typecheck', { timeout: 60_000 }, () => {
  it('fails on a Node global in a file that runs in the default runtime', () => {
    const { status, output } = typecheck({ 'encode.ts': usesBuffer })
    expect(status).toBe(1)
    expect(output).toContain(
      'convex/encode.ts:1:24 - Buffer is a Node global, which the default runtime does not provide.',
    )
  })

  it('passes Node code in Node files and tests, and Node types where they are erased', () => {
    const { status, output } = typecheck({
      'encode.ts': `'use node'\n${usesBuffer}`,
      'lib/bytes.ts': "'use node'\nexport const size = (text: string) => Buffer.byteLength(text)\n",
      'measure.ts':
        "'use node'\nimport { size } from './lib/bytes'\nexport const bytes = size('x')\n",
      'tests/encode.test.ts': usesBuffer,
      'site.ts': [
        "import type { Readable } from 'node:stream'",
        "import { AsyncLocalStorage, type AsyncResource } from 'node:async_hooks'",
        "import type { size } from './lib/bytes'",
        "export const options: RequestInit = { method: 'POST' }",
        'export let stream: Readable | typeof Buffer | AsyncResource | undefined',
        'export let measure: typeof size | undefined',
        'export const storage = new AsyncLocalStorage<string>()',
        'export interface Encoded extends Buffer {}',
        'declare const later: typeof setImmediate',
        '',
      ].join('\n'),
    })
    expect(output).toBe(
      "1 files run in Convex's default runtime and use only its globals; 3 run in Node.\n",
    )
    expect(status).toBe(0)
  })

  it('fails when it finds no file that runs in the default runtime', () => {
    const { status, output } = typecheck({ 'encode.ts': `'use node'\n${usesBuffer}` })
    expect(status).toBe(1)
    expect(output).toContain('holds no convex/ file that runs in the default runtime.')
  })

  it('fails when a file Convex bundles is not in the program', () => {
    const { status, output } = typecheck({
      'site.ts': "export const site = new URL('https://qivo.io')\n",
      'legacy.js': 'export const legacy = 1\n',
    })
    expect(status).toBe(1)
    expect(output).toContain('convex/legacy.js is not in ')
  })

  it('checks in the default runtime a file without use node, whoever imports it', () => {
    const { status, output } = typecheck({
      'lib/bytes.ts': 'export const size = (text: string) => Buffer.byteLength(text)\n',
      'lib/count.ts': 'export const count = (text: string) => Buffer.byteLength(text)\n',
      'measure.ts':
        "'use node'\nimport { size } from './lib/bytes'\nexport const bytes = size('x')\n",
      'tally.ts': "import { count } from './lib/count'\nexport const bytes = count('y')\n",
    })
    expect(status).toBe(1)
    expect(output).toContain('convex/lib/bytes.ts:1:39 - Buffer is a Node global')
    expect(output).toContain('convex/lib/count.ts:1:40 - Buffer is a Node global')
    expect(output).not.toContain('convex/measure.ts')
  })

  it('allows the web APIs and process.env, and refuses Node modules and the rest of process', () => {
    const { status, output } = typecheck({
      'web.ts': [
        "export const site = new URL(process.env.SITE_URL ?? 'https://qivo.io').origin",
        "export const bytes = new TextEncoder().encode(btoa('qivo'))",
        'export const id = crypto.randomUUID()',
        'export const load = () => fetch(new Request(site, { headers: new Headers() }))',
        '',
      ].join('\n'),
      'encode.ts': `'use node'\n${usesBuffer}`,
      'node.ts': [
        "import { createHash } from 'node:crypto'",
        "import hooks from 'node:async_hooks'",
        "import { executionAsyncId } from 'async_hooks'",
        "import { encoded } from './encode'",
        "export const hash = createHash('sha256')",
        'export const directory = process.cwd()',
        'export const later = (run: () => void) => setImmediate(run)',
        'export const exposed = { Buffer, encoded, hooks, executionAsyncId }',
        '',
      ].join('\n'),
    })
    expect(status).toBe(1)
    expect(output.split('\n').filter((line) => line.startsWith('convex/'))).toEqual([
      'convex/node.ts:1:28 - node:crypto is a Node module, which the default runtime does not provide.',
      "convex/node.ts:2:19 - the default runtime's node:async_hooks holds only AsyncLocalStorage and AsyncResource, so import them by name.",
      "convex/node.ts:3:34 - the default runtime's async_hooks holds only AsyncLocalStorage and AsyncResource, so import them by name.",
      "convex/node.ts:4:25 - ./encode starts with 'use node', and the default runtime cannot run it.",
      'convex/node.ts:6:26 - process holds only env in the default runtime, so read process.env.',
      'convex/node.ts:7:43 - setImmediate is a Node global, which the default runtime does not provide.',
      'convex/node.ts:8:26 - Buffer is a Node global, which the default runtime does not provide.',
    ])
  })
  it('passes reads of web types through mapped types and unions, and imports named by a template', () => {
    const { status, output } = typecheck({
      'web.ts': [
        "import type { Readable } from 'node:stream'",
        'export const method = (options: Partial<RequestInit>) => options.method',
        'export const url = (request: Readonly<Request>) => request.url',
        "export const header = (message: Request | Response) => message.headers.get('x')",
        'export const load = () => import(`./lib/site`)',
        'export let stream: Readable | undefined',
        '',
      ].join('\n'),
      'lib/site.ts': "export const site = new URL('https://qivo.io')\n",
    })
    expect(output).toBe(
      "2 files run in Convex's default runtime and use only its globals; 0 run in Node.\n",
    )
    expect(status).toBe(0)
  })

  it("follows the rules of Convex's bundler and fails what it cannot settle", () => {
    const { status, output } = typecheck({
      'schema.ts': `'use node'\n${usesBuffer}`,
      'lib/_generated/gen.ts': usesBuffer,
      'helped.ts': "import { size } from './lib/bytes.helpers'\nexport const bytes = size('x')\n",
      'lib/bytes.helpers.ts': 'export const size = (text: string) => Buffer.byteLength(text)\n',
      'declares.ts':
        "declare const Buffer: { from(text: string): unknown }\nexport const bytes = Buffer.from('x')\n",
      'augment.d.ts':
        "declare global {\n  interface Buffer {\n    tag?: string\n  }\n}\ndeclare module 'node:crypto' {\n  export const extra: number\n}\nexport {}\n",
      'augmented.ts': `import { randomUUID } from 'node:crypto'\n${usesBuffer}export const id = randomUUID()\n`,
      'emitter.ts': "export class Emitter extends (await import('node:events')).EventEmitter {}\n",
      'computed.ts': "export const load = (name: string) => import('node:' + name)\n",
      'escaped.ts': `'use\\x20node'\n${usesBuffer}`,
      'commented.ts': `'use node' // Node only\n${usesBuffer}`,
      'setup.ts': "import './lib/polyfill.setup'\nexport const ready = true\n",
      'lib/polyfill.setup.ts': "console.log('setup')\n",
      'shared.ts':
        "import { encode } from '../shared/encode.js'\nexport const encoded = encode('x')\n",
      '../shared/encode.js':
        "export const encode = (text) => Buffer.from(text).toString('base64')\n",
      '../shared/encode.d.ts': 'export declare const encode: (text: string) => string\n',
    })
    expect(status).toBe(1)
    expect(output.split('\n').filter((line) => /^(convex|shared)\//.test(line))).toEqual([
      "convex/commented.ts - Convex may run it in either runtime. Write 'use node' alone on its line at the top of the file, or no line that reads as one.",
      "convex/schema.ts - Convex runs schema.ts in the default runtime whatever its directive, so remove 'use node'.",
      'convex/shared.ts:1:24 - ../shared/encode.js resolves to shared/encode.d.ts, which the check cannot read.',
      'convex/setup.ts:1:8 - TypeScript does not resolve ./lib/polyfill.setup to a module. A file needs an import or an export, such as `export {}`, to be one.',
      'convex/emitter.ts:1:44 - node:events is a Node module, which the default runtime does not provide.',
      'convex/computed.ts:1:39 - this imports a module named at runtime, which the check cannot follow. Name it with a string.',
      'convex/augmented.ts:1:28 - node:crypto is a Node module, which the default runtime does not provide.',
      'convex/augmented.ts:2:24 - Buffer is a Node global, which the default runtime does not provide.',
      'convex/declares.ts:1:15 - this declares Buffer, a Node global the default runtime does not provide, and hides it from the check.',
      'convex/escaped.ts:2:24 - Buffer is a Node global, which the default runtime does not provide.',
      'convex/lib/_generated/gen.ts:1:24 - Buffer is a Node global, which the default runtime does not provide.',
      'convex/schema.ts:2:24 - Buffer is a Node global, which the default runtime does not provide.',
      'convex/lib/bytes.helpers.ts:1:39 - Buffer is a Node global, which the default runtime does not provide.',
    ])
  })

  it('follows imports when TypeScript reports its paths in lowercase, as it does on macOS and Windows', () => {
    const { status, output } = typecheck(
      {
        'Encode.ts': `'use node'\n${usesBuffer}`,
        'Site.ts': [
          "import { encoded } from './Encode'",
          "import { size } from './lib/Bytes.helpers'",
          'export const both = [encoded, size(encoded)]',
          '',
        ].join('\n'),
        'lib/Bytes.helpers.ts': 'export const size = (text: string) => Buffer.byteLength(text)\n',
        '../lowercase-paths.mjs': lowercasePaths,
        '../register-lowercase-paths.mjs': registerLowercasePaths,
      },
      { NODE_OPTIONS: '--import ./register-lowercase-paths.mjs' },
    )
    expect(status).toBe(1)
    expect(output.split('\n').filter((line) => line.startsWith('convex/'))).toEqual([
      "convex/Site.ts:1:25 - ./Encode starts with 'use node', and the default runtime cannot run it.",
      'convex/lib/Bytes.helpers.ts:1:39 - Buffer is a Node global, which the default runtime does not provide.',
    ])
  })
})

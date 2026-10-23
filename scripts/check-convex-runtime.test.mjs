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
 * repository's scripts and these convex/ files, and runs its
 * `npm run typecheck:convex` there, which is the one package.json holds.
 */
function typecheck(files) {
  repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qivo-convex-runtime-')))
  const contents = {
    'package.json': JSON.stringify({
      scripts: { 'typecheck:convex': scripts['typecheck:convex'] },
    }),
    'convex/tsconfig.json': fs.readFileSync(path.join(root, 'convex/tsconfig.json'), 'utf8'),
    'convex/env.d.ts': fs.readFileSync(path.join(root, 'convex/env.d.ts'), 'utf8'),
    ...Object.fromEntries(
      Object.entries(files).map(([file, source]) => [`convex/${file}`, source]),
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
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (result.error) throw result.error
  return { status: result.status, output: result.stdout + result.stderr }
}

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

  it('passes the same code in a Node file, a file only Node files import, and a test', () => {
    const { status, output } = typecheck({
      'encode.ts': `'use node'\n${usesBuffer}`,
      'lib/bytes.ts': 'export const size = (text: string) => Buffer.byteLength(text)\n',
      'measure.ts':
        "'use node'\nimport { size } from './lib/bytes'\nexport const bytes = size('x')\n",
      'tests/encode.test.ts': usesBuffer,
      'site.ts': "export const site = new URL('https://qivo.io')\n",
    })
    expect(output).toBe("1 convex/ files use only the default runtime's globals; 3 run in Node.\n")
    expect(status).toBe(0)
  })

  it('fails when it finds no file that runs in the default runtime', () => {
    const { status, output } = typecheck({ 'encode.ts': `'use node'\n${usesBuffer}` })
    expect(status).toBe(1)
    expect(output).toContain('holds no convex/ file that runs in the default runtime.')
  })

  it('checks a file that both kinds import in the default runtime', () => {
    const { status, output } = typecheck({
      'lib/bytes.ts': 'export const size = (text: string) => Buffer.byteLength(text)\n',
      'measure.ts':
        "'use node'\nimport { size } from './lib/bytes'\nexport const bytes = size('x')\n",
      'count.ts': "import { size } from './lib/bytes'\nexport const bytes = size('y')\n",
    })
    expect(status).toBe(1)
    expect(output).toContain('convex/lib/bytes.ts:1:39 - Buffer is a Node global')
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
      'node.ts': [
        "import { createHash } from 'node:crypto'",
        "import type { Readable } from 'stream'",
        "export const hash = createHash('sha256')",
        'export const directory = process.cwd()',
        'export let stream: Readable | undefined',
        'export const later = (run: () => void) => setImmediate(run)',
        '',
      ].join('\n'),
    })
    expect(status).toBe(1)
    expect(output.split('\n').filter((line) => line.startsWith('convex/'))).toEqual([
      'convex/node.ts:1:28 - node:crypto is a Node module, which the default runtime does not provide.',
      'convex/node.ts:2:31 - stream is a Node module, which the default runtime does not provide.',
      'convex/node.ts:4:26 - process holds only env in the default runtime, so read process.env.',
      'convex/node.ts:6:43 - setImmediate is a Node global, which the default runtime does not provide.',
    ])
  })
})

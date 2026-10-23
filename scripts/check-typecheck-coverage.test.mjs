import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./check-typecheck-coverage.mjs', import.meta.url))

const options = { noEmit: true, skipLibCheck: true, strict: true, lib: ['ES2022'], types: [] }

let repository = ''
afterEach(() => fs.rmSync(repository, { recursive: true, force: true }))

/** Writes a Git repository with two typechecks, one followed through `npm run`, and these extra files. */
function setUp(files = {}) {
  repository = fs.mkdtempSync(path.join(os.tmpdir(), 'qivo-typecheck-coverage-'))
  const fixture = {
    'package.json': JSON.stringify({
      scripts: {
        'verify:local': 'npm run lint && npm run typecheck && npm run build',
        lint: 'biome lint .',
        typecheck: 'tsc --noEmit && tsc -p tools',
        build: 'tsc --noEmit && vite build',
        // verify:local does not run this one
        'typecheck:other': 'tsc -p other/tsconfig.json',
      },
    }),
    '.github/workflows/ci.yml': 'steps:\n  - run: npm run typecheck\n  - run: npm run build\n',
    '.gitignore': 'dev-temp/\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: options, include: ['src'] }),
    'tools/tsconfig.json': JSON.stringify({ compilerOptions: options, include: ['*.mts'] }),
    'other/tsconfig.json': JSON.stringify({ compilerOptions: options, include: ['*.ts'] }),
    'src/main.ts':
      "import { helper } from '../lib/helper'\nexport const value: number = helper()\n",
    // in the program by import only
    'lib/helper.ts': 'export const helper = () => 1\n',
    'src/globals.d.ts': 'declare const buildId: string\n',
    'tools/config.mts': 'export default {}\n',
    // ignored by Git
    'dev-temp/scratch.ts': 'export {}\n',
    ...files,
  }
  for (const [file, source] of Object.entries(fixture)) {
    const target = path.join(repository, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, source)
  }
  execFileSync('git', ['init', '-q'], { cwd: repository })
}

/** Runs the check in the repository and returns its exit status and output. */
function check() {
  const result = spawnSync(process.execPath, [script], {
    cwd: repository,
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { status: result.status, output: result.stdout + result.stderr }
}

describe('typecheck coverage', () => {
  it('passes when every TypeScript file is in a program verify:local typechecks', () => {
    setUp()
    expect(check()).toEqual({
      status: 0,
      output: '4 TypeScript files are in the typechecks of 2 configs.\n',
    })
  })

  it('names a new file in no typecheck and one in a typecheck verify:local does not run', () => {
    setUp({ 'scripts/new.ts': 'export {}\n', 'other/old.ts': 'export {}\n' })
    const { status, output } = check()
    expect(status).toBe(1)
    expect(output).toContain('scripts/new.ts is in no typecheck that verify:local runs.')
    expect(output).toContain('other/old.ts is in no typecheck that verify:local runs.')
    expect(output).not.toContain('lib/helper.ts')
  })

  it('names a typecheck that CI does not run', () => {
    setUp({ '.github/workflows/ci.yml': 'steps:\n  - run: npm run build\n' })
    expect(check()).toMatchObject({
      status: 1,
      output: expect.stringContaining('ci.yml does not run `npm run typecheck`'),
    })
  })

  it('finds an error inside a declaration file that skipLibCheck hides', () => {
    setUp({ 'src/globals.d.ts': 'declare const buildId: MissingType\n' })
    expect(check()).toMatchObject({
      status: 1,
      output: expect.stringMatching(
        /globals\.d\.ts\(1,24\): error TS2304: Cannot find name 'MissingType'/,
      ),
    })
  })

  it('checks a declaration file with the @types packages its project finds', () => {
    setUp({
      '.gitignore': 'dev-temp/\nnode_modules/\n',
      'tools/tsconfig.json': JSON.stringify({
        compilerOptions: { ...options, types: ['fake'] },
        include: ['*.mts'],
      }),
      'node_modules/@types/fake/index.d.ts': 'declare namespace Fake {\n  type Id = string\n}\n',
      'tools/env.d.mts': 'export declare const id: Fake.Id\n',
    })
    expect(check()).toEqual({
      status: 0,
      output: '5 TypeScript files are in the typechecks of 2 configs.\n',
    })
    expect(fs.readdirSync(path.join(repository, 'tools'))).not.toContainEqual(
      expect.stringMatching(/^tsconfig\.coverage-/),
    )
  })
})

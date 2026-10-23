import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const script = fileURLToPath(new URL('./check-typecheck-coverage.mjs', import.meta.url))
const typescript = path.dirname(createRequire(import.meta.url).resolve('typescript/package.json'))

const options = { noEmit: true, skipLibCheck: true, strict: true, lib: ['ES2022'], types: [] }

let repository = ''
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(repository, { recursive: true, force: true })
})

/**
 * Returns an environment without the Git variables a Git hook exports, such
 * as GIT_DIR, and without the machine's Git configuration and ignore files.
 */
function isolated() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  )
  return { ...env, HOME: repository, XDG_CONFIG_HOME: repository, GIT_CONFIG_NOSYSTEM: '1' }
}

/** Writes files under a directory, creating their folders. */
function write(root, files) {
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, source)
  }
}

/**
 * Writes a Git repository with two typechecks, one followed through `npm run`,
 * the repository's TypeScript and these extra files.
 */
function setUp(files = {}) {
  repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qivo-typecheck-coverage-')))
  write(repository, {
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
    '.gitignore': 'dev-temp/\nnode_modules/\n',
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
  })
  if (!fs.existsSync(path.join(repository, 'node_modules/typescript'))) {
    fs.mkdirSync(path.join(repository, 'node_modules'), { recursive: true })
    fs.symlinkSync(typescript, path.join(repository, 'node_modules/typescript'))
  }
  execFileSync('git', ['init', '-q'], { cwd: repository, env: isolated() })
}

/** Runs the check in the repository, or through a path to it, and returns its exit status and output. */
function check(cwd = repository) {
  const result = spawnSync(process.execPath, [script], {
    cwd,
    env: { ...isolated(), PWD: cwd },
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { status: result.status, output: result.stdout + result.stderr }
}

// The check runs tsc, which takes over a second on a loaded machine.
describe('typecheck coverage', { timeout: 30_000 }, () => {
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
      output: expect.stringContaining(
        "tsconfig.json: src/globals.d.ts:1:24 - error TS2304: Cannot find name 'MissingType'.",
      ),
    })
  })

  it('treats name.d.css.ts as a declaration file', () => {
    setUp({ 'src/button.d.css.ts': 'export declare const button: MissingType\n' })
    expect(check()).toMatchObject({
      status: 1,
      output: expect.stringContaining('src/button.d.css.ts:1:30 - error TS2304'),
    })
  })

  it.each([
    ['passes', 'Id', 0, '5 TypeScript files are in the typechecks of 2 configs.'],
    ['fails', 'Missing', 1, "error TS2694: Namespace 'Fake' has no exported member 'Missing'."],
  ])(
    '%s on a declaration file that uses the @types packages its project finds',
    (_, member, status, output) => {
      setUp({
        'tools/tsconfig.json': JSON.stringify({
          compilerOptions: { ...options, types: ['fake'] },
          include: ['*.mts'],
        }),
        'node_modules/@types/fake/index.d.ts': 'declare namespace Fake {\n  type Id = string\n}\n',
        'tools/env.d.mts': `export declare const id: Fake.${member}\n`,
      })
      expect(check()).toMatchObject({ status, output: expect.stringContaining(output) })
    },
  )

  it('finds a declaration file that conflicts with a library its program imports', () => {
    setUp({
      'src/main.ts': "import 'clock'\nexport const value: number = 1\n",
      'src/globals.d.ts': 'declare var tick: { at: string }\n',
      'node_modules/clock/package.json': JSON.stringify({ name: 'clock', types: 'index.d.ts' }),
      'node_modules/clock/index.d.ts':
        'declare global {\n  var tick: { at: number }\n}\nexport {}\n',
    })
    // tsc reports the conflict at the library, which comes later in the program.
    const { status, output } = check()
    expect(status).toBe(1)
    expect(output).toMatch(/node_modules\/clock\/index\.d\.ts:2:7 - error TS2403: /)
    expect(output).toContain("src/globals.d.ts:1:13 - 'tick' was also declared here.")
  })

  it('checks a declaration file in every program that holds it', () => {
    setUp({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...options, strict: false },
        include: ['src'],
      }),
      'tools/tsconfig.json': JSON.stringify({
        compilerOptions: options,
        include: ['*.mts', '../src/globals.d.ts'],
      }),
      'src/globals.d.ts': 'declare function stamp(value): string\n',
    })
    const { status, output } = check()
    expect(status).toBe(1)
    expect(output).toContain('tools/tsconfig.json: src/globals.d.ts:1:24 - error TS7006: ')
    expect(output).not.toMatch(/^tsconfig\.json: /m)
  })

  it('fails on an error that names no file', () => {
    setUp({
      'tools/tsconfig.json': JSON.stringify({
        compilerOptions: { ...options, types: ['missing'] },
        include: ['*.mts'],
      }),
      'tools/env.d.mts': 'export declare const id: string\n',
    })
    expect(check()).toMatchObject({
      status: 1,
      output: expect.stringContaining(
        "tools/tsconfig.json: error TS2688: Cannot find type definition file for 'missing'.",
      ),
    })
  })

  it.each([
    ['is killed', "process.kill(process.pid, 'SIGKILL')"],
    ['exits 1 without a report', 'process.exit(1)'],
    [
      'stops after an error line',
      "console.log('src/globals.d.ts:1:1 - error TS1: x'); process.exit(2)",
    ],
  ])('fails when tsc %s', (_, stop) => {
    // A stand-in tsc lists the program and stops on the full check.
    setUp({
      'node_modules/typescript/package.json': JSON.stringify({ name: 'typescript' }),
      'node_modules/typescript/bin/tsc': [
        "const { execFileSync } = require('node:child_process')",
        "if (!process.argv.includes('--skipLibCheck'))",
        `  process.stdout.write(execFileSync(process.execPath, [${JSON.stringify(path.join(typescript, 'bin/tsc'))}, ...process.argv.slice(2)]))`,
        `else {\n  ${stop}\n}`,
      ].join('\n'),
    })
    expect(check()).toMatchObject({
      status: 1,
      output: expect.stringContaining('tsc did not finish checking tsconfig.json'),
    })
  })

  it('passes when run through a symlinked path', () => {
    setUp()
    const link = `${repository}-link`
    fs.symlinkSync(repository, link)
    try {
      expect(check(link)).toMatchObject({ status: 0 })
    } finally {
      fs.rmSync(link)
    }
  })

  it('leaves the repository alone when a Git hook exports GIT_DIR', () => {
    // A pre-push hook in a linked worktree gets the worktree's GIT_DIR.
    const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qivo-typecheck-outer-')))
    try {
      const git = (...args) =>
        execFileSync(
          'git',
          [
            '-c',
            'user.name=t',
            '-c',
            'user.email=t@example.com',
            '-c',
            'init.defaultBranch=main',
            ...args,
          ],
          {
            cwd: outer,
            env: { ...process.env, HOME: outer, XDG_CONFIG_HOME: outer, GIT_DIR: undefined },
          },
        )
      git('init', '-q', 'main')
      git('-C', 'main', 'commit', '-q', '--allow-empty', '-m', 'first')
      git('-C', 'main', 'worktree', 'add', '-q', '../linked')
      vi.stubEnv('GIT_DIR', path.join(outer, 'main/.git/worktrees/linked'))
      setUp()
      expect(check()).toMatchObject({ status: 0 })
      expect(fs.existsSync(path.join(repository, '.git'))).toBe(true)
      expect(fs.readFileSync(path.join(outer, 'main/.git/config'), 'utf8')).toContain(
        'bare = false',
      )
    } finally {
      fs.rmSync(outer, { recursive: true, force: true })
    }
  })
})

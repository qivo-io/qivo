import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dependencyDrift } from './dependency-drift.mjs'

describe('dependencyDrift', () => {
  const roots = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /** A project whose lockfile names `locked` and whose node_modules holds `installed`. */
  function project(locked, installed, directory = '.') {
    const root = mkdtempSync(join(tmpdir(), 'qivo-dependency-drift-'))
    roots.push(root)
    mkdirSync(join(root, directory), { recursive: true })
    const packages = { '': { name: 'fixture' }, ...locked }
    writeFileSync(
      join(root, directory, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages }),
    )
    for (const [path, version] of Object.entries(installed)) {
      mkdirSync(join(root, directory, path), { recursive: true })
      writeFileSync(join(root, directory, path, 'package.json'), JSON.stringify({ version }))
    }
    return root
  }

  const locked = {
    'node_modules/vitest': { version: '4.1.12', dev: true },
    'node_modules/a/node_modules/b': { version: '2.0.0' },
    'node_modules/@biomejs/cli-darwin-arm64': { version: '2.5.13', optional: true },
    'node_modules/@biomejs/cli-linux-x64': { version: '2.5.13', optional: true },
    'node_modules/a': { version: '1.0.0' },
  }
  const matching = {
    'node_modules/vitest': '4.1.12',
    'node_modules/a': '1.0.0',
    'node_modules/a/node_modules/b': '2.0.0',
    'node_modules/@biomejs/cli-linux-x64': '2.5.13',
  }

  it('passes an install that matches the lockfile, without the other platforms', () => {
    const root = project(locked, matching)
    // npm's own folders and files, which are not packages
    mkdirSync(join(root, 'node_modules/.bin'))
    writeFileSync(join(root, 'node_modules/.package-lock.json'), '{}')
    expect(dependencyDrift(root)).toEqual([])
  })

  it('names a locked package that is missing, including a nested one', () => {
    const { 'node_modules/a/node_modules/b': _, 'node_modules/vitest': __, ...rest } = matching
    expect(dependencyDrift(project(locked, rest))).toEqual([
      'node_modules/vitest is not installed (locked 4.1.12)',
      'node_modules/a/node_modules/b is not installed (locked 2.0.0)',
    ])
  })

  it('names a package installed at another version, an optional one too', () => {
    const older = {
      ...matching,
      'node_modules/vitest': '4.1.11',
      'node_modules/@biomejs/cli-linux-x64': '2.5.12',
    }
    expect(dependencyDrift(project(locked, older))).toEqual([
      'node_modules/vitest is 4.1.11, but the lockfile has 4.1.12',
      'node_modules/@biomejs/cli-linux-x64 is 2.5.12, but the lockfile has 2.5.13',
    ])
  })

  it('names an installed package the lockfile does not name, a nested one too', () => {
    const extra = {
      ...matching,
      // left by an older lockfile, it shadows the hoisted vite for vitest
      'node_modules/vitest/node_modules/vite': '8.3.3',
      'node_modules/@types/removed': '1.0.0',
    }
    expect(dependencyDrift(project(locked, extra))).toEqual([
      'node_modules/@types/removed is installed, but the lockfile does not name it',
      'node_modules/vitest/node_modules/vite is installed, but the lockfile does not name it',
    ])
  })

  it('names an installed package.json that is not JSON', () => {
    const root = project(locked, matching)
    writeFileSync(join(root, 'node_modules/a/package.json'), '{"version": "1.0')
    expect(dependencyDrift(root)).toEqual(['node_modules/a/package.json is not valid JSON'])
  })

  it('names the problems of a subdirectory by their path from the root', () => {
    const root = project({ 'node_modules/electron-updater': { version: '6.8.3' } }, {}, 'desktop')
    expect(dependencyDrift(root, 'desktop')).toEqual([
      'desktop/node_modules/electron-updater is not installed (locked 6.8.3)',
    ])
  })

  it('refuses a lockfile without a packages map, or one that is not JSON', () => {
    const root = project({}, {})
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 1 }))
    expect(() => dependencyDrift(root)).toThrow('package-lock.json has no packages map')
    mkdirSync(join(root, 'desktop'))
    writeFileSync(join(root, 'desktop/package-lock.json'), '<<<<<<< HEAD\n{}')
    expect(() => dependencyDrift(root, 'desktop')).toThrow(
      'desktop/package-lock.json is not valid JSON.',
    )
  })
})

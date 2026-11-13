import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkoutEnvironment } from '../git.mjs'
import { checkoutOf, programsFor } from './page.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

let temporary = ''
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(temporary, { recursive: true, force: true })
})

describe('the programs of a stand-in workspace', () => {
  it('keeps the Board the app opens within its 1,000 tasks', () => {
    expect([10, 1000, 1200, 3400, 10_000].map(programsFor)).toEqual([1, 1, 2, 4, 10])
  })
})

/** The values module `path` of the repository exports, by name: its
    exported constants, destructured ones too, functions and classes, not
    its types. */
function exportedValues(path) {
  const text = readFileSync(join(root, path), 'utf8')
  const names = new Set()
  for (const [, list] of text.matchAll(/^export const \{([^}]+)\}/gm))
    for (const name of list.split(',')) names.add(name.split(':').at(-1).trim())
  for (const [, name] of text.matchAll(/^export (?:const|let|class|(?:async )?function) (\w+)/gm))
    names.add(name)
  return names
}

describe('the benchmark transport', () => {
  it('exports every value of src/lib/auth.ts and src/lib/convex.ts, which it stands in for', () => {
    // the page build maps both modules to it (page.mjs), so a value it
    // lacks fails the build when the store imports it
    const transport = exportedValues('scripts/perf/transport.mjs')
    for (const path of ['src/lib/auth.ts', 'src/lib/convex.ts']) {
      const wanted = [...exportedValues(path)]
      expect(wanted.length, path).toBeGreaterThan(1)
      expect(
        wanted.filter((name) => !transport.has(name)),
        path,
      ).toEqual([])
    }
  })
})

describe('the baseline checkout', () => {
  it("archives the commit from root's repository when GIT_DIR names another", async () => {
    temporary = mkdtempSync(join(tmpdir(), 'qivo-perf-checkout-'))
    const other = join(temporary, 'other')
    execFileSync('git', ['init', '-q', other], { env: checkoutEnvironment() })
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      env: checkoutEnvironment(),
      encoding: 'utf8',
    }).trim()
    vi.stubEnv('GIT_DIR', join(other, '.git'))
    const folder = await checkoutOf(root, commit, temporary)
    expect(existsSync(join(folder, 'scripts/perf/page.mjs'))).toBe(true)
  })
})

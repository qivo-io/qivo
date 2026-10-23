import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeProblem } from './limits.mjs'

/* Scripts load the TypeScript limits registry only through scripts/limits.mjs,
 * which names the Node to use instead of failing on an unknown extension, and
 * the workspace reader through scripts/workspaceJoin.mjs, which checks the
 * Node through it. */
describe('the limits registry for Node scripts', () => {
  it('accepts Node 24 or later that loads TypeScript', () => {
    expect(nodeProblem('x.mjs', 'v24.21.0', 'strip')).toBeNull()
    expect(nodeProblem('x.mjs', 'v25.1.0', 'strip')).toBeNull()
  })

  it('names Node 24 for an older Node or one that cannot load TypeScript', () => {
    expect(nodeProblem('x.mjs', 'v22.23.3', 'strip')).toBe(
      'x.mjs needs Node 24 (package.json engines). This is Node v22.23.3. Switch to Node 24 and run it again.',
    )
    expect(nodeProblem('x.mjs', 'v24.21.0', false)).toMatch(
      /^x\.mjs needs Node 24 with TypeScript support\. This Node v24\.21\.0 cannot load TypeScript files\./,
    )
  })

  it('stops a script that reaches the registry through other modules with that sentence', () => {
    // docs-contract.mjs reaches it through limits-docs.mjs; the flag gives
    // this Node what a Node without TypeScript support has
    for (const script of ['scripts/staging-check.mjs', 'scripts/docs-contract.mjs']) {
      const run = spawnSync(process.execPath, ['--no-experimental-strip-types', script], {
        encoding: 'utf8',
      })
      expect(run.status).toBe(1)
      expect(run.stderr).toMatch(/needs Node 24 with TypeScript support/)
    }
  })

  it('are the only Node scripts that import a TypeScript file', () => {
    const importsTs = /(?:from\s*|import\s*\(\s*|import\s+)['"]\.{1,2}\/[^'"]*\.(?:ts|mts|tsx)['"]/
    const scripts = ['scripts', 'website/scripts'].flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
        .map((name) => join(dir, name)),
    )
    const found = scripts.filter((file) => importsTs.test(readFileSync(file, 'utf8')))
    expect(found).toEqual([
      'scripts/limits.mjs',
      'scripts/liveParts.mjs',
      'scripts/workspaceJoin.mjs',
    ])
  })
})

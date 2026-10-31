import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkoutEnvironment } from '../git.mjs'
import { checkoutOf } from './page.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

let temporary = ''
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(temporary, { recursive: true, force: true })
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
    // the app imports the vendored Convex Better Auth adapter
    expect(existsSync(join(folder, 'vendor/convex-better-auth/src/client/plugins'))).toBe(true)
  })
})

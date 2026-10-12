import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { apiModuleDrift } from './convex-api-modules.mjs'

const convexDir = fileURLToPath(new URL('../convex/', import.meta.url))

describe('convex/_generated/api.d.ts', () => {
  let copy
  afterEach(() => {
    if (copy) rmSync(copy, { recursive: true, force: true })
    copy = undefined
  })

  /** A small Convex directory: path → contents, plus an api.d.ts listing `listed`. */
  function fixture(files, listed) {
    copy = mkdtempSync(join(tmpdir(), 'qivo-convex-api-'))
    const all = {
      ...files,
      '_generated/api.d.ts': listed
        .map((m) => `import type * as ${m.replace(/\W/g, '_')} from "../${m}.js";`)
        .join('\n'),
    }
    for (const [path, text] of Object.entries(all)) {
      mkdirSync(dirname(join(copy, path)), { recursive: true })
      writeFileSync(join(copy, path), text)
    }
    return apiModuleDrift(copy)
  }

  it('lists every module of the real backend', () => {
    expect(apiModuleDrift(convexDir)).toEqual({ missing: [], extra: [] })
  })

  it('reports a module the file lacks and one it lists that no longer exists', () => {
    const drift = fixture(
      { 'issues.ts': 'export const a = 1', 'lib/keys.ts': 'export const b = 2' },
      ['issues', 'gone'],
    )
    expect(drift).toEqual({ missing: ['lib/keys'], extra: ['gone'] })
  })

  it('skips what codegen skips', () => {
    const drift = fixture(
      {
        'issues.ts': 'export const a = 1',
        'schema.ts': 'export default {}',
        'auth.config.ts': 'export default {}',
        'tests/issues.test.ts': 'import {} from "vitest"',
        'env.d.ts': 'declare const x: number',
        'notes.ts': '// no import or export',
        'component/convex.config.ts': 'export default {}',
        'component/inner.ts': 'export const c = 3',
      },
      ['issues'],
    )
    expect(drift).toEqual({ missing: [], extra: [] })
  })
})

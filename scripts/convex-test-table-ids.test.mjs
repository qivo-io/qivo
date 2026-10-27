import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CONVEX_TEST_VERSION, convexTestTableIds, withTableIds } from './convex-test-table-ids.mjs'

const file = fileURLToPath(new URL('../node_modules/convex-test/dist/index.js', import.meta.url))
const installed = readFileSync(file, 'utf8')
const { version } = JSON.parse(
  readFileSync(new URL('../node_modules/convex-test/package.json', import.meta.url), 'utf8'),
)

describe('withTableIds', () => {
  it('applies convex/convex-test#154 to the installed convex-test without moving a line', () => {
    expect(version).toBe(CONVEX_TEST_VERSION)
    const patched = withTableIds(installed, version)
    expect(patched).toContain('const ids = new Set(this._tableIds.get(tableName));')
    expect(patched).not.toContain('Object.keys(this._documents)')
    expect(patched.split('\n')).toHaveLength(installed.split('\n').length)
  })

  it('refuses another convex-test version', () => {
    expect(() => withTableIds(installed, '0.0.59')).toThrow(
      'convex-test is 0.0.59, but scripts/convex-test-table-ids.mjs patches 0.0.58',
    )
  })

  it('refuses code where an edited line is missing or appears twice', () => {
    const missing = installed.replace(
      'delete this._documents[_id];',
      'this._documents.delete(_id);',
    )
    expect(() => withTableIds(missing, version)).toThrow(
      'has 0 copies of `delete this._documents[_id];`',
    )
    const twice = `${installed}\n    _documents = {};\n`
    expect(() => withTableIds(twice, version)).toThrow('has 2 copies of `_documents = {};`')
  })
})

describe('convexTestTableIds', () => {
  const { transform } = convexTestTableIds()

  it('patches dist/index.js of convex-test and no other module', () => {
    expect(transform(installed, file).code).toBe(withTableIds(installed, version))
    expect(transform(installed, `${file}?v=1`).code).toBe(withTableIds(installed, version))
    const other = file.replace('/dist/index.js', '/dist/transactionMetrics.js')
    expect(transform(installed, other)).toBeNull()
  })
})

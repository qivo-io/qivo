import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/* Applies convex/convex-test#154 to the installed convex-test as Vitest loads
   it, until a convex-test release includes that change.

   On every query, convex-test 0.0.58 lists the ids of the committed documents
   in every table and keeps those of the queried table. #154 keeps a set of
   committed ids per table, updated where commit() writes documents, and
   starts each query from the queried table's set. Results keep their order,
   because a Set keeps insertion order as Object.keys did for these ids.

   Each edit stays on its line, so line numbers in stack traces still match
   the installed file. The patch refuses any other convex-test version, and
   an edit that does not match exactly one place, so an upgrade fails here
   until someone checks it. Delete this file, its declarations, its test and
   its use in vitest.config.mts once the installed convex-test includes #154. */

/** The convex-test version that these edits were checked against. */
export const CONVEX_TEST_VERSION = '0.0.58'

/** Each edit to dist/index.js, as the text it replaces and its replacement. */
const EDITS = [
  // DatabaseFake gets the committed ids of each table.
  ['_documents = {};', '_documents = {}; _tableIds = new Map();'],
  // commit() drops the id of a deleted document from its table's set...
  [
    'delete this._documents[_id];',
    'delete this._documents[_id]; this._tableIds.get(tableNameFromId(_id))?.delete(_id);',
  ],
  // ...and adds the id of an inserted or changed one.
  [
    'commitTs === null ? write : resolveCommittedValues(write, commitTs);',
    'commitTs === null ? write : resolveCommittedValues(write, commitTs); { const table = tableNameFromId(_id); (this._tableIds.get(table) ?? this._tableIds.set(table, new Set()).get(table)).add(_id); }',
  ],
  // _iterateDocs starts from the queried table's ids.
  [
    'const ids = new Set(Object.keys(this._documents).filter(isInTable));',
    'const ids = new Set(this._tableIds.get(tableName));',
  ],
]

/**
 * Returns convex-test's dist/index.js with #154 applied.
 *
 * Throws when `version` is not CONVEX_TEST_VERSION, or when the text an edit
 * replaces is missing from `code` or appears more than once.
 */
export function withTableIds(code, version) {
  if (version !== CONVEX_TEST_VERSION) {
    throw new Error(
      `convex-test is ${version}, but scripts/convex-test-table-ids.mjs patches ${CONVEX_TEST_VERSION}. ` +
        `If ${version} includes convex/convex-test#154, delete the patch as that file says. ` +
        `Otherwise check its edits against ${version} and update CONVEX_TEST_VERSION.`,
    )
  }
  for (const [from, to] of EDITS) {
    const count = code.split(from).length - 1
    if (count !== 1) {
      throw new Error(
        `convex-test ${version} has ${count} copies of \`${from}\`, so scripts/convex-test-table-ids.mjs ` +
          'cannot apply convex/convex-test#154. Check its edits against this file.',
      )
    }
    code = code.replace(from, () => to)
  }
  return code
}

/** A Vite plugin that applies withTableIds to convex-test's dist/index.js. */
export function convexTestTableIds() {
  return {
    name: 'qivo:convex-test-table-ids',
    transform(code, id) {
      const file = id.split('?')[0]
      if (!file.endsWith('/node_modules/convex-test/dist/index.js')) return null
      const manifest = JSON.parse(readFileSync(join(dirname(file), '..', 'package.json'), 'utf8'))
      // No edit moves code to another line, so the source map stays valid.
      return { code: withTableIds(code, manifest.version), map: null }
    },
  }
}

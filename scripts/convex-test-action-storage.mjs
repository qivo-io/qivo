import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/* Gives each file write of an action a transaction of its own in the
   installed convex-test, as Vitest loads it, until a convex-test release
   does the same.

   convex-test 0.0.58 (and 0.0.66, the latest on 2026-11-01) runs a file
   write (ctx.storage.store or delete) in a transaction of its own only when
   no function holds its global lock, and otherwise inside the transaction
   that is open. In a mutation, or a t.run handler, that is the caller's
   own. In an action it can be another function's. While the action's write
   awaits the file's SHA-256, that function commits or rolls back, and the
   write then throws "Write outside of transaction", or is lost when that
   transaction rolls back, as a query's always does. Two actions that store
   files at once, as two export steps of orgExportJob.test.ts do, fail that
   way by timing alone.

   The edit asks instead whether the write runs inside a query or mutation
   of its own async context, which convex-test already tracks for nested
   calls (nestedTxStorage). An action's write then waits for the lock and
   takes a transaction of its own, as an action's schedule and cancel
   already do, and a mutation's write still joins the mutation.

   The edit stays on its line, so line numbers in stack traces still match
   the installed file. The patch refuses any other convex-test version, and
   an edit that does not match exactly one place, so an upgrade fails here
   until someone checks it. Delete this file, its declarations, its test and
   its use in vitest.config.mts once the installed convex-test decides this
   by the caller's context. */

/** The convex-test version that the edit was checked against. */
export const CONVEX_TEST_VERSION = '0.0.58'

/** The edit to dist/index.js, as the text it replaces and its replacement.
 * writeToDatabase then opens a transaction unless its caller runs in one. */
const EDIT = [
  'if (!getTransactionManager().isInTransaction()) {',
  'if (nestedTxStorage.getStore() === undefined) {',
]

/**
 * Returns convex-test's dist/index.js with an action's file writes in
 * transactions of their own.
 *
 * Throws when `version` is not CONVEX_TEST_VERSION, or when the text the
 * edit replaces is missing from `code` or appears more than once.
 */
export function withActionStorage(code, version) {
  if (version !== CONVEX_TEST_VERSION) {
    throw new Error(
      `convex-test is ${version}, but scripts/convex-test-action-storage.mjs patches ${CONVEX_TEST_VERSION}. ` +
        `If ${version} runs an action's file writes in transactions of their own, delete the patch as that file says. ` +
        `Otherwise check its edit against ${version} and update CONVEX_TEST_VERSION.`,
    )
  }
  const [from, to] = EDIT
  const count = code.split(from).length - 1
  if (count !== 1) {
    throw new Error(
      `convex-test ${version} has ${count} copies of \`${from}\`, so scripts/convex-test-action-storage.mjs ` +
        'cannot give an action its own transaction for a file write. Check its edit against this file.',
    )
  }
  return code.replace(from, () => to)
}

/** A Vite plugin that applies withActionStorage to convex-test's dist/index.js. */
export function convexTestActionStorage() {
  return {
    name: 'qivo:convex-test-action-storage',
    transform(code, id) {
      const file = id.split('?')[0]
      if (!file.endsWith('/node_modules/convex-test/dist/index.js')) return null
      const manifest = JSON.parse(readFileSync(join(dirname(file), '..', 'package.json'), 'utf8'))
      // The edit moves no code to another line, so the source map stays valid.
      return { code: withActionStorage(code, manifest.version), map: null }
    },
  }
}

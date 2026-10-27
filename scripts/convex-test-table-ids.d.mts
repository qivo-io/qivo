import type { Plugin } from 'vite'

/** The convex-test version that the edits of convex/convex-test#154 were checked against. */
export const CONVEX_TEST_VERSION: string

/** convex-test's dist/index.js with convex/convex-test#154 applied. Throws on
 * another version, or when an edit does not match exactly one place. */
export function withTableIds(code: string, version: string): string

/** A Vite plugin that applies withTableIds to convex-test's dist/index.js. */
export function convexTestTableIds(): Plugin

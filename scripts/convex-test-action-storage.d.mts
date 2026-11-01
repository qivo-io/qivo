import type { Plugin } from 'vite'

/** The convex-test version that the edit was checked against. */
export const CONVEX_TEST_VERSION: string

/** convex-test's dist/index.js with an action's file writes in transactions
 * of their own. Throws on another version, or when the edit does not match
 * exactly one place. */
export function withActionStorage(code: string, version: string): string

/** A Vite plugin that applies withActionStorage to convex-test's dist/index.js. */
export function convexTestActionStorage(): Plugin

/* The globals of the Convex runtimes. Most functions run in a V8 isolate,
 * not Node, but this program also holds the Node actions ('use node'), and
 * sharp's types bring @types/node in through them. A program has one set of
 * globals, so process, URL, the fetch classes and console come from Node's
 * types. This names that dependency instead of declaring them again, which
 * conflicted with Node's declarations. Node's types also accept Buffer or
 * require anywhere, so scripts/check-convex-runtime.mjs, which
 * `npm run typecheck:convex` runs after tsc, fails on a Node global or module
 * in a file that runs in the isolate. */
/// <reference types="node" />

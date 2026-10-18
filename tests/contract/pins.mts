/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '1cbde0a73604d3b8fd94377c9c1ca4bfec688a67e7b6662ea8d80b5a27218aba'
export const SHA_TOOLS_MODERN = '1b272a08ba20b172fac13ead05d702a1753bd51793219bf06e5fb557fee39e2e'

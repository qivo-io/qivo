/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '003c10dfbe1aab118ede84794f5460c43037bb22d2e1269e603561e8f5fede19'
export const SHA_TOOLS_MODERN = 'f8d73f60e5f31a6a670d0371d7431183f0d6986d325c091972af682d3f0d5d9f'

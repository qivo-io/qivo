/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'ea5017f37c870a27e0ff60d5711a3b08e28af4e44cdfdbb893b66f7f8d29ddc0'
export const SHA_TOOLS_MODERN = '70b6f38947ef4585026deac0f201ffd5c5ed538cf370928b11521ee4682777a9'

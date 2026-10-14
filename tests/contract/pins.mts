/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '5b8932a1511c74bb1007c2043db4d680068ae967c1f381fd388796890f001f9d'
export const SHA_TOOLS_MODERN = 'b2ffaf8a7a8f14ddd1270a8d91ab7485d7a83e843b41e1a109e659233954d84e'

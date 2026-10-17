/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'b32161b6726fc9d3079759f564730b8d988a8f12a1af38a053954332c002d4e4'
export const SHA_TOOLS_MODERN = '45f7f0195660fdc87b997bde8d85e36ea78f4ce89781e9fe453b01f1afa13ae1'

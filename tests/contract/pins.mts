/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '4550286c23431dd39cb24a0908dfdf254bce2bddb8105ab1c7cece283df2e516'
export const SHA_TOOLS_MODERN = '42c373f05e42dc8e90acfc6a5f04893845da2ad2b6d0cf7ddf706234c1df6f00'

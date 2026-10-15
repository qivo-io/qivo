/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '146612031e95a7b4f21719025aa23a39b8644a67cdd4dc7625bd72841765bee2'
export const SHA_TOOLS_MODERN = '33a02ed7dcd30c6697eb2676fe5551751a90f20ef572fd5b5b968475de925bc3'

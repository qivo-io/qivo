/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'b0f8ae8edb17714d0897f51d18fdb33c53d1d669606e14a8d59d1dd4f0aca71b'
export const SHA_TOOLS_MODERN = 'bc1e01f580186ea4a09a4bdb5fa2b6deb72c3082ff7415a9e61fe62bbf62dda9'

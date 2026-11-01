/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'e8fb33e1aa3d209a81115c6b249106ac7dd26a49c32079054f473a63f31296a6'
export const SHA_TOOLS_MODERN = '31c431e5137665a9cebf51f06e3d5825bc424eb9e3329aaf504d7b9c3940af8f'

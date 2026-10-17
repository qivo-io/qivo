/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'e666c595272d737222f7b8188ca6ac76833077fa9a39e56c376bdab977f29372'
export const SHA_TOOLS_MODERN = '4fbe0f5ac53b2fdc6110536f4ad989d5224fd3dd3615b5a424f21bc3a384528c'

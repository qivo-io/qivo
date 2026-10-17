/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '2a10b2298da5c5481a5a708af9f71c0bb13789f041d1cb95e7c2850278accbda'
export const SHA_TOOLS_MODERN = '5a0db14c4696586833cf7cd0700399a11073f9472f8f2f6d8e876f04b99e9b64'
